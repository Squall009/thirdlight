/**
 * Runtime lifecycle tests (runtime.md §3): states, transitions, error
 * codes, single-loop ownership (no duplicate loops across start/stop
 * cycles), owned-listener removal on stop/dispose, repeatable disposal,
 * retained state across restart.
 *
 * The rAF "injected driver fake" (m1-acceptance §2.1) is a stubbed
 * global `requestAnimationFrame`/`cancelAnimationFrame`; it counts live
 * scheduled callbacks so single-loop ownership is observable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, createSimulationRegistry, instantiateRuntime, registerSimulationModule } from './index';
import { baseScene, cloneJson, snapshotOf } from './test-helpers';

interface RafFake {
  /** Live (scheduled, not cancelled) rAF callback IDs. */
  live: Set<number>;
  /** Invoke the oldest live callback once (one frame). */
  pump: () => void;
}

const restorers: Array<() => void> = [];

function installRafFake(): RafFake {
  const live = new Set<number>();
  const cbs = new Map<number, (time: number) => void>();
  let next = 1;
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (time: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const savedRaf = g.requestAnimationFrame;
  const savedCaf = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb) => {
    const id = next;
    next += 1;
    cbs.set(id, cb);
    live.add(id);
    return id;
  };
  g.cancelAnimationFrame = (id) => {
    cbs.delete(id);
    live.delete(id);
  };
  restorers.push(() => {
    g.requestAnimationFrame = savedRaf;
    g.cancelAnimationFrame = savedCaf;
  });
  return {
    live,
    pump: () => {
      const ids = [...live];
      const first = ids[0];
      const cb = first !== undefined ? cbs.get(first) : undefined;
      if (first === undefined || !cb) throw new Error('no live rAF callback to pump');
      // A fired rAF callback is single-shot: consume the handle before
      // invoking (the browser removes the scheduled entry on fire; the
      // runtime reschedules a FRESH handle inside the callback).
      cbs.delete(first);
      live.delete(first);
      cb(0); // the runtime ignores the rAF timestamp (it uses clock())
    },
  };
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

function makeRuntime(driver?: { kind: 'raf' } | { kind: 'manual' }, clock?: () => number) {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  const res = instantiateRuntime({
    snapshot: snapshotOf(cloneJson(baseScene())),
    registry: r,
    driver,
    ...(clock ? { clock } : {}),
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  return res.runtime;
}

describe('lifecycle (runtime.md §3)', () => {
  it('start/stop/start with the rAF driver keeps EXACTLY ONE active loop and removes the owned listener on stop/dispose', () => {
    const fake = installRafFake();
    let now = 0;
    const rt = makeRuntime(undefined, () => now); // driver defaults to raf (fake present)
    expect(fake.live.size).toBe(0); // no loop installed at instantiate

    expect(rt.start().ok).toBe(true);
    expect(fake.live.size).toBe(1);
    fake.pump(); // frame 1: anchor (zero steps)
    expect(fake.live.size).toBe(1); // loop rescheduled exactly once
    now += 1 / 60;
    fake.pump(); // 2 steps
    expect(fake.live.size).toBe(1);

    expect(rt.stop().ok).toBe(true);
    expect(fake.live.size).toBe(0); // owned listener removed
    expect(rt.start().ok).toBe(true);
    expect(fake.live.size).toBe(1); // restart installs ONE loop, not two
    now += 1 / 60;
    fake.pump();
    expect(fake.live.size).toBe(1);
    const diag = rt.getDiagnostics();
    expect(diag.ok).toBe(true);
    if (diag.ok) expect(diag.diagnostics.stepIndex).toBe(4);

    expect(rt.stop().ok).toBe(true);
    expect(fake.live.size).toBe(0);
    expect(rt.dispose().ok).toBe(true);
    expect(fake.live.size).toBe(0);
  });

  it('duplicate start ⇒ runtime_already_started; stop/tick while not running ⇒ runtime_not_running', () => {
    const rt = makeRuntime({ kind: 'manual' }, () => 0);
    expect(rt.start().ok).toBe(true);
    const dup = rt.start();
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('runtime_already_started');
    expect(rt.stop().ok).toBe(true);
    const stopAgain = rt.stop();
    expect(stopAgain.ok).toBe(false);
    if (!stopAgain.ok) expect(stopAgain.error.code).toBe('runtime_not_running');
    const tickStopped = rt.tick(1);
    expect(tickStopped.ok).toBe(false);
    if (!tickStopped.ok) expect(tickStopped.error.code).toBe('runtime_not_running');
    const fresh = makeRuntime({ kind: 'manual' }, () => 0);
    const tickInstantiated = fresh.tick(1);
    expect(tickInstantiated.ok).toBe(false);
    if (!tickInstantiated.ok) expect(tickInstantiated.error.code).toBe('runtime_not_running');
    fresh.dispose();
    rt.dispose();
  });

  it('tick with the rAF driver ⇒ tick_not_allowed', () => {
    const fake = installRafFake();
    const rt = makeRuntime(undefined, () => 0);
    expect(rt.start().ok).toBe(true);
    fake.pump();
    const res = rt.tick(1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('tick_not_allowed');
    rt.stop();
    rt.dispose();
  });

  it('dispose is idempotent; all lifecycle methods after dispose ⇒ runtime_disposed; getDiagnostics still works', () => {
    const rt = makeRuntime({ kind: 'manual' }, () => 0);
    expect(rt.start().ok).toBe(true);
    expect(rt.dispose().ok).toBe(true);
    const again = rt.dispose();
    expect(again).toEqual({ ok: true, alreadyDisposed: true });
    const results: Array<[string, { ok: boolean } & { error?: { code: string } }]> = [
      ['start', rt.start()],
      ['stop', rt.stop()],
      ['tick', rt.tick(1)],
      ['state', rt.getInterpolatedState()],
      ['camera', rt.getCamera()],
    ];
    for (const [name, res] of results) {
      expect(res.ok, name).toBe(false);
      if (!res.ok) expect(res.error!.code, name).toBe('runtime_disposed');
    }
    const diag = rt.getDiagnostics();
    expect(diag.ok).toBe(true);
    if (diag.ok) {
      expect(diag.diagnostics.state).toBe('disposed');
      expect(diag.diagnostics.snapshotId).toBe('demo-0001@r4');
    }
  });

  it('restart from stopped RETAINS the simulation state (stepIndex/simTime keep counting)', () => {
    const rt = makeRuntime({ kind: 'manual' }, () => 0);
    let now = 0;
    expect(rt.start().ok).toBe(true);
    rt.tick(now); // anchor
    for (let i = 0; i < 3; i += 1) {
      now += 1 / 120;
      rt.tick(now);
    }
    expect(rt.stop().ok).toBe(true);
    const mid = rt.getDiagnostics();
    if (!mid.ok) throw new Error('diagnostics failed');
    expect(mid.diagnostics.stepIndex).toBe(3);
    // Restart continues from step 3.
    expect(rt.start().ok).toBe(true);
    now += 1 / 120;
    expect(rt.tick(now).ok).toBe(true);
    const after = rt.getDiagnostics();
    if (!after.ok) throw new Error('diagnostics failed');
    expect(after.diagnostics.stepIndex).toBe(4);
    // The demo position follows the §7.1 formula at the CONTINUED
    // stepIndex (no reset, no jump): x(4) = x0 + A·sin(2π·5/480).
    const st = rt.getInterpolatedState();
    if (!st.ok) throw new Error('state failed');
    const box = st.state.transforms.find((t) => t.id === 'box-0001');
    expect(box).toBeDefined();
    const expectedX = 0.5 + 0.5 * Math.sin((2 * Math.PI * 5) / 480);
    expect(box!.position[0]).toBeCloseTo(expectedX, 9);
    // The last interpolated state remains readable after stop too.
    expect(rt.stop().ok).toBe(true);
    expect(rt.getInterpolatedState().ok).toBe(true);
  });

  it('onFrame is called exactly once per frame (including the anchor frame)', () => {
    const fake = installRafFake();
    let frames = 0;
    const r = createSimulationRegistry();
    for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
    const res = instantiateRuntime({
      snapshot: snapshotOf(cloneJson(baseScene())),
      registry: r,
      onFrame: () => {
        frames += 1;
      },
      clock: () => 0,
    });
    if (!res.ok) throw new Error('instantiate failed');
    res.runtime.start();
    fake.pump();
    expect(frames).toBe(1);
    fake.pump();
    expect(frames).toBe(2);
    res.runtime.stop();
    res.runtime.dispose();
  });

  it('driver defaults: raf when requestAnimationFrame exists, manual otherwise; explicit raf without rAF ⇒ config_invalid', () => {
    const fake = installRafFake();
    const withRaf = makeRuntime(undefined, () => 0);
    const tickRes = withRaf.tick(0);
    expect(tickRes.ok).toBe(false); // rAF driver ⇒ tick_not_allowed
    if (!tickRes.ok) expect(tickRes.error.code).toBe('tick_not_allowed');
    withRaf.dispose();
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    const saved = g.requestAnimationFrame;
    g.requestAnimationFrame = undefined;
    try {
      const noRaf = makeRuntime(undefined, () => 0); // defaults to manual now
      noRaf.start();
      expect(noRaf.tick(0).ok).toBe(true); // manual driver runs
      noRaf.dispose();
      const r = createSimulationRegistry();
      for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
      const res = instantiateRuntime({
        snapshot: snapshotOf(cloneJson(baseScene())),
        registry: r,
        driver: { kind: 'raf' },
        clock: () => 0,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('config_invalid');
    } finally {
      g.requestAnimationFrame = saved;
    }
    // The fake stays installed (restored by afterEach); nothing to pump.
    expect(fake.live.size).toBe(0);
  });
});