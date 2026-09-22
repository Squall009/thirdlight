/**
 * Packet 61 — Beacon Reach traversable step trace (REAL physics, Node).
 *
 * The packet's core binding evidence: "freeze a traversable layout and step
 * traces using actual physics." This test loads the CAPTURED sample project
 * (`samples/beacon-reach/captured/project.json` — authored through the real
 * editing path), composes the same real modules the preview/export runtime
 * uses — `@thirdlight/platformer` + `@thirdlight/runtime` (M3 wiring) +
 * `@thirdlight/physics-rapier` (pinned 0.20.0) + `@thirdlight/platformer-game`
 * (the zone session + camera modules) — at the ACCEPTED gameplay settings (no
 * retuned constants), and drives the capsule with a scripted action source
 * (hold right, jump at each obstacle). It freezes the step traces for the
 * three acceptance situations:
 *
 *   A — a fall in the first pit BEFORE the checkpoint increments the death
 *       counter once and respawns at the START spawn (X≈3, velocity stopped).
 *   B — the full traversal: clear the low step, both hazards and both pits,
 *       the checkpoint activates once, and the player reaches the beacon
 *       (goal) — the layout is traversable at the accepted constants.
 *   C — a fall in the second pit AFTER the checkpoint respawns at the
 *       CHECKPOINT spawn (X≈24, not the start).
 *
 * The render/visual/audio half (a real WebGL frame, audible cues, a
 * DOM+canvas capture) is the owner-run browser procedure — UNVERIFIED
 * in-container (tests/browser/m3-sample, packet-38 baseline §1).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPhysicsPort, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import {
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionFrame,
  type ActionSource,
  type GameplaySettings,
  type JumpPhase,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURED = join(HERE, '..', '..', '..', 'samples', 'beacon-reach', 'captured', 'project.json');

const DT = 1 / 120;
// The ACCEPTED gameplay settings (the sample's authored defaults — no retune).
const SETTINGS: GameplaySettings = {
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
};
const SOLVER = { hz: 120, gravityY: -19.62 } as const;
const CONTROLLER_CFG = {
  offsetSkin: 0.01,
  groundSnap: 0.1,
  maxSlopeClimbRad: Math.PI / 4,
  minSlopeSlideRad: Math.PI / 6,
  autostep: false,
} as const;

interface Captured {
  scene: {
    schemaVersion: number;
    sceneId: string;
    revision: number;
    entities: Array<{
      id: string;
      name?: string;
      components: Record<string, { position?: number[]; box?: { size: number[] }; collider?: { shape: { type: string; hx: number; hy: number } }; [k: string]: unknown }>;
    }>;
  };
  content: {
    game: Record<string, unknown>;
    settings: GameplaySettings;
  };
}

function loadCaptured(): Captured {
  return JSON.parse(new TextDecoder().decode(readFileSync(CAPTURED))) as Captured;
}

function staticsFromScene(c: Captured): RapierStaticColliderSpec[] {
  const out: RapierStaticColliderSpec[] = [];
  for (const e of c.scene.entities) {
    const col = e.components.collider;
    const pos = e.components.transform?.position;
    if (!col || !pos) continue;
    out.push({ entityId: e.id, shape: { type: 'box', hx: col.shape.hx, hy: col.shape.hy }, position: { x: pos[0], y: pos[1] }, rotationZ: 0 });
  }
  return out;
}

interface TraceFrame {
  step: number;
  state: string;
  x: number;
  y: number;
  grounded: boolean;
  deathCount: number;
  checkpointId: string | null;
  goalReached: boolean;
}

interface DriveResult {
  trace: TraceFrame[];
  /** The frame captured when `until` first held (before the next motion step). */
  final: TraceFrame;
}

/**
 * Compose the real runtime over the captured project and drive it. The action
 * source is dynamic: it always holds right and issues a single `jump: 'pressed'`
 * frame when the capsule is grounded and reaches a window in `jumpWindows`
 * (each window fires once). The `until` predicate is checked at the TOP of each
 * iteration (before the next motion step is applied), so a post-respawn check
 * captures the respawn position before any post-respawn motion.
 */
async function driveTrace(jumpWindows: number[], until: (v: { state: string; goalReached: boolean; deathCount: number }) => boolean, maxSteps: number): Promise<DriveResult> {
  const captured = loadCaptured();
  const playerEntity = captured.scene.entities.find((e) => e.id === (captured.content.game as { playerId: string }).playerId)!;
  const playerPos = playerEntity.components.transform!.position!;
  const statics = staticsFromScene(captured);
  const physicsInit = await createPhysicsPort({ character: { x: playerPos[0], y: playerPos[1] }, statics, solver: SOLVER, controller: CONTROLLER_CFG });
  if (!physicsInit.ok) throw new Error(`physics init failed: ${JSON.stringify(physicsInit.error)}`);
  const physics: PhysicsPort = physicsInit.port;
  const registry = createSimulationRegistry();
  for (const spec of [platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec]) {
    const r = registerSimulationModule(registry, spec.id, spec);
    if (!r.ok) throw new Error(`register ${spec.id} failed: ${JSON.stringify(r.error)}`);
  }
  // The render-only entities (model/light) are the three-adapter's job; the
  // physics/logic runtime keeps the rest.
  // (the player is a model entity too, but it carries the controller).
  const runtimeEntities = captured.scene.entities.filter((e) => 'controller' in e.components || (!('model' in e.components) && !('light' in e.components)));
  const snapshot = {
    snapshotId: `beacon-reach@r${captured.scene.revision}`,
    projectId: 'beacon-reach',
    revision: captured.scene.revision,
    scene: { ...captured.scene, entities: runtimeEntities },
    game: captured.content.game,
  };
  const action = { moveX: 0, jump: 'none' as JumpPhase };
  const actionSource: ActionSource = { sample: (stepIndex: number): ActionFrame => ({ stepIndex, moveX: action.moveX, jump: action.jump }) };
  let now = 0;
  const res = instantiateRuntime({
    snapshot,
    registry,
    modules: [PLATFORMER_MODULE_ID, PLATFORMER_GAME_MODULE_ID, PLATFORMER_GAME_CAMERA_MODULE_ID],
    actions: actionSource,
    physics,
    settings: SETTINGS,
    clock: () => now,
    driver: { kind: 'manual' },
  });
  if (!res.ok) throw new Error(`instantiateRuntime failed: ${JSON.stringify(res.error)}`);
  const runtime: Runtime = res.runtime;
  if (!runtime.start().ok) throw new Error('start failed');
  if (!runtime.tick(now).ok) throw new Error('pre-roll tick failed');

  const position = (): Vec2 => {
    const s = runtime.getInterpolatedState();
    if (!s.ok) throw new Error('getInterpolatedState failed');
    const t = s.state.transforms.find((x) => x.id === playerEntity.id);
    if (!t) throw new Error('player transform missing');
    return { x: t.position[0], y: t.position[1] };
  };
  const view = () => {
    const v = runtime.getGameView();
    if (!v.ok) throw new Error(`getGameView failed: ${JSON.stringify(v.error)}`);
    return v.view;
  };
  const frame = (): TraceFrame => {
    const v = view();
    const p = position();
    return { step: v.stepIndex, state: v.state, x: p.x, y: p.y, grounded: v.playerMotion.grounded, deathCount: v.deathCount, checkpointId: v.checkpointId, goalReached: v.goalReached };
  };

  // Start the run (the lower-level seam: the host uses the menu confirm; the
  // runtime exposes the same boundary as a game command).
  if (!runtime.gameCommand('start').ok) throw new Error('start command failed');
  runtime.tick((now += DT));

  const trace: TraceFrame[] = [];
  const jumped = new Set<number>();
  let final = frame();
  for (let step = 0; step < maxSteps; step += 1) {
    const v = view();
    final = frame();
    if (until({ state: v.state, goalReached: v.goalReached, deathCount: v.deathCount })) break;
    const p = position();
    const w = jumpWindows.find((jw) => !jumped.has(jw) && p.x >= jw && p.x < jw + 1.5);
    action.moveX = 1; // hold right
    action.jump = w !== undefined && v.state === 'playing' && v.playerMotion.grounded ? 'pressed' : 'none';
    if (w !== undefined) jumped.add(w);
    runtime.tick((now += DT));
    trace.push(frame());
  }
  runtime.dispose();
  physics.dispose();
  if (trace.length > 0) final = trace[trace.length - 1]!;
  return { trace, final };
}

// The jump windows (x thresholds, just before each obstacle along the course).
const LOW_STEP = 5.4; // low step at x=6..7
const HAZARD_1 = 9.5; // hazard at x=10.5..11.3
const PIT_1 = 14.8; // first pit at x=16..17.5
const HAZARD_2 = 27.0; // hazard at x=28..28.8
const PIT_2 = 30.5; // second pit at x=32..33.5
const FINAL_STEP = 35.4; // final step at x=36..37
const ALL_WINDOWS = [LOW_STEP, HAZARD_1, PIT_1, HAZARD_2, PIT_2, FINAL_STEP];

describe('Beacon Reach traversable step trace (packet 61, real physics)', () => {
  it('A: a fall in the first pit before the checkpoint increments death once and respawns at the START spawn', async () => {
    // Jump the low step + hazard 1, then WALK into the first pit (no PIT_1
    // jump). The death is detected, and once the bounded respawn delay elapses
    // the run returns to `playing` with the capsule re-placed at the start
    // spawn (X≈3) — captured before any post-respawn motion.
    const { final } = await driveTrace([LOW_STEP, HAZARD_1], (v) => v.deathCount >= 1 && v.state === 'playing', 120 * 15);
    expect(final.deathCount).toBe(1);
    expect(final.checkpointId).toBeNull(); // the checkpoint was never reached
    expect(final.grounded).toBe(true); // velocity stopped at the spawn
    expect(final.x).toBeGreaterThan(2.4);
    expect(final.x).toBeLessThan(3.6); // the START spawn (X≈3)
  }, 90_000);

  it('B: the full traversal clears every obstacle, activates the checkpoint once, and reaches the beacon (goal)', async () => {
    const { final } = await driveTrace(ALL_WINDOWS, (v) => v.goalReached, 120 * 60);
    expect(final.goalReached).toBe(true);
    expect(final.checkpointId).not.toBeNull(); // the checkpoint was activated en route
    expect(final.deathCount).toBe(0); // a clean traversal (no deaths)
    expect(final.x).toBeGreaterThan(43); // the player reached the beacon zone (X≈44..45)
  }, 120_000);

  it('C: a fall in the second pit after the checkpoint respawns at the CHECKPOINT spawn', async () => {
    // Jump the low step, hazard 1, pit 1 and hazard 2 (reaching + activating
    // the checkpoint at X≈22), then WALK into the second pit (no PIT_2 jump) →
    // a fall AFTER the checkpoint. The respawn re-places the capsule at the
    // checkpoint's safe spawn (X≈24).
    const { final } = await driveTrace([LOW_STEP, HAZARD_1, PIT_1, HAZARD_2], (v) => v.deathCount >= 1 && v.state === 'playing', 120 * 25);
    expect(final.deathCount).toBe(1);
    expect(final.checkpointId).not.toBeNull(); // the checkpoint was activated before the fall
    expect(final.grounded).toBe(true);
    expect(final.x).toBeGreaterThan(23.2);
    expect(final.x).toBeLessThan(24.8); // the CHECKPOINT spawn (X≈24), not the start
  }, 120_000);
});