/**
 * Mip nodes derived through the same rules and mesher as chunks
 * (mip-derive.ts), level by level over the same area of a test world:
 * nodes, ground and base triangles, vertex and shader bytes, the share of
 * ground nodes whose ground is a lattice heightfield, and µs a node (Node):
 * the node's downsample from its children, and its derive (evaluation,
 * mesh, consumers) for nodes with a surface.
 *
 *   node tools/voxel-bench/run.mjs mips [--worlds slice,hilly,town] [--levels 0,1,2] [--out DIR]
 *
 * Writes mips.md and mips.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import {
  ASSEMBLY_CLASS,
  chunkGrid,
  chunkOfKey,
  createWorldStore,
  deriveMipNode,
  groundHeightfield,
  GROUND_HEIGHTFIELD_TOLERANCE_M,
  mipCellMetres,
  mipChildren,
  mipNodeKey,
  MipTree,
  shaderBytes,
  SURFACE_VERTEX_BYTES,
  TERRAIN_RULES,
  type DeriveTimes,
  type PaletteStore,
} from '@thirdlight/voxel';
import { benchDir } from './bench-dirs';
import { loadArea } from './regions';
import { buildSliceWorld, TOWN_FOOTPRINT } from './slice-world';
import { townWorld } from './town';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
const E = grid.edge;

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
}

const pct = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
};

interface LevelRow {
  level: number;
  cellM: number;
  nodes: number;
  /** Nodes with a ground or base surface. */
  surfaceNodes: number;
  ground: number;
  base: number;
  instances: number;
  vertexKB: number;
  shaderKB: number;
  groundNodes: number;
  heightfields: number;
  /**
   * µs a node with a surface, p50 / p95: its downsample from its 8 children
   * (built first; level 1 reads its 8 chunks from the store), its apron and
   * neighbourhood gathered through the level's view (neighbours built), and
   * its derive (evaluation + mesh + consumers).
   */
  downUs: { p50: number; p95: number };
  apronUs: { p50: number; p95: number };
  deriveUs: { p50: number; p95: number };
  evaluateUs: { p50: number; p95: number };
  meshUs: { p50: number; p95: number };
}

/** Every level over the window [x0, x1) × [z0, z1) (cells, aligned to the coarsest level's node), the store's chunks' heights. */
function measure(store: PaletteStore, x0: number, z0: number, x1: number, z1: number, levels: readonly number[]): LevelRow[] {
  let cy0 = Infinity;
  let cy1 = -Infinity;
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    cy0 = Math.min(cy0, c.cy);
    cy1 = Math.max(cy1, c.cy);
  }
  const tree = new MipTree(store);
  const rows: LevelRow[] = [];
  for (const level of [...levels].sort((a, b) => a - b)) {
    const span = E << level;
    const row: LevelRow = { level, cellM: mipCellMetres(level), nodes: 0, surfaceNodes: 0, ground: 0, base: 0, instances: 0, vertexKB: 0, shaderKB: 0, groundNodes: 0, heightfields: 0, downUs: { p50: 0, p95: 0 }, apronUs: { p50: 0, p95: 0 }, deriveUs: { p50: 0, p95: 0 }, evaluateUs: { p50: 0, p95: 0 }, meshUs: { p50: 0, p95: 0 } };
    const down: number[] = [];
    const apron: number[] = [];
    const der: number[] = [];
    const ev: number[] = [];
    const me: number[] = [];
    const nodes: Array<{ level: number; nx: number; ny: number; nz: number }> = [];
    for (let nx = Math.floor(x0 / span); nx < Math.ceil(x1 / span); nx++) for (let nz = Math.floor(z0 / span); nz < Math.ceil(z1 / span); nz++) {
      // One node below the lowest chunk owns the ground's underside edges.
      for (let ny = (cy0 >> level) - 1; ny <= cy1 >> level; ny++) nodes.push({ level, nx, ny, nz });
    }
    // Downsamples first, each from its children (built before it, untimed), so a node's time is its own.
    const downOf = new Map<string, number>();
    if (level > 0) {
      for (const n of nodes) for (const k of mipChildren(n)) if (k.level > 0) tree.node(k);
      for (const n of nodes) {
        const t0 = performance.now();
        tree.node(n);
        downOf.set(mipNodeKey(n), (performance.now() - t0) * 1000);
      }
    }
    for (const n of nodes) {
      const downUs = downOf.get(mipNodeKey(n)) ?? 0;
      const times: DeriveTimes = { evaluateUs: 0, meshUs: 0, consumersUs: 0 };
      const t1 = performance.now();
      const d = deriveMipNode(tree, n, TERRAIN_RULES, times);
      const us = (performance.now() - t1) * 1000;
      row.nodes++;
      const g = d.ground.indices.length / 3;
      const b = d.base.indices.length / 3;
      row.ground += g;
      row.base += b;
      row.instances += d.instances.count;
      row.vertexKB += ((d.ground.vertexCount + d.base.vertexCount) * SURFACE_VERTEX_BYTES) / 1024;
      row.shaderKB += shaderBytes(d.shader) / 1024;
      if (g + b === 0) continue;
      row.surfaceNodes++;
      down.push(downUs);
      der.push(times.evaluateUs + times.meshUs + times.consumersUs);
      ev.push(times.evaluateUs);
      apron.push(us - times.evaluateUs - times.meshUs - times.consumersUs);
      me.push(times.meshUs);
      if (g > 0) {
        row.groundNodes++;
        const built = d.counts.wall + d.counts.beam + d.counts.rail > 0;
        if (!built && typeof groundHeightfield(d.ground, E, GROUND_HEIGHTFIELD_TOLERANCE_M, mipCellMetres(level)) !== 'string') row.heightfields++;
      }
    }
    row.downUs = { p50: pct(down, 50), p95: pct(down, 95) };
    row.apronUs = { p50: pct(apron, 50), p95: pct(apron, 95) };
    row.deriveUs = { p50: pct(der, 50), p95: pct(der, 95) };
    row.evaluateUs = { p50: pct(ev, 50), p95: pct(ev, 95) };
    row.meshUs = { p50: pct(me, 50), p95: pct(me, 95) };
    row.vertexKB = Math.round(row.vertexKB);
    row.shaderKB = Math.round(row.shaderKB);
    rows.push(row);
  }
  return rows;
}

/** [lo, hi) widened outward to whole multiples of `span`. */
const aligned = (lo: number, hi: number, span: number): [number, number] => [Math.floor(lo / span) * span, Math.ceil(hi / span) * span];

function main(): void {
  const worlds = arg('--worlds', 'slice,hilly,town').split(',');
  const levels = arg('--levels', '0,1,2').split(',').map(Number);
  const outDir = arg('--out', benchDir('mips'));
  mkdirSync(outDir, { recursive: true });
  const span = E << Math.max(...levels);
  const started = new Date().toISOString();
  const load0 = loadavg();
  const up0 = uptime();
  const reports: Array<{ world: string; window: string; levels: LevelRow[] }> = [];
  const log = (s: string): void => console.log(`[${(performance.now() / 1000).toFixed(0)} s] ${s}`);
  if (worlds.includes('slice')) {
    const slice = buildSliceWorld();
    const [sx, , sz] = slice.scene;
    // The slice page's ring round the scene, widened to whole coarsest nodes (the same area at every level).
    const [x0, x1] = aligned(sx - 192, sx + 192, span);
    const [z0, z1] = aligned(sz - 192, sz + 192, span);
    reports.push({ world: 'slice', window: `x ${x0}…${x1}, z ${z0}…${z1} cells`, levels: measure(slice.store, x0, z0, x1, z1, levels) });
    log('slice done');
  }
  if (worlds.includes('hilly')) {
    const store = createWorldStore(grid);
    const [x0, x1] = [0, 256];
    // A chunk of margin all round, so the window's nodes see their neighbours' cells.
    loadArea(hillyWorld({ footprint: 512 }).grids[0]!, store, x0 - span, x0 - span, x1 + span, x1 + span);
    reports.push({ world: 'hilly', window: `${x1 - x0}² cells`, levels: measure(store, x0, x0, x1, x1, levels) });
    log('hilly done');
  }
  if (worlds.includes('town')) {
    const store = createWorldStore(grid);
    loadArea(townWorld({ footprint: TOWN_FOOTPRINT }).grids[0]!, store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT);
    reports.push({ world: 'town', window: `whole ${TOWN_FOOTPRINT}² cells`, levels: measure(store, 0, 0, TOWN_FOOTPRINT, TOWN_FOOTPRINT, levels) });
    log('town done');
  }
  const json = { started, node: process.version, host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: [load0, loadavg()], uptimeH: up0 / 3600 }, rules: { id: TERRAIN_RULES.id, version: TERRAIN_RULES.version }, groundClass: ASSEMBLY_CLASS.ground, reports };
  writeFileSync(join(outDir, 'mips.json'), JSON.stringify(json, null, 2));
  const md: string[] = [
    `# Mip nodes through the derive (${started})`,
    '',
    `Node ${process.version}, ${json.host.cpus}, load ${load0.map((l) => l.toFixed(1)).join(' / ')} → ${loadavg().map((l) => l.toFixed(1)).join(' / ')}, uptime ${(up0 / 86400).toFixed(1)} d.`,
    '',
    '| World (window) | Level (cell) | Nodes (with surface) | Ground + base triangles | Instances | Vertex KB | Shader KB | Heightfield ground nodes | Downsample µs p50 / p95 | Apron µs p50 / p95 | Derive µs p50 / p95 (evaluate; mesh p50) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of reports) for (const l of r.levels) {
    md.push(`| ${r.world} (${r.window}) | L${l.level} (${l.cellM} m) | ${l.nodes} (${l.surfaceNodes}) | ${l.ground} + ${l.base} = ${l.ground + l.base} | ${l.instances} | ${l.vertexKB} | ${l.shaderKB} | ${l.heightfields} / ${l.groundNodes} | ${l.downUs.p50} / ${l.downUs.p95} | ${l.apronUs.p50} / ${l.apronUs.p95} | ${l.deriveUs.p50} / ${l.deriveUs.p95} (${l.evaluateUs.p50}; ${l.meshUs.p50}) |`);
  }
  md.push('');
  writeFileSync(join(outDir, 'mips.md'), md.join('\n'));
  console.log(md.join('\n'));
}

main();
