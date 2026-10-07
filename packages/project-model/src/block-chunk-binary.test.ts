/**
 * Binary block chunks: a layer's chunks written as binary and read back are
 * the same values its JSON chunk files hold (cells, rotations, variants,
 * corners, metadata, paint), and a malformed blob is refused with a message.
 * Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import { canonicalBlockChunk, type BlockChunk, type BlockType } from './block-layers';
import { applyBlockEdits, BlockGrid, type BlockEdit } from './block-grid';
import { decodeBlockChunks, encodeBlockChunks, readBlockChunkData, wrapBlockChunkData } from './block-chunk-binary';
import { encodeChunkPaint, unpaintedChunk } from './block-paint';

const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#777777' }, { color: '#888888' }], shape: 'full' },
  { blockId: 'ramp', name: 'Ramp', variants: [{ color: '#996633' }], shape: 'ramp' },
];
const types = new Map(TYPES.map((t) => [t.blockId, t]));

/** A varied layer: fills, rotated and variant cells, sloped corners, metadata, negative chunk coordinates. */
function layerChunks(): BlockChunk[] {
  const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [-40, -8, -40], max: [40, 24, 40] } });
  const edits: BlockEdit[] = [
    { kind: 'fill', box: [-40, -8, -40, 40, -6, 40], cell: { block: 'stone' } },
    { kind: 'cells', at: [3, -6, 5], cell: { block: 'ramp', rot: 270 } },
    { kind: 'cells', at: [-17, -6, 9], cell: { block: 'stone', variant: 1, meta: { tag: 'gate', cost: 2.5, open: true } } },
    { kind: 'cells', at: [20, -6, -33], cell: { block: 'stone', corners: [1, 1.25, 2, 0.5] } },
  ];
  const r = applyBlockEdits(g, edits, { types, stamps: new Map() });
  if (!r.ok) throw new Error(`${r.path}: ${r.message}`);
  return g.chunkKeys().map((k) => g.encodeChunk(k)!).map((c) => canonicalBlockChunk(c)!);
}

describe('binary block chunks', () => {
  it('round-trips a layer: the same values its JSON files hold', () => {
    const chunks = layerChunks();
    expect(chunks.length).toBe(36);
    // Paint on one chunk, as its stored base64 text.
    const lattice = unpaintedChunk();
    lattice[0] = 128;
    lattice[1] = 127;
    chunks[3] = { ...chunks[3]!, paint: encodeChunkPaint(lattice) };
    const back = decodeBlockChunks(encodeBlockChunks(chunks));
    expect(JSON.stringify(back)).toBe(JSON.stringify(chunks));
    expect(back).toEqual(chunks);
    // One chunk alone (a project's chunk file) too.
    expect(decodeBlockChunks(encodeBlockChunks([chunks[7]!]))).toEqual([chunks[7]]);
    // Each decoded chunk owns its palette objects (a parsed JSON chunk does).
    expect(back[0]!.palette[0]).not.toBe(back[1]!.palette[0]);
  });

  it('is far smaller than the pretty-printed JSON; the blob header names its compression and length', () => {
    const chunks = layerChunks();
    const raw = encodeBlockChunks(chunks);
    const json = new TextEncoder().encode(JSON.stringify(chunks, null, 2));
    expect(raw.length * 4).toBeLessThan(json.length);
    // (The compressed forms are read back where the compressors are: workspace chunk files, zstd; a build's chunk data, gzip.)
    for (const kind of ['none', 'zstd', 'gzip'] as const) {
      const head = readBlockChunkData(wrapBlockChunkData(kind, raw.length, raw));
      expect(head.compression).toBe(kind);
      expect(head.rawLength).toBe(raw.length);
      expect(decodeBlockChunks(head.stored)).toEqual(chunks);
    }
  });

  it('keeps a paint text that is not in the canonical base64 form as it is', () => {
    const odd: BlockChunk = { cx: 0, cz: 0, palette: [{ block: 'stone' }], columns: [[0, 0, 0, 1, 0]], paint: 'not base64 at all' };
    expect(decodeBlockChunks(encodeBlockChunks([odd]))).toEqual([odd]);
  });

  it('refuses malformed blobs with a message', () => {
    const raw = encodeBlockChunks(layerChunks());
    expect(() => decodeBlockChunks(raw.subarray(0, raw.length - 3))).toThrow(/block chunk binary/);
    expect(() => decodeBlockChunks(new Uint8Array([...raw, 0]))).toThrow(/bytes after the last chunk/);
    expect(() => decodeBlockChunks(new Uint8Array([9]))).toThrow(/layout 9/);
    expect(() => readBlockChunkData(new TextEncoder().encode('{"storageVersion": 4}'))).toThrow(/not a binary block chunk file/);
    const blob = wrapBlockChunkData('none', raw.length, raw);
    blob[5] = 7;
    expect(() => readBlockChunkData(blob)).toThrow(/unknown compression 7/);
    // A huge count is refused before anything is allocated.
    expect(() => decodeBlockChunks(new Uint8Array([1, 0, 0xff, 0xff, 0xff, 0xff, 0x0f]))).toThrow(/count runs past/);
    expect(() => encodeBlockChunks([{ cx: 0, cz: 0, palette: [], columns: [[0, 0, 0.5, 1, 0]] }])).toThrow(/not a stored integer/);
  });
});
