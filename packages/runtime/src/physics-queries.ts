/**
 * The physics queries of scripts and engine modules (`ctx.physics`: rays,
 * overlaps and picks, 2D and 3D) with the step's shared query budget.
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
import { colliderEntityOf, PHYSICS_QUERY_LIMIT, queryDistance, queryPositive, queryQuat, queryVec3 } from './physics-query-args';
import type { CharacterMoveResult, CharacterState3D, OverlapShape3D, PhysicsHit, PhysicsPort, PhysicsPort3D, PhysicsQuat, PhysicsQueryFilter3D, PhysicsStepClient, Vec2 } from './ports';
import type { PointerSample } from './actions';
import type { RuntimeViews } from './views';
import type { RuntimeGrid } from './grid';

/** What the queries read of the runtime (read at each call: the runtime makes its parts after this). */
export interface PhysicsQueryHost {
  readonly physics: PhysicsPort | undefined;
  readonly physics3d: PhysicsPort3D | undefined;
  readonly controllers: PlayerControllers;
  readonly views: RuntimeViews;
  readonly grid: RuntimeGrid;
  readonly tags: LiveTagIndex | null;
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

export class PhysicsQueries {
  /** Queries this step (rays and overlaps, 2D and 3D). */
  private used = 0;
  /** The 3D budget ran out once (warned in the play log). */
  private warned = false;

  constructor(private readonly h: PhysicsQueryHost) {}

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
    // At most PHYSICS_QUERY_LIMIT queries (rays and overlaps) per step for modules and scripts.
    raycast: (origin: Vec2, direction: Vec2, maxDistance: number) => {
      if (this.used >= PHYSICS_QUERY_LIMIT || this.h.physics?.raycast === undefined) return null;
      this.used += 1;
      return portCall('raycast', () => this.h.physics!.raycast!(origin, direction, maxDistance));
    },
    overlapBox: (center: Vec2, half: Vec2): string[] => {
      if (this.used >= PHYSICS_QUERY_LIMIT || this.h.physics?.overlap === undefined || half === null || typeof half !== 'object') return [];
      this.used += 1;
      return portCall('overlap', () => this.h.physics!.overlap!({ type: 'box', hx: Number(half.x), hy: Number(half.y) }, { x: Number(center?.x), y: Number(center?.y) }));
    },
    overlapCircle: (center: Vec2, radius: number): string[] => {
      if (this.used >= PHYSICS_QUERY_LIMIT || this.h.physics?.overlap === undefined) return [];
      this.used += 1;
      return portCall('overlap', () => this.h.physics!.overlap!({ type: 'circle', radius: Number(radius) }, { x: Number(center?.x), y: Number(center?.y) }));
    },
  };

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
