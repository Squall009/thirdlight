#!/usr/bin/env node
/**
 * Packet 14 — standalone evaluation probe: @dimforge/rapier2d-compat (0.20.0)
 * against the frozen course-spec.json fixture (m2-physics.md experiment 1/4).
 *
 * Standalone by design (plan-review BR-1): this file is NOT a vitest test, is
 * not typechecked/boundary-checked by the repo toolchain, and imports the
 * candidate from a DISPOSABLE isolated prefix (env EVAL_PREFIX, default
 * /tmp/tl-m2-eval-14) — never from the repo lockfile/node_modules.
 *
 * Usage:
 *   node probe-rapier2d.mjs phases   # T1..T9,T11 correctness phases (fresh world per phase)
 *   node probe-rapier2d.mjs cpu      # 3 runs x (5 s warmup + 30 s measure) patrol, per-step cost
 *   node coldinit-sample.mjs  # fresh-process cold-init sample (import+init+first step); run 3x
 *
 * API pinned against the 0.20.0 d.ts (NOT the unversioned rapier.rs doc links
 * in the planning brief — the 0.20.0 controller API is
 * world.createCharacterController(offset) + computeColliderMovement, see
 * evidence 03-api-surface.md).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, 'course-spec.json'), 'utf8'));
const PREFIX = process.env.EVAL_PREFIX ?? '/tmp/tl-m2-eval-14';
const RAPIER_PATH = join(PREFIX, 'rapier2d-compat/node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs');
const mode = process.argv[2] ?? 'phases';

const RAPIER = await import(RAPIER_PATH);
await RAPIER.init();
const rapierVersion = RAPIER.version();

const DT = spec.solver.dtSeconds;
const CH = spec.character;
const CC = CH.controller;
const RAD = (d) => (d * Math.PI) / 180;

function buildWorld() {
  const world = new RAPIER.World({ x: 0, y: spec.solver.gravity.y });
  world.timestep = DT;
  for (const b of spec.statics.bodies) {
    if (b.id === 'filler') {
      for (let i = 0; i < b.count; i++) {
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(24 + 0.75 * i, 0.25));
        world.createCollider(RAPIER.ColliderDesc.cuboid(b.half.x, b.half.y), body);
      }
      continue;
    }
    if (b.slopeDeg !== undefined) {
      // ramp cuboid: bottom-left corner at `base`, rotated CCW by slopeDeg.
      const th = RAD(b.slopeDeg);
      const cx = b.base.x + Math.cos(th) * b.half.x;
      const cy = b.base.y + Math.sin(th) * b.half.x;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy));
      world.createCollider(RAPIER.ColliderDesc.cuboid(b.half.x, b.half.y).setRotation(th), body);
      continue;
    }
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.center.x, b.center.y));
    world.createCollider(RAPIER.ColliderDesc.cuboid(b.half.x, b.half.y), body);
  }
  // PARENTLESS collider (documented pattern for computeColliderMovement:
  // "a collider not attached to any rigid-body: set the collider's position
  // directly" — rapier.rs character_controller_setup). A parented collider is
  // re-synced toward its (immovable) body by world.step() and breaks the loop.
  const charCollider = world.createCollider(
    RAPIER.ColliderDesc.capsule(CH.halfHeight, CH.radius).setTranslation(CH.start.x, CH.start.y),
  );
  const cc = world.createCharacterController(CC.offsetSkin);
  cc.setMaxSlopeClimbAngle(RAD(CC.maxSlopeClimbDeg));
  cc.setMinSlopeSlideAngle(RAD(CC.minSlopeSlideDeg));
  cc.enableSnapToGround(CC.groundSnap);
  return { world, charCollider, cc, pos: { x: CH.start.x, y: CH.start.y }, vy: 0, grounded: false, airborne: false, step: 0 };
}

/** 12-step idle settle pre-roll (declared in course-spec note): absorbs the first-step
 *  grounded-state initialization (1.36 mm dip on step 0 when grounded starts false;
 *  recorded as a contract-17 initialization note). Phases assert AFTER settle. */
function settle(sim) {
  for (let i = 0; i < 12; i++) stepCharacter(sim, 0, false);
}

/** One fixed step. Game logic owns gravity/jump intent/velocity (plan §3.4).
 * Grounded and not airborne ⇒ vy = 0 (canonical pattern: gravity integrates only
 * while airborne; official example: movement.y = isGrounded() ? 0 : vy - g*dt).
 * `airborne` bridges the window after a jump where the CC still reports grounded
 * (old ground within the snap-search range) while the capsule is actually rising:
 * gravity integrates until the character descends back into a grounded state. */
function stepCharacter(sim, moveX, jumpEdge) {
  if (jumpEdge && sim.grounded) {
    sim.vy = CH.jumpVelocity;
    sim.airborne = true;
  }
  if (sim.grounded && !sim.airborne) {
    sim.vy = 0;
  } else {
    sim.vy += spec.solver.gravity.y * DT;
    if (sim.vy < CH.maxFallSpeed) sim.vy = CH.maxFallSpeed;
  }
  if (sim.airborne && sim.grounded && sim.vy <= 0) sim.airborne = false; // landed
  const vx = moveX * CH.runSpeed;
  sim.cc.computeColliderMovement(sim.charCollider, { x: vx * DT, y: sim.vy * DT });
  const m = sim.cc.computedMovement();
  const t = sim.charCollider.translation();
  sim.pos = { x: t.x + m.x, y: t.y + m.y };
  sim.charCollider.setTranslation(sim.pos);
  sim.grounded = sim.cc.computedGrounded();
  sim.world.step(); // no dynamic bodies — pipeline update only; included in cost measurement
  sim.step += 1;
}

function place(sim, x, y) {
  sim.charCollider.setTranslation({ x, y });
  sim.pos = { x, y };
  sim.vy = 0;
  sim.grounded = false;
  sim.airborne = false;
}

const results = { runId: spec.runId, candidate: '@dimforge/rapier2d-compat@0.20.0', rapierVersion, mode, phases: {} };
const reach = CH.halfHeight + CH.radius; // 0.9

if (mode === 'coldinit') {
  // Fresh-process cold init (this IS a fresh process); sample import->init->first step.
  const t0 = process.hrtime.bigint();
  // (import + init already happened above; measure what remains + report total via env pass)
  const t1 = process.hrtime.bigint();
  const sim = buildWorld();
  const t2 = process.hrtime.bigint();
  stepCharacter(sim, 0, false);
  const t3 = process.hrtime.bigint();
  results.coldinit = {
    note: 'single-process sample: buildWorld+firstStep only; full import+init timing is measured by coldinit-run.mjs (fresh node process per sample)',
    buildWorldMs: Number(t2 - t1) / 1e6,
    firstStepMs: Number(t3 - t2) / 1e6,
    t0Unused: Number(t0 - t0),
  };
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

if (mode === 'phases') {
  const T = spec.tolerances;
  let phase;

  // T1 idle — grounded stability after the declared settle pre-roll.
  {
    const sim = buildWorld();
    settle(sim);
    let groundedAll = true;
    let maxD = 0;
    let prev = { ...sim.pos };
    for (let i = 0; i < T.T1_idle.steps; i++) {
      stepCharacter(sim, 0, false);
      if (!sim.grounded) groundedAll = false;
      const d = Math.hypot(sim.pos.x - prev.x, sim.pos.y - prev.y);
      if (d > maxD) maxD = d;
      prev = { ...sim.pos };
    }
    phase = { pass: groundedAll && maxD < T.T1_idle.maxPosDeltaPerStep, groundedAll, maxPosDeltaPerStep: maxD, endPos: sim.pos };
    results.phases.T1_idle = phase;
  }

  // T2 flat run + T3 seam — one continuous run from start past the seam.
  {
    const sim = buildWorld();
    settle(sim);
    const x0 = sim.pos.x;
    let minSpeed = Infinity;
    let maxSpeed = -Infinity;
    const speeds = [];
    let prevX = sim.pos.x;
    const seamX = T.T3_seam.seamX;
    const seamHalf = T.T3_seam.seamHalfWidth;
    let seamUngrounded = 0;
    let seamSeen = 0;
    let groundedAll = true;
    let steps = 0;
    let stallSteps = 0;
    while (sim.pos.x < 1.0 && steps < 600) {
      stepCharacter(sim, 1, false);
      const dx = sim.pos.x - prevX;
      prevX = sim.pos.x;
      if (sim.pos.x < 9.0 && dx === 0) stallSteps += 1; // 1-step horizontal stalls (jitter probe)
      if (steps >= 60) {
        const v = dx / DT;
        speeds.push(v);
        if (v < minSpeed) minSpeed = v;
        if (v > maxSpeed) maxSpeed = v;
      }
      if (!sim.grounded) groundedAll = false;
      if (sim.pos.x >= seamX - seamHalf && sim.pos.x <= seamX + seamHalf) {
        seamSeen += 1;
        if (!sim.grounded) seamUngrounded += 1;
      }
      steps += 1;
    }
    const speedOk = speeds.length > 0 && Math.abs(minSpeed - CH.runSpeed) / CH.runSpeed <= T.T2_flatRun.speedBand
      && Math.abs(maxSpeed - CH.runSpeed) / CH.runSpeed <= T.T2_flatRun.speedBand;
    const reachedX = sim.pos.x - x0;
    results.phases.T2_flatRun = {
      pass: speedOk && groundedAll && reachedX > 10.5,
      durationS: steps * DT,
      speedMin: minSpeed, speedMax: maxSpeed, expected: CH.runSpeed,
      groundedAll, reachedX, endPos: sim.pos,
      horizontalStallSteps: stallSteps,
      stallNote: '1-step horizontal stalls at existing floor contact (position unchanged for a step); average speed unaffected — recorded as minor CC jitter',
    };
    results.phases.T3_seam = {
      pass: seamSeen > 0 && seamUngrounded <= T.T3_seam.maxUngroundedSteps,
      seamStepsSeen: seamSeen, seamUngrounded, maxAllowed: T.T3_seam.maxUngroundedSteps,
    };
  }

  // T4 ramp A climb (43 deg < 45 deg limit). The capsule CENTER at the ramp top
  // corner is offset 0.9 along the slope normal: center at corner (4.194, 2.046)
  // is approx (3.579, 2.703) — the exit assertion uses center coordinates.
  {
    const sim = buildWorld();
    place(sim, 1.5, 0.9);
    settle(sim);
    const topCenter = { x: 3.579, y: 2.703 };
    let ascentSteps = 0;
    let ascentGrounded = 0;
    let minYBottom = Infinity;
    let done = false;
    let steps = 0;
    while (!done && steps < 240) {
      stepCharacter(sim, 1, false);
      if (!done) {
        ascentSteps += 1;
        if (sim.grounded) ascentGrounded += 1;
        const yb = sim.pos.y - reach;
        if (yb < minYBottom) minYBottom = yb;
        if (sim.pos.x >= topCenter.x - 0.03) done = true; // capsule center reached the top corner
      }
      steps += 1;
    }
    const exitOk = Math.hypot(sim.pos.x - topCenter.x, sim.pos.y - topCenter.y) < 0.3;
    const frac = ascentSteps ? ascentGrounded / ascentSteps : 0;
    results.phases.T4_rampClimb = {
      pass: frac >= T.T4_rampClimb.minGroundedFractionOfAscent && minYBottom >= T.T4_rampClimb.noPenetrateBelowFloor && exitOk,
      ascentSteps, groundedFraction: frac, minYBottom, endPos: sim.pos,
      note: 'ascent = steps until capsule center reaches the top corner (3.579, 2.703); grounded fraction over the whole ascent',
    };
  }

  // T5 ramp B refuse (47 deg > 45 deg limit).
  {
    const sim = buildWorld();
    place(sim, 5.5, 0.9);
    settle(sim);
    const y0 = sim.pos.y;
    let maxGain = 0;
    const steps = Math.round(T.T5_rampRefuse.pushDurationS / DT);
    for (let i = 0; i < steps; i++) {
      stepCharacter(sim, 1, false);
      const g = sim.pos.y - y0;
      if (g > maxGain) maxGain = g;
    }
    results.phases.T5_rampRefuse = {
      pass: maxGain < T.T5_rampRefuse.maxHeightGainM,
      maxHeighGainM: maxGain, maxAllowed: T.T5_rampRefuse.maxHeightGainM, endPos: sim.pos,
    };
  }

  // T6 wall stop at flat approach (face x=9.5). Controller keeps an `offset` skin gap,
  // so the hard limit is face + reach + offset + tolerance; "stop" = dx collapses.
  {
    const sim = buildWorld();
    place(sim, 8.4, 0.9);
    settle(sim);
    const face = T.T6_wallStop.wallFaceX;
    const hardLimit = face + reach + 0.01 + 0.005; // face + capsule radius + skin + tol
    let maxPenetration = 0;
    let contactStep = -1;
    let prevX = sim.pos.x;
    const dxAfter = [];
    let steps = 0;
    for (let i = 0; i < 300; i++) {
      stepCharacter(sim, 1, false);
      const dx = sim.pos.x - prevX;
      prevX = sim.pos.x;
      if (sim.pos.x - hardLimit > maxPenetration) maxPenetration = sim.pos.x - hardLimit;
      if (contactStep < 0 && dx < 0.01) contactStep = i;
      if (contactStep >= 0) dxAfter.push(dx);
      steps = i + 1;
      if (contactStep >= 0 && i - contactStep > 120) break; // settled window
    }
    const maxDxAfter = dxAfter.length ? Math.max(...dxAfter) : Infinity;
    results.phases.T6_wallStop = {
      pass: maxPenetration <= 0 && maxDxAfter < 0.02,
      finalCenterX: sim.pos.x, hardLimit, maxPenetration, contactStep, maxDxAfterContact: maxDxAfter, steps,
    };
  }

  // T7 head bump — climb ramp A, then jump straight up near its top under the ceiling
  // (underside y=4.0; clamp plane for the center = 4.0 - 0.9 reach + 0.01 skin + 0.005 tol = 3.115).
  // A 7 m/s jump from the floor only reaches 2.149 — it cannot hit this ceiling, so the
  // head-bump case is deliberately started from the ramp top (declared here, before the run).
  {
    const sim = buildWorld();
    place(sim, 1.5, 0.9);
    settle(sim);
    // phase a: climb to the ramp top corner (capsule center x >= 3.55 while grounded;
    // the center never exceeds approx 3.58 at the corner)
    let climbed = false;
    for (let i = 0; i < 240 && !climbed; i++) {
      stepCharacter(sim, 1, false);
      if (sim.pos.x >= 3.55 && sim.grounded) climbed = true;
    }
    const yAtJump = sim.pos.y;
    // phase b: jump straight up
    let maxCenterY = 0;
    let apexStep = -1;
    let maxVyAfter = 0;
    let prevY = sim.pos.y;
    let jumped = false;
    let landed = false;
    for (let i = 0; i < 300; i++) {
      const edge = i === 0 && !jumped;
      stepCharacter(sim, 0, edge);
      if (edge) jumped = true;
      if (sim.pos.y > maxCenterY) { maxCenterY = sim.pos.y; apexStep = i; }
      const dyPerStep = (sim.pos.y - prevY) / DT;
      if (apexStep >= 0 && i >= apexStep + 1) {
        if (dyPerStep > maxVyAfter) maxVyAfter = dyPerStep;
      }
      prevY = sim.pos.y;
      if (sim.grounded && i > 60) { landed = true; break; }
    }
    results.phases.T7_headBump = {
      pass: climbed && maxCenterY >= T.T7_headBump.contactMinCenterY && maxCenterY <= T.T7_headBump.maxCenterY && maxVyAfter <= 5e-4,
      yAtJump, maxCenterY, clampPlane: T.T7_headBump.maxCenterY, reachedCeiling: maxCenterY >= T.T7_headBump.contactMinCenterY,
      maxVyAfterContact: maxVyAfter, landed,
      note: 'ceiling contact = collider top within skin(0.01)+tol of 4.0 i.e. center >= contactMinCenterY; clamp plane = 4.0 - 0.9 reach - 0.01 skin + 0.005 tol; realized per-step dy after the apex step must not exceed the CC nudge scale (5e-4 m/step ≈ 0.06 m/s); sustained rise would fail',
    };
  }

  // T8 ledge — walk-into block (from x=11.0, 60 steps), then jump-on land.
  {
    const sim = buildWorld();
    place(sim, 11.0, 0.9);
    settle(sim);
    const limit = 12.0 + reach; // ledge face at x=12; capsule side reaches it at center 12.3
    let prevX = sim.pos.x;
    let contactStep = -1;
    const dxAfter = [];
    for (let i = 0; i < T.T8_ledge.blockSteps; i++) {
      stepCharacter(sim, 1, false);
      const dx = sim.pos.x - prevX;
      prevX = sim.pos.x;
      if (contactStep < 0 && dx < 0.01) contactStep = i;
      if (contactStep >= 0) dxAfter.push(dx);
    }
    const maxDxAfter = dxAfter.length ? Math.max(...dxAfter) : Infinity;
    const blockedOk = contactStep >= 0 && maxDxAfter < T.T8_ledge.blockMaxDxPerStep;
    const xBlockedAt = sim.pos.x;
    // jump on from the blocked position, moving forward (M2 has no autostep —
    // a 0.4 m step is taken with a forward jump, not by walking up)
    let landed = false;
    let groundedSteps = 0;
    for (let i = 0; i < 240 && !landed; i++) {
      stepCharacter(sim, 1, i === 0);
      if (sim.grounded && Math.abs(sim.pos.y - T.T8_ledge.landTopY) < 0.1) {
        groundedSteps += 1;
        if (groundedSteps >= T.T8_ledge.groundedWithinStepsOfContact) landed = true;
      } else {
        groundedSteps = 0;
      }
    }
    results.phases.T8_ledge = {
      pass: blockedOk && landed && Math.abs(sim.pos.y - T.T8_ledge.landTopY) <= T.T8_ledge.landTol,
      contactStep, blockedOk, maxDxAfter, xBlockedAt, landedY: sim.pos.y, expectedLandY: T.T8_ledge.landTopY,
    };
  }

  // T9 high-speed wall approach (12 m/s, no tunneling).
  {
    const sim = buildWorld();
    place(sim, 8.4, 0.9);
    settle(sim);
    const hardLimit = T.T6_wallStop.wallFaceX + reach + 0.01 + 0.005;
    let maxPenetration = 0;
    let contactStep = -1;
    let prevX = sim.pos.x;
    let steps = 0;
    for (let i = 0; i < 300; i++) {
      const saveSpeed = CH.runSpeed;
      CH.runSpeed = T.T9_highSpeed.approachSpeed;
      stepCharacter(sim, 1, false);
      CH.runSpeed = saveSpeed;
      const dx = sim.pos.x - prevX;
      prevX = sim.pos.x;
      if (sim.pos.x - hardLimit > maxPenetration) maxPenetration = sim.pos.x - hardLimit;
      if (contactStep < 0 && dx < 0.02) contactStep = i;
      steps = i + 1;
      if (contactStep >= 0 && i - contactStep > 60) break;
    }
    // 12 m/s = 0.1 m/step, so "contact" = first step moving less than half a step.
    results.phases.T9_highSpeed = {
      pass: maxPenetration <= 0 && contactStep >= 0,
      maxPenetration, contactStep, steps,
      note: 'tunneling (penetration beyond skin+tol) is the hard fail; stop dynamics recorded for contract 17',
    };
  }

  // T11 free jump height (x=0.5; ceiling at 4.0 is far above the 2.149 apex).
  {
    const sim = buildWorld();
    place(sim, 0.5, 0.9);
    settle(sim);
    let maxCenterY = 0;
    let jumped = false;
    for (let i = 0; i < 300; i++) {
      stepCharacter(sim, 0, i === 0 && !jumped);
      if (i === 0) jumped = true;
      if (sim.pos.y > maxCenterY) maxCenterY = sim.pos.y;
      if (sim.grounded && i > 60) break;
    }
    const apexGain = maxCenterY - 0.9;
    results.phases.T11_jumpHeight = {
      pass: Math.abs(apexGain - T.T11_jumpHeight.expectedApexM) <= T.T11_jumpHeight.toleranceM,
      apexGainM: apexGain, expected: T.T11_jumpHeight.expectedApexM,
      note: 'v^2/2g = 7^2/(2*19.62) = 1.249 m theoretical; discrete fixed-step result',
    };
  }

  // T12 — degenerate-input robustness (documented candidate limitation):
  // command a large downward delta (-3 m/s) while GROUNDed on flat ground.
  // Correct M2 game logic never does this (grounded ⇒ vy=0), but the CC must
  // not silently miss the floor. 60 steps; report penetration + grounded misses.
  {
    const sim = buildWorld();
    settle(sim);
    let maxPenetration = 0;
    let groundedMisses = 0;
    let minY = sim.pos.y;
    for (let i = 0; i < 60; i++) {
      sim.cc.computeColliderMovement(sim.charCollider, { x: 0, y: -3 * DT });
      const m = sim.cc.computedMovement();
      const t = sim.charCollider.translation();
      sim.pos = { x: t.x + m.x, y: t.y + m.y };
      sim.charCollider.setTranslation(sim.pos);
      sim.world.step();
      sim.grounded = sim.cc.computedGrounded();
      if (!sim.grounded) groundedMisses += 1;
      if (sim.pos.y < minY) minY = sim.pos.y;
      const pen = -(sim.pos.y - reach);
      if (pen > maxPenetration) maxPenetration = pen;
    }
    results.phases.T12_degenerateDown = {
      pass: false, // informational — not a course tolerance
      minCenterY: Number(minY.toFixed(5)),
      maxPenetrationM: Number(maxPenetration.toFixed(5)),
      groundedFlagMisses: groundedMisses,
      note: 'DEGENERATE INPUT (never produced by correct game logic, which clamps grounded ⇒ vy=0). ' +
        (maxPenetration > 0.01
          ? 'OBSERVED: the CC sweep missed the floor for at least one step and the capsule sank below it (reproduced; see handoff 14). M2 adapter guard: never command a downward delta while grounded.'
          : 'no penetration under degenerate downward input'),
    };
  }

  // T10: no Z dimension in 2D candidates — recorded, not tested (spec.plane).
  results.phases.T10_zDrift = { pass: true, note: 'not applicable: 2D candidates have no Z axis; M2 3D scene mapping keeps Z fixed by construction (contract 17)' };

  results.summary = Object.entries(results.phases).map(([k, v]) => `${k}: ${v.pass === false && k === 'T12_degenerateDown' ? 'INFO (limitation, see note)' : v.pass ? 'PASS' : 'FAIL'}`).join('\n');
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

if (mode === 'cpu') {
  const m = spec.measurement;
  const warmupSteps = Math.round(m.warmupS / DT);
  const measureSteps = Math.round(m.measureS / DT);
  const runResults = [];
  for (let run = 0; run < m.runs; run++) {
    const sim = buildWorld();
    const controllerCosts = [];
    const worldStepCosts = [];
    const totalCosts = [];
    let jump1Done = false;
    let jump2Done = false;
    for (let i = 0; i < warmupSteps + measureSteps; i++) {
      // patrol per spec: right at 4 m/s; free jump at x=-5 and x=5 (edge while grounded)
      let edge = false;
      if (sim.grounded && !jump1Done && sim.pos.x >= -5.0) { edge = true; jump1Done = true; }
      if (sim.grounded && !jump2Done && sim.pos.x >= 5.0) { edge = true; jump2Done = true; }
      if (i >= warmupSteps) {
        const t0 = process.hrtime.bigint();
        if (edge && sim.grounded) { sim.vy = CH.jumpVelocity; sim.airborne = true; }
        if (sim.grounded && !sim.airborne) { sim.vy = 0; } else { sim.vy += spec.solver.gravity.y * DT; if (sim.vy < CH.maxFallSpeed) sim.vy = CH.maxFallSpeed; }
        if (sim.airborne && sim.grounded && sim.vy <= 0) sim.airborne = false;
        sim.cc.computeColliderMovement(sim.charCollider, { x: CH.runSpeed * DT, y: sim.vy * DT });
        const mv = sim.cc.computedMovement();
        const t1 = process.hrtime.bigint();
        const t = sim.charCollider.translation();
        sim.pos = { x: t.x + mv.x, y: t.y + mv.y };
        sim.charCollider.setTranslation(sim.pos);
        sim.grounded = sim.cc.computedGrounded();
        sim.world.step();
        const t2 = process.hrtime.bigint();
        controllerCosts.push(Number(t1 - t0));
        worldStepCosts.push(Number(t2 - t1));
        totalCosts.push(Number(t2 - t0));
      } else {
        stepCharacter(sim, 1, edge);
      }
      if (sim.pos.x > 19.0) { // patrol end (past the ledge); wrap back to start for the 30 s window
        place(sim, CH.start.x, CH.start.y);
        jump1Done = false;
        jump2Done = false;
      }
    }
    const pct = (a, p) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] / 1e6; // ns -> ms
    };
    runResults.push({
      run,
      samples: totalCosts.length,
      controllerMs: { p50: pct(controllerCosts, 50), p95: pct(controllerCosts, 95), p99: pct(controllerCosts, 99) },
      worldStepMs: { p50: pct(worldStepCosts, 50), p95: pct(worldStepCosts, 95), p99: pct(worldStepCosts, 99) },
      totalStepMs: { p50: pct(totalCosts, 50), p95: pct(totalCosts, 95), p99: pct(totalCosts, 99) },
      tickBudgetMs: 8.333,
    });
  }
  results.cpu = {
    machine: 'container (NOT the reference desktop — directional only, plan-review BR-2)',
    node: process.version,
    fixture: '1 kinematic capsule + 64 static colliders (course-spec.json)',
    warmupS: m.warmupS, measureS: m.measureS, runs: m.runs,
    profilingLimits: 'process.hrtime.bigint(); no GC isolation (spikes included in percentiles); single-threaded; Node, not a browser — no GPU involvement',
    runs: runResults,
  };
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

console.error('unknown mode:', mode);
process.exit(2);