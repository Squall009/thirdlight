/**
 * Phase 25.14: the track rig's camera regions (dead zone, bounds and
 * distance per region, blended on enter) and look-ahead — the brain alone,
 * on a scripted world.
 */
import { describe, expect, it } from 'vitest';

import { CameraBrain, type CameraWorld } from './camera-brain';

const HZ = 120;
const BASE = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
const world = (pos: Record<string, number[]>): CameraWorld => ({
  worldOf: (id, p, r) => {
    const at = pos[id];
    if (at === undefined) return false;
    [p[0], p[1], p[2]] = [at[0]!, at[1]!, at[2]!];
    [r[0], r[1], r[2], r[3]] = [0, 0, 0, 1];
    return true;
  },
});
const brain = (): CameraBrain => new CameraBrain(HZ, { fovY: 60, near: 0.1, far: 100 });
const steps = (b: CameraBrain, w: CameraWorld, n: number): void => {
  for (let k = 0; k < n; k++) b.step(BASE, null, w);
};

describe('phase 25.14: camera regions', () => {
  it('a region changes the bounds, dead zone and distance while the target is inside, blended over its blend time', () => {
    const b = brain();
    b.add([
      { id: 'cam', components: { virtualCamera: { rig: 'track', target: 'hero', trackOffset: [0, 0, 10] } } },
      // A room from x 10 to 30: the framed point stays in x 15–25 there, the camera 20 m back, a 4 m dead zone.
      { id: 'room', components: { cameraRegion: { size: [20, 10], boundsMin: [-5, -100, -100], boundsMax: [5, 100, 100], distance: 20, deadZone: [4, 0, 0], blendTime: 0.5 } } },
    ]);
    const pos: Record<string, number[]> = { cam: [0, 0, 10], hero: [0, 0, 0], room: [20, 0, 0] };
    const w = world(pos);
    b.step(BASE, null, w);
    expect(b.view().position).toEqual([0, 0, 10]);
    expect(b.view().region).toBeNull();
    // Into the room (x 12): the blend starts from the camera's own settings.
    pos['hero'] = [12, 0, 0];
    b.step(BASE, null, w);
    expect(b.view().region).toBe('room');
    const first = b.view().position;
    expect(first[0]).toBeGreaterThan(11.9);
    expect(first[0]).toBeLessThan(12.1);
    expect(first[2]).toBeGreaterThan(10);
    expect(first[2]).toBeLessThan(10.1);
    // Half-way through the blend: between the two framings.
    steps(b, w, 29);
    const mid = b.view().position;
    expect(mid[0]).toBeGreaterThan(12.5);
    expect(mid[0]).toBeLessThan(14.5);
    expect(mid[2]).toBeGreaterThan(12);
    expect(mid[2]).toBeLessThan(18);
    // After it: clamped to x 15 at the region's distance.
    steps(b, w, 40);
    expect(b.view().position[0]).toBeCloseTo(15, 9);
    expect(b.view().position[2]).toBeCloseTo(20, 9);
    // The region's dead zone (±2 m) and bounds (≤ 25).
    pos['hero'] = [19, 0, 0];
    b.step(BASE, null, w);
    expect(b.view().position[0]).toBeCloseTo(17, 9);
    pos['hero'] = [29, 0, 0];
    b.step(BASE, null, w);
    expect(b.view().position[0]).toBeCloseTo(25, 9);
    // Out again (x 40): the camera's own settings come back over the region's blend time.
    pos['hero'] = [40, 0, 0];
    b.step(BASE, null, w);
    expect(b.view().region).toBeNull();
    expect(b.view().position[0]).toBeLessThan(26);
    steps(b, w, 60);
    expect(b.view().position).toEqual([40, 0, 10]);
  });

  it('overlaps: the highest priority, then the one entered last; a camera-bound region ignores other cameras; no depth holds every depth', () => {
    const b = brain();
    b.add([
      { id: 'cam', components: { virtualCamera: { rig: 'track', target: 'hero', trackOffset: [0, 0, 10] } } },
      { id: 'wide', components: { cameraRegion: { size: [100, 100], distance: 30, blendTime: 0 } } },
      { id: 'near', components: { cameraRegion: { size: [10, 10], distance: 15, blendTime: 0 } } },
      { id: 'high', components: { cameraRegion: { size: [4, 4], distance: 40, priority: 5, blendTime: 0 } } },
      { id: 'other', components: { cameraRegion: { size: [100, 100], distance: 50, priority: 9, camera: 'someone-else', blendTime: 0 } } },
    ]);
    const pos: Record<string, number[]> = { cam: [0, 0, 10], hero: [30, 0, 0], wide: [0, 0, 0], near: [0, 0, 0], high: [8, 0, 0], other: [0, 0, 0] };
    const w = world(pos);
    b.step(BASE, null, w);
    expect(b.view().region).toBe('wide');
    expect(b.view().position[2]).toBeCloseTo(30, 9);
    // Entered last wins a tie (0 = 0), whatever the load order.
    pos['hero'] = [0, 0, 7];
    b.step(BASE, null, w);
    expect(b.view().region).toBe('near');
    expect(b.view().position[2]).toBeCloseTo(22, 9);
    // A higher priority wins.
    pos['hero'] = [7, 0, 0];
    b.step(BASE, null, w);
    expect(b.view().region).toBe('high');
    expect(b.view().position[2]).toBeCloseTo(40, 9);
  });

  it('is replayable: a reset run gives the same views bit for bit', () => {
    const run = (): number[][] => {
      const b = brain();
      b.add([
        { id: 'cam', components: { virtualCamera: { rig: 'track', target: 'hero', deadZone: [1, 1, 0], damping: 0.2, lookAhead: [0, 0.4, 0] } } },
        { id: 'r1', components: { cameraRegion: { size: [8, 8], distance: 12, boundsMin: [-2, -2, -1], boundsMax: [2, 2, 1] } } },
      ]);
      const pos: Record<string, number[]> = { cam: [0, 2, 8], hero: [-10, 0, 0], r1: [0, 0, 0] };
      const out: number[][] = [];
      for (let k = 0; k < 400; k++) {
        pos['hero'] = [-10 + k * 0.06, Math.sin(k / 20) * 3, 0];
        b.step(BASE, null, world(pos));
        out.push([...b.view().position]);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('phase 25.14: look-ahead', () => {
  it('frames ahead of a falling target (vertical look-ahead), capped, eased; none without it', () => {
    const make = (extra: Record<string, unknown>): CameraBrain => {
      const b = brain();
      b.add([{ id: 'cam', components: { virtualCamera: { rig: 'track', target: 'hero', trackOffset: [0, 0, 10], ...extra } } }]);
      return b;
    };
    const ahead = make({ lookAhead: [0, 0.5, 0], lookAheadMax: [3, 2, 3], lookAheadSmoothing: 0.1 });
    const plain = make({});
    const pos: Record<string, number[]> = { cam: [0, 0, 10], hero: [0, 0, 0] };
    for (let k = 0; k < 240; k++) {
      // Falling at 2 m/s: 0.5 s ahead is 1 m below.
      pos['hero'] = [0, -2 * (k / HZ), 0];
      ahead.step(BASE, null, world(pos));
      plain.step(BASE, null, world(pos));
    }
    const y = pos['hero']![1]!;
    expect(plain.view().position[1]).toBeCloseTo(y, 9);
    expect(ahead.view().position[1]).toBeCloseTo(y - 1, 3);
    // Faster (10 m/s): capped at 2 m.
    for (let k = 0; k < 240; k++) {
      pos['hero'] = [0, y - 10 * (k / HZ), 0];
      ahead.step(BASE, null, world(pos));
    }
    expect(ahead.view().position[1]).toBeCloseTo(pos['hero']![1]! - 2, 3);
    // x has no look-ahead: moving sideways frames the target itself.
    expect(ahead.view().position[0]).toBe(0);
  });
});
