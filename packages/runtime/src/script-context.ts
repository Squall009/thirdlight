/**
 * What a phased module's step context (`ctx`) carries past the step's own
 * values: every engine part scripts reach — scenes, animators, gameplay
 * blocks, audio, effects, saves, spawning, cameras, input, the block layers,
 * materials, component access, UI, dialogue, modes, timelines, the
 * environment — and which behaviors tick this step.
 *
 * The members are made once per module and phase (`ScriptContext.fields`), as
 * values or as getters that read the step's state when accessed.
 */
import type { AnimatorSystem } from './animator-system';
import type { GameplayBlocks } from './blocks';
import type { CharacterDirector } from './character-director';
import type { DebugCommands } from './debug-commands';
import type { DialogueRunner } from './dialogue';
import type { EngineStatsHolder } from './engine-stats';
import type { EntityAccess } from './entity-access';
import type { EnvironmentDirector } from './environment-director';
import type { FrameLoop } from './frame-loop';
import type { RuntimeGrid } from './grid';
import type { RuntimeInputStatus } from './input-status';
import type { RuntimeMaterials } from './material-params';
import type { ModeState } from './modes';
import type { PresentationRequests } from './presentation-requests';
import type { RuntimeSaves } from './project-saves';
import type { RuntimeAssetHandles } from './asset-handles';
import type { ScriptAudioControl } from './script-audio';
import { modeControlOf, type blockControls } from './script-controls';
import type { RuntimeViews } from './views';
import type { UiState } from './ui';
import { uiControlOf } from './ui-control';
import type {
  BehaviorLifecycle,
  BehaviorModes,
  BehaviorSceneControl,
  BehaviorShell,
  BehaviorSockets,
  BehaviorSpawnControl,
  BehaviorTimeline,
  BehaviorUi,
  DebugCommandOptions,
  SimulationPhase,
} from './types';

/** The parts a step context reaches. */
export interface ScriptContextParts {
  /** `ctx.scenes` (null: a game without a scene catalog has none). */
  readonly scenes: BehaviorSceneControl | null;
  readonly animators: AnimatorSystem;
  readonly blockControls: ReturnType<typeof blockControls>;
  readonly game: unknown;
  readonly director: CharacterDirector;
  readonly audioControl: ScriptAudioControl;
  readonly presentation: PresentationRequests;
  readonly save: unknown;
  readonly spawnControl: BehaviorSpawnControl;
  readonly spawnerOwned: (entityId: string) => BehaviorSpawnControl;
  readonly views: RuntimeViews;
  readonly sockets: BehaviorSockets;
  /** `ctx.input.setCursor` (the cursor channel). */
  readonly cursor: unknown;
  readonly inputStatus: RuntimeInputStatus;
  readonly debugCommands: DebugCommands;
  readonly grid: RuntimeGrid;
  readonly materials: RuntimeMaterials;
  readonly entityAccess: EntityAccess;
  readonly shell: BehaviorShell;
  readonly saves: RuntimeSaves;
  readonly assetHandles: RuntimeAssetHandles;
  readonly ui: UiState;
  readonly engineStats: EngineStatsHolder;
  readonly loop: FrameLoop;
  readonly dialogue: DialogueRunner;
  readonly modes: ModeState;
  readonly lifecycle: BehaviorLifecycle;
  readonly timeline: BehaviorTimeline;
  readonly environment: EnvironmentDirector;
  readonly blocks: GameplayBlocks | null;
  /** The behavior group of each loaded entity that carries one. */
  readonly behaviorGroupOf: ReadonlyMap<string, string>;
  /** The completed steps now (`ctx.modes` reads the step being run). */
  stepIndex(): number;
  /** The active camera's yaw for the character's move input (null: a game without physics has none). */
  readonly cameraYaw: (() => number | undefined) | null;
}

/**
 * `StepContext.behaviorTicks`: whether an entity's behavior runs this step
 * (undefined — every behavior runs — without modes or while the mode ticks
 * every group; one function per runtime).
 */
export class BehaviorTicks {
  private fn: ((entityId: string) => boolean) | undefined = undefined;
  private off: { set: ReadonlySet<string>; fn: (entityId: string) => boolean } | null = null;

  constructor(
    private readonly modes: ModeState,
    private readonly inactive: () => ReadonlySet<string>,
    private readonly groupOf: ReadonlyMap<string, string>,
  ) {}

  now(): ((entityId: string) => boolean) | undefined {
    // A switched-off object's scripts do not tick.
    const off = this.inactive();
    if (this.modes.ticksAll) {
      if (off.size === 0) return undefined;
      if (this.off === null || this.off.set !== off) this.off = { set: off, fn: (entityId: string): boolean => !off.has(entityId) };
      return this.off.fn;
    }
    if (this.fn === undefined) this.fn = (entityId: string): boolean => !this.inactive().has(entityId) && this.modes.ticks(this.groupOf.get(entityId));
    return this.fn;
  }

  /** Objects were switched off or on: the functions are made again. */
  invalidate(): void {
    this.fn = undefined;
    this.off = null;
  }
}

/** The step contexts' members past the step's own, and the per-phase controls they share. */
export class ScriptContext {
  /** Which behaviors tick this step (`ctx.behaviorTicks`). */
  readonly ticks: BehaviorTicks;
  private readonly ui = new Map<SimulationPhase, BehaviorUi>();
  private readonly modes = new Map<SimulationPhase, BehaviorModes>();

  constructor(private readonly p: ScriptContextParts) {
    this.ticks = new BehaviorTicks(p.modes, () => p.entityAccess.inactive(), p.behaviorGroupOf);
  }

  /** A step context's members past the step's own, for one phase (made once per module and phase). */
  fields(phase: SimulationPhase): PropertyDescriptorMap {
    const p = this.p;
    let modes = this.modes.get(phase);
    if (modes === undefined) this.modes.set(phase, (modes = modeControlOf(p.modes, phase, () => p.stepIndex())));
    return contextFields(p, phase, modes, uiControlOf(this.ui, p.ui, phase), this.ticks);
  }
}

function contextFields(p: ScriptContextParts, phase: SimulationPhase, modes: BehaviorModes, ui: BehaviorUi, ticks: BehaviorTicks): PropertyDescriptorMap {
  const b = p.blockControls;
  const fields: PropertyDescriptorMap = {};
  if (p.scenes !== null) fields['scenes'] = { value: p.scenes, enumerable: true };
  fields['animators'] = { value: p.animators.control, enumerable: true };
  fields['animatorEvents'] = { get: () => p.animators.events, enumerable: true };
  fields['signals'] = { value: b.signals, enumerable: true };
  fields['messages'] = { value: b.messages, enumerable: true };
  fields['game'] = { value: p.game, enumerable: true };
  // The generic primitives.
  fields['health'] = { value: b.health, enumerable: true };
  fields['patrol'] = { value: b.patrol, enumerable: true };
  fields['hitbox'] = { value: b.hitbox, enumerable: true };
  fields['collectible'] = { value: b.collectible, enumerable: true };
  // The character's impulse and the per-object look overrides.
  fields['character'] = { value: p.director.control, enumerable: true };
  fields['look'] = { value: b.look, enumerable: true };
  fields['audio'] = { value: p.audioControl.control, enumerable: true };
  fields['audioOwned'] = { value: p.audioControl.owned, enumerable: true };
  fields['effects'] = { value: p.presentation.effects, enumerable: true };
  fields['decals'] = { value: p.presentation.decals, enumerable: true };
  fields['save'] = { value: p.save, enumerable: true };
  fields['spawner'] = { value: p.spawnControl, enumerable: true };
  fields['spawnerOwned'] = { value: p.spawnerOwned, enumerable: true };
  // The virtual cameras (ctx.camera).
  fields['camera'] = { value: p.views.control, enumerable: true };
  // Sockets (ctx.sockets).
  fields['sockets'] = { value: p.sockets, enumerable: true };
  // The cursor channel (ctx.input.setCursor).
  fields['cursor'] = { value: p.cursor, enumerable: true };
  // Bindings, the device in use and rebinding (ctx.input).
  fields['inputStatus'] = { value: p.inputStatus.view, enumerable: true };
  // Debug commands (this phase's calls; the behavior host adds the handler).
  const debugCommands = p.debugCommands;
  fields['debug'] = { value: Object.freeze({ command: (name: string, options?: DebugCommandOptions) => debugCommands.declare(name, options, phase === 'intent') }), enumerable: true };
  // The block layers, the terrains' and layers' scatter copies, the splines, and the ground of both.
  fields['grid'] = { value: p.grid.api, enumerable: true };
  fields['scatter'] = { value: p.grid.scatter.api, enumerable: true };
  fields['splines'] = { value: p.grid.splines.api, enumerable: true };
  fields['surface'] = { value: p.grid.surface.api, enumerable: true };
  // Graph-material parameters per object.
  fields['materials'] = { value: p.materials.api, enumerable: true };
  // Generic component access (the behavior host names the writing script) and the shell's scene list.
  fields['entities'] = { value: p.entityAccess.control, enumerable: true };
  fields['shell'] = { value: p.shell, enumerable: true };
  // Project saves (ctx.saves).
  fields['saves'] = { value: p.saves.api, enumerable: true };
  fields['assets'] = { value: p.assetHandles.api, enumerable: true };
  // The project UI (the step's UI events in the intent phase).
  fields['ui'] = { value: ui, enumerable: true };
  fields['stats'] = { get: () => p.engineStats.now(), enumerable: true };
  fields['display'] = { value: p.loop.display, enumerable: true };
  // Conversations (ctx.dialogue; calls apply at the end of the step).
  fields['dialogue'] = { value: p.dialogue.api, enumerable: true };
  // The game modes, the run lifecycle, and which behaviors tick in the current mode.
  fields['modes'] = { value: modes, enumerable: true };
  fields['lifecycle'] = { value: p.lifecycle, enumerable: true };
  fields['behaviorTicks'] = { get: () => ticks.now(), enumerable: true };
  // The switched-off objects (the behavior host's onEnable/onDisable).
  const access = p.entityAccess;
  fields['inactiveEntities'] = { get: () => access.inactive(), enumerable: true };
  // Timelines (ctx.timeline).
  fields['timeline'] = { value: p.timeline, enumerable: true };
  // The environment presets (ctx.environment).
  fields['environment'] = { value: p.environment.api, enumerable: true };
  // Last step's trigger enter/exit events (each script gets those it owns).
  const blocks = p.blocks;
  if (blocks !== null) fields['triggerEvents'] = { get: () => blocks.triggerEvents(), enumerable: true };
  // The primitives' events of the last step (each script gets those of the objects it owns).
  if (blocks !== null) fields['primitiveEvents'] = { get: () => blocks.primitiveEvents(), enumerable: true };
  // The climb volume the character is in (the character controllers read it).
  if (blocks !== null) fields['climb'] = { value: b.climb, enumerable: true };
  // 3D: the active camera's yaw for the character's move input (absent: world axes).
  const cameraYaw = p.cameraYaw;
  if (cameraYaw !== null) fields['cameraYaw'] = { get: cameraYaw, enumerable: true };
  return fields;
}
