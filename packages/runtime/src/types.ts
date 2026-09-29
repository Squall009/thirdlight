/**
 * Runtime public types — runtime.md §2 (snapshot), §3 (lifecycle API),
 * §4 (mutable simulation state), §5/§6 (scheduling + interpolation),
 * §7 (module shape), §8 (diagnostics), and the M2 additions §12 (phases,
 * ports, transform ownership) / §13 (fail-stop).
 *
 * These are the type surface of the `runtime` package (dependencies.md §3:
 * "types (snapshot, diagnostics, module interfaces)" plus the M2 additions
 * `ActionFrame`, `JumpPhase`, `ActionSource`, `createRecordedActionSource`,
 * `SimulationPhase`, `StepContext`, `GameplaySettings`, `PhysicsPort`,
 * `PhysicsStepClient`).
 */
import type { EntityV3, Quat, Vec3 } from '@thirdlight/project-model';

import type { ActionFrame, ActionSource, DebugCommandCall } from './actions';
import type { ErrorCode, RuntimeError } from './errors';
import type { PhysicsPort, PhysicsStepClient } from './ports';
import { registryBrand, type SimulationPhase } from './types-simulation';
import { type DebugCommandState, type EffectRequest } from './types-behavior';
import { type SceneLoadingView, type SceneLoadOptions, type SceneLoadRequest, type SceneSetView } from './types-scene';
export type { RuntimeSnapshotEntity, RuntimeScene, RuntimeSnapshot, RuntimeEventCue, ModelBounds, RuntimeSceneRow, ListedScene, SceneStatus, SceneLoadOptions, SceneTransitionView, SceneLoadingView, BehaviorSceneControl, BehaviorWorldView, BehaviorRandomStream, BehaviorRandom, LoadedSceneBatch, SceneSetView, SceneLoadRequest, GameplaySettings } from './types-scene';
export { SIMULATION_PHASE_ORDER } from './types-simulation';
export type { InstantiateConfig, TransformState, SimEntityData, SimState, ModuleConfig, Character3DQueries, SimulationModule, SimulationPhase, PlayerCapsule, ModuleResetContext, SimulationPhaseModule, StepContext, ClimbQuery, BehaviorShell, SimulationModuleSpec, SimulationRegistry } from './types-simulation';
export type { BehaviorMessage, BehaviorMessages, BehaviorMessageControl, TriggerEventRecord, HealthEventRecord, ContactEventRecord, PatrolEventRecord, CollectEventRecord, PrimitiveEventRecord, BehaviorTimers, BehaviorSpawnControl, BehaviorSave, DebugCommandArgType, DebugCommandArgSpec, DebugCommandOptions, DebugCommandSpec, DebugCommandArgs, DebugCommandState, BehaviorDebug, AudioFinishedEvent, AudioPlayOptions, AudioStingerOptions, AudioMusicState, BehaviorAudio, EffectRequest, BehaviorEffects } from './types-behavior';
export type { CameraBlendOptions, BehaviorCameraState, BehaviorUiEvent, EnvironmentChangeOptions, BehaviorEnvironment, BehaviorUi, DialogueVariableValue, BehaviorDialogueEvent, BehaviorDialogueState, BehaviorDialogueHistoryEntry, BehaviorDialogue, BehaviorModeEvent, BehaviorModeTransition, BehaviorModes, BehaviorLifecycle, BehaviorTimelineEvent, BehaviorTimeline, BehaviorCamera, BehaviorSockets, BehaviorSignals, BehaviorGameState, BehaviorHealth, BehaviorPatrol, BehaviorHitbox, BehaviorCollectible, BehaviorCharacter, BehaviorLookValue, BehaviorLook, BehaviorAnimatorHandle, BehaviorAnimatorControl, AnimatorEventRecord, BehaviorTagQuery } from './types-behavior-world';
export { registryBrand as SIM_REGISTRY_BRAND };

/** Lifecycle states (runtime.md §3/§13). */
export type RuntimeStateName = 'instantiated' | 'running' | 'stopped' | 'failed' | 'disposed';

/** The runtime instance (runtime.md §3 API; every call returns a result). */
export interface Runtime {
  start(): { ok: true } | { ok: false; error: RuntimeError };
  stop(): { ok: true } | { ok: false; error: RuntimeError };
  /** Phase 9.10: pause or resume the simulation (frames still render). */
  setPaused?(paused: boolean): void;
  readonly isPaused?: boolean;
  /** Phase 22.0: the last frame's interpolation alpha (as `getInterpolatedState().state.alpha`), without building the state. */
  readonly interpolationAlpha?: number;
  /**
   * Phase 19.2 (Play debugging): hold the simulation at a step boundary or
   * release it; while held, `debugStep` runs exactly one more step; a step
   * watcher returning true holds right after the step it saw (breakpoints);
   * `behaviorDebug` reads what running behavior instances expose to a
   * debugger (a visual script's Play debug build: its trace, wire values,
   * variables). The game never uses them; they change nothing it computes.
   */
  setDebugHold?(hold: boolean): void;
  readonly debugHeld?: boolean;
  debugStep?(): void;
  setStepWatcher?(watcher: ((stepIndex: number) => boolean) | null): void;
  /** Phase 25.16: told after every executed step (settle steps excluded) with the step count; never holds. */
  setStepObserver?(observer: ((stepIndex: number) => void) | null): void;
  /** Phase 25.16: where this run began: the step count (0, or the boundary of the last restart) and the last spawned copy's number then. */
  runStart?(): { readonly step: number; readonly spawnBase: number };
  behaviorDebug?(filter?: { behaviorId?: string; entityId?: string }): { behaviorId: string; entityId: string; debug: unknown }[];
  /** Phase 9.9: entities hidden (collected collectibles, `ctx.game.setVisible`; the renderer hides them). */
  hiddenEntities?(): ReadonlySet<string>;
  /** Phase 24.4h: the per-object look overrides scripts set (ctx.look; the renderer applies them). */
  entityLooks?(): ReadonlyMap<string, import('./primitives').EntityLook>;
  /** Phase 25.10: the objects scripts switched off, with their children (also in `hiddenEntities`; audio sources are silent). */
  inactiveEntities?(): ReadonlySet<string>;
  /** Phase 25.10: the light values scripts wrote (`ctx.entity(id).set('light', …)`); the renderer applies them. */
  lightOverrides?(): ReadonlyMap<string, import('./entity-access').LightOverride>;
  /** Phase 25.10: the fields scripts wrote as digest text (null while none). */
  entityFieldsState?(): string | null;
  /** Phase 9.10: the sounds scripts played since the last call. Phase 23.13: the audio intent log's commands. */
  takeAudioRequests?(): import('./audio-mixer').AudioCommand[];
  /** Phase 23.13: the audio intent log's deterministic state (digests; null while scripts never used audio). */
  audioState?(): Record<string, unknown> | null;
  /** Phase 20.2: the effect requests (scripts, effect-component signals, gameplay hooks) since the last call; the adapter plays them. */
  takeEffectRequests?(): EffectRequest[];
  /** Phase 23.5: the block-layer chunks to re-mesh since the last call (their cells now); the adapter applies them. */
  takeGridChanges?(): import('./grid').GridRenderChange[];
  /** Phase 23.5: the block cells changed since the run started (plain data). */
  gridDiff?(): import('./grid').GridDiff;
  /** Phase 23.12: the material parameters scripts changed since the last call (one change per parameter); the adapter applies them. */
  takeMaterialChanges?(): import('./material-params').MaterialRenderChange[];
  /** Phase 23.12: the material parameters scripts set, as digest text (null while none is set). */
  materialState?(): string | null;
  /**
   * Phase 23.18: the environment blend (preset weights) interpolated like the transforms,
   * or null until a script changed the environment (the renderer then draws the static look).
   */
  readEnvironmentBlend?(): import('./environment-blend').EnvironmentBlendView | null;
  /** Phase 23.18: the committed environment blend as digest text (null until a script changed it). */
  environmentState?(): string | null;
  /** Phase 9.9: the run's counters and the character's health. */
  gameCounters?(): { counters: Record<string, number>; health: { current: number; max: number } | null };
  /** Manual driver only (runtime.md §3.5); rAF driver ⇒ `tick_not_allowed`. */
  tick(nowSeconds: number): { ok: true } | { ok: false; error: RuntimeError };
  getDiagnostics(): { ok: true; diagnostics: RuntimeDiagnostics } | { ok: false; error: RuntimeError };
  getInterpolatedState(): { ok: true; state: InterpolatedState } | { ok: false; error: RuntimeError };
  /**
   * Phase 21.2: the same interpolated transforms without allocating — each
   * entity (draw order) handed to `visit` in reused arrays. False when disposed.
   */
  forEachInterpolated?(visit: InterpolatedVisitor): boolean;
  /**
   * Phase 25.17 (D51): visit every entity's committed transform — the state
   * after the last step, not blended with the step before by the last frame's
   * interpolation alpha (which depends on when frames came). What digests of
   * the simulation hash.
   */
  forEachCommitted?(visit: InterpolatedVisitor): boolean;
  /** Phase 21.2: one entity's interpolated transform into the caller's arrays; false when disposed or unknown. */
  readInterpolated?(id: string, position: number[], rotation: number[], scale: number[]): boolean;
  /**
   * Phase 23.4: the view the camera brain resolved (virtual cameras), interpolated like the transforms —
   * `position`/`rotation` written, its lens returned; null without a virtual camera (draw the camera entity).
   */
  readCameraView?(position: number[], rotation: number[]): { fovY: number; near: number; far: number; letterbox: number } | null;
  /** Phase 23.4: the committed camera view (live camera, blend, pose, lens), or null without a virtual camera. */
  cameraView?(): import('./camera-brain').CameraViewInfo | null;
  /** Phase 23.4: the viewport the view is drawn in (screen↔world projection uses its aspect). */
  setCameraViewport?(width: number, height: number): boolean;
  /** Phase 23.11: the objects riding on sockets now (entity, target, node; a stable array while nothing changes). */
  socketAttachments?(): readonly { readonly entityId: string; readonly target: string; readonly node: string }[];
  /**
   * Phase 23.9a: queue a UI event (a click, a submit, a focus change, a
   * show/hide from a button) for the next sampled input frame (`ActionFrame.ui`).
   */
  queueUiEvent?(event: import('./ui').UiEventRecord): { ok: true } | { ok: false; error: RuntimeError };
  /** Phase 23.9a: the view-model writes, shown documents and presentation commands since the last take (null: none). */
  takeUiOutput?(): import('./ui').UiOutput | null;
  /** Phase 23.9a: the committed view model and shown documents. */
  uiView?(): import('./ui').UiStateView;
  /** Phase 23.16: queue a dialogue input (advance, choose, skip, auto, backlog) for the next sampled input frame (`ActionFrame.dialogue`). */
  queueDialogueInput?(input: import('./dialogue').DialogueInputRecord): { ok: true } | { ok: false; error: RuntimeError };
  /** Phase 23.16: the dialogue runner's state as digest text (null while nothing used dialogue). */
  dialogueState?(): string | null;
  /** Phase 23.16: the conversation now, for observers (null while nothing used dialogue). */
  dialogueView?(): Record<string, unknown> | null;
  /** Phase 23.10: the game modes as of the last step (null: the project has none). */
  modeView?(): import('./modes').ModeView | null;
  /** Phase 23.17: the timelines' screen overlay (fade, letterbox), plays and last events (null until one played). */
  timelineView?(): import('./timeline').TimelineView | null;
  /** Phase 23.17: the timelines' state for the step digest (null until one played). */
  timelineState?(): string | null;
  /** Phase 23.3: the cursor a script asked for ('free' | 'locked'), or null — the active input map decides. */
  cursorRequest?(): 'free' | 'locked' | null;
  /** Phase 23.3: the pointer as of the last step (position, held buttons, over/locked; null before the first sample). */
  readPointer?(): import('./actions').PointerSample | null;
  /**
   * Phase 23.14: the binding requests scripts made since the last call
   * (`ctx.input.rebind`, …) and how many were dropped over the per-step
   * limit; the host carries them out after the frame.
   */
  takeBindingRequests?(): { readonly requests: readonly import('./input-status').InputBindingRequest[]; readonly dropped: number };
  getCamera():{ ok: true; camera: CameraInfo } | { ok: false; error: RuntimeError };
  /** Idempotent: second call ⇒ `{ ok: true, alreadyDisposed: true }`. */
  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: RuntimeError };

  // ---- Phase 12 (c) scene set (v4 snapshots with a scene catalog) ---------
  /** The loaded scenes and every scene's status. */
  sceneSet?(): SceneSetView;
  /** The loads requested since the last call; the host fetches each and answers with `provideScene`. */
  takeSceneRequests?(): SceneLoadRequest[];
  /**
   * Answer a load request: the scene's resolved entities (applied at the next
   * step boundary) or a failure (the scene returns to `unloaded`, logged).
   */
  provideScene?(sceneId: string, result: { ok: true; entities: readonly EntityV3[] } | { ok: false; message: string }): { ok: true } | { ok: false; error: RuntimeError };
  /** Request a load/unload from outside a step (host, MCP); same rules as `ctx.scenes`. */
  requestScene?(op: 'load' | 'unload', sceneId: string, options?: SceneLoadOptions): { ok: true } | { ok: false; error: RuntimeError };
  /** Phase 24.6: a start's spawn in a game without the session: the character arrives there once the scene is loaded. */
  requestArrival?(sceneId: string, spawnId: string): { ok: true } | { ok: false; error: RuntimeError };
  /** Phase 22.0: why `requestScene(op, sceneId)` would be refused now (null: accepted); changes nothing. */
  sceneRequestProblem?(op: 'load' | 'unload', sceneId: string): string | null;
  /** Phase 25.24e: the scenes being loaded, the transition waiting and the last swap (a loading screen, the fade). */
  sceneLoadingView?(): SceneLoadingView;

  // ---- Phase 23.8 debug commands -------------------------------------------
  /** The registered debug commands and the calls the game ran (newest last, at most 16). */
  debugCommandState?(): DebugCommandState;
  /**
   * Queue one debug command call for the next executed step (it rides on that
   * step's input frame, so a recording of the run replays it). Refused when
   * the command is not declared (by the engine or a script), the arguments do not match its
   * declaration, or 16 calls are already waiting.
   */
  queueDebugCommand?(call: DebugCommandCall): { ok: true } | { ok: false; error: RuntimeError };

  // ---- Phase 23.19 project saves --------------------------------------------
  /** The save/load/delete/settings requests scripts made since the last call (the host owns storage). */
  takeSaveRequests?(): import('./project-saves').SaveRequest[];
  /**
   * Phase 24.4j: the player's save from the game shell — the save is made now,
   * between steps (the state of the last step), and handed to the host with
   * the next requests; the outcome arrives as a storage answer.
   */
  requestSave?(slot: number, meta?: import('./project-saves').SaveMeta): { ok: true } | { ok: false; error: RuntimeError };
  /** Phase 24.4j: every object's health now (object id → current and max; the HUD's `$flow.health`). */
  healthsView?(): Readonly<Record<string, { readonly current: number; readonly max: number }>>;
  /** Phase 24.4j: the shell's scene list entry the run is at (-1: none). */
  listedSceneIndex?(): number;
  /** Queue one storage answer for the next executed step (it rides on that step's input frame). */
  queueSaveEvent?(event: import('./project-saves').SaveEvent): { ok: true } | { ok: false; error: RuntimeError };
  /** The project saves state as digest text (null without a save schema or before any save activity). */
  savesState?(): string | null;
  /** The project settings document now. */
  projectSettings?(): Readonly<Record<string, boolean | number | string>>;
}

/** One interpolated transform (runtime.md §6). */
export interface InterpolatedTransform {
  id: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** Display state (runtime.md §6): `0 ≤ alpha < 1`, snapshot document order. */
export interface InterpolatedState {
  stepIndex: number;
  simTime: number;
  alpha: number;
  transforms: InterpolatedTransform[];
}

/**
 * Phase 21.2: a visitor of `Runtime.forEachInterpolated` — one entity's
 * interpolated transform in arrays the runtime reuses (read or copy them
 * during the call; they hold the next entity after it).
 */
export type InterpolatedVisitor = (id: string, position: readonly number[], rotation: readonly number[], scale: readonly number[]) => void;

/** The snapshot's camera projection parameters (runtime.md §6 `getCamera`). */
export interface CameraInfo {
  id: string;
  fovY: number;
  near: number;
  far: number;
}

/** One bounded diagnostic error entry (runtime.md §8). */
export interface DiagnosticErrorEntry {
  /** `behavior_log` is a diagnostics-only entry code (runtime.md §14.8.1); phase 25.10: `entity_write` (a refused or conflicting component write). */
  code: ErrorCode | 'behavior_log' | 'entity_write';
  message: string;
  stepIndex?: number;
  /** M2 fail-stop entries only. */
  moduleId?: string;
  phase?: SimulationPhase;
  reason?: string;
  /** The contract's short detail token (e.g. `duplicate_writer`). */
  detail?: string;
  /** Phase 19.0: the visual-script node the error came from (graph behaviors only). */
  nodeId?: string;
  /**
   * Phase 25.9: where in the project's compiled scripts (`behaviors/<digest>.js`,
   * `libraries/<digest>.js`; 1-based line and column) a log was called or an
   * error thrown; the Play backend maps it back to the source file.
   */
  at?: { file: string; line: number; column: number };
  /** Phase 25.9: an error's project frames, innermost first (at most 4; `at` is the first). */
  frames?: { file: string; line: number; column: number }[];
}

/**
 * Structured diagnostics (runtime.md §8; works in every state).
 *
 * The M2-only fields below are present exactly when the runtime is an M2
 * module set; M1 sets keep the accepted M1 field set (frozen regression).
 */
export interface RuntimeDiagnostics {
  state: RuntimeStateName;
  snapshotId: string;
  revision: number;
  simTime: number;
  stepIndex: number;
  fixedStepHz: number;
  /** Cumulative catch-up drops (runtime.md §5.4). */
  droppedSteps: number;
  /** §5 frame updates, including zero-step frames. */
  frameCount: number;
  entityCount: number;
  /** Selected module IDs (registration order). */
  modules: string[];
  /** `"performance"` (default clock) or `"injected"` (config clock). */
  clock: 'performance' | 'injected';
  /** Non-monotonic `clock()` observations (no step, no error). */
  clockWarningCount: number;
  /** Last 32 error entries (bounded ring). */
  errors: DiagnosticErrorEntry[];
  /** Cumulative (unbounded count; the ring stays bounded). */
  errorCount: number;

  // ---- M2 module sets only (runtime.md §8/§13) ---------------------------
  /** Sticky: `true` iff the runtime entered the §13 failed state. */
  failed?: boolean;
  failedModuleId?: string;
  failedPhase?: SimulationPhase;
  failedStepIndex?: number;
  /** Executed-step action samples. */
  inputSamples?: number;
  /** Dropped steps that consequently had no sample. */
  droppedInputSteps?: number;
  /** `12` for M2 sets after the pre-roll, else `0`. */
  settleSteps?: number;
  /** `port.step()` calls. */
  physicsSteps?: number;
  inputSuspendCount?: number;
  inputActivateCount?: number;
  inputDisconnectCount?: number;
  inputMappingUnsupportedCount?: number;
  physicsStallSteps?: number;
  physicsPenetrationCorrectedCount?: number;
  /** Accepted intents committed in this runtime instance (runtime.md §14.8.1). */
  intentCommitCount?: number;
  /** Behavior `ctx.log` calls accepted into the per-instance rings. */
  logCount?: number;
  /** Behavior `ctx.log` calls rejected by the per-step bound. */
  logDropped?: number;
  /**
   * Phase 25.10: `ctx.entity(id).set` writes — applied, refused (each noted in
   * `errors` as `entity_write`/`refused` once per step and field), conflicts
   * (a field written twice in a step; `entity_write`/`conflict`) and the
   * objects switched off now. Present once a script wrote.
   */
  entityWrites?: { applied: number; refused: number; conflicts: number; inactive: number };

}
