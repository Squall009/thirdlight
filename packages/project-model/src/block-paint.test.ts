/**
 * The paint brush (any target) and a block layer's surface
 * paint — weights that always sum to 255, a standalone wetness, the falloffs,
 * vertices shared by chunks painted alike, the stored form (canonical, round
 * trip, validation), the colours a chunk mesh takes, and determinism.
 * Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE, canonicalBlockChunk, validateSceneBlocks, type BlockLayerComponent, type BlockType } from './block-layers';
import { applyBlockEdits, blockEditsShapeError, BlockGrid, type BlockEdit } from './block-grid';
import { BLOCK_PAINT_LAYOUT, PAINT_CHUNK_SIZE, PAINT_VERTICES, chunkPaintColors, chunkPaintError, decodeChunkPaint, encodeChunkPaint, paintOffset, unpaintedChunk } from './block-paint';
import { brushFalloff, paintPoint } from './paint-brush';
import type { ModelErrorV2 } from './errors';

const TYPES: BlockType[] = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' }];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
const LAYER: BlockLayerComponent = { cellSize: [2, 1, 2], bounds: { min: [0, 0, 0], max: [32, 8, 16] } };
const edit = (g: BlockGrid, ...edits: BlockEdit[]): number => {
  const r = applyBlockEdits(g, edits, { types, stamps: new Map() });
  if (!r.ok) throw new Error(`${r.path}: ${r.message}`);
  return r.cells;
};
/** Two chunks side by side (x 0-31), one row of soil. */
const ground = (): BlockGrid => {
  const g = new BlockGrid(LAYER);
  edit(g, { kind: 'fill', box: [0, 0, 0, 32, 1, 16], cell: { block: 'soil' } });
  g.takeDirty();
  return g;
};
const vertex = (g: BlockGrid, cx: number, cz: number, x: number, z: number): number[] => {
  const l = g.chunkPaint(cx, cz);
  const o = paintOffset(cx, cz, x, z)!;
  return l === null ? [255, 0, 0, 0, 0] : [...l.subarray(o, o + 5)];
};

describe('the paint brush (phase 25.21)', () => {
  it('falloffs: smooth (1 − d²/r²)², linear, constant; 0 outside', () => {
    expect(brushFalloff(0, 2, 'smooth')).toBe(1);
    expect(brushFalloff(1, 2, 'smooth')).toBeCloseTo(0.5625, 10);
    expect(brushFalloff(1, 2, 'linear')).toBeCloseTo(0.5, 10);
    expect(brushFalloff(3.9, 2, 'constant')).toBe(1);
    expect(brushFalloff(4.01, 2, 'constant')).toBe(0);
  });

  it('painting a weight channel moves weight onto it, erasing gives it back; the weights always sum to 255', () => {
    const v = new Uint8Array([255, 0, 0, 0, 0]);
    expect(paintPoint(v, 0, BLOCK_PAINT_LAYOUT, { channel: 2 }, 0.5)).toBe(true);
    expect([...v]).toEqual([128, 0, 127, 0, 0]);
    paintPoint(v, 0, BLOCK_PAINT_LAYOUT, { channel: 1 }, 0.3);
    expect(v[0]! + v[1]! + v[2]! + v[3]!).toBe(255);
    paintPoint(v, 0, BLOCK_PAINT_LAYOUT, { channel: 2, erase: true }, 1);
    expect(v[2]).toBe(0);
    expect(v[0]! + v[1]! + v[3]!).toBe(255);
    // Erasing the only weight moves it to the next layer.
    const only = new Uint8Array([255, 0, 0, 0, 0]);
    paintPoint(only, 0, BLOCK_PAINT_LAYOUT, { channel: 0, erase: true }, 1);
    expect([...only]).toEqual([0, 255, 0, 0, 0]);
    // Full strength paints the layer alone.
    const full = new Uint8Array([10, 100, 45, 100, 0]);
    paintPoint(full, 0, BLOCK_PAINT_LAYOUT, { channel: 3 }, 1);
    expect([...full]).toEqual([0, 0, 0, 255, 0]);
  });

  it('a standalone channel (wetness) rises toward 255 and dries toward 0, the weights untouched', () => {
    const v = new Uint8Array([255, 0, 0, 0, 0]);
    paintPoint(v, 0, BLOCK_PAINT_LAYOUT, { channel: 4 }, 0.5);
    expect([...v]).toEqual([255, 0, 0, 0, 128]);
    paintPoint(v, 0, BLOCK_PAINT_LAYOUT, { channel: 4, erase: true }, 0.5);
    expect([...v]).toEqual([255, 0, 0, 0, 64]);
  });
});

describe('block layer paint (phase 25.21)', () => {
  it('the paint lattice is 17 × 17 per chunk (a chunk is 16 columns)', () => {
    expect(PAINT_CHUNK_SIZE).toBe(CHUNK_SIZE);
    expect(PAINT_VERTICES).toBe(CHUNK_SIZE + 1);
  });

  it('a dab paints the vertices in its radius; a vertex on a chunk edge is painted alike in both chunks', () => {
    const g = ground();
    const n = edit(g, { kind: 'paint', at: [16, 8], radius: 3, strength: 1, channel: 1, falloff: 'constant' });
    expect(n).toBe(29); // lattice points within 3 of (16, 8)
    expect(vertex(g, 0, 0, 16, 8)).toEqual([0, 255, 0, 0, 0]);
    expect(vertex(g, 1, 0, 16, 8)).toEqual([0, 255, 0, 0, 0]);
    expect(vertex(g, 0, 0, 14, 8)).toEqual([0, 255, 0, 0, 0]);
    expect(vertex(g, 1, 0, 19, 8)).toEqual([0, 255, 0, 0, 0]);
    expect(vertex(g, 1, 0, 20, 8)).toEqual([255, 0, 0, 0, 0]);
    // Both chunks changed (stored and re-meshed).
    const d = g.takeDirty();
    expect(d.chunks).toEqual(['0,0', '1,0']);
    expect(d.mesh).toEqual(['0,0', '1,0']);
    expect(g.hasPaint()).toBe(true);
  });

  it('stored with the chunk: round trip, canonical (unpainted dropped), validated', () => {
    const g = ground();
    edit(g, { kind: 'paint', at: [4, 4], radius: 2, strength: 0.5, channel: 4 }, { kind: 'paint', at: [5, 4], radius: 2, strength: 0.7, channel: 2 });
    g.takeDirty();
    const data = g.toData('layer', null, g.chunkKeys())!;
    const c0 = data.chunks!.find((c) => c.cx === 0)!;
    const c1 = data.chunks!.find((c) => c.cx === 1)!;
    expect(typeof c0.paint).toBe('string');
    expect(c1.paint).toBeUndefined();
    expect(chunkPaintError(c0.paint)).toBeNull();
    const back = BlockGrid.from(LAYER, data);
    expect(back.chunkPaint(0, 0)).toEqual(g.chunkPaint(0, 0));
    expect(canonicalBlockChunk({ ...c1, paint: encodeChunkPaint(unpaintedChunk()) })!.paint).toBeUndefined();
    // Validation: a malformed paint and weights that do not sum to 255 are refused.
    const errors: ModelErrorV2[] = [];
    const bad = decodeChunkPaint(c0.paint)!;
    bad[0] = 7;
    const entities = [{ id: 'layer', components: { blockLayer: LAYER } }];
    validateSceneBlocks([{ entityId: 'layer', chunks: [{ ...c0, paint: encodeChunkPaint(bad) }] }], entities, errors);
    validateSceneBlocks([{ entityId: 'layer', chunks: [{ ...c0, paint: 'AAAA' }] }], entities, errors);
    expect(errors.map((e) => e.path)).toEqual(['/blocks/0/chunks/0/paint', '/blocks/0/chunks/0/paint']);
  });

  it('only chunks holding cells are painted; a chunk emptied of cells drops its paint', () => {
    const g = new BlockGrid(LAYER);
    edit(g, { kind: 'fill', box: [0, 0, 0, 16, 1, 16], cell: { block: 'soil' } });
    edit(g, { kind: 'paint', at: [16, 8], radius: 4, strength: 1, channel: 3 });
    expect(g.chunkPaint(1, 0)).toBeNull();
    expect(vertex(g, 0, 0, 16, 8)).toEqual([0, 0, 0, 255, 0]);
    edit(g, { kind: 'fill', box: [0, 0, 0, 16, 1, 16], cell: null });
    expect(g.toData('layer', null, g.takeDirty().chunks)).toBeNull();
    expect(g.chunkPaint(0, 0)).toBeNull();
  });

  it('the edit shape: channel 0-4, the brush limits, a metadata-only layer refused', () => {
    expect(blockEditsShapeError([{ kind: 'paint', at: [1, 1], radius: 2, strength: 0.5, channel: 5 }])?.path).toBe('/args/edits/0/channel');
    expect(blockEditsShapeError([{ kind: 'paint', at: [1, 1], radius: 0, strength: 0.5, channel: 0 }])?.path).toBe('/args/edits/0/radius');
    expect(blockEditsShapeError([{ kind: 'paint', at: [1, 1], radius: 2, strength: 1.5, channel: 0 }])?.path).toBe('/args/edits/0/strength');
    expect(blockEditsShapeError([{ kind: 'paint', at: [1, 1], radius: 2, strength: 0.5, channel: 0, falloff: 'bumpy' }])?.path).toBe('/args/edits/0/falloff');
    expect(blockEditsShapeError([{ kind: 'paint', at: [1, 1], radius: 2, strength: 0.5, channel: 0, falloff: 'linear', erase: true }])).toBeNull();
    const meta = new BlockGrid({ ...LAYER, metadataOnly: true });
    expect(applyBlockEdits(meta, [{ kind: 'paint', at: [1, 1], radius: 2, strength: 0.5, channel: 0 }], { types, stamps: new Map() }).ok).toBe(false);
  });

  it('chunk mesh colours: COLOR_0 the weights, COLOR_1.r the wetness, bilinear between vertices (layer metres)', () => {
    const g = ground();
    edit(g, { kind: 'paint', at: [3, 3], radius: 0.5, strength: 1, channel: 2, falloff: 'constant' }, { kind: 'paint', at: [3, 3], radius: 0.5, strength: 1, channel: 4, falloff: 'constant' });
    // Cell size 2 m: vertex (3, 3) is at (6, 6) m; halfway to (4, 3) at (7, 6) m.
    const at = new Float32Array([6, 1, 6, 7, 1, 6, 8, 1, 6]);
    const c = chunkPaintColors(g.chunkPaint(0, 0), 0, 0, LAYER.cellSize, at);
    expect([...c.weights]).toEqual([0, 0, 255, 0, 128, 0, 128, 0, 255, 0, 0, 0]);
    expect([...c.wetness]).toEqual([255, 0, 0, 255, 128, 0, 0, 255, 0, 0, 0, 255]);
    const none = chunkPaintColors(null, 0, 0, LAYER.cellSize, at);
    expect([...none.weights.subarray(0, 4)]).toEqual([255, 0, 0, 0]);
  });

  it('the same dabs give the same bytes', () => {
    const dabs: BlockEdit[] = [];
    for (let i = 0; i < 40; i++) dabs.push({ kind: 'paint', at: [3 + i * 0.37, 2 + ((i * 7) % 11) * 0.9], radius: 2.5, strength: 0.35, channel: i % 5, falloff: i % 3 === 0 ? 'linear' : 'smooth', ...(i % 7 === 0 ? { erase: true } : {}) });
    const a = ground();
    const b = ground();
    edit(a, ...dabs);
    for (const d of dabs) edit(b, d);
    expect(a.toData('l', null, a.takeDirty().chunks)).toEqual(b.toData('l', null, b.takeDirty().chunks));
    for (let i = 0; i < PAINT_VERTICES * PAINT_VERTICES; i++) {
      const o = i * 5;
      const l = a.chunkPaint(0, 0)!;
      expect(l[o]! + l[o + 1]! + l[o + 2]! + l[o + 3]!).toBe(255);
    }
  });
});
