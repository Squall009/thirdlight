import { describe, expect, it } from 'vitest';

import { planMipLevels, residentBytes, type MipCandidate } from './texture-budget';

/** A square texture of `edge` texels with a mip chain, 1 byte a texel (BC7-like), tail from 128. */
function tex(id: string, edge: number, over: Partial<MipCandidate> = {}): MipCandidate {
  const levelBytes: number[] = [];
  for (let e = edge; e >= 1; e = Math.floor(e / 2)) levelBytes.push(Math.max(16, e * e));
  const tail = levelBytes.findIndex((_, l) => edge >> l <= 128);
  return { id, levelBytes, tail, resident: tail, wanted: tail, copies: 1, weight: 0, ...over };
}

const MiB = 1024 * 1024;

describe('texture budget: which mips fit', () => {
  it('every texture keeps its tail; nothing more when nothing is seen', () => {
    const a = tex('a', 4096);
    const plan = planMipLevels([a], 64 * MiB);
    expect(plan.target.get('a')).toBe(a.tail);
    expect(plan.bytes).toBe(residentBytes(a, a.tail));
    expect(plan.over).toBe(false);
  });

  it('under a large budget each texture gets the level its size on screen asks for, no more', () => {
    const a = tex('a', 4096, { wanted: 0, weight: 900 });
    const b = tex('b', 2048, { wanted: 2, weight: 100 });
    const plan = planMipLevels([a, b], 512 * MiB);
    expect(plan.target.get('a')).toBe(0);
    expect(plan.target.get('b')).toBe(2);
  });

  it('under a small budget the texture furthest below its need goes first, one level at a time; the plan stays inside', () => {
    const a = tex('a', 4096, { wanted: 0, weight: 50 });
    const b = tex('b', 4096, { wanted: 0, weight: 900 });
    // Room for both at level 2 (4 MiB each with the tail) and one of them at level 1, not both.
    const budget = residentBytes(a, 2) * 2 + 1024 * 1024 * 4 + 1;
    const plan = planMipLevels([a, b], budget);
    expect(plan.bytes).toBeLessThanOrEqual(budget);
    // Equal need: the larger on screen gets the next level.
    expect(plan.target.get('b')).toBe(1);
    expect(plan.target.get('a')).toBe(2);
  });

  it('levels resident but no longer needed stay while there is room, and go first when there is not; the least-needed texture drops first', () => {
    // Both were close (level 0 resident); now `near` is still seen and `gone` left the view.
    const near = tex('near', 2048, { resident: 0, wanted: 0, weight: 500 });
    const gone = tex('gone', 2048, { resident: 0, wanted: tex('x', 2048).tail, weight: -3 });
    const roomy = planMipLevels([near, gone], 64 * MiB);
    expect(roomy.target.get('near')).toBe(0);
    expect(roomy.target.get('gone')).toBe(0);
    // Room for one whole chain and a little: the unneeded one drops, the needed one stays.
    const tight = residentBytes(near, 0) + residentBytes(gone, gone.tail) + 1;
    const plan = planMipLevels([near, gone], tight);
    expect(plan.target.get('near')).toBe(0);
    expect(plan.target.get('gone')).toBe(gone.tail);
    expect(plan.bytes).toBeLessThanOrEqual(tight);
  });

  it('counts every GPU copy and the textures that do not stream', () => {
    const a = tex('a', 1024, { wanted: 0, weight: 10, copies: 3 });
    expect(residentBytes(a, 0)).toBe(3 * residentBytes({ ...a, copies: 1 }, 0));
    const fixed = 10 * MiB;
    const budget = fixed + residentBytes(a, 1) + 1;
    const plan = planMipLevels([a], budget, fixed);
    expect(plan.target.get('a')).toBe(1);
    expect(plan.bytes).toBeLessThanOrEqual(budget);
  });

  it('says when the tails and fixed textures alone exceed the budget (the tails stay)', () => {
    const a = tex('a', 4096, { wanted: 0, weight: 1 });
    const plan = planMipLevels([a], 1024, 0);
    expect(plan.over).toBe(true);
    expect(plan.target.get('a')).toBe(a.tail);
  });

  it('a thousand textures plan in well under a frame', () => {
    const many = Array.from({ length: 1000 }, (_, i) => tex(`t${i}`, 2048, { wanted: i % 5, weight: i }));
    const t0 = performance.now();
    const plan = planMipLevels(many, 256 * MiB);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(plan.bytes).toBeLessThanOrEqual(256 * MiB);
  });
});
