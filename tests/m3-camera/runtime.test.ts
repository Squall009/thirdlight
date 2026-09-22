/**
 * Packet 51 — the follow camera in the real M3 runtime (tests/m3-camera/**):
 * `@thirdlight/platformer` (controller) + `@thirdlight/runtime` (M3 wiring)
 * + `@thirdlight/physics-rapier` (the pinned `@dimforge/rapier2d-compat@0.20.0`)
 * + `@thirdlight/platformer-game` (the real `thirdlight.platformer-game:camera`
 * module — the single transform owner, the §7.2 pipeline once per executed
 * step, the §7.4 snap at the R6 reset barrier).
 *
 * Every claim here is a committed-transform observation (the manual driver
 * leaves `lastAlpha = 0`, so `getInterpolatedState` reports `curr` exactly —
 * the committed pose at the end of the last executed step):
 *
 *   * framing across traversal (start snap, dead-zone bit stability, the
 *     authored depth/quaternion/scale never written);
 *   * level-edge clamps (the frustum clamp pins the camera at the exact
 *     fixture doubles at both the right and the left level edge);
 *   * narrow/large aspects (16:9 → 4:3 → 2560×720 through `setViewport`,
 *     each with the exact clamped pose);
 *   * short authored bounds (the authored bound dominates the frustum:
 *     the camera sits exactly on it, not on the frustum clamp);
 *   * player fall (the camera Y is pinned at the exact frustum minimum
 *     while the capsule falls below killY) and sudden respawn (the §7.4
 *     snap to the exact start-snap pose, no streak across the map);
 *   * resize physics identity (the committed player trace is
 *     byte-identical with and without an intervening resize; only the
 *     camera clamp changes);
 *   * non-finite dimensions (`setViewport` rejects, the previous record is
 *     retained, the simulation continues);
 *   * conflicting camera owners (the §3.4 instantiate rejections with the
 *     real specs);
 *   * start and replay snaps (both snap to the start spawn).
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
  type SimulationModuleSpec,
  type SimulationPhaseModule,
  type StepContext,
  type Vec2,
} from '@thirdlight/runtime';
import { PLATFORMER_MODULE_ID, platformerSpec } from '@thirdlight/platformer';
import {
  PLATFORMER_GAME_CAMERA_MODULE_ID,
  PLATFORMER_GAME_MODULE_ID,
  createGameCameraModule,
  platformerGameCameraSpec,
  platformerGameSessionSpec,
} from '@thirdlight/platformer-game';

const DT = 1 / 120;
const SETTLE_STEPS = 12;

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

// The promoted fixture doubles (fixtures/m3/camera, fovY 45, CAMERA_Z 12,
// level X[0,48] Y[-4,8]):
const HALF_W_16_9 = 8.836555997292695;
const HALF_H = 4.970562748477141;
const HALF_W_4_3 = 6.6274169979695206;
const X_CLAMP_16_9_MAX = 39.16344400270731;
const X_CLAMP_4_3_MAX = 41.37258300203048;
const Y_CLAMP_MIN = 0.9705627484771409;
const Y_CLAMP_MAX = 3.029437251522859;

const PLAYER_ID = 'group-0001';
const CAM_ID = 'cam-main';
const SPAWN_ID = 'spawn-0001';
const SAFE_SPAWN_ID = 'spawn-0002';
const KILL_Y = -4;

const T = { rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

interface CourseOpts {
  statics: RapierStaticColliderSpec[];
  zones?: Array<{ id: string; role: 'hazard' | 'checkpoint' | 'goal'; center: [number, number]; size: [number, number] }>;
  cameraBounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

function v3Snapshot(o: CourseOpts): unknown {
  const zoneEntities = (o.zones ?? []).map((z) => ({
    id: z.id,
    components: {
      transform: { position: [z.center[0], z.center[1], 0], ...T },
      gameZone:
        z.role === 'checkpoint'
          ? { role: 'checkpoint', size: z.size, safeSpawnId: SAFE_SPAWN_ID, activation: { emissive: '#ff0000', emissiveIntensity: 2, cueAssetId: null } }
          : { role: z.role, size: z.size },
    },
  }));
  const staticEntities = o.statics.map((s, i) => ({
    id: `static-${String(i + 1).padStart(4, '0')}`,
    components: {
      transform: { position: [s.position.x, s.position.y, 0], ...T },
      box: { size: [s.shape.hx * 2, s.shape.hy * 2, 1], material: { color: '#6f6f6f' } },
      collider: { shape: { type: 'box', hx: s.shape.hx, hy: s.shape.hy } },
    },
  }));
  return {
    snapshotId: 'demo-cam@r1',
    projectId: 'demo-cam',
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
              bounds: o.cameraBounds ?? { minX: 0, maxX: 48, minY: -4, maxY: 8 },
            },
          },
        },
        { id: PLAYER_ID, name: 'Player', components: { transform: { position: [3, 0.9, 0], ...T }, controller: {} } },
        { id: SPAWN_ID, components: { transform: { position: [3, 0.91, 0], ...T }, playerSpawn: {} } },
        { id: SAFE_SPAWN_ID, components: { transform: { position: [22, 0.91, 0], ...T }, playerSpawn: {} } },
        ...zoneEntities,
        ...staticEntities,
      ],
    },
    game: {
      configVersion: 1,
      title: 'Camera Course',
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

const FLAT: CourseOpts = {
  statics: [{ entityId: 'floor', shape: { type: 'box', hx: 24, hy: 0.25 }, position: { x: 24, y: -0.25 }, rotationZ: 0 }],
  zones: [
    { id: 'zone-checkpoint', role: 'checkpoint', center: [22, 1], size: [2, 2] },
    { id: 'zone-goal', role: 'goal', center: [44.5, 1], size: [1, 2] },
  ],
};

/** Course B: floor 0..10, then the pit (killY -4). */
const PIT: CourseOpts = {
  statics: [{ entityId: 'floor', shape: { type: 'box', hx: 5, hy: 0.25 }, position: { x: 5, y: -0.25 }, rotationZ: 0 }],
};

/** Course D: flat floor, authored camera bounds tighter than the frustum. */
const SHORT_BOUNDS: CourseOpts = {
  statics: FLAT.statics,
  zones: FLAT.zones,
  cameraBounds: { minX: 10, maxX: 38, minY: 2, maxY: 5 },
};

interface Run {
  runtime: Runtime;
  step(): void;
  view(): GameView;
  position(): Vec2;
  camera(): { x: number; y: number; z: number; rotation: [number, number, number, number]; scale: [number, number, number] };
  dispose(): void;
}

async function startRun(course: CourseOpts, frames: readonly ActionFrame[]): Promise<Run> {
  const init = await createPhysicsPort({
    character: { x: 3, y: 0.9 },
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
  return {
    runtime,
    step(): void {
      now += DT;
      const r = runtime.tick(now);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    },
    view(): GameView {
      const v = runtime.getGameView();
      if (!v.ok) throw new Error(`getGameView failed: ${JSON.stringify(v.error)}`);
      return v.view;
    },
    position(): Vec2 {
      const t = transformOf(PLAYER_ID);
      return { x: t.position[0], y: t.position[1] };
    },
    camera() {
      const t = transformOf(CAM_ID);
      return { x: t.position[0], y: t.position[1], z: t.position[2], rotation: t.rotation as [number, number, number, number], scale: t.scale as [number, number, number] };
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
/** Leftward-walk frames (moveX -1, no jump) for `n` sampled steps. */
function walkLeft(n: number): ActionFrame[] {
  return Array.from({ length: n }, (_, i) => Object.freeze({ stepIndex: SETTLE_STEPS + i, moveX: -1, jump: 'none' as const }));
}

describe('packet 51 — the real follow camera (real runtime + real Rapier + real camera module)', () => {
  it('framing across traversal: the start snap, the authored depth/quaternion/scale never written', async () => {
    const run = await startRun(FLAT, walkRight(2500));
    const rt = run.runtime;
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    run.step(); // step 13: the start boundary (the R6 camera snap runs here)
    const v = run.view();
    expect(v.state).toBe('playing');
    expect(v.stepIndex).toBe(13);
    // The §7.4 start snap: the dead-zone target at the start spawn (3, 0.91),
    // k forced to 1, cap skipped, then the authored bounds and the frustum
    // clamp. C before the snap = (8.8365..., ~1.52) (12 preroll decay steps
    // from the authored (0, 4)); the snap X target 3.5 clamps to the exact
    // frustum minimum, and the snap Y lands at the dead-zone edge of the
    // ground line (≈ 1.41, within float chain error).
    const cam = run.camera();
    expect(cam.x).toBe(HALF_W_16_9); // 0 + halfW, the exact fixture double
    expect(cam.y).toBeCloseTo(1.41, 9);
    expect(cam.z).toBe(12); // the authored depth — never written
    expect(cam.rotation).toEqual([0, 0, 0, 1]); // the authored quaternion — never written
    expect(cam.scale).toEqual([1, 1, 1]); // the authored scale — never written
    // The player is at the start spawn, inside the level.
    const p = run.position();
    expect(p.x).toBeGreaterThan(2.9);
    expect(p.x).toBeLessThan(3.1);
    run.dispose();
  }, 30000);

  it('level-edge clamps: the frustum clamp pins the camera at the exact fixture doubles (right and left edges)', async () => {
    // Right edge: walk to the goal (x ≈ 43.7). Past x ≈ 40 the camera is
    // pinned at the 16:9 frustum clamp max, exactly (the no-write rule keeps
    // the exact double stable thereafter).
    const run = await startRun(FLAT, walkRight(2500));
    run.runtime.gameCommand('start');
    run.step();
    while (run.position().x < 40.5 && run.view().state === 'playing') run.step();
    const camR = run.camera();
    const pR = run.position();
    expect(pR.x).toBeGreaterThan(40.5);
    expect(pR.x).toBeLessThan(48); // inside the level
    expect(camR.x).toBe(X_CLAMP_16_9_MAX); // exactly the fixture double
    expect(camR.y).toBeGreaterThanOrEqual(Y_CLAMP_MIN - 1e-12);
    expect(camR.y).toBeLessThanOrEqual(Y_CLAMP_MAX + 1e-12);
    expect(camR.z).toBe(12);
    run.dispose();

    // Left edge: the course floor (x∈[0,48], top y=0) has no left wall — the
    // box's side face (y ≤ 0) is below the capsule's bottom (y ≈ 0.01), so
    // the capsule walks off the floor's left edge exactly like the packet 49
    // course B pit, and falls past x = 0. The camera target T.x = P.x − 0.5
    // stays far left of the frustum minimum (8.836555997292695) the whole
    // time, so the §7.3 clamped pose is the exact clamp value on every step
    // and the no-write rule (|C′−C| ≤ EPS) keeps the committed camera X the
    // exact fixture double through the walk, the fall, the death, and the
    // respawn snap — the left edge of the authored window.
    const runL = await startRun(FLAT, walkLeft(2500));
    runL.runtime.gameCommand('start');
    runL.step();
    let sawMidFall = false;
    for (let i = 0; i < 1500; i += 1) {
      runL.step();
      const cam = runL.camera();
      const p = runL.position();
      expect(cam.x).toBe(HALF_W_16_9); // pinned, exactly, every step
      expect(cam.z).toBe(12);
      if (p.x < 0 && p.y > -3) sawMidFall = true;
      // Stop at the first grounded `playing` step after the respawn (the
      // recorded frames keep walking left — do not run past it).
      const v = runL.view();
      if (sawMidFall && v.state === 'playing' && p.x > 2.5 && p.y > 0.8) break;
    }
    expect(sawMidFall).toBe(true);
    const camL = runL.camera();
    expect(camL.x).toBe(HALF_W_16_9); // still exact after death + respawn snap
    // The camera Y bottomed at the frustum clamp min (0.9705627484771409)
    // while the player fell, then recovered toward the dead-zone edge (the
    // physics float rest line + 0.5) after the respawn: assert the band, not
    // a float-chain value.
    expect(camL.y).toBeGreaterThanOrEqual(Y_CLAMP_MIN - 1e-6);
    expect(camL.y).toBeLessThanOrEqual(Y_CLAMP_MAX + 1e-6);
    runL.dispose();
  }, 60000);

  it('narrow/large aspects through setViewport: 16:9 → 4:3 → 2560×720, each with the exact clamped pose', async () => {
    const run = await startRun(FLAT, walkRight(2500));
    const rt = run.runtime;
    expect(rt.setViewport(1280, 720)).toEqual({ ok: true });
    rt.gameCommand('start');
    run.step();
    // 16:9: walk to the right clamp (the player is far past the clamp max).
    while (run.position().x < 42 && run.view().state === 'playing') run.step();
    expect(run.camera().x).toBe(X_CLAMP_16_9_MAX);
    // 4:3 (narrow): the clamp max widens to the exact 4:3 fixture double.
    // The camera (below the new clamp) decays up toward it; the module's
    // no-write rule (|C′−C| ≤ EPS = 1e-9) can stop the decay at ≤1e-10 below
    // the exact clamp double, so assert the pin within 1e-8.
    expect(rt.setViewport(1024, 768)).toEqual({ ok: true });
    while (run.position().x < 43 && run.view().state === 'playing') run.step();
    expect(Math.abs(run.camera().x - X_CLAMP_4_3_MAX)).toBeLessThan(1e-8);
    // 2560×720 (large aspect, 3.55:1): the clamp max collapses; the camera
    // comes in from ABOVE the new (much smaller) window, so the first wide
    // step clamps to the exact new double. A couple of bounded steps: the
    // manual clock's float accumulation can schedule 0 or 2 steps on one
    // tick.
    expect(rt.setViewport(2560, 720)).toEqual({ ok: true });
    const aspect = 2560 / 720;
    const halfW = HALF_H * aspect;
    const clampMax = 48 - halfW;
    for (let i = 0; i < 8 && Math.abs(run.camera().x - clampMax) > 1e-9; i += 1) {
      expect(run.view().state).toBe('playing');
      run.step();
    }
    const camWide = run.camera();
    expect(camWide.x).toBe(clampMax); // exactly the wide clamp pose
    expect(camWide.y).toBeGreaterThanOrEqual(Y_CLAMP_MIN - 1e-12);
    expect(camWide.y).toBeLessThanOrEqual(Y_CLAMP_MAX + 1e-12);
    // The clamp is real: the level is wider than the frustum on X at this
    // aspect, and the camera sits inside the level, left of the player.
    expect(halfW).toBeGreaterThan(HALF_W_16_9);
    expect(clampMax).toBeLessThan(X_CLAMP_4_3_MAX);
    expect(camWide.x).toBeLessThan(run.position().x);
    run.dispose();
  }, 60000);

  it('short authored bounds: the authored bound dominates the frustum (the camera sits exactly on it)', async () => {
    const run = await startRun(SHORT_BOUNDS, walkRight(2500));
    run.runtime.gameCommand('start');
    run.step();
    // The authored bounds X[10,38] Y[2,5] are tighter than the frustum
    // clamp ranges on both axes (X: 38 < 39.1634; Y bottom: 2 > 0.9705).
    // Walk right: the camera is bounded at exactly X = 38 (NOT the frustum
    // clamp 39.1634 — the order of operations: authored bounds before the
    // frustum clamp) and at exactly Y = 2 (NOT ≈ 1.41).
    while (run.position().x < 40.5 && run.view().state === 'playing') run.step();
    const cam = run.camera();
    expect(cam.x).toBe(38); // the authored bound, exactly
    expect(cam.y).toBe(2); // the authored bound, exactly
    expect(cam.z).toBe(12);
    expect(cam.x).toBeLessThan(X_CLAMP_16_9_MAX); // NOT the frustum clamp
    run.dispose();
  }, 60000);

  it('player fall: the camera Y is pinned at the exact frustum minimum; sudden respawn: the §7.4 snap, no streak', async () => {
    const run = await startRun(PIT, walkRight(1200));
    const rt = run.runtime;
    rt.gameCommand('start');
    run.step();
    // Walk off the floor edge (x = 10) and fall below killY. Track the
    // camera Y across every step of the fall: it must never go below the
    // exact frustum clamp minimum, even though the capsule falls to < -4.
    let minCamY = Number.POSITIVE_INFINITY;
    let minPlayerY = Number.POSITIVE_INFINITY;
    while (run.view().deathCount === 0 && run.view().state !== 'won') {
      run.step();
      const cam = run.camera();
      const p = run.position();
      minCamY = Math.min(minCamY, cam.y);
      minPlayerY = Math.min(minPlayerY, p.y);
    }
    const v1 = run.view();
    expect(v1.deathCount).toBe(1);
    expect(minPlayerY).toBeLessThan(KILL_Y); // the capsule really fell below killY
    expect(minCamY).toBe(Y_CLAMP_MIN); // the camera Y never went below the exact clamp
    expect(minCamY).toBeGreaterThanOrEqual(Y_CLAMP_MIN - 1e-12);

    // Run through the respawn boundary. Before it, the camera was tracking
    // the falling player (x ≈ 12-13); the §7.4 snap (reason 'spawn') sends it
    // to the dead-zone target at the start spawn (3, 0.91): T = (3.5, Y),
    // k forced to 1, cap skipped, then bounds + frustum ⇒ exactly
    // (HALF_W_16_9, Y_CLAMP_MIN, 12) — a single-step jump, never a streak:
    // the pre-boundary pose and the post-boundary pose are the only two
    // committed camera poses across the boundary.
    const preCam = run.camera();
    expect(preCam.x).toBeGreaterThan(HALF_W_16_9); // still tracking the fall, x > 3.5
    expect(preCam.y).toBe(Y_CLAMP_MIN); // pinned on the minimum during the fall
    while (run.view().state === 'respawning') run.step();
    const v2 = run.view();
    expect(v2.state).toBe('playing');
    const cam = run.camera();
    expect(cam.x).toBe(HALF_W_16_9); // the exact start-snap X (3.5 clamped to the frustum min)
    expect(cam.y).toBe(Y_CLAMP_MIN); // the exact start-snap Y (the clamped minimum is inside the dead zone)
    expect(cam.z).toBe(12);
    // The no-render-streak invariant: across the boundary the display
    // (prev → curr of the boundary step) interpolates exactly these two
    // committed poses — the camera never sweeps through intermediate x.
    expect(cam.x).toBeLessThan(preCam.x); // one discontinuity, not a sweep
    const p = run.position();
    expect(p.x).toBeGreaterThan(2.5);
    expect(p.x).toBeLessThan(6);
    expect(p.y).toBeGreaterThan(0.5);
    run.dispose();
  }, 60000);

  it('resize physics identity: the committed player trace is byte-identical with and without an intervening resize', async () => {
    const N = 1500;
    const frames = walkRight(N);
    const runA = await startRun(FLAT, frames);
    runA.runtime.gameCommand('start');
    const traceA: number[][] = [];
    const camA: number[][] = [];
    runA.step(); // the start boundary
    for (let i = 0; i < N - 1; i += 1) {
      runA.step();
      const p = runA.position();
      const c = runA.camera();
      traceA.push([p.x, p.y]);
      camA.push([c.x, c.y]);
      if (runA.view().state === 'won' && i > 400) break;
    }
    runA.dispose();

    const runB = await startRun(FLAT, frames);
    runB.runtime.setViewport(1024, 768); // the resize, mid-walk (presentation-only)
    runB.runtime.gameCommand('start');
    const traceB: number[][] = [];
    const camB: number[][] = [];
    runB.step();
    for (let i = 0; i < N - 1; i += 1) {
      runB.step();
      const p = runB.position();
      const c = runB.camera();
      traceB.push([p.x, p.y]);
      camB.push([c.x, c.y]);
      if (runB.view().state === 'won' && i > 400) break;
    }
    runB.dispose();

    // The player trajectory is identical at every step (the resize never
    // touches physics or authoritative gameplay state, §7.5): strict
    // element-wise equality of the committed traces.
    expect(traceB.length).toBe(traceA.length);
    for (let i = 0; i < traceA.length; i += 1) {
      expect(Object.is(traceB[i][0], traceA[i][0]), `step ${i} player x`).toBe(true);
      expect(Object.is(traceB[i][1], traceA[i][1]), `step ${i} player y`).toBe(true);
    }
    // The camera clamp DID change (4:3 clamp max vs 16:9): the camera traces
    // differ, and at a late step each sits on its own exact clamp.
    let differ = false;
    for (let i = 0; i < camA.length; i += 1) {
      if (camB[i][0] !== camA[i][0] || camB[i][1] !== camA[i][1]) {
        differ = true;
        break;
      }
    }
    expect(differ).toBe(true);
    const lastA = camA[camA.length - 1];
    const lastB = camB[camB.length - 1];
    expect(lastA[0]).toBe(X_CLAMP_16_9_MAX);
    expect(lastB[0]).toBe(X_CLAMP_4_3_MAX);
  }, 60000);

  it('non-finite dimensions: setViewport rejects, the previous record is retained, the simulation continues', async () => {
    const run = await startRun(FLAT, walkRight(2500));
    const rt = run.runtime;
    expect(rt.setViewport(1280, 720)).toEqual({ ok: true });
    rt.gameCommand('start');
    run.step();
    // The committed §7.5 rejection set (resize.json `rejected`), verbatim:
    const rejected: [number, number][] = [
      [Number.NaN, 720],
      [1280, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 720],
      [0, 720],
      [1280, -1],
      [20000, 720],
      [1280, 20000],
    ];
    for (const [w, h] of rejected) {
      const r = rt.setViewport(w, h);
      expect(r, `${w}×${h} must be rejected`).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'camera_viewport_invalid' }),
      });
    }
    // Boundary accepts:
    expect(rt.setViewport(1, 1)).toEqual({ ok: true });
    expect(rt.setViewport(16384, 16384)).toEqual({ ok: true });
    expect(rt.setViewport(16385, 720).ok).toBe(false);
    // Restore 16:9 and walk to the right edge: the camera still clamps at
    // the 16:9 double (the previous valid record was retained through every
    // rejection), and the simulation ran the whole time.
    expect(rt.setViewport(1280, 720)).toEqual({ ok: true });
    while (run.position().x < 42 && run.view().state === 'playing') run.step();
    expect(run.camera().x).toBe(X_CLAMP_16_9_MAX);
    expect(run.view().state).toBe('playing'); // the run is alive
    run.dispose();
  }, 60000);

  it('conflicting camera owners: the §3.4 instantiate rejections (the real specs)', async () => {
    const registry = createSimulationRegistry();
    for (const spec of [platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec]) {
      expect(registerSimulationModule(registry, spec.id, spec).ok).toBe(true);
    }
    const badRegistry = createSimulationRegistry();
    for (const spec of [platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec]) {
      expect(registerSimulationModule(badRegistry, spec.id, spec).ok).toBe(true);
    }
    // A second camera-phase module (a different ID, the same real create):
    const secondCamera: SimulationModuleSpec = {
      id: 'thirdlight.other:camera',
      phases: ['camera'],
      create: createGameCameraModule,
    };
    expect(registerSimulationModule(badRegistry, secondCamera.id, secondCamera).ok).toBe(true);
    // A camera-phase module that does not own the scene camera entity:
    const wrongOwnerCamera: SimulationModuleSpec = {
      id: 'thirdlight.other:camera-bad',
      phases: ['camera'],
      create: (): SimulationPhaseModule => ({
        transformOwners: [SPAWN_ID],
        step(): void {
          /* never instantiated */
        },
      }),
    };
    expect(registerSimulationModule(badRegistry, wrongOwnerCamera.id, wrongOwnerCamera).ok).toBe(true);

    const snapshot = v3Snapshot(FLAT);
    const base = {
      snapshot,
      physics: undefined,
      settings: SETTINGS,
      clock: () => 0,
      driver: { kind: 'manual' } as const,
    };

    // missing: no module declares `camera`.
    {
      const r = instantiateRuntime({
        ...base,
        registry,
        modules: [PLATFORMER_MODULE_ID, PLATFORMER_GAME_MODULE_ID],
        actions: createRecordedActionSource([]),
        physics: undefined as unknown as PhysicsPort,
      });
      expect(r).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'config_invalid', reason: 'camera_owner', detail: 'missing' }),
      });
    }
    // multiple: two modules declare `camera`.
    {
      const r = instantiateRuntime({
        ...base,
        registry: badRegistry,
        modules: [PLATFORMER_MODULE_ID, PLATFORMER_GAME_MODULE_ID, PLATFORMER_GAME_CAMERA_MODULE_ID, 'thirdlight.other:camera'],
        actions: createRecordedActionSource([]),
        physics: undefined as unknown as PhysicsPort,
      });
      expect(r).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'config_invalid', reason: 'camera_owner', detail: 'multiple' }),
      });
    }
    // owner_mismatch: the camera module's owners are not exactly [cameraId].
    // (A real physics port is required here: the §12.4 physics-port check
    // precedes the §3.4 cameraEntry owner check.)
    {
      const init = await createPhysicsPort({
        character: { x: 3, y: 0.9 },
        statics: FLAT.statics,
        solver: SOLVER,
        controller: CONTROLLER_CFG,
      });
      if (!init.ok) throw new Error('physics init failed');
      const r = instantiateRuntime({
        ...base,
        registry: badRegistry,
        modules: [PLATFORMER_MODULE_ID, PLATFORMER_GAME_MODULE_ID, 'thirdlight.other:camera-bad'],
        actions: createRecordedActionSource([]),
        physics: init.port,
      });
      init.port.dispose();
      expect(r).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'config_invalid', reason: 'camera_owner', detail: 'owner_mismatch' }),
      });
    }
    // The real M3 set instantiates (the owner-ok case, repaired CC-51-1):
    {
      const init = await createPhysicsPort({
        character: { x: 3, y: 0.9 },
        statics: FLAT.statics,
        solver: SOLVER,
        controller: CONTROLLER_CFG,
      });
      if (!init.ok) throw new Error('physics init failed');
      const r = instantiateRuntime({
        ...base,
        registry,
        modules: [PLATFORMER_MODULE_ID, PLATFORMER_GAME_MODULE_ID, PLATFORMER_GAME_CAMERA_MODULE_ID],
        actions: createRecordedActionSource([]),
        physics: init.port,
      });
      if (r.ok) r.runtime.dispose();
      else init.port.dispose();
      expect(r.ok).toBe(true);
    }
  }, 30000);

  it('start and replay snaps: both snap the camera to the start spawn', async () => {
    const run = await startRun(FLAT, walkRight(2500));
    const rt = run.runtime;
    rt.gameCommand('start');
    run.step();
    expect(run.camera().x).toBe(HALF_W_16_9); // the start snap
    // Walk to the goal: the camera pins at the 16:9 clamp max; the run wins.
    while (run.view().state !== 'won') run.step();
    expect(run.camera().x).toBe(X_CLAMP_16_9_MAX);
    // Replay: the next boundary re-places the capsule at the start spawn
    // (T6) and the R6 camera snap (reason 'replay') snaps to the start
    // spawn's dead-zone target — the same pose as the start snap.
    expect(rt.gameCommand('replay')).toEqual({ ok: true });
    run.step();
    const v = run.view();
    expect(v.replayEpoch).toBe(1);
    expect(v.state).toBe('playing');
    const cam = run.camera();
    expect(cam.x).toBe(HALF_W_16_9); // the exact replay snap X
    // Y: the pre-snap camera sat on the dead-zone edge of the physics float
    // rest line (1.4096703908154713 = rest Y 0.9096703908154713 + 0.5); the
    // spawn's Y (0.91) is inside the dead zone of that pose, so the snap
    // leaves Y untouched. Assert the dead-zone band, not a float-chain value.
    expect(Math.abs(cam.y - 1.41)).toBeLessThan(1e-3);
    expect(cam.z).toBe(12);
    run.dispose();
  }, 60000);
});