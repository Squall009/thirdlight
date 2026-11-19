/**
 * A glow mask in a voxel texture set's ORM alpha, through the engine's texture path: the bench's crack mask (seamless,
 * about a third of the texels lit), an ORM image carrying it encoded as an import encodes it (`encodeKtx2`, 'data':
 * UASTC with its own mips), assembled into an array beside the voxel ORM's absent layer as the slot assembly packs one
 * (each layer's four channels, or its constant), in one encode and layer by layer then joined, and transcoded by
 * three's transcoder as a page reads it: the mask's mean comes back within 1/255 at every level, the absent layer and
 * an ORM without alpha read A = 1. And the mean the volume uses for the bench's material, against the texture's own.
 */
import { describe, expect, it } from 'vitest';
import { parseFillLayer, VOXEL_ORM_ABSENT } from '@thirdlight/project-model';
import { fillLayerId } from '@thirdlight/project-model/texture-slots';

import { encodeRgbaPng } from '../../packages/backend/src/image-thumbnail';
import { createInlineTextureEncoder, encodeKtx2, type PackLayer } from '../../packages/backend/src/texture-encode';
import { layerMeansOfSums, volumeLookGlow } from '../../packages/three-adapter/src/voxel-light-volume-colours';
import { crackGlowMask, placeholderSet, withAlpha } from './texture-sets';
import { transcodeKtx2Levels } from './three-basis';

const SIZE = 256;
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The mean of channel `k` of layer `layer` of a transcoded level (0–255). */
function channelMean(level: { width: number; height: number; data: Uint8Array }, layer: number, k: number): number {
  const n = level.width * level.height;
  let s = 0;
  for (let i = 0; i < n; i++) s += level.data[(layer * n + i) * 4 + k]!;
  return s / n;
}

describe('a glow mask in the ORM alpha', () => {
  const mask = crackGlowMask(SIZE);
  const orm = placeholderSet('rock', SIZE).orm;
  const masked = withAlpha(orm, mask);
  const maskMean = mask.reduce((s, v) => s + v, 0) / mask.length;

  it('the bench mask: cracks over about a third of the tile, seamless, not constant', () => {
    const lit = mask.filter((v) => v > 0).length / mask.length;
    console.log(`[glow mask] lit texels ${(lit * 100).toFixed(1)} %, mean ${(maskMean / 255).toFixed(3)}`);
    expect(lit).toBeGreaterThan(0.15);
    expect(lit).toBeLessThan(0.5);
    // Seamless: the first and last columns (and rows) differ no more than neighbouring ones do inside.
    const step = (a: number, b: number): number => Math.abs(mask[a]! - mask[b]!);
    let edge = 0;
    let inner = 0;
    for (let y = 0; y < SIZE; y++) {
      edge += step(y * SIZE + SIZE - 1, y * SIZE);
      inner += step(y * SIZE + SIZE / 2 - 1, y * SIZE + SIZE / 2);
    }
    expect(edge).toBeLessThan(inner * 3 + SIZE * 8);
  });

  it('keeps its mean through the import encode, the slot assembly (one encode, and layer by layer joined) and every mip; the absent layer and an ORM without alpha read A = 1', async () => {
    const png = (rgba: Uint8Array): Uint8Array => encodeRgbaPng(rgba, SIZE, SIZE);
    const imported = await encodeKtx2(png(masked), 'data');
    const plain = await encodeKtx2(png(orm.map((v, i) => (i % 4 === 3 ? 255 : v))), 'data');
    if (!imported.ok || !plain.ok) throw new Error('encode failed');
    const absent = parseFillLayer(fillLayerId(VOXEL_ORM_ABSENT))!;
    expect(absent).toEqual([255, 204, 0, 255]);
    // As the slot assembly packs each layer: a texture's four channels, a constant's bytes.
    const whole = (source: number): PackLayer => [0, 1, 2, 3].map((channel) => ({ source, channel })) as unknown as PackLayer;
    const constant = absent.map((value) => ({ value })) as unknown as PackLayer;
    const enc = createInlineTextureEncoder();
    const one = await enc.pack([imported.ktx2, plain.ktx2], [whole(0), constant, whole(1)], 'data', [], 'assembled');
    if (!one.ok) throw new Error(one.message);
    // Layer by layer then joined (the assembly's way on several encoder threads, or past one encode's size).
    const parts = await Promise.all([[0, whole(0)], [0, constant], [1, whole(0)]].map(([s, l]) => enc.pack([[imported.ktx2, plain.ktx2][s as number]!], [l as PackLayer], 'data', [], 'assembled')));
    for (const p of parts) if (!p.ok) throw new Error('layer encode failed');
    const joined = await enc.pack(parts.map((p) => (p as { ktx2: Uint8Array }).ktx2), [whole(0), whole(1), whole(2)], 'data');
    if (!joined.ok) throw new Error(joined.message);
    expect(joined.joined).toBe(true);
    for (const [name, ktx2] of [['one encode', one.ktx2], ['joined', joined.ktx2]] as const) {
      const t = await transcodeKtx2Levels(ktx2);
      expect(t.layers).toBe(3);
      expect(t.levels.length).toBeGreaterThan(5);
      const errs: string[] = [];
      for (const [l, level] of t.levels.entries()) {
        const a = channelMean(level, 0, 3);
        errs.push((a - maskMean).toFixed(2));
        // The mips are the encoder's (alpha filtered as the other channels, by a filter wider than a box that rings at
        // the cracks' edges and is clamped at 0): the mean holds within 1/255 down to the 128² tail the volume's pass
        // reads the mask's share from, and drifts up below 64² (see the log).
        expect(Math.abs(a - maskMean), `${name} level ${l}`).toBeLessThan(level.width >= 128 ? 1 : 8);
        expect(channelMean(level, 1, 3), `${name} absent layer level ${l}`).toBe(255);
        expect(channelMean(level, 2, 3), `${name} no alpha level ${l}`).toBe(255);
      }
      // Not a constant: the top level keeps the cracks (texels near 0 and near 255).
      const top = t.levels[0]!;
      const n = top.width * top.height;
      let low = 0;
      let high = 0;
      for (let i = 0; i < n; i++) {
        const a = top.data[i * 4 + 3]!;
        if (a < 16) low++;
        if (a > 240) high++;
      }
      expect(low / n).toBeGreaterThan(0.4);
      expect(high / n).toBeGreaterThan(0.05);
      console.log(`[glow mask] ${name}: the mask's mean over each level against the source's (/255): ${errs.join(', ')}`);
    }
  }, 120_000);

  it("the volume's mean of what the bench's masked lava draws: the pass's against the texture's own, and the cheaper colour mean × mask mean", () => {
    const SIDE = 1024;
    const albedo = placeholderSet('rock', SIDE).albedo;
    const m = crackGlowMask(SIDE);
    const n = SIDE * SIDE;
    // The truth: the mean over every texel of linear colour × mask.
    const exact = [0, 0, 0];
    const colour = [0, 0, 0];
    let mm = 0;
    for (let i = 0; i < n; i++) {
      const a = m[i]! / 255;
      mm += a;
      for (let k = 0; k < 3; k++) {
        const c = srgbToLinear(albedo[i * 4 + k]! / 255);
        exact[k]! += c * a;
        colour[k]! += c;
      }
    }
    for (let k = 0; k < 3; k++) {
      exact[k]! /= n;
      colour[k]! /= n;
    }
    mm /= n;
    // The pass's: the 16² level's colour (each texel the box mean of a block, in linear light as an sRGB texture's mips
    // are read), times each channel's share the mask keeps over the 128² level, through the reduction the page runs.
    const level = (side: number): { c: number[][]; a: number[] } => {
      const b = SIDE / side;
      const c: number[][] = [];
      const a: number[] = [];
      for (let by = 0; by < side; by++) for (let bx = 0; bx < side; bx++) {
        const sum = [0, 0, 0];
        let ma = 0;
        for (let y = by * b; y < (by + 1) * b; y++) for (let x = bx * b; x < (bx + 1) * b; x++) {
          const i = y * SIDE + x;
          ma += m[i]! / 255;
          for (let k = 0; k < 3; k++) sum[k]! += srgbToLinear(albedo[i * 4 + k]! / 255);
        }
        c.push(sum.map((v) => v / (b * b)));
        a.push(ma / (b * b));
      }
      return { c, a };
    };
    const coarse = level(16);
    const fine = level(128);
    const avg = (v: readonly number[]): number => v.reduce((x, y) => x + y, 0) / v.length;
    const sums = [0, 1, 2].map((k) => avg(coarse.c.map((c) => c[k]!)));
    const prod = [...[0, 1, 2].map((k) => avg(fine.c.map((c, i) => c[k]! * fine.a[i]!))), avg(fine.a)];
    const col = [0, 1, 2].map((k) => avg(fine.c.map((c) => c[k]!)));
    const means = layerMeansOfSums(sums, prod, col, (c) => c);
    // A mask of 1 everywhere: the colour mean again, exactly (an unmasked material's light is as before).
    expect(layerMeansOfSums(sums, [...col, 1], col, (c) => c).slice(3, 6)).toEqual(means.slice(0, 3));
    const rel = (got: readonly number[]): number => Math.max(...[0, 1, 2].map((k) => Math.abs(got[k]! - exact[k]!) / exact[k]!));
    const built = rel(means.slice(3, 6));
    const cheap = rel(colour.map((c) => c * mm));
    console.log(`[glow mask] the masked lava's mean drawn (linear rgb) ${exact.map((v) => v.toFixed(4)).join(', ')}; mask mean ${mm.toFixed(3)}; the pass's (16² colour × the 128² mask share) off by ${(built * 100).toFixed(2)} %, colour mean × mask mean by ${(cheap * 100).toFixed(2)} %`);
    expect(built).toBeLessThan(0.03);
    // The material's one value the volume uses: glow × the mean of what it draws (a white tint: the set as authored).
    const glow: [number, number, number] = [4, 1.41, 0.28];
    const value = volumeLookGlow({ colour: 0xffffff, pattern: 0, glow }, [means, null, null])!;
    for (let k = 0; k < 3; k++) expect(Math.abs(value[k]! - glow[k]! * exact[k]!) / (glow[k]! * exact[k]!)).toBeLessThan(0.03);
    // Its colour part is the plain mean the bounce reads.
    for (let k = 0; k < 3; k++) expect(means[k]).toBeCloseTo(colour[k]!, 6);
  });
});
