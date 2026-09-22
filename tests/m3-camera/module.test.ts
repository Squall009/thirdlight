/**
 * Packet 51 — the camera module's write semantics and defensive paths
 * (tests/m3-camera/**): driven directly (no runtime, no physics) —
 *
 *   * the step writes exactly the §7.2 pipeline result of `followCamera`
 *     (cap active for 0 < k < 1, exact hard target for k = 0, cap skipped
 *     on the snap), and nothing else: `position.z`, rotation and scale of
 *     the camera entity are never written (gameplay.md §7.1/§3.4);
 *   * the no-oscillation rule: inside the dead zone the step writes nothing
 *     (the camera keeps its pose exactly);
 *   * the §7.5 defensive non-finite viewport: no transform write, one
 *     bounded `camera_viewport_invalid` diagnostic entry, never a
 *     fail-stop (the step and the R6 snap);
 *   * the `create` defenses (schemaVersion 3, a non-null `content.game`,
 *     a `cameraFollow` component, a finite positive `fovY`);
 *   * `transformOwners` is exactly the scene camera entity (the single
 *     camera owner, §3.4); a non-`camera` phase is a no-op; a missing
 *     `GameSessionPort` is a module error.
 */
import { describe, expect, it } from 'vitest';
import type {
  ActionFrame,
  GameplaySettings,
  IntentSet,
  ModuleConfig,
  ModuleResetContext,
  RuntimeSnapshot,
  StepContext,
} from '@thirdlight/runtime';
import { createGameCameraModule, followCamera } from '@thirdlight/platformer-game';

const CAM = 'cam-main';
const PLAYER = 'group-0001';
const Z = 12; // the authored depth — never written

const T = (x: number, y: number) => ({ position: [x, y, Z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });

const LEVEL = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
const BOUNDS = LEVEL;
const FOV_Y = 45;
const DZ = { x: 0.5, y: 0.5 };

function snapshot(overrides?: { schemaVersion?: 1 | 2 | 3; cameraFollow?: null; camera?: null; fovY?: number }): RuntimeSnapshot {
  const schemaVersion = overrides?.schemaVersion ?? 3;
  return {
    snapshotId: 'cam-t@r1',
    projectId: 'cam-t',
    revision: 1,
    scene: {
      schemaVersion,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        {
          id: CAM,
          components: {
            transform: T(0, 0),
            ...(overrides?.camera === null ? {} : { camera: { type: 'perspective', fovY: overrides?.fovY ?? FOV_Y, near: 0.1, far: 100 } }),
            ...(overrides?.cameraFollow === null ? {} : { cameraFollow: { deadZone: DZ, smoothing: 0.5, bounds: BOUNDS } }),
          },
        },
        { id: PLAYER, components: { transform: T(10, 0), controller: {} } },
      ],
    } as RuntimeSnapshot['scene'],
    game:
      schemaVersion === 3
        ? {
            configVersion: 1,
            title: 'Camera Unit',
            objective: 'test',
            instructions: 'test',
            playerId: PLAYER,
            cameraId: CAM,
            spawnId: 'spawn-0001',
            level: LEVEL,
            killY: -4,
            cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
          }
        : undefined,
  } as RuntimeSnapshot;
}

function cfgOf(
  snap: RuntimeSnapshot,
  logs: Array<{ level: string; message: string }>,
  overrides?: Partial<ModuleConfig>,
): ModuleConfig {
  return {
    fixedStepHz: 120,
    settings: {} as GameplaySettings,
    sceneVersion: 3,
    game: snap.game ?? null,
    behaviorLog: (level, message) => {
      logs.push({ level: String(level), message });
    },
    ...overrides,
  };
}

function stateOf(cam: [number, number, number], player: [number, number, number]) {
  return {
    order: [PLAYER, CAM],
    entities: new Map(),
    stepIndex: 1,
    simTime: 1 / 120,
    prev: new Map(),
    curr: new Map([
      [PLAYER, T(player[0], player[1])],
      [CAM, T(cam[0], cam[1])],
    ]),
  };
}

function stepCtx(
  state: ReturnType<typeof stateOf>,
  viewport: { width: number; height: number; aspect: number },
  gameplay: boolean,
): StepContext {
  const port = gameplay
    ? {
        content: null,
        run: () => ({}),
        lastMotionSegment: () => undefined,
        viewport: () => viewport,
        beginRespawn: () => undefined,
        activateCheckpoint: () => undefined,
        reachGoal: () => undefined,
      }
    : undefined;
  return {
    stepIndex: 1,
    phase: 'camera',
    action: { stepIndex: 1, moveX: 0, jump: 'none' } as ActionFrame,
    settings: {} as GameplaySettings,
    physics: {} as StepContext['physics'],
    state,
    intents: {} as IntentSet,
    emit: () => undefined,
    ...(gameplay ? { gameplay: port } : {}),
  } as unknown as StepContext;
}

describe('packet 51 — the camera module (write semantics, defensive paths)', () => {
  it('writes exactly the §7.2 pipeline result (cap active for 0 < k < 1)', () => {
    const logs: Array<{ level: string; message: string }> = [];
    const snap = snapshot();
    const mod = createGameCameraModule(snap, cfgOf(snap, logs));
    expect(mod.transformOwners).toEqual([CAM]);
    // C = (0, 0), P = (10, 0), dz = (0.5, 0.5), k = 0.5:
    // T = (9.5, 0); S = (4.75, 0); the per-axis cap (4 m) applies: (4, 0);
    // bounds/level are wide ⇒ the write is (4, 0).
    const state = stateOf([0, 0, Z], [10, 0, Z]);
    mod.step('camera', stepCtx(state, { width: 1280, height: 720, aspect: 16 / 9 }, true));
    const cam = state.curr.get(CAM)!;
    expect(cam.position).toEqual([4, 0, Z]); // x written, y written, z untouched
    expect(cam.rotation).toEqual([0, 0, 0, 1]); // the authored quaternion, never written
    expect(cam.scale).toEqual([1, 1, 1]); // the authored scale, never written
    expect(logs).toEqual([]); // no diagnostic on a valid step
    // Agreement with the pure function: the same input gives the same write.
    const pure = followCamera({
      camera: { x: 0, y: 0 },
      player: { x: 10, y: 0 },
      deadZone: DZ,
      smoothing: 0.5,
      bounds: BOUNDS,
      level: LEVEL,
      fovY: FOV_Y,
      aspect: 16 / 9,
    });
    expect(pure.position.x).toBe(4);
    expect(pure.position.y).toBe(0);
    expect(pure.capped.x).toBe(4);
    expect(pure.smoothed.x).toBe(4.75);
    expect(pure.target.x).toBe(9.5);
  });

  it('k = 0 is an exact hard target that bypasses the cap (§7.2)', () => {
    const logs: Array<{ level: string; message: string }> = [];
    const snapK0 = snapshot();
    const sceneCam = snapK0.scene.entities[0].components as { cameraFollow: { smoothing: number } };
    sceneCam.cameraFollow.smoothing = 0;
    const modK0 = createGameCameraModule(snapK0, cfgOf(snapK0, logs));
    const state = stateOf([0, 0, Z], [10, 0, Z]);
    modK0.step('camera', stepCtx(state, { width: 1280, height: 720, aspect: 16 / 9 }, true));
    expect(state.curr.get(CAM)!.position).toEqual([9.5, 0, Z]); // T exactly, no cap
  });

  it('the snap pipeline (reset, §7.4) forces k = 1 and skips the cap', () => {
    const logs: Array<{ level: string; message: string }> = [];
    const snap = snapshot();
    const mod = createGameCameraModule(snap, cfgOf(snap, logs));
    const state = stateOf([0, 0, Z], [10, 0, Z]);
    const resetCtx = {
      reason: 'spawn',
      stepIndex: 1,
      playerCenter: { x: 10, y: 0 },
      viewport: { width: 1280, height: 720, aspect: 16 / 9 },
      state,
    } as unknown as ModuleResetContext;
    mod.reset!(resetCtx);
    // C = (0, 0), P = (10, 0): T = (9.5, 0); snap ⇒ S = T, cap skipped:
    // the write is (9.5, 0) even though the normal k = 0.5 step caps at 4.
    expect(state.curr.get(CAM)!.position).toEqual([9.5, 0, Z]);
    expect(logs).toEqual([]);
  });

  it('inside the dead zone the step writes nothing (no-oscillation rule, §7.2)', () => {
    const logs: Array<{ level: string; message: string }> = [];
    const snap = snapshot();
    const mod = createGameCameraModule(snap, cfgOf(snap, logs));
    const state = stateOf([5, 2, Z], [5.3, 2.1, Z]); // |Δ| = (0.3, 0.1) < (0.5, 0.5)
    const before = state.curr.get(CAM)!.position;
    mod.step('camera', stepCtx(state, { width: 1280, height: 720, aspect: 16 / 9 }, true));
    expect(state.curr.get(CAM)!.position).toBe(before); // the very same array, untouched
    // And the pure function reports no move.
    const pure = followCamera({
      camera: { x: 5, y: 2 },
      player: { x: 5.3, y: 2.1 },
      deadZone: DZ,
      smoothing: 0.5,
      bounds: BOUNDS,
      level: LEVEL,
      fovY: FOV_Y,
      aspect: 16 / 9,
    });
    expect(pure.moved).toBe(false);
    expect(pure.position.x).toBe(5);
    expect(pure.position.y).toBe(2);
  });

  it('a non-finite viewport never writes and never throws (one bounded diagnostic, §7.5)', () => {
    const logs: Array<{ level: string; message: string }> = [];
    const snap = snapshot();
    const mod = createGameCameraModule(snap, cfgOf(snap, logs));
    const state = stateOf([0, 0, Z], [10, 0, Z]);
    // Step: NaN width.
    mod.step('camera', stepCtx(state, { width: Number.NaN, height: 720, aspect: Number.NaN }, true));
    expect(state.curr.get(CAM)!.position).toEqual([0, 0, Z]); // untouched
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('warn');
    expect(logs[0].message).toContain('camera_viewport_invalid');
    // Reset: ±Infinity viewport.
    const logs2: Array<{ level: string; message: string }> = [];
    const mod2 = createGameCameraModule(snap, cfgOf(snap, logs2));
    const state2 = stateOf([0, 0, Z], [10, 0, Z]);
    mod2.reset!({
      reason: 'spawn',
      stepIndex: 1,
      playerCenter: { x: 10, y: 0 },
      viewport: { width: Number.POSITIVE_INFINITY, height: 720, aspect: Number.POSITIVE_INFINITY },
      state: state2,
    } as unknown as ModuleResetContext);
    expect(state2.curr.get(CAM)!.position).toEqual([0, 0, Z]);
    expect(logs2).toHaveLength(1);
    expect(logs2[0].message).toContain('camera_viewport_invalid');
    // And a valid viewport after the invalid one writes normally.
    const state3 = stateOf([0, 0, Z], [10, 0, Z]);
    mod.step('camera', stepCtx(state3, { width: 1280, height: 720, aspect: 16 / 9 }, true));
    expect(state3.curr.get(CAM)!.position).toEqual([4, 0, Z]);
    // The initial record ("until `setViewport`", §7.1): width/height 0 with
    // the DEFAULT_ASPECT — the aspect is what the pipeline consumes, so the
    // step writes normally (this is the runtime's real pre-setViewport state).
    const logsInit: Array<{ level: string; message: string }> = [];
    const modInit = createGameCameraModule(snap, cfgOf(snap, logsInit));
    const stateInit = stateOf([0, 0, Z], [10, 0, Z]);
    modInit.step('camera', stepCtx(stateInit, { width: 0, height: 0, aspect: 16 / 9 }, true));
    expect(stateInit.curr.get(CAM)!.position).toEqual([4, 0, Z]);
    expect(logsInit).toEqual([]);
  });

  it('a non-`camera` phase is a no-op; a missing `GameSessionPort` is a module error', () => {
    const logs: Array<{ level: string; message: string }> = [];
    const snap = snapshot();
    const mod = createGameCameraModule(snap, cfgOf(snap, logs));
    const state = stateOf([0, 0, Z], [10, 0, Z]);
    const ctx = stepCtx(state, { width: 1280, height: 720, aspect: 16 / 9 }, true);
    mod.step('transform', { ...ctx, phase: 'transform' } as unknown as StepContext);
    expect(state.curr.get(CAM)!.position).toEqual([0, 0, Z]); // no write in another phase
    expect(() => mod.step('camera', stepCtx(state, { width: 1280, height: 720, aspect: 16 / 9 }, false))).toThrow(
      /GameSessionPort/,
    );
  });

  it('the `create` defenses (schemaVersion 3, `content.game`, `cameraFollow`, finite positive `fovY`)', () => {
    const logs: Array<{ level: string; message: string }> = [];
    expect(() => createGameCameraModule(snapshot({ schemaVersion: 2 }), cfgOf(snapshot({ schemaVersion: 2 }), logs, { sceneVersion: 2 }))).toThrow(/schemaVersion 3/);
    expect(() =>
      createGameCameraModule(snapshot(), cfgOf(snapshot(), logs, { game: null })),
    ).toThrow(/content.game/);
    expect(() => createGameCameraModule(snapshot({ cameraFollow: null }), cfgOf(snapshot({ cameraFollow: null }), logs))).toThrow(
      /cameraFollow/,
    );
    // A non-finite fovY is refused.
    const badFov = snapshot();
    (badFov.scene.entities[0].components as { camera: { fovY: number } }).camera.fovY = Number.NaN;
    expect(() => createGameCameraModule(badFov, cfgOf(badFov, logs))).toThrow(/fovY/);
  });
});