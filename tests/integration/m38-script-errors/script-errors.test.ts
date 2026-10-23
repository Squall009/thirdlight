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
 * run (neither their step nor their message callback); each error reports
 * one Problems line; page and worker agree step for step.
 *
 * Code that outlives its hook (an async step after its `await`, a promise
 * callback) cannot act: its ctx calls are refused, an async hook is switched
 * off once and its rejection never goes unhandled, and page and worker still
 * agree. An engine failure inside a ctx call (an injected physics port throw
 * in a ray query) fails the run instead of being blamed on the script.
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

// An async step: what it does after its await must not happen.
const ASYNC = `export default {
  async step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    ctx.save.set('async-before', ctx.stepIndex);
    await null;
    ctx.save.set('async-after', ctx.stepIndex);
  },
};
`;
// An async callback whose promise rejects later: settled by the engine, never an unhandled rejection.
const REJECTER = `export default {
  async onEnable(s, ctx) {
    await null;
    throw new Error('rejected on purpose');
  },
};
`;
// A synchronous script that leaves a promise behind: its late ctx call is refused, the script runs on.
const LATE = `export default {
  instantiate() { return {}; },
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    ctx.save.set('last:' + ctx.entityId, ctx.stepIndex);
    if (s.refused !== undefined) {
      ctx.save.set('refused', s.refused);
      s.refused = undefined;
    }
    if (ctx.stepIndex === 5) Promise.resolve().then(() => {
      try { ctx.save.set('late', ctx.stepIndex); } catch (e) { s.refused = String(e.message).slice(0, 400); }
    });
  },
};
`;
// A ray every step, its failure caught by the script.
const RAYCASTER = `export default {
  step(s, ctx) {
    if (ctx.phase !== 'intent') return;
    ctx.save.set('last:' + ctx.entityId, ctx.stepIndex);
    try { ctx.physics.raycast3d([0, 5, 5], [0, -1, 0], 10); } catch (e) { ctx.save.set('caught', 1); }
  },
};
`;

const carrier = (id: string, behaviorId: string, x: number): Any => ({ id, components: { transform: T([x, 0.5, 5]), behavior: { behaviorId, values: {} } } });
const SCRIPTS: Record<string, string> = { broken: BROKEN, pinger: PINGER, listener: LISTENER, walker: WALKER, async: ASYNC, rejecter: REJECTER, late: LATE, raycaster: RAYCASTER };
const ERRORS_LEVEL = [carrier('broken-1', 'broken', -4), carrier('broken-2', 'broken', -3), carrier('pinger-1', 'pinger', -2), carrier('listener-1', 'listener', -1), carrier('walker-1', 'walker', 1)];

type Run = { h: Harness; problems: string[]; storage: Record<string, unknown>; errors: Any[]; state: string; player: number[] };

async function run(mode: Mode, steps: number, carriers: Any[] = ERRORS_LEVEL, wrapPhysics?: (port: Any) => Any): Promise<Run> {
  const scene = sceneOf({}, [0, 3, 0], carriers, 'serr');
  const problems: string[] = [];
  const ids = [...new Set(carriers.map((c) => c.components.behavior.behaviorId as string))];
  const h = await startHarness(mode, {
    snapshot: scene.snapshot,
    settings: SETTINGS,
    physics: scene.physics,
    digestSteps: true,
    modules: MODULES_3D,
    storage: true,
    behaviors: ids.map((id) => behaviorModule(id, SCRIPTS[id]!)),
    ...(wrapPhysics !== undefined ? { wrapPhysics } : {}),
    // The script-error lines among the run's problems (a save-schema notice is another kind).
    host: { buildId: 'b', onProblem: (code: string) => void (code.startsWith('script_error') && problems.push(code)) },
  });
  let now = 10;
  while (h.digests.length < steps) {
    now += 2 * DT;
    try {
      await h.tick(now);
    } catch {
      // A failed run ticks no more.
      break;
    }
  }
  if (h.rt.getDiagnostics().diagnostics.state === 'failed') {
    const d = h.rt.getDiagnostics();
    return { h, problems, storage: {}, errors: d.diagnostics.errors.filter((e: Any) => e.code !== 'behavior_log'), state: d.diagnostics.state, player: [] };
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
      // One Problems line per error (each kind names its script).
      expect(a.problems.sort()).toEqual([expect.stringMatching(/^script_error_broken_[0-9a-f]{16}$/), expect.stringMatching(/^script_error_listener_[0-9a-f]{16}$/)]);
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

  it('code that outlives its hook cannot act: an async hook is switched off once, a late ctx call is refused', async () => {
    const level = [carrier('async-1', 'async', -4), carrier('rejecter-1', 'rejecter', -3), carrier('late-1', 'late', -2), carrier('walker-1', 'walker', 1)];
    const a = await run('single', 60, level);
    const w = await run('worker', 60, level);
    try {
      expect(a.state).toBe('running');
      // Both async hooks are listed once, as async; nothing they did after their await happened.
      expect(a.errors.map((e: Any) => `${e.moduleId} ${e.reason}`).sort()).toEqual(['thirdlight.behavior:async behavior_step_async', 'thirdlight.behavior:rejecter behavior_step_async']);
      // The line says how to fix it.
      for (const e of a.errors) expect(e.message).toContain('must not be async, and ctx works only during the call. To fix it, keep work for later in `state` and act on it in a later step.');
      expect(typeof a.storage['async-before']).toBe('number');
      expect(a.storage['async-after']).toBeUndefined();
      // The promise left behind by a synchronous step was refused; that script runs on.
      expect(a.storage['late']).toBeUndefined();
      expect(String(a.storage['refused'])).toContain('ctx.save.set was called after its hook returned');
      expect(String(a.storage['refused'])).toContain('keep work for later in `state` and act on it in a later step');
      expect(a.storage['last:late-1']).toBeGreaterThan(50);
      // The page and the worker play the same game.
      expect(w.state).toBe('running');
      expect(w.errors).toEqual(a.errors);
      expect(w.storage).toEqual(a.storage);
      expect(w.h.digests.slice(0, 60)).toEqual(a.h.digests.slice(0, 60));
    } finally {
      await a.h.dispose();
      await w.h.dispose();
    }
  }, 120_000);

  it('an engine failure inside a ctx call fails the run, even when the script catches it', async () => {
    let rays = 0;
    // The real Rapier port, its ray query made to throw on the 20th call (as a WASM panic would).
    const wrap = (port: Any): Any => new Proxy(port, {
      get(target, key) {
        const v = target[key];
        if (key === 'raycast') {
          return (...args: unknown[]) => {
            rays += 1;
            if (rays === 20) throw new Error('rapier panic (injected)');
            return v.apply(target, args);
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const a = await run('single', 60, [carrier('raycaster-1', 'raycaster', -2), carrier('walker-1', 'walker', 1)], wrap);
    try {
      expect(rays).toBe(20);
      expect(a.state).toBe('failed');
      expect(a.errors).toHaveLength(1);
      expect(a.errors[0]).toMatchObject({ code: 'physics_port_error', reason: 'threw', moduleId: 'thirdlight.behavior:raycaster' });
      expect(a.errors[0].message).toContain('physics port raycast() threw: rapier panic (injected)');
      expect(a.problems).toEqual([]);
    } finally {
      await a.h.dispose();
    }
  }, 60_000);
});
