/**
 * The gameplay building blocks, run by the runtime every fixed
 * step (deterministic; a replay plays the same):
 *
 * - movers (and doors: movers that start on a signal) follow their waypoints;
 *   a mover with a collider is a kinematic platform, and the player standing
 *   on it moves with it;
 * - triggers and switches emit signals (seen by movers and scripts in the
 *   next step);
 * - the generic primitives (health, collectibles, patrols, hitboxes) run in
 *   `primitives.ts`.
 *
 * The blocks test the character (the controller's object) in both
 * dimensions.
 *
 * Boxes (triggers, switches) are centred on their entity.
 *
 * A trigger may be a circle (centred on its entity, tested
 * against the player's capsule itself), may emit its signal every step while
 * the player is inside (`mode: "stay"`), and records `enter`/`exit` events
 * that the scripts owning it read in the next step (`ctx.events`).
 *
 * In a 3D project (`host.physics3d`) movers are posed on the 3D
 * port (their full position and their entity's rotation) and carry and push
 * the player in 3D; colliders scripts drive are posed with them; triggers are
 * 3D volumes — a box (turned with its entity), a sphere or a capsule standing
 * along its entity's Y — tested exactly against the character's capsule. The
 * 2D plane's switches are refused in 3D by the project model, so the 3D step
 * runs movers and triggers.
 */
import type { ActionFrame } from './actions';
import type { ColliderShape3D, KinematicPose3D, PhysicsPort, PhysicsPort3D, Vec2 } from './ports';
import { BLOCK_DEFAULTS, SWITCH_DEFAULT_ACTION, type EntityV3 } from '@thirdlight/project-model';
import type { BehaviorMessage, PlayerCapsule, PrimitiveEventRecord, TransformState, TriggerEventRecord } from './types';
import { capsuleHalfTotal, colliderRotationZ, colliderShape3DOf } from './scene-set';
import { rotate3, segmentBoxDistance2, segmentPointDistance2, segmentSegmentDistance2, sub3, type V3 } from './geometry3';
import { advancePath, Primitives, reversePath, type PathState } from './primitives';

/**
 * Script messages per step (`ctx.messages.send`): far above what
 * game logic sends in one step, small enough to bound the per-step lists.
 */
export const MAX_MESSAGES_PER_STEP = 256;
/** The longest signal name (`ctx.signals.emit` ignores longer ones). */
export const MAX_SIGNAL_NAME = 64;

/**
 * The mover's tuning is its data; `BLOCK_DEFAULTS` are the values
 * used when a field is absent (the constants every project played with before).
 */
const D = BLOCK_DEFAULTS;

type Vec3 = [number, number, number];

/** The path fields (points, lengths, speed, mode, wait, easing and the position along it) are shared with the waypoint patrol. */
interface Mover extends PathState {
  id: string;
  startOn: string | null;
  /** The signals that hold it, toggle it and turn it around (null: none). */
  stopOn: string | null;
  toggleOn: string | null;
  reverseOn: string | null;
  /** The authored speed and moving flag (a new run restores them; scripts write `speed` and `active`). */
  authoredSpeed: number;
  authoredActive: boolean;
  // state
  started: boolean;
  /** False — it holds where it is (still posed and solid). */
  active: boolean;
  /** The box collider's half extents (a mover without a box or polygon collider never pushes). */
  half: Vec2 | null;
  /** A polygon collider's vertices, turned by its rotation, around the mover's position. */
  poly: readonly Vec2[] | null;
  /** The most it pushes a player per step (its `maxPush` m/s over the step rate). */
  pushStep: number;
  /** Its collider's rotation about Z (the entity's; a mover translates, it does not turn). */
  rotationZ: number;
  /** 3D: the entity's rotation, and its collider's box around its position (null: no collider). */
  rotation: [number, number, number, number];
  aabb: { min: Vec3; max: Vec3 } | null;
}

interface Box {
  id: string;
  half: Vec2;
}

interface Trigger extends Box {
  signal: string;
  exitSignal: string | null;
  once: boolean;
  /** A circle's radius (null: the box `half`). */
  radius: number | null;
  /** Emit the signal every step while inside. */
  stay: boolean;
  inside: boolean;
  spent: boolean;
  /** 3D: the volume — a box's half extents with depth, a sphere, or a capsule (its centre-segment half length). */
  volume: { kind: 'box'; half: Vec3 } | { kind: 'sphere'; radius: number } | { kind: 'capsule'; radius: number; halfSegment: number };
  /** The scene transition an entry starts (null: none). */
  transition: SceneTransitionRequest | null;
}

/** A trigger's scene transition, as the runtime carries it out. */
export interface SceneTransitionRequest {
  readonly scene: string;
  readonly spawn: string | null;
  readonly unload: readonly string[];
  /** Seconds the view fades out before the swap and back in after it (0: none), and its colour. */
  readonly fade?: number;
  readonly fadeColor?: string;
}

function transitionOf(v: unknown): SceneTransitionRequest | null {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as { scene?: unknown; spawn?: unknown; unload?: unknown; fade?: unknown; fadeColor?: unknown };
  if (typeof t.scene !== 'string') return null;
  return Object.freeze({
    scene: t.scene,
    spawn: typeof t.spawn === 'string' ? t.spawn : null,
    unload: Object.freeze(Array.isArray(t.unload) ? t.unload.filter((x): x is string => typeof x === 'string') : []),
    ...(typeof t.fade === 'number' && Number.isFinite(t.fade) && t.fade > 0 ? { fade: Math.min(5, t.fade) } : {}),
    ...(typeof t.fadeColor === 'string' ? { fadeColor: t.fadeColor } : {}),
  });
}

interface Switch extends Box {
  signal: string;
  mode: 'interact' | 'stand';
  /** The input action an interact switch reads. */
  action: string;
  once: boolean;
  inside: boolean;
  spent: boolean;
}

/** A climb volume the character is in: its object and its world up and across axes (unit vectors). */
export interface ClimbVolumeView {
  readonly id: string;
  readonly up: readonly [number, number, number];
  readonly across: readonly [number, number, number];
}

/** The rotation about Z alone of a quaternion (the 2D plane turns objects about Z only). */
function planeRotation(r: readonly number[]): [number, number, number, number] {
  const z = colliderRotationZ(r);
  return [0, 0, Math.sin(z / 2), Math.cos(z / 2)];
}

/** A request to the renderer's effect player (presentation only). */
export interface BlocksEffectRequest {
  op: 'play' | 'stop';
  effectId: string;
  entityId: string | null;
  position: Vec3;
  source: 'component';
}

export interface BlocksHost {
  readonly hz: number;
  readonly physics: PhysicsPort | undefined;
  readonly curr: Map<string, TransformState>;
  /** The character the blocks test — the controller's object ('' without one). */
  readonly characterId: string;
  /**
   * The character's capsule. The blocks test its bounding box:
   * half width `radius`, half height `halfHeight + radius`, centred at the
   * character's position plus `offset`.
   */
  readonly characterCapsule: PlayerCapsule;
  /** The character's committed position on the 2D plane (the entity origin), or null. */
  character(): Vec2 | null;
  /** The collider entity the character stands on, or null. */
  groundEntityId(): string | null;
  /** Play or stop a visual effect (presentation only; the simulation never reads it back). */
  effect?(request: BlocksEffectRequest): void;
  /** The gap the character's controller keeps from the world (its `skin`; default 0.01 m). */
  readonly characterSkin?: number;
  /** The 3D port (a 3D project) — movers are posed on it and the blocks work in 3D. */
  readonly physics3d?: PhysicsPort3D;
  /** The project's gravity (m/s² along Y) and fall speed cap (m/s) for gravity bodies (absent: −19.62, −30). */
  readonly gravityY?: number;
  readonly maxFallSpeed?: number;
  /** 3D: the character's committed position (the entity origin), or null. */
  character3?(): Vec3 | null;
  /** 3D: the character's capsule centre offset along Z. */
  readonly characterOffsetZ?: number;
  /** 3D: the colliders scripts drive, where they are now (posed as kinematic bodies with the movers). */
  scriptColliders3D?(): readonly { entityId: string; position: Vec3; rotation: readonly number[] }[];
  /** The character entered a trigger with a scene transition (the runtime loads, unloads and moves it). */
  sceneTransition?(triggerId: string, transition: SceneTransitionRequest): void;
}

// ---- 3D geometry (in geometry3.ts) ---------------------

export { segmentBoxDistance2, segmentPointDistance2, segmentSegmentDistance2 } from './geometry3';

/** The box around a resolved 3D collider shape turned by `q` (offsets from the body origin). */
function shapeAabb3(shape: ColliderShape3D, q: readonly number[]): { min: Vec3; max: Vec3 } {
  const pts: V3[] = [];
  switch (shape.type) {
    case 'box':
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push([sx * shape.hx, sy * shape.hy, sz * shape.hz]);
      break;
    case 'sphere':
      return { min: [-shape.radius, -shape.radius, -shape.radius], max: [shape.radius, shape.radius, shape.radius] };
    case 'capsule': {
      const e = rotate3(q, [0, shape.halfHeight, 0]);
      const r = shape.radius;
      return { min: [-Math.abs(e[0]) - r, -Math.abs(e[1]) - r, -Math.abs(e[2]) - r], max: [Math.abs(e[0]) + r, Math.abs(e[1]) + r, Math.abs(e[2]) + r] };
    }
    case 'convex':
    case 'mesh': {
      const list = shape.type === 'convex' ? shape.points : shape.vertices;
      for (let i = 0; i + 2 < list.length; i += 3) pts.push([list[i]!, list[i + 1]!, list[i + 2]!]);
      break;
    }
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    const r = rotate3(q, p);
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, r[i]!);
      max[i] = Math.max(max[i]!, r[i]!);
    }
  }
  return { min, max };
}

/** A box collider's half extents, or null for another shape. */
function boxHalf(col: Record<string, unknown> | undefined): Vec2 | null {
  const shape = col?.['shape'] as { type?: string; hx?: number; hy?: number } | undefined;
  return shape?.type === 'box' && typeof shape.hx === 'number' && typeof shape.hy === 'number' ? { x: shape.hx, y: shape.hy } : null;
}

/** A polygon collider's vertices turned by `rotationZ`, or null for another shape. */
function polygonAround(col: Record<string, unknown> | undefined, rotationZ: number): Vec2[] | null {
  const shape = col?.['shape'] as { type?: string; vertices?: unknown } | undefined;
  if (shape?.type !== 'polygon' || !Array.isArray(shape.vertices)) return null;
  const c = Math.cos(rotationZ);
  const s = Math.sin(rotationZ);
  const out: Vec2[] = [];
  for (const v of shape.vertices as unknown[]) {
    if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'number') return null;
    out.push({ x: v[0] * c - v[1] * s, y: v[0] * s + v[1] * c });
  }
  return out.length >= 3 ? out : null;
}

/**
 * The extent of a convex polygon along one axis inside a slab of
 * the other (`axis` 'x': the x range of the part with lo <= y <= hi), or null
 * when the polygon misses the slab.
 */
function slabExtent(poly: readonly Vec2[], axis: 'x' | 'y', lo: number, hi: number): { min: number; max: number } | null {
  const other = axis === 'x' ? 'y' : 'x';
  let min = Infinity;
  let max = -Infinity;
  const take = (v: number): void => {
    if (v < min) min = v;
    if (v > max) max = v;
  };
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (a[other] >= lo && a[other] <= hi) take(a[axis]);
    const d = b[other] - a[other];
    if (d === 0) continue;
    for (const edge of [lo, hi]) {
      const t = (edge - a[other]) / d;
      if (t > 0 && t < 1) take(a[axis] + (b[axis] - a[axis]) * t);
    }
  }
  return min <= max ? { min, max } : null;
}

/** The margin a pushing mover keeps beyond the controller's skin (0.01 + 0.001 = a 0.011 m gap). */
const PUSH_MARGIN = 0.001;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The shared frozen empties of a quiet step. */
const NO_TRIGGER_EVENTS: readonly TriggerEventRecord[] = Object.freeze([]);
const NO_QUEUED_MESSAGES: readonly { message: BehaviorMessage; to: string | null }[] = Object.freeze([]);
const NO_MESSAGES: readonly BehaviorMessage[] = Object.freeze([]);
const NO_CARRY: Vec2 = Object.freeze({ x: 0, y: 0 });
const NO_CARRY3: Readonly<Vec3> = Object.freeze([0, 0, 0]) as unknown as Readonly<Vec3>;

/**
 * A model facing where it goes — the yaw of the
 * horizontal motion of what it follows (its parent, else itself) about +Y,
 * plus an offset, turning at `rate` rad/s. Two-sided facing data reads as
 * this with the offset `yawRight − 90°` (the stored data is upgraded).
 */
interface Facer {
  yaw: number;
  /** The offset (rad), the turn rate (rad/s), the last world position (x, z), whose motion it reads. */
  offset: number;
  rate: number;
  last: [number, number] | null;
  follow: string;
}

export class GameplayBlocks {
  private readonly movers = new Map<string, Mover>();
  private readonly triggers = new Map<string, Trigger>();
  private readonly switches = new Map<string, Switch>();
  private readonly oneWay = new Set<string>();
  /** Climb volumes (half extents of their box, in their object's frame). */
  private readonly climbVolumes = new Map<string, { half: Vec3 }>();
  private readonly parents = new Map<string, string>();
  private readonly hidden = new Set<string>();
  /** Loaded objects authored hidden (`visible: false`): every run starts with them hidden. */
  private readonly startHidden = new Set<string>();
  /** The hidden set as it stood at the start of the step, kept once something changed it in the step (null: unchanged). */
  private hiddenStart: Set<string> | null = null;
  /** Objects a script switched off (with their children): no mover, trigger, switch, primitive or facing steps. */
  private inactive: ReadonlySet<string> = new Set();
  /** Models that face where they go (yaw about +Y, radians). */
  private readonly facers = new Map<string, Facer>();
  private readonly counters = new Map<string, number>();
  /** Entities whose `effect` component (re)starts or stops on a signal. */
  private readonly effectTriggers = new Map<string, { effectId: string; signal: string | null; stop: string | null }>();
  /** The gap a pushing mover keeps from the character (the controller's skin plus a margin). */
  private readonly pushSkin: number;
  private signalsNow = new Set<string>();
  private signalsPrev = new Set<string>();
  /** Triggers entered/left in this step, and in the previous one (what scripts see). */
  private triggerEventsNow: TriggerEventRecord[] = [];
  private triggerEventsPrev: readonly TriggerEventRecord[] = Object.freeze([]);
  /** Script messages sent in this step, and in the previous one (what scripts see); `to` null = every script. */
  private messagesNow: { message: BehaviorMessage; to: string | null }[] = [];
  private messagesPrev: readonly { message: BehaviorMessage; to: string | null }[] = Object.freeze([]);
  /** Sends refused at the per-step limit over the whole play (a run's restart keeps them: they are diagnostics). */
  private refused: { count: number; firstStep: number; lastStep: number } | null = null;
  private carry: Vec2 = { x: 0, y: 0 };
  /** 3D: the carried platform's motion (and pushes) this step, and where each script-driven collider was posed last. */
  private carry3: Readonly<Vec3> = NO_CARRY3;
  private readonly scriptPosed = new Map<string, Vec3>();
  private step = 0;
  /** The character capsule's box — centre offset from the character's position, half width, half height. */
  private readonly pc: { ox: number; oy: number; hw: number; hh: number };
  /** The generic primitives (health on any object, collectibles, patrols, hitbox contacts). */
  readonly primitives: Primitives;

  constructor(
    private readonly host: BlocksHost,
    entities: readonly EntityV3[],
  ) {
    const c = host.characterCapsule;
    this.pc = { ox: c.offset.x, oy: c.offset.y, hw: c.radius, hh: capsuleHalfTotal(c) };
    this.pushSkin = (host.characterSkin ?? 0.01) + PUSH_MARGIN;
    const blocks = this;
    this.primitives = new Primitives({
      hz: host.hz,
      dimension: host.physics3d !== undefined ? 3 : 2,
      get curr() {
        return host.curr;
      },
      physics: host.physics,
      physics3d: host.physics3d,
      character: () => blocks.characterBox(),
      worldOf: (id) => blocks.worldOf(id),
      parentOf: (id) => blocks.parents.get(id),
      setHidden: (id, hidden) => blocks.setVisible(id, !hidden),
      addCounter: (name, delta) => blocks.addCounter(name, delta),
      emit: (signal) => blocks.emit(signal),
      note: (e) => blocks.cueLog?.events.push({ name: e.type, entity: e.entity }),
      ...(host.gravityY !== undefined ? { gravityY: host.gravityY } : {}),
      ...(host.maxFallSpeed !== undefined ? { maxFallSpeed: host.maxFallSpeed } : {}),
    });
    this.add(entities);
  }

  /** The character's capsule box (centre and half extents), or null without a character. */
  private characterBox(): { id: string; centre: Vec3; half: Vec3 } | null {
    const id = this.host.characterId;
    const t = id !== '' ? this.host.curr.get(id) : undefined;
    if (t === undefined) return null;
    const oz = this.host.physics3d !== undefined ? (this.host.characterOffsetZ ?? 0) : 0;
    return { id, centre: [t.position[0] + this.pc.ox, t.position[1] + this.pc.oy, t.position[2] + oz], half: [this.pc.hw, this.pc.hh, this.pc.hw] };
  }

  /** Entities of a loaded scene. */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      if (e.parentId !== undefined) this.parents.set(e.id, e.parentId);
      if (e.visible === false) {
        this.startHidden.add(e.id);
        this.hidden.add(e.id);
      }
      const c = e.components as unknown as Record<string, Record<string, unknown> | undefined>;
      const p = e.components.transform.position;
      const col = c['collider'];
      if (col !== undefined && col['oneWay'] === true) this.oneWay.add(e.id);
      const face = c['faceMovement'];
      if (face !== undefined) {
        // A two-sided model (no mode) reads as a velocity one: moving +X faces yawRight (the stored data is upgraded).
        const offsetDeg = face['mode'] === 'velocity' ? num(face['yawOffset'], 0) : num(face['yawRight'], 90) - 90;
        const turn = num(face['turnSeconds'], 0.12);
        const q = e.components.transform.rotation;
        this.facers.set(e.id, {
          yaw: 2 * Math.atan2(q[1] ?? 0, q[3] ?? 1),
          offset: (offsetDeg * Math.PI) / 180,
          rate: turn > 0 ? Math.PI / turn : Infinity,
          last: null,
          follow: e.parentId ?? e.id,
        });
      }
      const m = c['mover'];
      if (m !== undefined) {
        const base: Vec3 = [p[0], p[1], p[2]];
        const points: Vec3[] = [base, ...(m['waypoints'] as number[][]).map((w) => [base[0] + (w[0] ?? 0), base[1] + (w[1] ?? 0), base[2] + (w[2] ?? 0)] as Vec3)];
        const mode = m['mode'] as Mover['mode'];
        const segs = mode === 'loop' ? points.length : points.length - 1;
        const lengths = Array.from({ length: segs }, (_, i) => {
          const a = points[i]!;
          const b = points[(i + 1) % points.length]!;
          return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        });
        this.movers.set(e.id, {
          id: e.id,
          points,
          lengths,
          speed: num(m['speed'], 1),
          authoredSpeed: num(m['speed'], 1),
          authoredActive: m['active'] !== false,
          active: m['active'] !== false,
          mode,
          wait: num(m['wait'], 0),
          easing: m['easing'] === 'smooth' || m['easing'] === 'gravity' ? m['easing'] : 'linear',
          startOn: typeof m['startOn'] === 'string' ? (m['startOn'] as string) : null,
          stopOn: typeof m['stopOn'] === 'string' ? (m['stopOn'] as string) : null,
          toggleOn: typeof m['toggleOn'] === 'string' ? (m['toggleOn'] as string) : null,
          reverseOn: typeof m['reverseOn'] === 'string' ? (m['reverseOn'] as string) : null,
          started: typeof m['startOn'] !== 'string',
          segment: 0,
          along: 0,
          dir: 1,
          waiting: 0,
          done: false,
          pos: [...base],
          half: boxHalf(col),
          poly: polygonAround(col, colliderRotationZ(e.components.transform.rotation)),
          pushStep: num(m['maxPush'], D.maxPush) / this.host.hz,
          rotationZ: colliderRotationZ(e.components.transform.rotation),
          ...this.mover3(e, col),
        });
      }
      const t = c['trigger'];
      if (t !== undefined) {
        const circle = t['shape'] === 'circle';
        const radius = circle ? num(t['radius'], 0.5) : null;
        const size = (t['size'] as number[] | undefined) ?? [2 * (radius ?? 0.5), 2 * (radius ?? 0.5)];
        // The 3D volume (a 3D project; the model gives a box its depth, a capsule its height).
        const r3 = num(t['radius'], 0.5);
        const volume: Trigger['volume'] =
          t['shape'] === 'sphere' || t['shape'] === 'circle'
            ? { kind: 'sphere', radius: r3 }
            : t['shape'] === 'capsule'
              ? { kind: 'capsule', radius: r3, halfSegment: Math.max(0, num(t['height'], 2 * r3) / 2 - r3) }
              : { kind: 'box', half: [size[0]! / 2, size[1]! / 2, (size[2] ?? size[0]!) / 2] };
        this.triggers.set(e.id, {
          volume,
          id: e.id,
          half: { x: size[0]! / 2, y: size[1]! / 2 },
          radius,
          stay: t['mode'] === 'stay',
          signal: String(t['signal']),
          exitSignal: typeof t['exitSignal'] === 'string' ? (t['exitSignal'] as string) : null,
          once: t['once'] === true,
          inside: false,
          spent: false,
          transition: transitionOf(t['sceneTransition']),
        });
      }
      const s = c['switch'];
      if (s !== undefined) {
        const size = s['size'] as number[];
        this.switches.set(e.id, { id: e.id, half: { x: size[0]! / 2, y: size[1]! / 2 }, signal: String(s['signal']), mode: s['mode'] as Switch['mode'], action: typeof s['action'] === 'string' ? (s['action'] as string) : SWITCH_DEFAULT_ACTION, once: s['once'] === true, inside: false, spent: false });
      }
      const h = c['health'];
      // An effect component that a signal starts or stops.
      const fx = c['effect'];
      if (fx !== undefined && (typeof fx['signal'] === 'string' || typeof fx['stopSignal'] === 'string')) {
        this.effectTriggers.set(e.id, { effectId: String(fx['effectId']), signal: typeof fx['signal'] === 'string' ? (fx['signal'] as string) : null, stop: typeof fx['stopSignal'] === 'string' ? (fx['stopSignal'] as string) : null });
      }
      // Health on any object, collectibles, patrols, hitboxes.
      if (h !== undefined || c['collectible'] !== undefined || c['patrol'] !== undefined || c['hitbox'] !== undefined || c['gravity'] !== undefined) this.primitives.add(e.id, c, p);
      // A volume the character climbs in.
      const climb = c['climbVolume'];
      if (climb !== undefined) {
        const size = Array.isArray(climb['size']) ? (climb['size'] as number[]) : [1, 4];
        const w = num(size[0], 1);
        this.climbVolumes.set(e.id, { half: [w / 2, num(size[1], w) / 2, num(size[2], w) / 2] });
      }
    }
  }

  /** A mover's 3D data — its entity's rotation and its collider's box (a 2D plane never reads them). */
  private mover3(e: EntityV3, col: Record<string, unknown> | undefined): Pick<Mover, 'rotation' | 'aabb'> {
    const q = e.components.transform.rotation;
    const rotation: [number, number, number, number] = [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1];
    if (this.host.physics3d === undefined || col === undefined) return { rotation, aabb: null };
    const shape = colliderShape3DOf(col['shape'], e.components.transform.scale);
    return { rotation, aabb: shape === null ? null : shapeAabb3(shape, rotation) };
  }

  /** Entities of an unloaded scene. */
  remove(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.scriptPosed.delete(id);
      this.movers.delete(id);
      this.triggers.delete(id);
      this.switches.delete(id);
      this.climbVolumes.delete(id);
      this.oneWay.delete(id);
      this.hidden.delete(id);
      this.startHidden.delete(id);
      this.parents.delete(id);
      this.facers.delete(id);
      this.effectTriggers.delete(id);
    }
    this.primitives.remove(ids);
  }

  /** A new run (start/replay): everything back as authored. */
  resetRun(): void {
    for (const m of this.movers.values()) {
      Object.assign(m, { started: m.startOn === null, segment: 0, along: 0, dir: 1, waiting: 0, done: false, pos: [...m.points[0]!], speed: m.authoredSpeed, active: m.authoredActive });
      this.writeTransform(m.id, m.pos);
    }
    for (const t of this.triggers.values()) Object.assign(t, { inside: false, spent: false });
    for (const s of this.switches.values()) Object.assign(s, { inside: false, spent: false });
    this.hidden.clear();
    for (const id of this.startHidden) this.hidden.add(id);
    this.hiddenStart = null;
    this.counters.clear();
    this.signalsNow.clear();
    this.signalsPrev.clear();
    this.triggerEventsNow = [];
    this.triggerEventsPrev = Object.freeze([]);
    this.messagesNow = [];
    this.messagesPrev = Object.freeze([]);
    this.carry = { x: 0, y: 0 };
    this.carry3 = NO_CARRY3;
    this.scriptPosed.clear();
    // Health back to its start, collectibles back, patrols at their start.
    this.primitives.resetRun();
  }

  /**
   * The character was placed (a spawn, a respawn, a teleport) —
   * the face-movement models under `rootId` forget their last position, so
   * the placement is not read as motion (they keep their yaw).
   */
  placed(rootId: string): void {
    for (const [id, f] of this.facers) if (this.isUnder(id, rootId)) f.last = null;
  }

  private isUnder(id: string, rootId: string): boolean {
    let p = this.parents.get(id);
    for (let guard = 0; p !== undefined && guard < 64; guard++) {
      if (p === rootId) return true;
      p = this.parents.get(p);
    }
    return false;
  }

  /**
   * A spawn's facing — the face-movement models under
   * `rootId` (the character's) turn at once to `yaw` (radians about +Y) plus
   * their offset, as if the character had just moved that way.
   */
  faceSpawn(rootId: string, yaw: number): void {
    for (const [id, f] of this.facers) {
      if (!this.isUnder(id, rootId)) continue;
      f.yaw = yaw + f.offset;
      f.last = null;
      const t = this.host.curr.get(id);
      if (t !== undefined) {
        t.rotation[0] = 0;
        t.rotation[1] = Math.sin(f.yaw / 2);
        t.rotation[2] = 0;
        t.rotation[3] = Math.cos(f.yaw / 2);
      }
    }
  }

  // ---- queries ------------------------------------------------------------------

  /**
   * The climb volume the character's capsule centre is in now
   * (the first in load order; null: none, or no character): its object, and
   * its up and across axes in the world (its object's +Y and +X, turned with
   * the object's rotation — about Z only on the 2D plane).
   */
  climbVolume(): ClimbVolumeView | null {
    if (this.climbVolumes.size === 0) return null;
    const ch = this.characterBox();
    if (ch === null) return null;
    const flat = this.host.physics3d === undefined;
    for (const [id, v] of this.climbVolumes) {
      if (this.inactive.has(id)) continue;
      const at = this.worldOf(id);
      const t = this.host.curr.get(id);
      if (at === null || t === undefined) continue;
      const r = t.rotation;
      const q: [number, number, number, number] = flat ? planeRotation(r) : [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1];
      const inv: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]];
      const local = rotate3(inv, sub3(ch.centre, at));
      if (Math.abs(local[0]) > v.half[0] || Math.abs(local[1]) > v.half[1] || (!flat && Math.abs(local[2]) > v.half[2])) continue;
      return { id, up: rotate3(q, [0, 1, 0]) as Vec3, across: rotate3(q, [1, 0, 0]) as Vec3 };
    }
    return null;
  }

  /** A script shows or hides an entity (a new run starts every object as authored). */
  setVisible(entityId: string, visible: boolean): void {
    if (visible === !this.hidden.has(entityId)) return;
    if (this.hiddenStart === null) this.hiddenStart = new Set(this.hidden);
    if (visible) this.hidden.delete(entityId);
    else this.hidden.add(entityId);
  }

  /** Whether an object was hidden at the start of this step (`ctx.entity(id).get('object').visible`). */
  hiddenAtStepStart(entityId: string): boolean {
    return (this.hiddenStart ?? this.hidden).has(entityId);
  }

  /** A step begins (the hidden set's step-start copy is dropped). */
  beginScriptStep(): void {
    this.hiddenStart = null;
  }

  /** A mover's speed and moving flag now (null: no mover). */
  moverState(entityId: string): { speed: number; active: boolean } | null {
    const m = this.movers.get(entityId);
    return m === undefined ? null : { speed: m.speed, active: m.active };
  }

  /** A script's mover write (speed in m/s, moving or held), from the next step on. */
  setMover(entityId: string, patch: { speed?: number; active?: boolean }): void {
    const m = this.movers.get(entityId);
    if (m === undefined) return;
    if (patch.speed !== undefined) m.speed = patch.speed;
    if (patch.active !== undefined) m.active = patch.active;
  }

  /**
   * The objects switched off (a script's `active: false`, with
   * their children). Their movers, triggers, switches, primitives and facing
   * models do not step; a trigger or switch switched off forgets that the
   * character was inside (switched on again, an entry is an entry).
   */
  setInactive(ids: ReadonlySet<string>): void {
    this.inactive = ids;
    for (const id of ids) {
      const t = this.triggers.get(id);
      if (t !== undefined) t.inside = false;
      const sw = this.switches.get(id);
      if (sw !== undefined) sw.inside = false;
    }
    this.primitives.setInactive(ids);
  }

  hiddenEntities(): ReadonlySet<string> {
    return this.hidden;
  }

  countersView(): Record<string, number> {
    return Object.fromEntries([...this.counters].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  addCounter(name: string, delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  /** The named counters set from a project save's components section (every other counter is cleared). */
  setCounters(values: Readonly<Record<string, number>>): void {
    this.counters.clear();
    for (const [k, v] of Object.entries(values)) if (/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k) && Number.isFinite(v)) this.counters.set(k, v);
  }

  /** The character's health (ctx.game.health), or null when it has none. */
  healthView(): { current: number; max: number } | null {
    const id = this.host.characterId;
    return id !== '' ? this.primitives.healthOf(id) : null;
  }

  /** A signal emitted in the previous step (what consumers see this step). */
  signaled(name: string): boolean {
    return this.signalsPrev.has(name);
  }

  emit(name: string): void {
    this.signalsNow.add(name);
    this.cueLog?.signals.push(name);
  }

  // ---- What the event → cue table listens to ----------------------------

  /** This step's signals and events, in the order they happened (null: the project has no event sounds). */
  private cueLog: { signals: string[]; events: { name: string; entity: string }[] } | null = null;

  /** Start noting signals and events for the event → cue table (a project with event sounds). */
  enableCueLog(): void {
    if (this.cueLog === null) this.cueLog = { signals: [], events: [] };
  }

  /** The signals and events noted since the last call (then forgotten). */
  takeCueLog(): { signals: readonly string[]; events: readonly { name: string; entity: string }[] } | null {
    const log = this.cueLog;
    if (log === null || (log.signals.length === 0 && log.events.length === 0)) return null;
    this.cueLog = { signals: [], events: [] };
    return log;
  }

  /** The triggers the player entered or left in the previous step (in trigger order). */
  triggerEvents(): readonly TriggerEventRecord[] {
    return this.triggerEventsPrev;
  }

  /** Queue a script message for the next step; false at the step's limit. */
  sendMessage(message: BehaviorMessage, to: string | null): boolean {
    if (this.messagesNow.length >= MAX_MESSAGES_PER_STEP) {
      const r = this.refused;
      if (r === null) this.refused = { count: 1, firstStep: message.stepIndex, lastStep: message.stepIndex };
      else {
        r.count += 1;
        r.lastStep = message.stepIndex;
      }
      return false;
    }
    this.messagesNow.push({ message: Object.freeze({ ...message }), to });
    return true;
  }

  /**
   * The message queue's refused sends (null while none was refused): a full
   * queue means scripts send more in one step than the limit, the warning a
   * runaway sender (or a queue nothing turns over) shows in Play diagnostics.
   */
  messageQueueView(): { refused: number; firstRefusedStep: number; lastRefusedStep: number; perStepLimit: number; warning: string } | null {
    const r = this.refused;
    if (r === null) return null;
    return {
      refused: r.count,
      firstRefusedStep: r.firstStep,
      lastRefusedStep: r.lastStep,
      perStepLimit: MAX_MESSAGES_PER_STEP,
      warning: `ctx.messages.send refused ${r.count} message(s): more than ${MAX_MESSAGES_PER_STEP} sent in one step (first at step ${r.firstStep}, last at step ${r.lastStep}); the refused ones never arrive`,
    };
  }

  /** The messages of `name` sent in the previous step to every script or to `to`, in send order. */
  messagesFor(to: string, name: string): readonly BehaviorMessage[] {
    // No messages last step (the usual case) answers with one shared empty list.
    if (this.messagesPrev.length === 0) return NO_MESSAGES;
    const out: BehaviorMessage[] = [];
    for (const m of this.messagesPrev) if (m.message.name === name && (m.to === null || m.to === to)) out.push(m.message);
    return Object.freeze(out);
  }

  /** Every message sent in the previous step to every script or to `to`, in send order. */
  messagesTo(to: string): readonly BehaviorMessage[] {
    if (this.messagesPrev.length === 0) return NO_MESSAGES;
    const out: BehaviorMessage[] = [];
    for (const m of this.messagesPrev) if (m.to === null || m.to === to) out.push(m.message);
    return out.length === 0 ? NO_MESSAGES : Object.freeze(out);
  }

  /** The carried platform's motion this step (added to the player's staged move). */
  carryDelta(): Vec2 {
    return this.carry;
  }

  /** 3D: the carried platform's motion (and a mover's push) this step, added to the player's move. */
  carryDelta3(): Readonly<Vec3> {
    return this.carry3;
  }

  isOneWay(entityId: string | null): boolean {
    return entityId !== null && this.oneWay.has(entityId);
  }

  // ---- the step --------------------------------------------------------------------

  /**
   * Signals, trigger events, script messages and the primitives' events turn
   * over: what was sent or happened last step is what scripts see now. Every
   * step does this, whatever holds physics (a game mode's hold, a plain step
   * without a physics world): messages and signals are script-to-script and
   * have nothing to do with the bodies, movers and triggers a hold stops.
   */
  turnover(stepIndex: number): void {
    this.step = stepIndex;
    // The primitives' events turn over with the trigger events.
    this.primitives.turnover(stepIndex);
    // The two signal sets swap (the new current one is cleared only
    // when it holds something), and an empty step's events and messages are one
    // shared frozen empty list — a quiet step makes no collections.
    const signals = this.signalsPrev;
    this.signalsPrev = this.signalsNow;
    if (signals.size > 0) signals.clear();
    this.signalsNow = signals;
    if (this.triggerEventsNow.length === 0) this.triggerEventsPrev = NO_TRIGGER_EVENTS;
    else {
      this.triggerEventsPrev = Object.freeze(this.triggerEventsNow);
      this.triggerEventsNow = [];
    }
    if (this.messagesNow.length === 0) this.messagesPrev = NO_QUEUED_MESSAGES;
    else {
      this.messagesPrev = Object.freeze(this.messagesNow);
      this.messagesNow = [];
    }
    // Effect components started or stopped by last step's signals (entity order: deterministic).
    if (this.effectTriggers.size > 0 && this.signalsPrev.size > 0) {
      for (const [id, t] of this.effectTriggers) {
        if (this.inactive.has(id)) continue;
        if (t.stop !== null && this.signalsPrev.has(t.stop)) this.host.effect?.({ op: 'stop', effectId: '', entityId: id, position: [0, 0, 0], source: 'component' });
        if (t.signal !== null && this.signalsPrev.has(t.signal)) this.host.effect?.({ op: 'play', effectId: t.effectId, entityId: id, position: [0, 0, 0], source: 'component' });
      }
    }
  }

  /** Start of a step that runs physics: the turnover, then movers advance (their colliders are posed for physics). */
  beforeStep(stepIndex: number): void {
    this.turnover(stepIndex);
    if (this.host.physics3d !== undefined) {
      this.beforeStep3D(this.host.physics3d);
      return;
    }
    if (this.movers.size === 0) {
      // Nothing moves the character this step: no carry, no poses.
      this.carry = NO_CARRY;
      return;
    }
    const dt = 1 / this.host.hz;
    const ground = this.host.groundEntityId();
    this.carry = { x: 0, y: 0 };
    const poses: { entityId: string; position: Vec2; rotationZ: number }[] = [];
    // A mover that moves into the player (one it is not carrying) pushes the
    // player out along the shallower axis this step — a rising lift scoops up
    // a player at its edge, a sliding block shoves — so the character never
    // ends up inside a kinematic body (the controller would then have to
    // correct beyond its contracted bound).
    const player = this.host.character();
    const pushed = { x: 0, y: 0 };
    // A mover moving mostly upward pushes a player beside or
    // under it (the capsule's centre below the mover's top) out sideways, away
    // from the mover, never up — a rising gate or pillar does not lift a
    // player pressing against it; only a player above it is scooped up.
    const push = (m: Mover, before: Vec3): void => {
      if (player === null) return;
      if (m.half === null) {
        if (m.poly !== null) pushPolygon(m, before);
        return;
      }
      const px = player.x + this.pc.ox + pushed.x;
      const py = player.y + this.pc.oy + pushed.y;
      const ox = m.half.x + this.pc.hw + this.pushSkin - Math.abs(px - m.pos[0]);
      const oy = m.half.y + this.pc.hh + this.pushSkin - Math.abs(py - m.pos[1]);
      if (ox <= 0 || oy <= 0) return;
      const dx = m.pos[0] - before[0];
      const dy = m.pos[1] - before[1];
      const sideways = dy > 0 && dy >= Math.abs(dx) && py < m.pos[1] + m.half.y;
      if (oy <= ox && !sideways) pushed.y += Math.min(m.pushStep, oy) * (py >= m.pos[1] ? 1 : -1);
      else pushed.x += Math.min(m.pushStep, ox) * (px >= m.pos[0] ? 1 : -1);
    };
    // The same rule for a polygon collider, with its exact extent
    // across the character's box (the part of the polygon beside the box for
    // the horizontal overlap, the part above or below it for the vertical one)
    // instead of a box's half extents. A box keeps the rule above unchanged.
    const pushPolygon = (m: Mover, before: Vec3): void => {
      if (player === null || m.poly === null) return;
      const px = player.x + this.pc.ox + pushed.x;
      const py = player.y + this.pc.oy + pushed.y;
      const hw = this.pc.hw + this.pushSkin;
      const hh = this.pc.hh + this.pushSkin;
      const xs = slabExtent(m.poly, 'x', py - hh - m.pos[1], py + hh - m.pos[1]);
      const ys = slabExtent(m.poly, 'y', px - hw - m.pos[0], px + hw - m.pos[0]);
      if (xs === null || ys === null) return;
      const right = px >= m.pos[0] + (xs.min + xs.max) / 2;
      const up = py >= m.pos[1] + (ys.min + ys.max) / 2;
      const ox = right ? m.pos[0] + xs.max - (px - hw) : px + hw - (m.pos[0] + xs.min);
      const oy = up ? m.pos[1] + ys.max - (py - hh) : py + hh - (m.pos[1] + ys.min);
      if (ox <= 0 || oy <= 0) return;
      const dx = m.pos[0] - before[0];
      const dy = m.pos[1] - before[1];
      const sideways = dy > 0 && dy >= Math.abs(dx) && py < m.pos[1] + ys.max;
      if (oy <= ox && !sideways) pushed.y += Math.min(m.pushStep, oy) * (up ? 1 : -1);
      else pushed.x += Math.min(m.pushStep, ox) * (right ? 1 : -1);
    };
    for (const m of this.movers.values()) {
      if (this.inactive.has(m.id)) continue;
      const before: Vec3 = [...m.pos];
      this.moverSignals(m);
      if (m.started && m.active && !m.done) this.advance(m, dt);
      this.writeTransform(m.id, m.pos);
      poses.push({ entityId: m.id, position: { x: m.pos[0], y: m.pos[1] }, rotationZ: m.rotationZ });
      if (ground === m.id) this.carry = { x: m.pos[0] - before[0], y: m.pos[1] - before[1] };
      else if (m.pos[0] !== before[0] || m.pos[1] !== before[1]) push(m, before);
    }
    this.carry = { x: this.carry.x + pushed.x, y: this.carry.y + pushed.y };
    if (poses.length > 0) this.host.physics?.setKinematicPositions?.(poses);
  }

  /**
   * The 3D mover step. Movers advance and are posed on the 3D
   * port with their entity's rotation (a mover translates, it does not turn),
   * together with the colliders scripts drive (where the last step's
   * transform phase left them). The player moves with what it stands on; a
   * mover moving into the player pushes it out along the axis of least
   * overlap (the 2D rule in 3D: a mover moving mostly upward pushes a player
   * beside or under it sideways, never up).
   */
  private beforeStep3D(port: PhysicsPort3D): void {
    const extras = this.host.scriptColliders3D?.() ?? [];
    if (this.movers.size === 0 && extras.length === 0) {
      this.carry3 = NO_CARRY3;
      return;
    }
    const dt = 1 / this.host.hz;
    const ground = this.host.groundEntityId();
    const carry: Vec3 = [0, 0, 0];
    const pushed: Vec3 = [0, 0, 0];
    const poses: KinematicPose3D[] = [];
    const player = this.host.character3?.() ?? null;
    const oz = this.host.characterOffsetZ ?? 0;
    const capHalf: Vec3 = [this.pc.hw, this.pc.hh, this.pc.hw];
    const push = (m: Mover, before: Vec3): void => {
      if (player === null || m.aabb === null) return;
      const pc: Vec3 = [player[0] + this.pc.ox + pushed[0], player[1] + this.pc.oy + pushed[1], player[2] + oz + pushed[2]];
      const centre: Vec3 = [0, 1, 2].map((i) => m.pos[i]! + (m.aabb!.min[i]! + m.aabb!.max[i]!) / 2) as Vec3;
      const over: Vec3 = [0, 1, 2].map((i) => (m.aabb!.max[i]! - m.aabb!.min[i]!) / 2 + capHalf[i]! + this.pushSkin - Math.abs(pc[i]! - centre[i]!)) as Vec3;
      if (over[0] <= 0 || over[1] <= 0 || over[2] <= 0) return;
      const d = sub3(m.pos, before);
      const sideways = d[1] > 0 && d[1] >= Math.hypot(d[0], d[2]) && pc[1] < m.pos[1] + m.aabb.max[1];
      const axis: 0 | 1 | 2 = over[1] <= over[0] && over[1] <= over[2] && !sideways ? 1 : over[0] <= over[2] ? 0 : 2;
      pushed[axis] = pushed[axis] + Math.min(m.pushStep, over[axis]) * (pc[axis] >= centre[axis] ? 1 : -1);
    };
    for (const m of this.movers.values()) {
      if (this.inactive.has(m.id)) continue;
      const before: Vec3 = [...m.pos];
      this.moverSignals(m);
      if (m.started && m.active && !m.done) this.advance(m, dt);
      this.writeTransform(m.id, m.pos);
      poses.push({ entityId: m.id, position: { x: m.pos[0], y: m.pos[1], z: m.pos[2] }, rotation: { x: m.rotation[0], y: m.rotation[1], z: m.rotation[2], w: m.rotation[3] } });
      if (ground === m.id) {
        carry[0] = m.pos[0] - before[0];
        carry[1] = m.pos[1] - before[1];
        carry[2] = m.pos[2] - before[2];
      } else if (m.pos[0] !== before[0] || m.pos[1] !== before[1] || m.pos[2] !== before[2]) push(m, before);
    }
    for (const x of extras) {
      const q = x.rotation;
      poses.push({ entityId: x.entityId, position: { x: x.position[0], y: x.position[1], z: x.position[2] }, rotation: { x: q[0] ?? 0, y: q[1] ?? 0, z: q[2] ?? 0, w: q[3] ?? 1 } });
      const was = this.scriptPosed.get(x.entityId);
      if (was !== undefined && ground === x.entityId) {
        carry[0] = x.position[0] - was[0];
        carry[1] = x.position[1] - was[1];
        carry[2] = x.position[2] - was[2];
      }
      this.scriptPosed.set(x.entityId, [x.position[0], x.position[1], x.position[2]]);
    }
    this.carry3 = [carry[0] + pushed[0], carry[1] + pushed[1], carry[2] + pushed[2]];
    if (poses.length > 0) port.setKinematicPoses?.(poses);
  }

  private advance(m: Mover, dt: number): void {
    advancePath(m, dt);
  }

  /**
   * A mover reads last step's signals, in a fixed order: its
   * start signal starts it (and moves a held one: `active`), its stop signal
   * holds it, its toggle signal moves a held one and holds a moving one, and
   * its reverse signal turns it around (a finished once-mover travels back).
   * `stopOn`/`toggleOn` hold and move through the same `active` flag a
   * script writes, so `get('mover').active` shows it.
   */
  private moverSignals(m: Mover): void {
    const sig = this.signalsPrev;
    if (sig.size === 0) return;
    if (m.startOn !== null && sig.has(m.startOn)) {
      if (!m.started) m.started = true;
      m.active = true;
    }
    if (m.stopOn !== null && sig.has(m.stopOn)) m.active = false;
    if (m.toggleOn !== null && sig.has(m.toggleOn)) {
      if (m.started && m.active) m.active = false;
      else {
        m.started = true;
        m.active = true;
      }
    }
    if (m.reverseOn !== null && sig.has(m.reverseOn)) reversePath(m);
  }

  /**
   * After the transform phase (both dimensions): the generic primitives
   * (patrols walk; collectibles and hitbox contacts test the character),
   * face-movement models turn, and the triggers (and, on the 2D plane, the
   * switches) test the character. One path with or without a
   * game mode; the deleted session's game components and damage are gone.
   */
  afterPhysics(frame: ActionFrame): void {
    this.primitives.afterPhysics(true);
    if (this.facers.size > 0) this.turnFacers(1 / this.host.hz);
    if (this.host.physics3d !== undefined) {
      this.triggers3D();
      return;
    }
    const player = this.host.character();
    if (player === null) return;
    this.triggers2D(player);
    for (const s of this.switches.values()) {
      if (this.inactive.has(s.id)) continue;
      const at = this.worldOf(s.id);
      const inside = at !== null && Math.abs(player.x + this.pc.ox - at[0]) < s.half.x + this.pc.hw && Math.abs(player.y + this.pc.oy - at[1]) < s.half.y + this.pc.hh;
      // An interact switch reads its own action (absent: interact).
      const fire = s.mode === 'stand' ? inside && !s.inside : inside && frame.actions?.[s.action]?.p === 'pressed';
      if (fire && !s.spent) {
        this.emit(s.signal);
        if (s.once) s.spent = true;
      }
      s.inside = inside;
    }
  }

  /** A 2D-plane plain step (no simulation modules), after its turnover: the primitives step. */
  stepPrimitivesOnly(): void {
    if (!this.primitives.active && this.facers.size === 0) return;
    this.primitives.afterPhysics(true);
    if (this.facers.size > 0) this.turnFacers(1 / this.host.hz);
  }

  /**
   * The 2D-plane triggers against the character at `player` (its origin): a
   * box against the capsule's box; A circle against the capsule
   * itself (a segment of half length halfHeight − radius, swept by the
   * radius) — the distance from the circle's centre to the segment is under
   * the two radii.
   */
  private triggers2D(player: Vec2): void {
    const segHalf = Math.max(0, this.pc.hh - this.pc.hw);
    const cx = player.x + this.pc.ox;
    const cy = player.y + this.pc.oy;
    for (const t of this.triggers.values()) {
      if (this.inactive.has(t.id)) continue;
      const at = this.worldOf(t.id);
      let inside = false;
      if (at !== null) {
        if (t.radius !== null) {
          const ny = Math.min(cy + segHalf, Math.max(cy - segHalf, at[1]));
          inside = Math.hypot(at[0] - cx, at[1] - ny) < t.radius + this.pc.hw;
        } else inside = Math.abs(cx - at[0]) < t.half.x + this.pc.hw && Math.abs(cy - at[1]) < t.half.y + this.pc.hh;
      }
      this.updateTrigger(t, inside);
    }
  }

  /** The primitives' events of the previous step (every object's; the behavior host gives each script those it owns). */
  primitiveEvents(): readonly PrimitiveEventRecord[] {
    return this.primitives.events();
  }

  /** A trigger's signals and events for this step's inside test (the 2D plane's and 3D's shared rules). */
  private updateTrigger(t: Trigger, inside: boolean): void {
    // An entry starts the trigger's scene transition (as its signal, only once with `once`).
    if (inside && !t.inside && t.transition !== null && !t.spent) this.host.sceneTransition?.(t.id, t.transition);
    if (inside && (!t.inside || t.stay) && !t.spent) {
      this.emit(t.signal);
      if (t.once) t.spent = true;
    }
    if (!inside && t.inside && t.exitSignal !== null) this.emit(t.exitSignal);
    // Every real entry and exit (whatever `once` says about the signal).
    // `stepIndex` counts as scripts' `ctx.stepIndex` does (this.step is the 1-based ordinal).
    if (inside !== t.inside) {
      this.triggerEventsNow.push(Object.freeze({ type: inside ? 'enter' : 'exit', trigger: t.id, stepIndex: this.step - 1 }));
      this.cueLog?.events.push({ name: inside ? 'enter' : 'exit', entity: t.id });
    }
    t.inside = inside;
  }

  /**
   * The 3D triggers after physics. The player is its capsule —
   * a segment of half length `halfHeight` along Y through its centre, swept
   * by its radius — tested exactly against each volume at its entity's world
   * position (the parents' offsets summed, as in 2D): a sphere by the
   * segment's distance to its centre, a capsule by segment-to-segment
   * distance (standing along the trigger's own Y, turned with it), a box by
   * the segment's distance to it in the box's own frame. Inside is strictly
   * closer than the radii (a touch is outside, as in 2D).
   */
  private triggers3D(): void {
    const p = this.host.character3?.() ?? null;
    if (p === null) return;
    const seg = Math.max(0, this.pc.hh - this.pc.hw);
    const c: Vec3 = [p[0] + this.pc.ox, p[1] + this.pc.oy, p[2] + (this.host.characterOffsetZ ?? 0)];
    const a: Vec3 = [c[0], c[1] - seg, c[2]];
    const b: Vec3 = [c[0], c[1] + seg, c[2]];
    const r = this.pc.hw;
    for (const t of this.triggers.values()) {
      if (this.inactive.has(t.id)) continue;
      const at = this.worldOf(t.id);
      if (at === null) continue;
      const q = this.host.curr.get(t.id)?.rotation ?? [0, 0, 0, 1];
      const v = t.volume;
      let inside: boolean;
      if (v.kind === 'sphere') inside = segmentPointDistance2(a, b, at) < (v.radius + r) * (v.radius + r);
      else if (v.kind === 'capsule') {
        const e = rotate3(q, [0, v.halfSegment, 0]);
        inside = segmentSegmentDistance2(a, b, [at[0] - e[0], at[1] - e[1], at[2] - e[2]], [at[0] + e[0], at[1] + e[1], at[2] + e[2]]) < (v.radius + r) * (v.radius + r);
      } else {
        inside = segmentBoxDistance2(rotate3(q, sub3(a, at), true), rotate3(q, sub3(b, at), true), v.half) < r * r;
      }
      this.updateTrigger(t, inside);
    }
  }

  private writeTransform(id: string, pos: readonly number[]): void {
    const t = this.host.curr.get(id);
    if (t === undefined) return;
    t.position[0] = pos[0]!;
    t.position[1] = pos[1]!;
    t.position[2] = pos[2]!;
  }

  /** Each facing model turns toward the horizontal motion of what it follows. */
  private turnFacers(dt: number): void {
    for (const [id, f] of this.facers) if (!this.inactive.has(id)) this.turnVelocityFacer(id, f, dt);
  }

  /**
   * A velocity model turns toward the yaw of the horizontal
   * motion of what it follows (its parent, else itself) — atan2(dx, dz) about
   * +Y, 0 facing +Z, plus its offset — by the shorter way at its turn rate;
   * it keeps its yaw while standing (below 0.1 mm per step).
   */
  private turnVelocityFacer(id: string, f: Facer, dt: number): void {
    const at = this.worldOf(f.follow);
    if (at === null) return;
    const last = f.last;
    f.last = [at[0], at[2]];
    if (last !== null) {
      const dx = at[0] - last[0];
      const dz = at[2] - last[1];
      if (Math.hypot(dx, dz) > 1e-4) {
        const target = Math.atan2(dx, dz) + f.offset;
        let d = target - f.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const step = f.rate * dt;
        f.yaw = Math.abs(d) <= step ? f.yaw + d : f.yaw + Math.sign(d) * step;
        f.yaw = Math.atan2(Math.sin(f.yaw), Math.cos(f.yaw));
      }
    }
    const t = this.host.curr.get(id);
    if (t !== undefined) {
      t.rotation[0] = 0;
      t.rotation[1] = Math.sin(f.yaw / 2);
      t.rotation[2] = 0;
      t.rotation[3] = Math.cos(f.yaw / 2);
    }
  }

  /** World position by summing the parent chain (the runtime's hierarchy has no rotation here). */
  private worldOf(id: string): Vec3 | null {
    const t = this.host.curr.get(id);
    if (t === undefined) return null;
    const out: Vec3 = [t.position[0], t.position[1], t.position[2]];
    let parent = this.parents.get(id);
    for (let guard = 0; parent !== undefined && guard < 64; guard++) {
      const pt = this.host.curr.get(parent);
      if (pt === undefined) break;
      out[0] += pt.position[0];
      out[1] += pt.position[1];
      out[2] += pt.position[2];
      parent = this.parents.get(parent);
    }
    return out;
  }
}
