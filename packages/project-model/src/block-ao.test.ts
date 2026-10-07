/**
 * Corner shading (per-vertex ambient occlusion) of block meshes: open floor
 * is unshaded, the foot of a wall is shaded from both sides of the crease, an
 * inside corner most; sloped ground is never shaded by its own steps; walls
 * made of edge pieces shade the floor beside them; strength 0 shades nothing.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from './block-grid';
import type { BlockLayerComponent, BlockType } from './block-layers';
import { chunkMeshAO } from './block-ao';
import { meshBlockChunk, shapeSource } from './block-mesh';

const LAYER: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 8, 16] } };
const T: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#808080' }], shape: 'full' },
  { blockId: 'wall', name: 'Wall', variants: [{ color: '#888888' }], shape: 'full', placement: 'edge' },
];
const TYPES = new Map(T.map((t) => [t.blockId, t]));
const looks = { source: (t: BlockType, _v: number, fm: [number, number, number]) => ({ key: `c:${t.blockId}`, source: shapeSource(t.shape === 'none' ? 'full' : t.shape, fm[0], fm[1], fm[2], t.boxes), uv: 'world' as const }) };

function grid(edits: readonly unknown[]): BlockGrid {
  const g = new BlockGrid(LAYER);
  expect(applyBlockEdits(g, edits as never, { types: TYPES, stamps: new Map() }).ok).toBe(true);
  return g;
}

/** The shading of every vertex of the chunk's mesh at (x, y, z) with normal n. */
function shadeAt(g: BlockGrid, strength: number, at: [number, number, number], n: [number, number, number]): number[] {
  const out: number[] = [];
  for (const part of meshBlockChunk(g, 0, 0, TYPES, looks)) {
    const ao = chunkMeshAO(g, TYPES, part, strength);
    for (let i = 0; i < ao.length; i++) {
      const p = [part.positions[i * 3]!, part.positions[i * 3 + 1]!, part.positions[i * 3 + 2]!];
      const m = [part.normals[i * 3]!, part.normals[i * 3 + 1]!, part.normals[i * 3 + 2]!];
      if (p.every((v, k) => Math.abs(v - at[k]!) < 1e-6) && m.every((v, k) => Math.abs(v - n[k]!) < 1e-6)) out.push(ao[i]!);
    }
  }
  return [...new Set(out)];
}

describe('corner shading', () => {
  const UP: [number, number, number] = [0, 1, 0];
  it('leaves open floor unshaded, shades the foot of a wall on both faces and an inside corner most', () => {
    // A floor (row 0) with a wall two cells high along x = 5 and z = 5 (an inside corner at (5, 1, 5)).
    const g = grid([{ kind: 'fill', box: [0, 0, 0, 12, 1, 12], cell: { block: 'stone' } }, { kind: 'fill', box: [5, 1, 0, 6, 3, 12], cell: { block: 'stone' } }, { kind: 'fill', box: [0, 1, 5, 12, 3, 6], cell: { block: 'stone' } }]);
    expect(shadeAt(g, 0.6, [2, 1, 2], UP)).toEqual([1]);
    // The floor at the wall's foot (x = 5, between z 1 and 2): two of the four samples in the wall.
    expect(shadeAt(g, 0.6, [5, 1, 2], UP)[0]).toBeCloseTo(1 - 0.6 * (2 / 3), 6);
    // The wall's face at its foot: the floor under the crease shades it alike.
    expect(shadeAt(g, 0.6, [5, 1, 2], [-1, 0, 0])[0]).toBeCloseTo(1 - 0.6 * (2 / 3), 6);
    // The wall's face half way up its two rows: all four samples in the open column beside it.
    expect(shadeAt(g, 0.6, [5, 2, 2], [-1, 0, 0])[0]).toBe(1);
    // The inside corner: three closed.
    expect(shadeAt(g, 0.6, [5, 1, 5], UP)[0]).toBeCloseTo(0.4, 6);
    // Strength 0: none.
    expect(shadeAt(g, 0, [5, 1, 5], UP)).toEqual([1]);
  });

  it('never shades sloped ground by its own steps, and walls of edge pieces shade the floor beside them', () => {
    // A slope rising a row over four cells along x, sloped tops on a solid base.
    const slope: unknown[] = [{ kind: 'fill', box: [0, 0, 0, 12, 1, 12], cell: { block: 'stone' } }];
    for (let x = 0; x < 4; x++) slope.push({ kind: 'cells', at: [x, 1, 2], cell: { block: 'stone', corners: [x / 4, (x + 1) / 4, (x + 1) / 4, x / 4] } });
    const g = grid(slope);
    for (const part of meshBlockChunk(g, 0, 0, TYPES, looks)) {
      const ao = chunkMeshAO(g, TYPES, part, 1);
      for (let i = 0; i < ao.length; i++) {
        const onTop = part.normals[i * 3 + 1]! > 0.9 && part.positions[i * 3 + 2]! > 2 && part.positions[i * 3 + 2]! < 3;
        if (onTop) expect(ao[i]).toBe(1);
      }
    }
    // A wall of edge pieces along x = 6 (row 1): the floor vertices on its line are shaded, open floor not.
    const wall: number[] = [];
    for (let z = 0; z < 12; z++) wall.push(6, 1, z, 0);
    const e = grid([{ kind: 'fill', box: [0, 0, 0, 12, 1, 12], cell: { block: 'stone' } }, { kind: 'edges', at: wall, edge: { block: 'wall' } }]);
    expect(shadeAt(e, 0.6, [6, 1, 3], UP)[0]).toBeLessThan(1);
    expect(shadeAt(e, 0.6, [2, 1, 3], UP)).toEqual([1]);
  });
});
