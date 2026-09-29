/**
 * Timelines — sequencer assets (`content.timelines[]`, v4).
 *
 * A timeline is a length of time (`duration`, seconds) with tracks; every
 * track holds keys on the time ruler (a key with a `duration` is a clip).
 * Tracks never name entities: they name binding slots (`slots`), and a play
 * call binds slots to entities (a slot's `entity` is its default binding, so
 * the editor can preview and a script may play the timeline without
 * bindings) — one timeline is reusable with different actors.
 *
 * Track types (the keys' own fields in brackets):
 * - `camera`     a key makes a virtual camera live from its time until the
 *                next key [camera slot | release, blend, blendTime, rail
 *                progress [from, to] over the key's span, easing]; track
 *                `end`: release (the game's cameras decide again) or keep;
 * - `transform`  the target's transform [position, rotation, scale, easing];
 * - `animator`   the target's animator [kind set | trigger | play, name,
 *                value, fade, layer];
 * - `audio`      [kind music | release | stinger | sfx, asset, fade, volume,
 *                loop, duration, at (a slot: positional)]; track
 *                `releaseMusic`: give the music back at the end;
 * - `dialogue`   run a dialogue node and wait [dialogue, node, wait];
 * - `effect`     [effect, duration, at, position, params];
 * - `activation` the target shown or hidden [active];
 * - `signal`     [name, onSkip fire | drop];
 * - `fade`       a full-screen colour over the view [value 0–1, color,
 *                easing]; `letterbox` bars [value 0–0.5, easing]; both with
 *                track `hold` (keep the last value after the end);
 * - `wait`       the timeline stops at the key until an input action is
 *                pressed [action, timeout];
 * - `material`   a graph-material parameter of the target (track `param`,
 *                `material`) [value, easing];
 * - `environment` switch to an environment preset [preset, blendTime];
 * - `mode` switch the game mode (as `ctx.modes.switch`)
 *                [mode, blend, blendTime].
 *
 * Validation here is the data's own rules; references to assets, effects and
 * materials are checked against the project by `validateTimelineReferences`.
 * Pure: no I/O.
 */
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';
import { isPlainObject } from './validate';

/** Engine limits of timelines (documented in deployment.md). */
export const TIMELINE_LIMITS = Object.freeze({
  /** Timelines per project. */
  timelines: 64,
  /** Tracks per timeline. */
  tracks: 32,
  /** Keys per track. */
  keys: 256,
  /** Binding slots per timeline. */
  slots: 16,
  /** Markers per timeline. */
  markers: 64,
  /** The longest timeline (seconds): ten minutes, longer than any cutscene. */
  duration: 600,
  /** A timeline's canonical JSON (fits one 64 KiB command). */
  bytes: 49_152,
  /** Name characters (timeline, track). */
  nameChars: 128,
  /** Timelines playing at once. */
  playing: 8,
  /** Effect parameters on one key. */
  params: 16,
});

export const TIMELINE_TRACK_TYPES = ['camera', 'transform', 'animator', 'audio', 'dialogue', 'effect', 'activation', 'signal', 'fade', 'letterbox', 'wait', 'material', 'environment', 'mode'] as const;
export type TimelineTrackType = (typeof TIMELINE_TRACK_TYPES)[number];

/** How a value moves from the previous key to this one (`step`: holds the previous value, then jumps). */
export const TIMELINE_EASINGS = ['linear', 'step', 'easeIn', 'easeOut', 'easeInOut'] as const;
export type TimelineEasing = (typeof TIMELINE_EASINGS)[number];

/** Tracks that act on one bound object (`target` is required). */
export const TIMELINE_TARGET_TRACKS: readonly TimelineTrackType[] = ['transform', 'animator', 'activation', 'material'];

export type TimelineValue = number | number[] | string;

export interface TimelineKey {
  /** Seconds from the timeline's start (0 – duration). */
  time: number;
  /** A clip's length (seconds): effect, sfx. */
  duration?: number;
  easing?: TimelineEasing;
  // camera
  camera?: string;
  release?: boolean;
  blend?: 'cut' | 'linear' | 'eased';
  blendTime?: number;
  progress?: [number, number];
  // transform
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  // animator / audio
  kind?: 'set' | 'trigger' | 'play' | 'music' | 'release' | 'stinger' | 'sfx';
  name?: string;
  value?: TimelineValue | boolean;
  fade?: number;
  layer?: number;
  asset?: string;
  volume?: number;
  loop?: boolean;
  at?: string;
  // dialogue
  dialogue?: string;
  node?: string;
  wait?: boolean;
  // effect
  effect?: string;
  params?: Record<string, number | number[] | string>;
  // activation
  active?: boolean;
  // signal
  onSkip?: 'fire' | 'drop';
  // fade
  color?: string;
  // wait
  action?: string;
  timeout?: number;
  // environment
  preset?: string;
  // mode
  mode?: string;
}

export interface TimelineTrack {
  /** Unique in the timeline. */
  trackId: string;
  type: TimelineTrackType;
  name?: string;
  /** A muted track does nothing (editing aid). */
  muted?: boolean;
  /** The bound object (a slot name): transform, animator, activation, material. */
  target?: string;
  keys: TimelineKey[];
  /** camera: what happens at the end (absent: release). */
  end?: 'release' | 'keep';
  endBlend?: 'cut' | 'linear' | 'eased';
  endBlendTime?: number;
  /** fade / letterbox: keep the last value after the timeline ends (absent: cleared). */
  hold?: boolean;
  /** audio: give the music back to the game flow when the timeline ends. */
  releaseMusic?: boolean;
  /** material: the parameter key and, optionally, the one material. */
  param?: string;
  material?: string;
}

export interface TimelineSlot {
  /** The name tracks use (`[A-Za-z_][A-Za-z0-9_]{0,31}`). */
  name: string;
  /** The default binding (an entity id); a play call may bind another. */
  entity?: string;
}

export interface TimelineMarker {
  name: string;
  time: number;
}

export interface TimelineAsset {
  timelineId: string;
  name: string;
  duration: number;
  slots?: TimelineSlot[];
  markers?: TimelineMarker[];
  tracks: TimelineTrack[];
  /** An input action that skips the timeline while it plays. */
  skipAction?: string;
  /** Plays when a run starts (default bindings). */
  playOnStart?: boolean;
  /** Plays when this signal fires (default bindings). */
  playOnSignal?: string;
}
const SLOT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const ACTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const SIGNAL_RE = /^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const ANIM_NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

const TIMELINE_KEYS = ['timelineId', 'name', 'duration', 'slots', 'markers', 'tracks', 'skipAction', 'playOnStart', 'playOnSignal'];
const TRACK_COMMON = ['trackId', 'type', 'name', 'muted', 'keys'];
const TRACK_EXTRA: Record<TimelineTrackType, readonly string[]> = {
  camera: ['end', 'endBlend', 'endBlendTime'],
  transform: ['target'],
  animator: ['target'],
  audio: ['releaseMusic'],
  dialogue: [],
  effect: [],
  activation: ['target'],
  signal: [],
  fade: ['hold'],
  letterbox: ['hold'],
  wait: [],
  material: ['target', 'param', 'material'],
  environment: [],
  mode: [],
};
const KEY_FIELDS: Record<TimelineTrackType, readonly string[]> = {
  camera: ['time', 'camera', 'release', 'blend', 'blendTime', 'progress', 'easing'],
  transform: ['time', 'position', 'rotation', 'scale', 'easing'],
  animator: ['time', 'kind', 'name', 'value', 'fade', 'layer'],
  audio: ['time', 'kind', 'asset', 'fade', 'volume', 'loop', 'duration', 'at'],
  dialogue: ['time', 'dialogue', 'node', 'wait'],
  effect: ['time', 'effect', 'duration', 'at', 'position', 'params'],
  activation: ['time', 'active'],
  signal: ['time', 'name', 'onSkip'],
  fade: ['time', 'value', 'color', 'easing'],
  letterbox: ['time', 'value', 'easing'],
  wait: ['time', 'action', 'timeout'],
  material: ['time', 'value', 'easing'],
  environment: ['time', 'preset', 'blendTime'],
  mode: ['time', 'mode', 'blend', 'blendTime'],
};

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
function only(v: Record<string, unknown>, allowed: readonly string[], path: string, errors: ModelErrorV2[], what: string): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown ${what} field "${k}" (allowed: ${allowed.join(', ')})`, k, allowed.join(', '));
}
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isName = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function num(errors: ModelErrorV2[], v: unknown, path: string, min: number, max: number, what: string, required = false): void {
  if (v === undefined) {
    if (required) err(errors, 'field_missing', path, `${what} is required`, undefined, `${min}..${max}`);
    return;
  }
  if (!isNum(v, min, max)) err(errors, 'field_value', path, `${what} is a number ${min}–${max}`, v, `${min}..${max}`);
}
function bool(errors: ModelErrorV2[], v: unknown, path: string, what: string): void {
  if (v !== undefined && typeof v !== 'boolean') err(errors, 'field_type', path, `${what} is true or false`, v, 'boolean');
}
function oneOf(errors: ModelErrorV2[], v: unknown, path: string, options: readonly string[], what: string, required = false): void {
  if (v === undefined) {
    if (required) err(errors, 'field_missing', path, `${what} is required`, undefined, options.join(' | '));
    return;
  }
  if (typeof v !== 'string' || !options.includes(v)) err(errors, 'field_value', path, `${what} is one of ${options.join(', ')}`, v, options.join(' | '));
}
function re(errors: ModelErrorV2[], v: unknown, path: string, rx: RegExp, what: string, required = false): void {
  if (v === undefined) {
    if (required) err(errors, 'field_missing', path, `${what} is required`, undefined, String(rx));
    return;
  }
  if (typeof v !== 'string' || !rx.test(v)) err(errors, 'field_value', path, `${what} does not match ${String(rx)}`, v, String(rx));
}
function vec(errors: ModelErrorV2[], v: unknown, path: string, n: number, what: string, min = -1e6, max = 1e6): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => isNum(x, min, max))) err(errors, 'field_value', path, `${what} is ${n} finite numbers`, v, `[${n} numbers]`);
}

/** A key's value for a material track: a number, 2–4 numbers or "#rrggbb". */
function materialValueOk(v: unknown): boolean {
  if (isNum(v, -1e6, 1e6)) return true;
  if (typeof v === 'string') return COLOR_RE.test(v);
  return Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => isNum(x, -1e6, 1e6));
}

function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonicalJson(v[k]);
    return out;
  }
  return Object.is(v, -0) ? 0 : v;
}

function validateKey(type: TimelineTrackType, k: unknown, path: string, duration: number, slots: ReadonlySet<string>, errors: ModelErrorV2[]): void {
  if (!isPlainObject(k)) {
    err(errors, 'field_type', path, 'a key is an object { time, … }', k, 'object');
    return;
  }
  only(k, KEY_FIELDS[type], path, errors, `${type} key`);
  num(errors, k['time'], `${path}/time`, 0, duration, 'time (within the timeline)', true);
  oneOf(errors, k['easing'], `${path}/easing`, TIMELINE_EASINGS, 'easing');
  const slot = (v: unknown, p: string, what: string, required: boolean): void => {
    if (v === undefined) {
      if (required) err(errors, 'field_missing', p, `${what} names a binding slot`, undefined, 'a slot name');
      return;
    }
    if (typeof v !== 'string' || !slots.has(v)) err(errors, 'reference_missing', p, `${what} names one of the timeline's slots (${[...slots].join(', ') || 'none declared'})`, v, 'a slot name');
  };
  switch (type) {
    case 'camera': {
      bool(errors, k['release'], `${path}/release`, 'release');
      slot(k['camera'], `${path}/camera`, 'camera', k['release'] !== true);
      if (k['release'] === true && k['camera'] !== undefined) err(errors, 'field_unexpected', `${path}/camera`, 'a release key names no camera', k['camera'], 'no camera');
      oneOf(errors, k['blend'], `${path}/blend`, ['cut', 'linear', 'eased'], 'blend');
      num(errors, k['blendTime'], `${path}/blendTime`, 0, 30, 'blendTime (seconds)');
      vec(errors, k['progress'], `${path}/progress`, 2, 'progress [from, to]', 0, 1);
      break;
    }
    case 'transform':
      vec(errors, k['position'], `${path}/position`, 3, 'position');
      vec(errors, k['rotation'], `${path}/rotation`, 4, 'rotation (a quaternion)', -1, 1);
      vec(errors, k['scale'], `${path}/scale`, 3, 'scale');
      if (k['position'] === undefined && k['rotation'] === undefined && k['scale'] === undefined) err(errors, 'field_missing', path, 'a transform key sets a position, rotation or scale', undefined, 'position | rotation | scale');
      break;
    case 'animator': {
      oneOf(errors, k['kind'], `${path}/kind`, ['set', 'trigger', 'play'], 'kind', true);
      if (typeof k['name'] !== 'string' || !ANIM_NAME_RE.test(k['name'])) err(errors, 'field_value', `${path}/name`, 'name is a parameter (set, trigger) or state (play) name, 1–64 characters', k['name'], 'a name');
      if (k['kind'] === 'set') {
        if (typeof k['value'] !== 'boolean' && !isNum(k['value'], -1e6, 1e6)) err(errors, 'field_value', `${path}/value`, 'a set key has a number or true/false value', k['value'], 'number | boolean');
      } else if (k['value'] !== undefined) err(errors, 'field_unexpected', `${path}/value`, 'only a set key has a value', k['value'], 'no value');
      if (k['kind'] !== 'play' && (k['fade'] !== undefined || k['layer'] !== undefined)) err(errors, 'field_unexpected', path, 'fade and layer belong to a play key', undefined, 'kind play');
      num(errors, k['fade'], `${path}/fade`, 0, 10, 'fade (seconds)');
      if (k['layer'] !== undefined && !(Number.isInteger(k['layer']) && isNum(k['layer'], 0, 15))) err(errors, 'field_value', `${path}/layer`, 'layer is an integer 0–15', k['layer'], '0..15');
      break;
    }
    case 'audio': {
      oneOf(errors, k['kind'], `${path}/kind`, ['music', 'release', 'stinger', 'sfx'], 'kind', true);
      const kind = k['kind'];
      if (kind === 'stinger' || kind === 'sfx') re(errors, k['asset'], `${path}/asset`, ID_RE, 'asset', true);
      else if (kind === 'music') re(errors, k['asset'], `${path}/asset`, ID_RE, 'asset (absent: silence)');
      else if (k['asset'] !== undefined) err(errors, 'field_unexpected', `${path}/asset`, 'a release key names no asset', k['asset'], 'no asset');
      num(errors, k['fade'], `${path}/fade`, 0, 60, 'fade (seconds)');
      num(errors, k['volume'], `${path}/volume`, 0, 1, 'volume');
      bool(errors, k['loop'], `${path}/loop`, 'loop');
      if (kind !== 'sfx' && (k['loop'] !== undefined || k['duration'] !== undefined || k['at'] !== undefined)) err(errors, 'field_unexpected', path, 'loop, duration and at belong to an sfx key', undefined, 'kind sfx');
      num(errors, k['duration'], `${path}/duration`, 0.001, TIMELINE_LIMITS.duration, 'duration (seconds)');
      slot(k['at'], `${path}/at`, 'at', false);
      break;
    }
    case 'dialogue':
      re(errors, k['dialogue'], `${path}/dialogue`, ID_RE, 'dialogue', true);
      if (k['node'] !== undefined && !isName(k['node'], 64)) err(errors, 'field_value', `${path}/node`, 'node is a node name, 1–64 characters', k['node'], 'a name');
      bool(errors, k['wait'], `${path}/wait`, 'wait');
      break;
    case 'effect': {
      re(errors, k['effect'], `${path}/effect`, ID_RE, 'effect', true);
      num(errors, k['duration'], `${path}/duration`, 0.001, TIMELINE_LIMITS.duration, 'duration (seconds)');
      slot(k['at'], `${path}/at`, 'at', false);
      vec(errors, k['position'], `${path}/position`, 3, 'position');
      const params = k['params'];
      if (params !== undefined) {
        if (!isPlainObject(params) || Object.keys(params).length > TIMELINE_LIMITS.params) err(errors, 'field_value', `${path}/params`, `params is an object of at most ${TIMELINE_LIMITS.params} values`, params, 'object');
        else
          for (const [pk, pv] of Object.entries(params)) {
            if (!PARAM_RE.test(pk)) err(errors, 'field_value', `${path}/params/${pk}`, 'a parameter key is an identifier', pk, 'identifier');
            if (!(isNum(pv, -1e6, 1e6) || (typeof pv === 'string' && COLOR_RE.test(pv)) || (Array.isArray(pv) && pv.length === 3 && pv.every((x) => isNum(x, -1e6, 1e6))))) err(errors, 'field_value', `${path}/params/${pk}`, 'a parameter value is a number, 3 numbers or "#rrggbb"', pv, 'number | [3] | color');
          }
      }
      break;
    }
    case 'activation':
      if (typeof k['active'] !== 'boolean') err(errors, 'field_value', `${path}/active`, 'active is true or false', k['active'], 'boolean');
      break;
    case 'signal':
      re(errors, k['name'], `${path}/name`, SIGNAL_RE, 'name', true);
      oneOf(errors, k['onSkip'], `${path}/onSkip`, ['fire', 'drop'], 'onSkip');
      break;
    case 'fade':
      num(errors, k['value'], `${path}/value`, 0, 1, 'value (opacity)', true);
      re(errors, k['color'], `${path}/color`, COLOR_RE, 'color');
      break;
    case 'letterbox':
      num(errors, k['value'], `${path}/value`, 0, 0.5, 'value (each bar, a fraction of the height)', true);
      break;
    case 'wait':
      re(errors, k['action'], `${path}/action`, ACTION_RE, 'action', true);
      num(errors, k['timeout'], `${path}/timeout`, 0.001, TIMELINE_LIMITS.duration, 'timeout (seconds)');
      break;
    case 'material':
      if (!materialValueOk(k['value'])) err(errors, 'field_value', `${path}/value`, 'value is a number, 2–4 numbers or "#rrggbb"', k['value'], 'number | [2-4] | color');
      break;
    case 'mode':
      re(errors, k['mode'], `${path}/mode`, ID_RE, 'mode', true);
      oneOf(errors, k['blend'], `${path}/blend`, ['cut', 'linear', 'eased'], 'blend');
      num(errors, k['blendTime'], `${path}/blendTime`, 0, 30, 'blendTime (seconds)');
      break;
    case 'environment':
      re(errors, k['preset'], `${path}/preset`, ID_RE, 'preset', true);
      num(errors, k['blendTime'], `${path}/blendTime`, 0, 60, 'blendTime (seconds)');
      break;
  }
}

/** One timeline (its own rules; project references: `validateTimelineReferences`). */
export function validateTimeline(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a timeline is an object { timelineId, name, duration, tracks, … }', value, 'object');
    return;
  }
  only(value, TIMELINE_KEYS, path, errors, 'timeline');
  re(errors, value['timelineId'], `${path}/timelineId`, ID_RE, 'timelineId', true);
  if (!isName(value['name'], TIMELINE_LIMITS.nameChars)) err(errors, 'field_value', `${path}/name`, `a timeline name has 1-${TIMELINE_LIMITS.nameChars} characters`, value['name'], 'a name');
  num(errors, value['duration'], `${path}/duration`, 0.001, TIMELINE_LIMITS.duration, 'duration (seconds)', true);
  const duration = isNum(value['duration'], 0.001, TIMELINE_LIMITS.duration) ? value['duration'] : TIMELINE_LIMITS.duration;
  re(errors, value['skipAction'], `${path}/skipAction`, ACTION_RE, 'skipAction');
  bool(errors, value['playOnStart'], `${path}/playOnStart`, 'playOnStart');
  re(errors, value['playOnSignal'], `${path}/playOnSignal`, SIGNAL_RE, 'playOnSignal');
  const slots = new Set<string>();
  const rawSlots = value['slots'];
  if (rawSlots !== undefined) {
    if (!Array.isArray(rawSlots) || rawSlots.length > TIMELINE_LIMITS.slots) err(errors, 'limits_exceeded', `${path}/slots`, `slots is an array of at most ${TIMELINE_LIMITS.slots}`, Array.isArray(rawSlots) ? rawSlots.length : rawSlots, `≤ ${TIMELINE_LIMITS.slots}`);
    else
      rawSlots.forEach((s, i) => {
        const p = `${path}/slots/${i}`;
        if (!isPlainObject(s)) return err(errors, 'field_type', p, 'a slot is { name, entity? }', s, 'object');
        only(s, ['name', 'entity'], p, errors, 'slot');
        re(errors, s['name'], `${p}/name`, SLOT_RE, 'name', true);
        re(errors, s['entity'], `${p}/entity`, ID_RE, 'entity');
        if (typeof s['name'] === 'string') {
          if (slots.has(s['name'])) err(errors, 'id_duplicate', `${p}/name`, 'slot names are unique', s['name'], 'a unique name');
          slots.add(s['name']);
        }
      });
  }
  const markers = value['markers'];
  if (markers !== undefined) {
    if (!Array.isArray(markers) || markers.length > TIMELINE_LIMITS.markers) err(errors, 'limits_exceeded', `${path}/markers`, `markers is an array of at most ${TIMELINE_LIMITS.markers}`, Array.isArray(markers) ? markers.length : markers, `≤ ${TIMELINE_LIMITS.markers}`);
    else
      markers.forEach((m, i) => {
        const p = `${path}/markers/${i}`;
        if (!isPlainObject(m)) return err(errors, 'field_type', p, 'a marker is { name, time }', m, 'object');
        only(m, ['name', 'time'], p, errors, 'marker');
        re(errors, m['name'], `${p}/name`, SIGNAL_RE, 'name', true);
        num(errors, m['time'], `${p}/time`, 0, duration, 'time (within the timeline)', true);
      });
  }
  const tracks = value['tracks'];
  if (!Array.isArray(tracks)) {
    err(errors, 'field_type', `${path}/tracks`, 'tracks is an array', tracks, 'array');
    return;
  }
  if (tracks.length > TIMELINE_LIMITS.tracks) err(errors, 'limits_exceeded', `${path}/tracks`, `at most ${TIMELINE_LIMITS.tracks} tracks`, tracks.length, `≤ ${TIMELINE_LIMITS.tracks}`);
  const trackIds = new Set<string>();
  tracks.forEach((t, i) => {
    const p = `${path}/tracks/${i}`;
    if (!isPlainObject(t)) return err(errors, 'field_type', p, 'a track is { trackId, type, keys, … }', t, 'object');
    oneOf(errors, t['type'], `${p}/type`, TIMELINE_TRACK_TYPES, 'type', true);
    if (typeof t['type'] !== 'string' || !(TIMELINE_TRACK_TYPES as readonly string[]).includes(t['type'])) return;
    const type = t['type'] as TimelineTrackType;
    only(t, [...TRACK_COMMON, ...TRACK_EXTRA[type]], p, errors, `${type} track`);
    re(errors, t['trackId'], `${p}/trackId`, ID_RE, 'trackId', true);
    if (typeof t['trackId'] === 'string') {
      if (trackIds.has(t['trackId'])) err(errors, 'id_duplicate', `${p}/trackId`, 'track ids are unique in a timeline', t['trackId'], 'a unique id');
      trackIds.add(t['trackId']);
    }
    if (t['name'] !== undefined && !isName(t['name'], TIMELINE_LIMITS.nameChars)) err(errors, 'field_value', `${p}/name`, `a track name has 1-${TIMELINE_LIMITS.nameChars} characters`, t['name'], 'a name');
    bool(errors, t['muted'], `${p}/muted`, 'muted');
    if (TIMELINE_TARGET_TRACKS.includes(type)) {
      if (typeof t['target'] !== 'string' || !slots.has(t['target'])) err(errors, 'reference_missing', `${p}/target`, `a ${type} track's target names one of the timeline's slots`, t['target'], 'a slot name');
    }
    if (type === 'camera') {
      oneOf(errors, t['end'], `${p}/end`, ['release', 'keep'], 'end');
      oneOf(errors, t['endBlend'], `${p}/endBlend`, ['cut', 'linear', 'eased'], 'endBlend');
      num(errors, t['endBlendTime'], `${p}/endBlendTime`, 0, 30, 'endBlendTime (seconds)');
    }
    if (type === 'fade' || type === 'letterbox') bool(errors, t['hold'], `${p}/hold`, 'hold');
    if (type === 'audio') bool(errors, t['releaseMusic'], `${p}/releaseMusic`, 'releaseMusic');
    if (type === 'material') {
      re(errors, t['param'], `${p}/param`, PARAM_RE, 'param', true);
      re(errors, t['material'], `${p}/material`, ID_RE, 'material');
    }
    const keys = t['keys'];
    if (!Array.isArray(keys)) return err(errors, 'field_type', `${p}/keys`, 'keys is an array', keys, 'array');
    if (keys.length > TIMELINE_LIMITS.keys) err(errors, 'limits_exceeded', `${p}/keys`, `at most ${TIMELINE_LIMITS.keys} keys per track`, keys.length, `≤ ${TIMELINE_LIMITS.keys}`);
    keys.forEach((k, j) => validateKey(type, k, `${p}/keys/${j}`, duration, slots, errors));
    if (type === 'material' && keys.length > 1) {
      // Every key of one parameter has the same shape (a number, the same vector length, or colours).
      const shape = (v: unknown): string => (typeof v === 'number' ? 'n' : typeof v === 'string' ? 'c' : Array.isArray(v) ? `v${v.length}` : '?');
      const first = shape((keys[0] as Record<string, unknown> | undefined)?.['value']);
      keys.forEach((k, j) => {
        if (isPlainObject(k) && shape(k['value']) !== first) err(errors, 'field_value', `${p}/keys/${j}/value`, 'every key of a material track has the same kind of value', k['value'], 'the first key\'s kind');
      });
    }
  });
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(canonicalJson(value))).length;
  } catch {
    bytes = 0;
  }
  if (bytes > TIMELINE_LIMITS.bytes) err(errors, 'limits_exceeded', path, `a timeline has at most ${TIMELINE_LIMITS.bytes} bytes of JSON`, bytes, `≤ ${TIMELINE_LIMITS.bytes}`);
}

/** `content.timelines` (each timeline's rules, unique ids, the count limit). */
export function validateTimelines(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) {
    err(errors, 'field_type', path, 'timelines is an array', value, 'array');
    return;
  }
  if (value.length > TIMELINE_LIMITS.timelines) err(errors, 'limits_exceeded', path, `at most ${TIMELINE_LIMITS.timelines} timelines`, value.length, `≤ ${TIMELINE_LIMITS.timelines}`);
  const ids = new Set<string>();
  value.forEach((t, i) => {
    validateTimeline(t, `${path}/${i}`, errors);
    const id = isPlainObject(t) ? t['timelineId'] : undefined;
    if (typeof id === 'string') {
      if (ids.has(id)) err(errors, 'id_duplicate', `${path}/${i}/timelineId`, 'timelineId is already used by an earlier timeline', id, 'a unique id');
      ids.add(id);
    }
  });
}

/** What the timelines name outside themselves (assets, effects, materials, dialogues, presets). */
export function timelineRefs(list: readonly TimelineAsset[] | undefined): { assets: string[]; effects: string[]; materials: string[]; dialogues: string[]; presets: string[] } {
  const assets = new Set<string>();
  const effects = new Set<string>();
  const materials = new Set<string>();
  const dialogues = new Set<string>();
  const presets = new Set<string>();
  for (const tl of list ?? []) {
    for (const t of tl.tracks) {
      if (t.type === 'material' && t.material !== undefined) materials.add(t.material);
      for (const k of t.keys) {
        if (t.type === 'audio' && k.asset !== undefined) assets.add(k.asset);
        if (t.type === 'effect' && k.effect !== undefined) effects.add(k.effect);
        if (t.type === 'dialogue' && k.dialogue !== undefined) dialogues.add(k.dialogue);
        if (t.type === 'environment' && k.preset !== undefined) presets.add(k.preset);
      }
    }
  }
  const sorted = (s: Set<string>): string[] => [...s].sort();
  return { assets: sorted(assets), effects: sorted(effects), materials: sorted(materials), dialogues: sorted(dialogues), presets: sorted(presets) };
}

/**
 * The timelines' references against the project: audio keys name an audio or
 * music asset, effect keys an effect, material tracks a material. Dialogue
 * and environment-preset ids are checked when the project holds those
 * collections — `dialogueIds` / `presetIds` null skip it.
 */
export function validateTimelineReferences(
  list: readonly TimelineAsset[],
  path: string,
  errors: ModelErrorV2[],
  ctx: { assetKind: (id: string) => unknown; effectIds: ReadonlySet<string>; materialIds: ReadonlySet<string>; modeIds?: ReadonlySet<string>; dialogueIds?: ReadonlySet<string> | null; presetIds?: ReadonlySet<string> | null },
): void {
  list.forEach((tl, i) => {
    tl.tracks.forEach((t, j) => {
      const p = `${path}/${i}/tracks/${j}`;
      if (t.type === 'material' && t.material !== undefined && !ctx.materialIds.has(t.material)) err(errors, 'reference_missing', `${p}/material`, 'material names a project material', t.material, 'a materialId');
      t.keys.forEach((k, n) => {
        const kp = `${p}/keys/${n}`;
        if (t.type === 'audio' && k.asset !== undefined) {
          const kind = ctx.assetKind(k.asset);
          if (kind !== 'audio' && kind !== 'music') err(errors, 'reference_missing', `${kp}/asset`, 'asset names an audio or music asset', k.asset, 'an audio/music assetId');
        }
        if (t.type === 'effect' && k.effect !== undefined && !ctx.effectIds.has(k.effect)) err(errors, 'reference_missing', `${kp}/effect`, 'effect names a project effect', k.effect, 'an effectId');
        if (t.type === 'dialogue' && k.dialogue !== undefined && ctx.dialogueIds != null && !ctx.dialogueIds.has(k.dialogue)) err(errors, 'reference_missing', `${kp}/dialogue`, 'dialogue names a project dialogue', k.dialogue, 'a dialogue id');
        if (t.type === 'mode' && k.mode !== undefined && !(ctx.modeIds?.has(k.mode) ?? false)) err(errors, 'reference_missing', `${kp}/mode`, 'mode names a game mode of the project (content.modes)', k.mode, 'a modeId');
        if (t.type === 'environment' && k.preset !== undefined && ctx.presetIds != null && !ctx.presetIds.has(k.preset)) err(errors, 'reference_missing', `${kp}/preset`, 'preset names a project environment preset', k.preset, 'a preset id');
      });
    });
  });
}

/** The canonical timeline: keys sorted by name, each track's keys by time (stable), no undefined fields, no negative zero. */
export function canonicalTimeline(t: TimelineAsset): TimelineAsset {
  const c = canonicalJson(t) as TimelineAsset;
  for (const tr of c.tracks) tr.keys = tr.keys.map((k, i) => ({ k, i })).sort((a, b) => a.k.time - b.k.time || a.i - b.i).map((x) => x.k);
  if (c.markers !== undefined) c.markers = c.markers.map((m, i) => ({ m, i })).sort((a, b) => a.m.time - b.m.time || a.i - b.i).map((x) => x.m);
  return c;
}

export function canonicalTimelines(list: readonly TimelineAsset[]): TimelineAsset[] {
  return [...list].map(canonicalTimeline).sort((a, b) => (a.timelineId < b.timelineId ? -1 : a.timelineId > b.timelineId ? 1 : 0));
}
