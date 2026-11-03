/**
 * How an exported game opens its voxel worlds: from the worlds its build
 * ships (the catalog's `voxelWorlds` block) and their region files, read
 * whole through the page's content reader, each checked against its row
 * (length and SHA-256) before a chunk of it is used; and a pool of the
 * export's voxel workers a world (decoding and deriving). The simulation
 * worker opens them from inside itself, or the page does in single-thread
 * mode. Nothing here reaches the network by itself: the reader is the
 * entry's.
 */
import type { VoxelWorldConnection, VoxelWorldPorts } from '@thirdlight/runtime';
import { chunkGrid, defaultVoxelWorkers, eventTargetWorker, shippedChunkSource, shippedVoxelWorldsProblem, STREAM_POOL_SETTINGS, WorkerPool, type PoolWorker, type ShippedVoxelWorld } from '@thirdlight/voxel';
import { hexToBytes } from '@thirdlight/shared';
import { bufferResolver, type SceneCatalogIo } from './scene-catalog';

export type { ShippedVoxelWorld };

export interface ShippedVoxelPortsOptions {
  /** The worlds the build ships. */
  readonly worlds: readonly ShippedVoxelWorld[];
  /** The build's content reader and hash (relative `content/sha256/<digest>` paths). */
  readonly io: SceneCatalogIo;
  /** The export's voxel worker script (a classic worker: the export's scripts are IIFE bundles). */
  readonly workerUrl: string;
  /** Starts one voxel worker some other way (Node tests); default a browser `Worker` of `workerUrl`. */
  readonly createWorker?: () => PoolWorker;
  /** Derive workers a world (default {@link defaultVoxelWorkers}). */
  readonly workers?: number;
}

/** The ports an exported game's runtime opens its voxel worlds through. */
export function shippedVoxelPorts(o: ShippedVoxelPortsOptions): VoxelWorldPorts {
  // The rows come from a catalog file the buildId binds; their shape is checked once here before any path is made of them.
  const problem = shippedVoxelWorldsProblem(o.worlds);
  const byName = new Map(o.worlds.map((w) => [w.world, w]));
  const read = bufferResolver(
    o.worlds.flatMap((w) => w.files.map((f) => ({ digest: f.digest, byteLength: f.byteLength }))),
    o.io,
  );
  return {
    open: async (world: string): Promise<VoxelWorldConnection> => {
      if (problem !== null) throw new Error(`the build's voxel worlds: ${problem}`);
      const w = byName.get(world);
      if (w === undefined) throw new Error(`voxel world ${world} is not part of this build`);
      const source = shippedChunkSource(w, async (f) => new Uint8Array(await read(f.digest)));
      const create = o.createWorker ?? (() => eventTargetWorker(new (globalThis as unknown as { Worker: new (url: string, options: { name: string }) => Parameters<typeof eventTargetWorker>[0] }).Worker(o.workerUrl, { name: `thirdlight-voxels ${world}` })));
      const pool = new WorkerPool({ size: o.workers ?? defaultVoxelWorkers(), create, ...STREAM_POOL_SETTINGS });
      return { grid: chunkGrid(w.edge), worldId: hexToBytes(w.worldId), source, pool };
    },
  };
}
