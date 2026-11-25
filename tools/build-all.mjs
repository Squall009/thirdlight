#!/usr/bin/env node
/**
 * `npm run build`: the repository checks, the strict typecheck and the
 * bundles, as one command.
 *
 * The steps are independent of each other (none reads what another writes),
 * so they run in lanes at once: the typecheck (its own tsc processes,
 * incremental), the bundles, and the checks split by their time. One after
 * another they took about 50 s warm; in lanes the build takes about as long
 * as its longest lane (the typecheck). Each step's output is
 * printed whole, in the order below, once its lane is done; the build fails
 * when any step fails, and every failing step is reported, not only the
 * first.
 *
 * The last line is `build: done …` from tools/build.mjs when every step
 * passed (tools/gate.sh reads it).
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

/** The lanes; each runs its steps in turn. */
const LANES = [
  ['typecheck'],
  ['history-comments'],
  ['check-deps', 'check-slow-units', 'check-docs', 'check-size'],
  ['check-boundaries', 'check-redefinitions'],
];
/** The bundles run last in their own lane: their `build: done` line closes the output. */
const BUNDLES = 'build';

function run(step) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [`tools/${step}.mjs`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => out.push(b));
    child.on('close', (code, signal) => done({ step, ok: code === 0, code: code ?? signal, ms: Date.now() - t0, text: Buffer.concat(out).toString('utf8') }));
  });
}

async function lane(steps) {
  const results = [];
  for (const s of steps) results.push(await run(s));
  return results;
}

const t0 = Date.now();
const results = (await Promise.all([...LANES.map(lane), lane([BUNDLES])])).flat();
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.step === BUNDLES && failed.length === 0) continue;
  process.stdout.write(r.text);
  console.log(`build-all: ${r.step} ${r.ok ? 'ok' : `FAILED (exit ${String(r.code)})`} in ${(r.ms / 1000).toFixed(1)} s`);
}
if (failed.length > 0) {
  console.error(`build-all: FAILED: ${failed.map((r) => r.step).join(', ')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(1);
}
const bundles = results.find((r) => r.step === BUNDLES);
console.log(`build-all: every step passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
// The bundles' own output last: it ends with their `build: done` line.
process.stdout.write(bundles.text);
