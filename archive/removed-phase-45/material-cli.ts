/**
 * The material id width report (`node tools/voxel-bench/run.mjs material`):
 * what the stored material id's width costs on every test world, so the id
 * space is chosen by its numbers: 16 bits (65,535 ids, before), 24 bits at
 * rest (the 23-bit id in the 32-bit record value, now) and a full 32-bit
 * field.
 *
 * - At rest: every stored chunk's world bytes with the material plane at 2,
 *   3 and 4 bytes an entry (the uniform body likewise), each through zstd
 *   level 3 as region files store them. Uniform chunks live in the region
 *   table either way, so they cost nothing more.
 * - In memory: palette entries resident (a 48-bit record value needs 8
 *   bytes an entry instead of 4) against the store's whole memory.
 * - Per changed cell: a cell delta (undo, saves) is 7 bytes a cell today and
 *   9 with a 32-bit material; aprons and the assembly block carry a record
 *   value per cell (4 bytes, 8 when it no longer fits 32 bits).
 *
 * Writes material.md and material.json to --out (default
 * ~/.cache/thirdlight-phase45/work/45.7d/results).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { chunkGrid, chunkOfKey, DELTA_CELL_BYTES, type ChunkCoord } from '@thirdlight/voxel';
import { loadArea, pickStore } from './regions';
import type { TestGrid } from './world-kit';
import { allWorlds } from './worlds';

const grid = chunkGrid(32);
const arg = (name: string, def: string): string => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : def);
const zstd = (b: Uint8Array): number => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }).length;
const log = (s: string): void => console.error(`[material ${new Date().toISOString().slice(11, 19)}] ${s}`);

/** Bytes of a material at rest now. */
const NOW = 3;

/**
 * A chunk's world bytes with the material plane at `width` bytes an entry
 * instead of 3 (low bytes kept, high bytes zero; the test worlds' ids fit 16
 * bits). The header's CRC is not recomputed: only sizes are measured.
 */
function atWidth(b: Uint8Array, width: number): Uint8Array {
  const body = (b[3]! >>> 5) & 3;
  const at = body === 0 ? 8 : 10;
  const count = body === 0 ? 1 : (b[8]! | (b[9]! << 8)) + 1;
  const out = new Uint8Array(b.length + (width - NOW) * count);
  out.set(b.subarray(0, at));
  for (let e = 0; e < count; e++) out.set(b.subarray(at + NOW * e, at + NOW * e + Math.min(NOW, width)), at + width * e);
  out.set(b.subarray(at + NOW * count), at + width * count);
  return out;
}

/** 512 m super-tiles covering a grid (one store at a time, as the region report loads them). */
function superTiles(g: TestGrid): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let x = Math.floor(g.bounds.min[0] / 1024); x < Math.ceil(g.bounds.max[0] / 1024); x++) for (let z = Math.floor(g.bounds.min[2] / 1024); z < Math.ceil(g.bounds.max[2] / 1024); z++) out.push([x, z]);
  return out;
}

interface Row {
  world: string;
  stored: number;
  uniform: number;
  raw16: number;
  raw24: number;
  raw32: number;
  zstd16: number;
  zstd24: number;
  zstd32: number;
  entries: number;
  memory: number;
}

function main(): void {
  const out = arg('--out', join(homedir(), '.cache', 'thirdlight-phase45', 'work', '45.7d', 'results'));
  mkdirSync(out, { recursive: true });
  const rows: Row[] = [];
  for (const world of allWorlds()) {
    const g = world.grids[0]!;
    const row: Row = { world: world.name, stored: 0, uniform: 0, raw16: 0, raw24: 0, raw32: 0, zstd16: 0, zstd24: 0, zstd32: 0, entries: 0, memory: 0 };
    const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    for (const [sx, sz] of superTiles(g)) {
      const store = pickStore(grid);
      loadArea(g, store, sx * 1024, sz * 1024, (sx + 1) * 1024, (sz + 1) * 1024);
      row.memory += store.memoryBytes();
      for (const key of store.chunkKeys()) {
        chunkOfKey(grid, key, c);
        const b = store.encodeChunk(c.cx, c.cy, c.cz)!;
        if (((b[3]! >>> 5) & 3) === 0) {
          row.uniform++;
          continue;
        }
        row.stored++;
        row.entries += (b[8]! | (b[9]! << 8)) + 1;
        const narrow = atWidth(b, 2);
        const wide = atWidth(b, 4);
        row.raw16 += narrow.length;
        row.raw24 += b.length;
        row.raw32 += wide.length;
        row.zstd16 += zstd(narrow);
        row.zstd24 += zstd(b);
        row.zstd32 += zstd(wide);
      }
      log(`${world.name} tile ${sx},${sz}: ${row.stored} stored chunks so far`);
    }
    rows.push(row);
  }
  const pct = (a: number, b: number): string => `${(((b - a) / a) * 100).toFixed(2)} %`;
  const lines = [
    '# Material id width at rest: u16 (before) vs u24 (now) vs u32',
    '',
    `Host load ${loadavg().map((l) => l.toFixed(2)).join(' ')}; zstd level 3 per stored chunk; uniform chunks are table entries (no change).`,
    '',
    '| World | Stored chunks | Uniform | zstd MB u16 | u24 (change) | u32 (change) | Raw MB u16 → u24 → u32 | Palette entries | 32-bit record + 4 B an entry / store memory |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.world} | ${r.stored.toLocaleString('en-US')} | ${r.uniform.toLocaleString('en-US')} | ${(r.zstd16 / 1e6).toFixed(3)} | ${(r.zstd24 / 1e6).toFixed(3)} (${pct(r.zstd16, r.zstd24)}) | ${(r.zstd32 / 1e6).toFixed(3)} (${pct(r.zstd16, r.zstd32)}) | ${(r.raw16 / 1e6).toFixed(2)} → ${(r.raw24 / 1e6).toFixed(2)} → ${(r.raw32 / 1e6).toFixed(2)} | ${r.entries.toLocaleString('en-US')} | ${((r.entries * 4) / 1e6).toFixed(2)} MB of ${(r.memory / 1e6).toFixed(1)} MB (${((100 * r.entries * 4) / r.memory).toFixed(2)} %) |`,
    ),
    '',
    `u24 is the 23-bit id in the 32-bit record value: nothing changes per cell or in memory. A full 32-bit field makes the record value 48 bits: a cell delta ${DELTA_CELL_BYTES} → ${DELTA_CELL_BYTES + 2} B a cell (+${(200 / DELTA_CELL_BYTES).toFixed(0)} %), a record value per apron or assembly-block cell 4 → 8 B, and 4 B more per resident palette entry (last column).`,
  ];
  const md = lines.join('\n') + '\n';
  writeFileSync(join(out, 'material.md'), md);
  writeFileSync(join(out, 'material.json'), JSON.stringify(rows, null, 1));
  console.log(md);
}

main();
