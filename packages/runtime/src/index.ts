/**
 * @thirdlight/runtime — public surface: `instantiateRuntime`,
 * `createSimulationRegistry`, `registerSimulationModule`, `BUILTIN_MODULES`,
 * types (snapshot, diagnostics, module interfaces), `ERROR_CODES`,
 * `ActionFrame`, `JumpPhase`, `ActionSource`, `createRecordedActionSource`,
 * `SimulationPhase`, `StepContext`, `GameplaySettings`, `PhysicsPort`,
 * `PhysicsStepClient`; `PhysicsResetPort`, `ModuleResetContext` and
 * `SIMULATION_PHASE_ORDER`.
 *
 * The play/runtime core (docs/contracts/runtime.md) with the module-set
 * lifecycle:
 *
 * - the runtime snapshot input (strict, re-validated, deep-frozen; v3 and
 *   v4 scenes);
 * - the instantiate/start/stop/dispose lifecycle with a single frame-driver
 *   owner, the `failed` state and fail-stop (no rollback, fresh restart only);
 * - the separate mutable simulation state and the phase-scoped write guard;
 * - fixed-step scheduling with bounded catch-up (120 Hz, MAX_CATCHUP_SECONDS
 *   0.1 of game time per frame, drop-and-resync) and the 12-step settle pre-roll of phase-declaring sets;
 * - the canonical phase order `intent → controller → physics → transform`,
 *   module phase registration, transform-ownership validation, injected
 *   action/physics ports and one action sample per executed step;
 * - the read-only render interpolation policy;
 * - the built-in moving-box demonstration (`thirdlight.demo:box-motion`);
 * - structured diagnostics.
 *
 * Pure core: imports `@thirdlight/project-model`
 * only — no three.js, no physics library, no Node built-ins, no I/O. Runs
 * unmodified in the play-preview bundle, the export bundle, and the Node
 * test harness.
 */
export { ERROR_CODES, type ErrorCode, type RuntimeError } from './errors';
export {
  JUMP_PHASES,
  MOVE_QUANTUM,
  NEUTRAL_ACTION_SOURCE,
  InputFrameError,
  createRecordedActionSource,
  neutralFrame,
  upgradeActionFrameV1,
  actionAxis,
  actionPhase,
  ACTION_FRAME_VERSION,
  controllerActionsOf,
  quantizeMove,
  validateActionFrame,
  type ActionFrame,
  type ActionValue,
  MAX_FRAME_ACTIONS,
  type ActionSource,
  type ActionSourceDiagnostics,
  type JumpPhase,
  // Pointer samples in the frame.
  POINTER_BUTTON_BITS,
  validatePointerSample,
  validateInputPress,
  type InputPress,
  type PointerSample,
  // Debug commands on input frames.
  validateDebugCommands,
  validateDebugCommandCall,
  DEBUG_COMMAND_NAME_RE,
  MAX_FRAME_COMMANDS,
  MAX_COMMAND_ARGS,
  MAX_COMMAND_TEXT,
  type DebugCommandArg,
  type DebugCommandCall,
} from './actions';
// The player's bindings, the device in use and rebinding (the frame's input entry, scripts' requests).
export {
  checkRebindOptions,
  glyphOfAction,
  mergeInputStatus,
  validateInputStatus,
  MAX_BINDING_REQUESTS,
  MAX_FRAME_INPUT_EVENTS,
  type GamepadFamily,
  type InputActionStatus,
  type InputBindingConflict,
  type InputBindingDevice,
  type InputBindingPart,
  type InputBindingRequest,
  type InputBindingStatus,
  type InputDeviceKind,
  type InputDeviceStatus,
  type InputGlyph,
  type InputGlyphPart,
  type InputRebindEvent,
  type InputRebindOptions,
  type InputRebindTarget,
  type InputStatusEntry,
  type RebindConflictPolicy,
} from './input-status';
export {
  validateCharacterMoveResult,
  type CharacterClearanceResult,
  type CharacterMoveResult,
  type CharacterMoveResultFailure,
  type PhysicsDiagnostics,
  type PhysicsPort,
  type PhysicsResetPort,
  type PhysicsStepClient,
  type StaticColliderSpec,
  type OverlapShape,
  type RaycastHit,
  type Vec2,
  // The 3D port (a project with physics_dimension 3).
  validateCharacterMoveResult3D,
  type CharacterMoveResult3D,
  type PhysicsInitConfig3D,
  type PhysicsPort3D,
  type PhysicsQuat,
  type RaycastHit3D,
  type CharacterState3D,
  type StaticColliderSpec3D,
  type PhysicsVec3,
  // 3D shapes, kinematic poses, overlap queries and clearance.
  type CharacterClearanceResult3D,
  type ColliderShape3D,
  type KinematicPose3D,
  type OverlapShape3D,
  // 3D queries for scripts (filters by tag and collision layer).
  type PhysicsHit,
  type PhysicsQueryFilter,
  type PhysicsQueryFilter3D,
} from './ports';
export { DuplicateMoveError, PhaseViolationError } from './guard';
export {
  type CameraInfo,
  type DiagnosticErrorEntry,
  type PlayerCapsule,
  type BehaviorTagQuery,
  type BehaviorSceneControl,
  type BehaviorWorldView,
  type WorldTransformOptions,
  type LoadedSceneBatch,
  type RuntimeSceneRow,
  type SceneLoadOptions,
  type SceneActivateOptions,
  type SceneLoadRequest,
  type SceneLoadingView,
  type ListedScene,
  type SceneTransitionView,
  type SceneSetView,
  type SceneStatus,
  type GameplaySettings,
  type InstantiateConfig,
  type InterpolatedState,
  type InterpolatedTransform,
  type InterpolatedVisitor,
  type StepPairVisitor,
  type ModuleConfig,
  type Character3DQueries,
  type ModuleResetContext,
  type Runtime,
  type RuntimeDiagnostics,
  type RuntimeScene,
  type RuntimeSnapshot,
  type RuntimeSnapshotEntity,
  type RuntimeStateName,
  type SimEntityData,
  type SimState,
  type SimulationModule,
  type SimulationModuleSpec,
  type SimulationPhase,
  type SimulationPhaseModule,
  type SimulationRegistry,
  type StepContext,
  type TransformState,
  SIMULATION_PHASE_ORDER,
} from './types';
export {
  BUILTIN_MODULES,
  CHARACTER_MODULE_ID,
  createSimulationRegistry,
  registerSimulationModule,
  validatePhaseList,
} from './registry';
export { interpolateTransformInto } from './interp';
export { cameraBlendOf, interpolateCameraPose, type CameraPoseLike } from './camera-brain';
export { catchUpSteps, DROP_THROUGH_STEPS, EFFECT_MAX_QUEUED_REQUESTS, MAX_CATCHUP_SECONDS, SETTLE_PREROLL_STEPS, engineTimingSteps, instantiateRuntime } from './runtime';
// The per-step budget of 3D script queries; the pointer state the runtime keeps.
export { PHYSICS_QUERY_LIMIT, type HeldPointer } from './runtime';
export {
  BEHAVIOR_MODULE_PREFIX,
  BEHAVIOR_CALLBACKS,
  BEHAVIOR_SELF_OWNER,
  BehaviorHostError,
  BehaviorHostIntentLimit,
  behaviorModuleId,
  clipLogMessage,
  createBehaviorModuleSpec,
  materializeBehaviorValues,
  type BehaviorArtifact,
  type BehaviorContext,
  type BehaviorInstanceInfo,
  type BehaviorPrepareConfig,
  type BehaviorSpec,
  type BehaviorCallbackName,
  type BehaviorEnginePin,
  type BehaviorHostInput,
  type BehaviorLogEntry,
  type BehaviorProperties,
  type BehaviorPropertyView,
  type BehaviorDebugView,
} from './behavior';
export {
  BEHAVIOR_LOG_CODE,
  BEHAVIOR_LOG_LEVELS,
  BehaviorIntentError,
  INTENT_LIMITS,
  emptyIntentSet,
  facingQuaternion,
  normalizedQuaternion,
  quantizeIntentMove,
  validateIntentPhase,
  validateIntentShape,
  validateIntentValue,
  type BehaviorIntent,
  type BehaviorLogLevel,
  type ControlJumpIntent,
  type ControlMoveIntent,
  type CharacterMoveIntent,
  type CharacterPlaceIntent,
  type CharacterEnableIntent,
  type IntentKind,
  type IntentSet,
  type ControllerIntents,
  controllerIntents,
  type IntentTransformWrite,
  type SimulationPhaseName,
  type TransformIntent,
} from './intents';
// Folders and inherited flags (the runtime resolves them at scene
// load; the editor uses the same rules for its viewport and inspector).
export { resolveSnapshotHierarchy } from './snapshot';
export { effectiveEntityFlags, resolveSceneHierarchy, type EffectiveEntityFlags } from '@thirdlight/project-model';
// The character capsule's default and ranges (the editor draws and edits it).
export { CAPSULE_LIMITS, DEFAULT_CONTROLLER_CAPSULE, controllerCapsuleOf } from '@thirdlight/project-model';
export { createTagQuery } from './behavior';
export { audioDurationsFromAssetRows, capsuleHalfTotal, colliderRotationZ, colliderShape2DOf, colliderSpecs2D, colliderSpecs3D, modelBoundsFromAssetRows, physics3DConfigOf, playerCapsuleOf, playerPhysicsOf, sceneEntitiesFromDocument, staticColliderOf, staticColliderOf3D, colliderShape3DOf, worldTransformsOf, type ColliderContext } from './scene-set';
// The tuning defaults hosts and editors read (the values are project-model's).
export { BLOCK_DEFAULTS, DEFAULT_CONTROLLER_TUNING, ENGINE_TIMING_DEFAULTS, controllerTuningOf } from '@thirdlight/project-model';
export type { ModelBounds } from './types';
// Animators and ctx.input.
export { AnimatorMachine, ANIMATOR_SPEED_LIMITS, MAX_SCRIPT_MORPHS, type AnimatorControllerLike, type AnimatorLayerLike, type AnimatorPose, type AnimatorPoseLayer } from './animator';
// Sockets and the rig poser (model nodes posed by an animator pose, as three.js poses them).
export { MAX_SOCKET_ATTACHMENTS, SocketSystem, type SocketAttachment, type SocketHost } from './sockets';
export { RigPoser, composeMat4, decomposeMat4, invertMat4, mat4, mulMat4, sampleChannel, type Mat4 } from './rig-pose';
// Every realized entity's world matrix in flat arrays (the renderer places its drawables from them).
export { WorldMatrices } from './world-matrices';
export type { BehaviorSockets } from './types';
// The rig reader (hosts and the editor read the node names the game resolves sockets on).
export { readModelRig, rigNodeNames, type ModelRig } from '@thirdlight/project-model';
// A build's block chunk data, decoded on the game page before a scene reaches the runtime (pure byte decoding).
export { BLOCK_CHUNK_DATA_KEY, decodeBlockChunks, readBlockChunkData } from '@thirdlight/project-model';
// The project's lens (its camera settings) for the editor's camera previews.
export { VIEW_LENS_DEFAULTS, viewLensOf } from '@thirdlight/project-model';
export { inputView, type BehaviorInputView } from './behavior';
// ctx.spawn / ctx.destroy (prefab copies in the running game).
export { MAX_LIVE_SPAWNED, MAX_SPAWNS_PER_STEP, SPAWN_ID_PREFIX, expandPrefab, parseSpawnOptions, type SpawnOptions, type SpawnPlacement } from './spawn';
export type { BehaviorSpawnControl } from './types';
// ctx.timers and the trigger events in ctx.events.
export { MAX_TIMERS_PER_INSTANCE, MAX_TIMER_SECONDS } from './timers';
export type { BehaviorMessage, BehaviorMessageControl, BehaviorMessages, BehaviorTimers, TriggerEventRecord } from './types';
// The generic primitives' script APIs and events.
export type { BehaviorCharacter, BehaviorLook, BehaviorLookValue, RuntimeEventCue } from './types';
export type { EntityLook } from './primitives';
export { CHARACTER_IMPULSE_MAX } from './character-placement';
export { LOOK_MAX_EMISSIVE_INTENSITY, MAX_LOOK_OVERRIDES } from './primitives';
export type { BehaviorCollectible, BehaviorHealth, BehaviorHitbox, BehaviorPatrol, CollectEventRecord, ContactEventRecord, HealthEventRecord, PatrolEventRecord, PrimitiveEventRecord } from './types';
// ctx.random (seeded, replay-safe) and ctx.world queries.
export { DEFAULT_RANDOM_SEED, MAX_RANDOM_STREAMS, randomSeedOf } from './random';
export type { BehaviorRandom, BehaviorRandomStream } from './types';
export { MAX_MESSAGES_PER_STEP } from './blocks';
export type { AnimatorEventRecord, AudioFinishedEvent, AudioMusicOptions, AudioMusicState, AudioPlayOptions, AudioStingerOptions, BehaviorAnimatorControl, BehaviorAnimatorHandle, BehaviorAudio, BehaviorEffects, BehaviorSave, EffectRequest } from './types';
// The 3D kinematic character controller module.
export { CHARACTER_3D_MODULE_ID, RUN_ACTION, character3DSpec, createCharacter3DModule, type Character3DStatus } from './character3d';
export { character3DPhysicsOf } from './scene-set';
// The camera framework — the script API, the brain and its pure rig maths (the editor's frustum previews use it).
export type { BehaviorCamera, BehaviorCameraState, CameraBlendOptions } from './types';
export { CameraBrain, MAX_SHAKE_IMPULSES, type CameraPathData, type CameraViewInfo, type CameraWorld, type VirtualCameraData, type VirtualCameraState } from './camera-brain';
// Environment presets — the blend state (simulation) and the blended look (renderer, editor preview).
export type { BehaviorEnvironment, EnvironmentChangeOptions } from './types';
export { EnvironmentDirector, MAX_ENVIRONMENT_BLEND_SECONDS, type EnvironmentSaveState } from './environment-director';
export {
  ENVIRONMENT_EASINGS,
  FOG_DEFAULTS,
  SKY_DEFAULTS,
  blendEnvironment,
  blendEnvironmentOver,
  blendLight,
  blendTouchesLights,
  colorToLinear,
  easeEnvironment,
  lightValuesFor,
  linearToColor,
  mixColors,
  resolveEnvironmentKey,
  type BlendedEnvironment,
  type EnvironmentBaseLook,
  type EnvironmentBlendView,
  type EnvironmentEasing,
  type EnvironmentLightIdentity,
  type EnvironmentLightValues,
  type EnvironmentOverride,
} from './environment-blend';
export { lookAtQuat, orbitOffset, pointOnPath, quatFromYawPitch, samplePath, screenToRay, worldToScreen, yawPitchOf, type CameraPose, type SampledPath, type ScreenPoint } from './camera-rig';
export { debugCallProblem, debugCallRefusal, ENGINE_DEBUG_COMMANDS, SIGNAL_DEBUG_COMMAND } from './debug-commands';
// Scripts' asset handles (ctx.assets).
export { ASSET_KEY_MAX_LENGTH, MAX_FRAME_ASSET_ANSWERS, RuntimeAssetHandles, validateAssetAnswers, type AssetHandleAnswer, type AssetHandleRequest, type AssetHandleState, type BehaviorAssets } from './asset-handles';
// Project save documents (ctx.saves).
export { MAX_FRAME_SAVE_EVENTS, PROJECT_SAVE_FORMAT, PROJECT_SAVE_FORMAT_VERSION, SAVE_REQUESTS_PER_STEP, SAVE_STORAGE_CODES, SAVE_WORLD_DEPRECATED, type SaveStorageCode, type SaveStorageInfo, projectSaveFileProblem, worldSaveProblem, utf8Length, validateSaveEvents, type BehaviorSaves, type ProjectSaveFile, type WorldSave, type SaveEvent, type SaveMeta, type SaveRequest, type SaveResult, type SaveSlotInfo } from './project-saves';
// (the save schema's limits and settings rules, for hosts that do not depend on project-model)
export { SAVE_LIMITS, SAVE_THUMBNAIL_DEFAULT, saveSlotMetaProblem, settingsDocumentOf, type SaveSchema, type SettingsEngineBinding, type SettingsField, type SettingsFieldValue } from '@thirdlight/project-model';
// The runtime content a game page reads: the manifest's versions and buildId inputs, the catalog's shape and parts (v5).
export {
  catalogRootProblem,
  joinCatalogParts,
  manifestBuildIdInputV2,
  manifestBuildIdInputV5,
  RUNTIME_CONTENT_MANIFEST_VERSION_4,
  RUNTIME_CONTENT_MANIFEST_VERSION_5,
  validateManifestV5,
  type CatalogBlockRow,
  type CatalogEntry,
  type CatalogFileRef,
  type CatalogRootV5,
  type CatalogSceneRow,
  type CatalogShardRow,
  type RuntimeContentManifestV5,
} from '@thirdlight/project-model';
// Texture streaming: the KTX2 level layout the page reads by part, and the budget setting.
export {
  buildKtx2Subset,
  ktx2LevelSize,
  readKtx2Layout,
  textureBudgetBytesOf,
  TEXTURE_BUDGET_DEFAULT_MB,
  type Ktx2Layout,
  type Ktx2Range,
  type ManifestMipPart,
} from '@thirdlight/project-model';
// Levels of detail: the models' default switch points, the project's bias and hysteresis, instance density (defined once, in project-model).
export {
  instanceDensityOf,
  LOD_BIAS_DEFAULT,
  LOD_HYSTERESIS_DEFAULT,
  LOD_REFERENCE_FOV_DEG,
  LOD_SCREEN_SIZES_DEFAULT,
  lodCullSizeOf,
  lodScreenSizesFor,
  lodTuningOf,
  type InstanceDensity,
  type LodTuningSettings,
  type ModelLodSettings,
} from '@thirdlight/project-model';
// The model's limits the hosts and the renderer re-check (defined once, in project-model).
export {
  ASSET_METRIC_CAPS,
  AUDIO_MAX_LATE_MS_DEFAULT,
  AUDIO_MAX_LATE_MS_LIMIT,
  AUDIO_VOICE_CAP,
  AUDIO_VOICES_DEFAULT,
  MAX_FOG_VOLUMES,
  MAX_INPUT_BINDINGS,
  PAD_BINDING_KINDS,
  MAX_LOCAL_LIGHTS,
  LIGHT_LAYER_COUNT,
  LIGHT_LAYERS_ALL,
  lightLayerMaskOf,
  INSTANCES_LOCAL_LIGHTS_DEFAULT,
  lightImportanceOf,
  localLightModeOf,
  type LightImportance,
  type LocalLightMode,
  MAX_MATERIAL_INSTANCE_DEPTH,
  MAX_POLYGON_VERTICES,
  MAX_SOURCE_BYTES,
  M2_GLTF_EXTENSION_ALLOWLIST,
  MODEL_JSON_CHUNK_BYTES_MAX,
} from '@thirdlight/project-model';
export type { BehaviorDebug, DebugCommandArgs, DebugCommandArgSpec, DebugCommandArgType, DebugCommandOptions, DebugCommandSpec, DebugCommandState } from './types';
// Block layers — ctx.grid, the runtime grid, and the pure grid/meshing helpers the renderer shares.
export { GRID_WRITES_PER_STEP, RuntimeGrid, gridColliderId, type BehaviorGrid, type GridCell, type GridCellInput, type GridChange, type GridDiff, type GridEdge, type GridEdgeInput, type GridPick, type GridRenderChange, type GridSurface, type GridVec3 } from './grid';
// Edge pieces: the editor's edge brush snaps and checks edges with the backend's rules.
export { BLOCK_EDGE_THICKNESS, edgeInBounds, type BlockEdge } from '@thirdlight/project-model';
// The editor previews a block stroke locally with the same edit code the backend runs (then commits one editBlocks).
export { BLOCK_EDIT_MAX_EDITS, SCULPT_LIMITS, chunkLightmapLayout, applyBlockEdits, effectiveCellMeta, pickCell, surfaceBelow, type BlockEdit, type BlockStamp } from '@thirdlight/project-model';
// The instance brush's places and surface drop (the editor finds the surface under the same places the backend plans).
export { INSTANCE_BRUSH_DEFAULTS, INSTANCE_BRUSH_LIMITS, StrokeCandidates, candidateDrop, dropOntoBlockLayers, instanceStrokeError } from '@thirdlight/project-model';
// The paint brush and block-layer paint (the editor's Paint mode, the renderer's paint colours).
export { BRUSH_FALLOFFS, PAINT_BRUSH_LIMITS, PAINT_CHANNELS, chunkPaintColors, type BrushFalloff, type PaintBrush } from '@thirdlight/project-model';
// A prop's block footprint: the editor snaps props and writes footprints with the backend's geometry.
export { footprintCells, footprintEdits, footprintMinCell, footprintPlaces, overLayer, placeInWorld, pointInParent, turnedSize, yawQuarterTurns, type FootprintLayer, type FootprintNode } from '@thirdlight/project-model';
export { BlockGrid, CHUNK_SIZE, autoVariant, blockTopOptions, blockTypeSolid, blockVariantUv, chunkKeyOf, collisionMeshChunk, compareChunkKeys, meshBlockChunk, rotatedFootprint, shapeSource, type BlockCell, type BlockChunk, type BlockLayerComponent, type BlockLayerData, type BlockLookResolver, type BlockMeshSource, type BlockTopOptions, type BlockType, type BlockUvMode, type BlockVariant, type CellField, type ChunkMeshPart } from '@thirdlight/project-model';
// The audio intent log (script sound handles, music, duck) and the positional maths the host shares.
export { AUDIO_BUS_NAMES, AUDIO_MAX_HANDLES, AUDIO_MAX_QUEUED_COMMANDS, AUDIO_MAX_PLAYS_PER_STEP, AUDIO_PITCH_MAX, AUDIO_PITCH_MIN, AUDIO_SPATIAL_DEFAULTS, AudioMixer, STINGER_DEFAULTS, distanceGain, lateBoundOf, listenerRelative, ownerModeOf, spatialOf, type AudioOwner, type AudioOwnerMode, type AudioBusName, type AudioCommand, type AudioDistanceModel, type AudioSpatial } from './audio-mixer';
// Graph-material parameters per object — ctx.materials, the catalogue and the renderer's changes.
export { MATERIAL_WRITES_PER_STEP, RuntimeMaterials, materialCatalogOf, materialCatalogProblem, materialChangeKey, type BehaviorMaterials, type MaterialSaveEntry, type MaterialParamValue, type MaterialRenderChange, type RuntimeMaterialCatalog, type RuntimeMaterialParameter, type RuntimeMaterialParameterType } from './material-params';
// The project UI — ctx.ui, the UI events of an input frame, the view-model diff the host draws from.
export type { BehaviorUi, BehaviorUiEvent, BehaviorUiView, BehaviorStats, BehaviorStatsTime, BehaviorDisplay } from './types';
export { FRAME_RATE_CAP_URL_PARAM, FramePacer, frameRateCapFromUrl, frameTargetMs, UNCAPPED_TARGET_FPS, SIM_DELAY_URL_PARAM, simDelayFromUrl, type FramePacingStats } from './frame-pacing';
// The frame-rate cap's values (project-model owns them), for the page's pacing and the shell.
export { FRAME_RATE_CAPS, frameRateCapOf, projectFrameRateCap, type FrameRateCap } from '@thirdlight/project-model';
// The render settings (ambient occlusion, render scale, dynamic resolution) the renderer and the game page read.
export { AMBIENT_OCCLUSION_DEFAULT, AMBIENT_OCCLUSION_KINDS, ambientOcclusionOf, RENDER_SCALE_MAX, RENDER_SCALE_MIN, renderScaleOf, renderSettingsOf, type AmbientOcclusionKind, type RenderSettings } from '@thirdlight/project-model';
export { DEFAULT_QUALITY_LEVELS, levelPost, LOD_BIAS_MAX, LOD_BIAS_MIN, PIXEL_RATIO_CAP_MAX, QUALITY_LEVEL_ID_RE, qualityLevelOf, qualityLevelsOf, type QualityLevelConfig, type QualityLevelPost } from '@thirdlight/project-model';
// The simulation's step rate when a project sets none (project-model's).
export { DEFAULT_FIXED_STEP_HZ, fixedStepHzOf } from '@thirdlight/project-model';
export { clampAlpha, previewFrameSeconds } from './frame-clock';
export { ENGINE_STATS_NONE, STATS_WINDOW_MS, engineStatsOf } from './engine-stats';
export {
  MAX_FRAME_UI_EVENTS,
  UI_EVENT_KINDS,
  UI_DEFAULT_VIEW,
  UI_MAX_COMMANDS,
  UI_MAX_SHOWN,
  UI_MODEL_MAX_BYTES,
  UiState,
  applyUiOutputToModel,
  mergeUiOutput,
  readUiPath,
  uiPathSegments,
  uiViewOf,
  validateUiEvent,
  validateUiEvents,
  type UiCommand,
  type UiEventKind,
  type UiEventRecord,
  type UiOutput,
  type UiShownDocument,
  type UiStateView,
  type UiView,
} from './ui';
// The document types the game host draws (project-model's; the host reads them through the runtime).
export { UI_LIMITS, uiDocumentsForRuntime, uiTextPlaceholders } from '@thirdlight/project-model';
export type { RuntimeUiDocumentRow, UiAction, UiBinding, UiDocument, UiEngineAction, UiIcon, UiScaleMode, UiStyle, UiStyleValues, UiTheme, UiTween, UiWidget, UiWorldAnchor } from '@thirdlight/project-model';
// Dialogue — ctx.dialogue, the runner, the dialogue inputs of an input frame, and the data/UI helpers hosts share.
export { DIALOGUE_INPUT_KINDS, DialogueRunner, validateDialogueInput, validateDialogueInputs, type DialogueAudioPort, type DialogueInputKind, type DialogueInputRecord, type DialogueSaveState, type DialogueUiPort } from './dialogue';
export type { BehaviorDialogue, BehaviorDialogueEvent, BehaviorDialogueHistoryEntry, BehaviorDialogueState, DialogueVariableValue } from './types';
export { DIALOGUE_DOCUMENT_ID, DIALOGUE_LIMITS, dialogueForRuntime, dialogueUiDocument, withDialogueUiDocument, parseRichText, richTextVisibleLength, uiValueText, codePointLength, UI_DIALOGUE_INPUTS } from '@thirdlight/project-model';
export type { DialogueDocument, DialogueSettings, DialogueSpeaker, RuntimeDialogueData, RichStyle, RichToken, UiDialogueInput } from '@thirdlight/project-model';
// Game modes (ctx.modes), the run lifecycle (ctx.lifecycle) and the mode view the host reads.
export type { BehaviorLifecycle, BehaviorModeEvent, BehaviorModes, BehaviorModeTransition } from './types';
// Generic component access (ctx.entity) and the shell's scene list (ctx.shell).
export { MAX_ENTITY_WRITES_PER_STEP, type BehaviorEntityControl, type BehaviorEntityHandle, type EntityFieldsSave, type EntityWriteCode, type EntityWriteResult, type LightOverride } from './entity-access';
export type { BehaviorShell } from './types';
// Where the character may climb (read by the character controller modules).
export type { ClimbQuery } from './types';
export type { ClimbVolumeView } from './blocks';
export { ModeState, type ModeEffects, type ModeEventRecord, type ModeTransitionSpec, type ModeView } from './modes';
export { modesForRuntime } from '@thirdlight/project-model';
export type { GameMode, RuntimeModes } from '@thirdlight/project-model';
// The sequencer (timelines in the simulation step; the evaluation the editor's scrub preview shares).
export {
  TimelineSystem,
  TIMELINE_MAX_PLAYING,
  evaluateTimelineAt,
  timelineBindings,
  timelineEase,
  transformTrackAt,
  valueTrackAt,
  cameraKeyAt,
  cameraProgressAt,
  fadeColorAt,
  curveAt,
  type TimelineHost,
  type TimelineDialoguePort,
  type TimelineEnvironmentPort,
  type TimelineEvent,
  type TimelineView,
  type TimelinePreview,
  type TimelinePlayState,
  type TimelineTransformPose,
} from './timeline';
export type { BehaviorTimeline, BehaviorTimelineEvent } from './types';
export type { TimelineAsset, TimelineTrack, TimelineKey, TimelineTrackType } from '@thirdlight/project-model';
// The editor may take project-model values only through the runtime.
export { TIMELINE_EASINGS, TIMELINE_TARGET_TRACKS, TIMELINE_TRACK_TYPES, TIMELINE_LIMITS } from '@thirdlight/project-model';
// The resource manager a game page and the editor's Scene view hold what they load from assets in.
export {
  createResourceManager,
  assetVersionKey,
  RESOURCE_KINDS,
  RESOURCE_HANDLE_PREFIX,
  EMBEDDED_TEXTURES_LISTED,
  embeddedTextureBytes,
  type EmbeddedTextures,
  type EmbeddedTexturesObservation,
  type LoadedResource,
  type ResidentCount,
  type ResourceKind,
  type ResourceManager,
  type ResourceManagerOptions,
  type ResourceObservation,
} from './resources';
export { DIALOGUE_VOICE_LOOKAHEAD_LINES, dialogueVoicesAhead, type DialogueVoiceAhead } from './dialogue-ahead';
// Collider shapes made from geometry (the editor's model colliders and the build's `_COL` parts make the same).
export { COLLIDER_3D_LIMITS, MAX_COLLIDER_EXTENT, colliderFromTriangles, convexFromPoints, convexHull2, polygonFromPoints, roundMm } from '@thirdlight/project-model';
// Probe grids (baked indirect light): placement, the record, and the artifact's PNG decoder (16-bit samples kept).
export {
  DEFAULT_PROBE_BOUNCES,
  DEFAULT_PROBE_SPACING,
  MAX_PROBE_BOUNCES,
  MAX_TEXTURE_EDGE,
  PROBE_ARTIFACT_ROW_PROBES,
  PROBE_ATLAS_PADDING,
  PROBE_FILLED,
  PROBE_GPU_TEXELS,
  PROBE_MOVED,
  PROBE_SPACING_MAX,
  PROBE_SPACING_MIN,
  PROBE_SH_TEXELS,
  PROBE_TEXELS,
  PROBE_VALID,
  PROBE_VALIDITY_THRESHOLD,
  decodePngRgba,
  placeProbeGrids,
  probeArtifactSize,
  probeCount,
  probeGridGpuBytes,
  type ProbeBake,
  type ProbeGridBox,
  type ProbeGridRecord,
  type ProbeVolumeBox,
} from '@thirdlight/project-model';
