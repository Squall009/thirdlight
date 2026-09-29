/**
 * Phase 25.10: generic component access for scripts (`ctx.entity(ref)`).
 *
 * The component descriptors mark what scripts may read (`scriptReadable`)
 * and write while the game runs (`runtimeWritable`). This module turns the
 * marks into the table the runtime enforces and checks a write's patch
 * against the descriptors: the field exists, is writable, applies to the
 * component as it stands (a `when` condition), and its value fits the
 * field's type and range. The runtime adds what only it knows (an object's
 * physics body, the camera, a static object, a material's parameters).
 *
 * Versioned with the schema: the marks belong to the project schema
 * (`SCRIPT_ACCESS_SCHEMA_VERSION` is the project `schemaVersion`), so a
 * renamed or unmarked field is a schema change, never a silent break; a unit
 * test pins the table for this version.
 *
 * Pure: no I/O, no runtime, no three.js.
 */

import { DESCRIPTORS, type FieldCondition, type FieldDescriptor } from './descriptors';
import { PROJECT_SCHEMA_VERSION } from './upgrade-v24';

/** The project schema version the script access marks belong to. */
export const SCRIPT_ACCESS_SCHEMA_VERSION = PROJECT_SCHEMA_VERSION;

/** The pseudo-component name of an object's own fields (the registry's `entity` descriptor: active, visible, name…). */
export const SCRIPT_OBJECT_COMPONENT = 'object';

/** What scripts may read and write of one component (top-level keys; `*`: the component's value itself). */
export interface ScriptComponentAccess {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/** The whole table: every component a script may read, by name (`object` first, then registry order). */
export interface ScriptAccessTable {
  readonly schemaVersion: number;
  readonly components: Readonly<Record<string, ScriptComponentAccess>>;
}

function rootOf(component: string): FieldDescriptor | null {
  if (component === SCRIPT_OBJECT_COMPONENT) return DESCRIPTORS.entity;
  const c = DESCRIPTORS.components.find((d) => d.name === component);
  return c === undefined ? null : c.value;
}

function accessOf(root: FieldDescriptor): ScriptComponentAccess | null {
  if (root.type !== 'object') {
    if (root.scriptReadable !== true) return null;
    return { read: ['*'], write: root.runtimeWritable === true ? ['*'] : [] };
  }
  const read = [...new Set(root.fields.filter((f) => f.scriptReadable === true).map((f) => f.key))];
  if (read.length === 0) return null;
  const write = [...new Set(root.fields.filter((f) => f.runtimeWritable === true).map((f) => f.key))];
  return { read, write };
}

let table: ScriptAccessTable | null = null;

/** The script access table (built once from the descriptors; frozen). */
export function scriptAccessTable(): ScriptAccessTable {
  if (table !== null) return table;
  const components: Record<string, ScriptComponentAccess> = {};
  const obj = accessOf(DESCRIPTORS.entity);
  if (obj !== null) components[SCRIPT_OBJECT_COMPONENT] = Object.freeze({ read: Object.freeze([...obj.read]), write: Object.freeze([...obj.write]) });
  for (const c of DESCRIPTORS.components) {
    const a = accessOf(c.value);
    if (a !== null) components[c.name] = Object.freeze({ read: Object.freeze([...a.read]), write: Object.freeze([...a.write]) });
  }
  table = Object.freeze({ schemaVersion: SCRIPT_ACCESS_SCHEMA_VERSION, components: Object.freeze(components) });
  return table;
}

/** The access of one component, or null when scripts may not read it. */
export function scriptComponentAccess(component: string): ScriptComponentAccess | null {
  return Object.prototype.hasOwnProperty.call(scriptAccessTable().components, component) ? scriptAccessTable().components[component]! : null;
}

function deepFreezeCopy(v: unknown): unknown {
  if (Array.isArray(v)) return Object.freeze(v.map(deepFreezeCopy));
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepFreezeCopy(x);
    return Object.freeze(out);
  }
  return v;
}

/**
 * A read-only snapshot of a component value: only its script-readable keys,
 * deep-frozen copies. `defaults` fills readable fields the value leaves out
 * with the descriptor default the engine uses (so a script reads `range: 0`
 * of a point light that never set one).
 */
export function scriptSnapshot(component: string, value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const access = scriptComponentAccess(component);
  if (access === null) return Object.freeze({});
  if (access.read.includes('*')) return deepFreezeCopy(value) as Readonly<Record<string, unknown>>;
  const root = rootOf(component);
  const out: Record<string, unknown> = {};
  for (const key of access.read) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
      out[key] = deepFreezeCopy(value[key]);
      continue;
    }
    if (root?.type !== 'object') continue;
    const f = applicableField(root.fields, key, value);
    if (f !== null && f.default !== undefined) out[key] = deepFreezeCopy(f.default);
  }
  return Object.freeze(out);
}

// ---- writes ------------------------------------------------------------------------------

/** Why a write was refused (the runtime adds its own: see runtime `EntityWriteCode`). */
export type ScriptWriteCode = 'component_unknown' | 'patch_invalid' | 'field_unknown' | 'field_not_writable' | 'field_not_applicable' | 'field_value';

export interface ScriptWriteProblem {
  readonly component: string;
  /** The field (`component.key`, or the component for a whole-value problem). */
  readonly field: string;
  readonly code: ScriptWriteCode;
  readonly message: string;
}

export type ScriptPatchResult =
  | { readonly ok: true; readonly fields: readonly (readonly [string, unknown])[] }
  | { readonly ok: false; readonly problem: ScriptWriteProblem };

function conditionHolds(c: FieldCondition, value: Readonly<Record<string, unknown>>, siblings: readonly FieldDescriptor[]): boolean {
  // `../key` conditions name a field of an enclosing object: top-level component fields have none.
  if (c.key.startsWith('../')) return true;
  let v = value[c.key];
  if (v === undefined) v = siblings.find((f) => f.key === c.key && f.default !== undefined)?.default as unknown;
  return (c.in as readonly unknown[]).includes(v);
}

function applies(f: FieldDescriptor, value: Readonly<Record<string, unknown>>, siblings: readonly FieldDescriptor[]): boolean {
  if (f.when === undefined) return true;
  const list = (Array.isArray(f.when) ? f.when : [f.when]) as readonly FieldCondition[];
  return list.every((c) => conditionHolds(c, value, siblings));
}

/** The descriptor of `key` that applies to the value (the same key may be listed per condition), or null. */
function applicableField(fields: readonly FieldDescriptor[], key: string, value: Readonly<Record<string, unknown>>): FieldDescriptor | null {
  for (const f of fields) if (f.key === key && applies(f, value, fields)) return f;
  return null;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function rangeProblem(n: number, f: { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean }): string | null {
  if (f.min !== undefined && (f.minExclusive === true ? n <= f.min : n < f.min)) return `${f.minExclusive === true ? 'above' : 'at least'} ${f.min}`;
  if (f.max !== undefined && (f.maxExclusive === true ? n >= f.max : n > f.max)) return `${f.maxExclusive === true ? 'below' : 'at most'} ${f.max}`;
  return null;
}

/** A written value checked against its field: the normalized value, or what it must be. */
function checkValue(f: FieldDescriptor, v: unknown): { ok: true; value: unknown } | { ok: false; expected: string } {
  switch (f.type) {
    case 'number': {
      if (!finite(v)) return { ok: false, expected: 'a finite number' };
      const r = rangeProblem(v, f);
      if (r !== null) return { ok: false, expected: `a number ${r}` };
      if (f.nonZero === true && v === 0) return { ok: false, expected: 'a number other than 0' };
      return { ok: true, value: v };
    }
    case 'int': {
      if (!finite(v) || !Number.isInteger(v)) return { ok: false, expected: 'a whole number' };
      if (f.values !== undefined && !f.values.includes(v)) return { ok: false, expected: `one of ${f.values.join(', ')}` };
      const r = rangeProblem(v, f);
      return r === null ? { ok: true, value: v } : { ok: false, expected: `a whole number ${r}` };
    }
    case 'bool':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, expected: 'true or false' };
    case 'color':
      return typeof v === 'string' && COLOR_RE.test(v) ? { ok: true, value: v.toLowerCase() } : { ok: false, expected: 'a colour "#rrggbb"' };
    case 'enum':
      return typeof v === 'string' && f.options.some((o) => o.value === v) ? { ok: true, value: v } : { ok: false, expected: `one of ${f.options.map((o) => o.value).join(', ')}` };
    case 'string': {
      if (typeof v !== 'string') return { ok: false, expected: 'a text' };
      if ((f.minLength !== undefined && v.length < f.minLength) || (f.maxLength !== undefined && v.length > f.maxLength)) return { ok: false, expected: `a text of ${f.minLength ?? 0}–${f.maxLength ?? '∞'} characters` };
      return { ok: true, value: v };
    }
    case 'vec2':
    case 'vec3': {
      const n = f.type === 'vec2' ? 2 : 3;
      if (!Array.isArray(v) || v.length !== n || !v.every(finite)) return { ok: false, expected: `${n} finite numbers [${f.labels.join(', ')}]` };
      for (const x of v as number[]) {
        const r = rangeProblem(x, { ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}), ...(f.minExclusive === true ? { minExclusive: true } : {}) });
        if (r !== null) return { ok: false, expected: `each number ${r}` };
      }
      if (f.nonZero === true && (v as number[]).every((x) => x === 0)) return { ok: false, expected: 'not every number 0' };
      return { ok: true, value: [...(v as number[])] };
    }
    case 'quat': {
      if (!Array.isArray(v) || v.length !== 4 || !v.every(finite)) return { ok: false, expected: 'a quaternion [x, y, z, w]' };
      const q = v as number[];
      const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
      if (!(len > 1e-9)) return { ok: false, expected: 'a quaternion that is not all 0' };
      return { ok: true, value: q.map((x) => x / len) };
    }
    case 'map': {
      // Phase 25.10: a writable map (material parameters) is checked for its shape here and for its values by the runtime.
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, expected: `an object: ${f.keyLabel.toLowerCase()} → value` };
      return { ok: true, value: v };
    }
    default:
      return { ok: false, expected: 'a value scripts cannot write' };
  }
}

/**
 * Check a script's `set(component, patch)` against the descriptors, given
 * the component's current value (the `when` conditions read it). The result
 * lists the fields to write in the patch's key order (normalized values), or
 * the first refused field. Nothing of a refused patch is written.
 */
export function checkScriptPatch(component: string, current: Readonly<Record<string, unknown>>, patch: unknown): ScriptPatchResult {
  const refuse = (field: string, code: ScriptWriteCode, message: string): ScriptPatchResult => ({ ok: false, problem: Object.freeze({ component, field, code, message }) });
  const root = rootOf(component);
  const access = scriptComponentAccess(component);
  if (root === null || access === null) return refuse(component, 'component_unknown', `"${component}" is not a component scripts can use`);
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return refuse(component, 'patch_invalid', `set("${component}", patch) needs an object of field values`);
  if (root.type !== 'object') {
    if (!access.write.includes('*')) return refuse(component, 'field_not_writable', `${component} is fixed while the game runs`);
    const checked = checkValue(root, patch);
    return checked.ok ? { ok: true, fields: Object.freeze([Object.freeze(['*', checked.value] as const)]) } : refuse(component, 'field_value', `${component} must be ${checked.expected}`);
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return refuse(component, 'patch_invalid', `set("${component}", patch) names no field`);
  const merged = { ...current, ...(patch as Record<string, unknown>) };
  const out: (readonly [string, unknown])[] = [];
  for (const key of keys) {
    const field = `${component}.${key}`;
    if (!root.fields.some((f) => f.key === key) || key === 'components') return refuse(field, 'field_unknown', `${component} has no field "${key}"`);
    const f = applicableField(root.fields, key, merged);
    if (f === null) return refuse(field, 'field_not_applicable', `${field} does not apply to this ${component}`);
    if (f.runtimeWritable !== true) return refuse(field, 'field_not_writable', `${field} is fixed while the game runs (only ${access.write.length > 0 ? access.write.map((k) => `${component}.${k}`).join(', ') : 'nothing of it'} can be written)`);
    const checked = checkValue(f, (patch as Record<string, unknown>)[key]);
    if (!checked.ok) return refuse(field, 'field_value', `${field} must be ${checked.expected}`);
    out.push(Object.freeze([key, checked.value] as const));
  }
  return { ok: true, fields: Object.freeze(out) };
}
