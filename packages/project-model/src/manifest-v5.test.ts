/**
 * Manifest v5 and its catalog: the small manifest, the block files, the
 * entry shards, the scenes' dependency files, the strict readers, and the
 * reading of a whole build (v5, and v4 in the same shape).
 */
import { describe, expect, it } from 'vitest';

import {
  captureManifestV2,
  captureManifestV5,
  CATALOG_BLOCK_KEYS,
  CATALOG_PART_BYTES,
  catalogRootProblem,
  dependencyTables,
  MANIFEST_KEYS_V2,
  MANIFEST_KEYS_V5,
  readRuntimeContentSync,
  scanDependencies,
  sha256Hex,
  validateManifestV5,
  type CaptureManifestV5Input,
  type CaptureSceneV5,
  type CatalogFile,
  type CatalogRootV5,
} from './index';
import { everyOptionalKey, v2Input } from './manifest-test-inputs';

const BEHAVIOR = {
  behaviorId: 'mover',
  sourceDigest: '1'.repeat(64),
  sourceByteLength: 10,
  manifestDigest: '2'.repeat(64),
  outputDigest: '3'.repeat(64),
  outputByteLength: 20,
  apiVersion: 1,
  declaration: { properties: [] },
  ownedTransforms: [],
  requiredModules: [],
};

/** The v5 input for the same project as a v4 input: its scenes with what each needs, the start, what the project-wide blocks need. */
function v5Of(v4: Record<string, unknown>, extra: Partial<CaptureManifestV5Input> = {}): CaptureManifestV5Input {
  const { scenes, scene: _s, ...rest } = v4 as { scenes?: { sceneId: string; start: boolean }[]; scene?: unknown };
  return {
    ...(rest as unknown as CaptureManifestV5Input),
    ...(scenes !== undefined ? { scenes: scenes.map((sc) => ({ ...(sc as unknown as CaptureSceneV5), dependencies: ['asset-1'] })) } : {}),
    start: (scenes ?? []).filter((sc) => sc.start).map((sc) => sc.sceneId),
    dependencies: ['asset-1'],
    ...extra,
  };
}

function capture(input: CaptureManifestV5Input): { manifest: Record<string, unknown>; bytes: Uint8Array; root: CatalogRootV5; files: Map<string, Uint8Array> } {
  const res = captureManifestV5(input);
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  return { manifest: res.manifest as unknown as Record<string, unknown>, bytes: res.bytes, root: res.root, files: new Map(res.files.map((f: CatalogFile) => [f.path, f.bytes])) };
}

function assetInput(i: number, kind: 'model' | 'audio' | 'texture' = 'audio'): Record<string, unknown> {
  const id = `a-${String(i).padStart(6, '0')}`;
  return { assetId: id, kind, version: 1, sourceDigest: sha256Hex(new TextEncoder().encode(id)), sourceByteLength: 100 + i, recipe: { id: kind === 'model' ? 'gltf-glb' : 'audio', version: 1 }, metricsDigest: 'b'.repeat(64), ...(kind === 'audio' ? { durationMs: 1000 + i, loadType: 'stream', preload: false } : {}) };
}

describe('manifest-v5: every optional block', () => {
  const v4Input = { ...v2Input(), ...everyOptionalKey(), behaviors: [BEHAVIOR] };

  it('the manifest keeps the start and the catalog, and every block reads back as the v4 capture of the same project has it', () => {
    const v5 = capture(v5Of(v4Input));
    expect(Object.keys(v5.manifest)).toEqual([...MANIFEST_KEYS_V5]);
    expect(v5.manifest['start']).toEqual(['scene-a']);
    expect(validateManifestV5(JSON.parse(new TextDecoder().decode(v5.bytes))).ok).toBe(true);
    // Every block of the catalog has its file.
    expect([...new Set(v5.root.files.map((f) => f.key))]).toEqual([...CATALOG_BLOCK_KEYS]);
    expect(catalogRootProblem(v5.root)).toBeNull();

    const v4 = captureManifestV2(v4Input as never);
    if (!v4.ok) throw new Error(JSON.stringify(v4.error));
    const v4Files = new Map(v4.contentFiles.map((f) => [f.path, f.bytes]));
    const a = readRuntimeContentSync(JSON.parse(new TextDecoder().decode(v4.bytes)), (p) => v4Files.get(p) ?? null) as unknown as Record<string, unknown>;
    const b = readRuntimeContentSync(JSON.parse(new TextDecoder().decode(v5.bytes)), (p) => v5.files.get(p) ?? null) as unknown as Record<string, unknown>;
    // Everything a v4 manifest carried (inline or in its content files), bar its own version, time and id.
    const same = [...MANIFEST_KEYS_V2, 'materials', 'materialFunctions', 'uiDocuments', 'dialogue', 'buffers'].filter((k) => !['manifestVersion', 'capturedAt', 'buildId', 'contentFiles'].includes(k));
    for (const k of same) expect(b[k], k).toEqual(a[k]);
    expect(b['start']).toEqual(a['start']);
    // What the simulation reads of each asset, and the names scripts load by.
    expect(b['facts']).toEqual([{ assetId: 'asset-1', kind: 'model' }]);
    expect((b['sceneDependencies'] as Record<string, { assetId: string }[]>)['scene-a']!.map((e) => e.assetId)).toEqual(['asset-1']);
  });

  it('the buildId covers the catalog: a changed block changes the catalog root and the buildId', () => {
    const one = capture(v5Of(v4Input));
    const two = capture(v5Of({ ...v4Input, tags: [{ bit: 3, name: 'runner' }] }));
    expect(two.manifest['catalog']).not.toEqual(one.manifest['catalog']);
    expect(two.manifest['buildId']).not.toBe(one.manifest['buildId']);
    // The same input: the same bytes.
    expect(capture(v5Of(v4Input)).bytes).toEqual(one.bytes);
  });
});

describe('manifest-v5: size and shards', () => {
  const withAssets = (n: number, extra: Record<string, unknown>[] = []): CaptureManifestV5Input =>
    v5Of({ ...v2Input(), assets: [...Array.from({ length: n }, (_, i) => assetInput(i)), ...extra], behaviors: [] }, { dependencies: [] });

  it('the manifest does not grow with the project: 10 or 5,000 assets, the same length but the digits of the root\'s size', () => {
    const small = capture(withAssets(10));
    const large = capture(withAssets(5000));
    expect(Math.abs(large.bytes.length - small.bytes.length)).toBeLessThanOrEqual(4);
    expect(large.root.entries.length).toBeGreaterThan(small.root.entries.length);
  });

  it('entries are in shards by id range; a lookup reads one; an added asset rewrites one shard', () => {
    const before = capture(withAssets(3000));
    const shards = before.root.entries;
    expect(shards.length).toBeGreaterThan(4);
    for (let i = 1; i < shards.length; i += 1) expect(shards[i - 1]!.last < shards[i]!.first).toBe(true);
    // One shard holds the id; its file lists that entry.
    const id = 'a-001234';
    const at = shards.filter((s) => s.first <= id && id <= s.last);
    expect(at).toHaveLength(1);
    const rows = JSON.parse(new TextDecoder().decode(before.files.get(at[0]!.path)!)) as { assetId: string }[];
    expect(rows.some((r) => r.assetId === id)).toBe(true);
    expect(rows).toHaveLength(at[0]!.count);
    // A new asset between two ids: the shards other than its own keep their files.
    const after = capture(withAssets(3000, [{ ...assetInput(1234), assetId: 'a-001234x' }]));
    const old = new Set(shards.map((s) => s.digest));
    const changed = after.root.entries.filter((s) => !old.has(s.digest));
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(changed.length).toBeLessThanOrEqual(2);
  });

  it('a large block is split into parts that join back', () => {
    const prefabs = Array.from({ length: 8000 }, (_, i) => ({ prefabId: `pf-${String(i).padStart(5, '0')}`, displayName: `Prefab ${i}`, createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', name: 'Root with a long enough name to take some room in the file', parentLocalId: null, components: { transform: { position: [i, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } }] }));
    const big = capture(v5Of({ ...v2Input(), prefabs, behaviors: [] }));
    const parts = big.root.files.filter((f) => f.key === 'prefabs');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.byteLength).toBeLessThanOrEqual(CATALOG_PART_BYTES + 4096);
    const read = readRuntimeContentSync(big.manifest, (p) => big.files.get(p) ?? null);
    expect((read['prefabs'] as { prefabId: string }[]).map((p) => p.prefabId)).toEqual(prefabs.map((p) => p.prefabId));
  });
});

describe('manifest-v5: scenes and their dependencies', () => {
  it('each scene\'s dependency file holds the entries its objects need, and nothing else', () => {
    const assets = [assetInput(1, 'model'), assetInput(2, 'model'), assetInput(3, 'texture')];
    const scenes = [
      { sceneId: 'scene-a', path: 'scenes/scene-a.json', digest: 'e'.repeat(64), byteLength: 10, start: true, dependencies: ['a-000001', 'a-000003'] },
      { sceneId: 'scene-b', path: 'scenes/scene-b.json', digest: 'd'.repeat(64), byteLength: 10, start: false, dependencies: ['a-000002'] },
    ];
    const c = capture({ ...v5Of({ ...v2Input(), assets, behaviors: [] }), scenes, start: ['scene-a'], dependencies: [] });
    const deps = (id: string): string[] => (JSON.parse(new TextDecoder().decode(c.files.get(c.root.scenes!.find((s) => s.sceneId === id)!.dependencies.path)!)) as { assetId: string }[]).map((e) => e.assetId);
    expect(deps('scene-a')).toEqual(['a-000001', 'a-000003']);
    expect(deps('scene-b')).toEqual(['a-000002']);
  });

  it('the dependency scan follows prefabs, materials, material maps and effects to the assets they name', () => {
    const tables = dependencyTables({
      assets: [{ assetId: 'crate', kind: 'model', materials: { body: 'mat-wood' } }, { assetId: 'wood', kind: 'texture' }, { assetId: 'spark', kind: 'texture' }, { assetId: 'unused', kind: 'texture' }, { assetId: 'boom', kind: 'audio' }],
      materials: [{ materialId: 'mat-wood', textures: { baseColor: 'wood' } } as never],
      effects: [{ effectId: 'fx-sparks', texture: 'spark' } as never],
      prefabs: [{ prefabId: 'pf-crate', entities: [{ components: { model: { asset: { assetId: 'crate' } } } }] } as never],
    });
    const scene = { entities: [{ id: 'spawner', components: { spawner: { prefabId: 'pf-crate' }, effect: { effectId: 'fx-sparks' }, audioSource: { assetId: 'boom' } } }] };
    expect(scanDependencies(tables, [scene])).toEqual(['boom', 'crate', 'spark', 'wood']);
    expect(scanDependencies(tables, [{ entities: [] }])).toEqual([]);
  });
});

describe('manifest-v5: strict readers', () => {
  const good = (): { manifest: Record<string, unknown>; files: Map<string, Uint8Array>; root: CatalogRootV5 } => capture(v5Of({ ...v2Input(), ...everyOptionalKey(), behaviors: [BEHAVIOR] }));

  it('refuses another version, an unknown or missing key, keys out of order and a changed buildId', () => {
    const m = good().manifest;
    expect(validateManifestV5({ ...m, manifestVersion: 4 }).ok).toBe(false);
    expect(validateManifestV5({ ...m, assets: [] }).ok).toBe(false);
    const { start: _s, ...missing } = m;
    expect(validateManifestV5(missing).ok).toBe(false);
    const { manifestVersion, ...others } = m;
    expect(validateManifestV5({ ...others, manifestVersion }).ok).toBe(false);
    expect(validateManifestV5({ ...m, buildId: 'f'.repeat(64) }).ok).toBe(false);
    expect(validateManifestV5({ ...m, catalog: { ...(m['catalog'] as object), path: 'catalog.json' } }).ok).toBe(false);
  });

  it('refuses a root out of shape and a file that does not match its row', () => {
    const { manifest, files, root } = good();
    expect(catalogRootProblem({ ...root, extra: 1 })).not.toBeNull();
    expect(catalogRootProblem({ ...root, files: [...root.files].reverse() })).not.toBeNull();
    expect(catalogRootProblem({ ...root, entries: [...root.entries, ...root.entries] })).not.toBeNull();
    const shard = root.entries[0]!.path;
    const changed = new Map(files);
    changed.set(shard, new TextEncoder().encode('[]\n'));
    expect(() => readRuntimeContentSync(manifest, (p) => changed.get(p) ?? null)).toThrow(/does not match its digest/);
    const gone = new Map(files);
    gone.delete(root.files[0]!.path);
    expect(() => readRuntimeContentSync(manifest, (p) => gone.get(p) ?? null)).toThrow(/is missing/);
  });
});
