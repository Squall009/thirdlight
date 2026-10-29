/**
 * The light loop's face pick for a light seen through several faces (its JS
 * twin, `cubeFaceOf`) against three's point-light shadow convention: the
 * face table is three's own (read from three's `PointShadowNode`), and for
 * random points round a light, turned or not, the face picked is the one
 * whose camera (placed as three places a point light's face camera) sees the
 * point, at the place and depth that camera projects it to. A mover
 * walking past a lamp has the faces it is in drawn again, and the faces it
 * left, and no others: no face keeps its old depth.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { FaceRedraws } from './shadow-atlas';
import { moverFaces } from './shadow-atlas-draw';
import { CUBE_DIRECTIONS, CUBE_FACES, CUBE_UPS, cubeDepthTerms, cubeFaceOf, placeCubeFace } from './shadow-cube';

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

  it('redraw the faces a walker is in or was last drawn in, so none keeps its old depth, and only those', () => {
    const lamp = new THREE.Vector3(0, 2.5, 0);
    const cameras = Array.from({ length: CUBE_FACES }, (_, f) => {
      const c = new THREE.PerspectiveCamera(90, 1, 0.5, 8);
      c.updateProjectionMatrix();
      placeCubeFace(c, f, lamp, null);
      return c;
    });
    const faces = [0, 1, 2, 3, 4, 5];
    const faceAlong = (x: number, y: number, z: number): number => CUBE_DIRECTIONS.findIndex((d) => d[0] === x && d[1] === y && d[2] === z);
    const sphere = (x: number, z: number): number[] => [x, 0.9, z, 0.5];
    // Under the lamp: the face looking down only; far off along +x at its height: the face looking along +x.
    expect(moverFaces(cameras, faces, sphere(0, 0))).toBe(1 << faceAlong(0, -1, 0));
    expect(moverFaces(cameras, faces, [6, 2.5, 0, 0.3])).toBe(1 << faceAlong(1, 0, 0));
    // A walker crosses under the lamp; every third frame the atlas makes it wait (the redraw budget).
    const redraws = new FaceRedraws();
    const tiles = [{ x: 0, y: 0, size: 64 }];
    const shows: (number[] | null)[] = faces.map(() => null);
    let drawn = 0;
    let granted = 0;
    for (let i = 0; i <= 280; i += 1) {
      const at = sphere(-7 + i * 0.05, 1);
      const now = moverFaces(cameras, faces, at);
      const dirty = redraws.note(i === 0, now) || now !== 0 || i === 0;
      if (!dirty || i % 3 === 2) continue;
      granted += 1;
      const want = redraws.draw(tiles, 0b111111);
      for (const f of faces) {
        if ((want & (1 << f)) === 0) continue;
        drawn += 1;
        shows[f] = (now & (1 << f)) !== 0 ? at : null;
      }
      // After a redraw every face shows the walker where it is now, or nothing.
      for (const f of faces) expect(shows[f], `frame ${i} face ${f}`).toEqual((now & (1 << f)) !== 0 ? at : null);
    }
    expect(granted).toBeGreaterThan(150);
    // The first redraw draws all six; then about two faces a redraw, not six.
    expect(drawn / granted).toBeLessThan(2.5);
    // The lamp moved: all six again.
    redraws.note(true, 0);
    expect(redraws.draw(tiles, 0b111111)).toBe(0b111111);
    // New tiles (another place in the atlas): all six again.
    redraws.note(false, 1);
    expect(redraws.draw([{ x: 64, y: 0, size: 64 }], 0b111111)).toBe(0b111111);
  });
});
