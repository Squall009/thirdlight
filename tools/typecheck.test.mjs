/**
 * Check tool test suite — root typecheck (dependencies.md §5 check 5;
 * 04-review R7: required base inheritance + effective strictness).
 *
 * The config-validation tests run `validatePackageTsconfig` / `extendsChain`
 * directly against temporary workspaces (no tsc needed). The CLI regression
 * tests spawn the real tools/typecheck.mjs in a temporary workspace
 * (node_modules symlinked so the pinned tsc resolves) and assert on the
 * actual exit codes — including that a strictness-disabled config fails
 * before tsc runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validatePackageTsconfig, extendsChain } from './typecheck.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(REPO, 'tools', 'typecheck.mjs');

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tl-typecheck-'));
  mkdirSync(join(root, 'packages'), { recursive: true });
  cpSync(join(REPO, 'tsconfig.base.json'), join(root, 'tsconfig.base.json'));
  return root;
}

/** Create a fixture package; `tsconfig` may be an object or raw JSONC text.
 *  A placeholder source file is always present so the package tsconfig has
 *  real inputs (TS18003 "No inputs" is a genuine config failure). */
function addPkg(root, name, { tsconfig, files = {} } = {}) {
  const dir = join(root, 'packages', name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@thirdlight/${name}`, version: '0.0.0', private: true }, null, 2),
  );
  if (tsconfig !== undefined) {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      typeof tsconfig === 'string' ? tsconfig : JSON.stringify(tsconfig, null, 2),
    );
  }
  const all = { 'src/placeholder.ts': 'export const placeholder = true;\n', ...files };
  for (const [rel, content] of Object.entries(all)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const EXTENDS_BASE = { extends: '../../tsconfig.base.json', include: ['src'] };

describe('R7 — tsconfig validation: base inheritance + effective strictness', () => {
  it('passes a tsconfig that extends the strict base (no override)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', { tsconfig: EXTENDS_BASE });
    expect(validatePackageTsconfig(root, 'project-model')).toEqual([]);
  });

  it('fails a tsconfig that extends the base but sets strict:false (the R7 repro)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', {
      tsconfig: { ...EXTENDS_BASE, compilerOptions: { strict: false } },
    });
    const vs = validatePackageTsconfig(root, 'project-model');
    expect(vs).toHaveLength(1);
    expect(vs[0]).toContain('strict');
    expect(vs[0]).toContain('false');
    expect(vs[0]).toContain('tsconfig.base.json');
  });

  it('fails a standalone non-strict config (no extends at all)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', {
      tsconfig: { compilerOptions: { strict: false, noEmit: true }, include: ['src'] },
    });
    const vs = validatePackageTsconfig(root, 'project-model');
    expect(vs.some((v) => v.includes('does not extend tsconfig.base.json'))).toBe(true);
  });

  it('passes a tsconfig that re-asserts strict:true explicitly', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', {
      tsconfig: { ...EXTENDS_BASE, compilerOptions: { strict: true } },
    });
    expect(validatePackageTsconfig(root, 'project-model')).toEqual([]);
  });

  it('accepts transitive inheritance (extends an intermediate base that extends the root base)', () => {
    const root = makeRoot();
    const mid = join(root, 'tsconfig.mid.json');
    writeFileSync(mid, JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: {} }));
    addPkg(root, 'project-model', { tsconfig: { extends: '../../tsconfig.mid.json', include: ['src'] } });
    expect(validatePackageTsconfig(root, 'project-model')).toEqual([]);
  });

  it('rejects an intermediate base that does not reach the root base', () => {
    const root = makeRoot();
    const mid = join(root, 'tsconfig.mid.json');
    writeFileSync(mid, JSON.stringify({ compilerOptions: { strict: true } }));
    addPkg(root, 'project-model', { tsconfig: { extends: '../../tsconfig.mid.json', include: ['src'] } });
    const vs = validatePackageTsconfig(root, 'project-model');
    expect(vs.some((v) => v.includes('does not extend tsconfig.base.json'))).toBe(true);
  });

  it('fails a missing package tsconfig', () => {
    const root = makeRoot();
    addPkg(root, 'project-model');
    const vs = validatePackageTsconfig(root, 'project-model');
    expect(vs).toHaveLength(1);
    expect(vs[0]).toContain('missing');
  });

  it('fails an extends target that does not exist', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', { tsconfig: { extends: '../../does-not-exist.json', include: ['src'] } });
    const vs = validatePackageTsconfig(root, 'project-model');
    expect(vs.some((v) => v.includes('not found'))).toBe(true);
  });

  it('parses JSONC tsconfigs (comments allowed)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', {
      tsconfig: '{\n  // the strict base\n  "extends": "../../tsconfig.base.json",\n  "include": ["src"]\n}\n',
    });
    expect(validatePackageTsconfig(root, 'project-model')).toEqual([]);
  });

  it('extendsChain resolves the chain in order and detects cycles', () => {
    const root = makeRoot();
    const dir = addPkg(root, 'project-model', { tsconfig: EXTENDS_BASE });
    const chain = extendsChain(join(dir, 'tsconfig.json'));
    expect(chain.error).toBeNull();
    expect(chain.files).toEqual([
      join(dir, 'tsconfig.json'),
      join(root, 'tsconfig.base.json'),
    ]);
    // cycle: A extends B extends A
    const a = join(root, 'a.json');
    const b = join(root, 'b.json');
    writeFileSync(a, JSON.stringify({ extends: './b.json' }));
    writeFileSync(b, JSON.stringify({ extends: './a.json' }));
    expect(extendsChain(a).error).toContain('cycle');
  });
});

describe('R7 — CLI regression (spawn the real tool)', () => {
  let root;
  const runTool = () =>
    spawnSync(process.execPath, [TOOL], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    });

  beforeAll(() => {
    root = makeRoot();
    // the pinned tsc resolves through the symlinked node_modules.
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  }, 60000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 1 (before tsc runs) when a package disables strict (the R7 repro)', () => {
    addPkg(root, 'project-model', {
      tsconfig: { ...EXTENDS_BASE, compilerOptions: { strict: false } },
      files: { 'src/index.ts': 'export function identity(value) { return value; }\n' },
    });
    const r = runTool();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('effective `strict` is false');
    expect(r.stderr).toContain('tsc was not run');
    rmSync(join(root, 'packages', 'project-model'), { recursive: true, force: true });
  }, 120000);

  it('exits 1 for a standalone non-strict config (no base inheritance)', () => {
    addPkg(root, 'project-model', {
      tsconfig: { compilerOptions: { strict: false, noEmit: true }, include: ['src'] },
      files: { 'src/index.ts': 'export const x = 1;\n' },
    });
    const r = runTool();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not extend tsconfig.base.json');
    rmSync(join(root, 'packages', 'project-model'), { recursive: true, force: true });
  }, 120000);

  it('exits 0 for a strict package that typechecks clean', () => {
    addPkg(root, 'project-model', {
      tsconfig: EXTENDS_BASE,
      files: { 'src/index.ts': 'export const x: number = 1;\n' },
    });
    const r = runTool();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('tsc --noEmit -p packages/project-model');
    rmSync(join(root, 'packages', 'project-model'), { recursive: true, force: true });
  }, 120000);

  it('exits 1 on a real type error under the strict base (tsc plane still enforced)', () => {
    addPkg(root, 'project-model', {
      tsconfig: EXTENDS_BASE,
      files: { 'src/index.ts': 'export function identity(value) { return value; }\n' },
    });
    const r = runTool();
    expect(r.status).toBe(1);
    // tsc prints diagnostics to stdout; the tool forwards them.
    expect(`${r.stdout}\n${r.stderr}`).toContain('TS7006');
    rmSync(join(root, 'packages', 'project-model'), { recursive: true, force: true });
  }, 120000);
});