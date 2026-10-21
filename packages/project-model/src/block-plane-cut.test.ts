/**
 * The 2D plane's cut of a block layer's collision shapes: boxes for runs of
 * full cells (merged across a chunk), a 1:2 slope of sloped corners as one
 * piece, stairs a box per step, a thin wall for an edge piece across the
 * plane and none for one along it, one-way blocks apart, the half-open row
 * on a cell boundary, a cell edit changing the cut, and overlapping shapes
 * whose faces cross cut to their exact union.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits, type BlockEdit } from './block-grid';
import type { BlockLayerComponent, BlockType } from './block-layers';
import { BLOCK_EDGE_THICKNESS } from './block-edges';
import { planeCollisionChunk, planeCutChunkRows, planeCutRow, type PlaneCutPiece } from './block-plane-cut';

const LAYER: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [40, 8, 4] } };
const T = (blockId: string, shape: BlockType['shape'], extra: Partial<BlockType> = {}): BlockType => ({ blockId, name: blockId, variants: [{ color: '#888888' }], shape, ...extra });
const TYPES = new Map(
  [T('stone', 'full'), T('stairs', 'stairs'), T('ramp', 'ramp'), T('ledge', 'full', { oneWay: true }), T('wall', 'full', { placement: 'edge' }), T('slab', 'half'), T('wide', 'full', { footprint: [1, 1, 2] }), T('rampwall', 'ramp', { placement: 'edge' })].map((t) => [t.blockId, t]),
);

function grid(edits: BlockEdit[]): BlockGrid {
  const g = new BlockGrid(LAYER);
  applyBlockEdits(g, edits, { types: TYPES, stamps: new Map() });
  return g;
}

/** A piece as its bounding box in layer-local metres, rounded to 0.1 mm, and its corner count. */
const box = (p: PlaneCutPiece): number[] => {
  const xs = p.vertices.map((v) => v[0] + p.x);
  const ys = p.vertices.map((v) => v[1] + p.y);
  const r = (v: number): number => Math.round(v * 1e4) / 1e4;
  return [r(Math.min(...xs)), r(Math.min(...ys)), r(Math.max(...xs)), r(Math.max(...ys)), p.vertices.length];
};
const boxes = (ps: readonly PlaneCutPiece[]): number[][] => ps.map(box).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
/** Every piece is counter-clockwise and convex. */
const convex = (p: PlaneCutPiece): boolean =>
  p.vertices.every((a, i) => {
    const b = p.vertices[(i + 1) % p.vertices.length]!;
    const c = p.vertices[(i + 2) % p.vertices.length]!;
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0;
  });

describe('the 2D plane cut of a block layer', () => {
  it('cuts a run of full cells to one box per chunk, takes the row in front on a cell boundary and none behind', () => {
    // Ground rows 0-1 over x 0-24 in z row 1 only.
    const g = grid([{ kind: 'fill', box: [0, 0, 1, 24, 2, 2], cell: { block: 'stone' } }]);
    const at1 = planeCutRow(1, 0, 1);
    expect(at1).toEqual({ localZ: 1, row: 1 });
    expect(boxes(planeCollisionChunk(g, 0, 0, TYPES, at1.localZ, at1.row).solid)).toEqual([[0, 0, 16, 2, 4]]);
    expect(boxes(planeCollisionChunk(g, 1, 0, TYPES, at1.localZ, at1.row).solid)).toEqual([[16, 0, 24, 2, 4]]);
    // Inside the row, and from a layer moved back by half a cell.
    expect(boxes(planeCollisionChunk(g, 0, 0, TYPES, 1.5, 1).solid)).toEqual([[0, 0, 16, 2, 4]]);
    const moved = planeCutRow(1, -1.5, 0);
    expect(moved).toEqual({ localZ: 1.5, row: 1 });
    // The boundary at z 2 belongs to row 2 (empty): nothing, though row 1's front face lies on it.
    const at2 = planeCutRow(1, 0, 2);
    expect(at2.row).toBe(2);
    expect(planeCollisionChunk(g, 0, 0, TYPES, at2.localZ, at2.row)).toEqual({ solid: [], oneWay: [] });
    expect(planeCutChunkRows(1, TYPES)).toEqual([0, 0]);
  });

  it('cuts a 1:2 slope of sloped corners to one piece, stairs to a box per step, a turned ramp to a wedge', () => {
    const edits: BlockEdit[] = [
      { kind: 'fill', box: [0, 0, 0, 30, 1, 4], cell: { block: 'stone' } },
      // x 4-8: the top rises from 1 to 3 (cell heights 0-0.5, 0.5-1, then 0-0.5, 0.5-1 a row up).
      { kind: 'fill', box: [4, 1, 0, 5, 2, 4], cell: { block: 'stone', corners: [0, 0.5, 0.5, 0] } },
      { kind: 'fill', box: [5, 1, 0, 6, 2, 4], cell: { block: 'stone', corners: [0.5, 1, 1, 0.5] } },
      { kind: 'fill', box: [6, 1, 0, 7, 2, 4], cell: { block: 'stone', corners: [1, 1.5, 1.5, 1] } },
      { kind: 'fill', box: [7, 1, 0, 8, 2, 4], cell: { block: 'stone', corners: [1.5, 2, 2, 1.5] } },
      // Stairs rising toward +x (turned 90) at x 12, a ramp rising toward −x (turned 270) at x 9.
      { kind: 'fill', box: [12, 1, 0, 13, 2, 4], cell: { block: 'stairs', rot: 90 } },
      { kind: 'fill', box: [9, 1, 0, 10, 2, 4], cell: { block: 'ramp', rot: 270 } },
    ];
    const g = grid(edits);
    const pieces = planeCollisionChunk(g, 0, 0, TYPES, 1.5, 1).solid;
    expect(pieces.every(convex)).toBe(true);
    const b = boxes(pieces);
    // The slope from x 4 (top 1) to x 8 (top 3) in one piece over the ground's row.
    const slope = pieces.find((p) => box(p)[0] === 4)!;
    expect(box(slope)).toEqual([4, 0, 8, 3, 4]);
    const top = (x: number): number => Math.max(...slope.vertices.filter((v) => Math.abs(v[0] + slope.x - x) < 1e-6).map((v) => v[1] + slope.y));
    expect(top(4)).toBeCloseTo(1, 4);
    expect(top(8)).toBeCloseTo(3, 4);
    // The stairs: a box per step between x 12 and 13, each higher than the one before.
    const steps = b.filter((r) => r[0]! >= 12 && r[2]! <= 13);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < steps.length; i++) expect(steps[i]![3]!).toBeGreaterThan(steps[i - 1]![3]!);
    expect(Math.max(...steps.map((r) => r[3]!))).toBeCloseTo(2, 4);
    // The ramp rising toward −x: a piece from x 9 to 10 whose top falls from 2 to 1.
    const ramp = pieces.find((p) => box(p)[0] === 9)!;
    const rampTop = (x: number): number => Math.max(...ramp.vertices.filter((v) => Math.abs(v[0] + ramp.x - x) < 1e-6).map((v) => v[1] + ramp.y));
    expect(rampTop(9)).toBeCloseTo(2, 4);
    expect(rampTop(10)).toBeCloseTo(1, 4);
    // The flat runs between them are merged boxes of the ground's height.
    expect(b).toContainEqual([0, 0, 4, 1, 4]);
    expect(b).toContainEqual([8, 0, 9, 1, 4]);
    expect(b).toContainEqual([13, 0, 16, 1, 4]);
  });

  it('cuts an edge piece across the plane to a thin wall, leaves one along it out, keeps one-way blocks apart', () => {
    const g = grid([
      { kind: 'fill', box: [0, 0, 1, 10, 1, 2], cell: { block: 'stone' } },
      { kind: 'fill', box: [3, 3, 1, 6, 4, 2], cell: { block: 'ledge' } },
      { kind: 'edges', at: [8, 1, 1, 0], edge: { block: 'wall' } },
      { kind: 'edges', at: [2, 1, 1, 1], edge: { block: 'wall' } },
    ] as BlockEdit[]);
    const cut = planeCollisionChunk(g, 0, 0, TYPES, 1, 1);
    const t = BLOCK_EDGE_THICKNESS;
    // The wall stands on the ground: one span from the ground's bottom to the wall's top across its thickness.
    const w0 = Math.round((8 - t / 2) * 1e4) / 1e4;
    const w1 = Math.round((8 + t / 2) * 1e4) / 1e4;
    expect(boxes(cut.solid)).toEqual([
      [0, 0, w0, 1, 4],
      [w0, 0, w1, 2, 4],
      [w1, 0, 10, 1, 4],
    ]);
    expect(boxes(cut.oneWay)).toEqual([[3, 3, 6, 4, 4]]);
  });

  it('follows a cell edit, splits long and tall runs within the collider extent, and reaches a footprint from the row behind', () => {
    const g = grid([{ kind: 'fill', box: [0, 0, 1, 16, 1, 2], cell: { block: 'stone' } }]);
    expect(boxes(planeCollisionChunk(g, 0, 0, TYPES, 1.5, 1).solid)).toEqual([[0, 0, 16, 1, 4]]);
    // A pit dug at x 6-8.
    applyBlockEdits(g, [{ kind: 'fill', box: [6, 0, 1, 8, 1, 2], cell: null }], { types: TYPES, stamps: new Map() });
    expect(boxes(planeCollisionChunk(g, 0, 0, TYPES, 1.5, 1).solid)).toEqual([[0, 0, 6, 1, 4], [8, 0, 16, 1, 4]]);
    // 8 m cells: a chunk is 128 m wide and 8 rows 64 m tall: two pieces across, one tall.
    const big = new BlockGrid({ cellSize: [8, 8, 8], bounds: { min: [0, 0, 0], max: [16, 8, 2] } });
    applyBlockEdits(big, [{ kind: 'fill', box: [0, 0, 0, 16, 8, 1], cell: { block: 'stone' } }], { types: TYPES, stamps: new Map() });
    const pieces = planeCollisionChunk(big, 0, 0, TYPES, 4, 0).solid;
    expect(boxes(pieces)).toEqual([[0, 0, 64, 64, 4], [64, 0, 128, 64, 4]]);
    expect(pieces.every((p) => p.vertices.every((v) => Math.abs(v[0]) <= 64 && Math.abs(v[1]) <= 64))).toBe(true);
    // A block two cells deep anchored in the row behind the plane reaches it.
    const deep = grid([{ kind: 'fill', box: [2, 0, 0, 3, 1, 1], cell: { block: 'wide' } }]);
    expect(planeCutChunkRows(1, TYPES)).toEqual([0, 0]);
    expect(boxes(planeCollisionChunk(deep, 0, 0, TYPES, 1.5, 1).solid)).toEqual([[2, 0, 3, 1, 4]]);
  });

  it('cuts shapes whose faces cross inside a slab to their exact union', () => {
    // A ramp rising toward +x in cell x 8 and, on its x line, an edge ramp falling toward +x across its thickness:
    // the edge piece's top crosses the ramp's just right of x 8, inside the slab from x 8 to the edge's far side.
    const ground: BlockEdit = { kind: 'fill', box: [0, 0, 1, 16, 1, 2], cell: { block: 'stone' } };
    const ramp: BlockEdit = { kind: 'fill', box: [8, 1, 1, 9, 2, 2], cell: { block: 'ramp', rot: 90 } };
    const edge = { kind: 'edges', at: [8, 1, 1, 0], edge: { block: 'rampwall', rot: 180 } } as BlockEdit;
    const cut = (edits: BlockEdit[]): PlaneCutPiece[] => planeCollisionChunk(grid(edits), 0, 0, TYPES, 1.5, 1).solid;
    const both = cut([ground, ramp, edge]);
    const apart = [...cut([ground, ramp]), ...cut([ground, edge])];
    expect(both.every(convex)).toBe(true);
    // Inside a convex counter-clockwise piece by more than a hair: the comparison skips points on any boundary.
    const depth = (p: PlaneCutPiece, x: number, y: number): number =>
      Math.min(
        ...p.vertices.map((a, i) => {
          const b = p.vertices[(i + 1) % p.vertices.length]!;
          const ex = b[0] - a[0];
          const ey = b[1] - a[1];
          return (ex * (y - p.y - a[1]) - ey * (x - p.x - a[0])) / Math.hypot(ex, ey);
        }),
      );
    const inside = (ps: readonly PlaneCutPiece[], x: number, y: number): number => Math.max(...ps.map((p) => depth(p, x, y)));
    const wrong: [number, number][] = [];
    for (let x = 7.9; x <= 8.1; x += 0.0025) {
      for (let y = 0.5; y <= 2.1; y += 0.0025) {
        const a = inside(both, x, y);
        const b = inside(apart, x, y);
        if (Math.abs(a) > 1e-3 && Math.abs(b) > 1e-3 && a > 0 !== b > 0) wrong.push([x, y]);
      }
    }
    expect(wrong.length, JSON.stringify(wrong.slice(0, 3))).toBe(0);
  });
});
