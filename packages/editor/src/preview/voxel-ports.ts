/**
 * How Play opens a project's voxel worlds: the preview origin's voxel
 * routes under the play's locator (`<root><world>` for the world's manifest
 * and region files, `<root><world>/regions/<file>` read by range, with the
 * streamer's batched reads), and a pool of module workers a world (the voxel
 * worker script, decoding and deriving). The simulation worker opens them
 * from inside itself (Chrome and Edge start workers from workers), or the
 * page does in single-thread mode. Play reads the files as the backend has
 * them now; an exported game reads its own copies (not through here).
 */
import { hexToBytes } from '@thirdlight/shared';
import type { VoxelWorldConnection, VoxelWorldPorts } from '@thirdlight/runtime';
import { chunkGrid, eventTargetWorker, RegionChunkSource, STREAM_POOL_SETTINGS, WORLD_GRID_ID, WorkerPool, type ChunkEdge } from '@thirdlight/voxel';
import { defaultVoxelWorkers, rangeByteSource } from '../voxel-world/range-reads';

/** Region files a world's source keeps open at once. */
const OPEN_REGION_FILES = 64;

interface WorldInfo {
  ok: boolean;
  manifest?: { worldId: string; edge: number; layout: 'stacked' | 'column'; footprint: 512 | 1024 };
  files?: Array<{ name: string }>;
  error?: { message: string };
}

/** `root`: the absolute URL the worlds are under (ends in `/`); `workerUrl`: the voxel worker script. */
export function playVoxelPorts(root: string, workerUrl: string): VoxelWorldPorts {
  return {
    open: async (world: string): Promise<VoxelWorldConnection> => {
      const base = `${root}${encodeURIComponent(world)}`;
      const res = await fetch(base);
      const info = (await res.json()) as WorldInfo;
      if (!info.ok || info.manifest === undefined) throw new Error(info.error?.message ?? `HTTP ${res.status}`);
      const m = info.manifest;
      const files = new Set((info.files ?? []).map((f) => f.name));
      const grid = chunkGrid(m.edge as ChunkEdge);
      // A file the world does not list holds only air.
      const worldId = hexToBytes(m.worldId);
      const source = new RegionChunkSource({ worldId, gridId: WORLD_GRID_ID, grid, layout: m.layout, footprint: m.footprint, open: (name) => (files.has(name) ? rangeByteSource(`${base}/regions/${encodeURIComponent(name)}`, {}) : null), maxOpen: OPEN_REGION_FILES });
      const pool = new WorkerPool({ size: defaultVoxelWorkers(), create: () => eventTargetWorker(new Worker(workerUrl, { type: 'module', name: `thirdlight-voxels ${world}` })), ...STREAM_POOL_SETTINGS });
      return { grid, worldId, source, pool };
    },
  };
}
