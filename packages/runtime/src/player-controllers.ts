/**
 * The player controllers of a game: every object with a `controller`
 * component, in the snapshot's entity order. Several may share one view
 * (local co-op): each steps with its own input — its controller's actions —
 * and owns its own physics body, a character of the physics port (the first
 * controller is the port's first character, the others its further
 * `characters`, named by their object). A call that names no controller
 * means the first (index 0), so a game with one player works as it always did.
 *
 * This module holds what the runtime keeps per controller between steps (the
 * last physics result, the 3D fall speed, scripts' impulses, the staged
 * moves) and runs the physics phase for all of them: every controller's move
 * is staged on the port, the port steps once, and each result is checked and
 * committed to its controller's transform.
 */
import { controllerActionsOf, controllerMovementOf } from '@thirdlight/project-model';

import { clipMessage } from './errors';
import { DuplicateMoveError, PhaseViolationError } from './guard';
import {
  validateCharacterMoveResult,
  validateCharacterMoveResult3D,
  type CharacterMoveResult,
  type CharacterMoveResult3D,
  type CharacterState3D,
  type PhysicsPort,
  type PhysicsPort3D,
  type PhysicsResetPort,
  type PhysicsVec3,
  type Vec2,
} from './ports';
import type { EntityV3 } from '@thirdlight/project-model';
import { character3DPhysicsOf } from './scene-set';
import type { GameplaySettings, SimulationPhase, TransformState } from './types';

/** A `PhysicsPort` throw/validation failure (fail-stop `physics_port_error`). */
export class PhysicsPortFailure extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(clipMessage(message));
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
  /** 3D: its step-up height and ground snap (the result check allows them). */
  readonly climb3D: { stepHeight: number; groundSnap: number } | undefined;
  last2D: CharacterMoveResult | undefined;
  last3D: CharacterMoveResult3D | undefined;
  /** 3D: its vertical speed under gravity while no module staged a move (m/s). */
  fallSpeed3d: number;
  /** The velocity (m/s) scripts' impulses add at its next controller phase (null: none). */
  impulse: [number, number, number] | null;
}

/** What the controllers read from and ask of the runtime. */
export interface PlayerControllersHost {
  readonly hz: number;
  readonly settings: GameplaySettings;
  readonly physics: PhysicsPort | undefined;
  readonly physics3d: PhysicsPort3D | undefined;
  /** The live transforms (the runtime may swap the map). */
  curr(): Map<string, TransformState>;
  currentPhase(): SimulationPhase | undefined;
  /** The motion of what a controller stands on this step (and a mover's push). */
  carry2D(id: string): Vec2;
  carry3D(id: string): readonly [number, number, number];
  /** Cells written this step collide in this step's sweep. */
  flushCollision3D(port: PhysicsPort3D): void;
  /** One more physics step ran. */
  countStep(): void;
  /** A controller's 3D module status (on, climbing, its yaw), or null. */
  status3D(id: string): { enabled?: unknown; climbing?: unknown; yaw?: unknown } | null;
  /** A controller was placed (its face-movement models forget their last position). */
  placed(id: string): void;
}

export class PlayerControllers {
  /** The controller objects, in snapshot order (index 0 is the one a call without an object means). */
  readonly ids: readonly string[];
  /** Every input action a controller reads (a game mode that switches gameplay off holds them all). */
  readonly actionNames: readonly string[];
  private readonly byId = new Map<string, ControllerState>();
  /** The moves staged in this step's controller phase (2D, and the plane part of a 3D move). */
  private readonly staged = new Map<string, Vec2>();
  private readonly staged3d = new Map<string, PhysicsVec3>();

  constructor(
    private readonly host: PlayerControllersHost,
    ids: readonly string[],
    entities: readonly EntityV3[],
  ) {
    this.ids = Object.freeze([...ids]);
    const names = new Set<string>();
    ids.forEach((id, index) => {
      const controller = (entities.find((e) => e.id === id)?.components as { controller?: unknown } | undefined)?.controller;
      const a = controllerActionsOf(controller);
      const climb = controllerMovementOf(controller).climbAction;
      names.add(a.move).add(a.jump);
      if (climb !== null) names.add(climb);
      const c3 = host.physics3d !== undefined ? character3DPhysicsOf(controller, host.settings.max_slope_climb_deg) : undefined;
      this.byId.set(id, {
        id,
        portId: index === 0 ? undefined : id,
        actions: Object.freeze({ move: a.move, jump: a.jump, climb }),
        climb3D: c3 !== undefined ? { stepHeight: c3.stepHeight, groundSnap: c3.groundSnap } : undefined,
        last2D: undefined,
        last3D: undefined,
        fallSpeed3d: 0,
        impulse: null,
      });
    });
    this.actionNames = Object.freeze([...names]);
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

  /** A controller's last physics result (its vectors carry z in 3D), or undefined before its first step. */
  result(id: string): CharacterMoveResult | undefined {
    const c = this.byId.get(id);
    if (c === undefined) return undefined;
    return this.host.physics3d !== undefined ? (c.last3D as unknown as CharacterMoveResult | undefined) : c.last2D;
  }

  /** Whether a controller stands on something (true before its first step: it starts at rest). */
  grounded(id: string): boolean {
    return this.result(id)?.grounded ?? true;
  }

  /** The collider a controller stands on, or null. */
  groundEntityId(id: string): string | null {
    return this.result(id)?.groundEntityId ?? null;
  }

  /** A controller's last applied move (per step) and, in 3D, the way it faces (degrees). */
  lastMotion(id: string): { applied?: { x: number; y: number; z?: number }; facing?: number } {
    const c = this.byId.get(id);
    if (c === undefined) return {};
    if (this.host.physics3d === undefined) return c.last2D !== undefined ? { applied: c.last2D.applied } : {};
    const state = this.characterState(id);
    return { ...(c.last3D !== undefined ? { applied: c.last3D.applied } : {}), ...(state !== undefined ? { facing: state.facing } : {}) };
  }

  // ---- impulses ---------------------------------------------------------------------------

  /** Add a script's impulse (m/s) for a controller's next controller phase; the 2D plane drops z. */
  addImpulse(id: string, v: readonly [number, number, number]): void {
    const c = this.byId.get(id);
    if (c === undefined) return;
    const a = c.impulse ?? [0, 0, 0];
    c.impulse = [a[0] + v[0], a[1] + v[1], this.host.physics3d !== undefined ? a[2] + v[2] : 0];
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
    if (this.staged.has(entityId)) {
      throw new DuplicateMoveError(`entity "${entityId}" already staged a move in this step`);
    }
    if (!isFiniteVec2(delta)) {
      throw new Error('a staged character move must be a finite { x, y }');
    }
    const c = this.byId.get(entityId);
    const port3 = this.host.physics3d;
    if (port3 !== undefined) {
      // A 3D move (z optional: a module written for the plane moves in it).
      const z = (delta as { z?: unknown }).z;
      // A player controller moves with what it stands on (and a mover's push).
      const c3 = c !== undefined ? this.host.carry3D(entityId) : NO_CARRY3;
      // Lifted by what it stands on, its own fall is cancelled — the port poses the
      // movers after the sweep, so a grounded character's small fall would end inside the risen platform.
      const ownY = c3[1] > 0 && delta.y < 0 ? 0 : delta.y;
      const moved3 = { x: delta.x + c3[0], y: ownY + c3[1], z: (typeof z === 'number' && Number.isFinite(z) ? z : 0) + c3[2] };
      this.staged.set(entityId, { x: moved3.x, y: moved3.y });
      this.staged3d.set(entityId, moved3);
      port3.stageCharacterMove(moved3, c?.portId);
      return;
    }
    // A player controller moves with the platform it stands on.
    const carry = c !== undefined ? this.host.carry2D(entityId) : NO_CARRY;
    const moved = { x: delta.x + carry.x, y: delta.y + carry.y };
    this.staged.set(entityId, moved);
    this.host.physics?.stageCharacterMove(moved, c?.portId);
  }

  /** Drop every staged move (a step ended, or the runtime is disposed). */
  clearStaged(): void {
    if (this.staged.size > 0) this.staged.clear();
    if (this.staged3d.size > 0) this.staged3d.clear();
  }

  /** The physics phase (runtime, not a module): one validated port step for every controller. */
  runPhysics(): void {
    if (this.host.physics3d !== undefined) {
      this.runPhysics3D(this.host.physics3d);
      return;
    }
    const port = this.host.physics;
    if (!port) return;
    const curr = this.host.curr();
    const before = this.ids.map((id) => {
      const t = curr.get(id);
      return t ? { x: t.position[0], y: t.position[1] } : { x: 0, y: 0 };
    });
    let raw: unknown;
    this.host.countStep();
    try {
      raw = port.step();
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port step() threw: ${messageOf(e)}`);
    }
    this.ids.forEach((id, i) => {
      const c = this.byId.get(id)!;
      // A controller whose object is not in the game (its scene is not loaded) keeps its body where it is.
      if (i > 0 && !curr.has(id)) return;
      const result = i === 0 ? raw : port.lastResultOf?.(id);
      const requested: Vec2 = this.staged.get(id) ?? { x: 0, y: 0 };
      const check = validateCharacterMoveResult(result, before[i]!, requested);
      if (!check.ok) {
        throw new PhysicsPortFailure('result', `physics port returned an invalid result${i === 0 ? '' : ` for "${id}"`}: ${check.failure.detail}`);
      }
      c.last2D = check.result;
      const t = curr.get(id);
      if (t) {
        // Authoritative commit: position.x/position.y only, before any
        // phase-transform module runs.
        t.position[0] = check.result.position.x;
        t.position[1] = check.result.position.y;
      }
    });
    this.clearStaged();
  }

  /**
   * The 3D physics phase — one validated `port.step()`. A
   * character falls under the project's gravity (`gravity_y` along Y, capped
   * at `max_fall_speed`) and rests on what it lands on (its fall speed is
   * zeroed while grounded); a move a module staged in the controller phase
   * replaces the fall. Walking, jumping and turning are the controller's.
   * The full position (x, y and z) is committed to each controller's transform.
   */
  runPhysics3D(port: PhysicsPort3D): void {
    // Cells written this step collide in this step's sweep.
    this.host.flushCollision3D(port);
    const curr = this.host.curr();
    const dt = 1 / this.host.hz;
    const plan = this.ids.map((id) => {
      const c = this.byId.get(id)!;
      const t = curr.get(id);
      const previous: PhysicsVec3 = t ? { x: t.position[0], y: t.position[1], z: t.position[2] } : { x: 0, y: 0, z: 0 };
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
    plan.forEach(({ c, t, previous, requested }, i) => {
      if (requested === null) return;
      const result = i === 0 ? raw : port.lastResultOf?.(c.id);
      const check = validateCharacterMoveResult3D(result, previous, requested, c.climb3D);
      if (!check.ok) throw new PhysicsPortFailure('result', `physics port returned an invalid result${i === 0 ? '' : ` for "${c.id}"`}: ${check.failure.detail}`);
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

  // ---- placement -------------------------------------------------------------------------

  /** Put a 3D controller at an origin (the port's clearance rules), from rest. */
  place3D(id: string, x: number, y: number, z: number): void {
    const port = this.host.physics3d;
    const c = this.byId.get(id);
    if (port === undefined || c === undefined) return;
    if (typeof port.placeCharacter !== 'function') throw new PhysicsPortFailure('threw', 'the 3D physics port cannot place the character');
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
   * Put a 2D-plane controller at an origin, from rest: the port's character
   * is cleared and placed and its transform set (the caller resets its
   * controller module). False without a reset port or for an unknown controller.
   */
  place2D(id: string, x: number, y: number): boolean {
    const port = this.resetPort2D();
    const c = this.byId.get(id);
    if (c === undefined || port === null) return false;
    try {
      port.clearCharacterMotion(c.portId);
      port.placeCharacter({ x, y }, c.portId);
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port placeCharacter() threw: ${messageOf(e)}`);
    }
    this.host.placed(id);
    const t = this.host.curr().get(id);
    if (t !== undefined) {
      t.position[0] = x;
      t.position[1] = y;
    }
    return true;
  }

  /**
   * The start of a run, the first and every restarted one alike: every
   * controller whose object is in the game is put back where its transform
   * now says (a restart restored the authored one), from rest, holding
   * nothing of the last run (its last result, fall speed, impulse or staged
   * move); then the physics world is rebuilt from the colliders it holds,
   * the bodies where they now are. A world's query structures keep the
   * history of what was added and moved in it, and that history decides
   * ties in a sweep (a body on the seam of two block chunks went another way
   * in the first run than after a restart). On the 2D plane without a reset
   * port the bodies stay. Throws a port failure.
   */
  startRun(): void {
    this.clearImpulses();
    this.clearStaged();
    const curr = this.host.curr();
    for (const id of this.ids) {
      const c = this.byId.get(id)!;
      c.last2D = undefined;
      c.last3D = undefined;
      c.fallSpeed3d = 0;
      const t = curr.get(id);
      if (t === undefined) continue;
      const [x, y, z] = [t.position[0], t.position[1], t.position[2]];
      if (this.host.physics3d !== undefined) this.place3D(id, x, y, z);
      else this.place2D(id, x, y);
    }
    try {
      (this.host.physics3d ?? this.host.physics)?.restartWorld?.();
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port restartWorld() threw: ${messageOf(e)}`);
    }
  }

  /** The 2D port narrowed to the reset/clearance surface placements need (null: it has none). */
  resetPort2D(): PhysicsResetPort | null {
    const port = this.host.physics as (PhysicsPort & Partial<PhysicsResetPort>) | undefined;
    if (port === undefined) return null;
    if (typeof port.clearCharacterMotion !== 'function') return null;
    if (typeof port.placeCharacter !== 'function') return null;
    if (typeof port.characterClearance !== 'function') return null;
    return port as PhysicsResetPort;
  }

  /** A timeline moves a 3D controller: its body goes with it, from rest. Returns whether it was one. */
  moveWithTimeline3D(id: string, position: readonly number[]): boolean {
    const port = this.host.physics3d;
    const c = this.byId.get(id);
    if (port === undefined || c === undefined || typeof port.placeCharacter !== 'function') return false;
    port.placeCharacter({ x: position[0]!, y: position[1]!, z: position[2]! }, c.portId);
    c.last3D = undefined;
    c.fallSpeed3d = 0;
    return true;
  }

  // ---- reads -----------------------------------------------------------------------------

  /** `ctx.physics.characterState` — a 3D controller after the last step (undefined in 2D, before it, or for another object). */
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

const NO_CARRY: Vec2 = Object.freeze({ x: 0, y: 0 });
const NO_CARRY3: readonly [number, number, number] = Object.freeze([0, 0, 0]) as unknown as readonly [number, number, number];

function isFiniteVec2(v: unknown): v is Vec2 {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Vec2).x === 'number' && typeof (v as Vec2).y === 'number' && Number.isFinite((v as Vec2).x) && Number.isFinite((v as Vec2).y);
}

function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' && (e as { message: string }).message !== '') return clipMessage((e as { message: string }).message);
  return clipMessage(String(e));
}
