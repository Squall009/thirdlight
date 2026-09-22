/**
 * Packet-24 acceptance: determinism (project-model.md §18.8.3) — identical
 * bytes plus identical options must produce a byte-identical proposal and
 * identical recipe/metadata hashes, with no clock, PRNG, locale, environment or
 * network influence. Acceptance row A02 ("import recipe/source hashes").
 */

import { describe, expect, it, vi } from 'vitest';

import {
  importMetadataDigest,
  importRecipeDigest,
  inspectGlb,
  type ImportJobPort,
  type ImportOptions,
  type ImportProposal,
} from './index';
import { fixtureBytes } from './test-fixtures';

const tinyV1 = fixtureBytes('tiny-v1.glb');
const tinyV2 = fixtureBytes('tiny-v2.glb');
const countLimit = fixtureBytes('count-limit.glb');

function options(job?: ImportJobPort): ImportOptions {
  return {
    profile: 'gltf-glb',
    recipeVersion: 1,
    toolchain: { three: '0.186.0' },
    ...(job === undefined ? {} : { job }),
  };
}

function job(overrides: Partial<ImportJobPort> = {}): ImportJobPort {
  return {
    now: () => 0,
    isCancelled: () => false,
    proposalId: () => 'p-0123456789abcdef0123456789abcdef',
    stageId: () => 'stage-determinism',
    expiresAt: () => '2026-09-18T12:00:00Z',
    suggestedDisplayName: 'My Model',
    ...overrides,
  };
}

function snapshot(proposal: ImportProposal): string {
  return JSON.stringify(proposal);
}

describe('determinism', () => {
  it('two runs of the same bytes and options are byte-identical (no job port)', () => {
    const a = inspectGlb(tinyV1, options());
    const b = inspectGlb(tinyV1, options());
    expect(snapshot(a)).toBe(snapshot(b));
    expect(a.proposalId).toBe(b.proposalId);
    expect(a.sourceDigest).toBe(b.sourceDigest);
    expect(importRecipeDigest(a.importRecipe)).toBe(importRecipeDigest(b.importRecipe));
    expect(importMetadataDigest(a)).toBe(importMetadataDigest(b));
    // Pure inspection mode is explicitly identified (no staged source).
    expect(a.stageId).toBe('');
    expect(a.expiresAt).toBe('');
    expect(a.proposalId).toMatch(/^p-[0-9a-f]{32}$/);
  });

  it('two runs with equal job values are byte-identical (fresh port objects)', () => {
    const a = inspectGlb(tinyV1, options(job()));
    const b = inspectGlb(tinyV1, options(job()));
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it('the injected job identity does not affect the recipe or metadata digest', () => {
    const a = inspectGlb(tinyV1, options(job()));
    const b = inspectGlb(
      tinyV1,
      options(
        job({
          proposalId: () => 'p-ffffffffffffffffffffffffffffffff',
          stageId: () => 'stage-other',
          expiresAt: () => '2027-01-01T00:00:00Z',
          suggestedDisplayName: 'Renamed',
        }),
      ),
    );
    expect(a.proposalId).not.toBe(b.proposalId);
    expect(a.stageId).not.toBe(b.stageId);
    expect(importRecipeDigest(a.importRecipe)).toBe(importRecipeDigest(b.importRecipe));
    expect(importMetadataDigest(a)).toBe(importMetadataDigest(b));
  });

  it('does not read the system clock (wall time only enters via the job port)', () => {
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(1_000_000);
    const a = inspectGlb(tinyV1, options());
    spy.mockReturnValue(9_999_999_999);
    const b = inspectGlb(tinyV1, options());
    spy.mockRestore();
    expect(snapshot(a)).toBe(snapshot(b));
    expect(Date.now).not.toBe(spy);
  });

  it('truncated display lists are deterministic and flagged', () => {
    const index = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' } } as const;
    const a = inspectGlb(countLimit, { ...index, job: job() });
    const b = inspectGlb(countLimit, { ...index, job: job() });
    expect(a.inspection.truncated).toBe(true);
    expect(a.inspection.nodeNames.length).toBe(64);
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it('distinct sources of the same whole model keep the recipe digest and differ in metadata', () => {
    const v1 = inspectGlb(tinyV1, options(job()));
    const v2 = inspectGlb(tinyV2, options(job()));
    expect(importRecipeDigest(v1.importRecipe)).toBe(importRecipeDigest(v2.importRecipe));
    expect(importMetadataDigest(v1)).not.toBe(importMetadataDigest(v2));
    expect(v1.sourceDigest).not.toBe(v2.sourceDigest);
    // The metadata digest covers only persistable facts, so it is stable across
    // the non-persistent inspection lists (§18.1 rule 3 / §8).
    expect(importMetadataDigest(v1)).toBe(
      importMetadataDigest({
        ...v1,
        inspection: { nodeNames: [], materialNames: [], clipNames: [], sceneCount: 0, truncated: false },
        suggestedDisplayName: 'anything else',
        proposalId: 'p-00000000000000000000000000000000',
        stageId: 'stage-x',
        expiresAt: '2030-01-01T00:00:00Z',
      }),
    );
  });

  it('rejected proposals are deterministic too', () => {
    const bytes = fixtureBytes('accessor-overflow.glb');
    const a = inspectGlb(bytes, options(job()));
    const b = inspectGlb(bytes, options(job()));
    expect(snapshot(a)).toBe(snapshot(b));
  });
});
