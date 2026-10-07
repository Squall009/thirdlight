/**
 * Wall paint: a dab on a wall paints the exposed wall points within its
 * radius (none buried in the ground), the points' stored form in both chunk
 * forms (JSON chunk and binary, round trip; a layer without wall paint keeps
 * its bytes), validation, and what a chunk mesh draws — a layer without
 * `wallPaint` exactly as before, with it walls cut at the points, unpainted
 * walls on the second layer, the top's paint over the lip fading one step
 * down, moss up a painted face; paint kept through a height edit.
 * Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import { canonicalBlockChunk, validateSceneBlocks, type BlockLayerComponent, type BlockType } from './block-layers';
import { applyBlockEdits, blockEditsShapeError, BlockGrid, type BlockEdit } from './block-grid';
import { decodeBlockChunks, encodeBlockChunks } from './block-chunk-binary';
import { blockTopOptions, meshBlockChunk, shapeSource, type BlockLookResolver, type ChunkMeshPart } from './block-mesh';
import { chunkPaintColors } from './block-paint';
import { chunkMeshPaint } from './block-paint-mesh';
import { UNPAINTED_WALL, decodeWallPaint, encodeWallPaint, wallPaintError, wallPaintSteps, wallPointKey, wallPointOfKey } from './block-wall-paint';
import type { ModelErrorV2 } from './errors';

const TYPES: BlockType[] = [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' }];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
/** Half-metre rows, as a level kit's: points every 0.5 m across (2 per cell) and every row up. */
const LAYER: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 16, 32] }, wallPaint: true };
const edit = (g: BlockGrid, ...edits: BlockEdit[]): number => {
  const r = applyBlockEdits(g, edits, { types, stamps: new Map() });
  if (!r.ok) throw new Error(`${r.path}: ${r.message}`);
  return r.cells;
};
/** Ground 2 rows deep over x 0-31, z 0-15, and a block 4 rows higher on x 4-7, z 4-7 (walls 2 m high). */
const ground = (layer: BlockLayerComponent = LAYER): BlockGrid => {
  const g = new BlockGrid(layer);
  edit(g, { kind: 'fill', box: [0, 0, 0, 32, 2, 16], cell: { block: 'stone' } }, { kind: 'fill', box: [4, 2, 4, 8, 6, 8], cell: { block: 'stone' } });
  g.takeDirty();
  return g;
};
const moss = (at: [number, number, number], radius = 1.5): BlockEdit => ({ kind: 'paint', at: [at[0], at[2]], y: at[1], target: 'walls', radius, strength: 1, falloff: 'constant', channel: 2 });
const resolver: BlockLookResolver = { source: (t, v, fm) => ({ key: `c:${t.blockId}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2]), uv: 'world' }) };
const mesh = (g: BlockGrid, layer: BlockLayerComponent): ChunkMeshPart[] => meshBlockChunk(g, 0, 0, types, resolver, blockTopOptions(layer));
/** The weights and wetness at the vertex at (x, y, z) facing `n` (metres), from a chunk mesh. */
function colourAt(g: BlockGrid, layer: BlockLayerComponent, at: [number, number, number], n: [number, number, number]): number[] | null {
  for (const part of mesh(g, layer)) {
    const c = chunkMeshPaint(g, types, 0, 0, { wallPaint: layer.wallPaint === true, topSubdivision: 1 }, part);
    for (let i = 0; i < part.positions.length / 3; i++) {
      const same = (a: Float32Array, o: number, v: readonly number[]): boolean => Math.abs(a[o]! - v[0]!) < 1e-4 && Math.abs(a[o + 1]! - v[1]!) < 1e-4 && Math.abs(a[o + 2]! - v[2]!) < 1e-4;
      if (same(part.positions, i * 3, at) && same(part.normals, i * 3, n)) return [...c.weights.subarray(i * 4, i * 4 + 4), c.wetness[i * 4]!];
    }
  }
  return null;
}

describe('wall paint', () => {
  it('points every ~0.5 m: steps per cell across and per row from the cell size', () => {
    expect(wallPaintSteps([1, 0.5, 1])).toEqual({ along: 2, up: 1 });
    expect(wallPaintSteps([1, 1, 1])).toEqual({ along: 2, up: 2 });
    expect(wallPaintSteps([0.25, 0.25, 0.25])).toEqual({ along: 1, up: 1 });
    expect(wallPaintSteps([64, 64, 64])).toEqual({ along: 16, up: 16 });
    const key = wallPointKey(15, 3, 2, 16, -40);
    expect(wallPointOfKey(key)).toEqual([15, 3, 2, 16, -40]);
  });

  it('a dab paints the exposed wall points around it (none buried, none on a top), weights summing to 255; erasing goes back to unpainted', () => {
    const g = ground();
    // On the block's −x wall (plane x = 4), 1 m up it (rows: the ground's top is row 2 = 1 m).
    const n = edit(g, moss([4, 4, 6]));
    expect(n).toBeGreaterThan(0);
    const points = g.chunkWallPaint(0, 0)!;
    for (const [key, v] of points) {
      const [lx, lz, side, , k] = wallPointOfKey(key);
      expect(v[0]! + v[1]! + v[2]! + v[3]!).toBe(255);
      expect(v[2]).toBe(255);
      // Only the block's walls show between rows 2 and 6 (heights 1-3 m); the ground's sides are far from the dab.
      expect(k).toBeGreaterThanOrEqual(2);
      expect(k).toBeLessThanOrEqual(6);
      expect([lx, lz, side].join()).toMatch(/^4,\d+,1$|^\d+,(4|7),(2|3)$|^(3|4),\d+,0$/);
    }
    // The −x side of column 4 (plane x = 4): points at z 5-7 (j across), rows 3-5.
    expect(points.get(wallPointKey(4, 6, 1, 0, 4))).toEqual(Uint8Array.from([0, 0, 255, 0, 0]));
    // Column 3's +x side is buried below row 2 (column 3 is ground there): nothing stored for it.
    for (const key of points.keys()) expect(wallPointOfKey(key)[2] === 0 && wallPointOfKey(key)[0] === 3).toBe(false);
    expect(g.takeDirty().mesh).toEqual(['0,0']);
    edit(g, { ...moss([4, 4, 6], 3), erase: true } as BlockEdit);
    // Erasing the moss gives its weight back to the rock: the points are unpainted again and not stored.
    expect(g.chunkWallPaint(0, 0)!.size).toBe(0);
    expect(g.encodeChunk('0,0')!.wallPaint).toBeUndefined();
  });

  it('stored with the chunk: JSON and binary chunk forms round-trip it; a layer without it keeps its bytes', () => {
    const g = ground();
    edit(g, moss([4, 4, 6]), { kind: 'paint', at: [5, 5], radius: 2, strength: 0.5, channel: 4 });
    const c = canonicalBlockChunk(g.encodeChunk('0,0')!)!;
    expect(typeof c.wallPaint).toBe('string');
    expect(Object.keys(c)).toEqual(['cx', 'cz', 'palette', 'columns', 'paint', 'wallPaint']);
    // JSON (a chunk file is this object as text).
    const json = JSON.parse(JSON.stringify(c));
    expect(canonicalBlockChunk(json)).toEqual(c);
    const back = BlockGrid.from(LAYER, { entityId: 'l', chunks: [json] });
    expect(back.encodeChunk('0,0')).toEqual(c);
    // Binary (layout 3 when a chunk has wall paint).
    const raw = encodeBlockChunks([c, canonicalBlockChunk(g.encodeChunk('1,0')!)!]);
    expect(raw[0]).toBe(3);
    expect(decodeBlockChunks(raw)).toEqual([c, canonicalBlockChunk(g.encodeChunk('1,0')!)!]);
    // Without wall paint the payload is written as before (layout 1).
    const plain = { ...c };
    delete plain.wallPaint;
    expect(encodeBlockChunks([plain])[0]).toBe(1);
    expect(decodeBlockChunks(encodeBlockChunks([plain]))).toEqual([plain]);
  });

  it('validation: a stored wall paint is sorted 9-byte points whose weights sum to 255', () => {
    const one = new Map([[wallPointKey(1, 2, 0, 1, 3), Uint8Array.from([0, 100, 155, 0, 9])]]);
    const s = encodeWallPaint(one)!;
    expect(wallPaintError(s)).toBeNull();
    expect(decodeWallPaint(s)).toEqual(one);
    expect(encodeWallPaint(new Map([[1, Uint8Array.from(UNPAINTED_WALL)]]))).toBeUndefined();
    expect(wallPaintError('AAAA')).toMatch(/9-byte points/);
    const bad = Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
    bad[5] = 1;
    expect(wallPaintError(btoa(String.fromCharCode(...bad)))).toMatch(/sum to 255/);
    const twice = Uint8Array.from([...bad.slice(0, 4), 0, 100, 155, 0, 9, ...bad.slice(0, 4), 0, 100, 155, 0, 9]);
    expect(wallPaintError(btoa(String.fromCharCode(...twice)))).toMatch(/sorted/);
    const errors: ModelErrorV2[] = [];
    validateSceneBlocks([{ entityId: 'l', chunks: [{ cx: 0, cz: 0, palette: [{ block: 'stone' }], columns: [[0, 0, 0, 1, 0]], wallPaint: 'AAAA' }] }], [{ id: 'l', components: { blockLayer: LAYER } }], errors);
    expect(errors.map((e) => e.path)).toContain('/blocks/0/chunks/0/wallPaint');
    // The dab: walls need the brush's height; a tops dab takes none.
    expect(blockEditsShapeError([{ kind: 'paint', at: [1, 1], radius: 1, strength: 1, channel: 0, target: 'walls' }])?.path).toMatch(/\/y$/);
    expect(blockEditsShapeError([{ kind: 'paint', at: [1, 1], radius: 1, strength: 1, channel: 0, y: 2 }])?.path).toMatch(/\/y$/);
    expect(blockEditsShapeError([{ kind: 'paint', at: [1, 1], radius: 1, strength: 1, channel: 0, target: 'sides' } as never])?.path).toMatch(/\/target$/);
  });

  it('a layer without wall paint meshes and colours exactly as before (walls show the top paint above them)', () => {
    const off: BlockLayerComponent = { ...LAYER, wallPaint: undefined };
    const g = ground(off);
    edit(g, { kind: 'paint', at: [4, 6], radius: 2, strength: 1, channel: 3 }, moss([4, 4, 6]));
    expect(blockTopOptions(off)).toEqual({});
    for (const part of mesh(g, off)) {
      expect(chunkMeshPaint(g, types, 0, 0, { wallPaint: false, topSubdivision: 1 }, part)).toEqual(chunkPaintColors(g.chunkPaint(0, 0), 0, 0, g.cellSize, part.positions));
    }
    // The block's −x wall at mid-height takes the lattice (layer 4 painted at the top there).
    expect(colourAt(g, off, [4, 2, 6], [-1, 0, 0])![3]).toBeGreaterThan(200);
  });

  it('with wall paint: walls cut at the points, unpainted walls on layer 2, the top over the lip fading one step down, moss up a painted face', () => {
    const g = ground();
    const plainParts = mesh(g, { ...LAYER, wallPaint: undefined });
    const cutParts = mesh(g, LAYER);
    const verts = (ps: ChunkMeshPart[]): number => ps.reduce((s, p) => s + p.positions.length / 3, 0);
    // A 1 × 0.5 m wall face becomes two 0.5 m pieces (6 vertices instead of 4); tops are not cut.
    expect(verts(cutParts)).toBeGreaterThan(verts(plainParts));
    expect(colourAt(g, LAYER, [4, 2, 6.5], [-1, 0, 0])).not.toBeNull();
    // Unpainted: the wall's own default (layer 2), the top's lip (layer 1) over its top row, gone one step down.
    expect(colourAt(g, LAYER, [4, 2, 6], [-1, 0, 0])).toEqual([0, 255, 0, 0, 0]);
    expect(colourAt(g, LAYER, [4, 3, 6], [-1, 0, 0])).toEqual([255, 0, 0, 0, 0]);
    expect(colourAt(g, LAYER, [4, 2.5, 6], [-1, 0, 0])).toEqual([0, 255, 0, 0, 0]);
    expect(colourAt(g, LAYER, [5, 3, 6], [0, 1, 0])).toEqual([255, 0, 0, 0, 0]);
    // Moss up the face: the painted points show between the corners (0.5 m across) and the paint survives a height edit.
    edit(g, moss([4, 3.5, 6.5], 1));
    expect(colourAt(g, LAYER, [4, 1.5, 6.5], [-1, 0, 0])).toEqual([0, 0, 255, 0, 0]);
    expect(colourAt(g, LAYER, [4, 3, 6.5], [-1, 0, 0])).toEqual([255, 0, 0, 0, 0]);
    edit(g, { kind: 'fill', box: [4, 6, 4, 8, 8, 8], cell: { block: 'stone' } });
    // The block is a metre taller: the moss stays where it was painted, the lip moved up with the top.
    expect(colourAt(g, LAYER, [4, 1.5, 6.5], [-1, 0, 0])).toEqual([0, 0, 255, 0, 0]);
    expect(colourAt(g, LAYER, [4, 3, 6.5], [-1, 0, 0])).toEqual([0, 255, 0, 0, 0]);
    expect(colourAt(g, LAYER, [4, 4, 6.5], [-1, 0, 0])).toEqual([255, 0, 0, 0, 0]);
  });
});
