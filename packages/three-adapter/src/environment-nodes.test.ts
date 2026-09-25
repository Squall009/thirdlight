/**
 * Phase 17.3: the environment renderer on WebGPURenderer (no GPU: the node
 * construction and the decisions — which sky, which post plan, when the
 * pipeline is rebuilt). The pixels are checked by the environment parity e2e
 * (`tests/e2e/env-parity.e2e.ts`) on WebGL 2 and WebGPU. three's node PMREM
 * generator and the pipeline itself need a live renderer, so they are
 * replaced by recorders here.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';

import type { FogVolumeBox, PostPlan } from './environment-nodes';

const built: { plan: PostPlan; updates: FogVolumeBox[][]; renders: number; disposed: boolean; luts: (THREE.Texture | null)[] }[] = [];

vi.mock('three/webgpu', async (importOriginal) => {
  const real = await importOriginal<typeof import('three/webgpu')>();
  class PMREMGenerator {
    fromScene(): { texture: THREE.Texture; dispose(): void } {
      return { texture: new THREE.Texture(), dispose: () => undefined };
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
      const rec = { plan, updates: [] as FogVolumeBox[][], renders: 0, disposed: false, luts: [] as (THREE.Texture | null)[] };
      built.push(rec);
      const passes = ['render', ...(plan.ssao ? ['ssao'] : []), ...(plan.fogVolumes ? ['fogVolumes'] : []), ...(plan.dof ? ['dof'] : []), ...(plan.bloom ? ['bloom'] : []), 'output', ...(plan.grading ? ['grading'] : []), ...(plan.aa !== 'none' ? [plan.aa] : [])];
      return {
        passes,
        update: (_c: unknown, v: FogVolumeBox[]) => rec.updates.push(v),
        setLut: (t: THREE.Texture | null) => rec.luts.push(t),
        setSize: () => undefined,
        render: () => (rec.renders += 1),
        dispose: () => (rec.disposed = true),
      };
    },
  };
});

const { createEnvironmentRenderer } = await import('./environment');

function nodeRenderer(): THREE.WebGLRenderer & { render: ReturnType<typeof vi.fn> } {
  return { isWebGPURenderer: true, toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, samples: 4, getPixelRatio: () => 1, render: vi.fn() } as unknown as THREE.WebGLRenderer & { render: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  built.length = 0;
  vi.restoreAllMocks();
});

describe('environment renderer on WebGPURenderer (phase 17.3)', () => {
  it('draws the physical and gradient skies as node materials with image-based lighting', () => {
    const scene = new THREE.Scene();
    const env = createEnvironmentRenderer(nodeRenderer(), scene, { loadTexture: async () => null });
    env.setKeyLightDirection([0, -1, -1]);
    env.set({ sky: { mode: 'procedural', turbidity: 4 } });
    const sky = scene.children.find((o) => (o as { isSkyMesh?: boolean }).isSkyMesh === true) as unknown as { turbidity: { value: number }; cloudSpeed: { value: number }; sunPosition: { value: THREE.Vector3 } };
    expect(sky).toBeDefined();
    expect(sky.turbidity.value).toBe(4);
    expect(sky.cloudSpeed.value).toBe(0); // clouds stand still, like the legacy sky
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

  it('plans the post stack per quality level, never builds an EffectComposer, and rebuilds only on a change', () => {
    const composerRender = vi.spyOn(EffectComposer.prototype, 'render');
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
    expect(composerRender).not.toHaveBeenCalled();
    expect(built).toHaveLength(1);
    const plan = built[0]!.plan;
    expect(plan.bloom).toEqual({ strength: 1.5, radius: 0.4, threshold: 0.85 });
    expect(plan.ssao).toEqual({ radius: 0.3, intensity: 1 });
    expect(plan.dof).toEqual({ focus: 4, aperture: 0.002, maxBlur: 0.01 });
    expect(plan.grading).toMatchObject({ lift: 0.2, gamma: 1, gain: 1, vignette: 0.7 });
    expect(plan.aa).toBe('smaa');
    expect(plan.samples).toBe(0); // like the legacy composer: no MSAA in the post stack
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
