/**
 * Edit, undo and save costs on the test worlds (the 45.2 pick, 32³, stacked
 * 256 m region files, zstd 3).
 *
 *   node tools/voxel-bench/run.mjs edits [--samples 60] [--strokes 1000] [--out DIR] [--keep]
 *
 * Per world and edit kind (single voxel, 1/2/4 m brush dab, 4 m brush drag,
 * 16 m box fill, a 20 m stamp at 30°): apply µs, cells and chunks changed,
 * undo record bytes (in memory and encoded) and undo apply µs, at random
 * surface spots. Then a session of N mixed strokes on region files on disk,
 * saved every 10 strokes (dirty files only): bytes rewritten per save and
 * save ms; the game save after N strokes against the shipped files: bytes,
 * entries, write and load ms, and the same save with every entry a cell
 * delta (the other encoding that keeps the changed cells); base-chunk hash
 * µs per chunk (bytes already in the base form, and through a decode).
 * Writes
 * edits.md/edits.json to --out (default ~/.cache/thirdlight-phase45/work/
 * 45.4/results); scratch region files go next to it and are deleted after.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { mulberry32 } from '@thirdlight/shared';
import {
  applyEdit,
  applySave,
  applyUndo,
  baseChunkHash,
  baseContentHash,
  canonicalEditCommand,
  createChunkImage,
  decodePaletteImage,
  playerCells,
  chunkGrid,
  chunkKey,
  chunkOfKey,
  DEFAULT_REGION_FOOTPRINT,
  encodeUndoRecord,
  readSave,
  stampShapeHash,
  UNDO_MEMORY_BUDGET_BYTES,
  undoRecordBytes,
  VOXEL_ROLE,
  writeSave,
  type ChunkCoord,
  type EditGrids,
  type PaletteStore,
  type SaveChunk,
  type StampShape,
  type VoxelEditCommand,
} from '@thirdlight/voxel';
import { loadArea, pickStore, surfaceY, zstdCompress, zstdDecompress } from './regions';
import { listRegionFiles, RegionWorld, ShippedWorld, updateSave, type WorldDirOptions } from '@thirdlight/workspace';
import { MAT, type TestGrid } from './world-kit';
import { cavesWorld, hillyWorld, townWorld } from './worlds';

const grid = chunkGrid(32);
const WORLD = Uint8Array.from({ length: 16 }, (_, i) => (i * 29 + 3) & 0xff);
const OPTS: WorldDirOptions = { grid, worldId: WORLD, layout: 'stacked', footprint: DEFAULT_REGION_FOOTPRINT };
const stone = { material: MAT.stone, role: VOXEL_ROLE.wall, wetness: 0 };
const soil = { material: MAT.soil, role: VOXEL_ROLE.terrain, wetness: 0 };
const MB = 1024 * 1024;
const f1 = (n: number): string => n.toFixed(1);
const f2 = (n: number): string => n.toFixed(2);
const kb = (n: number): string => (n / 1024).toFixed(1);

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : dflt;
}

function log(s: string): void {
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
}

/** A 20 × 10 × 20 m stamp (a bridge-like slab with arches): 40 × 20 × 40 cells, partly covered edges. */
const BIG_STAMP: StampShape = (() => {
  const size: [number, number, number] = [40, 20, 40];
  const coverage = new Uint8Array(40 * 20 * 40);
  for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) for (let y = 0; y < 20; y++) {
    const arch = (x % 10) - 4.5;
    const solid = y >= 14 || (y >= 4 + Math.sqrt(Math.max(0, 25 - arch * arch)) * 2 ? 1 : 0);
    const edge = z === 0 || z === 39 || x === 0 || x === 39;
    coverage[(x * 40 + z) * 20 + y] = solid ? (edge ? 128 : 255) : 0;
  }
  return { size, coverage };
})();
const STAMP_HASH = stampShapeHash(BIG_STAMP);
const stamps = (id: string) => (id === 'bridge' ? { shape: BIG_STAMP, hash: STAMP_HASH } : undefined);

type Kind = 'single voxel' | '1 m dab' | '2 m dab' | '4 m dab' | '4 m drag (10 dabs, 5 m)' | '16 m box fill' | '20 m stamp at 30°';
const KINDS: readonly Kind[] = ['single voxel', '1 m dab', '2 m dab', '4 m dab', '4 m drag (10 dabs, 5 m)', '16 m box fill', '20 m stamp at 30°'];

/** One command of a kind at a surface cell (x, y, z); `k` alternates dig/add. */
function commandOf(kind: Kind, x: number, y: number, z: number, k: number): VoxelEditCommand {
  const dab = (r: number): VoxelEditCommand =>
    canonicalEditCommand(k % 2 === 0 ? { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [r, r, r], points: [x + 0.5, y + 0.5, z + 0.5], mode: 'dig', smooth: true } : { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [r, r, r], points: [x + 0.5, y + 1.5, z + 0.5], mode: 'add', voxel: soil, smooth: true });
  switch (kind) {
    case 'single voxel':
      return canonicalEditCommand(k % 2 === 0 ? { v: 2, grid: 0, kind: 'dig', cells: [x, y, z] } : { v: 2, grid: 0, kind: 'set', cells: [x, y + 1, z], voxel: { ...stone, shape: 15 } });
    case '1 m dab':
      return dab(1);
    case '2 m dab':
      return dab(2);
    case '4 m dab':
      return dab(4);
    case '4 m drag (10 dabs, 5 m)': {
      const points: number[] = [];
      for (let i = 0; i < 10; i++) points.push(x + 0.5 + i, y + 0.5, z + 0.5 + i * 0.3);
      return canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [4, 4, 4], points, mode: k % 2 === 0 ? 'dig' : 'add', ...(k % 2 === 0 ? {} : { voxel: soil }), smooth: true });
    }
    case '16 m box fill':
      return canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [x - 16, y - 8, z - 16], max: [x + 15, y + 23, z + 15], mode: k % 2 === 0 ? 'dig' : 'place', ...(k % 2 === 0 ? {} : { voxel: stone }) });
    case '20 m stamp at 30°':
      return canonicalEditCommand({ v: 2, grid: 0, kind: 'stamp', stamp: { id: 'bridge', hash: STAMP_HASH }, origin: [x - 17.25, y - 3, z - 17.25], yaw: [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], scale: 1, mode: 'add', voxel: stone, smooth: true });
  }
}

interface Area {
  readonly name: string;
  readonly g: TestGrid;
  readonly box: readonly [number, number, number, number];
  readonly top: number;
  readonly bottom: number;
}

function areas(): Area[] {
  return [
    { name: 'hilly 512 m', g: hillyWorld().grids[0]!, box: [-512, -512, 512, 512], top: 400, bottom: -140 },
    { name: 'town 256 m', g: townWorld().grids[0]!, box: [0, 0, 512, 512], top: 120, bottom: -140 },
    { name: 'caves 256 m', g: cavesWorld().grids[0]!, box: [0, 0, 512, 512], top: 120, bottom: -140 },
  ];
}

function load(a: Area): PaletteStore {
  const s = pickStore(grid);
  loadArea(a.g, s, a.box[0], a.box[1], a.box[2], a.box[3]);
  return s;
}

/** Random surface spots at least 40 cells inside the area (so strokes stay in it). */
function spots(a: Area, store: PaletteStore, n: number, seed: number): [number, number, number][] {
  const rand = mulberry32(seed);
  const out: [number, number, number][] = [];
  while (out.length < n) {
    const x = Math.floor(a.box[0] + 40 + rand() * (a.box[2] - a.box[0] - 80));
    const z = Math.floor(a.box[1] + 40 + rand() * (a.box[3] - a.box[1] - 80));
    const y = surfaceY(store, x, z, a.top, a.bottom);
    if (y !== null) out.push([x, y, z]);
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((p, q) => p - q);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
};
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((p, q) => p + q, 0) / xs.length);

interface KindRow {
  world: string;
  kind: Kind;
  samples: number;
  applyUsMedian: number;
  applyUsMean: number;
  cells: number;
  chunks: number;
  undoBytes: number;
  undoEncodedBytes: number;
  imageShare: number;
  undoApplyUs: number;
}

function measureKinds(a: Area, samples: number): KindRow[] {
  const rows: KindRow[] = [];
  const store = load(a);
  const g: EditGrids = { store: (id) => (id === 0 ? store : undefined) };
  // Warm the code paths once so the first kind is not charged for compilation.
  for (const [x, y, z] of spots(a, store, 5, 99)) for (const kind of KINDS) applyUndo(g, applyEdit(g, commandOf(kind, x, y, z, 1), { stamps }).chunks);
  for (const kind of KINDS) {
    const t: number[] = [];
    const tu: number[] = [];
    let cells = 0;
    let chunks = 0;
    let undo = 0;
    let enc = 0;
    let images = 0;
    let n = 0;
    spots(a, store, samples, 7 + KINDS.indexOf(kind)).forEach(([x, y, z], k) => {
      const cmd = commandOf(kind, x, y, z, k);
      const t0 = performance.now();
      const out = applyEdit(g, cmd, { stamps });
      t.push((performance.now() - t0) * 1000);
      cells += out.cells;
      chunks += out.chunks.length;
      undo += undoRecordBytes(out.chunks);
      enc += encodeUndoRecord(grid, out.chunks).length;
      images += out.chunks.filter((u) => u.before.kind === 'image').length;
      n += out.chunks.length;
      const t1 = performance.now();
      applyUndo(g, out.chunks);
      tu.push((performance.now() - t1) * 1000);
    });
    rows.push({ world: a.name, kind, samples, applyUsMedian: median(t), applyUsMean: mean(t), cells: cells / samples, chunks: chunks / samples, undoBytes: undo / samples, undoEncodedBytes: enc / samples, imageShare: n === 0 ? 0 : images / n, undoApplyUs: median(tu) });
    log(`${a.name}: ${kind}: ${f1(median(t))} µs, ${f1(undo / samples)} undo B`);
  }
  return rows;
}

/** The session mix: half 1–2 m dabs, a quarter 4 m drags, a sixth single voxels, the rest 16 m fills. */
function sessionKind(r: number): Kind {
  if (r < 0.25) return '1 m dab';
  if (r < 0.5) return '2 m dab';
  if (r < 0.75) return '4 m drag (10 dabs, 5 m)';
  if (r < 0.92) return 'single voxel';
  return '16 m box fill';
}

interface SessionRow {
  world: string;
  strokes: number;
  saves: number;
  filesPerSave: number;
  bytesPerSave: number;
  chunksPerSave: number;
  saveMs: number;
  worldBytes: number;
  gameSave: { strokes: number; chunks: number; bytes: number; allDeltaBytes: number; delta: number; image: number; uniform: number; air: number; buildMs: number; writeMs: number; readMs: number; applyMs: number; openMs: number; bytesPerStroke: number }[];
  hashUs: number;
  hashDecodeUs: number;
  hashKBPerChunk: number;
}

async function measureSession(a: Area, strokes: number, work: string): Promise<SessionRow> {
  const shippedDir = join(work, 'shipped');
  const editDir = join(work, 'edit');
  rmSync(work, { recursive: true, force: true });
  RegionWorld.create(shippedDir, OPTS, load(a));
  cpSync(shippedDir, editDir, { recursive: true });
  const worldBytes = readdirSync(shippedDir).reduce((n, f) => n + statSync(join(shippedDir, f)).size, 0);
  const { world } = await RegionWorld.open(editDir, OPTS, listRegionFiles(editDir));
  const shipped = new ShippedWorld(shippedDir, OPTS, listRegionFiles(shippedDir));
  const rand = mulberry32(1234);
  const pool = spots(a, world.store, 400, 4321);
  const touched = new Map<number, ChunkCoord>();
  const saves: { files: number; bytes: number; repacked: number; ms: number }[] = [];
  const gameSave: SessionRow['gameSave'] = [];
  let save: { worldId: Uint8Array; grid: typeof grid; chunks: readonly SaveChunk[] } = { worldId: WORLD, grid, chunks: [] };
  const checkpoints = new Set([10, 100, strokes]);
  for (let i = 1; i <= strokes; i++) {
    const [x, , z] = pool[Math.floor(rand() * pool.length)]!;
    const y = surfaceY(world.store, x, z, a.top, a.bottom) ?? a.bottom;
    const out = world.edit(commandOf(sessionKind(rand()), x, y, z, i), stamps);
    for (const u of out.chunks) touched.set(chunkKey(grid, u.cx, u.cy, u.cz), { cx: u.cx, cy: u.cy, cz: u.cz });
    if (i % 10 === 0) {
      const t0 = performance.now();
      const s = world.save();
      saves.push({ ...s, ms: performance.now() - t0 });
    }
    if (checkpoints.has(i)) {
      const t0 = performance.now();
      save = updateSave(save, shipped, world.store, 0, touched.values());
      touched.clear();
      const t1 = performance.now();
      const bytes = writeSave(save, 'zstd', zstdCompress);
      const t2 = performance.now();
      const back = readSave(bytes, grid, WORLD, zstdDecompress);
      const t3 = performance.now();
      const fresh = await RegionWorld.open(shippedDir, OPTS, listRegionFiles(shippedDir));
      const t4 = performance.now();
      const fresher = new ShippedWorld(shippedDir, OPTS, listRegionFiles(shippedDir));
      applySave(back, WORLD, () => fresh.world.store, (c) => fresher.hash(c), () => 'save');
      const t5 = performance.now();
      const count = (k: string): number => save.chunks.filter((c) => c.content.kind === k).length;
      // The same changed cells with every entry a delta: the other encoding that keeps them.
      const allDelta = { ...save, chunks: save.chunks.map((c) => (c.content.kind === 'delta' ? c : { ...c, content: { kind: 'delta' as const, delta: playerCells(grid, c.content) } })) };
      const allDeltaBytes = writeSave(allDelta, 'zstd', zstdCompress).length;
      gameSave.push({ strokes: i, chunks: save.chunks.length, bytes: bytes.length, allDeltaBytes, delta: count('delta'), image: count('image'), uniform: count('uniform'), air: count('air'), buildMs: t1 - t0, writeMs: t2 - t1, readMs: t3 - t2, applyMs: t5 - t4, openMs: t4 - t3, bytesPerStroke: bytes.length / i });
      log(`${a.name}: game save after ${i} strokes: ${save.chunks.length} chunks, ${kb(bytes.length)} KB`);
    }
  }
  // Hash cost: every chunk the session touched, from its shipped bytes.
  const keys = [...world.store.chunkKeys()].slice(0, 2000);
  let hashUs = 0;
  let hashDecodeUs = 0;
  const img = createChunkImage(grid);
  let hashBytes = 0;
  let hashed = 0;
  for (const key of keys) {
    const c = chunkOfKey(grid, key);
    const b = shipped.chunkBytes(c);
    if (b === null || b.length < 64) continue;
    const t0 = performance.now();
    const h = baseChunkHash(grid, b);
    const t1 = performance.now();
    // What a codec newer than the base form pays: decode, write the base form, hash.
    decodePaletteImage(b, img);
    const h2 = baseContentHash(img);
    hashUs += (t1 - t0) * 1000;
    hashDecodeUs += (performance.now() - t1) * 1000;
    if (h.some((x, k) => x !== h2[k])) throw new Error('base hash differs between the two paths');
    hashBytes += b.length;
    hashed++;
  }
  return {
    world: a.name,
    strokes,
    saves: saves.length,
    filesPerSave: mean(saves.map((s) => s.files)),
    bytesPerSave: mean(saves.map((s) => s.bytes)),
    chunksPerSave: mean(saves.map((s) => s.repacked)),
    saveMs: median(saves.map((s) => s.ms)),
    worldBytes,
    gameSave,
    hashUs: hashed === 0 ? 0 : hashUs / hashed,
    hashDecodeUs: hashed === 0 ? 0 : hashDecodeUs / hashed,
    hashKBPerChunk: hashed === 0 ? 0 : hashBytes / hashed / 1024,
  };
}

async function main(): Promise<void> {
  const samples = Number(arg('--samples', '60'));
  const strokes = Number(arg('--strokes', '1000'));
  const out = arg('--out', join(homedir(), '.cache', 'thirdlight-phase45', 'work', '45.4', 'results'));
  const work = join(out, '..', 'scratch');
  mkdirSync(out, { recursive: true });
  const report: Record<string, unknown> = { started: new Date().toISOString(), node: process.version, loadavg: loadavg(), undoBudgetBytes: UNDO_MEMORY_BUDGET_BYTES };
  const kinds: KindRow[] = [];
  const sessions: SessionRow[] = [];
  for (const a of areas()) {
    log(`${a.name}: edit kinds`);
    kinds.push(...measureKinds(a, samples));
    log(`${a.name}: session of ${strokes} strokes`);
    sessions.push(await measureSession(a, strokes, join(work, a.name.split(' ')[0]!)));
  }
  rmSync(work, { recursive: true, force: true });
  report.kinds = kinds;
  report.sessions = sessions;
  report.finished = new Date().toISOString();
  report.loadavgEnd = loadavg();
  report.peakRssMB = process.resourceUsage().maxRSS / 1000;
  const md: string[] = ['# Edits, undo and saves', ''];
  md.push(`Undo budget ${UNDO_MEMORY_BUDGET_BYTES / MB} MiB; ${samples} surface spots per kind; apply and undo µs are medians.`, '');
  md.push('| World | Edit | apply µs (mean) | cells | chunks | undo B (encoded) | image share | undo apply µs | strokes per 64 MiB |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of kinds) md.push(`| ${r.world} | ${r.kind} | ${f1(r.applyUsMedian)} (${f1(r.applyUsMean)}) | ${f1(r.cells)} | ${f2(r.chunks)} | ${f1(r.undoBytes)} (${f1(r.undoEncodedBytes)}) | ${Math.round(100 * r.imageShare)} % | ${f1(r.undoApplyUs)} | ${Math.floor(UNDO_MEMORY_BUDGET_BYTES / Math.max(1, r.undoBytes))} |`);
  md.push('', `Session: ${strokes} mixed strokes (a quarter 1 m dabs, a quarter 2 m dabs, a quarter 4 m drags, 17 % single voxels, 8 % 16 m fills), region files saved every 10 strokes (dirty files only), game save at 10 / 100 / ${strokes} strokes.`, '');
  md.push('| World | region MB | saves | files / save | KB written / save | chunks re-packed / save | save ms (median) | hash µs a chunk (KB) | hash through a decode µs |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of sessions) md.push(`| ${s.world} | ${f2(s.worldBytes / MB)} | ${s.saves} | ${f2(s.filesPerSave)} | ${kb(s.bytesPerSave)} | ${f1(s.chunksPerSave)} | ${f1(s.saveMs)} | ${f1(s.hashUs)} (${f2(s.hashKBPerChunk)}) | ${f1(s.hashDecodeUs)} |`);
  md.push('', '| World | strokes | save chunks (delta / image / uniform / air) | save KB | all-delta KB | B / stroke | build ms | write ms | read ms | open shipped files ms | hash + apply ms |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of sessions) for (const g of s.gameSave) md.push(`| ${s.world} | ${g.strokes} | ${g.chunks} (${g.delta} / ${g.image} / ${g.uniform} / ${g.air}) | ${kb(g.bytes)} | ${kb(g.allDeltaBytes)} | ${f1(g.bytesPerStroke)} | ${f1(g.buildMs)} | ${f1(g.writeMs)} | ${f1(g.readMs)} | ${f1(g.openMs)} | ${f1(g.applyMs)} |`);
  writeFileSync(join(out, 'edits.json'), JSON.stringify(report, null, 1));
  writeFileSync(join(out, 'edits.md'), md.join('\n') + '\n');
  console.log(md.join('\n'));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
