/**
 * Voxel mips for the chunk tree (DRAFT): level L of the tree holds voxels
 * of 0.5 m × 2^L, one node per 2^L chunks a side, each node a chunk-shaped
 * block of edge³ voxels. A parent node is made from its 8 children (the
 * nodes one level down; at level 1, chunks) by a 2 × 2 × 2 downsample:
 *
 * - **density** is the mean of the 8 cells' shapes (air 0, full 255, a
 *   surface cell its density byte), rounded;
 * - **material** is the dominant one: the material with the largest summed
 *   density among the 8 (ties: the lower id); air when the mean rounds to 0;
 * - **category** and orientation come from the first cell (in local-index
 *   order) of the dominant material.
 *
 * A node therefore has the same form as a chunk (the same planes, the same
 * palette store and codec), so it streams, compresses and meshes with the
 * same code. Paint colour folding waits for paint storage.
 *
 * An edit marks the nodes above every changed chunk stale, level by level
 * ({@link MipStaleSet}); the editor rebuilds them in the background, a
 * running game only the low levels near the edit.
 */
import { localIndex, type ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import { OCCUPANCY } from './derived-data';
import { MATERIAL_AIR, SHAPE_EMPTY } from './record';

/** A node of the chunk tree: level (0 = a chunk) and its coordinates at that level. */
export interface MipNode {
  readonly level: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** The node at `level` above chunk (cx, cy, cz). */
export function mipNodeOf(cx: number, cy: number, cz: number, level: number): MipNode {
  return { level, nx: cx >> level, ny: cy >> level, nz: cz >> level };
}

/** A node's key within its level (for sets and maps). */
export function mipNodeKey(n: MipNode): string {
  return `${n.level}:${n.nx},${n.ny},${n.nz}`;
}

/** The 8 children of a node (level − 1), in octant order (bit 0 x, bit 1 y, bit 2 z). */
export function mipChildren(n: MipNode): MipNode[] {
  if (n.level < 1) throw new RangeError('a chunk (level 0) has no children');
  const out: MipNode[] = [];
  for (let o = 0; o < 8; o++) out.push({ level: n.level - 1, nx: 2 * n.nx + (o & 1), ny: 2 * n.ny + ((o >> 1) & 1), nz: 2 * n.nz + ((o >> 2) & 1) });
  return out;
}

/**
 * Downsamples 8 children (octant order; null = all air) into `out`, a node
 * of the same edge. Returns false when the parent is all air (`out` is
 * then air too).
 */
export function downsampleMip(grid: ChunkGrid, children: ReadonlyArray<DenseChunk | null>, out: DenseChunk): boolean {
  if (children.length !== 8) throw new RangeError('a mip node has 8 children');
  const e = grid.edge;
  const h = e >> 1;
  const mats = new Uint16Array(8);
  const dens = new Uint16Array(8);
  const firsts = new Int32Array(8);
  let any = false;
  for (let o = 0; o < 8; o++) {
    const child = children[o] ?? null;
    const ox = (o & 1) * h;
    const oy = ((o >> 1) & 1) * h;
    const oz = ((o >> 2) & 1) * h;
    for (let x = 0; x < h; x++) for (let z = 0; z < h; z++) for (let y = 0; y < h; y++) {
      const pi = localIndex(grid, ox + x, oy + y, oz + z);
      if (child === null) {
        out.material[pi] = MATERIAL_AIR;
        out.category[pi] = 0;
        out.shape[pi] = SHAPE_EMPTY;
        out.orientation[pi] = 0;
        continue;
      }
      let sum = 0;
      let k = 0;
      for (let c = 0; c < 8; c++) {
        const ci = localIndex(grid, 2 * x + (c & 1), 2 * y + ((c >> 1) & 1), 2 * z + ((c >> 2) & 1));
        const m = child.material[ci]!;
        if (m === MATERIAL_AIR) continue;
        const d = child.shape[ci]!;
        sum += d;
        // The cell's weight under its material, keeping the first cell of each material.
        let j = 0;
        while (j < k && mats[j] !== m) j++;
        if (j === k) {
          mats[k] = m;
          dens[k] = 0;
          firsts[k] = ci;
          k++;
        }
        dens[j]! += d;
      }
      const mean = Math.round(sum / 8);
      if (k === 0 || mean === 0) {
        out.material[pi] = MATERIAL_AIR;
        out.category[pi] = 0;
        out.shape[pi] = SHAPE_EMPTY;
        out.orientation[pi] = 0;
        continue;
      }
      let best = 0;
      for (let j = 1; j < k; j++) if (dens[j]! > dens[best]! || (dens[j] === dens[best] && mats[j]! < mats[best]!)) best = j;
      const m = mats[best]!;
      const first = firsts[best]!;
      out.material[pi] = m;
      out.category[pi] = child.category[first]!;
      out.orientation[pi] = child.orientation[first]!;
      out.shape[pi] = mean;
      any = true;
    }
  }
  return any;
}

/**
 * The tree nodes made stale by changed chunks, per level up to a highest
 * level: every ancestor of a changed chunk, once.
 */
export class MipStaleSet {
  private readonly stale = new Map<string, MipNode>();

  constructor(readonly maxLevel: number) {
    if (!Number.isInteger(maxLevel) || maxLevel < 1) throw new RangeError(`highest mip level ${maxLevel}`);
  }

  /** Marks the ancestors of changed chunks stale (levels 1 … maxLevel). */
  markChanged(chunks: Iterable<{ readonly cx: number; readonly cy: number; readonly cz: number }>): void {
    for (const c of chunks) for (let l = 1; l <= this.maxLevel; l++) {
      const n = mipNodeOf(c.cx, c.cy, c.cz, l);
      this.stale.set(mipNodeKey(n), n);
    }
  }

  /** Stale nodes, lowest level first (a parent is rebuilt after its children), then by coordinates. */
  nodes(maxLevel = this.maxLevel): MipNode[] {
    return [...this.stale.values()].filter((n) => n.level <= maxLevel).sort((a, b) => a.level - b.level || a.nx - b.nx || a.ny - b.ny || a.nz - b.nz);
  }

  /** Clears a node once rebuilt. */
  rebuilt(n: MipNode): void {
    this.stale.delete(mipNodeKey(n));
  }

  get size(): number {
    return this.stale.size;
  }
}

/**
 * Solid/empty/mixed flags ({@link OCCUPANCY}) of every chunk-tree node, so
 * culling, rays and the far field skip whole empty or whole solid subtrees
 * without reading voxels. A chunk's flag is its derived occupancy flag (a
 * chunk never given one, all air, is empty); a node above is empty when all
 * 8 children are, solid when all 8 are, and mixed otherwise.
 *
 * A chunk whose flag changes marks its ancestors stale (the same
 * {@link MipStaleSet} the mips use); a read refreshes stale nodes first,
 * lowest level first, so a flag read is never stale.
 */
export class ChunkTreeFlags {
  private readonly flags = new Map<string, number>();
  private readonly stale: MipStaleSet;

  constructor(readonly maxLevel: number) {
    this.stale = new MipStaleSet(maxLevel);
  }

  /** Sets a chunk's flag (its derived occupancy flag); marks its ancestors stale when it changed. */
  setChunk(cx: number, cy: number, cz: number, flag: number): void {
    if (flag !== OCCUPANCY.empty && flag !== OCCUPANCY.solid && flag !== OCCUPANCY.mixed) throw new RangeError(`occupancy flag ${flag}`);
    const key = mipNodeKey(mipNodeOf(cx, cy, cz, 0));
    if ((this.flags.get(key) ?? OCCUPANCY.empty) === flag) return;
    if (flag === OCCUPANCY.empty) this.flags.delete(key);
    else this.flags.set(key, flag);
    this.stale.markChanged([{ cx, cy, cz }]);
  }

  /** Nodes waiting to be refreshed (lowest level first). */
  staleNodes(): MipNode[] {
    return this.stale.nodes();
  }

  /** Recomputes every stale node from its children, lowest level first; returns the nodes whose flag changed. */
  refresh(): MipNode[] {
    const changed: MipNode[] = [];
    for (const n of this.stale.nodes()) {
      let empty = 0;
      let solid = 0;
      for (const c of mipChildren(n)) {
        const f = this.flags.get(mipNodeKey(c)) ?? OCCUPANCY.empty;
        if (f === OCCUPANCY.empty) empty++;
        else if (f === OCCUPANCY.solid) solid++;
      }
      const flag = empty === 8 ? OCCUPANCY.empty : solid === 8 ? OCCUPANCY.solid : OCCUPANCY.mixed;
      const key = mipNodeKey(n);
      if ((this.flags.get(key) ?? OCCUPANCY.empty) !== flag) changed.push(n);
      if (flag === OCCUPANCY.empty) this.flags.delete(key);
      else this.flags.set(key, flag);
      this.stale.rebuilt(n);
    }
    return changed;
  }

  /** A node's flag (level 0: a chunk), refreshed first when anything below it changed. */
  flagOf(n: MipNode): number {
    if (n.level > this.maxLevel) throw new RangeError(`level ${n.level} is above the highest level ${this.maxLevel}`);
    if (this.stale.size > 0) this.refresh();
    return this.flags.get(mipNodeKey(n)) ?? OCCUPANCY.empty;
  }
}
