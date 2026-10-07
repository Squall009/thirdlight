/**
 * Opt-in (TL_PERF=1): what live blocks cost the simulation.
 *
 *   TL_PERF=1 npx vitest run tests/perf/live-blocks.test.ts
 *
 * A 64 × 64 stone floor with 500 door cells on it, run through the production
 * game host (the page composition, real Rapier): each door spawns a root with
 * a script (it reads its cell's `open` field every step) and a leaf with a box
 * and a box collider. Against the same floor whose 500 cells are a plain
 * block (no objects):
 *
 * - load: the first frame (the start set, the doors spawned at the first step);
 * - step: the simulation's time per fixed step over 600 steps (what the
 *   worker spends, one frame behind the page);
 * - churn: one door cleared and one written back every step (a spawn and a
 *   despawn per step);
 * - memory: the heap the doors keep (after a full collection).
 *
 * The numbers go to ~/.cache/thirdlight-perf/live-blocks.jsonl and docs/plan-phase-30.md.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Harness } from '../integration/m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const SIDE = 64;
const DOORS = 500;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const LAYER = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [SIDE, 4, SIDE] } };
const PREFAB = {
  prefabId: 'door',
  displayName: 'Door',
  createdRevision: 1,
  entityCount: 2,
  depth: 2,
  entities: [
    { localId: 'group-0001', name: 'Door', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'door', values: {} } } },
    { localId: 'box-0001', name: 'Leaf', parentLocalId: 'group-0001', components: { transform: T([0, 1, 0]), box: { size: [0.9, 2, 0.1], material: { color: '#8b5a2b' } }, collider: { shape: { type: 'box', hx: 0.45, hy: 1, hz: 0.05 } } } },
  ],
};
const DOOR = `
export default {
  instantiate() { return { open: false, cell: null }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    if (state.cell === null) state.cell = ctx.grid.cellOf(ctx.entityId);
    const c = state.cell;
    if (c === null) return;
    const open = ctx.grid.meta(c.layer, c.x, c.y, c.z, 'open') === true;
    if (open !== state.open) { state.open = open; ctx.signals.emit('door'); }
  },
};
`;
/** With churn: one door cleared and one written back every step, walking the doors. */
const CHURN = (on: boolean) => `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (!${on} || ctx.phase !== 'intent' || ctx.stepIndex < 10) return;
    const i = ctx.stepIndex % ${DOORS};
    const x = i % ${SIDE}, z = Math.floor(i / ${SIDE}) * 4;
    if (ctx.grid.get('ground-0001', x, 1, z) !== null) ctx.grid.clear('ground-0001', x, 1, z);
    else ctx.grid.set('ground-0001', x, 1, z, { block: 'door' });
  },
};
`;

function doorCells(): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < DOORS; i++) out.push([i % SIDE, Math.floor(i / SIDE) * 4]);
  return out;
}

function scene(live: boolean): { snapshot: Any; physics: Any } {
  const types = [
    { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
    live ? { blockId: 'door', name: 'Door', variants: [{ prefab: 'door' }], shape: 'none', live: true } : { blockId: 'door', name: 'Door', variants: [{ color: '#8b5a2b' }], shape: 'none' },
  ];
  const g = new BlockGrid(LAYER as Any);
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, SIDE, 1, SIDE], cell: { block: 'stone' } }, ...doorCells().map(([x, z]) => ({ kind: 'fill', box: [x, 1, z, x + 1, 2, z + 1], cell: { block: 'door' } }))] as Any, { types: new Map(types.map((t) => [t.blockId, t as Any])), stamps: new Map() });
  const data = g.toData('ground-0001', null, g.takeDirty().chunks)!;
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([32, 20, 80]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 300 } } },
    { id: 'player-0001', components: { transform: T([0.5, 3, 0.5]), controller: {} } },
    { id: 'ground-0001', components: { transform: T([0, 0, 0]), blockLayer: LAYER } },
    { id: 'churn-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'churn', values: {} } } },
  ];
  return {
    snapshot: { snapshotId: 'livep@r1', projectId: 'livep', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [data] }, blockTypes: types, cellFields: [{ key: 'open', type: 'bool' }], prefabs: [PREFAB] },
    physics: physics3DConfigOf(entities, SETTINGS),
  };
}

function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'live-blocks.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const r2 = (v: number): number => Math.round(v * 100) / 100;

describe.skipIf(process.env['TL_PERF'] === undefined)('live blocks: measurements (opt-in)', () => {
  it('500 live doors: load, step, churn and heap against the same cells without objects', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const heap = (): number => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };
    const measure = async (live: boolean, churn: boolean): Promise<{ loadMs: number; stepMs: number; heapMb: number; objects: number }> => {
      const s = scene(live);
      const h0 = heap();
      const h: Harness = await startHarness('single', { snapshot: s.snapshot, settings: SETTINGS, physics: s.physics, behaviors: [behaviorModule('door', DOOR), behaviorModule('churn', CHURN(churn))], host: { buildId: 'b' } });
      try {
        let now = 10;
        const t0 = performance.now();
        await h.tick(now);
        now += DT;
        await h.tick(now);
        const loadMs = performance.now() - t0;
        for (let i = 0; i < 60; i++) await h.tick((now += DT));
        const per: number[] = [];
        for (let i = 0; i < 600; i++) {
          const t = performance.now();
          await h.tick((now += DT));
          per.push(performance.now() - t);
        }
        const objects = (h.rt.sceneSet().spawned as Any[]).length;
        const heapMb = (heap() - h0) / 1048576;
        const errors = ((h.rt.getDiagnostics() as Any).diagnostics?.errors ?? []) as Any[];
        expect(errors).toEqual([]);
        return { loadMs: r2(loadMs), stepMs: r2(median(per)), heapMb: r2(heapMb), objects };
      } finally {
        await h.dispose();
      }
    };
    // Warm the code paths once, then measure.
    await measure(true, false);
    const plain = await measure(false, false);
    const live = await measure(true, false);
    const plainChurn = await measure(false, true);
    const churn = await measure(true, true);
    expect(live.objects).toBe(DOORS * 2);
    record(`live-blocks ${DOORS} doors: plain ${JSON.stringify(plain)} | live ${JSON.stringify(live)} | plain+churn ${JSON.stringify(plainChurn)} | live+churn ${JSON.stringify(churn)} | per door: load ${r2(((live.loadMs - plain.loadMs) / DOORS) * 1000)} µs, step ${r2(((live.stepMs - plain.stepMs) / DOORS) * 1000)} µs, heap ${r2(((live.heapMb - plain.heapMb) * 1024) / DOORS)} KB`);
  }, 600_000);
});
