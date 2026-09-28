/**
 * Phase 25.9: script libraries compiled as shared modules (minified,
 * tree-shaken, compiled once) that behaviors import by digest, the 23.7
 * bundled form kept for older records, and compiled positions mapped back to
 * the sources.
 */
import { describe, expect, it } from 'vitest';
import { scriptLibraryContainerText } from '@thirdlight/project-model';

import { canonicalContainerText } from './container';
import { compileBehavior, createBehaviorCompiler } from './compile';
import { createLibraryCache } from './libraries';
import { M2_PINNED_MODULES } from './limits';
import { originalPosition, sourceFileOf } from './source-map';
import type { BehaviorCompileOptions, ScriptLibraryInput } from './types';

const NO_PROPS = { properties: [] };
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const container = (text: string): Uint8Array => enc(canonicalContainerText({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }));
const lib = (libraryId: string, files: { path: string; text: string }[]): ScriptLibraryInput => ({ libraryId, containerBytes: enc(scriptLibraryContainerText({ files })) });

const BASE = lib('base', [{ path: 'src/index.ts', text: 'export const ten = 10;\nfunction neverUsed(): string {\n  return "dropped by tree shaking";\n}\nexport default 7;\n' }]);
const MID = lib('mid', [
  { path: 'src/index.ts', text: "import { ten } from '@lib/base';\nimport { plusOne } from './util';\nexport const twenty = ten * 2;\nexport function fail(n: number): number {\n  if (n > 1) throw new Error('boom ' + n);\n  return plusOne(n);\n}\n" },
  { path: 'src/util.ts', text: 'export const plusOne = (n: number): number => n + 1;\nexport const unusedHere = (): number => 99;\n' },
]);
const USER = "import { twenty, fail } from '@lib/mid';\nexport default {\n  value: twenty,\n  step() {\n    fail(3);\n  },\n};\n";

describe('shared library modules (phase 25.9)', () => {
  it('each library is its own minified, tree-shaken module; the behavior imports it by digest', async () => {
    const r = await compileBehavior({ behaviorId: 'user', declaration: NO_PROPS, containerBytes: container(USER), pinnedModules: M2_PINNED_MODULES, libraries: [MID, BASE] });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const mods = r.libraryModules ?? [];
    expect(mods.map((m) => m.libraryId)).toEqual(['base', 'mid']);
    const [base, mid] = mods as [(typeof mods)[number], (typeof mods)[number]];
    expect(dec(base.outputBytes)).not.toContain('dropped by tree shaking');
    expect(base.exports).toEqual(['default', 'ten']);
    // A library imports another by digest, next to it.
    expect(dec(mid.outputBytes)).toContain(`from"./${base.outputDigest}.js"`);
    expect(dec(mid.outputBytes).trimEnd()).not.toContain('\n');
    // The behavior carries no library code, only the import of the module it names.
    const out = dec(r.outputBytes);
    expect(out).toContain(`from "../libraries/${mid.outputDigest}.js"`);
    expect(out).not.toContain('boom');
    expect(out).not.toContain(base.outputDigest);
    // The manifest pins the sources and the linked modules; the recipe says shared.
    expect(r.manifest.libraries?.map((p) => p.libraryId)).toEqual(['base', 'mid']);
    expect(r.manifest.libraryModules).toEqual([
      { libraryId: 'base', outputDigest: base.outputDigest },
      { libraryId: 'mid', outputDigest: mid.outputDigest },
    ]);
  });

  it('the same inputs give the same bytes; a changed library changes its importers\' outputs (the pins cover the linked output)', async () => {
    const input = { behaviorId: 'user', declaration: NO_PROPS, containerBytes: container(USER), pinnedModules: M2_PINNED_MODULES, libraries: [MID, BASE] };
    const a = await compileBehavior(input);
    const b = await compileBehavior(input, { libraryCache: createLibraryCache() });
    if (!a.ok || !b.ok) throw new Error('compile failed');
    expect(b.outputDigest).toBe(a.outputDigest);
    expect(b.libraryModules?.map((m) => m.outputDigest)).toEqual(a.libraryModules?.map((m) => m.outputDigest));
    const base2 = lib('base', [{ path: 'src/index.ts', text: 'export const ten = 11;\nexport default 7;\n' }]);
    const c = await compileBehavior({ ...input, libraries: [MID, base2] });
    if (!c.ok) throw new Error('compile failed');
    // base changed, so mid (which imports it by digest) and the behavior (which imports mid) change too.
    expect(c.libraryModules?.[0]?.outputDigest).not.toBe(a.libraryModules?.[0]?.outputDigest);
    expect(c.libraryModules?.[1]?.outputDigest).not.toBe(a.libraryModules?.[1]?.outputDigest);
    expect(c.outputDigest).not.toBe(a.outputDigest);
  });

  it('a library shared by several behaviors is compiled once per compiler', async () => {
    const opts: BehaviorCompileOptions = { libraryCache: createLibraryCache() };
    const digests = new Set<string>();
    for (const id of ['one', 'two', 'three']) {
      const r = await compileBehavior({ behaviorId: id, declaration: NO_PROPS, containerBytes: container(`import { ten } from '@lib/base';\nexport default { v: ten + ${id.length}, step() {} };\n`), pinnedModules: M2_PINNED_MODULES, libraries: [BASE] }, opts);
      if (!r.ok) throw new Error(JSON.stringify(r));
      digests.add(r.libraryModules![0]!.outputDigest);
    }
    expect(digests.size).toBe(1);
    // One transpiled library and one shared module in the cache.
    expect(opts.libraryCache?.entries.size).toBe(2);
  });

  it('an import of a name the library does not export is a compile error naming the library', async () => {
    const r = await compileBehavior({ behaviorId: 'user', declaration: NO_PROPS, containerBytes: container("import { nope } from '@lib/base';\nexport default { v: nope, step() {} };\n"), pinnedModules: M2_PINNED_MODULES, libraries: [BASE] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({ path: 'src/index.ts', line: 1 });
    expect(r.diagnostics[0]?.message).toContain('No matching export in "@lib/base" for import "nope"');
  });

  it('the bundled (23.7) form is still available and differs from the shared one', async () => {
    const input = { behaviorId: 'user', declaration: NO_PROPS, containerBytes: container(USER), pinnedModules: M2_PINNED_MODULES, libraries: [MID, BASE] };
    const shared = await compileBehavior(input);
    const bundled = await compileBehavior({ ...input, libraryLinking: 'bundle' });
    if (!shared.ok || !bundled.ok) throw new Error('compile failed');
    expect(dec(bundled.outputBytes)).toContain('boom');
    expect(bundled.libraryModules).toBeUndefined();
    expect(bundled.manifest.libraryModules).toBeUndefined();
    expect(bundled.outputDigest).not.toBe(shared.outputDigest);
    expect(bundled.recipeDigest).not.toBe(shared.recipeDigest);
    // The compiler's cache keeps the two apart.
    const compiler = createBehaviorCompiler();
    const x = await compiler.compile(input);
    const y = await compiler.compile({ ...input, libraryLinking: 'bundle' });
    if (!x.ok || !y.ok) throw new Error('compile failed');
    expect(x.outputDigest).toBe(shared.outputDigest);
    expect(y.outputDigest).toBe(bundled.outputDigest);
  });

  it('source maps take compiled positions back to the library and behavior files', async () => {
    const r = await compileBehavior({ behaviorId: 'user', declaration: NO_PROPS, containerBytes: container(USER), pinnedModules: M2_PINNED_MODULES, libraries: [MID, BASE] });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const mid = r.libraryModules!.find((m) => m.libraryId === 'mid')!;
    const midText = dec(mid.outputBytes);
    const throwAt = originalPosition(mid.sourceMap, 1, midText.indexOf('throw') + 1);
    expect(throwAt).toMatchObject({ source: 'src/index.ts', line: 5 });
    const plusOne = originalPosition(mid.sourceMap, 1, midText.indexOf('+1') + 1);
    expect(plusOne?.source).toBe('tl-lib-own:src/util.ts');
    expect(sourceFileOf(plusOne!.source)).toEqual({ path: 'src/util.ts' });
    // The behavior's own map: the call inside step().
    const out = dec(r.outputBytes).split('\n');
    const line = out.findIndex((l) => l.includes('fail(3)')) + 1;
    const call = originalPosition(r.sourceMap!, line, out[line - 1]!.indexOf('fail(3)') + 1);
    expect(call).toMatchObject({ source: 'src/index.ts', line: 5, column: 5 });
    expect(sourceFileOf('tl-lib-link:mid')).toBeNull();
    expect(sourceFileOf('tl-lib:mid/src/util.ts')).toEqual({ library: 'mid', path: 'src/util.ts' });
    expect(originalPosition('not json', 1, 1)).toBeNull();
  });

  it('a behavior without library imports keeps its exact bytes (sources maps ride along without changing them)', async () => {
    const bytes = container('export default { step() {} };\n');
    const plain = await compileBehavior({ behaviorId: 'b', declaration: NO_PROPS, containerBytes: bytes, pinnedModules: M2_PINNED_MODULES });
    const injected = await compileBehavior({ behaviorId: 'b', declaration: NO_PROPS, containerBytes: bytes, pinnedModules: M2_PINNED_MODULES }, {
      build: async (o: unknown) => {
        const { build } = await import('esbuild');
        const { outfile: _o, sourcemap: _s, sourcesContent: _c, ...rest } = o as Record<string, unknown>;
        return build({ ...(rest as object), sourcemap: false } as never) as never;
      },
    });
    if (!plain.ok || !injected.ok) throw new Error('compile failed');
    expect(plain.outputDigest).toBe(injected.outputDigest);
    expect(plain.sourceMap).toContain('"mappings"');
  });
});
