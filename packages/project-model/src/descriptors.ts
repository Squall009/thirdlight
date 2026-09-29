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

import { EVENT_CUE_BUSES, EVENT_CUE_LIMITS, EVENT_CUE_SOURCES } from './event-cues';
import { SHELL_LIMITS } from './shell';
import { SAVE_LIMITS, SAVE_SECTIONS } from './save-schema';
import { MAX_ANIMATOR_MORPHS } from './animator';
import { ANIMATOR_CONDITION_OPS, ANIMATOR_PARAMETER_TYPES, MAX_ANIMATOR_CONDITIONS, MAX_ANIMATOR_EVENTS, MAX_ANIMATOR_LAYERS, MAX_ANIMATOR_PARAMETERS, MAX_ANIMATOR_STATES, MAX_ANIMATOR_TRANSITIONS, MAX_ANIMATORS, MAX_BLEND_CHILDREN, MAX_LAYER_MASK } from './animator';
import { BLOCK_DEFAULTS, BLOCK_TUNING_LIMITS, HITBOX_SHAPES, GRAVITY_SCALE, MOVER_EASINGS, MOVER_MODES, PATROL_MODES, PRIMITIVE_DEFAULTS, PRIMITIVE_LIMITS, SWITCH_MODES, SWITCH_DEFAULT_ACTION, FACE_MOVEMENT_MODES, MAX_TRANSITION_FADE, MAX_TRANSITION_UNLOADS, TRIGGER_HEIGHT, TRIGGER_MODES, TRIGGER_RADIUS, TRIGGER_SHAPES } from './blocks';
import { CAPSULE_LIMITS, CHARACTER_3D_LIMITS, COLLIDER_3D_LIMITS, CONTROLLER_ACTION_DEFAULTS, CONTROLLER_MOVEMENT_LIMITS, DEFAULT_CONTROLLER_MOVEMENT, CONTROLLER_TUNING_LIMITS, DEFAULT_CHARACTER_3D, DEFAULT_CONTROLLER_CAPSULE, DEFAULT_CONTROLLER_TUNING, MAX_COLLIDER_EXTENT, MAX_COLLISION_LAYERS, MAX_POLYGON_VERTICES } from './components';
import { M2_SETTINGS_KEYS, MAX_BEHAVIORS, MAX_ENUM_VALUES, MAX_PREFAB_ENTITIES, MAX_PREFABS, MAX_PROPERTIES, MAX_SCENES, PREFAB_V4_COMPONENTS } from './content';
import { CURSOR_MODES, DEFAULT_INPUT, INPUT_ACTION_TYPES, INPUT_HOLD_MAX, INPUT_HOLD_MIN, INPUT_MAPS, MAX_INPUT_ACTIONS, MAX_INPUT_BINDINGS, MAX_INPUT_MAPS, MAX_INPUT_GLYPHS, POINTER_AXES, POINTER_BUTTONS } from './input';
import { MAX_GRAPH_DOCUMENTS } from './graph';
import { EFFECT_DEFAULTS, EFFECT_LIMITS, EFFECT_PARAMETER_TYPES } from './effects';
import { UI_LIMITS } from './ui-documents';
import { DIALOGUE_LIMITS } from './dialogue';
import { TIMELINE_LIMITS } from './timelines';
import { UI_DESCRIPTORS, type UiDescriptors } from './ui-descriptors';
import { SCRIPT_LIBRARY_LIMITS } from './script-libraries';
import { BLOCK_LIMITS } from './block-layers';
import { blockFootprint, blockLayer } from './block-descriptors';
import { DEFAULT_WIND, MATERIAL_PARAMS, MATERIAL_SHADERS, MATERIAL_TEXTURE_SLOTS, MAX_MATERIAL_PARAMETERS, MAX_MATERIAL_SLOTS, MAX_MATERIALS, type MaterialParamType } from './materials';
import { MATERIAL_DATA_MAX, MATERIAL_PARAMETER_TYPES } from './material-graph-kinds';
import { SOCKET_ATTACH_CONFLICTS, SOCKET_ATTACH_LIMITS } from './sockets';
import { MODE_BLENDS, MODE_DEFAULTS, MODE_LIMITS, MODE_PHYSICS, MODE_UNGROUPED } from './modes';
import { CAMERA_BLENDS, CAMERA_PATH_LIMITS, CAMERA_RAIL_MODES, CAMERA_REGION_DEFAULTS, CAMERA_REGION_LIMITS, VIRTUAL_CAMERA_DEFAULTS as VCD, VIRTUAL_CAMERA_LIMITS as VCL, VIRTUAL_CAMERA_RIGS } from './cameras';
import { DIRECTIONAL_SHADOW_DEFAULTS, DIRECTIONAL_SHADOW_LIMITS, MAX_EMISSIVE_INTENSITY, MAX_INTENSITY, MAX_LOCAL_INTENSITY, SURFACE_DEFAULTS } from './scene-v3';
import { MAX_INSTANCES, MAX_TAGS } from './types-v3';

// ---- the descriptor types ----------------------------------------------------

/** A JSON value (defaults, presets, create values). */
export type DescriptorJson = null | boolean | number | string | readonly DescriptorJson[] | { readonly [k: string]: DescriptorJson };
export type DescriptorScalar = string | number | boolean;

/** The units a field may be in (display text; values are stored in these units). */
export type DescriptorUnit = 'm' | 'm/s' | 'm/s²' | 's' | 'deg' | 'deg/s' | 'cd' | '1/m' | 'points' | 'points/s' | '×' | 'Hz' | 'voices' | 'px';

/** The Scene-view handle kinds (15.2 draws and drags them). */
export const HANDLE_KINDS = ['box2', 'box3', 'radius', 'capsule', 'cone', 'direction', 'path', 'polygon', 'point', 'height', 'bounds'] as const;
export type HandleKind = (typeof HANDLE_KINDS)[number];

/**
 * The roles each handle kind binds to fields, as alternative role sets
 * (a `box2` edits a `[w, h]` size, or half extents `hx`/`hy`).
 */
export const HANDLE_ROLES: Readonly<Record<HandleKind, readonly (readonly string[])[]>> = {
  // Phase 23.0: half extents with an optional depth (a collider box: three axes once hz is set).
  box2: [['size'], ['halfX', 'halfY'], ['halfX', 'halfY', 'halfZ']],
  box3: [['size']],
  radius: [['radius']],
  // Phase 23.1: a centred capsule (a collider or trigger) has no offset.
  capsule: [['radius', 'height', 'offset'], ['radius', 'height']],
  cone: [['direction', 'angle', 'range']],
  direction: [['direction']],
  path: [['points']],
  polygon: [['vertices']],
  point: [['point']],
  // Phase 23.2: a height above the object's origin (or above the feet of a capsule, `from`), dragged up and down.
  height: [['height']],
  // Phase 25.14: an axis-aligned box between two corners (a track camera's bounds), each corner dragged.
  bounds: [['min', 'max']],
};

export const ASSET_KINDS = ['model', 'audio', 'texture', 'music', 'font'] as const;
export type DescriptorAssetKind = (typeof ASSET_KINDS)[number];

/** What an `ref` field names (besides assets, entities and scenes). */
export type DescriptorRefTarget = 'material' | 'animator' | 'behavior' | 'prefab' | 'animatorParameter' | 'animatorState' | 'clip' | 'effect' | 'uiDocument' | 'uiTheme' | 'uiTween' | 'uiWidget' | 'behaviorGroup' | 'inputMap' | 'mode';

/** String formats (validation hints and widget choices). */
export type DescriptorStringFormat = 'id' | 'name' | 'identifier' | 'keyCode' | 'counter' | 'multiline' | 'sha256' | 'materialSlot' | 'boneName' | 'socketNode';

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
  /** Phase 23.2: the project physics dimension the field applies in (absent: both); the Inspector shows the project's. */
  readonly dimension?: 2 | 3;
  /**
   * Phase 25.10: scripts read it (`ctx.entity(ref).get(component)`: a
   * read-only snapshot of the step-start state). The marks are versioned with
   * the project schema (`SCRIPT_ACCESS_SCHEMA_VERSION`): renaming a marked
   * field is a schema change.
   */
  readonly scriptReadable?: true;
  /**
   * Phase 25.10: scripts may write it while the game runs
   * (`ctx.entity(ref).set(component, patch)`, applied at the end of the step);
   * each such field has defined runtime behavior. Every other field is fixed
   * at run time and a write to it is refused naming the field.
   */
  readonly runtimeWritable?: true;
  /** Phase 25.10: exists only while the game runs (never stored; starts at `default`). */
  readonly runtimeOnly?: true;
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
  /** Phase 23.0: a vec3 whose last component may be left out (`[x, y]` reads as `[x, y, 0]`). */
  readonly optionalLast?: boolean;
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
  readonly typedBy?: 'behaviorDeclaration' | 'animatorParameter' | 'propertyType' | 'materialParameter' | 'effectParameter' | 'uiBinding' | 'uiAction' | 'uiStyleRef' | 'uiWidget' | 'uiPadding' | 'uiStyle' | 'uiStyleState';
  /** Phase 23.9b (`uiBinding`): the plain value a binding stands in for (the editor offers it or a view-model path). */
  readonly valueType?: 'number' | 'text' | 'bool' | 'texture' | 'entity';
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
  readonly follows?: 'position' | 'rotationZ' | 'rotation' | 'transform';
  /** Phase 15.2 (`radius`): measured along X only (the engine compares horizontal distance) instead of in the X/Y plane. */
  readonly along?: 'x';
  /** Phase 15.2 (`radius` along X): a field (pointer) giving the half height of the band drawn with it (read, not dragged). */
  readonly band?: string;
  /** Phase 15.2 (`path`): the path closes back to its start while this holds. */
  readonly loop?: FieldCondition;
  /** Phase 23.2: the project physics dimension the handle applies in (absent: both). */
  readonly dimension?: 2 | 3;
  /** Phase 23.2 (`height`): a capsule field (pointer to its object) whose feet the height is measured from (read, not dragged). */
  readonly from?: string;
  /**
   * Phase 25.14: the frame's origin is another object — the one an entity
   * field (pointer) names, plus an optional offset field — instead of this
   * object (a track camera's dead zone sits around its target). Without that
   * object the handle is not shown.
   */
  readonly anchor?: { readonly entity: string; readonly offset?: string };
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

/**
 * Phase 24.5: the icon an object carrying the component shows in the Scene
 * view and the hierarchy (the editor draws the artwork). When an object
 * carries several components with icons, the one earliest in this list wins
 * (the most specific first).
 */
export const COMPONENT_ICONS = ['camera', 'spawn', 'audio', 'fog', 'patrol', 'mover', 'switch', 'collectible', 'sensor', 'hitbox', 'health'] as const;
export type ComponentIcon = (typeof COMPONENT_ICONS)[number];

/**
 * Phase 24.5: a GameObject menu entry that creates a new object carrying the
 * component (the menus render from these; no hard-coded list).
 */
export interface CreateEntryDescriptor {
  readonly label: string;
  /** The GameObject submenu it sits in (absent: the menu itself). An existing submenu of that name gains it. */
  readonly menu?: string;
  /** The new object's name (absent: the label). */
  readonly name?: string;
  /** A placeholder box of this size (m) and colour (absent: an empty object). */
  readonly box?: { readonly size: readonly [number, number, number]; readonly color: string };
  /** The component's value (absent: its "+ Add component" value). */
  readonly value?: DescriptorJson;
  /** Other components the new object carries (a platform's collider). */
  readonly with?: { readonly [component: string]: DescriptorJson };
  /** The project physics dimension the entry fits (absent: both). */
  readonly dimension?: 2 | 3;
  /** Pointers into `value` set to another scene of the project when created (the entry needs a second scene). */
  readonly otherScene?: readonly string[];
}

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
  /** Phase 23.1: `dimension` — the project physics dimension a preset fits (absent: both; the "+ Add component" list shows the project's). */
  readonly presets?: readonly { readonly label: string; readonly value: DescriptorJson; readonly dimension?: 2 | 3 }[];
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
  /** Phase 24.5: the GameObject menu entries that create an object with it. */
  readonly create?: readonly CreateEntryDescriptor[];
  /** Phase 24.5: the object's icon (see `COMPONENT_ICONS`). */
  readonly icon?: ComponentIcon;
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
  /** Phase 24.5: the component icons, most specific first (an object shows the first its components name). */
  readonly icons?: readonly ComponentIcon[];
  /** Every v4 content block. */
  readonly content: readonly ContentBlockDescriptor[];
  /** Phase 23.9b: the fields of a UI document, a widget, a style and a tween (the UI document editor's Inspector). */
  readonly ui?: UiDescriptors;
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

const PHYSICS_RULES = ['A physics body (collider or controller) is a root object at unit scale [1, 1, 1], rotated about Z only in a 2D-plane project (any axis in a 3D one); the player controller stands upright.'];
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
    // Phase 17.4: true by default — solid geometry blocks the light and shows the shadows falling on it in any genre.
    bool('castShadow', 'Casts shadows', 'Blocks the directional light: casts a realtime shadow (off for decals, glows, backdrops).', { default: true, omitDefault: true }),
    bool('receiveShadow', 'Receives shadows', 'Shows the realtime shadows falling on it.', { default: true, omitDefault: true }),
  ]),
  add: { kind: 'pick', value: { asset: {} }, pick: ['asset/assetId'] },
  handles: [],
  excludes: [
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
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
    // Phase 17.4: true by default — solid geometry blocks the light and shows the shadows falling on it in any genre.
    bool('castShadow', 'Casts shadows', 'Blocks the directional light: casts a realtime shadow (off for decals, glows, backdrops).', { default: true, omitDefault: true }),
    bool('receiveShadow', 'Receives shadows', 'Shows the realtime shadows falling on it.', { default: true, omitDefault: true }),
  ]),
  add: { kind: 'menu', value: { size: [1, 1, 1], material: { color: '#b0b0b0' } } },
  handles: [{ kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local', follows: 'transform' }],
  excludes: [
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
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
    { component: 'socketAttach', reason: 'a socket poses the object every step; the scene camera is posed by its camera module' },
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
    { component: 'model', reason: 'an object shows one model, box or camera' },
    { component: 'box', reason: 'an object shows one model, box or camera' },
    { component: 'instances', reason: 'an instance set is scenery, not a camera' },
    { component: 'virtualCamera', reason: 'a virtual camera is a shot; the scene camera draws whichever shot is live' },
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
  tooltip: 'A solid shape the player stands on and bumps into (a box or a convex polygon in the X/Y plane; in a 3D project a box with a depth, a sphere, a capsule, a convex hull or a triangle mesh).',
  category: 'Physics',
  value: obj('collider', 'Collider', 'The collision shape.', [
    obj('shape', 'Shape', 'A box (half extents) or a convex polygon; in a 3D project also a sphere, a capsule, a convex hull or a triangle mesh.', [
      enm('type', 'Shape', 'Box or convex polygon (2D plane); box, sphere, capsule, convex hull or mesh (3D project).', ['box', 'polygon', 'sphere', 'capsule', 'convex', 'mesh'], { required: true, default: 'box' }),
      num('hx', 'Half width', 'Half the box width.', { required: true, when: when('type', 'box'), min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.05, unit: 'm', default: 0.5, handle: 'box2' }),
      num('hy', 'Half height', 'Half the box height.', { required: true, when: when('type', 'box'), min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.05, unit: 'm', default: 0.5, handle: 'box2' }),
      // Phase 23.0: the depth. Absent in a 2D plane (which ignores it); required by a 3D project (no guessed depth).
      num('hz', 'Half depth', 'Half the box depth along Z (needed in a 3D project; a 2D plane ignores it).', { when: when('type', 'box'), min: 0, minExclusive: true, max: POSITION_LIMIT, step: 0.05, unit: 'm', handle: 'box2' }),
      list('vertices', 'Vertices', `3–${MAX_POLYGON_VERTICES} corners [x, y], counter-clockwise, convex.`, vec2('*', 'Vertex', 'A corner [x, y] from the object origin.', { min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.05, unit: 'm' }), {
        required: true,
        when: when('type', 'polygon'),
        minItems: 3,
        maxItems: MAX_POLYGON_VERTICES,
        handle: 'polygon',
      }),
      // Phase 23.1: the 3D shapes (a 3D project). A capsule stands along the object's Y, its height the controller's convention (end caps included).
      num('radius', 'Radius', 'The sphere\'s radius.', { required: true, when: when('type', 'sphere'), min: 0, minExclusive: true, max: MAX_COLLIDER_EXTENT, step: 0.05, unit: 'm', default: 0.5, handle: 'radius' }),
      num('radius', 'Radius', 'The capsule\'s radius.', { required: true, when: when('type', 'capsule'), min: 0, minExclusive: true, max: MAX_COLLIDER_EXTENT, step: 0.05, unit: 'm', default: 0.5, handle: 'capsule' }),
      num('height', 'Height', 'The capsule\'s total height along the object\'s Y (end caps included; at least twice the radius).', { required: true, when: when('type', 'capsule'), min: 0, minExclusive: true, max: 2 * MAX_COLLIDER_EXTENT, step: 0.05, unit: 'm', default: 2, handle: 'capsule' }),
      // Generated from a model (its _COL node, else its geometry) and stored as data; shown read-only.
      list('points', 'Hull points', `4–${COLLIDER_3D_LIMITS.convexPoints} points [x, y, z] whose convex hull is the shape (made from a model).`, vec3('*', 'Point', 'A point [x, y, z] from the object origin.', { min: -MAX_COLLIDER_EXTENT, max: MAX_COLLIDER_EXTENT, unit: 'm' }), {
        required: true,
        when: when('type', 'convex'),
        minItems: 4,
        maxItems: COLLIDER_3D_LIMITS.convexPoints,
        readOnly: true,
      }),
      list('vertices', 'Mesh vertices', `3–${COLLIDER_3D_LIMITS.meshVertices} vertices [x, y, z] (made from a model).`, vec3('*', 'Vertex', 'A vertex [x, y, z] from the object origin.', { min: -MAX_COLLIDER_EXTENT, max: MAX_COLLIDER_EXTENT, unit: 'm' }), {
        required: true,
        when: when('type', 'mesh'),
        minItems: 3,
        maxItems: COLLIDER_3D_LIMITS.meshVertices,
        readOnly: true,
      }),
      list('triangles', 'Mesh triangles', `1–${COLLIDER_3D_LIMITS.meshTriangles} triangles [a, b, c] (vertex indices; made from a model).`, vec3('*', 'Triangle', 'Three different vertex indices [a, b, c].'), {
        required: true,
        when: when('type', 'mesh'),
        minItems: 1,
        maxItems: COLLIDER_3D_LIMITS.meshTriangles,
        readOnly: true,
      }),
    ], { required: true, rules: ['A polygon is convex, counter-clockwise, has no repeated corner, an area of at least 1e-6 m² and stays within 64 m of the origin.', 'Sphere, capsule, convex hull and mesh are 3D shapes (physics_dimension 3); a mesh is static level geometry (not on a mover).'] }),
    bool('oneWay', 'One-way', 'The player can jump up through it and land on top (a platform).', { default: false, omitDefault: true }),
    // Phase 23.3: absent = the implicit "default" layer (every collider is in one layer; none has to be named).
    list('layers', 'Collision layers', `The collision layers it is in (3D; absent: "default"). Script queries filter by layer; name layers in the project's collision layers.`, str('*', 'Layer', 'A collision layer: "default" or one the project names.', { format: 'identifier', minLength: 1, maxLength: 32 }), { minItems: 1, maxItems: 16, unique: true }),
  ]),
  add: { kind: 'menu', value: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } },
  // Phase 24.5: a 3 × 0.2 m shelf (a platform to land on, thin enough to jump up through), 2D only (a 3D project has no one-way colliders).
  create: [{ label: 'One-way platform', menu: 'Gameplay', box: { size: [3, 0.2, 2], color: '#8fb573' }, value: { shape: { type: 'box', hx: 1.5, hy: 0.1 }, oneWay: true }, dimension: 2 }],
  presets: [
    { label: 'Box', value: { shape: { type: 'box', hx: 0.5, hy: 0.5 } }, dimension: 2 },
    { label: 'Polygon', value: { shape: { type: 'polygon', vertices: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] } }, dimension: 2 },
    // Phase 23.1 (3D projects): a 1 m box, a 0.5 m sphere, a 2 m capsule, a 1 m cube's hull and a 1 m floor quad as starting shapes.
    { label: 'Box (3D)', value: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } }, dimension: 3 },
    { label: 'Sphere', value: { shape: { type: 'sphere', radius: 0.5 } }, dimension: 3 },
    { label: 'Capsule', value: { shape: { type: 'capsule', radius: 0.5, height: 2 } }, dimension: 3 },
    { label: 'Convex hull', value: { shape: { type: 'convex', points: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] } }, dimension: 3 },
    { label: 'Mesh', value: { shape: { type: 'mesh', vertices: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]], triangles: [[0, 2, 1], [0, 3, 2]] } }, dimension: 3 },
  ],
  handles: [
    { kind: 'box2', label: 'Box size', bind: { halfX: 'shape/hx', halfY: 'shape/hy', halfZ: 'shape/hz' }, space: 'local', when: when('shape/type', 'box'), follows: 'rotationZ' },
    { kind: 'polygon', label: 'Polygon', bind: { vertices: 'shape/vertices' }, space: 'local', when: when('shape/type', 'polygon'), follows: 'rotationZ' },
    // Phase 23.1: the 3D shapes turn and scale with the object (a 3D collider takes its whole transform).
    { kind: 'radius', label: 'Sphere radius', bind: { radius: 'shape/radius' }, space: 'local', when: when('shape/type', 'sphere'), follows: 'transform' },
    { kind: 'capsule', label: 'Capsule', bind: { radius: 'shape/radius', height: 'shape/height' }, space: 'local', when: when('shape/type', 'capsule'), follows: 'transform' },
  ],
  excludes: [
    { component: 'socketAttach', reason: 'a socket poses the object every step; a physics body is posed by physics' },
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
    { component: 'controller', reason: 'the player controller has its own capsule' },
    { component: 'playerSpawn', reason: 'a player spawn is a marker' },
    { component: 'instances', reason: 'an instance set is scenery without its own body' },
    { component: 'patrol', reason: 'a patroller is not a physics body (give it a hitbox)' },
    { component: 'gravity', reason: 'a gravity body is not a physics body (give it a hitbox)' },
  ],
  prefab: true,
  rules: PHYSICS_RULES,
};

const CT = DEFAULT_CONTROLLER_TUNING;
const TL = CONTROLLER_TUNING_LIMITS;
const C3 = DEFAULT_CHARACTER_3D;
const C3L = CHARACTER_3D_LIMITS;
const CML = CONTROLLER_MOVEMENT_LIMITS;
const CMD = DEFAULT_CONTROLLER_MOVEMENT;
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
      // Phase 23.0: [x, y] or [x, y, z] — z places the capsule in depth in a 3D project (a 2D plane ignores it).
      vec3('offset', 'Offset', 'The capsule centre from the object origin (z: in a 3D project).', { min: -CAPSULE_LIMITS.maxOffset, max: CAPSULE_LIMITS.maxOffset, step: 0.01, unit: 'm', default: [...DEFAULT_CONTROLLER_CAPSULE.offset], handle: 'capsule', optionalLast: true }),
    ], { group: 'Collision', rules: ['height ≥ 2 × radius'] }),
    // Phase 15.3: the movement tuning (absent: the engine defaults, the values every project played with before).
    num('acceleration', 'Acceleration', 'How fast it speeds up toward the run speed (40: a 4 m/s run in 0.1 s).', { group: 'Movement', ...TL.acceleration, step: 1, unit: 'm/s²', default: CT.acceleration }),
    num('deceleration', 'Deceleration', 'How fast it slows down when the input eases or stops.', { group: 'Movement', ...TL.deceleration, step: 1, unit: 'm/s²', default: CT.deceleration }),
    num('coyoteTime', 'Coyote time', 'A jump still starts this long after walking off an edge.', { group: 'Jump', ...TL.coyoteTime, step: 0.01, unit: 's', default: CT.coyoteTime }),
    num('jumpBuffer', 'Jump buffer', 'A jump pressed this long before landing still happens on landing.', { group: 'Jump', ...TL.jumpBuffer, step: 0.01, unit: 's', default: CT.jumpBuffer }),
    num('jumpRelease', 'Jump release', 'Share of the upward speed kept when jump is released early (1: a fixed jump height).', { group: 'Jump', ...TL.jumpRelease, step: 0.05, unit: '×', default: CT.jumpRelease }),
    num('groundSnap', 'Ground snap', 'Pulls the character down onto ground this close below it (walking down slopes and bumps).', { group: 'Collision', ...TL.groundSnap, step: 0.01, unit: 'm', default: CT.groundSnap }),
    num('skin', 'Skin', 'The small gap the character keeps from walls and floors.', { group: 'Collision', ...TL.skin, step: 0.001, unit: 'm', default: CT.skin }),
    // Phase 23.2: the 2D plane's autostep; a 3D character steps up with `stepHeight` instead.
    bool('autostep', 'Autostep', 'Climb low steps without jumping.', { group: 'Collision', default: CT.autostep, dimension: 2 }),
    num('autostepHeight', 'Step height', 'The highest step it climbs.', { group: 'Collision', when: when('autostep', true), ...TL.autostepHeight, step: 0.01, unit: 'm', default: CT.autostepHeight, dimension: 2 }),
    // Phase 23.2: the 3D character (physics_dimension 3; a 2D plane ignores these).
    num('walkSpeed', 'Walk speed', 'Speed with the move input fully pushed (2: a brisk walk).', { group: 'Movement', ...C3L.walkSpeed, step: 0.1, unit: 'm/s', default: C3.walkSpeed, dimension: 3 }),
    num('runSpeed', 'Run speed', 'Speed while the "run" input action is held (absent: the project run speed setting).', { group: 'Movement', ...C3L.runSpeed, step: 0.1, unit: 'm/s', dimension: 3 }),
    num('airControl', 'Air control', 'Share of the acceleration it has in the air (0: no steering mid-jump, 1: as on the ground).', { group: 'Movement', ...C3L.airControl, step: 0.05, unit: '×', default: C3.airControl, dimension: 3 }),
    num('gravityScale', 'Gravity scale', 'Multiplies the project gravity for this character.', { group: 'Movement', ...C3L.gravityScale, step: 0.1, unit: '×', default: C3.gravityScale, dimension: 3 }),
    num('turnSpeed', 'Turn speed', 'How fast it turns to face where it moves (0: at once).', { group: 'Movement', ...C3L.turnSpeed, step: 10, unit: 'deg/s', default: C3.turnSpeed, dimension: 3 }),
    bool('faceMovement', 'Face movement', 'Turn the object about its up axis to face the direction it moves (its +Z forward).', { group: 'Movement', default: C3.faceMovement, dimension: 3 }),
    bool('jump', 'Can jump', 'The jump input makes it jump (off: a character that only walks).', { group: 'Jump', default: C3.jump, dimension: 3 }),
    num('jumpSpeed', 'Jump speed', 'Upward speed at a jump (absent: the project jump velocity setting).', { group: 'Jump', when: when('jump', true), ...C3L.jumpSpeed, step: 0.1, unit: 'm/s', dimension: 3 }),
    num('slopeLimit', 'Slope limit', 'The steepest slope it walks up (absent: the project max_slope_climb_deg setting).', { group: 'Collision', ...C3L.slopeLimit, step: 1, unit: 'deg', dimension: 3 }),
    num('stepHeight', 'Step-up height', 'Steps up to this height are climbed without a jump (0.3: a stair riser; 0: off). The ground snap is at least this, so it walks down them too.', { group: 'Collision', ...C3L.stepHeight, step: 0.01, unit: 'm', default: C3.stepHeight, dimension: 3, handle: 'height' }),
    bool('ledgeClimb', 'Ledge climb', 'Pushing against a ledge higher than a step pulls the character up onto it.', { group: 'Collision', default: C3.ledgeClimb, dimension: 3 }),
    num('ledgeHeight', 'Ledge height', 'The highest ledge it climbs (above its feet).', { group: 'Collision', when: when('ledgeClimb', true), ...C3L.ledgeHeight, step: 0.05, unit: 'm', default: C3.ledgeHeight, dimension: 3, handle: 'height' }),
    num('ledgeClimbTime', 'Climb time', 'How long a ledge climb takes.', { group: 'Collision', when: when('ledgeClimb', true), ...C3L.ledgeClimbTime, step: 0.05, unit: 's', default: C3.ledgeClimbTime, dimension: 3 }),
    // Phase 24.8: the input actions it reads (the input frame has no fixed move/jump channels).
    str('moveAction', 'Move action', 'The input action (an axis) that moves it.', { format: 'identifier', minLength: 1, maxLength: 32, group: 'Input', default: CONTROLLER_ACTION_DEFAULTS.moveAction }),
    str('jumpAction', 'Jump action', 'The input action (a button) that makes it jump.', { format: 'identifier', minLength: 1, maxLength: 32, group: 'Input', default: CONTROLLER_ACTION_DEFAULTS.jumpAction }),
    // Phase 25.13: climbing (inside a climb volume) and walls (both off by default), both dimensions.
    num('climbSpeed', 'Climb speed', 'How fast it moves inside a climb volume (up/down along it, sideways across it; jump leaves).', { group: 'Climbing and walls', ...CML.climbSpeed, step: 0.1, unit: 'm/s', default: CMD.climbSpeed }),
    str('climbAction', 'Climb action', 'The input action (an axis) that climbs: its value, or a 2D axis\' up/down (absent: the move action\'s up/down — a 2D project whose move is left/right only names another action here).', { format: 'identifier', minLength: 1, maxLength: 32, group: 'Climbing and walls' }),
    bool('wallSlide', 'Wall slide', 'Falling while pushing into a wall, it slides down no faster than the wall slide speed.', { group: 'Climbing and walls', default: CMD.wallSlide }),
    num('wallSlideSpeed', 'Wall slide speed', 'The fastest it slides down a wall.', { group: 'Climbing and walls', when: when('wallSlide', true), ...CML.wallSlideSpeed, step: 0.1, unit: 'm/s', default: CMD.wallSlideSpeed }),
    bool('wallJump', 'Wall jump', 'In the air, jump pushes it off a wall it touches (away from the wall and up).', { group: 'Climbing and walls', default: CMD.wallJump }),
    num('wallJumpAway', 'Wall jump away', 'Speed away from the wall at a wall jump (absent: its run speed).', { group: 'Climbing and walls', when: when('wallJump', true), ...CML.wallJumpAway, step: 0.1, unit: 'm/s' }),
    num('wallJumpUp', 'Wall jump up', 'Upward speed at a wall jump (absent: its jump speed).', { group: 'Climbing and walls', when: when('wallJump', true), ...CML.wallJumpUp, step: 0.1, unit: 'm/s' }),
    num('wallJumpLock', 'Wall jump lock', 'How long after a wall jump the input does not steer (absent: until the top of the jump; 0: steers at once; a landing always ends it).', { group: 'Climbing and walls', when: when('wallJump', true), ...CML.wallJumpLock, step: 0.05, unit: 's' }),
  ], { rules: ['The steepest walkable slope is the project setting max_slope_climb_deg; run speed, jump speed and gravity are project settings too (a 3D character may override them).'] }),
  add: { kind: 'menu', value: {} },
  handles: [
    { kind: 'capsule', label: 'Capsule', bind: { radius: 'capsule/radius', height: 'capsule/height', offset: 'capsule/offset' }, space: 'local' },
    // Phase 23.2 (3D): the step-up and ledge heights above the capsule's feet.
    { kind: 'height', label: 'Step-up height', bind: { height: 'stepHeight' }, space: 'local', from: 'capsule', dimension: 3 },
    { kind: 'height', label: 'Ledge height', bind: { height: 'ledgeHeight' }, space: 'local', from: 'capsule', when: when('ledgeClimb', true), dimension: 3 },
  ],
  excludes: [
    { component: 'socketAttach', reason: 'a socket poses the object every step; the player is moved by its controller' },
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
    { component: 'collider', reason: 'the player controller has its own capsule' },
    { component: 'mover', reason: 'the player moves by input, not along waypoints' },
    { component: 'playerSpawn', reason: 'the spawn marks where the player starts' },
    { component: 'instances', reason: 'an instance set is scenery' },
    { component: 'collectible', reason: 'the character collects; it is not collected' },
    { component: 'patrol', reason: 'the character moves by input, not by itself' },
    { component: 'climbVolume', reason: 'the character climbs in a climb volume; it is not one' },
    { component: 'gravity', reason: 'the character falls under its own controller' },
  ],
  prefab: false,
  rules: PHYSICS_RULES,
};

const playerSpawn: ComponentDescriptor = {
  name: 'playerSpawn',
  label: 'Player spawn',
  tooltip: 'Where the player starts (a level names its spawn).',
  category: 'Gameplay',
  value: obj('playerSpawn', 'Player spawn', 'A spawn marker.', [
    // Phase 24.4f: a facing in any direction (3D too): the character's yaw on arrival (phase 24.8: replaces the left/right facing).
    num('yaw', 'Yaw', 'The way the character faces on arrival, degrees about +Y (0: facing +Z; absent: as it was).', { min: -360, max: 360, step: 5, unit: 'deg' }),
  ]),
  add: { kind: 'menu', value: {} },
  create: [{ label: 'Spawn point' }],
  icon: 'spawn',
  handles: [],
  excludes: [
    { component: 'collider', reason: 'a player spawn is a marker' },
    { component: 'controller', reason: 'the spawn marks where the player starts' },
    { component: 'instances', reason: 'an instance set is scenery' },
  ],
  prefab: false,
  rules: MARKER_RULES,
};

// Phase 23.4: the camera framework (defaults and their reasons: project-model VIRTUAL_CAMERA_DEFAULTS).
const ORBITING = when('rig', 'follow', 'orbitPoint');
const TRACKING = when('rig', 'follow', 'orbitPoint', 'topDown');
/** Phase 24.4g: the rigs that lag behind a target by `damping` (the track rig's smoothing). */
const DAMPED = when('rig', 'follow', 'orbitPoint', 'topDown', 'track');
const TRACK = when('rig', 'track');
const ACTION_NAME = { format: 'identifier' as const, minLength: 1, maxLength: 32 };
const virtualCamera: ComponentDescriptor = {
  name: 'virtualCamera',
  label: 'Virtual camera',
  tooltip: 'A camera shot the game cuts or blends to: follow/orbit a target, orbit a point in snapped turns, top-down, fixed/look-at, along a rail, or track a target with a dead zone and bounds. The live one is the enabled camera with the highest priority (on a tie the one activated last); without one the scene camera keeps its own view.',
  category: 'Camera',
  value: obj('virtualCamera', 'Virtual camera', 'One camera shot and how the view blends to it.', [
    enm('rig', 'Rig', 'How the camera moves: follow/orbit a target, orbit a point, straight down onto the target, fixed where it is placed, along a camera path, or track a target without turning (dead zone, bounds).', VIRTUAL_CAMERA_RIGS, { required: true, default: 'follow', labels: { follow: 'Follow / orbit', orbitPoint: 'Orbit a point', topDown: 'Top-down', fixed: 'Fixed / look-at', rail: 'Rail (path)', track: 'Track (dead zone)' } }),
    int('priority', 'Priority', 'The enabled camera with the highest priority is live (on a tie: the one activated last, then the first in the scene).', { min: VCL.priority.min, max: VCL.priority.max, default: VCD.priority }),
    bool('enabled', 'Enabled at start', 'Takes part from the start; scripts activate and deactivate cameras (ctx.camera).', { default: VCD.enabled }),
    entity('target', 'Target', 'The object it follows, circles or looks at (none: the rig centres on where the camera is placed; fixed and rail cameras look ahead).', { anyScene: true }),
    vec3('targetOffset', 'Target offset', 'Added to the target\'s position (e.g. a character\'s head height).', { min: VCL.offset.min, max: VCL.offset.max, step: 0.1, unit: 'm', default: [...VCD.targetOffset] }),
    num('distance', 'Distance', 'How far from the target (or point) it sits; top-down: the height above it.', { when: TRACKING, min: VCL.distance.min, max: VCL.distance.max, step: 0.5, unit: 'm', default: VCD.distance }),
    num('minDistance', 'Min distance', 'The closest it zooms, and the closest a wall pulls it in.', { when: ORBITING, min: VCL.minDistance.min, max: VCL.minDistance.max, step: 0.1, unit: 'm', default: VCD.minDistance }),
    num('maxDistance', 'Max distance', 'The farthest it zooms out.', { when: ORBITING, min: VCL.maxDistance.min, max: VCL.maxDistance.max, step: 1, unit: 'm', default: VCD.maxDistance }),
    num('yaw', 'Yaw', 'The heading around the target (0: on its +Z side looking toward −Z).', { when: TRACKING, min: VCL.yaw.min, max: VCL.yaw.max, step: 5, unit: 'deg', default: VCD.yaw }),
    num('pitch', 'Pitch', 'How far above the target it looks down (negative: from below).', { when: ORBITING, min: VCL.pitch.min, max: VCL.pitch.max, step: 1, unit: 'deg', default: VCD.pitch }),
    num('pitchMin', 'Pitch min', 'The lowest a player tilts it.', { when: ORBITING, min: VCL.pitch.min, max: VCL.pitch.max, step: 1, unit: 'deg', default: VCD.pitchMin }),
    num('pitchMax', 'Pitch max', 'The highest a player tilts it.', { when: ORBITING, min: VCL.pitch.min, max: VCL.pitch.max, step: 1, unit: 'deg', default: VCD.pitchMax }),
    str('yawAction', 'Turn action', 'An input action (axis) that turns it around the target (a 2D axis: x turns, y tilts).', { ...ACTION_NAME, when: when('rig', 'follow'), group: 'Input' }),
    str('pitchAction', 'Tilt action', 'An input action (axis) that tilts it.', { ...ACTION_NAME, when: ORBITING, group: 'Input' }),
    num('rotateSpeed', 'Turn speed', 'Turning and tilting speed at full input (degrees per second).', { when: ORBITING, min: VCL.rotateSpeed.min, max: VCL.rotateSpeed.max, step: 10, unit: 'deg', default: VCD.rotateSpeed, group: 'Input' }),
    str('zoomAction', 'Zoom action', 'An input action (axis) that moves it closer (negative) or farther (positive).', { ...ACTION_NAME, when: ORBITING, group: 'Input' }),
    num('zoomSpeed', 'Zoom speed', 'Zoom speed at full input.', { when: ORBITING, min: VCL.zoomSpeed.min, max: VCL.zoomSpeed.max, step: 1, unit: 'm/s', default: VCD.zoomSpeed, group: 'Input' }),
    str('turnLeftAction', 'Turn left action', 'An input action (button): each press turns one step to the left.', { ...ACTION_NAME, when: when('rig', 'orbitPoint'), group: 'Input' }),
    str('turnRightAction', 'Turn right action', 'An input action (button): each press turns one step to the right.', { ...ACTION_NAME, when: when('rig', 'orbitPoint'), group: 'Input' }),
    num('yawStep', 'Turn step', 'How far one press turns (the yaw snaps to whole steps).', { when: when('rig', 'orbitPoint'), min: VCL.yawStep.min, max: VCL.yawStep.max, step: 5, unit: 'deg', default: VCD.yawStep }),
    num('turnTime', 'Turn time', 'How long a snapped turn takes (0: at once).', { when: when('rig', 'orbitPoint'), min: VCL.turnTime.min, max: VCL.turnTime.max, step: 0.05, unit: 's', default: VCD.turnTime }),
    vec3('point', 'Point', 'The world point it circles (absent: the target, else where the camera is placed).', { when: when('rig', 'orbitPoint'), min: VCL.point.min, max: VCL.point.max, step: 0.5, unit: 'm', handle: 'point' }),
    bool('collision', 'Collision', 'Pulled in front of colliders between it and the target (3D projects).', { when: when('rig', 'follow'), default: VCD.collision }),
    num('collisionRadius', 'Collision radius', 'The clearance it keeps from what it is pulled in by.', { when: when('rig', 'follow'), min: VCL.collisionRadius.min, max: VCL.collisionRadius.max, step: 0.05, unit: 'm', default: VCD.collisionRadius }),
    // Phase 24.4g: the track rig — its offset from the framed point, the dead zone and the bounds (world axes).
    vec3('trackOffset', 'Offset', 'Where the camera sits relative to the point it frames (absent: where it is placed relative to the target at the start).', { when: TRACK, min: VCL.offset.min, max: VCL.offset.max, step: 0.5, unit: 'm' }),
    vec3('deadZone', 'Dead zone', 'The box (width, height, depth) around the framed point the target moves in before the camera follows (0: always follows).', { when: TRACK, min: VCL.deadZone.min, max: VCL.deadZone.max, step: 0.1, unit: 'm', default: [0, 0, 0], labels: ['w', 'h', 'd'], handle: 'box3' }),
    vec3('boundsMin', 'Bounds min', 'The framed point never goes below this on any axis (absent: no limit).', { when: TRACK, min: VCL.bounds.min, max: VCL.bounds.max, step: 0.5, unit: 'm', handle: 'bounds' }),
    vec3('boundsMax', 'Bounds max', 'The framed point never goes above this on any axis (absent: no limit).', { when: TRACK, min: VCL.bounds.min, max: VCL.bounds.max, step: 0.5, unit: 'm', handle: 'bounds' }),
    // Phase 25.14: look-ahead (per axis; a vertical look-ahead is [0, t, 0]).
    vec3('lookAhead', 'Look-ahead', 'Frames this many seconds of the target\'s movement ahead of it, per axis (0: none; a vertical look-ahead [0, t, 0] shows the ground below a fall).', { when: TRACK, min: VCL.lookAhead.min, max: VCL.lookAhead.max, step: 0.05, unit: 's', default: [0, 0, 0], labels: ['x', 'y', 'z'] }),
    vec3('lookAheadMax', 'Look-ahead max', 'The farthest it looks ahead, per axis.', { when: TRACK, min: VCL.lookAheadMax.min, max: VCL.lookAheadMax.max, step: 0.5, unit: 'm', default: [...VCD.lookAheadMax], labels: ['x', 'y', 'z'] }),
    num('lookAheadSmoothing', 'Look-ahead smoothing', 'How long a change of the target\'s speed takes to show in the look-ahead (0: at once).', { when: TRACK, min: VCL.lookAheadSmoothing.min, max: VCL.lookAheadSmoothing.max, step: 0.05, unit: 's', default: VCD.lookAheadSmoothing }),
    num('damping', 'Damping', 'How long it lags behind a moving target (0: rigid; the track rig\'s smoothing).', { when: DAMPED, min: VCL.damping.min, max: VCL.damping.max, step: 0.05, unit: 's', default: VCD.damping }),
    entity('path', 'Path', 'The object carrying the camera path it rides (none: it stays where it is placed).', { when: when('rig', 'rail'), component: 'cameraPath', anyScene: true }),
    num('progress', 'Progress', 'Where along the path it starts (0: the first point, 1: the end).', { when: when('rig', 'rail'), min: VCL.progress.min, max: VCL.progress.max, step: 0.01, default: VCD.progress }),
    num('railSpeed', 'Rail speed', 'How fast it rides the path (negative: backwards; 0: stays until a script moves it).', { when: when('rig', 'rail'), min: VCL.railSpeed.min, max: VCL.railSpeed.max, step: 0.5, unit: 'm/s', default: VCD.railSpeed }),
    enm('railMode', 'At the end', 'Stop at the end, loop to the start, or ride back and forth.', CAMERA_RAIL_MODES, { when: when('rig', 'rail'), default: VCD.railMode, labels: { once: 'Stop', loop: 'Loop', pingpong: 'Back and forth' } }),
    num('fovY', 'Field of view', 'Vertical field of view (absent: the scene camera\'s).', { min: VCL.fovY.min, max: VCL.fovY.max, step: 1, unit: 'deg', group: 'Lens' }),
    num('near', 'Near', 'The near clipping plane (absent: the scene camera\'s).', { min: VCL.near.min, max: VCL.near.max, step: 0.01, unit: 'm', group: 'Lens' }),
    num('far', 'Far', 'The far clipping plane (absent: the scene camera\'s).', { min: VCL.far.min, max: VCL.far.max, step: 10, unit: 'm', group: 'Lens' }),
    enm('blend', 'Blend in', 'How the view moves to this camera when it goes live: a cut, a constant-speed move or an eased move.', CAMERA_BLENDS, { default: VCD.blend, group: 'Blend' }),
    num('blendTime', 'Blend time', 'How long the move to this camera takes.', { when: when('blend', 'linear', 'eased'), min: VCL.blendTime.min, max: VCL.blendTime.max, step: 0.1, unit: 's', default: VCD.blendTime, group: 'Blend' }),
    num('letterbox', 'Letterbox', 'Black bars over the top and bottom while it is live (each a share of the view height).', { min: VCL.letterbox.min, max: VCL.letterbox.max, step: 0.01, default: VCD.letterbox, group: 'Effects' }),
    num('shakeAmplitude', 'Shake', 'A constant shake while it is live (0: none).', { min: VCL.shakeAmplitude.min, max: VCL.shakeAmplitude.max, step: 0.01, unit: 'm', default: VCD.shakeAmplitude, group: 'Effects' }),
    num('shakeFrequency', 'Shake frequency', 'How fast it shakes.', { min: VCL.shakeFrequency.min, max: VCL.shakeFrequency.max, step: 0.5, unit: 'Hz', default: VCD.shakeFrequency, group: 'Effects' }),
    num('shakeRotation', 'Shake rotation', 'How much the shake also turns it.', { min: VCL.shakeRotation.min, max: VCL.shakeRotation.max, step: 0.5, unit: 'deg', default: VCD.shakeRotation, group: 'Effects' }),
  ], { rules: ['pitchMin ≤ pitchMax, minDistance ≤ maxDistance and near < far when both are set'] }),
  // A new camera follows at the defaults (5 m away, 20° above); its target is picked next.
  add: { kind: 'menu', value: { rig: 'follow' } },
  presets: [
    { label: 'Follow / orbit', value: { rig: 'follow' } },
    { label: 'Orbit a point (snapped turns)', value: { rig: 'orbitPoint', distance: 15, pitch: 45 } },
    { label: 'Top-down', value: { rig: 'topDown', distance: 15 } },
    { label: 'Fixed / look-at', value: { rig: 'fixed' } },
    // Phase 24.4g: frames its target as placed, following once it leaves a 2 × 1 m box (about a body's reach), with a short 0.2 s lag.
    { label: 'Track (dead zone)', value: { rig: 'track', deadZone: [2, 1, 2], damping: 0.2 } },
  ],
  // Phase 24.5: the track rig's shot as its own object (the target is picked in the Inspector; without one it frames where it is placed).
  create: [{ label: 'Camera track', menu: 'Cameras', value: { rig: 'track', deadZone: [2, 1, 2], damping: 0.2 } }],
  icon: 'camera',
  handles: [
    { kind: 'point', label: 'Orbit point', bind: { point: 'point' }, space: 'world', when: when('rig', 'orbitPoint') },
    // Phase 25.14: the track rig's dead zone (around its target, where it frames it at the start) and bounds (world corners).
    { kind: 'box3', label: 'Dead zone', bind: { size: 'deadZone' }, space: 'local', when: TRACK, anchor: { entity: 'target', offset: 'targetOffset' } },
    { kind: 'bounds', label: 'Bounds', bind: { min: 'boundsMin', max: 'boundsMax' }, space: 'world', when: TRACK },
  ],
  excludes: [
    { component: 'camera', reason: 'a virtual camera is a shot; the scene camera draws whichever shot is live' },
  ],
  prefab: false,
};

const cameraPath: ComponentDescriptor = {
  name: 'cameraPath',
  label: 'Camera path',
  tooltip: 'A path rail cameras ride (points as offsets from where this object is placed).',
  category: 'Camera',
  value: obj('cameraPath', 'Camera path', 'Points a rail camera rides through.', [
    list('points', 'Points', `${CAMERA_PATH_LIMITS.minPoints}–${CAMERA_PATH_LIMITS.maxPoints} points, as offsets from where the object is placed.`, vec3('*', 'Point', 'An offset [x, y, z].', { min: -CAMERA_PATH_LIMITS.coordinate, max: CAMERA_PATH_LIMITS.coordinate, step: 0.1, unit: 'm' }), { required: true, minItems: CAMERA_PATH_LIMITS.minPoints, maxItems: CAMERA_PATH_LIMITS.maxPoints, handle: 'path', default: [[0, 0, 0], [6, 0, 0]] }),
    bool('closed', 'Closed', 'The path runs back from the last point to the first.', { default: false }),
    bool('smooth', 'Smooth', 'A smooth curve through the points (off: straight segments).', { default: true }),
  ]),
  // A new path is a 6 m straight run sideways (a dolly move across a small set).
  add: { kind: 'menu', value: { points: [[0, 0, 0], [6, 0, 0]] } },
  handles: [{ kind: 'path', label: 'Path', bind: { points: 'points' }, space: 'local', loop: when('closed', true) }],
  excludes: [],
  prefab: false,
};

// Phase 25.14: a place where track cameras frame differently.
const CRD = CAMERA_REGION_DEFAULTS;
const CRL = CAMERA_REGION_LIMITS;
const cameraRegion: ComponentDescriptor = {
  name: 'cameraRegion',
  label: 'Camera region',
  tooltip: 'While a track camera\'s target is inside this box, the camera uses the region\'s dead zone, bounds and distance (each absent: the camera\'s own); entering or leaving blends between them. A room, a corridor, an arena, a vista: any place that frames differently.',
  category: 'Camera',
  value: obj('cameraRegion', 'Camera region', 'How track cameras frame while their target is inside.', [
    vec3('size', 'Size', 'Width, height (and depth; absent: every depth), centred on the object along the world axes (its rotation is not used).', { required: true, min: CRL.size.min, max: CRL.size.max, step: 0.5, unit: 'm', default: [10, 6], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    entity('camera', 'Camera', 'The track camera it applies to (none: every track camera).', { component: 'virtualCamera', anyScene: true }),
    int('priority', 'Priority', 'Where regions overlap the highest wins (on a tie: the one entered last).', { min: VCL.priority.min, max: VCL.priority.max, default: CRD.priority }),
    vec3('deadZone', 'Dead zone', 'The camera\'s dead zone in here (absent: its own).', { min: VCL.deadZone.min, max: VCL.deadZone.max, step: 0.1, unit: 'm', labels: ['w', 'h', 'd'], handle: 'box3' }),
    vec3('boundsMin', 'Bounds min', 'The framed point stays at or above this in here, from the region\'s position (absent: the camera\'s own).', { min: VCL.bounds.min, max: VCL.bounds.max, step: 0.5, unit: 'm', handle: 'bounds' }),
    vec3('boundsMax', 'Bounds max', 'The framed point stays at or below this in here, from the region\'s position (absent: the camera\'s own).', { min: VCL.bounds.min, max: VCL.bounds.max, step: 0.5, unit: 'm', handle: 'bounds' }),
    num('distance', 'Distance', 'The camera\'s distance from the framed point in here, along its offset (absent: its own offset).', { min: VCL.distance.min, max: VCL.distance.max, step: 0.5, unit: 'm' }),
    num('blendTime', 'Blend time', 'How long entering or leaving blends the camera to its new framing (0: at once).', { min: VCL.blendTime.min, max: VCL.blendTime.max, step: 0.1, unit: 's', default: CRD.blendTime }),
  ]),
  // 10 × 6 m: a room about two storeys high (the default 1.8 m character several strides from wall to wall).
  add: { kind: 'menu', value: { size: [10, 6] } },
  create: [
    { label: 'Camera region', menu: 'Cameras', dimension: 2 },
    { label: 'Camera region', menu: 'Cameras', value: { size: [10, 6, 10] }, dimension: 3 },
  ],
  icon: 'camera',
  handles: [
    { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', follows: 'position' },
    { kind: 'bounds', label: 'Bounds', bind: { min: 'boundsMin', max: 'boundsMax' }, space: 'local' },
    { kind: 'box3', label: 'Dead zone', bind: { size: 'deadZone' }, space: 'local' },
  ],
  excludes: [],
  prefab: false,
};

// Phase 23.11: an object riding on a node of another object's model.
const socketAttach: ComponentDescriptor = {
  name: 'socketAttach',
  label: 'Socket',
  tooltip: 'Rides on a named node (a bone or any node) of another object\'s model, with an offset: equipment in a hand, a rider on a mount, a pilot in a cockpit. The simulation places it every step, following the target\'s animation; scripts attach and detach at run time (ctx.sockets).',
  category: 'Object',
  value: obj('socketAttach', 'Socket', 'The node this object rides on and its offset from it.', [
    entity('target', 'Target', 'The object whose model carries the node.', { required: true, component: 'model' }),
    str('node', 'Node', 'The node (or bone) of the target\'s model it rides on (the list shows the model\'s nodes).', { required: true, minLength: 1, maxLength: SOCKET_ATTACH_LIMITS.nodeName, format: 'socketNode' }),
    vec3('position', 'Offset', 'The offset from the node, in the node\'s space.', { min: -SOCKET_ATTACH_LIMITS.offset, max: SOCKET_ATTACH_LIMITS.offset, step: 0.05, unit: 'm', default: [0, 0, 0] }),
    { type: 'quat', key: 'rotation', label: 'Rotation offset', tooltip: 'The rotation from the node\'s (the Inspector shows degrees).', default: [0, 0, 0, 1] },
    vec3('scale', 'Scale', 'Scale relative to the node.', { min: SOCKET_ATTACH_LIMITS.scaleMin, max: SOCKET_ATTACH_LIMITS.scaleMax, step: 0.05, default: [1, 1, 1] }),
    bool('attached', 'Attached at start', 'Rides on the node from the start (off: a script attaches it later with ctx.sockets.attach).', { default: true }),
  ]),
  // A socket needs its target (picked first; the node starts as a placeholder name picked from the target's list next).
  add: { kind: 'pick', value: {}, pick: ['target'] },
  handles: [],
  excludes: SOCKET_ATTACH_CONFLICTS.map((c) => ({ component: c, reason: c === 'camera' ? 'the scene camera is posed by the camera brain' : 'a physics body is posed by physics, not by a socket' })),
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
    // Phase 17.4: the sun's shadow map as data (defaults and their reasons: project-model DIRECTIONAL_SHADOW_DEFAULTS).
    int('shadowMapSize', 'Shadow map size', 'Shadow resolution in texels per side (sharper, more memory).', { when: when('type', 'directional'), values: [...DIRECTIONAL_SHADOW_LIMITS.mapSizes], default: DIRECTIONAL_SHADOW_DEFAULTS.mapSize, omitDefault: true }),
    num('shadowBias', 'Shadow bias', 'Depth offset of the shadow test (more negative: less acne, shadows may detach).', { when: when('type', 'directional'), min: DIRECTIONAL_SHADOW_LIMITS.bias.min, max: DIRECTIONAL_SHADOW_LIMITS.bias.max, step: 0.0001, default: DIRECTIONAL_SHADOW_DEFAULTS.bias, omitDefault: true }),
    num('shadowNormalBias', 'Shadow normal bias', 'Offset along the surface normal (removes stripes on grazing surfaces).', { when: when('type', 'directional'), min: DIRECTIONAL_SHADOW_LIMITS.normalBias.min, max: DIRECTIONAL_SHADOW_LIMITS.normalBias.max, step: 0.005, unit: 'm', default: DIRECTIONAL_SHADOW_DEFAULTS.normalBias, omitDefault: true }),
    num('shadowExtent', 'Shadow extent', 'Half the side of the shadowed square around the camera (v4 games; a v3 game uses its level bounds).', { when: when('type', 'directional'), min: DIRECTIONAL_SHADOW_LIMITS.extent.min, max: DIRECTIONAL_SHADOW_LIMITS.extent.max, step: 1, unit: 'm', default: DIRECTIONAL_SHADOW_DEFAULTS.extent, omitDefault: true }),
    num('range', 'Range', 'Light reaches this far (0: unlimited).', { when: when('type', 'point'), min: 0, max: 1000, step: 0.5, unit: 'm', default: 0, handle: 'radius' }),
    num('range', 'Range', 'Light reaches this far (0: unlimited).', { when: when('type', 'spot'), min: 0, max: 1000, step: 0.5, unit: 'm', default: 0, handle: 'cone' }),
    num('decay', 'Decay', 'How fast it fades with distance (2: physically correct).', { when: when('type', 'point', 'spot'), min: 0, max: 4, step: 0.1, default: 2 }),
    num('angle', 'Angle', 'Half-angle of the spot cone.', { when: when('type', 'spot'), min: 1, max: 89, step: 1, unit: 'deg', default: 30, handle: 'cone' }),
    num('penumbra', 'Soft edge', 'How soft the cone edge is (0: hard).', { when: when('type', 'spot'), min: 0, max: 1, step: 0.05, default: 0.2 }),
    // Phase 25.8: a spot light's cookie (directional lights get none).
    asset('cookie', 'Cookie', 'A texture projected through the cone (the light is tinted and masked by it: a window frame, leaves, a logo).', ['texture'], { when: when('type', 'spot') }),
    color('groundColor', 'Ground colour', 'The colour from below.', { when: when('type', 'hemisphere'), default: '#444444' }),
    enm('mode', 'Mode', 'Realtime, baked into lightmaps, or both (mixed).', ['realtime', 'baked', 'mixed'], { default: 'realtime', omitDefault: true }),
  ]),
  add: { kind: 'menu', value: { type: 'point', color: '#ffd9a0', intensity: 30, range: 8, decay: 2 } },
  // Phase 15.5 (genre-neutral reasons; the GameObject menu creates these too):
  // - directional and ambient = a new project's starter lights: a white key from
  //   above-front at 1.2 casting shadows (a lone key without shadows flattens any
  //   scene) over a cool fill at 0.6 (shadowed sides stay readable, not black).
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
  rules: [
    'At most one directional, one ambient and one hemisphere light and 16 point/spot lights per scene; any scene may hold any light.',
    'With scenes loaded together, the most recently loaded scene\'s directional, ambient and hemisphere light is on (each kind on its own); the others come back when it unloads.',
    'Point and spot lights of all loaded scenes share the budget of 16; past it the most recently loaded scenes\' lights are on.',
  ],
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
    // Phase 17.4: true by default — solid geometry blocks the light and shows the shadows falling on it in any genre.
    bool('castShadow', 'Casts shadows', 'Blocks the directional light: casts a realtime shadow (off for decals, glows, backdrops).', { default: true, omitDefault: true }),
    bool('receiveShadow', 'Receives shadows', 'Shows the realtime shadows falling on it.', { default: true, omitDefault: true }),
    // Phase 25.7d: absent = the project's Instance chunk size (32 m unless set).
    num('chunkSize', 'Chunk size', 'The copies are drawn in chunks about this wide, each hidden when out of view and given its level of detail on its own (absent: the project\'s Instance chunk size).', { min: 1, max: 4096, step: 1, unit: 'm' }),
  ]),
  add: { kind: 'tool', tool: 'instance brush or instance import' },
  handles: [],
  excludes: [
    ...['box', 'camera', 'model', 'collider', 'controller', 'modelAnimation', 'playerSpawn', 'light'].map((c) => ({ component: c, reason: 'an instance set is one model placed many times, with nothing of its own' })),
    { component: 'blockLayer', reason: 'a block layer is its own level geometry' },
  ],
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
    // Phase 20.2: triggers.
    signal('signal', 'Play on signal', 'Starts (or restarts) the effect when this signal is sent (a switch, trigger or script).'),
    signal('stopSignal', 'Stop on signal', 'Stops spawning when this signal is sent; living particles finish.'),
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
  create: [{ label: 'Fog volume', menu: 'Light' }],
  icon: 'fog',
  handles: [{ kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [],
  prefab: false,
  rules: ['At most 16 fog volumes per scene.'],
};

// Phase 23.10: the behavior group an object's behavior belongs to (game modes tick groups).
const behaviorGroupC: ComponentDescriptor = {
  name: 'behaviorGroup',
  label: 'Behavior group',
  tooltip: 'The group this object\'s behavior belongs to. A game mode lists the groups that tick while it is active; the others pause (their scripts do not run).',
  category: 'Scripting',
  value: obj('behaviorGroup', 'Behavior group', 'The group of this object\'s behavior.', [
    ref('group', 'Group', 'One of the project\'s behavior groups (Game modes panel).', 'behaviorGroup', { required: true }),
  ]),
  // The group is picked when the component is added (the project's first group as a start).
  add: { kind: 'pick', value: {}, pick: ['group'] },
  handles: [],
  excludes: [],
  prefab: true,
};

// Phase 23.10: one game mode (the Game modes panel edits it; setModes stores the whole list).
const MODE_TRANSITION_FIELDS: readonly FieldDescriptor[] = [
  enm('blend', 'Camera blend', 'How the view moves to the mode\'s camera (absent: the camera\'s own blend).', MODE_BLENDS),
  num('blendTime', 'Blend time', 'Seconds of the camera blend (absent: the camera\'s own).', { min: 0, max: MODE_LIMITS.blendTimeMax, step: 0.05, unit: 's' }),
  ref('fade', 'Fade document', 'A UI document shown from the switch for the fade time — its show and hide tweens are the fade.', 'uiDocument'),
  num('fadeTime', 'Fade time', 'Seconds the fade document stays.', { min: MODE_LIMITS.fadeTimeMin, max: MODE_LIMITS.fadeTimeMax, step: 0.05, unit: 's', default: MODE_DEFAULTS.fadeTime }),
];
const MODE_ITEM: FieldDescriptor = obj('*', 'Game mode', 'One game mode.', [
  str('modeId', 'Id', 'Scripts (ctx.modes.switch) and UI mode actions name it.', { required: true, format: 'id', minLength: 1, maxLength: 64 }),
  str('name', 'Name', 'Shown in the editor and the Play toolbar.', { required: true, minLength: 1, maxLength: MODE_LIMITS.nameLength }),
  list('inputMaps', 'Input maps', 'The input maps active in the mode (absent: every map). Actions of other maps read as released.', ref('*', 'Map', 'gameplay, ui or one of the project\'s maps.', 'inputMap'), { maxItems: MODE_LIMITS.inputMaps, unique: true }),
  entity('camera', 'Camera', 'A virtual camera that is live while the mode is, over the priorities (absent: the priority rule).', { component: 'virtualCamera', anyScene: true }),
  list('ui', 'UI documents', 'Shown while the mode is active, hidden when it ends.', ref('*', 'Document', 'A UI document.', 'uiDocument'), { maxItems: MODE_LIMITS.ui, unique: true }),
  list('groups', 'Ticking groups', 'The behavior groups whose scripts run (absent: every group). The other groups pause.', ref('*', 'Group', 'A behavior group.', 'behaviorGroup'), { maxItems: MODE_LIMITS.groups, unique: true }),
  enm('ungrouped', 'Ungrouped behaviors', 'Behaviors of objects without a behavior group.', MODE_UNGROUPED, { default: MODE_DEFAULTS.ungrouped }),
  bool('pause', 'Pause allowed', 'The engine pause (the pause key, a pause button) may be used in this mode.', { default: MODE_DEFAULTS.pause }),
  ref('pauseScreen', 'Pause screen', 'A UI document drawn while the game is paused in this mode (absent: the engine\'s pause panel).', 'uiDocument'),
  num('timeScale', 'Time scale', 'Simulation speed: fewer or more fixed steps per second (each step unchanged).', { min: MODE_LIMITS.timeScaleMin, max: MODE_LIMITS.timeScaleMax, step: 0.05, default: MODE_DEFAULTS.timeScale }),
  enm('physics', 'Physics', 'Physics, the character, movers and triggers step (run) or stand still (hold).', MODE_PHYSICS, { default: MODE_DEFAULTS.physics }),
  obj('enter', 'Transition in', 'How entering this mode looks (a script\'s switch may pass its own).', MODE_TRANSITION_FIELDS),
]);

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
    // Phase 25.12: gravity — constant acceleration from each point (the stretch takes as long as at its speed).
    enm('easing', 'Easing', 'Constant speed, smooth starts and stops, or gravity: from rest at each point, speeding up evenly until the next (each stretch takes as long as at its speed).', MOVER_EASINGS, { default: 'linear' }),
    signal('startOn', 'Start on signal', 'Wait for this signal before moving (absent: moves from the start).'),
    num('maxPush', 'Max push', 'The fastest it shoves a player out of its way (a safety limit that keeps the player out of the platform).', { ...BL.maxPush, step: 1, unit: 'm/s', default: BD.maxPush }),
    // Phase 25.10: a held mover stays where it is (it still collides and carries) until a script switches it on.
    bool('active', 'Moving', 'Off: it holds where it is (still solid) until a script, its start signal or its toggle signal moves it.', { default: true, omitDefault: true }),
    // Phase 25.12: more signals (seen one step after they are sent, like startOn).
    signal('stopOn', 'Stop on signal', 'This signal holds it where it is (still solid); its start or toggle signal moves it again.'),
    signal('toggleOn', 'Toggle on signal', 'This signal moves it if it is held, and holds it if it moves.'),
    signal('reverseOn', 'Reverse on signal', 'This signal turns it around, back the way it came (a finished once-mover goes back to its start).'),
  ], { rules: ['startOn, stopOn and toggleOn name different signals.'] }),
  // Phase 15.5: a new mover goes 4 m sideways and back at 2 m/s (a brisk walk), pausing 0.5 s at each end (reads as a stop, not a bounce).
  add: { kind: 'menu', value: { waypoints: [[4, 0, 0]], speed: 2, mode: 'pingpong', wait: 0.5 } },
  // Phase 24.5: placeholder boxes against the engine's default 1.8 m character: a 2 m platform to stand on and a 3 m door
  // to walk through (it rises 3 m when "open" is sent — the switch's default signal); each with its box collider.
  create: [
    { label: 'Moving platform', menu: 'Gameplay', box: { size: [2, 0.4, 2], color: '#c9a36a' }, with: { collider: { shape: { type: 'box', hx: 1, hy: 0.2 } } }, dimension: 2 },
    { label: 'Moving platform', menu: 'Gameplay', box: { size: [2, 0.4, 2], color: '#c9a36a' }, with: { collider: { shape: { type: 'box', hx: 1, hy: 0.2, hz: 1 } } }, dimension: 3 },
    { label: 'Door (opens on "open")', name: 'Door', menu: 'Gameplay', box: { size: [0.6, 3, 2], color: '#7a5230' }, value: { waypoints: [[0, 3, 0]], speed: 3, mode: 'once', startOn: 'open' }, with: { collider: { shape: { type: 'box', hx: 0.3, hy: 1.5 } } }, dimension: 2 },
    { label: 'Door (opens on "open")', name: 'Door', menu: 'Gameplay', box: { size: [0.6, 3, 2], color: '#7a5230' }, value: { waypoints: [[0, 3, 0]], speed: 3, mode: 'once', startOn: 'open' }, with: { collider: { shape: { type: 'box', hx: 0.3, hy: 1.5, hz: 1 } } }, dimension: 3 },
  ],
  icon: 'mover',
  handles: [{ kind: 'path', label: 'Waypoints', bind: { points: 'waypoints' }, space: 'local', loop: when('mode', 'loop') }],
  excludes: [{ component: 'controller', reason: 'the player moves by input, not along waypoints' }, { component: 'socketAttach', reason: 'a socket poses the object every step; a mover follows its waypoints' }, { component: 'patrol', reason: 'a mover and a patrol would both move it' }, { component: 'gravity', reason: 'a mover sets its position itself' }],
  prefab: true,
};

const trigger: ComponentDescriptor = {
  name: 'trigger',
  label: 'Trigger',
  tooltip: 'Sends a signal when the player enters an area (a box or a circle; in a 3D project a box with a depth, a sphere or a capsule).',
  category: 'Gameplay',
  value: obj('trigger', 'Trigger', 'An area that emits signals.', [
    enm('shape', 'Shape', 'Box or circle (2D plane); box, sphere or capsule (3D project).', TRIGGER_SHAPES, { default: 'box' }),
    // Phase 23.1: the depth (d) is the third component, needed in a 3D project (a 2D plane ignores it).
    vec3('size', 'Size', 'Width and height of the box (and its depth in a 3D project).', { required: true, when: when('shape', 'box'), min: 0.05, max: 500, step: 0.1, unit: 'm', default: [2, 2], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    num('radius', 'Radius', 'Radius of the circle or sphere.', { required: true, when: when('shape', 'circle', 'sphere'), min: TRIGGER_RADIUS.min, max: TRIGGER_RADIUS.max, step: 0.05, unit: 'm', default: 1, handle: 'radius' }),
    num('radius', 'Radius', 'Radius of the capsule.', { required: true, when: when('shape', 'capsule'), min: TRIGGER_RADIUS.min, max: TRIGGER_RADIUS.max, step: 0.05, unit: 'm', default: 0.5, handle: 'capsule' }),
    num('height', 'Height', 'The capsule\'s total height along the object\'s Y (end caps included; at least twice the radius).', { required: true, when: when('shape', 'capsule'), min: TRIGGER_HEIGHT.min, max: TRIGGER_HEIGHT.max, step: 0.05, unit: 'm', default: 2, handle: 'capsule' }),
    signal('signal', 'Signal', 'Sent when the player enters.', { required: true, default: 'trigger' }),
    signal('exitSignal', 'Exit signal', 'Sent when the player leaves (absent: none).'),
    enm('mode', 'Mode', 'Enter: once per entry. Stay: every step while inside.', TRIGGER_MODES, { default: 'enter' }),
    bool('once', 'Once', 'Only the first time.', { default: false }),
    // Phase 24.4e: the generic scene exit — a trigger that moves the character to another scene.
    obj('sceneTransition', 'Scene transition', 'Entering loads a scene and moves the character to a spawn in it (absent: no transition).', [
      scene('scene', 'Load scene', 'The scene loaded when the character enters.', { required: true }),
      entity('spawn', 'Arrive at', 'The player spawn the character is moved to once the scene is loaded (in that scene or this one; absent: it stays where it is).', { component: 'playerSpawn', anyScene: true }),
      list('unload', 'Unload scenes', 'Scenes unloaded once the loaded scene is in (they stay in view until then).', scene('*', 'Scene', 'A scene to unload.'), { maxItems: MAX_TRANSITION_UNLOADS, unique: true }),
      // Phase 25.24e: an optional fade over the swap.
      num('fade', 'Fade', 'Seconds the view fades out before the swap and back in after it (absent or 0: no fade; the old scene stays in view until the new one is drawn).', { min: 0, max: MAX_TRANSITION_FADE, step: 0.05 }),
      color('fadeColor', 'Fade colour', 'The colour the view fades to (absent: black).'),
    ]),
  ]),
  // Phase 15.5: a 2 m square (the default 1.8 m character fits inside) sending the neutral signal name "trigger".
  add: { kind: 'menu', value: { size: [2, 2], signal: 'trigger' } },
  // Phase 23.1 (3D projects; a 2D plane keeps the single entry above): a 2 m cube, a 1 m sphere and a 2 m capsule — the default 1.8 m character fits in each.
  presets: [
    { label: 'Box (3D)', value: { size: [2, 2, 2], signal: 'trigger' }, dimension: 3 },
    { label: 'Sphere', value: { shape: 'sphere', radius: 1, signal: 'trigger' }, dimension: 3 },
    { label: 'Capsule', value: { shape: 'capsule', radius: 0.5, height: 2, signal: 'trigger' }, dimension: 3 },
  ],
  // Phase 24.5: an area, and an area that moves the character to another scene (its first spawn picked in the Inspector).
  create: [
    { label: 'Trigger', menu: 'Gameplay', dimension: 2 },
    { label: 'Trigger', menu: 'Gameplay', value: { size: [2, 2, 2], signal: 'trigger' }, dimension: 3 },
    { label: 'Scene transition', menu: 'Gameplay', value: { size: [2, 2], signal: 'transition', sceneTransition: { scene: '' } }, otherScene: ['sceneTransition/scene'], dimension: 2 },
    { label: 'Scene transition', menu: 'Gameplay', value: { size: [2, 2, 2], signal: 'transition', sceneTransition: { scene: '' } }, otherScene: ['sceneTransition/scene'], dimension: 3 },
  ],
  icon: 'sensor',
  handles: [
    { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', when: when('shape', 'box') },
    { kind: 'radius', label: 'Radius', bind: { radius: 'radius' }, space: 'local', when: when('shape', 'circle') },
    // Phase 23.1: the 3D areas turn with the object (its own rotation; a trigger ignores scale).
    { kind: 'radius', label: 'Sphere radius', bind: { radius: 'radius' }, space: 'local', when: when('shape', 'sphere'), follows: 'rotation' },
    { kind: 'capsule', label: 'Capsule', bind: { radius: 'radius', height: 'height' }, space: 'local', when: when('shape', 'capsule'), follows: 'rotation' },
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
    enm('mode', 'Mode', 'Interact: press its action nearby. Stand: step on it.', SWITCH_MODES, { required: true, default: 'interact' }),
    signal('signal', 'Signal', 'Sent when used.', { required: true, default: 'open' }),
    vec2('size', 'Size', 'The area the player must be in.', { required: true, min: 0.05, max: 100, step: 0.1, unit: 'm', default: [1, 1], labels: ['w', 'h'], handle: 'box2' }),
    bool('once', 'Once', 'Only the first time.', { default: false }),
    // Phase 24.4f: the input action that works an interact switch (absent: interact).
    str('action', 'Action', 'The input action pressed nearby to use it.', { ...ACTION_NAME, when: when('mode', 'interact'), default: SWITCH_DEFAULT_ACTION }),
  ]),
  // Phase 15.5: a 1 m square pressed with the interact action, sending "open" (the door preset waits for it).
  add: { kind: 'menu', value: { mode: 'interact', signal: 'open', size: [1, 1] } },
  // Phase 24.5: a 0.6 m pad (2D plane only: a 3D project refuses switches).
  create: [{ label: 'Switch', menu: 'Gameplay', box: { size: [0.6, 0.2, 0.6], color: '#d9534f' }, dimension: 2 }],
  icon: 'switch',
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [],
  prefab: true,
};

const health: ComponentDescriptor = {
  name: 'health',
  label: 'Health',
  // Phase 24.4b: any object's health; scripts take and give it (ctx.health) and read its damaged/died events.
  tooltip: 'The object\'s health (any object): scripts damage and heal it and hear when it is damaged or reaches 0; a hitbox with damage takes some on contact.',
  category: 'Gameplay',
  value: obj('health', 'Health', 'Health.', [
    int('max', 'Maximum', 'The most health it can have.', { required: true, min: 1, max: 1000, default: 3 }),
    int('start', 'Start', 'Health at the start of a run (absent: the maximum).', { min: 1, max: 1000 }),
  ], { rules: ['start ≤ max'] }),
  // Phase 15.5: 3 hits (the common small health pool).
  add: { kind: 'menu', value: { max: 3 } },
  // Phase 24.5: a 1 m box that can be damaged (scripts or a hitbox with damage take its health).
  create: [{ label: 'Object with health', menu: 'Gameplay', box: { size: [1, 1, 1], color: '#b0b7c3' }, value: { max: 3 } }],
  icon: 'health',
  handles: [],
  excludes: [],
  prefab: true,
};

// ---- phase 24.4: generic primitives -------------------------------------------------

const PD = PRIMITIVE_DEFAULTS;
const PL = PRIMITIVE_LIMITS;

const collectible: ComponentDescriptor = {
  name: 'collectible',
  label: 'Collectible',
  tooltip: 'The character touching it adds an amount to a named counter; it hides, sends a signal and may come back after a while.',
  category: 'Gameplay',
  value: obj('collectible', 'Collectible', 'Adds to a counter when touched.', [
    str('counter', 'Counter', 'The counter it adds to (any name: a letter or _, then letters, digits or _).', { required: true, format: 'counter', minLength: 1, maxLength: 32, default: 'items' }),
    num('amount', 'Amount', 'Added to the counter when collected (negative takes away).', { ...PL.amount, step: 1, default: PD.collectibleAmount }),
    // Its depth (d) counts in a 3D project (absent: the width); a 2D plane ignores it.
    vec3('size', 'Size', 'The area that collects it: width, height (and depth in a 3D project; absent: the width).', { min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [...PD.collectibleSize], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    signal('onCollect', 'On collect', 'A signal sent when it is collected (absent: none).'),
    num('respawn', 'Comes back after', 'Seconds until it comes back after being collected (0: never).', { ...PL.respawn, step: 0.5, unit: 's', default: 0 }),
  ]),
  // A neutral counter name; one of something over the default 1 m area.
  add: { kind: 'menu', value: { counter: 'items' } },
  // Phase 24.5: a 0.4 m token (small enough to read as an item next to the default 1.8 m character).
  create: [{ label: 'Collectible', menu: 'Gameplay', box: { size: [0.4, 0.4, 0.4], color: '#f2c230' } }],
  icon: 'collectible',
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local' }],
  excludes: [{ component: 'controller', reason: 'the character collects; it is not collected' }],
  prefab: true,
};

const patrol: ComponentDescriptor = {
  name: 'patrol',
  label: 'Patrol',
  tooltip: 'Walks by itself: along waypoints, or straight ahead turning around at walls and ledges.',
  category: 'Gameplay',
  value: obj('patrol', 'Patrol', 'Walks by itself.', [
    enm('mode', 'Mode', 'Waypoints: along points placed from where it starts. Edges: straight ahead, turning at a wall or a ledge.', PATROL_MODES, { required: true, default: 'edges', labels: { waypoints: 'Waypoints', edges: 'Edge to edge' } }),
    list('waypoints', 'Waypoints', '1–16 points, as offsets from where the object is placed (the start is not listed).', vec3('*', 'Point', 'An offset [x, y, z].', { min: -1000, max: 1000, step: 0.1, unit: 'm' }), { required: true, when: when('mode', 'waypoints'), minItems: 1, maxItems: 16, handle: 'path', default: [[4, 0, 0]] }),
    bool('loop', 'Loop', 'From the last point straight back to the start (off: back and forth).', { when: when('mode', 'waypoints'), default: false }),
    num('speed', 'Speed', 'Walking speed.', { required: true, ...PL.speed, step: 0.1, unit: 'm/s', default: 1.5 }),
    num('wait', 'Wait', 'Pause at each waypoint, or after turning around.', { ...PL.wait, step: 0.1, unit: 's', default: 0 }),
    vec3('direction', 'Start direction', 'The way it starts walking (the 2D plane: any direction in the plane — with a y part it moves up or down and does not look for ledges; a 3D project: the direction along the ground).', { when: when('mode', 'edges'), min: -1, max: 1, step: 0.1, default: [...PD.patrolDirection], nonZero: true, handle: 'direction' }),
    vec3('size', 'Body', 'Its body, centred on its position: width, height (and depth in 3D); the probes look from its front and underside.', { when: when('mode', 'edges'), min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [...PD.patrolSize], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    num('wallProbe', 'Wall probe', 'How far past its front it looks for a wall to turn at.', { group: 'Probes', when: when('mode', 'edges'), ...PL.wallProbe, step: 0.01, unit: 'm', default: PD.wallProbe }),
    num('ledgeProbe', 'Ledge probe', 'How far down, from 0.1 m above its underside, it looks for floor just past its front (0.4: a drop deeper than 0.3 m is a ledge).', { group: 'Probes', when: when('mode', 'edges'), ...PL.ledgeProbe, step: 0.05, unit: 'm', default: PD.ledgeProbe }),
  ]),
  // 1.5 m/s: an unhurried walk; edge to edge needs no further setup.
  add: { kind: 'menu', value: { mode: 'edges', speed: 1.5 } },
  // Phase 24.5: a 0.8 m body walking edge to edge.
  create: [{ label: 'Patrolling object', menu: 'Gameplay', box: { size: [0.8, 0.8, 0.8], color: '#8e3fb0' } }],
  icon: 'patrol',
  presets: [
    { label: 'Edge to edge', value: { mode: 'edges', speed: 1.5 } },
    { label: 'Waypoints', value: { mode: 'waypoints', waypoints: [[4, 0, 0]], speed: 1.5 } },
  ],
  handles: [
    { kind: 'path', label: 'Waypoints', bind: { points: 'waypoints' }, space: 'local', when: when('mode', 'waypoints'), loop: when('loop', true) },
    { kind: 'box2', label: 'Body', bind: { size: 'size' }, space: 'local', when: when('mode', 'edges') },
    { kind: 'direction', label: 'Start direction', bind: { direction: 'direction' }, space: 'local', when: when('mode', 'edges') },
  ],
  excludes: [
    { component: 'controller', reason: 'the character moves by input, not by itself' },
    { component: 'mover', reason: 'a mover and a patrol would both move it' },
    { component: 'collider', reason: 'a patroller is not a physics body (give it a hitbox)' },
  ],
  prefab: true,
};

// ---- phase 25.13: climb volumes and gravity bodies --------------------------------

const climbVolume: ComponentDescriptor = {
  name: 'climbVolume',
  label: 'Climb volume',
  tooltip: 'A box the character climbs in (a ladder, a vine, a net, a climbing wall): up/down moves it along the box\'s up axis, sideways across it, at its climb speed and without gravity; jump or moving out leaves.',
  category: 'Gameplay',
  value: obj('climbVolume', 'Climb volume', 'Climbed in.', [
    // Its depth (d) counts in a 3D project (absent: the width); a 2D plane ignores it. It turns with the object (its +Y is "up").
    vec3('size', 'Size', 'Width, height (and depth in a 3D project; absent: the width), centred on the object and turned with it.', { required: true, min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [1, 4], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
  ]),
  // 1 m wide and 4 m tall: a ladder up one storey (about 3 m) and a little over the top, for the default 1.8 m character.
  add: { kind: 'menu', value: { size: [1, 4] } },
  create: [
    { label: 'Climb volume', menu: 'Gameplay', dimension: 2 },
    { label: 'Climb volume', menu: 'Gameplay', value: { size: [1, 4, 1] }, dimension: 3 },
  ],
  icon: 'sensor',
  handles: [{ kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', follows: 'rotation' }],
  excludes: [{ component: 'controller', reason: 'the character climbs in a climb volume; it is not one' }],
  prefab: true,
};

const gravityC: ComponentDescriptor = {
  name: 'gravity',
  label: 'Gravity',
  tooltip: 'The object (not a character: a patroller, an item) falls under the project\'s gravity until its body rests on a collider below it, and falls again when the floor goes.',
  category: 'Gameplay',
  value: obj('gravity', 'Gravity', 'Falls onto colliders.', [
    num('scale', 'Scale', 'Multiplies the project gravity (0: it does not fall).', { ...GRAVITY_SCALE, step: 0.1, unit: '×', default: 1 }),
    vec3('size', 'Body', 'Its body, centred on its position: width, height (and depth in 3D); its underside rests on the floor.', { min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [...PD.patrolSize], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
  ]),
  // The project's gravity on a 1 m body (a patroller's default body).
  add: { kind: 'menu', value: {} },
  handles: [{ kind: 'box2', label: 'Body', bind: { size: 'size' }, space: 'local' }],
  excludes: [
    { component: 'controller', reason: 'the character falls under its own controller' },
    { component: 'mover', reason: 'a mover sets its position itself' },
    { component: 'collider', reason: 'a gravity body is not a physics body (give it a hitbox)' },
  ],
  prefab: true,
};

const hitbox: ComponentDescriptor = {
  name: 'hitbox',
  label: 'Hitbox',
  tooltip: 'An area whose contacts with other hitboxes and the character are events for scripts (the other object and the contact normal); may take health on contact.',
  category: 'Gameplay',
  value: obj('hitbox', 'Hitbox', 'Contact events.', [
    enm('shape', 'Shape', 'A box, or a sphere (a circle on the 2D plane).', HITBOX_SHAPES, { default: 'box' }),
    vec3('size', 'Size', 'Width, height (and depth in a 3D project; absent: the width).', { required: true, when: when('shape', 'box'), min: PL.size.min, max: PL.size.max, step: 0.05, unit: 'm', default: [1, 1], labels: ['w', 'h', 'd'], handle: 'box2', optionalLast: true }),
    num('radius', 'Radius', 'Radius of the sphere (or circle).', { required: true, when: when('shape', 'sphere'), ...PL.radius, step: 0.05, unit: 'm', default: 0.5, handle: 'radius' }),
    int('damage', 'Damage', 'Health a new contact takes from the other object (its own health, or its nearest parent\'s; 0: none).', { ...PL.damage, default: 0 }),
  ]),
  // A 1 m box: about a person-sized object's reach.
  add: { kind: 'menu', value: { size: [1, 1] } },
  create: [
    { label: 'Hitbox', menu: 'Gameplay', dimension: 2 },
    { label: 'Hitbox', menu: 'Gameplay', value: { size: [1, 1, 1] }, dimension: 3 },
  ],
  icon: 'hitbox',
  // The 2D plane's box has no depth; a 3D box a 1 m depth; a sphere (a circle on the 2D plane) fits both.
  presets: [
    { label: 'Box', value: { size: [1, 1] }, dimension: 2 },
    { label: 'Box', value: { size: [1, 1, 1] }, dimension: 3 },
    { label: 'Sphere', value: { shape: 'sphere', radius: 0.5 } },
  ],
  handles: [
    { kind: 'box2', label: 'Size', bind: { size: 'size' }, space: 'local', when: when('shape', 'box') },
    { kind: 'radius', label: 'Radius', bind: { radius: 'radius' }, space: 'local', when: when('shape', 'sphere') },
  ],
  excludes: [],
  prefab: true,
};

const audioSource: ComponentDescriptor = {
  name: 'audioSource',
  label: 'Audio source',
  tooltip: 'A looping sound here, louder as the player comes near (along X), or panned around the camera (the project\'s Audio sources setting; 3D projects).',
  category: 'Audio',
  value: obj('audioSource', 'Audio source', 'A positional loop.', [
    asset('assetId', 'Sound', 'An audio or music asset.', ['audio', 'music'], { required: true }),
    num('volume', 'Volume', 'Volume at full strength.', { required: true, min: 0, max: 1, step: 0.05, default: 0.8 }),
    num('range', 'Range', 'Heard within this distance (full volume within a quarter of it). Panned: its max distance.', { required: true, min: 0.5, max: 500, step: 0.5, unit: 'm', default: 12, handle: 'radius' }),
    // Phase 23.13: the panner model's distance fade (the project's Audio sources setting; 3D projects by default).
    enm('distanceModel', 'Distance model', 'Panned: how the volume falls with distance — linear (silent at the range), inverse or exponential (natural falloff, quieter but never silent within the range).', ['linear', 'inverse', 'exponential'], { default: 'linear', group: 'Panned' }),
    num('refDistance', 'Full volume within', 'Panned: full volume within this distance (absent: a quarter of the range).', { min: 0.01, max: 500, step: 0.25, unit: 'm', default: 3, group: 'Panned' }),
    num('rolloff', 'Rolloff', 'Panned: how fast the volume falls (1: the model\'s natural rate).', { min: 0, max: 10, step: 0.1, default: 1, group: 'Panned' }),
  ]),
  // Phase 15.5: 0.8 volume (headroom under the effects) heard within 12 m (about a screen width at the default camera).
  add: { kind: 'pick', value: { volume: 0.8, range: 12 }, pick: ['assetId'] },
  icon: 'audio',
  handles: [{ kind: 'radius', label: 'Range', bind: { radius: 'range' }, space: 'local', along: 'x' }],
  excludes: [],
  prefab: true,
};

const faceMovement: ComponentDescriptor = {
  name: 'faceMovement',
  label: 'Face movement',
  tooltip: 'Turns this model to face where its parent (or, at the top, itself) is going: to one of two yaws by the side it moves to, or toward its motion in any direction.',
  category: 'Animation',
  value: obj('faceMovement', 'Face movement', 'Yaw from the motion.', [
    // Phase 24.4f: `velocity` faces the horizontal motion in any direction (3D too); `sides` (absent) picks one of two yaws by the sign of X.
    enm('mode', 'Mode', 'Sides: one yaw moving right, another moving left. Velocity: faces the way it moves, in any direction.', FACE_MOVEMENT_MODES, { default: 'sides', omitDefault: true, labels: { sides: 'Two sides', velocity: 'Face velocity' } }),
    num('yawRight', 'Yaw moving right', 'Rotation about +Y while the parent moves right.', { required: true, when: when('mode', 'sides'), min: -360, max: 360, step: 5, unit: 'deg', default: 90 }),
    num('yawLeft', 'Yaw moving left', 'Rotation about +Y while the parent moves left.', { required: true, when: when('mode', 'sides'), min: -360, max: 360, step: 5, unit: 'deg', default: -90 }),
    num('yawOffset', 'Yaw offset', 'Added to the motion\'s yaw (0: the model is authored facing +Z).', { when: when('mode', 'velocity'), min: -360, max: 360, step: 5, unit: 'deg', default: 0 }),
    num('turnSeconds', 'Turn time', 'Time to turn around (a half turn).', { min: 0, max: 5, step: 0.01, unit: 's', default: 0.12 }),
  ]),
  // Phase 15.5: a model authored facing +Z turns ±90° to face +X / −X, turning around in 0.12 s (quick, still visible).
  add: { kind: 'menu', value: { yawRight: 90, yawLeft: -90, turnSeconds: 0.12 } },
  presets: [
    { label: 'Two sides', value: { yawRight: 90, yawLeft: -90, turnSeconds: 0.12 } },
    // Phase 24.4f: a model authored facing +Z faces its motion (a 3D walker, a top-down character).
    { label: 'Face velocity', value: { mode: 'velocity', turnSeconds: 0.12 } },
  ],
  handles: [],
  excludes: [],
  prefab: true,
};

// ---- the entity's own fields ------------------------------------------------------

const ENTITY: ObjectFieldDescriptor = obj('entity', 'Object', 'An object in a scene.', [
  str('id', 'Id', 'The stable object id.', { ...ID, required: true, readOnly: true }),
  str('name', 'Name', 'The name shown in the Hierarchy.', NAME),
  entity('parentId', 'Parent', 'The parent object (none: a scene root).', { nullable: true, default: null }),
  bool('active', 'Active', 'Inactive objects are not in the game (an object a script switches off stays loaded but is not drawn, collides with nothing, fires no trigger and does not tick).', { default: true, omitDefault: true }),
  // Phase 25.10: drawn or not while the game runs (scripts and collectibles hide objects; never stored).
  bool('visible', 'Visible', 'Drawn (with its children, their lights and effects); it still collides, triggers and ticks while hidden.', { default: true, runtimeOnly: true }),
  bool('locked', 'Locked', 'Cannot be selected in the Scene view.', { default: false, omitDefault: true }),
  bool('static', 'Static', 'Never moves (baked lighting, cheaper rendering).', { default: false, omitDefault: true }),
  int('tags', 'Tags', 'The tag bits (a 32-bit mask of the project\'s tags).', { min: 0, max: 0xffffffff, default: 0, omitDefault: true }),
  { type: 'components', key: 'components', label: 'Components', tooltip: 'What the object is and does.', required: true, allowed: [] },
]);

// ---- content blocks ----------------------------------------------------------------

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

// Phase 23.18: environment presets — named looks scripts switch or blend to (a part a preset leaves out is the base look's).
const PRESET_LIGHT = obj('*', 'Light', 'The values this preset gives the lights it names (one of entity, tag or type; none: every light).', [
  entity('entity', 'Entity', 'One light by its entity.', { component: 'light' }),
  str('tag', 'Tag', 'Every light with this tag.', { format: 'identifier', minLength: 1, maxLength: 32 }),
  enm('type', 'Type', 'Every light of this type.', ['directional', 'ambient', 'point', 'spot', 'hemisphere']),
  color('color', 'Colour', 'The light colour.'),
  num('intensity', 'Intensity', 'The light intensity (candela for point and spot lights).', { min: 0, max: 1000, step: 0.05 }),
  vec3('direction', 'Direction', 'Where a directional or spot light shines (not all 0).', { min: -1, max: 1, step: 0.05, nonZero: true }),
  color('groundColor', 'Ground colour', 'A hemisphere light\'s ground colour.'),
], { rules: ['A light entry names at most one of entity, tag or type (none: every light).'] });
const PRESET = obj('*', 'Preset', 'A named look: sky, fog, post-processing, light values and a lightmap multiplier.', [
  str('presetId', 'Id', 'A stable id scripts use: a-z, 0-9, _ or -.', { required: true, format: 'identifier', minLength: 1, maxLength: 64 }),
  str('name', 'Name', 'Shown in the editor.', { required: true, minLength: 1, maxLength: 128 }),
  SKY,
  FOG,
  POST,
  list('lights', 'Lights', 'Light values (later entries win per field).', PRESET_LIGHT, { maxItems: 32 }),
  obj('lightmap', 'Lightmap', 'Multiplies baked lighting (a bake keeps the light of the moment it was baked).', [
    num('intensity', 'Intensity', 'Multiplies the baked light (1: as baked).', { min: 0, max: 8, step: 0.05, default: 1 }),
    color('tint', 'Tint', 'Tints the baked light (white: as baked).', { default: '#ffffff' }),
  ]),
], { rules: ['Preset ids are unique.'] });

const ENVIRONMENT: FieldDescriptor = obj('environment', 'Environment', 'Sky, fog, post-processing, wind and the default quality.', [
  SKY,
  FOG,
  POST,
  WIND,
  enm('quality', 'Quality', 'The default graphics quality (players change it in Settings).', ['low', 'medium', 'high'], { default: 'high' }),
  list('presets', 'Presets', 'Named looks scripts switch or blend to at run time (ctx.environment).', PRESET, { maxItems: 64 }),
]);

const KEY_CODE = { format: 'keyCode' as const, minLength: 1, maxLength: 32 };
const BINDING_KINDS = ['key', 'gamepadButton', 'gamepadAxis', 'keys1d', 'keys2d', 'gamepadButtons1d', 'gamepadStick', 'pointerButton', 'pointerPosition', 'pointerDelta', 'pointerAxis'] as const;
const INPUT: FieldDescriptor = obj('input', 'Input', 'The game\'s actions and their keys and gamepad bindings (absent: the default actions).', [
  list('actions', 'Actions', `Up to ${MAX_INPUT_ACTIONS} named actions.`, obj('*', 'Action', 'A named action and its bindings.', [
    str('name', 'Name', 'The action name scripts and blocks read (a letter or _, then letters, digits or _).', { required: true, format: 'identifier', minLength: 1, maxLength: 32 }),
    enm('type', 'Type', 'A button, a 1D axis (left/right) or a 2D axis.', INPUT_ACTION_TYPES, { required: true, default: 'button', labels: { axis1d: 'Axis (1D)', axis2d: 'Axis (2D)' } }),
    // Phase 23.10: gameplay, ui or one of the project's own maps (game modes activate maps).
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
      // Phase 23.14: absent = a tap counts at once; 0.5 s is a deliberate hold most players read as "hold" (a starting value the designer tunes).
      num('hold', 'Hold', 'Hold instead of tap: the binding counts only after it has been held this long.', { when: when('kind', 'key', 'gamepadButton', 'pointerButton'), min: INPUT_HOLD_MIN, max: INPUT_HOLD_MAX, step: 0.05, unit: 's', default: 0.5 }),
    ], { rules: ['A button takes keys, buttons and pointer buttons; a 1D axis also two-key, two-button, axis and pointer-axis bindings; a 2D axis four keys, a stick, the pointer position or the pointer movement.'] }), { required: true, maxItems: MAX_INPUT_BINDINGS }),
    num('deadZone', 'Dead zone', 'Axis values within this count as 0 (then rescaled).', { min: 0, max: 1, maxExclusive: true, step: 0.05, default: 0.2 }),
    bool('invert', 'Invert', 'Flip the axis.', { default: false }),
    num('scale', 'Scale', 'Multiply the value.', { min: 0, minExclusive: true, max: 10, step: 0.1, unit: '×', default: 1 }),
  ]), { required: true, maxItems: MAX_INPUT_ACTIONS }),
  // Phase 23.10: the project's own input maps (a game mode activates maps; gameplay and ui always exist).
  list('maps', 'Project maps', `Up to ${MAX_INPUT_MAPS} input maps besides gameplay and ui (game modes activate maps).`, str('*', 'Map', 'A letter or _, then letters, digits or _.', { format: 'identifier', minLength: 1, maxLength: 32 }), { maxItems: MAX_INPUT_MAPS, unique: true }),
  // Phase 23.3: free by default — a pointer-driven game needs a visible cursor; mouse-look opts in to locked.
  // Phase 25.6: keyed by any map (gameplay, ui or the project's own).
  map('cursor', 'Cursor', 'The cursor while each map is active (absent: free): free, or locked (hidden and held in the view; its movement still counts, its position is the view\'s centre). The ui map\'s applies while a menu is open; during play the first of the active maps that sets one (a game mode\'s maps in their order). It is hidden while a gamepad drives the game.', 'Map', enm('*', 'Cursor', 'Free or locked while this map is active.', CURSOR_MODES, { default: 'free' }), { keyRef: 'inputMap', maxEntries: MAX_INPUT_MAPS + 2 }),
  // Phase 23.14: the project's own glyph images (absent: the engine's generic icons).
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
  enm('shader', 'Shader', 'Standard, foliage (wind), kit (world-space detail), unlit or water.', MATERIAL_SHADERS, { required: true, default: 'standard' }),
  obj('params', 'Parameters', 'Shader parameter overrides.', MATERIAL_SHADERS.flatMap((s) => Object.entries(MATERIAL_PARAMS[s]).map(([k, t]) => paramField(k, t, s))), { required: true, default: {} }),
  obj('textures', 'Textures', 'Texture slots.', MATERIAL_SHADERS.flatMap((s) => MATERIAL_TEXTURE_SLOTS[s].map((slot) => asset(slot, slot.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), `The ${s} shader\'s ${slot} texture.`, ['texture'], { when: when('../shader', s) }))), { required: true, default: {} }),
  // Phase 18.0: a graph material's exposed parameters and its node graph.
  list('parameters', 'Exposed parameters', `Up to ${MAX_MATERIAL_PARAMETERS} parameters the graph reads (Parameter nodes); objects may override the public ones.`, obj('*', 'Parameter', 'An exposed parameter.', [
    str('key', 'Key', 'The name Parameter nodes and overrides use.', { required: true, format: 'identifier', minLength: 1, maxLength: 32 }),
    enm('type', 'Type', 'The value type (colour is a vec3 edited as a colour; a texture names a texture asset).', MATERIAL_PARAMETER_TYPES, { required: true, default: 'float' }),
    json('default', 'Default', 'The material\'s own value (a number, 2–4 numbers, "#rrggbb", a texture asset id / "", or a data parameter\'s starting RGBA bytes).', { required: true, typedBy: 'materialParameter' }),
    num('min', 'Min', 'The lowest value, within ±1e6 (numbers and vectors).', { when: when('type', 'float', 'vec2', 'vec3', 'vec4') }),
    num('max', 'Max', 'The highest value, within ±1e6 and at least min (numbers and vectors).', { when: when('type', 'float', 'vec2', 'vec3', 'vec4') }),
    // Phase 23.12: a data parameter's grid (cells per side; 64 is the engine limit).
    vec2('size', 'Size', `A data parameter's cells [width, height], 1–${MATERIAL_DATA_MAX} each.`, { required: true, when: when('type', 'data'), labels: ['width', 'height'], min: 1, max: MATERIAL_DATA_MAX, step: 1, default: [8, 8] }),
    enm('visibility', 'Visibility', 'Public: objects may override it. Private: the material\'s value only.', ['public', 'private'], { default: 'public', omitDefault: true }),
    str('label', 'Label', 'Shown instead of the key.', { minLength: 1, maxLength: 64 }),
    str('group', 'Group', 'A foldable group in the Inspector.', { minLength: 1, maxLength: 64 }),
    str('tooltip', 'Tooltip', 'Help text.', { minLength: 1, maxLength: 256 }),
  ]), { maxItems: MAX_MATERIAL_PARAMETERS }),
  json('graph', 'Graph', 'The node graph (graph kind "material"): nodes, wires, groups and comments, edited in the Material tab with graph edits.', { readOnly: true }),
  // Phase 25.19: a material instance (its parent's look with some values changed).
  str('instanceOf', 'Instance of', 'A material instance: the parent material (or instance) whose look it takes.', { ...ID }),
  json('values', 'Parameter values', "An instance of a graph material: its values for the parent's parameters (parameter key → value)."),
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
  { key: 'environment', label: 'Environment', tooltip: 'Sky, fog, post-processing, wind and quality.', required: false, value: ENVIRONMENT, ops: ['setEnvironment'] },
  { key: 'input', label: 'Input', tooltip: 'Actions and their bindings.', required: false, value: INPUT, ops: ['setInput'] },
  { key: 'materials', label: 'Materials', tooltip: 'Project materials.', required: false, value: list('materials', 'Materials', `Up to ${MAX_MATERIALS} materials.`, MATERIAL_ITEM, { maxItems: MAX_MATERIALS, default: [] }), ops: ['setMaterial', 'deleteMaterial'] },
  { key: 'animators', label: 'Animator controllers', tooltip: 'State machines for model animation.', required: false, value: list('animators', 'Animator controllers', `Up to ${MAX_ANIMATORS} controllers.`, ANIMATOR_ITEM, { maxItems: MAX_ANIMATORS, default: [] }), ops: ['setAnimator', 'deleteAnimator'] },
  // Phase 20.0: visual effects; each system's graph is edited in the Effect tab (graphEdit ops).
  { key: 'effects', label: 'Effects', tooltip: 'Visual effects: particle systems authored as node graphs.', required: false, value: list('effects', 'Effects', `Up to ${EFFECT_LIMITS.effects} effects.`, EFFECT_ITEM, { maxItems: EFFECT_LIMITS.effects, default: [] }), ops: ['setEffect', 'deleteEffect', 'renameEffect', 'graphEdit'] },
  // Phase 23.7: shared script libraries; their files are edited in the script editor (Library tab).
  { key: 'scriptLibraries', label: 'Script libraries', tooltip: 'Shared TypeScript and JSON modules every script can import as @lib/<id>.', required: false, value: list('scriptLibraries', 'Script libraries', `Up to ${SCRIPT_LIBRARY_LIMITS.libraries} libraries.`, json('*', 'Library', 'A script library: { libraryId, name, files: [{ path, text }] }.', { readOnly: true }), { maxItems: SCRIPT_LIBRARY_LIMITS.libraries, default: [] }), ops: ['setScriptLibrary', 'deleteScriptLibrary'] },
  // Phase 23.5 (E8): block types, the cell metadata schema and stamps for block layers.
  {
    key: 'blockTypes',
    label: 'Block types',
    tooltip: 'The blocks block layers are built from: their looks, collision shape, footprint, rotations and default cell metadata.',
    required: false,
    value: list('blockTypes', 'Block types', `Up to ${BLOCK_LIMITS.blockTypes} block types.`, obj('*', 'Block type', 'One block.', [
      str('blockId', 'Id', 'The stable block id cells name.', { ...ID, required: true }),
      str('name', 'Name', 'Shown in the block palette.', { ...NAME, required: true }),
      json('variants', 'Looks', `1–${BLOCK_LIMITS.variants} weighted looks: {model: {assetId, piece?}} | {prefab} | {color: "#rrggbb"}, each with an optional weight (a cell without a variant picks one by weight, stably by position).`, { required: true }),
      enm('shape', 'Collision shape', 'The collision shape (and the coloured stand-in\'s shape): full, half, ramp, stairs (rising toward +Z), custom boxes or none.', ['full', 'half', 'ramp', 'stairs', 'custom', 'none'], { required: true }),
      json('boxes', 'Custom boxes', `1–${BLOCK_LIMITS.customBoxes} boxes [x0, y0, z0, x1, y1, z1] in footprint units (0–1).`, { required: true, when: when('shape', 'custom') }),
      bool('solid', 'Solid', 'Fills its cell and hides the faces of neighbours touching it (absent: a full shape is solid).'),
      vec3('footprint', 'Footprint', 'Cells along x, y and z (a 2 × 1 × 2 well); the cells it covers stay empty.', { min: 1, max: BLOCK_LIMITS.footprint, step: 1, default: [1, 1, 1], labels: ['x', 'y', 'z'] }),
      json('rotations', 'Rotations', 'The allowed rotations in degrees: a set of 0, 90, 180, 270 (absent: all).'),
      json('metadata', 'Default metadata', 'Cell metadata every cell of this block starts with (field key → value).'),
      json('materials', 'Materials', 'Model material mapping: source material name (or "*") → materialId.'),
    ]), { maxItems: BLOCK_LIMITS.blockTypes, default: [] }),
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
    value: list('blockStamps', 'Block stamps', `Up to ${BLOCK_LIMITS.stamps} stamps.`, obj('*', 'Stamp', 'A saved pattern.', [
      str('stampId', 'Id', 'The stable stamp id.', { ...ID, required: true }),
      str('name', 'Name', 'Shown in the stamp list.', { ...NAME, required: true }),
      vec3('size', 'Size', 'The pattern\'s extent in cells.', { required: true, min: 1, max: BLOCK_LIMITS.stampSize, step: 1, labels: ['x', 'y', 'z'] }),
      json('palette', 'Palette', 'The cell values the runs name.', { required: true, readOnly: true }),
      json('columns', 'Cells', `Run-length columns [x, z, y, n, p, …] (at most ${BLOCK_LIMITS.stampCells} cells).`, { required: true, readOnly: true }),
    ]), { maxItems: BLOCK_LIMITS.stamps, default: [] }),
    ops: ['setBlockStamp', 'deleteBlockStamp'],
  },
  // Phase 23.9a: project UI documents and themes (JSON widget trees; the visual editor is 23.9b).
  { key: 'uiDocuments', label: 'UI documents', tooltip: 'HUDs, menus and screens drawn by the game over the view (widget trees bound to script values).', required: false, value: list('uiDocuments', 'UI documents', `Up to ${UI_LIMITS.documents} documents.`, json('*', 'Document', 'A UI document: { uiDocumentId, name, root, styles?, tweens?, … }.', { readOnly: true }), { maxItems: UI_LIMITS.documents, default: [] }), ops: ['setUiDocument', 'deleteUiDocument'] },
  // Phase 23.10: game modes (the first is the start mode) and the behavior groups modes tick.
  { key: 'modes', label: 'Game modes', tooltip: 'Named states of the running game: the input maps, camera, UI documents and ticking behavior groups of each, switched in one transition without a scene load (explore and tactical, on foot and driving, build and play…). The first mode is the one a run starts in.', required: false, value: list('modes', 'Game modes', `Up to ${MODE_LIMITS.modes} modes; the first is the start mode.`, MODE_ITEM, { maxItems: MODE_LIMITS.modes, default: [] }), ops: ['setModes'] },
  { key: 'behaviorGroups', label: 'Behavior groups', tooltip: 'Names an object\'s behavior can belong to (its Behavior group component); a game mode lists the groups that tick while it is active.', required: false, value: list('behaviorGroups', 'Behavior groups', `Up to ${MODE_LIMITS.behaviorGroups} names.`, str('*', 'Group', 'A letter or _, then letters, digits or _.', { format: 'identifier', minLength: 1, maxLength: 32 }), { maxItems: MODE_LIMITS.behaviorGroups, unique: true, default: [] }), ops: ['setBehaviorGroups'] },
  // Phase 24.4j: the game shell — menus and HUD as UI documents, the ordered scene list (a game that plays as a scene).
  {
    key: 'shell',
    label: 'Game shell',
    tooltip: 'The menus around the game and its HUD, drawn with the project\'s UI documents: a title before play, pause, settings, controls (rebinding) and the save and load screens (project saves), the HUD shown while playing, and the game\'s scenes in order for New game and Next scene.',
    required: false,
    value: obj('shell', 'Game shell', 'Menus, HUD and the scene list of a game without the game session.', [
      obj('screens', 'Screens', 'The UI document drawn for each shell screen. Its buttons use the engine actions: new game, continue, resume, back, open a screen, save or load a slot, set a volume, rebind, next scene.', [
        ref('title', 'Title', 'Shown before play (the game waits behind it); absent: the game starts at once.', 'uiDocument'),
        ref('pause', 'Pause', 'Shown while paused (absent: the engine\'s pause panel with Resume and Restart).', 'uiDocument'),
        ref('settings', 'Settings', 'Opened by the settings or open action (volumes, quality).', 'uiDocument'),
        ref('controls', 'Controls', 'The rebinding screen (rebind actions; $flow.input lists the actions and their keys).', 'uiDocument'),
        ref('save', 'Save', 'Save slots (project saves; $flow.saves lists them).', 'uiDocument'),
        ref('load', 'Load', 'Load slots (project saves).', 'uiDocument'),
      ]),
      list('hud', 'HUD', `UI documents shown while the game plays (hidden behind the menus); bind to $flow.counters, $flow.health, $flow.prompts or script values. Up to ${SHELL_LIMITS.hud}.`, ref('*', 'Document', 'A UI document.', 'uiDocument'), { maxItems: SHELL_LIMITS.hud, unique: true }),
      list('scenes', 'Scene list', `The game's scenes in order: New game begins a fresh run at the first, Next scene moves on to the next (up to ${SHELL_LIMITS.scenes}).`, obj('*', 'Listed scene', 'A scene and where the character starts in it.', [
        scene('scene', 'Scene', 'A scene of the project.', { required: true }),
        entity('spawn', 'Spawn', 'The player spawn the character starts at (in that scene; absent: it stays where it is).', { component: 'playerSpawn', anyScene: true }),
        // Phase 25.24e: the fade of a move to this scene.
        num('fade', 'Fade', 'Seconds the view fades out before a move to this scene and back in after it (absent or 0: no fade; the previous scene stays in view until this one is drawn).', { min: 0, max: MAX_TRANSITION_FADE, step: 0.05 }),
        color('fadeColor', 'Fade colour', 'The colour the view fades to (absent: black).'),
      ]), { maxItems: SHELL_LIMITS.scenes }),
      bool('pause', 'Pause allowed', 'The pause input opens the pause screen.', { default: true }),
      bool('status', 'Status line', 'A small debug line: the shell screen, the listed scene and the input prompts.', { default: false }),
    ]),
    ops: ['setShell'],
  },
  // Phase 24.4i: the event → cue table (the generic replacement for fixed cue slots).
  {
    key: 'eventCues',
    label: 'Event sounds',
    tooltip: 'Sounds the game plays when a signal is sent or an event happens (a trigger entered, something collected, damaged, touched…), by name.',
    required: false,
    value: list('eventCues', 'Event sounds', `Up to ${EVENT_CUE_LIMITS.cues} rows.`, obj('*', 'Event sound', 'One sound for one signal or event.', [
      enm('on', 'On', 'A signal (by its name) or an event scripts see in ctx.events (by its type: enter, exit, collected, damaged, died, contact…, or an animator clip event\'s name).', EVENT_CUE_SOURCES, { required: true, default: 'signal', labels: { signal: 'Signal', event: 'Event' } }),
      str('name', 'Name', 'The signal\'s name, or the event\'s type or name.', { required: true, minLength: 1, maxLength: EVENT_CUE_LIMITS.name, default: 'trigger' }),
      entity('entity', 'Object', 'Only this object\'s events (absent: any object\'s).', { when: when('on', 'event'), anyScene: true }),
      asset('assetId', 'Sound', 'The audio asset played.', ['audio'], { required: true }),
      num('volume', 'Volume', 'How loud (0–1).', { min: 0, max: 1, step: 0.05, default: 1 }),
      enm('bus', 'Bus', 'The mixer bus it plays on.', EVENT_CUE_BUSES, { default: 'sfx' }),
    ]), { maxItems: EVENT_CUE_LIMITS.cues, default: [] }),
    ops: ['setEventCues'],
  },
  { key: 'uiThemes', label: 'UI themes', tooltip: 'Named styles and icons UI documents share.', required: false, value: list('uiThemes', 'UI themes', `Up to ${UI_LIMITS.themes} themes.`, json('*', 'Theme', 'A UI theme: { uiThemeId, name, styles, icons? }.', { readOnly: true }), { maxItems: UI_LIMITS.themes, default: [] }), ops: ['setUiTheme', 'deleteUiTheme'] },
  // Phase 23.16: dialogue — conversations (dialogue graphs, edited in the Dialogue tab with graphEdit), the speaker registry, the settings.
  { key: 'dialogues', label: 'Dialogues', tooltip: 'Conversations: node graphs of lines (speaker, expression, text, voice clip), choices, conditions and effects, signals and jumps.', required: false, value: list('dialogues', 'Dialogues', `Up to ${DIALOGUE_LIMITS.dialogues} conversations.`, json('*', 'Dialogue', 'A conversation: { dialogueId, name, graph } (graph kind dialogue).', { readOnly: true }), { maxItems: DIALOGUE_LIMITS.dialogues, default: [] }), ops: ['setDialogue', 'deleteDialogue', 'graphEdit'] },
  { key: 'speakers', label: 'Speakers', tooltip: 'Who speaks in conversations: name, name-plate colour, portraits per expression, voice profile, text blip.', required: false, value: list('speakers', 'Speakers', `Up to ${DIALOGUE_LIMITS.speakers} speakers.`, json('*', 'Speaker', 'A speaker: { speakerId, name, color?, portraits? {expression: texture}, defaultExpression?, voiceProfile?, blip?, blipEvery?, blipVolume? }.', { readOnly: true }), { maxItems: DIALOGUE_LIMITS.speakers, default: [] }), ops: ['setSpeaker', 'deleteSpeaker'] },
  { key: 'dialogueSettings', label: 'Dialogue settings', tooltip: 'Text speed, auto-advance and its delay, the music/SFX duck under a voice, the backlog length, the dialogue UI document and theme.', required: false, value: json('dialogueSettings', 'Dialogue settings', '{ textSpeed? (chars/s, 0 instant), autoAdvance?, autoDelay? (s), duck? (0–1), backlog? (1–100), document? (uiDocumentId), theme? (uiThemeId) }.', { readOnly: true }), ops: ['setDialogueSettings'] },
  // Phase 23.17: timelines (tracks of keys on a time ruler; edited in the Timeline tab).
  { key: 'timelines', label: 'Timelines', tooltip: 'Sequences of camera cuts, moves, animation, sound, dialogue, effects, signals and fades on a time ruler, played by scripts or signals.', required: false, value: list('timelines', 'Timelines', `Up to ${TIMELINE_LIMITS.timelines} timelines.`, json('*', 'Timeline', 'A timeline: { timelineId, name, duration, slots?, markers?, tracks, … }.', { readOnly: true }), { maxItems: TIMELINE_LIMITS.timelines, default: [] }), ops: ['setTimeline', 'deleteTimeline'] },
  // Phase 16.1: standalone node graphs; their body is edited in the graph editor (graphEdit ops).
  { key: 'graphs', label: 'Graphs', tooltip: 'Standalone node graphs, edited in the graph editor.', required: false, value: list('graphs', 'Graphs', `Up to ${MAX_GRAPH_DOCUMENTS} graphs.`, json('*', 'Graph', 'A graph document: { graphId, kind, name, graph }.', { readOnly: true }), { maxItems: MAX_GRAPH_DOCUMENTS, default: [] }), ops: ['setGraph', 'deleteGraph', 'graphEdit'] },
  { key: 'tags', label: 'Tags', tooltip: 'Named tag bits objects carry.', required: false, value: list('tags', 'Tags', `Up to ${MAX_TAGS} tags.`, obj('*', 'Tag', 'A named bit.', [int('bit', 'Bit', 'The bit (0–31).', { required: true, min: 0, max: 31 }), str('name', 'Name', 'A letter, then letters, digits, _ or - (unique ignoring case).', { required: true, format: 'identifier', minLength: 1, maxLength: 32 })]), { maxItems: MAX_TAGS, default: [] }), ops: ['setTags'] },
  // Phase 23.3: named collision layers (3D physics); "default" is implicit.
  { key: 'collisionLayers', label: 'Collision layers', tooltip: 'Named collision layers colliders are in and script queries filter by (3D; "default" is implicit).', required: false, value: list('collisionLayers', 'Collision layers', `Up to ${MAX_COLLISION_LAYERS} names ("default" is implicit).`, str('*', 'Layer', 'A letter or _, then letters, digits or _.', { format: 'identifier', minLength: 1, maxLength: 32 }), { maxItems: MAX_COLLISION_LAYERS, unique: true, default: [] }), ops: ['setCollisionLayers'] },
  // Phase 23.19: the project save schema (save document version + migrations, slots, sections, picture, settings document).
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
      list('sections', 'Included state', 'Engine state every save includes: block cells, material values, spawned objects, script storage, the environment blend, dialogue variables and seen lines, and objects\' health, collectibles, patrols and hitboxes.', enm('*', 'Section', 'One kind of engine state.', [...SAVE_SECTIONS]), { maxItems: SAVE_SECTIONS.length }),
      obj('thumbnail', 'Slot picture', 'The size and format of a slot\'s picture of the view (absent: 256 × 144 JPEG).', [
        int('width', 'Width', 'Pixels.', { required: true, min: 16, max: SAVE_LIMITS.thumbnailSide }),
        int('height', 'Height', 'Pixels.', { required: true, min: 16, max: SAVE_LIMITS.thumbnailSide }),
        enm('format', 'Format', 'JPEG or WebP.', ['jpeg', 'webp'], { required: true }),
        num('quality', 'Quality', 'Encoder quality.', { min: 0.1, max: 1, step: 0.05 }),
      ]),
      list('settings', 'Settings document', `Up to ${SAVE_LIMITS.settingsFields} fields the game's settings screen writes (ctx.saves.setSetting): { key, type: bool|number|string|enum, default, label?, min?, max?, values?, engine?: music|sfx|ui|quality }.`, json('*', 'Setting', 'One settings field.'), { maxItems: SAVE_LIMITS.settingsFields }),
    ], { rules: ['a default fits its field; a volume binding is a 0–1 number, a quality binding an enum of low/medium/high'] }),
    ops: ['setSaveSchema'],
  },
  { key: 'settings', label: 'Gameplay settings', tooltip: 'Gravity, run speed, jump, slopes, and the engine settings (step rate, sound voices, music fade, animation blend).', required: true, value: SETTINGS, ops: ['setSettings'] },
  { key: 'scenes', label: 'Scenes', tooltip: 'The project\'s scenes.', required: true, value: list('scenes', 'Scenes', `1–${MAX_SCENES} scenes.`, obj('*', 'Scene', 'A scene file.', [str('sceneId', 'Id', 'The stable scene id.', { ...ID, required: true, readOnly: true }), str('name', 'Name', 'Shown in the scene list.', { ...NAME, required: true })]), { required: true, minItems: 1, maxItems: MAX_SCENES }), ops: ['createScene', 'renameScene', 'deleteScene'] },
  { key: 'startScenes', label: 'Start scenes', tooltip: 'The scenes loaded when the game starts (without a flow).', required: true, value: list('startScenes', 'Start scenes', `1–${MAX_SCENES} scenes.`, scene('*', 'Scene', 'A start scene.'), { required: true, minItems: 1, maxItems: MAX_SCENES, unique: true }), ops: ['setStartScenes'] },
  {
    key: 'assets',
    label: 'Assets',
    tooltip: 'Imported models, sounds, textures, music and fonts (their versions are written by the importer).',
    required: true,
    value: list('assets', 'Assets', 'The asset catalog.', obj('*', 'Asset', 'An imported asset.', [
      str('assetId', 'Id', 'The stable asset id.', { ...ID, required: true, readOnly: true }),
      enm('kind', 'Kind', 'Model, audio, texture, music or font.', ASSET_KINDS, { required: true, readOnly: true }),
      str('displayName', 'Name', 'Shown in the asset browser.', { ...NAME, required: true, readOnly: true }),
      int('currentVersion', 'Version', 'The current version (the last).', { required: true, min: 1, readOnly: true }),
      list('versions', 'Versions', 'Every imported version (append-only, written by the importer).', json('*', 'Version', 'An imported version: source, recipe and metrics.', { readOnly: true }), { required: true, minItems: 1, readOnly: true }),
      enm('vertexColors', 'Vertex colours', 'Data: COLOR_0 feeds shaders (wind weights). Tint: multiplies the colour.', ['data', 'tint'], { when: when('kind', 'model'), default: 'data', omitDefault: true }),
      map('materials', 'Default materials', 'Material slot → project material, for every placement.', 'Slot', ref('*', 'Material', 'A project material.', 'material'), { when: when('kind', 'model'), keyFormat: 'materialSlot', minEntries: 1, maxEntries: MAX_MATERIAL_SLOTS }),
      asset('clipsFor', 'Clips for', 'An animation-only file: its clips play on this model\'s rig.', ['model'], { when: when('kind', 'model') }),
    ]), { required: true }),
    ops: ['publishAsset', 'setAssetOptions', 'deleteAsset'],
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
    ops: ['createPrefab', 'instantiatePrefab', 'deletePrefab'],
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
  virtualCamera,
  cameraPath,
  cameraRegion,
  socketAttach,
  light,
  playerSpawn,
  mover,
  trigger,
  switchC,
  health,
  collectible,
  patrol,
  hitbox,
  climbVolume,
  gravityC,
  audioSource,
  animator,
  faceMovement,
  modelAnimation,
  behavior,
  prefab,
  folder,
  blockLayer,
  blockFootprint,
  behaviorGroupC,
];

// ---- phase 25.10: what scripts read and write (ctx.entity) --------------------------

/**
 * Components scripts never read: a folder is not in the game, an instance
 * set's copies and a block layer's cells are bulk data (the block layers are
 * read through `ctx.grid`).
 */
const SCRIPT_UNREADABLE: ReadonlySet<string> = new Set(['folder', 'instances', 'blockLayer']);
/** The object's own fields scripts read (`locked` is editor-only; `components` is the rest of the table). */
const SCRIPT_OBJECT_READ: ReadonlySet<string> = new Set(['id', 'name', 'parentId', 'active', 'visible', 'static', 'tags']);
/**
 * The fields scripts may write while the game runs, each with its runtime
 * behavior (runtime `entity-access.ts`). `*`: the component's value itself (a
 * map). Everything the engine builds once — static batching, baked lighting,
 * static colliders, instancing, assets that need loading — stays fixed.
 */
const SCRIPT_WRITABLE: Readonly<Record<string, readonly string[]>> = {
  entity: ['active', 'visible'],
  transform: ['position', 'rotation', 'scale'],
  light: ['color', 'intensity', 'range'],
  mover: ['speed', 'active'],
  materialParams: ['*'],
};

function markField(f: FieldDescriptor, read: boolean, write: boolean): FieldDescriptor {
  if (!read && !write) return f;
  return { ...f, ...(read ? { scriptReadable: true as const } : {}), ...(write ? { runtimeWritable: true as const } : {}) };
}

/** A component with its script marks (every top-level field readable, the listed ones writable). */
function withScriptAccess(c: ComponentDescriptor): ComponentDescriptor {
  if (SCRIPT_UNREADABLE.has(c.name)) return c;
  const writable = SCRIPT_WRITABLE[c.name] ?? [];
  const root = c.value;
  if (root.type !== 'object') return { ...c, value: markField(root, true, writable.includes('*')) };
  return { ...c, value: { ...root, fields: root.fields.map((f) => markField(f, true, writable.includes(f.key))) } };
}

function withObjectScriptAccess(e: ObjectFieldDescriptor): ObjectFieldDescriptor {
  const writable = SCRIPT_WRITABLE['entity'] ?? [];
  return { ...e, fields: e.fields.map((f) => markField(f, SCRIPT_OBJECT_READ.has(f.key), writable.includes(f.key))) };
}

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
  entity: withObjectScriptAccess({ ...ENTITY, fields: ENTITY.fields.map((f) => (f.key === 'components' ? { ...f, allowed: COMPONENTS.map((c) => c.name) } : f)) }),
  components: COMPONENTS.map(withScriptAccess),
  icons: [...COMPONENT_ICONS],
  content: CONTENT,
  ui: UI_DESCRIPTORS,
});
