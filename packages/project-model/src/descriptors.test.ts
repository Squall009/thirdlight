/**
 * Phase 15.0: the descriptor registry matches the validators.
 *
 * Every component and content block is probed through its real validator
 * from valid base documents (one per variant: each light type, zone role,
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
import { PREFAB_V4_COMPONENTS, validateContentV4, validateGameConfig, validatePrefabDefinitions, validateTagRegistry } from './content';
import {
  DESCRIPTORS,
  HANDLE_KINDS,
  HANDLE_ROLES,
  type ComponentDescriptor,
  type FieldCondition,
  type FieldDescriptor,
  type ListFieldDescriptor,
  type ObjectFieldDescriptor,
} from './descriptors';
import type { ModelErrorV2 } from './errors';
import { validateFlow } from './flow';
import { validateInput } from './input';
import { MATERIAL_PARAMS, MATERIAL_SHADERS, MATERIAL_TEXTURE_SLOTS, validateEnvironment, validateMaterials } from './materials';
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
  'flow:lives.max': (o, v) => {
    o['start'] = Math.max(1, Math.min(o['start'] as number, Math.floor(v)));
  },
  'camera:far': (o, v) => {
    o['near'] = Math.min(o['near'] as number, v / 2);
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
  if (adj !== undefined && typeof value === 'number') adj(o, value);
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
  // Phase 15.3: a choice of numbers — each accepted, a whole number between two refused.
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
      const v = value as number[];
      expectErr(ctx, set([...v, 0]), errAt, 'too many components');
      expectErr(ctx, set('x'), errAt, 'a string');
      for (let i = 0; i < n; i++) {
        const comp = (x: number): J => {
          const copy = [...v];
          copy[i] = x;
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
    else if (!(disc.has(f.key) && obj[f.key] !== f.default)) {
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
  cameraFollow: { camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } },
  surface: { box: { size: [1, 1, 1] } },
  materials: { box: { size: [1, 1, 1] } },
  animator: { model: { asset: { assetId: 'model-a' } } },
  modelAnimation: { model: { asset: { assetId: 'model-a' } } },
};
function entityScene(name: string, value: J, extra: Obj = {}): J {
  const comps: Obj = name === 'folder' ? { folder: value } : { transform: T, ...(PARTNERS[name] ?? {}), ...extra, [name]: value };
  if (name === 'transform') comps['transform'] = value;
  return { schemaVersion: 4, sceneId: 'main', revision: 1, entities: [SPAWN, { id: 'subject-0001', components: comps }] };
}

const LIGHTS = [
  { type: 'directional', color: '#fff4e0', intensity: 1.6, direction: [0.4, -1, -0.6], castShadow: true, mode: 'mixed' },
  { type: 'ambient', color: '#8a94b0', intensity: 0.9, mode: 'baked' },
  { type: 'point', color: '#ffd9a0', intensity: 30, range: 8, decay: 2, castShadow: true, mode: 'realtime' },
  { type: 'spot', color: '#ffffff', intensity: 80, range: 12, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -1, 0], castShadow: false },
  { type: 'hemisphere', color: '#bcd7ff', groundColor: '#5a4a38', intensity: 0.8, mode: 'baked' },
];

/** Every component's variant bases (each fills every field that applies). */
const COMPONENT_BASES: Record<string, J[]> = {
  transform: [{ position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 2, 1] }],
  model: [{ asset: { assetId: 'model-a' }, piece: 'Tree' }],
  box: [{ size: [1, 2, 3], material: { color: '#aabbcc' } }],
  materials: [{ '*': 'mat-a', Bark: 'mat-b' }],
  surface: [{ color: '#aabbcc', roughness: 0.5, metalness: 0.2, emissive: '#112233', emissiveIntensity: 1 }],
  instances: [{ asset: { assetId: 'model-a', piece: 'Rock' }, buffer: 'a'.repeat(64), count: 10 }],
  fogVolume: [{ size: [6, 3, 4], density: 0.25, color: '#dfe7ef', falloff: 0.5, heightFalloff: 0.3 }],
  collider: [{ shape: { type: 'box', hx: 0.5, hy: 0.25 }, oneWay: true }, { shape: { type: 'polygon', vertices: [[-1, -1], [1, -1], [1, 1], [-1, 1]] } }],
  controller: [{ capsule: { radius: 0.3, height: 1.8, offset: [0, 0.1] }, acceleration: 30, deceleration: 50, coyoteTime: 0.1, jumpBuffer: 0.1, jumpRelease: 0.4, groundSnap: 0.2, skin: 0.02, autostep: true, autostepHeight: 0.3 }],
  camera: [{ type: 'perspective', fovY: 60, near: 0.1, far: 100 }],
  cameraFollow: [{ deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, bounds: { minX: -50, maxX: 50, minY: -10, maxY: 20 }, distance: 10, maxSpeed: 100 }],
  light: LIGHTS,
  gameZone: [
    { role: 'hazard', size: [2, 1], damage: 1 },
    { role: 'checkpoint', size: [1.5, 1.5], safeSpawnId: 'spawn-0001', activation: { emissive: '#1bc8ff', emissiveIntensity: 1.2, cueAssetId: 'cue-a' } },
    { role: 'goal', size: [2, 2] },
    { role: 'exit', size: [1.5, 2.5], load: ['scene-b'], unload: ['scene-c'], spawnId: 'spawn-0001' },
  ],
  playerSpawn: [{ facing: 'left' }],
  mover: [{ waypoints: [[1, 0, 0], [2, 1, 0]], speed: 2, mode: 'loop', wait: 0.5, easing: 'smooth', startOn: 'go', maxPush: 30 }],
  trigger: [
    { shape: 'box', size: [2, 2], signal: 'enter', exitSignal: 'leave', mode: 'stay', once: true },
    { shape: 'circle', radius: 1.5, signal: 'enter' },
  ],
  switch: [{ mode: 'stand', signal: 'open', size: [1, 1], once: true }],
  health: [{ max: 5, start: 3, invulnerableSeconds: 1, knockback: 2, knockbackTime: 0.4, hitBounce: 3 }],
  pickup: [
    { kind: 'coin', value: 1, size: [1, 1], respawn: 'death', cue: 'cue-a' },
    { kind: 'custom', value: 2, counter: 'stars' },
  ],
  enemy: [
    { patrol: 'edges', speed: 1.5, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 2, chase: 3, chaseHeight: 3, stompBounce: 7, stompTolerance: 0.3, defeat: 'fade', defeatTime: 0.5, wallProbe: 0.1, ledgeProbe: 0.6 },
    { patrol: 'points', range: [-2, 2], speed: 1.5, size: [0.8, 0.8], contactDamage: 0, stompable: false, health: 1 },
  ],
  audioSource: [{ assetId: 'cue-a', volume: 0.8, range: 12 }],
  animator: [{ controller: 'ctl-a', parameters: { speed: 1, grounded: true } }],
  faceMovement: [{ yawRight: 90, yawLeft: -90, turnSeconds: 0.12 }],
  modelAnimation: [{ assetId: 'model-a', version: 1, roles: { idle: { clipIndex: 0 }, run: { clipIndex: 1 }, airborne: { clipIndex: 2 } } }],
  behavior: [{ behaviorId: 'beh-a', values: { speed: 3 } }],
  prefab: [{ prefabId: 'pre-a', localId: 'root' }],
  folder: [{}],
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
const ENV_BASES: J[] = [
  { sky: SKY_PROCEDURAL, fog: { mode: 'linear', color: '#c8d2dc', near: 10, far: 120 }, post: POST_FULL, wind: WIND_FULL, quality: 'medium' },
  { sky: { mode: 'gradient', topColor: '#3d7cd6', horizonColor: '#bfe3ff', bottomColor: '#6b7b5a', intensity: 1 }, fog: { mode: 'exp2', color: '#c8d2dc', density: 0.01 } },
  { sky: { mode: 'texture', texture: 'tex-a', cube: ['px', 'nx', 'py', 'ny', 'pz', 'nz'] }, fog: { mode: 'none', color: '#c8d2dc' } },
  { sky: { mode: 'color', color: '#7ec8ff' } },
];

const FLOW_BASE = {
  levels: [{ id: 'level-1', name: 'One', scenes: ['main', 'extra'], spawnId: 'spawn-0001', music: 'mus-a', environment: { sky: SKY_PROCEDURAL, fog: { mode: 'linear', color: '#c8d2dc', near: 10, far: 120 }, post: POST_FULL, wind: WIND_FULL }, ambience: ['amb-a', 'amb-b'] }],
  lives: { start: 3, max: 5 },
  title: { subtitle: 'A game', music: 'mus-a', scene: 'main', pan: { distance: 6, seconds: 20 } },
  hud: { preset: 'minimal', timer: true },
  ui: { font: 'serif', accent: '#ffc857', panel: '#1b2330', text: '#f4f1e8', logo: 'tex-a' },
  texts: { levelComplete: 'Done', gameOver: 'Over', credits: 'Made by someone' },
  volumes: { music: 0.5, sfx: 0.5, ui: 0.5 },
  sounds: { move: 'snd-a', confirm: 'snd-b', back: 'snd-c' },
  score: { points: { coins: 10 }, timeBonus: { targetSeconds: 60, perSecond: 5 } },
};

const BINDINGS: { type: string; binding: Obj }[] = [
  { type: 'button', binding: { kind: 'key', code: 'Space' } },
  { type: 'button', binding: { kind: 'gamepadButton', button: 0 } },
  { type: 'axis1d', binding: { kind: 'gamepadAxis', axis: 0 } },
  { type: 'axis1d', binding: { kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' } },
  { type: 'axis1d', binding: { kind: 'gamepadButtons1d', negative: 14, positive: 15 } },
  { type: 'axis2d', binding: { kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' } },
  { type: 'axis2d', binding: { kind: 'gamepadStick', x: 0, y: 1 } },
];
const INPUT_BASES: J[] = BINDINGS.map((b) => ({ actions: [{ name: 'act', type: b.type, map: 'ui', bindings: [b.binding], deadZone: 0.2, invert: true, scale: 2 }] }));

const MATERIAL_BASES: J[] = MATERIAL_SHADERS.map((s) => [
  { materialId: 'mat-a', name: 'Material', shader: s, params: Object.fromEntries(Object.entries(MATERIAL_PARAMS[s]).map(([k, t]) => [k, clone(t.default)])), textures: Object.fromEntries(MATERIAL_TEXTURE_SLOTS[s].map((slot) => [slot, 'tex-a'])) },
]);

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
  const motion = (kind: string, n: string) => (kind === 'clip' ? { kind: 'clip', clip: CLIP(n) } : kind === 'blend1d' ? { kind: 'blend1d', parameter: 'speed', children: [{ threshold: 0, clip: CLIP(`${n}-a`) }, { threshold: 1, clip: CLIP(`${n}-b`) }] } : { kind: 'empty' });
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
  Object.values(import.meta.glob('../../../samples/beacon-reach/captured/project.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>)[0] as string,
) as { content: { assets: Obj[] } };
const MODEL_ASSET = SAMPLE.content.assets.find((a) => a['kind'] === 'model')!;

function contentDoc(extra: Obj = {}): Obj {
  return {
    assets: [],
    prefabs: [],
    behaviors: [],
    settings: {},
    behaviorTrust: { entries: [] },
    game: null,
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
  probe('entity', sceneErrors, { schemaVersion: 4, sceneId: 'main', revision: 1, entities: [{ id: 'parent-0001', components: { transform: T } }, { id: 'subject-0001', name: 'Thing', parentId: 'parent-0001', active: false, locked: true, static: true, tags: 5, components: { transform: T } }] }, '/entities/1', DESCRIPTORS.entity, 'entity:');
  // content blocks
  const game = { configVersion: 2, title: 'Title', objective: 'Objective', instructions: 'Instructions', playerId: 'player-1', cameraId: 'camera-1', spawnId: 'spawn-1', cues: { start: 'cue-a', jump: null, checkpoint: null, death: null, goal: null }, respawnDelay: 0.5, dropThroughTime: 0.2, settleTime: 0.05 };
  probe('game', (g) => errorsOf((e) => validateGameConfig(g, '', e, 2)), game, '', block('game'), 'game:');
  probe('flow', (f) => errorsOf((e) => validateFlow(f, '', e)), FLOW_BASE, '', block('flow'), 'flow:');
  ENV_BASES.forEach((b, i) => probe(`environment[${i}]`, (v) => errorsOf((e) => validateEnvironment(v, '', e)), b, '', block('environment'), 'environment:'));
  INPUT_BASES.forEach((b, i) => probe(`input[${i}]`, (v) => errorsOf((e) => validateInput(v, '', e)), b, '', block('input'), 'input:'));
  MATERIAL_BASES.forEach((b, i) => probe(`materials[${i}]`, (v) => errorsOf((e) => validateMaterials(v, '', e)), b, '', block('materials'), 'materials:'));
  ANIMATOR_BASES.forEach((b, i) => probe(`animators[${i}]`, (v) => errorsOf((e) => validateAnimators(v, '', e)), b, '', block('animators'), 'animators:'));
  probe('tags', (v) => errorsOf((e) => validateTagRegistry(v, '', e)), [{ bit: 3, name: 'enemy' }], '', block('tags'), 'tags:');
  probe('settings', contentErrors, contentDoc({ settings: { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, fixed_step_hz: 240, audio_voices: 12, music_fade_s: 2, animation_crossfade_s: 0.3 } }), '/settings', block('settings'), 'settings:');
  probe('scenes', contentErrors, contentDoc(), '/scenes', block('scenes'), 'scenes:');
  probe('startScenes', contentErrors, contentDoc(), '/startScenes', block('startScenes'), 'startScenes:');
  const anims = { ...MODEL_ASSET, assetId: 'anims-0001', displayName: 'Anims', vertexColors: 'tint', materials: { '*': 'mat-a' }, clipsFor: MODEL_ASSET['assetId'] };
  const mat = { materialId: 'mat-a', name: 'M', shader: 'standard', params: {}, textures: {} };
  probe('assets', contentErrors, contentDoc({ assets: [anims, MODEL_ASSET], materials: [mat] }), '/assets', block('assets'), 'assets:');
  PROPERTY_BASES.forEach((p, i) =>
    probe(`behaviors[${i}]`, contentErrors, contentDoc({ behaviors: [{ behaviorId: 'beh-a', displayName: 'Behavior', declaration: { properties: [p] }, source: null, publishedRevision: 0 }] }), '/behaviors', block('behaviors'), 'behaviors:'),
  );
  probe('behaviorTrust', contentErrors, contentDoc({ behaviorTrust: { entries: [] } }), '/behaviorTrust', block('behaviorTrust'), 'behaviorTrust:');
  probe('lighting', contentErrors, contentDoc({ lighting: {} }), '/lighting', block('lighting'), 'lighting:');
  const prefabDef = { prefabId: 'pre-a', displayName: 'Crate', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', name: 'Root', parentLocalId: null, components: { transform: T } }] };
  probe('prefabs', (v) => errorsOf((e) => validatePrefabDefinitions(v, '', e, 4)), [prefabDef], '', block('prefabs'), 'prefabs:');
  // the content block's own keys (each block's inside is probed above)
  const contentRoot: ObjectFieldDescriptor = { type: 'object', key: 'content', label: 'Content', tooltip: '', fields: DESCRIPTORS.content.map((b) => ({ ...b.value, key: b.key, required: b.required })) };
  const ctx: Ctx = { label: 'content', validate: contentErrors };
  const root = contentDoc();
  const probeErrs = contentErrors({ ...root, zz_probe: 1 }).filter((e) => e.path === '/zz_probe');
  if (!probeErrs.some(isUnknownKey)) fail('content: an unknown block is not refused');
  const tokens = new Set(probeErrs.flatMap((e) => `${e.expected ?? ''} ${e.message}`.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []));
  for (const t of tokens) {
    if (allKeys(contentRoot).has(t) || t === 'zz_probe') continue;
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
      if (!Array.isArray(v) || v.length !== n) return 'wrong length';
      for (const x of v) if (typeof x !== 'number' || (d.min !== undefined && (d.minExclusive ? x <= d.min : x < d.min)) || (d.max !== undefined && x > d.max)) return 'component out of range';
      if (d.ascending && !((v[0] as number) < (v[1] as number))) return 'not ascending';
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

describe('descriptor registry (phase 15.0)', () => {
  it('describes exactly the v4 components, in one registry that survives JSON', () => {
    expect(DESCRIPTORS.components.map((c) => c.name).sort()).toEqual([...V4_REGISTRY].sort());
    expect(new Set(DESCRIPTORS.components.map((c) => c.name)).size).toBe(DESCRIPTORS.components.length);
    expect(JSON.parse(JSON.stringify(DESCRIPTORS))).toEqual(DESCRIPTORS);
    // it travels in every queryGameConfig: keep it small
    expect(JSON.stringify(DESCRIPTORS).length).toBeLessThan(200_000);
    for (const c of DESCRIPTORS.components) expect(c.value.key).toBe(c.name);
  });

  it('every validator matches its descriptor (fields, required/optional, ranges, options, lengths, counts) and every descriptor is reached', () => {
    failures.length = 0;
    visited.clear();
    runAllProbes();
    const all: FieldDescriptor[] = [];
    for (const c of DESCRIPTORS.components) walk(c.value, all, false);
    for (const b of DESCRIPTORS.content) walk(b.value, all, false);
    walk(DESCRIPTORS.entity, all, false);
    const unreached = all.filter((d) => !visited.has(d) && d.type !== 'json' && d.type !== 'components');
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
      const comps: Obj = { transform: T, ...(c.name === 'animator' || c.name === 'modelAnimation' ? { model: { asset: { assetId: 'model-a' } } } : {}), ...(c.name === 'surface' || c.name === 'materials' ? { box: { size: [1, 1, 1] } } : {}), [c.name]: value };
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
