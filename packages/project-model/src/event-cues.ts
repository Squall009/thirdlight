/**
 * The event → cue table (`content.eventCues`, v4): project data
 * that maps named things happening in the simulation to sounds the host
 * plays — the generic form of fixed cue slots.
 *
 * Each row names what it listens to:
 * - `on: "signal"`: a signal by name (any name a trigger, switch,
 *   collectible or script sends);
 * - `on: "event"`: an event scripts see in `ctx.events`, by its type or name
 *   — a trigger's `enter`/`exit`, the primitives' `collected`, `restored`,
 *   `damaged`, `healed`, `died`, `turned`, `contact`, `separate`, or an
 *   animator clip event's name — optionally only an object's (`entity`).
 *
 * and plays `assetId` (an audio asset) at `volume` on a bus (absent: sfx);
 * `maxLateMs` bounds how late it may still start when its file is not ready
 * yet (absent: the engine's default).
 * The table never changes what the simulation does: the sound is played
 * through the audio intent log like a script's `ctx.audio.play`.
 */
import { AUDIO_MAX_LATE_MS_LIMIT } from './content-limits';
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';

export const EVENT_CUE_SOURCES = ['signal', 'event'] as const;
export const EVENT_CUE_BUSES = ['sfx', 'music', 'voice', 'ui'] as const;

/** Engine limits: the name length (a signal name's). The table has as many rows as the game needs. */
export const EVENT_CUE_LIMITS = Object.freeze({ name: 64 });

/** The engine event types a row may listen to without a clip event name (the documented `ctx.events` types). */
export const ENGINE_EVENT_TYPES = ['enter', 'exit', 'collected', 'restored', 'damaged', 'healed', 'died', 'turned', 'contact', 'separate'] as const;

export interface EventCue {
  on: (typeof EVENT_CUE_SOURCES)[number];
  /** The signal's name, or the event's type (or an animator clip event's name). */
  name: string;
  /** Only this object's events (`on: "event"`; absent: any object's). */
  entity?: string;
  /** The audio asset played. */
  assetId: string;
  /** 0–1 (absent: 1). */
  volume?: number;
  /** The mixer bus (absent: sfx). */
  bus?: (typeof EVENT_CUE_BUSES)[number];
  /** How late (ms) it may still start when its file is not ready yet; later it is dropped (absent: the engine's default). */
  maxLateMs?: number;
}

export const EVENT_CUE_FIELDS = ['on', 'name', 'entity', 'assetId', 'volume', 'bus', 'maxLateMs'] as const;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/;
const ENTITY_RE = ID_RE;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}

export function validateEventCue(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'an event cue is an object { on, name, assetId, entity?, volume?, bus?, maxLateMs? }', v);
  for (const k of Object.keys(v)) if (!(EVENT_CUE_FIELDS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, EVENT_CUE_FIELDS.join(', '));
  for (const k of ['on', 'name', 'assetId'] as const) if (v[k] === undefined) err(errors, 'field_missing', `${path}/${k}`, `"${k}" is required`, undefined, k);
  if (v['on'] !== undefined && !(EVENT_CUE_SOURCES as readonly unknown[]).includes(v['on'])) err(errors, 'field_value', `${path}/on`, 'on is signal or event', v['on']);
  if (v['name'] !== undefined && (typeof v['name'] !== 'string' || !NAME_RE.test(v['name']))) err(errors, 'field_value', `${path}/name`, 'name is a signal or event name (a letter or _, then letters, digits, _ : . or -; at most 64)', v['name']);
  if (v['entity'] !== undefined) {
    if (v['on'] !== 'event') err(errors, 'field_unexpected', `${path}/entity`, 'only an event row names an object (a signal has no object)', v['entity']);
    else if (typeof v['entity'] !== 'string' || !ENTITY_RE.test(v['entity'])) err(errors, 'field_value', `${path}/entity`, 'entity names an object (an entity id)', v['entity']);
  }
  if (v['assetId'] !== undefined && (typeof v['assetId'] !== 'string' || v['assetId'].length === 0 || v['assetId'].length > 128)) err(errors, 'field_value', `${path}/assetId`, 'assetId names an audio asset', v['assetId']);
  if (v['volume'] !== undefined && !(typeof v['volume'] === 'number' && Number.isFinite(v['volume']) && v['volume'] >= 0 && v['volume'] <= 1)) err(errors, 'field_value', `${path}/volume`, 'volume is 0–1', v['volume']);
  if (v['maxLateMs'] !== undefined && !(typeof v['maxLateMs'] === 'number' && Number.isInteger(v['maxLateMs']) && v['maxLateMs'] >= 0 && v['maxLateMs'] <= AUDIO_MAX_LATE_MS_LIMIT)) err(errors, 'field_value', `${path}/maxLateMs`, `maxLateMs is a whole number of milliseconds 0–${AUDIO_MAX_LATE_MS_LIMIT}`, v['maxLateMs']);
  if (v['bus'] !== undefined && !(EVENT_CUE_BUSES as readonly unknown[]).includes(v['bus'])) err(errors, 'field_value', `${path}/bus`, 'bus is sfx, music, voice or ui', v['bus']);
}

/** `content.eventCues`: the whole table. */
export function validateEventCues(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(v)) return err(errors, 'field_type', path, 'eventCues is a list', v, 'array');
  v.forEach((c, i) => validateEventCue(c, `${path}/${i}`, errors));
}

/** Every row's sound is an audio asset of the project. */
export function validateEventCueReferences(content: Record<string, unknown>, errors: ModelErrorV2[], kindOf: (assetId: string) => unknown): void {
  const cues = content['eventCues'];
  if (!Array.isArray(cues)) return;
  cues.forEach((c, i) => {
    if (!isPlainObject(c) || typeof c['assetId'] !== 'string') return;
    if (kindOf(c['assetId']) !== 'audio') err(errors, 'asset_reference_missing', `/eventCues/${i}/assetId`, 'an event cue plays an audio asset of this project', c['assetId'], 'an audio assetId');
  });
}

export const canonicalEventCue = (c: EventCue): EventCue => ({
  on: c.on,
  name: c.name,
  ...(c.entity !== undefined ? { entity: c.entity } : {}),
  assetId: c.assetId,
  ...(c.volume !== undefined ? { volume: c.volume } : {}),
  ...(c.bus !== undefined ? { bus: c.bus } : {}),
  ...(c.maxLateMs !== undefined ? { maxLateMs: c.maxLateMs } : {}),
});

export const canonicalEventCues = (list: readonly EventCue[]): EventCue[] => list.map(canonicalEventCue);
