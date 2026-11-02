/**
 * The voxel streamer: keeps the chunks around a focus point loaded in one
 * world store, within one memory budget, with the per-cell work in workers.
 *
 * Each {@link VoxelStreamer.update} (one call a frame, or less) plans and
 * returns; reads and jobs finish later and land in the store when they do:
 * - chunks past the unload bounds are dropped (a dirty one stays until it
 *   is saved), loads for them are cancelled, queued loads are re-ordered by
 *   the new distances;
 * - over budget, the farthest clean chunks are evicted (least recently
 *   wanted first among equals) and loading stops short of them until there
 *   is room again;
 * - missing chunks inside the load bounds are read from the source in
 *   batches, nearest first, as far as the pool has room (back-pressure);
 *   absent and uniform chunks land at once, stored ones go to a worker
 *   (`load`, or `apply-save` when the save holds the chunk);
 * - with derive on, a chunk whose neighbours within R are all known gets a
 *   `derive` job (the placeholder for meshing and its kin) with its apron.
 *
 * Every job carries a tracker id and the input stamps it read; a result
 * whose chunk was edited, reloaded or had a neighbour within R change
 * meanwhile is refused, and a reply for a cancelled or timed-out job is
 * ignored. Edits (on the main thread, or as `edit` jobs) bump the edited
 * chunks and invalidate every chunk within R of the edit, whose derived
 * results are then rebuilt in the `edit` lane.
 */
import { apronBytes, apronTransfer, buildApron, checkRadius, dependentChunks } from './apron';
import { payloadBytes, payloadTransfer, type ChunkPayload } from './chunk-wire';
import { chunkInWorld, chunkKey, type ChunkCoord, type ChunkGrid } from './coords';
import { DirtyTracker } from './dirty-tracker';
import { applyEdit, editBounds, editChunks, EditRefused, type ChunkUndo, type EditOutcome } from './edit-apply';
import type { VoxelEditCommand } from './edit-command';
import type { PaletteStore } from './palette-store';
import type { RegionChunkRead } from './region-file';
import type { ChunkSource } from './region-source';
import type { MismatchChoice, SaveChunk } from './save-file';
import { stampShapeHash, type StampShape } from './stamp-shape';
import type { ApplySaveInput, ApplySaveOutput, DeriveInput, DeriveOutput, EditInput, EditOutput, JobLane, LoadInput, LoadOutput, SaveContentWire, StoredChunk } from './stream-job';
import { checkRing, chunkDistance2, DEFAULT_STREAM_RING, inNearRing, pastUnloadRing, RESIDENT_CHUNK_OVERHEAD_BYTES, ringChunks, type Focus, type StreamRing } from './stream-ring';
import { decodeUndoRecord } from './undo-store';
import { SampleRing, type JobOutcome, type WorkerPool } from './worker-pool';

export interface VoxelStreamerOptions {
  /** The world store chunks stream into (createWorldStore). */
  readonly store: PaletteStore;
  /** Which grid this streamer serves (0: the world grid). */
  readonly gridId?: number;
  readonly source: ChunkSource;
  readonly pool: WorkerPool;
  /** Shared with saves (one id space for jobs and saves); a new one when absent. */
  readonly tracker?: DirtyTracker;
  readonly ring?: StreamRing;
  /** The memory budget in bytes (VOXEL_STREAM_BUDGET_BYTES[tier]). */
  readonly budgetBytes: number;
  /** The rules' dependency radius R in cells (aprons and invalidation). */
  readonly dependencyRadius: number;
  /** Run the derive placeholder on loaded chunks. */
  readonly derive?: boolean;
  /** Chunks per source read (default 64). */
  readonly readBatch?: number;
  /** Source reads in flight at once (default 4). */
  readonly maxReads?: number;
  /**
   * Main-thread milliseconds an update may spend building aprons for derive
   * jobs (default 2): the rest wait for the next update, so a burst of
   * landed chunks never stalls a frame.
   */
  readonly deriveMsPerUpdate?: number;
}

/** What happened to a chunk, for the systems built on the streamer (render, physics, navigation). */
export type StreamEvent =
  | { readonly type: 'loaded' | 'unloaded' | 'derived'; readonly cx: number; readonly cy: number; readonly cz: number }
  | { readonly type: 'damaged'; readonly cx: number; readonly cy: number; readonly cz: number; readonly reason: string }
  | { readonly type: 'mismatch'; readonly cx: number; readonly cy: number; readonly cz: number; readonly applied: boolean };

type Phase = 'reading' | 'decoding' | 'resident' | 'damaged';

interface Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly key: number;
  phase: Phase;
  /** Live load job id (0: none). */
  job: number;
  /** Bytes counted for it: store arrays + bookkeeping + derived parts. */
  bytes: number;
  /** Derived bytes by part (the derive placeholder's `derive`, later meshes, colliders, …). */
  parts: Map<string, number> | null;
  d2: number;
  wantedTick: number;
  /** Its derived result must be (re)built: 'edit' after an edit nearby (the edit lane). */
  derive: 'no' | 'yes' | 'edit';
  deriveJob: number;
  derived: DeriveOutput | null;
  /** Base hash from the load (when asked for). */
  hash: Uint8Array | null;
}

/** Window in which a chunk loaded again after being unloaded counts as churn. */
const CHURN_WINDOW_MS = 10_000;
/** Fraction of the budget eviction brings the total down to, and below which loading resumes past the eviction horizon. */
const EVICT_TO = 0.95;
const RESUME_BELOW = 0.85;

export interface StreamCounters {
  loads: number;
  loadsStored: number;
  loadsUniform: number;
  loadsAir: number;
  unloads: number;
  evictions: number;
  /** Loads of a chunk unloaded less than CHURN_WINDOW_MS before. */
  reloads: number;
  cancelledLoads: number;
  staleRefused: number;
  retried: number;
  damaged: number;
  derives: number;
  /** Ticks that ended over budget with nothing evictable (dirty or unknown neighbourhood). */
  overBudgetTicks: number;
  /** Ticks a dirty chunk past the unload bounds was kept. */
  heldDirty: number;
  mismatches: number;
}

export interface StreamMetrics {
  readonly resident: number;
  readonly residentStored: number;
  readonly reading: number;
  readonly decoding: number;
  readonly damaged: number;
  readonly deriving: number;
  /** Bytes counted against the budget: chunks (store + bookkeeping), derived parts, open tables. */
  readonly bytes: { readonly total: number; readonly chunks: number; readonly derived: number; readonly tables: number; readonly budget: number };
  /** The store's own count of its arrays (to check the streamer's sum). */
  readonly storeBytes: number;
  readonly counters: Readonly<StreamCounters>;
}

/** One chunk's derive placeholder result and its key. */
export interface DerivedChunk {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly result: DeriveOutput;
}

export class VoxelStreamer {
  readonly grid: ChunkGrid;
  readonly gridId: number;
  readonly store: PaletteStore;
  readonly tracker: DirtyTracker;
  readonly ring: StreamRing;
  readonly radius: number;
  budgetBytes: number;
  readonly counters: StreamCounters = { loads: 0, loadsStored: 0, loadsUniform: 0, loadsAir: 0, unloads: 0, evictions: 0, reloads: 0, cancelledLoads: 0, staleRefused: 0, retried: 0, damaged: 0, derives: 0, overBudgetTicks: 0, heldDirty: 0, mismatches: 0 };
  /** Main-thread milliseconds: planning per update, adopting a chunk, building an apron. */
  readonly planMs = new SampleRing();
  readonly adoptMs = new SampleRing();
  readonly apronMs = new SampleRing();
  /** Worker microseconds per stored load: decompress and decode. */
  readonly decompressUs = new SampleRing();
  readonly decodeUs = new SampleRing();
  /** Apron bytes per derive job. */
  readonly apronBytes = new SampleRing();

  private readonly opts: VoxelStreamerOptions;
  private readonly chunks = new Map<number, Chunk>();
  private readonly unloadedAt = new Map<number, number>();
  private readonly saves = new Map<number, SaveChunk>();
  private onMismatch: MismatchChoice | 'report' = 'save';
  private readonly listeners: Array<(e: StreamEvent) => void> = [];
  private focus: Focus = { x: 0, y: 0, z: 0 };
  private focusChunk = Number.NaN;
  private wanted: Array<{ cx: number; cy: number; cz: number; d2: number }> = [];
  private cursor = 0;
  private horizon = Infinity;
  private tick = 0;
  private reads = 0;
  private bytesChunks = 0;
  private bytesDerived = 0;
  private readonly heldOutside = new Set<number>();
  private readonly deriveWanted = new Set<number>();
  private wake: (() => void) | null = null;

  constructor(opts: VoxelStreamerOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.grid = opts.store.grid;
    this.gridId = opts.gridId ?? 0;
    this.tracker = opts.tracker ?? new DirtyTracker();
    this.ring = opts.ring ?? DEFAULT_STREAM_RING;
    checkRing(this.ring);
    checkRadius(this.grid.edge, opts.dependencyRadius);
    this.radius = opts.dependencyRadius;
    if (!(opts.budgetBytes > 0)) throw new RangeError('the streaming budget must be positive');
    this.budgetBytes = opts.budgetBytes;
  }

  /** Listens to chunk events (loaded, unloaded, derived, damaged, mismatch). */
  on(listener: (e: StreamEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(e: StreamEvent): void {
    for (const l of this.listeners) l(e);
  }

  /**
   * The save whose entries replace their chunks as they load (the game's
   * save; entries can be updated with {@link putSaveEntry} as it saves).
   * `onMismatch` is what to do when an entry's base hash differs from the
   * shipped chunk's: keep the save, take the base, or apply nothing and
   * report (a `mismatch` event; the game decides and edits).
   */
  setSave(entries: Iterable<SaveChunk>, onMismatch: MismatchChoice | 'report' = 'save'): void {
    this.saves.clear();
    for (const e of entries) this.putSaveEntry(e);
    this.onMismatch = onMismatch;
  }

  putSaveEntry(e: SaveChunk): void {
    if (e.grid !== this.gridId) return;
    this.saves.set(chunkKey(this.grid, e.cx, e.cy, e.cz), e);
  }

  /** Moves the focus (cells; fractions allowed). Planning happens in the next {@link update}. */
  setFocus(x: number, y: number, z: number): void {
    this.focus = { x, y, z };
  }

  /** Whether a chunk's content is in the store (loaded, uniform or known air). */
  isResident(cx: number, cy: number, cz: number): boolean {
    if (!chunkInWorld(this.grid, cx, cy, cz)) return false;
    return this.chunks.get(chunkKey(this.grid, cx, cy, cz))?.phase === 'resident';
  }

  /** A resident chunk's derive placeholder result (null: none yet or stale). */
  derivedOf(cx: number, cy: number, cz: number): DeriveOutput | null {
    const c = this.chunks.get(chunkKey(this.grid, cx, cy, cz));
    return c === undefined || c.phase !== 'resident' || c.derive !== 'no' ? null : c.derived;
  }

  /** Every resident chunk with a current derive result. */
  *derivedChunks(): IterableIterator<DerivedChunk> {
    for (const c of this.chunks.values()) if (c.phase === 'resident' && c.derive === 'no' && c.derived !== null) yield { cx: c.cx, cy: c.cy, cz: c.cz, result: c.derived };
  }

  /** Base hash of a chunk as loaded (null unless the streamer loaded it with a save entry or hashing on). */
  baseHashOf(cx: number, cy: number, cz: number): Uint8Array | null {
    return this.chunks.get(chunkKey(this.grid, cx, cy, cz))?.hash ?? null;
  }

  /**
   * Registers what a derived representation of a resident chunk costs
   * (bytes; 0 removes it), so meshes, colliders, light and the rest count
   * against the same budget as the voxels. False when the chunk is not
   * resident (its data is then not kept either).
   */
  setPart(cx: number, cy: number, cz: number, part: string, bytes: number): boolean {
    const c = this.chunks.get(chunkKey(this.grid, cx, cy, cz));
    if (c === undefined || c.phase !== 'resident') return false;
    c.parts ??= new Map();
    const old = c.parts.get(part) ?? 0;
    if (bytes > 0) c.parts.set(part, bytes);
    else c.parts.delete(part);
    c.bytes += bytes - old;
    this.bytesDerived += bytes - old;
    return true;
  }

  metrics(): StreamMetrics {
    let resident = 0;
    let stored = 0;
    let reading = 0;
    let decoding = 0;
    let damaged = 0;
    let deriving = 0;
    for (const c of this.chunks.values()) {
      if (c.phase === 'resident') {
        resident++;
        if (this.store.chunkForm(c.cx, c.cy, c.cz) === 'stored') stored++;
      } else if (c.phase === 'reading') reading++;
      else if (c.phase === 'decoding') decoding++;
      else damaged++;
      if (c.deriveJob !== 0) deriving++;
    }
    const tables = this.opts.source.memoryBytes();
    return {
      resident,
      residentStored: stored,
      reading,
      decoding,
      damaged,
      deriving,
      bytes: { total: this.bytesChunks + this.bytesDerived + tables, chunks: this.bytesChunks, derived: this.bytesDerived, tables, budget: this.budgetBytes },
      storeBytes: this.store.memoryBytes(),
      counters: { ...this.counters },
    };
  }

  private ref(c: { cx: number; cy: number; cz: number }): { grid: number; key: number } {
    return { grid: this.gridId, key: chunkKey(this.grid, c.cx, c.cy, c.cz) };
  }

  private laneOf(c: Chunk): JobLane {
    return inNearRing(this.grid, this.ring, this.focus, c.cx, c.cz) ? 'near' : 'far';
  }

  /** One planning step (see the file comment); cheap when the focus stays in its chunk. */
  update(): void {
    const t0 = performance.now();
    this.tick++;
    const g = this.grid;
    const fk = chunkKey(g, Math.floor(this.focus.x) >> g.shift, Math.floor(this.focus.y) >> g.shift, Math.floor(this.focus.z) >> g.shift);
    if (fk !== this.focusChunk) {
      this.focusChunk = fk;
      this.wanted = ringChunks(g, this.ring, this.focus);
      this.cursor = 0;
      for (const w of this.wanted) {
        const c = this.chunks.get(chunkKey(g, w.cx, w.cy, w.cz));
        if (c !== undefined) c.wantedTick = this.tick;
      }
      for (const c of [...this.chunks.values()]) {
        c.d2 = chunkDistance2(g, this.focus, c.cx, c.cy, c.cz);
        if (pastUnloadRing(g, this.ring, this.focus, c.cx, c.cy, c.cz)) this.drop(c, false);
        else if (c.phase === 'decoding') this.opts.pool.reprioritize(c.job, this.laneOf(c), c.d2);
        else if (c.deriveJob !== 0) this.opts.pool.reprioritize(c.deriveJob, c.derive === 'edit' ? 'edit' : this.laneOf(c), c.d2);
      }
    } else if (this.heldOutside.size > 0) {
      for (const key of [...this.heldOutside]) {
        const c = this.chunks.get(key);
        if (c !== undefined && pastUnloadRing(g, this.ring, this.focus, c.cx, c.cy, c.cz)) this.drop(c, false);
        else this.heldOutside.delete(key);
      }
    }
    this.enforceBudget();
    this.requestLoads();
    if (this.opts.derive === true) this.requestDerives();
    for (const [key, at] of this.unloadedAt) {
      if (t0 - at <= CHURN_WINDOW_MS) break;
      this.unloadedAt.delete(key);
    }
    this.planMs.add(performance.now() - t0);
  }

  /** Resolves once nothing is being read, decoded or derived and nothing more can be requested. */
  async settle(maxUpdates = 100_000): Promise<void> {
    for (let i = 0; i < maxUpdates; i++) {
      this.update();
      if (this.idle()) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    throw new Error('streamer did not settle');
  }

  private idle(): boolean {
    if (this.reads > 0) return false;
    for (const c of this.chunks.values()) if (c.phase === 'reading' || c.phase === 'decoding' || c.deriveJob !== 0) return false;
    if (this.opts.derive === true) {
      for (const key of this.deriveWanted) {
        const c = this.chunks.get(key);
        if (c !== undefined && this.canDerive(c)) return false;
      }
    }
    for (let i = this.cursor; i < this.wanted.length; i++) {
      const w = this.wanted[i]!;
      if (w.d2 >= this.horizon) break;
      if (!this.chunks.has(chunkKey(this.grid, w.cx, w.cy, w.cz))) return false;
    }
    return true;
  }

  private poke(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /**
   * Drops a chunk: cancels its read or job, or unloads it from the store.
   * A resident chunk that may not unload (dirty, or in a save) stays and is
   * retried each update. `evict`: dropped for the budget, not the ring.
   */
  private drop(c: Chunk, evict: boolean): boolean {
    if (c.phase === 'resident') {
      const ref = this.ref(c);
      if (!this.tracker.canUnload(ref)) {
        this.counters.heldDirty++;
        this.heldOutside.add(c.key);
        return false;
      }
      this.cancelDerive(c);
      this.store.dropChunk(c.cx, c.cy, c.cz);
      this.tracker.unload(ref);
      this.bytesChunks -= c.bytes - this.partBytes(c);
      this.bytesDerived -= this.partBytes(c);
      this.unloadedAt.delete(c.key);
      this.unloadedAt.set(c.key, performance.now());
      this.counters.unloads++;
      if (evict) this.counters.evictions++;
      this.emit({ type: 'unloaded', cx: c.cx, cy: c.cy, cz: c.cz });
    } else if (c.phase === 'decoding') {
      this.opts.pool.cancel(c.job);
      this.tracker.expireJob(c.job);
      this.counters.cancelledLoads++;
    } else if (c.phase === 'reading') this.counters.cancelledLoads++;
    this.heldOutside.delete(c.key);
    this.deriveWanted.delete(c.key);
    this.chunks.delete(c.key);
    return true;
  }

  private partBytes(c: Chunk): number {
    let n = 0;
    if (c.parts !== null) for (const b of c.parts.values()) n += b;
    return n;
  }

  private cancelDerive(c: Chunk): void {
    if (c.deriveJob === 0) return;
    this.opts.pool.cancel(c.deriveJob);
    this.tracker.expireJob(c.deriveJob);
    c.deriveJob = 0;
  }

  private enforceBudget(): void {
    const tables = this.opts.source.memoryBytes();
    let total = this.bytesChunks + this.bytesDerived + tables;
    if (total <= this.budgetBytes) {
      if (total < this.budgetBytes * RESUME_BELOW && this.horizon !== Infinity) {
        this.horizon = Infinity;
        this.cursor = 0;
      }
      return;
    }
    const candidates = [...this.chunks.values()].filter((c) => c.phase === 'resident' && this.tracker.canUnload(this.ref(c)));
    candidates.sort((a, b) => b.d2 - a.d2 || a.wantedTick - b.wantedTick);
    for (const c of candidates) {
      if (total <= this.budgetBytes * EVICT_TO) break;
      const bytes = c.bytes;
      if (!this.drop(c, true)) continue;
      total -= bytes;
      this.horizon = Math.min(this.horizon, c.d2);
    }
    if (total > this.budgetBytes) this.counters.overBudgetTicks++;
  }

  private requestLoads(): void {
    const batch = this.opts.readBatch ?? 64;
    const maxReads = this.opts.maxReads ?? 4;
    let reading = 0;
    for (const c of this.chunks.values()) if (c.phase === 'reading') reading++;
    let room = this.opts.pool.room() - reading;
    while (this.reads < maxReads && room > 0 && this.cursor < this.wanted.length) {
      const list: Chunk[] = [];
      while (list.length < batch && list.length < room && this.cursor < this.wanted.length) {
        const w = this.wanted[this.cursor]!;
        if (w.d2 >= this.horizon) break;
        this.cursor++;
        const key = chunkKey(this.grid, w.cx, w.cy, w.cz);
        if (this.chunks.has(key)) continue;
        const c: Chunk = { cx: w.cx, cy: w.cy, cz: w.cz, key, phase: 'reading', job: 0, bytes: 0, parts: null, d2: w.d2, wantedTick: this.tick, derive: 'no', deriveJob: 0, derived: null, hash: null };
        this.chunks.set(key, c);
        list.push(c);
      }
      if (list.length === 0) break;
      room -= list.length;
      this.reads++;
      this.opts.source
        .read(list)
        .then(
          (reads) => this.onReads(list, reads),
          (e: unknown) => {
            const reason = e instanceof Error ? e.message : String(e);
            this.onReads(
              list,
              list.map((c) => ({ cx: c.cx, cy: c.cy, cz: c.cz, kind: 'damaged', reason })),
            );
          },
        )
        .finally(() => {
          this.reads--;
          this.poke();
        });
    }
  }

  private onReads(list: readonly Chunk[], reads: readonly RegionChunkRead[]): void {
    list.forEach((c, i) => {
      if (this.chunks.get(c.key) !== c || c.phase !== 'reading') return;
      const r = reads[i]!;
      const save = this.saves.get(c.key);
      if (r.kind === 'damaged') {
        c.phase = 'damaged';
        this.counters.damaged++;
        this.emit({ type: 'damaged', cx: c.cx, cy: c.cy, cz: c.cz, reason: r.reason });
        return;
      }
      if (save === undefined && r.kind !== 'stored') {
        this.land(c, r.kind === 'air' ? { form: 'air' } : { form: 'uniform', value: r.value }, null);
        return;
      }
      const stored: StoredChunk | null = r.kind === 'air' ? null : r.kind === 'uniform' ? { uniform: r.value } : { stored: r.bytes.slice(), raw: r.raw };
      const job = this.tracker.beginJob(this.ref(c));
      c.phase = 'decoding';
      c.job = job.id;
      if (save !== undefined) this.submitApplySave(c, job.id, stored, save);
      else this.submitLoad(c, job.id, stored!);
    });
  }

  private submitLoad(c: Chunk, id: number, stored: StoredChunk): void {
    const input: LoadInput = { edge: this.grid.edge, chunk: { grid: this.gridId, cx: c.cx, cy: c.cy, cz: c.cz }, bytes: stored, hash: false };
    const transfer = 'stored' in stored ? [stored.stored.buffer as ArrayBuffer] : [];
    void this.opts.pool.submit<LoadOutput>({ id, kind: 'load', lane: this.laneOf(c), distance: c.d2, input, transfer }).then((o) => {
      if (o.status === 'done') {
        this.decompressUs.add(o.output.decompressUs);
        this.decodeUs.add(o.output.decodeUs);
      }
      this.onLoaded(c, id, o, (out) => ({ payload: out.payload, hash: out.hash }));
    });
  }

  private submitApplySave(c: Chunk, id: number, base: StoredChunk | null, save: SaveChunk): void {
    const s = save.content;
    const content: SaveContentWire = s.kind === 'delta' ? { kind: 'delta', bytes: s.delta.encode() } : s.kind === 'image' ? { kind: 'image', bytes: s.bytes.slice() } : s.kind === 'uniform' ? { kind: 'uniform', value: s.value } : { kind: 'air' };
    const input: ApplySaveInput = { edge: this.grid.edge, chunk: { grid: this.gridId, cx: c.cx, cy: c.cy, cz: c.cz }, base, expect: save.base.slice(), content, onMismatch: this.onMismatch };
    const transfer: ArrayBuffer[] = [input.expect.buffer as ArrayBuffer];
    if (base !== null && 'stored' in base) transfer.push(base.stored.buffer as ArrayBuffer);
    if (content.kind === 'delta' || content.kind === 'image') transfer.push(content.bytes.buffer as ArrayBuffer);
    void this.opts.pool.submit<ApplySaveOutput>({ id, kind: 'apply-save', lane: this.laneOf(c), distance: c.d2, input, transfer }).then((o) =>
      this.onLoaded(c, id, o, (out) => {
        if (out.mismatch) {
          this.counters.mismatches++;
          this.emit({ type: 'mismatch', cx: c.cx, cy: c.cy, cz: c.cz, applied: out.applied });
        }
        return { payload: out.payload, hash: out.baseNow };
      }),
    );
  }

  private onLoaded<O>(c: Chunk, id: number, o: JobOutcome<O>, take: (out: O) => { payload: ChunkPayload; hash: Uint8Array | null }): void {
    this.poke();
    if (o.status === 'cancelled') return;
    const mine = this.chunks.get(c.key) === c && c.phase === 'decoding' && c.job === id;
    if (o.status !== 'done') {
      this.tracker.expireJob(id);
      if (!mine) return;
      if (o.status === 'refused' || o.status === 'failed') {
        c.phase = 'damaged';
        this.counters.damaged++;
        this.emit({ type: 'damaged', cx: c.cx, cy: c.cy, cz: c.cz, reason: o.message });
      } else {
        // Timed out, queue full or worker lost: forget it so the next update asks again.
        this.counters.retried++;
        this.chunks.delete(c.key);
        this.cursor = 0;
      }
      return;
    }
    const acc = this.tracker.acceptResult(id);
    if (!acc.ok || !mine) {
      this.counters.staleRefused++;
      if (mine) {
        this.chunks.delete(c.key);
        this.cursor = 0;
      }
      return;
    }
    const { payload, hash } = take(o.output);
    this.land(c, payload, hash);
  }

  /** A chunk's content arrives: into the store, counted, neighbours within R invalidated. */
  private land(c: Chunk, payload: ChunkPayload, hash: Uint8Array | null): void {
    const t0 = performance.now();
    this.store.adoptPayload(c.cx, c.cy, c.cz, payload);
    this.adoptMs.add(performance.now() - t0);
    c.phase = 'resident';
    c.job = 0;
    c.hash = hash;
    c.bytes = this.store.chunkBytes(c.cx, c.cy, c.cz) + RESIDENT_CHUNK_OVERHEAD_BYTES;
    this.bytesChunks += c.bytes;
    this.counters.loads++;
    if (payload.form === 'stored') this.counters.loadsStored++;
    else if (payload.form === 'uniform') this.counters.loadsUniform++;
    else this.counters.loadsAir++;
    const at = this.unloadedAt.get(c.key);
    if (at !== undefined && performance.now() - at <= CHURN_WINDOW_MS) this.counters.reloads++;
    this.tracker.loaded(this.ref(c));
    if (this.opts.derive === true) {
      this.wantDerive(c, 'yes');
      this.invalidateAround({ minX: c.cx << this.grid.shift, minY: c.cy << this.grid.shift, minZ: c.cz << this.grid.shift, maxX: ((c.cx + 1) << this.grid.shift) - 1, maxY: ((c.cy + 1) << this.grid.shift) - 1, maxZ: ((c.cz + 1) << this.grid.shift) - 1 }, 'yes', c.key);
    }
    this.emit({ type: 'loaded', cx: c.cx, cy: c.cy, cz: c.cz });
  }

  private wantDerive(c: Chunk, why: 'yes' | 'edit'): void {
    if (this.opts.derive !== true) return;
    if (c.derive !== 'edit') c.derive = why;
    this.deriveWanted.add(c.key);
  }

  /**
   * Invalidates every resident chunk within R of a cell box (except `skip`):
   * their running jobs become stale and their derived results are rebuilt.
   */
  private invalidateAround(box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, why: 'yes' | 'edit', skip = -1): void {
    for (const d of dependentChunks(this.grid, box, this.radius)) {
      const key = chunkKey(this.grid, d.cx, d.cy, d.cz);
      if (key === skip) continue;
      const n = this.chunks.get(key);
      if (n === undefined || n.phase !== 'resident') continue;
      this.tracker.invalidated(this.ref(n));
      this.wantDerive(n, why);
    }
  }

  /** Whether all of a chunk's neighbours within R are known (resident, or outside the world). */
  private canDerive(c: Chunk): boolean {
    if (c.phase !== 'resident') return false;
    if (this.radius === 0) return true;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const nx = c.cx + dx;
      const ny = c.cy + dy;
      const nz = c.cz + dz;
      if (!chunkInWorld(this.grid, nx, ny, nz)) continue;
      if (this.chunks.get(chunkKey(this.grid, nx, ny, nz))?.phase !== 'resident') return false;
    }
    return true;
  }

  private requestDerives(): void {
    let room = this.opts.pool.room();
    const until = performance.now() + (this.opts.deriveMsPerUpdate ?? 2);
    for (const key of [...this.deriveWanted]) {
      if (room <= 0 || performance.now() > until) return;
      const c = this.chunks.get(key);
      if (c === undefined) {
        this.deriveWanted.delete(key);
        continue;
      }
      if (!this.canDerive(c)) continue;
      this.deriveWanted.delete(key);
      this.cancelDerive(c);
      const form = this.store.chunkForm(c.cx, c.cy, c.cz);
      if (form === 'absent') {
        // An air chunk has nothing to derive.
        this.setDerived(c, { solid: 0, exposed: 0, mask: null, hash: 0 });
        continue;
      }
      const t0 = performance.now();
      const apron = buildApron(this.store, c.cx, c.cy, c.cz, this.radius);
      this.apronMs.add(performance.now() - t0);
      this.apronBytes.add(apronBytes(apron));
      const payload = this.store.chunkPayload(c.cx, c.cy, c.cz, true);
      const job = this.tracker.beginJob(this.ref(c));
      const lane: JobLane = c.derive === 'edit' ? 'edit' : this.laneOf(c);
      c.deriveJob = job.id;
      const input: DeriveInput = { edge: this.grid.edge, chunk: { grid: this.gridId, cx: c.cx, cy: c.cy, cz: c.cz }, payload, radius: this.radius, apron };
      room--;
      void this.opts.pool.submit<DeriveOutput>({ id: job.id, kind: 'derive', lane, distance: c.d2, input, transfer: payloadTransfer(payload, apronTransfer(apron)) }).then((o) => {
        this.poke();
        if (o.status === 'cancelled') return;
        if (c.deriveJob === job.id) c.deriveJob = 0;
        if (o.status !== 'done') {
          this.tracker.expireJob(job.id);
          if (this.chunks.get(key) === c && o.status !== 'refused' && o.status !== 'failed') this.wantDerive(c, c.derive === 'edit' ? 'edit' : 'yes');
          return;
        }
        if (!this.tracker.acceptResult(job.id).ok || this.chunks.get(key) !== c) {
          this.counters.staleRefused++;
          return;
        }
        if (this.deriveWanted.has(key)) return;
        this.setDerived(c, o.output);
      });
    }
  }

  private setDerived(c: Chunk, out: DeriveOutput): void {
    c.derived = out;
    c.derive = 'no';
    this.counters.derives++;
    this.setPart(c.cx, c.cy, c.cz, 'derive', out.mask?.byteLength ?? 0);
    this.emit({ type: 'derived', cx: c.cx, cy: c.cy, cz: c.cz });
  }

  /** After an edit changed `changed`: bump them, recount them, invalidate everything within R of `box`. */
  private afterEdit(changed: readonly ChunkCoord[], box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): void {
    for (const ch of changed) {
      const key = chunkKey(this.grid, ch.cx, ch.cy, ch.cz);
      const c = this.chunks.get(key)!;
      this.tracker.edited(this.ref(c));
      const bytes = this.store.chunkBytes(c.cx, c.cy, c.cz) + RESIDENT_CHUNK_OVERHEAD_BYTES + this.partBytes(c);
      this.bytesChunks += bytes - c.bytes;
      c.bytes = bytes;
      this.wantDerive(c, 'edit');
    }
    this.invalidateAround(box, 'edit');
  }

  private loadedCheck = (g: number, cx: number, cy: number, cz: number): boolean => g === this.gridId && this.isResident(cx, cy, cz);

  /**
   * Applies an edit command on the main thread (small strokes: tens of µs).
   * Every chunk it can touch must be resident, else it is refused before
   * any write; edited chunks become dirty and everything within R of the
   * edit is rebuilt in the edit lane.
   */
  edit(cmd: VoxelEditCommand, stamps?: readonly { readonly id: string; readonly shape: StampShape }[]): EditOutcome {
    const resolve = resolver(stamps);
    const outcome = applyEdit({ store: (g) => (g === this.gridId ? this.store : undefined) }, cmd, { stamps: resolve, loaded: this.loadedCheck });
    this.afterEdit(outcome.chunks, editBounds(this.grid, cmd, resolve));
    return outcome;
  }

  /**
   * Applies an edit command in a worker (large fills and stamps): the
   * chunks it touches are sent as copies, and the result is adopted only if
   * none of them changed meanwhile (else `superseded`: send it again, the
   * apply is deterministic).
   */
  async editInWorker(cmd: VoxelEditCommand, stamps?: readonly { readonly id: string; readonly shape: StampShape }[]): Promise<{ status: 'done'; cells: number; undo: ChunkUndo[] } | { status: 'superseded' | 'refused' | 'failed'; message: string }> {
    const resolve = resolver(stamps);
    const touched = editChunks(this.grid, cmd, resolve);
    for (const t of touched) if (!this.loadedCheck(cmd.grid, t.cx, t.cy, t.cz)) throw new EditRefused('chunk_not_loaded', `chunk (${t.cx}, ${t.cy}, ${t.cz}) of grid ${cmd.grid} is not loaded`);
    const job = this.tracker.beginJob(touched.map((t) => this.ref(t)));
    const chunks = touched.map((t) => ({ chunk: { grid: this.gridId, cx: t.cx, cy: t.cy, cz: t.cz }, payload: this.store.chunkPayload(t.cx, t.cy, t.cz, true) }));
    const transfer: ArrayBuffer[] = [];
    for (const ch of chunks) payloadTransfer(ch.payload, transfer);
    const input: EditInput = { edge: this.grid.edge, command: cmd, chunks, ...(stamps === undefined ? {} : { stamps: stamps.map((s) => ({ id: s.id, shape: s.shape })) }) };
    const o = await this.opts.pool.submit<EditOutput>({ id: job.id, kind: 'edit', lane: 'edit', distance: 0, input, transfer });
    if (o.status !== 'done') {
      this.tracker.expireJob(job.id);
      return { status: o.status === 'refused' ? 'refused' : 'failed', message: 'message' in o ? o.message : o.status };
    }
    if (!this.tracker.acceptResult(job.id).ok) {
      this.counters.staleRefused++;
      return { status: 'superseded', message: 'a chunk changed while the edit ran' };
    }
    const changed: ChunkCoord[] = [];
    for (const ch of o.output.chunks) {
      this.store.adoptPayload(ch.chunk.cx, ch.chunk.cy, ch.chunk.cz, ch.payload);
      changed.push({ cx: ch.chunk.cx, cy: ch.chunk.cy, cz: ch.chunk.cz });
    }
    this.afterEdit(changed, editBounds(this.grid, cmd, resolve));
    return { status: 'done', cells: o.output.cells, undo: decodeUndoRecord(this.grid, o.output.undo) };
  }

  /** Bytes a payload would move to a worker (for reports). */
  static payloadBytes(p: ChunkPayload): number {
    return payloadBytes(p);
  }
}

function resolver(stamps?: readonly { readonly id: string; readonly shape: StampShape }[]): ((id: string) => { shape: StampShape; hash: string } | undefined) | undefined {
  if (stamps === undefined) return undefined;
  const m = new Map(stamps.map((s) => [s.id, { shape: s.shape, hash: stampShapeHash(s.shape) }]));
  return (id) => m.get(id);
}
