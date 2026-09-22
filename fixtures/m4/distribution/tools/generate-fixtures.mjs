#!/usr/bin/env node
/**
 * fixtures/m4/distribution — packet 66 (M4 engine-kit / independent build
 * contract). Deterministic generator (plain node; no dependencies).
 *
 * Resolves the distribution.md §1 allowlist against the LIVE tree and
 * pins, as specification:
 *   cases/kit-inventory.json   the exact kit file inventory (src path →
 *                              kit path, classification, byteLength,
 *                              sha256 — canonical ascending kitPath)
 *   cases/kit-identity.json    the kit identity record (working-tree
 *                              engineRef, lockfileDigest, kitDigest —
 *                              the accepted block-digest rule over the
 *                              inventory, kit.json excluded)
 *   cases/license-inventory.json  the third-party pin + license table
 *                              (extracted from package-lock.json) + the
 *                              build-only/runtime classification
 *   cases/pin-cases.json       the game.json pin shape + the match /
 *                              mismatch / stale-pin / superseded-kit cases
 *   cases/build-tool-cases.json  the game-build.mjs verification order
 *                              (step → failure code) + the cwd /
 *                              symlink / absolute-path / negative-inventory
 *                              rules
 *   index.json                 byte length + sha256 of every generated
 *                              data file
 *
 * The independent checker (check-kit.mjs) re-derives the inventory from
 * the live tree and verifies the identity digests, the negative-inventory
 * rules and the license extraction.
 *
 * Run: node fixtures/m4/distribution/tools/generate-fixtures.mjs [--check]
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const FIXTURES_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..');
// distribution/tools/ → distribution/ → m4/ → fixtures/ → repo root (4 up).
const REPO_ROOT = resolve(FIXTURES_DIR, '..', '..', '..');
const CHECK = process.argv.includes('--check');

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sha256Bytes = (b) => createHash('sha256').update(b).digest('hex');

/** Canonical ascending-order block digest (the accepted rule). */
function blockDigest(entries) {
  const rows = entries
    .map((e) => JSON.stringify({ path: e.path, sha256: e.sha256 }))
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

/** Deterministic recursive file listing (files only). */
function listFiles(root, prefix = '') {
  const out = [];
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, rel));
    else if (st.isFile()) out.push(rel);
    else out.push(`${rel}\0SYMLINK`); // flagged, never followed
  }
  return out;
}

// ---- distribution.md §1 — the allowlist (closed rule) -----------------------

const TOP_LEVEL_FILES = ['package.json', 'package-lock.json', 'tsconfig.base.json'];
const TOOLS_FILES = [
  'build.mjs', 'build.test.mjs',
  'check-boundaries.mjs', 'check-boundaries.test.mjs',
  'check-deps.mjs', 'check-deps.test.mjs',
  'typecheck.mjs', 'typecheck.test.mjs',
];
const CONTRACT_FILES = readdirSync(join(REPO_ROOT, 'docs/contracts')).sort();
const TEMPLATE_SRC = 'fixtures/m4/templates/templates/platformer-starter';
const TEMPLATE_KIT = 'templates/platformer-starter';

function buildInventory() {
  const entries = [];
  const add = (srcRel, kitPath, classification) => {
    const abs = join(REPO_ROOT, srcRel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`allowlisted path missing or not a file: ${srcRel}`);
    }
    entries.push({ src: srcRel, kitPath, classification, byteLength: statSync(abs).size, sha256: sha256File(abs) });
  };

  for (const f of TOP_LEVEL_FILES) add(f, f, 'manifest');
  for (const p of readdirSync(join(REPO_ROOT, 'packages')).sort()) {
    const pkgDir = join(REPO_ROOT, 'packages', p);
    if (!existsSync(join(pkgDir, 'package.json'))) continue;
    for (const rel of listFiles(pkgDir)) {
      if (rel.split('/').includes('node_modules')) continue;
      add(`packages/${p}/${rel}`, `packages/${p}/${rel}`, 'source');
    }
  }
  for (const f of TOOLS_FILES) add(`tools/${f}`, `tools/${f}`, 'tooling');
  for (const f of CONTRACT_FILES) add(`docs/contracts/${f}`, `docs/contracts/${f}`, 'contracts');
  for (const rel of listFiles(join(REPO_ROOT, TEMPLATE_SRC))) {
    add(`${TEMPLATE_SRC}/${rel}`, `${TEMPLATE_KIT}/${rel}`, 'template');
  }

  // Generated kit data (the generator produces the exact bytes below; they
  // are inventory members; kit.json is EXCLUDED from the kitDigest — the
  // accepted self-exclusion rule).
  const lockBytes = readFileSync(join(REPO_ROOT, 'package-lock.json'));
  const lockDigest = sha256Bytes(lockBytes);
  const dataEntries = entries
    .map((e) => ({ path: e.kitPath, sha256: e.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const kitDigest = blockDigest(dataEntries);
  const gitDirty = countDirtyPaths();

  const kitJson = {
    v: 1,
    engineRef: {
      kind: 'working-tree',
      recordedAt: '2026-09-22',
      dirtyPathCount: gitDirty,
      note: 'commit alone cannot identify a dirty tree — the digests are the identity (m4-plan §2.3; distribution.md §3)',
    },
    engineVersion: '0.1.0',
    lockfileDigest: `sha256:${lockDigest}`,
    fileCount: dataEntries.length + 2, // + kit.json + NOTICE
    inventory: dataEntries,
    generated: ['kit.json', 'NOTICE'],
    kitDigest: `sha256:${kitDigest}`,
  };
  const kitJsonBytes = Buffer.from(JSON.stringify(kitJson, null, 2) + '\n', 'utf8');
  const notice = buildNotice(lockBytes, kitDigest);
  const noticeBytes = Buffer.from(notice, 'utf8');

  entries.push({ src: '(generated by the kit assembler at assembly time)', kitPath: 'kit.json', classification: 'generated-data', byteLength: kitJsonBytes.length, sha256: sha256Bytes(kitJsonBytes) });
  entries.push({ src: '(generated by the kit assembler at assembly time)', kitPath: 'NOTICE', classification: 'generated-data', byteLength: noticeBytes.length, sha256: sha256Bytes(noticeBytes) });

  entries.sort((a, b) => a.kitPath.localeCompare(b.kitPath));
  return { entries, kitDigest, lockDigest, kitJson, notice };
}

function countDirtyPaths() {
  // The dirty-path count of the recorded working tree (git status) — a
  // record, not an identity input.
  try {
    const out = execSync('git status --porcelain', { cwd: REPO_ROOT }).toString().split('\n').filter(Boolean).length;
    return out;
  } catch {
    return -1; // non-git context: the record is unavailable (not an identity input)
  }
}

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

// ---- the case files ----------------------------------------------------------

function licenseInventory() {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const top = ['three', 'react', 'react-dom', 'ws', '@dimforge/rapier2d-compat', '@modelcontextprotocol/sdk', 'esbuild', 'typescript', 'vitest'];
  const classification = {
    three: { class: 'runtime-browser', bundles: ['preview', 'preview-m3', 'export'] },
    react: { class: 'runtime-browser', bundles: ['editor'] },
    'react-dom': { class: 'runtime-browser', bundles: ['editor'] },
    ws: { class: 'runtime-node', bundles: ['backend'] },
    '@dimforge/rapier2d-compat': { class: 'runtime-browser', bundles: ['preview', 'preview-m3', 'export'] },
    '@modelcontextprotocol/sdk': { class: 'runtime-node', bundles: ['mcp-adapter'] },
    esbuild: { class: 'build-only-at-runtime', bundles: ['(none — external in the backend bundle; resolved from node_modules at export/compile time)'] },
    typescript: { class: 'build-only', bundles: ['(none — typecheck)'] },
    vitest: { class: 'build-only-test', bundles: ['(none — tests)'] },
  };
  const pins = top.map((n) => {
    const entry = lock.packages[`node_modules/${n}`];
    if (!entry) throw new Error(`missing lockfile entry for top-level pin ${n}`);
    return { name: n, version: entry.version, license: entry.license ?? null, ...classification[n] };
  });
  const allEntries = Object.keys(lock.packages).filter((k) => k).length;
  return {
    note: 'C12: the kit installs EXACTLY this lockfile (npm ci — lockfile-authoritative; no re-resolution → a transitive floating dependency is impossible by construction). Top-level pins classified per distribution.md §5; every transitive entry is pinned by the lockfile integrity hashes.',
    pins,
    lockfile: {
      version: lock.lockfileVersion,
      entryCount: allEntries + 1, // includes the root entry ""
      esbuildPlatformPackages: Object.keys(lock.packages).filter((k) => k.startsWith('node_modules/@esbuild/')).length,
      nodeModulesNeverVendored: true,
      reason: 'machine-dependent platform binaries (25 @esbuild/<platform> packages) — install via npm ci --prefix <kit>',
    },
  };
}

function pinCases(kitDigest, lockDigest) {
  const validPin = {
    engineVersion: '0.1.0',
    kitDigest: `sha256:${kitDigest}`,
    lockfileDigest: `sha256:${lockDigest}`,
  };
  return {
    note: 'game.json (distribution.md §2) is the game-owned authoritative identity. The build tool compares game.json.enginePin against the vendored kit\'s ACTUAL identity (re-hashed — never the recorded kit.json alone).',
    validPin,
    cases: [
      { id: 'PIN-MATCH', gamePin: validPin, result: 'build proceeds to install' },
      { id: 'PIN-KIT-DIGEST-MISMATCH', gamePin: { ...validPin, kitDigest: `sha256:${'0'.repeat(64)}` }, result: 'game_pin_mismatch' },
      { id: 'PIN-LOCKFILE-MISMATCH', gamePin: { ...validPin, lockfileDigest: `sha256:${'0'.repeat(64)}` }, result: 'game_pin_mismatch' },
      { id: 'PIN-ENGINE-VERSION-MISMATCH', gamePin: { ...validPin, engineVersion: '0.2.0' }, result: 'game_pin_mismatch (the engineVersion must equal the kit\'s engineVersion field — 0.1.0; never a fabricated release version)' },
      { id: 'KIT-STALE-REHASH', gamePin: validPin, actualKit: { tamperedFile: 'packages/runtime/src/index.ts' }, result: 'kit_tampered (the re-hash runs BEFORE the pin comparison — a tampered kit is refused regardless of the pin)' },
      { id: 'KIT-LOCKFILE-HANDEDIT', gamePin: validPin, actualKit: { tamperedFile: 'package-lock.json' }, result: 'kit_lockfile_mismatch (stale pin / hand-edit — refused; a clean upgrade is the §2 explicit procedure)' },
      { id: 'SUPERSEDED-KIT', gamePin: { ...validPin, kitDigest: `sha256:${'1'.repeat(64)}` }, actualKit: { superseded: true }, result: 'game_pin_mismatch (the vendored kit is a different identity — the operator re-vendors the pinned kit or performs the explicit upgrade)' },
    ],
  };
}

function buildToolCases() {
  return {
    note: 'engine-kit/tools/game-build.mjs (distribution.md §6) — the ONLY build entry a game may document in game.json.buildEntry. Plain Node (node:* only — no new dependency). All paths from its own file location (import.meta.url) or explicit absolute arguments — never process.cwd().',
    steps: [
      { order: 1, step: 'resolve-paths', detail: 'kit root from import.meta.url; game dir from --game (absolute); derive data/build/template paths', failure: null },
      { order: 2, step: 'verify-kit', detail: 're-hash the vendored tree against kit.json (lockfileDigest + kitDigest + per-file on any digest mismatch)', failure: 'kit_tampered | kit_inventory_missing | kit_lockfile_mismatch' },
      { order: 3, step: 'verify-pin', detail: 'game.json.enginePin (engineVersion, kitDigest, lockfileDigest) vs the ACTUAL kit identity', failure: 'game_pin_mismatch' },
      { order: 4, step: 'install', detail: 'npm ci --prefix <kit> (lockfile-authoritative; registry or warm cache)', failure: 'kit_install_unavailable (structured — never a silent skip or partial install)' },
      { order: 5, step: 'build-engine', detail: 'npm run build --prefix <kit> = check-deps → check-boundaries → typecheck → build.mjs (the accepted pipeline)', failure: 'the pipeline step\'s own structured failure (boundary violation / forbidden runtime import / type error / build error) — no game output exists yet' },
      { order: 6, step: 'install-template', detail: 'verified copy of the kit templates/ set into <gameDataRoot>/templates/ (packet 65 identity)', failure: 'template_install_mismatch | template_content_mismatch' },
      { order: 7, step: 'export', detail: 'spawn the kit backend deployment bundle (game data root; THIRDLIGHT_ENGINE_ROOT=<kit>; admin token; loopback bind — all tool-derived) and call the accepted admin export route', failure: 'the accepted export error codes (content_quota_exceeded, content_publish_failed, …) unchanged' },
      { order: 8, step: 'verify-output', detail: 'the static closure exists under <game>/build/<projectId>@r<revision>/ with its metadata (export.md §4 shape)', failure: 'a structured export failure (the closure is absent or incomplete — never claimed built)' },
    ],
    rules: [
      { id: 'CWD-INDEPENDENCE', rule: 'run from /, from the game root and from the checkout → identical verified outputs (no process.cwd() anywhere in the tool; the engine build.mjs is invoked only via npm run build, where npm fixes the working directory to the kit root)', negative: 'a tool revision that reads process.cwd() for the kit root' },
      { id: 'SYMLINK-CONTAINMENT', rule: 'any symlink whose realpath leaves the game directory is rejected at assembly AND re-checked before every build', failure: 'kit_path_rejected' },
      { id: 'ABSOLUTE-CHECKOUT-PATH', rule: 'no functional path reference to the original checkout in the kit\'s GENERATED data (kit.json, NOTICE, game.json) or in the tool source; the docs/contracts/** copies may RECORD evidence paths (byte-identical engine source — the CCR-66-1 exemption; digests still bind)', failure: 'kit_path_rejected' },
      { id: 'SECRET-LICENSE-OMISSION', rule: 'no credentials/tokens/origin literals in kit data or tool source (the export.md §5.4 forbidden-content class applied to kit data); NOTICE is REQUIRED', failure: 'kit_path_rejected (content) | kit_notice_missing (absent NOTICE)' },
    ],
    negativeInventory: [
      { id: 'NEG-NODE-MODULES', inject: 'engine-kit/node_modules/anything', result: 'assembly refuses (node_modules is never a kit member — §4)' },
      { id: 'NEG-DIST', inject: 'engine-kit/dist/editor/main.js', result: 'assembly refuses (dist/ is a kit-local build output — excluded from the inventory)' },
      { id: 'NEG-GIT', inject: 'engine-kit/.git/HEAD', result: 'assembly refuses (the kit carries no VCS state — the identity is the digests, not a commit reference into the original repo)' },
      { id: 'NEG-FIXTURES', inject: 'engine-kit/fixtures/…', result: 'assembly refuses (fixtures are engine test data, not engine distribution)' },
      { id: 'NEG-SYMLINK-ESCAPE', inject: 'engine-kit/packages/link → /elsewhere/checkout/packages', result: 'kit_path_rejected (a directory symlink into the original checkout is NOT independent — m4-plan §2.3 table)' },
      { id: 'NEG-TAMPER', inject: 'a hand-edit to any inventory-listed kit file', result: 'kit_tampered (the re-hash before every build)' },
      { id: 'NEG-FLOATING-DEP', inject: 'an npm install (re-resolution) instead of npm ci', result: 'forbidden by the frozen install command — a transitive floating dependency cannot enter the kit install' },
      { id: 'NEG-REGISTRY-DOWN', inject: 'npm ci with no registry and no warm cache', result: 'kit_install_unavailable (documented, structured — the operator provides registry or cache; the build never proceeds on a partial install)' },
    ],
  };
}

// ---- output ------------------------------------------------------------------

const OUT = {
  'cases/kit-inventory.json': null,
  'cases/kit-identity.json': null,
  'cases/license-inventory.json': null,
  'cases/pin-cases.json': null,
  'cases/build-tool-cases.json': null,
  'index.json': null,
};

function main() {
  const { entries, kitDigest, lockDigest, kitJson, notice } = buildInventory();

  const data = {
    'cases/kit-inventory.json': {
      note: 'distribution.md §1 allowlist resolved against the live tree at 2026-09-22. src = the checkout-relative source path (the template set\'s src is the packet-65 fixture — its canonical source); kitPath = the in-kit path. classification: manifest | source | tooling | contracts | template | generated-data. Canonical ascending kitPath order.',
      fileCount: entries.length,
      files: entries,
    },
    'cases/kit-identity.json': {
      note: 'distribution.md §3 — the identity the kit assembler emits into kit.json and the checker re-derives. engineRef.kind is working-tree (this M4 baseline: the dirty M2/M3 tree — a commit alone cannot identify it).',
      identity: kitJson,
    },
    'cases/license-inventory.json': licenseInventory(),
    'cases/pin-cases.json': pinCases(kitDigest, lockDigest),
    'cases/build-tool-cases.json': buildToolCases(),
  };

  const files = Object.keys(data).sort();
  const buffers = new Map();
  for (const rel of files) {
    const abs = join(FIXTURES_DIR, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(data[rel], null, 2) + '\n', 'utf8');
    buffers.set(rel, bytes);
    if (CHECK) {
      const existing = readFileSync(abs);
      if (!existing.equals(bytes)) throw new Error(`--check: ${rel} differs`);
      console.log(`  check OK: ${rel}`);
    } else {
      writeFileSync(abs, bytes);
      console.log(`wrote ${rel} (${bytes.length} bytes)`);
    }
  }

  const index = {
    note: 'byte length + sha256 of every generated data file (UTF-8 byte lengths). Regenerate with the committed tool; verify with check-kit.mjs (independent re-derivation from the live tree).',
    files: files.map((rel) => ({ path: rel, byteLength: buffers.get(rel).length, sha256: sha256Bytes(buffers.get(rel)) })),
  };
  const indexBytes = Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf8');
  const indexAbs = join(FIXTURES_DIR, 'index.json');
  if (CHECK) {
    const existing = readFileSync(indexAbs);
    if (!existing.equals(indexBytes)) throw new Error('--check: index.json differs');
    console.log('  check OK: index.json');
  } else {
    writeFileSync(indexAbs, indexBytes);
    console.log(`wrote index.json (${indexBytes.length} bytes)`);
  }
  console.log(CHECK ? 'fixture set verified byte-identical' : `generated ${files.length + 1} fixture files under ${FIXTURES_DIR}`);
}

main();