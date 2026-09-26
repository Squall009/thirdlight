/**
 * Packet 31 — module-boundary evidence: the runtime core imports no Rapier
 * implementation, and the approved pin is reachable from exactly one package.
 *
 * `tools/check-boundaries.mjs` is the enforced check (dependencies.md §4.1/
 * §4.3); these assertions are the readable, greppable version of the same
 * claim for the packet-31 evidence manifest.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from './helpers';

function packageJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO, 'packages', name, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('runtime core imports no physics implementation', () => {
  it('declares no Rapier dependency and no physics-rapier edge', () => {
    const runtime = packageJson('runtime');
    const deps = (runtime['dependencies'] ?? {}) as Record<string, string>;
    expect(Object.keys(deps)).toEqual(['@thirdlight/project-model']);
  });

  it('contains no Rapier import anywhere in its sources', () => {
    const importPattern =
      /(?:from|import)\s*\(?\s*['"](?:@dimforge\/rapier2d-compat|@thirdlight\/physics-rapier)['"]/;
    const offenders = sourceFiles(join(REPO, 'packages', 'runtime', 'src')).filter((file) =>
      importPattern.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('is the only package allowed to import the pin (the adapter)', () => {
    const importers: string[] = [];
    for (const name of readdirSync(join(REPO, 'packages'))) {
      const pkgDir = join(REPO, 'packages', name);
      let deps: Record<string, string> = {};
      try {
        deps = (packageJson(name)['dependencies'] ?? {}) as Record<string, string>;
      } catch {
        continue;
      }
      if (Object.keys(deps).includes('@dimforge/rapier2d-compat')) importers.push(name);
      // No production or test source outside the adapter may import the pin.
      for (const file of sourceFiles(join(pkgDir, 'src'))) {
        const source = readFileSync(file, 'utf8');
        if (/from ['"]@dimforge\/rapier2d-compat['"]/.test(source) && name !== 'physics-rapier') {
          importers.push(`${name}:${file}`);
        }
      }
    }
    expect(importers).toEqual(['physics-rapier']);
  });

  it('keeps the adapter free of the forbidden edges (no three/editor/backend/internal imports)', () => {
    const adapterSrc = sourceFiles(join(REPO, 'packages', 'physics-rapier', 'src'));
    expect(adapterSrc.length).toBeGreaterThan(0);
    for (const file of adapterSrc) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const specifier of imports) {
        const allowed =
          specifier.startsWith('./') || specifier.startsWith('../') || specifier === '@dimforge/rapier2d-compat' ||
          // Phase 23.0: the 3D backend (the `./3d` subpath; decision 0005).
          specifier === '@dimforge/rapier3d-compat' ||
          specifier === '@thirdlight/runtime' ||
          specifier === 'vitest';
        expect(allowed, `${file} imports '${specifier}' (dependencies.md §4.1/§4.3)`).toBe(true);
      }
      expect(source.includes('node:'), `${file} must not use Node built-ins`).toBe(false);
    }
  });
});
