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
 * §10.8/§21.1 the player controller. Its only field is the optional capsule
 * (phase 14.0, v4); absent = `DEFAULT_CONTROLLER_CAPSULE`.
 */
export interface ControllerComponent {
  capsule?: ControllerCapsule;
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
}

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
  publishedRevision: number;
}

export interface BehaviorRecord {
  behaviorId: string;
  displayName: string;
  declaration: PropertyDeclaration;
  source: BehaviorSourceRecord | null;
  publishedRevision: number;
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
