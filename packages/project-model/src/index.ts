/**
 * @thirdlight/project-model — public surface (dependencies.md §3;
 * project-model.md §12.1): types, parse*, validate*, normalize*,
 * serializeCanonical, ERROR_CODES, KNOWN_VERSIONS.
 *
 * Only storage v4 projects load (`validateProjectV4`); a v3 project is read
 * (`validateEnvelopeV3`/`validateProjectV3`) and upgraded on open
 * (`migrateProjectV3ToV4`). The v1/v2 (M1/M2) scene models were removed in
 * phase 9.3; their component rules live on in `components.ts`. Strict byte
 * parsing with duplicate-key rejection, total value validation,
 * normalization to the §12.2 canonical form and canonical byte
 * serialization are unchanged.
 *
 * Pure data and logic: no I/O, no three.js, no Node built-ins — the leaf
 * unit of the node-side graph (dependencies.md §4.1). All entry points are
 * pure and total: same input → same result; malformed data yields error
 * results, never thrown exceptions.
 */

export {
  ERROR_CODES,
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
  Manifest,
  Quat,
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
  ControllerCapsule,
  ControllerComponent,
  DeclaredProperty,
  EntityComponentsV2,
  GameplaySettings,
  ImportRecipe,
  ModelAssetRef,
  ModelComponent,
  PrefabComponentsV2,
  PrefabDefinition,
  PrefabEntity,
  PrefabProvenanceComponent,
  PrefabComponentsV4Extra,
  PropertyBounds,
  PropertyDeclaration,
  PropertyType,
  PropertyValue,
  PropertyVisibility,
  SettingsMap,
  SettingsValue,
  TrustEntry,
} from './types-v2';

// Phase 14.0: the character capsule (default, limits, resolved form).
export { CAPSULE_LIMITS, CONTROLLER_FIELDS, CONTROLLER_TUNING_FIELDS, CONTROLLER_TUNING_LIMITS, DEFAULT_CONTROLLER_CAPSULE, DEFAULT_CONTROLLER_TUNING, controllerCapsuleOf, controllerTuningOf } from './components';
export { parseDocumentBytes, type ByteParse } from './parse-bytes';
export { parseEnvelopeV3, parseManifest, parseSceneV3 } from './parse-api';

export { validateManifest, normalizeManifest } from './validate';

export {
  M2_SETTINGS_KEYS,
  AUDIO_VOICE_CAP,
  MAX_SOURCE_PATH_LENGTH,
  MAX_CONVERTED_SOURCE_BYTES,
  M2_GLTF_EXTENSION_ALLOWLIST,
  isValidSourcePath,
  normalizeContentV3,
  resolveGameplaySettings,
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
  // Phase 15.3: the follow camera's tuning defaults and ranges.
  CAMERA_FOLLOW_DEFAULTS,
  CAMERA_FOLLOW_LIMITS,
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
  type PlayerSpawnFacing,
  PLAYER_SPAWN_FACINGS,
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
  normalizeEnvelopeV3,
  validateEnvelopeV3,
  validateProjectV3,
  type EnvelopeV3Load,
} from './project-v3';

export { captureContent, collectAssetRefsV3 } from './capture';

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
export { validateContentV4, canonicalGame, MAX_SCENES, GAME_TIMING_DEFAULTS, GAME_TIMING_FIELDS, GAME_TIMING_LIMITS } from './content';
// Phase 14.1: prefabs spawned into a running game (the snapshot/manifest carry them).
export { PREFAB_V4_COMPONENTS, canonicalPrefabs, validatePrefabDefinitions } from './content';
export {
  GAME_ZONE_ROLES_V4,
  INSTANCE_FLOATS,
  MAX_INSTANCES,
  type ContentCatalogV4,
  type SceneIndexEntry,
  type InstancesComponent,
  type SceneV4,
} from './types-v3';
// Phase 9.9: gameplay building blocks.
export {
  BLOCK_COMPONENT_NAMES,
  BLOCK_COMPONENTS,
  // Phase 15.3: the blocks' tuning defaults and ranges, the defeat effects.
  BLOCK_DEFAULTS,
  BLOCK_TUNING_LIMITS,
  DEFEAT_EFFECTS,
  ENEMY_PATROLS,
  MOVER_MODES,
  PICKUP_KINDS,
  SWITCH_MODES,
  // Phase 14.2: trigger shapes and modes.
  TRIGGER_MODES,
  TRIGGER_RADIUS,
  TRIGGER_SHAPES,
  type BlockComponentName,
  type EnemyComponent,
  type AudioSourceComponent,
  type FaceMovementComponent,
  type HealthComponent,
  type MoverComponent,
  type PickupComponent,
  type SwitchComponent,
  type TriggerComponent,
} from './blocks';
// Phase 9.10: game flow.
export {
  canonicalFlow,
  flowAssetRefs,
  HUD_PRESETS,
  MAX_FLOW_LEVELS,
  MAX_LEVEL_AMBIENCE,
  MAX_SCORE_COUNTERS,
  MAX_TITLE_PAN_DISTANCE,
  MENU_SOUND_KINDS,
  MAX_SCORE_POINTS,
  UI_FONTS,
  validateFlow,
  type FlowLevel,
  type FlowScore,
  type GameFlow,
  type MenuSounds,
  type TitlePan,
} from './flow';
// Phase 16.1: the generic node-graph model and the registered graph kinds.
export {
  applyGraphOps,
  canonicalGraphData,
  canonicalGraphDocuments,
  findCycle,
  GRAPH_AUTO_TYPE,
  GRAPH_ITEM_ID_RE,
  graphAssetRefs,
  graphDocumentsContext,
  graphInterface,
  resolveGraphPorts,
  staticNodePorts,
  GRAPH_LIMITS,
  GRAPH_OP_NAMES,
  MAX_GRAPH_DOCUMENTS,
  nodeDef,
  nodeFieldValue,
  nodePorts,
  portCompatibility,
  validateGraphData,
  validateGraphDocument,
  validateGraphDocuments,
  validateGraphOps,
  wouldCycle,
  type GraphComment,
  type GraphContext,
  type GraphConversion,
  type GraphInterfaceDef,
  type GraphNodePorts,
  type GraphPortTypeRule,
  type GraphData,
  type GraphDocument,
  type GraphEdge,
  type GraphFieldDef,
  type GraphGroup,
  type GraphKindDef,
  type GraphNode,
  type GraphNodeDef,
  type GraphOp,
  type GraphOpsResult,
  type GraphPoint,
  type GraphPortDef,
  type GraphPortRef,
  type GraphPortType,
  type GraphValue,
} from './graph';
export { ANIMATOR_BLEND_GRAPH_KIND, ANIMATOR_GRAPH_KIND, ANIMATOR_LAYER_GRAPH_KIND, GRAPH_KINDS, TEST_GRAPH_KIND } from './graph-kinds';
// Phase 19.0/19.1: visual scripts (the `behavior` graph kinds, their node catalogue and compile checks).
export {
  BEHAVIOR_API_NODES,
  BEHAVIOR_DATA_TYPES,
  BEHAVIOR_FUNCTION_GRAPH_KIND,
  BEHAVIOR_FUNCTION_ID_RE,
  BEHAVIOR_FUNCTION_KIND,
  BEHAVIOR_GRAPH_KIND,
  BEHAVIOR_GRAPH_LIMITS,
  BEHAVIOR_LIBRARY_GRAPH_KIND,
  BEHAVIOR_LIBRARY_KIND,
  BEHAVIOR_VALUE_TYPES,
  BEHAVIOR_VARIABLE_KINDS,
  BEHAVIOR_VARIABLE_NAME_RE,
  DATA_TYPE_DEFAULT,
  REQUIRED_CORE_FIELDS,
  VARIABLE_PORT_TYPE,
  VARIABLE_PROPERTY_TYPE,
  axesOptions,
  behaviorApiSpec,
  behaviorFunctionInterface,
  behaviorGraphContext,
  behaviorGraphDeclaration,
  behaviorNodePhases,
  behaviorOwnedTransforms,
  behaviorScriptGraphs,
  calleeScope,
  checkBehaviorGraph,
  enumOptions,
  eventPhase,
  isVariableAccess,
  parseVariableValue,
  scopedNodeId,
  variableLabel,
  variableNodesOf,
  variableProperty,
  variableTypeOf,
  variableVisibility,
  type BehaviorFunctionRecord,
  type BehaviorGraphProblem,
  type BehaviorScriptEnv,
  type BehaviorScriptGraph,
  type BehaviorValueType,
  type BehaviorVariableKind,
} from './behavior-graph';
export { BEHAVIOR_API_SKIPPED } from './behavior-api.generated';
export type { BehaviorApiArg, BehaviorApiNodeSpec, BehaviorApiOutput, BehaviorApiStep, BehaviorApiValue, BehaviorDataType } from './behavior-api';
// Phase 18.1: the material node catalogue (material graphs and material functions).
export { MATERIAL_BUILTIN_SOURCES, MATERIAL_FUNCTION_GRAPH_KIND, MATERIAL_GRAPH_KIND, MATERIAL_PARAMETER_TYPES, MATERIAL_VALUE_TYPES, type MaterialParameterType } from './material-graph-kinds';
// Phase 16.2: an animator controller's layers and blend trees as graphs (owner kind `animator`).
export { animatorGraphOf, animatorTransitionPairs, applyAnimatorGraph, parseAnimatorOwnerId, type AnimatorGraphWrite, type AnimatorOwnerTarget } from './animator-graph';
// Phase 9.8: input actions.
export {
  canonicalInput,
  DEFAULT_INPUT,
  INPUT_ACTION_TYPES,
  MAX_INPUT_ACTIONS,
  validateInput,
  type InputAction,
  type InputActionType,
  type InputBinding,
  type InputConfig,
} from './input';
// Phase 14.6: the old modelAnimation profile becomes an animator controller on open.
export { glbClipDurations, LEGACY_CROSSFADE_SECONDS, LEGACY_RUN_SPEED_EPS, migrateModelAnimations, type ClipDurationOf, type ModelAnimationMigration } from './animator-migrate';
// Phase 9.7: animator controllers.
export {
  ANIMATOR_CONDITION_OPS,
  ANIMATOR_PARAMETER_TYPES,
  ANIMATOR_RESERVED_GRAPH_ID_RE,
  animatorAssetIds,
  animatorsForRuntime,
  animatorStates,
  canonicalAnimatorController,
  canonicalAnimators,
  MAX_ANIMATORS,
  MAX_ANIMATOR_LAYERS,
  MAX_LAYER_MASK,
  validateAnimatorComponent,
  validateAnimatorController,
  validateAnimators,
  type AnimatorClipRef,
  type AnimatorComponent,
  type AnimatorCondition,
  type AnimatorConditionOp,
  type AnimatorController,
  type AnimatorEvent,
  type AnimatorLayer,
  type AnimatorLayout,
  type AnimatorMotion,
  type AnimatorParameter,
  type AnimatorParameterType,
  type AnimatorState,
  type AnimatorTransition,
} from './animator';
// Phase 9.6: baked lighting.
export {
  canonicalLighting,
  LIGHTMAP_SOURCES,
  MAX_LIGHTMAP_ATLASES,
  MAX_LIGHTMAP_ENTRIES,
  MAX_BAKED_LIGHTS,
  validateLighting,
  validateLightingBake,
  type LightingBake,
  type LightingEntry,
  type LightingMap,
} from './lighting';
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
  // Phase 18.0: graph materials (exposed parameters, the graph, the runtime view).
  canonicalMaterialParameters,
  MATERIAL_PARAMETER_KEY_RE,
  materialGraphContext,
  materialParameterPortType,
  materialParameterValueError,
  materialsForRuntime,
  MAX_MATERIAL_PARAMETERS,
  validateMaterialGraph,
  validateMaterialParameters,
  canonicalMaterialParams,
  materialOverrideErrors,
  validateMaterialParamsComponent,
  type MaterialParamsComponent,
  type MaterialParameter,
  type MaterialParameterValue,
  MAX_MATERIALS,
  MAX_MATERIAL_SLOTS,
  validateEnvironment,
  validateMaterialMapping,
  validateMaterials,
  validateFogVolumeComponent,
  MAX_FOG_VOLUMES,
  canonicalLevelEnvironment,
  environmentTextureRefs,
  validateLevelEnvironment,
  type LevelEnvironment,
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

// Phase 15.0: the component and content descriptor registry (pure data).
export {
  ASSET_KINDS,
  DESCRIPTORS,
  HANDLE_KINDS,
  HANDLE_ROLES,
  type AssetRefFieldDescriptor,
  type BoolFieldDescriptor,
  type ColorFieldDescriptor,
  type ComponentAdd,
  type ComponentDescriptor,
  type ComponentRelation,
  type ComponentsFieldDescriptor,
  type ContentBlockDescriptor,
  type DescriptorAssetKind,
  type DescriptorJson,
  type DescriptorRefTarget,
  type DescriptorRegistry,
  type DescriptorScalar,
  type DescriptorStringFormat,
  type DescriptorUnit,
  type EntityRefFieldDescriptor,
  type EnumFieldDescriptor,
  type EnumOption,
  type FieldCondition,
  type FieldDescriptor,
  type FieldType,
  type HandleDescriptor,
  type HandleKind,
  type IntFieldDescriptor,
  type JsonFieldDescriptor,
  type ListFieldDescriptor,
  type MapFieldDescriptor,
  type NumberFieldDescriptor,
  type ObjectFieldDescriptor,
  type QuatFieldDescriptor,
  type RefFieldDescriptor,
  type SceneRefFieldDescriptor,
  type SignalFieldDescriptor,
  type StringFieldDescriptor,
  type VecFieldDescriptor,
} from './descriptors';
