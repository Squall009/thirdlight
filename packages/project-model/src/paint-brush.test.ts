/**
 * The brush's stroke options: the curve falloff and its half-strength ring,
 * the opacity a stroke never paints past (however many dabs cross a point),
 * the noise mask (in range, deterministic, anchored to the target, 3D noise
 * equal to 2D at y = 0), their validation — and that a preview painting dab
 * by dab with one stroke's coverage gives the bytes of the command that
 * holds all the dabs, for a block layer's tops and walls and for vertex
 * paint. Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import { applyBlockEdits, BlockGrid, type BlockEdit } from './block-grid';
import type { BlockLayerComponent, BlockType } from './block-layers';
import { BRUSH_HARDNESS_DEFAULT, StrokeCoverage, brushFalloff, brushHalfRadius, brushMask, brushStrokeError, paintPoint, strokeCoverage, type BrushMask, type PaintLayout } from './paint-brush';
import { fractalNoise01, valueNoise01 } from './value-noise';
import { paintVertexDabs, type PaintVec3 } from './vertex-paint-stroke';

const MASK: BrushMask = { scale: 3, contrast: 1.6, threshold: 0.45, octaves: 4, seed: 1207 };

describe('stroke options', () => {
  it('curve: full strength out to the hardness, then the smooth falloff; the half-strength ring of each falloff', () => {
    expect(brushFalloff(0.25, 1, 'curve', 0.5)).toBe(1);
    expect(brushFalloff(0.81, 1, 'curve', 0.5)).toBeCloseTo((1 - 0.64) ** 2, 12);
    expect(brushFalloff(1.01, 1, 'curve', 0.5)).toBe(0);
    expect(brushFalloff(0.25, 1, 'curve')).toBe(brushFalloff(0.25, 1, 'curve', BRUSH_HARDNESS_DEFAULT));
    for (const f of ['smooth', 'linear', 'curve'] as const) {
      const h = brushHalfRadius(f, 0.3);
      expect(brushFalloff(h * h, 1, f, 0.3), f).toBeCloseTo(0.5, 9);
    }
    expect(brushHalfRadius('constant')).toBe(1);
  });

  it('opacity: a stroke takes a point at most that far toward the target, however many dabs cross it', () => {
    const layout: PaintLayout = { channels: 1, weights: 0 };
    for (const [opacity, strength] of [[0.5, 0.8], [0.3, 0.1], [0.75, 1]] as const) {
      const v = new Uint8Array([0]);
      const c = new StrokeCoverage(opacity);
      for (let i = 0; i < 40; i++) paintPoint(v, 0, layout, { channel: 0 }, c.take(7, strength));
      expect(Math.abs(v[0]! - 255 * opacity), `opacity ${opacity}, strength ${strength}`).toBeLessThanOrEqual(1);
    }
    // From a painted start: the ceiling is a share of the way left (a second stroke goes further).
    const v = new Uint8Array([128]);
    const c = new StrokeCoverage(0.5);
    for (let i = 0; i < 20; i++) paintPoint(v, 0, layout, { channel: 0 }, c.take(1, 0.6));
    expect(Math.abs(v[0]! - (128 + 127 * 0.5))).toBeLessThanOrEqual(1);
    // No ceiling: no coverage kept, every dab blends in full.
    expect(strokeCoverage(undefined)).toBeNull();
    expect(strokeCoverage(1)).toBeNull();
  });

  it('mask: 0-1, the same at the same place every time, different with another seed, anchored to the place not the brush', () => {
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 2000; i++) {
      const x = (i * 7.31) % 97;
      const z = (i * 3.17) % 89;
      const m = brushMask(MASK, x, z);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
      expect(brushMask(MASK, x, z)).toBe(m);
      lo = Math.min(lo, m);
      hi = Math.max(hi, m);
    }
    // It breaks paint up: both held back and painted somewhere.
    expect(lo).toBe(0);
    expect(hi).toBe(1);
    let differs = 0;
    for (let i = 0; i < 200; i++) if (brushMask(MASK, i * 0.7, i * 1.3) !== brushMask({ ...MASK, seed: 1208 }, i * 0.7, i * 1.3)) differs++;
    expect(differs).toBeGreaterThan(150);
    // 3D noise is the 2D noise at y = 0 (a wall's mask meets the ground's), and smooth in y.
    for (let i = 0; i < 50; i++) {
      expect(valueNoise01(i * 0.37, i * 0.61, 5, 0)).toBe(valueNoise01(i * 0.37, i * 0.61, 5));
      expect(Math.abs(valueNoise01(i * 0.37, i * 0.61, 5, 1e-6) - valueNoise01(i * 0.37, i * 0.61, 5))).toBeLessThan(1e-4);
    }
    expect(fractalNoise01(1.5, 2.5, 1, 9)).toBe(valueNoise01(1.5, 2.5, 9));
  });

  it('validates opacity, hardness and the mask; absent fields are fine', () => {
    expect(brushStrokeError({})).toBeNull();
    expect(brushStrokeError({ opacity: 0.4, hardness: 0.2, mask: MASK })).toBeNull();
    expect(brushStrokeError({ opacity: 0 })?.field).toBe('opacity');
    expect(brushStrokeError({ opacity: 1.2 })?.field).toBe('opacity');
    expect(brushStrokeError({ hardness: 1 })?.field).toBe('hardness');
    expect(brushStrokeError({ mask: { ...MASK, octaves: 6 } })?.field).toBe('mask/octaves');
    expect(brushStrokeError({ mask: { ...MASK, scale: 0 } })?.field).toBe('mask/scale');
    expect(brushStrokeError({ mask: { ...MASK, seed: 1.5 } })?.field).toBe('mask/seed');
    expect(brushStrokeError({ mask: { ...MASK, extra: 1 } })?.field).toBe('mask/extra');
  });
});

const TYPES: BlockType[] = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' }];
const ctx = { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() };
const LAYER: BlockLayerComponent = { cellSize: [2, 1, 2], bounds: { min: [0, 0, 0], max: [32, 8, 16] }, wallPaint: true };

/** Two chunks of soil, two rows high, a step up in the middle (walls to paint). */
function ground(): BlockGrid {
  const g = new BlockGrid(LAYER);
  const r = applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 32, 1, 16], cell: { block: 'soil' } }, { kind: 'fill', box: [10, 1, 0, 22, 2, 16], cell: { block: 'soil' } }], ctx);
  if (!r.ok) throw new Error(r.message);
  g.takeDirty();
  return g;
}

/** Every chunk's stored form (paint and wall paint included). */
const bytes = (g: BlockGrid): string => JSON.stringify(g.chunkKeys().sort().map((k) => g.encodeChunk(k)));

describe('preview and command paint the same bytes', () => {
  const dabs: BlockEdit[] = [];
  for (let i = 0; i < 14; i++) dabs.push({ kind: 'paint', at: [8 + i * 1.1, 7 + (i % 3) * 0.4], radius: 3.5, strength: 0.6, channel: 2, opacity: 0.55, mask: MASK, falloff: 'curve', hardness: 0.3 });
  const walls: BlockEdit[] = dabs.map((d) => ({ ...d, target: 'both', y: 1.4 }) as BlockEdit);

  for (const [name, stroke] of [['tops', dabs], ['tops and walls', walls]] as const) {
    it(`block layer ${name}: dab by dab with one stroke's coverage, as one command`, () => {
      const command = ground();
      const r = applyBlockEdits(command, stroke, ctx);
      expect(r.ok).toBe(true);
      const preview = ground();
      const coverages = new Map();
      for (const d of stroke) expect(applyBlockEdits(preview, [d], { ...ctx, coverages }).ok).toBe(true);
      expect(bytes(preview)).toBe(bytes(command));
      // Without the stroke's coverage the dabs pass the opacity: the coverage is what holds it.
      const loose = ground();
      for (const d of stroke) applyBlockEdits(loose, [d], ctx);
      expect(bytes(loose)).not.toBe(bytes(command));
      // The mask held paint back somewhere the unmasked stroke paints.
      const plain = ground();
      applyBlockEdits(plain, stroke.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'mask')) as BlockEdit), ctx);
      expect(bytes(plain)).not.toBe(bytes(command));
    });
  }

  it('vertex paint: dab by dab with one stroke, as the whole stroke', () => {
    const points = new Float32Array(30 * 30 * 3);
    for (let z = 0; z < 30; z++) for (let x = 0; x < 30; x++) points.set([x * 0.25, Math.sin(x * 0.3) * 0.5, z * 0.25], (z * 30 + x) * 3);
    const brush = { radius: 1.2, strength: 0.7, channel: 1, falloff: 'smooth' as const, opacity: 0.4, mask: { ...MASK, scale: 1 } };
    const stroke: PaintVec3[] = Array.from({ length: 12 }, (_v, i) => [1 + i * 0.4, 0, 3 + (i % 2) * 0.3]);
    const all = new Uint8Array(30 * 30 * 4);
    paintVertexDabs(points, all, stroke, brush);
    const one = new Uint8Array(30 * 30 * 4);
    const s = { mask: brush.mask, coverage: strokeCoverage(brush.opacity) };
    for (const d of stroke) paintVertexDabs(points, one, [d], brush, s);
    expect(Array.from(one)).toEqual(Array.from(all));
    // The opacity held: no vertex past 40 % of the way to full.
    expect(Math.max(...Array.from(all).filter((_v, i) => i % 4 === 1))).toBeLessThanOrEqual(Math.round(255 * 0.4) + 1);
  });
});
