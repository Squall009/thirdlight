#!/usr/bin/env node
/**
 * Thirdlight dependency pin check (dependencies.md §5 check 6).
 *
 * One root lockfile (npm, decision 0001 §3). Package `dependencies` use exact
 * pinned versions (no ranges) from the dependencies.md §7 table. This check:
 *
 *   1. runs `npm ls --depth=0 --json` and FAILS on npm execution or tree
 *      errors before anything else — a non-zero npm exit (e.g. ELSPROBLEMS:
 *      a package manifest added without `npm install`), any top-level
 *      `problems`/`error` record, and any missing/invalid tree entry
 *      (workspace packages INCLUDED — they are filtered only from the pin
 *      comparison, never from error reporting);
 *   2. compares every installed non-workspace package against the §7 pins —
 *      a version drift fails, and an installed package that is not a §7 pin
 *      at all fails (any addition is an owner-approved decision change —
 *      dependencies.md §9);
 *   3. checks every declared dependency spec (root + workspace packages,
 *      all dep sections) is an exact version — no `^`, `~`, ranges, `*`,
 *      `file:`, `workspace:` — and, for pinned names, equals the pin;
 *      workspace-internal deps must equal the target's current version.
 *
 * Pins not yet installed are NOT a failure: their consumer package is not
 * implemented yet (dependencies.md §2: the lockfile reflects only implemented
 * packages) — they are reported as pending.
 *
 * Plain Node, no new dependency. Any violation ⇒ non-zero exit.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** The approved M1 stack pins (dependencies.md §7; decision 0001 §3, incl. the 2026-09-17 React ruling). */
export const PINS = {
  typescript: '5.9.3',
  esbuild: '0.28.2',
  vitest: '5.0.1',
  ws: '8.21.3',
  three: '0.186.0',
  '@types/three': '0.186.0',
  '@modelcontextprotocol/sdk': '1.30.0',
  react: '19.3.0',
  'react-dom': '19.3.0',
  '@types/react': '19.3.0',
  '@types/react-dom': '19.3.0',
  '@dimforge/rapier2d-compat': '0.20.0',
  // Phase 23.0: the 3D backend, the same version as the 2D pin (decision 0005).
  '@dimforge/rapier3d-compat': '0.20.0',
  '@playwright/test': '1.62.1',
  'playwright-core': '1.62.1',
  '@types/node': '22.20.4',
  '@types/ws': '8.18.1',
  // Phase 16.3: the script editor (CodeMirror 6, editor bundle only; plan-phase-16 §6).
  '@codemirror/state': '6.7.6',
  '@codemirror/view': '6.43.13',
  '@codemirror/language': '6.12.4',
  '@codemirror/commands': '6.11.1',
  '@codemirror/autocomplete': '6.20.3',
  '@codemirror/lint': '6.9.7',
  '@codemirror/search': '6.7.2',
  '@codemirror/lang-javascript': '6.2.5',
  '@lezer/common': '1.5.3',
  '@lezer/highlight': '1.2.4',
  '@lezer/lr': '1.4.10',
  '@lezer/javascript': '1.5.5',
};

/** §7 scope/consumer notes for the pending-pin report. */
const PIN_CONSUMERS = {
  ws: 'backend (packet 09)',
  three: 'three-adapter (packet 08)',
  '@types/three': 'three-adapter, dev (packet 08)',
  '@modelcontextprotocol/sdk': 'mcp-adapter (packet 11)',
  react: 'editor (packet 10)',
  'react-dom': 'editor (packet 10)',
  '@types/react': 'editor, dev (packet 10)',
  '@types/react-dom': 'editor, dev (packet 10)',
  typescript: 'workspace (root dev)',
  esbuild: 'workspace build script (root dev) + exporter (packet 12)',
  vitest: 'workspace (root dev)',
  '@types/node': 'Node-side packages (backend, workspace, exporter, mcp-adapter), dev — replaces the hand-written ambient stubs (D21)',
  '@types/ws': 'backend, dev',
  '@codemirror/state': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@codemirror/view': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@codemirror/language': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@codemirror/commands': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@codemirror/autocomplete': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@codemirror/lint': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@codemirror/search': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@codemirror/lang-javascript': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@lezer/common': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@lezer/highlight': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@lezer/lr': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  '@lezer/javascript': 'editor (phase 16.3 script editor; never in the runtime/export bundle)',
  'playwright-core': 'backend (phase 11: the headless editor for MCP play; same version as @playwright/test)',
  '@dimforge/rapier2d-compat':
    'physics-rapier (packet 31) — the exact 0.20.0 pin (decision 0002 §1; dependencies.md §7); bundled by the preview/export graphs in packets 35/36',
  '@dimforge/rapier3d-compat':
    'physics-rapier ./3d (phase 23.0) — the exact 0.20.0 pin, the 2D pin\'s version (decision 0005); only in the separate physics-3d.js bundle a 3D project loads',
};

/** Exact semver string: no ^, ~, ranges, *, file:, workspace:, etc. */
const RE_EXACT = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

/**
 * Walk an `npm ls --depth=0 --json` tree; collect {name, version, where}
 * for registry packages. npm keys dependency entries by package name and the
 * entry objects carry `version`/`resolved`/`invalid` (no `name` field), so
 * the name comes from the key.
 */
export function collectInstalled(nodeLsJson) {
  const out = [];
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const SECTION_KEYS = new Set([
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
    'workspaceDependencies',
    'node_modules',
  ]);
  const isEntry = (v) =>
    isObj(v) &&
    (typeof v.version === 'string' ||
      typeof v.invalid === 'boolean' ||
      typeof v.missing === 'boolean' ||
      typeof v.resolved === 'string');
  const walkEntry = (o, where, name) => {
    if (
      name !== undefined &&
      (typeof o.version === 'string' || o.invalid === true || o.missing === true)
    ) {
      out.push({
        name,
        version: typeof o.version === 'string' ? o.version : '(invalid/missing)',
        where,
        invalid: Boolean(o.invalid) || Boolean(o.missing),
      });
    }
    for (const [k, v] of Object.entries(o)) {
      if (!isObj(v)) continue;
      if (SECTION_KEYS.has(k)) {
        for (const [k2, entry] of Object.entries(v)) {
          if (isObj(entry)) walkEntry(entry, where ? `${where}.${k}.${k2}` : `${k}.${k2}`, k2);
        }
      } else if (isEntry(v)) {
        walkEntry(v, where ? `${where}.${k}` : k, k);
      }
    }
  };
  walkEntry(nodeLsJson, '', undefined);
  return out.filter((e) => !e.name.startsWith('@thirdlight/'));
}

/**
 * Report npm tree health: top-level `problems`/`error` records and
 * missing/invalid entries — workspace packages INCLUDED (they are filtered
 * only from the pin comparison, never from error reporting; 04-review R6).
 */
export function collectTreeIssues(tree) {
  const issues = [];
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const SECTION_KEYS = new Set([
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
    'workspaceDependencies',
    'node_modules',
  ]);
  if (Array.isArray(tree.problems)) {
    for (const p of tree.problems) issues.push(`npm tree problem: ${String(p)}`);
  }
  if (isObj(tree.error)) {
    const parts = [tree.error.code ?? 'ERROR'];
    if (tree.error.summary) parts.push(`— ${tree.error.summary}`);
    if (tree.error.detail) parts.push(`(${tree.error.detail})`);
    issues.push(`npm tree error: ${parts.join(' ')}`);
  }
  const walkEntry = (o, where, name) => {
    if (name !== undefined) {
      if (o.missing === true) {
        issues.push(
          `missing npm tree entry: '${name}' at ${where || 'root'} (UNMET — the ` +
            `manifest exists but the workspace link/install is missing; run \`npm install\`)`,
        );
      } else if (o.invalid === true) {
        issues.push(
          `invalid npm tree entry: '${name}' at ${where || 'root'} (invalid per npm ls)`,
        );
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (!isObj(v)) continue;
      if (SECTION_KEYS.has(k)) {
        for (const [k2, entry] of Object.entries(v)) {
          if (isObj(entry)) walkEntry(entry, where ? `${where}.${k}.${k2}` : `${k}.${k2}`, k2);
        }
      } else if (
        typeof v.version === 'string' ||
        typeof v.invalid === 'boolean' ||
        typeof v.missing === 'boolean' ||
        typeof v.resolved === 'string'
      ) {
        walkEntry(v, where ? `${where}.${k}` : k, k);
      }
    }
  };
  walkEntry(tree, '', undefined);
  return issues;
}

/**
 * Check 6, steps 1+2: npm execution/tree health (before pin filtering), then
 * the pin comparison of the non-workspace installed tree. `ls`: the raw
 * `{ status, stdout, stderr }` of `npm ls --depth=0 --json`.
 */
export function checkInstalledTree(ls, pins = PINS) {
  const violations = [];
  if (ls.status !== 0) {
    const errs = (ls.stderr ?? '')
      .split('\n')
      .filter((l) => l.startsWith('npm ERR!'))
      .filter((l) => !l.includes('complete log') && !l.includes('debug-0.log'))
      .map((l) => l.replace(/^npm ERR!\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' | ');
    violations.push(
      `npm ls --depth=0 --json exited with status ${ls.status} — the workspace ` +
        'install is broken (a package manifest added without `npm install` is ' +
        `the typical cause; dependencies.md §2); npm said: ${errs || '(no npm ERR output)'}`,
    );
  }
  let tree = null;
  try {
    tree = JSON.parse(ls.stdout);
  } catch {
    if (ls.status === 0) {
      violations.push(
        'could not parse `npm ls --depth=0 --json` output as JSON (stdout head: ' +
          `${String(ls.stdout).slice(0, 200).trim() || '(empty)'})`,
      );
    }
    return { violations, installed: [], pending: Object.keys(pins).sort() };
  }
  // tree health (top-level problems/error records + missing/invalid entries,
  // workspace packages included) is reported once by collectTreeIssues;
  // the execution failure above is a distinct fact (npm's exit status).
  violations.push(...collectTreeIssues(tree));
  const installed = collectInstalled(tree);
  const cmp = compareInstalled(installed, pins);
  violations.push(...cmp.violations);
  return { violations, installed, pending: cmp.pending };
}

/** Compare installed packages against the §7 pins. */
export function compareInstalled(installed, pins = PINS) {
  const violations = [];
  const seen = new Map(); // name -> [versions]
  for (const { name, version, where } of installed) {
    if (name === 'thirdlight') continue;
    const list = seen.get(name) ?? [];
    list.push(version);
    seen.set(name, list);
    if (pins[name] && pins[name] !== version) {
      violations.push(
        `version drift: '${name}'@${version} installed at ${where || 'root'} but the dependencies.md §7 pin is ${name}@${pins[name]}`,
      );
    } else if (!pins[name]) {
      violations.push(
        `unpinned dependency: '${name}'@${version} at ${where || 'root'} is not in the dependencies.md §7 pin table — any addition is an owner-approved decision change (dependencies.md §9)`,
      );
    }
  }
  const pending = Object.keys(pins)
    .sort()
    .filter((n) => !seen.has(n));
  return { violations, pending, installed: Object.fromEntries(seen) };
}

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Check declared dependency specs for exact versions (no ranges) and pin
 * agreement. `pkgs`: [{ name, file, pkgJson, version }] including the root.
 */
export function checkDeclaredDeps(pkgs, pins = PINS) {
  const violations = [];
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  for (const p of pkgs) {
    for (const section of DEP_SECTIONS) {
      const deps = p.pkgJson[section] ?? {};
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string' || !RE_EXACT.test(spec)) {
          violations.push(
            `${p.file}: ${section} entry '${name}' uses '${spec}' — dependency versions must be exact (no ranges), dependencies.md §5.6`,
          );
          continue;
        }
        if (name.startsWith('@thirdlight/')) {
          const unit = byName.get(name);
          if (unit && unit.version !== spec) {
            violations.push(
              `${p.file}: ${section} entry '${name}'@${spec} — workspace dep must equal the target's current version ${unit.version} (exact versions, no ranges, dependencies.md §5.6)`,
            );
          }
          continue;
        }
        if (pins[name] && pins[name] !== spec) {
          violations.push(
            `${p.file}: ${section} entry '${name}'@${spec} — the dependencies.md §7 pin is ${name}@${pins[name]}`,
          );
        } else if (!pins[name]) {
          violations.push(
            `${p.file}: ${section} entry '${name}'@${spec} — not in the dependencies.md §7 pin table (any addition is an owner-approved decision change, dependencies.md §9)`,
          );
        }
      }
    }
  }
  return violations;
}

function readWorkspacePkgs(root) {
  const out = [];
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  out.push({
    name: rootPkg.name ?? '(root)',
    file: 'package.json',
    pkgJson: rootPkg,
    version: rootPkg.version,
  });
  const dir = join(root, 'packages');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const f = join(dir, e.name, 'package.json');
    if (!existsSync(f)) continue;
    const pkgJson = JSON.parse(readFileSync(f, 'utf8'));
    out.push({
      name: pkgJson.name ?? e.name,
      file: join('packages', e.name, 'package.json'),
      pkgJson,
      version: pkgJson.version,
    });
  }
  return out;
}

function main() {
  const root = process.cwd();

  // 1+2: npm execution/tree health, then installed tree vs pins.
  const ls = spawnSync('npm', ['ls', '--depth=0', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  const { violations, installed, pending } = checkInstalledTree(ls);

  // 3: declared exactness + pin agreement.
  violations.push(...checkDeclaredDeps(readWorkspacePkgs(root)));

  if (violations.length > 0) {
    console.error(`check-deps: FAIL — ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }

  console.log('check-deps: OK');
  console.log(`  installed (npm ls --depth=0, non-workspace):`);
  for (const e of installed) {
    if (e.name === 'thirdlight') continue;
    console.log(`    ${e.name} ${e.version} (= §7 pin)`);
  }
  if (pending.length > 0) {
    console.log(
      '  §7 pins not yet installed (consumer package not implemented — dependencies.md §2):',
    );
    for (const n of pending) {
      console.log(`    ${n}@${PINS[n]} — ${PIN_CONSUMERS[n] ?? 'dependencies.md §7'}`);
    }
  }
  console.log('  declared dependency specs: all exact versions (no ranges)');
}

// CLI guard — realpath-based, so it also works when the tool is invoked
// through a symlinked or relative path. (The naive
// `pathToFileURL(argv[1]) === import.meta.url` comparison silently skips
// main() for symlinked tool paths — a silent no-op check, the exact
// failure mode dependencies.md §9 forbids.)
function isMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}