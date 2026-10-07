/**
 * Live blocks in the running game — through the production game host, in
 * the page and in the simulation worker, with Rapier.
 *
 * A neutral 3D scene: a block layer with a stone floor and a `door` block
 * type marked live, whose look is a prefab (a root with a model, a script and
 * a child leaf with a box and a collider). Two door cells are authored; a
 * script writes a third (turned) and clears one at fixed steps. Each door
 * cell spawns the prefab as objects with the cell's ids, placed at the cell
 * (the root's model left to the chunk mesh), in the step the cell is written
 * and gone in the step it is cleared; the door's script finds its cell.
 * Scripts cannot destroy a live block's object; spawned-copy saves leave
 * them out. Page and worker agree step by step.
 *
 * Saves: the grid section keeps the written cells; loading it brings the
 * door back (spawned again from the cell) and the components section's
 * written fields reach the respawned object.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const T = (position: number[], rotation = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
const LAYER = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [8, 4, 8] } };
const TYPES = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'door', name: 'Door', variants: [{ prefab: 'door' }], shape: 'none', live: true },
];
const FIELDS = [{ key: 'open', type: 'bool' }];
const L = 'ground-0001';
const PREFAB = {
  prefabId: 'door',
  displayName: 'Door',
  createdRevision: 1,
  entityCount: 2,
  depth: 2,
  entities: [
    { localId: 'group-0001', name: 'Door', components: { transform: T([0, 0, 0]), model: { asset: { assetId: 'door-frame' } }, behavior: { behaviorId: 'door-logic', values: {} } } },
    { localId: 'box-0001', name: 'Leaf', parentLocalId: 'group-0001', components: { transform: T([0.25, 0.5, 0]), box: { size: [0.5, 1, 0.1], material: { color: '#c03030' } }, collider: { shape: { type: 'box', hx: 0.25, hy: 0.5, hz: 0.05 } } } },
  ],
};

/** Each door's script records, once, the step it first ran in and its cell (with the cell's metadata). */
const DOOR_LOGIC = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const seen = ctx.save.get('doors') ?? {};
    if (seen[ctx.entityId] !== undefined) return;
    const c = ctx.grid.cellOf(ctx.entityId);
    seen[ctx.entityId] = { step: ctx.stepIndex, cell: c === null ? null : [c.layer, c.x, c.y, c.z], open: c === null ? null : ctx.grid.meta(c.layer, c.x, c.y, c.z, 'open') };
    ctx.save.set('doors', seen);
  },
};
`;

/** Writes a turned door at step 30, clears an authored one at 40, tries to destroy one; records what it saw a step later. */
const BUILDER = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const L = '${L}';
    const s = ctx.stepIndex;
    if (s === 30) {
      ctx.grid.set(L, 6, 2, 6, { block: 'door', rot: 180, meta: { open: true } });
      ctx.save.set('id30', ctx.grid.entity(L, 6, 2, 6));
      ctx.save.set('stone30', ctx.grid.entity(L, 0, 0, 0));
      ctx.save.set('there30', ctx.world.transform('ground-0001-6_2_6') != null);
    }
    if (s === 31) ctx.save.set('there31', ctx.world.transform('ground-0001-6_2_6') != null);
    if (s === 40) ctx.grid.clear(L, 2, 2, 2);
    if (s === 41) ctx.save.set('gone41', ctx.world.transform('ground-0001-2_2_2') == null && ctx.world.transform('ground-0001-2_2_2-1') == null);
    if (s === 45) {
      try { ctx.destroy('ground-0001-5_2_3'); ctx.save.set('destroy', 'allowed'); } catch (e) { ctx.save.set('destroy', String(e && e.message).slice(0, 120)); }
    }
  },
};
`;

function scene(scriptId: string, saves: boolean): { snapshot: Any; physics: Any } {
  const g = new BlockGrid(LAYER as Any);
  const types = new Map(TYPES.map((t) => [t.blockId, t as Any]));
  applyBlockEdits(
    g,
    [
      { kind: 'fill', box: [0, 0, 0, 8, 2, 8], cell: { block: 'stone' } },
      { kind: 'fill', box: [2, 2, 2, 3, 3, 3], cell: { block: 'door' } },
      { kind: 'fill', box: [5, 2, 3, 6, 3, 4], cell: { block: 'door', rot: 90 } },
    ] as Any,
    { types, stamps: new Map() },
  );
  const data = g.toData(L, null, g.takeDirty().chunks)!;
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([4, 6, 16]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', keepLoaded: true, components: { transform: T([0.5, 2, 7.5]), controller: {} } },
    { id: L, components: { transform: T([0, 0, 0]), blockLayer: LAYER } },
    { id: 'builder-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: scriptId, values: {} } } },
  ];
  return {
    snapshot: {
      snapshotId: 'live@r1',
      projectId: 'live',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [data] },
      scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }],
      blockTypes: TYPES,
      cellFields: FIELDS,
      prefabs: [PREFAB],
      ...(saves ? { saveSchema: { version: 1, slots: 2, sections: ['grid', 'components', 'storage'] } } : {}),
    },
    physics: physics3DConfigOf(entities, SETTINGS),
  };
}

const clocks = new WeakMap<Harness, { now: number; i: number }>();

const stepIndexOf = (h: Harness): number => (h.rt.getDiagnostics() as Any).diagnostics?.stepIndex ?? 0;

/** Tick until the run has executed `count` steps (uneven frames, as a browser's). */
async function steps(h: Harness, count: number): Promise<void> {
  const c = clocks.get(h)!;
  while (stepIndexOf(h) < count) {
    const n = [1, 2, 0, 3, 1][c.i++ % 5]!;
    c.now += n * DT + DT * 0.1 * ((c.i % 3) - 1);
    try {
      await h.tick(c.now);
    } catch (e) {
      throw new Error(`${(e as Error).message}: ${JSON.stringify((h.rt.getDiagnostics() as Any).diagnostics?.errors ?? []).slice(0, 1500)}`);
    }
  }
}

async function run(mode: Mode, count: number, script: { id: string; source: string }, saves = false): Promise<Harness> {
  const s = scene(script.id, saves);
  const behaviors = [behaviorModule('door-logic', DOOR_LOGIC), behaviorModule(script.id, script.source)];
  const h = await startHarness(mode, { snapshot: s.snapshot, settings: SETTINGS, physics: s.physics, digestSteps: true, host: { buildId: 'b' }, behaviors, storage: true });
  clocks.set(h, { now: 10, i: 0 });
  await steps(h, count);
  return h;
}

const spawnedIds = (h: Harness): string[] => (h.rt.sceneSet().spawned as Any[]).map((e) => e.id);
const transformOf = (h: Harness, id: string): Any => h.rt.getInterpolatedState().state.transforms.find((t: Any) => t.id === id);

describe('live blocks in the running game (page and worker)', () => {
  it('each live cell spawns its prefab with the cell\'s ids, in the step it is written, and loses it in the step it is cleared', async () => {
    const a = await run('single', 90, { id: 'builder', source: BUILDER });
    const w = await run('worker', 90, { id: 'builder', source: BUILDER });
    try {
      for (const h of [a, w]) {
        const errors = (h.rt.getDiagnostics() as Any).diagnostics?.errors ?? [];
        expect(errors.filter((e: Any) => e.code !== 'module_error' || !String(e.message).includes('live block'))).toEqual([]);
        // The authored door at 5,2,3 and the written one at 6,2,6 remain; the cleared one at 2,2,2 is gone.
        expect(spawnedIds(h).sort()).toEqual(['ground-0001-5_2_3', 'ground-0001-5_2_3-1', 'ground-0001-6_2_6', 'ground-0001-6_2_6-1']);
        // Placed at the bottom centre of the cell, turned with it (180° about +Y); the leaf keeps its local offset.
        const root = transformOf(h, 'ground-0001-6_2_6');
        expect(root.position.map((v: number) => Math.round(v * 1e6) / 1e6)).toEqual([6.5, 1, 6.5]);
        expect(Math.abs(root.rotation[1])).toBeCloseTo(1, 6);
        const turned = transformOf(h, 'ground-0001-5_2_3');
        expect(turned.position.map((v: number) => Math.round(v * 1e6) / 1e6)).toEqual([5.5, 1, 3.5]);
        expect(turned.rotation[1]).toBeCloseTo(Math.SQRT1_2, 6);
        // The root's model stays with the chunk mesh; the leaf keeps its box and collider; ids, parents, provenance.
        const docs = new Map((h.rt.sceneSet().spawned as Any[]).map((e) => [e.id, e]));
        expect(docs.get('ground-0001-6_2_6').components.model).toBeUndefined();
        expect(docs.get('ground-0001-6_2_6').components.behavior.behaviorId).toBe('door-logic');
        expect(docs.get('ground-0001-6_2_6-1').parentId).toBe('ground-0001-6_2_6');
        expect(docs.get('ground-0001-6_2_6-1').components.box).toBeDefined();
        expect(docs.get('ground-0001-6_2_6-1').components.prefab).toEqual({ prefabId: 'door', localId: 'box-0001' });
        const st = await h.storage();
        // ctx.grid.entity names the cell's object at once; it is in the game from the end of that step on.
        expect(st['id30']).toBe('ground-0001-6_2_6');
        expect(st['stone30']).toBeNull();
        expect(st['there30']).toBe(false);
        expect(st['there31']).toBe(true);
        expect(st['gone41']).toBe(true);
        expect(String(st['destroy'])).toContain('goes with its cell');
        // Each door's script found its cell (and the written one's metadata) on its first step.
        const doors = st['doors'] as Record<string, Any>;
        expect(doors['ground-0001-2_2_2']).toEqual({ step: 0, cell: [L, 2, 2, 2], open: false });
        expect(doors['ground-0001-5_2_3']).toEqual({ step: 0, cell: [L, 5, 2, 3], open: false });
        expect(doors['ground-0001-6_2_6']).toEqual({ step: 31, cell: [L, 6, 2, 6], open: true });
      }
      const m = Math.min(a.digests.length, w.digests.length);
      expect(a.digests.slice(0, m)).toEqual(w.digests.slice(0, m));
    } finally {
      await a.dispose();
      await w.dispose();
    }
  }, 180_000);

  it('a save keeps the cells; loading it spawns the door again and gives its object the saved fields', async () => {
    // Loading a save restores its storage section too: what the script records after the load is what the test reads.
    const SAVER = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const L = '${L}';
    const s = ctx.stepIndex;
    if (s === 20) ctx.grid.set(L, 6, 2, 6, { block: 'door' });
    if (s === 22) ctx.entity('ground-0001-6_2_6-1').set('object', { visible: false });
    if (s === 24) ctx.saves.save(1);
    if (s === 30) ctx.grid.clear(L, 6, 2, 6);
    if (s === 60) ctx.saves.load(1);
    for (const r of ctx.saves.results()) if (r.op === 'load') ctx.save.set('loaded', r.ok);
    if (ctx.save.get('loaded') === true && ctx.save.get('back') === undefined) {
      ctx.save.set('back', ctx.world.transform('ground-0001-6_2_6-1') != null);
      ctx.save.set('visible', ctx.entity('ground-0001-6_2_6-1').get('object').visible);
    }
  },
};
`;
    for (const mode of ['single', 'worker'] as const) {
      const h = await run(mode, 40, { id: 'saver', source: SAVER }, true);
      try {
        // Cleared at step 30: the door's objects went with the cell.
        expect(spawnedIds(h)).not.toContain('ground-0001-6_2_6');
        await steps(h, 100);
        const st = await h.storage();
        expect(st['loaded']).toBe(true);
        expect(st['back']).toBe(true);
        expect(st['visible']).toBe(false);
        expect(spawnedIds(h)).toContain('ground-0001-6_2_6-1');
      } finally {
        await h.dispose();
      }
    }
  }, 180_000);

  it('a scene reload and a run restart put the authored live blocks back as fresh objects, and only them', async () => {
    const RELOADER = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const L = '${L}';
    const s = ctx.stepIndex;
    const n = (ctx.save.get('n') ?? 0) + 1;
    ctx.save.set('n', n);
    if (s === 10) { ctx.grid.set(L, 6, 2, 6, { block: 'door' }); ctx.grid.clear(L, 2, 2, 2); }
    if (s === 40) ctx.scenes.reload('scene-main');
    if (s === 60) ctx.grid.set(L, 1, 2, 1, { block: 'door', rot: 270 });
    if (s === 80) ctx.lifecycle.restart();
  },
};
`;
    const ids = ['ground-0001-2_2_2', 'ground-0001-2_2_2-1', 'ground-0001-5_2_3', 'ground-0001-5_2_3-1'];
    for (const mode of ['single', 'worker'] as const) {
      const h = await run(mode, 30, { id: 'reloader', source: RELOADER });
      try {
        expect(spawnedIds(h).sort()).toEqual(['ground-0001-5_2_3', 'ground-0001-5_2_3-1', 'ground-0001-6_2_6', 'ground-0001-6_2_6-1']);
        await steps(h, 55);
        // Reloaded: the scene's cells as authored, so its doors as authored.
        expect(spawnedIds(h).sort()).toEqual(ids);
        await steps(h, 70);
        expect(spawnedIds(h)).toContain('ground-0001-1_2_1');
        const docOf = (id: string): unknown => (h.rt.sceneSet().spawned as Any[]).find((e) => e.id === id);
        const before = docOf('ground-0001-5_2_3');
        await steps(h, 100);
        expect(spawnedIds(h).sort()).toEqual(ids);
        // Restarted: the same ids, new objects.
        expect(docOf('ground-0001-5_2_3')).not.toBe(before);
        const errors = ((h.rt.getDiagnostics() as Any).diagnostics?.errors ?? []).filter((e: Any) => e.code !== 'module_error');
        expect(errors.filter((e: Any) => e.code === 'spawn_refused' || e.code === 'scene_load_failed')).toEqual([]);
      } finally {
        await h.dispose();
      }
    }
  }, 180_000);
});
