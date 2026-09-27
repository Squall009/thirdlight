/**
 * Phase 23.5 (E8): block layers in the running game — through the production
 * game host, in the page and in the simulation worker.
 *
 * A neutral 3D scene: a block layer (1 × 0.5 × 1 m cells) holding an 8 × 8
 * floor two cells deep, a mesh floor 4 m below it and a player capsule above
 * the floor's middle. The capsule falls and lands on the blocks (their chunk
 * collider). A script clears the cells under the player at one step; the
 * chunk collider is rebuilt before that step's physics sweep (the sweep finds
 * no support any more) and the player falls through the hole onto the lower
 * floor. Page and worker give identical digests and positions; the renderer's
 * chunk change arrives in both.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const LAYER = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [8, 4, 8] } };
const TYPES = [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' }];
const DIG_STEP = 240;

/** Clears the two cells under the player at one step (the intent phase, before physics). */
const DIGGER = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'intent' || ctx.stepIndex !== ${DIG_STEP}) return;
    const layer = ctx.grid.layers()[0];
    const p = ctx.world.transform('player-0001').position;
    const cell = ctx.grid.worldToCell(layer, [p[0], p[1], p[2]]);
    ctx.grid.clear(layer, cell.x, 1, cell.z);
    ctx.grid.clear(layer, cell.x, 0, cell.z);
  },
};
`;

function scene(withDigger: boolean): { snapshot: Any; physics: Any } {
  const g = new BlockGrid(LAYER as Any);
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 8, 2, 8], cell: { block: 'stone' } }], { types: new Map(TYPES.map((t) => [t.blockId, t as Any])), stamps: new Map() });
  const data = g.toData('ground-0001', null, g.takeDirty().chunks)!;
  const lower = { type: 'mesh', vertices: [[-8, -4, -8], [16, -4, -8], [16, -4, 16], [-8, -4, 16]], triangles: [[0, 2, 1], [0, 3, 2]] };
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([4, 6, 16]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([4.5, 3, 4.5]), controller: {} } },
    { id: 'ground-0001', components: { transform: T([0, 0, 0]), blockLayer: LAYER } },
    { id: 'lower-0001', components: { transform: T([0, 0, 0]), collider: { shape: lower } } },
    ...(withDigger ? [{ id: 'digger-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'digger', values: {} } } }] : []),
  ];
  return {
    snapshot: { snapshotId: 'blk@r1', projectId: 'blk', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [data] }, game: null, blockTypes: TYPES },
    physics: physics3DConfigOf(entities, SETTINGS),
  };
}

/** Moves its own (empty) entity at the digging step: marks which digest belongs to that step. */
const MARKER = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'transform' || ctx.stepIndex !== ${DIG_STEP}) return;
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: 1 } });
  },
};
`;

/** The port calls in order: collider removals/additions and each step's grounded result. */
type PortEvent = { kind: 'remove' | 'add'; ids: string[] } | { kind: 'step'; grounded: boolean };

async function run(mode: Mode, kind: 'idle' | 'dig' | 'marker', steps: number, events?: PortEvent[]): Promise<{ h: Harness; digests: string[]; player: number[] }> {
  // Every run steps through the behavior host (the same script slot), so the runs step alike.
  const source = kind === 'dig' ? DIGGER : kind === 'marker' ? MARKER : 'export default { instantiate() { return {}; }, step() {} };';
  const mod = behaviorModule('digger', source);
  const behaviors = [{ row: { ...mod.row, ownedTransforms: ['@self'] }, url: mod.url }];
  const s = scene(true);
  const wrapPhysics = events === undefined
    ? undefined
    : (port: Any): Any => {
        const step = port.step.bind(port);
        const add = port.addStaticColliders.bind(port);
        const remove = port.removeStaticColliders.bind(port);
        port.step = () => {
          const r = step();
          events.push({ kind: 'step', grounded: r.grounded });
          return r;
        };
        port.addStaticColliders = (specs: Any[]) => {
          events.push({ kind: 'add', ids: specs.map((x) => x.entityId) });
          return add(specs);
        };
        port.removeStaticColliders = (ids: string[]) => {
          events.push({ kind: 'remove', ids: [...ids] });
          return remove(ids);
        };
        return port;
      };
  const h = await startHarness(mode, { snapshot: s.snapshot, settings: SETTINGS, physics: s.physics, digestSteps: true, host: { buildId: 'b' }, behaviors, ...(wrapPhysics !== undefined ? { wrapPhysics } : {}) });
  let now = 10;
  let i = 0;
  while (h.digests.length < steps) {
    const n = [1, 2, 0, 3, 1][i++ % 5]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
  }
  const d = h.rt.getDiagnostics();
  if (d.ok && d.diagnostics.errors.length > 0) throw new Error(JSON.stringify(d.diagnostics.errors));
  const player = [...h.rt.getInterpolatedState().state.transforms.find((t: Any) => t.id === 'player-0001')!.position];
  return { h, digests: [...h.digests], player };
}

describe('phase 23.5: block layers in the running game (page and worker)', () => {
  it('the start layer collides: its chunk becomes a triangle-mesh collider in the runtime, not in the init config', () => {
    const { physics } = scene(false);
    // The layer entity carries no collider of its own; the runtime adds the chunk colliders.
    expect(physics.statics.map((s: Any) => s.entityId)).toEqual(['lower-0001']);
  });

  it('the player lands on the blocks; clearing the cells under it drops it through in the same step, identical in page and worker', async () => {
    const STEPS = 480;
    const idle = await run('single', 'idle', STEPS);
    const marker = await run('single', 'marker', STEPS);
    const events: PortEvent[] = [];
    const a = await run('single', 'dig', STEPS, events);
    const w = await run('worker', 'dig', STEPS);
    try {
      // Without the script the player rests on the blocks' top (1 m) plus half its 1.8 m height and the skin.
      expect(idle.player[1]).toBeGreaterThan(1 + 0.9 - 1e-3);
      expect(idle.player[1]).toBeLessThan(1 + 0.9 + 0.02);
      // With it the player fell through the hole onto the lower floor (-4 m).
      expect(a.player[1]).toBeGreaterThan(-4 + 0.9 - 1e-3);
      expect(a.player[1]).toBeLessThan(-4 + 0.9 + 0.02);
      // Same step: the chunk's collider is rebuilt (removed, re-added without the column) before
      // that step's physics sweep, and the sweep already finds no support under the player.
      const removal = events.findIndex((e) => e.kind === 'remove');
      expect(removal).toBeGreaterThan(0);
      expect(events[removal]).toEqual({ kind: 'remove', ids: ['ground-0001#blocks:0,0:0'] });
      expect(events[removal + 1]).toEqual({ kind: 'add', ids: ['ground-0001#blocks:0,0:0'] });
      const stepsBefore = events.slice(0, removal).filter((e) => e.kind === 'step') as { grounded: boolean }[];
      expect(stepsBefore[stepsBefore.length - 1]!.grounded).toBe(true);
      expect(events[removal + 2]).toEqual({ kind: 'step', grounded: false });
      // In digests: the marker script moves its entity in the digging step (its first differing digest
      // names that step); the player's position first differs one step later — the 3D character phase
      // (phase 23.0) starts a fall from rest at the step after its support went away, as when it walks
      // off an edge.
      const firstDiff = (x: string[]): number => x.slice(0, Math.min(x.length, idle.digests.length)).findIndex((d, k) => d !== idle.digests[k]);
      const digStepDigest = firstDiff(marker.digests);
      expect(digStepDigest).toBeGreaterThan(0);
      expect(firstDiff(a.digests)).toBe(digStepDigest + 1);
      // Page and worker agree step by step.
      const m = Math.min(a.digests.length, w.digests.length);
      expect(a.digests.slice(0, m)).toEqual(w.digests.slice(0, m));
      expect(w.player).toEqual(a.player);
      // The renderer's chunk changes (the adapter takes them each frame; none here): the dug chunk without the column.
      for (const h of [a.h, w.h]) {
        const changes = (h.rt as Any).takeGridChanges() as Any[];
        const chunk = changes.filter((c) => c.entityId === 'ground-0001' && c.cx === 0 && c.cz === 0).pop();
        expect(chunk).toBeDefined();
        const columns = chunk.chunk.columns as number[][];
        expect(columns.find((c) => c[0] === 4 && c[1] === 4)).toBeUndefined();
        expect(columns.length).toBe(63);
      }
    } finally {
      await idle.h.dispose();
      await marker.h.dispose();
      await a.h.dispose();
      await w.h.dispose();
    }
  }, 180_000);
});
