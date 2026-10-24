import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { flatTerrainTile, scatterRuleSeed, terrainScatterSurface, TerrainField, type ScatterRule, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { COVER_DRAW_KEY, coverDrawPlacement, installCoverPlacement } from './cover-gpu';
import { coverCandidate, coverRandom, coverShare, listCoverPatches, planCover, type CoverPatch, type CoverRuleConsts, type CoverTexels, type CoverTileRef } from './cover-placement';
import { metresPerStep, packHeightNormalAlone, packLayers, TERRAIN_TEXEL_BYTES } from './terrain-texels';
import { terrainUniforms } from './terrain-material';
import type { TerrainCoverSurface } from './terrain-view';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';

// One tile of rolling ground: 65 samples, 2 m apart (128 m a side), two layers painted in bands across x.
const S = 65;
const SPACING = 2;
const RANGE = [-20, 80];
const ORIGIN = [-40, 3, 10];
const COMP = { tileSamples: S, spacing: SPACING, heightRange: RANGE, tiles: [{ x: 0, z: 0, data: 'x' }] } as unknown as TerrainComponent;

function rollingTile(): TerrainTile {
  const t = flatTerrainTile(S, 0);
  const step = metresPerStep(RANGE);
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) t.heights[z * S + x] = Math.round((20 + 6 * Math.sin(x / 7) + 4 * Math.cos(z / 5) + x * 0.15 - RANGE[0]!) / step);
  t.weights = new Uint8Array(S * S * 8);
  for (let z = 0; z < S; z++) {
    for (let x = 0; x < S; x++) {
      // Layer 0 fades into layer 5 across x (layer 5 rides channel 1).
      const a = Math.round(255 * Math.min(1, Math.max(0, 1 - (x - 16) / 24)));
      t.weights.set([0, 5, 0, 0, a, 255 - a, 0, 0], (z * S + x) * 8);
    }
  }
  t.holes = new Uint8Array(Math.ceil((64 * 64) / 8));
  t.holes[(40 * 64 + 40) >> 3]! |= 1 << ((40 * 64 + 40) & 7);
  return t;
}

const tile = rollingTile();
const field = new TerrainField(COMP, ORIGIN, new Map([['0,0', tile]]));
const surface = terrainScatterSurface(field);
const texels = ((): CoverTexels => {
  const heights = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
  const layers = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
  const indices = new Uint8Array(S * S * TERRAIN_TEXEL_BYTES);
  const step = metresPerStep(RANGE);
  packHeightNormalAlone(heights, tile, step, SPACING);
  packLayers(layers, indices, tile);
  return { samples: S, spacing: SPACING, low: RANGE[0]!, step, heights, layers, indices };
})();
const TILE = (S - 1) * SPACING;
const tileAt = (tx: number, tz: number): CoverTileRef | undefined => (tx === 0 && tz === 0 ? { page: 0, layer: 0, low: 0, high: 60 } : undefined);

const rule: ScatterRule = { id: 'grass', asset: { assetId: 'kit' }, density: 8, scale: [0.8, 1.3], align: 0.5, layers: [{ layer: 0, min: 0.4, fade: 0.2 }], slope: { max: 35, fade: 5 }, cover: true, coverDistance: 60 };
const consts = (r: ScatterRule): CoverRuleConsts => ({ seed: scatterRuleSeed(r), density: r.density, scale: r.scale ?? [1, 1], yaw: r.yaw ?? 360, align: r.align ?? 0, sink: r.sink ?? 0, rule: r });
const model = { distances: [0, 20, 50], culls: false, radius: 0.5 };

/** Every candidate of every patch of every ring round `eye` (the terrain's frame). */
function candidatesAround(r: ScatterRule, eye: [number, number]): { plan: ReturnType<typeof planCover>; all: { k: number; p: CoverPatch; c: ReturnType<typeof coverCandidate> }[] } {
  const plan = planCover(r, r.coverDistance!, model, TILE);
  const all: { k: number; p: CoverPatch; c: ReturnType<typeof coverCandidate> }[] = [];
  plan.rings.forEach((ring, k) => {
    const lists = new Map<number, CoverPatch[]>();
    listCoverPatches(ring, eye, TILE, 1, tileAt, () => true, lists);
    for (const p of lists.get(0) ?? []) for (let i = 0; i < ring.perPatch; i++) all.push({ k, p, c: coverCandidate(i, p, ring, plan.thinning, consts(r), texels, 0, 0, ORIGIN, eye) });
  });
  return { plan, all };
}

describe('ground cover placed on the GPU (its arithmetic, on the CPU)', () => {
  it('plans rings from the eye to the reach: each draws one model level, its patches fit the tile whole', () => {
    const plan = planCover(rule, 60, model, TILE);
    const rings = plan.rings;
    expect(rings[0]!.inner).toBe(0);
    expect(rings.at(-1)!.outer).toBe(60);
    for (let k = 1; k < rings.length; k++) expect(rings[k]!.inner).toBe(rings[k - 1]!.outer);
    // Cut at the model's switches (at the rule's mean size) and from where the copies thin (60 % of the reach), each
    // reaching √2 as far (one too close to a switch left out).
    expect(rings.map((r) => [Math.round(r.inner * 100) / 100, Math.round(r.outer * 100) / 100, r.level])).toEqual([[0, 21, 0], [21, 36, 1], [36, 52.5, 1], [52.5, 60, 2]]);
    for (const r of rings) {
      expect(Math.abs(TILE / r.patch - Math.round(TILE / r.patch))).toBeLessThan(1e-9);
      expect(r.perPatch).toBe(r.side * r.side);
      // The grid is as dense as the ring's inner edge needs.
      expect((r.side / r.patch) ** 2 / (rule.density * r.gridShare)).toBeGreaterThan(0.8);
      expect((r.side / r.patch) ** 2 / (rule.density * r.gridShare)).toBeLessThan(1.25);
    }
    // Every copy to 60 % of the reach, faded to nothing at it (as the cover made on the CPU).
    expect(coverShare(plan.thinning, 30)).toBe(1);
    expect(coverShare(plan.thinning, 48)).toBeCloseTo(0.5, 6);
    expect(coverShare(plan.thinning, 60)).toBe(0);
    expect(coverShare({ ...plan.thinning, min: 0.3 }, 59)).toBe(0.3);
    // A screen size to thin from (`densityStart`): past where the model covers it, by the square of distance.
    const screen = planCover(rule, 60, model, TILE, 1, 21);
    expect(coverShare(screen.thinning, 30)).toBeCloseTo((21 / 30) ** 2, 6);
    expect(coverShare(screen.thinning, 42)).toBeCloseTo((21 / 42) ** 2 * (1 - 0.15625), 6);
    expect(screen.rings.map((r) => Math.round(r.outer * 100) / 100)).toEqual([21, 29.7, 42, 52.5, 60]);
  });

  it('puts each copy on the ground the terrain\'s queries give, and reads its slope and layer shares as they do', () => {
    const plan = planCover({ ...rule, density: 2 }, 60, model, TILE);
    const ring = plan.rings[0]!;
    let checked = 0;
    for (let i = 0; i < ring.perPatch; i++) {
      for (const p of [{ gx: 0, gz: 0, layer: 0 }, { gx: ring.side * 3, gz: ring.side * 5, layer: 0 }]) {
        const c = coverCandidate(i, p, ring, plan.thinning, consts(rule), texels, 0, 0, ORIGIN, [0, 0]);
        const g = surface.at(ORIGIN[0]! + c.x, ORIGIN[2]! + c.z);
        if (g === null) continue;
        checked += 1;
        expect(ORIGIN[1]! + c.y).toBeCloseTo(g.y, 3);
        // The texels' normals are central differences a sample wide; the queries' half a sample.
        // Within a sample of the terrain's edge the queries difference one side only (half the slope).
        if (Math.min(c.x, c.z, TILE - c.x, TILE - c.z) > SPACING) expect(Math.abs(c.slope - g.slope)).toBeLessThan(3);
        if (Math.min(c.x, c.z, TILE - c.x, TILE - c.z) > SPACING) expect(Math.abs(c.conditions - ((): number => {
          const share = g.layer(0);
          const k = share >= 0.4 ? 1 : share <= 0.2 ? 0 : ((t: number) => t * t * (3 - 2 * t))(1 - (0.4 - share) / 0.2);
          const s = g.slope <= 35 ? 1 : g.slope >= 40 ? 0 : ((t: number) => t * t * (3 - 2 * t))(1 - (g.slope - 35) / 5);
          return k * s;
        })())).toBeLessThan(0.08);
      }
    }
    expect(checked).toBeGreaterThan(ring.perPatch);
    // A hole keeps every copy off its cell.
    const hole = { gx: Math.floor((80 / ring.patch)) * ring.side, gz: Math.floor((80 / ring.patch)) * ring.side, layer: 0 };
    for (let i = 0; i < ring.perPatch; i++) {
      const c = coverCandidate(i, hole, ring, plan.thinning, consts({ ...rule, layers: [], slope: undefined }), texels, 0, 0, ORIGIN, [80, 80]);
      if (c.x >= 80 && c.x < 82 && c.z >= 80 && c.z < 82) expect(c.kept).toBe(false);
    }
  });

  it('gives a patch the same copies every time, wherever the eye is (only which are kept changes)', () => {
    const plan = planCover(rule, 60, model, TILE);
    const ring = plan.rings[0]!;
    const p = { gx: ring.side * 2, gz: ring.side, layer: 0 };
    const a = Array.from({ length: ring.perPatch }, (_, i) => coverCandidate(i, p, ring, plan.thinning, consts(rule), texels, 0, 0, ORIGIN, [10, 10]));
    const b = Array.from({ length: ring.perPatch }, (_, i) => coverCandidate(i, p, ring, plan.thinning, consts(rule), texels, 0, 0, ORIGIN, [10, 10]));
    const far = Array.from({ length: ring.perPatch }, (_, i) => coverCandidate(i, p, ring, plan.thinning, consts(rule), texels, 0, 0, ORIGIN, [40, 30]));
    expect(b).toEqual(a);
    expect(far.map((c) => [c.x, c.y, c.z, c.scale, ...c.rotation])).toEqual(a.map((c) => [c.x, c.y, c.z, c.scale, ...c.rotation]));
    // Each in its own cell of the patch, the turn and size within the rule's.
    const cell = ring.patch / ring.side;
    a.forEach((c, i) => {
      expect(Math.floor(c.x / cell)).toBe(p.gx + (i % ring.side));
      expect(Math.floor(c.z / cell)).toBe(p.gz + Math.floor(i / ring.side));
      expect(c.scale).toBeGreaterThanOrEqual(0.8);
      expect(c.scale).toBeLessThanOrEqual(1.3);
      expect(Math.hypot(...c.rotation)).toBeCloseTo(1, 6);
    });
    // Another rule (its id in the seed) puts its copies elsewhere.
    const other = coverCandidate(0, p, ring, plan.thinning, consts({ ...rule, id: 'flowers' }), texels, 0, 0, ORIGIN, [10, 10]);
    expect([other.x, other.z]).not.toEqual([a[0]!.x, a[0]!.z]);
    expect(coverRandom(7, -3, 12, 2)).toBe(coverRandom(7, -3, 12, 2));
  });

  it('keeps the rule\'s density near the eye and thins it with distance, with no step between rings and none past the reach', () => {
    const flat: ScatterRule = { id: 'g', asset: { assetId: 'kit' }, density: 4, cover: true, coverDistance: 60 };
    const eye: [number, number] = [64, 64];
    const { plan, all } = candidatesAround(flat, eye);
    const kept = all.filter((x) => x.c.kept);
    // Each copy is drawn by one ring only.
    const seen = new Set<string>();
    for (const x of kept) {
      const key = `${x.c.x.toFixed(4)},${x.c.z.toFixed(4)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Copies per m² in annuli against the rule's density times the share there (the ground is all on the tile: 64 m round the eye).
    const band = (a: number, b: number): number => {
      const n = kept.filter((x) => {
        const d = Math.hypot(x.c.x - eye[0], x.c.z - eye[1]);
        return d >= a && d < b && x.c.normal[1] > 0.05;
      }).length;
      return n / (Math.PI * (b * b - a * a));
    };
    const want = (a: number, b: number): number => {
      let sum = 0;
      for (let k = 0; k < 64; k++) {
        const d = a + ((k + 0.5) / 64) * (b - a);
        sum += flat.density * coverShare(plan.thinning, d) * d;
      }
      return sum / (((a + b) / 2) * 64);
    };
    for (const [a, b] of [[0, 15], [15, 30], [30, 42], [42, 52], [52, 57]] as const) expect(band(a, b) / want(a, b)).toBeGreaterThan(0.9), expect(band(a, b) / want(a, b)).toBeLessThan(1.1);
    // Across a ring's edge the density goes on (kept within 3 m either side).
    for (const edge of [plan.rings[0]!.outer, plan.rings[1]!.outer]) expect(band(edge - 3, edge) / band(edge, edge + 3)).toBeGreaterThan(0.75);
    expect(kept.every((x) => Math.hypot(x.c.x - eye[0], x.c.z - eye[1]) < 60)).toBe(true);
  });

  it('lists only the patches of a ring that meet its annulus, lie on a drawn tile and are in view', () => {
    const plan = planCover(rule, 60, model, TILE);
    const ring = plan.rings[1]!;
    const lists = new Map<number, CoverPatch[]>();
    listCoverPatches(ring, [64, 64], TILE, 1, tileAt, () => true, lists);
    const all = lists.get(0)!;
    for (const p of all) {
      const x0 = (p.gx / ring.side) * ring.patch;
      const z0 = (p.gz / ring.side) * ring.patch;
      const near = Math.hypot(Math.max(x0, Math.min(64, x0 + ring.patch)) - 64, Math.max(z0, Math.min(64, z0 + ring.patch)) - 64);
      expect(near).toBeLessThan(ring.outer);
      expect(x0 >= 0 && z0 >= 0 && x0 < TILE && z0 < TILE).toBe(true);
    }
    expect(all.length).toBeLessThanOrEqual(ring.maxPatches);
    const half = new Map<number, CoverPatch[]>();
    listCoverPatches(ring, [64, 64], TILE, 1, tileAt, (x) => x > 64, half);
    expect(half.get(0)!.length).toBeLessThan(all.length);
    expect(half.get(0)!.length).toBeGreaterThan(0);
  });

  it('builds its vertex stage for a mesh of the model (the WGSL three makes from it, the same nodes WebGL 2 builds)', () => {
    installCoverPlacement();
    const plan = planCover(rule, 60, model, TILE);
    const ring = plan.rings[0]!;
    const page = { heights: new THREE.DataArrayTexture(new Uint8Array(S * S * 4), S, S, 1), layers: new THREE.DataArrayTexture(new Uint8Array(S * S * 4), S, S, 1), indices: new THREE.DataArrayTexture(new Uint8Array(S * S * 4), S, S, 1) };
    const surf: TerrainCoverSurface = { uniforms: terrainUniforms(), samples: S, spacing: SPACING, tileSize: TILE, low: RANGE[0]!, step: metresPerStep(RANGE), origin: ORIGIN, pages: [page], tileAt };
    const patches = new THREE.DataTexture(new Float32Array(1024 * 4), 1024, 1, THREE.RGBAFormat, THREE.FloatType);
    const m = new MeshStandardNodeMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.1), m);
    mesh.userData[COVER_DRAW_KEY] = coverDrawPlacement({ ring, plan, rule: { ...rule, noise: { scale: 20, seed: 3, min: 0.4 } }, seed: scatterRuleSeed(rule), surface: surf, page, patches, eye: TSL.uniform(new THREE.Vector2()), local: new THREE.Matrix4() });
    (mesh as unknown as { count: number }).count = 512;
    const scene = litScene();
    scene.add(mesh);
    const wgsl = wgslOf(wgslRenderer(), scene, mesh);
    expect(wgsl).toMatch(/instance_index/);
    expect(wgsl).toMatch(/textureLoad/);
    // The hash's constants are compiled in.
    expect(wgsl).toMatch(/668265261|0x27d4eb2d/i);
  });
});
