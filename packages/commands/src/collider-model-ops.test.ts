/**
 * `colliderFromModel`: its arguments and the planner over a model file (the
 * object's model at its latest version, the kind for the project's dimension).
 */
import { describe, expect, it } from 'vitest';

import { planModelCollider, validateColliderFromModelArgs } from './collider-model-ops';
import type { ContentDocument, SceneDocument } from './types';

/** A GLB of one `crate_LOD0` cube (0..1 on every axis) and a `crate_COL` node holding that cube moved up 2 m. */
function crateGlb(): Uint8Array {
  const corners: number[] = [];
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) corners.push(x, y, z);
  const pos = new Float32Array(corners);
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'crate_LOD0', mesh: 0 }, { name: 'crate_COL', children: [2] }, { name: 'part', mesh: 0, translation: [0, 2, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
    buffers: [{ byteLength: pos.byteLength }],
  }));
  const jlen = Math.ceil(json.length / 4) * 4;
  const out = new Uint8Array(20 + jlen + 8 + pos.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jlen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jlen);
  out.set(json, 20);
  dv.setUint32(20 + jlen, pos.byteLength, true);
  dv.setUint32(24 + jlen, 0x004e4942, true);
  out.set(new Uint8Array(pos.buffer), 28 + jlen);
  return out;
}

const scene = { schemaVersion: 4, sceneId: 'main', revision: 1, entities: [{ id: 'crate-0001', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, model: { asset: { assetId: 'model-crate' }, piece: 'crate' } } }] } as unknown as SceneDocument;
const content = (dimension: 2 | 3): ContentDocument => ({ settings: { physics_dimension: dimension }, assets: [{ assetId: 'model-crate', kind: 'model', versions: [{ version: 1 }, { version: 2 }] }] }) as unknown as ContentDocument;

describe('colliderFromModel', () => {
  it('takes an object and a kind', () => {
    expect(validateColliderFromModelArgs({ entityId: 'crate-0001', kind: 'compound' }).ok).toBe(true);
    expect(validateColliderFromModelArgs({ entityId: 'crate-0001', kind: 'sphere' })).toMatchObject({ ok: false, error: { path: '/args/kind' } });
    expect(validateColliderFromModelArgs({ entityId: 'crate-0001' })).toMatchObject({ ok: false, error: { path: '/args/kind' } });
    expect(validateColliderFromModelArgs({ entityId: 'crate-0001', kind: 'box', extra: 1 })).toMatchObject({ ok: false, error: { path: '/args/extra' } });
  });

  it('reads the object\'s model at its latest version and makes the kind for the project\'s dimension', () => {
    const reads: string[] = [];
    const read = (assetId: string, version: number) => {
      reads.push(`${assetId}@${version}`);
      return { ok: true as const, bytes: crateGlb() };
    };
    const box = planModelCollider(scene, content(3), { entityId: 'crate-0001', kind: 'box' }, read);
    expect(box).toMatchObject({ ok: true, prepared: { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5, center: [0.5, 0.5, 0.5] } }, source: 'geometry' });
    expect(reads).toEqual(['model-crate@2']);
    const hull = planModelCollider(scene, content(3), { entityId: 'crate-0001', kind: 'convex' }, read);
    expect(hull.ok && hull.source).toBe('collision');
    expect(hull.ok && (hull.prepared.shape['points'] as number[][])).toContainEqual([1, 3, 1]);
    const poly = planModelCollider(scene, content(2), { entityId: 'crate-0001', kind: 'polygon' }, read);
    expect(poly.ok && poly.prepared.shape).toEqual({ type: 'polygon', vertices: [[0, 2], [1, 2], [1, 3], [0, 3]] });
    // A 3D kind on the plane is refused with the reason.
    expect(planModelCollider(scene, content(2), { entityId: 'crate-0001', kind: 'mesh' }, read)).toMatchObject({ ok: false, error: { path: '/args/kind' } });
    // Points primitives have no triangles: a mesh from them is refused.
    expect(planModelCollider(scene, content(3), { entityId: 'crate-0001', kind: 'mesh' }, read)).toMatchObject({ ok: false });
    expect(planModelCollider(scene, content(3), { entityId: 'nobody', kind: 'box' }, read)).toMatchObject({ ok: false, error: { code: 'entity_not_found' } });
  });
});
