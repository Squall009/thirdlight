/**
 * Mover signals and the gravity easing through the production
 * composition (the real game host, the character controller and Rapier), on
 * the 2D plane and in 3D, on the main thread and in the simulation worker.
 *
 * A held lift (`active: false`, gravity easing, `once`) carries the character:
 * a director script sends `lift` (toggle: it rises), `hold` (stop: it holds
 * mid-way), `lift` again (it rises on to the top), then `back` (reverse: the
 * finished lift goes back down). The lift's heights follow the constant
 * acceleration, the character rides it all the way, the logs and every
 * step's digest agree in page and worker and in a second run.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

type Any = any;
type Dim = 2 | 3;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const DIRECTOR = `
const SEND = { 20: 'lift', 140: 'hold', 200: 'lift', 460: 'back' };
const LOOK = [100, 139, 141, 180, 199, 300, 450, 470, 700];
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    if (SEND[s] !== undefined) ctx.signals.emit(SEND[s]);
    if (LOOK.includes(s)) {
      const log = ctx.save.get('log') ?? [];
      const lift = ctx.world.transform('lift-0001').position[1];
      const who = ctx.world.transform('player-0001').position[1];
      const m = ctx.entity('lift-0001').get('mover');
      log.push([s, Math.round(lift * 1e4) / 1e4, Math.round((who - lift) * 1e3) / 1e3, m.active]);
      ctx.save.set('log', log);
    }
  },
};
`;

function level(dim: Dim): Any[] {
  const z = dim === 3;
  return [
    { id: 'cam-main', components: { transform: T([0, 3, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 1.12, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -3, 0]), collider: { shape: z ? { type: 'box', hx: 8, hy: 0.5, hz: 4 } : { type: 'box', hx: 8, hy: 0.5 } } } },
    {
      id: 'lift-0001',
      components: {
        transform: T([0, 0, 0]),
        collider: { shape: z ? { type: 'box', hx: 1.5, hy: 0.2, hz: 1.5 } : { type: 'box', hx: 1.5, hy: 0.2 } },
        mover: { waypoints: [[0, 2, 0]], speed: 1, mode: 'once', easing: 'gravity', active: false, toggleOn: 'lift', stopOn: 'hold', reverseOn: 'back' },
      },
    },
    { id: 'director-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
}

const SETTINGS_2D = { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const SETTINGS_3D = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const STEPS = 720;

async function run(mode: Mode, dim: Dim): Promise<{ log: Any[]; digests: string[]; errors: Any[] }> {
  const entities = level(dim);
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0, ...(e.components.mover ? { kinematic: true } : {}) }));
  const settings = dim === 3 ? SETTINGS_3D : SETTINGS_2D;
  const physics =
    dim === 3
      ? physics3DConfigOf(entities, SETTINGS_3D)
      : { character: { x: 0, y: 1.12 }, statics, solver: { hz: 120, gravityY: SETTINGS_2D.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } };
  const h = await startHarness(mode, {
    snapshot: { snapshotId: `movers${dim}@r1`, projectId: `movers${dim}`, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, scenes: [{ sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) }] },
    storage: true,
    settings,
    physics,
    replay: Array.from({ length: STEPS + 100 }, (_, i) => ({ stepIndex: i, moveX: 0, ...(dim === 3 ? { moveY: 0 } : {}), jump: 'none' as const })),
    digestSteps: true,
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    behaviors: [behaviorModule('director', DIRECTOR)],
  });
  try {
    let now = 10;
    while (h.digests.length < STEPS) {
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
    return { log: values['log'] ?? [], digests: h.digests.slice(0, STEPS), errors: d.ok ? d.diagnostics.errors : [d] };
  } finally {
    await h.dispose();
  }
}

/** The lift's height `k` steps after it left its start with the gravity easing (2 m in 2 s: 2 (t / 2)^2). */
const rise = (k: number): number => 2 * (k / 240) ** 2;

describe('mover signals and the gravity easing', () => {
  for (const dim of [2, 3] as const) {
    it(`toggle, stop, toggle, reverse a lift that carries the character; page, worker and a second run identical (${dim}D)`, async () => {
      const single = await run('single', dim);
      expect(single.errors).toEqual([]);
      const at = (s: number): Any[] => single.log.find((r: Any[]) => r[0] === s)!;
      // Held until the toggle (sent at 20, read at 21: moving from step 21).
      expect(at(100)[1]).toBeCloseTo(rise(80), 3);
      expect(at(139)[1]).toBeCloseTo(rise(119), 3);
      // Stopped from step 141 (sent at 140) where it was, `active` false as a script reads it.
      expect(at(141)[1]).toBeCloseTo(rise(120), 3);
      expect(at(180)[1]).toBe(at(141)[1]);
      expect(at(199)[1]).toBe(at(141)[1]);
      expect(at(180)[3]).toBe(false);
      // Toggled on again (read at 201): it carries on along its curve and reaches the top.
      expect(at(300)[1]).toBeCloseTo(rise(120 + 100), 3);
      expect(at(300)[3]).toBe(true);
      expect(at(450)[1]).toBeCloseTo(2, 6);
      // Reversed (sent at 460): back down from rest, at the start again well before step 700.
      expect(at(470)[1]).toBeCloseTo(2 - rise(10), 3);
      expect(at(700)[1]).toBeCloseTo(0, 6);
      // The character rode it the whole way (its origin 0.9 m above the lift's top, at the same height above the lift).
      const gap = at(100)[2];
      expect(gap).toBeGreaterThan(1.05);
      expect(gap).toBeLessThan(1.2);
      for (const r of single.log) expect(Math.abs(r[2] - gap), JSON.stringify(r)).toBeLessThan(0.06);

      const worker = await run('worker', dim);
      expect(worker.log).toEqual(single.log);
      expect(worker.digests).toEqual(single.digests);
      const again = await run('single', dim);
      expect(again.digests).toEqual(single.digests);
    }, 240_000);
  }
});
