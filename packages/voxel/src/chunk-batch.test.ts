/**
 * The draw batcher's budget bookkeeping: what the page reports for a chunk
 * it draws is the chunk's mesh part, and a draw taken away from a chunk that
 * stays resident takes its part with it.
 */
import { describe, expect, it } from 'vitest';
import { ChunkDrawBatcher, MESH_PART, type ChunkDrawBatch, type ChunkDrawFeed } from './chunk-batch';
import type { JoinedDraw } from './chunk-join';
import { chunkGrid } from './coords';
import type { StreamEvent } from './voxel-streamer';

function feed(): { feed: ChunkDrawFeed; emit(e: StreamEvent): void; parts: Map<string, number>; joins: Map<string, JoinedDraw | null> } {
  const grid = chunkGrid(32);
  let listener: ((e: StreamEvent) => void) | null = null;
  const parts = new Map<string, number>();
  const joins = new Map<string, JoinedDraw | null>();
  return {
    parts,
    joins,
    emit: (e) => listener?.(e),
    feed: {
      grid,
      pieces: { gpuBytes: 0 },
      on: (l) => void (listener = l),
      joinedChunk: (cx, cy, cz) => joins.get(`${cx},${cy},${cz}`) ?? null,
      setPart: (cx, cy, cz, part, bytes) => {
        const k = `${cx},${cy},${cz}:${part}`;
        if (bytes > 0) parts.set(k, bytes);
        else parts.delete(k);
        return true;
      },
    },
  };
}

const surface = { vertexCount: 3, vertices: new Uint8Array(36), indices: new Uint32Array([0, 1, 2]) };
const draw = { edge: 32, ground: surface, base: surface, instances: { count: 0, data: new Uint32Array(0) }, solid: 1, side: 34 } as unknown as JoinedDraw;

describe('ChunkDrawBatcher', () => {
  it("sets a resident chunk's mesh part to 0 when its draw is removed (nothing derived with assembly any more)", () => {
    const f = feed();
    const sent: ChunkDrawBatch[] = [];
    let flush: () => void = () => {};
    const b = new ChunkDrawBatcher('w', f.feed, 16, (x) => sent.push(x), (fn) => (flush = fn));
    f.joins.set('1,0,2', draw);
    f.emit({ type: 'chunk', cx: 1, cy: 0, cz: 2, shaderOnly: false, reliefOnly: false });
    flush();
    expect(sent.at(-1)!.chunks.map((c) => c.kind)).toEqual(['draw']);
    b.drawn([1, 0, 2, 4096], 0, 5000);
    expect(f.parts.get(`1,0,2:${MESH_PART}`)).toBe(4096);
    // The kit meshes' bytes the page reports with its draws go to the streamer's budget.
    expect(f.feed.pieces!.gpuBytes).toBe(5000);
    // Its sections no longer join to anything: the page drops the draw and the budget its bytes.
    f.joins.set('1,0,2', null);
    f.emit({ type: 'chunk', cx: 1, cy: 0, cz: 2, shaderOnly: false, reliefOnly: false });
    flush();
    expect(sent.at(-1)!.chunks.map((c) => c.kind)).toEqual(['remove']);
    expect(f.parts.has(`1,0,2:${MESH_PART}`)).toBe(false);
    // A late report for the removed draw counts nothing.
    b.drawn([1, 0, 2, 4096], 0);
    expect(f.parts.has(`1,0,2:${MESH_PART}`)).toBe(false);
  });
});
