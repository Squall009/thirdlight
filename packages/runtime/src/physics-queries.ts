/**
 * The physics queries of scripts and engine modules (`ctx.physics`: rays,
 * overlaps and picks) with the step's shared query budget. A query takes
 * [x, y, z] arrays in the world, or {x, y} on the caller's plane.
 *
 * Each call into a physics port is the engine's own work: a port that
 * throws (a Rapier panic, a broken world) is a `PhysicsPortFailure`, which
 * fails the run like any other port failure, even when the query came
 * from a script, instead of reading as that script's error.
 */
import type { LiveTagIndex } from './scene-set';
import type { PlayerControllers } from './player-controllers';
import { PhysicsPortFailure } from './player-controllers';
import { messageOf } from './behavior-errors';
import { colliderEntityOf, PHYSICS_QUERY_LIMIT, PLANE_QUERY_HALF_DEPTH, queryDistance, queryPositive, queryQuat, queryVec2, queryVec3 } from './physics-query-args';
import { planeCoords, planePoint, planeVector } from '@thirdlight/project-model';
import type { CharacterMoveResult, CharacterState3D, OverlapShape3D, PhysicsHit, PhysicsPlane, PhysicsPort, PhysicsPort3D, PhysicsQuat, PhysicsQueryFilter3D, PhysicsStepClient, RaycastHit, Vec2 } from './ports';
import type { PointerSample } from './actions';
import type { RuntimeViews } from './views';
import type { RuntimeGrid } from './grid';
import type { PlaneLocks } from './plane-locks';

/** What the queries read of the runtime (read at each call: the runtime makes its parts after this). */
export interface PhysicsQueryHost {
  readonly physics: PhysicsPort | undefined;
  readonly physics3d: PhysicsPort3D | undefined;
  readonly controllers: PlayerControllers;
  readonly views: RuntimeViews;
  readonly grid: RuntimeGrid;
  readonly tags: LiveTagIndex | null;
  readonly planes: PlaneLocks;
  /** The pointer as the step sees it (picks under it). */
  pointer(): PointerSample | null;
  stepIndex(): number;
  /** A line in the play log. */
  warn(message: string): void;
}

/** One call into a physics port: its throw is the engine's failure, not the caller's. */
function portCall<T>(what: string, call: () => T): T {
  try {
    return call();
  } catch (e) {
    throw new PhysicsPortFailure('threw', `physics port ${what}() threw: ${messageOf(e)}`);
  }
}

/** The plane of a caller locked to none. */
const Z_PLANE: PhysicsPlane = Object.freeze({ axis: 'z', origin: 0 });
const HALF_TURN = Math.SQRT1_2;
/** A cylinder (standing along Y) turned to lie along Z, and along X. */
const CYLINDER_ALONG_Z: PhysicsQuat = Object.freeze({ x: HALF_TURN, y: 0, z: 0, w: HALF_TURN });
const CYLINDER_ALONG_X: PhysicsQuat = Object.freeze({ x: 0, y: 0, z: HALF_TURN, w: HALF_TURN });

/** Each shared client's queries (a script's view is made from them). */
const OWNERS = new WeakMap<PhysicsStepClient, PhysicsQueries>();

/** A script's `ctx.physics`: `client` with its 2D queries on the plane of the script's object. */
export function physicsOfCaller(client: PhysicsStepClient, entityId: string): PhysicsStepClient {
  return OWNERS.get(client)?.forCaller(entityId) ?? client;
}

export class PhysicsQueries {
  /** Queries this step (rays and overlaps, 2D and 3D). */
  private used = 0;
  /** The 3D budget ran out once (warned in the play log). */
  private warned = false;

  constructor(private readonly h: PhysicsQueryHost) {
    OWNERS.set(this.client, this);
  }

  /** A new step: the budget is whole again. */
  beginStep(): void {
    this.used = 0;
  }

  readonly client: PhysicsStepClient = {
    stageCharacterMove: (entityId: string, delta: Vec2): void => this.h.controllers.stage(entityId, delta),
    // In 3D the 3D result (its vectors carry z too); a call naming no controller means the first.
    characterResult: (entityId?: string): CharacterMoveResult | undefined => {
      const id = this.h.controllers.resolve(entityId);
      return id !== undefined ? this.h.controllers.result(id) : undefined;
    },
    setPlane: (entityId: string, plane: PhysicsPlane | null): boolean => this.h.planes.request(entityId, plane),
    planeOf: (entityId: string): PhysicsPlane | null => (typeof entityId === 'string' ? this.h.planes.planeOf(entityId) : null),
    characterState: (entityId?: string): CharacterState3D | undefined => {
      const id = this.h.controllers.resolve(entityId);
      return id !== undefined ? this.h.controllers.characterState(id) : undefined;
    },
    // 3D: rays, overlaps and picks with filters; at most PHYSICS_QUERY_LIMIT a step.
    raycast3d: (origin: readonly number[], direction: readonly number[], maxDistance?: number, filter?: unknown) => {
      const o = queryVec3(origin, 'raycast3d origin');
      const d = queryVec3(direction, 'raycast3d direction');
      return this.castRay3D(o, d, queryDistance(maxDistance, 100, 'raycast3d'), filter);
    },
    overlapSphere: (center: readonly number[], radius: number, filter?: unknown): string[] =>
      this.overlap3D({ type: 'sphere', radius: queryPositive(radius, 'overlapSphere radius') }, queryVec3(center, 'overlapSphere center'), undefined, filter),
    overlapBox3d: (center: readonly number[], half: readonly number[], rotation?: readonly number[], filter?: unknown): string[] => {
      const h = queryVec3(half, 'overlapBox3d half');
      return this.overlap3D({ type: 'box', hx: queryPositive(h[0], 'overlapBox3d half x'), hy: queryPositive(h[1], 'overlapBox3d half y'), hz: queryPositive(h[2], 'overlapBox3d half z') }, queryVec3(center, 'overlapBox3d center'), queryQuat(rotation, 'overlapBox3d rotation'), filter);
    },
    overlapCapsule: (center: readonly number[], radius: number, height: number, rotation?: readonly number[], filter?: unknown): string[] => {
      const r = queryPositive(radius, 'overlapCapsule radius');
      const h = queryPositive(height, 'overlapCapsule height');
      return this.overlap3D({ type: 'capsule', radius: r, halfHeight: Math.max(0, h / 2 - r) }, queryVec3(center, 'overlapCapsule center'), queryQuat(rotation, 'overlapCapsule rotation'), filter);
    },
    pickAt: (x: number, y: number, maxDistance?: number, filter?: unknown) => {
      if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) throw new Error('pickAt takes a screen point x, y (numbers, 0-1 from the top left)');
      const ray = this.h.views.screenRay(x, y);
      return this.castRay3D(ray.origin, ray.direction, queryDistance(maxDistance, 1000, 'pickAt'), filter);
    },
    pickAtPointer: (maxDistance?: number, filter?: unknown) => {
      const max = queryDistance(maxDistance, 1000, 'pickAtPointer');
      const p = this.h.pointer();
      if (p === null || (p.over === false && p.locked !== true)) return null;
      const ray = p.locked === true ? this.h.views.screenRay(0.5, 0.5) : this.h.views.screenRay(p.x, p.y);
      return this.castRay3D(ray.origin, ray.direction, max, filter);
    },
    // Engine modules have no calling object: their 2D forms run on the default plane.
    raycast: ((origin: unknown, direction: unknown, maxDistance?: number, filter?: unknown) => this.raycast(undefined, origin, direction, maxDistance, filter)) as PhysicsStepClient['raycast'],
    overlapBox: ((center: unknown, half: unknown, a3?: unknown, a4?: unknown) => this.overlapBox(undefined, center, half, a3, a4)) as PhysicsStepClient['overlapBox'],
    overlapCircle: (center: Vec2, radius: number, filter?: unknown): string[] => this.overlapCircle(undefined, center, radius, filter),
  };

  /**
   * The client a script's `ctx.physics` is: the shared one, with the 2D
   * forms of the queries on the plane its object is locked to.
   */
  forCaller(entityId: string): PhysicsStepClient {
    return Object.freeze({
      ...this.client,
      raycast: ((origin: unknown, direction: unknown, maxDistance?: number, filter?: unknown) => this.raycast(entityId, origin, direction, maxDistance, filter)) as PhysicsStepClient['raycast'],
      overlapBox: ((center: unknown, half: unknown, a3?: unknown, a4?: unknown) => this.overlapBox(entityId, center, half, a3, a4)) as PhysicsStepClient['overlapBox'],
      overlapCircle: (center: Vec2, radius: number, filter?: unknown): string[] => this.overlapCircle(entityId, center, radius, filter),
    });
  }

  /** The plane a caller's 2D queries run on: the one its object is locked to, else the world's Z plane at 0. */
  private planeFor(caller: string | undefined): PhysicsPlane {
    return (caller !== undefined ? this.h.planes.planeOf(caller) : null) ?? Z_PLANE;
  }

  /** A ray: [x, y, z] arrays are a 3D ray; {x, y} a ray on the caller's plane. */
  private raycast(caller: string | undefined, origin: unknown, direction: unknown, maxDistance: unknown, filter: unknown): RaycastHit | PhysicsHit | null {
    if (Array.isArray(origin)) return this.castRay3D(queryVec3(origin, 'raycast origin'), queryVec3(direction, 'raycast direction'), queryDistance(maxDistance, 100, 'raycast'), filter);
    if (this.h.physics3d === undefined) {
      // The 2D port (a 2D project): its own plane, unfiltered.
      if (this.used >= PHYSICS_QUERY_LIMIT || this.h.physics?.raycast === undefined) return null;
      this.used += 1;
      return portCall('raycast', () => this.h.physics!.raycast!(origin as Vec2, direction as Vec2, Number(maxDistance)));
    }
    const plane = this.planeFor(caller);
    const o = queryVec2(origin, 'raycast origin');
    const d = queryVec2(direction, 'raycast direction');
    const hit = this.castRay3D(planePoint(plane, o.x, o.y), planeVector(plane, d.x, d.y), queryDistance(maxDistance, 100, 'raycast'), filter);
    if (hit === null) return null;
    const [nx, ny] = planeCoords(plane, hit.normal);
    const len = Math.hypot(nx, ny);
    return Object.freeze({ entityId: hit.entityId, distance: hit.distance, normal: len > 0 ? { x: nx / len, y: ny / len } : { x: 0, y: 0 } });
  }

  /** A box: [x, y, z] arrays are a 3D box (then a rotation and a filter); {x, y} a box on the caller's plane (then a filter). */
  private overlapBox(caller: string | undefined, center: unknown, half: unknown, a3: unknown, a4: unknown): string[] {
    if (Array.isArray(center)) {
      const h = queryVec3(half, 'overlapBox half');
      return this.overlap3D({ type: 'box', hx: queryPositive(h[0], 'overlapBox half x'), hy: queryPositive(h[1], 'overlapBox half y'), hz: queryPositive(h[2], 'overlapBox half z') }, queryVec3(center, 'overlapBox center'), queryQuat(a3, 'overlapBox rotation'), a4);
    }
    if (this.h.physics3d === undefined) {
      if (this.used >= PHYSICS_QUERY_LIMIT || this.h.physics?.overlap === undefined || half === null || typeof half !== 'object') return [];
      this.used += 1;
      const c = center as Vec2 | undefined;
      const hh = half as Vec2;
      return portCall('overlap', () => this.h.physics!.overlap!({ type: 'box', hx: Number(hh.x), hy: Number(hh.y) }, { x: Number(c?.x), y: Number(c?.y) }));
    }
    const plane = this.planeFor(caller);
    const c = queryVec2(center, 'overlapBox center');
    const h = queryVec2(half, 'overlapBox half');
    const hx = queryPositive(h.x, 'overlapBox half x');
    const hy = queryPositive(h.y, 'overlapBox half y');
    // The box's 2D width runs along the plane's right; its depth is a sliver across the plane.
    const shape = plane.axis === 'z' ? { type: 'box' as const, hx, hy, hz: PLANE_QUERY_HALF_DEPTH } : { type: 'box' as const, hx: PLANE_QUERY_HALF_DEPTH, hy, hz: hx };
    return this.overlap3D(shape, planePoint(plane, c.x, c.y), undefined, a3);
  }

  /** A circle on the caller's plane (a disc: a thin cylinder along the plane's normal). */
  private overlapCircle(caller: string | undefined, center: unknown, radius: unknown, filter: unknown): string[] {
    if (this.h.physics3d === undefined) {
      if (this.used >= PHYSICS_QUERY_LIMIT || this.h.physics?.overlap === undefined) return [];
      this.used += 1;
      const c = center as Vec2 | undefined;
      return portCall('overlap', () => this.h.physics!.overlap!({ type: 'circle', radius: Number(radius) }, { x: Number(c?.x), y: Number(c?.y) }));
    }
    const plane = this.planeFor(caller);
    const c = queryVec2(center, 'overlapCircle center');
    const r = queryPositive(radius, 'overlapCircle radius');
    return this.overlap3D({ type: 'cylinder', radius: r, halfHeight: PLANE_QUERY_HALF_DEPTH }, planePoint(plane, c.x, c.y), plane.axis === 'z' ? CYLINDER_ALONG_Z : CYLINDER_ALONG_X, filter);
  }

  /** One query from the step's 3D budget (null past it — warned once — or without a 3D port). */
  private takeQuery3D(): PhysicsPort3D | null {
    const port = this.h.physics3d;
    if (port === undefined) return null;
    if (this.used >= PHYSICS_QUERY_LIMIT) {
      if (!this.warned) {
        this.warned = true;
        this.h.warn(`more than ${PHYSICS_QUERY_LIMIT} physics queries in one step (step ${this.h.stepIndex()}): the rest of the step's queries find nothing (warned once)`);
      }
      return null;
    }
    this.used += 1;
    return port;
  }

  /** A script's query filter as the port takes it (tags and exclusions become the accept test). */
  private queryFilter3D(filter: unknown): PhysicsQueryFilter3D | undefined {
    if (filter === undefined || filter === null) return undefined;
    if (typeof filter !== 'object' || Array.isArray(filter)) throw new Error('a query filter is { tags?, layers?, exclude? }');
    const f = filter as Record<string, unknown>;
    for (const k of Object.keys(f)) if (k !== 'tags' && k !== 'layers' && k !== 'exclude') throw new Error(`unknown query filter field "${k.slice(0, 32)}" (tags, layers, exclude)`);
    const names = (v: unknown, what: string): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.length > 64 || !v.every((s) => typeof s === 'string')) throw new Error(`query filter ${what} is a list of up to 64 names`);
      return v as string[];
    };
    const tags = names(f['tags'], 'tags');
    const layers = names(f['layers'], 'layers');
    const exclude = names(f['exclude'], 'exclude');
    // Tag names resolve like ctx.tags.mask (an unknown name is a script error).
    const tagIndex = this.h.tags;
    const mask = tags === undefined ? undefined : tags.length === 0 ? 0 : tagIndex === null ? 0 : tagIndex.mask(...tags);
    const skip = exclude === undefined || exclude.length === 0 ? null : new Set(exclude);
    const accept =
      mask === undefined && skip === null
        ? undefined
        : (colliderId: string): boolean => {
            const id = colliderEntityOf(colliderId);
            return (skip === null || !skip.has(id)) && (mask === undefined || (mask !== 0 && tagIndex !== null && tagIndex.has(id, mask)));
          };
    return { ...(layers !== undefined ? { layers } : {}), ...(accept !== undefined ? { accept } : {}) };
  }

  /** A filtered 3D ray (origin, direction not normalized) into a script's hit. */
  private castRay3D(origin: readonly number[], direction: readonly number[], maxDistance: number, filter: unknown): PhysicsHit | null {
    const f = this.queryFilter3D(filter);
    const len = Math.hypot(direction[0]!, direction[1]!, direction[2]!);
    if (!(len > 0)) return null;
    const port = this.takeQuery3D();
    if (port === null || typeof port.raycast !== 'function') return null;
    const u = [direction[0]! / len, direction[1]! / len, direction[2]! / len];
    const hit = portCall('raycast', () => port.raycast!({ x: origin[0]!, y: origin[1]!, z: origin[2]! }, { x: u[0]!, y: u[1]!, z: u[2]! }, maxDistance, f));
    if (hit === null) return null;
    const p = hit.point ?? { x: origin[0]! + u[0]! * hit.distance, y: origin[1]! + u[1]! * hit.distance, z: origin[2]! + u[2]! * hit.distance };
    const entityId = colliderEntityOf(hit.entityId);
    // A block layer's chunk: the layer, and the cell just inside the surface the ray hit (1 mm behind it); a scatter copy: its address.
    const detail = entityId !== hit.entityId ? this.h.grid.hitDetail(entityId, hit.entityId, [p.x - hit.normal.x * 1e-3, p.y - hit.normal.y * 1e-3, p.z - hit.normal.z * 1e-3]) : {};
    return Object.freeze({ entityId, point: [p.x, p.y, p.z], normal: [hit.normal.x, hit.normal.y, hit.normal.z], distance: hit.distance, ...detail }) as PhysicsHit;
  }

  /** A filtered 3D overlap (sorted ids, at most 64). */
  private overlap3D(shape: OverlapShape3D, center: readonly number[], rotation: PhysicsQuat | undefined, filter: unknown): string[] {
    const f = this.queryFilter3D(filter);
    const port = this.takeQuery3D();
    if (port === null || typeof port.overlap !== 'function') return [];
    // A block layer's chunk colliders are reported as their layer (once).
    return [...new Set(portCall('overlap', () => port.overlap!(shape, { x: center[0]!, y: center[1]!, z: center[2]! }, rotation, f)).map(colliderEntityOf))].sort();
  }
}
