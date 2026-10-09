/**
 * The play-test runner's own rules — checking a spec, splitting
 * an input script into relay exercises (between frames, at every requested
 * observation step, within the relay's steps, frames and body bounds), and
 * the run loop over a backend (a restart first, hold on every exercise, one
 * play per threading mode, runs compared by their digests). The real
 * backend, editor and game are exercised by tests/e2e/playtest.e2e.ts.
 */
import { describe, expect, it } from 'vitest';

import { INPUT_RELAY_MAX_FRAMES, INPUT_RELAY_MAX_STEPS } from '@thirdlight/protocol';

import { checkPlaytestSpec, pickPath, runPlaytest, splitScript, type PlaytestBackend, type PlaytestFrame } from './playtest';

const walk = (stepOffset: number, steps: number): PlaytestFrame => ({ stepOffset, steps, actions: { move: { v: 1, p: 'none' } } });
const span = (fs: readonly PlaytestFrame[]): number => fs.reduce((n, f) => Math.max(n, f.stepOffset + (f.steps ?? 1)), 0);

describe('splitScript', () => {
  it('one exercise when it fits; a trailing gap is an empty frame', () => {
    const r = splitScript([walk(10, 20)], [40]);
    expect(r.ok && r.value).toEqual([{ start: 0, length: 40, frames: [walk(10, 20), { stepOffset: 30, steps: 10 }], observe: true }]);
  });

  it('ends an exercise at each observation step and re-bases the frames', () => {
    const r = splitScript([walk(0, 30), walk(50, 10)], [30]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((c) => [c.start, c.length, c.observe])).toEqual([
      [0, 30, true],
      [30, 30, true],
    ]);
    expect(r.value[1]!.frames).toEqual([walk(20, 10)]);
  });

  it('refuses an observation inside a frame\'s run', () => {
    const r = splitScript([walk(0, 30)], [10]);
    expect(r.ok).toBe(false);
  });

  it('long scripts: at most 7200 steps and 600 frames per exercise, split between frames, nothing lost', () => {
    const frames: PlaytestFrame[] = [];
    for (let i = 0; i < 2000; i += 1) frames.push(walk(i * 9, 5));
    const r = splitScript(frames, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let at = 0;
    let n = 0;
    for (const c of r.value) {
      expect(c.start).toBe(at);
      expect(c.length).toBeLessThanOrEqual(INPUT_RELAY_MAX_STEPS);
      expect(c.frames.length).toBeLessThanOrEqual(INPUT_RELAY_MAX_FRAMES);
      expect(span(c.frames)).toBe(c.length);
      expect(JSON.stringify({ mode: 'exclusive-test', frames: c.frames, hold: true, restart: true }).length).toBeLessThanOrEqual(16_384);
      n += c.frames.filter((f) => f.actions !== undefined).length;
      at += c.length;
    }
    expect(n).toBe(2000);
    expect(at).toBe(span(frames));
    expect(r.value[r.value.length - 1]!.observe).toBe(true);
    expect(r.value.slice(0, -1).every((c) => !c.observe)).toBe(true);
  });

  it('a long frame of its own fits one exercise', () => {
    const r = splitScript([walk(0, 7000), walk(7000, 7200)], []);
    expect(r.ok && r.value.map((c) => [c.start, c.length])).toEqual([
      [0, 7000],
      [7000, 7200],
    ]);
  });
});

describe('checkPlaytestSpec and pickPath', () => {
  it('an input script or a driver; bounded runs, threads, fields and steps', () => {
    expect(checkPlaytestSpec({}).ok).toBe(false);
    expect(checkPlaytestSpec({ frames: [walk(0, 1)], driver: () => null }).ok).toBe(false);
    expect(checkPlaytestSpec({ frames: [walk(0, 1)], runs: 9 }).ok).toBe(false);
    expect(checkPlaytestSpec({ frames: [walk(0, 1)], threads: 'all' as never }).ok).toBe(false);
    expect(checkPlaytestSpec({ frames: [walk(0, 10), walk(5, 1)] }).ok).toBe(false);
    expect(checkPlaytestSpec({ frames: [{ stepOffset: 0, moveX: 1 } as never] }).ok).toBe(false);
    expect(checkPlaytestSpec({ frames: [walk(0, 1)], observe: { fields: ['a b'] } }).ok).toBe(false);
    expect(checkPlaytestSpec({ driver: () => null, observe: { atSteps: [5] } }).ok).toBe(false);
    const ok = checkPlaytestSpec({ frames: [walk(0, 1)], threads: 'both', observe: { atSteps: [9, 3] } });
    expect(ok.ok && ok.value).toMatchObject({ threads: ['worker', 'single'], runs: 2, atSteps: [3, 9], fields: ['state', 'player', 'counters', 'scenes', 'ui.values'] });
  });

  it('reads dot paths (null when absent)', () => {
    const doc = { ui: { values: { t: { seen: 7 } } }, list: [{ a: 1 }] };
    expect(pickPath(doc, 'ui.values.t.seen')).toBe(7);
    expect(pickPath(doc, 'list.0.a')).toBe(1);
    expect(pickPath(doc, 'ui.nothing.here')).toBeNull();
  });
});

/** A backend over a fake game: each step adds its `move` value to x; the digest is x at the run step (optionally skewed per play). */
function fakeBackend(skew: (play: number, run: number) => number = () => 0) {
  const calls: string[] = [];
  let play = 0;
  let run = 0;
  let x = 0;
  let step = 0;
  let runStep = 0;
  let last: Record<string, unknown> | undefined;
  const backend: PlaytestBackend = {
    startPlay: async (body) => {
      play += 1;
      run = 0;
      calls.push(`start ${JSON.stringify(body)}`);
      return { status: 200, body: { ok: true, playSessionId: `play-${play}` } };
    },
    stopPlay: async (id) => {
      calls.push(`stop ${id}`);
      return { status: 200, body: { ok: true } };
    },
    inputRelay: async (_id, body) => {
      const frames = body['frames'] as PlaytestFrame[];
      calls.push(`exercise ${frames.length} frames${body['restart'] === true ? ' restart' : ''}${body['hold'] === true ? ' hold' : ''}`);
      if (body['restart'] === true) {
        run += 1;
        x = 0;
        runStep = 0;
      }
      const from = step + 1;
      for (let i = 0; i < span(frames); i += 1) {
        const f = frames.find((g) => g.stepOffset <= i && i < g.stepOffset + (g.steps ?? 1));
        x += Number((f?.actions?.['move'] as { v?: number } | undefined)?.v ?? 0);
        step += 1;
        runStep += 1;
      }
      last = { toStep: step, runStep, digest: `x${x + skew(play, run)}`, held: true };
      return { status: 200, body: { ok: true, appliedFromStep: from, appliedToStep: step } };
    },
    gameObserve: async () => ({ status: 200, body: { ok: true, state: 'running', simulation: { mode: play === 1 ? 'worker' : 'single' }, player: { x }, run: { runStep, digest: `x${x}`, ...(last !== undefined ? { lastInput: last } : {}) } } }),
    diagnostics: async () => ({ status: 200, body: { ok: true, diagnostics: { runtime: { errors: [] } } } }),
  };
  return { backend, calls };
}

describe('runPlaytest over a backend', () => {
  it('each threading mode one play; every run restarts first; every exercise holds; runs that agree are deterministic', async () => {
    const { backend, calls } = fakeBackend();
    const r = await runPlaytest(backend, 'p', { frames: [walk(0, 30), walk(40, 20)], threads: 'both', runs: 2, variables: { k: 1 }, observe: { atSteps: [35], fields: ['player.x'] } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(calls).toEqual([
      'start {"options":{"demo":false,"variables":{"k":1},"threads":"worker"}}',
      'exercise 2 frames restart hold',
      'exercise 1 frames hold',
      'exercise 2 frames restart hold',
      'exercise 1 frames hold',
      'stop play-1',
      'start {"options":{"demo":false,"variables":{"k":1},"threads":"single"}}',
      'exercise 2 frames restart hold',
      'exercise 1 frames hold',
      'exercise 2 frames restart hold',
      'exercise 1 frames hold',
      'stop play-2',
    ]);
    expect(r.deterministic).toBe(true);
    expect(r.runs.map((x) => [x.threads, x.run, x.simulation])).toEqual([
      ['worker', 1, 'worker'],
      ['worker', 2, 'worker'],
      ['single', 1, 'single'],
      ['single', 2, 'single'],
    ]);
    expect(r.runs[0]!.observations).toEqual([
      { runStep: 35, digest: 'x30', fields: { 'player.x': 30 } },
      { runStep: 60, digest: 'x50', fields: { 'player.x': 50 } },
    ]);
  });

  it('runs that disagree are reported', async () => {
    const { backend } = fakeBackend((play, run) => (play === 2 && run === 2 ? 1 : 0));
    const r = await runPlaytest(backend, 'p', { frames: [walk(0, 10)], threads: 'both', runs: 2 });
    expect(r.ok && r.deterministic).toBe(false);
    expect(r.ok && r.mismatches).toEqual(['single run 2: at run step 10 digest x11, the first run at 10 x10']);
  });

  it('a driver steps in lockstep: its first step restarts, its result and trace are the run\'s', async () => {
    const { backend, calls } = fakeBackend();
    const r = await runPlaytest(backend, 'p', {
      runs: 2,
      driver: async (game) => {
        let o = await game.observe();
        while ((o['player'] as { x: number }).x < 25) o = await game.step([walk(0, 10)]);
        game.log(`run ${game.run}`);
        return { x: (o['player'] as { x: number }).x };
      },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(calls.slice(0, 5)).toEqual(['start {"options":{"demo":false}}', 'exercise 1 frames restart hold', 'exercise 1 frames hold', 'exercise 1 frames hold', 'exercise 1 frames hold']);
    expect(r.deterministic).toBe(true);
    expect(r.runs.map((x) => [x.result, x.log, x.trace?.exercises])).toEqual([
      [{ x: 30 }, ['run 1'], 4],
      [{ x: 30 }, ['run 2'], 4],
    ]);
  });

  it('a game that starts paused is refused, and its play stopped', async () => {
    const { backend, calls } = fakeBackend();
    const paused: PlaytestBackend = { ...backend, gameObserve: async () => ({ status: 200, body: { ok: true, state: 'paused' } }) };
    const r = await runPlaytest(paused, 'p', { frames: [walk(0, 10)] });
    expect(r).toMatchObject({ ok: false, error: { code: 'playtest_paused' } });
    expect(calls[calls.length - 1]).toBe('stop play-1');
  });

  it('a game that fails ends the test with its error at once, before or during a run, and its play stopped', async () => {
    const error = { code: 'module_error', message: 'behavior "b" step threw: boom', stepIndex: 40 };
    for (const when of ['before', 'during', 'relay'] as const) {
      const { backend, calls } = fakeBackend();
      let exercised = false;
      const failing: PlaytestBackend = {
        ...backend,
        inputRelay: async (id, body) => {
          exercised = true;
          // The run failed inside the exercise: it never completes and the relay times out.
          if (when === 'relay') return { status: 504, body: { ok: false, error: { code: 'input_relay_timeout', message: 'input relay timed out' } } };
          return backend.inputRelay(id, body, 1000);
        },
        // The run fails before it holds after the exercise: the observation says so (no lastInput held).
        gameObserve: async () => ({ status: 200, body: when === 'before' || exercised ? { ok: true, state: 'failed', error, run: { runStep: 3, digest: 'x' } } : { ok: true, state: 'running', run: { runStep: 0, digest: 'x' } } }),
      };
      const t0 = Date.now();
      const r = await runPlaytest(failing, 'p', { frames: [walk(0, 10)] });
      expect(r, when).toMatchObject({ ok: false, error: { code: 'playtest_game_failed', message: expect.stringContaining('boom') } });
      expect(r.ok === false && r.error.message, when).toContain(when === 'before' ? 'before the play-test began' : 'during the run');
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(calls[calls.length - 1]).toBe('stop play-1');
    }
  });
});
