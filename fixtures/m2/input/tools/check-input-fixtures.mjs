#!/usr/bin/env node
/**
 * fixtures/m2/input/tools/check-input-fixtures.mjs
 *
 * Packet-30 fixture consistency checker (plain Node, no dependencies, no
 * TypeScript). It is fixture tooling, NOT an implementation of the input
 * package: it re-derives every expected frame and sampling state from the
 * contracted arithmetic (runtime.md §12.5.2/§12.5.3, input.md §4.2/§4.3/§5.3)
 * with its own independent code path.
 *
 * Checks:
 *   1. every fixture parses and is byte-canonical (2-space indent, LF, one
 *      trailing newline);
 *   2. `index.json` lists every fixture file with its real SHA-256 and no
 *      dangling/orphan entries;
 *   3. `raw-sequences.json`: every step's `stepIndex` strictly ascends, the
 *      threaded sampling state (`down`, `awaitingRelease`) matches, and each
 *      `expect.frame` / `expect.next` is re-derived from `raw` exactly
 *      (quantization, 0.2 dead zone, keyboard → D-pad → stick precedence,
 *      non-standard mapping ignored, press latch, fresh activation);
 *   4. every `pins` entry names a real heading in the file it pins;
 *   5. no credential-like strings.
 *
 * Usage (from the repository root):
 *   node fixtures/m2/input/tools/check-input-fixtures.mjs
 *   node fixtures/m2/input/tools/check-input-fixtures.mjs --write
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
const fail = (check, message) => failures.push(`[${check}] ${message}`);
const pass = (check, message) => console.log(`ok   ${check}: ${message}`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readText = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));

const DEAD_ZONE = 0.2;
const QUANTUM = 1e4;

// --- independent re-derivation ----------------------------------------------

function quantize(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  const q = Math.floor(Math.abs(clamped) * QUANTUM + 0.5) / QUANTUM;
  if (q === 0) return 0;
  return clamped < 0 ? -q : q;
}

function rescale(axis0) {
  if (typeof axis0 !== 'number' || !Number.isFinite(axis0)) return 0;
  const a = Math.abs(axis0);
  if (a <= DEAD_ZONE) return 0;
  const scaled = Math.min((a - DEAD_ZONE) / (1 - DEAD_ZONE), 1);
  return axis0 < 0 ? -scaled : scaled;
}

function opposing(left, right) {
  if (left && !right) return -1;
  if (right && !left) return 1;
  return 0;
}

/** The active standard-mapped pad, or null (non-standard mapping is ignored). */
function standardPad(raw) {
  const gp = raw.gamepad;
  if (!gp || gp.mapping !== 'standard') return null;
  return gp;
}

function deriveStep(raw, stepIndex, previous) {
  const gp = standardPad(raw);
  const keyboardDigital = opposing(raw.keyboardLeft === true, raw.keyboardRight === true);
  const dpadDigital = gp === null ? 0 : opposing(gp.button14 === true, gp.button15 === true);
  const digital = keyboardDigital !== 0 ? keyboardDigital : dpadDigital;
  const stick = gp === null ? 0 : rescale(gp.axis0);
  const moveX = quantize(digital !== 0 ? digital : stick);

  const downNow = raw.keyboardJump === true || (gp !== null && gp.button0 === true);
  let jump;
  let next;
  if (previous.awaitingRelease) {
    jump = downNow ? 'held' : 'none';
    next = { down: downNow, awaitingRelease: downNow };
  } else {
    const down = downNow || raw.jumpLatch === true;
    if (down && !previous.down) jump = 'pressed';
    else if (down && previous.down) jump = 'held';
    else if (!down && previous.down) jump = 'released';
    else jump = 'none';
    next = { down, awaitingRelease: false };
  }
  return { frame: { stepIndex, moveX, jump }, next };
}

// --- checks ------------------------------------------------------------------

function checkCanonical() {
  let files = 0;
  for (const name of readdirSync(ROOT)) {
    if (!name.endsWith('.json')) continue;
    files += 1;
    const text = readText(name);
    const canonical = JSON.stringify(JSON.parse(text), null, 2) + '\n';
    if (WRITE) {
      writeFileSync(join(ROOT, name), canonical);
    } else if (text !== canonical) {
      fail('canonical', `${name} is not byte-canonical (2-space indent, LF, one trailing newline)`);
    }
  }
  pass('canonical', `${files} fixture file(s) byte-canonical`);
}

function checkIndex() {
  const index = readJson('index.json');
  const listed = new Map(index.files.map((f) => [f.path, f.sha256]));
  const onDisk = readdirSync(ROOT).filter((n) => n.endsWith('.json') && n !== 'index.json');
  for (const name of onDisk) {
    const real = sha256(readFileSync(join(ROOT, name)));
    if (!listed.has(name)) {
      if (WRITE) continue;
      fail('index', `${name} is on disk but not listed in index.json`);
    } else if (listed.get(name) !== real) {
      if (WRITE) continue;
      fail('index', `${name} sha256 ${listed.get(name)} != recomputed ${real}`);
    }
  }
  for (const path of listed.keys()) {
    if (!onDisk.includes(path)) fail('index', `index.json lists missing file ${path}`);
  }
  if (WRITE) {
    const files = onDisk.sort().map((name) => ({
      path: name,
      sha256: sha256(readFileSync(join(ROOT, name))),
    }));
    writeFileSync(join(ROOT, 'index.json'), JSON.stringify({ ...index, files }, null, 2) + '\n');
  }
  pass('index', `${listed.size} fixture file(s) hashed and cross-checked`);
}

function checkSequences() {
  const doc = readJson('raw-sequences.json');
  let steps = 0;
  let sequences = 0;
  for (const seq of doc.sequences) {
    sequences += 1;
    let previous = seq.initialState ?? { down: false, awaitingRelease: false };
    let previousIndex = null;
    for (const step of seq.steps) {
      steps += 1;
      if (previousIndex !== null && step.stepIndex <= previousIndex) {
        fail('sequences', `${seq.caseId}: stepIndex ${step.stepIndex} does not strictly ascend`);
      }
      previousIndex = step.stepIndex;
      const derived = deriveStep(step.raw, step.stepIndex, previous);
      if (JSON.stringify(derived.frame) !== JSON.stringify(step.expect.frame)) {
        fail(
          'sequences',
          `${seq.caseId}@${step.stepIndex}: frame ${JSON.stringify(derived.frame)} != ${JSON.stringify(step.expect.frame)}`,
        );
      }
      if (JSON.stringify(derived.next) !== JSON.stringify(step.expect.next)) {
        fail(
          'sequences',
          `${seq.caseId}@${step.stepIndex}: next ${JSON.stringify(derived.next)} != ${JSON.stringify(step.expect.next)}`,
        );
      }
      previous = derived.next;
    }
  }
  pass('sequences', `${sequences} sequence(s), ${steps} step(s) re-derived`);
}

function checkPins() {
  const doc = readJson('raw-sequences.json');
  let pins = 0;
  for (const pin of doc.pins) {
    pins += 1;
    const path = join(REPO, pin.file);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      fail('pins', `${pin.file} does not exist`);
      continue;
    }
    if (!text.split('\n').some((line) => line.trimEnd() === pin.section)) {
      fail('pins', `${pin.file} has no heading "${pin.section}"`);
    }
  }
  pass('pins', `${pins} pin(s) resolved to real headings`);
}

function checkSecrets() {
  const text = readdirSync(ROOT)
    .filter((n) => n.endsWith('.json') || n.endsWith('.md'))
    .map((n) => readText(n))
    .join('\n');
  const patterns = [/Bearer\s+[A-Za-z0-9._-]{16,}/, /sk-[A-Za-z0-9]{16,}/, /authoringToken/];
  for (const pattern of patterns) {
    if (pattern.test(text)) fail('secrets', `credential-like pattern ${pattern} found`);
  }
  pass('secrets', 'no credential-like strings');
}

checkCanonical();
checkIndex();
checkSequences();
checkPins();
checkSecrets();

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`check FAILED: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log('check OK: input fixtures consistent');
