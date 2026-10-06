/**
 * The sky's turn and "align the sky's sun to the key light": where a sky
 * image's sun is, and the turn that puts it where the key light comes from —
 * checked against three's own rotation (the matrix `backgroundRotation` and
 * `environmentRotation` become), not against this file's formula.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { alignedSkyRotation, applySkyRotation, cubePixelDirection, equirectPixelDirection, findSkySun, skyRotationRadians, wrapDegrees, type SkyPixels } from './sky-rotation';

/** An RGBA image filled by `fill(x, y)` → [r, g, b]. */
function image(width: number, height: number, fill: (x: number, y: number) => readonly number[]): SkyPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = fill(x, y);
      data.set([p[0]!, p[1]!, p[2]!, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** Where three's background/environment rotation by `deg` about Y takes a direction the unturned sky shows at `d`. */
function turned(d: readonly number[], deg: number): THREE.Vector3 {
  // The lookup is Rᵀ·view direction (SceneProperties/MaterialProperties): what was at d is now seen at R·d.
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(deg), 0)).transpose();
  return new THREE.Vector3(d[0], d[1], d[2]).applyMatrix4(m.invert());
}

const azimuthOf = (v: THREE.Vector3): number => THREE.MathUtils.radToDeg(Math.atan2(v.z, v.x));

describe('sky rotation', () => {
  it('only texture skies turn; the scene turns background and environment alike', () => {
    expect(skyRotationRadians({ mode: 'texture', rotation: 90 })).toBeCloseTo(Math.PI / 2, 12);
    expect(skyRotationRadians({ mode: 'texture' })).toBe(0);
    expect(skyRotationRadians({ mode: 'procedural', rotation: 90 })).toBe(0);
    expect(skyRotationRadians(undefined)).toBe(0);
    const scene = new THREE.Scene();
    applySkyRotation(scene, 1.25);
    expect([scene.backgroundRotation.y, scene.environmentRotation.y]).toEqual([1.25, 1.25]);
    expect(wrapDegrees(270)).toBe(-90);
    expect(wrapDegrees(-180)).toBe(180);
  });

  it('maps equirect pixels as three samples them: the middle column is +X, a quarter is −Z, the top row is up', () => {
    const [x0, , z0] = equirectPixelDirection(127.5, 63.5, 256, 128);
    expect(x0).toBeCloseTo(1, 6);
    expect(z0).toBeCloseTo(0, 6);
    // three's equirectUV of that direction gives the pixel back.
    const d = equirectPixelDirection(64, 10, 256, 128);
    const u = Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5;
    const v = Math.asin(d[1]) / Math.PI + 0.5;
    expect(u * 256 - 0.5).toBeCloseTo(64, 6);
    expect((1 - v) * 128 - 0.5).toBeCloseTo(10, 6);
  });

  it('maps cube pixels with three\'s mirrored x: the +X image is seen towards −X, +Z towards +Z, +Y overhead', () => {
    const near = (a: readonly number[], b: readonly number[]): void => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6));
    near(cubePixelDirection(0, 15.5, 15.5, 32), [-1, 0, 0]);
    near(cubePixelDirection(1, 15.5, 15.5, 32), [1, 0, 0]);
    near(cubePixelDirection(2, 15.5, 15.5, 32), [0, 1, 0]);
    near(cubePixelDirection(4, 15.5, 15.5, 32), [0, 0, 1]);
    near(cubePixelDirection(5, 15.5, 15.5, 32), [0, 0, -1]);
    // The top rows of a side face look up.
    expect(cubePixelDirection(4, 16, 0, 32)[1]).toBeGreaterThan(0.6);
  });

  it('finds a painted sun in an equirect (not a lone brighter pixel elsewhere) and turns it to the key light', () => {
    // A blue sky with a saturated sun disc at azimuth 120°, elevation 20°, and one stray white pixel.
    const W = 512;
    const H = 256;
    const sunAz = 120;
    const sunEl = 20;
    const sunPx = (sunAz / 360 + 0.5) * W;
    const sunPy = (0.5 - sunEl / 180) * H;
    const sky = image(W, H, (x, y) => {
      if (x === 40 && y === 200) return [255, 255, 255];
      if (Math.hypot(x - sunPx, y - sunPy) < 6) return [255, 255, 250];
      return y < H / 2 ? [90, 140, 230] : [70, 90, 60];
    });
    const sun = findSkySun({ equirect: sky })!;
    expect(sun.azimuth).toBeCloseTo(sunAz, 0);
    expect(sun.elevation).toBeCloseTo(sunEl, 0);
    // A key light shining from azimuth −30° (travelling the other way), 40° up.
    const from = new THREE.Vector3(Math.cos(THREE.MathUtils.degToRad(-30)) * Math.cos(THREE.MathUtils.degToRad(40)), Math.sin(THREE.MathUtils.degToRad(40)), Math.sin(THREE.MathUtils.degToRad(-30)) * Math.cos(THREE.MathUtils.degToRad(40)));
    const travel = from.clone().negate().toArray();
    const rotation = alignedSkyRotation(sun.direction, travel)!;
    expect(rotation).toBeGreaterThan(-180);
    expect(rotation).toBeLessThanOrEqual(180);
    // three's turn by that much puts the sun where the light comes from.
    expect(wrapDegrees(azimuthOf(turned(sun.direction, rotation)) - -30)).toBeCloseTo(0, 0);
  });

  it('finds the sun across cube faces and aligns it the same way', () => {
    // The sun on the −Z image (seen towards −Z), right of centre and a little up.
    const faces = Array.from({ length: 6 }, (_, f) =>
      image(64, 64, (x, y) => (f === 5 && Math.hypot(x - 44, y - 24) < 4 ? [255, 250, 240] : f === 2 ? [100, 150, 240] : [80, 110, 160])),
    );
    const sun = findSkySun({ cube: faces })!;
    const expected = cubePixelDirection(5, 44, 24, 64);
    expect(sun.direction[0]).toBeCloseTo(expected[0], 1);
    expect(sun.direction[2]).toBeCloseTo(expected[2], 1);
    expect(sun.elevation).toBeGreaterThan(5);
    // A light travelling towards −X comes from +X (azimuth 0).
    const rotation = alignedSkyRotation(sun.direction, [-1, -1, 0])!;
    expect(wrapDegrees(azimuthOf(turned(sun.direction, rotation)))).toBeCloseTo(0, 0);
  });

  it('has no answer for a light straight down', () => {
    expect(alignedSkyRotation([1, 0, 0], [0, -1, 0])).toBeNull();
  });
});
