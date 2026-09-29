/**
 * A reader puts the manifest's content files back under their
 * keys, each checked against its row (length and SHA-256) before it is used.
 */
import { describe, expect, it } from 'vitest';
import { expandManifestContentFiles } from './scene-catalog';

const sha256HexAsync = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A manifest with three content files (the blocks' canonical bytes, as project-model's capture writes them). */
async function capture(): Promise<{ manifest: Record<string, unknown>; files: Map<string, Uint8Array> }> {
  const blocks: [string, unknown][] = [
    ['materials', [{ materialId: 'mat-a', name: 'A', shader: 'standard', params: {}, textures: {} }]],
    ['uiDocuments', [{ uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', text: 'hi' } }]],
    ['buffers', [{ digest: 'f'.repeat(64), byteLength: 40 }]],
  ];
  const files = new Map<string, Uint8Array>();
  const rows = [];
  for (const [key, block] of blocks) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(block, null, 2)}\n`);
    const digest = await sha256HexAsync(bytes);
    files.set(`content/sha256/${digest}`, bytes);
    rows.push({ key, path: `content/sha256/${digest}`, digest, byteLength: bytes.length });
  }
  return { manifest: { manifestVersion: 4, contentFiles: rows, assets: [] }, files };
}

const io = (files: Map<string, Uint8Array>, reads: string[] = []) => ({
  read: (path: string): Promise<ArrayBuffer> => {
    reads.push(path);
    const b = files.get(path);
    return b === undefined ? Promise.reject(new Error(`404 ${path}`)) : Promise.resolve(b.slice().buffer);
  },
  sha256Hex: sha256HexAsync,
});

describe('expandManifestContentFiles (phase 25.7b)', () => {
  it('reads each listed file once and puts its block back under its key', async () => {
    const { manifest, files } = await capture();
    expect('materials' in manifest).toBe(false);
    const reads: string[] = [];
    const out = (await expandManifestContentFiles(manifest as { contentFiles?: never[] }, io(files, reads))) as Record<string, unknown>;
    expect(reads.sort()).toEqual([...files.keys()].sort());
    expect((out['materials'] as { materialId: string }[]).map((m) => m.materialId)).toEqual(['mat-a']);
    expect((out['uiDocuments'] as { uiDocumentId: string }[])[0]!.uiDocumentId).toBe('hud');
    expect(out['buffers']).toEqual([{ digest: 'f'.repeat(64), byteLength: 40 }]);
    expect('materials' in manifest).toBe(false); // the document itself is not changed
  });

  it('refuses a changed, missing or unknown file and a key the document already has', async () => {
    const { manifest, files } = await capture();
    const [path, bytes] = [...files.entries()][0]!;
    const changed = new Map(files);
    const other = bytes.slice();
    other[other.length - 2] = other[other.length - 2] === 0x5d ? 0x7d : 0x5d;
    changed.set(path, other);
    await expect(expandManifestContentFiles(manifest as never, io(changed))).rejects.toThrow(/digest does not match/);
    const missing = new Map(files);
    missing.delete(path);
    await expect(expandManifestContentFiles(manifest as never, io(missing))).rejects.toThrow(/404/);
    const rows = manifest['contentFiles'] as { key: string }[];
    await expect(expandManifestContentFiles({ ...manifest, contentFiles: [{ ...rows[0]!, key: 'scripts' }] } as never, io(files))).rejects.toThrow(/unknown block/);
    await expect(expandManifestContentFiles({ ...manifest, materials: [] } as never, io(files))).rejects.toThrow(/already has/);
  });

  it('a manifest without content files is returned as it is', async () => {
    const doc: { manifestVersion: number; assets: never[]; contentFiles?: never[] } = { manifestVersion: 4, assets: [] };
    expect(await expandManifestContentFiles(doc, io(new Map()))).toEqual(doc);
  });
});
