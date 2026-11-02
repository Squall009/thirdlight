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
 * - missing chunks inside the load bounds (of the focus, and of a point a
 *   second ahead along its motion) are read from the source in batches of
 *   whole columns, nearest that lead point first (stream-reads.ts); stored
 *   ones wait for room in the pool (back-pressure) before they are decoded;
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
 *
 * When another writer changed the source (a backend applied an edit command
 * and saved it), {@link VoxelStreamer.refresh} reads the chunks it names
 * again: a resident chunk keeps its content until the new one lands, then
 * swaps it and everything within R is rebuilt in the `edit` lane.
 *
 * The store holds the chunks as the world's files hold them (the base) and
 * is never written by an edit: runtime edits go to the streamer's
 * {@link VoxelOverlay}, and everything read from the world (`voxelAt`, the
 * payloads and aprons of derive jobs, edits run in workers) is the overlay
 * laid over the base. Overrides are not chunk content: they stay when their
 * chunk unloads, apply again when it loads, count against the budget and are
 * never evicted; a save keeps the fields the game marks saved
 * ({@link VoxelStreamer.saveChunks}). An edited chunk is therefore never
 * dirty (nothing of it is to be written back) and unloads like any other.
 */
import { checkRadius } from './apron';
import type { JoinedChunk, JoinTimes } from './chunk-join';
import { jobRadius, type AssemblyRuleSet } from './assembly';
import { ALL_DERIVED_PARTS, DEFAULT_SAVED_FIELDS, fieldsFeed, type VoxelRecord } from './record';
import { payloadTransfer, type ChunkPayload } from './chunk-wire';
import { chunkInWorld, chunkKey, DEFAULT_SECTION_EDGE, type CellGrid, type ChunkCoord, type ChunkGrid, type SectionEdge } from './coords';
import { createDenseChunk } from './dense-chunk';
import { DirtyTracker } from './dirty-tracker';
import { applyEdit, editBounds, editChunks, EditRefused, type ChunkUndo, type EditOutcome } from './edit-apply';
import type { VoxelEditCommand } from './edit-command';
import { createWorldStore, type PaletteStore } from './palette-store';
import type { RegionChunkRead } from './region-file';
import type { ChunkSource } from './region-source';
import { savePayloadOf, type MismatchChoice, type SaveChunk } from './save-file';
import { stampShapeHash, type StampShape } from './stamp-shape';
import type { CellBox } from './stroke';
import type { ApplySaveInput, ApplySaveOutput, DeriveOutput, EditInput, EditOutput, JobLane, LoadInput, LoadOutput, SaveContentWire, StoredChunk } from './stream-job';
import { SectionDerives, type DeriveView, type SectionEvent } from './stream-sections';
import { DEFAULT_STREAM_READS, readOrder, STREAM_PREFETCH_SECONDS, StreamReadPlan, type WantedChunk } from './stream-reads';
import { checkRing, chunkDistance2, DEFAULT_STREAM_RING, inNearRing, RESIDENT_CHUNK_OVERHEAD_BYTES, type Focus, type StreamRing } from './stream-ring';
import { decodeUndoRecord } from './undo-store';
import { OverlayMerge, readBaseChunks } from './stream-overlay';
import { VoxelOverlay } from './voxel-overlay';
import { SampleRing, type JobOutcome, type WorkerPool } from './worker-pool';

export interface VoxelStreamerOptions {
  /**
   * The world store chunks stream into (createWorldStore): the base, as the
   * world's files hold it; runtime edits never write it.
   */
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
  /** Run the derive placeholder on loaded chunks (or, with `rules`, the assembly derive). */
  readonly derive?: boolean;
  /**
   * Derive with these assembly rules (derive-assembly.ts) instead of the
   * placeholder; the dependency radius must then be their job radius
   * (rule radius + consumer reach), and absent chunks next to non-air ones
   * are derived too (their cells can stand on a neighbour's ground).
   */
  readonly rules?: AssemblyRuleSet;
  /** Chunks per source read (default 64; a batch ends with a whole column, see stream-reads.ts). */
  readonly readBatch?: number;
  /** Source reads in flight at once (default {@link DEFAULT_STREAM_READS}). */
  readonly maxReads?: number;
  /**
   * Seconds of the focus's motion read ahead (default
   * {@link STREAM_PREFETCH_SECONDS}; 0: the ring around the focus only).
   * The lead is capped at the near radius.
   */
  readonly prefetchSeconds?: number;
  /**
   * Main-thread milliseconds an update may spend building aprons for derive
   * jobs (default 2): the rest wait for the next update, so a burst of
   * landed chunks never stalls a frame.
   */
  readonly deriveMsPerUpdate?: number;
  /**
   * Main-thread milliseconds an update (or an edit) may spend building the
   * jobs of an edit's rebuilds (default 8): an edit is waited on, so its
   * jobs go out first and get more room than streaming's.
   */
  readonly editDeriveMsPerUpdate?: number;
  /**
   * Edge of the derive sections (8, 16 or 32 cells): what is derived,
   * swapped and reported as one unit. Smaller sections need assembly rules;
   * the default is {@link DEFAULT_SECTION_EDGE} with rules whose radius
   * fits one, else the chunk edge.
   */
  readonly sectionEdge?: SectionEdge;
}

/**
 * What happened to a chunk, for the systems built on the streamer (render,
 * physics, navigation). `derived` and `shader` (only the shader data was
 * derived again: material or wetness changed, the other outputs stand)
 * name a derive section in section coordinates (chunks when the section
 * edge is the chunk edge); `chunk` names a storage chunk whose sections
 * took new results in one task (its joined draw is to be replaced); `swap`
 * closes an edit's atomic swap, after the `chunk` events of its chunks.
 */
export type StreamEvent =
  | { readonly type: 'loaded' | 'unloaded'; readonly cx: number; readonly cy: number; readonly cz: number }
  | SectionEvent
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
  /** Base hash from the load (when asked for). */
  hash: Uint8Array | null;
  /** The live refresh of a resident chunk (0: none): only the newest refresh swaps its content in. */
  refresh: number;
  /** The changed-cell box the live refresh named (null: the chunk's whole extent), which bounds what its swap rebuilds. */
  refreshBox: CellBox | null;
  /** The derived parts the live refresh's change makes stale (DERIVED_PART bits). */
  refreshParts: number;
}

/** A chunk about to be read. */
function newChunk(cx: number, cy: number, cz: number, key: number, d2: number, tick: number): Chunk {
  return { cx, cy, cz, key, phase: 'reading', job: 0, bytes: 0, parts: null, d2, wantedTick: tick, hash: null, refresh: 0, refreshBox: null, refreshParts: 0 };
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
  /** Derives of the shader data alone (a change of material or wetness only). */
  shaderDerives: number;
  /** Chunks the derive planner looked at (a blocked chunk is looked at again only after a neighbour lands). */
  deriveChecks: number;
  /** Ticks that ended over budget with nothing evictable (dirty or unknown neighbourhood). */
  overBudgetTicks: number;
  /** Ticks a dirty chunk past the unload bounds was kept. */
  heldDirty: number;
  mismatches: number;
  /** Resident chunks read again after their source changed, and swapped in. */
  refreshed: number;
  /** Refreshes not swapped in: damaged, superseded by a later refresh, or the chunk was edited here meanwhile. */
  refreshDropped: number;
  /** Edits whose rebuilt sections were swapped in together. */
  swaps: number;
}

export interface StreamMetrics {
  readonly resident: number;
  readonly residentStored: number;
  readonly reading: number;
  readonly decoding: number;
  readonly damaged: number;
  readonly deriving: number;
  /** Bytes counted against the budget: chunks (store + bookkeeping), derived parts, the runtime overlay, open tables. */
  readonly bytes: { readonly total: number; readonly chunks: number; readonly derived: number; readonly overlay: number; readonly tables: number; readonly budget: number };
  /** The store's own count of its arrays (to check the streamer's sum). */
  readonly storeBytes: number;
  readonly counters: Readonly<StreamCounters>;
}

/** One derive section's result and its section coordinates. */
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
  /** The runtime edits over the base store: what every read of the world sees first. */
  readonly overlay: VoxelOverlay;
  readonly tracker: DirtyTracker;
  readonly ring: StreamRing;
  readonly radius: number;
  budgetBytes: number;
  readonly counters: StreamCounters = { loads: 0, loadsStored: 0, loadsUniform: 0, loadsAir: 0, unloads: 0, evictions: 0, reloads: 0, cancelledLoads: 0, staleRefused: 0, retried: 0, damaged: 0, derives: 0, shaderDerives: 0, deriveChecks: 0, overBudgetTicks: 0, heldDirty: 0, mismatches: 0, refreshed: 0, refreshDropped: 0, swaps: 0 };
  /** Main-thread milliseconds: planning per update, adopting a chunk, building an apron. */
  readonly planMs = new SampleRing();
  readonly adoptMs = new SampleRing();
  readonly apronMs = new SampleRing();
  /** Worker microseconds per stored load: decompress and decode. */
  readonly decompressUs = new SampleRing();
  readonly decodeUs = new SampleRing();
  /** Apron bytes per derive job. */
  readonly apronBytes = new SampleRing();
  /** Worker µs per finished derive job (the assembly evaluation, meshes and consumer outputs). */
  readonly deriveUs = new SampleRing();
  /** Main-thread µs joining a chunk's sections into one draw ({@link joinedChunk}). */
  readonly joinUs = new SampleRing();

  private readonly opts: VoxelStreamerOptions;
  private readonly chunks = new Map<number, Chunk>();
  private readonly unloadedAt = new Map<number, number>();
  private readonly saves = new Map<number, SaveChunk>();
  private onMismatch: MismatchChoice | 'report' = 'save';
  private readonly listeners: Array<(e: StreamEvent) => void> = [];
  private focus: Focus = { x: 0, y: 0, z: 0 };
  /** Motion, lead point and held reads (stream-reads.ts). */
  private readonly plan: StreamReadPlan<{ c: Chunk; stored: StoredChunk }>;
  private wanted: WantedChunk[] = [];
  private cursor = 0;
  private horizon = Infinity;
  private tick = 0;
  private reads = 0;
  /** Refresh load jobs in flight. */
  private refreshing = 0;
  private refreshSeq = 0;
  private bytesChunks = 0;
  private bytesDerived = 0;
  private bytesOverlay = 0;
  /** Payloads, worker results and save bases with the overlay laid over the base. */
  private readonly merged: OverlayMerge;
  private readonly heldOutside = new Set<number>();
  /** The derive sections (null when the streamer derives nothing). */
  private readonly derives: SectionDerives | null;
  private wake: (() => void) | null = null;

  constructor(opts: VoxelStreamerOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.grid = opts.store.grid;
    this.gridId = opts.gridId ?? 0;
    this.tracker = opts.tracker ?? new DirtyTracker();
    this.ring = opts.ring ?? DEFAULT_STREAM_RING;
    checkRing(this.ring);
    this.plan = new StreamReadPlan(this.grid, this.ring, opts.prefetchSeconds ?? STREAM_PREFETCH_SECONDS);
    checkRadius(this.grid.edge, opts.dependencyRadius);
    if (opts.rules !== undefined && jobRadius(opts.rules) !== opts.dependencyRadius) throw new RangeError(`dependency radius ${opts.dependencyRadius} for rules ${opts.rules.id} (needs ${jobRadius(opts.rules)})`);
    this.radius = opts.dependencyRadius;
    if (!(opts.budgetBytes > 0)) throw new RangeError('the streaming budget must be positive');
    this.budgetBytes = opts.budgetBytes;
    this.overlay = new VoxelOverlay(this.store, 'runtime');
    this.merged = new OverlayMerge(this.store, this.overlay);
    const view: DeriveView = {
      grid: this.grid,
      voxelAt: (x, y, z, out) => this.overlay.voxelAt(x, y, z, out),
      chunkForm: (cx, cy, cz) => this.overlay.chunkForm(cx, cy, cz),
      chunkPayload: (cx, cy, cz) => this.merged.payload(cx, cy, cz),
    };
    this.derives =
      opts.derive === true
        ? new SectionDerives(
            {
              store: view,
              grid: this.grid,
              gridId: this.gridId,
              pool: opts.pool,
              tracker: this.tracker,
              radius: this.radius,
              rules: opts.rules,
              counters: this.counters,
              rings: { apronMs: this.apronMs, apronBytes: this.apronBytes, deriveUs: this.deriveUs, joinUs: this.joinUs },
              isResident: (cx, cy, cz) => this.isResident(cx, cy, cz),
              lane: (cx, cy, cz) => (inNearRing(this.grid, this.ring, this.focus, cx, cz) ? 'near' : 'far'),
              distance2: (cx, cy, cz) => chunkDistance2(this.grid, this.focus, cx, cy, cz),
              setPart: (cx, cy, cz, part, bytes) => this.setPart(cx, cy, cz, part, bytes),
              emit: (e) => this.emit(e),
              poke: () => this.poke(),
            },
            opts.sectionEdge ?? defaultSectionEdge(this.grid, opts.rules, this.radius),
            opts.editDeriveMsPerUpdate ?? 8,
          )
        : null;
  }

  /**
   * The voxel at a cell as the game sees it: the overlay's value, else the
   * base's. A cell of a chunk that is not resident reads its override or air
   * (ask {@link isResident} first).
   */
  voxelAt(x: number, y: number, z: number, out: VoxelRecord): VoxelRecord {
    return this.overlay.voxelAt(x, y, z, out);
  }

  /** The grid of derive sections (the chunk grid when sections are whole chunks). */
  get sections(): CellGrid {
    return this.derives?.sections ?? this.grid;
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
    this.plan.moved(this.focus, performance.now());
  }

  /** Whether a chunk's content is in the store (loaded, uniform or known air). */
  isResident(cx: number, cy: number, cz: number): boolean {
    if (!chunkInWorld(this.grid, cx, cy, cz)) return false;
    return this.chunks.get(chunkKey(this.grid, cx, cy, cz))?.phase === 'resident';
  }

  /** A derive section's current result, in section coordinates (null: none yet, or a rebuild pending). */
  derivedOf(sx: number, sy: number, sz: number): DeriveOutput | null {
    return this.derives?.derivedOf(sx, sy, sz) ?? null;
  }

  /**
   * A storage chunk's draw: its derive sections' newest results joined into
   * one ground and one base surface, one instance list and one shader grid
   * of the chunk (chunk-join.ts). Called when a `chunk` event names it; null
   * when the chunk has nothing derived with assembly rules.
   */
  joinedChunk(cx: number, cy: number, cz: number, times?: JoinTimes): JoinedChunk | null {
    return this.derives?.joinedChunk(cx, cy, cz, times) ?? null;
  }

  /** Every derive section with a current result. */
  *derivedChunks(): IterableIterator<DerivedChunk> {
    if (this.derives !== null) yield* this.derives.derived();
  }

  /** {@link setPart} for a derive section (section coordinates): counted against its chunk. */
  setSectionPart(sx: number, sy: number, sz: number, part: string, bytes: number): boolean {
    return this.derives?.setPart(sx, sy, sz, part, bytes) ?? false;
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
    for (const c of this.chunks.values()) {
      if (c.phase === 'resident') {
        resident++;
        if (this.store.chunkForm(c.cx, c.cy, c.cz) === 'stored') stored++;
      } else if (c.phase === 'reading') reading++;
      else if (c.phase === 'decoding') decoding++;
      else damaged++;
    }
    const deriving = this.derives?.deriving ?? 0;
    const tables = this.opts.source.memoryBytes();
    return {
      resident,
      residentStored: stored,
      reading,
      decoding,
      damaged,
      deriving,
      bytes: { total: this.bytesChunks + this.bytesDerived + this.bytesOverlay + tables, chunks: this.bytesChunks, derived: this.bytesDerived, overlay: this.bytesOverlay, tables, budget: this.budgetBytes },
      storeBytes: this.store.memoryBytes(),
      counters: { ...this.counters },
    };
  }

  private laneOf(c: Chunk): JobLane {
    return inNearRing(this.grid, this.ring, this.focus, c.cx, c.cz) ? 'near' : 'far';
  }

  /** One planning step (see the file comment); cheap when the focus stays in its chunk. */
  update(): void {
    const t0 = performance.now();
    this.tick++;
    const g = this.grid;
    if (this.plan.update(this.focus, t0)) {
      this.wanted = readOrder(g, this.ring, this.focus, this.plan.lead);
      this.cursor = 0;
      for (const w of this.wanted) {
        const c = this.chunks.get(chunkKey(g, w.cx, w.cy, w.cz));
        if (c !== undefined) c.wantedTick = this.tick;
      }
      for (const c of [...this.chunks.values()]) {
        c.d2 = chunkDistance2(g, this.focus, c.cx, c.cy, c.cz);
        if (this.plan.pastUnload(this.focus, c.cx, c.cy, c.cz)) this.drop(c, false);
        else if (c.phase === 'decoding') this.opts.pool.reprioritize(c.job, this.laneOf(c), c.d2);
      }
    } else if (this.heldOutside.size > 0) {
      for (const key of [...this.heldOutside]) {
        const c = this.chunks.get(key);
        if (c !== undefined && this.plan.pastUnload(this.focus, c.cx, c.cy, c.cz)) this.drop(c, false);
        else this.heldOutside.delete(key);
      }
    }
    this.enforceBudget();
    // Held stored chunks go to the pool as it has room (a dropped chunk's bytes are let go).
    const held = this.plan.held;
    let n = 0;
    while (n < held.length && this.opts.pool.room() > 0) {
      const { c, stored } = held[n++]!;
      if (this.chunks.get(c.key) === c && c.phase === 'reading') this.decode(c, stored);
    }
    if (n > 0) held.splice(0, n);
    this.requestLoads();
    this.derives?.request(this.opts.deriveMsPerUpdate ?? 2);
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
    if (this.reads > 0 || this.refreshing > 0) return false;
    for (const c of this.chunks.values()) if (c.phase === 'reading' || c.phase === 'decoding') return false;
    if (this.derives?.pending() === true) return false;
    for (let i = this.cursor; i < this.wanted.length; i++) {
      const w = this.wanted[i]!;
      if (w.d2 >= this.horizon) continue;
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
      const ref = jobRef(this, c);
      if (!this.tracker.canUnload(ref)) {
        this.counters.heldDirty++;
        this.heldOutside.add(c.key);
        return false;
      }
      this.derives?.chunkDropped(c.cx, c.cy, c.cz);
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
    this.chunks.delete(c.key);
    return true;
  }

  private partBytes(c: Chunk): number {
    let n = 0;
    if (c.parts !== null) for (const b of c.parts.values()) n += b;
    return n;
  }

  private enforceBudget(): void {
    const tables = this.opts.source.memoryBytes();
    // The overlay counts but is never evicted: it is the game's changes, not a copy of the files.
    let total = this.bytesChunks + this.bytesDerived + this.bytesOverlay + tables;
    if (total <= this.budgetBytes) {
      if (total < this.budgetBytes * RESUME_BELOW && this.horizon !== Infinity) {
        this.horizon = Infinity;
        this.cursor = 0;
      }
      return;
    }
    const candidates = [...this.chunks.values()].filter((c) => c.phase === 'resident' && this.tracker.canUnload(jobRef(this, c)));
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
    const maxReads = this.opts.maxReads ?? DEFAULT_STREAM_READS;
    // Most chunks read are air or uniform and need no worker: reads go on while the pool has room for what waits.
    while (this.reads < maxReads && this.opts.pool.room() > this.plan.held.length && this.cursor < this.wanted.length) {
      const list: Chunk[] = [];
      let column = -1;
      while (this.cursor < this.wanted.length) {
        const w = this.wanted[this.cursor]!;
        // A batch ends between columns: a column is one byte range in its region file.
        if (list.length >= batch && w.column !== column) break;
        this.cursor++;
        if (w.d2 >= this.horizon) continue;
        column = w.column;
        const key = chunkKey(this.grid, w.cx, w.cy, w.cz);
        if (this.chunks.has(key)) continue;
        const c = newChunk(w.cx, w.cy, w.cz, key, w.d2, this.tick);
        this.chunks.set(key, c);
        list.push(c);
      }
      if (list.length === 0) break;
      const axis = this.opts.source.rowAxis;
      if (axis !== undefined) {
        for (const n of this.plan.rowNeighbours(this.focus, axis, list)) {
          const key = chunkKey(this.grid, n.cx, n.cy, n.cz);
          const d2 = chunkDistance2(this.grid, this.focus, n.cx, n.cy, n.cz);
          if (this.chunks.has(key) || d2 >= this.horizon) continue;
          const c = newChunk(n.cx, n.cy, n.cz, key, d2, this.tick);
          this.chunks.set(key, c);
          list.push(c);
        }
      }
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
      if (save === undefined && (this.plan.held.length > 0 || this.opts.pool.room() === 0)) {
        this.plan.held.push({ c, stored: stored! });
        return;
      }
      this.decode(c, stored, save);
    });
  }

  /** Sends a read chunk to a worker: a load, or the save's entry applied over it. */
  private decode(c: Chunk, stored: StoredChunk | null, save = this.saves.get(c.key)): void {
    const job = this.tracker.beginJob(jobRef(this, c));
    c.phase = 'decoding';
    c.job = job.id;
    if (save !== undefined) this.submitApplySave(c, job.id, stored, save);
    else this.submitLoad(c, job.id, stored!);
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
    const content: SaveContentWire = { kind: s.kind, payload: savePayloadOf(s) };
    const input: ApplySaveInput = { edge: this.grid.edge, chunk: { grid: this.gridId, cx: c.cx, cy: c.cy, cz: c.cz }, base, expect: save.base.slice(), content, onMismatch: this.onMismatch };
    const transfer: ArrayBuffer[] = [input.expect.buffer as ArrayBuffer];
    if (base !== null && 'stored' in base) transfer.push(base.stored.buffer as ArrayBuffer);
    transfer.push(content.payload.buffer as ArrayBuffer);
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
    this.tracker.loaded(jobRef(this, c));
    this.derives?.chunkLanded(c.cx, c.cy, c.cz);
    this.emit({ type: 'loaded', cx: c.cx, cy: c.cy, cz: c.cz });
  }

  /**
   * After an edit changed `changed` in the overlay: move their input stamps
   * (jobs reading them are stale; they do not become dirty, the base is
   * unchanged), recount the overlay, and rebuild what the changed fields
   * feed in the edit's group: the shader data alone of the sections within
   * the shader border of `box` when only material or wetness changed, else
   * every section within R of `box`. The jobs go out at once (an edit is
   * waited on), and the group swaps when all are back.
   */
  private afterEdit(changed: readonly ChunkCoord[], box: CellBox, parts: number): number {
    for (const ch of changed) this.tracker.invalidated(jobRef(this, ch));
    this.bytesOverlay = this.overlay.memoryBytes();
    const d = this.derives;
    if (d === null) return 0;
    const group = d.newGroup();
    if (changed.length > 0) d.invalidate(box, 'edit', parts, group);
    d.request(this.opts.deriveMsPerUpdate ?? 2, true);
    d.settleGroup(group);
    return group;
  }

  private loadedCheck = (g: number, cx: number, cy: number, cz: number): boolean => g === this.gridId && this.isResident(cx, cy, cz);

  /**
   * Applies an edit command to the overlay on the main thread (small
   * strokes: tens of µs). Every chunk it can touch must be resident, else
   * it is refused before any write; every section within R of the edit (or
   * within the shader border, for a material or wetness change) is rebuilt
   * in the edit lane. Reads see the edit at once; the rebuilt sections swap
   * in together (the `swap` event naming `group`).
   */
  edit(cmd: VoxelEditCommand, stamps?: readonly { readonly id: string; readonly shape: StampShape }[]): EditOutcome & { readonly group: number } {
    const resolve = resolver(stamps);
    const outcome = applyEdit({ store: (g) => (g === this.gridId ? this.overlay : undefined) }, cmd, { stamps: resolve, loaded: this.loadedCheck });
    const group = this.afterEdit(outcome.chunks, editBounds(this.grid, cmd, resolve), fieldsFeed(outcome.fields));
    return { ...outcome, group };
  }

  /**
   * Applies an edit command in a worker (large fills and stamps): the
   * chunks it touches are sent as copies, and the result is adopted only if
   * none of them changed meanwhile (else `superseded`: send it again, the
   * apply is deterministic).
   */
  async editInWorker(cmd: VoxelEditCommand, stamps?: readonly { readonly id: string; readonly shape: StampShape }[]): Promise<{ status: 'done'; cells: number; undo: ChunkUndo[]; group: number } | { status: 'superseded' | 'refused' | 'failed'; message: string }> {
    const resolve = resolver(stamps);
    const touched = editChunks(this.grid, cmd, resolve);
    for (const t of touched) if (!this.loadedCheck(cmd.grid, t.cx, t.cy, t.cz)) throw new EditRefused('chunk_not_loaded', `chunk (${t.cx}, ${t.cy}, ${t.cz}) of grid ${cmd.grid} is not loaded`);
    const job = this.tracker.beginJob(touched.map((t) => jobRef(this, t)));
    const chunks = touched.map((t) => ({ chunk: { grid: this.gridId, cx: t.cx, cy: t.cy, cz: t.cz }, payload: this.merged.payload(t.cx, t.cy, t.cz) }));
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
      const { cx, cy, cz } = ch.chunk;
      this.merged.adoptEdited(cx, cy, cz, ch.payload);
      changed.push({ cx, cy, cz });
    }
    const group = this.afterEdit(changed, editBounds(this.grid, cmd, resolve), fieldsFeed(o.output.fields));
    return { status: 'done', cells: o.output.cells, undo: decodeUndoRecord(this.grid, o.output.undo), group };
  }

  /**
   * Reads chunks again because the source changed them (another writer
   * applied and saved an edit). Resident chunks keep their content until the
   * new content lands, then swap it in; chunks still being read or decoded
   * are read again; others load as usual when they are wanted.
   *
   * `box`, when the caller knows it (the cells the edit could change,
   * `editBounds`), bounds what is rebuilt: the refreshed chunks and every
   * chunk within the dependency radius of the box. Without it every chunk
   * within the radius of a refreshed chunk's whole extent is rebuilt.
   * `parts` (DERIVED_PART bits, `fieldsFeed` of the changed fields;
   * default all) says what the change makes stale: only the shader data
   * rebuilds the shader data of the chunks within the shader border of the
   * box (or of the refreshed chunks) and nothing else.
   *
   * Returns the refresh's edit group: what it rebuilds swaps in together,
   * once every resident chunk named has landed again (the `swap` event
   * naming it; 0 when the streamer derives nothing).
   */
  refresh(chunks: readonly ChunkCoord[], box?: CellBox, parts: number = ALL_DERIVED_PARTS): number {
    this.opts.source.invalidate?.(chunks);
    const list: Chunk[] = [];
    const token = ++this.refreshSeq;
    const group = this.derives?.newGroup() ?? 0;
    for (const ch of chunks) {
      if (!chunkInWorld(this.grid, ch.cx, ch.cy, ch.cz)) continue;
      const c = this.chunks.get(chunkKey(this.grid, ch.cx, ch.cy, ch.cz));
      if (c === undefined) continue;
      if (c.phase === 'resident') {
        // A refresh still in flight was superseded: its new content lands with this one, so its cells count too.
        c.refreshBox = box === undefined || (c.refresh !== 0 && c.refreshBox === null) ? null : c.refresh !== 0 ? unionBox(c.refreshBox!, box) : { ...box };
        c.refreshParts = (c.refresh !== 0 ? c.refreshParts : 0) | parts;
        c.refresh = token;
        list.push(c);
        this.derives?.awaitChunk(group, c.cx, c.cy, c.cz);
      } else {
        // Bytes read before the change must not land: forget the chunk, the next update reads it again.
        this.drop(c, false);
        this.cursor = 0;
      }
    }
    if (list.length === 0) {
      this.derives?.settleGroup(group);
      return group;
    }
    const versions = list.map((c) => this.tracker.version(jobRef(this, c)));
    this.reads++;
    this.opts.source
      .read(list)
      .then(
        (reads) => list.forEach((c, i) => this.onRefreshRead(c, token, versions[i]!, reads[i]!)),
        () => {
          for (const c of list) if (c.refresh === token) this.refreshDropped(c);
        },
      )
      .finally(() => {
        this.reads--;
        this.poke();
      });
    return group;
  }

  private refreshDropped(c: Chunk): void {
    c.refresh = 0;
    this.counters.refreshDropped++;
    this.derives?.contentDropped(c.cx, c.cy, c.cz);
  }

  private onRefreshRead(c: Chunk, token: number, version: number, r: RegionChunkRead): void {
    if (this.chunks.get(c.key) !== c || c.phase !== 'resident' || c.refresh !== token) return;
    if (r.kind === 'damaged') {
      this.refreshDropped(c);
      return;
    }
    if (r.kind !== 'stored') {
      this.swapIn(c, token, version, r.kind === 'air' ? { form: 'air' } : { form: 'uniform', value: r.value });
      return;
    }
    const job = this.tracker.beginJob(jobRef(this, c));
    // The load does not read neighbours, and staleness is the refresh token's and the edit version's: the job id only routes the reply.
    this.tracker.expireJob(job.id);
    const stored = r.bytes.slice();
    const input: LoadInput = { edge: this.grid.edge, chunk: { grid: this.gridId, cx: c.cx, cy: c.cy, cz: c.cz }, bytes: { stored, raw: r.raw }, hash: false };
    this.refreshing++;
    void this.opts.pool.submit<LoadOutput>({ id: job.id, kind: 'load', lane: 'edit', distance: c.d2, input, transfer: [stored.buffer as ArrayBuffer] }).then((o) => {
      this.refreshing--;
      this.poke();
      if (o.status !== 'done') {
        if (c.refresh === token) this.refreshDropped(c);
        return;
      }
      this.swapIn(c, token, version, o.output.payload);
    });
  }

  /** A refreshed chunk's new content replaces its old one (unless it was refreshed again or edited here meanwhile). */
  private swapIn(c: Chunk, token: number, version: number, payload: ChunkPayload): void {
    if (this.chunks.get(c.key) !== c || c.phase !== 'resident' || c.refresh !== token) return;
    const ref = jobRef(this, c);
    if (this.tracker.version(ref) !== version) {
      this.refreshDropped(c);
      return;
    }
    c.refresh = 0;
    const t0 = performance.now();
    this.store.adoptPayload(c.cx, c.cy, c.cz, payload);
    this.adoptMs.add(performance.now() - t0);
    const bytes = this.store.chunkBytes(c.cx, c.cy, c.cz) + RESIDENT_CHUNK_OVERHEAD_BYTES + this.partBytes(c);
    this.bytesChunks += bytes - c.bytes;
    c.bytes = bytes;
    this.tracker.loaded(ref);
    this.counters.refreshed++;
    const s = this.grid.shift;
    const parts = c.refreshParts;
    c.refreshParts = 0;
    const given = c.refreshBox;
    c.refreshBox = null;
    const box = given ?? { minX: c.cx << s, minY: c.cy << s, minZ: c.cz << s, maxX: ((c.cx + 1) << s) - 1, maxY: ((c.cy + 1) << s) - 1, maxZ: ((c.cz + 1) << s) - 1 };
    this.derives?.contentLanded(c.cx, c.cy, c.cz, box, parts);
    this.emit({ type: 'loaded', cx: c.cx, cy: c.cy, cz: c.cz });
  }

  /**
   * Drops every runtime edit (the game quit, or loads another save) and
   * rebuilds what they changed around the resident chunks in one group,
   * which it returns (0: nothing to rebuild, or the streamer derives
   * nothing). Reads see the base at once.
   */
  clearOverlay(): number {
    const d = this.derives;
    const group = d?.newGroup() ?? 0;
    const g = this.grid;
    const s = g.shift;
    for (const c of this.overlay.changedChunks()) {
      if (!this.isResident(c.cx, c.cy, c.cz)) continue;
      this.tracker.invalidated(jobRef(this, c));
      // What is rebuilt is bounded by the cells that change back, as for an edit.
      const o = this.overlay.chunkOverrides(c.cx, c.cy, c.cz)!;
      const box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
      for (let k = 0; k < o.count; k++) {
        const i = o.cells[k]!;
        const x = (c.cx << s) | (i >>> (s << 1));
        const y = (c.cy << s) | (i & g.mask);
        const z = (c.cz << s) | ((i >>> s) & g.mask);
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        box.minZ = Math.min(box.minZ, z);
        box.maxX = Math.max(box.maxX, x);
        box.maxY = Math.max(box.maxY, y);
        box.maxZ = Math.max(box.maxZ, z);
      }
      d?.invalidate(box, 'edit', ALL_DERIVED_PARTS, group);
    }
    this.overlay.clear();
    this.bytesOverlay = 0;
    if (d !== null) {
      d.request(this.opts.deriveMsPerUpdate ?? 2, true);
      d.settleGroup(group);
    }
    return group;
  }

  /**
   * The save entries of the runtime edits (save-file.ts): each chunk with
   * overrides against its base as the world's files hold it, keeping the
   * fields in `saved` (a PLANE_BIT mask; default material, role and shape:
   * wetness is not saved). A chunk whose kept fields equal the base gives
   * no entry. Chunks unloaded since they were edited are read from the
   * source again for their base; the entries are then taken in one task, so
   * no edit lands half in a save. Refused (rejects) when such a base cannot
   * be read.
   */
  async saveChunks(saved: number = DEFAULT_SAVED_FIELDS): Promise<SaveChunk[]> {
    const bases = createWorldStore(this.grid, 'save-base');
    const have = new Set<number>();
    // Chunks can unload while bases are read: read until every chunk away has its base here.
    for (;;) {
      const away = this.overlay.changedChunks().filter((c) => !this.isResident(c.cx, c.cy, c.cz) && !have.has(chunkKey(this.grid, c.cx, c.cy, c.cz)));
      if (away.length === 0) break;
      await readBaseChunks(away, bases, { gridId: this.gridId, source: this.opts.source, pool: this.opts.pool, tracker: this.tracker });
      for (const c of away) have.add(chunkKey(this.grid, c.cx, c.cy, c.cz));
    }
    const out: SaveChunk[] = [];
    const scratch = createDenseChunk(this.grid);
    for (const c of this.overlay.changedChunks()) {
      const e = this.overlay.saveChunk(this.gridId, c.cx, c.cy, c.cz, this.isResident(c.cx, c.cy, c.cz) ? this.store : bases, saved, scratch);
      if (e !== null) out.push(e);
    }
    return out;
  }
}

/** A chunk's key in the dirty tracker's job references. */
function jobRef(s: { readonly gridId: number; readonly grid: ChunkGrid }, c: { cx: number; cy: number; cz: number }): { grid: number; key: number } {
  return { grid: s.gridId, key: chunkKey(s.grid, c.cx, c.cy, c.cz) };
}

function resolver(stamps?: readonly { readonly id: string; readonly shape: StampShape }[]): ((id: string) => { shape: StampShape; hash: string } | undefined) | undefined {
  if (stamps === undefined) return undefined;
  const m = new Map(stamps.map((s) => [s.id, { shape: s.shape, hash: stampShapeHash(s.shape) }]));
  return (id) => m.get(id);
}

/**
 * Sections of the engine default edge when assembly rules can derive them
 * (their radius fits a section, the chunk splits into them), else whole
 * chunks.
 */
function defaultSectionEdge(grid: ChunkGrid, rules: AssemblyRuleSet | undefined, radius: number): SectionEdge {
  if (rules === undefined || grid.edge <= DEFAULT_SECTION_EDGE || grid.edge % DEFAULT_SECTION_EDGE !== 0 || radius > DEFAULT_SECTION_EDGE) return grid.edge as SectionEdge;
  return DEFAULT_SECTION_EDGE;
}

function unionBox(a: CellBox, b: CellBox): CellBox {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ) };
}
