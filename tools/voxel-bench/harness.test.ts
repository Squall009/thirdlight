import { chunkGrid } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { benchWorld } from './bench';
import { CANDIDATES, markdownReport, runHarness } from './harness';
import { sweepWorld } from './sweep';
import { measureTransfer, startEchoWorker } from './transfer';
import { cavesWorld, plainWorld, townWorld } from './worlds';

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
