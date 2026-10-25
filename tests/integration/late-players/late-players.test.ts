/**
 * A game that starts without a player, through the production composition
 * (the real game host, the character controllers and Rapier), on the 2D
 * plane and in 3D, on the main thread and in the simulation worker. The
 * start scene holds a camera and a script only; the script loads a level
 * whose player stands above its floor. The player arrives with the level:
 * it falls onto the floor, walks right on the recorded input, and when the
 * level is unloaded and loaded again it comes back where the level puts it.
 * Every step's digest agrees in page and worker.
 */
import { describe, expect, it } from 'vitest';

import { physics2DConfigOf, physics3DConfigOf } from '@thirdlight/runtime';

import { modulesOf } from '../../game-modules';
import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
type Dim = 2 | 3;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SETTINGS_2D = { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { ...SETTINGS_2D };

/** Loads the level at step 10, unloads it at step 300 and loads it again at step 320; logs the player every 10 steps. */
const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.stepIndex === 10 || ctx.stepIndex === 320) ctx.scenes.load('scene-level');
    if (ctx.stepIndex === 300) ctx.scenes.unload('scene-level');
    if (ctx.stepIndex % 10 !== 0) return;
    const t = ctx.world.transform('player-0001');
    const log = ctx.save.get('log') ?? [];
    log.push([ctx.stepIndex, t === undefined ? null : [Math.round(t.position[0] * 1e4) / 1e4, Math.round(t.position[1] * 1e4) / 1e4]]);
    ctx.save.set('log', log);
  },
};
`;

function start(): Any[] {
  return [
    { id: 'cam-main', components: { transform: T([0, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'director', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
}

/** The level: a floor whose top is at y 0, and the player 2 m above it at x −2. */
function level(dim: Dim): Any[] {
  return [
    { id: 'player-0001', components: { transform: T([-2, 2.9, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), collider: { shape: dim === 3 ? { type: 'box', hx: 15, hy: 0.5, hz: 4 } : { type: 'box', hx: 15, hy: 0.5 } } } },
  ];
}

/** The recorded input: `move` pushes right for steps 150–269 (3D reads x as across). */
function recording(n: number): Any[] {
  return Array.from({ length: n + 100 }, (_, s) => ({ stepIndex: s, actions: s >= 150 && s < 270 ? { move: { v: 1, x: 1, y: 0, p: 'none' } } : {} }));
}

async function run(mode: Mode, dim: Dim, steps: number): Promise<{ log: [number, number[] | null][]; digests: string[]; errors: Any[]; observed: Any }> {
  const main = start();
  const later = level(dim);
  const settings = dim === 3 ? SETTINGS_3D : SETTINGS_2D;
  // The required modules come from every scene (the build's rule), so the level's player and floor name them.
  const physics = dim === 3 ? physics3DConfigOf(main, SETTINGS_3D, { required: true }) : physics2DConfigOf(main as Any, SETTINGS_2D, { required: true });
  const modules = modulesOf({ scene: { entities: [...main, ...later] } } as Any, settings, physics);
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: `late${dim}@r1`,
      projectId: `late${dim}`,
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
        { sceneId: 'scene-level', start: false },
      ],
    },
    storage: true,
    settings,
    physics,
    modules,
    replay: recording(steps),
    digestSteps: true,
    loadScene: async () => level(dim),
    behaviors: [behaviorModule('director', DIRECTOR)],
  });
  try {
    let now = 10;
    while (h.digests.length < steps) {
      now += DT;
      await h.tick(now);
      if (h.digests.length % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const diag = h.rt.getDiagnostics();
    const errors = diag.ok ? diag.diagnostics.errors : [];
    // The host's observation names the player that arrived (as tl_game_observe reports it).
    const observed = (h.host as Any).observe().observation.player;
    return { log: ((await h.storage()) as Any).log ?? [], digests: [...h.digests], errors, observed };
  } finally {
    await h.dispose();
  }
}

for (const dim of [2, 3] as const) {
  describe(`a player that arrives with a later scene (${dim}D)`, () => {
    it('falls onto the level floor, walks on its input, comes back where the level puts it — identical in page and worker', async () => {
      const STEPS = 420;
      const a = await run('single', dim, STEPS);
      const w = await run('worker', dim, STEPS);
      expect(a.errors).toEqual([]);
      const at = (step: number): number[] | null => a.log.find(([s]) => s === step)?.[1] ?? null;
      // Not there before the level loads.
      expect(at(0)).toBeNull();
      // Landed on the floor (top 0, half its 1.8 m height and the skin above it), still where it was authored.
      const landed = at(140)!;
      expect(landed[0]).toBeCloseTo(-2, 3);
      expect(landed[1]).toBeGreaterThan(0.9 - 1e-3);
      expect(landed[1]).toBeLessThan(0.9 + 0.03);
      // Walked right on its input for a second (3D walks unless run is held), standing on the floor.
      const walked = at(290)!;
      expect(walked[0]).toBeGreaterThan(landed[0] + 1);
      expect(walked[1]).toBeLessThan(0.9 + 0.03);
      // Gone with its level, then back where the level puts it (falling from there again).
      expect(at(310)).toBeNull();
      const back = at(330)!;
      expect(back[0]).toBeCloseTo(-2, 3);
      expect(back[1]).toBeGreaterThan(landed[1]);
      expect(at(410)![1]).toBeLessThan(0.9 + 0.03);
      expect(a.observed?.y).toBeCloseTo(at(410)![1], 1);
      expect(w.observed?.y).toBeCloseTo(at(410)![1], 1);
      const n = Math.min(a.digests.length, w.digests.length);
      expect(n).toBeGreaterThanOrEqual(STEPS);
      expect(w.digests.slice(0, n)).toEqual(a.digests.slice(0, n));
      expect(w.log).toEqual(a.log);
    }, 180_000);
  });
}
