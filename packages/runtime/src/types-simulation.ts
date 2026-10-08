/**
 * Runtime types of the simulation: the instantiate config, simulation state,
 * modules and their phases, and the step context a module runs with.
 */

import type { EntityV3, Quat, Vec3 } from '@thirdlight/project-model';
import type { ActionFrame, ActionSource } from './actions';
import type { BehaviorIntent, BehaviorLogLevel, IntentSet } from './intents';
import type { CharacterClearanceResult3D, PhysicsPort, PhysicsPort3D, PhysicsStepClient, PhysicsVec3, RaycastHit3D, Vec2 } from './ports';
import { type BehaviorSceneControl, type GameplaySettings, type RuntimeSnapshot } from './types-scene';
import { type AnimatorEventRecord, type BehaviorAnimatorControl, type BehaviorCamera, type BehaviorCharacter, type BehaviorCollectible, type BehaviorDialogue, type BehaviorEnvironment, type BehaviorGameState, type BehaviorHealth, type BehaviorHitbox, type BehaviorLifecycle, type BehaviorLook, type BehaviorModes, type BehaviorPatrol, type BehaviorSignals, type BehaviorSockets, type BehaviorTagQuery, type BehaviorTimeline, type BehaviorUi, type BehaviorStats, type BehaviorDisplay } from './types-behavior-world';
import { type BehaviorAudio, type BehaviorEffects, type BehaviorMessageControl, type BehaviorSave, type BehaviorSpawnControl, type DebugCommandArgs, type DebugCommandOptions, type PrimitiveEventRecord, type TriggerEventRecord } from './types-behavior';

/** Config accepted by `instantiateRuntime` (strict shape). */
export interface InstantiateConfig {
  snapshot: RuntimeSnapshot;
  registry: SimulationRegistry;
  /** Module IDs present in `registry`. Default `["thirdlight.demo:box-motion"]`. */
  modules?: readonly string[];
  /** The injected per-step input port. Default: neutral frames. */
  actions?: ActionSource;
  /**
   * An already-initialized physics port. Required by
   * port-requiring sets. Or a 3D port (`PhysicsPort3D`, a project
   * whose `physics_dimension` is 3).
   */
  physics?: PhysicsPort | PhysicsPort3D;
  /** Gameplay settings input, resolved + deep-frozen at instantiate. Default: registry defaults. */
  settings?: unknown;
  /** Monotonic seconds. Default `performance.now() / 1000`. */
  clock?: () => number;
  /** `"raf"` requires `requestAnimationFrame`; `"manual"` = host calls `tick`. */
  driver?: { kind: 'raf' } | { kind: 'manual' };
  /** Integer 1 ≤ v ≤ 1000. Default 120. */
  fixedStepHz?: number;
  /** Called once per frame after the step update. */
  onFrame?: () => void;
  /**
   * Values the scripts see in `ctx.save` from step 0 (a test or
   * debug start: "Play from…", `tl_play_start` variables). Same rules as
   * `ctx.save.set` (≤ 64 keys, each ≤ 4 KB as JSON); a value that breaks
   * them is `config_invalid`.
   */
  variables?: Readonly<Record<string, unknown>>;
  /**
   * The game mode runs start in (a Play start option: "Play
   * from…", `tl_play_start` mode) instead of the first one. A mode the
   * snapshot does not have is `config_invalid`; ignored without modes.
   */
  startMode?: string;
  /** The stored project settings document (values that do not fit the save schema's fields fall back to the defaults). */
  projectSettings?: Readonly<Record<string, unknown>>;
}

/**
 * The independent mutable simulation state. `prev`/`curr`
 * hold the transforms at the end of step n−1 / step n; every simulation
 * mutation writes only here, never to the (deep-frozen) snapshot.
 */
export interface TransformState {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** Per-entity simulation data (the `entities` map values). */
export interface SimEntityData {
  id: string;
  parentId: string | null;
  name?: string;
  transform: TransformState;
  box?: { size: Vec3; material: { color: string } };
  /** v2 marker: the entity carries `components.collider`. */
  hasCollider?: true;
  /** v2 marker: the entity carries `components.controller`. */
  hasController?: true;
  /** The kinds of the entity's components, as stored (`ctx.world.withComponent`). */
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

/** Module config passed to `SimulationModuleSpec.create`. */
export interface ModuleConfig {
  fixedStepHz: number;
  /** The resolved, deep-frozen gameplay settings (M2 sets). */
  settings: Readonly<GameplaySettings>;
  /** The snapshot's `schemaVersion` (3, or 4 for the merged start scenes). */
  sceneVersion: 3 | 4;
  /**
   * The runtime's bounded diagnostics sink for behavior `ctx.log` calls
   * (an M2 host seam): the runtime owns
   * the 32-entry ring, the module owns its per-instance ring and counters.
   */
  /** `at` is where in the project's compiled script the log was called (when found). */
  behaviorLog?: (level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }) => void;
  /** The runtime's live tag index (follows scene loads/unloads). */
  tags?: BehaviorTagQuery;
  /** 3 in a 3D project (absent: the 2D plane) — scripts may drive colliders no mover moves there. */
  physicsDimension?: 3;
  /**
   * 3D projects: read-only queries of the 3D world for the
   * character controller module (a ray; the clearance of the character's
   * capsule at an origin) — not part of the scripts' context.
   */
  character3D?: Character3DQueries;
}

/** The 3D world queries the character controller uses to find a ledge and room on top of it. */
export interface Character3DQueries {
  raycast(origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number): RaycastHit3D | null;
  /** The clearance of the character capsule if its origin were at `origin` (null: the port cannot tell). */
  clearance(origin: PhysicsVec3): CharacterClearanceResult3D | null;
}

/**
 * Simulation module shape:
 * `step` mutates `curr` consistently or throws; `dispose?` is called by
 * `runtime.dispose()`. The shape of an M1 module (one that declares no
 * phases), such as the built-in demo.
 */
export interface SimulationModule {
  step(state: SimState, stepIndex: number): void;
  dispose?(): void;
}

/**
 * The canonical simulation phase order.
 */
export type SimulationPhase = 'intent' | 'controller' | 'transform';

export const SIMULATION_PHASE_ORDER: readonly SimulationPhase[] = [
  'intent',
  'controller',
  'transform',
];

/**
 * The player's collision capsule as the systems use it —
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
  /** The reset character centre (the placed controller's; at a restart, the first controller's). */
  readonly playerCenter: Readonly<Vec2>;
  /**
   * The player controller that was placed (a transfer: a respawn, an
   * arrival, a script's placement). Absent: a run restart, which resets
   * every controller (each from where it starts, `state.curr`).
   */
  readonly characterId?: string;
  readonly state: SimState;
}

/**
 * The M2 phase-declaring module shape. `transformOwners`
 * is declared once, at `create`; the runtime validates it before any step.
 * `SimulationModule` stays the name of the M1 shape.
 */
export interface SimulationPhaseModule {
  readonly transformOwners: readonly string[];
  step(phase: SimulationPhase, ctx: StepContext): void;
  /** The runtime-called reset hook (the character was placed: a restart, an arrival, a respawn). */
  reset?(ctx: ModuleResetContext): void;
  /**
   * A scene was loaded at a step boundary — `entities` are its
   * resolved entities. A module that keeps per-entity state (the behavior
   * host) attaches to them; it may throw to refuse (the load fails the run).
   */
  sceneLoaded?(entities: readonly EntityV3[]): void;
  /**
   * These entities were unloaded; release what belongs to them. `reload`:
   * their scene is reloaded and they come straight back as authored (a
   * script host starts them over as at a run restart, without leave callbacks).
   */
  sceneUnloaded?(entityIds: ReadonlySet<string>, how?: 'unload' | 'reload'): void;
  dispose?(): void;
}

/**
 * The frozen per-phase context. The phase-scoped `state.curr` write target
 * is `ctx.state`.
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
   * The intents committed so far in this step: in the
   * `intent` phase a module sees only what earlier modules committed, in later
   * phases the full set. Frozen.
   */
  readonly intents: IntentSet;
  /**
   * Commit one validated intent (in the contract's exhaustive order). Throws
   * a `BehaviorIntentError` on any rejection; the runtime turns it into the
   * contract's fail-stop.
   */
  emit(intent: BehaviorIntent): void;
  /** The scene API (v4 snapshots with a scene catalog). */
  readonly scenes?: BehaviorSceneControl;
  /** The animators of the loaded entities (`ctx.animator(id)` in scripts). */
  readonly animators?: BehaviorAnimatorControl;
  /** The clip events of the previous step (`ctx.events` in scripts). */
  readonly animatorEvents?: readonly AnimatorEventRecord[];
  /** Signals (seen one step after they are emitted). */
  readonly signals?: BehaviorSignals;
  /** The run's counters and the character's health. */
  readonly game?: BehaviorGameState;
  /** Play a sound (an audio asset) — presentation only, never part of the simulation. */
  readonly audio?: BehaviorAudio;
  /** `ctx.audio` for a script on an object: the sounds it starts belong to that object (or its scene; the play's `owner`). */
  readonly audioOwned?: (entityId: string) => BehaviorAudio;
  /** Play visual effects — presentation only, never part of the simulation. */
  readonly effects?: BehaviorEffects;
  /** Values kept in the player's save. */
  readonly save?: BehaviorSave;
  /** Spawn prefab copies into the running game and destroy them. */
  readonly spawner?: BehaviorSpawnControl;
  /** One script object's own `ctx.spawn` (its copies are spawned in its scene; a scene reload removes them). */
  readonly spawnerOwned?: (entityId: string) => BehaviorSpawnControl;
  /**
   * The triggers the player entered or left in the previous step
   * (every trigger; the behavior host gives each script those it owns, in
   * `ctx.events`).
   */
  readonly triggerEvents?: readonly TriggerEventRecord[];
  /**
   * The primitives' events of the previous step (health changes,
   * collections, patrol turns, hitbox contacts — every object's; the behavior
   * host gives each script those of the objects it owns, in `ctx.events`).
   */
  readonly primitiveEvents?: readonly PrimitiveEventRecord[];
  /** Any object's health (`ctx.health`). */
  readonly health?: BehaviorHealth;
  /** Patrollers (`ctx.patrol`). */
  readonly patrol?: BehaviorPatrol;
  /** Hitboxes (`ctx.hitbox`). */
  readonly hitbox?: BehaviorHitbox;
  /** Collectibles (`ctx.collectible`). */
  readonly collectible?: BehaviorCollectible;
  /** The character (`ctx.character`). */
  readonly character?: BehaviorCharacter;
  /** Per-object look overrides (`ctx.look`). */
  readonly look?: BehaviorLook;
  /** Messages between scripts (the behavior host gives each script its own `ctx.messages`). */
  readonly messages?: BehaviorMessageControl;
  /**
   * The objects switched off now (by a script, with their children) — the behavior host
   * sends `onEnable`/`onDisable` when an instance's object changes side.
   */
  readonly inactiveEntities?: ReadonlySet<string>;
  /**
   * 3D projects: the active camera's yaw this step — radians
   * about +Y, 0 looking along −Z (three.js' default camera) — when a camera
   * rig provides one; the 3D character reads its move input relative to it.
   * Absent: world axes (the input's y pushes along −Z, its x along +X).
   */
  readonly cameraYaw?: number;
  /** The virtual cameras (`ctx.camera`; a scene without one answers false/null). */
  readonly camera?: BehaviorCamera;
  /** Sockets (`ctx.sockets`). */
  readonly sockets?: BehaviorSockets;
  /** The cursor a script asks for (`ctx.input.setCursor`; simulation state the host applies after the step). */
  readonly cursor?: { readonly request: (mode: 'free' | 'locked' | 'auto') => void };
  /** The host's input status (device, bindings, rebind events) and the binding-request queue (`ctx.input`). */
  readonly inputStatus?: import('./input-status').InputStatusView;
  /** The project's debug commands (declared and received per phase; the behavior host adds the handler). */
  readonly debug?: { command(name: string, options?: DebugCommandOptions): readonly DebugCommandArgs[] };
  /** The block layers of the loaded scenes (`ctx.grid`). */
  readonly grid?: import('./grid').BehaviorGrid;
  /** The terrains' and block layers' scatter copies (`ctx.scatter`). */
  readonly scatter?: import('./scatter-copies').BehaviorScatter;
  /** The loaded splines (`ctx.splines`). */
  readonly splines?: import('./splines').BehaviorSplines;
  /** The ground of block layers and terrains (`ctx.surface`). */
  readonly surface?: import('./surface').BehaviorSurface;
  /** Graph-material parameters per object (`ctx.materials`). */
  readonly materials?: import('./material-params').BehaviorMaterials;
  /** Project saves (`ctx.saves`). */
  readonly saves?: import('./project-saves').BehaviorSaves;
  /** Asset handles (`ctx.assets`). */
  readonly assets?: import('./asset-handles').BehaviorAssets;
  /** The project UI (`ctx.ui`: the view model, shown documents, UI events). */
  readonly ui?: BehaviorUi;
  /** The page's frame statistics (`ctx.stats`). */
  readonly stats?: BehaviorStats;
  /** The frame-rate cap (`ctx.display`). */
  readonly display?: BehaviorDisplay;
  /** Conversations (`ctx.dialogue`). */
  readonly dialogue?: BehaviorDialogue;
  /** The game modes (`ctx.modes`; present while the project has modes). */
  readonly modes?: BehaviorModes;
  /** The run lifecycle (`ctx.lifecycle`). */
  readonly lifecycle?: BehaviorLifecycle;
  /**
   * Whether the behavior on this entity runs this step (its
   * behavior group ticks in the current game mode). Absent: every behavior
   * runs (no modes, or the mode ticks every group).
   */
  readonly behaviorTicks?: (entityId: string) => boolean;
  /** Timelines (`ctx.timeline`). */
  readonly timeline?: BehaviorTimeline;
  /** Environment presets (`ctx.environment`). */
  readonly environment?: BehaviorEnvironment;
  /** Generic component access (`ctx.entity(ref)`; the behavior host names the writing script). */
  readonly entities?: import('./entity-access').BehaviorEntityControl;
  /** The shell's scene list (`ctx.shell`). */
  readonly shell?: BehaviorShell;
  /** The climb volume the character is in (the character controllers; not the scripts' context). */
  readonly climb?: ClimbQuery;
}

/** Where a player character may climb. */
export interface ClimbQuery {
  /** The climb volume a player controller's capsule centre is in now (its object, world up and across axes), or null; absent id: the first. */
  volume(entityId?: string): import('./blocks').ClimbVolumeView | null;
}

/**
 * `ctx.shell` — the game shell's scene list (`content.shell`) from scripts.
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

export interface SimulationModuleSpec {
  id: string;
  /**
   * The declared phases: non-empty, unique, canonical
   * order. Absent ⇒ an M1 module that runs in an implicit `transform`
   * phase.
   */
  phases?: readonly SimulationPhase[];
  /** Module IDs this spec cannot coexist with. */
  excludes?: readonly string[];
  /**
   * The spec needs an injected physics port (without one: `config_invalid`,
   * reason `physics_port`).
   */
  requiresPhysicsPort?: boolean;
  /**
   * Transform owners of an M1 module when it participates in an M2 set
   * (the demo owns every `box` entity).
   */
  legacyTransformOwners?: (snapshot: RuntimeSnapshot) => readonly string[];
  /**
   * Components the module needs on at least one scene entity (a
   * composition refuses to start the module without one, naming the
   * component). The module declares it; no host assumes it.
   */
  requiresEntityWith?: readonly string[];
  create(snapshot: RuntimeSnapshot, cfg: ModuleConfig): SimulationModule | SimulationPhaseModule;
}

/**
 * Branded simulation-module registry. Create with
 * `createSimulationRegistry()`; register engine modules with
 * `registerSimulationModule`.
 */
export interface SimulationRegistry {
  [registryBrand]: Map<string, SimulationModuleSpec>;
}
export const registryBrand: unique symbol = Symbol('thirdlight.simulation-registry');