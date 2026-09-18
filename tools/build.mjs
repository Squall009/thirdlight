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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

const root = process.cwd();

/**
 * The editor page config (sessions.md §13.2 analogue for the authoring page).
 * `authoringOrigin` + the API base are derived at RUNTIME by the editor from
 * `location.origin` (the editor is same-origin with the backend); the build
 * injects `projectId`, `previewOrigin`, and the project-scoped `authoringToken`
 * (deployment values — read from env so no secret is hardcoded in source).
 */
const editorConfig = {
  v: 1,
  projectId: process.env.THIRDLIGHT_PROJECT_ID ?? 'demo-0001',
  previewOrigin: (process.env.THIRDLIGHT_PREVIEW_ORIGIN ?? 'http://127.0.0.1:8502').replace(/\/$/, ''),
  authoringToken: process.env.THIRDLIGHT_EDITOR_TOKEN ?? '',
};

/** Emit dist/editor/index.html (static authoring page; loads ./main.js). */
function emitEditorPage() {
  const cssPath = join(root, 'packages/editor/src/editor.css');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  const configJson = JSON.stringify(editorConfig).replace(/</g, '\\u003c');
  const html =
    '<!doctype html>\n<html>\n  <head>\n' +
    '    <meta charset="utf-8" />\n' +
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '    <title>Thirdlight Editor</title>\n' +
    '    <style>\n' + css + '\n    </style>\n' +
    '  </head>\n  <body>\n' +
    '    <div id="tl-root"></div>\n' +
    `    <script>window.__thirdlightEditor = ${configJson};</script>\n` +
    '    <script src="./main.js"></script>\n  </body>\n</html>\n';
  const out = join(root, 'dist/editor/index.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`build: editor page: -> ${join('dist/editor/index.html')}`);
}

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
// The static authoring page (only when the editor entry exists — packet 10).
if (existsSync(join(root, 'packages/editor/src/index.tsx'))) {
  emitEditorPage();
}
if (built === 0) {
  console.log(
    'build: no bundle entries present yet — nothing to build (editor/preview ' +
      'entries land in packet 10; the export bundle is built by the exporter in ' +
      'packet 12 — dependencies.md §4.2).',
  );
}
console.log(`build: done (${built} built, ${skipped} skipped).`);