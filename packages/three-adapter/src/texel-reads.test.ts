import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { installTexelReads, neverFlipped } from './texel-reads';

/** The vertex GLSL WebGL 2 builds for a mesh whose position reads one texel of `tex`. */
function glslReading(tex: THREE.Texture): string {
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null };
  const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL: true });
  const material = new MeshBasicNodeMaterial();
  material.positionNode = TSL.positionLocal.add(TSL.textureLoad(tex, TSL.ivec2(1, 2)).xyz);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const backend = (renderer as unknown as { backend: { createNodeBuilder(o: THREE.Object3D, r: WebGPURenderer): Record<string, unknown> & { build(): void; vertexShader: string } } }).backend;
  const b = backend.createNodeBuilder(mesh, renderer);
  b['scene'] = scene;
  b['camera'] = new THREE.PerspectiveCamera();
  b['material'] = material;
  b['lightsNode'] = renderer.lighting.getNode(scene);
  b.build();
  return b.vertexShader;
}

describe('texel reads of data textures', () => {
  it('reads a data texture on WebGL 2 at the coordinates given: no flip uniform, no size to flip with', () => {
    const data = new THREE.DataTexture(new Float32Array(16 * 4), 4, 4, THREE.RGBAFormat, THREE.FloatType);
    const before = glslReading(data);
    // three's own build: the row flipped by a uniform three sets for every draw (false for a data texture).
    expect(before).toMatch(/textureSize/);
    installTexelReads();
    const after = glslReading(data);
    expect(after).not.toMatch(/textureSize/);
    expect(after).toMatch(/texelFetch/);
    // A render target's texture keeps the flip it needs.
    const target = new THREE.RenderTarget(4, 4);
    expect(glslReading(target.texture)).toMatch(/textureSize/);
  });

  it('counts only data textures that three never flips', () => {
    expect(neverFlipped(new THREE.DataTexture())).toBe(true);
    expect(neverFlipped(new THREE.DataArrayTexture())).toBe(true);
    expect(neverFlipped(new THREE.Texture())).toBe(false);
    expect(neverFlipped(new THREE.RenderTarget(1, 1).texture)).toBe(false);
    expect(neverFlipped(new THREE.DepthTexture(1, 1))).toBe(false);
    expect(neverFlipped(null)).toBe(false);
  });
});
