/**
 * The collision ring: which resident chunks have physics bodies. Bodies
 * cost far more than draws (a ground trimesh takes ~140 bytes of the
 * physics engine's heap a triangle, several times the geometry handed
 * over) and only what can touch them needs them: characters and scripts
 * act near the world's foci, while the stream ring around them is mostly
 * only drawn. So a chunk gets a body only while any part of it lies within
 * the collision radius (horizontal) and height (vertical) of a focus, and
 * keeps it until it is past those bounds plus a hysteresis for every
 * focus, so a focus moving back and forth across a chunk edge does not add
 * and remove the same bodies.
 *
 * The distance is to the chunk's box, not its centre: everything nearer
 * than the radius to a focus is solid, whatever the chunk edge.
 *
 * Inside the ring, a chunk's body follows its draw: the `chunk` event that
 * replaces its draw replaces its body in the same task (the atomic swap of
 * an edit holds for bodies and draws alike). Chunks entering the ring as
 * the foci move get their bodies on {@link CollisionRing.update}, nearest
 * first and within a main-thread time slice (at least one body a call); chunks
 * leaving lose theirs at once, farthest first. Each body's bytes are
 * registered as the chunk's `collision` part in the stream budget, so
 * physics memory is counted with the voxels and derived data it comes
 * from, and an evicted or unloaded chunk takes its body with it.
 */
import { chunkInWorld, chunkKey, type ChunkGrid } from './coords';
import type { CollisionSource } from './derived-collision';
import { DEFAULT_COLLISION_RING, type Focus } from './stream-ring';

/** Collision ring bounds in cells: a body is added within radius/height and kept until past keepRadius/keepHeight. */
export interface CollisionRingBounds {
  readonly radius: number;
  readonly height: number;
  readonly keepRadius: number;
  readonly keepHeight: number;
}

/**
 * Cells past the collision bounds a chunk keeps its body (8 m): enough
 * that walking along a chunk edge never re-adds a body, small against the
 * radius so the ring stays the size asked for.
 */
export const COLLISION_RING_HYSTERESIS_CELLS = 16;

/**
 * Main-thread milliseconds an update may spend adding the bodies of chunks
 * that entered the ring (at least one body a call): a flight past many
 * chunks spreads its adds over frames instead of stalling one.
 */
export const COLLISION_ADD_MS_PER_UPDATE = 4;

/** The budget part a chunk's body is counted as. */
export const COLLISION_PART = 'collision';

/** The bounds for a collision radius and height (cells; default {@link DEFAULT_COLLISION_RING}) with the hysteresis. */
export function collisionRingBounds(r: Readonly<{ radius: number; height: number }> = DEFAULT_COLLISION_RING, hysteresis = COLLISION_RING_HYSTERESIS_CELLS): CollisionRingBounds {
  for (const v of [r.radius, r.height, hysteresis]) if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError('collision ring bounds must be finite and ≥ 0');
  return Object.freeze({ radius: r.radius, height: r.height, keepRadius: r.radius + hysteresis, keepHeight: r.height + hysteresis });
}

/** The physics side: builds and drops a chunk's body. */
export interface CollisionBodies {
  /** Replaces the chunk's body with one built from `source`; returns the bytes it costs (0: nothing to collide, no body). */
  set(key: number, cx: number, cy: number, cz: number, source: CollisionSource): number;
  /** Drops the chunk's body, if any. */
  remove(key: number): void;
}

/** The streaming side (VoxelStreamer has these). */
export interface CollisionRingFeed {
  isResident(cx: number, cy: number, cz: number): boolean;
  /** The chunk's sections joined (null: nothing derived). */
  joinedChunk(cx: number, cy: number, cz: number): CollisionSource | null;
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean;
}

export interface CollisionRingOptions {
  readonly grid: ChunkGrid;
  readonly bodies: CollisionBodies;
  readonly feed: CollisionRingFeed;
  /** Default: {@link collisionRingBounds}(). */
  readonly bounds?: CollisionRingBounds;
  /** Default {@link COLLISION_ADD_MS_PER_UPDATE}. */
  readonly addMsPerUpdate?: number;
}

interface Member {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Bytes its body is counted at (0: inside the ring, no body: air, or not derived yet). */
  bytes: number;
}

/** What one {@link CollisionRing.update} did. */
export interface CollisionRingUpdate {
  readonly added: number;
  readonly removed: number;
  /** Chunks inside the ring left without a body for a later update (the time slice ran out). */
  readonly waiting: number;
}

/** Distance (cells) from `p` to the span [lo, lo + edge) along one axis. */
function axisGap(p: number, lo: number, edge: number): number {
  return p < lo ? lo - p : p > lo + edge ? p - lo - edge : 0;
}

/**
 * Whether any focus is nearer than `radius` (horizontally) and `height` (vertically) to a chunk's box (cells;
 * strictly: a box only touching the bound is out, as cells are half-open): the collision ring's test.
 */
export function chunkNearFoci(grid: ChunkGrid, foci: readonly Focus[], cx: number, cy: number, cz: number, radius: number, height: number): boolean {
  const e = grid.edge;
  for (const f of foci) {
    const gx = axisGap(f.x, cx * e, e);
    const gz = axisGap(f.z, cz * e, e);
    if (gx * gx + gz * gz < radius * radius && axisGap(f.y, cy * e, e) < height) return true;
  }
  return false;
}

export class CollisionRing {
  private current: CollisionRingBounds;
  private readonly grid: ChunkGrid;
  private readonly bodies: CollisionBodies;
  private readonly feed: CollisionRingFeed;
  private readonly addMs: number;
  private foci: readonly Focus[] = [];
  private readonly members = new Map<number, Member>();
  /** Bodies added and removed since the ring was made. */
  adds = 0;
  removes = 0;
  /** Bytes of every body in the ring (what its parts add to the budget). */
  bytes = 0;

  constructor(opts: CollisionRingOptions) {
    this.grid = opts.grid;
    this.bodies = opts.bodies;
    this.feed = opts.feed;
    this.current = opts.bounds ?? collisionRingBounds();
    this.addMs = opts.addMsPerUpdate ?? COLLISION_ADD_MS_PER_UPDATE;
  }

  /** Where bodies are added and kept (cells). */
  get bounds(): CollisionRingBounds {
    return this.current;
  }

  /** New bounds, applied by the next {@link update}: bodies past the new keep bounds go, chunks inside the new add bounds get theirs. */
  setBounds(bounds: CollisionRingBounds): void {
    this.current = bounds;
  }

  /** The points bodies are kept around (cells): the camera, characters, anything that collides. */
  setFoci(foci: readonly Focus[]): void {
    this.foci = foci.map((f) => ({ x: f.x, y: f.y, z: f.z }));
  }

  /** Chunks with a body. */
  get count(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.bytes > 0) n++;
    return n;
  }

  /** Whether the chunk has a body. */
  has(cx: number, cy: number, cz: number): boolean {
    return (this.members.get(chunkKey(this.grid, cx, cy, cz))?.bytes ?? 0) > 0;
  }

  /** Squared horizontal gap and vertical gap (cells) from the nearest focus to a chunk's box; [Infinity, Infinity] without foci. */
  private gaps(cx: number, cy: number, cz: number): [number, number] {
    const e = this.grid.edge;
    let best2 = Infinity;
    let bestY = Infinity;
    for (const f of this.foci) {
      const gx = axisGap(f.x, cx * e, e);
      const gz = axisGap(f.z, cz * e, e);
      const gy = axisGap(f.y, cy * e, e);
      const h2 = gx * gx + gz * gz;
      // Nearest by horizontal gap, then vertical: the order bodies are added and removed in.
      if (h2 < best2 || (h2 === best2 && gy < bestY)) {
        best2 = h2;
        bestY = gy;
      }
    }
    return [best2, bestY];
  }

  private within(cx: number, cy: number, cz: number, radius: number, height: number): boolean {
    return chunkNearFoci(this.grid, this.foci, cx, cy, cz, radius, height);
  }

  /**
   * Whether a chunk column's collision is in place for something standing
   * in it: the column lies within the add bounds of a focus, and each of its
   * chunks within those bounds is in the ring and `ready` (its derive
   * arrived, so its body is the chunk's ground and not a placeholder for
   * results still on their way). False for a column no focus reaches.
   */
  columnSettled(cx: number, cz: number, ready: (cx: number, cy: number, cz: number) => boolean): boolean {
    const b = this.bounds;
    const e = this.grid.edge;
    let any = false;
    for (const f of this.foci) {
      for (let cy = Math.floor((f.y - b.height) / e); cy <= Math.floor((f.y + b.height) / e); cy++) {
        if (!chunkInWorld(this.grid, cx, cy, cz) || !this.within(cx, cy, cz, b.radius, b.height)) continue;
        if (!this.members.has(chunkKey(this.grid, cx, cy, cz)) || !ready(cx, cy, cz)) return false;
        any = true;
      }
    }
    return any;
  }

  /** Whether the chunk belongs in the ring: within the add bounds, or a member within the keep bounds. */
  wants(cx: number, cy: number, cz: number): boolean {
    const b = this.bounds;
    if (this.within(cx, cy, cz, b.radius, b.height)) return true;
    return this.members.has(chunkKey(this.grid, cx, cy, cz)) && this.within(cx, cy, cz, b.keepRadius, b.keepHeight);
  }

  /**
   * A chunk's sections took new results (the streamer's `chunk` event, not
   * shader-only): inside the ring its body is replaced now, from `joined`
   * when the caller has the join (the draw's), else joined here. Returns
   * whether the chunk is in the ring (its body replaced or, with nothing to
   * collide, dropped).
   */
  changed(cx: number, cy: number, cz: number, joined?: CollisionSource | null): boolean {
    if (!this.wants(cx, cy, cz) || !this.feed.isResident(cx, cy, cz)) return false;
    this.place(cx, cy, cz, joined === undefined ? this.feed.joinedChunk(cx, cy, cz) : joined);
    return true;
  }

  /**
   * The chunk left the stream (unloaded or evicted): its body goes with it.
   * Its budget parts went with the chunk, so none is cleared here (the
   * streamer announces the unload before it forgets the chunk, and a
   * second subtraction would undercount the budget).
   */
  unloaded(cx: number, cy: number, cz: number): void {
    const key = chunkKey(this.grid, cx, cy, cz);
    const m = this.members.get(key);
    if (m === undefined) return;
    if (m.bytes > 0) this.drop(key, m, false);
    this.members.delete(key);
  }

  private place(cx: number, cy: number, cz: number, joined: CollisionSource | null): void {
    const key = chunkKey(this.grid, cx, cy, cz);
    let m = this.members.get(key);
    if (m === undefined) {
      m = { cx, cy, cz, bytes: 0 };
      this.members.set(key, m);
    }
    const had = m.bytes > 0;
    // The part is overwritten below, or cleared when no body follows.
    if (had) this.drop(key, m, false);
    const bytes = joined === null ? 0 : this.bodies.set(key, cx, cy, cz, joined);
    if (bytes <= 0) {
      if (had) this.feed.setPart(cx, cy, cz, COLLISION_PART, 0);
      return;
    }
    // Only a resident chunk carries parts: a body the budget cannot count is not kept.
    if (!this.feed.setPart(cx, cy, cz, COLLISION_PART, bytes)) {
      this.bodies.remove(key);
      return;
    }
    m.bytes = bytes;
    this.bytes += bytes;
    this.adds++;
  }

  /** Drops a member's body; `clearPart`: take its bytes off the chunk's budget parts too. */
  private drop(key: number, m: Member, clearPart: boolean): void {
    this.bodies.remove(key);
    this.bytes -= m.bytes;
    m.bytes = 0;
    this.removes++;
    if (clearPart) this.feed.setPart(m.cx, m.cy, m.cz, COLLISION_PART, 0);
  }

  /**
   * After the foci moved: bodies of chunks past the keep bounds of every
   * focus are removed (farthest first), then resident chunks within the
   * add bounds that are not in the ring get theirs (nearest first) until
   * the time slice is spent.
   */
  update(): CollisionRingUpdate {
    const b = this.bounds;
    const leaving: Array<{ key: number; m: Member; h2: number; y: number }> = [];
    for (const [key, m] of this.members) {
      if (this.within(m.cx, m.cy, m.cz, b.keepRadius, b.keepHeight)) continue;
      const [h2, y] = this.gaps(m.cx, m.cy, m.cz);
      leaving.push({ key, m, h2, y });
    }
    leaving.sort((p, q) => q.h2 - p.h2 || q.y - p.y);
    let removed = 0;
    for (const l of leaving) {
      if (l.m.bytes > 0) {
        this.drop(l.key, l.m, true);
        removed++;
      }
      this.members.delete(l.key);
    }
    const entering = this.entering();
    const t0 = performance.now();
    let added = 0;
    let done = 0;
    for (const c of entering) {
      // At least one body a call, so a slice too short for one still makes progress (chunks with nothing to collide are cheap).
      if (added > 0 && performance.now() - t0 >= this.addMs) break;
      done++;
      const before = this.adds;
      this.place(c.cx, c.cy, c.cz, this.feed.joinedChunk(c.cx, c.cy, c.cz));
      added += this.adds - before;
    }
    return { added, removed, waiting: entering.length - done };
  }

  /** Resident chunks within the add bounds of a focus and not in the ring, nearest first. */
  private entering(): Array<{ cx: number; cy: number; cz: number; h2: number; y: number }> {
    const b = this.bounds;
    const e = this.grid.edge;
    const seen = new Set<number>();
    const out: Array<{ cx: number; cy: number; cz: number; h2: number; y: number }> = [];
    for (const f of this.foci) {
      const x0 = Math.floor((f.x - b.radius) / e);
      const x1 = Math.floor((f.x + b.radius) / e);
      const z0 = Math.floor((f.z - b.radius) / e);
      const z1 = Math.floor((f.z + b.radius) / e);
      const y0 = Math.floor((f.y - b.height) / e);
      const y1 = Math.floor((f.y + b.height) / e);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) for (let cy = y0; cy <= y1; cy++) {
        if (!chunkInWorld(this.grid, cx, cy, cz)) continue;
        const key = chunkKey(this.grid, cx, cy, cz);
        if (seen.has(key) || this.members.has(key)) continue;
        seen.add(key);
        if (!this.within(cx, cy, cz, b.radius, b.height) || !this.feed.isResident(cx, cy, cz)) continue;
        const [h2, y] = this.gaps(cx, cy, cz);
        out.push({ cx, cy, cz, h2, y });
      }
    }
    return out.sort((p, q) => p.h2 - q.h2 || p.y - q.y);
  }
}
