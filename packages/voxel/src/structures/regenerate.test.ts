/**
 * Regenerating a building over its grid's real store: fresh equals
 * regenerated from any earlier definition, undo and redo exact, nothing
 * changes for an unchanged definition, a material swap changes material
 * ids only, hand edits captured as overrides round-trip through TLVO's
 * bytes, and regenerate-all brings every older structure up to the
 * generator.
 */
import { mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import { denseValue, exportOrAir } from '../cell-delta';
import { chunkGrid, chunkOfKey } from '../coords';
import { createDenseChunk } from '../dense-chunk';
import { canonicalEditCommand } from '../edit-command';
import { applyEdit, applyUndo } from '../edit-apply';
import { createWorldStore } from '../palette-store';
import { PLANE_BIT, valueOf, valueRole, VOXEL_ROLE, type VoxelRecord } from '../record';
import type { VoxelStoreCandidate } from '../store';
import { decodeOverrides, encodeOverrides, type StructureOverrides } from '../structure-overrides';
import { BUILDING_GENERATOR, canonicalStructureDefinition } from './building';
import { StructureDefinitionError, type StructureDefinition } from './definition';
import { boxChunks, type StructureGenerator } from './generator';
import { captureOverrides, regenerateAll, regenerateStructure } from './regenerate';

const grid = chunkGrid(32);
const GRID_ID = 7;
const MAT = { wall: 10, floor: 14, roof: 13, foundation: 6, stair: 14 };
const R = VOXEL_ROLE;
type Pt = [number, number];
const rect = (id: string, x0: number, z0: number, x1: number, z1: number): { id: string; points: Pt[] } => ({ id, points: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });

function def(over: Record<string, unknown> = {}): StructureDefinition {
  return canonicalStructureDefinition({ footprint: [rect('main', 0, 0, 16, 12)], storeys: 2, storeyHeight: 6, foundationDepth: 2, roof: { shape: 'gable', overhang: 1, axis: 'x' }, materials: MAT, openings: [], stairs: [], generator: 1, ...over });
}

const none = (): StructureOverrides => ({ grid, gridId: GRID_ID, chunks: new Map() });

function fresh(d: StructureDefinition): VoxelStoreCandidate {
  const s = createWorldStore(grid);
  const out = createDenseChunk(grid);
  for (const c of boxChunks(grid, BUILDING_GENERATOR.box(d))) if (BUILDING_GENERATOR.chunk(d, grid, c.cx, c.cy, c.cz, out)) s.importChunk(c.cx, c.cy, c.cz, out);
  return s;
}

const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
const val = (s: VoxelStoreCandidate, x: number, y: number, z: number): number => valueOf(s.voxelAt(x, y, z, v));

/** Fails unless two stores hold the same voxels in every chunk either holds. */
function expectSame(a: VoxelStoreCandidate, b: VoxelStoreCandidate, what: string): void {
  const keys = new Set([...a.chunkKeys(), ...b.chunkKeys()]);
  const ca = createDenseChunk(grid);
  const cb = createDenseChunk(grid);
  for (const k of keys) {
    const { cx, cy, cz } = coordsOfKey(k);
    exportOrAir(a, cx, cy, cz, ca);
    exportOrAir(b, cx, cy, cz, cb);
    for (let i = 0; i < grid.cellsPerChunk; i++) {
      const p = denseValue(ca, i);
      const q = denseValue(cb, i);
      if (p !== q) expect.fail(`${what}: chunk (${cx}, ${cy}, ${cz}) cell ${i}: ${p} against ${q}`);
    }
  }
}

/** Every cell of a store's chunks: x, y, z and its value. */
function snapshot(s: VoxelStoreCandidate): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const c = createDenseChunk(grid);
  for (const k of s.chunkKeys()) {
    const { cx, cy, cz } = coordsOfKey(k);
    s.exportChunk(cx, cy, cz, c);
    for (let i = 0; i < grid.cellsPerChunk; i++) out.push([(cx << grid.shift) + (i >>> (grid.shift << 1)), (cy << grid.shift) + (i & grid.mask), (cz << grid.shift) + ((i >>> grid.shift) & grid.mask), denseValue(c, i)]);
  }
  return out;
}

const coordsOfKey = (key: number): { cx: number; cy: number; cz: number } => ({ ...chunkOfKey(grid, key) });

/** A hand edit on the structure's grid, captured as its overrides the way the command layer will. */
function edit(s: VoxelStoreCandidate, d: StructureDefinition, o: StructureOverrides, cmd: Record<string, unknown>): StructureOverrides {
  const out = applyEdit({ store: (id) => (id === GRID_ID ? s : undefined) }, canonicalEditCommand({ v: 2, grid: GRID_ID, ...cmd }));
  return captureOverrides(BUILDING_GENERATOR, d, s, o, out.chunks);
}

const dig = (cells: number[]): Record<string, unknown> => ({ kind: 'dig', cells });
const setCells = (cells: number[], material: number, role: number): Record<string, unknown> => ({ kind: 'set', cells, voxel: { material, role, shape: 15, wetness: 0 } });
const paint = (min: number[], max: number[], material: number, role: number): Record<string, unknown> => ({ kind: 'fill', min, max, mode: 'paint', voxel: { material, role, wetness: 0 } });

describe('regenerating a structure', () => {
  it('writes the definition into an empty grid, then refuses nothing but changes nothing for the same definition', () => {
    const d = def({ stairs: [{ id: 's', polygon: 'main', from: 0, at: [1, 2], facing: '+z' }] });
    const s = createWorldStore(grid);
    const first = regenerateStructure(BUILDING_GENERATOR, s, GRID_ID, none(), d);
    expect(first.changed).toBe(true);
    expect(first.cells).toBeGreaterThan(1000);
    expect(first.undo.every((u) => u.grid === GRID_ID && u.before.kind === 'image' && u.before.bytes === null)).toBe(true);
    expectSame(s, fresh(d), 'first write');
    const again = regenerateStructure(BUILDING_GENERATOR, s, GRID_ID, first.overrides, d);
    expect([again.changed, again.cells, again.undo.length, again.fields]).toEqual([false, 0, 0, 0]);
    expect(again.definition).toBe(d);
  });

  it('equals a fresh generate after any chain of definition changes, and its undo and redo are exact (random definitions and changes)', () => {
    const rnd = mulberry32(4711);
    const pick = (n: number): number => Math.floor(rnd() * n);
    let checked = 0;
    for (let run = 0; run < 12; run++) {
      let d = def({ footprint: [rect('main', pick(4), pick(4), 10 + pick(12), 8 + pick(10))], storeys: 1 + pick(3), roof: { shape: (['flat', 'gable', 'hip'] as const)[pick(3)]!, overhang: pick(3), axis: rnd() < 0.5 ? 'x' : 'z' } });
      const s = createWorldStore(grid);
      regenerateStructure(BUILDING_GENERATOR, s, GRID_ID, none(), d);
      for (let step = 0; step < 6; step++) {
        const next = mutate(d, rnd);
        if (next === null) continue;
        const was = createWorldStore(grid);
        for (const k of s.chunkKeys()) {
          const c = coordsOfKey(k);
          const out = createDenseChunk(grid);
          s.exportChunk(c.cx, c.cy, c.cz, out);
          was.importChunk(c.cx, c.cy, c.cz, out);
        }
        const r = regenerateStructure(BUILDING_GENERATOR, s, GRID_ID, none(), next.def, d);
        expectSame(s, fresh(next.def), `run ${run} step ${step} (${next.what})`);
        applyUndo({ store: () => s }, r.undo);
        expectSame(s, was, `undo of ${next.what}`);
        applyUndo({ store: () => s }, r.redo);
        expectSame(s, fresh(next.def), `redo of ${next.what}`);
        d = next.def;
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  it('swaps a material as material ids only: no role, shape or cell set changes, a painted cell stays painted, a hole stays cut', () => {
    const d = def({ openings: [{ id: 'door', polygon: 'main', edge: 0, storey: 0, at: 6, width: 2, height: 4, sill: 0 }] });
    const s = fresh(d);
    let o = edit(s, d, none(), paint([0, 2, 4], [0, 3, 5], 15, R.wall));
    o = edit(s, d, o, dig([15, 2, 6, 15, 3, 6]));
    for (const [part, to] of [['wall', 12], ['roof', 16], ['floor', 17]] as const) {
      const swapped = def({ ...d, materials: { ...d.materials, [part]: to } });
      const was = snapshot(s);
      const r = regenerateStructure(BUILDING_GENERATOR, s, GRID_ID, o, swapped);
      expect(r.fields, part).toBe(PLANE_BIT.material);
      expect(r.misfits, part).toEqual([]);
      expect(r.materialSwaps.length, part).toBeGreaterThan(0);
      // Cell by cell: the same cells solid, each with its role, shape and wetness; only material ids differ.
      let differ = 0;
      for (const [x, y, z, before] of was) {
        const now = val(s, x, y, z);
        expect(now === 0, `${part} (${x}, ${y}, ${z})`).toBe(before === 0);
        expect(now & ~0xfff, `${part} (${x}, ${y}, ${z})`).toBe(before & ~0xfff);
        if (now !== before) differ++;
      }
      expect(differ, part).toBe(r.cells);
      expect(s.voxelAt(0, 2, 4, v).material, part).toBe(15);
      expect(val(s, 15, 2, 6), part).toBe(0);
      o = r.overrides;
      // Swap back for the next part.
      const back = regenerateStructure(BUILDING_GENERATOR, s, GRID_ID, o, d);
      expect(back.fields).toBe(PLANE_BIT.material);
      o = back.overrides;
    }
  });

  it('keeps hand edits through capture, TLVO bytes and a regenerate: the grid rebuilt from the decoded overrides is the edited grid', () => {
    const d = def({ footprint: [rect('a', 0, 0, 20, 10), rect('b', 0, 10, 10, 24)], roof: { shape: 'hip', overhang: 1, axis: 'x' } });
    const s = fresh(d);
    let o = none();
    o = edit(s, d, o, dig([5, 2, 0, 6, 2, 0, 5, 3, 0, 6, 3, 0]));
    o = edit(s, d, o, setCells([4, 1, 4, 4, 2, 4, 4, 3, 4], 11, R.pillar));
    o = edit(s, d, o, paint([0, 1, 12], [0, 5, 14], 15, R.wall));
    o = edit(s, d, o, { kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [10, 14, 5], mode: 'dig', smooth: false });
    const cells = [...o.chunks.values()].reduce((n, c) => n + c.value.count, 0);
    expect(cells).toBeGreaterThan(20);
    // Putting a dug cell back to what the generator makes drops its override.
    const before = cells;
    o = edit(s, d, o, setCells([5, 2, 0], MAT.wall, R.wall));
    expect([...o.chunks.values()].reduce((n, c) => n + c.value.count, 0)).toBe(before - 1);
    const bytes = encodeOverrides(o);
    const back = decodeOverrides(grid, bytes);
    expect(encodeOverrides(back)).toEqual(bytes);
    const rebuilt = createWorldStore(grid);
    const r = regenerateStructure(BUILDING_GENERATOR, rebuilt, GRID_ID, back, d);
    expect([r.kept, r.absorbed, r.misfits.length]).toEqual([before - 1, 0, 0]);
    expectSame(rebuilt, s, 'rebuilt from the overrides');
    expect(encodeOverrides(r.overrides)).toEqual(bytes);
  });

  it('regenerates every structure an older generator wrote as one report, leaving current ones alone', () => {
    // A test generator one version on, which lays the foundation one row deeper.
    const next: StructureGenerator<StructureDefinition> = {
      kind: 'building',
      version: 2,
      canonical: (input) => input as StructureDefinition,
      box: (d) => {
        const b = BUILDING_GENERATOR.box(d);
        return { ...b, minY: b.minY - 1 };
      },
      chunk: (d, g, cx, cy, cz, out) => BUILDING_GENERATOR.chunk({ ...d, foundationDepth: d.foundationDepth + 1 }, g, cx, cy, cz, out),
    };
    const a = def();
    const b = def({ footprint: [rect('main', 0, 0, 10, 10)] });
    const sa = fresh(a);
    const sb = fresh(b);
    const oa = edit(sa, a, none(), dig([3, -2, 3]));
    const report = regenerateAll(next, [
      { name: 'a', store: sa, gridId: GRID_ID, overrides: oa, definition: a },
      { name: 'b', store: sb, gridId: 8, overrides: { grid, gridId: 8, chunks: new Map() }, definition: { ...b, generator: 2 } },
    ]);
    expect(report.current).toEqual(['b']);
    expect(report.regenerated.map((x) => x.name)).toEqual(['a']);
    const ra = report.regenerated[0]!.report;
    expect(ra.definition.generator).toBe(2);
    expect(ra.cells).toBe(16 * 12);
    expect([report.kept, report.absorbed, report.misfits]).toEqual([1, 0, 0]);
    expect(val(sa, 3, -2, 3)).toBe(0);
    expect(valueRole(val(sa, 3, -3, 4))).toBe(R.foundation);
  });

  it('refuses a definition the generator cannot read', () => {
    expect(() => canonicalStructureDefinition({ ...def(), generator: 9 })).toThrow(StructureDefinitionError);
  });
});

/** One random change a designer makes: scale, a wing, a storey, the roof, a material, an opening added, moved or removed. */
function mutate(d: StructureDefinition, rnd: () => number): { def: StructureDefinition; what: string } | null {
  const pick = (n: number): number => Math.floor(rnd() * n);
  const main = d.footprint[0]!;
  const kind = pick(8);
  let input: Record<string, unknown>;
  let what: string;
  switch (kind) {
    case 0: {
      const [x1, z1] = main.points[2]!;
      const dx = pick(5) - 2;
      const dz = pick(5) - 2;
      input = { ...d, footprint: [rect(main.id, main.points[0]![0], main.points[0]![1], x1 + dx, z1 + dz), ...d.footprint.slice(1)] };
      what = `scale ${dx}, ${dz}`;
      break;
    }
    case 1: {
      const x0 = main.points[0]![0];
      const z1 = main.points[2]![1];
      input = { ...d, footprint: [...d.footprint, rect(`w${d.footprint.length}`, x0 + pick(4), z1 - 2, x0 + 6 + pick(6), z1 + 4 + pick(8))] };
      what = 'add a wing';
      break;
    }
    case 2:
      input = { ...d, storeys: Math.max(1, d.storeys + (rnd() < 0.7 ? 1 : -1)) };
      what = 'storeys';
      break;
    case 3:
      input = { ...d, roof: { shape: (['flat', 'gable', 'hip'] as const)[pick(3)]!, overhang: pick(3), axis: rnd() < 0.5 ? 'x' : 'z' } };
      what = 'roof';
      break;
    case 4:
      input = { ...d, materials: { ...d.materials, [(['wall', 'floor', 'roof', 'foundation', 'stair'] as const)[pick(5)]!]: 20 + pick(20) } };
      what = 'material';
      break;
    case 5:
      input = { ...d, openings: [...d.openings, { id: `o${d.openings.length}-${pick(1000)}`, polygon: main.id, edge: pick(4), storey: pick(d.storeys), at: 2 + pick(4), width: 1 + pick(3), height: 1 + pick(4), sill: pick(2) }] };
      what = 'add an opening';
      break;
    case 6: {
      if (d.openings.length === 0) return null;
      const k = pick(d.openings.length);
      input = { ...d, openings: d.openings.map((o, i) => (i === k ? { ...o, at: Math.max(0, o.at + pick(3) - 1) } : o)) };
      what = 'move an opening';
      break;
    }
    default: {
      if (d.openings.length === 0) return null;
      const k = pick(d.openings.length);
      input = { ...d, openings: d.openings.filter((_, i) => i !== k) };
      what = 'remove an opening';
    }
  }
  try {
    return { def: canonicalStructureDefinition(input), what };
  } catch (e) {
    if (e instanceof StructureDefinitionError) return null;
    throw e;
  }
}
