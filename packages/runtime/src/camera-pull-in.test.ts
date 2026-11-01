/**
 * Pull-in: the state machine's timing (in, hold, out, a zoom at rest) and a
 * follow camera driven by the camera brain through a world of boxes — along a
 * wall and through a doorway, a pillar swung in — whose sphere is never left
 * overlapping a box at any step, whose drawn frames never slide through one,
 * and which comes back out to its distance after the hold and the ease.
 */
import { describe, expect, it } from 'vitest';

import { CameraBrain, type CameraWorld, type VirtualCameraData } from './camera-brain';
import { newPullIn, stepPullIn } from './camera-pull-in';
import { orbitOffset, type V3 } from './camera-rig';

const HZ = 60;
const TIMES = { inTime: 0.1, holdTime: 0.3, outTime: 0.6 };
const free = (): boolean => false;

describe('pull-in state machine', () => {
  it('moves in at the in speed, holds once clear, then eases out over the out time', () => {
    const st = newPullIn();
    expect(stepPullIn(st, 6, 99, free, TIMES, HZ)).toBe(6);
    // An occluder at 3 m: in at 6 m / 0.1 s = 1 m a step, not past it.
    const ins = [1, 2, 3, 4].map(() => stepPullIn(st, 6, 3, free, TIMES, HZ));
    expect(ins.map((d) => +d.toFixed(9))).toEqual([5, 4, 3, 3]);
    expect(st.phase).toBe('in');
    // Clear again: held for round(0.3 × 60) = 18 steps (the last one starts the ease).
    const held: number[] = [];
    for (let i = 0; i < 17; i += 1) held.push(stepPullIn(st, 6, 99, free, TIMES, HZ));
    expect(held.every((d) => d === 3)).toBe(true);
    expect(st.phase).toBe('hold');
    // Eased out over 36 steps: slow at the start and at the end, monotonic, at 6 on the last.
    const out: number[] = [];
    for (let i = 0; i < 36; i += 1) out.push(stepPullIn(st, 6, 99, free, TIMES, HZ));
    expect(out[0]).toBeGreaterThan(3);
    expect(out[0]! - 3).toBeLessThan(out[18]! - out[17]!);
    for (let i = 1; i < out.length; i += 1) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]!);
    expect(out[35]).toBe(6);
    expect(st.phase).toBe('rest');
  });

  it('never moves into a collider: a move that starts in or crosses one goes to the clear distance as a cut', () => {
    const st = newPullIn();
    stepPullIn(st, 6, 99, free, TIMES, HZ);
    const asked: [number, number][] = [];
    const d = stepPullIn(st, 6, 2, (from, to) => (asked.push([from, to]), true), TIMES, HZ);
    expect(asked).toEqual([[6, 5]]);
    expect(d).toBe(2);
    expect(st.cut).toBe(true);
    // The next step is not a cut.
    stepPullIn(st, 6, 2, free, TIMES, HZ);
    expect(st.cut).toBe(false);
  });

  it('a zoom at rest is followed at once; an in time of 0 snaps; the out may narrow on the way', () => {
    const st = newPullIn();
    stepPullIn(st, 4, 99, free, TIMES, HZ);
    expect(stepPullIn(st, 5, 99, free, TIMES, HZ)).toBe(5);
    expect(st.phase).toBe('rest');
    const snap = { ...TIMES, inTime: 0, holdTime: 0 };
    expect(stepPullIn(st, 5, 1, free, snap, HZ)).toBe(1);
    // Easing out toward 5, a new occluder at 2 holds it there.
    for (let i = 0; i < 20; i += 1) stepPullIn(st, 5, 99, free, snap, HZ);
    const mid = st.dist!;
    expect(mid).toBeGreaterThan(2);
    expect(stepPullIn(st, 5, 2, free, snap, HZ)).toBe(2);
  });
});

/** An axis-aligned box: min and max corners. */
type Box = readonly [V3, V3];

/** The distance from a point to a box (0 inside). */
function boxDistance(p: readonly number[], [lo, hi]: Box): number {
  let s = 0;
  for (let k = 0; k < 3; k += 1) {
    const d = Math.max(lo[k]! - p[k]!, 0, p[k]! - hi[k]!);
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Where a ray enters a box (null: it misses, or starts inside). */
function rayBox(o: readonly number[], d: readonly number[], [lo, hi]: Box): number | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let k = 0; k < 3; k += 1) {
    if (Math.abs(d[k]!) < 1e-12) {
      if (o[k]! < lo[k]! || o[k]! > hi[k]!) return null;
      continue;
    }
    const a = (lo[k]! - o[k]!) / d[k]!;
    const b = (hi[k]! - o[k]!) / d[k]!;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 >= t0 && t0 > 0 ? t0 : null;
}

/**
 * A world of boxes. The sphere cast is the ray against each box grown by the
 * radius (it stops at or before the true contact, as a physics cast stops at
 * the contact); a box the sphere starts in does not stop it.
 */
function boxWorld(boxes: () => readonly Box[], positions: Record<string, V3>): CameraWorld {
  return {
    worldOf: (id, p, r) => {
      const at = positions[id];
      if (at === undefined) return false;
      for (let k = 0; k < 3; k += 1) p[k] = at[k]!;
      r[0] = 0;
      r[1] = 0;
      r[2] = 0;
      r[3] = 1;
      return true;
    },
    castSphere: (o, d, radius, max) => {
      let best: number | null = null;
      for (const [lo, hi] of boxes()) {
        const grown: Box = [[lo[0] - radius, lo[1] - radius, lo[2] - radius], [hi[0] + radius, hi[1] + radius, hi[2] + radius]];
        const t = rayBox(o, d, grown);
        if (t !== null && t <= max && (best === null || t < best)) best = t;
      }
      return best === null ? null : { distance: best };
    },
    sphereOverlaps: (c, radius) => boxes().some((b) => boxDistance(c, b) < radius),
    raycast: (o, d, max) => {
      const hits = boxes().map((b) => rayBox(o, d, b)).filter((t): t is number => t !== null && t <= max);
      return hits.length === 0 ? null : { distance: Math.min(...hits) };
    },
  };
}

const BASE = { position: [0, 2, 10], rotation: [0, 0, 0, 1] };
const LENS = { fovY: 60, near: 0.1, far: 200 };
const RADIUS = 0.3;

describe('a follow camera pulled in by the brain', () => {
  it('along a wall and through a doorway: never inside a box, pulled in and back out after the hold and the ease', () => {
    // A wall along the walk (on the camera's side), then a cross wall at x 8 with a doorway (z −0.6…0.6, 2.2 m high).
    const T = 0.2;
    const boxes: Box[] = [
      [[-2, 0, -1.6], [6, 3, -1.6 + T]],
      [[8, 0, -10], [8 + T, 3, -0.6]],
      [[8, 0, 0.6], [8 + T, 3, 10]],
      [[8, 2.2, -0.6], [8 + T, 3, 0.6]],
    ];
    const hero: V3 = [0, 1.6, 0];
    const w = boxWorld(() => boxes, { hero });
    // Behind the walker (−X), a little to the wall's side (−Z) and above.
    const data: VirtualCameraData = { rig: 'follow', target: 'hero', distance: 4, yaw: -110, pitch: 15, collisionRadius: RADIUS };
    const b = new CameraBrain(HZ, LENS);
    b.add([{ id: 'cam', components: { virtualCamera: data } }]);
    const off = orbitOffset(-110, 15, 1);
    const distanceOf = (): number => {
      const p = b.view().position;
      return Math.hypot(p[0] - hero[0], p[1] - hero[1], p[2] - hero[2]);
    };
    const pos: number[] = [0, 0, 0];
    const rot: number[] = [0, 0, 0, 1];
    let pulled = 0;
    let worst = Infinity;
    const trace: number[] = [];
    // Walk at 1.5 m/s along the wall and through the doorway to x 14, then stand.
    for (let i = 0; i < 12 * HZ; i += 1) {
      hero[0] = Math.min(14, (1.5 * i) / HZ);
      b.step(BASE, null, w);
      const d = distanceOf();
      trace.push(d);
      if (d < 4 - 1e-6) pulled += 1;
      // The step's pose and the frames drawn between it and the last.
      for (const a of [0.25, 0.5, 0.75, 1]) {
        b.readInterpolated(a, pos, rot);
        for (const box of boxes) worst = Math.min(worst, boxDistance(pos, box));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(RADIUS - 1e-9);
    expect(pulled).toBeGreaterThan(HZ);
    // Standing past the doorway with the way back clear: out to 4 m and at rest.
    expect(trace[trace.length - 1]).toBeCloseTo(4, 9);
    // The camera sits on its orbit line all the time.
    const p = b.view().position;
    const along = [(p[0] - hero[0]) / 4, (p[1] - hero[1]) / 4, (p[2] - hero[2]) / 4];
    for (let k = 0; k < 3; k += 1) expect(along[k]).toBeCloseTo(off[k]!, 9);
  });

  it('a pillar swung in between: a cut in front of it whatever the in time, held, then eased out over the out time', () => {
    const hero: V3 = [0, 1, 0];
    let pillar: Box[] = [];
    const w = boxWorld(() => pillar, { hero });
    const b = new CameraBrain(HZ, LENS);
    b.add([{ id: 'cam', components: { virtualCamera: { rig: 'follow', target: 'hero', distance: 6, pitch: 0, collisionRadius: RADIUS, pullInTime: 0.5, pullHoldTime: 0.5, pullOutTime: 1 } } }]);
    for (let i = 0; i < 5; i += 1) b.step(BASE, null, w);
    expect(b.view().position[2]).toBeCloseTo(6, 12);
    // A pillar 1 m thick at z 2.5…3.5, between the camera and its target: in front of it at once (2.5 − 0.3), no frame in between.
    pillar = [[[-1, 0, 2.5], [1, 3, 3.5]]];
    b.step(BASE, null, w);
    expect(b.view().position[2]).toBeCloseTo(2.2, 9);
    const pos: number[] = [0, 0, 0];
    b.readInterpolated(0.5, pos, [0, 0, 0, 1]);
    expect(pos[2]).toBeCloseTo(2.2, 9);
    // Gone: held 0.5 s, then out over 1 s.
    pillar = [];
    // (The hold's last step is the ease's first.)
    for (let i = 0; i < 29; i += 1) b.step(BASE, null, w);
    expect(b.view().position[2]).toBeCloseTo(2.2, 9);
    for (let i = 0; i < 30; i += 1) b.step(BASE, null, w);
    expect(b.view().position[2]).toBeCloseTo(2.2 + (6 - 2.2) / 2, 9);
    for (let i = 0; i < 31; i += 1) b.step(BASE, null, w);
    expect(b.view().position[2]).toBeCloseTo(6, 12);
  });

  it('occlusion none sits at its distance; see-through says so in the view; a blend takes the incoming mode at its midpoint', () => {
    const hero: V3 = [0, 1, 0];
    const wall: Box[] = [[[-5, 0, 2], [5, 3, 2.4]]];
    const w = boxWorld(() => wall, { hero });
    const b = new CameraBrain(HZ, LENS, () => undefined, true);
    b.add([
      { id: 'pull', components: { virtualCamera: { rig: 'follow', target: 'hero', distance: 6, pitch: 0, occlusion: 'pullIn', priority: 2 } } },
      { id: 'none', components: { virtualCamera: { rig: 'follow', target: 'hero', distance: 6, pitch: 0, occlusion: 'none', priority: 1 } } },
      // No choice in a project whose see-through setting is on: see-through.
      { id: 'room', components: { virtualCamera: { rig: 'fixed', target: 'hero', priority: 0, blend: 'linear', blendTime: 1 } } },
    ]);
    b.step(BASE, null, w);
    expect(b.view().occlusion).toBe('pullIn');
    expect(b.view().seeThroughLoaded).toBe(true);
    expect(b.view().position[2]).toBeCloseTo(2 - 0.2, 9);
    b.deactivate('pull', { blend: 'cut' });
    b.step(BASE, null, w);
    expect(b.view().occlusion).toBe('none');
    expect(b.view().position[2]).toBeCloseTo(6, 12);
    b.deactivate('none');
    const modes: (string | undefined)[] = [];
    for (let i = 0; i < HZ; i += 1) {
      b.step(BASE, null, w);
      modes.push(b.view().occlusion);
    }
    expect(modes.indexOf('seeThrough')).toBe(HZ / 2 - 1);
    expect(modes.slice(0, HZ / 2 - 1).every((m) => m === 'none')).toBe(true);
  });
});
