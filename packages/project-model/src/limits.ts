/**
 * The model's limits and id syntax, gathered for the packages that check the
 * same bounds outside the model (commands, the editor, the protocol, the
 * importer, the backend, the physics ports, the game host).
 *
 * Each value is defined once, next to the rule that uses it, and only
 * re-exported here, so a limit changes (or goes) in one place. This module is
 * also the `@thirdlight/project-model/limits` subpath: plain constants, so
 * packages that may otherwise import project-model types only can read them.
 */

export { ID_RE, MAX_ENTITY_DEPTH, MAX_LEN, MAX_REVISION, NAME_MAX, NAME_MIN } from './validate';
export * from './content-limits';
export { MAX_COLLISION_LAYERS, MAX_ENTITIES_V2 } from './components';
export { MAX_EMISSIVE_INTENSITY, MAX_ENTITIES_V4, MAX_INTENSITY } from './scene-v3';
export { MAX_INSTANCES, SCENE_LIMITS_V3 } from './types-v3';
export { EVENT_CUE_LIMITS } from './event-cues';
export { MODE_LIMITS } from './modes';
export { MAX_ANIMATOR_LAYERS } from './animator';
export { MATERIAL_DATA_MAX } from './material-graph-kinds';
export { SAVE_LIMITS, SCRIPT_SAVE_LIMITS } from './save-schema';
export { ENVIRONMENT_PRESET_LIMITS } from './environment-presets';
export { MAX_TRANSITION_FADE, MAX_TRANSITION_UNLOADS } from './blocks';
export { MAX_INPUT_ACTIONS, MAX_INPUT_BINDINGS } from './input';
export { MAX_FOG_VOLUMES, MAX_MATERIAL_INSTANCE_DEPTH } from './materials';
export { MAX_LOCAL_LIGHTS } from './scene-v3';
export { COLLIDER_3D_LIMITS, CONVEX_TOL, MAX_COLLIDER_EXTENT, MAX_POLYGON_VERTICES, MIN_POLYGON_AREA } from './components';
// The audio load-type defaults and the browser-support rules (pure data rules the editor applies too).
export { AUDIO_DECODE_ON_LOAD_BELOW_MS, AUDIO_FORMATS, AUDIO_LOAD_TYPES, AUDIO_PIPELINE_NAME, AUDIO_PIPELINE_VERSION, AUDIO_STREAM_ABOVE_MS, audioLoadOf, audioPlaybackGaps, audioSummaryOf, defaultAudioLoadType } from './audio-assets';
export { RUNTIME_CONTENT_MANIFEST_MAX_BYTES } from './manifest';
export { MANIFEST_CONTENT_FILE_MAX_BYTES } from './manifest-v2';
export { MAX_TAGS, INSTANCE_FLOATS } from './types-v3';
export { BEHAVIOR_GRAPH_LIMITS } from './behavior-graph-nodes';
export { EFFECT_LIMITS } from './effects';
export { GRAPH_LIMITS } from './graph';
export { PAINT_BRUSH_LIMITS } from './paint-brush';
export { SCRIPT_LIBRARY_LIMITS } from './script-libraries';
export { SCULPT_LIMITS } from './block-sculpt';
export { TIMELINE_LIMITS } from './timelines';
export { UI_LIMITS } from './ui-documents';
export { MAX_LIGHTMAP_ATLASES, MAX_LIGHTMAP_ENTRIES } from './lighting';
export { DIALOGUE_LIMITS } from './dialogue';
export { MAX_INPUT_MAPS } from './input';
export { GRAPH_CURVE_LIMITS } from './graph';
