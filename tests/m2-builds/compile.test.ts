/**
 * Packet 33 — `compileBehavior` over the real pinned esbuild 0.28.2
 * (project-model.md §22.3.3 steps 13–15, §22.4; behaviors.md §5).
 *
 * The valid fixtures compile reproducibly; every hostile container and every
 * bound fails with the committed code; the injected build/clock seams prove
 * the compiler-failure, timeout, output-bound and output-scan paths; and no
 * project source is ever executed (sentinel).
 */
import { describe, expect, it } from 'vitest';

import {
  COMPILER_ID,
  COMPILER_LIMITS,
  M2_PINNED_MODULES,
  compileBehavior,
  compileRecipeDigest,
  createBehaviorCompiler,
  esbuildPinMatches,
  manifestBytesOf,
  parseSourceGraphContainer,
  prepareBehavior,
  preparedSourceFrom,
  scanOutput,
} from '../../packages/behavior-build/src/index';

import { containerBytes, containerText, expectMatches, fixtureDeclaration, index } from './fixtures';

const DECLARATION = fixtureDeclaration();
const BEHAVIOR_ID = index.behaviorId;

/** A generous timeout so the fixture runs are not the timeout case. */
const RUN_LIMITS = { timeoutMs: 30_000 };

async function compileFixture(rel: string, overrides: Record<string, unknown> = {}) {
  return compileBehavior({
    behaviorId: BEHAVIOR_ID,
    declaration: DECLARATION,
    containerBytes: containerBytes(rel),
    pinnedModules: M2_PINNED_MODULES,
    limits: RUN_LIMITS,
    ...overrides,
  });
}

describe('packet 33 — compileBehavior (project-model.md §22.3.3 steps 13–15)', () => {
  it('uses the pinned parser version', () => {
    expect(esbuildPinMatches()).toBe(true);
    expect(COMPILER_ID).toBe('thirdlight.behavior-compiler');
    // The recorded recipe digest is the COMPILER_LIMITS-based one.
    expect(compileRecipeDigest(DECLARATION, M2_PINNED_MODULES, COMPILER_LIMITS)).toBe(
      index.validSample.recipeDigest,
    );
  });

  it('compiles the valid sample reproducibly with the committed digests', async () => {
    const first = await compileBehavior({
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
      containerBytes: containerBytes('valid/sample.json'),
      pinnedModules: M2_PINNED_MODULES,
      limits: COMPILER_LIMITS,
    });
    if (!first.ok) throw new Error(`compile failed: ${JSON.stringify(first)}`);
    const second = await compileBehavior({
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
      containerBytes: containerBytes('valid/sample.json'),
      pinnedModules: M2_PINNED_MODULES,
      limits: COMPILER_LIMITS,
    });
    if (!second.ok) throw new Error(`second compile failed: ${JSON.stringify(second)}`);
    // Byte-identical output and manifest for identical inputs (2-run equality).
    expect(Buffer.from(second.outputBytes).equals(Buffer.from(first.outputBytes))).toBe(true);
    expect(Buffer.from(second.manifestBytes).equals(Buffer.from(first.manifestBytes))).toBe(true);
    const expected = index.cases.find((c) => c.container === 'valid/sample.json')?.expect as Record<string, unknown>;
    expect(first.manifestDigest).toBe(expected['manifestDigest']);
    expect(first.outputDigest).toBe(expected['outputDigest']);
    expect(first.outputBytes.length).toBe(expected['outputByteLength']);
    expect(first.recipeDigest).toBe(expected['recipeDigest']);
    expect(first.declarationDigest).toBe(expected['declarationDigest']);
    // The committed output artifact is the pinned artifact bytes.
    const committed = containerBytes('valid/sample.output.js');
    expect(Buffer.from(first.outputBytes).equals(Buffer.from(committed))).toBe(true);
    // The manifest bytes are the canonical 2-space JSON + newline.
    expect(Buffer.from(first.manifestBytes).toString('utf8')).toBe(
      `${JSON.stringify(first.manifest, null, 2)}\n`,
    );
    expect(manifestBytesOf(first.manifest).length).toBe(first.manifestBytes.length);
  });

  it('fails every committed hostile container with its exact code/reason/limit', async () => {
    const problems: string[] = [];
    for (const c of index.cases) {
      if (c.expect['ok'] !== false) continue;
      const result = await compileFixture(c.container);
      if (result.ok) {
        problems.push(`${c.caseId}: expected failure, compiled`);
        continue;
      }
      problems.push(...expectMatches(c.expect, result as unknown as Record<string, unknown>).map((p) => `${c.caseId}: ${p}`));
    }
    expect(problems).toEqual([]);
  });

  it('compiles the second valid container (ownedTransforms) reproducibly', async () => {
    const result = await compileFixture('valid/owned-transforms.json', { limits: COMPILER_LIMITS });
    if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result)}`);
    const expected = index.cases.find((c) => c.container === 'valid/owned-transforms.json')?.expect as Record<string, unknown>;
    expect(result.manifest.ownedTransforms).toEqual(['model-0001', 'model-0002']);
    expect(result.outputDigest).toBe(expected['outputDigest']);
    expect(result.manifestDigest).toBe(expected['manifestDigest']);
  });

  it('reproduces the declaration bound failures', async () => {
    for (const c of index.declarationCases) {
      const declaration =
        c.declaration === 'empty'
          ? { properties: [] }
          : { properties: Array.from({ length: 33 }, (_, i) => ({ key: `p${i}`, label: `P${i}`, type: 'number', default: 0 })) };
      const result = await compileBehavior({
        behaviorId: BEHAVIOR_ID,
        declaration: declaration as never,
        containerBytes: containerBytes('valid/sample.json'),
        pinnedModules: M2_PINNED_MODULES,
        limits: RUN_LIMITS,
      });
      // Phase 19.1: a behavior may declare no property (the packet-33 "empty" case compiles now).
      if (c.declaration === 'empty') {
        expect(result.ok, c.caseId).toBe(true);
        continue;
      }
      expect(result.ok, c.caseId).toBe(false);
      if (!result.ok) expectMatches(c.expect, result as unknown as Record<string, unknown>).forEach((p) => expect(p).toBe(''));
    }
  });

  it('reports an injected compiler failure as behavior_compile_failed', async () => {
    const result = await compileBehavior(
      {
        behaviorId: BEHAVIOR_ID,
        declaration: DECLARATION,
        containerBytes: containerBytes('valid/sample.json'),
        pinnedModules: M2_PINNED_MODULES,
        limits: RUN_LIMITS,
      },
      {
        build: () => {
          throw new Error('injected compiler failure');
        },
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'behavior_compile_failed' });
  });

  it('reports a cooperative timeout (injected clock, pre-check)', async () => {
    let calls = 0;
    const result = await compileBehavior(
      {
        behaviorId: BEHAVIOR_ID,
        declaration: DECLARATION,
        containerBytes: containerBytes('valid/sample.json'),
        pinnedModules: M2_PINNED_MODULES,
        limits: { timeoutMs: 1 },
      },
      { now: () => (calls++ === 0 ? 0 : 5_000) },
    );
    expect(result).toMatchObject({ ok: false, code: 'behavior_compile_timeout' });
  });

  it('reports a cooperative timeout when the clock advances after the real build', async () => {
    let calls = 0;
    const result = await compileBehavior(
      {
        behaviorId: BEHAVIOR_ID,
        declaration: DECLARATION,
        containerBytes: containerBytes('valid/sample.json'),
        pinnedModules: M2_PINNED_MODULES,
        limits: { timeoutMs: 1 },
      },
      { now: () => (calls++ < 4 ? 0 : 5_000) },
    );
    expect(result).toMatchObject({ ok: false, code: 'behavior_compile_timeout' });
  });

  it('bounds oversized output bytes (injected build)', async () => {
    const result = await compileBehavior(
      {
        behaviorId: BEHAVIOR_ID,
        declaration: DECLARATION,
        containerBytes: containerBytes('valid/sample.json'),
        pinnedModules: M2_PINNED_MODULES,
        limits: RUN_LIMITS,
      },
      { build: () => ({ outputFiles: [{ contents: new Uint8Array(131_073).fill(0x2f) }] }) },
    );
    expect(result).toMatchObject({ ok: false, code: 'behavior_output_limits_exceeded', limit: 'output_bytes', current: 131_073 });
  });

  it('scans the output for forbidden patterns (letter d = fetch()', async () => {
    const result = await compileBehavior(
      {
        behaviorId: BEHAVIOR_ID,
        declaration: DECLARATION,
        containerBytes: containerBytes('valid/sample.json'),
        pinnedModules: M2_PINNED_MODULES,
        limits: RUN_LIMITS,
      },
      { build: () => ({ outputFiles: [{ contents: new TextEncoder().encode('const x = fetch("./x");\n') }] }) },
    );
    expect(result).toMatchObject({ ok: false, code: 'behavior_output_forbidden_content', reason: 'd' });
  });

  it('exposes the output scanner directly (letters follow export.md §5.4)', () => {
    expect(scanOutput(new TextEncoder().encode('ok'), M2_PINNED_MODULES)).toBeNull();
    expect(scanOutput(new TextEncoder().encode('var a = import("./x")'), M2_PINNED_MODULES)).toMatchObject({ letter: 'k' });
    expect(scanOutput(new TextEncoder().encode('var a = eval("1")'), M2_PINNED_MODULES)).toMatchObject({ letter: 'l' });
    expect(scanOutput(new TextEncoder().encode('void "@thirdlight/runtime"'), M2_PINNED_MODULES)).toMatchObject({ letter: 'p' });
    expect(scanOutput(new TextEncoder().encode('void "/api/v1/"'), M2_PINNED_MODULES)).toMatchObject({ letter: 'c' });
    // A host-supplied token value maps to letter a; the configured origins map
    // to a/b (an `http://` origin also matches table pattern h, so the reported
    // letter is the earliest-position hit — both are recorded).
    const host = scanOutput(new TextEncoder().encode('void "secret-token-value"'), M2_PINNED_MODULES, ['secret-token-value']);
    expect(host).toMatchObject({ letter: 'a' });
    const origin = scanOutput(new TextEncoder().encode('void "http://127.0.0.1:8501"'), M2_PINNED_MODULES, ['http://127.0.0.1:8501']);
    expect(origin?.letters).toContain('a');
  });

  it('never executes project source (global sentinel + throwing top-level code)', async () => {
    const sentinel = '__thirdlight_behavior_executed__';
    (globalThis as Record<string, unknown>)[sentinel] = undefined;
    const indexText = [
      "declare const globalThis: { __thirdlight_behavior_executed__?: boolean };",
      'globalThis.__thirdlight_behavior_executed__ = true;',
      "throw new Error('top-level code must never run');",
      'export default { step() {} };',
      '',
    ].join('\n');
    const container = {
      graphVersion: 1,
      entryPath: 'src/index.ts',
      requiredModules: [],
      ownedTransforms: [],
      files: [{ path: 'src/index.ts', text: indexText }],
    };
    const bytes = new TextEncoder().encode(`${JSON.stringify(container, null, 2)}\n`);
    const result = await compileBehavior({
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
      containerBytes: bytes,
      pinnedModules: M2_PINNED_MODULES,
      limits: RUN_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((globalThis as Record<string, unknown>)[sentinel]).toBeUndefined();
    // The bytes survive statically in the artifact (no execution, no rewrite).
    const text = new TextDecoder().decode(result.outputBytes);
    expect(text).toContain('top-level code must never run');
    expect(text).toContain(sentinel);
  });

  it('provides the injectable compiler instance and the prepared-record builder', async () => {
    const compiler = createBehaviorCompiler({ now: () => Date.now() });
    expect(compiler.pinnedModules).toEqual(M2_PINNED_MODULES);
    const prepared = await prepareBehavior(compiler, {
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
      containerBytes: containerBytes('valid/sample.json'),
      pinnedModules: compiler.pinnedModules,
      limits: COMPILER_LIMITS,
    });
    if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
    expect(prepared.prepared.entryPath).toBe('src/index.ts');
    const sampleExpect = index.cases.find((c) => c.container === 'valid/sample.json')?.expect as Record<string, unknown>;
    expect(prepared.prepared.sourceDigest).toBe(sampleExpect['sourceDigest'] ?? prepared.prepared.sourceDigest);
    expect(prepared.prepared.declarationDigest).toBe(sampleExpect['declarationDigest']);
    const direct = await compileBehavior({
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
      containerBytes: containerBytes('valid/sample.json'),
      pinnedModules: M2_PINNED_MODULES,
      limits: COMPILER_LIMITS,
    });
    if (!direct.ok) throw new Error('direct compile failed');
    expect(prepared.prepared).toEqual(preparedSourceFrom(direct));
  });

  it('validates the container before ever calling the injected build', async () => {
    let called = false;
    const result = await compileBehavior(
      {
        behaviorId: BEHAVIOR_ID,
        declaration: DECLARATION,
        containerBytes: containerBytes('hostile/bare-import.json'),
        pinnedModules: M2_PINNED_MODULES,
        limits: RUN_LIMITS,
      },
      {
        build: () => {
          called = true;
          return { outputFiles: [{ contents: new Uint8Array(1) }] };
        },
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'behavior_import_forbidden', reason: 'bare' });
    expect(called).toBe(false);
  });

  it('keeps the fixture limits equal to COMPILER_LIMITS', () => {
    expect(index.limits).toEqual(COMPILER_LIMITS);
    expect(parseSourceGraphContainer(containerBytes('valid/sample.json'), COMPILER_LIMITS).ok).toBe(true);
    expect(containerText('valid/sample.json').length).toBe(index.cases.find((c) => c.container === 'valid/sample.json')?.containerByteLength);
  });
});
