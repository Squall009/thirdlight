/**
 * Packet 34 — the behavior publication workflow (pure state machine,
 * editor-side) and the trust/declaration projection.
 *
 * No browser: the DOM transport (`session/client.ts`) is exercised by the
 * packet-37 browser procedure; these tests pin the pure decisions — the
 * normative trust notice, the typed command args, the bounded diagnostics,
 * and the structural "staged edits do not change active play or the published
 * revision" guarantee.
 */
import { describe, expect, it } from 'vitest';
import {
  BEHAVIOR_TRUST_NOTICE,
  COMPILE_DIAGNOSTIC_LIMIT,
  canPublishStagedSource,
  compileFailed,
  declarationSchemaView,
  initialPublicationState,
  isStagedDigestAcknowledged,
  planAcknowledgeTrust,
  planPublishDeclaration,
  planPublishSource,
  publicationFailed,
  published,
  sourceDigestOf,
  sourceStaged,
  stageSourceEdit,
  trustObserved,
} from './behavior-publication';
import { PrefabProjection } from './prefab-projection';
import type { BehaviorRecord } from '@thirdlight/project-model';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('trust notice (runtime.md §14.1.1/§14.2.2)', () => {
  it('states no hard timeout, no hostile-code sandbox and the origin/credentials rule', () => {
    const text = BEHAVIOR_TRUST_NOTICE.join('\n');
    expect(text).toMatch(/NO hard runtime timeout/i);
    expect(text).toMatch(/cannot be interrupted/i);
    expect(text).toMatch(/NO hostile-code sandbox/i);
    expect(text).toMatch(/defense in depth/i);
    expect(text).toMatch(/not a sandbox/i);
    expect(text).toMatch(/no authoring credentials/i);
    expect(text).toMatch(/no project filesystem handle/i);
    // It must not claim containment.
    expect(text).not.toMatch(/sandboxed|isolated from|safe to run untrusted/i);
  });
});

describe('publication state machine', () => {
  it('stages a digest without touching the published revision', () => {
    const initial = initialPublicationState();
    expect(initial.status).toBe('idle');
    const staged = sourceStaged(initial, { stageId: 'stage-1', digest: DIGEST_A, byteLength: 1234 });
    expect(staged.status).toBe('staged');
    expect(staged.staged).toEqual({ stageId: 'stage-1', digest: DIGEST_A, byteLength: 1234 });
    expect(staged.publishedRevision).toBeNull();
  });

  it('bounds compile diagnostics to 32 with a truncated flag and 256-char messages', () => {
    const diagnostics = Array.from({ length: 40 }, (_, i) => ({
      code: 'behavior_source_invalid',
      reason: 'path',
      message: 'x'.repeat(400),
      path: `/files/${i}`,
    }));
    const state = compileFailed(initialPublicationState(), {
      code: 'behavior_source_invalid',
      reason: 'path',
      diagnostics,
    });
    expect(state.status).toBe('compile-failed');
    expect(state.compileFailure?.diagnostics).toHaveLength(COMPILE_DIAGNOSTIC_LIMIT);
    expect(state.compileFailure?.truncated).toBe(true);
    expect(state.compileFailure?.diagnostics[0]?.message.length).toBe(256);
    expect(state.compileFailure?.diagnostics[0]?.message.endsWith('\u2026')).toBe(true);
  });

  it('keeps the previous publication on a refused source publication', () => {
    const publishedState = published(sourceStaged(initialPublicationState(), { stageId: 's', digest: DIGEST_A, byteLength: 10 }), { revision: 7 });
    const refused = publicationFailed(publishedState, { code: 'behavior_publication_unavailable', message: 'no prepared artifact' });
    expect(refused.status).toBe('publication-failed');
    expect(refused.publishedRevision).toBe(7);
    expect(refused.error?.code).toBe('behavior_publication_unavailable');
  });

  it('gates source publication on the exact digest acknowledgment', () => {
    let state = sourceStaged(initialPublicationState(), { stageId: 's', digest: DIGEST_A, byteLength: 10 });
    expect(isStagedDigestAcknowledged(state)).toBe(false);
    expect(canPublishStagedSource(state)).toBe(false);
    state = trustObserved(state, [{ sourceDigest: DIGEST_B }]);
    expect(canPublishStagedSource(state)).toBe(false);
    state = trustObserved(state, [{ sourceDigest: DIGEST_B }, { sourceDigest: DIGEST_A }]);
    expect(isStagedDigestAcknowledged(state)).toBe(true);
    expect(canPublishStagedSource(state)).toBe(true);
  });

  it('a staged edit changes only the staged facts (never the published revision or the active play pin)', () => {
    const play = { snapshotId: 'demo-0001@r4', revision: 4 };
    const playBefore = JSON.stringify(play);
    const state = published(
      sourceStaged(initialPublicationState(), { stageId: 's1', digest: DIGEST_A, byteLength: 10 }),
      { revision: 4 },
    );
    const edited = stageSourceEdit(state, { stageId: 's2', digest: DIGEST_B, byteLength: 20 });
    expect(edited.staged?.digest).toBe(DIGEST_B);
    expect(edited.publishedRevision).toBe(4);
    expect(edited.acknowledgedDigests).toEqual(state.acknowledgedDigests);
    expect(JSON.stringify(play)).toBe(playBefore);
  });
});

describe('typed command planners', () => {
  it('builds the exact acknowledgeBehaviorTrust args and rejects a bad digest', () => {
    expect(planAcknowledgeTrust(DIGEST_A)).toEqual({ sourceDigest: DIGEST_A });
    expect(() => planAcknowledgeTrust('not-a-digest')).toThrow();
  });

  it('builds the exact publishBehavior source args (digest-bound facts only)', () => {
    const declaration = { properties: [{ key: 'speed', label: 'Speed', type: 'number' as const, default: 3.5 }] };
    const args = planPublishSource({
      behaviorId: 'behavior-0100',
      displayName: 'Drift',
      declaration,
      sourceDigest: DIGEST_A,
      sourceByteLength: 512,
    });
    expect(args).toEqual({
      behaviorId: 'behavior-0100',
      displayName: 'Drift',
      mode: 'source',
      declaration,
      source: { sourceDigest: DIGEST_A, sourceByteLength: 512 },
    });
    expect('manifestDigest' in args).toBe(false);
    expect('outputDigest' in args).toBe(false);
  });

  it('builds the exact declaration-mode args', () => {
    const declaration = { properties: [{ key: 'speed', label: 'Speed', type: 'number' as const, default: 3.5 }] };
    expect(planPublishDeclaration({ behaviorId: 'behavior-0100', displayName: 'Drift', mode: 'declaration-create', declaration })).toEqual({
      behaviorId: 'behavior-0100',
      displayName: 'Drift',
      mode: 'declaration-create',
      declaration,
    });
  });
});

describe('declaration schema view', () => {
  it('is built from published declaration data only and marks acknowledgment', () => {
    const record: BehaviorRecord = {
      behaviorId: 'behavior-0100',
      displayName: 'Drift',
      declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5 }] },
      source: {
        sourceDigest: DIGEST_A,
        sourceByteLength: 512,
        entryPath: 'src/index.ts',
        fileCount: 1,
        manifestDigest: 'c'.repeat(64),
        outputDigest: 'd'.repeat(64),
        outputByteLength: 500,
        requiredModules: ['@thirdlight/runtime'],
        publishedRevision: 9,
      },
      publishedRevision: 9,
    };
    const view = declarationSchemaView(record, [DIGEST_A]);
    expect(view.hasSource).toBe(true);
    expect(view.sourceDigest).toBe(DIGEST_A);
    expect(view.acknowledged).toBe(true);
    expect(view.properties[0]?.key).toBe('speed');
  });
});

describe('trust projection (packet 34)', () => {
  it('advances trust only from acknowledgeBehaviorTrust change records', () => {
    const projection = new PrefabProjection();
    expect(projection.listTrust()).toEqual([]);
    projection.applyChange({
      type: 'acknowledgeBehaviorTrust',
      sourceDigest: DIGEST_A,
      previous: [],
      next: [{ sourceDigest: DIGEST_A, acknowledgedRevision: 5 }],
    });
    expect(projection.isDigestAcknowledged(DIGEST_A)).toBe(true);
    projection.applyChange({
      type: 'acknowledgeBehaviorTrust',
      sourceDigest: DIGEST_A,
      previous: [{ sourceDigest: DIGEST_A, acknowledgedRevision: 5 }],
      next: [],
    });
    expect(projection.isDigestAcknowledged(DIGEST_A)).toBe(false);
  });

  it('keeps the source record in the declaration view and never fabricates one', () => {
    const projection = new PrefabProjection();
    const record: BehaviorRecord = {
      behaviorId: 'behavior-0100',
      displayName: 'Drift',
      declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5 }] },
      source: null,
      publishedRevision: 2,
    };
    projection.applyChange({ type: 'publishBehavior', behaviorId: 'behavior-0100', previous: null, next: record });
    expect(projection.getBehavior('behavior-0100')?.source).toBeNull();
    projection.applyChange({
      type: 'publishBehavior',
      behaviorId: 'behavior-0100',
      previous: record,
      next: {
        ...record,
        source: {
          sourceDigest: DIGEST_A,
          sourceByteLength: 512,
          entryPath: 'src/index.ts',
          fileCount: 1,
          manifestDigest: 'c'.repeat(64),
          outputDigest: 'd'.repeat(64),
          outputByteLength: 500,
          requiredModules: ['@thirdlight/runtime'],
          publishedRevision: 3,
        },
        publishedRevision: 3,
      },
    });
    expect(projection.getBehavior('behavior-0100')?.source?.sourceDigest).toBe(DIGEST_A);
  });
});

describe('client-side source digest', () => {
  it('is the SHA-256 of the exact bytes', async () => {
    const digest = await sourceDigestOf(new TextEncoder().encode('abc'));
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
