/**
 * Phase 15.3 integration harness: one neutral level played through the real
 * production composition — the game host, the platformer controller, the
 * platformer-game session and camera, Rapier physics — with the physics port
 * built from the player's data exactly as the preview and export hosts build
 * it (`playerCapsuleOf`, `playerPhysicsOf`, the project's `fixed_step_hz`).
 */
import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { playerCapsuleOf, playerPhysicsOf, type ModelBounds } from '@thirdlight/runtime';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
export const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
export const thing = (id: string, x: number, y: number, components: Record<string, unknown>) => ({ id, components: { transform: at(x, y), ...components } });
/** Neutral movement settings (not the engine defaults on purpose: the tuning under test is separate). */
export const BASE_SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

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

export type Drive = (step: number) => { moveX: number; jump: 'none' | 'pressed' | 'held' | 'released'; actions?: Record<string, unknown> };

export interface LevelOptions {
  spawn?: [number, number];
  controller?: Record<string, unknown>;
  playerExtra?: Record<string, unknown>;
  follow?: Record<string, unknown>;
  cameraZ?: number;
  game?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  extra?: Any[];
  modelBounds?: Record<string, ModelBounds>;
  drive: Drive;
}

export interface Level {
  rt: Any;
  hz: number;
  tick(n?: number): void;
  pos(id: string): [number, number, number];
  view(): Any;
  counters(): Any;
  hidden(): ReadonlySet<string>;
  opacity(): ReadonlyMap<string, number>;
  dropThroughCalls: number[];
}

/** A long floor (top at y = 0) from x = -40 to 40, the player, its spawn, a camera, a far goal, plus `extra`. */
export async function level(o: LevelOptions): Promise<Level> {
  const spawn = o.spawn ?? [0, 0.91];
  const controller = o.controller ?? {};
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, o.cameraZ ?? 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, ...(o.follow ?? {}) } } },
    { id: 'player-0001', components: { transform: at(spawn[0], spawn[1]), controller, ...(o.playerExtra ?? {}) } },
    { id: 'spawn-0001', components: { transform: at(spawn[0], spawn[1]), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(0, -0.5), box: { size: [80, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 40, hy: 0.5 } } } },
    { id: 'goal-0001', components: { transform: at(38, 1), gameZone: { role: 'goal', size: [1, 2] } } },
    ...(o.extra ?? []),
  ];
  const scene = { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities };
  const settings = { ...BASE_SETTINGS, ...(o.settings ?? {}) } as Any;
  const hz: number = settings.fixed_step_hz ?? 120;
  const statics = entities
    .filter((e) => e.components.collider)
    .map((e) => ({
      entityId: e.id,
      shape: e.components.collider.shape,
      position: { x: e.components.transform.position[0], y: e.components.transform.position[1] },
      rotationZ: 0,
      ...(e.components.mover !== undefined ? { kinematic: true } : {}),
      ...(e.components.collider.oneWay === true ? { oneWay: true } : {}),
    }));
  // As the preview and export hosts do: the capsule and the controller tuning come from the player's controller.
  const capsule = playerCapsuleOf(controller);
  const tuning = playerPhysicsOf(controller);
  const physics = await createPhysicsPort({
    character: { x: spawn[0], y: spawn[1], radius: capsule.radius, halfHeight: capsule.halfHeight, offset: capsule.offset },
    statics,
    solver: { hz, gravityY: settings.gravity_y },
    controller: { offsetSkin: tuning.offsetSkin, groundSnap: tuning.groundSnap, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: tuning.autostep, ...(tuning.autostep ? { autostepHeight: tuning.autostepHeight } : {}) },
  });
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  const port: Any = physics.port;
  const dropThroughCalls: number[] = [];
  const realDrop = port.dropThrough.bind(port);
  port.dropThrough = (steps: number) => {
    dropThroughCalls.push(steps);
    realDrop(steps);
  };
  const input = {
    sample: (stepIndex: number) => ({ stepIndex, ...o.drive(stepIndex) }),
    sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
    markConfirmConsumed: () => undefined,
    dispose: () => undefined,
  };
  const audio: Any = createGameAudioOwner({ contextFactory: () => null } as Any);
  const host = createGameHost({
    snapshot: {
      snapshotId: 'tuning@r1',
      projectId: 'tuning',
      revision: 1,
      scene,
      game: { configVersion: 2, title: 'Tuning', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null }, ...(o.game ?? {}) },
      ...(o.modelBounds !== undefined ? { modelBounds: o.modelBounds } : {}),
    },
    settings,
    physics: port,
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
      now += 1 / hz;
      const r = rt.tick(now);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    }
  };
  tick();
  const started = rt.gameCommand('start');
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  tick(2);
  const pos = (id: string): [number, number, number] => {
    const t = rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === id);
    return [t.position[0], t.position[1], t.position[2]];
  };
  return {
    rt,
    hz,
    tick,
    pos,
    view: () => rt.getGameView().view,
    counters: () => rt.gameCounters(),
    hidden: () => rt.hiddenEntities() as ReadonlySet<string>,
    opacity: () => rt.entityOpacity() as ReadonlyMap<string, number>,
    dropThroughCalls,
  };
}

/** One sample per step: the player, the camera, the enemy, the run state and counters (exact numbers). */
export function trace(L: Level, steps: number, ids: readonly string[] = ['player-0001', 'cam-main']): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < steps; i++) {
    L.tick();
    const v = L.view();
    out.push({ step: v.stepIndex, state: v.state, deaths: v.deathCount, at: ids.map((id) => L.pos(id)), counters: L.counters(), hidden: [...L.hidden()].sort() });
  }
  return out;
}

export const ENEMY = { patrol: 'edges', speed: 1, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 };
/** A neutral course: an edge-walking enemy, a coin, a damaging hazard, a deadly zone and a lift. */
export function course(t: { enemy?: object; mover?: object } = {}): Any[] {
  return [
    thing('enemy-0001', 6, 0, { enemy: { ...ENEMY, ...(t.enemy ?? {}) } }),
    thing('coin-0001', 10, 1, { pickup: { kind: 'coin', value: 1, size: [0.8, 0.8] } }),
    thing('spikes-0001', 13, 0.3, { gameZone: { role: 'hazard', size: [1, 0.6], damage: 1 } }),
    thing('pit-0001', 17, 0.3, { gameZone: { role: 'hazard', size: [1, 0.6] } }),
    thing('lift-0001', 24, 0.25, { box: { size: [2, 0.5, 2], material: { color: '#999999' } }, collider: { shape: { type: 'box', hx: 1, hy: 0.25 } }, mover: { waypoints: [[0, 1.5, 0]], speed: 1, mode: 'pingpong', ...(t.mover ?? {}) } }),
  ];
}

/** Run right; jump at 50 (released early), 140 and 260 (held). */
export const RUN_AND_JUMP: Drive = (s) => ({ moveX: 1, jump: s === 50 || s === 140 || s === 260 ? 'pressed' : s === 56 ? 'released' : (s > 50 && s < 56) || (s > 140 && s < 170) || (s > 260 && s < 290) ? 'held' : 'none' });

/** The recorded non-default run (`replay-nondefault.json`): 60 Hz, every kind of tuning set. */
export const NONDEFAULT_RUN: LevelOptions = {
  controller: { acceleration: 25, deceleration: 90, coyoteTime: 0.1, jumpBuffer: 0.15, jumpRelease: 0.3, skin: 0.02, groundSnap: 0.2 },
  playerExtra: { health: { max: 3, knockback: 4, hitBounce: 7, knockbackTime: 0.4 } },
  extra: course({ enemy: { stompBounce: 12, stompTolerance: 0.3, defeat: 'fade', defeatTime: 0.5, ledgeProbe: 0.8 }, mover: { maxPush: 30 } }),
  follow: { maxSpeed: 120, distance: 10 },
  game: { respawnDelay: 0.5, settleTime: 0.05 },
  settings: { fixed_step_hz: 60 },
  drive: (s) => RUN_AND_JUMP(s * 2),
};
export const NONDEFAULT_STEPS = 480;
export const TRACE_IDS: readonly string[] = ['player-0001', 'cam-main', 'enemy-0001', 'lift-0001'];
