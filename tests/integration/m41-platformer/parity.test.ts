/**
 * The parity suite: the 3D controller's arcade profile, locked to a plane,
 * against the 2D platformer controller's reference traces, case by case,
 * within tolerances a player cannot feel (`PARITY`): every key event (a
 * change of grounding or state: a take-off, a landing, grabbing a wall or a
 * ladder) on the same step and within 1 cm; every step within 1.5 cm of the
 * 2D path a step either side; the controller's own velocity equal at every
 * step; and per measure — jump apex and air time, run speed, slopes, stair
 * timing, wall moves, climb, one-way, mover carry — the numbers below. Where
 * a case differs for a reason of the 2D port's own (not the rules), the case
 * says so and how it is held instead.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { CASES, PARITY, pathGap, readTrace, recordCase, SETTINGS, STAND_Y, type TraceRow } from './cases';


/** Steps where a case's staged velocity may differ from the 2D's, and why. */
const VELOCITY_EXCEPT: Readonly<Record<string, readonly [number, number, string]>> = {
  // Letting go on the last stair's edge: the slide down it starts a step later (its ride ended 1.6 cm behind).
  stairs: [250, 256, 'edge slide'],
  // Walking off a rising lift: the 2D runtime loses the lift as ground a step before the edge and scoops the
  // character up by the mover's push; the 3D carries it to the edge. Same rise in total (the path holds it to 1.4 mm).
  movers: [567, 571, 'lift edge'],
};

type Rows = readonly TraceRow[];
const got = new Map<string, Rows>();
const ref = (id: string): Rows => readTrace(id).rows;

beforeAll(async () => {
  for (const c of CASES) {
    const r = await recordCase(c, 3, { profile: 'arcade', plane: { axis: 'z', origin: 0 } });
    expect(r.errors, c.id).toEqual([]);
    got.set(c.id, r.rows);
  }
}, 120_000);

/** Key events: each step whose grounding or state differs from the step before. */
function events(rows: Rows): { at: number; kind: string }[] {
  const out: { at: number; kind: string }[] = [];
  for (let i = 1; i < rows.length; i += 1) if (rows[i]![4] !== rows[i - 1]![4] || rows[i]![5] !== rows[i - 1]![5]) out.push({ at: i, kind: `${rows[i - 1]![5]}${rows[i]![5]}` });
  return out;
}

const dist = (a: TraceRow, b: TraceRow): number => Math.hypot(a[0] - b[0], a[1] - b[1]);


const peak = (rows: Rows, from: number, to: number): number => Math.max(...rows.slice(from, to).map((r) => r[1]));
const firstAt = (rows: Rows, test: (r: TraceRow, i: number) => boolean, from = 0): number => rows.findIndex((r, i) => i >= from && test(r, i));

describe('every case: events, path and velocity', () => {
  for (const c of CASES) {
    // The sideways platform's own rule is below (the 2D port's carry stalls there).
    const sideways = c.id === 'side-platform';
    it(`${c.id}: the same key events on the same step, each within ${PARITY.eventPosition * 100} cm`, () => {
      const a = events(ref(c.id));
      const b = events(got.get(c.id)!);
      expect(b.map((e) => e.kind)).toEqual(a.map((e) => e.kind));
      for (let k = 0; k < a.length; k += 1) {
        expect(Math.abs(b[k]!.at - a[k]!.at), `${c.id} event ${k}`).toBeLessThanOrEqual(PARITY.eventSteps);
        const gap = sideways ? Math.abs(got.get(c.id)![b[k]!.at]![1] - ref(c.id)[a[k]!.at]![1]) : dist(got.get(c.id)![b[k]!.at]!, ref(c.id)[a[k]!.at]!);
        expect(gap, `${c.id} event ${k} at step ${a[k]!.at}`).toBeLessThanOrEqual(PARITY.eventPosition);
      }
    });
    it(`${c.id}: every step within ${PARITY.path * 100} cm of the 2D path and with the 2D's own velocity`, () => {
      const r = ref(c.id);
      const g = got.get(c.id)!;
      const except = VELOCITY_EXCEPT[c.id];
      for (let i = 0; i < r.length; i += 1) {
        const settling = c.id === 'stairs' && i >= 250;
        if (!sideways) expect(pathGap(g[i]!, r, i), `${c.id} step ${i}`).toBeLessThanOrEqual(settling ? PARITY.stairRest : PARITY.path);
        else expect(Math.abs(g[i]![1] - r[i]![1]), `${c.id} step ${i}`).toBeLessThanOrEqual(PARITY.path);
        if (except !== undefined && i >= except[0] && i < except[1]) continue;
        for (const k of [2, 3] as const) expect(Math.abs(g[i]![k] - r[i]![k]), `${c.id} step ${i} column ${k}`).toBeLessThanOrEqual(PARITY.velocity);
      }
    });
  }
});

describe('per measure', () => {
  it('jump: the full jump\'s and the hop\'s apex within 1 cm, the same air time', () => {
    for (const [from, to] of [[20, 150], [180, 300]] as const) {
      expect(Math.abs(peak(got.get('jump-apex')!, from, to) - peak(ref('jump-apex'), from, to))).toBeLessThanOrEqual(PARITY.measure);
      const air = (rows: Rows): number => firstAt(rows, (r) => r[4] === 1, firstAt(rows, (r) => r[4] === 0, from)) - firstAt(rows, (r) => r[4] === 0, from);
      expect(air(got.get('jump-apex')!)).toBe(air(ref('jump-apex')));
    }
  });

  it('run: the run speed, reached and left on the same steps', () => {
    const at = (rows: Rows, v: number): number => firstAt(rows, (r) => r[2] === v);
    for (const v of [SETTINGS.run_speed, -SETTINGS.run_speed]) expect(at(got.get('run')!, v)).toBe(at(ref('run'), v));
    expect(firstAt(got.get('run')!, (r, i) => i > 100 && r[2] === 0)).toBe(firstAt(ref('run'), (r, i) => i > 100 && r[2] === 0));
  });

  it('slopes: the stop on the 25° ramp and the stop at the foot of the 55° ramp within 1 cm; the 40° slide comes to rest on the same step', () => {
    for (const i of [129, 419]) expect(dist(got.get('slopes')![i]!, ref('slopes')[i]!)).toBeLessThanOrEqual(PARITY.measure);
    const rest = (rows: Rows): number => firstAt(rows, (r, i) => i > 0 && r[2] === 0 && r[1] < STAND_Y + 0.01);
    expect(Math.abs(rest(got.get('slope-slide')!) - rest(ref('slope-slide')))).toBeLessThanOrEqual(PARITY.eventSteps);
    expect(dist(got.get('slope-slide')!.at(-1)!, ref('slope-slide').at(-1)!)).toBeLessThanOrEqual(PARITY.measure);
  });

  it('stairs: each tread reached on the way up and down on the same step (±1); the rest within 5 cm', () => {
    const treads = (rows: Rows): number[] => {
      const up = [1, 2, 3, 4].map((k) => firstAt(rows, (r) => r[1] >= STAND_Y + 0.2 * k - 0.002));
      const top = up[3]!;
      return [...up, ...[3, 2, 1, 0].map((k) => firstAt(rows, (r) => r[1] <= STAND_Y + 0.2 * k + 0.002, top))];
    };
    const a = treads(ref('stairs'));
    const b = treads(got.get('stairs')!);
    expect(a.every((s) => s > 0)).toBe(true);
    for (let k = 0; k < a.length; k += 1) expect(Math.abs(b[k]! - a[k]!), `tread ${k}`).toBeLessThanOrEqual(PARITY.eventSteps);
    expect(dist(got.get('stairs')!.at(-1)!, ref('stairs').at(-1)!)).toBeLessThanOrEqual(PARITY.stairRest);
  });

  it('walls: the slide at the wall slide speed on the same steps, the wall jump on the same step', () => {
    const sliding = (rows: Rows): number[] => rows.flatMap((r, i) => (r[5] === 'w' && r[3] === -2 ? [i] : []));
    expect(sliding(got.get('walls')!)).toEqual(sliding(ref('walls')));
    const kick = (rows: Rows): number => firstAt(rows, (r) => r[2] < 0 && r[3] > 8);
    expect(kick(got.get('walls')!)).toBe(kick(ref('walls')));
  });

  it('climb: on the ladder on the same steps, its highest point within 1 cm', () => {
    const on = (rows: Rows): number[] => rows.flatMap((r, i) => (r[5] === 'c' ? [i] : []));
    expect(on(got.get('climb')!)).toEqual(on(ref('climb')));
    expect(Math.abs(peak(got.get('climb')!, 0, 520) - peak(ref('climb'), 0, 520))).toBeLessThanOrEqual(PARITY.measure);
  });

  it('one-way: up through the shelf, on it within 1 cm, dropped through and off its end on the same steps', () => {
    const g = got.get('one-way')!;
    const r = ref('one-way');
    for (let i = 120; i < 155; i += 1) expect(Math.abs(g[i]![1] - r[i]![1])).toBeLessThanOrEqual(PARITY.measure);
    expect(events(g).map((e) => e.at)).toEqual(events(r).map((e) => e.at));
  });

  it('movers: the lift carries it to the same top (1 cm); it walks off and lands on the same step', () => {
    expect(Math.abs(peak(got.get('movers')!, 0, 260) - peak(ref('movers'), 0, 260))).toBeLessThanOrEqual(PARITY.measure);
    const landed = (rows: Rows): number => firstAt(rows, (r) => r[4] === 1, 570);
    expect(landed(got.get('movers')!)).toBe(landed(ref('movers')));
    expect(dist(got.get('movers')![landed(ref('movers'))]!, ref('movers')[landed(ref('movers'))]!)).toBeLessThanOrEqual(PARITY.measure);
  });

  it('sideways platform: carried on every step the 2D was (and on the steps the 2D port stalled), within those stalls of the 2D', () => {
    // The 2D port's carry stalls on a sliding platform (Rapier reads the platform's top as tilted within its
    // skin and stops the move; here 4 steps, 33 mm, made up by one push later), which the 3D port's sweep fixes.
    // So the 3D is held to moving with the platform (1 m/s) on every step the 2D moved, and to the 2D's
    // position within those 4 steps.
    const g = got.get('side-platform')!;
    const r = ref('side-platform');
    const platformStep = 1 / 120;
    for (let i = 1; i < r.length; i += 1) {
      if (g[i]![4] !== 1 || r[i]![4] !== 1 || g[i - 1]![4] !== 1 || r[i - 1]![4] !== 1) continue;
      const d2 = Math.abs(r[i]![0] - r[i - 1]![0]);
      expect(Math.abs(g[i]![0] - g[i - 1]![0]), `step ${i}`).toBeGreaterThanOrEqual(Math.min(d2, platformStep) - 1e-6);
    }
    for (let i = 0; i < r.length; i += 1) expect(Math.abs(g[i]![0] - r[i]![0]), `step ${i}`).toBeLessThanOrEqual(4 * platformStep + 1e-6);
  });

  it('coyote time and the jump buffer: both jumps start on the same steps', () => {
    const starts = (rows: Rows): number[] => rows.flatMap((r, i) => (r[3] > 9 && (rows[i - 1]?.[3] ?? 0) <= 9 ? [i] : []));
    expect(starts(got.get('coyote-buffer')!)).toEqual(starts(ref('coyote-buffer')));
    expect(starts(ref('coyote-buffer')).length).toBe(2);
  });
});
