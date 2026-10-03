/**
 * The loaded objects' animators — one `AnimatorMachine` per entity with an
 * `animator` component — and the script API over them (`ctx.animators`).
 *
 * Stepped once per fixed step by the runtime. A player character's
 * animators (a controller's object and its children; each player its own)
 * get `speed` (horizontal, m/s), `grounded`, `velocityY` and the `landed`
 * trigger from that character's committed motion when their controller has
 * those parameters. An animator's start time is
 * its component's `startTime`, or with `randomStart` a number drawn from the
 * game's seed and the object's id, so a replay, a reload and an export start
 * every copy at the same place.
 *
 * A look-at constraint (`lookAt` on the component) steps after its machine:
 * the target's world position is brought into the model's space and
 * compared with the head bone as the clips pose it (the model's rig, read
 * from its file into the build), and the head chain turns toward it at the
 * turn speed (`look-at.ts`). Its turn is part of the pose, so the renderer
 * and the sockets apply it after the clips.
 *
 * Pure and deterministic (no clock, no `Math.random`).
 */
import type { EntityV3 } from '@thirdlight/project-model';

import { AnimatorMachine, type AnimatorControllerLike, type AnimatorPose } from './animator';
import { LookAtState, anglesToward, transformPoint, type LookAtLike } from './look-at';
import { seededUnit } from './random';
import { invertMat4, mat4, type Mat4, type RigPoser } from './rig-pose';
import type { TransformState } from './types';
import type { AnimatorEventRecord, BehaviorAnimatorControl, BehaviorAnimatorHandle } from './types-behavior-world';

/** What the animators read from the runtime. */
export interface AnimatorSystemHost {
  /** Fixed steps per second. */
  readonly hz: number;
  /** The run seed (the project's `random_seed`). */
  readonly seed: number;
  /** The player characters the locomotion parameters describe (the controllers' objects). */
  characterIds(): readonly string[];
  /** An entity's committed transform now. */
  transformOf(id: string): TransformState | undefined;
  /** Whether a player character stands on the ground (its controller's last move). */
  grounded(id: string): boolean;
  /** Switched-off objects (their animators hold their pose). */
  inactive(): ReadonlySet<string>;
  stepIndex(): number;
  /** The rig of an entity's model (null: no model, or its rig was not read). */
  rigOf(entityId: string): RigPoser | null;
  /** An entity's world matrix (its transform composed up its parents); false when it is not loaded. */
  worldMatrix(entityId: string, out: Mat4): boolean;
  warn(message: string): void;
}

interface AnimatorComponentLike {
  controller: string;
  parameters?: Record<string, number | boolean>;
  startTime?: number;
  randomStart?: boolean;
  lookAt?: LookAtLike;
}

interface Animated {
  machine: AnimatorMachine;
  entity: EntityV3;
  /** The look-at constraint's state (when the component has one). */
  look: LookAtState | null;
}

export class AnimatorSystem {
  private readonly controllers = new Map<string, AnimatorControllerLike>();
  private readonly machines = new Map<string, Animated>();
  /** Parent ids of the loaded entities (the player's model may be a child of the player). */
  private readonly parentOf = new Map<string, string>();
  private fired: readonly AnimatorEventRecord[] = Object.freeze([]);
  /** Each player character's grounding and position a step ago (none after a reset). */
  private readonly motion = new Map<string, { wasGrounded: boolean; lastPos: [number, number, number] | null }>();
  /** `ctx.animators`. */
  readonly control: BehaviorAnimatorControl;

  constructor(
    controllers: readonly AnimatorControllerLike[],
    private readonly host: AnimatorSystemHost,
  ) {
    for (const c of controllers) this.controllers.set(c.controllerId, c);
    this.control = Object.freeze({
      of: (entityId: string): BehaviorAnimatorHandle | null => {
        const rec = this.machines.get(String(entityId));
        if (rec === undefined) return null;
        const m = rec.machine;
        const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);
        const look = rec.look;
        return Object.freeze({
          setLookTarget: (entityId: string | null) => {
            if (look === null || (entityId !== null && (typeof entityId !== 'string' || entityId.length === 0))) return false;
            look.target = entityId;
            return true;
          },
          setLookPoint: (point: readonly [number, number, number]) => {
            if (look === null || !Array.isArray(point) || point.length !== 3 || !point.every((x) => typeof x === 'number' && Number.isFinite(x))) return false;
            look.target = [point[0], point[1], point[2]] as const;
            return true;
          },
          setLookWeight: (weight: number) => {
            if (look === null || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) return false;
            look.weight = weight;
            return true;
          },
          set: (name: string, value: number | boolean) => m.set(String(name), value),
          trigger: (name: string) => m.trigger(String(name)),
          get: (name: string) => m.get(String(name)),
          state: (layer?: number) => m.stateName(typeof layer === 'number' && Number.isInteger(layer) && layer >= 0 ? layer : 0),
          play: (state: string, fade?: number, layer?: number, time?: number) => m.play(String(state), num(fade, 0), typeof layer === 'number' && Number.isInteger(layer) && layer >= 0 ? layer : -1, num(time, 0)),
          // Per-instance playback speed and morph weights.
          setSpeed: (speed: number) => m.setSpeed(speed),
          speed: () => m.speed(),
          setMorph: (name: string, weight: number) => m.setMorph(String(name), weight),
          morph: (name: string) => m.morph(String(name)),
        });
      },
    });
  }

  /** The clip events of the last step (scripts see them this step). */
  get events(): readonly AnimatorEventRecord[] {
    return this.fired;
  }

  get size(): number {
    return this.machines.size;
  }

  /** An entity's machine (timeline keys drive it), or undefined. */
  machine(id: string): AnimatorMachine | undefined {
    return this.machines.get(id)?.machine;
  }

  /** An entity's pose now, or null without an animator. */
  poseOf(id: string): AnimatorPose | null {
    const rec = this.machines.get(id);
    return rec === undefined ? null : this.poseOfRec(rec);
  }

  /** Every loaded animator's pose (the renderer plays these). */
  poses(): ReadonlyMap<string, AnimatorPose> {
    const out = new Map<string, AnimatorPose>();
    for (const [id, rec] of this.machines) out.set(id, this.poseOfRec(rec));
    return out;
  }

  private poseOfRec(rec: Animated): AnimatorPose {
    const pose = rec.machine.pose();
    const look = rec.look?.pose() ?? null;
    return look === null ? pose : { ...pose, look };
  }

  /** Start an animator for every entity of these that has one (and whose controller exists). */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      if (e.parentId !== undefined) this.parentOf.set(e.id, e.parentId);
      const a = (e.components as { animator?: AnimatorComponentLike }).animator;
      if (a === undefined) continue;
      const controller = this.controllers.get(a.controller);
      if (controller === undefined) continue;
      // A random start comes from the game's seed and the object's id: a replay (or a reload) starts it alike.
      const start = a.randomStart === true ? seededUnit(this.host.seed, 'animator-start', e.id) : (a.startTime ?? 0);
      this.machines.set(e.id, { machine: new AnimatorMachine(controller, a.parameters ?? {}, start), entity: e, look: a.lookAt !== undefined ? new LookAtState(a.lookAt) : null });
    }
  }

  remove(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.machines.delete(id);
      this.parentOf.delete(id);
    }
  }

  /** Back to the entry states (a replay or a new run). */
  reset(): void {
    const entities = [...this.machines.values()].map((r) => r.entity);
    this.machines.clear();
    this.add(entities);
    this.fired = Object.freeze([]);
    this.motion.clear();
  }

  /** The player character an object is (or is under), or null. */
  private characterOf(id: string, characters: ReadonlySet<string>): string | null {
    if (characters.size === 0) return null;
    let cur: string | undefined = id;
    for (let depth = 0; cur !== undefined && depth < 64; depth++) {
      if (characters.has(cur)) return cur;
      cur = this.parentOf.get(cur);
    }
    return null;
  }

  /**
   * A player character's motion over the last step: horizontal speed (x and
   * z), vertical velocity, its controller's grounding and whether it landed.
   */
  private characterMotion(id: string): { speed: number; vy: number; grounded: boolean; landed: boolean } {
    let m = this.motion.get(id);
    if (m === undefined) {
      m = { wasGrounded: true, lastPos: null };
      this.motion.set(id, m);
    }
    const t = this.host.transformOf(id);
    const grounded = this.host.grounded(id);
    const landed = grounded && !m.wasGrounded;
    m.wasGrounded = grounded;
    if (t === undefined) return { speed: 0, vy: 0, grounded, landed };
    const p = t.position;
    const last = m.lastPos;
    m.lastPos = [p[0], p[1], p[2]];
    if (last === null) return { speed: 0, vy: 0, grounded, landed };
    const hz = this.host.hz;
    return { speed: Math.hypot(p[0] - last[0], p[2] - last[2]) * hz, vy: (p[1] - last[1]) * hz, grounded, landed };
  }

  /** Advance every animator by one fixed step. */
  step(): void {
    if (this.machines.size === 0) return;
    // Every player character's motion once a step (whether or not one of its animators steps).
    const ids = this.host.characterIds();
    const motions = new Map(ids.map((id) => [id, this.characterMotion(id)]));
    const characters = new Set(ids);
    const fired: AnimatorEventRecord[] = [];
    const dt = 1 / this.host.hz;
    const off = this.host.inactive();
    const stepIndex = this.host.stepIndex();
    for (const [id, rec] of this.machines) {
      const machine = rec.machine;
      // A switched-off object's animator holds its pose.
      if (off.size > 0 && off.has(id)) continue;
      const character = this.characterOf(id, characters);
      if (character !== null) {
        const { speed, vy, grounded, landed } = motions.get(character)!;
        machine.set('speed', speed);
        machine.set('grounded', grounded);
        machine.set('velocityY', vy);
        if (landed) machine.trigger('landed');
      }
      for (const e of machine.step(dt)) fired.push(Object.freeze({ entityId: id, name: e.name, clip: e.clip, stepIndex }));
      if (rec.look !== null) this.stepLook(id, rec.machine, rec.look, dt);
    }
    this.fired = Object.freeze(fired);
  }

  private readonly mWorld = mat4();
  private readonly mInv = mat4();
  private readonly mNode = mat4();
  private readonly warned = new Set<string>();

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key) || this.warned.size > 256) return;
    this.warned.add(key);
    this.host.warn(message);
  }

  /** One look-at step: the angles toward the target from the head as the clips pose it. */
  private stepLook(id: string, machine: AnimatorMachine, look: LookAtState, dt: number): void {
    const c = look.config;
    let weight = look.weight ?? c.weight ?? 1;
    if (c.weightParameter !== undefined) {
      const v = machine.get(c.weightParameter);
      if (v === undefined) this.warnOnce(`param:${id}`, `animator look-at on "${id}": the controller has no parameter "${c.weightParameter}" (its weight reads 0)`);
      weight *= typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    }
    const target = look.target !== undefined ? look.target : (c.target ?? (c.point !== undefined ? ([c.point[0]!, c.point[1]!, c.point[2]!] as const) : null));
    let wanted: { yaw: number; pitch: number } | null = null;
    let world: readonly number[] | null = null;
    if (typeof target === 'string') {
      // A target that is not loaded (yet, or any more) reads as no target: the head turns back.
      if (this.host.worldMatrix(target, this.mWorld)) world = [this.mWorld[12]!, this.mWorld[13]!, this.mWorld[14]!];
    } else if (target !== null) world = target;
    if (world !== null && weight > 0) {
      const rig = this.host.rigOf(id);
      const head = rig?.nodeIndex(c.head.bone) ?? -1;
      if (rig === null || rig === undefined) this.warnOnce(`rig:${id}`, `animator look-at on "${id}": its model's rig is not in the build; the head does not turn`);
      else if (head < 0) this.warnOnce(`bone:${id}`, `animator look-at on "${id}": its model has no bone "${c.head.bone}"; the head does not turn`);
      else if (this.host.worldMatrix(id, this.mWorld)) {
        rig.nodeMatrix(head, machine.pose(), this.mNode);
        invertMat4(this.mInv, this.mWorld);
        wanted = anglesToward([this.mNode[12]!, this.mNode[13]!, this.mNode[14]!], transformPoint(this.mInv, world));
      }
    }
    look.step(wanted, weight, dt);
  }
}
