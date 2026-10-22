/**
 * `ctx.camera.setSeeThrough` is simulation state carried with the resolved
 * view: a neutral 3D scene whose project turns see-through on (radius 0.3),
 * a follow camera on the player and a script that changes it at fixed steps
 * (subjects by id, a field over the project's, null back to the camera's
 * target, refused arguments, out-of-range numbers kept within their limits).
 * Run in the page and in the simulation worker from the same input, every
 * step's digest is identical and the view the renderer gets carries the same
 * see-through at every step both observed; before the first call the view
 * carries none (the project's settings stand, digests as before).
 */
import { describe, expect, it } from 'vitest';

import { physics3DConfigOf, SEE_THROUGH_LIMITS } from '@thirdlight/runtime';

import { FakeNode, behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3, see_through: 1, see_through_radius: 0.3 };

/** What the script asks for, and what each call answered (kept in the UI view model, part of the digest). */
const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    const cam = ctx.camera;
    const s = ctx.stepIndex;
    const answer = (k, v) => ctx.ui.set('st.' + k, v);
    if (s === 40) answer('a', cam.setSeeThrough({ subjects: ['crate-0001', 'player-0001', 'crate-0001'], softness: 0.1 }));
    if (s === 80) answer('b', cam.setSeeThrough({ maxFade: 3, fadeTime: -1, enabled: true }));
    if (s === 120) answer('c', cam.setSeeThrough({ radius: 'big' }));
    if (s === 121) answer('d', cam.setSeeThrough({ subjects: 'player-0001' }));
    if (s === 122) answer('e', cam.setSeeThrough(null));
    if (s === 123) answer('e2', cam.setSeeThrough({}));
    if (s === 124) answer('e3', cam.setSeeThrough({ radious: 0.5 }));
    if (s === 160) answer('f', cam.setSeeThrough({ subjects: null, enabled: false }));
    if (s === 200) answer('g', cam.setSeeThrough({ subjects: [] , enabled: true }));
  },
};
`;

function scene(): { snapshot: Any; physics: Any } {
  const entities: Any[] = [
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [30, 1, 30], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 15, hy: 0.5, hz: 15 } } } },
    { id: 'crate-0001', components: { transform: T([3, 0.5, 0]), box: { size: [1, 1, 1], material: { color: '#aa6644' }, seeThrough: false } } },
    { id: 'cam-follow', components: { transform: T([0, 2, 6]), virtualCamera: { rig: 'follow', target: 'player-0001', distance: 6, pitch: 20 } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  return {
    snapshot: { snapshotId: 'seethrough@r1', projectId: 'seethrough', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities } },
    physics: physics3DConfigOf(entities, SETTINGS),
  };
}

const PATTERN = [1, 2, 1, 0, 3, 1];

async function run(mode: Mode, steps: number): Promise<{ h: Harness; digests: string[]; views: Map<number, Any> }> {
  const { snapshot, physics } = scene();
  const h = await startHarness(mode, { snapshot, settings: SETTINGS, physics, behaviors: [behaviorModule('director', DIRECTOR)], digestSteps: true, host: { buildId: 'b', container: new FakeNode() } });
  let now = 10;
  await h.tick(now);
  const views = new Map<number, Any>();
  let i = 0;
  while (h.digests.length < steps) {
    now += PATTERN[i++ % PATTERN.length]! * DT;
    await h.tick(now);
    const obs = h.host.observe();
    if (obs.ok && obs.observation.camera !== undefined) views.set(obs.observation.stepIndex, obs.observation.camera.seeThrough ?? null);
  }
  return { h, digests: [...h.digests], views };
}

describe('ctx.camera.setSeeThrough (page and worker)', () => {
  it('carries the same see-through with the view, step for step, over the project settings', async () => {
    const a = await run('single', 240);
    const w = await run('worker', 240);
    try {
      const n = Math.min(a.digests.length, w.digests.length);
      expect(a.digests.slice(0, n).findIndex((d, k) => d !== w.digests[k]), 'first differing step (page vs worker)').toBe(-1);
      let compared = 0;
      for (const [step, st] of a.views) {
        if (!w.views.has(step)) continue;
        expect(w.views.get(step), `see-through at step ${step}`).toEqual(st);
        compared += 1;
      }
      expect(compared).toBeGreaterThan(60);
      const near = (from: number, to: number): Any => {
        for (const [step, st] of [...a.views].sort((x, y) => x[0] - y[0])) if (step >= from && step < to) return st;
        throw new Error(`no view in ${from}-${to}`);
      };
      // Before any call: nothing carried (the renderer keeps the project's settings).
      expect(near(5, 39)).toBeNull();
      // Named subjects (repeats once), a field changed, the rest from the project (on, radius 0.3).
      const named = near(42, 79);
      expect(named.subjects).toEqual(['crate-0001', 'player-0001']);
      expect(named.settings).toMatchObject({ enabled: true, radius: 0.3, softness: 0.1, maxFade: 0.75 });
      // Out-of-range numbers kept within their limits; the subjects stay.
      const clamped = near(82, 119);
      expect(clamped.settings.maxFade).toBe(SEE_THROUGH_LIMITS.maxFade.max);
      expect(clamped.settings.fadeTime).toBe(SEE_THROUGH_LIMITS.fadeTime.min);
      expect(clamped.subjects).toEqual(['crate-0001', 'player-0001']);
      // Wrong arguments change nothing.
      expect(near(126, 159)).toEqual(clamped);
      // null: back to the camera's target; off.
      const back = near(162, 199);
      expect(back.subjects).toBeNull();
      expect(back.settings.enabled).toBe(false);
      // An empty list is the camera's target too.
      expect(near(202, 240).subjects).toBeNull();
      expect((a.h.rt as Any).uiView().model.st).toEqual({ a: true, b: true, c: false, d: false, e: false, e2: false, e3: false, f: true, g: true });
    } finally {
      await a.h.dispose();
      await w.h.dispose();
    }
  }, 120_000);
});
