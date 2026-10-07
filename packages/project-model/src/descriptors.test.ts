/**
 * The descriptor registry matches the validators.
 *
 * Every component and content block is probed through its real validator
 * from valid base documents (one per variant: each light type,
 * trigger shape, sky mode, binding kind, shader, motion kind…):
 * - the validator refuses an unknown key, and every key it names as allowed
 *   has a descriptor (no field without a descriptor);
 * - every described key is accepted, required ones cannot be removed,
 *   optional ones can;
 * - numbers and vectors: min and max accepted (exclusive bounds refused),
 *   just outside refused, ints refuse fractions; enums accept every option
 *   and refuse others; strings accept `maxLength` and refuse one more; lists
 *   accept `minItems`/`maxItems` and refuse one fewer/more; wrong types and
 *   `null` (unless nullable) refused;
 * - every descriptor node is reached by some base (coverage);
 * - defaults fit their own descriptors, "+ Add component" values and presets
 *   validate, exclusions/requirements match the scene validator, handles
 *   bind real fields, and the registry survives JSON (how it travels).
 */
import { describe, expect, it } from 'vitest';

import { validateAnimators } from './animator';
import { BLOCK_COMPONENTS } from './blocks';
import { CAPSULE_LIMITS } from './components';
import { PREFAB_V4_COMPONENTS, validateContentV4, validatePrefabDefinitions, validateTagRegistry } from './content';
import {
  COMPONENT_ICONS,
  DESCRIPTORS,
  HANDLE_KINDS,
  HANDLE_ROLES,
  type ComponentDescriptor,
  type FieldCondition,
  type FieldDescriptor,
  type ListFieldDescriptor,
  type ObjectFieldDescriptor,
} from './descriptors';
import { REMOVED_COMPONENTS } from './upgrade-v24';
import type { ModelErrorV2 } from './errors';
import { validateInput } from './input';
import { validateModes } from './modes';
import { validateEventCues } from './event-cues';
import { validateShell } from './shell';
import { MATERIAL_PARAMS, MATERIAL_SHADERS, MATERIAL_TEXTURE_SLOTS, validateEnvironment, validateMaterials, validateSceneEnvironment } from './materials';
import { validateEffects } from './effects';
import { validateBlockStamps, validateBlockTypes, validateCellFields } from './block-layers';
import { validateUiDocument } from './ui-documents';
import { V4_REGISTRY, validateSceneV4 } from './scene-v3';

type J = unknown;
type Obj = Record<string, unknown>;
interface Err {
  code: string;
  path: string;
  message: string;
  expected?: string;
  reason?: string;
  found?: unknown;
}
type Validate = (root: J) => Err[];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const seg = (p: string): string[] => (p === '' ? [] : p.slice(1).split('/'));
function getAt(root: J, ptr: string): J {
  let v = root;
  for (const s of seg(ptr)) v = (v as Obj)[s];
  return v;
}
function setAt(root: J, ptr: string, value: J): J {
  if (ptr === '') return clone(value);
  const out = clone(root);
  const parts = seg(ptr);
  let v = out as Obj;
  for (const s of parts.slice(0, -1)) v = v[s] as Obj;
  const last = parts[parts.length - 1]!;
  if (value === undefined) {
    if (Array.isArray(v)) v.splice(Number(last), 1);
    else delete v[last];
  } else v[last] = value;
  return out;
}
const at = (errs: Err[], ptr: string): Err[] => errs.filter((e) => e.path === ptr || e.path.startsWith(`${ptr}/`));
const isUnknownKey = (e: Err): boolean => /unexpected|unknown/.test(e.code) || e.reason === 'field_unexpected';

// ---- conditions ----------------------------------------------------------------

function effective(obj: Obj, key: string, siblings: readonly FieldDescriptor[]): unknown {
  if (obj[key] !== undefined) return obj[key];
  return siblings.find((f) => f.key === key && f.default !== undefined)?.default;
}
function holds(c: FieldCondition | readonly FieldCondition[] | undefined, obj: Obj, siblings: readonly FieldDescriptor[], parent?: { obj: Obj; fields: readonly FieldDescriptor[] }): boolean {
  if (c === undefined) return true;
  const list = Array.isArray(c) ? (c as readonly FieldCondition[]) : [c as FieldCondition];
  return list.every((x) => {
    if (x.key.startsWith('../')) return parent !== undefined && x.in.includes(effective(parent.obj, x.key.slice(3), parent.fields) as never);
    return x.in.includes(effective(obj, x.key, siblings) as never);
  });
}
/** Keys whose value decides other fields (a `when` names them): their options are probed through variant bases. */
function discriminators(fields: readonly FieldDescriptor[]): Set<string> {
  const out = new Set<string>();
  const add = (c: FieldCondition | readonly FieldCondition[] | undefined): void => {
    if (c === undefined) return;
    for (const x of Array.isArray(c) ? (c as readonly FieldCondition[]) : [c as FieldCondition]) if (!x.key.startsWith('../')) out.add(x.key);
  };
  for (const f of fields) add(f.when);
  return out;
}

// ---- the prober ------------------------------------------------------------------

const visited = new Set<FieldDescriptor>();
const failures: string[] = [];
const fail = (msg: string): void => {
  failures.push(msg);
};

/**
 * Cross-field rules the probes must respect (the probe sets one value; these
 * move a sibling so only the probed field's own range is tested).
 */
const ADJUST: Record<string, (o: Obj, v: number) => void> = {
  'controller:capsule.height': (o, v) => {
    o['radius'] = Math.max(CAPSULE_LIMITS.minRadius, Math.min(o['radius'] as number, v / 2));
  },
  'health:start': (o, v) => {
    o['max'] = Math.max(o['max'] as number, Math.min(1000, Math.ceil(v)));
  },
  'camera:far': (o, v) => {
    o['near'] = Math.min(o['near'] as number, v / 2);
  },
  // The virtual camera's paired limits.
  'virtualCamera:pitchMin': (o, v) => {
    if (typeof o['pitchMax'] === 'number') o['pitchMax'] = Math.max(o['pitchMax'] as number, v);
  },
  'virtualCamera:pitchMax': (o, v) => {
    if (typeof o['pitchMin'] === 'number') o['pitchMin'] = Math.min(o['pitchMin'] as number, v);
  },
  'virtualCamera:minDistance': (o, v) => {
    if (typeof o['maxDistance'] === 'number') o['maxDistance'] = Math.max(o['maxDistance'] as number, v);
  },
  'virtualCamera:maxDistance': (o, v) => {
    if (typeof o['minDistance'] === 'number') o['minDistance'] = Math.min(o['minDistance'] as number, v);
  },
  'virtualCamera:near': (o, v) => {
    if (typeof o['far'] === 'number') o['far'] = Math.max(o['far'] as number, v * 2);
  },
  'virtualCamera:far': (o, v) => {
    if (typeof o['near'] === 'number') o['near'] = Math.min(o['near'] as number, v / 2);
  },
  // The track rig's bounds (the other side moved out of the way).
  'virtualCamera:boundsMin': (o) => {
    if (Array.isArray(o['boundsMax'])) o['boundsMax'] = [1e6, 1e6, 1e6];
  },
  'virtualCamera:boundsMax': (o) => {
    if (Array.isArray(o['boundsMin'])) o['boundsMin'] = [-1e6, -1e6, -1e6];
  },
  // A camera region's bounds (the other side moved out of the way).
  'cameraRegion:boundsMin': (o) => {
    if (Array.isArray(o['boundsMax'])) o['boundsMax'] = [1e6, 1e6, 1e6];
  },
  'cameraRegion:boundsMax': (o) => {
    if (Array.isArray(o['boundsMin'])) o['boundsMin'] = [-1e6, -1e6, -1e6];
  },
  'behaviors:*.declaration.properties.*.min': (o, v) => {
    o['max'] = Math.max(o['max'] as number, v);
  },
  'behaviors:*.declaration.properties.*.max': (o, v) => {
    o['min'] = Math.min(o['min'] as number, v);
  },
  'settings:min_slope_slide_deg': (o, v) => {
    o['max_slope_climb_deg'] = Math.max(o['max_slope_climb_deg'] as number, v);
  },
};

/** List count probes that cannot run in a minimal base (their items must resolve against other data). */
const SKIP_COUNT = new Set(['startScenes:']);
/** Optional fields of an exactly-one-of pair (removing the present one leaves none). */
// Fields that come in pairs or one of a set: removing one alone is refused.
const ONE_OF_REMOVAL = new Set(['uiWidget:worldAnchor.point', 'uiWidget:image', 'uiWidget:saveSlot', 'blockStamps:*.edgePalette', 'blockStamps:*.edges']);


interface Ctx {
  label: string;
  validate: Validate;
}

function eps(x: number): number {
  return Math.max(Math.abs(x) * 1e-9, 1e-9);
}

function expectOk(ctx: Ctx, root: J, errAt: string, what: string): void {
  const errs = at(ctx.validate(root), errAt);
  if (errs.length > 0) fail(`${ctx.label} ${errAt}: ${what} should be accepted, got ${errs.map((e) => `${e.code} ${e.path} ${e.message}`).join('; ')}`);
}
function expectErr(ctx: Ctx, root: J, errAt: string, what: string): void {
  const errs = ctx.validate(root);
  // at the field, inside it, or on an object containing it (a polygon is judged whole)
  const near = errs.filter((e) => e.path === errAt || e.path.startsWith(`${errAt}/`) || (e.path !== '' && errAt.startsWith(`${e.path}/`)));
  if (near.length === 0) fail(`${ctx.label} ${errAt}: ${what} should be refused (errors: ${errs.map((e) => `${e.code} ${e.path}`).join('; ') || 'none'})`);
}

/** Set one value in a containing object (applying the cross-field adjustment for the probed key). */
function withValue(root: J, objPtr: string, key: string, value: J, dpath: string): J {
  const o = clone(getAt(root, objPtr)) as Obj;
  o[key] = value;
  const adj = ADJUST[dpath];
  // A vector's cross-field rule too (the track rig's bounds).
  if (adj !== undefined && (typeof value === 'number' || Array.isArray(value))) adj(o, value as number);
  return setAt(root, objPtr, o);
}

function filler(len: number): string {
  return 'a'.repeat(len);
}

function probeNumberRange(ctx: Ctx, root: J, objPtr: string, key: string, d: { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean; nonZero?: boolean; values?: readonly number[] }, isInt: boolean, errAt: string, dpath: string): void {
  const ptr = `${objPtr}/${key}`;
  if (d.min !== undefined) {
    if (d.minExclusive) {
      expectErr(ctx, withValue(root, objPtr, key, d.min, dpath), errAt, `exclusive min ${d.min}`);
      expectOk(ctx, withValue(root, objPtr, key, d.min + eps(d.min) * 1000, dpath), errAt, `just above exclusive min ${d.min}`);
    } else if (!(d.nonZero && d.min === 0)) {
      expectOk(ctx, withValue(root, objPtr, key, d.min, dpath), errAt, `min ${d.min}`);
    }
    expectErr(ctx, withValue(root, objPtr, key, d.min - (isInt ? 1 : eps(d.min) * 1000), dpath), errAt, `below min ${d.min}`);
  }
  if (d.max !== undefined) {
    if (d.maxExclusive) {
      expectErr(ctx, withValue(root, objPtr, key, d.max, dpath), errAt, `exclusive max ${d.max}`);
      expectOk(ctx, withValue(root, objPtr, key, d.max - eps(d.max) * 1000, dpath), errAt, `just below exclusive max ${d.max}`);
    } else expectOk(ctx, withValue(root, objPtr, key, d.max, dpath), errAt, `max ${d.max}`);
    expectErr(ctx, withValue(root, objPtr, key, d.max + (isInt ? 1 : eps(d.max) * 1000), dpath), errAt, `above max ${d.max}`);
  }
  if (d.nonZero) expectErr(ctx, withValue(root, objPtr, key, 0, dpath), errAt, '0 (non-zero)');
  // A choice of numbers — each accepted, a whole number between two refused.
  if (d.values !== undefined) {
    for (const v of d.values) expectOk(ctx, withValue(root, objPtr, key, v, dpath), errAt, `value ${v}`);
    for (let v = (d.min ?? d.values[0]!) + 1; v < (d.max ?? d.values[d.values.length - 1]!); v++) {
      if (!d.values.includes(v)) {
        expectErr(ctx, withValue(root, objPtr, key, v, dpath), errAt, `${v} (not one of ${d.values.join(', ')})`);
        break;
      }
    }
  }
  if (isInt && d.min !== undefined && d.max !== undefined && d.max - d.min >= 1) expectErr(ctx, withValue(root, objPtr, key, d.min + 0.5, dpath), errAt, 'a fraction');
  void ptr;
}

/** Probe the value at `objPtr/key` (present in the base) described by `d`. */
function probeField(ctx: Ctx, root: J, objPtr: string, key: string, d: FieldDescriptor, dpath: string, parent: { obj: Obj; fields: readonly FieldDescriptor[] } | undefined, isDiscriminator: boolean, listPtr?: string): void {
  const ptr = objPtr === '' && key === '' ? '' : `${objPtr}/${key}`;
  // a list validator reports a bad item at the list (not every validator names the item)
  const errAt = listPtr ?? ptr;
  visited.add(d);
  if (d.type === 'json' || d.type === 'components') return;
  const value = getAt(root, ptr);
  const set = (v: J): J => (ptr === '' ? v : withValue(root, objPtr, key, v, dpath));
  // wrong type / null
  if (d.type !== 'object' && d.type !== 'map' && d.type !== 'list') {
    if (!d.nullable) expectErr(ctx, set(null), errAt, 'null');
    else expectOk(ctx, set(null), errAt, 'null (nullable)');
  }
  if (d.readOnly && d.type !== 'object' && d.type !== 'list') return; // written by tools: presence and type only
  switch (d.type) {
    case 'number':
    case 'int':
      expectErr(ctx, set('x'), errAt, 'a string');
      probeNumberRange(ctx, root, objPtr, key, d, d.type === 'int', errAt, dpath);
      return;
    case 'bool':
      expectErr(ctx, set('x'), errAt, 'a string');
      return;
    case 'enum':
      expectErr(ctx, set('zz_not_an_option'), errAt, 'an unknown option');
      if (!isDiscriminator) for (const o of d.options) if (!(d.omitDefault && o.value === d.default)) expectOk(ctx, set(o.value), errAt, `option ${o.value}`);
      return;
    case 'color':
      expectErr(ctx, set('#zzzzzz'), errAt, 'a bad colour');
      expectErr(ctx, set(42), errAt, 'a number');
      return;
    case 'string':
      expectErr(ctx, set(42), errAt, 'a number');
      if (d.maxLength !== undefined) {
        expectOk(ctx, set(filler(d.maxLength)), errAt, `${d.maxLength} characters`);
        expectErr(ctx, set(filler(d.maxLength + 1)), errAt, `${d.maxLength + 1} characters`);
      }
      if (d.minLength !== undefined && d.minLength >= 1) expectErr(ctx, set(''), errAt, 'empty');
      return;
    case 'assetRef':
    case 'entityRef':
    case 'sceneRef':
    case 'ref':
      expectErr(ctx, set(42), errAt, 'a number');
      return;
    case 'signal':
      expectErr(ctx, set(42), errAt, 'a number');
      expectErr(ctx, set('not a signal!'), errAt, 'a bad signal name');
      return;
    case 'quat':
      expectErr(ctx, set('x'), errAt, 'a string');
      return;
    case 'vec2':
    case 'vec3': {
      const n = d.type === 'vec2' ? 2 : 3;
      // A vec3 whose last component may be left out is probed at full length (and short).
      const v0 = value as number[];
      const v = d.optionalLast === true && v0.length === n - 1 ? [...v0, 0] : v0;
      if (d.optionalLast === true) expectOk(ctx, set(v.slice(0, n - 1)), errAt, 'the last component left out');
      expectErr(ctx, set([...v, 0]), errAt, 'too many components');
      expectErr(ctx, set('x'), errAt, 'a string');
      for (let i = 0; i < n; i++) {
        // Tied components move together, so a bound is probed on all of them at once.
        const comp = (x: number): J => {
          const copy = [...v];
          copy[i] = x;
          if (d.same?.includes(i) === true) for (const j of d.same) copy[j] = x;
          return set(copy);
        };
        const skipMaxOk = d.ascending === true && i === 0;
        const skipMinOk = d.ascending === true && i === 1;
        if (d.min !== undefined) {
          if (d.minExclusive) expectErr(ctx, comp(d.min), errAt, `component ${i} at exclusive min`);
          else if (!skipMinOk) expectOk(ctx, comp(d.min), errAt, `component ${i} at min ${d.min}`);
          expectErr(ctx, comp(d.min - eps(d.min) * 1000), errAt, `component ${i} below min`);
        }
        if (d.max !== undefined) {
          if (!skipMaxOk) expectOk(ctx, comp(d.max), errAt, `component ${i} at max ${d.max}`);
          expectErr(ctx, comp(d.max + eps(d.max) * 1000), errAt, `component ${i} above max`);
        }
      }
      if (d.same !== undefined && d.same.length > 1) {
        const copy = [...v];
        copy[d.same[0]!] = (copy[d.same[1]!] as number) + (d.step ?? 1);
        expectErr(ctx, set(copy), errAt, 'tied components differ');
      }
      if (d.nonZero) expectErr(ctx, set(new Array(n).fill(0)), errAt, 'all zero');
      if (d.ascending) expectErr(ctx, set([v[1], v[0]]), errAt, 'descending');
      return;
    }
    case 'object':
      probeObject(ctx, root, ptr, d, dpath, parent);
      return;
    case 'list':
      probeList(ctx, root, ptr, d, dpath);
      return;
    case 'map': {
      const o = value as Obj;
      const k0 = Object.keys(o)[0];
      if (k0 !== undefined) probeField(ctx, root, ptr, k0, d.value, dpath.endsWith(':') ? `${dpath}*` : `${dpath}.*`, undefined, false);
      else visited.add(d.value);
      return;
    }
  }
}

function probeList(ctx: Ctx, root: J, ptr: string, d: ListFieldDescriptor, dpath: string): void {
  const v = getAt(root, ptr) as unknown[];
  if (v.length > 0) probeField(ctx, root, ptr, '0', d.item, dpath.endsWith(':') ? `${dpath}*` : `${dpath}.*`, undefined, false, d.item.type === 'object' ? undefined : ptr);
  expectErr(ctx, setAt(root, ptr, 'x'), ptr, 'a string instead of a list');
  const scalarItems = d.item.type !== 'object' && d.item.type !== 'list' && d.item.type !== 'map' && d.item.type !== 'json';
  if (!scalarItems || v.length === 0 || SKIP_COUNT.has(dpath) || d.readOnly) return;
  const items = (n: number): unknown[] => Array.from({ length: n }, (_, i) => (d.unique ? (typeof v[0] === 'string' ? `${v[0] as string}${i}` : i) : clone(v[0])));
  const lo = d.length ?? d.minItems;
  const hi = d.length ?? d.maxItems;
  if (lo !== undefined && lo >= 1) {
    expectOk(ctx, setAt(root, ptr, items(lo)), ptr, `${lo} items`);
    expectErr(ctx, setAt(root, ptr, items(lo - 1)), ptr, `${lo - 1} items`);
  }
  if (hi !== undefined) {
    expectOk(ctx, setAt(root, ptr, items(hi)), ptr, `${hi} items`);
    expectErr(ctx, setAt(root, ptr, items(hi + 1)), ptr, `${hi + 1} items`);
  }
  if (d.unique && v.length > 0) expectErr(ctx, setAt(root, ptr, [v[0], v[0]]), ptr, 'a repeated item');
}

const allKeys = (d: ObjectFieldDescriptor): Set<string> => new Set(d.fields.map((f) => f.key));

function probeObject(ctx: Ctx, root: J, ptr: string, d: ObjectFieldDescriptor, dpath: string, parent: { obj: Obj; fields: readonly FieldDescriptor[] } | undefined): void {
  visited.add(d);
  const obj = getAt(root, ptr) as Obj;
  const here = (k: string): string => (dpath.endsWith(':') ? `${dpath}${k}` : `${dpath}.${k}`);
  // 1. an unknown key is refused, and every key the validator lists as allowed has a descriptor
  const probeErrs = ctx.validate(setAt(root, `${ptr}/zz_probe`, 1)).filter((e) => e.path === `${ptr}/zz_probe`);
  if (!probeErrs.some(isUnknownKey)) fail(`${ctx.label} ${ptr}: an unknown key is not refused as unknown`);
  const tokens = new Set(probeErrs.flatMap((e) => `${e.expected ?? ''} ${e.message}`.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []));
  const described = allKeys(d);
  for (const t of tokens) {
    if (described.has(t) || t === 'zz_probe') continue;
    const errs = ctx.validate(setAt(root, `${ptr}/${t}`, { zz: 1 })).filter((e) => e.path === `${ptr}/${t}` || e.path.startsWith(`${ptr}/${t}/`));
    // refused as unknown, or its key itself judged (key syntax), not its value
    if (!errs.some((e) => isUnknownKey(e) || e.found === t)) fail(`${ctx.label} ${ptr}: the validator knows "${t}" but it has no descriptor`);
  }
  // 2. every applicable described key: present in the base, required/optional as described, then probed
  const disc = discriminators(d.fields);
  const self = { obj, fields: d.fields };
  for (const f of d.fields) {
    if (!holds(f.when, obj, d.fields, parent)) continue;
    const p = `${ptr}/${f.key}`;
    if (obj[f.key] === undefined) continue; // covered by another base (coverage check)
    const without = setAt(root, p, undefined);
    if (f.required) {
      if (ctx.validate(without).length === 0) fail(`${ctx.label} ${p}: removing a required field should be refused`);
    }
    else if (!(disc.has(f.key) && obj[f.key] !== f.default) && !ONE_OF_REMOVAL.has(here(f.key))) {
      const errs = ctx.validate(without);
      if (errs.length > 0) fail(`${ctx.label} ${p}: removing the optional field should be accepted, got ${errs.map((e) => `${e.code} ${e.path}`).join('; ')}`);
    }
    probeField(ctx, root, ptr, f.key, f, here(f.key), self, disc.has(f.key));
  }
}

/** Probe one base: it validates, then every described field is probed. */
function probe(label: string, validate: Validate, root: J, ptr: string, d: FieldDescriptor, dpath: string, parent?: { obj: Obj; fields: readonly FieldDescriptor[] }): void {
  const ctx: Ctx = { label, validate };
  const base = validate(root);
  if (base.length > 0) {
    fail(`${label}: the base does not validate: ${base.map((e) => `${e.code} ${e.path} ${e.message}`).join('; ')}`);
    return;
  }
  if (d.type === 'object') probeObject(ctx, root, ptr, d, dpath, parent);
  else {
    const parts = seg(ptr);
    probeField(ctx, root, parts.length <= 1 ? '' : `/${parts.slice(0, -1).join('/')}`, parts[parts.length - 1] ?? '', d, dpath, parent, false);
  }
}

// ---- validators as root functions -------------------------------------------------

const errorsOf = (fn: (errors: ModelErrorV2[]) => void): Err[] => {
  const errors: ModelErrorV2[] = [];
  fn(errors);
  return errors as unknown as Err[];
};
const sceneErrors: Validate = (doc) => {
  const r = validateSceneV4(doc);
  return r.ok ? [] : (r.errors as unknown as Err[]);
};
const contentErrors: Validate = (doc) => {
  const r = validateContentV4(doc);
  return r.ok ? [] : (r.errors as unknown as Err[]);
};

// ---- bases ----------------------------------------------------------------------------

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const SPAWN = { id: 'spawn-0001', components: { transform: T, playerSpawn: {} } };
const PARTNERS: Record<string, Obj> = {
  surface: { box: { size: [1, 1, 1] } },
  materials: { box: { size: [1, 1, 1] } },
  materialParams: { box: { size: [1, 1, 1] } },
  animator: { model: { asset: { assetId: 'model-a' } } },
  modelAnimation: { model: { asset: { assetId: 'model-a' } } },
};
function entityScene(name: string, value: J, extra: Obj = {}): J {
  // A model collider shape is made from the object's own model.
  const modelShape = name === 'collider' && ((value as Obj | null)?.['shape'] as Obj | undefined)?.['type'] === 'model';
  const comps: Obj = name === 'folder' ? { folder: value } : { transform: T, ...(PARTNERS[name] ?? {}), ...(modelShape ? { model: { asset: { assetId: 'model-a' } } } : {}), ...extra, [name]: value };
  if (name === 'transform') comps['transform'] = value;
  return { schemaVersion: 4, sceneId: 'main', revision: 1, entities: [SPAWN, { id: 'subject-0001', components: comps }] };
}

const LIGHTS = [
  { type: 'directional', color: '#fff4e0', intensity: 1.6, direction: [0.4, -1, -0.6], castShadow: true, mode: 'mixed', shadowMapSize: 2048, shadowBias: -0.001, shadowNormalBias: 0.05, shadowExtent: 30, lightMask: 5, shadowCasterMask: 3 },
  { type: 'ambient', color: '#8a94b0', intensity: 0.9, mode: 'baked' },
  { type: 'point', color: '#ffd9a0', intensity: 30, range: 8, decay: 2, castShadow: true, mode: 'realtime', lightMask: 0, shadowCasterMask: 254, importance: 'vertex' },
  { type: 'spot', color: '#ffffff', intensity: 80, range: 12, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -1, 0], castShadow: false, cookie: 'tex-a' },
  { type: 'hemisphere', color: '#bcd7ff', groundColor: '#5a4a38', intensity: 0.8, mode: 'baked' },
];

/** One placed primitive collider shape of each type (compound bases list them). */
const COMPONENT_BASES_PLACED: Record<string, J> = {
  polygon: { type: 'polygon', vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], center: [1, 2, 0], rotation: [0, 0, 0, 1] },
  sphere: { type: 'sphere', radius: 0.5, center: [0, 1, 0], rotation: [0, 0, 0, 1] },
  capsule: { type: 'capsule', radius: 0.5, height: 2, center: [0, 1, 0], rotation: [0, 0, 0, 1] },
  convex: { type: 'convex', points: [[-1, -1, -1], [1, -1, -1], [0, 1, -1], [0, 0, 1]], center: [0, 1, 0], rotation: [0, 0, 0, 1] },
  mesh: { type: 'mesh', vertices: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], triangles: [[0, 2, 1], [0, 3, 2]], center: [0, 1, 0], rotation: [0, 0, 0, 1] },
};

/** Every component's variant bases (each fills every field that applies). */
const COMPONENT_BASES: Record<string, J[]> = {
  transform: [{ position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 2, 1] }],
  model: [{ asset: { assetId: 'model-a' }, piece: 'Tree', castShadow: false, receiveShadow: true, lightLayers: 2, localLights: 'vertex' }],
  box: [{ size: [1, 2, 3], material: { color: '#aabbcc' }, castShadow: true, receiveShadow: false, lightLayers: 3, localLights: 'none' }],
  materials: [{ '*': 'mat-a', Bark: 'mat-b' }],
  materialParams: [{ 'mat-a': { tint: '#aabbcc', speed: 2, offset: [1, 2] } }],
  effect: [{ effectId: 'fx-a', playOnStart: false, params: { rate: 3, tint: '#aabbcc', offset: [1, 2, 3] }, signal: 'go', stopSignal: 'halt' }],
  surface: [{ color: '#aabbcc', roughness: 0.5, metalness: 0.2, emissive: '#112233', emissiveIntensity: 1 }],
  instances: [{ asset: { assetId: 'model-a', piece: 'Rock' }, buffer: 'a'.repeat(64), count: 10, castShadow: false, receiveShadow: false, chunkSize: 24, lightLayers: 4, densityStart: 0.03, densityEnd: 0.01, densityMin: 0.5, lodPerCopy: true , localLights: 'pixel' }],
  fogVolume: [{ size: [6, 3, 4], density: 0.25, color: '#dfe7ef', falloff: 0.5, heightFalloff: 0.3 }],
  probeVolume: [{ size: [16, 6, 16], spacing: 1.5 }],
  collider: [
    { shape: { type: 'box', hx: 0.5, hy: 0.25 }, oneWay: true },
    { shape: { type: 'box', hx: 0.5, hy: 0.25, hz: 1 }, layers: ['default', 'props'] },
    { shape: { type: 'polygon', vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]] } },
    // The 3D shapes (their dimension rule is the project's, not the scene's).
    { shape: { type: 'sphere', radius: 0.5 } },
    { shape: { type: 'capsule', radius: 0.5, height: 100 } },
    { shape: { type: 'convex', points: [[-1, -1, -1], [1, -1, -1], [0, 1, -1], [0, 0, 1]] } },
    { shape: { type: 'mesh', vertices: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], triangles: [[0, 2, 1], [0, 3, 2]] } },
    // Placed shapes, a compound of every primitive and the model's _COL parts.
    { shape: { type: 'box', hx: 0.5, hy: 0.25, hz: 1, center: [0, 0.25, 0], rotation: [0, 0, 0.7071067811865476, 0.7071067811865476] } },
    { shape: { type: 'polygon', vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], center: [1, 2, 0], rotation: [0, 0, 0, 1] } },
    { shape: { type: 'sphere', radius: 0.5, center: [0, 1, 0], rotation: [0, 0, 0, 1] } },
    { shape: { type: 'capsule', radius: 0.5, height: 2, center: [0, 1, 0], rotation: [0, 0, 0, 1] } },
    { shape: { type: 'convex', points: [[-1, -1, -1], [1, -1, -1], [0, 1, -1], [0, 0, 1]], center: [0, 1, 0], rotation: [0, 0, 0, 1] } },
    { shape: { type: 'mesh', vertices: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], triangles: [[0, 2, 1], [0, 3, 2]], center: [0, 1, 0], rotation: [0, 0, 0, 1] } },
    { shape: { type: 'compound', shapes: [
      { type: 'box', hx: 0.5, hy: 0.25, hz: 1, center: [0, 0.25, 0], rotation: [0, 0, 0, 1] },
      { type: 'polygon', vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]], center: [1, 2, 0], rotation: [0, 0, 0, 1] },
      { type: 'sphere', radius: 0.5, center: [0, 1, 0], rotation: [0, 0, 0, 1] },
      { type: 'capsule', radius: 0.5, height: 2, center: [0, 1, 0], rotation: [0, 0, 0, 1] },
      { type: 'convex', points: [[-1, -1, -1], [1, -1, -1], [0, 1, -1], [0, 0, 1]], center: [0, 1, 0], rotation: [0, 0, 0, 1] },
      { type: 'mesh', vertices: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], triangles: [[0, 2, 1], [0, 3, 2]], center: [0, 1, 0], rotation: [0, 0, 0, 1] },
    ] } },
    // The list probe reads a compound's first shape: one compound per primitive type.
    ...['polygon', 'sphere', 'capsule', 'convex', 'mesh'].map((type) => ({ shape: { type: 'compound', shapes: [COMPONENT_BASES_PLACED[type]!] } })),
    { shape: { type: 'model' } },
  ],
  controller: [{ capsule: { radius: 0.3, height: 1.8, offset: [0, 0.1] }, acceleration: 30, deceleration: 50, coyoteTime: 0.1, jumpBuffer: 0.1, jumpRelease: 0.4, groundSnap: 0.2, skin: 0.02, autostep: true, autostepHeight: 0.3, walkSpeed: 2.5, runSpeed: 6, airControl: 0.3, gravityScale: 1.5, turnSpeed: 360, faceMovement: false, moveFrame: 'world', jump: true, jumpSpeed: 5, slopeLimit: 40, stepHeight: 0.5, ledgeClimb: true, ledgeHeight: 1, ledgeClimbTime: 0.4, moveAction: 'walk', jumpAction: 'hop', runAction: 'dash', climbSpeed: 1.5, climbAction: 'climb', wallSlide: true, wallSlideSpeed: 1, wallJump: true, wallJumpAway: 5, wallJumpUp: 6, wallJumpLock: 0.2 }],
  camera: [{ type: 'perspective', fovY: 60, near: 0.1, far: 100 }],
  // The behavior group an object's script belongs to.
  behaviorGroup: [{ group: 'field' }],
  // A socket with its offset, and one a script attaches later.
  socketAttach: [
    { target: 'spawn-0001', node: 'hand_R', position: [0.1, 0, -0.05], rotation: [0, 0.7071067811865476, 0, 0.7071067811865476], scale: [1, 2, 1], attached: false },
    { target: 'spawn-0001', node: 'Armature Bone.001' },
  ],
  virtualCamera: [
    { rig: 'follow', priority: 5, enabled: false, target: 'spawn-0001', targetOffset: [0, 1.5, 0], distance: 6, minDistance: 1, maxDistance: 20, yaw: 30, pitch: 25, pitchMin: -20, pitchMax: 60, yawAction: 'look', pitchAction: 'tilt', rotateSpeed: 90, zoomAction: 'zoom', zoomSpeed: 5, collision: false, collisionRadius: 0.3, damping: 0.2, fovY: 50, near: 0.2, far: 500, blend: 'linear', blendTime: 1, letterbox: 0.1, shakeAmplitude: 0.05, shakeFrequency: 6, shakeRotation: 1 },
    { rig: 'orbitPoint', distance: 15, minDistance: 5, maxDistance: 40, yaw: 45, pitch: 45, pitchMin: 20, pitchMax: 70, pitchAction: 'tilt', rotateSpeed: 60, zoomAction: 'zoom', zoomSpeed: 10, turnLeftAction: 'left', turnRightAction: 'right', yawStep: 90, turnTime: 0.3, point: [1, 0, 2], damping: 0.1, blend: 'cut' },
    { rig: 'topDown', target: 'spawn-0001', distance: 12, yaw: 90, damping: 0 },
    { rig: 'fixed', target: 'spawn-0001', blend: 'eased', blendTime: 2 },
    { rig: 'rail', path: 'path-0001', progress: 0.25, railSpeed: 3, railMode: 'pingpong', target: 'spawn-0001' },
    // The track rig.
    { rig: 'track', target: 'spawn-0001', trackOffset: [0, 2, 12], deadZone: [2, 1, 2], boundsMin: [-50, -10, -50], boundsMax: [50, 20, 50], damping: 0.2 },
    // Look-ahead.
    { rig: 'track', target: 'spawn-0001', lookAhead: [0, 0.4, 0], lookAheadMax: [2, 3, 2], lookAheadSmoothing: 0.3 },
  ],
  // A camera region.
  cameraRegion: [
    { size: [20, 8, 4], camera: 'spawn-0001', priority: 2, deadZone: [3, 1, 0], boundsMin: [-5, -2, -1], boundsMax: [5, 2, 1], distance: 15, blendTime: 1 },
    { size: [10, 6, 10] },
  ],
  cameraPath: [{ points: [[0, 0, 0], [4, 1, 0], [8, 0, 2]], closed: true, smooth: false }],
  light: LIGHTS,
  playerSpawn: [{ yaw: 90 }],
  mover: [{ waypoints: [[1, 0, 0], [2, 1, 0]], speed: 2, mode: 'loop', wait: 0.5, easing: 'smooth', startOn: 'go', maxPush: 30, active: false, stopOn: 'halt', toggleOn: 'flip', reverseOn: 'back' }],
  trigger: [
    { shape: 'box', size: [2, 2, 2], signal: 'enter', exitSignal: 'leave', mode: 'stay', once: true },
    { shape: 'circle', radius: 1.5, signal: 'enter' },
    // The 3D areas.
    { shape: 'sphere', radius: 1.5, signal: 'enter' },
    { shape: 'capsule', radius: 0.025, height: 500, signal: 'enter' },
    // A scene transition.
    { size: [2, 2, 2], signal: 'door', sceneTransition: { scene: 'scene-b', spawn: 'spawn-0001', unload: ['scene-c'], fade: 0.5, fadeColor: '#101820' } },
  ],
  switch: [{ mode: 'stand', signal: 'open', size: [1, 1], once: true }, { mode: 'interact', signal: 'open', size: [1, 1], action: 'use' }],
  health: [{ max: 5, start: 3 }],
  // The generic primitives.
  collectible: [{ counter: 'shards', amount: -2.5, size: [1, 2, 3], onCollect: 'got', respawn: 4 }, { counter: 'items' }],
  patrol: [
    { mode: 'edges', speed: 2, wait: 0.5, direction: [0, 0, -1], size: [1, 2, 1], wallProbe: 0.1, ledgeProbe: 0.6 },
    { mode: 'waypoints', waypoints: [[4, 0, 0], [4, 2, 0]], loop: true, speed: 1, wait: 1 },
  ],
  hitbox: [{ shape: 'box', size: [1, 2, 3], damage: 2 }, { shape: 'sphere', radius: 0.5 }],
  // A climb volume and a gravity body.
  climbVolume: [{ size: [1, 4, 1] }, { size: [2, 3, 0.5] }],
  gravity: [{ scale: 0.5, size: [1, 2, 1] }, {}],
  audioSource: [{ assetId: 'cue-a', volume: 0.8, range: 12 }, { assetId: 'cue-a', volume: 0.8, range: 12, distanceModel: 'inverse', refDistance: 2, rolloff: 1.5 }],
  animator: [{ controller: 'ctl-a', parameters: { speed: 1, grounded: true }, startTime: 0.25 }, { controller: 'ctl-a', randomStart: true, lookAt: { head: { bone: 'Head', yaw: 60, pitch: 30 }, neck: { bone: 'Neck', yaw: 30, pitch: 20 }, chest: { bone: 'Spine', yaw: 15, pitch: 10 }, target: 'spawn-0001', weight: 0.5, weightParameter: 'speed', turnSpeed: 180 } }, { controller: 'ctl-a', lookAt: { head: { bone: 'Head', yaw: 60, pitch: 30 }, point: [1, 2, 3] } }],
  faceMovement: [{ yawRight: 90, yawLeft: -90, turnSeconds: 0.12 }, { mode: 'velocity', yawOffset: -90, turnSeconds: 0.2 }],
  modelAnimation: [{ assetId: 'model-a', version: 1, roles: { idle: { clipIndex: 0 }, run: { clipIndex: 1 }, airborne: { clipIndex: 2 } } }],
  behavior: [{ behaviorId: 'beh-a', values: { speed: 3 } }],
  prefab: [{ prefabId: 'pre-a', localId: 'root' }],
  folder: [{}],
  // A block layer (every optional flag set to its non-default value).
  blockLayer: [{ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] }, metadataOnly: true, collision: false, castShadow: false, receiveShadow: false, maxSlope: 30, smoothAngle: 40, topSubdivision: 2, wallPaint: true, lightLayers: 128, cutaway: { regions: [{ region: 'roof', when: 'room' }], planes: [4], fade: 0.5 }, kits: [{ kit: 'ruined', region: 'hall' }], walk: { from: 'spawn', maxStep: 0.5, maxDrop: 1, headroom: 1.8, field: 'walkable', diagonal: true }, vertexAO: 0.6 }],
  // A prop's block footprint.
  blockFootprint: [{ layer: 'layer-a', size: [2, 3], set: { blocked: true, cost: 4 } }],
};

const SKY_PROCEDURAL = { mode: 'procedural', turbidity: 6, rayleigh: 1.5, mieCoefficient: 0.005, mieDirectionalG: 0.8, sunFromLight: false, sunElevation: 35, sunAzimuth: 160, intensity: 1, environmentIntensity: 1 };
const POST_FULL = {
  toneMapping: 'agx',
  exposure: 1,
  antialias: 'fxaa',
  bloom: { enabled: true, strength: 0.6, radius: 0.4, threshold: 0.85 },
  grading: { contrast: 0.1, saturation: 0.1, brightness: 0.1, tint: '#ffffff', lut: 'tex-a', lift: 0, gamma: 1, gain: 1 },
  vignette: { enabled: true, darkness: 0.5, offset: 1 },
  ssao: { enabled: true, radius: 0.5, intensity: 1 },
  dof: { enabled: false, focus: 10, aperture: 0.002, maxBlur: 0.01 },
};
const WIND_FULL = { direction: [1, 0], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 };
// A scene's look.
const SCENE_ENV_BASES: J[] = [
  { sky: SKY_PROCEDURAL, fog: { mode: 'linear', color: '#c8d2dc', near: 10, far: 120 }, post: POST_FULL, wind: WIND_FULL, wetness: 0.4 },
  { sky: { mode: 'gradient', topColor: '#3d7cd6', horizonColor: '#bfe3ff', bottomColor: '#6b7b5a', intensity: 1 }, fog: { mode: 'exp2', color: '#c8d2dc', density: 0.01 } },
  { sky: { mode: 'texture', texture: 'tex-a', cube: ['px', 'nx', 'py', 'ny', 'pz', 'nz'], rotation: 90 }, fog: { mode: 'none', color: '#c8d2dc' } },
  { sky: { mode: 'color', color: '#7ec8ff' } },
];
// The project's part: the quality and the presets.
const ENV_BASES: J[] = [
  { quality: 'medium' },
  // The project's own quality levels (every field of a level).
  {
    qualityLevels: [
      {
        id: 'low',
        name: 'Low',
        post: { bloom: { enabled: false, strength: 0.3, radius: 0.2, threshold: 1 }, ssao: { enabled: true, radius: 0.3, intensity: 1 }, dof: { enabled: false, focus: 5, aperture: 0.001, maxBlur: 0.005 }, antialias: 'fxaa' },
        renderScale: 0.75,
        pixelRatio: 1,
        msaa: 0,
        shadowMapSize: 1024,
        localLights: 4,
        ambientOcclusion: 'ssao',
        lodBias: 0.5,
        dynamicResolution: true,
      },
      { id: 'high' },
    ],
  },
  // Environment presets.
  {
    presets: [
      {
        presetId: 'night',
        name: 'Night',
        sky: { mode: 'color', color: '#000010' },
        fog: { mode: 'linear', color: '#101820', near: 5, far: 40 },
        post: POST_FULL,
        lights: [
          { entity: 'light-0001', color: '#8090ff', intensity: 0.2, direction: [0, -1, 0], groundColor: '#101010' },
          { tag: 'Lamps', intensity: 30 },
          { type: 'ambient', color: '#101020' },
        ],
        lightmap: { intensity: 0.25, tint: '#8090ff' },
        wetness: 0.7,
      },
    ],
  },
  { presets: [{ presetId: 'lamps', name: 'Lamps', lights: [{ tag: 'Lamps', intensity: 30 }] }] },
  { presets: [{ presetId: 'dim', name: 'Dim', lights: [{ type: 'ambient', color: '#101020' }] }] },
];

const BINDINGS: { type: string; binding: Obj }[] = [
  // A hold binding.
  { type: 'button', binding: { kind: 'key', code: 'Space', hold: 0.5 } },
  { type: 'button', binding: { kind: 'gamepadButton', button: 0, pad: 1 } },
  { type: 'axis1d', binding: { kind: 'gamepadAxis', axis: 0 } },
  { type: 'axis1d', binding: { kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' } },
  { type: 'axis1d', binding: { kind: 'gamepadButtons1d', negative: 14, positive: 15 } },
  { type: 'axis2d', binding: { kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' } },
  { type: 'axis2d', binding: { kind: 'gamepadStick', x: 0, y: 1 } },
  // The pointer bindings.
  { type: 'button', binding: { kind: 'pointerButton', button: 'right' } },
  { type: 'axis1d', binding: { kind: 'pointerAxis', axis: 'wheel' } },
  { type: 'axis2d', binding: { kind: 'pointerPosition' } },
  { type: 'axis2d', binding: { kind: 'pointerDelta' } },
];
const INPUT_BASES: J[] = [
  ...BINDINGS.map((b, i) => ({ actions: [{ name: 'act', type: b.type, map: 'ui', bindings: [b.binding], deadZone: 0.2, invert: true, scale: 2 }], ...(i === 0 ? { cursor: { gameplay: 'locked', ui: 'free' }, glyphs: { 'xbox:pad-south': 'tex-a' } } : {}) })),
  // The project's own input maps (an action of one).
  { actions: [{ name: 'select', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'KeyE' }] }], maps: ['tactical', 'build'] },
];

// An effect with a parameter of every type and one system.
const EFFECT_GRAPH = { nodes: ['spawn', 'initialize', 'update', 'output'].map((c, i) => ({ id: c, type: c, position: [0, i * 200] })), edges: [] };
const EFFECT_BASES: J[] = [
  [
    {
      effectId: 'fx-a',
      name: 'Effect',
      duration: 3,
      loop: false,
      seed: 7,
      bounds: { center: [0, 1, 0], size: [2, 2, 2] },
      parameters: [
        { key: 'rate', type: 'float', default: 2, min: 0, max: 10, visibility: 'private', label: 'Rate', group: 'Spawn', tooltip: 'How many.' },
        { key: 'offset', type: 'vec3', default: [0, 1, 0], min: -5, max: 5 },
        { key: 'tint', type: 'color', default: '#ffaa00' },
      ],
      systems: [{ systemId: 'sparks', name: 'Sparks', maxParticles: 500, space: 'world', graph: EFFECT_GRAPH }],
    },
  ],
];
const MATERIAL_BASES: J[] = [
  ...MATERIAL_SHADERS.map((s) => [
    { materialId: 'mat-a', name: 'Material', shader: s, params: Object.fromEntries(Object.entries(MATERIAL_PARAMS[s]).map(([k, t]) => [k, clone(t.default)])), textures: Object.fromEntries(MATERIAL_TEXTURE_SLOTS[s].map((slot) => [slot, 'tex-a'])) },
  ]),
  // A graph material with an exposed parameter.
  [
    {
      materialId: 'mat-g',
      name: 'Graph material',
      shader: 'standard',
      params: {},
      textures: {},
      parameters: [{ key: 'speed', type: 'float', default: 1, min: 0, max: 10, visibility: 'private', label: 'Speed', group: 'Motion', tooltip: 'How fast it moves.' }],
      graph: { nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }], edges: [] },
    },
  ],
  // A material instance (checked against its parent with the whole list elsewhere).
  [{ materialId: 'mat-i', name: 'Instance', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-g', values: { speed: 2 } }],
  // A graph material with a data parameter (its grid size).
  [
    {
      materialId: 'mat-d',
      name: 'Data material',
      shader: 'standard',
      params: {},
      textures: {},
      parameters: [{ key: 'cells', type: 'data', default: [0, 0, 0, 0], size: [4, 4] }],
      graph: { nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }], edges: [] },
    },
  ],
];

const CLIP = (name: string) => ({ assetId: 'model-a', clip: name, duration: 1 });
function animatorBase(o: { firstParam: 'float' | 'int' | 'bool' | 'trigger'; firstState: 'clip' | 'blend1d'; layerFirst: 'clip' | 'blend1d' | 'empty'; cond: 'number' | 'bool' | 'trigger' }): J {
  const params = [
    { name: 'speed', type: 'float', default: 0.5 },
    { name: 'count', type: 'int', default: 1 },
    { name: 'grounded', type: 'bool', default: true },
    { name: 'attack', type: 'trigger' },
  ];
  const first = params.findIndex((p) => p.type === o.firstParam);
  const ordered = [params[first]!, ...params.filter((_, i) => i !== first)];
  const motion = (kind: string, n: string) => (kind === 'clip' ? { kind: 'clip', clip: CLIP(n) } : kind === 'blend1d' ? { kind: 'blend1d', parameter: 'speed', children: [{ threshold: 0, clip: CLIP(`${n}-a`), speed: 0, position: [0, 0] }, { threshold: 1, clip: CLIP(`${n}-b`), speed: 1.4 }] } : { kind: 'empty' });
  const cond = o.cond === 'number' ? { parameter: 'speed', op: 'greater', value: 0.1 } : o.cond === 'bool' ? { parameter: 'grounded', op: 'true' } : { parameter: 'attack', op: 'trigger' };
  return [
    {
      controllerId: 'ctl-a',
      name: 'Controller',
      parameters: ordered,
      states: [
        { id: 'idle', name: 'Idle', motion: motion(o.firstState, 'idle'), speed: 1, speedParameter: 'speed', loop: true, position: [10, 20] },
        { id: 'run', name: 'Run', motion: motion('clip', 'run'), speed: 1, loop: true },
      ],
      transitions: [{ from: 'idle', to: 'run', conditions: [cond], duration: 0.2, exitTime: 0.5, interruption: 'source' }],
      entry: 'idle',
      events: [{ assetId: 'model-a', clip: 'run', time: 0.1, name: 'step' }],
      // A morph target driven by a float parameter.
      morphs: [{ target: 'smile', parameter: 'speed' }],
      layers: [
        {
          name: 'Upper body',
          mask: ['Spine', 'Head'],
          weight: 1,
          weightParameter: 'speed',
          states: [
            { id: 'l-first', name: 'First', motion: motion(o.layerFirst, 'l-first'), speed: 1, speedParameter: 'speed', loop: false, position: [0, 0] },
            { id: 'l-none', name: 'None', motion: motion('empty', 'x'), speed: 1, loop: true },
          ],
          transitions: [{ from: '*', to: 'l-none', conditions: [cond], duration: 0.1, exitTime: 1, interruption: 'none' }],
          entry: 'l-first',
        },
      ],
    },
  ];
}
const ANIMATOR_BASES: J[] = [
  animatorBase({ firstParam: 'float', firstState: 'clip', layerFirst: 'clip', cond: 'number' }),
  animatorBase({ firstParam: 'int', firstState: 'blend1d', layerFirst: 'blend1d', cond: 'bool' }),
  animatorBase({ firstParam: 'bool', firstState: 'clip', layerFirst: 'empty', cond: 'trigger' }),
  animatorBase({ firstParam: 'trigger', firstState: 'clip', layerFirst: 'clip', cond: 'number' }),
];

const SAMPLE = JSON.parse(
  Object.values(import.meta.glob('../../../templates/starter/captured/project.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>)[0] as string,
) as { content: { assets: Obj[] } };
const MODEL_ASSET = SAMPLE.content.assets.find((a) => a['kind'] === 'model')!;

function contentDoc(extra: Obj = {}): Obj {
  return {
    assets: [],
    prefabs: [],
    behaviors: [],
    settings: {},
    behaviorTrust: { entries: [] },
    scenes: [{ sceneId: 'main', name: 'Main' }],
    startScenes: ['main'],
    ...extra,
  };
}
const PROPERTY_BASES: Obj[] = [
  { key: 'speed', label: 'Speed', type: 'number', default: 5, min: 0, max: 10, step: 0.5, visibility: 'private', group: 'Movement', header: 'Tuning', tooltip: 'How fast.' },
  { key: 'title', label: 'Title', type: 'string', default: 'hi', maxLength: 32 },
  { key: 'mood', label: 'Mood', type: 'enum', default: 'calm', values: ['calm', 'angry'] },
  { key: 'offset', label: 'Offset', type: 'vec3', default: [0, 0, 0], bounds: { min: [-1, -1, -1], max: [1, 1, 1] } },
];

const block = (key: string): FieldDescriptor => DESCRIPTORS.content.find((b) => b.key === key)!.value;
const comp = (name: string): ComponentDescriptor => DESCRIPTORS.components.find((c) => c.name === name)!;

// ---- the probes ------------------------------------------------------------------------

// ---- UI documents -----------------------------------------------------------

const UI_STYLE_VALUES = { color: '#ffffff', background: '#00000080', opacity: 0.5, backgroundImage: 'tex-a', slice: [2, 2, 2, 2], font: 'sans', fontSize: 16, bold: true, italic: false, align: 'center', lineHeight: 1.2, letterSpacing: 1, textShadow: '#000000', padding: 4, radius: 4, borderWidth: 1, borderColor: '#ffffff', shadow: '#000000' };
const UI_SOUNDS = { click: 'snd-a', hover: 'snd-a', focus: 'snd-a' };
const UI_STYLE = { ...UI_STYLE_VALUES, sounds: UI_SOUNDS, hover: { ...UI_STYLE_VALUES }, focus: { ...UI_STYLE_VALUES }, pressed: { ...UI_STYLE_VALUES }, disabled: { ...UI_STYLE_VALUES } };
const UI_WIDGET_BASES: Record<string, unknown>[] = [
  {
    id: 'w', type: 'panel', anchor: [0.5, 0.5], pivot: [0.5, 0.5], offset: [1, 2], size: [100, 50], stretch: 'x', margin: [1, 2, 3, 4], grow: 1, style: 's1', css: UI_STYLE, visible: true, enabled: { bind: 'a.b' }, opacity: 0.5, rotation: 10, focusable: true, sounds: UI_SOUNDS,
    nav: { up: 'x1', down: 'x1', left: 'x1', right: 'x1', next: 'x1', prev: 'x1' }, onFocus: { do: 'event', name: 'f' },
    worldAnchor: { point: [0, 0, 0], offset: [0, 1, 0], clamp: true, margin: 12 }, children: [{ id: 'ind', type: 'panel' }],
  },
  { type: 'stack', direction: 'row', gap: 4, align: 'center', justify: 'between', wrap: true, children: [] },
  { type: 'grid', columns: 3, gap: 2, cellSize: [10, 10], align: 'start', children: [] },
  { type: 'text', text: 'Hi', wrap: false },
  { type: 'image', image: 'tex-a', slice: [1, 1, 1, 1], fit: 'contain' },
  { type: 'image', image: 'tex-a', tint: '#ff0000' },
  { type: 'image', saveSlot: 2, fit: 'cover' },
  { type: 'bar', value: 0.5, min: 0, max: { bind: 'm' }, shape: 'radial', direction: 'left', fillColor: '#00ff00', fillStyle: 's1', startAngle: 90 },
  { id: 'b', type: 'button', text: 'Go', direction: 'row', gap: 2, align: 'center', justify: 'center', onClick: { do: 'event', name: 'go' }, children: [] },
  { type: 'list', items: { bind: 'rows' }, itemKey: 'id', template: { type: 'text', text: '{$item}' }, direction: 'row', gap: 1, align: 'start', justify: 'start', columns: 2, wrap: true },
  { type: 'input', value: 'x', placeholder: 'Name', maxLength: 20, onSubmit: { do: 'event', name: 's' } },
];

function runUiProbes(): void {
  const ui = DESCRIPTORS.ui!;
  const validate: Validate = (v) => errorsOf((e) => validateUiDocument(v, '', e));
  const doc = {
    uiDocumentId: 'hud', name: 'HUD', theme: 'th-a', layer: 1, modal: true, focus: true, actionMap: 'ui', scale: { reference: [1280, 720], mode: 'fit' }, initialFocus: 'b1', onCancel: { do: 'hide', doc: 'hud' }, sounds: UI_SOUNDS,
    styles: { s1: UI_STYLE }, icons: { i1: { asset: 'tex-a', rect: [0, 0, 8, 8] } }, tweens: { in: { kind: 'slide', duration: 0.2, delay: 0, easing: 'easeOut', from: 1, to: 0, direction: 'left', distance: 40 } },
    root: { type: 'panel', children: [{ id: 'b1', type: 'button' }] },
  };
  probe('uiDocument', validate, doc, '', ui.document, 'uiDocument:');
  // The show/hide tweens name a tween of the document (removing the tweens would leave them dangling: probed on their own).
  probe('uiDocument[1]', validate, { ...doc, showTween: 'in', hideTween: 'in' }, '/showTween', ui.document.fields.find((f) => f.key === 'showTween')!, 'uiDocument:showTween');
  probe('uiDocument[2]', validate, { ...doc, showTween: 'in', hideTween: 'in' }, '/hideTween', ui.document.fields.find((f) => f.key === 'hideTween')!, 'uiDocument:hideTween');
  UI_WIDGET_BASES.forEach((w, i) =>
    probe(`uiWidget[${i}]`, validate, { uiDocumentId: 'd', name: 'D', root: { type: 'panel', children: [w, { id: 'x1', type: 'panel' }] } }, '/root/children/0', ui.widget, 'uiWidget:'),
  );
  // A style (the document's own), and its states with the same value fields.
  probe('uiStyle', validate, doc, '/styles/s1', ui.style, 'uiStyle:');
  const stateFields: ObjectFieldDescriptor = { ...ui.style, fields: ui.style.fields.filter((f) => !(f.type === 'json' && f.typedBy === 'uiStyleState') && f.key !== 'sounds') };
  for (const st of ['hover', 'focus', 'pressed', 'disabled']) probe(`uiStyle.${st}`, validate, doc, `/styles/s1/${st}`, stateFields, `uiStyle.${st}:`);
  probe('uiWidget.css', validate, { uiDocumentId: 'd', name: 'D', root: { type: 'panel', css: UI_STYLE } }, '/root/css', ui.style, 'uiWidget.css:');
  // The world anchor's indicator names a child (removing the children would leave it dangling: probed on its own).
  const withIndicator = { type: 'panel', worldAnchor: { point: [0, 0, 0], indicator: 'ind' }, children: [{ id: 'ind', type: 'panel' }] };
  const indicator = (ui.widget.fields.find((f) => f.key === 'worldAnchor') as ObjectFieldDescriptor).fields.find((f) => f.key === 'indicator')!;
  probe('uiWidget.indicator', validate, { uiDocumentId: 'd', name: 'D', root: withIndicator }, '/root/worldAnchor/indicator', indicator, 'uiWidget:worldAnchor.indicator');
  probe('uiTween', validate, { uiDocumentId: 'd', name: 'D', tweens: { t: { kind: 'fade', duration: 1, from: 0, to: 1 } }, root: { type: 'panel' } }, '/tweens/t', ui.tween, 'uiTween:');
}

function runAllProbes(): void {
  for (const c of DESCRIPTORS.components) {
    const bases = COMPONENT_BASES[c.name];
    if (bases === undefined) {
      fail(`component ${c.name} has no test base`);
      continue;
    }
    bases.forEach((b, i) => probe(`${c.name}[${i}]`, sceneErrors, entityScene(c.name, b), `/entities/1/components/${c.name}`, c.value, `${c.name}:`));
  }
  // the entity's own fields
  probe('entity', sceneErrors, { schemaVersion: 4, sceneId: 'main', revision: 1, entities: [{ id: 'parent-0001', components: { transform: T } }, { id: 'subject-0001', name: 'Thing', parentId: 'parent-0001', active: false, visible: false, locked: true, static: true, keepLoaded: true, tags: 5, components: { transform: T } }] }, '/entities/1', DESCRIPTORS.entity, 'entity:');
  // content blocks
  ENV_BASES.forEach((b, i) => probe(`environment[${i}]`, (v) => errorsOf((e) => validateEnvironment(v, '', e)), b, '', block('environment'), 'environment:'));
  SCENE_ENV_BASES.forEach((b, i) => probe(`sceneEnvironment[${i}]`, (v) => errorsOf((e) => validateSceneEnvironment(v, '', e)), b, '', DESCRIPTORS.sceneEnvironment!, 'sceneEnvironment:'));
  INPUT_BASES.forEach((b, i) => probe(`input[${i}]`, (v) => errorsOf((e) => validateInput(v, '', e)), b, '', block('input'), 'input:'));
  MATERIAL_BASES.forEach((b, i) => probe(`materials[${i}]`, (v) => errorsOf((e) => validateMaterials(v, '', e)), b, '', block('materials'), 'materials:'));
  EFFECT_BASES.forEach((b, i) => probe(`effects[${i}]`, (v) => errorsOf((e) => validateEffects(v, '', e)), b, '', block('effects'), 'effects:'));
  ANIMATOR_BASES.forEach((b, i) => probe(`animators[${i}]`, (v) => errorsOf((e) => validateAnimators(v, '', e)), b, '', block('animators'), 'animators:'));
  probe('tags', (v) => errorsOf((e) => validateTagRegistry(v, '', e)), [{ bit: 3, name: 'walker' }], '', block('tags'), 'tags:');
  probe('settings', contentErrors, contentDoc({ settings: { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, fixed_step_hz: 240, audio_voices: 12, music_fade_s: 2, animation_crossfade_s: 0.3, render_backend: 1, physics_dimension: 3, sim_thread: 2, debug_console: 1, random_seed: 7, depth_buffer: 2, audio_spatial: 2, instance_chunk_m: 16, texture_budget_mb: 256, camera_fov_deg: 50, camera_near_m: 0.3, camera_far_m: 400, import_extract_textures: 1, block_chunk_storage: 1, stats_overlay: 2, frame_rate_cap: 30, lod_bias: 1.5, lod_hysteresis: 0.2, ambient_occlusion: 2, render_scale: 0.75, dynamic_resolution: 1 } }), '/settings', block('settings'), 'settings:');
  probe('scenes', contentErrors, contentDoc(), '/scenes', block('scenes'), 'scenes:');
  probe('startScenes', contentErrors, contentDoc(), '/startScenes', block('startScenes'), 'startScenes:');
  const anims = { ...MODEL_ASSET, assetId: 'anims-0001', displayName: 'Anims', vertexColors: 'tint', materials: { '*': 'mat-a' }, extractTextures: true, textures: { '0': 'tex-albedo' }, clipsFor: MODEL_ASSET['assetId'], labels: ['level-3', 'voice'], address: 'anims/walk' };
  const v0 = (MODEL_ASSET['versions'] as Obj[])[0]!;
  const texture = { ...MODEL_ASSET, assetId: 'tex-albedo', kind: 'texture', displayName: 'Albedo', versions: [{ ...v0, importRecipe: { profile: 'image', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } }, metrics: { format: 'png', width: 64, height: 64, decodedBytes: 16384 } }] };
  const mat = { materialId: 'mat-a', name: 'M', shader: 'standard', params: {}, textures: {} };
  probe('assets', contentErrors, contentDoc({ assets: [anims, MODEL_ASSET, texture], materials: [mat] }), '/assets', block('assets'), 'assets:');
  PROPERTY_BASES.forEach((p, i) =>
    probe(`behaviors[${i}]`, contentErrors, contentDoc({ behaviors: [{ behaviorId: 'beh-a', displayName: 'Behavior', declaration: { properties: [p] }, source: null, publishedRevision: 0 }] }), '/behaviors', block('behaviors'), 'behaviors:'),
  );
  probe('behaviorTrust', contentErrors, contentDoc({ behaviorTrust: { entries: [] } }), '/behaviorTrust', block('behaviorTrust'), 'behaviorTrust:');
  probe('lighting', contentErrors, contentDoc({ lighting: {} }), '/lighting', block('lighting'), 'lighting:');
  probe('graphs', contentErrors, contentDoc({ graphs: [{ graphId: 'g-1', kind: 'test', name: 'G', graph: { nodes: [], edges: [] } }] }), '/graphs', block('graphs'), 'graphs:');
  // Shared script libraries (the files are free text, the item is json).
  probe('scriptLibraries', contentErrors, contentDoc({ scriptLibraries: [{ libraryId: 'lib-a', name: 'Lib', files: [{ path: 'src/index.ts', text: 'export const a = 1;\n' }] }] }), '/scriptLibraries', block('scriptLibraries'), 'scriptLibraries:');
  // Block types, cell fields and stamps.
  probe('blockTypes', (v) => errorsOf((e) => validateBlockTypes(v, '', e)), [{ blockId: 'grass', name: 'Grass', variants: [{ color: '#55aa55', weight: 2 }], shape: 'full', solid: true, footprint: [1, 1, 1], rotations: [0, 90], metadata: { walkable: true }, materials: { '*': 'mat-a' }, uv: 'world' }], '', block('blockTypes'), 'blockTypes:');
  probe('blockTypes[1]', (v) => errorsOf((e) => validateBlockTypes(v, '', e)), [{ blockId: 'odd', name: 'Odd', variants: [{ model: { assetId: 'model-a', piece: 'Rock' } }], shape: 'custom', boxes: [[0, 0, 0, 1, 0.5, 1]] }], '', block('blockTypes'), 'blockTypes:');
  probe('blockTypes[2]', (v) => errorsOf((e) => validateBlockTypes(v, '', e)), [{ blockId: 'door', name: 'Door', variants: [{ prefab: 'door' }], shape: 'none', live: true }], '', block('blockTypes'), 'blockTypes:');
  probe('blockTypes[3]', (v) => errorsOf((e) => validateBlockTypes(v, '', e)), [{ blockId: 'fence', name: 'Fence', variants: [{ color: '#886644' }], shape: 'half', placement: 'edge', blocking: false, rotations: [0, 180] }], '', block('blockTypes'), 'blockTypes:');
  probe('blockTypes[4]', (v) => errorsOf((e) => validateBlockTypes(v, '', e)), [{ blockId: 'wall', name: 'Wall', variants: [{ color: '#888888' }, { color: '#999999' }], shape: 'full', connect: { with: ['gate'], pieces: { single: { variant: 0, rot: 90 }, end: { variant: 1, rot: 90 }, straight: { variant: 1, rot: 90 }, corner: { variant: 1, rot: 180 }, t: { variant: 1, rot: 90 }, cross: { variant: 1, rot: 90 }, base: { variant: 0, rot: 180 }, cap: { variant: 1, rot: 270 } } } }], '', block('blockTypes'), 'blockTypes:');
  probe('blockTypes[5]', (v) => errorsOf((e) => validateBlockTypes(v, '', e)), [{ blockId: 'wall', name: 'Wall', variants: [{ color: '#888888' }, { color: '#999999' }], shape: 'full', kits: { burnt: { block: 'wall-burnt', variant: 1, variants: [0, 1] } } }], '', block('blockTypes'), 'blockTypes:');
  probe('cellFields', (v) => errorsOf((e) => validateCellFields(v, '', e)), [{ key: 'terrain', type: 'enum', values: ['grass', 'rock'], color: '#aa5500', label: 'Terrain' }], '', block('cellFields'), 'cellFields:');
  probe('cellFields[1]', (v) => errorsOf((e) => validateCellFields(v, '', e)), [{ key: 'cost', type: 'int', default: 1, min: 0, max: 10 }], '', block('cellFields'), 'cellFields:');
  probe('blockStamps', (v) => errorsOf((e) => validateBlockStamps(v, '', e)), [{ stampId: 'hut', name: 'Hut', size: [2, 1, 2], palette: [{ block: 'grass' }], columns: [[0, 0, 0, 1, 0]] }], '', block('blockStamps'), 'blockStamps:');
  probe('blockStamps[1]', (v) => errorsOf((e) => validateBlockStamps(v, '', e)), [{ stampId: 'room', name: 'Room', size: [2, 1, 2], palette: [{ block: 'grass' }], columns: [[0, 0, 0, 1, 0]], edgePalette: [{ block: 'wall' }], edges: [[2, 0, 0, 0, 0]] }], '', block('blockStamps'), 'blockStamps:');
  // UI documents and themes (json items).
  probe('uiDocuments', contentErrors, contentDoc({ uiDocuments: [{ uiDocumentId: 'hud', name: 'HUD', root: { type: 'panel' } }] }), '/uiDocuments', block('uiDocuments'), 'uiDocuments:');
  probe('uiThemes', contentErrors, contentDoc({ uiThemes: [{ uiThemeId: 'base', name: 'Base', styles: {} }] }), '/uiThemes', block('uiThemes'), 'uiThemes:');
  // Dialogue (json items; the settings a json block).
  probe('dialogues', contentErrors, contentDoc({ dialogues: [{ dialogueId: 'talk', name: 'Talk', graph: { nodes: [{ id: 'start', type: 'start', position: [0, 0] }], edges: [] } }] }), '/dialogues', block('dialogues'), 'dialogues:');
  probe('speakers', contentErrors, contentDoc({ speakers: [{ speakerId: 'guide', name: 'Guide', color: '#80c0ff' }] }), '/speakers', block('speakers'), 'speakers:');
  // Game modes (every field, the references present) and behavior groups.
  // (The shape validator: the references to documents, maps and groups are the project's check, tested in modes.test.ts.)
  probe('modes', (v) => errorsOf((e) => validateModes(v, '', e)), [{ modeId: 'explore', name: 'Explore', inputMaps: ['gameplay', 'tactical'], camera: 'cam-0001', ui: ['hud'], groups: ['field'], ungrouped: 'pause', pause: false, pauseScreen: 'hud', timeScale: 0.5, physics: 'hold', enter: { blend: 'eased', blendTime: 0.5, fade: 'fade', fadeTime: 0.25 } }], '', block('modes'), 'modes:');
  // The event → cue table (the shape validator; the sounds' kinds are the project's check).
  probe('eventCues', (v) => errorsOf((e) => validateEventCues(v, '', e)), [{ on: 'event', name: 'collected', entity: 'spawn-0001', assetId: 'cue-a', volume: 0.5, bus: 'ui', maxLateMs: 250 }, { on: 'signal', name: 'door', assetId: 'cue-a' }], '', block('eventCues'), 'eventCues:');
  // The game shell (the shape validator; its documents, scenes and spawns are the project's check).
  probe('shell', (v) => errorsOf((e) => validateShell(v, '', e)), { screens: { title: 'title', pause: 'pause', settings: 'settings', controls: 'controls', save: 'saves', load: 'saves' }, simulate: { title: 'scripts', pause: 'pause', settings: 'scripts', controls: 'pause', save: 'pause', load: 'scripts' }, hud: ['hud'], scenes: [{ scene: 'main', spawn: 'spawn-0001', fade: 1, fadeColor: '#000000' }], pause: false, status: true }, '', block('shell'), 'shell:');
  probe('behaviorGroups', contentErrors, contentDoc({ behaviorGroups: ['field', 'board'] }), '/behaviorGroups', block('behaviorGroups'), 'behaviorGroups:');
  // Timelines (json items).
  probe('timelines', contentErrors, contentDoc({ timelines: [{ timelineId: 'intro', name: 'Intro', duration: 2, tracks: [{ trackId: 's', type: 'signal', keys: [{ time: 1, name: 'go' }] }] }] }), '/timelines', block('timelines'), 'timelines:');
  // The UI editor's descriptors (a document's own fields, each widget type, styles, tweens).
  runUiProbes();
  // The named collision layers.
  probe('lightLayers', contentErrors, contentDoc({ lightLayers: ['world', '', 'characters'] }), '/lightLayers', block('lightLayers'), 'lightLayers:');
  probe('collisionLayers', contentErrors, contentDoc({ collisionLayers: ['props', 'units'] }), '/collisionLayers', block('collisionLayers'), 'collisionLayers:');
  // The project save schema.
  probe('saveSchema', contentErrors, contentDoc({ saveSchema: { version: 3, slots: 5, migrations: [{ from: 1, name: 'v1to2' }], sections: ['grid', 'storage'], legacyWorld: false, thumbnail: { width: 160, height: 90, format: 'webp', quality: 0.8 }, settings: [{ key: 'hints', type: 'bool', default: true }] } }), '/saveSchema', block('saveSchema'), 'saveSchema:');
  const prefabDef = { prefabId: 'pre-a', displayName: 'Crate', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', name: 'Root', parentLocalId: null, components: { transform: T } }] };
  probe('prefabs', (v) => errorsOf((e) => validatePrefabDefinitions(v, '', e, 4)), [prefabDef], '', block('prefabs'), 'prefabs:');
  // The resources' addresses and labels.
  probe('loadable', contentErrors, contentDoc({ prefabs: [prefabDef], loadable: [{ kind: 'prefab', id: 'pre-a', address: 'props/crate', labels: ['props'] }] }), '/loadable', block('loadable'), 'loadable:');
  // the content block's own keys (each block's inside is probed above)
  const contentRoot: ObjectFieldDescriptor = { type: 'object', key: 'content', label: 'Content', tooltip: '', fields: DESCRIPTORS.content.map((b) => ({ ...b.value, key: b.key, required: b.required })) };
  const ctx: Ctx = { label: 'content', validate: contentErrors };
  const root = contentDoc();
  const probeErrs = contentErrors({ ...root, zz_probe: 1 }).filter((e) => e.path === '/zz_probe');
  if (!probeErrs.some(isUnknownKey)) fail('content: an unknown block is not refused');
  const tokens = new Set(probeErrs.flatMap((e) => `${e.expected ?? ''} ${e.message}`.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []));
  for (const t of tokens) {
    if (allKeys(contentRoot).has(t) || t === 'zz_probe') continue;
    // `game` stays a stored key that is always null (a block is refused), so it has nothing to describe.
    if (t === 'game') continue;
    if (!contentErrors({ ...root, [t]: { zz: 1 } }).some((e) => e.path === `/${t}` && isUnknownKey(e))) fail(`content: the validator knows block "${t}" but it has no descriptor`);
  }
  for (const b of DESCRIPTORS.content) if (b.required) expectErr(ctx, setAt(root, `/${b.key}`, undefined), `/${b.key}`, 'removing a required block');
}

function walk(d: FieldDescriptor, out: FieldDescriptor[], skipUnder: boolean): void {
  if (skipUnder) return;
  out.push(d);
  if (d.type === 'object') for (const f of d.fields) walk(f, out, false);
  if (d.type === 'list') walk(d.item, out, false);
  if (d.type === 'map') walk(d.value, out, false);
}

/** A value fits its own descriptor (defaults, presets). */
function fits(d: FieldDescriptor, v: unknown): string | null {
  if (v === null) return d.nullable ? null : 'null';
  switch (d.type) {
    case 'number':
    case 'int': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'not a number';
      if (d.type === 'int' && !Number.isInteger(v)) return 'not an integer';
      const n = d as { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean; nonZero?: boolean };
      if (n.min !== undefined && (n.minExclusive ? v <= n.min : v < n.min)) return `below ${n.min}`;
      if (n.max !== undefined && (n.maxExclusive ? v >= n.max : v > n.max)) return `above ${n.max}`;
      if (n.nonZero && v === 0) return 'zero';
      if (d.type === 'int' && d.values !== undefined && !d.values.includes(v)) return `not one of ${d.values.join(', ')}`;
      return null;
    }
    case 'bool':
      return typeof v === 'boolean' ? null : 'not a boolean';
    case 'enum':
      return d.options.some((o) => o.value === v) ? null : `not an option (${String(v)})`;
    case 'color':
      return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v) ? null : 'not a lowercase #rrggbb';
    case 'vec2':
    case 'vec3': {
      const n = d.type === 'vec2' ? 2 : 3;
      if (!Array.isArray(v) || !(v.length === n || (d.optionalLast === true && v.length === n - 1))) return 'wrong length';
      for (const x of v) if (typeof x !== 'number' || (d.min !== undefined && (d.minExclusive ? x <= d.min : x < d.min)) || (d.max !== undefined && x > d.max)) return 'component out of range';
      if (d.ascending && !((v[0] as number) < (v[1] as number))) return 'not ascending';
      if (d.same !== undefined && d.same.some((j) => v[j] !== v[d.same![0]!])) return 'tied components differ';
      return null;
    }
    case 'string':
      return typeof v === 'string' && (d.maxLength === undefined || v.length <= d.maxLength) && (d.minLength === undefined || v.length >= d.minLength) ? null : 'bad string';
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) return 'not an object';
      for (const [k, x] of Object.entries(v as Obj)) {
        const fs = d.fields.filter((f) => f.key === k && holds(f.when, v as Obj, d.fields));
        if (fs.length === 0) return `unknown key ${k}`;
        const bad = fits(fs[0]!, x);
        if (bad !== null) return `${k}: ${bad}`;
      }
      for (const f of d.fields) if (f.required && holds(f.when, v as Obj, d.fields) && (v as Obj)[f.key] === undefined) return `missing ${f.key}`;
      return null;
    }
    case 'list':
      if (!Array.isArray(v)) return 'not a list';
      for (const x of v) {
        const bad = fits(d.item, x);
        if (bad !== null) return bad;
      }
      return null;
    default:
      return null;
  }
}

describe('descriptor registry', () => {
  it('describes exactly the v4 components, in one registry that survives JSON', () => {
    expect(DESCRIPTORS.components.map((c) => c.name).sort()).toEqual([...V4_REGISTRY].sort());
    expect(new Set(DESCRIPTORS.components.map((c) => c.name)).size).toBe(DESCRIPTORS.components.length);
    expect(JSON.parse(JSON.stringify(DESCRIPTORS))).toEqual(DESCRIPTORS);
    // it travels in every queryGameConfig: keep it small
    // (the UI document vocabulary is about 20 KB; environment presets, which repeat
    // the sky/fog/post descriptors, about 9 KB; a compound repeats the collider shapes, about 6 KB;
    // a quality level repeats the bloom/AO/depth-of-field descriptors, about 3 KB; a block type's connection pieces
    // repeat their look and turn, about 3 KB; a block layer's cut-away, about 1.6 KB; kits on block types and layers,
    // about 2 KB; a block layer's walk and corner shading, about 1.7 KB)
    expect(JSON.stringify(DESCRIPTORS).length).toBeLessThan(282_000);
    for (const c of DESCRIPTORS.components) expect(c.value.key).toBe(c.name);
  });

  it('every validator matches its descriptor (fields, required/optional, ranges, options, lengths, counts) and every descriptor is reached', () => {
    failures.length = 0;
    visited.clear();
    runAllProbes();
    const all: FieldDescriptor[] = [];
    for (const c of DESCRIPTORS.components) walk(c.value, all, false);
    for (const b of DESCRIPTORS.content) walk(b.value, all, false);
    for (const d of Object.values(DESCRIPTORS.ui ?? {})) walk(d, all, false);
    walk(DESCRIPTORS.entity, all, false);
    // A runtime-only field is never stored: the validator refuses it (probed below), no base reaches it.
    const unreached = all.filter((d) => !visited.has(d) && d.type !== 'json' && d.type !== 'components' && d.runtimeOnly !== true);
    for (const d of DESCRIPTORS.entity.fields.filter((f) => f.runtimeOnly === true)) {
      const stored = sceneErrors({ schemaVersion: 4, sceneId: 'main', revision: 1, entities: [{ id: 'subject-0001', [d.key]: d.default as J, components: { transform: T } }] });
      if (!stored.some((e) => e.path === `/entities/0/${d.key}`)) failures.push(`runtime-only field "${d.key}" is accepted as stored data`);
    }
    for (const d of unreached) failures.push(`descriptor "${d.key}" (${d.label}) is never reached by a test base`);
    expect(failures).toEqual([]);
  });

  it('the gameplay blocks list the same fields as their descriptors', () => {
    for (const [name, b] of Object.entries(BLOCK_COMPONENTS)) {
      const d = comp(name).value as ObjectFieldDescriptor;
      expect([...new Set(d.fields.map((f) => f.key))].sort(), name).toEqual([...b.fields].sort());
    }
  });

  it('the prefab vocabulary is the components marked prefab', () => {
    const allowed = ['transform', 'model', 'box', 'behavior', ...PREFAB_V4_COMPONENTS].sort();
    expect(DESCRIPTORS.components.filter((c) => c.prefab).map((c) => c.name).sort()).toEqual(allowed);
    const prefabs = block('prefabs') as ListFieldDescriptor;
    const entities = (prefabs.item as ObjectFieldDescriptor).fields.find((f) => f.key === 'entities') as ListFieldDescriptor;
    const components = (entities.item as ObjectFieldDescriptor).fields.find((f) => f.key === 'components') as { allowed: readonly string[] };
    expect([...components.allowed].sort()).toEqual(allowed);
    // and the prefab validator agrees, component by component
    for (const c of DESCRIPTORS.components) {
      if (c.name === 'folder') continue;
      const value = (COMPONENT_BASES[c.name] ?? [])[0];
      const comps: Obj = { transform: T, ...(c.name === 'animator' || c.name === 'modelAnimation' ? { model: { asset: { assetId: 'model-a' } } } : {}), ...(c.name === 'surface' || c.name === 'materials' || c.name === 'materialParams' ? { box: { size: [1, 1, 1] } } : {}), [c.name]: value };
      const def = { prefabId: 'pre-a', displayName: 'P', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', components: comps }] };
      const errs = errorsOf((e) => validatePrefabDefinitions([def], '', e, 4)).filter((e) => e.path.startsWith(`/0/entities/0/components/${c.name}`) && /forbidden|unknown/.test(e.code));
      expect(errs.length === 0, `${c.name} on a prefab entity`).toBe(c.prefab);
    }
  });

  it('defaults, add values and presets fit their descriptors and validate', () => {
    const all: FieldDescriptor[] = [];
    for (const c of DESCRIPTORS.components) walk(c.value, all, false);
    for (const b of DESCRIPTORS.content) walk(b.value, all, false);
    walk(DESCRIPTORS.entity, all, false);
    for (const d of all) if (d.default !== undefined && d.type !== 'json') expect(fits(d, d.default), `default of ${d.key} (${d.label})`).toBeNull();
    for (const c of DESCRIPTORS.components) {
      const values = [...(c.add.kind === 'menu' ? [c.add.value] : []), ...(c.presets ?? []).map((p) => p.value)];
      for (const v of values) {
        expect(fits(c.value, v), `${c.name} add/preset fits`).toBeNull();
        expect(sceneErrors(entityScene(c.name, v)), `${c.name} add/preset validates`).toEqual([]);
      }
    }
    // the input block's default is the engine's default actions, and it validates
    expect(errorsOf((e) => validateInput(block('input').default, '', e))).toEqual([]);
  });

  it('create menu entries fit their descriptors, validate and name known icons', () => {
    let entries = 0;
    for (const c of DESCRIPTORS.components) {
      if (c.icon !== undefined) expect(COMPONENT_ICONS, `${c.name} icon`).toContain(c.icon);
      for (const e of c.create ?? []) {
        entries += 1;
        expect(c.add.kind === 'menu' || e.value !== undefined, `${c.name} ${e.label}: a value`).toBe(true);
        const v = JSON.parse(JSON.stringify(e.value ?? (c.add.kind === 'menu' ? c.add.value : {}))) as Obj;
        // The scene pointers the editor fills with another scene of the project.
        for (const p of e.otherScene ?? []) {
          const keys = p.split('/');
          let at = v as Obj;
          for (const k of keys.slice(0, -1)) at = at[k] as Obj;
          expect(at[keys[keys.length - 1]!], `${c.name} ${e.label} ${p}`).toBe('');
          at[keys[keys.length - 1]!] = 'scene-other';
        }
        expect(fits(c.value, v), `${c.name} ${e.label} fits`).toBeNull();
        const extra: Obj = { ...((e.with ?? {}) as Obj), ...(e.box !== undefined ? { box: { size: [...e.box.size], material: { color: e.box.color } } } : {}) };
        for (const [name, value] of Object.entries(e.with ?? {})) expect(fits(DESCRIPTORS.components.find((x) => x.name === name)!.value, value as J), `${c.name} ${e.label} with ${name}`).toBeNull();
        if (e.dimension !== 3) expect(sceneErrors(entityScene(c.name, v, extra)), `${c.name} ${e.label} validates`).toEqual([]);
      }
    }
    expect(entries).toBeGreaterThanOrEqual(12);
    // The removed game components and blocks are not described at all.
    for (const n of Object.keys(REMOVED_COMPONENTS)) expect(DESCRIPTORS.components.find((c) => c.name === n), n).toBeUndefined();
    for (const n of ['game', 'flow']) expect(DESCRIPTORS.content.find((b) => b.key === n), n).toBeUndefined();
  });

  it('exclusions and requirements match the scene validator', () => {
    const names = DESCRIPTORS.components.map((c) => c.name).filter((n) => n !== 'folder' && n !== 'transform');
    const excluded = (a: string, b: string): boolean => comp(a).excludes.some((x) => x.component === b) || comp(b).excludes.some((x) => x.component === a);
    // symmetric
    for (const c of DESCRIPTORS.components) for (const x of c.excludes) expect(comp(x.component).excludes.some((y) => y.component === c.name), `${x.component} excludes ${c.name}`).toBe(true);
    // partners the two components need, chosen so the partners exclude nothing on the entity
    const options = (a: string): (string | null)[] => {
      const req = comp(a).requiresAnyOf;
      return req === undefined ? [null] : [...req.components];
    };
    const partners = (a: string, b: string): string[] | null => {
      for (const pa of options(a)) {
        for (const pb of options(b)) {
          const set = [pa, pb].filter((x): x is string => x !== null && x !== a && x !== b);
          const all = [a, b, ...set];
          const bad = all.some((x, i) => all.some((y, k) => k > i && x !== y && !(x === a && y === b) && excluded(x, y)));
          if (!bad) return [...new Set(set)];
        }
      }
      return null;
    };
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i]!;
        const b = names[j]!;
        const ps = partners(a, b);
        if (ps === null) continue; // every partner either needs is excluded by the other
        const comps: Obj = { transform: T, ...Object.fromEntries(ps.map((p) => [p, COMPONENT_BASES[p]![0]])), [a]: COMPONENT_BASES[a]![0], [b]: COMPONENT_BASES[b]![0] };
        if ((a === 'modelAnimation' || b === 'modelAnimation') && comps['model'] === undefined) continue;
        const errs = sceneErrors({ schemaVersion: 4, sceneId: 'main', revision: 1, entities: [SPAWN, { id: 'subject-0001', components: comps }] });
        const conflict = errs.filter((e) => /conflict/.test(e.code));
        expect(conflict.length > 0, `${a} + ${b} (+ ${ps.join(', ') || 'nothing'}): ${conflict.map((e) => e.message).join('; ') || 'accepted'}`).toBe(excluded(a, b));
      }
    }
    for (const c of DESCRIPTORS.components) {
      if (c.requiresAnyOf === undefined) continue;
      const bare = { schemaVersion: 4, sceneId: 'main', revision: 1, entities: [SPAWN, { id: 'subject-0001', components: { transform: T, [c.name]: COMPONENT_BASES[c.name]![0] } }] };
      expect(sceneErrors(bare).some((e) => /missing|conflict/.test(e.code)), `${c.name} without ${c.requiresAnyOf.components.join('/')}`).toBe(true);
      for (const p of c.requiresAnyOf.components) {
        const comps: Obj = { transform: T, [p]: COMPONENT_BASES[p]![0], [c.name]: COMPONENT_BASES[c.name]![0] };
        if (c.name === 'modelAnimation') comps['model'] = { asset: { assetId: 'model-a' } };
        expect(sceneErrors({ ...bare, entities: [SPAWN, { id: 'subject-0001', components: comps }] }), `${c.name} with ${p}`).toEqual([]);
      }
    }
  });

  it('handles bind real fields with the right roles, and handle fields name their handle', () => {
    for (const c of DESCRIPTORS.components) {
      const fieldsAt = (ptr: string): FieldDescriptor[] => {
        let level: FieldDescriptor[] = [c.value];
        for (const s of ptr.split('/')) {
          level = level.flatMap((d) => (d.type === 'object' ? d.fields.filter((f) => f.key === s) : []));
        }
        return level;
      };
      for (const h of c.handles) {
        expect(HANDLE_KINDS).toContain(h.kind);
        expect(HANDLE_ROLES[h.kind].some((roles) => roles.length === Object.keys(h.bind).length && roles.every((r) => h.bind[r] !== undefined)), `${c.name} ${h.kind} roles`).toBe(true);
        for (const ptr of Object.values(h.bind)) expect(fieldsAt(ptr).some((f) => f.handle === h.kind), `${c.name} ${h.kind} → ${ptr}`).toBe(true);
      }
      const walkHandles = (d: FieldDescriptor, ptr: string): void => {
        if (d.handle !== undefined) expect(c.handles.some((h) => h.kind === d.handle && Object.values(h.bind).includes(ptr)), `${c.name} ${ptr} names ${d.handle}`).toBe(true);
        if (d.type === 'object') for (const f of d.fields) walkHandles(f, ptr === '' ? f.key : `${ptr}/${f.key}`);
      };
      walkHandles(c.value, '');
    }
  });
});
