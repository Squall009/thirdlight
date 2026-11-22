/**
 * Where a world's far cache work runs. The backend gives it worker threads,
 * so a full build (minutes for a world of kilometres), a fine bake (hours
 * for one baked to 0.5 m) and the rebuild after each edit (a few hundred
 * milliseconds) never hold its event loop; from source all run in this
 * thread.
 */
import type { GridPlacement } from '@thirdlight/voxel';
import { buildFarCacheInto, rebuildFarCache, yieldingFarRunner, type FarRebuildReport } from './voxel-far-cache';
import { inThreadFarFine, rebakeFarFine, type FarFineResult, type FarFineTask } from './voxel-far-fine';

export interface FarCacheJobs {
  /** A whole cache built into `fresh` ({@link buildFarCacheInto}), structure grids resampled where `grids` place them; the cache in use is left as it is. */
  build(worldDir: string, fresh: string, grids?: readonly GridPlacement[]): Promise<void>;
  /** The kept ancestors of `chunks` and the baked fine nodes over them built again in place ({@link rebuildFarWorldCache}), the grids where `grids` place them. */
  rebuild(worldDir: string, cacheDir: string, chunks: ReadonlyArray<{ readonly cx: number; readonly cy: number; readonly cz: number }>, grids?: readonly GridPlacement[]): Promise<FarRebuildReport>;
  /** Fine bake jobs (voxel-far-fine.ts), each answered as it is built (nothing is written: the caller writes the columns). */
  bakeFine(tasks: readonly FarFineTask[]): AsyncIterable<FarFineResult>;
  /** Stops what it started (its worker threads). */
  close(): void;
}

/**
 * A rebuild after an edit: the kept levels' ancestors of `chunks` and their
 * baked bricks ({@link rebuildFarCache}), then the fine nodes over them in
 * the baked fine columns ({@link rebakeFarFine}).
 */
export function rebuildFarWorldCache(worldDir: string, cacheDir: string, chunks: ReadonlyArray<{ readonly cx: number; readonly cy: number; readonly cz: number }>, grids: readonly GridPlacement[] = []): FarRebuildReport {
  const t0 = performance.now();
  const coarse = rebuildFarCache(worldDir, cacheDir, chunks, grids);
  const fine = rebakeFarFine(worldDir, cacheDir, chunks);
  return fine === undefined ? coarse : { ...coarse, ms: performance.now() - t0, fine };
}

/** Far cache work in this thread: a full build and a fine bake give the event loop back between region columns. */
export function inProcessFarJobs(): FarCacheJobs {
  return {
    build: async (worldDir, fresh, grids = []) => {
      await buildFarCacheInto(worldDir, fresh, { run: yieldingFarRunner(worldDir, grids), grids });
    },
    rebuild: (worldDir, cacheDir, chunks, grids = []) => Promise.resolve(rebuildFarWorldCache(worldDir, cacheDir, chunks, grids)),
    bakeFine: (tasks) => inThreadFarFine()(tasks),
    close: () => undefined,
  };
}
