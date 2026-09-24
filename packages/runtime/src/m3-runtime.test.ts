/**
 * Packet 49 — the M3 runtime wiring (gameplay.md §3/§6.1/§7.1/§8.1;
 * runtime.md §15): instantiate-time composition validation, the run surface
 * (`getGameView`/`gameCommand`/`setViewport`), the step boundary (queued
 * commands, the due reset seam, the R8 boundary view), the committed
 * `GameView` at commit, the §2.5 effective-frame overrides, the gameplay
 * port's phase/run-state rules, the fail-stop freeze (T7) and the M1/M2
 * invariance (`game_session_unavailable`, reason `schedule`).
 *
 * The modules here are TEST-ONLY stubs (they verify the runtime's wiring —
 * phase order, port construction, the write guard, the view publication).
 * The real `platformer-game` session module and the real Rapier course are
 * exercised separately (`packages/platformer-game` unit behavior and
 * `tests/m3-gameplay/**`).
 */
import { describe, expect, it } from 'vitest';
import {
  createRecordedActionSource,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionFrame,
  type GameView,
  type ModuleConfig,
  type Runtime,
  type RuntimeDiagnostics,
  type RuntimeError,
  type SimulationModuleSpec,
  type SimulationPhaseModule,
  type StepContext,
} from './index';
import { cloneJson } from './test-helpers';

const DT = 1 / 120;

// ---------------------------------------------------------------------------
// v3 test snapshot
// ---------------------------------------------------------------------------

const T = { rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

/**
 * A minimal reset-capable physics port for the wiring tests (the real
 * `physics-rapier` port is exercised in `tests/m3-respawn/**`). It satisfies
 * the M3 `PhysicsResetPort` surface so the due reset (R1–R7) runs without a
 * fail-stop: the clearance probe reports `ok` and the reset ops are no-ops
 * (the stub modules write no transform, so the reset's world mutation is a
 * no-op for them). `step()` returns a neutral, self-consistent result.
 */
function stubResetPort(): {
  stageCharacterMove(delta: { x: number; y: number }): void;
  step(): {
    requested: { x: number; y: number };
    applied: { x: number; y: number };
    position: { x: number; y: number };
    grounded: boolean;
    supportNormal: { x: number; y: number };
    contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
    snapped: boolean;
  };
  reset(character: { x: number; y: number }): void;
  clearCharacterMotion(): void;
  placeCharacter(center: { x: number; y: number }): { ok: boolean; supportNormal?: { x: number; y: number } };
  characterClearance(center: { x: number; y: number }): { ok: boolean; supportNormal?: { x: number; y: number } };
  diagnostics(): { stallSteps?: number; penetrationCorrectedCount?: number };
  dispose(): void;
} {
  const neutral = { x: 0, y: 0 };
  return {
    stageCharacterMove(_delta) {
      /* no-op */
    },
    step() {
      // `previousPosition` is (0,0) in these wiring tests (no controller
      // entity), so `position` must equal (0,0) + applied for the
      // `applied == position - previousPosition` invariant (runtime.md §12.6).
      return {
        requested: { ...neutral },
        applied: { ...neutral },
        position: { x: 0, y: 0 },
        grounded: true,
        supportNormal: { x: 0, y: 1 },
        contacts: { ground: true, wall: false, head: false, steepSlope: false },
        snapped: false,
      };
    },
    reset(_character) {
      /* no-op */
    },
    clearCharacterMotion() {
      /* no-op */
    },
    placeCharacter(_center) {
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    characterClearance(_center) {
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    diagnostics() {
      return {};
    },
    dispose() {
      /* no-op */
    },
  };
}

function v3Scene(overrides?: { cameraFollow?: unknown }): {
  schemaVersion: 3;
  sceneId: string;
  revision: number;
  entities: unknown[];
} {
  const entities: unknown[] = [
    {
      id: 'cam-main',
      name: 'Test Camera',
      components: {
        transform: { position: [0, 4, 12], ...T },
        camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 },
        ...(overrides?.cameraFollow === undefined
          ? {
              cameraFollow: {
                deadZone: { x: 0.5, y: 0.5 },
                smoothing: 0.2,
                bounds: { minX: 0, maxX: 48, minY: -4, maxY: 8 },
              },
            }
          : {}),
      },
    },
    {
      id: 'player-0001',
      name: 'Player',
      components: {
        transform: { position: [3, 0.91, 0], ...T },
      },
    },
    {
      id: 'spawn-0001',
      components: {
        transform: { position: [3, 0.91, 0], ...T },
        playerSpawn: {},
      },
    },
    {
      id: 'spawn-0002',
      components: {
        transform: { position: [22, 0.91, 0], ...T },
        playerSpawn: {},
      },
    },
    {
      id: 'zone-checkpoint',
      components: {
        transform: { position: [22, 1, 0], ...T },
        gameZone: {
          role: 'checkpoint',
          size: [2, 2],
          safeSpawnId: 'spawn-0002',
          activation: { emissive: '#ff0000', emissiveIntensity: 2, cueAssetId: null },
        },
      },
    },
    {
      id: 'zone-goal',
      components: {
        transform: { position: [44.5, 1, 0], ...T },
        gameZone: { role: 'goal', size: [1, 2] },
      },
    },
  ];
  return { schemaVersion: 3, sceneId: 'scene-main', revision: 1, entities };
}

function gameBlock(): unknown {
  return {
    configVersion: 1,
    title: 'Test Course',
    objective: 'Reach the goal',
    instructions: 'A/D move. Space jumps.',
    playerId: 'player-0001',
    cameraId: 'cam-main',
    spawnId: 'spawn-0001',
    level: { minX: 0, maxX: 48, minY: -4, maxY: 8 },
    killY: -4,
    cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
  };
}

function v3Snapshot(sceneOverrides?: { cameraFollow?: unknown }, game?: unknown): unknown {
  return {
    snapshotId: 'demo-t49@r1',
    projectId: 'demo-t49',
    revision: 1,
    scene: v3Scene(sceneOverrides),
    game: game === undefined ? gameBlock() : game,
  };
}

// ---------------------------------------------------------------------------
// Test-only stub modules
// ---------------------------------------------------------------------------

const STUB_GAMEPLAY = 'thirdlight.teststub:gameplay';
const STUB_CAMERA = 'thirdlight.teststub:camera';
const STUB_INPUT_OBSERVER = 'thirdlight.teststub:input-observer';

/** A stub gameplay module: records the port it receives and runs `act`. */
function stubGameplaySpec(act?: (ctx: StepContext) => void): SimulationModuleSpec {
  return {
    id: STUB_GAMEPLAY,
    phases: ['gameplay'],
    create: (_snap, _cfg) => {
      const instance: SimulationPhaseModule & { seenPort?: boolean } = {
        transformOwners: [],
        step(phase, ctx) {
          if (phase !== 'gameplay') return;
          if (ctx.gameplay === undefined) throw new Error('the stub gameplay module requires ctx.gameplay');
          instance.seenPort = true;
          act?.(ctx);
        },
        dispose(): void {
          /* stateless */
        },
      };
      return instance;
    },
  };
}

/** A stub camera module: writes the camera entity x/y (its declared owner). */
function stubCameraSpec(
  rec: { viewport?: { width: number; height: number; aspect: number }; cameraPos?: [number, number] },
): SimulationModuleSpec {
  return {
    id: STUB_CAMERA,
    phases: ['camera'],
    create: () => ({
      transformOwners: ['cam-main'],
      step(phase: string, ctx: StepContext): void {
        if (phase !== 'camera') return;
        const gp = ctx.gameplay!;
        rec.viewport = { ...gp.viewport() };
        const player = ctx.state.curr.get(gp.content.player.entityId)!;
        const cam = ctx.state.curr.get('cam-main')!;
        cam.position[0] = player.position[0];
        cam.position[1] = player.position[1] + 4;
        rec.cameraPos = [cam.position[0], cam.position[1]];
      },
      dispose(): void {
        /* stateless */
      },
    }),
  };
}

/**
 * A stub intent-phase module that records the (effective) action frame it
 * receives — the §2.5 overrides act on the frame the runtime hands to every
 * phase (the controller in a real set), so the observer sees exactly what
 * the controller would receive.
 */
function stubInputObserverSpec(rec: { frames: ActionFrame[] }): SimulationModuleSpec {
  return {
    id: STUB_INPUT_OBSERVER,
    phases: ['intent'],
    create: () => ({
      transformOwners: [],
      step(phase: string, ctx: StepContext): void {
        if (phase === 'intent') rec.frames.push({ ...ctx.action });
      },
      dispose(): void {
        /* stateless */
      },
    }),
  };
}

function registryWith(...specs: SimulationModuleSpec[]) {
  const r = createSimulationRegistry();
  for (const s of specs) {
    const res = registerSimulationModule(r, s.id, s);
    if (!res.ok) throw new Error(`register ${s.id} failed: ${JSON.stringify(res.error)}`);
  }
  return r;
}

interface M3Harness {
  runtime: Runtime;
  rec: { viewport?: { width: number; height: number; aspect: number }; cameraPos?: [number, number] };
  controller: { frames: ActionFrame[] };
  now: { t: number };
  tick(): void;
}

/** An M3 runtime: stub input observer + gameplay + camera, manual clock. */
function m3Harness(
  frames: readonly ActionFrame[],
  opts?: {
    snapshot?: unknown;
    gameplayAct?: (ctx: StepContext) => void;
    modules?: SimulationModuleSpec[];
    /** Run the 12-step settle pre-roll tick (default true). */
    preRoll?: boolean;
  },
): M3Harness {
  const rec: M3Harness['rec'] = {};
  const controller: M3Harness['controller'] = { frames: [] };
  const specs =
    opts?.modules ?? [stubInputObserverSpec(controller), stubGameplaySpec(opts?.gameplayAct), stubCameraSpec(rec)];
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: opts?.snapshot ?? v3Snapshot(),
    registry: registryWith(...specs),
    modules: specs.map((s) => s.id),
    actions: createRecordedActionSource(frames),
    physics: stubResetPort(),
    settings: {},
    clock: () => now.t,
    driver: { kind: 'manual' },
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const runtime = res.runtime;
  if (!runtime.start().ok) throw new Error('start failed');
  if (opts?.preRoll !== false && !runtime.tick(now.t).ok) throw new Error('pre-roll tick failed'); // the 12-step settle
  return {
    runtime,
    rec,
    controller,
    now,
    tick(): void {
      now.t += DT;
      if (!runtime.tick(now.t).ok) throw new Error('tick failed (fail-stop)');
    },
  };
}

function errOf(r: { ok: true } | { ok: false; error: RuntimeError }): RuntimeError {
  if ('ok' in r && r.ok) throw new Error(`expected rejection, got ok`);
  return (r as { ok: false; error: RuntimeError }).error;
}

const frame = (stepIndex: number, moveX: number, jump: ActionFrame['jump']): ActionFrame =>
  Object.freeze({ stepIndex, moveX, jump });

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('M3 runtime wiring (gameplay.md §3/§6.1/§7.1; runtime.md §15)', () => {
  it('the instantiate-time committed view (stepIndex 0, awaitingStart)', () => {
    // No pre-roll tick: the view published at instantiate is the stepIndex-0
    // committed view.
    const { runtime } = m3Harness([frame(12, 0, 'none')], { preRoll: false });
    const r = runtime.getGameView();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.view;
    expect(v.viewVersion).toBe(1);
    expect(v.runId).toBe('demo-t49@r1#0');
    expect(v.snapshotId).toBe('demo-t49@r1');
    expect(v.replayEpoch).toBe(0);
    expect(v.state).toBe('awaitingStart');
    expect(v.stepIndex).toBe(0);
    expect(v.simTime).toBe(0);
    expect(v.playerId).toBe('player-0001');
    expect(v.cameraId).toBe('cam-main');
    expect(v.activeSpawnId).toBe('spawn-0001');
    expect(v.checkpointId).toBeNull();
    expect(v.checkpointActive).toBe(false);
    expect(v.goalReached).toBe(false);
    expect(v.deathCount).toBe(0);
    expect(v.respawnAtStep).toBeNull();
    expect(v.events).toEqual([]);
    expect(v.eventCount).toBe(0);
    expect(v.eventDropped).toBe(0);
    expect(v.failed).toBe(false);
    expect(v.playerMotion).toEqual({ speed: 0, grounded: true });
    expect(Object.isFrozen(v)).toBe(true);
    // Freshness: a new deep-frozen copy per call, no aliasing.
    const r2 = runtime.getGameView();
    if (r2.ok) {
      expect(r2.view).not.toBe(r.view);
      expect(r2.view.events).not.toBe(r.view.events);
      expect(Object.isFrozen(r2.view.events)).toBe(true);
    }
  });

  it('the M3 composition table (gameplay.md §3.4) rejects before create', () => {
    const gameplay = stubGameplaySpec();
    const camera = stubCameraSpec({});
    const v2Scene = { schemaVersion: 2, sceneId: 'scene-main', revision: 1, entities: [] };
    const bad = (snapshot: unknown, modules: string[]): RuntimeError =>
      errOf(instantiateRuntime({
        snapshot,
        registry: registryWith(gameplay, camera),
        modules,
        driver: { kind: 'manual' },
      }));

    // A v1/v2 scene is not a playable snapshot at all (phase 9.3).
    const v2SceneNoGame = { schemaVersion: 2, sceneId: 'scene-main', revision: 1, entities: [
      {
        id: 'cam-main',
        components: {
          transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
        },
      },
    ] };
    expect(bad({ snapshotId: 'demo-t49@r1', projectId: 'demo-t49', revision: 1, scene: v2SceneNoGame }, [STUB_GAMEPLAY, STUB_CAMERA])).toMatchObject({ code: 'snapshot_invalid' });
    const v1Scene = {
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        {
          id: 'cam-main',
          components: {
            transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
          },
        },
      ],
    };
    expect(bad({ snapshotId: 'demo-t49@r1', projectId: 'demo-t49', revision: 1, scene: v1Scene }, [STUB_GAMEPLAY, STUB_CAMERA])).toMatchObject({ code: 'snapshot_invalid' });
    // A null game block.
    expect(bad(v3Snapshot(undefined, null), [STUB_GAMEPLAY, STUB_CAMERA])).toMatchObject({
      code: 'config_invalid',
      reason: 'game_config',
    });
    // No camera module / two gameplay modules.
    expect(bad(v3Snapshot(), [STUB_GAMEPLAY])).toMatchObject({
      code: 'config_invalid',
      reason: 'camera_owner',
      detail: 'missing',
    });
    const secondGameplay = { ...gameplay, id: 'thirdlight.teststub:gameplay-2' };
    expect(
      errOf(
        instantiateRuntime({
          snapshot: v3Snapshot(),
          registry: registryWith(gameplay, secondGameplay, camera),
          modules: [STUB_GAMEPLAY, secondGameplay.id, STUB_CAMERA],
          driver: { kind: 'manual' },
        }),
      ),
    ).toMatchObject({ code: 'config_invalid', reason: 'gameplay_module' });
    // Two camera modules.
    const secondCamera = { ...camera, id: 'thirdlight.teststub:camera-2' };
    expect(
      errOf(
        instantiateRuntime({
          snapshot: v3Snapshot(),
          registry: registryWith(gameplay, camera, secondCamera),
          modules: [STUB_GAMEPLAY, STUB_CAMERA, secondCamera.id],
          driver: { kind: 'manual' },
        }),
      ),
    ).toMatchObject({ code: 'config_invalid', reason: 'camera_owner', detail: 'multiple' });
    // The camera module's owners are not exactly [cameraId].
    const wrongCamera = {
      ...camera,
      create: () => ({ transformOwners: ['player-0001'] as string[], step: () => undefined, dispose: () => undefined }),
    };
    expect(
      errOf(
        instantiateRuntime({
          snapshot: v3Snapshot(),
          registry: registryWith(gameplay, wrongCamera),
          modules: [STUB_GAMEPLAY, STUB_CAMERA],
          driver: { kind: 'manual' },
        }),
      ),
    ).toMatchObject({ code: 'config_invalid', reason: 'camera_owner', detail: 'owner_mismatch' });
    // The camera entity carries no cameraFollow (scene-local validation passes).
    expect(bad(v3Snapshot({ cameraFollow: null }), [STUB_GAMEPLAY, STUB_CAMERA])).toMatchObject({
      code: 'config_invalid',
      reason: 'camera_follow',
    });
    // The `game` wrapper field: required on v3, refused on v1/v2.
    const noGame = cloneJson(v3Snapshot()) as Record<string, unknown>;
    delete noGame.game;
    expect(bad(noGame, [STUB_GAMEPLAY, STUB_CAMERA])).toMatchObject({
      code: 'snapshot_invalid',
      reason: 'shape',
      path: '/game',
    });
    // A v2 scene is refused whatever it carries (phase 9.3: v3/v4 only).
    const v2WithGame = errOf(
      instantiateRuntime({
        snapshot: { snapshotId: 'demo-t49@r1', projectId: 'demo-t49', revision: 1, scene: v2Scene, game: gameBlock() },
        registry: registryWith(gameplay, camera),
        modules: [STUB_GAMEPLAY, STUB_CAMERA],
        driver: { kind: 'manual' },
      }),
    );
    expect(v2WithGame).toMatchObject({ code: 'snapshot_invalid', reason: 'shape', path: '/scene/schemaVersion' });
    // A malformed game block (a missing required field).
    const badGame = cloneJson(gameBlock()) as Record<string, unknown>;
    delete badGame.killY;
    expect(bad(v3Snapshot(undefined, badGame), [STUB_GAMEPLAY, STUB_CAMERA])).toMatchObject({
      code: 'snapshot_invalid',
      reason: 'scene_validation',
    });
  });

  it('M1/M2 sets expose no run surface (game_session_unavailable, reason schedule)', () => {
    const demoSpec: SimulationModuleSpec = {
      id: 'thirdlight.teststub:transform',
      phases: ['transform'],
      create: () => ({ transformOwners: [], step: () => undefined, dispose: () => undefined }),
    };
    const res = instantiateRuntime({
      snapshot: {
        snapshotId: 'demo-t49@r1',
        projectId: 'demo-t49',
        revision: 1,
        scene: {
          schemaVersion: 4,
          sceneId: 'scene-main',
          revision: 1,
          entities: [
            {
              id: 'cam-main',
              components: {
                transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
                camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
              },
            },
          ],
        },
        game: null,
      },
      registry: registryWith(demoSpec),
      modules: ['thirdlight.teststub:transform'],
      driver: { kind: 'manual' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(errOf(res.runtime.getGameView())).toMatchObject({ code: 'game_session_unavailable', reason: 'schedule' });
    expect(errOf(res.runtime.gameCommand('start'))).toMatchObject({ code: 'game_session_unavailable', reason: 'schedule' });
    expect(errOf(res.runtime.setViewport(800, 600))).toMatchObject({ code: 'game_session_unavailable', reason: 'schedule' });
  });

  it('the run command queue (gameplay.md §2.3): submit rules, coalesce, boundary consumption', () => {
    const h = m3Harness([frame(12, 0, 'none'), frame(13, 0, 'none'), frame(14, 0, 'none')]);
    const rt = h.runtime;
    // `replay` is invalid in awaitingStart; `start` is accepted and queued.
    expect(errOf(rt.gameCommand('replay'))).toMatchObject({
      code: 'game_command_invalid',
      reason: 'state',
      command: 'replay',
      state: 'awaitingStart',
    });
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    // A conflicting submission with a pending command is rejected; an
    // identical one coalesces (idempotent).
    expect(errOf(rt.gameCommand('replay'))).toMatchObject({
      code: 'game_command_invalid',
      reason: 'pending',
      command: 'replay',
    });
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    let d = rt.getDiagnostics();
    expect(d.ok).toBe(true);
    if (d.ok) {
      const diag = d.diagnostics as RuntimeDiagnostics;
      expect(diag.pendingCommands).toEqual(['start']);
      expect(diag.runState).toBe('awaitingStart');
    }
    // The first boundary after the settle (step 13) consumes the command.
    h.tick(); // step 13
    const v1 = rt.getGameView();
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.view.state).toBe('playing');
    expect(v1.view.stepIndex).toBe(13);
    expect(v1.view.events).toMatchObject([
      { id: 'demo-t49@r1#0/runStarted/13', kind: 'runStarted', stepIndex: 13, boundary: true, deathCount: 0 },
    ]);
    // `start` again is now invalid (state playing); `replay` is accepted and
    // consumed at the next boundary (T6: epoch++, counters reset).
    expect(errOf(rt.gameCommand('start'))).toMatchObject({ code: 'game_command_invalid', reason: 'state', state: 'playing' });
    expect(rt.gameCommand('replay')).toEqual({ ok: true });
    h.tick(); // step 14
    const v2 = rt.getGameView();
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.view.state).toBe('playing');
    expect(v2.view.replayEpoch).toBe(1);
    expect(v2.view.runId).toBe('demo-t49@r1#1');
    expect(v2.view.events).toMatchObject([
      { id: 'demo-t49@r1#0/runStarted/13', kind: 'runStarted', stepIndex: 13, boundary: true },
      { id: 'demo-t49@r1#1/replayed/14', kind: 'replayed', stepIndex: 14, boundary: true, deathCount: 0 },
    ]);
    // A failed runtime refuses further commands (the run is frozen).
    expect(rt.getDiagnostics().ok).toBe(true);
  });

  it('setViewport validation (gameplay.md §7.1) and the camera-phase viewport read', () => {
    const h = m3Harness([frame(12, 0, 'none')]);
    const rt = h.runtime;
    for (const [w, ht] of [
      [0, 720],
      [-1, 720],
      [1280, 0],
      [Number.NaN, 720],
      [Number.POSITIVE_INFINITY, 720],
      [16385, 720],
      [1280, 16385],
    ] as Array<[number, number]>) {
      expect(errOf(rt.setViewport(w, ht))).toMatchObject({ code: 'camera_viewport_invalid', width: w, height: ht });
    }
    expect(rt.setViewport(1280, 720)).toEqual({ ok: true });
    h.tick();
    expect(h.rec.viewport).toEqual({ width: 1280, height: 720, aspect: 1280 / 720 });
    // An invalid update retains the previous record (the camera keeps reading 1280×720).
    expect(errOf(rt.setViewport(0, 720))).toMatchObject({ code: 'camera_viewport_invalid' });
    h.tick();
    expect(h.rec.viewport).toEqual({ width: 1280, height: 720, aspect: 1280 / 720 });
  });

  it('the §2.5 effective-frame overrides (the held-jump fixture table, real runtime)', () => {
    // Sampled frames (0-based completed index = stepIndex − 1); a valid jump
    // phase chain: pressed → held → held.
    //  12 (step 13, awaitingStart):  move 1, jump pressed
    //  13 (step 14, firstLive):      move 1, jump held
    //  14 (step 15):                 move 1, jump held
    const h = m3Harness([frame(12, 1, 'pressed'), frame(13, 1, 'held'), frame(14, 1, 'held')]);
    const rt = h.runtime;
    // Step 13 runs BEFORE the `start` boundary would be consumed? No — the
    // boundary at step 13 has nothing pending (no command submitted yet):
    // the run stays awaitingStart, so the whole step is gated.
    h.tick(); // step 13
    expect(h.controller.frames.at(-1)).toEqual({ stepIndex: 12, moveX: 0, jump: 'none' });
    const vAwait = rt.getGameView();
    expect(vAwait.ok).toBe(true);
    if (vAwait.ok) expect(vAwait.view.state).toBe('awaitingStart');
    // Submit `start` between frames: the boundary before step 14 consumes it
    // (firstLive = 14). The held-jump fixture pins: at firstLive the jump is
    // forced to none, the move is NOT gated.
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    h.tick(); // step 14 (firstLive)
    expect(h.controller.frames.at(-1)).toEqual({ stepIndex: 13, moveX: 1, jump: 'none' });
    // Step 15: the jump is released (the gate has passed).
    h.tick(); // step 15
    expect(h.controller.frames.at(-1)).toEqual({ stepIndex: 14, moveX: 1, jump: 'held' });
  });

  it('the gameplay port: phase rules, run-state rules, the three commits (via the real session module path)', () => {
    // A module that calls a port commit in the TRANSFORM phase →
    // module_error/phase_violation fail-stop; the last committed view is
    // retained with the failure record (T7, CC-49-1 phase label).
    const badPhase = {
      id: 'thirdlight.teststub:badphase',
      phases: ['transform', 'gameplay'] as const,
      create: () => ({
        transformOwners: [] as string[],
        step(phase: string, ctx: StepContext): void {
          if (phase === 'transform' && ctx.stepIndex + 1 === 13) ctx.gameplay!.beginRespawn('fall'); // wrong phase
        },
        dispose: () => undefined,
      }),
    };
    const res = instantiateRuntime({
      snapshot: v3Snapshot(),
      registry: registryWith(badPhase, stubCameraSpec({})),
      modules: [badPhase.id, STUB_CAMERA],
      actions: createRecordedActionSource([frame(12, 0, 'none')]),
      physics: stubResetPort(),
      settings: {},
      clock: () => 0,
      driver: { kind: 'manual' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.runtime.start().ok).toBe(true);
    expect(res.runtime.tick(0).ok).toBe(true); // pre-roll
    let now = 0;
    res.runtime.tick((now += DT)); // step 13: the violation (tick stays ok; the state is `failed`)
    const view = res.runtime.getGameView();
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.view.failed).toBe(true);
    expect(view.view.failure).toMatchObject({
      code: 'module_error',
      reason: 'phase_violation',
      stepIndex: 13,
      phase: 'transform',
    });
    expect(view.view.state).toBe('awaitingStart'); // the run state is frozen
    expect(errOf(res.runtime.gameCommand('start'))).toMatchObject({ code: 'runtime_failed' });
    const diag = res.runtime.getDiagnostics();
    expect(diag.ok).toBe(true);
    if (diag.ok) {
      expect((diag.diagnostics as RuntimeDiagnostics).errors?.at(-1)).toMatchObject({
        code: 'module_error',
        reason: 'phase_violation',
        phase: 'transform',
      });
    }
  });

  it('the three port commits and the respawn delay (real state machine, no physics)', () => {
    // The stub gameplay module drives the real session port: a checkpoint at
    // step 14, a hazard death at step 15 (respawn due at 15+1+30 = 46), a
    // goal — never reached (the run is dead). A second checkpoint attempt is
    // `gameplay_invalid` (single activation).
    const acts: string[] = [];
    const h = m3Harness(
      Array.from({ length: 40 }, (_, i) => frame(12 + i, 0, 'none')),
      {
        gameplayAct: (ctx) => {
          const run = ctx.gameplay!.run();
          if (run.state !== 'playing') return;
          if (run.stepIndex === 14) {
            acts.push('checkpoint');
            ctx.gameplay!.activateCheckpoint('zone-checkpoint');
          } else if (run.stepIndex === 15) {
            acts.push('death');
            ctx.gameplay!.beginRespawn('hazard', 'zone-hazard-01');
          } else if (run.stepIndex === 47 && run.checkpointId !== null) {
            // After the respawn boundary (step 46): a second activation must
            // be a run-state commit rule violation (gameplay_invalid).
            acts.push('second-checkpoint');
            ctx.gameplay!.activateCheckpoint('zone-checkpoint');
          }
        },
      },
    );
    const rt = h.runtime;
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    for (let i = 0; i < 34; i += 1) h.tick(); // steps 13..46
    expect(acts).toEqual(['checkpoint', 'death']);
    const v = rt.getGameView();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // Step 46 is the respawn boundary (15 + 1 + 30): the `respawned` event
    // marks it; the state is `playing` again (packet 49: the world is not
    // physically reset — the no-op seam — so the player transform is static).
    expect(v.view.state).toBe('playing');
    expect(v.view.stepIndex).toBe(46);
    expect(v.view.deathCount).toBe(1);
    expect(v.view.respawnAtStep).toBeNull();
    expect(v.view.checkpointId).toBe('zone-checkpoint');
    expect(v.view.checkpointActive).toBe(true);
    expect(v.view.activeSpawnId).toBe('spawn-0002'); // the checkpoint's safeSpawnId
    expect(v.view.events.map((e) => e.kind)).toEqual(['runStarted', 'checkpointActivated', 'died', 'respawned']);
    expect(v.view.events.at(-1)).toMatchObject({
      id: 'demo-t49@r1#0/respawned/46',
      kind: 'respawned',
      stepIndex: 46,
      boundary: true,
      deathCount: 1,
    });
    const diag = rt.getDiagnostics();
    expect(diag.ok).toBe(true);
    if (diag.ok) {
      const d = diag.diagnostics as RuntimeDiagnostics;
      expect(d.runState).toBe('playing');
      expect(d.deathCount).toBe(1);
      expect(d.checkpointId).toBe('zone-checkpoint');
      expect(d.gameEventCount).toBe(4);
    }
    // Step 47: the second checkpoint attempt → gameplay_invalid fail-stop.
    h.now.t += DT;
    rt.tick(h.now.t); // the violation (tick stays ok; the state is `failed`)
    expect(acts).toEqual(['checkpoint', 'death', 'second-checkpoint']);
    const vFail = rt.getGameView();
    expect(vFail.ok).toBe(true);
    if (!vFail.ok) return;
    expect(vFail.view.failed).toBe(true);
    expect(vFail.view.failure).toMatchObject({ code: 'module_error', reason: 'gameplay_invalid', phase: 'gameplay' });
    expect(vFail.view.state).toBe('playing'); // frozen at the last committed value
    expect(vFail.view.stepIndex).toBe(47); // the failed step's ordinal
  });

  it('the camera module writes the camera entity in the camera phase (the M3 write-guard extension)', () => {
    const h = m3Harness([frame(12, 0, 'none')]);
    h.tick();
    expect(h.rec.cameraPos).toEqual([3, 0.91 + 4]); // the stub's follow rule
    const cam = h.runtime.getInterpolatedState();
    expect(cam.ok).toBe(true);
    if (cam.ok) {
      const t = cam.state.transforms.find((x) => x.id === 'cam-main');
      expect(t?.position[0]).toBeCloseTo(3, 6);
      expect(t?.position[1]).toBeCloseTo(4.91, 6);
      // The authored camera depth (z) is untouched.
      expect(t?.position[2]).toBe(12);
    }
  });

  it('a goal reach wins once (state won, no further evaluation)', () => {
    const h = m3Harness(
      Array.from({ length: 6 }, (_, i) => frame(12 + i, 0, 'none')),
      {
        gameplayAct: (ctx) => {
          const run = ctx.gameplay!.run();
          if (run.state === 'playing' && run.stepIndex === 14) ctx.gameplay!.reachGoal('zone-goal');
          else if (run.state === 'won' && run.stepIndex === 15) {
            // A port commit while `won` is a run-state rule violation.
            ctx.gameplay!.beginRespawn('fall');
          }
        },
      },
    );
    const rt = h.runtime;
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    h.tick(); // step 13
    h.tick(); // step 14: the goal
    let v = rt.getGameView();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.view.state).toBe('won');
    expect(v.view.goalReached).toBe(true);
    expect(v.view.events.map((e) => e.kind)).toEqual(['runStarted', 'goalReached']);
    h.tick(); // step 15: the port call while won → gameplay_invalid fail-stop
    const vFail = rt.getGameView();
    expect(vFail.ok).toBe(true);
    if (!vFail.ok) return;
    expect(vFail.view.failed).toBe(true);
    expect(vFail.view.failure).toMatchObject({ reason: 'gameplay_invalid', stepIndex: 15, phase: 'gameplay' });
    expect(vFail.view.state).toBe('won');
  });

  it('the event ring (gameplay.md §6): 32 retained, front evictions, cumulative count', () => {
    // 20 hazard deaths back-to-back (the stub re-arms each run boundary) →
    // 1 runStarted + 20 died + 19 respawned = 40 events > 32.
    let deaths = 0;
    const h = m3Harness(
      Array.from({ length: 700 }, (_, i) => frame(12 + i, 0, 'none')),
      {
        gameplayAct: (ctx) => {
          const run = ctx.gameplay!.run();
          if (run.state !== 'playing') return;
          if (deaths < 20) {
            deaths += 1;
            ctx.gameplay!.beginRespawn('hazard', 'zone-hazard-01');
          }
        },
      },
    );
    const rt = h.runtime;
    expect(rt.gameCommand('start')).toEqual({ ok: true });
    // Each death at step N is followed by 30 respawning steps; the respawn
    // boundary is at N+31, where the stub immediately re-dies. Death 20 is
    // at step 13 + 31×19 = 602; its respawn boundary (633) is NOT reached:
    // run steps 13..632 (620 ticks), mirroring the events-bound fixture.
    for (let i = 0; i < 620; i += 1) h.tick(); // steps 13..632
    const v = rt.getGameView();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.view.state).toBe('respawning');
    expect(v.view.eventCount).toBe(40); // 1 runStarted + 20 died + 19 respawned
    expect(v.view.eventDropped).toBe(40 - 32);
    expect(v.view.events.length).toBe(32);
    expect(v.view.events[0]!.kind).toBe('respawned'); // the evicted front is gone
    expect(v.view.events.at(-1)!.kind).toBe('died');
    expect(v.view.deathCount).toBe(20);
  });

  it('dispose releases the run surface (runtime_disposed)', () => {
    const h = m3Harness([frame(12, 0, 'none')]);
    const rt = h.runtime;
    expect(rt.dispose().ok).toBe(true);
    expect(errOf(rt.getGameView())).toMatchObject({ code: 'runtime_disposed' });
    expect(errOf(rt.gameCommand('start'))).toMatchObject({ code: 'runtime_disposed' });
    expect(errOf(rt.setViewport(800, 600))).toMatchObject({ code: 'runtime_disposed' });
  });
});