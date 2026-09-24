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
} from './actions';
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
  type ModuleConfig,
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
  type BehaviorEnginePin,
  type BehaviorHostInput,
  type BehaviorLogEntry,
  type BehaviorProperties,
  type BehaviorPropertyView,
} from './behavior';
export {
  BEHAVIOR_LOG_CODE,
  BEHAVIOR_LOG_LEVELS,
  BehaviorIntentError,
  INTENT_LIMITS,
  emptyIntentSet,
  quantizeIntentMove,
  validateIntentPhase,
  validateIntentShape,
  validateIntentValue,
  type BehaviorIntent,
  type BehaviorLogLevel,
  type ControlJumpIntent,
  type ControlMoveIntent,
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
export { capsuleHalfTotal, modelBoundsFromAssetRows, playerCapsuleOf, playerPhysicsOf, sceneEntitiesFromDocument } from './scene-set';
// Phase 15.3: the tuning defaults hosts and editors read (the values are project-model's).
export { BLOCK_DEFAULTS, CAMERA_FOLLOW_DEFAULTS, DEFAULT_CONTROLLER_TUNING, GAME_TIMING_DEFAULTS, controllerTuningOf } from '@thirdlight/project-model';
export type { ModelBounds } from './types';
// Phase 9.7/9.8: animators and ctx.input.
export { AnimatorMachine, type AnimatorControllerLike, type AnimatorLayerLike, type AnimatorPose, type AnimatorPoseLayer } from './animator';
export { inputView, type BehaviorInputView } from './behavior';
// Phase 14.1: ctx.spawn / ctx.destroy (prefab copies in the running game).
export { MAX_LIVE_SPAWNED, MAX_SPAWNS_PER_STEP, SPAWN_ID_PREFIX, expandPrefab, parseSpawnOptions, type SpawnOptions, type SpawnPlacement } from './spawn';
export type { BehaviorSpawnControl } from './types';
// Phase 14.2: ctx.timers and the trigger events in ctx.events.
export { MAX_TIMERS_PER_INSTANCE, MAX_TIMER_SECONDS } from './timers';
export type { BehaviorTimers, TriggerEventRecord } from './types';
export type { AnimatorEventRecord, BehaviorAnimatorControl, BehaviorAnimatorHandle, BehaviorAudio, BehaviorSave, RunRestore, RunSaveState } from './types';
