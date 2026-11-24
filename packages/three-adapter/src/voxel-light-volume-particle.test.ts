import { describe, expect, it } from 'vitest';
import { CPU_SCALAR_OPS, latticeHash4 } from '@thirdlight/shared';
import { ambientCubeSteps, VOLUME_FULL_WEIGHT, VOLUME_LEVELS, VOLUME_READ_KINDS, VOLUME_READ_MIN_WEIGHT, volumeCellM, volumeParticleRead, volumeReadFlag } from './voxel-light-volume-layout';

/** A fixed hash in [0, 1) of a cell of a level and a lane (the same faces every run). */
const hash = (level: number, x: number, y: number, z: number, k: number): number => latticeHash4(x, y, z, (level + 1) * 1009 + k) / 4294967296;

/** Cells of each level: level 0 holds light in about a third of its cells (beside surfaces), the coarse levels in most. */
function faces(level: number, x: number, y: number, z: number): number[][] | null {
  if (hash(level, x, y, z, 0) < (level === 0 ? 0.66 : 0.15)) return null;
  return Array.from({ length: 6 }, (_, f) => [0, 1, 2].map((ch) => hash(level, x, y, z, 1 + f * 3 + ch) * (level + 1)));
}

/**
 * The rule written out on its own: level 0 the one cell the centre lies in (all the weight where it holds light), each
 * coarse level the eight cells round the centre weighted trilinearly, a cell's light its faces toward the eye by the
 * ambient cube's weights, each level taking the smooth step of its weight (to the full weight) of what the finer ones left.
 */
function reference(p: number[], eye: number[]): { light: number[]; weight: number } {
  const d = [0, 1, 2].map((a) => eye[a]! - p[a]!);
  const len = Math.hypot(d[0]!, d[1]!, d[2]!);
  const n = d.map((v) => v / len);
  const cellLight = (fc: number[][]): number[] => [0, 1, 2].map((ch) => ambientCubeSteps(CPU_SCALAR_OPS, n[0]!, n[1]!, n[2]!, [fc[0]![ch]!, fc[1]![ch]!, fc[2]![ch]!, fc[3]![ch]!, fc[4]![ch]!, fc[5]![ch]!]));
  let left = 1;
  const acc = [0, 0, 0];
  for (let level = 0; level < VOLUME_LEVELS; level++) {
    if (left <= 1e-3) break;
    const m = volumeCellM(level);
    let light = [0, 0, 0];
    let w = 0;
    if (level === 0) {
      const fc = faces(0, Math.floor(p[0]! / m), Math.floor(p[1]! / m), Math.floor(p[2]! / m));
      if (fc !== null) {
        light = cellLight(fc);
        w = 1;
      }
    } else {
      const g = p.map((v) => v / m - 0.5);
      const sum = [0, 0, 0];
      for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
        const c = [Math.floor(g[0]!) + dx, Math.floor(g[1]!) + dy, Math.floor(g[2]!) + dz];
        const t = [0, 1, 2].map((a) => g[a]! - Math.floor(g[a]!));
        const wk = (dx ? t[0]! : 1 - t[0]!) * (dy ? t[1]! : 1 - t[1]!) * (dz ? t[2]! : 1 - t[2]!);
        // A cell weighing less than the read's least is not read (the GPU's rule).
        const fc = wk > VOLUME_READ_MIN_WEIGHT ? faces(level, c[0]!, c[1]!, c[2]!) : null;
        if (fc === null) continue;
        const l = cellLight(fc);
        for (let ch = 0; ch < 3; ch++) sum[ch]! += wk * l[ch]!;
        w += wk;
      }
      light = w > 0 ? sum.map((v) => v / w) : [0, 0, 0];
    }
    const s = Math.min(Math.max(w / VOLUME_FULL_WEIGHT, 0), 1);
    const share = s * s * (3 - 2 * s);
    for (let ch = 0; ch < 3; ch++) acc[ch]! += left * share * light[ch]!;
    left *= 1 - share;
  }
  const weight = 1 - left;
  return { light: acc.map((v) => v / Math.max(weight, 1e-4)), weight };
}

describe("lit particles' read of the light volume", () => {
  it('a particle reads the levels at its centre facing the eye: equal to the rule written out at 600 points, open air from the coarse levels', () => {
    let coarse = 0;
    let level0 = 0;
    for (let i = 0; i < 600; i++) {
      const r = (k: number): number => hash(9, i, k, 3, k);
      const p = [-30 + 60 * r(0), -5 + 20 * r(1), -30 + 60 * r(2)];
      const eye = [p[0]! + 40 * (r(3) - 0.5), p[1]! + 10 * (r(4) - 0.5) + 0.1, p[2]! + 40 * (r(5) - 0.5)];
      const got = volumeParticleRead(p, eye, faces, CPU_SCALAR_OPS);
      const want = reference(p, eye);
      expect(got.weight).toBeCloseTo(want.weight, 9);
      for (let ch = 0; ch < 3; ch++) expect(got.light[ch]).toBeCloseTo(want.light[ch]!, 9);
      if (faces(0, Math.floor(p[0]! / 0.5), Math.floor(p[1]! / 0.5), Math.floor(p[2]! / 0.5)) === null) {
        if (got.weight > 0) coarse++;
        expect(got.shares[0]).toBe(0);
      } else level0++;
    }
    expect(coarse).toBeGreaterThan(300);
    expect(level0).toBeGreaterThan(100);
  });

  it("lit particles are a kind of reader of their own: on by default, left out when other kinds are named, read a pixel by 'particlepixel'", () => {
    expect(volumeReadFlag(null).kinds & VOLUME_READ_KINDS.particle).toBe(VOLUME_READ_KINDS.particle);
    expect(volumeReadFlag('surface,kit,prop').kinds & VOLUME_READ_KINDS.particle).toBe(0);
    expect(volumeReadFlag(null).particlePixel).toBe(false);
    expect(volumeReadFlag('particlepixel').particlePixel).toBe(true);
  });
});
