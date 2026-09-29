/**
 * Phase 25.14: camera regions and look-ahead on the track camera, through
 * the production composition (the real game host, the character controllers
 * and Rapier), on the 2D plane and in 3D, on the main thread and in the
 * simulation worker, driven by recorded input.
 *
 * The character walks right from x 0 into a camera region centred at x 8
 * (6 m wide: x 5–11) that gives the track camera a 20 m distance and bounds
 * of ±1 m in x around the region (the framed point stays in x 7–9). Before
 * the region the camera sits at its placed offset (12 m back); inside, after
 * the region's blend, at 20 m along the same direction, and its x stops at 9
 * while the character walks on to x 10. The camera also looks ahead
 * vertically: a jump inside the region lifts the view above where the
 * character is framed without it. The camera position is read by a project
 * script from `ctx.camera.screenToRay` (the ray's origin). Logs and every
 * step's digest agree in page and worker and in a second run.
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

/** Logs [step, player x/y, camera x/y/z] every 5 steps. */
const LOGGER = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent' || ctx.stepIndex % 5 !== 0) return;
    const key = 'log' + Math.floor(ctx.stepIndex / 100);
    const log = ctx.save.get(key) ?? [];
    const r = (v) => Math.round(v * 1e4) / 1e4;
    const t = ctx.world.transform('player-0001');
    const o = ctx.camera.screenToRay(0.5, 0.5).origin;
    log.push([ctx.stepIndex, t === undefined ? null : [r(t.position[0]), r(t.position[1])], [r(o[0]), r(o[1]), r(o[2])]]);
    ctx.save.set(key, log);
  },
};
`;

const SETTINGS_2D = { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { gravity_y: -20, run_speed: 4, jump_velocity: 8, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };

function level(dim: Dim, region: boolean): Any[] {
  const z = dim === 3;
  const floor = { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), collider: { shape: z ? { type: 'box', hx: 40, hy: 0.5, hz: 4 } : { type: 'box', hx: 40, hy: 0.5 } } } };
  return [
    { id: 'cam-main', components: { transform: T([0, 3, 16]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {}, behavior: { behaviorId: 'logger', values: {} } } },
    floor,
    // Placed 12 m in front of the character, 2.09 m above it: that offset is its framing.
    { id: 'tracker-0001', components: { transform: T([0, 3, 12]), virtualCamera: { rig: 'track', target: 'player-0001', lookAhead: [0, 0.25, 0], lookAheadMax: [0, 1.5, 0] } } },
    ...(region ? [{ id: 'room-0001', components: { transform: T([8, 2, 0]), cameraRegion: { size: z ? [6, 6, 6] : [6, 6], boundsMin: [-1, -10, -10], boundsMax: [1, 10, 10], distance: 20, blendTime: 0.25 } } }] : []),
  ];
}

type Frame = { moveX?: number; jump?: 'pressed' | 'held' | 'released' };
function recording(script: (s: number) => Frame, n: number): Any[] {
  return Array.from({ length: n + 100 }, (_, s) => {
    const f = script(s);
    return { stepIndex: s, moveX: f.moveX ?? 0, moveY: 0, jump: f.jump ?? 'none' };
  });
}

async function run(mode: Mode, dim: Dim, entities: Any[], script: (s: number) => Frame, steps: number): Promise<{ log: Any[]; digests: string[]; errors: Any[] }> {
  const settings = dim === 3 ? SETTINGS_3D : SETTINGS_2D;
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics = dim === 3 ? physics3DConfigOf(entities, SETTINGS_3D) : { character: { x: 0, y: 0.91 }, statics, solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } };
  const h = await startHarness(mode, {
    snapshot: { snapshotId: `regions${dim}@r1`, projectId: `regions${dim}`, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }] },
    storage: true,
    settings,
    physics,
    replay: recording(script, steps),
    digestSteps: true,
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [behaviorModule('logger', LOGGER)],
  });
  try {
    let now = 10;
    while (h.digests.length < steps) {
      now += DT;
      await h.tick(now);
    }
    const d = (h.rt as Any).getDiagnostics();
    const values = await h.storage();
    const log = Array.from({ length: Math.ceil(steps / 100) + 1 }, (_, i) => (values[`log${i}`] ?? []) as Any[]).flat();
    return { log, digests: h.digests.slice(0, steps), errors: d.ok ? d.diagnostics.errors : [d] };
  } finally {
    await h.dispose();
  }
}

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

describe('phase 25.14: camera regions and look-ahead (track camera)', () => {
  for (const dim of [2, 3] as const) {
    // To x 10 (inside the region, past its framed bound 9), then a jump there. The 2D run is 4 m/s, the 3D walk 2 m/s.
    const until = dim === 3 ? 660 : 360;
    const SCRIPT = (s: number): Frame => {
      if (s < 60) return {};
      if (s < until) return { moveX: 1 };
      if (s === until + 60) return { jump: 'pressed' };
      if (s > until + 60 && s < until + 90) return { jump: 'held' };
      if (s === until + 90) return { jump: 'released' };
      return {};
    };
    const steps = until + 240;

    it(`a region changes the camera's distance and bounds when the character walks in, blended; vertical look-ahead on a jump (${dim}D)`, async () => {
      const on = await allModes(dim, level(dim, true), SCRIPT, steps);
      const off = await allModes(dim, level(dim, false), SCRIPT, steps);
      if (process.env['TL_DEBUG']) console.log(JSON.stringify(on.map((r: Any[]) => [r[0], r[1], r[2]])));
      const len = Math.hypot(2.09, 12);
      const far = (20 * 12) / len;
      const px = (log: Any[], s: number): number => row(log, s)[1][0];
      const cam = (log: Any[], s: number): number[] => row(log, s)[2];
      // At the start: its placed framing, 12 m back.
      expect(cam(on, 30)[2]).toBeCloseTo(12, 2);
      // Find the first logged step inside the region (x ≥ 5): until then both runs frame alike.
      const enter = on.find((r: Any[]) => r[1] !== null && r[1][0] >= 5)[0] as number;
      expect(cam(on, enter - 10)).toEqual(cam(off, enter - 10));
      // Blending in over 0.25 s (30 steps): part-way, then at 20 m along the same direction.
      const mid = cam(on, enter + 15)[2]!;
      expect(mid).toBeGreaterThan(12.5);
      expect(mid).toBeLessThan(far - 0.5);
      expect(cam(on, enter + 40)[2]).toBeCloseTo(far, 2);
      // Without the region the camera stays 12 m back.
      expect(cam(off, enter + 40)[2]).toBeCloseTo(12, 2);
      // The character walks on to x ≥ 9.5; the camera's x stops at the region's bound (9).
      expect(px(on, until)).toBeGreaterThan(9.5);
      expect(px(on, until)).toBeLessThan(11);
      expect(cam(on, until)[0]).toBeCloseTo(9, 2);
      expect(cam(off, until)[0]).toBeCloseTo(px(off, until), 1);
      // Vertical look-ahead: while the jump rises the view is above the character's own framing (its placed 2.09 m + the region's longer offset).
      const riseAt = until + 75;
      const lift = (log: Any[]): number => cam(log, riseAt)[1]! - row(log, riseAt)[1][1];
      const settled = cam(on, until)[1]! - row(on, until)[1][1];
      expect(row(on, riseAt)[1][1]).toBeGreaterThan(row(on, until)[1][1] + 0.3);
      expect(lift(on)).toBeGreaterThan(settled + 0.3);
      expect(lift(on)).toBeLessThan(settled + 1.5 + 1e-3);
    }, 240_000);
  }
});
