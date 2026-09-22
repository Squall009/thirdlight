/**
 * Packet 50 — the runtime-owned safe respawn (tests/m3-respawn/**): the real
 * Rapier R1–R7 reset transaction over `PhysicsResetPort`. Every accepted piece
 * composed for real:
 *
 *   `@thirdlight/platformer` (the controller module — its `reset` hook clears
 *     the velocity and the jump windows)
 *   + `@thirdlight/runtime` (M3 wiring: the boundary, the R1–R7 transaction,
 *     the rebase, the fail-stop, the view)
 *   + `@thirdlight/physics-rapier` (the pinned `@dimforge/rapier2d-compat@0.20.0`
 *     — `clearCharacterMotion` / `placeCharacter` / `characterClearance`)
 *   + `@thirdlight/platformer-game` (the pure gameplay-phase session module:
 *     the swept §4.2 zone predicate over the runtime's motion segments, and
 *     the real `camera`-phase follow module — the single camera transform
 *     owner whose §7.4 reset snap the R6 barrier runs; packet 51)
 *
 * The reset is the one runtime-owned discontinuity (gameplay.md §5.1 R1–R7):
 * R1 resolve the destination, R2 verify (pure reads), R3 clearance probe (the
 * real Rapier narrow-phase), R4 physics reset (the §5.2 restricted operations),
 * R5 stage the pose, R6 module `reset()` hooks (the controller clears its
 * windows, the camera snaps), R7 apply + rebase (`prev := curr`, the motion
 * segment rebased to a zero-motion segment at the reset pose). The step-end
 * promotion then captures the post-reset `curr` as the next step's backup —
 * the no-render-streak guarantee (the display never sweeps between death and
 * spawn).
 *
 * The R8 fault-injection seam (`injectResetFault`) reproduces each reset phase
 * failure's exact signature (pinned by
 * `fixtures/m3/gameplay/run/failure-phases.json`); the real R3/R4 failures are
 * exercised with a real blocked destination and a fault-injecting port.
 */
import { describe, expect, it } from 'vitest';
import { createPhysicsPort, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import {
  createRecordedActionSource,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionFrame,
  type GameView,
  type GameplaySettings,
  type PhysicsPort,
  type Runtime,
  type Vec2,
} from '@thirdlight/runtime';
import { PLATFORMER_MODULE_ID, platformerSpec } from '@thirdlight/platformer';
import {
  PLATFORMER_GAME_CAMERA_MODULE_ID,
  PLATFORMER_GAME_MODULE_ID,
  platformerGameCameraSpec,
  platformerGameSessionSpec,
} from '@thirdlight/platformer-game';

const SETTLE_STEPS = 12;
const DT = 1 / 120;
const KILL_Y = -4;
const SOLVER = { hz: 120, gravityY: -19.62 } as const;
const CONTROLLER_CFG = {
  offsetSkin: 0.01,
  groundSnap: 0.1,
  maxSlopeClimbRad: Math.PI / 4,
  minSlopeSlideRad: Math.PI / 6,
  autostep: false,
} as const;
const SETTINGS: GameplaySettings = {
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
};

const PLAYER_ID = 'group-0001';
const CAM_ID = 'cam-main';
const SPAWN_ID = 'spawn-0001';
const SAFE_SPAWN_ID = 'spawn-0002';

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

interface Course {
  statics: RapierStaticColliderSpec[];
  zones: Array<{ id: string; role: 'hazard' | 'checkpoint' | 'goal'; center: [number, number]; size: [number, number] }>;
  /** The capsule's initial X (default 3). */
  characterX?: number;
  /** The start spawn's X (default 3). */
  spawnX?: number;
}

/** Death before any checkpoint: floor 0..10 then the pit. Destination = start spawn. */
const COURSE_BEFORE_CP: Course = {
  statics: [{ entityId: 'floor', shape: { type: 'box', hx: 5, hy: 0.25 }, position: { x: 5, y: -0.25 }, rotationZ: 0 }],
  zones: [],
};

/** Death after a checkpoint: floor 0..30, checkpoint at x=22 (safe spawn 22), pit after 30. */
const COURSE_AFTER_CP: Course = {
  statics: [{ entityId: 'floor', shape: { type: 'box', hx: 15, hy: 0.25 }, position: { x: 15, y: -0.25 }, rotationZ: 0 }],
  zones: [{ id: 'zone-cp', role: 'checkpoint', center: [22, 1], size: [2, 2] }],
};

/**
 * Blocked destination (the real R3 clearance probe): the capsule starts at
 * x=1 (on the floor, NOT inside the wall), and the start spawn (x=3) sits
 * inside a wall. The pre-roll settles the capsule at x=1 (outside the wall);
 * the `start` reset's R3 clearance probe (a query at the destination, x=3)
 * reports `blocked` — independent of the capsule's pose — and the runtime
 * fail-stops at step 13 with `game_spawn_blocked` / `blocked`.
 */
const COURSE_BLOCKED: Course = {
  statics: [
    { entityId: 'floor', shape: { type: 'box', hx: 5, hy: 0.25 }, position: { x: 5, y: -0.25 }, rotationZ: 0 },
    { entityId: 'wall', shape: { type: 'box', hx: 0.6, hy: 1.2 }, position: { x: 3, y: 0.91 }, rotationZ: 0 },
  ],
  zones: [],
  characterX: 1,
  spawnX: 3,
};

// ---------------------------------------------------------------------------
// Scene + harness
// ---------------------------------------------------------------------------

const T = { rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

function v3Snapshot(course: Course): unknown {
  const zoneEntities = course.zones.map((z) => ({
    id: z.id,
    components: {
      transform: { position: [z.center[0], z.center[1], 0], ...T },
      gameZone:
        z.role === 'checkpoint'
          ? {
              role: 'checkpoint',
              size: z.size,
              safeSpawnId: SAFE_SPAWN_ID,
              activation: { emissive: '#ff0000', emissiveIntensity: 2, cueAssetId: null },
            }
          : { role: z.role, size: z.size },
    },
  }));
  const staticEntities = course.statics.map((s, i) => ({
    id: `static-${String(i + 1).padStart(4, '0')}`,
    components: {
      transform: { position: [s.position.x, s.position.y, 0], ...T },
      box: { size: [s.shape.hx * 2, s.shape.hy * 2, 1], material: { color: '#6f6f6f' } },
      collider: { shape: { type: 'box', hx: s.shape.hx, hy: s.shape.hy } },
    },
  }));
  return {
    snapshotId: 'demo-resp@r1',
    projectId: 'demo-resp',
    revision: 1,
    scene: {
      schemaVersion: 3,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        {
          id: CAM_ID,
          name: 'Gameplay camera',
          components: {
            transform: { position: [0, 4, 12], ...T },
            camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 },
            cameraFollow: {
              deadZone: { x: 0.5, y: 0.5 },
              smoothing: 0.2,
              bounds: { minX: 0, maxX: 48, minY: -4, maxY: 8 },
            },
          },
        },
        {
          id: PLAYER_ID,
          name: 'Player',
          components: {
            transform: { position: [course.characterX ?? 3, 0.9, 0], ...T },
            controller: {},
          },
        },
        { id: SPAWN_ID, components: { transform: { position: [course.spawnX ?? 3, 0.91, 0], ...T }, playerSpawn: {} } },
        { id: SAFE_SPAWN_ID, components: { transform: { position: [22, 0.91, 0], ...T }, playerSpawn: {} } },
        ...zoneEntities,
        ...staticEntities,
      ],
    },
    game: {
      configVersion: 1,
      title: 'Respawn Course',
      objective: 'Reach the goal',
      instructions: 'A/D move. Space jumps.',
      playerId: PLAYER_ID,
      cameraId: CAM_ID,
      spawnId: SPAWN_ID,
      level: { minX: 0, maxX: 48, minY: -4, maxY: 8 },
      killY: KILL_Y,
      cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
    },
  };
}

interface Run {
  runtime: Runtime;
  /** The test-only reset fault seam (not on the public `Runtime` surface). */
  fault(phase: string | null): void;
  step(): void;
  view(): GameView;
  position(): Vec2;
  /** The raw committed transforms (prev/curr coherence). */
  committed(): { id: string; position: [number, number, number] }[];
  dispose(): void;
}

async function startRespawnRun(course: Course, frames: readonly ActionFrame[]): Promise<Run> {
  const init = await createPhysicsPort({
    character: { x: course.characterX ?? 3, y: 0.9 },
    statics: course.statics,
    solver: SOLVER,
    controller: CONTROLLER_CFG,
  });
  if (!init.ok) throw new Error(`physics init failed: ${JSON.stringify(init.error)}`);
  const physics: PhysicsPort = init.port;
  const registry = createSimulationRegistry();
  for (const spec of [platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec]) {
    const r = registerSimulationModule(registry, spec.id, spec);
    if (!r.ok) {
      physics.dispose();
      throw new Error(`register ${spec.id} failed: ${JSON.stringify(r.error)}`);
    }
  }
  let now = 0;
  const res = instantiateRuntime({
    snapshot: v3Snapshot(course),
    registry,
    modules: [PLATFORMER_MODULE_ID, PLATFORMER_GAME_MODULE_ID, PLATFORMER_GAME_CAMERA_MODULE_ID],
    actions: createRecordedActionSource(frames),
    physics,
    settings: SETTINGS,
    clock: () => now,
    driver: { kind: 'manual' },
  });
  if (!res.ok) {
    physics.dispose();
    throw new Error(`instantiateRuntime failed: ${JSON.stringify(res.error)}`);
  }
  const runtime = res.runtime;
  if (!runtime.start().ok) throw new Error('start failed');
  if (!runtime.tick(now).ok) throw new Error('pre-roll tick failed'); // the 12-step settle
  const position = (): Vec2 => {
    const s = runtime.getInterpolatedState();
    if (!s.ok) throw new Error('getInterpolatedState failed');
    const t = s.state.transforms.find((x) => x.id === PLAYER_ID);
    if (!t) throw new Error('player transform missing');
    return { x: t.position[0], y: t.position[1] };
  };
  return {
    runtime,
    fault(phase: string | null): void {
      (runtime as unknown as { injectResetFault(p: string | null): void }).injectResetFault(phase);
    },
    step(): void {
      now += DT;
      const r = runtime.tick(now);
      // A fail-stop makes the state `failed`; a subsequent `tick` returns
      // `runtime_failed` (a failed instance is never ticked again). That is
      // the expected terminal state — not a test error. Any other `tick`
      // failure is a real error.
      if (!r.ok && r.error.code !== 'runtime_failed') throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    },
    view(): GameView {
      const v = runtime.getGameView();
      if (!v.ok) throw new Error(`getGameView failed: ${JSON.stringify(v.error)}`);
      return v.view;
    },
    position,
    committed(): { id: string; position: [number, number, number] }[] {
      const s = runtime.getInterpolatedState();
      if (!s.ok) throw new Error('getInterpolatedState failed');
      return s.state.transforms.map((t) => ({ id: t.id, position: t.position }));
    },
    dispose(): void {
      runtime.dispose();
      physics.dispose();
    },
  };
}

/** Rightward-walk frames (moveX 1, no jump) for `n` sampled steps. */
function walkRight(n: number): ActionFrame[] {
  return Array.from({ length: n }, (_, i) => Object.freeze({ stepIndex: SETTLE_STEPS + i, moveX: 1, jump: 'none' as const }));
}

/** Run until the Nth death (deathCount >= n), returning once reached. */
function runToDeath(run: Run, n: number): void {
  let steps = 0;
  while (steps < 900 && run.view().deathCount < n) {
    run.step();
    steps += 1;
  }
  if (run.view().deathCount < n) throw new Error(`death ${n} not reached within 900 steps`);
}

/** Run until the first death, returning the death's stepIndex (1-based). */
function runToFirstDeath(run: Run): number {
  let steps = 0;
  while (steps < 900 && run.view().deathCount === 0) {
    run.step();
    steps += 1;
  }
  const v = run.view();
  if (v.deathCount === 0) throw new Error('no death within 900 steps');
  return v.events.find((e) => e.kind === 'died')!.stepIndex;
}

/** Run through the respawn boundary (state leaves `respawning`). */
function runThroughRespawn(run: Run): void {
  let steps = 0;
  while (run.view().state === 'respawning' && steps < 600) {
    run.step();
    steps += 1;
  }
  if (run.view().state !== 'playing') throw new Error('did not return to `playing` after the respawn');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M3 safe respawn (packet 50: the runtime-owned R1–R7 reset transaction)', () => {
  it('death before a checkpoint: the capsule is re-placed at the START spawn (R1 destination)', async () => {
    const run = await startRespawnRun(COURSE_BEFORE_CP, walkRight(600));
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    const deathStep = runToFirstDeath(run);
    const v1 = run.view();
    expect(v1.events.find((e) => e.kind === 'died')!).toMatchObject({ cause: 'fall', boundary: false });
    expect(v1.respawnAtStep).toBe(deathStep + 1 + 30);

    // The capsule kept falling during the window (input gated, physics runs).
    expect(run.position().y).toBeLessThan(KILL_Y);

    runThroughRespawn(run);
    const v2 = run.view();
    expect(v2.state).toBe('playing');
    expect(v2.deathCount).toBe(1);
    expect(v2.events.find((e) => e.kind === 'respawned')!).toMatchObject({
      boundary: true,
      stepIndex: deathStep + 31,
      deathCount: 1,
    });
    // R1 destination = the start spawn (no checkpoint was activated): the
    // capsule is re-placed at (3, 0.91) — on the floor, NOT left in the pit.
    const pos = run.position();
    expect(pos.x).toBeGreaterThan(2.5);
    expect(pos.x).toBeLessThan(6);
    expect(pos.y).toBeGreaterThan(0.5);
    expect(v2.activeSpawnId).toBe(SPAWN_ID);
    // R4 cleared the velocity (the fall speed is gone) and the capsule is
    // grounded on the floor.
    expect(v2.playerMotion.speed).toBeLessThan(0.5);
    expect(v2.playerMotion.grounded).toBe(true);
    // No re-death at the boundary (the capsule is far from the pit).
    expect(v2.events.filter((e) => e.kind === 'died')).toHaveLength(1);
    run.dispose();
  }, 30000);

  it('death after a checkpoint: the capsule is re-placed at the checkpoint SAFE spawn (R1 destination)', async () => {
    const run = await startRespawnRun(COURSE_AFTER_CP, walkRight(900));
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    // Walk past the checkpoint (x=22) so it activates, then fall off the edge (x=30).
    let steps = 0;
    while (steps < 600 && run.view().checkpointId === null) {
      run.step();
      steps += 1;
    }
    expect(run.view().checkpointId).toBe('zone-cp');
    expect(run.view().activeSpawnId).toBe(SAFE_SPAWN_ID);
    // Now fall off the floor edge (x=30) and die.
    const deathStep = runToFirstDeath(run);
    expect(run.view().events.find((e) => e.kind === 'died')!).toMatchObject({ cause: 'fall' });

    runThroughRespawn(run);
    const v2 = run.view();
    expect(v2.state).toBe('playing');
    // R1 destination = the activated checkpoint's safe spawn (22, 0.91).
    const pos = run.position();
    expect(pos.x).toBeGreaterThan(21.5);
    expect(pos.x).toBeLessThan(24);
    expect(pos.y).toBeGreaterThan(0.5);
    expect(v2.activeSpawnId).toBe(SAFE_SPAWN_ID);
    expect(v2.playerMotion.grounded).toBe(true);
    expect(v2.events.filter((e) => e.kind === 'died')).toHaveLength(1);
    run.dispose();
  }, 30000);

  it('the reset clears the fall velocity, the jump windows and the render streak (prev == curr coherence)', async () => {
    const run = await startRespawnRun(COURSE_BEFORE_CP, walkRight(600));
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    runToFirstDeath(run);
    // Mid-fall: the capsule is moving (nonzero fall velocity).
    const falling = run.view();
    expect(falling.playerMotion.speed).toBeGreaterThan(1);
    // The last committed transform before the boundary (the capsule in the pit).
    const before = run.committed().find((t) => t.id === PLAYER_ID)!;
    expect(before.position[1]).toBeLessThan(KILL_Y);

    runThroughRespawn(run);
    const v2 = run.view();
    // The velocity is cleared (R4 `clearCharacterMotion`): the speed is ~0.
    expect(v2.playerMotion.speed).toBeLessThan(0.5);
    // The rebase (R7) + step-end promotion: the committed transform is at the
    // reset pose (on the floor), and the display shows it with no sweep —
    // the prev/curr coherence (no render streak between death and spawn).
    const after = run.committed().find((t) => t.id === PLAYER_ID)!;
    expect(after.position[0]).toBeGreaterThan(2.5);
    expect(after.position[0]).toBeLessThan(6);
    expect(after.position[1]).toBeGreaterThan(0.5);
    const disp = run.position();
    expect(disp.x).toBeGreaterThanOrEqual(after.position[0] - 1e-6);
    expect(disp.x).toBeLessThanOrEqual(after.position[0] + 1e-6);
    expect(disp.y).toBeGreaterThanOrEqual(after.position[1] - 1e-6);
    expect(disp.y).toBeLessThanOrEqual(after.position[1] + 1e-6);
    run.dispose();
  }, 30000);

  it('repeated deaths: each respawn re-places the capsule at the correct spawn', async () => {
    const run = await startRespawnRun(COURSE_BEFORE_CP, walkRight(1500));
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    // Three consecutive fall deaths, each respawn re-placing the capsule at
    // the start spawn (no checkpoint). The capsule walks back, falls, respawns.
    for (let death = 1; death <= 3; death += 1) {
      runToDeath(run, death);
      const v = run.view();
      expect(v.deathCount).toBe(death);
      // The capsule is in the pit (below killY) during the window.
      expect(run.position().y).toBeLessThan(KILL_Y);
      runThroughRespawn(run);
      const v2 = run.view();
      expect(v2.state).toBe('playing');
      expect(v2.deathCount).toBe(death);
      const pos = run.position();
      // Re-placed at the start spawn (3, 0.91) every time.
      expect(pos.x).toBeGreaterThan(2.5);
      expect(pos.x).toBeLessThan(6);
      expect(pos.y).toBeGreaterThan(0.5);
      expect(v2.playerMotion.grounded).toBe(true);
    }
    expect(run.view().deathCount).toBe(3);
    run.dispose();
  }, 30000);

  it('a blocked destination (the real R3 clearance probe) fail-stops with game_spawn_blocked/blocked', async () => {
    // The capsule starts at x=1 (on the floor, outside the wall); the start
    // spawn (x=3) is inside the wall. The pre-roll settles the capsule at x=1;
    // the `start` reset's R3 clearance probe (a query at the destination, x=3)
    // reports `blocked` — independent of the capsule's pose — and the runtime
    // fail-stops at step 13 (the first boundary) with `game_spawn_blocked` /
    // `blocked` (the real Rapier narrow-phase, no fault injection).
    const run = await startRespawnRun(COURSE_BLOCKED, walkRight(600));
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    let steps = 0;
    while (run.view().state !== 'playing' && run.view().failed === false && steps < 600) {
      run.step();
      steps += 1;
    }
    const v = run.view();
    // The `start` reset's R3 check fail-stopped at step 13: the view's state
    // is the session's `playing` (T1 sets it before R1), the runtime is
    // `failed` (the fail-stop). The `runStarted` boundary event IS appended
    // (published at the boundary, before R1–R7 — gameplay.md §3.2 item 0).
    expect(v.failed).toBe(true);
    expect(v.failure).toMatchObject({
      code: 'game_spawn_blocked',
      reason: 'blocked',
      stepIndex: 13,
      phase: 'reset:R3',
    });
    // A failure is never a death (no death occurred). The `runStarted`
    // boundary event IS present (published at the boundary); `respawned` is
    // absent (this is a `start` reset, not a `spawn` reset).
    expect(v.deathCount).toBe(0);
    expect(v.events.find((e) => e.kind === 'respawned')).toBeUndefined();
    expect(v.events.find((e) => e.kind === 'runStarted')).toBeDefined();
    // The run is over: the driver is cancelled.
    expect(run.runtime.gameCommand('start').ok).toBe(false);
    run.dispose();
  }, 30000);

  it('a failed runtime cannot resume (the driver is cancelled, the view is retained)', async () => {
    const run = await startRespawnRun(COURSE_BLOCKED, walkRight(600));
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    let steps = 0;
    while (run.view().failed === false && steps < 600) {
      run.step();
      steps += 1;
    }
    expect(run.view().failed).toBe(true);
    // The runtime is in the accepted `failed` state: the driver is cancelled,
    // so further ticks return `runtime_failed` (a failed instance is never
    // ticked again — the state is retained, no crash). The view's `state` is
    // the session's `playing` (the session's T1 sets it before R1); the
    // runtime's fail-stop is the `failed` flag.
    expect(run.runtime.tick(1e9).ok).toBe(false);
    expect(run.view().state).toBe('playing');
    // A run command on a failed runtime is rejected (the run is over).
    expect(run.runtime.gameCommand('start').ok).toBe(false);
    run.dispose();
  }, 30000);

  it('the snapshot is unchanged by the reset (the world is private, the authored scene is frozen)', async () => {
    const run = await startRespawnRun(COURSE_BEFORE_CP, walkRight(600));
    const before = JSON.stringify(run.runtime.getInterpolatedState());
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    runToFirstDeath(run);
    runThroughRespawn(run);
    const after = run.view();
    // The view's snapshotId is the same frozen snapshot (the reset is a
    // private world mutation; the authored scene is never edited).
    expect(after.snapshotId).toBe('demo-resp@r1');
    void before;
    run.dispose();
  }, 30000);

  it('injected failure at each reset phase (R1–R8): the exact pinned signatures', async () => {
    // Each reset phase failure fail-stops with its exact signature (pinned by
    // `fixtures/m3/gameplay/run/failure-phases.json`): code, reason, the 1-based
    // stepIndex (13, the first boundary), the `reset:<label>` phase, and the
    // last-committed-state claim (the step is abandoned, no `respawned` event,
    // a failure is never a death).
    const signatures: Record<string, { code: string; reason: string; phase: string }> = {
      R1: { code: 'game_spawn_invalid', reason: 'reference', phase: 'reset:R1' },
      R2: { code: 'game_spawn_blocked', reason: 'hazard', phase: 'reset:R2' },
      R3: { code: 'game_spawn_blocked', reason: 'blocked', phase: 'reset:R3' },
      R4: { code: 'physics_port_error', reason: 'reset', phase: 'reset:R4' },
      R5: { code: 'physics_port_error', reason: 'reset', phase: 'reset:R5' },
      R6: { code: 'module_error', reason: 'module_threw', phase: 'reset:R6' },
      R7: { code: 'module_error', reason: 'phase_violation', phase: 'reset:R7' },
      R8: { code: 'module_error', reason: 'phase_violation', phase: 'reset:R8' },
    };
    for (const [label, sig] of Object.entries(signatures)) {
      const run = await startRespawnRun(COURSE_BEFORE_CP, walkRight(600));
      expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
      const deathStep = runToFirstDeath(run);
      // Arm the fault at the phase; the due respawn fail-stops there.
      run.fault(label);
      let steps = 0;
      while (run.view().state !== 'failed' && steps < 600) {
        run.step();
        steps += 1;
      }
      const v = run.view();
      // The view's `state` is the session's state: the session's T5 sets it to
      // `playing` before the R1 check, so a reset-phase failure shows
      // `state: 'playing'` + `failed: true` (the runtime's fail-stop is the
      // `failed` flag, not the session's state — matching the fixture's
      // `fail-reset-R1` expected state).
      expect(v.state, `phase ${label}: state`).toBe('playing');
      expect(v.failed, `phase ${label}: failed`).toBe(true);
      expect(v.failure, `phase ${label}: failure`).toMatchObject({
        code: sig.code,
        reason: sig.reason,
        stepIndex: deathStep + 31,
        phase: sig.phase,
      });
      // A failure is never a death. The `respawned` boundary event IS present
      // (published at the boundary, before R1–R7 — gameplay.md §3.2 item 0).
      expect(v.deathCount, `phase ${label}: deathCount`).toBe(1);
      expect(v.events.find((e) => e.kind === 'respawned'), `phase ${label}: respawned`).toBeDefined();
      // The run is over: the driver is cancelled.
      expect(run.runtime.gameCommand('start').ok, `phase ${label}: cannot resume`).toBe(false);
      run.dispose();
    }
  }, 60000);

  it('stop during the respawn delay: the boundary still runs when the driver resumes', async () => {
    const run = await startRespawnRun(COURSE_BEFORE_CP, walkRight(600));
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    const deathStep = runToFirstDeath(run);
    const respawnAt = deathStep + 1 + 30;
    // Step a few steps into the window, then STOP (no ticks). The respawn is
    // still pending (the counter is step-based, not wall-clock).
    for (let i = 0; i < 5; i += 1) run.step();
    // (The driver is "stopped" — no ticks for an arbitrary duration.)
    // Resume: the boundary runs at the due step (the respawn re-places the
    // capsule at the start spawn).
    runThroughRespawn(run);
    const v = run.view();
    expect(v.state).toBe('playing');
    expect(v.events.find((e) => e.kind === 'respawned')!.stepIndex).toBe(respawnAt);
    expect(v.playerMotion.grounded).toBe(true);
    run.dispose();
  }, 30000);

  it('a buffered/held jump and a pending control intent do not leak across the reset', async () => {
    // The capsule holds a jump (jump 'held') as it walks off the edge and
    // dies. The reset (R6) clears the controller's jump windows and the
    // pending control intent. After the respawn, the capsule stands still at
    // the start spawn (no jump, no buffered move) — the windows/intent did
    // not leak across the reset.
    const frames: ActionFrame[] = [];
    // Hold the jump for the whole walk (a held jump that never releases).
    for (let i = 0; i < 600; i += 1) {
      const jump: ActionFrame['jump'] = i === 0 ? 'pressed' : 'held';
      frames.push(Object.freeze({ stepIndex: SETTLE_STEPS + i, moveX: 1, jump }));
    }
    const run = await startRespawnRun(COURSE_BEFORE_CP, frames);
    expect(run.runtime.gameCommand('start')).toEqual({ ok: true });
    runToFirstDeath(run);
    runThroughRespawn(run);
    const v = run.view();
    expect(v.state).toBe('playing');
    // After the respawn, the capsule is at the start spawn, grounded, with
    // no jump in progress (the held-jump window was cleared by R6). A held
    // jump across the reset would have launched the capsule (y >> 0.91).
    const pos = run.position();
    expect(pos.x).toBeGreaterThan(2.5);
    expect(pos.x).toBeLessThan(6);
    expect(pos.y).toBeLessThan(1.5); // not launched by a leaked jump
    expect(v.playerMotion.grounded).toBe(true);
    run.dispose();
  }, 30000);
});