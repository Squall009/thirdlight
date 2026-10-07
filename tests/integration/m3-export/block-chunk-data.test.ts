/**
 * A build's block chunk data, both halves: the closure's packer takes a
 * scene document's layer cells out into a binary blob (gzip-compressed with
 * the backend's gzip, or uncompressed without one), and the game page's
 * reader puts them back from the blob before the runtime sees the document.
 * The cells it gets back are the ones the project holds; a layer two
 * documents name (a start scene's file and the merged start scene) is one
 * blob; an entry with only regions, and a document with its cells inline
 * (Play's start snapshot), pass through as they are.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { applyBlockEdits, BlockGrid, encodeChunkPaint, unpaintedChunk, type BlockLayerData, type BlockType } from '@thirdlight/project-model';

import { blockDataPacker } from '../../../packages/exporter/src/block-chunk-data';
import { withBlockChunkData } from '../../../packages/game-host/src/block-chunk-data';
import { nodeGzip } from '../../../packages/backend/src/gzip-port';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#777777' }], shape: 'full' },
  { blockId: 'grass', name: 'Grass', variants: [{ color: '#44aa44' }, { color: '#55bb55' }], shape: 'full' },
];

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** A 48 × 48 layer over 9 chunks: stone, a grass top with rotated and variant cells, metadata, paint; and a regions-only layer. */
function layers(): { cells: BlockLayerData; regionsOnly: BlockLayerData } {
  const g = new BlockGrid({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [48, 8, 48] } });
  const r = applyBlockEdits(
    g,
    [
      { kind: 'fill', box: [0, 0, 0, 48, 2, 48], cell: { block: 'stone' } },
      { kind: 'fill', box: [0, 2, 0, 48, 3, 48], cell: { block: 'grass' } },
      { kind: 'cells', at: [7, 3, 9], cell: { block: 'grass', rot: 180, variant: 1, meta: { note: 'gate' } } },
    ],
    { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() },
  );
  if (!r.ok) throw new Error(r.message);
  const data = g.toData('ground-0001', null, g.takeDirty().chunks)!;
  const lattice = unpaintedChunk();
  lattice[5] = 200;
  lattice[6] = 55;
  data.chunks![4] = { ...data.chunks![4]!, paint: encodeChunkPaint(lattice) };
  return { cells: { ...data, regions: [{ regionId: 'spawn', boxes: [[0, 2, 0, 4, 3, 4]] }] }, regionsOnly: { entityId: 'zones-0001', regions: [{ regionId: 'deploy', boxes: [[1, 0, 1, 3, 1, 3]] }] } };
}

const sceneDoc = (blocks: BlockLayerData[]): Record<string, unknown> =>
  deepFreeze({ schemaVersion: 4, sceneId: 'scene-main', revision: 3, entities: [{ id: 'ground-0001', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [48, 8, 48] } } } }], blocks });

describe('block chunk data in a build', () => {
  for (const gzip of [nodeGzip, undefined]) {
    it(`packs a layer's cells into one blob and the page reads the same cells back (${gzip !== undefined ? 'gzip' : 'uncompressed'})`, async () => {
      const { cells, regionsOnly } = layers();
      const own = sceneDoc([cells, regionsOnly]);
      // The merged start scene names the same (captured) entry objects.
      const merged = deepFreeze({ ...own, entities: [...(own['entities'] as unknown[])] });
      const packer = blockDataPacker(sha, gzip);
      const packedOwn = packer.pack(own) as { blocks: Record<string, unknown>[] };
      const packedMerged = packer.pack(merged) as { blocks: Record<string, unknown>[] };
      const blobs = packer.blobs();
      expect(blobs).toHaveLength(1);
      expect(packedOwn.blocks[0]).toEqual({ entityId: 'ground-0001', regions: cells.regions, chunkData: blobs[0]!.digest });
      expect(packedOwn.blocks[1]).toBe(regionsOnly);
      expect(packedMerged.blocks[0]!['chunkData']).toBe(blobs[0]!.digest);
      // The scene file holds no cells; the blob is far smaller than the cells as the scene file's JSON was.
      const fileBytes = JSON.stringify(packedOwn, null, 2).length;
      const before = JSON.stringify(own, null, 2).length;
      expect(fileBytes).toBeLessThan(2_000);
      expect(blobs[0]!.bytes.length * (gzip !== undefined ? 50 : 4)).toBeLessThan(before);
      expect(sha(blobs[0]!.bytes)).toBe(blobs[0]!.digest);

      const reads: string[] = [];
      const read = async (digest: string): Promise<ArrayBuffer> => {
        reads.push(digest);
        const b = blobs.find((x) => x.digest === digest)!.bytes;
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      };
      const back = await withBlockChunkData(JSON.parse(JSON.stringify(packedOwn)), read);
      expect(JSON.stringify(back)).toBe(JSON.stringify(own));
      expect(reads).toEqual([blobs[0]!.digest]);
    });
  }

  it('a document with its cells inline passes through untouched; a missing reader or buffer is an error', async () => {
    const { cells } = layers();
    const inline = sceneDoc([cells]);
    expect(await withBlockChunkData(inline, undefined)).toBe(inline);
    const packer = blockDataPacker(sha, nodeGzip);
    const packed = packer.pack(inline);
    await expect(withBlockChunkData(packed, undefined)).rejects.toThrow(/reads no buffers/);
    await expect(withBlockChunkData(packed, () => Promise.reject(new Error('buffer abc… is not part of this build')))).rejects.toThrow(/not part of this build/);
    // A blob cut short does not decode.
    const blob = packer.blobs()[0]!.bytes;
    const cut = blob.slice(0, blob.length - 10);
    await expect(withBlockChunkData(packed, async () => cut.buffer as ArrayBuffer)).rejects.toThrow();
  });

  it('an unchanged layer is encoded once across builds (its frozen entry is remembered)', () => {
    const { cells } = layers();
    const doc = sceneDoc([cells]);
    let encodedHashes = 0;
    const counting = (b: Uint8Array): string => {
      encodedHashes += 1;
      return sha(b);
    };
    blockDataPacker(counting, nodeGzip).pack(doc);
    const second = blockDataPacker(counting, nodeGzip);
    second.pack(doc);
    expect(encodedHashes).toBe(1);
    expect(second.blobs()).toHaveLength(1);
  });
});
