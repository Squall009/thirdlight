/**
 * Plane locks switched mid-run by a script, through the production game
 * host on the Rapier 3D backend, in the page and in the simulation worker.
 *
 * The player walks diagonally on the recorded input. At step 60 a script
 * locks it (`ctx.character.setPlane`) and a crate standing off to the side
 * (`ctx.physics.setPlane`) to the plane z = 0.5: both snap onto it, and the
 * player walks and jumps on it with z held exactly. At step 200 the script
 * frees the player (`ctx.physics.setPlane(id, null)`): it moves along z
 * again. At step 260 it locks it to the plane x = 2: x is held, z moves.
 * Every step's digest agrees in page and worker, and two page runs agree.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
const STEPS = 360;

/**
 * Switches the planes, and checks every step (the step-start transforms, in
 * the intent phase) that a locked player and crate are on their planes —
 * the counts of steps off the plane and the highest point go into a small
 * summary (a save value is bounded) with samples at the switches.
 */
const DIRECTOR = `
const KEY = [59, 60, 61, 199, 200, 259, 260, 261, 359];
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    const ok = [];
    if (s === 60) ok.push(ctx.character.setPlane(undefined, { axis: 'z', origin: 0.5 }), ctx.physics.setPlane('crate-0001', { axis: 'z', origin: 0.5 }));
    if (s === 200) ok.push(ctx.physics.setPlane('player-0001', null));
    if (s === 260) ok.push(ctx.character.setPlane('player-0001', { axis: 'x', origin: 2 }));
    // Refused: a bad plane, an object with no body.
    if (s === 61) ok.push(ctx.physics.setPlane('player-0001', { axis: 'y', origin: 0 }), ctx.physics.setPlane('cam-main', { axis: 'z', origin: 0 }));
    const p = ctx.world.transform('player-0001').position;
    const c = ctx.world.transform('crate-0001');
    const plane = ctx.physics.planeOf('player-0001');
    const sum = ctx.save.get('sum') ?? { offZ: 0, crateOff: 0, offX: 0, apex: -1, planes: 0, samples: [] };
    if (s > 60 && s < 200) {
      if (p[2] !== 0.5) sum.offZ += 1;
      if (c.position[2] !== 0.5 || c.rotation[0] !== 0 || c.rotation[1] !== 0) sum.crateOff += 1;
      if (plane !== null && plane.axis === 'z' && plane.origin === 0.5) sum.planes += 1;
      sum.apex = Math.max(sum.apex, p[1]);
    }
    if (s > 260 && p[0] !== 2) sum.offX += 1;
    if (KEY.includes(s)) sum.samples.push([s, [p[0], p[1], p[2]], plane === null ? null : plane.axis + plane.origin, ok]);
    ctx.save.set('sum', sum);
  },
};
`;

function entities(): Any[] {
  return [
    { id: 'cam-main', components: { transform: T([0, 6, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'director', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'director', values: {} } } },
    { id: 'player-0001', components: { transform: T([0, 1, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), collider: { shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 } } } },
    // Off to the side and turned a little about X and Z: locked, it stands on z = 0.5 turned about Z only.
    { id: 'crate-0001', components: { transform: T([8, 0.5, 3], [0.1, 0, 0.1, Math.sqrt(0.98)]), collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } } } },
  ];
}

/** Diagonal on `move` throughout; jump pressed at step 100 (while on the plane z = 0.5). */
function recording(): Any[] {
  return Array.from({ length: STEPS + 100 }, (_, s) => ({ stepIndex: s, actions: { move: { v: 1, x: 0.6, y: 0.8, p: 'none' }, ...(s === 100 ? { jump: { v: 1, p: 'pressed' } } : {}) } }));
}

async function run(mode: Mode): Promise<{ log: Any; digests: string[]; errors: Any[] }> {
  const main = entities();
  const h = await startHarness(mode, {
    snapshot: { snapshotId: 'plane@r1', projectId: 'plane', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main } },
    storage: true,
    settings: SETTINGS,
    physics: physics3DConfigOf(main, SETTINGS),
    replay: recording(),
    digestSteps: true,
    behaviors: [behaviorModule('director', DIRECTOR)],
  });
  try {
    let now = 10;
    while (h.digests.length < STEPS) {
      now += DT;
      await h.tick(now);
      if (h.digests.length % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const diag = h.rt.getDiagnostics();
    return { log: ((await h.storage()) as Any).sum ?? null, digests: [...h.digests], errors: diag.ok ? diag.diagnostics.errors : [] };
  } finally {
    await h.dispose();
  }
}

describe('plane locks switched by a script mid-run (3D, page and worker)', () => {
  it('lock, free and lock again: snapped, held while walking and jumping, free in between; digests equal', async () => {
    const a = await run('single');
    const b = await run('single');
    const w = await run('worker');
    expect(a.errors).toEqual([]);
    const sum = a.log as Any;
    const at = (step: number): Any => sum.samples.find((r: Any) => r[0] === step);
    // Free: walking diagonally moved it along x and z.
    const p59 = at(59)[1];
    expect(p59[0]).toBeGreaterThan(0.3);
    expect(Math.abs(p59[2])).toBeGreaterThan(0.4);
    expect(at(59)[2]).toBeNull();
    // The requests were taken; the bad ones refused.
    expect(at(60)[3]).toEqual([true, true]);
    expect(at(61)[3]).toEqual([false, false]);
    // From the boundary after the request on: the player and the crate on the plane z = 0.5 (the
    // crate turned about Z only) every step, walking and jumping.
    expect(at(61)[1][2]).toBe(0.5);
    expect(sum.offZ).toBe(0);
    expect(sum.crateOff).toBe(0);
    expect(sum.planes).toBe(139);
    // It still walked along x on the plane, and the jump lifted it.
    expect(at(199)[1][0]).toBeGreaterThan(p59[0] + 1);
    expect(sum.apex).toBeGreaterThan(1.9);
    // Freed: z moves again from 0.5.
    expect(at(200)[3]).toEqual([true]);
    expect(at(259)[2]).toBeNull();
    expect(Math.abs(at(259)[1][2] - 0.5)).toBeGreaterThan(0.3);
    // Locked about X: x held at 2, z keeps moving.
    expect(at(260)[3]).toEqual([true]);
    expect(at(261)[1][0]).toBe(2);
    expect(sum.offX).toBe(0);
    expect(Math.abs(at(STEPS - 1)[1][2] - at(261)[1][2])).toBeGreaterThan(0.5);
    expect(at(STEPS - 1)[2]).toBe('x2');
    // Deterministic: two page runs and the worker, every step.
    const n = Math.min(a.digests.length, b.digests.length, w.digests.length);
    expect(n).toBeGreaterThanOrEqual(STEPS);
    expect(b.digests.slice(0, n)).toEqual(a.digests.slice(0, n));
    expect(w.digests.slice(0, n)).toEqual(a.digests.slice(0, n));
    expect(w.log).toEqual(a.log);
  }, 180_000);
});
