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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tl-typecheck-'));
  roots.push(root); // Register immediately, including fixture setup/assertion failures.
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
    expect(vs.some((v) => v.includes('does-not-exist.json'))).toBe(true);
  });

  it('parses JSONC tsconfigs (comments allowed)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', {
      tsconfig: '{\n  // the strict base\n  "extends": "../../tsconfig.base.json",\n  "include": ["src"]\n}\n',
    });
    expect(validatePackageTsconfig(root, 'project-model')).toEqual([]);
  });

  it('resolves package-name, absolute, and extensionless bases using TS semantics', () => {
    const root = makeRoot();
    const preset = join(root, 'node_modules', 'strict-preset');
    mkdirSync(preset, { recursive: true });
    writeFileSync(join(preset, 'package.json'), JSON.stringify({ tsconfig: 'config.json' }));
    writeFileSync(join(preset, 'config.json'), JSON.stringify({ extends: join(root, 'tsconfig.base') }));
    addPkg(root, 'project-model', { tsconfig: { extends: 'strict-preset', include: ['src'] } });
    expect(validatePackageTsconfig(root, 'project-model')).toEqual([]);
  });

  it('merges array options by key: a later strict umbrella does not erase an earlier explicit override', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'weak.json'), JSON.stringify({ compilerOptions: { noImplicitAny: false } }));
    addPkg(root, 'project-model', { tsconfig: {
      extends: ['../../weak.json', '../../tsconfig.base.json'], include: ['src'],
    } });
    expect(validatePackageTsconfig(root, 'project-model')).toEqual([
      expect.stringContaining('effective `noImplicitAny` is false'),
    ]);
  });

  it('does not truncate inheritance deeper than sixteen configs', () => {
    const root = makeRoot();
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(root, `base${i}.json`), JSON.stringify({
        extends: i === 19 ? './tsconfig.base.json' : `./base${i + 1}.json`,
      }));
    }
    addPkg(root, 'project-model', { tsconfig: { extends: '../../base0.json', include: ['src'] } });
    expect(validatePackageTsconfig(root, 'project-model')).toEqual([]);
  });

  it.each([
    '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noCheck": "false" } }',
    '{ "extends": ["../../tsconfig.base.json", 42] }',
    '{ "extends": "../../tsconfig.base.json", BROKEN }',
  ])('rejects malformed config rather than trusting inheritance: %s', (tsconfig) => {
    const root = makeRoot();
    addPkg(root, 'project-model', { tsconfig });
    expect(validatePackageTsconfig(root, 'project-model').length).toBeGreaterThan(0);
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
    expect(extendsChain(a).error).toContain('Circularity');
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

  beforeEach(() => {
    root = makeRoot();
    // the pinned tsc resolves through the symlinked node_modules.
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  }, 60000);

  it('exits 1 (before tsc runs) when a package disables strict (the R7 repro)', () => {
    addPkg(root, 'project-model', {
      tsconfig: { ...EXTENDS_BASE, compilerOptions: { strict: false } },
      files: { 'src/index.ts': 'export function identity(value) { return value; }\n' },
    });
    const r = runTool();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('effective `strict` is false');
    expect(r.stderr).toContain('tsc was not run');
  }, 120000);

  it('exits 1 for a standalone non-strict config (no base inheritance)', () => {
    addPkg(root, 'project-model', {
      tsconfig: { compilerOptions: { strict: false, noEmit: true }, include: ['src'] },
      files: { 'src/index.ts': 'export const x = 1;\n' },
    });
    const r = runTool();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('does not extend tsconfig.base.json');
  }, 120000);

  it('exits 0 for a strict package that typechecks clean', () => {
    addPkg(root, 'project-model', {
      tsconfig: EXTENDS_BASE,
      files: { 'src/index.ts': 'export const x: number = 1;\n' },
    });
    const r = runTool();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('tsc --noEmit -p packages/project-model');
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
  }, 120000);

  it.each([
    ['noImplicitAny', false, 'export function identity(value) { return value; }', 'TS7006'],
    ['noCheck', true, 'export const broken: number = "not a number";', 'TS2322'],
    ['strictNullChecks', false, 'export const broken: number = null;', 'TS2322'],
  ])('rejects %s:%s even when the real compiler would silently pass', (option, value, source, diagnostic) => {
    addPkg(root, 'project-model', {
      tsconfig: { ...EXTENDS_BASE, compilerOptions: { [option]: value } },
      files: { 'src/index.ts': source },
    });
    const unchecked = spawnSync(process.execPath, [
      join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'),
      '--noEmit', '-p', 'packages/project-model',
    ], { cwd: root, encoding: 'utf8', timeout: 120000 });
    expect(unchecked.status, unchecked.stdout + unchecked.stderr).toBe(0);
    const rejected = runTool();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(`effective \`${option}\` is ${value}`);
    expect(rejected.stderr).toContain('tsc was not run');

    // Same source, checks restored: the wrapper really runs pinned tsc.
    addPkg(root, 'project-model', { tsconfig: EXTENDS_BASE });
    const checked = runTool();
    expect(checked.status).toBe(1);
    expect(checked.stdout + checked.stderr).toContain(diagnostic);
  }, 120000);

  it.each([
    ['strictFunctionTypes', false], ['strictBindCallApply', false],
    ['strictPropertyInitialization', false], ['strictBuiltinIteratorReturn', false],
    ['noImplicitThis', false], ['useUnknownInCatchVariables', false], ['alwaysStrict', false],
    ['skipLibCheck', true], ['skipDefaultLibCheck', true],
  ])('rejects inherited %s:%s with strict:true intact', (option, value) => {
    writeFileSync(join(root, 'weakened.json'), JSON.stringify({
      extends: './tsconfig.base.json', compilerOptions: { [option]: value },
    }));
    addPkg(root, 'project-model', { tsconfig: {
      extends: '../../weakened.json', include: ['src'],
    } });
    const r = runTool();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`effective \`${option}\` is ${value}`);
    expect(r.stderr).toContain('tsc was not run');
  }, 120000);

  it.each([false, true])('honors extends array order, including repeated diamond ancestry (weak last: %s)', (weakLast) => {
    writeFileSync(join(root, 'weak.json'), JSON.stringify({
      extends: './tsconfig.base.json', compilerOptions: { noImplicitAny: false },
    }));
    writeFileSync(join(root, 'strong.json'), JSON.stringify({
      extends: './tsconfig.base.json', compilerOptions: { noImplicitAny: true },
    }));
    const bases = ['../../weak.json', '../../strong.json'];
    addPkg(root, 'project-model', { tsconfig: {
      extends: weakLast ? bases.reverse() : bases, include: ['src'],
    } });
    const r = runTool();
    expect(r.status, r.stdout + r.stderr).toBe(weakLast ? 1 : 0);
    if (weakLast) expect(r.stderr).toContain('effective `noImplicitAny` is false');
    else expect(r.stdout).toContain('tsc --noEmit -p packages/project-model');
  }, 120000);

  it('accepts direct extends arrays and a package override restoring inherited checks', () => {
    writeFileSync(join(root, 'weak.json'), JSON.stringify({ compilerOptions: { noCheck: true } }));
    addPkg(root, 'project-model', { tsconfig: {
      extends: ['../../tsconfig.base.json', '../../weak.json'],
      compilerOptions: { noCheck: false }, include: ['src'],
    } });
    const r = runTool();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('tsc --noEmit -p packages/project-model');
  }, 120000);

  it('rejects an extends array when the required root base file is missing', () => {
    rmSync(join(root, 'tsconfig.base.json'));
    addPkg(root, 'project-model', { tsconfig: {
      extends: ['../../tsconfig.base.json'], compilerOptions: { strict: true }, include: ['src'],
    } });
    const r = runTool();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tsconfig.base.json');
    expect(r.stderr).toContain('tsc was not run');
  }, 120000);

  it.each(['missing', 'unrelated', 'cycle'])('rejects invalid extends arrays: %s base', (kind) => {
    writeFileSync(join(root, 'unrelated.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, 'cycle.json'), JSON.stringify({
      extends: ['./tsconfig.base.json', './cycle.json'],
    }));
    const bases = kind === 'unrelated'
      ? ['../../unrelated.json']
      : ['../../tsconfig.base.json', `../../${kind}.json`];
    addPkg(root, 'project-model', { tsconfig: { extends: bases, include: ['src'] } });
    const r = runTool();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(kind === 'unrelated' ? 'does not extend tsconfig.base.json' : `${kind}.json`);
    expect(r.stderr).toContain('tsc was not run');
  }, 120000);
});