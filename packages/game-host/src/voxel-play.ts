/**
 * A game's voxel worlds as the simulation hands them to the page.
 *
 * A world runs with the simulation (the worker by default, else the page):
 * its streamer, overlay, derive workers and collision bodies are the
 * runtime's (`VoxelWorldHost`), opened through the ports the play gives
 * (Play: the backend's range route; an export: its content files). These
 * ports are wrapped so that every opened world's chunk draws leave the
 * simulation as batches, one a streamer task (`ChunkDrawBatcher`): a
 * worker posts each batch to the page in one transferred message, a page
 * simulation hands it straight to the page's draws. The page answers with
 * the drawn chunks' GPU bytes (`drawn`), counted in the world's budget,
 * and with what its far draws were seen at (`farSeen`), for the far field's
 * selection.
 *
 * Every world derives its detail pieces from the build's voxel kits (a
 * material no kit binds draws plain voxel faces): one piece table
 * for all of them, the one the page draws the pieces from. The project's
 * quality levels go with the ports: the level the page reports scales
 * every world's distances and sets its budget; the build's voxel materials
 * go with them too (`ctx.voxels.materialOf`).
 */
import type { QualityLevelConfig, VoxelMaterialSources, VoxelWorldConnection, VoxelWorldPorts } from '@thirdlight/runtime';
import { ChunkDrawBatcher, worldPieceTable, type ChunkDrawBatch, type FarSeenWire, type PieceKitSource, type PieceTable } from '@thirdlight/voxel';

export interface VoxelPresentation {
  /** The ports the runtime opens worlds through. */
  readonly ports: VoxelWorldPorts;
  /** The page's GPU bytes of a world's drawn chunks (`[cx, cy, cz, bytes]` repeated), of its nodes and seams summed, and of the kit meshes and textures. */
  drawn(world: string, bytes: readonly number[], coarse: number, kits: number): void;
  /** A round of a world's far field visibility feedback from the page. */
  farSeen(world: string, seen: FarSeenWire): void;
}

/**
 * Wraps a play's world ports so each opened world sends its chunk draws through `send` and derives its pieces from
 * `kits` with the project's piece `seed`; `qualityLevels` the project's (absent: the engine's), `materials` the build's
 * voxel materials (absent: the ports').
 */
export function presentVoxelWorlds(ports: VoxelWorldPorts, send: (b: ChunkDrawBatch) => void, kits: readonly PieceKitSource[], seed: number, qualityLevels?: readonly QualityLevelConfig[], materials?: VoxelMaterialSources): VoxelPresentation {
  const batchers = new Map<string, ChunkDrawBatcher>();
  let table: PieceTable | null = null;
  const levels = qualityLevels ?? ports.qualityLevels;
  const mats = materials ?? ports.materials;
  return {
    ports: {
      ...(levels !== undefined ? { qualityLevels: levels } : {}),
      ...(mats !== undefined ? { materials: mats } : {}),
      open: async (world: string): Promise<VoxelWorldConnection> => {
        const conn = await ports.open(world);
        // A world reopened while this connection still opened (a scene reload) has its own batcher under
        // the same name: this connection closes only the one it made.
        let mine: ChunkDrawBatcher | null = null;
        return {
          grid: conn.grid,
          worldId: conn.worldId,
          source: conn.source,
          pool: conn.pool,
          ...(conn.budgetBytes !== undefined ? { budgetBytes: conn.budgetBytes } : {}),
          ...(conn.far !== undefined ? { far: conn.far } : {}),
          pieces: (table ??= worldPieceTable(kits, seed)),
          present: (stream, sectionEdge) => {
            conn.present?.(stream, sectionEdge);
            mine = new ChunkDrawBatcher(world, stream, sectionEdge, send);
            batchers.set(world, mine);
          },
          close: () => {
            mine?.close();
            if (mine !== null && batchers.get(world) === mine) batchers.delete(world);
            mine = null;
            conn.close?.();
          },
        };
      },
    },
    drawn: (world, bytes, coarse, kits) => batchers.get(world)?.drawn(bytes, coarse, kits),
    farSeen: (world, seen) => batchers.get(world)?.farSeen(seen),
  };
}
