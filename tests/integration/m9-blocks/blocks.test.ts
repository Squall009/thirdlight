/**
 * Phase 9.9: the gameplay building blocks through the production composition
 * — the real game host, the platformer controller, Rapier physics — on small
 * v4 levels, driven by a scripted input source:
 * pickups count and disappear, an enemy hurts on contact and is stomped from
 * above, a moving platform carries the player, a one-way platform is jumped
 * through from below and stood on, a pressure plate opens a door, a damaging
 * hazard takes health instead of a life.
 */
import { describe, expect, it } from 'vitest';

import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

class FakeNode {
  textContent = '';
  children: Any[] = [];
  appendChild(c: Any): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

type Drive = (step: number) => { moveX: number; jump: 'none' | 'pressed' | 'held' | 'released' };

/** One level: the player at `spawn`, a long floor, a goal far away, plus `extra` entities. */
async function level(spawn: [number, number], extra: Any[], drive: Drive, playerExtra: Record<string, unknown> = {}) {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(spawn[0], spawn[1]), controller: {}, ...playerExtra } },
    { id: 'spawn-0001', components: { transform: at(spawn[0], spawn[1]), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(0, -0.5), box: { size: [80, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 40, hy: 0.5 } } } },
    { id: 'goal-0001', components: { transform: at(38, 1), gameZone: { role: 'goal', size: [1, 2] } } },
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
  const physics = await createPhysicsPort({
    character: { x: spawn[0], y: spawn[1] },
    statics,
    solver: { hz: 120, gravityY: SETTINGS.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  } as Any);
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  const input = {
    sample: (stepIndex: number) => ({ stepIndex, ...drive(stepIndex) }),
    sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
    markConfirmConsumed: () => undefined,
    dispose: () => undefined,
  };
  // The sounds the host plays (ctx.audio and pickup cues), recorded.
  const sounds: string[] = [];
  const audio: Any = createGameAudioOwner({ contextFactory: () => null } as Any);
  audio.playSound = (assetId: string) => sounds.push(assetId);
  const host = createGameHost({
    snapshot: {
      snapshotId: 'blocks@r1',
      projectId: 'blocks',
      revision: 1,
      scene,
      game: { configVersion: 2, title: 'Blocks', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
    },
    settings: SETTINGS,
    physics: physics.port,
    adapter: () => null,
    input,
    audio,
    readArtifact: async () => new ArrayBuffer(0),
    container: new FakeNode(),
    buildId: 'b',
    assetPaths: {},
    document: { createElement: () => new FakeNode() },
  } as Any);
  const mounted = host.mount();
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
  let now = 0;
  const rt: Any = host.runtime;
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += DT;
      const r = rt.tick(now);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    }
  };
  tick();
  const started = rt.gameCommand('start');
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  tick(2);
  const pos = (id: string): [number, number] => {
    const t = rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === id);
    return [t.position[0], t.position[1]];
  };
  return { rt, tick, pos, sounds, view: () => rt.getGameView().view, counters: () => rt.gameCounters(), hidden: () => rt.hiddenEntities() as ReadonlySet<string> };
}

const box = (id: string, x: number, y: number, components: Record<string, unknown>) => ({ id, components: { transform: at(x, y), ...components } });

describe('gameplay blocks (real host, platformer, Rapier)', () => {
  it('pickups add to counters and disappear; a heart heals', async () => {
    const L = await level([0, 0.91], [
      box('coin-0001', 2, 0.9, { pickup: { kind: 'coin', value: 1 } }),
      box('coin-0002', 3, 0.9, { pickup: { kind: 'coin', value: 1 } }),
      box('gem-0001', 4, 0.9, { pickup: { kind: 'gem', value: 5 } }),
      box('key-0001', 5, 0.9, { pickup: { kind: 'custom', counter: 'stars', value: 2 } }),
    ], () => ({ moveX: 1, jump: 'none' }));
    L.tick(180);
    expect(L.counters().counters).toEqual({ coins: 2, gems: 5, stars: 2 });
    expect([...L.hidden()].sort()).toEqual(['coin-0001', 'coin-0002', 'gem-0001', 'key-0001']);
  });

  it('an enemy hurts on contact (health, invulnerability, bounce) and is stomped from above', async () => {
    const enemy = { patrol: 'points', range: [-0.5, 0.5], speed: 0, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 };
    // Walk into it: one hit (invulnerable afterwards), health 3 → 2.
    const walk = await level([0, 0.91], [box('enemy-0001', 3, 0, { enemy })], () => ({ moveX: 1, jump: 'none' }), { health: { max: 3, invulnerableSeconds: 2 } });
    walk.tick(90);
    expect(walk.counters().health).toEqual({ current: 2, max: 3 });
    expect(walk.view().deathCount).toBe(0);
    // Drop on it from above: stomped (hidden, counted), the player bounces up.
    const stomp = await level([3, 3], [box('enemy-0001', 3, 0, { enemy })], () => ({ moveX: 0, jump: 'none' }), { health: { max: 3 } });
    let peakAfter = -Infinity;
    let stomped = -1;
    for (let i = 0; i < 120; i++) {
      stomp.tick();
      if (stomped < 0 && stomp.hidden().has('enemy-0001')) stomped = i;
      if (stomped >= 0 && i > stomped) peakAfter = Math.max(peakAfter, stomp.pos('player-0001')[1]);
    }
    expect(stomped).toBeGreaterThan(0);
    expect(stomp.counters()).toEqual({ counters: { defeated: 1 }, health: { current: 3, max: 3 } });
    expect(peakAfter).toBeGreaterThan(2.2); // bounced back up above the enemy's top
  });

  it('without a health component an enemy touch is a death (as hazards are)', async () => {
    const L = await level([0, 0.91], [box('enemy-0001', 3, 0, { enemy: { patrol: 'points', range: [-0.5, 0.5], speed: 0, size: [0.8, 0.8], contactDamage: 1, stompable: false, health: 1 } })], () => ({ moveX: 1, jump: 'none' }));
    L.tick(90);
    expect(L.view().deathCount).toBe(1);
  });

  it('a moving platform carries the player standing on it', async () => {
    const platform = box('lift-0001', 10, 1, { box: { size: [2, 0.4, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 1, hy: 0.2 } }, mover: { waypoints: [[0, 3, 0]], speed: 1, mode: 'once' } });
    const L = await level([10, 2.2], [platform], () => ({ moveX: 0, jump: 'none' }));
    L.tick(60);
    const startY = L.pos('player-0001')[1];
    const liftStart = L.pos('lift-0001')[1];
    L.tick(240); // 2 s at 1 m/s: the lift rises 2 m
    const lift = L.pos('lift-0001')[1];
    expect(lift - liftStart).toBeGreaterThan(1.8);
    expect(L.pos('player-0001')[1] - startY).toBeGreaterThan(1.7);
    expect(L.pos('player-0001')[1] - lift).toBeGreaterThan(0.9); // still on top of it
  });

  it('a one-way platform is jumped through from below and stood on from above', async () => {
    // Jump apex: 8² / (2 · 20) = 1.6 m of feet height; the shelf top is at 1.3 m.
    const shelf = box('shelf-0001', 0, 1.2, { box: { size: [4, 0.2, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 2, hy: 0.1 }, oneWay: true } });
    // Start beside it (a spawn under a one-way platform counts as blocked), walk under, jump.
    const L = await level([-4, 0.91], [shelf], (s) => ({ moveX: s < 70 ? 1 : 0, jump: s >= 110 && s < 112 ? 'pressed' : s >= 110 && s < 160 ? 'held' : 'none' }));
    const start = L.pos('player-0001')[1];
    let peak = -Infinity;
    for (let i = 0; i < 320; i++) {
      L.tick();
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
    L.tick(60);
    expect(L.pos('door-0001')[1]).toBeCloseTo(2, 3); // closed
    L.tick(240);
    expect(L.pos('door-0001')[1]).toBeCloseTo(6, 3); // open
  });

  it('a lift started by a trigger carries a player who walks onto it from a one-way shelf', async () => {
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
      L.tick();
      if (walking && L.pos('player-0001')[0] >= 16.9) {
        walking = false;
        stoppedAt = L.pos('player-0001')[0];
      }
    }
    expect(L.view().failed).toBe(false);
    expect(L.pos('lift-0001')[1]).toBeCloseTo(2.7, 3);
    const [x, y] = L.pos('player-0001');
    expect(Math.abs(x - stoppedAt)).toBeLessThan(0.1); // no drift while carried
    expect(y).toBeGreaterThan(2.9 + 0.85); // standing on the lift's top (2.9)
    expect(y).toBeLessThan(2.9 + 0.95);
  });

  it('a damaging hazard takes health; at zero it is a death', async () => {
    const lava = box('lava-0001', 3, 0.5, { gameZone: { role: 'hazard', size: [1, 1], damage: 1 } });
    const L = await level([0, 0.91], [lava], () => ({ moveX: 0.5, jump: 'none' }), { health: { max: 2, invulnerableSeconds: 0.5 } });
    L.tick(150);
    expect(L.counters().health!.current).toBeLessThan(2);
    L.tick(360);
    expect(L.view().deathCount).toBeGreaterThanOrEqual(1);
  });

  it('phase 9.13: a model child faces where its parent goes (the player, a patrolling enemy)', async () => {
    const yawOf = (L: Any, id: string): number => {
      const t = L.rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === id);
      return (2 * Math.atan2(t.rotation[1], t.rotation[3]) * 180) / Math.PI;
    };
    const L = await level(
      [0, 0.91],
      [
        { id: 'look-0001', parentId: 'player-0001', components: { transform: at(0, 0), faceMovement: { yawRight: 90, yawLeft: -90, turnSeconds: 0.1 } } },
        box('enemy-0001', 12, 0, { enemy: { patrol: 'points', range: [-1, 1], speed: 2, size: [0.8, 0.8], contactDamage: 0, stompable: false, health: 1 } }),
        { id: 'snout-0001', parentId: 'enemy-0001', components: { transform: at(0, 0), faceMovement: { yawRight: 90, yawLeft: -90, turnSeconds: 0.1 } } },
      ],
      (s) => ({ moveX: s < 100 ? 1 : -1, jump: 'none' }),
    );
    L.tick(60);
    expect(yawOf(L, 'look-0001')).toBeCloseTo(90, 3);
    L.tick(80);
    expect(yawOf(L, 'look-0001')).toBeCloseTo(-90, 3);
    // The enemy turns at each end of its patrol: both directions are seen.
    const seen = new Set<number>();
    for (let i = 0; i < 180; i++) {
      L.tick();
      seen.add(Math.round(yawOf(L, 'snout-0001')));
    }
    expect(seen.has(90) && seen.has(-90)).toBe(true);
  });
});

describe('gameplay blocks: the 9.9 wrap-up additions', () => {
  it('a chasing enemy walks toward the player in range; a patrolling one does not', async () => {
    const enemy = { patrol: 'points', range: [-4, 4], speed: 1, size: [0.8, 0.8], contactDamage: 0, stompable: true, health: 1 };
    const still = () => ({ moveX: 0, jump: 'none' as const });
    const chaser = await level([0, 0.91], [box('enemy-0001', 5, 0, { enemy: { ...enemy, chase: 6 } })], still);
    const walker = await level([0, 0.91], [box('enemy-0001', 5, 0, { enemy })], still);
    chaser.tick(120);
    walker.tick(120);
    expect(chaser.pos('enemy-0001')[0]).toBeLessThan(4.2); // one second toward the player
    expect(walker.pos('enemy-0001')[0]).toBeGreaterThan(5.8); // patrols right first
  });

  it('a stomped enemy squashes toward its feet, then disappears', async () => {
    const enemy = { patrol: 'points', range: [-0.5, 0.5], speed: 0, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 };
    const L = await level([3, 3], [box('enemy-0001', 3, 0, { enemy })], () => ({ moveX: 0, jump: 'none' }), { health: { max: 3 } });
    const scaleY = (): number => L.rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === 'enemy-0001').scale[1];
    let squashed = Infinity;
    for (let i = 0; i < 120 && !L.hidden().has('enemy-0001'); i++) {
      L.tick();
      if (L.counters().counters['defeated'] === 1) squashed = Math.min(squashed, scaleY());
    }
    expect(L.counters().counters['defeated']).toBe(1);
    expect(squashed).toBeLessThan(0.5);
    expect(L.hidden().has('enemy-0001')).toBe(true);
  });

  it('a hit with knockback pushes the player away; health starts at `start`', async () => {
    const enemy = { patrol: 'points', range: [-0.5, 0.5], speed: 0, size: [0.8, 0.8], contactDamage: 1, stompable: false, health: 1 };
    const walkIn = (s: number) => ({ moveX: s < 40 ? 1 : 0, jump: 'none' as const });
    const soft = await level([0, 0.91], [box('enemy-0001', 1.6, 0, { enemy })], walkIn, { health: { max: 5, start: 3, invulnerableSeconds: 2 } });
    const hard = await level([0, 0.91], [box('enemy-0001', 1.6, 0, { enemy })], walkIn, { health: { max: 5, start: 3, invulnerableSeconds: 2, knockback: 8 } });
    soft.tick(120);
    hard.tick(120);
    expect(soft.counters().health).toEqual({ current: 2, max: 5 });
    expect(hard.counters().health).toEqual({ current: 2, max: 5 });
    expect(soft.pos('player-0001')[0] - hard.pos('player-0001')[0]).toBeGreaterThan(1); // pushed back ~2 m
  });

  it('a trigger emits its exit signal when the player leaves it; a pickup plays its cue', async () => {
    const trigger = box('trig-0001', 3, 1, { trigger: { size: [1, 2], signal: 'in', exitSignal: 'out' } });
    const door = box('door-0001', 12, 2, { box: { size: [0.6, 4, 2], material: { color: '#553311' } }, collider: { shape: { type: 'box', hx: 0.3, hy: 2 } }, mover: { waypoints: [[0, 4, 0]], speed: 8, mode: 'once', startOn: 'out' } });
    const coin = box('coin-0001', 2, 0.9, { pickup: { kind: 'coin', value: 1, cue: 'asset-ding' } });
    let x = 0;
    const L = await level([0, 0.91], [trigger, door, coin], () => ({ moveX: x, jump: 'none' }));
    const run = (n: number): void => L.tick(n);
    x = 0.5;
    // Walk into the trigger and stop inside it: the door stays shut.
    for (let i = 0; i < 600 && L.pos('player-0001')[0] < 3; i++) run(1);
    x = 0;
    run(60);
    expect(L.pos('door-0001')[1]).toBeCloseTo(2, 3);
    expect(L.sounds).toEqual(['asset-ding']);
    // Walk out of it: the exit signal opens the door.
    x = 1;
    run(120);
    expect(L.pos('door-0001')[1]).toBeGreaterThan(5);
  });
});

describe('gameplay blocks: phase 14.2 circle triggers', () => {
  it('a circle trigger opens a door when the player walks into it (not while passing below it)', async () => {
    // A circle 2.9 m up with radius 0.5 (bottom at 2.4 m): the default capsule
    // (top at 1.81 m when standing) passes below it; the low one is walked through.
    const high = box('trig-0001', 3, 2.9, { trigger: { shape: 'circle', radius: 0.5, signal: 'hi' } });
    const low = box('trig-0002', 6, 1, { trigger: { shape: 'circle', radius: 0.4, signal: 'lo' } });
    const doorHi = box('door-0001', 14, 2, { box: { size: [0.6, 4, 2], material: { color: '#553311' } }, collider: { shape: { type: 'box', hx: 0.3, hy: 2 } }, mover: { waypoints: [[0, 4, 0]], speed: 8, mode: 'once', startOn: 'hi' } });
    const doorLo = box('door-0002', 12, 2, { box: { size: [0.6, 4, 2], material: { color: '#553311' } }, collider: { shape: { type: 'box', hx: 0.3, hy: 2 } }, mover: { waypoints: [[0, 4, 0]], speed: 8, mode: 'once', startOn: 'lo' } });
    const L = await level([0, 0.91], [high, low, doorHi, doorLo], () => ({ moveX: 1, jump: 'none' }));
    L.tick(240);
    expect(L.pos('player-0001')[0]).toBeGreaterThan(7);
    expect(L.pos('door-0002')[1]).toBeGreaterThan(5); // walked through the low circle: open
    expect(L.pos('door-0001')[1]).toBeCloseTo(2, 3); // passed below the high one: shut
  });
});
