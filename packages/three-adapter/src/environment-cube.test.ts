import * as THREE from 'three';
import { texture } from 'three/tsl';
import { MeshStandardNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { ENVIRONMENT_CUBE_ROUGH_LEVELS, ENVIRONMENT_CUBE_SIZE, EnvironmentCube } from './environment-cube';
import { litScene, wgslRenderer } from './test-wgsl';

/** The fragment WGSL of a lit standard material with `environment` as the scene's environment lighting node. */
function litFragment(renderer: WebGPURenderer, environment: unknown): string {
  const scene = litScene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new MeshStandardNodeMaterial({ roughness: 0.6 }));
  scene.add(mesh);
  const backend = (renderer as unknown as { backend: { createNodeBuilder(o: THREE.Object3D, r: WebGPURenderer): Record<string, unknown> & { build(): void; fragmentShader: string } } }).backend;
  const b = backend.createNodeBuilder(mesh, renderer);
  b['scene'] = scene;
  b['camera'] = new THREE.PerspectiveCamera();
  b['material'] = mesh.material;
  const lights: THREE.Light[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Light).isLight === true) lights.push(o as THREE.Light);
  });
  const lightsNode = renderer.lighting.getNode(scene) as unknown as { setLights(l: THREE.Light[]): void };
  lightsNode.setLights(lights);
  b['lightsNode'] = lightsNode;
  b['environmentNode'] = environment;
  b.build();
  return b.fragmentShader;
}

describe('the lighting cube', () => {
  it('lights a surface with one cube lookup per term, at a level from its roughness, in place of the PMREM atlas', () => {
    const renderer = wgslRenderer();
    const cube = new EnvironmentCube(renderer);
    const viaCube = litFragment(renderer, cube.node);
    // The reflection (roughness 0.6) and the diffuse light (roughness 1) both read the cube texture with a level.
    expect(viaCube).toMatch(/texture_cube<f32>/);
    expect(viaCube.match(/textureSampleLevel\(\s*\w+,\s*\w+_sampler/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(viaCube).toContain(`* ${ENVIRONMENT_CUBE_ROUGH_LEVELS}.0`);
    // Three's own path for the same lighting decodes the atlas (a 2D texture, faces chosen per fragment).
    const pmrem = new THREE.Texture();
    pmrem.mapping = THREE.CubeUVReflectionMapping;
    pmrem.image = { width: 768, height: 1024 };
    const viaAtlas = litFragment(renderer, texture(pmrem));
    expect(viaAtlas).not.toMatch(/texture_cube<f32>/);
    expect(viaCube.length).toBeLessThan(viaAtlas.length);
    expect(ENVIRONMENT_CUBE_SIZE >> ENVIRONMENT_CUBE_ROUGH_LEVELS).toBeGreaterThanOrEqual(16);
    cube.dispose();
  });
});
