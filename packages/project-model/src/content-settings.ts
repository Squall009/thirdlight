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
import { TEXTURE_BUDGET_DEFAULT_MB, TEXTURE_BUDGET_MAX_MB, TEXTURE_BUDGET_MIN_MB } from './texture-streaming';
import { LOD_BIAS_DEFAULT, LOD_BIAS_MAX, LOD_BIAS_MIN, LOD_HYSTERESIS_DEFAULT, LOD_HYSTERESIS_MAX } from './model-lod';
import { VIEW_LENS_DEFAULTS, VIRTUAL_CAMERA_LIMITS } from './cameras';
import { FRAME_RATE_CAPS } from './frame-rate-cap';
import { AMBIENT_OCCLUSION_DEFAULT, AMBIENT_OCCLUSION_NEW_PROJECT, AMBIENT_OCCLUSION_SETTING_VALUES, ambientOcclusionSettingValue, RENDER_SCALE_DEFAULT, RENDER_SCALE_MAX, RENDER_SCALE_MIN } from './render-settings';

// ---- settings registry ------------------------------------------


/**
 * The simulation's step rate when a project sets none (`fixed_step_hz`), and
 * the rates it may choose. 120 Hz: two steps per 60 Hz display frame (smooth
 * on common displays, cheap for any 2D scene); 60 halves the cost, 240 halves
 * the step for fast motion. The runtime, the physics ports, the game page,
 * the worker and the exporter all read these.
 */
export const DEFAULT_FIXED_STEP_HZ = 120;
export const FIXED_STEP_HZ_CHOICES: readonly number[] = Object.freeze([60, 120, 240]);

/** A project's step rate: its `fixed_step_hz`, else the default. */
export function fixedStepHzOf(settings: { readonly fixed_step_hz?: number } | undefined): number {
  return settings?.fixed_step_hz ?? DEFAULT_FIXED_STEP_HZ;
}

export interface SettingsKeySpec {
  key: string;
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  minExclusive?: boolean;
  maxExclusive?: boolean;
  unit: string;
  /** Whole numbers only. */
  integer?: boolean;
  /** Exactly one of these values. */
  values?: readonly number[];
  /** Display text for each of `values` (same order), e.g. a backend name. */
  valueLabels?: readonly string[];
  /**
   * Values an older project may hold that stay valid (the engine
   * reads them as documented next to the setting) but are no longer offered.
   */
  legacyValues?: readonly number[];
  /**
   * An engine setting resolved only when the project sets it
   * (absent: the engine uses `default`), so a project that never sets it
   * keeps its exact resolved settings, manifest and digests.
   */
  optional?: boolean;
  /** Display text and Inspector group. */
  label?: string;
  tooltip?: string;
  group?: string;
}

/**
 * The settings group that draws the game (renderer, depth, instance chunks,
 * texture budget): the editor shows it with the quality, apart from gameplay.
 */
export const RENDERING_SETTINGS_GROUP = 'Rendering';

/** The six-key gameplay settings registry (a fixed table). */
export const M2_SETTINGS_KEYS: readonly SettingsKeySpec[] = [
  // Reasons (these six are always resolved into the manifest, so they
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
  // Engine settings (optional: resolved only when set). Defaults
  // are the values every project ran with before they became data.
  { key: 'fixed_step_hz', type: 'number', default: DEFAULT_FIXED_STEP_HZ, values: FIXED_STEP_HZ_CHOICES, integer: true, unit: 'Hz', optional: true, group: 'Engine', label: 'Fixed step', tooltip: 'Simulation steps per second (60, 120 or 240). Timings in seconds keep their length; replays are recorded at one rate.' },
  { key: 'audio_voices', type: 'number', default: AUDIO_VOICES_DEFAULT, min: 1, max: AUDIO_VOICE_CAP, integer: true, unit: 'voices', optional: true, group: 'Audio', label: 'Sound voices', tooltip: `How many sound effects play at once (a new one is dropped while all are busy; at most ${AUDIO_VOICE_CAP}).` },
  // 1 s: a gentle crossfade between two music tracks.
  { key: 'music_fade_s', type: 'number', default: 1, min: 0, max: 10, unit: 's', optional: true, group: 'Audio', label: 'Music fade', tooltip: 'Seconds a music change crossfades (0: cut).' },
  // 0.2 s: a quick blend between two animation roles (idle, run, airborne).
  { key: 'animation_crossfade_s', type: 'number', default: 0.2, min: 0, max: 2, unit: 's', optional: true, group: 'Animation', label: 'Animation blend', tooltip: 'Seconds a model blends between its idle, run and airborne animations (animator transitions set their own).' },
  // The renderer backend of Play, the export and the Scene view
  // (three-adapter RENDER_BACKEND_SETTING_VALUES). 1, auto — WebGPU
  // where the browser can start it, else WebGL 2: every browser with WebGL 2
  // draws and the faster API is used where it exists. 0 was the archived WebGL
  // renderer ("legacy"): still valid in an older project, read as auto.
  { key: 'render_backend', type: 'number', default: 1, values: [1, 2, 3], legacyValues: [0], valueLabels: ['Auto (WebGPU, else WebGL 2)', 'WebGPU', 'WebGL 2'], integer: true, unit: '', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'Renderer', tooltip: 'Which backend draws the game and the Scene view: WebGPU where the browser has it (else WebGL 2), WebGPU, or WebGL 2. WebGPU needs https or localhost. A page URL flag ?renderer=auto|webgpu|webgl2 overrides it.' },
  // Where the game's simulation runs (game-host SIM_THREAD_SETTING_VALUES).
  // 1, a worker: runtime, physics and scripts run off the page's main thread, so
  // a long step never delays a frame or an input event — every genre gains and
  // none needs the page thread; the page falls back to it where the browser
  // cannot start a worker. Results are the same either way (determinism).
  // The simulation's dimension. 2, the 2D plane: every project
  // made before 3D physics existed plays on it exactly as before (its own
  // Rapier 2D backend); 3 runs the game on the 3D backend (Vec3 positions,
  // full rotations, colliders with depth) — a choice of the game, not a
  // default fitted to any genre, so the neutral default keeps existing data valid.
  { key: 'physics_dimension', type: 'number', default: 2, values: [2, 3], valueLabels: ['2D plane', '3D'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Physics', tooltip: 'The simulation\'s dimension: a 2D plane (movement and collision in X and Y, colliders rotate about Z) or full 3D (colliders with depth and any rotation). A 3D project needs every box collider to have a depth.' },
  { key: 'sim_thread', type: 'number', default: 1, values: [1, 2], valueLabels: ['Worker (off the main thread)', 'Main thread'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Simulation thread', tooltip: 'Where the game simulation (physics, gameplay, scripts) runs in Play and the export: a worker (the page thread only draws and reads input) or the page\'s main thread. Results are identical. A page URL flag ?threads=off|on overrides it.' },
  // The seed of the scripts' ctx.random (every stream mixes it with the
  // script, object and stream name). 0: any fixed value keeps runs and replays
  // repeatable; a game changes it to reshuffle every random choice at once.
  // The in-game debug console in an exported game (Play always has
  // it). 0, off: a release build must never ship a console by accident; a
  // test or playtest build turns it on.
  { key: 'debug_console', type: 'number', default: 0, values: [0, 1], valueLabels: ['Off', 'On'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Debug console in export', tooltip: 'Whether an exported game has the debug console (the ` key: the project\'s debug commands). Play always has it. Leave it off for a release build.' },
  { key: 'random_seed', type: 'number', default: 0, min: 0, max: 4294967295, integer: true, unit: '', optional: true, group: 'Engine', label: 'Random seed', tooltip: 'The seed of the scripts\' random numbers (ctx.random) and of animators\' random start times: the same seed gives the same numbers in every run, replay and export; change it to get a different, still repeatable, sequence (0 to 4294967295).' },
  // The depth buffer's precision (three-adapter DEPTH_BUFFER_SETTING_VALUES).
  // 1, standard: what every project drew with before; a level of any genre at
  // the usual near/far planes needs nothing else. Logarithmic or reversed-Z keep
  // near geometry sharp while far vistas (kilometres out) still sort — a
  // choice of the game (they cost a little: logarithmic writes depth per pixel,
  // reversed-Z needs WebGPU or WebGL 2's EXT_clip_control and falls back to
  // standard without it).
  { key: 'depth_buffer', type: 'number', default: 1, values: [1, 2, 3], valueLabels: ['Standard', 'Logarithmic (far vistas)', 'Reversed Z (far vistas)'], integer: true, unit: '', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'Depth precision', tooltip: 'How depth is stored: standard, logarithmic or reversed Z. The last two keep close objects sharp while scenery kilometres away still draws in the right order (pair with a large camera far plane). Reversed Z needs WebGPU or a WebGL 2 browser with EXT_clip_control (else standard).' },
  // How audio sources are heard. 0, automatic: a 2D-plane project
  // keeps the X-distance model (louder as the player comes near along X, no
  // panning) so every existing project sounds exactly as before; a 3D project
  // gets a panner per source with the listener on the active camera. 1 and 2
  // force one or the other (a 2D game may want stereo panning).
  // The size (m) of an instance set's spatial chunks, each culled on its own
  // (a set's own chunkSize overrides it; each chunk draws one level of detail
  // for its copies unless the set asks for a level per copy). 32 m: a few seconds' walk for the default 1.8 m character and
  // small next to a usual view distance, so chunks out of view are culled
  // (three-adapter INSTANCE_CHUNK_METERS, the same value).
  { key: 'instance_chunk_m', type: 'number', default: 32, min: 1, max: 4096, unit: 'm', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'Instance chunk size', tooltip: 'Instance sets are drawn in square chunks of about this size (m), each hidden when out of view. Smaller: finer culling, more draw calls. A set can set its own.' },
  { key: 'audio_spatial', type: 'number', default: 0, values: [0, 1, 2], valueLabels: ['Automatic (2D: by distance to the player, 3D: panned)', 'By distance to the player (X)', 'Panned (listener on the camera)'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Audio sources', tooltip: 'How audio sources are heard: by their X distance to the player (the 2D default, no panning) or through a panner with the listener on the active camera (the 3D default: left/right panning and each source\'s distance model). Script sounds with a position are always panned.' },
  // The texture budget of Play and the export (MiB; project-model
  // TEXTURE_BUDGET_DEFAULT_MB, where the default's reason is): streamed
  // textures load the mips their on-screen size needs inside it, the least
  // needed dropped first when it is full.
  { key: 'texture_budget_mb', type: 'number', default: TEXTURE_BUDGET_DEFAULT_MB, min: TEXTURE_BUDGET_MIN_MB, max: TEXTURE_BUDGET_MAX_MB, integer: true, unit: 'MiB', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'Texture budget', tooltip: 'GPU memory (MiB) for textures in Play and the export. Streamed textures (large KTX2 textures; per texture in its import settings) load the detail their size on screen needs inside it; when it is full, the least-needed detail is dropped first.' },
  // The default lens of every virtual camera that sets none (cameras.ts VIEW_LENS_DEFAULTS, where the reasons are;
  // the ranges are a virtual camera's own lens limits).
  { key: 'camera_fov_deg', type: 'number', default: VIEW_LENS_DEFAULTS.fovY, min: VIRTUAL_CAMERA_LIMITS.fovY.min, max: VIRTUAL_CAMERA_LIMITS.fovY.max, unit: 'deg', optional: true, group: 'Camera', label: 'Field of view', tooltip: 'The vertical field of view of every camera that does not set its own (and of the view while no camera is live).' },
  { key: 'camera_near_m', type: 'number', default: VIEW_LENS_DEFAULTS.near, min: VIRTUAL_CAMERA_LIMITS.near.min, max: VIRTUAL_CAMERA_LIMITS.near.max, unit: 'm', optional: true, group: 'Camera', label: 'Near plane', tooltip: 'Nothing closer than this is drawn, for every camera that does not set its own near plane.' },
  { key: 'camera_far_m', type: 'number', default: VIEW_LENS_DEFAULTS.far, min: VIRTUAL_CAMERA_LIMITS.far.min, max: VIRTUAL_CAMERA_LIMITS.far.max, unit: 'm', optional: true, group: 'Camera', label: 'Far plane', tooltip: 'Nothing farther than this is drawn, for every camera that does not set its own far plane (beyond the near plane).' },
  // Which models' images are taken out into KTX2 texture assets ("extract
  // textures"). 0: a new import extracts unless asked not to, an older model
  // keeps its images until re-imported with the setting (no silent change to a
  // project on open). 1: every model, older imports included — the backend
  // extracts each GLB still holding images where its file is, and Problems
  // lists what is left (Godot extracts on import; Unity reimports when an
  // importer default changes).
  { key: 'import_extract_textures', type: 'number', default: 0, values: [0, 1], valueLabels: ['New models', 'Every model (older imports too)'], integer: true, unit: '', optional: true, group: 'Import', label: 'Extract model textures', tooltip: 'Which models have the images inside their files taken out into compressed (KTX2) texture assets they share: new imports only, or every model — older imports are then extracted where their GLB file is, and Problems lists any model still holding images.' },
  // How the editor stores a project's block-layer cells (block-chunk-binary.ts): 0, one JSON text file per
  // chunk — what every project had before, so an existing project keeps its files until it opts in; 1, one
  // compressed binary file per chunk (smaller and faster to read, but a git diff shows only that it changed).
  // New projects are made with 1 (NEW_PROJECT_SETTINGS). Changing it rewrites every chunk file in the new form
  // in the same save; either form is read whatever the setting says. The game never sees it (an export always
  // ships its own binary chunk data).
  { key: 'block_chunk_storage', type: 'number', default: 0, values: [0, 1], valueLabels: ['JSON text', 'Binary'], integer: true, unit: '', optional: true, group: 'Project files', label: 'Block chunk files', tooltip: 'Block-layer cells as JSON text (a diff shows each column) or compressed binary (smaller, faster). A change rewrites every chunk file; both open.' },
  // The built-in stats overlay (game-host stats-overlay.ts): engine UI a game
  // opts into, so 0 (none, and no key) is the default; 1 shows it from the
  // start, 2 keeps it hidden until F3, in Play and the export alike.
  { key: 'stats_overlay', type: 'number', default: 0, values: [0, 1, 2], valueLabels: ['Off', 'Shown (F3 hides it)', 'Hidden until F3'], integer: true, unit: '', optional: true, group: 'Engine', label: 'Stats overlay', tooltip: 'A small box over the game with fps, frame, CPU and GPU times (average and worst), draw calls, triangles, texture memory against the budget, geometry, objects and the quality level, in Play and the export. F3 shows and hides it when on. Scripts read the same numbers in ctx.stats, UI documents in $flow.stats.' },
  // The most frames per second Play and the export draw (frame-rate-cap.ts): 0, none — the display's
  // rate, what every game drew at before; a game caps it to save a phone's battery (game time keeps its
  // fixed step either way), and a player's settings field or a script may change it while it runs.
  { key: 'frame_rate_cap', type: 'number', default: 0, values: [0, ...FRAME_RATE_CAPS], valueLabels: ['None (the display\'s rate)', ...FRAME_RATE_CAPS.map((fps) => `${fps} fps`)], integer: true, unit: '', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'Frame-rate cap', tooltip: 'The most frames per second Play and the export draw (none: the display\'s rate). Game time is unaffected: the simulation keeps its fixed step. A player\'s settings field bound to frameRateCap, the UI action setSetting frameRateCap and scripts (ctx.display.setFrameRateCap) change it while the game runs; a page URL flag ?frameRateCap=30|60|120|none overrides it.' },
  // Levels of detail (model-lod.ts, where the defaults' reasons are): a quality setting dividing every switch
  // point and cull size (2: each level kept to half the size), and the margin a level switches back by.
  { key: 'lod_bias', type: 'number', default: LOD_BIAS_DEFAULT, min: LOD_BIAS_MIN, max: LOD_BIAS_MAX, unit: '×', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'LOD bias', tooltip: 'Scales where every model switches to its coarser levels and stops being drawn: 2 keeps each level twice as far, 0.5 switches at half the distance (cheaper). Each model sets its own switch points in its import settings.' },
  { key: 'lod_hysteresis', type: 'number', default: LOD_HYSTERESIS_DEFAULT, min: 0, max: LOD_HYSTERESIS_MAX, unit: '', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'LOD hysteresis', tooltip: 'A model switches back to its finer level only this share of the switch distance closer than where it switched, so one standing at a switch point does not flicker.' },
  // Ambient occlusion, render scale and dynamic resolution (render-settings.ts, where the reasons are). AO:
  // unset, GTAO (what every game drew before the setting, so none changes look); new projects are made with
  // SSAO (NEW_PROJECT_SETTINGS); drawn only where a scene's look turns it on.
  { key: 'ambient_occlusion', type: 'number', default: ambientOcclusionSettingValue(AMBIENT_OCCLUSION_DEFAULT), values: [...AMBIENT_OCCLUSION_SETTING_VALUES], valueLabels: ['Off', 'SSAO (fast, half resolution)', 'GTAO (quality)'], integer: true, unit: '', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'Ambient occlusion', tooltip: 'The kind of ambient occlusion drawn where a scene\'s look turns it on (Post → Ambient occlusion). It darkens only the indirect light (ambient, sky and probe light, and per-vertex local light) in creases and corners, never the sun or per-pixel lamps. SSAO is the fast one new projects start with; GTAO is darker and more exact, at about twice the cost, and what a project draws when it does not set this. A player\'s settings field bound to ambientOcclusion overrides it.' },
  { key: 'render_scale', type: 'number', default: RENDER_SCALE_DEFAULT, min: RENDER_SCALE_MIN, max: RENDER_SCALE_MAX, unit: '×', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'Render scale', tooltip: 'The share of the screen\'s resolution Play and the export draw the 3D view at (0.5–1), upscaled to the screen with AMD FSR 1 (edge-adaptive upscaling and sharpening). 0.75 draws about half the pixels. The Scene view always draws at full resolution. A player\'s settings field bound to renderScale overrides it.' },
  { key: 'dynamic_resolution', type: 'number', default: 0, values: [0, 1], valueLabels: ['Off', 'On'], integer: true, unit: '', optional: true, group: RENDERING_SETTINGS_GROUP, label: 'Dynamic resolution', tooltip: 'Lowers the render scale (down to 0.5) while the GPU takes longer than a frame (the frame-rate cap, else 60 fps) and raises it again, up to the render scale, when it has room. It changes slowly and waits longer after a change that did not hold, so it does not flicker. A player\'s settings field bound to dynamicResolution overrides it.' },
];

/**
 * The settings a new project is made with (an empty one, or one from a
 * template, under the template's own): a setting whose default changed keeps
 * its old value for projects that do not set it, so an existing game never
 * changes look or behaviour on an engine update; new projects get the new
 * value written out.
 */
export const NEW_PROJECT_SETTINGS: Readonly<Record<string, number>> = Object.freeze({
  ambient_occlusion: ambientOcclusionSettingValue(AMBIENT_OCCLUSION_NEW_PROJECT),
  block_chunk_storage: 1,
});

/** The simulation's dimension (the `physics_dimension` setting's values). */
export type PhysicsDimension = 2 | 3;
export const PHYSICS_DIMENSIONS: readonly PhysicsDimension[] = [2, 3];

/**
 * The physics dimension a settings map resolves to — 3 only when
 * the project sets `physics_dimension` to 3, else 2 (the 2D plane every
 * project had before the setting existed).
 */
/** The depth buffer the renderer uses (the `depth_buffer` setting; absent or unknown: standard). */
export function depthBufferOf(settings: unknown): 'standard' | 'logarithmic' | 'reversed' {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['depth_buffer'] : undefined;
  return v === 2 ? 'logarithmic' : v === 3 ? 'reversed' : 'standard';
}

/**
 * How audio sources are heard (the `audio_spatial` setting):
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

/** Whether the project extracts every model's images, older imports included (`import_extract_textures` 1). */
export function extractTexturesEverywhere(settings: unknown): boolean {
  return typeof settings === 'object' && settings !== null && (settings as Record<string, unknown>)['import_extract_textures'] === 1;
}

/** How the editor writes block chunk files (`block_chunk_storage`; absent or 0: JSON text, 1: binary). */
export function blockChunkStorageOf(settings: unknown): 'json' | 'binary' {
  return typeof settings === 'object' && settings !== null && (settings as Record<string, unknown>)['block_chunk_storage'] === 1 ? 'binary' : 'json';
}

/** The project's instance-set chunk size (m) when it sets `instance_chunk_m`, else undefined (the engine default, 32 m). */
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
/** The project's steepest walkable slope in degrees (`max_slope_climb_deg`; absent: its default). */
export function maxSlopeClimbOf(settings: unknown): number {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['max_slope_climb_deg'] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : (SETTINGS_BY_KEY.get('max_slope_climb_deg')!.default as number);
}
