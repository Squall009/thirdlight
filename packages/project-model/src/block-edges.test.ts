/**
 * Edge pieces in the data: the block type rules, chunk storage (JSON and
 * binary forms, the same edges), the `edges` edit, the content's references,
 * and the mesher (drawn on the edge, collision without open doors).
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits, blockEditsShapeError } from './block-grid';
import { canonicalBlockType, composeBlockLayers, validateBlockType, validateSceneBlocks, type BlockLayerComponent, type BlockType } from './block-layers';
import { decodeBlockChunks, encodeBlockChunks } from './block-chunk-binary';
import { BLOCK_EDGE_THICKNESS, edgeFrame, edgeInBox, edgeOfSide } from './block-edges';
import { collisionMeshChunk, meshBlockChunk, shapeSource } from './block-mesh';
import type { ModelErrorV2 } from './errors';

const LAYER: BlockLayerComponent = { cellSize: [2, 1, 2], bounds: { min: [0, 0, 0], max: [32, 8, 32] } };
const WALL: BlockType = { blockId: 'wall', name: 'Wall', variants: [{ color: '#888888' }], shape: 'full', placement: 'edge' };
const DOOR: BlockType = { blockId: 'door', name: 'Door', variants: [{ color: '#884422' }], shape: 'full', placement: 'edge' };
const RAIL: BlockType = { blockId: 'rail', name: 'Rail', variants: [{ color: '#444444' }], shape: 'half', placement: 'edge', blocking: false };
const STONE: BlockType = { blockId: 'stone', name: 'Stone', variants: [{ color: '#666666' }], shape: 'full' };
const TYPES = new Map([WALL, DOOR, RAIL, STONE].map((t) => [t.blockId, t]));
const ctx = { types: TYPES, stamps: new Map() };

function typeErrors(t: unknown): string[] {
  const errors: ModelErrorV2[] = [];
  validateBlockType(t, '', errors);
  return errors.map((e) => `${e.path}: ${e.message}`);
}

const looks = { source: (t: BlockType, _v: number, fm: [number, number, number]) => ({ key: `c:${t.blockId}`, source: shapeSource(t.shape === 'none' ? 'full' : t.shape, fm[0], fm[1], fm[2], t.boxes), uv: 'world' as const }) };

describe('edge pieces', () => {
  it('an edge block type has an edge shape, no footprint or solid flag, and turns end for end only; blocking belongs to edges', () => {
    expect(typeErrors(WALL)).toEqual([]);
    expect(typeErrors(RAIL)).toEqual([]);
    expect(typeErrors({ ...WALL, shape: 'ramp' }).join()).toContain('edge piece');
    expect(typeErrors({ ...WALL, footprint: [2, 1, 1] }).join()).toContain('no footprint');
    expect(typeErrors({ ...WALL, solid: true }).join()).toContain('no solid');
    expect(typeErrors({ ...WALL, rotations: [0, 90] }).join()).toContain('end for end');
    expect(typeErrors({ ...STONE, blocking: false }).join()).toContain('blocking belongs to an edge piece');
    expect(typeErrors({ ...WALL, placement: 'corner' }).join()).toContain('placement is cell or edge');
    // Stored only when they say something.
    expect(canonicalBlockType({ ...STONE, placement: 'cell' })).toEqual(STONE);
    expect(canonicalBlockType({ ...WALL, blocking: true })).toEqual(WALL);
    expect(canonicalBlockType(RAIL).blocking).toBe(false);
  });

  it('the edges edit sets edges by list or on and inside a box, keeps or replaces, and erases', () => {
    const g = new BlockGrid(LAYER);
    // The outline of a 3 × 2 room (one row high) plus the layer's far border edge (x = 32 is in bounds for an x-line edge).
    const r = applyBlockEdits(g, [{ kind: 'edges', box: [4, 0, 4, 7, 1, 6], edge: { block: 'wall' } }, { kind: 'edges', at: [32, 0, 0, 0], edge: { block: 'wall' } }], ctx);
    expect(r).toEqual({ ok: true, cells: 4 * 2 + 3 * 3 + 1 });
    expect(g.edgeCount).toBe(18);
    expect(g.edgeAt(7, 0, 5, 0)).toEqual({ block: 'wall' });
    expect(g.edgeAt(5, 0, 6, 1)).toEqual({ block: 'wall' });
    // keep: only where none stands.
    expect(applyBlockEdits(g, [{ kind: 'edges', at: [7, 0, 5, 0, 8, 0, 5, 0], edge: { block: 'door', open: true }, mode: 'keep' }], ctx)).toEqual({ ok: true, cells: 1 });
    expect(g.edgeAt(7, 0, 5, 0)).toEqual({ block: 'wall' });
    expect(g.edgeAt(8, 0, 5, 0)).toEqual({ block: 'door', open: true });
    // Erase by box.
    expect(applyBlockEdits(g, [{ kind: 'edges', box: [4, 0, 4, 5, 1, 6], edge: null }], ctx)).toMatchObject({ ok: true });
    expect(g.edgeAt(4, 0, 4, 0)).toBeNull();
    expect(g.edgeAt(5, 0, 5, 0)).toBeNull();
    expect(g.edgeAt(6, 0, 5, 0)).toEqual({ block: 'wall' });
    // Out of bounds and shape errors.
    expect(applyBlockEdits(g, [{ kind: 'edges', at: [33, 0, 0, 0], edge: { block: 'wall' } }], ctx)).toMatchObject({ ok: false, path: '/args/edits/0/at' });
    expect(applyBlockEdits(g, [{ kind: 'edges', at: [0, 0, 32, 0], edge: { block: 'wall' } }], ctx)).toMatchObject({ ok: false });
    expect(blockEditsShapeError([{ kind: 'edges', at: [0, 0, 0, 2], edge: { block: 'wall' } }])?.message).toContain('axis');
    expect(blockEditsShapeError([{ kind: 'edges', edge: { block: 'wall' } }])?.message).toContain('at');
    expect(blockEditsShapeError([{ kind: 'edges', at: [0, 0, 0, 0], edge: { block: 'wall', rot: 90 } }])?.message).toContain('rot is 0 or 180');
    expect(blockEditsShapeError([{ kind: 'edges', at: [0, 0, 0, 0], box: [0, 0, 0, 1, 1, 1], edge: null }])).not.toBeNull();
  });

  it('a chunk stores its edges in JSON and binary forms alike; an edge-only chunk is a chunk; replaceChunk follows them', () => {
    const g = new BlockGrid(LAYER);
    g.set(1, 0, 1, { block: 'stone' });
    applyBlockEdits(g, [{ kind: 'edges', at: [1, 0, 1, 0, 2, 0, 1, 1, 20, 3, 20, 0], edge: { block: 'wall' } }, { kind: 'edges', at: [1, 1, 1, 0], edge: { block: 'door', rot: 180, open: true } }], ctx);
    expect(g.chunkKeys()).toEqual(['0,0', '1,1']);
    const a = g.encodeChunk('0,0')!;
    const b = g.encodeChunk('1,1')!;
    expect(a.edgePalette).toEqual([{ block: 'wall' }, { block: 'door', rot: 180, open: true }]);
    expect(a.edges).toEqual([[1, 1, 0, 0, 0], [2, 1, 0, 1, 0], [1, 1, 1, 0, 1]]);
    expect(b).toMatchObject({ cx: 1, cz: 1, palette: [], columns: [], edgePalette: [{ block: 'wall' }], edges: [[4, 4, 3, 0, 0]] });
    // The scene rules take them (bounds, structure) and the content's (types).
    const entities = [{ id: 'layer', components: { blockLayer: LAYER } }];
    const errors: ModelErrorV2[] = [];
    validateSceneBlocks([{ entityId: 'layer', chunks: [a, b] }], entities, errors);
    composeBlockLayers([{ entityId: 'layer', chunks: [a, b] }], entities, { blockTypes: [...TYPES.values()] }, errors);
    expect(errors).toEqual([]);
    // Binary: the same chunks back, key for key (key order included).
    const back = decodeBlockChunks(encodeBlockChunks([a, b]));
    expect(JSON.stringify(back)).toBe(JSON.stringify([a, b]));
    // Without edges the payload is the layout it always was (existing files keep their bytes).
    const plain = new BlockGrid(LAYER);
    plain.set(1, 0, 1, { block: 'stone' });
    expect(encodeBlockChunks([plain.encodeChunk('0,0')!])[0]).toBe(1);
    expect(encodeBlockChunks([a])[0]).toBe(2);
    // A copy following the chunks (the renderer's, a worker's) gets the same edges, and loses them again.
    const copy = BlockGrid.from(LAYER, { entityId: 'layer', chunks: [a] });
    expect(copy.edgeAt(1, 1, 1, 0)).toEqual({ block: 'door', rot: 180, open: true });
    copy.replaceChunk(1, 1, b);
    expect(copy.edgeAt(20, 3, 20, 0)).toEqual({ block: 'wall' });
    copy.replaceChunk(0, 0, null);
    expect(copy.edgeAt(1, 0, 1, 0)).toBeNull();
    expect(copy.edgeCount).toBe(1);
    expect(copy.memory()).toMatchObject({ cells: 0, edges: 1 });
  });

  it('scene and content rules refuse edges out of bounds, cells naming edge pieces and edges naming cell blocks', () => {
    const entities = [{ id: 'layer', components: { blockLayer: LAYER } }];
    const check = (chunk: unknown): string[] => {
      const errors: ModelErrorV2[] = [];
      validateSceneBlocks([{ entityId: 'layer', chunks: [chunk] }], entities, errors);
      if (errors.length === 0) composeBlockLayers([{ entityId: 'layer', chunks: [chunk as never] }], entities, { blockTypes: [...TYPES.values()] }, errors);
      return errors.map((e) => e.message);
    };
    expect(check({ cx: 0, cz: 0, palette: [], columns: [], edgePalette: [{ block: 'wall' }], edges: [[0, 0, 8, 0, 0]] }).join()).toContain('outside');
    expect(check({ cx: 0, cz: 0, palette: [], columns: [], edgePalette: [{ block: 'wall' }], edges: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] }).join()).toContain('twice');
    expect(check({ cx: 0, cz: 0, palette: [], columns: [], edgePalette: [{ block: 'stone' }], edges: [[0, 0, 0, 0, 0]] }).join()).toContain('fills cells');
    expect(check({ cx: 0, cz: 0, palette: [{ block: 'wall' }], columns: [[0, 0, 0, 1, 0]] }).join()).toContain('edge piece');
    expect(check({ cx: 0, cz: 0, palette: [], columns: [], edgePalette: [{ block: 'wall', rot: 90 }], edges: [[0, 0, 0, 0, 0]] }).join()).toContain('0 or 180');
  });

  it('an edge piece is drawn on its edge, facing across it; an open one keeps its look but loses its collider', () => {
    const g = new BlockGrid(LAYER);
    applyBlockEdits(g, [{ kind: 'edges', at: [3, 2, 1, 0], edge: { block: 'wall' } }, { kind: 'edges', at: [5, 0, 6, 1], edge: { block: 'door' } }], ctx);
    const parts = meshBlockChunk(g, 0, 0, TYPES, looks);
    const wall = parts.find((p) => p.blockId === 'wall')!;
    const extent = (p: { positions: Float32Array }, axis: number): [number, number] => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = axis; i < p.positions.length; i += 3) {
        lo = Math.min(lo, p.positions[i]!);
        hi = Math.max(hi, p.positions[i]!);
      }
      return [lo, hi];
    };
    // An x-line wall at x = 3 cells (6 m): thin across x, a cell along z (2-4 m), row 2 (2-3 m).
    const t = 2 * BLOCK_EDGE_THICKNESS;
    expect(extent(wall, 0)[0]).toBeCloseTo(6 - t / 2, 5);
    expect(extent(wall, 0)[1]).toBeCloseTo(6 + t / 2, 5);
    expect(extent(wall, 1)).toEqual([2, 3]);
    expect(extent(wall, 2)).toEqual([2, 4]);
    // A z-line door at z = 6 cells runs along x over cell 5 (10-12 m).
    const door = parts.find((p) => p.blockId === 'door')!;
    expect(extent(door, 0)).toEqual([10, 12]);
    expect(extent(door, 2)[0]).toBeCloseTo(12 - t / 2, 5);
    expect(edgeFrame([2, 1, 2], 3, 2, 1, 0, 180).rot).toBe(270);
    expect(edgeOfSide(4, 0, 4, '+x')).toEqual([5, 0, 4, 0]);
    // Collision: both closed, then the door opened.
    const tris = (): number => collisionMeshChunk(g, 0, 0, TYPES).reduce((n, p) => n + p.indices.length / 3, 0);
    expect(tris()).toBe(24);
    applyBlockEdits(g, [{ kind: 'edges', at: [5, 0, 6, 1], edge: { block: 'door', open: true } }], ctx);
    expect(tris()).toBe(12);
    expect(meshBlockChunk(g, 0, 0, TYPES, looks).find((p) => p.blockId === 'door')).toBeDefined();
  });

  it('copy, move, turn, mirror, stamp and array edits carry the edges with the cells, each between the same two cells and facing the same one', () => {
    // A 3 × 2 room of numbered cells, walled on every edge, one inner edge a door facing −x (rot 180).
    const make = (): BlockGrid => {
      const g = new BlockGrid(LAYER);
      for (let x = 2; x < 5; x++) for (let z = 2; z < 4; z++) g.set(x, 0, z, { block: 'stone', meta: { n: (x - 2) * 10 + (z - 2) } });
      applyBlockEdits(g, [{ kind: 'edges', box: [2, 0, 2, 5, 1, 4], edge: { block: 'wall' } }, { kind: 'edges', at: [3, 0, 2, 0], edge: { block: 'door', rot: 180 } }], ctx);
      g.takeDirty();
      return g;
    };
    /** Each edge as the cells it separates: [the cell it faces, the cell behind it] by number (null: no cell), and its block. */
    const sides = (g: BlockGrid, box: number[]): string[] => {
      const n = (x: number, z: number): number | null => (g.get(x, 0, z)?.meta?.['n'] as number | undefined) ?? null;
      const out: string[] = [];
      g.forEachEdge((x, y, z, axis, idx) => {
        if (!edgeInBox(box, x, y, z, axis)) return;
        const e = g.edgeValueOf(idx);
        const [plus, minus] = axis === 0 ? [n(x, z), n(x - 1, z)] : [n(x, z), n(x, z - 1)];
        out.push(`${e.block}:${e.rot === 180 ? minus : plus}|${e.rot === 180 ? plus : minus}`);
      });
      return out.sort();
    };
    const before = sides(make(), [2, 0, 2, 5, 1, 4]);
    // Every edge on or inside the box: 4 × 2 x-line and 3 × 3 z-line edges.
    expect(before).toHaveLength(17);
    for (const rot of [0, 90, 180, 270] as const) {
      for (const mirror of [undefined, 'x', 'z'] as const) {
        const g = make();
        const r = applyBlockEdits(g, [{ kind: 'copy', box: [2, 0, 2, 5, 1, 4], to: [10, 0, 10], rot, ...(mirror !== undefined ? { mirror } : {}), move: true }], ctx);
        expect(r.ok).toBe(true);
        expect(g.edgeCount, `rot ${rot} mirror ${mirror}`).toBe(17);
        expect(sides(g, [10, 0, 10, 14, 1, 14]), `rot ${rot} mirror ${mirror}`).toEqual(before);
      }
    }
    // A turned copy of a piece that may face one way only keeps facing it.
    const oneWay = new Map([...TYPES, ['door', { ...DOOR, rotations: [180] }]]);
    const g1 = make();
    applyBlockEdits(g1, [{ kind: 'copy', box: [3, 0, 2, 4, 1, 3], to: [20, 0, 20], mirror: 'x' }], { types: oneWay, stamps: new Map() });
    expect(g1.edgeAt(21, 0, 20, 0)).toEqual({ block: 'door', rot: 180 });
    // A stamp and an array (a paste into another layer) carry their edges the same way.
    const g2 = new BlockGrid(LAYER);
    const stamp = { stampId: 'room', name: 'Room', size: [3, 1, 2] as [number, number, number], palette: [{ block: 'stone' }], columns: [[0, 0, 0, 1, 0]], edgePalette: [{ block: 'wall' }], edges: [[3, 0, 0, 0, 0], [0, 2, 0, 1, 0]] };
    expect(applyBlockEdits(g2, [{ kind: 'stamp', stampId: 'room', at: [6, 0, 6], rot: 90 }, { kind: 'array', origin: [20, 0, 20], size: [2, 1, 2], palette: [{ block: 'stone' }], data: [4, 0], edgePalette: [{ block: 'door', rot: 180 }], edges: [[2, 1, 0, 0, 0]] }], { types: TYPES, stamps: new Map([['room', stamp]]) })).toEqual({ ok: true, cells: 1 + 2 + 4 + 1 });
    // Turned a quarter (x' = z, z' = 3 - x): the stamp's x = 3 line edge (facing +x) runs along x at z = 6, facing −z;
    // its z = 2 line edge over x 0-1 stands on the x = 8 line; the stamp's cell (0, 0) lands at (6, 8).
    expect(g2.edgeAt(6, 0, 6, 1)).toEqual({ block: 'wall', rot: 180 });
    expect(g2.edgeAt(8, 0, 8, 0)).toEqual({ block: 'wall' });
    expect(g2.get(6, 0, 8)).toEqual({ block: 'stone', rot: 90 });
    expect(g2.edgeAt(22, 0, 21, 0)).toEqual({ block: 'door', rot: 180 });
    // The edits' shape: edge rows lie within the array (its outline included).
    expect(blockEditsShapeError([{ kind: 'array', origin: [0, 0, 0], size: [2, 1, 2], palette: [null], data: [4, -1], edgePalette: [{ block: 'wall' }], edges: [[3, 0, 0, 0, 0]] }])?.message).toContain('within the pattern');
  });
});
