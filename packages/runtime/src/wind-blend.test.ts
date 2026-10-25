/**
 * `ctx.environment.setWind` is simulation state: two runs of the same calls
 * agree step by step, a save taken mid-blend continues to the same steps,
 * and what the renderer reads (the shares, over JSON as the simulation
 * worker sends them) blends to the same wind.
 */
import { describe, expect, it } from 'vitest';

import type { WindConfig } from '@thirdlight/project-model';

import { EnvironmentDirector } from './environment-director';
import { blendWinds } from './wind-blend';

const HZ = 60;
const SCENE_WIND: WindConfig = { direction: [1, 0], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 };

function run(director: EnvironmentDirector, steps: number, at: (step: number) => void): string[] {
  const digests: string[] = [];
  for (let s = 0; s < steps; s += 1) {
    at(s);
    director.step();
    digests.push(director.digestText() ?? 'null');
  }
  return digests;
}

const script = (d: EnvironmentDirector) => (s: number): void => {
  if (s === 3) d.api.setWind({ strength: 3, direction: [0, 1] }, { blend: 1 });
  if (s === 40) d.api.setWind({ gust: 2 }, { blend: 0.5, easing: 'easeInOut' });
  if (s === 90) d.api.setWind(null, { blend: 2 });
};

describe('ctx.environment.setWind', () => {
  it('is inert until used, then blends over whole steps and runs alike every time', () => {
    const a = new EnvironmentDirector(HZ, [], () => {});
    expect(a.view(1)).toBeNull();
    expect(a.digestText()).toBeNull();
    const b = new EnvironmentDirector(HZ, [], () => {});
    const da = run(a, 240, script(a));
    const db = run(b, 240, script(b));
    expect(da).toEqual(db);
    expect(da[2]).toBe('null');
    expect(new Set(da).size).toBeGreaterThan(100);
  });

  it('half way through a blend the wind is between the two; at its end it is the new one; changes add up', () => {
    const d = new EnvironmentDirector(HZ, [], () => {});
    expect(d.api.setWind({ strength: 3, direction: [0, 1] }, { blend: 1 })).toBe(true);
    for (let s = 0; s < 30; s += 1) d.step();
    const half = blendWinds(SCENE_WIND, d.view(1)!.wind!);
    expect(half.strength).toBeCloseTo(1.75, 5);
    expect(Math.hypot(half.direction[0], half.direction[1])).toBeCloseTo(1, 6);
    expect(half.direction[0]).toBeCloseTo(Math.SQRT1_2, 5);
    for (let s = 0; s < 31; s += 1) d.step();
    const end = blendWinds(SCENE_WIND, d.view(1)!.wind!);
    expect(end.strength).toBe(3);
    expect(end.direction).toEqual([0, 1]);
    // A second change keeps the first one's fields.
    d.api.setWind({ gust: 2 }, {});
    d.step();
    const both = blendWinds(SCENE_WIND, d.view(1)!.wind!);
    expect([both.strength, both.gust, both.direction]).toEqual([3, 2, [0, 1]]);
    // Back to the scene's own wind.
    d.api.setWind(null, {});
    d.step();
    const back = blendWinds(SCENE_WIND, d.view(1)!.wind!);
    expect([back.strength, back.gust, back.direction]).toEqual([0.5, 0.4, [1, 0]]);
    // The pattern's speed defaults to gusts per second times its size (20 m), as the renderer reads it.
    expect(back.speed).toBeCloseTo(0.3 * 20, 9);
  });

  it('a save taken mid-blend restores to the same steps; the shares survive JSON (the worker sends them so)', () => {
    const a = new EnvironmentDirector(HZ, [], () => {});
    run(a, 60, script(a));
    const saved = JSON.parse(JSON.stringify(a.saveState())) as ReturnType<EnvironmentDirector['saveState']>;
    expect(a.checkState(saved)).toBeNull();
    const b = new EnvironmentDirector(HZ, [], () => {});
    b.restoreState(saved);
    const tail = (d: EnvironmentDirector): string[] => run(d, 120, (s) => script(d)(s + 60));
    expect(tail(b)).toEqual(tail(a));
    const view = a.view(0.5)!;
    expect(blendWinds(SCENE_WIND, JSON.parse(JSON.stringify(view.wind)))).toEqual(blendWinds(SCENE_WIND, view.wind!));
  });

  it('refuses a bad value or option, and a broken save section, with a warning', () => {
    const warnings: string[] = [];
    const d = new EnvironmentDirector(HZ, [], (m) => warnings.push(m));
    expect(d.api.setWind({ strength: 11 }, {})).toBe(false);
    expect(d.api.setWind({ direction: [0, 0] }, {})).toBe(false);
    expect(d.api.setWind({ strength: 1 }, { blend: -1 })).toBe(false);
    expect(d.api.setWind({ strength: 1 }, { easing: 'bounce' as never })).toBe(false);
    expect(warnings).toHaveLength(4);
    expect(d.view(1)).toBeNull();
    expect(d.checkState({ weights: [['', 1]], target: null, transition: null, overrides: [], serial: 0, wind: { weights: [['w1', 1]], transition: null, patches: [['w1', { strength: 99 }]], target: 'w1', serial: 1 } })).toMatch(/strength/);
  });
});
