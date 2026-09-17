#!/usr/bin/env node
/**
 * Thirdlight dependency pin check (dependencies.md §5 check 6).
 *
 * One root lockfile (npm, decision 0001 §3). Package `dependencies` use exact
 * pinned versions (no ranges) from the dependencies.md §7 table. This check:
 *
 *   1. runs `npm ls --depth=0 --json` and compares every installed
 *      non-workspace package against the §7 pins — a version drift fails, and
 *      an installed package that is not a §7 pin at all fails (any addition
 *      is an owner-approved decision change — dependencies.md §9);
 *   2. fails on any invalid/UNMET entry in the npm tree;
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const violations = [];

  // 1+2: installed tree vs pins.
  const ls = spawnSync('npm', ['ls', '--depth=0', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  let tree;
  try {
    tree = JSON.parse(ls.stdout);
  } catch {
    violations.push(
      `could not parse \`npm ls --depth=0 --json\` (npm exit ${ls.status}; stderr: ${ls.stderr?.trim() || '(empty)'})`,
    );
    finish(violations);
    return;
  }
  const installed = collectInstalled(tree);
  const { violations: drift, pending } = compareInstalled(installed);
  violations.push(...drift);
  for (const e of installed) {
    if (e.invalid) {
      violations.push(
        `invalid npm tree entry: '${e.name}'@${e.version} at ${e.where || 'root'} (UNMET/invalid per npm ls)`,
      );
    }
  }

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

  function finish(vs) {
    console.error(`check-deps: FAIL — ${vs.length} violation(s):`);
    for (const v of vs) console.error(`  ${v}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}