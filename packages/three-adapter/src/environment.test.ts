/**
 * The environment renderer's post stack lifetime (no WebGL needed): Play
 * reports the canvas size every frame, and a same-size resize must not
 * rebuild the composer — each rebuild allocates every pass's render targets
 * and programs. A real size change rebuilds once and frees the old passes.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { createEnvironmentRenderer } from './environment';

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
