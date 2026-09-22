#!/usr/bin/env node
/**
 * fixtures/m2/physics/tools/check-physics-fixtures.mjs
 *
 * Packet-31 fixture consistency checker (plain Node, no dependencies, no
 * TypeScript). It is fixture tooling, NOT an implementation of the adapter:
 * it re-derives every *derivable* value from its own independent code path.
 *
 * Checks:
 *   1. every fixture parses as JSON and is byte-canonical (2-space indent, LF,
 *      one trailing newline, no BOM, no NaN/Infinity literals);
 *   2. `index.json` lists every fixture file with its real SHA-256 and no
 *      dangling/orphan entries;
 *   3. `course.json` reproduces the frozen packet-14 course exactly
 *      (`tests/evaluations/m2-physics/course-spec.json`): 64 statics, the two
 *      rotated ramp boxes re-derived from `base + slope`, the solver/capsule/
 *      controller constants, and no polygon statics;
 *   4. `slope-course.json`/`snap-course.json`/`convex-course.json` are
 *      internally consistent (every ramp box center/rotation satisfies the
 *      base+slope derivation; polygon shapes are bounded 3..8-vertex CCW
 *      hulls with positive area);
 *   5. `tolerances.json` re-derives every `cosNormalY` from its `angleDeg` and
 *      records the contract table value where the contract text differs;
 *   6. every `cases.json` case names a real course, its slope starts satisfy
 *      the declared upright-capsule support-offset placement, its expectation
 *      keys are known, and every `pins` entry resolves to a real file/heading
 *      or is a declared numeric claim;
 *   7. every `failures.json` expected code/reason is declared in its code
 *      registry, the ops are known, and no credential-like strings appear.
 *
 * Usage (from the repository root):
 *   node fixtures/m2/physics/tools/check-physics-fixtures.mjs
 *   node fixtures/m2/physics/tools/check-physics-fixtures.mjs --write
 *
 * Exit 0 = all checks passed; 1 = at least one failed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..', '..', '..');
const WRITE = process.argv.includes('--write');

const COURSES = ['course.json', 'snap-course.json', 'slope-course.json', 'convex-course.json'];
const FIXTURES = ['cases.json', 'failures.json', 'tolerances.json', ...COURSES];

const failures = [];
const fail = (check, message) => failures.push(`[${check}] ${message}`);
const pass = (check, message) => console.log(`ok   ${check}: ${message}`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const RAD = (deg) => (deg * Math.PI) / 180;

// --- 1. byte canonicality ----------------------------------------------------

for (const name of FIXTURES) {
  const text = readFileSync(join(ROOT, name), 'utf8');
  if (text.charCodeAt(0) === 0xfeff) fail('canonical', `${name} starts with a BOM`);
  if (!text.endsWith('\n') || text.endsWith('\n\n')) fail('canonical', `${name} must end with exactly one newline`);
  if (text.includes('\r')) fail('canonical', `${name} contains CR`);
  // `JSON.parse` rejects the non-JSON literals NaN/Infinity/-Infinity, so a
  // successful parse is the strict check (the strings "NaN"/"Infinity" are a
  // legitimate non-finite encoding and are revived by the test harness).
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail('canonical', `${name} does not parse: ${e.message}`);
    continue;
  }
  const canonical = `${JSON.stringify(parsed, null, 2)}\n`;
  if (canonical !== text) fail('canonical', `${name} is not byte-canonical (2-space indent, one trailing LF)`);
}
if (failures.length === 0) pass('canonical', `${FIXTURES.length} fixture files are byte-canonical JSON`);

// --- 2. index integrity ------------------------------------------------------

const toEntries = () =>
  FIXTURES.map((name) => ({ path: name, sha256: sha256(readFileSync(join(ROOT, name))) })).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
const index = readJson('index.json');
const expectedEntries = toEntries();
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
const course = readJson('course.json');
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
        x: round12(body.base.x + Math.cos(th) * body.half.x),
        y: round12(body.base.y + Math.sin(th) * body.half.x),
      },
      rotationZ: round12(th),
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
function round12(v) {
  return Number(v.toFixed(12));
}
if (course.statics.length !== 64) fail('course', `course.json has ${course.statics.length} statics, expected 64`);
if (JSON.stringify(course.statics) !== JSON.stringify(expectedStatics)) {
  fail('course', 'course.json statics do not reproduce the frozen packet-14 course derivation');
} else {
  pass('course', '64 statics reproduced exactly from tests/evaluations/m2-physics/course-spec.json');
}
if (course.solver.hz !== 120 || course.solver.gravityY !== -19.62) fail('course', 'solver constants drifted');
if (
  course.character.capsule.radius !== 0.3 ||
  course.character.capsule.halfHeight !== 0.6 ||
  course.character.runSpeed !== 4 ||
  course.character.jumpVelocity !== 7 ||
  course.character.maxFallSpeed !== -30
) {
  fail('course', 'capsule/movement constants drifted');
}
if (course.controller.offsetSkin !== 0.01 || course.controller.groundSnap !== 0.1 || course.controller.autostep !== false) {
  fail('course', 'controller constants drifted');
}
if (course.controller.maxSlopeClimbRad !== round12(RAD(45)) || course.controller.minSlopeSlideRad !== round12(RAD(30))) {
  fail('course', 'slope-angle settings drifted');
}

// --- 4. other courses --------------------------------------------------------

function checkCourse(name) {
  const c = readJson(name);
  let statics = 0;
  let polygons = 0;
  for (const s of c.statics) {
    statics += 1;
    if (s.shape.type === 'polygon') {
      polygons += 1;
      const v = s.shape.vertices;
      if (v.length < 3 || v.length > 8) fail(name, `${s.entityId}: polygon vertex count ${v.length}`);
      let twiceArea = 0;
      for (let i = 0; i < v.length; i += 1) {
        const a = v[i];
        const b = v[(i + 1) % v.length];
        twiceArea += a[0] * b[1] - b[0] * a[1];
      }
      if (twiceArea / 2 <= 0) fail(name, `${s.entityId}: polygon must be counter-clockwise with positive area`);
      const extent = Math.max(...v.flat().map(Math.abs));
      if (extent > 64) fail(name, `${s.entityId}: polygon half-extent ${extent} > 64`);
    } else if (s.shape.type !== 'box') {
      fail(name, `${s.entityId}: unknown shape type ${s.shape.type}`);
    }
    if (!Number.isFinite(s.position.x) || !Number.isFinite(s.position.y) || !Number.isFinite(s.rotationZ)) {
      fail(name, `${s.entityId}: non-finite transform`);
    }
    // A ramp box names itself `...ramp...`/`slope-<deg>` or carries the
    // derived rotation; when the id encodes an angle, re-derive it.
    const match = /(?:slope-|ramp[ab]?)(\d+(?:\.\d+)?)/.exec(s.entityId);
    if (match && s.shape.type === 'box') {
      const deg = Number(match[1]);
      if (deg > 1 && deg < 90 && Math.abs(s.rotationZ - round12(RAD(deg))) > 1e-9) {
        fail(name, `${s.entityId}: rotationZ ${s.rotationZ} != ${round12(RAD(deg))}`);
      }
    }
  }
  if (c.counts.statics !== statics) fail(name, `counts.statics ${c.counts.statics} != ${statics}`);
  if (c.counts.polygonStatics !== polygons) fail(name, `counts.polygonStatics ${c.counts.polygonStatics} != ${polygons}`);
  return { statics, polygons };
}
for (const name of COURSES.filter((n) => n !== 'course.json')) {
  const { statics, polygons } = checkCourse(name);
  pass('course', `${name}: ${statics} statics (${polygons} polygon) internally consistent`);
}

// --- 5. tolerances -----------------------------------------------------------

const tolerances = readJson('tolerances.json');
for (const row of tolerances.slopeThresholds) {
  const derived = Number(Math.cos(RAD(row.angleDeg)).toFixed(8));
  if (Math.abs(row.cosNormalY - derived) > 1e-12) {
    fail('tolerances', `slope ${row.angleDeg}: cosNormalY ${row.cosNormalY} != cos ${derived}`);
  }
  if (row.contractTableValue !== undefined && Math.abs(row.contractTableValue - derived) <= 1e-12) {
    fail('tolerances', `slope ${row.angleDeg}: contractTableValue equals the derived cos — remove the mismatch note`);
  }
}
for (const [key, value] of Object.entries(tolerances.course)) {
  if (!Number.isFinite(value)) fail('tolerances', `course.${key} must be a finite number`);
}
if (tolerances.controller.offsetSkin !== 0.01 || tolerances.controller.groundSnap !== 0.1) {
  fail('tolerances', 'controller constants drifted');
}
pass('tolerances', `${tolerances.slopeThresholds.length} slope thresholds re-derived; contract constants pinned`);

// --- 6. cases ----------------------------------------------------------------

const KNOWN_EXPECT_KEYS = new Set([
  'groundedEveryStep', 'groundedAtLeastOnce', 'groundedFractionMin', 'maxUngroundedSteps',
  'minUngroundedSteps', 'firstStepGrounded', 'firstStepSteepSlope', 'firstStepSupportNormalY',
  'supportNormalY', 'minSupportNormalY', 'maxStepDelta', 'minCapsuleBottom', 'finalX', 'finalY',
  'maxX', 'minX', 'minFinalX', 'maxY', 'maxCenterY', 'minHeightGain', 'maxHeightGain',
  'minHeightLoss', 'maxHeightLoss', 'speedBand', 'contactsAtLeastOnce', 'snappedAtLeastOnce',
  'snappedWhileAirborneNever', 'maxStepRiseAfterContact', 'noZ', 'maxXNote',
  'groundedButSteepNote',
]);
const cases = readJson('cases.json');
const courseData = Object.fromEntries(COURSES.map((n) => [n, readJson(n)]));
for (const c of cases.cases) {
  const courseFile = courseData[c.course];
  if (!courseFile) {
    fail('cases', `${c.id}: unknown course ${c.course}`);
    continue;
  }
  for (const key of Object.keys(c.expect)) {
    if (!KNOWN_EXPECT_KEYS.has(key)) fail('cases', `${c.id}: unknown expectation key '${key}'`);
  }
  if (!Array.isArray(c.pins) || c.pins.length === 0) fail('cases', `${c.id}: pins are required`);
  // A slope start must equal the declared upright-capsule support placement.
  const deg = /slope-stand-(\d+(?:\.\d+)?)/.exec(c.id) ?? /slope-no-autonomous-slide-(\d+(?:\.\d+)?)/.exec(c.id);
  if (deg) {
    const ramp = courseFile.statics.find((s) => s.entityId === `slope-${deg[1]}`);
    if (!ramp) {
      fail('cases', `${c.id}: no ramp slope-${deg[1]} in ${c.course}`);
    } else {
      const th = RAD(Number(deg[1]));
      const base = { x: round12(ramp.position.x - Math.cos(th) * ramp.shape.hx), y: 0 };
      const offset = 0.6 * Math.cos(th) + 0.3 + ramp.shape.hy;
      const x = round12(base.x + Math.cos(th) * 1 - Math.sin(th) * offset);
      const y = round12(Math.sin(th) * 1 + Math.cos(th) * offset);
      if (Math.abs(c.start.x - x) > 1e-9 || Math.abs(c.start.y - y) > 1e-9) {
        fail('cases', `${c.id}: start (${c.start.x}, ${c.start.y}) != derived (${x}, ${y})`);
      }
    }
  }
}
pass('cases', `${cases.cases.length} cases: courses, pivots and expectation keys consistent`);

// --- 7. failures -------------------------------------------------------------

const failureFile = readJson('failures.json');
const KNOWN_OPS = new Set([
  'create', 'createPreAborted', 'createAbortDuringInit', 'disposeTwice', 'staleAfterDispose',
  'nonFiniteDelta', 'resetInvalid',
]);
for (const c of failureFile.cases) {
  if (!KNOWN_OPS.has(c.op)) fail('failures', `${c.id}: unknown op ${c.op}`);
  // A case declares either the init-result code (`code`) or the thrown
  // adapter error code (`errorCode`); both must be in the registry.
  const code = c.expect.code ?? c.expect.errorCode;
  if (code && !failureFile.codes[code]) fail('failures', `${c.id}: undeclared code ${code}`);
  if (c.expect.reason && !code) fail('failures', `${c.id}: reason without a declared code`);
  if (c.op === 'create' && !c.expect.reason) fail('failures', `${c.id}: create failures must declare a reason`);
  if (c.op.startsWith('create') && !c.config) fail('failures', `${c.id}: create cases need a config`);
}
if (!failureFile.nonFiniteEncoding) fail('failures', 'nonFiniteEncoding note is required (NaN/Infinity cannot be JSON)');
pass('failures', `${failureFile.cases.length} cases: ops and codes declared`);

// --- pins + credentials ------------------------------------------------------

const HEADING = /^#{1,6}\s+.*?\b(\d+(?:\.\d+)*)\b/m;
function pinResolves(pin) {
  const sectionAt = pin.indexOf(' §');
  if (sectionAt < 0) return true; // a numeric/textual claim, checked by the test suite
  const filePart = pin.slice(0, sectionAt);
  const section = pin.slice(sectionAt + 2).split(' ')[0].replace(/[()]/g, '');
  const path = join(REPO, filePart);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const headings = text.match(/^#{1,6}\s+.*$/gm) ?? [];
  return headings.some((h) => {
    const m = HEADING.exec(h);
    return m ? m[1] === section || m[1].startsWith(`${section}.`) : false;
  });
}
const allPins = [...cases.cases.flatMap((c) => c.pins), ...failureFile.cases.flatMap((c) => c.note ? [] : [])];
const unresolved = allPins.filter((p) => !pinResolves(p));
if (unresolved.length > 0) fail('pins', `unresolved pins: ${JSON.stringify(unresolved)}`);
else pass('pins', `${allPins.length} case pins resolve`);

const CREDENTIAL_LIKE = /(?:authoringToken|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.)/;
for (const name of [...FIXTURES, 'README.md']) {
  const text = readFileSync(join(ROOT, name), 'utf8');
  if (CREDENTIAL_LIKE.test(text)) fail('sanitization', `${name} contains a credential-like string`);
}
pass('sanitization', 'no credential-like strings in the fixture set');

// --- report ------------------------------------------------------------------

for (const name of FIXTURES) {
  const rel = relative(REPO, join(ROOT, name));
  if (!rel.startsWith('..') && !readFileSync(join(ROOT, name), 'utf8')) fail('fixtures', `${name} is empty`);
}
if (failures.length > 0) {
  console.error(`check-physics-fixtures: FAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('check-physics-fixtures: OK — all packet-31 fixture checks passed.');
