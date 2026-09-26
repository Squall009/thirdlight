/**
 * Phase 23.7: script libraries (`@lib/<id>`) and `.json` data modules in the
 * behavior compiler.
 */
import { describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';
import { scriptLibraryContainerText, scriptLibraryDigest } from '@thirdlight/project-model';

import { canonicalContainerText } from './container';
import { checkScriptLibrary, compileBehavior, createBehaviorCompiler } from './compile';
import { createLibraryCache } from './libraries';
import { M2_PINNED_MODULES } from './limits';
import type { BehaviorCompileOptions, ScriptLibraryInput } from './types';

const NO_PROPS = { properties: [] };

function container(files: { path: string; text: string }[], requiredModules: string[] = []): Uint8Array {
  return new TextEncoder().encode(
    canonicalContainerText({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules, ownedTransforms: [], files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)) }),
  );
}

function lib(libraryId: string, files: { path: string; text: string }[]): ScriptLibraryInput {
  return { libraryId, containerBytes: new TextEncoder().encode(scriptLibraryContainerText({ files })) };
}

/** Evaluate a compiled output here only as a test of the output (the compiler never runs source): as CommonJS. */
async function evaluate(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const cjs = transformSync(new TextDecoder().decode(bytes), { format: 'cjs' }).code;
  const holder: { exports: Record<string, unknown> } = { exports: {} };
  new Function('module', 'exports', cjs)(holder, holder.exports);
  return (holder.exports as { default: Record<string, unknown> }).default;
}

const RULES = lib('rules', [
  { path: 'src/index.ts', text: "import table from './table.json';\nexport const bonus = (n: number): number => n * table.factor;\nexport const NAME = 'rules';\n" },
  { path: 'src/table.json', text: '{ "factor": 3 }\n' },
]);

describe('script libraries', () => {
  it('links an imported library into the behavior and pins its digest', async () => {
    const r = await compileBehavior({
      behaviorId: 'user',
      declaration: NO_PROPS,
      containerBytes: container([{ path: 'src/index.ts', text: "import { bonus } from '@lib/rules';\nexport default { value: bonus(2), step() {} };\n" }]),
      pinnedModules: M2_PINNED_MODULES,
      libraries: [RULES, lib('unused', [{ path: 'src/index.ts', text: 'export const x = 1;\n' }])],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.libraries).toEqual([{ libraryId: 'rules', sourceDigest: scriptLibraryDigest({ files: [{ path: 'src/index.ts', text: "import table from './table.json';\nexport const bonus = (n: number): number => n * table.factor;\nexport const NAME = 'rules';\n" }, { path: 'src/table.json', text: '{ "factor": 3 }\n' }] }) }]);
    expect((await evaluate(r.outputBytes))['value']).toBe(6);
  });

  it('a library importing another library pins both; the same inputs give the same bytes', async () => {
    const base = lib('base', [{ path: 'src/index.ts', text: 'export const ten = 10;\n' }]);
    const mid = lib('mid', [{ path: 'src/index.ts', text: "import { ten } from '@lib/base';\nexport const twenty = ten * 2;\n" }]);
    const input = {
      behaviorId: 'user',
      declaration: NO_PROPS,
      containerBytes: container([{ path: 'src/index.ts', text: "import { twenty } from '@lib/mid';\nexport default { value: twenty, step() {} };\n" }]),
      pinnedModules: M2_PINNED_MODULES,
      libraries: [mid, base],
    };
    const a = await compileBehavior(input);
    const b = await compileBehavior(input, { libraryCache: createLibraryCache() });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.manifest.libraries?.map((p) => p.libraryId)).toEqual(['base', 'mid']);
    expect(new TextDecoder().decode(a.outputBytes)).toBe(new TextDecoder().decode(b.outputBytes));
    expect(a.manifestDigest).toBe(b.manifestDigest);
    expect((await evaluate(a.outputBytes))['value']).toBe(20);
  });

  it('a behavior without library imports compiles to exactly the same bytes whatever libraries exist', async () => {
    const bytes = container([{ path: 'src/index.ts', text: 'export default { step() {} };\n' }]);
    const plain = await compileBehavior({ behaviorId: 'b', declaration: NO_PROPS, containerBytes: bytes, pinnedModules: M2_PINNED_MODULES });
    const withLibs = await compileBehavior({ behaviorId: 'b', declaration: NO_PROPS, containerBytes: bytes, pinnedModules: M2_PINNED_MODULES, libraries: [RULES] });
    expect(plain.ok && withLibs.ok).toBe(true);
    if (!plain.ok || !withLibs.ok) return;
    expect(withLibs.manifestDigest).toBe(plain.manifestDigest);
    expect(withLibs.recipeDigest).toBe(plain.recipeDigest);
    expect('libraries' in withLibs.manifest).toBe(false);
  });

  it('a missing library is a compile failure naming it', async () => {
    const r = await compileBehavior({
      behaviorId: 'user',
      declaration: NO_PROPS,
      containerBytes: container([{ path: 'src/index.ts', text: "import { x } from '@lib/nope';\nexport default { step() { x; } };\n" }]),
      pinnedModules: M2_PINNED_MODULES,
      libraries: [RULES],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('behavior_library_missing');
    expect(r.diagnostics[0]?.message).toContain('@lib/nope');
  });

  it('libraries importing each other in a cycle are refused with the chain', async () => {
    const a = lib('a', [{ path: 'src/index.ts', text: "import { b } from '@lib/b';\nexport const a = 1 + b;\n" }]);
    const b = lib('b', [{ path: 'src/index.ts', text: "import { c } from '@lib/c';\nexport const b = c;\n" }]);
    const c = lib('c', [{ path: 'src/index.ts', text: "import { a } from '@lib/a';\nexport const c = a;\n" }]);
    const r = await compileBehavior({
      behaviorId: 'user',
      declaration: NO_PROPS,
      containerBytes: container([{ path: 'src/index.ts', text: "import { a } from '@lib/a';\nexport default { step() { a; } };\n" }]),
      pinnedModules: M2_PINNED_MODULES,
      libraries: [a, b, c],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('behavior_library_cycle');
    expect(r.detail).toBe('@lib/a -> @lib/b -> @lib/c -> @lib/a');
  });

  it('a relative cycle inside a library is refused like one in a behavior', async () => {
    const loop = lib('loop', [
      { path: 'src/index.ts', text: "export { y } from './x';\n" },
      { path: 'src/x.ts', text: "import { z } from './y';\nexport const y = z;\n" },
      { path: 'src/y.ts', text: "import { y } from './x';\nexport const z = y;\n" },
    ]);
    const r = await checkScriptLibrary({ libraryId: 'loop', libraries: [loop] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('behavior_source_cycle');
    expect(r.diagnostics[0]?.library).toBe('loop');
  });

  it('a syntax error in a library names the library, its file and line', async () => {
    const broken = lib('broken', [
      { path: 'src/index.ts', text: "export * from './util';\n" },
      { path: 'src/util.ts', text: 'export const f = (\n  1 +;\n' },
    ]);
    const r = await checkScriptLibrary({ libraryId: 'broken', libraries: [broken] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('behavior_source_invalid');
    expect(r.diagnostics[0]).toMatchObject({ library: 'broken', path: 'src/util.ts', line: 2 });
  });

  it('a library may type-import engine modules without listing them; value imports stay forbidden', async () => {
    const typed = lib('typed', [{ path: 'src/index.ts', text: "import type { BehaviorContext } from '@thirdlight/runtime';\nexport const id = (ctx: BehaviorContext): string => ctx.entityId;\n" }]);
    const ok = await checkScriptLibrary({ libraryId: 'typed', libraries: [typed] });
    expect(ok.ok).toBe(true);
    const valued = lib('valued', [{ path: 'src/index.ts', text: "import { x } from '@thirdlight/runtime';\nexport const y = x;\n" }]);
    const bad = await checkScriptLibrary({ libraryId: 'valued', libraries: [valued] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('behavior_import_forbidden');
  });

  it('checkScriptLibrary reports the digest and the libraries it reaches', async () => {
    const base = lib('base', [{ path: 'src/index.ts', text: 'export const ten = 10;\n' }]);
    const mid = lib('mid', [{ path: 'src/index.ts', text: "export { ten } from '@lib/base';\n" }]);
    const r = await checkScriptLibrary({ libraryId: 'mid', libraries: [base, mid] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imports).toEqual(['base']);
    expect(r.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a compiler instance compiles a library once for several behaviors (the cache)', async () => {
    let transforms = 0;
    const compiler = createBehaviorCompiler();
    const opts: BehaviorCompileOptions = { libraryCache: createLibraryCache() };
    for (const id of ['one', 'two', 'three']) {
      const r = await compileBehavior(
        { behaviorId: id, declaration: NO_PROPS, containerBytes: container([{ path: 'src/index.ts', text: `import { NAME } from '@lib/rules';\nexport default { v: NAME + '${id}', step() {} };\n` }]), pinnedModules: M2_PINNED_MODULES, libraries: [RULES] },
        opts,
      );
      expect(r.ok).toBe(true);
      transforms = opts.libraryCache?.entries.size ?? 0;
    }
    expect(transforms).toBe(1);
    expect(typeof compiler.checkLibrary).toBe('function');
  });
});

describe('.json data modules', () => {
  it('a behavior imports a .json file of its own container as its parsed value', async () => {
    const r = await compileBehavior({
      behaviorId: 'data',
      declaration: NO_PROPS,
      containerBytes: container([
        { path: 'src/index.ts', text: "import items from './items.json';\nexport default { first: items.list[0].name, step() {} };\n" },
        { path: 'src/items.json', text: '{ "list": [{ "name": "apple" }, { "name": "pear" }] }\n' },
      ]),
      pinnedModules: M2_PINNED_MODULES,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await evaluate(r.outputBytes))['first']).toBe('apple');
  });

  it('invalid JSON is a source problem naming the file', async () => {
    const r = await compileBehavior({
      behaviorId: 'data',
      declaration: NO_PROPS,
      containerBytes: container([
        { path: 'src/index.ts', text: "import items from './items.json';\nexport default { items, step() {} };\n" },
        { path: 'src/items.json', text: '{ "list": [1, 2,, ] }\n' },
      ]),
      pinnedModules: M2_PINNED_MODULES,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('behavior_source_invalid');
    expect(r.reason).toBe('json');
    expect(r.diagnostics[0]?.path).toBe('src/items.json');
  });

  it('a missing .json file is refused like a missing .ts file', async () => {
    const r = await compileBehavior({
      behaviorId: 'data',
      declaration: NO_PROPS,
      containerBytes: container([{ path: 'src/index.ts', text: "import items from './nope.json';\nexport default { items, step() {} };\n" }]),
      pinnedModules: M2_PINNED_MODULES,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('behavior_source_missing');
    expect(r.detail).toBe('src/nope.json');
  });
});
