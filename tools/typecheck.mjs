#!/usr/bin/env node
/**
 * Thirdlight root typecheck (type-level strictness).
 *
 * For every implemented workspace package (packages/<name>/package.json):
 *
 *   1. VALIDATES the package tsconfig: it must
 *      extend the root `tsconfig.base.json` (directly or transitively — the
 *      inheritance graph is resolved by TypeScript, including extends arrays)
 *      AND the EFFECTIVE compiler options must keep `strict: true`, all its
 *      sub-options, and declaration checking. Checking-disabling overrides
 *      and configs that do not extend the base fail before tsc runs.
 *   2. runs the pinned TypeScript 5.9.3 `tsc --noEmit` (incremental: its
 *      state per package in dist/.typecheck/) over the package tsconfig. Any type error ⇒ non-zero exit, tsc's own
 *      `file(line,col): error TSxxxx` listing. The editor's TSX is
 *      typechecked with the same tsc (jsx: react-jsx in the base config;
 *      the esbuild TSX loader builds it, this is the typecheck plane).
 *
 * Uses the pinned `typescript` devDependency for config
 * resolution — no new dependency. With no implemented packages there is
 * nothing to typecheck — reported honestly, exit 0.
 *
 * Exit codes: 0 = all validated and tsc clean; 1 = validation or tsc
 * failure; 2 = environment error (pinned tsc not installed).
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import process from 'node:process';
import ts from 'typescript'; // pinned devDependency

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
 * `strict: true` without disabling its sub-options or skipping checks.
 * Returns violation strings (empty = OK).
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

async function main() {
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
    // no packages dir yet — nothing to typecheck.
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
  //    capturable by the test suite). The packages are independent checks,
  //    and one at a time takes about two minutes: a few run at once,
  //    their output printed in package order.
  // The projects outside packages/ with their own tsconfig (the performance harness and its tests): typed
  // against the packages, so a package change that breaks them fails here, not at the next perf run.
  const projects = [...pkgs.map((name) => join('packages', name)), ...EXTRA_PROJECTS.filter((p) => existsSync(join(root, p, 'tsconfig.json')))];
  const runs = await runLimited(projects, TSC_PARALLEL, (project) => tscRun(tscScript, root, project));
  let failed = false;
  projects.forEach((project, i) => {
    const r = runs[i];
    console.log(`typecheck: tsc --noEmit -p ${project}`);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) failed = true;
  });
  process.exit(failed ? 1 : 0);
}

/** How many tsc processes run at once: each takes up to ~1 GB, and the gate runs under a memory cap. */
const TSC_PARALLEL = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

/** Typechecked like a package, though not one (each has a tsconfig that extends the base). */
const EXTRA_PROJECTS = ['tools/perf'];

function tscRun(tscScript, root, project) {
  return new Promise((done) => {
    // Incremental: tsc keeps each package's last check (file versions, dependency signatures, its
    // diagnostics) and re-checks only what changed since. The gate's typecheck usually runs on code a
    // build already checked, so it took a minute to repeat a clean result; an unchanged package now
    // costs seconds and its earlier errors are still reported. Kept under dist/ (build output, ignored).
    const info = join(root, 'dist', '.typecheck', `${project.replace(/^packages\//, '').replaceAll('/', '-')}.tsbuildinfo`);
    const child = spawn(process.execPath, [tscScript, '--noEmit', '--incremental', '--tsBuildInfoFile', info, '-p', project], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (e) => done({ status: 1, stdout, stderr: `${stderr}${e.message}\n` }));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

/** Map `items` through `run` with at most `limit` in flight; results in input order. */
async function runLimited(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// CLI guard — realpath-based, so it also works when the tool is invoked
// through a symlinked or relative path. (The naive
// `pathToFileURL(argv[1]) === import.meta.url` comparison silently skips
// main() for symlinked tool paths — a silent no-op check.)
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