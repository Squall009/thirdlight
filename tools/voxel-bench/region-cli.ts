/**
 * The region file report (`node tools/voxel-bench/run.mjs region`):
 *
 * - sizes: every test world written as region files at 256 m and 512 m
 *   footprints, full-height columns and stacked cubes; header and table
 *   overhead; what one zstd or deflate stream per region would save;
 *   structure grids in their own containers;
 * - write amplification: bytes a save rewrites after one voxel edit and after
 *   a 4 m brush, per layout;
 * - range reads: one chunk and a 3 × 3 × 3 neighbourhood, from disk and from
 *   a range-serving HTTP server in another process, apart and coalesced;
 * - repo growth: a scripted hour of editing committed to scratch git repos
 *   (per layout), .git size before and after `git gc`.
 *
 * Writes region.md and region.json to --out (default
 * ~/.cache/thirdlight-phase45/work/45.3/results); scratch files go to
 * --work and are deleted at the end unless --keep.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, zstdCompressSync } from 'node:zlib';
import { mulberry32 } from '@thirdlight/shared';
import {
  chunkGrid,
  chunkOfKey,
  openRegion,
  readRegionChunks,
  RegionIndex,
  REGION_ENTRY_BYTES,
  REGION_HEADER_BYTES,
  voxel,
  VOXEL_CATEGORY,
  type ChunkCoord,
  type PaletteStore,
  type RegionFootprint,
  type RegionLayout,
  type VoxelStroke,
} from '@thirdlight/voxel';
import { FileSource, HttpSource, importRead, loadArea, pickStore, RegionSet, startRangeServer, surfaceY } from './regions';
import { MAT, type TestGrid, type TestWorld } from './world-kit';
import { allWorlds, hillyWorld, verticalWorld } from './worlds';

const grid = chunkGrid(32);
const WORLD_ID = Uint8Array.from({ length: 16 }, (_, i) => (i * 73 + 5) & 0xff);
const CONFIGS: readonly { layout: RegionLayout; footprint: RegionFootprint }[] = [
  { layout: 'column', footprint: 512 },
  { layout: 'stacked', footprint: 512 },
  { layout: 'column', footprint: 1024 },
  { layout: 'stacked', footprint: 1024 },
];
const cfgName = (c: { layout: RegionLayout; footprint: RegionFootprint }): string => `${c.footprint / 2} m ${c.layout}`;
const MB = 1e6;
const arg = (name: string, def: string): string => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : def);
const log = (s: string): void => console.error(`[region ${new Date().toISOString().slice(11, 19)}] ${s}`);

interface SizeRow {
  world: string;
  config: string;
  files: number;
  bytes: number;
  headerTable: number;
  entries: number;
  uniform: number;
  raw: number;
  maxFile: number;
  mbPerKm2: number;
  perRegionZstd?: number;
  perRegionDeflate?: number;
}

/** Super-tiles of 512 m (1024 cells) covering a grid. */
function superTiles(g: TestGrid): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let x = Math.floor(g.bounds.min[0] / 1024); x < Math.ceil(g.bounds.max[0] / 1024); x++) for (let z = Math.floor(g.bounds.min[2] / 1024); z < Math.ceil(g.bounds.max[2] / 1024); z++) out.push([x, z]);
  return out;
}

/** Writes a world's region files for every layout, one 512 m super-tile at a time; sizes per layout. */
function measureSizes(world: TestWorld): SizeRow[] {
  const rows = new Map<string, SizeRow>(CONFIGS.map((c) => [cfgName(c), { world: world.name, config: cfgName(c), files: 0, bytes: 0, headerTable: 0, entries: 0, uniform: 0, raw: 0, maxFile: 0, mbPerKm2: 0 }]));
  const structures: SizeRow = { world: world.name, config: 'structure grids (256 m column)', files: 0, bytes: 0, headerTable: 0, entries: 0, uniform: 0, raw: 0, maxFile: 0, mbPerKm2: 0 };
  let regionZstd = 0;
  let regionDeflate = 0;
  world.grids.forEach((g, gi) => {
    for (const [sx, sz] of gi === 0 ? superTiles(g) : [[0, 0] as [number, number]]) {
      const store = pickStore(grid);
      if (gi === 0) loadArea(g, store, sx * 1024, sz * 1024, (sx + 1) * 1024, (sz + 1) * 1024);
      else loadArea(g, store, g.bounds.min[0], g.bounds.min[2], g.bounds.max[0], g.bounds.max[2]);
      for (const c of gi === 0 ? CONFIGS : CONFIGS.slice(0, 1)) {
        const row = gi === 0 ? rows.get(cfgName(c))! : structures;
        for (const bytes of new RegionSet(store, c.layout, c.footprint, WORLD_ID, gi).allFiles().values()) {
          const idx = RegionIndex.parse(bytes);
          row.files++;
          row.bytes += bytes.length;
          row.headerTable += REGION_HEADER_BYTES + idx.size * REGION_ENTRY_BYTES;
          row.entries += idx.size;
          row.maxFile = Math.max(row.maxFile, bytes.length);
          for (let i = 0; i < idx.size; i++) {
            const r = idx.read(i, bytes);
            if (r.kind === 'uniform') row.uniform++;
            else if (r.kind === 'stored' && r.raw) row.raw++;
          }
        }
      }
      if (gi === 0) {
        // One stream per 256 m region instead of one frame per chunk: the codec bytes of its stored chunks, concatenated.
        const parts = new Map<string, Uint8Array[]>();
        const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
        for (const key of store.chunkKeys()) {
          chunkOfKey(grid, key, c);
          const b = store.encodeChunk(c.cx, c.cy, c.cz)!;
          // A uniform chunk is a table entry either way.
          if (((b[3]! >>> 5) & 3) === 0) continue;
          const name = `${Math.floor(c.cx / 16)}.${Math.floor(c.cz / 16)}`;
          if (!parts.has(name)) parts.set(name, []);
          parts.get(name)!.push(b);
        }
        for (const list of parts.values()) {
          const all = Buffer.concat(list);
          regionZstd += zstdCompressSync(all).length;
          regionDeflate += deflateRawSync(all, { level: 6 }).length;
        }
      }
    }
  });
  const km2 = world.areaM2 / 1e6;
  const out = [...rows.values()];
  for (const r of out) r.mbPerKm2 = r.bytes / MB / km2;
  out[0]!.perRegionZstd = regionZstd;
  out[0]!.perRegionDeflate = regionDeflate;
  if (structures.files > 0) out.push(structures);
  return out;
}

/** A 1 km² hilly area (cells −1024 … 1024) in one store, its surface reachable for strokes. */
function hillyArea(): { store: PaletteStore; g: TestGrid } {
  const g = hillyWorld().grids[0]!;
  const store = pickStore(grid);
  loadArea(g, store, -1024, -1024, 1024, 1024);
  return { store, g };
}

const stone = voxel(MAT.stone, VOXEL_CATEGORY.construction, 255);
const soil = voxel(MAT.soil, VOXEL_CATEGORY.terrain, 255);

interface AmpRow {
  world: string;
  config: string;
  edit: string;
  samples: number;
  filesRewritten: number;
  bytesRewritten: number;
  chunksChanged: number;
  entryBytes: number;
}

/** Bytes a save rewrites after one edit, per layout: mean over random surface spots. */
function measureAmplification(label: string, store: PaletteStore, g: TestGrid, area: readonly [number, number, number, number], samples: number): AmpRow[] {
  const sets = CONFIGS.map((c) => ({ c, set: new RegionSet(store, c.layout, c.footprint, WORLD_ID) }));
  for (const s of sets) s.set.takeChanged(true);
  const rand = mulberry32(45);
  const rows: AmpRow[] = [];
  const edits: Array<[string, (x: number, y: number, z: number, k: number) => VoxelStroke]> = [
    ['one voxel', (x, y, z) => ({ kind: 'box', min: [x, y + 1, z], max: [x, y + 1, z], voxel: stone })],
    ['4 m brush (sphere r 2 m)', (x, y, z, k) => ({ kind: 'sphere', center: [x, y, z], radius: 4, voxel: k % 2 === 0 ? voxel() : soil })],
  ];
  for (const [name, make] of edits) {
    const acc = sets.map((s) => ({ world: label, config: cfgName(s.c), edit: name, samples: 0, filesRewritten: 0, bytesRewritten: 0, chunksChanged: 0, entryBytes: 0 }));
    for (let k = 0; k < samples; k++) {
      const x = Math.floor(area[0] + rand() * (area[2] - area[0]));
      const z = Math.floor(area[1] + rand() * (area[3] - area[1]));
      const y = surfaceY(store, x, z, g.bounds.max[1], g.bounds.min[1]);
      if (y === null) continue;
      const stroke = make(x, y, z, k);
      store.applyStroke(stroke);
      sets.forEach((s, i) => {
        s.set.mark(stroke);
        const r = s.set.repack();
        const files = s.set.takeChanged();
        const a = acc[i]!;
        a.samples++;
        a.chunksChanged += r.chunks;
        a.entryBytes += r.entryBytes;
        for (const b of files.values()) {
          a.filesRewritten++;
          a.bytesRewritten += b?.length ?? 0;
        }
      });
    }
    rows.push(...acc);
  }
  return rows;
}

interface ReadRow {
  source: string;
  what: string;
  maxGap: number;
  requests: number;
  medianMs: number;
  p95Ms: number;
  bytes: number;
  fetched: number;
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
};

/** A range server in its own Node process, so reads cross a real socket and another event loop. */
async function serverProcess(root: string): Promise<{ port: number; stop: () => void }> {
  const child = spawn(process.execPath, [process.argv[1]!, '--serve', root], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      const m = /port (\d+)/.exec(d.toString());
      if (m !== null) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`range server exited ${code}`)));
  });
  return { port, stop: () => child.kill() };
}

/** Range-read latency from disk and over HTTP: one chunk (cold: header and table too; warm) and a 3 × 3 × 3 neighbourhood. */
async function measureReads(store: PaletteStore, g: TestGrid, dir: string, samples: number): Promise<{ rows: ReadRow[]; decodeUs: number }> {
  const set = new RegionSet(store, 'column', 512, WORLD_ID);
  mkdirSync(dir, { recursive: true });
  for (const [name, b] of set.allFiles()) writeFileSync(join(dir, name), b);
  const rand = mulberry32(9);
  const spots: ChunkCoord[] = [];
  while (spots.length < samples) {
    const x = Math.floor(-1000 + rand() * 2000);
    const z = Math.floor(-1000 + rand() * 2000);
    const y = surfaceY(store, x, z, g.bounds.max[1], g.bounds.min[1]);
    // Keep the 3 × 3 neighbourhood inside one region: the read is per file.
    const cx = x >> 5;
    const cz = z >> 5;
    if (y === null || ((cx + 1) & 15) < 2 || ((cz + 1) & 15) < 2) continue;
    spots.push({ cx, cy: y >> 5, cz });
  }
  const server = await serverProcess(dir);
  const rows: ReadRow[] = [];
  const back = pickStore(grid);
  let decodeMs = 0;
  let decoded = 0;
  try {
    for (const kind of ['disk', 'http'] as const) {
      const make = async (c: ChunkCoord): Promise<FileSource | HttpSource> => {
        const name = `r.${Math.floor(c.cx / 16)}.${Math.floor(c.cz / 16)}.vxr`;
        return kind === 'disk' ? FileSource.open(join(dir, name)) : new HttpSource(`http://127.0.0.1:${server.port}/${name}`);
      };
      const cases: Array<[string, number, (c: ChunkCoord) => ChunkCoord[], boolean]> = [
        ['one chunk, cold (header + table + chunk)', -1, (c) => [c], true],
        ['one chunk, table cached', -1, (c) => [c], false],
        ['3×3×3 chunks, table cached', -1, near, false],
        ['3×3×3 chunks, table cached', 4096, near, false],
        ['3×3×3 chunks, table cached', 64 * 1024, near, false],
      ];
      for (const [what, gap, list, cold] of cases) {
        const coalesced = gap >= 0;
        const ms: number[] = [];
        let requests = 0;
        let bytes = 0;
        let fetched = 0;
        for (const c of spots) {
          const src = await make(c);
          let index = cold ? null : await openRegion(src);
          const before = src.requests;
          const fetchedBefore = src.fetched;
          const t0 = performance.now();
          if (index === null) index = await openRegion(src);
          const reads = await readRegionChunks(src, index, list(c), gap);
          ms.push(performance.now() - t0);
          requests += src.requests - before;
          fetched += src.fetched - fetchedBefore;
          for (const r of reads) if (r.kind === 'stored') bytes += r.bytes.length;
          if (kind === 'disk' && gap === 4096) {
            const t1 = performance.now();
            for (const r of reads) importRead(back, r);
            decodeMs += performance.now() - t1;
            decoded += reads.filter((r) => r.kind !== 'air').length;
          }
          if (src instanceof FileSource) await src.close();
        }
        rows.push({ source: kind, what, maxGap: gap, requests: requests / spots.length, medianMs: pct(ms, 0.5), p95Ms: pct(ms, 0.95), bytes: bytes / spots.length, fetched: fetched / spots.length });
      }
    }
  } finally {
    server.stop();
  }
  return { rows, decodeUs: (decodeMs * 1000) / Math.max(1, decoded) };
}

function near(c: ChunkCoord): ChunkCoord[] {
  const out: ChunkCoord[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) out.push({ cx: c.cx + dx, cy: c.cy + dy, cz: c.cz + dz });
  return out;
}

/** Bytes of every file under a folder. */
function treeBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? treeBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return n;
}

interface RepoRow {
  config: string;
  commitEveryMin: number;
  strokes: number;
  commits: number;
  worldBytes: number;
  gitInitial: number;
  gitAfterHour: number;
  gitAfterGc: number;
  gitInitialGc: number;
  filesPerCommit: number;
  bytesWrittenPerCommit: number;
  blobs: number;
  deltaBlobs: number;
}

/**
 * A scripted hour of editing on the 1 km² hilly area: a stroke every 3 s
 * around a cursor that wanders a few metres a stroke and jumps elsewhere every
 * 5 minutes; half small terrain dabs (r 1–2 m), a quarter 4 m dabs, a quarter
 * walls (0.5 m thick, 4–8 m long, 3 m tall). Every layout tracks the same
 * edits in its own scratch repo, committing every N minutes.
 */
function measureRepo(store: PaletteStore, g: TestGrid, work: string, commitsEvery: readonly number[]): RepoRow[] {
  const variants = CONFIGS.flatMap((c) => commitsEvery.filter((m) => m === commitsEvery[0] || (c.layout === 'column' && c.footprint === 512)).map((m) => ({ c, m })));
  const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.name=voxel-bench', '-c', 'user.email=bench@localhost', '-c', 'gc.auto=0', ...a], { cwd, encoding: 'utf8' });
  const repos = variants.map(({ c, m }) => {
    const dir = join(work, `repo-${c.footprint / 2}-${c.layout}-${m}min`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    const set = new RegionSet(store, c.layout, c.footprint, WORLD_ID);
    const files = set.allFiles();
    for (const [n, b] of files) writeFileSync(join(dir, n), b);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'world');
    // The world alone, packed by gc: the baseline the hour's growth after gc is measured against.
    const base = `${dir}-base`;
    rmSync(base, { recursive: true, force: true });
    cpSync(dir, base, { recursive: true });
    git(base, 'gc', '-q');
    const gitInitialGc = treeBytes(join(base, '.git'));
    rmSync(base, { recursive: true, force: true });
    return {
      gitInitialGc,
      c,
      m,
      dir, set, worldBytes: [...files.values()].reduce((s, b) => s + b.length, 0), gitInitial: treeBytes(join(dir, '.git')), commits: 0, files: 0, written: 0 };
  });
  const rand = mulberry32(2026);
  let cx = 0;
  let cz = 0;
  const seconds = 3600;
  let strokes = 0;
  for (let t = 3; t <= seconds; t += 3) {
    if (t % 300 === 0) {
      cx = Math.floor(-900 + rand() * 1800);
      cz = Math.floor(-900 + rand() * 1800);
    }
    cx = Math.max(-1000, Math.min(1000, cx + Math.round((rand() - 0.5) * 20)));
    cz = Math.max(-1000, Math.min(1000, cz + Math.round((rand() - 0.5) * 20)));
    const y = surfaceY(store, cx, cz, g.bounds.max[1], g.bounds.min[1]);
    if (y !== null) {
      const r = rand();
      let stroke: VoxelStroke;
      if (r < 0.5) stroke = { kind: 'sphere', center: [cx, y, cz], radius: 2 + Math.floor(rand() * 3), voxel: rand() < 0.5 ? voxel() : soil };
      else if (r < 0.75) stroke = { kind: 'sphere', center: [cx, y, cz], radius: 4, voxel: rand() < 0.5 ? voxel() : soil };
      else {
        const len = 8 + Math.floor(rand() * 9);
        const alongX = rand() < 0.5;
        stroke = { kind: 'box', min: [cx, y + 1, cz], max: alongX ? [cx + len - 1, y + 6, cz] : [cx, y + 6, cz + len - 1], voxel: stone };
      }
      store.applyStroke(stroke);
      strokes++;
      for (const rp of repos) rp.set.mark(stroke);
    }
    for (const rp of repos) {
      if (t % (rp.m * 60) !== 0) continue;
      const changed = rp.set.takeChanged();
      for (const [n, b] of changed) {
        if (b === null) rmSync(join(rp.dir, n), { force: true });
        else writeFileSync(join(rp.dir, n), b);
        rp.files++;
        rp.written += b?.length ?? 0;
      }
      git(rp.dir, 'add', '-A');
      git(rp.dir, 'commit', '-q', '--allow-empty', '-m', `edits to ${t}s`);
      rp.commits++;
    }
  }
  return repos.map((rp) => {
    const gitAfterHour = treeBytes(join(rp.dir, '.git'));
    git(rp.dir, 'gc', '-q');
    const gitAfterGc = treeBytes(join(rp.dir, '.git'));
    // How the pack stores the region blobs: as deltas against their earlier versions, or whole.
    const pack = readdirSync(join(rp.dir, '.git', 'objects', 'pack')).find((f) => f.endsWith('.idx'))!;
    const verify = git(rp.dir, 'verify-pack', '-v', join('.git', 'objects', 'pack', pack));
    const blobs = verify.split('\n').filter((l) => / blob /.test(l));
    const deltas = blobs.filter((l) => l.trim().split(/\s+/).length >= 7).length;
    return {
      config: cfgName(rp.c),
      commitEveryMin: rp.m,
      strokes,
      commits: rp.commits,
      worldBytes: rp.worldBytes,
      gitInitial: rp.gitInitial,
      gitAfterHour,
      gitAfterGc,
      gitInitialGc: rp.gitInitialGc,
      filesPerCommit: rp.files / Math.max(1, rp.commits),
      bytesWrittenPerCommit: rp.written / Math.max(1, rp.commits),
      blobs: blobs.length,
      deltaBlobs: deltas,
    };
  });
}

const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '-');
const f2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '-');
const f3 = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : '-');
const kb = (n: number): string => (n / 1000).toFixed(1);

async function main(): Promise<void> {
  if (process.argv.includes('--serve')) {
    const { port } = await startRangeServer(arg('--serve', '.'));
    console.log(`port ${port}`);
    return;
  }
  const out = arg('--out', join(homedir(), '.cache', 'thirdlight-phase45', 'work', '45.3', 'results'));
  const work = arg('--work', join(homedir(), '.cache', 'thirdlight-phase45', 'work', '45.3', 'scratch'));
  const parts = arg('--parts', 'sizes,amp,reads,repo').split(',');
  const samples = Number(arg('--samples', '60'));
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const report: Record<string, unknown> = { started: new Date().toISOString(), node: process.version, loadavg: loadavg() };
  const md: string[] = ['# Region files', ''];
  if (parts.includes('sizes')) {
    const rows: SizeRow[] = [];
    for (const w of allWorlds()) {
      log(`sizes: ${w.name}`);
      rows.push(...measureSizes(w));
    }
    report.sizes = rows;
    md.push('| World | Layout | Files | MB | MB/km² | header+table KB (%) | entries (uniform, raw) | max file KB | one zstd / deflate stream per region MB |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) md.push(`| ${r.world} | ${r.config} | ${r.files} | ${f3(r.bytes / MB)} | ${f2(r.mbPerKm2)} | ${kb(r.headerTable)} (${f1((100 * r.headerTable) / r.bytes)} %) | ${r.entries} (${r.uniform}, ${r.raw}) | ${kb(r.maxFile)} | ${r.perRegionZstd === undefined ? '' : `${f3(r.perRegionZstd / MB)} / ${f3((r.perRegionDeflate ?? 0) / MB)} (+ table)`} |`);
    md.push('');
  }
  let area: { store: PaletteStore; g: TestGrid } | null = null;
  const hilly = (): { store: PaletteStore; g: TestGrid } => {
    if (area === null) {
      log('loading the 1 km² hilly area');
      area = hillyArea();
    }
    return area;
  };
  if (parts.includes('reads')) {
    const { store, g } = hilly();
    log('range reads');
    const r = await measureReads(store, g, join(work, 'reads'), samples);
    report.reads = r;
    md.push(`Range reads on the 1 km² hilly area (256 m column files), ${samples} surface spots; decode (zstd + palette, Node) ${f1(r.decodeUs)} µs a chunk.`, '');
    md.push('| Source | Read | Coalesce gap | Requests | Median ms | p95 ms | Chunk KB | Fetched KB |', '|---|---|---|---|---|---|---|---|');
    for (const x of r.rows) md.push(`| ${x.source} | ${x.what} | ${x.maxGap < 0 ? 'apart' : `${x.maxGap / 1024} KB`} | ${f1(x.requests)} | ${f3(x.medianMs)} | ${f3(x.p95Ms)} | ${kb(x.bytes)} | ${kb(x.fetched)} |`);
    md.push('');
  }
  if (parts.includes('amp')) {
    const { store, g } = hilly();
    log('write amplification');
    const rows = measureAmplification('hilly 1 km²', store, g, [-1000, -1000, 1000, 1000], samples);
    log('write amplification: the 2 km tall world');
    const tall = verticalWorld().grids[0]!;
    const tallStore = pickStore(grid);
    loadArea(tall, tallStore, 0, 0, 512, 512);
    rows.push(...measureAmplification('vertical 2 km', tallStore, tall, [8, 8, 504, 504], samples));
    report.amplification = rows;
    md.push('| World | Layout | Edit | Samples | Files rewritten | KB rewritten / edit | Chunks changed / edit | Changed entries KB / edit | Amplification |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) md.push(`| ${r.world} | ${r.config} | ${r.edit} | ${r.samples} | ${f2(r.filesRewritten / r.samples)} | ${kb(r.bytesRewritten / r.samples)} | ${f2(r.chunksChanged / r.samples)} | ${f2(r.entryBytes / r.samples / 1000)} | ${f1(r.bytesRewritten / Math.max(1, r.entryBytes))}× |`);
    md.push('');
  }
  if (parts.includes('repo')) {
    // A fresh area: the earlier parts edited the store.
    area = null;
    const { store, g } = hilly();
    log('repo growth');
    const rows = measureRepo(store, g, work, [10, 2]);
    report.repo = rows;
    md.push('| Layout | Commit every | Strokes | Commits | World MB | .git initial MB | .git after the hour MB | growth / hour MB (loose) | after gc MB | world alone after gc MB | growth / hour after gc MB | files / commit | MB written / commit | blobs in pack (as deltas) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) md.push(`| ${r.config} | ${r.commitEveryMin} min | ${r.strokes} | ${r.commits} | ${f2(r.worldBytes / MB)} | ${f2(r.gitInitial / MB)} | ${f2(r.gitAfterHour / MB)} | ${f2((r.gitAfterHour - r.gitInitial) / MB)} | ${f2(r.gitAfterGc / MB)} | ${f2(r.gitInitialGc / MB)} | ${f2((r.gitAfterGc - r.gitInitialGc) / MB)} | ${f1(r.filesPerCommit)} | ${f2(r.bytesWrittenPerCommit / MB)} | ${r.blobs} (${r.deltaBlobs}) |`);
    md.push('');
  }
  report.finished = new Date().toISOString();
  report.peakRssMB = process.resourceUsage().maxRSS / 1000;
  writeFileSync(join(out, 'region.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(out, 'region.md'), md.join('\n') + '\n');
  console.log(md.join('\n'));
  if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

