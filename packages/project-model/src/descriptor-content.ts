/**
 * The content block descriptors: environment, input, materials, effects,
 * animators, behaviors, settings and the other project-wide blocks.
 */

import { EVENT_CUE_BUSES, EVENT_CUE_LIMITS, EVENT_CUE_SOURCES } from './event-cues';
import { ASSET_METRIC_CAPS, AUDIO_MAX_LATE_MS_DEFAULT, AUDIO_MAX_LATE_MS_LIMIT } from './content-limits';
import { SHELL_LIMITS, SHELL_SCREENS, SHELL_SIMULATE } from './shell';
import { SAVE_LIMITS, SAVE_SECTIONS } from './save-schema';
import { MAX_ANIMATOR_MORPHS } from './animator';
import { ANIMATOR_CONDITION_OPS, ANIMATOR_PARAMETER_TYPES, MAX_ANIMATOR_CONDITIONS, MAX_ANIMATOR_EVENTS, MAX_ANIMATOR_LAYERS, MAX_ANIMATOR_PARAMETERS, MAX_ANIMATOR_STATES, MAX_ANIMATOR_TRANSITIONS, MAX_BLEND_CHILDREN, MAX_BLEND_GROUND_SPEED, MAX_LAYER_MASK } from './animator';
import { MAX_TRANSITION_FADE } from './blocks';
import { MAX_COLLISION_LAYERS } from './components';
import { LIGHT_LAYER_COUNT, MAX_LIGHT_LAYER_NAME } from './light-layers';
import { RESOURCE_KIND_TABLE } from './loadable';
import { ADDRESS_MAX_LENGTH, ASSET_LABEL_MAX_LENGTH, M2_SETTINGS_KEYS, MAX_ENUM_VALUES, MAX_DECLARATION_BYTES, MAX_PREFAB_ENTITIES, PREFAB_V4_COMPONENTS } from './content';
import {
  CURSOR_MODES,
  DEFAULT_INPUT,
  INPUT_ACTION_TYPES,
  INPUT_HOLD_MAX,
  INPUT_HOLD_MIN,
  INPUT_PAD_SLOTS,
  MAX_INPUT_ACTIONS,
  MAX_INPUT_BINDINGS,
  MAX_INPUT_MAPS,
  MAX_INPUT_GLYPHS,
  POINTER_AXES,
  POINTER_BUTTONS,
} from './input';
import { EFFECT_DEFAULTS, EFFECT_LIMITS, EFFECT_PARAMETER_TYPES } from './effects';
import { UI_LIMITS } from './ui-documents';
import { DIALOGUE_LIMITS } from './dialogue';
import { TIMELINE_LIMITS } from './timelines';
import { SCRIPT_LIBRARY_LIMITS } from './script-libraries';
import { BLOCK_LIMITS, BLOCK_UV_MODES } from './block-layers';
import { BLOCK_CONNECT_WITH_MAX } from './block-connect';
import { DEFAULT_WIND, HEIGHT_FOG_DEFAULTS, HEIGHT_FOG_LIMITS, SKY_ROTATION_MAX, MATERIAL_PARAMS, MATERIAL_SHADERS, MATERIAL_TEXTURE_SLOTS, MAX_MATERIAL_PARAMETERS, MAX_MATERIAL_SLOTS, type MaterialParamType } from './materials';
import { MATERIAL_DATA_MAX, MATERIAL_PARAMETER_TYPES } from './material-graph-kinds';
import { TRIM_DENSITY_MAX, TRIM_DENSITY_MIN, TRIM_PADDING_MAX, TRIM_SHEET_DEFAULTS, TRIM_SHEET_SIZE_MAX, TRIM_STARTER_LAYOUT } from './trim-sheet';
import { MODE_LIMITS } from './modes';
import { MAX_LOCAL_LIGHTS } from './local-lights';
import { LOD_BIAS_MAX, LOD_BIAS_MIN } from './model-lod';
import { MSAA_SAMPLE_COUNTS, PIXEL_RATIO_CAP_MAX, PIXEL_RATIO_CAP_MIN, QUALITY_POST_EFFECTS, SHADOW_MAP_SIZES } from './quality-levels';
import { AMBIENT_OCCLUSION_KINDS, RENDER_SCALE_MAX, RENDER_SCALE_MIN } from './render-settings';
import { MAX_TAGS } from './types-v3';
import { asset, bool, color, enm, entity, ID, int, json, list, map, NAME, num, obj, ref, scene, str, vec2, vec3, when } from './descriptor-builders';
import { ASSET_KINDS, type ContentBlockDescriptor, type DescriptorJson, type DescriptorUnit, type FieldDescriptor, type ListFieldDescriptor, type ObjectFieldDescriptor } from './descriptor-types';
import { MODE_ITEM } from './descriptor-components';

// ---- content blocks ----------------------------------------------------------------

const WIND = obj('wind', 'Wind', 'The global wind foliage and cloth sway in.', [
  vec2('direction', 'Direction', 'Horizontal direction [x, z] (not both 0).', { required: true, min: -1, max: 1, step: 0.05, nonZero: true, labels: ['x', 'z'], default: [...DEFAULT_WIND.direction] }),
  num('strength', 'Strength', 'Base strength (0: still air).', { required: true, min: 0, max: 10, step: 0.05, default: DEFAULT_WIND.strength }),
  num('gust', 'Gusts', 'Extra strength of gusts.', { required: true, min: 0, max: 10, step: 0.05, default: DEFAULT_WIND.gust }),
  num('gustFrequency', 'Gust frequency', 'Gusts per second.', { required: true, min: 0, max: 10, step: 0.05, default: DEFAULT_WIND.gustFrequency }),
  num('turbulence', 'Turbulence', 'Small-scale variation over space.', { required: true, min: 0, max: 1, step: 0.05, default: DEFAULT_WIND.turbulence }),
]);

const WETNESS = num('wetness', 'Wetness', 'How wet the scene is (rain): materials with a Scene wetness node (the height-blended layers template) darken and shine as if wet, water pooling in low parts first. Presets blend it.', { min: 0, max: 1, step: 0.05, default: 0 });

// The sky defaults are the three.js Sky example's physically based
// clear day (haze 6, Rayleigh 1.5, Mie 0.005 / 0.8), the sun from the scene's
// key light (else 35° up), and plain blues for the gradient and colour modes;
// below the horizon a neutral grey (no ground is assumed). A project that wants
// night, space or an interior sets its own sky.
const SKY_MODES = ['procedural', 'gradient', 'texture', 'color'] as const;
const PROCEDURAL = when('mode', 'procedural');
const SKY = obj('sky', 'Sky', 'The background and the light it gives (image-based lighting).', [
  enm('mode', 'Sky', 'Physically based, a three-colour gradient, an image, or one colour.', SKY_MODES, { required: true, default: 'procedural' }),
  num('turbidity', 'Haze', 'Atmospheric haze.', { when: PROCEDURAL, min: 1, max: 20, step: 0.1, default: 6 }),
  num('rayleigh', 'Rayleigh', 'Blue-sky scattering.', { when: PROCEDURAL, min: 0, max: 4, step: 0.05, default: 1.5 }),
  num('mieCoefficient', 'Mie', 'Haze around the sun.', { when: PROCEDURAL, min: 0, max: 0.1, step: 0.001, default: 0.005 }),
  num('mieDirectionalG', 'Mie direction', 'How tight the sun glow is.', { when: PROCEDURAL, min: 0, max: 1, step: 0.01, default: 0.8 }),
  bool('sunFromLight', 'Sun from light', 'Place the sun opposite the scene\'s directional light.', { when: PROCEDURAL, default: true }),
  num('sunElevation', 'Sun elevation', 'Sun height above the horizon.', { when: [PROCEDURAL, when('sunFromLight', false)], min: -10, max: 90, step: 1, unit: 'deg', default: 35 }),
  num('sunAzimuth', 'Sun azimuth', 'Sun direction around the horizon.', { when: [PROCEDURAL, when('sunFromLight', false)], min: -180, max: 180, step: 1, unit: 'deg', default: 160 }),
  color('topColor', 'Top colour', 'The sky overhead.', { when: when('mode', 'gradient'), default: '#3d7cd6' }),
  color('horizonColor', 'Horizon colour', 'The sky at the horizon.', { when: when('mode', 'gradient'), default: '#bfe3ff' }),
  color('bottomColor', 'Bottom colour', 'Below the horizon.', { when: when('mode', 'gradient'), default: '#757575' }), // a neutral mid grey — no ground (grass, sand, water, a floor) is assumed
  color('color', 'Colour', 'The one sky colour.', { when: when('mode', 'color'), default: '#7ec8ff' }),
  asset('texture', 'Image', 'An equirectangular sky image.', ['texture'], { when: when('mode', 'texture') }),
  list('cube', 'Cube faces', 'Six images +x, −x, +y, −y, +z, −z (instead of one image).', asset('*', 'Face', 'A cube face.', ['texture']), { when: when('mode', 'texture'), length: 6 }),
  num('rotation', 'Rotation', 'Turns the sky image about the vertical axis (background and sky lighting alike).', { when: when('mode', 'texture'), min: -SKY_ROTATION_MAX, max: SKY_ROTATION_MAX, step: 1, unit: 'deg', default: 0 }),
  num('intensity', 'Brightness', 'Background brightness.', { min: 0, max: 8, step: 0.05, default: 1 }),
  num('environmentIntensity', 'Sky lighting', 'How much the sky lights the scene (0: none).', { min: 0, max: 8, step: 0.05, default: 1 }),
], { rules: ['A texture sky needs an image or six cube faces.'] });

// Fog is off by default; turned on it starts as a light grey-blue haze from 10 m to 120 m (a level's far end fades) or density 0.01.
const FOG = obj('fog', 'Fog', 'Distance fog.', [
  enm('mode', 'Fog', 'None, linear (near to far) or exponential (density).', ['none', 'linear', 'exp2'], { required: true, default: 'none', labels: { exp2: 'Exponential' } }),
  color('color', 'Colour', 'The fog colour.', { required: true, default: '#c8d2dc' }),
  num('near', 'Start', 'Fog starts here.', { when: when('mode', 'linear'), min: 0, max: 10000, step: 1, unit: 'm', default: 10 }),
  num('far', 'Full', 'Fog is full here.', { when: when('mode', 'linear'), min: 0, max: 10000, step: 1, unit: 'm', default: 120 }),
  num('density', 'Density', 'Exponential fog density.', { when: when('mode', 'exp2'), min: 0, max: 1, step: 0.001, default: 0.01 }),
]);

const HEIGHT_FOG = obj('heightFog', 'Height fog', 'Exponential height fog: thickens with distance and lies low, thinning with height; it fogs the sky towards the horizon too, so the far edge of a level fades into it. Presets blend it.', [
  num('density', 'Density', 'Fog per metre at the base height.', { required: true, min: 0, max: HEIGHT_FOG_LIMITS.density, step: 0.0005, default: HEIGHT_FOG_DEFAULTS.density }),
  color('color', 'Colour', 'The fog colour.', { required: true, default: HEIGHT_FOG_DEFAULTS.color }),
  num('height', 'Base height', 'World height where the fog has its density.', { min: -HEIGHT_FOG_LIMITS.height, max: HEIGHT_FOG_LIMITS.height, step: 1, unit: 'm', default: HEIGHT_FOG_DEFAULTS.height }),
  num('falloff', 'Falloff', 'How fast it thins with height (per metre: halves every 0.69 / falloff m).', { min: 0, max: HEIGHT_FOG_LIMITS.falloff, step: 0.005, default: HEIGHT_FOG_DEFAULTS.falloff }),
  num('start', 'Start distance', 'No fog nearer than this to the camera.', { min: 0, max: HEIGHT_FOG_LIMITS.start, step: 1, unit: 'm', default: HEIGHT_FOG_DEFAULTS.start }),
  color('inscatterColor', 'Sun glow', 'Added towards the sun (absent: no glow).'),
  num('inscatterExponent', 'Sun glow size', 'Higher: a tighter glow round the sun.', { min: HEIGHT_FOG_LIMITS.inscatterExponentMin, max: HEIGHT_FOG_LIMITS.inscatterExponentMax, step: 1, default: HEIGHT_FOG_DEFAULTS.inscatterExponent }),
]);

const effect = (key: string, label: string, tooltip: string, fields: readonly FieldDescriptor[]): ObjectFieldDescriptor =>
  obj(key, label, tooltip, [bool('enabled', 'On', `Turns ${label.toLowerCase()} on.`, { required: true, default: true }), ...fields]);

// Every post effect starts neutral or off; AgX tone mapping at exposure 1 keeps bright lights from clipping in any palette.
const POST = obj('post', 'Post-processing', 'Tone mapping, exposure and screen effects.', [
  enm('toneMapping', 'Tone mapping', 'How bright colours are mapped to the screen.', ['none', 'aces', 'agx', 'neutral'], { default: 'agx', labels: { aces: 'ACES', agx: 'AgX' } }),
  num('exposure', 'Exposure', 'Overall brightness.', { min: 0, max: 8, step: 0.05, default: 1 }),
  enm('antialias', 'Anti-aliasing', 'Smooths jagged edges.', ['none', 'fxaa', 'smaa'], { default: 'none', labels: { fxaa: 'FXAA', smaa: 'SMAA' } }),
  effect('bloom', 'Bloom', 'Bright parts glow.', [
    num('strength', 'Strength', 'Glow strength.', { min: 0, max: 3, step: 0.05, default: 0.6 }),
    num('radius', 'Radius', 'Glow spread.', { min: 0, max: 1, step: 0.05, default: 0.4 }),
    num('threshold', 'Threshold', 'Only brighter than this glows.', { min: 0, max: 2, step: 0.05, default: 0.85 }),
  ]),
  obj('grading', 'Colour grading', 'Contrast, saturation, tint, lift/gamma/gain and a LUT.', [
    num('contrast', 'Contrast', '−1 to 1 (0: unchanged).', { min: -1, max: 1, step: 0.05, default: 0 }),
    num('saturation', 'Saturation', '−1 to 1 (0: unchanged).', { min: -1, max: 1, step: 0.05, default: 0 }),
    num('brightness', 'Brightness', '−1 to 1 (0: unchanged).', { min: -1, max: 1, step: 0.05, default: 0 }),
    color('tint', 'Tint', 'Multiplied over the image (white: none).', { default: '#ffffff' }),
    asset('lut', 'LUT', 'A colour lookup texture.', ['texture']),
    num('lift', 'Lift', 'Raises the blacks (0: unchanged).', { min: -0.5, max: 0.5, step: 0.01, default: 0 }),
    num('gamma', 'Gamma', 'Mid-tones (above 1 brightens; 1: unchanged).', { min: 0.2, max: 5, step: 0.05, default: 1 }),
    num('gain', 'Gain', 'Scales the whites (1: unchanged).', { min: 0, max: 4, step: 0.05, default: 1 }),
  ]),
  effect('vignette', 'Vignette', 'Darkened corners.', [
    num('darkness', 'Darkness', 'How dark the corners get.', { min: 0, max: 1, step: 0.05, default: 0.5 }),
    num('offset', 'Size', 'How far in it reaches.', { min: 0, max: 2, step: 0.05, default: 1 }),
  ]),
  effect('ssao', 'Ambient occlusion', 'Contact shadows in creases.', [
    num('radius', 'Radius', 'How far it looks.', { min: 0.01, max: 4, step: 0.01, unit: 'm', default: 0.5 }),
    num('intensity', 'Intensity', 'How dark.', { min: 0, max: 4, step: 0.05, default: 1 }),
  ]),
  effect('dof', 'Depth of field', 'Blur away from the focus distance.', [
    num('focus', 'Focus', 'Sharp at this distance.', { min: 0.1, max: 1000, step: 0.1, unit: 'm', default: 10 }),
    num('aperture', 'Aperture', 'Blur amount.', { min: 0, max: 0.1, step: 0.0005, default: 0.002 }),
    num('maxBlur', 'Max blur', 'Blur limit.', { min: 0, max: 0.05, step: 0.001, default: 0.01 }),
  ]),
]);

// Environment presets — named looks scripts switch or blend to (a part a preset leaves out is the base look's).
const PRESET_LIGHT = obj('*', 'Light', 'The values this preset gives the lights it names (one of entity, tag or type; none: every light).', [
  entity('entity', 'Entity', 'One light by its entity.', { component: 'light' }),
  str('tag', 'Tag', 'Every light with this tag.', { format: 'identifier', minLength: 1, maxLength: 32 }),
  enm('type', 'Type', 'Every light of this type.', ['directional', 'ambient', 'point', 'spot', 'hemisphere']),
  color('color', 'Colour', 'The light colour.'),
  num('intensity', 'Intensity', 'The light intensity (candela for point and spot lights).', { min: 0, max: 1000, step: 0.05 }),
  vec3('direction', 'Direction', 'Where a directional or spot light shines (not all 0).', { min: -1, max: 1, step: 0.05, nonZero: true }),
  color('groundColor', 'Ground colour', 'A hemisphere light\'s ground colour.'),
], { rules: ['A light entry names at most one of entity, tag or type (none: every light).'] });
const PRESET = obj('*', 'Preset', 'A named look: sky, fog, post-processing, light values, a lightmap multiplier and the wetness.', [
  str('presetId', 'Id', 'A stable id scripts use: a-z, 0-9, _ or -.', { required: true, format: 'identifier', minLength: 1, maxLength: 64 }),
  str('name', 'Name', 'Shown in the editor.', { required: true, minLength: 1, maxLength: 128 }),
  SKY,
  FOG,
  HEIGHT_FOG,
  POST,
  list('lights', 'Lights', 'Light values (later entries win per field).', PRESET_LIGHT, { maxItems: 32 }),
  obj('lightmap', 'Lightmap', 'Multiplies baked lighting (a bake keeps the light of the moment it was baked).', [
    num('intensity', 'Intensity', 'Multiplies the baked light (1: as baked).', { min: 0, max: 8, step: 0.05, default: 1 }),
    color('tint', 'Tint', 'Tints the baked light (white: as baked).', { default: '#ffffff' }),
  ]),
  WETNESS,
], { rules: ['Preset ids are unique.'] });

/**
 * A quality level's post-processing: the look's effects it may change, each
 * effect's `enabled` optional (off turns the effect off at the level; a level
 * never turns one on).
 */
const LEVEL_POST = obj(
  'post',
  'Post-processing',
  'Per effect, what this level changes where the look has it on; Off turns it off (never on).',
  POST.fields
    .filter((f) => (QUALITY_POST_EFFECTS as readonly string[]).includes(f.key) || f.key === 'antialias')
    .map((f) => (f.type === 'object' ? { ...f, fields: f.fields.map((x) => (x.key === 'enabled' ? bool('enabled', 'On', 'Off: off at this level.', { default: true }) : x)) } : f)),
);

/** One quality level (quality-levels.ts): the look's post per effect and renderer settings, each absent one the project's. */
const QUALITY_LEVEL = obj('level', 'Quality level', 'Graphics settings players pick from.', [
  str('id', 'Id', 'Named by environment.quality, a player\'s setting and game-control setQuality.', { required: true, minLength: 1, maxLength: 32 }),
  str('name', 'Name', 'Shown to players (absent: the id).', { minLength: 1, maxLength: 64 }),
  LEVEL_POST,
  num('renderScale', 'Render scale', 'Drawn at this share of the resolution, FSR 1 upscaled (absent: render_scale).', { min: RENDER_SCALE_MIN, max: RENDER_SCALE_MAX, step: 0.05 }),
  num('pixelRatio', 'Pixel ratio cap', 'Most pixels per CSS pixel on HiDPI displays (absent: 1).', { min: PIXEL_RATIO_CAP_MIN, max: PIXEL_RATIO_CAP_MAX, step: 0.25 }),
  int('msaa', 'MSAA', 'Multisampling without a post stack (absent: 4).', { values: [...MSAA_SAMPLE_COUNTS], valueLabels: MSAA_SAMPLE_COUNTS.map((n) => (n === 0 ? 'Off' : `${n}×`)) }),
  int('shadowMapSize', 'Largest shadow map', 'Larger light shadow maps are lowered to it (absent: each light\'s own).', { values: [...SHADOW_MAP_SIZES] }),
  int('localLights', 'Local lights', `Point and spot lights drawn at once (absent: ${MAX_LOCAL_LIGHTS}).`, { min: 0, max: MAX_LOCAL_LIGHTS }),
  int('shadowedLights', 'Shadowed lights', 'Point and spot lights drawing their shadow at once: largest on screen first, spot before point, fading with distance (absent: every one).', { min: 0, max: MAX_LOCAL_LIGHTS }),
  enm('ambientOcclusion', 'Ambient occlusion', 'Where a look has AO (absent: ambient_occlusion).', [...AMBIENT_OCCLUSION_KINDS], { labels: { off: 'Off', ssao: 'SSAO', gtao: 'GTAO' } }),
  num('lodBias', 'LOD bias', 'Above 1 keeps finer LODs further (absent: lod_bias).', { min: LOD_BIAS_MIN, max: LOD_BIAS_MAX, step: 0.05 }),
  bool('dynamicResolution', 'Dynamic resolution', 'Lower the scale while the GPU is over budget (absent: dynamic_resolution).'),
], { rules: ['Level ids are unique.'] });

const ENVIRONMENT: FieldDescriptor = obj('environment', 'Environment', 'The quality levels, the one a game starts at, and the presets; each scene has its own sky, fog, post-processing and wind.', [
  str('quality', 'Quality', 'The quality level a game starts at, one of the levels\' ids (players change it in Settings; absent: the highest).', { minLength: 1 }),
  list('qualityLevels', 'Quality levels', 'The project\'s quality levels, lowest first (absent: the engine\'s low, medium and high: low draws no bloom, AO, depth of field, anti-aliasing or MSAA; medium no AO or depth of field).', QUALITY_LEVEL, { minItems: 1 }),
  list('presets', 'Presets', 'Named looks scripts switch or blend to at run time (ctx.environment), laid over the active scene\'s look.', PRESET, { maxItems: 64 }),
]);

/** A scene's look (`SceneV4.environment`): with several scenes loaded the active scene's applies. */
export const SCENE_ENVIRONMENT: ObjectFieldDescriptor = obj('environment', 'Scene environment', 'This scene\'s sky, fog, height fog, post-processing, wind and wetness.', [SKY, FOG, HEIGHT_FOG, POST, WIND, WETNESS]);

const KEY_CODE = { format: 'keyCode' as const, minLength: 1, maxLength: 32 };
const BINDING_KINDS = ['key', 'gamepadButton', 'gamepadAxis', 'keys1d', 'keys2d', 'gamepadButtons1d', 'gamepadStick', 'pointerButton', 'pointerPosition', 'pointerDelta', 'pointerAxis'] as const;
const INPUT: FieldDescriptor = obj('input', 'Input', 'The game\'s actions and their keys and gamepad bindings (absent: the default actions).', [
  list('actions', 'Actions', `Up to ${MAX_INPUT_ACTIONS} named actions.`, obj('*', 'Action', 'A named action and its bindings.', [
    str('name', 'Name', 'The action name scripts and blocks read (a letter or _, then letters, digits or _).', { required: true, format: 'identifier', minLength: 1, maxLength: 32 }),
    enm('type', 'Type', 'A button, a 1D axis (left/right) or a 2D axis.', INPUT_ACTION_TYPES, { required: true, default: 'button', labels: { axis1d: 'Axis (1D)', axis2d: 'Axis (2D)' } }),
    // Gameplay, ui or one of the project's own maps (game modes activate maps).
    ref('map', 'Map', 'Read by the game (gameplay), the menus (ui) or one of the project\'s maps.', 'inputMap', { required: true, default: 'gameplay' }),
    list('bindings', 'Bindings', `Up to ${MAX_INPUT_BINDINGS} keys, buttons, axes or composites.`, obj('*', 'Binding', 'One binding (it must fit the action type).', [
      enm('kind', 'Kind', 'What is bound.', BINDING_KINDS, { required: true, default: 'key', labels: { gamepadButton: 'Gamepad button', gamepadAxis: 'Gamepad axis', keys1d: 'Two keys (1D)', keys2d: 'Four keys (2D)', gamepadButtons1d: 'Two gamepad buttons (1D)', gamepadStick: 'Gamepad stick', pointerButton: 'Pointer button', pointerPosition: 'Pointer position (2D)', pointerDelta: 'Pointer movement (2D)', pointerAxis: 'Pointer axis (1D)' } }),
      str('code', 'Key', 'A keyboard key (KeyboardEvent.code).', { ...KEY_CODE, required: true, when: when('kind', 'key') }),
      int('button', 'Button', 'A standard gamepad button index.', { required: true, when: when('kind', 'gamepadButton'), min: 0, max: 31 }),
      int('axis', 'Axis', 'A standard gamepad axis index.', { required: true, when: when('kind', 'gamepadAxis'), min: 0, max: 7 }),
      str('negative', 'Negative key', 'The key for −1.', { ...KEY_CODE, required: true, when: when('kind', 'keys1d') }),
      str('positive', 'Positive key', 'The key for +1.', { ...KEY_CODE, required: true, when: when('kind', 'keys1d') }),
      int('negative', 'Negative button', 'The gamepad button for −1.', { required: true, when: when('kind', 'gamepadButtons1d'), min: 0, max: 31 }),
      int('positive', 'Positive button', 'The gamepad button for +1.', { required: true, when: when('kind', 'gamepadButtons1d'), min: 0, max: 31 }),
      str('up', 'Up', 'The key for up.', { ...KEY_CODE, required: true, when: when('kind', 'keys2d') }),
      str('down', 'Down', 'The key for down.', { ...KEY_CODE, required: true, when: when('kind', 'keys2d') }),
      str('left', 'Left', 'The key for left.', { ...KEY_CODE, required: true, when: when('kind', 'keys2d') }),
      str('right', 'Right', 'The key for right.', { ...KEY_CODE, required: true, when: when('kind', 'keys2d') }),
      int('x', 'X axis', 'The stick\'s horizontal axis index.', { required: true, when: when('kind', 'gamepadStick'), min: 0, max: 7 }),
      int('y', 'Y axis', 'The stick\'s vertical axis index.', { required: true, when: when('kind', 'gamepadStick'), min: 0, max: 7 }),
      enm('button', 'Pointer button', 'The mouse (or pen/touch) button.', POINTER_BUTTONS, { required: true, when: when('kind', 'pointerButton'), default: 'left' }),
      enm('axis', 'Pointer axis', 'The pointer\'s movement along x or y (up positive; percent of the view per step), or the wheel (notches, positive towards the user).', POINTER_AXES, { required: true, when: when('kind', 'pointerAxis'), default: 'x' }),
      // Absent = a tap counts at once; 0.5 s is a deliberate hold most players read as "hold" (a starting value the designer tunes).
      num('hold', 'Hold', 'Hold instead of tap: the binding counts only after it has been held this long.', { when: when('kind', 'key', 'gamepadButton', 'pointerButton'), min: INPUT_HOLD_MIN, max: INPUT_HOLD_MAX, step: 0.05, unit: 's', default: 0.5 }),
      // Absent = the pad the player used last (a one-player game); a co-op game binds each player's actions to their own pad.
      int('pad', 'Pad', 'Only this gamepad (its slot, 0 for the first connected): each player of a local co-op game on a pad of their own. Absent: the pad used last.', { when: when('kind', 'gamepadButton', 'gamepadAxis', 'gamepadButtons1d', 'gamepadStick'), min: 0, max: INPUT_PAD_SLOTS - 1 }),
    ], { rules: ['A button takes keys, buttons and pointer buttons; a 1D axis also two-key, two-button, axis and pointer-axis bindings; a 2D axis four keys, a stick, the pointer position or the pointer movement.'] }), { required: true, maxItems: MAX_INPUT_BINDINGS }),
    num('deadZone', 'Dead zone', 'Axis values within this count as 0 (then rescaled).', { min: 0, max: 1, maxExclusive: true, step: 0.05, default: 0.2 }),
    bool('invert', 'Invert', 'Flip the axis.', { default: false }),
    num('scale', 'Scale', 'Multiply the value.', { min: 0, minExclusive: true, max: 10, step: 0.1, unit: '×', default: 1 }),
  ]), { required: true, maxItems: MAX_INPUT_ACTIONS }),
  // The project's own input maps (a game mode activates maps; gameplay and ui always exist).
  list('maps', 'Project maps', `Up to ${MAX_INPUT_MAPS} input maps besides gameplay and ui (game modes activate maps).`, str('*', 'Map', 'A letter or _, then letters, digits or _.', { format: 'identifier', minLength: 1, maxLength: 32 }), { maxItems: MAX_INPUT_MAPS, unique: true }),
  // Free by default — a pointer-driven game needs a visible cursor; mouse-look opts in to locked.
  // Keyed by any map (gameplay, ui or the project's own).
  map('cursor', 'Cursor', 'The cursor while each map is active (absent: free): free, or locked (hidden and held in the view; its movement still counts, its position is the view\'s centre). The ui map\'s applies while a menu is open; during play the first of the active maps that sets one (a game mode\'s maps in their order). It is hidden while a gamepad drives the game.', 'Map', enm('*', 'Cursor', 'Free or locked while this map is active.', CURSOR_MODES, { default: 'free' }), { keyRef: 'inputMap', maxEntries: MAX_INPUT_MAPS + 2 }),
  // The project's own glyph images (absent: the engine's generic icons).
  map('glyphs', 'Glyphs', 'Glyph key → an image shown instead of the engine\'s generic icon. A key is an icon id (pad-south, pad-shoulder-left, mouse-left, key, …), optionally for one gamepad family (xbox:pad-south) or one key (key:Space).', 'Glyph', asset('*', 'Image', 'The texture shown for this glyph.', ['texture']), { maxEntries: MAX_INPUT_GLYPHS }),
], { default: JSON.parse(JSON.stringify(DEFAULT_INPUT)) as DescriptorJson, rules: ['Action names are unique.'] });

/** One shader parameter, as a descriptor field (the schema is in `MATERIAL_PARAMS`). */
function paramField(key: string, t: MaterialParamType, shader: string): FieldDescriptor {
  const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/\bao\b/i, 'AO');
  const w = when('../shader', shader);
  const tip = `The ${shader} shader\'s ${label.toLowerCase()} (absent: the file\'s value or the shader default).`;
  switch (t.kind) {
    case 'number':
      return num(key, label, tip, { when: w, min: t.min, max: t.max, step: t.max - t.min <= 1 ? 0.01 : 0.1, default: t.default });
    case 'color':
      return color(key, label, tip, { when: w, default: t.default });
    case 'bool':
      return bool(key, label, tip, { when: w, default: t.default });
    case 'enum':
      return enm(key, label, tip, t.values, { when: w, default: t.default });
    case 'vec2':
      return vec2(key, label, tip, { when: w, min: t.min, max: t.max, step: 0.01, default: [...t.default] });
  }
}

const MATERIAL_ITEM = obj('*', 'Material', 'A project material: a shader and overrides.', [
  str('materialId', 'Id', 'The stable material id.', { ...ID, required: true }),
  str('name', 'Name', 'Shown in pickers.', { ...NAME, required: true }),
  enm('shader', 'Shader', 'Standard, foliage (wind), kit (world-space detail), unlit, water or trim (a trim sheet: its row table in trim).', MATERIAL_SHADERS, { required: true, default: 'standard' }),
  obj('params', 'Parameters', 'Shader parameter overrides.', MATERIAL_SHADERS.flatMap((s) => Object.entries(MATERIAL_PARAMS[s]).map(([k, t]) => paramField(k, t, s))), { required: true, default: {} }),
  obj('textures', 'Textures', 'Texture slots.', MATERIAL_SHADERS.flatMap((s) => MATERIAL_TEXTURE_SLOTS[s].map((slot) => asset(slot, slot.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), `The ${s} shader\'s ${slot} texture.`, ['texture'], { when: when('../shader', s) }))), { required: true, default: {} }),
  // A graph material's exposed parameters and its node graph.
  list('parameters', 'Exposed parameters', `Up to ${MAX_MATERIAL_PARAMETERS} parameters the graph reads (Parameter nodes); objects may override the public ones.`, obj('*', 'Parameter', 'An exposed parameter.', [
    str('key', 'Key', 'The name Parameter nodes and overrides use.', { required: true, format: 'identifier', minLength: 1, maxLength: 32 }),
    enm('type', 'Type', 'The value type (colour is a vec3 edited as a colour; a texture names a texture asset).', MATERIAL_PARAMETER_TYPES, { required: true, default: 'float' }),
    json('default', 'Default', 'The material\'s own value (a number, 2–4 numbers, "#rrggbb", a texture asset id / "", or a data parameter\'s starting RGBA bytes).', { required: true, typedBy: 'materialParameter' }),
    num('min', 'Min', 'The lowest value, within ±1e6 (numbers and vectors).', { when: when('type', 'float', 'vec2', 'vec3', 'vec4') }),
    num('max', 'Max', 'The highest value, within ±1e6 and at least min (numbers and vectors).', { when: when('type', 'float', 'vec2', 'vec3', 'vec4') }),
    // A data parameter's grid (cells per side; 64 is the engine limit).
    vec2('size', 'Size', `A data parameter's cells [width, height], 1–${MATERIAL_DATA_MAX} each.`, { required: true, when: when('type', 'data'), labels: ['width', 'height'], min: 1, max: MATERIAL_DATA_MAX, step: 1, default: [8, 8] }),
    enm('visibility', 'Visibility', 'Public: objects may override it. Private: the material\'s value only.', ['public', 'private'], { default: 'public', omitDefault: true }),
    str('label', 'Label', 'Shown instead of the key.', { minLength: 1, maxLength: 64 }),
    str('group', 'Group', 'A foldable group in the Inspector.', { minLength: 1, maxLength: 64 }),
    str('tooltip', 'Tooltip', 'Help text.', { minLength: 1, maxLength: 256 }),
  ]), { maxItems: MAX_MATERIAL_PARAMETERS }),
  json('graph', 'Graph', 'The node graph (graph kind "material"): nodes, wires, groups and comments, edited in the Material tab with graph edits.', { readOnly: true }),
  // A material instance (its parent's look with some values changed).
  str('instanceOf', 'Instance of', 'A material instance: the parent material (or instance) whose look it takes.', { ...ID }),
  json('values', 'Parameter values', "An instance of a graph material: its values for the parent's parameters (parameter key → value)."),
  // A trim material's row table (trim-sheet.ts).
  obj('trim', 'Trim sheet', 'A trim material\'s row table: where each row (a strip that tiles along u) lies on the sheet, in pixels from the image\'s top. Generated architecture asks for rows by slot.', [
    vec2('size', 'Size', 'The sheet\'s width and height in pixels (its textures\' level 0).', { required: true, labels: ['width', 'height'], min: 1, max: TRIM_SHEET_SIZE_MAX, step: 1, unit: 'px', default: [...TRIM_SHEET_DEFAULTS.size] }),
    num('texelDensity', 'Texel density', 'Pixels per metre along a strip (each row may set its own).', { required: true, min: TRIM_DENSITY_MIN, max: TRIM_DENSITY_MAX, step: 1, unit: 'px', default: TRIM_SHEET_DEFAULTS.texelDensity }),
    int('padding', 'Padding', 'Pixels above and below every row that repeat its edge (or continue its wrap), so filtering and mips read only the row.', { required: true, min: 0, max: TRIM_PADDING_MAX, unit: 'px', default: TRIM_SHEET_DEFAULTS.padding }),
    list('rows', 'Rows', 'The rows, each a slot and its pixel bounds; rows do not overlap.', obj('*', 'Row', 'A row of the sheet.', [
      str('slot', 'Slot', `The semantic slot it fills (the starter layout: ${TRIM_STARTER_LAYOUT.join(', ')}); unique on the sheet.`, { ...ID, required: true }),
      int('top', 'Top', 'Its first pixel row (inside the sheet).', { required: true, min: 0, unit: 'px' }),
      int('bottom', 'Bottom', 'The pixel row below its last (exclusive; inside the sheet, below top).', { required: true, min: 1, unit: 'px' }),
      num('texelDensity', 'Texel density', 'Its own pixels per metre (absent: the sheet\'s).', { min: TRIM_DENSITY_MIN, max: TRIM_DENSITY_MAX, step: 1, unit: 'px' }),
      bool('tileV', 'Tiles in v', 'It tiles in v too: its padding continues its wrap.', { default: false, omitDefault: true }),
    ]), { required: true }),
  ], { required: true, when: when('shader', 'trim') }),
]);

// A visual effect (systems of particles, each a graph of kind "effect").
const EFFECT_ITEM = obj('*', 'Effect', 'A visual effect: particle systems simulated from one origin.', [
  str('effectId', 'Id', 'The stable effect id.', { ...ID, required: true, readOnly: true }),
  str('name', 'Name', 'Shown in pickers and the Effects list.', { ...NAME, required: true }),
  num('duration', 'Duration', 'One cycle of the effect (bursts and the effect time refer to it).', { required: true, min: 0.01, max: EFFECT_LIMITS.duration, step: 0.1, unit: 's', default: EFFECT_DEFAULTS.duration }),
  bool('loop', 'Loop', 'Restart the cycle at its end (off: spawning stops and the effect ends when its particles are gone).', { required: true, default: EFFECT_DEFAULTS.loop }),
  int('seed', 'Seed', 'The random seed: the same seed gives the same particles.', { required: true, min: 0, max: EFFECT_LIMITS.seed, default: EFFECT_DEFAULTS.seed }),
  obj('bounds', 'Bounds', 'The culling box around the origin: the effect is skipped when this box is off screen.', [
    vec3('center', 'Centre', 'The box centre relative to the origin.', { required: true, min: -EFFECT_LIMITS.extent, max: EFFECT_LIMITS.extent, step: 0.1, unit: 'm', default: [...EFFECT_DEFAULTS.bounds.center] }),
    vec3('size', 'Size', 'The box size.', { required: true, min: 0, max: EFFECT_LIMITS.extent, minExclusive: true, step: 0.1, unit: 'm', default: [...EFFECT_DEFAULTS.bounds.size] }),
  ], { required: true }),
  list('parameters', 'Exposed parameters', `Up to ${EFFECT_LIMITS.parameters} parameters the systems read (Parameter nodes); objects may override the public ones.`, obj('*', 'Parameter', 'An exposed parameter.', [
    str('key', 'Key', 'The name Parameter nodes and overrides use.', { required: true, format: 'identifier', minLength: 1, maxLength: 32 }),
    enm('type', 'Type', 'The value type.', EFFECT_PARAMETER_TYPES, { required: true, default: 'float' }),
    json('default', 'Default', 'The effect\'s own value (a number, 3 numbers or "#rrggbb").', { required: true, typedBy: 'effectParameter' }),
    num('min', 'Min', 'The lowest value, within ±1e6 (numbers and vectors).', { when: when('type', 'float', 'vec3') }),
    num('max', 'Max', 'The highest value, within ±1e6 and at least min (numbers and vectors).', { when: when('type', 'float', 'vec3') }),
    enm('visibility', 'Visibility', 'Public: objects may override it. Private: the effect\'s value only.', ['public', 'private'], { default: 'public', omitDefault: true }),
    str('label', 'Label', 'Shown instead of the key.', { minLength: 1, maxLength: 64 }),
    str('group', 'Group', 'A foldable group in the Inspector.', { minLength: 1, maxLength: 64 }),
    str('tooltip', 'Tooltip', 'Help text.', { minLength: 1, maxLength: 256 }),
  ]), { maxItems: EFFECT_LIMITS.parameters }),
  list('systems', 'Systems', `Up to ${EFFECT_LIMITS.systems} particle systems, in evaluation order.`, obj('*', 'System', 'A particle system.', [
    str('systemId', 'Id', 'The stable system id (unique in the effect).', { ...ID, required: true, readOnly: true }),
    str('name', 'Name', 'Shown in the Effect tab.', { ...NAME, required: true }),
    int('maxParticles', 'Max particles', 'The most living particles (executors may cap lower; the CPU fallback does).', { required: true, min: 1, max: EFFECT_LIMITS.maxParticles, default: EFFECT_DEFAULTS.maxParticles }),
    enm('space', 'Simulation space', 'Local: particles move with the object. World: they stay where they were born.', ['local', 'world'], { required: true, default: EFFECT_DEFAULTS.space }),
    json('graph', 'Graph', 'The system graph (graph kind "effect": Spawn, Initialize, Update and Output chains), edited in the Effect tab with graph edits.', { required: true, readOnly: true }),
  ]), { required: true, maxItems: EFFECT_LIMITS.systems, default: [] }),
]);

const CLIP = obj('clip', 'Clip', 'A named clip of a model asset.', [
  asset('assetId', 'Model', 'The model the clip is in.', ['model'], { required: true }),
  ref('clip', 'Clip', 'The clip name.', 'clip', { required: true }),
  num('duration', 'Length', 'The clip length (read from the file).', { required: true, min: 0.001, max: 600, unit: 's', readOnly: true }),
]);

const STATES = (allowEmpty: boolean): ListFieldDescriptor =>
  list('states', 'States', `1–${MAX_ANIMATOR_STATES} states.`, obj('*', 'State', 'A state: a clip or a 1D blend tree.', [
    str('id', 'Id', 'The stable state id (unique across layers).', { ...ID, required: true }),
    str('name', 'Name', 'Shown in the graph.', { ...NAME, required: true }),
    obj('motion', 'Motion', allowEmpty ? 'A clip, a blend tree, or nothing (the layers under it show through).' : 'A clip or a blend tree.', [
      enm('kind', 'Motion', 'What plays.', allowEmpty ? ['clip', 'blend1d', 'empty'] : ['clip', 'blend1d'], { required: true, default: 'clip', labels: { blend1d: 'Blend tree (1D)' } }),
      { ...CLIP, required: true, when: when('kind', 'clip') },
      ref('parameter', 'Parameter', 'The float or int parameter the tree blends by.', 'animatorParameter', { required: true, when: when('kind', 'blend1d'), paramTypes: ['float', 'int'] }),
      list('children', 'Clips', `2–${MAX_BLEND_CHILDREN} clips by threshold (increasing).`, obj('*', 'Blend clip', 'A clip and its threshold.', [
        num('threshold', 'Threshold', 'The parameter value where this clip plays fully.', { required: true, min: -1e6, max: 1e6, step: 0.1 }),
        { ...CLIP, required: true },
        num('speed', 'Ground speed', 'The ground speed the clip was authored for. Set on every clip, the tree reads its parameter as a ground speed and scales time so the blended speed matches it (feet stay planted between the thresholds).', { min: 0, max: MAX_BLEND_GROUND_SPEED, step: 0.1, unit: 'm/s' }),
        // Editor-only (the blend tree graph).
        vec2('position', 'Graph position', 'Where the blend tree graph draws the clip (editor only).', { min: -1e6, max: 1e6, step: 1 }),
      ]), { required: true, when: when('kind', 'blend1d'), minItems: 2, maxItems: MAX_BLEND_CHILDREN }),
    ], { required: true }),
    num('speed', 'Speed', 'Playback speed (× the speed parameter when set).', { required: true, min: 0, max: 10, step: 0.05, unit: '×', default: 1 }),
    ref('speedParameter', 'Speed parameter', 'A float parameter the speed is multiplied by.', 'animatorParameter', { paramTypes: ['float'] }),
    bool('loop', 'Loop', 'Loops (else holds the last frame).', { required: true, default: true }),
    // The graph editor's coordinate bound (GRAPH_LIMITS.coordinate).
    vec2('position', 'Graph position', 'Where the editor draws the state.', { min: -1e6, max: 1e6, step: 1 }),
  ]), { required: true, minItems: 1, maxItems: MAX_ANIMATOR_STATES });

const TRANSITIONS = list('transitions', 'Transitions', `Up to ${MAX_ANIMATOR_TRANSITIONS} transitions.`, obj('*', 'Transition', 'From a state (or any state) to a state, on conditions or at an exit time.', [
  ref('from', 'From', 'A state of this layer, or * (any state).', 'animatorState', { required: true, also: ['*'] }),
  ref('to', 'To', 'A state of this layer.', 'animatorState', { required: true }),
  list('conditions', 'Conditions', `Up to ${MAX_ANIMATOR_CONDITIONS}; all must hold.`, obj('*', 'Condition', 'A test on a parameter.', [
    ref('parameter', 'Parameter', 'The parameter tested.', 'animatorParameter', { required: true }),
    enm('op', 'Test', 'Numbers: greater/less/equals/not equals; bools: true/false; triggers: trigger.', ANIMATOR_CONDITION_OPS, { required: true, default: 'greater', labels: { notEquals: 'Not equals' } }),
    num('value', 'Value', 'Compared with.', { required: true, when: when('op', 'greater', 'less', 'equals', 'notEquals'), min: -1e6, max: 1e6, step: 0.1, default: 0 }),
  ]), { required: true, maxItems: MAX_ANIMATOR_CONDITIONS, default: [] }),
  num('duration', 'Crossfade', 'Blend time.', { required: true, min: 0, max: 10, step: 0.05, unit: 's', default: 0.2 }),
  num('exitTime', 'Exit time', 'Only after this normalized time of the source state (absent: any time).', { min: 0, max: 100, step: 0.05 }),
  enm('interruption', 'Interruption', 'None, or a newer transition from the current state may cut in.', ['none', 'source'], { default: 'none' }),
], { rules: ['A transition needs a condition or an exit time.'] }), { required: true, maxItems: MAX_ANIMATOR_TRANSITIONS, default: [] });

const ANIMATOR_ITEM = obj('*', 'Animator controller', 'A state machine for model animation.', [
  str('controllerId', 'Id', 'The stable controller id.', { ...ID, required: true }),
  str('name', 'Name', 'Shown in pickers.', { ...NAME, required: true }),
  list('parameters', 'Parameters', `Up to ${MAX_ANIMATOR_PARAMETERS} parameters (speed and grounded are set for the player automatically).`, obj('*', 'Parameter', 'A named value the transitions test.', [
    str('name', 'Name', 'A letter or _, then letters, digits or _.', { required: true, format: 'identifier', minLength: 1, maxLength: 64 }),
    enm('type', 'Type', 'Float, int, bool or trigger.', ANIMATOR_PARAMETER_TYPES, { required: true, default: 'float' }),
    num('default', 'Default', 'The starting value.', { when: when('type', 'float'), min: -1e6, max: 1e6, step: 0.1, default: 0 }),
    int('default', 'Default', 'The starting value.', { when: when('type', 'int'), min: -1e6, max: 1e6, default: 0 }),
    bool('default', 'Default', 'The starting value.', { when: when('type', 'bool'), default: false }),
  ]), { required: true, maxItems: MAX_ANIMATOR_PARAMETERS, default: [] }),
  STATES(false),
  TRANSITIONS,
  ref('entry', 'Entry state', 'The state the base layer starts in.', 'animatorState', { required: true }),
  list('events', 'Events', `Up to ${MAX_ANIMATOR_EVENTS} named events at clip times (scripts hear them).`, obj('*', 'Event', 'A named event at a time in a clip.', [
    asset('assetId', 'Model', 'The model the clip is in.', ['model'], { required: true }),
    ref('clip', 'Clip', 'The clip name.', 'clip', { required: true }),
    num('time', 'Time', 'Seconds into the clip.', { required: true, min: 0, max: 600, step: 0.01, unit: 's', default: 0 }),
    str('name', 'Name', 'A letter or _, then letters, digits or _.', { required: true, format: 'identifier', minLength: 1, maxLength: 64 }),
  ]), { required: true, maxItems: MAX_ANIMATOR_EVENTS, default: [] }),
  list('morphs', 'Morph targets', `Up to ${MAX_ANIMATOR_MORPHS} morph targets (blend shapes) whose weight follows a float parameter (clamped to 0–1); scripts may set others.`, obj('*', 'Morph target', 'A morph target driven by a parameter.', [
    str('target', 'Target', 'The morph target\'s name in the model.', { ...NAME, required: true }),
    ref('parameter', 'Parameter', 'The float parameter whose value (0–1) is the weight.', 'animatorParameter', { required: true, paramTypes: ['float'] }),
  ]), { maxItems: MAX_ANIMATOR_MORPHS }),
  list('layers', 'Layers', `1–${MAX_ANIMATOR_LAYERS} override layers over the base layer (absent: the base layer only).`, obj('*', 'Layer', 'An override layer driving some bones.', [
    str('name', 'Name', 'Shown in the editor.', { ...NAME, required: true }),
    list('mask', 'Bones', `The bones this layer drives (up to ${MAX_LAYER_MASK}; empty: every bone).`, str('*', 'Bone', 'A bone (node) name of the model\'s skeleton.', { ...NAME, format: 'boneName' }), { required: true, maxItems: MAX_LAYER_MASK, unique: true, default: [] }),
    num('weight', 'Weight', 'How much the layer replaces the ones under it.', { required: true, min: 0, max: 1, step: 0.05, default: 1 }),
    ref('weightParameter', 'Weight parameter', 'A float parameter (0–1) the weight is multiplied by.', 'animatorParameter', { paramTypes: ['float'] }),
    STATES(true),
    TRANSITIONS,
    ref('entry', 'Entry state', 'The state the layer starts in.', 'animatorState', { required: true }),
  ]), { minItems: 1, maxItems: MAX_ANIMATOR_LAYERS }),
], { rules: ['Parameter names and state ids are unique; references name parameters and states of this controller.'] });

const DECLARED_PROPERTY = obj('*', 'Property', 'A property the script declares (shown per object).', [
  str('key', 'Key', 'The property key the script reads (a lowercase letter, then lowercase letters, digits or _).', { required: true, format: 'identifier', minLength: 1, maxLength: 64 }),
  str('label', 'Label', 'Shown in the Inspector.', { required: true, minLength: 1, maxLength: 64 }),
  enm('type', 'Type', 'The value type.', ['number', 'boolean', 'string', 'enum', 'vec3', 'entityRef', 'assetRef'], { required: true, default: 'number', labels: { vec3: 'Vector', entityRef: 'Object', assetRef: 'Asset' } }),
  json('default', 'Default', 'The value when an object sets none (of the declared type).', { required: true, typedBy: 'propertyType' }),
  num('min', 'Min', 'Smallest number.', { when: when('type', 'number'), min: -1e12, max: 1e12 }),
  num('max', 'Max', 'Largest number.', { when: when('type', 'number'), min: -1e12, max: 1e12 }),
  num('step', 'Step', 'Increment of the number field.', { when: when('type', 'number'), min: 0, minExclusive: true, max: 1e6 }),
  int('maxLength', 'Max length', 'Longest string (default 256).', { when: when('type', 'string'), min: 1, max: 1024, default: 256 }),
  list('values', 'Values', `1–${MAX_ENUM_VALUES} choices.`, str('*', 'Value', 'A choice (1–64 characters).', { minLength: 1, maxLength: 64 }), { required: true, when: when('type', 'enum'), minItems: 1, maxItems: MAX_ENUM_VALUES, unique: true }),
  obj('bounds', 'Bounds', 'Per-axis limits of a vector.', [
    vec3('min', 'Min', 'Smallest per axis.', { required: true, min: -1e6, max: 1e6 }),
    vec3('max', 'Max', 'Largest per axis.', { required: true, min: -1e6, max: 1e6 }),
  ], { when: when('type', 'vec3'), rules: ['min ≤ max per axis'] }),
  // Public (shown and set per object) or private (the script reads the default).
  enm('visibility', 'Visibility', 'Public: shown in the Inspector of every object with this script and set per object. Private: not shown, not settable; the script reads the default.', ['public', 'private'], { default: 'public' }),
  str('group', 'Group', 'The Inspector section the property is listed in.', { minLength: 1, maxLength: 64 }),
  str('header', 'Header', 'A heading shown above the property in the Inspector.', { minLength: 1, maxLength: 64 }),
  str('tooltip', 'Tooltip', 'The help shown when hovering the property.', { minLength: 1, maxLength: 256 }),
], { rules: ['min ≤ max; the default fits the type and its limits.'] });

const settingsUnit = (u: string): DescriptorUnit => (u === 'm/s^2' ? 'm/s²' : u === 'degrees' ? 'deg' : (u as DescriptorUnit));
const settingsLabel = (key: string): string => key.replace(/_deg$/, '').replace(/_y$/, '').split('_').map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
const SETTINGS: FieldDescriptor = obj('settings', 'Gameplay settings', 'The player character\'s physics and movement, and the engine settings (step rate, sound voices, music fade, animation blend).', M2_SETTINGS_KEYS.map((s): FieldDescriptor => {
  const common = {
    ...(s.min !== undefined ? { min: s.min } : {}),
    ...(s.max !== undefined ? { max: s.max } : {}),
    ...(s.group !== undefined ? { group: s.group } : {}),
    ...(s.unit !== '' ? { unit: settingsUnit(s.unit) } : {}),
    default: s.default,
  };
  const label = s.label ?? settingsLabel(s.key);
  const tooltip = s.tooltip ?? `${s.key} (${s.unit}).`;
  if (s.integer === true) return int(s.key, label, tooltip, { ...common, ...(s.values !== undefined ? { values: [...s.values] } : {}), ...(s.valueLabels !== undefined ? { valueLabels: [...s.valueLabels] } : {}) });
  return num(s.key, label, tooltip, {
    ...common,
    ...(s.minExclusive === true ? { minExclusive: true } : {}),
    ...(s.maxExclusive === true ? { maxExclusive: true } : {}),
    step: 0.1,
  });
}), { required: true, default: {}, rules: ['min_slope_slide_deg ≤ max_slope_climb_deg'] });

/** One piece of a connected block type: the look it shows and a turn added for looks made facing another way. */
const connectPiece = (key: string, label: string, tooltip: string): FieldDescriptor =>
  obj(key, label, tooltip, [int('variant', 'Look', 'Variant index.', { required: true, min: 0, max: BLOCK_LIMITS.variants - 1, default: 0 }), int('rot', 'Extra turn', 'Degrees (edges: 0, 180).', { values: [0, 90, 180, 270], default: 0, omitDefault: true })]);

export const CONTENT: readonly ContentBlockDescriptor[] = [
  { key: 'environment', label: 'Environment', tooltip: 'The quality levels, the default level and the environment presets (each scene has its own look).', required: false, value: ENVIRONMENT, ops: ['setEnvironment'] },
  { key: 'input', label: 'Input', tooltip: 'Actions and their bindings.', required: false, value: INPUT, ops: ['setInput'] },
  { key: 'materials', label: 'Materials', tooltip: 'Project materials.', required: false, value: list('materials', 'Materials', 'The project\'s materials (each its own file).', MATERIAL_ITEM, { default: [] }), ops: ['setMaterial', 'deleteMaterial'] },
  { key: 'animators', label: 'Animator controllers', tooltip: 'State machines for model animation.', required: false, value: list('animators', 'Animator controllers', 'The project\'s controllers (each its own file).', ANIMATOR_ITEM, { default: [] }), ops: ['setAnimator', 'deleteAnimator'] },
  // Visual effects; each system's graph is edited in the Effect tab (graphEdit ops).
  { key: 'effects', label: 'Effects', tooltip: 'Visual effects: particle systems authored as node graphs.', required: false, value: list('effects', 'Effects', 'The project\'s effects (each its own file).', EFFECT_ITEM, { default: [] }), ops: ['setEffect', 'deleteEffect', 'renameEffect', 'graphEdit'] },
  // Shared script libraries; their files are edited in the script editor (Library tab).
  { key: 'scriptLibraries', label: 'Script libraries', tooltip: 'Shared TypeScript and JSON modules every script can import as @lib/<id>.', required: false, value: list('scriptLibraries', 'Script libraries', 'The project\'s libraries (each its own file).', json('*', 'Library', 'A script library: { libraryId, name, files: [{ path, text }] }.', { readOnly: true, shape: 'ScriptLibrary' }), { default: [] }), ops: ['setScriptLibrary', 'deleteScriptLibrary'] },
  // Block types, the cell metadata schema and stamps for block layers.
  {
    key: 'blockTypes',
    label: 'Block types',
    tooltip: 'The blocks block layers are built from: their looks, collision shape, footprint, rotations and default cell metadata.',
    required: false,
    value: list('blockTypes', 'Block types', 'The project\'s block types.', obj('*', 'Block type', 'One block.', [
      str('blockId', 'Id', 'The stable block id cells name.', { ...ID, required: true }),
      str('name', 'Name', 'Shown in the block palette.', { ...NAME, required: true }),
      json('variants', 'Looks', `1–${BLOCK_LIMITS.variants} weighted looks: {model: {assetId, piece?}} | {prefab} | {color: "#rrggbb"}, each with an optional weight (a cell without a variant picks one by weight, stably by position) and an optional uv ("model" | "world") of its own.`, { required: true, shape: 'BlockVariant[]' }),
      enm('uv', 'Texture mapping', "Where the looks' texture coordinates come from. Model: the model's own (a coloured stand-in, or a model part without any, is mapped to the world). World: from the block's place in the layer, in metres, one flat projection per face (tops from above, walls from the side, slopes past 45° as walls), so a texture runs on across cells without a seam; a material's tiling sets how many metres one repeat covers. A look may set its own.", BLOCK_UV_MODES, { default: 'model', labels: { model: 'Model', world: 'World (metres)' } }),
      enm('shape', 'Collision shape', 'The collision shape (and the coloured stand-in\'s shape): full, half, ramp, stairs (rising toward +Z), custom boxes or none.', ['full', 'half', 'ramp', 'stairs', 'custom', 'none'], { required: true }),
      json('boxes', 'Custom boxes', `1–${BLOCK_LIMITS.customBoxes} boxes [x0, y0, z0, x1, y1, z1] in footprint units (0–1).`, { required: true, when: when('shape', 'custom') }),
      bool('solid', 'Solid', 'Fills its cell and hides the faces of neighbours touching it (absent: a full shape is solid).'),
      vec3('footprint', 'Footprint', 'Cells along x, y and z (a 2 × 1 × 2 well); the cells it covers stay empty.', { min: 1, max: BLOCK_LIMITS.footprint, step: 1, default: [1, 1, 1], labels: ['x', 'y', 'z'] }),
      json('rotations', 'Rotations', 'The allowed rotations in degrees: a set of 0, 90, 180, 270 (absent: all).'),
      json('metadata', 'Default metadata', 'Cell metadata every cell of this block starts with (field key → value).'),
      // A picker per slot (as a model asset's default materials); "*" also maps a stand-in's one material.
      map('materials', 'Materials', 'Material slot → project material: a model look\'s source material name, or "*" for every slot (a coloured stand-in has one: "*" gives it a material, e.g. a painted terrain material).', 'Slot', ref('*', 'Material', 'A project material.', 'material'), { keyFormat: 'materialSlot', minEntries: 1, maxEntries: 32 }),
      bool('live', 'Live', "In the running game each cell showing a prefab look spawns that prefab as real objects (scripts, movers, lights, children), placed, removed and saved with the cell; the root's model stays merged with the blocks."),
      enm('placement', 'Placement', 'Cell: the block fills cells. Edge: it stands on the edge between two cells (a wall, door, window, fence), drawn along the edge and facing across it; its shape is a thin slab (full, half), boxes or none.', ['cell', 'edge'], { default: 'cell', labels: { cell: 'Cell', edge: 'Edge' } }),
      bool('blocking', 'Blocks passage', 'An edge piece blocks moving across its edge (grid movement and pathfinding read it); an open one (a door) never does.', { default: true, when: when('placement', 'edge') }),
      obj('connect', 'Connections', "The look follows the neighbours: paint the block and each cell (or edge) shows the straight, corner, T-join, cross, end, base or cap piece its neighbours call for, turned to fit. A piece not set keeps the ordinary look; a cell that names a variant keeps it.", [
        list('with', 'Connects with', 'Other block types (of the same placement) that count as connected; the block itself always does.', str('*', 'Block type', 'A block type id.', { ...ID }), { maxItems: BLOCK_CONNECT_WITH_MAX, unique: true, default: [] }),
        obj('pieces', 'Pieces', 'The look of each piece (unturned neighbours in its own frame).', [
          connectPiece('single', 'Single', 'No neighbour.'),
          connectPiece('end', 'End', 'One neighbour (+Z unturned); an edge piece: joined at +X only.'),
          connectPiece('straight', 'Straight', 'Two opposite (−Z, +Z); an edge piece: both ends joined.'),
          connectPiece('corner', 'Corner', 'Two at a right angle (+X, +Z); an edge piece: a turn at +X.'),
          connectPiece('t', 'T-join', 'Three (−X, +X, +Z). Cells only.'),
          connectPiece('cross', 'Cross', 'All four. Cells only.'),
          connectPiece('base', 'Base', 'One above, none below.'),
          connectPiece('cap', 'Cap', 'One below, none above.'),
        ], { required: true, default: {} }),
      ]),
      map('kits', 'Kits', "What the block shows under each kit (a burnt, ruined or winter set): a layer, or a region of it, that shows the kit draws this block type instead, without changing the cells. The target keeps the layout: the same placement and footprint. A kit is every block's entry under one name.", 'Kit', obj('*', 'Swap', 'The block shown under this kit.', [
        str('block', 'Block', 'The block type drawn instead (the same placement and footprint).', { ...ID, required: true }),
        int('variant', 'Look', "The target's look (absent: the cell's own when the target has it, else one picked by the target's weights; a connected target keeps resolving its pieces).", { min: 0, max: BLOCK_LIMITS.variants - 1 }),
        list('variants', 'Look per look', "Per look of this block (in order): the target's look shown. Wins over Look.", int('*', 'Look', 'Variant index of the target.', { min: 0, max: BLOCK_LIMITS.variants - 1 }), { maxItems: BLOCK_LIMITS.variants }),
      ]), { keyFormat: 'id', minEntries: 1 }),
    ]), { default: [] }),
    ops: ['setBlockType', 'deleteBlockType'],
  },
  {
    key: 'cellFields',
    label: 'Cell fields',
    tooltip: 'The project\'s cell metadata schema (walkable, slippery, move cost, terrain…): what every block-layer cell can carry.',
    required: false,
    value: list('cellFields', 'Cell fields', `Up to ${BLOCK_LIMITS.cellFields} fields.`, obj('*', 'Cell field', 'One metadata field.', [
      str('key', 'Key', 'The field name scripts read (an identifier).', { required: true, format: 'identifier', minLength: 1, maxLength: 32 }),
      enm('type', 'Type', 'Boolean, choice, whole number, number or text.', ['bool', 'enum', 'int', 'float', 'string'], { required: true }),
      json('default', 'Default', 'The value a cell has when neither its block nor the cell sets one (absent: false / the first choice / 0 / "").'),
      list('values', 'Choices', `The choices (1–${BLOCK_LIMITS.enumValues}).`, str('*', 'Choice', 'One choice.', { minLength: 1, maxLength: BLOCK_LIMITS.stringLength }), { required: true, minItems: 1, maxItems: BLOCK_LIMITS.enumValues, unique: true, when: when('type', 'enum') }),
      num('min', 'Min', 'The smallest value.', { when: when('type', 'int', 'float') }),
      num('max', 'Max', 'The largest value.', { when: when('type', 'int', 'float') }),
      color('color', 'Overlay colour', 'The colour the editor paints this field with.'),
      str('label', 'Label', 'Shown in the editor.', { minLength: 1, maxLength: 64 }),
    ]), { maxItems: BLOCK_LIMITS.cellFields, default: [] }),
    ops: ['setCellFields'],
  },
  {
    key: 'blockStamps',
    label: 'Block stamps',
    tooltip: 'Saved patterns of cells (a cottage footprint, a bridge span) placed on block layers.',
    required: false,
    value: list('blockStamps', 'Block stamps', 'The project\'s stamps.', obj('*', 'Stamp', 'A saved pattern.', [
      str('stampId', 'Id', 'The stable stamp id.', { ...ID, required: true }),
      str('name', 'Name', 'Shown in the stamp list.', { ...NAME, required: true }),
      vec3('size', 'Size', 'The pattern\'s extent in cells.', { required: true, min: 1, max: BLOCK_LIMITS.stampSize, step: 1, labels: ['x', 'y', 'z'] }),
      json('palette', 'Palette', 'The cell values the runs name.', { required: true, readOnly: true }),
      json('columns', 'Cells', `Run-length columns [x, z, y, n, p, …] (at most ${BLOCK_LIMITS.stampCells} cells).`, { required: true, readOnly: true }),
      json('edgePalette', 'Edge pieces', 'The edge values the edge rows name.', { readOnly: true }),
      json('edges', 'Edges', 'Edge rows [x, z, y, axis, p] (the outline included).', { readOnly: true }),
    ]), { default: [] }),
    ops: ['setBlockStamp', 'deleteBlockStamp'],
  },
  // Project UI documents and themes (JSON widget trees, also edited in the visual UI editor).
  { key: 'uiDocuments', label: 'UI documents', tooltip: 'HUDs, menus and screens drawn by the game over the view (widget trees bound to script values).', required: false, value: list('uiDocuments', 'UI documents', 'The project\'s documents (each its own file).', json('*', 'Document', 'A UI document: { uiDocumentId, name, root, styles?, tweens?, … }.', { readOnly: true, shape: 'UiDocument' }), { default: [] }), ops: ['setUiDocument', 'deleteUiDocument'] },
  // Game modes (the first is the start mode) and the behavior groups modes tick.
  { key: 'modes', label: 'Game modes', tooltip: 'Named states of the running game: the input maps, camera, UI documents and ticking behavior groups of each, switched in one transition without a scene load (explore and tactical, on foot and driving, build and play…). The first mode is the one a run starts in.', required: false, value: list('modes', 'Game modes', `Up to ${MODE_LIMITS.modes} modes; the first is the start mode.`, MODE_ITEM, { maxItems: MODE_LIMITS.modes, default: [] }), ops: ['setModes'] },
  { key: 'behaviorGroups', label: 'Behavior groups', tooltip: 'Names an object\'s behavior can belong to (its Behavior group component); a game mode lists the groups that tick while it is active.', required: false, value: list('behaviorGroups', 'Behavior groups', `Up to ${MODE_LIMITS.behaviorGroups} names.`, str('*', 'Group', 'A letter or _, then letters, digits or _.', { format: 'identifier', minLength: 1, maxLength: 32 }), { maxItems: MODE_LIMITS.behaviorGroups, unique: true, default: [] }), ops: ['setBehaviorGroups'] },
  // The game shell — menus and HUD as UI documents, the ordered scene list (a game that plays as a scene).
  {
    key: 'shell',
    label: 'Game shell',
    tooltip: 'The menus around the game and its HUD, drawn with the project\'s UI documents: a title before play, pause, settings, controls (rebinding) and the save and load screens (project saves), the HUD shown while playing, and the game\'s scenes in order for New game and Next scene.',
    required: false,
    value: obj('shell', 'Game shell', 'Menus, HUD and the scene list of a game without the game session.', [
      obj('screens', 'Screens', 'The UI document drawn for each shell screen. Its buttons use the engine actions: new game, continue, resume, back, open a screen, save or load a slot, set a volume, rebind, next scene.', [
        ref('title', 'Title', 'Shown before play (the game waits behind it); absent: the game starts at once.', 'uiDocument'),
        ref('pause', 'Pause', 'Shown while paused (absent: the engine\'s pause panel, with Resume only).', 'uiDocument'),
        ref('settings', 'Settings', 'Opened by the settings or open action (volumes, quality).', 'uiDocument'),
        ref('controls', 'Controls', 'The rebinding screen (rebind actions; $flow.input lists the actions and their keys).', 'uiDocument'),
        ref('save', 'Save', 'Save slots (project saves; $flow.saves lists them).', 'uiDocument'),
        ref('load', 'Load', 'Load slots (project saves).', 'uiDocument'),
      ]),
      obj('simulate', 'While shown', 'What runs under each screen: the engine pause (no steps), or the scripts outside behavior groups (physics and grouped scripts held) — a title or menu its scripts animate.', SHELL_SCREENS.map((k) => enm(k, k.charAt(0).toUpperCase() + k.slice(1), `What runs while the ${k} screen shows.`, SHELL_SIMULATE, { default: 'pause', labels: { pause: 'Pause', scripts: 'Scripts run' } }))),
      list('hud', 'HUD', `UI documents shown while the game plays (hidden behind the menus); bind to $flow.counters, $flow.health, $flow.prompts or script values. Up to ${SHELL_LIMITS.hud}.`, ref('*', 'Document', 'A UI document.', 'uiDocument'), { maxItems: SHELL_LIMITS.hud, unique: true }),
      list('scenes', 'Scene list', `The game's scenes in order: New game begins a fresh run at the first, Next scene moves on to the next.`, obj('*', 'Listed scene', 'A scene and where the character starts in it.', [
        scene('scene', 'Scene', 'A scene of the project.', { required: true }),
        entity('spawn', 'Spawn', 'The player spawn the character starts at (in that scene; absent: it stays where it is).', { component: 'playerSpawn', anyScene: true }),
        // The fade of a move to this scene.
        num('fade', 'Fade', 'Seconds the view fades out before a move to this scene and back in after it (absent or 0: no fade; the previous scene stays in view until this one is drawn).', { min: 0, max: MAX_TRANSITION_FADE, step: 0.05 }),
        color('fadeColor', 'Fade colour', 'The colour the view fades to (absent: black).'),
      ])),
      bool('pause', 'Pause allowed', 'The pause input opens the pause screen.', { default: true }),
      bool('status', 'Status line', 'A small debug line: the shell screen, the listed scene and the input prompts.', { default: false }),
    ]),
    ops: ['setShell'],
  },
  // The event → cue table (the generic replacement for fixed cue slots).
  {
    key: 'eventCues',
    label: 'Event sounds',
    tooltip: 'Sounds the game plays when a signal is sent or an event happens (a trigger entered, something collected, damaged, touched…), by name.',
    required: false,
    value: list('eventCues', 'Event sounds', 'One row per signal or event that plays a sound.', obj('*', 'Event sound', 'One sound for one signal or event.', [
      enm('on', 'On', 'A signal (by its name) or an event scripts see in ctx.events (by its type: enter, exit, collected, damaged, died, contact…, or an animator clip event\'s name).', EVENT_CUE_SOURCES, { required: true, default: 'signal', labels: { signal: 'Signal', event: 'Event' } }),
      str('name', 'Name', 'The signal\'s name, or the event\'s type or name.', { required: true, minLength: 1, maxLength: EVENT_CUE_LIMITS.name, default: 'trigger' }),
      entity('entity', 'Object', 'Only this object\'s events (absent: any object\'s).', { when: when('on', 'event'), anyScene: true }),
      asset('assetId', 'Sound', 'The audio asset played.', ['audio'], { required: true }),
      num('volume', 'Volume', 'How loud (0–1).', { min: 0, max: 1, step: 0.05, default: 1 }),
      enm('bus', 'Bus', 'The mixer bus it plays on.', EVENT_CUE_BUSES, { default: 'sfx' }),
      int('maxLateMs', 'Late by at most', 'When its file is not loaded yet, it still starts this long after the event; later it is dropped.', { min: 0, max: AUDIO_MAX_LATE_MS_LIMIT, unit: 'ms', default: AUDIO_MAX_LATE_MS_DEFAULT }),
    ]), { default: [] }),
    ops: ['setEventCues'],
  },
  { key: 'uiThemes', label: 'UI themes', tooltip: 'Named styles and icons UI documents share.', required: false, value: list('uiThemes', 'UI themes', 'The project\'s themes (each its own file).', json('*', 'Theme', 'A UI theme: { uiThemeId, name, styles, icons? }.', { readOnly: true, shape: 'UiTheme' }), { default: [] }), ops: ['setUiTheme', 'deleteUiTheme'] },
  // Dialogue — conversations (dialogue graphs, edited in the Dialogue tab with graphEdit), the speaker registry, the settings.
  { key: 'dialogues', label: 'Dialogues', tooltip: 'Conversations: node graphs of lines (speaker, expression, text, voice clip), choices, conditions and effects, signals and jumps.', required: false, value: list('dialogues', 'Dialogues', 'The project\'s conversations (each its own file).', json('*', 'Dialogue', 'A conversation: { dialogueId, name, graph } (graph kind dialogue).', { readOnly: true, shape: 'DialogueDocument' }), { default: [] }), ops: ['setDialogue', 'deleteDialogue', 'graphEdit'] },
  { key: 'speakers', label: 'Speakers', tooltip: 'Who speaks in conversations: name, name-plate colour, portraits per expression, voice profile, text blip.', required: false, value: list('speakers', 'Speakers', 'The project\'s speakers.', json('*', 'Speaker', 'A speaker: { speakerId, name, color?, portraits? {expression: texture}, defaultExpression?, voiceProfile?, blip?, blipEvery?, blipVolume? }.', { readOnly: true, shape: 'DialogueSpeaker' }), { default: [] }), ops: ['setSpeaker', 'deleteSpeaker'] },
  { key: 'dialogueSettings', label: 'Dialogue settings', tooltip: 'Text speed, auto-advance and its delay, the music/SFX duck under a voice, the backlog length, the dialogue UI document and theme.', required: false, value: json('dialogueSettings', 'Dialogue settings', '{ textSpeed? (chars/s, 0 instant), autoAdvance?, autoDelay? (s), duck? (0–1), backlog? (1–100), document? (uiDocumentId), theme? (uiThemeId), voiceMaxLateMs? (ms a voice whose file is not loaded may still start late; 1000) }.', { readOnly: true, shape: 'DialogueSettings' }), ops: ['setDialogueSettings'] },
  // Timelines (tracks of keys on a time ruler; edited in the Timeline tab).
  { key: 'timelines', label: 'Timelines', tooltip: 'Sequences of camera cuts, moves, animation, sound, dialogue, effects, signals and fades on a time ruler, played by scripts or signals.', required: false, value: list('timelines', 'Timelines', 'The project\'s timelines (each its own file).', json('*', 'Timeline', 'A timeline: { timelineId, name, duration, slots?, markers?, tracks, … }.', { readOnly: true, shape: 'TimelineAsset' }), { default: [] }), ops: ['setTimeline', 'deleteTimeline'] },
  // Standalone node graphs; their body is edited in the graph editor (graphEdit ops).
  { key: 'graphs', label: 'Graphs', tooltip: 'Standalone node graphs, edited in the graph editor.', required: false, value: list('graphs', 'Graphs', 'The project\'s graphs (each its own file).', json('*', 'Graph', 'A graph document: { graphId, kind, name, graph }.', { readOnly: true, shape: 'GraphDocument' }), { default: [] }), ops: ['setGraph', 'deleteGraph', 'graphEdit'] },
  { key: 'tags', label: 'Tags', tooltip: 'Named tag bits objects carry.', required: false, value: list('tags', 'Tags', `Up to ${MAX_TAGS} tags.`, obj('*', 'Tag', 'A named bit.', [int('bit', 'Bit', 'The bit (0–31).', { required: true, min: 0, max: 31 }), str('name', 'Name', 'A letter, then letters, digits, _ or - (unique ignoring case).', { required: true, format: 'identifier', minLength: 1, maxLength: 32 })]), { maxItems: MAX_TAGS, default: [] }), ops: ['setTags'] },
  // Named collision layers (3D physics); "default" is implicit.
  // The resources' addresses and labels (each resource file holds its own; assets keep theirs on their records).
  {
    key: 'loadable',
    label: 'Loadable resources',
    tooltip: 'The resources (prefabs, materials, dialogue, …) a script may load by address or label; Play and export ship them even when no scene uses them.',
    required: false,
    value: list('loadable', 'Loadable resources', 'One entry per resource with an address or labels.', obj('*', 'Resource', 'A resource and the names scripts load it by.', [
      enm('kind', 'Kind', 'The resource kind.', RESOURCE_KIND_TABLE.map((k) => k.kind), { required: true, default: 'prefab' }),
      str('id', 'Id', 'The resource id.', { ...ID, required: true }),
      str('address', 'Address', 'The one name a script loads it by (unique in the project).', { minLength: 1, maxLength: ADDRESS_MAX_LENGTH }),
      list('labels', 'Labels', 'Names a script loads it by, with everything else carrying them (ascending).', str('*', 'Label', 'A letter or digit, then letters, digits, _ - . /.', { minLength: 1, maxLength: ASSET_LABEL_MAX_LENGTH }), { minItems: 1, unique: true }),
    ]), { default: [] }),
    ops: ['setLabels', 'setAddress'],
  },
  { key: 'collisionLayers', label: 'Collision layers', tooltip: 'Named collision layers colliders are in and script queries filter by (3D; "default" is implicit).', required: false, value: list('collisionLayers', 'Collision layers', `Up to ${MAX_COLLISION_LAYERS} names ("default" is implicit).`, str('*', 'Layer', 'A letter or _, then letters, digits or _.', { format: 'identifier', minLength: 1, maxLength: 32 }), { maxItems: MAX_COLLISION_LAYERS, unique: true, default: [] }), ops: ['setCollisionLayers'] },
  { key: 'lightLayers', label: 'Light layers', tooltip: 'Names of the light layers by number (editor labels: objects, lights and scripts use the layer masks).', required: false, value: list('lightLayers', 'Light layers', `Up to ${LIGHT_LAYER_COUNT} names, the first naming layer 1 ("" leaves one unnamed).`, str('*', 'Layer', 'A name of up to 32 characters ("" for none).', { maxLength: MAX_LIGHT_LAYER_NAME }), { maxItems: LIGHT_LAYER_COUNT, default: [] }), ops: ['setLightLayers'] },
  // The project save schema (save document version + migrations, slots, sections, picture, settings document).
  {
    key: 'saveSchema',
    label: 'Project saves',
    tooltip: 'The project save document (its version and migrations), the slot count, the engine state every save includes, the slot picture and the settings document the game writes.',
    required: false,
    value: obj('saveSchema', 'Project saves', 'The save schema.', [
      int('version', 'Version', 'The save document\'s schema version (older saves are migrated on load).', { required: true, min: 1, max: SAVE_LIMITS.version }),
      int('slots', 'Slots', `Numbered save slots (engine limit ${SAVE_LIMITS.slots}).`, { required: true, min: 1, max: SAVE_LIMITS.slots }),
      list('migrations', 'Migrations', 'For each older version, the script function (ctx.saves.migration) that upgrades a document by one version.', obj('*', 'Migration', 'One upgrade step.', [
        int('from', 'From version', 'The version it upgrades from (to from + 1; below the schema version).', { required: true, min: 1 }),
        str('name', 'Function', 'The name a script registers with ctx.saves.migration.', { required: true, minLength: 1, maxLength: 64 }),
      ], { rules: ['one migration per version; from < version'] }), { maxItems: SAVE_LIMITS.migrations }),
      list('sections', 'Included state', 'Engine state every save includes: block cells, material values, spawned objects, script storage, the environment blend, dialogue variables and seen lines, objects\' health, collectibles, patrols and hitboxes, and where the play stands (world: the loaded scenes and the player\'s place, which a load moves the game to).', enm('*', 'Section', 'One kind of engine state.', [...SAVE_SECTIONS]), { maxItems: SAVE_SECTIONS.length }),
      bool('legacyWorld', 'Always save the world', 'Without world in the sections, false keeps no world in a save (the game restores scenes and its player itself); absent or true keeps the deprecated always-on world.', { default: true }),
      obj('thumbnail', 'Slot picture', 'The size and format of a slot\'s picture of the view (absent: 256 × 144 JPEG).', [
        int('width', 'Width', 'Pixels.', { required: true, min: 16, max: SAVE_LIMITS.thumbnailSide }),
        int('height', 'Height', 'Pixels.', { required: true, min: 16, max: SAVE_LIMITS.thumbnailSide }),
        enm('format', 'Format', 'JPEG or WebP.', ['jpeg', 'webp'], { required: true }),
        num('quality', 'Quality', 'Encoder quality.', { min: 0.1, max: 1, step: 0.05 }),
      ]),
      list('settings', 'Settings document', `Up to ${SAVE_LIMITS.settingsFields} fields the game's settings screen writes (ctx.saves.setSetting): { key, type: bool|number|string|enum, default, label?, min?, max?, values?, engine?: music|sfx|ui|quality|frameRateCap }.`, json('*', 'Setting', 'One settings field.', { shape: 'SettingsField' }), { maxItems: SAVE_LIMITS.settingsFields }),
    ], { rules: ['a default fits its field; a volume binding is a 0–1 number, a quality binding an enum of low/medium/high'] }),
    ops: ['setSaveSchema'],
  },
  { key: 'settings', label: 'Gameplay settings', tooltip: 'Gravity, run speed, jump, slopes, and the engine settings (step rate, sound voices, music fade, animation blend).', required: true, value: SETTINGS, ops: ['setSettings'] },
  { key: 'scenes', label: 'Scenes', tooltip: 'The project\'s scenes.', required: true, value: list('scenes', 'Scenes', 'At least one scene.', obj('*', 'Scene', 'A scene file.', [str('sceneId', 'Id', 'The stable scene id.', { ...ID, required: true, readOnly: true }), str('name', 'Name', 'Shown in the scene list.', { ...NAME, required: true })]), { required: true, minItems: 1 }), ops: ['createScene', 'renameScene', 'deleteScene'] },
  { key: 'startScenes', label: 'Start scenes', tooltip: 'The scenes loaded when the game starts (without a flow).', required: true, value: list('startScenes', 'Start scenes', 'At least one scene.', scene('*', 'Scene', 'A start scene.'), { required: true, minItems: 1, unique: true }), ops: ['setStartScenes'] },
  {
    key: 'assets',
    label: 'Assets',
    tooltip: 'Imported models, audio, textures and fonts (their versions are written by the importer).',
    required: true,
    value: list('assets', 'Assets', 'The asset catalog.', obj('*', 'Asset', 'An imported asset.', [
      str('assetId', 'Id', 'The stable asset id.', { ...ID, required: true, readOnly: true }),
      enm('kind', 'Kind', 'Model, audio, texture or font.', ASSET_KINDS, { required: true, readOnly: true }),
      str('displayName', 'Name', 'Shown in the asset browser.', { ...NAME, required: true, readOnly: true }),
      int('currentVersion', 'Version', 'The current version (the last).', { required: true, min: 1, readOnly: true }),
      list('versions', 'Versions', 'Every imported version (append-only, written by the importer).', json('*', 'Version', 'An imported version: source, recipe and metrics.', { readOnly: true }), { required: true, minItems: 1, readOnly: true }),
      enm('vertexColors', 'Vertex colours', 'Data: COLOR_0 feeds shaders (wind weights). Tint: multiplies the colour.', ['data', 'tint'], { when: when('kind', 'model'), default: 'data', omitDefault: true }),
      map('materials', 'Default materials', 'Material slot → project material, for every placement.', 'Slot', ref('*', 'Material', 'A project material.', 'material'), { when: when('kind', 'model'), keyFormat: 'materialSlot', minEntries: 1, maxEntries: MAX_MATERIAL_SLOTS }),
      bool('extractTextures', 'Extract textures', 'Import setting: the file\'s images become texture assets the model draws with (they count and stream like any texture). Set when the model is imported or re-imported.', { when: when('kind', 'model'), default: false, omitDefault: true, readOnly: true }),
      map('textures', 'Extracted textures', 'The file\'s image index → the texture asset it was extracted into (written by the importer).', 'Image', asset('*', 'Texture', 'A texture asset.', ['texture']), { when: when('kind', 'model'), minEntries: 1, maxEntries: ASSET_METRIC_CAPS.images }),
      asset('clipsFor', 'Clips for', 'An animation-only file: its clips play on this model\'s rig.', ['model'], { when: when('kind', 'model') }),
      list('labels', 'Labels', 'Names a script may load the asset by, with every other asset carrying them (ascending; set with setLabels).', str('*', 'Label', 'A letter or digit, then letters, digits, _ - . /.', { minLength: 1, maxLength: ASSET_LABEL_MAX_LENGTH }), { minItems: 1, unique: true, readOnly: true }),
      str('address', 'Address', 'The one name a script may load the asset by (unique in the project; set with setAddress).', { minLength: 1, maxLength: ADDRESS_MAX_LENGTH, readOnly: true }),
    ]), { required: true }),
    ops: ['publishAsset', 'setAssetOptions', 'deleteAsset', 'importAssets', 'setLabels', 'setAddress'],
  },
  {
    key: 'prefabs',
    label: 'Prefabs',
    tooltip: 'Captured object groups placed as independent copies.',
    required: true,
    value: list('prefabs', 'Prefabs', 'The project\'s prefabs (each its own file).', obj('*', 'Prefab', 'A captured definition (immutable).', [
      str('prefabId', 'Id', 'The stable prefab id.', { ...ID, required: true, readOnly: true }),
      str('displayName', 'Name', 'Shown in the prefab list.', { ...NAME, required: true, readOnly: true }),
      int('createdRevision', 'Created at', 'The project revision it was captured at.', { required: true, min: 0, readOnly: true }),
      int('entityCount', 'Objects', 'How many objects it holds (derived).', { required: true, min: 1, max: MAX_PREFAB_ENTITIES, readOnly: true }),
      int('depth', 'Depth', 'Hierarchy depth (derived).', { required: true, min: 1, readOnly: true }),
      list('entities', 'Objects', `1–${MAX_PREFAB_ENTITIES} objects, parents first.`, obj('*', 'Prefab object', 'One object of the prefab.', [
        str('localId', 'Local id', 'The id inside the prefab.', { ...ID, required: true, readOnly: true }),
        str('name', 'Name', 'The object name.', { ...NAME, readOnly: true }),
        str('parentLocalId', 'Parent', 'The parent inside the prefab (none: a root).', { ...ID, nullable: true, readOnly: true }),
        { type: 'components', key: 'components', label: 'Components', tooltip: 'The prefab component vocabulary.', required: true, readOnly: true, allowed: ['transform', 'model', 'box', 'behavior', ...PREFAB_V4_COMPONENTS] },
      ]), { required: true, minItems: 1, maxItems: MAX_PREFAB_ENTITIES, readOnly: true }),
    ]), { required: true }),
    ops: ['createPrefab', 'instantiatePrefab', 'deletePrefab'],
  },
  {
    key: 'behaviors',
    label: 'Behaviors',
    tooltip: 'Published scripts and their declared properties.',
    required: true,
    value: list('behaviors', 'Behaviors', 'The project\'s scripts (each its own file).', obj('*', 'Behavior', 'A published script.', [
      str('behaviorId', 'Id', 'The stable behavior id.', { ...ID, required: true, readOnly: true }),
      str('displayName', 'Name', 'Shown in pickers.', { ...NAME, required: true }),
      obj('declaration', 'Declaration', 'The properties objects set.', [list('properties', 'Properties', `The declared properties (none or more; the declaration is at most ${MAX_DECLARATION_BYTES} bytes).`, DECLARED_PROPERTY, { required: true })], { required: true }),
      json('source', 'Source', 'The compiled source record (written by the behavior build; none: declaration only).', { required: true, nullable: true, readOnly: true }),
      int('publishedRevision', 'Published at', 'The project revision it was published at.', { required: true, min: 0, readOnly: true }),
    ]), { required: true }),
    ops: ['publishBehavior', 'deleteBehavior'],
  },
  { key: 'behaviorTrust', label: 'Script trust', tooltip: 'Which script sources the owner acknowledged.', required: true, value: obj('behaviorTrust', 'Script trust', 'Acknowledged sources.', [list('entries', 'Entries', 'Acknowledged source digests.', json('*', 'Entry', 'A source digest and the revision it was acknowledged at.', { readOnly: true }), { required: true, readOnly: true })], { required: true, readOnly: true }), ops: ['acknowledgeBehaviorTrust', 'revokeBehaviorTrust'] },
  { key: 'lighting', label: 'Baked lighting', tooltip: 'Each scene\'s lightmap bake (written by the baker).', required: false, value: map('lighting', 'Baked lighting', 'Scene → its bake.', 'Scene', json('*', 'Bake', 'Lightmap atlases, entries and the hashes the bake was made from.', { readOnly: true, shape: 'LightingBake' }), { keyRef: 'scene', readOnly: true }), ops: ['setLighting'] },
];