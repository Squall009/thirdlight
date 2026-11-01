import { sha256Hex } from '@thirdlight/shared';
import { chunkGrid, createDenseChunk, VOXEL_CATEGORY, type ChunkEdge, type DenseChunk } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { chunkRange, type TestGrid, type TestWorld } from './world-kit';
import { cavesWorld, hillyWorld, plainWorld, townWorld, verticalWorld } from './worlds';

/** Small versions of every world, quick to generate whole. */
const small = (seed?: number): TestWorld[] => [
  plainWorld({ seed, footprint: 64 }),
  hillyWorld({ seed, footprint: 96 }),
  townWorld({ seed, footprint: 120 }),
  cavesWorld({ seed, footprint: 64 }),
  verticalWorld({ seed, footprint: 32 }),
];

function chunksOf(g: TestGrid, edge: ChunkEdge): Array<[number, number, number]> {
  const grid = chunkGrid(edge);
  const [x0, x1] = chunkRange(grid, g.bounds.min[0], g.bounds.max[0]);
  const [y0, y1] = chunkRange(grid, g.bounds.min[1], g.bounds.max[1]);
  const [z0, z1] = chunkRange(grid, g.bounds.min[2], g.bounds.max[2]);
  const out: Array<[number, number, number]> = [];
  for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) out.push([x, y, z]);
  return out;
}

function chunkBytes(c: DenseChunk): Uint8Array {
  const parts = [new Uint8Array(c.material.buffer, c.material.byteOffset, c.material.byteLength), c.category, c.shape, c.orientation];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One hash over every chunk of every grid, visited in the given order. */
function worldHash(world: TestWorld, edge: ChunkEdge, reverse: boolean): string {
  const grid = chunkGrid(edge);
  const c = createDenseChunk(grid);
  const hashes = new Map<string, string>();
  for (const g of world.grids) {
    const list = chunksOf(g, edge);
    if (reverse) list.reverse();
    for (const [x, y, z] of list) if (g.fill(grid, x, y, z, c)) hashes.set(`${g.name}:${x},${y},${z}`, sha256Hex(chunkBytes(c)));
  }
  return sha256Hex(new TextEncoder().encode([...hashes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).join('\n')));
}

describe('the test worlds', () => {
  it.each(small().map((w) => [w.name, w] as const))('%s is the same bytes for the same seed, in any chunk order, and differs for another seed', (name, world) => {
    const again = small().find((w) => w.name === name)!;
    const other = small(999).find((w) => w.name === name)!;
    const h = worldHash(world, 16, false);
    expect(worldHash(again, 16, true)).toBe(h);
    expect(worldHash(other, 16, false)).not.toBe(h);
  });

  it('generate the same cells whatever the chunk edge', () => {
    for (const world of small()) {
      const per = (edge: ChunkEdge): Map<string, number> => {
        const grid = chunkGrid(edge);
        const c = createDenseChunk(grid);
        const cells = new Map<string, number>();
        const g = world.grids[0]!;
        for (const [cx, cy, cz] of chunksOf(g, edge)) {
          if (!g.fill(grid, cx, cy, cz, c)) continue;
          // A diagonal sample of each chunk is enough to catch a cell that depends on the chunk layout.
          for (let k = 0; k < edge; k++) {
            const i = ((k * edge + k) * edge) + k;
            const key = `${(cx << grid.shift) + k},${(cy << grid.shift) + k},${(cz << grid.shift) + k}`;
            if (c.material[i] !== 0) cells.set(key, c.material[i]! * 1e6 + c.category[i]! * 1e3 + c.shape[i]!);
          }
        }
        return cells;
      };
      const a = per(16);
      const b = per(32);
      for (const [k, v] of a) if (b.has(k)) expect(b.get(k), `${world.name} ${k}`).toBe(v);
    }
  });

  it('cover what the harness needs: liquid with a partial top, rotated structure grids, thin construction, 2 km of height', () => {
    const grid = chunkGrid(32);
    const c = createDenseChunk(grid);
    // Whether any chunk of a grid passes `test`, looking only at chunks overlapping the given y range and x/z box (cells).
    const seen = (world: TestWorld, gi: number, test: (c: DenseChunk) => boolean, ys?: [number, number], xz?: [number, number, number, number]): boolean => {
      const g = world.grids[gi]!;
      for (const [x, y, z] of chunksOf(g, 32)) {
        if (ys !== undefined && ((y << 5) + 32 <= ys[0] || (y << 5) >= ys[1])) continue;
        if (xz !== undefined && ((x << 5) + 32 <= xz[0] || (x << 5) >= xz[1] || (z << 5) + 32 <= xz[2] || (z << 5) >= xz[3])) continue;
        if (g.fill(grid, x, y, z, c) && test(c)) return true;
      }
      return false;
    };
    const partialLiquid = (d: DenseChunk): boolean => d.category.some((cat, i) => cat === VOXEL_CATEGORY.liquid && d.shape[i]! > 0 && d.shape[i]! < 255);
    // The hilly world's lowest valleys lie near its +z edge (found by sampling its height function).
    expect(seen(hillyWorld(), 0, partialLiquid, [16, 32], [96, 192, 1504, 1600])).toBe(true);
    expect(seen(cavesWorld(), 0, partialLiquid, [-96, -64])).toBe(true);
    expect(seen(townWorld({ footprint: 512 }), 0, partialLiquid)).toBe(true);

    const town = townWorld();
    expect(town.grids.length).toBeGreaterThan(1);
    expect(town.grids.slice(1).every((g) => g.yawDeg === 30 || g.yawDeg === 45)).toBe(true);
    expect(seen(town, 1, (d) => d.category.includes(VOXEL_CATEGORY.roof))).toBe(true);

    const tall = verticalWorld();
    const height = tall.grids[0]!.bounds.max[1] - tall.grids[0]!.bounds.min[1];
    expect(height).toBeGreaterThanOrEqual(4000);
    const solid = (d: DenseChunk): boolean => d.material.some((m) => m !== 0);
    expect(seen(tall, 0, solid, [-2000, -1960])).toBe(true);
    expect(seen(tall, 0, solid, [1800, 1900])).toBe(true);
    expect(seen(tall, 0, partialLiquid, [-1720, -1690])).toBe(true);
  });
});
