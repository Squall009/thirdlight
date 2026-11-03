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
 *   edit's rebuilds, then near and far work), nearest first.
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
import type { DirtyTracker } from './dirty-tracker';
import { createWorldStore, type PaletteStore } from './palette-store';
import type { CellBox } from './stroke';
import type { DeriveInput, DeriveOutput, MipInput, MipOutput } from './stream-job';
import type { SeamSurface } from './lod-seam';
import { DrawnLevels, levelNodeDistance, type LevelRings } from './lod-select';
import { MIP_RING_HYSTERESIS_CELLS, RESIDENT_CHUNK_OVERHEAD_BYTES, type Focus, type MipRing, type StreamRing } from './stream-ring';
import { StreamLod, type LevelEvent } from './stream-lod';
import { StreamSeams, type SeamEvent, type SeamHold } from './stream-seams';
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
  bytes: number;
}

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

  /** Bytes counted against the stream budget: node cells, derived results, seams and bookkeeping. */
  get bytes(): number {
    return this.total + this.seams.bytes;
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
   * the rules' radius of the box, scaled to its level) is derived again.
   */
  changed(chunks: readonly ChunkCoord[], box: CellBox): void {
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
    void host.pool.submit<MipOutput>({ id, kind: 'mip', lane: 'mip', distance: this.distance(n) ** 2, input, transfer }).then((o) => this.rebuilt(n, id, stamp, mask, o));
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
    if (n.fresh || n.deriveJob !== 0 || n.held !== null || !this.complete(n)) return false;
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
    n.deriveJob = id;
    this.jobs.set(id, n);
    const input: DeriveInput = { edge: host.grid.edge, chunk: { grid: host.gridId, cx: n.nx, cy: n.ny, cz: n.nz }, payload, radius: host.radius, apron, rules: rulesRef(host.rules), level: n.level };
    void host.pool.submit<DeriveOutput>({ id, kind: 'derive', lane: 'mip', distance: this.distance(n) ** 2, input, transfer: payloadTransfer(payload, apronTransfer(apron)) }).then((o) => this.answered(n, id, stamp, o));
    return 1;
  }

  private answered(n: Node, id: number, stamp: number, o: JobOutcome<DeriveOutput>): void {
    this.host.poke();
    this.jobs.delete(id);
    if (o.status === 'cancelled' || n.deriveJob !== id || this.levels[n.level]!.get(n.key) !== n) return;
    n.deriveJob = 0;
    if (o.status !== 'done') {
      // Refused or failed: the same input fails again, so it waits for the next change (as a section does).
      if (o.status === 'refused' || o.status === 'failed') this.unfresh.delete(n);
      return;
    }
    if (n.deriveStamp !== stamp || !this.complete(n)) {
      this.counters.staleRefused++;
      return;
    }
    this.deriveUs.add(o.workerUs);
    const d = o.output.assembly;
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
    this.unfresh.delete(n);
    this.counters.derives++;
    this.recount(n);
    this.host.emit({ type: 'node', level: n.level, nx: n.nx, ny: n.ny, nz: n.nz, removed: d === null });
    if (alone) this.seams.nodeChanged(n.level, n.nx, n.ny, n.nz);
    this.lod.changed();
  }

  /** A held result is no longer what the node's inputs give (they changed, or it left): it and its seams go. */
  private release(n: Node): void {
    if (n.held === null) return;
    n.held.cancel();
    n.held = null;
  }

  /** A node is no longer derivable here (incomplete, or past its ring): its result goes, and it is derived again when it can be. */
  private dropDerived(n: Node): void {
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
    const n: Node = { level: m.level, nx: m.nx, ny: m.ny, nz: m.nz, key, built: 0, cellJob: 0, cellStamp: ++this.stampSeq, deriveJob: 0, deriveStamp: ++this.stampSeq, fresh: false, derived: null, held: null, bytes: 0 };
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
