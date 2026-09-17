#!/usr/bin/env node
/**
 * Thirdlight root typecheck (dependencies.md §5 check 5 — type-level
 * strictness).
 *
 * Runs the pinned TypeScript 5.9.3 `tsc --noEmit` over every implemented
 * workspace package's tsconfig (each extends the strict tsconfig.base.json —
 * decision 0001 §2/§3). Any type error ⇒ non-zero exit, tsc's own
 * `file(line,col): error TSxxxx` listing. The editor's TSX is typechecked
 * with the same tsc (jsx: react-jsx in the base config; decision 0001 §10 —
 * the esbuild TSX loader builds it, this is the typecheck plane).
 *
 * Plain Node, no new dependency. With no implemented packages yet (packet 04
 * state) there is nothing to typecheck — reported honestly, exit 0.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

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

let failed = false;
for (const name of pkgs) {
  const tsconfig = join(pkgsDir, name, 'tsconfig.json');
  if (!existsSync(tsconfig)) {
    console.error(
      `typecheck: packages/${name}/tsconfig.json missing — every package tsconfig ` +
        'must extend tsconfig.base.json (dependencies.md §5.5).',
    );
    failed = true;
    continue;
  }
  console.log(`typecheck: tsc --noEmit -p packages/${name}`);
  const r = spawnSync(
    process.execPath,
    [tscScript, '--noEmit', '-p', join('packages', name)],
    { cwd: root, stdio: 'inherit' },
  );
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);