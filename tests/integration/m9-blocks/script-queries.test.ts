/**
 * Phase 9.9 (wrap-up): a script's overlap queries and show/hide, through the
 * real game host and Rapier — `ctx.physics.overlapBox/overlapCircle` find the
 * level's colliders (never the player), share the 32-per-step budget with
 * rays, and `ctx.game.setVisible` hides an entity until the next run.
 *
 * Phase 22.0/22.3: in both threading modes — in the simulation worker the
 * queries and their budget are unchanged. The script keeps what it saw in
 * `ctx.save` (the test reads the run's save state; a worker's script cannot
 * write into the test's variables).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { behaviorModule, MODES, startHarness, type Harness } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

const PROBE = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.stepIndex === 30) {
      ctx.save.set('box', ctx.physics.overlapBox({ x: 3.2, y: 0.5 }, { x: 1, y: 0.3 }));
      ctx.save.set('wide', ctx.physics.overlapBox({ x: 4.5, y: 0.5 }, { x: 2, y: 0.3 }));
      ctx.save.set('circle', ctx.physics.overlapCircle({ x: 6.8, y: 0.7 }, 0.45));
      ctx.save.set('player', ctx.physics.overlapCircle({ x: 0, y: 0.91 }, 0.3));
      ctx.game.setVisible('crate-0002', false);
    }
    if (ctx.stepIndex === 31) {
      const out = [];
      for (let i = 0; i < 34; i++) out.push(ctx.physics.overlapBox({ x: 3, y: 0.5 }, { x: 0.2, y: 0.2 }).length);
      ctx.save.set('budget', out);
    }
  },
};
`;

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.dispose();
});

describe.each(MODES)('script queries (real host, Rapier; threading: %s)', (mode) => {
  it('overlapBox/overlapCircle find colliders, share the per-step budget; setVisible hides until a new run', async () => {
    const crate = (id: string, x: number) => ({ id, components: { transform: at(x, 0.5), box: { size: [1, 1, 1], material: { color: '#aa7733' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } });
    const entities: Any[] = [
      { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
      { id: 'player-0001', components: { transform: at(0, 0.91), controller: {}, behavior: { behaviorId: 'probe', values: { speed: 1 } } } },
      { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
      { id: 'floor-0001', components: { transform: at(10, -0.5), box: { size: [40, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 20, hy: 0.5 } } } },
      { id: 'goal-0001', components: { transform: at(28, 1), gameZone: { role: 'goal', size: [1, 2] } } },
      crate('crate-0001', 3),
      crate('crate-0002', 6),
    ];
    const statics = entities.filter((e) => e.components.collider).map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
    const h = await startHarness(mode, {
      snapshot: {
        snapshotId: 'q@r1',
        projectId: 'q',
        revision: 1,
        scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
        game: { configVersion: 2, title: 'Queries', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
      },
      settings: SETTINGS,
      physics: {
        character: { x: 0, y: 0.91 },
        statics,
        solver: { hz: 120, gravityY: SETTINGS.gravity_y },
        controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
      },
      behaviors: [behaviorModule('probe', PROBE, { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] })],
    });
    live.push(h);
    const rt: Any = h.rt;
    let now = 0;
    const tick = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        now += DT;
        await h.tick(now);
      }
    };
    await tick(40);
    const seen = rt.runState().values;
    expect(seen['box']).toEqual(['crate-0001']);
    expect(seen['wide']).toEqual(['crate-0001', 'crate-0002']);
    expect(seen['circle']).toEqual(['crate-0002']);
    expect(seen['player']).toEqual([]); // the player's capsule is not a level collider
    // 32 queries per step (rays and overlaps together), then empty.
    expect(seen['budget']).toEqual([...Array(32).fill(1), 0, 0]);
    expect(rt.hiddenEntities().has('crate-0002')).toBe(true);
    // A new run shows it again.
    expect(rt.gameCommand('start').ok).toBe(true);
    await tick(5);
    expect(rt.hiddenEntities().has('crate-0002')).toBe(false);
  });
});
