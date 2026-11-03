/**
 * Which level of the chunk tree is drawn where: level 0 (chunks) near the
 * world's foci, coarser nodes (voxel-mips.ts) further out, chosen per node
 * by its horizontal box distance from the nearest focus.
 *
 * - **Rings.** A node of level L ≥ 1 is split into its eight children while
 *   its distance is under `radii[L − 1]`; once split it stays split until
 *   it is `hysteresis` past that, so a focus moving back and forth across a
 *   ring does not flip the node every frame. The top level is never inside
 *   a coarser node.
 * - **Only what can be drawn.** A node is drawn only when it is ready (it
 *   has a derived result; a chunk: every derive section has one). Where the
 *   wanted level is not ready, what is ready stands in: a node wanted split
 *   whose children are not all ready stays whole (the old level stays drawn
 *   until the new one is there), and a node wanted whole that is not ready
 *   is drawn as its children. A finer level stands in only up to one node
 *   of the next level past its own ring (a stand-in drawn stays to the
 *   hysteresis past that), so the far edge, where coarse nodes are never
 *   complete, is not drawn at full detail.
 * - **2 : 1.** Nodes drawn next to each other across a face are at most one
 *   level apart (the seams join only neighbouring levels): a coarse node
 *   with a face against nodes two or more levels finer is split while its
 *   children are ready.
 *
 * Pure: the caller says what is ready and which nodes to cover.
 */
import { chunkKeyOrNone, type ChunkGrid } from './coords';
import type { Focus } from './stream-ring';
import type { LevelSelection } from './stream-seams';

/** A node of a level (level 0: a chunk). */
export interface LevelNode {
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** Distance rings of the levels drawn (cells, horizontal box distance from the nearest focus). */
export interface LevelRings {
  /** `radii[L]`: level L is drawn within it (L = 0 … the top level − 1); past the last, the top level. */
  readonly radii: readonly number[];
  /** Cells past its ring a split node stays split. */
  readonly hysteresis: number;
}

/** Throws unless the radii are finite, ≥ 0 and do not shrink outward, and the hysteresis is finite and ≥ 0. */
export function checkLevelRings(r: LevelRings): void {
  if (r.radii.length === 0) throw new RangeError('level rings need a radius');
  r.radii.forEach((v, i) => {
    if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError(`level ${i} radius ${v}`);
    if (i > 0 && v < r.radii[i - 1]!) throw new RangeError(`level ${i} radius ${v} inside level ${i - 1}'s ${r.radii[i - 1]}`);
  });
  if (!(r.hysteresis >= 0) || !Number.isFinite(r.hysteresis)) throw new RangeError(`level hysteresis ${r.hysteresis}`);
}

/** A set of drawn nodes (a {@link LevelSelection}), with the splits its rings chose (the next choice's hysteresis). */
export class DrawnLevels implements LevelSelection {
  private readonly byLevel: Array<Map<number, LevelNode>> = [];
  private readonly splitByLevel: Array<Set<number>> = [];

  constructor(
    readonly grid: ChunkGrid,
    readonly maxLevel: number,
  ) {
    for (let l = 0; l <= maxLevel; l++) {
      this.byLevel.push(new Map());
      this.splitByLevel.push(new Set());
    }
  }

  drawn(level: number, nx: number, ny: number, nz: number): boolean {
    const k = this.key(level, nx, ny, nz);
    return k >= 0 && this.byLevel[level]!.has(k);
  }

  /** Whether the rings wanted this node split (whatever was drawn). */
  wasSplit(level: number, nx: number, ny: number, nz: number): boolean {
    const k = this.key(level, nx, ny, nz);
    return k >= 0 && this.splitByLevel[level]!.has(k);
  }

  get size(): number {
    let n = 0;
    for (const m of this.byLevel) n += m.size;
    return n;
  }

  /** Nodes drawn at a level. */
  countAt(level: number): number {
    return this.byLevel[level]?.size ?? 0;
  }

  *nodes(): IterableIterator<LevelNode> {
    for (const m of this.byLevel) yield* m.values();
  }

  /** Nodes drawn here and not in `other`. */
  minus(other: DrawnLevels): LevelNode[] {
    const out: LevelNode[] = [];
    for (const n of this.nodes()) if (!other.drawn(n.level, n.nx, n.ny, n.nz)) out.push(n);
    return out;
  }

  add(n: LevelNode): void {
    this.byLevel[n.level]!.set(this.key(n.level, n.nx, n.ny, n.nz), n);
  }

  remove(n: LevelNode): boolean {
    const k = this.key(n.level, n.nx, n.ny, n.nz);
    return k >= 0 && this.byLevel[n.level]!.delete(k);
  }

  markSplit(n: LevelNode): void {
    this.splitByLevel[n.level]!.add(this.key(n.level, n.nx, n.ny, n.nz));
  }

  /** −1 outside the world or the levels. */
  private key(level: number, nx: number, ny: number, nz: number): number {
    if (!Number.isInteger(level) || level < 0 || level > this.maxLevel) return -1;
    return chunkKeyOrNone(this.grid, nx, ny, nz);
  }
}

export interface LevelChoice {
  readonly grid: ChunkGrid;
  readonly maxLevel: number;
  readonly rings: LevelRings;
  /** Focus points (cells); a node's distance is to the nearest. */
  readonly foci: readonly Focus[];
  /** The nodes of the top level to cover (those over loaded chunks). */
  readonly roots: Iterable<LevelNode>;
  /** Whether a node can be drawn now. */
  ready(level: number, nx: number, ny: number, nz: number): boolean;
  /** The previous choice (its splits give the hysteresis); null: none. */
  readonly previous: DrawnLevels | null;
}

export interface LevelChoiceStats {
  /** Faces left more than a level apart because the nodes that would mend them are not ready. */
  readonly unbalanced: number;
}

/** Whether a node lies in the world (its first chunk does: the world's bounds are whole nodes). */
const inWorld = (grid: ChunkGrid, n: LevelNode): boolean => chunkKeyOrNone(grid, n.nx * 2 ** n.level, n.ny * 2 ** n.level, n.nz * 2 ** n.level) >= 0;

const child = (n: LevelNode, o: number): LevelNode => ({ level: n.level - 1, nx: 2 * n.nx + (o & 1), ny: 2 * n.ny + ((o >> 1) & 1), nz: 2 * n.nz + ((o >> 2) & 1) });

/** Horizontal box distance (cells) from the nearest focus to a node. */
export function levelNodeDistance(grid: ChunkGrid, foci: readonly Focus[], n: LevelNode): number {
  const size = grid.edge * 2 ** n.level;
  const x0 = n.nx * size;
  const z0 = n.nz * size;
  let best = Infinity;
  for (const f of foci) {
    const dx = Math.max(0, x0 - f.x, f.x - (x0 + size));
    const dz = Math.max(0, z0 - f.z, f.z - (z0 + size));
    best = Math.min(best, dx * dx + dz * dz);
  }
  return Math.sqrt(best);
}

/** The drawn nodes for `c` (see the file comment), and what could not be balanced. */
export function chooseLevels(c: LevelChoice): { readonly drawn: DrawnLevels; readonly stats: LevelChoiceStats } {
  if (c.rings.radii.length < c.maxLevel) throw new RangeError(`${c.rings.radii.length} level radii for ${c.maxLevel} levels`);
  const out = new DrawnLevels(c.grid, c.maxLevel);
  const dist = (n: LevelNode): number => (c.foci.length === 0 ? Infinity : levelNodeDistance(c.grid, c.foci, n));
  const ready = (n: LevelNode): boolean => c.ready(n.level, n.nx, n.ny, n.nz);
  /** A finer level stands in for a coarser one only within one node of the next level past its own ring (and the hysteresis once it does). */
  const standIn = (n: LevelNode): boolean => {
    if (n.level >= c.maxLevel) return true;
    const kept = c.previous?.drawn(n.level, n.nx, n.ny, n.nz) === true ? c.rings.hysteresis : 0;
    return dist(n) < c.rings.radii[n.level]! + c.grid.edge * 2 ** (n.level + 1) + kept;
  };

  /** Covers node n into `list`; true when every part of it is covered. */
  const cover = (n: LevelNode, list: LevelNode[], asStandIn: boolean): boolean => {
    if (!inWorld(c.grid, n) || (asStandIn && !standIn(n))) return false;
    if (n.level === 0) {
      if (!ready(n)) return false;
      list.push(n);
      return true;
    }
    const r = c.rings.radii[n.level - 1]! + (c.previous?.wasSplit(n.level, n.nx, n.ny, n.nz) === true ? c.rings.hysteresis : 0);
    const split = dist(n) < r;
    if (split) out.markSplit(n);
    const kids: LevelNode[] = [];
    let all = true;
    if (split || !ready(n)) {
      for (let o = 0; o < 8; o++) {
        const k = child(n, o);
        if (inWorld(c.grid, k) && !cover(k, kids, asStandIn || !split)) all = false;
      }
    }
    if (split && all) {
      list.push(...kids);
      return true;
    }
    if (ready(n)) {
      list.push(n);
      return true;
    }
    list.push(...kids);
    return all;
  };

  const list: LevelNode[] = [];
  for (const root of c.roots) cover(root, list, false);
  for (const n of list) out.add(n);
  return { drawn: out, stats: { unbalanced: balance(out, c, ready) } };
}

/** The drawn levels across one face of node n (the layer of its same-size neighbour against the face). */
function finerAcross(drawn: DrawnLevels, n: LevelNode, f: number, below: number): boolean {
  const axis = f >> 1;
  const m = [n.nx, n.ny, n.nz];
  m[axis]! += f & 1 ? 1 : -1;
  const inPlane = [0, 1, 2].filter((a) => a !== axis);
  for (let l = 0; l <= below; l++) {
    const s = 2 ** (n.level - l);
    for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) {
      const c = [0, 0, 0];
      c[axis] = f & 1 ? m[axis]! * s : m[axis]! * s + s - 1;
      c[inPlane[0]!] = m[inPlane[0]!]! * s + i;
      c[inPlane[1]!] = m[inPlane[1]!]! * s + j;
      if (drawn.drawn(l, c[0]!, c[1]!, c[2]!)) return true;
    }
  }
  return false;
}

/** Splits drawn nodes that face nodes two or more levels finer while their children are ready; returns the faces left so. */
function balance(drawn: DrawnLevels, c: LevelChoice, ready: (n: LevelNode) => boolean): number {
  let unbalanced = 0;
  const queue = [...drawn.nodes()].filter((n) => n.level >= 2).sort((a, b) => b.level - a.level);
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (!drawn.drawn(n.level, n.nx, n.ny, n.nz)) continue;
    let bad = false;
    for (let f = 0; f < 6 && !bad; f++) bad = finerAcross(drawn, n, f, n.level - 2);
    if (!bad) continue;
    const kids: LevelNode[] = [];
    for (let o = 0; o < 8; o++) {
      const k = child(n, o);
      if (inWorld(c.grid, k)) kids.push(k);
    }
    if (!kids.every(ready)) {
      unbalanced++;
      continue;
    }
    drawn.remove(n);
    for (const k of kids) {
      drawn.add(k);
      if (k.level >= 2) queue.push(k);
    }
    // Its coarser neighbours may now face nodes two levels finer.
    for (let f = 0; f < 6; f++) {
      const m = [n.nx, n.ny, n.nz];
      m[f >> 1]! += f & 1 ? 1 : -1;
      const up = { level: n.level + 1, nx: m[0]! >> 1, ny: m[1]! >> 1, nz: m[2]! >> 1 };
      if (up.level <= c.maxLevel && drawn.drawn(up.level, up.nx, up.ny, up.nz)) queue.push(up);
    }
  }
  return unbalanced;
}
