/**
 * The Scene view's grid under a floor at y = 0: from wherever the camera
 * looks, a grid line's depth taken a pixel off its pixel's centre (what a
 * line's rasterizing does on a slanted ground) is still behind the floor's.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { VIEW_GROUND_MIN_DROP, VIEW_GROUND_SIZE, ViewGround, viewGroundDrop } from './view-ground';

/** The Scene view's lens: 50° of vertical field in a view 460 pixels high (the editor's default layout at 1600 × 900). */
const FOV = 50;
const HEIGHT_PX = 460;
const FOCAL_PX = HEIGHT_PX / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);

/**
 * At a grid point `[px, pz]` seen from `eye`: the range along its pixel's ray to the floor (y = 0) less the range to
 * the grid's plane (`drop` under it) along the ray one pixel lower or higher on screen, whichever is nearer. Negative:
 * the line's depth there is in front of the floor's, so the line draws over the floor.
 */
function clearance(eye: readonly [number, number, number], px: number, pz: number, drop: number): number {
  const h = eye[1];
  const l = Math.hypot(px - eye[0], pz - eye[2]);
  const pitch = Math.atan2(h, l);
  const floor = h / Math.sin(pitch);
  const px1 = 1 / FOCAL_PX;
  const grid = Math.min(...[pitch - px1, pitch + px1].filter((a) => a > 0).map((a) => (h + drop) / Math.sin(a)));
  return grid - floor;
}

const CORNERS = [-1, 1].flatMap((x) => [-1, 1].map((z) => [(x * VIEW_GROUND_SIZE) / 2, (z * VIEW_GROUND_SIZE) / 2] as const));
/** Where the pictures look from, and others: the overview (E1), the lane's and the lake's views, close up, far off, low over the ground. */
const EYES: ReadonlyArray<readonly [number, number, number]> = [[30, 28, 34], [12, 14, -30], [-40, 20, 40], [3, 2, 3], [0, 6, 0], [150, 90, 120], [60, 1.5, 0], [400, 300, -400]];

describe('the Scene view\'s grid under a floor', () => {
  it('sits far enough under y = 0 that no grid line draws over a floor there, from every eye; a centimetre does only up close', () => {
    for (const eye of EYES) {
      const drop = viewGroundDrop(eye[0], eye[2], FOCAL_PX);
      for (const [x, z] of CORNERS) expect(clearance(eye, x, z, drop), `eye ${eye.join(',')} corner ${x},${z}`).toBeGreaterThanOrEqual(0);
      for (const [x, z] of [[0, 0], [5, -5], [-10, 0]] as const) expect(clearance(eye, x, z, drop)).toBeGreaterThanOrEqual(0);
    }
    // The fixed centimetre the grid sat at: fine from a few metres, in front of the floor from the overview.
    expect(Math.min(...CORNERS.map(([x, z]) => clearance([0, 6, 0], x, z, VIEW_GROUND_MIN_DROP)))).toBeLessThan(0);
    expect(clearance([3, 2, 3], 0, 0, VIEW_GROUND_MIN_DROP)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...CORNERS.map(([x, z]) => clearance([30, 28, 34], x, z, VIEW_GROUND_MIN_DROP)))).toBeLessThan(0);
  });

  it('stays a centimetre up close and a gap nobody sees from far: under a thousandth of the distance looked from', () => {
    expect(viewGroundDrop(0, 0, 4000)).toBe(VIEW_GROUND_MIN_DROP);
    for (const eye of EYES) {
      const drop = viewGroundDrop(eye[0], eye[2], FOCAL_PX);
      expect(drop).toBeGreaterThanOrEqual(VIEW_GROUND_MIN_DROP);
      const far = Math.hypot(Math.abs(eye[0]) + VIEW_GROUND_SIZE / 2, eye[1], Math.abs(eye[2]) + VIEW_GROUND_SIZE / 2);
      expect(drop / far).toBeLessThan(1 / 400);
    }
    // No lens, no finite place: the least drop, never NaN.
    expect(viewGroundDrop(5, 5, 0)).toBe(VIEW_GROUND_MIN_DROP);
    expect(viewGroundDrop(Number.NaN, 0, FOCAL_PX)).toBe(VIEW_GROUND_MIN_DROP);
  });

  it('moves its grid and ground square with the camera before a frame', () => {
    const overlay = new THREE.Group();
    const g = new ViewGround(overlay);
    const camera = new THREE.PerspectiveCamera(FOV, 2, 0.1, 1000);
    camera.position.set(30, 28, 34);
    g.frame(camera, HEIGHT_PX);
    const want = -viewGroundDrop(30, 34, FOCAL_PX);
    expect(overlay.children.map((c) => c.position.y)).toEqual([want, want]);
    expect(want).toBeLessThan(-0.05);
    camera.position.set(1, 2, 1);
    g.frame(camera, HEIGHT_PX);
    expect(overlay.children.map((c) => c.position.y)).toEqual([-viewGroundDrop(1, 1, FOCAL_PX), -viewGroundDrop(1, 1, FOCAL_PX)]);
    g.dispose();
  });
});
