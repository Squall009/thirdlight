/**
 * The environment renderer on WebGPURenderer (no GPU: the node
 * construction and the decisions — which sky, which post plan, when the
 * pipeline is rebuilt). The pixels are checked by the environment parity e2e
 * (`tests/e2e/env-parity.e2e.ts`) on WebGL 2 and WebGPU. three's node PMREM
 * generator and the pipeline itself need a live renderer, so they are
 * replaced by recorders here.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WebGPURenderer } from 'three/webgpu';

import type { FogVolumeBox, PostPlan } from './environment-nodes';

/** Each PMREM scene bake — into a new target or the one given. */
const pmremBakes: ('new' | 'reused')[] = [];
const built: { plan: PostPlan; updates: FogVolumeBox[][]; renders: number; disposed: boolean; luts: (THREE.Texture | null)[]; params: Pick<PostPlan, 'grading' | 'bloom'>[] }[] = [];

vi.mock('three/webgpu', async (importOriginal) => {
  const real = await importOriginal<typeof import('three/webgpu')>();
  class PMREMGenerator {
    fromScene(_s: unknown, _sigma?: number, _near?: number, _far?: number, options?: { renderTarget?: { texture: THREE.Texture; dispose(): void } }): { texture: THREE.Texture; dispose(): void } {
      pmremBakes.push(options?.renderTarget !== undefined ? 'reused' : 'new');
      return options?.renderTarget ?? { texture: new THREE.Texture(), dispose: () => undefined };
    }
    fromEquirectangular(): { texture: THREE.Texture; dispose(): void } {
      return { texture: new THREE.Texture(), dispose: () => undefined };
    }
    fromCubemap(): { texture: THREE.Texture; dispose(): void } {
      return { texture: new THREE.Texture(), dispose: () => undefined };
    }
    dispose(): void {}
  }
  return { ...real, PMREMGenerator };
});
vi.mock('./environment-nodes', async (importOriginal) => {
  const real = await importOriginal<typeof import('./environment-nodes')>();
  return {
    ...real,
    buildPostPipeline: (_renderer: unknown, _scene: unknown, _camera: unknown, plan: PostPlan) => {
      const rec = { plan, updates: [] as FogVolumeBox[][], renders: 0, disposed: false, luts: [] as (THREE.Texture | null)[], params: [] as Pick<PostPlan, 'grading' | 'bloom'>[] };
      built.push(rec);
      const passes = ['render', ...(plan.ssao ? ['ssao'] : []), ...(plan.fogVolumes ? ['fogVolumes'] : []), ...(plan.dof ? ['dof'] : []), ...(plan.bloom ? ['bloom'] : []), 'output', ...(plan.grading ? ['grading'] : []), ...(plan.aa !== 'none' ? [plan.aa] : [])];
      return {
        passes,
        update: (_c: unknown, v: FogVolumeBox[]) => rec.updates.push(v),
        setLut: (t: THREE.Texture | null) => rec.luts.push(t),
        setSize: () => undefined,
        setParams: (p: Pick<PostPlan, 'grading' | 'bloom'>) => rec.params.push(p),
        render: () => (rec.renders += 1),
        dispose: () => (rec.disposed = true),
      };
    },
  };
});

const { createEnvironmentRenderer, skyInputsDiffer, SKY_REBAKE_THRESHOLD } = await import('./environment');

function nodeRenderer(): WebGPURenderer & { render: ReturnType<typeof vi.fn> } {
  return { isWebGPURenderer: true, toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, samples: 4, getPixelRatio: () => 1, render: vi.fn() } as unknown as WebGPURenderer & { render: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  built.length = 0;
  vi.restoreAllMocks();
});

describe('environment renderer on WebGPURenderer', () => {
  it('draws the physical and gradient skies as node materials with image-based lighting', () => {
    const scene = new THREE.Scene();
    const env = createEnvironmentRenderer(nodeRenderer(), scene, { loadTexture: async () => null });
    env.setKeyLightDirection([0, -1, -1]);
    env.set({ sky: { mode: 'procedural', turbidity: 4 } });
    const sky = scene.children.find((o) => (o as { isSkyMesh?: boolean }).isSkyMesh === true) as unknown as { turbidity: { value: number }; cloudSpeed: { value: number }; sunPosition: { value: THREE.Vector3 } };
    expect(sky).toBeDefined();
    expect(sky.turbidity.value).toBe(4);
    expect(sky.cloudSpeed.value).toBe(0); // clouds stand still, like the archived WebGL sky
    expect(sky.sunPosition.value.toArray().map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([0, 0.707, 0.707]);
    expect(scene.environment).not.toBeNull();

    env.set({ sky: { mode: 'gradient', topColor: '#0000ff' } });
    expect(scene.children.some((o) => (o as { isSkyMesh?: boolean }).isSkyMesh === true)).toBe(false);
    const dome = scene.children.find((o) => (o as THREE.Mesh).isMesh === true) as THREE.Mesh;
    const m = dome.material as THREE.Material & { isNodeMaterial?: boolean; fog: boolean; vertexNode: unknown; colorNode: unknown };
    expect(m.isNodeMaterial).toBe(true);
    expect(m.side).toBe(THREE.BackSide);
    expect(m.fog).toBe(false);
    expect(m.vertexNode).not.toBeNull(); // on the far plane
    expect(m.colorNode).not.toBeNull();
    expect(scene.environment).not.toBeNull();
    env.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('plans the post stack per quality level and rebuilds only on a change (not on same-size frames)', () => {
    const renderer = nodeRenderer();
    const scene = new THREE.Scene();
    const env = createEnvironmentRenderer(renderer, scene, { loadTexture: async () => null });
    const camera = new THREE.PerspectiveCamera();
    env.set({
      quality: 'high',
      post: { toneMapping: 'aces', bloom: { enabled: true, strength: 1.5 }, ssao: { enabled: true, radius: 0.3 }, dof: { enabled: true, focus: 4 }, grading: { lift: 0.2 }, vignette: { enabled: true, darkness: 0.7 }, antialias: 'smaa' },
    });
    for (let i = 0; i < 5; i++) {
      env.resize(800, 600);
      env.render(camera);
    }
    expect(built).toHaveLength(1);
    const plan = built[0]!.plan;
    expect(plan.bloom).toEqual({ strength: 1.5, radius: 0.4, threshold: 0.85 });
    expect(plan.ssao).toEqual({ radius: 0.3, intensity: 1 });
    expect(plan.dof).toEqual({ focus: 4, aperture: 0.002, maxBlur: 0.01 });
    expect(plan.grading).toMatchObject({ lift: 0.2, gamma: 1, gain: 1, vignette: 0.7 });
    expect(plan.aa).toBe('smaa');
    expect(plan.samples).toBe(0); // like the archived EffectComposer: no MSAA in the post stack
    expect(plan.displayBackground).toBe(false);
    expect(built[0]!.renders).toBe(5);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(env.diagnostics()).toMatchObject({ post: true, passes: ['render', 'ssao', 'dof', 'bloom', 'output', 'grading', 'smaa'], fallback: null });
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);

    // Low quality: bloom, AO, depth of field and anti-aliasing drop out; grading stays.
    env.setQuality('low');
    env.render(camera);
    expect(built).toHaveLength(2);
    expect(built[0]!.disposed).toBe(true);
    expect(built[1]!.plan).toMatchObject({ bloom: null, ssao: null, dof: null, aa: 'none' });
    expect(env.diagnostics().passes).toEqual(['render', 'output', 'grading']);
    env.dispose();
    expect(built[1]!.disposed).toBe(true);
  });

  it('a blend changes sky, fog, exposure and grading in place; different skies cross-fade as layers', () => {
    const renderer = nodeRenderer();
    const scene = new THREE.Scene();
    const env = createEnvironmentRenderer(renderer, scene, { loadTexture: async () => null });
    const camera = new THREE.PerspectiveCamera();
    const base = { sky: { mode: 'gradient' as const, topColor: '#4080ff' }, fog: { mode: 'linear' as const, color: '#ffffff', near: 10, far: 80 }, post: { grading: { contrast: 0.1 } } };
    env.set(base);
    env.render(camera);
    const dome = scene.children.find((o) => (o as THREE.Mesh).isMesh === true) as THREE.Mesh;
    const fog = scene.fog as THREE.Fog;
    expect(built).toHaveLength(1);
    // Mid-blend: the same dome and fog object, new numbers; the same post stack with new uniforms.
    env.setBlend({ sky: { mode: 'gradient', topColor: '#102040' }, fog: { mode: 'linear', color: '#808080', near: 5, far: 40 }, post: { exposure: 0.5, grading: { contrast: 0.3 } } });
    env.render(camera);
    expect(scene.children.filter((o) => (o as THREE.Mesh).isMesh === true)).toEqual([dome]);
    const u = ((dome.material as THREE.Material).userData as { skyUniforms: { top: { value: THREE.Color } } }).skyUniforms;
    expect(u.top.value.getHexString()).toBe('102040');
    expect(scene.fog).toBe(fog);
    expect([fog.color.getHexString(), fog.near, fog.far]).toEqual(['808080', 5, 40]);
    expect(renderer.toneMappingExposure).toBe(0.5);
    expect(built).toHaveLength(1);
    expect(built[0]!.params.at(-1)!.grading).toMatchObject({ contrast: 0.3 });
    // Two different skies: layers over the background, opacity = share.
    env.setBlend({ skyLayers: [{ sky: { mode: 'gradient', topColor: '#102040' }, weight: 0.75 }, { sky: { mode: 'color', color: '#ff0000' }, weight: 0.25 }] });
    const layers = scene.children.filter((o) => (o as THREE.Mesh).isMesh === true) as THREE.Mesh[];
    expect(layers).toHaveLength(2);
    expect(layers.map((l) => (l.material as THREE.Material).opacity)).toEqual([1, 0.25]);
    expect(layers.every((l) => (l.material as THREE.Material).transparent)).toBe(true);
    // Back to the environment: one dome with the base colours, the base fog and exposure.
    env.setBlend(null);
    const back = scene.children.filter((o) => (o as THREE.Mesh).isMesh === true) as THREE.Mesh[];
    expect(back).toHaveLength(1);
    expect(((back[0]!.material as THREE.Material).userData as { skyUniforms: { top: { value: THREE.Color } } }).skyUniforms.top.value.getHexString()).toBe('4080ff');
    expect((scene.fog as THREE.Fog).far).toBe(80);
    expect(renderer.toneMappingExposure).toBe(1);
    env.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('a blended sky re-bakes its lighting into the same target, only past the threshold, at most every 30th frame', () => {
    const renderer = nodeRenderer();
    const scene = new THREE.Scene();
    const env = createEnvironmentRenderer(renderer, scene, { loadTexture: async () => null });
    const camera = new THREE.PerspectiveCamera();
    const frames = (n: number): void => {
      for (let i = 0; i < n; i += 1) env.render(camera);
    };
    pmremBakes.length = 0;
    env.set({ sky: { mode: 'procedural', turbidity: 6, sunFromLight: false, sunElevation: 30 } });
    expect(pmremBakes).toEqual(['new']);
    const texture = scene.environment;
    frames(40);
    // Under the threshold (turbidity 0.5 %, the sun 0.3°): no re-bake, however many frames pass.
    env.setBlend({ sky: { mode: 'procedural', turbidity: 6.03, sunFromLight: false, sunElevation: 30.3 } });
    frames(60);
    expect(pmremBakes).toEqual(['new']);
    expect(env.diagnostics().iblRebakes).toBe(0);
    // Past it: one re-bake after at most 30 frames, into the same target (the scene keeps the same texture).
    env.setBlend({ sky: { mode: 'procedural', turbidity: 7, sunFromLight: false, sunElevation: 30.3 } });
    frames(30);
    expect(pmremBakes).toEqual(['new', 'reused']);
    expect(scene.environment).toBe(texture);
    expect(env.diagnostics().iblRebakes).toBe(1);
    // A new t every frame, each change small but adding up: re-baked against the last bake, not the last frame.
    for (let i = 1; i <= 90; i += 1) {
      env.setBlend({ sky: { mode: 'procedural', turbidity: 7 + i * 0.01, sunFromLight: false, sunElevation: 30.3 } });
      frames(1);
    }
    frames(30); // the ramp's last bake lands
    const rebakes = env.diagnostics().iblRebakes - 1;
    expect(rebakes).toBeGreaterThanOrEqual(2);
    expect(rebakes).toBeLessThanOrEqual(4);
    expect(pmremBakes.slice(1).every((b) => b === 'reused')).toBe(true);
    // Only fog and exposure change: nothing to re-bake.
    const before = pmremBakes.length;
    for (let i = 0; i < 60; i += 1) {
      env.setBlend({ sky: { mode: 'procedural', turbidity: 7.9, sunFromLight: false, sunElevation: 30.3 }, fog: { mode: 'exp2', color: '#808080', density: 0.01 + i * 0.001 }, post: { exposure: 1 - i * 0.01 } });
      frames(1);
    }
    expect(pmremBakes.length).toBe(before);
    // A gradient sky: the colours count in sRGB channels.
    env.setBlend(null);
    env.set({ sky: { mode: 'gradient', topColor: '#4080ff' } });
    pmremBakes.length = 0;
    env.setBlend({ sky: { mode: 'gradient', topColor: '#4081ff' } });
    frames(40);
    expect(pmremBakes).toEqual([]);
    env.setBlend({ sky: { mode: 'gradient', topColor: '#4090ff' } });
    frames(30);
    expect(pmremBakes).toEqual(['reused']);
    env.dispose();
  });

  it('sky input differences against the threshold', () => {
    const grey = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    expect(skyInputsDiffer('gradient', grey, grey.map((v) => v + SKY_REBAKE_THRESHOLD.color * 0.9))).toBe(false);
    expect(skyInputsDiffer('gradient', grey, grey.map((v, i) => (i === 8 ? v + SKY_REBAKE_THRESHOLD.color * 1.1 : v)))).toBe(true);
    const sun = (deg: number): number[] => [Math.cos(THREE.MathUtils.degToRad(deg)), Math.sin(THREE.MathUtils.degToRad(deg)), 0];
    const proc = (t: number, deg: number): number[] => [t, 1.5, 0.005, 0.8, ...sun(deg)];
    expect(skyInputsDiffer('procedural', proc(6, 10), proc(6, 10.4))).toBe(false);
    expect(skyInputsDiffer('procedural', proc(6, 10), proc(6, 10.6))).toBe(true);
    expect(skyInputsDiffer('procedural', proc(6, 10), proc(6.05, 10))).toBe(false);
    expect(skyInputsDiffer('procedural', proc(6, 10), proc(6.1, 10))).toBe(true);
    // Nothing baked yet (no inputs): always a difference.
    expect(skyInputsDiffer('procedural', proc(6, 10), [])).toBe(true);
  });

  it('fog volumes go to the pipeline as world boxes every frame (14.4 height falloff included)', () => {
    const env = createEnvironmentRenderer(nodeRenderer(), new THREE.Scene(), { loadTexture: async () => null });
    const camera = new THREE.PerspectiveCamera();
    env.set({ sky: { mode: 'color', color: '#808080' }, post: { toneMapping: 'none' } });
    env.setFogVolumes([{ center: [1, 2, 3], size: [2, 4, 6], density: 0.5, color: '#ffffff', heightFalloff: 0.8 }]);
    env.render(camera);
    expect(built).toHaveLength(1);
    expect(built[0]!.plan.fogVolumes).toBe(true);
    expect(built[0]!.updates[0]).toEqual([{ min: [0, 0, 0], max: [2, 4, 6], color: '#ffffff', density: 0.5, falloff: 0.5, heightFalloff: 0.8 }]);
    env.dispose();
  });

  it('without post, a colour or image sky is laid under the tone-mapped picture as it is (not post-processing)', () => {
    const renderer = nodeRenderer();
    const scene = new THREE.Scene();
    const env = createEnvironmentRenderer(renderer, scene, { loadTexture: async () => null });
    const camera = new THREE.PerspectiveCamera();
    env.set({ sky: { mode: 'color', color: '#7ec8ff' } }); // AgX by default
    env.render(camera);
    expect(built).toHaveLength(1);
    expect(built[0]!.plan).toMatchObject({ displayBackground: true, samples: 4, bloom: null, grading: null, aa: 'none', fogVolumes: false });
    expect(env.diagnostics()).toMatchObject({ post: false, passes: [] });
    // No tone mapping: the renderer draws the frame itself.
    env.set({ sky: { mode: 'color', color: '#7ec8ff' }, post: { toneMapping: 'none' } });
    env.render(camera);
    expect(built[0]!.disposed).toBe(true);
    expect(built).toHaveLength(1);
    expect(renderer.render).toHaveBeenCalledWith(scene, camera);
    // The low level has no anti-aliasing: a plain scene pass without MSAA.
    env.setQuality('low');
    env.render(camera);
    expect(built).toHaveLength(2);
    expect(built[1]!.plan).toMatchObject({ samples: 0, displayBackground: false });
    env.dispose();
  });
});
