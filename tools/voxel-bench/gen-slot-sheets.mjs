#!/usr/bin/env node
/**
 * Write the kit authoring package's generated files (slot-sheets.ts): the
 * slot contract the Blender templates read and one manual page a slot.
 *
 *   node tools/voxel-bench/gen-slot-sheets.mjs           # write them
 *   node tools/voxel-bench/gen-slot-sheets.mjs --check   # exit 1 naming the files that differ
 *
 * Small and memory-light (it reads the catalogue and three small GLBs), so it
 * runs without the voxel bench's memory cap. Bundles slot-sheets.ts with
 * esbuild into dist/voxel-bench/ and runs it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(REPO, 'dist', 'voxel-bench', 'slot-sheets.mjs');
mkdirSync(dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [join(REPO, 'tools', 'voxel-bench', 'slot-sheets.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: out,
  logLevel: 'warning',
  // import.meta.dirname must name the source folder, not dist/.
  define: { 'import.meta.dirname': JSON.stringify(join(REPO, 'tools', 'voxel-bench')) },
});
const { slotSheetFiles } = await import(pathToFileURL(out).href);
const check = process.argv.includes('--check');
const stale = [];
for (const [rel, text] of slotSheetFiles(REPO)) {
  const file = join(REPO, rel);
  const old = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (old === text) continue;
  stale.push(rel);
  if (!check) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}
if (check && stale.length > 0) {
  console.error(`gen-slot-sheets: stale (run node tools/voxel-bench/gen-slot-sheets.mjs):\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
console.log(check ? 'gen-slot-sheets: up to date' : `gen-slot-sheets: ${stale.length} files written`);
