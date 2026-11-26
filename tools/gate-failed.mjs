#!/usr/bin/env node
/**
 * What `tools/gate.sh check --failed` does with the unit files the last check failed.
 *
 * Most unit files share a vitest worker, so a file can fail only because of what ran before it there (a module's
 * state left behind). `--failed` runs only the failed files, so their neighbours change: a failure that came from
 * file order would pass there, and a rerun with nothing changed would be called green. So the check records, for
 * each failed file, a digest of its text and of the code it can reach (every tracked or untracked file outside the
 * docs), and `--failed`:
 *  - runs a file whose text and code are unchanged since that failing run ALONE (one file, one worker); passing
 *    there is RED all the same: it passed alone, failed in the shared pool, and nothing changed: it depends on
 *    file order, and is isolated (vitest.config.mts) or fixed, never called green;
 *  - runs a file that changed, or whose code changed (a real fix), with the other changed ones, as before.
 *
 *   node tools/gate-failed.mjs record <state-dir> <file>…   the digests at the failing run (unit-digests.json)
 *   node tools/gate-failed.mjs plan <state-dir> <file>…     one line a file: `alone <file>`, `rerun <file>`, `gone <file>`
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIGESTS = 'unit-digests.json';

/** What a test's outcome cannot depend on: prose. Everything else may be code a test reaches. */
const notCode = (path) => path.startsWith('docs/') || path.startsWith('archive/') || path.endsWith('.md');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A file's text digest, or null when it is gone (a fix that archived it). */
export function fileDigest(path, root = ROOT) {
  const p = join(root, path);
  return existsSync(p) ? sha(readFileSync(p)) : null;
}

/** One digest of every tracked and untracked (not ignored) file outside the docs, as the working tree holds it now. */
export function codeDigest(root = ROOT) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  const paths = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter((p) => p !== '' && !notCode(p)).sort();
  const h = createHash('sha256');
  for (const p of paths) {
    const full = join(root, p);
    h.update(p).update('\0').update(existsSync(full) ? sha(readFileSync(full)) : 'gone').update('\n');
  }
  return h.digest('hex');
}

/**
 * The decision, given the digests at the failing run and now. A file is run alone only when neither its text nor the
 * code changed: with a change, whether it passes says something about the change; without one, only about its
 * neighbours. A file not recorded (an older state) is rerun as before.
 */
export function planFailedRerun(recorded, current) {
  const out = { alone: [], rerun: [], gone: [] };
  for (const [file, now] of Object.entries(current.files)) {
    if (now === null) out.gone.push(file);
    else if (recorded !== null && recorded.files[file] === now && recorded.code === current.code) out.alone.push(file);
    else out.rerun.push(file);
  }
  return out;
}

/** The verdict on a file run alone with nothing changed: red either way, and why. */
export function aloneVerdict(file, passed) {
  return passed
    ? { red: true, line: `${file} passed alone, failed in the shared pool, unchanged: order-dependent — isolate it (vitest.config.mts) or fix it` }
    : { red: true, line: `${file} failed alone too, unchanged since the failing run` };
}

function digestsNow(files, root = ROOT) {
  return { code: codeDigest(root), files: Object.fromEntries(files.map((f) => [f, fileDigest(f, root)])) };
}

function main(argv) {
  const [cmd, dir, ...files] = argv;
  if (cmd === 'record' && dir !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DIGESTS), `${JSON.stringify(digestsNow(files), null, 2)}\n`);
    return 0;
  }
  if (cmd === 'plan' && dir !== undefined) {
    const p = join(dir, DIGESTS);
    const recorded = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    const plan = planFailedRerun(recorded, digestsNow(files));
    for (const kind of ['alone', 'rerun', 'gone']) for (const f of plan[kind]) console.log(`${kind} ${f}`);
    return 0;
  }
  if (cmd === 'verdict' && dir !== undefined) {
    // verdict <file> <passed|failed>
    console.log(aloneVerdict(dir, files[0] === 'passed').line);
    return 0;
  }
  console.error('usage: gate-failed.mjs record|plan <state-dir> <file>… | verdict <file> passed|failed');
  return 2;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
