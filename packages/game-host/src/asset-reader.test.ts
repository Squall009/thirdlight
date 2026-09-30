/** The verified asset reader (bounded parallel, once per asset, checked) and the start-scene asset set. */
import { describe, expect, it } from 'vitest';

import { createResourceManager } from '@thirdlight/runtime';

import { AssetReadError, createVerifiedAssetReader, mipPartsOf, startSceneAssets, type DeclaredAssetRow } from './asset-reader';

const hex = async (b: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, '0')).join('');

async function rowFor(assetId: string, kind: string, bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<DeclaredAssetRow> {
  const digest = await hex(bytes);
  return { assetId, version: 1, kind, path: `content/sha256/${digest}`, sourceDigest: digest, sourceByteLength: bytes.byteLength, ...extra };
}

describe('verified asset reader', () => {
  it('a row it was not given comes from the catalog: rows read since, else the shard lookup, then the checked read', async () => {
    const bytes = new TextEncoder().encode('late sound');
    const late = await rowFor('late', 'audio', bytes);
    const known = new Map<string, DeclaredAssetRow>();
    let lookups = 0;
    const catalog = {
      row: (id: string, v?: number) => (known.get(id)?.version === (v ?? 1) ? known.get(id) : undefined),
      rowAt: (path: string) => [...known.values()].find((r) => r.path === path),
      lookup: async (id: string) => {
        lookups += 1;
        if (id === 'late') known.set(id, late);
        return known.get(id);
      },
    };
    const reads: string[] = [];
    const reader = createVerifiedAssetReader([], { read: async (p) => (reads.push(p), bytes.slice().buffer), sha256Hex: hex }, { catalog });
    expect(reader.bytesAt(late.path)).toBeNull();
    expect(new TextDecoder().decode(await reader.bytes('late', 1, 'user'))).toBe('late sound');
    expect(lookups).toBe(1);
    // Known now: no second lookup, and its path reads through the reader.
    await reader.bytes('late', 1);
    expect(lookups).toBe(1);
    expect(reader.bytesAt(late.path)).not.toBeNull();
    expect(reads).toEqual([late.path]);
    // Not in the build: refused, naming it.
    await expect(reader.bytes('ghost', 1)).rejects.toThrow(/ghost v1 is not declared/);
  });

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
    await reader.bytesAt(rows[25]!.path, 'user');
    expect(reader.peek('a-25', 1)).toBeDefined();
    expect([...readsOf.values()].every((n) => n === 1)).toBe(true);
    expect(reader.bytesAt('content/sha256/unknown')).toBeNull();
  });

  it('bytes are held by their holders and freed when the last one lets go (read again when asked again)', async () => {
    const b = new TextEncoder().encode('scene file');
    const row = await rowFor('m-1', 'model', b);
    let reads = 0;
    const resources = createResourceManager();
    const reader = createVerifiedAssetReader([row], { read: async () => (reads++, b.slice().buffer), sha256Hex: hex }, { resources });
    await reader.preload([row], undefined, 'scene:a');
    // A decoder takes them (no holder: handed over), the scene's preparation still holds them.
    await reader.bytes('m-1', 1);
    resources.settle();
    expect(reader.peek('m-1', 1)).toBeDefined();
    expect(resources.observe().resident.bytes).toEqual({ count: 1, bytes: b.byteLength });
    reader.release('scene:a');
    resources.settle();
    expect(reader.peek('m-1', 1)).toBeUndefined();
    expect(resources.observe().resident).toEqual({});
    await reader.bytes('m-1', 1);
    expect(reads).toBe(2);
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
    rowFor('song', 'audio', b('m')),
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

describe('streamed textures: read by part', () => {
  /** A "file" cut into three parts (the head, then two levels), its row listing them. */
  async function streamed(): Promise<{ row: DeclaredAssetRow; files: Map<string, Uint8Array>; whole: Uint8Array }> {
    const whole = new Uint8Array(300).map((_, i) => (i * 7) & 255);
    const cuts = [0, 100, 180, 300];
    const files = new Map<string, Uint8Array>();
    const mipParts = [];
    for (let i = 0; i < 3; i += 1) {
      const part = whole.slice(cuts[i], cuts[i + 1]);
      const digest = await hex(part);
      files.set(`content/sha256/${digest}`, part);
      mipParts.push({ path: `content/sha256/${digest}`, digest, byteLength: part.length, offset: cuts[i]!, levels: i === 0 ? [2, 3] : [2 - i] });
    }
    const row = await rowFor('tex', 'texture', whole, { mipParts });
    return { row, files, whole };
  }

  it('a part is read at its own path and checked against its own digest; a changed part is refused', async () => {
    const { row, files } = await streamed();
    const reads: string[] = [];
    const reader = createVerifiedAssetReader([row], { read: async (p) => (reads.push(p), files.get(p)!.slice().buffer), sha256Hex: hex });
    const parts = mipPartsOf(row)!;
    expect(parts.map((p) => p.levels)).toEqual([[2, 3], [1], [0]]);
    expect([...(await reader.part(row, 2))]).toEqual([...files.get(parts[2]!.path)!]);
    expect(reads).toEqual([parts[2]!.path]);
    const bad = createVerifiedAssetReader([row], { read: async () => new Uint8Array(80).buffer, sha256Hex: hex });
    await expect(bad.part(row, 1)).rejects.toThrow(AssetReadError);
  });

  it('the whole file is its parts put together (the whole is never fetched), and the start reads only the head', async () => {
    const { row, files, whole } = await streamed();
    const reads: string[] = [];
    const reader = createVerifiedAssetReader([row], { read: async (p) => (reads.push(p), files.get(p)!.slice().buffer), sha256Hex: hex });
    expect([...new Uint8Array(await reader.bytes('tex', 1))]).toEqual([...whole]);
    expect(reads).not.toContain(row.path);
    expect(reads).toHaveLength(3);
    reads.length = 0;
    const resources = createResourceManager();
    const again = createVerifiedAssetReader([row], { read: async (p) => (reads.push(p), files.get(p)!.slice().buffer), sha256Hex: hex }, { resources });
    let total = 0;
    await again.preload([row], (_, t) => (total = t), 'start');
    expect(reads).toEqual([mipPartsOf(row)![0]!.path]);
    expect(total).toBe(100);
    // The decoder's read of the head shares what the start holds.
    await again.part(row, 0);
    expect(reads).toHaveLength(1);
  });

  it('malformed parts (a gap, a wrong path, not the whole file) read the texture whole', async () => {
    const { row } = await streamed();
    const parts = (row as unknown as { mipParts: Record<string, unknown>[] }).mipParts;
    expect(mipPartsOf({ ...row, mipParts: [parts[0], parts[2]] } as unknown as DeclaredAssetRow)).toBeNull();
    expect(mipPartsOf({ ...row, mipParts: [{ ...parts[0], path: 'content/sha256/x' }, parts[1], parts[2]] } as unknown as DeclaredAssetRow)).toBeNull();
    expect(mipPartsOf({ ...row, sourceByteLength: 301 })).toBeNull();
    expect(mipPartsOf({ ...row, kind: 'model' })).toBeNull();
  });
});
