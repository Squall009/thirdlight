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
 */
import { chunkKey, type ChunkGrid } from './coords';
import type { JoinedDraw, JoinTimes } from './chunk-join';
import type { InstanceList, SurfaceBuffer } from './derived-mesh';
import { shaderGridSide } from './derived-shader';
import type { SwapReport } from './stream-sections';
import type { StreamEvent } from './voxel-streamer';

/** One chunk's change in a batch. */
export interface ChunkDrawWire {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** `draw`: its draw is replaced (nothing to draw removes it); `shader`: only its shader data; `remove`: no longer drawn. */
  readonly kind: 'draw' | 'shader' | 'remove';
  readonly ground?: SurfaceBuffer;
  readonly base?: SurfaceBuffer;
  readonly instances?: InstanceList;
  /** The grid's one solid entry (0: all air), or −1: its side³ entries are in `cells`. */
  readonly solid?: number;
  readonly cells?: Uint16Array;
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

export interface ChunkDrawBatch {
  readonly world: string;
  /** The storage chunks' edge (cells). */
  readonly edge: number;
  /** The world closed (its scene unloaded): every draw of it goes. */
  readonly closed?: true;
  readonly chunks: readonly ChunkDrawWire[];
  readonly swaps: readonly ChunkSwapWire[];
  /** Wall-clock ms (`performance.timeOrigin + performance.now()`) when the batch left. */
  readonly sentAt: number;
  /** ms the batch's joins took where the world runs. */
  readonly joinMs: number;
}

/** What the batcher needs of a streamer. */
export interface ChunkDrawFeed {
  readonly grid: ChunkGrid;
  on(listener: (e: StreamEvent) => void): void;
  joinedChunk(cx: number, cy: number, cz: number, times: JoinTimes | undefined, cells: Uint16Array): JoinedDraw | null;
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean;
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
    add(c.instances?.data);
    add(c.cells);
  }
  return [...out];
}

/** The budget part a chunk's draw (its GPU buffers and shader grid) is counted as. */
export const MESH_PART = 'mesh';

const wallClock = (): number => performance.timeOrigin + performance.now();

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
  private chunks: ChunkDrawWire[] = [];
  private swaps: ChunkSwapWire[] = [];
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
    private readonly schedule: (flush: () => void) => void = (flush) => queueMicrotask(flush),
  ) {
    this.grid = feed.grid;
    this.copy = sectionEdge === feed.grid.edge;
    const side = shaderGridSide(feed.grid.edge);
    this.scratch = new Uint16Array(side * side * side);
    feed.on((e) => this.onStream(e));
  }

  private onStream(e: StreamEvent): void {
    if (this.closed) return;
    if (e.type === 'unloaded') {
      if (this.sent.delete(chunkKey(this.grid, e.cx, e.cy, e.cz))) this.push({ cx: e.cx, cy: e.cy, cz: e.cz, kind: 'remove' });
    } else if (e.type === 'chunk') this.chunk(e.cx, e.cy, e.cz, e.shaderOnly);
    else if (e.type === 'swap') this.swap(e.report);
  }

  private chunk(cx: number, cy: number, cz: number, shaderOnly: boolean): void {
    const key = chunkKey(this.grid, cx, cy, cz);
    const t0 = performance.now();
    const d = this.feed.joinedChunk(cx, cy, cz, undefined, this.scratch);
    this.joinMs += performance.now() - t0;
    if (d === null) {
      if (this.sent.delete(key)) this.push({ cx, cy, cz, kind: 'remove' });
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
    this.push({ cx, cy, cz, kind: 'draw', ground: surface(d.ground), base: surface(d.base), instances: { count: d.instances.count, data: own(d.instances.data) }, ...grid });
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
    this.schedule(() => this.flush());
  }

  private flush(): void {
    this.queued = false;
    if (this.closed || (this.chunks.length === 0 && this.swaps.length === 0)) return;
    const b: ChunkDrawBatch = { world: this.world, edge: this.grid.edge, chunks: this.chunks, swaps: this.swaps, sentAt: wallClock(), joinMs: this.joinMs };
    this.chunks = [];
    this.swaps = [];
    this.joinMs = 0;
    this.batches++;
    this.send(b);
  }

  /** The page's GPU bytes of drawn chunks (`[cx, cy, cz, bytes]` repeated): each chunk's `mesh` part. */
  drawn(bytes: readonly number[]): void {
    if (this.closed) return;
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      const cx = bytes[i]!;
      const cy = bytes[i + 1]!;
      const cz = bytes[i + 2]!;
      // A chunk unloaded since it was drawn keeps no part (its draw went with it).
      if (this.sent.has(chunkKey(this.grid, cx, cy, cz))) this.feed.setPart(cx, cy, cz, MESH_PART, bytes[i + 3]!);
    }
  }

  /** The world closed: what was not sent is dropped and the page lets go of every draw. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.swaps = [];
    this.sent.clear();
    this.send({ world: this.world, edge: this.grid.edge, closed: true, chunks: [], swaps: [], sentAt: wallClock(), joinMs: 0 });
  }
}
