/**
 * Runtime public types: the snapshot, the lifecycle API, the mutable
 * simulation state, scheduling and interpolation, module shapes,
 * diagnostics, phases, ports, transform ownership and the fail-stop.
 *
 * These are the type surface of the `runtime` package (snapshot,
 * diagnostics, module interfaces, `ActionFrame`, `JumpPhase`,
 * `ActionSource`, `createRecordedActionSource`, `SimulationPhase`,
 * `StepContext`, `GameplaySettings`, `PhysicsPort`, `PhysicsStepClient`).
 */
import type { EntityV3, Quat, Vec3 } from '@thirdlight/project-model';

import type { ActionFrame, ActionSource, DebugCommandCall } from './actions';
import type { ErrorCode, RuntimeError } from './errors';
import type { PhysicsPort, PhysicsStepClient } from './ports';
import { registryBrand, type SimulationPhase, type TransformState } from './types-simulation';
import { type DebugCommandState, type EffectRequest } from './types-behavior';
import { type SceneLoadingView, type SceneLoadOptions, type SceneLoadRequest, type SceneSetView } from './types-scene';
export type { RuntimeSnapshotEntity, RuntimeScene, RuntimeSnapshot, RuntimeEventCue, ModelBounds, RuntimeSceneRow, ListedScene, SceneStatus, SceneLoadOptions, SceneActivateOptions, SceneTransitionView, SceneLoadingView, BehaviorSceneControl, BehaviorWorldView, WorldTransformOptions, BehaviorRandomStream, BehaviorRandom, LoadedSceneBatch, SceneSetView, SceneLoadRequest, GameplaySettings } from './types-scene';
export { SIMULATION_PHASE_ORDER } from './types-simulation';
export type { InstantiateConfig, TransformState, SimEntityData, SimState, ModuleConfig, Character3DQueries, SimulationModule, SimulationPhase, PlayerCapsule, ModuleResetContext, SimulationPhaseModule, StepContext, ClimbQuery, BehaviorShell, SimulationModuleSpec, SimulationRegistry } from './types-simulation';
export type { BehaviorMessage, BehaviorMessages, BehaviorMessageControl, TriggerEventRecord, HealthEventRecord, ContactEventRecord, PatrolEventRecord, CollectEventRecord, PrimitiveEventRecord, BehaviorTimers, BehaviorSpawnControl, BehaviorSave, DebugCommandArgType, DebugCommandArgSpec, DebugCommandOptions, DebugCommandSpec, DebugCommandArgs, DebugCommandState, BehaviorDebug, AudioFinishedEvent, AudioPlayOptions, AudioStingerOptions, AudioMusicOptions, AudioMusicState, BehaviorAudio, EffectRequest, BehaviorEffects } from './types-behavior';
export type { CameraBlendOptions, BehaviorCameraState, BehaviorUiEvent, BehaviorUiView, BehaviorStats, BehaviorStatsTime, BehaviorDisplay, EnvironmentChangeOptions, BehaviorEnvironment, BehaviorUi, DialogueVariableValue, BehaviorDialogueEvent, BehaviorDialogueState, BehaviorDialogueHistoryEntry, BehaviorDialogue, BehaviorModeEvent, BehaviorModeTransition, BehaviorModes, BehaviorLifecycle, BehaviorTimelineEvent, BehaviorTimeline, BehaviorCamera, BehaviorSockets, BehaviorSignals, BehaviorGameState, BehaviorHealth, BehaviorPatrol, BehaviorHitbox, BehaviorCollectible, BehaviorCharacter, BehaviorLookValue, BehaviorLook, BehaviorAnimatorHandle, BehaviorAnimatorControl, AnimatorEventRecord, BehaviorTagQuery } from './types-behavior-world';
export { registryBrand as SIM_REGISTRY_BRAND };

/** Lifecycle states. */
export type RuntimeStateName = 'instantiated' | 'running' | 'stopped' | 'failed' | 'disposed';

/** The runtime instance (every call returns a result). */
export interface Runtime {
  start(): { ok: true } | { ok: false; error: RuntimeError };
  stop(): { ok: true } | { ok: false; error: RuntimeError };
  /** Pause or resume the simulation (frames still render). */
  setPaused?(paused: boolean): void;
  readonly isPaused?: boolean;
  /** The last frame's interpolation alpha (as `getInterpolatedState().state.alpha`), without building the state. */
  readonly interpolationAlpha?: number;
  /** Sim seconds the drawn state advances per wall second after the last frame (0 while paused, held or stopped). */
  readonly interpolationRate?: number;
  /**
   * Play debugging: hold the simulation at a step boundary or
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
  /** Told after every executed step (settle steps excluded) with the step count; never holds. */
  setStepObserver?(observer: ((stepIndex: number) => void) | null): void;
  /**
   * Where this run began: the step count (0, or the boundary of the last restart), the last spawned copy's
   * number then, and the run's number (0 for the run the play started with, one more per restart applied).
   */
  runStart?(): { readonly step: number; readonly spawnBase: number; readonly run?: number };
  behaviorDebug?(filter?: { behaviorId?: string; entityId?: string }): { behaviorId: string; entityId: string; debug: unknown }[];
  /** Entities hidden (collected collectibles, `ctx.game.setVisible`; the renderer hides them). */
  hiddenEntities?(): ReadonlySet<string>;
  /** The per-object look overrides scripts set (ctx.look; the renderer applies them). */
  entityLooks?(): ReadonlyMap<string, import('./primitives').EntityLook>;
  /** The objects scripts switched off, with their children (also in `hiddenEntities`; audio sources are silent). */
  inactiveEntities?(): ReadonlySet<string>;
  /** The light values scripts wrote (`ctx.entity(id).set('light', …)`); the renderer applies them. */
  lightOverrides?(): ReadonlyMap<string, import('./entity-access').LightOverride>;
  /** The material swaps made (slot → material over each object's authored mapping); the renderer puts them on once loaded. */
  materialSwaps?(): ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** The block types' material swaps, by block id; the renderer puts them on once loaded. */
  blockMaterialSwaps?(): ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** The fields scripts wrote as digest text (null while none). */
  entityFieldsState?(): string | null;
  /** The sounds scripts played since the last call. The audio intent log's commands. */
  takeAudioRequests?(): import('./audio-mixer').AudioCommand[];
  /** The audio intent log's deterministic state (digests; null while scripts never used audio). */
  audioState?(): Record<string, unknown> | null;
  /** The effect requests (scripts, effect-component signals, gameplay hooks) since the last call; the adapter plays them. */
  takeEffectRequests?(): EffectRequest[];
  /** The block-layer chunks to re-mesh since the last call (their cells now); the adapter applies them. */
  takeGridChanges?(): import('./grid').GridRenderChange[];
  /** The block cells changed since the run started (plain data). */
  gridDiff?(): import('./grid').GridDiff;
  /** The material parameters scripts changed since the last call (one change per parameter); the adapter applies them. */
  takeMaterialChanges?(): import('./material-params').MaterialRenderChange[];
  /** The material parameters scripts set, as digest text (null while none is set). */
  materialState?(): string | null;
  /**
   * The environment blend (preset weights) interpolated like the transforms,
   * or null until a script changed the environment (the renderer then draws the static look).
   */
  readEnvironmentBlend?(): import('./environment-blend').EnvironmentBlendView | null;
  /** The committed environment blend as digest text (null until a script changed it). */
  environmentState?(): string | null;
  /** The run's counters and the character's health. */
  gameCounters?(): { counters: Record<string, number>; health: { current: number; max: number } | null };
  /** Manual driver only; rAF driver ⇒ `tick_not_allowed`. */
  tick(nowSeconds: number): { ok: true } | { ok: false; error: RuntimeError };
  getDiagnostics(): { ok: true; diagnostics: RuntimeDiagnostics } | { ok: false; error: RuntimeError };
  getInterpolatedState(): { ok: true; state: InterpolatedState } | { ok: false; error: RuntimeError };
  /**
   * The same interpolated transforms without allocating — each
   * entity (draw order) handed to `visit` in reused arrays. False when disposed.
   */
  forEachInterpolated?(visit: InterpolatedVisitor): boolean;
  /**
   * Only the entities whose interpolated transform changed since the last
   * call (every entity at the first call and when the entity order changed),
   * handed out like `forEachInterpolated` — a presenter that keeps the last
   * transforms needs no others. One presenter reads it (a call takes what
   * changed). False when disposed.
   */
  forEachMoved?(visit: InterpolatedVisitor): boolean;
  /**
   * Visit every entity's committed transform — the state
   * after the last step, not blended with the step before by the last frame's
   * interpolation alpha (which depends on when frames came). What digests of
   * the simulation hash.
   */
  forEachCommitted?(visit: InterpolatedVisitor): boolean;
  /** Every entity's last two finished steps (before and after the last step), the pair the interpolation blends. */
  forEachStepPair?(visit: StepPairVisitor): boolean;
  /** One entity's interpolated transform into the caller's arrays; false when disposed or unknown. */
  readInterpolated?(id: string, position: number[], rotation: number[], scale: number[]): boolean;
  /**
   * A view as its camera brain resolved it (the engine owns the view), interpolated like the transforms —
   * `position`/`rotation` written, its lens returned (the default pose before the first step); null for an unknown view. `view`: the view's key (absent: the main view).
   */
  readCameraView?(position: number[], rotation: number[], view?: string): { fovY: number; near: number; far: number; letterbox: number } | null;
  /** `readCameraView` at a given alpha between the last two steps. */
  readCameraViewAt?(alpha: number, position: number[], rotation: number[], view?: string): { fovY: number; near: number; far: number; letterbox: number } | null;
  /** A view's committed state (live camera, blend, pose, lens), or null before the first step. */
  cameraView?(view?: string): import('./camera-brain').CameraViewInfo | null;
  /** The viewport a view is drawn in (screen↔world projection uses its aspect). */
  setCameraViewport?(width: number, height: number, view?: string): boolean;
  /** The view the UI is drawn over (CSS px, device pixels per CSS px) — what `ctx.ui.view()` reads. */
  setUiView?(width: number, height: number, pixelRatio: number): boolean;
  /** The page's frame statistics, once per stats window — what `ctx.stats` reads (false: not stats). */
  setStats?(stats: unknown): boolean;
  /** The game's frame-rate cap (`ctx.display.frameRateCap`): 30, 60 or 120 fps, null for none. */
  frameRateCap?(): number | null;
  /** Set the game's frame-rate cap (30, 60, 120, or null for none; a player's setting, the UI); false for another value. */
  setFrameRateCap?(fps: unknown): boolean;
  /**
   * Pace the frames at this cap whatever the game sets (null: uncapped — a
   * measurement), or follow the game's again (undefined); false for another value.
   */
  pinFrameRateCap?(fps: unknown): boolean;
  /** How the animation frames were paced under the cap. */
  framePacing?(): import('./frame-pacing').FramePacingStats;
  /** The objects riding on sockets now (entity, target, node; a stable array while nothing changes). */
  socketAttachments?(): readonly { readonly entityId: string; readonly target: string; readonly node: string }[];
  /**
   * Queue a UI event (a click, a submit, a focus change, a
   * show/hide from a button) for the next sampled input frame (`ActionFrame.ui`).
   */
  queueUiEvent?(event: import('./ui').UiEventRecord): { ok: true } | { ok: false; error: RuntimeError };
  /** The view-model writes, shown documents and presentation commands since the last take (null: none). */
  takeUiOutput?(): import('./ui').UiOutput | null;
  /** The committed view model and shown documents. */
  uiView?(): import('./ui').UiStateView;
  /** Queue a dialogue input (advance, choose, skip, auto, backlog) for the next sampled input frame (`ActionFrame.dialogue`). */
  queueDialogueInput?(input: import('./dialogue').DialogueInputRecord): { ok: true } | { ok: false; error: RuntimeError };
  /** The dialogue runner's state as digest text (null while nothing used dialogue). */
  dialogueState?(): string | null;
  /** The conversation now, for observers (null while nothing used dialogue). */
  dialogueView?(): Record<string, unknown> | null;
  /** The game modes as of the last step (null: the project has none). */
  modeView?(): import('./modes').ModeView | null;
  /** The timelines' screen overlay (fade, letterbox), plays and last events (null until one played). */
  timelineView?(): import('./timeline').TimelineView | null;
  /** The timelines' state for the step digest (null until one played). */
  timelineState?(): string | null;
  /** The cursor a script asked for ('free' | 'locked'), or null — the active input map decides. */
  cursorRequest?(): 'free' | 'locked' | null;
  /** The pointer as of the last step (position, held buttons, over/locked; null before the first sample). */
  readPointer?(): import('./actions').PointerSample | null;
  /**
   * The binding requests scripts made since the last call
   * (`ctx.input.rebind`, …) and how many were dropped over the per-step
   * limit; the host carries them out after the frame.
   */
  takeBindingRequests?(): { readonly requests: readonly import('./input-status').InputBindingRequest[]; readonly dropped: number };
  getCamera():{ ok: true; camera: CameraInfo } | { ok: false; error: RuntimeError };
  /** Idempotent: second call ⇒ `{ ok: true, alreadyDisposed: true }`. */
  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: RuntimeError };

  // ---- Scene set (v4 snapshots with a scene catalog) ---------------------
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
  /** A start's spawn: the character arrives there once the scene is loaded. */
  requestArrival?(sceneId: string, spawnId: string): { ok: true } | { ok: false; error: RuntimeError };
  /** Why `requestScene(op, sceneId)` would be refused now (null: accepted); changes nothing. */
  sceneRequestProblem?(op: 'load' | 'unload', sceneId: string): string | null;
  /** The scenes being loaded, the transition waiting and the last swap (a loading screen, the fade). */
  sceneLoadingView?(): SceneLoadingView;

  // ---- Debug commands -----------------------------------------------------
  /** The registered debug commands and the calls the game ran (newest last, at most 16). */
  debugCommandState?(): DebugCommandState;
  /**
   * Queue one debug command call for the next executed step (it rides on that
   * step's input frame, so a recording of the run replays it). Refused when
   * the command is not declared (by the engine or a script), the arguments do not match its
   * declaration, or 16 calls are already waiting.
   */
  queueDebugCommand?(call: DebugCommandCall): { ok: true } | { ok: false; error: RuntimeError };

  // ---- Project saves ------------------------------------------------------
  /** The save/load/delete/settings requests scripts made since the last call (the host owns storage). */
  takeSaveRequests?(): import('./project-saves').SaveRequest[];
  /** Problems for the author since the last call (the host relays each to Play's Problems; one per kind). */
  takeProblems?(): { code: string; message: string }[];
  /**
   * The player's save from the game shell — the save is made now,
   * between steps (the state of the last step), and handed to the host with
   * the next requests; the outcome arrives as a storage answer.
   */
  requestSave?(slot: number, meta?: import('./project-saves').SaveMeta): { ok: true } | { ok: false; error: RuntimeError };
  /** Every object's health now (object id → current and max; the HUD's `$flow.health`). */
  healthsView?(): Readonly<Record<string, { readonly current: number; readonly max: number }>>;
  /** The shell's scene list entry the run is at (-1: none). */
  listedSceneIndex?(): number;
  /** Queue one storage answer for the next executed step (it rides on that step's input frame). */
  queueSaveEvent?(event: import('./project-saves').SaveEvent): { ok: true } | { ok: false; error: RuntimeError };
  /** The project saves state as digest text (null without a save schema or before any save activity). */
  savesState?(): string | null;
  /** The project settings document now. */
  projectSettings?(): Readonly<Record<string, boolean | number | string>>;

  // ---- Scripts' asset handles ------------------------------------------------
  /** The loads and releases scripts asked for since the last call (the host holds the assets). */
  takeAssetRequests?(): import('./asset-handles').AssetHandleRequest[];
  /** Queue the host's answer to one load for the next executed step (it rides on that step's input frame). */
  queueAssetAnswer?(answer: import('./asset-handles').AssetHandleAnswer): { ok: true } | { ok: false; error: RuntimeError };
  /** The scripts' asset handles as digest text (null before any was used). */
  assetHandlesState?(): string | null;
}

/** One interpolated transform. */
export interface InterpolatedTransform {
  id: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** Display state: `0 ≤ alpha < 1`, snapshot document order. */
export interface InterpolatedState {
  stepIndex: number;
  simTime: number;
  alpha: number;
  transforms: InterpolatedTransform[];
}

/**
 * A visitor of `Runtime.forEachInterpolated` — one entity's
 * interpolated transform in arrays the runtime reuses (read or copy them
 * during the call; they hold the next entity after it).
 */
export type InterpolatedVisitor = (id: string, position: readonly number[], rotation: readonly number[], scale: readonly number[]) => void;
/** One entity's transform before and after the last step (`forEachStepPair`). */
export type StepPairVisitor = (id: string, prev: TransformState, curr: TransformState) => void;

/** The main view's key and the project's lens, the view's while no camera sets its own (`getCamera`). */
export interface CameraInfo {
  /** The view's key (`DEFAULT_VIEW_ID`). */
  id: string;
  fovY: number;
  near: number;
  far: number;
}

/** One bounded diagnostic error entry. */
export interface DiagnosticErrorEntry {
  /** `behavior_log` is a diagnostics-only entry code; `entity_write` (a refused or conflicting component write). */
  code: ErrorCode | 'behavior_log' | 'entity_write';
  message: string;
  stepIndex?: number;
  /** M2 fail-stop entries only. */
  moduleId?: string;
  phase?: SimulationPhase;
  reason?: string;
  /** The contract's short detail token (e.g. `duplicate_writer`). */
  detail?: string;
  /** The visual-script node the error came from (graph behaviors only). */
  nodeId?: string;
  /**
   * Where in the project's compiled scripts (`behaviors/<digest>.js`,
   * `libraries/<digest>.js`; 1-based line and column) a log was called or an
   * error thrown; the Play backend maps it back to the source file.
   */
  at?: { file: string; line: number; column: number };
  /** An error's project frames, innermost first (at most 4; `at` is the first). */
  frames?: { file: string; line: number; column: number }[];
}

/**
 * Structured diagnostics (works in every state).
 *
 * The M2-only fields below are present exactly when the runtime is an M2
 * module set.
 */
export interface RuntimeDiagnostics {
  state: RuntimeStateName;
  snapshotId: string;
  revision: number;
  simTime: number;
  stepIndex: number;
  fixedStepHz: number;
  /** Cumulative catch-up drops. */
  droppedSteps: number;
  /** Frame updates, including zero-step frames. */
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

  // ---- M2 module sets only ---------------------------
  /** Sticky: `true` iff the runtime entered the failed state. */
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
  /** The deepest overlap the character began a step in: the character's and the collider's entities, how deep (m), the physics step (`physicsSteps` counts them). */
  physicsDeepestOverlap?: { entities: [string, string]; depth: number; physicsStep: number };
  /** Accepted intents committed in this runtime instance. */
  intentCommitCount?: number;
  /** Behavior `ctx.log` calls accepted into the per-instance rings. */
  logCount?: number;
  /** Behavior `ctx.log` calls rejected by the per-step bound. */
  logDropped?: number;
  /**
   * `ctx.entity(id).set` writes — applied, refused (each noted in
   * `errors` as `entity_write`/`refused` once per step and field), conflicts
   * (a field written twice in a step; `entity_write`/`conflict`) and the
   * objects switched off now. Present once a script wrote.
   */
  entityWrites?: { applied: number; refused: number; conflicts: number; inactive: number };
  /**
   * `ctx.messages.send` calls refused at the per-step limit over the play,
   * the first and last step one was, and a warning that says so. Present
   * once a send was refused.
   */
  messageQueue?: { refused: number; firstRefusedStep: number; lastRefusedStep: number; perStepLimit: number; warning: string };

}
