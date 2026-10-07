/**
 * The level-building perf classes without a browser: the plans are
 * deterministic and have the classes' shape, the landscape is the area plus
 * a terrain whose scatter rules keep off it, the terrain lies under the area and its
 * heightmap covers its tiles, and the
 * measurement's target and far-cost rows read the report as the log says.
 */
import { describe, expect, it } from 'vitest';

import { validateScatterRules, type ModelErrorV2 } from '@thirdlight/project-model';

import { levelHeightAt, levelPlan, levelTerrainHeight, levelTerrainOrigin, levelTerrainRaw, levelScatterBlocks, levelScatterTerrain, LEVEL_SPEC } from '../../tools/perf/level';
import { farCostRows, levelTargetRows, LEVEL_FRAME_TARGET_MS, type LevelReport } from '../../tools/perf/level-run';
import type { FrameRunResult } from '../../tools/perf/frame-run';

const ids = (p: ReturnType<typeof levelPlan>): string[] => p.batches.flat().map((e) => e.id);

describe('the level classes', () => {
  it('are the same plan every time, with the class shape', () => {
    const a = levelPlan('area');
    expect(JSON.stringify(levelPlan('area'))).toBe(JSON.stringify(a));
    const S = LEVEL_SPEC;
    expect(a.counts).toMatchObject({ props: S.props, propColliders: S.propColliders, foliageSets: S.foliageSets, foliageCopies: S.foliageSets * S.foliageCopies, rooms: S.rooms, pointLights: S.pointLights, terrainTiles: 0 });
    expect(new Set(ids(a)).size).toBe(ids(a).length);
    // Every column of the layer gets its corners; a command stays a single request's size.
    const columns = a.blockEdits.filter((e) => e['kind'] === 'surface').reduce((n, e) => n + (e['columns'] as number[]).length / 6, 0);
    expect(columns).toBe(S.areaSide * S.areaSide);
    for (const e of a.blockEdits) expect(JSON.stringify(e).length).toBeLessThan(64 * 1024);
    // Rooms stand inside the layer and do not overlap.
    for (const [i, r] of a.rooms.entries()) {
      expect(r.box[0]).toBeGreaterThanOrEqual(0);
      expect(r.box[3]).toBeLessThanOrEqual(S.areaSide);
      for (const o of a.rooms.slice(i + 1)) expect(r.box[2] <= o.box[0] || o.box[2] <= r.box[0] || r.box[3] <= o.box[1] || o.box[3] <= r.box[1]).toBe(true);
    }
  });

  it('can build the rooms from edge pieces: the same rooms, walls as edges from the ground up, each edit a request\'s size', () => {
    const cells = levelPlan('area');
    const edges = levelPlan('area', undefined, 0, true);
    expect(edges.rooms).toEqual(cells.rooms);
    expect(edges.blockEdits.some((e) => e['kind'] === 'fill' && (e['cell'] as { block?: string }).block === 'rock')).toBe(false);
    const list = edges.blockEdits.filter((e) => e['kind'] === 'edges');
    expect(list).toHaveLength(2 * LEVEL_SPEC.rooms);
    for (const e of list) expect(JSON.stringify(e).length).toBeLessThan(64 * 1024);
    expect(edges.counts['edges']).toBe(list.reduce((n, e) => n + (e['at'] as number[]).length / 4, 0));
    expect(edges.counts['edges']).toBeGreaterThan(1000);
    // The default plan is unchanged by the option (the recorded classes stay comparable).
    expect(cells.edgeWalls).toBe(false);
  });

  it('can roof the rooms, and make the roofs cut-aways the layer lists, leaving the rest of the plan as it was', () => {
    const plain = levelPlan('area');
    const roofed = levelPlan('area', undefined, 0, false, false, 'roofs');
    const cut = levelPlan('area', undefined, 0, false, false, 'cutaway');
    const regions = (p: typeof plain): unknown[] => p.blockEdits.filter((e) => e['kind'] === 'region');
    expect(regions(plain)).toHaveLength(0);
    expect(regions(roofed)).toHaveLength(LEVEL_SPEC.rooms);
    expect(regions(cut)).toEqual(regions(roofed));
    expect((roofed.layer.components['blockLayer'] as { cutaway?: unknown }).cutaway).toBeUndefined();
    expect((cut.layer.components['blockLayer'] as { cutaway?: { regions: unknown[] } }).cutaway?.regions).toHaveLength(LEVEL_SPEC.rooms);
    // Each roof lies on its room's walls: the row above their top, over the whole room.
    const first = regions(roofed)[0] as { boxes: number[][] };
    const r = roofed.rooms[0]!;
    expect(first.boxes).toEqual([[r.box[0], r.top, r.box[1], r.box[2], r.top + 1, r.box[3]]]);
    expect(plain.roofs).toBe('none');
    expect(roofed.batches).toEqual(plain.batches);
  });

  it('can swap the kit while it runs, leaving the plan as it was', () => {
    const plain = levelPlan('area');
    const swapped = levelPlan('area', undefined, 0, false, false, 'none', true);
    expect(plain.kitSwap).toBe(false);
    expect(swapped.kitSwap).toBe(true);
    expect({ ...swapped, kitSwap: false }).toEqual(plain);
  });

  it('makes the landscape the area plus a terrain whose scatter rules keep off the area, the layer with its own', () => {
    const a = levelPlan('area');
    const l = levelPlan('landscape');
    // The same area (same seed and order): its entities and edits come first and match; the landscape adds the region its terrain scatter keeps clear.
    expect(ids(l).slice(0, ids(a).length)).toEqual(ids(a));
    expect(JSON.stringify(l.blockEdits.slice(0, a.blockEdits.length))).toBe(JSON.stringify(a.blockEdits));
    const N = LEVEL_SPEC.areaSide;
    expect(l.blockEdits.slice(a.blockEdits.length)).toEqual([{ kind: 'region', regionId: 'scatter-clear', op: 'set', boxes: [[0, 0, 0, N, 32, N]] }]);
    expect(l.camera).toEqual(a.camera);
    for (const r of levelScatterTerrain()) expect(r['exclude']).toEqual(['scatter-clear']);
    // Only the landscape's layer carries scatter rules (the area class stays as recorded).
    expect((a.layer.components['blockLayer'] as { scatter?: unknown }).scatter).toBeUndefined();
    expect((l.layer.components['blockLayer'] as { scatter?: unknown }).scatter).toEqual(levelScatterBlocks());
    // With and without the foliage policy, valid rules; the switch changes only the scatter.
    const off = levelPlan('landscape', undefined, 0, false, false, 'none', false, 0, false, 0, 0, 'off');
    expect({ ...off, foliage: 'on', layer: l.layer }).toEqual(l);
    const errors: ModelErrorV2[] = [];
    for (const f of ['on', 'off'] as const) {
      validateScatterRules(levelScatterTerrain(f), '/t', errors, false);
      validateScatterRules(levelScatterBlocks(f), '/b', errors, true);
    }
    expect(errors).toEqual([]);
  });

  it('keeps the terrain under the area\'s lowest ground, its tiles centred on the area and covered by the heightmap', () => {
    let lo = Infinity;
    const half = LEVEL_SPEC.areaSide / 2;
    for (let x = 0; x <= LEVEL_SPEC.areaSide; x += 1) for (let z = 0; z <= LEVEL_SPEC.areaSide; z += 1) lo = Math.min(lo, levelHeightAt(x, z) * LEVEL_SPEC.cellHeight);
    for (let x = -half; x <= half; x += 5) for (let z = -half; z <= half; z += 5) expect(levelTerrainHeight(x, z)).toBeLessThan(lo);
    const T = LEVEL_SPEC.terrain;
    const terrain = levelPlan('landscape').batches.flat().find((e) => e.id === 'terrain')!;
    expect((terrain.components['terrain'] as { tiles: unknown[] }).tiles.length).toBe(T.tiles * T.tiles);
    expect(levelTerrainOrigin()[0]).toBe(-(T.tiles * (T.tileSamples - 1) * T.spacing) / 2);
    const side = T.tiles * (T.tileSamples - 1) + 1;
    expect(levelTerrainRaw().length).toBe(side * side * 2);
  });
});

const run = (p50: number, p95: number, gpu: number | null, main: number, draws: number): FrameRunResult =>
  ({ frames: { n: 100, fps: 1000 / p50, p50, p95, p99: p95, mean: p50 }, draws: { n: 100, p50: draws, p95: draws, p99: draws, max: draws, mean: draws }, mainThread: { taskMsPerFrame: main, busyShare: 0.5 }, gpu: gpu === null ? { available: false, frames: 0, msPerFrame: 0, passes: [] } : { available: true, frames: 50, msPerFrame: gpu, passes: [] } }) as unknown as FrameRunResult;

describe('the level measurement rows', () => {
  const report = { classes: { area: { webgpu: run(8, 12, 7, 3, 300), webgl2: run(9, 20, null, 4, 320) }, landscape: { webgpu: run(11, 18, 10.5, 3.5, 380) } } } as unknown as Pick<LevelReport, 'classes'>;

  it('checks the frame p95, GPU and main-thread time against the target; no GPU timestamps is not shown, not a miss', () => {
    const rows = levelTargetRows(report);
    expect(rows.map((r) => [r.kind, r.renderer, r.within])).toEqual([
      ['area', 'webgpu', { p95: true, gpu: true, mainThread: true }],
      ['area', 'webgl2', { p95: false, gpu: null, mainThread: true }],
      ['landscape', 'webgpu', { p95: false, gpu: true, mainThread: true }],
    ]);
    expect(LEVEL_FRAME_TARGET_MS).toBe(16.7);
  });

  it('reports what the far part adds only for renderers measured in both classes', () => {
    expect(farCostRows(report)).toEqual([{ renderer: 'webgpu', p50Ms: 3, p95Ms: 6, gpuMs: 3.5, mainThreadMs: 0.5, draws: 80 }]);
  });
});
