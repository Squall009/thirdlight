import { describe, it, expect } from 'vitest';
import { ContentProjection } from './content-projection';
import { Projection, type ProjectedEntity } from './projection';
import type { AssetRecord, EntityV3 as Entity } from '@thirdlight/project-model';
import type { AssetSummary } from '@thirdlight/commands';

const DIGEST_V1 = 'a'.repeat(64);
const DIGEST_V2 = 'b'.repeat(64);

const METRICS = {
  nodes: 2,
  meshes: 1,
  primitives: 1,
  materials: 2,
  images: 0,
  textures: 0,
  vertices: 24,
  triangles: 12,
  animations: 1,
  animationChannels: 3,
  clipDurationMs: 1000,
  decodedGeometryBytes: 1024,
  decodedImageBytes: 0,
};

const RECIPE = { profile: 'gltf-glb' as const, recipeVersion: 1 as const, toolchain: { three: '0.186.0' }, extensions: [] };

function record(version: number, digest: string): AssetRecord {
  const versions = [];
  for (let v = 1; v <= version; v += 1) {
    versions.push({
      version: v,
      sourceDigest: v === version ? digest : DIGEST_V1,
      sourceByteLength: 100 + v,
      importRecipe: RECIPE,
      metrics: METRICS,
      importedAt: '2026-09-18T00:00:00Z',
      publishedRevision: v,
    });
  }
  return { assetId: 'asset-0001', kind: 'model', displayName: `Rock v${version}`, currentVersion: version, versions };
}

function summary(a: AssetRecord): AssetSummary {
  return {
    assetId: a.assetId,
    kind: a.kind,
    displayName: a.displayName,
    currentVersion: a.currentVersion,
    versionCount: a.versions.length,
    versions: a.versions.map((v) => ({ version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength })),
  };
}

/** A model entity referencing an asset (the placement shape). */
function modelEntity(id: string, assetId: string, x: number): Entity {
  return {
    id,
    name: id,
    components: {
      transform: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      // The M1 Entity type predates `model`; the projection reads it structurally.
      ...({ model: { asset: { assetId } } } as unknown as Record<string, never>),
    },
  };
}

describe('packet 27 — content projection (sessions.md §8/§19.4)', () => {
  it('hydrates from full state and lists assets in ascending assetId order', () => {
    const c = new ContentProjection();
    c.hydrate({
      assets: [
        { assetId: 'asset-0002', kind: 'model', displayName: 'B', currentVersion: 1, versionCount: 1 },
        { assetId: 'asset-0001', kind: 'model', displayName: 'A', currentVersion: 2, versionCount: 2 },
      ],
    });
    expect(c.listAssets().map((a) => a.assetId)).toEqual(['asset-0001', 'asset-0002']);
    expect(c.currentVersion('asset-0001')).toBe(2);
    expect(c.currentVersion('asset-missing')).toBeNull();
    expect(c.size).toBe(2);
  });

  it('a reimport change advances currentVersion while entity IDs/transforms stay identical', () => {
    const scene = new Projection();
    const entities = [modelEntity('model-0001', 'asset-0001', 1), modelEntity('model-0002', 'asset-0001', 2)];
    scene.hydrate({ revision: 4, entities });
    const before = scene.listEntities().map((e) => ({ ...e, position: [...e.position] }));

    const c = new ContentProjection();
    c.hydrate({ assets: [summary(record(1, DIGEST_V1))] });
    expect(c.resolveVersion('asset-0001')).toEqual({ version: 1, sourceDigest: DIGEST_V1, sourceByteLength: 101 });

    // The reimport applies through the scene projection (one revision) and the
    // content projection consumes the SAME change record.
    const applied = scene.applyMutationApplied({
      requestId: 'req-reimport',
      revision: 5,
      change: { type: 'publishAsset', mode: 'reimport', assetId: 'asset-0001', previous: record(1, DIGEST_V1), next: record(2, DIGEST_V2) },
    });
    expect(applied).toEqual({ deduped: false, gap: false, applied: true });
    c.applyChange({ type: 'publishAsset', mode: 'reimport', assetId: 'asset-0001', previous: record(1, DIGEST_V1), next: record(2, DIGEST_V2) });

    expect(c.currentVersion('asset-0001')).toBe(2);
    expect(c.resolveVersion('asset-0001')).toEqual({ version: 2, sourceDigest: DIGEST_V2, sourceByteLength: 102 });
    // Both placements keep their IDs, transforms and asset references.
    const after = scene.listEntities();
    expect(after.map((e) => e.id)).toEqual(['model-0001', 'model-0002']);
    expect(after.map((e) => e.position)).toEqual([
      [1, 0, 0],
      [2, 0, 0],
    ]);
    expect(after.map((e) => e.assetId)).toEqual(['asset-0001', 'asset-0001']);
    expect(after).toEqual(before);
  });

  it('the scene projection handles instantiatePrefab entries and setComponent(model)', () => {
    const scene = new Projection();
    scene.hydrate({ revision: 1, entities: [modelEntity('model-0001', 'asset-0001', 0)] });
    const change = {
      type: 'instantiatePrefab' as const,
      prefabId: 'prefab-0001',
      rootId: 'model-0002',
      entries: [
        { index: 1, entity: modelEntity('model-0002', 'asset-0001', 1) as never },
        { index: 2, entity: modelEntity('model-0003', 'asset-0001', 2) as never },
      ],
      mapping: [
        { localId: 'model-0001', entityId: 'model-0002' },
        { localId: 'model-0001', entityId: 'model-0003' },
      ],
    };
    const r = scene.applyMutationApplied({ requestId: 'req-place', revision: 2, change });
    expect(r.applied).toBe(true);
    expect(scene.entityOrder).toEqual(['model-0001', 'model-0002', 'model-0003']);
    // Two placements: distinct entity IDs, independent transforms.
    expect(scene.getEntity('model-0002')?.position).toEqual([1, 0, 0]);
    expect(scene.getEntity('model-0003')?.position).toEqual([2, 0, 0]);
    expect(scene.getEntity('model-0002')?.kind).toBe('model');
    expect(scene.getEntity('model-0002')?.assetId).toBe('asset-0001');

    scene.applyMutationApplied({
      requestId: 'req-setcomponent',
      revision: 3,
      change: { type: 'setComponent', id: 'model-0003', component: 'model', previous: { asset: { assetId: 'asset-0001' } }, next: { asset: { assetId: 'asset-0002' } }, changedFields: ['asset'] },
    });
    expect(scene.getEntity('model-0003')?.assetId).toBe('asset-0002');
  });

  it('reports unresolved placement references instead of merging partial state', () => {
    const c = new ContentProjection();
    c.hydrate({ assets: [summary(record(1, DIGEST_V1))] });
    const entities: ProjectedEntity[] = [
      { id: 'model-0001', name: 'a', parentId: null, kind: 'model', active: true, locked: false, static: false, tags: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], assetId: 'asset-0001' },
      { id: 'model-0002', name: 'b', parentId: null, kind: 'model', active: true, locked: false, static: false, tags: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], assetId: 'asset-gone' },
    ];
    expect(c.referencedAssetIds(entities)).toEqual(['asset-0001', 'asset-gone']);
    expect(c.unresolvedReferences(entities)).toEqual(['asset-gone']);
  });

  it('an undo of a create removes the record; content-only changes never touch the scene', () => {
    const c = new ContentProjection();
    c.hydrate({ assets: [] });
    c.applyChange({ type: 'publishAsset', mode: 'create', assetId: 'asset-0001', previous: null, next: record(1, DIGEST_V1) });
    expect(c.size).toBe(1);
    c.applyChange({ type: 'publishAsset', mode: 'create', assetId: 'asset-0001', previous: record(1, DIGEST_V1), next: null });
    expect(c.size).toBe(0);
    // Scene-only changes are not content changes.
    expect(c.applyChange({ type: 'setSettings', previous: {}, next: {}, changedKeys: [] })).toBe(false);
  });
});
