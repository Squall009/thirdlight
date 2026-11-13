import { describe, expect, it } from 'vitest';

import { lodLevelOf, lodLevelStep, lodSwitchMargin, type LodLevelAcc } from './lod-level';
import type { ScalarOps } from './scalar-ops';

/** The rule as stated: the last level whose switch (and every one before it) was reached, a shown level's switch nearer by the hysteresis share. */
function stated(switches: readonly number[], d: number, scale: number, current: number, h: number): number {
  let level = 0;
  for (let k = 1; k < switches.length; k += 1) {
    const at = switches[k]! * scale * (current === k ? 1 - h : 1);
    if (d < at) break;
    level = k;
  }
  return level;
}

/** Ops that record every step as text: the same function run on them shows the arithmetic a shader runs. */
const TEXT: ScalarOps<string, string> = {
  n: (v) => String(v),
  add: (a, b) => `(${a}+${b})`,
  sub: (a, b) => `(${a}-${b})`,
  mul: (a, b) => `(${a}*${b})`,
  div: (a, b) => `(${a}/${b})`,
  min: (a, b) => `min(${a},${b})`,
  max: (a, b) => `max(${a},${b})`,
  sqrt: (a) => `sqrt(${a})`,
  floor: (a) => `floor(${a})`,
  lt: (a, b) => `${a}<${b}`,
  select: (c, a, b) => `(${c}?${a}:${b})`,
};

/** Evaluate the recorded text (the shader's arithmetic) with numbers bound. */
function evaluate(expr: string, env: Record<string, number>): number {
  const scope: Record<string, unknown> = { ...env, min: Math.min, max: Math.max, sqrt: Math.sqrt, floor: Math.floor };
  const names = Object.keys(scope);
  return Function(...names, `return ${expr};`)(...names.map((k) => scope[k])) as number;
}

describe('the screen-size level rule', () => {
  const switches = [0, 20, 45, 90, 160];
  it('picks the stated level on a grid of distances, scales, shown levels and hysteresis shares', () => {
    for (const scale of [0.25, 0.5, 1, 1.7, 3])
      for (let d = 0; d < 600; d += 0.73)
        for (const current of [-1, 0, 1, 2, 3, 4])
          for (const h of [0, 0.05, 0.1, 0.3]) expect(lodLevelOf(switches, d, scale, current, h)).toBe(stated(switches, d, scale, current, h));
  });

  it('runs the same arithmetic on numbers and on a shader graph (the recorded steps evaluate to the CPU answer)', () => {
    let acc: LodLevelAcc<string> = { level: '0', open: '1' };
    for (let k = 1; k < switches.length; k += 1) acc = lodLevelStep(TEXT, acc, 'd', `(${switches[k]}*s)`, lodSwitchMargin(TEXT, 'c', String(k), 'h'));
    for (const s of [0.5, 1, 2])
      for (let d = 0; d < 400; d += 3.1)
        for (const c of [-1, 0, 1, 2, 3])
          for (const h of [0, 0.1]) expect(evaluate(acc.level, { d, s, c, h })).toBe(lodLevelOf(switches, d, s, c, h));
  });

  it('holds a shown level until the hysteresis share nearer, then switches back; never on a first pick', () => {
    const h = 0.1;
    // Walking out: level 1 from 20 m.
    expect(lodLevelOf(switches, 19.9, 1, 0, h)).toBe(0);
    expect(lodLevelOf(switches, 20, 1, 0, h)).toBe(1);
    // Walking back with level 1 shown: kept down to 18 m.
    expect(lodLevelOf(switches, 18.5, 1, 1, h)).toBe(1);
    expect(lodLevelOf(switches, 17.9, 1, 1, h)).toBe(0);
    // A first pick (none shown) has no margin.
    expect(lodLevelOf(switches, 18.5, 1, -1, h)).toBe(0);
    // A larger copy switches farther away (its switch distances scale with it).
    expect(lodLevelOf(switches, 30, 2, -1, 0)).toBe(0);
    expect(lodLevelOf(switches, 40, 2, -1, 0)).toBe(1);
  });

  it('draws the only level of a model with one', () => {
    expect(lodLevelOf([0], 1e6, 1, 0, 0.5)).toBe(0);
  });
});
