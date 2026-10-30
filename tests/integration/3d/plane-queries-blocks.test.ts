/**
 * One query, trigger, switch and door surface on the Rapier 3D backend,
 * through the production game host, in the page and in the simulation
 * worker.
 *
 * Queries: a script's `ctx.physics.raycast` / `overlapBox` / `overlapCircle`
 * take {x, y} on the plane its object is locked to (none: z = 0) and
 * [x, y, z] in the world. The probe object asks on z = 0, locks itself to the
 * plane x = 3 by script, and asks the same 2D questions again: they now run
 * on that plane (its x along −Z) and find the wall standing there.
 *
 * Blocks: the player walks along +X over a stand switch written in its 2D
 * form ([w, h]), which opens a door (a mover that starts on the signal); it
 * passes through a circle trigger and a depthless box trigger. Once free in
 * 3D and once locked to the plane z = 0, each in the page and the worker
 * with every step's digest equal.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
const STEPS = 840;

/** The probe's queries: on z = 0 at step 5, then on the plane x = 3 it locks itself to at step 10. */
const PROBE = `
const ask = (ctx) => ({
  ray2: ctx.physics.raycast({ x: 0, y: 4 }, { x: 1, y: 0 }, 20),
  ray3: ctx.physics.raycast([0, 4, -3], [1, 0, 0], 20),
  box2: ctx.physics.overlapBox({ x: 14, y: 4 }, { x: 0.2, y: 0.2 }),
  box3: ctx.physics.overlapBox([3, 4, -3], [0.2, 0.2, 0.2]),
  circle: ctx.physics.overlapCircle({ x: 3, y: 4 }, 0.6),
  filtered: ctx.physics.overlapBox({ x: 14, y: 4 }, { x: 0.2, y: 0.2 }, { exclude: ['wall-a'] }),
  plane: ctx.physics.planeOf(ctx.entityId),
});
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.stepIndex === 5) ctx.save.set('onZ', JSON.parse(JSON.stringify(ask(ctx))));
    if (ctx.stepIndex === 10) ctx.save.set('locked', ctx.physics.setPlane(ctx.entityId, { axis: 'x', origin: 3 }));
    if (ctx.stepIndex === 15) ctx.save.set('onX', JSON.parse(JSON.stringify(ask(ctx))));
  },
};
`;

/** The first step each signal is seen, the door's height, and the player's path. */
const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    const sum = ctx.save.get('sum') ?? { open: -1, goal: -1, goal2: -1, offZ: 0, end: null, door: 0 };
    for (const k of ['open', 'goal', 'goal2']) if (sum[k] < 0 && ctx.signals.on(k)) sum[k] = ctx.stepIndex;
    const p = ctx.world.transform('player-0001').position;
    if (p[2] !== 0) sum.offZ += 1;
    sum.door = ctx.world.transform('door').position[1];
    sum.end = [p[0], p[1], p[2]];
    ctx.save.set('sum', sum);
  },
};
`;

function entities(onPlane: boolean): Any[] {
  return [
    { id: 'cam-main', components: { transform: T([0, 6, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'director', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'director', values: {} } } },
    { id: 'probe', components: { transform: T([0, 8, 0]), collider: { shape: { type: 'box', hx: 0.2, hy: 0.2, hz: 0.2 } }, behavior: { behaviorId: 'probe', values: {} } } },
    { id: 'player-0001', components: { transform: T([0, 1, 0]), controller: { moveFrame: 'world', ...(onPlane ? { plane: { axis: 'z', origin: 0 } } : {}) } } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), collider: { shape: { type: 'box', hx: 30, hy: 0.5, hz: 5 } } } },
    // Crosses z = 0 (the walk's far end), and the plane x = 3 off the walk.
    { id: 'wall-a', components: { transform: T([14, 1, 0]), collider: { shape: { type: 'box', hx: 0.5, hy: 4, hz: 0.5 } } } },
    { id: 'wall-b', components: { transform: T([3, 1, -3]), collider: { shape: { type: 'box', hx: 0.5, hy: 4, hz: 0.5 } } } },
    // The 2D forms: a switch [w, h], a door with a depthless box, a circle and a [w, h] trigger.
    { id: 'switch', components: { transform: T([2, 0.1, 0]), switch: { mode: 'stand', signal: 'open', size: [1, 0.4] } } },
    { id: 'door', components: { transform: T([6, 1.5, 0]), mover: { waypoints: [[0, 3, 0]], speed: 6, mode: 'once', startOn: 'open' }, collider: { shape: { type: 'box', hx: 0.3, hy: 1.5 } } } },
    { id: 'goal', components: { transform: T([9, 1, 0]), trigger: { shape: 'circle', radius: 0.5, signal: 'goal' } } },
    { id: 'goal2', components: { transform: T([11, 1, 0]), trigger: { size: [1, 2], signal: 'goal2' } } },
  ];
}

function recording(): Any[] {
  return Array.from({ length: STEPS + 100 }, (_, s) => ({ stepIndex: s, actions: { move: { v: 1, x: 1, y: 0, p: 'none' } } }));
}

async function run(mode: Mode, onPlane: boolean): Promise<{ save: Any; digests: string[]; errors: Any[] }> {
  const main = entities(onPlane);
  const h = await startHarness(mode, {
    snapshot: { snapshotId: 'pq@r1', projectId: 'pq', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main } },
    storage: true,
    settings: SETTINGS,
    physics: physics3DConfigOf(main, SETTINGS),
    replay: recording(),
    digestSteps: true,
    behaviors: [behaviorModule('director', DIRECTOR), behaviorModule('probe', PROBE)],
  });
  try {
    let now = 10;
    while (h.digests.length < STEPS) {
      now += DT;
      await h.tick(now);
      if (h.digests.length % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const diag = h.rt.getDiagnostics();
    return { save: await h.storage(), digests: [...h.digests], errors: diag.ok ? diag.diagnostics.errors : [] };
  } finally {
    await h.dispose();
  }
}

const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps;

describe('one query, trigger, switch and door surface (3D, page and worker)', () => {
  it('free and on a plane: 2D queries on the caller\'s plane, 3D in the world; the 2D-form blocks work; digests equal', async () => {
    for (const onPlane of [false, true]) {
      const a = await run('single', onPlane);
      const w = await run('worker', onPlane);
      expect(a.errors).toEqual([]);
      const { onZ, onX, locked, sum } = a.save as Any;
      // On z = 0: the 2D ray finds the wall crossing it (13.5 m along +X), not the one at z = −3;
      // the 3D ray and box find that one.
      expect(onZ.ray2.entityId).toBe('wall-a');
      expect(near(onZ.ray2.distance, 13.5)).toBe(true);
      expect(onZ.ray2.normal).toEqual({ x: -1, y: 0 });
      expect(onZ.ray3.entityId).toBe('wall-b');
      expect(near(onZ.ray3.distance, 2.5)).toBe(true);
      expect(onZ.ray3.point.map((v: number) => Math.round(v * 1000) / 1000)).toEqual([2.5, 4, -3]);
      expect(onZ.box2).toEqual(['wall-a']);
      expect(onZ.box3).toEqual(['wall-b']);
      expect(onZ.circle).toEqual([]);
      expect(onZ.filtered).toEqual([]);
      expect(onZ.plane).toBeNull();
      // Locked to x = 3: the same 2D questions run on that plane (x along −Z) and find wall-b.
      expect(locked).toBe(true);
      expect(onX.plane).toEqual({ axis: 'x', origin: 3 });
      expect(onX.ray2.entityId).toBe('wall-b');
      expect(near(onX.ray2.distance, 2.5)).toBe(true);
      expect(onX.ray2.normal).toEqual({ x: -1, y: 0 });
      expect(onX.circle).toEqual(['wall-b']);
      expect(onX.box2).toEqual([]);
      expect(onX.ray3).toEqual(onZ.ray3);
      // The switch opened the door before the player got there; it walked through both triggers.
      expect(sum.open).toBeGreaterThan(0);
      expect(sum.goal).toBeGreaterThan(sum.open);
      expect(sum.goal2).toBeGreaterThan(sum.goal);
      expect(sum.door).toBeGreaterThan(4.4);
      expect(sum.end[0]).toBeGreaterThan(12);
      if (onPlane) expect(sum.offZ).toBe(0);
      else expect(Math.abs(sum.end[2])).toBeLessThan(0.01);
      // Page and worker alike, every step.
      expect(w.digests.slice(0, STEPS)).toEqual(a.digests.slice(0, STEPS));
      expect(w.save).toEqual(a.save);
    }
  }, 240_000);
});
