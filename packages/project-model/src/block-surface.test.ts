/**
 * Sloped block-layer terrain: corner heights as cell data, the warped mesh
 * (render and collision) lying exactly on the surface the queries report,
 * hidden faces between matching slopes, walls where neighbours differ, and
 * patterns (copy, turn, mirror, raise/lower) keeping the slope's shape.
 * Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import { canonicalBlockCell, composeBlockLayers, validateBlockCell, validateBlockLayerComponent, type BlockCell, type BlockLayerComponent, type BlockType } from './block-layers';
import { applyBlockEdits, BlockGrid, type BlockEdit } from './block-grid';
import { collisionMeshChunk, meshBlockChunk, shapeSource, type ChunkMeshPart } from './block-mesh';
import { blockTopAt, cornerHeightAt, surfaceBelow } from './block-surface';
import type { ModelErrorV2 } from './errors';

const TYPES: BlockType[] = [
  { blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' },
  { blockId: 'slab', name: 'Slab', variants: [{ color: '#aaaaaa' }], shape: 'half' },
  { blockId: 'ramp', name: 'Ramp', variants: [{ color: '#777777' }], shape: 'ramp' },
];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
const ctx = { types, stamps: new Map() };
const errs = (fn: (e: ModelErrorV2[]) => void): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  fn(e);
  return e;
};
const layer = (cellSize: [number, number, number] = [1, 1, 1]): BlockLayerComponent => ({ cellSize, bounds: { min: [0, 0, 0], max: [16, 8, 16] } });
const edit = (g: BlockGrid, ...edits: BlockEdit[]): void => {
  const r = applyBlockEdits(g, edits, ctx);
  if (!r.ok) throw new Error(`${r.path}: ${r.message}`);
};
const standIns = { source: (t: BlockType, _v: number, fm: [number, number, number]) => ({ key: `c:${t.blockId}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes) }) };

/** The height of the triangles of `parts` straight under (x, z) — the highest hit, or null (a ray against the mesh). */
function meshHeight(tris: number[][][], x: number, z: number): number | null {
  let best: number | null = null;
  for (const [a, b, c] of tris as [number[], number[], number[]][]) {
    const d = (b[0]! - a[0]!) * (c[2]! - a[2]!) - (c[0]! - a[0]!) * (b[2]! - a[2]!);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((x - a[0]!) * (c[2]! - a[2]!) - (c[0]! - a[0]!) * (z - a[2]!)) / d;
    const l2 = ((b[0]! - a[0]!) * (z - a[2]!) - (x - a[0]!) * (b[2]! - a[2]!)) / d;
    if (l1 < -1e-9 || l2 < -1e-9 || l1 + l2 > 1 + 1e-9) continue;
    const y = a[1]! + l1 * (b[1]! - a[1]!) + l2 * (c[1]! - a[1]!);
    if (best === null || y > best) best = y;
  }
  return best;
}
const trisOf = (parts: readonly ChunkMeshPart[]): number[][][] =>
  parts.flatMap((p) => {
    const out: number[][][] = [];
    for (let i = 0; i < p.indices.length; i += 3) out.push([0, 1, 2].map((k) => [p.positions[p.indices[i + k]! * 3]!, p.positions[p.indices[i + k]! * 3 + 1]!, p.positions[p.indices[i + k]! * 3 + 2]!]));
    return out;
  });
const collisionTris = (g: BlockGrid): number[][][] =>
  collisionMeshChunk(g, 0, 0, types).flatMap((p) => {
    const out: number[][][] = [];
    for (let i = 0; i < p.indices.length; i += 3) out.push([0, 1, 2].map((k) => [p.vertices[p.indices[i + k]! * 3]!, p.vertices[p.indices[i + k]! * 3 + 1]!, p.vertices[p.indices[i + k]! * 3 + 2]!]));
    return out;
  });

describe('sloped cells: data rules', () => {
  it('corners are four 1/64 steps in 0-4 on a block cell; all-1 is the flat top and is dropped', () => {
    expect(errs((e) => validateBlockCell({ block: 'soil', corners: [1, 0.5, 0.25, 0.015625] }, '', e))).toEqual([]);
    expect(errs((e) => validateBlockCell({ block: 'soil', corners: [2, 1.5, 0.25, 1] }, '', e))).toEqual([]);
    expect(errs((e) => validateBlockCell({ block: 'soil', corners: [4.015625, 1, 1, 1] }, '', e)).map((x) => x.path)).toEqual(['/corners']);
    expect(errs((e) => validateBlockCell({ block: 'soil', corners: [1, 0.3, 1, 1] }, '', e)).map((x) => x.path)).toEqual(['/corners']);
    expect(errs((e) => validateBlockCell({ block: 'soil', corners: [1, 1, 1] }, '', e)).map((x) => x.path)).toEqual(['/corners']);
    expect(errs((e) => validateBlockCell({ block: 'soil', corners: [0, 0, 0, 0] }, '', e)).map((x) => x.path)).toEqual(['/corners']);
    expect(errs((e) => validateBlockCell({ corners: [1, 0.5, 1, 1], meta: { a: 1 } }, '', e)).map((x) => x.path)).toContain('/corners');
    expect(canonicalBlockCell({ block: 'soil', corners: [1, 1, 1, 1] })).toEqual({ block: 'soil' });
    expect(canonicalBlockCell({ meta: { a: 1 }, corners: [0.5, 1, 1, 1], block: 'soil' })).toEqual({ block: 'soil', corners: [0.5, 1, 1, 1], meta: { a: 1 } });
  });

  it('only a single-cell full block slopes; maxSlope is degrees 1-89', () => {
    const g = new BlockGrid(layer());
    edit(g, { kind: 'cells', at: [0, 0, 0], cell: { block: 'slab', corners: [1, 0.5, 1, 1] } }, { kind: 'cells', at: [1, 0, 0], cell: { block: 'soil', corners: [1, 0.5, 1, 1] } });
    const data = g.toData('ground', null, g.takeDirty().chunks)!;
    const e = errs((x) => composeBlockLayers([data], [{ id: 'ground', components: { blockLayer: layer() } }], { blockTypes: TYPES }, x));
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain('single-cell full block');
    expect(errs((x) => validateBlockLayerComponent({ ...layer(), maxSlope: 30 }, '', x))).toEqual([]);
    expect(errs((x) => validateBlockLayerComponent({ ...layer(), maxSlope: 90 }, '', x)).map((y) => y.path)).toEqual(['/maxSlope']);
  });
});

describe('sloped cells: the mesh is the surface', () => {
  const CORNERS: [number, number, number, number][] = [
    [1, 0.5, 0.25, 0.75],
    [0.015625, 1, 0.5, 0.25],
    [0, 0, 1, 1],
    [1, 0, 1, 0],
  ];
  for (const cellSize of [[1, 1, 1], [2, 0.5, 2]] as [number, number, number][]) {
    for (const rot of [0, 90, 180, 270] as const) {
      it(`render and collision triangles lie on the corner surface (cell ${cellSize.join('×')}, rotation ${rot})`, () => {
        for (const corners of CORNERS) {
          const g = new BlockGrid(layer(cellSize));
          const cell: BlockCell = { block: 'soil', corners, ...(rot !== 0 ? { rot } : {}) };
          edit(g, { kind: 'cells', at: [3, 2, 4], cell });
          const render = trisOf(meshBlockChunk(g, 0, 0, types, standIns));
          const collision = collisionTris(g);
          for (let i = 0; i <= 8; i++)
            for (let j = 0; j <= 8; j++) {
              const u = 0.02 + (0.96 * i) / 8;
              const v = 0.02 + (0.96 * j) / 8;
              const x = (3 + u) * cellSize[0];
              const z = (4 + v) * cellSize[2];
              const expected = (2 + cornerHeightAt(corners, u, v)) * cellSize[1];
              expect(meshHeight(render, x, z)).toBeCloseTo(expected, 5);
              expect(meshHeight(collision, x, z)).toBeCloseTo(expected, 5);
              const s = surfaceBelow(g, types, x, 100, z);
              expect(s!.height).toBeCloseTo(expected, 9);
              expect(s!.cell).toEqual([3, 2, 4]);
            }
        }
      });
    }
  }

  it('the normal and slope follow the corners: a 1-in-2 rise along +x is 26.57°', () => {
    const g = new BlockGrid(layer([2, 1, 2]));
    edit(g, { kind: 'cells', at: [0, 0, 0], cell: { block: 'soil', corners: [0, 1, 1, 0] } });
    const s = surfaceBelow(g, types, 1, 5, 1)!;
    expect(s.slope).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 9);
    expect(s.normal[0]).toBeLessThan(0);
    expect(s.normal[2]).toBeCloseTo(0, 12);
    // Every warped render normal of the top points along the surface normal.
    const part = meshBlockChunk(g, 0, 0, types, standIns)[0]!;
    let seen = 0;
    for (let i = 0; i < part.normals.length; i += 3) {
      if (part.normals[i + 1]! < 0.5) continue;
      seen += 1;
      expect(part.normals[i]).toBeCloseTo(s.normal[0], 6);
      expect(part.normals[i + 1]).toBeCloseTo(s.normal[1], 6);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('matching slopes hide the side between them; different heights leave the wall', () => {
    const g = new BlockGrid(layer());
    // Two cells rising together along +x: the shared side (+x of the first, −x of the second) matches.
    edit(g, { kind: 'cells', at: [0, 0, 0], cell: { block: 'soil', corners: [0.25, 0.5, 0.5, 0.25] } }, { kind: 'cells', at: [1, 0, 0], cell: { block: 'soil', corners: [0.5, 0.75, 0.75, 0.5] } });
    const tris = trisOf(meshBlockChunk(g, 0, 0, types, standIns));
    const onPlaneX1 = tris.filter((t) => t.every((p) => Math.abs(p[0]! - 1) < 1e-6));
    expect(onPlaneX1).toEqual([]);
    // A step: the second cell's shared edge is higher — both sides stay (the higher one shows the wall).
    const h = new BlockGrid(layer());
    edit(h, { kind: 'cells', at: [0, 0, 0], cell: { block: 'soil', corners: [0.25, 0.5, 0.5, 0.25] } }, { kind: 'cells', at: [1, 0, 0], cell: { block: 'soil', corners: [0.75, 1, 1, 0.75] } });
    const wall = trisOf(meshBlockChunk(h, 0, 0, types, standIns)).filter((t) => t.every((p) => Math.abs(p[0]! - 1) < 1e-6));
    expect(wall.length).toBeGreaterThan(0);
    // A flat neighbour hides the sloped cell's side facing it, and a sloped neighbour never hides a flat cell's side.
    const f = new BlockGrid(layer());
    edit(f, { kind: 'cells', at: [0, 0, 0], cell: { block: 'soil' } }, { kind: 'cells', at: [1, 0, 0], cell: { block: 'soil', corners: [0.5, 1, 1, 0.5] } });
    const facing = trisOf(meshBlockChunk(f, 0, 0, types, standIns)).filter((t) => t.every((p) => Math.abs(p[0]! - 1) < 1e-6));
    // Only the flat cell's full side (2 triangles) is left on x = 1.
    expect(facing).toHaveLength(2);
    expect(Math.max(...facing.flat().map((p) => p[1]!))).toBe(1);
  });

  it('a layer without corners meshes exactly as before (render and collision bytes pinned)', () => {
    const g = new BlockGrid(layer());
    edit(
      g,
      { kind: 'fill', box: [0, 0, 0, 6, 2, 5], cell: { block: 'soil' } },
      { kind: 'cells', at: [1, 2, 1], cell: { block: 'ramp', rot: 90 } },
      { kind: 'cells', at: [2, 2, 1], cell: { block: 'ramp' } },
      { kind: 'cells', at: [3, 2, 2], cell: { block: 'slab' } },
      { kind: 'cells', at: [4, 2, 2], cell: { block: 'slab' } },
      { kind: 'cells', at: [0, 3, 0], cell: { block: 'soil' } },
      { kind: 'column', at: [5, 4], delta: -1 },
    );
    expect(meshDigest(meshBlockChunk(g, 0, 0, types, standIns), collisionMeshChunk(g, 0, 0, types))).toBe(PINNED_FLAT_DIGEST);
  });
});

/** FNV-1a over the meshes' numbers (positions rounded to 1e-6), in order. */
function meshDigest(parts: readonly ChunkMeshPart[], pieces: readonly { vertices: number[]; indices: number[] }[]): string {
  let h = 0x811c9dc5;
  const add = (n: number): void => {
    const s = String(Math.round(n * 1e6));
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ 44, 0x01000193) >>> 0;
  };
  for (const p of parts) {
    for (const k of p.key) add(k.charCodeAt(0));
    for (const arr of [p.positions, p.normals, p.uvs, p.indices]) for (const v of arr) add(v);
  }
  for (const p of pieces) for (const arr of [p.vertices, p.indices]) for (const v of arr) add(v);
  return h.toString(16);
}
/** The digest of the mesher before sloped cells existed (the same edits, measured on the previous code). */
const PINNED_FLAT_DIGEST = '4cd820fc';

describe('smooth slopes across rows', () => {
  /** A lane rising `rise` cells per column from column x0 (flat floor of one row before it): each column's top cell is the row under its lowest corner. */
  function lane(g: BlockGrid, z: number, x0: number, n: number, rise: number): void {
    for (let x = 0; x < x0 + n; x++) {
      const h0 = 1 + Math.max(0, x - x0) * rise;
      const h1 = 1 + Math.max(0, x + 1 - x0) * rise;
      const top = Math.max(0, Math.floor(Math.min(h0, h1)) - (Number.isInteger(Math.max(h0, h1)) && h0 === h1 ? 1 : 0));
      if (top > 0) edit(g, { kind: 'fill', box: [x, 0, z, x + 1, top, z + 1], cell: { block: 'soil' } });
      const c: [number, number, number, number] = [h0 - top, h1 - top, h1 - top, h0 - top];
      edit(g, { kind: 'cells', at: [x, top, z], cell: { block: 'soil', ...(c.every((v) => v === 1) ? {} : { corners: c }) } });
    }
  }
  it('a slope of 0.375 cells per column crossing rows is one continuous surface (render, collision and query agree, no step)', () => {
    const g = new BlockGrid(layer());
    for (let z = 0; z < 3; z++) lane(g, z, 2, 10, 0.375);
    const render = trisOf(meshBlockChunk(g, 0, 0, types, standIns));
    const collision = collisionTris(g);
    for (let i = 0; i < 120; i++) {
      const x = 0.05 + i * 0.1;
      const want = 1 + Math.max(0, x - 2) * 0.375;
      expect(surfaceBelow(g, types, x, 20, 1.5)!.height).toBeCloseTo(want, 9);
      expect(meshHeight(render, x, 1.5)).toBeCloseTo(want, 5);
      expect(meshHeight(collision, x, 1.5)).toBeCloseTo(want, 5);
    }
    // Nothing is drawn above the surface (no faces left standing out at a row boundary).
    for (const t of render) for (const p of t) if (p[2]! > 0.01 && p[2]! < 2.99) expect(p[1]!).toBeLessThanOrEqual(1 + Math.max(0, p[0]! - 2) * 0.375 + 1e-5);
  });
});

describe('sloped cells: patterns and columns keep the slope', () => {
  const surfaceGrid = (g: BlockGrid, x0: number, z0: number, n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n * 4; i++) for (let j = 0; j < n * 4; j++) out.push(Math.round(surfaceBelow(g, types, x0 + (i + 0.5) / 4, 100, z0 + (j + 0.5) / 4)!.height * 1e6) / 1e6);
    return out;
  };
  it('a copy turned a quarter turn or mirrored turns and mirrors the surface', () => {
    const g = new BlockGrid(layer());
    edit(g, { kind: 'cells', at: [0, 0, 0], cell: { block: 'soil', corners: [0.25, 0.5, 1, 0.75] } }, { kind: 'cells', at: [1, 0, 0], cell: { block: 'soil', corners: [0.5, 0.125, 1, 1] } });
    edit(g, { kind: 'copy', box: [0, 0, 0, 2, 1, 1], to: [8, 0, 8], rot: 90 });
    edit(g, { kind: 'copy', box: [0, 0, 0, 2, 1, 1], to: [8, 0, 12], mirror: 'x' });
    // The source sampled on a 4-per-cell grid, compared point by point with the turned and the mirrored copy.
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 4; j++) {
        const x = (i + 0.5) / 4;
        const z = (j + 0.5) / 4;
        const src = surfaceBelow(g, types, x, 100, z)!.height;
        // A quarter turn counter-clockwise from above over a 2 × 1 box: (x, z) → (z, 2 − x).
        expect(surfaceBelow(g, types, 8 + z, 100, 8 + (2 - x))!.height).toBeCloseTo(src, 9);
        expect(surfaceBelow(g, types, 8 + (2 - x), 100, 12 + z)!.height).toBeCloseTo(src, 9);
      }
    void surfaceGrid;
  });

  it('raising and lowering a sloped column moves its slope with the top', () => {
    const g = new BlockGrid(layer());
    edit(g, { kind: 'fill', box: [0, 0, 0, 1, 2, 1], cell: { block: 'soil' } }, { kind: 'cells', at: [0, 1, 0], cell: { block: 'soil', corners: [1, 0.5, 0.5, 1] } });
    edit(g, { kind: 'column', at: [0, 0], delta: 2 });
    expect(g.get(0, 1, 0)).toEqual({ block: 'soil' });
    expect(g.get(0, 3, 0)).toEqual({ block: 'soil', corners: [1, 0.5, 0.5, 1] });
    edit(g, { kind: 'column', at: [0, 0], delta: -3 });
    expect(g.get(0, 0, 0)).toEqual({ block: 'soil', corners: [1, 0.5, 0.5, 1] });
    expect(g.columnTop(0, 0)).toBe(0);
  });
});

describe('surfaces of the other shapes', () => {
  it('half, ramp (every rotation) and full tops agree with the mesh; points inside the blocks read the top of the stack', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const g = new BlockGrid(layer([1, 0.5, 1]));
      edit(g, { kind: 'fill', box: [0, 0, 0, 1, 3, 1], cell: { block: 'soil' } }, { kind: 'cells', at: [1, 0, 0], cell: { block: 'slab' } }, { kind: 'cells', at: [2, 0, 0], cell: { block: 'ramp', ...(rot !== 0 ? { rot } : {}) } });
      const tris = trisOf(meshBlockChunk(g, 0, 0, types, standIns));
      for (const [x, z] of [[0.5, 0.5], [1.3, 0.2], [2.1, 0.3], [2.5, 0.5], [2.9, 0.7], [2.2, 0.9]] as const) {
        expect(surfaceBelow(g, types, x, 9, z)!.height).toBeCloseTo(meshHeight(tris, x, z)!, 6);
      }
      expect(surfaceBelow(g, types, 2.5, 9, 0.5)!.slope).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 9);
    }
    const g = new BlockGrid(layer());
    edit(g, { kind: 'fill', box: [0, 0, 0, 1, 3, 1], cell: { block: 'soil' } });
    expect(surfaceBelow(g, types, 0.5, 1.2, 0.5)!.height).toBe(3);
    expect(surfaceBelow(g, types, 0.5, 9, 0.5)!.cell).toEqual([0, 2, 0]);
    expect(surfaceBelow(g, types, 5.5, 9, 5.5)).toBeNull();
    expect(blockTopAt(TYPES[0]!, { block: 'soil' }, [1, 1, 1], 0, 0)).toEqual({ height: 1, gx: 0, gz: 0 });
  });
});
