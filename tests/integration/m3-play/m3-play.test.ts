/**
 * Packet 59 — the v3 play-content build (B16/B19; delivery.md §2/§3).
 *
 * `buildPlayContentM3` (packages/backend/src/play-m3.ts) is the v3 counterpart
 * of the M2 `buildPlayContent`: a THIN consumer of the shared M3 closure
 * builder (`buildContentClosureM3`) that assembles the immutable v3 play
 * artifact set (the manifest v2 document, the v3 scene, the declared assets and
 * the prebuilt M3 bundle served as the entry). These Node tests prove the
 * build + its closed failure modes over a self-contained v3 envelope; the
 * real-backend + browser + SDK preview playthrough is the owner-run half
 * (UNVERIFIED in-container, packet-38 baseline §1).
 */
import { describe, expect, it } from 'vitest';

import { buildPlayContentM3 } from '../../../packages/backend/src/play-m3';
import type { WorkspaceService } from '@thirdlight/workspace';
import { sha256Hex, syntheticV3, fakeService } from '../m3-builds/helpers';
import {
  validateManifestV2,
  manifestBuildIdInputV2,
  type RuntimeContentManifestV2,
} from '@thirdlight/project-model';

const CTX = { projectId: 'demo-0005-play-v3', revision: 1, capturedAt: '2026-09-21T00:00:00Z' };
const GAME_BUNDLE = new Uint8Array([0x66, 0x75, 0x6e, 0x63, 0x74, 0x69, 0x6f, 0x6e]);

function sceneDoc() {
  const s = syntheticV3();
  return s.scene;
}

describe('buildPlayContentM3 (the v3 play artifact set)', () => {
  it('assembles the relative set: manifest.json (v2) + the declared assets + game.js (no scene.json — the scene rides the bridge)', async () => {
    const { scene, content, blobs } = syntheticV3();
    const res = await buildPlayContentM3({
      service: fakeService({ blobs }) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: CTX.projectId,
      revision: CTX.revision,
      capturedAt: CTX.capturedAt,
      scene,
      content,
      gameBundle: GAME_BUNDLE,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const built = res.built;

    // The v2 manifest is self-identifying and contract-valid.
    expect(built.manifest.manifestVersion).toBe(2);
    expect(built.buildId).toMatch(/^[0-9a-f]{64}$/);
    const preimage = manifestBuildIdInputV2(built.manifest as unknown as Record<string, unknown>);
    expect(preimage).not.toBeNull();
    expect(sha256Hex(preimage!)).toBe(built.buildId);
    const doc = JSON.parse(new TextDecoder().decode(built.manifestBytes)) as Record<string, unknown>;
    const v = validateManifestV2(doc, { scene, content });
    expect(v.ok).toBe(true);

    // The snapshot identity.
    expect(built.snapshotId).toBe(`${CTX.projectId}@r1`);
    expect(built.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    // The module set is derived from the declared dependencies (D17): the
    // game block, the controller entity and the model asset.
    expect(built.moduleIds).toEqual([
      'thirdlight.input:keyboard-gamepad',
      'thirdlight.physics-rapier:2d',
      'thirdlight.platformer-game:camera',
      'thirdlight.platformer-game:session',
      'thirdlight.platformer:controller',
      'thirdlight.three-adapter:gltf-loader',
    ]);

    // The complete artifact set (the accepted §17.2.1 locator route set —
    // manifest.json + assets + game.js). NO scene.json: the v3 scene arrives
    // via the nonce-verified tl.snapshot bridge; the manifest's sceneDigest is
    // the identity the preview verifies the bridge snapshot against.
    const byPath = new Map(built.artifacts.map((a) => [a.path, a]));
    expect(byPath.has('manifest.json')).toBe(true);
    expect(byPath.has('game.js')).toBe(true);
    expect(byPath.has('scene.json')).toBe(false);
    // The manifest carries the sceneDigest the bridge snapshot is verified against.
    expect(built.manifest.sceneDigest).toMatch(/^[0-9a-f]{64}$/);
    // The two declared assets at their digest-addressed paths (by kind).
    expect(built.manifest.assets.length).toBe(2);
    const kinds = new Set(built.manifest.assets.map((a) => a.kind));
    expect(kinds.has('model')).toBe(true);
    expect(kinds.has('audio')).toBe(true);
    for (const asset of built.manifest.assets) {
      const artifact = byPath.get(asset.path);
      expect(artifact, `artifact for ${asset.path}`).toBeDefined();
      if (asset.kind === 'model') expect(artifact?.contentType).toBe('model/gltf-binary');
      if (asset.kind === 'audio') expect(artifact?.contentType).toBe('audio/wav');
      // The artifact bytes re-hash to the declared digest.
      expect(sha256Hex(artifact!.bytes)).toBe(asset.sourceDigest);
    }
    // No behavior artifacts (M3 fails closed on behaviors — none here).
    expect(built.artifacts.every((a) => a.path !== 'behaviors/x.js')).toBe(true);
  });

  it('is manifest-version-agnostic to the store: the v2 manifest is opaque bytes with a stable digest', async () => {
    const { scene, content, blobs } = syntheticV3();
    const res = await buildPlayContentM3({
      service: fakeService({ blobs }) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: CTX.projectId,
      revision: CTX.revision,
      capturedAt: CTX.capturedAt,
      scene,
      content,
      gameBundle: GAME_BUNDLE,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Re-derive: a second identical build yields the same buildId + contentDigest (the captured-state is immutable at a revision).
    const res2 = await buildPlayContentM3({
      service: fakeService({ blobs }) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: CTX.projectId,
      revision: CTX.revision,
      capturedAt: CTX.capturedAt,
      scene,
      content,
      gameBundle: GAME_BUNDLE,
    });
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.built.buildId).toBe(res.built.buildId);
    expect(res2.built.contentDigest).toBe(res.built.contentDigest);
    expect(res2.built.manifestBytes).toEqual(res.built.manifestBytes);
  });

  it('refuses an over-cap game bundle (play_build_unavailable / game_bundle_bytes)', async () => {
    const { scene, content, blobs } = syntheticV3();
    const big = new Uint8Array(32 * 1024 * 1024 + 1);
    const res = await buildPlayContentM3({
      service: fakeService({ blobs }) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: CTX.projectId,
      revision: CTX.revision,
      capturedAt: CTX.capturedAt,
      scene,
      content,
      gameBundle: big,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('play_build_unavailable');
    expect(res.error.reason).toBe('game_bundle_bytes');
  });

  it('compiles source-bearing behaviors; a missing source blob fails closed', async () => {
    const { scene, content, blobs } = syntheticV3();
    const res = await buildPlayContentM3({
      service: {
        ...fakeService({
          blobs,
          behaviors: [{ behaviorId: 'behavior-x', source: { sourceDigest: 'ab'.repeat(32), sourceByteLength: 100 } }],
        }),
        readSourceBlob: () => ({ ok: false, error: { code: 'blob_missing', cls: 'not_found', message: 'source blob missing' } }),
      } as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: CTX.projectId,
      revision: CTX.revision,
      capturedAt: CTX.capturedAt,
      scene,
      content,
      gameBundle: GAME_BUNDLE,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('blob_missing');
  });

  it('surfaces the closure closed-set on a missing blob / digest mismatch', async () => {
    const { scene, content } = syntheticV3();
    // No blobs → the first asset read is blob_missing.
    const missing = await buildPlayContentM3({
      service: fakeService({}) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: CTX.projectId,
      revision: CTX.revision,
      capturedAt: CTX.capturedAt,
      scene,
      content,
      gameBundle: GAME_BUNDLE,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('blob_missing');

    const { blobs } = syntheticV3();
    const mismatch = await buildPlayContentM3({
      service: fakeService({ blobs, tamperDigest: 'ff'.repeat(32) }) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: CTX.projectId,
      revision: CTX.revision,
      capturedAt: CTX.capturedAt,
      scene,
      content,
      gameBundle: GAME_BUNDLE,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('asset_digest_mismatch');
  });
});