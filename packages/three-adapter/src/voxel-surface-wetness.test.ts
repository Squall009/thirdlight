/**
 * The voxel surface's height blend and wetness, run on numbers through the
 * very functions the program builds from nodes (`voxel-surface-wetness.ts`):
 * the higher surface in metres wins where two materials meet (deep rock
 * through shallow sand, never the other way), a whole share shows its
 * material alone, flat materials blend by share; wetness levels 0–7 on a
 * fixed set of pixel heights darken, smooth and flatten in order, and water
 * fills the lowest pixels first, standing in the low parts at level 7 and
 * nowhere when dry. The program side (both backends) is in
 * `voxel-surface.test.ts` and `voxel-relief.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { WETNESS_MAX } from '@thirdlight/voxel';

import type { ProjectionOps } from './voxel-surface-projection';
import { heightBlend, WET_FILL_MAX, WET_WATER_ROUGHNESS, wetLook } from './voxel-surface-wetness';

const NUM: ProjectionOps<number, boolean> = {
  num: (v) => v,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  abs: Math.abs,
  max: Math.max,
  sqrt: Math.sqrt,
  less: (a, b) => a < b,
  pick: (c, a, b) => (c ? a : b),
};

describe('the height blend in metres', () => {
  it('lets the higher surface win where two materials meet, by each material\'s own depth', () => {
    const sand = 0.02;
    const rock = 0.12;
    // Half and half: a rock top (height 0.98 → 0.24 cm down) stands above sand's middle (1 cm down) and wins; rock's
    // crack (height 0.2 → 9.6 cm down) is filled by sand.
    expect(heightBlend(NUM, 0.5, sand, 0.98, rock, 0.5).share).toBeGreaterThan(0.6);
    expect(heightBlend(NUM, 0.5, sand, 0.2, rock, 0.5).share).toBeLessThan(0.05);
    // In metres, not in the maps' 0–1: the same map values on a shallow and a deep material are not equal.
    const same = heightBlend(NUM, 0.6, sand, 0.6, rock, 0.5);
    expect(same.share).toBeLessThan(0.2);
    // A whole share is that material alone, however the heights lie.
    for (const [hA, hB] of [[0, 1], [1, 0], [0.3, 0.7]] as const) {
      expect(heightBlend(NUM, hA, sand, hB, rock, 0).share).toBe(0);
      expect(heightBlend(NUM, hA, sand, hB, rock, 1).share).toBe(1);
    }
    // The share rises with B's share of the cells at fixed heights.
    let last = -1;
    for (let s = 0; s <= 1.0001; s += 0.1) {
      const b = heightBlend(NUM, 0.5, sand, 0.5, rock, s).share;
      expect(b).toBeGreaterThanOrEqual(last);
      last = b;
    }
    // Flat materials (no depth) blend by their shares, half and half in the middle, the surface on its plain level.
    const flat = heightBlend(NUM, 0.2, 0, 0.9, 0, 0.5);
    expect(flat.share).toBeCloseTo(0.5, 6);
    expect(flat.recess).toBe(0);
    expect(flat.height).toBe(1);
    // The blended surface's recess and height: rock alone, height 0.25 → 9 cm down, height 0.25 of its depth.
    const r = heightBlend(NUM, 0.25, rock, 0.25, rock, 0);
    expect(r.recess).toBeCloseTo(0.09, 9);
    expect(r.height).toBeCloseTo(0.25, 9);
  });
});

describe('wetness (R111)', () => {
  // A fixed set of pixel heights (0 a crevice's floor … 1 the surface) and a material roughness.
  const heights = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1];
  const roughness = 0.8;
  const levels = Array.from({ length: WETNESS_MAX + 1 }, (_, k) => k / WETNESS_MAX);
  const at = (wet: number, h: number) => {
    const w = wetLook(NUM, wet, h);
    return { ...w, rough: roughness * w.roughness * (1 - w.water) + WET_WATER_ROUGHNESS * w.water };
  };

  it('darkens, smooths and flattens every pixel in order as the level rises; dry changes nothing', () => {
    for (const h of heights) {
      const dry = at(0, h);
      expect([dry.albedo, dry.roughness, dry.water, dry.flatten]).toEqual([1, 1, 0, 0]);
      for (let k = 1; k < levels.length; k++) {
        const a = at(levels[k - 1]!, h);
        const b = at(levels[k]!, h);
        expect(b.albedo, `h ${h} level ${k}`).toBeLessThan(a.albedo);
        // Strictly while the pixel is still out of the water; under it, water's own roughness and a flat normal stay.
        if (a.water === 0) {
          expect(b.rough, `h ${h} level ${k}`).toBeLessThan(a.rough);
          expect(b.flatten, `h ${h} level ${k}`).toBeGreaterThan(a.flatten);
        } else {
          expect(b.rough, `h ${h} level ${k}`).toBeLessThanOrEqual(a.rough);
          expect(b.flatten, `h ${h} level ${k}`).toBeGreaterThanOrEqual(a.flatten);
        }
        expect(b.water, `h ${h} level ${k}`).toBeGreaterThanOrEqual(a.water);
      }
    }
  });

  it('fills crevices first: at every level a lower pixel holds at least as much water; at 7 the low parts stand as water, the tops stay out', () => {
    for (const wet of levels) {
      const water = heights.map((h) => at(wet, h).water);
      for (let i = 1; i < water.length; i++) expect(water[i]!).toBeLessThanOrEqual(water[i - 1]!);
    }
    // Damp (levels 1–2): no standing water anywhere above the crevice floor's last few percent.
    expect(heights.slice(1).map((h) => at(2 / WETNESS_MAX, h).water).every((w) => w === 0)).toBe(true);
    const full = heights.map((h) => at(1, h));
    // Level 7: everything under the water line is water (flat, smooth), the tops are wet ground.
    for (const [i, h] of heights.entries()) {
      if (h <= WET_FILL_MAX - 0.05) expect([full[i]!.water, full[i]!.flatten, full[i]!.rough]).toEqual([1, 1, WET_WATER_ROUGHNESS]);
      if (h >= WET_FILL_MAX + 0.01) expect(full[i]!.water).toBe(0);
    }
    // The water line rises with the level: the wet share of the pixel set grows 3 → 5 → 7.
    const wetShare = (k: number): number => heights.filter((h) => at(k / WETNESS_MAX, h).water > 0.5).length;
    expect(wetShare(3)).toBeLessThan(wetShare(5));
    expect(wetShare(5)).toBeLessThan(wetShare(7));
  });
});
