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
import type { FarEvent } from './far-field';

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

  it('sends where the near field draws, by chunk and eroded by one, with the far field, and only when it changed', () => {
    const f = feed();
    const drawn: Array<{ level: number; nx: number; ny: number; nz: number }> = [];
    const farListeners: Array<(e: FarEvent) => void> = [];
    const levels = { lod: { drawn: { drawn: () => true, nodes: () => drawn } }, derivedOf: () => null, seams: { seamOf: () => null }, gpuBytes: 0 };
    const withFar: ChunkDrawFeed = { ...f.feed, mips: levels, far: { on: (l) => void farListeners.push(l), gpuBytes: 0 } };
    const sent: ChunkDrawBatch[] = [];
    let flush: () => void = () => {};
    new ChunkDrawBatcher('w', withFar, 16, (x) => sent.push(x), (fn) => (flush = fn));
    // A 4 × 4 × 4 block of chunks at level 0 and one level-1 node (2 chunks a side) beside it on x.
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) drawn.push({ level: 0, nx: x, ny: y, nz: z });
    drawn.push({ level: 1, nx: 2, ny: 0, nz: 0 });
    f.emit({ type: 'levels', reason: 'swap', added: drawn, removed: [] });
    flush();
    const c = sent.at(-1)!.nearCover!;
    expect(c.min).toEqual([0, 0, 0]);
    expect(c.size).toEqual([6, 4, 4]);
    const at = (x: number, y: number, z: number): number => c.cells[x + c.size[0] * (y + c.size[1] * z)]!;
    // Only chunks drawn with every chunk round them drawn too: the edge ring is the far field's to overlap.
    const inner: string[] = [];
    for (let x = 0; x < 6; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) if (at(x, y, z) === 1) inner.push(`${x},${y},${z}`);
    // The level-1 node's chunks are only two high, so the block's x = 3 layer has undrawn chunks round it.
    expect(inner).toEqual(['1,1,1', '1,1,2', '1,2,1', '1,2,2', '2,1,1', '2,1,2', '2,2,1', '2,2,2']);
    // Nothing changed: no cover again; a far event goes out in a batch of its own.
    f.emit({ type: 'levels', reason: 'swap', added: [], removed: [] });
    const mesh = { vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0), skirtTriangles: 0 };
    for (const l of farListeners) l({ type: 'far', added: [{ level: 2, nx: 5, ny: 0, nz: 0, mesh }], removed: [] });
    flush();
    expect(sent.at(-1)!.nearCover).toBeUndefined();
    expect(sent.at(-1)!.far!.added.map((a) => [a.level, a.nx])).toEqual([[2, 5]]);
  });
});
