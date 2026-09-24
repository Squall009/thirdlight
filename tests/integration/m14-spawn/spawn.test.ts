/**
 * Phase 14.1: `ctx.spawn` / `ctx.destroy` through the production composition
 * (the real game host, the platformer controller, Rapier physics) with
 * neutral prefabs:
 *
 * - a spawned crate blocks the walking player; destroying it frees its
 *   collider and the player walks on;
 * - a spawned coin is collected and counted;
 * - a new run removes every spawned entity (and its collider).
 */
import { describe, expect, it } from 'vitest';

import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { createBehaviorModuleSpec } from '@thirdlight/runtime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

const PREFABS = [
  { prefabId: 'crate', displayName: 'Crate', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0001', components: { transform: at(0, 0), box: { size: [1, 1, 1], material: { color: '#aa7733' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } }] },
  { prefabId: 'coin', displayName: 'Coin', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0002', components: { transform: at(0, 0), box: { size: [0.4, 0.4, 0.1], material: { color: '#ffcc00' } }, pickup: { kind: 'coin', value: 1, size: [0.6, 0.6] } } }] },
];

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

/** A neutral level (a long floor, top at y = 0), a script on a marker box that runs `script` every step. */
async function level(script: (ctx: Any) => void) {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
    { id: 'player-0001', components: { transform: at(0, 0.91), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(10, -0.5), box: { size: [60, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 30, hy: 0.5 } } } },
    { id: 'goal-0001', components: { transform: at(38, 1), gameZone: { role: 'goal', size: [1, 2] } } },
    { id: 'box-director', components: { transform: at(0, -5), box: { size: [0.2, 0.2, 0.2], material: { color: '#ffffff' } }, behavior: { behaviorId: 'director', values: {} } } },
  ];
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics = await createPhysicsPort({
    character: { x: 0, y: 0.91 },
    statics,
    solver: { hz: 120, gravityY: SETTINGS.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  } as Any);
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  const director = createBehaviorModuleSpec({
    declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] } as Any,
    artifact: {
      behaviorId: 'director',
      sourceDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      outputDigest: 'c'.repeat(64),
      ownedTransforms: [],
      requiredModules: [],
      enginePins: [],
      namespace: { default: { instantiate: () => ({}), step: (_s: unknown, ctx: Any) => script(ctx) } },
    } as Any,
  });
  const host = createGameHost({
    snapshot: {
      snapshotId: 'spawns@r1',
      projectId: 'spawns',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
      game: { configVersion: 2, title: 'Spawns', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
      prefabs: PREFABS,
    },
    settings: SETTINGS,
    physics: physics.port,
    behaviorModules: [director],
    adapter: () => null,
    input: {
      sample: (stepIndex: number) => ({ stepIndex, moveX: 1, jump: 'none' }),
      sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
      markConfirmConsumed: () => undefined,
      dispose: () => undefined,
    },
    audio: createGameAudioOwner({ contextFactory: () => null } as Any),
    readArtifact: async () => new ArrayBuffer(0),
    container: new FakeNode(),
    buildId: 'b',
    assetPaths: {},
    document: { createElement: () => new FakeNode() },
  } as Any);
  const mounted = host.mount();
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
  const rt: Any = host.runtime;
  let now = 0;
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += DT;
      const r = rt.tick(now);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    }
  };
  tick();
  if (!rt.gameCommand('start').ok) throw new Error('start refused');
  const x = (): number => rt.getInterpolatedState().state.transforms.find((t: Any) => t.id === 'player-0001').position[0];
  const probe = (p: { x: number; y: number }, half: { x: number; y: number }): string[] => (physics.port as Any).overlap({ type: 'box', hx: half.x, hy: half.y }, p);
  return { rt, tick, x, probe };
}

describe('ctx.spawn / ctx.destroy (real host, platformer, Rapier)', () => {
  it('a spawned crate blocks the player; destroying it frees its collider and the player walks on', async () => {
    // Scripts run from the first step; the run starts after the settle steps and
    // a new run removes spawned entities, so the test asks once the run is live.
    let crate: string | null = null;
    let spawnNow = false;
    let destroyNow = false;
    const L = await level((ctx) => {
      if (spawnNow) {
        crate = ctx.spawn('crate', { position: [3, 0.5] });
        spawnNow = false;
      }
      if (destroyNow) {
        ctx.destroy(crate);
        destroyNow = false;
      }
    });
    spawnNow = true;
    L.tick(180); // 1.5 s of walking right at 5 m/s would reach x ≈ 7.5 without the crate
    expect(crate).toBe('spawn-1');
    // Stopped at the crate's left face (x 2.5) minus the capsule radius (0.3).
    expect(L.x()).toBeLessThan(2.2 + 0.02);
    expect(L.x()).toBeGreaterThan(2.0);
    expect(L.probe({ x: 3, y: 0.5 }, { x: 0.2, y: 0.2 })).toEqual(['spawn-1']);
    destroyNow = true;
    L.tick(120);
    expect(L.probe({ x: 3, y: 0.5 }, { x: 0.2, y: 0.2 })).toEqual([]);
    expect(L.x()).toBeGreaterThan(5);
    expect(L.rt.sceneSet().spawned).toEqual([]);
  });

  it('a spawned coin is collected and counted; a new run removes spawned entities and their colliders', async () => {
    let asked = true;
    const L = await level((ctx) => {
      if (!asked) {
        asked = true;
        ctx.spawn('coin', { position: [2, 0.9] });
        ctx.spawn('crate', { position: [20, 0.5] });
      }
    });
    asked = false;
    L.tick(90);
    expect(L.rt.gameCounters().counters).toEqual({ coins: 1 });
    expect(L.rt.hiddenEntities().has('spawn-1')).toBe(true);
    expect(L.probe({ x: 20, y: 0.5 }, { x: 0.2, y: 0.2 })).toEqual(['spawn-2']);
    expect(L.rt.gameCommand('replay').ok).toBe(true);
    L.tick(2);
    expect(L.rt.sceneSet().spawned).toEqual([]);
    expect(L.probe({ x: 20, y: 0.5 }, { x: 0.2, y: 0.2 })).toEqual([]);
    expect(L.rt.gameCounters().counters).toEqual({});
  });
});
