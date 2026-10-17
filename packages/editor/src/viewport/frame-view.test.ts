import { describe, expect, it } from 'vitest';

import { ENTRY_LEVEL_DEG, FRAME_PITCH_MAX_DEG, FRAME_PITCH_MIN_DEG, framePose, insideBox, stampFrameBox, unionBoxes, viewShowsBox, type FrameInsets } from './frame-view';

type V3 = [number, number, number];
const pitchOf = (position: readonly number[], target: readonly number[]): number => (Math.atan2(position[1]! - target[1]!, Math.hypot(position[0]! - target[0]!, position[2]! - target[2]!)) * 180) / Math.PI;
const headingOf = (position: readonly number[], target: readonly number[]): number => Math.atan2(position[0]! - target[0]!, position[2]! - target[2]!);
/** Every corner of the box in front of the camera and inside the view's angles (a pinhole camera looking at the target). */
function seesWhole(box: { min: V3; max: V3 }, position: readonly number[], target: readonly number[], fovY: number, aspect: number, insets: FrameInsets = { left: 0, right: 0, top: 0, bottom: 0 }): boolean {
  const f = [0, 1, 2].map((i) => target[i]! - position[i]!);
  const fl = Math.hypot(...f);
  const fw = f.map((v) => v / fl);
  const r0 = [-fw[2]!, 0, fw[0]!];
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
    // On screen (-1…1, y up), inside the part the panels leave free.
    const sx = x / z / (ty * aspect);
    const sy = y / z / ty;
    if (z <= 0 || sx < -1 + 2 * insets.left - 1e-4 || sx > 1 - 2 * insets.right + 1e-4 || sy < -1 + 2 * insets.bottom - 1e-4 || sy > 1 - 2 * insets.top + 1e-4) return false;
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

describe('framing beside docked panels', () => {
  const building = { min: [218, 0, -45] as V3, max: [230, 7.5, -33] as V3 };
  /** Where the box's centre shows on screen (-1…1, y up). */
  const onScreen = (p: V3, position: readonly number[], target: readonly number[], fovY: number, aspect: number): [number, number] => {
    const f = [0, 1, 2].map((i) => target[i]! - position[i]!);
    const fl = Math.hypot(...f);
    const fw = f.map((v) => v / fl);
    const right = [-fw[2]!, 0, fw[0]!].map((v, _, a) => v / Math.hypot(a[0]!, a[2]!));
    const up = [right[1]! * fw[2]! - right[2]! * fw[1]!, right[2]! * fw[0]! - right[0]! * fw[2]!, right[0]! * fw[1]! - right[1]! * fw[0]!];
    const d = p.map((v, i) => v - position[i]!);
    const dot = (a: number[]): number => a[0]! * d[0]! + a[1]! * d[1]! + a[2]! * d[2]!;
    const ty = Math.tan((fovY * Math.PI) / 360);
    return [dot(right) / dot(fw) / (ty * aspect), dot(up) / dot(fw) / ty];
  };

  it('a right panel column: the building fits the part left of it and centres there', () => {
    const insets = { left: 0, right: 0.22, top: 0, bottom: 0 };
    const eye: V3 = [240, 10, -20];
    const target: V3 = [224, 0, -39];
    const pose = framePose(building, eye, target, 50, 16 / 9, insets);
    expect(seesWhole(building, pose.position, pose.target, 50, 16 / 9, insets)).toBe(true);
    const [x, y] = onScreen([224, 3.75, -39], pose.position, pose.target, 50, 16 / 9);
    expect(x).toBeCloseTo(-0.22, 6);
    expect(y).toBeCloseTo(0, 6);
    // The same heading and pitch; a little further back than with the whole view free.
    expect(pitchOf(pose.position, pose.target)).toBeCloseTo(pitchOf(eye, target), 6);
    expect(headingOf(pose.position, pose.target)).toBeCloseTo(headingOf(eye, target), 6);
    expect(pose.distance).toBeGreaterThan(framePose(building, eye, target, 50, 16 / 9).distance);
  });

  it('panels on every side, a tall view, a thin decal: whole in the free part, from outside', () => {
    const insets = { left: 0.18, right: 0.2, top: 0.1, bottom: 0.3 };
    for (const [box, aspect] of [
      [building, 16 / 9],
      [building, 0.6],
      [{ min: [0, 0, -0.25] as V3, max: [1, 1, 0.25] as V3 }, 16 / 9],
    ] as const) {
      const pose = framePose(box, [box.max[0] + 9, 6, box.max[2] + 14], [box.min[0], 0, box.min[2]], 50, aspect, insets);
      expect(seesWhole(box, pose.position, pose.target, 50, aspect, insets)).toBe(true);
      expect(insideBox(pose.position, box)).toBe(false);
    }
  });

  it('panels over nearly all the view still leave a quarter of it to frame in', () => {
    const insets = { left: 0.6, right: 0.6, top: 0, bottom: 0 };
    const pose = framePose(building, [240, 10, -20], [224, 0, -39], 50, 16 / 9, insets);
    expect(Number.isFinite(pose.distance)).toBe(true);
    expect(seesWhole(building, pose.position, pose.target, 50, 16 / 9, { left: 0.375, right: 0.375, top: 0, bottom: 0 })).toBe(true);
  });
});

describe('the view an editor opens with', () => {
  // A 24 × 6 × 24 block layer one cell under the ground (the 3D starter's).
  const layer = { min: [-12, -1, -12] as V3, max: [12, 5, 12] as V3 };

  it('is framed from inside the object, from below it, or nearly level with the ground', () => {
    // The starter's first view: a few metres up, inside the layer's box.
    expect(viewShowsBox(layer, [2.96, 3.13, 2.96], [0, 0.5, 0], 50, 16 / 9)).toBe(false);
    expect(viewShowsBox(layer, [0, -5, 30], [0, 0, 0], 50, 16 / 9)).toBe(false);
    // Outside the box but looking along the ground.
    const level: V3 = [0, 6, 40];
    expect(viewShowsBox(layer, level, [0, 6 - Math.tan(((ENTRY_LEVEL_DEG - 2) * Math.PI) / 180) * 40, 0], 50, 16 / 9)).toBe(false);
  });

  it('is kept when it already looks down at the object from outside, and framed when it looks away', () => {
    expect(viewShowsBox(layer, [25, 21, 25], [0, 2, 0], 50, 16 / 9)).toBe(true);
    // Aimed beside it, the centre still in view.
    expect(viewShowsBox(layer, [40, 30, 40], [16, 0, 16], 50, 16 / 9)).toBe(true);
    // Looking away from it.
    expect(viewShowsBox(layer, [40, 30, 40], [80, 0, 80], 50, 16 / 9)).toBe(false);
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
