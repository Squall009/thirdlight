/**
 * Phase 23.0: a neutral 3D scene (physics_dimension 3) on the Rapier 3D
 * backend through the production game host — a camera, a player capsule
 * dropped from 3 m, a floor box with depth, a box tilted about X on one side
 * and one turned about Y — run twice in the page and once in the simulation
 * worker (the same game-host worker core the browser bundles run, loading the
 * 3D backend). A digest of every executed step's committed state (every
 * transform bit for bit) is identical across the two page runs and between
 * the page and the worker; the capsule falls and rests on the floor with its
 * x and z kept; the observation of a scene-mode play reports it.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { startHarness, type Harness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
const tiltX = (deg: number) => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)];
const turnY = (deg: number) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
const START = [1.5, 3, -2];

function scene(): { snapshot: Any; physics: Any } {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T(START), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [20, 1, 20], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 10, hy: 0.5, hz: 10 } } } },
    { id: 'ramp-0001', components: { transform: T([-6, 0.5, 4], tiltX(20)), box: { size: [4, 0.4, 4], material: { color: '#6688aa' } }, collider: { shape: { type: 'box', hx: 2, hy: 0.2, hz: 2 } } } },
    { id: 'crate-0001', components: { transform: T([5, 0.5, 5], turnY(30)), box: { size: [1, 1, 1], material: { color: '#aa8866' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } } } },
  ];
  return {
    snapshot: { snapshotId: 'd3@r1', projectId: 'd3', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, game: null },
    physics: physics3DConfigOf(entities, SETTINGS),
  };
}

async function run(mode: Mode): Promise<{ h: Harness; digests: string[]; player: Any; scene: Any }> {
  const { snapshot, physics } = scene();
  const h = await startHarness(mode, { snapshot, settings: SETTINGS, physics, digestSteps: true, host: { buildId: 'b' } });
  let now = 10;
  let i = 0;
  while (h.digests.length < 360) {
    // Frames of 0–3 steps plus a sub-step remainder (as a display would give them).
    const steps = [1, 2, 0, 3, 1][i++ % 5]!;
    now += steps * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
  }
  const player = h.rt.getInterpolatedState().state.transforms.find((t: Any) => t.id === 'player-0001');
  const sc = h.host.observeScene!();
  return { h, digests: [...h.digests], player: { position: [...player.position] }, scene: sc.ok ? { ...sc.observation, sound: null } : sc };
}

describe('phase 23.0: a 3D scene steps deterministically (two runs, page and worker)', () => {
  it('the config: statics with their full rotation and depth, the capsule, gravity along −Y', () => {
    const { physics } = scene();
    expect(physics.dimension).toBe(3);
    expect(physics.character).toEqual({ position: { x: 1.5, y: 3, z: -2 }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } });
    expect(physics.statics.map((s: Any) => s.entityId)).toEqual(['floor-0001', 'ramp-0001', 'crate-0001']);
    expect(physics.statics[1].rotation.x).toBeCloseTo(Math.sin(Math.PI / 18), 12);
    expect(physics.statics[2].shape).toEqual({ type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 });
    expect(physics.solver).toEqual({ hz: 120, gravityY: -19.62 });
  });

  it('identical step digests over two page runs and in the worker; the capsule rests on the floor', async () => {
    const a = await run('single');
    const b = await run('single');
    const w = await run('worker');
    try {
      expect(a.digests.length).toBeGreaterThanOrEqual(360);
      const n = Math.min(a.digests.length, b.digests.length, w.digests.length);
      const diff = (x: string[]) => a.digests.slice(0, n).findIndex((d, k) => d !== x[k]);
      expect(diff(b.digests), 'first differing step (two page runs)').toBe(-1);
      expect(diff(w.digests), 'first differing step (page vs worker)').toBe(-1);
      // Every step's digest differs while it falls (the step index is part of it, the position too).
      expect(new Set(a.digests.slice(0, 60)).size).toBe(60);
      // Resting on the floor's top (y = 0): the capsule origin half its 1.8 m height up, plus the skin; x and z kept.
      const [x, y, z] = a.player.position;
      // (Rapier works in f32: a sub-micrometre drift of the untouched axes is its rounding.)
      expect(x).toBeCloseTo(START[0], 6);
      expect(z).toBeCloseTo(START[2], 6);
      expect(y).toBeGreaterThan(0.9 - 1e-3);
      expect(y).toBeLessThan(0.92);
      expect(w.player).toEqual(a.player);
      // The scene-mode observation: its step and the player in 3D.
      expect(a.scene).toMatchObject({ snapshotId: 'd3@r1' });
      expect(a.scene.player.x).toBeCloseTo(x, 9);
      expect(a.scene.player.y).toBeCloseTo(y, 9);
      expect(w.scene.player).toEqual(a.scene.player);
    } finally {
      await a.h.dispose();
      await b.h.dispose();
      await w.h.dispose();
    }
  }, 120_000);
});
