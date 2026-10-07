/**
 * The level-building perf classes without a browser: the plans are
 * deterministic and have the classes' shape, the landscape is the area plus
 * a far part that lies outside it, the ground plane is a valid GLB, and the
 * measurement's target and far-cost rows read the report as the log says.
 */
import { describe, expect, it } from 'vitest';

import { groundPlaneGlb, levelHeightAt, levelPlan, LEVEL_SPEC } from '../../tools/perf/level';
import { farCostRows, levelTargetRows, LEVEL_FRAME_TARGET_MS, type LevelReport } from '../../tools/perf/level-run';
import type { FrameRunResult } from '../../tools/perf/frame-run';

const ids = (p: ReturnType<typeof levelPlan>): string[] => p.batches.flat().map((e) => e.id);

describe('the level classes', () => {
  it('are the same plan every time, with the class shape', () => {
    const a = levelPlan('area');
    expect(JSON.stringify(levelPlan('area'))).toBe(JSON.stringify(a));
    const S = LEVEL_SPEC;
    expect(a.counts).toMatchObject({ props: S.props, propColliders: S.propColliders, foliageSets: S.foliageSets, foliageCopies: S.foliageSets * S.foliageCopies, rooms: S.rooms, pointLights: S.pointLights, farSets: 0, groundPlane: 0 });
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

  it('makes the landscape the area plus far rings outside it, under the far plane', () => {
    const a = levelPlan('area');
    const l = levelPlan('landscape');
    const S = LEVEL_SPEC;
    // The same area (same seed and order): its entities and edits come first and match.
    expect(ids(l).slice(0, ids(a).length)).toEqual(ids(a));
    expect(JSON.stringify(l.blockEdits)).toBe(JSON.stringify(a.blockEdits));
    expect(l.camera).toEqual(a.camera);
    expect(l.counts['farSets']).toBe(S.farRings.length * S.farSectors);
    expect(l.counts['farCopies']).toBe(S.farRings.length * S.farSectors * S.farCopies);
    const far = l.batches.flat().filter((e) => e.id.startsWith('far-'));
    const outer = S.farRings[S.farRings.length - 1]![1];
    for (const e of far) {
      const [cx, , cz] = (e.components['transform'] as { position: number[] }).position as [number, number, number];
      const f = l.buffers.find((b) => `far-${b.key.slice(4)}` === e.id)!.floats;
      for (let i = 0; i < f.length; i += 10) {
        const r = Math.hypot(cx + f[i]!, cz + f[i + 2]!);
        // Outside the area's corner (half the diagonal), inside the far plane.
        expect(r).toBeGreaterThan((S.areaSide / 2) * Math.SQRT2);
        expect(r).toBeLessThanOrEqual(outer + 0.01);
      }
    }
    expect(outer).toBeLessThan(S.farPlane);
  });

  it('keeps the far ground under the area\'s lowest ground', () => {
    let lo = Infinity;
    for (let x = 0; x <= LEVEL_SPEC.areaSide; x += 1) for (let z = 0; z <= LEVEL_SPEC.areaSide; z += 1) lo = Math.min(lo, levelHeightAt(x, z) * LEVEL_SPEC.cellHeight);
    const plane = levelPlan('landscape').batches.flat().find((e) => e.id === 'ground-plane')!;
    expect((plane.components['transform'] as { position: number[] }).position[1]).toBeLessThan(lo);
  });

  it('makes a valid ground plane GLB', () => {
    const glb = groundPlaneGlb(6000, 8);
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { accessors: { count: number; max?: number[] }[] };
    expect(json.accessors[0]!.count).toBe(81);
    expect(json.accessors[3]!.count).toBe(8 * 8 * 6);
    expect(json.accessors[0]!.max).toEqual([3000, 0, 3000]);
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
