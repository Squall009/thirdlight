#!/usr/bin/env node
/**
 * Thirdlight root typecheck (dependencies.md §5 check 5 — type-level
 * strictness).
 *
 * For every implemented workspace package (packages/<name>/package.json):
 *
 *   1. VALIDATES the package tsconfig (repaired per 04-review R7): it must
 *      extend the root `tsconfig.base.json` (directly or transitively — the
 *      extends chain is resolved explicitly) AND the EFFECTIVE compiler
 *      options (the TypeScript 5.9.3 config-resolution API, so per-package
 *      overrides are seen) must keep `strict: true`. A config that extends
 *      the base but sets `strict: false`, a standalone non-strict config, or
 *      a config that does not extend the base fails before tsc runs.
 *   2. runs the pinned TypeScript 5.9.3 `tsc --noEmit` over the package
 *      tsconfig. Any type error ⇒ non-zero exit, tsc's own
 *      `file(line,col): error TSxxxx` listing. The editor's TSX is
 *      typechecked with the same tsc (jsx: react-jsx in the base config;
 *      decision 0001 §10 — the esbuild TSX loader builds it, this is the
 *      typecheck plane).
 *
 * Uses the pinned `typescript` devDependency (dependencies.md §7) for config
 * resolution — no new dependency. With no implemented packages yet (packet
 * 04 state) there is nothing to typecheck — reported honestly, exit 0.
 *
 * Exit codes: 0 = all validated and tsc clean; 1 = validation or tsc
 * failure; 2 = environment error (pinned tsc not installed).
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import ts from 'typescript'; // pinned devDependency (dependencies.md §7)

const BASE_CONFIG = 'tsconfig.base.json';

/**
 * Resolve the `extends` chain of a tsconfig file (TS semantics: a relative
 * target is resolved against the containing file; a target without a
 * `.json` extension is retried with `.json`). Returns { files, error } —
 * `files` is the config file plus every extends target, in order.
 */
export function extendsChain(startPath) {
  const files = [startPath];
  const seen = new Set();
  let current = startPath;
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(current)) return { files, error: `extends cycle at '${current}'` };
    seen.add(current);
    const parsed = ts.readConfigFile(current, ts.sys.readFile);
    if (parsed.error || parsed.config === undefined || parsed.config === null) {
      return {
        files,
        error: `extends target '${current}' is not a readable JSON config`,
      };
    }
    const ext = parsed.config.extends;
    if (typeof ext !== 'string' || ext === '') break;
    if (!ext.startsWith('.')) {
      return {
        files,
        error: `extends value '${ext}' is not a relative path (package-name ` +
          'extends is not supported by this check; use a relative path to ' +
          `tsconfig.base.json)`,
      };
    }
    let candidate = resolve(dirname(current), ext);
    if (!existsSync(candidate) && !candidate.endsWith('.json')) {
      candidate = `${candidate}.json`;
    }
    if (!existsSync(candidate)) {
      return { files, error: `extends target '${ext}' not found (resolved: ${candidate})` };
    }
    files.push(candidate);
    current = candidate;
  }
  return { files, error: null };
}

/**
 * Validate one package tsconfig: it must extend the root tsconfig.base.json
 * (directly or transitively) and the effective compiler options must keep
 * `strict: true` (dependencies.md §5.5; decision 0001 §2/§3). Returns
 * violation strings (empty = OK).
 */
export function validatePackageTsconfig(root, pkgName) {
  const violations = [];
  const label = `packages/${pkgName}/tsconfig.json`;
  const tsconfigPath = join(root, 'packages', pkgName, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    violations.push(
      `${label} missing — every package tsconfig must extend tsconfig.base.json ` +
        '(dependencies.md §5.5).',
    );
    return violations;
  }
  // 1) required base inheritance (extends chain must include the root base).
  const base = resolve(root, BASE_CONFIG);
  const chain = extendsChain(tsconfigPath);
  if (chain.error) {
    violations.push(`${label}: ${chain.error}`);
    return violations;
  }
  if (!chain.files.includes(base)) {
    violations.push(
      `${label} does not extend tsconfig.base.json — per-package tsconfigs must ` +
        'extend the strict base (dependencies.md §5.5; chain: ' +
        chain.files.map((f) => f.replace(root, '.')).join(' → ') + ').'
    );
    return violations;
  }
  // 2) effective strictness (full TS config resolution, overrides included).
  const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (error) {
    violations.push(
      `${label}: invalid config — ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`,
    );
    return violations;
  }
  const host = {
    useCaseSensitiveFileNames: true,
    readDirectory: ts.sys.readDirectory,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
  };
  const parsed = ts.parseJsonConfigFileContent(config, host, dirname(tsconfigPath), undefined, tsconfigPath);
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors.slice(0, 3)) {
      violations.push(
        `${label}: ${ts.flattenDiagnosticMessageText(e.messageText, ' ')}`,
      );
    }
    return violations;
  }
  if (parsed.options.strict !== true) {
    violations.push(
      `${label}: effective \`strict\` is ${parsed.options.strict ?? 'unset'} — ` +
        'tsconfig.base.json requires strict: true and per-package configs must ' +
        'keep it (dependencies.md §5.5; decision 0001 §2/§3).',
    );
  }
  return violations;
}

function main() {
  const root = process.cwd();
  const tscScript = join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!existsSync(tscScript)) {
    console.error(
      'typecheck: pinned tsc not found at node_modules/typescript/lib/tsc.js — ' +
        'run `npm install` first (TypeScript 5.9.3, dependencies.md §7).',
    );
    process.exit(2);
  }

  const pkgsDir = join(root, 'packages');
  let entries = [];
  try {
    entries = readdirSync(pkgsDir, { withFileTypes: true });
  } catch {
    // no packages dir yet — nothing to typecheck (packet 04 state).
  }
  const pkgs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((n) => existsSync(join(pkgsDir, n, 'package.json')))
    .sort();

  if (pkgs.length === 0) {
    console.log(
      'typecheck: no implemented packages yet (units appear in packets 05–12, ' +
        'dependencies.md §2); nothing to typecheck.',
    );
    process.exit(0);
  }

  // 1) config validation: required base inheritance + effective strictness.
  let invalid = false;
  for (const name of pkgs) {
    for (const v of validatePackageTsconfig(root, name)) {
      console.error(`typecheck: FAIL — ${v}`);
      invalid = true;
    }
  }
  if (invalid) {
    console.error(
      'typecheck: FAIL — tsconfig validation errors (fix the configs; tsc was not run).',
    );
    process.exit(1);
  }

  // 2) tsc --noEmit per package (piped so the output is both shown here and
  //    capturable by the test suite).
  let failed = false;
  for (const name of pkgs) {
    console.log(`typecheck: tsc --noEmit -p packages/${name}`);
    const r = spawnSync(
      process.execPath,
      [tscScript, '--noEmit', '-p', join('packages', name)],
      { cwd: root, encoding: 'utf8' },
    );
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
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