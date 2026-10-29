/**
 * The light loop's face pick for a light seen through several faces (its JS
 * twin, `cubeFaceOf`) against three's point-light shadow convention: the
 * face table is three's own (read from three's `PointShadowNode`), and for
 * random points round a light, turned or not, the face picked is the one
 * whose camera (placed as three places a point light's face camera) sees the
 * point, at the place and depth that camera projects it to.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { CUBE_DIRECTIONS, CUBE_UPS, cubeDepthTerms, cubeFaceOf, placeCubeFace } from './shadow-cube';

/** A `[ new Vector3( x, y, z ), … ]` table of three's source, by its name. */
function threeTable(source: string, name: string): number[][] {
  const at = source.indexOf(`const ${name} = [`);
  expect(at, name).toBeGreaterThan(0);
  const body = source.slice(at, source.indexOf('];', at));
  return [...body.matchAll(/Vector3\(\s*([-\d. ]+),\s*([-\d. ]+),\s*([-\d. ]+)\)/g)].map((m) => [m[1], m[2], m[3]].map((v) => Number(v!.replace(/\s/g, ''))));
}

describe('the shadow atlas cube faces', () => {
  it("are three's point-light shadow faces (its WebGL table)", () => {
    // three's own source as text (Vite's raw import: the package may not read files through Node).
    const source = Object.values(import.meta.glob('../../../node_modules/three/src/nodes/lighting/PointShadowNode.js', { eager: true, query: '?raw', import: 'default' }))[0] as string;
    expect(threeTable(source, '_cubeDirectionsWebGL')).toEqual(CUBE_DIRECTIONS.map((d) => [...d]));
    expect(threeTable(source, '_cubeUpsWebGL')).toEqual(CUBE_UPS.map((d) => [...d]));
  });

  it('pick the face whose camera sees a point, at the place and depth it projects to', () => {
    let seed = 7;
    const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const camera = new THREE.PerspectiveCamera(90, 1, 0.5, 20);
    camera.updateProjectionMatrix();
    const light = new THREE.Vector3(3, 1.5, -2);
    const v = new THREE.Vector4();
    const [a, b] = cubeDepthTerms(camera.projectionMatrix.elements, 0.5, 0.5);
    for (const turn of [null, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.25))]) {
      const inverse = turn === null ? null : turn.clone().invert();
      for (let n = 0; n < 2000; n += 1) {
        const world = new THREE.Vector3(rand(), rand(), rand()).multiplyScalar(8).add(light);
        const local = world.clone().sub(light);
        if (inverse !== null) local.applyQuaternion(inverse);
        const f = cubeFaceOf(local.x, local.y, local.z);
        if (f.d < camera.near) continue;
        placeCubeFace(camera, f.face, light, turn);
        v.set(world.x, world.y, world.z, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
        expect(v.w).toBeCloseTo(f.d, 5);
        expect(v.x / v.w).toBeCloseTo(f.x, 5);
        expect(v.y / v.w).toBeCloseTo(f.y, 5);
        expect(Math.abs(f.x)).toBeLessThanOrEqual(1 + 1e-9);
        expect(Math.abs(f.y)).toBeLessThanOrEqual(1 + 1e-9);
        // The stored depth (WebGL 2's −1–1 range taken to 0–1).
        expect(a + b / f.d).toBeCloseTo((v.z / v.w) * 0.5 + 0.5, 5);
      }
    }
  });
});
