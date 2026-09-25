/**
 * Phase 15.0: the component and content descriptor registry.
 *
 * One table, pure data, that says for every entity component and every
 * content block what its fields are: type, unit, range and step, default,
 * group, label, tooltip, when a field applies, and which Scene-view handle
 * edits it. The generic Inspector (15.1) builds its sections from it, the
 * handle system (15.2) finds its handles in it, MCP and the editor read it
 * over `queryGameConfig` (the editor may import project-model types only).
 *
 * The validators stay the rules; this table describes them. A unit test
 * (`descriptors.test.ts`) probes every validator with each descriptor's
 * values — min/max accepted, just outside refused, every enum value, every
 * required field — and checks that no field a validator knows lacks a
 * descriptor.
 *
 * Shape conventions:
 * - Every component and content block is one root `FieldDescriptor` (`value`),
 *   usually an `object` whose `fields` are the stored keys.
 * - `when` makes a field apply only for some values of a sibling (`key`) or,
 *   with `../key`, of a field of the enclosing object; conditions compare the
 *   sibling's effective value (its `default` when it is absent). A list of
 *   conditions must all hold. Outside its condition a field is not shown and
 *   the engine ignores it (the validator may refuse it).
 * - The same key may appear more than once in one `fields` list with
 *   conditions that never hold together (a light's `intensity` is in candela
 *   for point and spot lights, a plain factor otherwise).
 * - `default` is the value the engine uses when an optional field is absent
 *   (or, for a required field, a neutral starting value). `omitDefault`
 *   fields are stored only when they differ from their default.
 * - `readOnly` fields are written by a tool (the importer, a bake, the
 *   behavior compiler, a prefab capture), shown but not edited field by field.
 * - Handles are listed per component with the fields they edit, by role
 *   (see `HANDLE_ROLES`); the edited field also names its handle kind.
 *
 * Pure: no I/O, no three.js, no UI code.
 */

import { ANIMATOR_CONDITION_OPS, ANIMATOR_PARAMETER_TYPES, MAX_ANIMATOR_CONDITIONS, MAX_ANIMATOR_EVENTS, MAX_ANIMATOR_LAYERS, MAX_ANIMATOR_PARAMETERS, MAX_ANIMATOR_STATES, MAX_ANIMATOR_TRANSITIONS, MAX_ANIMATORS, MAX_BLEND_CHILDREN, MAX_LAYER_MASK } from './animator';
import { BLOCK_DEFAULTS, BLOCK_TUNING_LIMITS, DEFEAT_EFFECTS, ENEMY_PATROLS, MOVER_EASINGS, MOVER_MODES, PICKUP_KINDS, PICKUP_RESPAWN, SWITCH_MODES, TRIGGER_MODES, TRIGGER_RADIUS, TRIGGER_SHAPES } from './blocks';
import { CAPSULE_LIMITS, CONTROLLER_TUNING_LIMITS, DEFAULT_CONTROLLER_CAPSULE, DEFAULT_CONTROLLER_TUNING, MAX_POLYGON_VERTICES } from './components';
import { GAME_TIMING_DEFAULTS, GAME_TIMING_LIMITS, M2_SETTINGS_KEYS, MAX_BEHAVIORS, MAX_ENUM_VALUES, MAX_PREFAB_ENTITIES, MAX_PREFABS, MAX_PROPERTIES, MAX_SCENES, PREFAB_V4_COMPONENTS } from './content';
import { HUD_PRESETS, MAX_FLOW_LEVELS, MAX_LEVEL_AMBIENCE, MAX_LEVEL_SCENES, MAX_SCORE_COUNTERS, MAX_SCORE_POINTS, MAX_TITLE_PAN_DISTANCE, UI_FONTS } from './flow';
import { DEFAULT_INPUT, INPUT_ACTION_TYPES, INPUT_MAPS, MAX_INPUT_ACTIONS, MAX_INPUT_BINDINGS } from './input';
import { MAX_GRAPH_DOCUMENTS } from './graph';
import { EFFECT_DEFAULTS, EFFECT_LIMITS, EFFECT_PARAMETER_TYPES } from './effects';
import { DEFAULT_WIND, MATERIAL_PARAMS, MATERIAL_SHADERS, MATERIAL_TEXTURE_SLOTS, MAX_MATERIAL_PARAMETERS, MAX_MATERIAL_SLOTS, MAX_MATERIALS, type MaterialParamType } from './materials';
import { MATERIAL_PARAMETER_TYPES } from './material-graph-kinds';
import { CAMERA_FOLLOW_DEFAULTS, CAMERA_FOLLOW_LIMITS, MAX_EMISSIVE_INTENSITY, MAX_EXIT_SCENES, MAX_INTENSITY, MAX_LOCAL_INTENSITY, MAX_ZONE_SPAN, SURFACE_DEFAULTS } from './scene-v3';
import { GAME_ZONE_ROLES_V4, MAX_INSTANCES, MAX_TAGS } from './types-v3';

// ---- the descriptor types ----------------------------------------------------

/** A JSON value (defaults, presets, create values). */
export type DescriptorJson = null | boolean | number | string | readonly DescriptorJson[] | { readonly [k: string]: DescriptorJson };
export type DescriptorScalar = string | number | boolean;

/** The units a field may be in (display text; values are stored in these units). */
export type DescriptorUnit = 'm' | 'm/s' | 'm/s²' | 's' | 'deg' | 'cd' | '1/m' | 'points' | 'points/s' | '×' | 'Hz' | 'voices';

/** The Scene-view handle kinds (15.2 draws and drags them). */
export const HANDLE_KINDS = ['box2', 'box3', 'radius', 'capsule', 'segment1d', 'cone', 'direction', 'path', 'polygon', 'point'] as const;
export type HandleKind = (typeof HANDLE_KINDS)[number];

/**
 * The roles each handle kind binds to fields, as alternative role sets
 * (a `box2` edits a `[w, h]` size, or half extents `hx`/`hy`, or world
 * bounds `minX..maxY`).
 */
export const HANDLE_ROLES: Readonly<Record<HandleKind, readonly (readonly string[])[]>> = {
  box2: [['size'], ['halfX', 'halfY'], ['minX', 'maxX', 'minY', 'maxY']],
  box3: [['size']],
  radius: [['radius']],
  capsule: [['radius', 'height', 'offset']],
  segment1d: [['range']],
  cone: [['direction', 'angle', 'range']],
  direction: [['direction']],
  path: [['points']],
  polygon: [['vertices']],
  point: [['point']],
};

export const ASSET_KINDS = ['model', 'audio', 'texture', 'music'] as const;
export type DescriptorAssetKind = (typeof ASSET_KINDS)[number];

/** What an `ref` field names (besides assets, entities and scenes). */
export type DescriptorRefTarget = 'material' | 'animator' | 'behavior' | 'prefab' | 'animatorParameter' | 'animatorState' | 'clip' | 'effect';

/** String formats (validation hints and widget choices). */
export type DescriptorStringFormat = 'id' | 'name' | 'identifier' | 'keyCode' | 'counter' | 'multiline' | 'sha256' | 'materialSlot' | 'boneName';

/** A condition on a sibling field (`key`) or, with `../key`, on a field of the enclosing object. */
export interface FieldCondition {
  readonly key: string;
  readonly in: readonly DescriptorScalar[];
}

interface FieldBase {
  /** The stored key (`*` for a list item or a map value). */
  readonly key: string;
  readonly label: string;
  readonly tooltip: string;
  /** Inspector group (fields without one sit at the top). */
  readonly group?: string;
  /** Required whenever the field applies (absent: optional). */
  readonly required?: boolean;
  /** The field applies only when these hold. */
  readonly when?: FieldCondition | readonly FieldCondition[];
  /** The engine's value when absent (optional fields) or a neutral starting value. */
  readonly default?: DescriptorJson;
  /** Stored only when it differs from `default` (the validator may refuse the default spelled out). */
  readonly omitDefault?: boolean;
  /** `null` is a stored value (e.g. "no cue"). */
  readonly nullable?: boolean;
  /** Written by a tool, shown read-only. */
  readonly readOnly?: boolean;
  readonly unit?: DescriptorUnit;
  /** The Scene-view handle that edits this field (see the component's `handles`). */
  readonly handle?: HandleKind;
}

export interface NumberFieldDescriptor extends FieldBase {
  readonly type: 'number';
  readonly min?: number;
  readonly max?: number;
  /** `min` itself is refused. */
  readonly minExclusive?: boolean;
  /** `max` itself is refused. */
  readonly maxExclusive?: boolean;
  /** 0 is refused. */
  readonly nonZero?: boolean;
  readonly step?: number;
}
export interface IntFieldDescriptor extends FieldBase {
  readonly type: 'int';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Phase 15.3: only these values (a choice of numbers, e.g. a step rate). */
  readonly values?: readonly number[];
  /** Phase 17.1: what each of `values` is called (same order; shown instead of the number). */
  readonly valueLabels?: readonly string[];
}
export interface BoolFieldDescriptor extends FieldBase {
  readonly type: 'bool';
}
export interface EnumOption {
  readonly value: string;
  readonly label: string;
}
export interface EnumFieldDescriptor extends FieldBase {
  readonly type: 'enum';
  readonly options: readonly EnumOption[];
}
export interface VecFieldDescriptor extends FieldBase {
  readonly type: 'vec2' | 'vec3';
  /** Component labels (e.g. `['w', 'h']`, `['x', 'y', 'z']`). */
  readonly labels: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /** Each component must be > min. */
  readonly minExclusive?: boolean;
  readonly step?: number;
  /** A vec2 whose first component is below the second (an x range). */
  readonly ascending?: boolean;
  /** Not every component 0 (a direction). */
  readonly nonZero?: boolean;
}
export interface QuatFieldDescriptor extends FieldBase {
  readonly type: 'quat';
}
export interface ColorFieldDescriptor extends FieldBase {
  readonly type: 'color';
}
export interface AssetRefFieldDescriptor extends FieldBase {
  readonly type: 'assetRef';
  readonly kinds: readonly DescriptorAssetKind[];
}
export interface EntityRefFieldDescriptor extends FieldBase {
  readonly type: 'entityRef';
  /** The component the named entity carries. */
  readonly component?: string;
  /** The entity may be in another scene. */
  readonly anyScene?: boolean;
}
export interface SceneRefFieldDescriptor extends FieldBase {
  readonly type: 'sceneRef';
}
export interface RefFieldDescriptor extends FieldBase {
  readonly type: 'ref';
  readonly target: DescriptorRefTarget;
  /** For `animatorParameter`: the parameter types that fit. */
  readonly paramTypes?: readonly string[];
  /** Extra values allowed besides a reference (e.g. `*` = any state). */
  readonly also?: readonly string[];
}
export interface SignalFieldDescriptor extends FieldBase {
  readonly type: 'signal';
}
export interface StringFieldDescriptor extends FieldBase {
  readonly type: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly format?: DescriptorStringFormat;
}
export interface ObjectFieldDescriptor extends FieldBase {
  readonly type: 'object';
  readonly fields: readonly FieldDescriptor[];
  /** Cross-field rules the validator enforces (shown as hints). */
  readonly rules?: readonly string[];
}
export interface ListFieldDescriptor extends FieldBase {
  readonly type: 'list';
  readonly item: FieldDescriptor;
  readonly minItems?: number;
  readonly maxItems?: number;
  /** Items are distinct. */
  readonly unique?: boolean;
  /** Exactly this many items. */
  readonly length?: number;
}
export interface MapFieldDescriptor extends FieldBase {
  readonly type: 'map';
  readonly keyLabel: string;
  readonly keyFormat?: DescriptorStringFormat;
  /** Keys name these (e.g. animator parameters). */
  readonly keyRef?: DescriptorRefTarget | 'scene';
  readonly value: FieldDescriptor;
  readonly minEntries?: number;
  readonly maxEntries?: number;
}
/** A component bag (a prefab entity's components) — each by its component descriptor. */
export interface ComponentsFieldDescriptor extends FieldBase {
  readonly type: 'components';
  readonly allowed: readonly string[];
}
/** A value typed elsewhere (a behavior's declared properties) or written whole by a tool. */
export interface JsonFieldDescriptor extends FieldBase {
  readonly type: 'json';
  /** Where its type comes from, when it is typed elsewhere. */
  readonly typedBy?: 'behaviorDeclaration' | 'animatorParameter' | 'propertyType' | 'materialParameter' | 'effectParameter';
}

export type FieldDescriptor =
  | NumberFieldDescriptor
  | IntFieldDescriptor
  | BoolFieldDescriptor
  | EnumFieldDescriptor
  | VecFieldDescriptor
  | QuatFieldDescriptor
  | ColorFieldDescriptor
  | AssetRefFieldDescriptor
  | EntityRefFieldDescriptor
  | SceneRefFieldDescriptor
  | RefFieldDescriptor
  | SignalFieldDescriptor
  | StringFieldDescriptor
  | ObjectFieldDescriptor
  | ListFieldDescriptor
  | MapFieldDescriptor
  | ComponentsFieldDescriptor
  | JsonFieldDescriptor;

export type FieldType = FieldDescriptor['type'];

/** A Scene-view handle: its kind, the fields it edits by role (pointers relative to the component) and when it applies. */
export interface HandleDescriptor {
  readonly kind: HandleKind;
  readonly label: string;
  readonly bind: Readonly<Record<string, string>>;
  /** `local`: offsets from the entity (in its space); `world`: scene coordinates. */
  readonly space: 'local' | 'world';
  /** Conditions on the component's fields (pointers relative to the component, e.g. `shape/type`). */
  readonly when?: FieldCondition | readonly FieldCondition[];
  /**
   * Phase 15.2: how a `local` handle's frame follows the object, as the engine
   * reads the data: its position only (absent — areas, paths, ranges), its
   * rotation about Z too (`rotationZ`: a collider), its whole rotation
   * (`rotation`: a spot light's direction) or its whole transform, scale
   * included (`transform`: a box mesh's size).
   */
  readonly follows?: 'rotationZ' | 'rotation' | 'transform';
  /** Phase 15.2 (`box2`/`box3` sizes): the point a height drag keeps — the centre (absent) or the bottom (a body standing on its feet). */
  readonly anchor?: 'bottom';
  /** Phase 15.2 (`radius`): measured along X only (the engine compares horizontal distance) instead of in the X/Y plane. */
  readonly along?: 'x';
  /** Phase 15.2 (`radius` along X): a field (pointer) giving the half height of the band drawn with it (read, not dragged). */
  readonly band?: string;
  /** Phase 15.2 (`path`): the path closes back to its start while this holds. */
  readonly loop?: FieldCondition;
}

/**
 * How a component is added: from "+ Add component" with `value`; after the
 * user picks the fields in `pick` (`value` holds the rest); by a tool
 * (`tool` names it); or never (always present, or kept only for old data).
 */
export type ComponentAdd =
  | { readonly kind: 'menu'; readonly value: DescriptorJson }
  | { readonly kind: 'pick'; readonly value: DescriptorJson; readonly pick: readonly string[] }
  | { readonly kind: 'tool'; readonly tool: string }
  | { readonly kind: 'never'; readonly reason: string };

export interface ComponentRelation {
  readonly component: string;
  readonly reason: string;
}

export interface ComponentDescriptor {
  /** The key in `entity.components`. */
  readonly name: string;
  readonly label: string;
  readonly tooltip: string;
  readonly category: 'Object' | 'Rendering' | 'Physics' | 'Gameplay' | 'Camera' | 'Lighting' | 'Audio' | 'Animation' | 'Scripting' | 'Organisation';
  readonly value: FieldDescriptor;
  readonly add: ComponentAdd;
  /** Ready-made values (a light per type, a zone per role). */
  readonly presets?: readonly { readonly label: string; readonly value: DescriptorJson }[];
  readonly handles: readonly HandleDescriptor[];
  /** Needs one of these on the same entity. */
  readonly requiresAnyOf?: { readonly components: readonly string[]; readonly reason: string };
  /** Cannot share an entity with these. */
  readonly excludes: readonly ComponentRelation[];
  /** May sit on a prefab entity (the prefab component vocabulary). */
  readonly prefab: boolean;
  /** Old data kept working; not offered for new objects. */
  readonly legacy?: boolean;
  /** Placement rules the validator enforces (a physics body is a root at unit scale…). */
  readonly rules?: readonly string[];
}

export interface ContentBlockDescriptor {
  /** The key in the project's content block. */
  readonly key: string;
  readonly label: string;
  readonly tooltip: string;
  /** Present in every v4 content block. */
  readonly required: boolean;
  readonly value: FieldDescriptor;
  /** The commands that write it (the one mutation path). */
  readonly ops: readonly string[];
}

export interface DescriptorRegistry {
  readonly version: 1;
  readonly handleKinds: readonly HandleKind[];
  readonly handleRoles: Readonly<Record<HandleKind, readonly (readonly string[])[]>>;
  /** An entity's own fields (name, parent, flags, tags). */
  readonly entity: ObjectFieldDescriptor;
  /** Every v4 component, in "+ Add component" order within its category. */
  readonly components: readonly ComponentDescriptor[];
  /** Every v4 content block. */
  readonly content: readonly ContentBlockDescriptor[];
}

// ---- small builders ------------------------------------------------------------

type Opts<T extends FieldDescriptor> = Omit<T, 'type' | 'key' | 'label' | 'tooltip'>;

const num = (key: string, label: string, tooltip: string, o: Opts<NumberFieldDescriptor> = {}): NumberFieldDescriptor => ({ type: 'number', key, label, tooltip, ...o });
const int = (key: string, label: string, tooltip: string, o: Opts<IntFieldDescriptor> = {}): IntFieldDescriptor => ({ type: 'int', key, label, tooltip, step: 1, ...o });
const bool = (key: string, label: string, tooltip: string, o: Opts<BoolFieldDescriptor> = {}): BoolFieldDescriptor => ({ type: 'bool', key, label, tooltip, ...o });
const opts = (values: readonly string[], labels: Readonly<Record<string, string>> = {}): EnumOption[] => values.map((v) => ({ value: v, label: labels[v] ?? v.charAt(0).toUpperCase() + v.slice(1) }));
const enm = (key: string, label: string, tooltip: string, values: readonly string[], o: Opts<EnumFieldDescriptor> | (Omit<Opts<EnumFieldDescriptor>, 'options'> & { labels?: Readonly<Record<string, string>> }) = {}): EnumFieldDescriptor => {
  const { labels, ...rest } = o as Omit<Opts<EnumFieldDescriptor>, 'options'> & { labels?: Readonly<Record<string, string>> };
  return { type: 'enum', key, label, tooltip, options: opts(values, labels), ...rest };
};
const vec2 = (key: string, label: string, tooltip: string, o: Omit<Opts<VecFieldDescriptor>, 'labels'> & { labels?: readonly string[] } = {}): VecFieldDescriptor => ({ type: 'vec2', key, label, tooltip, labels: ['x', 'y'], ...o });
const vec3 = (key: string, label: string, tooltip: string, o: Omit<Opts<VecFieldDescriptor>, 'labels'> & { labels?: readonly string[] } = {}): VecFieldDescriptor => ({ type: 'vec3', key, label, tooltip, labels: ['x', 'y', 'z'], ...o });
const color = (key: string, label: string, tooltip: string, o: Opts<ColorFieldDescriptor> = {}): ColorFieldDescriptor => ({ type: 'color', key, label, tooltip, ...o });
const asset = (key: string, label: string, tooltip: string, kinds: readonly DescriptorAssetKind[], o: Omit<Opts<AssetRefFieldDescriptor>, 'kinds'> = {}): AssetRefFieldDescriptor => ({ type: 'assetRef', key, label, tooltip, kinds, ...o });
const entity = (key: string, label: string, tooltip: string, o: Opts<EntityRefFieldDescriptor> = {}): EntityRefFieldDescriptor => ({ type: 'entityRef', key, label, tooltip, ...o });
const scene = (key: string, label: string, tooltip: string, o: Opts<SceneRefFieldDescriptor> = {}): SceneRefFieldDescriptor => ({ type: 'sceneRef', key, label, tooltip, ...o });
const ref = (key: string, label: string, tooltip: string, target: DescriptorRefTarget, o: Omit<Opts<RefFieldDescriptor>, 'target'> = {}): RefFieldDescriptor => ({ type: 'ref', key, label, tooltip, target, ...o });
const signal = (key: string, label: string, tooltip: string, o: Opts<SignalFieldDescriptor> = {}): SignalFieldDescriptor => ({ type: 'signal', key, label, tooltip, ...o });
const str = (key: string, label: string, tooltip: string, o: Opts<StringFieldDescriptor> = {}): StringFieldDescriptor => ({ type: 'string', key, label, tooltip, ...o });
const obj = (key: string, label: string, tooltip: string, fields: readonly FieldDescriptor[], o: Omit<Opts<ObjectFieldDescriptor>, 'fields'> = {}): ObjectFieldDescriptor => ({ type: 'object', key, label, tooltip, fields, ...o });
const list = (key: string, label: string, tooltip: string, item: FieldDescriptor, o: Omit<Opts<ListFieldDescriptor>, 'item'> = {}): ListFieldDescriptor => ({ type: 'list', key, label, tooltip, item, ...o });
const map = (key: string, label: string, tooltip: string, keyLabel: string, value: FieldDescriptor, o: Omit<Opts<MapFieldDescriptor>, 'value' | 'keyLabel'> = {}): MapFieldDescriptor => ({ type: 'map', key, label, tooltip, keyLabel, value, ...o });
const json = (key: string, label: string, tooltip: string, o: Opts<JsonFieldDescriptor> = {}): JsonFieldDescriptor => ({ type: 'json', key, label, tooltip, ...o });
const when = (key: string, ...values: DescriptorScalar[]): FieldCondition => ({ key, in: values });

/** The id syntax every stored id uses. */
const ID = { format: 'id' as const, minLength: 1, maxLength: 64 };
/** A display name: 1–128 characters, no control characters. */
const NAME = { format: 'name' as const, minLength: 1, maxLength: 128 };

// ---- components ------------------------------------------------------------------

const POSITION_LIMIT = 1e6; // the §10.1 length bound
const V3_LIMIT = 1e6; // the §23.10 number bound

const PHYSICS_RULES = ['A physics body (collider or controller) is a root object at unit scale [1, 1, 1], rotated about Z only; the player controller stands upright.'];
const MARKER_RULES = ['A zone or player spawn is a root object at unit scale with no rotation.'];

const transform: ComponentDescriptor = {
  name: 'transform',
  label: 'Transform',
  tooltip: 'Where the object is, how it is turned and how big it is (relative to its parent).',
  category: 'Object',
  value: obj('transform', 'Transform', 'Position, rotation and scale relative to the parent.', [
    vec3('position', 'Position', 'Offset from the parent (metres).', { min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.1, unit: 'm', default: [0, 0, 0] }),
    { type: 'quat', key: 'rotation', label: 'Rotation', tooltip: 'Orientation as a unit quaternion [x, y, z, w] (the Inspector shows degrees).', default: [0, 0, 0, 1] },
    vec3('scale', 'Scale', 'Size multiplier per axis (above 0).', { min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.1, unit: '×', default: [1, 1, 1] }),
  ]),
  add: { kind: 'never', reason: 'every object has a transform (a folder has none)' },
  handles: [],
  excludes: [],
  prefab: true,
};

const model: ComponentDescriptor = {
  name: 'model',
  label: 'Model',
  tooltip: 'Shows an imported 3D model (a whole file or one named piece of it).',
  category: 'Rendering',
  value: obj('model', 'Model', 'The model asset and, for a multi-piece file, the piece.', [
    obj('asset', 'Asset', 'The model asset.', [asset('assetId', 'Model', 'The imported model file.', ['model'], { required: true })], { required: true }),
    str('piece', 'Piece', 'One named piece of a multi-piece file (absent: the whole file).', NAME),
  ]),
  add: { kind: 'pick', value: { asset: {} }, pick: ['asset/assetId'] },
  handles: [],
  excludes: [
    { component: 'box', reason: 'an object shows one model, box or camera' },
    { component: 'camera', reason: 'an object shows one model, box or camera' },
    { component: 'instances', reason: 'an instance set places its own model many times' },
  ],
  prefab: true,
};

const box: ComponentDescriptor = {
  name: 'box',
  label: 'Box',
  tooltip: 'A simple coloured box (blocking out a level, placeholders).',
  category: 'Rendering',
  value: obj('box', 'Box', 'A box mesh.', [
    vec3('size', 'Size', 'Width, height and depth in metres.', { min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.1, unit: 'm', default: [1, 1, 1], handle: 'box3', labels: ['w', 'h', 'd'] }),
    obj('material', 'Material', 'The box colour (a project material overrides it).', [color('color', 'Colour', 'The box colour.', { default: '#b0b0b0' })], { default: { color: '#b0b0b0' } }),
  ]),
  add: { kind: 'menu', value: { size: [1, 1, 1], material: { color: '#b0b0b0' } } },
  handles: [{ kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local', follows: 'transform' }],
  excludes: [
    { component: 'model', reason: 'an object shows one model, box or camera' },
    { component: 'camera', reason: 'an object shows one model, box or camera' },
    { component: 'instances', reason: 'an instance set places its own model many times' },
  ],
  prefab: true,
};

const camera: ComponentDescriptor = {
  name: 'camera',
  label: 'Camera',
  tooltip: 'The scene camera the game looks through (one per scene).',
  category: 'Camera',
  value: obj('camera', 'Camera', 'A perspective camera.', [
    enm('type', 'Projection', 'Only perspective cameras exist.', ['perspective'], { default: 'perspective' }),
    num('fovY', 'Field of view', 'Vertical field of view.', { min: 0, minExclusive: true, max: 180, maxExclusive: true, step: 1, unit: 'deg', default: 60 }),
    num('near', 'Near', 'Nothing closer than this is drawn.', { min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.01, unit: 'm', default: 0.1 }),
    num('far', 'Far', 'Nothing farther than this is drawn (beyond near).', { min: 0, minExclusive: true, max: POSITION_LIMIT, step: 1, unit: 'm', default: 100 }),
  ], { rules: ['far > near'] }),
  // Phase 15.5: 60° vertical (the common game default, three.js's too), 0.1–100 m (from arm's length to a large level; far is a field).
  add: { kind: 'menu', value: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } },
  handles: [],
  excludes: [
    { component: 'model', reason: 'an object shows one model, box or camera' },
    { component: 'box', reason: 'an object shows one model, box or camera' },
    { component: 'instances', reason: 'an instance set is scenery, not a camera' },
  ],
  prefab: false,
};

const behavior: ComponentDescriptor = {
  name: 'behavior',
  label: 'Script',
  tooltip: 'Runs a published behavior (script) on this object with per-object property values.',
  category: 'Scripting',
  value: obj('behavior', 'Script', 'The behavior and this object\'s property values.', [
    ref('behaviorId', 'Behavior', 'The published behavior.', 'behavior', { required: true }),
    map('values', 'Properties', 'Values for the behavior\'s declared properties (absent: the declared default).', 'Property', json('*', 'Value', 'A value of the declared property type.', { typedBy: 'behaviorDeclaration' }), { required: true, keyFormat: 'identifier', default: {} }),
  ]),
  add: { kind: 'pick', value: { values: {} }, pick: ['behaviorId'] },
  handles: [],
  excludes: [],
  prefab: true,
};

const prefab: ComponentDescriptor = {
  name: 'prefab',
  label: 'Prefab link',
  tooltip: 'Which prefab (and which of its entities) this object was placed from.',
  category: 'Organisation',
  value: obj('prefab', 'Prefab link', 'Written when a prefab is placed.', [
    ref('prefabId', 'Prefab', 'The prefab this object came from.', 'prefab', { required: true, readOnly: true }),
    str('localId', 'Prefab entity', 'The prefab entity this object is a copy of.', { ...ID, required: true, readOnly: true }),
  ]),
  add: { kind: 'tool', tool: 'instantiatePrefab' },
  handles: [],
  excludes: [],
  prefab: false,
};

const collider: ComponentDescriptor = {
  name: 'collider',
  label: 'Collider',
  tooltip: 'A solid shape the player stands on and bumps into (a box or a convex polygon, in the X/Y plane).',
  category: 'Physics',
  value: obj('collider', 'Collider', 'The collision shape.', [
    obj('shape', 'Shape', 'A box (half extents) or a convex polygon.', [
      enm('type', 'Shape', 'Box or convex polygon.', ['box', 'polygon'], { required: true, default: 'box' }),
      num('hx', 'Half width', 'Half the box width.', { required: true, when: when('type', 'box'), min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.05, unit: 'm', default: 0.5, handle: 'box2' }),
      num('hy', 'Half height', 'Half the box height.', { required: true, when: when('type', 'box'), min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.05, unit: 'm', default: 0.5, handle: 'box2' }),
      list('vertices', 'Vertices', `3–${MAX_POLYGON_VERTICES} corners [x, y], counter-clockwise, convex.`, vec2('*', 'Vertex', 'A corner [x, y] from the object origin.', { min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.05, unit: 'm' }), {
        required: true,
        when: when('type', 'polygon'),
        minItems: 3,
        maxItems: MAX_POLYGON_VERTICES,
        handle: 'polygon',
      }),
    ], { required: true, rules: ['A polygon is convex, counter-clockwise, has no repeated corner, an area of at least 1e-6 m² and stays within 64 m of the origin.'] }),
    bool('oneWay', 'One-way', 'The player can jump up through it and land on top (a platform).', { default: false, omitDefault: true }),
  ]),
  add: { kind: 'menu', value: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } },
  presets: [
    { label: 'Box', value: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } },
    { label: 'Polygon', value: { shape: { type: 'polygon', vertices: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] } } },
  ],
  handles: [
    { kind: 'box2', label: 'Box size', bind: { halfX: 'shape/hx', halfY: 'shape/hy' }, space: 'local', when: when('shape/type', 'box'), follows: 'rotationZ' },
    { kind: 'polygon', label: 'Polygon', bind: { vertices: 'shape/vertices' }, space: 'local', when: when('shape/type', 'polygon'), follows: 'rotationZ' },
  ],
  excludes: [
    { component: 'controller', reason: 'the player controller has its own capsule' },
    { component: 'enemy', reason: 'an enemy\'s size is its body' },
    { component: 'gameZone', reason: 'a zone never blocks movement' },
    { component: 'playerSpawn', reason: 'a player spawn is a marker' },
    { component: 'instances', reason: 'an instance set is scenery without its own body' },
  ],
  prefab: true,
  rules: PHYSICS_RULES,
};

const CT = DEFAULT_CONTROLLER_TUNING;
const TL = CONTROLLER_TUNING_LIMITS;
const BD = BLOCK_DEFAULTS;
const BL = BLOCK_TUNING_LIMITS;

const controller: ComponentDescriptor = {
  name: 'controller',
  label: 'Player controller',
  tooltip: 'Makes this object the player: it runs, jumps and collides with a capsule.',
  category: 'Physics',
  value: obj('controller', 'Player controller', 'The player character.', [
    obj('capsule', 'Capsule', `The collision capsule (absent: ${DEFAULT_CONTROLLER_CAPSULE.radius} m radius, ${DEFAULT_CONTROLLER_CAPSULE.height} m tall — an adult human).`, [
      num('radius', 'Radius', 'Half the capsule width.', { required: true, min: CAPSULE_LIMITS.minRadius, max: CAPSULE_LIMITS.maxRadius, step: 0.01, unit: 'm', default: DEFAULT_CONTROLLER_CAPSULE.radius, handle: 'capsule' }),
      num('height', 'Height', 'Total height, both end caps included.', { required: true, min: CAPSULE_LIMITS.minHeight, max: CAPSULE_LIMITS.maxHeight, step: 0.01, unit: 'm', default: DEFAULT_CONTROLLER_CAPSULE.height, handle: 'capsule' }),
      vec2('offset', 'Offset', 'The capsule centre from the object origin.', { min: -CAPSULE_LIMITS.maxOffset, max: CAPSULE_LIMITS.maxOffset, step: 0.01, unit: 'm', default: [...DEFAULT_CONTROLLER_CAPSULE.offset], handle: 'capsule' }),
    ], { group: 'Collision', rules: ['height ≥ 2 × radius'] }),
    // Phase 15.3: the movement tuning (absent: the engine defaults, the values every project played with before).
    num('acceleration', 'Acceleration', 'How fast it speeds up toward the run speed (40: a 4 m/s run in 0.1 s).', { group: 'Movement', ...TL.acceleration, step: 1, unit: 'm/s²', default: CT.acceleration }),
    num('deceleration', 'Deceleration', 'How fast it slows down when the input eases or stops.', { group: 'Movement', ...TL.deceleration, step: 1, unit: 'm/s²', default: CT.deceleration }),
    num('coyoteTime', 'Coyote time', 'A jump still starts this long after walking off an edge.', { group: 'Jump', ...TL.coyoteTime, step: 0.01, unit: 's', default: CT.coyoteTime }),
    num('jumpBuffer', 'Jump buffer', 'A jump pressed this long before landing still happens on landing.', { group: 'Jump', ...TL.jumpBuffer, step: 0.01, unit: 's', default: CT.jumpBuffer }),
    num('jumpRelease', 'Jump release', 'Share of the upward speed kept when jump is released early (1: a fixed jump height).', { group: 'Jump', ...TL.jumpRelease, step: 0.05, unit: '×', default: CT.jumpRelease }),
    num('groundSnap', 'Ground snap', 'Pulls the character down onto ground this close below it (walking down slopes and bumps).', { group: 'Collision', ...TL.groundSnap, step: 0.01, unit: 'm', default: CT.groundSnap }),
    num('skin', 'Skin', 'The small gap the character keeps from walls and floors.', { group: 'Collision', ...TL.skin, step: 0.001, unit: 'm', default: CT.skin }),
    bool('autostep', 'Autostep', 'Climb low steps without jumping.', { group: 'Collision', default: CT.autostep }),
    num('autostepHeight', 'Step height', 'The highest step it climbs.', { group: 'Collision', when: when('autostep', true), ...TL.autostepHeight, step: 0.01, unit: 'm', default: CT.autostepHeight }),
  ], { rules: ['The steepest walkable slope is the project setting max_slope_climb_deg; run speed, jump speed and gravity are project settings too.'] }),
  add: { kind: 'menu', value: {} },
  handles: [{ kind: 'capsule', label: 'Capsule', bind: { radius: 'capsule/radius', height: 'capsule/height', offset: 'capsule/offset' }, space: 'local' }],
  excludes: [
    { component: 'collider', reason: 'the player controller has its own capsule' },
    { component: 'mover', reason: 'the player moves by input, not along waypoints' },
    { component: 'enemy', reason: 'the player is not an enemy' },
    { component: 'gameZone', reason: 'a zone is never a physics body' },
    { component: 'playerSpawn', reason: 'the spawn marks where the player starts' },
    { component: 'instances', reason: 'an instance set is scenery' },
  ],
  prefab: false,
  rules: PHYSICS_RULES,
};

const gameZone: ComponentDescriptor = {
  name: 'gameZone',
  label: 'Zone',
  tooltip: 'An area that does something when the player enters it: hurts (hazard), saves progress (checkpoint), ends the level (goal) or loads other scenes (exit).',
  category: 'Gameplay',
  value: obj('gameZone', 'Zone', 'A game zone.', [
    enm('role', 'Role', 'What the zone does.', GAME_ZONE_ROLES_V4, { required: true, default: 'hazard' }),
    vec2('size', 'Size', 'Width and height of the area.', { required: true, min: 0, minExclusive: true, max: MAX_ZONE_SPAN, step: 0.1, unit: 'm', default: [2, 2], labels: ['w', 'h'], handle: 'box2' }),
    int('damage', 'Damage', 'Health taken per hit (0: instant death).', { when: when('role', 'hazard'), min: 0, max: 1000, default: 0 }),
    entity('safeSpawnId', 'Respawn at', 'The player spawn used after a death once this checkpoint is reached.', { required: true, when: when('role', 'checkpoint'), component: 'playerSpawn' }),
    obj('activation', 'Activation look', 'How the checkpoint looks once reached.', [
      // Phase 15.5: a new checkpoint glows plain white at 1 (reads as "lit" in any palette; was Beacon Reach's cyan at 1.2).
      color('emissive', 'Glow colour', 'The glow when reached.', { required: true, default: '#ffffff' }),
      num('emissiveIntensity', 'Glow strength', 'How strongly it glows.', { required: true, min: 0, max: MAX_EMISSIVE_INTENSITY, step: 0.1, default: 1 }),
      asset('cueAssetId', 'Sound', 'Played when reached (none: the game\'s checkpoint cue).', ['audio'], { required: true, nullable: true, default: null }),
    ], { required: true, when: when('role', 'checkpoint') }),
    list('load', 'Load scenes', 'Scenes loaded when the player enters.', scene('*', 'Scene', 'A scene to load.'), { when: when('role', 'exit'), maxItems: MAX_EXIT_SCENES, unique: true }),
    list('unload', 'Unload scenes', 'Scenes unloaded when the player enters.', scene('*', 'Scene', 'A scene to unload.'), { when: when('role', 'exit'), maxItems: MAX_EXIT_SCENES, unique: true }),
    entity('spawnId', 'Arrive at', 'Where the player arrives (absent: stays where it is).', { when: when('role', 'exit'), component: 'playerSpawn', anyScene: true }),
  ], { rules: ['An exit loads or unloads at least one scene.'] }),
  // Phase 15.5: a hazard is a 1.5 × 0.5 m strip (a stride wide, low enough for the default 1.25 m jump); a goal 2 m square
  // (easy to walk into for the default 1.8 m character) — the editor's zone defaults (`DEFAULT_ZONE_SIZE`).
  add: { kind: 'menu', value: { role: 'hazard', size: [1.5, 0.5] } },
  presets: [
    { label: 'Hazard', value: { role: 'hazard', size: [1.5, 0.5] } },
    { label: 'Goal', value: { role: 'goal', size: [2, 2] } },
  ],
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [
    { component: 'collider', reason: 'a zone never blocks movement' },
    { component: 'controller', reason: 'a zone is never a physics body' },
    { component: 'playerSpawn', reason: 'a spawn is a separate marker' },
    { component: 'instances', reason: 'an instance set is scenery' },
  ],
  prefab: false,
  rules: MARKER_RULES,
};

const playerSpawn: ComponentDescriptor = {
  name: 'playerSpawn',
  label: 'Player spawn',
  tooltip: 'Where the player starts (a level names its spawn).',
  category: 'Gameplay',
  value: obj('playerSpawn', 'Player spawn', 'A spawn marker.', [
    // Phase 15.2: which way the player faces when it starts or respawns here.
    enm('facing', 'Facing', 'The way the player faces when it starts or respawns here (its face-movement models turn to it at once; none: as placed).', ['none', 'left', 'right'], { default: 'none', omitDefault: true }),
  ]),
  add: { kind: 'menu', value: {} },
  handles: [],
  excludes: [
    { component: 'gameZone', reason: 'a spawn is a separate marker' },
    { component: 'collider', reason: 'a player spawn is a marker' },
    { component: 'controller', reason: 'the spawn marks where the player starts' },
    { component: 'instances', reason: 'an instance set is scenery' },
  ],
  prefab: false,
  rules: MARKER_RULES,
};

const cameraFollow: ComponentDescriptor = {
  name: 'cameraFollow',
  label: 'Camera follow',
  tooltip: 'The camera follows the player, with a dead zone, smoothing and optional bounds.',
  category: 'Camera',
  value: obj('cameraFollow', 'Camera follow', 'How the camera follows the player.', [
    obj('deadZone', 'Dead zone', 'The player moves this far from the centre before the camera follows.', [
      num('x', 'X', 'Horizontal dead zone.', { required: true, min: 0, max: V3_LIMIT, step: 0.1, unit: 'm', default: 0.5 }),
      num('y', 'Y', 'Vertical dead zone.', { required: true, min: 0, max: V3_LIMIT, step: 0.1, unit: 'm', default: 0.5 }),
    ], { required: true }),
    num('smoothing', 'Smoothing', 'How much the camera lags behind (0: none).', { required: true, min: 0, max: 1, step: 0.05, default: 0.2 }),
    obj('bounds', 'Bounds', 'The camera stays inside this rectangle (absent: anywhere).', [
      num('minX', 'Left', 'Left edge.', { required: true, min: -V3_LIMIT, max: V3_LIMIT, step: 0.5, unit: 'm', default: -50, handle: 'box2' }),
      num('maxX', 'Right', 'Right edge.', { required: true, min: -V3_LIMIT, max: V3_LIMIT, step: 0.5, unit: 'm', default: 50, handle: 'box2' }),
      num('minY', 'Bottom', 'Bottom edge.', { required: true, min: -V3_LIMIT, max: V3_LIMIT, step: 0.5, unit: 'm', default: -10, handle: 'box2' }),
      num('maxY', 'Top', 'Top edge.', { required: true, min: -V3_LIMIT, max: V3_LIMIT, step: 0.5, unit: 'm', default: 20, handle: 'box2' }),
    ], { rules: ['minX < maxX and minY < maxY'] }),
    // Phase 15.3.
    num('distance', 'Distance', 'How far in front of the player plane the camera stays (absent: where the camera is placed).', { ...CAMERA_FOLLOW_LIMITS.distance, step: 0.5, unit: 'm' }),
    num('maxSpeed', 'Max speed', 'The fastest the smoothed camera moves per axis (a safety cap; smoothing shapes the motion).', { ...CAMERA_FOLLOW_LIMITS.maxSpeed, step: 10, unit: 'm/s', default: CAMERA_FOLLOW_DEFAULTS.maxSpeed }),
  ]),
  // Phase 15.5: a 0.5 m dead zone (small steps and landings do not move the view) and light smoothing 0.2 (a short lag, no
  // swim) — generic follow-camera values; Beacon Reach happens to use the same numbers in its own data.
  add: { kind: 'menu', value: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } },
  handles: [{ kind: 'box2', label: 'Bounds', bind: { minX: 'bounds/minX', maxX: 'bounds/maxX', minY: 'bounds/minY', maxY: 'bounds/maxY' }, space: 'world' }],
  requiresAnyOf: { components: ['camera'], reason: 'the follow settings belong to the camera' },
  excludes: [],
  prefab: false,
};

const LIGHT_TYPES = ['directional', 'ambient', 'point', 'spot', 'hemisphere'] as const;
const light: ComponentDescriptor = {
  name: 'light',
  label: 'Light',
  tooltip: 'A light: directional (the sun), ambient, point, spot or hemisphere (sky and ground).',
  category: 'Lighting',
  value: obj('light', 'Light', 'A light source.', [
    enm('type', 'Type', 'The kind of light.', LIGHT_TYPES, { required: true, default: 'point' }),
    color('color', 'Colour', 'The light colour (a hemisphere light: the sky colour).', { required: true, default: '#ffffff' }),
    num('intensity', 'Intensity', 'Brightness.', { required: true, when: when('type', 'directional', 'ambient', 'hemisphere'), min: 0, max: MAX_INTENSITY, step: 0.05, default: 1 }),
    num('intensity', 'Intensity', 'Brightness in candela.', { required: true, when: when('type', 'point', 'spot'), min: 0, max: MAX_LOCAL_INTENSITY, step: 1, unit: 'cd', default: 30 }),
    vec3('direction', 'Direction', 'Where the light shines (need not be unit length; not all 0).', { required: true, when: when('type', 'directional'), min: -1, max: 1, step: 0.05, nonZero: true, handle: 'direction', default: [0.4, -1, -0.3] }),
    vec3('direction', 'Direction', 'Where the spot points (not all 0).', { required: true, when: when('type', 'spot'), min: -1, max: 1, step: 0.05, nonZero: true, handle: 'cone', default: [0, -1, 0] }),
    bool('castShadow', 'Cast shadows', 'The light casts shadows.', { when: when('type', 'directional', 'point', 'spot'), default: false }),
    num('range', 'Range', 'Light reaches this far (0: unlimited).', { when: when('type', 'point'), min: 0, max: 1000, step: 0.5, unit: 'm', default: 0, handle: 'radius' }),
    num('range', 'Range', 'Light reaches this far (0: unlimited).', { when: when('type', 'spot'), min: 0, max: 1000, step: 0.5, unit: 'm', default: 0, handle: 'cone' }),
    num('decay', 'Decay', 'How fast it fades with distance (2: physically correct).', { when: when('type', 'point', 'spot'), min: 0, max: 4, step: 0.1, default: 2 }),
    num('angle', 'Angle', 'Half-angle of the spot cone.', { when: when('type', 'spot'), min: 1, max: 89, step: 1, unit: 'deg', default: 30, handle: 'cone' }),
    num('penumbra', 'Soft edge', 'How soft the cone edge is (0: hard).', { when: when('type', 'spot'), min: 0, max: 1, step: 0.05, default: 0.2 }),
    color('groundColor', 'Ground colour', 'The colour from below.', { when: when('type', 'hemisphere'), default: '#444444' }),
    enm('mode', 'Mode', 'Realtime, baked into lightmaps, or both (mixed).', ['realtime', 'baked', 'mixed'], { default: 'realtime', omitDefault: true }),
  ]),
  add: { kind: 'menu', value: { type: 'point', color: '#ffd9a0', intensity: 30, range: 8, decay: 2 } },
  // Phase 15.5 (genre-neutral reasons; the GameObject menu creates these too):
  // - directional and ambient = a new project's starter lights: a white key from
  //   above-front at 1.2 casting shadows (a lone key without shadows flattens any
  //   scene) over a cool fill at 0.6 (shadowed sides stay readable, not black).
  //   They were Beacon Reach's key and fill (#fff4e0 1.6, #8a94b0 0.9).
  // - point: a warm lamp (most placed point lights stand for a lamp, torch or
  //   candle), 30 cd reaching 8 m (a room); spot: white 80 cd, a 30° cone 12 m
  //   long pointing down (a ceiling spot or a stage light).
  // - hemisphere: a pale sky over a neutral grey ground (#444444, the field
  //   default; it was an earth brown, which assumes an outdoor ground).
  presets: [
    { label: 'Directional light', value: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: true } },
    { label: 'Ambient light', value: { type: 'ambient', color: '#8090a8', intensity: 0.6 } },
    { label: 'Point light', value: { type: 'point', color: '#ffd9a0', intensity: 30, range: 8, decay: 2 } },
    { label: 'Spot light', value: { type: 'spot', color: '#ffffff', intensity: 80, range: 12, decay: 2, angle: 30, penumbra: 0.3, direction: [0, -1, 0] } },
    { label: 'Hemisphere light', value: { type: 'hemisphere', color: '#bcd7ff', groundColor: '#444444', intensity: 0.8 } },
  ],
  handles: [
    { kind: 'direction', label: 'Direction', bind: { direction: 'direction' }, space: 'world', when: when('type', 'directional') },
    { kind: 'cone', label: 'Cone', bind: { direction: 'direction', angle: 'angle', range: 'range' }, space: 'local', when: when('type', 'spot'), follows: 'rotation' },
    { kind: 'radius', label: 'Range', bind: { radius: 'range' }, space: 'local', when: when('type', 'point') },
  ],
  excludes: [{ component: 'instances', reason: 'an instance set is scenery' }],
  prefab: false,
  rules: ['At most one directional, one ambient and one hemisphere light and 16 point/spot lights per scene.'],
};

const surface: ComponentDescriptor = {
  name: 'surface',
  label: 'Surface',
  tooltip: 'Simple look overrides for a box or model: colour, roughness, metalness and glow.',
  category: 'Rendering',
  value: obj('surface', 'Surface', 'Surface look.', [
    color('color', 'Colour', 'Base colour.', { default: SURFACE_DEFAULTS.color }),
    num('roughness', 'Roughness', '0: mirror-like, 1: matte.', { min: 0, max: 1, step: 0.05, default: SURFACE_DEFAULTS.roughness }),
    num('metalness', 'Metalness', '0: plastic/wood/stone, 1: metal.', { min: 0, max: 1, step: 0.05, default: SURFACE_DEFAULTS.metalness }),
    color('emissive', 'Glow colour', 'Light it gives off.', { default: SURFACE_DEFAULTS.emissive }),
    num('emissiveIntensity', 'Glow strength', 'How strongly it glows.', { min: 0, max: MAX_EMISSIVE_INTENSITY, step: 0.1, default: SURFACE_DEFAULTS.emissiveIntensity }),
  ]),
  add: { kind: 'menu', value: { ...SURFACE_DEFAULTS } },
  handles: [],
  requiresAnyOf: { components: ['box', 'model'], reason: 'a surface colours a box or a model' },
  excludes: [],
  prefab: true,
};

const modelAnimation: ComponentDescriptor = {
  name: 'modelAnimation',
  label: 'Model animation (old)',
  tooltip: 'The old idle/run/airborne clip roles. Projects are moved to an animator when opened; this stays only where the clips could not be measured.',
  category: 'Animation',
  value: obj('modelAnimation', 'Model animation (old)', 'Idle, run and airborne clips.', [
    asset('assetId', 'Model', 'The entity\'s model asset.', ['model'], { required: true, readOnly: true }),
    int('version', 'Version', 'The model version the roles were made for.', { required: true, min: 1, readOnly: true }),
    obj('roles', 'Roles', 'The clip per role.', [
      json('idle', 'Idle', 'The idle clip binding.', { required: true, readOnly: true }),
      json('run', 'Run', 'The run clip binding.', { required: true, readOnly: true }),
      json('airborne', 'Airborne', 'The airborne clip binding.', { required: true, readOnly: true }),
    ], { required: true, readOnly: true }),
  ]),
  add: { kind: 'never', reason: 'replaced by the animator (kept for old data)' },
  handles: [],
  requiresAnyOf: { components: ['model'], reason: 'it animates the object\'s model' },
  excludes: [{ component: 'instances', reason: 'an instance set is not animated' }],
  prefab: false,
  legacy: true,
};

const folder: ComponentDescriptor = {
  name: 'folder',
  label: 'Folder',
  tooltip: 'Organises objects in the Hierarchy; carries nothing else.',
  category: 'Organisation',
  value: obj('folder', 'Folder', 'A folder (no fields).', []),
  add: { kind: 'tool', tool: 'createFolder' },
  handles: [],
  excludes: [],
  prefab: false,
  rules: ['A folder carries no transform and no other component.'],
};

const instances: ComponentDescriptor = {
  name: 'instances',
  label: 'Instance set',
  tooltip: 'One model placed many times (grass, rocks, trees), stored as a binary transform buffer.',
  category: 'Rendering',
  value: obj('instances', 'Instance set', 'A model and its copies.', [
    obj('asset', 'Asset', 'The model placed.', [
      asset('assetId', 'Model', 'The model file.', ['model'], { required: true }),
      str('piece', 'Piece', 'One named piece of a multi-piece file (absent: the whole file).', NAME),
    ], { required: true }),
    str('buffer', 'Buffer', 'The SHA-256 of the copies\' transforms (written by the brush and import tools).', { format: 'sha256', minLength: 64, maxLength: 64, required: true, readOnly: true }),
    int('count', 'Copies', 'How many copies the buffer holds.', { min: 1, max: MAX_INSTANCES, required: true, readOnly: true }),
  ]),
  add: { kind: 'tool', tool: 'instance brush or instance import' },
  handles: [],
  excludes: ['box', 'camera', 'model', 'collider', 'controller', 'modelAnimation', 'gameZone', 'playerSpawn', 'light'].map((c) => ({ component: c, reason: 'an instance set is one model placed many times, with nothing of its own' })),
  prefab: false,
};

const materials: ComponentDescriptor = {
  name: 'materials',
  label: 'Materials',
  tooltip: 'Which project material each of the object\'s materials uses ("*": all of them).',
  category: 'Rendering',
  value: map('materials', 'Materials', 'Material slot → project material.', 'Slot', ref('*', 'Material', 'A project material.', 'material'), { keyFormat: 'materialSlot', minEntries: 1, maxEntries: MAX_MATERIAL_SLOTS }),
  add: { kind: 'pick', value: {}, pick: ['*'] },
  handles: [],
  requiresAnyOf: { components: ['model', 'box', 'instances'], reason: 'materials dress a model, a box or an instance set' },
  excludes: [],
  prefab: true,
};

// Phase 18.0: per-object overrides of graph-material parameters (extends the material mapping).
const materialParams: ComponentDescriptor = {
  name: 'materialParams',
  label: 'Material parameters',
  tooltip: 'This object\'s values for the public parameters of its graph materials (the materials keep their own values elsewhere).',
  category: 'Rendering',
  value: map(
    'materialParams',
    'Material parameters',
    'Graph material → its overridden parameters.',
    'Material',
    map('*', 'Parameters', 'Parameter → value (only public parameters).', 'Parameter', json('*', 'Value', 'A value of the parameter\'s type (number, 2–4 numbers, "#rrggbb" or a texture asset id).', { typedBy: 'materialParameter' }), { keyFormat: 'identifier', minEntries: 1, maxEntries: MAX_MATERIAL_PARAMETERS }),
    { keyRef: 'material', minEntries: 1, maxEntries: MAX_MATERIAL_SLOTS },
  ),
  add: { kind: 'tool', tool: 'the Materials section of the Inspector (override a public parameter)' },
  handles: [],
  requiresAnyOf: { components: ['model', 'box', 'instances'], reason: 'material parameters belong to the materials of a model, a box or an instance set' },
  excludes: [],
  prefab: true,
};

// Phase 20.0: a visual effect played from the entity.
const effectComponent: ComponentDescriptor = {
  name: 'effect',
  label: 'Effect',
  tooltip: 'Plays a visual effect (particles) from this object. Visual only: it never changes the game simulation.',
  category: 'Rendering',
  value: obj('effect', 'Effect', 'The effect and this object\'s values for its public parameters.', [
    ref('effectId', 'Effect', 'The project effect.', 'effect', { required: true }),
    bool('playOnStart', 'Play on start', 'Starts when the scene starts (off: a trigger or script plays it).', { default: true, omitDefault: true }),
    map('params', 'Parameters', 'Values for the effect\'s public parameters (absent: the effect\'s defaults).', 'Parameter', json('*', 'Value', 'A value of the parameter\'s type (a number, 3 numbers or "#rrggbb").', { typedBy: 'effectParameter' }), { keyFormat: 'identifier', maxEntries: EFFECT_LIMITS.parameters }),
  ]),
  add: { kind: 'pick', value: {}, pick: ['effectId'] },
  handles: [],
  excludes: [],
  prefab: true,
};

const fogVolume: ComponentDescriptor = {
  name: 'fogVolume',
  label: 'Fog volume',
  tooltip: 'A box of fog (mist in a valley, smoke in a room).',
  category: 'Rendering',
  value: obj('fogVolume', 'Fog volume', 'A fog box.', [
    vec3('size', 'Size', 'Width, height and depth.', { required: true, min: 0, minExclusive: true, max: 1000, step: 0.5, unit: 'm', default: [6, 3, 4], labels: ['w', 'h', 'd'], handle: 'box3' }),
    num('density', 'Density', 'How thick the fog is.', { required: true, min: 0, max: 1, step: 0.01, default: 0.25 }),
    color('color', 'Colour', 'The fog colour.', { required: true, default: '#dfe7ef' }),
    num('falloff', 'Soft edges', '0: a hard box, 1: fades from the centre.', { min: 0, max: 1, step: 0.05, default: 0.5 }),
    num('heightFalloff', 'Height falloff', 'How fast the fog thins with height above the bottom (0: even).', { min: 0, max: 10, step: 0.05, unit: '1/m', default: 0 }),
  ]),
  // Phase 15.5: a room-sized 6 × 3 × 4 m box of light grey-blue haze at a quarter density with soft edges — visible
  // at once, easy to resize; no setting assumed (valley mist, room smoke, steam).
  add: { kind: 'menu', value: { size: [6, 3, 4], density: 0.25, color: '#dfe7ef', falloff: 0.5 } },
  handles: [{ kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [],
  prefab: false,
  rules: ['At most 16 fog volumes per scene.'],
};

const animator: ComponentDescriptor = {
  name: 'animator',
  label: 'Animator',
  tooltip: 'Plays the model\'s animations with an animator controller (a state machine).',
  category: 'Animation',
  value: obj('animator', 'Animator', 'The controller and this object\'s starting parameter values.', [
    ref('controller', 'Controller', 'The animator controller.', 'animator', { required: true }),
    map('parameters', 'Parameters', 'Starting values for the controller\'s parameters (absent: the controller\'s defaults).', 'Parameter', json('*', 'Value', 'A number or true/false.', { typedBy: 'animatorParameter' }), { keyRef: 'animatorParameter', maxEntries: MAX_ANIMATOR_PARAMETERS }),
  ]),
  add: { kind: 'pick', value: {}, pick: ['controller'] },
  handles: [],
  requiresAnyOf: { components: ['model'], reason: 'an animator plays the object\'s model' },
  excludes: [],
  prefab: true,
};

const mover: ComponentDescriptor = {
  name: 'mover',
  label: 'Mover',
  tooltip: 'Moves the object along waypoints (a moving platform, a door); with a collider it carries the player.',
  category: 'Gameplay',
  value: obj('mover', 'Mover', 'Waypoint movement.', [
    list('waypoints', 'Waypoints', '1–16 points, as offsets from where the object is placed (the start is not listed).', vec3('*', 'Point', 'An offset [x, y, z].', { min: -1000, max: 1000, step: 0.1, unit: 'm' }), { required: true, minItems: 1, maxItems: 16, handle: 'path', default: [[4, 0, 0]] }), // phase 15.5: the add value's 4 m (it said 2 m) — a few character widths, visibly a trip
    num('speed', 'Speed', 'Travel speed.', { required: true, min: 0.01, max: 50, step: 0.1, unit: 'm/s', default: 2 }),
    enm('mode', 'Mode', 'Loop back to the start, go back and forth, or move once.', MOVER_MODES, { required: true, default: 'pingpong', labels: { pingpong: 'Back and forth' } }),
    num('wait', 'Wait', 'Pause at each point.', { min: 0, max: 60, step: 0.1, unit: 's', default: 0 }),
    enm('easing', 'Easing', 'Constant speed or smooth starts and stops.', MOVER_EASINGS, { default: 'linear' }),
    signal('startOn', 'Start on signal', 'Wait for this signal before moving (absent: moves from the start).'),
    num('maxPush', 'Max push', 'The fastest it shoves a player out of its way (a safety limit that keeps the player out of the platform).', { ...BL.maxPush, step: 1, unit: 'm/s', default: BD.maxPush }),
  ]),
  // Phase 15.5: a new mover goes 4 m sideways and back at 2 m/s (a brisk walk), pausing 0.5 s at each end (reads as a stop, not a bounce).
  add: { kind: 'menu', value: { waypoints: [[4, 0, 0]], speed: 2, mode: 'pingpong', wait: 0.5 } },
  handles: [{ kind: 'path', label: 'Waypoints', bind: { points: 'waypoints' }, space: 'local', loop: when('mode', 'loop') }],
  excludes: [{ component: 'controller', reason: 'the player moves by input, not along waypoints' }],
  prefab: true,
};

const trigger: ComponentDescriptor = {
  name: 'trigger',
  label: 'Trigger',
  tooltip: 'Sends a signal when the player enters an area (a box or a circle).',
  category: 'Gameplay',
  value: obj('trigger', 'Trigger', 'An area that emits signals.', [
    enm('shape', 'Shape', 'Box or circle.', TRIGGER_SHAPES, { default: 'box' }),
    vec2('size', 'Size', 'Width and height of the box.', { required: true, when: when('shape', 'box'), min: 0.05, max: 500, step: 0.1, unit: 'm', default: [2, 2], labels: ['w', 'h'], handle: 'box2' }),
    num('radius', 'Radius', 'Radius of the circle.', { required: true, when: when('shape', 'circle'), min: TRIGGER_RADIUS.min, max: TRIGGER_RADIUS.max, step: 0.05, unit: 'm', default: 1, handle: 'radius' }),
    signal('signal', 'Signal', 'Sent when the player enters.', { required: true, default: 'trigger' }),
    signal('exitSignal', 'Exit signal', 'Sent when the player leaves (absent: none).'),
    enm('mode', 'Mode', 'Enter: once per entry. Stay: every step while inside.', TRIGGER_MODES, { default: 'enter' }),
    bool('once', 'Once', 'Only the first time.', { default: false }),
  ]),
  // Phase 15.5: a 2 m square (the default 1.8 m character fits inside) sending the neutral signal name "trigger".
  add: { kind: 'menu', value: { size: [2, 2], signal: 'trigger' } },
  handles: [
    { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', when: when('shape', 'box') },
    { kind: 'radius', label: 'Radius', bind: { radius: 'radius' }, space: 'local', when: when('shape', 'circle') },
  ],
  excludes: [],
  prefab: true,
};

const switchC: ComponentDescriptor = {
  name: 'switch',
  label: 'Switch',
  tooltip: 'A lever or button (interact) or a pressure plate (stand) that sends a signal.',
  category: 'Gameplay',
  value: obj('switch', 'Switch', 'A switch.', [
    enm('mode', 'Mode', 'Interact: press the interact action nearby. Stand: step on it.', SWITCH_MODES, { required: true, default: 'interact' }),
    signal('signal', 'Signal', 'Sent when used.', { required: true, default: 'open' }),
    vec2('size', 'Size', 'The area the player must be in.', { required: true, min: 0.05, max: 100, step: 0.1, unit: 'm', default: [1, 1], labels: ['w', 'h'], handle: 'box2' }),
    bool('once', 'Once', 'Only the first time.', { default: false }),
  ]),
  // Phase 15.5: a 1 m square pressed with the interact action, sending "open" (the door preset waits for it).
  add: { kind: 'menu', value: { mode: 'interact', signal: 'open', size: [1, 1] } },
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [],
  prefab: true,
};

const health: ComponentDescriptor = {
  name: 'health',
  label: 'Health',
  tooltip: 'The player\'s health: hazards and enemies take some, a short grace follows each hit.',
  category: 'Gameplay',
  value: obj('health', 'Health', 'Player health.', [
    int('max', 'Maximum', 'Most health the player can have.', { required: true, min: 1, max: 1000, default: 3 }),
    int('start', 'Start', 'Health at the start and after a respawn (absent: the maximum).', { min: 1, max: 1000 }),
    num('invulnerableSeconds', 'Grace time', 'No further damage for this long after a hit.', { min: 0, max: 10, step: 0.1, unit: 's', default: BD.invulnerableSeconds }),
    num('knockback', 'Knockback', 'A hit pushes the player away at this speed (0: none).', { min: 0, max: 20, step: 0.5, unit: 'm/s', default: 0 }),
    num('knockbackTime', 'Knockback time', 'How long a knockback pushes (easing out).', { ...BL.knockbackTime, step: 0.05, unit: 's', default: BD.knockbackTime }),
    num('hitBounce', 'Hit bounce', 'A hit throws the player up at this speed (0: none).', { ...BL.hitBounce, step: 0.5, unit: 'm/s', default: BD.hitBounce }),
  ], { rules: ['start ≤ max'] }),
  // Phase 15.5: 3 hits (the common small health pool) with 1 s of grace after each.
  add: { kind: 'menu', value: { max: 3, invulnerableSeconds: 1 } },
  handles: [],
  excludes: [],
  prefab: false,
};

const pickup: ComponentDescriptor = {
  name: 'pickup',
  label: 'Pickup',
  tooltip: 'A collectable: a coin, gem, heart, extra life, key or a custom counter.',
  category: 'Gameplay',
  value: obj('pickup', 'Pickup', 'A collectable.', [
    enm('kind', 'Kind', 'What it counts as.', PICKUP_KINDS, { required: true, default: 'coin' }),
    int('value', 'Value', 'How much it adds.', { required: true, min: 1, max: 10000, default: 1 }),
    str('counter', 'Counter', 'The counter a custom pickup adds to (a letter or _, then letters, digits or _).', { required: true, when: when('kind', 'custom'), format: 'counter', minLength: 1, maxLength: 32 }),
    vec2('size', 'Size', 'The area that collects it (absent: its model\'s recorded bounds, else 1 × 1 m).', { min: 0.05, max: 20, step: 0.05, unit: 'm', default: [...BD.pickupSize], labels: ['w', 'h'], handle: 'box2' }),
    enm('respawn', 'Comes back', 'Never, or when the player respawns after a death.', PICKUP_RESPAWN, { default: 'never' }),
    asset('cue', 'Sound', 'Played when collected.', ['audio']),
  ]),
  // Phase 15.5: a coin worth 1; no size, so it collects over its model's bounds (else 1 × 1 m).
  add: { kind: 'menu', value: { kind: 'coin', value: 1 } },
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [],
  prefab: true,
};

const enemy: ComponentDescriptor = {
  name: 'enemy',
  label: 'Enemy',
  tooltip: 'Walks back and forth, hurts on contact, can be stomped; can chase the player nearby.',
  category: 'Gameplay',
  value: obj('enemy', 'Enemy', 'A walking enemy.', [
    enm('patrol', 'Patrol', 'Between two points, or until a ledge or a wall.', ENEMY_PATROLS, { required: true, default: 'edges', labels: { points: 'Between points', edges: 'Edge to edge' } }),
    vec2('range', 'Range', 'The x offsets [left, right] it walks between.', { required: true, when: when('patrol', 'points'), min: -500, max: 500, step: 0.1, unit: 'm', ascending: true, default: [-2, 2], labels: ['left', 'right'], handle: 'segment1d' }),
    num('speed', 'Speed', 'Walking speed.', { required: true, min: 0, max: 20, step: 0.1, unit: 'm/s', default: 1.5 }),
    vec2('size', 'Size', 'Its body: width and height.', { required: true, min: 0.1, max: 20, step: 0.05, unit: 'm', default: [0.8, 0.8], labels: ['w', 'h'], handle: 'box2' }),
    int('contactDamage', 'Contact damage', 'Health taken on contact (0: harmless).', { required: true, min: 0, max: 1000, default: 1 }),
    bool('stompable', 'Stompable', 'Jumping on it defeats it.', { required: true, default: true }),
    int('health', 'Health', 'Stomps needed to defeat it.', { required: true, min: 1, max: 100, default: 1 }),
    num('chase', 'Chase distance', 'Walks toward the player within this distance (0: never).', { min: 0, max: 50, step: 0.5, unit: 'm', default: 0, handle: 'radius' }),
    // Phase 15.3: the combat and walking tuning.
    num('chaseHeight', 'Chase height', 'Notices a player within this height of its feet.', { group: 'Chase', ...BL.chaseHeight, step: 0.1, unit: 'm', default: BD.chaseHeight }),
    num('stompBounce', 'Stomp bounce', 'A stomp throws the player up at this speed.', { group: 'Stomp', ...BL.stompBounce, step: 0.5, unit: 'm/s', default: BD.stompBounce }),
    num('stompTolerance', 'Stomp tolerance', 'A stomp counts when the player\'s feet were at most this far below its top.', { group: 'Stomp', ...BL.stompTolerance, step: 0.05, unit: 'm', default: BD.stompTolerance }),
    enm('defeat', 'Defeat effect', 'How it leaves when defeated: at once, squashed flat, or fading out.', DEFEAT_EFFECTS, { group: 'Defeat', default: BD.defeat }),
    num('defeatTime', 'Defeat time', 'How long the squash or fade takes.', { group: 'Defeat', when: when('defeat', 'squash', 'fade'), ...BL.defeatTime, step: 0.05, unit: 's', default: BD.defeatTime }),
    num('wallProbe', 'Wall probe', 'How far ahead of its front it looks for a wall to turn at.', { group: 'Walking', when: when('patrol', 'edges'), ...BL.wallProbe, step: 0.01, unit: 'm', default: BD.wallProbe }),
    num('ledgeProbe', 'Ledge probe', 'How far down, from 0.1 m above its feet, it looks for floor ahead (0.4: a drop deeper than 0.3 m is a ledge).', { group: 'Walking', when: when('patrol', 'edges'), ...BL.ledgeProbe, step: 0.05, unit: 'm', default: BD.ledgeProbe }),
  ]),
  // Phase 15.5: a 0.8 m body the default 1.8 m character jumps on with its 1.25 m jump, walking edge to edge at
  // 1.5 m/s (slower than the 4 m/s run, so it can be escaped), one hit of damage, one stomp.
  add: { kind: 'menu', value: { patrol: 'edges', speed: 1.5, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 } },
  handles: [
    { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', anchor: 'bottom' },
    { kind: 'segment1d', label: 'Patrol range', bind: { range: 'range' }, space: 'local', when: when('patrol', 'points') },
    { kind: 'radius', label: 'Chase distance', bind: { radius: 'chase' }, space: 'local', along: 'x', band: 'chaseHeight' },
  ],
  excludes: [
    { component: 'controller', reason: 'the player is not an enemy' },
    { component: 'collider', reason: 'an enemy\'s size is its body' },
  ],
  prefab: true,
};

const audioSource: ComponentDescriptor = {
  name: 'audioSource',
  label: 'Audio source',
  tooltip: 'A looping sound here, louder as the player comes near (along X).',
  category: 'Audio',
  value: obj('audioSource', 'Audio source', 'A positional loop.', [
    asset('assetId', 'Sound', 'An audio or music asset.', ['audio', 'music'], { required: true }),
    num('volume', 'Volume', 'Volume at full strength.', { required: true, min: 0, max: 1, step: 0.05, default: 0.8 }),
    num('range', 'Range', 'Heard within this distance (full volume within a quarter of it).', { required: true, min: 0.5, max: 500, step: 0.5, unit: 'm', default: 12, handle: 'radius' }),
  ]),
  // Phase 15.5: 0.8 volume (headroom under the effects) heard within 12 m (about a screen width at the default camera).
  add: { kind: 'pick', value: { volume: 0.8, range: 12 }, pick: ['assetId'] },
  handles: [{ kind: 'radius', label: 'Range', bind: { radius: 'range' }, space: 'local', along: 'x' }],
  excludes: [],
  prefab: true,
};

const faceMovement: ComponentDescriptor = {
  name: 'faceMovement',
  label: 'Face movement',
  tooltip: 'Turns this model to face where its parent is going (the player\'s model, an enemy\'s model).',
  category: 'Animation',
  value: obj('faceMovement', 'Face movement', 'Yaw per direction.', [
    num('yawRight', 'Yaw moving right', 'Rotation about +Y while the parent moves right.', { required: true, min: -360, max: 360, step: 5, unit: 'deg', default: 90 }),
    num('yawLeft', 'Yaw moving left', 'Rotation about +Y while the parent moves left.', { required: true, min: -360, max: 360, step: 5, unit: 'deg', default: -90 }),
    num('turnSeconds', 'Turn time', 'Time to turn around.', { min: 0, max: 5, step: 0.01, unit: 's', default: 0.12 }),
  ]),
  // Phase 15.5: a model authored facing +Z turns ±90° to face +X / −X, turning around in 0.12 s (quick, still visible).
  add: { kind: 'menu', value: { yawRight: 90, yawLeft: -90, turnSeconds: 0.12 } },
  handles: [],
  excludes: [],
  prefab: true,
};

// ---- the entity's own fields ------------------------------------------------------

const ENTITY: ObjectFieldDescriptor = obj('entity', 'Object', 'An object in a scene.', [
  str('id', 'Id', 'The stable object id.', { ...ID, required: true, readOnly: true }),
  str('name', 'Name', 'The name shown in the Hierarchy.', NAME),
  entity('parentId', 'Parent', 'The parent object (none: a scene root).', { nullable: true, default: null }),
  bool('active', 'Active', 'Inactive objects are not in the game.', { default: true, omitDefault: true }),
  bool('locked', 'Locked', 'Cannot be selected in the Scene view.', { default: false, omitDefault: true }),
  bool('static', 'Static', 'Never moves (baked lighting, cheaper rendering).', { default: false, omitDefault: true }),
  int('tags', 'Tags', 'The tag bits (a 32-bit mask of the project\'s tags).', { min: 0, max: 0xffffffff, default: 0, omitDefault: true }),
  { type: 'components', key: 'components', label: 'Components', tooltip: 'What the object is and does.', required: true, allowed: [] },
]);

// ---- content blocks ----------------------------------------------------------------

const AUDIO_CUE = (key: string, label: string, tooltip: string): AssetRefFieldDescriptor => asset(key, label, tooltip, ['audio'], { required: true, nullable: true, default: null });

const GAME: FieldDescriptor = obj('game', 'Game', 'Title texts, who the player is, the camera, the start spawn and the sound cues.', [
  int('configVersion', 'Version', 'The game block format (2).', { required: true, min: 2, max: 2, default: 2, readOnly: true }),
  str('title', 'Title', 'The game\'s title.', { required: true, minLength: 1, maxLength: 64, default: 'Untitled game' }),
  str('objective', 'Objective', 'One line on what to do.', { required: true, minLength: 1, maxLength: 160, default: 'Reach the goal.' }),
  str('instructions', 'Instructions', 'How to play.', { required: true, minLength: 1, maxLength: 320, default: 'Move and jump.' }),
  entity('playerId', 'Player', 'The object the player controls.', { required: true, component: 'controller' }),
  entity('cameraId', 'Camera', 'The game camera.', { required: true, component: 'camera' }),
  entity('spawnId', 'Start spawn', 'Where the player starts.', { required: true, component: 'playerSpawn' }),
  obj('cues', 'Sound cues', 'Sounds for game events (none: silent).', [
    AUDIO_CUE('start', 'Start', 'Played when the game starts.'),
    AUDIO_CUE('jump', 'Jump', 'Played on every jump.'),
    AUDIO_CUE('checkpoint', 'Checkpoint', 'Played when a checkpoint is reached.'),
    AUDIO_CUE('death', 'Death', 'Played when the player dies.'),
    AUDIO_CUE('goal', 'Goal', 'Played when the goal is reached.'),
  ], { required: true }),
  // Phase 15.3: the session timing (absent: the engine defaults, the values every project played with before).
  num('respawnDelay', 'Respawn delay', 'The pause between a death and the respawn.', { group: 'Session', ...GAME_TIMING_LIMITS.respawnDelay, step: 0.05, unit: 's', default: GAME_TIMING_DEFAULTS.respawnDelay }),
  num('dropThroughTime', 'Drop-through time', 'How long a one-way platform lets the player fall through it (down + jump).', { group: 'Session', ...GAME_TIMING_LIMITS.dropThroughTime, step: 0.025, unit: 's', default: GAME_TIMING_DEFAULTS.dropThroughTime }),
  num('settleTime', 'Settle time', 'The world settles this long before the first frame (resting bodies start at rest).', { group: 'Session', ...GAME_TIMING_LIMITS.settleTime, step: 0.05, unit: 's', default: GAME_TIMING_DEFAULTS.settleTime }),
], { nullable: true, default: null });

const WIND = obj('wind', 'Wind', 'The global wind foliage and cloth sway in.', [
  vec2('direction', 'Direction', 'Horizontal direction [x, z] (not both 0).', { required: true, min: -1, max: 1, step: 0.05, nonZero: true, labels: ['x', 'z'], default: [...DEFAULT_WIND.direction] }),
  num('strength', 'Strength', 'Base strength (0: still air).', { required: true, min: 0, max: 10, step: 0.05, default: DEFAULT_WIND.strength }),
  num('gust', 'Gusts', 'Extra strength of gusts.', { required: true, min: 0, max: 10, step: 0.05, default: DEFAULT_WIND.gust }),
  num('gustFrequency', 'Gust frequency', 'Gusts per second.', { required: true, min: 0, max: 10, step: 0.05, default: DEFAULT_WIND.gustFrequency }),
  num('turbulence', 'Turbulence', 'Small-scale variation over space.', { required: true, min: 0, max: 1, step: 0.05, default: DEFAULT_WIND.turbulence }),
]);

// Phase 15.5: the sky defaults are the three.js Sky example's physically based
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
  color('bottomColor', 'Bottom colour', 'Below the horizon.', { when: when('mode', 'gradient'), default: '#757575' }), // phase 15.5: a neutral grey of the old olive's brightness — no ground (grass, sand, water, a floor) is assumed
  color('color', 'Colour', 'The one sky colour.', { when: when('mode', 'color'), default: '#7ec8ff' }),
  asset('texture', 'Image', 'An equirectangular sky image.', ['texture'], { when: when('mode', 'texture') }),
  list('cube', 'Cube faces', 'Six images +x, −x, +y, −y, +z, −z (instead of one image).', asset('*', 'Face', 'A cube face.', ['texture']), { when: when('mode', 'texture'), length: 6 }),
  num('intensity', 'Brightness', 'Background brightness.', { min: 0, max: 8, step: 0.05, default: 1 }),
  num('environmentIntensity', 'Sky lighting', 'How much the sky lights the scene (0: none).', { min: 0, max: 8, step: 0.05, default: 1 }),
], { rules: ['A texture sky needs an image or six cube faces.'] });

// Phase 15.5: fog is off by default; turned on it starts as a light grey-blue haze from 10 m to 120 m (a level's far end fades) or density 0.01.
const FOG = obj('fog', 'Fog', 'Distance fog.', [
  enm('mode', 'Fog', 'None, linear (near to far) or exponential (density).', ['none', 'linear', 'exp2'], { required: true, default: 'none', labels: { exp2: 'Exponential' } }),
  color('color', 'Colour', 'The fog colour.', { required: true, default: '#c8d2dc' }),
  num('near', 'Start', 'Fog starts here.', { when: when('mode', 'linear'), min: 0, max: 10000, step: 1, unit: 'm', default: 10 }),
  num('far', 'Full', 'Fog is full here.', { when: when('mode', 'linear'), min: 0, max: 10000, step: 1, unit: 'm', default: 120 }),
  num('density', 'Density', 'Exponential fog density.', { when: when('mode', 'exp2'), min: 0, max: 1, step: 0.001, default: 0.01 }),
]);

const effect = (key: string, label: string, tooltip: string, fields: readonly FieldDescriptor[]): ObjectFieldDescriptor =>
  obj(key, label, tooltip, [bool('enabled', 'On', `Turns ${label.toLowerCase()} on.`, { required: true, default: true }), ...fields]);

// Phase 15.5: every post effect starts neutral or off; AgX tone mapping at exposure 1 keeps bright lights from clipping in any palette.
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

const ENVIRONMENT: FieldDescriptor = obj('environment', 'Environment', 'Sky, fog, post-processing, wind and the default quality.', [
  SKY,
  FOG,
  POST,
  WIND,
  enm('quality', 'Quality', 'The default graphics quality (players change it in Settings).', ['low', 'medium', 'high'], { default: 'high' }),
]);

const FLOW: FieldDescriptor = obj('flow', 'Game flow', 'Levels, lives, the title screen, HUD, menu look and texts, volumes, menu sounds and score rules.', [
  list('levels', 'Levels', `1–${MAX_FLOW_LEVELS} levels played in order.`, obj('*', 'Level', 'A level: scenes played together and where the player starts.', [
    str('id', 'Id', 'A stable id (saves remember levels by it): letters, digits, _ or -.', { format: 'identifier', minLength: 1, maxLength: 64, required: true }),
    str('name', 'Name', 'Shown in menus.', { minLength: 1, maxLength: 64, required: true }),
    list('scenes', 'Scenes', `The scenes loaded for this level (1–${MAX_LEVEL_SCENES}).`, scene('*', 'Scene', 'A scene of the level.'), { required: true, minItems: 1, maxItems: MAX_LEVEL_SCENES, unique: true }),
    entity('spawnId', 'Start spawn', 'The player spawn the level starts at.', { required: true, component: 'playerSpawn', anyScene: true }),
    asset('music', 'Music', 'Loops while the level plays.', ['music']),
    obj('environment', 'Level look', 'Sky, fog, post and wind laid over the project environment while the level plays.', [SKY, FOG, POST, WIND]),
    list('ambience', 'Ambience', `1–${MAX_LEVEL_AMBIENCE} sounds looped while the level plays.`, asset('*', 'Sound', 'An audio or music asset.', ['audio', 'music']), { minItems: 1, maxItems: MAX_LEVEL_AMBIENCE, unique: true }),
  ]), { required: true, minItems: 1, maxItems: MAX_FLOW_LEVELS }),
  obj('lives', 'Lives', 'Lives per game (absent: unlimited).', [
    int('start', 'Start', 'Lives at the start.', { required: true, min: 1, max: 99, default: 3 }),
    int('max', 'Maximum', 'Most lives (at least the start).', { required: true, min: 1, max: 99, default: 9 }),
  ], { rules: ['max ≥ start'] }),
  obj('title', 'Title screen', 'A title screen before the first level (absent: starts on a key press).', [
    str('subtitle', 'Subtitle', 'A line under the title.', { maxLength: 160 }),
    asset('music', 'Music', 'Plays on the title screen.', ['music']),
    scene('scene', 'Background scene', 'Seen behind the title menu (absent: the first level\'s start).'),
    // Phase 15.5: a new pan starts at 4 m over 20 s each way (a slow 0.2 m/s drift, a
    // few character widths at human scale) — the same values as the Game window's "pan" box.
    obj('pan', 'Camera pan', 'A slow sideways pan behind the menu, then back.', [
      num('distance', 'Distance', 'How far sideways (negative: to the left; not 0).', { required: true, min: -MAX_TITLE_PAN_DISTANCE, max: MAX_TITLE_PAN_DISTANCE, nonZero: true, step: 0.5, unit: 'm', default: 4 }),
      num('seconds', 'Duration', 'Seconds each way.', { required: true, min: 2, max: 600, step: 1, unit: 's', default: 20 }),
    ]),
  ]),
  obj('hud', 'HUD', 'The in-game display.', [
    enm('preset', 'Layout', 'Where the counters sit.', HUD_PRESETS, { required: true, default: 'classic' }),
    bool('timer', 'Timer', 'Show the level time.', { default: false }),
  ]),
  obj('ui', 'Menu look', 'Font and colours of the menus and HUD.', [
    enm('font', 'Font', 'The menu font.', UI_FONTS, { required: true, default: 'sans' }),
    color('accent', 'Accent', 'Highlights and the selection.', { required: true, default: '#ffc857' }),
    color('panel', 'Panel', 'Menu backgrounds.', { required: true, default: '#1b2330' }),
    color('text', 'Text', 'Menu text.', { required: true, default: '#f4f1e8' }),
    asset('logo', 'Logo', 'An image shown instead of the title text.', ['texture']),
  ]),
  obj('texts', 'Texts', 'Menu texts.', [
    str('levelComplete', 'Level complete', 'Shown when a level is finished.', { maxLength: 64, default: 'Level complete' }),
    str('gameOver', 'Game over', 'Shown when the lives run out.', { maxLength: 64, default: 'Game over' }),
    str('credits', 'Credits', 'The credits screen text.', { maxLength: 2000, format: 'multiline' }),
  ]),
  obj('volumes', 'Volumes', 'Default volumes before the player changes them in Settings.', [
    num('music', 'Music', 'Music volume.', { required: true, min: 0, max: 1, step: 0.05, default: 0.8 }),
    num('sfx', 'Sounds', 'Sound-effect volume.', { required: true, min: 0, max: 1, step: 0.05, default: 1 }),
    num('ui', 'Menu sounds', 'Menu sound volume.', { min: 0, max: 1, step: 0.05, default: 1 }),
  ]),
  obj('sounds', 'Menu sounds', 'Sounds the menus make.', [
    asset('move', 'Move', 'The selection moves or a value changes.', ['audio']),
    asset('confirm', 'Confirm', 'An item is chosen.', ['audio']),
    asset('back', 'Back', 'Back out of a menu.', ['audio']),
  ]),
  obj('score', 'Score', 'How a level\'s score is made (absent: no score).', [
    // Phase 15.5: a new counter row starts at 10 points a unit (the Game window's value; whole-point room for smaller rewards and penalties).
    map('points', 'Points', 'Points per unit of a run counter (coins, gems, keys, lives, defeated or a custom counter; negative: a penalty).', 'Counter', int('*', 'Points', 'Points per unit.', { min: -MAX_SCORE_POINTS, max: MAX_SCORE_POINTS, default: 10 }), { keyFormat: 'counter', maxEntries: MAX_SCORE_COUNTERS }),
    // Phase 15.5: a new time bonus starts at a one-minute target and 10 points a second —
    // round figures the designer tunes (the Game window's starting values).
    obj('timeBonus', 'Time bonus', 'Points for every second under a target time.', [
      num('targetSeconds', 'Target time', 'No bonus over this time.', { required: true, min: 1, max: 36000, step: 1, unit: 's', default: 60 }),
      num('perSecond', 'Per second', 'Points per second under the target.', { required: true, min: 0, max: 100000, step: 1, unit: 'points/s', default: 10 }),
    ]),
  ]),
], { rules: ['Level scenes and spawns, music, logo and sounds must exist in the project.'] });

const KEY_CODE = { format: 'keyCode' as const, minLength: 1, maxLength: 32 };
const BINDING_KINDS = ['key', 'gamepadButton', 'gamepadAxis', 'keys1d', 'keys2d', 'gamepadButtons1d', 'gamepadStick'] as const;
const INPUT: FieldDescriptor = obj('input', 'Input', 'The game\'s actions and their keys and gamepad bindings (absent: the default actions).', [
  list('actions', 'Actions', `Up to ${MAX_INPUT_ACTIONS} named actions.`, obj('*', 'Action', 'A named action and its bindings.', [
    str('name', 'Name', 'The action name scripts and blocks read (a letter or _, then letters, digits or _).', { required: true, format: 'identifier', minLength: 1, maxLength: 32 }),
    enm('type', 'Type', 'A button, a 1D axis (left/right) or a 2D axis.', INPUT_ACTION_TYPES, { required: true, default: 'button', labels: { axis1d: 'Axis (1D)', axis2d: 'Axis (2D)' } }),
    enm('map', 'Map', 'Read by the game (gameplay) or the menus (ui).', INPUT_MAPS, { required: true, default: 'gameplay', labels: { ui: 'UI' } }),
    list('bindings', 'Bindings', `Up to ${MAX_INPUT_BINDINGS} keys, buttons, axes or composites.`, obj('*', 'Binding', 'One binding (it must fit the action type).', [
      enm('kind', 'Kind', 'What is bound.', BINDING_KINDS, { required: true, default: 'key', labels: { gamepadButton: 'Gamepad button', gamepadAxis: 'Gamepad axis', keys1d: 'Two keys (1D)', keys2d: 'Four keys (2D)', gamepadButtons1d: 'Two gamepad buttons (1D)', gamepadStick: 'Gamepad stick' } }),
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
    ], { rules: ['A button takes keys and buttons; a 1D axis also two-key, two-button and axis bindings; a 2D axis four keys or a stick.'] }), { required: true, maxItems: MAX_INPUT_BINDINGS }),
    num('deadZone', 'Dead zone', 'Axis values within this count as 0 (then rescaled).', { min: 0, max: 1, maxExclusive: true, step: 0.05, default: 0.2 }),
    bool('invert', 'Invert', 'Flip the axis.', { default: false }),
    num('scale', 'Scale', 'Multiply the value.', { min: 0, minExclusive: true, max: 10, step: 0.1, unit: '×', default: 1 }),
  ]), { required: true, maxItems: MAX_INPUT_ACTIONS }),
], { default: JSON.parse(JSON.stringify(DEFAULT_INPUT)) as DescriptorJson, rules: ['Action names are unique.'] });

/** One shader parameter, as a descriptor field (the schema lives in `MATERIAL_PARAMS`). */
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
  enm('shader', 'Shader', 'Standard, foliage (wind), kit (world-space detail), unlit or water.', MATERIAL_SHADERS, { required: true, default: 'standard' }),
  obj('params', 'Parameters', 'Shader parameter overrides.', MATERIAL_SHADERS.flatMap((s) => Object.entries(MATERIAL_PARAMS[s]).map(([k, t]) => paramField(k, t, s))), { required: true, default: {} }),
  obj('textures', 'Textures', 'Texture slots.', MATERIAL_SHADERS.flatMap((s) => MATERIAL_TEXTURE_SLOTS[s].map((slot) => asset(slot, slot.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), `The ${s} shader\'s ${slot} texture.`, ['texture'], { when: when('../shader', s) }))), { required: true, default: {} }),
  // Phase 18.0: a graph material's exposed parameters and its node graph.
  list('parameters', 'Exposed parameters', `Up to ${MAX_MATERIAL_PARAMETERS} parameters the graph reads (Parameter nodes); objects may override the public ones.`, obj('*', 'Parameter', 'An exposed parameter.', [
    str('key', 'Key', 'The name Parameter nodes and overrides use.', { required: true, format: 'identifier', minLength: 1, maxLength: 32 }),
    enm('type', 'Type', 'The value type (colour is a vec3 edited as a colour; a texture names a texture asset).', MATERIAL_PARAMETER_TYPES, { required: true, default: 'float' }),
    json('default', 'Default', 'The material\'s own value (a number, 2–4 numbers, "#rrggbb" or a texture asset id / "").', { required: true, typedBy: 'materialParameter' }),
    num('min', 'Min', 'The lowest value, within ±1e6 (numbers and vectors).', { when: when('type', 'float', 'vec2', 'vec3', 'vec4') }),
    num('max', 'Max', 'The highest value, within ±1e6 and at least min (numbers and vectors).', { when: when('type', 'float', 'vec2', 'vec3', 'vec4') }),
    enm('visibility', 'Visibility', 'Public: objects may override it. Private: the material\'s value only.', ['public', 'private'], { default: 'public', omitDefault: true }),
    str('label', 'Label', 'Shown instead of the key.', { minLength: 1, maxLength: 64 }),
    str('group', 'Group', 'A foldable group in the Inspector.', { minLength: 1, maxLength: 64 }),
    str('tooltip', 'Tooltip', 'Help text.', { minLength: 1, maxLength: 256 }),
  ]), { maxItems: MAX_MATERIAL_PARAMETERS }),
  json('graph', 'Graph', 'The node graph (graph kind "material"): nodes, wires, groups and comments, edited in the Material tab with graph edits.', { readOnly: true }),
]);

// Phase 20.0: a visual effect (systems of particles, each a graph of kind "effect").
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
        // Phase 16.2: editor-only (the blend tree graph).
        vec2('position', 'Graph position', 'Where the blend tree graph draws the clip (editor only).', { min: -1e6, max: 1e6, step: 1 }),
      ]), { required: true, when: when('kind', 'blend1d'), minItems: 2, maxItems: MAX_BLEND_CHILDREN }),
    ], { required: true }),
    num('speed', 'Speed', 'Playback speed (× the speed parameter when set).', { required: true, min: 0, max: 10, step: 0.05, unit: '×', default: 1 }),
    ref('speedParameter', 'Speed parameter', 'A float parameter the speed is multiplied by.', 'animatorParameter', { paramTypes: ['float'] }),
    bool('loop', 'Loop', 'Loops (else holds the last frame).', { required: true, default: true }),
    // Phase 16.2: the graph editor's coordinate bound (GRAPH_LIMITS.coordinate).
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
  // Phase 15.4: public (shown and set per object) or private (the script reads the default).
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

const CONTENT: readonly ContentBlockDescriptor[] = [
  { key: 'game', label: 'Game', tooltip: 'Title texts, the player, camera, start spawn and sound cues.', required: true, value: GAME, ops: ['setGameConfig'] },
  { key: 'flow', label: 'Game flow', tooltip: 'Levels, lives, title screen, HUD, menus, volumes and score.', required: false, value: FLOW, ops: ['setFlow'] },
  { key: 'environment', label: 'Environment', tooltip: 'Sky, fog, post-processing, wind and quality.', required: false, value: ENVIRONMENT, ops: ['setEnvironment'] },
  { key: 'input', label: 'Input', tooltip: 'Actions and their bindings.', required: false, value: INPUT, ops: ['setInput'] },
  { key: 'materials', label: 'Materials', tooltip: 'Project materials.', required: false, value: list('materials', 'Materials', `Up to ${MAX_MATERIALS} materials.`, MATERIAL_ITEM, { maxItems: MAX_MATERIALS, default: [] }), ops: ['setMaterial', 'deleteMaterial'] },
  { key: 'animators', label: 'Animator controllers', tooltip: 'State machines for model animation.', required: false, value: list('animators', 'Animator controllers', `Up to ${MAX_ANIMATORS} controllers.`, ANIMATOR_ITEM, { maxItems: MAX_ANIMATORS, default: [] }), ops: ['setAnimator', 'deleteAnimator'] },
  // Phase 20.0: visual effects; each system's graph is edited in the Effect tab (graphEdit ops).
  { key: 'effects', label: 'Effects', tooltip: 'Visual effects: particle systems authored as node graphs.', required: false, value: list('effects', 'Effects', `Up to ${EFFECT_LIMITS.effects} effects.`, EFFECT_ITEM, { maxItems: EFFECT_LIMITS.effects, default: [] }), ops: ['setEffect', 'deleteEffect', 'renameEffect', 'graphEdit'] },
  // Phase 16.1: standalone node graphs; their body is edited in the graph editor (graphEdit ops).
  { key: 'graphs', label: 'Graphs', tooltip: 'Standalone node graphs, edited in the graph editor.', required: false, value: list('graphs', 'Graphs', `Up to ${MAX_GRAPH_DOCUMENTS} graphs.`, json('*', 'Graph', 'A graph document: { graphId, kind, name, graph }.', { readOnly: true }), { maxItems: MAX_GRAPH_DOCUMENTS, default: [] }), ops: ['setGraph', 'deleteGraph', 'graphEdit'] },
  { key: 'tags', label: 'Tags', tooltip: 'Named tag bits objects carry.', required: false, value: list('tags', 'Tags', `Up to ${MAX_TAGS} tags.`, obj('*', 'Tag', 'A named bit.', [int('bit', 'Bit', 'The bit (0–31).', { required: true, min: 0, max: 31 }), str('name', 'Name', 'A letter, then letters, digits, _ or - (unique ignoring case).', { required: true, format: 'identifier', minLength: 1, maxLength: 32 })]), { maxItems: MAX_TAGS, default: [] }), ops: ['setTags'] },
  { key: 'settings', label: 'Gameplay settings', tooltip: 'Gravity, run speed, jump, slopes, and the engine settings (step rate, sound voices, music fade, animation blend).', required: true, value: SETTINGS, ops: ['setSettings'] },
  { key: 'scenes', label: 'Scenes', tooltip: 'The project\'s scenes.', required: true, value: list('scenes', 'Scenes', `1–${MAX_SCENES} scenes.`, obj('*', 'Scene', 'A scene file.', [str('sceneId', 'Id', 'The stable scene id.', { ...ID, required: true, readOnly: true }), str('name', 'Name', 'Shown in the scene list.', { ...NAME, required: true })]), { required: true, minItems: 1, maxItems: MAX_SCENES }), ops: ['createScene', 'renameScene', 'deleteScene'] },
  { key: 'startScenes', label: 'Start scenes', tooltip: 'The scenes loaded when the game starts (without a flow).', required: true, value: list('startScenes', 'Start scenes', `1–${MAX_SCENES} scenes.`, scene('*', 'Scene', 'A start scene.'), { required: true, minItems: 1, maxItems: MAX_SCENES, unique: true }), ops: ['setStartScenes'] },
  {
    key: 'assets',
    label: 'Assets',
    tooltip: 'Imported models, sounds, textures and music (their versions are written by the importer).',
    required: true,
    value: list('assets', 'Assets', 'The asset catalog.', obj('*', 'Asset', 'An imported asset.', [
      str('assetId', 'Id', 'The stable asset id.', { ...ID, required: true, readOnly: true }),
      enm('kind', 'Kind', 'Model, audio, texture or music.', ASSET_KINDS, { required: true, readOnly: true }),
      str('displayName', 'Name', 'Shown in the asset browser.', { ...NAME, required: true, readOnly: true }),
      int('currentVersion', 'Version', 'The current version (the last).', { required: true, min: 1, readOnly: true }),
      list('versions', 'Versions', 'Every imported version (append-only, written by the importer).', json('*', 'Version', 'An imported version: source, recipe and metrics.', { readOnly: true }), { required: true, minItems: 1, readOnly: true }),
      enm('vertexColors', 'Vertex colours', 'Data: COLOR_0 feeds shaders (wind weights). Tint: multiplies the colour.', ['data', 'tint'], { when: when('kind', 'model'), default: 'data', omitDefault: true }),
      map('materials', 'Default materials', 'Material slot → project material, for every placement.', 'Slot', ref('*', 'Material', 'A project material.', 'material'), { when: when('kind', 'model'), keyFormat: 'materialSlot', minEntries: 1, maxEntries: MAX_MATERIAL_SLOTS }),
      asset('clipsFor', 'Clips for', 'An animation-only file: its clips play on this model\'s rig.', ['model'], { when: when('kind', 'model') }),
    ]), { required: true }),
    ops: ['publishAsset', 'setAssetOptions'],
  },
  {
    key: 'prefabs',
    label: 'Prefabs',
    tooltip: 'Captured object groups placed as independent copies.',
    required: true,
    value: list('prefabs', 'Prefabs', `Up to ${MAX_PREFABS} definitions.`, obj('*', 'Prefab', 'A captured definition (immutable).', [
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
    ]), { required: true, maxItems: MAX_PREFABS }),
    ops: ['createPrefab', 'instantiatePrefab'],
  },
  {
    key: 'behaviors',
    label: 'Behaviors',
    tooltip: 'Published scripts and their declared properties.',
    required: true,
    value: list('behaviors', 'Behaviors', `Up to ${MAX_BEHAVIORS} behaviors.`, obj('*', 'Behavior', 'A published script.', [
      str('behaviorId', 'Id', 'The stable behavior id.', { ...ID, required: true, readOnly: true }),
      str('displayName', 'Name', 'Shown in pickers.', { ...NAME, required: true }),
      obj('declaration', 'Declaration', 'The properties objects set.', [list('properties', 'Properties', `1–${MAX_PROPERTIES} declared properties.`, DECLARED_PROPERTY, { required: true, minItems: 1, maxItems: MAX_PROPERTIES })], { required: true }),
      json('source', 'Source', 'The compiled source record (written by the behavior build; none: declaration only).', { required: true, nullable: true, readOnly: true }),
      int('publishedRevision', 'Published at', 'The project revision it was published at.', { required: true, min: 0, readOnly: true }),
    ]), { required: true, maxItems: MAX_BEHAVIORS }),
    ops: ['publishBehavior'],
  },
  { key: 'behaviorTrust', label: 'Script trust', tooltip: 'Which script sources the owner acknowledged.', required: true, value: obj('behaviorTrust', 'Script trust', 'Acknowledged sources.', [list('entries', 'Entries', 'Acknowledged source digests.', json('*', 'Entry', 'A source digest and the revision it was acknowledged at.', { readOnly: true }), { required: true, readOnly: true })], { required: true, readOnly: true }), ops: ['acknowledgeBehaviorTrust'] },
  { key: 'lighting', label: 'Baked lighting', tooltip: 'Each scene\'s lightmap bake (written by the baker).', required: false, value: map('lighting', 'Baked lighting', 'Scene → its bake.', 'Scene', json('*', 'Bake', 'Lightmap atlases, entries and the hashes the bake was made from.', { readOnly: true }), { keyRef: 'scene', readOnly: true }), ops: ['setLighting'] },
];

// ---- the registry -------------------------------------------------------------------

const COMPONENTS: readonly ComponentDescriptor[] = [
  transform,
  model,
  box,
  materials,
  materialParams,
  effectComponent,
  surface,
  instances,
  fogVolume,
  collider,
  controller,
  camera,
  cameraFollow,
  light,
  gameZone,
  playerSpawn,
  mover,
  trigger,
  switchC,
  health,
  pickup,
  enemy,
  audioSource,
  animator,
  faceMovement,
  modelAnimation,
  behavior,
  prefab,
  folder,
];

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

/**
 * The registry (deep-frozen). Plain JSON: `JSON.parse(JSON.stringify(DESCRIPTORS))`
 * equals it, which is how it travels to the editor (`queryGameConfig.descriptors`).
 */
export const DESCRIPTORS: DescriptorRegistry = deepFreeze({
  version: 1,
  handleKinds: [...HANDLE_KINDS],
  handleRoles: HANDLE_ROLES,
  entity: { ...ENTITY, fields: ENTITY.fields.map((f) => (f.key === 'components' ? { ...f, allowed: COMPONENTS.map((c) => c.name) } : f)) },
  components: COMPONENTS,
  content: CONTENT,
});
