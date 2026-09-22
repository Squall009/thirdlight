#!/usr/bin/env node
/**
 * fixtures/m4/audit — packet 68 (the Gate Q review pack): the fixture
 * AUDIT. One entry point that proves the whole M4 proposal fixture set:
 *
 *   A. every fixture checker runs GREEN (delivery, templates,
 *      distribution, reliability);
 *   B. DELIBERATE corruption of the four edges of record — the module
 *      edge (65), the destination identity (64), the kit digest (66) and
 *      the backup inventory (67) — makes each checker exit NONZERO
 *      (the packet's "failures must exit nonzero" evidence rule);
 *   C. the error-code registry (cases/error-code-registry.json) is the
 *      single source of truth: every proposal's closed "New error codes"
 *      section matches it exactly, no code is defined in two sections
 *      (the "contradictory errors" failure mode), and delivery.md defines
 *      no new codes (reuse only).
 *
 * Any failure exits nonzero. The temp copies live under .tmp/ (cleaned).
 *
 * Run: node fixtures/m4/audit/tools/audit.mjs
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const AUDIT_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..');
const M4_DIR = resolve(AUDIT_DIR, '..');
const REPO_ROOT = resolve(M4_DIR, '..', '..');
const TMP = join(AUDIT_DIR, '.tmp');

let failures = 0;
const fail = (m) => { failures += 1; console.error(`FAIL: ${m}`); };
const ok = (m) => console.log(`ok: ${m}`);

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, label };
}

// ---- A. every checker runs green ---------------------------------------------
const CHECKERS = [
  { id: '64-delivery', cmd: process.execPath, args: ['fixtures/m4/delivery/tools/check-fixtures.mjs'] },
  { id: '65-templates', cmd: 'npx', args: ['tsx', 'fixtures/m4/templates/tools/check-fixtures.mts'] },
  { id: '66-distribution', cmd: process.execPath, args: ['fixtures/m4/distribution/tools/check-kit.mjs'] },
  { id: '67-reliability', cmd: 'npx', args: ['tsx', 'fixtures/m4/reliability/tools/check-reliability.mts'] },
];

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
console.log('A. checkers green');
for (const c of CHECKERS) {
  const r = run(c.cmd, c.args, c.id);
  if (r.code !== 0) fail(`checker ${c.id} exited ${r.code}:\n${r.out.split('\n').slice(-8).join('\n')}`);
  else ok(`checker ${c.id} green (exit 0)`);
}

// ---- B. deliberate corruption of the four edges of record ---------------------
console.log('B. deliberate corruption (each must exit nonzero)');

function copyDir(src, dest) {
  if (statSync(src).isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const n of readdirSync(src)) copyDir(join(src, n), join(dest, n));
  } else writeFileSync(dest, readFileSync(src));
}

// B1 — the module edge (65): a tampered M4 module registry entry.
{
  const dest = join(TMP, 'templates-tamper');
  copyDir(join(M4_DIR, 'templates'), dest);
  const p = join(dest, 'cases/module-cases.json');
  const d = JSON.parse(readFileSync(p, 'utf8'));
  // flip the core module id (a module-unknown edge: the registry no longer
  // resolves the platformer core set)
  const flip = (v) => (typeof v === 'string' && v === 'thirdlight.platformer:controller') ? 'thirdlight.platformer:controller-x' : v;
  const walk = (v) => Array.isArray(v) ? v.map(walk) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : flip(v);
  writeFileSync(p, `${JSON.stringify(walk(d), null, 2)}\n`);
  const r = run('npx', ['tsx', 'fixtures/m4/templates/tools/check-fixtures.mts', '--root', dest], 'B1');
  if (r.code === 0) fail('B1: the tampered module edge PASSED (the checker must exit nonzero)');
  else ok(`B1: the tampered module edge refused (exit ${r.code})`);
}

// B2 — the destination identity (64): a flipped byte in a delivery GLB.
{
  const dest = join(TMP, 'delivery-tamper');
  copyDir(join(M4_DIR, 'delivery'), dest);
  const glb = join(dest, 'glb/runner-m4.glb');
  const buf = Buffer.from(readFileSync(glb));
  buf[40] ^= 0xff;
  writeFileSync(glb, buf);
  const r = run(process.execPath, ['fixtures/m4/delivery/tools/check-fixtures.mjs', '--root', dest], 'B2');
  if (r.code === 0) fail('B2: the tampered destination identity PASSED (the checker must exit nonzero)');
  else ok(`B2: the tampered destination identity refused (exit ${r.code})`);
}

// B3 — the kit digest (66): a tampered inventory sha256 row.
{
  const dest = join(TMP, 'distribution-tamper');
  copyDir(join(M4_DIR, 'distribution'), dest);
  const p = join(dest, 'cases/kit-inventory.json');
  const d = JSON.parse(readFileSync(p, 'utf8'));
  d.files[10].sha256 = '0'.repeat(64);
  writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
  const r = run(process.execPath, ['fixtures/m4/distribution/tools/check-kit.mjs', '--fixture', dest], 'B3');
  if (r.code === 0) fail('B3: the tampered kit digest PASSED (the checker must exit nonzero)');
  else ok(`B3: the tampered kit digest refused (exit ${r.code})`);
}

// B4 — the backup inventory (67): a tampered frozen scene digest (in-place,
// then regenerated to restore — the 67 checker reads its own fixture dir).
{
  const p = join(M4_DIR, 'reliability/cases/budget-tables.json');
  const original = readFileSync(p);
  const d = JSON.parse(original.toString('utf8'));
  d.frozenScenes[0].identity.sha256 = '0'.repeat(64);
  writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
  const r = run('npx', ['tsx', 'fixtures/m4/reliability/tools/check-reliability.mts'], 'B4');
  const restored = run('npx', ['tsx', 'fixtures/m4/reliability/tools/generate-fixtures.mts'], 'B4-restore');
  const recheck = run('npx', ['tsx', 'fixtures/m4/reliability/tools/check-reliability.mts'], 'B4-recheck');
  if (r.code === 0) fail('B4: the tampered backup/scene inventory PASSED (the checker must exit nonzero)');
  else ok(`B4: the tampered frozen scene digest refused (exit ${r.code})`);
  if (restored.code !== 0 || recheck.code !== 0) {
    // restore the original bytes no matter what (the generator is deterministic)
    writeFileSync(p, original);
    fail('B4: the regenerate-and-recheck did not return to green');
  } else ok('B4: regenerated + re-checked green (the fixture is restored)');
}

// ---- C. the error-code registry (single source of truth) ----------------------
console.log('C. error-code registry (the contradictory-errors check)');
const registry = JSON.parse(readFileSync(join(AUDIT_DIR, 'cases/error-code-registry.json'), 'utf8'));

/** Extract the backticked snake_case codes from a proposal's closed
 *  "New error codes" section (from that heading to the next '## ' heading). */
function newCodeSection(text, headingPattern) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => headingPattern.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^##[ #]/.test(l)) break;
    // the "— plus the …" clause begins the cross-reference (reused) list —
    // capture codes before the marker on the same line, then stop: the
    // section DEFINES the new codes; the reused list only references them
    const cut = l.search(/— plus the|plus the reused|plus the accepted/i);
    const body = cut === -1 ? l : l.slice(0, cut);
    const codes = [...body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]);
    out.push(...codes);
    if (cut !== -1) break;
  }
  return [...new Set(out)];
}

const proposals = {
  templates: join(REPO_ROOT, 'docs/planning/m4-contracts/templates.md'),
  distribution: join(REPO_ROOT, 'docs/planning/m4-contracts/distribution.md'),
  reliability: join(REPO_ROOT, 'docs/planning/m4-contracts/reliability.md'),
  delivery: join(REPO_ROOT, 'docs/planning/m4-contracts/delivery.md'),
};

for (const [name, path] of Object.entries(proposals)) {
  const text = readFileSync(path, 'utf8');
  const section = newCodeSection(text, /^##.*new error codes/i);
  const expected = [...registry.newCodes[name]].sort();
  if (name === 'delivery') {
    if (section !== null) fail(`C: delivery.md defines a NEW-code section (it must be reuse-only)`);
    else ok('C: delivery.md defines no new codes (reuse only)');
    continue;
  }
  if (section === null) {
    fail(`C: ${name}.md has no "New error codes" section (the closed list is missing)`);
    continue;
  }
  const found = section.filter((c) => c.startsWith('template_') || c.startsWith('module_') || c.startsWith('kit_') || c.startsWith('game_pin') || c.startsWith('backup_') || c.startsWith('restore_') || c.startsWith('budget_') || c.startsWith('source_blob') || c === 'manifest_storage_mismatch');
  const missing = expected.filter((c) => !found.includes(c));
  const extra = found.filter((c) => !expected.includes(c));
  if (missing.length || extra.length) fail(`C: ${name} section ≠ registry (missing: ${missing.join(', ') || '—'}; extra: ${extra.join(', ') || '—'})`);
  else ok(`C: ${name} closed list = the registry (${expected.length} codes)`);
}

// no code defined in two sections (a contradictory error)
{
  const seen = new Map();
  for (const [surface, codes] of Object.entries(registry.newCodes)) {
    for (const c of codes) {
      if (seen.has(c) && seen.get(c) !== surface) fail(`C: code defined twice: ${c} (${seen.get(c)} AND ${surface})`);
      seen.set(c, surface);
    }
  }
  if (seen.size === Object.values(registry.newCodes).reduce((n, arr) => n + arr.length, 0)) ok(`C: every code appears in exactly one new-code section (${seen.size} codes — no contradictory error)`);
}

// ---- summary ------------------------------------------------------------------
rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} audit check(s) FAILED`);
  process.exit(1);
}
console.log('fixture audit: OK (checkers green, 4 corrupted edges refused nonzero, registry consistent)');