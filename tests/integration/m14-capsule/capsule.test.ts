/**
 * Phase 14.0: the player's collision capsule is data (`controller.capsule`)
 * and every system uses it — through the production composition (the real
 * game host, the platformer controller, Rapier physics), with the physics
 * init config built from the player entity as the hosts build it
 * (`playerCapsuleOf`):
 *
 * - a 1 m capsule walks under a 1.2 m ceiling that stops the default 1.8 m one;
 * - with its offset at half its height the entity origin is the feet: a spawn
 *   on the ground puts the feet on the ground (no float, no sink);
 * - pickups, stomps and hazard zones test the capsule's own size.
 */
import { describe, expect, it } from 'vitest';

import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { playerCapsuleOf } from '@thirdlight/runtime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

/** 1 m tall, 0.5 m wide, the entity origin at its feet (a small generic character). */
const SMALL_FEET = { capsule: { radius: 0.25, height: 1, offset: [0, 0.5] } };

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

/** One neutral level: a long floor (top at y = 0), the player at `spawn` with `controller`, plus `extra`. */
async function level(spawn: [number, number], controller: Record<string, unknown>, extra: Any[], drive: Drive, playerExtra: Record<string, unknown> = {}) {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(spawn[0], spawn[1]), controller, ...playerExtra } },
    { id: 'spawn-0001', components: { transform: at(spawn[0], spawn[1]), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(0, -0.5), box: { size: [80, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 40, hy: 0.5 } } } },
    { id: 'goal-0001', components: { transform: at(38, 1), gameZone: { role: 'goal', size: [1, 2] } } },
    ...extra,
  ];
  const scene = { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities };
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  // As the preview and export hosts do: the capsule comes from the player's controller.
  const capsule = playerCapsuleOf(controller);
  const physics = await createPhysicsPort({
    character: { x: spawn[0], y: spawn[1], radius: capsule.radius, halfHeight: capsule.halfHeight, offset: capsule.offset },
    statics,
    solver: { hz: 120, gravityY: SETTINGS.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  });
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  const input = {
    sample: (stepIndex: number) => ({ stepIndex, ...drive(stepIndex) }),
    sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
    markConfirmConsumed: () => undefined,
    dispose: () => undefined,
  };
  const audio: Any = createGameAudioOwner({ contextFactory: () => null } as Any);
  const host = createGameHost({
    snapshot: {
      snapshotId: 'capsule@r1',
      projectId: 'capsule',
      revision: 1,
      scene,
      game: { configVersion: 2, title: 'Capsule', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
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
  return { rt, tick, pos, view: () => rt.getGameView().view, counters: () => rt.gameCounters(), hidden: () => rt.hiddenEntities() as ReadonlySet<string> };
}

const thing = (id: string, x: number, y: number, components: Record<string, unknown>) => ({ id, components: { transform: at(x, y), ...components } });
/** A ceiling slab over x 3..5 whose underside is 1.2 m above the floor. */
const CEILING = thing('ceiling-0001', 4, 1.7, { box: { size: [2, 1, 2], material: { color: '#666666' } }, collider: { shape: { type: 'box', hx: 1, hy: 0.5 } } });
const right: Drive = () => ({ moveX: 1, jump: 'none' });
const still: Drive = () => ({ moveX: 0, jump: 'none' });

describe('the player capsule (real host, platformer, Rapier)', () => {
  it('a 1 m capsule walks under a 1.2 m ceiling that stops the default 1.8 m capsule', async () => {
    const tall = await level([0, 0.91], {}, [CEILING], right);
    tall.tick(240);
    expect(tall.pos('player-0001')[0]).toBeLessThan(3 - 0.3 + 0.001);
    const small = await level([0, 0.01], SMALL_FEET, [CEILING], right);
    small.tick(240);
    expect(small.pos('player-0001')[0]).toBeGreaterThan(6);
    expect(small.view().deathCount).toBe(0);
  });

  it('a spawn on the ground puts the feet on the ground; a respawn does too', async () => {
    // The spawn marker at y = 0.01 (the controller's skin above the floor): the origin is the feet.
    // Walk right into a ground-level hazard at x 4..5, then stand still: one death, one respawn.
    const L = await level([2, 0.01], SMALL_FEET, [thing('spikes-0001', 4.5, 0.2, { gameZone: { role: 'hazard', size: [1, 0.4] } })], (step) => ({ moveX: step < 90 ? 1 : 0, jump: 'none' }));
    L.tick(1);
    const [x0, y0] = L.pos('player-0001');
    expect(x0).toBeLessThan(2.1);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(y0).toBeLessThan(0.02);
    L.tick(240);
    expect(L.view().deathCount).toBe(1);
    const [x, y] = L.pos('player-0001');
    expect(x).toBeCloseTo(2, 6);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(0.02);
    // The default capsule at its old spawn height rests centred 0.91 m up (unchanged).
    const D = await level([2, 0.91], {}, [], still);
    D.tick(60);
    expect(D.pos('player-0001')[1]).toBeCloseTo(0.91, 2);
  });

  it('a pickup above the small capsule is not collected; the default capsule reaches it', async () => {
    // Coin box 1.1–1.9 m up at x = 3.
    const coin = thing('coin-0001', 3, 1.5, { pickup: { kind: 'coin', value: 1, size: [0.8, 0.8] } });
    const small = await level([0, 0.01], SMALL_FEET, [coin], right);
    small.tick(150);
    expect(small.pos('player-0001')[0]).toBeGreaterThan(4);
    expect(small.counters().counters).toEqual({});
    const tall = await level([0, 0.91], {}, [coin], right);
    tall.tick(150);
    expect(tall.counters().counters).toEqual({ coins: 1 });
  });

  it('a stomp tests the capsule feet (the origin with this offset), not a fixed 0.9 m below', async () => {
    const enemy = { patrol: 'points', range: [-0.5, 0.5], speed: 0, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 };
    const L = await level([3, 3], SMALL_FEET, [thing('enemy-0001', 3, 0, { enemy })], still, { health: { max: 3 } });
    let stomped = false;
    for (let i = 0; i < 120 && !stomped; i++) {
      L.tick();
      stomped = L.hidden().has('enemy-0001');
    }
    L.tick(30);
    expect(L.counters()).toEqual({ counters: { defeated: 1 }, health: { current: 3, max: 3 } });
  });

  it('a hazard above the small capsule does not kill it; the default capsule dies in it', async () => {
    // A hazard band 1.3–1.7 m up over x 3..5.
    const hazard = thing('hazard-0001', 4, 1.5, { gameZone: { role: 'hazard', size: [2, 0.4] } });
    const small = await level([0, 0.01], SMALL_FEET, [hazard], right);
    small.tick(240);
    expect(small.view().deathCount).toBe(0);
    expect(small.pos('player-0001')[0]).toBeGreaterThan(6);
    const tall = await level([0, 0.91], {}, [hazard], right);
    tall.tick(240);
    expect(tall.view().deathCount).toBeGreaterThanOrEqual(1);
  });
});
