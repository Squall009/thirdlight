/**
 * Phase 9.9: the gameplay building blocks, run by the runtime every fixed
 * step (deterministic; a replay plays the same):
 *
 * - movers (and doors: movers that start on a signal) follow their waypoints;
 *   a mover with a collider is a kinematic platform, and the player standing
 *   on it moves with it;
 * - triggers and switches emit signals (seen by movers and scripts in the
 *   next step);
 * - pickups add to counters (coins, gems, keys, lives, custom) or heal, and
 *   disappear; `respawn: "death"` ones come back when the player respawns;
 * - enemies walk (between two offsets, or until a ledge or a wall), hurt the
 *   player on contact, and are stomped from above (the player bounces);
 * - the player's `health` takes damage from enemies and damaging hazards,
 *   with a short invulnerability; at 0 (or without a health component) the
 *   player dies as before.
 *
 * Boxes (triggers, switches, pickups) are centred on their entity; an enemy's
 * box stands on its entity's position (its feet).
 *
 * Phase 14.2: a trigger may be a circle (centred on its entity, tested
 * against the player's capsule itself), may emit its signal every step while
 * the player is inside (`mode: "stay"`), and records `enter`/`exit` events
 * that the scripts owning it read in the next step (`ctx.events`).
 *
 * Phase 23.1 (a 3D project, `host.physics3d`): movers are posed on the 3D
 * port (their full position and their entity's rotation) and carry and push
 * the player in 3D; colliders scripts drive are posed with them; triggers are
 * 3D volumes — a box (turned with its entity), a sphere or a capsule standing
 * along its entity's Y — tested exactly against the player's capsule. The 2D
 * plane's switches, pickups and enemies are refused in 3D by the project
 * model (they come with game modes), so the 3D step runs movers and triggers.
 */
import type { ActionFrame } from './actions';
import type { ColliderShape3D, KinematicPose3D, PhysicsPort, PhysicsPort3D, Vec2 } from './ports';
import { BLOCK_DEFAULTS, type EntityV3 } from '@thirdlight/project-model';
import type { BehaviorMessage, ModelBounds, PlayerCapsule, TransformState, TriggerEventRecord } from './types';
import { capsuleHalfTotal, colliderRotationZ, colliderShape3DOf } from './scene-set';

/**
 * Phase 19.1: script messages per step (`ctx.messages.send`): far above what
 * game logic sends in one step, small enough to bound the per-step lists.
 */
export const MAX_MESSAGES_PER_STEP = 256;

/**
 * Phase 15.3: every tuning value below is the component's data (health,
 * enemy, mover, pickup); `BLOCK_DEFAULTS` are the values used when a field is
 * absent — the constants every project played with before (replays stay
 * valid), except a pickup without a size, which now collects over its
 * model's recorded bounds (else 1 x 1 m) instead of 0.8 x 0.8 m.
 */
const D = BLOCK_DEFAULTS;

type Vec3 = [number, number, number];

interface Mover {
  id: string;
  points: Vec3[];
  lengths: number[];
  speed: number;
  mode: 'loop' | 'pingpong' | 'once';
  wait: number;
  smooth: boolean;
  startOn: string | null;
  // state
  started: boolean;
  segment: number;
  along: number;
  dir: 1 | -1;
  waiting: number;
  done: boolean;
  pos: Vec3;
  /** The box collider's half extents (a mover without one never pushes). */
  half: Vec2 | null;
  /** Phase 15.3: the most it pushes a player per step (its `maxPush` m/s over the step rate). */
  pushStep: number;
  /** Phase 23.0: its collider's rotation about Z (the entity's; a mover translates, it does not turn). */
  rotationZ: number;
  /** Phase 23.1 (3D): the entity's rotation, and its collider's box around its position (null: no collider). */
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
  /** Phase 14.2: a circle's radius (null: the box `half`). */
  radius: number | null;
  /** Phase 14.2: emit the signal every step while inside. */
  stay: boolean;
  inside: boolean;
  spent: boolean;
  /** Phase 23.1 (3D): the volume — a box's half extents with depth, a sphere, or a capsule (its centre-segment half length). */
  volume: { kind: 'box'; half: Vec3 } | { kind: 'sphere'; radius: number } | { kind: 'capsule'; radius: number; halfSegment: number };
}

interface Switch extends Box {
  signal: string;
  mode: 'interact' | 'stand';
  once: boolean;
  inside: boolean;
  spent: boolean;
}

interface Pickup extends Box {
  kind: string;
  value: number;
  counter: string | null;
  respawnOnDeath: boolean;
  cue: string | null;
  /** Phase 20.2: the effect played where it was when collected (null: none). */
  effect: string | null;
  taken: boolean;
}

interface Enemy {
  id: string;
  start: Vec3;
  x: number;
  dir: 1 | -1;
  patrol: 'points' | 'edges';
  range: [number, number];
  speed: number;
  half: Vec2;
  contactDamage: number;
  stompable: boolean;
  maxHealth: number;
  health: number;
  defeated: boolean;
  chase: number;
  /** Phase 15.3: the enemy's tuning (its data, else the defaults). */
  chaseHeight: number;
  /** Phase 24.0: the speed it runs at while chasing (its walking speed when not set). */
  chaseSpeed: number;
  /** Phase 24.0: it only notices a player it can see (nothing solid between them). */
  chaseSight: boolean;
  /** Phase 24.0: it only notices a player in the direction it is walking. */
  chaseFacing: boolean;
  /** Phase 24.0: steps to keep chasing after it last noticed the player. */
  chaseMemorySteps: number;
  /** Phase 24.0: while chasing it may leave its patrol range. */
  chaseBeyondPatrol: boolean;
  /** Phase 24.0: steps of chase left after it last noticed the player. */
  memory: number;
  stompBounce: number;
  stompTolerance: number;
  defeat: 'none' | 'squash' | 'fade';
  /** Steps the squash or fade takes (at least 1). */
  defeatSteps: number;
  wallProbe: number;
  ledgeProbe: number;
  /** Steps left of the defeat squash or fade (0: none running). */
  squash: number;
  /** The authored Y scale (the squash scales it). */
  scaleY: number;
  /** Phase 20.2: effects played where it is when a stomp hurts it and when it is defeated (null: none). */
  hitEffect: string | null;
  defeatEffect: string | null;
}

/** Phase 20.2: a request to the renderer's effect player (presentation only). */
export interface BlocksEffectRequest {
  op: 'play' | 'stop';
  effectId: string;
  entityId: string | null;
  position: Vec3;
  source: 'component' | 'pickup' | 'enemyHit' | 'enemyDefeat' | 'playerHit' | 'checkpoint' | 'goal';
}

export interface BlocksHost {
  readonly hz: number;
  readonly physics: PhysicsPort | undefined;
  readonly curr: Map<string, TransformState>;
  readonly playerId: string;
  /**
   * Phase 14.0: the player's capsule. The blocks test its bounding box: half
   * width `radius`, half height `halfHeight + radius`, centred at the
   * player's position plus `offset`.
   */
  readonly playerCapsule: PlayerCapsule;
  /** The player's committed position (the entity origin), or null. */
  player(): Vec2 | null;
  /** The player's motion in the last step (m per step). */
  playerDelta(): Vec2;
  /** The collider entity the player stands on, or null. */
  groundEntityId(): string | null;
  /** Kill the player (the session's respawn), only while playing. */
  kill(): void;
  /** Play an audio asset through the sfx bus (after the step). */
  playCue?(assetId: string): void;
  /** Phase 20.2: play or stop a visual effect (presentation only; the simulation never reads it back). */
  effect?(request: BlocksEffectRequest): void;
  /** The animator of an entity (or of one of its children), for parameters. */
  animator(entityId: string): { set(name: string, v: number | boolean): boolean; trigger(name: string): boolean } | null;
  /** Phase 15.3: the gap the player's controller keeps from the world (its `skin`; default 0.01 m). */
  readonly playerSkin?: number;
  /** Phase 15.3: a model asset's recorded bounds (from the asset's import metrics), or null. */
  modelBounds?(assetId: string): ModelBounds | null;
  /** Phase 23.1: the 3D port (a 3D project) — movers are posed on it and the blocks work in 3D. */
  readonly physics3d?: PhysicsPort3D;
  /** Phase 23.1 (3D): the player's committed position (the entity origin), or null. */
  player3?(): Vec3 | null;
  /** Phase 23.1 (3D): the player's capsule centre offset along Z. */
  readonly playerOffsetZ?: number;
  /** Phase 23.1 (3D): the colliders scripts drive, where they are now (posed as kinematic bodies with the movers). */
  scriptColliders3D?(): readonly { entityId: string; position: Vec3; rotation: readonly number[] }[];
}

// ---- phase 23.1: 3D geometry (pure, deterministic) ---------------------------

type V3 = readonly [number, number, number];

/** Rotate `p` by the unit quaternion `q` ([x, y, z, w]); `inverse` rotates by its conjugate. */
function rotate3(q: readonly number[], p: V3, inverse = false): Vec3 {
  const qx = inverse ? -(q[0] ?? 0) : (q[0] ?? 0);
  const qy = inverse ? -(q[1] ?? 0) : (q[1] ?? 0);
  const qz = inverse ? -(q[2] ?? 0) : (q[2] ?? 0);
  const qw = q[3] ?? 1;
  const [x, y, z] = p;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

const sub3 = (a: V3, b: V3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Squared distance from point `p` to segment `a`–`b`. */
export function segmentPointDistance2(a: V3, b: V3, p: V3): number {
  const ab = sub3(b, a);
  const len2 = dot3(ab, ab);
  const t = len2 > 0 ? clamp01(dot3(sub3(p, a), ab) / len2) : 0;
  const d = sub3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
  return dot3(d, d);
}

/** Squared distance between segments `p1`–`q1` and `p2`–`q2` (closest points, Ericson §5.1.9). */
export function segmentSegmentDistance2(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = sub3(q1, p1);
  const d2 = sub3(q2, p2);
  const r = sub3(p1, p2);
  const a = dot3(d1, d1);
  const e = dot3(d2, d2);
  const f = dot3(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) return dot3(r, r);
  if (a <= 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot3(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot3(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1: Vec3 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2: Vec3 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const d = sub3(c1, c2);
  return dot3(d, d);
}

/**
 * Squared distance from segment `a`–`b` to the box of half extents `half`
 * centred at the origin (axis-aligned; the caller works in the box's frame).
 * The distance along the segment is convex, so a fixed golden-section search
 * finds its minimum (80 rounds: far below a micrometre; deterministic).
 */
export function segmentBoxDistance2(a: V3, b: V3, half: V3): number {
  const at = (t: number): number => {
    let d = 0;
    for (let i = 0; i < 3; i += 1) {
      const v = a[i]! + (b[i]! - a[i]!) * t;
      const o = Math.abs(v) - half[i]!;
      if (o > 0) d += o * o;
    }
    return d;
  };
  const g = (Math.sqrt(5) - 1) / 2;
  let lo = 0;
  let hi = 1;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = at(x1);
  let f2 = at(x2);
  for (let i = 0; i < 80; i += 1) {
    if (f1 <= f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = at(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = at(x2);
    }
  }
  return Math.min(at(0), at(1), f1, f2);
}

/** Phase 23.1: the box around a resolved 3D collider shape turned by `q` (offsets from the body origin). */
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

/** The margin a pushing mover keeps beyond the controller's skin (0.01 + 0.001 = the old 0.011 m gap). */
const PUSH_MARGIN = 0.001;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Phase 21.2: the shared frozen empties of a quiet step. */
const NO_TRIGGER_EVENTS: readonly TriggerEventRecord[] = Object.freeze([]);
const NO_QUEUED_MESSAGES: readonly { message: BehaviorMessage; to: string | null }[] = Object.freeze([]);
const NO_MESSAGES: readonly BehaviorMessage[] = Object.freeze([]);
const NO_CARRY: Vec2 = Object.freeze({ x: 0, y: 0 });
const NO_CARRY3: Readonly<Vec3> = Object.freeze([0, 0, 0]) as unknown as Readonly<Vec3>;

export class GameplayBlocks {
  private readonly movers = new Map<string, Mover>();
  private readonly triggers = new Map<string, Trigger>();
  private readonly switches = new Map<string, Switch>();
  private readonly pickups = new Map<string, Pickup>();
  private readonly enemies = new Map<string, Enemy>();
  private readonly oneWay = new Set<string>();
  private readonly hazardDamage = new Map<string, number>();
  private readonly parents = new Map<string, string>();
  private readonly hidden = new Set<string>();
  /** Phase 9.13: models that face where their parent goes (yaw about +Y, radians). */
  private readonly facers = new Map<string, { right: number; left: number; rate: number; yaw: number; lastX: number | null }>();
  private readonly counters = new Map<string, number>();
  private health: { max: number; start: number; current: number; invulnerable: number; invulnerableUntil: number; knockback: number; hitBounce: number; knockbackSteps: number; hitEffect: string | null } | null = null;
  /** Phase 20.2: entities whose `effect` component (re)starts or stops on a signal. */
  private readonly effectTriggers = new Map<string, { effectId: string; signal: string | null; stop: string | null }>();
  /** Phase 20.2: checkpoint/goal zones' effects (played when reached). */
  private readonly zoneEffects = new Map<string, string>();
  /** Phase 15.3: fading entities (a defeated enemy with `defeat: "fade"`): id -> opacity 0-1. */
  private readonly opacity = new Map<string, number>();
  /** The gap a pushing mover keeps from the player (the controller's skin plus a margin). */
  private readonly pushSkin: number;
  /** A hit's push: m/s along X, steps left. */
  private knock = { v: 0, steps: 0, total: 0 };
  private signalsNow = new Set<string>();
  private signalsPrev = new Set<string>();
  /** Phase 14.2: triggers entered/left in this step, and in the previous one (what scripts see). */
  private triggerEventsNow: TriggerEventRecord[] = [];
  private triggerEventsPrev: readonly TriggerEventRecord[] = Object.freeze([]);
  /** Phase 19.1: script messages sent in this step, and in the previous one (what scripts see); `to` null = every script. */
  private messagesNow: { message: BehaviorMessage; to: string | null }[] = [];
  private messagesPrev: readonly { message: BehaviorMessage; to: string | null }[] = Object.freeze([]);
  private pendingBounce: number | null = null;
  private carry: Vec2 = { x: 0, y: 0 };
  /** Phase 23.1 (3D): the carried platform's motion (and pushes) this step, and where each script-driven collider was posed last. */
  private carry3: Readonly<Vec3> = NO_CARRY3;
  private readonly scriptPosed = new Map<string, Vec3>();
  private step = 0;
  /** Phase 14.0: the player capsule's box — centre offset from the player's position, half width, half height. */
  private readonly pc: { ox: number; oy: number; hw: number; hh: number };

  constructor(
    private readonly host: BlocksHost,
    entities: readonly EntityV3[],
  ) {
    const c = host.playerCapsule;
    this.pc = { ox: c.offset.x, oy: c.offset.y, hw: c.radius, hh: capsuleHalfTotal(c) };
    this.pushSkin = (host.playerSkin ?? 0.01) + PUSH_MARGIN;
    this.add(entities);
  }

  /**
   * Phase 15.3: a pickup's collect area without a `size` — its model's
   * recorded bounds (its own model, else a direct child's; width x height
   * scaled by the transforms), else the neutral 1 x 1 m.
   */
  private pickupSizeOf(e: EntityV3, childModels: Map<string, { assetId: string; scale: readonly number[] }>): [number, number] {
    const own = (e.components as { model?: { asset?: { assetId?: string } } }).model?.asset?.assetId;
    const pick = own !== undefined ? { assetId: own, scale: [1, 1, 1] as readonly number[] } : childModels.get(e.id);
    const b = pick !== undefined ? (this.host.modelBounds?.(pick.assetId) ?? null) : null;
    if (pick === undefined || b === null) return [D.pickupSize[0], D.pickupSize[1]];
    const s = e.components.transform.scale;
    const w = Math.abs((b.max[0] - b.min[0]) * (s[0] ?? 1) * (pick.scale[0] ?? 1));
    const h = Math.abs((b.max[1] - b.min[1]) * (s[1] ?? 1) * (pick.scale[1] ?? 1));
    return w > 0 && h > 0 ? [w, h] : [D.pickupSize[0], D.pickupSize[1]];
  }

  /** Entities of a loaded scene. */
  add(entities: readonly EntityV3[]): void {
    // Phase 15.3: the first model child of each entity (a pickup's visual is often a child).
    const childModels = new Map<string, { assetId: string; scale: readonly number[] }>();
    for (const e of entities) {
      const assetId = (e.components as { model?: { asset?: { assetId?: string } } }).model?.asset?.assetId;
      if (e.parentId !== undefined && assetId !== undefined && !childModels.has(e.parentId)) childModels.set(e.parentId, { assetId, scale: e.components.transform?.scale ?? [1, 1, 1] });
    }
    for (const e of entities) {
      if (e.parentId !== undefined) this.parents.set(e.id, e.parentId);
      const c = e.components as unknown as Record<string, Record<string, unknown> | undefined>;
      const p = e.components.transform.position;
      const zone = c['gameZone'];
      if (zone !== undefined && zone['role'] === 'hazard' && typeof zone['damage'] === 'number') this.hazardDamage.set(e.id, zone['damage'] as number);
      if (zone !== undefined && typeof zone['effect'] === 'string') this.zoneEffects.set(e.id, zone['effect'] as string);
      const col = c['collider'];
      if (col !== undefined && col['oneWay'] === true) this.oneWay.add(e.id);
      const face = c['faceMovement'];
      if (face !== undefined && e.parentId !== undefined) {
        const right = (num(face['yawRight'], 90) * Math.PI) / 180;
        const left = (num(face['yawLeft'], -90) * Math.PI) / 180;
        const turn = num(face['turnSeconds'], 0.12);
        const q = e.components.transform.rotation;
        this.facers.set(e.id, { right, left, rate: turn > 0 ? Math.abs(right - left) / turn : Infinity, yaw: 2 * Math.atan2(q[1] ?? 0, q[3] ?? 1), lastX: null });
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
          mode,
          wait: num(m['wait'], 0),
          smooth: m['easing'] === 'smooth',
          startOn: typeof m['startOn'] === 'string' ? (m['startOn'] as string) : null,
          started: typeof m['startOn'] !== 'string',
          segment: 0,
          along: 0,
          dir: 1,
          waiting: 0,
          done: false,
          pos: [...base],
          half: boxHalf(col),
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
        // Phase 23.1: the 3D volume (a 3D project; the model gives a box its depth, a capsule its height).
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
        });
      }
      const s = c['switch'];
      if (s !== undefined) {
        const size = s['size'] as number[];
        this.switches.set(e.id, { id: e.id, half: { x: size[0]! / 2, y: size[1]! / 2 }, signal: String(s['signal']), mode: s['mode'] as Switch['mode'], once: s['once'] === true, inside: false, spent: false });
      }
      const pk = c['pickup'];
      if (pk !== undefined) {
        const size = (pk['size'] as number[] | undefined) ?? this.pickupSizeOf(e, childModels);
        this.pickups.set(e.id, {
          id: e.id,
          half: { x: size[0]! / 2, y: size[1]! / 2 },
          kind: String(pk['kind']),
          value: num(pk['value'], 1),
          counter: typeof pk['counter'] === 'string' ? (pk['counter'] as string) : null,
          respawnOnDeath: pk['respawn'] === 'death',
          cue: typeof pk['cue'] === 'string' ? (pk['cue'] as string) : null,
          effect: typeof pk['effect'] === 'string' ? (pk['effect'] as string) : null,
          taken: false,
        });
      }
      const en = c['enemy'];
      if (en !== undefined) {
        const size = en['size'] as number[];
        const range = (en['range'] as number[] | undefined) ?? [0, 0];
        const health = num(en['health'], 1);
        const speed = num(en['speed'], 1);
        this.enemies.set(e.id, {
          id: e.id,
          start: [p[0], p[1], p[2]],
          x: p[0],
          dir: 1,
          patrol: en['patrol'] as Enemy['patrol'],
          range: [p[0] + range[0]!, p[0] + range[1]!],
          speed,
          half: { x: size[0]! / 2, y: size[1]! / 2 },
          contactDamage: num(en['contactDamage'], 1),
          stompable: en['stompable'] === true,
          maxHealth: health,
          health,
          defeated: false,
          chase: num(en['chase'], 0),
          chaseHeight: num(en['chaseHeight'], D.chaseHeight),
          // Phase 24.0: 0 means "the walking speed" (so an untouched enemy keeps its exact old feel).
          chaseSpeed: num(en['chaseSpeed'], 0) > 0 ? (en['chaseSpeed'] as number) : speed,
          chaseSight: en['chaseSight'] === true,
          chaseFacing: en['chaseFacing'] === true,
          chaseMemorySteps: Math.max(0, Math.round(num(en['chaseMemory'], D.chaseMemory) * this.host.hz)),
          chaseBeyondPatrol: en['chaseBeyondPatrol'] === true,
          memory: 0,
          stompBounce: num(en['stompBounce'], D.stompBounce),
          stompTolerance: num(en['stompTolerance'], D.stompTolerance),
          defeat: en['defeat'] === 'none' || en['defeat'] === 'fade' ? (en['defeat'] as 'none' | 'fade') : 'squash',
          defeatSteps: Math.max(1, Math.round(num(en['defeatTime'], D.defeatTime) * this.host.hz)),
          wallProbe: num(en['wallProbe'], D.wallProbe),
          ledgeProbe: num(en['ledgeProbe'], D.ledgeProbe),
          squash: 0,
          scaleY: e.components.transform.scale[1] ?? 1,
          hitEffect: typeof en['hitEffect'] === 'string' ? (en['hitEffect'] as string) : null,
          defeatEffect: typeof en['defeatEffect'] === 'string' ? (en['defeatEffect'] as string) : null,
        });
      }
      const h = c['health'];
      if (h !== undefined && e.id === this.host.playerId) {
        const max = num(h['max'], 3);
        const start = Math.min(max, num(h['start'], max));
        this.health = {
          max,
          start,
          current: start,
          invulnerable: num(h['invulnerableSeconds'], D.invulnerableSeconds),
          invulnerableUntil: -1,
          knockback: num(h['knockback'], 0),
          hitBounce: num(h['hitBounce'], D.hitBounce),
          knockbackSteps: Math.max(1, Math.round(num(h['knockbackTime'], D.knockbackTime) * this.host.hz)),
          hitEffect: typeof h['hitEffect'] === 'string' ? (h['hitEffect'] as string) : null,
        };
      }
      // Phase 20.2: an effect component that a signal starts or stops.
      const fx = c['effect'];
      if (fx !== undefined && (typeof fx['signal'] === 'string' || typeof fx['stopSignal'] === 'string')) {
        this.effectTriggers.set(e.id, { effectId: String(fx['effectId']), signal: typeof fx['signal'] === 'string' ? (fx['signal'] as string) : null, stop: typeof fx['stopSignal'] === 'string' ? (fx['stopSignal'] as string) : null });
      }
    }
  }

  /** Phase 23.1: a mover's 3D data — its entity's rotation and its collider's box (a 2D plane never reads them). */
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
      this.pickups.delete(id);
      this.enemies.delete(id);
      this.oneWay.delete(id);
      this.hazardDamage.delete(id);
      this.hidden.delete(id);
      this.opacity.delete(id);
      this.parents.delete(id);
      this.facers.delete(id);
      this.effectTriggers.delete(id);
      this.zoneEffects.delete(id);
    }
  }

  /** A new run (start/replay): everything back as authored. */
  resetRun(): void {
    for (const m of this.movers.values()) {
      Object.assign(m, { started: m.startOn === null, segment: 0, along: 0, dir: 1, waiting: 0, done: false, pos: [...m.points[0]!] });
      this.writeTransform(m.id, m.pos);
    }
    for (const t of this.triggers.values()) Object.assign(t, { inside: false, spent: false });
    for (const s of this.switches.values()) Object.assign(s, { inside: false, spent: false });
    for (const p of this.pickups.values()) p.taken = false;
    for (const e of this.enemies.values()) {
      this.writeSquash(e.id, e.scaleY);
      Object.assign(e, { x: e.start[0], dir: 1, health: e.maxHealth, defeated: false, squash: 0, memory: 0 });
      this.writeTransform(e.id, e.start);
    }
    this.hidden.clear();
    this.opacity.clear();
    this.counters.clear();
    if (this.health !== null) Object.assign(this.health, { current: this.health.start, invulnerableUntil: -1 });
    this.knock = { v: 0, steps: 0, total: 0 };
    this.signalsNow.clear();
    this.signalsPrev.clear();
    this.triggerEventsNow = [];
    this.triggerEventsPrev = Object.freeze([]);
    this.messagesNow = [];
    this.messagesPrev = Object.freeze([]);
    this.pendingBounce = null;
    this.carry = { x: 0, y: 0 };
    this.carry3 = NO_CARRY3;
    this.scriptPosed.clear();
  }

  /**
   * Phase 15.2: a spawn's facing — the face-movement models under `rootId`
   * (the player's) turn to it at once, as if the player had just moved that
   * way (a spawn without a facing leaves them as they are).
   */
  faceSpawn(rootId: string, facing: 'left' | 'right'): void {
    for (const [id, f] of this.facers) {
      let p = this.parents.get(id);
      let under = false;
      for (let guard = 0; p !== undefined && guard < 64; guard++) {
        if (p === rootId) {
          under = true;
          break;
        }
        p = this.parents.get(p);
      }
      if (!under) continue;
      f.yaw = facing === 'right' ? f.right : f.left;
      f.lastX = null;
      const t = this.host.curr.get(id);
      if (t !== undefined) {
        t.rotation[0] = 0;
        t.rotation[1] = Math.sin(f.yaw / 2);
        t.rotation[2] = 0;
        t.rotation[3] = Math.cos(f.yaw / 2);
      }
    }
  }

  /** The player respawned after a death: health back to full, some pickups back. */
  onRespawn(): void {
    if (this.health !== null) Object.assign(this.health, { current: this.health.start, invulnerableUntil: -1 });
    this.knock = { v: 0, steps: 0, total: 0 };
    for (const p of this.pickups.values()) {
      if (p.taken && p.respawnOnDeath) {
        p.taken = false;
        this.hidden.delete(p.id);
      }
    }
    this.pendingBounce = null;
  }

  // ---- queries ------------------------------------------------------------------

  /** A script shows or hides an entity (a new run shows everything again). */
  setVisible(entityId: string, visible: boolean): void {
    if (visible) this.hidden.delete(entityId);
    else this.hidden.add(entityId);
  }

  hiddenEntities(): ReadonlySet<string> {
    return this.hidden;
  }

  /** Phase 15.3: entities fading out (id -> opacity 0-1); the renderer applies it. */
  entityOpacity(): ReadonlyMap<string, number> {
    return this.opacity;
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

  /** Phase 9.11: what a save keeps of the run (collected pickups, defeated enemies, counters, health). */
  snapshotRun(): { counters: Record<string, number>; collected: string[]; defeated: string[]; health: number | null } {
    return {
      counters: this.countersView(),
      collected: [...this.pickups.values()].filter((p) => p.taken).map((p) => p.id).sort(),
      defeated: [...this.enemies.values()].filter((e) => e.defeated).map((e) => e.id).sort(),
      health: this.health?.current ?? null,
    };
  }

  /** Phase 9.11: a loaded save's run (after the fresh run began): pickups stay collected, enemies defeated. */
  restoreRun(run: { counters?: Record<string, number>; collected?: readonly string[]; defeated?: readonly string[]; health?: number | null }): void {
    for (const [k, v] of Object.entries(run.counters ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k) && Number.isFinite(v)) this.counters.set(k, v);
    for (const id of run.collected ?? []) {
      const p = this.pickups.get(id);
      if (p === undefined) continue;
      p.taken = true;
      this.hidden.add(id);
    }
    for (const id of run.defeated ?? []) {
      const e = this.enemies.get(id);
      if (e === undefined) continue;
      e.defeated = true;
      this.hidden.add(id);
    }
    if (this.health !== null && typeof run.health === 'number' && run.health >= 1) this.health.current = Math.min(this.health.max, Math.round(run.health));
  }

  healthView(): { current: number; max: number } | null {
    return this.health === null ? null : { current: this.health.current, max: this.health.max };
  }

  /** A signal emitted in the previous step (what consumers see this step). */
  signaled(name: string): boolean {
    return this.signalsPrev.has(name);
  }

  emit(name: string): void {
    this.signalsNow.add(name);
  }

  /** Phase 14.2: the triggers the player entered or left in the previous step (in trigger order). */
  triggerEvents(): readonly TriggerEventRecord[] {
    return this.triggerEventsPrev;
  }

  /** Phase 19.1: queue a script message for the next step; false at the step's limit. */
  sendMessage(message: BehaviorMessage, to: string | null): boolean {
    if (this.messagesNow.length >= MAX_MESSAGES_PER_STEP) return false;
    this.messagesNow.push({ message: Object.freeze({ ...message }), to });
    return true;
  }

  /** Phase 19.1: the messages of `name` sent in the previous step to every script or to `to`, in send order. */
  messagesFor(to: string, name: string): readonly BehaviorMessage[] {
    // Phase 21.2: no messages last step (the usual case) answers with one shared empty list.
    if (this.messagesPrev.length === 0) return NO_MESSAGES;
    const out: BehaviorMessage[] = [];
    for (const m of this.messagesPrev) if (m.message.name === name && (m.to === null || m.to === to)) out.push(m.message);
    return Object.freeze(out);
  }

  /** The upward speed to give the player this step (a stomp or a hit), once. */
  takeBounce(): number | null {
    const b = this.pendingBounce;
    this.pendingBounce = null;
    return b;
  }

  /** The carried platform's motion this step (added to the player's staged move). */
  carryDelta(): Vec2 {
    return this.carry;
  }

  /** Phase 23.1 (3D): the carried platform's motion (and a mover's push) this step, added to the player's move. */
  carryDelta3(): Readonly<Vec3> {
    return this.carry3;
  }

  isOneWay(entityId: string | null): boolean {
    return entityId !== null && this.oneWay.has(entityId);
  }

  // ---- the step --------------------------------------------------------------------

  /** Start of a step: signals turn over, movers advance (their colliders are posed for physics). */
  beforeStep(stepIndex: number): void {
    this.step = stepIndex;
    // Phase 21.2: the two signal sets swap (the new current one is cleared only
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
    // Phase 20.2: effect components started or stopped by last step's signals (entity order: deterministic).
    if (this.effectTriggers.size > 0 && this.signalsPrev.size > 0) {
      for (const [id, t] of this.effectTriggers) {
        if (t.stop !== null && this.signalsPrev.has(t.stop)) this.host.effect?.({ op: 'stop', effectId: '', entityId: id, position: [0, 0, 0], source: 'component' });
        if (t.signal !== null && this.signalsPrev.has(t.signal)) this.host.effect?.({ op: 'play', effectId: t.effectId, entityId: id, position: [0, 0, 0], source: 'component' });
      }
    }
    if (this.host.physics3d !== undefined) {
      this.beforeStep3D(this.host.physics3d);
      return;
    }
    if (this.movers.size === 0 && this.knock.steps <= 0) {
      // Nothing moves the player this step: no carry, no poses.
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
    const player = this.host.player();
    const pushed = { x: 0, y: 0 };
    // Phase 14.7: a mover moving mostly upward pushes a player beside or
    // under it (the capsule's centre below the mover's top) out sideways, away
    // from the mover, never up — a rising gate or pillar does not lift a
    // player pressing against it; only a player above it is scooped up.
    const push = (m: Mover, before: Vec3): void => {
      if (player === null || m.half === null) return;
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
    for (const m of this.movers.values()) {
      const before: Vec3 = [...m.pos];
      if (!m.started && m.startOn !== null && this.signalsPrev.has(m.startOn)) m.started = true;
      if (m.started && !m.done) this.advance(m, dt);
      this.writeTransform(m.id, m.pos);
      poses.push({ entityId: m.id, position: { x: m.pos[0], y: m.pos[1] }, rotationZ: m.rotationZ });
      if (ground === m.id) this.carry = { x: m.pos[0] - before[0], y: m.pos[1] - before[1] };
      else if (m.pos[0] !== before[0] || m.pos[1] !== before[1]) push(m, before);
    }
    // A hit's knockback: a horizontal push that eases out over the health's knockback time.
    if (this.knock.steps > 0) {
      pushed.x += (this.knock.v * dt * this.knock.steps) / this.knock.total;
      this.knock.steps -= 1;
    }
    this.carry = { x: this.carry.x + pushed.x, y: this.carry.y + pushed.y };
    if (poses.length > 0) this.host.physics?.setKinematicPositions?.(poses);
  }

  /**
   * Phase 23.1: the 3D mover step. Movers advance and are posed on the 3D
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
    const player = this.host.player3?.() ?? null;
    const oz = this.host.playerOffsetZ ?? 0;
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
      const before: Vec3 = [...m.pos];
      if (!m.started && m.startOn !== null && this.signalsPrev.has(m.startOn)) m.started = true;
      if (m.started && !m.done) this.advance(m, dt);
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
    if (m.waiting > 0) {
      m.waiting = Math.max(0, m.waiting - dt);
      return;
    }
    let budget = m.speed * dt;
    for (let guard = 0; guard < 64 && budget > 1e-12; guard++) {
      const len = m.lengths[m.segment] ?? 0;
      const remaining = m.dir === 1 ? len - m.along : m.along;
      if (budget < remaining) {
        m.along += m.dir * budget;
        budget = 0;
        break;
      }
      budget -= remaining;
      m.along = m.dir === 1 ? len : 0;
      // At a point: wait, then pick the next segment.
      const atEnd = m.dir === 1 ? m.segment === m.lengths.length - 1 : m.segment === 0;
      if (m.mode === 'loop') {
        m.segment = (m.segment + 1) % m.lengths.length;
        m.along = 0;
      } else if (atEnd) {
        if (m.mode === 'once') {
          m.done = true;
          break;
        }
        m.dir = m.dir === 1 ? -1 : 1;
      } else {
        m.segment += m.dir;
        m.along = m.dir === 1 ? 0 : m.lengths[m.segment] ?? 0;
      }
      if (m.wait > 0) {
        m.waiting = m.wait;
        budget = 0;
      }
    }
    const len = m.lengths[m.segment] ?? 0;
    const a = m.points[m.segment]!;
    const b = m.points[(m.segment + 1) % m.points.length]!;
    let u = len > 0 ? m.along / len : 0;
    if (m.smooth) u = u * u * (3 - 2 * u);
    m.pos = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }

  /** After physics: overlaps with the player, enemies, pickups, switches, damage. */
  afterPhysics(frame: ActionFrame, playing: boolean): void {
    if (this.host.physics3d !== undefined) {
      if (playing) this.triggers3D();
      return;
    }
    const dt = 1 / this.host.hz;
    this.moveEnemies(dt);
    this.turnFacers(dt);
    const player = this.host.player();
    if (player === null || !playing) return;
    const overlaps = (id: string, half: Vec2, feetAnchored = false): boolean => {
      const at = this.worldOf(id);
      if (at === null) return false;
      const cy = feetAnchored ? at[1] + half.y : at[1];
      return Math.abs(player.x + this.pc.ox - at[0]) < half.x + this.pc.hw && Math.abs(player.y + this.pc.oy - cy) < half.y + this.pc.hh;
    };
    // Phase 14.2: a circle against the capsule itself (a segment of half
    // length halfHeight − radius, swept by the radius): the distance from the
    // circle's centre to the segment is under the two radii.
    const segHalf = Math.max(0, this.pc.hh - this.pc.hw);
    const inCircle = (id: string, r: number): boolean => {
      const at = this.worldOf(id);
      if (at === null) return false;
      const cx = player.x + this.pc.ox;
      const cy = player.y + this.pc.oy;
      const ny = Math.min(cy + segHalf, Math.max(cy - segHalf, at[1]));
      return Math.hypot(at[0] - cx, at[1] - ny) < r + this.pc.hw;
    };
    for (const t of this.triggers.values()) this.updateTrigger(t, t.radius !== null ? inCircle(t.id, t.radius) : overlaps(t.id, t.half));
    const interact = frame.actions?.['interact']?.p === 'pressed';
    for (const s of this.switches.values()) {
      const inside = overlaps(s.id, s.half);
      const fire = s.mode === 'stand' ? inside && !s.inside : inside && interact;
      if (fire && !s.spent) {
        this.emit(s.signal);
        if (s.once) s.spent = true;
      }
      s.inside = inside;
    }
    for (const p of this.pickups.values()) {
      if (p.taken || !overlaps(p.id, p.half)) continue;
      p.taken = true;
      this.hidden.add(p.id);
      if (p.cue !== null) this.host.playCue?.(p.cue);
      if (p.effect !== null) this.playAt(p.effect, p.id, 'pickup');
      if (p.kind === 'heart') {
        if (this.health !== null) this.health.current = Math.min(this.health.max, this.health.current + p.value);
      } else {
        const name = p.kind === 'custom' ? (p.counter ?? 'custom') : p.kind === 'life' ? 'lives' : `${p.kind}s`;
        this.addCounter(name, p.value);
      }
    }
    const delta = this.host.playerDelta();
    for (const e of this.enemies.values()) {
      if (e.defeated || !overlaps(e.id, e.half, true)) continue;
      const at = this.worldOf(e.id)!;
      const top = at[1] + 2 * e.half.y;
      const feetBefore = player.y + this.pc.oy - delta.y - this.pc.hh;
      if (e.stompable && delta.y < 0 && feetBefore >= top - e.stompTolerance) {
        e.health -= 1;
        this.pendingBounce = e.stompBounce;
        if (e.hitEffect !== null) this.playAt(e.hitEffect, e.id, 'enemyHit');
        const anim = this.host.animator(e.id);
        anim?.trigger('hurt');
        if (e.health <= 0) {
          e.defeated = true;
          // Phase 15.3: squash or fade over its defeat time; `none`: gone at once.
          if (e.defeat === 'none') this.hidden.add(e.id);
          else e.squash = e.defeatSteps;
          anim?.set('defeated', true);
          this.host.animator(e.id)?.set('attacking', false);
          this.addCounter('defeated', 1);
          if (e.defeatEffect !== null) this.playAt(e.defeatEffect, e.id, 'enemyDefeat');
        }
      } else if (e.contactDamage > 0) {
        this.damage(e.contactDamage, at[0]);
      }
    }
  }

  /** A trigger's signals and events for this step's inside test (the 2D plane's and 3D's shared rules). */
  private updateTrigger(t: Trigger, inside: boolean): void {
    if (inside && (!t.inside || t.stay) && !t.spent) {
      this.emit(t.signal);
      if (t.once) t.spent = true;
    }
    if (!inside && t.inside && t.exitSignal !== null) this.emit(t.exitSignal);
    // Phase 14.2: every real entry and exit (whatever `once` says about the signal).
    // `stepIndex` counts as scripts' `ctx.stepIndex` does (this.step is the 1-based ordinal).
    if (inside !== t.inside) this.triggerEventsNow.push(Object.freeze({ type: inside ? 'enter' : 'exit', trigger: t.id, stepIndex: this.step - 1 }));
    t.inside = inside;
  }

  /**
   * Phase 23.1: the 3D triggers after physics. The player is its capsule —
   * a segment of half length `halfHeight` along Y through its centre, swept
   * by its radius — tested exactly against each volume at its entity's world
   * position (the parents' offsets summed, as in 2D): a sphere by the
   * segment's distance to its centre, a capsule by segment-to-segment
   * distance (standing along the trigger's own Y, turned with it), a box by
   * the segment's distance to it in the box's own frame. Inside is strictly
   * closer than the radii (a touch is outside, as in 2D).
   */
  private triggers3D(): void {
    const p = this.host.player3?.() ?? null;
    if (p === null) return;
    const seg = Math.max(0, this.pc.hh - this.pc.hw);
    const c: Vec3 = [p[0] + this.pc.ox, p[1] + this.pc.oy, p[2] + (this.host.playerOffsetZ ?? 0)];
    const a: Vec3 = [c[0], c[1] - seg, c[2]];
    const b: Vec3 = [c[0], c[1] + seg, c[2]];
    const r = this.pc.hw;
    for (const t of this.triggers.values()) {
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

  private moveEnemies(dt: number): void {
    const player = this.host.player();
    for (const e of this.enemies.values()) {
      if (e.defeated) {
        // The defeat: squash toward the feet (or fade out), then gone.
        if (e.squash > 0) {
          e.squash -= 1;
          const total = e.defeatSteps;
          if (e.defeat === 'fade') this.opacity.set(e.id, e.squash / total);
          else this.writeSquash(e.id, e.scaleY * (0.15 + (0.85 * e.squash) / total));
          if (e.squash === 0) {
            this.hidden.add(e.id);
            this.opacity.delete(e.id);
          }
        }
        continue;
      }
      // Chase: notice a player within range, in front (`chaseFacing`), within its
      // sight (`chaseSight`); keep running them down for `chaseMemory` after that.
      let chasing = false;
      if (e.chase > 0 && player !== null) {
        const dx = player.x + this.pc.ox - e.x;
        const feet = player.y + this.pc.oy - this.pc.hh;
        const near = Math.abs(dx) <= e.chase && Math.abs(feet - e.start[1]) <= e.chaseHeight && Math.abs(dx) > 0.05;
        const inFront = !e.chaseFacing || dx * e.dir > 0;
        if (near && inFront && (!e.chaseSight || this.enemySight(e, player))) {
          e.dir = dx > 0 ? 1 : -1;
          e.memory = e.chaseMemorySteps;
          chasing = true;
        } else if (e.memory > 0) {
          // It remembers roughly where the player was and keeps coming.
          e.memory -= 1;
          if (Math.abs(dx) > 0.05) e.dir = dx > 0 ? 1 : -1;
          chasing = true;
        }
      }
      this.host.animator(e.id)?.set('attacking', chasing);
      const speed = chasing ? e.chaseSpeed : e.speed;
      this.host.animator(e.id)?.set('speed', speed);
      const step = speed * dt * e.dir;
      let next = e.x + step;
      // A points patrol holds it inside its range — unless it is chasing and may
      // leave its post; a chase that ended outside walks back in.
      if (e.patrol === 'points' && !(chasing && e.chaseBeyondPatrol)) {
        if (e.x < e.range[0]) {
          e.dir = 1;
          next = e.x + speed * dt;
        } else if (e.x > e.range[1]) {
          e.dir = -1;
          next = e.x - speed * dt;
        } else if (next > e.range[1]) {
          next = e.range[1];
          e.dir = -1;
        } else if (next < e.range[0]) {
          next = e.range[0];
          e.dir = 1;
        }
      }
      // A wall or a ledge ahead stops it — an edge walker always, a chaser too
      // (it never walks through a wall or off a platform).
      if ((chasing || e.patrol === 'edges') && this.host.physics?.raycast !== undefined) {
        const y = e.start[1];
        const front = e.x + e.dir * e.half.x;
        // Phase 15.3: the probe distances are the enemy's data (defaults 0.05 m ahead, 0.4 m down).
        const wall = this.host.physics.raycast({ x: e.x, y: y + e.half.y }, { x: e.dir, y: 0 }, e.half.x + Math.abs(next - e.x) + e.wallProbe);
        const floor = this.host.physics.raycast({ x: front + e.dir * e.wallProbe, y: y + 0.1 }, { x: 0, y: -1 }, e.ledgeProbe);
        if (wall !== null || floor === null) {
          e.dir = e.dir === 1 ? -1 : 1;
          next = e.x;
        }
      }
      e.x = next;
      this.writeTransform(e.id, [e.x, e.start[1], e.start[2]]);
    }
  }

  /**
   * Phase 24.0: can the enemy see the player? A ray from its eye to the player's
   * middle: a wall or a platform edge between them blocks it (the player's own
   * collider is never hit by a raycast, so a clear ray is a clear view).
   */
  private enemySight(e: Enemy, player: Vec2): boolean {
    const physics = this.host.physics;
    if (physics?.raycast === undefined) return true;
    const from = { x: e.x, y: e.start[1] + e.half.y };
    const to = { x: player.x + this.pc.ox, y: player.y + this.pc.oy };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (!(distance > 0.05)) return true;
    const hit = physics.raycast(from, { x: dx, y: dy }, distance);
    return hit === null || hit.distance >= distance - 1e-6;
  }

  /** Damage the player (from `fromX`: a knockback pushes away from it); without a health component any damage kills. */
  damage(amount: number, fromX?: number): 'alive' | 'dead' {
    if (amount <= 0) return 'alive';
    if (this.health === null) {
      this.host.kill();
      return 'dead';
    }
    if (this.step < this.health.invulnerableUntil) return 'alive';
    this.health.current = Math.max(0, this.health.current - amount);
    this.health.invulnerableUntil = this.step + Math.round(this.health.invulnerable * this.host.hz);
    this.host.animator(this.host.playerId)?.trigger('hurt');
    if (this.health.hitEffect !== null) this.playAt(this.health.hitEffect, this.host.playerId, 'playerHit');
    if (this.health.current === 0) {
      this.host.kill();
      return 'dead';
    }
    this.pendingBounce = this.health.hitBounce;
    const player = this.host.player();
    if (this.health.knockback > 0 && fromX !== undefined && player !== null) {
      const total = this.health.knockbackSteps;
      // Twice the speed at the start, easing to zero: the mean is `knockback`.
      this.knock = { v: 2 * this.health.knockback * (player.x >= fromX ? 1 : -1), steps: total, total };
    }
    return 'alive';
  }

  /**
   * A hazard zone touched: with `damage` (and a player health) it hurts —
   * 'handled' (the player may still die of it); else 'kill' (the session's
   * plain respawn, with the zone).
   */
  hazard(zoneId: string | undefined): 'handled' | 'kill' {
    const damage = zoneId !== undefined ? this.hazardDamage.get(zoneId) : undefined;
    if (damage === undefined || damage <= 0 || this.health === null) return 'kill';
    this.damage(damage);
    return 'handled';
  }

  private writeSquash(id: string, sy: number): void {
    const t = this.host.curr.get(id);
    if (t === undefined) return;
    t.scale[1] = sy;
  }

  private writeTransform(id: string, pos: readonly number[]): void {
    const t = this.host.curr.get(id);
    if (t === undefined) return;
    t.position[0] = pos[0]!;
    t.position[1] = pos[1]!;
    t.position[2] = pos[2]!;
  }

  /** World position by summing the parent chain (the runtime's hierarchy has no rotation here). */
  /** Phase 9.13: each facing model turns toward its parent's horizontal motion (it keeps its yaw while the parent stands). */
  private turnFacers(dt: number): void {
    for (const [id, f] of this.facers) {
      const parent = this.parents.get(id);
      const at = parent !== undefined ? this.worldOf(parent) : null;
      if (at === null) continue;
      const dx = f.lastX === null ? 0 : at[0] - f.lastX;
      f.lastX = at[0];
      const target = dx > 1e-4 ? f.right : dx < -1e-4 ? f.left : null;
      if (target !== null && target !== f.yaw) {
        const step = f.rate * dt;
        f.yaw = Math.abs(target - f.yaw) <= step ? target : f.yaw + Math.sign(target - f.yaw) * step;
      }
      const t = this.host.curr.get(id);
      if (t !== undefined) {
        t.rotation[0] = 0;
        t.rotation[1] = Math.sin(f.yaw / 2);
        t.rotation[2] = 0;
        t.rotation[3] = Math.cos(f.yaw / 2);
      }
    }
  }

  /** Phase 20.2: a checkpoint or goal reached: its zone's effect where the zone is (no effect: nothing). */
  zoneReached(zoneId: string, source: 'checkpoint' | 'goal'): void {
    const effectId = this.zoneEffects.get(zoneId);
    const at = effectId !== undefined ? this.worldOf(zoneId) : null;
    if (effectId !== undefined && at !== null) this.host.effect?.({ op: 'play', effectId, entityId: null, position: at, source });
  }

  /** Phase 20.2: play an effect where an entity is now (world position; it does not follow the entity). */
  private playAt(effectId: string, entityId: string, source: BlocksEffectRequest['source']): void {
    const at = this.worldOf(entityId);
    if (at !== null) this.host.effect?.({ op: 'play', effectId, entityId: null, position: at, source });
  }

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
