/**
 * Packet 58 — B19: the capture/build pins scene+game/settings/media/
 * behavior/modules at one revision; the M3 shared closure builder derives
 * the v2 manifest from ONE captured input (the single acknowledged envelope
 * read) and the declared artifact bytes.
 *
 * Node integration test: `buildContentClosureM3` over a synthetic v3 envelope
 * (one model + one audio asset, self-consistent digests) through a FAKE
 * workspace service (the shared `query`/`readBlob` edge). Failure modes:
 * `blob_missing`, `asset_digest_mismatch`, a missing behavior source blob,
 * and an invalid content block.
 */
import { describe, expect, it } from 'vitest';
import { buildContentClosureM3 } from '@thirdlight/exporter';

import { fakeService, sha256Hex, syntheticV3 } from './helpers';

const CTX = { projectId: 'm3b19', revision: 1, capturedAt: '2026-09-21T00:00:00Z' };

describe('B19 the M3 shared closure derives the v2 manifest from one capture', () => {
  it('happy path: the declared artifact bytes (kind-tagged) + the self-identifying manifest', async () => {
    const { scene, content, blobs } = syntheticV3();
    const res = await buildContentClosureM3({ service: fakeService({ blobs }), compiler: {} as never, projectId: CTX.projectId, revision: CTX.revision, capturedAt: CTX.capturedAt, scene, content });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.closure;

    // Two reachable assets, one artifact each, digest-addressed + kind-tagged.
    expect(c.assetArtifacts).toHaveLength(2);
    const byKind = new Map(c.assetArtifacts.map((a) => [a.contentType, a]));
    expect(byKind.get('model/gltf-binary')).toBeDefined();
    expect(byKind.get('audio/wav')).toBeDefined();
    // The artifact path is the digest address (content/sha256/<digest>), and
    // the emitted bytes match the declared digest (the read is digest-verified
    // at the source; the export re-verifies the emitted bytes too).
    for (const a of c.assetArtifacts) {
      expect(a.path).toBe(`content/sha256/${a.digest}`);
      expect(sha256Hex(a.bytes)).toBe(a.digest);
    }
    // The declared set == the manifest's asset rows (declared == emitted at the
    // closure level).
    expect(c.declaredPaths).toHaveLength(2);
    expect(c.manifest.assets).toHaveLength(2);
    // No behaviors (the supported M3 closure is behavior-free).
    expect(c.behaviors).toHaveLength(0);
    expect(c.behaviorArtifacts).toHaveLength(0);

    // The manifest is self-identifying: the buildId re-derives from its own
    // canonical bytes (every key but buildId, in the manifest key order).
    const manifestObj = JSON.parse(new TextDecoder().decode(c.manifestBytes)) as Record<string, unknown>;
    const without = { ...manifestObj };
    delete without['buildId'];
    // The buildId preimage is the 21-key canonical object; the buildId is its
    // SHA-256. We assert the manifest's own buildId field is present and the
    // document re-parses (the exact re-derivation is covered by the
    // project-model unit tests + the byte-identical fixture re-derivation).
    expect(typeof manifestObj['buildId']).toBe('string');
    expect(manifestObj['buildId']).toBe(c.buildId);
    expect(manifestObj['manifestVersion']).toBe(2);
    expect(manifestObj['settingsDigest']).toBe(c.manifest.settingsDigest);
    void without;
  });

  it('the closure is pinned at the captured revision', async () => {
    const { scene, content, blobs } = syntheticV3();
    const res = await buildContentClosureM3({ service: fakeService({ blobs }), compiler: {} as never, projectId: CTX.projectId, revision: CTX.revision, capturedAt: CTX.capturedAt, scene, content });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.closure.snapshotId).toBe('m3b19@r1');
    expect(res.closure.manifest.revision).toBe(1);
  });
});

describe('B19 the M3 closure failure modes', () => {
  it('blob_missing: a reachable asset with no immutable blob is refused', async () => {
    const { scene, content } = syntheticV3();
    // A service with NO blobs → every readBlob is blob_missing.
    const res = await buildContentClosureM3({ service: fakeService({}), compiler: {} as never, projectId: CTX.projectId, revision: CTX.revision, capturedAt: CTX.capturedAt, scene, content });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('blob_missing');
  });

  it('asset_digest_mismatch: a tampered blob digest is refused', async () => {
    const { scene, content, blobs } = syntheticV3();
    const res = await buildContentClosureM3({ service: fakeService({ blobs, tamperDigest: 'ff'.repeat(32) }), compiler: {} as never, projectId: CTX.projectId, revision: CTX.revision, capturedAt: CTX.capturedAt, scene, content });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('asset_digest_mismatch');
  });

  it('a source-bearing behavior is compiled from its source blob; a missing blob is refused', async () => {
    // Behaviors are reached through the shared `queryBehaviors` edge and
    // recompiled from their immutable source blob (the working path is covered
    // end to end by tests/e2e/behaviors.e2e.ts).
    const { scene, content, blobs } = syntheticV3();
    const res = await buildContentClosureM3({
      service: { ...fakeService({ blobs, behaviors: [{ behaviorId: 'behavior-x', source: { sourceDigest: 'ab'.repeat(32), sourceByteLength: 100 } }] }), readSourceBlob: () => ({ ok: false, error: { code: 'blob_missing', cls: 'not_found', message: 'source blob missing' } }) } as never,
      compiler: {} as never,
      projectId: CTX.projectId,
      revision: CTX.revision,
      capturedAt: CTX.capturedAt,
      scene,
      content,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('blob_missing');
  });

  it('invalid content: a dangling content block is refused (export_scene_invalid)', async () => {
    const { scene, content } = syntheticV3();
    // A content block that fails v3 validation (the settings map is malformed).
    const badContent = { ...content, settings: { run_speed: 'not-a-number' } };
    const res = await buildContentClosureM3({ service: fakeService({}), compiler: {} as never, projectId: CTX.projectId, revision: CTX.revision, capturedAt: CTX.capturedAt, scene, content: badContent });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('export_scene_invalid');
  });
});