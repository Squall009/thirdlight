/**
 * The 2D platformer controller's reference traces: each case of `cases.ts`
 * run through the production game host on the 2D backend reproduces its
 * stored trace exactly (the traces are deterministic, so the platformer
 * profile of the 3D controller is measured against fixed numbers).
 * `TL_RECORD_TRACES=1` re-records them (only ever from the 2D controller).
 * The traces also pin what each case is about: the full jump peaks above the
 * hop, the run reaches the run speed, the ladder is climbed, the shelf is
 * stood on and dropped through, the lift carries the character.
 */
import { describe, expect, it } from 'vitest';

import { CASES, readTrace, recordCase, traceFile, writeTrace, STAND_Y, SETTINGS, type TraceRow } from './cases';

const RECORD = process.env['TL_RECORD_TRACES'] === '1';

const peak = (rows: readonly TraceRow[], from: number, to: number): number => Math.max(...rows.slice(from, to).map((r) => r[1]));

describe('the 2D platformer controller reproduces its reference traces', () => {
  for (const c of CASES) {
    it(c.id, async () => {
      const { rows, errors } = await recordCase(c, 2);
      expect(errors).toEqual([]);
      if (RECORD) writeTrace(traceFile(c, rows));
      const stored = readTrace(c.id);
      expect(stored.rows.length).toBe(c.steps);
      const first = rows.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(stored.rows[i]));
      expect(first, `first differing step ${first}: ${JSON.stringify(rows[first])} vs ${JSON.stringify(stored.rows[first])}`).toBe(-1);
    }, 60_000);
  }
});

describe('what the reference traces show', () => {
  const t = (id: string) => readTrace(id).rows;
  it('a held jump peaks higher than a hop, and both land', () => {
    const rows = t('jump-apex');
    const full = peak(rows, 20, 150) - STAND_Y;
    const hop = peak(rows, 180, 300) - STAND_Y;
    // v² / 2g with the 9.9 m/s jump and 19.62 m/s² gravity (2.50 m), within a step's integration.
    expect(full).toBeGreaterThan(2.4);
    expect(full).toBeLessThan(2.6);
    expect(hop).toBeLessThan(full / 2);
    expect(rows[170]![4]).toBe(1);
    expect(rows[299]![4]).toBe(1);
  });
  it('the run reaches the run speed and stops', () => {
    const rows = t('run');
    expect(Math.max(...rows.map((r) => r[2]))).toBe(SETTINGS.run_speed);
    expect(Math.min(...rows.map((r) => r[2]))).toBe(-SETTINGS.run_speed);
    expect(rows[299]![2]).toBe(0);
  });
  it('the ladder is climbed, the shelf stood on and dropped through, the lift rides up', () => {
    expect(t('climb').some((r) => r[5] === 'c' && r[1] > 4)).toBe(true);
    const oneWay = t('one-way');
    expect(oneWay.slice(120, 155).every((r) => Math.abs(r[1] - (1.7 + STAND_Y)) < 0.01 && r[4] === 1)).toBe(true);
    expect(oneWay[220]![1]).toBeCloseTo(STAND_Y, 2);
    expect(peak(t('movers'), 0, 260)).toBeGreaterThan(2 + STAND_Y);
    expect(t('walls').some((r) => r[5] === 'w' && r[3] === -2)).toBe(true);
    expect(peak(t('stairs'), 0, 300)).toBeGreaterThan(0.75 + STAND_Y);
    expect(t('slope-slide').at(-1)![1]).toBeCloseTo(STAND_Y, 1);
  });
  it('a jump pressed just after leaving a ledge (coyote time) and just before landing (the buffer) both jump', () => {
    const rows = t('coyote-buffer');
    const left = rows.findIndex((r) => r[4] === 0);
    expect(left).toBeGreaterThan(80);
    expect(left).toBeLessThan(101);
    expect(rows[101]![3]).toBeGreaterThan(9);
    const landed = rows.findIndex((r, i) => i > 150 && r[4] === 1);
    expect(landed).toBeGreaterThan(202);
    expect(rows.slice(landed, landed + 3).some((r) => r[3] > 9)).toBe(true);
  });
});
