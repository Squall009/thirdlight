/**
 * The immutable play build + locator store units: manifest
 * identity (`buildId` recomputation, key order, ordering), the locator path
 * classification, the TTL/terminal-grace lifetime, the closure caps and the
 * leak counters. Fast and deterministic (an injected clock).
 */
import { describe, expect, it } from 'vitest';
import { classifyLocatorPath } from '@thirdlight/protocol';
import { PlayContentStore } from './play-content';

const ASSET = {
  assetId: 'asset-0001',
  version: 1,
  sourceDigest: 'a'.repeat(64),
  sourceByteLength: 26,
  recipeDigest: 'b'.repeat(64),
  metricsDigest: 'c'.repeat(64),
};
const BEHAVIOR = {
  behaviorId: 'behavior-0001',
  sourceDigest: 'd'.repeat(64),
  sourceByteLength: 120,
  manifestDigest: 'e'.repeat(64),
  outputDigest: 'f'.repeat(64),
  outputByteLength: 200,
  apiVersion: 1,
  declaration: { properties: [] },
  ownedTransforms: ['model-0001'],
  requiredModules: ['@thirdlight/runtime'],
};

describe('locator path classification', () => {
  const id = 'A'.repeat(43);
  it('accepts exactly the declared routes', () => {
    expect(classifyLocatorPath(`/play-content/${id}`).kind).toBe('shell');
    expect(classifyLocatorPath(`/play-content/${id}/`).kind).toBe('shell');
    expect(classifyLocatorPath(`/play-content/${id}/manifest.json`).kind).toBe('manifest');
    expect(classifyLocatorPath(`/play-content/${id}/game.js`).kind).toBe('game');
    const asset = classifyLocatorPath(`/play-content/${id}/content/asset-0001/2`);
    expect(asset.kind).toBe('asset');
    const digest = classifyLocatorPath(`/play-content/${id}/content/sha256/${'a'.repeat(64)}`);
    expect(digest.kind).toBe('asset-digest');
    expect(classifyLocatorPath(`/play-content/${id}/behaviors/${'b'.repeat(64)}.js`).kind).toBe('behavior');
  });
  it('rejects listings, traversal, undeclared paths and malformed identifiers', () => {
    expect(classifyLocatorPath('/play-content/').kind).toBe('invalid');
    expect(classifyLocatorPath('/play-content').kind).toBe('invalid');
    expect(classifyLocatorPath(`/play-content/${id}/..`).kind).toBe('invalid');
    expect(classifyLocatorPath(`/play-content/${id}/content/asset-0001/0`).kind).toBe('invalid');
    expect(classifyLocatorPath(`/play-content/${id}/content/../etc/passwd`).kind).toBe('invalid');
    expect(classifyLocatorPath(`/play-content/${id}/behaviors/nothex.js`).kind).toBe('invalid');
    expect(classifyLocatorPath(`/play-content/${id}/secrets.txt`).kind).toBe('invalid');
    expect(classifyLocatorPath(`/play-content/${'short'}/manifest.json`).kind).toBe('invalid');
  });
});

describe('PlayContentStore', () => {
  const TTL = 900_000;
  const GRACE = 60_000;
  const makeStore = (nowRef: { t: number }, overrides: Partial<{ maxArtifactBytes: number }> = {}): PlayContentStore =>
    new PlayContentStore({
      now: () => nowRef.t,
      ttlMs: TTL,
      graceMs: GRACE,
      randomId: (() => {
        let n = 0;
        return () => `${String(n++).padStart(43, 'A')}`;
      })(),
      sweepMs: 0,
      ...overrides,
    });

  const publish = (store: PlayContentStore, playSessionId: string): string => {
    const result = store.publish({
      playSessionId,
      projectId: 'demo-0001',
      revision: 1,
      snapshotId: 'demo-0001@r1',
      buildId: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      manifestBytes: new TextEncoder().encode('{}\n'),
      artifacts: [{ path: 'game.js', bytes: new TextEncoder().encode('x'), digest: 'c'.repeat(64), contentType: 'text/javascript' }],
    });
    expect(result.ok).toBe(true);
    return result.ok ? result.contentId : '';
  };

  it('serves a live locator, expires it at the TTL, and reports the remaining max-age', () => {
    const nowRef = { t: 0 };
    const store = makeStore(nowRef);
    const contentId = publish(store, `play-${'1'.repeat(32)}`);
    const set = store.get(contentId)!;
    expect(store.status(set)).toBe('live');
    expect(store.remainingMaxAge(set)).toBe(900);
    nowRef.t = 899_000;
    expect(store.status(set)).toBe('live');
    expect(store.remainingMaxAge(set)).toBe(1);
    nowRef.t = 900_001;
    expect(store.status(set)).toBe('expired');
    expect(store.remainingMaxAge(set)).toBe(0);
  });

  it('a terminal play keeps a 60 s read grace, then expires', () => {
    const nowRef = { t: 0 };
    const store = makeStore(nowRef);
    const playSessionId = `play-${'2'.repeat(32)}`;
    const contentId = publish(store, playSessionId);
    const set = store.get(contentId)!;
    nowRef.t = 100_000;
    store.markTerminal(playSessionId);
    nowRef.t = 150_000;
    expect(store.status(set)).toBe('grace');
    nowRef.t = 160_001;
    expect(store.status(set)).toBe('expired');
  });

  it('caps each held artifact, not the set; files it serves from disk are never held', () => {
    const nowRef = { t: 0 };
    const store = makeStore(nowRef, { maxArtifactBytes: 10 });
    const tooBig = store.publish({
      playSessionId: `play-${'3'.repeat(32)}`,
      projectId: 'demo-0001',
      revision: 1,
      snapshotId: 'demo-0001@r1',
      buildId: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      manifestBytes: new TextEncoder().encode('{}'),
      artifacts: [{ path: 'game.js', bytes: new Uint8Array(11), digest: 'c'.repeat(64), contentType: 'text/javascript' }],
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error.limit).toBe('artifact_bytes');
    expect(store.counters().sets).toBe(0);
    // Many held artifacts under the per-file cap, and a file far larger than it: the set publishes.
    const many = store.publish({
      playSessionId: `play-${'4'.repeat(32)}`,
      projectId: 'demo-0001',
      revision: 1,
      snapshotId: 'demo-0001@r1',
      buildId: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      manifestBytes: new TextEncoder().encode('{}'),
      artifacts: [
        ...Array.from({ length: 64 }, (_, i) => ({ path: `scenes/s${i}.json`, bytes: new Uint8Array(10).fill(i), digest: i.toString(16).padStart(64, '0'), contentType: 'application/json' })),
        { path: `content/sha256/${'e'.repeat(64)}`, digest: 'e'.repeat(64), byteLength: 1 << 30, contentType: 'audio/x-audio', file: { digest: 'e'.repeat(64), byteLength: 1 << 30, real: '/nonexistent' } },
      ],
    });
    expect(many.ok).toBe(true);
    // What the store holds is the manifest and the held artifacts only (the file's bytes are on disk).
    expect(store.counters().bytes).toBe(2 + 64 * 10);
  });

  it('prunes expired sets only after the retention window and counts its timers', () => {
    const nowRef = { t: 0 };
    const store = makeStore(nowRef);
    const contentId = publish(store, `play-${'5'.repeat(32)}`);
    nowRef.t = 900_001;
    expect(store.prune()).toBe(0); // still resolvable as expired (503), not yet pruned
    nowRef.t = 900_000 + TTL;
    expect(store.prune()).toBe(1);
    expect(store.get(contentId)).toBeUndefined();
    expect(store.counters().sets).toBe(0);
    expect(store.counters().timers).toBe(0); // sweepMs: 0 ⇒ no interval
    store.dispose();
  });

  it('allocates a fresh, unguessable capability per play and never reuses one', () => {
    const nowRef = { t: 0 };
    const store = new PlayContentStore({ now: () => nowRef.t, sweepMs: 0 });
    const ids = new Set<string>();
    for (let i = 0; i < 8; i += 1) ids.add(publish(store, `play-${String(i).repeat(32)}`));
    expect(ids.size).toBe(8);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    store.dispose();
  });
});
