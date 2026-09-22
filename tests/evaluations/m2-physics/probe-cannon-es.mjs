#!/usr/bin/env node
/**
 * Packet 14 — bounded FUNCTIONAL comparison probe: cannon-es@0.20.0 (JS 3D,
 * no WASM) against the same static-course requirements, constrained to the XY
 * plane (Z=0) per the 2.5D proposal. Controller-work comparison, NOT a
 * browser benchmark (m2-physics.md experiment 6).
 *
 * Standalone (BR-1): not a vitest test; imports the candidate from the
 * disposable prefix (EVAL_PREFIX), never the repo lockfile.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, 'course-spec.json'), 'utf8'));
const PREFIX = process.env.EVAL_PREFIX ?? '/tmp/tl-m2-eval-14';
const CANNON = await import(join(PREFIX, 'cannon-es/node_modules/cannon-es/dist/cannon-es.js'));

const DT = spec.solver.dtSeconds;
const STATIC_GROUP = 0x1;
const CHAR_GROUP = 0x2;
const RAD = (d) => (d * Math.PI) / 180;
const results = {
  runId: spec.runId,
  candidate: 'cannon-es@0.20.0',
  plane: spec.plane.convention,
  notes: [
    '3D engine constrained to XY (Z=0); planar constraint is M2 game logic, not an engine feature',
    'KINEMATIC bodies are moved by velocity but get NO collision response — all course collisions must be custom game logic',
    'grounding raycasts need explicit collision-filter groups to exclude the character body (self-hit measured: constant 0.89 m)',
    'cannon-es 0.20.0 has NO Capsule shape — the course capsule (total height 1.8) is approximated by a sphere of radius 0.9; shape mismatch is a controller-work item',
    'grounding = world.raycastClosest downward within 0.05 of the capsule reach (custom; no built-in ground classification)',
  ],
  phases: {},
};

function buildWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, spec.solver.gravity.y, 0) });
  const floor = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(20, 0.25, 20)), collisionFilterGroup: STATIC_GROUP });
  floor.position.set(0, -0.25, 0);
  world.addBody(floor);
  const th = RAD(43);
  const ramp = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(1.5, 0.1, 20)), collisionFilterGroup: STATIC_GROUP });
  ramp.position.set(2 + Math.cos(th) * 1.5, Math.sin(th) * 1.5, 0);
  ramp.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), th);
  world.addBody(ramp);
  const wall = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(0.25, 1.5, 20)), collisionFilterGroup: STATIC_GROUP });
  wall.position.set(9.75, 1.5, 0);
  world.addBody(wall);
  // character: sphere r=0.9 (no Capsule shape in cannon-es 0.20.0)
  const char = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, shape: new CANNON.Sphere(0.9), collisionFilterGroup: CHAR_GROUP, collisionFilterMask: STATIC_GROUP });
  char.position.set(-10, 0.9, 0);
  world.addBody(char);
  return { world, char };
}

function grounded(world, pos) {
  const from = new CANNON.Vec3(pos.x, pos.y - 0.01, 0);
  const to = new CANNON.Vec3(pos.x, pos.y - 1.4, 0);
  const res = new CANNON.RaycastResult();
  // custom controller-work: exclude the character's own body from the
  // grounding raycast (cannon raycasts hit the character sphere's own bottom
  // otherwise — measured: constant 0.89 m distance regardless of position).
  const hit = world.raycastClosest(from, to, { skipBackfaces: false, collisionFilterMask: STATIC_GROUP }, res);
  if (!hit) return false;
  const dist = 0.01 + res.distance;
  return dist >= 0.85 && dist <= 0.95; // sphere reach 0.9 ± 0.05
}

// P1 — flat-ground walk + grounding (120 steps at 4 m/s).
{
  const { world, char } = buildWorld();
  let ungrounded = 0;
  for (let i = 0; i < 120; i++) {
    if (!grounded(world, char.position)) ungrounded += 1;
    char.velocity.set(4, 0, 0);
    world.step(DT);
  }
  results.phases.P1_flatWalk = {
    endPos: { x: Number(char.position.x.toFixed(3)), y: Number(char.position.y.toFixed(4)) },
    ungroundedSteps: ungrounded,
    outOfBox: ungrounded === 0 ? 'walks at commanded speed with consistent raycast grounding (raycast is custom code — no built-in ground classification)' : 'INCONSISTENT raycast grounding — see ungroundedSteps',
  };
}

// P2 — wall approach: stop or pass through?
{
  const { world, char } = buildWorld();
  char.position.set(8.4, 0.9, 0);
  let maxPenetration = 0;
  for (let i = 0; i < 240; i++) {
    char.velocity.set(4, 0, 0);
    world.step(DT);
    const pen = char.position.x - (9.5 - 0.9); // sphere side reaches face at center 8.6
    if (pen > maxPenetration) maxPenetration = pen;
  }
  results.phases.P2_wall = {
    endPos: { x: Number(char.position.x.toFixed(3)), y: Number(char.position.y.toFixed(3)) },
    maxPenetrationM: Number(maxPenetration.toFixed(3)),
    outOfBox: maxPenetration > 0.1 ? 'KINEMATIC BODY PASSES THROUGH THE STATIC WALL — no collision response; M2 must implement manual penetration correction' : 'stopped (unexpected — verify)',
  };
}

// P3 — 43 deg ramp attempt (240 steps pushing up).
{
  const { world, char } = buildWorld();
  char.position.set(1.2, 0.9, 0);
  let maxGain = 0;
  for (let i = 0; i < 240; i++) {
    char.velocity.set(4, 0, 0);
    world.step(DT);
    if (char.position.y > 0.9 + maxGain) maxGain = char.position.y - 0.9;
  }
  results.phases.P3_ramp43 = {
    endPos: { x: Number(char.position.x.toFixed(3)), y: Number(char.position.y.toFixed(3)) },
    maxHeightGainM: Number(maxGain.toFixed(3)),
    outOfBox: maxGain < 0.5 ? 'capsule does NOT climb the 43 deg ramp (no slope/edge response for kinematic bodies); M2 needs custom slope response + edge handling' : 'climbed — inspect',
  };
}

// P4 — jump on flat ground (game logic: vy=7 when raycast-grounded, else gravity).
{
  const { world, char } = buildWorld();
  let vy = 0;
  let maxGain = 0;
  for (let i = 0; i < 300; i++) {
    const g = grounded(world, char.position);
    if (i === 0 && g) vy = 7;
    else if (!g) { vy += spec.solver.gravity.y * DT; if (vy < spec.character.maxFallSpeed) vy = spec.character.maxFallSpeed; }
    else vy = 0;
    char.velocity.set(0, vy, 0);
    world.step(DT);
    if (char.position.y > 0.9 + maxGain) maxGain = char.position.y - 0.9;
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
