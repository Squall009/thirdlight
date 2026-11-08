/**
 * The relief mesh's cost (`node tools/voxel-bench/run.mjs relief …`): the
 * level-0 sections within a relief radius of a camera derive their relief
 * mesh (relief-mesh.ts) n lattice steps a cell, the sections round them
 * plain (their faces toward the ring kept whole), through the worker's
 * derive path in this thread. Per world, radius and n: the ring's sections
 * with surfaces, triangles and vertex bytes plain and relief (the ring, and
 * a section p50 / p95), the relief part's µs a section p50 / p95, the whole
 * derive's µs with and without it, and the ring's mesh bytes.
 *
 *   --worlds slice,town,hilly,caves   --radii 16,32,64 (metres)   --n 2,4,8
 *   --rounds N (default 2; µs from every round, sizes from the first)   --out DIR
 *
 * Writes relief.md and relief.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import { chunkGrid, createWorldStore, RELIEF_FREE, reliefBytes, reliefNeighbourBit, VOXEL_SIZE_M, type PaletteStore, type ReliefOptions } from '@thirdlight/voxel';
import type { TestGrid } from './world-kit';
import { benchDir } from './bench-dirs';
import { loadArea, surfaceY } from './regions';
import { deriveReliefSections, RELIEF_SECTION_EDGE, surfaceBytes } from './relief-checks';
import { buildSliceWorld } from './slice-world';
import { townWorld } from './town';
import { cavesWorld, hillyWorld } from './worlds';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const WORLDS = arg('worlds', 'slice,town,hilly,caves').split(',');
const RADII = arg('radii', '16,32,64').split(',').map(Number);
const NS = arg('n', '2,4,8').split(',').map(Number);
const ROUNDS = Number(arg('rounds', '2'));
const OUT = arg('out', benchDir('relief'));
const grid = chunkGrid(32);
const E = grid.edge;
const SE = RELIEF_SECTION_EDGE;
/** Cells loaded round the camera past the largest radius (the derive's apron and the ring's plain neighbours). */
const MARGIN = 64;

interface Scene {
  readonly name: string;
  readonly store: PaletteStore;
  /** The camera (cells). */
  readonly at: readonly [number, number, number];
}

function scene(name: string, half: number): Scene {
  const load = (g: TestGrid, cx: number, cz: number): PaletteStore => {
    const s = createWorldStore(grid);
    loadArea(g, s, cx - half, cz - half, cx + half, cz + half);
    return s;
  };
  const ground = (s: PaletteStore, x: number, z: number): number => (surfaceY(s, x, z, 400, -128) ?? 0) + 4;
  if (name === 'slice') {
    const w = buildSliceWorld(2 * half + 64);
    return { name, store: w.store, at: [w.scene[0], w.scene[1] + 4, w.scene[2]] };
  }
  if (name === 'town') {
    const s = load(townWorld({ footprint: 2 * half }).grids[0]!, half, half);
    return { name, store: s, at: [half, ground(s, half, half), half] };
  }
  const g = (name === 'hilly' ? hillyWorld({ footprint: 2 * half }) : cavesWorld({ footprint: 2 * half })).grids[0]!;
  const s = load(g, 0, 0);
  return { name, store: s, at: [0, ground(s, 0, 0), 0] };
}

const q = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const r1 = (v: number): number => Math.round(v * 10) / 10;

interface Row {
  world: string;
  radiusM: number;
  n: number;
  sections: number;
  plainTriangles: number;
  reliefTriangles: number;
  sectionTriangles: { plain: [number, number]; relief: [number, number] };
  plainBytes: number;
  reliefBytes: number;
  reliefVertexBytes: number;
  /** Relief vertices, and of them those free to move (crease weight {@link RELIEF_FREE}): what displacement can reach. */
  reliefVertices: number;
  freeVertices: number;
  sectionReliefBytes: [number, number];
  reliefUs: number[];
  deriveUs: number[];
  plainUs: number[];
}

function measure(sc: Scene, radiusM: number, n: number, round: number, row: Row | null): Row {
  const rc = radiusM / VOXEL_SIZE_M;
  const [ax, ay, az] = sc.at;
  /** A section is in the ring when its box comes within the radius of the camera. */
  const inRing = (sx: number, sy: number, sz: number): boolean => {
    const d = [sx, sy, sz].map((s, k) => {
      const lo = s * SE;
      const c = [ax, ay, az][k]!;
      return c < lo ? lo - c : c > lo + SE ? c - lo - SE : 0;
    });
    return Math.hypot(d[0]!, d[1]!, d[2]!) <= rc;
  };
  const options = (sx: number, sy: number, sz: number): ReliefOptions | null => {
    if (!inRing(sx, sy, sz)) return null;
    let plainNeighbours = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if ((dx !== 0 || dy !== 0 || dz !== 0) && !inRing(sx + dx, sy + dy, sz + dz)) plainNeighbours |= reliefNeighbourBit(dx, dy, dz);
    }
    return { n, plainNeighbours };
  };
  const out: Row = row ?? { world: sc.name, radiusM, n, sections: 0, plainTriangles: 0, reliefTriangles: 0, sectionTriangles: { plain: [0, 0], relief: [0, 0] }, plainBytes: 0, reliefBytes: 0, reliefVertexBytes: 0, reliefVertices: 0, freeVertices: 0, sectionReliefBytes: [0, 0], reliefUs: [], deriveUs: [], plainUs: [] };
  const per = { plain: [] as number[], relief: [] as number[], bytes: [] as number[] };
  const c0 = (v: number): number => Math.floor((v - rc) / E);
  const c1 = (v: number): number => Math.floor((v + rc) / E);
  for (let cx = c0(ax); cx <= c1(ax); cx++) for (let cz = c0(az); cz <= c1(az); cz++) for (let cy = c0(ay); cy <= c1(ay); cy++) {
    for (const r of deriveReliefSections(sc.store, grid, cx, cy, cz, options)) {
      const rel = r.relief.relief;
      if (r.reliefUs === undefined) continue;
      out.reliefUs.push(r.reliefUs);
      out.deriveUs.push(r.deriveUs);
      out.plainUs.push(r.plainUs);
      if (round > 0 || rel === undefined) continue;
      const p = r.plain;
      const pt = (p.ground.indices.length + p.base.indices.length) / 3;
      if (pt === 0) continue;
      const rt = (rel.ground.indices.length + rel.base.indices.length) / 3;
      out.sections++;
      out.plainTriangles += pt;
      out.reliefTriangles += rt;
      out.plainBytes += surfaceBytes(p.ground) + surfaceBytes(p.base);
      out.reliefBytes += reliefBytes(rel);
      for (const sf of [rel.ground, rel.base]) {
        out.reliefVertices += sf.vertexCount;
        for (let i = 0; i < sf.vertexCount; i++) if (sf.crease[i] === RELIEF_FREE) out.freeVertices++;
      }
      out.reliefVertexBytes += rel.ground.vertices.byteLength + rel.base.vertices.byteLength + rel.ground.crease.byteLength + rel.base.crease.byteLength;
      per.plain.push(pt);
      per.relief.push(rt);
      per.bytes.push(reliefBytes(rel));
    }
  }
  if (round === 0) {
    out.sectionTriangles = { plain: [q(per.plain, 0.5), q(per.plain, 0.95)], relief: [q(per.relief, 0.5), q(per.relief, 0.95)] };
    out.sectionReliefBytes = [q(per.bytes, 0.5), q(per.bytes, 0.95)];
  }
  return out;
}

mkdirSync(OUT, { recursive: true });
const half = Math.max(...RADII) / VOXEL_SIZE_M + MARGIN;
const rows: Row[] = [];
const started = new Date().toISOString();
for (const w of WORLDS) {
  const t0 = performance.now();
  const sc = scene(w, half);
  console.log(`${w}: loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s, camera ${sc.at.join(',')}`);
  for (const radiusM of RADII) for (const n of NS) {
    let row: Row | null = null;
    for (let round = 0; round < ROUNDS; round++) row = measure(sc, radiusM, n, round, row);
    rows.push(row!);
    const r = row!;
    console.log(`${w} r ${radiusM} m n ${n}: ${r.sections} sections, triangles ${r.plainTriangles} → ${r.reliefTriangles}, MB ${(r.plainBytes / 1e6).toFixed(2)} → ${(r.reliefBytes / 1e6).toFixed(2)}, relief µs p50/p95 ${r1(q(r.reliefUs, 0.5))}/${r1(q(r.reliefUs, 0.95))}`);
  }
}
const md = [
  `# Relief mesh cost (${started})`,
  '',
  `Node ${process.version}, ${cpus()[0]?.model ?? '?'}, load ${loadavg().map((l) => l.toFixed(2)).join(' ')}, uptime ${(uptime() / 86400).toFixed(1)} d; ${ROUNDS} rounds (µs over all of them); 16³ sections, world rules, no kit.`,
  '',
  '| world | radius m | n | sections | triangles plain → relief (×) | a section p50 / p95 plain → relief | ring MB plain → relief (vertex MB) | relief MB a section p50 / p95 | relief µs a section p50 / p95 | derive µs p50 / p95 plain → with relief | free vertices |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.world} | ${r.radiusM} | ${r.n} | ${r.sections} | ${r.plainTriangles} → ${r.reliefTriangles} (${(r.reliefTriangles / Math.max(1, r.plainTriangles)).toFixed(1)}) | ${r.sectionTriangles.plain.join(' / ')} → ${r.sectionTriangles.relief.join(' / ')} | ${(r.plainBytes / 1e6).toFixed(2)} → ${(r.reliefBytes / 1e6).toFixed(2)} (${(r.reliefVertexBytes / 1e6).toFixed(2)}) | ${(r.sectionReliefBytes[0] / 1e3).toFixed(1)} / ${(r.sectionReliefBytes[1] / 1e3).toFixed(1)} kB | ${r1(q(r.reliefUs, 0.5))} / ${r1(q(r.reliefUs, 0.95))} | ${r1(q(r.plainUs, 0.5))} / ${r1(q(r.plainUs, 0.95))} → ${r1(q(r.deriveUs, 0.5))} / ${r1(q(r.deriveUs, 0.95))} | ${((100 * r.freeVertices) / Math.max(1, r.reliefVertices)).toFixed(0)} % |`,
  ),
  '',
].join('\n');
writeFileSync(join(OUT, 'relief.md'), md);
writeFileSync(join(OUT, 'relief.json'), JSON.stringify(rows.map((r) => ({ ...r, reliefUs: [q(r.reliefUs, 0.5), q(r.reliefUs, 0.95)], deriveUs: [q(r.deriveUs, 0.5), q(r.deriveUs, 0.95)], plainUs: [q(r.plainUs, 0.5), q(r.plainUs, 0.95)] })), null, 1));
console.log(md);
