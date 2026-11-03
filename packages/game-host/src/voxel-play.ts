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
 * the drawn chunks' GPU bytes (`drawn`), counted in the world's budget.
 */
import type { VoxelWorldConnection, VoxelWorldPorts } from '@thirdlight/runtime';
import { ChunkDrawBatcher, type ChunkDrawBatch } from '@thirdlight/voxel';

export interface VoxelPresentation {
  /** The ports the runtime opens worlds through. */
  readonly ports: VoxelWorldPorts;
  /** The page's GPU bytes of a world's drawn chunks (`[cx, cy, cz, bytes]` repeated), and of its nodes and seams summed. */
  drawn(world: string, bytes: readonly number[], coarse: number): void;
}

/** Wraps a play's world ports so each opened world sends its chunk draws through `send`. */
export function presentVoxelWorlds(ports: VoxelWorldPorts, send: (b: ChunkDrawBatch) => void): VoxelPresentation {
  const batchers = new Map<string, ChunkDrawBatcher>();
  return {
    ports: {
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
    drawn: (world, bytes, coarse) => batchers.get(world)?.drawn(bytes, coarse),
  };
}
