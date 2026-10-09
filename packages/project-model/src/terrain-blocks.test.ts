/**
 * The terrain's blocks layer at wide blends: the nearest border column is
 * found bin by bin there, and every sample comes out as the whole-box scan
 * gives it (ties settled by the same row order), across bins, gaps and two
 * layers.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid } from './block-grid';
import type { BlockLayerComponent, BlockType } from './block-layers';
import { TerrainBlockSeam, type TerrainBlocksSource } from './terrain-blocks';

const TYPES = new Map<string, BlockType>([['rock', { blockId: 'rock', name: 'Rock', shape: 'full', variants: [{ color: '#808080' }] } as unknown as BlockType]]);

/** A layer of `cells` columns (x, z, rows high) at `origin`, cells `size` metres. */
function layer(id: string, origin: [number, number, number], size: number, cells: [number, number, number][]): TerrainBlocksSource {
  const component: BlockLayerComponent = { cellSize: [size, size, size], bounds: { min: [0, 0, 0], max: [96, 8, 96] } };
  const g = new BlockGrid(component);
  for (const [x, z, rows] of cells) for (let y = 0; y < rows; y++) g.set(x, y, z, { block: 'rock' });
  return { id, component, data: g.toData(id, null, g.takeDirty().chunks)!, types: TYPES, origin };
}

describe('a terrain blocks layer at a wide blend', () => {
  it('finds the same border, height and weight bin by bin as by scanning the whole blend', () => {
    const cells: [number, number, number][] = [];
    // An L of columns with a gap, rows rising along x, across a bin line (16 columns); an island two bins off.
    for (let z = 10; z < 22; z++) for (let x = 12; x < 20; x++) if (!(x === 15 && z === 15)) cells.push([x, z, 1 + (x % 3)]);
    for (let z = 10; z < 14; z++) for (let x = 20; x < 30; x++) cells.push([x, z, 2]);
    for (let z = 60; z < 63; z++) for (let x = 50; x < 52; x++) cells.push([x, z, 3]);
    const a = layer('a', [0, 0, 0], 1, cells);
    // A second layer of 2 m cells overlapping the first's reach: equally near borders keep the first layer's.
    const b = layer('b', [40, 1, 0], 2, [[0, 0, 1], [1, 0, 1], [0, 1, 2], [5, 9, 1]]);
    const comp = { tileSamples: 65, spacing: 1, heightRange: [-20, 100] as [number, number] };
    const settings = { mode: 'cut' as const, blend: 30, paint: true };
    const scan = new TerrainBlockSeam([a, b], settings, comp, [0, 0, 0], Infinity);
    const bins = new TerrainBlockSeam([a, b], settings, comp, [0, 0, 0], 0);
    let reached = 0;
    const differ: string[] = [];
    for (let z = -30; z <= 100; z += 1.25)
      for (let x = -30; x <= 100; x += 1.25) {
        const s = scan.sample(x, z);
        if (JSON.stringify(bins.sample(x, z)) !== JSON.stringify(s)) differ.push(`${x}, ${z}`);
        if (s !== null && !s.under) reached += 1;
      }
    expect(differ).toEqual([]);
    expect(reached).toBeGreaterThan(4_000);
  });
});
