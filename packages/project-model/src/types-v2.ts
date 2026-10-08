/**
 * Logical types of the v2 model (components, content catalog, prefabs,
 * declared properties, physics components, behavior records and trust,
 * captured content view). The v3/v4 types (`types-v3.ts`) are built from
 * these.
 *
 * These describe the STRICT canonical output of the normalizers:
 * defaults filled, fixed key order, only present fields emitted. Inputs to
 * the entry points are `unknown`; the boundary re-checks every rule.
 */

import type { LocalLightMode } from './local-lights';
import type {
  BoxComponent,
  CameraComponent,
  Quat,
  TransformComponent,
  Vec3,
} from './types';
import type { EntityComponentsV3 } from './types-v3';

// ---- components ------------------------------------------

/** `components.model`: a whole-GLB reference by stable opaque id. */
export interface ModelAssetRef {
  assetId: string;
}

export interface ModelComponent {
  asset: ModelAssetRef;
  /**
   * One named piece of a multi-piece GLB (the base name of its
   * `<piece>_LOD<n>`/`<piece>_COL` nodes, or a top-level node name); absent =
   * the whole file.
   */
  piece?: string;
  /** Casts the directional light's realtime shadow (absent: true). */
  castShadow?: boolean;
  /** Shows realtime shadows falling on it (absent: true). */
  receiveShadow?: boolean;
  /** The light layers it is in, a bit mask (light-layers.ts; absent: every layer). */
  lightLayers?: number;
  /** How local lights reach it (local-lights.ts; absent: its material's mode, else per pixel). */
  localLights?: LocalLightMode;
}

/** Seven-type property value vocabulary. */
export type PropertyValue =
  | number
  | boolean
  | string
  | [number, number, number]
  | null;

/** `components.behavior`: values keyed by the resolved declaration. */
export interface BehaviorComponent {
  behaviorId: string;
  values: Record<string, PropertyValue>;
}

/** `components.prefab`: informational provenance, never inheritance. */
export interface PrefabProvenanceComponent {
  prefabId: string;
  localId: string;
}

export interface ColliderBoxShape {
  type: 'box';
  hx: number;
  hy: number;
  /** The half depth along Z (m) — required in a 3D project, ignored by a 2D plane. */
  hz?: number;
}

export interface ColliderPolygonShape {
  type: 'polygon';
  vertices: [number, number][];
}

/** 3D projects: a sphere centred on the entity. */
export interface ColliderSphereShape {
  type: 'sphere';
  radius: number;
}

/**
 * 3D projects: a capsule standing along the entity's local Y,
 * centred on the entity — `height` is the total height, end caps included
 * (>= 2 x radius), the controller capsule's convention.
 */
export interface ColliderCapsuleShape {
  type: 'capsule';
  radius: number;
  height: number;
}

/**
 * 3D projects: the convex hull of `points` ([x, y, z] in the
 * entity's frame) — usually generated from a model's `_COL` node or its
 * geometry, stored as data like the 2D plane's model outline polygon.
 */
export interface ColliderConvexShape {
  type: 'convex';
  points: [number, number, number][];
}

/**
 * 3D projects, static only: a triangle mesh — `vertices`
 * ([x, y, z] in the entity's frame) and `triangles` (index triples into
 * them), usually generated from a model's `_COL` node or its geometry.
 */
export interface ColliderMeshShape {
  type: 'mesh';
  vertices: [number, number, number][];
  triangles: [number, number, number][];
}

/**
 * Where a shape sits in its object's frame: `center` [x, y, z] in metres (a
 * 2D plane reads x and y) and `rotation` a unit quaternion [x, y, z, w]
 * (about Z only on a 2D plane). Absent: centred, unrotated.
 */
export interface ColliderShapePose {
  center?: [number, number, number];
  rotation?: [number, number, number, number];
}

/** One primitive shape (sphere, capsule, convex and mesh in 3D projects), placed by its pose. */
export type ColliderPrimitiveShape = (ColliderBoxShape | ColliderPolygonShape | ColliderSphereShape | ColliderCapsuleShape | ColliderConvexShape | ColliderMeshShape) & ColliderShapePose;

/** Several primitive shapes on one object (one body), each with its own pose. */
export interface ColliderCompoundShape {
  type: 'compound';
  shapes: ColliderPrimitiveShape[];
}

/**
 * Every convex part of the object's model's `_COL` node (its piece's, or
 * every `_COL` node of a single-piece file), read from the model file when
 * the game is built, so a changed model needs no edit.
 */
export interface ColliderModelShape {
  type: 'model';
}

/** The collider shape vocabulary. */
export type ColliderShape = ColliderPrimitiveShape | ColliderCompoundShape | ColliderModelShape;

export interface ColliderComponent {
  shape: ColliderShape;
  /** v4 only: the character passes from below and the sides, lands from above. */
  oneWay?: true;
  /** v4, 3D: the collision layers the collider is in (absent: "default"). */
  layers?: string[];
}

/**
 * v4 scenes: the player character's collision capsule. `height`
 * is the total height (end caps included, >= 2 x radius); `offset` places the
 * capsule's centre relative to the entity origin (default [0, 0]).
 */
export interface ControllerCapsule {
  radius: number;
  height: number;
  /** May carry a third component (z) in a 3D project. */
  offset?: [number, number] | [number, number, number];
}

/**
 * The player controller: the optional capsule (v4; absent =
 * `DEFAULT_CONTROLLER_CAPSULE`) and the optional movement tuning (v4;
 * absent = `DEFAULT_CONTROLLER_TUNING`, the values every project played
 * with before they became data).
 */
export interface ControllerComponent {
  capsule?: ControllerCapsule;
  /** m/s² toward the commanded run speed. */
  acceleration?: number;
  /** m/s² toward a slower (or zero) commanded speed. */
  deceleration?: number;
  /** Seconds after leaving an edge in which a jump still starts. */
  coyoteTime?: number;
  /** Seconds a jump press is remembered before landing. */
  jumpBuffer?: number;
  /** Upward speed kept when the jump is released early (0–1). */
  jumpRelease?: number;
  /** Metres the character is pulled down onto ground below it each step. */
  groundSnap?: number;
  /** Metres of gap the character keeps from the world. */
  skin?: number;
  /** Climbs steps up to `autostepHeight` without jumping. */
  autostep?: boolean;
  /** Metres: the highest step autostep climbs. */
  autostepHeight?: number;
  /** 3D projects: m/s walking (absent: 2). */
  walkSpeed?: number;
  /** 3D: m/s while the `run` action is held (absent: the project's run_speed). */
  runSpeed?: number;
  /** 3D: share of the acceleration available in the air (0–1, absent: 0.5). */
  airControl?: number;
  /** 3D: multiplies the project's gravity (absent: 1). */
  gravityScale?: number;
  /** 3D: whether the character can jump (absent: true). */
  jump?: boolean;
  /** 3D: m/s upward at a jump (absent: the project's jump_velocity). */
  jumpSpeed?: number;
  /** 3D: degrees, the steepest walkable slope (absent: the project's max_slope_climb_deg). */
  slopeLimit?: number;
  /** 3D: metres the character steps up without a jump (absent: 0.3; 0: off). */
  stepHeight?: number;
  /** 3D: pull up onto ledges up to `ledgeHeight` (absent: false). */
  ledgeClimb?: boolean;
  /** 3D: metres, the highest ledge it climbs (absent: 1.2). */
  ledgeHeight?: number;
  /** 3D: seconds a ledge climb takes (absent: 0.6). */
  ledgeClimbTime?: number;
  /** 3D: degrees per second it turns (absent: 720; 0: at once). */
  turnSpeed?: number;
  /** 3D: turn to face the movement direction (absent: true). */
  faceMovement?: boolean;
  /** 3D: what the move input is relative to — the live camera's heading or the world axes (absent: `view`). */
  moveFrame?: 'view' | 'world';
  /** The input action that moves it (absent: `move`). */
  moveAction?: string;
  /** The input action that makes it jump (absent: `jump`). */
  jumpAction?: string;
  /** 3D: the input action (a button) that makes it run while held (absent: `run`). */
  runAction?: string;
  /** m/s it moves inside a climb volume (absent: 2). */
  climbSpeed?: number;
  /** The input action (an axis) that climbs: its value, or a 2D axis' y (absent: the move action's y). */
  climbAction?: string;
  /** Falling while pushing into a wall slides down it at `wallSlideSpeed` at most (absent: false). */
  wallSlide?: boolean;
  /** m/s (absent: 2). */
  wallSlideSpeed?: number;
  /** Jump in the air off a wall it touches (absent: false). */
  wallJump?: boolean;
  /** m/s away from the wall at a wall jump (absent: the run speed). */
  wallJumpAway?: number;
  /** m/s upward at a wall jump (absent: the jump speed). */
  wallJumpUp?: number;
  /** Seconds a wall jump keeps the input from steering (absent: until the top of the jump; a landing ends it). */
  wallJumpLock?: number;
}

/** v2 component registry order: transform, model, box, camera, behavior, prefab, collider, controller. */
export interface EntityComponentsV2 {
  transform: TransformComponent;
  model?: ModelComponent;
  box?: BoxComponent;
  camera?: CameraComponent;
  behavior?: BehaviorComponent;
  prefab?: PrefabProvenanceComponent;
  collider?: ColliderComponent;
  controller?: ControllerComponent;
}

// ---- content catalog ----------------------------------------------------

/** The import recipe (recorded per version; part of the derived-cache key). */
export interface ImportRecipe {
  profile: 'gltf-glb';
  recipeVersion: 1;
  toolchain: Record<string, string>;
  extensions: string[];
}

/** The bounded decoded-resource metrics. */
export interface AssetMetrics {
  nodes: number;
  meshes: number;
  primitives: number;
  materials: number;
  images: number;
  textures: number;
  vertices: number;
  triangles: number;
  animations: number;
  animationChannels: number;
  clipDurationMs: number;
  decodedGeometryBytes: number;
  decodedImageBytes: number;
  /**
   * The axis-aligned box of the model's vertices in its own space
   * (metres, node transforms applied), recorded at import; absent for
   * versions imported before.
   */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** The original a converted asset version was made from. */
export type ConvertedFrom =
  | {
      format: 'fbx';
      sourceDigest: string;
      sourceByteLength: number;
      sourcePath?: string;
      converter: { name: 'blender'; version: string };
    }
  | {
      /**
       * A GLB converted at import: its images extracted into texture assets
       * (the model's `textures` names them; the stored GLB has a one-pixel
       * stand-in for each), and/or levels of detail generated (`lods`).
       */
      format: 'glb';
      sourceDigest: string;
      sourceByteLength: number;
      sourcePath?: string;
      converter: { name: 'texture-extract'; version: string };
      /**
       * The triangle shares levels 1… were generated at by the mesh
       * simplifier (the "generate LODs" import setting; absent: none were). A
       * re-import of the file generates them again.
       */
      lods?: number[];
    }
  | {
      /** A PNG, JPEG or WebP texture encoded to KTX2 at import. */
      format: 'png' | 'jpeg' | 'webp';
      sourceDigest: string;
      sourceByteLength: number;
      sourcePath?: string;
      converter: { name: 'ktx2-encoder'; version: string };
      /** color: ETC1S, sRGB; normal: UASTC, linear, normal-map mips; data: UASTC, linear. */
      encoding: 'color' | 'normal' | 'data';
    };

/** One channel of a packed texture: a channel of a texture asset's version, or a constant. */
export type PackedChannel = { assetId: string; digest: string; channel: 'r' | 'g' | 'b' | 'a' } | { value: number };

/**
 * A KTX2 texture (an array when it has several layers) packed at
 * import from texture assets, channel by channel: per layer its R, G, B and A
 * sources.
 */
export interface PackedFrom {
  layers: PackedChannel[][];
  converter: { name: 'ktx2-encoder'; version: string };
  encoding: 'color' | 'normal' | 'data';
  /**
   * Per layer: made from texels transcoded out of a lossy KTX2 and encoded
   * again (false: joined as stored, or encoded from a lossless image).
   * Absent on textures packed before KTX2 sources were taken.
   */
  reencoded?: boolean[];
}

export interface AssetVersion {
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
  /**
   * Optional: the bytes are a file in the game folder (a folder project's
   * marker folder), not a stored blob. A project-relative path with forward
   * slashes (see `isValidSourcePath`); `sourceDigest` still pins the bytes.
   */
  sourcePath?: string;
  /**
   * Optional: the GLB was converted at import from another format (FBX by
   * headless Blender). The GLB is this version's stored bytes; this records
   * the original — its digest and size, its path in the game folder when it
   * is referenced in place (else it is stored as a blob too) — and the
   * converter, so a changed original can be re-imported.
   */
  convertedFrom?: ConvertedFrom;
  /** A texture packed from texture assets (channel by channel, layer by layer). */
  packedFrom?: PackedFrom;
  importRecipe: ImportRecipe;
  metrics: AssetMetrics;
  importedAt: string;
  publishedRevision: number;
}

export interface AssetRecord {
  assetId: string;
  kind: 'model';
  displayName: string;
  currentVersion: number;
  versions: AssetVersion[];
}

// ---- prefabs and declared properties ------------------------------------

export type PropertyType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'enum'
  | 'vec3'
  | 'entityRef'
  | 'assetRef';

export interface PropertyBounds {
  min: Vec3;
  max: Vec3;
}

export interface DeclaredProperty {
  key: string;
  label: string;
  type: PropertyType;
  default: PropertyValue;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  values?: string[];
  bounds?: PropertyBounds;
  /**
   * Who may see and set the property. `public` (the default; the
   * canonical form omits it) is shown in the Inspector of every object
   * carrying the behavior and overridable per object; `private` is neither
   * shown nor overridable — the script always reads `default`.
   */
  visibility?: PropertyVisibility;
  /** The Inspector section the property is listed in (1–64 characters). */
  group?: string;
  /** A heading shown above the property in the Inspector (1–64 characters). */
  header?: string;
  /** The hover help of the property's field (1–256 characters). */
  tooltip?: string;
}

/** Declared-property visibility (Unity-like public/private). */
export type PropertyVisibility = 'public' | 'private';

export interface PropertyDeclaration {
  properties: DeclaredProperty[];
}

/**
 * Definition-entity component subset: transform, model, box, behavior;
 * in v4 content also the gameplay components a spawned or placed
 * copy carries too (`PREFAB_V4_COMPONENTS`).
 */
export interface PrefabComponentsV2 extends PrefabComponentsV4Extra {
  transform: TransformComponent;
  model?: ModelComponent;
  box?: BoxComponent;
  behavior?: BehaviorComponent;
}

/** The v4-only prefab components (same shapes as on a scene entity). */
export interface PrefabComponentsV4Extra {
  collider?: EntityComponentsV3['collider'];
  surface?: EntityComponentsV3['surface'];
  materials?: EntityComponentsV3['materials'];
  /** Overrides of graph-material parameters. */
  materialParams?: EntityComponentsV3['materialParams'];
  /** A visual effect played from the entity. */
  effect?: EntityComponentsV3['effect'];
  /** A copy writes its footprint into the block cells beneath it. */
  blockFootprint?: EntityComponentsV3['blockFootprint'];
  /** A copy's behavior group. */
  behaviorGroup?: EntityComponentsV3['behaviorGroup'];
  animator?: EntityComponentsV3['animator'];
  mover?: EntityComponentsV3['mover'];
  trigger?: EntityComponentsV3['trigger'];
  switch?: EntityComponentsV3['switch'];
  /** Generic health and primitives travel with a copy. */
  health?: EntityComponentsV3['health'];
  collectible?: EntityComponentsV3['collectible'];
  patrol?: EntityComponentsV3['patrol'];
  hitbox?: EntityComponentsV3['hitbox'];
  climbVolume?: EntityComponentsV3['climbVolume'];
  gravity?: EntityComponentsV3['gravity'];
  audioSource?: { assetId: string; volume: number; range: number; distanceModel?: 'linear' | 'inverse' | 'exponential'; refDistance?: number; rolloff?: number };
  faceMovement?: import('./blocks').FaceMovementComponent;
}

export interface PrefabEntity {
  localId: string;
  name?: string;
  parentLocalId?: string;
  components: PrefabComponentsV2;
}

export interface PrefabDefinition {
  prefabId: string;
  displayName: string;
  createdRevision: number;
  entityCount: number;
  depth: number;
  entities: PrefabEntity[];
}

// ---- behaviors and trust -------------------------------------------------

/** The prepared source record (only ever written by the preparation path). */
export interface BehaviorSourceRecord {
  sourceDigest: string;
  sourceByteLength: number;
  entryPath: string;
  fileCount: number;
  manifestDigest: string;
  outputDigest: string;
  outputByteLength: number;
  requiredModules: string[];
  /**
   * The transforms the script may write (entity ids, or "@self" =
   * each carrier's own), as its container declared them; stored only when
   * non-empty (older records stay byte-identical). Before, the record dropped
   * them, so Play and the export ran every script without its owners.
   */
  ownedTransforms?: string[];
  /**
   * `true` when the source declares its properties in code
   * (`export const properties = { … }` in src/index.ts) and the compiler
   * derived the record's declaration from it; absent otherwise (older
   * records stay byte-identical). Editors show such a declaration read-only.
   */
  declaredInCode?: true;
  /**
   * `'graph'` when the published source was generated from the
   * behavior's visual-script graph (`BehaviorRecord.graph`); absent for a
   * TypeScript source (older records stay byte-identical).
   */
  kind?: 'graph';
  /**
   * The script library versions (`@lib/<id>` imports, direct and
   * through other libraries) the output was compiled against, ascending by
   * libraryId; absent when the source imports none (older records stay
   * byte-identical).
   */
  libraries?: import('./script-libraries').BehaviorLibraryPin[];
  publishedRevision: number;
}

export interface BehaviorRecord {
  behaviorId: string;
  displayName: string;
  declaration: PropertyDeclaration;
  source: BehaviorSourceRecord | null;
  publishedRevision: number;
  /**
   * v4 content only: the visual script — a graph of kind
   * `behavior`, edited with `graphEdit {owner: {kind: "behavior", id}}`.
   * Present = the behavior is a visual script; publishing compiles it (the
   * published `source` then has `kind: 'graph'`). The game never reads it.
   */
  graph?: import('./graph').GraphData;
  /**
   * v4, visual scripts only: the script's functions — graphs
   * of kind `behavior-function`, edited with `graphEdit {owner: {kind:
   * "behavior", id: "<behaviorId>#<functionId>"}}` (a function exists while
   * its graph has nodes). Absent = none (sorted by id).
   */
  functions?: import('./behavior-graph').BehaviorFunctionRecord[];
}

export interface TrustEntry {
  sourceDigest: string;
  acknowledgedRevision: number;
}

export interface BehaviorTrust {
  entries: TrustEntry[];
}

// ---- settings ----------------------------------------------------

export type SettingsValue = number | boolean | string;
export type SettingsMap = Record<string, SettingsValue>;

/** The six-key gameplay settings registry value. */
export interface GameplaySettings {
  gravity_y: number;
  run_speed: number;
  jump_velocity: number;
  max_fall_speed: number;
  max_slope_climb_deg: number;
  min_slope_slide_deg: number;
  /** Engine settings, present only when the project sets them (absent: the engine default). */
  fixed_step_hz?: number;
  audio_voices?: number;
  music_fade_s?: number;
  animation_crossfade_s?: number;
  /** The renderer backend (0 WebGL legacy, 1 auto, 2 WebGPU, 3 WebGL 2; absent: 0). */
  render_backend?: number;
  /** Where the simulation runs in Play and the export (1 a worker, 2 the page's main thread; absent: 1). */
  sim_thread?: number;
  /** The texture budget of Play and the export in MiB (absent: `TEXTURE_BUDGET_DEFAULT_MB`). */
  texture_budget_mb?: number;
  /** The most frames per second Play and the export draw (30, 60, 120; absent or 0: none, the display's rate). */
  frame_rate_cap?: number;
  /** The kind of ambient occlusion where a look turns it on (0 off, 1 SSAO, 2 GTAO; absent: SSAO). */
  ambient_occlusion?: number;
  /** The share of the screen's resolution Play and the export draw at (0.5–1; absent: 1). */
  render_scale?: number;
  /** Whether the render scale drops while the GPU runs over budget (0 off, 1 on; absent: off). */
  dynamic_resolution?: number;
  /** The memory streamed terrain tiles and block chunks may take in Play and the export, MiB (absent: `STREAMING_BUDGET_DEFAULT_MB`). */
  streaming_budget_mb?: number;
}

// ---- content block and captured view ---------------------------------

export interface ContentCatalog {
  assets: AssetRecord[];
  prefabs: PrefabDefinition[];
  behaviors: BehaviorRecord[];
  settings: SettingsMap;
  behaviorTrust: BehaviorTrust;
}

export interface CapturedAsset {
  assetId: string;
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
  importRecipe: ImportRecipe;
}

export interface CapturedContent {
  contentVersion: 1;
  projectId: string;
  revision: number;
  assets: CapturedAsset[];
  contentDigest: string;
}

/** Re-exported base shapes used by the v2 signatures. */
export type { BoxComponent, CameraComponent, Quat, TransformComponent, Vec3 };
