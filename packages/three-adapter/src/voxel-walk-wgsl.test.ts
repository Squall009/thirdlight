/**
 * The WGSL walk's transmittance against the CPU walk's rule, in Node: the same steps and spent bound, the cover's words
 * read where the CPU's page form reads them, and the light volume's update multiplying what each walk let on. (The
 * page's GPU walk is checked against the CPU walk ray by ray, transmittance included, in the browser: walk.check.)
 */
import { describe, expect, it } from 'vitest';
import { coverPartial, WALK_BRICK_WORDS, WALK_COVER_STEPS, WALK_COVER_WORDS, WALK_SPENT } from '@thirdlight/voxel';

import { voxelWalkWgsl } from './voxel-walk-wgsl';
import { volumeUpdateWgsl } from './voxel-light-volume-wgsl';

describe('the WGSL walk through partly covered cells', () => {
  const w = voxelWalkWgsl({ group: 0, table: 1, pages: 2 });
  it('carries the CPU walk constants and reads the cover where the page form writes it', () => {
    expect(w).toContain(`const WALK_COVER_STEPS: f32 = ${WALK_COVER_STEPS}.0;`);
    expect(w).toContain(`const WALK_SPENT: f32 = ${WALK_SPENT};`);
    expect(w).toContain('trans: f32,');
    expect(w).toContain('return (walk_pages[w + WALK_BRICK_WORDS + (ci >> 3u)] >> ((ci & 7u) * 4u)) & 15u;');
    expect(w).toContain('trans = trans * (1.0 - f32(q) / WALK_COVER_STEPS);');
    // The cover's form as the CPU reads it: step 3 of cell 9 lands in word 16 + 1 at bits 4.
    const words = new Uint32Array(WALK_COVER_WORDS);
    words[WALK_BRICK_WORDS + (9 >>> 3)] = 3 << ((9 & 7) * 4);
    expect(coverPartial(words, 0).cell(9)).toBe(Math.round((3 * 255) / 15));
    // Only the light stop reads a cover; a cell entered by a face only; the first brick check before the stop's.
    expect(w).toContain('cover = v.y * stop;');
    expect(w).toContain('if (part && box == 1 && axis >= 0) {');
  });
  it("the light volume's update multiplies what its walks let on (sun, lamps, glow, sky, a hit)", () => {
    const u = volumeUpdateWgsl(true, true);
    expect(u).not.toContain('volume_clear');
    expect(u).toContain('return select(h.trans, 0.0, h.end == 1u);');
    expect(u).toContain('if (h.end == 0u || h.end == 2u) { return sky_radiance(d) * h.trans; }');
    expect(u).toContain('return (glow + volume_albedo(air) * e / PI) * h.trans;');
    expect(u.match(/volume_pass\(/g)!.length).toBeGreaterThanOrEqual(4);
  });
});
