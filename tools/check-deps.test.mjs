/**
 * Check tool test suite — dependency pin check (dependencies.md §5 check 6):
 * pin drift, unpinned dependencies, and declared-range detection.
 */

import { describe, it, expect } from 'vitest';
import { compareInstalled, checkDeclaredDeps, PINS, collectInstalled } from './check-deps.mjs';

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
    });
  });
});