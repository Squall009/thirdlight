/**
 * The chunk-edge cost report (`node tools/voxel-bench/run.mjs costs`): the
 * apron of width R per job and the chunks an edit rebuilds (edge-costs.ts),
 * at both edges.
 *
 * Apron bytes are dense records (5 bytes a cell, the provisional record),
 * the upper bound on a strip sent as plain cells; their worker round trip
 * is measured (copied and transferred) with the harness's echo worker.
 * Rebuilds are counted over random stroke centres (a seeded Monte Carlo).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apronCells, meanChunksRebuilt } from './edge-costs';
import { measureTransfer } from './transfer';

const EDGES = [16, 32] as const;
const RADII = [1, 2, 4] as const;
/** Stroke radii in cells (0.5, 1, 2 and 4 m). */
const STROKES = [1, 2, 4, 8] as const;
const RECORD_BYTES = 5;

async function main(): Promise<void> {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : join(homedir(), '.cache', 'thirdlight-voxel-bench', 'costs');
  mkdirSync(out, { recursive: true });
  const lines: string[] = ['# Chunk edge costs: aprons and rebuilds', ''];
  lines.push('| Edge | R | Apron cells | Apron / chunk | Apron KB (5 B/cell) | Job KB (chunk + apron) | Apron copy / move µs |', '|---|---|---|---|---|---|---|');
  const rows: unknown[] = [];
  for (const edge of EDGES) {
    for (const r of RADII) {
      const cells = apronCells(edge, r);
      const bytes = cells * RECORD_BYTES;
      const t = await measureTransfer(Array.from({ length: 32 }, () => new Uint8Array(bytes)));
      rows.push({ edge, r, cells, bytes, copyUs: t.copyUsPerChunk, moveUs: t.transferUsPerChunk });
      lines.push(`| ${edge} | ${r} | ${cells.toLocaleString('en-US')} | ${((100 * cells) / edge ** 3).toFixed(0)} % | ${(bytes / 1000).toFixed(1)} | ${(((edge + 2 * r) ** 3 * RECORD_BYTES) / 1000).toFixed(1)} | ${t.copyUsPerChunk.toFixed(1)} / ${t.transferUsPerChunk.toFixed(1)} |`);
    }
  }
  lines.push('', '| Stroke radius | R | Edge | Chunks rebuilt (mean) | Cells re-meshed (mean) | Cells read incl. aprons (mean) |', '|---|---|---|---|---|---|');
  const rebuilds: unknown[] = [];
  for (const s of STROKES) {
    for (const r of RADII) {
      for (const edge of EDGES) {
        const chunks = meanChunksRebuilt(edge, s, r);
        rebuilds.push({ strokeCells: s, r, edge, chunks });
        lines.push(`| ${s / 2} m | ${r} | ${edge} | ${chunks.toFixed(2)} | ${Math.round(chunks * edge ** 3).toLocaleString('en-US')} | ${Math.round(chunks * (edge + 2 * r) ** 3).toLocaleString('en-US')} |`);
      }
    }
  }
  const md = lines.join('\n') + '\n';
  writeFileSync(join(out, 'costs.md'), md);
  writeFileSync(join(out, 'costs.json'), JSON.stringify({ aprons: rows, rebuilds }, null, 1));
  console.log(md);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
