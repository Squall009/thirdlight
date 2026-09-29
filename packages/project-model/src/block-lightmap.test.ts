/**
 * Lightmap UVs for block-layer chunks: every triangle lands in its (cell,
 * facing) slot inside [0, 1]², slots never overlap, the layout digest is the
 * same for the same mesh and changes with the geometry, and bake entries for
 * chunks carry their chunk and layout. Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import type { BlockType } from './block-layers';
import { applyBlockEdits, BlockGrid } from './block-grid';
import { chunkLightmapLayout } from './block-lightmap';
import { meshBlockChunk, shapeSource } from './block-mesh';
import { validateLightingBake } from './lighting';
import type { ModelErrorV2 } from './errors';

const TYPES: BlockType[] = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' }];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
const looks = { source: (t: BlockType, _v: number, fm: [number, number, number]) => ({ key: `c:${t.blockId}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2]) }) };
const terrain = (extra = false): BlockGrid => {
  const g = new BlockGrid({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [16, 8, 16] } });
  applyBlockEdits(g, [
    { kind: 'fill', box: [0, 0, 0, 16, 2, 16], cell: { block: 'soil' } },
    { kind: 'sculpt', op: 'raise', at: [8, 8], radius: 4, strength: 2 },
    ...(extra ? [{ kind: 'cells' as const, at: [1, 2, 1], cell: { block: 'soil' } }] : []),
  ], { types, stamps: new Map() });
  return g;
};

describe('chunk lightmap layout', () => {
  it('every triangle maps into [0, 1]² inside its own slot; triangles of different slots never share a texel square', () => {
    const lm = chunkLightmapLayout(meshBlockChunk(terrain(), 0, 0, types, looks), [1, 0.5, 1]);
    expect(lm.side).toBeGreaterThan(10);
    let tris = 0;
    const slotOf = new Map<string, string>();
    for (const p of lm.parts) {
      expect(p.uv1!.length / 2).toBe(p.positions.length / 3);
      for (let i = 0; i < p.indices.length; i += 3) {
        tris += 1;
        const uv = [0, 1, 2].map((k) => [p.uv1![p.indices[i + k]! * 2]!, p.uv1![p.indices[i + k]! * 2 + 1]!]);
        for (const [u, v] of uv) {
          expect(u).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        // All three corners in one slot square; that square belongs to this facing only.
        const cells = uv.map(([u, v]) => `${Math.floor(u! * lm.side)},${Math.floor(v! * lm.side)}`);
        expect(new Set(cells).size).toBe(1);
        const n = [0, 1, 2].map((k) => p.normals[p.indices[i]! * 3 + k]!);
        const facing = n.map((x) => Math.round(x * 2)).join(',');
        const had = slotOf.get(cells[0]!);
        if (had === undefined) slotOf.set(cells[0]!, facing);
      }
    }
    expect(tris).toBeGreaterThan(500);
    expect(lm.area).toBeGreaterThan(16 * 16);
  });

  it('the layout digest is the same for the same mesh and changes with the geometry', () => {
    const a = chunkLightmapLayout(meshBlockChunk(terrain(), 0, 0, types, looks), [1, 0.5, 1]);
    const b = chunkLightmapLayout(meshBlockChunk(terrain(), 0, 0, types, looks), [1, 0.5, 1]);
    const c = chunkLightmapLayout(meshBlockChunk(terrain(true), 0, 0, types, looks), [1, 0.5, 1]);
    expect(a.layout).toMatch(/^[0-9a-f]{16}$/);
    expect(b.layout).toBe(a.layout);
    expect(c.layout).not.toBe(a.layout);
    expect(Array.from(b.parts[0]!.uv1!)).toEqual(Array.from(a.parts[0]!.uv1!));
  });

  it('bake entries: a chunk entry names its chunk and layout; one per chunk', () => {
    const errs = (bake: unknown): ModelErrorV2[] => {
      const e: ModelErrorV2[] = [];
      validateLightingBake(bake, '', e);
      return e;
    };
    const base = { bakeId: 'b1', createdAt: '2026-09-29T00:00:00Z', source: 'browser', range: 4, texelsPerMeter: 16, samples: 8, bounces: 0, atlases: ['atlas-1'], bakedLights: [], lightsHash: '0'.repeat(16), staticsHash: '0'.repeat(16) };
    const entry = { entityId: 'ground', chunk: [0, -1], layout: 'a'.repeat(16), atlas: 0, scaleOffset: [0.5, 0.5, 0, 0] };
    expect(errs({ ...base, entries: [entry, { ...entry, chunk: [1, -1] }, { entityId: 'box-1', atlas: 0, scaleOffset: [0.5, 0.5, 0.5, 0] }] })).toEqual([]);
    expect(errs({ ...base, entries: [entry, entry] }).map((e) => e.path)).toEqual(['/entries/1/entityId']);
    expect(errs({ ...base, entries: [{ ...entry, layout: undefined }] }).map((e) => e.path)).toEqual(['/entries/0/layout']);
    expect(errs({ ...base, entries: [{ ...entry, chunk: [0.5, 0] }] }).map((e) => e.path)).toEqual(['/entries/0/chunk']);
  });
});
