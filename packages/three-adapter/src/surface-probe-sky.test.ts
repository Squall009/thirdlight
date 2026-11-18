/**
 * The sky probe looks again when the environment map is baked again in place (the same texture: its render target
 * drawn anew), not only when the look's numbers change: a look switched at once changes the numbers that frame and
 * bakes its sky's light up to a second later, and a probe that projected between the two kept the old sky's light.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { ENVIRONMENT_BAKES_KEY, SKY_CHECK_MS, SkyProbe } from './surface-probe-sky';

/** A renderer that draws nothing and reads back a sky of `level` everywhere (the map as it is now). */
function fakeRenderer(level: () => number): unknown {
  return {
    getRenderTarget: () => null,
    setRenderTarget: () => undefined,
    render: () => undefined,
    readRenderTargetPixelsAsync: async (_t: unknown, _x: number, _y: number, w: number) => new Float32Array(w * 4).map((_, i) => (i % 4 === 3 ? 1 : level())),
  };
}

describe('the sky probe', () => {
  it('projects again when the environment map is baked again in place, with the new light', async () => {
    let sky = 3;
    const renderer = fakeRenderer(() => sky);
    const scene = new THREE.Scene();
    const env = new THREE.Texture();
    scene.environment = env;
    const probe = new SkyProbe();
    let now = 0;
    const look = async (): Promise<void> => {
      probe.update(renderer, scene, now);
      await new Promise((r) => setTimeout(r, 0));
      now += SKY_CHECK_MS + 1;
    };
    await look();
    expect(probe.version).toBe(1);
    const day = probe.coefficients[0]!;
    expect(day).toBeGreaterThan(0);
    // The night look: its numbers at once (the probe projects the old map with them), the map's bake a little later.
    scene.environmentIntensity = 0.5;
    await look();
    expect(probe.version).toBe(2);
    sky = 0.01;
    env.userData[ENVIRONMENT_BAKES_KEY] = 1;
    await look();
    expect(probe.version).toBe(3);
    expect(probe.coefficients[0]!).toBeLessThan(day / 100);
    // Nothing changed since: no projection.
    await look();
    expect(probe.version).toBe(3);
  });
});
