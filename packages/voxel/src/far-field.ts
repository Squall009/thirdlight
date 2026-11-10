/**
 * The far field: the far tree's nodes (far-tree.ts) drawn past the near
 * rings over the whole world, read from the world's far cache and made in
 * the stream's workers as voxel-mip meshes (far-mesh.ts) or as distance
 * bricks a draw ray marches (far-bricks.ts), the selection and its swaps
 * the same for both.
 *
 * - **Where it runs.** Beside the world's streamer, with its pool (far jobs
 *   go last, in the `mip` lane, a few at a time so they never fill the
 *   queue the near field needs) and the far cache as its source (region
 *   files of the world's format a level, read by range in Play and the
 *   editor, whole in an export).
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
import type { ChunkCoord, ChunkGrid, RegionFootprint } from './coords';
import { FAR_BRICK_BUILD, farBricksBytes, type FarBrickBuild, type FarBricks } from './far-bricks';
import { farMeshBytes, farNeighbourIndex, type FarMesh, type FarMeshInput } from './far-mesh';
import { FAR_BUDGET_BYTES, FAR_ERROR_PIXELS, farAncestors, FarNodeIndex, FarSelection, type FarDrawn } from './far-tree';
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

/** The range a level's far field error may take (pixels). */
export const FAR_ERROR_PIXELS_RANGE = Object.freeze({ min: 0.5, max: 16 });

/** Pixels a radian of the view the far field selects for when the host gives none: 720 rows at a 60° vertical field of view. */
export const FAR_VIEW_PIXELS_PER_RADIAN = 720 / (2 * Math.tan(Math.PI / 6));

/** Cells the eye moves before the far selection runs again (8 m): the error a node makes changes by a few per cent over it. */
export const FAR_RESELECT_CELLS = 16;

/** Far mesh jobs in the pool at once: the near field's jobs keep the queue. */
export const FAR_JOBS_IN_FLIGHT = 8;

/** Added to a far job's queue distance (squared cells), past any near job's in the same lane. */
const FAR_JOB_DISTANCE_OFFSET = 2 ** 52;

/** ms a far field waits after the pool sent a job back unrun before it sends again. */
const FAR_RETRY_MS = 100;

/** Queue places far jobs leave free in the pool for the near field's. */
const FAR_POOL_ROOM_KEPT = 64;

/** Todo entries one pump looks through (the rest wait for the next). */
const FAR_PUMP_SCAN = 512;

/** ms meshes that land are gathered before they go in together (one walk of the selection for all of them). */
export const FAR_COMMIT_MS = 250;

/** Nodes whose neighbourhoods one read gathers (the files' runs read together). */
export const FAR_READ_BATCH = 64;

/** Stored node bytes the far field keeps read (what the meshes' aprons read again), least recently used dropped first. */
export const FAR_ENTRY_CACHE_BYTES = 16 * 1024 * 1024;

/** One kept level of a far cache: its region files (sorted names). */
export interface FarCacheLevelFiles {
  readonly level: number;
  readonly regions: readonly string[];
}

/** Where a far field reads the far cache's nodes. */
export interface FarNodeSource {
  readonly grid: ChunkGrid;
  readonly minLevel: number;
  readonly maxLevel: number;
  /** Every kept node that holds anything, with its stored bytes. */
  index(): Promise<FarNodeIndex>;
  /** Nodes of one level as stored (one result each, in the order asked). */
  read(level: number, nodes: readonly ChunkCoord[]): Promise<RegionChunkRead[]>;
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
  /** A level's region file by name (null: not listed, all air). */
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
  for (const l of o.levels) {
    const names = new Set(l.regions);
    listed.set(l.level, names);
    sources.set(l.level, new RegionChunkSource({ worldId: o.worldId, gridId: WORLD_GRID_ID, grid: o.grid, layout: 'stacked', footprint: o.footprint, maxOpen: o.maxOpen, open: (name) => (names.has(name) ? o.open(l.level, name) : null) }));
  }
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
  /** The latest selection, by node key. */
  private target = new Map<string, FarDrawn>();
  /** Nodes drawn now (null mesh: drawn as nothing, a node of air surfaces). */
  private readonly shown = new Map<string, MipNode>();
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
  /** Target nodes to mesh, nearest first, and how far {@link pump} got through them. */
  private todo: FarDrawn[] | null = null;
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
  /** Selection ms and mesh worker µs. */
  readonly selectMs = new SampleRing();
  readonly meshUs = new SampleRing();
  readonly counters = { selections: 0, meshes: 0, events: 0, reads: 0, edits: 0, triangles: 0, bricks: 0 };
  /** GPU bytes of the far draws, as the page reports them. */
  gpuBytes = 0;

  constructor(
    private readonly opts: FarFieldOptions,
    private readonly host: FarFieldHost,
  ) {
    opts.source.index().then(
      (idx) => {
        this.index = idx;
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

  /** Where the far field is looked at from (world cells). */
  setEye(x: number, y: number, z: number): void {
    this.eye = [x, y, z];
    const at = this.selectedAt;
    if (at === null || Math.hypot(x - at[0], y - at[1], z - at[2]) >= FAR_RESELECT_CELLS) this.reselect = true;
  }

  /** The selection's settings changed (a quality level): selects again. */
  setView(o: Pick<FarFieldOptions, 'enabled' | 'errorPixels' | 'budgetBytes' | 'pixelsPerRadian' | 'draw'>): void {
    const drawWas = this.opts.draw ?? 'mesh';
    Object.assign(this.opts as { -readonly [K in keyof FarFieldOptions]: FarFieldOptions[K] }, o);
    if ((this.opts.draw ?? 'mesh') !== drawWas) this.remakeAll();
    this.reselect = true;
    this.update();
  }

  /** Every node is made again (the draw kind changed): each drawn one stays until its new draw replaces it. */
  private remakeAll(): void {
    for (const key of new Set([...this.shown.keys(), ...this.target.keys(), ...this.jobs.keys()])) {
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

  /** How bricks are made (one build: {@link FAR_BRICK_BUILD}). */
  get brickBuild(): FarBrickBuild {
    return FAR_BRICK_BUILD;
  }

  /**
   * The nodes a node's job reads: itself and its 26 neighbours, and for bricks
   * built from finer cells the block of descendants that many levels down
   * covering it and one of theirs round it (none below the lowest kept level).
   */
  private reads(n: MipNode): MipNode[] {
    const out: MipNode[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) out.push({ level: n.level, nx: n.nx + dx, ny: n.ny + dy, nz: n.nz + dz });
    const f = this.fineOf(n);
    if (f !== null) for (const m of f.nodes) out.push(m);
    return out;
  }

  /** The finer nodes a brick job of `n` reads (null: it reads its own level only). */
  private fineOf(n: MipNode): { level: number; scale: number; nodes: MipNode[] } | null {
    const b = this.brickBuild;
    if (this.draw !== 'bricks' || b.scale <= 1 || this.index === null) return null;
    const down = Math.log2(b.scale);
    const level = n.level - down;
    if (level < this.index.minLevel) return null;
    const S = b.scale;
    const nodes: MipNode[] = [];
    for (let dx = -1; dx <= S; dx++) for (let dz = -1; dz <= S; dz++) for (let dy = -1; dy <= S; dy++) nodes.push({ level, nx: n.nx * S + dx, ny: n.ny * S + dy, nz: n.nz * S + dz });
    return { level, scale: S, nodes };
  }

  /** Selects again if the eye moved far enough, and starts the meshes the selection needs. */
  update(): void {
    if (this.closed || this.index === null) return;
    if (this.reselect) {
      this.reselect = false;
      this.selectedAt = [...this.eye];
      const t0 = performance.now();
      const sel = this.opts.enabled === false ? null : this.selection.select(this.index, { eye: this.eye, pixelsPerRadian: this.opts.pixelsPerRadian ?? FAR_VIEW_PIXELS_PER_RADIAN, errorPixels: this.opts.errorPixels ?? FAR_ERROR_PIXELS, budgetBytes: this.opts.budgetBytes ?? FAR_BUDGET_BYTES, near: null });
      this.selectMs.add(performance.now() - t0);
      this.counters.selections++;
      this.target = new Map((sel?.drawn ?? []).map((d) => [mipNodeKey(d.node), d]));
      for (const [key, j] of this.jobs) {
        if (this.target.has(key)) continue;
        this.host.pool.cancel(j.id);
        this.jobs.delete(key);
      }
      for (const key of [...this.ready.keys()]) if (!this.target.has(key)) this.ready.delete(key);
      this.todo = null;
      this.commitSoon();
    }
    void this.pump();
  }

  /** Puts in what is ready a little later, once for everything that lands meanwhile (a commit walks the whole selection). */
  private commitSoon(): void {
    if (this.commitTimer !== null || this.closed) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      if (!this.closed) this.commit();
    }, FAR_COMMIT_MS);
  }

  /** The target nodes still to mesh, nearest first (made again after a selection or an edit). */
  private todoList(): FarDrawn[] {
    if (this.todo === null) {
      const list: FarDrawn[] = [];
      for (const [key, d] of this.target) if (this.needs(key)) list.push(d);
      list.sort((a, b) => a.distance - b.distance);
      this.todo = list;
      this.cursor = 0;
    }
    return this.todo;
  }

  /** Whether a target node needs a mesh it does not have yet. */
  private needs(key: string): boolean {
    return this.target.has(key) && (!this.shown.has(key) || this.stale.has(key)) && !this.ready.has(key);
  }

  /** Nodes still to mesh before what is drawn is the selection. */
  get pending(): number {
    let n = 0;
    for (const key of this.target.keys()) if ((!this.shown.has(key) || this.stale.has(key)) && !this.ready.has(key)) n++;
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
    return this.index !== null && !this.reselect && !this.waitUpdate && this.rereads === 0 && !this.reading && this.jobs.size === 0 && this.commitTimer === null && this.pending === 0;
  }

  private wake(): void {
    if (!this.idle) return;
    for (const w of this.waiters.splice(0)) w();
  }

  /**
   * Starts mesh jobs for target nodes without one, nearest first, a few at
   * a time; their neighbourhoods are read ahead in batches of
   * {@link FAR_READ_BATCH} nodes (one coalesced request a file run), so
   * reading never waits on one node at a time.
   */
  private async pump(): Promise<void> {
    if (this.closed || this.index === null || this.waitUpdate) return;
    const todo = this.todoList();
    while (this.cursor < todo.length && !this.needs(mipNodeKey(todo[this.cursor]!.node))) this.cursor++;
    if (this.cursor >= todo.length && this.jobs.size === 0) return this.wake();
    // The pool's queue is shared: far jobs leave the near field room in it.
    let room = Math.min(FAR_JOBS_IN_FLIGHT - this.jobs.size, this.host.pool.room() - FAR_POOL_ROOM_KEPT);
    const unread: MipNode[] = [];
    for (let i = this.cursor, seen = 0; i < todo.length && seen < FAR_PUMP_SCAN && (room > 0 || unread.length < FAR_READ_BATCH); i++, seen++) {
      const n = todo[i]!.node;
      const key = mipNodeKey(n);
      if (!this.needs(key) || this.jobs.has(key)) continue;
      if (this.neighbourhoodRead(n)) {
        if (room > 0) {
          this.submit(n);
          room--;
        }
      } else if (unread.length < FAR_READ_BATCH) unread.push(n);
    }
    if (this.reading || unread.length === 0) return;
    this.reading = true;
    try {
      await this.readNeighbourhoods(unread);
    } catch (e) {
      this.failed = e instanceof Error ? e.message : String(e);
      this.reading = false;
      this.wake();
      return;
    }
    this.reading = false;
    if (!this.closed) void this.pump();
  }

  /** Whether a node's 27 cells are read (a mesh job can be sent). */
  private neighbourhoodRead(n: MipNode): boolean {
    for (const m of this.reads(n)) if (!this.entries.has(mipNodeKey(m)) && this.index!.has(m)) return false;
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
        if (!this.index!.has(m)) {
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
    const cells: Array<StoredChunk | null> = new Array<StoredChunk | null>(27).fill(null);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const c = this.cellsOf({ level: n.level, nx: n.nx + dx, ny: n.ny + dy, nz: n.nz + dz });
      // A copy: the stored bytes stay here for the neighbours' meshes while the job takes its own across.
      cells[farNeighbourIndex(dx, dy, dz)] = c === null ? null : 'uniform' in c ? c : { stored: c.stored.slice(), raw: c.raw };
    }
    const f = this.fineOf(n);
    const fine = f === null ? undefined : { level: f.level, scale: f.scale, cells: f.nodes.map((m) => copyCells(this.cellsOf(m))) };
    const build = this.draw === 'bricks' ? this.brickBuild : undefined;
    const input: FarMeshInput = { edge: this.host.grid.edge, level: n.level, node: [n.nx, n.ny, n.nz], cells, rules: rulesRef(this.host.rules), ...(build !== undefined ? { build } : {}), ...(fine !== undefined ? { fine } : {}) };
    const transfer: ArrayBuffer[] = [];
    for (const c of [...cells, ...(fine?.cells ?? [])]) if (c !== null && 'stored' in c) transfer.push(c.stored.buffer as ArrayBuffer);
    const id = this.nextId--;
    const stamp = this.stamps.get(key) ?? 0;
    this.jobs.set(key, { id, stamp });
    const d = this.target.get(key);
    // After every near job of the lane (theirs count squared cells from the focus): the far field never holds the near field back.
    const distance = FAR_JOB_DISTANCE_OFFSET + (d?.distance ?? 0) ** 2;
    const kind = this.draw;
    void this.host.pool.submit<FarMesh | FarBricks>({ id, kind: kind === 'bricks' ? 'far-bricks' : 'far-mesh', lane: 'mip', distance, input, transfer }).then((o) => this.meshed(n, key, id, stamp, kind, o));
  }

  private meshed(n: MipNode, key: string, id: number, stamp: number, kind: FarDrawKind, o: JobOutcome<FarMesh | FarBricks>): void {
    const j = this.jobs.get(key);
    if (j === undefined || j.id !== id) return;
    this.jobs.delete(key);
    if (this.closed) return;
    if (o.status !== 'done') {
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
    this.meshUs.add(o.workerUs);
    this.counters.meshes++;
    if (kind === 'bricks') {
      const b = o.output as FarBricks;
      this.ready.set(key, { made: b.samples.length === 0 ? null : { bricks: b } });
    } else {
      const m = o.output as FarMesh;
      this.ready.set(key, { made: m.indices.length === 0 ? null : { mesh: m } });
    }
    this.commitSoon();
    void this.pump();
  }

  /** The drawn level-and-node ancestor (or self) of a node in `set`, walking up. */
  private ancestorIn(set: ReadonlyMap<string, unknown>, n: MipNode, self: boolean): string | null {
    const top = this.index?.maxLevel ?? n.level;
    for (let l = self ? n.level : n.level + 1; l <= top; l++) {
      const d = l - n.level;
      const key = mipNodeKey({ level: l, nx: n.nx >> d, ny: n.ny >> d, nz: n.nz >> d });
      if (set.has(key)) return key;
    }
    return null;
  }

  /** Puts in every group of changes whose new nodes are all meshed, and takes out what they replace. */
  private commit(): void {
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
      const a = this.ancestorIn(this.shown, d.node, false);
      if (a !== null) join(key, a);
    }
    const gone: string[] = [];
    for (const [key, n] of this.shown) {
      if (this.target.has(key)) continue;
      gone.push(key);
      find(key);
      const a = this.ancestorIn(this.target, n, false);
      if (a !== null) join(key, a);
    }
    const blocked = new Set<string>();
    for (const key of fresh) if (!this.ready.has(key)) blocked.add(find(key));
    const added: FarNodeDraw[] = [];
    const removed: MipNode[] = [];
    for (const key of gone) {
      if (blocked.has(find(key))) continue;
      const n = this.shown.get(key)!;
      this.shown.delete(key);
      removed.push(n);
    }
    for (const key of fresh) {
      if (blocked.has(find(key))) continue;
      this.show(key, added);
    }
    // Nodes an edit made stale: replaced alone (their place is drawn either way).
    for (const key of [...this.stale]) {
      if (!this.shown.has(key) || !this.target.has(key)) {
        if (!this.target.has(key)) this.stale.delete(key);
        continue;
      }
      if (!this.ready.has(key)) continue;
      this.stale.delete(key);
      removed.push(this.shown.get(key)!);
      this.shown.delete(key);
      this.show(key, added);
    }
    if (added.length > 0 || removed.length > 0) {
      this.counters.events++;
      const e: FarEvent = { type: 'far', added, removed };
      for (const l of this.listeners) l(e);
    }
    this.wake();
  }

  private show(key: string, added: FarNodeDraw[]): void {
    const d = this.target.get(key)!;
    const r = this.ready.get(key)!;
    this.ready.delete(key);
    this.shown.set(key, d.node);
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
  metrics(): { draw: FarDrawKind; nodes: number; drawn: number; pending: number; jobs: number; entryBytes: number; sourceBytes: number; selectMs: { p50: number; p95: number }; meshUs: { p50: number; p95: number }; problem: string | null; counters: FarField['counters']; index: number[] | null } {
    return {
      draw: this.draw,
      nodes: this.target.size,
      drawn: this.shown.size,
      pending: this.pending,
      jobs: this.jobs.size,
      entryBytes: this.entryBytes,
      sourceBytes: this.opts.source.memoryBytes(),
      selectMs: { p50: this.selectMs.quantile(0.5), p95: this.selectMs.quantile(0.95) },
      meshUs: { p50: this.meshUs.quantile(0.5), p95: this.meshUs.quantile(0.95) },
      problem: this.failed,
      counters: { ...this.counters },
      index: this.index?.counts() ?? null,
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

/** A node's stored cells as a job's own copy (the stored bytes stay here for the jobs that read them again). */
function copyCells(c: StoredChunk | null): StoredChunk | null {
  return c === null ? null : 'uniform' in c ? c : { stored: c.stored.slice(), raw: c.raw };
}

/** Bytes of the meshes and bricks in a far event. */
export function farEventBytes(e: Pick<FarEvent, 'added'>): number {
  let n = 0;
  for (const a of e.added) n += (a.mesh !== undefined ? farMeshBytes(a.mesh) : 0) + (a.bricks !== undefined ? farBricksBytes(a.bricks) : 0);
  return n;
}
