/**
 * Runtime types of the simulation: the instantiate config, simulation state,
 * modules and their phases, and the step context a module runs with.
 */

import type { EntityV3, Quat, Vec3 } from '@thirdlight/project-model';
import type { ActionFrame, ActionSource } from './actions';
import type { BehaviorIntent, BehaviorLogLevel, IntentSet } from './intents';
import type { CharacterClearanceResult3D, PhysicsPort, PhysicsPort3D, PhysicsStepClient, PhysicsVec3, RaycastHit3D, Vec2 } from './ports';
import { type BehaviorSceneControl, type GameplaySettings, type RuntimeSnapshot } from './types-scene';
import { type AnimatorEventRecord, type BehaviorAnimatorControl, type BehaviorCamera, type BehaviorCharacter, type BehaviorCollectible, type BehaviorDialogue, type BehaviorEnvironment, type BehaviorGameState, type BehaviorHealth, type BehaviorHitbox, type BehaviorLifecycle, type BehaviorLook, type BehaviorModes, type BehaviorPatrol, type BehaviorSignals, type BehaviorSockets, type BehaviorTagQuery, type BehaviorTimeline, type BehaviorUi } from './types-behavior-world';
import { type BehaviorAudio, type BehaviorEffects, type BehaviorMessageControl, type BehaviorSave, type BehaviorSpawnControl, type DebugCommandArgs, type DebugCommandOptions, type PrimitiveEventRecord, type TriggerEventRecord } from './types-behavior';

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
export const registryBrand: unique symbol = Symbol('thirdlight.simulation-registry');