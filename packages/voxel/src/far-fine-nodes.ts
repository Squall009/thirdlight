/**
 * The far field's fine nodes (far-fine.ts): the selection's index with the
 * fine levels, making a fine node (its block read from the streamer's
 * chunks and packed for the page), and what an edit or a change of the
 * resident chunks does to them. The far field (far-field.ts) holds one and
 * gives it the few parts of its state these need.
 */
import type { ChunkCoord, ChunkGrid } from './coords';
import { gatherFarCells } from './far-bricks-faces';
import { FAR_FINE_RESELECT_MS, farFineChunks, farFineDirty, FarFineIndex, farFineScale, isFarFine, packFarFine, type FarFineCells, type FarFineHost } from './far-fine';
import type { FarNodeIndex } from './far-tree';
import { mipNodeKey, type MipNode } from './voxel-mips';
import { SampleRing } from './worker-pool';

/** What the fine nodes take from the far field. */
export interface FarFineNodesHost {
  readonly grid: ChunkGrid;
  /** Where fine nodes' cells come from (absent: no fine nodes). */
  readonly fine: FarFineHost | undefined;
  /** Whether fine nodes are asked for (the option on, the bricks mode). */
  wanted(): boolean;
  /** Whether a node is drawn now or in the target. */
  held(key: string): boolean;
  /** A node's draw is to be made again (its old one stays until then). */
  remake(key: string): void;
  /** A fine node made: its block (null: it draws nothing). */
  made(key: string, fine: FarFineCells | null): void;
  /** The work's order changed: made again, and pumped. */
  rework(): void;
  /** Select again at the next update. */
  reselect(): void;
}

export class FarFineNodes {
  /** The selection's index with the fine levels (null: before the far index is read, or no fine host). */
  private index: FarFineIndex | null = null;
  /** ms a fine node's block took to read on the world's thread. */
  readonly ms = new SampleRing();
  readonly counters = { made: 0, empty: 0, edits: 0 };
  private reselectAt = -Infinity;

  constructor(private readonly host: FarFineNodesHost) {}

  /** The far index was read: the fine levels go under it. */
  setIndex(idx: FarNodeIndex): void {
    if (this.host.fine !== undefined) this.index = new FarFineIndex(idx, this.host.fine);
  }

  /** Whether fine nodes are asked for (they may not be drawn yet: the index is read first). */
  get wanted(): boolean {
    return this.host.wanted() && this.host.fine !== undefined;
  }

  /** Whether fine nodes are selected and drawn now. */
  get on(): boolean {
    return this.host.wanted() && this.index !== null;
  }

  /** The index the selection walks while {@link on}. */
  get selectIndex(): FarFineIndex | null {
    return this.on ? this.index : null;
  }

  /** Whether the tree holds a fine node (one of its chunks holds anything); null: not a fine node, or fine nodes off. */
  has(n: MipNode): boolean | null {
    return this.on && isFarFine(n) ? this.index!.has(n) : null;
  }

  /**
   * Chunks were edited (the world's files, or a run-time edit over them): every fine node whose block reads one is
   * made again from the edited cells and replaced alone (its old draw stays until then).
   */
  changed(chunks: readonly ChunkCoord[]): void {
    if (chunks.length === 0 || !this.on) return;
    let any = false;
    for (const n of farFineDirty(chunks)) {
      const key = mipNodeKey(n);
      if (!this.host.held(key)) continue;
      any = true;
      this.host.remake(key);
    }
    if (!any) return;
    this.counters.edits++;
    this.host.rework();
  }

  /** The chunks resident round the focus changed: fine nodes may open or must close (selected again, now and then). */
  residency(): void {
    if (!this.on) return;
    const now = performance.now();
    if (now - this.reselectAt < FAR_FINE_RESELECT_MS) return;
    this.reselectAt = now;
    this.host.reselect();
  }

  /**
   * Makes a fine node: its block read from the streamer's chunks and packed for the page; the ms taken. Not made
   * while a chunk it reads is not resident (it left since the selection): the selection is made again instead.
   */
  make(n: MipNode, key: string): number {
    const t0 = performance.now();
    const host = this.host.fine!;
    const { min, max } = farFineChunks(n);
    for (let cx = min[0]; cx <= max[0]; cx++) for (let cy = min[1]; cy <= max[1]; cy++) for (let cz = min[2]; cz <= max[2]; cz++) {
      if (host.resident(cx, cy, cz)) continue;
      this.reselectAt = -Infinity;
      this.residency();
      return performance.now() - t0;
    }
    const packed = packFarFine(gatherFarCells(this.host.grid, host.cells, [n.nx, n.ny, n.nz], farFineScale(n.level)));
    const ms = performance.now() - t0;
    this.ms.add(ms);
    this.counters.made++;
    if (packed === null) this.counters.empty++;
    this.host.made(key, packed);
    return ms;
  }
}
