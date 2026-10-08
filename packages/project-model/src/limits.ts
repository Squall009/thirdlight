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
// The simulation's step rate (default and choices).
export { DEFAULT_FIXED_STEP_HZ, FIXED_STEP_HZ_CHOICES } from './content-settings';
// The asset kinds (the editor's asset lists and pickers name them).
export { ASSET_KINDS } from './descriptor-types';
// The resource kinds (the project window's search and kind menu name them).
export { RESOURCE_KIND_TABLE } from './loadable';
export { MAX_COLLISION_LAYERS, MAX_ENTITIES_V2 } from './components';
export { MAX_EMISSIVE_INTENSITY, MAX_ENTITIES_V4, MAX_INTENSITY } from './scene-v3';
export { MAX_INSTANCES, SCENE_LIMITS_V3 } from './types-v3';
export { EVENT_CUE_LIMITS } from './event-cues';
export { MODE_LIMITS } from './modes';
export { MAX_ANIMATOR_LAYERS } from './animator';
export { MATERIAL_DATA_MAX } from './material-graph-kinds';
export { SAVE_LIMITS, SCRIPT_SAVE_LIMITS, SETTINGS_ENGINE_BINDINGS } from './save-schema';
// The frame-rate caps (the Saves panel's settings field and the UI action's choices).
export { FRAME_RATE_CAP_CHOICES } from './frame-rate-cap';
export { AMBIENT_OCCLUSION_DEFAULT, AMBIENT_OCCLUSION_KINDS, AMBIENT_OCCLUSION_NEW_PROJECT, RENDER_SCALE_MAX, RENDER_SCALE_MIN, renderSettingsOf } from './render-settings';
export { ENVIRONMENT_PRESET_LIMITS } from './environment-presets';
export { DEFAULT_QUALITY_LEVELS, MSAA_SAMPLE_COUNTS, PIXEL_RATIO_CAP_MAX, PIXEL_RATIO_CAP_MIN, QUALITY_LEVEL_ID_RE, qualityLevelsOf, SHADOW_MAP_SIZES } from './quality-levels';
export { MAX_TRANSITION_FADE, MAX_TRANSITION_UNLOADS } from './blocks';
export { MAX_INPUT_ACTIONS, MAX_INPUT_BINDINGS } from './input';
export { MAX_FOG_VOLUMES, MAX_MATERIAL_INSTANCE_DEPTH, SKY_ROTATION_MAX, WET_ALBEDO_SCALE, WET_ROUGHNESS } from './materials';
export { MAX_LOCAL_LIGHTS } from './local-lights';
export { LIGHT_LAYER_COUNT, LIGHT_LAYERS_ALL, MAX_LIGHT_LAYER_NAME, lightLayerLabel } from './light-layers';
export { INSTANCES_LOCAL_LIGHTS_DEFAULT, LIGHT_IMPORTANCES, LOCAL_LIGHT_MODES, MATERIAL_LOCAL_LIGHT_MODES } from './local-lights';
export { COLLIDER_3D_LIMITS, CONVEX_TOL, MAX_COLLIDER_EXTENT, MAX_POLYGON_VERTICES, MIN_POLYGON_AREA } from './components';
// The audio load-type defaults and the browser-support rules (pure data rules the editor applies too).
export { AUDIO_DECODE_ON_LOAD_BELOW_MS, AUDIO_FORMATS, AUDIO_LOAD_TYPES, AUDIO_PIPELINE_NAME, AUDIO_PIPELINE_VERSION, AUDIO_STREAM_ABOVE_MS, audioLoadOf, audioPlaybackGaps, audioSummaryOf, defaultAudioLoadType } from './audio-assets';
export { TEXTURE_BUDGET_DEFAULT_MB, TEXTURE_BUDGET_MAX_MB, TEXTURE_BUDGET_MIN_MB, TEXTURE_STREAM_TAIL_PX, TEXTURE_STREAMING_DEFAULT_ABOVE_PX, textureBudgetBytesOf, textureHasStreamableChain, textureStreamingOf } from './texture-streaming';
export { STREAMING_BUDGET_DEFAULT_MB, STREAMING_BUDGET_MAX_MB, STREAMING_BUDGET_MIN_MB } from './world-streaming';
export { INSTANCE_DENSITY_END_DEFAULT, INSTANCE_DENSITY_MIN_DEFAULT, INSTANCE_DENSITY_MIN_NEW, INSTANCE_DENSITY_START_DEFAULT, LOD_BIAS_DEFAULT, LOD_BIAS_MAX, LOD_BIAS_MIN, LOD_HYSTERESIS_DEFAULT, LOD_HYSTERESIS_MAX, LOD_SCREEN_SIZES_DEFAULT, MESH_LOD_RATIOS_DEFAULT, lodTuningOf } from './model-lod';
// The settings group the editor shows with the quality (Project Settings → Quality).
export { RENDERING_SETTINGS_GROUP, extractTexturesEverywhere } from './content-settings';
export { RUNTIME_CONTENT_MANIFEST_MAX_BYTES } from './manifest';
export { MANIFEST_CONTENT_FILE_MAX_BYTES } from './manifest-v2';
export { MAX_TAGS, INSTANCE_FLOATS } from './types-v3';
export { BEHAVIOR_GRAPH_LIMITS } from './behavior-graph-nodes';
export { EFFECT_LIMITS } from './effects';
export { GRAPH_LIMITS } from './graph';
export { PAINT_BRUSH_LIMITS } from './paint-brush';
export { SCRIPT_LIBRARY_LIMITS } from './script-libraries';
export { SCULPT_LIMITS } from './block-sculpt';
export { TERRAIN_BRUSH_LIMITS } from './terrain-edit';
export { TIMELINE_LIMITS } from './timelines';
export { UI_LIMITS } from './ui-documents';
export { MAX_LIGHTMAP_ATLASES, MAX_LIGHTMAP_ENTRIES } from './lighting';
export { DIALOGUE_LIMITS } from './dialogue';
export { INPUT_PAD_SLOTS, MAX_INPUT_MAPS, PAD_BINDING_KINDS } from './input';
export { GRAPH_CURVE_LIMITS } from './graph';
export { INSTANCE_BRUSH_LIMITS, INSTANCE_BRUSH_REACH } from './instance-brush';
// The deprecated UI engine actions and what replaces them (the editor marks them).
export { UI_DEPRECATED_ENGINE_ACTIONS } from './ui-documents';
