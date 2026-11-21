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
export function gridStats(list: readonly ReturnType<VoxelGridHost['stats']>[]): { count: number; resident: number; reading: number; decoding: number; deriving: number; bytes: number; bodies: number; shapes: number; bodyBuilds: number; bodyBuildMs: number; bytesPerGrid: { min: number; max: number }; nearest: ReturnType<VoxelGridHost['stats']> | null } {
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
    bytesPerGrid: { min: Math.min(...list.map((g) => g.bytes)), max: Math.max(...list.map((g) => g.bytes)) },
    // The grid nearest the stream focus, as its streamer sees it (diagnostics: its frame, level choice, held detail).
    nearest: [...list].sort((a, b) => Math.hypot(...a.focusM) - Math.hypot(...b.focusM))[0] ?? null,
  };
}

const toCells = (p: readonly number[]): Focus => ({ x: p[0]! / VOXEL_SIZE_M, y: p[1]! / VOXEL_SIZE_M, z: p[2]! / VOXEL_SIZE_M });

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
    // No far cache and no fine bricks: a structure grid's far field is not built yet (its world's far cache holds the world grid alone).
    this.streamer = worldStreamer({ grid, source: g.source, pool: shared.pool, gridId: g.place.gridId, tracker: shared.tracker, extent: g.extent === null ? null : grownChunkBox(g.extent, GRID_EXTENT_MARGIN_CHUNKS), ...(shared.budgetBytes !== undefined ? { budgetBytes: shared.budgetBytes } : {}), ...(shared.pieces !== undefined ? { pieces: shared.pieces } : {}), fineBricks: false }, settings);
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
    applyWorldRings(this.streamer, settings);
    const b = this.collisionBounds(settings);
    this.ring?.setBounds(b);
    if (this.streamer.collision !== null) this.streamer.collision.bounds = b;
  }

  /** A step: the world's foci (world metres) moved into the grid's frame, streaming and its bodies planned there. */
  step(stream: readonly [number, number, number], collide: readonly (readonly [number, number, number])[], velocity: readonly (readonly [number, number, number])[] | undefined, settings: ResolvedVoxelWorld): void {
    if (this.disposed) return;
    const s = this.streamer;
    this.focusM = this.frame.toGrid(stream[0], stream[1], stream[2]);
    const f = toCells(this.focusM);
    s.setFocus(f.x, f.y, f.z);
    const bodies = collide.map((p) => toCells(this.frame.toGrid(p[0]!, p[1]!, p[2]!)));
    s.mips?.lod.setFoci(bodies);
    const radius = this.collisionBounds(settings).radius;
    const ahead = bodies.flatMap((b, i) => {
      const v = velocity?.[i];
      return v === undefined ? [] : collisionLeadPoints(b, toCells(this.frame.directionToGrid(v[0]!, v[1]!, v[2]!)), radius);
    });
    const foci = [...(s.detail.fast ? [] : [f]), ...bodies, ...ahead];
    s.collision?.setFoci(foci);
    s.update();
    if (this.ring !== null) {
      this.ring.setFoci(foci);
      this.ring.update();
    }
  }

  /** A new run: the game's changes dropped (none reach a structure grid yet). */
  reset(): void {
    this.streamer.clearOverlay();
  }

  /** The world unloads: the body out of the port (the pool is the world's, closed with it). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.body?.clear();
    this.unresident();
  }

  /** What the grid holds (diagnostics): its id, resident chunks and bytes, its body. */
  stats(): { readonly grid: number; readonly resident: number; readonly reading: number; readonly decoding: number; readonly deriving: number; readonly bytes: number; readonly body: VoxelGridBodyStats | null; readonly focusM: readonly number[]; readonly detailHeld: boolean; readonly lod: Readonly<Record<string, number>> | null; readonly drawnAt: readonly number[] } {
    const m = this.streamer.metrics();
    // Of the chunks the grid holds, those drawn at level 0, and the level-1 nodes over them drawn.
    const drawnAt = [0, 0];
    const lod = this.streamer.mips?.lod.drawn;
    const e = this.extent;
    if (lod !== undefined && e !== null) for (let x = e.min[0]; x <= e.max[0]; x++) for (let y = e.min[1]; y <= e.max[1]; y++) for (let z = e.min[2]; z <= e.max[2]; z++) {
      if (lod.drawn(0, x, y, z)) drawnAt[0]!++;
      if (lod.drawn(1, x >> 1, y >> 1, z >> 1)) drawnAt[1]!++;
    }
    return { grid: this.frame.gridId, resident: m.resident, reading: m.reading, decoding: m.decoding, deriving: m.deriving, bytes: m.bytes.total, body: this.body?.stats() ?? null, focusM: this.focusM.map((v) => Math.round(v * 100) / 100), detailHeld: this.streamer.detail.held, lod: this.streamer.mips?.lod.counters ?? null, drawnAt };
  }
}
