/**
 * Terrain editing of a block layer: `surface` edits set a column's top
 * corners (growing or shrinking the column), `sculpt` dabs raise, lower,
 * smooth and flatten under a round brush — neighbouring columns stay joined
 * at every shared vertex, smoothing wears a cliff down, and the same dabs
 * give the same cells. Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import type { BlockLayerComponent, BlockType } from './block-layers';
import { applyBlockEdits, blockEditsShapeError, BlockGrid, type BlockEdit } from './block-grid';
import { columnHeights } from './block-sculpt';
import { surfaceBelow } from './block-surface';

const TYPES: BlockType[] = [
  { blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' },
  { blockId: 'rock', name: 'Rock', variants: [{ color: '#777777' }], shape: 'full' },
  { blockId: 'slab', name: 'Slab', variants: [{ color: '#aaaaaa' }], shape: 'half' },
];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
const LAYER: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [24, 16, 24] } };
const edit = (g: BlockGrid, ...edits: BlockEdit[]): void => {
  const r = applyBlockEdits(g, edits, { types, stamps: new Map() });
  if (!r.ok) throw new Error(`${r.path}: ${r.message}`);
};
const floor = (): BlockGrid => {
  const g = new BlockGrid(LAYER);
  edit(g, { kind: 'fill', box: [0, 0, 0, 24, 2, 24], cell: { block: 'soil' } });
  return g;
};

/** The largest mismatch between the columns sharing any vertex (0: one joined surface). */
function seams(g: BlockGrid): number {
  let worst = 0;
  for (let vz = 1; vz < 24; vz++)
    for (let vx = 1; vx < 24; vx++) {
      const hs = [
        columnHeights(g, types, vx - 1, vz - 1)?.[2],
        columnHeights(g, types, vx, vz - 1)?.[3],
        columnHeights(g, types, vx, vz)?.[0],
        columnHeights(g, types, vx - 1, vz)?.[1],
      ].filter((v): v is number => v !== undefined);
      worst = Math.max(worst, Math.max(...hs) - Math.min(...hs));
    }
  return worst;
}

describe('surface edits', () => {
  it('a column takes its corners: it grows with its top block, shrinks (metadata stays), and a corner over 1 reaches the row above', () => {
    const g = floor();
    edit(g, { kind: 'meta', at: [3, 1, 3], set: { mark: 1 } } as BlockEdit);
    edit(g, { kind: 'surface', columns: [3, 3, 3.5, 4.25, 4.75, 3.5] });
    expect(g.get(3, 2, 3)).toEqual({ block: 'soil' });
    expect(g.get(3, 3, 3)).toEqual({ block: 'soil', corners: [0.5, 1.25, 1.75, 0.5] });
    expect(g.get(3, 4, 3)).toBeNull();
    // The centre lies on the split diagonal (+x−z to −x+z here: its ends differ least).
    expect(surfaceBelow(g, types, 3.5, 99, 3.5)!.height).toBeCloseTo(0.5 * (3 + (1.25 + 0.5) / 2), 9);
    // Lower it into the floor: the rows above go, the metadata of row 1 stays.
    edit(g, { kind: 'surface', columns: [3, 3, 1, 1, 1.5, 1.5] });
    expect(g.get(3, 1, 3)).toEqual({ block: 'soil', corners: [0, 0, 0.5, 0.5], meta: { mark: 1 } });
    expect(g.columnTop(3, 3)).toBe(1);
    // A flat whole height is a full top cell; at the bottom the column is gone.
    edit(g, { kind: 'surface', columns: [3, 3, 1, 1, 1, 1] });
    expect(g.get(3, 0, 3)).toEqual({ block: 'soil' });
    expect(g.get(3, 1, 3)).toEqual({ meta: { mark: 1 } });
    edit(g, { kind: 'surface', columns: [3, 3, 0, 0, 0, 0] });
    expect(g.columnTop(3, 3)).toBeNull();
    // An empty column grows only with a cell; a column topped by a block that cannot slope is left alone.
    edit(g, { kind: 'surface', columns: [3, 3, 2, 2, 2.5, 2.5] });
    expect(g.columnTop(3, 3)).toBeNull();
    edit(g, { kind: 'surface', columns: [3, 3, 2, 2, 2.5, 2.5], cell: { block: 'rock' } });
    expect(g.get(3, 2, 3)).toEqual({ block: 'rock', corners: [0, 0, 0.5, 0.5] });
    edit(g, { kind: 'cells', at: [5, 2, 5], cell: { block: 'slab' } }, { kind: 'surface', columns: [5, 5, 4, 4, 4, 4] });
    expect(g.columnTop(5, 5)).toBe(2);
  });

  it('the edit shapes are checked', () => {
    expect(blockEditsShapeError([{ kind: 'surface', columns: [1, 2, 3, 4, 5] }])?.path).toBe('/args/edits/0/columns');
    expect(blockEditsShapeError([{ kind: 'surface', columns: [1.5, 2, 3, 4, 5, 6] }])?.path).toBe('/args/edits/0/columns/0');
    expect(blockEditsShapeError([{ kind: 'sculpt', op: 'dig', at: [1, 2], radius: 2, strength: 1 }])?.path).toBe('/args/edits/0/op');
    expect(blockEditsShapeError([{ kind: 'sculpt', op: 'raise', at: [1, 2], radius: 100, strength: 1 }])?.path).toBe('/args/edits/0/radius');
    expect(blockEditsShapeError([{ kind: 'sculpt', op: 'flatten', at: [1, 2], radius: 2, strength: 1 }])?.path).toBe('/args/edits/0/height');
    expect(blockEditsShapeError([{ kind: 'sculpt', op: 'smooth', at: [1.5, 2.25], radius: 2, strength: 0.5, cell: { block: 'soil' } }])).toBeNull();
  });
});

describe('sculpt dabs', () => {
  it('raise makes a smooth joined hill; lower digs; both keep every shared vertex joined', () => {
    const g = floor();
    edit(g, { kind: 'sculpt', op: 'raise', at: [12, 12], radius: 5, strength: 2 });
    // The centre vertex rose by the full strength (2 rows), the rim not at all.
    expect(columnHeights(g, types, 12, 12)![0]).toBe(4);
    expect(columnHeights(g, types, 4, 12)).toEqual([2, 2, 2, 2]);
    expect(seams(g)).toBe(0);
    for (let i = 0; i < 6; i++) edit(g, { kind: 'sculpt', op: 'raise', at: [12 + i * 0.5, 12], radius: 4, strength: 0.25 });
    edit(g, { kind: 'sculpt', op: 'lower', at: [6, 6], radius: 3, strength: 1 });
    expect(seams(g)).toBe(0);
    expect(columnHeights(g, types, 6, 6)![0]).toBe(1);
    // Steeper than three rows per column: the column keeps a wall (its corners stop four rows over its bottom).
    edit(g, { kind: 'sculpt', op: 'raise', at: [18, 18], radius: 2, strength: 10 });
    expect(seams(g)).toBeGreaterThan(0);
    // Every corner on the 1/64 grid and within 0-4 of its row.
    g.forEach((_x, _y, _z, idx) => {
      for (const c of g.valueOf(idx).corners ?? []) {
        expect(Number.isInteger(c * 64)).toBe(true);
        expect(c).toBeLessThanOrEqual(4);
      }
    });
  });

  it('smooth wears a cliff down; flatten levels to a height', () => {
    const g = floor();
    edit(g, { kind: 'fill', box: [12, 2, 0, 24, 6, 24], cell: { block: 'soil' } });
    const cliff = (): number => Math.abs(columnHeights(g, types, 12, 12)![0] - columnHeights(g, types, 11, 12)![1]);
    expect(cliff()).toBe(4);
    for (let i = 0; i < 12; i++) edit(g, { kind: 'sculpt', op: 'smooth', at: [12, 12], radius: 4, strength: 1 });
    expect(cliff()).toBeLessThan(0.5);
    edit(g, { kind: 'sculpt', op: 'flatten', at: [12, 12], radius: 6, strength: 1, height: 3 });
    expect(columnHeights(g, types, 12, 12)![0]).toBe(3);
  });

  it('the same dabs give the same cells (a stroke replayed on the stored layer)', () => {
    const dabs: BlockEdit[] = [];
    for (let i = 0; i < 20; i++) dabs.push({ kind: 'sculpt', op: i % 5 === 4 ? 'smooth' : 'raise', at: [5 + i * 0.37, 7 + Math.sin(i) * 3], radius: 3.3, strength: i % 5 === 4 ? 0.6 : 0.7 });
    const a = floor();
    const b = floor();
    edit(a, ...dabs);
    for (const d of dabs) edit(b, d);
    const enc = (g: BlockGrid): string => JSON.stringify(g.chunkKeys().map((k) => g.encodeChunk(k)));
    expect(enc(a)).toBe(enc(b));
  });
});
