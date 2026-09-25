/**
 * Phase 20.0: visual effects (`content.effects[]`) and the `effect` component.
 *
 * An effect is a set of particle systems simulated together from one origin
 * (the entity carrying the `effect` component, or a script/gameplay trigger
 * in phase 20.2). Each system is a node graph of kind `effect`
 * (effect-graph-kinds.ts) with the four contexts Spawn, Initialize, Update
 * and Output, plus its capacity (max particles) and its simulation space
 * (local: particles move with the origin; world: they stay where they were
 * born). The effect carries what all its systems share: the cycle duration
 * and whether it loops, the random seed (same seed, same particles on the
 * CPU reference evaluator), the culling bounds (a box around the origin)
 * and the exposed parameters (like material parameters, 15.4 visibility:
 * public ones may be overridden per object by the component, private ones
 * are the effect's own values).
 *
 * Effects are visual only: they never feed back into the deterministic game
 * simulation, so replays do not depend on them. Pure data rules here; the
 * evaluator is `@thirdlight/effects`.
 */
import type { ModelErrorV2 } from './errors';
import { canonicalGraphData, validateGraphData, type GraphContext, type GraphData } from './graph';
import { EFFECT_GRAPH_KIND } from './effect-graph-kinds';
import { graphForRuntime, MATERIAL_PARAMETER_KEY_RE, materialParameterValueError } from './materials';

export const EFFECT_PARAMETER_TYPES = ['float', 'vec3', 'color'] as const;
export type EffectParameterType = (typeof EFFECT_PARAMETER_TYPES)[number];

/** An exposed parameter of an effect (read by Parameter nodes of its systems). */
export interface EffectParameter {
  /** An identifier (Parameter nodes and overrides name it). */
  key: string;
  type: EffectParameterType;
  /** float: a number; vec3: 3 numbers; color: "#rrggbb". */
  default: number | number[] | string;
  min?: number;
  max?: number;
  /** Public (absent) = objects may override it; private = the effect's own value only. */
  visibility?: 'public' | 'private';
  label?: string;
  group?: string;
  tooltip?: string;
}

export interface EffectSystem {
  systemId: string;
  name: string;
  /** Capacity: at most this many living particles (the executor may cap lower, e.g. the CPU fallback). */
  maxParticles: number;
  /** local: particles move with the origin; world: they stay where they were born. */
  space: 'local' | 'world';
  /** The system's graph (kind `effect`). */
  graph: GraphData;
}

export interface EffectDef {
  effectId: string;
  name: string;
  /** Seconds of one cycle (bursts and the effect time refer to it). */
  duration: number;
  /** true: the cycle restarts at the end; false: spawning stops and the effect ends when its particles are gone. */
  loop: boolean;
  /** The random seed (0 – 2^32−1). */
  seed: number;
  /** Culling bounds around the origin (metres, effect space). */
  bounds: { center: [number, number, number]; size: [number, number, number] };
  /** Exposed parameters (absent = none; list order is the Inspector's). */
  parameters?: EffectParameter[];
  /** The particle systems, in evaluation order (events reach later systems in the same step). */
  systems: EffectSystem[];
}

/** The `effect` component: plays one effect from the entity. */
export interface EffectComponent {
  effectId: string;
  /** Absent = true: starts when the scene starts (a placed fire or fountain runs by itself). */
  playOnStart?: boolean;
  /** Overrides of public parameters (absent = none). */
  params?: Record<string, number | number[] | string>;
  /** Phase 20.2: (re)starts the effect when this signal is emitted (a switch, trigger or script sends it). */
  signal?: string;
  /** Phase 20.2: stops spawning when this signal is emitted (living particles finish their lives). */
  stopSignal?: string;
}

/** Engine limits (not tuning values). */
export const EFFECT_LIMITS = {
  effects: 128,
  systems: 16,
  parameters: 32,
  /** Data bound of one system's capacity (2^20); executors cap lower (the CPU fallback's cap is documented in 20.2). */
  maxParticles: 1_048_576,
  duration: 3600,
  seed: 4_294_967_295,
  /** Bounds centre and size (metres). */
  extent: 1e4,
} as const;

/**
 * A new effect's settings (engine defaults): a 2 s looping cycle — short
 * enough to see the loop while authoring, any effect sets its own; seed 1;
 * bounds a 4 m cube centred 1 m above the origin (a person-sized effect
 * standing on its origin).
 */
export const EFFECT_DEFAULTS = {
  duration: 2,
  loop: true,
  seed: 1,
  bounds: { center: [0, 1, 0] as [number, number, number], size: [4, 4, 4] as [number, number, number] },
  /** 1000: plenty for a smoke or spark system, affordable on the CPU fallback. */
  maxParticles: 1000,
  space: 'local' as const,
};

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A signal name (the switches' and triggers' syntax). */
const SIGNAL_RE = /^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
const shortText = (v: unknown, max: number): boolean => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
function onlyKeys(v: Record<string, unknown>, keys: readonly string[], path: string, errors: ModelErrorV2[], what: string): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}"`, k, keys.join(', '));
}
const vec3In = (v: unknown, lo: number, hi: number, loExclusive = false): boolean =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && (loExclusive ? x > lo : x >= lo) && x <= hi);

/** The port type an effect parameter feeds into a graph. */
export function effectParameterPortType(type: string): string | null {
  return (EFFECT_PARAMETER_TYPES as readonly string[]).includes(type) ? type : null;
}

/** The context a system graph validates in: the effect's parameters type the Parameter nodes. */
export function effectGraphContext(parameters: readonly unknown[] | undefined): GraphContext {
  return {
    lookup(name, value) {
      if (name !== 'parameter') return null;
      const p = (parameters ?? []).find((x) => isPlainObject(x) && x['key'] === value) as Record<string, unknown> | undefined;
      return typeof p?.['type'] === 'string' ? effectParameterPortType(p['type']) : null;
    },
  };
}

/** One value against a parameter declaration (null = valid). */
export function effectParameterValueError(p: Pick<EffectParameter, 'type' | 'min' | 'max'>, v: unknown): string | null {
  if (!(EFFECT_PARAMETER_TYPES as readonly string[]).includes(p.type)) return `one of ${EFFECT_PARAMETER_TYPES.join(', ')}`;
  return materialParameterValueError(p, v);
}

export function validateEffectParameters(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value) || value.length > EFFECT_LIMITS.parameters) {
    err(errors, 'field_value', path, `parameters is a list of at most ${EFFECT_LIMITS.parameters}`, Array.isArray(value) ? value.length : value);
    return;
  }
  const keys = new Set<string>();
  value.forEach((p, i) => {
    const pp = `${path}/${i}`;
    if (!isPlainObject(p)) return err(errors, 'field_type', pp, 'a parameter is { key, type, default, min?, max?, visibility?, label?, group?, tooltip? }', p);
    onlyKeys(p, ['key', 'type', 'default', 'min', 'max', 'visibility', 'label', 'group', 'tooltip'], pp, errors, 'parameter');
    const key = p['key'];
    if (typeof key !== 'string' || !MATERIAL_PARAMETER_KEY_RE.test(key)) err(errors, 'field_value', `${pp}/key`, 'a parameter key is an identifier (a letter or _, then letters, digits or _; 1-32 characters)', key);
    else if (keys.has(key)) err(errors, 'id_duplicate', `${pp}/key`, 'parameter keys are unique in an effect', key);
    else keys.add(key);
    const type = p['type'];
    if (typeof type !== 'string' || !(EFFECT_PARAMETER_TYPES as readonly string[]).includes(type)) {
      err(errors, 'field_value', `${pp}/type`, `type is one of ${EFFECT_PARAMETER_TYPES.join(', ')}`, type);
      return;
    }
    for (const k of ['min', 'max'] as const) {
      const v = p[k];
      if (v === undefined) continue;
      if (type === 'color') err(errors, 'field_unexpected', `${pp}/${k}`, `a colour parameter has no ${k}`, k);
      else if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6) err(errors, 'field_value', `${pp}/${k}`, `${k} is a number within ±1e6`, v);
    }
    if (typeof p['min'] === 'number' && typeof p['max'] === 'number' && p['min'] > p['max']) err(errors, 'field_value', `${pp}/max`, 'max is at least min', p['max']);
    if (p['default'] === undefined) err(errors, 'field_missing', `${pp}/default`, 'a parameter needs a default', undefined, 'default');
    else {
      const bad = effectParameterValueError({ type: type as EffectParameterType, ...(typeof p['min'] === 'number' ? { min: p['min'] } : {}), ...(typeof p['max'] === 'number' ? { max: p['max'] } : {}) }, p['default']);
      if (bad !== null) err(errors, 'field_value', `${pp}/default`, `the default is ${bad}`, p['default'], bad);
    }
    if (p['visibility'] !== undefined && p['visibility'] !== 'public' && p['visibility'] !== 'private') err(errors, 'field_value', `${pp}/visibility`, 'visibility is public or private', p['visibility']);
    for (const [k, max] of [['label', 64], ['group', 64], ['tooltip', 256]] as const) {
      if (p[k] !== undefined && !shortText(p[k], max)) err(errors, 'field_value', `${pp}/${k}`, `${k} is 1-${max} characters without control characters`, p[k]);
    }
  });
}

/** One effect (fields, parameters, systems and their graphs). */
export function validateEffect(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'an effect is { effectId, name, duration, loop, seed, bounds, parameters?, systems }', value);
  onlyKeys(value, ['effectId', 'name', 'duration', 'loop', 'seed', 'bounds', 'parameters', 'systems'], path, errors, 'effect');
  for (const k of ['effectId', 'name', 'duration', 'loop', 'seed', 'bounds', 'systems']) if (value[k] === undefined) err(errors, 'field_missing', `${path}/${k}`, `an effect needs "${k}"`, undefined, k);
  if (value['effectId'] !== undefined && (typeof value['effectId'] !== 'string' || !ID_RE.test(value['effectId']))) err(errors, 'id_invalid', `${path}/effectId`, 'effectId uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', value['effectId']);
  if (value['name'] !== undefined && !isName(value['name'])) err(errors, 'field_value', `${path}/name`, 'an effect name is 1-128 characters without control characters', value['name']);
  const d = value['duration'];
  if (d !== undefined && (typeof d !== 'number' || !Number.isFinite(d) || d < 0.01 || d > EFFECT_LIMITS.duration)) err(errors, 'field_value', `${path}/duration`, `duration is 0.01-${EFFECT_LIMITS.duration} seconds`, d);
  if (value['loop'] !== undefined && typeof value['loop'] !== 'boolean') err(errors, 'field_type', `${path}/loop`, 'loop is true or false', value['loop']);
  const seed = value['seed'];
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > EFFECT_LIMITS.seed)) err(errors, 'field_value', `${path}/seed`, `seed is an integer 0-${EFFECT_LIMITS.seed}`, seed);
  const b = value['bounds'];
  if (b !== undefined) {
    if (!isPlainObject(b)) err(errors, 'field_type', `${path}/bounds`, 'bounds is { center: [x, y, z], size: [x, y, z] }', b);
    else {
      onlyKeys(b, ['center', 'size'], `${path}/bounds`, errors, 'bounds');
      if (!vec3In(b['center'], -EFFECT_LIMITS.extent, EFFECT_LIMITS.extent)) err(errors, 'field_value', `${path}/bounds/center`, `center is [x, y, z] within ±${EFFECT_LIMITS.extent} m`, b['center']);
      if (!vec3In(b['size'], 0, EFFECT_LIMITS.extent, true)) err(errors, 'field_value', `${path}/bounds/size`, `size is [x, y, z], each 0 < v <= ${EFFECT_LIMITS.extent} m`, b['size']);
    }
  }
  const params = value['parameters'];
  if (params !== undefined) validateEffectParameters(params, `${path}/parameters`, errors);
  const ctx = effectGraphContext(Array.isArray(params) ? params : undefined);
  const systems = value['systems'];
  if (systems === undefined) return;
  if (!Array.isArray(systems) || systems.length > EFFECT_LIMITS.systems) {
    err(errors, 'field_value', `${path}/systems`, `systems is a list of at most ${EFFECT_LIMITS.systems}`, Array.isArray(systems) ? systems.length : systems);
    return;
  }
  const ids = new Set<string>();
  systems.forEach((s, i) => {
    const sp = `${path}/systems/${i}`;
    if (!isPlainObject(s)) return err(errors, 'field_type', sp, 'a system is { systemId, name, maxParticles, space, graph }', s);
    onlyKeys(s, ['systemId', 'name', 'maxParticles', 'space', 'graph'], sp, errors, 'system');
    for (const k of ['systemId', 'name', 'maxParticles', 'space', 'graph']) if (s[k] === undefined) err(errors, 'field_missing', `${sp}/${k}`, `a system needs "${k}"`, undefined, k);
    const id = s['systemId'];
    if (id !== undefined) {
      if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${sp}/systemId`, 'systemId uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', id);
      else if (ids.has(id)) err(errors, 'id_duplicate', `${sp}/systemId`, 'system ids are unique in an effect', id);
      else ids.add(id);
    }
    if (s['name'] !== undefined && !isName(s['name'])) err(errors, 'field_value', `${sp}/name`, 'a system name is 1-128 characters without control characters', s['name']);
    const m = s['maxParticles'];
    if (m !== undefined && (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > EFFECT_LIMITS.maxParticles)) err(errors, 'field_value', `${sp}/maxParticles`, `maxParticles is an integer 1-${EFFECT_LIMITS.maxParticles}`, m);
    if (s['space'] !== undefined && s['space'] !== 'local' && s['space'] !== 'world') err(errors, 'field_value', `${sp}/space`, 'space is local or world', s['space']);
    if (s['graph'] !== undefined) validateGraphData(EFFECT_GRAPH_KIND, s['graph'], `${sp}/graph`, errors, ctx);
  });
}

/** `content.effects`: at most 128 effects with unique ids. */
export function validateEffects(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'effects is a list', value, 'array of effects');
  if (value.length > EFFECT_LIMITS.effects) err(errors, 'limits_exceeded', path, `a project has at most ${EFFECT_LIMITS.effects} effects`, value.length);
  const seen = new Set<string>();
  value.forEach((e, i) => {
    validateEffect(e, `${path}/${i}`, errors);
    const id = isPlainObject(e) ? e['effectId'] : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}/effectId`, 'effectId is used twice', id);
      seen.add(id);
    }
  });
}

export function canonicalEffectParameters(list: readonly EffectParameter[]): EffectParameter[] {
  return list.map((p) => ({
    key: p.key,
    type: p.type,
    default: Array.isArray(p.default) ? [...p.default] : typeof p.default === 'string' ? p.default.toLowerCase() : p.default,
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    // Public is the default and omitted (15.4).
    ...(p.visibility === 'private' ? { visibility: 'private' as const } : {}),
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.group !== undefined ? { group: p.group } : {}),
    ...(p.tooltip !== undefined ? { tooltip: p.tooltip } : {}),
  }));
}

/** Canonical effect: fixed key order, systems in list order (their evaluation order), graphs canonical. */
export function canonicalEffect(e: EffectDef): EffectDef {
  return {
    effectId: e.effectId,
    name: e.name,
    duration: e.duration,
    loop: e.loop,
    seed: e.seed,
    bounds: { center: [e.bounds.center[0], e.bounds.center[1], e.bounds.center[2]], size: [e.bounds.size[0], e.bounds.size[1], e.bounds.size[2]] },
    ...(e.parameters !== undefined && e.parameters.length > 0 ? { parameters: canonicalEffectParameters(e.parameters) } : {}),
    systems: e.systems.map((s) => ({ systemId: s.systemId, name: s.name, maxParticles: s.maxParticles, space: s.space, graph: canonicalGraphData(s.graph) })),
  };
}

/** Canonical order: ascending effectId. */
export function canonicalEffects(list: readonly EffectDef[]): EffectDef[] {
  return [...list].sort((a, b) => (a.effectId < b.effectId ? -1 : a.effectId > b.effectId ? 1 : 0)).map(canonicalEffect);
}

/** The owner id of a system graph (`graphEdit {owner: {kind: "effect", id}}`). */
export function effectSystemOwnerId(effectId: string, systemId: string): string {
  return `${effectId}/${systemId}`;
}
export function parseEffectSystemOwnerId(id: string): { effectId: string; systemId: string } | null {
  const i = id.indexOf('/');
  if (i < 1 || i === id.length - 1) return null;
  const effectId = id.slice(0, i);
  const systemId = id.slice(i + 1);
  return ID_RE.test(effectId) && ID_RE.test(systemId) ? { effectId, systemId } : null;
}

// ---- the `effect` component ----------------------------------------------------------------

export function validateEffectComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'an effect component is { effectId, playOnStart?, params? }', value);
  onlyKeys(value, ['effectId', 'playOnStart', 'params', 'signal', 'stopSignal'], path, errors, 'effect component');
  for (const k of ['signal', 'stopSignal'] as const) {
    const v = value[k];
    if (v !== undefined && (typeof v !== 'string' || !SIGNAL_RE.test(v))) err(errors, 'field_value', `${path}/${k}`, `${k} is a signal name`, v);
  }
  const id = value['effectId'];
  if (id === undefined) err(errors, 'field_missing', `${path}/effectId`, 'an effect component names an effect', undefined, 'effectId');
  else if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'id_invalid', `${path}/effectId`, 'effectId uses the id syntax [a-z0-9][a-z0-9_-]{0,63}', id);
  if (value['playOnStart'] !== undefined && typeof value['playOnStart'] !== 'boolean') err(errors, 'field_type', `${path}/playOnStart`, 'playOnStart is true or false', value['playOnStart']);
  const params = value['params'];
  if (params !== undefined) {
    // Empty is allowed (the last override removed) and dropped from the canonical form.
    if (!isPlainObject(params) || Object.keys(params).length > EFFECT_LIMITS.parameters) {
      err(errors, 'field_value', `${path}/params`, `params is an object of at most ${EFFECT_LIMITS.parameters} parameter values`, params);
      return;
    }
    for (const [k, v] of Object.entries(params)) {
      if (!MATERIAL_PARAMETER_KEY_RE.test(k)) err(errors, 'field_value', `${path}/params/${k}`, 'a parameter key is an identifier', k);
      const ok = (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && COLOR_RE.test(v.toLowerCase())) || (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
      if (!ok) err(errors, 'field_type', `${path}/params/${k}`, 'a parameter value is a number, 3 numbers or a colour "#rrggbb"', v);
    }
  }
}

export function canonicalEffectComponent(c: EffectComponent): EffectComponent {
  const params = c.params !== undefined ? Object.fromEntries(Object.keys(c.params).sort().map((k) => { const v = c.params![k]!; return [k, Array.isArray(v) ? [...v] : typeof v === 'string' ? v.toLowerCase() : v]; })) : undefined;
  return {
    effectId: c.effectId,
    // true is the default and omitted.
    ...(c.playOnStart === false ? { playOnStart: false } : {}),
    ...(params !== undefined && Object.keys(params).length > 0 ? { params } : {}),
    // Phase 20.2: last, so an existing component keeps its exact canonical bytes.
    ...(c.signal !== undefined ? { signal: c.signal } : {}),
    ...(c.stopSignal !== undefined ? { stopSignal: c.stopSignal } : {}),
  };
}

/**
 * The project rule for one component: it names an effect of the project and
 * overrides only public parameters of it with values that fit. Returns
 * [relative path, code, message, found] tuples.
 */
export function effectComponentErrors(c: EffectComponent, effects: readonly EffectDef[]): { path: string; code: string; message: string; found: unknown }[] {
  const out: { path: string; code: string; message: string; found: unknown }[] = [];
  const e = effects.find((x) => x.effectId === c.effectId);
  if (e === undefined) return [{ path: '/effectId', code: 'reference_missing', message: 'the component names no effect of this project', found: c.effectId }];
  for (const [k, v] of Object.entries(c.params ?? {})) {
    const p = (e.parameters ?? []).find((x) => x.key === k);
    if (p === undefined) out.push({ path: `/params/${k}`, code: 'reference_missing', message: `effect "${e.name}" has no parameter "${k}"`, found: k });
    else if (p.visibility === 'private') out.push({ path: `/params/${k}`, code: 'field_value', message: `parameter "${k}" of effect "${e.name}" is private: objects cannot override it`, found: k });
    else {
      const bad = effectParameterValueError(p, v);
      if (bad !== null) out.push({ path: `/params/${k}`, code: 'field_value', message: `${k} must be ${bad}`, found: v });
    }
  }
  return out;
}

// ---- Phase 20.2: the runtime view and gameplay hooks ----------------------------------------

/**
 * The effects a game carries (the manifest's `effects`): every system graph
 * without editor-only text (comments, groups, reroutes, collapsed flags) —
 * the executors compile the graphs; positions are kept (canonical data).
 */
export function effectsForRuntime(effects: readonly EffectDef[]): EffectDef[] {
  return canonicalEffects(effects).map((e) => ({
    ...e,
    systems: e.systems.map((s) => ({ ...s, graph: graphForRuntime(s.graph) })),
  }));
}

/** The assets an effect's graphs name (billboard/ribbon textures, mesh models, mesh-surface shapes). */
export function effectAssetRefs(effect: EffectDef): { asset: 'texture' | 'model'; id: string }[] {
  const out: { asset: 'texture' | 'model'; id: string }[] = [];
  for (const s of effect.systems) {
    for (const n of s.graph.nodes) {
      const data = (n as { data?: Record<string, unknown> }).data ?? {};
      const def = EFFECT_GRAPH_KIND.nodes.find((d) => d.type === n.type);
      for (const f of def?.fields ?? []) {
        const kind = (f as { asset?: string }).asset;
        const v = data[f.key];
        if ((kind === 'texture' || kind === 'model') && typeof v === 'string' && v !== '') out.push({ asset: kind, id: v });
      }
    }
  }
  return out;
}

/** The project materials an effect's Output blocks shade with (shading `material`). */
export function effectMaterialRefs(effect: EffectDef): string[] {
  const out = new Set<string>();
  for (const s of effect.systems) {
    for (const n of s.graph.nodes) {
      const data = (n as { data?: Record<string, unknown> }).data ?? {};
      if (data['shading'] === 'material' && typeof data['material'] === 'string' && data['material'] !== '') out.add(data['material']);
    }
  }
  return [...out].sort();
}

/**
 * The effects an entity's gameplay hooks name (phase 20.2), as
 * [component-relative path, effectId]: pickup `effect` (collected), enemy
 * `hitEffect`/`defeatEffect`, health `hitEffect` (the player is hit), game
 * zone `effect` (a checkpoint or goal reached).
 */
export function effectHookRefs(components: Readonly<Record<string, unknown>>): [string, string][] {
  const out: [string, string][] = [];
  const at = (component: string, key: string): void => {
    const c = components[component] as Record<string, unknown> | undefined;
    const v = c?.[key];
    if (typeof v === 'string') out.push([`${component}/${key}`, v]);
  };
  at('pickup', 'effect');
  at('enemy', 'hitEffect');
  at('enemy', 'defeatEffect');
  at('health', 'hitEffect');
  at('gameZone', 'effect');
  return out;
}
