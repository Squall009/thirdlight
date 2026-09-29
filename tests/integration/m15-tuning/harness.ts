/**
 * Phase 15.3 integration harness: one neutral scene played through the real
 * production composition — the game host, the platformer controller, the
 * blocks and primitives, Rapier physics — with the physics port built from
 * the character's data exactly as the preview and export hosts build it
 * (`playerCapsuleOf`, `playerPhysicsOf`, the project's `fixed_step_hz`).
 */
import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { playerCapsuleOf, playerPhysicsOf } from '@thirdlight/runtime';
import { withGameModules } from '../../game-modules';

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
  settings?: Record<string, unknown>;
  extra?: Any[];
  drive: Drive;
}

export interface Level {
  rt: Any;
  hz: number;
  tick(n?: number): void;
  pos(id: string): [number, number, number];
  stepIndex(): number;
  counters(): Any;
  hidden(): ReadonlySet<string>;
  dropThroughCalls: number[];
}

/** A long floor (top at y = 0) from x = -40 to 40, the character, its spawn, a camera, plus `extra`. */
export async function level(o: LevelOptions): Promise<Level> {
  const spawn = o.spawn ?? [0, 0.91];
  const controller = o.controller ?? {};
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: at(spawn[0], spawn[1]), controller, ...(o.playerExtra ?? {}) } },
    { id: 'spawn-0001', components: { transform: at(spawn[0], spawn[1]), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(0, -0.5), box: { size: [80, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 40, hy: 0.5 } } } },
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
  // As the preview and export hosts do: the capsule and the controller tuning come from the character's controller.
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
  const host = createGameHost(withGameModules({
    snapshot: {
      snapshotId: 'tuning@r1',
      projectId: 'tuning',
      revision: 1,
      scene,
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
  } as Any));
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
  tick(3);
  const pos = (id: string): [number, number, number] => {
    const t = rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === id);
    return [t.position[0], t.position[1], t.position[2]];
  };
  return {
    rt,
    hz,
    tick,
    pos,
    stepIndex: () => rt.getDiagnostics().diagnostics.stepIndex,
    counters: () => rt.gameCounters(),
    hidden: () => rt.hiddenEntities() as ReadonlySet<string>,
    dropThroughCalls,
  };
}

/** One sample per step: the character, the patroller, the lift, the counters and health, the hidden objects (exact numbers). */
export function trace(L: Level, steps: number, ids: readonly string[] = ['player-0001']): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < steps; i++) {
    L.tick();
    out.push({ step: L.stepIndex(), at: ids.map((id) => L.pos(id)), counters: L.counters(), hidden: [...L.hidden()].sort() });
  }
  return out;
}

/** An edge-walking patroller whose hitbox hurts on contact. */
export const WALKER = { patrol: { mode: 'edges', speed: 1, size: [0.8, 0.8] }, hitbox: { size: [0.8, 0.8], damage: 1 } };
/** A neutral course: an edge-walking patroller with a damaging hitbox, a collectible, a damaging hitbox on the floor and a lift. */
export function course(t: { patrol?: object; collectible?: object; hitbox?: object; mover?: object } = {}): Any[] {
  return [
    thing('walker-0001', 6, 0.4, { patrol: { ...WALKER.patrol, ...(t.patrol ?? {}) }, hitbox: { ...WALKER.hitbox, ...(t.hitbox ?? {}) } }),
    thing('token-0001', 10, 1, { collectible: { counter: 'items', size: [0.8, 0.8], ...(t.collectible ?? {}) } }),
    thing('spikes-0001', 13, 0.3, { hitbox: { size: [1, 0.6], damage: 1, ...(t.hitbox ?? {}) } }),
    thing('lift-0001', 24, 0.25, { box: { size: [2, 0.5, 2], material: { color: '#999999' } }, collider: { shape: { type: 'box', hx: 1, hy: 0.25 } }, mover: { waypoints: [[0, 1.5, 0]], speed: 1, mode: 'pingpong', ...(t.mover ?? {}) } }),
  ];
}

/** Run right; jump at 50 (released early), 140 and 260 (held). */
export const RUN_AND_JUMP: Drive = (s) => ({ moveX: 1, jump: s === 50 || s === 140 || s === 260 ? 'pressed' : s === 56 ? 'released' : (s > 50 && s < 56) || (s > 140 && s < 170) || (s > 260 && s < 290) ? 'held' : 'none' });

/** The recorded non-default run (`replay-nondefault.json`): 60 Hz, controller, patrol, collectible and mover values set. */
export const NONDEFAULT_RUN: LevelOptions = {
  controller: { acceleration: 25, deceleration: 90, coyoteTime: 0.1, jumpBuffer: 0.15, jumpRelease: 0.3, skin: 0.02, groundSnap: 0.2 },
  playerExtra: { health: { max: 3 } },
  extra: course({ patrol: { ledgeProbe: 0.8, wallProbe: 0.1, wait: 0.25 }, collectible: { amount: 2 }, mover: { maxPush: 30 } }),
  settings: { fixed_step_hz: 60 },
  drive: (s) => RUN_AND_JUMP(s * 2),
};
export const NONDEFAULT_STEPS = 480;
export const TRACE_IDS: readonly string[] = ['player-0001', 'walker-0001', 'lift-0001'];
