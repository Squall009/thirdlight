#!/usr/bin/env node
/**
 * Thirdlight workspace build (dependencies.md §4.2, §7; export.md §5.3).
 *
 * Builds the editor and play-preview bundles (dependencies.md §4.2) with the
 * pinned esbuild 0.28.2 and the export.md §5.3 pinned option set — every
 * other option at its 0.28.2 default; no additional defines, banners,
 * loaders, aliases, or externals. The editor bundle's .tsx files use
 * esbuild's default TSX loader (decision 0001 §10 — no option change).
 *
 * The EXPORT bundle is not built here: the exporter builds it at export time
 * (packet 12; export.md §4/§5.1). With no bundle entries present yet (packet
 * 04 state) there is nothing to build — reported honestly, exit 0.
 *
 * Bundle output files: dist/editor/main.js and dist/preview/preview.js —
 * served from the configured dist/editor + dist/preview static dirs
 * (sessions.md §13.7); the file names are the packet 04 build choice.
 */

import esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

const root = process.cwd();

/** export.md §5.3 pinned option set (normative — the same set for all three bundles). */
const PINNED_OPTIONS = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
};

/** dependencies.md §4.2 — the two bundles built by the workspace build script. */
const BUNDLES = [
  {
    name: 'editor',
    entry: 'packages/editor/src/index.tsx',
    out: 'dist/editor/main.js',
  },
  {
    name: 'preview',
    entry: 'packages/editor/src/preview/preview-bootstrap.ts',
    out: 'dist/preview/preview.js',
  },
];

let built = 0;
let skipped = 0;
for (const b of BUNDLES) {
  const entry = join(root, b.entry);
  if (!existsSync(entry)) {
    console.log(`build: ${b.name}: entry not present (${b.entry}) — skipped (packet 10)`);
    skipped += 1;
    continue;
  }
  const out = join(root, b.out);
  mkdirSync(dirname(out), { recursive: true });
  await esbuild.build({ entryPoints: [entry], outfile: out, ...PINNED_OPTIONS });
  console.log(`build: ${b.name}: ${b.entry} -> ${b.out}`);
  built += 1;
}
if (built === 0) {
  console.log(
    'build: no bundle entries present yet — nothing to build (editor/preview ' +
      'entries land in packet 10; the export bundle is built by the exporter in ' +
      'packet 12 — dependencies.md §4.2).',
  );
}
console.log(`build: done (${built} built, ${skipped} skipped).`);