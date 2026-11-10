/**
 * A look laid over the project environment.
 * Pure (no renderer): the merge rule the renderer, Play, the export and the
 * editor's Scene view share. (The post pipeline's lifetime — no rebuild on a
 * same-size frame — is covered by environment-nodes.test.ts.)
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { environmentHasLook, layerEnvironment, type EnvironmentLike } from './environment';
import { cloudDriftUniform, createSkyMesh, followCamera } from './environment-nodes';

const BASE: EnvironmentLike & { wind?: unknown } = {
  sky: { mode: 'procedural', turbidity: 6 },
  fog: { mode: 'linear', color: '#ffffff', near: 10, far: 100 },
  post: { toneMapping: 'agx', exposure: 1.2, bloom: { enabled: true, strength: 0.5 }, grading: { contrast: 0.1 } },
  quality: 'medium',
  wind: { direction: [1, 0], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 },
};

describe('layerEnvironment', () => {
  it('no layer: the project environment unchanged (existing projects look identical)', () => {
    expect(layerEnvironment(BASE, null)).toBe(BASE);
    expect(layerEnvironment(BASE, undefined)).toBe(BASE);
    expect(layerEnvironment(null, null)).toBeNull();
  });

  it('sky, fog and wind replace the project part whole; quality stays the project one', () => {
    const out = layerEnvironment(BASE, { sky: { mode: 'color', color: '#ff0000' }, fog: { mode: 'none', color: '#000000' }, wind: { direction: [0, 1], strength: 3, gust: 0, gustFrequency: 0, turbulence: 0 } })!;
    expect(out.sky).toEqual({ mode: 'color', color: '#ff0000' });
    expect(out.fog).toEqual({ mode: 'none', color: '#000000' });
    expect(out.wind).toEqual({ direction: [0, 1], strength: 3, gust: 0, gustFrequency: 0, turbulence: 0 });
    expect(out.post).toBe(BASE.post);
    expect(out.quality).toBe('medium');
  });

  it('post merges per effect: a layer changes its grading and keeps the project bloom and tone mapping', () => {
    const out = layerEnvironment(BASE, { post: { grading: { lift: 0.1, gamma: 1.3, gain: 0.9 } } })!;
    expect(out.post).toEqual({ toneMapping: 'agx', exposure: 1.2, bloom: { enabled: true, strength: 0.5 }, grading: { lift: 0.1, gamma: 1.3, gain: 0.9 } });
    expect(out.sky).toBe(BASE.sky);
  });

  it('a layer over a project without an environment', () => {
    const out = layerEnvironment(null, { sky: { mode: 'color', color: '#00ff00' } });
    expect(out).toEqual({ sky: { mode: 'color', color: '#00ff00' } });
    expect(environmentHasLook(out)).toBe(true);
    expect(environmentHasLook(layerEnvironment({}, null))).toBe(false);
    expect(environmentHasLook(null)).toBe(false);
  });
});

describe('the sky round the camera', () => {
  const contains = (mesh: THREE.Mesh, at: THREE.Vector3): boolean => {
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld).containsPoint(at);
  };
  it('a camera high over a large world and far from its origin is inside the physical sky and the gradient dome when it draws them', () => {
    const sky = createSkyMesh({ turbidity: 6, rayleigh: 1.5, mieCoefficient: 0.005, mieDirectionalG: 0.8, sun: new THREE.Vector3(0, 1, 0), cloudCoverage: 0, cloudDensity: 0 }, cloudDriftUniform());
    const dome = followCamera(new THREE.Mesh(new THREE.SphereGeometry(4000, 8, 4)));
    const draw = (mesh: THREE.Mesh, cam: THREE.Camera): void => (mesh.onBeforeRender as unknown as (r: unknown, s: unknown, c: THREE.Camera) => void)(null, null, cam);
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
    for (const at of [[-2048, 1640, -4110], [0, 6000, 0], [9000, 20, -9000], [0, 1.7, 0]] as Array<[number, number, number]>) {
      camera.position.set(...at);
      camera.updateMatrixWorld();
      for (const mesh of [sky, dome]) {
        mesh.updateMatrixWorld();
        // What the renderer calls before it reads the draw's matrices.
        draw(mesh, camera);
        expect(contains(mesh, camera.position)).toBe(true);
        expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([...at]);
      }
    }
    // The sky's own size is unchanged: it is drawn on the far plane, so the far plane never clips it.
    expect(sky.scale.x).toBe(4500);
  });
});
