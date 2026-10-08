/**
 * A terrain's edit layers: a stamp placed raises a mountain where it lies
 * (and only there), switched off or weighed it gives the hand-made ground
 * back or half the mountain; a sculpt under it keeps the stamp on top; a
 * re-bake of the boxes a layer change reaches equals combining everything;
 * erosion over a rectangle is deterministic, changes the ground only inside
 * the rectangle, and repeated gives the same ground inside its border; a
 * terrain without layers combines to the bytes it holds.
 */
import { describe, expect, it } from 'vitest';
import { EROSION_FADE_SAMPLES, erodeGrid, flatTerrainTile, terrainHeightOf, validateTerrainLayers, type Heightmap, type ModelErrorV2, type ScatterCell, type SceneV4, type TerrainComponent, type TerrainLayer, type TerrainTile } from '@thirdlight/project-model';

import { erosionInput, planErosion, planTerrainEdit, planTerrainSplineRebake, splineRebakeRects, type TerrainLayerReads, type TerrainSplinePlan } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const RANGE: [number, number] = [-20, 100];
const GROUND = 'group-0902';
const N = 65;

type Blobs = { tiles: Map<string, TerrainTile>; deltas: Map<string, Int16Array> };

/** A cone 1 at its centre, 0 at its rim (a 33² image). */
const CONE: Heightmap = (() => {
  const w = 33;
  const samples = new Uint16Array(w * w);
  for (let z = 0; z < w; z++) for (let x = 0; x < w; x++) samples[z * w + x] = Math.round(Math.max(0, 1 - Math.hypot(x - 16, z - 16) / 16) * 65535);
  return { width: w, height: w, samples };
})();

/** A 2 × 1 terrain of 65-sample tiles at 1 m, gently rolling, with its tiles in `blobs`. */
function world(blobs: Blobs, layers?: TerrainLayer[]): SceneV4 {
  const tiles = [0, 1].map((x) => {
    const t = flatTerrainTile(N, 0);
    for (let z = 0; z < N; z++) for (let i = 0; i < N; i++) t.heights[z * N + i] = Math.round(((4 + 3 * Math.sin((x * (N - 1) + i) / 9) * Math.cos(z / 7) - RANGE[0]) / (RANGE[1] - RANGE[0])) * 65535);
    const d = `${x + 1}`.repeat(64);
    blobs.tiles.set(d, t);
    return { x, z: 0, data: d };
  });
  const comp: TerrainComponent = { tileSamples: N, spacing: 1, heightRange: RANGE, tiles, ...(layers !== undefined ? { layers } : {}) };
  const ground = { id: GROUND, name: 'Ground', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain: comp } };
  return { ...BEFORE.scene, entities: [...BEFORE.scene.entities, ground] } as SceneV4;
}

const terrainOf = (scene: SceneV4): TerrainComponent => scene.entities.find((e) => e.id === GROUND)!.components.terrain as TerrainComponent;
const withLayers = (scene: SceneV4, layers: TerrainLayer[] | undefined): SceneV4 =>
  ({ ...scene, entities: scene.entities.map((e) => (e.id === GROUND ? { ...e, components: { ...e.components, terrain: { ...terrainOf(scene), ...(layers !== undefined ? { layers } : {}) } } } : e)) }) as SceneV4;

let serial = 100;
function store(scene: SceneV4, plan: Pick<TerrainSplinePlan, 'tiles' | 'bases'>, blobs: Blobs): SceneV4 {
  const comp = terrainOf(scene);
  const name = (): string => (serial++).toString(16).padStart(64, 'c');
  const tiles = comp.tiles.map((t) => {
    const key = `${t.x},${t.z}`;
    const out = { ...t };
    const tile = plan.tiles.get(key);
    if (tile !== undefined) blobs.tiles.set((out.data = name()), tile);
    if (plan.bases.has(key)) {
      const b = plan.bases.get(key)!;
      if (b === null) delete out.base;
      else blobs.tiles.set((out.base = name()), b);
    }
    return out;
  });
  return { ...scene, entities: scene.entities.map((e) => (e.id === GROUND ? { ...e, components: { ...e.components, terrain: { ...comp, tiles } } } : e)) } as SceneV4;
}

const readers = (blobs: Blobs) => ({
  tile: (d: string) => (blobs.tiles.has(d) ? { ok: true as const, tile: blobs.tiles.get(d)! } : { ok: false as const, error: { code: 'blob_missing', cls: 'not_found', message: d } as never }),
  cell: (_d: string) => ({ ok: true as const, cell: new Map() as ScatterCell }),
  layers: { heightmap: (a: string) => (a === 'cone' ? CONE : null), delta: (d: string) => (blobs.deltas.has(d) ? { ok: true as const, delta: blobs.deltas.get(d)! } : { ok: false as const, error: { code: 'blob_missing', cls: 'not_found', message: d } as never }) } satisfies TerrainLayerReads,
});

function follow(before: SceneV4, after: SceneV4, blobs: Blobs): SceneV4 {
  const rects = splineRebakeRects(before, after).get(GROUND) ?? [];
  const r = readers(blobs);
  const planned = planTerrainSplineRebake(after, GROUND, rects, r.tile, r.cell, r.layers);
  if (!planned.ok) throw new Error(planned.error.message);
  return planned.plan === null ? after : store(after, planned.plan, blobs);
}

/** World height of the drawn ground at sample (gx, gz). */
function heightAt(scene: SceneV4, blobs: Blobs, gx: number, gz: number): number {
  const comp = terrainOf(scene);
  const tx = Math.min(1, Math.floor(gx / (N - 1)));
  const ref = comp.tiles.find((t) => t.x === tx && t.z === 0)!;
  const t = blobs.tiles.get(ref.data!)!;
  return terrainHeightOf(RANGE, t.heights[gz * N + (gx - tx * (N - 1))]!);
}

const STAMPS = (extra: Partial<{ enabled: boolean; strength: number }> = {}): TerrainLayer[] => [{ id: 'peaks', kind: 'stamps', stamps: [{ asset: 'cone', at: [64, 32], size: 40, height: 30, falloff: 0 }], ...extra }];

describe('terrain edit layers', () => {
  it('a stamp raises a mountain where it lies; off gives the ground back, half strength half of it', () => {
    const blobs: Blobs = { tiles: new Map(), deltas: new Map() };
    const s0 = world(blobs);
    const ground = heightAt(s0, blobs, 64, 32);
    const s1 = follow(s0, withLayers(s0, STAMPS()), blobs);
    expect(heightAt(s1, blobs, 64, 32) - ground).toBeCloseTo(30, 1);
    // Outside the stamp's square: the hand-made ground.
    expect(heightAt(s1, blobs, 10, 10)).toBe(heightAt(s0, blobs, 10, 10));
    // Both tiles keep their hand-made forms (the stamp straddles their seam).
    expect(terrainOf(s1).tiles.every((t) => t.base !== undefined)).toBe(true);
    const off = follow(s1, withLayers(s1, STAMPS({ enabled: false })), blobs);
    expect(heightAt(off, blobs, 64, 32)).toBe(ground);
    const half = follow(off, withLayers(off, STAMPS({ strength: 0.5 })), blobs);
    expect(heightAt(half, blobs, 64, 32) - ground).toBeCloseTo(15, 1);
    // Removed: the hand-made forms are dropped, the ground is as it was.
    const gone = follow(half, withLayers(half, []), blobs);
    expect(terrainOf(gone).tiles.every((t) => t.base === undefined)).toBe(true);
    for (const gx of [10, 50, 64, 80]) expect(heightAt(gone, blobs, gx, 32)).toBe(heightAt(s0, blobs, gx, 32));
  });

  it('a re-bake of the boxes a layer change reaches equals combining everything', () => {
    const blobs: Blobs = { tiles: new Map(), deltas: new Map() };
    const s0 = world(blobs);
    const after = withLayers(s0, STAMPS());
    const r = readers(blobs);
    const part = planTerrainSplineRebake(after, GROUND, splineRebakeRects(s0, after).get(GROUND)!, r.tile, r.cell, r.layers);
    const whole = planTerrainSplineRebake(after, GROUND, [[-10, -10, 200, 200]], r.tile, r.cell, r.layers);
    if (!part.ok || !whole.ok) throw new Error('refused');
    for (const [k, t] of whole.plan!.tiles) expect([...(part.plan!.tiles.get(k) ?? blobs.tiles.get(terrainOf(s0).tiles.find((x) => `${x.x},${x.z}` === k)!.data!)!).heights]).toEqual([...t.heights]);
  });

  it('a sculpt under a stamp edits the hand-made ground; the stamp stays on top', () => {
    const blobs: Blobs = { tiles: new Map(), deltas: new Map() };
    const s0 = world(blobs);
    const s1 = follow(s0, withLayers(s0, STAMPS()), blobs);
    const before = heightAt(s1, blobs, 64, 32);
    const r = readers(blobs);
    const edit = planTerrainEdit(s1 as never, undefined, { entityId: GROUND, kind: 'raise', dabs: [[64, 32]], radius: 4, strength: 2, falloff: 'constant' }, r.tile, undefined, r.cell, r.layers);
    if (!edit.ok) throw new Error(edit.error.message);
    const s2 = store(s1, edit.plan, blobs);
    expect(heightAt(s2, blobs, 64, 32) - before).toBeCloseTo(2, 1);
    // The hand-made form moved by the sculpt alone.
    const base = blobs.tiles.get(terrainOf(s2).tiles.find((t) => t.x === 1)!.base!)!;
    expect(terrainHeightOf(RANGE, base.heights[32 * N]!) - heightAt(s0, blobs, 64, 32)).toBeCloseTo(2, 1);
  });

  it('erosion over a rectangle is deterministic, stays inside it and repeats to the same ground inside its border', () => {
    const blobs: Blobs = { tiles: new Map(), deltas: new Map() };
    const s0 = follow(world(blobs), withLayers(world(blobs), STAMPS()), blobs);
    const r = readers(blobs);
    const args = { entityId: GROUND, rect: [40, 8, 88, 56] as [number, number, number, number], hydraulic: { droplets: 1 }, thermal: { iterations: 10 }, seed: 7 };
    const input = erosionInput(s0 as never, args, r.tile, r.layers);
    if (!input.ok) throw new Error(input.error.message);
    // The worker's way (the grid eroded elsewhere) and in process agree to the bit.
    const copy = { ...input.input.grid, heights: input.input.grid.heights.slice() };
    erodeGrid(copy, input.input.settings);
    const a = planErosion(input.input, null, r.layers.delta);
    const b = planErosion(input.input, copy.heights, r.layers.delta);
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(a.plan.changed).toBeGreaterThan(100);
    for (const [k, d] of a.plan.deltas) expect([...(b.plan.deltas.get(k) ?? [])]).toEqual([...(d ?? [])]);
    // Stored and combined: the ground moves inside the rectangle only.
    const tiles = [...a.plan.deltas].filter(([, d]) => d !== null).map(([k, d]) => {
      const [x, z] = k.split(',').map(Number) as [number, number];
      const digest = (serial++).toString(16).padStart(64, 'e');
      blobs.deltas.set(digest, d!);
      return { x, z, data: digest };
    });
    const layers = a.plan.layers.map((l) => (l.id === a.plan.layerId ? { ...l, tiles } : l)) as TerrainLayer[];
    const s1 = follow(s0, withLayers(s0, layers), blobs);
    let moved = 0;
    for (let gz = 0; gz < N; gz++)
      for (let gx = 0; gx < 2 * N - 1; gx++) {
        const d = heightAt(s1, blobs, gx, gz) - heightAt(s0, blobs, gx, gz);
        if (gx < 40 || gx > 88 || gz < 8 || gz > 56) expect(d).toBe(0);
        else if (d !== 0) moved++;
      }
    expect(moved).toBeGreaterThan(100);
    // Again over the same place: it reads the ground below it, not its own result.
    const again = erosionInput(s1 as never, { ...args, layerId: 'erosion' }, r.tile, r.layers);
    if (!again.ok) throw new Error(again.error.message);
    const c = planErosion(again.input, null, r.layers.delta);
    if (!c.ok) throw new Error('refused');
    // Inside the fade at its border the run is what it was; only the border blends with what was there.
    for (const [k, d] of c.plan.deltas) {
      const tx = Number(k.split(',')[0]);
      const first = a.plan.deltas.get(k)!;
      for (let gz = 8 + EROSION_FADE_SAMPLES; gz <= 56 - EROSION_FADE_SAMPLES; gz++)
        for (let gx = 40 + EROSION_FADE_SAMPLES; gx <= 88 - EROSION_FADE_SAMPLES; gx++) {
          const i = gx - tx * (N - 1);
          if (i < 0 || i >= N) continue;
          expect(d![gz * N + i]).toBe(first![gz * N + i]);
        }
    }
  });

  it('a terrain without layers is one base layer: nothing combines differently', () => {
    const blobs: Blobs = { tiles: new Map(), deltas: new Map() };
    const s0 = world(blobs);
    const r = readers(blobs);
    const planned = planTerrainSplineRebake(s0, GROUND, [[-10, -10, 200, 200]], r.tile, r.cell, r.layers);
    if (!planned.ok) throw new Error('refused');
    expect(planned.plan).toBeNull();
  });

  it('layers are checked', () => {
    const errors: ModelErrorV2[] = [];
    validateTerrainLayers([{ id: 'a', kind: 'stamps', stamps: [{ asset: 'cone', at: [0, 0], size: 0, height: 1 }] }, { id: 'a', kind: 'splines' }, { id: 'b', kind: 'splines' }, { id: 'c', kind: 'erosion', settings: { thermal: { talus: 95 } } }], '/layers', errors);
    expect(errors.map((e) => e.path)).toEqual(['/layers/0/stamps/0/size', '/layers/1/id', '/layers/2', '/layers/3/settings/thermal/talus']);
  });
});
