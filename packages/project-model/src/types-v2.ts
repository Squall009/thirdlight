/**
 * Explicitly versioned M2 logical types — project-model.md §§18–22
 * (schemaVersion 2 scene, content catalog, prefabs, declared properties,
 * physics components, behavior records and trust, captured content view).
 *
 * The M1 types in `types.ts` are unchanged. These describe the STRICT
 * canonical output of the v2 normalizers (§12.2): defaults filled, fixed key
 * order, only present fields emitted. Inputs to the entry points are
 * `unknown`; the boundary re-checks every rule.
 */

import type {
  BoxComponent,
  CameraComponent,
  Quat,
  TransformComponent,
  Vec3,
} from './types';

// ---- scene schemaVersion 2 (§10.5–§10.8, §21) --------------------------------

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
}

/** §10.8/§21.1 marker component: no fields in M2. */
export type ControllerComponent = Record<string, never>;

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

export interface EntityV2 {
  id: string;
  name?: string;
  parentId?: string;
  components: EntityComponentsV2;
}

export interface SceneV2 {
  schemaVersion: 2;
  sceneId: string;
  revision: number;
  entities: EntityV2[];
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

/** Definition-entity component subset (§20.2): transform, model, box, behavior only. */
export interface PrefabComponentsV2 {
  transform: TransformComponent;
  model?: ModelComponent;
  box?: BoxComponent;
  behavior?: BehaviorComponent;
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
