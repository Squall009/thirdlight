/**
 * The streamer of a world named by a scene's `voxelWorld` object, as every
 * place that streams one builds it: the runtime's world host (Play, an
 * exported game) and the editor's Scene view. The object's ring is in
 * metres and becomes cells here; the world derives with the engine's
 * assembly rules in its derive sections; the base store is the world's
 * files. What each place adds (bodies, edits, draws) hangs on the result.
 */
import type { ChunkSource } from './region-source';
import { VOXEL_SIZE_M, type ChunkGrid, type SectionEdge } from './coords';
import { DEFAULT_STREAM_RING, VOXEL_STREAM_BUDGET_BYTES, type StreamRing } from './stream-ring';
import { createWorldStore } from './palette-store';
import { jobRadius, PLACEHOLDER_RULES } from './assembly';
import { VoxelStreamer } from './voxel-streamer';
import type { WorkerPool } from './worker-pool';

/** A world's ring in metres (a `voxelWorld` object's, resolved). */
export interface WorldRingMetres {
  readonly loadRadius: number;
  readonly unloadRadius: number;
  readonly loadHeight: number;
  readonly unloadHeight: number;
}

/** The ring in cells, the near lane no wider than the load ring. */
export function worldStreamRing(r: WorldRingMetres): StreamRing {
  const cells = (m: number): number => m / VOXEL_SIZE_M;
  const loadRadius = cells(r.loadRadius);
  return { loadRadius, unloadRadius: cells(r.unloadRadius), loadHeight: cells(r.loadHeight), unloadHeight: cells(r.unloadHeight), nearRadius: Math.min(loadRadius, DEFAULT_STREAM_RING.nearRadius) };
}

/** A streamer for a world: the chunks around its focus read from `source`, decoded and derived in `pool`. */
export function worldStreamer(conn: { readonly grid: ChunkGrid; readonly source: ChunkSource; readonly pool: WorkerPool; readonly budgetBytes?: number }, settings: { readonly ring: WorldRingMetres; readonly sectionEdge: SectionEdge }): VoxelStreamer {
  return new VoxelStreamer({
    store: createWorldStore(conn.grid),
    source: conn.source,
    pool: conn.pool,
    ring: worldStreamRing(settings.ring),
    budgetBytes: conn.budgetBytes ?? VOXEL_STREAM_BUDGET_BYTES.low,
    dependencyRadius: jobRadius(PLACEHOLDER_RULES),
    derive: true,
    rules: PLACEHOLDER_RULES,
    sectionEdge: settings.sectionEdge,
  });
}
