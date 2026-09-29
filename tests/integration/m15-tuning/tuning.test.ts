/**
 * Tuning values as data, through the production composition
 * (real game host, platformer controller, blocks and primitives, Rapier
 * physics; the physics port built from the character's data as the preview
 * and export hosts build it).
 *
 * - A project that spells out every tuning value at its default plays
 *   bit-for-bit like one that sets none (so a recorded replay of a project
 *   without tuning values stays valid).
 * - Each non-default value changes what happens.
 * - A recorded replay with non-default values (`replay-nondefault.json`)
 *   plays back bit-for-bit.
 */
import { describe, expect, it } from 'vitest';

import { ENGINE_TIMING_DEFAULTS } from '@thirdlight/project-model';

import { NONDEFAULT_RUN, NONDEFAULT_STEPS, RUN_AND_JUMP, TRACE_IDS, course, level, thing, trace } from './harness';
import REPLAY from './replay-nondefault.json';

const ALL_DEFAULTS = {
  controller: { acceleration: 40, deceleration: 60, coyoteTime: 0.05, jumpBuffer: 8 / 120, jumpRelease: 0.5, groundSnap: 0.1, skin: 0.01, autostep: false, autostepHeight: 0.25 },
  patrol: { direction: [1, 0, 0], wallProbe: 0.05, ledgeProbe: 0.4, wait: 0 },
  collectible: { amount: 1, respawn: 0 },
  hitbox: { shape: 'box' },
  mover: { maxPush: 60 },
  settings: { fixed_step_hz: 120, audio_voices: 8, music_fade_s: 1, animation_crossfade_s: 0.2 },
};

describe('tuning values as data (phase 15.3, real host + platformer + Rapier)', () => {
  it('every value spelled out at its default plays bit-for-bit like none set', async () => {
    const none = await level({ playerExtra: { health: { max: 3 } }, extra: course(), drive: RUN_AND_JUMP });
    const d = ALL_DEFAULTS;
    const spelled = await level({
      controller: d.controller,
      playerExtra: { health: { max: 3 } },
      extra: course({ patrol: d.patrol, collectible: d.collectible, hitbox: d.hitbox, mover: d.mover }),
      settings: d.settings,
      drive: RUN_AND_JUMP,
    });
    const a = trace(none, 600, TRACE_IDS);
    const b = trace(spelled, 600, TRACE_IDS);
    expect(b).toEqual(a);
    // the course did what it was built for: the character got somewhere, took damage and collected
    type Sample = { at: number[][]; counters: { counters: Record<string, number>; health: { current: number } }; hidden: string[] };
    const samples = a as Sample[];
    expect(samples.some((x) => x.at[0]![0]! > 12)).toBe(true);
    expect(samples.some((x) => x.counters.health.current < 3)).toBe(true);
    expect(samples.at(-1)!.counters.counters).toEqual({ items: 1 });
    expect(samples.at(-1)!.hidden).toContain('token-0001');
  });

  it('acceleration, deceleration and jump release change the run and the jump', async () => {
    const xAfter = async (controller: object, steps: number) => {
      const L = await level({ controller, drive: () => ({ moveX: 1, jump: 'none' }) });
      L.tick(steps);
      return L.pos('player-0001')[0];
    };
    expect(await xAfter({ acceleration: 200 }, 6)).toBeGreaterThan((await xAfter({}, 6)) + 0.05);
    const stopAt = async (controller: object) => {
      const L = await level({ controller, drive: (s) => ({ moveX: s < 60 ? 1 : 0, jump: 'none' }) });
      L.tick(120);
      return L.pos('player-0001')[0];
    };
    expect(await stopAt({ deceleration: 5 })).toBeGreaterThan((await stopAt({})) + 1);
    const peak = async (controller: object) => {
      const L = await level({ controller, drive: (s) => ({ moveX: 0, jump: s === 20 ? 'pressed' : s > 20 && s < 26 ? 'held' : s === 26 ? 'released' : 'none' }) });
      let top = -Infinity;
      for (let i = 0; i < 120; i++) {
        L.tick();
        top = Math.max(top, L.pos('player-0001')[1]);
      }
      return top;
    };
    expect(await peak({ jumpRelease: 1 })).toBeGreaterThan((await peak({})) + 0.3);
  });

  it('skin, ground snap and autostep reach the physics port', async () => {
    // (dropped from 0.5 m up: the controller keeps its skin gap when it lands)
    const restY = async (controller: object) => {
      const L = await level({ controller, spawn: [0, 1.4], drive: () => ({ moveX: 0, jump: 'none' }) });
      L.tick(60);
      return L.pos('player-0001')[1];
    };
    expect((await restY({ skin: 0.05 })) - (await restY({}))).toBeCloseTo(0.04, 2);
    const step = [thing('step-0001', 8, 0.1, { box: { size: [6, 0.2, 2], material: { color: '#777777' } }, collider: { shape: { type: 'box', hx: 3, hy: 0.1 } } })];
    const walkX = async (controller: object) => {
      const L = await level({ controller, extra: step, drive: () => ({ moveX: 1, jump: 'none' }) });
      L.tick(240);
      return L.pos('player-0001')[0];
    };
    expect(await walkX({})).toBeLessThan(5);
    expect(await walkX({ autostep: true, autostepHeight: 0.3 })).toBeGreaterThan(9);
  });

  it('settle and drop-through times are the engine\'s (no project value)', async () => {
    const settle = await level({ drive: () => ({ moveX: 0, jump: 'none' }) });
    expect(settle.rt.getDiagnostics().diagnostics.settleSteps).toBe(Math.round(ENGINE_TIMING_DEFAULTS.settleTime * 120));
    expect(settle.rt.getDiagnostics().diagnostics.settleSteps).toBe(12);
    // down + jump on a one-way platform drops through for the engine's drop-through time
    const oneWay = [thing('ledge-0001', 0, 1.5, { box: { size: [4, 0.2, 2], material: { color: '#777777' } }, collider: { shape: { type: 'box', hx: 2, hy: 0.1 }, oneWay: true } })];
    const L = await level({ spawn: [0, 2.52], extra: oneWay, drive: (s) => ({ moveX: 0, jump: s === 60 ? 'pressed' : 'none', actions: { navigate: { v: 1, x: 0, y: -1, p: 'held' } } }) });
    L.tick(120);
    expect(L.dropThroughCalls).toEqual([Math.round(ENGINE_TIMING_DEFAULTS.dropThroughTime * 120)]);
    expect(L.dropThroughCalls).toEqual([15]);
    expect(L.pos('player-0001')[1]).toBeLessThan(1.2); // fell through to the floor
  });

  it('the project step rate: 60 Hz runs the same seconds in half the steps', async () => {
    const run = async (settings: object) => {
      const L = await level({ settings, drive: () => ({ moveX: 1, jump: 'none' }) });
      L.tick(Math.round(L.hz)); // one second
      return { hz: L.rt.getDiagnostics().diagnostics.fixedStepHz, x: L.pos('player-0001')[0], settle: L.rt.getDiagnostics().diagnostics.settleSteps };
    };
    const a = await run({});
    const b = await run({ fixed_step_hz: 60 });
    expect(a.hz).toBe(120);
    expect(b.hz).toBe(60);
    expect(b.settle).toBe(6);
    expect(Math.abs(b.x - a.x)).toBeLessThan(0.15);
  });

  it('replays a recorded non-default run bit-for-bit (replay-nondefault.json)', async () => {
    const L = await level(NONDEFAULT_RUN);
    const t = trace(L, NONDEFAULT_STEPS, TRACE_IDS);
    expect(REPLAY.trace.length).toBe(NONDEFAULT_STEPS);
    expect(JSON.parse(JSON.stringify(t))).toEqual(REPLAY.trace);
  });
});
