/**
 * A foliage material's `rootColour`: ground cover's bases blend toward the
 * terrain's baked albedo under their root. The blend against its CPU
 * reference, and the programs three builds for it: the albedo read only in
 * cover draws of a material that asks, nothing new anywhere else.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { scatterRuleSeed, type ScatterRule } from '@thirdlight/project-model';

import { COVER_DRAW_KEY, coverDrawPlacement, installCoverPlacement } from './cover-gpu';
import { planCover } from './cover-placement';
import { rootBlendAt } from './foliage-nodes';
import { createMaterialLibrary } from './material-library';
import { metresPerStep } from './terrain-texels';
import { terrainUniforms } from './terrain-material';
import type { TerrainCoverSurface } from './terrain-view';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';

const S = 65;
const SPACING = 2;
const RANGE = [-20, 80];
const TILE = (S - 1) * SPACING;
const rule: ScatterRule = { id: 'grass', asset: { assetId: 'kit' }, density: 8, cover: true, coverDistance: 60 };
const model = { distances: [0, 20, 50], culls: false, radius: 0.5 };

describe('the base blend toward the ground', () => {
  it('is the setting at the root, none from its height up, and falls smoothly between', () => {
    expect(rootBlendAt(0, 0.8, 0.4)).toBeCloseTo(0.8, 6);
    expect(rootBlendAt(0.4, 0.8, 0.4)).toBe(0);
    expect(rootBlendAt(1, 0.8, 0.4)).toBe(0);
    expect(rootBlendAt(0.2, 0.8, 0.4)).toBeCloseTo(0.4, 6);
    let last = Infinity;
    for (let r = 0; r <= 1; r += 0.05) {
      const k = rootBlendAt(r, 1, 0.5);
      expect(k).toBeLessThanOrEqual(last);
      last = k;
    }
  });
});

describe('the programs', () => {
  function build(params: Record<string, number>, cover: boolean): { wgsl: string; asked: number } {
    installCoverPlacement();
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([{ materialId: 'grass', name: 'grass', shader: 'foliage', params, textures: {} }]);
    const geometry = new THREE.BoxGeometry(0.1, 0.8, 0.1);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes['position']!.count * 4).fill(0.5), 4));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    lib.apply(mesh, { '*': 'grass' });
    const page = { heights: new THREE.DataArrayTexture(new Uint8Array(S * S * 4), S, S, 1), layers: new THREE.DataArrayTexture(new Uint8Array(S * S * 4), S, S, 1), indices: new THREE.DataArrayTexture(new Uint8Array(S * S * 4), S, S, 1) };
    // Filtered, as the terrain's macro albedo is (a read at level 0 in the vertex stage).
    const albedo = new THREE.DataArrayTexture(new Uint8Array(64 * 64 * 4), 64, 64, 1);
    albedo.magFilter = THREE.LinearFilter;
    albedo.minFilter = THREE.LinearFilter;
    let asked = 0;
    const surf: TerrainCoverSurface = {
      uniforms: terrainUniforms(),
      samples: S,
      spacing: SPACING,
      tileSize: TILE,
      low: RANGE[0]!,
      step: metresPerStep(RANGE),
      origin: [0, 0, 0],
      pages: [page],
      albedo: (p) => {
        expect(p).toBe(page);
        asked++;
        return albedo;
      },
      tileAt: () => ({ page: 0, layer: 0, low: 0, high: 60 }),
    };
    if (cover) {
      const plan = planCover(rule, 60, model, TILE);
      const patches = new THREE.DataTexture(new Float32Array(1024 * 4), 1024, 1, THREE.RGBAFormat, THREE.FloatType);
      mesh.userData[COVER_DRAW_KEY] = coverDrawPlacement({ ring: plan.rings[0]!, plan, rule, seed: scatterRuleSeed(rule), surface: surf, page, patches, masks: null, maskSide: 4, eye: TSL.uniform(new THREE.Vector2()), local: new THREE.Matrix4() });
      (mesh as unknown as { count: number }).count = 512;
    }
    const scene = litScene();
    scene.add(mesh);
    const wgsl = wgslOf(wgslRenderer(), scene, mesh);
    lib.dispose();
    return { wgsl, asked };
  }
  const vertexOf = (wgsl: string): string => wgsl.slice(wgsl.indexOf('@vertex'), wgsl.indexOf('@fragment'));
  const fragmentOf = (wgsl: string): string => wgsl.slice(wgsl.indexOf('@fragment'));
  const albedoReads = (s: string): number => (s.match(/textureSampleLevel\(/g) ?? []).length;

  it('reads the ground\'s albedo once per vertex in a cover draw that asks, and mixes it in by a varying', () => {
    const on = build({ rootColour: 0.8 }, true);
    const off = build({}, true);
    expect(on.asked).toBe(1);
    expect(off.asked).toBe(0);
    expect(albedoReads(vertexOf(on.wgsl))).toBe(albedoReads(vertexOf(off.wgsl)) + 1);
    expect(fragmentOf(on.wgsl)).toMatch(/mix\(/);
    // The blend's falloff is worked out per vertex, not per pixel.
    expect(vertexOf(on.wgsl)).toMatch(/smoothstep\(/);
    expect(on.wgsl.length).toBeGreaterThan(off.wgsl.length);
  });

  it('leaves a placed model of the same material as it is', () => {
    const on = build({ rootColour: 0.8 }, false);
    const off = build({}, false);
    expect(on.asked).toBe(0);
    expect(on.wgsl).toBe(off.wgsl);
  });
});
