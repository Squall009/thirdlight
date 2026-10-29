/**
 * The clustered local lights at three's own node builders (the
 * programs a real build makes for WebGPU and WebGL 2, no GPU): one loop over
 * the pixel's cell's list reads every listed light from the one packed
 * texture, so the program is the same whatever the number of point and spot
 * lights, whichever are on and wherever they are; area lights are drawn
 * with three's rectangle-light maths in the same loop; shadowed spot, point
 * and area lights are listed too, their shadows read from the shadow atlas
 * with hardware depth compares (one texture unit, built only while a listed
 * light casts), and a spot's cookie from the cookie atlas, the light tables'
 * texture (no unit of its own); three keeps no light of its own for any of
 * them; a build in mode `none` reads no list; the layer and room test is
 * built only for layered lights.
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
import { SURFACE_READ } from './surface-cache-lookup';
import { SurfaceCacheTextures } from './surface-cache-read';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';

/**
 * A renderer that has built the clustered lights once: three emits the shared functions (`Fn` with a layout,
 * the LTC ones here) in another order in a renderer's first build than in later ones, so programs are compared
 * after one.
 */
const box = (m: THREE.Material): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(), m);

function renderer(): WebGPURenderer {
  const r = wgslRenderer();
  registerProbeLighting(r as never);
  registerClusteredLights(r as never);
  const warm = litScene();
  warm.add(new ClusteredLights(new ClusterGpu(new ClusterTextures())));
  wgslOf(r, warm, box(new THREE.MeshStandardMaterial()));
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
  // WebGL 2 compares depth in hardware (its backend's answer; it is not initialized here).
  (r as unknown as { hasCompatibility: () => boolean }).hasCompatibility = () => true;
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

  it('list point and spot lights with shadows and cookies too (three builds none), and a build in mode none without lists', () => {
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
    const shadowedSpot = new THREE.SpotLight('#ffffff', 2, 5);
    shadowedSpot.castShadow = true;
    for (const l of [shadowed, cookie, shadowedSpot, new THREE.PointLight()]) expect(drawsClustered(l)).toBe(true);
    expect(drawsClustered(new THREE.DirectionalLight())).toBe(false);
    scene.add(cookie, shadowed);
    // No node of three's for either: the same program (their shadow and cookie reads are the light's flags).
    const withCookie = wgslOf(r, scene, box(mat));
    expect(withCookie).toBe(listed);
    const none = wgslOf(r, scene, box(localLightVariant(mat, 'none')));
    expect(none).not.toContain('tlClusterLightsCount');
    expect(none).not.toMatch(/texture_2d<u32>/);
  });

  it('read shadows from the atlas with four depth compares a light kind, only while a listed light casts', () => {
    const r = renderer();
    // Hardware depth compares (what the device offers; no device here).
    (r as unknown as { hasCompatibility: () => boolean }).hasCompatibility = () => true;
    const scene = litScene();
    const clustered = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
    scene.add(clustered);
    const units = (src: string): number => (src.match(/:\s*texture_/g) ?? []).length;
    const plain = wgslOf(r, scene, box(new THREE.MeshStandardMaterial()));
    expect(plain).not.toMatch(/texture_depth_2d/);
    clustered.shadows = true;
    const shadowed = wgslOf(r, scene, box(new THREE.MeshStandardMaterial()));
    // One unit more (the atlas, a depth texture with a comparison sampler); four compares a spot's, four a point
    // light's faces' (and four an area light's, while area lights are built).
    expect(units(shadowed)).toBe(units(plain) + 1);
    expect(shadowed).toMatch(/texture_depth_2d/);
    expect(shadowed).toMatch(/sampler_comparison/);
    expect((shadowed.match(/textureSampleCompare\(/g) ?? []).length).toBe(8);
    // The same on Lambert, and on WebGL 2 through a shadow sampler.
    expect((wgslOf(r, scene, box(new THREE.MeshLambertMaterial())).match(/textureSampleCompare\(/g) ?? []).length).toBe(8);
    clustered.areas = true;
    expect((wgslOf(r, scene, box(new THREE.MeshStandardMaterial())).match(/textureSampleCompare\(/g) ?? []).length).toBe(12);
    clustered.areas = false;
    const glsl = glslOf(scene, box(new THREE.MeshStandardMaterial()));
    expect(glsl).toMatch(/sampler2DShadow/);
    // Any number of shadowed spot and point lights: the same program.
    const lamps2 = (n: number): string => {
      const s = litScene();
      const c = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
      c.shadows = true;
      s.add(c);
      for (let i = 0; i < n; i += 1) {
        const l = i % 2 === 0 ? new THREE.SpotLight('#ffffff', 3, 6, 0.5) : new THREE.PointLight('#ffffff', 3, 6);
        l.castShadow = true;
        l.position.set(i, 3, 0);
        s.add(l);
      }
      return wgslOf(r, s, box(new THREE.MeshStandardMaterial()));
    };
    expect(lamps2(1)).toBe(lamps2(12));
  });

  it('read cookies from the light tables\' texture (no unit of its own), only while a spot projects one', () => {
    const r = renderer();
    const scene = litScene();
    const clustered = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
    scene.add(clustered);
    const units = (src: string): number => (src.match(/:\s*texture_/g) ?? []).length;
    const plain = wgslOf(r, scene, box(new THREE.MeshStandardMaterial()));
    clustered.cookies = true;
    const cookies = wgslOf(r, scene, box(new THREE.MeshStandardMaterial()));
    expect(cookies).not.toBe(plain);
    expect(units(cookies)).toBe(units(plain) + 1);
    // With area lights too: the LTC tables and the cookies are one texture.
    clustered.areas = true;
    const both = wgslOf(r, scene, box(new THREE.MeshStandardMaterial()));
    clustered.cookies = false;
    const areas = wgslOf(r, scene, box(new THREE.MeshStandardMaterial()));
    expect(units(both)).toBe(units(areas));
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
    const shifts = (src: string): number => (src.match(/ >> /g) ?? []).length;
    expect(shifts(layered)).toBeGreaterThan(shifts(plain));
  });

  it('shade area lights with three\'s rectangle-light maths on the physical model and as a form factor through direct on the others', () => {
    const r = renderer();
    const scene = litScene();
    const clustered = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
    scene.add(clustered);
    const without = wgslOf(r, scene, box(new THREE.MeshStandardMaterial()));
    // Built only while an area light is realized (their code costs every lit pixel): then one texture more, the LTC tables.
    clustered.areas = true;
    const physical = wgslOf(r, scene, box(new THREE.MeshStandardMaterial()));
    const units = (src: string): number => (src.match(/:\s*texture_/g) ?? []).length;
    expect(without).not.toMatch(/LTC_Evaluate\(/);
    expect(units(physical)).toBe(units(without) + 1);
    const lambert = wgslOf(r, scene, box(new THREE.MeshLambertMaterial()));
    // The specular and diffuse forms (two LTC integrals) on the physical model, one on Lambert; both tables read at level 0 from one texture.
    const calls = (src: string): number => (src.match(/LTC_Evaluate\(/g) ?? []).length;
    expect(calls(physical)).toBeGreaterThanOrEqual(2);
    expect(calls(lambert)).toBe(1);
    expect(physical).toMatch(/textureSampleLevel\(/);
    expect(physical).not.toMatch(/LTC_Uv[^\n]*\n[^\n]*textureSample\(/);
    const glsl = glslOf(scene, box(new THREE.MeshStandardMaterial()));
    expect(glsl).toMatch(/textureLod\(/);
    expect(glsl).toMatch(/LTC_Evaluate\(/);
  });

  it('on a surface reading the cache, sum the lights the cache does not hold apart only while some are in the scene', () => {
    const r = renderer();
    const scene = litScene();
    const clustered = new ClusteredLights(new ClusterGpu(new ClusterTextures()));
    scene.add(clustered);
    const reading = (): string => wgslOf(r, scene, box(localLightVariant(new THREE.MeshStandardMaterial(), 'pixel', { kind: SURFACE_READ.model, textures: new SurfaceCacheTextures(4, 7) })));
    const plain = reading();
    expect(plain).toContain('tlClusterLightsCount');
    expect(plain).not.toMatch(/& 8\b/);
    clustered.uncached = true;
    const split = reading();
    // The record's uncached bit decides which sums a light's terms go to.
    expect(split).not.toBe(plain);
    expect(split).toMatch(/& 8\b/);
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
