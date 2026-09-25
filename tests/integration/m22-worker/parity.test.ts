/**
 * Phase 22.0: the simulation worker computes exactly what the page computes.
 *
 * A neutral level with most of the simulation's moving parts — the player
 * controller on Rapier, pickups, a patrolling stompable enemy, a moving
 * platform, a one-way shelf, a checkpoint, a pressure plate and a door, and a
 * script that spawns coins on a timer, plays sounds and reads the input — is
 * run twice through the production game host: once in the page (single
 * thread) and once in the simulation worker (a Node worker thread with the
 * same game-host worker core the browser bundles run). The same inputs go in;
 * a digest of every executed step's committed state (the game view, every
 * transform bit for bit, counters, hidden entities, the scene set, the save
 * state) must be identical at every step.
 *
 * - replay: a recorded input (per step) with frames of 0–3 steps each;
 * - live input: a per-step input function, one step per frame (the bot path);
 * - 22.3: the worker frees the simulation on dispose (acknowledged), and a
 *   physics memory past the limit stops the simulation instead of growing.
 */
import { describe, expect, it } from 'vitest';

import { startRemoteSimulation } from '@thirdlight/game-host';

import { behaviorModule, startHarness, startNodeSimWorker, type Harness, type Mode } from './harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const box = (id: string, x: number, y: number, components: Record<string, unknown>) => ({ id, components: { transform: at(x, y), ...components } });

const PREFABS = [{ prefabId: 'coin', displayName: 'Coin', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0002', components: { transform: at(0, 0), box: { size: [0.4, 0.4, 0.1], material: { color: '#ffcc00' } }, pickup: { kind: 'coin', value: 1, size: [0.6, 0.6] } } }] }];

/** A script: a coin ahead of the player every 0.75 s (at most 6), a sound on each, a sound on every jump press. */
const DIRECTOR = `
export default {
  instantiate() { return { made: 0 }; },
  step(state, ctx) {
    ctx.timers.every('drop', 0.75);
    if (ctx.timers.fired('drop') && state.made < 6 && ctx.spawn) {
      ctx.spawn('coin', { position: [4 + state.made * 3, 1.2] });
      state.made += 1;
      ctx.audio && ctx.audio.play('asset-drop', { volume: 0.5 });
    }
    if (ctx.action.jump === 'pressed') ctx.audio && ctx.audio.play('asset-hop');
  },
};
`;

function level(): { snapshot: Any; physics: Any } {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(0, 0.91), controller: {}, health: { max: 3, invulnerableSeconds: 1 } } },
    { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
    box('floor-0001', 20, -0.5, { box: { size: [80, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 40, hy: 0.5 } } }),
    box('goal-0001', 58, 1, { gameZone: { role: 'goal', size: [1, 2] } }),
    box('cp-0001', 14, 1, { gameZone: { role: 'checkpoint', size: [1, 2], safeSpawnId: 'spawn-0002', activation: { emissive: '#1bc8ff', emissiveIntensity: 1, cueAssetId: null } } }),
    { id: 'spawn-0002', components: { transform: at(14, 0.91), playerSpawn: {} } },
    box('coin-0001', 2, 0.9, { pickup: { kind: 'coin', value: 1 } }),
    box('gem-0001', 9, 2.2, { pickup: { kind: 'gem', value: 5 } }),
    box('enemy-0001', 11, 0, { enemy: { patrol: 'points', range: [-1.5, 1.5], speed: 1.5, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 } }),
    box('lift-0001', 20, 0.4, { box: { size: [2, 0.4, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 1, hy: 0.2 } }, mover: { waypoints: [[0, 1.5, 0]], speed: 1, mode: 'pingpong' } }),
    box('shelf-0001', 26, 1.2, { box: { size: [4, 0.2, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 2, hy: 0.1 }, oneWay: true } }),
    box('plate-0001', 30, 0.5, { switch: { mode: 'stand', signal: 'open', size: [1, 1] } }),
    box('door-0001', 34, 2, { box: { size: [0.6, 4, 2], material: { color: '#553311' } }, collider: { shape: { type: 'box', hx: 0.3, hy: 2 } }, mover: { waypoints: [[0, 4, 0]], speed: 4, mode: 'once', startOn: 'open' } }),
    box('box-director', 0, -5, { box: { size: [0.2, 0.2, 0.2], material: { color: '#ffffff' } }, behavior: { behaviorId: 'director', values: {} } }),
  ];
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0, ...(e.components.mover ? { kinematic: true } : {}), ...(e.components.collider.oneWay ? { oneWay: true } : {}) }));
  return {
    snapshot: {
      snapshotId: 'parity@r1',
      projectId: 'parity',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
      game: { configVersion: 2, title: 'Parity', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
      prefabs: PREFABS,
    },
    physics: {
      character: { x: 0, y: 0.91 },
      statics,
      solver: { hz: HZ, gravityY: SETTINGS.gravity_y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    },
  };
}

/** A varied but valid input: runs right with pauses and turns, jumps (pressed → held … → released) now and then. */
function driveAt(s: number): { moveX: number; jump: 'none' | 'pressed' | 'held' | 'released' } {
  const moveX = s % 700 < 40 ? 0 : s % 500 < 30 ? -0.5 : s % 90 < 10 ? 0.3 : 1;
  // A valid jump chain: none → pressed → held* → released → none, a short or a long hold.
  const k = s % 150;
  const release = Math.floor(s / 150) % 3 === 0 ? 72 : 100;
  const jump = k === 60 ? 'pressed' : k > 60 && k < release ? 'held' : k === release ? 'released' : 'none';
  return { moveX, jump };
}

const RECORD_STEPS = 1500;
function recording(from: number): Any[] {
  const frames: Any[] = [];
  for (let s = from; s < from + RECORD_STEPS; s += 1) frames.push({ stepIndex: s, ...driveAt(s) });
  return frames;
}

/** Frame lengths in steps (0–3; a 0 is a display frame shorter than a step). */
const PATTERN = [1, 2, 1, 0, 3, 1, 1, 2, 0, 1];

async function run(mode: Mode, opts: { replay: boolean; varied: boolean }): Promise<{ h: Harness; digests: string[]; end: Any }> {
  const { snapshot, physics } = level();
  const h = await startHarness(mode, {
    snapshot,
    settings: SETTINGS,
    physics,
    behaviors: [behaviorModule('director', DIRECTOR)],
    digestSteps: true,
    ...(opts.replay
      ? { replay: recording(0) }
      : {
          input: {
            sample: (stepIndex: number) => ({ stepIndex, ...driveAt(stepIndex) }),
            sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
            markConfirmConsumed: () => undefined,
            dispose: () => undefined,
          },
        }),
  });
  let now = 10;
  await h.tick(now); // the settle pre-roll
  const started = h.host.control('start');
  if (!started.ok) throw new Error(JSON.stringify(started.error) + JSON.stringify(h.rt.getDiagnostics().diagnostics.errors));
  let i = 0;
  while (h.digests.length < 1200) {
    const steps = opts.varied ? PATTERN[i++ % PATTERN.length]! : 1;
    // A frame of `steps` steps (plus a sub-step remainder, so alphas differ too).
    now += steps * DT + (opts.varied ? DT * 0.25 * ((i % 3) - 1) * 0.5 : 0);
    await h.tick(now);
  }
  const obs = h.host.observe();
  const end = {
    obs: obs.ok ? { ...obs.observation, sound: null } : obs,
    counters: h.rt.gameCounters(),
    hidden: [...h.rt.hiddenEntities()].sort(),
    spawned: h.rt.sceneSet().spawned.map((e: Any) => e.id),
    player: h.rt.getInterpolatedState().state.transforms.find((t: Any) => t.id === 'player-0001'),
    sounds: [...h.sounds],
  };
  return { h, digests: [...h.digests], end };
}

describe('phase 22.0: identical results in the page and in the simulation worker', () => {
  it('a recorded replay: every step digest is equal (frames of 0–3 steps)', async () => {
    const a = await run('single', { replay: true, varied: true });
    const b = await run('worker', { replay: true, varied: true });
    try {
      expect(a.digests.length).toBeGreaterThanOrEqual(1200);
      // Every step changes the committed state (the digest is not a constant).
      expect(new Set(a.digests).size).toBeGreaterThan(1000);
      const n = Math.min(a.digests.length, b.digests.length);
      const firstDiff = a.digests.slice(0, n).findIndex((d, k) => d !== b.digests[k]);
      expect(firstDiff, `first differing step ${firstDiff}`).toBe(-1);
      expect(b.end).toEqual(a.end);
      // The run did exercise the moving parts.
      expect(a.end.counters.counters['coins']).toBeGreaterThan(0);
      expect(a.end.spawned.length).toBeGreaterThan(0);
      expect(a.end.sounds).toContain('asset-drop');
      expect(a.end.sounds).toContain('asset-hop');
    } finally {
      await a.h.dispose();
      await b.h.dispose();
    }
  }, 120_000);

  it('live input, one step per frame (the bot path): every step digest is equal', async () => {
    const a = await run('single', { replay: false, varied: false });
    const b = await run('worker', { replay: false, varied: false });
    try {
      const n = Math.min(a.digests.length, b.digests.length);
      expect(n).toBeGreaterThanOrEqual(1200);
      const firstDiff = a.digests.slice(0, n).findIndex((d, k) => d !== b.digests[k]);
      expect(firstDiff, `first differing step ${firstDiff}`).toBe(-1);
      expect(b.end).toEqual(a.end);
    } finally {
      await a.h.dispose();
      await b.h.dispose();
    }
  }, 120_000);
});

describe('phase 22.3: physics in the worker', () => {
  it('dispose frees the simulation in the worker (acknowledged before the worker ends)', async () => {
    const { snapshot, physics } = level();
    const worker = await startNodeSimWorker();
    const remote = await startRemoteSimulation({ worker, init: { snapshot, settings: SETTINGS, physics, behaviors: { rows: [], urls: {}, enginePins: [] } }, input: null, driver: 'manual' });
    remote.runtimeFactory(() => undefined);
    await remote.tick(1);
    await remote.tick(1 + DT);
    const t0 = Date.now();
    await remote.dispose();
    // The worker answered `disposed` (runtime + Rapier world freed) well before the 2 s fallback.
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(remote.runtime.getInterpolatedState().ok).toBe(false);
  }, 60_000);

  it('a physics memory past the limit stops the simulation (it never grows without bound)', async () => {
    const { snapshot, physics } = level();
    const worker = await startNodeSimWorker();
    const logs: string[] = [];
    const remote = await startRemoteSimulation({ worker, init: { snapshot, settings: SETTINGS, physics, behaviors: { rows: [], urls: {}, enginePins: [] }, memoryCapBytes: 1 }, input: null, driver: 'manual', log: (_l, m) => logs.push(m) });
    remote.runtimeFactory(() => undefined);
    await remote.tick(1);
    expect(remote.failure?.code).toBe('physics_memory_limit');
    const step = remote.runtime.getDiagnostics();
    await remote.tick(2);
    expect(remote.runtime.getDiagnostics().ok && step.ok && remote.runtime.getDiagnostics().ok).toBe(true);
    // Stopped: no more steps.
    const d1 = remote.runtime.getDiagnostics();
    await remote.tick(3);
    const d2 = remote.runtime.getDiagnostics();
    expect(d1.ok && d2.ok && d2.diagnostics.stepIndex).toBe(d1.ok ? d1.diagnostics.stepIndex : -1);
    expect(logs.some((l) => l.includes('physics_memory_limit') || l.includes('past the'))).toBe(true);
    await remote.dispose();
  }, 60_000);
});
