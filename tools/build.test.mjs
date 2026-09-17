/**
 * Check tool test suite — build prerequisite chain (04-review R1).
 *
 * dependencies.md §5: the boundary checks are machine-enforced and FAIL THE
 * BUILD. `npm run build` runs check 6 (check-deps), check 1
 * (check-boundaries), and check 5 (typecheck) before the esbuild step; a
 * failure in any of them must prevent bundle emission.
 *
 * These tests run the real `npm run build` in a disposable workspace: a copy
 * of the root manifests + lockfile + node_modules, the real tools/, and a
 * disposable `editor` package providing the two §4.2 bundle entries
 * (the entries the build script skips while packet 10 is pending).
 *
 * Environment note (verified on this host, npm 9.2.0): when npm ADDS a
 * workspace package to an EXISTING lockfile, the `packages/<path>` entry is
 * written WITHOUT the `name` field (a fresh lockfile includes it), and
 * `npm ls` then reports the workspace link as invalid (ELSPROBLEMS) until
 * the entry carries the name. The fixture pre-seeds the lockfile entry with
 * the `name` field — the exact shape npm writes for a fresh lockfile — so
 * the disposable tree is healthy for the reason-under-test. Future packets
 * that add a unit to the real lockfile must verify the entry includes
 * `name` (the R6 check-deps fails loudly otherwise); recorded in handoff 04.
 *
 * The workspace package is linked with `npm install` first so the npm tree
 * is healthy (a broken tree would fail for the R6 reason, not the reason
 * under test).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDITOR = join('packages', 'editor');

let root;

const CLEAN_INDEX = 'export const app = 1;\n';
const CLEAN_PREVIEW = 'export const preview = 2;\n';

function setEntries(kind) {
  const src = join(root, EDITOR, 'src');
  const index = join(src, 'index.tsx');
  const preview = join(src, 'preview', 'preview-bootstrap.ts');
  switch (kind) {
    case 'clean':
      writeFileSync(index, CLEAN_INDEX);
      writeFileSync(preview, CLEAN_PREVIEW);
      break;
    case 'boundaries':
      // editor may not import Node builtins (dependencies.md §4.1).
      writeFileSync(index, "import fs from 'fs';\nexport const app = fs;\n");
      writeFileSync(preview, CLEAN_PREVIEW);
      break;
    case 'typecheck':
      // implicit any — fails tsc under the strict base.
      writeFileSync(index, 'export function identity(value) {\n  return value;\n}\n');
      writeFileSync(preview, CLEAN_PREVIEW);
      break;
    default:
      throw new Error(`unknown entry kind: ${kind}`);
  }
}

function build() {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  return spawnSync('npm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
  });
}

/** `npm run` forwards the child scripts' output to stderr — check both. */
const out = (r) => `${r.stdout}\n${r.stderr}`;

describe('R1 — checks 1/5/6 are build prerequisites (04-review R1)', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tl-build-'));
    cpSync(join(REPO, 'package.json'), join(root, 'package.json'));
    cpSync(join(REPO, 'package-lock.json'), join(root, 'package-lock.json'));
    cpSync(join(REPO, 'tsconfig.base.json'), join(root, 'tsconfig.base.json'));
    cpSync(join(REPO, 'node_modules'), join(root, 'node_modules'), { recursive: true });
    // Drop the stale hidden lockfile of the copied install: it predates the
    // disposable workspace package and makes `npm ls` report the fresh
    // workspace link as invalid (ELSPROBLEMS).
    rmSync(join(root, 'node_modules', '.package-lock.json'), { force: true });
    symlinkSync(join(REPO, 'tools'), join(root, 'tools'));
    // Disposable editor package with the two bundle entries.
    mkdirSync(join(root, EDITOR, 'src', 'preview'), { recursive: true });
    writeFileSync(
      join(root, EDITOR, 'package.json'),
      JSON.stringify(
        {
          name: '@thirdlight/editor',
          version: '0.0.0',
          private: true,
          exports: { '.': './src/index.tsx' },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(root, EDITOR, 'tsconfig.json'),
      JSON.stringify({ extends: '../../tsconfig.base.json', include: ['src'] }, null, 2),
    );
    setEntries('clean');
    // Pre-seed the lockfile workspace entries WITH the `name` field (the
    // npm 9.2.0 existing-lockfile quirk described above) so that the
    // `npm install` below links a healthy tree.
    const lockPath = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages[join('packages', 'editor')] = {
      name: '@thirdlight/editor',
      version: '0.0.0',
    };
    lock.packages['node_modules/@thirdlight/editor'] = {
      resolved: 'packages/editor',
      link: true,
    };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    // Link the workspace package so `npm ls` is healthy (R6 territory).
    const inst = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 300000,
    });
    if (inst.status !== 0) {
      throw new Error(`disposable workspace npm install failed: ${inst.stdout}\n${inst.stderr}`);
    }
  }, 300000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('runs checks 6/1/5 and emits both bundles when they all pass', () => {
    setEntries('clean');
    const r = build();
    expect(r.status, out(r)).toBe(0);
    expect(out(r)).toContain('check-deps: OK');
    expect(out(r)).toContain('check-boundaries: OK');
    expect(out(r)).toContain('tsc --noEmit -p packages/editor');
    expect(out(r)).toContain('build: done (2 built, 0 skipped)');
    expect(existsSync(join(root, 'dist', 'editor', 'main.js'))).toBe(true);
    expect(existsSync(join(root, 'dist', 'preview', 'preview.js'))).toBe(true);
  }, 180000);

  it('a check-deps failure (declared pin drift) prevents bundle emission', () => {
    setEntries('clean');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    pkg.devDependencies.typescript = '5.9.2'; // the §7 pin is 5.9.3
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const r = build();
    expect(r.status).not.toBe(0);
    expect(out(r)).toContain('check-deps: FAIL');
    expect(out(r)).toContain('5.9.2');
    expect(out(r)).not.toContain('build: done (2 built');
    expect(existsSync(join(root, 'dist', 'editor', 'main.js'))).toBe(false);
    expect(existsSync(join(root, 'dist', 'preview', 'preview.js'))).toBe(false);
    pkg.devDependencies.typescript = '5.9.3'; // restore the exact pin
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  }, 180000);

  it('a check-boundaries failure prevents bundle emission', () => {
    setEntries('boundaries');
    const r = build();
    expect(r.status).not.toBe(0);
    expect(out(r)).toContain('check-boundaries: FAIL');
    expect(out(r)).toContain('node-builtin-forbidden');
    expect(existsSync(join(root, 'dist', 'editor', 'main.js'))).toBe(false);
    expect(existsSync(join(root, 'dist', 'preview', 'preview.js'))).toBe(false);
  }, 180000);

  it('a typecheck failure prevents bundle emission', () => {
    setEntries('typecheck');
    const r = build();
    expect(r.status).not.toBe(0);
    expect(out(r)).toContain('TS7006');
    expect(existsSync(join(root, 'dist', 'editor', 'main.js'))).toBe(false);
    expect(existsSync(join(root, 'dist', 'preview', 'preview.js'))).toBe(false);
  }, 180000);
});