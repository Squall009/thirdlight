/**
 * The loaded objects' animators — one `AnimatorMachine` per entity with an
 * `animator` component — and the script API over them (`ctx.animators`).
 *
 * Stepped once per fixed step by the runtime. The character's animators
 * (the controller's object and its children) get `speed` (horizontal, m/s),
 * `grounded`, `velocityY` and the `landed` trigger from the committed motion
 * when their controller has those parameters. An animator's start time is
 * its component's `startTime`, or with `randomStart` a number drawn from the
 * game's seed and the object's id, so a replay, a reload and an export start
 * every copy at the same place.
 *
 * Pure and deterministic (no clock, no `Math.random`).
 */
import type { EntityV3 } from '@thirdlight/project-model';

import { AnimatorMachine, type AnimatorControllerLike, type AnimatorPose } from './animator';
import { seededUnit } from './random';
import type { TransformState } from './types';
import type { AnimatorEventRecord, BehaviorAnimatorControl, BehaviorAnimatorHandle } from './types-behavior-world';

/** What the animators read from the runtime. */
export interface AnimatorSystemHost {
  /** Fixed steps per second. */
  readonly hz: number;
  /** The run seed (the project's `random_seed`). */
  readonly seed: number;
  /** The character the locomotion parameters describe (the controller's object; '' without one). */
  characterId(): string;
  /** An entity's committed transform now. */
  transformOf(id: string): TransformState | undefined;
  /** Whether the character stands on the ground (its controller's last move). */
  grounded(): boolean;
  /** Switched-off objects (their animators hold their pose). */
  inactive(): ReadonlySet<string>;
  stepIndex(): number;
}

interface AnimatorComponentLike {
  controller: string;
  parameters?: Record<string, number | boolean>;
  startTime?: number;
  randomStart?: boolean;
}

export class AnimatorSystem {
  private readonly controllers = new Map<string, AnimatorControllerLike>();
  private readonly machines = new Map<string, { machine: AnimatorMachine; entity: EntityV3 }>();
  /** Parent ids of the loaded entities (the player's model may be a child of the player). */
  private readonly parentOf = new Map<string, string>();
  private fired: readonly AnimatorEventRecord[] = Object.freeze([]);
  private wasGrounded = true;
  /** The character's position a step ago (null after a reset). */
  private lastPos: [number, number, number] | null = null;
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
        return Object.freeze({
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
    return this.machines.get(id)?.machine.pose() ?? null;
  }

  /** Every loaded animator's pose (the renderer plays these). */
  poses(): ReadonlyMap<string, AnimatorPose> {
    const out = new Map<string, AnimatorPose>();
    for (const [id, { machine }] of this.machines) out.set(id, machine.pose());
    return out;
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
      this.machines.set(e.id, { machine: new AnimatorMachine(controller, a.parameters ?? {}, start), entity: e });
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
    this.wasGrounded = true;
    this.lastPos = null;
  }

  private isCharacterOrChild(id: string): boolean {
    const character = this.host.characterId();
    if (character === '') return false;
    let cur: string | undefined = id;
    for (let depth = 0; cur !== undefined && depth < 64; depth++) {
      if (cur === character) return true;
      cur = this.parentOf.get(cur);
    }
    return false;
  }

  /**
   * The character's motion over the last step: horizontal speed (x and z),
   * vertical velocity and the controller's grounding.
   */
  private characterMotion(): { speed: number; vy: number; grounded: boolean } {
    const id = this.host.characterId();
    const t = id !== '' ? this.host.transformOf(id) : undefined;
    const grounded = this.host.grounded();
    if (t === undefined) return { speed: 0, vy: 0, grounded };
    const p = t.position;
    const last = this.lastPos;
    this.lastPos = [p[0], p[1], p[2]];
    if (last === null) return { speed: 0, vy: 0, grounded };
    const hz = this.host.hz;
    return { speed: Math.hypot(p[0] - last[0], p[2] - last[2]) * hz, vy: (p[1] - last[1]) * hz, grounded };
  }

  /** Advance every animator by one fixed step. */
  step(): void {
    if (this.machines.size === 0) return;
    const { speed, vy, grounded } = this.characterMotion();
    const landed = grounded && !this.wasGrounded;
    this.wasGrounded = grounded;
    const fired: AnimatorEventRecord[] = [];
    const dt = 1 / this.host.hz;
    const off = this.host.inactive();
    const stepIndex = this.host.stepIndex();
    for (const [id, { machine }] of this.machines) {
      // A switched-off object's animator holds its pose.
      if (off.size > 0 && off.has(id)) continue;
      if (this.isCharacterOrChild(id)) {
        machine.set('speed', speed);
        machine.set('grounded', grounded);
        machine.set('velocityY', vy);
        if (landed) machine.trigger('landed');
      }
      for (const e of machine.step(dt)) fired.push(Object.freeze({ entityId: id, name: e.name, clip: e.clip, stepIndex }));
    }
    this.fired = Object.freeze(fired);
  }
}
