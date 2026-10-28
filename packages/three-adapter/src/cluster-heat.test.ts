/**
 * The light clusters' heat map at three's own node builders (the programs a
 * real build makes, no GPU): it reads the packed lists as integers and
 * floats with texel loads only, loops over a cell's list, replaces the lit
 * result in every lit build (the probe light's, the sun's), leaves a build
 * in mode `none` without the lists, and a scene without it builds the
 * programs it built before.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WebGPURenderer } from 'three/webgpu';

import { ClusterGpu } from './cluster-gpu';
import { ClusterHeatLight, registerClusterHeat } from './cluster-heat';
import { ClusterTextures } from './cluster-pack';
import { localLightVariant } from './local-lights';
import { registerProbeLighting } from './probe-lighting';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';

function renderer(): WebGPURenderer {
  const r = wgslRenderer();
  registerProbeLighting(r as never);
  registerClusterHeat(r as never);
  return r;
}

/** The GLSL three's WebGL 2 backend builds for a mesh (its builder runs without a context). */
function glslOf(scene: THREE.Scene, mesh: THREE.Mesh): string {
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null };
  const r = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL: true });
  registerProbeLighting(r as never);
  registerClusterHeat(r as never);
  const lights: THREE.Light[] = [];
  scene.traverse((o) => void ((o as THREE.Light).isLight === true && lights.push(o as THREE.Light)));
  const backend = (r as unknown as { backend: { createNodeBuilder(o: THREE.Object3D, r: WebGPURenderer): { scene: THREE.Scene; camera: THREE.Camera; material: THREE.Material; lightsNode: unknown; build(): void; fragmentShader: string } } }).backend;
  const b = backend.createNodeBuilder(mesh, r);
  b.scene = scene;
  b.camera = new THREE.PerspectiveCamera();
  b.material = mesh.material as THREE.Material;
  const lightsNode = r.lighting.getNode(scene) as unknown as { setLights(l: THREE.Light[]): void };
  lightsNode.setLights(lights);
  b.lightsNode = lightsNode;
  b.build();
  return b.fragmentShader;
}

describe('the light clusters heat map', () => {
  it('reads the lists with integer and float texel loads, loops over a cell, and is the last word on the lit result', () => {
    const r = renderer();
    const scene = litScene();
    const mat = new THREE.MeshStandardMaterial();
    const plain = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), mat));
    expect(plain).not.toContain('tlClusterListed');
    const heat = new ClusterHeatLight(new ClusterGpu(new ClusterTextures()));
    scene.add(heat);
    const w = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), mat));
    // The headers and lists as unsigned integers, the records as floats: loads only, no sampler.
    expect(w).toMatch(/texture_2d<u32>/);
    expect(w).toMatch(/texture_2d<f32>/);
    expect(w).toMatch(/textureLoad\(/);
    expect(w).toContain('tlClusterListed');
    expect(w).toMatch(/for \(/);
    // Built after the sun: the direct light it replaces is assigned after the sun's is added.
    const frag = w.slice(w.indexOf('fn main'));
    expect(frag.lastIndexOf('tlClusterListed')).toBeGreaterThan(0);
    // A build without local lights reads no list.
    const none = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), localLightVariant(mat, 'none')));
    expect(none).toContain('tlClusterListed');
    expect(none).not.toMatch(/texture_2d<u32>/);
    // Gone again: the programs of before.
    heat.removeFromParent();
    expect(wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), mat))).toBe(plain);
  });

  it('builds for WebGL 2 with texelFetch on an unsigned integer sampler', () => {
    const scene = litScene();
    scene.add(new ClusterHeatLight(new ClusterGpu(new ClusterTextures())));
    const f = glslOf(scene, new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    expect(f).toMatch(/usampler2D/);
    expect(f).toMatch(/texelFetch\(/);
    expect(f).toContain('tlClusterListed');
  });
});
