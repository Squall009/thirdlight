/**
 * Opt-in (TL_PERF=1): what generated architecture costs to make, without a browser.
 *
 *   TL_PERF=1 npx vitest run tests/perf/architecture.test.ts
 *
 * A village-sized input: the neutral test room (walls with a door, a window and frames, a crown moulding, a floor,
 * a barrel vault, four stamped columns) repeated 8 × 8 times 12 m apart in one component (64 rooms over about
 * 100 × 100 m, 32 m chunks). Measured warm (the JIT settled, as in a worker after its first chunk):
 * - every chunk's generation (median, p95, worst; the soft target: ≤ 5 ms per chunk on a worker);
 * - the page's share before any job goes out: keying every chunk (hashing the elements that reach it);
 * - one room changed (a slider dragged): its chunks keyed again and made (the soft target: ≤ 16 ms);
 * - draws (one per chunk per material: the non-empty chunks), triangles, the bytes a build shipping meshes adds.
 *
 * The numbers go to ~/.cache/thirdlight-perf/architecture.jsonl and the phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { encodeArchitectureChunks } from '../../packages/project-model/src/arch-blob';
import { architectureChunkInput, architectureChunkKeys, generateArchitectureChunk } from '../../packages/project-model/src/arch-generate';
import type { ArchitectureComponent, ArchitectureElement, ArchitecturePath } from '../../packages/project-model/src/architecture';
import { defaultTrimSheet } from '../../packages/project-model/src/trim-sheet';
import { testArchitecture } from '../arch-test-style';

const ON = process.env['TL_PERF'] === '1';
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'architecture.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const round = (v: number): number => Math.round(v * 100) / 100;
const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

const SHEETS = { '*': defaultTrimSheet() };

/** The test room's elements moved by (dx, dz), their ids made unique per room. */
function roomAt(room: number, dx: number, dz: number, rise = 1.5): ArchitectureElement[] {
  const base = testArchitecture();
  const move = (p: ArchitecturePath): ArchitecturePath => ({ ...p, points: p.points.map((q) => [q[0] + dx, q[1], q[2] + dz] as [number, number, number]) });
  return base.elements.map((e) => {
    const id = `${e.id}-${room}`;
    if (e.kind === 'fill' && e.shape === 'barrel') return { ...e, id, path: move(e.path), rise };
    return { ...e, id, path: move(e.path) } as ArchitectureElement;
  });
}

function village(rise = 1.5, changed = -1, chunkSize = 32): ArchitectureComponent {
  const elements: ArchitectureElement[] = [];
  for (let i = 0; i < 64; i++) elements.push(...roomAt(i, (i % 8) * 12, Math.floor(i / 8) * 12, i === changed ? rise : 1.5));
  return { ...testArchitecture(chunkSize), elements };
}

describe.skipIf(!ON)('architecture generation cost', () => {
  it.each([32, 16])('a village of 64 rooms in %i m chunks: per chunk, keying, a room changed, draws and bytes', (chunkSize) => {
    const c = village(1.5, -1, chunkSize);
    // Warm the generator as a worker is after its first chunks.
    const keys = [...architectureChunkKeys(c, SHEETS).values()];
    for (let i = 0; i < 3; i++) for (const k of keys) generateArchitectureChunk(architectureChunkInput(c, k), SHEETS, k.cx, k.cz);
    const keyTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      architectureChunkKeys(c, SHEETS);
      keyTimes.push(performance.now() - t0);
    }
    const chunkMs: number[] = [];
    let triangles = 0;
    let draws = 0;
    const chunks = [];
    for (const k of keys) {
      const input = architectureChunkInput(c, k);
      const t0 = performance.now();
      const chunk = generateArchitectureChunk(input, SHEETS, k.cx, k.cz);
      chunkMs.push(performance.now() - t0);
      chunks.push(chunk);
      for (const m of chunk.meshes) {
        triangles += m.mesh.indices.length / 3;
        draws += 1;
      }
    }
    const bytes = encodeArchitectureChunks(chunks).length;
    // One room's vault rise changed (a slider dragged): the keys again, then only the chunks whose key changed.
    const regen: number[] = [];
    for (let i = 0; i < 10; i++) {
      const edited = village(1.5 + 0.1 * (i + 1), 27, chunkSize);
      const t0 = performance.now();
      const after = architectureChunkKeys(edited, SHEETS);
      const before = new Set(keys.map((k) => k.key));
      let made = 0;
      for (const k of after.values()) {
        if (before.has(k.key)) continue;
        generateArchitectureChunk(architectureChunkInput(edited, k), SHEETS, k.cx, k.cz);
        made += 1;
      }
      regen.push(performance.now() - t0);
      expect(made).toBeGreaterThan(0);
      expect(made).toBeLessThanOrEqual(4);
    }
    record(
      JSON.stringify({
        rooms: 64,
        chunkSize,
        elements: c.elements.length,
        chunks: keys.length,
        nonEmpty: chunks.filter((k) => k.meshes.length > 0).length,
        draws,
        trianglesNear: triangles,
        chunkMs: { median: round(pct(chunkMs, 0.5)), p95: round(pct(chunkMs, 0.95)), max: round(Math.max(...chunkMs)), total: round(chunkMs.reduce((a, b) => a + b, 0)) },
        keyingMs: round(pct(keyTimes, 0.5)),
        roomChangedMs: { median: round(pct(regen, 0.5)), max: round(Math.max(...regen)) },
        shippedBytes: bytes,
      }),
    );
    expect(pct(chunkMs, 0.5)).toBeLessThan(50);
  });
});
