/**
 * Phase 9.9: the gameplay building blocks through the production composition
 * — the real game host, the platformer controller, Rapier physics — on small
 * v4 scenes (every game plays as a scene), driven by a scripted input source:
 * a moving platform carries the character, a one-way platform is jumped
 * through from below and stood on, a pressure plate opens a door, a lift
 * started by a trigger carries the character, a trigger sends its exit
 * signal, a circle trigger tests the capsule, a face-movement model child
 * faces where its parent goes, and a scene transition's spawn turns it.
 *
 * Phase 22.0: every case runs in both threading modes — the simulation in
 * the page and in the simulation worker (a Node worker thread running the
 * same game-host worker core as the browser bundles).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { MODES, startHarness, type Harness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

type Drive = (step: number) => { moveX: number; jump: 'none' | 'pressed' | 'held' | 'released' };

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.dispose();
});

/**
 * One scene: the character at `spawn`, a long floor, plus `extra` entities;
 * with `second`, a second scene (loaded by a scene transition) holding those
 * entities.
 */
async function makeLevel(mode: Mode, spawn: [number, number], extra: Any[], drive: Drive, second?: Any[]) {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: at(spawn[0], spawn[1]), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(spawn[0], spawn[1]), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(0, -0.5), box: { size: [80, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 40, hy: 0.5 } } } },
    ...extra,
  ];
  const scene = { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities };
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({
      entityId: e.id,
      shape: e.components.collider.shape,
      position: { x: e.components.transform.position[0], y: e.components.transform.position[1] },
      rotationZ: 0,
      ...(e.components.mover ? { kinematic: true } : {}),
      ...(e.components.collider.oneWay ? { oneWay: true } : {}),
    }));
  const input = {
    sample: (stepIndex: number) => ({ stepIndex, ...drive(stepIndex) }),
    sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
    markConfirmConsumed: () => undefined,
    dispose: () => undefined,
  };
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: 'blocks@r1',
      projectId: 'blocks',
      revision: 1,
      scene,
      ...(second !== undefined
        ? {
            scenes: [
              { sceneId: 'scene-main', start: true, entityIds: entities.map((e) => e.id) },
              { sceneId: 'scene-two', start: false },
            ],
          }
        : {}),
    },
    ...(second !== undefined
      ? {
          loadScene: async (sceneId: string) => {
            if (sceneId !== 'scene-two') throw new Error('unknown scene');
            return second;
          },
        }
      : {}),
    settings: SETTINGS,
    physics: {
      character: { x: spawn[0], y: spawn[1] },
      statics,
      solver: { hz: 120, gravityY: SETTINGS.gravity_y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    },
    input,
  });
  live.push(h);
  let now = 0;
  const rt: Any = h.rt;
  const tick = async (n = 1): Promise<void> => {
    for (let i = 0; i < n; i++) {
      now += DT;
      await h.tick(now);
    }
  };
  await tick(3);
  const pos = (id: string): [number, number] => {
    const t = rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === id);
    return [t.position[0], t.position[1]];
  };
  /** The run failed (a fail-stop) or logged an error. */
  const failed = (): boolean => {
    const d = rt.getDiagnostics();
    return !d.ok || d.diagnostics.failed === true || d.diagnostics.errors.length > 0;
  };
  return { rt, tick, pos, failed };
}

const box = (id: string, x: number, y: number, components: Record<string, unknown>) => ({ id, components: { transform: at(x, y), ...components } });

describe.each(MODES)('threading: %s', (mode) => {
const level = (spawn: [number, number], extra: Any[], drive: Drive, second?: Any[]) => makeLevel(mode, spawn, extra, drive, second);

describe('gameplay blocks (real host, platformer, Rapier)', () => {
  it('a moving platform carries the character standing on it', async () => {
    const platform = box('lift-0001', 10, 1, { box: { size: [2, 0.4, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 1, hy: 0.2 } }, mover: { waypoints: [[0, 3, 0]], speed: 1, mode: 'once' } });
    const L = await level([10, 2.2], [platform], () => ({ moveX: 0, jump: 'none' }));
    await L.tick(60);
    const startY = L.pos('player-0001')[1];
    const liftStart = L.pos('lift-0001')[1];
    await L.tick(240); // 2 s at 1 m/s: the lift rises 2 m
    const lift = L.pos('lift-0001')[1];
    expect(lift - liftStart).toBeGreaterThan(1.8);
    expect(L.pos('player-0001')[1] - startY).toBeGreaterThan(1.7);
    expect(L.pos('player-0001')[1] - lift).toBeGreaterThan(0.9); // still on top of it
  });

  it('a one-way platform is jumped through from below and stood on from above', async () => {
    // Jump apex: 8² / (2 · 20) = 1.6 m of feet height; the shelf top is at 1.3 m.
    const shelf = box('shelf-0001', 0, 1.2, { box: { size: [4, 0.2, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 2, hy: 0.1 }, oneWay: true } });
    // Start beside it, walk under, jump.
    const L = await level([-4, 0.91], [shelf], (s) => ({ moveX: s < 70 ? 1 : 0, jump: s >= 110 && s < 112 ? 'pressed' : s >= 110 && s < 160 ? 'held' : 'none' }));
    const start = L.pos('player-0001')[1];
    let peak = -Infinity;
    for (let i = 0; i < 320; i++) {
      await L.tick();
      peak = Math.max(peak, L.pos('player-0001')[1]);
    }
    expect(Math.abs(L.pos('player-0001')[0])).toBeLessThan(2); // it is over the shelf
    const y = L.pos('player-0001')[1];
    expect(start).toBeLessThan(1);
    expect(peak).toBeGreaterThan(2.3); // passed up through the shelf
    expect(y).toBeGreaterThan(2.1); // standing on it (top 1.3 + 0.9)
    expect(y).toBeLessThan(2.4);
  });

  it('a pressure plate opens a door (a mover waiting for the signal)', async () => {
    const plate = box('plate-0001', 3, 0.5, { switch: { mode: 'stand', signal: 'open', size: [1, 1] } });
    const door = box('door-0001', 8, 2, { box: { size: [0.6, 4, 2], material: { color: '#553311' } }, collider: { shape: { type: 'box', hx: 0.3, hy: 2 } }, mover: { waypoints: [[0, 4, 0]], speed: 4, mode: 'once', startOn: 'open' } });
    const L = await level([0, 0.91], [plate, door], () => ({ moveX: 0.5, jump: 'none' }));
    await L.tick(60);
    expect(L.pos('door-0001')[1]).toBeCloseTo(2, 3); // closed
    await L.tick(240);
    expect(L.pos('door-0001')[1]).toBeCloseTo(6, 3); // open
  });

  it('a lift started by a trigger carries a character who walks onto it from a one-way shelf', async () => {
    // The lift starts rising while the player is still stepping across its
    // edge (walking in short bursts, as a relay drives it): the player is
    // scooped up and carried — not pushed into the lift, not sliding on it.
    const shelf = box('shelf-0001', 14.5, 0.8, { box: { size: [3, 0.2, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 1.5, hy: 0.1 }, oneWay: true } });
    const lift = box('lift-0001', 17, 0.7, { box: { size: [2, 0.4, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 1, hy: 0.2 } }, mover: { waypoints: [[0, 2, 0]], speed: 2, mode: 'once', wait: 0.5, startOn: 'ride' } });
    const trigger = box('trig-0001', 17, 1.9, { trigger: { size: [1.6, 1.6], signal: 'ride' } });
    let walking = true;
    const L = await level([15, 1.85], [shelf, lift, trigger], (s) => ({ moveX: walking && s > 60 && s % 10 < 6 ? 1 : 0, jump: 'none' }));
    let stoppedAt = Number.NaN;
    for (let i = 0; i < 480; i++) {
      await L.tick();
      if (walking && L.pos('player-0001')[0] >= 16.9) {
        walking = false;
        stoppedAt = L.pos('player-0001')[0];
      }
    }
    expect(L.failed()).toBe(false);
    expect(L.pos('lift-0001')[1]).toBeCloseTo(2.7, 3);
    const [x, y] = L.pos('player-0001');
    expect(Math.abs(x - stoppedAt)).toBeLessThan(0.1); // no drift while carried
    expect(y).toBeGreaterThan(2.9 + 0.85); // standing on the lift's top (2.9)
    expect(y).toBeLessThan(2.9 + 0.95);
  });

  it('phase 9.13: a model child faces where its parent goes (the character, a patroller)', async () => {
    // (Phase 24.7: a left/right model reads as a velocity facer, offset yawRight − 90°.)
    const yawOf = (L: Any, id: string): number => {
      const t = L.rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === id);
      return (2 * Math.atan2(t.rotation[1], t.rotation[3]) * 180) / Math.PI;
    };
    const L = await level(
      [0, 0.91],
      [
        { id: 'look-0001', parentId: 'player-0001', components: { transform: at(0, 0), faceMovement: { yawRight: 90, yawLeft: -90, turnSeconds: 0.1 } } },
        box('walker-0001', 12, 0.4, { patrol: { mode: 'waypoints', waypoints: [[1, 0, 0], [-1, 0, 0]], speed: 2 } }),
        { id: 'snout-0001', parentId: 'walker-0001', components: { transform: at(0, 0), faceMovement: { yawRight: 90, yawLeft: -90, turnSeconds: 0.1 } } },
      ],
      (s) => ({ moveX: s < 100 ? 1 : -1, jump: 'none' }),
    );
    await L.tick(60);
    expect(yawOf(L, 'look-0001')).toBeCloseTo(90, 3);
    await L.tick(80);
    expect(yawOf(L, 'look-0001')).toBeCloseTo(-90, 3);
    // The patroller turns at each end of its path: both directions are seen.
    const seen = new Set<number>();
    for (let i = 0; i < 180; i++) {
      await L.tick();
      seen.add(Math.round(yawOf(L, 'snout-0001')));
    }
    expect(seen.has(90) && seen.has(-90)).toBe(true);
  });
});

describe('phase 15.2: a spawn says which way the character faces (on arrival)', () => {
  // Phase 24.7: only an arrival (a scene transition's spawn) applies a spawn's
  // facing; phase 24.8: the facing is the spawn's yaw. The character stands still in a
  // transition trigger and arrives, from rest, at a spawn in a second scene.
  const yawOf = (L: Any, id: string): number => {
    const t = L.rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === id);
    return (2 * Math.atan2(t.rotation[1], t.rotation[3]) * 180) / Math.PI;
  };
  const look = { id: 'look-0001', parentId: 'player-0001', components: { transform: at(0, 0), faceMovement: { yawRight: 90, yawLeft: -90, turnSeconds: 0.1 } } };
  const door = box('door-0001', 0, 1, { trigger: { size: [1, 2], signal: 'through', sceneTransition: { scene: 'scene-two', spawn: 'spawn-two' } } });
  /** Stand in the transition trigger; arrive at a spawn 6 m to the right carrying `marker`. */
  const arrive = async (marker: Record<string, unknown>) => {
    const L = await level([0, 0.91], [look, door], () => ({ moveX: 0, jump: 'none' }), [{ id: 'spawn-two', components: { transform: at(6, 0.91), playerSpawn: marker } }]);
    let arrived = false;
    for (let i = 0; i < 400 && !arrived; i++) {
      await L.tick();
      arrived = L.pos('player-0001')[0] > 5.9;
    }
    expect(arrived, 'arrived at the second scene\'s spawn').toBe(true);
    expect(L.failed()).toBe(false);
    return L;
  };

  it('a yaw of -90 or 90: the face-movement model is turned that way on arrival (the character stands still)', async () => {
    const left = await arrive({ yaw: -90 });
    expect(yawOf(left, 'look-0001')).toBeCloseTo(-90, 3);
    await left.tick(30);
    expect(yawOf(left, 'look-0001')).toBeCloseTo(-90, 3);
    const right = await arrive({ yaw: 90 });
    expect(yawOf(right, 'look-0001')).toBeCloseTo(90, 3);
    await right.tick(30);
    expect(yawOf(right, 'look-0001')).toBeCloseTo(90, 3);
  });

  it('no yaw: the model keeps its placed turn', async () => {
    const absent = await arrive({});
    await absent.tick(30);
    expect(yawOf(absent, 'look-0001')).toBeCloseTo(0, 3);
  });
});

describe('gameplay blocks: the 9.9 wrap-up additions', () => {
  it('a trigger emits its exit signal when the character leaves it', async () => {
    const trigger = box('trig-0001', 3, 1, { trigger: { size: [1, 2], signal: 'in', exitSignal: 'out' } });
    const door = box('door-0001', 12, 2, { box: { size: [0.6, 4, 2], material: { color: '#553311' } }, collider: { shape: { type: 'box', hx: 0.3, hy: 2 } }, mover: { waypoints: [[0, 4, 0]], speed: 8, mode: 'once', startOn: 'out' } });
    let x = 0;
    const L = await level([0, 0.91], [trigger, door], () => ({ moveX: x, jump: 'none' }));
    const run = (n: number): Promise<void> => L.tick(n);
    x = 0.5;
    // Walk into the trigger and stop inside it: the door stays shut.
    for (let i = 0; i < 600 && L.pos('player-0001')[0] < 3; i++) await run(1);
    x = 0;
    await run(60);
    expect(L.pos('door-0001')[1]).toBeCloseTo(2, 3);
    // Walk out of it: the exit signal opens the door.
    x = 1;
    await run(120);
    expect(L.pos('door-0001')[1]).toBeGreaterThan(5);
  });
});

describe('gameplay blocks: phase 14.2 circle triggers', () => {
  it('a circle trigger opens a door when the character walks into it (not while passing below it)', async () => {
    // A circle 2.9 m up with radius 0.5 (bottom at 2.4 m): the default capsule
    // (top at 1.81 m when standing) passes below it; the low one is walked through.
    const high = box('trig-0001', 3, 2.9, { trigger: { shape: 'circle', radius: 0.5, signal: 'hi' } });
    const low = box('trig-0002', 6, 1, { trigger: { shape: 'circle', radius: 0.4, signal: 'lo' } });
    const doorHi = box('door-0001', 14, 2, { box: { size: [0.6, 4, 2], material: { color: '#553311' } }, collider: { shape: { type: 'box', hx: 0.3, hy: 2 } }, mover: { waypoints: [[0, 4, 0]], speed: 8, mode: 'once', startOn: 'hi' } });
    const doorLo = box('door-0002', 12, 2, { box: { size: [0.6, 4, 2], material: { color: '#553311' } }, collider: { shape: { type: 'box', hx: 0.3, hy: 2 } }, mover: { waypoints: [[0, 4, 0]], speed: 8, mode: 'once', startOn: 'lo' } });
    const L = await level([0, 0.91], [high, low, doorHi, doorLo], () => ({ moveX: 1, jump: 'none' }));
    await L.tick(240);
    expect(L.pos('player-0001')[0]).toBeGreaterThan(7);
    expect(L.pos('door-0002')[1]).toBeGreaterThan(5); // walked through the low circle: open
    expect(L.pos('door-0001')[1]).toBeCloseTo(2, 3); // passed below the high one: shut
  });
});
});
