#!/usr/bin/env node
/**
 * Thirdlight workspace build.
 *
 * Builds the editor and play-preview bundles with the
 * pinned esbuild 0.28.2 and the pinned option set (`PINNED_OPTIONS`) — every
 * other option at its 0.28.2 default; no additional defines (except React's
 * production mode for the editor bundle — see BUNDLES), banners,
 * loaders, aliases, or externals. The editor bundle's .tsx files use
 * esbuild's default TSX loader (no option change).
 *
 * The EXPORT bundle is not built here: the exporter builds it at export time.
 * With no bundle entries present there is nothing to build — reported
 * honestly, exit 0.
 *
 * Bundle output files: dist/editor/main.js and dist/preview/preview.js —
 * served from the configured dist/editor + dist/preview static dirs.
 */

import esbuild from 'esbuild';
import { readdirSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

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

/** The pinned option set (normative — the same set for all three bundles). */
const PINNED_OPTIONS = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
  // three's DRACOLoader computes default decoder URLs from import.meta.url at
  // module load, which an IIFE does not have; the page URL stands in (the
  // loader port always sets the real decoder path).
  define: { 'import.meta.url': 'location.href' },
};

/**
 * Every `import … from 'three'` (the engine's and three's own
 * addons': GLTFLoader, KTX2Loader, SkeletonUtils, …) resolves to
 * `three/webgpu`, so a browser bundle (the editor page, Play and the export) links one three build — the WebGPURenderer
 * build (`three.core.js` + `three.webgpu.js`) — and not `three.module.js`
 * (the WebGLRenderer, its shader chunks and the WebGL PMREM, which nothing
 * uses since the switch-over). `three/webgpu` re-exports the whole core, so
 * every class is the same object; the seven names only `three` has
 * (WebGLRenderer, WebGLCubeRenderTarget, WebGLUtils, ShaderChunk, ShaderLib,
 * UniformsLib, UniformsUtils) are used by no bundled module.
 */
const THREE_WEBGPU_ONLY_PLUGIN = {
  name: 'thirdlight-three-webgpu-only',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, (a) => b.resolve('three/webgpu', { kind: a.kind, resolveDir: a.resolveDir }));
  },
};

/** The two bundles built by the workspace build script. */
const BUNDLES = [
  {
    name: 'editor',
    entry: 'packages/editor/src/index.tsx',
    out: 'dist/editor/main.js',
    // React's production build. Unminified, esbuild substitutes
    // process.env.NODE_ENV = "development", which ships React's development
    // build (dev-only checks and per-render performance logging, several times
    // slower on large trees). The editor bundle only; the play bundles carry no React.
    define: { 'process.env.NODE_ENV': '"production"' },
  },
  // The editor worker (scatter, graph diagnostics, PNG encoding,
  // the browser lightmap bake on an OffscreenCanvas), next to the editor page;
  // the page loads it on first use and runs every job inline without it.
  {
    name: 'editor-worker',
    entry: 'packages/editor/src/workers/editor-worker.ts',
    out: 'dist/editor/editor-worker.js',
  },
  // The block mesh worker (block chunks meshed off the page's frame), next
  // to the editor page and on the preview origin next to the simulation worker.
  {
    name: 'mesh-worker',
    entry: 'packages/editor/src/workers/mesh-worker.ts',
    out: 'dist/editor/mesh-worker.js',
  },
  {
    name: 'mesh-worker (preview)',
    entry: 'packages/editor/src/workers/mesh-worker.ts',
    out: 'dist/preview/mesh-worker.js',
  },
  // The `preview-m3` wrapper entry — the v3 play
  // bundle (served as `game.js` at the v3 locator). The `preview.js`
  // entry above stays byte-stable (its bundle scan depends on it).
  {
    name: 'preview-m3',
    entry: 'packages/editor/src/preview/preview-m3.ts',
    out: 'dist/preview/preview-m3.js',
  },
  // The Play preview's simulation worker (runtime + physics +
  // scripts off the page's main thread), served on the preview origin as
  // /sim-worker.js next to the decoders.
  {
    name: 'sim-worker',
    entry: 'packages/editor/src/preview/sim-worker.ts',
    out: 'dist/preview/sim-worker.js',
  },
  // The 3D physics backend (rapier3d, its WASM inlined), served on
  // the preview origin as /physics-3d.js and loaded — by the page or the
  // simulation worker — only for a project whose physics_dimension is 3.
  {
    name: 'physics-3d',
    entry: 'packages/editor/src/preview/physics-3d.ts',
    out: 'dist/preview/physics-3d.js',
  },
];

/**
 * three's Draco and Basis decoders (pinned three), served next to the
 * editor page and on the preview origin at /decoders/ for GLBs that use
 * KHR_draco_mesh_compression / KHR_texture_basisu.
 */
const DECODER_FILES = [
  ['draco/draco_wasm_wrapper.js', 'node_modules/three/examples/jsm/libs/draco/draco_wasm_wrapper.js'],
  ['draco/draco_decoder.wasm', 'node_modules/three/examples/jsm/libs/draco/draco_decoder.wasm'],
  ['basis/basis_transcoder.js', 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.js'],
  ['basis/basis_transcoder.wasm', 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm'],
];
for (const dir of ['dist/editor/decoders', 'dist/preview/decoders']) {
  for (const [rel, src] of DECODER_FILES) {
    const out = join(root, dir, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, readFileSync(join(root, src)));
  }
}
console.log('build: decoders: three Draco + Basis -> dist/editor/decoders, dist/preview/decoders');

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
  await esbuild.build({ entryPoints: [entry], outfile: out, ...PINNED_OPTIONS, define: { ...PINNED_OPTIONS.define, ...(b.define ?? {}) }, plugins: [THREE_WEBGPU_ONLY_PLUGIN] });
  console.log(`build: ${b.name}: ${b.entry} -> ${b.out}`);
  built += 1;
}

/**
 * The MCP stdio server (mcp-adapter): a Node
 * PROCESS (not a browser bundle), so it uses Node options, distinct from the
 * browser PINNED_OPTIONS above. The `@modelcontextprotocol/sdk` is bundled in
 * (packages: 'bundle') so `node dist/mcp-adapter/mcp.mjs` is self-contained;
 * the harness spawns it and speaks MCP over stdin/stdout.
 */
const MCP_ENTRY = 'packages/mcp-adapter/src/bin.ts';
const MCP_OUT = 'dist/mcp-adapter/mcp.mjs';
const PLAYTEST_ENTRY = 'packages/mcp-adapter/src/playtest.ts';
const PLAYTEST_OUT = 'dist/mcp-adapter/playtest.mjs';
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
  // The play-test runner as a library for the CLI (tools/playtest.mjs), the same code tl_playtest runs.
  const runnerOut = join(root, PLAYTEST_OUT);
  await esbuild.build({
    entryPoints: [join(root, PLAYTEST_ENTRY)],
    outfile: runnerOut,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'bundle',
    treeShaking: true,
    sourcemap: false,
    minify: false,
  });
  console.log(`build: mcp-adapter (play-test runner): ${PLAYTEST_ENTRY} -> ${PLAYTEST_OUT}`);
  built += 1;
} else {
  // Absent mcp-adapter source (e.g. the disposable build-tooling workspace) is
  // NOT counted in the browser-bundle built/skipped tally — it is a separate
  // optional Node artifact, not one of the browser bundles.
  console.log(`build: mcp-adapter: entry not present (${MCP_ENTRY}) — not built (packet 11)`);
}

/**
 * The backend deployment bundle (local deployment; decision 0001): a Node
 * PROCESS (not a browser bundle), the same Node options as the
 * mcp-adapter artifact above. The workspace packages + `ws` are bundled in
 * (packages: 'bundle') so `node dist/backend/backend.mjs` is self-contained;
 * the `node:*` builtins stay external (platform: 'node'). Absent backend
 * source is NOT counted in the browser-bundle tally (separate optional Node
 * artifact, not a browser bundle).
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
    // playwright-core (the headless editor) resolves its browser
    // registry relative to its own files: loaded from node_modules at runtime.
    // ktx2-encoder loads its Basis WASM next to its own file
    // (import.meta.url) and jpeg-js is CommonJS: both from node_modules; the
    // WebP decoder's WASM file is read from its package there too.
    external: ['esbuild', 'playwright-core', 'ktx2-encoder', 'jpeg-js', '@jsquash/webp'],
    banner: {
      js: 'import { createRequire as __tl_createRequire } from "node:module"; const require = __tl_createRequire(import.meta.url);',
    },
  });
  console.log(`build: backend (deployment bundle): ${BACKEND_ENTRY} -> ${BACKEND_OUT}`);
  built += 1;
  // The KTX2 encoder's worker thread, next to the backend bundle (backend.ts finds it there).
  await esbuild.build({
    entryPoints: [join(root, 'packages/backend/src/ktx2-worker.ts')],
    outfile: join(root, 'dist/backend/ktx2-worker.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'bundle',
    treeShaking: true,
    sourcemap: false,
    minify: false,
    external: ['ktx2-encoder', 'jpeg-js', '@jsquash/webp'],
  });
  console.log('build: backend (KTX2 encoder worker): packages/backend/src/ktx2-worker.ts -> dist/backend/ktx2-worker.mjs');
} else {
  console.log(`build: backend: entry not present (${BACKEND_ENTRY}) — not built (packet 13)`);
}
// The static authoring page (only when the editor entry exists).
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
if (built > 0) {
  // The build stamp the backend reports (`GET /api/v1/engine`, tl_inspect target="engine"):
  // when dist/ was built and from which commit, so a running backend can say it is older than dist/.
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const dirty = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'dist', 'build-info.json'),
    `${JSON.stringify({ builtAt: new Date().toISOString(), commit: git.status === 0 ? git.stdout.trim() : 'unknown', dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null, version: String(pkg.version) }, null, 2)}\n`,
  );
}
console.log(`build: done (${built} built, ${skipped} skipped).`);