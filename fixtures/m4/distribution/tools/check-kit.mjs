#!/usr/bin/env node
/**
 * fixtures/m4/distribution — INDEPENDENT checker (plain node; no
 * dependencies; its own walk/digest implementation).
 *
 * Re-derives from the LIVE tree:
 *   1. the kit inventory (distribution.md §1 allowlist) → must match
 *      cases/kit-inventory.json exactly (paths, order, byteLength, sha256,
 *      classification)
 *   2. the negative-inventory rules (no node_modules/dist/.git/fixtures/
 *      samples/tests; no symlinks; no functional checkout path in the
 *      generated data; NOTICE present)
 *   3. the kit identity (lockfileDigest + kitDigest — distribution.md §3)
 *      → cases/kit-identity.json
 *   4. the license inventory (lockfile extraction — distribution.md §8)
 *      → cases/license-inventory.json
 *   5. index.json (byte length + sha256 of every data file)
 *
 * Negative control: --fixture <tampered-copy> re-runs the digest/index
 * verification against a modified fixture copy (the re-derivation sections
 * that do not depend on the live tree must still agree; a tampered data
 * file fails).
 *
 * Run: node fixtures/m4/distribution/tools/check-kit.mjs [--fixture <dir>]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const FIXTURES_DIR = process.argv.includes('--fixture')
  ? resolve(process.argv[process.argv.indexOf('--fixture') + 1])
  : resolve(dirname(new URL(import.meta.url).pathname), '..');
const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..');

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sha256Bytes = (b) => createHash('sha256').update(b).digest('hex');
const blockDigest = (entries) =>
  createHash('sha256').update(entries.map((e) => JSON.stringify({ path: e.path, sha256: e.sha256 })).sort().join('\n')).digest('hex');

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`FAIL: ${msg}`); };
const ok = (msg) => console.log(`ok: ${msg}`);
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected).slice(0, 200)}, got ${JSON.stringify(actual).slice(0, 200)}`);
  } else ok(label);
}

// ---- 1. independent re-derivation of the allowlist --------------------------

const TOP_LEVEL_FILES = ['package.json', 'package-lock.json', 'tsconfig.base.json'];
const TOOLS_FILES = ['build.mjs', 'build.test.mjs', 'check-boundaries.mjs', 'check-boundaries.test.mjs', 'check-deps.mjs', 'check-deps.test.mjs', 'typecheck.mjs', 'typecheck.test.mjs'];
const CONTRACT_FILES = readdirSync(join(REPO_ROOT, 'docs/contracts')).sort();
const TEMPLATE_SRC = 'fixtures/m4/templates/templates/platformer-starter';
const TEMPLATE_KIT = 'templates/platformer-starter';
const CHECKOUT_PATH = '/home/dadmin/projects/thirdlight';

function walkFiles(root) {
  const out = [];
  const bad = [];
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    const st = lstatLike(p);
    if (st.type === 'symlink') bad.push(`${root}/${name}`);
    else if (st.type === 'dir') { const [f, s] = walkFiles(p); out.push(...f); bad.push(...s); }
    else if (st.type === 'file') out.push(p);
    else bad.push(`${root}/${name}`);
  }
  return [out, bad];
}
function lstatLike(p) {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return { type: 'missing' };
  if (st.isSymbolicLink()) return { type: 'symlink' };
  if (st.isDirectory()) return { type: 'dir' };
  if (st.isFile()) return { type: 'file' };
  return { type: 'other' };
}

function deriveInventory() {
  const files = [];
  const add = (srcRel, kitPath, classification) => {
    const abs = join(REPO_ROOT, srcRel);
    if (!existsSync(abs)) throw new Error(`allowlisted path missing: ${srcRel}`);
    files.push({ src: srcRel, kitPath, classification, byteLength: statSync(abs).size, sha256: sha256File(abs) });
  };
  for (const f of TOP_LEVEL_FILES) add(f, f, 'manifest');
  for (const p of readdirSync(join(REPO_ROOT, 'packages')).sort()) {
    if (!existsSync(join(REPO_ROOT, `packages/${p}/package.json`))) continue;
    const [fs, symlinks] = walkFiles(join(REPO_ROOT, 'packages', p));
    if (symlinks.length) fail(`symlink in packages/${p}: ${symlinks[0]}`);
    for (const f of fs) {
      const rel = f.slice(join(REPO_ROOT, 'packages', p).length + 1);
      if (rel.split('/').includes('node_modules')) { console.log(`note: excluded by the kit rule (node_modules is never a kit member — §4): packages/${p}/${rel}`); continue; }
      add(`packages/${p}/${rel}`, `packages/${p}/${rel}`, 'source');
    }
  }
  for (const f of TOOLS_FILES) add(`tools/${f}`, `tools/${f}`, 'tooling');
  for (const f of CONTRACT_FILES) add(`docs/contracts/${f}`, `docs/contracts/${f}`, 'contracts');
  {
    const [fs, symlinks] = walkFiles(join(REPO_ROOT, TEMPLATE_SRC));
    if (symlinks.length) fail(`symlink in the template source set: ${symlinks[0]}`);
    for (const f of fs) {
      const rel = f.slice(join(REPO_ROOT, TEMPLATE_SRC).length + 1);
      add(`${TEMPLATE_SRC}/${rel}`, `${TEMPLATE_KIT}/${rel}`, 'template');
    }
  }
  files.sort((a, b) => a.kitPath.localeCompare(b.kitPath));
  return files;
}

const inventory = readFileSync(join(FIXTURES_DIR, 'cases/kit-inventory.json'), 'utf8');
const inv = JSON.parse(inventory);
const derived = deriveInventory();

assertEq(derived.length + 2, inv.fileCount, 'inventory fileCount (source files + the 2 generated data files)');
const derivedRows = derived.map((f) => ({ ...f }));
const invRows = inv.files
  .filter((f) => f.classification !== 'generated-data')
  .map((f) => ({ src: f.src, kitPath: f.kitPath, classification: f.classification, byteLength: f.byteLength, sha256: f.sha256 }));
assertEq(derivedRows, invRows, 'inventory rows (path/order/size/digest/classification)');

// ---- 2. negative-inventory rules --------------------------------------------

const allRows = inv.files;
// The negative-inventory rule applies to the KIT PATHS: the TOP-LEVEL
// exclusions (tests/, dist/, .git/, fixtures/, samples/) and node_modules
// anywhere. Unit-internal test directories (packages/<unit>/tests/) are unit
// SOURCE (the 17 units of dependencies.md §2 — npm test in the kit runs
// them), so they are INVENTORY members.
const badPaths = allRows.filter((f) =>
  f.kitPath.startsWith('tests/') || f.kitPath.startsWith('dist/') || f.kitPath.startsWith('.git/') ||
  f.kitPath.startsWith('fixtures/') || f.kitPath.startsWith('samples/') ||
  f.kitPath.includes('node_modules/') || f.kitPath.includes('projects/'));
if (badPaths.length) fail(`negative inventory violated: ${badPaths.map((f) => f.kitPath).join(', ')}`);
else ok('negative inventory (no top-level tests/dist/.git/fixtures/samples, no node_modules, no project data paths)');

if (!allRows.some((f) => f.kitPath === 'NOTICE')) fail('NOTICE missing from the inventory (kit_notice_missing would fire)');
else ok('NOTICE present in the inventory');

// generated data: re-derive kit.json + NOTICE bytes and compare the recorded sha256.
const identity = JSON.parse(readFileSync(join(FIXTURES_DIR, 'cases/kit-identity.json'), 'utf8')).identity;
const sourceRows = allRows.filter((f) => f.classification !== 'generated-data').map((f) => ({ path: f.kitPath, sha256: f.sha256 }));
const kitDigest = blockDigest(sourceRows);
const lockBytes = readFileSync(join(REPO_ROOT, 'package-lock.json'));
const lockDigest = sha256Bytes(lockBytes);

const notice = buildNotice(lockBytes, kitDigest);
const kitJsonBytes = Buffer.from(JSON.stringify(identity, null, 2) + '\n', 'utf8');
assertEq(sha256Bytes(kitJsonBytes), allRows.find((f) => f.kitPath === 'kit.json')?.sha256, 'kit.json bytes re-derive (identity file ↔ inventory entry)');
assertEq(sha256Bytes(notice), allRows.find((f) => f.kitPath === 'NOTICE')?.sha256, 'NOTICE bytes re-derive (independent builder ↔ inventory entry)');

for (const label of ['kit.json', 'NOTICE']) {
  const content = label === 'kit.json' ? kitJsonBytes.toString('utf8') : notice;
  if (content.includes(CHECKOUT_PATH)) fail(`functional checkout path inside ${label} (kit_path_rejected would fire)`);
  else ok(`no functional checkout path in ${label}`);
}

// ---- 3. identity -------------------------------------------------------------

assertEq(identity.lockfileDigest, `sha256:${lockDigest}`, 'identity.lockfileDigest = live lockfile digest');
assertEq(identity.kitDigest, `sha256:${kitDigest}`, 'identity.kitDigest = block digest over the source inventory');
assertEq(identity.engineVersion, '0.1.0', 'identity.engineVersion (never a fabricated release version)');
assertEq(identity.engineRef.kind, 'working-tree', 'identity.engineRef.kind (a dirty tree is never identified by a commit alone)');
assertEq(identity.fileCount, allRows.length, 'identity.fileCount = inventory length');

// ---- 4. license inventory -----------------------------------------------------

const lic = JSON.parse(readFileSync(join(FIXTURES_DIR, 'cases/license-inventory.json'), 'utf8'));
const lock = JSON.parse(lockBytes.toString('utf8'));
const expectedPins = ['three', 'react', 'react-dom', 'ws', '@dimforge/rapier2d-compat', '@modelcontextprotocol/sdk', 'esbuild', 'typescript', 'vitest'].map((n) => {
  const e = lock.packages[`node_modules/${n}`];
  return { name: n, version: e?.version, license: e?.license ?? null };
}).filter((p) => p.version);
assertEq(lic.pins.map(({ name, version, license }) => ({ name, version, license })), expectedPins, 'license pins (name/version/license re-extracted from the lockfile)');
assertEq(lic.lockfile.version, lock.lockfileVersion, 'lockfile version');
assertEq(lic.lockfile.esbuildPlatformPackages, Object.keys(lock.packages).filter((k) => k.startsWith('node_modules/@esbuild/')).length, 'esbuild platform package count (the node_modules-never-vendored reason)');
if (lic.pins.some((p) => p.class === 'build-only-at-runtime' && p.bundles[0].includes('browser'))) fail('esbuild misclassified as a browser-bundle member');
else ok('build-only vs runtime classification (esbuild is build-only-at-runtime, never a browser-bundle member)');

// ---- 5. pin + build-tool cases are well-formed --------------------------------

const pin = JSON.parse(readFileSync(join(FIXTURES_DIR, 'cases/pin-cases.json'), 'utf8'));
assertEq(pin.validPin, { engineVersion: '0.1.0', kitDigest: `sha256:${kitDigest}`, lockfileDigest: `sha256:${lockDigest}` }, 'game.json valid pin = the live kit identity');
if (!pin.cases.every((c) => c.id && c.result)) fail('pin cases malformed');
else ok(`pin cases (${pin.cases.length} match/mismatch/stale/superseded rows)`);

const tool = JSON.parse(readFileSync(join(FIXTURES_DIR, 'cases/build-tool-cases.json'), 'utf8'));
assertEq(tool.steps.map((s) => s.order), [1, 2, 3, 4, 5, 6, 7, 8], 'build-tool step order (verify-kit → verify-pin → install → build → template → export → verify)');
assertEq(tool.steps[1].failure?.split(' | ').sort().join(' | '), 'kit_inventory_missing | kit_lockfile_mismatch | kit_tampered', 'step 2 failure codes (closed)');
if (!tool.steps[3].failure.includes('kit_install_unavailable')) fail('step 4 must surface the structured registry failure');
else ok('step 4 registry failure is structured (never a silent skip)');
for (const id of ['CWD-INDEPENDENCE', 'SYMLINK-CONTAINMENT', 'ABSOLUTE-CHECKOUT-PATH', 'SECRET-LICENSE-OMISSION']) {
  if (!tool.rules.some((r) => r.id === id)) fail(`rule missing: ${id}`);
}
ok('cwd/symlink/absolute-path/secret-license rules present');
if (tool.negativeInventory.length < 8) fail('negative inventory cases incomplete');
else ok(`negative inventory cases (${tool.negativeInventory.length})`);

// ---- 6. index ------------------------------------------------------------------

const files = ['cases/build-tool-cases.json', 'cases/kit-identity.json', 'cases/kit-inventory.json', 'cases/license-inventory.json', 'cases/pin-cases.json'];
const index = JSON.parse(readFileSync(join(FIXTURES_DIR, 'index.json'), 'utf8'));
for (const f of files) {
  const bytes = readFileSync(join(FIXTURES_DIR, f));
  const row = index.files.find((r) => r.path === f);
  if (!row || row.byteLength !== bytes.length || row.sha256 !== sha256Bytes(bytes)) fail(`index row mismatch: ${f}`);
}
ok(`index.json rows verified (${files.length} files)`);

if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('kit fixture checks: OK');

function buildNotice(lockBytes, kitDigest) {
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const rows = [];
  for (const [k, v] of Object.entries(lock.packages)) {
    const parts = k.split('node_modules/');
    const name = parts[parts.length - 1];
    if (!k || name.startsWith('@thirdlight/') || name === 'thirdlight') continue;
    rows.push({ name, version: v.version ?? null, license: v.license ?? null, resolved: Boolean(v.resolved) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  const table = rows.map((r) => `| \`${r.name}@${r.version ?? '?'}\` | ${r.license ?? '—'} | ${r.resolved ? 'registry (pinned by lockfile integrity)' : 'workspace-local (no registry fetch)'} |`).join('\n');
  return `# Engine kit NOTICE

The engine kit (distribution.md) is a LOCAL, integrity-indexed distribution
of the Thirdlight workspace for the owner's independent games (m4-plan
§2.3). No public publishing; no license grant.

- Engine source: \`UNLICENSED\` (root package.json), private — local owner
  use only. Public redistribution requires a separate license decision.
- Self-generated content (the template sources and their NOTICE):
  \`thirdlight-sample-generated-content\` (original generated content — no
  downloaded asset, no third-party byte, no license asserted over external
  material).
- Kit identity: kitDigest \`sha256:${kitDigest}\` (the inventory digest —
  distribution.md §3). A commit alone does not identify the kit.

## Pinned third-party dependencies (from package-lock.json — the exact
## per-entry license names, never asserted beyond the package manifests)

| Package | Declared license | Source |
|---|---|---|
${table}
`;
}