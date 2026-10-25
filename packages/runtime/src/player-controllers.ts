/**
 * The player controllers of a game: every object with a `controller`
 * component, in the snapshot's entity order. Several may share one view
 * (local co-op): each steps with its own input — its controller's actions —
 * and owns its own physics body, a character of the physics port (the first
 * controller is the port's first character, the others its further
 * `characters`, named by their object). A call that names no controller
 * means the first (index 0), so a game with one player works as it always did.
 * A game may start without one: a scene that brings a player controller
 * adds it while the game runs (`add`), a further character of the port from
 * then on.
 *
 * This module holds what the runtime keeps per controller between steps (the
 * last physics result, the fall speed, scripts' impulses, the staged
 * moves) and runs the physics phase for all of them: every controller's move
 * is staged on the port, the port steps once, and each result is checked and
 * committed to its controller's transform.
 */
import { controllerActionsOf, controllerMovementOf, planeLockOf } from '@thirdlight/project-model';

import { actionPhase, type ActionFrame } from './actions';
import { clipMessage, EngineFailure } from './errors';
import { DuplicateMoveError, PhaseViolationError } from './guard';
import {
  validateCharacterMoveResult3D,
  type CharacterMoveResult3D,
  type CharacterState3D,
  type PhysicsPort3D,
  type PhysicsPlane,
  type PhysicsVec3,
  type Vec2,
} from './ports';
import type { EntityV3 } from '@thirdlight/project-model';
import { character3DOf, character3DPhysicsOf } from './scene-set';
import type { GameplaySettings, SimulationPhase, TransformState } from './types';

/** A physics port throw/validation failure (fail-stop `physics_port_error`). */
export class PhysicsPortFailure extends EngineFailure {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PhysicsPortFailure';
    this.reason = reason;
  }
}

/** The ids of the player controllers among `entities`, in their order (the first is index 0). */
export function controllerIdsOf(entities: readonly { id: string; components?: unknown }[]): string[] {
  const out: string[] = [];
  for (const e of entities) if ((e.components as { controller?: unknown } | undefined)?.controller !== undefined) out.push(e.id);
  return out;
}

/** What the runtime keeps per player controller between steps. */
interface ControllerState {
  readonly id: string;
  /** The port's name for its body (undefined: the first character). */
  readonly portId: string | undefined;
  /** The input actions it reads: move, jump, and the climb action (null: the move action). */
  readonly actions: { readonly move: string; readonly jump: string; readonly climb: string | null };
  /** Its step-up height and ground snap (the result check allows them). */
  readonly climb3D: { stepHeight: number; groundSnap: number };
  last3D: CharacterMoveResult3D | undefined;
  /** Its vertical speed under gravity while no module staged a move (m/s). */
  fallSpeed3d: number;
  /** The velocity (m/s) scripts' impulses add at its next controller phase (null: none). */
  impulse: [number, number, number] | null;
  /** The plane its character is locked to (null: free). */
  plane: PhysicsPlane | null;
  /** The port holds its character still (outside the loaded collision). */
  suspended: boolean;
}

/** What the controllers read from and ask of the runtime. */
export interface PlayerControllersHost {
  readonly hz: number;
  readonly settings: GameplaySettings;
  /** The physics port (absent: a game without physics; the controllers' moves go nowhere). */
  readonly physics3d: PhysicsPort3D | undefined;
  /** The live transforms (the runtime may swap the map). */
  curr(): Map<string, TransformState>;
  currentPhase(): SimulationPhase | undefined;
  /** The motion of what a controller stands on this step (and a mover's push). */
  carry3D(id: string): readonly [number, number, number];
  /** Cells written this step collide in this step's sweep (the block layers' colliders on the port). */
  flushCollision(): void;
  /** One more physics step ran. */
  countStep(): void;
  /** A controller's 3D module status (on, climbing, its yaw), or null. */
  status3D(id: string): { enabled?: unknown; climbing?: unknown; yaw?: unknown } | null;
  /** A controller was placed (its face-movement models forget their last position). */
  placed(id: string): void;
  /** Whether a controller's character is outside the loaded collision this step (it stands still, its state kept). */
  suspended?(id: string): boolean;
}

export class PlayerControllers {
  /** The controller objects, in snapshot order then as they were added (index 0 is the one a call without an object means). */
  private list: readonly string[] = Object.freeze([]);
  /** Every input action a controller reads (a game mode that switches gameplay off holds them all). */
  private names: readonly string[] = Object.freeze([]);
  private readonly byId = new Map<string, ControllerState>();
  /** The moves staged in this step's controller phase. */
  private readonly staged3d = new Map<string, PhysicsVec3>();

  constructor(
    private readonly host: PlayerControllersHost,
    ids: readonly string[],
    entities: readonly EntityV3[],
  ) {
    // The port made the start set's players: the first is its own character, the others further ones.
    ids.forEach((id, index) => this.register(id, (entities.find((e) => e.id === id)?.components as { controller?: unknown } | undefined)?.controller, index === 0 ? undefined : id));
  }

  /** The controller objects, in snapshot order then as they were added (index 0 is the one a call without an object means). */
  get ids(): readonly string[] {
    return this.list;
  }

  /** Every input action a controller reads (a game mode that switches gameplay off holds them all). */
  get actionNames(): readonly string[] {
    return this.names;
  }

  private register(id: string, controller: unknown, portId: string | undefined): void {
    const a = controllerActionsOf(controller);
    const climb = controllerMovementOf(controller).climbAction;
    const c3 = character3DPhysicsOf(controller, this.host.settings.max_slope_climb_deg);
    this.byId.set(id, {
      id,
      portId,
      actions: Object.freeze({ move: a.move, jump: a.jump, climb }),
      climb3D: { stepHeight: c3.stepHeight, groundSnap: c3.groundSnap },
      last3D: undefined,
      fallSpeed3d: 0,
      impulse: null,
      plane: planeLockOf(controller),
      suspended: false,
    });
    this.list = Object.freeze([...this.list, id]);
    this.names = Object.freeze([...new Set([...this.names, a.move, a.jump, ...(climb !== null ? [climb] : [])])]);
  }

  /**
   * A player controller that arrived with a scene: the
   * port makes its character where its object is (the same character a world
   * made with it at the start would hold), and it steps with the others from
   * the next physics phase. False when it is a player already. Throws a port
   * failure (a port that cannot add one, or refused it).
   */
  add(entity: EntityV3): boolean {
    if (this.byId.has(entity.id)) return false;
    const port = this.host.physics3d;
    try {
      if (typeof port?.addCharacter !== 'function') throw new PhysicsPortFailure('threw', `player controller "${entity.id}" arrived, but ${port === undefined ? 'the game has no physics port' : 'the physics port cannot add a character'}`);
      port.addCharacter(character3DOf(entity, this.host.settings));
    } catch (e) {
      throw e instanceof PhysicsPortFailure ? e : new PhysicsPortFailure('threw', `physics port addCharacter("${entity.id}") threw: ${messageOf(e)}`);
    }
    this.register(entity.id, (entity.components as { controller?: unknown }).controller, entity.id);
    // The port made it on its plane: its object starts there too.
    this.snapToPlane(entity.id);
    return true;
  }

  /** A controller's plane (null: free, or no such controller). */
  planeOf(id: string): PhysicsPlane | null {
    return this.byId.get(id)?.plane ?? null;
  }

  /** A controller's object put onto its character's plane (its coordinate along the normal set to the plane's). */
  private snapToPlane(id: string): void {
    const plane = this.byId.get(id)?.plane;
    const t = this.host.curr().get(id);
    if (plane === null || plane === undefined || t === undefined) return;
    t.position[plane.axis === 'x' ? 0 : 2] = plane.origin;
  }

  /**
   * Lock a controller's character to a plane, or free it (null), at a
   * step boundary: its body and its object snap onto the plane (a
   * placement: its face-movement models forget where they were); its speed
   * along the normal goes with the controller module's next move, which
   * keeps to the plane. False for an unknown controller or without a port.
   */
  setPlane(id: string, plane: PhysicsPlane | null): boolean {
    const port = this.host.physics3d;
    const c = this.byId.get(id);
    if (port === undefined || c === undefined) return false;
    if (typeof port.setCharacterPlane !== 'function') throw new PhysicsPortFailure('threw', 'the physics port cannot lock a character to a plane');
    let at: PhysicsVec3;
    try {
      at = port.setCharacterPlane(plane, c.portId);
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port setCharacterPlane() threw: ${messageOf(e)}`);
    }
    c.plane = plane;
    if (plane === null) return true;
    const t = this.host.curr().get(id);
    if (t !== undefined) {
      t.position[0] = at.x;
      t.position[1] = at.y;
      t.position[2] = at.z;
    }
    this.host.placed(id);
    return true;
  }

  /**
   * A player whose object left the game for good (a destroyed spawned copy;
   * its id never comes back): its character leaves the physics world, and
   * the next player becomes the first. False when it is no player. Throws a
   * port failure.
   */
  remove(id: string): boolean {
    const c = this.byId.get(id);
    if (c === undefined) return false;
    if (c.portId !== undefined) {
      const port = this.host.physics3d;
      try {
        port?.removeCharacter?.(c.portId);
      } catch (e) {
        throw new PhysicsPortFailure('threw', `physics port removeCharacter("${id}") threw: ${messageOf(e)}`);
      }
    }
    this.byId.delete(id);
    this.staged3d.delete(id);
    this.list = Object.freeze(this.list.filter((x) => x !== id));
    this.names = Object.freeze([...new Set([...this.byId.values()].flatMap((x) => [x.actions.move, x.actions.jump, ...(x.actions.climb !== null ? [x.actions.climb] : [])]))]);
    return true;
  }

  /** The first controller (what a call that names none means), or undefined without one. */
  get first(): string | undefined {
    return this.ids[0];
  }

  /** Whether an object is a player controller. */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The controller a call names (absent or empty: the first); undefined: not a controller. */
  resolve(id: string | undefined): string | undefined {
    if (id === undefined || id === '') return this.first;
    return this.byId.has(id) ? id : undefined;
  }

  /** The port's name for a controller's body (undefined: the first character). */
  portId(id: string): string | undefined {
    return this.byId.get(id)?.portId;
  }

  /** The input actions a controller reads. */
  actionsOf(id: string): { readonly move: string; readonly jump: string; readonly climb: string | null } | undefined {
    return this.byId.get(id)?.actions;
  }

  /** A controller's last physics result, or undefined before its first step. */
  result(id: string): CharacterMoveResult3D | undefined {
    return this.byId.get(id)?.last3D;
  }

  /** Whether a controller stands on something (true before its first step: it starts at rest). */
  grounded(id: string): boolean {
    return this.result(id)?.grounded ?? true;
  }

  /** The collider a controller stands on, or null. */
  groundEntityId(id: string): string | null {
    return this.result(id)?.groundEntityId ?? null;
  }

  /** A controller's last applied move (per step) and the way it faces (degrees). */
  lastMotion(id: string): { applied?: { x: number; y: number; z?: number }; facing?: number } {
    const c = this.byId.get(id);
    if (c === undefined) return {};
    const state = this.characterState(id);
    return { ...(c.last3D !== undefined ? { applied: c.last3D.applied } : {}), ...(state !== undefined ? { facing: state.facing } : {}) };
  }

  // ---- impulses ---------------------------------------------------------------------------

  /** Add a script's impulse (m/s) for a controller's next controller phase. */
  addImpulse(id: string, v: readonly [number, number, number]): void {
    const c = this.byId.get(id);
    if (c === undefined) return;
    const a = c.impulse ?? [0, 0, 0];
    c.impulse = [a[0] + v[0], a[1] + v[1], a[2] + v[2]];
  }

  /** Replace a controller's waiting impulse (a save's velocity). */
  setImpulse(id: string, v: [number, number, number]): void {
    const c = this.byId.get(id);
    if (c !== undefined) c.impulse = v;
  }

  /** A controller's waiting impulse, or null. */
  impulseOf(id: string): readonly [number, number, number] | null {
    return this.byId.get(id)?.impulse ?? null;
  }

  /** The impulses reached the controllers (or a run starts over): none waits. Returns whether one did. */
  clearImpulses(): boolean {
    let any = false;
    for (const c of this.byId.values()) {
      if (c.impulse !== null) any = true;
      c.impulse = null;
    }
    return any;
  }

  // ---- the controller and physics phases ---------------------------------------------------------

  /** A module stages a controller's move (controller phase only; once per controller and step). */
  stage(entityId: string, delta: unknown): void {
    if (this.host.currentPhase() !== 'controller') {
      throw new PhaseViolationError('stageCharacterMove is callable only in the controller phase');
    }
    if (typeof entityId !== 'string' || !this.host.curr().has(entityId)) {
      throw new Error(`unknown character entity ${JSON.stringify(String(entityId))}`);
    }
    if (this.staged3d.has(entityId)) {
      throw new DuplicateMoveError(`entity "${entityId}" already staged a move in this step`);
    }
    if (!isFiniteVec2(delta)) {
      throw new Error('a staged character move must be a finite { x, y }');
    }
    const c = this.byId.get(entityId);
    // z optional: a module written for the plane moves in it.
    const z = (delta as { z?: unknown }).z;
    // A player controller moves with what it stands on (and a mover's push).
    const c3 = c !== undefined ? this.host.carry3D(entityId) : NO_CARRY3;
    // Lifted by what it stands on, its own fall is cancelled — the port poses the
    // movers after the sweep, so a grounded character's small fall would end inside the risen platform.
    const ownY = c3[1] > 0 && delta.y < 0 ? 0 : delta.y;
    const moved3 = { x: delta.x + c3[0], y: ownY + c3[1], z: (typeof z === 'number' && Number.isFinite(z) ? z : 0) + c3[2] };
    this.staged3d.set(entityId, moved3);
    this.host.physics3d?.stageCharacterMove(moved3, c?.portId);
  }

  /** Drop every staged move (a step ended, or the runtime is disposed). */
  clearStaged(): void {
    if (this.staged3d.size > 0) this.staged3d.clear();
  }

  /** The physics phase (runtime, not a module): one validated port step for every controller (none without a port). */
  runPhysics(): void {
    if (this.host.physics3d !== undefined) this.runPhysics3D(this.host.physics3d);
  }

  /**
   * The physics phase — one validated `port.step()`. A
   * character falls under the project's gravity (`gravity_y` along Y, capped
   * at `max_fall_speed`) and rests on what it lands on (its fall speed is
   * zeroed while grounded); a move a module staged in the controller phase
   * replaces the fall. Walking, jumping and turning are the controller's.
   * The full position (x, y and z) is committed to each controller's transform.
   */
  runPhysics3D(port: PhysicsPort3D): void {
    // Cells written this step collide in this step's sweep.
    this.host.flushCollision();
    const curr = this.host.curr();
    const dt = 1 / this.host.hz;
    const plan = this.ids.map((id) => {
      const c = this.byId.get(id)!;
      const t = curr.get(id);
      const previous: PhysicsVec3 = t ? { x: t.position[0], y: t.position[1], z: t.position[2] } : { x: 0, y: 0, z: 0 };
      // Outside the loaded collision: no gravity, no move, no carry; its fall speed and last result wait for the ground.
      const suspended = this.host.suspended?.(id) === true;
      if (suspended !== c.suspended) {
        port.suspendCharacter?.(suspended, c.portId);
        c.suspended = suspended;
      }
      if (suspended) return { c, t, previous, requested: null };
      let requested = this.staged3d.get(id);
      // A controller whose object is not in the game (its scene is not loaded) keeps its body where it is.
      if (requested === undefined && t === undefined && c.portId !== undefined) return { c, t, previous, requested: null };
      if (requested === undefined) {
        const grounded = c.last3D?.grounded === true;
        c.fallSpeed3d = grounded ? 0 : Math.max(this.host.settings.max_fall_speed, c.fallSpeed3d + this.host.settings.gravity_y * dt);
        // Plus the platform it stands on (a mover's or script-driven collider's motion) and a mover's push.
        const c3 = this.host.carry3D(id);
        requested = { x: c3[0], y: c.fallSpeed3d * dt + c3[1], z: c3[2] };
        port.stageCharacterMove(requested, c.portId);
      }
      return { c, t, previous, requested };
    });
    // A world without a character (colliders for queries and movers): nothing falls.
    if (this.ids.length === 0) port.stageCharacterMove({ x: 0, y: 0, z: 0 });
    let raw: unknown;
    this.host.countStep();
    try {
      raw = port.step();
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port step() threw: ${messageOf(e)}`);
    }
    plan.forEach(({ c, t, previous, requested }) => {
      if (requested === null) return;
      const result = c.portId === undefined ? raw : port.lastResultOf?.(c.id);
      const check = validateCharacterMoveResult3D(result, previous, requested, c.climb3D);
      if (!check.ok) throw new PhysicsPortFailure('result', `physics port returned an invalid result${c.portId === undefined ? '' : ` for "${c.id}"`}: ${check.failure.detail}`);
      c.last3D = check.result;
      // A landing (or a head bump) ends the fall; the next step starts from rest.
      if (check.result.grounded || check.result.contacts.head) c.fallSpeed3d = 0;
      if (t) {
        t.position[0] = check.result.position.x;
        t.position[1] = check.result.position.y;
        t.position[2] = check.result.position.z;
      }
    });
    this.clearStaged();
  }

  /**
   * A player controller whose jump is pressed with down held while it
   * stands on a one-way platform drops through it (its jump reads as
   * released this step). Down is its climb
   * action's (else the `navigate` action's) y below −0.5.
   */
  dropThrough(action: ActionFrame, isOneWay: (entityId: string | null) => boolean, steps: number): ActionFrame {
    let out = action;
    for (const id of this.ids) {
      const a = this.byId.get(id)!.actions;
      if (actionPhase(action, a.jump) !== 'pressed' || (action.actions?.[a.climb ?? 'navigate']?.y ?? 0) >= -0.5) continue;
      if (!isOneWay(this.groundEntityId(id))) continue;
      this.host.physics3d?.dropThrough?.(steps, this.portId(id));
      out = { ...out, actions: { ...out.actions, [a.jump]: { v: 0, p: 'none' } } };
    }
    return out;
  }

  // ---- placement -------------------------------------------------------------------------

  /** Put a controller at an origin (the port's clearance rules), from rest. */
  place3D(id: string, x: number, y: number, z: number): void {
    const port = this.host.physics3d;
    const c = this.byId.get(id);
    if (port === undefined || c === undefined) return;
    if (typeof port.placeCharacter !== 'function') throw new PhysicsPortFailure('threw', 'the physics port cannot place the character');
    // A character on a plane is placed on it (the port does the same).
    if (c.plane?.axis === 'x') x = c.plane.origin;
    else if (c.plane?.axis === 'z') z = c.plane.origin;
    try {
      port.placeCharacter({ x, y, z }, c.portId);
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port placeCharacter() threw: ${messageOf(e)}`);
    }
    this.host.placed(id);
    const t = this.host.curr().get(id);
    if (t !== undefined) {
      t.position[0] = x;
      t.position[1] = y;
      t.position[2] = z;
    }
    c.last3D = undefined;
    c.fallSpeed3d = 0;
  }

  /**
   * The start of a run, the first and every restarted one alike: every
   * controller whose object is in the game starts where its transform now
   * says (a restart restored the authored one), from rest, holding nothing of
   * the last run (its last result, fall speed, impulse or staged move), in a
   * physics world rebuilt from the colliders it holds with the bodies there.
   * A world's query structures keep the history of what was added and moved
   * in it, and that history decides ties in a sweep (a body on the seam of
   * two block chunks went another way in the first run than after a
   * restart). A port without a rebuild places each body. Throws a port failure.
   */
  startRun(): void {
    this.clearImpulses();
    this.clearStaged();
    const curr = this.host.curr();
    const port = this.host.physics3d;
    const rebuild = typeof port?.restartWorld === 'function';
    const origins: { characterId?: string; position: { x: number; y: number; z: number } }[] = [];
    for (const id of this.ids) {
      const c = this.byId.get(id)!;
      c.last3D = undefined;
      c.fallSpeed3d = 0;
      const t = curr.get(id);
      if (t === undefined) continue;
      // A character on a plane starts on it.
      if (port !== undefined) this.snapToPlane(id);
      const [x, y, z] = [t.position[0], t.position[1], t.position[2]];
      if (!rebuild) {
        this.place3D(id, x, y, z);
        continue;
      }
      // The rebuilt world makes the body there: placing it first would only move it in the old world.
      origins.push({ ...(c.portId !== undefined ? { characterId: c.portId } : {}), position: { x, y, z } });
      this.host.placed(id);
    }
    if (!rebuild) return;
    try {
      port!.restartWorld!(origins);
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port restartWorld() threw: ${messageOf(e)}`);
    }
  }

  /**
   * A timeline moves a controller: its body goes with it, from rest.
   * Returns where it went (on its plane, if it has one), or null when it is
   * no controller (or the game has no physics).
   */
  moveWithTimeline3D(id: string, position: readonly number[]): [number, number, number] | null {
    const port = this.host.physics3d;
    const c = this.byId.get(id);
    if (port === undefined || c === undefined || typeof port.placeCharacter !== 'function') return null;
    const at: [number, number, number] = [position[0]!, position[1]!, position[2]!];
    if (c.plane !== null) at[c.plane.axis === 'x' ? 0 : 2] = c.plane.origin;
    port.placeCharacter({ x: at[0], y: at[1], z: at[2] }, c.portId);
    c.last3D = undefined;
    c.fallSpeed3d = 0;
    return at;
  }

  // ---- reads -----------------------------------------------------------------------------

  /** `ctx.physics.characterState` — a controller after the last step (undefined before it, or for another object). */
  characterState(id: string): CharacterState3D | undefined {
    const c = this.byId.get(id);
    const r = c?.last3D;
    if (this.host.physics3d === undefined || r === undefined) return undefined;
    const status = this.host.status3D(id);
    const yaw = typeof status?.yaw === 'number' ? status.yaw : 0;
    const hz = this.host.hz;
    return Object.freeze({
      position: Object.freeze({ x: r.position.x, y: r.position.y, z: r.position.z }),
      velocity: Object.freeze({ x: r.applied.x * hz, y: r.applied.y * hz, z: r.applied.z * hz }),
      grounded: r.grounded,
      contacts: Object.freeze({ ...r.contacts }),
      supportNormal: Object.freeze({ x: r.supportNormal.x, y: r.supportNormal.y, z: r.supportNormal.z }),
      groundEntityId: r.groundEntityId ?? null,
      enabled: status?.enabled !== false,
      climbing: status?.climbing === true,
      facing: (yaw * 180) / Math.PI,
    });
  }
}

const NO_CARRY3: readonly [number, number, number] = Object.freeze([0, 0, 0]) as unknown as readonly [number, number, number];

function isFiniteVec2(v: unknown): v is Vec2 {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Vec2).x === 'number' && typeof (v as Vec2).y === 'number' && Number.isFinite((v as Vec2).x) && Number.isFinite((v as Vec2).y);
}

function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' && (e as { message: string }).message !== '') return clipMessage((e as { message: string }).message);
  return clipMessage(String(e));
}
