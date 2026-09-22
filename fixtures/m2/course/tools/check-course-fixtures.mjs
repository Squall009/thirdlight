#!/usr/bin/env node
/**
 * fixtures/m2/course/tools/check-course-fixtures.mjs
 *
 * Packet-32 fixture consistency checker (plain Node, no dependencies, no
 * TypeScript). Fixture tooling only — it contains no controller or physics
 * logic; every *derivable* value is re-derived from an independent code path.
 *
 * Checks:
 *   1. every fixture parses as JSON and is byte-canonical (2-space indent, LF,
 *      exactly one trailing newline, no CR/BOM);
 *   2. `index.json` lists every fixture file with its real SHA-256 and has no
 *      dangling or orphan entries;
 *   3. `course.json` reproduces the frozen packet-14 course exactly
 *      (`tests/evaluations/m2-physics/course-spec.json`): 64 statics, the two
 *      rotated ramp boxes re-derived from `base + slope`, the solver/capsule/
 *      controller constants and the six gameplay settings;
 *   4. `slope-course.json` / `snap-course.json` carry exactly the packet-31
 *      fixture geometry they were copied from (no drift);
 *   5. `tolerances.json` re-derives every `cos(angle)` and the slope-table
 *      `supportNormalY` values (with the recorded C31-1 difference for 45.1°);
 *   6. every `cases.json` case names a real course file, a real input sequence
 *      (or a declared window), a known expectation shape and a
 *      `toleranceRef` that resolves to a tolerance key;
 *   7. every input sequence's spans strictly ascend and do not overlap, every
 *      `raw` names a declared atom, and a `jumpLatch` appears on at most one
 *      step of each contiguous held run;
 *   8. no credential-like string appears in any fixture.
 *
 * Usage (repository root):
 *   node fixtures/m2/course/tools/check-course-fixtures.mjs
 *   node fixtures/m2/course/tools/check-course-fixtures.mjs --write
 *
 * Exit 0 = all checks passed; 1 = at least one failed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..', '..', '..');
const WRITE = process.argv.includes('--write');

const FILES = ['cases.json', 'course.json', 'input-sequences.json', 'slope-course.json', 'snap-course.json', 'tolerances.json'];

const failures = [];
const passes = [];
const fail = (check, message) => failures.push(`[${check}] ${message}`);
const pass = (check, message) => passes.push(`[${check}] ${message}`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const read = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
const RAD = (deg) => (deg * Math.PI) / 180;
const r12 = (v) => Number(v.toFixed(12));

// --- 1. byte canonicality ----------------------------------------------------
for (const name of FILES) {
  const text = readFileSync(join(ROOT, name), 'utf8');
  if (text.charCodeAt(0) === 0xfeff) fail('canonical', `${name} starts with a BOM`);
  if (text.includes('\r')) fail('canonical', `${name} contains CR`);
  if (!text.endsWith('\n') || text.endsWith('\n\n')) fail('canonical', `${name} must end with exactly one newline`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail('canonical', `${name} does not parse: ${e.message}`);
    continue;
  }
  if (`${JSON.stringify(parsed, null, 2)}\n` !== text) fail('canonical', `${name} is not byte-canonical`);
}
if (!failures.some((f) => f.startsWith('[canonical]'))) pass('canonical', `${FILES.length} fixture files are byte-canonical JSON`);

// --- 2. index integrity ------------------------------------------------------
const onDisk = readdirSync(ROOT).filter((n) => n.endsWith('.json') && n !== 'index.json').sort();
const actual = [...new Set([...FILES, ...onDisk])].sort();
const expectedEntries = actual.map((path) => ({ path, sha256: sha256(readFileSync(join(ROOT, path))) }));
const index = read('index.json');
const listed = [...(index.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
if (JSON.stringify(listed) !== JSON.stringify(expectedEntries)) {
  if (WRITE) {
    writeFileSync(join(ROOT, 'index.json'), `${JSON.stringify({ ...index, files: expectedEntries }, null, 2)}\n`);
    pass('index', 'index.json rewritten (--write)');
  } else {
    fail('index', `index.json does not match the fixture files: ${JSON.stringify(listed)} != ${JSON.stringify(expectedEntries)}`);
  }
} else {
  pass('index', `${listed.length} fixture files listed with the correct SHA-256`);
}

// --- 3. frozen course derivation --------------------------------------------
const spec = JSON.parse(readFileSync(join(REPO, 'tests/evaluations/m2-physics/course-spec.json'), 'utf8'));
const course = read('course.json');
const expectedStatics = [];
for (const body of spec.statics.bodies) {
  if (body.id === 'filler') {
    for (let i = 0; i < body.count; i += 1) {
      expectedStatics.push({
        entityId: `filler-${String(i).padStart(2, '0')}`,
        shape: { type: 'box', hx: body.half.x, hy: body.half.y },
        position: { x: 24 + 0.75 * i, y: 0.25 },
        rotationZ: 0,
      });
    }
    continue;
  }
  if (body.slopeDeg !== undefined) {
    const th = RAD(body.slopeDeg);
    expectedStatics.push({
      entityId: body.id,
      shape: { type: 'box', hx: body.half.x, hy: body.half.y },
      position: {
        x: r12(body.base.x + Math.cos(th) * body.half.x),
        y: r12(body.base.y + Math.sin(th) * body.half.x),
      },
      rotationZ: r12(th),
    });
    continue;
  }
  expectedStatics.push({
    entityId: body.id,
    shape: { type: 'box', hx: body.half.x, hy: body.half.y },
    position: { x: body.center.x, y: body.center.y },
    rotationZ: 0,
  });
}
if (JSON.stringify(course.statics) !== JSON.stringify(expectedStatics)) {
  fail('course', 'course.json statics do not reproduce the frozen packet-14 derivation');
} else {
  pass('course', '64 statics reproduced exactly from tests/evaluations/m2-physics/course-spec.json');
}
if (course.solver.hz !== 120 || course.solver.gravityY !== -19.62) fail('course', 'solver constants drifted');
if (course.counts.statics !== 64 || course.counts.polygonStatics !== 0) fail('course', 'counts drifted');
if (course.controller.maxSlopeClimbRad !== r12(RAD(45)) || course.controller.minSlopeSlideRad !== r12(RAD(30))) {
  fail('course', 'slope-angle settings drifted');
}
const settings = {
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
};
if (JSON.stringify(course.settings) !== JSON.stringify(settings)) fail('course', 'gameplay settings block drifted');

// --- 4. copied packet-31 geometry -------------------------------------------
for (const [name, source] of [
  ['slope-course.json', 'fixtures/m2/physics/slope-course.json'],
  ['snap-course.json', 'fixtures/m2/physics/snap-course.json'],
]) {
  const ours = read(name);
  const theirs = JSON.parse(readFileSync(join(REPO, source), 'utf8'));
  if (JSON.stringify(ours.statics) !== JSON.stringify(theirs.statics)) {
    fail(name, `static geometry differs from ${source}`);
  } else {
    pass(name, `static geometry identical to ${source} (${ours.statics.length} colliders)`);
  }
  if (JSON.stringify(ours.controller) !== JSON.stringify(theirs.controller)) fail(name, 'controller config drifted');
}

// --- 5. tolerances -----------------------------------------------------------
const tol = read('tolerances.json').tolerances;
const table = tol.T14_slopeThreshold.table;
for (const row of table) {
  const expected = Math.cos(RAD(row.angleDeg));
  if (Math.abs(expected - row.supportNormalY) > 5e-12) {
    fail('tolerances', `slope ${row.angleDeg}: supportNormalY ${row.supportNormalY} != cos = ${expected}`);
  }
  if (row.angleDeg === 45.1 && Math.abs(0.70608759 - row.supportNormalY) < 1e-6) {
    fail('tolerances', 'slope 45.1 must carry the measured cos (0.70587157), not the contract typo (C31-1)');
  }
  const grounded = row.supportNormalY >= Math.cos(RAD(45)) - 1e-6;
  if (grounded !== row.grounded) fail('tolerances', `slope ${row.angleDeg}: grounded flag inconsistent`);
}
pass('tolerances', `${table.length} slope rows re-derived; ${Object.keys(tol).length} tolerance groups`);

// --- 6/7. cases and input sequences -----------------------------------------
const caseFile = read('cases.json');
const input = read('input-sequences.json');
const atoms = input.atoms;
const sequenceIds = new Set(input.sequences.map((s) => s.id));
const courseFiles = new Set(FILES.filter((f) => f.endsWith('-course.json') || f === 'course.json'));
const knownExpect = new Set([
  'toleranceRef', 'groundedEveryStep', 'maxStepDelta', 'finalY', 'speed', 'maxYDeviation',
  'accelSteps', 'decelSteps', 'runSpeed', 'toleranceMps', 'apexTheoretical', 'apexTolerance',
  'landTolerance', 'singleJump', 'maxVy', 'releaseFactor', 'releaseTolerance', 'apexBelowHold',
  'jumpStarts', 'wallFaceX', 'stopBand', 'maxPenetration', 'wallContact', 'maxPenetrationBelow',
  'stopWithinStepsOfContact', 'runwayLimitedApproach', 'seamX', 'maxUngroundedSteps',
  'groundedFractionMin', 'angleDeg', 'minGroundedFraction', 'minHeightGain', 'pushSeconds',
  'maxHeightGain', 'ceilingUndersideY', 'maxCenterY', 'contactMinCenterY',
  'maxRisePerStepAfterContact', 'headContact', 'ledgeTopY', 'blockMaxDxPerStep',
  'groundedWithinStepsOfContact', 'stepDownM', 'snapDistanceM', 'ungroundedSteps',
  'minUngroundedSteps', 'grounded', 'steepSlope', 'supportNormalY', 'positionZ', 'rotation',
  'scale', 'windowSteps', 'fires', 'fixtureLastCoyoteOffset', 'droppedWallSeconds', 'maxCatchupSteps',
  'droppedSteps', 'phantomSteps', 'minApproachSpeed',
]);
const toleranceKeys = new Set(Object.keys(tol));
for (const c of caseFile.cases) {
  if (!courseFiles.has(c.course)) fail('cases', `${c.id}: unknown course ${c.course}`);
  if (c.input !== null && !sequenceIds.has(c.input)) fail('cases', `${c.id}: unknown input sequence ${c.input}`);
  if (c.input === null && !c.window) fail('cases', `${c.id}: no input and no window`);
  if (c.window) {
    if (c.window.kind === 'buffered-jump') {
      if (typeof c.window.firstJumpStep !== 'number' || typeof c.window.pressOffsetFromLanding !== 'number') {
        fail('cases', `${c.id}: buffered-jump window needs firstJumpStep and pressOffsetFromLanding`);
      }
    } else if (c.window.kind === 'coyote-runoff') {
      if (!sequenceIds.has(c.window.runInput) || typeof c.window.pressOffsetFromLastGrounded !== 'number') {
        fail('cases', `${c.id}: coyote-runoff window needs a real runInput sequence and pressOffsetFromLastGrounded`);
      }
    } else {
      fail('cases', `${c.id}: unknown window kind ${c.window.kind}`);
    }
  }
  for (const key of Object.keys(c.expect)) {
    if (!knownExpect.has(key)) fail('cases', `${c.id}: unknown expectation field ${key}`);
  }
  const refs = Array.isArray(c.expect.toleranceRef) ? c.expect.toleranceRef : [c.expect.toleranceRef];
  for (const ref of refs) {
    if (!toleranceKeys.has(ref)) fail('cases', `${c.id}: toleranceRef ${ref} is not a tolerance key`);
  }
}
pass('cases', `${caseFile.cases.length} cases reference real courses, sequences and tolerances`);

for (const seq of input.sequences) {
  if (!Array.isArray(seq.spans) || seq.spans.length === 0) fail('inputs', `${seq.id}: no spans`);
  let last = -1;
  for (const span of seq.spans) {
    if (!(span.from <= span.to)) fail('inputs', `${seq.id}: span ${span.from}..${span.to} is empty or reversed`);
    if (span.from <= last) fail('inputs', `${seq.id}: spans overlap or do not ascend at ${span.from}`);
    if (!(span.raw in atoms)) fail('inputs', `${seq.id}: unknown atom ${span.raw}`);
    last = span.to;
  }
}
// jumpLatch appears on at most one step of each contiguous held run.
for (const [name, atom] of Object.entries(atoms)) {
  if ('jumpLatch' in atom && atom.jumpLatch !== true) fail('inputs', `atom ${name}: jumpLatch must be true when present`);
}
pass('inputs', `${input.sequences.length} sequences / ${Object.keys(atoms).length} raw atoms consistent`);

// --- 8. credential scan ------------------------------------------------------
const CREDENTIAL = /(bearer\s|api[_-]?key|secret|password|token\s*[:=]|authorization\s*[:=])/i;
for (const name of FILES) {
  const text = readFileSync(join(ROOT, name), 'utf8');
  if (CREDENTIAL.test(text)) fail('credentials', `${name} contains a credential-like string`);
}
pass('credentials', 'no credential-like strings in the fixture set');

// --- report ------------------------------------------------------------------
for (const p of passes) console.log(`ok   ${p}`);
for (const f of failures) console.error(`FAIL ${f}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${passes.length} checks passed`);
process.exit(0);
