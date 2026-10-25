/**
 * One-way colliders on the 3D backend: a collider that holds only what comes
 * at it from the side its local +Y faces (its "up"). A platform is landed on
 * from above and passed from below and the sides; turned, it is a one-way
 * wall or ceiling; in a full 3D level it is a one-way floor.
 *
 * The rule is the same for a character's sweep and a body's contacts: the
 * collider counts only while the other shape's lowest point along the
 * platform's up is on or above the platform's top (within
 * `ONE_WAY_LANDING_TOLERANCE`) and it is not moving up through it. Measuring
 * positions rather than contact normals keeps a shape that is half way
 * through from being caught by the platform's top face.
 *
 * Rapier calls a sweep's filter and a contact hook from inside its WASM
 * step, where nothing may call back into the world, so every decision is
 * made before the sweep or the step and only looked up in the callback.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsVec3 } from '@thirdlight/runtime';

import { ONE_WAY_LANDING_TOLERANCE } from './constants';

/** A one-way collider's own facts: its top and how far it reaches from its body's origin, in the body's frame. */
export interface OneWayShape {
  /** The highest point of its shapes along the body's local +Y. */
  localTop: number;
  /** The radius around the body's origin that holds all its shapes. */
  reach: number;
}

/** A one-way collider in the world: its handle, body and own facts. */
export interface OneWayCollider extends OneWayShape {
  handle: number;
  body: RAPIER.RigidBody;
}

/**
 * The one-way colliders of a world for a character's sweep: listed when
 * colliders come or go, so a step visits only those (not every collider
 * through WASM), and the filter that leaves out the ones that do not hold a
 * capsule now.
 */
export class OneWaySweeps {
  private readonly list: OneWayCollider[] = [];
  private readonly refused = new Set<number>();
  private readonly keep = (c: RAPIER.Collider): boolean => !this.refused.has(c.handle);

  /** List the one-way colliders again from the world's collider records (in their order). */
  relist(infos: Iterable<[number, { body: RAPIER.RigidBody; oneWay?: OneWayShape }]>): void {
    this.list.length = 0;
    for (const [handle, info] of infos) if (info.oneWay !== undefined) this.list.push({ handle, body: info.body, localTop: info.oneWay.localTop, reach: info.oneWay.reach });
  }

  /**
   * The predicate that leaves out the one-way colliders not holding a
   * capsule (standing along Y) centred at `centre`, moving `moving` this
   * step (null: where it is only), or null when it is near none it passes.
   * The reach margin covers its move, skin, snap and step height and a metre.
   */
  filterFor(centre: PhysicsVec3, shape: { halfHeight: number; radius: number }, tuning: { offsetSkin: number; groundSnap: number; autostep: boolean; autostepHeight?: number }, moving: PhysicsVec3 | null, dropping: boolean): ((c: RAPIER.Collider) => boolean) | null {
    if (this.list.length === 0) return null;
    const m = moving ?? { x: 0, y: 0, z: 0 };
    const lift = tuning.autostep ? (tuning.autostepHeight ?? 0.25) : 0;
    const margin = shape.halfHeight + shape.radius + Math.hypot(m.x, m.y, m.z) + tuning.offsetSkin + tuning.groundSnap + lift + 1;
    const lowAlong = (u: PhysicsVec3): number => capsuleLowAlong(centre, shape.halfHeight, shape.radius, u);
    return refusedFor(this.list, { centre, margin, lowAlong, motion: m, dropping }, this.refused) ? this.keep : null;
  }
}

/** A body's local +Y in the world. */
export function upOf(body: RAPIER.RigidBody): PhysicsVec3 {
  const q = body.rotation();
  // The second column of the rotation matrix.
  return { x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) };
}

const dot = (a: PhysicsVec3, b: PhysicsVec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Whether the platform holds a shape whose lowest point along its up is `low`, moving `along` its up this step. */
export function holds(low: number, top: number, along: number): boolean {
  return along <= 1e-9 && low >= top - ONE_WAY_LANDING_TOLERANCE;
}

/** What a mover of a character's sweep or a body's step needs to know: where it is, its lowest point along a direction, how it moves. */
export interface OneWayMover {
  /** Its centre (for the reach test). */
  centre: PhysicsVec3;
  /** Its own radius around the centre plus how far it can move this step (the reach test's margin). */
  margin: number;
  /** Its lowest point along `u` (a unit vector). */
  lowAlong(u: PhysicsVec3): number;
  /** Its move (or velocity) this step; only the sign along a platform's up matters. */
  motion: PhysicsVec3;
  /** Passing through every one-way collider (a drop through). */
  dropping: boolean;
}

/**
 * The one-way colliders that do not hold this mover now, by collider
 * handle, written into `out` (cleared first). A collider farther than its
 * reach plus the mover's margin cannot be touched and is left out of it.
 * Returns whether any was refused.
 */
export function refusedFor(platforms: readonly OneWayCollider[], m: OneWayMover, out: Set<number>): boolean {
  out.clear();
  for (const p of platforms) {
    const t = p.body.translation();
    const dx = t.x - m.centre.x;
    const dy = t.y - m.centre.y;
    const dz = t.z - m.centre.z;
    const near = p.reach + m.margin;
    if (dx * dx + dy * dy + dz * dz > near * near) continue;
    if (m.dropping) {
      out.add(p.handle);
      continue;
    }
    const u = upOf(p.body);
    if (!holds(m.lowAlong(u), dot(t, u) + p.localTop, dot(m.motion, u))) out.add(p.handle);
  }
  return out.size > 0;
}

/** The lowest point along `u` of a capsule standing along world Y (a character's). */
export function capsuleLowAlong(centre: PhysicsVec3, halfHeight: number, radius: number, u: PhysicsVec3): number {
  return dot(centre, u) - (halfHeight * Math.abs(u.y) + radius);
}

/** Rotate `v` by a unit quaternion. */
function turn(q: RAPIER.Rotation, v: PhysicsVec3): PhysicsVec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
}

/**
 * The lowest point along `u` of one collider (its world pose): exact for a
 * box, ball, capsule and cylinder; a hull's points; any other shape its
 * centre less its bounding radius (conservative: it counts as lower).
 */
function colliderLowAlong(c: RAPIER.Collider, u: PhysicsVec3): number {
  const t = c.translation();
  const q = c.rotation();
  const centre = dot(t, u);
  const axisY = (): number => Math.abs(dot(turn(q, { x: 0, y: 1, z: 0 }), u));
  switch (c.shape.type) {
    case RAPIER.ShapeType.Cuboid: {
      const h = c.halfExtents() ?? { x: 0, y: 0, z: 0 };
      return centre - (h.x * Math.abs(dot(turn(q, { x: 1, y: 0, z: 0 }), u)) + h.y * axisY() + h.z * Math.abs(dot(turn(q, { x: 0, y: 0, z: 1 }), u)));
    }
    case RAPIER.ShapeType.Ball:
      return centre - c.radius();
    case RAPIER.ShapeType.Capsule:
      return centre - (c.halfHeight() * axisY() + c.radius());
    case RAPIER.ShapeType.Cylinder: {
      const a = axisY();
      return centre - (c.halfHeight() * a + c.radius() * Math.sqrt(Math.max(0, 1 - a * a)));
    }
    case RAPIER.ShapeType.ConvexPolyhedron: {
      const v = c.vertices();
      let low = Infinity;
      for (let i = 0; i + 2 < v.length; i += 3) low = Math.min(low, dot(turn(q, { x: v[i]!, y: v[i + 1]!, z: v[i + 2]! }), u));
      return centre + low;
    }
    default:
      return centre - boundOf(c);
  }
}

/**
 * One-way colliders in a world's contact pipeline: before each
 * `world.step(events, hooks)` (Rapier runs hooks only in a step with an
 * event queue), `prepare` decides for every moving
 * (dynamic) body near a one-way collider whether the collider holds it, and
 * the hook drops the contacts of the pairs it does not. A one-way collider
 * needs `ActiveHooks.FILTER_CONTACT_PAIRS` (`markOneWay`).
 */
export class OneWayContacts implements RAPIER.PhysicsHooks {
  /** The (one-way collider, body) pairs whose contacts are dropped this step, as `collider:body` handle keys. */
  private readonly dropped = new Set<string>();
  private readonly oneWay = new Set<number>();
  private readonly scratch = new Set<number>();

  /** Decide every pair for the next step: `bodies` are the moving bodies to test, `platforms` the one-way colliders. */
  prepare(platforms: readonly OneWayCollider[], bodies: readonly RAPIER.RigidBody[], dt: number): void {
    this.dropped.clear();
    this.oneWay.clear();
    for (const p of platforms) this.oneWay.add(p.handle);
    if (platforms.length === 0) return;
    for (const body of bodies) {
      if (!body.isDynamic()) continue;
      const colliders: RAPIER.Collider[] = [];
      for (let i = 0; i < body.numColliders(); i++) colliders.push(body.collider(i));
      const t = body.translation();
      const v = body.linvel();
      let radius = 0;
      for (const c of colliders) {
        const ct = c.translation();
        radius = Math.max(radius, Math.hypot(ct.x - t.x, ct.y - t.y, ct.z - t.z) + boundOf(c));
      }
      const mover: OneWayMover = {
        centre: { x: t.x, y: t.y, z: t.z },
        margin: radius + Math.hypot(v.x, v.y, v.z) * dt + 1,
        lowAlong: (u) => Math.min(...colliders.map((c) => colliderLowAlong(c, u))),
        motion: { x: v.x, y: v.y, z: v.z },
        dropping: false,
      };
      if (refusedFor(platforms, mover, this.scratch)) for (const h of this.scratch) this.dropped.add(`${h}:${body.handle}`);
    }
  }

  // Rapier hands the hook functions to its WASM on their own (not as methods), so they keep `this` as arrows.
  readonly filterContactPair = (collider1: number, collider2: number, body1: number, body2: number): RAPIER.SolverFlags | null => {
    if (this.oneWay.has(collider1) && this.dropped.has(`${collider1}:${body2}`)) return null;
    if (this.oneWay.has(collider2) && this.dropped.has(`${collider2}:${body1}`)) return null;
    return RAPIER.SolverFlags.COMPUTE_IMPULSE;
  };

  readonly filterIntersectionPair = (): boolean => true;
}

/** A generous bounding radius of one collider around its own centre. */
function boundOf(c: RAPIER.Collider): number {
  switch (c.shape.type) {
    case RAPIER.ShapeType.Cuboid: {
      const h = c.halfExtents() ?? { x: 0, y: 0, z: 0 };
      return Math.hypot(h.x, h.y, h.z);
    }
    case RAPIER.ShapeType.Ball:
      return c.radius();
    case RAPIER.ShapeType.Capsule:
      return c.halfHeight() + c.radius();
    case RAPIER.ShapeType.Cylinder:
      return Math.hypot(c.halfHeight(), c.radius());
    case RAPIER.ShapeType.ConvexPolyhedron: {
      const v = c.vertices();
      let r = 0;
      for (let i = 0; i + 2 < v.length; i += 3) r = Math.max(r, Math.hypot(v[i]!, v[i + 1]!, v[i + 2]!));
      return r;
    }
    default:
      return 64;
  }
}

/** A one-way collider's description: its contacts go through the filter. */
export function markOneWay(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
  return desc.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
}
