/**
 * Check tool test suite — dependency pin check (dependencies.md §5 check 6):
 * pin drift, unpinned dependencies, and declared-range detection.
 */

import { describe, it, expect } from 'vitest';
import {
  compareInstalled,
  checkDeclaredDeps,
  checkInstalledTree,
  collectTreeIssues,
  PINS,
  collectInstalled,
} from './check-deps.mjs';

describe('check 6 — dependency pinning (dependencies.md §5.6)', () => {
  it('accepts the exact §7 pins and reports the rest as pending', () => {
    const installed = [
      { name: 'typescript', version: '5.9.3', where: 'dependencies.typescript' },
      { name: 'esbuild', version: '0.28.2', where: 'dependencies.esbuild' },
      { name: 'vitest', version: '5.0.1', where: 'dependencies.vitest' },
    ];
    const r = compareInstalled(installed);
    expect(r.violations).toEqual([]);
    expect(r.pending).toEqual(
      expect.arrayContaining([
        'three',
        'ws',
        'react',
        'react-dom',
        '@modelcontextprotocol/sdk',
      ]),
    );
    expect(r.pending).not.toContain('typescript');
  });

  it('fails on a version drift against a §7 pin', () => {
    const r = compareInstalled([
      { name: 'esbuild', version: '0.28.3', where: 'dependencies.esbuild' },
    ]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain('esbuild');
    expect(r.violations[0]).toContain('0.28.3');
    expect(r.violations[0]).toContain('0.28.2');
  });

  it('fails on an installed package that is not a §7 pin (no silent additions)', () => {
    const r = compareInstalled([
      { name: 'left-pad', version: '1.0.0', where: 'dependencies.left-pad' },
    ]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain('unpinned dependency');
    expect(r.violations[0]).toContain('left-pad');
  });

  it('collectInstalled walks the npm ls tree and drops workspace packages', () => {
    const tree = {
      name: 'thirdlight',
      version: '0.0.0',
      dependencies: {
        typescript: { version: '5.9.3', resolved: 'https://example/typescript.tgz' },
        '@thirdlight/project-model': { version: '0.0.0' },
      },
    };
    const c = collectInstalled(tree);
    expect(c.map((e) => e.name)).toEqual(['typescript']);
    expect(c[0].version).toBe('5.9.3');
  });

  it('declared deps: exact versions pass', () => {
    const vs = checkDeclaredDeps([
      { name: 'thirdlight', file: 'package.json', version: '0.0.0', pkgJson: { devDependencies: { typescript: '5.9.3' } } },
      { name: '@thirdlight/backend', file: 'packages/backend/package.json', version: '0.0.0', pkgJson: { dependencies: { ws: '8.21.3' } } },
    ]);
    expect(vs).toEqual([]);
  });

  it('declared deps: ranges (caret/tilde/star/file) fail — exact versions only', () => {
    const vs = checkDeclaredDeps([
      {
        name: 'thirdlight',
        file: 'package.json',
        version: '0.0.0',
        pkgJson: {
          devDependencies: { typescript: '^5.9.3', esbuild: '~0.28.2', vitest: '*' },
          dependencies: { 'file-dep': 'file:../dep' },
        },
      },
    ]);
    expect(vs).toHaveLength(4);
    expect(vs.join('\n')).toContain('no ranges');
  });

  it('declared deps: a wrong exact version fails against the §7 pin', () => {
    const vs = checkDeclaredDeps([
      {
        name: 'thirdlight',
        file: 'package.json',
        version: '0.0.0',
        pkgJson: { devDependencies: { typescript: '5.9.2' } },
      },
    ]);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toContain('5.9.2');
    expect(vs[0]).toContain('5.9.3');
  });

  it('declared deps: a workspace-internal dep must equal the target version', () => {
    const vs = checkDeclaredDeps([
      { name: 'thirdlight', file: 'package.json', version: '0.0.0', pkgJson: {} },
      { name: '@thirdlight/project-model', file: 'packages/project-model/package.json', version: '0.0.0', pkgJson: {} },
      {
        name: '@thirdlight/commands',
        file: 'packages/commands/package.json',
        version: '0.0.0',
        pkgJson: { dependencies: { '@thirdlight/project-model': '0.0.1' } },
      },
    ]);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toContain('@thirdlight/project-model');
    expect(vs[0]).toContain('0.0.1');
  });

  it('the §7 pin table carries every approved stack item', () => {
    expect(PINS).toEqual({
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
      '@playwright/test': '1.62.1',
      'playwright-core': '1.62.1',
      '@types/node': '22.20.4',
      '@types/ws': '8.18.1',
      // Phase 16.3: the script editor (CodeMirror 6).
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
    });
  });
});

describe('R6 — npm execution/tree errors fail before pin comparison (04-review R6)', () => {
  /** The real `npm ls --depth=0 --json` shape from the R6 repro: a package
   *  manifest added after `npm ci` without installing the workspace link. */
  const brokenTree = {
    version: '0.0.0',
    name: 'thirdlight',
    problems: [
      'missing: @thirdlight/project-model@file:/tmp/x/packages/project-model, required by thirdlight@0.0.0',
    ],
    dependencies: {
      '@thirdlight/project-model': {
        required: 'file:/tmp/x/packages/project-model',
        missing: true,
        problems: [
          'missing: @thirdlight/project-model@file:/tmp/x/packages/project-model, required by thirdlight@0.0.0',
        ],
      },
      esbuild: { version: '0.28.2', resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz', overridden: false },
      typescript: { version: '5.9.3', resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz', overridden: false },
      vitest: { version: '5.0.1', resolved: 'https://registry.npmjs.org/vitest/-/vitest-5.0.1.tgz', overridden: false },
    },
    error: {
      code: 'ELSPROBLEMS',
      summary: 'missing: @thirdlight/project-model@file:/tmp/x/packages/project-model, required by thirdlight@0.0.0',
      detail: '',
    },
  };

  it('fails on a non-zero npm ls exit with a missing workspace link (the R6 repro)', () => {
    const r = checkInstalledTree({
      status: 1,
      stdout: JSON.stringify(brokenTree),
      stderr:
        'npm ERR! code ELSPROBLEMS\nnpm ERR! missing: @thirdlight/project-model@file:/tmp/x/packages/project-model, required by thirdlight@0.0.0\n',
    });
    const all = r.violations.join('\n');
    expect(all).toContain('exited with status 1');
    expect(all).toContain('npm install');
    expect(all).toContain("'@thirdlight/project-model'");
    // the registry pins still compare (no silent skip): no drift here.
    expect(all).not.toContain('version drift');
  });

  it('collectTreeIssues reports the missing workspace entry (workspace packages are NOT filtered from error reporting)', () => {
    const issues = collectTreeIssues(brokenTree);
    const all = issues.join('\n');
    expect(all).toContain("missing npm tree entry: '@thirdlight/project-model'");
    expect(all).toContain('ELSPROBLEMS');
    expect(all).toContain('npm tree problem:');
  });

  it('reports an invalid (UNMET) registry entry the same way', () => {
    const issues = collectTreeIssues({
      name: 'thirdlight',
      version: '0.0.0',
      dependencies: { esbuild: { invalid: true, valid: false } },
    });
    expect(issues.join('\n')).toContain("invalid npm tree entry: 'esbuild'");
  });

  it('a healthy tree with a drifted version still fails the pin comparison (no regression)', () => {
    const r = checkInstalledTree({
      status: 0,
      stdout: JSON.stringify({
        name: 'thirdlight',
        version: '0.0.0',
        dependencies: { esbuild: { version: '0.28.3', resolved: 'x' } },
      }),
      stderr: '',
    });
    expect(r.violations.join('\n')).toContain('version drift');
  });

  it('a healthy pinned tree passes with the expected pending list', () => {
    const r = checkInstalledTree({
      status: 0,
      stdout: JSON.stringify({
        name: 'thirdlight',
        version: '0.0.0',
        dependencies: {
          typescript: { version: '5.9.3', resolved: 'x' },
          '@thirdlight/project-model': { version: '0.0.0', resolved: 'file:./packages/project-model' },
        },
      }),
      stderr: '',
    });
    expect(r.violations).toEqual([]);
    expect(r.pending).toContain('three');
    expect(r.installed.map((e) => e.name)).toEqual(['typescript']);
  });
});