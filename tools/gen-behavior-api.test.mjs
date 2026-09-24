/**
 * Phase 16.3: the script editor's behavior API typings stay generated from
 * the runtime (parity), and they are valid TypeScript a script can use.
 */
import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { OUTPUT, generateBehaviorApi } from './gen-behavior-api.mjs';

const generated = generateBehaviorApi();

function dtsOf(text) {
  const m = /BEHAVIOR_API_DTS: string = (".*");\n/.exec(text);
  if (m === null) throw new Error('BEHAVIOR_API_DTS not found');
  return JSON.parse(m[1]);
}

/** Type-check `script` against the typings in memory; returns the diagnostics' text. */
function check(dts, script) {
  const files = new Map([
    ['/behavior-api.d.ts', dts],
    ['/script.ts', script],
  ]);
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, types: [], lib: ['lib.es2022.d.ts'] };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) => (files.has(name) ? ts.createSourceFile(name, files.get(name), lang) : read(name, lang));
  host.fileExists = ((exists) => (name) => files.has(name) || exists(name))(host.fileExists.bind(host));
  host.readFile = ((readFile) => (name) => files.get(name) ?? readFile(name))(host.readFile.bind(host));
  const program = ts.createProgram(['/behavior-api.d.ts', '/script.ts'], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('behavior API typings (tools/gen-behavior-api.mjs)', () => {
  it('the checked-in behavior-api.generated.ts matches the runtime types (run node tools/gen-behavior-api.mjs)', () => {
    expect(readFileSync(OUTPUT, 'utf8') === generated).toBe(true);
  });

  it('the typings compile and type a script that uses the context', () => {
    const dts = dtsOf(generated);
    const script = [
      "import type { BehaviorContext, BehaviorSpec } from '@thirdlight/runtime';",
      'const spec: BehaviorSpec<{ n: number }> = {',
      '  instantiate: () => ({ n: 0 }),',
      '  step(state, ctx: BehaviorContext) {',
      "    if (ctx.phase !== 'intent') return;",
      '    state.n += ctx.input.value("move");',
      "    ctx.game?.add('ticks', 1);",
      "    ctx.timers.after('t', 1);",
      "    ctx.log('info', ctx.entityId);",
      '  },',
      '};',
      'export default spec;',
    ].join('\n');
    expect(check(dts, script)).toEqual([]);
    // A wrong member is caught (the typings are real, not `any`).
    expect(check(dts, script.replace('ctx.timers.after', 'ctx.timers.nope')).join('\n')).toContain('nope');
  });

  it('the member table resolves the context and its nested types', () => {
    const table = JSON.parse(/BEHAVIOR_API_TYPES: [^=]*= (\{[\s\S]*\});\n$/.exec(generated)[1]);
    const ctx = table.BehaviorContext;
    const names = ctx.map((m) => m.name);
    for (const n of ['entityId', 'properties', 'input', 'timers', 'game', 'emit', 'log']) expect(names).toContain(n);
    const game = ctx.find((m) => m.name === 'game');
    expect(game.optional).toBe(true);
    expect(table[game.type].map((m) => m.name)).toContain('add');
    expect(ctx.find((m) => m.name === 'log').kind).toBe('method');
  });
});
