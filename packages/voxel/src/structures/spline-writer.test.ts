/**
 * The spline writer over real ground, through the world-writer core: the
 * cells of a road, a path and a river against their own reading of the
 * course; fresh equals rewritten from any earlier course, undo and redo
 * exact; a deleted spline gives the ground back; hand edits by the fit
 * rule or left alone and reported; a river joining a body at its level;
 * the same cells whatever the chunk edge and order, twice.
 */
import { describe, expect, it } from 'vitest';
import { denseValue, exportOrAir } from '../cell-delta';
import { chunkGrid, chunkOfKey, VOXEL_SIZE_M, type ChunkGrid } from '../coords';
import { createDenseChunk } from '../dense-chunk';
import { applyUndo } from '../edit-apply';
import { createWorldStore } from '../palette-store';
import { readValue, recordValue, SHAPE_FULL, valueMaterial, valueOf, valueRole, valueShape, VOXEL_ROLE, type VoxelRecord } from '../record';
import type { VoxelStoreCandidate } from '../store';
import { decodeOverrides, encodeOverrides } from '../structure-overrides';
import { fillShapeAt } from '../water/level-fill';
import { SPLINE_WRITER, type SplineVoxelDefinition } from './spline-writer';
import { emptyWorldRecord, groundOf, rewriteInWorld, writeRecordOf, type WorldRecord } from './world-writer';

const C = VOXEL_SIZE_M;
const R = VOXEL_ROLE;
const MAT = { grass: 2, soil: 3, stone: 9, road: 20, gravel: 21, water: 30, lake: 31 };
const rec: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };

/** Ground from y −16 up to a height in cells per column (rolling unless `flat`). */
function ground(grid: ChunkGrid, x0: number, x1: number, z0: number, z1: number, height: (x: number, z: number) => number): VoxelStoreCandidate {
  const s = createWorldStore(grid);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const h = height(x, z);
      for (let y = -16; y < Math.ceil(h); y++) {
        const share = Math.min(1, h - y);
        readValue(recordValue(y >= Math.ceil(h) - 2 ? MAT.grass : MAT.soil, R.terrain, Math.max(1, Math.round(share * SHAPE_FULL)), 0), rec);
        s.setVoxel(x, y, z, rec);
      }
    }
  }
  return s;
}

const rolling = (x: number, z: number): number => 4 + 3 * Math.sin(x / 9) + 2 * Math.cos(z / 7);
const flat = (): number => 4;

/** A course through points [x, y, z, width] (metres), sampled every quarter metre along straight runs. */
function course(points: number[][], closed = false): number[] {
  const out: number[] = [];
  const n = points.length;
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const a = points[k]!;
    const b = points[(k + 1) % n]!;
    const len = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!);
    const steps = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 0; i < steps; i++) {
      const u = i / steps;
      out.push(a[0]! + (b[0]! - a[0]!) * u, a[1]! + (b[1]! - a[1]!) * u, a[2]! + (b[2]! - a[2]!) * u, a[3]! + (b[3]! - a[3]!) * u);
    }
  }
  if (!closed) out.push(...points[n - 1]!);
  return out;
}

function road(points: number[][], over: Partial<SplineVoxelDefinition> = {}): SplineVoxelDefinition {
  return { generator: 1, kind: 'road', material: MAT.road, bed: { material: MAT.gravel, depth: 1 }, depth: 1, shoulder: null, clear: 0, samples: course(points), closed: false, bodies: [], ...over };
}

const val = (s: VoxelStoreCandidate, x: number, y: number, z: number): number => valueOf(s.voxelAt(x, y, z, rec));

function snapshot(s: VoxelStoreCandidate): Map<string, number> {
  const out = new Map<string, number>();
  const d = createDenseChunk(s.grid);
  for (const k of s.chunkKeys()) {
    const c = chunkOfKey(s.grid, k);
    exportOrAir(s, c.cx, c.cy, c.cz, d);
    for (let i = 0; i < s.grid.cellsPerChunk; i++) {
      const v = denseValue(d, i);
      if (v !== 0) out.set(`${c.cx},${c.cy},${c.cz},${i}`, v);
    }
  }
  return out;
}

function expectSameCells(a: VoxelStoreCandidate, b: VoxelStoreCandidate, what: string): void {
  const p = snapshot(a);
  const q = snapshot(b);
  for (const [k, v] of p) if (q.get(k) !== v) expect.fail(`${what}: ${k} holds ${v} against ${q.get(k) ?? 0}`);
  for (const [k, v] of q) if (!p.has(k)) expect.fail(`${what}: ${k} holds 0 against ${v}`);
}

const recordBytes = (r: WorldRecord): string => Array.from(encodeOverrides(r), (b) => b.toString(16).padStart(2, '0')).join('');

/** The cell's centre (metres) measured to a straight segment's line, square at its ends (null: past an end). */
function across(ax: number, az: number, bx: number, bz: number, x: number, z: number): number | null {
  const px = (x + 0.5) * C;
  const pz = (z + 0.5) * C;
  const dx = bx - ax;
  const dz = bz - az;
  const u = ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz);
  if (u < 0 || u > 1) return null;
  return Math.hypot(ax + dx * u - px, az + dz * u - pz);
}

describe('spline writer: roads and paths', () => {
  const grid = chunkGrid(32);

  it('writes the surface across the width, the bed under it and nothing past the edge, on flat ground', () => {
    const s = ground(grid, -8, 140, -24, 24, flat);
    const d = road([[0, 2.25, 0, 6], [60, 2.25, 0, 6]], { clear: 2 });
    const r = rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), d);
    expect(r.changed).toBe(true);
    for (let x = -4; x <= 124; x++) {
      for (let z = -12; z <= 12; z++) {
        const d0 = across(0, 0, 60, 0, x, z);
        const on = d0 !== null && d0 <= 3;
        // The course's height 2.25 m = 4.5 cells: row 4 half full of road, row 3 full of road, rows 1-2 the bed.
        if (on) {
          expect(valueMaterial(val(s, x, 4, z)), `${x},${z}`).toBe(MAT.road);
          expect(valueShape(val(s, x, 4, z))).toBe(fillShapeAt(4.5, 4));
          expect(valueMaterial(val(s, x, 3, z))).toBe(MAT.road);
          expect(valueMaterial(val(s, x, 2, z))).toBe(MAT.gravel);
          expect(valueMaterial(val(s, x, 1, z))).toBe(MAT.gravel);
          expect(valueMaterial(val(s, x, 0, z))).toBe(MAT.soil);
          for (let y = 5; y < 9; y++) expect(val(s, x, y, z)).toBe(0);
        } else {
          expect(valueMaterial(val(s, x, 3, z)), `${x},${z} off the road`).toBe(MAT.grass);
        }
      }
    }
    // 6 m wide, 60 m long: 12 × 120 columns, the half-full top row over ground's full one, the next row and 2 bed rows.
    expect(r.written).toBe(12 * 120 * 4);
  });

  it('fresh equals rewritten after a point moves, a width changes and the kind changes; undo and redo exact', () => {
    const base = ground(grid, -40, 120, -40, 40, rolling);
    const courses: SplineVoxelDefinition[] = [
      road([[0, 3, 0, 6], [30, 3.5, 10, 6], [80, 2, 0, 6]], { shoulder: { width: 3, slope: 1 }, clear: 3 }),
      road([[0, 3, 0, 6], [30, 3.5, -6, 6], [80, 2, 0, 6]], { shoulder: { width: 3, slope: 1 }, clear: 3 }),
      road([[0, 3, 0, 4], [30, 3.5, -6, 9], [80, 2, 0, 5]], { shoulder: { width: 2, slope: 0.5 }, clear: 1 }),
      road([[0, 3, 0, 4], [30, 3.5, -6, 9], [80, 2, 0, 5]], { kind: 'river', material: MAT.water, bed: { material: MAT.gravel, depth: 1.5 }, depth: 1.5, shoulder: null, clear: 2 }),
    ];
    const s = ground(grid, -40, 120, -40, 40, rolling);
    let record = emptyWorldRecord(grid);
    for (const [i, d] of courses.entries()) {
      const before = snapshot(s);
      const r = rewriteInWorld(SPLINE_WRITER, s, record, d);
      const f = ground(grid, -40, 120, -40, 40, rolling);
      const fr = rewriteInWorld(SPLINE_WRITER, f, emptyWorldRecord(grid), d);
      expectSameCells(s, f, `course ${i} rewritten against fresh`);
      expect(recordBytes(r.record)).toBe(recordBytes(fr.record));
      applyUndo({ store: () => s }, r.undo);
      expect(snapshot(s)).toEqual(before);
      applyUndo({ store: () => s }, r.redo);
      expectSameCells(s, f, `course ${i} redone`);
      record = r.record;
    }
    // Gone: the ground is back, cell for cell.
    const gone = rewriteInWorld(SPLINE_WRITER, s, record, null);
    expect(gone.record.chunks.size).toBe(0);
    expect(gone.leftAlone).toEqual([]);
    expectSameCells(s, base, 'deleted');
  });

  it('follows a curve and its widths point by point', () => {
    const s = ground(grid, -40, 140, -60, 60, flat);
    // A bend: the samples of a quarter circle of radius 20 m, 2 m wide at its start, 10 m at its end.
    const pts: number[][] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * (Math.PI / 2);
      pts.push([20 * Math.sin(a), 2.25, 20 - 20 * Math.cos(a), 2 + 8 * (i / 40)]);
    }
    const d = road(pts, { bed: null });
    rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), d);
    let wrong = 0;
    let on = 0;
    for (let x = -10; x <= 70; x++) {
      for (let z = -10; z <= 70; z++) {
        const px = (x + 0.5) * C;
        const pz = (z + 0.5) * C;
        // Distance from the circle's centre (0, 20), and the angle along it.
        const r = Math.hypot(px, pz - 20);
        const a = Math.atan2(px, 20 - pz);
        const inArc = a >= 0 && a <= Math.PI / 2;
        const half = (2 + 8 * (a / (Math.PI / 2))) / 2;
        const expected = inArc && Math.abs(r - 20) <= half;
        const got = valueMaterial(val(s, x, 4, z)) === MAT.road;
        if (expected) on++;
        // Cells within a sample's step of the edge may go either way (the samples are a polyline).
        if (expected !== got && Math.abs(Math.abs(r - 20) - half) > 0.1 && Math.abs(a) > 0.02 && Math.abs(a - Math.PI / 2) > 0.02) wrong++;
      }
    }
    expect(on).toBeGreaterThan(700);
    expect(wrong).toBe(0);
  });

  it('meets uneven ground with its shoulders: cut above the rising line, filled under the falling one', () => {
    // Ground rising steeply across the road: 2 m below it on one side, 3 m above it on the other.
    const slope = (_x: number, z: number): number => 4.5 + z * 0.5;
    const s = ground(grid, -8, 60, -30, 30, slope);
    const d = road([[0, 2.25, 0, 4], [20, 2.25, 0, 4]], { bed: null, shoulder: { width: 4, slope: 1 } });
    rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), d);
    const top = 4.5;
    for (let x = 4; x <= 36; x++) {
      for (let z = -16; z <= 16; z++) {
        const e = Math.abs((z + 0.5) * C) - 2;
        if (e <= 0 || e > 4) continue;
        const cut = top + (e / C) * 1;
        const bank = top - (e / C) * 1;
        // Nothing solid wholly above the cut line, nothing open wholly under the bank line down to the shoulder's reach.
        for (let y = Math.ceil(cut); y < top + 8; y++) expect(val(s, x, y, z), `cut ${x},${y},${z}`).toBe(0);
        for (let y = Math.max(Math.floor(top - 8), -16); y < Math.floor(bank); y++) expect(val(s, x, y, z), `fill ${x},${y},${z}`).not.toBe(0);
      }
    }
  });

  it('climbs a slope with its top cells filled to the course', () => {
    const s = ground(grid, -8, 120, -16, 16, flat);
    const d = road([[0, 2, 0, 4], [50, 7, 0, 4]], { bed: null, clear: 4 });
    rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), d);
    for (let x = 2; x < 98; x += 3) {
      const yM = 2 + (5 * ((x + 0.5) * C)) / 50;
      const top = yM / C;
      let row = Math.ceil(top) - 1;
      if (fillShapeAt(top, row) === 0) row--;
      const v = val(s, x, row, 0);
      expect(valueMaterial(v), `x ${x}`).toBe(MAT.road);
      expect(Math.abs(valueShape(v) - fillShapeAt(top, row))).toBeLessThanOrEqual(1);
      expect(val(s, x, row + 1, 0)).toBe(0);
    }
  });

  it('writes the same cells at any chunk edge and in any chunk order, twice', () => {
    const run = (g: ChunkGrid): Map<string, number> => {
      const s = ground(g, -20, 100, -30, 30, rolling);
      const d = road([[0, 3, 0, 6], [25, 4, 8, 7], [45, 2, -5, 5]], { shoulder: { width: 2, slope: 0.75 }, clear: 2 });
      rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(g), d);
      const out = new Map<string, number>();
      for (let x = -20; x <= 100; x++) for (let z = -30; z <= 30; z++) for (let y = -16; y < 24; y++) out.set(`${x},${y},${z}`, val(s, x, y, z));
      return out;
    };
    const a = run(chunkGrid(32));
    expect(run(chunkGrid(16))).toEqual(a);
    expect(run(chunkGrid(32))).toEqual(a);
    // Reversed chunk order: each chunk's writes read the same ground.
    const g = chunkGrid(32);
    const s = ground(g, -20, 100, -30, 30, rolling);
    const d = road([[0, 3, 0, 6], [25, 4, 8, 7], [45, 2, -5, 5]], { shoulder: { width: 2, slope: 0.75 }, clear: 2 });
    const fwd = writeRecordOf(SPLINE_WRITER, g, d, groundOf(s, emptyWorldRecord(g)));
    const rev = emptyWorldRecord(g);
    const box = SPLINE_WRITER.box(d)!;
    const keys = [...fwd.chunks.keys()].reverse();
    for (const k of keys) {
      const c = chunkOfKey(g, k);
      const one = writeRecordOf(SPLINE_WRITER, g, { ...d }, groundOf(s, emptyWorldRecord(g)));
      rev.chunks.set(k, one.chunks.get(k)!);
      void c;
    }
    expect(box.minX).toBeLessThan(box.maxX);
    expect(recordBytes({ ...rev, chunks: new Map([...rev.chunks].sort((p, q) => p[0] - q[0])) })).toBe(recordBytes(fwd));
  });

  it('rewrites only the chunks where the course moved', () => {
    const s = ground(grid, -8, 1100, -24, 24, flat);
    const pts = Array.from({ length: 21 }, (_, i) => [i * 25, 2.25, 0, 6]);
    const r1 = rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), road(pts));
    const moved = pts.map((p, i) => (i === 10 ? [p[0]!, p[1]!, 4, p[3]!] : p));
    const r2 = rewriteInWorld(SPLINE_WRITER, s, r1.record, road(moved));
    const chunks = new Set(r2.undo.map((u) => `${u.cx},${u.cz}`));
    // The span from point 9 to point 11 (50 m) lies in about 4 chunk columns of 16 m, of the road's 32.
    expect(r1.undo.length).toBeGreaterThan(60);
    expect(chunks.size).toBeLessThanOrEqual(8);
    for (const u of r2.undo) expect((u.cx * 32 + 16) * C).toBeGreaterThan(200);
  });
});

describe('spline writer: hand edits and the record', () => {
  const grid = chunkGrid(32);

  it('keeps a dig on the road by the fit rule, reports one that no longer fits, and leaves one alone when the road leaves', () => {
    const s = ground(grid, -8, 80, -24, 24, flat);
    const r1 = rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), road([[0, 2.25, 0, 6], [40, 2.25, 0, 6]]));
    // A hole dug in the surface at x = 40 cells, and a block of stone set into the bed at x = 60.
    for (let y = 3; y <= 4; y++) s.setVoxel(40, y, 0, { material: 0, role: 0, shape: 0, wetness: 0 });
    s.setVoxel(60, 1, 1, { material: MAT.stone, role: R.terrain, shape: SHAPE_FULL, wetness: 0 });
    // Wider: both cells still under the road, the dig kept (air over the surface's base), the stone kept (terrain over terrain).
    const r2 = rewriteInWorld(SPLINE_WRITER, s, r1.record, road([[0, 2.25, 0, 8], [40, 2.25, 0, 8]]));
    expect(r2.kept).toBe(3);
    expect(r2.misfits).toEqual([]);
    expect(val(s, 40, 4, 0)).toBe(0);
    expect(valueMaterial(val(s, 60, 1, 1))).toBe(MAT.stone);
    // A river now along it: the dug surface's cells are liquid there (solid base, liquid now: a misfit, the water written).
    const r3 = rewriteInWorld(SPLINE_WRITER, s, r2.record, road([[0, 2.25, 0, 8], [40, 2.25, 0, 8]], { kind: 'river', material: MAT.water, bed: { material: MAT.gravel, depth: 1 }, depth: 1 }));
    expect(r3.misfits.map((m) => [m.x, m.y, m.z])).toEqual(expect.arrayContaining([[40, 3, 0]]));
    expect(valueRole(val(s, 40, 3, 0))).toBe(R.liquid);
    // Moved off: the stone block left alone and reported, everything else given back.
    const r4 = rewriteInWorld(SPLINE_WRITER, s, r3.record, road([[0, 2.25, 30, 4], [40, 2.25, 30, 4]]));
    expect(r4.leftAlone.some((c) => c.x === 60 && c.y === 1 && c.z === 1)).toBe(true);
    expect(valueMaterial(val(s, 60, 1, 1))).toBe(MAT.stone);
    expect(valueMaterial(val(s, 20, 3, 0))).toBe(MAT.grass);
  });

  it('round-trips the record through its TLVO bytes and rewrites from it alone', () => {
    const s = ground(grid, -20, 100, -30, 30, rolling);
    const d1 = road([[0, 3, 0, 6], [40, 3, 5, 6]], { shoulder: { width: 2, slope: 1 }, clear: 2 });
    const r1 = rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), d1);
    const bytes = encodeOverrides(r1.record);
    const back = decodeOverrides(grid, bytes);
    expect(recordBytes(back)).toBe(recordBytes(r1.record));
    // About ten bytes a cell: the codec's 10 a cell, a chunk's 10-byte header, 20 bytes of header and checksum.
    expect(bytes.length).toBe(20 + back.chunks.size * 10 + r1.written * 10);
    rewriteInWorld(SPLINE_WRITER, s, back, null);
    expectSameCells(s, ground(grid, -20, 100, -30, 30, rolling), 'put back from the decoded record');
  });
});

describe('spline writer: rivers', () => {
  const grid = chunkGrid(32);

  it('runs liquid to the course down its depth over its bed, and meets a body at the body\'s level in its material', () => {
    const s = ground(grid, -8, 120, -24, 24, flat);
    const meet = { level: 1.25, material: MAT.lake, seed: [50, 0] as const, reach: 12 };
    const d: SplineVoxelDefinition = { generator: 1, kind: 'river', material: MAT.water, bed: { material: MAT.gravel, depth: 1.5 }, depth: 1.5, shoulder: null, clear: 0, samples: course([[0, 2, 0, 4], [50, 2, 0, 4]]), closed: false, bodies: [meet] };
    rewriteInWorld(SPLINE_WRITER, s, emptyWorldRecord(grid), d);
    // Far from the lake: liquid rows from (2 − 1.5) m = row 1 to row 3, the bed at row 0.
    for (const x of [10, 30]) {
      expect(valueRole(val(s, x, 3, 0))).toBe(R.liquid);
      expect(valueMaterial(val(s, x, 3, 0))).toBe(MAT.water);
      expect(valueMaterial(val(s, x, 1, 0))).toBe(MAT.water);
      expect(valueMaterial(val(s, x, 0, 0))).toBe(MAT.gravel);
      expect(val(s, x, 4, 0)).toBe(0);
    }
    // Inside the reach (from 38 m on): rows under 1.25 m (2.5 cells) are the lake's, row 2 half full; above them the river's.
    for (const x of [80, 95]) {
      expect(valueMaterial(val(s, x, 1, 0))).toBe(MAT.lake);
      expect(valueMaterial(val(s, x, 2, 0))).toBe(MAT.lake);
      expect(valueShape(val(s, x, 2, 0))).toBe(fillShapeAt(2.5, 2));
      expect(valueMaterial(val(s, x, 3, 0))).toBe(MAT.water);
    }
    // An open end: nothing past the last point.
    expect(valueMaterial(val(s, 102, 3, 0))).toBe(MAT.grass);
  });
});
