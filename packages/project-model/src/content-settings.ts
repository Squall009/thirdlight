/**
 * The project settings registry: every settings key with its type, default,
 * bounds and editor labels, the resolvers hosts read, and settings validation.
 */

import {
  fieldType,
  fieldValue,
  isPlainObject,
  pointerSegment,
  withFound,
} from './validate';
import type { ModelErrorV2 } from './errors';
import type { SettingsMap } from './types-v2';
import { PROPERTY_KEY_RE } from './components';
import { AUDIO_VOICE_CAP, AUDIO_VOICES_DEFAULT, MAX_SETTINGS_KEYS } from './content-limits';
import { limitsError, sortedKeys } from './content-helpers';

// ---- settings registry (§20.9/§21.4) ------------------------------------------

export interface SettingsKeySpec {
  key: string;
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  minExclusive?: boolean;
  maxExclusive?: boolean;
  unit: string;
  /** Phase 15.3: whole numbers only. */
  integer?: boolean;
  /** Phase 15.3: exactly one of these values. */
  values?: readonly number[];
  /** Phase 17.1: display text for each of `values` (same order), e.g. a backend name. */
  valueLabels?: readonly string[];
  /**
   * Phase 17.4: values an older project may hold that stay valid (the engine
   * reads them as documented next to the setting) but are no longer offered.
   */
  legacyValues?: readonly number[];
  /**
   * Phase 15.3: an engine setting resolved only when the project sets it
   * (absent: the engine uses `default`), so a project that never sets it
   * keeps its exact resolved settings, manifest and digests.
   */
  optional?: boolean;
  /** Phase 15.3: display text and Inspector group. */
  label?: string;
  tooltip?: string;
  group?: string;
}

/** The six-key M2 gameplay settings registry (§21.4; the fixed M2 table). */
export const M2_SETTINGS_KEYS: readonly SettingsKeySpec[] = [
  // Phase 15.5 reasons (these six are always resolved into the manifest, so they
  // stay the recorded contract values): gravity 2 g — the snappy fall most action
  // games use (1 g feels floaty); a 4 m/s run — an adult's jog; a 7 m/s jump —
  // 1.25 m high at 2 g, clearing obstacles up to chest height of the default
  // 1.8 m character; falls capped at 30 m/s (keeps landings catchable); climbs
  // slopes up to 45° (a steep ramp or hillside), slides on slopes from 30°.
  { key: 'gravity_y', type: 'number', default: -19.62, min: -100, max: -1, unit: 'm/s^2' },
  { key: 'run_speed', type: 'number', default: 4, min: 0, minExclusive: true, max: 50, unit: 'm/s' },
  { key: 'jump_velocity', type: 'number', default: 7, min: 0, max: 50, unit: 'm/s' },
  { key: 'max_fall_speed', type: 'number', default: -30, min: -100, max: 0, maxExclusive: true, unit: 'm/s' },
  { key: 'max_slope_climb_deg', type: 'number', default: 45, min: 0, max: 89.9, unit: 'degrees' },
  { key: 'min_slope_slide_deg', type: 'number', default: 30, min: 0, max: 89.9, unit: 'degrees' },
  // Phase 15.3: engine settings (optional: resolved only when set). Defaults
  // are the values every project ran with before they became data.
  // 120 Hz: two simulation steps per 60 Hz display frame (smooth on common
  // displays, cheap for any 2D scene); 60 halves the cost, 240 halves the
  // step for fast motion.
  { key: 'fixed_step_hz', type: 'number', default: 120, values: [60, 120, 240], integer: true, unit: 'Hz', optional: true, group: 'Engine', label: 'Fixed step', tooltip: 'Simulation steps per second (60, 120 or 240). Timings in seconds keep their length; replays are recorded at one rate.' },
  { key: 'audio_voices', type: 'number', default: AUDIO_VOICES_DEFAULT, min: 1, max: AUDIO_VOICE_CAP, integer: true, unit: 'voices', optional: true, group: 'Audio', label: 'Sound voices', tooltip: `How many sound effects play at once (a new one is dropped while all are busy; at most ${AUDIO_VOICE_CAP}).` },
  // 1 s: a gentle crossfade between two music tracks.
  { key: 'music_fade_s', type: 'number', default: 1, min: 0, max: 10, unit: 's', optional: true, group: 'Audio', label: 'Music fade', tooltip: 'Seconds a music change crossfades (0: cut).' },
  // 0.2 s: a quick blend between two animation roles (idle, run, airborne).
  { key: 'animation_crossfade_s', type: 'number', default: 0.2, min: 0, max: 2, unit: 's', optional: true, group: 'Animation', label: 'Animation blend', tooltip: 'Seconds a model blends between its idle, run and airborne animations (animator transitions set their own).' },
  // Phase 17.1: the renderer backend of Play, the export and the Scene view
  // (three-adapter RENDER_BACKEND_SETTING_VALUES). Phase 17.4: 1, auto — WebGPU
  // where the browser can start it, else WebGL 2: every browser with WebGL 2
  // draws and the faster API is used where it exists. 0 was the archived WebGL
  // renderer ("legacy"): still valid in an older project, read as auto.
  { key: 'render_backend', type: 'number', default: 1, values: [1, 2, 3], legacyValues: [0], valueLabels: ['Auto (WebGPU, else WebGL 2)', 'WebGPU', 'WebGL 2'], integer: true, unit: '', optional: true, group: 'Rendering', label: 'Renderer', tooltip: 'Which backend draws the game and the Scene view: WebGPU where the browser has it (else WebGL 2), WebGPU, or WebGL 2. WebGPU needs https or localhost. A page URL flag ?renderer=auto|webgpu|webgl2 overrides it.' },
  // Phase 22.0: where the game's simulation runs (game-host SIM_THREAD_SETTING_VALUES).
  // 1, a worker: runtime, physics and scripts run off the page's main thread, so
  // a long step never delays a frame or an input event — every genre gains and
  // none needs the page thread; the page falls back to it where the browser
  // cannot start a worker. Results are the same either way (determinism).
  // Phase 23.0: the simulation's dimension. 2, the 2D plane: every project
  // made before 3D physics existed plays on it exactly as before (its own
  // Rapier 2D backend); 3 runs the game on the 3D backend (Vec3 positions,
  // full rotations, colliders with depth) — a choice of the game, not a
  // default fitted to any genre, so the neutral default keeps existing data valid.
  { key: 'physics_dimension', type: 'number', default: 2, values: [2, 3], valueLabels: ['2D plane', '3D'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Physics', tooltip: 'The simulation\'s dimension: a 2D plane (movement and collision in X and Y, colliders rotate about Z) or full 3D (colliders with depth and any rotation). A 3D project needs every box collider to have a depth.' },
  { key: 'sim_thread', type: 'number', default: 1, values: [1, 2], valueLabels: ['Worker (off the main thread)', 'Main thread'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Simulation thread', tooltip: 'Where the game simulation (physics, gameplay, scripts) runs in Play and the export: a worker (the page thread only draws and reads input) or the page\'s main thread. Results are identical. A page URL flag ?threads=off|on overrides it.' },
  // Phase 23.7: the seed of the scripts' ctx.random (every stream mixes it with the
  // script, object and stream name). 0: any fixed value keeps runs and replays
  // repeatable; a game changes it to reshuffle every random choice at once.
  // Phase 23.8: the in-game debug console in an exported game (Play always has
  // it). 0, off: a release build must never ship a console by accident; a
  // test or playtest build turns it on.
  { key: 'debug_console', type: 'number', default: 0, values: [0, 1], valueLabels: ['Off', 'On'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Debug console in export', tooltip: 'Whether an exported game has the debug console (the ` key: the project\'s debug commands). Play always has it. Leave it off for a release build.' },
  { key: 'random_seed', type: 'number', default: 0, min: 0, max: 4294967295, integer: true, unit: '', optional: true, group: 'Engine', label: 'Random seed', tooltip: 'The seed of the scripts\' random numbers (ctx.random): the same seed gives the same numbers in every run, replay and export; change it to get a different, still repeatable, sequence (0 to 4294967295).' },
  // Phase 23.4: the depth buffer's precision (three-adapter DEPTH_BUFFER_SETTING_VALUES).
  // 1, standard: what every project drew with before; a level of any genre at
  // the usual near/far planes needs nothing else. Logarithmic or reversed-Z keep
  // near geometry sharp while far vistas (kilometres out) still sort — a
  // choice of the game (they cost a little: logarithmic writes depth per pixel,
  // reversed-Z needs WebGPU or WebGL 2's EXT_clip_control and falls back to
  // standard without it).
  { key: 'depth_buffer', type: 'number', default: 1, values: [1, 2, 3], valueLabels: ['Standard', 'Logarithmic (far vistas)', 'Reversed Z (far vistas)'], integer: true, unit: '', optional: true, group: 'Rendering', label: 'Depth precision', tooltip: 'How depth is stored: standard, logarithmic or reversed Z. The last two keep close objects sharp while scenery kilometres away still draws in the right order (pair with a large camera far plane). Reversed Z needs WebGPU or a WebGL 2 browser with EXT_clip_control (else standard).' },
  // Phase 23.13: how audio sources are heard. 0, automatic: a 2D-plane project
  // keeps the phase 9.10 model (louder as the player comes near along X, no
  // panning) so every existing project sounds exactly as before; a 3D project
  // gets a panner per source with the listener on the active camera. 1 and 2
  // force one or the other (a 2D game may want stereo panning).
  // Phase 25.7d: the size (m) of an instance set's spatial chunks, each culled and
  // given its level of detail on its own (a set's own chunkSize overrides it).
  // 32 m: a few seconds' walk for the default 1.8 m character and small next
  // to a usual view distance, so chunks out of view are culled and a chunk's
  // level of detail (picked at its centre) is off by at most ~23 m (three-adapter
  // INSTANCE_CHUNK_METERS, the same value).
  { key: 'instance_chunk_m', type: 'number', default: 32, min: 1, max: 4096, unit: 'm', optional: true, group: 'Rendering', label: 'Instance chunk size', tooltip: 'Instance sets are drawn in square chunks of about this size (m), each hidden when out of view and given its level of detail on its own. Smaller: finer culling and LOD, more draw calls. A set can set its own.' },
  { key: 'audio_spatial', type: 'number', default: 0, values: [0, 1, 2], valueLabels: ['Automatic (2D: by distance to the player, 3D: panned)', 'By distance to the player (X)', 'Panned (listener on the camera)'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Audio sources', tooltip: 'How audio sources are heard: by their X distance to the player (the 2D default, no panning) or through a panner with the listener on the active camera (the 3D default: left/right panning and each source\'s distance model). Script sounds with a position are always panned.' },
];

/** Phase 23.0: the simulation's dimension (the `physics_dimension` setting's values). */
export type PhysicsDimension = 2 | 3;
export const PHYSICS_DIMENSIONS: readonly PhysicsDimension[] = [2, 3];

/**
 * Phase 23.0: the physics dimension a settings map resolves to — 3 only when
 * the project sets `physics_dimension` to 3, else 2 (the 2D plane every
 * project had before the setting existed).
 */
/** Phase 23.4: the depth buffer the renderer uses (the `depth_buffer` setting; absent or unknown: standard). */
export function depthBufferOf(settings: unknown): 'standard' | 'logarithmic' | 'reversed' {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['depth_buffer'] : undefined;
  return v === 2 ? 'logarithmic' : v === 3 ? 'reversed' : 'standard';
}

/**
 * Phase 23.13: how audio sources are heard (the `audio_spatial` setting):
 * 'legacy' (the X distance to the player) or 'panner' (a panner per source,
 * the listener on the active camera). Absent or 0: panner in 3D, legacy on
 * the 2D plane.
 */
export function audioSpatialOf(settings: unknown): 'legacy' | 'panner' {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['audio_spatial'] : undefined;
  if (v === 1) return 'legacy';
  if (v === 2) return 'panner';
  return physicsDimensionOf(settings) === 3 ? 'panner' : 'legacy';
}

/** Phase 25.7d: the project's instance-set chunk size (m) when it sets `instance_chunk_m`, else undefined (the engine default, 32 m). */
export function instanceChunkSizeOf(settings: unknown): number | undefined {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['instance_chunk_m'] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function physicsDimensionOf(settings: unknown): PhysicsDimension {
  return typeof settings === 'object' && settings !== null && (settings as Record<string, unknown>)['physics_dimension'] === 3 ? 3 : 2;
}

const SETTINGS_BY_KEY = new Map(M2_SETTINGS_KEYS.map((s) => [s.key, s]));

function settingsValueError(path: string, spec: SettingsKeySpec, found: unknown): ModelErrorV2 {
  return withFound(
    {
      code: 'field_value',
      path,
      message: `setting "${spec.key}" must be a number within its declared range`,
      expected: spec.values !== undefined ? `one of ${spec.values.join(', ')}` : `${spec.integer === true ? 'integer' : spec.type} within the ${spec.key} range`,
    },
    found,
  );
}

export function validateSettings(settings: unknown, path: string, errors: ModelErrorV2[], registry = SETTINGS_BY_KEY): void {
  if (!isPlainObject(settings)) {
    errors.push(fieldType(path, settings, 'object'));
    return;
  }
  const keys = Object.keys(settings);
  if (keys.length > MAX_SETTINGS_KEYS) {
    errors.push(limitsError(path, 'settings_keys', keys.length, MAX_SETTINGS_KEYS, `content.settings may declare at most ${MAX_SETTINGS_KEYS} keys`));
  }
  for (const key of keys) {
    if (!PROPERTY_KEY_RE.test(key)) {
      errors.push(fieldValue(`${path}/${pointerSegment(key)}`, key, '^[a-z][a-z0-9_]{0,63}$', 'setting keys must match the declared key syntax'));
      continue;
    }
    const spec = registry.get(key);
    if (!spec) {
      errors.push(withFound({ code: 'setting_unknown', path: `${path}/${pointerSegment(key)}`, message: `setting "${key}" is not in the M2 settings registry`, expected: `one of: ${[...registry.keys()].join(', ')}` }, key));
      continue;
    }
    const value = settings[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(settingsValueError(`${path}/${pointerSegment(key)}`, spec, value));
      continue;
    }
    if (spec.min !== undefined && (spec.minExclusive ? value <= spec.min : value < spec.min)) {
      errors.push(settingsValueError(`${path}/${pointerSegment(key)}`, spec, value));
    } else if (spec.max !== undefined && (spec.maxExclusive ? value >= spec.max : value > spec.max)) {
      errors.push(settingsValueError(`${path}/${pointerSegment(key)}`, spec, value));
    } else if ((spec.integer === true && !Number.isInteger(value)) || (spec.values !== undefined && !spec.values.includes(value) && spec.legacyValues?.includes(value) !== true)) {
      errors.push(settingsValueError(`${path}/${pointerSegment(key)}`, spec, value));
    }
  }
  const climb = settings['max_slope_climb_deg'];
  const slide = settings['min_slope_slide_deg'];
  if (typeof climb === 'number' && typeof slide === 'number' && slide > climb) {
    errors.push(
      fieldValue(
        `${path}/min_slope_slide_deg`,
        slide,
        'min_slope_slide_deg <= max_slope_climb_deg',
        'min_slope_slide_deg must not exceed max_slope_climb_deg',
      ),
    );
  }
}

export function canonicalSettings(s: SettingsMap): SettingsMap {
  const out: SettingsMap = {};
  for (const k of sortedKeys(s as unknown as Record<string, unknown>)) {
    out[k] = (s as Record<string, SettingsMap[string]>)[k] as SettingsMap[string];
  }
  return out;
}