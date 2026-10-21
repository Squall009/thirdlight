/**
 * A script error stops only that script, through the production host
 * (the game page's and the export's), on the main thread and in the
 * simulation worker, with the real 3D physics.
 *
 * A neutral level: the character starts in the air and a walker script walks
 * it; one object of the `broken` script throws in its step at step 10 (a
 * second object of the same script never throws); a pinger messages that
 * object and a listener, whose `onMessage` throws at the message of step 20.
 *
 * Checked: the run keeps stepping (the character falls onto the floor and
 * walks on, every healthy script keeps writing); each error is listed once,
 * with its object, step and hook; the throwing instances' later hooks never
 * run (neither their step nor their message callback); each script reports
 * one Problems line; page and worker agree step for step.
 */
import { describe, expect, it } from 'vitest';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';
import { DT, MODULES_3D, SETTINGS, STAND_Y, T, sceneOf, type Any } from '../m23-3d/character-kit';

const BROKEN = `export default {
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    ctx.save.set('last:' + ctx.entityId, ctx.stepIndex);
    if (ctx.entityId === 'broken-1' && ctx.stepIndex === 10) throw new Error('broken on purpose');
  },
  onMessage(s, m, ctx) { ctx.save.set('msg:' + ctx.entityId, m.value); },
};
`;
const PINGER = `export default {
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    ctx.save.set('last:' + ctx.entityId, ctx.stepIndex);
    ctx.messages.send('ping', ctx.stepIndex, 'broken-1');
    ctx.messages.send('ping', ctx.stepIndex, 'listener-1');
  },
};
`;
const LISTENER = `export default {
  onMessage(s, m, ctx) {
    ctx.save.set('heard', m.value);
    if (m.value === 20) throw new Error('listener on purpose');
  },
  step(s, ctx) { if (ctx.phase === 'intent') ctx.save.set('last:' + ctx.entityId, ctx.stepIndex); },
};
`;
const WALKER = `export default {
  step(s, ctx) { if (ctx.phase === 'intent') ctx.emit({ kind: 'character_move', x: 1, z: 0 }); },
};
`;

const carrier = (id: string, behaviorId: string, x: number): Any => ({ id, components: { transform: T([x, 0.5, 5]), behavior: { behaviorId, values: {} } } });

async function run(mode: Mode, steps: number): Promise<{ h: Harness; problems: string[]; storage: Record<string, unknown>; errors: Any[]; state: string; player: number[] }> {
  const scene = sceneOf({}, [0, 3, 0], [carrier('broken-1', 'broken', -4), carrier('broken-2', 'broken', -3), carrier('pinger-1', 'pinger', -2), carrier('listener-1', 'listener', -1), carrier('walker-1', 'walker', 1)], 'serr');
  const problems: string[] = [];
  const h = await startHarness(mode, {
    snapshot: scene.snapshot,
    settings: SETTINGS,
    physics: scene.physics,
    digestSteps: true,
    modules: MODULES_3D,
    storage: true,
    behaviors: [behaviorModule('broken', BROKEN), behaviorModule('pinger', PINGER), behaviorModule('listener', LISTENER), behaviorModule('walker', WALKER)],
    // The script-error lines among the run's problems (a save-schema notice is another kind).
    host: { buildId: 'b', onProblem: (code: string) => void (code.startsWith('script_error') && problems.push(code)) },
  });
  let now = 10;
  while (h.digests.length < steps) {
    now += 2 * DT;
    await h.tick(now);
  }
  const storage = await h.storage();
  const d = h.rt.getDiagnostics();
  const t = h.rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === 'player-0001');
  return { h, problems, storage, errors: d.diagnostics.errors.filter((e: Any) => e.code !== 'behavior_log'), state: d.diagnostics.state, player: [...t.position] };
}

describe('a script error stops only that script (page and worker)', () => {
  it('the run goes on; each error is listed once; the instance hears nothing more', async () => {
    const a = await run('single', 120);
    const w = await run('worker', 120);
    try {
      expect(a.state).toBe('running');
      expect(a.errors).toHaveLength(2);
      expect(a.errors[0]).toMatchObject({ code: 'module_error', reason: 'behavior_step_failed', moduleId: 'thirdlight.behavior:broken', entityId: 'broken-1', stepIndex: 10, phase: 'intent' });
      expect(a.errors[0].message).toContain('step threw: broken on purpose');
      // The message of step 20 arrives in step 21, before the listener's step.
      expect(a.errors[1]).toMatchObject({ reason: 'behavior_step_failed', moduleId: 'thirdlight.behavior:listener', entityId: 'listener-1', stepIndex: 21, phase: 'intent' });
      expect(a.errors[1].message).toContain('onMessage threw: listener on purpose');
      // The throwing instances stopped at their throw; the same script on another object and every other script went on.
      const s = a.storage;
      expect(s['last:broken-1']).toBe(10);
      expect(s['msg:broken-1']).toBe(9);
      expect(s['heard']).toBe(20);
      expect(s['last:listener-1']).toBe(20);
      expect(s['last:broken-2']).toBeGreaterThan(100);
      expect(s['last:pinger-1']).toBe(s['last:broken-2']);
      // The physics stepped on: the character fell onto the floor and walked along +x.
      expect(a.player[1]).toBeLessThan(STAND_Y + 0.02);
      expect(a.player[0]).toBeGreaterThan(1);
      // One Problems line per script.
      expect(a.problems.sort()).toEqual(['script_error_broken', 'script_error_listener']);
      // The worker runs the same game.
      expect(w.state).toBe('running');
      expect(w.errors).toEqual(a.errors);
      expect(w.storage).toEqual(a.storage);
      expect(w.h.digests.slice(0, 120)).toEqual(a.h.digests.slice(0, 120));
      expect(w.player).toEqual(a.player);
      expect(w.problems.sort()).toEqual(a.problems);
    } finally {
      await a.h.dispose();
      await w.h.dispose();
    }
  }, 120_000);
});
