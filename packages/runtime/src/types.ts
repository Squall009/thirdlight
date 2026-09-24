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
import type {
  AnimatorController,
  CameraFollowComponent,
  CheckpointActivationAppearance,
  EntityV3,
  GameConfig,
  GameplaySettings as ModelGameplaySettings,
  GameZoneRole,
  Quat,
  Scene,
  SceneV2,
  ResolvedSceneV3,
  TagDefinition,
  Vec3,
} from '@thirdlight/project-model';

/** The gameplay-zone role set (project-model §23.3.1) — canonical home here per gameplay.md §11. */
export type { GameZoneRole };
import type { ActionFrame, ActionSource } from './actions';
import type { BehaviorIntent, BehaviorLogLevel, IntentSet } from './intents';
import type { ErrorCode, RuntimeError } from './errors';
import type { PhysicsPort, PhysicsStepClient, Vec2 } from './ports';

/** One entity of any supported normalized scene version. */
export type RuntimeSnapshotEntity =
  | Scene['entities'][number]
  | SceneV2['entities'][number]
  | ResolvedSceneV3['entities'][number];

/**
 * A complete normalized scene document of any supported version
 * (project-model §8/§12.2 for `schemaVersion` 1, §13 for 2, §23 for 3).
 */
export interface RuntimeScene {
  schemaVersion: 1 | 2 | 3 | 4;
  sceneId: string;
  revision: number;
  entities: RuntimeSnapshotEntity[];
}

/**
 * The runtime snapshot (runtime.md §2; M3 addition in §15.3/`gameplay.md`
 * §4.1) — the ONLY input of a runtime instance. `scene` is a complete
 * normalized scene document; `game` carries the frozen v3
 * `content.game` block (project-model §23.4) and is present exactly for a
 * `schemaVersion` 3 snapshot (where it may be `null`, which an M3-enabled
 * module set rejects as `config_invalid`, reason `game_config`).
 */
export interface RuntimeSnapshot {
  /** Exactly `<projectId>@r<revision>` (project-model §6). */
  snapshotId: string;
  projectId: string;
  /** Integer, 0 ≤ v ≤ 2^53−1; must equal `scene.revision`. */
  revision: number;
  scene: RuntimeScene;
  /** v3 only: the frozen `content.game` block, or `null`. */
  game?: GameConfig | null;
  /**
   * Phase 12 (b), v3 only, optional: the project tag registry (`content.tags`).
   * The entities carry their effective masks once the scene is resolved.
   */
  tags?: readonly TagDefinition[];
  /**
   * Phase 12 (c), v4 only, optional: every scene of the project. `start`
   * scenes are merged into `scene` (their members listed in `entityIds`); the
   * others load on demand (`ctx.scenes.load`, an exit zone). Absent: the
   * whole snapshot scene is one fixed scene and the scene API is unavailable.
   */
  scenes?: readonly RuntimeSceneRow[];
  /** Phase 9.7, v4 only, optional: the project's animator controllers (`content.animators`). */
  animators?: readonly AnimatorController[];
}

/** Phase 12 (c): one scene of the project as the runtime knows it. */
export interface RuntimeSceneRow {
  sceneId: string;
  start: boolean;
  /** Start scenes: the ids of their (resolved) entities in the snapshot scene. */
  entityIds?: readonly string[];
}

/** Phase 12 (c): where a scene is in its load cycle. */
export type SceneStatus = 'unloaded' | 'loading' | 'loaded';

/**
 * Phase 12 (c): options of one scene load. `at` offsets the scene's root
 * entities (world units). Loads are keyed by scene id today; the batch shape
 * leaves room for keyed, repeated (instanced) loads of one scene later.
 */
export interface SceneLoadOptions {
  at?: readonly [number, number, number];
}

/** Phase 12 (c): the scene API a behavior script reaches as `ctx.scenes`. */
export interface BehaviorSceneControl {
  /** Request a load; it completes at a later step boundary. Loading or loaded ⇒ no-op. */
  load(sceneId: string, options?: SceneLoadOptions): void;
  /** Request an unload at the next step boundary. Unloaded ⇒ no-op. */
  unload(sceneId: string): void;
  status(sceneId: string): SceneStatus;
  /** The loaded scene ids, in load order. */
  loaded(): readonly string[];
}

/** Phase 12 (c): a read-only view of entity transforms (`ctx.world`). */
export interface BehaviorWorldView {
  /** The entity's current transform (this step so far), or `undefined` when it is not loaded. */
  transform(entityId: string): Readonly<{ position: readonly [number, number, number]; rotation: readonly [number, number, number, number]; scale: readonly [number, number, number] }> | undefined;
}

/** Phase 12 (c): one loaded scene as the runtime holds it (renderer/host view). */
export interface LoadedSceneBatch {
  readonly sceneId: string;
  readonly start: boolean;
  /** The scene's resolved entities (offset already applied), frozen. */
  readonly entities: readonly EntityV3[];
}

/** Phase 12 (c): the scene set the renderer syncs to (`revision` bumps on every change). */
export interface SceneSetView {
  readonly revision: number;
  readonly batches: readonly LoadedSceneBatch[];
  readonly status: Readonly<Record<string, SceneStatus>>;
}

/** Phase 12 (c): a load the host must fetch (`takeSceneRequests`). */
export interface SceneLoadRequest {
  readonly sceneId: string;
  readonly at?: readonly [number, number, number];
}

/** The resolved gameplay settings (runtime.md §12.2; project-model §14). */
export type GameplaySettings = ModelGameplaySettings;

/** Config accepted by `instantiateRuntime` (runtime.md §3.1; strict shape). */
export interface InstantiateConfig {
  snapshot: RuntimeSnapshot;
  registry: SimulationRegistry;
  /** Module IDs present in `registry`. Default `["thirdlight.demo:box-motion"]`. */
  modules?: readonly string[];
  /** The injected per-step input port (runtime.md §12.5). Default: neutral frames. */
  actions?: ActionSource;
  /** An already-initialized physics port (runtime.md §12.6). Required by port-requiring sets. */
  physics?: PhysicsPort;
  /** Gameplay settings input, resolved + deep-frozen at instantiate. Default: registry defaults. */
  settings?: unknown;
  /** Monotonic seconds. Default `performance.now() / 1000`. */
  clock?: () => number;
  /** `"raf"` requires `requestAnimationFrame`; `"manual"` = host calls `tick`. */
  driver?: { kind: 'raf' } | { kind: 'manual' };
  /** Integer 1 ≤ v ≤ 1000. Default 120 (the M1 constant). */
  fixedStepHz?: number;
  /** Called once per frame after the step update (runtime.md §6 frame ordering). */
  onFrame?: () => void;
}

/**
 * The independent mutable simulation state (runtime.md §4). `prev`/`curr`
 * hold the transforms at the end of step n−1 / step n; every simulation
 * mutation writes only here, never to the (deep-frozen) snapshot.
 */
export interface TransformState {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** Per-entity simulation data (runtime.md §4 `entities` map values). */
export interface SimEntityData {
  id: string;
  parentId: string | null;
  name?: string;
  transform: TransformState;
  box?: { size: Vec3; material: { color: string } };
  camera?: { type: 'perspective'; fovY: number; near: number; far: number };
  /** v2 marker: the entity carries `components.collider`. */
  hasCollider?: true;
  /** v2 marker: the entity carries `components.controller`. */
  hasController?: true;
}

export interface SimState {
  /** Entity IDs in snapshot document order. */
  order: readonly string[];
  entities: ReadonlyMap<string, SimEntityData>;
  stepIndex: number;
  /** Always `stepIndex / fixedStepHz` (single division, no accumulation). */
  simTime: number;
  /** Transforms at the end of step n−1. */
  prev: Map<string, TransformState>;
  /** Transforms at the end of step n (modules mutate this in place). */
  curr: Map<string, TransformState>;
}

/**
 * Module config passed to `SimulationModuleSpec.create` (runtime.md §7.2/§12.1;
 * the M3 `sceneVersion`/`game` additions are gameplay.md §3.4 / runtime.md §15).
 */
export interface ModuleConfig {
  fixedStepHz: number;
  /** The resolved, deep-frozen gameplay settings (M2 sets). */
  settings: Readonly<GameplaySettings>;
  /** The snapshot's `schemaVersion` (1, 2 or 3). */
  sceneVersion: 1 | 2 | 3 | 4;
  /**
   * v3 only: the frozen `content.game` block carried inside the snapshot
   * (runtime.md §2 M3 note). `null` on a v3 snapshot whose content has no
   * game block (an M3-enabled module set rejects it as `game_config`).
   */
  game?: Readonly<GameConfig> | null;
  /**
   * The runtime's bounded diagnostics sink for behavior `ctx.log` calls
   * (runtime.md §14.8.1). Additive M2 host seam (packet 34): the runtime owns
   * the 32-entry ring, the module owns its per-instance ring and counters.
   */
  behaviorLog?: (level: BehaviorLogLevel, message: string) => void;
  /** Phase 12 (c): the runtime's live tag index (follows scene loads/unloads). */
  tags?: BehaviorTagQuery;
}

/**
 * Simulation module shape (runtime.md §7.2; dependencies.md §6):
 * `step` mutates `curr` consistently or throws; `dispose?` is called by
 * `runtime.dispose()`. This is the accepted M1 shape, kept byte-compatible so
 * the frozen M1 demo source and M1 tests stay unchanged.
 */
export interface SimulationModule {
  step(state: SimState, stepIndex: number): void;
  dispose?(): void;
}

/**
 * The canonical simulation phase order (runtime.md §12.1; M3 adds the two
 * appended values `gameplay`/`camera` — `gameplay.md` §3.1). Every accepted
 * M2 phase list stays a prefix of this order and remains valid unchanged.
 */
export type SimulationPhase = 'intent' | 'controller' | 'transform' | 'gameplay' | 'camera';

export const SIMULATION_PHASE_ORDER: readonly SimulationPhase[] = [
  'intent',
  'controller',
  'transform',
  'gameplay',
  'camera',
];

// ---------------------------------------------------------------------------
// M3 game-session types (gameplay.md §2/§3/§4/§5/§6; runtime.md §15).
// Additive: absent for M1/M2 sets.
// ---------------------------------------------------------------------------

/** The run state machine's states (gameplay.md §2.1). */
export type RunState = 'awaitingStart' | 'playing' | 'respawning' | 'won';

/** One completed motion segment of an entity (gameplay.md §3.3). */
export interface MotionSegment {
  readonly from: Vec2;
  readonly to: Vec2;
}

/** The committed run data the gameplay phase reads (gameplay.md §3.3). */
export interface RunSnapshot {
  readonly state: RunState;
  /** The runtime step counter at read time (see `GameView.stepIndex`). */
  readonly stepIndex: number;
  readonly checkpointId: string | null;
  readonly goalReached: boolean;
  readonly deathCount: number;
  readonly replayEpoch: number;
  readonly respawnAtStep: number | null;
  /** `${snapshotId}#${replayEpoch}`. */
  readonly runId: string;
}

/** The runtime's viewport record (gameplay.md §4.1/§7.1). */
export interface ViewportInfo {
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
}

/** The frozen projection of one authored game zone (gameplay.md §4.1). */
export interface GameZoneSpec {
  readonly entityId: string;
  readonly role: GameZoneRole;
  /** The frozen snapshot transform x/y. */
  readonly center: Vec2;
  /** `size / 2` (half-extents, §4.1). */
  readonly half: Vec2;
  /** Checkpoint zones only. */
  readonly safeSpawnId?: string;
  /** Checkpoint zones only. */
  readonly activation?: Readonly<CheckpointActivationAppearance>;
  /** Phase 12 (c), exit zones only: the scenes loaded/unloaded on entry and the spawn to move to. */
  readonly load?: readonly string[];
  readonly unload?: readonly string[];
  readonly spawnId?: string;
}

/** The authored camera-follow bounds (project-model §23.3.3). */
export interface GameCameraBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * The frozen gameplay content the runtime projects from a v3 snapshot
 * (gameplay.md §4.1) — deep-frozen at instantiate, carried on `StepContext.gameplay`.
 */
export interface GameContent {
  readonly game: Readonly<GameConfig>;
  /** Ascending `entityId` codepoint order. */
  readonly zones: readonly GameZoneSpec[];
  readonly spawns: readonly { entityId: string; center: Vec2 }[];
  readonly player: { entityId: string };
  readonly camera: {
    entityId: string;
    deadZone: Vec2;
    smoothing: number;
    bounds: GameCameraBounds;
  };
}

/**
 * The frozen per-step gameplay port (gameplay.md §3.3 / runtime.md §15.3):
 * `StepContext.gameplay`, present iff the runtime is M3-enabled. The three
 * commit calls are callable in the `gameplay` phase only; from any other
 * phase they throw `module_error` (`reason: 'phase_violation'`); a run-state
 * rule violation is `module_error` (`reason: 'gameplay_invalid'`).
 */
export interface GameSessionPort {
  /** Deep-frozen at instantiate. */
  readonly content: Readonly<GameContent>;
  /** The committed run data, read-only. */
  run(): Readonly<RunSnapshot>;
  /** The last completed motion segment of `entityId`, or `undefined`. */
  lastMotionSegment(entityId: string): Readonly<MotionSegment> | undefined;
  /** The current viewport record. */
  viewport(): Readonly<ViewportInfo>;
  /** T2: decide a death at the current step (`cause`, optional `zoneId`). */
  beginRespawn(cause: 'hazard' | 'fall', zoneId?: string): void;
  /** T3: activate the single checkpoint zone (once per run). */
  activateCheckpoint(zoneEntityId: string): void;
  /** T4: reach the goal zone (wins once). */
  reachGoal(zoneEntityId: string): void;
}

/**
 * The runtime-called reset-barrier context (gameplay.md §5.1 R6 / §3.3).
 * `state.curr` is writable only for the module's declared owners.
 */
export interface ModuleResetContext {
  /** `transfer` (phase 12 c): an exit zone moved the player to its spawn. */
  readonly reason: 'start' | 'spawn' | 'replay' | 'transfer';
  /** The upcoming step index. */
  readonly stepIndex: number;
  /** The reset character centre. */
  readonly playerCenter: Readonly<Vec2>;
  readonly viewport: Readonly<ViewportInfo>;
  readonly state: SimState;
}

/** The six gameplay event kinds (gameplay.md §6). */
export type GameEventKind =
  | 'runStarted'
  | 'died'
  | 'respawned'
  | 'checkpointActivated'
  | 'goalReached'
  | 'replayed';

/** One bounded gameplay event (gameplay.md §6). */
export interface GameEvent {
  /** `${runId}/${kind}/${stepIndex}`. */
  readonly id: string;
  readonly kind: GameEventKind;
  readonly stepIndex: number;
  /** `true` for `runStarted`/`respawned`/`replayed`. */
  readonly boundary: boolean;
  readonly zoneId?: string;
  readonly cause?: 'hazard' | 'fall';
  /** The counter after this event. */
  readonly deathCount: number;
}

/** The committed player motion the view publishes (gameplay.md §6, C41-1). */
export interface PlayerMotion {
  /** `|last completed motion segment| × fixedStepHz` (m/s, finite ≥ 0). */
  readonly speed: number;
  /** The controller's committed grounding after that step. */
  readonly grounded: boolean;
}

/**
 * The committed read-only game view (gameplay.md §6 / runtime.md §15.5).
 * Exactly one frozen view exists per instance: the last committed one,
 * replaced at every commit (phase 8) and at every reset boundary (R8).
 * `getGameView()` returns a new deep-frozen copy per call.
 */
export interface GameView {
  readonly viewVersion: 1;
  /** `${snapshotId}#${replayEpoch}`. */
  readonly runId: string;
  /** `<projectId>@r<revision>` (accepted §2). */
  readonly snapshotId: string;
  readonly replayEpoch: number;
  readonly state: RunState;
  /**
   * The runtime step counter at publication: completed steps after a commit,
   * the upcoming index at a boundary, the failed step index after a fail-stop.
   */
  readonly stepIndex: number;
  readonly simTime: number;
  readonly playerId: string;
  readonly cameraId: string;
  /** `spawnId` or the activated checkpoint's `safeSpawnId`. */
  readonly activeSpawnId: string;
  readonly checkpointId: string | null;
  /** The read-only presentation bit the adapter consumes (PR-1). */
  readonly checkpointActive: boolean;
  /** The committed motion the role selector consumes (C41-1). */
  readonly playerMotion: PlayerMotion;
  readonly goalReached: boolean;
  readonly deathCount: number;
  readonly respawnAtStep: number | null;
  /** Oldest first, ≤ MAX_GAME_EVENTS. */
  readonly events: readonly GameEvent[];
  /** Cumulative. */
  readonly eventCount: number;
  /** Evicted from the front. */
  readonly eventDropped: number;
  readonly failed: boolean;
  /**
   * The last-committed-state failure record (gameplay.md §5.4/§10, T7).
   * `phase` (CC-49-1): the failure phase label the promoted
   * `failure-phases.json` fixture pins on every record (`intent`/
   * `controller`/`physics`/`transform`/`gameplay`/`camera`/`commit`/`R1`–
   * `R8`) — additive to the contract's `{ code, reason?, stepIndex }` shape.
   */
  readonly failure?: {
    readonly code: string;
    readonly reason?: string;
    readonly stepIndex: number;
    readonly phase?: string;
  };
}

/**
 * The M2 phase-declaring module shape (runtime.md §12.1). `transformOwners`
 * is declared once, at `create`; the runtime validates it before any step.
 *
 * Contract note (packet 29, C29-4): §12.1 reuses the M1 name `SimulationModule`
 * for this different signature. Packet 29 keeps the M1 name on the accepted
 * M1 shape (frozen demo source/tests) and names the M2 shape
 * `SimulationPhaseModule`.
 */
export interface SimulationPhaseModule {
  readonly transformOwners: readonly string[];
  step(phase: SimulationPhase, ctx: StepContext): void;
  /** M3 only: the runtime-called reset-barrier hook (`gameplay.md` §5.1 R6). */
  reset?(ctx: ModuleResetContext): void;
  /**
   * Phase 12 (c): a scene was loaded at a step boundary — `entities` are its
   * resolved entities. A module that keeps per-entity state (the behavior
   * host) attaches to them; it may throw to refuse (the load fails the run).
   */
  sceneLoaded?(entities: readonly EntityV3[]): void;
  /** Phase 12 (c): these entities were unloaded; release what belongs to them. */
  sceneUnloaded?(entityIds: ReadonlySet<string>): void;
  dispose?(): void;
}

/**
 * The frozen per-phase context (runtime.md §12.2 / `platformer.md` §3).
 *
 * Contract clarification (packet 29, C29-5): the promoted §12.2 requires the
 * runtime to pass a phase-scoped `state.curr` write target, but the §3
 * `StepContext` block omits it. Packet 29 exposes it as `ctx.state`.
 */
export interface StepContext {
  readonly stepIndex: number;
  readonly phase: SimulationPhase;
  /** The sampled frame — identical for every phase of this step. */
  readonly action: ActionFrame;
  readonly settings: Readonly<GameplaySettings>;
  readonly physics: PhysicsStepClient;
  /** The phase-scoped mutable state view (`curr` writable only for owned entities). */
  readonly state: SimState;
  /**
   * The intents committed so far in this step (runtime.md §14.5): in the
   * `intent` phase a module sees only what earlier modules committed, in later
   * phases the full set. Frozen; packet 34 (additive contract note C34-1).
   */
  readonly intents: IntentSet;
  /**
   * Commit one validated intent (runtime.md §14.4 exhaustive order). Throws a
   * `BehaviorIntentError` on any rejection; the runtime turns it into the
   * contract's fail-stop. Packet 34 (additive contract note C34-1).
   */
  emit(intent: BehaviorIntent): void;
  /**
   * M3 only (gameplay.md §3.3): the frozen gameplay port, present iff the
   * runtime is M3-enabled (at least one selected module declares `gameplay`
   * or `camera`). Absent for M1/M2 sets.
   */
  readonly gameplay?: GameSessionPort;
  /** Phase 12 (c): the scene API (v4 snapshots with a scene catalog). */
  readonly scenes?: BehaviorSceneControl;
  /** Phase 9.7: the animators of the loaded entities (`ctx.animator(id)` in scripts). */
  readonly animators?: BehaviorAnimatorControl;
  /** Phase 9.7: the clip events of the previous step (`ctx.events` in scripts). */
  readonly animatorEvents?: readonly AnimatorEventRecord[];
  /** Phase 9.9: signals (seen one step after they are emitted). */
  readonly signals?: BehaviorSignals;
  /** Phase 9.9: the run's counters and the player's health. */
  readonly game?: BehaviorGameState;
  /** Phase 9.10: play a sound (an audio asset) — presentation only, never part of the simulation. */
  readonly audio?: BehaviorAudio;
  /** Phase 9.11: values kept in the player's save. */
  readonly save?: BehaviorSave;
}

/** Phase 9.11: what a save keeps of a run, and what a load restores. */
export interface RunSaveState {
  readonly checkpointId: string | null;
  readonly counters: Readonly<Record<string, number>>;
  readonly collected: readonly string[];
  readonly defeated: readonly string[];
  readonly health: number | null;
  readonly values: Readonly<Record<string, unknown>>;
}
export type RunRestore = Partial<RunSaveState>;

/** Phase 9.11: `ctx.save` — values a script keeps in the player's save (≤ 64 keys, ≤ 4 KB each as JSON). */
export interface BehaviorSave {
  get(key: string): unknown;
  set(key: string, value: unknown): boolean;
  remove(key: string): void;
  keys(): string[];
}

/** Phase 9.10: `ctx.audio`. */
export interface BehaviorAudio {
  play(assetId: string, options?: { volume?: number }): void;
}

/** Phase 9.9: `ctx.signals`. */
export interface BehaviorSignals {
  emit(name: string): void;
  /** Emitted in the previous step (by a switch, a trigger or a script). */
  on(name: string): boolean;
}

/** Phase 9.9: `ctx.game`. */
export interface BehaviorGameState {
  counter(name: string): number;
  add(name: string, delta: number): void;
  health(): { current: number; max: number } | null;
}

/** Phase 9.7: one entity's animator, as a script sees it. */
export interface BehaviorAnimatorHandle {
  /** Set a float/int/bool parameter; false for an unknown name or a wrong type. */
  set(name: string, value: number | boolean): boolean;
  /** Set a trigger (it resets when a transition uses it). */
  trigger(name: string): boolean;
  get(name: string): number | boolean | undefined;
  /** The current state's name. */
  state(): string;
}

export interface BehaviorAnimatorControl {
  /** The entity's animator, or null when it has none (or is not loaded). */
  of(entityId: string): BehaviorAnimatorHandle | null;
}

/** Phase 9.7: a clip event an animator passed. */
export interface AnimatorEventRecord {
  readonly entityId: string;
  readonly name: string;
  readonly clip: string;
  /** The step in which the clip passed the event. */
  readonly stepIndex: number;
}

/**
 * Phase 12 (b): what a behavior script can ask about tags (`ctx.tags`, in
 * `instantiate` and every `step`). Built once when the scene loads from the
 * effective masks (own mask OR every folder above's); calls never allocate
 * per frame beyond the first query of a given mask.
 */
export interface BehaviorTagQuery {
  /** The mask of the named tags (names ignore case). Throws on an unknown name. */
  mask(...names: string[]): number;
  /** The entity's effective tag mask (0 for an unknown entity). */
  of(entityId: string): number;
  /** Whether the entity carries any (default) or all of the mask's bits. */
  has(entityId: string, mask: number, match?: 'any' | 'all'): boolean;
  /** The entities carrying any (default) or all of the mask's bits, in scene order. */
  query(mask: number, match?: 'any' | 'all'): readonly string[];
}

export interface SimulationModuleSpec {
  id: string;
  /**
   * The declared phases (runtime.md §12.1): non-empty, unique, canonical
   * order. Absent ⇒ an accepted M1 module that runs in an implicit
   * `transform` phase (M1 behavior preserved exactly).
   */
  phases?: readonly SimulationPhase[];
  /** Module IDs this spec cannot coexist with (runtime.md §12.4). */
  excludes?: readonly string[];
  /**
   * The spec needs an injected physics port (runtime.md §12.4
   * `config_invalid`, reason `physics_port`). Contract note (packet 29,
   * C29-1): the accepted §12.1 spec shape does not declare how the runtime
   * learns this.
   */
  requiresPhysicsPort?: boolean;
  /**
   * Transform owners of an M1 module when it participates in an M2 set
   * (runtime.md §12.1: the demo owns every `box` entity).
   */
  legacyTransformOwners?: (snapshot: RuntimeSnapshot) => readonly string[];
  create(snapshot: RuntimeSnapshot, cfg: ModuleConfig): SimulationModule | SimulationPhaseModule;
}

/**
 * Branded simulation-module registry (dependencies.md §6). Create with
 * `createSimulationRegistry()`; register engine modules with
 * `registerSimulationModule`.
 */
export interface SimulationRegistry {
  [registryBrand]: Map<string, SimulationModuleSpec>;
}
const registryBrand: unique symbol = Symbol('thirdlight.simulation-registry');
export { registryBrand as SIM_REGISTRY_BRAND };

/** Lifecycle states (runtime.md §3/§13). */
export type RuntimeStateName = 'instantiated' | 'running' | 'stopped' | 'failed' | 'disposed';

/** The runtime instance (runtime.md §3 API; every call returns a result). */
export interface Runtime {
  start(): { ok: true } | { ok: false; error: RuntimeError };
  stop(): { ok: true } | { ok: false; error: RuntimeError };
  /** Phase 9.10: switch to a level (its scenes become the loaded and start set; a fresh run at its spawn). */
  startLevel?(level: { scenes: readonly string[]; spawnId: string }, restore?: RunRestore): { ok: true } | { ok: false; error: RuntimeError };
  /** Phase 9.11: what a save keeps of the current run. */
  runState?(): RunSaveState;
  /** Phase 9.10: pause or resume the simulation (frames still render). */
  setPaused?(paused: boolean): void;
  readonly isPaused?: boolean;
  /** Phase 9.9: entities collected or defeated (the renderer hides them). */
  hiddenEntities?(): ReadonlySet<string>;
  /** Phase 9.10: the sounds scripts played since the last call. */
  takeAudioRequests?(): { assetId: string; volume: number; stepIndex: number }[];
  /** Phase 9.9: the run's counters and the player's health. */
  gameCounters?(): { counters: Record<string, number>; health: { current: number; max: number } | null };
  /** Manual driver only (runtime.md §3.5); rAF driver ⇒ `tick_not_allowed`. */
  tick(nowSeconds: number): { ok: true } | { ok: false; error: RuntimeError };
  getDiagnostics(): { ok: true; diagnostics: RuntimeDiagnostics } | { ok: false; error: RuntimeError };
  getInterpolatedState(): { ok: true; state: InterpolatedState } | { ok: false; error: RuntimeError };
  getCamera(): { ok: true; camera: CameraInfo } | { ok: false; error: RuntimeError };
  /** Idempotent: second call ⇒ `{ ok: true, alreadyDisposed: true }`. */
  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: RuntimeError };

  // ---- M3 run surface (gameplay.md §6.1; M3-enabled runtimes only) --------
  /**
   * The last committed `GameView` (a new deep-frozen copy per call).
   * `game_session_unavailable` (`reason: 'schedule'`) on a non-M3 runtime;
   * `runtime_disposed` after `dispose()`.
   */
  getGameView(): { ok: true; view: GameView } | { ok: false; error: RuntimeError };
  /**
   * Queue one run command between frame updates (never during a step).
   * A command invalid for the current run state is rejected immediately
   * (`game_command_invalid`, `reason: 'state'`); a conflicting submission
   * with a pending command is rejected (`reason: 'pending'`); a second
   * identical submission coalesces (idempotent `ok: true`).
   */
  gameCommand(cmd: 'start' | 'replay'): { ok: true } | { ok: false; error: RuntimeError };
  /**
   * Update the presentation-only viewport record. Non-finite, non-positive
   * or oversized (`> 16384`) dimensions are rejected with
   * `camera_viewport_invalid`; the previous record is retained.
   */
  setViewport(width: number, height: number): { ok: true } | { ok: false; error: RuntimeError };

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

/** The snapshot's camera projection parameters (runtime.md §6 `getCamera`). */
export interface CameraInfo {
  id: string;
  fovY: number;
  near: number;
  far: number;
}

/** One bounded diagnostic error entry (runtime.md §8). */
export interface DiagnosticErrorEntry {
  /** `behavior_log` is a diagnostics-only entry code (runtime.md §14.8.1). */
  code: ErrorCode | 'behavior_log';
  message: string;
  stepIndex?: number;
  /** M2 fail-stop entries only. */
  moduleId?: string;
  phase?: SimulationPhase;
  reason?: string;
  /** The contract's short detail token (e.g. `duplicate_writer`). */
  detail?: string;
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

  // ---- M3 module sets only (gameplay.md §8 / runtime.md §15.7) ------------
  /** The committed run state. */
  runState?: RunState;
  /** The committed run identity `${snapshotId}#${replayEpoch}`. */
  runId?: string;
  /** The committed death counter. */
  deathCount?: number;
  /** The committed activated-checkpoint zone id (or `null`). */
  checkpointId?: string | null;
  /** Cumulative gameplay events (unbounded count; the ring stays bounded). */
  gameEventCount?: number;
  /** The pending run command queue (≤ 1 entry; consumed at the next boundary). */
  pendingCommands?: readonly ('start' | 'replay')[];
}
