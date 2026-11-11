/**
 * A batch of a world's draws (`@thirdlight/voxel` chunk-batch.ts) made over
 * as many frames as it needs and shown in one.
 *
 * A batch is everything one streamer task changed: an edit's swap, a change
 * of the levels drawn with its seams, a node's new result. What it changes
 * must change between the same two frames (no frame shows half an edit, a
 * level half swapped or a seam beside the draw it no longer matches). Making
 * a draw is what costs: unpacking its surfaces into float geometry, placing
 * its kit pieces, uploading its shader grid. Showing it is adding a group
 * and writing the piece draws. So a stage makes the batch's draws hidden,
 * entry by entry, for as long as its caller's budget allows
 * ({@link VoxelBatchStage.prepare}), and shows them all in one task once
 * every one is made ({@link VoxelBatchStage.commit}): removals, shader-only
 * changes, the draws, then the seams and the far field's change, in the
 * batch's order. Until then the view draws what it drew before, so a big
 * swap is late by a few frames instead of one frame being long.
 */
import { FRAME_RATE_CAPS } from '@thirdlight/project-model';
import type { ChunkDrawBatch } from '@thirdlight/voxel';
import type { VoxelBatchApplied, VoxelChunkView, VoxelPreparedDraw } from './voxel-chunk-view';

/**
 * The share of the page's frame interval a frame may spend making staged
 * draws: the page's own render, the simulation's messages and the far
 * field's feedback keep the rest. At a 30 Hz cap that is ~8 ms of 33, at
 * 60 Hz ~4 ms of 17; a whole swap at the town took 80–131 ms in one task.
 */
export const VOXEL_BATCH_FRAME_SHARE = 0.25;

/** The longest frame interval the budget is taken from: the slowest frame-rate cap's (a hidden page's frames come seconds apart). */
const SLOWEST_FRAME_MS = 1000 / Math.min(...FRAME_RATE_CAPS);

/** Milliseconds a frame may spend making staged draws at a frame interval (unknown: the slowest cap's). */
export function voxelBatchFrameMs(intervalMs: number | null): number {
  const interval = intervalMs === null || !(intervalMs > 0) ? SLOWEST_FRAME_MS : Math.min(intervalMs, SLOWEST_FRAME_MS);
  return VOXEL_BATCH_FRAME_SHARE * interval;
}

export class VoxelBatchStage {
  /** Entries made so far (the batch's chunk entries, in order). */
  private next = 0;
  private readonly made: Array<VoxelPreparedDraw | undefined> = [];
  private settled = false;
  /** Times {@link prepare} was called (the frames the batch took, when called once a frame). */
  steps = 0;

  constructor(
    readonly view: VoxelChunkView,
    readonly batch: ChunkDrawBatch,
  ) {}

  /** Whether every entry's draw is made. */
  get ready(): boolean {
    return this.next >= this.batch.chunks.length;
  }

  /** Entries made, and in the batch. */
  get progress(): { readonly made: number; readonly of: number } {
    return { made: this.next, of: this.batch.chunks.length };
  }

  /**
   * Makes the next entries' draws, hidden, at least one, then more while
   * `more()` is true; true once every one is made. Shader-only changes and
   * removals change what is drawn, so they wait for the commit.
   */
  prepare(more: () => boolean): boolean {
    if (this.settled) throw new Error('voxel batch stage: already committed or discarded');
    this.steps++;
    const chunks = this.batch.chunks;
    while (this.next < chunks.length) {
      const c = chunks[this.next]!;
      if (c.kind === 'draw') {
        if (c.cells !== undefined) this.view.cells.set(c.cells);
        this.made[this.next] = this.view.prepare(c.cx, c.cy, c.cz, { ground: c.ground!, base: c.base!, ...(c.caster !== undefined ? { caster: c.caster } : {}), instances: c.instances!, solid: c.solid ?? 0 }, c.level ?? 0);
      }
      this.next++;
      if (!more()) break;
    }
    return this.ready;
  }

  /** Shows the whole batch in this task (making whatever is left first). */
  commit(): VoxelBatchApplied {
    if (!this.ready) this.prepare(() => true);
    this.settled = true;
    const view = this.view;
    const b = this.batch;
    return view.inBatch(() => {
      const chunkBytes: number[] = [];
      let replaced = 0;
      b.chunks.forEach((c, i) => {
        const level = c.level ?? 0;
        replaced++;
        if (c.kind === 'remove') {
          view.remove(c.cx, c.cy, c.cz, level);
          return;
        }
        let n: number;
        if (c.kind === 'shader') {
          if (c.cells !== undefined) view.cells.set(c.cells);
          n = view.setShader(c.cx, c.cy, c.cz, c.solid ?? 0, level);
        } else n = view.commit(this.made[i]!);
        if (level === 0) chunkBytes.push(c.cx, c.cy, c.cz, n);
      });
      this.made.length = 0;
      let seams = 0;
      for (const s of b.seams ?? []) {
        seams++;
        if (s.kind === 'remove') view.removeSeam(s.level, s.nx, s.ny, s.nz, s.face);
        else view.setSeam(s.level, s.nx, s.ny, s.nz, s.face, s.pieces ?? null);
      }
      view.far.apply(b.far, b.nearCover);
      return { chunkBytes, coarseBytes: view.coarseBytes(), replaced, seams, farBytes: view.far.bytes };
    });
  }

  /** Lets go of the draws made and not shown (the world closed before the batch was). */
  discard(): void {
    if (this.settled) return;
    this.settled = true;
    for (const p of this.made) if (p !== undefined) this.view.discard(p);
    this.made.length = 0;
  }
}

/**
 * Applies one batch of a world's draws to its view, all in this task: the
 * chunks' and nodes' draws, shader data and removals, then the seams. A
 * change of the levels drawn arrives whole in one batch, so the old level
 * stays drawn until the frame after the new one is complete.
 */
export function applyChunkDrawBatch(view: VoxelChunkView, b: ChunkDrawBatch): VoxelBatchApplied {
  return new VoxelBatchStage(view, b).commit();
}
