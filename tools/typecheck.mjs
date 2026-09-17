#!/usr/bin/env node
/**
 * Thirdlight root typecheck (dependencies.md §5 check 5 — type-level
 * strictness).
 *
 * For every implemented workspace package (packages/<name>/package.json):
 *
 *   1. VALIDATES the package tsconfig (repaired per 04-review R7): it must
 *      extend the root `tsconfig.base.json` (directly or transitively — the
 *      inheritance graph is resolved by TypeScript, including extends arrays)
 *      AND the EFFECTIVE compiler options must keep `strict: true`, all its
 *      sub-options, and declaration checking. Checking-disabling overrides
 *      and configs that do not extend the base fail before tsc runs.
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

// All strictFlag options in pinned TypeScript 5.9.3. Unset sub-options inherit
// `strict`; use the public parser API rather than internal option helpers.
const STRICT_OPTIONS = [
  'noImplicitAny', 'noImplicitThis', 'strictNullChecks', 'strictFunctionTypes',
  'strictBindCallApply', 'strictPropertyInitialization',
  'strictBuiltinIteratorReturn', 'useUnknownInCatchVariables', 'alwaysStrict',
];
const SKIP_CHECK_OPTIONS = ['noCheck', 'skipLibCheck', 'skipDefaultLibCheck'];

function parseConfig(startPath) {
  const path = resolve(startPath);
  const source = ts.readJsonConfigFile(path, ts.sys.readFile);
  const parsed = ts.parseJsonSourceFileConfigFileContent(
    source, ts.sys, dirname(path), undefined, path,
  );
  // TsConfigSourceFile.extendedSourceFiles is public in 5.9.3's .d.ts.
  // TS handles arrays (later bases win), package/absolute paths, diamonds,
  // missing bases, and cycles; no parallel hand-written resolution rules.
  return { parsed, files: [path, ...(source.extendedSourceFiles ?? [])] };
}

/** Config file plus its inherited files, using the same parser as validation. */
export function extendsChain(startPath) {
  const { parsed, files } = parseConfig(startPath);
  return {
    files,
    error: parsed.errors.length
      ? parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).join('; ')
      : null,
  };
}

/**
 * Validate one package tsconfig: it must extend the root tsconfig.base.json
 * (directly or transitively) and the effective compiler options must keep
 * `strict: true` without disabling its sub-options or skipping checks
 * (dependencies.md §5.5; decision 0001 §2/§3). Returns
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
  const { parsed, files } = parseConfig(tsconfigPath);
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors.slice(0, 3)) {
      violations.push(`${label}: ${ts.flattenDiagnosticMessageText(e.messageText, ' ')}`);
    }
    return violations;
  }
  if (!files.includes(base)) {
    violations.push(
      `${label} does not extend tsconfig.base.json — per-package tsconfigs must ` +
        'extend the strict base (dependencies.md §5.5; chain: ' +
        files.map((f) => f.replace(root, '.')).join(' → ') + ').'
    );
    return violations;
  }
  // 2) effective strictness (full TS config resolution, overrides included).
  if (parsed.options.strict !== true) {
    violations.push(
      `${label}: effective \`strict\` is ${parsed.options.strict ?? 'unset'} — ` +
        'tsconfig.base.json requires strict: true and per-package configs must ' +
        'keep it (dependencies.md §5.5; decision 0001 §2/§3).',
    );
  } else {
    for (const option of STRICT_OPTIONS) {
      if ((parsed.options[option] ?? parsed.options.strict) !== true) {
        violations.push(`${label}: effective \`${option}\` is false — strict sub-options must stay enabled.`);
      }
    }
  }
  for (const option of SKIP_CHECK_OPTIONS) {
    if (parsed.options[option] === true) {
      violations.push(`${label}: effective \`${option}\` is true — skipping type checks is not allowed.`);
    }
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