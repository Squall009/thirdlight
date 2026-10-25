/**
 * Runtime core: lifecycle, mutable simulation state, fixed steps with
 * bounded catch-up, interpolation and frame ordering, diagnostics, module
 * phases, ports, transform ownership and the fail-stop lifecycle.
 *
 * The runtime owns the single frame driver (rAF or manual). Every public
 * call returns a result object and never throws on protocol misuse. The
 * runtime core is three-free (project-model only) and
 * carries no hidden globals (every instance is an explicit object).
 *
 * Two module-set modes share the same constructor:
 *
 * - **M1 mode** (no selected spec declares phases): a module throw is a
 *   no-op step (the `curr`
 *   copy is restored) and `failed` is unreachable.
 * - **M2 mode** (at least one selected spec declares phases): the canonical
 *   phase order `intent → controller → physics → transform`, the write
 *   guard, transform-ownership validation, the settle pre-roll, per-step
 *   action sampling and fail-stop with no rollback.
 */
import { RuntimeGrid, worldStreamSources, type GridCutawayState, type GridRenderChange } from './grid';
import type { TerrainSimData } from './scatter-copies';
import { fail } from './runtime-config';
import { RuntimeMaterials, type MaterialRenderChange, type RuntimeMaterialCatalog } from './material-params';
import { RuntimeAssetHandles, type AssetHandleAnswer, type AssetHandleRequest } from './asset-handles';
import { PresentationRequests } from './presentation-requests';
import { saveSectionsPort } from './save-sections';
import { RuntimeSaves, type SaveEvent, type SaveRequest, type SaveSectionsPort, type WorldSave } from './project-saves';
import { projectFrameRateCap, seeThroughSettingsOfProject, type SaveSchema } from '@thirdlight/project-model';

import { type InputBindingRequest } from './input-status';
import type { BlockType, CellField } from '@thirdlight/project-model';
import {
  ENGINE_TIMING_DEFAULTS,
  type EntityV3,
  type PrefabDefinition,
  type RuntimeUiDocumentRow,
} from '@thirdlight/project-model';
import {
  neutralFrame,
  InputFrameError,
  type ActionFrame,
  type ActionSource,
  type DebugCommandCall,
  } from './actions';

import { type RuntimeError } from './errors';
import { RuntimeSim, cloneCurr, messageOf, type ModuleEntry } from './runtime-sim';
import { RuntimeFaults, behaviorDebugOf, behaviorPropertiesOf } from './runtime-faults';
import { RuntimeScenes } from './runtime-scenes';
import { RuntimeEntities } from './runtime-entities';
import { RuntimeCharacters } from './runtime-characters';
import { FrameDriver } from './runtime-frame';
import { playEventCues, timelineHostOf } from './runtime-bindings';
import { RuntimeInput, type HeldPointer } from './runtime-input';
import { RuntimePhases } from './runtime-phases';
import { ScriptContext } from './script-context';
import { blockControls, saveStoreControl, socketControlOf, timelineControlOf } from './script-controls';
import { UiState, type UiEventRecord, type UiOutput, type UiStateView } from './ui';
import { EngineStatsHolder } from './engine-stats';
import type { FramePacingStats } from './frame-pacing';
import { FrameLoop } from './frame-loop';
import { ModeState, type ModeView } from './modes';
import type { BehaviorDebugView, BehaviorPropertyView } from './behavior';
import { type LiveTagIndex } from './scene-set';
import type { BehaviorLogLevel } from './intents';


import { type AnimatorControllerLike, type AnimatorPose } from './animator';
import { AnimatorSystem } from './animator-system';
import { randomSeedOf } from './random';
import { AudioMixer, type AudioCommand } from './audio-mixer';
import { createScriptAudio } from './script-audio';
import { DialogueRunner, type DialogueInputRecord } from './dialogue';
import { cameraBlendOf, type CameraViewInfo } from './camera-brain';
import { RuntimeViews } from './views';
import { KeptObjects } from './kept';
import { EnvironmentDirector } from './environment-director';
import { type EnvironmentBlendView } from './environment-blend';
import type { ScriptStop } from './types';
import { SocketSystem } from './sockets';
import { TimelineSystem, type TimelineView } from './timeline';
import type { TimelineAsset } from '@thirdlight/project-model';
import { blocksCharacterOf, GameplayBlocks } from './blocks';
import { createGameControl } from './game-control';
import { createShellControl } from './scene-list';
import { loadOp } from './scene-control';
import { EntityAccess, type LightOverride } from './entity-access';
import { StepReads, type DrawnSteps } from './step-reads';
import { PlayerControllers } from './player-controllers';
import type { PhysicsPort3D, Vec2 } from './ports';
import {
  type CameraInfo,
  type RuntimeSceneRow,
  type SceneLoadOptions,
  type SceneLoadRequest,
  type SceneSetView,
  type EffectRequest,
  type DecalRequest,
  type GameplaySettings,
  type InterpolatedState,
  type InterpolatedVisitor,
  type StepPairVisitor,
  type ModelBounds,
  type Runtime,
  type RuntimeDiagnostics,
  type SimEntityData,
  type SimState,
  type SimulationModule,
  type SimulationPhaseModule,
  type TransformState,
  type DebugCommandState,
  } from './types';

export type { HeldPointer } from './runtime-input';

export { PHYSICS_QUERY_LIMIT } from './physics-query-args';

export { EFFECT_MAX_QUEUED_REQUESTS } from './presentation-requests';
export { catchUpSteps, MAX_CATCHUP_SECONDS } from './frame-clock';
/**
 * The M2 settle pre-roll at 120 Hz — the engine's settle time
 * (0.1 s, `ENGINE_TIMING_DEFAULTS.settleTime`) converted at the step rate.
 */
export const SETTLE_PREROLL_STEPS = 12;
/** Steps a one-way platform lets the character drop through at 120 Hz (`ENGINE_TIMING_DEFAULTS.dropThroughTime`, 0.125 s). */
export const DROP_THROUGH_STEPS = 15;

/**
 * The engine timing in whole steps at `hz` (120 Hz gives
 * `SETTLE_PREROLL_STEPS` and `DROP_THROUGH_STEPS`).
 */
export function engineTimingSteps(hz: number): { settleSteps: number; dropThroughSteps: number } {
  return {
    settleSteps: Math.max(0, Math.round(ENGINE_TIMING_DEFAULTS.settleTime * hz)),
    dropThroughSteps: Math.max(1, Math.round(ENGINE_TIMING_DEFAULTS.dropThroughTime * hz)),
  };
}

export interface BehaviorLogSink {
  handler: ((moduleId: string, level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }) => void) | null;
  stopped?: (moduleId: string, stop: ScriptStop) => void;
}


/** What the runtime is made of: `instantiateRuntime`'s validated, resolved inputs. */
export interface RuntimeArgs {
  snapshotId: string;
  revision: number;
  hz: number;
  clock: () => number;
  clockLabel: 'performance' | 'injected';
  driverKind: 'raf' | 'manual';
  onFrame?: () => void;
  modules: string[];
  entries: ModuleEntry[];
  isM2: boolean;
  /** The engine timing in steps. */
  timing: { settleSteps: number; dropThroughSteps: number };
  actions: ActionSource;
  /** The physics port (absent: a game without physics). */
  physics3d?: PhysicsPort3D;
  settings: GameplaySettings;
  /** The player controllers' objects, in snapshot order. */
  controllerEntityIds: readonly string[];
  order: string[];
  entities: Map<string, SimEntityData>;
  /** The project's lens (its camera settings): the view's while no camera sets its own. */
  viewLens: { fovY: number; near: number; far: number };
  prev: Map<string, TransformState>;
  curr: Map<string, TransformState>;
  logSink: BehaviorLogSink;
  sceneRows: readonly RuntimeSceneRow[] | null;
  startBatches: readonly { sceneId: string; entities: EntityV3[] }[];
  liveTags: LiveTagIndex | null;
  queryTags: LiveTagIndex | null;
  /** The controllers, and the snapshot scene's entities (their `animator` components). */
  animatorControllers: readonly AnimatorControllerLike[];
  initialEntities: readonly EntityV3[];
  /** The prefab definitions scripts spawn. */
  prefabs: readonly PrefabDefinition[];
  /** Model assetId -> its recorded bounds. */
  modelBounds: Readonly<Record<string, ModelBounds>>;
  /** audio assetId -> its recorded duration (ms). */
  audioDurations: Readonly<Record<string, number>>;
  /** Model rigs (sockets are resolved on them). */
  rigs?: Readonly<Record<string, import('@thirdlight/project-model').ModelRig>>;
  /** The models' `_COL` parts (colliders `{type: 'model'}` are made of them). */
  modelColliders?: import('@thirdlight/project-model').ModelColliderTable;
  /** Generated architecture's style and preset graphs. */
  architectureStyles?: readonly import('@thirdlight/project-model').ArchitectureGraphLike[];
  /** Injected script variables (validated; ctx.save from step 0). */
  variables?: Readonly<Record<string, unknown>>;
  /** The block types and cell fields of the project's block layers. */
  blockTypes: readonly BlockType[];
  cellFields: readonly CellField[];
  /** The graph materials' parameters (ctx.materials). */
  materialCatalog?: RuntimeMaterialCatalog;
  /** Every project material the game ships (what a material swap may name). */
  materialIds?: readonly string[];
  /** The project save schema and the stored project settings document. */
  saveSchema?: SaveSchema;
  projectSettings?: Readonly<Record<string, unknown>>;
  /** The project's UI documents (id, layer, modal). */
  uiDocuments: readonly RuntimeUiDocumentRow[];
  /** The compiled conversations, speakers and dialogue settings. */
  dialogue?: import('@thirdlight/project-model').RuntimeDialogueData;
  /** The project's game modes (absent: none) and the mode runs start in. */
  modes?: import('@thirdlight/project-model').RuntimeModes;
  startMode?: string;
  /** The project's timelines. */
  timelines?: readonly TimelineAsset[];
  /** The event → cue table. */
  eventCues?: readonly import('./types').RuntimeEventCue[];
  /** The shell's ordered scene list. */
  sceneList?: readonly import('./types').ListedScene[];
  /** The environment preset ids (ctx.environment). */
  environmentPresets: readonly string[];
}

const NO_LOOKS: ReadonlyMap<string, import('./primitives').EntityLook> = new Map();

export class RuntimeInstance implements Runtime {
  /** The simulation state the parts share (the module set, the entities and their transforms, the step). */
  private readonly sim: RuntimeSim;
  /** Errors, Problems lines and the fail-stop. */
  private readonly faults: RuntimeFaults;
  /** The loaded scene set, scene requests, transitions and the scene list. */
  private readonly scenes: RuntimeScenes;
  /** How objects come into the simulation and leave it; spawned copies. */
  private readonly entities: RuntimeEntities;
  /** The step's transforms (integration tests that follow a run step by step read them off the instance). */
  get curr(): ReadonlyMap<string, TransformState> {
    return this.sim.curr;
  }
  private readonly snapshotId: string;
  private readonly revision: number;
  private readonly clockLabel: 'performance' | 'injected';
  private readonly driverKind: 'raf' | 'manual';
  private onFrame?: () => void;
  private readonly modules: string[];
  private readonly isM2: boolean;
  private readonly actions: ActionSource;
  /** Where the active camera's yaw comes from (the camera framework sets it; null: world axes). */
  private cameraYawSource: (() => number | undefined) | null = null;
  /** The player controllers (several share the view in local co-op; the first is what a call naming none means). */
  private readonly controllers: PlayerControllers;
  /** The engine timing in steps. */
  private readonly timing: { settleSteps: number; dropThroughSteps: number };
  /** The scripts' saved values (ctx.save; kept across restarts). */
  private readonly saveStore = new Map<string, unknown>();
  /** `ctx.save` over the store. */
  private readonly saveControl = saveStoreControl(this.saveStore);
  /** The controls scripts reach the gameplay blocks through (signals, messages, the primitives, the climb volume, looks). */
  private readonly blockCtl = blockControls(() => this.blocks, () => this.sim.stepIndex);
  /** The module phases and the intents they commit. */
  private readonly phases: RuntimePhases;
  /** The step contexts' engine members and which behaviors tick. */
  private readonly script: ScriptContext;
  /** The physics bridge: colliders, player controllers, placements, queries and `ctx.lifecycle`. */
  private readonly chars: RuntimeCharacters;
  /** The frame update: steps owed, the settle pre-roll, pause and the debugger's hold. */
  private readonly frame: FrameDriver;
  /** The sampled input frame, what the host queues onto it, the pointer and the cursor. */
  private readonly input: RuntimeInput;
  /**
   * The run: a restart waiting for the next step boundary (ctx.lifecycle.restart, a restart UI event), its
   * start waiting for this boundary (the first run's, and a restart's after its module resets), the step
   * count when it began (0; a restart's boundary) and the last spawned copy's number then, and the restarts
   * applied in this play (a tool tells the restarted run from the one it asked to restart); the start's
   * injected script variables, applied again at every restart.
   */
  private readonly run = { restartDue: false, startDue: true, startStep: 0, spawnBase: 0, number: 0, variables: undefined as Readonly<Record<string, unknown>> | undefined };
  // ---- Animators ----
  private readonly animators: AnimatorSystem;
  // ---- The views (each owned by a camera brain) ----
  private readonly views: RuntimeViews;
  /** Sockets (entities riding on model nodes) and the script API over them. */
  private readonly sockets: SocketSystem;
  // ---- The project UI (view model, shown documents, UI events) ----
  private readonly ui: UiState;
  /** The dialogue runner (inert without conversations) and dialogue inputs waiting for the next sampled step. */
  private readonly dialogue: DialogueRunner;
  private readonly engineStats = new EngineStatsHolder();
  /** The rAF driver's loop, paced by the game's frame-rate cap, and `ctx.display` over it. */
  private readonly loop: FrameLoop;
  // ---- Game modes and the run lifecycle ----
  private readonly modes: ModeState;
  /** The event → cue table (empty: no event sounds). */
  private readonly eventCues: readonly import('./types').RuntimeEventCue[];
  // ---- The sequencer (inert without timelines) ----
  private readonly timelines: TimelineSystem;
  // ---- Gameplay building blocks ----
  private blocks: GameplayBlocks | null = null;
  /** The loaded block layers (`ctx.grid`, their colliders and render changes). */
  private readonly grid: RuntimeGrid;
  /** Graph-material parameters scripts set per object (`ctx.materials`). */
  private readonly materials: RuntimeMaterials;
  /** Every project material the game ships (null: not given — a material swap is refused). */
  private readonly materialIds: ReadonlySet<string> | null;
  /** `ctx.entity(ref).get/set` — the written fields, the switched-off objects and the end-of-step writes. */
  private readonly entityAccess: EntityAccess;
  /** Project saves (`ctx.saves`). */
  private readonly saves: RuntimeSaves;
  /** The environment preset blend (`ctx.environment`; inert until a script uses it). */
  private readonly environment: EnvironmentDirector;
  /** The audio intent log (handles, fades, music, duck; the host plays its commands). */
  private readonly audio: AudioMixer;
  /** Scripts' asset handles (`ctx.assets`) and the host's answers waiting for the next sampled step. */
  private readonly assetHandles = new RuntimeAssetHandles((message) => this.faults.log('thirdlight.runtime:assets', 'warn', message));
  /** Effect and decal requests for the renderer (presentation only, never part of the simulation). */
  private readonly presentation = new PresentationRequests({ stepIndex: () => this.sim.stepIndex, prefab: (id) => this.entities.prefabs.get(id), problem: (code, message) => this.faults.problem(code, message) });

  /** Kept objects (`keepLoaded`): they survive their scene's unload, reload and a save's scene changes. */
  private readonly kept = new KeptObjects();

  constructor(args: RuntimeArgs) {
    this.sim = new RuntimeSim({ hz: args.hz, settings: args.settings, physics3d: args.physics3d, entries: args.entries, order: args.order, entities: args.entities, prev: args.prev, curr: args.curr });
    this.faults = new RuntimeFaults(this.sim, () => {
      this.loop.cancel();
      this.frame.needsPreroll = false;
      this.sim.stateName = 'failed';
      this.frame.clock.alpha = 0;
    });
    this.frame = new FrameDriver(this.sim, {
      step: () => (this.isM2 ? this.stepOnceM2() : this.stepOnce()),
      prerollStep: () => this.stepOnceM2(neutralFrame(this.sim.stepIndex)),
      pausedBoundary: () => this.scenes.applyOps(false),
      timeScale: () => (this.modes.active ? this.modes.timeScale() : null),
      frameDone: () => this.onFrame?.(),
    }, args.isM2, args.timing.settleSteps);
    this.snapshotId = args.snapshotId;
    this.revision = args.revision;
    this.clockLabel = args.clockLabel;
    this.driverKind = args.driverKind;
    this.onFrame = args.onFrame;
    this.modules = [...args.modules];
    this.isM2 = args.isM2;
    this.timing = args.timing;
    this.actions = args.actions;
    // Injected variables are the scripts' saved values from step 0.
    // And again at every restart (a replay, a shell's new game), so every start begins with them.
    this.run.variables = args.variables;
    this.applyStartVariables();
    const rt = this;
    const loopHost = { running: () => this.sim.stateName === 'running', clock: () => args.clock(), runFrame: (t: number) => this.frame.run(t) };
    this.loop = new FrameLoop(projectFrameRateCap(args.settings), loopHost);
    this.chars = new RuntimeCharacters(this.sim, this.faults, {
      get blocks() { return rt.blocks; },
      get grid() { return rt.grid; },
      get views() { return rt.views; },
      kept: this.kept,
      get scenes() { return rt.scenes; },
      get phases() { return rt.phases; },
      get entityAccess() { return rt.entityAccess; },
      get input() { return rt.input; },
      queryTags: args.queryTags,
      requestRestart: () => void (rt.run.restartDue = true),
      yawSource: () => rt.cameraYawSource,
    }, { controllerEntityIds: args.controllerEntityIds, initialEntities: args.initialEntities, ...(args.modelColliders !== undefined ? { modelColliders: args.modelColliders } : {}) });
    this.controllers = this.chars.controllers;
    this.phases = new RuntimePhases(this.sim, {
      controllers: this.controllers,
      placement: this.chars.placement,
      director: this.chars.director,
      lifecycle: this.chars.lifecycle,
      physicsQueries: this.chars.queries.client,
      contextFields: (phase) => rt.script.fields(phase),
    });
    args.logSink.handler = (moduleId: string, level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }): void =>
      this.faults.log(moduleId, level, message, at);
    args.logSink.stopped = (moduleId, stop) => this.faults.scriptStopped(moduleId, stop);
    this.kept.add(args.initialEntities);
    this.scenes = new RuntimeScenes(this.sim, this.faults, {
      kept: this.kept,
      get colliders() { return rt.chars.colliders; },
      get grid() { return rt.grid; },
      get controllers() { return rt.controllers; },
      get placement() { return rt.chars.placement; },
      get environment() { return rt.environment; },
      sceneSoundsGone: (sceneId) => rt.audio.sceneGone(sceneId),
      spawned: () => rt.entities.spawned,
      attach: (frozen) => rt.entities.attach(frozen),
      detach: (ids, colliderIds, what, how) => rt.entities.detach(ids, colliderIds, what, how),
      playersArrive: (frozen, placeReturning) => rt.entities.playersArrive(frozen, placeReturning),
      notifyLoaded: (frozen) => rt.entities.notifyLoaded(frozen),
      removeSpawned: (ids) => rt.entities.removeSpawnedIds(ids),
      copiesOf: (sceneId) => rt.entities.copiesOf(sceneId),
    }, args.sceneRows, args.startBatches, args.sceneList ?? []);
    this.input = new RuntimeInput(this.sim, this.faults, args.actions, {
      get saves() { return rt.saves; },
      get assetHandles() { return rt.assetHandles; },
      get ui() { return rt.ui; },
      get dialogue() { return rt.dialogue; },
      get modes() { return rt.modes; },
      scenes: this.scenes,
      get blocks() { return rt.blocks; },
      requestRestart: () => void (rt.run.restartDue = true),
    });
    this.entities = new RuntimeEntities(this.sim, this.faults, {
      kept: this.kept,
      get colliders() { return rt.chars.colliders; },
      get planes() { return rt.chars.planes; },
      get grid() { return rt.grid; },
      get controllers() { return rt.controllers; },
      get placement() { return rt.chars.placement; },
      get materials() { return rt.materials; },
      get animators() { return rt.animators; },
      get blocks() { return rt.blocks; },
      get views() { return rt.views; },
      get sockets() { return rt.sockets; },
      get entityAccess() { return rt.entityAccess; },
      get audio() { return rt.audio; },
      liveTags: args.liveTags,
      intentAxes: () => rt.phases.intents.axes,
      sceneOf: (id) => rt.scenes.sceneOf(id),
      sceneSetChanged: () => rt.scenes.changed(),
    }, args.prefabs);
    // The start scenes' block layers; their chunks collide.
    this.grid = new RuntimeGrid(
      args.blockTypes,
      args.cellFields,
      args.physics3d !== undefined,
      args.settings.max_slope_climb_deg,
      args.materialIds,
      this.entities.prefabs,
      args.modelColliders,
      () => worldStreamSources(this.views.main.hasView() ? this.views.main.view() : null, this.controllers.ids, (id) => this.sim.curr.get(id)?.position),
      args.architectureStyles,
      (id) => this.scenes.sceneOf(id),
    );
    this.grid.addLayers(args.initialEntities);
    this.grid.flushCollision(args.physics3d);
    // The start set's graph materials (the values scripts set per object).
    this.materials = new RuntimeMaterials(args.materialCatalog);
    this.materialIds = args.materialIds !== undefined ? new Set(args.materialIds) : null;
    this.entityAccess = this.buildEntityAccess();
    this.materials.addEntities(args.initialEntities);
    // The environment preset blend (before the saves, whose sections read it).
    // The first start scene is the active one (its look is the base look).
    this.environment = new EnvironmentDirector(this.sim.hz, args.environmentPresets, (message) => this.faults.log('thirdlight.runtime:environment', 'warn', message), args.sceneRows !== null ? (args.startBatches[0]?.sceneId ?? null) : null);
    // Project saves (the document, slots, settings; inert without a save schema).
    this.saves = new RuntimeSaves(args.saveSchema, this.sim.hz, this.buildSaveSections(), args.projectSettings, (message) => this.faults.log('thirdlight.runtime:saves', 'warn', message), (code, message) => this.faults.problem(code, message));
    this.animators = new AnimatorSystem(args.animatorControllers, {
      hz: this.sim.hz,
      seed: randomSeedOf(this.sim.settings),
      characterIds: () => this.controllers.ids,
      transformOf: (id) => this.sim.curr.get(id),
      grounded: (id) => this.controllers.grounded(id),
      inactive: () => this.entityAccess.inactive(),
      stepIndex: () => this.sim.stepIndex,
      // The look-at reads the models' rigs and world matrices the sockets keep.
      rigOf: (id) => this.sockets.rigOf(id),
      worldMatrix: (id, out) => this.sockets.worldMatrix(id, out),
      warn: (message) => this.faults.log('thirdlight.runtime:animator', 'warn', message),
    });
    this.animators.add(args.initialEntities);
    // The audio intent log (clip lengths from the snapshot's recorded durations).
    this.audio = new AudioMixer(this.sim.hz, args.audioDurations, () => this.sim.stepIndex);
    // The views and the start set's shots.
    this.views = new RuntimeViews(this.sim.hz, args.viewLens, {
      worldOf: (id, position, rotation) => this.sim.worldTransformOf(id, position, rotation),
      raycast: (origin, direction, maxDistance) => {
        const port = this.sim.physics3d;
        if (port === undefined || typeof port.raycast !== 'function') return null;
        const hit = port.raycast({ x: origin[0], y: origin[1], z: origin[2] }, { x: direction[0], y: direction[1], z: direction[2] }, maxDistance);
        return hit === null ? null : { distance: hit.distance };
      },
      warn: (message) => this.faults.log('thirdlight.runtime:camera', 'warn', message),
    }, seeThroughSettingsOfProject(args.settings));
    this.views.add(args.initialEntities);
    // The project UI (inert until a script or a frame uses it).
    this.ui = new UiState(args.uiDocuments);
    // Conversations (the view model under `dialogue.`, voice through the audio intent log).
    const ui = this.ui;
    const durations = args.audioDurations;
    this.dialogue = new DialogueRunner(
      args.dialogue ?? null,
      { set: (p, v) => ui.set(p, v), clear: (p) => ui.clear(p), show: (d) => ui.show(d), hide: (d) => ui.hide(d), isShown: (d) => ui.isShown(d), focus: (d, w) => ui.command('focus', d, w, undefined) },
      this.audio,
      this.sim.hz,
      (id) => {
        const ms = durations[id];
        return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
      },
    );
    // The game modes (inert without modes) — the first run begins in the start mode.
    this.modes = new ModeState(args.modes, this.sim.hz, {
      showUi: (doc) => void this.ui.show(doc),
      hideUi: (doc) => void this.ui.hide(doc),
      isShown: (doc) => this.ui.isShown(doc),
      setCamera: (id, blend) => this.views.main.setOverride(id, blend),
      warn: (message) => this.faults.log('thirdlight.runtime:modes', 'warn', message),
    });
    this.modes.setStartMode(args.startMode);
    this.modes.beginRun(1);
    this.frame.clock.scale = this.modes.active ? this.modes.timeScale() : 1;
    this.entities.noteBehaviorGroups(args.initialEntities);
    this.eventCues = args.eventCues ?? [];
    // Movers, triggers, switches, one-way colliders and the generic primitives
    // (the characters are the player controllers' objects).
    this.blocks = new GameplayBlocks(
      {
        hz: this.sim.hz,
        curr: this.sim.curr,
        characters: args.initialEntities.filter((e) => this.controllers.has(e.id)).map((e) => blocksCharacterOf(e)),
        // Gravity bodies fall under the project's gravity, capped at its fall speed.
        gravityY: this.sim.settings.gravity_y,
        maxFallSpeed: this.sim.settings.max_fall_speed,
        groundEntityId: (id) => rt.controllers.groundEntityId(id),
        // The physics world (movers posed on it, walkers' probes).
        ...(args.physics3d !== undefined ? { physics3d: args.physics3d, scriptColliders3D: () => rt.chars.colliders.poses() } : {}),
        // A trigger's scene transition.
        sceneTransition: (triggerId, t) => rt.scenes.beginTransition(triggerId, t),
        suspended: (id) => rt.chars.suspension.has(id),
        effect: (r) => void rt.presentation.pushEffect({ op: r.op, effectId: r.effectId, entityId: r.entityId, position: r.position, params: null, source: r.source }),
      },
      args.initialEntities,
    );
    // Sockets — the start set's authored ones attach now and sit on their nodes from the first frame.
    this.sockets = new SocketSystem(args.rigs, {
      get curr() {
        return rt.sim.curr;
      },
      parentOf: (id: string) => rt.sim.entities.get(id)?.parentId ?? (rt.sim.entities.has(id) ? null : undefined),
      componentsOf: (id: string) => rt.sim.entities.get(id)?.componentKinds ?? (rt.sim.entities.has(id) ? [] : undefined),
      poseOf: (id: string) => rt.animators.poseOf(id),
      warn: (message: string) => rt.faults.log('thirdlight.runtime:sockets', 'warn', message),
    });
    this.sockets.add(args.initialEntities);
    this.settleSockets();
    // The timelines (inert while the project has none).
    this.timelines = new TimelineSystem(args.timelines ?? [], this.sim.hz, timelineHostOf({
      sim: this.sim,
      faults: this.faults,
      chars: this.chars,
      views: this.views,
      animators: this.animators,
      audio: this.audio,
      presentation: this.presentation,
      blocks: () => this.blocks,
      signals: this.blockCtl.signals,
      materials: this.materials,
      entityAccess: this.entityAccess,
      modes: this.modes,
      environment: this.environment,
      dialogue: this.dialogue,
    }));
    // The event → cue table listens to the blocks' signals and events.
    if (this.eventCues.length > 0) this.blocks?.enableCueLog();
    this.script = new ScriptContext({
      scenes: this.scenes.rows !== null ? this.scenes.control : null,
      animators: this.animators,
      blockControls: this.blockCtl,
      game: createGameControl({ blocks: () => this.blocks, has: (id) => this.sim.curr.has(id), warn: (message) => this.faults.log('thirdlight.runtime:counters', 'warn', message) }),
      director: this.chars.director,
      audioControl: createScriptAudio(this.audio, (id) => this.scenes.sceneOf(id)),
      presentation: this.presentation,
      save: this.saveControl,
      spawnControl: this.entities.spawnControl,
      spawnerOwned: this.entities.spawnerOwned,
      views: this.views,
      sockets: socketControlOf(this.sockets),
      cursor: this.input.cursorControl,
      inputStatus: this.input.status,
      debugCommands: this.input.debugCommands,
      grid: this.grid,
      materials: this.materials,
      entityAccess: this.entityAccess,
      shell: createShellControl({ listedIndex: () => rt.scenes.listedIndex(), count: () => rt.scenes.list.length, goTo: (i) => rt.scenes.requestListed(i), problem: (code, message) => rt.faults.problem(code, message) }),
      saves: this.saves,
      assetHandles: this.assetHandles,
      ui: this.ui,
      engineStats: this.engineStats,
      loop: this.loop,
      dialogue: this.dialogue,
      modes: this.modes,
      lifecycle: this.chars.lifecycle,
      timeline: timelineControlOf(this.timelines),
      environment: this.environment,
      blocks: this.blocks,
      behaviorGroupOf: this.entities.behaviorGroupOf,
      stepIndex: () => this.sim.stepIndex,
      cameraYaw: this.sim.physics3d !== undefined ? () => this.chars.cameraYaw3D() : null,
    });
  }

  // ---- Sockets ---------------------------------------------------------

  /**
   * Pose the attached entities now and make `prev` (and the committed copy)
   * agree, so the next frame draws them on their nodes without a streak from
   * where they were (the start of a game or a run).
   */
  private settleSockets(): void {
    if (!this.sockets.active) return;
    this.sockets.resolve(this.sim.committed);
    for (const a of this.sockets.list()) {
      const c = this.sim.curr.get(a.entityId);
      const p = this.sim.prev.get(a.entityId);
      if (c === undefined || p === undefined || p === c) continue;
      for (let k = 0; k < 3; k += 1) p.position[k] = c.position[k]!;
      for (let k = 0; k < 4; k += 1) p.rotation[k] = c.rotation[k]!;
      for (let k = 0; k < 3; k += 1) p.scale[k] = c.scale[k]!;
    }
  }

  socketAttachments(): readonly { readonly entityId: string; readonly target: string; readonly node: string }[] {
    return this.sockets.list();
  }

  /**
   * The effect requests since the last call (scripts'
   * `ctx.effects`, effect components' signals, gameplay hooks), in the order
   * they were made; the adapter plays them. Taking them changes nothing the
   * simulation computes.
   */
  takeEffectRequests(): EffectRequest[] {
    return this.presentation.takeEffects();
  }

  /** The decal requests since the last call (scripts' `ctx.decals`, a restart's clear); presentation only, like the effects'. */
  takeDecalRequests(): DecalRequest[] {
    return this.presentation.takeDecals();
  }

  /**
   * The block-layer chunks to re-mesh since the last call (their
   * cells now; null: no cells left) — cells scripts wrote, layers of scenes
   * loaded, a new run back to the authored cells. The renderer applies them
   * to its copy of each layer. Taking them changes nothing the simulation computes.
   */
  takeGridChanges(): GridRenderChange[] {
    return this.grid.takeRenderChanges();
  }

  /** Terrain tiles and scatter blobs decoded on the page (by digest): their colliders are built now (between steps). */
  addTerrainTiles(tiles: readonly TerrainSimData[]): void {
    this.grid.addTerrainData(tiles);
    this.grid.flushCollision(this.sim.physics3d);
  }

  /** The cells changed since the run started (tests, saves). */
  gridDiff(): import('./grid').GridDiff {
    return this.grid.api.diff();
  }

  /**
   * The material parameters scripts changed since the last call
   * (the latest value of each, a cleared one, a data parameter's grid) — the
   * renderer applies them per object. Taking them changes nothing the simulation computes.
   */
  takeMaterialChanges(): MaterialRenderChange[] {
    return this.materials.takeRenderChanges();
  }

  /** The values scripts set, as digest text (null while none is set). */
  materialState(): string | null {
    return this.materials.digestText();
  }

  /**
   * The environment preset weights interpolated like the
   * transforms (the renderer blends the look from them), or null until a
   * script changed the environment. Reading changes nothing the simulation computes.
   */
  readEnvironmentBlend(): EnvironmentBlendView | null {
    if (this.sim.stateName === 'disposed') return null;
    return this.environment.view(this.sim.stateName === 'failed' ? 1 : this.frame.clock.alpha);
  }

  /** The committed environment blend as digest text (null until a script changed it). */
  environmentState(): string | null {
    return this.environment.digestText();
  }

  /** The player's save from the game shell, made now (between steps) and handed to the host with the next requests. */
  requestSave(slot: number, meta?: import('./project-saves').SaveMeta): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (this.saves.schema === null) return { ok: false, error: fail('game_command_invalid', 'this game has no project save schema', { reason: 'saves' }) };
    const problem = this.saves.saveNow(slot, meta ?? {});
    return problem === null ? { ok: true } : { ok: false, error: fail('game_command_invalid', problem, { reason: 'saves' }) };
  }

  /** Every object's health now (the HUD's bindings). */
  healthsView(): Readonly<Record<string, { readonly current: number; readonly max: number }>> {
    return this.blocks?.primitives.healthsView() ?? {};
  }

  /** The save/load/delete/settings requests since the last call; the host (the storage owner) carries them out. */
  takeSaveRequests(): SaveRequest[] {
    return this.saves.takeRequests();
  }

  /** The project saves state as digest text (null without a save schema or before any save activity). */
  savesState(): string | null {
    return this.saves.digestText();
  }

  /** The scripts' asset loads and releases since the last call; the host (the resource owner) carries them out. */
  takeAssetRequests(): AssetHandleRequest[] {
    return this.assetHandles.takeRequests();
  }

  /** The scripts' asset handles as digest text (null before any was used). */
  assetHandlesState(): string | null {
    return this.assetHandles.digestText();
  }

  /** The project settings document now (empty without a save schema). */
  projectSettings(): Readonly<Record<string, boolean | number | string>> {
    return this.saves.settingsNow();
  }

  /** Where the play stands in a save: the loaded scenes, the active spawn, the scene list entry and the character with its velocity (m/s). */
  private captureWorld(): WorldSave {
    const at = this.scenes.capture();
    return { scenes: at.scenes, activeSpawn: this.chars.activeSpawn, listedScene: at.listedScene, ...this.chars.placement.capture() };
  }

  /** The engine state a save document's sections capture and restore (read when a save is made: the parts exist by then). */
  private buildSaveSections(): SaveSectionsPort {
    const rt = this;
    return saveSectionsPort({
      get grid() { return rt.grid; },
      get materials() { return rt.materials; },
      get saveStore() { return rt.saveStore; },
      get dialogue() { return rt.dialogue; },
      get environment() { return rt.environment; },
      sceneLoaded: (sceneId) => rt.scenes.isLoaded(sceneId),
      get entityAccess() { return rt.entityAccess; },
      blocks: () => rt.blocks,
      spawnedCopies: () => rt.entities.spawnRequests.savedCopies(),
      spawnedCopiesProblem: (value) => rt.entities.spawnRequests.savedCopiesProblem(value),
      restoreSpawnedCopies: (copies) => rt.entities.spawnRequests.restore(copies),
      syncLive: () => void rt.entities.syncLiveBlocks(),
      captureWorld: () => rt.captureWorld(),
      worldProblem: (world) => rt.scenes.worldProblem(world),
      // The saved scenes and spawn; the character is placed once the scenes are in and gets its saved velocity back.
      applyWorld: (world) => {
        rt.scenes.restore(world);
        rt.chars.activeSpawn = world.activeSpawn;
        rt.chars.placement.restoreFrom(world);
        rt.chars.director.saveLoaded();
      },
    });
  }



  /**
   * The sounds scripts played since the last call; the host plays
   * them. The audio intent log's commands (plays with handles,
   * stops, fades, music, duck, bus mix, reset), in the order they were made.
   * Taking them changes nothing the simulation computes.
   */
  takeAudioRequests(): AudioCommand[] {
    return this.audio.take();
  }

  /** The audio intent log's deterministic state (null while scripts never used audio). */
  audioState(): Record<string, unknown> | null {
    return this.audio.state();
  }

  /** Pause or resume the simulation (frames still render and reach onFrame). */
  setPaused(paused: boolean): void {
    this.frame.paused = paused === true;
  }

  get isPaused(): boolean {
    return this.frame.paused;
  }

  /** The last frame's interpolation alpha (what `getInterpolatedState().state.alpha` reports), without building the state. */
  get interpolationAlpha(): number {
    return this.sim.stateName === 'failed' ? 0 : this.frame.clock.alpha;
  }

  /**
   * Play debugging: hold the simulation at the next step
   * boundary (true) or let it run on (false). Frames still render and reach
   * onFrame; the clock resumes from where it was released (no catch-up).
   * Holding changes nothing the simulation computes: the same steps run
   * with the same inputs, only later.
   */
  setDebugHold(hold: boolean): void {
    this.frame.setDebugHold(hold);
  }

  /** Held at a step boundary by the debugger. */
  get debugHeld(): boolean {
    return this.frame.debugHold;
  }

  /** While held, run exactly one more step on the next frame (then stay held). */
  debugStep(): void {
    this.frame.debugStep();
  }

  /**
   * A check after every executed step (settle steps excluded):
   * returning true holds the simulation right there — the rest of that
   * frame's steps do not run (a breakpoint pauses at a step boundary, the
   * same one whatever the frame rate). null removes it.
   */
  setStepWatcher(watcher: ((stepIndex: number) => boolean) | null): void {
    this.frame.stepWatcher = watcher;
  }

  /** An observer told after every executed step (settle steps excluded) with the step count; null removes it. */
  setStepObserver(observer: ((stepIndex: number) => void) | null): void {
    this.frame.stepObserver = observer;
  }

  /**
   * Where this run began — the step count (0, or the boundary
   * of the last restart) and the number of the last spawned copy then (a
   * run's copies are numbered after it: ids are never reused in a play).
   */
  runStart(): { readonly step: number; readonly spawnBase: number; readonly run: number } {
    return { step: this.run.startStep, spawnBase: this.run.spawnBase, run: this.run.number };
  }

  /**
   * Entities hidden (collected collectibles, ctx.game.setVisible; the renderer hides them).
   * With the objects scripts switched off (and their children), which are not drawn either.
   */
  hiddenEntities(): ReadonlySet<string> {
    const off = this.entityAccess.inactive();
    return this.blocks?.hiddenWith(off) ?? off;
  }

  /** The objects scripts switched off, with their children (not drawn, no collision, no triggers, no ticking; audio sources silent). */
  inactiveEntities(): ReadonlySet<string> {
    return this.entityAccess.inactive();
  }

  /** The material swaps made (`ctx.entity(id).set('materials', …)`, timeline keys), by object; the renderer puts them on once loaded. */
  materialSwaps(): ReadonlyMap<string, Readonly<Record<string, string>>> {
    return this.entityAccess.materialSwaps();
  }

  /** The block types' material swaps (`ctx.grid.setTypeMaterials`), by block id; the renderer puts them on once loaded. */
  blockMaterialSwaps(): ReadonlyMap<string, Readonly<Record<string, string>>> {
    return this.grid.typeMaterialSwaps();
  }

  /** What scripts set for the block layers' cut-aways (`ctx.grid.setCutaway`, …); the renderer decides what is cut. */
  blockCutaways(): GridCutawayState {
    return this.grid.cutawayState();
  }

  /** The light values scripts wrote (`ctx.entity(id).set('light', …)`), by object; the renderer applies them. */
  lightOverrides(): ReadonlyMap<string, LightOverride> {
    return this.entityAccess.lightOverrides();
  }

  /** The fields scripts wrote, as digest text (null while none: every other digest is unchanged). */
  entityFieldsState(): string | null {
    return this.entityAccess.digestText();
  }

  /** `ctx.entity` — what the generic component access reads and writes in this runtime. */
  private buildEntityAccess(): EntityAccess {
    const rt = this;
    return new EntityAccess({
      doc: (id) => rt.scenes.entityDocument(id),
      stepStartTransform: (id) => rt.sim.stepStart?.get(id) ?? rt.sim.curr.get(id),
      get curr() {
        return rt.sim.curr;
      },
      order: () => rt.sim.order,
      parentOf: (id) => rt.sim.entities.get(id)?.parentId ?? undefined,
      get controllerIds() {
        return rt.controllers.ids;
      },
      isPhysicsBody: (id) => rt.controllers.has(id) || rt.sim.entities.get(id)?.hasCollider === true,
      isKept: (id) => rt.kept.has(id),
      keepProblem: (id, keep) => rt.entities.keepProblem(id, keep),
      setKept: (id, keep) => rt.entities.setKept(id, keep),
      transformIntentWrote: (id) => rt.phases.transformIntentWrote(id),
      hiddenAtStepStart: (id) => rt.blocks?.hiddenAtStepStart(id) ?? false,
      setVisible: (id, visible) => rt.blocks?.setVisible(id, visible),
      moverState: (id) => rt.blocks?.moverState(id) ?? null,
      setMover: (id, patch) => rt.blocks?.setMover(id, patch),
      get materials() {
        return rt.materials;
      },
      materialIds: () => rt.materialIds,
      materialsSwapped: (id, swap) => {
        const doc = rt.scenes.entityDocument(id);
        if (doc !== undefined) rt.materials.remap(doc, swap);
      },
      inactiveChanged: (off, on) => rt.onInactiveChanged(off, on),
      record: (entry) => rt.faults.record(entry),
      stepIndex: () => rt.sim.stepIndex,
    });
  }

  /**
   * Objects were switched off or on (with their children): the
   * blocks skip them, their colliders leave the physics world (and come back
   * where they are now), their scripts and animators stop ticking (read per
   * step), the renderer hides them (`hiddenEntities`).
   */
  private onInactiveChanged(off: readonly string[], on: readonly string[]): void {
    const set = this.entityAccess.inactive();
    this.blocks?.setInactive(set);
    // Their scripts stop or start ticking.
    if (this.script !== undefined) this.script.ticks.invalidate();
    this.chars.activeChanged(off, on);
  }


  /** The run's named counters and the character's health. */
  gameCounters(): { counters: Record<string, number>; health: { current: number; max: number } | null } {
    return { counters: this.blocks?.countersView() ?? {}, health: this.blocks?.healthView() ?? null };
  }

  /** Every loaded animator's pose (the renderer plays these). */
  animatorPoses(): ReadonlyMap<string, AnimatorPose> {
    return this.animators.poses();
  }

  start(): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    if (this.sim.stateName === 'failed') {
      return { ok: false, error: fail('runtime_failed', 'runtime is failed (dispose and instantiate fresh; a failed instance cannot resume)') };
    }
    if (this.sim.stateName === 'running') {
      return { ok: false, error: fail('runtime_already_started', 'runtime is already running') };
    }
    // Settle pre-roll (M2 module sets): initialization on the first frame
    // after start, cancellable by stop()/dispose() before that frame.
    this.frame.started();
    this.sim.stateName = 'running';
    // Exactly one driver at any time (normative): one rAF loop, installed here, cancelled on stop/dispose.
    if (this.driverKind === 'raf') this.loop.start();
    // Manual driver: no auto-loop; the host calls tick(), and the first
    // tick installs the anchor.
    return { ok: true };
  }

  stop(): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (this.sim.stateName === 'failed') {
      // stop() from `failed` returns { ok: true } (no driver).
      return { ok: true };
    }
    if (this.sim.stateName !== 'running') {
      return { ok: false, error: fail('runtime_not_running', 'runtime is not running (stop requires running)') };
    }
    // Cancel the driver (the owned listener is removed); the mutable
    // state is RETAINED — a restart continues (simTime/stepIndex keep
    // counting; M1 defines no reset).
    this.loop.cancel();
    // A stop before the pre-roll frame cancels the pending initialization.
    this.frame.needsPreroll = false;
    this.sim.stateName = 'stopped';
    return { ok: true };
  }

  tick(nowSeconds: number): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (this.driverKind === 'raf') {
      return {
        ok: false,
        error: fail('tick_not_allowed', 'tick() is manual-driver only (a second loop source would double-step the simulation)'),
      };
    }
    if (this.sim.stateName === 'failed') {
      return { ok: false, error: fail('runtime_failed', 'runtime is failed (a failed instance is never ticked again)') };
    }
    if (this.sim.stateName !== 'running') {
      return { ok: false, error: fail('runtime_not_running', 'runtime is not running (tick requires running)') };
    }
    if (typeof nowSeconds !== 'number' || !Number.isFinite(nowSeconds)) {
      return { ok: false, error: fail('config_invalid', 'tick requires a finite number of seconds') };
    }
    this.frame.run(nowSeconds);
    return { ok: true };
  }

  getDiagnostics(): { ok: true; diagnostics: RuntimeDiagnostics } | { ok: false; error: RuntimeError } {
    // Works in every state, including disposed.
    return { ok: true, diagnostics: this.buildDiagnostics() };
  }

  /** The two steps a draw reads now (a failed runtime draws its last committed step). */
  private drawnSteps(): DrawnSteps {
    const failed = this.sim.stateName === 'failed' && this.sim.committed !== null;
    return {
      order: this.sim.order,
      prev: failed ? this.sim.committed! : this.sim.prev,
      curr: failed ? this.sim.committed! : this.sim.curr,
      alpha: this.sim.stateName === 'failed' ? 0 : this.frame.clock.alpha,
    };
  }

  getInterpolatedState(): { ok: true; state: InterpolatedState } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    const s = this.drawnSteps();
    return { ok: true, state: { stepIndex: this.sim.stepIndex, simTime: this.sim.simTime, alpha: s.alpha, transforms: this.stepReads.transforms(s) } };
  }

  /**
   * The interpolated transform of every entity (draw order), the
   * values `getInterpolatedState` would return, handed to `visit` in three
   * arrays the runtime reuses (copy them; they change at the next entity) —
   * no objects per frame. False when the runtime is disposed.
   */
  forEachInterpolated(visit: InterpolatedVisitor): boolean {
    if (this.sim.stateName === 'disposed') return false;
    this.stepReads.forEach(this.drawnSteps(), visit);
    return true;
  }

  /** Every entity's committed transform (the last step's state; no interpolation). */
  forEachCommitted(visit: InterpolatedVisitor): boolean {
    if (this.sim.stateName === 'disposed') return false;
    const curr = this.drawnSteps().curr;
    // alpha 0 reads the committed transform as it is.
    this.stepReads.forEach({ order: this.sim.order, prev: curr, curr, alpha: 0 }, visit);
    return true;
  }

  /**
   * Every entity's last two finished steps (draw order): the transform
   * before the last step and after it, the pair `forEachInterpolated` blends
   * by the frame's alpha. A presenter that draws later than the frame that
   * stepped (the page, a frame behind the simulation worker) blends them by
   * its own clock.
   */
  forEachStepPair(visit: StepPairVisitor): boolean {
    if (this.sim.stateName === 'disposed') return false;
    this.stepReads.forEachPair(this.drawnSteps(), visit);
    return true;
  }

  /**
   * Sim seconds the drawn state advances per wall second from the last
   * frame on (the game mode's time scale; 0 while paused, held, stopped or
   * failed): with `interpolationAlpha`, where a later draw falls between the
   * last two steps.
   */
  get interpolationRate(): number {
    return this.frame.interpolationRate();
  }

  /**
   * One entity's interpolated transform into the caller's arrays
   * (no allocation). False when the runtime is disposed or has no such entity.
   */
  readInterpolated(id: string, position: number[], rotation: number[], scale: number[]): boolean {
    if (this.sim.stateName === 'disposed') return false;
    return this.stepReads.read(this.drawnSteps(), id, position, rotation, scale);
  }

  private readonly stepReads = new StepReads();

  // ---- The resolved view (views.ts) ------------------------

  /**
   * A view's pose as its camera brain resolved it, interpolated like the
   * transforms (`position`, `rotation` written; its lens returned; the base
   * pose before the brain's first step), or null for an unknown view.
   */
  readCameraView(position: number[], rotation: number[], view?: string): { fovY: number; near: number; far: number; letterbox: number } | null {
    if (this.sim.stateName === 'disposed') return null;
    return this.views.readInterpolated(this.sim.stateName === 'failed' ? 1 : cameraBlendOf(this.frame.clock.alpha), position, rotation, view);
  }

  /** `readCameraView` at a given alpha between the last two steps (0 the step before, 1 the last; a failed runtime reads its last step). */
  readCameraViewAt(alpha: number, position: number[], rotation: number[], view?: string): { fovY: number; near: number; far: number; letterbox: number } | null {
    if (this.sim.stateName === 'disposed') return null;
    return this.views.readInterpolated(this.sim.stateName === 'failed' ? 1 : alpha, position, rotation, view);
  }

  /** A view's committed state (the live camera, a blend in progress, the pose and lens), or null before its first step. */
  cameraView(view?: string): CameraViewInfo | null {
    if (this.sim.stateName === 'disposed') return null;
    return this.views.view(view);
  }

  /** The viewport a view is drawn in (the renderer reports it): screen↔world projection (`ctx.camera`) uses its aspect (16:9 until reported). */
  setCameraViewport(width: number, height: number, view?: string): boolean {
    if (this.sim.stateName === 'disposed') return false;
    return this.views.setViewport(width, height, view);
  }

  getCamera(): { ok: true; camera: CameraInfo } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    // Stable for the session: the main view's key and the project's lens; aspect is a viewport property.
    return { ok: true, camera: this.views.info() };
  }

  // ---- Scene set ---------------------------------------------------------

  sceneSet(): SceneSetView {
    return this.scenes.view();
  }

  takeSceneRequests(): SceneLoadRequest[] {
    return this.scenes.takeRequests();
  }

  provideScene(
    sceneId: string,
    result: { ok: true; entities: readonly EntityV3[] } | { ok: false; message: string },
  ): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    this.scenes.provide(sceneId, result);
    return { ok: true };
  }

  requestScene(op: 'load' | 'unload', sceneId: string, options?: SceneLoadOptions): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    const problem = this.scenes.opProblem(op, sceneId, options);
    if (problem !== null) return { ok: false, error: fail('scene_invalid', problem, { reason: op }) };
    this.scenes.enqueue(op === 'load' ? loadOp(sceneId, options) : { op, sceneId });
    return { ok: true };
  }

  /** Why `requestScene(op, sceneId)` would be refused now (null: it would be accepted); changes nothing. */
  sceneRequestProblem(op: 'load' | 'unload', sceneId: string): string | null {
    if (this.sim.stateName === 'disposed') return 'runtime is disposed';
    return this.scenes.opProblem(op, sceneId);
  }

  /** The scenes being loaded, the transition waiting and the last swap (unchanged views are the same object). */
  sceneLoadingView(): import('./types').SceneLoadingView {
    return this.scenes.loadingView();
  }

  /** The shell's scene list entry the run is at (-1: none). */
  listedSceneIndex(): number {
    return this.scenes.listedIndex();
  }

  /**
   * A test or debug start's spawn in a game without the game
   * session (Play from a scene, `tl_play_start sceneId`): the character
   * arrives at `spawnId` once `sceneId` is loaded, as a scene transition's
   * arrival (the spawn becomes the active one).
   */
  requestArrival(sceneId: string, spawnId: string): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (!this.scenes.known(sceneId)) return { ok: false, error: fail('scene_invalid', `unknown scene ${JSON.stringify(String(sceneId).slice(0, 64))}`, { reason: 'transfer' }) };
    this.chars.placement.arriveAt(spawnId, sceneId);
    return { ok: true };
  }

  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: RuntimeError } {
    if (this.sim.stateName === 'disposed') {
      return { ok: true, alreadyDisposed: true };
    }
    this.loop.cancel();
    this.sim.stateName = 'disposed';
    // Capture the behavior log totals before the instances are released so
    // `logCount`/`logDropped` stay observable after disposal.
    this.faults.behaviorLogTotals();
    // Release the module instances and all references held by the
    // runtime so the heap is reclaimable: dispose is
    // called exactly once on every module instance (including a failed one)
    // and on the port.
    for (const entry of this.sim.entries) {
      const d = entry.instance.dispose;
      if (typeof d === 'function') {
        try {
          d.call(entry.instance);
        } catch {
          /* a failing module dispose must not break runtime disposal */
        }
      }
    }
    this.sim.entries = [];
    if (this.sim.physics3d) {
      try {
        this.sim.physics3d.dispose();
      } catch {
        /* a failing port dispose must not break runtime disposal */
      }
    }
    this.sim.prev = new Map();
    this.sim.curr = new Map();
    this.sim.committed = null;
    this.sim.entities = new Map();
    this.sim.order = [];
    this.controllers.clearStaged();
    this.onFrame = undefined;
    this.frame.clock.clear();
    return { ok: true };
  }

  /** One fixed M1 step (with module isolation). */
  private stepOnce(): boolean {
    // Scene loads/unloads requested by the host apply here too.
    if (!this.scenes.applyOps()) return true;
    // A scene transition's arrival once its scene is loaded, a loaded save's placement once its scenes are in.
    this.chars.placement.atBoundary();
    // A restart asked for, then the game mode's step start.
    if (this.run.restartDue && !this.restartRun(this.sim.stepIndex + 1)) return false;
    if (this.run.startDue && !this.startRun()) return false;
    this.scenes.goToListed();
    if (!this.entities.syncLiveBlocks()) return false;
    this.modes.beginStep(this.sim.stepIndex + 1);
    this.grid.beginStep(this.sim.stepIndex + 1);
    this.chars.suspendBodies();
    this.materials.beginStep(this.sim.stepIndex + 1);
    // Nothing in a plain step reads actions, but the input source is sampled all the same: what the host
    // queued for the UI rides on the frame (the pause panel's restart, a relayed replay), and a relayed
    // input exercise counts its frames by the steps that sample it (without it a game without scripts
    // never answered one).
    try {
      this.input.sample(this.sim.stepIndex);
    } catch (e) {
      this.faults.record({ code: 'module_error', message: `input frame refused: ${messageOf(e)}`, stepIndex: this.sim.stepIndex + 1 });
    }
    // Copy curr before the step; restore it if any module throws
    // (no partial module application). Into the reused step
    // buffer `prev` does not hold (as the M2 step does) — a 3D scene plays on
    // this path, and a fresh copy per step would be ~0.5 KiB of garbage per
    // entity per step.
    const backupMirror = this.sim.spareMirror();
    backupMirror.copyFrom(this.sim.curr, this.sim.currShape);
    const backup = backupMirror.map;
    let failed = false;
    // The module receives the 1-based ordinal of the step being executed:
    // the step completes the stepIndex it is called with
    // ("curr := step(curr, stepIndex); stepIndex++") — the demo's exact
    // points (x0+A at stepIndex 119 under its `(stepIndex + 1)` offset) pin
    // this ordinal semantics. The SimState view still carries completed
    // steps (stepIndex = completed steps at call time;
    // simTime = stepIndex / fixedStepHz).
    const stepOrdinal = this.sim.stepIndex + 1;
    const view: SimState = {
      order: this.sim.order,
      entities: this.sim.entities,
      stepIndex: this.sim.stepIndex,
      simTime: this.sim.simTime,
      prev: this.sim.prev,
      curr: this.sim.curr,
    };
    for (const entry of this.sim.entries) {
      // Registration order (each module in registration order).
      try {
        (entry.instance as SimulationModule).step(view, stepOrdinal);
      } catch (e) {
        failed = true;
        this.faults.record({ code: 'module_error', message: `module step threw: ${messageOf(e)}`, stepIndex: stepOrdinal });
        break;
      }
    }
    if (failed) {
      // The step is a no-op: curr restored, stepIndex and simTime do not
      // advance; a module_error diagnostic is recorded. The failed module
      // instance is not re-created; the step keeps no-opping on every
      // subsequent step until disposed.
      this.sim.curr = cloneCurr(backup);
      return true;
    }
    // Signals, events and messages turn over every step (a step with physics turns them over in beforeStep below);
    // a plain step without a physics world runs the generic primitives (patrols walk; no world for their probes).
    const held = this.modes.physicsHeld;
    if (this.sim.physics3d === undefined || held) this.blocks?.turnover(stepOrdinal);
    if (this.sim.physics3d === undefined && !held) this.blocks?.stepPrimitivesOnly();
    // A respawn places the character (a plain step has no intent phase).
    try {
      this.chars.placement.respawn3DNow();
    } catch (e) {
      this.sim.curr = cloneCurr(backup);
      this.faults.failStopFromError(e, stepOrdinal);
      return false;
    }
    if (this.sim.physics3d !== undefined && !held) {
      // A game with physics steps it in a plain (scene-mode) step
      // too — its character falls and rests under the runtime's physics
      // phase even without a controller module.
      // Movers advance and are posed (script-driven colliders too), then after physics
      // the triggers test the player (a scene has no run state: always "playing").
      if (this.chars.colliders.needsSync && !this.chars.syncColliders()) {
        this.sim.curr = cloneCurr(backup);
        return false;
      }
      try {
        this.chars.queries.beginStep();
        this.blocks?.beforeStep(stepOrdinal);
        this.controllers.runPhysics3D(this.sim.physics3d);
        this.blocks?.afterPhysics(neutralFrame(stepOrdinal - 1));
      } catch (e) {
        this.sim.curr = cloneCurr(backup);
        this.faults.failStopFromError(e, stepOrdinal);
        return false;
      }
    }
    // The timelines (no input frame in a plain step: a wait key needs its timeout).
    if (this.timelines.active) this.timelines.step(stepOrdinal, null);
    // The camera brains resolve the views on the step's transforms.
    this.views.step(null);
    // Conversations advance (before the audio: a voice started now plays from this step).
    this.dialogue.endStep();
    // The environment blend advances with the step.
    this.environment.step();
    // The event → cue table plays the sounds of this step's signals and events.
    if (this.eventCues.length > 0) playEventCues(this.eventCues, this.blocks, this.animators, this.audio);
    // Fades and clips advance; finished sounds are seen next step.
    this.audio.endStep();
    this.sim.prev = backup; // prev := curr at the end of step n−1
    this.sim.stepIndex += 1;
    this.sim.simTime = this.sim.stepIndex / this.sim.hz; // single division
    this.animators.step();
    // Attached entities follow their nodes (posed by the animators just stepped).
    if (this.sockets.active) this.sockets.resolve(null);
    // Cells written after the physics phase collide from the next step; the live blocks' objects follow now.
    this.grid.flushCollision(this.sim.physics3d);
    if (!this.entities.syncLiveBlocks()) return false;
    return true;
  }

  /**
   * One fixed M2 step. Returns `false` after a fail-stop, so the
   * caller stops the frame loop immediately.
   */
  private stepOnceM2(actionOverride?: ActionFrame): boolean {
    const stepIndex = this.sim.stepIndex;
    const ordinal = stepIndex + 1; // the 1-based executed-step index (fixtures)
    // Scene unloads/loads take effect at the step boundary,
    // before the arrivals (a spawn may be in a scene that just loaded).
    if (!this.scenes.applyOps()) return false;
    // A scene transition's arrival once its scene is loaded, a loaded save's placement once its scenes are in.
    this.chars.placement.atBoundary();
    // The spawns and destroys the last step requested, in order.
    if (!this.entities.applySpawnOps()) return false;
    this.entities.spawnRequests.stepBoundary();
    // A restart asked for last step, then the game mode's step start
    // (last step's events end; a script's switch applies now).
    if (this.run.restartDue && !this.restartRun(ordinal)) return false;
    if (this.run.startDue && !this.startRun()) return false;
    this.scenes.goToListed();
    if (!this.entities.syncLiveBlocks()) return false;
    // The plane locks scripts asked for last step: bodies and characters snap onto their planes or go free.
    if (!this.chars.applyPlanes()) return false;
    this.modes.beginStep(ordinal);
    this.scenes.beginStep();
    this.grid.beginStep(ordinal);
    // Bodies outside the rings' collision stand still this step.
    this.chars.suspendBodies();
    this.materials.beginStep(ordinal);
    this.saves.beginStep();
    let action: ActionFrame;
    if (actionOverride !== undefined) {
      action = actionOverride;
      this.input.skipDelivery();
    } else {
      try {
        action = this.input.sample(stepIndex);
      } catch (e) {
        if (e instanceof InputFrameError) {
          this.faults.failStop('module_error', 'input_frame_invalid', messageOf(e), stepIndex);
        } else {
          this.faults.failStop('module_error', 'input_source_threw', messageOf(e), stepIndex);
        }
        return false;
      }
    }
    // The actions of input maps the game mode does not activate read as released
    // (the sampled frame stays the recorded input).
    if (this.modes.active) action = this.modes.mask(action, this.controllers.actionNames);
    // Movers advance (and are posed for physics), a pending bounce
    // reaches the controller; down + jump on a one-way platform drops through.
    this.chars.queries.beginStep();
    // The colliders scripts drive become kinematic bodies before they are first posed.
    if (this.sim.physics3d !== undefined && this.chars.colliders.needsSync && !this.chars.syncColliders()) return false;
    // A game mode may hold physics (the controller, physics, movers and triggers stand still);
    // signals, trigger events and script messages turn over all the same.
    const held = this.modes.physicsHeld;
    if (held) this.blocks?.turnover(ordinal);
    else this.blocks?.beforeStep(ordinal);
    this.chars.placement.beginStep();
    action = this.controllers.dropThrough(action, (id) => this.blocks?.isOneWay(id) === true, this.timing.dropThroughSteps);
    // The pre-step copy goes into the reused buffer `prev` does not hold.
    const backupMirror = this.sim.spareMirror();
    backupMirror.copyFrom(this.sim.curr, this.sim.currShape);
    const backup = backupMirror.map;
    // `ctx.entity(id).get('transform')` reads the step-start transforms; the hidden set's step-start copy starts over.
    this.sim.stepStart = backup;
    this.blocks?.beginScriptStep();
    this.controllers.clearStaged();
    this.sim.currentPhase = undefined;
    this.sim.currentModuleId = undefined;
    // The intent set is cleared at the start of every fixed step.
    // Reset in place (the committed writes are frozen copies, never handed out mutable).
    this.phases.beginStep(stepIndex);
    try {
      this.phases.run('intent', action);
      // The director's walks, holds and placements, then a respawn or a script's character_place, before the controller runs.
      this.chars.director.afterIntentPhase(held, action);
      this.chars.placement.afterIntentPhase();
      if (!held) {
        this.phases.run('controller', action);
        // The impulses reached the controllers (a held step keeps them for the next one).
        if (this.controllers.clearImpulses()) this.phases.changed();
        this.controllers.runPhysics();
      }
      this.phases.run('transform', action);
      // After the transform phase the blocks test the character (triggers,
      // switches, the primitives; not while a game mode holds physics).
      if (!held) this.blocks?.afterPhysics(action);
    } catch (e) {
      this.faults.failStopFromError(e, stepIndex);
      return false;
    }
    // The component writes scripts queued in this step, in script order.
    this.entityAccess.applyQueued();
    if (this.sim.stateName === 'failed') return false;
    // The timelines, after every script phase and before the camera brain (on this step's input frame).
    if (this.timelines.active) {
      try {
        this.timelines.step(ordinal, action);
      } catch (e) {
        this.faults.failStopFromError(e, stepIndex);
        return false;
      }
    }
    // The camera brain, after every phase (the camera phase included):
    // the view is resolved in the step, so replays and the worker resolve it alike.
    this.views.step(action);
    // Conversations advance: the frame's dialogue inputs and the scripts' calls apply, the view model follows.
    this.dialogue.endStep();
    // The environment blend advances with the step.
    this.environment.step();
    // Saves asked for this step are assembled, loaded ones restored (a step boundary).
    this.saves.endStep();
    // The event → cue table plays the sounds of this step's signals and events.
    if (this.eventCues.length > 0) playEventCues(this.eventCues, this.blocks, this.animators, this.audio);
    // Fades and clips advance; finished sounds are seen next step.
    this.audio.endStep();
    // The step-end promotion (`state.prev` during step n holds the state at
    // the end of step n−2): `prev := backup`
    // below, where `backup` is the pre-step `curr` — the post-reset `curr`
    // when a reset wrote at this step's boundary (the no-streak mechanism).
    this.sim.prev = backup;
    this.sim.stepIndex += 1;
    this.sim.simTime = this.sim.stepIndex / this.sim.hz;
    // Cells written after the physics phase collide from the next step; the live blocks' objects follow now.
    this.grid.flushCollision(this.sim.physics3d);
    if (!this.entities.syncLiveBlocks()) return false;
    this.sim.committedMirror.copyFrom(this.sim.curr, this.sim.currShape);
    this.sim.committed = this.sim.committedMirror.map;
    this.animators.step();
    // Attached entities follow their nodes (posed by the animators just stepped); the committed copy too.
    if (this.sockets.active) this.sockets.resolve(this.sim.committed);
    // The step's scene requests commit with it.
    this.scenes.commitStep();
    return true;
  }

  /** The view the host draws the UI over (`ctx.ui.view()`; false: not a view). */
  setUiView(width: number, height: number, pixelRatio: number): boolean {
    return this.sim.stateName !== 'disposed' && this.ui.setScreenView(width, height, pixelRatio);
  }

  /** The page's frame statistics (`ctx.stats`; false: not stats). */
  setStats(stats: unknown): boolean {
    return this.sim.stateName !== 'disposed' && this.engineStats.set(stats);
  }

  /** The game's frame-rate cap (`ctx.display.frameRateCap`). */
  frameRateCap(): number | null {
    return this.loop.pacer.frameRateCap;
  }

  /** Set the game's frame-rate cap (false: not a cap). */
  setFrameRateCap(fps: unknown): boolean {
    return this.sim.stateName !== 'disposed' && this.loop.pacer.setCap(fps);
  }

  /** Pace at this cap whatever the game sets (undefined: the game's again). */
  pinFrameRateCap(fps: unknown): boolean {
    return this.sim.stateName !== 'disposed' && this.loop.pacer.pinCap(fps);
  }

  framePacing(): FramePacingStats {
    return this.loop.pacer.stats();
  }

  /** The dialogue runner's state as digest text (null while nothing used dialogue). */
  dialogueState(): string | null {
    return this.dialogue.digestText();
  }

  /** The conversation now, for observers (null while nothing used dialogue). */
  dialogueView(): Record<string, unknown> | null {
    return this.dialogue.observe();
  }

  /** The UI changes since the host last took them. */
  takeUiOutput(): UiOutput | null {
    return this.ui.takeOutput();
  }

  /** The committed view model and shown documents. */
  uiView(): UiStateView {
    return this.ui.view();
  }

  // ---- Game modes and the run lifecycle -------------------------------

  /** The game modes as of the last step (null without modes). */
  modeView(): ModeView | null {
    return this.modes.active ? this.modes.view() : null;
  }

  /** The start's injected variables into ctx.save (at the start and at every restart). */
  private applyStartVariables(): void {
    const variables = this.run.variables;
    if (variables !== undefined) for (const [k, v] of Object.entries(variables)) this.saveControl.set(k, v);
  }

  /**
   * Restart the run, at a step boundary: the start scenes (later loads unloaded, spawned copies
   * gone), every object at its authored transform, the scripts started over (their reset hook, as a
   * replay), cameras, animators, sockets, blocks, cells, material values, timelines, conversations,
   * the UI and the start mode as at the start, the character placed where it started (from rest).
   * `ctx.save` values stay (as across a replay), except that the start's variables are set again.
   * Returns false after a fail-stop.
   */
  private restartRun(ordinal: number): boolean {
    this.run.restartDue = false;
    this.applyStartVariables();
    // A new run — its steps count from here (tools compare a run with its replay by run step).
    this.run.startStep = ordinal - 1;
    this.run.number += 1;
    this.scenes.newRun();
    // A save's placement, scripts' impulses and a spawn facing do not outlive the run.
    this.chars.placement.restartRun();
    this.chars.director.reset();
    this.controllers.clearImpulses();
    this.entities.clearSpawned();
    this.run.spawnBase = this.entities.spawnRequests.serial;
    // Every sound scripts started stops, every decal they spawned goes: the new run's scripts hold no handle to them.
    this.audio.reset();
    this.presentation.restartRun();
    // The scripts start over knowing no handle: those still open are released (and reported).
    this.assetHandles.endRun();
    if (!this.scenes.restoreStartSet()) return false;
    for (const [id, data] of this.sim.entities) {
      const t = this.sim.curr.get(id);
      if (t === undefined) continue;
      for (let k = 0; k < 3; k += 1) t.position[k] = data.transform.position[k]!;
      for (let k = 0; k < 4; k += 1) t.rotation[k] = data.transform.rotation[k]!;
      for (let k = 0; k < 3; k += 1) t.scale[k] = data.transform.scale[k]!;
    }
    this.views.reset();
    this.timelines.reset();
    // The look starts over too: the first start scene's, no preset (a replay sees what the first run saw).
    this.environment.reset();
    this.input.newRun();
    this.animators.reset();
    this.sockets.reset();
    this.settleSockets();
    this.blocks?.resetRun();
    // Every field scripts wrote back as authored (switched-off objects come back, colliders included).
    this.entityAccess.reset();
    // The live blocks start over as fresh objects at the next boundary.
    this.entities.removeSpawnedIds(new Set(this.grid.reset().filter((id) => this.entities.spawned.has(id))));
    this.grid.flushCollision(this.sim.physics3d);
    this.materials.reset();
    // No conversation, no save document and no play time yet, as at the first start.
    this.dialogue.resetRun();
    this.faults.scriptErrorLines.clear();
    this.saves.reset();
    this.ui.resetRun();
    this.modes.beginRun(ordinal);
    this.chars.activeSpawn = null;
    // Every module's run reset brings the controllers back in the state they were created in (not a placement's,
    // which starts a character from rest mid-run); right after, the run starts as the first did (`startRun`).
    this.run.startDue = true;
    const first = this.controllers.first !== undefined ? this.sim.entities.get(this.controllers.first) : undefined;
    const start: Vec2 = first === undefined ? { x: 0, y: 0 } : { x: first.transform.position[0], y: first.transform.position[1] };
    for (const entry of this.sim.entries) {
      if (!entry.phased) continue;
      const instance = entry.instance as SimulationPhaseModule;
      if (typeof instance.reset !== 'function') continue;
      this.sim.currentModuleId = entry.id;
      try {
        instance.reset(this.chars.resetContext('replay', ordinal, start, new Set(entry.owners)));
      } catch (e) {
        this.faults.failStopFromError(e, this.sim.stepIndex);
        return false;
      }
    }
    // No render streak: prev := curr for the restarted state.
    const prevMirror = this.sim.stepMirrors[this.sim.stepMirrors[1].map === this.sim.prev ? 1 : 0];
    prevMirror.copyFrom(this.sim.curr, this.sim.currShape);
    this.sim.prev = prevMirror.map;
    return true;
  }

  /** The look overrides now (object → emissive/tint), for the renderer. */
  entityLooks(): ReadonlyMap<string, import('./primitives').EntityLook> {
    return this.blocks?.primitives.looksView() ?? NO_LOOKS;
  }

  /** The timelines' screen overlay, plays and last events (null until a timeline played). */
  timelineView(): TimelineView | null {
    return this.timelines.view();
  }

  /** The timelines' state for the step digest (null until a timeline played). */
  timelineState(): string | null {
    return this.timelines.digestState();
  }

  // ---- Input and what the host queues for the next sampled step ---------------

  /** The pointer state as of the last step (null before the first sample; observers, the host). */
  readPointer(): Readonly<HeldPointer> | null {
    return this.input.pointer();
  }

  /**
   * The cursor a script asked for (`ctx.input.setCursor`): 'free',
   * 'locked', or null — the active input map decides. Simulation state: a new
   * run starts with none.
   */
  cursorRequest(): 'free' | 'locked' | null {
    return this.input.cursor();
  }

  /** The binding requests scripts made since the last call (see `Runtime.takeBindingRequests`). */
  takeBindingRequests(): { readonly requests: readonly InputBindingRequest[]; readonly dropped: number } {
    return this.input.takeBindingRequests();
  }

  /** The declared debug commands (the engine's `signal` first) and the calls run (newest last). */
  debugCommandState(): DebugCommandState {
    return this.input.debugCommandState();
  }

  /** Queue a debug command call for the next sampled step (see `Runtime.queueDebugCommand`). */
  queueDebugCommand(call: DebugCommandCall): { ok: true } | { ok: false; error: RuntimeError } {
    return this.input.queueDebugCommand(call);
  }

  /** Queue a UI event for the next sampled step (see `Runtime.queueUiEvent`). */
  queueUiEvent(event: UiEventRecord): { ok: true } | { ok: false; error: RuntimeError } {
    return this.input.queueUiEvent(event);
  }

  /**
   * Queue a dialogue input (advance, choose, skip, auto,
   * backlog — the dialogue UI's buttons) for the next sampled step; it rides
   * on that step's input frame (`ActionFrame.dialogue`), so a recording
   * replays it and the worker applies it at the same step.
   */
  queueDialogueInput(input: DialogueInputRecord): { ok: true } | { ok: false; error: RuntimeError } {
    return this.input.queueDialogueInput(input);
  }

  /**
   * Queue one storage answer (the slot list, a save/delete
   * outcome, a loaded document) for the next sampled step — it rides on that
   * step's input frame, so a recording replays it and the worker applies it
   * at the same step. Refused for a project without a save schema, a bad
   * entry, or when 64 are already waiting.
   */
  queueSaveEvent(event: SaveEvent): { ok: true } | { ok: false; error: RuntimeError } {
    return this.input.queueSaveEvent(event);
  }

  /** Queue the host's answer to one asset load for the next sampled step (it rides on that step's input frame). */
  queueAssetAnswer(answer: AssetHandleAnswer): { ok: true } | { ok: false; error: RuntimeError } {
    return this.input.queueAssetAnswer(answer);
  }

  /** A run's start at a step boundary, the first run's and every restart's alike (the physics world, the bodies); false after a fail-stop. */
  private startRun(): boolean {
    this.run.startDue = false;
    return this.chars.startRun();
  }


  /** The problems since the last call (the host relays them). */
  takeProblems(): { code: string; message: string }[] {
    return this.faults.takeProblems();
  }

  /** Play debugging: what the running behavior instances expose for a debugger (`behaviorDebugOf`). */
  behaviorDebug(filter: { behaviorId?: string; entityId?: string } = {}): BehaviorDebugView[] {
    return behaviorDebugOf(this.sim.entries, filter);
  }

  /** The property values every behavior instance on `entityId` reads (public and private), read-only, for the Play debug view. */
  behaviorProperties(entityId: string): BehaviorPropertyView[] {
    return behaviorPropertiesOf(this.sim.entries, entityId);
  }

  private buildDiagnostics(): RuntimeDiagnostics {
    const sim = this.sim;
    const base: RuntimeDiagnostics = {
      state: sim.stateName,
      snapshotId: this.snapshotId,
      revision: this.revision,
      simTime: sim.simTime,
      stepIndex: sim.stepIndex,
      fixedStepHz: sim.hz,
      droppedSteps: this.frame.clock.droppedSteps,
      frameCount: this.frame.clock.frameCount,
      entityCount: sim.entityCount,
      modules: [...this.modules],
      clock: this.clockLabel,
      clockWarningCount: this.frame.clock.clockWarningCount,
      ...this.faults.base(),
    };
    if (!this.isM2) return base;
    const m2: RuntimeDiagnostics = {
      ...base,
      ...this.faults.phasedFields(this.actions, this.controllers.first, { inputSamples: this.input.samples, droppedInputSteps: this.frame.clock.droppedInputSteps, settleSteps: this.frame.settleSteps, physicsSteps: this.chars.physicsSteps, intentCommitCount: this.phases.commitCount }),
    };
    // Generic component writes (only once a script used them: every other diagnostics frame keeps its shape).
    const ea = this.entityAccess;
    if (ea.applied + ea.refused + ea.conflicts > 0) m2.entityWrites = { applied: ea.applied, refused: ea.refused, conflicts: ea.conflicts, inactive: ea.inactive().size };
    // Script messages refused at the per-step limit (only once one was: the warning); block layers' memory (with layers).
    const queue = this.blocks?.messageQueueView() ?? null;
    if (queue !== null) m2.messageQueue = queue;
    const blockMemory = this.grid.memory();
    if (blockMemory !== null) m2.blockMemory = blockMemory;
    const terrainMemory = this.grid.terrain.memory();
    if (terrainMemory !== null) m2.terrainMemory = terrainMemory;
    const scatterCopies = this.grid.scatter.diagnostics();
    if (scatterCopies !== null) m2.scatterCopies = scatterCopies;
    const splines = this.grid.splines.diagnostics();
    if (splines !== null) m2.splines = splines;
    const architecture = this.grid.architecture.diagnostics();
    if (architecture !== null) m2.architecture = architecture;
    const worldStream = this.grid.stream.diagnostics();
    if (worldStream !== null) m2.worldStream = { ...worldStream, suspended: this.chars.suspension.diagnostics() };
    return Object.assign(m2, this.faults.failure());
  }
}
