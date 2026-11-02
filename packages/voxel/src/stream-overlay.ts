/**
 * What the streamer needs to lay its runtime overlay over the base store
 * outside a plain read: a chunk's merged content as a job payload, a worker
 * edit's whole chunks turned back into overrides, and a chunk's base read
 * from the world's files again when a save needs it after the chunk left.
 */
import { exportOrAir } from './cell-delta';
import type { ChunkPayload } from './chunk-wire';
import { chunkKey, type ChunkCoord } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import type { DirtyTracker } from './dirty-tracker';
import { createWorldStore, type PaletteStore } from './palette-store';
import { readValue, type VoxelRecord } from './record';
import type { ChunkSource } from './region-source';
import type { LoadInput, LoadOutput } from './stream-job';
import type { VoxelOverlay } from './voxel-overlay';
import type { WorkerPool } from './worker-pool';

export class OverlayMerge {
  /** Scratch store a chunk is merged in (empty between uses). */
  private readonly scratch: PaletteStore;
  private readonly cells: DenseChunk;
  private readonly v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

  constructor(
    private readonly base: PaletteStore,
    private readonly overlay: VoxelOverlay,
  ) {
    this.scratch = createWorldStore(base.grid, 'merge');
    this.cells = createDenseChunk(base.grid);
  }

  /**
   * A resident chunk's content with its overrides laid over it, as a job
   * payload (its own arrays). Without overrides it is the base's payload;
   * with, the base's arrays are copied and only the overridden cells written.
   */
  payload(cx: number, cy: number, cz: number): ChunkPayload {
    const o = this.overlay.chunkOverrides(cx, cy, cz);
    if (o === null) return this.base.chunkPayload(cx, cy, cz, true);
    const m = this.scratch;
    m.adoptPayload(cx, cy, cz, this.base.chunkPayload(cx, cy, cz, true));
    const g = this.base.grid;
    const s = g.shift;
    for (let k = 0; k < o.count; k++) {
      const i = o.cells[k]!;
      m.setVoxel((cx << s) | (i >>> (s << 1)), (cy << s) | (i & g.mask), (cz << s) | ((i >>> s) & g.mask), readValue(o.values[k]!, this.v));
    }
    // Handing the arrays over leaves the scratch store empty again.
    return m.chunkPayload(cx, cy, cz, false);
  }

  /** A worker edit answers whole chunks: the overlay keeps the cells that differ from the base. */
  adoptEdited(cx: number, cy: number, cz: number, p: ChunkPayload): void {
    this.scratch.adoptPayload(cx, cy, cz, p);
    exportOrAir(this.scratch, cx, cy, cz, this.cells);
    this.scratch.dropChunk(cx, cy, cz);
    this.overlay.importChunk(cx, cy, cz, this.cells);
  }
}

/** What reading base chunks again needs from the streamer. */
export interface BaseReader {
  readonly gridId: number;
  readonly source: ChunkSource;
  readonly pool: WorkerPool;
  readonly tracker: DirtyTracker;
}

/**
 * Reads chunks' base content from the source into `into` (stored chunks
 * decoded in workers). Rejects when a chunk cannot be read or decoded: a
 * save must not be made against a base it does not have.
 */
export async function readBaseChunks(list: readonly ChunkCoord[], into: PaletteStore, r: BaseReader): Promise<void> {
  const grid = into.grid;
  const reads = await r.source.read(list);
  await Promise.all(
    list.map(async (c, i) => {
      const read = reads[i]!;
      if (read.kind === 'damaged') throw new Error(`the base of chunk (${c.cx}, ${c.cy}, ${c.cz}) cannot be read: ${read.reason}`);
      if (read.kind === 'air') return;
      if (read.kind === 'uniform') {
        into.adoptPayload(c.cx, c.cy, c.cz, { form: 'uniform', value: read.value });
        return;
      }
      // The id only routes the reply: the base is the files' content, which no edit here changes.
      const id = r.tracker.beginJob({ grid: r.gridId, key: chunkKey(grid, c.cx, c.cy, c.cz) }).id;
      r.tracker.expireJob(id);
      const stored = read.bytes.slice();
      const input: LoadInput = { edge: grid.edge, chunk: { grid: r.gridId, cx: c.cx, cy: c.cy, cz: c.cz }, bytes: { stored, raw: read.raw }, hash: false };
      const o = await r.pool.submit<LoadOutput>({ id, kind: 'load', lane: 'far', distance: 0, input, transfer: [stored.buffer as ArrayBuffer] });
      if (o.status !== 'done') throw new Error(`the base of chunk (${c.cx}, ${c.cy}, ${c.cz}) did not load (${o.status})`);
      into.adoptPayload(c.cx, c.cy, c.cz, o.output.payload);
    }),
  );
}
