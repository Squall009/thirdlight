/**
 * Collision for a streamed voxel world through the engine's one physics
 * backend (physics-rapier's port): every storage chunk becomes one static
 * body, built from its derive sections joined (chunk-join.ts) in the same
 * task as its draw, holding its collision boxes (full-cell merges, and the
 * partial shapes of beams, rails and posts the assembly resolved) and its
 * projected ground surface: a heightfield where the chunk is ground alone
 * and a height function (derived-collision.ts), else triangle meshes. A
 * chunk's body is replaced whenever one of its sections is derived again
 * (an edit within the rules' reach, a neighbour landing) and removed when
 * it unloads, so physics always agrees with what the assembly evaluation
 * resolved and with what is drawn.
 *
 * Positions are relative to the floating origin, like the meshes; a
 * re-base re-places every body.
 *
 * The port moves characters (kinematic capsules swept by its controller)
 * and answers queries; it has no free rigid bodies. A dropped body is
 * therefore a capsule character falling under gravity (the runtime's own
 * way of moving one) or a swept sphere (`castSphere`).
 */
import { createPhysicsPort3D, estimateStaticBodyBytes3D, MAX_MESH_TRIANGLES_3D, MAX_MESH_VERTICES_3D, physicsMemoryBytes3D, type ColliderShape3D, type RapierPhysicsPort3D } from '@thirdlight/physics-rapier';
import { chunkOrigin, collisionBodyParts, collisionGeometry, CollisionRing, collisionRingBounds, DEFAULT_COLLISION_RING, DEFAULT_STREAM_RING, SampleRing, VOXEL_SIZE_M, type CellGrid, type ChunkGrid, type CollisionRingFeed, type CollisionSource, type FloatingOrigin } from '@thirdlight/voxel';

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
/** The physics step rate a drop is simulated at. */
const STEP_HZ = 60;
/** Gravity along y, m/s². */
const GRAVITY_Y = -9.81;
/** Steps a resting body must stay grounded and still before a drop ends. */
const REST_STEPS = 10;

type Vec3 = [number, number, number];
type ColliderPart3D = Extract<ColliderShape3D, { type: 'compound' }>['parts'][number];

interface ChunkBody {
  readonly id: string;
  readonly cell: Vec3;
  readonly parts: ColliderPart3D[];
  /** What it costs: the geometry kept here (for re-bases) and the physics engine's heap for it (estimated). */
  readonly bytes: number;
  readonly geometryBytes: number;
  readonly heightfield: boolean;
}

/** Where a dropped capsule came to rest. */
export interface DropResult {
  /** The capsule's lowest point, in cells (fractional). */
  readonly feet: Vec3;
  readonly grounded: boolean;
  /** The chunk body it stands on (`voxel:cx,cy,cz`), or null. */
  readonly on: string | null;
  readonly steps: number;
  /** How far it fell, metres. */
  readonly fellM: number;
}

export class VoxelCollision {
  private readonly bodies = new Map<number, ChunkBody>();
  readonly addMs = new SampleRing();
  readonly removeMs = new SampleRing();
  adds = 0;
  removes = 0;
  bytes = 0;
  geometryBytes = 0;
  /** The physics engine's heap when this world was made (null: not seen). */
  readonly wasmAtCreate = physicsMemoryBytes3D();
  private probeCount = 0;

  private constructor(
    private readonly port: RapierPhysicsPort3D,
    private readonly grid: CellGrid,
    private readonly origin: FloatingOrigin,
    private readonly heightfields: boolean,
  ) {}

  /**
   * A physics world with no character of its own (probes add theirs), a
   * body a chunk of `grid`. `heightfields: false` keeps all ground as
   * meshes (to compare the two).
   */
  static async create(grid: CellGrid, origin: FloatingOrigin, heightfields = true): Promise<VoxelCollision> {
    const r = await createPhysicsPort3D({
      character: { position: { x: 0, y: 0, z: 0 }, radius: 0.3, halfHeight: 0.5, offset: { x: 0, y: 0.8, z: 0 } },
      noCharacter: true,
      statics: [],
      solver: { hz: STEP_HZ, gravityY: GRAVITY_Y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: 0.8, minSlopeSlideRad: 0.9, autostep: false },
    });
    if (!r.ok) throw new Error(`physics: ${r.error.message}`);
    return new VoxelCollision(r.port, grid, origin, heightfields);
  }

  get count(): number {
    return this.bodies.size;
  }

  private position(cell: Vec3): { x: number; y: number; z: number } {
    const o = this.origin.origin;
    return { x: (cell[0] - o.x) * VOXEL_SIZE_M, y: (cell[1] - o.y) * VOXEL_SIZE_M, z: (cell[2] - o.z) * VOXEL_SIZE_M };
  }

  /**
   * Replaces a chunk's body with the collision of its joined sections (null:
   * nothing derived, no body); returns what the body costs (0: no body):
   * the geometry kept for re-bases plus the physics heap it takes
   * (`estimateStaticBodyBytes3D`; the heap itself is one module-wide
   * number that never shrinks, so it cannot be split per body).
   */
  set(key: number, cx: number, cy: number, cz: number, d: CollisionSource | null): number {
    this.remove(key);
    if (d === null) return 0;
    const t0 = performance.now();
    const geo = collisionGeometry(d, { maxVertices: MAX_MESH_VERTICES_3D, maxTriangles: MAX_MESH_TRIANGLES_3D }, this.heightfields);
    // The port's mesh takes the typed arrays as they are (its shape lists are read element by element).
    const parts = collisionBodyParts(geo) as unknown as ColliderPart3D[];
    if (parts.length === 0) return 0;
    const cell: Vec3 = [chunkOrigin(this.grid, cx), chunkOrigin(this.grid, cy), chunkOrigin(this.grid, cz)];
    const shape: ColliderShape3D = { type: 'compound', parts };
    const body: ChunkBody = { id: `voxel:${cx},${cy},${cz}`, cell, parts, bytes: geo.bytes + estimateStaticBodyBytes3D(shape), geometryBytes: geo.bytes, heightfield: geo.heightfield !== null };
    this.port.addStaticColliders([{ entityId: body.id, shape, position: this.position(cell), rotation: IDENTITY }]);
    this.bodies.set(key, body);
    this.bytes += body.bytes;
    this.geometryBytes += body.geometryBytes;
    this.adds++;
    this.addMs.add(performance.now() - t0);
    return body.bytes;
  }

  remove(key: number): void {
    const body = this.bodies.get(key);
    if (body === undefined) return;
    const t0 = performance.now();
    this.port.removeStaticColliders([body.id]);
    this.bodies.delete(key);
    this.bytes -= body.bytes;
    this.geometryBytes -= body.geometryBytes;
    this.removes++;
    this.removeMs.add(performance.now() - t0);
  }

  /** After a floating-origin re-base: every body again at its integer cell. */
  rebase(): void {
    const all = [...this.bodies.values()];
    this.port.removeStaticColliders(all.map((b) => b.id));
    this.port.addStaticColliders(all.map((b) => ({ entityId: b.id, shape: { type: 'compound' as const, parts: b.parts }, position: this.position(b.cell), rotation: IDENTITY })));
  }

  /**
   * Drops a capsule (radius and centre-segment half height in metres) with
   * its lowest point at `feet` (cells, fractional) and lets it fall under
   * gravity, a physics step at a time, until it has rested for a few steps
   * or `maxSteps` have passed.
   */
  dropCapsule(feet: Vec3, radiusM: number, halfHeightM: number, maxSteps = 600): DropResult {
    const id = `probe-${++this.probeCount}`;
    const o = this.origin.origin;
    const start = this.position(feet);
    this.port.addCharacter({ id, position: start, radius: radiusM, halfHeight: halfHeightM, offset: { x: 0, y: radiusM + halfHeightM, z: 0 } });
    try {
      const dt = 1 / STEP_HZ;
      let vy = 0;
      let rest = 0;
      let steps = 0;
      let at = start;
      let grounded = false;
      let on: string | null = null;
      while (steps < maxSteps && rest < REST_STEPS) {
        vy = grounded ? 0 : vy + GRAVITY_Y * dt;
        this.port.stageCharacterMove({ x: 0, y: (vy + (grounded ? GRAVITY_Y * dt : 0)) * dt, z: 0 }, id);
        this.port.step();
        steps++;
        const r = this.port.lastResultOf(id);
        if (r === undefined) break;
        const moved = Math.abs(r.position.y - at.y);
        at = r.position;
        grounded = r.grounded;
        on = r.groundEntityId ?? null;
        rest = grounded && moved < 1e-4 ? rest + 1 : 0;
      }
      return { feet: [at.x / VOXEL_SIZE_M + o.x, at.y / VOXEL_SIZE_M + o.y, at.z / VOXEL_SIZE_M + o.z], grounded, on, steps, fellM: start.y - at.y };
    } finally {
      this.port.removeCharacter(id);
    }
  }

  /**
   * Sweeps a sphere (radius in metres) from `from` (cells) along `dir` up
   * to `maxM` metres: where it first touches a collider (its centre, cells,
   * and the distance), or null when nothing is in the way.
   */
  castSphere(from: Vec3, dir: Vec3, radiusM: number, maxM: number): { distanceM: number; centre: Vec3; hit: string } | null {
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    const d = { x: dir[0] / len, y: dir[1] / len, z: dir[2] / len };
    if (this.port.castSphere === undefined) throw new Error('physics: this port sweeps no spheres');
    const h = this.port.castSphere(this.position(from), d, radiusM, maxM);
    if (h === null) return null;
    const k = h.distance / VOXEL_SIZE_M;
    return { distanceM: h.distance, centre: [from[0] + d.x * k, from[1] + d.y * k, from[2] + d.z * k], hit: h.entityId };
  }

  stats(): Record<string, unknown> {
    const q = (r: SampleRing, p: number): number => Number(r.quantile(p).toFixed(3));
    const diag = this.port.diagnostics();
    let heightfields = 0;
    let heightfieldBytes = 0;
    for (const b of this.bodies.values()) {
      if (!b.heightfield) continue;
      heightfields++;
      heightfieldBytes += b.bytes;
    }
    return {
      bodies: this.bodies.size,
      heightfields,
      heightfieldBytes,
      colliders: diag.worldColliderCount,
      bytes: this.bytes,
      geometryBytes: this.geometryBytes,
      wasmBytes: physicsMemoryBytes3D(),
      wasmAtCreate: this.wasmAtCreate,
      adds: this.adds,
      removes: this.removes,
      addMs: { p50: q(this.addMs, 0.5), p95: q(this.addMs, 0.95), max: q(this.addMs, 1), n: this.addMs.count },
      removeMs: { p50: q(this.removeMs, 0.5), p95: q(this.removeMs, 0.95), max: q(this.removeMs, 1), n: this.removeMs.count },
    };
  }
}

/**
 * The page's bodies and their collision ring: the engine's default bounds
 * around the camera's target (`ringed` false gives every resident chunk a
 * body, to compare), updated once a frame, and
 * what it did for the hook's state. Inside the ring a chunk's body is
 * replaced from its draw's join in the task that replaces the draw
 * (`ring.changed`); outside it has none.
 */
export class PageCollisionRing {
  readonly ring: CollisionRing;
  private readonly ms = new SampleRing();
  private waiting = 0;

  private constructor(grid: ChunkGrid, readonly collision: VoxelCollision, feed: CollisionRingFeed, ringed: boolean) {
    // Unringed: the stream ring's unload bounds widened by the lead point's reach (the near radius), which hold every resident chunk.
    const all = { radius: DEFAULT_STREAM_RING.unloadRadius + DEFAULT_STREAM_RING.nearRadius, height: DEFAULT_STREAM_RING.unloadHeight };
    this.ring = new CollisionRing({ grid, bodies: collision, feed, bounds: collisionRingBounds(ringed ? DEFAULT_COLLISION_RING : all) });
  }

  /** A physics world of chunk bodies (`heightfields`: see {@link VoxelCollision.create}) re-placed on every re-base of `origin`. */
  static async create(grid: ChunkGrid, origin: FloatingOrigin, feed: CollisionRingFeed, heightfields: boolean, ringed: boolean): Promise<PageCollisionRing> {
    const collision = await VoxelCollision.create(grid, origin, heightfields);
    origin.onRebase(() => collision.rebase());
    return new PageCollisionRing(grid, collision, feed, ringed);
  }

  /** One frame's ring work; the chunks still waiting for a body. */
  update(): number {
    const t0 = performance.now();
    const u = this.ring.update();
    if (u.added + u.removed > 0) this.ms.add(performance.now() - t0);
    this.waiting = u.waiting;
    return u.waiting;
  }

  /** Until every chunk the ring reached has its body (adds are otherwise spread over frames). */
  async settle(): Promise<void> {
    while (this.update() > 0) await new Promise((ok) => setTimeout(ok, 0));
  }

  stats(): Record<string, unknown> {
    const q = (p: number): number => Number(this.ms.quantile(p).toFixed(3));
    const r = this.ring;
    return { ...this.collision.stats(), ring: { bodies: r.count, bytes: r.bytes, adds: r.adds, removes: r.removes, waiting: this.waiting, bounds: r.bounds, updateMs: { p50: q(0.5), p95: q(0.95), max: q(1), n: this.ms.count } } };
  }
}
