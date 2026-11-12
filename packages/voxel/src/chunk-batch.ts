/**
 * A voxel world's draws handed from where the world runs to where it is
 * drawn. In a game the world runs with the simulation (its worker, or the
 * page in single-thread mode): the store, the overlay of the game's edits,
 * the streamer, its derive workers and the collision bodies. The page only
 * draws; it gets each chunk's joined sections as plain buffers.
 *
 * Everything one task of the streamer brings goes out as one batch: the
 * streamer emits every `chunk` event of a swap in one task just before the
 * swap, so a swap's chunks reach the page in one message and are replaced
 * between the same two frames (the edit stays atomic for draws, as it is
 * for bodies, which the simulation replaces in that same task). The
 * buffers are made by the join for the batch, so a worker hands them over
 * without a copy (the transfer list).
 *
 * A chunk whose draw was sent and whose shader data alone changed gets its
 * grid only. The page answers with each drawn chunk's GPU bytes, counted as
 * the chunk's `mesh` part of the stream budget where the world runs.
 *
 * With mip levels (the streamer's `mips`), only what the level choice draws
 * goes out: a chunk drawn at level 0, a node of a coarser level (one draw
 * a node, its grid in its own cells), and the seams between levels. A
 * change of the levels drawn comes as a `seams` event and a `levels` event
 * in one task, so the new nodes, the old ones' removal and their seams
 * leave in one batch and the page swaps them between the same two frames:
 * the old level is drawn until the new one is complete. A node's new result
 * and the seams rebuilt from it come in one task too, and the nodes an edit
 * changes on screen come in its swap's task, with its chunks.
 */
import { crc32, wallClock } from '@thirdlight/shared';
import { chunkKey, chunkOfKey, type ChunkGrid } from './coords';
import type { FarEvent, FarNodeDraw } from './far-field';
import type { FarSeenWire } from './far-seen';
import type { MipNode } from './voxel-mips';
import type { JoinedDraw, JoinTimes } from './chunk-join';
import type { DerivedData } from './derived-data';
import type { InstanceList, SurfaceBuffer } from './derived-mesh';
import { reliefBytes, type ReliefSurface } from './relief-mesh';
import { RELIEF_DRAW_PART } from './relief-ring';
import { shaderGridEntries, shaderGridSide, shaderSolidEntry } from './derived-shader';
import type { FaceSeam, NodeFace } from './lod-seam';
import type { SwapReport } from './stream-sections';
import type { StreamEvent } from './voxel-streamer';

/** A surface as drawn: a relief mesh's carries a crease weight a vertex (relief-mesh.ts; 0 fixed, 255 free). */
export type DrawSurface = SurfaceBuffer & { readonly crease?: Uint8Array };

/** One chunk's (or, with `level`, one mip node's) change in a batch. */
export interface ChunkDrawWire {
  /** The chunk-tree level (absent: 0, a storage chunk); cx, cy, cz are then the node's coordinates at that level. */
  readonly level?: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** `draw`: its draw is replaced (nothing to draw removes it); `shader`: only its shader data; `remove`: no longer drawn. */
  readonly kind: 'draw' | 'shader' | 'remove';
  readonly ground?: DrawSurface;
  readonly base?: DrawSurface;
  /**
   * With a relief draw: the chunk's plain surfaces (what collides), for a
   * view that casts shadows to draw into its shadow maps in place of the
   * relief meshes (the relief only ever recesses the plain surface, so the
   * plain solid holds it).
   */
  readonly caster?: { readonly ground: SurfaceBuffer; readonly base: SurfaceBuffer };
  readonly instances?: InstanceList;
  /** The grid's one solid entry (0: all air), or −1: its side³ entries are in `cells`. */
  readonly solid?: number;
  readonly cells?: Uint16Array;
}

/** One seam piece: positions in the finer level's steps from `origin` (cells of the finer level). */
export interface SeamPieceWire {
  readonly origin: readonly [number, number, number];
  readonly ground: SurfaceBuffer;
  readonly base: SurfaceBuffer;
}

/** A seam between levels in a batch: the coarse node's (level ≥ 1) face, its pieces drawn, or removed. */
export interface SeamDrawWire {
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly face: NodeFace;
  readonly kind: 'draw' | 'remove';
  readonly pieces?: readonly SeamPieceWire[];
}

/** What a swap in a batch did (its measures, for edit-to-screen timings). */
export interface ChunkSwapWire {
  readonly groups: readonly number[];
  readonly sections: number;
  readonly chunks: number;
  /** ms from the edit to the swap where the world runs. */
  readonly ms: number;
  /** Main-thread ms there building the swap's derive jobs. */
  readonly mainMs: number;
}

/**
 * The relief ring as the draws displace by it (cells): lattice steps a cell (0: none), where the displacement ends
 * now and the ring's centre; the vertex stage fades over the last metres before `radius` from `focus`.
 */
export interface ChunkReliefWire {
  readonly n: number;
  readonly radius: number;
  readonly focus: readonly [number, number, number];
}

/** A {@link NearCoverWire} chunk the far field is hidden in. */
export const NEAR_COVER_HIDDEN = 2;

/** A {@link NearCoverWire} chunk of the near field's edge ring: the far field draws there, behind the near field. */
export const NEAR_COVER_EDGE = 1;

/**
 * Where the near field draws, for the far field to leave to it: a box of
 * storage chunks (`min`, `size` in chunks) and one byte a chunk (index
 * `x + size[0] * (y + size[1] * z)`): {@link NEAR_COVER_HIDDEN} where the
 * near field draws that chunk and every chunk round it (the far field is
 * not drawn there), {@link NEAR_COVER_EDGE} in the ring of drawn chunks
 * just inside its edge, 0 elsewhere. In the edge ring the far field
 * overlaps the near field by one chunk and closes any gap between the two
 * levels' surfaces, but its depth goes behind all of the near field, so the
 * near field wins wherever it has geometry, even where the coarser far
 * surface lies above it.
 */
export interface NearCoverWire {
  readonly min: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly cells: Uint8Array;
}

/** The far field's change in a batch (far-field.ts): nodes drawn (or drawn again) and nodes no longer drawn. */
export interface FarDrawWire {
  readonly added: readonly FarNodeDraw[];
  readonly removed: readonly MipNode[];
  /** The last far event in it ({@link FarEvent.seq}): what the draws name in their visibility feedback. */
  readonly seq?: number;
}

export interface ChunkDrawBatch {
  readonly world: string;
  /** The storage chunks' edge (cells). */
  readonly edge: number;
  /** The world closed (its scene unloaded): every draw of it goes. */
  readonly closed?: true;
  readonly chunks: readonly ChunkDrawWire[];
  /** Seams drawn or removed (applied after `chunks`). */
  readonly seams?: readonly SeamDrawWire[];
  readonly swaps: readonly ChunkSwapWire[];
  /** The relief ring changed (its centre moved, its steps or radius): what the draws displace by from now on. */
  readonly relief?: ChunkReliefWire;
  /** The far field's draws changed (applied after `chunks` and `seams`). */
  readonly far?: FarDrawWire;
  /** Where the near field draws changed (with a far field only). */
  readonly nearCover?: NearCoverWire;
  /** Wall-clock ms (`performance.timeOrigin + performance.now()`) when the batch left. */
  readonly sentAt: number;
  /** ms the batch's joins took where the world runs. */
  readonly joinMs: number;
}

/** What the batcher reads of a streamer's mip levels (`VoxelStreamer.mips`). */
export interface ChunkDrawLevels {
  /** The level choice: what is drawn now. */
  readonly lod: { readonly drawn: { drawn(level: number, nx: number, ny: number, nz: number): boolean; nodes?(): Iterable<{ readonly level: number; readonly nx: number; readonly ny: number; readonly nz: number }> } };
  derivedOf(level: number, nx: number, ny: number, nz: number): DerivedData | null;
  readonly seams: { seamOf(level: number, nx: number, ny: number, nz: number, face: NodeFace): FaceSeam | null };
  /** The page's GPU bytes of every node and seam it draws, counted in the mip share of the budget. */
  gpuBytes: number;
}

/** What the batcher needs of a streamer. */
export interface ChunkDrawFeed {
  readonly grid: ChunkGrid;
  /** The mip levels (null or absent: none, every derived chunk is drawn). */
  readonly mips?: ChunkDrawLevels | null;
  on(listener: (e: StreamEvent) => void): void;
  joinedChunk(cx: number, cy: number, cz: number, times: JoinTimes | undefined, cells: Uint16Array): JoinedDraw | null;
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean;
  /** The kit pieces (`VoxelStreamer.pieces`): the page's GPU bytes of the kit meshes and textures they draw from, counted in the budget. */
  readonly pieces?: { gpuBytes: number };
  /** The far field (`VoxelStreamer.far`; null or absent: none). */
  readonly far?: { on(listener: (e: FarEvent) => void): void; gpuBytes: number; feedback?(fb: FarSeenWire): void } | null;
}

export interface ChunkDrawBatcherOptions {
  /** When a batch is sent (default: at the end of the task, a microtask). */
  readonly schedule?: (flush: () => void) => void;
  /**
   * Told of every chunk's join on its `chunk` event, drawn or not (`drawn`:
   * at level 0), for what else is built per chunk from the same join (a
   * page's collision bodies; `bodiesStand`: only shader data or relief
   * meshes changed, what collides is as it was). With it every chunk event
   * is joined.
   */
  readonly onJoined?: (cx: number, cy: number, cz: number, joined: JoinedDraw | null, bodiesStand: boolean, drawn: boolean) => void;
  /**
   * The batches are applied where the world runs and never transferred
   * (default false): buffers the streamer keeps (node results, seams) are
   * then sent as they are, not copied.
   */
  readonly inPlace?: boolean;
}

/** The buffers a batch can hand over (each once). */
export function chunkDrawBatchTransfer(b: ChunkDrawBatch): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView | undefined): void => {
    if (a !== undefined && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  };
  for (const c of b.chunks) {
    add(c.ground?.vertices);
    add(c.ground?.indices);
    add(c.base?.vertices);
    add(c.base?.indices);
    add(c.ground?.crease);
    add(c.base?.crease);
    add(c.caster?.ground.vertices);
    add(c.caster?.ground.indices);
    add(c.caster?.base.vertices);
    add(c.caster?.base.indices);
    add(c.instances?.data);
    add(c.cells);
  }
  for (const s of b.seams ?? []) for (const p of s.pieces ?? []) {
    add(p.ground.vertices);
    add(p.ground.indices);
    add(p.base.vertices);
    add(p.base.indices);
  }
  for (const a of b.far?.added ?? []) {
    add(a.mesh?.vertices);
    add(a.mesh?.indices);
    add(a.bricks?.bricks);
    add(a.bricks?.samples);
    add(a.bricks?.looks);
    add(a.bricks?.blocks);
    add(a.fine?.cells);
    add(a.fine?.words);
  }
  add(b.nearCover?.cells);
  return [...out];
}

/** The budget part a chunk's draw (its GPU buffers and shader grid) is counted as. */
export const MESH_PART = 'mesh';

/**
 * Collects a streamer's chunk draws task by task and sends each task's as
 * one batch (at the end of the task: a microtask). `sectionEdge`: the
 * world's derive section edge; a join of whole-chunk sections hands out
 * the sections' own buffers, which are copied before they leave.
 */
export class ChunkDrawBatcher {
  private readonly grid: ChunkGrid;
  private readonly scratch: Uint16Array;
  private readonly copy: boolean;
  /** Chunks whose draw was sent and not removed since. */
  private readonly sent = new Set<number>();
  /** Bytes of the relief meshes in each chunk's draw sent (only chunks drawn with relief). */
  private readonly reliefSent = new Map<number, number>();
  /** Mip nodes and seams whose draw was sent and not removed since ("level,nx,ny,nz", "…,face"). */
  private readonly nodesSent = new Set<string>();
  private readonly seamsSent = new Set<string>();
  private readonly opts: ChunkDrawBatcherOptions;
  private chunks: ChunkDrawWire[] = [];
  private seams: SeamDrawWire[] = [];
  private swaps: ChunkSwapWire[] = [];
  private relief: ChunkReliefWire | null = null;
  private farAdded: FarNodeDraw[] = [];
  private farRemoved: MipNode[] = [];
  private farSeq = 0;
  /** The near field's draws changed since the cover last went (with a far field). */
  private coverDirty = false;
  private coverSent = '';
  private joinMs = 0;
  private queued = false;
  private closed = false;
  /** Batches sent (with or without swaps). */
  batches = 0;

  constructor(
    private readonly world: string,
    private readonly feed: ChunkDrawFeed,
    sectionEdge: number,
    private readonly send: (b: ChunkDrawBatch) => void,
    opts: ChunkDrawBatcherOptions | ((flush: () => void) => void) = {},
  ) {
    this.opts = typeof opts === 'function' ? { schedule: opts } : opts;
    this.grid = feed.grid;
    this.copy = sectionEdge === feed.grid.edge && this.opts.inPlace !== true;
    const side = shaderGridSide(feed.grid.edge);
    this.scratch = new Uint16Array(side * side * side);
    feed.on((e) => this.onStream(e));
    feed.far?.on((e) => {
      if (this.closed) return;
      this.farAdded.push(...e.added);
      this.farRemoved.push(...e.removed);
      this.farSeq = e.seq;
      this.queue();
    });
  }

  private onStream(e: StreamEvent): void {
    if (this.closed) return;
    // What the near field draws changes with the levels drawn (and, without mip levels, with each chunk drawn or gone).
    if (this.feed.far != null && (e.type === 'unloaded' || e.type === 'levels' || (e.type === 'chunk' && this.feed.mips == null))) {
      this.coverDirty = true;
      this.queue();
    }
    if (e.type === 'unloaded') {
      const key = chunkKey(this.grid, e.cx, e.cy, e.cz);
      this.reliefSent.delete(key);
      if (this.sent.delete(key)) this.push({ cx: e.cx, cy: e.cy, cz: e.cz, kind: 'remove' });
    } else if (e.type === 'chunk') this.chunk(e.cx, e.cy, e.cz, e.shaderOnly, e.reliefOnly);
    else if (e.type === 'swap') this.swap(e.report);
    else if (e.type === 'relief') {
      this.relief = { n: e.n, radius: e.radius, focus: [e.x, e.y, e.z] };
      this.queue();
    }
    else if (e.type === 'levels') {
      // Removed first: a chunk drawn again in the same swap (a level change and back) ends drawn.
      for (const n of e.removed) {
        if (n.level === 0) this.undraw(n.nx, n.ny, n.nz);
        else if (this.nodesSent.delete(`${n.level},${n.nx},${n.ny},${n.nz}`)) this.push({ level: n.level, cx: n.nx, cy: n.ny, cz: n.nz, kind: 'remove' });
      }
      for (const n of e.added) {
        if (n.level === 0) this.chunk(n.nx, n.ny, n.nz, false, false);
        else this.node(n.level, n.nx, n.ny, n.nz);
      }
    } else if (e.type === 'node') {
      const levels = this.feed.mips;
      if (levels != null && levels.lod.drawn.drawn(e.level, e.nx, e.ny, e.nz)) this.node(e.level, e.nx, e.ny, e.nz);
    } else if (e.type === 'seams') {
      for (const k of e.removed) {
        if (this.seamsSent.delete(`${k.level},${k.nx},${k.ny},${k.nz},${k.face}`)) this.pushSeam({ level: k.level, nx: k.nx, ny: k.ny, nz: k.nz, face: k.face, kind: 'remove' });
      }
      for (const k of e.built) this.seam(k.level, k.nx, k.ny, k.nz, k.face);
    }
  }

  /** A chunk no longer drawn at level 0 (it stays resident): its draw goes, and its parts with it. */
  private undraw(cx: number, cy: number, cz: number): void {
    const key = chunkKey(this.grid, cx, cy, cz);
    if (!this.sent.delete(key)) return;
    this.push({ cx, cy, cz, kind: 'remove' });
    this.dropParts(cx, cy, cz, key);
  }

  private dropParts(cx: number, cy: number, cz: number, key: number): void {
    this.feed.setPart(cx, cy, cz, MESH_PART, 0);
    if (this.reliefSent.delete(key)) this.feed.setPart(cx, cy, cz, RELIEF_DRAW_PART, 0);
  }

  private chunk(cx: number, cy: number, cz: number, shaderOnly: boolean, reliefOnly: boolean): void {
    const key = chunkKey(this.grid, cx, cy, cz);
    const levels = this.feed.mips;
    const drawn = levels == null || levels.lod.drawn.drawn(0, cx, cy, cz);
    const onJoined = this.opts.onJoined;
    if (!drawn && onJoined === undefined) return this.undraw(cx, cy, cz);
    const t0 = performance.now();
    const d = this.feed.joinedChunk(cx, cy, cz, undefined, this.scratch);
    this.joinMs += performance.now() - t0;
    onJoined?.(cx, cy, cz, d, shaderOnly || reliefOnly, drawn);
    if (!drawn) return this.undraw(cx, cy, cz);
    if (d === null) {
      if (this.sent.delete(key)) {
        this.push({ cx, cy, cz, kind: 'remove' });
        // The chunk stays resident with no draw: the page reports no bytes for a removed draw, so its parts go here.
        this.dropParts(cx, cy, cz, key);
      }
      return;
    }
    const cells = d.solid < 0 ? this.scratch.slice() : undefined;
    const grid = { solid: d.solid, ...(cells !== undefined ? { cells } : {}) };
    if (shaderOnly && this.sent.has(key)) {
      this.push({ cx, cy, cz, kind: 'shader', ...grid });
      return;
    }
    this.sent.add(key);
    const own = <T extends Uint8Array | Uint16Array | Uint32Array>(a: T): T => (this.copy ? (a.slice() as T) : a);
    const surface = (s: SurfaceBuffer): SurfaceBuffer => ({ vertexCount: s.vertexCount, vertices: own(s.vertices), indices: own(s.indices) });
    if (d.relief !== undefined) {
      // The relief mesh is drawn in place of the surfaces (the plain ones still collide, and cast where shadows are
      // drawn), its crease weights with it.
      const relief = (r: ReliefSurface): DrawSurface => ({ ...surface(r), crease: own(r.crease) });
      // What of the chunk's draw is relief (its GPU copy): the relief share's, not the base world's; a plain caster the
      // view builds is the chunk's mesh part, as the same surfaces drawn plain would be.
      this.reliefSent.set(key, reliefBytes({ n: 0, ...d.relief }));
      const caster = { ground: surface(d.ground), base: surface(d.base) };
      this.push({ cx, cy, cz, kind: 'draw', ground: relief(d.relief.ground), base: relief(d.relief.base), caster, instances: { count: d.instances.count, data: own(d.instances.data) }, ...grid });
      return;
    }
    if (this.reliefSent.delete(key)) this.feed.setPart(cx, cy, cz, RELIEF_DRAW_PART, 0);
    this.push({ cx, cy, cz, kind: 'draw', ground: surface(d.ground), base: surface(d.base), instances: { count: d.instances.count, data: own(d.instances.data) }, ...grid });
  }

  /** A drawn mip node's draw from its current result (nothing to draw: removed). */
  private node(level: number, nx: number, ny: number, nz: number): void {
    const id = `${level},${nx},${ny},${nz}`;
    const d = this.feed.mips?.derivedOf(level, nx, ny, nz) ?? null;
    if (d === null || (d.ground.indices.length === 0 && d.base.indices.length === 0 && d.instances.count === 0)) {
      if (this.nodesSent.delete(id)) this.push({ level, cx: nx, cy: ny, cz: nz, kind: 'remove' });
      return;
    }
    this.nodesSent.add(id);
    const solid = shaderSolidEntry(d.shader);
    const cells = solid < 0 ? shaderGridEntries(d.shader, new Uint16Array(this.scratch.length)) : undefined;
    // The streamer keeps the node's result (seams read it): a batch that leaves the thread takes copies.
    const own = <T extends Uint8Array | Uint16Array | Uint32Array>(a: T): T => (this.opts.inPlace === true ? a : (a.slice() as T));
    const surface = (s: SurfaceBuffer): SurfaceBuffer => ({ vertexCount: s.vertexCount, vertices: own(s.vertices), indices: own(s.indices) });
    this.push({ level, cx: nx, cy: ny, cz: nz, kind: 'draw', ground: surface(d.ground), base: surface(d.base), instances: { count: d.instances.count, data: own(d.instances.data) }, solid, ...(cells !== undefined ? { cells } : {}) });
  }

  private seam(level: number, nx: number, ny: number, nz: number, face: NodeFace): void {
    const id = `${level},${nx},${ny},${nz},${face}`;
    const s = this.feed.mips?.seams.seamOf(level, nx, ny, nz, face) ?? null;
    if (s === null || s.pieces.length === 0) {
      if (this.seamsSent.delete(id)) this.pushSeam({ level, nx, ny, nz, face, kind: 'remove' });
      return;
    }
    this.seamsSent.add(id);
    const own = <T extends Uint8Array | Uint16Array | Uint32Array>(a: T): T => (this.opts.inPlace === true ? a : (a.slice() as T));
    const surface = (b: SurfaceBuffer): SurfaceBuffer => ({ vertexCount: b.vertexCount, vertices: own(b.vertices), indices: own(b.indices) });
    this.pushSeam({ level, nx, ny, nz, face, kind: 'draw', pieces: s.pieces.map((p) => ({ origin: [p.origin[0], p.origin[1], p.origin[2]], ground: surface(p.ground), base: surface(p.base) })) });
  }

  private pushSeam(w: SeamDrawWire): void {
    this.seams.push(w);
    this.queue();
  }

  private swap(r: SwapReport): void {
    this.swaps.push({ groups: r.groups, sections: r.sections, chunks: r.chunks.length, ms: r.ms, mainMs: r.mainMs });
    this.queue();
  }

  private push(c: ChunkDrawWire): void {
    this.chunks.push(c);
    this.queue();
  }

  private queue(): void {
    if (this.queued) return;
    this.queued = true;
    const flush = (): void => this.flush();
    if (this.opts.schedule !== undefined) this.opts.schedule(flush);
    else queueMicrotask(flush);
  }

  private flush(): void {
    this.queued = false;
    const cover = this.coverDirty ? this.nearCover() : null;
    this.coverDirty = false;
    const far = this.farAdded.length > 0 || this.farRemoved.length > 0 ? { added: this.farAdded, removed: this.farRemoved, seq: this.farSeq } : null;
    if (this.closed || (this.chunks.length === 0 && this.seams.length === 0 && this.swaps.length === 0 && this.relief === null && far === null && cover === null)) return;
    const b: ChunkDrawBatch = { world: this.world, edge: this.grid.edge, chunks: this.chunks, ...(this.seams.length > 0 ? { seams: this.seams } : {}), swaps: this.swaps, ...(this.relief !== null ? { relief: this.relief } : {}), ...(far !== null ? { far } : {}), ...(cover !== null ? { nearCover: cover } : {}), sentAt: wallClock(), joinMs: this.joinMs };
    this.farAdded = [];
    this.farRemoved = [];
    this.relief = null;
    this.chunks = [];
    this.seams = [];
    this.swaps = [];
    this.joinMs = 0;
    this.batches++;
    this.send(b);
  }

  /**
   * Where the near field draws now, eroded by one chunk, and its edge ring ({@link NearCoverWire}),
   * or null when it is what was sent last: the drawn levels' nodes (empty
   * chunks included: the near field is what shows there), else the chunks
   * whose draws were sent.
   */
  private nearCover(): NearCoverWire | null {
    const boxes: Array<readonly [number, number, number, number]> = [];
    const drawnNodes = this.feed.mips?.lod.drawn.nodes?.();
    if (drawnNodes !== undefined) {
      for (const n of drawnNodes) boxes.push([n.nx << n.level, n.ny << n.level, n.nz << n.level, 1 << n.level]);
    } else {
      const c = { cx: 0, cy: 0, cz: 0 };
      for (const key of this.sent) {
        chunkOfKey(this.grid, key, c);
        boxes.push([c.cx, c.cy, c.cz, 1]);
      }
    }
    let wire: NearCoverWire;
    if (boxes.length === 0) wire = { min: [0, 0, 0], size: [1, 1, 1], cells: new Uint8Array(1) };
    else {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const [x, y, z, s] of boxes) {
        lo[0] = Math.min(lo[0]!, x);
        lo[1] = Math.min(lo[1]!, y);
        lo[2] = Math.min(lo[2]!, z);
        hi[0] = Math.max(hi[0]!, x + s - 1);
        hi[1] = Math.max(hi[1]!, y + s - 1);
        hi[2] = Math.max(hi[2]!, z + s - 1);
      }
      const size: [number, number, number] = [hi[0]! - lo[0]! + 1, hi[1]! - lo[1]! + 1, hi[2]! - lo[2]! + 1];
      const [sx, sy, sz] = size;
      let cells = new Uint8Array(sx * sy * sz);
      for (const [x, y, z, s] of boxes) {
        for (let dz = 0; dz < s; dz++) for (let dy = 0; dy < s; dy++) {
          const row = x - lo[0]! + sx * (y + dy - lo[1]! + sy * (z + dz - lo[2]!));
          cells.fill(1, row, row + s);
        }
      }
      // Eroded by one chunk (a chunk counts when it and every chunk round it is drawn): a minimum over three
      // along each axis in turn is the minimum over the 27. What erosion takes off is the edge ring.
      const drawn = cells;
      const strides = [1, sx, sx * sy];
      for (let a = 0; a < 3; a++) {
        const out = new Uint8Array(cells.length);
        const st = strides[a]!;
        const n = size[a]!;
        for (let i = 0; i < cells.length; i++) {
          const k = Math.floor(i / st) % n;
          out[i] = k > 0 && k < n - 1 && cells[i]! !== 0 && cells[i - st]! !== 0 && cells[i + st]! !== 0 ? 1 : 0;
        }
        cells = out;
      }
      for (let i = 0; i < cells.length; i++) cells[i] = cells[i] !== 0 ? NEAR_COVER_HIDDEN : drawn[i] !== 0 ? NEAR_COVER_EDGE : 0;
      wire = { min: [lo[0]!, lo[1]!, lo[2]!], size, cells };
    }
    const sig = `${wire.min.join(',')}/${wire.size.join(',')}/${wire.cells.length}:${crc32(wire.cells)}`;
    if (sig === this.coverSent) return null;
    this.coverSent = sig;
    return wire;
  }

  /** The page's GPU bytes of drawn chunks (`[cx, cy, cz, bytes]` repeated): each chunk's `mesh` part; `coarse`: every node's and seam's, summed; `kits`: the kit meshes and textures. */
  drawn(bytes: readonly number[], coarse: number, kits = 0, far = 0): void {
    if (this.closed) return;
    if (this.feed.far != null) this.feed.far.gpuBytes = far;
    // Nothing draws nodes or seams without mip levels.
    if (this.feed.mips != null) this.feed.mips.gpuBytes = coarse;
    if (this.feed.pieces != null) this.feed.pieces.gpuBytes = kits;
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      const cx = bytes[i]!;
      const cy = bytes[i + 1]!;
      const cz = bytes[i + 2]!;
      const key = chunkKey(this.grid, cx, cy, cz);
      // A chunk unloaded since it was drawn keeps no part (its draw went with it).
      if (!this.sent.has(key)) continue;
      const relief = Math.min(this.reliefSent.get(key) ?? 0, bytes[i + 3]!);
      this.feed.setPart(cx, cy, cz, MESH_PART, bytes[i + 3]! - relief);
      if (this.reliefSent.has(key)) this.feed.setPart(cx, cy, cz, RELIEF_DRAW_PART, relief);
    }
  }

  /** A round of the far field's visibility feedback from the page (far-seen.ts): handed to the far field. */
  farSeen(fb: FarSeenWire): void {
    if (this.closed) return;
    this.feed.far?.feedback?.(fb);
  }

  /** The world closed: what was not sent is dropped and the page lets go of every draw. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.relief = null;
    this.chunks = [];
    this.seams = [];
    this.swaps = [];
    this.farAdded = [];
    this.farRemoved = [];
    this.sent.clear();
    this.reliefSent.clear();
    this.nodesSent.clear();
    this.seamsSent.clear();
    this.send({ world: this.world, edge: this.grid.edge, closed: true, chunks: [], swaps: [], sentAt: wallClock(), joinMs: 0 });
  }
}

