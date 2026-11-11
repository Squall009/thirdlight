/**
 * Derived-data costs on the test worlds (the chosen store, 32³): what the
 * assembly derive produces per chunk, in bytes per consumer and µs per
 * chunk, against the representations it was chosen over; the voxel mips'
 * bytes and cost per level; the prop light channel's stamping cost.
 *
 *   node tools/voxel-bench/run.mjs derive [--worlds town,plain,hilly,caves,vertical] [--out DIR]
 *
 * Every chunk of a window (the whole world for the 256 m worlds, a 512 m
 * square of the hilly world, a 128 m square of the 2 km tall world) whose
 * neighbourhood holds anything other than air is derived on this thread
 * with the placeholder rules (R = 2, apron 3); chunks on the window's outer
 * ring are left out (their aprons would read unloaded air). Writes
 * derive.md/derive.json to --out (default ~/.cache/thirdlight-voxel-bench/
 * derive).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { benchDir } from './bench-dirs';
import { performance } from 'node:perf_hooks';
import {
  BRICK_EDGE,
  buildApron,
  chunkGrid,
  chunkOfKey,
  createDenseChunk,
  createWorldStore,
  derivedBytes,
  derivedPartBytes,
  deriveSectionCollisionsWithApron,
  deriveSectionsWithApron,
  deriveWithApron,
  downsampleMip,
  jobRadius,
  lightCoverage,
  mipChildren,
  mipNodeKey,
  PLACEHOLDER_RULES,
  WORLD_RULES,
  propCoverageChunk,
  shaderGridEntries,
  shaderSolidEntry,
  SURFACE_VERTEX_BYTES,
  type DenseChunk,
  type DeriveTimes,
  type MipNode,
  type PaletteStore,
  type PropShape,
} from '@thirdlight/voxel';
import { loadArea, zstdCompress } from './regions';
import { chunkRange, type TestGrid, type TestWorld } from './world-kit';
import { cavesWorld, hillyWorld, plainWorld, townWorld, verticalWorld } from './worlds';

const grid = chunkGrid(32);
const E = grid.edge;
const CELLS = E * E * E;
const R = jobRadius(PLACEHOLDER_RULES);
/** Every 16³ section of a 32³ chunk (the streaming's derive units). */
const SECTION_IDS = Array.from({ length: 8 }, (_, i) => i);

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
}

function log(s: string): void {
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

interface Window {
  world: TestWorld;
  /** Cell square [x0, x1) × [z0, z1) of the world grid (every grid of the world is derived whole when `allGrids`). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  allGrids: boolean;
}

interface ChunkRow {
  applyUs: number;
  /** The streaming's own path (the world rules, 16³ sections): the full derive, and the collision alone, µs a chunk. */
  sectionsFullUs: number;
  sectionsCollisionUs: number;
  apronUs: number;
  evaluateUs: number;
  meshUs: number;
  consumersUs: number;
  bytes: number;
  parts: ReturnType<typeof derivedPartBytes>;
  /** Alternative representations' bytes (for the pick). */
  lightDense: number;
  lightBricks: number;
  collisionPlane: number;
  navPlane: number;
  occBitmaskOnly: number;
  vertsGround: number;
  vertsBase: number;
  tris: number;
  instances: number;
  boxes: number;
  fullBoxes: number;
  standable: number;
  lightPartial: number;
  counts: { wall: number; ground: number; groundPartial: number; beam: number; rail: number; liquid: number };
  stored: boolean;
  /** Whether the chunk draws a surface (and so needs its shader data on the GPU). */
  drawn: boolean;
  /** A drawn chunk whose grid holds two or more solid entries (one solid entry blends to itself: no grid needed). */
  gridNeeded: boolean;
  /** Mixed 4³ bricks of the shader grid (two or more entries, air counted): the sparse alternative's size. */
  shaderMixedBricks: number;
}

/** Mixed 4³ bricks of a side³ shader grid (bricks clipped at the far edges). */
function mixedShaderBricks(cells: Uint16Array, side: number): number {
  let mixed = 0;
  for (let bx = 0; bx < side; bx += 4) for (let bz = 0; bz < side; bz += 4) for (let by = 0; by < side; by += 4) {
    let first = -1;
    let m = false;
    for (let x = bx; x < Math.min(side, bx + 4) && !m; x++) for (let z = bz; z < Math.min(side, bz + 4) && !m; z++) for (let y = by; y < Math.min(side, by + 4) && !m; y++) {
      const e = cells[(x * side + z) * side + y]!;
      if (first < 0) first = e;
      else if (e !== first) m = true;
    }
    if (m) mixed++;
  }
  return mixed;
}

let gridScratch = new Uint16Array(0);

/** Light coverage bytes if stored per 4³ brick: a byte per brick, 64 more for a brick that is not one value. */
function brickLightBytes(cov: Uint8Array): number {
  const nb = E / BRICK_EDGE;
  let bytes = nb * nb * nb;
  for (let bx = 0; bx < nb; bx++) for (let bz = 0; bz < nb; bz++) for (let by = 0; by < nb; by++) {
    let first = -1;
    let mixed = false;
    for (let x = 0; x < 4 && !mixed; x++) for (let z = 0; z < 4 && !mixed; z++) for (let y = 0; y < 4 && !mixed; y++) {
      const c = cov[((bx * 4 + x) * E + (bz * 4 + z)) * E + (by * 4 + y)]!;
      if (first < 0) first = c;
      else if (c !== first) mixed = true;
    }
    if (mixed) bytes += 64;
  }
  return bytes;
}

function deriveGrid(g: TestGrid, w: Window, rows: ChunkRow[]): void {
  const store = createWorldStore(grid);
  const all = w.allGrids;
  const x0 = all ? g.bounds.min[0] : w.x0;
  const x1 = all ? g.bounds.max[0] : w.x1;
  const z0 = all ? g.bounds.min[2] : w.z0;
  const z1 = all ? g.bounds.max[2] : w.z1;
  loadArea(g, store, x0 - E, z0 - E, x1 + E, z1 + E);
  const [cx0, cx1] = chunkRange(grid, x0, x1);
  const [cz0, cz1] = chunkRange(grid, z0, z1);
  const [cy0, cy1] = chunkRange(grid, g.bounds.min[1], g.bounds.max[1]);
  // Present chunks and their neighbours: everything whose neighbourhood can hold more than air.
  const targets = new Set<string>();
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const x = c.cx + dx;
      const y = c.cy + dy;
      const z = c.cz + dz;
      const inner = all ? x >= cx0 - 1 && x <= cx1 && z >= cz0 - 1 && z <= cz1 : x > cx0 && x < cx1 - 1 && z > cz0 && z < cz1 - 1;
      if (inner && y >= cy0 - 1 && y <= cy1) targets.add(`${x},${y},${z}`);
    }
  }
  const t: DeriveTimes = { evaluateUs: 0, consumersUs: 0, meshUs: 0 };
  for (const key of [...targets].sort()) {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    const a0 = performance.now();
    const apron = buildApron(store, x, y, z, R);
    const a1 = performance.now();
    t.evaluateUs = 0;
    t.consumersUs = 0;
    t.meshUs = 0;
    const d = deriveWithApron(grid, PLACEHOLDER_RULES, apron, (out) => store.exportChunk(x, y, z, out), t);
    const a2 = performance.now();
    const wr = buildApron(store, x, y, z, jobRadius(WORLD_RULES));
    const s0 = performance.now();
    deriveSectionsWithApron(grid, WORLD_RULES, wr, (out) => store.exportChunk(x, y, z, out), 16, SECTION_IDS);
    const s1 = performance.now();
    deriveSectionCollisionsWithApron(grid, WORLD_RULES, wr, (out) => store.exportChunk(x, y, z, out), 16, SECTION_IDS);
    const s2 = performance.now();
    const cov = lightCoverage(grid, d.light, null);
    let anyCov = false;
    for (let i = 0; i < CELLS && !anyCov; i++) anyCov = cov[i] !== 0;
    const solidish = d.counts.wall + d.counts.beam + d.counts.rail + d.counts.ground;
    const side = d.shader.side;
    if (gridScratch.length < side ** 3) gridScratch = new Uint16Array(side ** 3);
    const drawn = d.ground.vertexCount + d.base.vertexCount + d.instances.count > 0;
    rows.push({
      applyUs: (a2 - a1) * 1000,
      sectionsFullUs: (s1 - s0) * 1000,
      sectionsCollisionUs: (s2 - s1) * 1000,
      apronUs: (a1 - a0) * 1000,
      evaluateUs: t.evaluateUs,
      meshUs: t.meshUs,
      consumersUs: t.consumersUs,
      bytes: derivedBytes(d),
      parts: derivedPartBytes(d),
      lightDense: d.light.uniform >= 0 ? 1 : CELLS,
      lightBricks: d.light.uniform >= 0 ? 1 : brickLightBytes(cov),
      collisionPlane: d.counts.wall + d.counts.beam + d.counts.rail === 0 ? 0 : CELLS,
      navPlane: d.nav.blocking === 2 || d.nav.standable.length > 0 ? CELLS : 1,
      occBitmaskOnly: solidish === 0 ? 0 : CELLS / 8,
      vertsGround: d.ground.vertexCount,
      vertsBase: d.base.vertexCount,
      tris: (d.ground.indices.length + d.base.indices.length) / 3,
      instances: d.instances.count,
      boxes: d.collision.boxes.length / 6,
      fullBoxes: d.collision.fullBoxes,
      standable: d.nav.standable.length,
      lightPartial: d.light.partialCells.length,
      counts: { ...d.counts },
      stored: store.chunkForm(x, y, z) === 'stored',
      drawn,
      gridNeeded: drawn && shaderSolidEntry(d.shader) < 0,
      shaderMixedBricks: drawn && shaderSolidEntry(d.shader) < 0 ? mixedShaderBricks(shaderGridEntries(d.shader, gridScratch), side) : 0,
    });
  }
}

interface MipLevel {
  level: number;
  nodes: number;
  stored: number;
  uniform: number;
  zstdBytes: number;
  downUs: number[];
}

/** Builds mip levels 1 … maxLevel over a store's chunks: node counts, codec + zstd bytes, downsample µs. */
function mipLevels(store: PaletteStore, maxLevel: number): MipLevel[] {
  const out: MipLevel[] = [];
  let below = new Map<string, DenseChunk | null>();
  const keyOf = (n: MipNode): string => mipNodeKey(n);
  const c = { cx: 0, cy: 0, cz: 0 };
  const chunkNodes = new Set<string>();
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    chunkNodes.add(`${c.cx},${c.cy},${c.cz}`);
  }
  let present: Array<[number, number, number]> = [...chunkNodes].map((s) => s.split(',').map(Number) as [number, number, number]);
  for (let level = 1; level <= maxLevel; level++) {
    const parents = new Map<string, MipNode>();
    for (const [x, y, z] of present) {
      const n: MipNode = { level, nx: x >> 1, ny: y >> 1, nz: z >> 1 };
      parents.set(keyOf(n), n);
    }
    const nodeStore = createWorldStore(grid, 'mip');
    const next = new Map<string, DenseChunk | null>();
    const row: MipLevel = { level, nodes: 0, stored: 0, uniform: 0, zstdBytes: 0, downUs: [] };
    for (const n of parents.values()) {
      const kids = mipChildren(n).map((k): DenseChunk | null => {
        if (level === 1) {
          const d = createDenseChunk(grid);
          return store.exportChunk(k.nx, k.ny, k.nz, d) ? d : null;
        }
        return below.get(keyOf(k)) ?? null;
      });
      const outChunk = createDenseChunk(grid);
      const t0 = performance.now();
      const any = downsampleMip(grid, kids, outChunk);
      row.downUs.push((performance.now() - t0) * 1000);
      next.set(keyOf(n), any ? outChunk : null);
      if (!any) continue;
      row.nodes++;
      nodeStore.importChunk(n.nx, n.ny, n.nz, outChunk);
      const form = nodeStore.chunkForm(n.nx, n.ny, n.nz);
      if (form === 'uniform') {
        row.uniform++;
        row.zstdBytes += 13;
      } else if (form === 'stored') {
        row.stored++;
        row.zstdBytes += zstdCompress(nodeStore.encodeChunk(n.nx, n.ny, n.nz)!).length;
      }
      nodeStore.dropChunk(n.nx, n.ny, n.nz);
    }
    out.push(row);
    below = next;
    present = [...parents.values()].filter((n) => next.get(keyOf(n)) !== null).map((n) => [n.nx, n.ny, n.nz]);
  }
  return out;
}

/** Stamping cost of the prop light channel: µs per prop per chunk it overlaps, for a canopy-sized sphere and a turned crate. */
function propBench(): { sphereUs: number; crateUs: number; sphereCells: number; crateCells: number } {
  const sphere: PropShape = { inside: (x, y, z) => x * x + y * y + z * z <= 9, min: [-3, -3, -3], max: [3, 3, 3], position: [8.2, 6.1, 8.3], yaw: [1, 0], scale: 1 };
  const crate: PropShape = { inside: (x, y, z) => Math.abs(x) <= 0.6 && Math.abs(y) <= 0.5 && Math.abs(z) <= 0.4, min: [-0.6, -0.5, -0.4], max: [0.6, 0.5, 0.4], position: [5.1, 1, 5.3], yaw: [Math.cos(0.52), Math.sin(0.52)], scale: 1 };
  const time = (p: PropShape): { us: number; cells: number } => {
    let cells = 0;
    const t0 = performance.now();
    const n = 200;
    for (let i = 0; i < n; i++) {
      const out = propCoverageChunk(grid, 0, 0, 0, [p], 0.5);
      if (i === 0 && out !== null) for (const v of out) if (v !== 0) cells++;
    }
    return { us: ((performance.now() - t0) * 1000) / n, cells };
  };
  const s = time(sphere);
  const c = time(crate);
  return { sphereUs: s.us, crateUs: c.us, sphereCells: s.cells, crateCells: c.cells };
}

function summarize(name: string, rows: ChunkRow[]): Record<string, unknown> {
  const nonEmpty = rows.filter((r) => r.bytes > 0);
  const f = (sel: (r: ChunkRow) => number): { mean: number; p50: number; p95: number; max: number } => {
    const xs = rows.map(sel);
    return { mean: mean(xs), p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(0, ...xs) };
  };
  const cells = rows.length * CELLS;
  const totals = { wall: 0, ground: 0, groundPartial: 0, beam: 0, rail: 0, liquid: 0 };
  for (const r of rows) for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += r.counts[k];
  const solidCells = totals.wall + totals.ground + totals.beam + totals.rail;
  return {
    world: name,
    chunks: rows.length,
    storedChunks: rows.filter((r) => r.stored).length,
    deriveUs: f((r) => r.applyUs),
    sectionsFullUs: f((r) => r.sectionsFullUs),
    sectionsCollisionUs: f((r) => r.sectionsCollisionUs),
    apronUs: f((r) => r.apronUs),
    evaluateUs: f((r) => r.evaluateUs),
    meshUs: f((r) => r.meshUs),
    consumersUs: f((r) => r.consumersUs),
    bytes: f((r) => r.bytes),
    totalMB: sum(rows.map((r) => r.bytes)) / 1e6,
    nonEmpty: nonEmpty.length,
    parts: Object.fromEntries((['occupancy', 'light', 'collision', 'nav', 'ground', 'base', 'instances', 'shader'] as const).map((k) => [k, mean(rows.map((r) => r.parts[k]))])),
    surface: (() => {
      const drawn = rows.filter((r) => r.drawn);
      const grids = rows.filter((r) => r.gridNeeded);
      const side = E + 2;
      const verts = sum(rows.map((r) => r.vertsGround + r.vertsBase));
      return {
        vertexBytes: SURFACE_VERTEX_BYTES,
        verticesPerDrawnChunk: drawn.length === 0 ? 0 : verts / drawn.length,
        vertexBytesPerDrawnChunk: drawn.length === 0 ? 0 : (verts * SURFACE_VERTEX_BYTES) / drawn.length,
        drawn: drawn.length,
        gridNeeded: grids.length,
        shaderPackedMean: mean(rows.map((r) => r.parts.shader)),
        shaderPackedDrawnMean: mean(drawn.map((r) => r.parts.shader)),
        gpuDenseBytesPerGrid: side ** 3 * 2,
        gpuDenseMBAll: (grids.length * side ** 3 * 2) / 1e6,
        sparseBricksMean: mean(grids.map((r) => r.shaderMixedBricks)),
        sparseBytesPerGrid: mean(grids.map((r) => Math.ceil(side / 4) ** 3 * 2 + r.shaderMixedBricks * 128)),
      };
    })(),
    alternatives: {
      lightMaskPartials: mean(rows.map((r) => r.parts.light)),
      lightDense: mean(rows.map((r) => r.lightDense)),
      lightBricks: mean(rows.map((r) => r.lightBricks)),
      collisionBoxes: mean(rows.map((r) => r.parts.collision)),
      collisionPlane: mean(rows.map((r) => r.collisionPlane)),
      navOurs: mean(rows.map((r) => r.parts.nav)),
      navPlane: mean(rows.map((r) => r.navPlane)),
      occOurs: mean(rows.map((r) => r.parts.occupancy)),
      occBitmaskOnly: mean(rows.map((r) => r.occBitmaskOnly)),
    },
    mesh: { vertsGround: f((r) => r.vertsGround), vertsBase: f((r) => r.vertsBase), tris: f((r) => r.tris), instances: sum(rows.map((r) => r.instances)), boxes: f((r) => r.boxes), fullBoxes: sum(rows.map((r) => r.fullBoxes)), standable: f((r) => r.standable) },
    classes: totals,
    partialShare: {
      ofCells: (totals.beam + totals.rail + totals.groundPartial) / cells,
      ofSolid: solidCells === 0 ? 0 : (totals.beam + totals.rail + totals.groundPartial) / solidCells,
      beamRailOfConstruction: totals.wall + totals.beam + totals.rail === 0 ? 0 : (totals.beam + totals.rail) / (totals.wall + totals.beam + totals.rail),
      lightPartialCells: sum(rows.map((r) => r.lightPartial)),
    },
  };
}

function main(): void {
  const names = arg('--worlds', 'town,plain,hilly,caves,vertical').split(',');
  const outDir = arg('--out', benchDir('derive'));
  mkdirSync(outDir, { recursive: true });
  const started = new Date().toISOString();
  const windows: Window[] = [];
  for (const n of names) {
    if (n === 'town') windows.push({ world: townWorld(), x0: 0, z0: 0, x1: 512, z1: 512, allGrids: true });
    else if (n === 'plain') windows.push({ world: plainWorld(), x0: 0, z0: 0, x1: 512, z1: 512, allGrids: true });
    else if (n === 'caves') windows.push({ world: cavesWorld(), x0: 0, z0: 0, x1: 512, z1: 512, allGrids: true });
    else if (n === 'hilly') windows.push({ world: hillyWorld(), x0: -512, z0: -512, x1: 512, z1: 512, allGrids: false });
    else if (n === 'vertical') windows.push({ world: verticalWorld(), x0: 128, z0: 128, x1: 384, z1: 384, allGrids: false });
    else throw new Error(`unknown world ${n}`);
  }
  const report: Record<string, unknown>[] = [];
  const mips: Record<string, MipLevel[]> = {};
  for (const w of windows) {
    const t0 = performance.now();
    const rows: ChunkRow[] = [];
    const grids = w.allGrids ? w.world.grids : [w.world.grids[0]!];
    for (const g of grids) deriveGrid(g, w, rows);
    const s = summarize(w.world.name, rows);
    report.push(s);
    log(`${w.world.name}: ${rows.length} chunks derived in ${((performance.now() - t0) / 1000).toFixed(1)} s, derive p50 ${(s.deriveUs as { p50: number }).p50.toFixed(0)} µs`);
    // Mips over the world grid's window.
    const store = createWorldStore(grid);
    const g0 = w.world.grids[0]!;
    if (w.allGrids) loadArea(g0, store, g0.bounds.min[0], g0.bounds.min[2], g0.bounds.max[0], g0.bounds.max[2]);
    else loadArea(g0, store, w.x0, w.z0, w.x1, w.z1);
    mips[w.world.name] = mipLevels(store, 4);
  }
  const props = propBench();
  const json = { started, node: process.version, host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: loadavg() }, rules: { id: PLACEHOLDER_RULES.id, version: PLACEHOLDER_RULES.version, radius: PLACEHOLDER_RULES.radius, jobRadius: R }, worlds: report, mips: Object.fromEntries(Object.entries(mips).map(([k, v]) => [k, v.map((l) => ({ ...l, downUs: { mean: mean(l.downUs), p95: pct(l.downUs, 95) } }))])), props, peakRssMB: (process.resourceUsage().maxRSS * 1024) / 1e6 };
  writeFileSync(join(outDir, 'derive.json'), JSON.stringify(json, null, 1));
  const md: string[] = [`# Derived data ${started}`, '', `node ${process.version}, ${json.host.cpus}, load ${loadavg().map((l) => l.toFixed(2)).join(' ')}, peak RSS ${json.peakRssMB.toFixed(0)} MB`, ''];
  md.push('| World | chunks (stored) | derive µs p50 / p95 | eval / mesh / consumers µs mean | apron µs p50 | bytes mean / p95 | MB | occ / light / coll / nav / ground / base / inst B mean |', '|---|---|---|---|---|---|---|---|');
  for (const r of report as Array<ReturnType<typeof summarize> & Record<string, never>>) {
    const x = r as unknown as { world: string; chunks: number; storedChunks: number; deriveUs: { p50: number; p95: number }; evaluateUs: { mean: number }; meshUs: { mean: number }; consumersUs: { mean: number }; apronUs: { p50: number }; bytes: { mean: number; p95: number }; totalMB: number; parts: Record<string, number> };
    md.push(`| ${x.world} | ${x.chunks} (${x.storedChunks}) | ${x.deriveUs.p50.toFixed(0)} / ${x.deriveUs.p95.toFixed(0)} | ${x.evaluateUs.mean.toFixed(0)} / ${x.meshUs.mean.toFixed(0)} / ${x.consumersUs.mean.toFixed(0)} | ${x.apronUs.p50.toFixed(0)} | ${x.bytes.mean.toFixed(0)} / ${x.bytes.p95.toFixed(0)} | ${x.totalMB.toFixed(2)} | ${['occupancy', 'light', 'collision', 'nav', 'ground', 'base', 'instances'].map((k) => x.parts[k]!.toFixed(0)).join(' / ')} |`);
  }
  md.push('', '| World | streaming path (world rules, 16³ sections) µs a chunk mean / p95: full | collision alone |', '|---|---|---|');
  for (const r of report) {
    const x = r as unknown as { world: string; sectionsFullUs: { mean: number; p95: number }; sectionsCollisionUs: { mean: number; p95: number } };
    md.push(`| ${x.world} | ${x.sectionsFullUs.mean.toFixed(0)} / ${x.sectionsFullUs.p95.toFixed(0)} | ${x.sectionsCollisionUs.mean.toFixed(0)} / ${x.sectionsCollisionUs.p95.toFixed(0)} |`);
  }
  md.push('', '```json', JSON.stringify({ worlds: report.map((r) => ({ world: r.world, surface: r.surface, alternatives: r.alternatives, mesh: r.mesh, classes: r.classes, partialShare: r.partialShare })), mips: json.mips, props }, null, 1), '```');
  writeFileSync(join(outDir, 'derive.md'), md.join('\n'));
  console.log(md.join('\n'));
}

main();
