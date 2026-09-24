/**
 * Phase 14.7: physics fixes through the production composition (the real
 * game host, the platformer controller, Rapier) on small neutral v4 levels.
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

/** One level: the player at `spawn`, a long floor (top at y = 0), a goal far away, plus `extra` entities. */
async function level(spawn: [number, number], extra: Any[], drive: Drive, playerAt: [number, number] = spawn) {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(playerAt[0], playerAt[1]), controller: {} } },
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
    character: { x: playerAt[0], y: playerAt[1] },
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
  const audio: Any = createGameAudioOwner({ contextFactory: () => null } as Any);
  const host = createGameHost({
    snapshot: {
      snapshotId: 'physics@r1',
      projectId: 'physics',
      revision: 1,
      scene,
      game: { configVersion: 2, title: 'Physics', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
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
  if (!mounted.ok) return { mounted } as Any;
  let now = 0;
  const rt: Any = host.runtime;
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += DT;
      const r = rt.tick(now);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    }
  };
  // The start (and its spawn clearance) may fail: that result is returned, not thrown.
  now += DT;
  const first = rt.tick(now);
  const started = first.ok ? rt.gameCommand('start') : first;
  for (let i = 0; i < 2 && started.ok; i++) {
    now += DT;
    rt.tick(now); // a failed start reset shows in the view, checked by the test
  }
  const pos = (id: string): [number, number] => {
    const t = rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === id);
    return [t.position[0], t.position[1]];
  };
  return { mounted, started, rt, tick, pos, view: () => rt.getGameView().view };
}

const box = (id: string, x: number, y: number, components: Record<string, unknown>) => ({ id, components: { transform: at(x, y), ...components } });

/** On the floor the capsule's centre rests at 0.91 (half height 0.9 + the controller's skin). */
const REST_Y = 0.91;

describe('phase 14.7: a mover rising beside the player', () => {
  // A switch-opened gate: a pressure plate right in front of a 3 m gate (0.5 m
  // thick, left face at x = 5.75) that rises 3.2 m with an eased start. The
  // player walks right the whole time: it steps on the plate, reaches the gate
  // while it is still low and keeps pressing against it as it rises. Two gate
  // colliders: a box centred on the entity and a polygon standing on its
  // origin (as a model's collider is authored).
  const gates = {
    box: { y: 1.5, bottom: -1.5, collider: { shape: { type: 'box', hx: 0.25, hy: 1.5 } } },
    polygon: { y: 0, bottom: 0, collider: { shape: { type: 'polygon', vertices: [[-0.25, 0], [0.25, 0], [0.25, 3], [-0.25, 3]] } } },
  } as const;
  for (const [name, g] of Object.entries(gates)) {
    it(`pressing against a rising gate (${name} collider) never lifts the player; it walks on under the open gate`, async () => {
      const plate = box('plate-0001', 5.2, 0, { switch: { mode: 'stand', signal: 'open', size: [1, 0.8], once: true } });
      const gate = box('gate-0001', 6, g.y, { collider: g.collider, mover: { waypoints: [[0, 3.2, 0]], speed: 3.5, mode: 'once', startOn: 'open', easing: 'smooth' } });
      const L = await level([0, REST_Y], [plate, gate], () => ({ moveX: 1, jump: 'none' }));
      expect(L.started.ok).toBe(true);
      let maxY = -Infinity;
      let pressed = 0;
      for (let i = 0; i < 360; i++) {
        L.tick();
        const [x, y] = L.pos('player-0001');
        const gateBottom = L.pos('gate-0001')[1] + g.bottom;
        maxY = Math.max(maxY, y);
        if (gateBottom < y + 0.6) {
          // The gate's lower edge is beside the capsule's straight side: the player stays outside it.
          expect(x).toBeLessThan(5.75 - 0.3 + 1e-3);
          if (gateBottom > 0.05 && x > 5.75 - 0.3 - 0.02) pressed += 1;
        }
      }
      expect(pressed).toBeGreaterThan(10); // it really pressed against the rising gate
      expect(maxY).toBeLessThan(REST_Y + 0.01); // never lifted
      expect(L.view().failed).toBe(false);
      expect(L.pos('player-0001')[0]).toBeGreaterThan(8); // through the open gate
    });
  }

  it('a player standing on a rising block is still carried up', async () => {
    const block = box('block-0001', 3, 0.5, { box: { size: [2, 1, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 1, hy: 0.5 } }, mover: { waypoints: [[0, 2, 0]], speed: 1, mode: 'once', startOn: 'up' } });
    const plate = box('plate-0001', 3, 1.4, { switch: { mode: 'stand', signal: 'up', size: [1, 0.8] } });
    const L = await level([3, 1 + REST_Y], [block, plate], () => ({ moveX: 0, jump: 'none' }));
    expect(L.started.ok).toBe(true);
    L.tick(360);
    expect(L.pos('block-0001')[1]).toBeCloseTo(2.5, 3);
    const y = L.pos('player-0001')[1];
    expect(y).toBeGreaterThan(3 + 0.85); // on the block's top (3)
    expect(y).toBeLessThan(3 + 0.95);
  });
});

describe('phase 14.7: a player spawn inside a one-way platform', () => {
  it('is not blocked: the game starts and the player stands on the floor under the shelf', async () => {
    const shelf = box('shelf-0001', 0, 1.2, { box: { size: [4, 0.2, 2], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 2, hy: 0.1 }, oneWay: true } });
    // The capsule (0.01..1.81 m) passes through the shelf (1.1..1.3 m).
    const L = await level([0, REST_Y], [shelf], () => ({ moveX: 0, jump: 'none' }));
    expect(L.mounted.ok).toBe(true);
    expect(L.started.ok).toBe(true);
    L.tick(60);
    expect(L.view().failed).toBe(false);
    const [x, y] = L.pos('player-0001');
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeGreaterThan(REST_Y - 0.01);
    expect(y).toBeLessThan(REST_Y + 0.01);
  });

  it('a solid slab in the same place still blocks the spawn', async () => {
    const slab = box('slab-0001', 0, 1.2, { collider: { shape: { type: 'box', hx: 2, hy: 0.1 } } });
    // The player entity waits clear of the slab; the start reset's clearance probe checks the spawn.
    const L = await level([0, REST_Y], [slab], () => ({ moveX: 0, jump: 'none' }), [-6, REST_Y]);
    expect(L.mounted.ok).toBe(true);
    expect(L.started.ok).toBe(true);
    expect(L.view().failure).toMatchObject({ code: 'game_spawn_blocked', reason: 'blocked' });
  });
});
