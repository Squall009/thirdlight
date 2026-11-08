/**
 * The relief mesh on real worlds through the worker's derive path: slice,
 * town (ground and roofs), hilly ground and caves, n = 2, 4, 8, each in a
 * window of 2 × 2 × 2 sections that straddles chunk faces. Crack-free per
 * section and across section and chunk faces (every relief edge with other
 * than two triangles lies along the plain mesh's own outline), the same
 * area, crease weights two sections agree on, plain neighbours met on
 * today's edges, every other derived output byte for byte the plain
 * derive's, and deterministic.
 */
import { chunkGrid, createWorldStore, POSITION_STEPS_PER_CELL, RELIEF_SUBDIVISIONS, reliefNeighbourBit, type PaletteStore, type ReliefOptions } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { loadArea, surfaceY } from './regions';
import { canonicalEqual, creaseDisagreements, deriveReliefSections, drawnSurface, RELIEF_SECTION_EDGE, watertight, worldMesh, type ReliefSection } from './relief-checks';
import { buildSliceWorld } from './slice-world';
import { townWorld } from './town';
import type { TestGrid } from './world-kit';
import { cavesWorld, hillyWorld } from './worlds';

const grid = chunkGrid(32);
const S = POSITION_STEPS_PER_CELL;
const SE = RELIEF_SECTION_EDGE;

interface Window {
  readonly name: string;
  readonly store: PaletteStore;
  /** The window's first section (world section coordinates); it holds 2 × 2 × 2. */
  readonly s0: readonly [number, number, number];
}

function loaded(g: TestGrid, x0: number, z0: number, x1: number, z1: number): PaletteStore {
  const s = createWorldStore(grid);
  loadArea(g, s, x0, z0, x1, z1);
  return s;
}

/** The first of two sections either side of the chunk face nearest `v` (cells). */
const straddle = (v: number): number => 2 * Math.round(v / grid.edge) - 1;

function windows(): Window[] {
  const slice = buildSliceWorld(256);
  const [sx, sy, sz] = slice.scene;
  const town = loaded(townWorld({ footprint: 128 }).grids[0]!, 0, 0, 128, 128);
  const hilly = loaded(hillyWorld({ footprint: 96 }).grids[0]!, -48, -48, 48, 48);
  const caves = loaded(cavesWorld({ footprint: 128 }).grids[0]!, -64, -64, 64, 64);
  const ground = (s: PaletteStore): number => surfaceY(s, 0, 0, 400, -128) ?? 0;
  return [
    { name: 'slice', store: slice.store, s0: [straddle(sx), straddle(sy), straddle(sz)] },
    // Houses' walls and floors on the ground, then their roofs (a wall under a roof, eaves, gables).
    { name: 'town ground', store: town, s0: [1, -1, 3] },
    { name: 'town roofs', store: town, s0: [1, 0, 3] },
    { name: 'hilly', store: hilly, s0: [-1, straddle(ground(hilly)), -1] },
    { name: 'caves', store: caves, s0: [-1, straddle(ground(caves)), -1] },
    { name: 'caves deep', store: caves, s0: [-1, straddle(ground(caves) - 48), -1] },
  ];
}

const inWindow = (w: Window, sx: number, sy: number, sz: number): boolean => [sx, sy, sz].every((s, a) => s >= w.s0[a]! && s < w.s0[a]! + 2);

/** The window's sections derived with relief n where `on` says (and inside the window), plain elsewhere, every unit told its plain neighbours. */
function deriveWindow(w: Window, n: number, on: (sx: number, sy: number, sz: number) => boolean = () => true): ReliefSection[] {
  const relief = (sx: number, sy: number, sz: number): boolean => inWindow(w, sx, sy, sz) && on(sx, sy, sz);
  const options = (sx: number, sy: number, sz: number): ReliefOptions | null => {
    if (!relief(sx, sy, sz)) return null;
    let plainNeighbours = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if ((dx !== 0 || dy !== 0 || dz !== 0) && !relief(sx + dx, sy + dy, sz + dz)) plainNeighbours |= reliefNeighbourBit(dx, dy, dz);
    }
    return { n, plainNeighbours };
  };
  const chunk = (s: number): number => Math.floor(s / 2);
  const out: ReliefSection[] = [];
  for (let cx = chunk(w.s0[0]); cx <= chunk(w.s0[0] + 1); cx++) for (let cy = chunk(w.s0[1]); cy <= chunk(w.s0[1] + 1); cy++) for (let cz = chunk(w.s0[2]); cz <= chunk(w.s0[2] + 1); cz++) {
    for (const r of deriveReliefSections(w.store, grid, cx, cy, cz, options)) if (inWindow(w, ...r.s)) out.push(r);
  }
  return out;
}

/** Positions are taken from two cells below the window's corner; the check's box keeps two cells inside its faces. */
const originOf = (w: Window): [number, number, number] => [0, 1, 2].map((a) => (w.s0[a]! * SE - 2) * S) as [number, number, number];
const BOX = { lo: [4 * S, 4 * S, 4 * S], hi: [2 * SE * S, 2 * SE * S, 2 * SE * S] };

function check(w: Window, sections: readonly ReliefSection[], label: string): { triangles: number; plainTriangles: number; free: number } {
  const origin = originOf(w);
  let triangles = 0;
  let plainTriangles = 0;
  let free = 0;
  for (const kind of ['ground', 'base'] as const) {
    const plain = worldMesh(sections.map((r) => ({ s: r.plain[kind], at: r.s })), origin);
    const relief = worldMesh(sections.map((r) => ({ s: drawnSurface(r.relief, kind), at: r.s })), origin);
    const t = watertight(plain, relief, BOX);
    expect(t.unexplained, `${label} ${kind}: ${t.firstUnexplained}`).toBe(0);
    if (plain.tris.length === 0) expect(relief.tris.length, `${label} ${kind}`).toBe(0);
    else expect(t.areaRatio, `${label} ${kind} area`).toBeCloseTo(1, 3);
    triangles += relief.tris.length / 3;
    plainTriangles += plain.tris.length / 3;
    free += creaseDisagreements(relief).free;
  }
  // Ground and bodies together: a point they share (where the ground meets a wall) moves for neither.
  const all = worldMesh(
    sections.flatMap((r) => [
      { s: drawnSurface(r.relief, 'ground'), at: r.s },
      { s: drawnSurface(r.relief, 'base'), at: r.s },
    ]),
    origin,
  );
  const d = creaseDisagreements(all);
  expect(d.count, `${label} crease weights: ${d.first}`).toBe(0);
  for (const r of sections) expect(canonicalEqual(r), `${label} section ${r.s.join(',')}: outputs with relief`).toBe(true);
  return { triangles, plainTriangles, free };
}

describe('the relief mesh on real worlds', () => {
  const ws = windows();

  it('is crack-free across section and chunk faces for n = 2, 4, 8, and changes no other output', { timeout: 240_000 }, () => {
    for (const w of ws) {
      let last = 0;
      for (const n of RELIEF_SUBDIVISIONS) {
        const r = check(w, deriveWindow(w, n), `${w.name} n ${n}`);
        expect(r.plainTriangles, `${w.name}: the window holds surface`).toBeGreaterThan(100);
        expect(r.triangles, `${w.name} n ${n}: denser with n`).toBeGreaterThan(Math.max(last, r.plainTriangles));
        expect(r.free, `${w.name} n ${n}: free vertices`).toBeGreaterThan(0);
        last = r.triangles;
      }
    }
  });

  it('meets plain neighbours on their own edges: relief and plain sections mixed are crack-free, the borders fixed', { timeout: 240_000 }, () => {
    // Five in eight sections relief, by a hash of their coordinates: relief beside relief and beside plain on every axis.
    const on = (sx: number, sy: number, sz: number): boolean => (((sx * 7 + sy * 3 + sz * 5) % 8) + 8) % 8 < 5;
    let onBorder = 0;
    for (const w of ws) {
      const sections = deriveWindow(w, 4, on);
      check(w, sections, `${w.name} mixed`);
      // Every body vertex on a face toward a plain section is fixed (so lies on the plain side's own edge).
      for (const r of sections) {
        const b = r.relief.relief?.base;
        if (b === undefined) continue;
        const view = new DataView(b.vertices.buffer, b.vertices.byteOffset, b.vertices.byteLength);
        for (let f = 0; f < 6; f++) {
          const step = [0, 0, 0];
          step[f >> 1] = (f & 1) === 1 ? 1 : -1;
          const nb = [r.s[0] + step[0]!, r.s[1] + step[1]!, r.s[2] + step[2]!] as const;
          if (inWindow(w, ...nb) && on(...nb)) continue;
          const plane = ((f & 1) === 1 ? SE + 1 : 1) * S;
          for (let v = 0; v < b.vertexCount; v++) {
            if (view.getUint16(v * 12 + 2 * (f >> 1), true) !== plane) continue;
            onBorder++;
            expect(b.crease[v], `${w.name} section ${r.s.join(',')} face ${f}`).toBe(0);
          }
        }
      }
    }
    expect(onBorder).toBeGreaterThan(0);
  });

  it('is deterministic: the same voxels give the same relief bytes', { timeout: 60_000 }, () => {
    const w = ws[2]!;
    const a = deriveWindow(w, 8);
    const b = deriveWindow(w, 8);
    let vertices = 0;
    a.forEach((r, i) => {
      expect(r.relief.relief === undefined).toBe(b[i]!.relief.relief === undefined);
      if (r.relief.relief === undefined) return;
      for (const k of ['ground', 'base'] as const) {
        const x = r.relief.relief[k];
        const y = b[i]!.relief.relief![k];
        expect(Buffer.from(x.vertices).equals(Buffer.from(y.vertices)), k).toBe(true);
        expect(Buffer.from(x.indices.buffer, x.indices.byteOffset, x.indices.byteLength).equals(Buffer.from(y.indices.buffer, y.indices.byteOffset, y.indices.byteLength)), k).toBe(true);
        expect(Buffer.from(x.crease).equals(Buffer.from(y.crease)), k).toBe(true);
        vertices += x.vertexCount;
      }
    });
    expect(vertices).toBeGreaterThan(0);
  });
});
