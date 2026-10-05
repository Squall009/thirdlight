/**
 * `ModelFiles` Node tests.
 *
 * Browser-only pixel/WebGL behavior stays UNVERIFIED; these tests use the real
 * pinned GLTFLoader port and a synthetic self-contained GLB (the boundary
 * rules forbid importing another package's test helper or reading fixture
 * files), and assert the resource-ownership ledger instead of pixels.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createResourceManager } from '@thirdlight/runtime';
import { ModelFiles, type VisualDescriptor } from './model-files';

/** A minimal valid glTF 2.0 GLB (empty scene, no buffers). */
function tinyGlb(): Uint8Array {
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'thirdlight-editor-test' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4);
  jsonPadded.set(jsonBytes, 0);
  jsonPadded.fill(0x20, jsonBytes.length);
  const total = 12 + 8 + jsonPadded.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  return out;
}

function descriptor(assetId: string, version: number, byteLength: number): VisualDescriptor {
  return { assetId, version, sourceDigest: 'ab'.repeat(32), sourceByteLength: byteLength };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('ModelFiles — superseded preview disposal (GG-4)', () => {
  it('discards and disposes a stale successful preview instead of leaking it', async () => {
    const scene = new THREE.Scene();
    const bytes = tinyGlb();
    const len = bytes.byteLength;
    let calls = 0;
    const instances = new ModelFiles({
      resolve: async () => {
        calls += 1;
        return bytes;
      },
      descriptorFor: (assetId) => descriptor(assetId, 1, len),
    });

    // Both previews start in the same synchronous block: A's load settles
    // before B supersedes it, so A's late `.then` takes the stale branch.
    const a = instances.previewAsset(descriptor('asset-0000000000000001', 1, len), scene);
    const b = instances.previewAsset(descriptor('asset-0000000000000002', 1, len), scene);
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(['asset_load_stale', 'asset_load_cancelled']).toContain(ra.code);
    expect(rb.ok).toBe(true);

    // Only the surviving preview holder is attached to the scene.
    expect(instances.previewSession()?.assetId).toBe('asset-0000000000000002');
    expect(scene.children).toHaveLength(1);

    instances.dispose();
    expect(scene.children).toHaveLength(0);
    const own = instances.ownership();
    expect(own.outstanding).toBe(0);
    expect(own.allocations).toBe(own.releases);
  });
});

describe('ModelFiles — a preview and another read of the same file', () => {
  it('a piece or clip read started while the preview loads joins its load instead of superseding it', async () => {
    const scene = new THREE.Scene();
    const bytes = tinyGlb();
    const len = bytes.byteLength;
    let calls = 0;
    const instances = new ModelFiles({
      resolve: async () => {
        calls += 1;
        await flush();
        return bytes;
      },
      descriptorFor: (assetId) => descriptor(assetId, 1, len),
    });
    const id = 'asset-0000000000000004';
    const preview = instances.previewAsset(descriptor(id, 1, len), scene);
    const read = instances.prepared(id);
    const [p, r] = await Promise.all([preview, read]);
    expect(p.ok, JSON.stringify(p)).toBe(true);
    expect(r).not.toBeNull();
    expect(calls).toBe(1);
    expect(instances.previewSession()?.assetId).toBe(id);
    instances.clearPreview();
    instances.dispose();
    await flush();
    expect(instances.ownership().outstanding).toBe(0);
  });
});

describe('ModelFiles — a query holds a file only while it is handed over', () => {
  it('a piece or thumbnail read leaves nothing resident once the caller has it', async () => {
    const bytes = tinyGlb();
    const len = bytes.byteLength;
    const resources = createResourceManager();
    const files = new ModelFiles({ resolve: async () => bytes, descriptorFor: (assetId) => descriptor(assetId, 1, len), resources });
    expect(await files.prepared('m-q')).not.toBeNull();
    resources.settle();
    expect(resources.has('model', 'm-q@1')).toBe(false);
    files.dispose();
    resources.settle();
    expect(resources.observe().resident).toEqual({});
  });
});
