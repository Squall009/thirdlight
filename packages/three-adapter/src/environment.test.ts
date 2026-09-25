/**
 * The environment renderer's post stack lifetime (no WebGL needed): Play
 * reports the canvas size every frame, and a same-size resize must not
 * rebuild the composer — each rebuild allocates every pass's render targets
 * and programs. A real size change rebuilds once and frees the old passes.
 *
 * Phase 14.4: a level's look laid over the project environment.
 * Pure (no WebGL): the merge rule the renderer, Play, the export and the
 * editor's Scene view share.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { createEnvironmentRenderer, environmentHasLook, layerEnvironment, type EnvironmentLike } from './environment';

/** Just what building a composer reads from the renderer. */
function fakeRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    getPixelRatio: () => 1,
    getSize: (v: THREE.Vector2) => v.set(800, 600),
    render: () => undefined,
  } as unknown as THREE.WebGLRenderer;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('environment renderer post stack', () => {
  it('builds the composer once across same-size frames and frees every pass on a real resize', () => {
    const composerRender = vi.spyOn(EffectComposer.prototype, 'render').mockImplementation(() => undefined);
    const addPass = vi.spyOn(EffectComposer.prototype, 'addPass');
    const bloomDispose = vi.spyOn(UnrealBloomPass.prototype, 'dispose');
    const outputDispose = vi.spyOn(OutputPass.prototype, 'dispose');
    const env = createEnvironmentRenderer(fakeRenderer(), new THREE.Scene(), { loadTexture: async () => null });
    env.set({ quality: 'high', post: { bloom: { enabled: true } } });
    const camera = new THREE.PerspectiveCamera();

    // Play's frame loop: the same size and a render, every frame.
    for (let i = 0; i < 30; i++) {
      env.resize(800, 600);
      env.render(camera);
    }
    expect(env.diagnostics()).toMatchObject({ post: true, passes: ['render', 'bloom', 'output'], fallback: null });
    expect(composerRender).toHaveBeenCalledTimes(30);
    expect(addPass).toHaveBeenCalledTimes(3); // one build: render, bloom, output
    expect(bloomDispose).not.toHaveBeenCalled();

    // A real resize: one rebuild, and the old passes are freed.
    env.resize(1024, 768);
    env.render(camera);
    env.render(camera);
    expect(addPass).toHaveBeenCalledTimes(6);
    expect(bloomDispose).toHaveBeenCalledTimes(1);
    expect(outputDispose).toHaveBeenCalledTimes(1);

    env.dispose();
    expect(bloomDispose).toHaveBeenCalledTimes(2);
    expect(outputDispose).toHaveBeenCalledTimes(2);
  });
});

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

  it('post merges per effect: a level changes its grading and keeps the project bloom and tone mapping', () => {
    const out = layerEnvironment(BASE, { post: { grading: { lift: 0.1, gamma: 1.3, gain: 0.9 } } })!;
    expect(out.post).toEqual({ toneMapping: 'agx', exposure: 1.2, bloom: { enabled: true, strength: 0.5 }, grading: { lift: 0.1, gamma: 1.3, gain: 0.9 } });
    expect(out.sky).toBe(BASE.sky);
  });

  it('a level look over a project without an environment', () => {
    const out = layerEnvironment(null, { sky: { mode: 'color', color: '#00ff00' } });
    expect(out).toEqual({ sky: { mode: 'color', color: '#00ff00' } });
    expect(environmentHasLook(out)).toBe(true);
    expect(environmentHasLook(layerEnvironment({}, null))).toBe(false);
    expect(environmentHasLook(null)).toBe(false);
  });
});
