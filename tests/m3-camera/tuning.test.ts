/**
 * Phase 15.3: the follow camera's distance and speed cap are data.
 *
 * - `cameraFollow.maxSpeed` (m/s; default 480 = the old 4 m per step at
 *   120 Hz) caps the smoothed motion per step at the module's step rate;
 * - `cameraFollow.distance` keeps the camera that far in front of the player
 *   plane (z = player z + distance) and sizes the level frustum clamp;
 * - without `distance` the camera stays where it is placed (z never written)
 *   and the clamp uses that placed distance — a camera placed 12 m out frames
 *   exactly as the old constant did.
 */
import { describe, expect, it } from 'vitest';
import type { ActionFrame, GameplaySettings, IntentSet, ModuleConfig, RuntimeSnapshot, StepContext } from '@thirdlight/runtime';
import { CAMERA_CONSTANTS, CAMERA_MAX_SPEED, createGameCameraModule, followCamera } from '@thirdlight/platformer-game';

const CAMERA_Z = CAMERA_CONSTANTS.cameraZ;
const CAMERA_MAX_STEP = CAMERA_CONSTANTS.cameraMaxStep;

const CAM = 'cam-main';
const PLAYER = 'player-0001';
const T = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });

function setup(follow: Record<string, unknown>, o: { camZ?: number; playerZ?: number; playerX?: number; hz?: number; level?: { minX: number; maxX: number; minY: number; maxY: number } } = {}) {
  const camZ = o.camZ ?? 12;
  const playerZ = o.playerZ ?? 0;
  const snap = {
    snapshotId: 'cam-tune@r1',
    projectId: 'cam-tune',
    revision: 1,
    scene: {
      schemaVersion: o.level !== undefined ? 3 : 4,
      sceneId: 'main',
      revision: 1,
      entities: [
        { id: CAM, components: { transform: T(0, 0, camZ), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.5, ...follow } } },
        { id: PLAYER, components: { transform: T(o.playerX ?? 10, 0, playerZ), controller: {} } },
      ],
    },
    game: {
      configVersion: o.level !== undefined ? 1 : 2,
      title: 't',
      objective: 'o',
      instructions: 'i',
      playerId: PLAYER,
      cameraId: CAM,
      spawnId: 'spawn-0001',
      ...(o.level !== undefined ? { level: o.level, killY: -50 } : {}),
      cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
    },
  } as unknown as RuntimeSnapshot;
  const hz = o.hz ?? 120;
  const cfg: ModuleConfig = { fixedStepHz: hz, settings: {} as GameplaySettings, sceneVersion: o.level !== undefined ? 3 : 4, game: snap.game ?? null, behaviorLog: () => undefined };
  const mod = createGameCameraModule(snap, cfg);
  const state = {
    order: [PLAYER, CAM],
    entities: new Map(),
    stepIndex: 1,
    simTime: 1 / hz,
    prev: new Map(),
    curr: new Map([
      [PLAYER, T(o.playerX ?? 10, 0, playerZ)],
      [CAM, T(0, 0, camZ)],
    ]),
  };
  const ctx = {
    stepIndex: 1,
    phase: 'camera',
    action: { stepIndex: 1, moveX: 0, jump: 'none' } as ActionFrame,
    settings: {} as GameplaySettings,
    physics: {} as StepContext['physics'],
    state,
    intents: {} as IntentSet,
    emit: () => undefined,
    gameplay: { content: null, run: () => ({}), lastMotionSegment: () => undefined, viewport: () => ({ width: 1280, height: 720, aspect: 16 / 9 }), beginRespawn: () => undefined, activateCheckpoint: () => undefined, reachGoal: () => undefined },
  } as unknown as StepContext;
  return { step: () => mod.step('camera', ctx), cam: () => state.curr.get(CAM)!.position };
}

describe('the follow camera tuning (phase 15.3)', () => {
  it('the default speed cap is the old constant: 480 m/s is 4 m per step at 120 Hz', () => {
    expect(CAMERA_MAX_SPEED / 120).toBe(CAMERA_MAX_STEP);
    const d = setup({});
    d.step();
    expect(d.cam()).toEqual([4, 0, 12]); // T = 9.5, S = 4.75, capped at 4
  });

  it('maxSpeed caps the per-step motion at the step rate', () => {
    const slow = setup({ maxSpeed: 120 });
    slow.step();
    expect(slow.cam()[0]).toBe(1); // 120 m/s at 120 Hz: 1 m per step
    const hz60 = setup({ maxSpeed: 120 }, { hz: 60 });
    hz60.step();
    expect(hz60.cam()[0]).toBe(2); // the same speed at 60 Hz: 2 m per step
  });

  it('without distance the authored z is kept (never written)', () => {
    const placed = setup({}, { camZ: 20 });
    placed.step();
    expect(placed.cam()[2]).toBe(20);
  });

  it('distance keeps the camera that far in front of the player plane', () => {
    const near = setup({ distance: 6 }, { camZ: 20, playerZ: 1 });
    near.step();
    expect(near.cam()[2]).toBe(7);
  });

  it('the level frustum clamp uses the camera distance (authored, else as placed)', () => {
    // A level 20 m wide: at 12 m (fovY 45°, 16:9) the view is ~17.7 m wide, so
    // the camera centre stays within 8.84..11.16; at 6 m within 4.42..15.58.
    // The player at x = 2 (target 1.5) pins the camera at the left limit.
    const level = { minX: 0, maxX: 20, minY: -50, maxY: 50 };
    const halfW = (d: number) => d * Math.tan((45 * Math.PI) / 360) * (16 / 9);
    const at = (follow: Record<string, unknown>, camZ: number) => {
      const s = setup({ smoothing: 0, ...follow }, { camZ, level, playerX: 2 });
      s.step();
      return s.cam()[0];
    };
    const expectAt = (d: number) => Math.max(0 + halfW(d), Math.min(1.5, 20 - halfW(d)));
    expect(expectAt(12)).not.toBeCloseTo(expectAt(6), 3);
    expect(at({}, 12)).toBeCloseTo(expectAt(CAMERA_Z), 12); // placed 12 m out: the old framing exactly
    expect(at({}, 12)).toBe(followCamera({ camera: { x: 0, y: 0 }, player: { x: 2, y: 0 }, deadZone: { x: 0.5, y: 0.5 }, smoothing: 0, bounds: { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity }, level, fovY: 45, aspect: 16 / 9 }).position.x);
    expect(at({}, 6)).toBeCloseTo(expectAt(6), 12); // placed 6 m out: its own framing
    expect(at({ distance: 6 }, 12)).toBeCloseTo(expectAt(6), 12); // authored distance wins
  });
});
