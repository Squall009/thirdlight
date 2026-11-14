/**
 * The frame arbiter: the one place the engine's per-frame time slices come
 * from. A system that spreads work over frames (making staged draws,
 * selecting far nodes, building derive jobs, adding collision bodies,
 * merging static cells, clipping decals, preparing the surface cache,
 * placing probes, preparing a loaded scene, making stored scatter's sets,
 * reading far fine nodes' blocks) asks the arbiter how many
 * milliseconds it may spend in this frame or update, instead of keeping a
 * constant of its own; the profiler's budget table shows them beside the
 * categories they are spent in.
 *
 * A slice is a share of the frame interval (the frame-rate cap's) or a fixed
 * number of milliseconds. The defaults are what each system used before it
 * asked the arbiter, so asking changes no pacing; a quality tier's table
 * (project-model's frame budgets) is installed over them where a host knows
 * its tier.
 *
 * One arbiter per thread (each page and worker has its own copy of this
 * module): the page's host installs its tier's slices on the page, the
 * simulation's on its own thread.
 */
import type { SpanCategory } from './profiler';

/** The time slices the arbiter hands out. */
export const FRAME_SLICE_IDS = ['voxelBatch', 'farSelect', 'voxelDerive', 'voxelEditDerive', 'voxelCollisionAdd', 'staticMerge', 'decalClip', 'surfacePrepare', 'probePlace', 'scenePrep', 'scatterBuild', 'farFinePack'] as const;
export type FrameSliceId = (typeof FRAME_SLICE_IDS)[number];

/** One slice: a share of the frame interval, or fixed milliseconds; the budget category it is spent in, and the thread it runs on. */
export interface FrameSlice {
  readonly category: SpanCategory;
  /** `page`: the page's thread; `sim`: the simulation's (a worker, or the page in single-thread mode). */
  readonly thread: 'page' | 'sim';
  /** The share of the frame interval (0–1). */
  readonly share?: number;
  /** Fixed milliseconds (a slice that does not follow the frame rate). */
  readonly ms?: number;
}

/**
 * The slices as the systems had them: making staged voxel draws a quarter of
 * the frame interval (about 8 ms of a 30 Hz frame); far selection 2 ms a task;
 * derive jobs' aprons 2 ms an update, an edit's 8; collision bodies 4 ms an
 * update; static merging and the page's own decal clips 4 ms a frame; the
 * surface cache's charts and trace rings 1 ms, a probe placement 1 ms; a
 * loaded scene's preparation 4 ms a step; stored scatter's sets 4 ms a frame;
 * the far field's fine nodes' blocks 4 ms an update.
 */
export const FRAME_SLICE_DEFAULTS: Readonly<Record<FrameSliceId, FrameSlice>> = Object.freeze({
  voxelBatch: Object.freeze({ category: 'voxelApply', thread: 'page', share: 0.25 }),
  farSelect: Object.freeze({ category: 'voxelStream', thread: 'sim', ms: 2 }),
  voxelDerive: Object.freeze({ category: 'voxelStream', thread: 'sim', ms: 2 }),
  voxelEditDerive: Object.freeze({ category: 'voxelStream', thread: 'sim', ms: 8 }),
  voxelCollisionAdd: Object.freeze({ category: 'physics', thread: 'sim', ms: 4 }),
  staticMerge: Object.freeze({ category: 'props', thread: 'page', ms: 4 }),
  decalClip: Object.freeze({ category: 'props', thread: 'page', ms: 4 }),
  surfacePrepare: Object.freeze({ category: 'lighting', thread: 'page', ms: 1 }),
  probePlace: Object.freeze({ category: 'lighting', thread: 'page', ms: 1 }),
  scenePrep: Object.freeze({ category: 'other', thread: 'sim', ms: 4 }),
  scatterBuild: Object.freeze({ category: 'props', thread: 'page', ms: 4 }),
  farFinePack: Object.freeze({ category: 'voxelStream', thread: 'sim', ms: 4 }),
} satisfies Record<FrameSliceId, FrameSlice>);

/** A slice as a reader of the arbiter gets it: its milliseconds at the interval it was asked at. */
export interface FrameSliceReading extends FrameSlice {
  readonly id: FrameSliceId;
  /** Milliseconds at the current frame interval (null: a share and no interval known yet). */
  readonly msNow: number | null;
}

export class FrameArbiter {
  private slices: Readonly<Record<FrameSliceId, FrameSlice>> = FRAME_SLICE_DEFAULTS;
  private interval: number | null = null;

  /** A tier's slices replace the current ones (every id must be there). */
  install(slices: Readonly<Record<FrameSliceId, FrameSlice>>): void {
    this.slices = slices;
  }

  /** The frame interval (ms) the host draws at now (null: not known). */
  setInterval(ms: number | null): void {
    this.interval = ms !== null && ms > 0 && Number.isFinite(ms) ? ms : null;
  }

  get intervalMs(): number | null {
    return this.interval;
  }

  /** The milliseconds a slice may take now; a share slice at `intervalMs`, else at the interval the host set. */
  sliceMs(id: FrameSliceId, intervalMs?: number): number {
    const s = this.slices[id];
    if (s.ms !== undefined) return s.ms;
    const interval = intervalMs ?? this.interval;
    if (interval === null || !(interval > 0)) throw new RangeError(`the ${id} slice is a share of the frame interval, and no interval is known`);
    return (s.share ?? 0) * interval;
  }

  /** Every slice with its milliseconds now (a reader's view: the profile's budget table). */
  read(): FrameSliceReading[] {
    return FRAME_SLICE_IDS.map((id) => {
      const s = this.slices[id];
      const msNow = s.ms ?? (this.interval !== null ? (s.share ?? 0) * this.interval : null);
      return { id, ...s, msNow };
    });
  }
}

/** This thread's arbiter. */
export const frameArbiter = new FrameArbiter();

/** The milliseconds slice `id` may take now on this thread (`intervalMs`: the interval a share slice is taken from). */
export function frameSliceMs(id: FrameSliceId, intervalMs?: number): number {
  return frameArbiter.sliceMs(id, intervalMs);
}
