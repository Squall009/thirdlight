/**
 * A restart asked of the runtime (the host's replay, the pause panel's
 * restart) is applied at a step boundary and counted: `runStart()` names the
 * run (0 for the one the play started with) and the step it began at. A game
 * whose steps sample no input (no scripts) applies it too.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, createSimulationRegistry, instantiateRuntime, registerSimulationModule } from './index';
import type { Runtime, RuntimeError } from './index';
import { baseScene, cloneJson, snapshotOf } from './test-helpers';

const DT = 1 / 120;

function plainGame(modules?: string[], actions?: { sample(stepIndex: number): unknown }): { rt: Runtime; step: (n: number) => void } {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  const res = instantiateRuntime({ snapshot: snapshotOf(cloneJson(baseScene())), registry: r, driver: { kind: 'manual' }, clock: () => 0, ...(modules !== undefined ? { modules } : {}), ...(actions !== undefined ? { actions } : {}) } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify((res as { error: RuntimeError }).error)}`);
  const rt = res.runtime;
  rt.start();
  let t = 0;
  rt.tick(t);
  return {
    rt,
    step: (n) => {
      for (let i = 0; i < n; i += 1) {
        t += DT;
        const r2 = rt.tick(t);
        if (!r2.ok) throw new Error(`tick failed: ${JSON.stringify(r2.error)}`);
      }
    },
  };
}

const restart = { kind: 'restart', doc: '', widget: '', name: '' } as const;

describe('a restart is applied and counted', () => {
  for (const modules of [undefined, []] as const) {
    it(`a game without scripts (${modules === undefined ? 'the built-in demo' : 'no modules'}) restarts at the boundary after the step that took the request`, () => {
      const { rt, step } = plainGame(modules === undefined ? undefined : [...modules]);
      step(50);
      expect(rt.runStart!().step).toBe(0);
      expect(rt.queueUiEvent!(restart).ok).toBe(true);
      // The step that takes the request (51), then the boundary of step 52 starts the new run.
      step(1);
      expect(rt.runStart!().step).toBe(0);
      step(1);
      expect(rt.runStart!().step).toBe(51);
      expect(rt.runStart!().run).toBe(1);
      step(10);
      expect(rt.queueUiEvent!(restart).ok).toBe(true);
      step(2);
      expect(rt.runStart!()).toMatchObject({ step: 63, run: 2 });
      rt.dispose();
    });
  }
});

describe('a game without scripts samples its input source every step', () => {
  for (const modules of [undefined, []] as const) {
    it(`so a relayed input exercise counts its frames (${modules === undefined ? 'the built-in demo' : 'no modules'})`, () => {
      const sampled: number[] = [];
      const { rt, step } = plainGame(modules === undefined ? undefined : [...modules], { sample: (stepIndex) => (sampled.push(stepIndex), { stepIndex }) });
      const before = sampled.length;
      step(30);
      expect(sampled.length - before).toBe(30);
      expect(sampled.slice(-3)).toEqual([sampled.at(-3), sampled.at(-3)! + 1, sampled.at(-3)! + 2]);
      rt.dispose();
    });
  }
});
