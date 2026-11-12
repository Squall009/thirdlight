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
 *   (`load`);
 * - with derive on, a chunk whose neighbours within R are all known gets a
 *   `derive` job (the placeholder for meshing and its kin) with its apron;
 * - with assembly rules, the chunk tree's coarser levels are built from
 *   the resident chunks and derived within their rings, after all level-0
 *   work (stream-mips.ts);
 * - bodies get their ground on a path of their own (stream-collision.ts):
 *   collision-only derives round the collision foci its host names, ahead
 *   of the drawing work;
 * - faster than {@link STREAM_DETAIL_SPEED} level 0 is held back: the
 *   levels drawn leave it out, no streaming level-0 derive goes out and
 *   those waiting in the pool are cancelled; once the speed has stayed
 *   down, they are derived nearest the focus first and drawn.
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
 * A restored save goes into the overlay too ({@link VoxelStreamer.restoreSave}):
 * its entries for chunks not loaded wait and land in the overlay with their
 * chunk, so the base always stays what the files hold and a later save's
 * base hashes are of the shipped chunks.
 */
import { StreamDetail } from './stream-detail';
import { CollisionDerives, type CollisionEvent } from './stream-collision';
import { copyCoverage, countGround, emptyCoverage, type GroundCoverage, type GroundQuery } from './stream-coverage';
import { checkRadius } from './apron';
import type { JoinedChunk, JoinedDraw, JoinTimes } from './chunk-join';
import { jobRadius, type AssemblyRuleSet } from './assembly';
import { ALL_DERIVED_PARTS, DEFAULT_SAVED_FIELDS, fieldsFeed, MATERIAL_AIR, type VoxelRecord } from './record';
import { payloadTransfer, type ChunkPayload } from './chunk-wire';
import type { PieceTable } from './piece-table';
import { StreamPieces } from './stream-pieces';
import type { ReliefRing, ReliefRingSettings } from './relief-ring';
import { StreamRelief, type ReliefEvent } from './stream-relief';
import { chunkInWorld, chunkKey, DEFAULT_SECTION_EDGE, type CellGrid, type ChunkCoord, type ChunkGrid, type SectionEdge } from './coords';
import { createDenseChunk } from './dense-chunk';
import { DirtyTracker } from './dirty-tracker';
import { applyEdit, editBounds, editChunks, EditRefused, type ChunkUndo, type EditOutcome } from './edit-apply';
import type { VoxelEditCommand } from './edit-command';
import { createWorldStore, type PaletteStore } from './palette-store';
import type { RegionChunkRead } from './region-file';
import type { ChunkSource } from './region-source';
import type { MismatchChoice, SaveChunk } from './save-file';
import { stampShapeHash, type StampShape } from './stamp-shape';
import type { CellBox } from './stroke';
import type { DeriveOutput, EditInput, EditOutput, JobLane, LoadInput, LoadOutput, StoredChunk } from './stream-job';
import { StreamMips, type MipEvent } from './stream-mips';
import type { LevelEvent } from './stream-lod';
import type { SeamEvent } from './stream-seams';
import type { LevelRings } from './lod-select';
import { SectionDerives, type DeriveView, type SectionEvent } from './stream-sections';
import { DEFAULT_STREAM_READS, motionDistance2, readOrder, STREAM_PREFETCH_SECONDS, StreamReadPlan, type WantedChunk } from './stream-reads';
import { checkRing, chunkDistance2, DEFAULT_LEVEL_RINGS, DEFAULT_STREAM_RING, mipRingsFor, RESIDENT_CHUNK_OVERHEAD_BYTES, type Focus, type MipRing, type StreamRing } from './stream-ring';
import { decodeUndoRecord } from './undo-store';
import { FarField, type FarFieldOptions } from './far-field';
import type { FarFineHost } from './far-fine';
import { OverlayMerge, PendingRestore, readBaseChunks } from './stream-overlay';
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
  /**
   * The chunk tree's levels kept derived, with `rules` (default: each
   * default level to the load ring, `mipRingsFor`, following the ring when
   * it changes; empty: none). Nodes are built in workers from the resident
   * chunks, never stored.
   */
  readonly mips?: readonly MipRing[];
  /**
   * Where each level is drawn, with mips (default
   * {@link DEFAULT_LEVEL_RINGS}): `mips.lod` chooses, from it and the foci.
   */
  readonly levels?: LevelRings;
  /**
   * The world's kit piece table (piece-table.ts, built for `rules`): what
   * the derives choose detail pieces from. Absent: no kit, no pieces
   * (`pieces.set` changes it).
   */
  readonly pieces?: PieceTable | null;
  /**
   * The relief ring, with `rules` (relief-ring.ts; absent or n 0: none):
   * level-0 sections round the focus also derive a relief mesh `n` lattice
   * steps a cell, drawn in place of their surfaces, displaced to `radius`
   * cells; collision and every other output stay the plain derive's. The
   * ring is planned again as the focus moves (`relief.set` changes it) and holds at most its share of the budget
   * (`RELIEF_BUDGET_SHARE`), shrinking to fit; the base world keeps the rest.
   */
  readonly relief?: ReliefRingSettings;
  /**
   * The far field as voxel-mip meshes, with `rules` (far-field.ts; absent:
   * nothing is drawn past the near rings): the far cache's nodes selected by
   * screen error from the focus, meshed in this pool after everything else.
   */
  readonly far?: FarFieldOptions;
}

/**
 * What happened to a chunk, for the systems built on the streamer (render,
 * physics, navigation). `derived` and `shader` (only the shader data was
 * derived again: material or wetness changed, the other outputs stand)
 * name a derive section in section coordinates (chunks when the section
 * edge is the chunk edge); `chunk` names a storage chunk whose sections
 * took new results in one task (its joined draw is to be replaced); `swap`
 * closes an edit's atomic swap, after the `chunk` events of its chunks;
 * `node` names a chunk-tree node whose derived result changed
 * ({@link VoxelStreamer.mips}); `seams` names the seams between levels
 * built and dropped in one swap (`mips.seams`), just before the `swap` or
 * after the `node` event of what changed them; `levels` names the nodes
 * drawn and no longer drawn (`mips.lod`): a change of the levels drawn,
 * just after the `seams` event of the same swap, or nodes that can no
 * longer be drawn.
 */
export type StreamEvent =
  | { readonly type: 'loaded' | 'unloaded'; readonly cx: number; readonly cy: number; readonly cz: number }
  | SectionEvent
  | { readonly type: 'damaged'; readonly cx: number; readonly cy: number; readonly cz: number; readonly reason: string }
  | { readonly type: 'mismatch'; readonly cx: number; readonly cy: number; readonly cz: number; readonly applied: boolean }
  | MipEvent
  | SeamEvent
  | LevelEvent
  | ReliefEvent
  | CollisionEvent;

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
/** The longest `settle` waits between updates for a read or a job to end before it updates anyway. */
const SETTLE_POLL_MS = 4;

/** Fraction of the budget eviction brings the total down to, and below which loading resumes past the eviction horizon. */
const EVICT_TO = 0.95;
const RESUME_BELOW = 0.85;

/**
 * Share of the pool's queue loads leave free while bodies' collision-only derives wait (64 of the streaming pool's
 * 256), so a body's ground never waits behind a refill's decodes.
 */
export const STREAM_DERIVE_RESERVE_SHARE = 0.25;

/**
 * Pool room loads may take: all of it, less {@link STREAM_DERIVE_RESERVE_SHARE} of the queue while `reserve` (a
 * body's collision-only derives are waiting). A refill reads and decodes in tasks of its own between updates;
 * without the reserve its decodes would fill the queue ahead of a stopped body's ground. Held back always, the
 * reserve slowed the refill itself: the level-0 ring after a stop waits for the chunks round it to load.
 */
function loadRoom(pool: WorkerPool, reserve: boolean): number {
  return pool.room() - (reserve ? Math.floor(pool.capacity * STREAM_DERIVE_RESERVE_SHARE) : 0);
}

export interface StreamCounters {
  /** Times the load ring narrowed or widened for the focus's speed (stream-ring.ts `speedRing`). */
  speedRings: number;
  /** Updates, and those where the ground under the focus or its lead point was not resident and derived, or out of the ring's height (stream-coverage.ts). */
  readonly ground: GroundCoverage;
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
  /** Edits (and relief ring changes, `relief.plans`) whose rebuilt sections were swapped in together. */
  swaps: number;
  /** Of the derives, sections answered empty without a job (air with air all round). */
  airDerives: number;
  /** Derive jobs cancelled while still queued: their chunk unloaded, or left the collision ring while level 0 was held back. */
  cancelledDerives: number;
  /** Times level 0 was held back for the focus's speed, and let go again. */
  detailHolds: number;
  /** Collision-only derives that landed round bodies (stream-collision.ts), air chunks among them answered without a job, and those refused. */
  collisionDerives: number;
  collisionAir: number;
  collisionRefused: number;
}

export interface StreamMetrics {
  readonly resident: number;
  readonly residentStored: number;
  readonly reading: number;
  readonly decoding: number;
  readonly damaged: number;
  readonly deriving: number;
  /** Bytes counted against the budget: chunks (store + bookkeeping), derived parts, the runtime overlay, open tables (and region files a source holds whole), the chunk tree's nodes, the page's kit meshes and textures. */
  readonly bytes: { readonly total: number; readonly chunks: number; readonly derived: number; readonly overlay: number; readonly tables: number; readonly mips: number; readonly kits: number; readonly budget: number; readonly relief: number; readonly reliefShare: number };
  /** The store's own count of its arrays (to check the streamer's sum). */
  readonly storeBytes: number;
  readonly counters: Readonly<StreamCounters>;
  /** Worker µs a level-0 section evaluating the rules, all sections and those drawing pieces (null: nothing derived). */
  readonly evaluateUs: { readonly all: SampleSummary; readonly pieces: SampleSummary } | null;
  /** Worker µs a level-0 section building its relief mesh (null: none asked for, or nothing derived). */
  readonly reliefUs: SampleSummary | null;
  /** The relief ring (cells; null: the streamer derives no sections with rules). */
  readonly relief: ReturnType<ReliefRing['state']> | null;
  /** Updates counted, those where the ground under the focus or its lead point was not resident and derived, and those with no ground within the ring's height (stream-coverage.ts). */
  readonly coverage: Readonly<GroundCoverage>;
}

/** Quantiles of a sample ring (µs) and how many samples it holds. */
export interface SampleSummary {
  readonly p50: number;
  readonly p95: number;
  readonly n: number;
}

const summarize = (r: SampleRing): SampleSummary => ({ p50: Number(r.quantile(0.5).toFixed(1)), p95: Number(r.quantile(0.95).toFixed(1)), n: r.count });

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
  readonly radius: number;
  budgetBytes: number;
  readonly counters: StreamCounters = { loads: 0, loadsStored: 0, loadsUniform: 0, loadsAir: 0, unloads: 0, evictions: 0, reloads: 0, cancelledLoads: 0, staleRefused: 0, retried: 0, damaged: 0, derives: 0, shaderDerives: 0, deriveChecks: 0, overBudgetTicks: 0, heldDirty: 0, mismatches: 0, refreshed: 0, refreshDropped: 0, swaps: 0, speedRings: 0, airDerives: 0, cancelledDerives: 0, detailHolds: 0, collisionDerives: 0, collisionAir: 0, collisionRefused: 0, ground: emptyCoverage() };
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
  /** A restored save's entries for chunks not loaded yet: each lands in the overlay with its chunk. */
  private readonly restoring = new PendingRestore();
  private readonly listeners: Array<(e: StreamEvent) => void> = [];
  private focus: Focus = { x: 0, y: 0, z: 0 };
  /** Motion, lead point and held reads (stream-reads.ts). */
  private readonly plan: StreamReadPlan<{ c: Chunk; stored: StoredChunk }>;
  private wanted: WantedChunk[] = [];
  private cursor = 0;
  private horizon = Infinity;
  private tick = 0;
  private reads = 0;
  /** Refresh load jobs in flight, and the last refresh number given. */
  private readonly refreshes = { live: 0, seq: 0 };
  /** Bytes the stream holds by part: chunk payloads, derived results, the runtime overlay. */
  private readonly held = { chunks: 0, derived: 0, overlay: 0 };
  /** Payloads, worker results and save bases with the overlay laid over the base. */
  private readonly merged: OverlayMerge;
  private readonly heldOutside = new Set<number>();
  /** The derive sections (null when the streamer derives nothing). */
  private readonly derives: SectionDerives | null;
  /** The chunk tree's coarser levels: their nodes' derived results, metrics and bytes (null without rules or levels). */
  readonly mips: StreamMips | null;
  private wake: (() => void) | null = null;
  /**
   * The relief ring (null: no sections derived with rules): `relief.set`
   * changes it without a reload (the next update plans it; the sections it
   * changes swap in together), `relief.radius` is where it displaces now.
   */
  readonly relief: StreamRelief | null;
  /** The kit piece table the derives choose pieces from ({@link StreamPieces.set} changes it). */
  readonly pieces: StreamPieces;
  /** The far field (null: none): its events go to the draws beside the stream's. */
  readonly far: FarField | null;
  /** Level 0 held back at speed (stream-detail.ts): `detail.held` now. */
  readonly detail: StreamDetail;
  /**
   * Collision on its own path (stream-collision.ts; null without derives and rules): its host names the collision
   * foci (`setFoci`) and the ring's add bounds (`bounds`, cells) each update; `source` is a chunk's collision-only
   * join until its full result is in.
   */
  readonly collision: CollisionDerives | null;

  constructor(opts: VoxelStreamerOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.grid = opts.store.grid;
    this.gridId = opts.gridId ?? 0;
    this.tracker = opts.tracker ?? new DirtyTracker();
    const ring = opts.ring ?? DEFAULT_STREAM_RING;
    checkRing(ring);
    this.plan = new StreamReadPlan(this.grid, ring, opts.prefetchSeconds ?? STREAM_PREFETCH_SECONDS);
    this.detail = new StreamDetail(this.plan);
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
              pieceTable: () => this.pieces.table,
              relief: (sx, sy, sz) => this.relief?.ring.optionsFor(sx, sy, sz) ?? null,
              counters: this.counters,
              rings: { apronMs: this.apronMs, apronBytes: this.apronBytes, deriveUs: this.deriveUs, joinUs: this.joinUs },
              isResident: (cx, cy, cz) => this.isResident(cx, cy, cz),
              coming: (cx, cy, cz) => {
                const c = this.chunks.get(chunkKey(this.grid, cx, cy, cz));
                if (c !== undefined) return c.phase === 'reading' || c.phase === 'decoding';
                return this.plan.wants(this.focus, cx, cy, cz) && chunkDistance2(this.grid, this.focus, cx, cy, cz) < this.horizon;
              },
              lane: (cx, cy, cz) => laneOf(this.plan, this.focus, cx, cz),
              distance2: (cx, cy, cz) => motionDistance2(this.grid, this.focus, this.plan.lead, cx, cy, cz),
              setPart: (cx, cy, cz, part, bytes) => this.setPart(cx, cy, cz, part, bytes),
              emit: (e) => {
                this.emit(e);
                // A chunk's drawn surfaces changed: the seams reading them follow (a group's own are rebuilt in its swap), and it may be drawable now.
                if (e.type === 'chunk' && !e.shaderOnly) {
                  this.mips?.seams.chunkChanged(e.cx, e.cy, e.cz);
                  this.mips?.lod.changed();
                }
              },
              poke: () => this.poke(),
              deriveNow: (cx, cy, cz) => this.detail.deriveNow(cx, cy, cz),
              seamHold: (groups, chunks, surfaces, ready) => this.mips?.holdEdit(groups, chunks, surfaces, ready) ?? null,
            },
            opts.sectionEdge ?? defaultSectionEdge(this.grid, opts.rules, this.radius),
            opts.editDeriveMsPerUpdate ?? 8,
          )
        : null;
    const derives = this.derives;
    this.collision =
      derives !== null && opts.rules !== undefined
        ? new CollisionDerives({
            store: view,
            grid: this.grid,
            gridId: this.gridId,
            pool: opts.pool,
            tracker: this.tracker,
            radius: this.radius,
            rules: opts.rules,
            sectionEdge: derives.sections.edge as SectionEdge,
            pieceTable: () => this.pieces.table,
            isResident: (cx, cy, cz) => this.isResident(cx, cy, cz),
            fullReady: (cx, cy, cz) => derives.chunkReady(cx, cy, cz),
            fullCurrent: (cx, cy, cz) => derives.chunkCurrent(cx, cy, cz),
            stamps: (cx, cy, cz) => derives.stampsOf(cx, cy, cz),
            derivable: (cx, cy, cz) => derives.chunkDerivable(cx, cy, cz),
            setPart: (cx, cy, cz, part, bytes) => this.setPart(cx, cy, cz, part, bytes),
            emit: (e) => this.emit(e),
            poke: () => this.poke(),
            counters: this.counters,
          })
        : null;
    this.relief = this.derives !== null && opts.rules !== undefined ? new StreamRelief(this.derives, this.grid, (cx, cy, cz) => this.chunks.get(chunkKey(this.grid, cx, cy, cz))?.parts ?? null) : null;
    if (opts.relief !== undefined && opts.relief.n !== 0) {
      if (this.relief === null) throw new RangeError('relief needs a streamer deriving with assembly rules');
      this.relief.set(opts.relief);
    }
    const rings = opts.mips ?? mipRingsFor(ring);
    const streamer = this;
    const chunks = this.chunks;
    this.mips =
      this.derives !== null && opts.rules !== undefined && rings.length > 0
        ? new StreamMips(
            {
              grid: this.grid,
              gridId: this.gridId,
              pool: opts.pool,
              tracker: this.tracker,
              rules: opts.rules,
              pieceTable: () => this.pieces.table,
              radius: this.radius,
              isResident: (cx, cy, cz) => this.isResident(cx, cy, cz),
              *residentChunks() {
                for (const c of chunks.values()) if (c.phase === 'resident') yield { cx: c.cx, cy: c.cy, cz: c.cz };
              },
              chunkPayload: (cx, cy, cz) => this.merged.payload(cx, cy, cz),
              chunkSurfaces: (cx, cy, cz, axis, plane) => this.derives?.seamSurfaces(cx, cy, cz, axis, plane),
              chunkReady: (cx, cy, cz) => this.derives?.chunkReady(cx, cy, cz) ?? false,
              get ring() {
                return streamer.ring;
              },
              focus: () => this.focus,
              emit: (e) => this.emit(e),
              poke: () => this.poke(),
            },
            rings,
            opts.levels ?? DEFAULT_LEVEL_RINGS,
          )
        : null;
    if (opts.far !== undefined && opts.rules === undefined) throw new RangeError('the far field needs a streamer deriving with assembly rules');
    const fineHost: FarFineHost = {
      // Outside the world is air: a fine node at the world's edge reads it as such.
      resident: (cx, cy, cz) => !chunkInWorld(this.grid, cx, cy, cz) || this.isResident(cx, cy, cz),
      holds: (cx, cy, cz) => {
        if (!this.isResident(cx, cy, cz)) return false;
        const form = this.overlay.chunkForm(cx, cy, cz);
        if (form !== 'uniform') return form === 'stored';
        const s = this.grid.shift;
        return this.overlay.voxelAt(cx << s, cy << s, cz << s, fineProbe).material !== MATERIAL_AIR;
      },
      cells: (cx, cy, cz, out) => this.isResident(cx, cy, cz) && this.overlay.exportChunk(cx, cy, cz, out),
      nearDrawn: (cx, cy, cz) => nearDrawn(this.mips, cx, cy, cz, () => this.isResident(cx, cy, cz)),
    };
    this.far = opts.far !== undefined && opts.rules !== undefined ? new FarField(opts.far, { grid: this.grid, pool: opts.pool, rules: opts.rules, fine: fineHost }) : null;
    if (this.far?.fineNodes.wanted === true) setNearOnly(this, true);
    const merged = this.merged;
    this.pieces = new StreamPieces(
      {
        rules: opts.rules,
        derives: this.derives,
        mips: this.mips,
        deriveMs: opts.deriveMsPerUpdate ?? 2,
        *resident() {
          for (const c of chunks.values()) if (c.phase === 'resident') yield { cx: c.cx, cy: c.cy, cz: c.cz, payload: () => merged.payload(c.cx, c.cy, c.cz) };
        },
      },
      opts.pieces ?? null,
    );
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
    // Where the near field draws decides where fine far nodes open (a node it draws whole stays closed).
    if (e.type === 'levels') this.far?.fineNodes.residency();
    for (const l of this.listeners) l(e);
  }

  /**
   * Restores a game's save in place of every runtime edit: the overlay is
   * cleared and each entry of this grid goes into it, never into the base
   * store. A resident chunk's entry is laid over it now (reads see it at
   * once; what it changes is rebuilt in the returned group, as for
   * {@link clearOverlay}); any other waits and lands with its chunk, before
   * the chunk counts as resident. `onMismatch` is the game's choice when an
   * entry's base hash differs from the shipped chunk's: the player's cells
   * on the new base (`save`), or the new base alone (`base`, the entry
   * dropped); either way a `mismatch` event reports the chunk.
   */
  restoreSave(entries: Iterable<SaveChunk>, onMismatch: MismatchChoice): number {
    const group = this.clearOverlay(false);
    this.restoring.start(onMismatch);
    for (const e of entries) {
      if (e.grid !== this.gridId) continue;
      if (this.isResident(e.cx, e.cy, e.cz)) this.restoreInto(e, group);
      else this.restoring.put(chunkKey(this.grid, e.cx, e.cy, e.cz), e);
    }
    this.held.overlay = this.overlay.memoryBytes() + this.restoring.bytes;
    this.settleRebuild(group);
    return group;
  }

  /**
   * Lays a save entry over its chunk's base in the overlay and returns the
   * base's hash; `group`: rebuild what it changed there (0: the chunk is
   * landing, so everything around it is derived anyway).
   */
  private restoreInto(e: SaveChunk, group: number): Uint8Array {
    const out = this.restoring.apply(this.store, this.overlay, e);
    if (out.mismatch) {
      this.counters.mismatches++;
      this.emit({ type: 'mismatch', cx: e.cx, cy: e.cy, cz: e.cz, applied: out.applied });
    }
    if (group !== 0) this.rebuildOverrides(e, group);
    return out.baseNow;
  }

  /** Moves the focus (cells; fractions allowed). Planning happens in the next {@link update}. */
  setFocus(x: number, y: number, z: number): void {
    this.focus = { x, y, z };
    this.plan.moved(this.focus, performance.now());
  }

  /**
   * Whether every derive section of a chunk has its result, or waits for a chunk that is not coming (the load ring's
   * edge; without derives: whether it is resident). A chunk's `chunk` event comes with its first sections' results,
   * its body then built from those; what stands on it waits for this.
   */
  chunkReady(cx: number, cy: number, cz: number): boolean {
    return this.derives?.chunkReady(cx, cy, cz) ?? this.isResident(cx, cy, cz);
  }

  /** Whether a chunk's content is in the store (loaded, uniform or known air). */
  isResident(cx: number, cy: number, cz: number): boolean {
    if (!chunkInWorld(this.grid, cx, cy, cz)) return false;
    return this.chunks.get(chunkKey(this.grid, cx, cy, cz))?.phase === 'resident';
  }

  /**
   * A derive section's current result, in section coordinates (null: none
   * yet, or a rebuild pending); `drawn`: the newest committed result, the
   * one drawn and collided, even while a rebuild is pending.
   */
  derivedOf(sx: number, sy: number, sz: number, drawn = false): DeriveOutput | null {
    return this.derives?.derivedOf(sx, sy, sz, drawn) ?? null;
  }

  /**
   * A storage chunk's draw: its derive sections' newest results joined into
   * one ground and one base surface, one instance list and one shader grid
   * of the chunk (chunk-join.ts). Called when a `chunk` event names it; null
   * when the chunk has nothing derived with assembly rules. Given `cells`,
   * the join is as a renderer uploads it ({@link JoinedDraw}): the shader
   * grid's entries are written there (side³) unless it is one solid entry,
   * so no palette is packed only to be expanded again.
   */
  joinedChunk(cx: number, cy: number, cz: number, times?: JoinTimes): JoinedChunk | null;
  joinedChunk(cx: number, cy: number, cz: number, times: JoinTimes | undefined, cells: Uint16Array): JoinedDraw | null;
  joinedChunk(cx: number, cy: number, cz: number, times?: JoinTimes, cells?: Uint16Array): JoinedChunk | JoinedDraw | null {
    if (this.derives === null) return null;
    return cells === undefined ? this.derives.joinedChunk(cx, cy, cz, times) : this.derives.joinedDraw(cx, cy, cz, cells, times);
  }

  /** Every derive section with a current result. */
  *derivedChunks(): IterableIterator<DerivedChunk> {
    if (this.derives !== null) yield* this.derives.derived();
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
    this.held.derived += bytes - old;
    if (this.relief !== null && StreamRelief.isPart(part)) this.relief.bytes += bytes - old;
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
    const mips = this.mips?.bytes ?? 0;
    const kits = this.pieces.gpuBytes;
    return {
      resident,
      residentStored: stored,
      reading,
      decoding,
      damaged,
      deriving,
      bytes: { total: this.held.chunks + this.held.derived + this.held.overlay + tables + mips + kits, chunks: this.held.chunks, derived: this.held.derived, overlay: this.held.overlay, tables, mips, kits, budget: this.budgetBytes, relief: this.relief?.bytes ?? 0, reliefShare: this.relief?.share(this.budgetBytes) ?? 0 },
      storeBytes: this.store.memoryBytes(),
      counters: { ...this.counters, ground: copyCoverage(this.counters.ground) },
      evaluateUs: this.derives === null ? null : { all: summarize(this.derives.evaluateUs.all), pieces: summarize(this.derives.evaluateUs.pieces) },
      reliefUs: this.derives === null || this.derives.reliefUs.count === 0 ? null : summarize(this.derives.reliefUs),
      relief: this.relief?.ring.state() ?? null,
      coverage: copyCoverage(this.counters.ground),
    };
  }

  /** The load ring (its unload bounds hold every resident chunk). */
  get ring(): StreamRing {
    return this.plan.ring;
  }

  /**
   * A new load ring, applied without a reload: the next update plans again,
   * so chunks past the new unload bounds go (their draws and bodies with
   * them) and those now inside load; the levels kept derived follow the
   * load ring unless the streamer was given its own (`mips`).
   */
  setRing(ring: StreamRing): void {
    checkRing(ring);
    this.plan.setRing(ring);
    if (this.opts.mips === undefined) this.mips?.setRings(mipRingsFor(ring));
    this.mips?.lod.changed();
    this.poke();
  }

  /** One planning step (see the file comment); cheap when the focus stays in its chunk. */
  update(): void {
    const t0 = performance.now();
    this.tick++;
    const g = this.grid;
    const replanned = this.plan.update(this.focus, t0);
    if (this.plan.detailChanged) {
      this.counters.detailHolds++;
      this.mips?.lod.setDetail(!this.plan.detailHeld);
      this.poke();
    }
    if (replanned) {
      if (this.plan.ringChanged) {
        if (this.opts.mips === undefined) this.mips?.setRings(mipRingsFor(this.ring));
        this.mips?.lod.changed();
        this.counters.speedRings++;
      }
      this.wanted = readOrder(g, this.ring, this.focus, this.plan.lead, this.plan.leadRadius);
      this.cursor = 0;
      for (const w of this.wanted) {
        const c = this.chunks.get(chunkKey(g, w.cx, w.cy, w.cz));
        if (c !== undefined) c.wantedTick = this.tick;
      }
      for (const c of [...this.chunks.values()]) {
        c.d2 = chunkDistance2(g, this.focus, c.cx, c.cy, c.cz);
        if (this.plan.pastUnload(this.focus, c.cx, c.cy, c.cz)) this.drop(c, false);
        else if (c.phase === 'decoding') this.opts.pool.reprioritize(c.job, laneOf(this.plan, this.focus, c.cx, c.cz), motionDistance2(g, this.focus, this.plan.lead, c.cx, c.cy, c.cz));
      }
      this.mips?.focusMoved();
      // Held back, the level-0 derives still waiting in the pool are not built for nothing (bodies have their own path);
      // near only, neither are those for chunks the detail ring has left.
      if (this.detail.fast) this.derives?.cancelQueued(() => false);
      else if (this.detail.nearOnly) this.derives?.cancelQueued((cx, cy, cz) => this.detail.deriveNow(cx, cy, cz));
    } else if (this.heldOutside.size > 0) {
      for (const key of [...this.heldOutside]) {
        const c = this.chunks.get(key);
        if (c !== undefined && this.plan.pastUnload(this.focus, c.cx, c.cy, c.cz)) this.drop(c, false);
        else this.heldOutside.delete(key);
      }
    }
    this.relief?.plan(this.focus);
    this.enforceBudget();
    // The draws' fade follows the ring's centre and where it displaces now.
    const told = this.relief?.drawState(this.focus) ?? null;
    if (told !== null) this.emit(told);
    // Loads leave room for bodies' ground while it waits (looked at once an update: the collision foci's chunks).
    this.collision?.look();
    // Held stored chunks go to the pool as it has room (a dropped chunk's bytes are let go).
    const held = this.plan.held;
    let n = 0;
    while (n < held.length && loadRoom(this.opts.pool, this.collision?.waiting === true) > 0) {
      const { c, stored } = held[n++]!;
      if (this.chunks.get(c.key) === c && c.phase === 'reading') this.decode(c, stored);
    }
    if (n > 0) held.splice(0, n);
    this.requestLoads();
    // Bodies' ground before the drawing work: it is what a player waits for, and it is cheap.
    this.collision?.request(this.opts.deriveMsPerUpdate ?? 2);
    this.derives?.request(this.opts.deriveMsPerUpdate ?? 2);
    this.mips?.request(this.opts.deriveMsPerUpdate ?? 2);
    // The far field selects from the focus too; its jobs go last in the pool.
    this.far?.setEye(this.focus.x, this.focus.y, this.focus.z, { radius: this.ring.loadRadius, height: this.ring.loadHeight, drawn: (cx, cy, cz) => nearDrawn(this.mips, cx, cy, cz, () => this.chunks.get(chunkKey(this.grid, cx, cy, cz))?.phase === 'resident') });
    this.far?.update();
    // Whether the ground under the focus and its lead point is resident and derived this update (stream-coverage.ts).
    const ground: GroundQuery = {
      isResident: (x, y, z) => this.isResident(x, y, z),
      chunkReady: (x, y, z) => this.chunkReady(x, y, z),
      isAir: (x, y, z) => this.store.chunkForm(x, y, z) === 'absent',
      gap: (x, y, z) => {
        const c = this.chunks.get(chunkKey(this.grid, x, y, z));
        if (c === undefined) return 'unread';
        if (c.phase === 'reading') return 'reading';
        if (c.phase === 'decoding') return 'decoding';
        return this.derives?.chunkBlocked(x, y, z) === true ? 'blocked' : 'deriving';
      },
    };
    countGround(this.counters.ground, this.grid, this.focus, this.plan.lead, this.ring.loadHeight, ground);
    for (const [key, at] of this.unloadedAt) {
      if (t0 - at <= CHURN_WINDOW_MS) break;
      this.unloadedAt.delete(key);
    }
    this.planMs.add(performance.now() - t0);
  }

  /**
   * Resolves once nothing is being read, decoded or derived and nothing
   * more can be requested. A read or a job wakes the next update when it
   * ends; work no one answers (air derived around air within an update's
   * derive time, sections waiting for it) goes on after
   * {@link SETTLE_POLL_MS} at the latest, so a world of air settles too.
   */
  async settle(maxUpdates = 100_000): Promise<void> {
    for (let i = 0; i < maxUpdates; i++) {
      this.update();
      if (this.idle()) return;
      await new Promise<void>((resolve) => {
        const poll = setTimeout(() => this.poke(), SETTLE_POLL_MS);
        this.wake = () => {
          clearTimeout(poll);
          resolve();
        };
      });
    }
    throw new Error('streamer did not settle');
  }

  private idle(): boolean {
    if (this.reads > 0 || this.refreshes.live > 0) return false;
    for (const c of this.chunks.values()) if (c.phase === 'reading' || c.phase === 'decoding') return false;
    if (this.derives?.pending() === true || this.mips?.pending() === true || this.collision?.pending() === true) return false;
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
      this.collision?.dropped(c.cx, c.cy, c.cz);
      this.store.dropChunk(c.cx, c.cy, c.cz);
      this.mips?.chunkDropped(c.cx, c.cy, c.cz);
      this.far?.fineNodes.residency();
      this.tracker.unload(ref);
      this.held.chunks -= c.bytes - partBytes(c);
      this.held.derived -= partBytes(c);
      if (this.relief !== null) this.relief.bytes -= reliefPartBytes(c);
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

  private enforceBudget(): void {
    const tables = this.opts.source.memoryBytes();
    // Relief keeps to its own share: its ring shrinks, the world's chunks are never evicted for it.
    this.relief?.fit(this.budgetBytes);
    const budget = this.budgetBytes - (this.relief?.share(this.budgetBytes) ?? 0);
    // The overlay counts but is never evicted: it is the game's changes, not a copy of the files.
    // Mip nodes count too; they leave with the chunks under them. The kit meshes stay as long as the kits do.
    let total = this.held.chunks + this.held.derived - (this.relief?.bytes ?? 0) + this.held.overlay + tables + (this.mips?.bytes ?? 0) + this.pieces.gpuBytes;
    if (total <= budget) {
      if (total < budget * RESUME_BELOW && this.horizon !== Infinity) {
        this.horizon = Infinity;
        this.cursor = 0;
      }
      return;
    }
    const candidates = [...this.chunks.values()].filter((c) => c.phase === 'resident' && this.tracker.canUnload(jobRef(this, c)));
    candidates.sort((a, b) => b.d2 - a.d2 || a.wantedTick - b.wantedTick);
    for (const c of candidates) {
      if (total <= budget * EVICT_TO) break;
      const bytes = c.bytes - reliefPartBytes(c);
      const mips = this.mips?.bytes ?? 0;
      if (!this.drop(c, true)) continue;
      total -= bytes + mips - (this.mips?.bytes ?? 0);
      this.horizon = Math.min(this.horizon, c.d2);
    }
    if (total > budget) this.counters.overBudgetTicks++;
  }

  private requestLoads(): void {
    const batch = this.opts.readBatch ?? 64;
    const maxReads = this.opts.maxReads ?? DEFAULT_STREAM_READS;
    // Most chunks read are air or uniform and need no worker: reads go on while the pool has room for what waits.
    while (this.reads < maxReads && loadRoom(this.opts.pool, this.collision?.waiting === true) > this.plan.held.length && this.cursor < this.wanted.length) {
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
      if (r.kind === 'damaged') {
        c.phase = 'damaged';
        this.counters.damaged++;
        this.emit({ type: 'damaged', cx: c.cx, cy: c.cy, cz: c.cz, reason: r.reason });
        return;
      }
      if (r.kind !== 'stored') {
        this.land(c, r.kind === 'air' ? { form: 'air' } : { form: 'uniform', value: r.value }, null);
        return;
      }
      const stored: StoredChunk = { stored: r.bytes.slice(), raw: r.raw };
      if (this.plan.held.length > 0 || loadRoom(this.opts.pool, this.collision?.waiting === true) <= 0) {
        this.plan.held.push({ c, stored });
        return;
      }
      this.decode(c, stored);
    });
  }

  /** Sends a read stored chunk to a worker to decode. */
  private decode(c: Chunk, stored: StoredChunk): void {
    const job = this.tracker.beginJob(jobRef(this, c));
    c.phase = 'decoding';
    c.job = job.id;
    const id = job.id;
    const input: LoadInput = { edge: this.grid.edge, chunk: { grid: this.gridId, cx: c.cx, cy: c.cy, cz: c.cz }, bytes: stored, hash: false };
    const transfer = 'stored' in stored ? [stored.stored.buffer as ArrayBuffer] : [];
    void this.opts.pool.submit<LoadOutput>({ id, kind: 'load', lane: laneOf(this.plan, this.focus, c.cx, c.cz), distance: motionDistance2(this.grid, this.focus, this.plan.lead, c.cx, c.cy, c.cz), input, transfer }).then((o) => {
      if (o.status === 'done') {
        this.decompressUs.add(o.output.decompressUs);
        this.decodeUs.add(o.output.decodeUs);
      }
      this.onLoaded(c, id, o, (out) => ({ payload: out.payload, hash: out.hash }));
    });
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
    // A restored save's entry is in the overlay before anything reads the chunk.
    const restored = this.restoring.take(c.key);
    if (restored !== undefined) {
      hash = this.restoreInto(restored, 0);
      this.held.overlay = this.overlay.memoryBytes() + this.restoring.bytes;
    }
    c.phase = 'resident';
    c.job = 0;
    c.hash = hash;
    c.bytes = this.store.chunkBytes(c.cx, c.cy, c.cz) + RESIDENT_CHUNK_OVERHEAD_BYTES;
    this.held.chunks += c.bytes;
    this.counters.loads++;
    if (payload.form === 'stored') this.counters.loadsStored++;
    else if (payload.form === 'uniform') this.counters.loadsUniform++;
    else this.counters.loadsAir++;
    const at = this.unloadedAt.get(c.key);
    if (at !== undefined && performance.now() - at <= CHURN_WINDOW_MS) this.counters.reloads++;
    this.tracker.loaded(jobRef(this, c));
    this.derives?.chunkLanded(c.cx, c.cy, c.cz);
    this.mips?.chunkLanded(c.cx, c.cy, c.cz);
    this.far?.fineNodes.residency();
    this.emit({ type: 'loaded', cx: c.cx, cy: c.cy, cz: c.cz });
  }

  /**
   * After an edit changed `changed` in the overlay: move their input stamps
   * (jobs reading them are stale; they do not become dirty, the base is
   * unchanged), recount the overlay, and rebuild what the changed fields
   * feed in the edit's group: the shader data alone of the sections within
   * the shader border of `box` when only material or wetness changed (and
   * the sections holding `box` whole when the paint moved cells to another
   * kit's pieces), else every section within R of `box`. The jobs go out at once (an edit is
   * waited on), and the group swaps when all are back.
   */
  private afterEdit(changed: readonly ChunkCoord[], box: CellBox, parts: number): number {
    for (const ch of changed) this.tracker.invalidated(jobRef(this, ch));
    this.held.overlay = this.overlay.memoryBytes();
    const d = this.derives;
    if (d === null) return 0;
    const group = d.newGroup();
    if (changed.length > 0) {
      d.invalidate(box, 'edit', parts, group);
      this.mips?.changed(changed, box, group);
      this.far?.fineNodes.changed(changed);
    }
    d.request(this.opts.deriveMsPerUpdate ?? 2, true);
    // The drawn nodes the edit changed swap with it: their rebuilds go out now, in the edit lane.
    this.mips?.advanceEdits();
    d.settleGroup(group);
    return group;
  }

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
    const outcome = applyEdit({ store: (g) => (g === this.gridId ? this.overlay : undefined) }, cmd, { stamps: resolve, loaded: (g, cx, cy, cz) => g === this.gridId && this.isResident(cx, cy, cz) });
    const group = this.afterEdit(outcome.chunks, editBounds(this.grid, cmd, resolve), this.pieces.feeds(fieldsFeed(outcome.fields), outcome.materialSwaps));
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
    for (const t of touched) if (cmd.grid !== this.gridId || !this.isResident(t.cx, t.cy, t.cz)) throw new EditRefused('chunk_not_loaded', `chunk (${t.cx}, ${t.cy}, ${t.cz}) of grid ${cmd.grid} is not loaded`);
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
    const group = this.afterEdit(changed, editBounds(this.grid, cmd, resolve), this.pieces.feeds(fieldsFeed(o.output.fields), o.output.materialSwaps));
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
   * box (or of the refreshed chunks) and nothing else. `materialSwaps`
   * (the edit's `EditOutcome.materialSwaps`) tell a shader-only change that
   * keeps every kit piece (wetness, a paint within one kit) from one moving
   * cells to another kit's, which derives the sections holding them whole;
   * without them, while a kit binds a material, a shader-only change counts
   * as the latter.
   *
   * Returns the refresh's edit group: what it rebuilds swaps in together,
   * once every resident chunk named has landed again (the `swap` event
   * naming it; 0 when the streamer derives nothing).
   */
  refresh(chunks: readonly ChunkCoord[], box?: CellBox, parts: number = ALL_DERIVED_PARTS, materialSwaps?: readonly number[]): number {
    parts = this.pieces.feeds(parts, materialSwaps);
    this.opts.source.invalidate?.(chunks);
    this.far?.refresh(chunks);
    const list: Chunk[] = [];
    const token = ++this.refreshes.seq;
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
    this.refreshes.live++;
    void this.opts.pool.submit<LoadOutput>({ id: job.id, kind: 'load', lane: 'edit', distance: c.d2, input, transfer: [stored.buffer as ArrayBuffer] }).then((o) => {
      this.refreshes.live--;
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
    const bytes = this.store.chunkBytes(c.cx, c.cy, c.cz) + RESIDENT_CHUNK_OVERHEAD_BYTES + partBytes(c);
    this.held.chunks += bytes - c.bytes;
    c.bytes = bytes;
    this.tracker.loaded(ref);
    this.counters.refreshed++;
    const s = this.grid.shift;
    const parts = c.refreshParts;
    c.refreshParts = 0;
    const given = c.refreshBox;
    c.refreshBox = null;
    const box = given ?? { minX: c.cx << s, minY: c.cy << s, minZ: c.cz << s, maxX: ((c.cx + 1) << s) - 1, maxY: ((c.cy + 1) << s) - 1, maxZ: ((c.cz + 1) << s) - 1 };
    // The nodes join the refresh's group before its sections can swap.
    this.mips?.changed([c], box, this.derives?.refreshGroup(c.cx, c.cy, c.cz) ?? undefined);
    this.far?.fineNodes.changed([c]);
    this.derives?.contentLanded(c.cx, c.cy, c.cz, box, parts);
    this.emit({ type: 'loaded', cx: c.cx, cy: c.cy, cz: c.cz });
  }

  /**
   * Drops every runtime edit (the game quit, or loads another save) and
   * rebuilds what they changed around the resident chunks in one group,
   * which it returns (0: nothing to rebuild, or the streamer derives
   * nothing). Reads see the base at once. `settle` false leaves the group
   * open for more (a restore's entries).
   */
  clearOverlay(settle = true): number {
    const group = this.derives?.newGroup() ?? 0;
    for (const c of this.overlay.changedChunks()) if (this.isResident(c.cx, c.cy, c.cz)) this.rebuildOverrides(c, group);
    this.overlay.clear();
    this.restoring.clear();
    this.held.overlay = 0;
    if (settle) this.settleRebuild(group);
    return group;
  }

  /** Invalidates a resident chunk's jobs and rebuilds, in `group`, the sections around the cells it overrides (bounded by them, as for an edit). */
  private rebuildOverrides(c: ChunkCoord, group: number): void {
    const o = this.overlay.chunkOverrides(c.cx, c.cy, c.cz);
    if (o === null) return;
    this.tracker.invalidated(jobRef(this, c));
    const g = this.grid;
    const s = g.shift;
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
    this.derives?.invalidate(box, 'edit', ALL_DERIVED_PARTS, group);
    this.mips?.changed([c], box, group);
    this.far?.fineNodes.changed([c]);
  }

  private settleRebuild(group: number): void {
    const d = this.derives;
    if (d === null) return;
    d.request(this.opts.deriveMsPerUpdate ?? 2, true);
    this.mips?.advanceEdits();
    d.settleGroup(group);
  }

  /**
   * The save entries of the runtime edits (save-file.ts): each chunk with
   * overrides against its base as the world's files hold it, keeping the
   * fields in `saved` (a PLANE_BIT mask; default material, role and shape:
   * wetness is not saved). A chunk whose kept fields equal the base gives
   * no entry. Chunks unloaded since they were edited are read from the
   * source again for their base; the entries are then taken in one task, so
   * no edit lands half in a save. Refused (rejects) when such a base cannot
   * be read. A restored save's entries whose chunks have not loaded since
   * are kept as they were restored (their base hash is the one they were
   * made against).
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
    out.push(...this.restoring.entries());
    return out;
  }
}

/** Bytes of a chunk's relief parts (its sections' relief meshes and their draw). */
function reliefPartBytes(c: Chunk): number {
  let n = 0;
  if (c.parts !== null) for (const [name, b] of c.parts) if (StreamRelief.isPart(name)) n += b;
  return n;
}

/** Bytes of a chunk's derived parts. */
function partBytes(c: Chunk): number {
  let n = 0;
  if (c.parts !== null) for (const b of c.parts.values()) n += b;
  return n;
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


/**
 * Fine far bricks on or off (far-fine.ts), without a reload: on, the far field draws levels 0–1 past the detail ring
 * from the streamer's chunks and the near field draws only its level-0 ring (no level 1 or 2 is derived or drawn);
 * off, the near field's rings are as they were. A streamer without a far field draws none; one given its own mip
 * rings has the load ring's again.
 */
export function setFineBricks(streamer: VoxelStreamer, on: boolean): void {
  const far = streamer.far;
  if (far === null) return;
  far.setView({ fine: on });
  // Only where the far field draws them (the bricks mode with the chunks at hand) does the near field give its rings up.
  setNearOnly(streamer, far.fineNodes.wanted);
}

/**
 * The near field as fine far bricks leave it (true) or with every ring (false): near only, the level choice draws the
 * level-0 ring alone, the coarser levels do no work at all (no downsample, derive or node kept), and level 0 is
 * derived only within the detail ring's reach of a focus; the load ring still reads every chunk the far field's fine
 * nodes are built from. Off, the levels are rebuilt from the resident chunks and level 0 is derived ring-wide again.
 */
export function setNearOnly(streamer: VoxelStreamer, on: boolean): void {
  const mips = streamer.mips;
  streamer.detail.setReach(on && mips !== null ? (cx, cy, cz) => mips.lod.inDetailReach(cx, cy, cz) : null);
  mips?.lod.setNearOnly(on);
  mips?.setDormant(on);
}

/** A cell read to tell a uniform chunk's value (the fine host's `holds`). */
const fineProbe: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

/** Whether the near field draws a chunk now: a drawn level covers it (without levels: `resident`). */
function nearDrawn(mips: StreamMips | null, cx: number, cy: number, cz: number, resident: () => boolean): boolean {
  if (mips === null) return resident();
  const d = mips.lod.drawn;
  for (let l = 0; l <= mips.maxLevel; l++) if (d.drawn(l, cx >> l, cy >> l, cz >> l)) return true;
  return false;
}

/** The lane a chunk column's load and derive go in: near round the focus and along the way read ahead of it at speed. */
function laneOf(plan: Pick<StreamReadPlan<unknown>, 'near'>, focus: Focus, cx: number, cz: number): JobLane {
  return plan.near(focus, cx, cz) ? 'near' : 'far';
}
