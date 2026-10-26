/**
 * A player jumping while it pushes into the side of a mover at rest (a closed
 * gate), through the production game host on the Rapier 3D backend: it rises
 * and falls as it does beside a fixed wall of the same shape. Pushed into the
 * wall at its skin, every cast of Rapier's sweep stopped at once and the
 * player hung in the air for good after its first jump (found playing an
 * upgraded side-view platformer). Plain and arcade controllers, page and
 * worker alike.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const STEPS = 700;
/** Jumps pressed at these steps, each held 40 steps; the player pushes left (into the gate) throughout. */
const JUMPS = [200, 320, 440, 560];
/** A gate 0.5 m thick and 3 m tall, its foot on the floor (a convex prism, as a side-view kit piece is). */
const GATE = { type: 'convex', points: [[-0.25, 0, -0.5], [-0.25, 0, 0.5], [0.25, 0, -0.5], [0.25, 0, 0.5], [0.25, 3, -0.5], [0.25, 3, 0.5], [-0.25, 3, -0.5], [-0.25, 3, 0.5]] };

const director = `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    const p = ctx.world.transform('player-0001').position;
    const log = ctx.save.get('log') ?? [];
    if (ctx.stepIndex % 10 === 0) log.push([ctx.stepIndex, p[0], p[1]]);
    ctx.save.set('log', log);
  },
};`;

const jumpOf = (s: number): string => {
  for (const j of JUMPS) {
    if (s === j) return 'pressed';
    if (s > j && s < j + 40) return 'held';
    if (s === j + 40) return 'released';
  }
  return 'none';
};

async function run(mode: Mode, mover: boolean, arcade: boolean): Promise<{ log: number[][]; digests: string[] }> {
  const main: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 6, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'director', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'director', values: {} } } },
    { id: 'player-0001', components: { transform: T([-9, 0.5165, 0]), controller: { capsule: { radius: 0.182, height: 1.013, offset: [0, 0] }, coyoteTime: 0.08, jumpBuffer: 0.1, jumpRelease: 0.5, ...(arcade ? { profile: 'arcade' } : {}) } } },
    { id: 'floor', components: { transform: T([-10, -0.5, 0]), collider: { shape: { type: 'box', hx: 10, hy: 0.5, hz: 0.5 } } } },
    // A mover that never starts (its signal is never sent): kinematic, at rest.
    { id: 'gate', components: { transform: T([-12, 0, 0]), collider: { shape: GATE }, ...(mover ? { mover: { waypoints: [[0, 3.2, 0]], speed: 3.5, mode: 'once', easing: 'smooth', startOn: 'never-sent' } } : {}) } },
  ];
  const replay = Array.from({ length: STEPS + 100 }, (_, s) => ({ stepIndex: s, moveX: -1, moveY: 0, jump: jumpOf(s) }));
  const h = await startHarness(mode, { snapshot: { snapshotId: 'gate@r1', projectId: 'gate', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main } }, storage: true, settings: SETTINGS, physics: physics3DConfigOf(main, SETTINGS), replay, digestSteps: true, behaviors: [behaviorModule('director', director)] });
  try {
    let now = 10;
    while (h.digests.length < STEPS) {
      now += DT;
      await h.tick(now);
      if (h.digests.length % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return { log: ((await h.storage()) as Any).log, digests: [...h.digests] };
  } finally {
    await h.dispose();
  }
}

/** The highest point of each jump (from its press to the next). */
const apexes = (log: readonly number[][]): number[] => JUMPS.map((j, i) => Math.max(...log.filter((r) => r[0] >= j && r[0] < (JUMPS[i + 1] ?? STEPS)).map((r) => r[2]!)));

describe('a player jumps while it pushes into a mover at rest (3D)', () => {
  for (const arcade of [false, true]) {
    it(`${arcade ? 'arcade' : 'plain'} controller: every jump rises and lands as beside a fixed wall; page and worker alike`, async () => {
      const wall = await run('single', false, arcade);
      const gate = await run('single', true, arcade);
      const fixed = apexes(wall.log);
      // Against the wall: the jumps go up (well over 1 m) and come down to the floor.
      for (const a of fixed) expect(a).toBeGreaterThan(1.3);
      const moved = apexes(gate.log);
      for (let i = 0; i < JUMPS.length; i++) expect(moved[i]!, `jump ${i + 1}`).toBeCloseTo(fixed[i]!, 1);
      // Back on the floor before each next jump and at the end, never held up in the air beside the gate.
      for (const j of [...JUMPS.slice(1), STEPS].map((s) => s - 10)) expect(gate.log.find((r) => r[0] === j)![2]).toBeCloseTo(0.5165, 2);
      const w = await run('worker', true, arcade);
      expect(w.digests.slice(0, STEPS)).toEqual(gate.digests.slice(0, STEPS));
    }, 120_000);
  }
});
