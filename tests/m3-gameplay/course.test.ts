/**
 * Packet 49 — the real-course M3 run (tests/m3-gameplay/**): every accepted
 * piece composed for real —
 *
 *   `@thirdlight/platformer` (the controller module)
 *   + `@thirdlight/runtime` (M3 wiring: boundary, run state, view, override)
 *   + `@thirdlight/physics-rapier` (the pinned `@dimforge/rapier2d-compat@0.20.0`)
 *   + `@thirdlight/platformer-game` (the pure gameplay-phase session module:
 *     the swept §4.2 zone predicate over the runtime's motion segments, and —
 *     packet 51 — the real `camera`-phase follow module: the single camera
 *     transform owner, the §7.2 pipeline and the §7.4 reset snap)
 *
 * The course is a flat test course (not the M2 frozen course): the zone
 * geometry comes from the v3 scene (`components.gameZone`), the physics
 * statics from the injected port — the same world both describe. Nothing
 * here is a mock of the engine or of the camera: the camera assertions are
 * on the real module's committed writes (owner write, viewport-driven
 * clamp, authored-depth invariant).
 *
 * Packet-49 scope (gameplay.md §5.1): the due reset is the QUEUED-REQUEST
 * NO-OP SEAM — the run-state bookkeeping (T2/T5, the `died`/`respawned`
 * events, the counters, the boundary) is real; the physical re-placement
 * (R1–R7 over `PhysicsResetPort`) is packet 50. The tests assert the run
 * surface accordingly and never claim a respawned position.
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

const DT = 1 / 120;
const SETTLE_STEPS = 12;

// ---------------------------------------------------------------------------
// The test course
// ---------------------------------------------------------------------------

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

interface Course {
  /** The physics statics (and the scene's collider entities). */
  statics: RapierStaticColliderSpec[];
  /** Hazard/checkpoint/goal zones in the v3 scene. */
  zones: Array<{ id: string; role: 'hazard' | 'checkpoint' | 'goal'; center: [number, number]; size: [number, number] }>;
}

/** Course A: flat floor 0..48, a checkpoint at 22 and the goal at 44.5. */
const COURSE_A: Course = {
  statics: [{ entityId: 'floor', shape: { type: 'box', hx: 24, hy: 0.25 }, position: { x: 24, y: -0.25 }, rotationZ: 0 }],
  zones: [
    { id: 'zone-checkpoint', role: 'checkpoint', center: [22, 1], size: [2, 2] },
    { id: 'zone-goal', role: 'goal', center: [44.5, 1], size: [1, 2] },
  ],
};

/** Course B: floor 0..10, then the pit (killY -4). */
const COURSE_B: Course = {
  statics: [{ entityId: 'floor', shape: { type: 'box', hx: 5, hy: 0.25 }, position: { x: 5, y: -0.25 }, rotationZ: 0 }],
  zones: [],
};

/** Course C: flat floor + a hazard strip on the walking path (fixture pattern). */
const COURSE_C: Course = {
  statics: [{ entityId: 'floor', shape: { type: 'box', hx: 24, hy: 0.25 }, position: { x: 24, y: -0.25 }, rotationZ: 0 }],
  zones: [{ id: 'zone-hazard-01', role: 'hazard', center: [15, 0.125], size: [0.8, 0.25] }],
};

const PLAYER_ID = 'group-0001';
const CAM_ID = 'cam-main';
const SPAWN_ID = 'spawn-0001';
const SAFE_SPAWN_ID = 'spawn-0002';
const KILL_Y = -4;

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
    snapshotId: 'demo-m3t@r1',
    projectId: 'demo-m3t',
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
            transform: { position: [3, 0.9, 0], ...T },
            controller: {},
          },
        },
        { id: SPAWN_ID, components: { transform: { position: [3, 0.91, 0], ...T }, playerSpawn: {} } },
        { id: SAFE_SPAWN_ID, components: { transform: { position: [22, 0.91, 0], ...T }, playerSpawn: {} } },
        ...zoneEntities,
        ...staticEntities,
      ],
    },
    game: {
      configVersion: 1,
      title: 'M3 Test Course',
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

// ---------------------------------------------------------------------------
// Harness (packet 51: the real camera module — the single camera owner)
// ---------------------------------------------------------------------------

interface Run {
  runtime: Runtime;
  /** Advance one executed fixed step (the manual driver, one step per tick). */
  step(): void;
  view(): GameView;
  position(): Vec2;
  /** The committed camera transform (the camera phase's owned write, §7.1). */
  camera(): { x: number; y: number; z: number };
  dispose(): void;
}

async function startCourseRun(course: Course, frames: readonly ActionFrame[]): Promise<Run> {
  const start = { x: 3, y: 0.9 };
  const init = await createPhysicsPort({
    character: start,
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
  const transformOf = (id: string) => {
    const s = runtime.getInterpolatedState();
    if (!s.ok) throw new Error('getInterpolatedState failed');
    const t = s.state.transforms.find((x) => x.id === id);
    if (!t) throw new Error(`transform ${id} missing`);
    return t;
  };
  const position = (): Vec2 => {
    const t = transformOf(PLAYER_ID);
    return { x: t.position[0], y: t.position[1] };
  };
  const camera = (): { x: number; y: number; z: number } => {
    const t = transformOf(CAM_ID);
    return { x: t.position[0], y: t.position[1], z: t.position[2] };
  };
  return {
    runtime,
    step(): void {
      now += DT;
      if (!runtime.tick(now).ok) throw new Error('tick failed');
    },
    view(): GameView {
      const v = runtime.getGameView();
      if (!v.ok) throw new Error(`getGameView failed: ${JSON.stringify(v.error)}`);
      return v.view;
    },
    position,
    camera,
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

function kinds(view: GameView): string[] {
  return view.events.map((e) => e.kind);
}

// ---------------------------------------------------------------------------
// courses
// ---------------------------------------------------------------------------

describe('M3 real course (run state, zones, committed view; the real respawn — packet 50)', () => {
  it('course A: start → checkpoint → goal (the full happy path, real physics + real session module)', async () => {
    const run = await startCourseRun(COURSE_A, walkRight(2000));
    const rt = run.runtime;
    // The pre-roll settle: the capsule rests at the M2 flat-rest centre.
    const rest = run.position();
    expect(rest.y).toBeCloseTo(0.91, 2);
    expect(rest.x).toBeCloseTo(3, 3);
    expect(run.view().state).toBe('awaitingStart');

    expect(rt.gameCommand('start')).toEqual({ ok: true });
    // The first boundary after the settle is step 13: the `start` command
    // is consumed there (runStarted@13) and the walk begins.
    run.step();
    let v = run.view();
    expect(v.state).toBe('playing');
    expect(v.stepIndex).toBe(13);
    expect(v.runId).toBe('demo-m3t@r1#0');
    expect(v.events).toMatchObject([{ id: 'demo-m3t@r1#0/runStarted/13', kind: 'runStarted', stepIndex: 13, boundary: true }]);
    expect(v.playerMotion.grounded).toBe(true);

    // Walk to the checkpoint (x > ~20.7 ⇒ the swept overlap) — a bounded
    // search: the zone crossing is deterministic, so 900 steps suffice
    // (4 m/s ⇒ ~41 m in ~1250 steps; the checkpoint is at ~18 m).
    let steps = 1;
    while (steps < 900 && run.view().checkpointId === null) {
      run.step();
      steps += 1;
    }
    v = run.view();
    expect(v.checkpointId).toBe('zone-checkpoint');
    expect(v.checkpointActive).toBe(true);
    expect(v.activeSpawnId).toBe(SAFE_SPAWN_ID); // the activated checkpoint's safeSpawnId
    const cpEvent = v.events.find((e) => e.kind === 'checkpointActivated');
    expect(cpEvent).toMatchObject({ zoneId: 'zone-checkpoint', boundary: false });
    // The capsule is still running at the committed motion's speed band.
    expect(v.playerMotion.speed).toBeGreaterThan(3);
    expect(v.playerMotion.speed).toBeLessThanOrEqual(4.5);
    expect(v.playerMotion.grounded).toBe(true);

    // Walk on to the goal (x > ~43.7). The single-activation guard holds:
    // re-crossing the checkpoint zone emits no second event.
    while (steps < 2000 && !run.view().goalReached) {
      run.step();
      steps += 1;
    }
    v = run.view();
    expect(v.state).toBe('won');
    expect(v.goalReached).toBe(true);
    expect(v.deathCount).toBe(0);
    expect(kinds(v)).toEqual(['runStarted', 'checkpointActivated', 'goalReached']);
    expect(v.eventCount).toBe(3);
    expect(v.events.at(-1)).toMatchObject({ zoneId: 'zone-goal', boundary: false });
    expect(v.activeSpawnId).toBe(SAFE_SPAWN_ID);

    // The camera phase wrote the camera entity (the real camera module —
    // packet 51's single camera owner), keeping the authored depth.
    // The capsule stopped at the goal (x ≈ 44), far past the 16:9 frustum
    // clamp max, so the camera is pinned at the clamped double (up to the
    // module's no-write EPS 1e-9 — the decay can stop at ≤1e-10 below the
    // clamp); the camera Y sits at the dead-zone edge of the physics float
    // rest line (0.9096703908154713 + 0.5 = 1.4096703908154713 — the
    // solver's settled rest Y is not exactly the authored 0.91, so assert
    // the dead-zone band, not a float-chain value); the viewport record is
    // read in the camera phase (16:9 by default).
    expect(rt.setViewport(1280, 720)).toEqual({ ok: true });
    run.step(); // a `won` step: the phases still run (evaluation is frozen)
    const camPos = run.camera();
    const player = run.position();
    expect(Math.abs(camPos.x - 39.16344400270731)).toBeLessThan(1e-8); // the 16:9 frustum clamp max (48 − 12·tan(22.5°)·16/9)
    expect(Math.abs(camPos.y - 1.41)).toBeLessThan(1e-3); // the dead-zone edge of the rest line
    expect(camPos.z).toBe(12); // the authored depth, untouched
    expect(camPos.x).toBeLessThan(player.x); // the camera lags the goal-bound player at the clamp

    // After `won`, `start` is invalid (the state is not `awaitingStart`);
    // `replay` is accepted (valid in `won`) and consumed at the next
    // boundary (T6: fresh epoch, the checkpoint latch and counters reset).
    // Packet 50: the `replay` reset re-places the capsule at the START
    // spawn (the R1 destination for a `replay`/`start` reset) — the capsule
    // is no longer standing inside the goal zone, so the run does NOT re-win
    // at the boundary; it walks back from the start spawn (state `playing`).
    expect(rt.gameCommand('start').ok).toBe(false);
    expect(rt.gameCommand('replay')).toEqual({ ok: true });
    run.step();
    v = run.view();
    expect(v.replayEpoch).toBe(1);
    expect(v.runId).toBe('demo-m3t@r1#1');
    expect(v.state).toBe('playing'); // re-placed at the start spawn, not the goal
    expect(v.goalReached).toBe(false);
    expect(v.deathCount).toBe(0);
    expect(v.checkpointId).toBeNull(); // T6 reset the checkpoint latch
    expect(kinds(v)).toEqual(['runStarted', 'checkpointActivated', 'goalReached', 'replayed']);
    // The capsule is re-placed at the start spawn (the R1 destination), on
    // the floor, grounded.
    const replayPos = run.position();
    expect(replayPos.x).toBeGreaterThan(2.5);
    expect(replayPos.x).toBeLessThan(6);
    expect(replayPos.y).toBeGreaterThan(0.5);
    expect(v.playerMotion.grounded).toBe(true);
    const replayed = v.events.find((e) => e.kind === 'replayed')!;
    expect(replayed).toMatchObject({ boundary: true });
    expect(replayed.id).toBe(`demo-m3t@r1#1/replayed/${replayed.stepIndex}`); // the new epoch's runId
    // Packet 51: the replay boundary's R6 camera snap (reason 'replay')
    // re-snapped the camera to the start spawn's dead-zone target — the
    // exact 16:9 frustum clamp min, with the authored depth untouched.
    const camReplay = run.camera();
    expect(camReplay.x).toBe(8.836555997292695);
    expect(Math.abs(camReplay.y - 1.41)).toBeLessThan(1e-3); // the pre-snap dead-zone edge (the spawn Y is inside the dead zone)
    expect(camReplay.z).toBe(12);
    run.dispose();
  }, 30000);

  it('course B: the fall death (T2 cause fall) and the real respawn (the reset re-places the capsule at the start spawn)', async () => {
    const run = await startCourseRun(COURSE_B, walkRight(600));
    const rt = run.runtime;
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    // Walk off the floor edge (x = 10) and fall below killY (-4).
    let steps = 0;
    while (steps < 600 && run.view().deathCount === 0) {
      run.step();
      steps += 1;
    }
    const v1 = run.view();
    expect(v1.deathCount).toBe(1);
    expect(v1.state).toBe('respawning');
    const died = v1.events.find((e) => e.kind === 'died')!;
    expect(died).toMatchObject({ kind: 'died', cause: 'fall', boundary: false });
    expect(died.zoneId).toBeUndefined(); // a fall carries no zone
    const deathStep = died.stepIndex;
    expect(v1.respawnAtStep).toBe(deathStep + 1 + 30);

    // The capsule kept falling during the respawn window (the physics runs;
    // the input is gated — the effective frame is neutral).
    const yDuringRespawn = run.position().y;
    expect(yDuringRespawn).toBeLessThan(KILL_Y);

    // Run through the respawn boundary (deathStep + 31): the `respawned`
    // event, the state back to `playing`, the capsule re-placed at the start
    // spawn (the real reset — packet 50's R1–R7 transaction). No checkpoint
    // was activated, so the destination is the start spawn (3, 0.91).
    while (run.view().state === 'respawning' && steps < 600) {
      run.step();
      steps += 1;
    }
    const v2 = run.view();
    expect(v2.state).toBe('playing');
    expect(v2.deathCount).toBe(1);
    const respawned = v2.events.find((e) => e.kind === 'respawned')!;
    expect(respawned).toMatchObject({ kind: 'respawned', boundary: true, stepIndex: deathStep + 31, deathCount: 1 });
    // The capsule is re-placed at the start spawn (NOT left in the pit):
    // on the floor, grounded, near the start x. No re-death at the boundary
    // (the capsule is far from the pit); it walks back and dies again later.
    const pos = run.position();
    expect(pos.x).toBeGreaterThan(2.5);
    expect(pos.x).toBeLessThan(6);
    expect(pos.y).toBeGreaterThan(0.5);
    expect(v2.playerMotion.grounded).toBe(true);
    expect(v2.events.filter((e) => e.kind === 'died')).toHaveLength(1);
    // The run surface is fully committed at the boundary.
    expect(v2.activeSpawnId).toBe(SPAWN_ID); // no checkpoint was activated
    run.dispose();
  }, 30000);

  it('course C: the hazard death (T2 cause hazard, zone id) and the real respawn (the reset re-places the capsule at the start spawn)', async () => {
    const run = await startCourseRun(COURSE_C, walkRight(600));
    const rt = run.runtime;
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    let steps = 0;
    while (steps < 600 && run.view().deathCount === 0) {
      run.step();
      steps += 1;
    }
    const v1 = run.view();
    expect(v1.deathCount).toBe(1);
    const died = v1.events.find((e) => e.kind === 'died')!;
    expect(died).toMatchObject({ kind: 'died', cause: 'hazard', zoneId: 'zone-hazard-01', boundary: false });
    const deathStep = died.stepIndex;

    // The respawn boundary (deathStep + 31): the `respawned` event, the state
    // back to `playing`, the capsule re-placed at the start spawn (the real
    // reset) — far from the hazard, so no re-death at the boundary.
    while (run.view().state === 'respawning' && steps < 600) {
      run.step();
      steps += 1;
    }
    const v2 = run.view();
    expect(v2.state).toBe('playing');
    expect(v2.deathCount).toBe(1);
    const respawned = v2.events.find((e) => e.kind === 'respawned')!;
    expect(respawned.stepIndex).toBe(deathStep + 31);
    const diedAgain = v2.events.filter((e) => e.kind === 'died');
    expect(diedAgain).toHaveLength(1); // no re-death at the boundary
    // The capsule is re-placed at the start spawn (far from the hazard):
    // on the floor, grounded.
    const pos = run.position();
    expect(pos.x).toBeGreaterThan(2.5);
    expect(pos.x).toBeLessThan(6);
    expect(pos.y).toBeGreaterThan(0.5);
    expect(v2.playerMotion.grounded).toBe(true);
    run.dispose();
  }, 30000);
});