/**
 * Terrains shaped by splines: a road flattens and paints the ground along
 * it and keeps the scatter clear; what a change re-bakes (the band round the
 * curve before and after) gives the same tiles as shaping everything again;
 * a sculpt beside a road edits the hand-made tile and the road holds; a
 * spline removed gives the hand-made ground back and drops the hand-made
 * forms; a block layer's cells stop the carve; a bake of scatter rules
 * alone leaves the material the rules and the road painted.
 */
import { describe, expect, it } from 'vitest';
import { TerrainField, flatTerrainTile, terrainFlatStep, type BlockLayerData, type ScatterCell, type ScatterRule, type SceneV4, type SplineComponent, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import { planTerrainEdit, planTerrainSplineRebake, splineRebakeRects, type TerrainSplinePlan } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const MODEL = (BEFORE.content as unknown as { assets: { assetId: string; kind: string }[] }).assets.find((a) => a.kind === 'model')?.assetId ?? 'model-1';
const TREES: ScatterRule = { id: 'trees', asset: { assetId: MODEL }, density: 0.5, spacing: 1 };
const RANGE: [number, number] = [-20, 100];
const GROUND = 'group-0902';
const ROAD = 'group-0903';

type Blobs = { tiles: Map<string, TerrainTile>; cells: Map<string, ScatterCell> };

/** A 2 × 1 terrain of 33-sample tiles at 1 m, rolling 2–6 m high, with its tiles in `blobs`. */
function world(blobs: Blobs, scatter?: ScatterRule[]): SceneV4 {
  const tiles = [0, 1].map((x) => {
    const t = flatTerrainTile(33, 0);
    for (let z = 0; z < 33; z++) for (let i = 0; i < 33; i++) t.heights[z * 33 + i] = Math.round(((4 + 2 * Math.sin((x * 32 + i) / 7) - RANGE[0]) / (RANGE[1] - RANGE[0])) * 65535);
    const d = `${x + 1}`.repeat(64);
    blobs.tiles.set(d, t);
    return { x, z: 0, data: d };
  });
  const comp: TerrainComponent = { tileSamples: 33, spacing: 1, heightRange: RANGE, tiles, ...(scatter !== undefined ? { scatter } : {}) };
  const ground = { id: GROUND, name: 'Ground', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain: comp } };
  return { ...BEFORE.scene, entities: [...BEFORE.scene.entities, ground] } as SceneV4;
}

function withSpline(scene: SceneV4, spline: SplineComponent | null): SceneV4 {
  const rest = scene.entities.filter((e) => e.id !== ROAD);
  if (spline === null) return { ...scene, entities: rest } as SceneV4;
  const road = { id: ROAD, name: 'Road', components: { transform: { position: [0, 5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, spline } };
  return { ...scene, entities: [...rest, road] } as SceneV4;
}

const terrainOf = (scene: SceneV4): TerrainComponent => scene.entities.find((e) => e.id === GROUND)!.components.terrain as TerrainComponent;

let serial = 100;
/** The scene with a plan's tiles, hand-made forms and scatter stored under new digests. */
function store(scene: SceneV4, plan: Pick<TerrainSplinePlan, 'tiles' | 'bases' | 'scatter'>, blobs: Blobs): SceneV4 {
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
    if (plan.scatter.has(key)) {
      const cell = plan.scatter.get(key)!;
      if (cell === null) delete out.scatter;
      else blobs.cells.set((out.scatter = name()), cell);
    }
    return out;
  });
  return { ...scene, entities: scene.entities.map((e) => (e.id === GROUND ? { ...e, components: { ...e.components, terrain: { ...comp, tiles } } } : e)) } as SceneV4;
}

const readers = (blobs: Blobs) => ({
  tile: (d: string) => (blobs.tiles.has(d) ? { ok: true as const, tile: blobs.tiles.get(d)! } : { ok: false as const, error: { code: 'blob_missing', cls: 'not_found', message: d } as never }),
  cell: (d: string) => ({ ok: true as const, cell: blobs.cells.get(d)! }),
});

/** Re-bake after a change from `before` to `after` and store it. */
function follow(before: SceneV4, after: SceneV4, blobs: Blobs): { scene: SceneV4; plan: TerrainSplinePlan | null } {
  const rects = splineRebakeRects(before, after).get(GROUND) ?? [];
  const r = readers(blobs);
  const planned = planTerrainSplineRebake(after, GROUND, rects, r.tile, r.cell);
  if (!planned.ok) throw new Error(JSON.stringify(planned.error));
  return { scene: planned.plan === null ? after : store(after, planned.plan, blobs), plan: planned.plan };
}

function fieldOf(scene: SceneV4, blobs: Blobs): TerrainField {
  const comp = terrainOf(scene);
  const flat = terrainFlatStep(comp.heightRange);
  const tiles = new Map(comp.tiles.map((t) => [`${t.x},${t.z}`, t.data !== undefined ? blobs.tiles.get(t.data)! : flatTerrainTile(33, flat)]));
  return new TerrainField(comp, [0, 0, 0], tiles);
}

const ROAD_SPLINE: SplineComponent = { points: [{ at: [4, 0, 16] }, { at: [32, 0, 16] }, { at: [60, 0, 16] }], width: 6, terrain: { falloff: 3, paint: { layer: 1, falloff: 1 } }, scatter: { margin: 1 } };

describe('terrains shaped by splines', () => {
  it('a road flattens and paints the ground along it, keeps scatter clear, and keeps the hand-made tiles beside', () => {
    const blobs: Blobs = { tiles: new Map(), cells: new Map() };
    let scene = world(blobs, [TREES]);
    // The trees baked first, everywhere.
    const r0 = readers(blobs);
    const bake = planTerrainEdit(scene, BEFORE.content, { entityId: GROUND, kind: 'bake', scatter: [TREES] }, r0.tile, undefined, r0.cell);
    if (!bake.ok) throw new Error(JSON.stringify(bake.error));
    scene = store(scene, { tiles: bake.plan.tiles, bases: new Map(), scatter: bake.plan.scatter }, blobs);
    const hand = fieldOf(scene, blobs);
    const after = withSpline(scene, ROAD_SPLINE);
    const { scene: s1, plan } = follow(scene, after, blobs);
    expect(plan).not.toBeNull();
    const f = fieldOf(s1, blobs);
    // On the road: its height (the object's y 5), all layer 1; off it: the ground as made by hand.
    for (const x of [8, 20, 33, 50]) {
      expect(f.heightAt(x, 16)!).toBeCloseTo(5, 2);
      expect(f.sample(x, 16)!.layers[0]).toBe(1);
      expect(f.heightAt(x, 2)).toBeCloseTo(hand.heightAt(x, 2)!, 6);
    }
    // Both tiles keep their hand-made form beside the drawn one.
    expect(terrainOf(s1).tiles.every((t) => t.base !== undefined)).toBe(true);
    // No tree on the band (half width 3 + margin 1), trees beside it.
    const trees: number[][] = [];
    for (const t of terrainOf(s1).tiles) {
      const c = blobs.cells.get(t.scatter!)!.get('trees')!;
      for (let i = 0; i < c.cells.length / 2; i++) trees.push([c.copies[i * 10]!, c.copies[i * 10 + 2]!]);
    }
    expect(trees.length).toBeGreaterThan(100);
    expect(trees.filter(([x, z]) => x! > 6 && x! < 58 && Math.abs(z! - 16) < 3.9)).toEqual([]);
    expect(trees.filter(([, z]) => Math.abs(z! - 16) > 5).length).toBeGreaterThan(50);
    // What the change re-baked equals shaping the whole terrain again.
    const whole = planTerrainSplineRebake(s1, GROUND, [[-100, -100, 200, 200]], readers(blobs).tile, readers(blobs).cell);
    expect(whole.ok && whole.plan).toBeNull();
  });

  it('a moved road gives its old band back; a sculpt beside it edits the hand-made ground and the road holds; removed, the sculpt shows', () => {
    const blobs: Blobs = { tiles: new Map(), cells: new Map() };
    const scene = world(blobs);
    const hand = fieldOf(scene, blobs);
    let s = follow(scene, withSpline(scene, ROAD_SPLINE), blobs).scene;
    // Moved 10 m north.
    const moved: SplineComponent = { ...ROAD_SPLINE, points: ROAD_SPLINE.points.map((p) => ({ at: [p.at[0], p.at[1], p.at[2] + 10] as [number, number, number] })) };
    s = follow(s, withSpline(s, moved), blobs).scene;
    let f = fieldOf(s, blobs);
    expect(f.heightAt(20, 16)).toBeCloseTo(hand.heightAt(20, 16)!, 6);
    expect(f.sample(20, 16)!.layers).toEqual(hand.sample(20, 16)!.layers);
    expect(f.heightAt(20, 26)!).toBeCloseTo(5, 2);
    // A raise across the road: on it the road holds, beside it the ground rises.
    const r = readers(blobs);
    const raise = planTerrainEdit(s, BEFORE.content, { entityId: GROUND, kind: 'raise', dabs: [[20, 22]], radius: 6, strength: 3 }, r.tile, undefined, r.cell);
    if (!raise.ok) throw new Error(JSON.stringify(raise.error));
    s = store(s, { tiles: raise.plan.tiles, bases: raise.plan.bases, scatter: raise.plan.scatter }, blobs);
    f = fieldOf(s, blobs);
    expect(f.heightAt(20, 26)!).toBeCloseTo(5, 2);
    expect(f.heightAt(20, 20)!).toBeGreaterThan(hand.heightAt(20, 20)! + 1);
    // The road removed: the raise shows under where it was, the hand-made forms go.
    s = follow(s, withSpline(s, null), blobs).scene;
    f = fieldOf(s, blobs);
    expect(f.heightAt(20, 25)!).toBeGreaterThan(hand.heightAt(20, 25)! + 0.05);
    expect(terrainOf(s).tiles.some((t) => t.base !== undefined)).toBe(false);
  });

  it('one point moved re-bakes only round the segments it moved, the same tiles as shaping everything again', () => {
    const blobs: Blobs = { tiles: new Map(), cells: new Map() };
    let scene = world(blobs, [TREES]);
    const r0 = readers(blobs);
    const bake = planTerrainEdit(scene, BEFORE.content, { entityId: GROUND, kind: 'bake', scatter: [TREES] }, r0.tile, undefined, r0.cell);
    if (!bake.ok) throw new Error(JSON.stringify(bake.error));
    scene = store(scene, { tiles: bake.plan.tiles, bases: new Map(), scatter: bake.plan.scatter }, blobs);
    const long: SplineComponent = { ...ROAD_SPLINE, points: [0, 1, 2, 3, 4, 5, 6].map((k) => ({ at: [2 + k * 10, 0, 16 + 4 * Math.sin(k)] as [number, number, number] })) };
    let s = follow(scene, withSpline(scene, long), blobs).scene;
    const moved: SplineComponent = { ...long, points: long.points.map((p, i) => (i === 5 ? { at: [p.at[0], p.at[1], p.at[2] + 3] as [number, number, number] } : p)) };
    const rects = splineRebakeRects(s, withSpline(s, moved)).get(GROUND)!;
    // Segments 3-5 (point 5 and its neighbours' smooth tangents), before and after: x from about 30 m on.
    expect(Math.min(...rects.map((r) => r[0]))).toBeGreaterThan(20);
    s = follow(s, withSpline(s, moved), blobs).scene;
    const whole = planTerrainSplineRebake(s, GROUND, [[-100, -100, 200, 200]], readers(blobs).tile, readers(blobs).cell);
    expect(whole.ok && whole.plan).toBeNull();
  });

  it('a bake of scatter rules alone keeps the material the rules baked and the road painted (rules baked after the road)', () => {
    const blobs: Blobs = { tiles: new Map(), cells: new Map() };
    let scene = world(blobs);
    // A road across, then layer 2 baked above 5 m (the rolling tops): the hand-made forms beside the drawn tiles predate the rules.
    scene = follow(scene, withSpline(scene, ROAD_SPLINE), blobs).scene;
    const HIGH = [{ layer: 2, height: { min: 5, fade: 0.1 } }];
    const r0 = readers(blobs);
    const rules = planTerrainEdit(scene, BEFORE.content, { entityId: GROUND, kind: 'bake', rules: HIGH }, r0.tile, undefined, r0.cell);
    if (!rules.ok) throw new Error(JSON.stringify(rules.error));
    scene = store(scene, { tiles: rules.plan.tiles, bases: rules.plan.bases ?? new Map(), scatter: new Map() }, blobs);
    scene = { ...scene, entities: scene.entities.map((e) => (e.id === GROUND ? { ...e, components: { ...e.components, terrain: { ...terrainOf(scene), rules: HIGH } } } : e)) } as SceneV4;
    const layersOf = (sc: SceneV4): number[] => {
      const f = fieldOf(sc, blobs);
      const out: number[] = [];
      for (let z = 0; z < 32; z += 2) for (let x = 0; x < 64; x += 2) out.push(f.sample(x, z)!.layers[0]!);
      return out;
    };
    const before = layersOf(scene);
    expect(before.filter((l) => l === 2).length).toBeGreaterThan(20);
    expect(before.filter((l) => l === 1).length).toBeGreaterThan(20);
    // The trees baked alone: the ground's layers stay as the rules and the road left them.
    const r1 = readers(blobs);
    const trees = planTerrainEdit(scene, BEFORE.content, { entityId: GROUND, kind: 'bake', scatter: [TREES] }, r1.tile, undefined, r1.cell);
    if (!trees.ok) throw new Error(JSON.stringify(trees.error));
    const after = store(scene, { tiles: trees.plan.tiles, bases: new Map(), scatter: trees.plan.scatter }, blobs);
    expect(layersOf(after)).toEqual(before);
  });

  it('a block layer\'s cells stop the carve at their border', () => {
    const blobs: Blobs = { tiles: new Map(), cells: new Map() };
    const scene = world(blobs);
    const hand = fieldOf(scene, blobs);
    // A 6 × 8 block area at x 30-35, z 12-19 (one cell high).
    const layer = { id: 'group-0904', name: 'Blocks', components: { transform: { position: [30, 0, 12], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [6, 4, 8] } } } };
    const cells: { x: number; y: number; z: number }[] = [];
    for (let x = 0; x < 6; x++) for (let z = 0; z < 8; z++) cells.push({ x, y: 0, z });
    const data = blockData('group-0904', cells);
    const withBlocks = { ...scene, entities: [...scene.entities, layer], blocks: [data] } as unknown as SceneV4;
    const s = follow(withBlocks, withSpline(withBlocks, ROAD_SPLINE), blobs).scene;
    const f = fieldOf(s, blobs);
    expect(f.heightAt(20, 16)!).toBeCloseTo(5, 2);
    expect(f.heightAt(33, 16)).toBeCloseTo(hand.heightAt(33, 16)!, 6);
  });
});

/** A block layer's data holding plain cells (one block type) at the given places. */
function blockData(entityId: string, cells: readonly { x: number; y: number; z: number }[]): BlockLayerData {
  const columns = cells.map((c) => [c.x, c.z, c.y, 1, 0]);
  return { entityId, chunks: [{ cx: 0, cz: 0, palette: [{ block: 'stone' }], columns }] } as unknown as BlockLayerData;
}
