/**
 * Phase 23.1: 3D colliders, movers and triggers through the production game
 * host, in the page and in the simulation worker (the same game-host worker
 * core the browser bundles run).
 *
 * A neutral 3D scene: a triangle-mesh floor, a turned convex hull, a scaled
 * box, a sphere and a capsule; a player capsule dropped onto a lift (a mover
 * with a box collider). A box trigger turned about Y around the lift's top
 * fires "landed" when the player lands; the lift waits for that signal, then
 * slides 5 m across the floor carrying the player into a sphere trigger that
 * fires "arrived", which opens a door (a second mover). The step digests are
 * identical over two page runs and in the worker; the player ends on the lift
 * at its destination and the door is open — both only happen when the
 * triggers fire in 3D and the mover carries the player.
 *
 * A second scene lifts the behavior ownership rule: a script owning its own
 * entity ("@self") drives a box collider through transform intents; the
 * runtime poses it as a kinematic body and the player standing on it rides
 * along (page and worker alike).
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const T = (position: number[], rotation: number[] = [0, 0, 0, 1], scale: number[] = [1, 1, 1]) => ({ position, rotation, scale });
const turnY = (deg: number) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
const tiltX = (deg: number) => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)];
const CAM = { id: 'cam-main', components: { transform: T([0, 6, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } };

function sceneOf(entities: Any[], id: string): { snapshot: Any; physics: Any } {
  return {
    snapshot: { snapshotId: `${id}@r1`, projectId: id, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, game: null },
    physics: physics3DConfigOf(entities, SETTINGS),
  };
}

function level(): { snapshot: Any; physics: Any } {
  const floorMesh = { type: 'mesh', vertices: [[-8, 0, -8], [8, 0, -8], [8, 0, 8], [-8, 0, 8]], triangles: [[0, 2, 1], [0, 3, 2]] };
  return sceneOf(
    [
      CAM,
      { id: 'player-0001', components: { transform: T([4, 3, 0]), controller: {} } },
      { id: 'floor-0001', components: { transform: T([0, 0, 0]), collider: { shape: floorMesh } } },
      { id: 'hull-0001', components: { transform: T([-5, 0.5, 5], tiltX(15)), collider: { shape: { type: 'convex', points: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0, 0.5, -0.5], [0, 0, 0.6]] } } } },
      { id: 'crate-0001', components: { transform: T([6, 0.5, -6], turnY(20), [2, 1, 0.5]), collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } } } },
      { id: 'ball-0001', components: { transform: T([-6, 0.5, -2]), collider: { shape: { type: 'sphere', radius: 0.5 } } } },
      { id: 'post-0001', components: { transform: T([6, 1, 6], [0, 0, 0, 1], [1.5, 1.5, 1.5]), collider: { shape: { type: 'capsule', radius: 0.3, height: 1.4 } } } },
      // The lift: waits for "landed", then slides 5 m (−4 in x, +3 in z) at 2 m/s.
      { id: 'lift-0001', components: { transform: T([4, 0.1, 0]), collider: { shape: { type: 'box', hx: 0.6, hy: 0.1, hz: 0.6 } }, mover: { waypoints: [[-4, 0, 3]], speed: 2, mode: 'once', startOn: 'landed' } } },
      // A thin box trigger turned 30° about Y just above the lift's top: the player's capsule
      // (a segment swept by 0.3 m) comes within it only as it lands.
      { id: 'trig-land', components: { transform: T([4, 0.22, 0], turnY(30)), trigger: { shape: 'box', size: [1, 0.06, 1], signal: 'landed', once: true } } },
      // A sphere trigger where the lift stops.
      { id: 'trig-arrive', components: { transform: T([0, 1.1, 3]), trigger: { shape: 'sphere', radius: 0.4, signal: 'arrived' } } },
      // The door opens (rises 2 m) on "arrived".
      { id: 'door-0001', components: { transform: T([-6, 0.5, -6]), collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } }, mover: { waypoints: [[0, 2, 0]], speed: 4, mode: 'once', startOn: 'arrived' } } },
      // A capsule trigger lying along X (turned 90° about Z) the player never reaches: never fires.
      { id: 'trig-far', components: { transform: T([-6, 1, 6], [0, 0, Math.SQRT1_2, Math.SQRT1_2]), trigger: { shape: 'capsule', radius: 0.3, height: 2, signal: 'never' } } },
    ],
    'd3t',
  );
}

async function run(mode: Mode, scene: { snapshot: Any; physics: Any }, steps: number, extra: Record<string, unknown> = {}): Promise<{ h: Harness; digests: string[]; at: (id: string) => number[] }> {
  const h = await startHarness(mode, { snapshot: scene.snapshot, settings: SETTINGS, physics: scene.physics, digestSteps: true, host: { buildId: 'b' }, ...extra });
  let now = 10;
  let i = 0;
  while (h.digests.length < steps) {
    const n = [1, 2, 0, 3, 1][i++ % 5]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
  }
  const errors = h.rt.getDiagnostics();
  if (errors.ok && errors.diagnostics.errors.length > 0) throw new Error(JSON.stringify(errors.diagnostics.errors));
  const transforms = h.rt.getInterpolatedState().state.transforms;
  return { h, digests: [...h.digests], at: (id: string) => [...transforms.find((t: Any) => t.id === id)!.position] };
}

describe('phase 23.1: 3D colliders, movers and triggers (page and worker)', () => {
  it('the config resolves the 3D shapes: scale applied, capsule height to half segment, meshes flattened, movers kinematic', () => {
    const { physics } = level();
    const byId = (id: string) => physics.statics.find((s: Any) => s.entityId === id);
    expect(byId('crate-0001').shape).toEqual({ type: 'box', hx: 1, hy: 0.5, hz: 0.25 });
    expect(byId('post-0001').shape).toEqual({ type: 'capsule', radius: 0.3 * 1.5, halfHeight: (0.7 - 0.3) * 1.5 });
    expect(byId('floor-0001').shape).toEqual({ type: 'mesh', vertices: [-8, 0, -8, 8, 0, -8, 8, 0, 8, -8, 0, 8], indices: [0, 2, 1, 0, 3, 2] });
    expect(byId('hull-0001').shape.points).toHaveLength(12);
    expect(byId('lift-0001').kinematic).toBe(true);
    expect(byId('floor-0001').kinematic).toBeUndefined();
    // Triggers are no colliders.
    expect(byId('trig-land')).toBeUndefined();
  });

  it('the player lands on the lift, "landed" starts it, it carries the player into "arrived", which opens the door — identical in two page runs and the worker', async () => {
    const STEPS = 720;
    const a = await run('single', level(), STEPS);
    const b = await run('single', level(), STEPS);
    const w = await run('worker', level(), STEPS);
    try {
      const n = Math.min(a.digests.length, b.digests.length, w.digests.length);
      expect(n).toBeGreaterThanOrEqual(STEPS);
      const diff = (x: string[]) => a.digests.slice(0, n).findIndex((d, k) => d !== x[k]);
      expect(diff(b.digests), 'first differing step (two page runs)').toBe(-1);
      expect(diff(w.digests), 'first differing step (page vs worker)').toBe(-1);
      // The lift reached its end (it only starts on "landed").
      const lift = a.at('lift-0001');
      expect(lift[0]).toBeCloseTo(0, 6);
      expect(lift[2]).toBeCloseTo(3, 6);
      // The player rode it there: on its top (0.2) plus half its 1.8 m height and the skin.
      const p = a.at('player-0001');
      expect(Math.abs(p[0]! - 0)).toBeLessThan(0.02);
      expect(Math.abs(p[2]! - 3)).toBeLessThan(0.02);
      expect(p[1]).toBeGreaterThan(0.2 + 0.9 - 1e-3);
      expect(p[1]).toBeLessThan(0.2 + 0.9 + 0.02);
      // "arrived" fired: the door rose 2 m.
      expect(a.at('door-0001')[1]).toBeCloseTo(2.5, 6);
      expect(w.at('door-0001')).toEqual(a.at('door-0001'));
      expect(w.at('player-0001')).toEqual(p);
    } finally {
      await a.h.dispose();
      await b.h.dispose();
      await w.h.dispose();
    }
  }, 180_000);

  it('without the landing trigger the lift never moves and the door stays shut (the signal is what drives them)', async () => {
    const scene = level();
    scene.snapshot.scene.entities = scene.snapshot.scene.entities.filter((e: Any) => e.id !== 'trig-land');
    const a = await run('single', scene, 480);
    try {
      expect(a.at('lift-0001')).toEqual([4, 0.1, 0]);
      expect(a.at('door-0001')).toEqual([-6, 0.5, -6]);
      const p = a.at('player-0001');
      expect(p[0]).toBeCloseTo(4, 4);
      expect(p[1]).toBeGreaterThan(1.1 - 1e-3);
      expect(p[1]).toBeLessThan(1.12);
    } finally {
      await a.h.dispose();
    }
  }, 60_000);
});

/** A script owning its own entity: from step 120 it moves it 1 cm per step along +x for 150 steps. */
const DRIVER = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== 'transform' || ctx.stepIndex < 120 || ctx.stepIndex >= 270) return;
    const t = ctx.world.transform(ctx.entityId);
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: t.position[0] + 0.01 } });
  },
};
`;

function ridingScene(): { snapshot: Any; physics: Any } {
  return sceneOf(
    [
      CAM,
      { id: 'player-0001', components: { transform: T([0, 3, 0]), controller: {} } },
      { id: 'plat-0001', components: { transform: T([0, 0.1, 0]), collider: { shape: { type: 'box', hx: 1, hy: 0.1, hz: 1 } }, behavior: { behaviorId: 'driver', values: {} } } },
    ],
    'd3s',
  );
}

describe('phase 23.1: a script drives a collider through intents (3D)', () => {
  it('the collider is posed as a kinematic body and carries the player standing on it (page and worker alike)', async () => {
    const driver = behaviorModule('driver', DRIVER);
    const behaviors = [{ row: { ...driver.row, ownedTransforms: ['@self'] }, url: driver.url }];
    const a = await run('single', ridingScene(), 420, { behaviors });
    const w = await run('worker', ridingScene(), 420, { behaviors });
    try {
      const plat = a.at('plat-0001');
      expect(plat[0]).toBeCloseTo(1.5, 6);
      const p = a.at('player-0001');
      // Carried 1.5 m along x (within the one-step pose lag's rounding), resting on the platform's top.
      expect(Math.abs(p[0]! - 1.5)).toBeLessThan(0.02);
      expect(p[1]).toBeGreaterThan(0.2 + 0.9 - 1e-3);
      expect(p[1]).toBeLessThan(0.2 + 0.9 + 0.02);
      expect(w.at('player-0001')).toEqual(p);
      const n = Math.min(a.digests.length, w.digests.length);
      expect(a.digests.slice(0, n)).toEqual(w.digests.slice(0, n));
    } finally {
      await a.h.dispose();
      await w.h.dispose();
    }
  }, 120_000);
});
