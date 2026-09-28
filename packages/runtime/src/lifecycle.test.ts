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
import { BUILTIN_MODULES, createBehaviorModuleSpec, createSimulationRegistry, instantiateRuntime, neutralFrame, registerSimulationModule, type BehaviorLifecycle } from './index';
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

describe('ctx.lifecycle.respawn on the 2D plane (phase 24.7)', () => {
  const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
  interface Ctx {
    phase: string;
    stepIndex: number;
    lifecycle: BehaviorLifecycle;
    world: { transform(id: string): { position: readonly number[] } | undefined };
  }

  /** A scene whose character (the controller entity) starts at (0, 5), two spawns, one script; the port keeps the character where it was last placed. */
  function run(script: (ctx: Ctx) => void) {
    const placed: { x: number; y: number }[] = [];
    let where = { x: 0, y: 5 };
    const zero = { x: 0, y: 0 };
    const port = {
      stageCharacterMove() {},
      step: () => ({ requested: { ...zero }, applied: { ...zero }, position: { ...where }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false }),
      reset() {},
      clearCharacterMotion() {},
      placeCharacter(c: { x: number; y: number }) {
        placed.push({ ...c });
        where = { x: c.x, y: c.y };
        return { ok: true, supportNormal: { x: 0, y: 1 } };
      },
      characterClearance: () => ({ ok: true, supportNormal: { x: 0, y: 1 } }),
      addStaticColliders() {},
      removeStaticColliders() {},
      setKinematicPositions() {},
      diagnostics: () => ({}),
      dispose() {},
    };
    const spec = createBehaviorModuleSpec({
      declaration: { properties: [] } as never,
      artifact: {
        behaviorId: 'keeper',
        sourceDigest: 'a'.repeat(64),
        manifestDigest: 'b'.repeat(64),
        outputDigest: 'c'.repeat(64),
        ownedTransforms: [],
        requiredModules: [],
        enginePins: [],
        namespace: { default: { step: (_s: unknown, ctx: Ctx) => script(ctx) } },
      } as never,
    });
    const r = createSimulationRegistry();
    registerSimulationModule(r, spec.id, spec);
    const now = { t: 0 };
    const res = instantiateRuntime({
      snapshot: {
        snapshotId: 'respawn@r1',
        projectId: 'respawn',
        revision: 1,
        scene: {
          schemaVersion: 4,
          sceneId: 'scene-main',
          revision: 1,
          entities: [
            { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
            { id: 'player-0001', components: { transform: at(0, 5), controller: {} } },
            { id: 'spawn-a', components: { transform: at(2, 1), playerSpawn: {} } },
            { id: 'spawn-b', components: { transform: at(8, 3), playerSpawn: {} } },
            { id: 'box-keeper', components: { transform: at(0, -5), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, behavior: { behaviorId: 'keeper', values: {} } } },
          ],
        },
      },
      registry: r,
      modules: [spec.id],
      actions: { sample: (i: number) => neutralFrame(i) },
      physics: port as never,
      settings: {},
      fixedStepHz: 120,
      clock: () => now.t,
      driver: { kind: 'manual' },
    } as never);
    if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
    const rt = res.runtime;
    expect(rt.start().ok).toBe(true);
    expect(rt.tick(now.t).ok).toBe(true);
    const tick = (n = 1): void => {
      for (let i = 0; i < n; i++) {
        now.t += 1 / 120;
        const t = rt.tick(now.t);
        if (!t.ok) throw new Error(`tick failed: ${JSON.stringify(t.error)} ${JSON.stringify(rt.getDiagnostics())}`);
      }
    };
    const character = (): number[] => {
      const s = rt.getInterpolatedState();
      if (!s.ok) throw new Error('no state');
      return [...s.state.transforms.find((x) => x.id === 'player-0001')!.position];
    };
    return { rt, tick, placed, character };
  }

  it('moves the character to the active spawn at the next step boundary; a named spawn becomes the active one', () => {
    const seen: string[] = [];
    let ask: (() => boolean) | null = null;
    let lifecycle: BehaviorLifecycle | null = null;
    const h = run((ctx) => {
      if (ctx.phase !== 'intent') return;
      lifecycle = ctx.lifecycle;
      const p = ctx.world.transform('player-0001')!.position;
      seen.push(`${p[0]},${p[1]}`);
      if (ask !== null) {
        expect(ask()).toBe(true);
        ask = null;
      }
    });
    h.tick(3);
    expect(h.character().slice(0, 2)).toEqual([0, 5]);
    expect(h.placed).toEqual([]);
    expect(lifecycle!.spawnPoint()).toBe('spawn-a'); // the first spawn until one is set

    // Asked in a step: that step still sees the character where it was; the next one sees it at the spawn.
    seen.length = 0;
    ask = () => lifecycle!.respawn();
    h.tick(1);
    expect(h.placed).toEqual([]);
    expect(seen).toEqual(['0,5']);
    h.tick(1);
    expect(h.placed).toEqual([{ x: 2, y: 1 }]);
    expect(seen).toEqual(['0,5', '2,1']);
    h.tick(2);
    expect(h.character().slice(0, 2)).toEqual([2, 1]);

    // A named spawn: it becomes the active one, and later respawns use it.
    ask = () => lifecycle!.respawn('spawn-b');
    h.tick(2);
    expect(h.placed.at(-1)).toEqual({ x: 8, y: 3 });
    expect(lifecycle!.spawnPoint()).toBe('spawn-b');
    expect(h.character().slice(0, 2)).toEqual([8, 3]);
    // An unknown spawn is refused and moves nothing.
    expect(lifecycle!.respawn('box-keeper')).toBe(false);
    const before = h.placed.length;
    h.tick(2);
    expect(h.placed.length).toBe(before);
    expect(h.rt.getDiagnostics().ok && (h.rt.getDiagnostics() as { diagnostics: { state: string } }).diagnostics.state).toBe('running');
  });
});
