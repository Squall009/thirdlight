/**
 * The surface cache's voxel charts on real derived chunks (the town's houses
 * and streets, the caves' tunnels and overhangs): every drawn triangle's
 * surface found in a chart under its own face, each chart cell found back at
 * itself, keys only near the surface, the chart point on the drawn surface,
 * random surface points and the occupancy walk's hits there resolving to the
 * same texel, and a chunk's chart bytes at each of the cache's levels; the
 * live probes placed from the charts and cells.
 */
import { describe, expect, it } from 'vitest';
import { joinSections, sectionLocalOrigin, VOXEL_SIZE_M, walkRay, walkVoxels } from '@thirdlight/voxel';
import { DEFAULT_PROBE_SPACING } from '@thirdlight/project-model';
import { brickSide, locateVoxelFace, locateVoxelHit, placeProbeBricks, PROBE_PLACED_DROPPED, ProbeMarks, probeSolid, SURFACE_LEVELS, VOXEL_HIT_REACH, voxelCellOf, voxelChartBox, voxelChartBytes, voxelChartFrame, voxelChartPoint, voxelChunkCharts, voxelFaceKey, voxelSurfaceGeometry, voxelTileMarks, type VoxelChunkCharts } from '@thirdlight/three-adapter';

import { walkWorld, WALK_GRID, type WalkWorld } from './walk-world';
import { cavesWorld, townWorld } from './worlds';

const SECTION = 16;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Chunk {
  readonly cell0: [number, number, number];
  readonly positions: Float32Array;
  readonly indices: ArrayLike<number>;
  readonly made: VoxelChunkCharts;
}

/** Every chunk of the box with something drawn: its joined surface as the page draws it, and its charts. */
function chunksOf(w: WalkWorld): Chunk[] {
  const out: Chunk[] = [];
  const e = WALK_GRID.edge;
  for (let cx = w.min[0]; cx <= w.max[0]; cx++) for (let cy = w.min[1]; cy <= w.max[1]; cy++) for (let cz = w.min[2]; cz <= w.max[2]; cz++) {
    const parts = Array.from({ length: 8 }, (_, id) => {
      const [lx, ly, lz] = sectionLocalOrigin(e, SECTION, id);
      return w.sections.get(`${cx * 2 + lx / SECTION},${cy * 2 + ly / SECTION},${cz * 2 + lz / SECTION}`) ?? null;
    });
    if (parts.every((p) => p === null)) continue;
    const j = joinSections(e, SECTION, parts);
    const geo = voxelSurfaceGeometry([j.ground, j.base]);
    if (geo === null) continue;
    const positions = geo.getAttribute('position').array as Float32Array;
    const indices = geo.index!.array;
    const cell0: [number, number, number] = [cx * e, cy * e, cz * e];
    out.push({ cell0, positions, indices, made: voxelChunkCharts(positions, indices, cell0, e, (x, y, z) => w.solidAt(x, y, z)) });
  }
  return out;
}

/** A random point on each of `n` random triangles of a chunk (metres, world), with its triangle's face and normal. */
function surfacePoints(c: Chunk, r: () => number, n: number, solidAt: (x: number, y: number, z: number) => boolean, hidden?: { n: number }): { p: number[]; face: number; normal: number[] }[] {
  const out: { p: number[]; face: number; normal: number[] }[] = [];
  const tris = Math.floor(c.indices.length / 3);
  for (let k = 0; k < n && tris > 0; k++) {
    const t = Math.floor(r() * tris);
    const v = [0, 1, 2].map((i) => [0, 1, 2].map((a) => c.cell0[a]! * VOXEL_SIZE_M + c.positions[c.indices[t * 3 + i]! * 3 + a]!));
    const e1 = [0, 1, 2].map((a) => v[1]![a]! - v[0]![a]!);
    const e2 = [0, 1, 2].map((a) => v[2]![a]! - v[0]![a]!);
    const nn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const len = Math.hypot(nn[0]!, nn[1]!, nn[2]!);
    if (!(len > 1e-9)) continue;
    const normal = nn.map((x) => x / len);
    let a = r();
    let b = r();
    if (a + b > 1) {
      a = 1 - a;
      b = 1 - b;
    }
    const p = [0, 1, 2].map((i) => v[0]![i]! + e1[i]! * a + e2[i]! * b);
    const an = normal.map(Math.abs);
    const axis = an[0]! >= an[1]! && an[0]! >= an[2]! ? 0 : an[1]! >= an[2]! ? 1 : 2;
    // Hidden: the cell half a cell in front of it along its main axis is a body (the ground under a floor).
    const front = p.map((v) => Math.floor(v / VOXEL_SIZE_M));
    front[axis] = Math.floor(p[axis]! / VOXEL_SIZE_M + (normal[axis]! < 0 ? -0.5 : 0.5));
    if (solidAt(front[0]!, front[1]!, front[2]!)) {
      if (hidden !== undefined) hidden.n++;
      continue;
    }
    out.push({ p, face: axis * 2 + (normal[axis]! < 0 ? 1 : 0), normal });
  }
  return out;
}

/** Where a world point on face `face` is charted, over the chunks (its own first, then the others: a key may be another chunk's). */
function locate(chunks: readonly Chunk[], p: readonly number[], face: number): { c: Chunk; chart: number; u: number; v: number } | null {
  const { cell, fu, fv } = voxelCellOf(p, face);
  const e = WALK_GRID.edge;
  const own = chunks.find((c) => [0, 1, 2].every((a) => cell[a]! >= c.cell0[a]! && cell[a]! < c.cell0[a]! + e));
  for (const c of own !== undefined ? [own, ...chunks.filter((k) => k !== own)] : chunks) {
    const at = locateVoxelFace(c.made, cell, face, fu, fv);
    if (at !== null) return { c, ...at };
  }
  return null;
}

const town = walkWorld(townWorld({ footprint: 512 }), [-2, -1, -2], [1, 0, 1], [8, 0, 8]);
const caves = walkWorld(cavesWorld({ footprint: 512 }), [-1, -2, -1], [1, 1, 1], [6, 0, 6]);

describe.each([
  ['town', town],
  ['caves', caves],
])('voxel charts: %s', (name, w) => {
  const chunks = chunksOf(w);

  it('covers every drawn triangle under its own face, on the drawn surface', () => {
    const r = rng(name === 'town' ? 11 : 12);
    let n = 0;
    let found = 0;
    let far = 0;
    const out = new Float32Array(6);
    const hidden = { n: 0 };
    for (const c of chunks) {
      for (const s of surfacePoints(c, r, 120, (x, y, z) => w.solidAt(x, y, z), hidden)) {
        n++;
        const at = locate(chunks, s.p, s.face);
        if (at === null) continue;
        found++;
        voxelChartPoint(at.c.made, at.chart, at.u, at.v, out, 0);
        const d = Math.hypot(out[0]! - s.p[0]!, out[1]! - s.p[1]!, out[2]! - s.p[2]!);
        if (d > 0.75) far++;
      }
    }
    console.log(`${name}: ${n} points on drawn triangles, ${found} charted (${((found / n) * 100).toFixed(2)} %); ${hidden.n} more on hidden ones (charted nowhere)`);
    expect(n).toBeGreaterThan(2000);
    // Coverage of the drawn surface by its charts (a sliver of a triangle across a crease may miss).
    expect(found / n).toBeGreaterThan(0.995);
    expect(far / found).toBeLessThan(0.01);
  });

  it('finds each chart cell back at itself, and keys only cells near the surface', () => {
    let cells = 0;
    let back = 0;
    let deep = 0;
    const out = new Float32Array(6);
    for (const c of chunks) {
      const m = c.made;
      for (let k = 0; k < m.charts.length; k++) {
        const f = voxelChartFrame(m, k);
        for (let j = 0; j < f.hc; j++) for (let i = 0; i < f.wc; i++) {
          cells++;
          voxelChartPoint(m, k, (i + 0.5) * VOXEL_SIZE_M, (j + 0.5) * VOXEL_SIZE_M, out, 0);
          const { cell, fu, fv } = voxelCellOf([out[0]!, out[1]!, out[2]!], f.face);
          const at = locateVoxelFace(m, cell, f.face, fu, fv);
          if (at !== null && at.chart === k && Math.floor(at.u / VOXEL_SIZE_M) === i && Math.floor(at.v / VOXEL_SIZE_M) === j) back++;
        }
      }
      // A keyed cell lies within two cells of an open one (a cell deep inside a body has no face of its own).
      const e = c.made.edge;
      for (let ly = 0; ly < e; ly += 3) for (let lz = 0; lz < e; lz += 3) for (let lx = 0; lx < e; lx += 3) {
        const x = c.cell0[0] + lx, y = c.cell0[1] + ly, z = c.cell0[2] + lz;
        let open = false;
        for (let dy = -2; dy <= 2 && !open; dy++) for (let dz = -2; dz <= 2 && !open; dz++) for (let dx = -2; dx <= 2 && !open; dx++) open = !w.solidAt(x + dx, y + dy, z + dz);
        if (open) continue;
        for (let face = 0; face < 6; face++) {
          const key = voxelFaceKey(c.cell0, e, x, y, z, face);
          if (key >= 0 && locateVoxelFace(c.made, [x, y, z], face, 0.5, 0.5) !== null) deep++;
        }
      }
    }
    expect(cells).toBeGreaterThan(1000);
    // Two surfaces of one face within two cells of each other share keys: the first charted keeps them.
    expect(back / cells).toBeGreaterThan(0.999);
    expect(deep).toBe(0);
  });

  it('resolves the walk\'s hits to a texel on the surface there', () => {
    const r = rng(name === 'town' ? 21 : 22);
    const src = w.source();
    const e = WALK_GRID.edge;
    const byChunk = new Map(chunks.map((c) => [c.cell0.map((v) => v / e).join(','), c.made]));
    const chartsAt = (x: number, y: number, z: number): VoxelChunkCharts | null => byChunk.get([x, y, z].map((v) => Math.floor(v / e)).join(',')) ?? null;
    let rays = 0;
    let hits = 0;
    let resolved = 0;
    let same = 0;
    const out = new Float32Array(6);
    for (const c of chunks) {
      for (const s of surfacePoints(c, r, 60, (x, y, z) => w.solidAt(x, y, z))) {
        const want = locate(chunks, s.p, s.face);
        if (want === null) continue;
        // From 1 m out along the surface's normal, tilted at random, toward the point.
        const o = [0, 1, 2].map((a) => s.p[a]! + s.normal[a]! * 1 + (r() - 0.5) * 0.6);
        const d = [0, 1, 2].map((a) => s.p[a]! - o[a]!);
        const ray = walkRay(o, d);
        if (ray === null) continue;
        rays++;
        const hit = walkVoxels(src, ray, 3, { stop: 'light', far: false }).hit;
        if (hit === null || hit.normal.every((v) => v === 0)) continue;
        hits++;
        const axis = hit.normal.findIndex((v) => v !== 0);
        const face = axis * 2 + (hit.normal[axis]! < 0 ? 1 : 0);
        const len = Math.hypot(d[0]!, d[1]!, d[2]!);
        const hp = [0, 1, 2].map((a) => o[a]! + (d[a]! / len) * hit.t);
        const got = locateVoxelHit(chartsAt, hp, hit.cell, face);
        if (got === null) continue;
        voxelChartPoint(got.made, got.chart, got.u, got.v, out, 0);
        expect(Math.hypot(out[0]! - hp[0]!, out[1]! - hp[1]!, out[2]! - hp[2]!)).toBeLessThanOrEqual(VOXEL_HIT_REACH + 1e-6);
        resolved++;
        if (got.made === want.c.made && got.chart === want.chart && Math.abs(got.u - want.u) <= VOXEL_SIZE_M * 1.01 && Math.abs(got.v - want.v) <= VOXEL_SIZE_M * 1.01) same++;
      }
    }
    console.log(`${name}: ${rays} rays, ${hits} hits, ${resolved} resolved within ${VOXEL_HIT_REACH} m (${((resolved / hits) * 100).toFixed(1)} %), ${same} to the aimed point's own texel (${((same / hits) * 100).toFixed(1)} %)`);
    expect(rays).toBeGreaterThan(1000);
    expect(hits).toBeGreaterThan(rays * 0.8);
    expect(resolved / hits).toBeGreaterThan(0.97);
  });

  it('says what a chunk takes at each level, and charts a box round its surface', () => {
    const bytes = chunks.map((c) => voxelChartBytes(c.made, SURFACE_LEVELS));
    const per = Array.from({ length: SURFACE_LEVELS }, (_, l) => bytes.reduce((s, b) => s + b[l]!, 0) / bytes.length);
    console.log(`${name}: ${chunks.length} chunks, ${chunks.reduce((s, c) => s + c.made.charts.length, 0)} charts, ${chunks.reduce((s, c) => s + c.made.cells, 0)} chart cells; KiB a chunk by level: ${per.map((b) => (b / 1024).toFixed(1)).join(' / ')}`);
    for (let l = 1; l < SURFACE_LEVELS; l++) expect(per[l]!).toBeLessThanOrEqual(per[l - 1]!);
    expect(per[0]!).toBeGreaterThan(per[3]! * 4);
    const out = new Float32Array(6);
    for (const c of chunks.slice(0, 8)) for (let k = 0; k < c.made.charts.length; k++) {
      const f = voxelChartFrame(c.made, k);
      const box = voxelChartBox(c.made, k, 0, f.wc, 0, f.hc);
      voxelChartPoint(c.made, k, f.wc * VOXEL_SIZE_M * 0.5, f.hc * VOXEL_SIZE_M * 0.5, out, 0);
      for (let a = 0; a < 3; a++) {
        expect(out[a]!).toBeGreaterThanOrEqual(box.min[a]! - 1e-4);
        expect(out[a]!).toBeLessThanOrEqual(box.max[a]! + 1e-4);
      }
      if (box.plane !== null) expect(Math.abs(box.plane[0] * out[0]! + box.plane[1] * out[1]! + box.plane[2] * out[2]! - box.plane[3])).toBeLessThan(1e-3);
    }
  });
});

/**
 * The live probes' placement from the voxel charts (the marks) and cells (what is solid): bricks only near the
 * charted surfaces, no lit probe inside a body, probes under roofs and in the caves' tunnels (enclosed air) as well
 * as in the open.
 */
describe.each([
  ['town', town],
  ['caves', caves],
])('probes over voxel charts: %s', (name, w) => {
  it('places bricks near the surfaces, drops the probes inside bodies, keeps those in rooms and tunnels', () => {
    const chunks = chunksOf(w);
    const marks = new ProbeMarks(DEFAULT_PROBE_SPACING);
    for (const c of chunks) voxelTileMarks(c.made, marks);
    const solid = (p: readonly number[]): boolean => w.solidAt(Math.floor(p[0]! / VOXEL_SIZE_M), Math.floor(p[1]! / VOXEL_SIZE_M), Math.floor(p[2]! / VOXEL_SIZE_M));
    const placed = placeProbeBricks(marks.finish(), probeSolid({ voxels: (x, y, z) => w.solidAt(x, y, z) }, brickSide(DEFAULT_PROBE_SPACING, 0)));
    const levels = [0, 0, 0];
    for (const b of placed.bricks) levels[b.level]!++;
    let lit = 0;
    let dropped = 0;
    let insideLit = 0;
    let roofed = 0;
    const src = w.source();
    for (let i = 0; i < placed.keys.length; i++) {
      const o = [placed.origins[i * 3]!, placed.origins[i * 3 + 1]!, placed.origins[i * 3 + 2]!];
      if (placed.states[i] === PROBE_PLACED_DROPPED) {
        dropped++;
        continue;
      }
      lit++;
      if (solid(o)) insideLit++;
      // Under something solid within 8 m straight up, and walled within 8 m on all four sides: a room's or a tunnel's air.
      const shut = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].every((d) => {
        const r = walkRay([o[0]! + 0.0013, o[1]! + 0.0017, o[2]! + 0.0011], d);
        return r !== null && walkVoxels(src, r, 8, { stop: 'light', far: false }).hit !== null;
      });
      if (shut) roofed++;
    }
    // Every brick touches a chart's box (grown by a brick side: a coarse brick holds its finer ones' surfaces).
    const boxes = chunks.flatMap((c) => Array.from({ length: c.made.charts.length }, (_, k) => {
      const f = voxelChartFrame(c.made, k);
      return voxelChartBox(c.made, k, 0, f.wc, 0, f.hc);
    }));
    const near = placed.bricks.filter((b) => boxes.some((x) => [0, 1, 2].every((a) => x.max[a]! >= b.min[a]! - b.side && x.min[a]! <= b.min[a]! + 2 * b.side))).length;
    console.log(`${name}: probe bricks by level ${levels.join(' / ')}; probes ${placed.keys.length}: lit ${lit}, dropped inside bodies ${dropped}, lit with walls and a roof within 8 m ${roofed}; bricks near a chart ${near} of ${placed.bricks.length}`);
    expect(levels[0]!).toBeGreaterThan(20);
    expect(levels[1]!).toBeGreaterThan(5);
    expect(lit).toBeGreaterThan(500);
    expect(dropped).toBeGreaterThan(100);
    expect(insideLit).toBe(0);
    expect(roofed).toBeGreaterThan(20);
    expect(near).toBe(placed.bricks.length);
  });
});
