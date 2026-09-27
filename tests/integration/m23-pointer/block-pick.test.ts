/**
 * Phase 23.3 × 23.5: a 3D query that hits a block layer's chunk collider
 * reports the layer's entity and the cell it hit (`hit.cell`, the cell just
 * inside the surface — `ctx.grid` coordinates), the same cell `ctx.grid.pick`
 * finds along the same ray; an overlap reports the layer once; a filter's
 * exclusion names the layer. A scene without a player with only a block
 * layer still gets a physics world (its chunks are colliders).
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const LAYER = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [8, 4, 8] } };
const TYPES = [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' }];

const PROBE = `
export default {
  instantiate() { return { done: false }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent' || state.done || ctx.stepIndex < 5) return;
    state.done = true;
    const hit = ctx.physics.raycast3d([2.5, 5, 6.5], [0, -1, 0], 20);
    const pick = ctx.grid.pick([2.5, 5, 6.5], [0, -1, 0], 20);
    const side = ctx.physics.raycast3d([-3, 0.3, 3.5], [1, 0, 0], 20);
    const all = ctx.physics.overlapBox3d([4, 1, 4], [3, 0.2, 3]);
    const none = ctx.physics.raycast3d([2.5, 5, 6.5], [0, -1, 0], 20, { exclude: ['ground-0001'] });
    const short = (x) => x === null ? null : { e: x.entityId, c: x.cell, y: Math.round(x.point[1] * 1000) / 1000 };
    ctx.log('info', 'R1 ' + JSON.stringify(short(hit)));
    ctx.log('info', 'R2 ' + JSON.stringify(pick === null ? null : [pick.layer, pick.x, pick.y, pick.z]));
    ctx.log('info', 'R3 ' + JSON.stringify(short(side)));
    ctx.log('info', 'R4 ' + JSON.stringify([all, none]));
  },
};
`;

describe('phase 23.3: a 3D hit on a block layer maps to its cell', () => {
  it('raycast3d reports the layer and the cell (as ctx.grid.pick does); overlaps (through its surface) report the layer once', async () => {
    const g = new BlockGrid(LAYER as Any);
    applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 8, 2, 8], cell: { block: 'stone' } }], { types: new Map(TYPES.map((t) => [t.blockId, t as Any])), stamps: new Map() });
    const data = g.toData('ground-0001', null, g.takeDirty().chunks)!;
    const entities: Any[] = [
      { id: 'cam-main', components: { transform: T([4, 6, 16]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
      { id: 'ground-0001', components: { transform: T([0, 0, 0]), blockLayer: LAYER } },
      { id: 'probe-0001', components: { transform: T([0, -9, 0]), behavior: { behaviorId: 'probe', values: {} } } },
    ];
    const physics = physics3DConfigOf(entities, SETTINGS);
    expect(physics?.noCharacter).toBe(true);
    const snapshot = { snapshotId: 'bp@r1', projectId: 'bp', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [data] }, game: null, blockTypes: TYPES };
    const h = await startHarness('single', { snapshot, settings: SETTINGS, physics, behaviors: [behaviorModule('probe', PROBE)], host: { buildId: 'b' } });
    try {
      let now = 10;
      const got = (tag: string): Any => {
        const d = h.rt.getDiagnostics();
        const m = d.ok ? d.diagnostics.errors.map((e: Any) => String(e.message)).find((x: string) => x.includes(`${tag} `)) : undefined;
        return m === undefined ? undefined : JSON.parse(m.slice(m.indexOf(`${tag} `) + tag.length + 1));
      };
      for (let i = 0; i < 200 && got('R4') === undefined; i += 1) {
        now += DT;
        await h.tick(now);
      }
      const r = { hit: got('R1'), pick: got('R2'), side: got('R3'), all: got('R4')[0], none: got('R4')[1] };
      // The floor's top is at y = 1 (two 0.5 m cells); the ray from above hits cell [2, 1, 6].
      expect(r.hit).toEqual({ e: 'ground-0001', c: [2, 1, 6], y: 1 });
      expect(r.pick).toEqual(['ground-0001', 2, 1, 6]);
      // From the side at y 0.3: the lower cell of column x 0.
      expect(r.side.e).toBe('ground-0001');
      expect(r.side.c).toEqual([0, 0, 3]);
      expect(r.all).toEqual(['ground-0001']);
      expect(r.none).toBeNull();
    } finally {
      await h.dispose();
    }
  }, 120_000);
});
