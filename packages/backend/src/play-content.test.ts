/**
 * Packet 35 — the immutable play build + locator store units: manifest
 * identity (`buildId` recomputation, key order, ordering), the locator path
 * classification, the TTL/terminal-grace lifetime, the closure caps and the
 * leak counters. Fast and deterministic (an injected clock).
 */
import { describe, expect, it } from 'vitest';
import { classifyLocatorPath, manifestBuildIdInput } from '@thirdlight/protocol';
import { BUILD_OPTIONS_DIGEST, PlayContentStore, captureRuntimeContentManifest, sha256HexBytes } from './play-content';

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

describe('captureRuntimeContentManifest (sessions.md §17.1.1)', () => {
  const input = {
    projectId: 'demo-0002',
    revision: 7,
    capturedAt: '2026-09-19T10:00:00Z',
    sceneDigest: '1'.repeat(64),
    contentDigest: '2'.repeat(64),
    assets: [ASSET],
    behaviors: [BEHAVIOR],
    moduleIds: ['thirdlight.physics-rapier:2d', 'thirdlight.platformer:controller'],
  };

  it('is self-identifying: buildId = SHA-256 of the canonical document without buildId', () => {
    const captured = captureRuntimeContentManifest(input);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const preimage = manifestBuildIdInput(captured.manifest as unknown as Record<string, unknown>);
    expect(preimage).not.toBeNull();
    expect(captured.buildId).toBe(sha256HexBytes(preimage as Uint8Array));
    expect(captured.manifest.buildId).toBe(captured.buildId);
    // The manifest document is canonical (2-space indent, LF, trailing newline).
    const text = new TextDecoder().decode(captured.bytes);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(captured.manifest);
  });

  it('orders assets by assetId/version, behaviors by behaviorId and names the required modules', () => {
    const captured = captureRuntimeContentManifest({
      ...input,
      assets: [ASSET, { ...ASSET, assetId: 'asset-0000', version: 2 }, { ...ASSET, assetId: 'asset-0000', version: 1 }],
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.manifest.assets.map((a) => `${a['assetId']}@${a['version']}`)).toEqual(['asset-0000@1', 'asset-0000@2', 'asset-0001@1']);
    expect(captured.manifest.behaviors[0]!['path']).toBe(`behaviors/${BEHAVIOR.outputDigest}.js`);
    expect(captured.manifest.modules.map((m) => m['id'])).toEqual(['thirdlight.physics-rapier:2d', 'thirdlight.platformer:controller']);
    expect(captured.manifest.buildOptionsDigest).toBe(BUILD_OPTIONS_DIGEST);
  });

  it('rejects a malformed digest', () => {
    const captured = captureRuntimeContentManifest({ ...input, sceneDigest: 'nope' });
    expect(captured.ok).toBe(false);
  });
});

describe('locator path classification (sessions.md §17.2.1)', () => {
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

describe('PlayContentStore (sessions.md §17.3/§17.4)', () => {
  const TTL = 900_000;
  const GRACE = 60_000;
  const makeStore = (nowRef: { t: number }, overrides: Partial<{ maxSetBytes: number; maxArtifactBytes: number }> = {}): PlayContentStore =>
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

  it('enforces the single-artifact and closure byte caps before publishing', () => {
    const nowRef = { t: 0 };
    const store = makeStore(nowRef, { maxArtifactBytes: 10, maxSetBytes: 20 });
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
    const tooLargeSet = store.publish({
      playSessionId: `play-${'4'.repeat(32)}`,
      projectId: 'demo-0001',
      revision: 1,
      snapshotId: 'demo-0001@r1',
      buildId: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      manifestBytes: new TextEncoder().encode('{}'),
      artifacts: [
        { path: 'a', bytes: new Uint8Array(10), digest: 'c'.repeat(64), contentType: 'text/javascript' },
        { path: 'b', bytes: new Uint8Array(10), digest: 'd'.repeat(64), contentType: 'text/javascript' },
      ],
    });
    expect(tooLargeSet.ok).toBe(false);
    if (!tooLargeSet.ok) expect(tooLargeSet.error.limit).toBe('closure_bytes');
    expect(store.counters().sets).toBe(0);
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
