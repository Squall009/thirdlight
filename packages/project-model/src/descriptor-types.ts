/**
 * The descriptor types: how a field, a component, a content block and the
 * whole registry are described to the editor, the backend and MCP.
 */

import { type UiDescriptors } from './ui-descriptors';

// ---- the descriptor types ----------------------------------------------------

/** A JSON value (defaults, presets, create values). */
export type DescriptorJson = null | boolean | number | string | readonly DescriptorJson[] | { readonly [k: string]: DescriptorJson };
export type DescriptorScalar = string | number | boolean;

/** The units a field may be in (display text; values are stored in these units). */
export type DescriptorUnit = 'm' | 'm/s' | 'm/s²' | 's' | 'deg' | 'deg/s' | 'cd' | '1/m' | 'points' | 'points/s' | '×' | 'Hz' | 'voices' | 'px' | 'ms' | 'MiB';

/** The Scene-view handle kinds (the Scene view draws and drags them). */
export const HANDLE_KINDS = ['box2', 'box3', 'radius', 'capsule', 'cone', 'direction', 'path', 'polygon', 'point', 'height', 'bounds', 'spline'] as const;
export type HandleKind = (typeof HANDLE_KINDS)[number];

/**
 * The roles each handle kind binds to fields, as alternative role sets
 * (a `box2` edits a `[w, h]` size, or half extents `hx`/`hy`).
 */
export const HANDLE_ROLES: Readonly<Record<HandleKind, readonly (readonly string[])[]>> = {
  // Half extents with an optional depth (a collider box: three axes once hz is set).
  box2: [['size'], ['halfX', 'halfY'], ['halfX', 'halfY', 'halfZ']],
  box3: [['size']],
  radius: [['radius']],
  // A centred capsule (a collider or trigger) has no offset.
  capsule: [['radius', 'height', 'offset'], ['radius', 'height']],
  cone: [['direction', 'angle', 'range']],
  direction: [['direction']],
  path: [['points']],
  polygon: [['vertices']],
  point: [['point']],
  // A height above the object's origin (or above the feet of a capsule, `from`), dragged up and down.
  height: [['height']],
  // An axis-aligned box between two corners (a track camera's bounds), each corner dragged.
  bounds: [['min', 'max']],
  // A curve's points ({at, tangent?, width?, roll?}), dragged across the ground, up and down, wider and turned.
  spline: [['points']],
};

export const ASSET_KINDS = ['model', 'audio', 'texture', 'font'] as const;
export type DescriptorAssetKind = (typeof ASSET_KINDS)[number];

/** What an `ref` field names (besides assets, entities and scenes). */
export type DescriptorRefTarget = 'material' | 'animator' | 'behavior' | 'prefab' | 'animatorParameter' | 'animatorState' | 'clip' | 'effect' | 'uiDocument' | 'uiTheme' | 'uiTween' | 'uiWidget' | 'behaviorGroup' | 'inputMap' | 'mode';

/** String formats (validation hints and widget choices). */
export type DescriptorStringFormat = 'id' | 'name' | 'identifier' | 'keyCode' | 'counter' | 'multiline' | 'sha256' | 'materialSlot' | 'boneName' | 'socketNode' | 'ownBone';

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
  /** The project physics dimension the field applies in (absent: both); the Inspector shows the project's. */
  readonly dimension?: 2 | 3;
  /**
   * Scripts read it (`ctx.entity(ref).get(component)`: a
   * read-only snapshot of the step-start state). The marks are versioned with
   * the project schema (`SCRIPT_ACCESS_SCHEMA_VERSION`): renaming a marked
   * field is a schema change.
   */
  readonly scriptReadable?: true;
  /**
   * Scripts may write it while the game runs
   * (`ctx.entity(ref).set(component, patch)`, applied at the end of the step);
   * each such field has defined runtime behavior. Every other field is fixed
   * at run time and a write to it is refused naming the field.
   */
  readonly runtimeWritable?: true;
  /** Exists only while the game runs (never stored; starts at `default`). */
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
  /** Only these values (a choice of numbers, e.g. a step rate). */
  readonly values?: readonly number[];
  /** What each of `values` is called (same order; shown instead of the number). */
  readonly valueLabels?: readonly string[];
  /**
   * A bit mask of layers (bit n: layer n + 1): the Inspector shows one
   * checkbox per layer — light layers named by `content.lightLayers`, decal
   * layers by number.
   */
  readonly mask?: 'lightLayers' | 'decalLayers';
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
  /** A vec3 whose last component may be left out (`[x, y]` reads as `[x, y, 0]`). */
  readonly optionalLast?: boolean;
  /** Components (by index) that always hold one value (a cell square from above: x and z); editing one sets them all. */
  readonly same?: readonly number[];
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
  /** `uiBinding`: the plain value a binding stands in for (the editor offers it or a view-model path). */
  readonly valueType?: 'number' | 'text' | 'bool' | 'texture' | 'entity';
  /**
   * The TypeScript type the value has, written with types this package
   * exports (e.g. `ScatterRule[]`): the generated reference prints those
   * declarations, so a value edited as JSON is documented field by field.
   */
  readonly shape?: string;
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
   * How a `local` handle's frame follows the object, as the engine
   * reads the data: its position only (absent — areas, paths, ranges), its
   * rotation about Z too (`rotationZ`: a collider), its whole rotation
   * (`rotation`: a spot light's direction) or its whole transform, scale
   * included (`transform`: a box mesh's size).
   */
  readonly follows?: 'position' | 'rotationZ' | 'rotation' | 'transform';
  /** `radius`: measured along X only (the engine compares horizontal distance) instead of in the X/Y plane. */
  readonly along?: 'x';
  /** `radius` along X: a field (pointer) giving the half height of the band drawn with it (read, not dragged). */
  readonly band?: string;
  /** `path`, `spline`: the path closes back to its start while this holds. */
  readonly loop?: FieldCondition;
  /** The project physics dimension the handle applies in (absent: both). */
  readonly dimension?: 2 | 3;
  /** `height`: a capsule field (pointer to its object) whose feet the height is measured from (read, not dragged). */
  readonly from?: string;
  /**
   * The frame's origin is another object — the one an entity
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
 * The icon an object carrying the component shows in the Scene
 * view and the hierarchy (the editor draws the artwork). When an object
 * carries several components with icons, the one earliest in this list wins
 * (the most specific first).
 */
export const COMPONENT_ICONS = ['camera', 'spawn', 'audio', 'fog', 'patrol', 'mover', 'switch', 'collectible', 'sensor', 'hitbox', 'health'] as const;
export type ComponentIcon = (typeof COMPONENT_ICONS)[number];

/**
 * A GameObject menu entry that creates a new object carrying the
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
  /** `dimension` — the project physics dimension a preset fits (absent: both; the "+ Add component" list shows the project's). */
  /** Starting values; `requires`: components the object needs for this one (a model collider needs a model). */
  readonly presets?: readonly { readonly label: string; readonly value: DescriptorJson; readonly dimension?: 2 | 3; readonly requires?: readonly string[] }[];
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
  /** The GameObject menu entries that create an object with it. */
  readonly create?: readonly CreateEntryDescriptor[];
  /** The object's icon (see `COMPONENT_ICONS`). */
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
  /** The component icons, most specific first (an object shows the first its components name). */
  readonly icons?: readonly ComponentIcon[];
  /** Every v4 content block. */
  readonly content: readonly ContentBlockDescriptor[];
  /** The fields of a UI document, a widget, a style and a tween (the UI document editor's Inspector). */
  readonly ui?: UiDescriptors;
  /** A scene's look (sky, fog, post-processing, wind): each scene document's `environment`, set with `setEnvironment {sceneId}`. */
  readonly sceneEnvironment?: ObjectFieldDescriptor;
}