/**
 * A structure grid of a voxel world while the world is open: its own
 * streamer (its cells read from its own region files, derived and meshed in
 * the world's pool, under the world's job ids), where it stands (a
 * {@link GridFrame}: a place and a yaw), and one static body for the whole
 * grid in the physics port.
 *
 * Everything the grid streams and derives is in its own frame: the foci the
 * world's host is given (world metres) are moved into the grid's frame
 * before they reach the streamer, its collision ring and its level choice,
 * so distances, rings and reads are the grid's own while what it holds stays
 * the cells as its files hold them. Its streamer reads only round the chunks
 * the grid holds (their box from its files' tables, a margin of air round
 * them), not the whole load ring of an empty frame.
 *
 * A town holds many such grids, so a grid costs nothing while it has nothing to do: a step moves its streamer only
 * when the focus has moved a cell in its frame, something landed or changed in it since its last update
 * (the streamer's `counters.activity`), or that update left work (`idle(true)`); a grid whose box (its chunks and their margin) lies
 * past the load ring's unload bounds is not stepped at all once it has let go of what it held; the collision foci it
 * is given are only those whose keep bounds reach its box. What it holds counts against its world's one budget (the
 * world's host sets each grid's share every step).
 *
 * Collision is one compound body a grid: each storage chunk the collision
 * ring keeps gives its parts (placed at the chunk's corner, in the grid's
 * metres), and the body is built again from every kept chunk's parts at the
 * end of the task a chunk's body changed in (so it changes between the same
 * two steps as the chunk's draw), placed at the grid's position and turned
 * by its yaw.
 *
 * Not done in a structure grid (the world grid's alone): the open regions,
 * the walk graph, the props' lighting channel, the coarse floor and the far
 * field; `ctx.voxels` reads, rays, edits and saves answer from the world grid.
 */
import { COLLIDER_3D_LIMITS, type ResolvedVoxelWorld } from '@thirdlight/project-model';
import {
  applyWorldRings,
  collisionBodyParts,
  collisionGeometry,
  collisionLeadPoints,
  CollisionRing,
  collisionRingBounds,
  GRID_EXTENT_MARGIN_CHUNKS,
  GridFrame,
  grownChunkBox,
  VOXEL_SIZE_M,
  worldStreamer,
  type ChunkBox,
  type ChunkGrid,
  type ChunkSource,
  type CollisionBodies,
  type CollisionBodyPart,
  type CollisionRingFeed,
  type CollisionSource,
  type DirtyTracker,
  type Focus,
  type GridPlacement,
  type PieceTable,
  type StreamEvent,
  type VoxelStreamer,
  type WorkerPool,
} from '@thirdlight/voxel';
import { residentBytes } from '@thirdlight/shared';

import type { ColliderShape3D, PhysicsPort3D } from './ports';

/** A structure grid as the host opens it with its world: where it stands, its chunk source and the chunks it holds. */
export interface VoxelGridConnection {
  readonly place: GridPlacement;
  readonly source: ChunkSource;
  /** The chunks its files hold (null: none; the grid streams nothing). */
  readonly extent: ChunkBox | null;
}

/** A grid's body in the port and what it took to build (diagnostics). */
export interface VoxelGridBodyStats {
  /** 1 while the grid has a body. */
  readonly bodies: number;
  /** Collider parts of the body (every kept chunk's). */
  readonly shapes: number;
  /** Chunks whose parts the body holds. */
  readonly chunks: number;
  /** Times the body was built, and the ms they took in all (the port's add and remove included). */
  readonly builds: number;
  readonly buildMs: number;
}

/** One compound body for a whole grid, kept by the grid's collision ring chunk by chunk (see the file's note). */
class GridBody implements CollisionBodies {
  private readonly parts = new Map<number, CollisionBodyPart[]>();
  private placed: string | null = null;
  private dirty = false;
  private queued = false;
  private closed = false;
  builds = 0;
  buildMs = 0;

  constructor(
    private readonly port: PhysicsPort3D,
    private readonly grid: ChunkGrid,
    private readonly frame: GridFrame,
    private readonly entityId: string,
  ) {}

  set(key: number, cx: number, cy: number, cz: number, source: CollisionSource): number {
    const geo = collisionGeometry(source, { maxVertices: COLLIDER_3D_LIMITS.meshVertices, maxTriangles: COLLIDER_3D_LIMITS.meshTriangles });
    const m = this.grid.edge * VOXEL_SIZE_M;
    // A chunk's parts are placed from its corner; on the grid's one body they are placed from the grid's cell 0.
    const parts = collisionBodyParts(geo).map((p) => ({ ...p, position: { x: p.position.x + cx * m, y: p.position.y + cy * m, z: p.position.z + cz * m } }));
    if (parts.length === 0) {
      this.remove(key);
      return 0;
    }
    this.parts.set(key, parts);
    this.changed();
    return geo.bytes + (this.port.staticBodyBytes?.({ type: 'compound', parts } as unknown as ColliderShape3D) ?? 0);
  }

  remove(key: number): void {
    if (this.parts.delete(key)) this.changed();
  }

  /** Built again at the end of this task, once, whatever number of chunks changed in it. */
  private changed(): void {
    this.dirty = true;
    if (this.queued || this.closed) return;
    this.queued = true;
    queueMicrotask(() => this.build());
  }

  private build(): void {
    this.queued = false;
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    const t0 = performance.now();
    if (this.placed !== null) this.port.removeStaticColliders!([this.placed]);
    this.placed = null;
    const parts = [...this.parts.values()].flat();
    if (parts.length > 0) {
      // The port reads the typed arrays element by element; the runtime's shape lists them as plain lists.
      const shape = { type: 'compound', parts } as unknown as ColliderShape3D;
      const p = this.frame.position;
      this.port.addStaticColliders!([{ entityId: this.entityId, shape, position: { x: p[0], y: p[1], z: p[2] }, rotation: this.frame.quaternion() }]);
      this.placed = this.entityId;
    }
    this.builds++;
    this.buildMs += performance.now() - t0;
  }

  /** The body out of the port (the world unloads). */
  clear(): void {
    this.closed = true;
    if (this.placed !== null) this.port.removeStaticColliders!([this.placed]);
    this.placed = null;
    this.parts.clear();
  }

  stats(): VoxelGridBodyStats {
    let shapes = 0;
    for (const p of this.parts.values()) shapes += p.length;
    return { bodies: this.placed === null ? 0 : 1, shapes, chunks: this.parts.size, builds: this.builds, buildMs: this.buildMs };
  }
}

/**
 * What a chunk's body is made of: its collision-only join while that is of the chunk as it is now (stream-collision.ts:
 * the same surface the full join gives), else its full sections joined once all have results, else the
 * collision-only join it has, else the full sections it has.
 */
export function streamerCollisionFeed(streamer: VoxelStreamer): CollisionRingFeed {
  return {
    isResident: (cx, cy, cz) => streamer.isResident(cx, cy, cz),
    setPart: (cx, cy, cz, part, bytes) => streamer.setPart(cx, cy, cz, part, bytes),
    joinedChunk: (cx, cy, cz) => {
      const alone = streamer.collision?.source(cx, cy, cz) ?? null;
      if (alone !== null && (streamer.collision!.fresh(cx, cy, cz) || !streamer.chunkReady(cx, cy, cz))) return alone;
      return streamer.joinedChunk(cx, cy, cz);
    },
  };
}

/** The grids' stats summed for the diagnostics (bytes a grid: the least and the most). */
export function gridStats(list: readonly ReturnType<VoxelGridHost['stats']>[]): { count: number; resident: number; reading: number; decoding: number; deriving: number; bytes: number; bodies: number; shapes: number; bodyBuilds: number; bodyBuildMs: number; updates: number; skipped: number; waits: Record<string, number>; bytesPerGrid: { min: number; max: number }; nearest: ReturnType<VoxelGridHost['stats']> | null } {
  const sum = (f: (g: ReturnType<VoxelGridHost['stats']>) => number): number => list.reduce((n, g) => n + f(g), 0);
  return {
    count: list.length,
    resident: sum((g) => g.resident),
    reading: sum((g) => g.reading),
    decoding: sum((g) => g.decoding),
    deriving: sum((g) => g.deriving),
    bytes: sum((g) => g.bytes),
    bodies: sum((g) => g.body?.bodies ?? 0),
    shapes: sum((g) => g.body?.shapes ?? 0),
    bodyBuilds: sum((g) => g.body?.builds ?? 0),
    bodyBuildMs: Math.round(sum((g) => g.body?.buildMs ?? 0) * 100) / 100,
    updates: sum((g) => g.updates),
    skipped: sum((g) => g.skipped),
    waits: list.reduce<Record<string, number>>((o, g) => ({ ...o, [g.waits]: (o[g.waits] ?? 0) + 1 }), {}),
    bytesPerGrid: { min: Math.min(...list.map((g) => g.bytes)), max: Math.max(...list.map((g) => g.bytes)) },
    // The grid nearest the stream focus, as its streamer sees it (diagnostics: its frame, level choice, held detail).
    nearest: [...list].sort((a, b) => Math.hypot(...a.focusM) - Math.hypot(...b.focusM))[0] ?? null,
  };
}

const toCells = (p: readonly number[]): Focus => ({ x: p[0]! / VOXEL_SIZE_M, y: p[1]! / VOXEL_SIZE_M, z: p[2]! / VOXEL_SIZE_M });

/**
 * How far the stream focus moves, as a share of its gap to a grid's box, before that grid's streamer is told: a cell
 * at least, and at most half its level rings' hysteresis, inside which a choice made from the focus a little back is
 * one the hysteresis could have made anyway. A grid 100 m off then plans every 4 m of travel, not every 0.5 m.
 */
const GRID_REFOCUS_SHARE = 1 / 8;

export class VoxelGridHost {
  readonly frame: GridFrame;
  readonly streamer: VoxelStreamer;
  private readonly ring: CollisionRing | null = null;
  private readonly body: GridBody | null = null;
  private readonly unresident: () => void;
  private disposed = false;
  /** The stream focus as last moved into the grid's frame (metres). */
  private focusM: readonly [number, number, number] = [0, 0, 0];
  /** The chunks the grid's files hold (null: none). */
  private readonly extent: ChunkBox | null;
  /** The box its streamer reads (the extent and its margin), metres in its frame. */
  private readonly box: { readonly min: readonly number[]; readonly max: readonly number[] } | null;
  /** The stream focus (grid metres) and collision foci (cells) its streamer was last updated with, and its activity then. */
  private steppedAt: readonly number[] | null = null;
  private steppedFoci: readonly Focus[] = [];
  private steppedActivity = -1;
  private steppedWorld: readonly number[] | null = null;
  /** Where the stream focus was when the grid last looked (world metres), and how far it may move before it looks again. */
  private skipAt: readonly number[] | null = null;
  private skipM = 0;
  /** The collision ring's bounds for the settings last stepped with (made again when they change). */
  private boundsOf: ResolvedVoxelWorld | null = null;
  private bounds: ReturnType<typeof collisionRingBounds> | null = null;
  /** The box's bounding sphere in the world (metres). */
  private readonly sphere: { readonly x: number; readonly y: number; readonly z: number; readonly r: number } | null;
  /** Its last update left nothing to do (`VoxelStreamer.idle(true)`); and whether the box was in reach then. */
  private quiet = false;
  private inReach = false;
  /** Updates run and steps that skipped one (diagnostics). */
  updates = 0;
  skipped = 0;

  constructor(
    world: string,
    grid: ChunkGrid,
    g: VoxelGridConnection,
    settings: ResolvedVoxelWorld,
    shared: { readonly pool: WorkerPool; readonly tracker: DirtyTracker; readonly pieces?: PieceTable | null; readonly budgetBytes?: number },
    physics: PhysicsPort3D | undefined,
  ) {
    this.frame = new GridFrame(g.place);
    this.extent = g.extent;
    const m = grid.edge * VOXEL_SIZE_M;
    const read = g.extent === null ? null : grownChunkBox(g.extent, GRID_EXTENT_MARGIN_CHUNKS);
    this.box = read === null ? null : { min: read.min.map((v) => v * m), max: read.max.map((v) => (v + 1) * m) };
    const b = this.box;
    if (b === null) this.sphere = null;
    else {
      const c = this.frame.toWorld((b.min[0]! + b.max[0]!) / 2, (b.min[1]! + b.max[1]!) / 2, (b.min[2]! + b.max[2]!) / 2);
      this.sphere = { x: c[0], y: c[1], z: c[2], r: Math.hypot(b.max[0]! - b.min[0]!, b.max[1]! - b.min[1]!, b.max[2]! - b.min[2]!) / 2 };
    }
    // No far cache and no fine bricks: a structure grid's far field is not built yet (its world's far cache holds the world grid alone).
    this.streamer = worldStreamer({ grid, source: g.source, pool: shared.pool, gridId: g.place.gridId, tracker: shared.tracker, extent: read, ...(shared.budgetBytes !== undefined ? { budgetBytes: shared.budgetBytes } : {}), ...(shared.pieces !== undefined ? { pieces: shared.pieces } : {}), fineBricks: false }, settings);
    const streamer = this.streamer;
    this.unresident = residentBytes.register('voxelStream', () => streamer.held.total);
    if (physics !== undefined && typeof physics.addStaticColliders === 'function' && typeof physics.removeStaticColliders === 'function') {
      this.body = new GridBody(physics, grid, this.frame, `voxel:${world}:grid-${g.place.gridId}`);
      this.ring = new CollisionRing({ grid, bodies: this.body, feed: streamerCollisionFeed(streamer), bounds: this.collisionBounds(settings) });
    }
    if (streamer.collision !== null) streamer.collision.bounds = this.collisionBounds(settings);
    streamer.on((e) => this.onStream(e));
  }

  private collisionBounds(s: ResolvedVoxelWorld): ReturnType<typeof collisionRingBounds> {
    const cells = (m: number): number => m / VOXEL_SIZE_M;
    return collisionRingBounds({ radius: Math.min(cells(s.collision.radius), cells(s.ring.loadRadius)), height: Math.min(cells(s.collision.height), cells(s.ring.loadHeight)) });
  }

  private onStream(e: StreamEvent): void {
    if (this.disposed) return;
    if (e.type === 'unloaded') this.ring?.unloaded(e.cx, e.cy, e.cz);
    else if ((e.type === 'chunk' && !e.shaderOnly && !e.reliefOnly) || e.type === 'collision') this.ring?.changed(e.cx, e.cy, e.cz);
  }

  /** New distances (a quality level or a script's rings): as the world grid's. */
  setRings(settings: ResolvedVoxelWorld): void {
    if (this.disposed) return;
    this.quiet = false;
    this.skipAt = null;
    applyWorldRings(this.streamer, settings);
    const b = this.collisionBounds(settings);
    this.ring?.setBounds(b);
    if (this.streamer.collision !== null) this.streamer.collision.bounds = b;
  }

  /** Horizontal and vertical gaps (metres) from a grid point to its box (0 inside). */
  private gaps(p: readonly number[]): [number, number] {
    const b = this.box!;
    const gap = (a: number): number => Math.max(0, b.min[a]! - p[a]!, p[a]! - b.max[a]!);
    return [Math.hypot(gap(0), gap(2)), gap(1)];
  }

  /**
   * A step: the world's foci (world metres) moved into the grid's frame, streaming and its bodies planned there, when
   * there is anything to do (see the file's note). Else nothing but a distance test: while its streamer is quiet and
   * nothing landed, the stream focus may move {@link skipM} from {@link skipAt} before the grid looks again, and a
   * body is looked at only once it comes within the grid's sphere and its collision's keep bounds.
   */
  step(stream: readonly [number, number, number], collide: readonly (readonly [number, number, number])[], velocity: readonly (readonly [number, number, number])[] | undefined, settings: ResolvedVoxelWorld): void {
    if (this.disposed || this.box === null) return;
    const s = this.streamer;
    if (this.boundsOf !== settings) {
      this.boundsOf = settings;
      this.bounds = this.collisionBounds(settings);
    }
    const cb = this.bounds!;
    const slack = s.grid.edge * VOXEL_SIZE_M * Math.SQRT2;
    if (this.quiet && s.counters.activity === this.steppedActivity && this.skipAt !== null && this.steppedFoci.length === 0) {
      const d = [stream[0] - this.skipAt[0]!, stream[1] - this.skipAt[1]!, stream[2] - this.skipAt[2]!];
      const c = this.sphere!;
      const touch = (c.r + Math.max(cb.keepRadius, cb.keepHeight) * VOXEL_SIZE_M + slack) ** 2;
      if (d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]! < this.skipM * this.skipM && collide.every((p) => (p[0]! - c.x) ** 2 + (p[1]! - c.y) ** 2 + (p[2]! - c.z) ** 2 >= touch)) {
        this.skipped++;
        return;
      }
    }
    const at = this.frame.toGrid(stream[0], stream[1], stream[2]);
    this.focusM = at;
    // In reach while any chunk it reads could be inside the unload bounds (one chunk's diagonal of slack).
    const ring = s.ring;
    const [h, v] = this.gaps(at);
    const outH = h - (ring.unloadRadius * VOXEL_SIZE_M + slack);
    const outV = v - (ring.unloadHeight * VOXEL_SIZE_M + slack);
    const inReach = outH < 0 && outV < 0;
    // Bodies whose collision could reach its box (the keep bounds, metres); the camera's own ground likewise.
    const near = (gh: number, gv: number): boolean => gh < cb.keepRadius * VOXEL_SIZE_M + slack && gv < cb.keepHeight * VOXEL_SIZE_M + slack;
    const nearIndex: number[] = [];
    const bodies: Focus[] = [];
    collide.forEach((p, i) => {
      const q = this.frame.toGrid(p[0]!, p[1]!, p[2]!);
      const [gh, gv] = this.gaps(q);
      if (!near(gh, gv)) return;
      nearIndex.push(i);
      bodies.push(toCells(q));
    });
    if (this.quiet && !inReach && !this.inReach && bodies.length === 0 && this.steppedFoci.length === 0) {
      // Out of reach and holding nothing: looked at again once the focus may have come within reach.
      this.skipAt = stream;
      this.skipM = Math.max(VOXEL_SIZE_M, outH, outV);
      this.skipped++;
      return;
    }
    const within = (a: Focus, b: Focus, d: number): boolean => Math.abs(a.x - b.x) < d && Math.abs(a.y - b.y) < d && Math.abs(a.z - b.z) < d;
    const f = toCells(at);
    // Bodies are told every cell they move (what they touch); the stream focus by its share of the gap.
    const refocus = Math.min((s.mips?.lod.levelRings.hysteresis ?? 2) / 2, Math.max(1, (Math.hypot(h, v) / VOXEL_SIZE_M) * GRID_REFOCUS_SHARE));
    const still = this.steppedAt !== null && within(f, toCells(this.steppedAt), refocus) && bodies.length === this.steppedFoci.length && bodies.every((b, i) => within(b, this.steppedFoci[i]!, 1));
    if (this.quiet && still && s.counters.activity === this.steppedActivity && inReach === this.inReach) {
      // Measured from where it was last told, by a distance a turn cannot stretch (each axis is within it then).
      this.skipAt = this.steppedWorld;
      this.skipM = refocus * VOXEL_SIZE_M;
      this.skipped++;
      return;
    }
    s.setFocus(f.x, f.y, f.z);
    s.mips?.lod.setFoci(bodies);
    const ahead = bodies.flatMap((b, k) => {
      const vel = velocity?.[nearIndex[k]!];
      return vel === undefined ? [] : collisionLeadPoints(b, toCells(this.frame.directionToGrid(vel[0]!, vel[1]!, vel[2]!)), cb.radius);
    });
    const foci = [...(s.detail.fast || !near(h, v) ? [] : [f]), ...bodies, ...ahead];
    s.collision?.setFoci(foci);
    s.update();
    if (this.ring !== null) {
      this.ring.setFoci(foci);
      this.ring.update();
    }
    this.updates++;
    this.steppedAt = at;
    this.steppedWorld = stream;
    this.steppedFoci = bodies;
    this.inReach = inReach;
    this.quiet = s.idle(true);
    this.steppedActivity = s.counters.activity;
    this.skipAt = stream;
    this.skipM = refocus * VOXEL_SIZE_M;
  }

  /** The grid's share of its world's budget from now on (bytes; its streamer evicts down to it at its next update). */
  setBudget(bytes: number): void {
    this.streamer.budgetBytes = Math.max(1, bytes);
  }

  /** A new run: the game's changes dropped (none reach a structure grid yet). */
  reset(): void {
    this.streamer.clearOverlay();
    this.quiet = false;
    this.skipAt = null;
  }

  /** The world unloads: the body out of the port (the pool is the world's, closed with it). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.body?.clear();
    this.unresident();
  }

  /** What keeps its streamer from being quiet now (diagnostics): `none`, or the first of reads, derives, levels, collision, time, wanted. */
  private waits(m: ReturnType<VoxelStreamer['metrics']>): string {
    const s = this.streamer;
    if (s.idle(true)) return 'none';
    if (m.reading + m.decoding > 0) return 'reads';
    if (m.deriving > 0) return 'derives';
    if (s.mips?.pending() === true) return s.mips.lod.pending() ? 'levels: choice' : 'levels: nodes';
    if (s.collision?.pending() === true) return 'collision';
    return s.idle() ? 'time' : 'wanted';
  }

  /** What the grid holds (diagnostics): its id, resident chunks and bytes, its body. */
  stats(): { readonly grid: number; readonly resident: number; readonly reading: number; readonly decoding: number; readonly deriving: number; readonly bytes: number; readonly body: VoxelGridBodyStats | null; readonly focusM: readonly number[]; readonly detailHeld: boolean; readonly lod: Readonly<Record<string, number>> | null; readonly drawnAt: readonly number[]; readonly updates: number; readonly skipped: number; readonly waits: string } {
    const m = this.streamer.metrics();
    // Of the chunks the grid holds, those drawn at level 0, and the level-1 nodes over them drawn.
    const drawnAt = [0, 0];
    const lod = this.streamer.mips?.lod.drawn;
    const e = this.extent;
    if (lod !== undefined && e !== null) for (let x = e.min[0]; x <= e.max[0]; x++) for (let y = e.min[1]; y <= e.max[1]; y++) for (let z = e.min[2]; z <= e.max[2]; z++) {
      if (lod.drawn(0, x, y, z)) drawnAt[0]!++;
      if (lod.drawn(1, x >> 1, y >> 1, z >> 1)) drawnAt[1]!++;
    }
    return { grid: this.frame.gridId, resident: m.resident, reading: m.reading, decoding: m.decoding, deriving: m.deriving, bytes: m.bytes.total, body: this.body?.stats() ?? null, focusM: this.focusM.map((v) => Math.round(v * 100) / 100), detailHeld: this.streamer.detail.held, lod: this.streamer.mips?.lod.counters ?? null, drawnAt, updates: this.updates, skipped: this.skipped, waits: this.waits(m) };
  }
}
