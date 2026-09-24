/**
 * Phase 9.7: animator controllers (state machines for model animation) and
 * the `animator` component that puts one on a model entity.
 *
 * A controller (`content.animators[]`) has parameters (float, int, bool,
 * trigger), states — each plays one clip or a 1D blend tree of clips —,
 * transitions (from a state or from any state; conditions on parameters, a
 * crossfade duration, an optional exit time), an entry state and clip events.
 * Clips are named clips of model assets (`{assetId, clip, duration}`; the
 * editor fills the duration from the file).
 *
 * Phase 14.6: the controller's own states are the base layer; `layers` adds
 * override layers on top (e.g. an upper-body attack while running). Each
 * layer has its own states, transitions and entry state, shares the
 * controller's parameters and events, and drives only the bones of its
 * `mask` (empty = every bone), with a weight (0–1, optionally times a float
 * parameter). A layer state may be `empty` (the layers under it show
 * through).
 */
import type { ModelErrorV2 } from './errors';

export const ANIMATOR_PARAMETER_TYPES = ['float', 'int', 'bool', 'trigger'] as const;
export type AnimatorParameterType = (typeof ANIMATOR_PARAMETER_TYPES)[number];
export const ANIMATOR_CONDITION_OPS = ['greater', 'less', 'equals', 'notEquals', 'true', 'false', 'trigger'] as const;
export type AnimatorConditionOp = (typeof ANIMATOR_CONDITION_OPS)[number];

export interface AnimatorParameter {
  name: string;
  type: AnimatorParameterType;
  /** Number for float/int, boolean for bool; triggers start unset. */
  default?: number | boolean;
}

export interface AnimatorClipRef {
  assetId: string;
  clip: string;
  /** Seconds (the clip's length in the file). */
  duration: number;
}

export type AnimatorMotion =
  | { kind: 'clip'; clip: AnimatorClipRef }
  | { kind: 'blend1d'; parameter: string; children: { threshold: number; clip: AnimatorClipRef }[] }
  /** Phase 14.6, override layers only: nothing plays (the layers under it show through). */
  | { kind: 'empty' };

export interface AnimatorState {
  id: string;
  name: string;
  motion: AnimatorMotion;
  /** Playback speed (× the speed parameter when there is one). */
  speed: number;
  speedParameter?: string;
  loop: boolean;
  /** Where the editor draws the state. */
  position?: [number, number];
}

export interface AnimatorCondition {
  parameter: string;
  op: AnimatorConditionOp;
  value?: number;
}

export interface AnimatorTransition {
  /** A state id, or "*" (any state). */
  from: string;
  to: string;
  conditions: AnimatorCondition[];
  /** Crossfade in seconds. */
  duration: number;
  /** Normalized time of the source state after which the transition may fire (absent = any time). */
  exitTime?: number;
  /** "source": a newer transition from the current state may cut in during the crossfade. */
  interruption?: 'none' | 'source';
}

export interface AnimatorEvent {
  /** The clip (by asset and name) and the time in it (seconds). */
  assetId: string;
  clip: string;
  time: number;
  name: string;
}

/** Phase 14.6: an override layer (drawn over the base layer and the layers before it). */
export interface AnimatorLayer {
  name: string;
  /** The bone (node) names this layer drives, as the model's skeleton names them; empty = every bone. */
  mask: string[];
  /** 0–1: how much the layer replaces the layers under it on its bones. */
  weight: number;
  /** A float parameter (clamped to 0–1) the weight is multiplied by. */
  weightParameter?: string;
  states: AnimatorState[];
  transitions: AnimatorTransition[];
  entry: string;
}

export interface AnimatorController {
  controllerId: string;
  name: string;
  parameters: AnimatorParameter[];
  /** The base layer's states, transitions and entry state. */
  states: AnimatorState[];
  transitions: AnimatorTransition[];
  entry: string;
  events: AnimatorEvent[];
  /** Phase 14.6: override layers over the base layer (absent = the base layer only). */
  layers?: AnimatorLayer[];
}

export interface AnimatorComponent {
  controller: string;
  /** Initial parameter values for this entity. */
  parameters?: Record<string, number | boolean>;
}

export const MAX_ANIMATORS = 64;
export const MAX_ANIMATOR_PARAMETERS = 32;
export const MAX_ANIMATOR_STATES = 64;
export const MAX_ANIMATOR_TRANSITIONS = 256;
export const MAX_ANIMATOR_CONDITIONS = 8;
export const MAX_ANIMATOR_EVENTS = 64;
export const MAX_BLEND_CHILDREN = 16;
/** Phase 14.6: override layers besides the base layer. */
export const MAX_ANIMATOR_LAYERS = 3;
/** Phase 14.6: bone names in one layer mask (the import cap on joints per skin). */
export const MAX_LAYER_MASK = 128;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isName(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
}
const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
function onlyKeys(v: Record<string, unknown>, keys: readonly string[], path: string, errors: ModelErrorV2[]): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, keys.join(', '));
}

function checkClip(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a clip is { assetId, clip, duration }', v);
  onlyKeys(v, ['assetId', 'clip', 'duration'], path, errors);
  if (typeof v['assetId'] !== 'string' || !ID_RE.test(v['assetId'])) err(errors, 'field_value', `${path}/assetId`, 'assetId is a model asset id', v['assetId']);
  if (!isName(v['clip'])) err(errors, 'field_value', `${path}/clip`, 'clip is the clip name (1–128 characters)', v['clip']);
  if (!num(v['duration'], 0.001, 600)) err(errors, 'field_value', `${path}/duration`, 'duration is the clip length in seconds (0–600)', v['duration']);
}

/** One layer's states, entry and transitions (the base layer or an override layer). */
function checkGraph(v: Record<string, unknown>, path: string, params: ReadonlyMap<string, AnimatorParameterType>, stateIds: Set<string>, allowEmpty: boolean, errors: ModelErrorV2[]): void {
  const own = new Set<string>();
  const slist = v['states'];
  if (!Array.isArray(slist) || slist.length < 1 || slist.length > MAX_ANIMATOR_STATES) err(errors, 'field_value', `${path}/states`, `states is a list of 1–${MAX_ANIMATOR_STATES}`, Array.isArray(slist) ? slist.length : slist);
  else
    slist.forEach((s, i) => {
      const sp = `${path}/states/${i}`;
      if (!isPlainObject(s)) return err(errors, 'field_type', sp, 'a state is an object', s);
      onlyKeys(s, ['id', 'name', 'motion', 'speed', 'speedParameter', 'loop', 'position'], sp, errors);
      const id = s['id'];
      if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'field_value', `${sp}/id`, 'a state id is an id', id);
      else if (stateIds.has(id)) err(errors, 'field_value', `${sp}/id`, 'state ids are unique (across all layers)', id);
      else {
        stateIds.add(id);
        own.add(id);
      }
      if (!isName(s['name'])) err(errors, 'field_value', `${sp}/name`, 'name is 1–128 characters', s['name']);
      if (!num(s['speed'], 0, 10)) err(errors, 'field_value', `${sp}/speed`, 'speed is a number in [0, 10]', s['speed']);
      if (typeof s['loop'] !== 'boolean') err(errors, 'field_type', `${sp}/loop`, 'loop is true or false', s['loop']);
      if (s['speedParameter'] !== undefined && params.get(s['speedParameter'] as string) !== 'float') err(errors, 'reference_missing', `${sp}/speedParameter`, 'speedParameter names a float parameter', s['speedParameter']);
      const pos = s['position'];
      if (pos !== undefined && (!Array.isArray(pos) || pos.length !== 2 || !pos.every((x) => num(x, -1e5, 1e5)))) err(errors, 'field_value', `${sp}/position`, 'position is [x, y]', pos);
      const m = s['motion'];
      if (!isPlainObject(m)) return err(errors, 'field_type', `${sp}/motion`, 'motion is a clip or a 1D blend tree', m);
      if (m['kind'] === 'clip') {
        onlyKeys(m, ['kind', 'clip'], `${sp}/motion`, errors);
        checkClip(m['clip'], `${sp}/motion/clip`, errors);
      } else if (m['kind'] === 'blend1d') {
        onlyKeys(m, ['kind', 'parameter', 'children'], `${sp}/motion`, errors);
        const bp = params.get(m['parameter'] as string);
        if (bp !== 'float' && bp !== 'int') err(errors, 'reference_missing', `${sp}/motion/parameter`, 'a blend tree reads a float or int parameter', m['parameter']);
        const kids = m['children'];
        if (!Array.isArray(kids) || kids.length < 2 || kids.length > MAX_BLEND_CHILDREN) err(errors, 'field_value', `${sp}/motion/children`, `a blend tree has 2–${MAX_BLEND_CHILDREN} clips`, kids);
        else {
          let last = -Infinity;
          kids.forEach((k, j) => {
            const kp = `${sp}/motion/children/${j}`;
            if (!isPlainObject(k)) return err(errors, 'field_type', kp, 'a blend child is { threshold, clip }', k);
            onlyKeys(k, ['threshold', 'clip'], kp, errors);
            if (!num(k['threshold'], -1e6, 1e6) || k['threshold'] <= last) err(errors, 'field_value', `${kp}/threshold`, 'thresholds are numbers in increasing order', k['threshold']);
            else last = k['threshold'];
            checkClip(k['clip'], `${kp}/clip`, errors);
          });
        }
      } else if (m['kind'] === 'empty' && allowEmpty) {
        onlyKeys(m, ['kind'], `${sp}/motion`, errors);
      } else err(errors, 'field_value', `${sp}/motion/kind`, allowEmpty ? 'motion kind is clip, blend1d or empty' : 'motion kind is clip or blend1d (empty is for override layers)', m['kind']);
    });

  if (typeof v['entry'] !== 'string' || !own.has(v['entry'])) err(errors, 'reference_missing', `${path}/entry`, 'entry names a state of this layer', v['entry']);

  const tlist = v['transitions'];
  if (!Array.isArray(tlist) || tlist.length > MAX_ANIMATOR_TRANSITIONS) err(errors, 'field_value', `${path}/transitions`, `transitions is a list of at most ${MAX_ANIMATOR_TRANSITIONS}`, tlist);
  else
    tlist.forEach((t, i) => {
      const tp = `${path}/transitions/${i}`;
      if (!isPlainObject(t)) return err(errors, 'field_type', tp, 'a transition is an object', t);
      onlyKeys(t, ['from', 'to', 'conditions', 'duration', 'exitTime', 'interruption'], tp, errors);
      if (t['from'] !== '*' && !own.has(t['from'] as string)) err(errors, 'reference_missing', `${tp}/from`, 'from names a state of this layer or "*" (any state)', t['from']);
      if (!own.has(t['to'] as string)) err(errors, 'reference_missing', `${tp}/to`, 'to names a state of this layer', t['to']);
      if (!num(t['duration'], 0, 10)) err(errors, 'field_value', `${tp}/duration`, 'duration is the crossfade in seconds [0, 10]', t['duration']);
      if (t['exitTime'] !== undefined && !num(t['exitTime'], 0, 100)) err(errors, 'field_value', `${tp}/exitTime`, 'exitTime is a normalized time [0, 100]', t['exitTime']);
      if (t['interruption'] !== undefined && t['interruption'] !== 'none' && t['interruption'] !== 'source') err(errors, 'field_value', `${tp}/interruption`, 'interruption is none or source', t['interruption']);
      const conds = t['conditions'];
      if (!Array.isArray(conds) || conds.length > MAX_ANIMATOR_CONDITIONS) return err(errors, 'field_value', `${tp}/conditions`, `conditions is a list of at most ${MAX_ANIMATOR_CONDITIONS}`, conds);
      if (conds.length === 0 && t['exitTime'] === undefined) err(errors, 'field_value', `${tp}/conditions`, 'a transition needs a condition or an exit time', conds);
      conds.forEach((c, j) => {
        const cp = `${tp}/conditions/${j}`;
        if (!isPlainObject(c)) return err(errors, 'field_type', cp, 'a condition is { parameter, op, value? }', c);
        onlyKeys(c, ['parameter', 'op', 'value'], cp, errors);
        const type = params.get(c['parameter'] as string);
        if (type === undefined) return err(errors, 'reference_missing', `${cp}/parameter`, 'the condition names a parameter of this controller', c['parameter']);
        const op = c['op'];
        const numeric = op === 'greater' || op === 'less' || op === 'equals' || op === 'notEquals';
        const fits = type === 'trigger' ? op === 'trigger' : type === 'bool' ? op === 'true' || op === 'false' : numeric;
        if (!fits) return err(errors, 'field_value', `${cp}/op`, type === 'trigger' ? 'a trigger condition is "trigger"' : type === 'bool' ? 'a bool condition is "true" or "false"' : 'a number condition is greater, less, equals or notEquals', op);
        if (numeric && !num(c['value'], -1e6, 1e6)) err(errors, 'field_value', `${cp}/value`, 'a number condition compares with a value', c['value']);
        if (!numeric && c['value'] !== undefined) err(errors, 'field_unexpected', `${cp}/value`, 'only number conditions have a value', c['value']);
      });
    });

}

/** One controller (structure, ranges and its internal references). */
export function validateAnimatorController(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'an animator controller is an object', value);
  const v = value;
  onlyKeys(v, ['controllerId', 'name', 'parameters', 'states', 'transitions', 'entry', 'events', 'layers'], path, errors);
  if (typeof v['controllerId'] !== 'string' || !ID_RE.test(v['controllerId'])) err(errors, 'field_value', `${path}/controllerId`, 'controllerId is an id (a-z, 0-9, _ and -)', v['controllerId']);
  if (!isName(v['name'])) err(errors, 'field_value', `${path}/name`, 'name is 1–128 characters', v['name']);

  const params = new Map<string, AnimatorParameterType>();
  const plist = v['parameters'];
  if (!Array.isArray(plist) || plist.length > MAX_ANIMATOR_PARAMETERS) err(errors, 'field_value', `${path}/parameters`, `parameters is a list of at most ${MAX_ANIMATOR_PARAMETERS}`, plist);
  else
    plist.forEach((p, i) => {
      const pp = `${path}/parameters/${i}`;
      if (!isPlainObject(p)) return err(errors, 'field_type', pp, 'a parameter is { name, type, default? }', p);
      onlyKeys(p, ['name', 'type', 'default'], pp, errors);
      const name = p['name'];
      const type = p['type'];
      if (typeof name !== 'string' || !PARAM_RE.test(name)) return err(errors, 'field_value', `${pp}/name`, 'a parameter name is a letter or _ then letters, digits or _', name);
      if (params.has(name)) err(errors, 'field_value', `${pp}/name`, 'parameter names are unique', name);
      if (!(ANIMATOR_PARAMETER_TYPES as readonly unknown[]).includes(type)) return err(errors, 'field_value', `${pp}/type`, 'type is float, int, bool or trigger', type);
      params.set(name, type as AnimatorParameterType);
      const d = p['default'];
      if (d === undefined) return;
      const ok = type === 'bool' ? typeof d === 'boolean' : type === 'int' ? Number.isInteger(d) && num(d, -1e6, 1e6) : type === 'float' ? num(d, -1e6, 1e6) : false;
      if (!ok) err(errors, 'field_value', `${pp}/default`, type === 'trigger' ? 'a trigger has no default' : `the default must be a ${type}`, d);
    });

  const stateIds = new Set<string>();
  checkGraph(v, path, params, stateIds, false, errors);

  const layers = v['layers'];
  if (layers !== undefined) {
    if (!Array.isArray(layers) || layers.length < 1 || layers.length > MAX_ANIMATOR_LAYERS) err(errors, 'field_value', `${path}/layers`, `layers is a list of 1–${MAX_ANIMATOR_LAYERS} override layers (absent = the base layer only)`, Array.isArray(layers) ? layers.length : layers);
    else
      layers.forEach((l, i) => {
        const lp = `${path}/layers/${i}`;
        if (!isPlainObject(l)) return err(errors, 'field_type', lp, 'a layer is { name, mask, weight, weightParameter?, states, transitions, entry }', l);
        onlyKeys(l, ['name', 'mask', 'weight', 'weightParameter', 'states', 'transitions', 'entry'], lp, errors);
        if (!isName(l['name'])) err(errors, 'field_value', `${lp}/name`, 'name is 1–128 characters', l['name']);
        const mask = l['mask'];
        if (!Array.isArray(mask) || mask.length > MAX_LAYER_MASK) err(errors, 'field_value', `${lp}/mask`, `mask is a list of at most ${MAX_LAYER_MASK} bone names (empty = every bone)`, mask);
        else {
          const seen = new Set<string>();
          mask.forEach((b, j) => {
            if (!isName(b)) err(errors, 'field_value', `${lp}/mask/${j}`, 'a bone name is 1–128 characters', b);
            else if (seen.has(b)) err(errors, 'field_value', `${lp}/mask/${j}`, 'bone names in a mask are unique', b);
            else seen.add(b);
          });
        }
        if (!num(l['weight'], 0, 1)) err(errors, 'field_value', `${lp}/weight`, 'weight is a number in [0, 1]', l['weight']);
        if (l['weightParameter'] !== undefined && params.get(l['weightParameter'] as string) !== 'float') err(errors, 'reference_missing', `${lp}/weightParameter`, 'weightParameter names a float parameter', l['weightParameter']);
        checkGraph(l, lp, params, stateIds, true, errors);
      });
  }

  const elist = v['events'];
  if (!Array.isArray(elist) || elist.length > MAX_ANIMATOR_EVENTS) err(errors, 'field_value', `${path}/events`, `events is a list of at most ${MAX_ANIMATOR_EVENTS}`, elist);
  else
    elist.forEach((e, i) => {
      const ep = `${path}/events/${i}`;
      if (!isPlainObject(e)) return err(errors, 'field_type', ep, 'an event is { assetId, clip, time, name }', e);
      onlyKeys(e, ['assetId', 'clip', 'time', 'name'], ep, errors);
      if (typeof e['assetId'] !== 'string' || !ID_RE.test(e['assetId'])) err(errors, 'field_value', `${ep}/assetId`, 'assetId is a model asset id', e['assetId']);
      if (!isName(e['clip'])) err(errors, 'field_value', `${ep}/clip`, 'clip is a clip name', e['clip']);
      if (!num(e['time'], 0, 600)) err(errors, 'field_value', `${ep}/time`, 'time is seconds into the clip', e['time']);
      if (typeof e['name'] !== 'string' || !PARAM_RE.test(e['name'])) err(errors, 'field_value', `${ep}/name`, 'an event name is a letter or _ then letters, digits or _', e['name']);
    });
}

/** `content.animators`. */
export function validateAnimators(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value) || value.length > MAX_ANIMATORS) return err(errors, 'field_value', path, `animators is a list of at most ${MAX_ANIMATORS}`, value);
  const ids = new Set<string>();
  value.forEach((c, i) => {
    validateAnimatorController(c, `${path}/${i}`, errors);
    const id = isPlainObject(c) ? c['controllerId'] : undefined;
    if (typeof id === 'string') {
      if (ids.has(id)) err(errors, 'id_duplicate', `${path}/${i}/controllerId`, 'controller ids are unique', id);
      ids.add(id);
    }
  });
}

/** The `animator` component (its controller is checked against the content). */
export function validateAnimatorComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'animator is { controller, parameters? }', value);
  onlyKeys(value, ['controller', 'parameters'], path, errors);
  if (typeof value['controller'] !== 'string' || !ID_RE.test(value['controller'])) err(errors, 'field_value', `${path}/controller`, 'controller is a controller id', value['controller']);
  const p = value['parameters'];
  if (p === undefined) return;
  if (!isPlainObject(p) || Object.keys(p).length > MAX_ANIMATOR_PARAMETERS) return err(errors, 'field_value', `${path}/parameters`, 'parameters maps parameter names to numbers or booleans', p);
  for (const [k, x] of Object.entries(p)) {
    if (!PARAM_RE.test(k)) err(errors, 'field_value', `${path}/parameters/${k}`, 'a parameter name', k);
    if (typeof x !== 'boolean' && !num(x, -1e6, 1e6)) err(errors, 'field_value', `${path}/parameters/${k}`, 'a parameter value is a number or a boolean', x);
  }
}

const clipOf = (c: AnimatorClipRef): AnimatorClipRef => ({ assetId: c.assetId, clip: c.clip, duration: c.duration });

const canonicalMotion = (m: AnimatorMotion): AnimatorMotion =>
  m.kind === 'clip'
    ? { kind: 'clip', clip: clipOf(m.clip) }
    : m.kind === 'blend1d'
      ? { kind: 'blend1d', parameter: m.parameter, children: m.children.map((k) => ({ threshold: k.threshold, clip: clipOf(k.clip) })) }
      : { kind: 'empty' };
const canonicalStates = (list: readonly AnimatorState[]): AnimatorState[] =>
  list.map((s) => ({
    id: s.id,
    name: s.name,
    motion: canonicalMotion(s.motion),
    speed: s.speed,
    ...(s.speedParameter !== undefined ? { speedParameter: s.speedParameter } : {}),
    loop: s.loop,
    ...(s.position !== undefined ? { position: [s.position[0], s.position[1]] as [number, number] } : {}),
  }));
const canonicalTransitions = (list: readonly AnimatorTransition[]): AnimatorTransition[] =>
  list.map((t) => ({
    from: t.from,
    to: t.to,
    conditions: t.conditions.map((x) => ({ parameter: x.parameter, op: x.op, ...(x.value !== undefined ? { value: x.value } : {}) })),
    duration: t.duration,
    ...(t.exitTime !== undefined ? { exitTime: t.exitTime } : {}),
    ...(t.interruption !== undefined ? { interruption: t.interruption } : {}),
  }));

export function canonicalAnimatorController(c: AnimatorController): AnimatorController {
  return {
    controllerId: c.controllerId,
    name: c.name,
    parameters: c.parameters.map((p) => ({ name: p.name, type: p.type, ...(p.default !== undefined ? { default: p.default } : {}) })),
    states: canonicalStates(c.states),
    transitions: canonicalTransitions(c.transitions),
    entry: c.entry,
    events: c.events.map((e) => ({ assetId: e.assetId, clip: e.clip, time: e.time, name: e.name })),
    // Phase 14.6: override layers (a controller without them keeps its exact old form).
    ...(c.layers !== undefined && c.layers.length > 0
      ? {
          layers: c.layers.map((l) => ({
            name: l.name,
            mask: [...l.mask],
            weight: l.weight,
            ...(l.weightParameter !== undefined ? { weightParameter: l.weightParameter } : {}),
            states: canonicalStates(l.states),
            transitions: canonicalTransitions(l.transitions),
            entry: l.entry,
          })),
        }
      : {}),
  };
}

export function canonicalAnimators(list: readonly AnimatorController[]): AnimatorController[] {
  return [...list].sort((a, b) => (a.controllerId < b.controllerId ? -1 : a.controllerId > b.controllerId ? 1 : 0)).map(canonicalAnimatorController);
}

export function canonicalAnimatorComponent(c: AnimatorComponent): AnimatorComponent {
  return {
    controller: c.controller,
    ...(c.parameters !== undefined ? { parameters: Object.fromEntries(Object.keys(c.parameters).sort().map((k) => [k, c.parameters![k]!])) } : {}),
  };
}

/** Every model asset a controller's clips come from. */
export function animatorAssetIds(c: AnimatorController): string[] {
  const ids = new Set<string>();
  for (const s of animatorStates(c)) {
    if (s.motion.kind === 'clip') ids.add(s.motion.clip.assetId);
    else if (s.motion.kind === 'blend1d') for (const k of s.motion.children) ids.add(k.clip.assetId);
  }
  return [...ids].sort();
}

/** Phase 14.6: every state of a controller, the base layer's first, then each override layer's. */
export function animatorStates(c: AnimatorController): AnimatorState[] {
  return [...c.states, ...(c.layers ?? []).flatMap((l) => l.states)];
}
