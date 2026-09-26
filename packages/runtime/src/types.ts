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
  PrefabDefinition,
  Quat,
  ResolvedSceneV3,
  TagDefinition,
  Vec3,
} from '@thirdlight/project-model';

/** The gameplay-zone role set (project-model §23.3.1) — canonical home here per gameplay.md §11. */
export type { GameZoneRole };
import type { ActionFrame, ActionSource } from './actions';
import type { BehaviorIntent, BehaviorLogLevel, IntentSet } from './intents';
import type { ErrorCode, RuntimeError } from './errors';
import type { PhysicsPort, PhysicsPort3D, PhysicsStepClient, Vec2 } from './ports';

/** One entity of any supported normalized scene version. */
export type RuntimeSnapshotEntity = ResolvedSceneV3['entities'][number];

/**
 * A complete normalized scene document (project-model §23: `schemaVersion`
 * 3, or 4 for the merged start scenes).
 */
export interface RuntimeScene {
  schemaVersion: 3 | 4;
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
  /** Phase 14.1, v4 only, optional: the project's prefab definitions (`ctx.spawn`). */
  prefabs?: readonly PrefabDefinition[];
  /**
   * Phase 15.3, v4 only, optional: model assetId -> its recorded bounds (the
   * asset's import metrics; the runtime never loads a model). A pickup
   * without a size collects over its model's bounds.
   */
  modelBounds?: Readonly<Record<string, ModelBounds>>;
}

/** Phase 15.3: a model's axis-aligned bounds in its own space (metres). */
export interface ModelBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
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
  /**
   * Request a load; it completes at a later step boundary. Loading or loaded ⇒ no-op.
   * @graphNode Load scene
   */
  load(sceneId: string, options?: SceneLoadOptions): void;
  /**
   * Request an unload at the next step boundary. Unloaded ⇒ no-op.
   * @graphNode Unload scene
   */
  unload(sceneId: string): void;
  /**
   * Where a scene is in its load cycle.
   * @graphPure
   * @graphNode Scene status
   */
  status(sceneId: string): SceneStatus;
  /**
   * The loaded scene ids, in load order.
   * @graphPure
   * @graphNode Loaded scenes
   */
  loaded(): readonly string[];
}

/** Phase 12 (c): a read-only view of entity transforms (`ctx.world`). */
export interface BehaviorWorldView {
  /**
   * The entity's current transform (this step so far), or `undefined` when it is not loaded.
   * @graphPure
   * @graphNode Transform of
   */
  transform(entityId: string): Readonly<{ position: readonly [number, number, number]; rotation: readonly [number, number, number, number]; scale: readonly [number, number, number] }> | undefined;
  /**
   * Phase 23.7: the first loaded entity whose name is exactly `name` (case-sensitive), or `undefined`.
   * Entities are searched in load order: the start scene in document order, then later scenes and spawned copies as they arrived.
   * @graphPure
   * @graphNode Find object by name
   */
  find(name: string): string | undefined;
  /**
   * Phase 23.7: every loaded entity whose name is exactly `name` (case-sensitive), in load order (spawned copies included).
   * @graphPure
   * @graphNode Find objects by name
   */
  findAll(name: string): readonly string[];
  /**
   * Phase 23.7: every loaded entity carrying a component of this kind (as stored on the entity, e.g. `'collider'`, `'light'`, `'behavior'`), in load order (spawned copies included).
   * @graphPure
   * @graphNode Find objects with component
   */
  withComponent(kind: string): readonly string[];
}

/**
 * Phase 23.7: one seeded random number stream (`ctx.random`, `ctx.random.stream(name)`).
 * Replay-safe: the numbers come from the project's `random_seed` setting mixed with the
 * script id, the object's id and the stream name, and advance only when drawn — a replay,
 * the simulation worker and the page all draw the same numbers. Each new run starts over.
 */
export interface BehaviorRandomStream {
  /**
   * A number in [0, 1) (a multiple of 2^-32).
   * @graphNode Seeded random
   */
  next(): number;
  /**
   * A number in [min, max).
   * @graphNode Seeded random range
   * @graphDefault max 1
   */
  range(min: number, max: number): number;
  /**
   * A whole number from `min` to `max`, both included (the bounds are rounded inward).
   * @graphNode Seeded random integer
   * @graphDefault max 6
   */
  int(min: number, max: number): number;
  /**
   * True with probability `p` (0: never, 1: always).
   * @graphNode Seeded chance
   * @graphDefault p 0.5
   */
  chance(p: number): boolean;
  /**
   * One item of `list` chosen evenly, or `undefined` when it is empty.
   * @graphNode skip a list's random item is Seeded random integer with the list's Get item
   */
  pick<T>(list: readonly T[]): T | undefined;
}

/**
 * Phase 23.7: `ctx.random` — the instance's main seeded stream, plus named sub-streams.
 */
export interface BehaviorRandom extends BehaviorRandomStream {
  /**
   * An independent named stream of this object (the same name gives the same stream):
   * draws from one never shift the numbers of another, so adding a draw for loot does
   * not change the numbers used for movement. Names: 1–64 characters of letters, digits,
   * `_ . : -`; at most 64 streams per object.
   * @graphLabel name stream
   */
  stream(name: string): BehaviorRandomStream;
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
  /**
   * Phase 14.1: the live spawned entities (`ctx.spawn`), in spawn order
   * (parents before children), frozen. An id may come back in a later run
   * as a new object: renderers compare the objects, not only the ids.
   */
  readonly spawned: readonly EntityV3[];
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
  /**
   * An already-initialized physics port (runtime.md §12.6). Required by
   * port-requiring sets. Phase 23.0: or a 3D port (`PhysicsPort3D`, a project
   * whose `physics_dimension` is 3).
   */
  physics?: PhysicsPort | PhysicsPort3D;
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
  /** Phase 23.7: the kinds of the entity's components, as stored (`ctx.world.withComponent`). */
  componentKinds?: readonly string[];
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
  /** The snapshot's `schemaVersion` (3, or 4 for the merged start scenes). */
  sceneVersion: 3 | 4;
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
  /** Phase 23.1: 3 in a 3D project (absent: the 2D plane) — scripts may drive colliders no mover moves there. */
  physicsDimension?: 3;
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
 * Phase 14.0: the player's collision capsule as the systems use it —
 * `radius`, the centre-line `halfHeight` (the total height is
 * `2 × (halfHeight + radius)`) and the centre's `offset` from the entity
 * origin. Positions the runtime reports (the player's transform, motion
 * segments) are the entity origin; the capsule centre is origin + offset.
 */
export interface PlayerCapsule {
  readonly radius: number;
  readonly halfHeight: number;
  readonly offset: Vec2;
}

/**
 * The frozen gameplay content the runtime projects from a v3 snapshot
 * (gameplay.md §4.1) — deep-frozen at instantiate, carried on `StepContext.gameplay`.
 */
export interface GameContent {
  readonly game: Readonly<GameConfig>;
  /** Ascending `entityId` codepoint order. */
  readonly zones: readonly GameZoneSpec[];
  /** Phase 15.2: `facing` only when the spawn sets left or right. */
  readonly spawns: readonly { entityId: string; center: Vec2; facing?: 'left' | 'right' }[];
  /** Phase 14.0: the player entity and its collision capsule (from its `controller`). */
  readonly player: { entityId: string; capsule: PlayerCapsule };
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
  /** Phase 20.2: play visual effects — presentation only, never part of the simulation. */
  readonly effects?: BehaviorEffects;
  /** Phase 9.11: values kept in the player's save. */
  readonly save?: BehaviorSave;
  /** Phase 14.1: spawn prefab copies into the running game and destroy them. */
  readonly spawner?: BehaviorSpawnControl;
  /**
   * Phase 14.2: the triggers the player entered or left in the previous step
   * (every trigger; the behavior host gives each script those it owns, in
   * `ctx.events`).
   */
  readonly triggerEvents?: readonly TriggerEventRecord[];
  /** Phase 19.1: messages between scripts (the behavior host gives each script its own `ctx.messages`). */
  readonly messages?: BehaviorMessageControl;
}

/** Phase 19.1: one message a script sent (`ctx.messages`). */
export interface BehaviorMessage {
  readonly name: string;
  /** The payload (a number, text or true/false), or null when none was sent. */
  readonly value: number | string | boolean | null;
  /** The entity whose script sent it. */
  readonly from: string;
  /** The step it was sent in (scripts see it in the next step). */
  readonly stepIndex: number;
}

/**
 * Phase 19.1: `ctx.messages` — named messages between scripts with an
 * optional value, to every script or to the scripts of one entity. Like
 * signals, a message sent in a step is seen in the next step (in send order);
 * at most `MAX_MESSAGES_PER_STEP` (256) are sent per step and a new run
 * clears them.
 */
export interface BehaviorMessages {
  /**
   * Send a message (name: 1–64 letters, digits or _ . : -) with an optional
   * value (a number, text of at most 256 characters or true/false) to every
   * script, or only to the scripts on entity `target`. `false` when it is
   * refused (a bad name or value, or the step's limit).
   * @graphNode Send message
   * @graphLabel name message
   * @graphLabel target to entity (empty: every script)
   */
  send(name: string, value?: number | string | boolean, target?: string): boolean;
  /**
   * The messages of that name sent in the previous step to every script or to this entity, in send order.
   * @graphPure
   * @graphNode Messages received
   * @graphLabel name message
   */
  received(name: string): readonly BehaviorMessage[];
}

/** Phase 19.1: the runtime side of `ctx.messages` (the behavior host fills in sender and receiver). */
export interface BehaviorMessageControl {
  send(from: string, name: unknown, value: unknown, target: unknown): boolean;
  received(to: string, name: unknown): readonly BehaviorMessage[];
}

/**
 * Phase 14.2: one `ctx.events` entry for a trigger a script owns — the player
 * entered (`enter`) or left (`exit`) it in `stepIndex` (scripts see it in the
 * next step, like signals). A script owns the triggers on its own entity, on
 * the entity's descendants, and those named by its entityRef properties.
 */
export interface TriggerEventRecord {
  readonly type: 'enter' | 'exit';
  /** The trigger's entity id. */
  readonly trigger: string;
  readonly stepIndex: number;
}

/**
 * Phase 14.2: `ctx.timers` — named timers of one script instance, counted in
 * fixed steps (deterministic: `seconds × fixedStepHz` rounded, at least one
 * step). At most `MAX_TIMERS_PER_INSTANCE` (64) run per instance; a new run
 * (start, replay, a level switch) clears them.
 */
export interface BehaviorTimers {
  /**
   * Fire once, `seconds` from this step. Returns `false` (and changes
   * nothing) when a one-shot timer of that name and length is already
   * running — a script may call it every step; a different length restarts it.
   * @graphNode Start timer
   * @graphLabel name timer
   * @graphDefault seconds 1
   */
  after(name: string, seconds: number): boolean;
  /**
   * Fire every `seconds`, the first time `seconds` from this step. Returns
   * `false` (and changes nothing) when a repeating timer of that name and
   * period is already running.
   * @graphNode Start repeating timer
   * @graphLabel name timer
   * @graphDefault seconds 1
   */
  every(name: string, seconds: number): boolean;
  /**
   * True in the step the timer fires (in every phase of that step).
   * @graphPure
   * @graphNode Timer fired
   * @graphLabel name timer
   */
  fired(name: string): boolean;
  /**
   * Stop a timer; `false` when none of that name was running.
   * @graphNode Cancel timer
   * @graphLabel name timer
   */
  cancel(name: string): boolean;
}

/**
 * Phase 14.1: `ctx.spawn` / `ctx.destroy` in scripts. A spawn is requested
 * during a step and appears at the next step boundary (deterministic: in
 * request order); the id is returned at once. A new run removes every
 * spawned entity; saves never keep them.
 */
export interface BehaviorSpawnControl {
  /**
   * Copy the project prefab `prefabId` into the running game with its root at
   * `options.position` (`[x, y]` keeps the root's authored z, or `[x, y, z]`),
   * optional `rotation` (quaternion `[x, y, z, w]`) and `scale` (number or
   * `[x, y, z]`). Returns the new root id (`spawn-<n>`), or `null` when an
   * engine limit refuses it (64 spawns per step, 1024 live spawned entities).
   * An unknown prefab or bad options throw.
   */
  spawn(prefabId: string, options: { position: readonly number[]; rotation?: readonly number[]; scale?: number | readonly number[] }): string | null;
  /**
   * Remove a spawned entity and its children at the next step boundary.
   * `false` when it is already gone (or queued). An authored entity throws:
   * hide it with `ctx.game.setVisible` instead.
   */
  destroy(entityId: string): boolean;
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
  /**
   * The value kept under `key` (undefined when there is none).
   * @graphPure
   * @graphNode Saved value
   */
  get(key: string): unknown;
  /**
   * Keep a value under `key`; `false` when it does not fit (a bad key, 64 keys, 4 KB).
   * @graphNode Save value
   */
  set(key: string, value: unknown): boolean;
  /**
   * Forget the value under `key`.
   * @graphNode Remove saved value
   */
  remove(key: string): void;
  /**
   * The keys of the kept values.
   * @graphPure
   * @graphNode Saved keys
   */
  keys(): string[];
}

/** Phase 9.10: `ctx.audio`. */
export interface BehaviorAudio {
  /**
   * Play an audio asset once (volume 0–1).
   * @graphNode Play sound
   * @graphLabel assetId sound
   * @graphAsset assetId audio
   * @graphDefault volume 1
   */
  play(assetId: string, options?: { volume?: number }): void;
}

/**
 * Phase 20.2: one request to the renderer's effect player (`ctx.effects`,
 * the `effect` component's signals, gameplay hooks). Presentation only:
 * requests are recorded in step order and taken by the adapter; nothing in
 * the simulation reads them back (replays do not depend on effects).
 */
export interface EffectRequest {
  readonly op: 'play' | 'stop';
  /** play: the project effect; stop by entity: '' . */
  readonly effectId: string;
  /** play: the new play's handle (> 0); stop: the handle stopped (0 = every play on `entityId`). */
  readonly handle: number;
  /** The entity it plays on (it follows the entity), or null (at `position` in world space). */
  readonly entityId: string | null;
  /** World position (no entity), or the offset from the entity (metres). */
  readonly position: readonly [number, number, number];
  /** Overrides of the effect's public parameters (null = none). */
  readonly params: Readonly<Record<string, number | readonly number[] | string>> | null;
  /** What asked: a script, the entity's `effect` component (its signal), or a gameplay hook. */
  readonly source: 'script' | 'component' | 'pickup' | 'enemyHit' | 'enemyDefeat' | 'playerHit' | 'checkpoint' | 'goal';
  /** The step it was asked in (1-based like the step being simulated). */
  readonly stepIndex: number;
}

/** Phase 20.2: `ctx.effects` — play visual effects (presentation only, never part of the simulation). */
export interface BehaviorEffects {
  /**
   * Play a project effect (particles) once: on `entityId` (it follows the object; `position` is then an offset from it) or, without one, at `position` in world metres. `params` override its public parameters. Returns a handle for `stop`, or 0 when refused (a bad id, more than 32 plays in one step).
   * @graphNode Play effect
   * @graphLabel effectId effect
   */
  play(effectId: string, options?: { position?: readonly number[]; entityId?: string; params?: Readonly<Record<string, number | readonly number[] | string>> }): number;
  /**
   * Stop spawning: a play's handle, or an object's id (every effect playing on it, its effect component included). Living particles finish their lives.
   * @graphNode Stop effect
   */
  stop(target: number | string): void;
}

/** Phase 9.9: `ctx.signals`. */
export interface BehaviorSignals {
  /**
   * Send a named signal; switches, doors and scripts see it in the next step.
   * @graphNode Emit signal
   * @graphLabel name signal
   */
  emit(name: string): void;
  /**
   * Emitted in the previous step (by a switch, a trigger or a script).
   * @graphPure
   * @graphNode Signal received
   * @graphLabel name signal
   */
  on(name: string): boolean;
}

/** Phase 9.9: `ctx.game`. */
export interface BehaviorGameState {
  /**
   * The current value of one of the run's counters (0 when it was never added to).
   * @graphPure
   * @graphNode Counter value
   * @graphLabel name counter
   */
  counter(name: string): number;
  /**
   * Add to one of the run's counters (coins, keys, anything you name); the HUD and score rules read them.
   * @graphNode Add to counter
   * @graphLabel name counter
   * @graphDefault amount 1
   */
  add(name: string, amount: number): void;
  /**
   * The player's health, or null when the game has none.
   * @graphPure
   * @graphNode Player health
   */
  health(): { current: number; max: number } | null;
  /**
   * Show or hide an entity (and its children) until the next run; it still collides and triggers.
   * @graphNode Set visible
   * @graphDefault visible true
   */
  setVisible(entityId: string, visible: boolean): void;
}

/** Phase 9.7: one entity's animator, as a script sees it. */
export interface BehaviorAnimatorHandle {
  /**
   * Set a float/int/bool parameter; false for an unknown name or a wrong type.
   * @graphNode Set animator parameter
   * @graphLabel name parameter
   */
  set(name: string, value: number | boolean): boolean;
  /**
   * Set a trigger (it resets when a transition uses it).
   * @graphNode Set animator trigger
   * @graphLabel name trigger
   */
  trigger(name: string): boolean;
  /**
   * A parameter's value (undefined for an unknown name).
   * @graphPure
   * @graphNode Animator parameter
   * @graphLabel name parameter
   */
  get(name: string): number | boolean | undefined;
  /**
   * The current state's name (of the base layer, or of override layer `layer` — 1 is the first; phase 14.6).
   * @graphPure
   * @graphNode Animator state
   */
  state(layer?: number): string;
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
  /**
   * The mask of the named tags (names ignore case). Throws on an unknown name.
   * @graphPure
   * @graphNode Tag mask
   * @graphLabel names tags (comma separated)
   */
  mask(...names: string[]): number;
  /**
   * The entity's effective tag mask (0 for an unknown entity).
   * @graphPure
   * @graphNode Tags of
   */
  of(entityId: string): number;
  /**
   * Whether the entity carries any (default) or all of the mask's bits.
   * @graphPure
   * @graphNode Has tags
   */
  has(entityId: string, mask: number, match?: 'any' | 'all'): boolean;
  /**
   * The entities carrying any (default) or all of the mask's bits, in scene order.
   * @graphPure
   * @graphNode Find by tags
   */
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
  behaviorDebug?(filter?: { behaviorId?: string; entityId?: string }): { behaviorId: string; entityId: string; debug: unknown }[];
  /** Phase 9.9: entities collected or defeated (the renderer hides them). */
  hiddenEntities?(): ReadonlySet<string>;
  /** Phase 15.3: entities fading out (id -> opacity 0-1; a defeated enemy with `defeat: "fade"`). */
  entityOpacity?(): ReadonlyMap<string, number>;
  /** Phase 9.10: the sounds scripts played since the last call. */
  takeAudioRequests?(): { assetId: string; volume: number; stepIndex: number }[];
  /** Phase 20.2: the effect requests (scripts, effect-component signals, gameplay hooks) since the last call; the adapter plays them. */
  takeEffectRequests?(): EffectRequest[];
  /** Phase 9.9: the run's counters and the player's health. */
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
  /** Phase 21.2: one entity's interpolated transform into the caller's arrays; false when disposed or unknown. */
  readInterpolated?(id: string, position: number[], rotation: number[], scale: number[]): boolean;
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
   * Phase 21.2: the committed view itself (deep-frozen, so it cannot alias
   * anything mutable) without the copy `getGameView` makes — for a host that
   * reads it every frame. Null where `getGameView` fails.
   */
  peekGameView?(): GameView | null;
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
  /** Phase 22.0: why `requestScene(op, sceneId)` would be refused now (null: accepted); changes nothing. */
  sceneRequestProblem?(op: 'load' | 'unload', sceneId: string): string | null;
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
  /** Phase 19.0: the visual-script node the error came from (graph behaviors only). */
  nodeId?: string;
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
