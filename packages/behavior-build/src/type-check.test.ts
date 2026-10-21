import { describe, expect, it } from 'vitest';

import { canonicalContainerText } from './container';
import { createBehaviorCompiler } from './compile';
import { utf8Encode } from './canonical';

const container = (files: { path: string; text: string }[]): Uint8Array =>
  utf8Encode(canonicalContainerText({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)) }));

const compiler = createBehaviorCompiler({ now: () => performance.now() });

async function check(files: { path: string; text: string }[], libraries: { libraryId: string; files: { path: string; text: string }[] }[] = []) {
  const containerBytes = container(files);
  const libs = libraries.map((l) => ({ libraryId: l.libraryId, containerBytes: utf8Encode(canonicalContainerText({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: l.files })) }));
  // The real build first (it must accept what the type check then reports on).
  const built = await compiler.compile({ behaviorId: 'probe', declaration: { properties: [] }, containerBytes, pinnedModules: compiler.pinnedModules, ...(libs.length > 0 ? { libraries: libs } : {}) });
  expect(built.ok).toBe(true);
  return compiler.typeCheck!({ behaviorId: 'probe', containerBytes, libraries: libs });
}

describe('script type check (pinned TypeScript, generated API typings)', () => {
  it('reports a wrong option name with its position and the real field names, in an untyped script', async () => {
    const text = [
      'export default {',
      '  step(state, ctx) {',
      "    ctx.camera.activate('cam', { blendTime: 0.5 });",
      '  },',
      '};',
      '',
    ].join('\n');
    const r = await check([{ path: 'src/index.ts', text }]);
    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0]!;
    expect(d).toMatchObject({ code: 'behavior_type_error', reason: 'ts2353', path: 'src/index.ts', line: 3, column: 34 });
    expect(d.message).toContain("'blendTime'");
    expect(d.message).toMatch(/has: [^)]*\btime\b/);
  }, 60_000);

  it('passes a correct script (code-declared properties, other modules, a library, a JSON module)', async () => {
    const r = await check(
      [
        {
          path: 'src/index.ts',
          text: [
            "import type { BehaviorContext } from '@thirdlight/runtime';",
            "import { half } from './math';",
            "import table from './table.json';",
            "import { greet } from '@lib/core';",
            'export const properties = { speed: property.number(3, { min: 0 }), mode: property.private.enum("a", { values: ["a", "b"] }) };',
            'export default {',
            '  instantiate: () => ({ n: 0 }),',
            '  step(state, ctx) {',
            "    ctx.camera.activate('cam', { time: half(1) });",
            '    state.n += table.step;',
            "    ctx.log('info', greet(ctx));",
            '  },',
            '};',
            'export function helper(ctx: BehaviorContext, x) { return ctx.stepIndex + x; }',
            '',
          ].join('\n'),
        },
        { path: 'src/math.ts', text: 'export const half = (v: number): number => v / 2;\n' },
        { path: 'src/table.json', text: '{ "step": 1 }\n' },
      ],
      [{ libraryId: 'core', files: [{ path: 'src/index.ts', text: "import type { BehaviorContext } from '@thirdlight/runtime';\nexport function greet(ctx: BehaviorContext): string { return ctx.entityId; }\n" }] }],
    );
    expect(r.diagnostics).toEqual([]);
  }, 60_000);

  it('places errors in other modules and libraries, and checks a call against the typings', async () => {
    const r = await check(
      [
        { path: 'src/index.ts', text: "import { go } from './flow';\nexport default { step(s, ctx) { go(ctx); } };\n" },
        { path: 'src/flow.ts', text: "import type { BehaviorContext } from '@thirdlight/runtime';\nimport { k } from '@lib/core';\nexport function go(ctx: BehaviorContext): void {\n  ctx.modes.switch('m', { nope: 1 });\n  ctx.log('info', k);\n}\n" },
      ],
      [{ libraryId: 'core', files: [{ path: 'src/index.ts', text: 'export const k: number = "x";\n' }] }],
    );
    const where = r.diagnostics.map((d) => `${d.library ?? ''}:${d.path}:${d.line}:${d.column}:${d.reason}`).sort();
    expect(where).toEqual([':src/flow.ts:4:27:ts2353', ':src/flow.ts:5:19:ts2345', 'core:src/index.ts:1:14:ts2322']);
  }, 60_000);

  it('skips a generated visual-script source', async () => {
    const { GRAPH_SOURCE_BANNER } = await import('./graph-banner');
    const r = await compiler.typeCheck!({ behaviorId: 'g', containerBytes: container([{ path: 'src/index.ts', text: `${GRAPH_SOURCE_BANNER}\nexport default { step(s, ctx) { ctx.nope(); } };\n` }]) });
    expect(r).toEqual({ diagnostics: [], skipped: 'graph' });
  }, 60_000);
});
