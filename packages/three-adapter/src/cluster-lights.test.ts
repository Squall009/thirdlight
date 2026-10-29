/**
 * The clustered point and spot lights at three's own node builders (the
 * programs a real build makes for WebGPU and WebGL 2, no GPU): one loop over
 * the pixel's cell's list reads every listed light from the one packed
 * texture, so the program is the same whatever the number of point and spot
 * lights, whichever are on and wherever they are; a light with a shadow or a
 * cookie keeps three's own node; a build in mode `none` reads no list; the
 * layer and room test is built only for layered lights.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WebGPURenderer } from 'three/webgpu';

import { ClusterGpu } from './cluster-gpu';
import { ClusteredLights, drawsClustered, registerClusteredLights } from './cluster-lights';
import { ClusterTextures } from './cluster-pack';
import { LayeredPointLight } from './light-layers';
import { localLightVariant } from './local-lights';
import { registerProbeLighting } from './probe-lighting';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';

function renderer(): WebGPURenderer {
  const r = wgslRenderer();
  registerProbeLighting(r as never);
  registerClusteredLights(r as never);
  return r;
}

function lamps(scene: THREE.Scene, n: number, offset = 0): THREE.Light[] {
  const out: THREE.Light[] = [];
  for (let i = 0; i < n; i += 1) {
    const l = i % 3 === 2 ? new THREE.SpotLight('#ffcc88', 4, 6, 0.6, 0.3) : new THREE.PointLight('#88ccff', 3, i % 2 === 0 ? 5 : 0);
    l.position.set(i + offset, 2, -i);
    scene.add(l);
    out.push(l);
  }
  return out;
}

/** The GLSL three's WebGL 2 backend builds for a mesh (its builder runs without a context). */
function glslOf(scene: THREE.Scene, mesh: THREE.Mesh): string {
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null };
  const r = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, forceWebGL: true });
  registerProbeLighting(r as never);
  registerClusteredLights(r as never);
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

const box = (m: THREE.Material): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(), m);

describe('the clustered lights', () => {
  it('draw any number of point and spot lights with one program: one list texture, one loop, no light of three', () => {
    const r = renderer();
    const mat = new THREE.MeshStandardMaterial();
    const base = litScene();
    const plain = wgslOf(r, base, box(mat));
    const shapes = [0, 1, 16, 40].map((n) => {
      const scene = litScene();
      scene.add(new ClusteredLights(new ClusterGpu(new ClusterTextures())));
      const ls = lamps(scene, n);
      // Some switched off: they change nothing either.
      for (let i = 0; i < ls.length; i += 4) ls[i]!.visible = false;
      return wgslOf(r, scene, box(mat));
    });
    for (const s of shapes) expect(s).toBe(shapes[0]);
    const w = shapes[0]!;
    // One texture unit more than the sun and the ambient light alone, read with loads (no sampler); a loop.
    const units = (src: string): number => (src.match(/:\s*texture_/g) ?? []).length;
    expect(units(w)).toBe(units(plain) + 1);
    expect(w).toMatch(/texture_2d<u32>/);
    expect(w).toMatch(/textureLoad\(/);
    expect(w).toMatch(/for \(/);
    expect(w).toContain('tlClusterLightsCount');
    // Without the clustered lights' object three draws its own point lights (a scene of another page).
    const own = litScene();
    lamps(own, 2);
    expect(wgslOf(r, own, box(mat))).not.toContain('tlClusterLightsCount');
    expect(wgslOf(r, own, box(mat))).not.toBe(plain);
  });

  it('leave a light with a shadow or a cookie to three, and a build in mode none without lists', () => {
    const r = renderer();
    const mat = new THREE.MeshStandardMaterial();
    const scene = litScene();
    scene.add(new ClusteredLights(new ClusterGpu(new ClusterTextures())));
    lamps(scene, 4);
    const listed = wgslOf(r, scene, box(mat));
    const shadowed = new THREE.PointLight('#ffffff', 2, 5);
    shadowed.castShadow = true;
    const cookie = new THREE.SpotLight('#ffffff', 2, 5);
    cookie.map = new THREE.Texture();
    expect(drawsClustered(shadowed)).toBe(false);
    expect(drawsClustered(cookie)).toBe(false);
    expect(drawsClustered(new THREE.PointLight())).toBe(true);
    expect(drawsClustered(new THREE.DirectionalLight())).toBe(false);
    scene.add(cookie);
    // Three's spot node with its cookie: another program, the loop still in it.
    const withCookie = wgslOf(r, scene, box(mat));
    expect(withCookie).not.toBe(listed);
    expect(withCookie).toContain('tlClusterLightsCount');
    const none = wgslOf(r, scene, box(localLightVariant(mat, 'none')));
    expect(none).not.toContain('tlClusterLightsCount');
    expect(none).not.toMatch(/texture_2d<u32>/);
  });

  it('test layers and rooms only while a listed light is layered', () => {
    const r = renderer();
    const mat = new THREE.MeshStandardMaterial();
    const scene = litScene();
    const clustered = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
    scene.add(clustered);
    scene.add(new LayeredPointLight('#ffffff', 2, 5));
    const plain = wgslOf(r, scene, box(mat));
    clustered.layered = true;
    const layered = wgslOf(r, scene, box(mat));
    expect(layered).not.toBe(plain);
    // The layer word's bits against the object's (a per-object uniform), its room shifted above them.
    const shifts = (src: string): number => (src.match(/>>/g) ?? []).length;
    expect(shifts(layered)).toBeGreaterThan(shifts(plain));
  });

  it('build for WebGL 2 with texelFetch on an unsigned integer sampler, the records bit-cast', () => {
    const scene = litScene();
    scene.add(new ClusteredLights(new ClusterGpu(new ClusterTextures())));
    lamps(scene, 20);
    const f = glslOf(scene, box(new THREE.MeshLambertMaterial()));
    expect(f).toMatch(/usampler2D/);
    expect(f).toMatch(/uintBitsToFloat\(/);
    expect(f).toMatch(/texelFetch\(/);
    expect(f).toContain('tlClusterLightsCount');
    // No uniform per light: twenty lamps add no point or spot light uniforms.
    expect(f).not.toMatch(/pointLight|spotLight/i);
  });
});
