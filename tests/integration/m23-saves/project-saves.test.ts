/**
 * Phase 23.19 (E15): project-defined save documents through the production
 * game host, in the page and in the simulation worker.
 *
 * A neutral scene: a block layer and one script. The script changes a cell,
 * keeps a value with ctx.save, writes its document and saves to slot 2; then
 * changes the cell and the value again and loads slot 2. The host carries the
 * requests out against a storage (a Map here, IndexedDB in the browser) and
 * answers through the next step's input. After the load the cell, the value
 * and the document are the saved ones — in both hosts.
 *
 * Determinism: a recorded input carrying a loaded save document replays to
 * identical step digests in the page and in the worker; and a v1 document is
 * migrated to v2 by the script's registered migration on load.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from '@thirdlight/project-model';
import { memoryProjectSaveBackend } from '@thirdlight/game-host';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const LAYER = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 2, 4] } };
const TYPES = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'wood', name: 'Wood', variants: [{ color: '#aa7744' }], shape: 'full' },
];
const SCHEMA = { version: 2, slots: 3, migrations: [{ from: 1, name: 'v1to2' }], sections: ['grid', 'storage'] };

/**
 * mode "live": saves at step 40, changes things at 60, loads at 80 (the host answers).
 * mode "replay": only registers the migration and reads (the load comes with the recorded input).
 */
const SCRIPT = (live: boolean) => `
export default {
  instantiate() { return { log: [] }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    ctx.saves.migration('v1to2', (doc, from) => ({ ...doc, upgradedFrom: from, score: (doc.points ?? 0) * 2 }));
    for (const r of ctx.saves.results()) state.log.push(r.op + ':' + r.slot + ':' + r.ok + (r.reason ? ':' + r.reason : ''));
    if (${live} && s === 40) {
      ctx.grid.set('ground-0001', 1, 1, 1, { block: 'wood' });
      ctx.save.set('points', 7);
      ctx.saves.write({ chapter: 2, flags: ['door'] });
      ctx.saves.save(2, { title: 'Before the bridge', chapter: 'Two', location: 'Mill', thumbnail: true });
    }
    if (${live} && s === 60) {
      ctx.grid.set('ground-0001', 1, 1, 1, { block: 'stone' });
      ctx.grid.clear('ground-0001', 0, 0, 0);
      ctx.save.set('points', 99);
      ctx.saves.write({ chapter: 3 });
    }
    if (${live} && s === 80) ctx.saves.load(2);
  },
  debug(state) { return { log: state.log }; },
};
`;

function snapshot(): Any {
  const g = new BlockGrid(LAYER as Any);
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 4, 1, 4], cell: { block: 'stone' } }], { types: new Map(TYPES.map((t) => [t.blockId, t as Any])), stamps: new Map() });
  const data = g.toData('ground-0001', null, g.takeDirty().chunks)!;
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([2, 4, 10]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 100 } } },
    { id: 'ground-0001', components: { transform: T([0, 0, 0]), blockLayer: LAYER } },
    { id: 'saver-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'saver', values: {} } } },
  ];
  return { snapshotId: 'sav@r1', projectId: 'sav', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [data] }, blockTypes: TYPES, saveSchema: SCHEMA };
}

async function run(mode: Mode, opts: { live: boolean; steps: number; store: Map<string, string>; replay?: Any[] }): Promise<{ h: Harness; digests: string[] }> {
  const mod = behaviorModule('saver', SCRIPT(opts.live));
  const h = await startHarness(mode, {
    snapshot: snapshot(),
    settings: SETTINGS,
    physics: null,
    digestSteps: true,
    behaviors: [mod],
    host: { projectSaveBackend: memoryProjectSaveBackend(opts.store), saveNamespace: 'test' },
    storage: opts.live,
    ...(opts.replay !== undefined ? { replay: opts.replay } : {}),
  });
  let now = 10;
  let i = 0;
  while (h.digests.length < opts.steps) {
    const n = [1, 2, 0, 3, 1][i++ % 5]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
    // Let the host's storage work (promises) finish between frames, as a browser does between rAFs.
    await h.host.projectSaves?.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
  const d = h.rt.getDiagnostics();
  if (d.ok && d.diagnostics.errors.length > 0) throw new Error(JSON.stringify(d.diagnostics.errors));
  return { h, digests: [...h.digests] };
}

describe('phase 23.19: project save documents (page and worker)', () => {
  it('save to slot 2 with metadata, change things, load slot 2 — the cell, the value and the document come back (page and worker alike)', async () => {
    const runs: Record<string, { h: Harness; digests: string[]; store: Map<string, string> }> = {};
    try {
      for (const mode of ['single', 'worker'] as const) {
        const store = new Map<string, string>();
        runs[mode] = { ...(await run(mode, { live: true, steps: 140, store })), store };
      }
      for (const mode of ['single', 'worker'] as const) {
        const { h, store } = runs[mode]!;
        // The storage holds slot 2: its record and its body (the document and the opted-in sections).
        const meta = JSON.parse(store.get('test:slot:2:meta')!);
        expect(meta).toMatchObject({ slot: 2, title: 'Before the bridge', chapter: 'Two', location: 'Mill', version: 2 });
        const body = JSON.parse(store.get('test:slot:2:body')!);
        expect(body.doc).toEqual({ chapter: 2, flags: ['door'] });
        expect(body.sections.storage).toEqual({ points: 7 });
        expect(body.sections.grid.layers[0].cells).toEqual([[1, 1, 1, { block: 'wood' }]]);
        // The host's observation lists the slot with its metadata.
        const obs = h.host.observe() as Any;
        expect(obs.ok).toBe(true);
        expect(obs.observation.saves.slotCount).toBe(3);
        expect(obs.observation.saves.slots.map((x: Any) => [x.slot, x.title, x.chapter, x.location])).toEqual([[2, 'Before the bridge', 'Two', 'Mill']]);
      }
      // After the load, the page's runtime holds the saved state again: the cell back to wood, the cleared one back, the document.
      const rt = runs['single']!.h.rt as Any;
      expect(rt.gridDiff().layers[0].cells).toEqual([[1, 1, 1, { block: 'wood' }]]);
      expect(rt.savesState()).toContain('{"chapter":2,"flags":["door"]}');
      expect(await runs['single']!.h.storage()).toEqual({ points: 7 });
      // (Live runs differ in savedAt — the player's clock — so step-exact parity is the recorded-input test below.)
    } finally {
      for (const r of Object.values(runs)) await r.h.dispose();
    }
  }, 180_000);

  it('a recorded input with a loaded v1 save replays to identical digests in the page and the worker; the v1 document is migrated on load', async () => {
    const LOAD_STEP = 50;
    const file = {
      format: 'thirdlight.save',
      version: 1,
      playSeconds: 12.5,
      doc: { points: 21 },
      sections: { grid: { version: 1, layers: [{ layer: 'ground-0001', cells: [[2, 1, 2, { block: 'wood' }], [0, 0, 0, null]] }] }, storage: { points: 3 } },
    };
    const replay = [{ stepIndex: LOAD_STEP, moveX: 0, jump: 'none', saves: [{ kind: 'loaded', slot: 1, ok: true, save: file }] }];
    const page = await run('single', { live: false, steps: 120, store: new Map(), replay });
    const worker = await run('worker', { live: false, steps: 120, store: new Map(), replay });
    const idle = await run('single', { live: false, steps: 120, store: new Map() });
    try {
      const n = Math.min(page.digests.length, worker.digests.length);
      expect(n).toBeGreaterThanOrEqual(120);
      expect(worker.digests.slice(0, n)).toEqual(page.digests.slice(0, n));
      // The load moved the digests (the restored state is simulation state).
      expect(page.digests.slice(0, n)).not.toEqual(idle.digests.slice(0, n));
      const rt = page.h.rt as Any;
      expect(rt.savesState()).toContain('"points":21');
      expect(rt.savesState()).toContain('"upgradedFrom":1');
      expect(rt.savesState()).toContain('"score":42');
      expect(rt.gridDiff().layers[0].cells).toEqual([[0, 0, 0, null], [2, 1, 2, { block: 'wood' }]]);
    } finally {
      await page.h.dispose();
      await worker.h.dispose();
      await idle.h.dispose();
    }
  }, 180_000);
});
