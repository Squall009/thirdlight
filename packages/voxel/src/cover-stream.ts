/**
 * Ground cover as a voxel world streams: which chunk columns grow cover now,
 * and when each one's cover is made again.
 *
 * Cover is derived and never stored. It is not a derive part of a chunk: the
 * rule scatter core that places it sits above this package, so a column's
 * cover is a job of its own (`voxel-cover`, served by a worker entry beside
 * the stream jobs) asked once the column's chunks are drawn. It sits on the
 * shared foundations it needs and adds none: the surface fields job's input
 * ({@link surfaceFieldsInputOf}: the column and the eight round it), the
 * world's worker pool in its background queue (a derive or a load always goes
 * first, so a mesh never waits for cover), and the chunk draw batches, which
 * carry each answer to where the world is drawn ({@link ChunkCoverWire}).
 *
 * **The unit is a chunk column.** The job answers the points whose surface
 * lies in the rows of the column's chunks drawn at level 0, so cover exists
 * exactly where full-detail ground is drawn: it comes after the chunk's draw,
 * and goes in the batch that removes the column's last drawn chunk.
 *
 * **What makes a column's cover again** (the feeds):
 * - a drawn chunk of it or of a column beside it changed in shape, material,
 *   wetness or liquid ({@link COVER_FED_BY}; a gas-only change feeds nothing:
 *   no rule reads gas). A rule reads up to a chunk past its column (a
 *   species' spacing and the distance fields' search), so the eight columns
 *   round a change are made again with it;
 * - a chunk of it or beside it arrived (a column made at the load ring's rim
 *   read the missing chunk as air);
 * - a chunk of it was drawn or is no longer drawn at level 0;
 * - the table of what grows changed (a dressing, a material's dressing):
 *   every column, no chunk derived;
 * - a prop's keep-clear box came, went or moved: the columns within a
 *   species' largest spacing of where it was and is.
 *
 * An answer equal to the one last sent is not sent again, so a change that
 * reaches a column without changing its plants costs the job and nothing
 * where the world is drawn.
 *
 * Pure: no I/O, no three.js.
 */
import { crc32 } from '@thirdlight/shared';

import { chunkKey, VOXEL_SIZE_M, type ChunkGrid } from './coords';
import type { ChunkPayload } from './chunk-wire';
import type { DirtyTracker } from './dirty-tracker';
import type { PaletteStore } from './palette-store';
import { OverlayMerge } from './stream-overlay';
import type { VoxelOverlay } from './voxel-overlay';
import { DRESSING_CLEAR_FLOATS } from './dressing-rules';
import { DERIVED_PART } from './record';
import { SURFACE_DISTANCE_CAP_M, SURFACE_FIELDS_FED_BY } from './surface-fields';
import { surfaceFieldsInputOf } from './surface-fields-job';
import { BACKGROUND_WORKER_SHARE, type JobOutcome, type WorkerPool } from './worker-pool';

/** The cover job's kind in a worker pool (a worker entry that makes cover serves it beside the stream jobs). */
export const VOXEL_COVER_JOB = 'voxel-cover';

/** The derived parts whose change makes cover again: what the surface fields read, less gas (no rule condition reads it). */
export const COVER_FED_BY = SURFACE_FIELDS_FED_BY & ~DERIVED_PART.gas;

/** Bytes a cover point takes in a set (four floats: the point-set path's own form). */
export const COVER_POINT_BYTES = 16;

/** ms before a column whose job found the pool's queue full is asked again. */
const RETRY_MS = 250;

/** One species' points over a chunk column as the cover job answers them: opaque here but for the buffer handed over. */
export interface ChunkCoverSetWire {
  readonly points: { readonly count: number; readonly data: Float32Array };
}

/** A chunk column's ground cover in a draw batch: every species that grows on it (absent: it grows nothing any more). */
export interface ChunkCoverWire {
  readonly cx: number;
  readonly cz: number;
  readonly sets?: readonly ChunkCoverSetWire[];
}

/** What the cover stream reads of a streamer. */
export interface ChunkCoverFeed {
  readonly grid: ChunkGrid;
  readonly gridId: number;
  readonly tracker: Pick<DirtyTracker, 'beginJob' | 'expireJob'>;
  on(listener: (e: { readonly type: string; readonly cx?: number; readonly cy?: number; readonly cz?: number }) => void): void;
  isResident(cx: number, cy: number, cz: number): boolean;
  /** The base chunks and the game's changes over them: a job reads a chunk as the game sees it. */
  readonly store: PaletteStore;
  readonly overlay: VoxelOverlay;
}

export interface ChunkCoverStreamOptions {
  readonly stream: ChunkCoverFeed;
  readonly pool: Pick<WorkerPool, 'submit' | 'cancelQueued' | 'size'>;
  /** A column's cover leaves for where the world is drawn (the draw batcher's `cover`). */
  send(w: ChunkCoverWire): void;
  /** 1 a cell (a chunk's local index) where something not in the voxels stands (a structure's stamp); absent or null: nothing. */
  built?(cx: number, cy: number, cz: number): Uint8Array | null;
  /** Every column's cover is made and sent again after work ({@link ChunkCoverStream.settled} turned true). */
  idle?(): void;
}

/** What the cover stream holds and did (diagnostics, benches, tests). */
export interface ChunkCoverStats {
  /** Columns with a chunk drawn at level 0, those whose cover is to be made (again), jobs out. */
  readonly columns: number;
  readonly waiting: number;
  readonly live: number;
  /** Jobs answered, answers sent on (changed), answers equal to what was sent, jobs dropped (the column changed or left meanwhile). */
  readonly jobs: number;
  readonly sent: number;
  readonly same: number;
  readonly dropped: number;
  /** Columns holding cover where the world is drawn, and their points. */
  readonly covered: number;
  readonly points: number;
  /** Worker ms of the answered jobs: their sum and the last one's. */
  readonly workerMs: number;
  readonly lastMs: number;
}

interface Column {
  readonly cx: number;
  readonly cz: number;
  /** Its chunk rows drawn at level 0. */
  readonly drawn: Set<number>;
  /** Its cover is to be made (again); the order it was asked in. */
  dirty: boolean;
  order: number;
  /** The live job (0: none) and whether its answer is already out of date. */
  job: number;
  stale: boolean;
  /** What was sent last: its digest (null: nothing grows, or nothing sent) and its points. */
  hash: number | null;
  points: number;
}

const columnKey = (cx: number, cz: number): string => `${cx},${cz}`;

/** A digest of a column's answer: every set's fields and its points' bytes. */
function digestOf(sets: readonly ChunkCoverSetWire[]): number {
  let h = 0;
  for (const s of sets) {
    const text = JSON.stringify(s, (k, v: unknown) => (k === 'data' ? undefined : v));
    const head = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) head[i] = text.charCodeAt(i) & 0xff;
    h = (Math.imul(h, 31) + crc32(head)) | 0;
    h = (Math.imul(h, 31) + crc32(new Uint8Array(s.points.data.buffer, s.points.data.byteOffset, s.points.data.byteLength))) | 0;
  }
  return h;
}

/** The cover of a streamed voxel grid's chunk columns, made in its pool and sent with its draws (see the module's header). */
export class ChunkCoverStream {
  private readonly columns = new Map<string, Column>();
  /** Per column: the chunk rows resident (what a job reads up to). */
  private readonly rows = new Map<string, Set<number>>();
  private table: unknown = null;
  private clear: Float32Array | null = null;
  private seq = 0;
  private live = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private queued = false;
  /** A job was asked since the stream last told it was idle. */
  private busy = false;
  private closed = false;
  private readonly counts = { jobs: 0, sent: 0, same: 0, dropped: 0, workerMs: 0, lastMs: 0 };
  /** Chunks as the game sees them, for the jobs (the streamer's own merge is its derives'). */
  private readonly merged: OverlayMerge;

  constructor(private readonly o: ChunkCoverStreamOptions) {
    this.merged = new OverlayMerge(o.stream.store, o.stream.overlay);
    o.stream.on((e) => {
      if (this.closed || (e.type !== 'loaded' && e.type !== 'unloaded')) return;
      const key = columnKey(e.cx!, e.cz!);
      let set = this.rows.get(key);
      if (e.type === 'loaded') {
        if (set === undefined) this.rows.set(key, (set = new Set()));
        set.add(e.cy!);
        // A column made before this chunk came read it as air.
        this.touch(e.cx!, e.cz!, 1);
      } else if (set !== undefined) {
        set.delete(e.cy!);
        if (set.size === 0) this.rows.delete(key);
      }
    });
  }

  /**
   * What grows from now on (the cover job's table: the dressings and which voxel material grows which; null: nothing):
   * every column's cover is made again, and no chunk is derived for it.
   */
  setTable(table: unknown): void {
    if (this.closed || JSON.stringify(table) === JSON.stringify(this.table)) return;
    this.table = table;
    for (const c of this.columns.values()) this.mark(c);
    this.pump();
  }

  /**
   * The props rule plants keep clear of, as boxes in the grid's metres (`propClearances`; null: none): the columns
   * near a box that came, went or moved are made again.
   */
  setClear(boxes: Float32Array | null): void {
    if (this.closed) return;
    const key = (b: Float32Array, o: number): string => Array.from(b.subarray(o, o + DRESSING_CLEAR_FLOATS)).join(',');
    const was = new Map<string, number>();
    const old = this.clear ?? new Float32Array(0);
    for (let o = 0; o + DRESSING_CLEAR_FLOATS <= old.length; o += DRESSING_CLEAR_FLOATS) was.set(key(old, o), o);
    const next = boxes !== null && boxes.length > 0 ? boxes.slice() : null;
    const now = next ?? new Float32Array(0);
    const changed: [Float32Array, number][] = [];
    for (let o = 0; o + DRESSING_CLEAR_FLOATS <= now.length; o += DRESSING_CLEAR_FLOATS) if (!was.delete(key(now, o))) changed.push([now, o]);
    for (const o of was.values()) changed.push([old, o]);
    this.clear = next;
    if (changed.length === 0) return;
    // A plant a prop cleared no longer holds its neighbours off: what changes reaches a species' largest spacing past the box.
    const side = this.o.stream.grid.edge * VOXEL_SIZE_M;
    for (const [b, o] of changed) {
      const x0 = Math.floor((b[o]! - SURFACE_DISTANCE_CAP_M) / side);
      const x1 = Math.floor((b[o + 3]! + SURFACE_DISTANCE_CAP_M) / side);
      const z0 = Math.floor((b[o + 2]! - SURFACE_DISTANCE_CAP_M) / side);
      const z1 = Math.floor((b[o + 5]! + SURFACE_DISTANCE_CAP_M) / side);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const c = this.columns.get(columnKey(cx, cz));
        if (c !== undefined) this.mark(c);
      }
    }
    this.pump();
  }

  /** A level-0 chunk's draw was sent or changed (`parts`: the derived parts that changed; every part for a new draw). */
  drawn(cx: number, cy: number, cz: number, parts: number): void {
    if (this.closed) return;
    const key = columnKey(cx, cz);
    let c = this.columns.get(key);
    if (c === undefined) this.columns.set(key, (c = { cx, cz, drawn: new Set(), dirty: false, order: 0, job: 0, stale: false, hash: null, points: 0 }));
    const fresh = !c.drawn.has(cy);
    c.drawn.add(cy);
    if (fresh) this.mark(c);
    if ((parts & COVER_FED_BY) !== 0) this.touch(cx, cz, 1);
    this.pump();
  }

  /** A level-0 chunk is no longer drawn: its points go, with the column's cover when it was its last. */
  removed(cx: number, cy: number, cz: number): void {
    if (this.closed) return;
    const key = columnKey(cx, cz);
    const c = this.columns.get(key);
    if (c === undefined || !c.drawn.delete(cy)) return;
    if (c.drawn.size > 0) {
      this.mark(c);
      this.pump();
      return;
    }
    this.columns.delete(key);
    if (c.job !== 0) this.drop(c);
    if (c.hash !== null) this.o.send({ cx, cz });
  }

  /** The columns within `ring` columns of (cx, cz) that have a drawn chunk are made again. */
  private touch(cx: number, cz: number, ring: number): void {
    let any = false;
    for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++) {
      const c = this.columns.get(columnKey(cx + dx, cz + dz));
      if (c === undefined) continue;
      this.mark(c);
      any = true;
    }
    if (any) this.pump();
  }

  private mark(c: Column): void {
    if (c.job !== 0) c.stale = true;
    if (c.dirty) return;
    c.dirty = true;
    c.order = this.seq++;
  }

  /** A column's live job is given up: a queued one never runs, a sent one's answer is not used. */
  private drop(c: Column): void {
    this.o.pool.cancelQueued(c.job);
    this.o.stream.tracker.expireJob(c.job);
    c.job = 0;
    c.stale = false;
    this.live--;
    this.counts.dropped++;
  }

  /** Jobs are asked at the end of the task: every change of one task is one job a column. */
  private pump(): void {
    if (this.queued || this.closed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.submit();
    });
  }

  private submit(): void {
    if (this.closed) return;
    // The background's share of the workers, as the far field's jobs have: cover never fills the pool.
    const most = Math.max(1, Math.floor(this.o.pool.size * BACKGROUND_WORKER_SHARE));
    if (this.live >= most) return;
    const waiting = [...this.columns.values()].filter((c) => c.dirty && c.job === 0).sort((a, b) => a.order - b.order);
    for (const c of waiting) {
      if (this.live >= most) return;
      if (this.table === null) {
        // Nothing grows: a column that held cover lets it go, with no job.
        c.dirty = false;
        if (c.hash !== null) {
          c.hash = null;
          c.points = 0;
          this.o.send({ cx: c.cx, cz: c.cz });
        }
        continue;
      }
      this.ask(c);
    }
    if (this.live === 0 && this.busy) {
      this.busy = false;
      this.o.idle?.();
    }
  }

  private ask(c: Column): void {
    const s = this.o.stream;
    let low = Infinity;
    let high = -Infinity;
    for (const cy of c.drawn) {
      low = Math.min(low, cy);
      high = Math.max(high, cy);
    }
    // A surface reads the cells over it as far as chunks are loaded (its sky, its water), and a row under its own chunk's.
    let top = high;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const cy of this.rows.get(columnKey(c.cx + dx, c.cz + dz)) ?? []) top = Math.max(top, cy);
    const store = { grid: s.grid, chunkPayload: (x: number, y: number, z: number): ChunkPayload => (s.isResident(x, y, z) ? this.merged.payload(x, y, z) : { form: 'air' }) };
    const { input: fields, transfer } = surfaceFieldsInputOf(store, c.cx, c.cz, low - 1, top, this.o.built);
    const id = s.tracker.beginJob({ grid: s.gridId, key: chunkKey(s.grid, c.cx, high, c.cz) }).id;
    c.dirty = false;
    c.stale = false;
    c.job = id;
    this.live++;
    this.busy = true;
    const input = { fields, rows: [low, high], table: this.table, ...(this.clear !== null ? { clear: this.clear } : {}) };
    void this.o.pool.submit<{ sets: ChunkCoverSetWire[] }>({ id, kind: VOXEL_COVER_JOB, lane: 'mip', distance: c.order, input, transfer, background: true }).then((out) => this.answered(c, id, out));
  }

  private answered(c: Column, id: number, out: JobOutcome<{ sets: ChunkCoverSetWire[] }>): void {
    if (this.closed || c.job !== id) return;
    this.o.stream.tracker.expireJob(id);
    c.job = 0;
    this.live--;
    if (out.status !== 'done') {
      // A full queue or a lost worker: asked again, a little later when nothing else will wake the stream.
      this.mark(c);
      if (this.retry === null) this.retry = setTimeout(() => {
        this.retry = null;
        this.submit();
      }, RETRY_MS);
      return;
    }
    this.counts.jobs++;
    this.counts.lastMs = out.workerUs / 1000;
    this.counts.workerMs += this.counts.lastMs;
    if (c.stale) {
      // The column changed while the job ran: the answer is of cells that are no longer there.
      c.stale = false;
      this.counts.dropped++;
    } else {
      const sets = out.output.sets;
      const hash = sets.length === 0 ? null : digestOf(sets);
      if (hash === c.hash) this.counts.same++;
      else {
        c.hash = hash;
        c.points = sets.reduce((n, s) => n + s.points.count, 0);
        this.counts.sent++;
        this.o.send(sets.length === 0 ? { cx: c.cx, cz: c.cz } : { cx: c.cx, cz: c.cz, sets });
      }
    }
    this.submit();
  }

  /** Whether every column's cover is made and sent (nothing waits, no job is out). */
  get settled(): boolean {
    if (this.live > 0) return false;
    for (const c of this.columns.values()) if (c.dirty) return false;
    return true;
  }

  stats(): ChunkCoverStats {
    let waiting = 0;
    let covered = 0;
    let points = 0;
    for (const c of this.columns.values()) {
      if (c.dirty) waiting++;
      if (c.hash !== null) covered++;
      points += c.points;
    }
    return { columns: this.columns.size, waiting, live: this.live, ...this.counts, covered, points };
  }

  /** The world closed: jobs out are given up and nothing more is sent (its draws go with its batcher's last batch). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    for (const c of this.columns.values()) if (c.job !== 0) this.drop(c);
    this.columns.clear();
    this.rows.clear();
  }
}
