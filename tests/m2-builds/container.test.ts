/**
 * Packet 33 — the canonical source-graph container and the static source rules
 * (project-model.md §22.1/§22.3.3 steps 1–12).
 *
 * Every case in `fixtures/m2/behaviors/expected.json` is executed against the
 * real parser/analyzer; the expectations are the committed fixture index (also
 * independently re-derived by `fixtures/m2/behaviors/tools/check.mjs`).
 */
import { describe, expect, it } from 'vitest';

import {
  M2_PINNED_MODULES,
  analyzeSourceGraph,
  parseSourceGraphContainer,
  type BehaviorCompilerLimits,
} from '../../packages/behavior-build/src/index';

import { containerBytes, containerText, expectMatches, index } from './fixtures';

const LIMITS = index.limits as BehaviorCompilerLimits;

/** Compile products the static pipeline cannot derive (checked by compile.test.ts). */
const COMPILE_PRODUCT_KEYS = new Set([
  'manifestDigest',
  'outputDigest',
  'outputByteLength',
  'recipeDigest',
  'declarationDigest',
]);

/** Run steps 1–12 (the full static pipeline) and flatten the outcome. */
function analyzeContainer(bytes: Uint8Array, limits: BehaviorCompilerLimits = LIMITS) {
  const parsed = parseSourceGraphContainer(bytes, limits);
  if (!parsed.ok) {
    const f = parsed.failure;
    return {
      ok: false,
      code: f.code,
      reason: f.reason,
      ...(f.limit !== undefined ? { limit: f.limit } : {}),
      ...(f.current !== undefined ? { current: f.current } : {}),
      ...(f.max !== undefined ? { max: f.max } : {}),
      ...(f.detail !== undefined ? { detail: f.detail } : {}),
    };
  }
  const analyzed = analyzeSourceGraph(parsed.container, M2_PINNED_MODULES, limits);
  if (!analyzed.ok) {
    const f = analyzed.failure;
    return {
      ok: false,
      code: f.code,
      reason: f.reason,
      ...(f.limit !== undefined ? { limit: f.limit } : {}),
      ...(f.current !== undefined ? { current: f.current } : {}),
      ...(f.max !== undefined ? { max: f.max } : {}),
      ...(f.detail !== undefined ? { detail: f.detail } : {}),
    };
  }
  const a = analyzed.analysis;
  return {
    ok: true,
    fileCount: a.fileCount,
    requiredModules: a.requiredModules,
    ownedTransforms: a.ownedTransforms,
    importDepth: a.importDepth,
    typeOnlyImports: a.typeOnlyImports,
    acceptedImports: a.acceptedImports,
    relativeEdges: a.relativeEdges,
  };
}

describe('packet 33 — source-graph container + static rules (project-model.md §22.1/§22.3)', () => {
  it('replays every committed fixture container with its exact outcome', () => {
    expect(index.cases.length).toBeGreaterThanOrEqual(30);
    const problems: string[] = [];
    for (const c of index.cases) {
      const derived = analyzeContainer(containerBytes(c.container));
      const pinned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c.expect)) {
        if (c.expect['ok'] === true && COMPILE_PRODUCT_KEYS.has(k)) continue;
        pinned[k] = v;
      }
      for (const p of expectMatches(pinned, derived)) problems.push(`${c.caseId}: ${p}`);
      // byte-length claim for the committed bytes
      if (new TextEncoder().encode(containerText(c.container)).length !== c.containerByteLength) {
        problems.push(`${c.caseId}: container byte length mismatch`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('accepts the valid sample and derives the §22.1 analysis fields', () => {
    const derived = analyzeContainer(containerBytes('valid/sample.json'));
    expect(derived).toMatchObject({
      ok: true,
      fileCount: 2,
      requiredModules: ['@thirdlight/runtime'],
      ownedTransforms: [],
      importDepth: 1,
      typeOnlyImports: 1,
      acceptedImports: 1,
      relativeEdges: [['src/index.ts', 'src/util.ts']],
    });
  });

  it('rejects a container with a reordered key set or extra whitespace (canonical bytes are the declaration)', () => {
    const text = containerText('valid/sample.json');
    const compact = JSON.stringify(JSON.parse(text));
    const derived = analyzeContainer(new TextEncoder().encode(compact));
    expect(derived).toMatchObject({ ok: false, code: 'behavior_source_invalid', reason: 'container' });
  });

  it('rejects an unknown top-level field instead of stripping it', () => {
    const value = JSON.parse(containerText('valid/sample.json')) as Record<string, unknown>;
    value['author'] = 'x';
    const derived = analyzeContainer(new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
    expect(derived).toMatchObject({ ok: false, code: 'behavior_source_invalid', reason: 'container' });
  });

  it('rejects an unpaired surrogate in file text (encoding)', () => {
    const value = JSON.parse(containerText('valid/sample.json')) as { files: { path: string; text: string }[] };
    (value.files[0] as { text: string }).text = 'export default { step() { return "\ud800"; } };\n';
    const derived = analyzeContainer(new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
    expect(derived).toMatchObject({ ok: false, code: 'behavior_source_invalid', reason: 'encoding' });
  });

  it('bounds the raw container bytes before parsing (graph_bytes)', () => {
    const big = new Uint8Array(300_000).fill(0x20);
    const derived = analyzeContainer(big);
    expect(derived).toMatchObject({
      ok: false,
      code: 'behavior_source_limits_exceeded',
      limit: 'graph_bytes',
      current: 300_000,
      max: LIMITS.graphBytes,
    });
  });

  it('honours a lowered bound override (files)', () => {
    const derived = analyzeContainer(containerBytes('valid/sample.json'), { ...LIMITS, files: 1 });
    expect(derived).toMatchObject({ ok: false, code: 'behavior_source_limits_exceeded', limit: 'files', current: 2, max: 1 });
  });
});
