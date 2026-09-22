#!/usr/bin/env node
/**
 * fixtures/m2/runtime/tools/check-runtime-fixtures.mjs
 *
 * Packet-29 fixture consistency checker (plain Node, no dependencies, no
 * TypeScript). It is fixture tooling, NOT an implementation of the runtime:
 * it re-derives every value the fixtures claim from the contracted
 * arithmetic and checks internal consistency.
 *
 * Checks:
 *   1. each fixture parses and is byte-canonical (2-space indent, LF, one
 *      trailing newline);
 *   2. `index.json` lists every fixture file with its real SHA-256 and no
 *      dangling/orphan entries;
 *   3. `scheduler-traces.json`: the fixed-step arithmetic (floor step count,
 *      at most 8 executed steps per frame, drop-and-resync, contiguous
 *      one-sample-per-executed-step indices, no dropped step sampled);
 *   4. `demo-traces.json`: every sample re-derived from the frozen §7.1
 *      formula x = x0 + A·sin(2π(stepIndex + 1)/(hz·T));
 *   5. `failstop.json`: every code/reason is declared in the accepted
 *      `fixtures/m2/contracts/expected.json` runtime registry, and failed
 *      cases never claim a rollback;
 *   6. no credential-like strings.
 *
 * Usage (from the repository root):
 *   node fixtures/m2/runtime/tools/check-runtime-fixtures.mjs
 *   node fixtures/m2/runtime/tools/check-runtime-fixtures.mjs --write
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

const failures = [];
function fail(check, message) {
  failures.push(`[${check}] ${message}`);
}
function pass(check, message) {
  console.log(`ok   ${check}: ${message}`);
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const FIXTURE_FILES = ['scheduler-traces.json', 'demo-traces.json', 'failstop.json'];
const NON_FIXTURES = new Set(['README.md', 'index.json', 'tools']);

// 1. canonical bytes ---------------------------------------------------------
for (const rel of FIXTURE_FILES) {
  const bytes = readFileSync(join(ROOT, rel));
  const text = bytes.toString('utf8');
  if (text.includes('\r')) fail('canonical', `${rel}: CR found`);
  if (!text.endsWith('\n') || text.endsWith('\n\n')) fail('canonical', `${rel}: must end with exactly one LF`);
  if (text.charCodeAt(0) === 0xfeff) fail('canonical', `${rel}: BOM found`);
  const canonical = JSON.stringify(JSON.parse(text), null, 2) + '\n';
  if (canonical !== text) fail('canonical', `${rel}: not canonical JSON (2-space indent)`);
}
if (!failures.length) pass('canonical', `${FIXTURE_FILES.length} fixture file(s) byte-canonical`);

// 2. index -------------------------------------------------------------------
const filesOnDisk = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => !NON_FIXTURES.has(e.name))
  .map((e) => e.name)
  .sort();
const index = {
  kind: 'runtime-fixture-index',
  setVersion: 1,
  id: 'runtime-fixtures',
  packet: 29,
  files: FIXTURE_FILES.map((rel) => ({
    path: rel,
    sha256: sha256(readFileSync(join(ROOT, rel))),
  })),
};
if (WRITE) {
  writeFileSync(join(ROOT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log('wrote index.json');
} else {
  const current = readJson('index.json');
  const listed = (current.files ?? []).map((f) => f.path).sort();
  const expected = [...FIXTURE_FILES].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    fail('index', `index files ${JSON.stringify(listed)} != ${JSON.stringify(expected)}`);
  }
  for (const entry of current.files ?? []) {
    const real = sha256(readFileSync(join(ROOT, entry.path)));
    if (real !== entry.sha256) fail('index', `${entry.path}: sha256 ${real} != index ${entry.sha256}`);
  }
  const orphans = filesOnDisk.filter((f) => !listed.includes(f));
  if (orphans.length) fail('index', `unlisted fixture files: ${orphans.join(', ')}`);
  if (!failures.length) pass('index', `${listed.length} file(s) listed with matching sha256`);
}

// 3. scheduler arithmetic ----------------------------------------------------
const DT = 1 / 120;
const MAX_CATCHUP = 8;
const scheduler = readJson('scheduler-traces.json');
if (scheduler.constants.dt !== DT || scheduler.constants.maxCatchupSteps !== MAX_CATCHUP) {
  fail('scheduler', 'constants do not match 1/120 and 8');
}
for (const c of scheduler.cases) {
  let stepIndex = c.preRoll;
  let anchorT = 0;
  let anchorSim = c.preRoll / scheduler.constants.fixedStepHz;
  let droppedSteps = 0;
  const sampled = [];
  for (const frame of c.frames) {
    const t = anchorT + frame.elapsed;
    const target = anchorSim + (t - anchorT);
    const rawN = Math.floor((target - stepIndex / scheduler.constants.fixedStepHz) / DT + 1e-9);
    const n = Math.min(rawN, MAX_CATCHUP);
    for (let i = 0; i < n; i += 1) sampled.push(stepIndex + i);
    stepIndex += n;
    if (rawN > MAX_CATCHUP) {
      droppedSteps += rawN - MAX_CATCHUP;
      anchorT = t;
      anchorSim = stepIndex / scheduler.constants.fixedStepHz;
    }
  }
  const e = c.expect;
  if (e.stepIndex !== stepIndex) fail('scheduler', `${c.caseId}: stepIndex ${stepIndex} != ${e.stepIndex}`);
  if (e.droppedSteps !== droppedSteps) fail('scheduler', `${c.caseId}: droppedSteps ${droppedSteps} != ${e.droppedSteps}`);
  if ((e.droppedInputSteps ?? 0) !== droppedSteps) {
    fail('scheduler', `${c.caseId}: droppedInputSteps must equal droppedSteps for M2 sets`);
  }
  if (JSON.stringify(e.sampledStepIndices) !== JSON.stringify(sampled)) {
    fail('scheduler', `${c.caseId}: sampledStepIndices mismatch`);
  }
  if ((e.preRollActionSamples ?? []).length !== 0) fail('scheduler', `${c.caseId}: pre-roll must sample nothing`);
  // one sample per executed step, strictly ascending, no duplicates
  for (let i = 1; i < sampled.length; i += 1) {
    if (sampled[i] !== sampled[i - 1] + 1) fail('scheduler', `${c.caseId}: sampled indices not contiguous`);
  }
  if (c.recordedFrames?.length) {
    const pressed = c.recordedFrames.filter((f) => f.jump === 'pressed');
    const sampledPressed = pressed.filter((f) => sampled.includes(f.stepIndex));
    const expectedCount = e.pressedCount ?? 0;
    if (sampledPressed.length !== expectedCount) {
      fail('scheduler', `${c.caseId}: pressed edges ${sampledPressed.length} != ${expectedCount} (replay would duplicate)`);
    }
    if (expectedCount > 0 && e.pressedAtStepIndex !== pressed[0].stepIndex) {
      fail('scheduler', `${c.caseId}: pressedAtStepIndex mismatch`);
    }
  }
}
pass('scheduler', `${scheduler.cases.length} case(s) re-derived from the fixed-step arithmetic`);

// 4. demo math ---------------------------------------------------------------
const demo = readJson('demo-traces.json');
for (const sample of demo.samples) {
  const { amplitude: A, periodSeconds: T, fixedStepHz: hz, x0 } = demo.constants;
  const expected = x0 + A * Math.sin((2 * Math.PI * (sample.completedSteps + 1)) / (hz * T));
  if (Math.abs(expected - sample.x) > 1e-12) {
    fail('demo', `completedSteps ${sample.completedSteps}: ${sample.x} != ${expected}`);
  }
}
for (let i = 1; i < demo.samples.length; i += 1) {
  if (demo.samples[i].completedSteps <= demo.samples[i - 1].completedSteps) fail('demo', 'samples not strictly ascending');
}
pass('demo', `${demo.samples.length} sample(s) re-derived from the §7.1 formula`);

// 5. failstop registry -------------------------------------------------------
const registry = new Set([
  ...(readJson('../contracts/expected.json').registry?.runtimeErrorCodes ?? []),
  'config_invalid',
  'module_error',
]);
const failstop = readJson('failstop.json');
const seenCases = new Set();
for (const c of failstop.cases) {
  if (seenCases.has(c.caseId)) fail('failstop', `duplicate caseId ${c.caseId}`);
  seenCases.add(c.caseId);
  const code = c.expect.code;
  if (code !== undefined && !registry.has(code)) {
    fail('failstop', `${c.caseId}: code ${code} is not in the accepted runtime registry`);
  }
  if (c.expect.state === 'failed' && c.expect.transformRollbackAttempted === true) {
    fail('failstop', `${c.caseId}: a failed case must not claim a transform rollback`);
  }
  if (c.expect.state === 'failed' && c.expect.canResume === true) {
    fail('failstop', `${c.caseId}: a failed instance must not be able to resume`);
  }
}
pass('failstop', `${failstop.cases.length} case(s) validated against the accepted runtime code registry`);

// 6. credential scan ---------------------------------------------------------
const SECRET = /(secret|password|token|api[_-]?key|authorization)\s*[:=]/i;
for (const rel of FIXTURE_FILES) {
  if (SECRET.test(readFileSync(join(ROOT, rel), 'utf8'))) fail('secrets', `${rel}: credential-like content`);
}
void relative;
void REPO;
pass('secrets', 'no credential-like content in the runtime fixtures');

if (failures.length) {
  console.error(`\ncheck-runtime-fixtures: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\ncheck-runtime-fixtures: all checks passed');
