/**
 * Deriving a node of the chunk tree (voxel-mips.ts) at any level through
 * the same assembly rules and the same mesher as a chunk.
 *
 * A level-L node is a chunk-shaped block of cells 0.5 m × 2^L a side, so a
 * level reads like a store of chunks: node (nx, ny, nz) of level L is
 * "chunk" (nx, ny, nz) of that level's view, and its apron comes from the
 * neighbouring nodes of the same level exactly as a chunk's comes from its
 * neighbours. The derive then runs unchanged (`deriveWithApron`): the rule
 * set's thresholds and reach, the mesher's lattice, crease and section rules
 * and the 34³ shader grid (the node's cells and a one-cell border of its
 * neighbours' cells, dominant material) are all in cells, whatever their
 * size. The result records its level; positions are in the node's cells
 * from one cell below its corner, so a vertex at p steps lies at
 * ((n · E − 1) · steps + p) / steps cells of the level, × `mipCellMetres(L)`
 * metres, along each axis.
 *
 * The tree here is built on demand from a level-0 source and kept per
 * node (what a bench or a test reads; the streamer builds nodes in workers
 * from resident chunks and passes a node's cells and apron to the same
 * derive).
 */
import { jobRadius, type AssemblyRuleSet } from './assembly';
import { buildApron } from './apron';
import { localIndex, type ChunkGrid } from './coords';
import { copyDenseChunk, createDenseChunk, type DenseChunk } from './dense-chunk';
import type { DerivedData, DeriveTimes } from './derived-data';
import { deriveWithApron } from './derive-assembly';
import { mipChildren, mipNodeKey, downsampleMip, type MipNode } from './voxel-mips';
import type { VoxelRecord } from './record';
import type { VoxelStoreCandidate } from './store';

/** What a mip tree reads its level-0 chunks from. */
export type MipSource = Pick<VoxelStoreCandidate, 'grid' | 'exportChunk'>;

/** One level of the tree read like a store of chunks (what an apron and a derive read). */
export interface MipLevelView {
  readonly level: number;
  readonly grid: ChunkGrid;
  /** The voxel at a cell of this level (cells of 0.5 m × 2^level). */
  voxelAt(x: number, y: number, z: number, out: VoxelRecord): VoxelRecord;
  /** A node's form: absent (all air) or stored. */
  chunkForm(nx: number, ny: number, nz: number): 'absent' | 'stored';
  /** Writes a node's cells into `out`; false (and `out` untouched) when it is all air. */
  exportChunk(nx: number, ny: number, nz: number, out: DenseChunk): boolean;
}

/**
 * The chunk tree over a level-0 source, built on demand: a node is
 * downsampled from its 8 children (which are built first) and kept until
 * {@link MipTree.clear}. Level 0 reads the source each time.
 */
export class MipTree {
  private readonly nodes = new Map<string, DenseChunk | null>();

  constructor(readonly source: MipSource) {}

  get grid(): ChunkGrid {
    return this.source.grid;
  }

  /** A node's cells (null: all air). Level 0 is the source's chunk, read into a fresh block. */
  node(n: MipNode): DenseChunk | null {
    if (n.level === 0) {
      const c = createDenseChunk(this.grid);
      return this.source.exportChunk(n.nx, n.ny, n.nz, c) ? c : null;
    }
    const key = mipNodeKey(n);
    const known = this.nodes.get(key);
    if (known !== undefined) return known;
    const out = createDenseChunk(this.grid);
    const built = downsampleMip(this.grid, mipChildren(n).map((c) => this.node(c)), out) ? out : null;
    this.nodes.set(key, built);
    return built;
  }

  /** Nodes kept (levels ≥ 1). */
  get size(): number {
    return this.nodes.size;
  }

  /** Forgets every kept node (after an edit of the source, or to free memory). */
  clear(): void {
    this.nodes.clear();
  }

  /** Level `level` read like a store of chunks. */
  level(level: number): MipLevelView {
    if (!Number.isInteger(level) || level < 0) throw new RangeError(`chunk-tree level ${level}`);
    const grid = this.grid;
    const zero = level === 0 ? createDenseChunk(grid) : null;
    // The last node read: an apron reads a neighbour's strip cell after cell.
    let last: DenseChunk | null = null;
    let lx = 0, ly = 0, lz = 0;
    let has = false;
    const at = (nx: number, ny: number, nz: number): DenseChunk | null => {
      if (has && nx === lx && ny === ly && nz === lz) return last;
      last = zero !== null ? (this.source.exportChunk(nx, ny, nz, zero) ? zero : null) : this.node({ level, nx, ny, nz });
      lx = nx;
      ly = ny;
      lz = nz;
      has = true;
      return last;
    };
    return {
      level,
      grid,
      voxelAt: (x, y, z, out) => {
        const c = at(x >> grid.shift, y >> grid.shift, z >> grid.shift);
        const i = localIndex(grid, x & grid.mask, y & grid.mask, z & grid.mask);
        out.material = c === null ? 0 : c.material[i]!;
        out.role = c === null ? 0 : c.role[i]!;
        out.shape = c === null ? 0 : c.shape[i]!;
        out.wetness = c === null ? 0 : c.wetness[i]!;
        return out;
      },
      chunkForm: (nx, ny, nz) => (at(nx, ny, nz) === null ? 'absent' : 'stored'),
      exportChunk: (nx, ny, nz, out) => {
        const c = at(nx, ny, nz);
        if (c === null) return false;
        if (c !== out) copyDenseChunk(c, out);
        return true;
      },
    };
  }
}

/**
 * Derives node `n` of the tree with `rules`: its cells and an apron of the
 * same level's neighbours, through the chunk derive. The result's `level`
 * is the node's.
 */
export function deriveMipNode(tree: MipTree, n: MipNode, rules: AssemblyRuleSet, times?: DeriveTimes): DerivedData {
  const view = tree.level(n.level);
  const apron = buildApron(view, n.nx, n.ny, n.nz, jobRadius(rules));
  return deriveWithApron(tree.grid, rules, apron, (out) => view.exportChunk(n.nx, n.ny, n.nz, out), times, n.level);
}
