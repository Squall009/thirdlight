/**
 * Phase 23.18: the environment blend is simulation state — a neutral scene
 * with two presets ("day", "night") and a director script: night over 2 s
 * (from the base look), day over 1 s with a fog-colour override interrupting
 * it, then a held mix `blend(day, night, 0.3)`. Run twice in the page and
 * once in the simulation worker from the same input, every step's digest
 * (the blend included) is identical and the blend the renderer gets (the
 * host's observation) agrees frame by frame. A game that never touches the
 * environment keeps its digest exactly (nothing is added before first use).
 */
import { describe, expect, it } from 'vitest';

import { behaviorModule, FakeNode, startHarness, type Harness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const DIRECTOR = `
export default {
  instantiate() { return {}; },
  step(state, ctx) {
    const env = ctx.environment;
    const s = ctx.stepIndex;
    if (s === 30) env.set('night', { blend: 2 });
    if (s === 150) env.set('day', { blend: 1, easing: 'easeInOut', override: { fog: { color: '#ff0000' } } });
    if (s === 500) env.blend('day', 'night', 0.3);
  },
};
`;
const IDLE = `export default { instantiate() { return {}; }, step() {} };`;

function snapshot(presets: boolean): Any {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 2, 8]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'sun-0001', components: { transform: T([0, 5, 0]), light: { type: 'directional', color: '#ffffff', intensity: 2, direction: [0, -1, 0] } } },
    { id: 'floor-0001', components: { transform: T([0, -0.5, 0]), box: { size: [10, 1, 10], material: { color: '#888888' } } } },
    { id: 'director-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'director', values: {} } } },
  ];
  return {
    snapshotId: 'env@r1',
    projectId: 'env',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
    game: null,
    ...(presets ? { environmentPresets: ['day', 'night'] } : {}),
  };
}

const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode, source: string, presets: boolean, steps: number): Promise<{ h: Harness; digests: string[]; views: Map<number, Any> }> {
  const h = await startHarness(mode, { snapshot: snapshot(presets), settings: { fixed_step_hz: HZ }, physics: null, behaviors: [behaviorModule('director', source)], digestSteps: true, host: { buildId: 'b', container: new FakeNode() } });
  let now = 10;
  await h.tick(now);
  const views = new Map<number, Any>();
  let i = 0;
  while (h.digests.length < steps) {
    const n = PATTERN[i++ % PATTERN.length]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
    const obs = h.host.observeScene!();
    if (obs.ok) views.set(obs.observation.stepIndex, obs.observation.environment ?? null);
  }
  return { h, digests: [...h.digests], views };
}

const firstDiff = (a: string[], b: string[]): number => a.slice(0, Math.min(a.length, b.length)).findIndex((d, k) => d !== b[k]);

describe('phase 23.18: the environment blend is simulation state (two page runs and the worker)', () => {
  it('night over 2 s, day with an override interrupting it, a held mix: identical digests and blend frames', async () => {
    const a = await run('single', DIRECTOR, true, 600);
    const b = await run('single', DIRECTOR, true, 600);
    const w = await run('worker', DIRECTOR, true, 600);
    try {
      expect(firstDiff(a.digests, b.digests), 'first differing step (two page runs)').toBe(-1);
      expect(firstDiff(a.digests, w.digests), 'first differing step (page vs worker)').toBe(-1);
      let compared = 0;
      for (const [step, v] of a.views) {
        if (!w.views.has(step)) continue;
        expect(w.views.get(step), `environment at step ${step}`).toEqual(v);
        compared += 1;
      }
      expect(compared).toBeGreaterThan(150);
      const at = (step: number): Any => {
        for (let s = step; s < step + 4; s += 1) if (a.views.has(s)) return a.views.get(s);
        throw new Error(`no view near step ${step}`);
      };
      // Nothing before the first change.
      expect(at(10)).toBeNull();
      // A quarter of the way to night half a second after the change (60 of 240 steps): weights, not a switch.
      const quarter = at(90);
      expect(quarter.target).toBe('night');
      expect(quarter.weights['night']).toBeGreaterThan(0.24);
      expect(quarter.weights['night']).toBeLessThan(0.28);
      expect(quarter.weights['']).toBeCloseTo(1 - quarter.weights['night'], 9);
      const mid = at(144);
      expect(mid.weights['night']).toBeGreaterThan(0.45);
      expect(mid.weights['night']).toBeLessThan(0.5);
      // The weights are interpolated with the frame's alpha, the progress is the committed step's.
      expect(Math.abs(mid.progress - mid.weights['night'])).toBeLessThan(1 / 240 + 1e-9);
      // Interrupted at step 150 (night ≈ 1/2): the patched day blends in from there.
      const day = at(300);
      expect(day.target).toBe('day');
      expect(day.progress).toBe(1);
      expect(Object.keys(day.weights)).toEqual(['day~1']);
      // The held mix.
      const held = at(560);
      expect(held.weights).toEqual({ day: 0.7, night: 0.3 });
    } finally {
      await a.h.dispose();
      await b.h.dispose();
      await w.h.dispose();
    }
  }, 180_000);

  it('a game that never changes the environment has the same digests with or without presets', async () => {
    const a = await run('single', IDLE, false, 200);
    const b = await run('single', IDLE, true, 200);
    try {
      expect(firstDiff(a.digests, b.digests)).toBe(-1);
      expect([...b.views.values()].every((v) => v === null)).toBe(true);
    } finally {
      await a.h.dispose();
      await b.h.dispose();
    }
  }, 60_000);
});
