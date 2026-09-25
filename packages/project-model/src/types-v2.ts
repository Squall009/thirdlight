/**
 * Logical types introduced by the M2 model — project-model.md §§18–22
 * (components, content catalog, prefabs, declared properties, physics
 * components, behavior records and trust, captured content view). The v3/v4
 * types (`types-v3.ts`) are built from these; the schemaVersion 2 scene and
 * entity types themselves were removed in phase 9.3.
 *
 * These describe the STRICT canonical output of the normalizers (§12.2):
 * defaults filled, fixed key order, only present fields emitted. Inputs to
 * the entry points are `unknown`; the boundary re-checks every rule.
 */

import type {
  BoxComponent,
  CameraComponent,
  Quat,
  TransformComponent,
  Vec3,
} from './types';
import type { EntityComponentsV3 } from './types-v3';

// ---- components (§10.5–§10.8, §21) ------------------------------------------

/** `components.model` (§18.1): a whole-GLB reference by stable opaque id. */
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
}

/** Seven-type property value vocabulary (§20.5). */
export type PropertyValue =
  | number
  | boolean
  | string
  | [number, number, number]
  | null;

/** `components.behavior` (§10.5): values keyed by the resolved declaration. */
export interface BehaviorComponent {
  behaviorId: string;
  values: Record<string, PropertyValue>;
}

/** `components.prefab` (§10.6): informational provenance, never inheritance. */
export interface PrefabProvenanceComponent {
  prefabId: string;
  localId: string;
}

export interface ColliderBoxShape {
  type: 'box';
  hx: number;
  hy: number;
}

export interface ColliderPolygonShape {
  type: 'polygon';
  vertices: [number, number][];
}

/** §21.1/§21.3 collider shape vocabulary. */
export type ColliderShape = ColliderBoxShape | ColliderPolygonShape;

export interface ColliderComponent {
  shape: ColliderShape;
  /** Phase 9.9, v4 only: the character passes from below and the sides, lands from above. */
  oneWay?: true;
}

/**
 * Phase 14.0 (v4 scenes): the player character's collision capsule. `height`
 * is the total height (end caps included, >= 2 x radius); `offset` places the
 * capsule's centre relative to the entity origin (default [0, 0]).
 */
export interface ControllerCapsule {
  radius: number;
  height: number;
  offset?: [number, number];
}

/**
 * §10.8/§21.1 the player controller: the optional capsule (phase 14.0, v4;
 * absent = `DEFAULT_CONTROLLER_CAPSULE`) and, phase 15.3 (v4), the optional
 * movement tuning (absent = `DEFAULT_CONTROLLER_TUNING`, the values every
 * project played with before they became data).
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

// ---- content catalog (§18) ----------------------------------------------------

/** §18.5 import recipe (recorded per version; part of the derived-cache key). */
export interface ImportRecipe {
  profile: 'gltf-glb';
  recipeVersion: 1;
  toolchain: Record<string, string>;
  extensions: string[];
}

/** §18.6 bounded decoded-resource metrics. */
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
   * Phase 15.3: the axis-aligned box of the model's vertices in its own space
   * (metres, node transforms applied), recorded at import; absent for
   * versions imported before.
   */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** The original a converted asset version was made from. */
export interface ConvertedFrom {
  format: 'fbx';
  sourceDigest: string;
  sourceByteLength: number;
  sourcePath?: string;
  converter: { name: 'blender'; version: string };
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

// ---- prefabs and declared properties (§20) ------------------------------------

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
   * Phase 15.4: who may see and set the property. `public` (the default; the
   * canonical form omits it) is shown in the Inspector of every object
   * carrying the behavior and overridable per object; `private` is neither
   * shown nor overridable — the script always reads `default`.
   */
  visibility?: PropertyVisibility;
  /** Phase 15.4: the Inspector section the property is listed in (1–64 characters). */
  group?: string;
  /** Phase 15.4: a heading shown above the property in the Inspector (1–64 characters). */
  header?: string;
  /** Phase 15.4: the hover help of the property's field (1–256 characters). */
  tooltip?: string;
}

/** Phase 15.4: declared-property visibility (Unity-like public/private). */
export type PropertyVisibility = 'public' | 'private';

export interface PropertyDeclaration {
  properties: DeclaredProperty[];
}

/**
 * Definition-entity component subset (§20.2): transform, model, box, behavior;
 * phase 14.1 (v4 content only): the gameplay components a spawned or placed
 * copy carries too (`PREFAB_V4_COMPONENTS`).
 */
export interface PrefabComponentsV2 extends PrefabComponentsV4Extra {
  transform: TransformComponent;
  model?: ModelComponent;
  box?: BoxComponent;
  behavior?: BehaviorComponent;
}

/** Phase 14.1: the v4-only prefab components (same shapes as on a scene entity). */
export interface PrefabComponentsV4Extra {
  collider?: EntityComponentsV3['collider'];
  surface?: EntityComponentsV3['surface'];
  materials?: EntityComponentsV3['materials'];
  /** Phase 18.0: overrides of graph-material parameters. */
  materialParams?: EntityComponentsV3['materialParams'];
  /** Phase 20.0: a visual effect played from the entity. */
  effect?: EntityComponentsV3['effect'];
  animator?: EntityComponentsV3['animator'];
  mover?: EntityComponentsV3['mover'];
  trigger?: EntityComponentsV3['trigger'];
  switch?: EntityComponentsV3['switch'];
  pickup?: EntityComponentsV3['pickup'];
  enemy?: EntityComponentsV3['enemy'];
  audioSource?: { assetId: string; volume: number; range: number };
  faceMovement?: { yawRight: number; yawLeft: number; turnSeconds?: number };
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

// ---- behaviors and trust (§22) -------------------------------------------------

/** §22.2 prepared source record (only ever written by the preparation path). */
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
   * Phase 14.1: the transforms the script may write (entity ids, or "@self" =
   * each carrier's own), as its container declared them; stored only when
   * non-empty (older records stay byte-identical). Before, the record dropped
   * them, so Play and the export ran every script without its owners.
   */
  ownedTransforms?: string[];
  /**
   * Phase 15.4: `true` when the source declares its properties in code
   * (`export const properties = { … }` in src/index.ts) and the compiler
   * derived the record's declaration from it; absent otherwise (older
   * records stay byte-identical). Editors show such a declaration read-only.
   */
  declaredInCode?: true;
  /**
   * Phase 19.0: `'graph'` when the published source was generated from the
   * behavior's visual-script graph (`BehaviorRecord.graph`); absent for a
   * TypeScript source (older records stay byte-identical).
   */
  kind?: 'graph';
  publishedRevision: number;
}

export interface BehaviorRecord {
  behaviorId: string;
  displayName: string;
  declaration: PropertyDeclaration;
  source: BehaviorSourceRecord | null;
  publishedRevision: number;
  /**
   * Phase 19.0 (v4 content only): the visual script — a graph of kind
   * `behavior`, edited with `graphEdit {owner: {kind: "behavior", id}}`.
   * Present = the behavior is a visual script; publishing compiles it (the
   * published `source` then has `kind: 'graph'`). The game never reads it.
   */
  graph?: import('./graph').GraphData;
  /**
   * Phase 19.1 (v4, visual scripts only): the script's functions — graphs
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

// ---- settings (§20.9/§21.4) ----------------------------------------------------

export type SettingsValue = number | boolean | string;
export type SettingsMap = Record<string, SettingsValue>;

/** The six-key M2 gameplay settings registry value (§21.4/§21.5). */
export interface GameplaySettings {
  gravity_y: number;
  run_speed: number;
  jump_velocity: number;
  max_fall_speed: number;
  max_slope_climb_deg: number;
  min_slope_slide_deg: number;
  /** Phase 15.3: engine settings, present only when the project sets them (absent: the engine default). */
  fixed_step_hz?: number;
  audio_voices?: number;
  music_fade_s?: number;
  animation_crossfade_s?: number;
  /** Phase 17.1: the renderer backend (0 WebGL legacy, 1 auto, 2 WebGPU, 3 WebGL 2; absent: 0). */
  render_backend?: number;
}

// ---- content block and captured view (§18/§19) ---------------------------------

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

/** Re-exported M1 shapes used by the v2 signatures. */
export type { BoxComponent, CameraComponent, Quat, TransformComponent, Vec3 };
