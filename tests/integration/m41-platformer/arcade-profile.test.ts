/**
 * The 3D character controller's arcade movement profile (the 2D platformer controller's rules) with real
 * Rapier through the production game host: every platformer case (`cases.ts`)
 * run by a plane-locked 3D character shows what the 2D controller's reference
 * trace shows (autostep, jump buffer and coyote time, wall slide and wall
 * jump, a ladder, a one-way shelf with drop-through, a lift and a sideways
 * platform carrying it); the same level on the plane x = 0 gives the same
 * in-plane trace as on z = 0; free in 3D (no plane) a character moving only
 * along X matches the plane-locked one (down, which drops it through a
 * one-way shelf, is then an action and not a walk in depth); the profile does not turn the
 * character, and it reads the 2D controller's own tuning fields. How close
 * each case comes to its reference trace is the parity suite's.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { CASES, recordCase, type TraceRow } from './cases';
import { expectOutcomes } from './outcomes';

type Any = any;
const ARCADE = { profile: 'arcade' };
const ON_Z = { ...ARCADE, plane: { axis: 'z', origin: 0 } };
const ON_X = { ...ARCADE, plane: { axis: 'x', origin: 0 } };

/** Where two Rapier 3D runs of the same moves may differ (m): the sweeps settle a few millimetres apart on contact (as the 2D and 3D ports do). */
const TOLERANCE = 0.01;

const worst = (a: readonly TraceRow[], b: readonly TraceRow[]): number => Math.max(...a.map((r, i) => Math.max(Math.abs(r[0] - b[i]![0]), Math.abs(r[1] - b[i]![1]))));

const onZ = new Map<string, { rows: TraceRow[]; depth: number[]; errors: Any[] }>();

beforeAll(async () => {
  for (const c of CASES) onZ.set(c.id, await recordCase(c, ON_Z));
}, 120_000);

describe('the arcade profile on a Z plane', () => {
  it('runs every case without an error and never leaves its plane', () => {
    for (const [id, r] of onZ) {
      expect(r.errors, id).toEqual([]);
      expect(r.depth.every((d) => d === 0), id).toBe(true);
    }
  });
  expectOutcomes((id) => onZ.get(id)!.rows);
});

describe('the arcade profile in either mode', () => {
  it('on the plane x = 0 the same level and moves give the same in-plane trace as on z = 0', async () => {
    for (const c of CASES) {
      const id = c.id;
      const r = await recordCase(c, ON_X, 'x');
      expect(r.errors, id).toEqual([]);
      expect(r.depth.every((d) => d === 0), id).toBe(true);
      // (Measured: at most 10.2 mm, on the 25° ramp: the prism turned onto the other plane settles the capsule a hair apart.)
      expect(worst(r.rows, onZ.get(id)!.rows), id).toBeLessThan(2 * TOLERANCE);
    }
  }, 60_000);

  it('free in 3D, moving only along X, it matches the plane-locked character', async () => {
    // (A free character's resting press onto the ground moves ledge, stair and run timing; the plane-locked one is the parity suite's.)
    for (const id of ['jump-apex', 'walls', 'slope-slide', 'movers', 'climb', 'one-way']) {
      const c = CASES.find((x) => x.id === id)!;
      const r = await recordCase(c, ARCADE);
      expect(r.errors, id).toEqual([]);
      expect(worst(r.rows, onZ.get(id)!.rows), id).toBeLessThan(2 * TOLERANCE);
      expect(Math.max(...r.depth.map(Math.abs)), id).toBeLessThan(TOLERANCE);
    }
  }, 60_000);

  it('the character profile on the same run plays differently (walk speed, air control): the profile is what moves it', async () => {
    const c = CASES.find((x) => x.id === 'run')!;
    const r = await recordCase(c, { plane: { axis: 'z', origin: 0 }, moveFrame: 'world' });
    expect(Math.max(...r.rows.map((x) => x[2]))).toBeLessThan(onZ.get('run')!.rows.reduce((m, x) => Math.max(m, x[2]), 0));
  }, 30_000);

  it('without autostep the stair is a wall it stops at; with it, it climbs (the 2D fields, not stepHeight)', async () => {
    const c = CASES.find((x) => x.id === 'stairs')!;
    const r = await recordCase({ ...c, controller: { ...c.controller, autostep: false } }, { ...ON_Z, stepHeight: 0.3 });
    expect(r.errors).toEqual([]);
    expect(Math.max(...r.rows.map((x) => x[1]))).toBeLessThan(0.6);
  }, 30_000);
});
