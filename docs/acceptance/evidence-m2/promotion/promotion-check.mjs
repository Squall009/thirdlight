#!/usr/bin/env node
/**
 * docs/acceptance/evidence-m2/promotion/promotion-check.mjs
 *
 * Post-promotion consistency check (2026-09-18). Docs-only: it proves that
 * every Gate-E-accepted inventory destination section exists in
 * docs/contracts/**, that the accepted diff text was applied, that no
 * "PROPOSED — pending Gate E" marker survives in the promoted contracts, and
 * that the proposal/diff files are marked PROMOTED/historical.
 *
 * It does NOT execute any proposed behavior and does NOT replace the M1
 * regression toolchain (see toolchain.txt).
 *
 * Usage: node docs/acceptance/evidence-m2/promotion/promotion-check.mjs
 * Exit 0 = all checks passed; 1 = at least one failure.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..');
const failures = [];
const passes = [];
const fail = (m) => failures.push(m);
const pass = (m) => passes.push(m);

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------- 1. sections
const want = {
  'docs/contracts/project-model.md': [
    '## 18. Content catalog', '### 18.1 ', '### 18.2 ', '### 18.3 ', '### 18.4 ',
    '### 18.5 ', '### 18.6 ', '### 18.7 ', '### 18.8 ', '### 18.9 ', '### 18.10 ',
    '## 19. Captured immutable content view', '### 19.1 ', '### 19.2 ', '### 19.3 ',
    '## 20. Prefab definitions', '### 20.1 ', '### 20.2 ', '### 20.3 ', '### 20.4 ',
    '### 20.5 ', '### 20.6 ', '### 20.7 ', '### 20.8 ', '### 20.9 ', '### 20.10 ',
    '## 21. Physics-bearing components', '### 21.1 ', '### 21.2 ', '### 21.3 ',
    '### 21.4 ', '### 21.5 ', '### 21.6 ',
    '## 22. Behavior source records', '### 22.1 ', '### 22.2 ', '### 22.3 ',
    '### 22.4 ', '### 22.5 ', '### 22.6 ', '### 22.7 ',
    '### 13.1 Three-block composition', '### 13.2 Behavior source, trust',
  ],
  'docs/contracts/workspace.md': [
    '### 4.5 Envelope version compatibility', '### 7.6 The supported staging area',
    '## 13. Content storage, publication and retention', '### 13.0 ', '### 13.1 ',
    '### 13.2 ', '### 13.3 ', '#### 13.3.1 ', '#### 13.3.2 ', '#### 13.3.3 ',
    '#### 13.3.4 ', '### 13.4 ', '### 13.5 ', '### 13.6 ', '### 13.7 ',
    '### 13.8 ', '### 13.9 ', '### 13.10 ',
    '## 14. Migration: M1 project', '#### 14.1 ', '#### 14.2 ', '#### 14.3 ', '#### 14.4 ',
    '## 15. Artifact backup classification',
  ],
  'docs/contracts/commands.md': [
    '**§3.1.1 `publishAsset`', '**§3.1.2 `createPrefab`', '**§3.1.3 `instantiatePrefab`',
    '**§3.1.4 `publishBehavior`', '**§3.1.5 `setBehaviorProperties`',
    '**§3.1.6 `setComponent`', '**§3.1.7 `setSettings`', '**§3.1.8 `acknowledgeBehaviorTrust`',
    '### 8.5 `publishAsset`', '### 8.6 `createPrefab`', '### 8.7 `instantiatePrefab`',
    '### 8.8 `publishBehavior`', '### 8.9 `setBehaviorProperties`', '### 8.10 `setComponent`',
    '### 8.11 `setSettings`', '### 8.12 `acknowledgeBehaviorTrust`',
  ],
  'docs/contracts/runtime.md': [
    '## 12. M2 module phases', '### 12.0 ', '### 12.1 ', '### 12.2 ', '### 12.3 ',
    '### 12.4 ', '### 12.5 ', '### 12.6 ', '### 12.7 ',
    '## 13. M2 fail-stop lifecycle',
    '## 14. Behavior execution boundary', '### 14.1 ', '### 14.2 ', '### 14.3 ',
    '### 14.4 ', '### 14.5 ', '### 14.6 ', '### 14.7 ', '### 14.8 ',
  ],
  'docs/contracts/sessions.md': [
    '### 10.5 Play-content readiness', '## 16. Authenticated committed asset-byte reads',
    '## 17. Immutable play-content locator', '### 17.1 ', '### 17.2 ', '### 17.3 ',
    '### 17.4 ', '### 17.5 ', '### 17.6 ', '## 18. Bounded input-exercise relay',
  ],
  'docs/contracts/export.md': [
    'manifest.json', 'content/sha256/<digest>', 'behaviors/<outputDigest>.js',
    '**Reference-build entry (U-4 ACCEPT', '`schemaVersion` becomes exactly `2`',
  ],
};
for (const [file, needles] of Object.entries(want)) {
  if (!existsSync(join(ROOT, file))) { fail(`missing contract ${file}`); continue; }
  const text = read(file);
  const missing = needles.filter((n) => !text.includes(n));
  if (missing.length) fail(`${file}: missing ${missing.length} destination marker(s): ${missing.slice(0, 4).join(' | ')}`);
  else pass(`${file}: all ${needles.length} destination markers present`);
}

// ---------------------------------------------------------------- 2. key diffs
const applied = [
  ['docs/contracts/project-model.md', 'version_combination_unsupported'],
  ['docs/contracts/project-model.md', 'physics_transform_unsupported'],
  ['docs/contracts/project-model.md', 'behavior_trust_unacknowledged'],
  ['docs/contracts/project-model.md', 'content.behaviorTrust'],
  ['docs/contracts/workspace.md', 'migration_resume_required'],
  ['docs/contracts/workspace.md', '**G3 — content publication addendum'],
  ['docs/contracts/commands.md', 'instantiatePrefab'],
  ['docs/contracts/commands.md', 'reference_in_use'],
  ['docs/contracts/commands.md', 'behavior_publication_unavailable'],
  ['docs/contracts/commands.md', 'preparation_missing'],
  ['docs/contracts/runtime.md', 'IntentSet'],
  ['docs/contracts/runtime.md', 'runtime_failed'],
  ['docs/contracts/sessions.md', 'PLAY_CONTENT_TTL'],
  ['docs/contracts/sessions.md', 'bridgeVersion: 2'],
  ['docs/contracts/sessions.md', 'engineRoot'],
  ['docs/contracts/export.md', 'outputDigest'],
  ['docs/contracts/export.md', 'export_manifest_invalid'],
  ['docs/contracts/dependencies.md', 'behavior-build'],
  ['docs/contracts/dependencies.md', 'sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ=='],
];
for (const [file, needle] of applied) {
  const text = read(file);
  if (!text.includes(needle)) fail(`${file}: accepted diff text not applied: ${needle.slice(0, 60)}`);
}
if (failures.length === 0) pass('every sampled accepted-diff marker is present');

// ---------------------------------------------------------------- 3. no markers
const contractFiles = Object.keys(want);
for (const f of contractFiles) {
  const text = read(f);
  for (const bad of ['PROPOSED — pending Gate E', 'PROPOSED, pending Gate E', 'PROPOSED pending Gate E']) {
    if (text.includes(bad)) fail(`${f}: promoted contract still contains "${bad}"`);
  }
}
pass('no "PROPOSED — pending Gate E" marker remains in docs/contracts/');

// ---------------------------------------------------------------- 4. GE-2 rename
const deps = read('docs/contracts/dependencies.md');
if (/\|\s*`behaviors`\s*\|/.test(deps)) fail('dependencies.md §2 still has a `behaviors` unit row');
if (/\|\s*`behavior-compiler`\s*\|/.test(deps)) fail('dependencies.md §2 still has a `behavior-compiler` unit row');
if (!deps.includes('**M2 naming resolution (binding — GE-2).**')) fail('dependencies.md: GE-2 naming resolution note missing');
pass('GE-2 rename materialized (no behavior-compiler/behaviors unit rows; behavior-build/runtime only)');

// ---------------------------------------------------------------- 5. proposal headers
const propDir = 'docs/planning/m2-contracts';
const propFiles = readdirSync(join(ROOT, propDir)).filter((f) => f.endsWith('.md')).map((f) => `${propDir}/${f}`);
for (const f of readdirSync(join(ROOT, propDir, 'diffs')).filter((f) => f.endsWith('.md'))) propFiles.push(`${propDir}/diffs/${f}`);
let missingHeader = 0;
for (const f of propFiles) {
  if (!read(f).startsWith('PROMOTED into docs/contracts/ on 2026-09-18')) { missingHeader++; fail(`${f}: PROMOTED header missing`); }
}
if (missingHeader === 0) pass(`${propFiles.length} proposal/diff file(s) carry the PROMOTED/historical header`);

// ---------------------------------------------------------------- 6. decisions
const dec = read('docs/decisions/0002-m2-content-and-behavior.md');
for (const needle of ['owner pre-approval (autonomous M2 build instruction,', 'U-4', 'no hard runtime\ntimeout and no hostile-code sandbox']) {
  if (!dec.includes(needle.replace('\\n', '\n'))) fail(`decision 0002: missing "${needle}"`);
}
pass('decision 0002 records the pin/trust/U-4 dispositions under the pre-approval tag');

for (const p of passes) console.log(`ok   ${p}`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${failures.length === 0 ? 'promotion-check OK' : 'promotion-check FAILED'}: ${passes.length} check group(s) passed, ${failures.length} problem(s)`);
process.exit(failures.length === 0 ? 0 : 1);
