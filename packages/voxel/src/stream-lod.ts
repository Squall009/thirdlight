/**
 * The levels the streamer draws (lod-select.ts), kept current as the foci
 * move and nodes become ready or leave, and changed only in whole swaps.
 *
 * - **A swap.** When the choice differs from what is drawn, it becomes the
 *   seams' selection and the faces it adds are built (stream-seams.ts); only
 *   once every one is back are the new nodes drawn and the old ones dropped,
 *   with the seams, in one task: a `seams` event, then a `levels` event
 *   naming every node added and removed. The old level is drawn until then.
 *   One swap is built at a time; a choice made meanwhile waits for it.
 * - **Lost nodes.** A drawn node that can no longer be drawn (its chunk
 *   left, its result dropped) leaves at once in a `levels` event of its own:
 *   there is nothing to keep drawing, and what stands in comes with the next
 *   swap.
 * - **When to choose.** Again after a focus moved a cell or more, a node
 *   became ready or left, or the rings changed; otherwise the drawn choice
 *   stands (it is cheap when nothing changed).
 * - **Detail held back.** While the streamer holds level 0 back for the
 *   focus's speed ({@link StreamLod.setDetail}), the choice is made with no
 *   level-0 ring: level 1 is drawn where level 0 would be (level 0 still
 *   stands in only for a level-1 node not ready next to a focus, so nothing
 *   near goes missing). When the speed falls, level 0 comes back by swaps as
 *   its chunks are derived, nearest the focus first.
 */
import type { ChunkGrid } from './coords';
import { checkLevelRings, chooseLevels, DrawnLevels, levelNodeDistance, type LevelNode, type LevelRings } from './lod-select';
import type { Focus, StreamRing } from './stream-ring';
import type { StreamSeams } from './stream-seams';
import { SampleRing } from './worker-pool';

/** Nodes drawn and no longer drawn together (`swap`: a change of the choice, built whole; `lost`: nodes that can no longer be drawn). */
export interface LevelEvent {
  readonly type: 'levels';
  readonly reason: 'swap' | 'lost';
  readonly added: readonly LevelNode[];
  readonly removed: readonly LevelNode[];
}

/** What the level choice needs from the streamer and its mip levels. */
export interface LodHost {
  readonly grid: ChunkGrid;
  readonly maxLevel: number;
  /** The load ring (its unload bounds hold every resident chunk). */
  readonly ring: StreamRing;
  readonly seams: StreamSeams;
  focus(): Focus;
  /** Whether a node (level 0: a chunk) has what it is drawn from. */
  ready(level: number, nx: number, ny: number, nz: number): boolean;
  emit(e: LevelEvent): void;
}

/** Cells a focus moves before the levels are chosen again. */
const REFOCUS_CELLS = 1;

export class StreamLod {
  readonly counters = { choices: 0, swaps: 0, levelChanges: 0, lost: 0, unbalanced: 0 };
  /** Milliseconds from a choice to its swap. */
  readonly swapMs = new SampleRing();
  private rings: LevelRings;
  private current: DrawnLevels;
  /** The last choice (its splits are the next one's hysteresis). */
  private chosen: DrawnLevels | null = null;
  private building: DrawnLevels | null = null;
  private dirty = true;
  private extra: readonly Focus[] = [];
  /** Level 0 drawn (false: held back at speed, the choice made without its ring). */
  private detail = true;
  /** Only the level-0 ring drawn ({@link setNearOnly}). */
  private nearOnly = false;
  private used: readonly Focus[] = [];

  constructor(
    private readonly host: LodHost,
    rings: LevelRings,
  ) {
    this.rings = this.checked(rings);
    this.current = new DrawnLevels(host.grid, host.maxLevel);
  }

  /** What is drawn now (a selection: the seams' while no swap is being built). */
  get drawn(): DrawnLevels {
    return this.current;
  }

  /** The rings in use. */
  get levelRings(): LevelRings {
    return this.rings;
  }

  /** A swap is being built. */
  get swapping(): boolean {
    return this.building !== null;
  }

  /** New rings: the levels are chosen again (the change is one swap). */
  setRings(rings: LevelRings): void {
    this.rings = this.checked(rings);
    this.dirty = true;
  }

  /** Focus points besides the stream's own (the collision ring's: characters), each drawn at level 0 round it like the stream focus. */
  setFoci(foci: readonly Focus[]): void {
    this.extra = foci.map((f) => ({ x: f.x, y: f.y, z: f.z }));
  }

  /** The focus points besides the stream's own ({@link setFoci}). */
  get extraFoci(): readonly Focus[] {
    return this.extra;
  }

  /** Draws level 0 (true, the default) or holds it back (false: the levels are chosen with no level-0 ring); the change is one swap. */
  setDetail(on: boolean): void {
    if (on === this.detail) return;
    this.detail = on;
    this.dirty = true;
  }

  /**
   * Draws only the level-0 ring (true: fine far bricks draw past it, so no level 1 or 2 is chosen there and nothing
   * stands in for them: level 0 covers what it covers with every ring) or every ring (false, the default); one swap.
   */
  setNearOnly(on: boolean): void {
    if (on === this.nearOnly) return;
    this.nearOnly = on;
    this.dirty = true;
  }

  /**
   * Whether a chunk lies where level 0 may be drawn: near only, under a level-1 node within level 0's ring, its
   * hysteresis and one chunk more of any focus (a node at the edge is ready before the ring reaches it); with every
   * ring drawn, anywhere (level 1 is downsampled from the chunks and a chunk stands in wherever a node is not ready).
   */
  inDetailReach(cx: number, cy: number, cz: number): boolean {
    if (!this.nearOnly) return true;
    const g = this.host.grid;
    return levelNodeDistance(g, this.foci(), { level: 1, nx: cx >> 1, ny: cy >> 1, nz: cz >> 1 }) < this.rings.radii[0]! + this.rings.hysteresis + g.edge;
  }

  /**
   * Cells round the stream focus whose chunks the level-0 ring needs read (a chunk's centre within it): a chunk is
   * drawn at level 0 under a level-1 node within the ring, its hysteresis and a chunk ({@link inDetailReach}); a chunk
   * of that node lies at most 1.5 chunks √2 past the node's nearest point, and a chunk's derive reads its neighbours,
   * one chunk (√2 across a corner) more: 4.5 chunks in all. The collision ring lies inside the level-0 ring
   * (world-streamer.ts `worldLevelRings`).
   */
  detailReadReach(): number {
    const e = this.host.grid.edge;
    return this.rings.radii[0]! + this.rings.hysteresis + e + Math.ceil(3.5 * e);
  }

  /** Whether level 0 is drawn ({@link setDetail}). */
  get detailShown(): boolean {
    return this.detail;
  }

  /** Something a choice reads changed (a node or chunk became ready): choose again at the next update. */
  changed(): void {
    this.dirty = true;
  }

  /** A node can no longer be drawn: it leaves now, if drawn. */
  lost(level: number, nx: number, ny: number, nz: number): void {
    this.dirty = true;
    const n = { level, nx, ny, nz };
    if (!this.current.drawn(level, nx, ny, nz) || !this.current.remove(n)) return;
    this.counters.lost++;
    if (level === 0) this.host.seams.nodeChanged(0, nx, ny, nz);
    this.host.emit({ type: 'levels', reason: 'lost', added: [], removed: [n] });
  }

  /** Whether a choice is to be made or a swap is being built (for the streamer's idle check). */
  pending(): boolean {
    return this.building !== null || this.dirty || this.moved();
  }

  /** Chooses the levels when something changed, and starts the swap to the choice when it differs from what is drawn. */
  update(): void {
    if (this.building !== null || (!this.dirty && !this.moved())) return;
    this.dirty = false;
    const foci = this.foci();
    this.used = foci;
    const host = this.host;
    const radii = this.rings.radii;
    const rings = this.detail ? { radii, hysteresis: this.rings.hysteresis } : { radii: [0, ...radii.slice(1)], hysteresis: this.rings.hysteresis };
    // Near only, no coarser node is drawn and nothing stands in for one: level 0 is drawn over every level-1 node its
    // ring splits, exactly where it is drawn with every ring (a stand-in would reach a level-1 node farther). Held back
    // at speed, what is derived next to the focus still stands in, as with every ring.
    const nearOnly = this.nearOnly;
    const { drawn, stats } = chooseLevels({ grid: host.grid, maxLevel: host.maxLevel, rings, foci, roots: this.roots(foci[0]!), ready: (l, x, y, z) => (nearOnly && l > 0 ? false : host.ready(l, x, y, z)), previous: this.chosen, standIns: !nearOnly || !this.detail });
    this.counters.choices++;
    this.counters.unbalanced = stats.unbalanced;
    this.chosen = drawn;
    if (drawn.size === this.current.size && drawn.minus(this.current).length === 0) return;
    this.building = drawn;
    const t0 = performance.now();
    host.seams.setSelection(drawn, () => this.swap(drawn, t0));
  }

  private swap(next: DrawnLevels, t0: number): void {
    this.building = null;
    this.dirty = true;
    const host = this.host;
    // A node that left while the swap was built is not drawn; the seams facing it follow.
    for (const n of [...next.nodes()]) {
      if (host.ready(n.level, n.nx, n.ny, n.nz)) continue;
      next.remove(n);
      host.seams.nodeChanged(n.level, n.nx, n.ny, n.nz);
    }
    const added = next.minus(this.current);
    const removed = this.current.minus(next);
    this.current = next;
    if (added.length === 0 && removed.length === 0) return;
    this.counters.swaps++;
    if (removed.some((r) => added.some((a) => a.level !== r.level && overlaps(a, r)))) this.counters.levelChanges++;
    this.swapMs.add(performance.now() - t0);
    host.emit({ type: 'levels', reason: 'swap', added, removed });
  }

  private checked(rings: LevelRings): LevelRings {
    checkLevelRings(rings);
    if (rings.radii.length < this.host.maxLevel) throw new RangeError(`${rings.radii.length} level radii for ${this.host.maxLevel} levels`);
    return { radii: [...rings.radii], hysteresis: rings.hysteresis };
  }

  private foci(): Focus[] {
    const f = this.host.focus();
    return [{ x: f.x, y: f.y, z: f.z }, ...this.extra];
  }

  /** Whether a focus moved a cell or more since the last choice (or foci came or went). */
  private moved(): boolean {
    const now = this.foci();
    if (now.length !== this.used.length) return true;
    return now.some((f, i) => {
      const u = this.used[i]!;
      return Math.abs(f.x - u.x) >= REFOCUS_CELLS || Math.abs(f.y - u.y) >= REFOCUS_CELLS || Math.abs(f.z - u.z) >= REFOCUS_CELLS;
    });
  }

  /** The top level's nodes over the unload bounds round the stream focus (they hold every resident chunk). */
  private *roots(f: Focus): IterableIterator<LevelNode> {
    const g = this.host.grid;
    const r = this.host.ring;
    const size = g.edge * 2 ** this.host.maxLevel;
    const lo = (v: number, d: number): number => Math.floor((v - d) / size);
    const hi = (v: number, d: number): number => Math.floor((v + d) / size);
    const level = this.host.maxLevel;
    for (let nx = lo(f.x, r.unloadRadius); nx <= hi(f.x, r.unloadRadius); nx++) {
      for (let nz = lo(f.z, r.unloadRadius); nz <= hi(f.z, r.unloadRadius); nz++) {
        for (let ny = lo(f.y, r.unloadHeight); ny <= hi(f.y, r.unloadHeight); ny++) yield { level, nx, ny, nz };
      }
    }
  }
}

/** Whether two nodes (any levels) share space. */
function overlaps(a: LevelNode, b: LevelNode): boolean {
  const lo = a.level >= b.level ? a : b;
  const hi = lo === a ? b : a;
  const s = lo.level - hi.level;
  return hi.nx >> s === lo.nx && hi.ny >> s === lo.ny && hi.nz >> s === lo.nz;
}
