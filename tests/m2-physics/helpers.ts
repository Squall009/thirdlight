/**
 * Packet 31 — shared fixture-replay helpers for the real-library physics
 * tests (`tests/m2-physics/**`).
 *
 * These helpers implement the packet-14 canonical character model
 * (`tests/evaluations/m2-physics/probe-rapier2d.mjs`) as the temporary driver:
 * game logic owns gravity/jump intent/velocity, the adapter owns collision
 * correction. The platformer controller module itself is packet 32.
 *
 * Nothing here is a fixture of its own: the expectations come from
 * `fixtures/m2/physics/**` (frozen packet-14 tolerances + the accepted
 * physics contract), and every result is validated with the runtime's own
 * `validateCharacterMoveResult` (the accepted port result rule).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateCharacterMoveResult,
  type CharacterMoveResult,
  type Vec2,
} from '@thirdlight/runtime';
import type { RapierPhysicsInitConfig, RapierStaticColliderSpec } from '@thirdlight/physics-rapier';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
export const FIXTURES = join(REPO, 'fixtures', 'm2', 'physics');
export const DT = 1 / 120;
export const REACH = 0.9;

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function fixture<T>(name: string): T {
  return readJson<T>(join(FIXTURES, name));
}

export interface CharacterSpec {
  start: Vec2;
  capsule: { radius: number; halfHeight: number };
  runSpeed: number;
  jumpVelocity: number;
  maxFallSpeed: number;
}

export interface CourseFile {
  kind: string;
  id: string;
  solver: { hz: 120; gravityY: number };
  character: CharacterSpec;
  controller: RapierPhysicsInitConfig['controller'];
  statics: RapierStaticColliderSpec[];
}

export interface Segment {
  steps: number;
  moveX: number;
  speed?: number;
  jumpOnFirst?: boolean;
  stopWhen?: { xAtLeast?: number; grounded?: boolean };
}

export interface CaseExpectation {
  groundedEveryStep?: boolean;
  groundedAtLeastOnce?: boolean;
  groundedFractionMin?: number;
  maxUngroundedSteps?: number;
  minUngroundedSteps?: number;
  firstStepGrounded?: boolean;
  firstStepSteepSlope?: boolean;
  firstStepSupportNormalY?: { value: number; tolerance: number };
  supportNormalY?: { value: number; tolerance: number };
  minSupportNormalY?: number;
  maxStepDelta?: number;
  minCapsuleBottom?: { value: number; tolerance: number };
  finalX?: { value: number; tolerance: number };
  finalY?: { value: number; tolerance: number };
  maxX?: number;
  minX?: number;
  minFinalX?: number;
  maxY?: number;
  maxCenterY?: { value: number; tolerance: number };
  minHeightGain?: number;
  maxHeightGain?: number;
  minHeightLoss?: number;
  maxHeightLoss?: number;
  speedBand?: number;
  contactsAtLeastOnce?: Partial<Record<'ground' | 'wall' | 'head' | 'steepSlope', boolean>>;
  snappedAtLeastOnce?: boolean;
  snappedWhileAirborneNever?: boolean;
  maxStepRiseAfterContact?: { contact: 'head' | 'wall' | 'ground' | 'steepSlope'; limit: number };
  noZ?: boolean;
}

export interface PhysicsCase {
  id: string;
  description: string;
  course: string;
  start: Vec2;
  settleSteps: number;
  segments: Segment[];
  expect: CaseExpectation;
  pins: string[];
}

export interface StepRecord {
  index: number;
  moveX: number;
  requested: Vec2;
  result: CharacterMoveResult;
}

export function buildConfig(course: CourseFile, start: Vec2): RapierPhysicsInitConfig {
  return {
    character: { x: start.x, y: start.y },
    statics: course.statics,
    solver: course.solver,
    controller: course.controller,
  };
}

export interface RunResult {
  records: StepRecord[];
  /** Steps executed before the measured window (the settle pre-roll). */
  settleSteps: number;
  /** The authored start position (the authoritative basis of step 0). */
  start: Vec2;
  /** Runtime result-validation failures (must be empty). */
  invalid: string[];
  /** Z keys found in any result (must be empty). */
  zKeys: string[];
}

/**
 * Drive one case through the real port with the packet-14 canonical model.
 * Every returned result is checked with the runtime's accepted
 * `validateCharacterMoveResult`.
 */
export function runCase(
  port: import('@thirdlight/runtime').PhysicsPort,
  course: CourseFile,
  physicsCase: PhysicsCase,
  records: StepRecord[] = [],
): RunResult {
  const { runSpeed, jumpVelocity, maxFallSpeed } = course.character;
  const invalid: string[] = [];
  const zKeys: string[] = [];
  let vy = 0;
  let airborne = false;
  let last: CharacterMoveResult | undefined;
  let previous: Vec2 = { x: physicsCase.start.x, y: physicsCase.start.y };
  let index = 0;

  const scanZ = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => scanZ(v, `${path}[${i}]`));
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [k, v] of Object.entries(value)) {
      if (k === 'z') zKeys.push(`${path}.z`);
      scanZ(v, `${path}.${k}`);
    }
  };

  const step = (moveX: number, jump: boolean, speed: number): CharacterMoveResult => {
    const grounded = last?.grounded === true;
    if (jump && grounded) {
      vy = jumpVelocity;
      airborne = true;
    }
    if (grounded && !airborne) {
      vy = 0;
    } else {
      vy += course.solver.gravityY * DT;
      if (vy < maxFallSpeed) vy = maxFallSpeed;
    }
    if (airborne && grounded && vy <= 0) airborne = false;
    const requested = { x: moveX * speed * DT, y: vy * DT };
    port.stageCharacterMove(requested);
    const result = port.step();
    const check = validateCharacterMoveResult(result, previous, requested);
    if (!check.ok) invalid.push(`step ${index}: ${check.failure.detail}`);
    scanZ(result, `step ${index}`);
    previous = { x: result.position.x, y: result.position.y };
    last = result;
    records.push({ index, moveX, requested: { ...requested }, result });
    index += 1;
    return result;
  };

  for (let i = 0; i < physicsCase.settleSteps; i += 1) step(0, false, runSpeed);
  for (const segment of physicsCase.segments) {
    for (let i = 0; i < segment.steps; i += 1) {
      const result = step(segment.moveX, Boolean(segment.jumpOnFirst) && i === 0, segment.speed ?? runSpeed);
      const stop = segment.stopWhen;
      if (stop) {
        const xOk = stop.xAtLeast === undefined || result.position.x >= stop.xAtLeast;
        const groundedOk = stop.grounded === undefined || result.grounded === stop.grounded;
        if (xOk && groundedOk) break;
      }
    }
  }
  return { records, settleSteps: physicsCase.settleSteps, start: { ...physicsCase.start }, invalid, zKeys };
}

/** Evaluate the declared expectation bands; returns a list of failures. */
export function evaluate(
  run: RunResult,
  physicsCase: PhysicsCase,
  startHeight: number,
): string[] {
  const failures: string[] = [];
  const expect = physicsCase.expect;
  // Expectations describe the measured window: the settle pre-roll (a declared
  // part of the model) is not gameplay.
  const measured = run.records.slice(run.settleSteps);
  const results = measured.map((r) => r.result);
  const n = results.length;
  const fail = (label: string, got: unknown): void => {
    failures.push(`${physicsCase.id}: ${label} (got ${JSON.stringify(got)})`);
  };
  if (run.invalid.length > 0) failures.push(`${physicsCase.id}: runtime result validation: ${run.invalid.join('; ')}`);
  if (run.zKeys.length > 0) failures.push(`${physicsCase.id}: Z keys present: ${run.zKeys.join(', ')}`);
  if (n === 0) {
    failures.push(`${physicsCase.id}: no steps ran`);
    return failures;
  }

  const groundedCount = results.filter((r) => r.grounded).length;
  const ungroundedCount = n - groundedCount;
  if (expect.groundedEveryStep && ungroundedCount !== 0) fail('groundedEveryStep', ungroundedCount);
  if (expect.groundedAtLeastOnce && groundedCount === 0) fail('groundedAtLeastOnce', groundedCount);
  if (expect.groundedFractionMin !== undefined && groundedCount / n < expect.groundedFractionMin) {
    fail('groundedFractionMin', groundedCount / n);
  }
  if (expect.maxUngroundedSteps !== undefined && ungroundedCount > expect.maxUngroundedSteps) {
    fail('maxUngroundedSteps', ungroundedCount);
  }
  if (expect.minUngroundedSteps !== undefined && ungroundedCount < expect.minUngroundedSteps) {
    fail('minUngroundedSteps', ungroundedCount);
  }
  if (expect.firstStepGrounded !== undefined && results[0]!.grounded !== expect.firstStepGrounded) {
    fail('firstStepGrounded', results[0]!.grounded);
  }
  if (expect.firstStepSteepSlope !== undefined && results[0]!.contacts.steepSlope !== expect.firstStepSteepSlope) {
    fail('firstStepSteepSlope', results[0]!.contacts.steepSlope);
  }
  if (expect.firstStepSupportNormalY) {
    const got = results[0]!.supportNormal.y;
    if (Math.abs(got - expect.firstStepSupportNormalY.value) > expect.firstStepSupportNormalY.tolerance) {
      fail('firstStepSupportNormalY', got);
    }
  }
  if (expect.supportNormalY) {
    for (const r of results) {
      if (Math.abs(r.supportNormal.y - expect.supportNormalY.value) > expect.supportNormalY.tolerance) {
        fail('supportNormalY', r.supportNormal.y);
        break;
      }
    }
  }
  if (expect.minSupportNormalY !== undefined) {
    const min = Math.min(...results.map((r) => r.supportNormal.y));
    if (min < expect.minSupportNormalY) fail('minSupportNormalY', min);
  }
  if (expect.maxStepDelta !== undefined) {
    let max = 0;
    for (let i = 1; i < n; i += 1) {
      const a = results[i - 1]!.position;
      const b = results[i]!.position;
      max = Math.max(max, Math.hypot(b.x - a.x, b.y - a.y));
    }
    if (max > expect.maxStepDelta) fail('maxStepDelta', max);
  }
  if (expect.minCapsuleBottom) {
    const minBottom = Math.min(...results.map((r) => r.position.y - REACH));
    if (minBottom < expect.minCapsuleBottom.value - expect.minCapsuleBottom.tolerance) {
      fail('minCapsuleBottom', minBottom);
    }
  }
  const last = results[n - 1]!;
  if (expect.finalX && Math.abs(last.position.x - expect.finalX.value) > expect.finalX.tolerance) {
    fail('finalX', last.position.x);
  }
  if (expect.finalY && Math.abs(last.position.y - expect.finalY.value) > expect.finalY.tolerance) {
    fail('finalY', last.position.y);
  }
  if (expect.maxX !== undefined) {
    const maxX = Math.max(...results.map((r) => r.position.x));
    if (maxX > expect.maxX) fail('maxX', maxX);
  }
  if (expect.minX !== undefined) {
    const minX = Math.min(...results.map((r) => r.position.x));
    if (minX < expect.minX) fail('minX', minX);
  }
  if (expect.minFinalX !== undefined && last.position.x < expect.minFinalX) {
    fail('minFinalX', last.position.x);
  }
  if (expect.maxY !== undefined) {
    const maxY = Math.max(...results.map((r) => r.position.y));
    if (maxY > expect.maxY) fail('maxY', maxY);
  }
  if (expect.maxCenterY) {
    const maxY = Math.max(...results.map((r) => r.position.y));
    if (maxY > expect.maxCenterY.value + expect.maxCenterY.tolerance) fail('maxCenterY', maxY);
  }
  const gain = Math.max(...results.map((r) => r.position.y)) - startHeight;
  const loss = startHeight - Math.min(...results.map((r) => r.position.y));
  if (expect.minHeightGain !== undefined && gain < expect.minHeightGain) fail('minHeightGain', gain);
  if (expect.maxHeightGain !== undefined && gain > expect.maxHeightGain) fail('maxHeightGain', gain);
  if (expect.minHeightLoss !== undefined && loss < expect.minHeightLoss) fail('minHeightLoss', loss);
  if (expect.maxHeightLoss !== undefined && loss > expect.maxHeightLoss) fail('maxHeightLoss', loss);
  if (expect.speedBand !== undefined) {
    const windowStart = Math.min(60, n);
    const window = measured.slice(windowStart);
    if (window.length === 0) fail('speedBand (empty window)', window.length);
    else {
      const dx = window.reduce((acc, r, i) => {
        const prev = i === 0 ? results[windowStart - 1] ?? r.result : window[i - 1]!.result;
        return acc + (r.result.position.x - prev.position.x);
      }, 0);
      const mean = dx / window.length / DT;
      if (Math.abs(mean - 4.0) / 4.0 > expect.speedBand) fail('speedBand mean', mean);
    }
  }
  if (expect.contactsAtLeastOnce) {
    for (const key of ['ground', 'wall', 'head', 'steepSlope'] as const) {
      if (
        expect.contactsAtLeastOnce[key] === true &&
        !results.some((r) => r.contacts[key])
      ) {
        fail(`contactsAtLeastOnce.${key}`, false);
      }
    }
  }
  if (expect.snappedAtLeastOnce && !results.some((r) => r.snapped)) fail('snappedAtLeastOnce', false);
  if (expect.snappedWhileAirborneNever) {
    // A ground-contact correction may only be reported with a ground contact:
    // grounded, or a normal-flagged ground the controller classifies as
    // steepSlope (physics.md §8 item 4). Never for a truly airborne step.
    const bad = results.findIndex(
      (r) => r.snapped && !r.grounded && !r.contacts.steepSlope,
    );
    if (bad >= 0) fail('snappedWhileAirborneNever', bad);
  }
  if (expect.maxStepRiseAfterContact) {
    const key = expect.maxStepRiseAfterContact.contact;
    const first = results.findIndex((r) => r.contacts[key]);
    if (first < 0) fail(`maxStepRiseAfterContact.${key} (contact never observed)`, first);
    else {
      let maxRise = 0;
      for (let i = first + 1; i < n; i += 1) {
        maxRise = Math.max(maxRise, results[i]!.position.y - results[i - 1]!.position.y);
      }
      if (maxRise > expect.maxStepRiseAfterContact.limit) fail('maxStepRiseAfterContact', maxRise);
    }
  }
  return failures;
}
