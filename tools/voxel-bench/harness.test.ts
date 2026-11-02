import { chunkGrid } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { benchWorld } from './bench';
import { CANDIDATES, markdownReport, runHarness } from './harness';
import { sweepWorld } from './sweep';
import { measureTransfer, startEchoWorker } from './transfer';
import { cavesWorld, plainWorld, townWorld } from './worlds';
import { mulberry32 } from '@thirdlight/shared';
import { NAMED_CODECS, zstdDict } from './codecs';
import { corpusSampleOf, readCorpus, type CorpusSample } from './corpus';
import { apronCells, meanChunksRebuilt } from './edge-costs';
import { LZ4 } from './lz4-block';

const tiny = { randomReads: 5_000, coherentColumns: 16, edits: 2_000, strokes: 6, transferChunks: 4, seed: 3 };

describe('the storage harness', () => {
  it('sweeps a tiny world through the dense store, every chunk read back as generated', () => {
    const r = sweepWorld(plainWorld({ footprint: 64 }), CANDIDATES.dense!, chunkGrid(16));
    expect(r.verified).toBe(true);
    const t = r.totals;
    expect(t.chunksPresent).toBeGreaterThan(0);
    expect(t.memoryBytes).toBe(t.chunksPresent * 16 ** 3 * 5);
    expect(t.rawBytes).toBe(t.chunksPresent * (16 ** 3 * 5 + 1));
    expect(t.zstdBytes).toBeGreaterThan(0);
    expect(t.zstdBytes).toBeLessThan(t.rawBytes);
    expect(t.zstdNeither).toBeLessThanOrEqual(t.zstdBytes);
    expect(t.paletteHistogram.reduce((a, b) => a + b, 0)).toBe(t.chunksPresent);
  });

  it('extrapolates a sampled sweep by footprint', () => {
    // Tiles of 32 cells keep it small; the plain ground's surface lies in one chunk layer, so every tile holds as many chunks.
    const world = plainWorld({ footprint: 64 });
    const full = sweepWorld(world, CANDIDATES.dense!, chunkGrid(16), undefined, undefined, 32);
    const half = sweepWorld(world, CANDIDATES.dense!, chunkGrid(16), 2, undefined, 32);
    expect(full.tilesTotal).toBe(4);
    expect(half.tilesSwept).toBe(2);
    expect(half.factor).toBe(2);
    expect(half.totals.memoryBytes).toBe(full.totals.memoryBytes);
  });

  it('benchmarks access, edits, strokes and transfer on a tiny window', async () => {
    const b = await benchWorld(townWorld({ footprint: 80 }), CANDIDATES.dense!, chunkGrid(32), tiny);
    expect(b.chunks).toBeGreaterThan(0);
    expect(b.randomReadNs).toBeGreaterThan(0);
    expect(b.coherentReadNs).toBeGreaterThan(0);
    expect(b.strokes.map((s) => s.name)).toEqual(['sphere r=1 m', 'sphere r=2 m', 'sphere r=4 m', 'box 2 m', 'box 8 m']);
    expect(b.strokes.find((s) => s.name === 'box 2 m')!.cellsPerOp).toBe(64);
    expect(b.transfer?.raw.chunks).toBe(4);
  });

  it('reports every world it ran as a table row', async () => {
    const reports = await runHarness([cavesWorld({ footprint: 32 })], 'dense', { edge: 16, bench: false });
    const md = markdownReport(reports);
    expect(md).toContain('| caves | dense | 16 |');
    await expect(runHarness([], 'nope', { edge: 16, bench: false })).rejects.toThrow(/unknown candidate/);
  });
});

describe('the palette candidates', () => {
  const palettes = Object.keys(CANDIDATES).filter((n) => n.startsWith('palette') || n === 'bricks');

  it('read back every swept chunk of the town and the caves as generated, through voxelAt too', () => {
    expect(palettes.length).toBeGreaterThanOrEqual(4);
    for (const name of palettes) {
      for (const world of [townWorld({ footprint: 96 }), cavesWorld({ footprint: 48 })]) {
        const r = sweepWorld(world, CANDIDATES[name]!, chunkGrid(16));
        expect({ name, world: world.name, mismatches: r.mismatches }).toEqual({ name, world: world.name, mismatches: 0 });
        expect(r.voxelAtChecks).toBeGreaterThan(0);
        expect(r.totals.memoryBytes).toBeLessThan(r.totals.chunksPresent * 16 ** 3 * 5);
      }
    }
  });

  it('read what the dense oracle reads after the benchmark edits and strokes', async () => {
    for (const name of ['palette', 'palette-runs', 'palette-planes', 'bricks']) {
      const b = await benchWorld(townWorld({ footprint: 80 }), CANDIDATES[name]!, chunkGrid(32), { ...tiny, transferChunks: 0 });
      expect({ name, editMismatches: b.editMismatches }).toEqual({ name, editMismatches: 0 });
    }
  });
});

describe('worker transfer', () => {
  it('copies or moves chunk bytes through a real worker and back unchanged', async () => {
    const worker = startEchoWorker();
    try {
      const bytes = new Uint8Array(4096).map((_, i) => (i * 31) & 255);
      const copied = bytes.slice().buffer;
      const back = await worker.echo(copied, false);
      expect(copied.byteLength).toBe(4096);
      expect(new Uint8Array(back)).toEqual(bytes);
      const moved = bytes.slice().buffer;
      const back2 = await worker.echo(moved, true);
      expect(moved.byteLength).toBe(0);
      expect(new Uint8Array(back2)).toEqual(bytes);
    } finally {
      await worker.close();
    }
  });

  it('measures copy and transfer round trips per chunk', async () => {
    const chunks = [new Uint8Array(160_000), new Uint8Array(20_000)];
    const r = await measureTransfer(chunks, 2);
    expect(r.chunks).toBe(2);
    expect(r.meanBytes).toBe(90_000);
    expect(r.copyUsPerChunk).toBeGreaterThan(0);
    expect(r.transferUsPerChunk).toBeGreaterThan(0);
  });
});

describe('the codecs the harness sizes with', () => {
  const rand = mulberry32(12);
  const samples = [
    new Uint8Array(13).fill(7),
    Uint8Array.from({ length: 5000 }, (_, i) => (i >> 6) & 3),
    Uint8Array.from({ length: 3000 }, () => Math.floor(rand() * 256)),
  ];

  it.each(Object.keys(NAMED_CODECS))('%s gives back every byte', (name) => {
    for (const b of samples) expect(new Uint8Array(NAMED_CODECS[name]!.decompress(NAMED_CODECS[name]!.compress(b)))).toEqual(b);
  });

  it('zstd with a dictionary round-trips, smaller where the dictionary holds the content', () => {
    const c = zstdDict(Uint8Array.from({ length: 6000 }, (_, i) => (i >> 6) & 3));
    const packed = c.compress(samples[1]!);
    expect(new Uint8Array(c.decompress(packed))).toEqual(samples[1]);
    expect(packed.length).toBeLessThan(NAMED_CODECS.zstd!.compress(samples[1]!).length);
  });

  // lz4js reads past a cut block without noticing (the chunk codec's CRC catches the wrong bytes); a wrong length it refuses.
  it('lz4 stores bytes without matches as they are, and refuses a block that does not fill its stated length', () => {
    const noise = LZ4.compress(samples[2]!);
    expect(noise.length).toBe(4 + samples[2]!.length);
    const packed = LZ4.compress(samples[1]!);
    expect(packed.length).toBeLessThan(samples[1]!.length / 4);
    const longer = packed.slice();
    longer[0]! += 1;
    expect(() => LZ4.decompress(longer)).toThrow(/lz4 block: 5000 bytes for a stated 5001/);
    expect(() => LZ4.decompress(noise.subarray(0, noise.length - 1))).toThrow(/stored bytes/);
  });

  it('resolves codec names and refuses unknown ones', async () => {
    await expect(runHarness([plainWorld({ footprint: 32 })], 'dense', { edge: 16, bench: false, codecs: ['zstd', 'nope'] })).rejects.toThrow(/unknown codec 'nope'/);
  });
});

describe('corpus files and edge costs', () => {
  it('keeps a bounded, seeded sample of chunk bytes and reads it back', () => {
    const map = new Map<string, CorpusSample>();
    for (let k = 0; k < 2500; k++) corpusSampleOf(map, 'w').add(Uint8Array.of(k & 255, k >> 8, 9));
    const back = readCorpus(map.get('w')!.bytes());
    expect(back.length).toBe(2000);
    expect(back.every((b) => b.length === 3 && b[2] === 9)).toBe(true);
  });

  it('counts apron cells and the chunks an edit rebuilds', () => {
    expect(apronCells(32, 2)).toBe(36 ** 3 - 32 ** 3);
    expect(apronCells(16, 1)).toBe(18 ** 3 - 16 ** 3);
    // A single cell with no dependency radius never leaves its chunk.
    expect(meanChunksRebuilt(16, 0, 0, 2000)).toBe(1);
    // Reach r on each side: per axis the chance to cross a border is 2r / edge, so the mean is (1 + 2r / edge)³.
    expect(meanChunksRebuilt(32, 0, 4, 100_000)).toBeCloseTo((1 + 8 / 32) ** 3, 1);
  });
});
