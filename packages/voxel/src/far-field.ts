/**
 * The far field: the far tree's nodes (far-tree.ts) drawn past the near
 * rings over the whole world, read from the world's far cache and made in
 * the stream's workers as voxel-mip meshes (far-mesh.ts) or as distance
 * bricks a draw ray marches (far-bricks.ts), the selection and its swaps
 * the same for both.
 *
 * - **Where it runs.** Beside the world's streamer, with its pool (far jobs
 *   are the pool's background jobs, a few at a time: the near field's go
 *   first, yet a share of the workers stays the far field's, so it follows
 *   the eye during a fast flight too) and the far cache as its source
 *   (region files of the world's format a level, read by range in Play and
 *   the editor, whole in an export).
 * - **Order.** Nodes are made where the error drawn now is largest (nothing
 *   yet, then a coarse stand-in, then over-fine nodes behind the eye), and
 *   put in by the same order, whole groups up to a byte budget a commit, so
 *   the page's uploads between two frames stay small. The selection runs in
 *   slices of a couple of milliseconds.
 * - **What is drawn.** The selection by screen error ({@link FarSelection},
 *   from the stream focus) over every node the cache keeps: nothing is cut
 *   off at any distance. The near field is not left out of the selection:
 *   the far field draws under the near field everywhere and the draw hides
 *   it where the near field is drawn (by chunk), so a chunk the near field
 *   has not drawn yet still shows its far stand-in, never a hole.
 * - **Changes swap whole.** A node replacing others (a parent closing over
 *   its children, children opening a parent) goes in with their removal
 *   in one event once every new node of the group is meshed: the old
 *   nodes are drawn until then, so no area is drawn twice or not at all.
 * - **Edits.** When the world's files change (`refresh`, after the backend
 *   rebuilt the cache's ancestors of the changed chunks), those ancestors
 *   are read again and they and their neighbours (whose meshes read them)
 *   are meshed again and replaced each alone.
 */
import { rulesRef, type AssemblyRuleSet } from './assembly';
import { DISTANCE_BRICK_SAMPLES } from './distance-brick-format';
import { VOXEL_SIZE_M, type ChunkCoord, type ChunkGrid, type RegionFootprint } from './coords';
import { FAR_BRICK_BUILD, farBricksBytes, type FarBricks } from './far-bricks';
import { farBrickDirty, farBrickJobCells, farFineOf } from './far-bricks-baked';
import { farBricksGpuBytes } from './far-bricks-shade';
import { FarGpuLedger } from './far-gpu-ledger';
import { FAR_SEEN_RELEASE_SHARE, FAR_SEEN_RESELECT_MS, FAR_SEEN_TURN_MS, FAR_UNSEEN_ERROR_SCALE, FarSeenLog, type FarSeenWire } from './far-seen';
import { farMeshBytes, farNeighbourIndex, type FarMesh, type FarMeshInput } from './far-mesh';
import { FAR_BUDGET_BYTES, FAR_ERROR_PIXELS, farAncestors, farCellPixels, farNodeBox, farNodeDistance, FarNodeIndex, FarSelection, type FarDrawn, type FarSelected } from './far-tree';
import { parseRegionFileName, REGION_ENTRY_BYTES, WORLD_GRID_ID, type RegionByteSource, type RegionChunkRead } from './region-file';
import { RegionChunkSource } from './region-source';
import type { StoredChunk } from './stream-job';
import { mipNodeKey, type MipNode } from './voxel-mips';
import { SampleRing, type JobOutcome, type WorkerPool } from './worker-pool';

/**
 * How a voxel world is drawn past its near rings: `mesh` (the far tree's
 * nodes meshed from their voxel mips), `bricks` (the same nodes as distance
 * bricks, ray marched) or `off` (nothing past the load ring). Bricks are
 * the far field (the owner's chosen direction, held at the cap on the floor
 * GPU); meshes stay as the fallback a level or a page can switch to.
 */
export const FAR_FIELD_MODES = Object.freeze(['off', 'mesh', 'bricks'] as const);
export type FarFieldMode = (typeof FAR_FIELD_MODES)[number];

/** What a far node is made as: a mesh or bricks. */
export type FarDrawKind = Exclude<FarFieldMode, 'off'>;

/** A far field mode as the far field's view settings: on or off, and what its nodes are made as. */
export function farViewOf(mode: FarFieldMode): { readonly enabled: boolean; readonly draw?: FarDrawKind } {
  return mode === 'off' ? { enabled: false } : { enabled: true, draw: mode };
}

/** The far field mode each tier draws when a level leaves it out. */
export const FAR_FIELD_BY_TIER: Readonly<Record<'low' | 'medium' | 'high', FarFieldMode>> = Object.freeze({ low: 'bricks', medium: 'bricks', high: 'bricks' });

/** The on-screen error (pixels) a far node's cell may make at each tier (more nodes, sharper horizons, higher up). */
export const FAR_ERROR_PIXELS_BY_TIER: Readonly<Record<'low' | 'medium' | 'high', number>> = Object.freeze({ low: 8, medium: 4, high: 3 });

/**
 * GPU bytes each tier's far field may hold in the nodes it draws (bricks: their atlas regions and brick tables;
 * meshes: their buffers). The selection opens nodes by screen error, largest first, while they fit, so the budget is
 * a bound, not a target: on the 8 km test world low draws 50–85 MiB at its error and is never cut, medium ~155 MiB
 * at the town and high ~255 MiB. Sized inside the low tier's memory budget (`LOW_MEMORY_BUDGET_MIB` in
 * project-model); no tier holds less than low (medium and high are not measured on their own hardware yet).
 */
export const FAR_GPU_BUDGET_BYTES_BY_TIER: Readonly<Record<'low' | 'medium' | 'high', number>> = Object.freeze({ low: 384 * 2 ** 20, medium: 384 * 2 ** 20, high: 384 * 2 ** 20 });

/** Selections a far field makes again for one eye when what came in was over its GPU budget. */
const FAR_OVER_BUDGET_RESELECTS = 3;

/** The range a level's far field error may take (pixels). */
export const FAR_ERROR_PIXELS_RANGE = Object.freeze({ min: 0.5, max: 16 });

/** Pixels a radian of the view the far field selects for when the host gives none: 720 rows at a 60° vertical field of view. */
export const FAR_VIEW_PIXELS_PER_RADIAN = 720 / (2 * Math.tan(Math.PI / 6));

/** Cells the eye moves before the far selection runs again (8 m): the error a node makes changes by a few per cent over it. */
export const FAR_RESELECT_CELLS = 16;

/** Far mesh jobs in the pool at once: the near field's jobs keep the queue. */
export const FAR_JOBS_IN_FLIGHT = 8;

/** ms of selection one task runs before the rest waits for a later task. */
export const FAR_SELECT_SLICE_MS = 2;

/** ms a far field waits after the pool sent a job back unrun before it sends again. */
const FAR_RETRY_MS = 100;


/** ms between pumps an update asks for when nothing came back meanwhile (a job, a read): the pool's room is all that changed. */
const FAR_PUMP_MS = 50;

/** Nodes remembered as read before the memory is cleared (each is read again when next wanted). */
const FAR_READ_DONE_KEPT = 8192;

/** Todo entries one pump looks through (the rest wait for the next). */
const FAR_PUMP_SCAN = 512;

/** ms meshes that land are gathered before they go in together (one walk of the selection for all of them). */
export const FAR_COMMIT_MS = 250;

/**
 * Bytes of made nodes one commit puts in (whole groups; at least one): what the page uploads between two frames
 * stays a small part of a frame (bricks ~3.6 kB of GPU texels a brick, ~1 kB of them sent), the rest goes in
 * {@link FAR_COMMIT_AGAIN_MS} later.
 */
export const FAR_COMMIT_BYTES = 1024 * 1024;

/** ms to the next commit when one was cut at {@link FAR_COMMIT_BYTES}. */
export const FAR_COMMIT_AGAIN_MS = 50;

/** Nodes whose neighbourhoods one read gathers (the files' runs read together). */
export const FAR_READ_BATCH = 64;

/** Stored node bytes the far field keeps read (what the meshes' aprons read again), least recently used dropped first. */
export const FAR_ENTRY_CACHE_BYTES = 16 * 1024 * 1024;

/** One kept level of a far cache: its region files (sorted names). */
export interface FarCacheLevelFiles {
  readonly level: number;
  readonly regions: readonly string[];
}

/**
 * A far source's reads at this level and past it name the baked bricks of
 * kept level `level − FAR_BAKED_LEVELS` (the far tree has at most
 * `FAR_MAX_LEVEL` levels, so the two never meet).
 */
export const FAR_BAKED_LEVELS = 64;

/** Where a far field reads the far cache's nodes. */
export interface FarNodeSource {
  readonly grid: ChunkGrid;
  readonly minLevel: number;
  readonly maxLevel: number;
  /** Every kept node that holds anything, with its stored bytes. */
  index(): Promise<FarNodeIndex>;
  /**
   * Nodes of one level as stored (one result each, in the order asked); a level of
   * {@link FAR_BAKED_LEVELS} and more reads that kept level's baked bricks.
   */
  read(level: number, nodes: readonly ChunkCoord[]): Promise<RegionChunkRead[]>;
  /** Whether the cache holds a kept level's bricks baked (absent or false: they are built here, from the nodes). */
  baked?(level: number): boolean;
  /** Forgets what it holds of these nodes' files (they were rewritten). */
  invalidate(level: number, nodes: readonly ChunkCoord[]): void;
  memoryBytes(): number;
}

export interface RegionFarSourceOptions {
  readonly worldId: Uint8Array;
  readonly grid: ChunkGrid;
  readonly footprint: RegionFootprint;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly levels: readonly FarCacheLevelFiles[];
  /** The kept levels whose bricks the cache holds baked, and their region files (none: built from the nodes). */
  readonly bricks?: readonly FarCacheLevelFiles[];
  /** A level's region file by name (null: not listed, all air); `level` past {@link FAR_BAKED_LEVELS}: a baked bricks file. */
  open(level: number, name: string): RegionByteSource | null;
  /** Region tables kept open a level. */
  readonly maxOpen: number;
}

/**
 * A far cache read through region files a level (the far cache stores a
 * level's nodes as chunks of the world's format, layout stacked): the index
 * from every listed file's table, nodes by range.
 */
export function regionFarSource(o: RegionFarSourceOptions): FarNodeSource {
  const sources = new Map<number, RegionChunkSource>();
  const listed = new Map<number, Set<string>>();
  const addLevel = (level: number, regions: readonly string[]): Set<string> => {
    const names = new Set(regions);
    sources.set(level, new RegionChunkSource({ worldId: o.worldId, gridId: WORLD_GRID_ID, grid: o.grid, layout: 'stacked', footprint: o.footprint, maxOpen: o.maxOpen, open: (name) => (names.has(name) ? o.open(level, name) : null) }));
    return names;
  };
  for (const l of o.levels) listed.set(l.level, addLevel(l.level, l.regions));
  for (const l of o.bricks ?? []) addLevel(FAR_BAKED_LEVELS + l.level, l.regions);
  const levelSource = (level: number): RegionChunkSource => {
    const s = sources.get(level);
    if (s === undefined) throw new RangeError(`far level ${level} is not kept`);
    return s;
  };
  return {
    grid: o.grid,
    minLevel: o.minLevel,
    maxLevel: o.maxLevel,
    async index(): Promise<FarNodeIndex> {
      const idx = new FarNodeIndex(o.grid, o.minLevel, o.maxLevel);
      const c = { cx: 0, cy: 0, cz: 0 };
      for (const [level, names] of listed) {
        const src = levelSource(level);
        await Promise.all(
          [...names].map(async (name) => {
            const at = parseRegionFileName('stacked', name);
            if (at === null) return;
            const t = await src.table(at.rx, at.ry, at.rz);
            if (t === null) return;
            for (let i = 0; i < t.size; i++) {
              t.coordOf(i, c);
              idx.add({ level, nx: c.cx, ny: c.cy, nz: c.cz }, t.storedBytes(i) + REGION_ENTRY_BYTES);
            }
          }),
        );
      }
      return idx;
    },
    read: (level, nodes) => levelSource(level).read(nodes),
    baked: (level) => sources.has(FAR_BAKED_LEVELS + level),
    invalidate: (level, nodes) => levelSource(level).invalidate(nodes),
    memoryBytes: () => {
      let n = 0;
      for (const s of sources.values()) n += s.memoryBytes();
      return n;
    },
  };
}

/** A far node's draw. */
export interface FarNodeDraw {
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Its mesh (the `mesh` mode) or its bricks (the `bricks` mode): exactly one is present. */
  readonly mesh?: FarMesh;
  readonly bricks?: FarBricks;
}

/** The far nodes drawn changed: these go in (a node again: its draw is replaced) and these go, between the same two frames. */
export interface FarEvent {
  readonly type: 'far';
  /** The event's number (1 up): a round of visibility feedback names the last one its frame drew ({@link FarSeenWire.farSeq}). */
  readonly seq: number;
  readonly added: readonly FarNodeDraw[];
  readonly removed: readonly MipNode[];
}

export interface FarFieldOptions {
  readonly source: FarNodeSource;
  /** Whether anything is drawn (default true): off, every far draw goes and nothing is read or meshed. */
  readonly enabled?: boolean;
  /** What nodes are made as (default `mesh`); a change makes every drawn node again, swapped in node by node. */
  readonly draw?: FarDrawKind;
  /** On-screen error a drawn node's cell may make (pixels; {@link FAR_ERROR_PIXELS}). */
  readonly errorPixels?: number;
  /** Pixels a radian of the view ({@link FAR_VIEW_PIXELS_PER_RADIAN}). */
  readonly pixelsPerRadian?: number;
  /** Stored bytes of the nodes drawn at once ({@link FAR_BUDGET_BYTES}). */
  readonly budgetBytes?: number;
  /** GPU bytes the drawn nodes may hold (default the medium tier's, {@link FAR_GPU_BUDGET_BYTES_BY_TIER}). */
  readonly gpuBudgetBytes?: number;
  /** ms an unseen node keeps its detail ({@link FAR_SEEN_TURN_MS}); feedback comes through {@link FarField.feedback}. */
  readonly seenTurnMs?: number;
}

/**
 * Where the near field draws: the cylinder round the focus it loads (cells: horizontal radius, vertical
 * half-height) and whether it draws a chunk now. A far node it draws every chunk of is hidden under it, so making
 * that node can wait; in a fast flight the near field draws little, and the far field there is all there is.
 */
export interface FarNearRing {
  readonly radius: number;
  readonly height: number;
  drawn(cx: number, cy: number, cz: number): boolean;
}

/**
 * Wanted nodes outside the near field's cylinder still drawn by a coarser stand-in: how many (`coarse`: two or more
 * levels coarser), the nearest of those (metres from the eye), and the largest error a stand-in makes in pixels
 * with the error its wanted node would make there.
 */
export interface FarStandIns {
  readonly pending: number;
  readonly coarse: number;
  readonly nearestCoarseM: number | null;
  readonly worstPx: number;
  readonly wantedPx: number;
}

/** What the far field takes from the world it draws for. */
export interface FarFieldHost {
  readonly grid: ChunkGrid;
  readonly pool: WorkerPool;
  readonly rules: AssemblyRuleSet;
}

interface Ready {
  /** Null: the node draws nothing. */
  readonly made: { readonly mesh?: FarMesh; readonly bricks?: FarBricks } | null;
  /** Its GPU bytes where it is drawn. */
  readonly gpu: number;
}

/** GPU bytes a made node holds where it is drawn. */
function madeGpuBytes(made: Ready['made']): number {
  return made === null ? 0 : (made.mesh !== undefined ? farMeshBytes(made.mesh) : 0) + (made.bricks !== undefined ? farBricksGpuBytes(made.bricks) : 0);
}

/**
 * One world's far field ({@link FarFieldOptions}); `update` after the
 * focus moves (`setEye`), `refresh` when the world's files changed.
 */
export class FarField {
  private index: FarNodeIndex | null = null;
  private failed: string | null = null;
  private readonly selection = new FarSelection();
  private eye: [number, number, number] = [0, 0, 0];
  private selectedAt: [number, number, number] | null = null;
  private reselect = true;
  /** The latest selection, by node key: what the far field draws once everything is made. */
  private wanted = new Map<string, FarDrawn>();
  /**
   * The nodes made and put in next on the way to {@link wanted}: a wanted node whose drawn stand-in is two or more
   * levels coarser is reached one level at a time (the stand-in's children first, then theirs), so a coarse node
   * gives way within a few jobs instead of waiting for every finer node under it.
   */
  private target = new Map<string, FarDrawn>();
  /** The near field's load cylinder (null: none known); nodes wholly inside it are made after the rest. */
  private near: FarNearRing | null = null;
  /** Nodes drawn now (null mesh: drawn as nothing, a node of air surfaces). */
  private readonly shown = new Map<string, MipNode>();
  /** The drawn and made nodes' GPU bytes, and the budget's bookkeeping. */
  private readonly gpu = new FarGpuLedger();
  /** Todo nodes that refine a drawn coarser node (more GPU bytes for detail); held while over the budget. */
  private refines = new Set<string>();
  /** Whether the drawn and made nodes were over the GPU budget when the todo was made. */
  private todoOver = false;
  /** Meshes made for target nodes, waiting for their group. */
  private readonly ready = new Map<string, Ready>();
  /** Nodes whose draw must be made again (an edit): replaced alone when ready. */
  private readonly stale = new Set<string>();
  private readonly jobs = new Map<string, { id: number; stamp: number }>();
  private readonly stamps = new Map<string, number>();
  /** Stored nodes read, least recently used first. */
  private readonly entries = new Map<string, { cells: StoredChunk | null; bytes: number }>();
  private entryBytes = 0;
  private reading = false;
  /** A selection under way ({@link selectStep}) and the ms it took so far. */
  private selecting: { readonly steps: Generator<void, FarSelected, void>; ms: number } | null = null;
  /** Nodes whose neighbourhoods were read (checked again when sent: the read cache may have dropped some). */
  private readonly readDone = new Set<string>();
  /** When the last pump ran (an update between events pumps at most every {@link FAR_PUMP_MS}). */
  private pumpedAt = -Infinity;
  /** Target nodes to mesh, nearest first, and how far {@link pump} got through them. */
  private todo: FarDrawn[] | null = null;
  /** Each todo node's place in the list (its job's order among the far field's). */
  private rank = new Map<string, number>();
  private cursor = 0;
  /** A job came back unrun (a busy pool): nothing is sent for {@link FAR_RETRY_MS}. */
  private waitUpdate = false;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Edits whose nodes are being read again. */
  private rereads = 0;
  private nextId = -1;
  private closed = false;
  private readonly listeners: Array<(e: FarEvent) => void> = [];
  private readonly waiters: Array<() => void> = [];
  /**
   * Selection ms and mesh worker µs; ms a far job waited in the pool's queue and a batch of neighbourhoods took to
   * read; ms the far field's own work took on the world's thread (a pump's scan, a commit's walk).
   */
  readonly samples = { selectMs: new SampleRing(), meshUs: new SampleRing(), queueMs: new SampleRing(), readMs: new SampleRing(), pumpMs: new SampleRing(), commitMs: new SampleRing() };
  readonly counters = { selections: 0, meshes: 0, events: 0, reads: 0, edits: 0, triangles: 0, bricks: 0, unrun: 0, swappedIn: 0, swappedOut: 0, commitsCut: 0, seenReselects: 0 };
  /** When (ms since the far field was made) its stages first happened: the index read, a job sent, a node drawn. */
  readonly firsts: { index: number | null; job: number | null; drawn: number | null } = { index: null, job: null, drawn: null };
  private readonly made = performance.now();
  /** GPU bytes of the far draws, as the page reports them. */
  gpuBytes = 0;
  /** What the draws reported seen (visibility feedback; none: every node counts as seen). */
  readonly seen: FarSeenLog;

  /**
   * What reads the far cache beside the far field (the coarse floor, far-ground.ts): its source, its index once
   * read (null before), and job ids of the far field's own id space.
   */
  readonly cache: { readonly source: FarNodeSource; index(): FarNodeIndex | null; jobId(): number };

  constructor(
    private readonly opts: FarFieldOptions,
    private readonly host: FarFieldHost,
  ) {
    this.cache = { source: opts.source, index: () => this.index, jobId: () => this.nextId-- };
    this.seen = new FarSeenLog(opts.seenTurnMs ?? FAR_SEEN_TURN_MS, opts.source.maxLevel);
    opts.source.index().then(
      (idx) => {
        this.index = idx;
        this.firsts.index = performance.now() - this.made;
        this.reselect = true;
        this.update();
      },
      (e: unknown) => {
        this.failed = e instanceof Error ? e.message : String(e);
        this.wake();
      },
    );
  }

  on(listener: (e: FarEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Why the far cache could not be read (null: it was, or is being read). */
  get problem(): string | null {
    return this.failed;
  }

  /** Where the far field is looked at from (world cells), and the near field's load cylinder round it. */
  setEye(x: number, y: number, z: number, near: FarNearRing | null = this.near): void {
    this.eye = [x, y, z];
    this.near = near;
    this.seen.near = near === null ? null : { eye: [x, y, z], radius: near.radius, height: near.height, edge: this.host.grid.edge };
    const at = this.selectedAt;
    if (at === null || Math.hypot(x - at[0], y - at[1], z - at[2]) >= FAR_RESELECT_CELLS) {
      this.reselect = true;
      this.gpu.overReselects = 0;
    }
  }

  /** The selection's settings changed (a quality level): selects again. */
  setView(o: Pick<FarFieldOptions, 'enabled' | 'errorPixels' | 'budgetBytes' | 'gpuBudgetBytes' | 'pixelsPerRadian' | 'draw'>): void {
    const drawWas = this.opts.draw ?? 'mesh';
    Object.assign(this.opts as { -readonly [K in keyof FarFieldOptions]: FarFieldOptions[K] }, o);
    this.gpu.overReselects = 0;
    if ((this.opts.draw ?? 'mesh') !== drawWas) this.remakeAll();
    this.reselect = true;
    this.update();
  }

  /** Every node is made again (the draw kind changed): each drawn one stays until its new draw replaces it. */
  private remakeAll(): void {
    for (const key of new Set([...this.shown.keys(), ...this.wanted.keys(), ...this.target.keys(), ...this.jobs.keys()])) {
      this.stamps.set(key, (this.stamps.get(key) ?? 0) + 1);
      if (this.shown.has(key)) this.stale.add(key);
    }
    for (const j of this.jobs.values()) this.host.pool.cancel(j.id);
    this.jobs.clear();
    this.ready.clear();
    this.todo = null;
  }

  /** What nodes are made as now. */
  get draw(): FarDrawKind {
    return this.opts.draw ?? 'mesh';
  }


  /**
   * The nodes a node's job reads: for bricks built from finer cells the block
   * of descendants that many levels down covering it and one of theirs round
   * it (the build reads nothing else), else (meshes, and bricks at the lowest
   * kept level) itself and its 26 neighbours.
   */
  private reads(n: MipNode): MipNode[] {
    const b = bakedRead(this.opts.source, this.draw, n);
    if (b !== null) return [b];
    const f = farFineOf(n, this.draw === 'bricks' ? FAR_BRICK_BUILD.scale : 1, this.index?.minLevel ?? Infinity);
    if (f !== null) return f.nodes;
    const out: MipNode[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) out.push({ level: n.level, nx: n.nx + dx, ny: n.ny + dy, nz: n.nz + dz });
    return out;
  }


  /** Selects again if the eye moved far enough, and starts the meshes the selection needs. */
  update(): void {
    if (this.closed || this.index === null) return;
    if (this.reselect && this.selecting === null) {
      this.reselect = false;
      this.selectedAt = [...this.eye];
      if (this.opts.enabled === false) this.selected(null);
      else {
        const gpuBytesOf = this.gpu.foresee();
        const at = (this.seen.selectingAt = performance.now());
        // Unseen nodes are released only near the GPU budget: below it they keep their detail and only wait behind.
        const unseen = this.seen.running(at) && this.liveGpu >= FAR_SEEN_RELEASE_SHARE * this.gpuBudget ? (n: MipNode) => this.seen.unseen(n, at) : undefined;
        this.selecting = { steps: this.selection.steps(this.index, { eye: this.eye, pixelsPerRadian: this.opts.pixelsPerRadian ?? FAR_VIEW_PIXELS_PER_RADIAN, errorPixels: this.opts.errorPixels ?? FAR_ERROR_PIXELS, budgetBytes: this.opts.budgetBytes ?? FAR_BUDGET_BYTES, gpuBudgetBytes: this.gpuBudget, gpuBytesOf, near: null, ...(unseen !== undefined ? { unseen, unseenScale: FAR_UNSEEN_ERROR_SCALE } : {}) }), ms: 0 };
        this.selectStep();
      }
      return;
    }
    // Between events (a job back, a read done, a selection) the pool's room is all that can change: looked at now and then.
    if (performance.now() - this.pumpedAt >= FAR_PUMP_MS) void this.pump();
  }

  /**
   * Runs the selection for at most {@link FAR_SELECT_SLICE_MS} and goes on in a later task until it is done (a
   * selection of thousands of nodes takes 10–30 ms: whole, it held the world's thread for frames at a time while the
   * eye moved). The drawn nodes and the jobs follow the last finished selection meanwhile.
   */
  private selectStep(): void {
    const s = this.selecting;
    if (s === null || this.closed) return;
    const t0 = performance.now();
    for (;;) {
      const r = s.steps.next();
      if (r.done === true) {
        s.ms += performance.now() - t0;
        this.samples.selectMs.add(s.ms);
        this.selecting = null;
        this.selected(r.value);
        // The eye moved on meanwhile: the next selection starts at the next update.
        return;
      }
      if (performance.now() - t0 >= FAR_SELECT_SLICE_MS) break;
    }
    s.ms += performance.now() - t0;
    setTimeout(() => this.selectStep(), 0);
  }

  /** A selection finished: it is the target; jobs for nodes it no longer holds go. */
  private selected(sel: FarSelected | null): void {
    this.counters.selections++;
    this.gpu.selected = sel?.gpuBytes ?? 0;
    this.gpu.held = sel?.heldByBudget ?? 0;
    this.wanted = new Map((sel?.drawn ?? []).map((d) => [mipNodeKey(d.node), d]));
    const at = this.seen.selectingAt;
    this.seen.selectedUnseen = new Set();
    if (this.seen.running(at) && this.liveGpu >= FAR_SEEN_RELEASE_SHARE * this.gpuBudget) for (const [key, d] of this.wanted) if (this.seen.unseen(d.node, at)) this.seen.selectedUnseen.add(key);
    this.restep();
    this.commitSoon();
    void this.pump();
  }

  /**
   * The next nodes toward the selection from what is drawn ({@link target}): a wanted node is made itself when it is
   * drawn, nothing is drawn over it, its stand-in is one level coarser, or the step between is not kept; else the
   * stand-in's child over it is made first. Jobs and made nodes no step needs go.
   */
  private restep(): void {
    const next = new Map<string, FarDrawn>();
    const ppr = this.opts.pixelsPerRadian ?? FAR_VIEW_PIXELS_PER_RADIAN;
    for (const [key, d] of this.wanted) {
      const a = this.shown.has(key) ? null : drawnAbove(this.shown, d.node, this.index?.maxLevel ?? d.node.level);
      if (a === null || a - d.node.level < 2 || this.index === null) {
        next.set(key, d);
        continue;
      }
      const up = a - 1 - d.node.level;
      const step: MipNode = { level: a - 1, nx: d.node.nx >> up, ny: d.node.ny >> up, nz: d.node.nz >> up };
      const sk = mipNodeKey(step);
      if (next.has(sk)) continue;
      if (!this.index.has(step)) {
        next.set(key, d);
        continue;
      }
      const distance = farNodeDistance(this.host.grid, step, this.eye);
      next.set(sk, { node: step, errorPixels: farCellPixels(step.level, distance, ppr), distance, bytes: this.index.bytesOf(step), nearOverlap: false });
    }
    this.target = next;
    for (const [key, j] of this.jobs) {
      if (this.target.has(key)) continue;
      this.host.pool.cancel(j.id);
      this.jobs.delete(key);
    }
    for (const key of [...this.ready.keys()]) if (!this.target.has(key)) this.ready.delete(key);
    this.todo = null;
  }


  /** GPU bytes the drawn nodes may hold. */
  get gpuBudget(): number {
    return this.opts.gpuBudgetBytes ?? FAR_GPU_BUDGET_BYTES_BY_TIER.medium;
  }

  /** GPU bytes of the drawn nodes and of those made and waiting to go in. */
  private get liveGpu(): number {
    let n = this.gpu.drawn;
    for (const r of this.ready.values()) n += r.gpu;
    return n;
  }

  /** Puts in what is ready a little later, once for everything that lands meanwhile (a commit walks the whole selection). */
  private commitSoon(ms = FAR_COMMIT_MS): void {
    if (this.commitTimer !== null || this.closed) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      if (!this.closed) this.commit();
    }, ms);
  }

  /**
   * The target nodes still to make, the largest error drawn in their place now first (made again after a
   * selection or an edit): where nothing is drawn yet, then where a coarse ancestor stands in (its cell's error
   * at the node's distance, in pixels), then where finer nodes are drawn than the selection wants (a node behind
   * the eye closing over its children: the threshold's worth, so it gives memory back before the small refinements;
   * over the GPU budget before every refinement); nearest first among equals. Nodes wholly inside the near field's
   * load cylinder go after all others: the near field draws over them once its chunks are in, so the far work goes
   * to the nodes round its edge first. With visibility feedback a stand-in seen lately counts by the error it was
   * seen at (its nearest pixel's), and nodes the eye has not met for a turn window go after the seen ones: what the
   * eye sees too coarse is refined first.
   */
  private todoList(): FarDrawn[] {
    if (this.todo === null) {
      const ppr = this.opts.pixelsPerRadian ?? FAR_VIEW_PIXELS_PER_RADIAN;
      const coarsen = this.opts.errorPixels ?? FAR_ERROR_PIXELS;
      const now = performance.now();
      const fed = this.seen.running(now);
      const list: Array<{ d: FarDrawn; error: number; hidden: boolean; unseen: boolean }> = [];
      // Over the GPU budget, nodes closing over finer ones go before refinements: they give memory back.
      const over = this.liveGpu > this.gpuBudget;
      this.todoOver = over;
      this.refines = new Set();
      for (const [key, d] of this.target) {
        if (!this.needs(key)) continue;
        let error: number;
        if (this.shown.has(key)) error = d.errorPixels;
        else {
          const a = drawnAbove(this.shown, d.node, this.index?.maxLevel ?? d.node.level);
          if (a !== null) {
            const cell = 2 ** a;
            const up = a - d.node.level;
            const seenPx = fed ? this.seen.seenError({ level: a, nx: d.node.nx >> up, ny: d.node.ny >> up, nz: d.node.nz >> up }, now, ppr) : null;
            error = seenPx ?? (cell * ppr) / Math.max(d.distance, cell);
            this.refines.add(key);
          } else error = childDrawn(this.shown, d.node) ? (over ? Number.MAX_VALUE : coarsen) : Infinity;
        }
        // Only refinements wait for the eye: nothing drawn in its place is a hole, and a node closing over finer ones
        // gives memory back (first over the budget).
        const unseen = fed && this.refines.has(key) && this.seen.unseen(d.node, now);
        list.push({ d, error, hidden: underNear(this.host.grid, d.node, this.eye, this.near), unseen });
      }
      list.sort((a, b) => Number(a.hidden) - Number(b.hidden) || Number(a.unseen) - Number(b.unseen) || b.error - a.error || a.d.distance - b.d.distance);
      this.todo = list.map((e) => e.d);
      this.rank = new Map(this.todo.map((d, i) => [mipNodeKey(d.node), i]));
      this.cursor = 0;
    }
    return this.todo;
  }

  /**
   * A round of visibility feedback from the draws ({@link FarSeenWire}; stale rounds are dropped). When it changes
   * which wanted nodes are unseen, the work's order is made again and, at most every {@link FAR_SEEN_RESELECT_MS},
   * the selection: what came into view refines, what left it for a turn window coarsens.
   */
  feedback(fb: FarSeenWire): void {
    if (this.closed || this.index === null) return;
    const now = performance.now();
    if (!this.seen.apply(fb, now, this.counters.events) || !this.seen.running(now)) return;
    let moved = false;
    for (const [key, d] of this.wanted) {
      if (this.seen.unseen(d.node, now) === this.seen.selectedUnseen.has(key)) continue;
      moved = true;
      break;
    }
    if (!moved) return;
    this.todo = null;
    // Below the release share a selection would draw the same nodes: only the order changes.
    if (this.liveGpu < FAR_SEEN_RELEASE_SHARE * this.gpuBudget && this.seen.selectedUnseen.size === 0) return;
    if (this.reselect || this.selecting !== null || now - this.seen.reselectedAt < FAR_SEEN_RESELECT_MS) return;
    this.seen.reselectedAt = now;
    this.counters.seenReselects++;
    this.reselect = true;
    setTimeout(() => this.update(), 0);
  }

  /** The next `count` nodes the far field makes, in its order (diagnostics and tests: where the work goes first). */
  next(count: number): MipNode[] {
    if (this.index === null) return [];
    const out: MipNode[] = [];
    for (const d of this.todoList()) {
      if (out.length >= count) break;
      if (this.needs(mipNodeKey(d.node))) out.push(d.node);
    }
    return out;
  }



  /** Whether a target node needs a mesh it does not have yet. */
  private needs(key: string): boolean {
    return this.target.has(key) && (!this.shown.has(key) || this.stale.has(key)) && !this.ready.has(key);
  }

  /** Nodes still to mesh before what is drawn is the selection. */
  get pending(): number {
    let n = 0;
    for (const key of this.target.keys()) if ((!this.shown.has(key) || this.stale.has(key)) && !this.ready.has(key)) n++;
    for (const key of this.wanted.keys()) if (!this.target.has(key)) n++;
    return n;
  }

  /** Resolves once the drawn nodes are the selection (or the far cache could not be read). */
  settle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((ok) => this.waiters.push(ok));
  }

  /** Nothing left to read, mesh or put in (or nothing can be: closed, or the cache failed). */
  private get idle(): boolean {
    if (this.closed || this.failed !== null) return true;
    return this.index !== null && !this.reselect && this.selecting === null && !this.waitUpdate && this.rereads === 0 && !this.reading && this.jobs.size === 0 && this.commitTimer === null && this.pending === 0;
  }

  private wake(): void {
    if (!this.idle) return;
    for (const w of this.waiters.splice(0)) w();
  }

  /**
   * Starts mesh jobs for target nodes without one, in the todo's order, a few at
   * a time; their neighbourhoods are read ahead in batches of
   * {@link FAR_READ_BATCH} nodes (one coalesced request a file run), so
   * reading never waits on one node at a time.
   */
  private async pump(): Promise<void> {
    if (this.closed || this.index === null || this.waitUpdate) return;
    const tp = performance.now();
    this.pumpedAt = tp;
    const todo = this.todoList();
    while (this.cursor < todo.length && !this.needs(mipNodeKey(todo[this.cursor]!.node))) this.cursor++;
    if (this.cursor >= todo.length && this.jobs.size === 0) return this.wake();
    // Background jobs: the near field's go first, yet a share of the workers is the far field's while it waits.
    let room = Math.min(FAR_JOBS_IN_FLIGHT - this.jobs.size, this.host.pool.backgroundRoom());
    // Over the GPU budget refinements wait while other jobs (nodes closing over finer ones first) are out: those give
    // memory back. With none out they go, so a far field over its budget with nothing to close still fills.
    const hold = this.jobs.size > 0 && this.liveGpu > this.gpuBudget;
    const unread: MipNode[] = [];
    // A node is looked at once a scan by key alone: whether its neighbourhood was read (or asked for) is remembered,
    // and its 27 + fine reads are checked again only when it is sent. A scan of every node's reads at every update
    // took the world's thread whole (10 ms a pump, ~90 pumps a second in Play).
    for (let i = this.cursor, seen = 0; i < todo.length && seen < FAR_PUMP_SCAN && (room > 0 || (!this.reading && unread.length < FAR_READ_BATCH)); i++, seen++) {
      const n = todo[i]!.node;
      const key = mipNodeKey(n);
      if (!this.needs(key) || this.jobs.has(key) || (hold && this.refines.has(key))) continue;
      if (this.readDone.has(key)) {
        if (room <= 0) continue;
        if (this.neighbourhoodRead(n)) {
          this.readDone.delete(key);
          this.submit(n);
          room--;
        } else this.readDone.delete(key);
      } else if (!this.reading && unread.length < FAR_READ_BATCH) unread.push(n);
    }
    this.samples.pumpMs.add(performance.now() - tp);
    if (this.reading || unread.length === 0) return;
    this.reading = true;
    const t0 = performance.now();
    try {
      await this.readNeighbourhoods(unread);
      this.samples.readMs.add(performance.now() - t0);
    } catch (e) {
      this.failed = e instanceof Error ? e.message : String(e);
      this.reading = false;
      this.wake();
      return;
    }
    if (this.readDone.size > FAR_READ_DONE_KEPT) this.readDone.clear();
    for (const n of unread) this.readDone.add(mipNodeKey(n));
    this.reading = false;
    if (!this.closed) void this.pump();
  }

  /** Whether a node's 27 cells are read (a mesh job can be sent). */
  private neighbourhoodRead(n: MipNode): boolean {
    for (const m of this.reads(n)) if (!this.entries.has(mipNodeKey(m)) && holdsRead(this.index!, m)) return false;
    return true;
  }

  /** Reads every stored node the batch's meshes need (each node and its 26 neighbours) that is not read yet. */
  private async readNeighbourhoods(nodes: readonly MipNode[]): Promise<void> {
    const byLevel = new Map<number, Map<string, ChunkCoord>>();
    for (const n of nodes) {
      for (const m of this.reads(n)) {
        const key = mipNodeKey(m);
        if (this.entries.has(key)) continue;
        let l = byLevel.get(m.level);
        if (l === undefined) byLevel.set(m.level, (l = new Map()));
        if (!holdsRead(this.index!, m)) {
          this.keep(key, null);
          continue;
        }
        l.set(key, { cx: m.nx, cy: m.ny, cz: m.nz });
      }
    }
    for (const [level, want] of byLevel) {
      if (want.size === 0) continue;
      const keys = [...want.keys()];
      const reads = await this.opts.source.read(level, [...want.values()]);
      this.counters.reads += reads.length;
      reads.forEach((r, i) => {
        if (r.kind === 'damaged') throw new Error(`far node ${keys[i]!}: ${r.reason}`);
        // A copy: a read's bytes may be a view of the whole range fetched for many nodes, which a kept view would hold.
        this.keep(keys[i]!, r.kind === 'air' ? null : r.kind === 'uniform' ? { uniform: r.value } : { stored: r.bytes.slice(), raw: r.raw });
      });
    }
  }

  private keep(key: string, cells: StoredChunk | null): void {
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.entries.delete(key);
      this.entryBytes -= old.bytes;
    }
    const bytes = cells !== null && 'stored' in cells ? cells.stored.byteLength + 16 : 16;
    this.entries.set(key, { cells, bytes });
    this.entryBytes += bytes;
    while (this.entryBytes > FAR_ENTRY_CACHE_BYTES && this.entries.size > 0) {
      const [k, e] = this.entries.entries().next().value!;
      this.entries.delete(k);
      this.entryBytes -= e.bytes;
    }
  }

  private cellsOf(n: MipNode): StoredChunk | null {
    const key = mipNodeKey(n);
    const e = this.entries.get(key);
    if (e === undefined) return null;
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.cells;
  }

  private submit(n: MipNode): void {
    const key = mipNodeKey(n);
    const baked = bakedRead(this.opts.source, this.draw, n);
    const rules = rulesRef(this.host.rules);
    const edge = this.host.grid.edge;
    // A copy of each entry: the stored bytes stay here for the neighbours' jobs while the job takes its own across.
    // Baked bricks are only decoded there; else the builder gets the cells the bake gave it (farBrickJobCells).
    const input: FarMeshInput =
      baked !== null
        ? { edge, level: n.level, node: [n.nx, n.ny, n.nz], cells: [], rules, baked: copyCells(this.cellsOf(baked)) }
        : this.draw === 'bricks'
          ? { edge, rules, ...farBrickJobCells(n, FAR_BRICK_BUILD, this.index?.minLevel ?? Infinity, (m) => copyCells(this.cellsOf(m))) }
          : { edge, rules, level: n.level, node: [n.nx, n.ny, n.nz], cells: farMeshCells(n, (m) => copyCells(this.cellsOf(m))) };
    const transfer: ArrayBuffer[] = [];
    for (const c of [...input.cells, ...(input.fine?.cells ?? []), ...(input.baked != null ? [input.baked] : [])]) if (c !== null && 'stored' in c) transfer.push(c.stored.buffer as ArrayBuffer);
    const id = this.nextId--;
    const stamp = this.stamps.get(key) ?? 0;
    this.jobs.set(key, { id, stamp });
    // Its place in the todo list (by the error drawn there now) orders it among the far field's jobs.
    const distance = this.rank.get(key) ?? 0;
    const kind = this.draw;
    this.firsts.job ??= performance.now() - this.made;
    void this.host.pool.submit<FarMesh | FarBricks>({ id, kind: kind === 'bricks' ? 'far-bricks' : 'far-mesh', lane: 'mip', distance, input, transfer, background: true }).then((o) => this.meshed(n, key, id, stamp, kind, o));
  }

  private meshed(n: MipNode, key: string, id: number, stamp: number, kind: FarDrawKind, o: JobOutcome<FarMesh | FarBricks>): void {
    const j = this.jobs.get(key);
    if (j === undefined || j.id !== id) return;
    this.jobs.delete(key);
    if (this.closed) return;
    if (o.status !== 'done') {
      if (o.status !== 'cancelled') this.counters.unrun++;
      // Cancelled with its node, or the pool was busy: the next pump asks again while the node is still wanted.
      if (o.status !== 'cancelled' && o.status !== 'queue_full' && o.status !== 'timeout' && o.status !== 'worker_lost') this.failed = `far node ${key}: ${o.status}${'message' in o ? `: ${o.message}` : ''}`;
      // Asked again at the next update, never in this task: a busy pool answers at once, and asking again at once
      // would never give the near field's work the thread back.
      this.todo = null;
      if (!this.waitUpdate) {
        this.waitUpdate = true;
        setTimeout(() => {
          this.waitUpdate = false;
          void this.pump();
        }, FAR_RETRY_MS);
      }
      return;
    }
    if ((this.stamps.get(key) ?? 0) !== stamp || !this.target.has(key)) {
      void this.pump();
      return;
    }
    this.samples.meshUs.add(o.workerUs);
    this.samples.queueMs.add(o.queueMs);
    this.counters.meshes++;
    let made: Ready['made'];
    if (kind === 'bricks') {
      const b = o.output as FarBricks;
      made = b.samples.length === 0 ? null : { bricks: b };
    } else {
      const m = o.output as FarMesh;
      made = m.indices.length === 0 ? null : { mesh: m };
    }
    const gpu = madeGpuBytes(made);
    this.ready.set(key, { made, gpu });
    // The foreseen bytes were off: the selection is made again with the made nodes' ratio.
    if (this.gpu.made(key, gpu, this.target.get(key)?.bytes ?? 0) && !this.reselect) {
      this.reselect = true;
      setTimeout(() => this.update(), 0);
    }
    this.commitSoon();
    void this.pump();
  }


  /** Puts in every group of changes whose new nodes are all meshed, and takes out what they replace. */
  private commit(): void {
    const tc = performance.now();
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
      parent.set(k, r);
      return r;
    };
    const join = (a: string, b: string): void => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const fresh: string[] = [];
    for (const [key, d] of this.target) {
      if (this.shown.has(key)) continue;
      fresh.push(key);
      find(key);
      const a = ancestorIn(this.shown, d.node, this.index?.maxLevel ?? d.node.level);
      if (a !== null) join(key, a);
    }
    const gone: string[] = [];
    for (const [key, n] of this.shown) {
      if (this.target.has(key)) continue;
      gone.push(key);
      find(key);
      const a = ancestorIn(this.target, n, this.index?.maxLevel ?? n.level);
      if (a !== null) join(key, a);
    }
    const blocked = new Set<string>();
    for (const key of fresh) if (!this.ready.has(key)) blocked.add(find(key));
    // The groups that can go in, in the todo's order (the largest error drawn first), up to the commit's bytes.
    const groups = new Map<string, { fresh: string[]; gone: string[]; rank: number; bytes: number }>();
    const groupOf = (key: string): { fresh: string[]; gone: string[]; rank: number; bytes: number } | null => {
      const root = find(key);
      if (blocked.has(root)) return null;
      let g = groups.get(root);
      if (g === undefined) groups.set(root, (g = { fresh: [], gone: [], rank: Infinity, bytes: 0 }));
      return g;
    };
    for (const key of fresh) {
      const g = groupOf(key);
      if (g === null) continue;
      g.fresh.push(key);
      g.rank = Math.min(g.rank, this.rank.get(key) ?? Infinity);
      g.bytes += readyBytes(this.ready.get(key)!);
    }
    for (const key of gone) groupOf(key)?.gone.push(key);
    const added: FarNodeDraw[] = [];
    const removed: MipNode[] = [];
    let bytes = 0;
    let cut = false;
    let moved = false;
    for (const g of [...groups.values()].sort((a, b) => a.rank - b.rank)) {
      if (bytes > 0 && bytes + g.bytes > FAR_COMMIT_BYTES) {
        cut = true;
        continue;
      }
      bytes += g.bytes;
      moved = true;
      for (const key of g.gone) {
        removed.push(this.shown.get(key)!);
        this.shown.delete(key);
        this.gpu.unshow(key);
      }
      for (const key of g.fresh) this.show(key, added);
    }
    // Nodes an edit made stale: replaced alone (their place is drawn either way).
    for (const key of [...this.stale]) {
      if (!this.shown.has(key) || !this.target.has(key)) {
        if (!this.target.has(key)) this.stale.delete(key);
        continue;
      }
      if (!this.ready.has(key)) continue;
      if (bytes > 0 && bytes + readyBytes(this.ready.get(key)!) > FAR_COMMIT_BYTES) {
        cut = true;
        continue;
      }
      bytes += readyBytes(this.ready.get(key)!);
      this.stale.delete(key);
      removed.push(this.shown.get(key)!);
      this.shown.delete(key);
      this.gpu.unshow(key);
      this.show(key, added);
    }
    if (added.length > 0 || removed.length > 0) {
      this.counters.events++;
      this.counters.swappedIn += added.length;
      this.counters.swappedOut += removed.length;
      this.firsts.drawn ??= performance.now() - this.made;
      const e: FarEvent = { type: 'far', seq: this.counters.events, added, removed };
      for (const l of this.listeners) l(e);
    }
    // What is drawn moved toward the selection: the next steps are made from it.
    if (moved) this.restep();
    this.samples.commitMs.add(performance.now() - tc);
    // Over the budget or back under it: the todo's order changes (nodes closing over finer ones first, or not).
    if (this.liveGpu > this.gpuBudget !== this.todoOver) this.todo = null;
    // All in, yet over the budget: the selection foresaw nodes it had not made smaller than they came. It selects
    // again with the drawn nodes' own bytes (a few times at most before the eye moves on).
    if (this.gpu.drawn > this.gpuBudget && this.ready.size === 0 && this.jobs.size === 0 && !this.reselect && this.selecting === null && this.gpu.overReselects < FAR_OVER_BUDGET_RESELECTS && [...this.wanted.keys()].every((k) => this.shown.has(k))) {
      this.gpu.overReselects++;
      this.reselect = true;
      setTimeout(() => this.update(), 0);
    }
    if (cut) {
      this.counters.commitsCut++;
      this.commitSoon(FAR_COMMIT_AGAIN_MS);
    }
    if (moved) void this.pump();
    this.wake();
  }

  private show(key: string, added: FarNodeDraw[]): void {
    const d = this.target.get(key)!;
    const r = this.ready.get(key)!;
    this.ready.delete(key);
    this.shown.set(key, d.node);
    this.gpu.show(key, r.gpu);
    if (r.made !== null) {
      if (r.made.mesh !== undefined) this.counters.triangles += r.made.mesh.indices.length / 3;
      if (r.made.bricks !== undefined) this.counters.bricks += r.made.bricks.samples.length / DISTANCE_BRICK_SAMPLES;
      added.push({ level: d.node.level, nx: d.node.nx, ny: d.node.ny, nz: d.node.nz, ...r.made });
    }
  }

  /**
   * The world's files changed at these chunks (the far cache rebuilt their
   * ancestors with them): the ancestors are read again, and every drawn or
   * wanted node whose mesh reads one is meshed again.
   */
  refresh(chunks: readonly ChunkCoord[]): void {
    // Before the index is read there is nothing drawn to change: the index is read after the change.
    if (this.closed || chunks.length === 0 || this.index === null) return;
    const src = this.opts.source;
    const ancestors = farAncestors(chunks, src.minLevel, src.maxLevel);
    this.counters.edits++;
    const byLevel = new Map<number, ChunkCoord[]>();
    for (const a of ancestors) {
      const l = byLevel.get(a.level) ?? [];
      l.push({ cx: a.nx, cy: a.ny, cz: a.nz });
      byLevel.set(a.level, l);
    }
    for (const [level, nodes] of byLevel) src.invalidate(level, nodes);
    // Baked bricks the edit made stale (the backend baked them again with the rebuild): read again when sent. Their
    // drawn nodes are made again below with the ancestors' neighbours, which hold every one of them.
    if (this.draw === 'bricks' && src.baked !== undefined) {
      const dirty = farBrickDirty(chunks, this.host.grid.edge, FAR_BRICK_BUILD, src.minLevel, src.maxLevel).filter((n) => src.baked!(n.level));
      const bakedByLevel = new Map<number, ChunkCoord[]>();
      for (const n of dirty) {
        const b = { level: FAR_BAKED_LEVELS + n.level, nx: n.nx, ny: n.ny, nz: n.nz };
        const old = this.entries.get(mipNodeKey(b));
        if (old !== undefined) {
          this.entries.delete(mipNodeKey(b));
          this.entryBytes -= old.bytes;
        }
        bakedByLevel.set(b.level, [...(bakedByLevel.get(b.level) ?? []), { cx: n.nx, cy: n.ny, cz: n.nz }]);
      }
      for (const [level, nodes] of bakedByLevel) src.invalidate(level, nodes);
    }
    this.rereads++;
    this.reread(ancestors).then(
      () => {
        this.rereads--;
        this.update();
      },
      (e: unknown) => {
        this.rereads--;
        this.failed = e instanceof Error ? e.message : String(e);
        this.wake();
      },
    );
  }

  private async reread(ancestors: readonly MipNode[]): Promise<void> {
    if (this.index === null) return;
    for (const a of ancestors) {
      const key = mipNodeKey(a);
      const old = this.entries.get(key);
      if (old !== undefined) {
        this.entries.delete(key);
        this.entryBytes -= old.bytes;
      }
    }
    const byLevel = new Map<number, MipNode[]>();
    for (const a of ancestors) byLevel.set(a.level, [...(byLevel.get(a.level) ?? []), a]);
    for (const [level, nodes] of byLevel) {
      const reads = await this.opts.source.read(level, nodes.map((n) => ({ cx: n.nx, cy: n.ny, cz: n.nz })));
      reads.forEach((r, i) => {
        const n = nodes[i]!;
        const key = mipNodeKey(n);
        const cells: StoredChunk | null = r.kind === 'stored' ? { stored: r.bytes.slice(), raw: r.raw } : r.kind === 'uniform' ? { uniform: r.value } : null;
        this.keep(key, cells);
        if (cells === null) this.index!.remove(n);
        else this.index!.add(n, ('stored' in cells ? cells.stored.byteLength : 0) + REGION_ENTRY_BYTES);
      });
    }
    for (const a of ancestors) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const key = mipNodeKey({ level: a.level, nx: a.nx + dx, ny: a.ny + dy, nz: a.nz + dz });
        if (!this.shown.has(key) && !this.target.has(key)) continue;
        this.stamps.set(key, (this.stamps.get(key) ?? 0) + 1);
        this.ready.delete(key);
        const j = this.jobs.get(key);
        if (j !== undefined) {
          this.host.pool.cancel(j.id);
          this.jobs.delete(key);
        }
        if (this.shown.has(key)) this.stale.add(key);
      }
    }
    this.todo = null;
    this.reselect = true;
  }

  /** What the far field holds and draws. */
  metrics(): { draw: FarDrawKind; nodes: number; drawn: number; pending: number; jobs: number; entryBytes: number; sourceBytes: number; selectMs: { p50: number; p95: number }; meshUs: { p50: number; p95: number }; queueMs: { p50: number; p95: number }; readMs: { p50: number; p95: number; n: number }; pumpMs: { p50: number; p95: number; n: number; sum: number }; commitMs: { p50: number; p95: number; n: number }; firsts: FarField['firsts']; problem: string | null; counters: FarField['counters']; gpu: { budget: number; drawn: number; live: number; selected: number; held: number; reselects: number; perStored: number }; standIns: FarStandIns; index: number[] | null; seen: FarSeenLog['counters'] & { unseenWanted: number; turnMs: number } } {
    return {
      draw: this.draw,
      nodes: this.wanted.size,
      drawn: this.shown.size,
      pending: this.pending,
      jobs: this.jobs.size,
      entryBytes: this.entryBytes,
      sourceBytes: this.opts.source.memoryBytes(),
      selectMs: { p50: this.samples.selectMs.quantile(0.5), p95: this.samples.selectMs.quantile(0.95) },
      meshUs: { p50: this.samples.meshUs.quantile(0.5), p95: this.samples.meshUs.quantile(0.95) },
      queueMs: { p50: this.samples.queueMs.quantile(0.5), p95: this.samples.queueMs.quantile(0.95) },
      readMs: { p50: this.samples.readMs.quantile(0.5), p95: this.samples.readMs.quantile(0.95), n: this.samples.readMs.count },
      pumpMs: { p50: this.samples.pumpMs.quantile(0.5), p95: this.samples.pumpMs.quantile(0.95), n: this.samples.pumpMs.count, sum: sumOf(this.samples.pumpMs) },
      commitMs: { p50: this.samples.commitMs.quantile(0.5), p95: this.samples.commitMs.quantile(0.95), n: this.samples.commitMs.count },
      firsts: { ...this.firsts },
      problem: this.failed,
      counters: { ...this.counters },
      gpu: { budget: this.gpuBudget, drawn: this.gpu.drawn, live: this.liveGpu, selected: this.gpu.selected, held: this.gpu.held, reselects: this.gpu.overReselects, perStored: this.gpu.ratio },
      standIns: farStandIns(this.wanted, this.shown, this.index?.maxLevel ?? 0, this.opts.pixelsPerRadian ?? FAR_VIEW_PIXELS_PER_RADIAN, (n) => underNear(this.host.grid, n, this.eye, this.near)),
      index: this.index?.counts() ?? null,
      seen: { ...this.seen.counters, unseenWanted: this.seen.selectedUnseen.size, turnMs: this.seen.turnMs },
    };
  }


  /** Bytes the far field holds where the world runs (its read nodes and the source's tables). */
  get bytes(): number {
    return this.entryBytes + this.opts.source.memoryBytes();
  }

  close(): void {
    this.closed = true;
    if (this.commitTimer !== null) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    for (const j of this.jobs.values()) this.host.pool.cancel(j.id);
    this.jobs.clear();
    this.ready.clear();
    this.entries.clear();
    for (const w of this.waiters.splice(0)) w();
  }
}


/** The key of a node's nearest ancestor in `set` (null: none), walking up to level `top`. */
function ancestorIn(set: ReadonlyMap<string, unknown>, n: MipNode, top: number): string | null {
  for (let l = n.level + 1; l <= top; l++) {
    const d = l - n.level;
    const key = mipNodeKey({ level: l, nx: n.nx >> d, ny: n.ny >> d, nz: n.nz >> d });
    if (set.has(key)) return key;
  }
  return null;
}

/** The level of the drawn node over `n` (null: none is drawn over it). */
function drawnAbove(shown: ReadonlyMap<string, MipNode>, n: MipNode, top: number): number | null {
  for (let l = n.level + 1; l <= top; l++) {
    const d = l - n.level;
    if (shown.has(mipNodeKey({ level: l, nx: n.nx >> d, ny: n.ny >> d, nz: n.nz >> d }))) return l;
  }
  return null;
}

/** Whether one of `n`'s children is drawn (the node closes over finer ones). */
function childDrawn(shown: ReadonlyMap<string, MipNode>, n: MipNode): boolean {
  for (let i = 0; i < 8; i++) if (shown.has(mipNodeKey({ level: n.level - 1, nx: n.nx * 2 + (i & 1), ny: n.ny * 2 + ((i >> 1) & 1), nz: n.nz * 2 + (i >> 2) }))) return true;
  return false;
}

/** Whether the near field draws every chunk of a node now (it lies inside its load cylinder round the eye). */
function underNear(grid: ChunkGrid, n: MipNode, eye: readonly [number, number, number], r: FarNearRing | null): boolean {
  if (r === null) return false;
  const b = farNodeBox(grid, n);
  const [ex, ey, ez] = eye;
  if (b.min[1] < ey - r.height || b.max[1] > ey + r.height) return false;
  const dx = Math.max(Math.abs(b.min[0] - ex), Math.abs(b.max[0] - ex));
  const dz = Math.max(Math.abs(b.min[2] - ez), Math.abs(b.max[2] - ez));
  if (dx * dx + dz * dz > r.radius * r.radius) return false;
  const side = 1 << n.level;
  const x0 = n.nx * side, y0 = n.ny * side, z0 = n.nz * side;
  for (let x = x0; x < x0 + side; x++) for (let y = y0; y < y0 + side; y++) for (let z = z0; z < z0 + side; z++) if (!r.drawn(x, y, z)) return false;
  return true;
}

/** How much coarser than the selection the far field is drawn now outside the near field ({@link FarStandIns}). */
function farStandIns(wanted: ReadonlyMap<string, FarDrawn>, shown: ReadonlyMap<string, MipNode>, top: number, ppr: number, hidden: (n: MipNode) => boolean): FarStandIns {
  const out = { pending: 0, coarse: 0, nearestCoarseM: null as number | null, worstPx: 0, wantedPx: 0 };
  for (const [key, d] of wanted) {
    if (shown.has(key) || hidden(d.node)) continue;
    const a = drawnAbove(shown, d.node, top);
    if (a === null) continue;
    out.pending++;
    const px = farCellPixels(a, d.distance, ppr);
    if (px > out.worstPx) {
      out.worstPx = px;
      out.wantedPx = d.errorPixels;
    }
    if (a - d.node.level < 2) continue;
    out.coarse++;
    const m = d.distance * VOXEL_SIZE_M;
    if (out.nearestCoarseM === null || m < out.nearestCoarseM) out.nearestCoarseM = m;
  }
  return out;
}

/** Bytes of a made node (what its event carries). */
function readyBytes(r: Ready): number {
  return r.made === null ? 0 : (r.made.mesh !== undefined ? farMeshBytes(r.made.mesh) : 0) + (r.made.bricks !== undefined ? farBricksBytes(r.made.bricks) : 0);
}

/** The kept samples' sum. */
function sumOf(r: SampleRing): number {
  let n = 0;
  for (const v of r.sorted()) n += v;
  return n;
}

/** A node's stored cells as a job's own copy (the stored bytes stay here for the jobs that read them again). */
/** A brick node's baked entry (a read at {@link FAR_BAKED_LEVELS} past its level), when the cache holds it baked. */
function bakedRead(source: FarNodeSource, draw: FarDrawKind, n: MipNode): MipNode | null {
  return draw === 'bricks' && source.baked?.(n.level) === true ? { level: FAR_BAKED_LEVELS + n.level, nx: n.nx, ny: n.ny, nz: n.nz } : null;
}

/** Whether a read node holds anything (a baked entry: whether its node does). */
function holdsRead(index: FarNodeIndex, m: MipNode): boolean {
  return index.has(m.level >= FAR_BAKED_LEVELS ? { level: m.level - FAR_BAKED_LEVELS, nx: m.nx, ny: m.ny, nz: m.nz } : m);
}

/** A mesh job's cells: the node and its 26 neighbours (index {@link farNeighbourIndex}). */
function farMeshCells(n: MipNode, cellsOf: (m: MipNode) => StoredChunk | null): Array<StoredChunk | null> {
  const cells = new Array<StoredChunk | null>(27).fill(null);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) cells[farNeighbourIndex(dx, dy, dz)] = cellsOf({ level: n.level, nx: n.nx + dx, ny: n.ny + dy, nz: n.nz + dz });
  return cells;
}

function copyCells(c: StoredChunk | null): StoredChunk | null {
  return c === null ? null : 'uniform' in c ? c : { stored: c.stored.slice(), raw: c.raw };
}

/** Bytes of the meshes and bricks in a far event. */
export function farEventBytes(e: Pick<FarEvent, 'added'>): number {
  let n = 0;
  for (const a of e.added) n += (a.mesh !== undefined ? farMeshBytes(a.mesh) : 0) + (a.bricks !== undefined ? farBricksBytes(a.bricks) : 0);
  return n;
}
