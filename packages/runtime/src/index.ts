/**
 * @thirdlight/runtime — public surface (dependencies.md §3 row:
 * `instantiateRuntime`, `createSimulationRegistry`,
 * `registerSimulationModule`, `BUILTIN_MODULES`, types (snapshot,
 * diagnostics, module interfaces), `ERROR_CODES`; M2 additions:
 * `ActionFrame`, `JumpPhase`, `ActionSource`, `createRecordedActionSource`,
 * `SimulationPhase`, `StepContext`, `GameplaySettings`, `PhysicsPort`,
 * `PhysicsStepClient`; M3 additions (gameplay.md / runtime.md §15):
 * `GameSession`, `GameSessionPort`, `GameView`, `PhysicsResetPort`, the
 * `GameContent`/`RunSnapshot`/`ModuleResetContext` types, `SIMULATION_PHASE_ORDER`
 * with the appended `gameplay`/`camera` phases, and the `getGameView`/
 * `gameCommand`/`setViewport` run surface.
 *
 * Thirdlight M1 play/runtime core (docs/contracts/runtime.md, packet 08)
 * plus the M2 module-set lifecycle (packet 29, runtime.md §12/§13):
 *
 * - the runtime snapshot input (strict, re-validated, deep-frozen; v3 and
 *   v4 scenes with the `game` wrapper field — v1/v2 were removed in 9.3);
 * - the instantiate/start/stop/dispose lifecycle with a single frame-driver
 *   owner, the `failed` state and fail-stop (no rollback, fresh restart only);
 * - the separate mutable simulation state and the phase-scoped write guard;
 * - fixed-step scheduling with bounded catch-up (120 Hz, MAX_CATCHUP_STEPS 8,
 *   drop-and-resync) and the 12-step M2 settle pre-roll;
 * - the canonical phase order `intent → controller → physics → transform`,
 *   module phase registration, transform-ownership validation, injected
 *   action/physics ports and one action sample per executed step;
 * - the read-only render interpolation policy;
 * - the built-in moving-box demonstration (`thirdlight.demo:box-motion`);
 * - structured diagnostics.
 *
 * Pure core (dependencies.md §4.1): imports `@thirdlight/project-model`
 * only — no three.js, no physics library, no Node built-ins, no I/O. Runs
 * unmodified in the play-preview bundle, the export bundle, and the Node
 * test harness (runtime.md §9).
 */
export { ERROR_CODES, type ErrorCode, type RuntimeError } from './errors';
export {
  JUMP_PHASES,
  MOVE_QUANTUM,
  NEUTRAL_ACTION_SOURCE,
  InputFrameError,
  createRecordedActionSource,
  neutralFrame,
  quantizeMove,
  validateActionFrame,
  type ActionFrame,
  type ActionValue,
  MAX_FRAME_ACTIONS,
  type ActionSource,
  type ActionSourceDiagnostics,
  type JumpPhase,
  // Phase 23.3: pointer samples in the frame.
  POINTER_BUTTON_BITS,
  validatePointerSample,
  type PointerSample,
  // Phase 23.8: debug commands on input frames.
  validateDebugCommands,
  validateDebugCommandCall,
  DEBUG_COMMAND_NAME_RE,
  MAX_FRAME_COMMANDS,
  MAX_COMMAND_ARGS,
  MAX_COMMAND_TEXT,
  type DebugCommandArg,
  type DebugCommandCall,
} from './actions';
// Phase 23.14: the player's bindings, the device in use and rebinding (the frame's input entry, scripts' requests).
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
  type Vec2,
  // Phase 23.0: the 3D port (a project with physics_dimension 3).
  validateCharacterMoveResult3D,
  type CharacterMoveResult3D,
  type PhysicsInitConfig3D,
  type PhysicsPort3D,
  type PhysicsQuat,
  type RaycastHit3D,
  type CharacterState3D,
  type StaticColliderSpec3D,
  type PhysicsVec3,
  // Phase 23.1: 3D shapes, kinematic poses, overlap queries and clearance.
  type CharacterClearanceResult3D,
  type ColliderShape3D,
  type KinematicPose3D,
  type OverlapShape3D,
  // Phase 23.3: 3D queries for scripts (filters by tag and collision layer).
  type PhysicsHit,
  type PhysicsQueryFilter,
  type PhysicsQueryFilter3D,
} from './ports';
export { DuplicateMoveError, PhaseViolationError } from './guard';
export {
  type CameraInfo,
  type DiagnosticErrorEntry,
  type GameCameraBounds,
  type GameContent,
  type PlayerCapsule,
  type GameEvent,
  type GameEventKind,
  type GameSessionPort,
  type BehaviorTagQuery,
  type BehaviorSceneControl,
  type BehaviorWorldView,
  type LoadedSceneBatch,
  type RuntimeSceneRow,
  type SceneLoadOptions,
  type SceneLoadRequest,
  type SceneSetView,
  type SceneStatus,
  type GameView,
  type GameZoneRole,
  type GameplaySettings,
  type InstantiateConfig,
  type InterpolatedState,
  type InterpolatedTransform,
  type InterpolatedVisitor,
  type ModuleConfig,
  type Character3DQueries,
  type ModuleResetContext,
  type MotionSegment,
  type PlayerMotion,
  type Runtime,
  type RuntimeDiagnostics,
  type RuntimeScene,
  type RuntimeSnapshot,
  type RuntimeSnapshotEntity,
  type RuntimeStateName,
  type RunSnapshot,
  type RunState,
  type SimEntityData,
  type SimState,
  type SimulationModule,
  type SimulationModuleSpec,
  type SimulationPhase,
  type SimulationPhaseModule,
  type SimulationRegistry,
  type StepContext,
  type TransformState,
  type ViewportInfo,
  SIMULATION_PHASE_ORDER,
} from './types';
export {
  CAMERA_MAX_STEP,
  CAMERA_Z,
  DEFAULT_ASPECT,
  GameSession,
  MAX_GAME_EVENTS,
  RESPAWN_DELAY_STEPS,
  type BoundaryOutcome,
  type GameCommandAccepted,
  type GameCommandRejection,
  type RunCommand,
} from './game-session';
export {
  BUILTIN_MODULES,
  PLATFORMER_MODULE_ID,
  createSimulationRegistry,
  registerSimulationModule,
  validatePhaseList,
} from './registry';
export { DROP_THROUGH_STEPS, MAX_CATCHUP_STEPS, SETTLE_PREROLL_STEPS, instantiateRuntime, sessionTimingSteps } from './runtime';
// Phase 23.3: the per-step budget of 3D script queries; the pointer state the runtime keeps.
export { QUERY_LIMIT_3D, type HeldPointer } from './runtime';
export {
  BEHAVIOR_MODULE_PREFIX,
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
  type IntentTransformWrite,
  type SimulationPhaseName,
  type TransformIntent,
} from './intents';
// Phase 12: folders and inherited flags (the runtime resolves them at scene
// load; the editor uses the same rules for its viewport and inspector).
export { resolveSnapshotHierarchy } from './snapshot';
export { effectiveEntityFlags, resolveSceneHierarchy, type EffectiveEntityFlags } from '@thirdlight/project-model';
// Phase 14.0: the character capsule's default and ranges (the editor draws and edits it).
export { CAPSULE_LIMITS, DEFAULT_CONTROLLER_CAPSULE, controllerCapsuleOf } from '@thirdlight/project-model';
export { createTagQuery } from './behavior';
export { audioDurationsFromAssetRows, capsuleHalfTotal, colliderRotationZ, modelBoundsFromAssetRows, physics3DConfigOf, playerCapsuleOf, playerPhysicsOf, sceneEntitiesFromDocument, staticColliderOf, staticColliderOf3D, colliderShape3DOf } from './scene-set';
// Phase 15.3: the tuning defaults hosts and editors read (the values are project-model's).
export { BLOCK_DEFAULTS, CAMERA_FOLLOW_DEFAULTS, DEFAULT_CONTROLLER_TUNING, GAME_TIMING_DEFAULTS, controllerTuningOf } from '@thirdlight/project-model';
export type { ModelBounds } from './types';
// Phase 9.7/9.8: animators and ctx.input.
export { AnimatorMachine, ANIMATOR_SPEED_LIMITS, MAX_SCRIPT_MORPHS, type AnimatorControllerLike, type AnimatorLayerLike, type AnimatorPose, type AnimatorPoseLayer } from './animator';
// Phase 23.11: sockets and the rig poser (model nodes posed by an animator pose, as three.js poses them).
export { MAX_SOCKET_ATTACHMENTS, SocketSystem, type SocketAttachment, type SocketHost } from './sockets';
export { RigPoser, composeMat4, decomposeMat4, invertMat4, mat4, mulMat4, sampleChannel, type Mat4 } from './rig-pose';
export type { BehaviorSockets } from './types';
// Phase 23.11: the rig reader (hosts and the editor read the node names the game resolves sockets on).
export { readModelRig, rigNodeNames, type ModelRig } from '@thirdlight/project-model';
export { inputView, type BehaviorInputView } from './behavior';
// Phase 14.1: ctx.spawn / ctx.destroy (prefab copies in the running game).
export { MAX_LIVE_SPAWNED, MAX_SPAWNS_PER_STEP, SPAWN_ID_PREFIX, expandPrefab, parseSpawnOptions, type SpawnOptions, type SpawnPlacement } from './spawn';
export type { BehaviorSpawnControl } from './types';
// Phase 14.2: ctx.timers and the trigger events in ctx.events.
export { MAX_TIMERS_PER_INSTANCE, MAX_TIMER_SECONDS } from './timers';
export type { BehaviorMessage, BehaviorMessageControl, BehaviorMessages, BehaviorTimers, TriggerEventRecord } from './types';
// Phase 23.7: ctx.random (seeded, replay-safe) and ctx.world queries.
export { DEFAULT_RANDOM_SEED, MAX_RANDOM_STREAMS, randomSeedOf } from './random';
export type { BehaviorRandom, BehaviorRandomStream } from './types';
export { MAX_MESSAGES_PER_STEP } from './blocks';
export type { AnimatorEventRecord, AudioFinishedEvent, AudioMusicState, AudioPlayOptions, AudioStingerOptions, BehaviorAnimatorControl, BehaviorAnimatorHandle, BehaviorAudio, BehaviorEffects, BehaviorSave, EffectRequest, RunRestore, RunSaveState } from './types';
// Phase 23.2: the 3D kinematic character controller module.
export { CHARACTER_3D_MODULE_ID, RUN_ACTION, character3DSpec, createCharacter3DModule, type Character3DStatus } from './character3d';
export { character3DPhysicsOf } from './scene-set';
// Phase 23.4: the camera framework — the script API, the brain and its pure rig maths (the editor's frustum previews use it).
export type { BehaviorCamera, BehaviorCameraState, CameraBlendOptions } from './types';
export { CameraBrain, MAX_SHAKE_IMPULSES, type CameraPathData, type CameraViewInfo, type CameraWorld, type VirtualCameraData, type VirtualCameraState } from './camera-brain';
// Phase 23.18: environment presets — the blend state (simulation) and the blended look (renderer, editor preview).
export type { BehaviorEnvironment, EnvironmentChangeOptions } from './types';
export { EnvironmentDirector, MAX_ENVIRONMENT_BLEND_SECONDS, type EnvironmentSaveState } from './environment-director';
export {
  ENVIRONMENT_EASINGS,
  FOG_DEFAULTS,
  SKY_DEFAULTS,
  blendEnvironment,
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
export { debugCallProblem } from './debug-commands';
// Phase 23.19: project save documents (ctx.saves).
export { MAX_FRAME_SAVE_EVENTS, PROJECT_SAVE_FORMAT, PROJECT_SAVE_FORMAT_VERSION, SAVE_REQUESTS_PER_STEP, projectSaveFileProblem, utf8Length, validateSaveEvents, type BehaviorSaves, type ProjectSaveFile, type SaveEvent, type SaveMeta, type SaveRequest, type SaveResult, type SaveSlotInfo } from './project-saves';
// (the save schema's limits and settings rules, for hosts that do not depend on project-model)
export { SAVE_LIMITS, SAVE_THUMBNAIL_DEFAULT, settingsDocumentOf, type SaveSchema, type SettingsField, type SettingsFieldValue } from '@thirdlight/project-model';
export type { BehaviorDebug, DebugCommandArgs, DebugCommandArgSpec, DebugCommandArgType, DebugCommandOptions, DebugCommandSpec, DebugCommandState } from './types';
// Phase 23.5 (E8): block layers — ctx.grid, the runtime grid, and the pure grid/meshing helpers the renderer shares.
export { GRID_WRITES_PER_STEP, RuntimeGrid, gridColliderId, type BehaviorGrid, type GridCell, type GridCellInput, type GridChange, type GridDiff, type GridPick, type GridRenderChange, type GridVec3 } from './grid';
// Phase 23.6: the editor previews a block stroke locally with the same edit code the backend runs (then commits one editBlocks).
export { applyBlockEdits, effectiveCellMeta, pickCell, type BlockEdit, type BlockStamp } from '@thirdlight/project-model';
export { BlockGrid, CHUNK_SIZE, autoVariant, blockTypeSolid, chunkKeyOf, collisionMeshChunk, compareChunkKeys, meshBlockChunk, rotatedFootprint, shapeSource, type BlockCell, type BlockChunk, type BlockLayerComponent, type BlockLayerData, type BlockLookResolver, type BlockMeshSource, type BlockType, type BlockVariant, type CellField, type ChunkMeshPart } from '@thirdlight/project-model';
// Phase 23.13: the audio intent log (script sound handles, music, duck) and the positional maths the host shares.
export { AUDIO_BUS_NAMES, AUDIO_MAX_HANDLES, AUDIO_MAX_PLAYS_PER_STEP, AUDIO_PITCH_MAX, AUDIO_PITCH_MIN, AUDIO_SPATIAL_DEFAULTS, AudioMixer, STINGER_DEFAULTS, distanceGain, listenerRelative, spatialOf, type AudioBusName, type AudioCommand, type AudioDistanceModel, type AudioSpatial } from './audio-mixer';
// Phase 23.12 (E9): graph-material parameters per object — ctx.materials, the catalogue and the renderer's changes.
export { MATERIAL_WRITES_PER_STEP, RuntimeMaterials, materialCatalogOf, materialCatalogProblem, materialChangeKey, type BehaviorMaterials, type MaterialSaveEntry, type MaterialParamValue, type MaterialRenderChange, type RuntimeMaterialCatalog, type RuntimeMaterialParameter, type RuntimeMaterialParameterType } from './material-params';
// Phase 23.9a: the project UI — ctx.ui, the UI events of an input frame, the view-model diff the host draws from.
export type { BehaviorUi, BehaviorUiEvent } from './types';
export {
  MAX_FRAME_UI_EVENTS,
  UI_EVENT_KINDS,
  UI_MAX_COMMANDS,
  UI_MAX_SHOWN,
  UI_MODEL_MAX_BYTES,
  UiState,
  applyUiOutputToModel,
  mergeUiOutput,
  readUiPath,
  uiPathSegments,
  validateUiEvent,
  validateUiEvents,
  type UiCommand,
  type UiEventKind,
  type UiEventRecord,
  type UiOutput,
  type UiShownDocument,
  type UiStateView,
} from './ui';
// The document types the game host draws (project-model's; the host reads them through the runtime).
export { UI_LIMITS, uiDocumentsForRuntime, uiTextPlaceholders } from '@thirdlight/project-model';
export type { RuntimeUiDocumentRow, UiAction, UiBinding, UiDocument, UiEngineAction, UiIcon, UiStyle, UiStyleValues, UiTheme, UiTween, UiWidget, UiWorldAnchor } from '@thirdlight/project-model';
