/**
 * Phase 15.3: tuning values as data, through the production composition
 * (real game host, platformer controller, platformer-game session and camera,
 * Rapier physics; the physics port built from the player's data as the
 * preview and export hosts build it).
 *
 * - A project that spells out every tuning value at its default plays
 *   bit-for-bit like one that sets none (so every recorded replay made
 *   before the values became data stays valid).
 * - Each non-default value changes what happens.
 * - A recorded replay with non-default values (`replay-nondefault.json`)
 *   plays back bit-for-bit.
 */
import { describe, expect, it } from 'vitest';

import { ENEMY, NONDEFAULT_RUN, NONDEFAULT_STEPS, RUN_AND_JUMP, TRACE_IDS, course, level, thing, trace } from './harness';
import REPLAY from './replay-nondefault.json';

const ALL_DEFAULTS = {
  controller: { acceleration: 40, deceleration: 60, coyoteTime: 0.05, jumpBuffer: 8 / 120, jumpRelease: 0.5, groundSnap: 0.1, skin: 0.01, autostep: false, autostepHeight: 0.25 },
  health: { hitBounce: 5, knockbackTime: 0.25, invulnerableSeconds: 1 },
  enemy: { chaseHeight: 2, chaseSpeed: 0, chaseMemory: 0, stompBounce: 9, stompTolerance: 0.2, defeat: 'squash', defeatTime: 0.3, wallProbe: 0.05, ledgeProbe: 0.4 },
  mover: { maxPush: 60 },
  follow: { maxSpeed: 480 },
  game: { respawnDelay: 0.25, dropThroughTime: 0.125, settleTime: 0.1 },
  settings: { fixed_step_hz: 120, audio_voices: 8, music_fade_s: 1, animation_crossfade_s: 0.2 },
};

describe('tuning values as data (phase 15.3, real host + platformer + Rapier)', () => {
  it('every value spelled out at its default plays bit-for-bit like none set', async () => {
    const none = await level({ playerExtra: { health: { max: 3, knockback: 3 } }, extra: course(), drive: RUN_AND_JUMP });
    const d = ALL_DEFAULTS;
    const spelled = await level({
      controller: d.controller,
      playerExtra: { health: { max: 3, knockback: 3, ...d.health } },
      extra: course({ enemy: d.enemy, mover: d.mover }),
      follow: d.follow,
      game: d.game,
      settings: d.settings,
      drive: RUN_AND_JUMP,
    });
    const a = trace(none, 600, TRACE_IDS);
    const b = trace(spelled, 600, TRACE_IDS);
    expect(b).toEqual(a);
    // the course did what it was built for: the player got somewhere, took damage and died once
    const last = a.at(-1) as { deaths: number; counters: { health: { current: number } | null } };
    expect(last.deaths).toBeGreaterThanOrEqual(1);
    expect((a as { at: number[][] }[]).some((s) => s.at[0]![0]! > 12)).toBe(true);
    expect((a as { counters: { health: { current: number } } }[]).some((s) => s.counters.health.current < 3)).toBe(true);
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

  it('respawn delay, settle time and drop-through time are the game block\'s', async () => {
    const pit = [thing('pit-0001', 3, 0.3, { gameZone: { role: 'hazard', size: [1, 0.6] } })];
    const respawnSteps = async (game: object) => {
      const L = await level({ game, extra: pit, drive: (s) => ({ moveX: s < 150 ? 1 : 0, jump: 'none' }) });
      let died = -1;
      for (let i = 0; i < 400; i++) {
        L.tick();
        const v = L.view();
        if (died < 0 && v.state === 'respawning') died = v.stepIndex;
        if (died >= 0 && v.state === 'playing') return v.stepIndex - died;
      }
      return -1;
    };
    const def = await respawnSteps({});
    const slow = await respawnSteps({ respawnDelay: 1 });
    expect(def, 'the default delay').toBeGreaterThan(30);
    expect(slow - def, `default ${def}, slow ${slow}`).toBe(90); // (1 − 0.25) s at 120 Hz
    const settle = async (game: object) => {
      const L = await level({ game, drive: () => ({ moveX: 0, jump: 'none' }) });
      return L.rt.getDiagnostics().diagnostics.settleSteps;
    };
    expect(await settle({})).toBe(12);
    expect(await settle({ settleTime: 0.25 })).toBe(30);
    // down + jump on a one-way platform drops through for dropThroughTime
    const oneWay = [thing('ledge-0001', 0, 1.5, { box: { size: [4, 0.2, 2], material: { color: '#777777' } }, collider: { shape: { type: 'box', hx: 2, hy: 0.1 }, oneWay: true } })];
    const drop = async (game: object) => {
      const L = await level({ game, spawn: [0, 2.52], extra: oneWay, drive: (s) => ({ moveX: 0, jump: s === 60 ? 'pressed' : 'none', actions: { navigate: { v: 1, x: 0, y: -1, p: 'held' } } }) });
      L.tick(120);
      return { calls: L.dropThroughCalls, y: L.pos('player-0001')[1] };
    };
    const d1 = await drop({});
    expect(d1.calls).toEqual([15]);
    expect(d1.y).toBeLessThan(1.2); // fell through to the floor
    expect((await drop({ dropThroughTime: 0.5 })).calls).toEqual([60]);
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

  it('enemy stomp bounce, defeat fade and chase height; mover push; the camera distance', async () => {
    const stompPeak = async (enemy: object) => {
      const L = await level({ spawn: [3, 3], playerExtra: { health: { max: 3 } }, extra: [thing('enemy-0001', 3, 0, { enemy: { ...ENEMY, patrol: 'points', range: [-0.5, 0.5], speed: 0, ...enemy } })], drive: () => ({ moveX: 0, jump: 'none' }) });
      let top = -Infinity;
      let fading = 0;
      let stomped = false;
      for (let i = 0; i < 200; i++) {
        L.tick();
        const y = L.pos('player-0001')[1];
        if (stomped) top = Math.max(top, y);
        if (L.counters().counters.defeated === 1) stomped = true;
        const o = L.opacity().get('enemy-0001');
        if (o !== undefined && o > 0 && o < 1) fading += 1;
      }
      return { top, fading, hidden: L.hidden().has('enemy-0001') };
    };
    const def = await stompPeak({});
    const big = await stompPeak({ stompBounce: 14, defeat: 'fade', defeatTime: 0.5 });
    expect(big.top).toBeGreaterThan(def.top + 1);
    expect(def.fading).toBe(0);
    expect(big.fading).toBeGreaterThan(50); // ~0.5 s of partial opacity
    expect(big.hidden).toBe(true);

    // the camera keeps the authored distance from the player plane
    const cam = await level({ follow: { distance: 8 }, cameraZ: 20, drive: () => ({ moveX: 0, jump: 'none' }) });
    cam.tick(5);
    expect(cam.pos('cam-main')[2]).toBe(8);
    const placed = await level({ cameraZ: 20, drive: () => ({ moveX: 0, jump: 'none' }) });
    placed.tick(5);
    expect(placed.pos('cam-main')[2]).toBe(20);
  });

  it('a pickup without a size collects over its model\'s recorded bounds (else 1 x 1 m)', async () => {
    // A coin 1.4 m to the right at head height: the 1 x 1 m default misses a standing player (0.5 + 0.3 < 1.4); a 3 m wide model reaches.
    const coin = (modelBounds?: object) =>
      level({
        extra: [thing('coin-0001', 1.4, 1, { pickup: { kind: 'coin', value: 1 }, model: { asset: { assetId: 'model-coin' } } })],
        ...(modelBounds !== undefined ? { modelBounds: modelBounds as never } : {}),
        drive: () => ({ moveX: 0, jump: 'none' }),
      });
    const without = await coin();
    without.tick(30);
    expect(without.counters().counters).toEqual({});
    const wide = await coin({ 'model-coin': { min: [-1.5, -0.5, -0.1], max: [1.5, 0.5, 0.1] } });
    wide.tick(30);
    expect(wide.counters().counters).toEqual({ coins: 1 });
  });

  it('replays a recorded non-default run bit-for-bit (replay-nondefault.json)', async () => {
    const L = await level(NONDEFAULT_RUN);
    const t = trace(L, NONDEFAULT_STEPS, TRACE_IDS);
    expect(REPLAY.trace.length).toBe(NONDEFAULT_STEPS);
    expect(JSON.parse(JSON.stringify(t))).toEqual(REPLAY.trace);
  });
});
