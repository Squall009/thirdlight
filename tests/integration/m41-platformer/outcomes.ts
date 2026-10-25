/**
 * What each platformer case shows, checked on a run's rows: the full jump
 * peaks near v²/2g and above the hop, the run reaches the run speed, the
 * ladder is climbed, the shelf is stood on and dropped through, the lift
 * carries the character, the wall slide holds the fall, the stairs are
 * climbed, the slope slides a resting character down, and a jump pressed in
 * the coyote window or the buffer jumps. The reference traces and the
 * arcade profile's runs are held to the same checks.
 */
import { expect, it } from 'vitest';

import { SETTINGS, STAND_Y, type TraceRow } from './cases';

const peak = (rows: readonly TraceRow[], from: number, to: number): number => Math.max(...rows.slice(from, to).map((r) => r[1]));

/** Declare the checks (inside a describe) over `t`, the rows of a case by id. */
export function expectOutcomes(t: (id: string) => readonly TraceRow[]): void {
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
  it('a wall jump pushes off the wall; a sideways platform carries the character standing on it', () => {
    const walls = t('walls');
    const kick = walls.findIndex((r) => r[2] < 0 && r[3] > 8);
    expect(kick).toBeGreaterThan(0);
    expect(walls[kick - 1]![5]).toBe('w');
    const side = t('side-platform');
    expect(side.slice(0, 110).every((r) => r[4] === 1)).toBe(true);
    expect(side[110]![0] - side[0]![0]).toBeGreaterThan(0.85);
    expect(side[300]![4]).toBe(1);
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
}
