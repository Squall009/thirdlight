/**
 * Reflections: the traced pixels' plan (which pixel of each square casts
 * this frame, how many rays a budget holds) and the materials' read at
 * three's own node builder (the WGSL a real build makes, no GPU).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { REFLECTION_START_SPACING, REFLECTION_TRACE_SPACINGS, ReflectionsLight, registerReflections, traceOffset, traceSpacing, traceTiles } from './post-reflections';
import { registerProbeLighting } from './probe-lighting';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';

describe('reflections: the traced pixels', () => {
  it('every place of a square is traced once in k² frames, and every traced pixel lies inside the trace', () => {
    const [w, h] = [481, 271];
    for (const k of REFLECTION_TRACE_SPACINGS) {
      const seen = new Set<string>();
      for (let f = 0; f < k * k; f += 1) {
        const [ox, oy] = traceOffset(f, k);
        expect(ox).toBeGreaterThanOrEqual(0);
        expect(ox).toBeLessThan(k);
        expect(oy).toBeLessThan(k);
        seen.add(`${ox},${oy}`);
        const t = traceTiles(w, h, k, ox, oy);
        // The last square's pixel is inside; one more would not be.
        expect(ox + (t.x - 1) * k).toBeLessThan(w);
        expect(ox + t.x * k).toBeGreaterThanOrEqual(w);
        expect(oy + (t.y - 1) * k).toBeLessThan(h);
        expect(oy + t.y * k).toBeGreaterThanOrEqual(h);
        expect(t.count).toBe(t.x * t.y);
      }
      expect(seen.size).toBe(k * k);
    }
  });

  it('the spacing is the finest whose rays fit the budget (the start before a cost is known, the coarsest when none fits)', () => {
    const [w, h] = [960, 540];
    expect(traceSpacing(w, h, null, 0.5, 2)).toBe(REFLECTION_START_SPACING);
    // 20 ns a ray, 0.5 ms: 25,000 rays; 960 × 540 at 6 → 14,400; at 4 → 32,400.
    expect(traceSpacing(w, h, 2e-5, 0.5, 2)).toBe(6);
    expect(traceTiles(w, h, 6, 0, 0).count * 2e-5).toBeLessThanOrEqual(0.5);
    expect(traceTiles(w, h, 4, 0, 0).count * 2e-5).toBeGreaterThan(0.5);
    expect(traceSpacing(w, h, 1e-9, 0.5, 4)).toBe(4);
    expect(traceSpacing(w, h, 1, 0.5, 2)).toBe(REFLECTION_TRACE_SPACINGS[REFLECTION_TRACE_SPACINGS.length - 1]);
  });
});

describe('reflections: the materials', () => {
  function lit(): { r: ReturnType<typeof wgslRenderer>; scene: THREE.Scene } {
    const r = wgslRenderer();
    registerProbeLighting(r as never);
    registerReflections(r as never);
    return { r, scene: litScene() };
  }

  it('a physical material blends the last frame\'s reflection into its environment light, last; other kinds and a scene without the light keep their programs', () => {
    const { r, scene } = lit();
    // With an environment: its radiance is what the reflection replaces.
    const std = new MeshStandardNodeMaterial({ roughness: 0.2 });
    std.envNode = TSL.vec3(0.5);
    const lambert = new THREE.MeshLambertMaterial();
    const plain = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), std));
    const plainLambert = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), lambert));
    const light = new ReflectionsLight();
    scene.add(light);
    const read = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), std));
    const samples = (s: string): number => s.match(/textureSample(Level)?\(/g)?.length ?? 0;
    // The history and its depth: two more samples.
    expect(samples(read)).toBe(samples(plain) + 2);
    // Its blend is the last write of the radiance before the lighting model reads it.
    // (directly or through a node variable: the last value given the radiance is the blend, after the environment's)
    const writes = [...read.matchAll(/\tradiance = ([^;]+);/g)].map((m) => m[1]!);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    const last = writes[writes.length - 1]!;
    expect(last.startsWith('mix( radiance,') || new RegExp(`\\t${last} = mix\\( radiance,`).test(read)).toBe(true);
    // Its reads sit behind the roughness test (a rough pixel reads nothing) and take no texture transform.
    expect(read).toMatch(/= \( Roughness < 0\.5 \);/);
    expect(read).not.toMatch(/nodeUniform\d+ \* vec3<f32>\( nodeVar\d+, 1\.0 \) \)\.xy \)/);
    // A Lambert material has no environment radiance: unchanged.
    expect(wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), lambert))).toBe(plainLambert);
    scene.remove(light);
    light.dispose();
    expect(wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), std))).toBe(plain);
  });
});
