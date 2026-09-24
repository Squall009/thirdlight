/**
 * Phase 15.1: the generic Inspector's model — pure functions over the
 * component and content descriptors (`queryGameConfig {descriptors:true}`).
 *
 * - `widgetFor`: one widget per field type (number/int with unit, range and
 *   step, bool, enum, vec2/vec3, quat as Euler degrees, colour, asset ref
 *   with its kinds, entity ref, scene ref, named refs, signal, string,
 *   nested object, list, map; tool-written and loosely typed values are
 *   shown read-only).
 * - `visibleFields`: the fields that apply to a value (`when` conditions on a
 *   sibling or, with `../`, on the enclosing object; a key listed twice shows
 *   the variant that holds).
 * - `componentPatch`: one edit (a path and a new value, or `undefined` to
 *   remove it) → the partial top-level value the existing commands take
 *   (`setComponent`, `setTransform`, `setGameConfig`): fields that stop
 *   applying are dropped, required fields that start applying get the value
 *   of a preset of that variant, a fitting reference or their default
 *   (`Fill`), an optional
 *   field set to its default is removed (absent means the default). `null`
 *   = nothing changed.
 * - `addEntries`: the "+ Add component" list with the descriptor defaults and
 *   presets; components that cannot be added say why (already present,
 *   excluded by another component, needs another component, made by a tool).
 *
 * Types only from project-model (the editor never imports its values); no
 * DOM, no React — unit-tested in `descriptor-fields.test.ts` and against the
 * real registry and commands in `tests/integration/m15-inspector`.
 */
import type {
  ComponentDescriptor,
  DescriptorJson,
  DescriptorRegistry,
  FieldCondition,
  FieldDescriptor,
  ObjectFieldDescriptor,
} from '@thirdlight/project-model';

export type WidgetKind =
  | 'number'
  | 'int'
  | 'bool'
  | 'enum'
  | 'vector'
  | 'euler'
  | 'color'
  | 'asset'
  | 'entity'
  | 'scene'
  | 'ref'
  | 'signal'
  | 'text'
  | 'multiline'
  | 'object'
  | 'list'
  | 'map'
  | 'readonly';

/** A path from a component (or content block) root: object keys, map keys and list indices. */
export type FieldPath = readonly (string | number)[];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** The widget that edits a field. */
export function widgetFor(f: FieldDescriptor): WidgetKind {
  if (f.readOnly === true) return 'readonly';
  switch (f.type) {
    case 'number':
      return 'number';
    case 'int':
      return 'int';
    case 'bool':
      return 'bool';
    case 'enum':
      return 'enum';
    case 'vec2':
    case 'vec3':
      return 'vector';
    case 'quat':
      return 'euler';
    case 'color':
      return 'color';
    case 'assetRef':
      return 'asset';
    case 'entityRef':
      return 'entity';
    case 'sceneRef':
      return 'scene';
    case 'ref':
      return 'ref';
    case 'signal':
      return 'signal';
    case 'string':
      return f.format === 'multiline' ? 'multiline' : 'text';
    case 'object':
      return 'object';
    case 'list':
      return 'list';
    case 'map':
      return 'map';
    case 'components':
    case 'json':
      return 'readonly';
  }
}

/** A number field small enough for a slider next to its text box (both ends bounded). */
export function sliderRange(f: FieldDescriptor): { min: number; max: number; step: number } | null {
  if (f.type !== 'number' && f.type !== 'int') return null;
  if (f.min === undefined || f.max === undefined || !(f.max - f.min <= 10_000)) return null;
  const step = f.step ?? (f.type === 'int' ? 1 : (f.max - f.min) / 100);
  return { min: f.min, max: f.max, step };
}

/** The visible label: the descriptor label with its unit. */
export function fieldLabel(f: FieldDescriptor): string {
  return f.unit !== undefined ? `${f.label} (${f.unit})` : f.label;
}

/**
 * The accessible name of a field: the component name (none for the
 * transform), then the path (list positions from 1). Stable for tests and
 * screen readers: "trigger radius", "controller capsule height",
 * "mover waypoints 1", "position".
 */
export function fieldAria(component: string, path: FieldPath): string {
  const parts: string[] = component === 'transform' || component === '' ? [] : [component];
  for (const p of path) parts.push(typeof p === 'number' ? String(p + 1) : p);
  return parts.join(' ');
}

// ---- conditions and defaults -----------------------------------------------------

/**
 * Where required fields that start applying get their value: a preset of the
 * same variant (`seeds`, see `seedsOf`), else — for a reference — the first
 * object or asset that fits (`pick`; the user changes it after), else the
 * field's default.
 */
export interface Fill {
  readonly seeds?: readonly unknown[];
  readonly pick?: (f: FieldDescriptor) => unknown;
}

/** An object level: its descriptor and its stored value (the enclosing level for `../` conditions). */
export interface Level {
  readonly desc: ObjectFieldDescriptor;
  readonly value: Obj;
  readonly parent?: Level;
}

const conditionsOf = (f: FieldDescriptor): readonly FieldCondition[] =>
  f.when === undefined ? [] : Array.isArray(f.when) ? (f.when as readonly FieldCondition[]) : [f.when as FieldCondition];

/** The value a field of this level has in effect (stored, else the applicable variant's default). */
function effectiveAt(level: Level, key: string, depth: number): unknown {
  const stored = level.value[key];
  if (stored !== undefined) return stored;
  const candidates = level.desc.fields.filter((f) => f.key === key);
  const hit = candidates.find((f) => depth < 4 && conditionsOf(f).every((c) => holds(c, level, depth + 1))) ?? candidates[0];
  return hit?.default;
}

function holds(c: FieldCondition, level: Level, depth: number): boolean {
  let at: Level | undefined = level;
  let key = c.key;
  while (key.startsWith('../')) {
    at = at?.parent;
    key = key.slice(3);
  }
  if (at === undefined) return true;
  const v = effectiveAt(at, key, depth);
  return c.in.some((x) => x === v);
}

/** Whether a field applies at this level. */
export function applies(f: FieldDescriptor, level: Level): boolean {
  return conditionsOf(f).every((c) => holds(c, level, 0));
}

/** The fields shown for a value: those that apply (one per key). */
export function visibleFields(level: Level): FieldDescriptor[] {
  const seen = new Set<string>();
  const out: FieldDescriptor[] = [];
  for (const f of level.desc.fields) {
    if (seen.has(f.key) || !applies(f, level)) continue;
    seen.add(f.key);
    out.push(f);
  }
  return out;
}

/** Fields without a group first, then each group in order of first appearance. */
export function groupFields(fields: readonly FieldDescriptor[]): { group: string | null; fields: FieldDescriptor[] }[] {
  const out: { group: string | null; fields: FieldDescriptor[] }[] = [{ group: null, fields: [] }];
  for (const f of fields) {
    const g = f.group ?? null;
    let bucket = out.find((b) => b.group === g);
    if (bucket === undefined) {
      bucket = { group: g, fields: [] };
      out.push(bucket);
    }
    bucket.fields.push(f);
  }
  return out.filter((b) => b.fields.length > 0);
}

/**
 * A starting value for a field: its default, else (an object) its required
 * applicable fields' starting values, (an enum) its first option, (a bool)
 * false, (a list) the smallest list of item starting values.
 */
export function startValue(f: FieldDescriptor, parent?: Level): unknown {
  if (f.default !== undefined) return clone(f.default);
  switch (f.type) {
    case 'object': {
      const value: Obj = {};
      const level: Level = { desc: f, value, ...(parent !== undefined ? { parent } : {}) };
      for (let pass = 0; pass < 3; pass++) {
        for (const g of visibleFields(level)) {
          if (g.required !== true || value[g.key] !== undefined) continue;
          const v = startValue(g, level);
          if (v !== undefined) value[g.key] = v;
        }
      }
      return value;
    }
    case 'enum':
      return f.options[0]?.value;
    case 'bool':
      return false;
    case 'list': {
      const n = f.length ?? f.minItems ?? 0;
      const item = startValue(f.item);
      if (n > 0 && item === undefined) return undefined;
      return Array.from({ length: n }, () => clone(item));
    }
    case 'map':
      return {};
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return [0, 0, 0];
    // A required text without a default (a custom pickup's counter) starts as its
    // key name — a valid name in every text format — and is renamed after.
    case 'string':
    case 'signal':
      return f.required === true ? f.key : undefined;
    default:
      return undefined;
  }
}

/**
 * Bring a value in line with its conditions: drop keys whose every variant
 * stopped applying, add required applicable fields that are missing (their
 * starting value), recurse into nested objects and list items.
 */
export function normalize(desc: ObjectFieldDescriptor, value: Obj, parent?: Level, fill: Fill = {}, at: FieldPath = []): Obj {
  const out: Obj = { ...value };
  const level: Level = { desc, value: out, ...(parent !== undefined ? { parent } : {}) };
  for (let pass = 0; pass < 3; pass++) {
    for (const key of Object.keys(out)) {
      const variants = desc.fields.filter((f) => f.key === key);
      if (variants.length > 0 && !variants.some((f) => applies(f, level))) delete out[key];
    }
    for (const f of visibleFields(level)) {
      // A key listed per variant (a light's intensity in candela or as a factor) may
      // hold a value the new variant refuses: it starts over like a missing field.
      const cur = out[f.key];
      if ((f.type === 'number' || f.type === 'int') && typeof cur === 'number' && !checkNumber(f, cur).ok) delete out[f.key];
      if (f.required === true && out[f.key] === undefined) {
        const v = seeded(f, level, fill.seeds ?? [], at) ?? (f.type === 'entityRef' || f.type === 'assetRef' || f.type === 'sceneRef' || f.type === 'ref' ? fill.pick?.(f) : undefined) ?? startValue(f, level);
        if (v !== undefined) out[f.key] = v;
      }
    }
  }
  for (const f of visibleFields(level)) {
    const v = out[f.key];
    if (f.type === 'object' && isObj(v)) out[f.key] = normalize(f, v, level, fill, [...at, f.key]);
    if (f.type === 'list' && f.item.type === 'object' && Array.isArray(v)) {
      const item = f.item;
      out[f.key] = v.map((x) => (isObj(x) ? normalize(item, x, level) : x));
    }
  }
  return out;
}

/**
 * A required field's starting value from a seed (a preset or the add value)
 * whose object at the same place is the same variant — switching a collider
 * to a polygon takes the polygon preset's corners, not three zeros. Only
 * sibling conditions are compared.
 */
function seeded(f: FieldDescriptor, level: Level, seeds: readonly unknown[], at: FieldPath): unknown {
  const conds = conditionsOf(f);
  if (conds.some((c) => c.key.startsWith('../'))) return undefined;
  for (const seed of seeds) {
    const obj = getAt(seed, at);
    if (!isObj(obj) || obj[f.key] === undefined) continue;
    if (conds.every((c) => c.in.some((x) => x === obj[c.key]))) return clone(obj[f.key]);
  }
  return undefined;
}

/** A component's seeds for `componentPatch`: its presets and its add value. */
export function seedsOf(c: ComponentDescriptor): unknown[] {
  return [...(c.presets ?? []).map((p) => p.value), ...(c.add.kind === 'menu' || c.add.kind === 'pick' ? [c.add.value] : [])];
}

// ---- paths -------------------------------------------------------------------------

/** The field descriptor a path names (walking objects by their applicable fields, lists by item, maps by value). */
export function fieldAt(root: FieldDescriptor, value: unknown, path: FieldPath): FieldDescriptor | null {
  let f: FieldDescriptor = root;
  let v: unknown = value;
  let level: Level | undefined;
  for (const p of path) {
    if (f.type === 'object') {
      const here: Level = { desc: f, value: isObj(v) ? v : {}, ...(level !== undefined ? { parent: level } : {}) };
      const variants = f.fields.filter((x) => x.key === p);
      const next = variants.find((x) => applies(x, here)) ?? variants[0];
      if (next === undefined) return null;
      level = here;
      f = next;
      v = isObj(v) ? v[String(p)] : undefined;
    } else if (f.type === 'list') {
      f = f.item;
      v = Array.isArray(v) ? v[Number(p)] : undefined;
    } else if (f.type === 'map') {
      f = f.value;
      v = isObj(v) ? v[String(p)] : undefined;
    } else return null;
  }
  return f;
}

export function getAt(value: unknown, path: FieldPath): unknown {
  let v = value;
  for (const p of path) {
    if (Array.isArray(v)) v = v[Number(p)];
    else if (isObj(v)) v = v[String(p)];
    else return undefined;
  }
  return v;
}

/** A copy with the value at `path` replaced (`undefined` removes an object key or a list item). */
export function setAt(value: unknown, path: FieldPath, next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const arr = Array.isArray(value) ? [...(value as unknown[])] : [];
    const inner = setAt(arr[head], rest, next);
    if (inner === undefined && rest.length === 0) arr.splice(head, 1);
    else arr[head] = inner;
    return arr;
  }
  const obj: Obj = isObj(value) ? { ...value } : {};
  const inner = setAt(obj[head!], rest, next);
  if (inner === undefined) delete obj[head!];
  else obj[head!] = inner;
  return obj;
}

// ---- edits → command values -------------------------------------------------------------

/**
 * One edit → the partial top-level value for the component's command: each
 * changed top-level field whole, `null` for a removed one. `null` when the
 * edit changes nothing (an edit that changes nothing is refused as
 * `no_change`, so it is never sent).
 */
export function componentPatch(root: ObjectFieldDescriptor, current: Obj, path: FieldPath, next: unknown, fill: Fill = {}): Obj | null {
  const f = fieldAt(root, current, path);
  let v = next;
  // An optional field set to its default is removed (absent means the default).
  if (f !== null && f.required !== true && v !== undefined && f.default !== undefined && f.default !== null && deepEqual(v, f.default) && path.length > 0 && typeof path[path.length - 1] === 'string') {
    const parentDesc = fieldAt(root, current, path.slice(0, -1));
    if (parentDesc?.type === 'object') v = undefined;
  }
  const candidate = normalize(root, setAt(current, path, v) as Obj, undefined, fill);
  const patch: Obj = {};
  for (const k of new Set([...Object.keys(current), ...Object.keys(candidate)])) {
    if (!deepEqual(current[k], candidate[k])) patch[k] = candidate[k] === undefined ? null : candidate[k];
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

// ---- number input ------------------------------------------------------------------

export type ParsedNumber = { ok: true; value: number | undefined } | { ok: false; message: string };

/** Parse a typed number against its field (empty: no value). The backend re-checks everything. */
export function parseNumberInput(f: FieldDescriptor, raw: string): ParsedNumber {
  const t = raw.trim();
  if (t === '') return { ok: true, value: undefined };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, message: `${f.label}: "${t}" is not a number` };
  return checkNumber(f, n);
}

export function checkNumber(f: FieldDescriptor, n: number): ParsedNumber {
  const lim = f as { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean; nonZero?: boolean };
  if (f.type === 'int' && !Number.isInteger(n)) return { ok: false, message: `${f.label}: a whole number` };
  if (lim.min !== undefined && (n < lim.min || (lim.minExclusive === true && n === lim.min))) return { ok: false, message: `${f.label}: ${lim.minExclusive === true ? 'above' : 'at least'} ${lim.min}` };
  if (lim.max !== undefined && (n > lim.max || (lim.maxExclusive === true && n === lim.max))) return { ok: false, message: `${f.label}: ${lim.maxExclusive === true ? 'below' : 'at most'} ${lim.max}` };
  if (f.type === 'number' && lim.nonZero === true && n === 0) return { ok: false, message: `${f.label}: not 0` };
  return { ok: true, value: n };
}

/** Display a number (at most 4 decimals). */
export const formatNumber = (v: number): string => String(Number(v.toFixed(4)));

// ---- which command edits a component --------------------------------------------------------

export type ComponentOp = 'setTransform' | 'setBehaviorProperties' | 'setComponent' | null;

/** The command a component's edits go through (null: shown read-only — written by a tool). */
export function componentOp(name: string): ComponentOp {
  if (name === 'transform') return 'setTransform';
  if (name === 'behavior') return 'setBehaviorProperties';
  if (name === 'prefab' || name === 'folder') return null;
  return 'setComponent';
}

/** Whether "remove" is offered (the transform and the prefab link stay; a folder is a folder). */
export function removable(name: string): boolean {
  return componentOp(name) !== null && name !== 'transform';
}

// ---- "+ Add component" --------------------------------------------------------------------------

export interface AddEntry {
  /** A stable key (component, or component:preset index). */
  readonly id: string;
  readonly component: string;
  readonly label: string;
  readonly category: ComponentDescriptor['category'];
  /** The value added (menu entries; the starting draft of a pick entry). */
  readonly value: DescriptorJson | null;
  /** The fields the user picks before the component is added. */
  readonly pick: readonly string[];
  readonly enabled: boolean;
  /** Why it cannot be added. */
  readonly reason: string | null;
}

/**
 * The "+ Add component" list for an object carrying `present` (component
 * names). Every component but the transform is listed; one entry per preset.
 */
export function addEntries(reg: DescriptorRegistry, present: ReadonlySet<string>, opts: { folder?: boolean } = {}): AddEntry[] {
  const out: AddEntry[] = [];
  const labelOf = (name: string): string => reg.components.find((c) => c.name === name)?.label ?? name;
  for (const c of reg.components) {
    if (c.name === 'transform') continue;
    let reason: string | null = null;
    if (opts.folder === true) reason = 'a folder carries no components';
    else if (present.has(c.name)) reason = 'already on this object';
    else if (c.add.kind === 'tool') reason = `made by the ${c.add.tool}`;
    else if (c.add.kind === 'never') reason = c.add.reason;
    else {
      const clash = c.excludes.find((x) => present.has(x.component));
      if (clash !== undefined) reason = `${clash.reason} (it has ${labelOf(clash.component)})`;
      else if (c.requiresAnyOf !== undefined && !c.requiresAnyOf.components.some((n) => present.has(n))) reason = `needs ${c.requiresAnyOf.components.map(labelOf).join(' or ')}: ${c.requiresAnyOf.reason}`;
    }
    const pick = c.add.kind === 'pick' ? c.add.pick : [];
    const base = c.add.kind === 'menu' || c.add.kind === 'pick' ? c.add.value : null;
    if (c.presets !== undefined && c.presets.length > 0 && c.add.kind === 'menu') {
      c.presets.forEach((p, i) => out.push({ id: `${c.name}:${i}`, component: c.name, label: `${c.label}: ${p.label}`, category: c.category, value: p.value, pick: [], enabled: reason === null, reason }));
    } else {
      out.push({ id: c.name, component: c.name, label: c.label, category: c.category, value: base, pick, enabled: reason === null, reason });
    }
  }
  return out;
}

/** The value a pick entry adds once its pick fields are set (`*` names a map key), or why not yet. */
export function pickedValue(c: ComponentDescriptor, draft: Obj): { ok: true; value: Obj } | { ok: false; missing: string[] } {
  if (c.add.kind !== 'pick') return { ok: true, value: draft };
  const missing = c.add.pick.filter((p) => {
    const v = getAt(draft, p.split('/'));
    return v === undefined || v === '' || v === null;
  });
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value: c.value.type === 'object' ? normalize(c.value, draft) : draft };
}

// ---- pickers ------------------------------------------------------------------------------

/** Every signal name the scene's components send or wait for (suggestions for signal fields). */
export function collectSignals(reg: DescriptorRegistry, bags: readonly Obj[]): string[] {
  const found = new Set<string>();
  const walk = (f: FieldDescriptor, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (f.type === 'signal' && typeof v === 'string' && v !== '') found.add(v);
    else if (f.type === 'object' && isObj(v)) for (const g of f.fields) walk(g, v[g.key]);
    else if (f.type === 'list' && Array.isArray(v)) for (const x of v) walk(f.item, x);
    else if (f.type === 'map' && isObj(v)) for (const x of Object.values(v)) walk(f.value, x);
  };
  for (const bag of bags) for (const c of reg.components) walk(c.value, bag[c.name]);
  return [...found].sort();
}

export interface EntityOption {
  readonly id: string;
  readonly name: string;
  readonly sceneId?: string;
  readonly components: readonly string[];
}

/** What the reference pickers offer. */
export interface PickerData {
  readonly assets: readonly { assetId: string; kind: string; displayName: string }[];
  /** Every object of the project (entity refs may name other scenes). */
  readonly entities: readonly EntityOption[];
  readonly scenes: readonly { sceneId: string; name: string }[];
  readonly refs: Readonly<Partial<Record<'material' | 'animator' | 'behavior' | 'prefab', readonly { id: string; name: string }[]>>>;
  /** The scene of the object being edited (entity refs stay in it unless they may be anywhere). */
  readonly sceneId?: string;
}

/** The first object, asset, scene or project item a reference field may name (a starting choice). */
export function firstReference(f: FieldDescriptor, d: PickerData): string | undefined {
  switch (f.type) {
    case 'entityRef':
      return entityChoices(f, d.entities, d.sceneId)[0]?.id;
    case 'assetRef':
      return d.assets.find((a) => (f.kinds as readonly string[]).includes(a.kind))?.assetId;
    case 'sceneRef':
      return d.scenes[0]?.sceneId;
    case 'ref':
      return d.refs[f.target as 'material']?.[0]?.id;
    default:
      return undefined;
  }
}

/** The objects an entity-ref field may name: carrying its component, in the same scene unless it may be anywhere. */
export function entityChoices(f: FieldDescriptor, all: readonly EntityOption[], sceneId: string | undefined): EntityOption[] {
  if (f.type !== 'entityRef') return [];
  return all.filter((e) => (f.component === undefined || e.components.includes(f.component)) && (f.anyScene === true || sceneId === undefined || e.sceneId === undefined || e.sceneId === sceneId));
}
