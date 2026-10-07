/**
 * Auto-connect: a connected block type's cells and edge pieces show the piece
 * their neighbours call for, turned to fit — checked through the mesher (the
 * looks' arms reach toward the neighbours), the rules' validation and
 * content checks, and the chunks a neighbour's change re-meshes.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from './block-grid';
import { canonicalBlockType, composeBlockContent, validateBlockType, type BlockLayerComponent, type BlockType } from './block-layers';
import { cellConnectNeighbours, edgeConnectNeighbours, resolveCellLook, resolveEdgeLook } from './block-connect';
import { meshBlockChunk, shapeSource, type BlockMeshSource } from './block-mesh';
import type { ModelErrorV2 } from './errors';

const LAYER: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [48, 8, 48] } };

// Variants: 0 the ordinary look, then one per piece. Each look is a post with an arm toward each side the piece
// connects at rotation 0 (+Z the block's forward), stopping short of the cell's side so every arm is its own cell's.
const ARMS: readonly string[][] = [[], [], ['+z'], ['-z', '+z'], ['+x', '+z'], ['-x', '+x', '+z'], ['-x', '+x', '-z', '+z'], ['+z']];
const WALL: BlockType = {
  blockId: 'wall',
  name: 'Wall',
  variants: ARMS.map((_, i) => ({ color: `#0000${(i * 16).toString(16).padStart(2, '0')}` })),
  shape: 'custom',
  boxes: [[0.4, 0, 0.4, 0.6, 1, 0.6]],
  connect: { pieces: { single: { variant: 1 }, end: { variant: 2 }, straight: { variant: 3 }, corner: { variant: 4 }, t: { variant: 5 }, cross: { variant: 6 } } },
};
const GATE: BlockType = { blockId: 'gate', name: 'Gate', variants: [{ color: '#884422' }], shape: 'full' };
const TYPES = new Map([WALL, GATE].map((t) => [t.blockId, t]));
const ctx = { types: TYPES, stamps: new Map() };

const ARM_BOX: Record<string, number[]> = { '+x': [0.6, 0, 0.45, 0.95, 1, 0.55], '-x': [0.05, 0, 0.45, 0.4, 1, 0.55], '+z': [0.45, 0, 0.6, 0.55, 1, 0.95], '-z': [0.45, 0, 0.05, 0.55, 1, 0.4] };
function armSource(arms: readonly string[], fm: [number, number, number]): BlockMeshSource {
  return shapeSource('custom', fm[0], fm[1], fm[2], [[0.4, 0, 0.4, 0.6, 1, 0.6], ...arms.map((a) => ARM_BOX[a]!)]);
}
const looks = { source: (t: BlockType, v: number, fm: [number, number, number]) => ({ key: `${t.blockId}:${v}`, source: t.blockId === 'wall' ? armSource(ARMS[v]!, fm) : shapeSource('full', fm[0], fm[1], fm[2]), uv: 'world' as const }) };

/** The sides of a cell (x, y, z) the drawn arms reach toward (vertices on the planes 0.05 inside its sides). */
function drawnArms(parts: ReturnType<typeof meshBlockChunk>, x: number, y: number, z: number): string[] {
  const seen = new Set<string>();
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4;
  for (const p of parts) {
    for (let i = 0; i < p.positions.length; i += 3) {
      const [px, py, pz] = [p.positions[i]!, p.positions[i + 1]!, p.positions[i + 2]!];
      if (px < x - 1e-4 || px > x + 1 + 1e-4 || pz < z - 1e-4 || pz > z + 1 + 1e-4 || py < y - 1e-4 || py > y + 1 + 1e-4) continue;
      if (near(px, x + 0.95)) seen.add('+x');
      if (near(px, x + 0.05)) seen.add('-x');
      if (near(pz, z + 0.95)) seen.add('+z');
      if (near(pz, z + 0.05)) seen.add('-z');
    }
  }
  return [...seen].sort();
}

/** The sides a cell has connected neighbours on. */
function neighbourSides(g: BlockGrid, x: number, y: number, z: number): string[] {
  const out: string[] = [];
  for (const [s, dx, dz] of [['+x', 1, 0], ['-x', -1, 0], ['+z', 0, 1], ['-z', 0, -1]] as const) if (g.get(x + dx, y, z + dz)?.block === 'wall') out.push(s);
  return out.sort();
}

function typeErrors(t: unknown): string[] {
  const errors: ModelErrorV2[] = [];
  validateBlockType(t, '', errors);
  return errors.map((e) => `${e.path}: ${e.message}`);
}

describe('auto-connect', () => {
  // A run along z = 2 from x = 2 to 8, turning up z at x = 2 (a corner), a T at x = 5 made a cross by (5, 1).
  const RUN: [number, number][] = [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [2, 3], [2, 4], [5, 3], [5, 4], [5, 1], [12, 12]];

  it('painting a wall resolves every cell to the piece its neighbours call for, turned onto them', () => {
    const g = new BlockGrid(LAYER);
    expect(applyBlockEdits(g, [{ kind: 'cells', at: RUN.flatMap(([x, z]) => [x, 1, z]), cell: { block: 'wall' } }], ctx).ok).toBe(true);
    const pieces = Object.fromEntries(RUN.map(([x, z]) => [`${x},${z}`, resolveCellLook(g, WALL, g.get(x, 1, z)!, x, 1, z, 0)]));
    expect(pieces['2,2']).toEqual({ variant: 4, rot: 0, piece: 'corner' });
    expect(pieces['3,2']).toEqual({ variant: 3, rot: 90, piece: 'straight' });
    expect(pieces['5,2']).toEqual({ variant: 6, rot: 0, piece: 'cross' });
    expect(pieces['8,2']).toEqual({ variant: 2, rot: 270, piece: 'end' });
    expect(pieces['2,4']).toEqual({ variant: 2, rot: 180, piece: 'end' });
    expect(pieces['5,1']).toEqual({ variant: 2, rot: 0, piece: 'end' });
    expect(pieces['12,12']).toEqual({ variant: 1, rot: 0, piece: 'single' });
    // Drawn: each cell's arms reach exactly toward its neighbours (the mesher's own rotation).
    const parts = meshBlockChunk(g, 0, 0, TYPES, looks);
    for (const [x, z] of RUN) expect(drawnArms(parts, x, 1, z), `cell ${x},${z}`).toEqual(neighbourSides(g, x, 1, z));
    // A T where the cross loses (5, 1) (unturned: its stem toward +z); without (5, 3) instead, turned half round.
    applyBlockEdits(g, [{ kind: 'cells', at: [5, 1, 1], cell: null }], ctx);
    expect(resolveCellLook(g, WALL, g.get(5, 1, 2)!, 5, 1, 2, 0)).toEqual({ variant: 5, rot: 0, piece: 't' });
    applyBlockEdits(g, [{ kind: 'cells', at: [5, 1, 1], cell: { block: 'wall' } }, { kind: 'cells', at: [5, 1, 3], cell: null }], ctx);
    expect(resolveCellLook(g, WALL, g.get(5, 1, 2)!, 5, 1, 2, 0)).toEqual({ variant: 5, rot: 180, piece: 't' });
    expect(drawnArms(meshBlockChunk(g, 0, 0, TYPES, looks), 5, 1, 2)).toEqual(['+x', '-x', '-z']);
  });

  it('keeps a cell\'s own turn where several fit, adds a piece\'s extra turn, and leaves pinned cells and unnamed pieces alone', () => {
    const g = new BlockGrid(LAYER);
    applyBlockEdits(g, [{ kind: 'cells', at: [1, 0, 1, 2, 0, 1, 3, 0, 1], cell: { block: 'wall', rot: 270 } }], ctx);
    // A straight run along x fits 90 and 270: the cell's 270 stays.
    expect(resolveCellLook(g, WALL, g.get(2, 0, 1)!, 2, 0, 1, 0).rot).toBe(270);
    // A look made along x: its straight piece turns a further 90.
    const alongX: BlockType = { ...WALL, connect: { pieces: { straight: { variant: 3, rot: 90 } } } };
    expect(resolveCellLook(g, alongX, g.get(2, 0, 1)!, 2, 0, 1, 0)).toEqual({ variant: 3, rot: 0, piece: 'straight' });
    // No end piece named: the ends keep their ordinary look and turn.
    expect(resolveCellLook(g, alongX, g.get(1, 0, 1)!, 1, 0, 1, 7)).toEqual({ variant: 7, rot: 270, piece: null });
    // A cell that names a variant is pinned.
    applyBlockEdits(g, [{ kind: 'cells', at: [2, 0, 1], cell: { block: 'wall', variant: 0 } }], ctx);
    expect(resolveCellLook(g, WALL, g.get(2, 0, 1)!, 2, 0, 1, 0)).toEqual({ variant: 0, rot: 0, piece: null });
  });

  it('base and cap win over the horizontal piece and keep its turn; with connects other types', () => {
    const tall: BlockType = { ...WALL, connect: { with: ['gate'], pieces: { ...WALL.connect!.pieces, base: { variant: 7 }, cap: { variant: 7, rot: 180 } } } };
    const types = new Map([[tall.blockId, tall], [GATE.blockId, GATE]]);
    const g = new BlockGrid(LAYER);
    applyBlockEdits(g, [{ kind: 'fill', box: [2, 0, 2, 5, 3, 3], cell: { block: 'wall' } }, { kind: 'cells', at: [5, 1, 2], cell: { block: 'gate' } }], { types, stamps: new Map() });
    expect(resolveCellLook(g, tall, g.get(3, 0, 2)!, 3, 0, 2, 0)).toEqual({ variant: 7, rot: 90, piece: 'base' });
    expect(resolveCellLook(g, tall, g.get(3, 1, 2)!, 3, 1, 2, 0)).toEqual({ variant: 3, rot: 90, piece: 'straight' });
    expect(resolveCellLook(g, tall, g.get(3, 2, 2)!, 3, 2, 2, 0)).toEqual({ variant: 7, rot: 270, piece: 'cap' });
    // The gate beside (4, 1) counts: a straight piece, not an end.
    expect(resolveCellLook(g, tall, g.get(4, 1, 2)!, 4, 1, 2, 0).piece).toBe('straight');
    expect(resolveCellLook(g, tall, g.get(4, 0, 2)!, 4, 0, 2, 0).piece).toBe('base');
  });

  it('edge pieces resolve from their ends: single, end (joined end at +X), straight, corner at a turn (straight without one)', () => {
    const fence: BlockType = { blockId: 'fence', name: 'Fence', variants: [{ color: '#111111' }, { color: '#222222' }, { color: '#333333' }, { color: '#444444' }, { color: '#555555' }], shape: 'full', placement: 'edge', connect: { pieces: { single: { variant: 1 }, end: { variant: 2 }, straight: { variant: 3 }, corner: { variant: 4 } } } };
    const types = new Map([[fence.blockId, fence]]);
    const g = new BlockGrid(LAYER);
    // An L: along the z = 4 line from x = 2 to 5 (axis 1), then up the x = 5 line from z = 4 to 6 (axis 0). A lone edge apart.
    applyBlockEdits(g, [{ kind: 'edges', at: [2, 0, 4, 1, 3, 0, 4, 1, 4, 0, 4, 1, 5, 0, 4, 0, 5, 0, 5, 0, 10, 0, 10, 1], edge: { block: 'fence' } }], { types, stamps: new Map() });
    const at = (x: number, z: number, axis: number) => resolveEdgeLook(g, fence, g.edgeAt(x, 0, z, axis)!, x, 0, z, axis, 0);
    // (2, 4) z-line: open at x = 2, joined at x = 3; its +X end (rotation 0) is x = 3.
    expect(at(2, 4, 1)).toEqual({ variant: 2, rot: 0, piece: 'end' });
    expect(at(3, 4, 1)).toEqual({ variant: 3, rot: 0, piece: 'straight' });
    // (4, 4) z-line: a turn at x = 5 (its +X end at rotation 0).
    expect(at(4, 4, 1)).toEqual({ variant: 4, rot: 0, piece: 'corner' });
    // (5, 4) x-line: a turn at z = 4, its start, which is its +X end at rotation 0 (an x-line edge's +X runs toward −z).
    expect(at(5, 4, 0)).toEqual({ variant: 4, rot: 0, piece: 'corner' });
    // (5, 5) x-line: joined at z = 5 (start, +X at 0), open at z = 6.
    expect(at(5, 5, 0)).toEqual({ variant: 2, rot: 0, piece: 'end' });
    expect(at(10, 10, 1)).toEqual({ variant: 1, rot: 0, piece: 'single' });
    // Without a corner piece the turn shows the straight one, keeping the edge's own facing.
    const noCorner: BlockType = { ...fence, connect: { pieces: { straight: { variant: 3 } } } };
    expect(resolveEdgeLook(g, noCorner, { block: 'fence', rot: 180 }, 4, 0, 4, 1, 0)).toEqual({ variant: 3, rot: 180, piece: 'straight' });
    // Drawn: an end piece whose look stands on its +X half sits on the joined half of its edge.
    const half = (t: BlockType, v: number, fm: [number, number, number]): BlockMeshSource => (v === 2 ? shapeSource('custom', fm[0], fm[1], fm[2], [[0.5, 0, 0.4, 1, 1, 0.6]]) : shapeSource('full', fm[0], fm[1], fm[2]));
    const parts = meshBlockChunk(g, 0, 0, types, { source: (t, v, fm) => ({ key: `${t.blockId}:${v}`, source: half(t, v, fm), uv: 'world' as const }) });
    const endPart = parts.find((p) => p.variant === 2)!;
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < endPart.positions.length; i += 3) {
      if (endPart.positions[i + 2]! > 3.9 && endPart.positions[i + 2]! < 4.1) xs.push(endPart.positions[i]!);
      else if (endPart.positions[i]! > 4.9 && endPart.positions[i]! < 5.1) zs.push(endPart.positions[i + 2]!);
    }
    // (2, 4): x from 2.5 to 3 (the joined half); (5, 5): z from 5 to 5.5.
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([2.5, 3]);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([5, 5.5]);
  });

  it('a neighbour written across a chunk border re-meshes the chunk whose look it changes (edges too; opening a door does not)', () => {
    const fence: BlockType = { blockId: 'fence', name: 'Fence', variants: [{ color: '#111111' }], shape: 'full', placement: 'edge', blocking: true };
    const g = new BlockGrid(LAYER);
    g.setEdge(15, 0, 3, 1, { block: 'fence' });
    g.takeDirty();
    g.setEdge(16, 0, 3, 1, { block: 'fence' });
    expect(g.takeDirty().mesh).toEqual(expect.arrayContaining(['0,0', '1,0']));
    g.setEdge(16, 0, 3, 1, { block: 'fence', open: true });
    expect(g.takeDirty().mesh).toEqual(['1,0']);
    void fence;
    expect(cellConnectNeighbours(1, 2, 3)).toHaveLength(6);
    // An edge's neighbours: three at each end, above and below.
    expect(edgeConnectNeighbours(5, 0, 4, 0)).toEqual([[5, 0, 3, 0], [4, 0, 4, 1], [5, 0, 4, 1], [5, 0, 5, 0], [4, 0, 5, 1], [5, 0, 5, 1], [5, -1, 4, 0], [5, 1, 4, 0]]);
  });

  it('validates the rules and checks them against the content', () => {
    expect(typeErrors(WALL)).toEqual([]);
    expect(typeErrors({ ...WALL, connect: { pieces: { bend: { variant: 0 } } } }).join()).toContain('a piece is one of');
    expect(typeErrors({ ...WALL, connect: { pieces: { end: { variant: 9 } } } }).join()).toContain('variant is an index');
    expect(typeErrors({ ...WALL, connect: { pieces: { end: { variant: 1, rot: 45 } } } }).join()).toContain('rot is 0, 90');
    expect(typeErrors({ ...WALL, connect: { with: ['gate', 'gate'], pieces: {} } }).join()).toContain('distinct');
    expect(typeErrors({ ...WALL, connect: {} }).join()).toContain('pieces is an object');
    const edge = { blockId: 'rail', name: 'Rail', variants: [{ color: '#111111' }], shape: 'half', placement: 'edge' };
    expect(typeErrors({ ...edge, connect: { pieces: { t: { variant: 0 } } } }).join()).toContain('T-joins and crosses');
    expect(typeErrors({ ...edge, connect: { pieces: { end: { variant: 0, rot: 90 } } } }).join()).toContain('0 or 180');
    // Canonical: rot 0 dropped, with sorted, pieces in order; absent stays absent.
    expect(canonicalBlockType({ ...WALL, connect: { with: ['b', 'a'], pieces: { cap: { variant: 1, rot: 0 }, end: { variant: 2 } } } }).connect).toEqual({ with: ['a', 'b'], pieces: { end: { variant: 2 }, cap: { variant: 1 } } });
    expect(canonicalBlockType(GATE).connect).toBeUndefined();
    const errors: ModelErrorV2[] = [];
    composeBlockContent({ blockTypes: [{ ...WALL, connect: { with: ['rail', 'nope'], pieces: { end: { variant: 7 }, cap: { variant: 8 } } } }, edge as BlockType, { ...GATE, footprint: [2, 1, 1], connect: { pieces: {} } }] }, errors);
    expect(errors.map((e) => e.path).sort()).toEqual(['/blockTypes/0/connect/pieces/cap/variant', '/blockTypes/0/connect/with/0', '/blockTypes/0/connect/with/1', '/blockTypes/2/connect']);
  });
});
