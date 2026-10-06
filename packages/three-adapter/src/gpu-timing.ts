/**
 * The GPU's time per frame from timestamp queries (WebGPU's
 * `timestamp-query` feature, WebGL 2's `EXT_disjoint_timer_query_webgl2`),
 * where the renderer was made with `trackTimestamp` and the device has them.
 * Without them nothing is measured: `take()` answers null, never an estimate.
 *
 * three records a query per render pass and sums what is resolved; a resolve
 * takes a while, so one covers the frames drawn since the last one began.
 */

interface TimestampRenderer {
  readonly backend?: { readonly trackTimestamp?: boolean; readonly disjoint?: unknown };
  resolveTimestampsAsync?(type?: string): Promise<number | undefined>;
}

export interface GpuTiming {
  /** A frame was drawn with `renderer`: its queries are resolved with the next resolve. */
  afterFrame(renderer: unknown): void;
  /** The GPU time and frames resolved since the last take; null while the renderer measures nothing. */
  take(): { ms: number; frames: number; worst: number } | null;
  /** GPU ms per frame resolved since the last call (a second reader beside `take`: dynamic resolution); null: none resolved. */
  recent(): number | null;
  /** Whether the last drawn frame's renderer measures GPU time. */
  measuring(): boolean;
}

/** Whether this renderer records GPU timestamps (made with trackTimestamp, and the device has the queries). */
export function measuresGpuTime(renderer: unknown): boolean {
  const b = (renderer as TimestampRenderer | null)?.backend;
  // WebGL 2 without the disjoint timer extension leaves `disjoint` null.
  return b?.trackTimestamp === true && (b.disjoint === undefined || b.disjoint !== null);
}

export function createGpuTiming(): GpuTiming {
  let measuring = false;
  let resolving = false;
  let unresolved = 0;
  let ms = 0;
  let frames = 0;
  let worst = 0;
  let recentMs = 0;
  let recentFrames = 0;
  return {
    afterFrame(renderer) {
      measuring = measuresGpuTime(renderer);
      if (!measuring) return;
      unresolved += 1;
      const r = renderer as TimestampRenderer;
      if (resolving || typeof r.resolveTimestampsAsync !== 'function') return;
      resolving = true;
      const covered = unresolved;
      unresolved = 0;
      r.resolveTimestampsAsync('render').then(
        (total) => {
          resolving = false;
          const t = Number(total ?? 0);
          if (!Number.isFinite(t) || t < 0) return;
          ms += t;
          frames += covered;
          recentMs += t;
          recentFrames += covered;
          // The slowest frame is not seen apart from the others it was resolved with: the resolve's mean stands for it.
          worst = Math.max(worst, t / covered);
        },
        () => {
          resolving = false;
        },
      );
    },
    recent() {
      if (recentFrames === 0) return null;
      const v = recentMs / recentFrames;
      recentMs = 0;
      recentFrames = 0;
      return v;
    },
    measuring: () => measuring,
    take() {
      if (!measuring) return null;
      const out = { ms, frames, worst };
      ms = 0;
      frames = 0;
      worst = 0;
      return out;
    },
  };
}
