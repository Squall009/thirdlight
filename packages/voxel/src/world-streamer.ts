/**
 * The streamer of a world named by a scene's `voxelWorld` object, as every
 * place that streams one builds it: the runtime's world host (Play, an
 * exported game) and the editor's Scene view. The object's ring and level
 * distances are in metres and become cells here; the world derives with the engine's
 * world rules (terrain features included) in its derive sections; the base store is the world's
 * files. What each place adds (bodies, edits, draws) hangs on the result.
 */
import type { ChunkSource } from './region-source';
import { VOXEL_SIZE_M, type ChunkGrid, type SectionEdge } from './coords';
import { DEFAULT_LEVEL_RINGS, DEFAULT_STREAM_RING, VOXEL_STREAM_BUDGET_BYTES, type StreamRing } from './stream-ring';
import { COLLISION_RING_HYSTERESIS_CELLS } from './collision-ring';
import type { LevelRings } from './lod-select';
import { createWorldStore } from './palette-store';
import { jobRadius } from './assembly';
import { WORLD_RULES } from './rule-registry';
import { VoxelStreamer } from './voxel-streamer';
import type { WorkerPool } from './worker-pool';

/** A world's ring in metres (a `voxelWorld` object's, resolved). */
export interface WorldRingMetres {
  readonly loadRadius: number;
  readonly unloadRadius: number;
  readonly loadHeight: number;
  readonly unloadHeight: number;
}

/** A world's level distances in metres (a `voxelWorld` object's, resolved): level 0 within `level0`, level 1 within `level1`, level 2 past it. */
export interface WorldLevelsMetres {
  readonly level0: number;
  readonly level1: number;
}

/**
 * The level rings in cells. Level 0 reaches at least as far as a chunk keeps
 * its collision body (the collision radius and its hysteresis), so what a
 * character touches is what is drawn; level 1 is never inside level 0.
 */
export function worldLevelRings(levels: WorldLevelsMetres | undefined, collisionRadius: number | undefined): LevelRings {
  const cells = (m: number): number => m / VOXEL_SIZE_M;
  const D = DEFAULT_LEVEL_RINGS.radii;
  const keep = collisionRadius === undefined ? 0 : cells(collisionRadius) + COLLISION_RING_HYSTERESIS_CELLS;
  const r0 = Math.max(levels === undefined ? D[0]! : cells(levels.level0), keep);
  const r1 = Math.max(levels === undefined ? D[1]! : cells(levels.level1), r0);
  return { radii: [r0, r1], hysteresis: DEFAULT_LEVEL_RINGS.hysteresis };
}

/** The ring in cells, the near lane no wider than the load ring. */
export function worldStreamRing(r: WorldRingMetres): StreamRing {
  const cells = (m: number): number => m / VOXEL_SIZE_M;
  const loadRadius = cells(r.loadRadius);
  return { loadRadius, unloadRadius: cells(r.unloadRadius), loadHeight: cells(r.loadHeight), unloadHeight: cells(r.unloadHeight), nearRadius: Math.min(loadRadius, DEFAULT_STREAM_RING.nearRadius) };
}

/** A streamer for a world: the chunks around its focus read from `source`, decoded and derived in `pool`. */
export function worldStreamer(conn: { readonly grid: ChunkGrid; readonly source: ChunkSource; readonly pool: WorkerPool; readonly budgetBytes?: number }, settings: { readonly ring: WorldRingMetres; readonly sectionEdge: SectionEdge; readonly levels?: WorldLevelsMetres; readonly collision?: { readonly radius: number } }): VoxelStreamer {
  return new VoxelStreamer({
    store: createWorldStore(conn.grid),
    source: conn.source,
    pool: conn.pool,
    ring: worldStreamRing(settings.ring),
    budgetBytes: conn.budgetBytes ?? VOXEL_STREAM_BUDGET_BYTES.low,
    dependencyRadius: jobRadius(WORLD_RULES),
    derive: true,
    rules: WORLD_RULES,
    sectionEdge: settings.sectionEdge,
    levels: worldLevelRings(settings.levels, settings.collision?.radius),
  });
}
