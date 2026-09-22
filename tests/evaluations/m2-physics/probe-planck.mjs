#!/usr/bin/env node
/**
 * Packet 14 — bounded FUNCTIONAL comparison probe: planck@1.5.0 (Box2D-derived,
 * no WASM) against the same static-course requirements as the Rapier probe.
 * This is a controller-work comparison, NOT a browser benchmark (m2-physics.md
 * experiment 6: unrun candidates get no fabricated benchmark column; a
 * functional probe answers "what custom logic would M2 have to write?").
 *
 * Standalone (BR-1): not a vitest test; imports the candidate from the
 * disposable prefix (EVAL_PREFIX), never the repo lockfile.
 *
 * Shape note (recorded): Box2D-derived planck has NO capsule shape — the
 * course capsule (total height 1.8) is approximated here by a circle of
 * radius 0.9; the shape mismatch itself is a controller-work item.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, 'course-spec.json'), 'utf8'));
const PREFIX = process.env.EVAL_PREFIX ?? '/tmp/tl-m2-eval-14';
const planck = (await import(join(PREFIX, 'planck/node_modules/planck/dist/planck.js'))).default;

const DT = spec.solver.dtSeconds;
const R = 0.9; // circle radius (capsule-equivalent height 1.8)
const results = {
  runId: spec.runId,
  candidate: 'planck@1.5.0',
  plane: spec.plane.convention,
  notes: [
    'circle r=0.9 approximates the course capsule (no capsule shape in planck/Box2D)',
    'kinematic bodies get NO collision response from the solver — all course collisions must be handled by custom game logic',
    'grounding = downward raycast within 0.05 of the expected floor distance (custom; no built-in ground classification)',
  ],
  phases: {},
};

function buildWorld() {
  const world = new planck.World({ gravity: { x: 0, y: spec.solver.gravity.y } });
  // floor (merge the two floor slabs for this functional probe; seam is a Rapier-CC test)
  const floor = world.createBody({ position: { x: 0, y: -0.25 }, type: planck.Body.STATIC });
  floor.createFixture(planck.Box(20, 0.25));
  // ramp A (43 deg): box half-length 1.5 rotated CCW, bottom-left corner at (2,0)
  const th = (43 * Math.PI) / 180;
  const ramp = world.createBody({ position: { x: 2 + Math.cos(th) * 1.5, y: 0 + Math.sin(th) * 1.5 }, angle: th, type: planck.Body.STATIC });
  ramp.createFixture(planck.Box(1.5, 0.1));
  // wall (face x=9.5)
  const wall = world.createBody({ position: { x: 9.75, y: 1.5 }, type: planck.Body.STATIC });
  wall.createFixture(planck.Box(0.25, 1.5));
  const char = world.createBody({ position: { x: -10, y: 0.9 }, type: planck.Body.KINEMATIC });
  char.createFixture(planck.Circle(R));
  return { world, char };
}

function grounded(world, pos) {
  // downward ray from just below the circle center to 1.4 m below center.
  // First hit distance below center ≈ 0.01 + 1.39 * fraction. Grounded when
  // that distance is within 0.05 of the circle radius (custom logic —
  // planck has no built-in ground classification).
  const start = { x: pos.x, y: pos.y - 0.01 };
  const span = 1.39;
  let dist = -1;
  world.rayCast(start, { x: pos.x, y: pos.y - 1.4 }, (_input, _fixture, _point, fraction) => {
    dist = 0.01 + span * fraction;
    return 0; // terminate at first hit
  });
  if (dist < 0) return false;
  return dist >= R - 0.05 && dist <= R + 0.05;
}

// P1 — flat-ground walk + grounding (120 steps at 4 m/s).
{
  const { world, char } = buildWorld();
  let ungrounded = 0;
  for (let i = 0; i < 120; i++) {
    const p = char.getPosition();
    if (!grounded(world, { x: p.x, y: p.y })) ungrounded += 1;
    char.setLinearVelocity({ x: 4, y: 0 });
    world.step(DT);
  }
  const p = char.getPosition();
  results.phases.P1_flatWalk = {
    endPos: { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(4)) },
    ungroundedSteps: ungrounded,
    outOfBox: ungrounded === 0 ? 'walks at commanded speed with consistent raycast grounding (the raycast is custom code — no built-in ground classification)' : 'INCONSISTENT raycast grounding — see ungroundedSteps',
  };
}

// P2 — wall approach: does the kinematic body stop at the face, or pass through?
{
  const { world, char } = buildWorld();
  char.setPosition({ x: 8.4, y: 0.9 });
  let maxPenetration = 0;
  for (let i = 0; i < 240; i++) {
    char.setLinearVelocity({ x: 4, y: 0 });
    world.step(DT);
    const p = char.getPosition();
    // face at x=9.5; circle side reaches the face at center x = 9.5 - 0.9 = 8.6
    const pen = p.x - (9.5 - R);
    if (pen > maxPenetration) maxPenetration = pen;
  }
  const p = char.getPosition();
  results.phases.P2_wall = {
    endPos: { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)) },
    maxPenetrationM: Number(maxPenetration.toFixed(3)),
    outOfBox: maxPenetration > 0.1 ? 'KINEMATIC BODY PASSES THROUGH THE STATIC WALL — no collision response; M2 must implement manual penetration correction (cast-circle backoff or contact-driven impulse logic)' : 'stopped (unexpected — verify)',
  };
}

// P3 — 43 deg ramp attempt (240 steps pushing up): does the circle climb?
{
  const { world, char } = buildWorld();
  char.setPosition({ x: 1.2, y: 0.9 });
  let maxGain = 0;
  let groundedLosses = 0;
  let wasGrounded = false;
  for (let i = 0; i < 240; i++) {
    char.setLinearVelocity({ x: 4, y: 0 });
    world.step(DT);
    const p = char.getPosition();
    const g = grounded(world, { x: p.x, y: p.y });
    if (wasGrounded && !g) groundedLosses += 1;
    wasGrounded = g;
    if (p.y > 0.9 + maxGain) maxGain = p.y - 0.9;
  }
  const p = char.getPosition();
  results.phases.P3_ramp43 = {
    endPos: { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)) },
    maxHeightGainM: Number(maxGain.toFixed(3)),
    groundedLossEvents: groundedLosses,
    outOfBox: maxGain < 0.5 ? 'circle does NOT climb the 43 deg ramp — falls/slides at the base corner (Box2D edge case); M2 needs edge-snapping + slope classification + custom slope response to match the Rapier CC behavior' : 'climbed — inspect',
  };
}

// P4 — jump on flat ground (game logic: vy=7 when raycast-grounded, else gravity).
{
  const { world, char } = buildWorld();
  let vy = 0;
  let maxGain = 0;
  for (let i = 0; i < 300; i++) {
    const p = char.getPosition();
    if (i === 0 && grounded(world, { x: p.x, y: p.y })) { vy = 7; }
    else if (!grounded(world, { x: p.x, y: p.y })) { vy += spec.solver.gravity.y * DT; if (vy < spec.character.maxFallSpeed) vy = spec.character.maxFallSpeed; }
    else { vy = 0; }
    char.setLinearVelocity({ x: 0, y: vy });
    world.step(DT);
    const p2 = char.getPosition();
    if (p2.y > 0.9 + maxGain) maxGain = p2.y - 0.9;
  }
  results.phases.P4_jump = {
    apexGainM: Number(maxGain.toFixed(3)),
    expectedContinuous: 1.249,
    outOfBox: Math.abs(maxGain - 1.249) < 0.06 ? 'jump works with game-logic velocity + raycast grounding (kinematic: no solver help); apex matches free-fall within step discretization' : 'JUMP FAILED — grounding logic or kinematic integration problem (see apexGainM)',
  };
}

results.summary = Object.entries(results.phases).map(([k, v]) => `${k}: end=${JSON.stringify(v.endPos ?? 'n/a')} ${v.outOfBox ? '[' + v.outOfBox.slice(0, 90) + ']' : ''}`).join('\n');
console.log(JSON.stringify(results, null, 2));
process.exit(0);
