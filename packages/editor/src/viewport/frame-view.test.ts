import { describe, expect, it } from 'vitest';

import { FRAME_PITCH_MAX_DEG, FRAME_PITCH_MIN_DEG, framePose, insideBox, stampFrameBox, unionBoxes } from './frame-view';

type V3 = [number, number, number];
const pitchOf = (position: readonly number[], target: readonly number[]): number => (Math.atan2(position[1]! - target[1]!, Math.hypot(position[0]! - target[0]!, position[2]! - target[2]!)) * 180) / Math.PI;
const headingOf = (position: readonly number[], target: readonly number[]): number => Math.atan2(position[0]! - target[0]!, position[2]! - target[2]!);
/** Every corner of the box in front of the camera and inside the view's angles (a pinhole camera looking at the target). */
function seesWhole(box: { min: V3; max: V3 }, position: readonly number[], target: readonly number[], fovY: number, aspect: number): boolean {
  const f = [0, 1, 2].map((i) => target[i]! - position[i]!);
  const fl = Math.hypot(...f);
  const fw = f.map((v) => v / fl);
  const r0 = [fw[2]!, 0, -fw[0]!];
  const rl = Math.hypot(...r0);
  const right = r0.map((v) => v / rl);
  const up = [right[1]! * fw[2]! - right[2]! * fw[1]!, right[2]! * fw[0]! - right[0]! * fw[2]!, right[0]! * fw[1]! - right[1]! * fw[0]!];
  const ty = Math.tan((fovY * Math.PI) / 360);
  for (let k = 0; k < 8; k++) {
    const c = [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]];
    const d = c.map((v, i) => v - position[i]!);
    const z = d[0]! * fw[0]! + d[1]! * fw[1]! + d[2]! * fw[2]!;
    const x = d[0]! * right[0]! + d[1]! * right[1]! + d[2]! * right[2]!;
    const y = d[0]! * up[0]! + d[1]! * up[1]! + d[2]! * up[2]!;
    if (z <= 0 || Math.abs(y / z) > ty * 1.0001 || Math.abs(x / z) > ty * aspect * 1.0001) return false;
  }
  return true;
}

describe('framing a box', () => {
  // A two-storey building, 12 × 12 m, 6 m of walls and a 1.5 m roof.
  const building = { min: [218, 0, -45] as V3, max: [230, 7.5, -33] as V3 };

  it('puts the camera outside the box, looking at its centre and seeing all of it, from a view inside its walls', () => {
    // The view as F left it: inside the building, level, a few metres from the middle.
    const pose = framePose(building, [224, 1.6, -38], [224, 1.6, -40], 50, 16 / 9);
    expect(pose.target).toEqual([224, 3.75, -39]);
    expect(insideBox(pose.position, building)).toBe(false);
    expect(seesWhole(building, pose.position, pose.target, 50, 16 / 9)).toBe(true);
    // A level view is lifted to look down; the heading (from +z here) is kept.
    expect(pitchOf(pose.position, pose.target)).toBeCloseTo(FRAME_PITCH_MIN_DEG, 6);
    expect(headingOf(pose.position, pose.target)).toBeCloseTo(0, 6);
  });

  it('keeps a view that already looks down at a sensible slope, and eases off one straight down', () => {
    const eye: V3 = [230, 12, -30];
    const target: V3 = [224, 0, -39];
    const kept = framePose(building, eye, target, 50, 16 / 9);
    expect(pitchOf(kept.position, kept.target)).toBeCloseTo(pitchOf(eye, target), 6);
    expect(headingOf(kept.position, kept.target)).toBeCloseTo(headingOf(eye, target), 6);
    const down = framePose(building, [224, 40, -39], [224, 0, -39], 50, 16 / 9);
    expect(pitchOf(down.position, down.target)).toBeCloseTo(FRAME_PITCH_MAX_DEG, 6);
    expect(insideBox(down.position, building)).toBe(false);
  });

  it('fits the narrower angle: a tall, thin view backs off further and still sees the whole box', () => {
    const wide = framePose(building, [240, 10, -20], [224, 0, -39], 50, 16 / 9);
    const tall = framePose(building, [240, 10, -20], [224, 0, -39], 50, 0.5);
    expect(tall.distance).toBeGreaterThan(wide.distance);
    expect(seesWhole(building, tall.position, tall.target, 50, 0.5)).toBe(true);
  });

  it('a decal (thin) and a point are framed at least the smallest radius away', () => {
    const decal = { min: [0, 0, -0.25] as V3, max: [1, 1, 0.25] as V3 };
    const pose = framePose(decal, [5, 3, 5], [0, 0, 0], 50, 16 / 9);
    expect(pose.distance).toBeGreaterThanOrEqual(2 / Math.sin((25 * Math.PI) / 180) - 1e-9);
    expect(seesWhole(decal, pose.position, pose.target, 50, 16 / 9)).toBe(true);
  });
});

describe('what Home frames', () => {
  it('a stamp: its turned square, as high as it raises, down from the ground at its raised centre (or from its own height)', () => {
    const turned = stampFrameBox({ asset: 'hill', at: [10, 20], size: 8, rotation: 45, height: 6 }, 'terrain-1');
    expect(turned.min[0]).toBeCloseTo(10 - 4 * Math.SQRT2, 6);
    expect(turned.max[2]).toBeCloseTo(20 + 4 * Math.SQRT2, 6);
    expect([turned.min[1], turned.max[1], turned.ground]).toEqual([-6, 0, 'terrain-1']);
    expect([stampFrameBox({ asset: 'pit', at: [0, 0], size: 4, height: -3 }, 't').min[1], stampFrameBox({ asset: 'pit', at: [0, 0], size: 4, height: -3 }, 't').max[1]]).toEqual([0, 3]);
    const cut = stampFrameBox({ asset: 'pit', at: [0, 0], size: 4, height: -3, mode: 'min', y: 12 }, 'terrain-1');
    expect([cut.min[1], cut.max[1], cut.ground]).toEqual([9, 12, undefined]);
  });

  it('several selections: the box around them all, the ground kept only when they share it', () => {
    expect(unionBoxes([null, { min: [0, 0, 0], max: [1, 1, 1], ground: 't' }, { min: [-2, 0, 3], max: [0, 4, 5], ground: 't' }])).toEqual({ min: [-2, 0, 0], max: [1, 4, 5], ground: 't' });
    expect(unionBoxes([{ min: [0, 0, 0], max: [1, 1, 1], ground: 't' }, { min: [0, 0, 0], max: [1, 1, 1] }])?.ground).toBeUndefined();
    expect(unionBoxes([null])).toBeNull();
  });
});
