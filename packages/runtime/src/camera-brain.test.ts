/**
 * Phase 23.4: the camera brain and its rig maths — priority resolution,
 * blends (cut, linear, eased), each rig's pose, snapped turns on input, the
 * rail, seeded shake, collision pull-in and screen↔world projection.
 */
import { describe, expect, it } from 'vitest';

import type { ActionFrame } from './actions';
import { CameraBrain, type CameraWorld, type VirtualCameraData } from './camera-brain';
import { orbitOffset, quatFromYawPitch, rotateVec, samplePath, pointOnPath, screenToRay, worldToScreen, yawPitchOf, newPose } from './camera-rig';

const HZ = 120;
const BASE = { position: [0, 2, 10], rotation: [0, 0, 0, 1] };
const LENS = { fovY: 60, near: 0.1, far: 100 };

function world(positions: Record<string, number[]>, raycast?: CameraWorld['raycast']): CameraWorld {
  return {
    worldOf: (id, p, r) => {
      const at = positions[id];
      if (at === undefined) return false;
      p[0] = at[0]!;
      p[1] = at[1]!;
      p[2] = at[2]!;
      r[0] = 0;
      r[1] = 0;
      r[2] = 0;
      r[3] = 1;
      return true;
    },
    ...(raycast !== undefined ? { raycast } : {}),
  };
}

const cam = (id: string, data: VirtualCameraData) => ({ id, components: { transform: {}, virtualCamera: data } });
const frame = (stepIndex: number, actions: ActionFrame['actions'] = {}): ActionFrame => ({ stepIndex, moveX: 0, jump: 'none', actions });

function run(b: CameraBrain, steps: number, w: CameraWorld, actions?: (i: number) => ActionFrame['actions']): void {
  for (let i = 0; i < steps; i += 1) b.step(BASE, frame(i, actions?.(i)), w);
}

const forward = (q: readonly number[]) => rotateVec(q, 0, 0, -1);
const near = (a: readonly number[], b: readonly number[], digits = 9): void => {
  expect(a.length).toBe(b.length);
  for (let k = 0; k < a.length; k += 1) expect(a[k]).toBeCloseTo(b[k]!, digits);
};

describe('camera rig maths', () => {
  it('a yaw/pitch rotation looks back at the pivot from its orbit offset', () => {
    for (const [yaw, pitch] of [[0, 0], [90, 20], [-135, 60], [30, -15]] as const) {
      const off = orbitOffset(yaw, pitch, 1);
      const f = forward(quatFromYawPitch(yaw, pitch));
      expect(f[0]).toBeCloseTo(-off[0], 12);
      expect(f[1]).toBeCloseTo(-off[1], 12);
      expect(f[2]).toBeCloseTo(-off[2], 12);
      const yp = yawPitchOf(f[0], f[1], f[2])!;
      expect(yp.pitch).toBeCloseTo(pitch, 9);
      expect(((yp.yaw - yaw + 540) % 360) - 180).toBeCloseTo(0, 9);
    }
    // yaw 0 looks down −Z (the default camera), pitch 90 straight down
    expect(forward(quatFromYawPitch(0, 0))).toEqual([0, 0, -1]);
    const down = forward(quatFromYawPitch(0, 90));
    expect(down[1]).toBeCloseTo(-1, 12);
  });

  it('projection: a world point maps to the screen and the screen ray passes back through it', () => {
    const pose = newPose();
    pose.position = [1, 2, 8];
    pose.rotation = quatFromYawPitch(20, 10);
    const p = [3, 1, -2];
    const s = worldToScreen(pose, 16 / 9, p[0]!, p[1]!, p[2]!);
    expect(s.onScreen).toBe(true);
    const ray = screenToRay(pose, 16 / 9, s.x, s.y);
    const at = [0, 1, 2].map((k) => ray.origin[k]! + ray.direction[k]! * s.depth / -rotateVec([-pose.rotation[0], -pose.rotation[1], -pose.rotation[2], pose.rotation[3]], ray.direction[0], ray.direction[1], ray.direction[2])[2]);
    for (let k = 0; k < 3; k += 1) expect(at[k]).toBeCloseTo(p[k]!, 9);
    // the screen centre is straight ahead; behind the camera is off screen
    const c = screenToRay(pose, 1, 0.5, 0.5).direction;
    const f = forward(pose.rotation);
    for (let k = 0; k < 3; k += 1) expect(c[k]).toBeCloseTo(f[k]!, 12);
    expect(worldToScreen(pose, 1, 1, 2, 20).onScreen).toBe(false);
  });

  it('a path is sampled by arc length (straight and smooth)', () => {
    const straight = samplePath([[0, 0, 0], [4, 0, 0], [4, 3, 0]], false, false);
    expect(straight.length).toBeCloseTo(7, 12);
    const p: [number, number, number] = [0, 0, 0];
    const t: [number, number, number] = [0, 0, 0];
    pointOnPath(straight, 0.5, p, t);
    expect(p).toEqual([3.5, 0, 0]);
    pointOnPath(straight, 1, p, t);
    expect(p).toEqual([4, 3, 0]);
    const smooth = samplePath([[0, 0, 0], [4, 0, 0], [4, 3, 0]], false, true);
    pointOnPath(smooth, 0, p, t);
    expect(p).toEqual([0, 0, 0]);
    pointOnPath(smooth, 1, p, t);
    expect(p[0]).toBeCloseTo(4, 12);
    expect(p[1]).toBeCloseTo(3, 12);
    const closed = samplePath([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], true, false);
    expect(closed.length).toBeCloseTo(8, 12);
  });
});

describe('camera brain', () => {
  it('without an enabled virtual camera the view is the scene camera, exactly', () => {
    const b = new CameraBrain(HZ, LENS);
    b.add([cam('vc-a', { rig: 'fixed', enabled: false })]);
    run(b, 3, world({ 'vc-a': [5, 5, 5] }));
    const v = b.view();
    expect(v.live).toBeNull();
    expect(v.position).toEqual([0, 2, 10]);
    expect(v.rotation).toEqual([0, 0, 0, 1]);
    expect(v.fovY).toBe(60);
  });

  it('priority, then the one activated last, then load order', () => {
    const b = new CameraBrain(HZ, LENS);
    b.add([cam('vc-a', { rig: 'fixed' }), cam('vc-b', { rig: 'fixed' }), cam('vc-c', { rig: 'fixed', priority: 5, enabled: false })]);
    const w = world({ 'vc-a': [1, 0, 0], 'vc-b': [2, 0, 0], 'vc-c': [3, 0, 0] });
    run(b, 1, w);
    expect(b.live()).toBe('vc-a');
    b.activate('vc-b');
    run(b, 1, w);
    expect(b.live()).toBe('vc-b');
    b.activate('vc-c');
    run(b, 1, w);
    expect(b.live()).toBe('vc-c');
    b.setPriority('vc-c', -1);
    run(b, 1, w);
    expect(b.live()).toBe('vc-b');
    b.deactivate('vc-b');
    run(b, 1, w);
    expect(b.live()).toBe('vc-a');
    expect(b.activate('nope')).toBe(false);
  });

  it('the first view is a cut; later changes blend: linear, eased and cut, over the incoming camera\'s time', () => {
    const w = world({ 'vc-a': [0, 0, 0], 'vc-b': [12, 0, 0] });
    const make = (blend: 'cut' | 'linear' | 'eased'): CameraBrain => {
      const b = new CameraBrain(HZ, LENS);
      b.add([cam('vc-a', { rig: 'fixed' }), cam('vc-b', { rig: 'fixed', enabled: false, blend, blendTime: 1 })]);
      run(b, 1, w);
      expect(b.view().position[0]).toBe(0);
      expect(b.view().blend).toBeNull();
      b.activate('vc-b');
      return b;
    };
    const lin = make('linear');
    run(lin, 60, w); // half of 1 s at 120 Hz
    expect(lin.view().position[0]).toBeCloseTo(6, 9);
    expect(lin.view().blend).toMatchObject({ from: 'vc-a', style: 'linear' });
    expect(lin.blending()).toBe(true);
    run(lin, 60, w);
    expect(lin.view().position[0]).toBeCloseTo(12, 9);
    expect(lin.blending()).toBe(false);
    const eased = make('eased');
    run(eased, 30, w); // a quarter: smoothstep(0.25) = 0.15625
    expect(eased.view().position[0]).toBeCloseTo(12 * 0.15625, 9);
    run(eased, 30, w);
    expect(eased.view().position[0]).toBeCloseTo(6, 9);
    const cut = make('cut');
    run(cut, 1, w);
    expect(cut.view().position[0]).toBe(12);
    // a script's blend overrides the camera's own
    const over = make('eased');
    over.deactivate('vc-b');
    over.activate('vc-b', { blend: 'cut' });
    run(over, 1, w);
    expect(over.view().position[0]).toBe(12);
  });

  it('back to the scene camera blends over the outgoing camera\'s blend; an interrupted blend continues from the blended view', () => {
    const w = world({ 'vc-a': [0, 2, 0], 'vc-b': [10, 2, 0] });
    const b = new CameraBrain(HZ, LENS);
    b.add([cam('vc-a', { rig: 'fixed', blend: 'linear', blendTime: 0.5 }), cam('vc-b', { rig: 'fixed', enabled: false, blend: 'linear', blendTime: 1 })]);
    run(b, 1, w);
    b.deactivate('vc-a');
    run(b, 30, w); // half of 0.5 s toward the scene camera at x 0 … z 10
    expect(b.live()).toBeNull();
    expect(b.view().position[2]).toBeCloseTo(5, 9);
    b.activate('vc-b');
    run(b, 1, w);
    const x1 = b.view().position[0];
    expect(x1).toBeCloseTo(10 / 120, 6);
    expect(b.view().position[2]).toBeCloseTo(5 * (1 - 1 / 120), 6);
    run(b, 119, w);
    near(b.view().position, [10, 2, 0]);
  });

  it('follow: orbits the target at distance/yaw/pitch, turns and tilts on input within its limits, zooms', () => {
    const b = new CameraBrain(HZ, LENS);
    b.add([cam('vc-f', { rig: 'follow', target: 'hero', targetOffset: [0, 1, 0], distance: 6, yaw: 0, pitch: 30, pitchMax: 45, yawAction: 'look', zoomAction: 'zoom', rotateSpeed: 90, zoomSpeed: 4, maxDistance: 7 })]);
    const w = world({ hero: [1, 0, -2], 'vc-f': [0, 0, 0] });
    run(b, 1, w);
    const off = orbitOffset(0, 30, 6);
    expect(b.view().position[0]).toBeCloseTo(1 + off[0], 12);
    expect(b.view().position[1]).toBeCloseTo(1 + off[1], 12);
    expect(b.view().position[2]).toBeCloseTo(-2 + off[2], 12);
    // A 2D look axis: x turns (right: yaw decreases), y tilts; 1 s at full input.
    run(b, 120, w, () => ({ look: { v: 1, x: 1, y: 1, p: 'held' } }));
    const st = b.get('vc-f')!;
    expect(st.yaw).toBeCloseTo(-90, 6);
    expect(st.pitch).toBe(45); // clamped at pitchMax
    run(b, 120, w, () => ({ zoom: { v: 1, p: 'held' } }));
    expect(b.get('vc-f')!.distance).toBe(7); // clamped at maxDistance
  });

  it('follow: pulled in front of a collider between it and the target (never closer than minDistance)', () => {
    const hits: number[] = [];
    const b = new CameraBrain(HZ, LENS);
    b.add([cam('vc-f', { rig: 'follow', target: 'hero', distance: 8, pitch: 0, collisionRadius: 0.5, minDistance: 1 })]);
    let wall = 3;
    const w = world({ hero: [0, 0, 0] }, (o, d, max) => {
      hits.push(max);
      return wall < max ? { distance: wall } : null;
    });
    run(b, 1, w);
    expect(hits[0]).toBeCloseTo(8.5, 12);
    expect(b.view().position[2]).toBeCloseTo(2.5, 12);
    wall = 0.2;
    run(b, 1, w);
    expect(b.view().position[2]).toBeCloseTo(1, 12);
    wall = 100;
    run(b, 1, w);
    expect(b.view().position[2]).toBeCloseTo(8, 12);
  });

  it('orbitPoint: a press turns one snapped step, eased over turnTime; topDown looks straight down', () => {
    const b = new CameraBrain(HZ, LENS);
    b.add([cam('vc-o', { rig: 'orbitPoint', point: [0, 0, 0], distance: 10, pitch: 45, yaw: 0, yawStep: 90, turnTime: 0.25, turnLeftAction: 'left', turnRightAction: 'right' })]);
    const w = world({ 'vc-o': [0, 0, 0] });
    run(b, 1, w);
    b.step(BASE, frame(1, { left: { v: 1, p: 'pressed' } }), w);
    expect(b.get('vc-o')!.yaw).toBe(90);
    run(b, 14, w, () => ({ left: { v: 1, p: 'held' } })); // held does not turn again
    const mid = yawPitchOf(...(forward(b.view().rotation) as [number, number, number]))!.yaw;
    expect(mid).toBeGreaterThan(30);
    expect(mid).toBeLessThan(60);
    run(b, 30, w);
    const end = forward(b.view().rotation);
    expect(yawPitchOf(end[0], end[1], end[2])!.yaw).toBeCloseTo(90, 9);
    expect(b.view().position[0]).toBeCloseTo(orbitOffset(90, 45, 10)[0], 9);
    b.step(BASE, frame(99, { right: { v: 1, p: 'pressed' } }), w);
    b.step(BASE, frame(100, { right: { v: 1, p: 'released' } }), w);
    b.step(BASE, frame(101, { right: { v: 1, p: 'pressed' } }), w);
    expect(b.get('vc-o')!.yaw).toBe(-90);
    expect(b.turn('vc-o', 2)).toBe(true);
    expect(b.get('vc-o')!.yaw).toBe(90);

    const t = new CameraBrain(HZ, LENS);
    t.add([cam('vc-t', { rig: 'topDown', target: 'hero', distance: 12, yaw: 0 })]);
    run(t, 1, world({ hero: [3, 1, 4], 'vc-t': [0, 0, 0] }));
    near(t.view().position, [3, 13, 4]);
    expect(forward(t.view().rotation)[1]).toBeCloseTo(-1, 12);
  });

  it('fixed looks at its target; rail rides its path at railSpeed and stops at the end', () => {
    const b = new CameraBrain(HZ, LENS);
    b.add([
      cam('vc-x', { rig: 'fixed', target: 'hero' }),
      cam('vc-r', { rig: 'rail', path: 'track', railSpeed: 6, enabled: false }),
      { id: 'track', components: { cameraPath: { points: [[0, 0, 0], [6, 0, 0]], smooth: false } } },
    ]);
    const w = world({ 'vc-x': [0, 5, 5], hero: [0, 0, 0], track: [0, 1, 3], 'vc-r': [0, 0, 0] });
    run(b, 1, w);
    const f = forward(b.view().rotation);
    const n = Math.hypot(0, -5, -5);
    expect(f[1]).toBeCloseTo(-5 / n, 12);
    expect(f[2]).toBeCloseTo(-5 / n, 12);
    b.activate('vc-r', { blend: 'cut' });
    run(b, 1, w);
    expect(b.view().position[0]).toBeCloseTo(6 / 120 / 6 * 6, 12);
    run(b, 59, w);
    expect(b.get('vc-r')!.progress).toBeCloseTo(0.5, 9);
    near(b.view().position, [3, 1, 3]);
    // looking along the path (+X)
    expect(forward(b.view().rotation)[0]).toBeCloseTo(1, 12);
    run(b, 200, w);
    expect(b.get('vc-r')!.progress).toBe(1);
    near(b.view().position, [6, 1, 3]);
  });

  it('shake is seeded: two brains shake alike, it fades out, and it never moves the unshaken blend', () => {
    const make = () => {
      const b = new CameraBrain(HZ, LENS);
      b.add([cam('vc-a', { rig: 'fixed' })]);
      return b;
    };
    const w = world({ 'vc-a': [0, 0, 0] });
    const a = make();
    const c = make();
    run(a, 1, w);
    run(c, 1, w);
    a.shake(0.5, 0.25);
    c.shake(0.5, 0.25);
    const seen: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      a.step(BASE, frame(i), w);
      c.step(BASE, frame(i), w);
      expect(a.view().position).toEqual(c.view().position);
      seen.push(Math.hypot(...a.view().position));
    }
    expect(Math.max(...seen)).toBeGreaterThan(0.01);
    expect(Math.max(...seen)).toBeLessThanOrEqual(0.5 * Math.SQRT2 + 1e-9);
    expect(seen[seen.length - 1]).toBe(0); // 0.25 s later it is over
  });

  it('reset: a new run starts every camera from its data', () => {
    const b = new CameraBrain(HZ, LENS);
    b.add([cam('vc-a', { rig: 'fixed' }), cam('vc-b', { rig: 'follow', enabled: false, yaw: 10 })]);
    const w = world({ 'vc-a': [0, 0, 0], 'vc-b': [0, 0, 0] });
    b.activate('vc-b');
    b.set('vc-b', { yaw: 50 });
    run(b, 5, w);
    expect(b.live()).toBe('vc-b');
    b.reset();
    run(b, 1, w);
    expect(b.live()).toBe('vc-a');
    expect(b.get('vc-b')!.yaw).toBe(10);
  });

  it('interpolation between the last two steps; a cut does not streak', () => {
    const b = new CameraBrain(HZ, LENS);
    b.add([cam('vc-a', { rig: 'rail', path: 'track', railSpeed: 12 }), { id: 'track', components: { cameraPath: { points: [[0, 0, 0], [12, 0, 0]], smooth: false } } }]);
    const w = world({ track: [0, 0, 0], 'vc-a': [0, 0, 0] });
    run(b, 2, w);
    const p = [0, 0, 0];
    const r = [0, 0, 0, 1];
    b.readInterpolated(0.5, p, r);
    expect(p[0]).toBeCloseTo(0.15, 12); // between 0.1 and 0.2
    const c = new CameraBrain(HZ, LENS);
    c.add([cam('vc-a', { rig: 'fixed' })]);
    run(c, 1, world({ 'vc-a': [7, 0, 0] }));
    c.readInterpolated(0.3, p, r);
    expect(p).toEqual([7, 0, 0]);
  });
});
