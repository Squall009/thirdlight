/**
 * The far field's GPU bytes: what its drawn nodes hold where they are drawn,
 * what the nodes made lately came to, and from those how much a node not
 * made yet is foreseen to hold (its stored bytes times the made nodes'
 * ratio). The far field's selection spends its GPU budget by these.
 */
import { mipNodeKey, type MipNode } from './voxel-mips';

/**
 * GPU bytes a node is foreseen to hold a stored byte before any node was made (then the made nodes' own ratio):
 * the 8 km test world's bricks, 69–71 from its town and along a flight (a small test world's ~180).
 */
export const FAR_GPU_PER_STORED_BYTE = 70;

/** Made nodes whose GPU bytes the ledger remembers (~100 bytes each). */
const FAR_KNOWN_GPU_NODES = 65_536;

/** The made nodes' ratio moved this share off what the last selection foresaw with: select again. */
const FAR_GPU_RATIO_RESELECT = 0.25;

export class FarGpuLedger {
  /** GPU bytes of each drawn node, and their sum. */
  private readonly shown = new Map<string, number>();
  private shownSum = 0;
  /**
   * GPU bytes of the nodes made lately (most recent last): the selection counts them as they are, since a node's
   * stored bytes foretell its GPU bytes only loosely (its surface, not its cells).
   */
  private readonly known = new Map<string, number>();
  /** GPU and stored bytes of every node made. */
  private madeGpu = 0;
  private madeStored = 0;
  /** The ratio the last selection foresaw with. */
  private selectedRatio = FAR_GPU_PER_STORED_BYTE;
  /** The last selection's foreseen GPU bytes and the nodes it held closed for a budget. */
  selected = 0;
  held = 0;
  /** Selections made again for one eye because what came in was over the budget. */
  overReselects = 0;

  /** GPU bytes a stored byte of the nodes made so far (before any: {@link FAR_GPU_PER_STORED_BYTE}). */
  get ratio(): number {
    return this.madeStored > 0 ? this.madeGpu / this.madeStored : FAR_GPU_PER_STORED_BYTE;
  }

  /** GPU bytes of the drawn nodes. */
  get drawn(): number {
    return this.shownSum;
  }

  /** A selection starts: how it foresees a node's GPU bytes from its stored bytes. */
  foresee(): (n: MipNode, storedBytes: number) => number {
    const ratio = this.ratio;
    this.selectedRatio = ratio;
    return (n, stored) => this.known.get(mipNodeKey(n)) ?? stored * ratio;
  }

  /** A node was made; true when the made nodes' ratio moved far enough off the selection's to select again. */
  made(key: string, gpu: number, storedBytes: number): boolean {
    this.known.delete(key);
    this.known.set(key, gpu);
    if (this.known.size > FAR_KNOWN_GPU_NODES) this.known.delete(this.known.keys().next().value!);
    this.madeGpu += gpu;
    this.madeStored += storedBytes;
    return Math.abs(this.ratio / this.selectedRatio - 1) > FAR_GPU_RATIO_RESELECT;
  }

  show(key: string, gpu: number): void {
    this.shownSum += gpu - (this.shown.get(key) ?? 0);
    this.shown.set(key, gpu);
  }

  unshow(key: string): void {
    this.shownSum -= this.shown.get(key) ?? 0;
    this.shown.delete(key);
  }
}
