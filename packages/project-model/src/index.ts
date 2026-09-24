/**
 * @thirdlight/project-model — public surface (dependencies.md §3;
 * project-model.md §12.1): types, parse*, validate*, normalize*, migrate*,
 * serializeCanonical, ERROR_CODES, KNOWN_VERSIONS, plus the packet-20 M2
 * versioned entry points (v2 scene, content, three-block composition,
 * captured content, settings resolution and the pure M1→M2 conversion).
 *
 * The M1 schemaVersion 1 model (docs/contracts/project-model.md §7–§10) is
 * unchanged: strict byte parsing with duplicate-key rejection, total value
 * validation, normalization to the §12.2 canonical form, canonical byte
 * serialization, and the M1 migration entry points. The M2 logical types and
 * validators (§§18–22) are explicitly versioned so existing consumers keep
 * their M1 entry points.
 *
 * Pure data and logic: no I/O, no three.js, no Node built-ins — the leaf
 * unit of the node-side graph (dependencies.md §4.1). All entry points are
 * pure and total: same input → same result; malformed data yields error
 * results, never thrown exceptions.
 */

export {
  ERROR_CODES,
  INTERCHANGE_SCENE_VERSIONS,
  KNOWN_VERSIONS,
  SCHEMA_VERSIONS_BY_DOCUMENT,
  type EnvelopeV3Error,
  type EnvelopeV3ErrorCode,
  type ErrorCode,
  type LimitName,
  type ModelError,
  type ModelErrorV2,
  type ModelErrorV3,
  type ModelResult,
  type ModelResultV2,
  type ModelResultV3,
  type SerializeResult,
} from './errors';

export type {
  BoxComponent,
  BoxMaterial,
  CameraComponent,
  Entity,
  EntityComponents,
  Manifest,
  Quat,
  Scene,
  SceneRef,
  TransformComponent,
  Vec3,
} from './types';

export type {
  AssetMetrics,
  AssetRecord,
  AssetVersion,
  ConvertedFrom,
  BehaviorComponent,
  BehaviorRecord,
  BehaviorSourceRecord,
  BehaviorTrust,
  CapturedAsset,
  CapturedContent,
  ColliderBoxShape,
  ColliderComponent,
  ColliderPolygonShape,
  ColliderShape,
  ContentCatalog,
  ControllerComponent,
  DeclaredProperty,
  EntityComponentsV2,
  EntityV2,
  GameplaySettings,
  ImportRecipe,
  ModelAssetRef,
  ModelComponent,
  PrefabComponentsV2,
  PrefabDefinition,
  PrefabEntity,
  PrefabProvenanceComponent,
  PropertyBounds,
  PropertyDeclaration,
  PropertyType,
  PropertyValue,
  SceneV2,
  SettingsMap,
  SettingsValue,
  TrustEntry,
} from './types-v2';

export { parseDocumentBytes, type ByteParse } from './parse-bytes';
export {
  parseEnvelopeV3,
  parseManifest,
  parseScene,
  parseSceneV2,
  parseSceneV3,
} from './parse-api';

export {
  validateManifest,
  validateProject,
  validateScene,
  normalizeManifest,
  normalizeScene,
} from './validate';

export {
  normalizeSceneV2,
  validateSceneV2,
} from './scene-v2';

export {
  M2_SETTINGS_KEYS,
  MAX_SOURCE_PATH_LENGTH,
  MAX_CONVERTED_SOURCE_BYTES,
  M2_GLTF_EXTENSION_ALLOWLIST,
  isValidSourcePath,
  normalizeContent,
  normalizeContentV3,
  resolveGameplaySettings,
  validateContent,
  validateContentV3,
  validateGameConfig,
  validateTagRegistry,
  TAG_NAME_RE,
  type SettingsKeySpec,
} from './content';

// Packet 44: the explicit v3 model surface (project-model.md §23;
// workspace.md §16.9): the versioned scene/content entry points, the v3
// registry/limits/preset constants and the v3 types. The additive
// component-level validators and `validateGameConfig` are recorded in the
// packet-44 handoff (CC-44-1).
export {
  normalizeSceneV3,
  validateActivationAppearance,
  validateCameraFollowComponent,
  validateGameZoneComponent,
  validateLightComponent,
  validateModelAnimationComponent,
  validatePlayerSpawnComponent,
  validateSceneV3,
  validateSurfaceComponent,
} from './scene-v3';
export {
  AUDIO_PCM_WAV_PROFILE,
  GAME_ZONE_LIMITS,
  GAME_ZONE_ROLES,
  SURFACE_PRESETS,
  V3_REGISTRY,
  isFolderEntity,
  MAX_TAGS,
  type TagDefinition,
  type EntityFlagsV3,
  type FolderComponent,
  type FolderEntityV3,
  type ResolvedSceneV3,
  type SceneEntityV3,
  type AnimationRoleBinding,
  type AssetKind,
  type AssetMetricsV3,
  type AssetRecordV3,
  type AssetVersionV3,
  type AuthoringEnvelopeV3,
  type CameraFollowComponent,
  type CheckpointActivationAppearance,
  type ComponentV3,
  type ContentCatalogV3,
  type CueRef,
  type EntityComponentsV3,
  type EntityV3,
  type GameConfig,
  type GameZoneComponent,
  type GameZoneRole,
  type GltfGlbRecipeV3,
  type ImportRecipeV3,
  type LightComponent,
  type ModelAnimationComponent,
  type PcmWavMetrics,
  type PcmWavRecipe,
  type PlayerSpawnComponent,
  type SceneV3,
  type SurfaceComponent,
} from './types-v3';
export {
  effectiveEntityFlags,
  nearestObjectAncestor,
  resolveSceneHierarchy,
  type EffectiveEntityFlags,
} from './hierarchy-v3';
export {
  migrateSceneV3,
  normalizeEnvelopeV3,
  validateEnvelopeV3,
  validateProjectV3,
  type EnvelopeV3Load,
} from './project-v3';

export { captureContent, collectAssetRefsV3 } from './capture';
export { validateProjectV2 } from './project-v2';

// Packet 36: the pure runtime-content manifest capture (sessions.md §17.1.1)
// plus the canonical/digest helpers the export closure needs. Additive public
// surface recorded as contract-change request C36-2 (docs/handoffs/36.md).
export {
  BUILD_OPTIONS_RECORD,
  MANIFEST_KEYS,
  M2_ENGINE_PINS,
  M2_KNOWN_MODULE_IDS,
  M2_MODULE_PACKAGES,
  RUNTIME_CONTENT_MANIFEST_MAX_BYTES,
  RUNTIME_CONTENT_MANIFEST_VERSION,
  RUNTIME_CONTENT_TYPE,
  buildOptionsRecordBytes,
  captureManifest,
  capturedViewDigest,
  digestBytes,
  digestEmittedClosure,
  manifestBuildIdInput,
  recipeDigestOf,
  requiredModuleIds,
  versionFactsDigest,
  type CaptureManifestInput,
  type CaptureManifestResult,
  type EmittedArtifactDigest,
  type ManifestAssetInput,
  type ManifestBehaviorInput,
  type ManifestError,
  type RuntimeContentManifest,
} from './manifest';
export { canonicalJsonText, sha256Hex, sha256HexOfText,
  sha256HexAsync, sha256Hex as sha256HexBytes } from './sha256';

// Packet 58: the pure manifest v2 derivation (delivery.md §2, sessions.md §17.1.1)
// — the M3 immutable runtime-content identity, the captured v3 content view, the
// media identity and the strict v2 reader + version-compat rule. Additive public
// surface (reopens the packet-44-owned project-model manifest-derivation section,
// plan-review PR-2; recorded in docs/handoffs/58.md).
export {
  blockDigest,
  captureContentViewV3,
  captureManifestV2,
  CUE_SLOTS,
  M3_ENGINE_PINS,
  M3_KNOWN_MODULE_IDS,
  M3_MODULE_PACKAGES,
  M3_RECIPE_VERSIONS,
  M3_SETTINGS_KEYS,
  MANIFEST_KEYS_V2,
  type ManifestSceneRow,
  manifestBuildIdInputV2,
  manifestVersionCompat,
  mediaProfileDigest,
  resolveMediaIdentityV3,
  RUNTIME_CONTENT_MANIFEST_VERSION_2,
  validateManifestV2,
  type CapturedAssetV3,
  type CapturedContentViewV3,
  type CaptureManifestV2Input,
  type CaptureManifestV2Result,
  type CueSlot,
  type ManifestAssetInputV2,
  type ManifestErrorV2,
  type MediaAnimationRow,
  type MediaBlock,
  type MediaCueRef,
  type RuntimeContentManifestV2,
  type ValidateManifestV2Options,
  type ValidateManifestV2Result,
} from './manifest-v2';

export { serializeCanonical } from './normalize';

export { migrateManifest, migrateScene, migrateSceneV1ToV2 } from './migrate';

// The engine module registry + the declared-dependency resolver (D17).
export {
  BEHAVIOR_PACKAGE_MODULES,
  ENGINE_MODULES,
  ENGINE_MODULE_IDS,
  resolveRequiredModules,
  type EngineModule,
  type ResolveModulesInput,
  type ResolveModulesResult,
  type UnresolvedModule,
} from './modules';

// Phase 12 (c): v4 projects — several scenes, one file each.
export {
  composeV4,
  composeSceneV4,
  migrateProjectV3ToV4,
  validateManifestV2Project,
  validateProjectV4,
  MIGRATED_SCENE_NAME,
  type MigrationV4Result,
  type ProjectManifestV2,
  type ProjectV4,
} from './project-v4';
export { validateSceneV4, validateMergedSceneV4, validateInstancesComponent, MAX_ENTITIES_V4, MAX_EXIT_SCENES, V4_REGISTRY } from './scene-v3';
export { validateContentV4, canonicalGame, MAX_SCENES } from './content';
export {
  GAME_ZONE_ROLES_V4,
  INSTANCE_FLOATS,
  MAX_INSTANCES,
  type ContentCatalogV4,
  type SceneIndexEntry,
  type InstancesComponent,
  type SceneV4,
} from './types-v3';
// Phase 9.4: materials, material mappings and the environment (wind).
export {
  canonicalEnvironment,
  canonicalMaterialMapping,
  canonicalMaterials,
  DEFAULT_WIND,
  MATERIAL_PARAMS,
  MATERIAL_SHADERS,
  MATERIAL_SLOT_ALL,
  MATERIAL_TEXTURE_SLOTS,
  materialParamError,
  MAX_MATERIALS,
  MAX_MATERIAL_SLOTS,
  validateEnvironment,
  validateMaterialMapping,
  validateMaterials,
  validateFogVolumeComponent,
  MAX_FOG_VOLUMES,
  type EnvironmentConfig,
  type FogConfig,
  type FogVolumeComponent,
  type PostConfig,
  type SkyConfig,
  type MaterialDef,
  type MaterialParamType,
  type MaterialParamValue,
  type MaterialShader,
  type WindConfig,
} from './materials';
