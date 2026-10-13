/**
 * Height in alpha, browser-free: when an image's A counts as a height (a
 * constant or a level or two of encoder noise does not; a few stray texels
 * do not make one), the brightness height that stands in for a missing one,
 * the stand-in packed into an array layer's A by the encoder, which textures
 * a project's materials read their height from (never a cut-out's), and the
 * problem line.
 */
import type { MaterialDef } from '@thirdlight/project-model';
import { LAYERED_TEXTURES, layeredMaterial } from '@thirdlight/project-model/layered-surface';
import { describe, expect, it } from 'vitest';

import { heightProblemLine, heightSlotUses } from './height-alpha';
import { alphaSpread, brightnessHeight, FLAT_ALPHA_SPREAD, heightAlphaOf } from './height-pixels';
import { encodeRgbaPng } from './image-thumbnail';
import { decodeTextureRgba, packKtx2 } from './texture-encode';

const N = 32 * 32;
/** An RGBA image of N pixels from a per-pixel function. */
const image = (px: (i: number) => [number, number, number, number]): Uint8Array => {
  const out = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) out.set(px(i), i * 4);
  return out;
};

describe('the check: is there a height in A?', () => {
  it('a missing (opaque) A is flat, with encoder noise of a level or two too; a constant below opaque is a height', () => {
    expect(heightAlphaOf(image(() => [90, 80, 70, 255]))).toBe('flat');
    expect(heightAlphaOf(image((i) => [90, 80, 70, 252 + (i % 3)]))).toBe('flat');
    // A layer that is uniformly high or low (the painted-terrain fixtures' 230 and 20) is a deliberate height.
    expect(heightAlphaOf(image(() => [90, 80, 70, 128]))).toBe('height');
    expect(heightAlphaOf(image((i) => [90, 80, 70, 20 + (i % 3)]))).toBe('height');
    expect(alphaSpread(image((i) => [0, 0, 0, 200 + (i % 3)]))).toBe(2);
  });
  it('a painted height spans far more than the flat spread; a few stray texels do not make one', () => {
    expect(heightAlphaOf(image((i) => [90, 80, 70, i % 256]))).toBe('height');
    expect(alphaSpread(image((i) => [0, 0, 0, (i * 7) % 256]))).toBeGreaterThan(200);
    // Under one percent of the pixels at 0 (a seam) on an otherwise constant A.
    const seam = image((i) => [90, 80, 70, i < 8 ? 0 : 255]);
    expect(alphaSpread(seam)).toBeLessThanOrEqual(FLAT_ALPHA_SPREAD);
    expect(heightAlphaOf(seam)).toBe('flat');
  });
});

describe('the stand-in: a height from brightness', () => {
  it('dark is low, bright is high, stretched to the full range', () => {
    const h = brightnessHeight(image((i) => (i < N / 2 ? [40, 40, 40, 255] : [160, 160, 160, 255])));
    expect(h[0]).toBe(0);
    expect(h[N - 1]).toBe(255);
    // Green weighs most (Rec. 709): a green texel is brighter than a blue one of the same value.
    const g = brightnessHeight(image((i) => (i % 3 === 0 ? [0, 200, 0, 255] : i % 3 === 1 ? [0, 0, 200, 255] : [0, 0, 0, 255])));
    expect(g[0]!).toBeGreaterThan(g[1]!);
  });
  it('a plain colour gets a flat middle height', () => {
    expect([...new Set(brightnessHeight(image(() => [120, 60, 30, 255])))]).toEqual([128]);
  });
  it('the encoder packs it into a layer\'s A once, beside the texture\'s own colour', async () => {
    const px = image((i) => {
      const v = (i % 32) * 8;
      return [v, v, v, 255];
    });
    const png = encodeRgbaPng(px, 32, 32);
    const packed = await packKtx2([png], [[{ source: 0, channel: 0 }, { source: 0, channel: 1 }, { source: 0, channel: 2 }, { source: 0, height: true }]], 'data');
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    expect(packed.joined).toBe(false);
    const back = await decodeTextureRgba(packed.ktx2, N);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const want = brightnessHeight(px);
    // UASTC keeps the ramp within a few levels.
    for (const i of [0, 5, 17, 31, 32 * 16 + 20]) expect(Math.abs(back.data[i * 4 + 3]! - want[i]!)).toBeLessThanOrEqual(6);
    expect(back.data[31 * 4 + 3]!).toBeGreaterThan(back.data[3]! + 200);
  });
});

describe('which textures are checked', () => {
  const withAlbedo = (m: MaterialDef, slots: string[]): MaterialDef => ({ ...m, parameters: (m.parameters ?? []).map((p) => (p.key === LAYERED_TEXTURES.albedo ? { ...p, default: slots } : p)) as MaterialDef['parameters'] });

  it('a layered surface\'s albedo slots, per layer; an instance by its own slots', () => {
    const m = withAlbedo(layeredMaterial('ground', 'Ground'), ['rock', '', 'moss']);
    const inst: MaterialDef = { materialId: 'ground-b', name: 'Ground B', shader: 'standard', params: {}, textures: {}, instanceOf: 'ground', values: { [LAYERED_TEXTURES.albedo]: ['sand', 'moss'] } };
    expect(heightSlotUses([m, inst]).map((u) => `${u.materialId}:${u.layer}:${u.textureId}`)).toEqual(['ground:0:rock', 'ground:2:moss', 'ground-b:0:sand', 'ground-b:1:moss']);
  });
  it('a cut-out (alpha into opacity) is never checked: its A is opacity', () => {
    const base = withAlbedo(layeredMaterial('leaves', 'Leaves'), ['leaf']);
    const graph = base.graph!;
    const albedoRead = graph.edges.find((e) => graph.nodes.find((n) => n.id === e.from.node)?.data?.['key'] === LAYERED_TEXTURES.albedo)!.to.node;
    const out = graph.nodes.find((n) => n.type === 'pbr')!.id;
    const cutout: MaterialDef = { ...base, graph: { ...graph, edges: [...graph.edges, { id: 'cut', from: { node: albedoRead, port: 'a' }, to: { node: out, port: 'opacity' } }] } };
    expect(heightSlotUses([cutout])).toEqual([]);
  });
  it('the problem names the texture, says blends will be soft, and where it is used', () => {
    const line = heightProblemLine('rock-albedo', [{ materialId: 'g', name: 'Ground', layer: 1, textureId: 'rock-albedo' }]);
    expect(line).toMatch(/^rock-albedo: no height in alpha — blends between layers will be soft \("Ground" layer 2\)/);
    expect(line).toMatch(/Texture Designer/);
  });
});
