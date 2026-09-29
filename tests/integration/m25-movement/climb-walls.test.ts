/**
 * Phase 25.13: climbing, wall slide and wall jump, gravity bodies and the 2D
 * patrol's any-axis walk, through the production composition (the real game
 * host, the character controllers and Rapier), on the 2D plane and in 3D,
 * on the main thread and in the simulation worker, driven by recorded input.
 *
 * - Climb: the character walks into a climb volume (a 1 m × 6 m box), pushes
 *   up: it rises at its climb speed (2 m/s, no gravity), then jump leaves (it
 *   rises past where it let go, then falls back to the floor), and pushing up
 *   again at the top of the fall takes hold again.
 * - Walls: with wall slide and wall jump on, the character jumps against a
 *   tall wall and keeps pushing into it: its fall is held at the slide speed;
 *   a jump press there pushes it off (away from the wall, up). With both off
 *   (the default) the same input falls at full speed and the press does
 *   nothing: the defaults keep the old behaviour.
 * - Gravity bodies: an edge-walking patroller placed in the air falls onto the
 *   floor and walks on it; a plain body with gravity lands and rests.
 * - 2D only: a patroller walking along +y turns at the ceiling.
 * Logs and every step's digest agree in page and worker and in a second run.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Dim = 2 | 3;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** Logs [step, x, y] of the character and the bodies every 5 steps. */
const LOGGER = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent' || ctx.stepIndex % 5 !== 0) return;
    // One save key per 100 steps (a save value has a size limit).
    const key = 'log' + Math.floor(ctx.stepIndex / 100);
    const log = ctx.save.get(key) ?? [];
    const at = (id) => { const t = ctx.world.transform(id); return t === undefined ? null : [Math.round(t.position[0] * 1e4) / 1e4, Math.round(t.position[1] * 1e4) / 1e4]; };
    log.push([ctx.stepIndex, at('player-0001'), at('walker-0001'), at('rock-0001'), at('riser-0001')]);
    ctx.save.set(key, log);
  },
};
`;

const SETTINGS_2D = { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { gravity_y: -20, run_speed: 4, jump_velocity: 8, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };

function box(dim: Dim, id: string, c: number[], h: number[]): Any {
  return { id, components: { transform: T(c), collider: { shape: dim === 3 ? { type: 'box', hx: h[0], hy: h[1], hz: h[2] } : { type: 'box', hx: h[0], hy: h[1] } } } };
}

/** The climb level: a floor, a climb volume at x 2 (y 0–6), a floor-level start at x 0. Gravity bodies and patrols to the left. */
function climbLevel(dim: Dim, controller: Any): Any[] {
  const z = dim === 3;
  const out: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 3, 16]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller, behavior: { behaviorId: 'logger', values: {} } } },
    box(dim, 'floor-0001', [0, -0.5, 0], [30, 0.5, 4]),
    { id: 'ladder-0001', components: { transform: T([2, 3, 0]), climbVolume: { size: z ? [1, 6, 1] : [1, 6] } } },
    // A patroller placed 3 m up falls onto the floor and walks; a plain body lands and rests.
    { id: 'walker-0001', components: { transform: T([-8, 3.5, 0]), patrol: { mode: 'edges', speed: 1, size: z ? [1, 1, 1] : [1, 1] }, gravity: { size: z ? [1, 1, 1] : [1, 1] } } },
    { id: 'rock-0001', components: { transform: T([-12, 5, 0]), gravity: { scale: 2, size: z ? [0.5, 0.5, 0.5] : [0.5, 0.5] } } },
  ];
  if (!z) {
    // 2D: a patroller walking up (along +y) turns at a ceiling (bottom at y 4).
    out.push(box(dim, 'ceiling-0001', [-16, 4.5, 0], [1, 0.5, 1]));
    out.push({ id: 'riser-0001', components: { transform: T([-16, 1, 0]), patrol: { mode: 'edges', speed: 1, direction: [0, 1, 0], size: [0.5, 0.5] } } });
  }
  return out;
}

/** The wall level: a floor, a tall wall whose left face is at x 3, the character 1.5 m from it. */
function wallLevel(dim: Dim, controller: Any): Any[] {
  return [
    { id: 'cam-main', components: { transform: T([0, 3, 16]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([1.5, 0.91, 0]), controller, behavior: { behaviorId: 'logger', values: {} } } },
    box(dim, 'floor-0001', [0, -0.5, 0], [30, 0.5, 4]),
    box(dim, 'wall-0001', [4, 6, 0], [1, 6, 4]),
  ];
}

type Frame = { moveX?: number; moveY?: number; jump?: 'pressed' | 'held' | 'released' };
function recording(dim: Dim, script: (s: number) => Frame, n: number): Any[] {
  return Array.from({ length: n + 100 }, (_, s) => {
    const f = script(s);
    return { stepIndex: s, moveX: f.moveX ?? 0, moveY: f.moveY ?? 0, jump: f.jump ?? 'none' };
  });
}

async function run(mode: Mode, dim: Dim, entities: Any[], script: (s: number) => Frame, steps: number): Promise<{ log: Any[]; digests: string[]; errors: Any[] }> {
  const settings = dim === 3 ? SETTINGS_3D : SETTINGS_2D;
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics = dim === 3 ? physics3DConfigOf(entities, SETTINGS_3D) : { character: { x: entities[1].components.transform.position[0], y: 0.91 }, statics, solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } };
  const h = await startHarness(mode, {
    snapshot: { snapshotId: `climb${dim}@r1`, projectId: `climb${dim}`, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }] },
    storage: true,
    settings,
    physics,
    replay: recording(dim, script, steps),
    digestSteps: true,
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [behaviorModule('logger', LOGGER)],
  });
  try {
    let now = 10;
    while (h.digests.length < steps) {
      now += DT;
      try {
        await h.tick(now);
      } catch (e) {
        const d = (h.rt as Any).getDiagnostics();
        throw new Error(`${String(e)} at step ${h.digests.length}: ${JSON.stringify(d.ok ? d.diagnostics.errors.slice(-3) : d).slice(0, 2500)}`);
      }
    }
    const d = (h.rt as Any).getDiagnostics();
    const values = await h.storage();
    const log = Array.from({ length: Math.ceil(steps / 100) + 1 }, (_, i) => (values[`log${i}`] ?? []) as Any[]).flat();
    return { log, digests: h.digests.slice(0, steps), errors: d.ok ? d.diagnostics.errors : [d] };
  } finally {
    await h.dispose();
  }
}

/** The logged row of step `s` (a multiple of 5). */
const row = (log: Any[], s: number): Any[] => {
  const r = log.find((x: Any[]) => x[0] === s);
  expect(r, `step ${s}`).toBeDefined();
  return r;
};

async function allModes(dim: Dim, entities: Any[], script: (s: number) => Frame, steps: number): Promise<Any[]> {
  const single = await run('single', dim, entities, script, steps);
  expect(single.errors).toEqual([]);
  const worker = await run('worker', dim, entities, script, steps);
  expect(worker.log).toEqual(single.log);
  expect(worker.digests).toEqual(single.digests);
  const again = await run('single', dim, entities, script, steps);
  expect(again.digests).toEqual(single.digests);
  return single.log;
}

// The 3D character's move input: y pushes along −Z (forward), x along +X.
const CLIMB = (dim: Dim) => (s: number): Frame => {
  if (s < 60) return {};
  // Walk right to the volume (x 2): the 2D run is 4 m/s, the 3D walk 2 m/s.
  if (s < (dim === 3 ? 180 : 116)) return { moveX: 1 };
  if (s < 200) return {};
  // Up for 1 s (2 m at the climb speed), then jump off.
  if (s < 320) return { moveY: 1 };
  if (s === 320) return { jump: 'pressed' };
  if (s < 330) return { jump: 'held' };
  if (s === 330) return { jump: 'released' };
  if (s < 470) return {};
  // Up again: takes hold at the floor and climbs.
  if (s < 530) return { moveY: 1 };
  return {};
};

const WALL = (s: number): Frame => {
  if (s < 30) return {};
  // Run right into the wall's left face (x 3) and jump; keep pushing into it.
  if (s === 60) return { moveX: 1, jump: 'pressed' };
  if (s > 60 && s < 70) return { moveX: 1, jump: 'held' };
  if (s === 70) return { moveX: 1, jump: 'released' };
  if (s < 150) return { moveX: 1 };
  // Jump off the wall (still sliding down it).
  if (s === 150) return { moveX: 1, jump: 'pressed' };
  return {};
};

describe('phase 25.13: climbing, walls, gravity bodies, 2D patrol axes', () => {
  for (const dim of [2, 3] as const) {
    it(`climbs a climb volume, jump leaves, takes hold again; gravity bodies land; page, worker, replay alike (${dim}D)`, async () => {
      const log = await allModes(dim, climbLevel(dim, {}), CLIMB(dim), 560);
      if (process.env['TL_DEBUG']) console.log(JSON.stringify(log.map((r: Any[]) => [r[0], r[1]])));
      const y = (s: number): number => row(log, s)[1][1];
      const x = (s: number): number => row(log, s)[1][0];
      const ground = y(55);
      expect(x(200)).toBeGreaterThan(1.55);
      expect(x(200)).toBeLessThan(2.45);
      expect(y(200)).toBeCloseTo(ground, 2);
      // Climbing: 2 m/s straight up (no gravity): 1 m in 0.5 s, x unchanged.
      expect(y(260) - y(200)).toBeGreaterThan(0.95);
      expect(y(260) - y(200)).toBeLessThan(1.05);
      expect(y(320) - y(260)).toBeCloseTo(y(260) - y(200), 1);
      expect(x(320)).toBeCloseTo(x(200), 3);
      // Jump off: higher first, then down on the floor again.
      expect(Math.max(...[325, 330, 335, 340, 345].map(y))).toBeGreaterThan(y(320) + 0.3);
      expect(y(465)).toBeCloseTo(ground, 1);
      // Up again from the floor: it takes hold again.
      expect(y(525) - y(470)).toBeGreaterThan(0.8);
      // Gravity bodies: the patroller fell onto the floor (its 1 m body on the floor top at 0) and walks on it; the rock rests.
      expect(row(log, 5)[2][1]).toBeGreaterThan(3);
      expect(row(log, 300)[2][1]).toBeCloseTo(0.5, 2);
      expect(row(log, 300)[2][0]).not.toBeCloseTo(-8, 1);
      expect(row(log, 300)[3][1]).toBeCloseTo(0.25, 2);
      expect(row(log, 540)[3][1]).toBeCloseTo(0.25, 2);
      if (dim === 2) {
        // The riser walks up (x unchanged), turns at the ceiling (its top reaches y 4 at its centre 3.75) and goes back down.
        const ys = log.map((r: Any[]) => r[4][1]);
        expect(Math.max(...ys)).toBeGreaterThan(3.6);
        expect(Math.max(...ys)).toBeLessThan(3.8);
        expect(ys[ys.length - 1]).toBeLessThan(Math.max(...ys) - 0.5);
        for (const r of log) expect(r[4][0]).toBe(-16);
      }
    }, 240_000);

    it(`wall slide holds the fall at its speed and wall jump pushes off; off by default (${dim}D)`, async () => {
      const on = await allModes(dim, wallLevel(dim, { wallSlide: true, wallSlideSpeed: 1, wallJump: true, wallJumpAway: 5, wallJumpUp: 6 }), WALL, 300);
      const off = await allModes(dim, wallLevel(dim, {}), WALL, 300);
      if (process.env['TL_DEBUG']) console.log(JSON.stringify(on.map((r: Any[]) => [r[0], r[1]])), JSON.stringify(off.map((r: Any[]) => [r[0], r[1]])));
      const y = (log: Any[], s: number): number => row(log, s)[1][1];
      const x = (log: Any[], s: number): number => row(log, s)[1][0];
      // Against the wall, falling (in the air: above the floor): sliding at 1 m/s (5 steps: 1/24 m) — without wall slide much faster.
      const ground = y(on, 25);
      let sliding = 0;
      for (let s = 80; s < 145; s += 5) {
        const d = y(on, s) - y(on, s + 5);
        if (d > 0.001 && y(on, s + 5) > ground + 0.05 && x(on, s) > 2.68) {
          expect(d, `step ${s}`).toBeLessThan(1 / 24 + 0.002);
          sliding += 1;
        }
      }
      expect(sliding).toBeGreaterThan(4);
      expect(y(on, 145)).toBeGreaterThan(ground + 0.2);
      let fastest = 0;
      for (let s = 80; s < 145; s += 5) fastest = Math.max(fastest, y(off, s) - y(off, s + 5));
      expect(fastest).toBeGreaterThan(0.15);
      // The wall jump: away from the wall (−x) and up, only with it on.
      expect(x(on, 145)).toBeGreaterThan(2.5);
      expect(x(on, 180)).toBeLessThan(x(on, 145) - 0.8);
      expect(y(on, 180)).toBeGreaterThan(y(on, 145) + 0.3);
      expect(x(off, 180)).toBeGreaterThan(2.5);
    }, 240_000);
  }
});
