/**
 * The active scene's look is simulation state. Start scenes scene-main
 * (camera, a director script) and scene-a, scene-two loaded on demand; the
 * director blends to a preset, makes scene-a active over half a second, loads
 * scene-two in place of scene-a with a fade (scene-two becomes active over the
 * fade), then unloads it (scene-main is active again at once). The page, the
 * simulation worker and a replay of the recorded input give the same digest
 * every step, and the page and the worker hand the renderer the same blend
 * (active scene, the scene blending out, its share) frame by frame.
 */
import { describe, expect, it } from 'vitest';

import { behaviorModule, FakeNode, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const STEPS = 420;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    if (ctx.phase !== undefined && ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    if (s === 20) ctx.environment.set('night', { blend: 1 });
    if (s === 40) ctx.scenes.setActive('scene-a', { blend: 0.5, easing: 'easeInOut' });
    if (s === 120) ctx.scenes.load('scene-two', { unload: ['scene-a'], fade: 0.25 });
    if (s === 300 && ctx.scenes.status('scene-two') === 'loaded') ctx.scenes.unload('scene-two');
  },
};
`;

const MAIN = [
  { id: 'cam-main', components: { transform: T([0, 2, 8]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
  { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
];
const A = [{ id: 'box-a', components: { transform: T([0, 0, 0]), box: { size: [2, 1, 2], material: { color: '#aa3333' } } } }];
const TWO = [{ id: 'box-two', components: { transform: T([5, 0, 0]), box: { size: [2, 1, 2], material: { color: '#33aa33' } } } }];

function cfg(replay: boolean): Any {
  return {
    snapshot: {
      snapshotId: 'active@r1',
      projectId: 'active',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [...MAIN, ...A] },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: MAIN.map((e) => e.id) },
        { sceneId: 'scene-a', start: true, entityIds: A.map((e) => e.id) },
        { sceneId: 'scene-two', start: false },
      ],
      environmentPresets: ['night'],
    },
    settings: { fixed_step_hz: HZ },
    physics: null,
    behaviors: [behaviorModule('director', DIRECTOR)],
    loadScene: async (sceneId: string) => {
      if (sceneId !== 'scene-two') throw new Error('unknown scene');
      return TWO;
    },
    digestSteps: true,
    host: { buildId: 'b', container: new FakeNode() },
    ...(replay ? { replay: Array.from({ length: STEPS + 50 }, (_, s) => ({ stepIndex: s, moveX: 0, jump: 'none' })) } : {}),
  };
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode, replay: boolean): Promise<{ h: Harness; digests: string[]; views: Map<number, Any> }> {
  const h = await startHarness(mode, cfg(replay));
  let now = 10;
  await h.tick(now);
  const views = new Map<number, Any>();
  let i = 0;
  while (h.digests.length < STEPS) {
    now += PATTERN[i++ % PATTERN.length]! * DT;
    await h.tick(now);
    const obs = h.host.observe();
    if (obs.ok) views.set(obs.observation.stepIndex, obs.observation.environment ?? null);
  }
  return { h, digests: h.digests.slice(0, STEPS), views };
}

describe('the active scene and its look are simulation state (page, worker, replay)', () => {
  it('setActive over a blend, a transition taking the active scene over its fade, an unload: identical digests and blend frames', async () => {
    const page = await run('single', false);
    const worker = await run('worker', true);
    const replay = await run('single', true);
    try {
      expect(worker.digests).toEqual(page.digests);
      expect(replay.digests).toEqual(page.digests);
      let compared = 0;
      for (const [step, v] of page.views) {
        if (!worker.views.has(step)) continue;
        expect(worker.views.get(step), `environment at step ${step}`).toEqual(v);
        compared += 1;
      }
      expect(compared).toBeGreaterThan(100);
      const near = (step: number): Any => {
        for (let s = step; s < step + 4; s += 1) if (page.views.has(s)) return page.views.get(s);
        throw new Error(`no view near step ${step}`);
      };
      // Nothing before the first change.
      expect(near(10)).toBeNull();
      // scene-a blending in (60 steps from step 41), the preset over it.
      const mid = near(72);
      expect(mid.scene).toMatchObject({ active: 'scene-a', from: 'scene-main' });
      expect(mid.scene.weight).toBeGreaterThan(0.3);
      expect(mid.scene.weight).toBeLessThan(0.7);
      expect(mid.target).toBe('night');
      expect(near(110).scene).toEqual({ active: 'scene-a', from: null, weight: 1 });
      // scene-two in place of scene-a, its look blending in over the fade, then scene-main after the unload.
      const swapped = [...page.views.entries()].find(([, v]) => v?.scene?.active === 'scene-two');
      expect(swapped, 'scene-two became active').toBeDefined();
      expect(swapped![1].scene.from).toBe('scene-a');
      expect(near(380).scene).toEqual({ active: 'scene-main', from: null, weight: 1 });
    } finally {
      await page.h.dispose();
      await worker.h.dispose();
      await replay.h.dispose();
    }
  }, 180_000);
});
