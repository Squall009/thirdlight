/**
 * The chunk tree's coarser levels at runtime (voxel-mips.ts): nodes of
 * levels 1 … N built in workers from the resident level-0 chunks, never
 * read from or written to a file (mips are derived data).
 *
 * - **Cells.** A node's cells are the downsample of its 8 children (`mip`
 *   jobs): at level 1 the resident chunks as the game sees them (the
 *   runtime overlay over the base), above it the level below's nodes. A
 *   child not known yet (not resident; a node below not complete) counts
 *   as air, and the node records which octants it was built from: it is
 *   **complete** when all 8 were known. Cells are kept per level in a store
 *   of chunk-shaped nodes, for every node over resident chunks (the next
 *   level up and the neighbours' aprons read them).
 * - **Derive.** A complete node within its level's ring is derived like a
 *   chunk (`derive` jobs with a `level`): its cells and an apron of the
 *   same level's nodes, the same rules and mesher. The apron reads only the
 *   cells within the rules' radius of the node, which lie in the octants of
 *   each neighbour facing it, so a node derives once those octants are
 *   known, without waiting for whole neighbours; a node over chunks not all
 *   resident is not derived (never drawn from guessed cells).
 * - **Staleness.** A change of level-0 cells (an edit, a refreshed or
 *   restored chunk, a chunk landing or leaving) marks every ancestor of the
 *   changed chunks stale ({@link MipStaleSet}: rebuilt lowest level first,
 *   a parent once its children are settled), and moves the derive stamp of
 *   the nodes within the rules' radius of the change at each level, so an
 *   edit re-derives its ancestors and only the neighbours its cells reach.
 *   A job's result is kept only while its node's stamp is the one it was
 *   sent with.
 * - **Order.** Mip jobs go in the `mip` lane, after every level-0 job (an
 *   edit's rebuilds, then near and far work), nearest first; an edit's own
 *   go in the `edit` lane, the drawn nodes' ahead of its level-0 rebuilds.
 * - **Edits swap whole.** Every node an edit makes stale that is shown
 *   (drawn, or read by a seam drawn) joins the edit's group (the level-0
 *   group's id; a shown node meeting another open group merges the two).
 *   Their new results are held, and the old ones drawn, until every shown
 *   node of the group has its new result and the seams reading them or the
 *   edit's chunks are rebuilt from them; then they go in with the level-0
 *   group's swap, in its task (named in its report). Nodes not shown join
 *   no group: they go in alone as they land (nothing draws them), so edits
 *   that meet only under coarse nodes nobody draws never hold each other's
 *   swap; their jobs still go in the edit lane.
 * - **Memory.** Node cells, derived results and bookkeeping are one part of
 *   the stream budget; a node whose chunks unload loses its result and,
 *   once none is left, its cells.
 * - **Seams and levels.** The seams between the levels drawn
 *   (stream-seams.ts) and the choice of which level is drawn where
 *   (stream-lod.ts) are kept here too: a node's new result goes in together
 *   with the seams rebuilt from it, a drawn node that loses its result
 *   leaves the levels drawn at once, and the seams' bytes are part of this
 *   budget share.
 */
import { apronTransfer, buildApron, dependentChunks } from './apron';
import { rulesRef, type AssemblyRuleSet } from './assembly';
import { payloadTransfer, type ChunkPayload } from './chunk-wire';
import { chunkInWorld, chunkKey, type ChunkCoord, type ChunkGrid } from './coords';
import { derivedBytes, type DerivedData } from './derived-data';
import { levelDrawsPieces } from './derived-mesh';
import type { PieceTable } from './piece-table';
import type { DirtyTracker } from './dirty-tracker';
import { createWorldStore, type PaletteStore } from './palette-store';
import type { CellBox } from './stroke';
import type { DeriveInput, DeriveOutput, MipInput, MipOutput } from './stream-job';
import type { SeamSurface } from './lod-seam';
import { DrawnLevels, levelNodeDistance, type LevelRings } from './lod-select';
import { MIP_RING_HYSTERESIS_CELLS, RESIDENT_CHUNK_OVERHEAD_BYTES, type Focus, type MipRing, type StreamRing } from './stream-ring';
import { StreamLod, type LevelEvent } from './stream-lod';
import { StreamSeams, type EditHold, type HeldNode, type SeamEvent, type SeamHold } from './stream-seams';
import { MipStaleSet, type MipNode } from './voxel-mips';
import { SampleRing, type JobOutcome, type WorkerPool } from './worker-pool';

/** A node's derived result changed (`removed`: it has none now). */
export interface MipEvent {
  readonly type: 'node';
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly removed: boolean;
}

/** What the mip levels need from the streamer that owns the chunks. */
export interface MipHost {
  readonly grid: ChunkGrid;
  readonly gridId: number;
  readonly pool: WorkerPool;
  readonly tracker: DirtyTracker;
  readonly rules: AssemblyRuleSet;
  /** The world's kit piece table (null: none, the default pieces). */
  pieceTable(): PieceTable | null;
  /** The rules' job radius (the apron depth at every level). */
  readonly radius: number;
  isResident(cx: number, cy: number, cz: number): boolean;
  /** A resident chunk as the game sees it, as a payload of its own arrays. */
  chunkPayload(cx: number, cy: number, cz: number): ChunkPayload;
  focus(): Focus;
  /** The load ring (the level choice covers its unload bounds). */
  readonly ring: StreamRing;
  /** A level-0 chunk's drawn derive-section surfaces near a plane, for the seams (undefined: one has no result yet). */
  chunkSurfaces(cx: number, cy: number, cz: number, axis: number, plane: number): SeamSurface[] | undefined;
  /** Whether every derive section of a resident chunk has a result (it can be drawn). */
  chunkReady(cx: number, cy: number, cz: number): boolean;
  emit(e: MipEvent | SeamEvent | LevelEvent): void;
  poke(): void;
}

interface Node extends MipNode {
  readonly key: number;
  /** Octants the stored cells were built from (bit o: child o was known); 0 before the first build. */
  built: number;
  cellJob: number;
  cellStamp: number;
  deriveJob: number;
  deriveStamp: number;
  /** The derived result is current (false: never derived, or an input changed since). */
  fresh: boolean;
  /** The newest derived result (null: none, or nothing to draw). */
  derived: DerivedData | null;
  /** A new result waiting for the seams reading it (it goes in with them). */
  held: SeamHold | null;
  /** The open edit group the node is to swap with (null: none). */
  group: MipGroup | null;
  /** A new result waiting for its edit group's swap (undefined: none; null: nothing to draw). */
  groupHeld: DerivedData | null | undefined;
  /** An edit changed it while nothing showed it: its jobs go in the edit lane, but it swaps alone (it holds no one's swap). */
  edited: boolean;
  bytes: number;
}

/** The mip side of one or more edits (the ids of their level-0 groups): the nodes they made stale, swapping with them. */
interface MipGroup {
  readonly ids: Set<number>;
  readonly members: Set<Node>;
  /** The level-0 groups ready to swap, waiting for this one. */
  readonly asks: Set<EditAsk>;
  /** The seams being rebuilt for the swap (undefined: not asked yet; 'none': none reads what changes). */
  seams: SeamHold | 'none' | undefined;
  open: boolean;
}

/** A level-0 group's wait for its mip group (what its `seamHold` returns). */
interface EditAsk extends EditHold {
  readonly ids: ReadonlySet<number>;
  readonly chunks: ReadonlyArray<readonly [number, number, number]>;
  readonly surfaces: (cx: number, cy: number, cz: number, axis: number, plane: number) => SeamSurface[] | undefined;
  readonly ready: () => void;
  group: MipGroup;
  done: boolean;
  nodes: Array<readonly [number, number, number, number]>;
  over: boolean;
}

/** The edit lane's distance for a shown node's job: ahead of the edit's level-0 rebuilds (distance 0), which are not drawn where nodes are. */
const DRAWN_EDIT_DISTANCE = -1;

/** Every octant. */
const ALL_OCTANTS = 0xff;

/** Per neighbour offset (index (dx + 1) · 9 + (dz + 1) · 3 + (dy + 1)): the neighbour's octants within half a node of this one. */
const FACING = new Uint8Array(27);
for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
  let m = 0;
  for (let o = 0; o < 8; o++) {
    const side = (d: number, bit: number): boolean => d === 0 || bit === (d < 0 ? 1 : 0);
    if (side(dx, o & 1) && side(dy, (o >> 1) & 1) && side(dz, (o >> 2) & 1)) m |= 1 << o;
  }
  FACING[(dx + 1) * 9 + (dz + 1) * 3 + (dy + 1)] = m;
}

export class StreamMips {
  readonly maxLevel: number;
  /** Worker µs a node: its downsample, and its derive. */
  readonly downsampleUs = new SampleRing();
  readonly deriveUs = new SampleRing();
  readonly counters = { downsamples: 0, derives: 0, staleRefused: 0 };
  /** The seams between the levels drawn (stream-seams.ts). */
  readonly seams: StreamSeams;
  /** Which level is drawn where (stream-lod.ts). */
  readonly lod: StreamLod;
  private readonly rings: ReadonlyMap<number, number>;
  /** Nodes by level (index 0 unused), by key within the level. */
  private readonly levels: Array<Map<number, Node>> = [];
  private readonly stores: PaletteStore[] = [];
  private readonly stale: MipStaleSet;
  /** Nodes without a current result (derived when complete, in their ring and their apron known). */
  private readonly unfresh = new Set<Node>();
  private readonly jobs = new Map<number, Node>();
  /** Open edit groups by every level-0 group id they answer to. */
  private readonly groups = new Map<number, MipGroup>();
  private total = 0;
  private stampSeq = 0;

  constructor(
    private readonly host: MipHost,
    rings: readonly MipRing[],
    levelRings: LevelRings,
  ) {
    const levels = new Map<number, number>();
    for (const r of rings) {
      if (!Number.isInteger(r.level) || r.level < 1 || !(r.radius >= 0) || !Number.isFinite(r.radius) || levels.has(r.level)) throw new RangeError(`mip ring level ${r.level}, radius ${r.radius}`);
      levels.set(r.level, r.radius);
    }
    if (levels.size === 0) throw new RangeError('mips need at least one level');
    // The apron must lie in the octants facing a node (half a node deep at most).
    if (2 * host.radius > host.grid.edge) throw new RangeError(`rules radius ${host.radius} past half a node of ${host.grid.edge}`);
    this.rings = levels;
    this.maxLevel = Math.max(...levels.keys());
    this.stale = new MipStaleSet(this.maxLevel);
    for (let l = 0; l <= this.maxLevel; l++) {
      this.levels.push(new Map());
      this.stores.push(createWorldStore(host.grid, `mip-${l}`));
    }
    this.seams = new StreamSeams(
      {
        grid: host.grid,
        gridId: host.gridId,
        pool: host.pool,
        tracker: host.tracker,
        maxLevel: this.maxLevel,
        nodeResult: (l, nx, ny, nz) => this.drawnResult(l, nx, ny, nz),
        nodes: () => this.allNodes(),
        chunkSurfaces: (cx, cy, cz, axis, plane) => host.chunkSurfaces(cx, cy, cz, axis, plane),
        emit: (e) => host.emit(e),
        poke: () => host.poke(),
      },
      new DrawnLevels(host.grid, this.maxLevel),
    );
    this.lod = new StreamLod(
      {
        grid: host.grid,
        maxLevel: this.maxLevel,
        ring: host.ring,
        seams: this.seams,
        focus: () => host.focus(),
        ready: (l, nx, ny, nz) => (l === 0 ? host.isResident(nx, ny, nz) && host.chunkReady(nx, ny, nz) : this.drawnResult(l, nx, ny, nz) !== undefined),
        emit: (e) => host.emit(e),
      },
      levelRings,
    );
  }

  /** The page's GPU bytes of the nodes and seams it draws (reported after each batch it applies). */
  gpuBytes = 0;

  /** Bytes counted against the stream budget: node cells, derived results, seams, bookkeeping and the page's GPU bytes of their draws. */
  get bytes(): number {
    return this.total + this.seams.bytes + this.gpuBytes;
  }

  /** Nodes kept (with cells), all levels. */
  get nodeCount(): number {
    let n = 0;
    for (let l = 1; l <= this.maxLevel; l++) n += this.levels[l]!.size;
    return n;
  }

  /** Bytes of the kept node cells (what the level stores hold). */
  cellBytes(): number {
    let n = 0;
    for (let l = 1; l <= this.maxLevel; l++) n += this.stores[l]!.memoryBytes();
    return n;
  }

  /** Live mip jobs. */
  get running(): number {
    return this.jobs.size;
  }

  /** A node's newest derived result (null: none, nothing to draw, or the level is not kept). */
  derivedOf(level: number, nx: number, ny: number, nz: number): DerivedData | null {
    if (level < 1 || level > this.maxLevel || !chunkInWorld(this.host.grid, nx, ny, nz)) return null;
    return this.levels[level]!.get(chunkKey(this.host.grid, nx, ny, nz))?.derived ?? null;
  }

  /** A node's result as drawn: its current one, or while a rebuild is pending the one before (undefined: none). */
  private drawnResult(level: number, nx: number, ny: number, nz: number): DerivedData | null | undefined {
    if (level < 1 || level > this.maxLevel || !chunkInWorld(this.host.grid, nx, ny, nz)) return undefined;
    const n = this.levels[level]!.get(chunkKey(this.host.grid, nx, ny, nz));
    if (n === undefined) return undefined;
    return n.fresh ? n.derived : (n.derived ?? undefined);
  }

  private *allNodes(): IterableIterator<MipNode> {
    for (let l = 1; l <= this.maxLevel; l++) yield* this.levels[l]!.values();
  }

  /** Every node with a current derived result (`result` null: derived, nothing to draw). */
  *derived(): IterableIterator<{ readonly level: number; readonly nx: number; readonly ny: number; readonly nz: number; readonly result: DerivedData | null }> {
    for (let l = 1; l <= this.maxLevel; l++) for (const n of this.levels[l]!.values()) if (n.fresh) yield { level: l, nx: n.nx, ny: n.ny, nz: n.nz, result: n.derived };
  }

  /** A chunk's content landed (first load, or a reload): its ancestors are rebuilt, and results reading it derived again. */
  chunkLanded(cx: number, cy: number, cz: number): void {
    this.changed([{ cx, cy, cz }], this.chunkBox(cx, cy, cz));
  }

  /** A chunk left: its ancestors lose their results at once (they are no longer complete) and are rebuilt without it. */
  chunkDropped(cx: number, cy: number, cz: number): void {
    this.lod.lost(0, cx, cy, cz);
    this.stale.markChanged([{ cx, cy, cz }]);
    for (let l = 1; l <= this.maxLevel; l++) {
      const n = this.levels[l]!.get(chunkKey(this.host.grid, cx >> l, cy >> l, cz >> l));
      if (n === undefined) continue;
      n.cellStamp = ++this.stampSeq;
      this.dropDerived(n);
    }
  }

  /**
   * Level-0 cells of `chunks` changed within `box`: their ancestors are
   * rebuilt, and every node whose derive reads the changed cells (within
   * the rules' radius of the box, scaled to its level) is derived again;
   * with `group` (the level-0 group of the edit or refresh), those nodes
   * swap with it.
   */
  changed(chunks: readonly ChunkCoord[], box: CellBox, group?: number): void {
    this.stale.markChanged(chunks);
    const g = this.host.grid;
    for (let l = 1; l <= this.maxLevel; l++) {
      const nodes = this.levels[l]!;
      for (const c of chunks) {
        const n = nodes.get(chunkKey(g, c.cx >> l, c.cy >> l, c.cz >> l));
        if (n !== undefined) n.cellStamp = ++this.stampSeq;
      }
      if (!this.rings.has(l)) continue;
      const scaled = { minX: box.minX >> l, minY: box.minY >> l, minZ: box.minZ >> l, maxX: box.maxX >> l, maxY: box.maxY >> l, maxZ: box.maxZ >> l };
      for (const d of dependentChunks(g, scaled, this.host.radius)) {
        const n = nodes.get(chunkKey(g, d.cx, d.cy, d.cz));
        if (n === undefined) continue;
        n.deriveStamp = ++this.stampSeq;
        n.fresh = false;
        this.release(n);
        this.wantDerive(n);
        if (group === undefined) continue;
        if (this.shown(n)) this.join(n, group);
        else n.edited = true;
      }
    }
  }

  /**
   * The kit pieces of some materials changed: every node of a level that
   * draws pieces whose cells `holds` (its payload holds such a material)
   * and that has or awaits a result is derived again, in `group`'s swap
   * where it is shown. Its cells are unchanged, and so is every other node.
   */
  piecesChanged(holds: (p: ChunkPayload) => boolean, group: number): void {
    for (let l = 1; l <= this.maxLevel; l++) {
      if (!levelDrawsPieces(l) || !this.rings.has(l)) continue;
      for (const n of this.levels[l]!.values()) {
        if (!(n.fresh || n.deriveJob !== 0) || !holds(this.stores[l]!.chunkPayload(n.nx, n.ny, n.nz, true))) continue;
        n.deriveStamp = ++this.stampSeq;
        n.fresh = false;
        this.release(n);
        this.wantDerive(n);
        if (this.shown(n)) this.join(n, group);
        else n.edited = true;
      }
    }
  }

  /** The focus moved: results past their ring (and its hysteresis) are dropped, and the levels drawn may change. */
  focusMoved(): void {
    for (const [l, radius] of this.rings) {
      for (const n of this.levels[l]!.values()) {
        if ((n.fresh || n.deriveJob !== 0) && this.distance(n) > radius + MIP_RING_HYSTERESIS_CELLS) this.dropDerived(n);
      }
    }
  }

  /** Whether any mip work can go on now (for the streamer's idle check). */
  pending(): boolean {
    if (this.jobs.size > 0) return true;
    for (const m of this.stale.nodes()) if (this.childrenSettled(m)) return true;
    for (const n of this.unfresh) if (this.derivable(n)) return true;
    return this.lod.pending() || this.seams.pending();
  }

  /** Sends what can go: node rebuilds lowest level first, then derives, within `ms` of main-thread time and the pool's room. */
  request(ms: number): void {
    const t0 = performance.now();
    this.advanceEdits();
    for (const g of this.openGroups()) this.stepGroup(g);
    let room = this.host.pool.room();
    for (const m of this.stale.nodes()) {
      if (room <= 0 || performance.now() - t0 > ms) return;
      if (this.childrenSettled(m)) room -= this.rebuild(m);
    }
    for (const n of this.unfresh) {
      if (room <= 0 || performance.now() - t0 > ms) return;
      if (n.fresh) {
        this.unfresh.delete(n);
        continue;
      }
      if (this.derivable(n)) room -= this.derive(n);
    }
    this.lod.update();
    this.seams.request();
  }

  /**
   * A level-0 group (`ids`: its own and those merged into it) is ready to
   * swap: what it must wait for besides, the drawn nodes its edits changed
   * and the seams reading them or its `chunks` (rebuilt from `surfaces`,
   * its held results). The returned hold is done, or calls `ready`, once
   * every level-0 group of the mip group has asked and all of that is
   * built; the first to commit puts the nodes and seams in (all of the mip
   * group's level-0 groups are told in one task, so they swap together).
   * Null: nothing to wait for.
   */
  holdEdit(ids: readonly number[], chunks: ReadonlyArray<readonly [number, number, number]>, surfaces: EditAsk['surfaces'], ready: () => void): EditHold | null {
    let g: MipGroup | null = null;
    for (const id of ids) {
      const m = this.groups.get(id);
      if (m !== undefined && m.open) g = g === null ? m : this.mergeGroups(m, g);
    }
    if (g === null) {
      const hold = this.seams.holdEdit([], chunks, surfaces, ready);
      return hold === null ? null : { get done() { return hold.done; }, nodes: [], commit: () => hold.commit(), cancel: () => hold.cancel() };
    }
    const group = g;
    const ask: EditAsk = {
      ids: new Set(ids),
      chunks,
      surfaces,
      ready,
      group,
      done: false,
      nodes: [],
      over: false,
      commit: () => {
        if (ask.over) return;
        ask.over = true;
        ask.group.asks.delete(ask);
        if (ask.group.open) ask.nodes = this.commitGroup(ask.group);
      },
      cancel: () => {
        if (ask.over) return;
        ask.over = true;
        ask.group.asks.delete(ask);
        if (ask.group.open) this.restart(ask.group);
      },
    };
    group.asks.add(ask);
    // New chunks to read: the seams are worked out again.
    this.restart(group);
    this.stepGroup(group, ask);
    return ask;
  }

  /** Sends the next jobs of every open edit group (node rebuilds, then derives), in the edit lane. */
  advanceEdits(): void {
    for (const g of this.openGroups()) {
      let room = this.host.pool.room();
      for (const n of g.members) {
        if (room <= 0) return;
        if (this.stale.has(n) && this.childrenSettled(n)) room -= this.rebuild(n);
      }
      for (const n of g.members) {
        if (room <= 0) return;
        if (this.unfresh.has(n) && this.derivable(n)) room -= this.derive(n);
      }
    }
  }

  private *openGroups(): IterableIterator<MipGroup> {
    const seen = new Set<MipGroup>();
    for (const g of this.groups.values()) {
      if (!g.open || seen.has(g)) continue;
      seen.add(g);
      yield g;
    }
  }

  /** A node joins the edit group of level-0 group `id` (merging the open group it is in already). */
  private join(n: Node, id: number): void {
    let g = this.groups.get(id);
    if (g === undefined || !g.open) {
      g = { ids: new Set([id]), members: new Set(), asks: new Set(), seams: undefined, open: true };
      this.groups.set(id, g);
    }
    if (n.group !== null && n.group !== g && n.group.open) g = this.mergeGroups(n.group, g);
    n.group = g;
    g.members.add(n);
    this.restart(g);
  }

  /** Merges group `a` into `b`: they swap together, as one. */
  private mergeGroups(a: MipGroup, b: MipGroup): MipGroup {
    if (a === b) return b;
    this.restart(a);
    a.open = false;
    for (const id of a.ids) {
      b.ids.add(id);
      this.groups.set(id, b);
    }
    for (const n of a.members) {
      n.group = b;
      b.members.add(n);
    }
    for (const k of a.asks) {
      k.group = b;
      b.asks.add(k);
    }
    this.restart(b);
    return b;
  }

  /** A node no longer swaps with its group (it left, cannot be derived, or goes in alone). */
  private leaveGroup(n: Node): void {
    const g = n.group;
    if (g === null) return;
    n.group = null;
    g.members.delete(n);
    if (n.groupHeld !== undefined) {
      n.groupHeld = undefined;
      this.restart(g);
    }
    // The group may be ready without it now: looked at by the caller or the next request (never from inside a drop).
  }

  /** What a group's seams were built from changed: they are built again once it is ready. */
  private restart(g: MipGroup): void {
    if (g.seams !== undefined && g.seams !== 'none') g.seams.cancel();
    g.seams = undefined;
    for (const k of g.asks) k.done = false;
  }

  /**
   * Builds a group's seams once every level-0 group of it has asked and no
   * drawn member is still on its way, then tells every asker (`asking`: the
   * one asking now, which reads `done` instead).
   */
  private stepGroup(g: MipGroup, asking: EditAsk | null = null): void {
    if (!g.open) return;
    for (const id of g.ids) {
      let asked = false;
      for (const k of g.asks) if (k.ids.has(id)) asked = true;
      if (!asked) return;
    }
    for (const n of g.members) if (this.awaited(n)) return;
    if (g.seams === undefined) {
      const held: HeldNode[] = [];
      for (const n of g.members) if (n.groupHeld !== undefined) held.push({ level: n.level, nx: n.nx, ny: n.ny, nz: n.nz, result: n.groupHeld });
      const chunks = new Map<string, readonly [number, number, number]>();
      for (const k of g.asks) for (const c of k.chunks) chunks.set(c.join(), c);
      const first = g.asks.values().next().value!;
      const hold: SeamHold | null = this.seams.holdEdit(held, [...chunks.values()], first.surfaces, () => {
        if (g.seams === hold && g.open) this.groupReady(g, null);
      });
      g.seams = hold ?? 'none';
      if (hold !== null && !hold.done) return;
    } else if (g.seams !== 'none' && !g.seams.done) return;
    this.groupReady(g, asking);
  }

  private groupReady(g: MipGroup, asking: EditAsk | null): void {
    const asks = [...g.asks];
    for (const k of asks) k.done = true;
    for (const k of asks) if (k !== asking && !k.over) k.ready();
  }

  /** Puts a group's held results and seams in (in the task of its level-0 swap); returns the nodes put in. */
  private commitGroup(g: MipGroup): Array<readonly [number, number, number, number]> {
    g.open = false;
    for (const id of g.ids) if (this.groups.get(id) === g) this.groups.delete(id);
    const nodes: Array<readonly [number, number, number, number]> = [];
    for (const n of g.members) {
      n.group = null;
      const d = n.groupHeld;
      if (d === undefined) continue;
      n.groupHeld = undefined;
      this.commit(n, d, false);
      nodes.push([n.level, n.nx, n.ny, n.nz]);
    }
    g.members.clear();
    if (g.seams !== undefined && g.seams !== 'none') g.seams.commit();
    for (const k of g.asks) k.over = true;
    g.asks.clear();
    return nodes;
  }

  /** Whether a node is drawn now (its old result stays drawn while the new one waits). */
  private drawn(n: MipNode): boolean {
    return this.lod.drawn.drawn(n.level, n.nx, n.ny, n.nz);
  }

  /** Whether a node's result is on screen: it is drawn, or a seam drawn beside it reads it. */
  private shown(n: MipNode): boolean {
    return this.drawn(n) || this.seams.reads(n.level, n.nx, n.ny, n.nz);
  }

  /** Whether a group must wait for a member: shown, its new result not in yet, and on its way (a node that cannot derive now is not waited for). */
  private awaited(n: Node): boolean {
    return n.groupHeld === undefined && this.shown(n) && this.progressing(n);
  }

  /** Whether a node will get a new result without another change: a job on its way, its cells waiting for a rebuild, or derivable once neighbours on their way are rebuilt. */
  private progressing(n: Node): boolean {
    if (n.deriveJob !== 0 || n.cellJob !== 0 || this.stale.has(n)) return true;
    if (n.fresh || !this.unfresh.has(n) || !this.complete(n)) return false;
    const radius = this.rings.get(n.level);
    if (radius === undefined || this.distance(n) > radius) return false;
    const nodes = this.levels[n.level]!;
    const g = this.host.grid;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const at = { level: n.level, nx: n.nx + dx, ny: n.ny + dy, nz: n.nz + dz };
      if (!this.inWorld(at.level, at.nx, at.ny, at.nz) || this.stale.has(at)) continue;
      const m = nodes.get(chunkKey(g, at.nx, at.ny, at.nz));
      if (m === undefined) return false;
      if (m.cellJob !== 0) continue;
      const need = FACING[(dx + 1) * 9 + (dz + 1) * 3 + (dy + 1)]!;
      if ((m.built & need) !== need) return false;
    }
    return true;
  }

  /** Whether a node's work belongs to an open edit (it, or a node above it whose cells it feeds, swaps with one). */
  private urgent(m: MipNode): boolean {
    for (let l = m.level; l <= this.maxLevel; l++) {
      const s = l - m.level;
      const n = this.levels[l]!.get(chunkKey(this.host.grid, m.nx >> s, m.ny >> s, m.nz >> s));
      if (n === undefined) continue;
      if (n.edited || (n.group !== null && n.group.open)) return true;
    }
    return false;
  }

  /** A node's job lane and distance: an open edit's in the edit lane (drawn ones first), streaming work in the mip lane, nearest first. */
  private laneOf(n: Node): { lane: 'edit' | 'mip'; distance: number } {
    if (!this.urgent(n)) return { lane: 'mip', distance: this.distance(n) ** 2 };
    return { lane: 'edit', distance: this.shown(n) ? DRAWN_EDIT_DISTANCE : this.distance(n) ** 2 };
  }

  private chunkBox(cx: number, cy: number, cz: number): CellBox {
    const s = this.host.grid.shift;
    return { minX: cx << s, minY: cy << s, minZ: cz << s, maxX: ((cx + 1) << s) - 1, maxY: ((cy + 1) << s) - 1, maxZ: ((cz + 1) << s) - 1 };
  }

  /** Whether a node lies inside the world (its first chunk does; the world's bounds are whole nodes). */
  private inWorld(level: number, nx: number, ny: number, nz: number): boolean {
    return chunkInWorld(this.host.grid, nx * 2 ** level, ny * 2 ** level, nz * 2 ** level);
  }

  /** Horizontal box distance (cells) from the focus to a node. */
  private distance(n: MipNode): number {
    return levelNodeDistance(this.host.grid, [this.host.focus()], n);
  }

  /** Whether a node's cells are what its children hold now (not waiting for a rebuild, none running). */
  private settled(m: MipNode): boolean {
    if (this.stale.has(m)) return false;
    const n = this.levels[m.level]!.get(chunkKey(this.host.grid, m.nx, m.ny, m.nz));
    return n === undefined || n.cellJob === 0;
  }

  private complete(n: Node): boolean {
    return n.built === ALL_OCTANTS && n.cellJob === 0 && !this.stale.has(n);
  }

  /** Whether a node's children are settled, so it can be rebuilt from them. */
  private childrenSettled(m: MipNode): boolean {
    if (m.level === 1) return true;
    for (let o = 0; o < 8; o++) if (!this.settled(this.child(m, o))) return false;
    return true;
  }

  private child(m: MipNode, o: number): MipNode {
    return { level: m.level - 1, nx: 2 * m.nx + (o & 1), ny: 2 * m.ny + ((o >> 1) & 1), nz: 2 * m.nz + ((o >> 2) & 1) };
  }

  /** Whether a child's cells are known: outside the world (air), a resident chunk, or a complete node. */
  private known(c: MipNode): boolean {
    if (!this.inWorld(c.level, c.nx, c.ny, c.nz)) return true;
    if (c.level === 0) return this.host.isResident(c.nx, c.ny, c.nz);
    const n = this.levels[c.level]!.get(chunkKey(this.host.grid, c.nx, c.ny, c.nz));
    return n !== undefined && this.complete(n);
  }

  /** Sends a node's rebuild (or applies it at once when there is nothing to downsample); returns the jobs sent. */
  private rebuild(m: MipNode): number {
    const host = this.host;
    const g = host.grid;
    const level = m.level;
    const key = chunkKey(g, m.nx, m.ny, m.nz);
    let n = this.levels[level]!.get(key);
    let mask = 0;
    const children: Array<ChunkPayload | null> = [];
    let any = false;
    for (let o = 0; o < 8; o++) {
      const c = this.child(m, o);
      if (!this.known(c)) {
        children.push(null);
        continue;
      }
      mask |= 1 << o;
      if (!this.inWorld(c.level, c.nx, c.ny, c.nz)) {
        children.push(null);
        continue;
      }
      const p = level === 1 ? host.chunkPayload(c.nx, c.ny, c.nz) : this.stores[level - 1]!.chunkPayload(c.nx, c.ny, c.nz, true);
      children.push(p.form === 'air' ? null : p);
      any ||= p.form !== 'air';
    }
    this.stale.rebuilt(m);
    if (n !== undefined && n.cellJob !== 0) this.cancel(n, 'cells');
    if (mask === 0) {
      if (n !== undefined) this.remove(n);
      return 0;
    }
    n ??= this.add(m, key);
    if (!any) {
      this.setCells(n, mask, { form: 'air' });
      return 0;
    }
    const id = this.jobId(n);
    const stamp = n.cellStamp;
    n.cellJob = id;
    this.jobs.set(id, n);
    const transfer: ArrayBuffer[] = [];
    for (const p of children) if (p !== null) payloadTransfer(p, transfer);
    const input: MipInput = { edge: g.edge as MipInput['edge'], children };
    void host.pool.submit<MipOutput>({ id, kind: 'mip', ...this.laneOf(n), input, transfer }).then((o) => this.rebuilt(n, id, stamp, mask, o));
    return 1;
  }

  private rebuilt(n: Node, id: number, stamp: number, mask: number, o: JobOutcome<MipOutput>): void {
    this.host.poke();
    this.jobs.delete(id);
    if (o.status === 'cancelled' || n.cellJob !== id || this.levels[n.level]!.get(n.key) !== n) return;
    n.cellJob = 0;
    if (o.status !== 'done') {
      // A rebuild is never skipped: the node waits again (a refused input would fail again, but its children's next change sends a new one).
      if (o.status !== 'refused' && o.status !== 'failed') this.stale.mark(n);
      return;
    }
    if (n.cellStamp !== stamp) {
      this.counters.staleRefused++;
      return;
    }
    this.downsampleUs.add(o.workerUs);
    this.counters.downsamples++;
    this.setCells(n, mask, o.output.payload);
    // An edit's next step (the node's derive, its parent's cells) goes out now, not at the next update.
    if (this.urgent(n)) this.advanceEdits();
  }

  private setCells(n: Node, mask: number, payload: ChunkPayload): void {
    this.stores[n.level]!.adoptPayload(n.nx, n.ny, n.nz, payload);
    n.built = mask;
    this.recount(n);
    if (mask !== ALL_OCTANTS) this.dropDerived(n);
    else if (!n.fresh) this.wantDerive(n);
  }

  /** Whether a node can be derived now: unfresh, complete, in its ring, and the facing octants of its neighbours known. */
  private derivable(n: Node): boolean {
    if (n.fresh || n.deriveJob !== 0 || n.held !== null || n.groupHeld !== undefined || !this.complete(n)) return false;
    const radius = this.rings.get(n.level);
    if (radius === undefined || this.distance(n) > radius) return false;
    const nodes = this.levels[n.level]!;
    const g = this.host.grid;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const mx = n.nx + dx;
      const my = n.ny + dy;
      const mz = n.nz + dz;
      if (!this.inWorld(n.level, mx, my, mz)) continue;
      const m = nodes.get(chunkKey(g, mx, my, mz));
      if (m === undefined || m.cellJob !== 0 || this.stale.has(m)) return false;
      const need = FACING[(dx + 1) * 9 + (dz + 1) * 3 + (dy + 1)]!;
      if ((m.built & need) !== need) return false;
    }
    return true;
  }

  /** Sends a node's derive (or settles it at once when it and its apron are air); returns the jobs sent. */
  private derive(n: Node): number {
    const host = this.host;
    const store = this.stores[n.level]!;
    const apron = buildApron(store, n.nx, n.ny, n.nz, host.radius);
    if (store.chunkForm(n.nx, n.ny, n.nz) === 'absent' && apron.dense.every((d, k) => d === 0 && apron.uniform[k] === 0)) {
      // Air with air all around: nothing stands, nothing is drawn.
      this.commit(n, null);
      return 0;
    }
    const payload = store.chunkPayload(n.nx, n.ny, n.nz, true);
    const id = this.jobId(n);
    const stamp = n.deriveStamp;
    const pieces = levelDrawsPieces(n.level) ? host.pieceTable() : null;
    n.deriveJob = id;
    this.jobs.set(id, n);
    const input: DeriveInput = { edge: host.grid.edge, chunk: { grid: host.gridId, cx: n.nx, cy: n.ny, cz: n.nz }, payload, radius: host.radius, apron, rules: rulesRef(host.rules), level: n.level, ...(pieces === null ? {} : { pieces: pieces.bytes }) };
    void host.pool.submit<DeriveOutput>({ id, kind: 'derive', ...this.laneOf(n), input, transfer: payloadTransfer(payload, apronTransfer(apron)) }).then((o) => this.answered(n, id, stamp, o));
    return 1;
  }

  private answered(n: Node, id: number, stamp: number, o: JobOutcome<DeriveOutput>): void {
    this.host.poke();
    this.jobs.delete(id);
    if (o.status === 'cancelled' || n.deriveJob !== id || this.levels[n.level]!.get(n.key) !== n) return;
    n.deriveJob = 0;
    if (o.status !== 'done') {
      // Refused or failed: the same input fails again, so it waits for the next change (as a section does), and its edit swaps without it.
      if (o.status === 'refused' || o.status === 'failed') {
        const g = n.group;
        this.unfresh.delete(n);
        this.leaveGroup(n);
        if (g !== null) this.stepGroup(g);
      }
      return;
    }
    if (n.deriveStamp !== stamp || !this.complete(n)) {
      this.counters.staleRefused++;
      return;
    }
    this.deriveUs.add(o.workerUs);
    const d = o.output.assembly;
    const g = n.group;
    if (g !== null && this.shown(n)) {
      // Shown: it goes in with its edit's swap, the old result drawn until then.
      n.groupHeld = d;
      if (g.seams !== undefined) this.restart(g);
      this.stepGroup(g);
      return;
    }
    // Not shown: nothing draws it, so it goes in now, alone (its group may be ready without it).
    this.leaveGroup(n);
    if (g !== null) this.stepGroup(g);
    // The seams reading the node are rebuilt from the new result first; both go in together.
    const hold = this.seams.holdNode(n.level, n.nx, n.ny, n.nz, d, () => {
      if (n.held !== hold || hold === null) return;
      n.held = null;
      this.commit(n, d, false);
      hold.commit();
    });
    if (hold === null) this.commit(n, d);
    else n.held = hold;
  }

  /** Puts a node's result in; `alone`: no hold rebuilt the seams reading it, so they are rebuilt after. */
  private commit(n: Node, d: DerivedData | null, alone = true): void {
    n.derived = d;
    n.fresh = true;
    n.edited = false;
    this.unfresh.delete(n);
    this.counters.derives++;
    this.recount(n);
    this.host.emit({ type: 'node', level: n.level, nx: n.nx, ny: n.ny, nz: n.nz, removed: d === null });
    if (alone) this.seams.nodeChanged(n.level, n.nx, n.ny, n.nz);
    this.lod.changed();
  }

  /** A held result is no longer what the node's inputs give (they changed, or it left): it and its seams go. */
  private release(n: Node): void {
    if (n.groupHeld !== undefined) {
      n.groupHeld = undefined;
      if (n.group !== null) this.restart(n.group);
    }
    if (n.held === null) return;
    n.held.cancel();
    n.held = null;
  }

  /** A node is no longer derivable here (incomplete, or past its ring): its result goes, and it is derived again when it can be. */
  private dropDerived(n: Node): void {
    this.leaveGroup(n);
    n.edited = false;
    if (n.deriveJob !== 0) this.cancel(n, 'derive');
    this.release(n);
    const had = n.derived !== null;
    n.derived = null;
    n.fresh = false;
    this.wantDerive(n);
    this.recount(n);
    if (had) {
      this.host.emit({ type: 'node', level: n.level, nx: n.nx, ny: n.ny, nz: n.nz, removed: true });
      this.seams.nodeChanged(n.level, n.nx, n.ny, n.nz);
    }
    // Drawn with no result (nothing to draw) or with one, it can no longer be drawn.
    this.lod.lost(n.level, n.nx, n.ny, n.nz);
  }

  /** Keeps a node of a kept level in the set of those to derive (levels kept only as the next one's children are never derived). */
  private wantDerive(n: Node): void {
    if (this.rings.has(n.level)) this.unfresh.add(n);
  }

  private add(m: MipNode, key: number): Node {
    const n: Node = { level: m.level, nx: m.nx, ny: m.ny, nz: m.nz, key, built: 0, cellJob: 0, cellStamp: ++this.stampSeq, deriveJob: 0, deriveStamp: ++this.stampSeq, fresh: false, derived: null, held: null, group: null, groupHeld: undefined, edited: false, bytes: 0 };
    this.levels[m.level]!.set(key, n);
    this.seams.nodeChanged(m.level, m.nx, m.ny, m.nz);
    return n;
  }

  private remove(n: Node): void {
    this.dropDerived(n);
    if (n.cellJob !== 0) this.cancel(n, 'cells');
    this.stores[n.level]!.dropChunk(n.nx, n.ny, n.nz);
    this.unfresh.delete(n);
    this.levels[n.level]!.delete(n.key);
    this.total -= n.bytes;
    n.bytes = 0;
    this.seams.nodeChanged(n.level, n.nx, n.ny, n.nz);
  }

  private cancel(n: Node, which: 'cells' | 'derive'): void {
    const id = which === 'cells' ? n.cellJob : n.deriveJob;
    this.host.pool.cancel(id);
    this.jobs.delete(id);
    if (which === 'cells') n.cellJob = 0;
    else n.deriveJob = 0;
  }

  private recount(n: Node): void {
    const bytes = this.stores[n.level]!.chunkBytes(n.nx, n.ny, n.nz) + (n.derived === null ? 0 : derivedBytes(n.derived)) + RESIDENT_CHUNK_OVERHEAD_BYTES;
    this.total += bytes - n.bytes;
    n.bytes = bytes;
  }

  /** A pool job id (the tracker's id space; staleness is the node's own stamps, so the job only routes the reply). */
  private jobId(n: Node): number {
    const s = n.level;
    const id = this.host.tracker.beginJob({ grid: this.host.gridId, key: chunkKey(this.host.grid, n.nx * 2 ** s, n.ny * 2 ** s, n.nz * 2 ** s) }).id;
    this.host.tracker.expireJob(id);
    return id;
  }
}
