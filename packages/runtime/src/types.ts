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
  EntityV3,
  GameplaySettings as ModelGameplaySettings,
  PrefabDefinition,
  Quat,
  ResolvedSceneV3,
  TagDefinition,
  Vec3,
} from '@thirdlight/project-model';

import type { ActionFrame, ActionSource, DebugCommandArg, DebugCommandCall } from './actions';
import type { BehaviorIntent, BehaviorLogLevel, IntentSet } from './intents';
import type { ErrorCode, RuntimeError } from './errors';
import type { CharacterClearanceResult3D, PhysicsPort, PhysicsPort3D, PhysicsStepClient, PhysicsVec3, RaycastHit3D, Vec2 } from './ports';

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
 * The runtime snapshot (runtime.md §2) — the ONLY input of a runtime
 * instance. `scene` is a complete normalized scene document. Phase 24.8: no
 * `game` wrapper field (the deleted game block).
 */
export interface RuntimeSnapshot {
  /** Exactly `<projectId>@r<revision>` (project-model §6). */
  snapshotId: string;
  projectId: string;
  /** Integer, 0 ≤ v ≤ 2^53−1; must equal `scene.revision`. */
  revision: number;
  scene: RuntimeScene;
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
  /**
   * Phase 23.13, v4 only, optional: audio/music assetId -> its recorded
   * duration in ms (the asset's import metrics). A script sound's `finished`
   * event is computed from it in the simulation.
   */
  audioDurations?: Readonly<Record<string, number>>;
  /**
   * Phase 23.11, v4 only, optional: model assetId -> its rig (nodes and node
   * animation channels, read from the GLB by the play/export closure) — the
   * data sockets are resolved on (the runtime never loads a model).
   */
  rigs?: Readonly<Record<string, import('@thirdlight/project-model').ModelRig>>;
  /** Phase 23.5, v4 only, optional: the block types block layers use (`content.blockTypes`). */
  blockTypes?: readonly import('@thirdlight/project-model').BlockType[];
  /** Phase 23.5, v4 only, optional: the cell metadata schema (`content.cellFields`). */
  cellFields?: readonly import('@thirdlight/project-model').CellField[];
  /**
   * Phase 23.12, optional: the graph materials' parameters, the model assets'
   * default mappings and the closure's textures (`ctx.materials` checks script
   * values against them; built from the manifest by `materialCatalogOf`).
   */
  materialCatalog?: import('./material-params').RuntimeMaterialCatalog;
  /** Phase 23.19, optional: the project save schema (`content.saveSchema`; `ctx.saves`). */
  saveSchema?: import('@thirdlight/project-model').SaveSchema;
  /** Phase 23.18, optional: the ids of the environment presets (`environment.presets`; `ctx.environment`). */
  environmentPresets?: readonly string[];
  /**
   * Phase 23.9a, v4 only, optional: the project's UI documents as the
   * simulation knows them (id, layer, modal) — `ctx.ui.show/hide` and a
   * frame's show/hide entries name them. The host draws the documents.
   */
  uiDocuments?: readonly import('@thirdlight/project-model').RuntimeUiDocumentRow[];
  /**
   * Phase 23.16, v4 only, optional: the compiled conversations, the speaker
   * registry and the dialogue settings (`ctx.dialogue`; built from the
   * manifest's `dialogue`).
   */
  dialogue?: import('@thirdlight/project-model').RuntimeDialogueData;
  /**
   * Phase 23.10, v4 only, optional: the project's game modes (the first is
   * the start mode) and each input action's map (the masking of inactive
   * maps). Absent: no modes — nothing of them runs or enters the digest.
   */
  modes?: import('@thirdlight/project-model').RuntimeModes;
  /** Phase 23.17, v4 only, optional: the project's timelines (`content.timelines`; `ctx.timeline`). */
  timelines?: readonly import('@thirdlight/project-model').TimelineAsset[];
  /** Phase 24.4i, v4 only, optional: the event → cue table (`content.eventCues`); absent: no event sounds. */
  eventCues?: readonly RuntimeEventCue[];
  /** Phase 24.4j, optional: the shell's ordered scene list (`content.shell.scenes`) the `scene` UI event walks. */
  sceneList?: readonly ListedScene[];
}

/** Phase 24.4i: one row of the event → cue table (project-model `EventCue`). */
export type RuntimeEventCue = import('@thirdlight/project-model').EventCue;

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

/** Phase 24.4j: one entry of the shell's scene list (phase 25.24e: with the fade of a move to it). */
export interface ListedScene {
  readonly scene: string;
  readonly spawn?: string;
  readonly fade?: number;
  readonly fadeColor?: string;
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
  /**
   * Phase 25.24e: scenes unloaded when this one is in (a transition). They
   * stay drawn until the loaded scene replaces them in the same step, so the
   * view never shows an empty world.
   */
  unload?: readonly string[];
  /** Phase 25.24e: seconds the view fades out before the swap and back in after it (0–5; absent: 0, no fade). */
  fade?: number;
  /** Phase 25.24e: the fade's colour ("#rrggbb"; absent: black). */
  fadeColor?: string;
}

/**
 * Phase 25.24e: a scene transition in progress (a trigger's scene
 * transition, a move along the shell's scene list, a load with `unload` or
 * `fade`): the scene it waits for, and where it is — `out` while the view
 * fades out, `loading` while the scene is read and prepared.
 */
export interface SceneTransitionView {
  readonly scene: string;
  readonly phase: 'out' | 'loading';
  /** How far the view has faded out (0–1; 1 for a transition without a fade). */
  readonly fade: number;
  /** The fade's length (seconds; 0: none) and colour. */
  readonly seconds: number;
  readonly color: string;
  /** The scenes it unloads once its scene is in. */
  readonly unload: readonly string[];
}

/**
 * Phase 25.24e: scene loading as the page reads it (a loading screen, the
 * fade): the scenes being loaded, the transition waiting (null: none) and
 * the last swap a transition made (the page fades back in once it has drawn
 * that scene set revision).
 */
export interface SceneLoadingView {
  readonly loading: readonly string[];
  readonly transition: SceneTransitionView | null;
  readonly swap: { readonly scene: string; readonly revision: number; readonly seconds: number; readonly color: string } | null;
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
  /**
   * Phase 25.24e: the scenes being loaded (asked for, not yet in), in request order.
   * @graphPure
   * @graphNode Loading scenes
   */
  loading(): readonly string[];
  /**
   * Phase 25.24e: the scene transition in progress (its scene, `out` while the view fades out, `loading` while the scene loads), or null.
   * @graphPure
   * @graphNode Scene transition
   */
  transition(): SceneTransitionView | null;
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
  /**
   * Phase 23.8: values the scripts see in `ctx.save` from step 0 (a test or
   * debug start: "Play from…", `tl_play_start` variables). Same rules as
   * `ctx.save.set` (≤ 64 keys, each ≤ 4 KB as JSON); a value that breaks
   * them is `config_invalid`.
   */
  variables?: Readonly<Record<string, unknown>>;
  /**
   * Phase 23.10: the game mode runs start in (a Play start option: "Play
   * from…", `tl_play_start` mode) instead of the first one. A mode the
   * snapshot does not have is `config_invalid`; ignored without modes.
   */
  startMode?: string;
  /** Phase 23.19: the stored project settings document (values that do not fit the save schema's fields fall back to the defaults). */
  projectSettings?: Readonly<Record<string, unknown>>;
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

/** Module config passed to `SimulationModuleSpec.create` (runtime.md §7.2/§12.1). */
export interface ModuleConfig {
  fixedStepHz: number;
  /** The resolved, deep-frozen gameplay settings (M2 sets). */
  settings: Readonly<GameplaySettings>;
  /** The snapshot's `schemaVersion` (3, or 4 for the merged start scenes). */
  sceneVersion: 3 | 4;
  /**
   * The runtime's bounded diagnostics sink for behavior `ctx.log` calls
   * (runtime.md §14.8.1). Additive M2 host seam (packet 34): the runtime owns
   * the 32-entry ring, the module owns its per-instance ring and counters.
   */
  /** Phase 25.9: `at` is where in the project's compiled script the log was called (when found). */
  behaviorLog?: (level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }) => void;
  /** Phase 12 (c): the runtime's live tag index (follows scene loads/unloads). */
  tags?: BehaviorTagQuery;
  /** Phase 23.1: 3 in a 3D project (absent: the 2D plane) — scripts may drive colliders no mover moves there. */
  physicsDimension?: 3;
  /**
   * Phase 23.2 (3D projects): read-only queries of the 3D world for the
   * character controller module (a ray; the clearance of the character's
   * capsule at an origin) — not part of the scripts' context.
   */
  character3D?: Character3DQueries;
}

/** Phase 23.2: the 3D world queries the character controller uses to find a ledge and room on top of it. */
export interface Character3DQueries {
  raycast(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number): RaycastHit3D | null;
  /** The clearance of the character capsule if its origin were at `origin` (null: the port cannot tell). */
  clearance(origin: PhysicsVec3): CharacterClearanceResult3D | null;
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
 * The canonical simulation phase order (runtime.md §12.1). Phase 24.7: the
 * game session's `gameplay` and `camera` phases were deleted with it.
 */
export type SimulationPhase = 'intent' | 'controller' | 'transform';

export const SIMULATION_PHASE_ORDER: readonly SimulationPhase[] = [
  'intent',
  'controller',
  'transform',
];

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
 * The runtime-called reset context: the character was placed (a restart
 * `replay`, a scene arrival or respawn `transfer`). `state.curr` is writable
 * only for the module's declared owners.
 */
export interface ModuleResetContext {
  readonly reason: 'replay' | 'transfer';
  /** The upcoming step index. */
  readonly stepIndex: number;
  /** The reset character centre. */
  readonly playerCenter: Readonly<Vec2>;
  readonly state: SimState;
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
  /** The runtime-called reset hook (the character was placed: a restart, an arrival, a respawn). */
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
 * The frozen per-phase context (runtime.md §12.2 / the controller contract §3).
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
  /** Phase 12 (c): the scene API (v4 snapshots with a scene catalog). */
  readonly scenes?: BehaviorSceneControl;
  /** Phase 9.7: the animators of the loaded entities (`ctx.animator(id)` in scripts). */
  readonly animators?: BehaviorAnimatorControl;
  /** Phase 9.7: the clip events of the previous step (`ctx.events` in scripts). */
  readonly animatorEvents?: readonly AnimatorEventRecord[];
  /** Phase 9.9: signals (seen one step after they are emitted). */
  readonly signals?: BehaviorSignals;
  /** Phase 9.9: the run's counters and the character's health. */
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
  /**
   * Phase 24.4: the primitives' events of the previous step (health changes,
   * collections, patrol turns, hitbox contacts — every object's; the behavior
   * host gives each script those of the objects it owns, in `ctx.events`).
   */
  readonly primitiveEvents?: readonly PrimitiveEventRecord[];
  /** Phase 24.4b: any object's health (`ctx.health`). */
  readonly health?: BehaviorHealth;
  /** Phase 24.4c: patrollers (`ctx.patrol`). */
  readonly patrol?: BehaviorPatrol;
  /** Phase 24.4d: hitboxes (`ctx.hitbox`). */
  readonly hitbox?: BehaviorHitbox;
  /** Phase 24.4a: collectibles (`ctx.collectible`). */
  readonly collectible?: BehaviorCollectible;
  /** Phase 24.4f: the character (`ctx.character`). */
  readonly character?: BehaviorCharacter;
  /** Phase 24.4h: per-object look overrides (`ctx.look`). */
  readonly look?: BehaviorLook;
  /** Phase 19.1: messages between scripts (the behavior host gives each script its own `ctx.messages`). */
  readonly messages?: BehaviorMessageControl;
  /**
   * Phase 25.11: the objects switched off now (by a script, with their children) — the behavior host
   * sends `onEnable`/`onDisable` when an instance's object changes side.
   */
  readonly inactiveEntities?: ReadonlySet<string>;
  /**
   * Phase 23.2 (3D projects): the active camera's yaw this step — radians
   * about +Y, 0 looking along −Z (three.js' default camera) — when a camera
   * rig provides one; the 3D character reads its move input relative to it.
   * Absent: world axes (the input's y pushes along −Z, its x along +X).
   */
  readonly cameraYaw?: number;
  /** Phase 23.4: the virtual cameras (`ctx.camera`; a scene without one answers false/null). */
  readonly camera?: BehaviorCamera;
  /** Phase 23.11: sockets (`ctx.sockets`). */
  readonly sockets?: BehaviorSockets;
  /** Phase 23.3: the cursor a script asks for (`ctx.input.setCursor`; simulation state the host applies after the step). */
  readonly cursor?: { readonly request: (mode: 'free' | 'locked' | 'auto') => void };
  /** Phase 23.14: the host's input status (device, bindings, rebind events) and the binding-request queue (`ctx.input`). */
  readonly inputStatus?: import('./input-status').InputStatusView;
  /** Phase 23.8: the project's debug commands (declared and received per phase; the behavior host adds the handler). */
  readonly debug?: { command(name: string, options?: DebugCommandOptions): readonly DebugCommandArgs[] };
  /** Phase 23.5: the block layers of the loaded scenes (`ctx.grid`). */
  readonly grid?: import('./grid').BehaviorGrid;
  /** Phase 23.12: graph-material parameters per object (`ctx.materials`). */
  readonly materials?: import('./material-params').BehaviorMaterials;
  /** Phase 23.19: project saves (`ctx.saves`). */
  readonly saves?: import('./project-saves').BehaviorSaves;
  /** Phase 23.9a: the project UI (`ctx.ui`: the view model, shown documents, UI events). */
  readonly ui?: BehaviorUi;
  /** Phase 23.16: conversations (`ctx.dialogue`). */
  readonly dialogue?: BehaviorDialogue;
  /** Phase 23.10: the game modes (`ctx.modes`; present while the project has modes). */
  readonly modes?: BehaviorModes;
  /** Phase 23.10: the run lifecycle (`ctx.lifecycle`). */
  readonly lifecycle?: BehaviorLifecycle;
  /**
   * Phase 23.10: whether the behavior on this entity runs this step (its
   * behavior group ticks in the current game mode). Absent: every behavior
   * runs (no modes, or the mode ticks every group).
   */
  readonly behaviorTicks?: (entityId: string) => boolean;
  /** Phase 23.17: timelines (`ctx.timeline`). */
  readonly timeline?: BehaviorTimeline;
  /** Phase 23.18: environment presets (`ctx.environment`). */
  readonly environment?: BehaviorEnvironment;
  /** Phase 25.10: generic component access (`ctx.entity(ref)`; the behavior host names the writing script). */
  readonly entities?: import('./entity-access').BehaviorEntityControl;
  /** Phase 25.10: the shell's scene list (`ctx.shell`). */
  readonly shell?: BehaviorShell;
  /** Phase 25.13: the climb volume the character is in (the character controllers; not the scripts' context). */
  readonly climb?: ClimbQuery;
}

/** Phase 25.13: where the character may climb. */
export interface ClimbQuery {
  /** The climb volume the character's capsule centre is in now (its object, world up and across axes), or null. */
  volume(): import('./blocks').ClimbVolumeView | null;
}

/**
 * Phase 25.10: `ctx.shell` — the game shell's scene list (`content.shell`,
 * phase 24.4j) from scripts.
 */
export interface BehaviorShell {
  /**
   * Move to the next entry of the shell's scene list at the next step boundary — the same move as the
   * shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene, the
   * entry's scene loads, the character arrives at its spawn). False when the list has no next entry.
   * Calling it again in the same step asks for the same move.
   * @graphNode Next scene
   */
  nextScene(): boolean;
  /**
   * The scene list entry the run is at (-1: none).
   * @graphPure
   * @graphNode Scene list entry
   */
  sceneIndex(): number;
  /**
   * How many entries the shell's scene list has (0: the project has none).
   * @graphPure
   * @graphNode Scene list length
   */
  sceneCount(): number;
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
  /** Phase 25.11: every message sent in the previous step to every script or to `to`, in send order (`onMessage`). */
  all?(to: string): readonly BehaviorMessage[];
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

/** Phase 24.4b: a change of an object's health (seen in the step after it happened). */
export interface HealthEventRecord {
  readonly type: 'damaged' | 'healed' | 'died';
  /** The object whose health changed. */
  readonly entity: string;
  /** damaged/healed: how much it changed (died: 0). */
  readonly amount: number;
  /** Its health after the change. */
  readonly current: number;
  /** What caused it (an object id, or any text a script passed; '' when none). */
  readonly source: string;
  readonly stepIndex: number;
}

/** Phase 24.4d: a hitbox began or stopped touching another hitbox or the character. */
export interface ContactEventRecord {
  readonly type: 'contact' | 'separate';
  /** This side (a hitbox's object, or the character). */
  readonly entity: string;
  /** The other side. */
  readonly other: string;
  /** Unit vector from this side toward the other at the contact ([0, 0, 0] on separate). */
  readonly normal: readonly [number, number, number];
  readonly stepIndex: number;
}

/** Phase 24.4c: a patroller turned around (at a wall, a ledge, the end of its waypoints, or by a script). */
export interface PatrolEventRecord {
  readonly type: 'turned';
  readonly entity: string;
  readonly reason: 'wall' | 'ledge' | 'end' | 'script';
  /** The direction it walks in now (a unit vector). */
  readonly direction: readonly [number, number, number];
  readonly stepIndex: number;
}

/** Phase 24.4a: a collectible was collected (by the character) or came back. */
export interface CollectEventRecord {
  readonly type: 'collected' | 'restored';
  readonly entity: string;
  readonly counter: string;
  /** collected: what it added (restored: 0). */
  readonly amount: number;
  /** collected: the object that collected it ('' on restored). */
  readonly by: string;
  readonly stepIndex: number;
}

export type PrimitiveEventRecord = HealthEventRecord | ContactEventRecord | PatrolEventRecord | CollectEventRecord;

/**
 * Phase 14.2: `ctx.timers` — named timers of one script instance, counted in
 * fixed steps (deterministic: `seconds × fixedStepHz` rounded, at least one
 * step). At most `MAX_TIMERS_PER_INSTANCE` (64) run per instance; a new run
 * (a restart) clears them.
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

/** Phase 23.8: the type of a debug command argument. */
export type DebugCommandArgType = 'number' | 'string' | 'boolean';

/** Phase 23.8: one declared argument of a debug command. */
export interface DebugCommandArgSpec {
  /** The argument's name (a letter or _, then letters, digits, _ . : -). */
  readonly name: string;
  readonly type: DebugCommandArgType;
  /** May be left out of a call (a call without it has no such key). */
  readonly optional?: boolean;
}

/** Phase 23.8: how a script declares a debug command (`ctx.debug.command(name, options)`). */
export interface DebugCommandOptions {
  /** One line the console and tools show (at most 120 characters). */
  readonly description?: string;
  /** The arguments in order (at most 8; the console also takes them by position). */
  readonly args?: readonly DebugCommandArgSpec[];
}

/** Phase 23.8: a registered debug command, as the console and tools list it. */
export interface DebugCommandSpec {
  readonly name: string;
  readonly description: string;
  readonly args: readonly DebugCommandArgSpec[];
}

/** Phase 23.8: the arguments of one debug command call. */
export type DebugCommandArgs = Readonly<Record<string, DebugCommandArg>>;

/**
 * Phase 23.8: the registered debug commands and the calls the game ran (the
 * newest last, at most 16): what a playtest needs to reproduce a run (each
 * call is an input-frame entry at its step).
 */
export interface DebugCommandState {
  readonly registered: readonly DebugCommandSpec[];
  readonly applied: readonly { readonly stepIndex: number; readonly name: string; readonly args: DebugCommandArgs }[];
  /** Bumped whenever `registered` or `applied` changes. */
  readonly revision: number;
}

/**
 * Phase 23.8: `ctx.debug` — project debug commands (a test or debug tool, the
 * in-game console and `tl_game_control` run them). A command runs inside the
 * simulation step as part of the step's input, so a recording replays it.
 */
export interface BehaviorDebug {
  /**
   * Declare the debug command `name` (the first declaration fixes its
   * arguments; calling it again every step is how a script listens) and get
   * the calls made to it in this step — in the `intent` phase; the other
   * phases see none. With `handler`, it also runs once per call, right here.
   * Every script instance that declares the command receives each call.
   * Engine limits: 32 commands per game; a second declaration with other
   * arguments throws.
   * @graphNode skip a debug command is declared in code (typed arguments, an optional handler)
   */
  command(name: string, options?: DebugCommandOptions, handler?: (args: DebugCommandArgs) => void): readonly DebugCommandArgs[];
}

/** A script sound's end (`ctx.audio.events()`), seen in the step after it happened. */
export interface AudioFinishedEvent {
  readonly kind: 'finished';
  readonly handle: number;
  readonly assetId: string;
  /** `ended`: it played to its end; `stopped`: a script stopped it (after its fade). */
  readonly reason: 'ended' | 'stopped';
}

/** Options of `ctx.audio.play`. */
export interface AudioPlayOptions {
  /** 0–1 (1). */
  volume?: number;
  /** Loop until stopped (false). */
  loop?: boolean;
  /** Playback rate, 0.25–4 (1: as recorded; 2: an octave up and twice as fast). */
  pitch?: number;
  /** The bus (sfx). */
  bus?: 'sfx' | 'music' | 'voice' | 'ui';
  /** Seconds to fade in from silence (0). */
  fadeIn?: number;
  /** Positional: follow this entity (`position` is then an offset from it). */
  entityId?: string;
  /** Positional: world position in metres (or the offset from `entityId`). */
  position?: readonly number[];
  /** Positional: linear, inverse or exponential (linear). */
  distanceModel?: 'linear' | 'inverse' | 'exponential';
  /** Positional: full volume within this distance, m (2). */
  refDistance?: number;
  /** Positional: silent (linear) or no more fading (others) beyond this distance, m (30). */
  maxDistance?: number;
  /** Positional: how fast it fades (1). */
  rolloff?: number;
}

/** Options of `ctx.audio.stinger`. */
export interface AudioStingerOptions {
  /** 0–1 (1). */
  volume?: number;
  /** The music's level under it, 0–1 (0.3). */
  duck?: number;
  /** Seconds to duck and to come back (0.25). */
  fade?: number;
}

/** A script's view of the music (`ctx.audio.musicState()`). */
export interface AudioMusicState {
  /** Who picks the track: the scripts (after `music`), or the host (`flow`: since phase 24.7 deleted the level flow, nothing plays then). */
  readonly owner: 'script' | 'flow';
  /** The scripts' track (null: silence, or the host owns it). */
  readonly track: string | null;
  /** The music duck now (1 = not ducked). */
  readonly duck: number;
}

/**
 * Phase 9.10: `ctx.audio`. Phase 23.13: playback handles, music control and
 * positional sound — what scripts ask for is simulation state (handles,
 * volumes, fades, finished events replay identically); the page's audio
 * engine plays it.
 */
export interface BehaviorAudio {
  /**
   * Play an audio asset (volume 0–1). Returns its handle (0 when refused: a bad id, more than 32 plays in one step or 64 sounds alive). Options: `loop`, `pitch` (playback rate 0.25–4), `bus` (sfx, music, voice, ui), `fadeIn` seconds; positional with `entityId` (it follows the entity) and/or `position` (world metres, or the offset from the entity), fading by `distanceModel` (linear, inverse, exponential), `refDistance` (2 m), `maxDistance` (30 m) and `rolloff` (1).
   * @graphNode Play sound
   * @graphLabel assetId sound
   * @graphAsset assetId audio
   * @graphDefault volume 1
   */
  play(assetId: string, options?: AudioPlayOptions): number;
  /**
   * Stop a sound, fading out over `fadeSeconds` (0: now). Its finished event (reason "stopped") arrives in the step after the fade ends.
   * @graphNode Stop sound
   * @graphDefault fadeSeconds 0
   */
  stop(handle: number, fadeSeconds?: number): void;
  /**
   * Fade a sound's volume to `to` (0–1) over `seconds` (linear, whole steps).
   * @graphNode Fade sound
   * @graphDefault to 0
   * @graphDefault seconds 1
   */
  fade(handle: number, to: number, seconds: number): void;
  /**
   * Set a sound's volume (0–1) now.
   * @graphNode Set sound volume
   * @graphDefault volume 1
   */
  setVolume(handle: number, volume: number): void;
  /**
   * Set a sound's pitch — its playback rate, 0.25–4 (1: as recorded; it plays faster or slower too).
   * @graphNode Set sound pitch
   * @graphDefault pitch 1
   */
  setPitch(handle: number, pitch: number): void;
  /**
   * Loop a sound or let it end at the end of its clip.
   * @graphNode Set sound loop
   */
  setLoop(handle: number, loop: boolean): void;
  /**
   * Whether a sound is still playing (its finished event has not happened).
   * @graphNode Sound playing
   * @graphPure
   */
  playing(handle: number): boolean;
  /**
   * A sound's volume now (its fade included; 0 when it is not playing).
   * @graphNode Sound volume
   * @graphPure
   */
  volumeOf(handle: number): number;
  /**
   * True in the step after a sound finished (it ended or was stopped).
   * @graphNode Sound finished
   * @graphPure
   */
  finished(handle: number): boolean;
  /**
   * The sounds that finished in the previous step (handle, asset, reason "ended" or "stopped").
   * @graphNode skip a list of records; the Sound finished node checks one handle
   */
  events(): readonly AudioFinishedEvent[];
  /**
   * Play a music track (looped), crossfading over `fadeSeconds` (1); null fades to silence. The scripts then own the music until `releaseMusic`.
   * @graphNode Set music
   * @graphLabel assetId track
   * @graphAsset assetId music
   * @graphDefault fadeSeconds 1
   */
  music(assetId: string | null, fadeSeconds?: number): void;
  /**
   * Give the music back to the host (silence since phase 24.7 deleted the level flow's music), crossfading over `fadeSeconds` (1).
   * @graphNode Release music
   * @graphDefault fadeSeconds 1
   */
  releaseMusic(fadeSeconds?: number): void;
  /**
   * Play a stinger (a short musical phrase) once over the music: the track ducks to `duck` (0.3) while it plays and comes back after it, both over `fade` seconds (0.25). Returns its handle.
   * @graphNode Play stinger
   * @graphLabel assetId sound
   * @graphAsset assetId audio
   */
  stinger(assetId: string, options?: AudioStingerOptions): number;
  /**
   * Duck the music to `level` (0–1; 0.3) over `seconds` (0.25) until `unduck`. The deepest duck alive wins (a stinger's, dialogue voice's).
   * @graphNode Duck music
   * @graphDefault level 0.3
   * @graphDefault seconds 0.25
   */
  duck(level: number, seconds?: number): void;
  /**
   * End the script's music duck over `seconds` (0.25).
   * @graphNode Unduck music
   * @graphDefault seconds 0.25
   */
  unduck(seconds?: number): void;
  /**
   * Who picks the music (the scripts or the host), the scripts' track and the duck now.
   * @graphNode Music state
   * @graphPure
   */
  musicState(): AudioMusicState;
  /**
   * Mix a bus (sfx, music, voice, ui) to `volume` (0–1) over `seconds` (0), on top of the player's volume setting.
   * @graphNode Set bus volume
   * @graphDefault volume 1
   * @graphDefault seconds 0
   */
  setBusVolume(bus: 'sfx' | 'music' | 'voice' | 'ui', volume: number, seconds?: number): void;
  /**
   * The scripts' mix of a bus now (1 unless set).
   * @graphNode Bus volume
   * @graphPure
   */
  busVolume(bus: 'sfx' | 'music' | 'voice' | 'ui'): number;
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
  /** What asked: a script, or the entity's `effect` component (its signal). Phase 24.7: the character controller's gameplay hooks were deleted. */
  readonly source: 'script' | 'component';
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
   * Stop spawning: a play's handle, or an object's id (every effect playing on it, its effect component included). Living particles finish their lifetimes.
   * @graphNode Stop effect
   */
  stop(target: number | string): void;
}

/** Phase 23.4: a blend a script names for the camera change it makes (absent: the camera's own). */
export interface CameraBlendOptions {
  /** `cut`, `linear` or `eased`. */
  blend?: 'cut' | 'linear' | 'eased';
  /** Seconds (0–30). */
  time?: number;
}

/** Phase 23.4: a virtual camera's live rig values (`ctx.camera.get`). */
export interface BehaviorCameraState {
  readonly rig: 'follow' | 'orbitPoint' | 'topDown' | 'fixed' | 'rail';
  readonly enabled: boolean;
  readonly priority: number;
  /** It is the live camera. */
  readonly live: boolean;
  /** The target entity ('' for none). */
  readonly target: string;
  readonly distance: number;
  /** Degrees (a snapped rig: the step it turns to). */
  readonly yaw: number;
  readonly pitch: number;
  /** A rail camera's place along its path (0–1). */
  readonly progress: number;
  readonly railSpeed: number;
  readonly fovY: number;
  readonly letterbox: number;
}

/** Phase 23.9a: one UI event of this step (from the input frame). */
export interface BehaviorUiEvent {
  /** click (a button's event action), submit (an input), focus (the focus moved to `widget`), custom, show, hide, toggle; mode (a mode action: `value` is the mode), restart (the engine's restart), scene (the game shell's move along its scene list: `value` is the entry). */
  readonly kind: 'click' | 'submit' | 'focus' | 'custom' | 'show' | 'hide' | 'toggle' | 'mode' | 'restart' | 'scene';
  /** The UI document it happened in. */
  readonly doc: string;
  /** The widget ('' for none). */
  readonly widget: string;
  /** The event name ('' for focus, show, hide). */
  readonly name: string;
  /** The value the action carried (or the submitted text). */
  readonly value?: number | string | boolean | null;
  /** The list item it came from. */
  readonly index?: number;
}

/**
 * Phase 23.9a: `ctx.ui` — the project UI. Scripts publish view-model values
 * that UI documents bind to (`{ "bind": "hud.hp" }`, `{hud.hp}` in a text),
 * show and hide documents, and read the UI events of the step (clicks,
 * submits, focus changes: part of the input frame, so replays hold). The
 * game host draws the documents; the view model and the shown documents are
 * simulation state.
 */
/** Phase 23.18: how a change to an environment preset happens (`ctx.environment.set`). */
export interface EnvironmentChangeOptions {
  /** Seconds the blend takes (0–600; 0 or absent: at once). */
  blend?: number;
  /** How the blend progresses. */
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
  /** Per-field changes over the preset: { sky?, fog?, post?, lights?, lightmap? }, each merged over the preset's (a light list adds entries). */
  override?: { readonly [part: string]: unknown };
}

/**
 * Phase 23.18 (E17): `ctx.environment` — switch or blend the look (sky, fog,
 * light colours and intensities, exposure and grading) between the project's
 * environment presets at run time. `''` names the base look (the project
 * environment with the level's look). The blend is simulation state: it
 * replays, runs alike in the simulation worker and can be saved.
 */
export interface BehaviorEnvironment {
  /**
   * Switch to a preset ('' = the base look), blending over `blend` seconds from the look now (an interrupted blend continues from where it is). False when there is no such preset or an option is refused.
   * @graphNode Set environment
   * @graphLabel presetId preset
   * @graphLabel blend blend (seconds)
   */
  set(presetId: string, options?: EnvironmentChangeOptions): boolean;
  /**
   * Hold a mix of two presets: t = 0 shows a, 1 shows b (a timeline or a script drives t; '' = the base look). Stops a running blend.
   * @graphNode Blend environments
   * @graphDefault t 0.5
   */
  blend(a: string, b: string, t: number): boolean;
  /**
   * The preset the last change went to ('' = the base look), how far its blend is (0–1) and whether one is running.
   * @graphPure
   * @graphNode Environment state
   */
  state(): { target: string; progress: number; blending: boolean };
  /**
   * How much of a preset is in the look now (0–1; '' = the base look).
   * @graphPure
   * @graphNode Environment weight
   * @graphLabel presetId preset
   */
  weight(presetId: string): number;
  /**
   * The project's environment preset ids.
   * @graphPure
   * @graphNode Environment presets
   */
  presets(): readonly string[];
}

export interface BehaviorUi {
  /**
   * Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.
   * @graphNode Set UI value
   */
  set(path: string, value: unknown): boolean;
  /**
   * The published value at a path (null when there is none).
   * @graphPure
   * @graphNode UI value
   */
  get(path: string): unknown;
  /**
   * Remove a path from the view model (`false` when it was not there).
   * @graphNode Clear UI value
   */
  clear(path: string): boolean;
  /**
   * Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.
   * @graphNode Show UI
   * @graphLabel docId document
   */
  show(docId: string, options?: { layer?: number; modal?: boolean }): boolean;
  /**
   * Hide a shown UI document (`false` when it was not shown).
   * @graphNode Hide UI
   * @graphLabel docId document
   */
  hide(docId: string): boolean;
  /**
   * The document is shown.
   * @graphPure
   * @graphNode UI shown
   * @graphLabel docId document
   */
  isShown(docId: string): boolean;
  /**
   * Play a tween of a document (on a widget, or the whole document). Presentation only.
   * @graphNode Play UI tween
   * @graphLabel docId document
   */
  play(docId: string, tween: string, widgetId?: string): boolean;
  /**
   * Move the keyboard/gamepad focus to a widget of a shown document.
   * @graphNode Focus UI widget
   * @graphLabel docId document
   * @graphLabel widgetId widget
   */
  focus(docId: string, widgetId: string): boolean;
  /**
   * The UI events of this step (clicks, submits, focus changes, shows and hides), in order.
   * @graphPure
   * @graphNode UI events
   */
  events(): readonly BehaviorUiEvent[];
  /**
   * The first UI event of this step with this name (a button's or an input's event), or null.
   * @graphPure
   * @graphNode UI event
   */
  event(name: string): BehaviorUiEvent | null;
}

/** Phase 23.16: a value of a dialogue variable or binding. */
export type DialogueVariableValue = number | string | boolean | null;

/** Phase 23.16: one dialogue event (seen by scripts in the step after it happened). */
export interface BehaviorDialogueEvent {
  /** start, lineStart, lineEnd, choice (options shown), chosen, signal, end. */
  readonly kind: 'start' | 'lineStart' | 'lineEnd' | 'choice' | 'chosen' | 'signal' | 'end';
  /** The conversation (the number `start` returned). */
  readonly conversation: number;
  readonly dialogueId: string;
  /** The node (a line, a choice, a signal; '' for start/end). */
  readonly nodeId: string;
  /** lineStart: the speaker id ('' for narration). */
  readonly speaker: string;
  /** lineStart: the line as shown (rich text); chosen: the option's text. */
  readonly text: string;
  /** signal: its name; end: why (end, stopped, loop). */
  readonly name: string;
  /** signal: its value. */
  readonly value: string;
  /** chosen: the option's index among those shown; else -1. */
  readonly index: number;
}

/** Phase 23.16: the conversation now. */
export interface BehaviorDialogueState {
  readonly conversation: number;
  readonly dialogueId: string;
  readonly nodeId: string;
  /** line, choice, signal (waiting for resume), wait. */
  readonly kind: 'line' | 'choice' | 'signal' | 'wait';
  readonly speaker: string;
  /** The line as shown (rich text; '' when not on a line). */
  readonly text: string;
  /** Visible characters of the line so far, and in all. */
  readonly revealed: number;
  readonly total: number;
  /** The options shown, in order (a choice), as their texts. */
  readonly options: readonly string[];
}

/** Phase 23.16: one line (or a chosen option) in the backlog. */
export interface BehaviorDialogueHistoryEntry {
  readonly dialogueId: string;
  readonly nodeId: string;
  readonly speaker: string;
  /** The speaker's display name ('' for narration or a chosen option). */
  readonly name: string;
  readonly text: string;
  /** A line, or the option the player picked. */
  readonly choice: boolean;
}

/**
 * Phase 23.16: `ctx.dialogue` — conversations (dialogue graphs of the
 * project). A script starts one; the engine runs it in the simulation (the
 * typewriter reveal, voice clips on the voice bus with music and effects
 * ducked, auto-advance, skip-if-seen, choices, conditions and effects on the
 * dialogue variables) and shows it in the dialogue UI document. Player input
 * (advance, choose, skip, auto, backlog) arrives as input-frame entries, so
 * replays hold. Calls take effect at the end of the step; events are seen in
 * the next step.
 */
export interface BehaviorDialogue {
  /**
   * Start a conversation (at its Start, a named entry, or any node); bindings are values its lines and conditions read as $name. Returns the conversation number, or 0 (unknown dialogue, entry or node, or one is running).
   * @graphNode Start dialogue
   * @graphLabel dialogueId dialogue
   */
  start(dialogueId: string, options?: { entry?: string; node?: string; bindings?: Readonly<Record<string, DialogueVariableValue>> }): number;
  /**
   * End the running conversation.
   * @graphNode Stop dialogue
   */
  stop(): boolean;
  /**
   * A conversation is running (this one, when given).
   * @graphPure
   * @graphNode Dialogue running
   */
  isRunning(conversation?: number): boolean;
  /**
   * The conversation now (null when none).
   * @graphPure
   * @graphNode Dialogue state
   */
  current(): BehaviorDialogueState | null;
  /**
   * Advance: reveal the rest of the line, or go on after it.
   * @graphNode Advance dialogue
   */
  advance(): boolean;
  /**
   * Pick an option of the choice shown (0 = the first shown).
   * @graphNode Choose option
   */
  choose(index: number): boolean;
  /**
   * Continue after a Signal node that waits.
   * @graphNode Resume dialogue
   */
  resume(): boolean;
  /**
   * Skip lines already seen (until an unseen line or a choice).
   * @graphNode Set dialogue skip
   */
  setSkip(on: boolean): void;
  /**
   * The player's auto-advance (null: the project's setting).
   * @graphNode Set dialogue auto
   */
  setAuto(on: boolean | null): void;
  /**
   * The player's text speed in characters per second (0: whole lines at once; null: the project's setting).
   * @graphNode Set text speed
   */
  setTextSpeed(charsPerSecond: number | null): void;
  /**
   * The dialogue events of the previous step (line starts and ends, choices, picks, signals, starts and ends), in order.
   * @graphPure
   * @graphNode Dialogue events
   */
  events(): readonly BehaviorDialogueEvent[];
  /**
   * The first dialogue event of the previous step of this kind (and signal name), or null.
   * @graphPure
   * @graphNode Dialogue event
   */
  event(kind: 'start' | 'lineStart' | 'lineEnd' | 'choice' | 'chosen' | 'signal' | 'end', name?: string): BehaviorDialogueEvent | null;
  /**
   * A dialogue variable (null when unset).
   * @graphPure
   * @graphNode Dialogue variable
   */
  get(name: string): DialogueVariableValue;
  /**
   * Set a dialogue variable (conditions and effects read and write them); false for a bad name or value.
   * @graphNode Set dialogue variable
   */
  set(name: string, value: DialogueVariableValue): boolean;
  /**
   * Every dialogue variable.
   * @graphNode skip a map of values; use Dialogue variable
   */
  variables(): Readonly<Record<string, DialogueVariableValue>>;
  /**
   * The line (or option) was seen: "dialogueId/nodeId".
   * @graphPure
   * @graphNode Line seen
   */
  seen(key: string): boolean;
  /**
   * The backlog: the lines shown and options picked, oldest first.
   * @graphNode skip a list of records; UI documents bind dialogue.backlog
   */
  history(): readonly BehaviorDialogueHistoryEntry[];
}

/** Phase 23.10: one enter or exit of a game mode switch (`ctx.modes.events()`). */
export interface BehaviorModeEvent {
  /** enter (the mode became current) or exit (it ended). */
  readonly kind: 'enter' | 'exit';
  /** The mode entered or left. */
  readonly mode: string;
  /** The mode on the other side of the switch ('' at a run start). */
  readonly other: string;
}

/** Phase 23.10: how a switch looks (absent fields: the target mode's own transition, then the camera's blend). */
export interface BehaviorModeTransition {
  /** The camera blend into the mode's camera: cut, linear or eased. */
  blend?: 'cut' | 'linear' | 'eased';
  /** Seconds of the camera blend (0–30). */
  blendTime?: number;
  /** A UI document shown from the switch for `fadeTime` seconds (its show/hide tweens make the fade). */
  fade?: string;
  /** Seconds the fade document stays (0.05–10; default 0.5). */
  fadeTime?: number;
}

/**
 * Phase 23.10: `ctx.modes` — the project's game modes. A mode decides the
 * active input maps, the live camera, the UI documents shown and the behavior
 * groups that tick; a switch changes them together in one step, without a
 * scene load. `switch` applies at the next step boundary; the enter/exit
 * events are read in the step the switch applied (intent phase), like UI
 * events. A game without modes answers '' / false.
 */
export interface BehaviorModes {
  /**
   * The current game mode ('' when the project has none).
   * @graphPure
   * @graphNode Current mode
   */
  current(): string;
  /**
   * The mode before the current one ('' at the start of a run).
   * @graphPure
   * @graphNode Previous mode
   */
  previous(): string;
  /**
   * The current mode is this one.
   * @graphPure
   * @graphNode Mode is
   * @graphLabel modeId mode
   */
  is(modeId: string): boolean;
  /**
   * Switch to a game mode at the next step (its input maps, camera, UI documents and ticking groups together; no scene load). `false` for a mode the project does not have or a bad transition.
   * @graphNode Switch mode
   * @graphLabel modeId mode
   */
  switch(modeId: string, transition?: BehaviorModeTransition): boolean;
  /**
   * This step's enter and exit events (the step a switch applied in), in order.
   * @graphPure
   * @graphNode Mode events
   */
  events(): readonly BehaviorModeEvent[];
  /**
   * A mode was entered this step (this one, or any when empty).
   * @graphPure
   * @graphNode Mode entered
   * @graphLabel modeId mode
   */
  entered(modeId?: string): boolean;
  /**
   * A mode ended this step (this one, or any when empty).
   * @graphPure
   * @graphNode Mode exited
   * @graphLabel modeId mode
   */
  exited(modeId?: string): boolean;
  /**
   * Seconds since the current mode was entered.
   * @graphPure
   * @graphNode Time in mode
   */
  time(): number;
}

/**
 * Phase 23.10: `ctx.lifecycle` — the engine's run lifecycle: respawn the
 * character at a player spawn and restart the run. Winning, losing and what a
 * death means are the game's own rules (scripts); this is only the mechanism. Phase 24.7: it
 * works on the 2D plane too (the character controller session that owned it is gone).
 */
export interface BehaviorLifecycle {
  /**
   * Move the character (the controller's object) to a player spawn and stop it — the active spawn, or the one named (which becomes the active one). In 3D applied after this step's intent phase (a later phase: the next step); on the 2D plane at the next step boundary. `false` without a character or for an unknown spawn.
   * @graphNode Respawn player
   * @graphLabel spawnId spawn
   */
  respawn(spawnId?: string): boolean;
  /**
   * Make a player spawn (an object with the Player spawn component) the one respawn uses.
   * @graphNode Set spawn point
   * @graphLabel spawnId spawn
   */
  setSpawn(spawnId: string): boolean;
  /**
   * The active player spawn ('' when there is none: respawn then uses where the player started).
   * @graphPure
   * @graphNode Spawn point
   */
  spawnPoint(): string;
  /**
   * Restart the run at the next step: scenes, objects, scripts, cameras, UI and the start mode as at the start.
   * @graphNode Restart run
   */
  restart(): boolean;
}

/** Phase 23.17: one timeline event (seen in the step after it happened). */
export interface BehaviorTimelineEvent {
  /** started, ended or marker (a marker of the timeline was reached). */
  readonly kind: 'started' | 'ended' | 'marker';
  readonly handle: number;
  /** The timeline's id. */
  readonly timeline: string;
  /** marker: its name ('' otherwise). */
  readonly name: string;
  /** ended: finished, skipped or stopped ('' otherwise). */
  readonly reason: '' | 'finished' | 'skipped' | 'stopped';
  readonly stepIndex: number;
}

/**
 * Phase 23.17: `ctx.timeline` — play project timelines (sequences of camera
 * cuts, moves, animation, sound, dialogue, effects, signals, fades) as an
 * engine system in the simulation step. Calls take effect at the end of the
 * step; events (started, ended, marker) are seen in the next step, so a
 * script never waits: it reacts to the events or to the timeline's signals.
 */
export interface BehaviorTimeline {
  /**
   * Play a timeline, binding its slots to objects (`{ slot: entityId }`; unbound slots use the timeline's defaults). Returns its handle (0 when refused: no such timeline, or 8 already playing).
   * @graphNode Play timeline
   * @graphLabel timelineId timeline
   */
  play(timelineId: string, bindings?: Readonly<Record<string, string>>): number;
  /**
   * Pause a playing timeline (it holds its current state).
   * @graphNode Pause timeline
   */
  pause(handle: number): boolean;
  /**
   * Resume a paused timeline.
   * @graphNode Resume timeline
   */
  resume(handle: number): boolean;
  /**
   * Stop a timeline where it is (no end states: the sounds and effects it started stop, the cameras go back).
   * @graphNode Stop timeline
   */
  stop(handle: number): boolean;
  /**
   * Skip to the end: every track's end state at once (cameras, transforms, music, activation; remaining signals fire unless a key says drop).
   * @graphNode Skip timeline
   */
  skip(handle: number): boolean;
  /**
   * Jump to a time (seconds): the moves, fades and cameras there; keys in between do not fire.
   * @graphNode Seek timeline
   * @graphDefault seconds 0
   */
  seek(handle: number, seconds: number): boolean;
  /**
   * A play's state: playing, paused, waiting (for input or a dialogue), ended (recently), or null.
   * @graphPure
   * @graphNode Timeline state
   */
  state(handle: number): 'playing' | 'paused' | 'waiting' | 'ended' | null;
  /**
   * A play's time in seconds (counted in fixed steps).
   * @graphPure
   * @graphNode Timeline time
   */
  time(handle: number): number;
  /**
   * Whether any play of this timeline is running.
   * @graphPure
   * @graphNode Timeline playing
   * @graphLabel timelineId timeline
   */
  isPlaying(timelineId: string): boolean;
  /**
   * The timeline events of the previous step (started, ended, marker), in order.
   * @graphNode skip a list of records; the Timeline ended and Timeline marker nodes check one
   */
  events(): readonly BehaviorTimelineEvent[];
  /**
   * True in the step after a play ended (finished, skipped or stopped).
   * @graphPure
   * @graphNode Timeline ended
   */
  ended(handle: number): boolean;
  /**
   * True in the step after a marker with this name was reached (of the play `handle`, or of any play when 0).
   * @graphPure
   * @graphNode Timeline marker
   * @graphDefault handle 0
   */
  marker(name: string, handle?: number): boolean;
}

/**
 * Phase 23.4: `ctx.camera` — the virtual cameras (the `virtualCamera`
 * component): which is live, their rig values, shake and screen↔world
 * projection. Changes take effect at the end of the step (the camera brain
 * resolves the live camera after every script has run); reads and the
 * projection use the camera as resolved at the end of the previous step.
 * The projection uses normalized screen coordinates — x 0 (left) to 1
 * (right), y 0 (top) to 1 (bottom) — and the viewport aspect the host
 * reports.
 */
export interface BehaviorCamera {
  /**
   * Enable a virtual camera and bring it in front of the cameras of its priority (it goes live unless a higher priority is enabled). `false` when there is no such camera.
   * @graphNode Activate camera
   * @graphLabel cameraId camera
   */
  activate(cameraId: string, options?: CameraBlendOptions): boolean;
  /**
   * Disable a virtual camera (the view blends to the next one, or back to the scene camera).
   * @graphNode Deactivate camera
   * @graphLabel cameraId camera
   */
  deactivate(cameraId: string, options?: CameraBlendOptions): boolean;
  /**
   * Set a camera's priority (−1000–1000; the enabled camera with the highest is live).
   * @graphNode Set camera priority
   * @graphLabel cameraId camera
   */
  setPriority(cameraId: string, priority: number): boolean;
  /**
   * Point a camera at another target entity ('' for none).
   * @graphNode Set camera target
   * @graphLabel cameraId camera
   * @graphLabel entityId target
   */
  setTarget(cameraId: string, entityId: string): boolean;
  /**
   * Set a camera's rig values (each optional): distance, yaw, pitch (kept within its pitch limits), progress and railSpeed of a rail camera, field of view, letterbox, the orbit point, the target offset.
   * @graphNode Set camera rig
   * @graphLabel cameraId camera
   */
  set(
    cameraId: string,
    params: {
      distance?: number;
      yaw?: number;
      pitch?: number;
      progress?: number;
      railSpeed?: number;
      fovY?: number;
      letterbox?: number;
      point?: readonly number[];
      targetOffset?: readonly number[];
    },
  ): boolean;
  /**
   * Turn a camera by whole steps (an orbit-a-point camera: its turn step; positive turns left).
   * @graphNode Turn camera
   * @graphLabel cameraId camera
   * @graphDefault steps 1
   */
  turn(cameraId: string, steps: number): boolean;
  /**
   * Shake the view: up to `amplitude` metres (and `rotation` degrees), `frequency` times a second (default 8), fading out over `seconds`. Seeded: the same run shakes the same way (`seed` picks another pattern).
   * @graphNode Shake camera
   * @graphDefault amplitude 0.2
   * @graphDefault seconds 0.5
   * @graphDefault frequency 8
   * @graphDefault rotation 0
   * @graphDefault seed 0
   */
  shake(amplitude: number, seconds: number, frequency?: number, rotation?: number, seed?: number): void;
  /**
   * The live virtual camera, or null while the scene camera shows its own view.
   * @graphPure
   * @graphNode Live camera
   */
  live(): string | null;
  /**
   * A blend between two cameras is in progress.
   * @graphPure
   * @graphNode Camera blending
   */
  blending(): boolean;
  /**
   * A virtual camera's live rig values, or null when there is no such camera.
   * @graphPure
   * @graphNode Camera state
   * @graphLabel cameraId camera
   */
  get(cameraId: string): BehaviorCameraState | null;
  /**
   * Where a world point appears on screen (x, y 0–1 from the top left), how far in front of the camera it is, and whether it is in view.
   * @graphPure
   * @graphNode World to screen
   */
  worldToScreen(position: readonly number[]): { x: number; y: number; depth: number; onScreen: boolean };
  /**
   * The ray from the camera through a screen point (x, y 0–1 from the top left): its origin and unit direction.
   * @graphPure
   * @graphNode Screen to ray
   * @graphDefault x 0.5
   * @graphDefault y 0.5
   */
  screenToRay(x: number, y: number): { origin: readonly [number, number, number]; direction: readonly [number, number, number] };
}

/**
 * Phase 23.11: `ctx.sockets` — objects riding on named nodes (bones or any
 * node) of other objects' models. The simulation places an attached object
 * at the end of every step, after the animators, so it follows the target's
 * animation in Play, the worker and the export alike.
 */
export interface BehaviorSockets {
  /**
   * Attach an object to a node of the target's model, with an optional offset in the node's space (position [x, y, z], rotation quaternion [x, y, z, w], scale [x, y, z]). Without a target the object's own Socket component is used. False (and a warning in the play log) when refused: an unknown object, target or node, a loop, or a physics body or the scene camera.
   * @graphNode Attach to socket
   * @graphLabel entityId object
   * @graphLabel targetId target
   * @graphLabel node node
   */
  attach(entityId: string, targetId?: string, node?: string, position?: readonly number[], rotation?: readonly number[], scale?: readonly number[]): boolean;
  /**
   * Detach an object from its socket: it stays where the node left it (keepWorld, the default) or snaps back to its transform from before the attach. False when it was not attached.
   * @graphNode Detach from socket
   * @graphLabel entityId object
   * @graphDefault keepWorld true
   */
  detach(entityId: string, keepWorld?: boolean): boolean;
  /**
   * The socket an object rides on (the target object and the node's name), or null.
   * @graphPure
   * @graphNode Socket of
   * @graphLabel entityId object
   */
  attachedTo(entityId: string): { readonly target: string; readonly nodeName: string } | null;
  /**
   * A node's world position and rotation now (the target's model posed by its animator), or null when the target, its model or the node is missing — e.g. where a muzzle or a hand is.
   * @graphPure
   * @graphNode Node pose
   * @graphLabel targetId target
   * @graphLabel node node
   */
  nodePose(targetId: string, node: string): { readonly position: readonly [number, number, number]; readonly rotation: readonly [number, number, number, number] } | null;
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
   * Add to one of the run's named counters (any name); HUD documents read them (`$flow.counters.<name>`).
   * @graphNode Add to counter
   * @graphLabel name counter
   * @graphDefault amount 1
   */
  add(name: string, amount: number): void;
  /**
   * The character's health (the controller's object), or null when it has none.
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

/**
 * Phase 24.4b: `ctx.health` — the health of any object with a Health
 * component. Changes apply at once (a later `get` in the same step sees them);
 * each is an event (`damaged`, `healed`, and `died` when it reaches 0) that
 * scripts owning the object read in the next step's `ctx.events` (all of them:
 * `events()`). What reaching 0 means is the game's rule: the engine only
 * reports it.
 */
export interface BehaviorHealth {
  /**
   * The object's health now, or null when it has no Health component.
   * @graphPure
   * @graphNode Health of
   * @graphLabel entityId object
   */
  get(entityId: string): { current: number; max: number } | null;
  /**
   * Take `amount` (> 0) from the object's health, not below 0 (a `damaged` event, and `died` when it reaches 0). `source` names what did it (an object id or any text). False without health, when it is already at 0, or for a bad amount.
   * @graphNode Damage
   * @graphLabel entityId object
   * @graphDefault amount 1
   */
  damage(entityId: string, amount: number, source?: string): boolean;
  /**
   * Give `amount` (> 0) back, not above its maximum (a `healed` event). False without health, at its maximum, or for a bad amount.
   * @graphNode Heal
   * @graphLabel entityId object
   * @graphDefault amount 1
   */
  heal(entityId: string, amount: number): boolean;
  /**
   * Every object's health events of the previous step (damaged, healed, died), in the order they happened.
   * @graphPure
   * @graphNode Health events
   */
  events(): readonly HealthEventRecord[];
}

/** Phase 24.4c: `ctx.patrol` — objects with a Patrol component. */
export interface BehaviorPatrol {
  /**
   * The way a patroller walks now (a unit vector) and whether it walks at all; null for an object without a patrol.
   * @graphPure
   * @graphNode Patrol state
   * @graphLabel entityId object
   */
  get(entityId: string): { direction: readonly [number, number, number]; active: boolean } | null;
  /**
   * Stop a patroller where it is, or let it walk on. False for an object without a patrol.
   * @graphNode Set patrol active
   * @graphLabel entityId object
   * @graphDefault active true
   */
  setActive(entityId: string, active: boolean): boolean;
  /**
   * Turn a patroller around now (a `turned` event). False for an object without a patrol, or a waypoint loop (it only goes forward).
   * @graphNode Turn patroller
   * @graphLabel entityId object
   */
  turn(entityId: string): boolean;
}

/** Phase 24.4d: `ctx.hitbox` — objects with a Hitbox component. */
export interface BehaviorHitbox {
  /**
   * Switch a hitbox off (it touches nothing: its contacts end) or on again. False for an object without a hitbox.
   * @graphNode Set hitbox active
   * @graphLabel entityId object
   * @graphDefault active true
   */
  setActive(entityId: string, active: boolean): boolean;
  /**
   * The objects a hitbox (or the character) touches now, sorted by id.
   * @graphPure
   * @graphNode Touching
   * @graphLabel entityId object
   */
  touching(entityId: string): readonly string[];
}

/** Phase 24.4a: `ctx.collectible` — objects with a Collectible component. */
export interface BehaviorCollectible {
  /**
   * Whether a collectible has been collected (and not come back yet).
   * @graphPure
   * @graphNode Is collected
   * @graphLabel entityId object
   */
  collected(entityId: string): boolean;
  /**
   * Bring a collected collectible back now (shown, collectable again; a `restored` event). False when it is not collected.
   * @graphNode Restore collectible
   * @graphLabel entityId object
   */
  restore(entityId: string): boolean;
}

/** Phase 24.4f: `ctx.character` — the character (the object with the Character controller). */
export interface BehaviorCharacter {
  /**
   * Add `velocity` [x, y, z] (m/s, each at most 100 either way) to the character's velocity at its next move — a push, a launch, a knock back or a bounce; its own acceleration then brings it back to what the input asks. A positive y lifts it off the ground. The 2D plane ignores z. Impulses in one step add up. False without a character or for a bad vector.
   * @graphNode Character impulse
   * @graphLabel velocity velocity
   */
  impulse(velocity: readonly [number, number, number]): boolean;
}

/**
 * Phase 24.4h: a look override (`ctx.look.set`): an emissive glow and a tint
 * multiplied into the object's own colour, on every mesh under the object.
 */
export interface BehaviorLookValue {
  /** The glow colour ('#rrggbb'). */
  emissive?: string;
  /** How strongly it glows (0–4; absent with a glow colour: 1). */
  emissiveIntensity?: number;
  /** A colour ('#rrggbb') multiplied into the object's own colour. */
  tint?: string;
}

/** Phase 24.4h: `ctx.look` — per-object look overrides the renderer applies (both renderers). */
export interface BehaviorLook {
  /**
   * Give an object (and every mesh under it) a look override — a glow (emissive colour and intensity) and/or a tint — replacing any it had, until cleared or a new run. False for an object not loaded or a bad value.
   * @graphNode Set look
   * @graphLabel entityId object
   */
  set(entityId: string, look: BehaviorLookValue): boolean;
  /**
   * Give an object its own look back. False when it had no override.
   * @graphNode Clear look
   * @graphLabel entityId object
   */
  clear(entityId: string): boolean;
  /**
   * The object's look override now, or null when it has none.
   * @graphPure
   * @graphNode Look of
   * @graphLabel entityId object
   */
  get(entityId: string): BehaviorLookValue | null;
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
  /**
   * Phase 23.11: set this animator's playback speed (× every clip and crossfade; 1 as authored, 0.5 half speed, 0 holds the pose; 0–10). False for a value outside 0–10.
   * @graphNode Set animation speed
   * @graphDefault speed 1
   */
  setSpeed(speed: number): boolean;
  /**
   * Phase 23.11: this animator's playback speed.
   * @graphPure
   * @graphNode Animation speed
   */
  speed(): number;
  /**
   * Phase 23.11: set a morph target's weight (0–1) by its name in the model (over the controller's parameter binding of that target, if any).
   * @graphNode Set morph weight
   * @graphLabel name morph target
   */
  setMorph(name: string, weight: number): boolean;
  /**
   * Phase 23.11: a morph target's weight now (0 when nothing sets it).
   * @graphPure
   * @graphNode Morph weight
   * @graphLabel name morph target
   */
  morph(name: string): number;
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
  /**
   * Phase 24.3: components the module needs on at least one scene entity (a
   * composition refuses to start the module without one, naming the
   * component). The module declares it; no host assumes it.
   */
  requiresEntityWith?: readonly string[];
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
   * no script registered the command, the arguments do not match its
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
