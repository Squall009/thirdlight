/**
 * Behavior publication (editor-side): the trust notice, the typed command
 * args and the trust/declaration projection.
 *
 * No browser: the DOM transport (`session/client.ts`) is exercised by the
 * browser tests; these tests pin the pure decisions.
 */
import { describe, expect, it } from 'vitest';
import { BEHAVIOR_TRUST_NOTICE, planAcknowledgeTrust, planPublishDeclaration, planPublishSource } from './behavior-publication';
import { PrefabProjection } from './prefab-projection';
import type { BehaviorRecord } from '@thirdlight/project-model';

const DIGEST_A = 'a'.repeat(64);

describe('trust notice', () => {
  it('states no hard timeout, no hostile-code sandbox and the origin/credentials rule', () => {
    const text = BEHAVIOR_TRUST_NOTICE.join('\n');
    expect(text).toMatch(/NO hard runtime timeout/i);
    expect(text).toMatch(/cannot be interrupted/i);
    expect(text).toMatch(/NO hostile-code sandbox/i);
    expect(text).toMatch(/defense in depth/i);
    expect(text).toMatch(/not a sandbox/i);
    expect(text).toMatch(/no authoring credentials/i);
    expect(text).toMatch(/no project filesystem handle/i);
    // Scripts run in the simulation worker by default; the notice names both threads.
    expect(text).toMatch(/simulation worker/i);
    expect(text).toMatch(/main thread/i);
    // It must not claim containment.
    expect(text).not.toMatch(/sandboxed|isolated from|safe to run untrusted/i);
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

describe('trust projection', () => {
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
