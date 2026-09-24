import { describe, expect, it } from 'vitest';

import { scatterProblem, scatterTransforms } from './instances';

const base = { count: 100, width: 20, depth: 6, scaleMin: 0.5, scaleMax: 1.5, randomYaw: true, seed: 7 };

describe('scatter (phase 12 c instance sets)', () => {
  it('spreads copies inside the rectangle with unit quaternions and scales in range; a seed repeats the layout', () => {
    const t = scatterTransforms(base);
    expect(t.length).toBe(1000);
    for (let i = 0; i < 100; i += 1) {
      const b = i * 10;
      expect(Math.abs(t[b]!)).toBeLessThanOrEqual(10);
      expect(t[b + 1]).toBe(0);
      expect(Math.abs(t[b + 2]!)).toBeLessThanOrEqual(3);
      expect(Math.hypot(t[b + 3]!, t[b + 4]!, t[b + 5]!, t[b + 6]!)).toBeCloseTo(1, 5);
      expect(t[b + 7]).toBeGreaterThanOrEqual(0.5);
      expect(t[b + 7]).toBeLessThanOrEqual(1.5);
      expect(t[b + 8]).toBe(t[b + 7]);
    }
    expect(scatterTransforms(base)).toEqual(t);
    expect(scatterTransforms({ ...base, seed: 8 })).not.toEqual(t);
  });

  it('refuses bad options', () => {
    expect(scatterProblem({ ...base, count: 0 })).toMatch(/count/);
    expect(scatterProblem({ ...base, count: 70_000 })).toMatch(/count/);
    expect(scatterProblem({ ...base, scaleMin: 2, scaleMax: 1 })).toMatch(/scale/);
    expect(scatterProblem(base)).toBeNull();
    expect(() => scatterTransforms({ ...base, width: -1 })).toThrow(/width/);
  });
});
