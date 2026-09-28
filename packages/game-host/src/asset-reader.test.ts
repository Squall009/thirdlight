/** Phase 25.24b: the verified asset reader (bounded parallel, once per asset, checked) and the start-scene asset set. */
import { describe, expect, it } from 'vitest';

import { AssetReadError, createVerifiedAssetReader, startSceneAssets, type DeclaredAssetRow } from './asset-reader';

const hex = async (b: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, '0')).join('');

async function rowFor(assetId: string, kind: string, bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<DeclaredAssetRow> {
  const digest = await hex(bytes);
  return { assetId, version: 1, kind, path: `content/sha256/${digest}`, sourceDigest: digest, sourceByteLength: bytes.byteLength, ...extra };
}

describe('verified asset reader', () => {
  it('reads each asset once, at most 8 at a time, and checks every one', async () => {
    const files = new Map<string, Uint8Array>();
    const rows: DeclaredAssetRow[] = [];
    for (let i = 0; i < 30; i += 1) {
      const b = new TextEncoder().encode(`file ${i}`);
      const r = await rowFor(`a-${i}`, 'texture', b);
      files.set(r.path, b);
      rows.push(r);
    }
    let active = 0;
    let most = 0;
    const readsOf = new Map<string, number>();
    const reader = createVerifiedAssetReader(rows, {
      read: async (path) => {
        readsOf.set(path, (readsOf.get(path) ?? 0) + 1);
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 2));
        active -= 1;
        return files.get(path)!.slice().buffer;
      },
      sha256Hex: hex,
    });
    const progress: number[] = [];
    await reader.preload(rows.slice(0, 20), (loaded) => progress.push(loaded));
    expect(most).toBe(8);
    expect(progress).toHaveLength(20);
    expect(reader.stats().reads).toBe(20);
    // Asked again (and a later asset for the first time): no second read of the first ones.
    const again = await reader.bytes('a-3', 1);
    expect(new TextDecoder().decode(again)).toBe('file 3');
    expect(reader.peek('a-25', 1)).toBeUndefined();
    await reader.bytesAt(rows[25]!.path);
    expect(reader.peek('a-25', 1)).toBeDefined();
    expect([...readsOf.values()].every((n) => n === 1)).toBe(true);
    expect(reader.bytesAt('content/sha256/unknown')).toBeNull();
  });

  it('refuses bytes that do not match the manifest, naming the asset', async () => {
    const good = new TextEncoder().encode('good');
    const row = await rowFor('tex-1', 'texture', good);
    const reader = createVerifiedAssetReader([row, { ...row, assetId: 'tex-2', path: 'content/other' }], {
      read: async (path) => (path === row.path ? new TextEncoder().encode('evil').buffer : good.slice().buffer),
      sha256Hex: hex,
    });
    await expect(reader.bytes('tex-1', 1)).rejects.toThrow(/tex-1: digest/);
    await expect(reader.preload([row])).rejects.toBeInstanceOf(AssetReadError);
    await expect(reader.bytes('nope', 1)).rejects.toThrow(/not declared/);
  });
});

describe('start-scene assets', () => {
  const b = (s: string): Uint8Array => new TextEncoder().encode(s);
  const assets = Promise.all([
    rowFor('model-a', 'model', b('a'), { materials: { body: 'mat-model' } }),
    rowFor('model-b', 'model', b('b')),
    rowFor('tex-direct', 'texture', b('t1')),
    rowFor('tex-mat', 'texture', b('t2')),
    rowFor('tex-model-mat', 'texture', b('t3')),
    rowFor('tex-fn', 'texture', b('t4')),
    rowFor('tex-fx', 'texture', b('t5')),
    rowFor('tex-sky', 'texture', b('t6')),
    rowFor('lm-start', 'texture', b('t7')),
    rowFor('lm-later', 'texture', b('t8')),
    rowFor('tex-unused', 'texture', b('t9')),
    rowFor('song', 'music', b('m')),
  ]);
  it('follows what the start scenes use, and nothing else', async () => {
    const picked = startSceneAssets({
      assets: await assets,
      startSceneIds: ['main'],
      entities: [
        { id: 'e1', components: { model: { asset: { assetId: 'model-a' } }, materials: { '*': 'mat-1' } } },
        { id: 'e2', components: { box: {}, materials: { '*': 'mat-graph' } } },
        { id: 'e3', components: { effect: { effectId: 'fx-1' } } },
        { id: 'e4', components: { audioSource: { asset: 'song' }, decal: { texture: 'tex-direct' } } },
      ],
      materials: [
        { materialId: 'mat-1', textures: { map: 'tex-mat' } },
        { materialId: 'mat-model', textures: { map: 'tex-model-mat' } },
        { materialId: 'mat-graph', graph: { nodes: [{ type: 'call', data: { graphId: 'fn-1' } }] } },
        { materialId: 'mat-unused', textures: { map: 'tex-unused' } },
      ],
      materialFunctions: [{ graphId: 'fn-1', graph: { nodes: [{ type: 'sampleTexture', data: { texture: 'tex-fn' } }] } }],
      effects: [{ effectId: 'fx-1', systems: [{ graph: { nodes: [{ data: { texture: 'tex-fx' } }] } }] }],
      environment: { sky: { texture: 'tex-sky' } },
      lighting: { main: { atlases: ['lm-start'] }, later: { atlases: ['lm-later'] } },
    });
    expect(picked.map((r) => r.assetId).sort()).toEqual(['lm-start', 'model-a', 'tex-direct', 'tex-fn', 'tex-fx', 'tex-mat', 'tex-model-mat', 'tex-sky']);
  });
});
