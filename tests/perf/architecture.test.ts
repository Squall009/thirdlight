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
import { ARCHITECTURE_PRESET_KIND } from '../../packages/project-model/src/arch-style-kinds';
import { expandArchitecture } from '../../packages/project-model/src/arch-rooms';
import { architectureStylesOf } from '../../packages/project-model/src/arch-style';
import { encodeWallPaint, wallPaintSteps, wallPointKey } from '../../packages/project-model/src/block-wall-paint';
import { moveWall } from '../../packages/editor/src/session/room-draw';
import { architecturePaintOf } from '../../packages/project-model/src/arch-room-grid';

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

  it.each([32, 16])('a village of 64 styled rooms in %i m chunks: a preset slider dragged over one room (expand, keys, its changed chunks)', (chunkSize) => {
    // 64 outlines; room 27 alone wears a preset derived from the starter room (its slider is the one dragged).
    const graphs = [{ graphId: 'one', kind: ARCHITECTURE_PRESET_KIND, name: 'One', graph: { nodes: [{ id: 'preset', type: 'preset', position: [0, 0] as [number, number], data: { style: '', base: 'starter-room', sheet: '' } }], edges: [] } }];
    const outlines = Array.from({ length: 64 }, (_, i) => {
      const x = (i % 8) * 12;
      const z = Math.floor(i / 8) * 12;
      return { id: `r${i}`, preset: i === 27 ? 'one' : 'starter-room', path: { points: [[x, 0, z], [x + 8, 0, z], [x + 8, 0, z + 6], [x, 0, z + 6]] as [number, number, number][], closed: true }, openings: [{ id: 'door', at: 4, width: 1.2, bottom: 0, top: 2.2, frameSides: 'both' as const }] };
    });
    const raw: ArchitectureComponent = { elements: [], chunkSize, outlines };
    const table = architectureStylesOf(graphs);
    const base = expandArchitecture(raw, [0, 0, 0], table).component;
    const keys = [...architectureChunkKeys(base, SHEETS).values()];
    const chunkMs: number[] = [];
    for (let i = 0; i < 2; i++) for (const k of keys) generateArchitectureChunk(architectureChunkInput(base, k), SHEETS, k.cx, k.cz);
    let draws = 0;
    for (const k of keys) {
      const t0 = performance.now();
      const chunk = generateArchitectureChunk(architectureChunkInput(base, k), SHEETS, k.cx, k.cz);
      chunkMs.push(performance.now() - t0);
      draws += chunk.meshes.length;
    }
    const before = new Set(keys.map((k) => k.key));
    const expandMs: number[] = [];
    const regen: number[] = [];
    let made = 0;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const edited = expandArchitecture(raw, [0, 0, 0], table, { preview: { preset: 'one', values: { ceiling_height: 3 + 0.05 * (i + 1), moulding_depth: 0.08 + 0.005 * i } } }).component;
      expandMs.push(performance.now() - t0);
      made = 0;
      for (const k of architectureChunkKeys(edited, SHEETS).values()) {
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
        styledRooms: 64,
        chunkSize,
        elements: base.elements.length,
        chunks: keys.length,
        draws,
        chunkMs: { median: round(pct(chunkMs, 0.5)), p95: round(pct(chunkMs, 0.95)), max: round(Math.max(...chunkMs)) },
        expandMs: round(pct(expandMs, 0.5)),
        sliderRoomMs: { median: round(pct(regen, 0.5)), max: round(Math.max(...regen)), chunksMade: made },
      }),
    );
  });

  it('64 rooms sharing walls on a painted block layer (16 m chunks): expand, chunks with paint, a shared wall dragged (expand, keys, its changed chunks)', () => {
    // 8 × 8 rooms of 8 × 6 m side by side (every inner wall shared), a door on each room's first side, on a layer
    // with wall paint over every chunk (a painted stripe on each wall plane's points).
    const outlines = Array.from({ length: 64 }, (_, i) => {
      const x = (i % 8) * 8;
      const z = Math.floor(i / 8) * 6;
      return { id: `r${i}`, preset: 'starter-room', path: { points: [[x, 0, z], [x + 8, 0, z], [x + 8, 0, z + 6], [x, 0, z + 6]] as [number, number, number][], closed: true }, openings: [{ id: 'door', at: 4.5, width: 1, bottom: 0, top: 2.1 }] };
    });
    const st = wallPaintSteps([1, 1, 1]);
    const chunksPaint: Record<string, string> = {};
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 3; cz++) {
      const points = new Map<number, Uint8Array>();
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) for (let side = 0; side < 4; side++) for (let k = 0; k <= 3 * st.up; k += 2) points.set(wallPointKey(lx, lz, side, 1, k), Uint8Array.from([0, 0, 255, 0, 128]));
      chunksPaint[`${cx},${cz}`] = encodeWallPaint(points)!;
    }
    const paint = architecturePaintOf({ cellSize: [1, 1, 1], wallPaint: true }, Object.entries(chunksPaint).map(([k, v]) => ({ cx: Number(k.split(',')[0]), cz: Number(k.split(',')[1]), wallPaint: v })), [0, 0, 0], [0, 0, 0])!;
    const raw: ArchitectureComponent = { elements: [], chunkSize: 16, layer: 'floor', outlines };
    const table = architectureStylesOf([]);
    const expandMs: number[] = [];
    let base = expandArchitecture(raw, [0, 0, 0], table, { paint }).component;
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      base = expandArchitecture(raw, [0, 0, 0], table, { paint }).component;
      expandMs.push(performance.now() - t0);
    }
    const walls = base.elements.filter((e) => e.kind === 'sweep' && e.wall === true).length;
    const keys = [...architectureChunkKeys(base, SHEETS).values()];
    for (let i = 0; i < 2; i++) for (const k of keys) generateArchitectureChunk(architectureChunkInput(base, k), SHEETS, k.cx, k.cz);
    const chunkMs: number[] = [];
    const plainMs: number[] = [];
    let draws = 0;
    let perMaterial = 0;
    const plain = { ...base, paint: undefined };
    for (const k of keys) {
      let t0 = performance.now();
      const chunk = generateArchitectureChunk(architectureChunkInput(base, k), SHEETS, k.cx, k.cz);
      chunkMs.push(performance.now() - t0);
      t0 = performance.now();
      generateArchitectureChunk(architectureChunkInput(plain, k), SHEETS, k.cx, k.cz);
      plainMs.push(performance.now() - t0);
      draws += chunk.meshes.length;
      perMaterial = Math.max(perMaterial, ...[...new Set(chunk.meshes.map((m) => m.material))].map((m) => chunk.meshes.filter((x) => x.material === m).length));
    }
    expect(perMaterial).toBeLessThanOrEqual(1);
    // A wall dragged a cell at a time (room 27's east side, shared with room 28: both rooms move with it).
    const drag = (withPaint: boolean): { ms: number[]; made: number; expandKeys: number[] } => {
      const before = new Set([...architectureChunkKeys(withPaint ? base : plain, SHEETS).values()].map((k) => k.key));
      const ms: number[] = [];
      const expandKeys: number[] = [];
      let made = 0;
      for (let i = 1; i <= 8; i++) {
        const t0 = performance.now();
        const moved = moveWall(raw, 'r27', 1, -(1 + (i % 3)));
        const edited = expandArchitecture(moved, [0, 0, 0], table, withPaint ? { paint } : {}).component;
        const ks = [...architectureChunkKeys(edited, SHEETS).values()];
        expandKeys.push(performance.now() - t0);
        made = 0;
        for (const k of ks) {
          if (before.has(k.key)) continue;
          generateArchitectureChunk(architectureChunkInput(edited, k), SHEETS, k.cx, k.cz);
          made += 1;
        }
        ms.push(performance.now() - t0);
      }
      return { ms, made, expandKeys };
    };
    const painted = drag(true);
    const unpainted = drag(false);
    const regen = painted.ms;
    const made = painted.made;
    record(
      JSON.stringify({
        sharedRooms: 64,
        chunkSize: 16,
        wallPieces: walls,
        elements: base.elements.length,
        chunks: keys.length,
        draws,
        expandMs: { median: round(pct(expandMs, 0.5)), max: round(Math.max(...expandMs)) },
        chunkMs: { median: round(pct(chunkMs, 0.5)), p95: round(pct(chunkMs, 0.95)), max: round(Math.max(...chunkMs)) },
        unpaintedChunkMs: { median: round(pct(plainMs, 0.5)), max: round(Math.max(...plainMs)) },
        wallDragMs: { median: round(pct(regen, 0.5)), max: round(Math.max(...regen)), chunksMade: made, pageShare: round(pct(painted.expandKeys, 0.5)) },
        unpaintedWallDragMs: { median: round(pct(unpainted.ms, 0.5)), max: round(Math.max(...unpainted.ms)), pageShare: round(pct(unpainted.expandKeys, 0.5)) },
      }),
    );
  });
});
