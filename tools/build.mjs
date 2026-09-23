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
import { readdirSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

const root = process.cwd();

/** Emit dist/editor/index.html (static authoring page; loads ./main.js). */
function emitEditorPage() {
  const cssPath = join(root, 'packages/editor/src/editor.css');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  const html =
    '<!doctype html>\n<html>\n  <head>\n' +
    '    <meta charset="utf-8" />\n' +
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '    <title>Thirdlight Editor</title>\n' +
    '    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />\n' +
    '    <style>\n' + css + '\n    </style>\n' +
    '  </head>\n  <body>\n' +
    '    <div id="tl-root"></div>\n' +
    // The backend injects window.__thirdlightEditor here when serving the page.
    '    <script src="./main.js"></script>\n  </body>\n</html>\n';
  const out = join(root, 'dist/editor/index.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  // Static files next to the page (favicon, manifest): copied as-is.
  const pub = join(root, 'packages/editor/public');
  const copyTree = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const src = join(from, name);
      if (statSync(src).isDirectory()) copyTree(src, join(to, name));
      else writeFileSync(join(to, name), readFileSync(src));
    }
  };
  if (existsSync(pub)) copyTree(pub, dirname(out));
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
  // Packet 59 (delivery.md §3.2): the M3 preview wrapper entry — the v3 play
  // bundle (served as `game.js` at the v3 locator). The M2 `preview.js`
  // entry above stays byte-stable (binding M2 §5.4.1 bundle-scan evidence).
  {
    name: 'preview-m3',
    entry: 'packages/editor/src/preview/preview-m3.ts',
    out: 'dist/preview/preview-m3.js',
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

/**
 * The MCP stdio server (mcp-adapter, packet 11; decision 0001 §5): a Node
 * PROCESS (not a browser bundle), so it uses Node options, distinct from the
 * browser PINNED_OPTIONS above. The `@modelcontextprotocol/sdk` is bundled in
 * (packages: 'bundle') so `node dist/mcp-adapter/mcp.mjs` is self-contained;
 * the harness spawns it and speaks MCP over stdin/stdout.
 */
const MCP_ENTRY = 'packages/mcp-adapter/src/bin.ts';
const MCP_OUT = 'dist/mcp-adapter/mcp.mjs';
if (existsSync(join(root, MCP_ENTRY))) {
  const out = join(root, MCP_OUT);
  mkdirSync(dirname(out), { recursive: true });
  await esbuild.build({
    entryPoints: [join(root, MCP_ENTRY)],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'bundle',
    treeShaking: false,
    sourcemap: false,
    minify: false,
  });
  console.log(`build: mcp-adapter (stdio server): ${MCP_ENTRY} -> ${MCP_OUT}`);
  built += 1;
} else {
  // Absent mcp-adapter source (e.g. the disposable build-tooling workspace) is
  // NOT counted in the browser-bundle built/skipped tally — it is a separate
  // optional Node artifact, not one of the dependencies.md §4.2 browser bundles.
  console.log(`build: mcp-adapter: entry not present (${MCP_ENTRY}) — not built (packet 11)`);
}

/**
 * The backend deployment bundle (packet 13 local deployment; decision 0001
 * §6): a Node PROCESS (not a browser bundle), the same Node options as the
 * mcp-adapter artifact above. The workspace packages + `ws` are bundled in
 * (packages: 'bundle') so `node dist/backend/backend.mjs` is self-contained;
 * the `node:*` builtins stay external (platform: 'node'). Absent backend
 * source is NOT counted in the browser-bundle tally (separate optional Node
 * artifact, not a dependencies.md §4.2 browser bundle).
 */
const BACKEND_ENTRY = 'packages/backend/src/index.ts';
const BACKEND_OUT = 'dist/backend/backend.mjs';
if (existsSync(join(root, BACKEND_ENTRY))) {
  const out = join(root, BACKEND_OUT);
  mkdirSync(dirname(out), { recursive: true });
  await esbuild.build({
    entryPoints: [join(root, BACKEND_ENTRY)],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'bundle',
    treeShaking: false,
    sourcemap: false,
    minify: false,
    // esbuild (the exporter's bundler dependency) must stay EXTERNAL: its
    // JS API dynamically resolves the platform binary relative to its own
    // file location (__filename), which a bundled ESM context lacks
    // ("__filename is not defined" at export time). From the deployment
    // checkout it resolves from node_modules as usual. The artifact is
    // therefore run from the engine checkout (documented in the
    // deployment docs; the mcp-adapter bundle stays fully self-contained).
    external: ['esbuild'],
    banner: {
      js: 'import { createRequire as __tl_createRequire } from "node:module"; const require = __tl_createRequire(import.meta.url);',
    },
  });
  console.log(`build: backend (deployment bundle): ${BACKEND_ENTRY} -> ${BACKEND_OUT}`);
  built += 1;
} else {
  console.log(`build: backend: entry not present (${BACKEND_ENTRY}) — not built (packet 13)`);
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