/**
 * The module phases of a step: each module's reused state view and step
 * context per phase, the phases run in registration order, and the intents
 * modules commit — checked (shape, phase, value, owner, one writer per
 * channel, the per-step cap) and applied here, so one step has at most one
 * writer per `(entityId, axis)` and every rejection is a fail-stop (a throw
 * the step loop turns into one).
 */
import { neutralFrame, type ActionFrame } from './actions';
import type { CharacterDirector } from './character-director';
import type { ControllerPlacements } from './character-placement';
import { frozenContext, liveScopedState } from './guard';
import {
  BehaviorIntentError,
  INTENT_LIMITS,
  quantizeIntentMove,
  validateIntentPhase,
  validateIntentShape,
  validateIntentValue,
  writeRotationForm,
  type BehaviorIntent,
  type ControllerIntents,
  type IntentSet,
} from './intents';
import { emptyControllerChannels, emptyMutableIntents, resetMutableIntents, type MutableControllerChannels, type MutableIntentSet } from './mutable-intents';
import type { PlayerControllers } from './player-controllers';
import { ownerSetOf, type ModuleEntry, type PhaseViews, type RuntimeSim } from './runtime-sim';
import type { BehaviorLifecycle, SimulationModule, SimulationPhase, SimulationPhaseModule, StepContext } from './types';

/** What the phases reach past the simulation state. */
export interface PhaseHost {
  readonly controllers: PlayerControllers;
  readonly placement: ControllerPlacements;
  readonly director: CharacterDirector;
  /** `ctx.lifecycle` (a respawn intent is its respawn). */
  readonly lifecycle: BehaviorLifecycle;
  /** `ctx.physics` (the queries with the step's budget). */
  readonly physicsQueries: StepContext['physics'];
  /** The step context's members past the step's own, for one phase (made once per module and phase). */
  contextFields(phase: SimulationPhase): PropertyDescriptorMap;
}

export class RuntimePhases {
  /** The runtime's per-step intent set. */
  intents: MutableIntentSet = emptyMutableIntents(-1);
  /** Bumped at every commit and step start; the intents view is remade only when it moved. */
  private version = 0;
  private viewVersion = -1;
  private viewCache: IntentSet | null = null;
  /** The per-step intent cap for the current entity order (`stepLimit`). */
  private limit: number = INTENT_LIMITS.perStep;
  private limitOrder: readonly string[] | null = null;
  /** The frame the current phase runs with (read by the reused step contexts). */
  private action: ActionFrame = neutralFrame(0);
  private frozenOrderSource: readonly string[] | null = null;
  private frozenOrderCopy: readonly string[] = Object.freeze([]);
  /** Accepted intents committed in this runtime instance. */
  commitCount = 0;

  constructor(
    private readonly sim: RuntimeSim,
    private readonly host: PhaseHost,
  ) {}

  /** The intents changed outside a commit (a placement, an impulse): the next view is remade. */
  changed(): void {
    this.version += 1;
  }

  /** The intent set is cleared at the start of every fixed step (in place: the committed writes are frozen copies, never handed out mutable). */
  beginStep(stepIndex: number): void {
    resetMutableIntents(this.intents, stepIndex);
    this.version += 1;
  }

  /** An owned transform intent wrote this object's transform this step. */
  transformIntentWrote(id: string): boolean {
    const stored = this.intents.axes.get(id);
    const tag = this.intents.axesTag * 64;
    return stored !== undefined && stored >= tag && stored < tag + 64 && stored !== tag;
  }

  run(phase: SimulationPhase, action: ActionFrame): void {
    const sim = this.sim;
    this.action = action;
    for (const entry of sim.entries) {
      if (!entry.phases.includes(phase)) continue;
      sim.currentPhase = phase;
      sim.currentModuleId = entry.id;
      const views = this.viewsOf(entry, phase);
      if (entry.phased) {
        // The intents committed before this module runs (it does not see its own in `ctx.intents`).
        views.intents = this.view();
        (entry.instance as SimulationPhaseModule).step(phase, views.ctx!);
      } else {
        // Accepted M1 module participating in an M2 set (implicit
        // transform phase): the M1 `(state, stepIndex)` call is preserved.
        (entry.instance as SimulationModule).step(views.state, sim.stepIndex + 1);
      }
    }
  }

  /** The frozen copy of the entity order modules see (remade only when the order changes). */
  private frozenOrder(): readonly string[] {
    if (this.frozenOrderSource !== this.sim.order) {
      this.frozenOrderSource = this.sim.order;
      this.frozenOrderCopy = Object.freeze([...this.sim.order]);
    }
    return this.frozenOrderCopy;
  }

  /**
   * A module's state view and step context for one phase, made
   * once and reused every step. They read the step's values when accessed
   * (step index, time, transforms, the frame, the events) — what a context
   * made at the call would hold, since the runtime changes none of them while
   * a module runs.
   */
  private viewsOf(entry: ModuleEntry, phase: SimulationPhase): PhaseViews {
    let byPhase = entry.views;
    if (byPhase === undefined) {
      byPhase = new Map();
      entry.views = byPhase;
    }
    const cached = byPhase.get(phase);
    if (cached !== undefined) return cached;
    // The closures live in another function: V8 would allocate their scope at every call, cache hits included.
    const made = this.makeViews(entry, phase);
    byPhase.set(phase, made);
    return made;
  }

  private makeViews(entry: ModuleEntry, phase: SimulationPhase): PhaseViews {
    const sim = this.sim;
    // The accepted rule: the transform phase writes the declared owners.
    const writablePhase = phase === 'transform';
    const state = liveScopedState({
      order: () => this.frozenOrder(),
      entities: () => sim.entities,
      stepIndex: () => sim.stepIndex,
      simTime: () => sim.simTime,
      prev: () => sim.prev,
      curr: () => sim.curr,
      writableOwners: () => (writablePhase ? ownerSetOf(entry) : null),
    });
    const views: PhaseViews = { state, ctx: null, intents: null };
    if (entry.phased) {
      const fields: PropertyDescriptorMap = {
        stepIndex: { get: () => sim.stepIndex, enumerable: true },
        phase: { value: phase, enumerable: true },
        action: { get: () => this.action, enumerable: true },
        settings: { value: sim.settings, enumerable: true },
        physics: { value: this.host.physicsQueries, enumerable: true },
        state: { value: state, enumerable: true },
        intents: { get: () => views.intents, enumerable: true },
        emit: { value: (intent: BehaviorIntent): void => this.commit(entry, phase, intent), enumerable: true },
        ...this.host.contextFields(phase),
      };
      views.ctx = frozenContext(Object.defineProperties({}, fields) as StepContext);
    }
    return views;
  }

  /**
   * A frozen read-only view of the intents committed so far this step (phase
   * The same object until the next commit or step).
   */
  private view(): IntentSet {
    if (this.viewCache !== null && this.viewVersion === this.version) return this.viewCache;
    const s = this.intents;
    const view: IntentSet = Object.freeze({
      stepIndex: s.stepIndex,
      move: s.move,
      jump: s.jump,
      moveWriter: s.moveWriter,
      jumpWriter: s.jumpWriter,
      // The writes are frozen when committed.
      transformWrites: Object.freeze(s.transformWrites.slice()),
      // Present only when committed (a 2D step's view has no such field).
      ...(s.moveY !== null ? { moveY: s.moveY } : {}),
      ...(s.characterMove !== null ? { characterMove: Object.freeze({ ...s.characterMove }) } : {}),
      ...(s.characterPlace !== null ? { characterPlace: Object.freeze({ ...s.characterPlace }) } : {}),
      ...(s.characterEnabled !== null ? { characterEnabled: s.characterEnabled } : {}),
      // scripts' impulses for the controller, and the yaw a placement faces (present only when set).
      ...this.controllerExtras(this.host.controllers.first),
      ...this.furtherControllerIntents(),
    });
    this.viewCache = view;
    this.viewVersion = this.version;
    return view;
  }

  /** A controller's impulse and placement yaw this step, as intent fields (present only when set). */
  private controllerExtras(id: string | undefined): { impulse?: { x: number; y: number; z: number }; characterYaw?: number; inputHeld?: boolean } {
    if (id === undefined) return {};
    const controllers = this.host.controllers;
    const i = controllers.impulseOf(id);
    const yaw = this.host.placement.of(id)?.stepFacing ?? null;
    const held = (id === controllers.first ? this.intents : this.intents.further.get(id))?.inputHeld === true;
    return { ...(i !== null ? { impulse: Object.freeze({ x: i[0], y: i[1], z: i[2] }) } : {}), ...(yaw !== null ? { characterYaw: yaw } : {}), ...(held ? { inputHeld: true } : {}) };
  }

  /** The further player controllers' channels this step (`IntentSet.controllers`; absent when none was named). */
  private furtherControllerIntents(): { controllers?: Readonly<Record<string, ControllerIntents>> } {
    const out: Record<string, ControllerIntents> = {};
    const ids = this.host.controllers.ids;
    for (let i = 1; i < ids.length; i += 1) {
      const id = ids[i]!;
      const c = this.intents.further.get(id);
      const extras = this.controllerExtras(id);
      if (c === undefined && extras.impulse === undefined && extras.characterYaw === undefined) continue;
      out[id] = Object.freeze({
        move: c?.move ?? null,
        jump: c?.jump ?? null,
        ...(c !== undefined && c.moveY !== null ? { moveY: c.moveY } : {}),
        ...(c?.characterMove != null ? { characterMove: Object.freeze({ ...c.characterMove }) } : {}),
        ...(c?.characterPlace != null ? { characterPlace: Object.freeze({ ...c.characterPlace }) } : {}),
        ...(c !== undefined && c.characterEnabled !== null ? { characterEnabled: c.characterEnabled } : {}),
        ...extras,
      });
    }
    return Object.keys(out).length > 0 ? { controllers: Object.freeze(out) } : {};
  }

  /** A player controller's intent channels this step (the first's are the set's own; a further one's are made when named). */
  channelsOf(id: string): MutableControllerChannels {
    if (id === this.host.controllers.first) return this.intents;
    let c = this.intents.further.get(id);
    if (c === undefined) {
      c = emptyControllerChannels();
      this.intents.further.set(id, c);
    }
    return c;
  }

  /**
   * Commit one intent (steps 1–7). The runtime owns the
   * cross-module duplicate-writer check and the per-step cap; the transform
   * write is applied here (position axes only) so one step has at most one
   * writer per `(entityId, axis)`. Every rejection is a fail-stop.
   */
  private commit(entry: ModuleEntry, phase: SimulationPhase, raw: unknown): void {
    const shape = validateIntentShape(raw);
    if (!shape.ok) throw shape.error;
    const intent = shape.intent;
    const phaseError = validateIntentPhase(intent, phase);
    if (phaseError !== null) throw phaseError;
    const valueError = validateIntentValue(intent);
    if (valueError !== null) throw valueError;

    const controllers = this.host.controllers;
    // A player controller's intents name their controller (absent: the first).
    let channels: MutableControllerChannels | null = null;
    let player: string | undefined;
    if (intent.kind !== 'transform' && intent.kind !== 'pose') {
      player = controllers.resolve(intent.entityId);
      if (intent.entityId !== undefined && player === undefined) {
        throw new BehaviorIntentError('behavior_intent_invalid', 'value', `${intent.kind}.entityId "${intent.entityId}" is not a player controller`);
      }
      channels = player !== undefined ? this.channelsOf(player) : this.intents;
    }
    if (intent.kind === 'control_move') {
      const c = channels!;
      if (c.move !== null) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_writer', `control_move already committed by "${c.moveWriter}" and "${entry.id}"`);
      }
      this.bump();
      c.move = quantizeIntentMove(intent.value);
      c.moveWriter = entry.id;
      // The second axis (a 3D character's forward input).
      if (intent.y !== undefined) c.moveY = quantizeIntentMove(intent.y);
      return;
    }
    if (intent.kind === 'character_move' || intent.kind === 'character_place' || intent.kind === 'character_enable') {
      // The character controller's channels (one writer each per controller and step); character_move is 3D only,
      // character_place on the 2D plane needs a character with a physics port, character_enable a character.
      if (this.sim.physics3d === undefined && (intent.kind === 'character_move' || player === undefined || (intent.kind === 'character_place' && controllers.resetPort2D() === null))) {
        throw new BehaviorIntentError('behavior_intent_invalid', 'value', intent.kind === 'character_move' ? 'a character_move intent needs a 3D project (physics_dimension 3)' : `a ${intent.kind} intent needs a character (a controller)${intent.kind === 'character_place' ? ' with physics' : ''}`);
      }
      const c = channels!;
      const writer = c.characterWriters.get(intent.kind);
      if (writer !== undefined) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_writer', `${intent.kind} already committed by "${writer}" and "${entry.id}"`);
      }
      this.bump();
      c.characterWriters.set(intent.kind, entry.id);
      if (intent.kind === 'character_move') c.characterMove = { x: intent.x, z: intent.z, run: intent.run === true };
      else if (intent.kind === 'character_place') {
        c.characterPlace = { x: intent.position[0], y: intent.position[1], z: intent.position[2] };
        if (player !== undefined) this.host.placement.of(player)?.placeFacing(intent.facing);
      }
      else this.host.director.noteEnabled(player, (c.characterEnabled = intent.enabled));
      return;
    }
    if (intent.kind === 'respawn') {
      // The respawn intent is ctx.lifecycle's respawn (at the active spawn, else where the character started).
      this.bump();
      this.host.lifecycle.respawn(undefined, player);
      return;
    }
    if (intent.kind === 'control_jump') {
      const c = channels!;
      if (c.jump !== null) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_writer', `control_jump already committed by "${c.jumpWriter}" and "${entry.id}"`);
      }
      this.bump();
      c.jump = intent.value;
      c.jumpWriter = entry.id;
      return;
    }
    if (!ownerSetOf(entry).has(intent.entityId)) {
      throw new BehaviorIntentError('behavior_transform_forbidden', 'not_owner', `entity "${intent.entityId}" is not owned by module "${entry.id}"`);
    }
    const transform = this.sim.curr.get(intent.entityId);
    if (transform === undefined) {
      throw new BehaviorIntentError('behavior_transform_forbidden', 'not_owner', `entity "${intent.entityId}" does not exist`);
    }
    // The written channels of an entity are bits in one map entry
    // tagged with the step (x/y/z 1/2/4, rotation 8, scale 16): no key strings per intent.
    const axes = this.intents.axes;
    const tag = this.intents.axesTag * 64;
    const stored = axes.get(intent.entityId);
    const have = stored !== undefined && stored >= tag && stored < tag + 64 ? stored - tag : 0;
    // A quaternion or a facing is a rotation write too (one form per intent).
    const turns = intent.quaternion !== undefined || intent.facing !== undefined;
    if (intent.kind === 'pose') {
      if ((intent.rotation !== undefined || turns) && (have & 8) !== 0) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a rotation write to "${intent.entityId}" in this step`);
      }
      if (intent.scale !== undefined && (have & 16) !== 0) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a scale write to "${intent.entityId}" in this step`);
      }
      this.bump();
      let bits = 0;
      if (intent.rotation !== undefined) {
        const rad = Math.PI / 360; // half-angle per degree
        const y = (intent.rotation.yaw ?? 0) * rad;
        const x = (intent.rotation.pitch ?? 0) * rad;
        const z = (intent.rotation.roll ?? 0) * rad;
        // q = qYaw · qPitch · qRoll
        const cy = Math.cos(y);
        const sy = Math.sin(y);
        const cx = Math.cos(x);
        const sx = Math.sin(x);
        const cz = Math.cos(z);
        const sz = Math.sin(z);
        // qYaw · qPitch as [x, y, z, w]
        const qx = cy * sx;
        const qy = sy * cx;
        const qz = -sy * sx;
        const qw = cy * cx;
        transform.rotation[0] = qx * cz + qy * sz;
        transform.rotation[1] = qy * cz - qx * sz;
        transform.rotation[2] = qw * sz + qz * cz;
        transform.rotation[3] = qw * cz - qz * sz;
        bits |= 8;
      } else if (turns) {
        writeRotationForm(transform.rotation, intent);
        bits |= 8;
      }
      if (intent.scale !== undefined) {
        const sc = intent.scale;
        if (typeof sc === 'number') {
          transform.scale[0] = sc;
          transform.scale[1] = sc;
          transform.scale[2] = sc;
        } else {
          transform.scale[0] = sc[0];
          transform.scale[1] = sc[1];
          transform.scale[2] = sc[2];
        }
        bits |= 16;
      }
      axes.set(intent.entityId, tag + (have | bits));
      return;
    }
    const position = intent.position;
    let bits = 0;
    for (const axis in position) {
      const bit = axis === 'x' ? 1 : axis === 'y' ? 2 : axis === 'z' ? 4 : 0;
      if (bit === 0) continue;
      if ((have & bit) !== 0) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a write to "${intent.entityId}".${axis} in this step`);
      }
      bits |= bit;
    }
    if (turns) {
      if ((have & 8) !== 0) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a rotation write to "${intent.entityId}" in this step`);
      }
      bits |= 8;
    }
    this.bump();
    if ((bits & 1) !== 0) transform.position[0] = position.x as number;
    if ((bits & 2) !== 0) transform.position[1] = position.y as number;
    if ((bits & 4) !== 0) transform.position[2] = position.z as number;
    if (turns) writeRotationForm(transform.rotation, intent);
    axes.set(intent.entityId, tag + (have | bits));
    // Frozen once here; every `ctx.intents` view shares it.
    this.intents.transformWrites.push(Object.freeze({
      moduleId: entry.id,
      entityId: intent.entityId,
      position: Object.freeze({ ...intent.position }),
    }));
  }

  /** The per-step intent cap, then the cumulative count. */
  private bump(): void {
    if (this.intents.count + 1 > INTENT_LIMITS.perStep) {
      const limit = this.stepLimit();
      if (this.intents.count + 1 > limit) {
        throw new BehaviorIntentError('behavior_intent_limit', 'per_step', `more than ${limit} intents were committed in one step`);
      }
    }
    this.intents.count += 1;
    this.commitCount += 1;
    this.version += 1;
  }

  /**
   * The per-step intent cap scales with the live behavior
   * instances — `max(INTENT_LIMITS.perStep, perInstancePerStep × instances)` —
   * so every instance may use its own bound in the same step (hundreds of
   * moving objects), while the floor keeps every run the fixed cap of 64
   * accepted valid. Instances come and go only with entities, so the count is
   * re-read when the entity order changes.
   */
  private stepLimit(): number {
    if (this.limitOrder !== this.sim.order) {
      let instances = 0;
      for (const entry of this.sim.entries) {
        const probe = entry.instance as { behaviorDiagnostics?: () => { instanceCount?: number } };
        if (typeof probe.behaviorDiagnostics !== 'function') continue;
        try {
          const n = probe.behaviorDiagnostics().instanceCount;
          if (typeof n === 'number' && Number.isInteger(n) && n > 0) instances += n;
        } catch {
          /* a failing diagnostics read counts no instances */
        }
      }
      this.limit = Math.max(INTENT_LIMITS.perStep, INTENT_LIMITS.perInstancePerStep * instances);
      this.limitOrder = this.sim.order;
    }
    return this.limit;
  }
}
