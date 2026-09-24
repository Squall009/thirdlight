/**
 * Packet 27 repair — viewport `ModelInstances` Node tests (GG-4, GG-8).
 *
 * Browser-only pixel/WebGL behavior stays UNVERIFIED; these tests use the real
 * pinned GLTFLoader port and a synthetic self-contained GLB (the boundary
 * rules forbid importing another package's test helper or reading fixture
 * files), and assert the resource-ownership ledger instead of pixels.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ModelInstances, type VisualDescriptor } from './model-instances';
import type { ProjectedEntity } from '../session/projection';

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

function entity(id: string, assetId: string): ProjectedEntity {
  return {
    id,
    name: id,
    parentId: null,
    active: true,
    locked: false,
    static: false,
    tags: 0,
    kind: 'model',
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    assetId,
    components: {},
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('ModelInstances — superseded preview disposal (GG-4)', () => {
  it('discards and disposes a stale successful preview instead of leaking it', async () => {
    const scene = new THREE.Scene();
    const bytes = tinyGlb();
    const len = bytes.byteLength;
    let calls = 0;
    const instances = new ModelInstances(scene, {
      resolve: async () => {
        calls += 1;
        return bytes;
      },
      descriptorFor: (assetId) => descriptor(assetId, 1, len),
    });

    // Both previews start in the same synchronous block: A's load settles
    // before B supersedes it, so A's late `.then` takes the stale branch.
    const a = instances.previewAsset(descriptor('asset-0000000000000001', 1, len));
    const b = instances.previewAsset(descriptor('asset-0000000000000002', 1, len));
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

describe('ModelInstances — bounded failed-load retry (GG-8)', () => {
  it('stops re-issuing a persistently failing load after the bounded attempts', async () => {
    const scene = new THREE.Scene();
    let calls = 0;
    const instances = new ModelInstances(scene, {
      resolve: async () => {
        calls += 1;
        return new Uint8Array([0, 1, 2, 3]); // never a valid GLB
      },
      descriptorFor: (assetId) => descriptor(assetId, 1, 4),
    });
    const entities = [entity('model-0001', 'asset-0000000000000003')];

    for (let i = 0; i < 6; i += 1) {
      instances.sync(entities);
      await flush();
    }
    expect(calls).toBe(2); // FAILED_LOAD_RETRY_LIMIT — no hammering
    expect(instances.failures.size).toBe(1);

    instances.dispose();
    expect(instances.ownership().outstanding).toBe(0);
  });
});
