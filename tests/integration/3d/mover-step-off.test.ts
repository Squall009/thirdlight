/**
 * Stepping off a mover onto fixed ground, through the production game host
 * on the Rapier 3D backend: a once-mover carries the standing player across
 * a pit and stops flush with the far floor; the player walks on onto that
 * floor (free in 3D, and locked to a plane as a side-view stretch has it).
 * The ride can leave the character at or a fraction of a millimetre inside
 * its skin, where Rapier's sweep stopped it for good at the floor's edge: on
 * a box floor from the start of a ride, on a triangle-mesh floor (what a
 * block layer's chunk collides with) when the player walks on, stops and
 * rides.
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf } from '@thirdlight/runtime';

import { behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const STEPS = 700;

/** The far floor (x −48…−32, top at y = 0) as a box or as the same box's triangle mesh. */
const FAR_BOX = { type: 'box', hx: 8, hy: 0.5, hz: 2 };
const FAR_MESH = {
  type: 'mesh',
  vertices: [[-8, -0.5, -2], [8, -0.5, -2], [8, 0.5, -2], [-8, 0.5, -2], [-8, -0.5, 2], [8, -0.5, 2], [8, 0.5, 2], [-8, 0.5, 2]],
  triangles: [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]],
};

interface Case {
  name: string;
  far: object;
  lock: boolean;
  /** Where the player starts, and the steps it walks left (−X): until `stop`, then from `walk` on. */
  start: number;
  stop: number;
  walk: number;
}
const CASES: Case[] = [
  { name: 'box floor, free, from the start of the ride', far: FAR_BOX, lock: false, start: -26.8, stop: 0, walk: 300 },
  { name: 'box floor, on a plane, from the start of the ride', far: FAR_BOX, lock: true, start: -26.8, stop: 0, walk: 300 },
  { name: 'mesh floor, on a plane, walked onto the mover and stopped', far: FAR_MESH, lock: true, start: -24, stop: 102, walk: 330 },
];

const director = (lock: boolean): string => `
export default {
  instantiate() { return {}; },
  step(_s, ctx) {
    if (ctx.phase !== 'intent') return;
    if (${lock} && ctx.stepIndex === 2) ctx.character.setPlane(undefined, { axis: 'z', origin: 0 });
    const p = ctx.world.transform('player-0001').position;
    const log = ctx.save.get('log') ?? [];
    if (ctx.stepIndex % 20 === 0) log.push([ctx.stepIndex, p[0], p[1], p[2]]);
    ctx.save.set('log', log);
  },
};`;

async function run(mode: Mode, c: Case): Promise<{ log: number[][]; digests: string[] }> {
  const main: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 6, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'director', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'director', values: {} } } },
    { id: 'player-0001', components: { transform: T([c.start, 0.91, 0]), controller: { walkSpeed: 4 } } },
    // The near floor ends at x = −26; the platform rests flush with it, starts when the player steps on, and stops flush with the far floor's edge at −32.
    { id: 'floor-far', components: { transform: T([-40, -0.5, 0]), collider: { shape: c.far } } },
    { id: 'floor-near', components: { transform: T([-23, -0.5, 0]), collider: { shape: { type: 'box', hx: 3, hy: 0.5, hz: 2 } } } },
    { id: 'lift', components: { transform: T([-27, -0.25, 0]), collider: { shape: { type: 'box', hx: 1, hy: 0.25, hz: 1 } }, mover: { waypoints: [[-4, 0, 0]], speed: 2, mode: 'once', startOn: 'ride' } } },
    { id: 'lift-start', components: { transform: T([-27, 1, 0]), trigger: { size: [1.6, 2, 2], signal: 'ride', once: true } } },
  ];
  const replay = Array.from({ length: STEPS + 100 }, (_, s) => ({ stepIndex: s, actions: s < c.stop || s >= c.walk ? { move: { v: 1, x: -1, y: 0, p: 'none' } } : {} }));
  const h = await startHarness(mode, { snapshot: { snapshotId: 'off@r1', projectId: 'off', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main } }, storage: true, settings: SETTINGS, physics: physics3DConfigOf(main, SETTINGS), replay, digestSteps: true, behaviors: [behaviorModule('director', director(c.lock))] });
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

describe('a player steps off a stopped mover onto the floor beside it (3D)', () => {
  for (const c of CASES) {
    it(`${c.name}: it walks on across the far floor at floor height; page and worker alike`, async () => {
      const a = await run('single', c);
      const at = (step: number): number[] => a.log.find((r) => r[0] === step)!;
      // Carried to the far edge and standing there before it walks on.
      expect(at(c.walk - (c.walk % 20))[1]).toBeLessThan(-30.5);
      // Well past the edge where it used to stop (x −32.0…−32.1).
      expect(at(STEPS)[1]).toBeLessThan(-37);
      for (const r of a.log.filter((r) => r[0] >= c.walk)) expect(r[2]).toBeCloseTo(0.91, 2);
      if (c.lock) expect(a.log.every((r) => r[0] < 4 || r[3] === 0)).toBe(true);
      const w = await run('worker', c);
      expect(w.digests.slice(0, STEPS)).toEqual(a.digests.slice(0, STEPS));
    }, 120_000);
  }
});
