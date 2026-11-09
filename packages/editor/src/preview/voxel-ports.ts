/**
 * How Play opens a project's voxel worlds: the preview origin's voxel
 * routes under the play's locator (`<root><world>` for the world's manifest
 * and region files, `<root><world>/regions/<file>` read by range, its far
 * cache under `<root><world>/far`, with the
 * streamer's batched reads), and a pool of module workers a world (the voxel
 * worker script, decoding and deriving). The simulation worker opens them
 * from inside itself (Chrome and Edge start workers from workers), or the
 * page does in single-thread mode. Play reads the files as the backend has
 * them now; an exported game reads its own copies (not through here).
 */
import type { VoxelWorldConnection, VoxelWorldPorts } from '@thirdlight/runtime';
import { RangeWorld } from '../voxel-world/range-world';

/** `root`: the absolute URL the worlds are under (ends in `/`); `workerUrl`: the voxel worker script. */
export function playVoxelPorts(root: string, workerUrl: string): VoxelWorldPorts {
  return {
    open: async (world: string): Promise<VoxelWorldConnection> => {
      const w = await RangeWorld.open({ url: `${root}${encodeURIComponent(world)}`, workerUrl, workerName: `thirdlight-voxels ${world}` });
      return { grid: w.grid, worldId: w.worldId, source: w.source, pool: w.pool, far: w.far };
    },
  };
}
