#!/usr/bin/env node
/**
 * fixtures/m3/audit/tools/check-promotion.mjs
 *
 * Gate K docs-only promotion check (packet 43 follow-up, 2026-09-19).
 *
 * Asserts that the accepted / accepted-with-repaired contract rows recorded in
 * docs/planning/m3-contracts/contract-diffs.md §2 are actually present in their
 * destination documents under docs/contracts/, that the rejected PM13 row is
 * absent, that the two new contract homes exist and are registered, that the
 * v3 version-combination statements agree across project-model / workspace /
 * runtime / gameplay, and that the preview CSP carries `'wasm-unsafe-eval'`.
 *
 * It is a docs-consistency check, not a product test: a marker is a short exact
 * substring of the applied normative text, chosen so that removing that text
 * fails the check. No dependency, no eval, no network.
 *
 * Usage (repository root):
 *   node fixtures/m3/audit/tools/check-promotion.mjs
 *   TL43_PROMOTION_DOCS_ROOT=<copy of docs/contracts> node fixtures/m3/audit/tools/check-promotion.mjs
 *   node fixtures/m3/audit/tools/check-promotion.mjs --corrupt-control
 *
 * Exit 0 = every check passed; 1 = at least one failed. `--corrupt-control`
 * copies docs/contracts, removes one accepted marker and one registration, and
 * requires this checker to exit non-zero on each corrupted copy.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const CONTRACTS = process.env.TL43_PROMOTION_DOCS_ROOT
  ? resolve(process.env.TL43_PROMOTION_DOCS_ROOT)
  : join(REPO, 'docs', 'contracts');

// ---------------------------------------------------------------------------
// negative control: remove accepted text from a copy and require a non-zero exit
// ---------------------------------------------------------------------------
if (process.argv.includes('--corrupt-control')) {
  const src = CONTRACTS;
  const self = fileURLToPath(import.meta.url);
  const cases = [
    ['remove-marker', 'export.md', 'Non-root static closure.', ''],
    ['remove-registration', 'dependencies.md', '`gameplay.md`, `presentation.md`', '`gameplay.md`'],
    ['drop-csp-token', 'sessions.md', "script-src 'self' 'wasm-unsafe-eval'; connect-src", "script-src 'self'; connect-src"],
    ['restore-pm13', 'project-model.md', '### 18.1', '### 18.1\n\n**reserved for packet 41** — note only'],
  ];
  let ok = true;
  for (const [name, file, find, replace] of cases) {
    const tmp = mkdtempSync(join(tmpdir(), 'tl43-promo-'));
    try {
      cpSync(src, tmp, { recursive: true });
      const p = join(tmp, file);
      const text = readFileSync(p, 'utf8');
      if (!text.includes(find)) { console.log(`  CONTROL ${name}: fixture text not found`); ok = false; continue; }
      writeFileSync(p, text.replace(find, replace));
      const r = spawnSync(process.execPath, [self], {
        env: { ...process.env, TL43_PROMOTION_DOCS_ROOT: tmp }, encoding: 'utf8',
      });
      const status = r.status === null ? 'spawn-failed' : r.status;
      const good = status !== 0;
      if (!good) ok = false;
      console.log(`  CONTROL ${name}: exit ${status} ${good ? '(expected non-zero)' : '(UNEXPECTED ZERO)'}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`check-promotion --corrupt-control: ${ok ? 'every removal was detected' : 'A CONTROL FAILED'}`);
  process.exit(ok ? 0 : 1);
}

const failures = [];
const passes = [];
const fail = (check, detail) => failures.push({ check, detail });
const pass = (check, detail) => passes.push({ check, detail: detail ?? null });

// ---------------------------------------------------------------------------
// 1. accepted / accepted-with-repaired rows: one marker per row
// ---------------------------------------------------------------------------
// row | file | exact marker in the promoted destination
const MARKERS = [
  // packet 39 — project-model
  ['PM1', 'project-model.md', 'adds exactly one required key, `game`'],
  ['PM2', 'project-model.md', 'scene `[1, 2, 3]`'],
  ['PM3', 'project-model.md', 'M3 adds one passable combination, not a new rule.'],
  ['PM4', 'project-model.md', 'In the M3 workspace the embedded scene is `schemaVersion` 3'],
  ['PM5', 'project-model.md', 'plus six components'],
  ['PM6', 'project-model.md', '**v3 additions.** The content key order becomes'],
  ['PM7', 'project-model.md', 'v3 documents add one collected pass'],
  ['PM8', 'project-model.md', 'migrateSceneV3(scene)` is the pure v2→v3 logical migration'],
  ['PM9', 'project-model.md', 'game_reference_missing` | `content.game` names an entity'],
  ['PM10', 'project-model.md', '### 13.2 Three-block composition'],
  ['PM11', 'project-model.md', 'v3 adds no document and no second mutable file.'],
  ['PM12', 'project-model.md', 'The packet-39 v3 material (new §23) is a new known version combination'],
  ['PM14', 'project-model.md', '| `game` | `GameConfig` or `null` |'],
  ['PM15', 'project-model.md', '`"model"` (whole-GLB model kind) or `"audio"`'],
  ['PM16', 'project-model.md', 'in v3** every `components.modelAnimation.assetId`'],
  ['PM17', 'project-model.md', 'are likewise **not** in the definition vocabulary'],
  ['PM18', 'project-model.md', '**v3 game references** are the first content→scene references'],
  ['PM19', 'project-model.md', '### 23.9 New error codes'],
  ['PM41-1', 'project-model.md', 'One reviewed exception (M3, packet 41)'],
  ['PM41-2', 'project-model.md', 'exactly `"gltf-glb"` or `"pcm-wav"`'],
  ['PM41-3', 'project-model.md', 'Audio metric member (`presentation.md` §41.4.3)'],
  ['PM41-4', 'project-model.md', '`animation_role_out_of_range`'],
  ['PM41-5', 'project-model.md', '§18.7 defines the **model** profile'],
  ['PM41-6', 'project-model.md', 'binding contributes its recorded `version` explicitly'],
  ['PM41-7', 'project-model.md', '33 554 432'],
  ['PM43-1', 'project-model.md', 'this M1 sentence is not a v3 non-goal.'],
  ['PM43-2', 'project-model.md', 'That bullet is scoped to scene schemaVersion 1/2.'],
  // packet 39 — workspace
  ['W1', 'workspace.md', '**no new file, directory or artifact'],
  ['W2', 'workspace.md', 'A `storageVersion` 3 envelope keeps the **same** top-level key set'],
  ['W3', 'workspace.md', 'exactly **three** passable combinations'],
  ['W4', 'workspace.md', 'migrateProjectCopyV3(sourceProjectId, newProjectId)` | operator'],
  ['W5', 'workspace.md', 'migration_version_unsupported` | the source is not a loadable'],
  ['W6', 'workspace.md', '`content.game`, canonical | 16 384 B'],
  ['W7', 'workspace.md', 'v3 migration is a second, separate operator'],
  ['W8', 'workspace.md', 'v3 adds no backup class.'],
  ['W9', 'workspace.md', '### 16.5 Migration: v2 project → v3 project copy'],
  // packet 39 — commands
  ['C1', 'commands.md', '| `applySurfacePreset` | mutation |'],
  ['C2', 'commands.md', 'M3 adds: no new `createEntity` kind'],
  ['C3', 'commands.md', '| `surfacePreset` | `"matte-ground" | "hazard" | "beacon"`'],
  ['C4', 'commands.md', '{ box, camera, model, collider, controller, gameZone, playerSpawn, cameraFollow,'],
  ['C5', 'commands.md', '**§3.1.10 `setGameConfig`**'],
  ['C6', 'commands.md', '`kind` is `"model" | "audio"`, **required** on `mode: "create"`'],
  ['C7', 'commands.md', '`queryEntities` accepts an optional `component` filter'],
  ['C8', 'commands.md', '| `setGameConfig` | `{ type, previous, next, changedFields }`'],
  ['C9', 'commands.md', '| `game_config_invalid` | `validation` | `path`, `reason`'],
  ['C10', 'commands.md', 'The derived prefix order is **first match**'],
  ['C11', 'commands.md', '| `modelAnimation` | `assetId`, `version`, `roles`'],
  ['C12', 'commands.md', '### 8.14 `setGameConfig`'],
  ['C13', 'commands.md', '`applySurfacePreset` ⇒ `{ "kind": "setComponent", "id", "component": "surface"'],
  ['C14', 'commands.md', 'Packet-39 v3 fixtures add `fixtures/m3/contracts/commands/*`'],
  ['CMD41-1', 'commands.md', '`create`** (`field_missing`) and, on `reimport`'],
  ['CMD41-2', 'commands.md', '#### 8.5.1 Atomic animated reimport'],
  ['CMD41-3', 'commands.md', '`animation_skin_unsupported`'],
  // packet 40/41/42 — runtime
  ['R40-1', 'runtime.md', 'The **M3 run** and its schedule'],
  ['R40-2', 'runtime.md', 'v3 snapshots only, required.'],
  ['R40-3', 'runtime.md', 'Run-start barrier (M3-enabled sets).'],
  ['R40-4', 'runtime.md', '`lastCommitted` (M3, runtime-private).'],
  ['R40-5', 'runtime.md', 'M3 step boundary (additive).'],
  ['R40-6', 'runtime.md', "needs **no extra adapter API and no new read"],
  ['R40-7', 'runtime.md', '`game_spawn_blocked`'],
  ['R40-8', 'runtime.md', 'M3 additions, appended'],
  ['R40-9', 'runtime.md', 'M3 phase scoping.'],
  ['R40-10', 'runtime.md', 'Exactly one camera writer (M3).'],
  ['R40-11', 'runtime.md', 'M3 supersession (scoped).'],
  ['R40-12', 'runtime.md', '**The diagnostic `reset()` is never a gameplay path (normative).**'],
  ['R40-13', 'runtime.md', '`getGameView()` keeps returning the last committed view with'],
  ['R40-14', 'runtime.md', 'M3 effective-frame overrides (additive).'],
  ['R40-15', 'runtime.md', '## 15. M3 game session: schedule, reset barrier, view and camera'],
  ['R40-16', 'runtime.md', 'The M3 game session is contract material.'],
  ['R40-17', 'runtime.md', 'readonly playerMotion: PlayerMotion;'],
  ['R41-1', 'runtime.md', 'Presentation resources are host-owned.'],
  ['R41-2', 'runtime.md', 'Animation roles write no transform.'],
  ['R41-3', 'runtime.md', 'Presentation survival across fail-stop.'],
  ['R41-4', 'runtime.md', 'this is a `GameView` field, not a snapshot field'],
  ['R42-1', 'runtime.md', 'C35-5 closed (packet 42):'],
  ['R42-2', 'runtime.md', 'C35-5 — where `content.settings` comes from (closed by packet 42).'],
  ['R42-3', 'runtime.md', 'Menu controls are not action frames (packet 42).'],
  ['R42-4', 'runtime.md', '### 15.5 The committed `GameView` and the run surface'],
  // packet 42 — sessions
  ['S42-1', 'sessions.md', '`game.control.request`'],
  ['S42-2', 'sessions.md', 'The build is a manifest v2 capture.'],
  ['S42-3', 'sessions.md', 'game observation events | ≤ 32'],
  ['S42-4', 'sessions.md', '`allow="gamepad"` — the editor'],
  ['S42-5', 'sessions.md', '`tl.game.control`'],
  ['S42-6', 'sessions.md', 'A reload constructs a **fresh `game-host`**'],
  ['S42-7', 'sessions.md', 'exactly `2` for an M3 capture'],
  ['S42-8', 'sessions.md', "script-src 'self' 'wasm-unsafe-eval'"],
  ['S42-9', 'sessions.md', 'M3 (packet 42): no new fetch.'],
  ['S42-10', 'sessions.md', 'M3 readiness and the title screen.'],
  ['S42-11', 'sessions.md', '## 20. M3 game control and observation relay'],
  ['S42-12', 'sessions.md', 'The preview CSP token set (including'],
  // packet 42 — export
  ['E42-1', 'export.md', 'The export declares its own policy.'],
  ['E42-2', 'export.md', 'Non-root static closure.'],
  ['E42-3', 'export.md', 'One shared host composition.'],
  ['E42-4', 'export.md', 'M3 entry (packet 58).'],
  ['E42-5', 'export.md', 'M3 addition (packet 42):'],
  ['E42-6', 'export.md', 'The host starts in `awaitingStart`'],
  ['E42-7', 'export.md', 'For an M3 export `manifest.manifestVersion` is `2`'],
  ['E42-8', 'export.md', 'M3 two-tree rule (packet 42, normative).'],
  ['E42-9', 'export.md', 'M3: the manifest is `manifestVersion` 2'],
  ['PM43-3', 'export.md', 'This §8 list is scoped to an M1 export.'],
  // packet 42 — dependencies
  ['D42-1', 'dependencies.md', '| `game-host` | `delivery.md` §§3–5 | 55 |'],
  ['D42-2', 'dependencies.md', 'platformerGameSessionSpec'],
  ['D42-3', 'dependencies.md', '`game-host` | `runtime` (types + `instantiateRuntime`'],
  ['D42-4', 'dependencies.md', 'The M3 runtime bundles share one host composition.'],
  ['D42-5', 'dependencies.md', 'platformer-game → input | physics-rapier'],
  ['D42-6', 'dependencies.md', 'Host-composition containment'],
  ['D42-7', 'dependencies.md', '`game-host` and `platformer-game` are the only M3 units added by packet 42'],
  // new contract homes
  ['NC-1', 'gameplay.md', '## 6. The committed read-only game view'],
  ['NC-1b', 'gameplay.md', 'readonly playerMotion: PlayerMotion; // the committed motion the role selector consumes (C41-1)'],
  ['NC-2', 'presentation.md', '## 41.3 Rigid-node animation roles'],
];

// PM13 (Gate K rejected, superseded by PM41-1): the reserved-slot note must not
// be applied anywhere.
const PM13_ABSENT = [
  ['project-model.md', '**reserved for packet 41** — note only'],
  ['project-model.md', 'Packet 41 owns that exact replacement text'],
];

const read = (file) => readFileSync(join(CONTRACTS, file), 'utf8');

// ---------------------------------------------------------------------------
// 2. the v3 combination agreement (project-model / workspace / runtime / gameplay)
// ---------------------------------------------------------------------------
function versionTablesAgree() {
  const pm = read('project-model.md');
  const ws = read('workspace.md');
  const rt = read('runtime.md');
  const gp = read('gameplay.md');

  const pmTriple = pm.match(/`manifest (\d) \+ scene (\d) \+\s*\n?storage (\d)`/);
  const wsRow = ws.match(/^\| 1 \| 3 \| 3 \| \*\*valid\*\*/m);
  if (!pmTriple) return 'project-model.md: the `manifest N + scene N + storage N` v3 combination row is missing';
  if (!wsRow) return 'workspace.md: the `| 1 | 3 | 3 | **valid**` row is missing';
  const a = pmTriple.slice(1, 4).join('.');
  const b = '1.3.3';
  if (a !== b) return `version tables disagree: project-model ${a} vs workspace ${b}`;
  if (!/sceneVersion: 1 \| 2 \| 3;/.test(rt)) return 'runtime.md: ModuleConfig.sceneVersion does not admit 3';
  if (!/`schemaVersion !== 3`/.test(gp)) return 'gameplay.md: the v3-only instantiate rule (`schemaVersion` !== 3) is missing';
  if (!/Unsupported module combinations|installed\./.test(rt)) return 'runtime.md: §12.4 text missing';
  return null;
}

// ---------------------------------------------------------------------------
// 3. the CSP token (C38-1) and the manifest v2 identity
// ---------------------------------------------------------------------------
function cspOk() {
  const s = read('sessions.md');
  const e = read('export.md');
  const m = s.match(/^\s*default-src 'none'; script-src 'self' (?<tok>[^;]+); connect-src 'self';/m);
  if (!m) return 'sessions.md §17.4: the preview CSP fence line is missing';
  if (!m.groups.tok.includes("'wasm-unsafe-eval'")) {
    return `sessions.md §17.4: script-src token is ${m.groups.tok.trim()}, expected 'wasm-unsafe-eval'`;
  }
  if (!e.includes("script-src 'self' 'wasm-unsafe-eval'")) return 'export.md §3: the export CSP does not carry the token';
  return null;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
for (const [row, file, text] of MARKERS) {
  if (!existsSync(join(CONTRACTS, file))) { fail('marker', `${row}: ${file} is missing`); continue; }
  if (!read(file).includes(text)) fail('marker', `${row}: ${file} is missing marker ${JSON.stringify(text)}`);
}
if (!failures.some((f) => f.check === 'marker')) {
  pass('marker', `${MARKERS.length} accepted-row markers present in their destination contracts`);
}

let pm13Bad = null;
for (const [file, text] of PM13_ABSENT) {
  if (existsSync(join(CONTRACTS, file)) && read(file).includes(text)) pm13Bad = `${file} still contains ${JSON.stringify(text)}`;
}
if (pm13Bad) fail('pm13-absent', pm13Bad);
else pass('pm13-absent', 'the rejected PM13 reserved-slot note is absent (PM41-1 is the applied text)');

{
  const deps = read('dependencies.md');
  const problems = [];
  for (const home of ['gameplay.md', 'presentation.md']) {
    if (!existsSync(join(CONTRACTS, home))) problems.push(`${home} does not exist`);
    else {
      const t = read(home);
      if (!t.startsWith('# Thirdlight —')) problems.push(`${home} has no accepted contract header`);
      if (/PROPOSED/.test(t.split('\n').slice(0, 30).join('\n'))) problems.push(`${home} header still says PROPOSED`);
    }
  }
  if (!deps.includes('`gameplay.md`, `presentation.md`')) problems.push('dependencies.md companion list does not register the two homes');
  if (!deps.includes('| `platformer-game` | `gameplay.md` | 49 |')) problems.push('dependencies.md §2 does not register `platformer-game` → gameplay.md');
  if (problems.length) fail('new-homes', problems.join('; '));
  else pass('new-homes', 'gameplay.md/presentation.md exist, carry accepted headers and are registered in dependencies.md');
}

{
  const problem = versionTablesAgree();
  if (problem) fail('version-combination', problem);
  else pass('version-combination', 'project-model / workspace / runtime / gameplay agree on `manifest 1 + scene 3 + storage 3`');
}

{
  const problem = cspOk();
  if (problem) fail('csp', problem);
  else pass('csp', "sessions §17.4 and export §3 carry `script-src 'self' 'wasm-unsafe-eval'`");
}

const OK = failures.length === 0;
console.log(`check-promotion: ${passes.length} groups passed, ${failures.length} failed (${MARKERS.length} markers)`);
for (const p of passes) console.log(`  PASS ${p.check}: ${p.detail ?? ''}`);
for (const f of failures) console.log(`  FAIL ${f.check}: ${f.detail}`);
process.exit(OK ? 0 : 1);
