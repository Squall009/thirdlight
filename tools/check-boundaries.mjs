#!/usr/bin/env node
/**
 * Thirdlight boundary check 1 — static import graph.
 *
 * Scans the .ts/.tsx sources of every implemented workspace package
 * (packages/<name>/package.json) and checks every
 * `import` / `export … from` / dynamic `import()` specifier against the
 * normative edge rules:
 *
 *   allowed edges          node-side allowed import edges (exact table),
 *                          including the types-only edge qualifiers: a
 *                          value import, value re-export, or dynamic
 *                          `import()` of a types-only target fails
 *                          (`types-only-edge`). The qualifiers per the
 *                          table text: editor → project-model/commands
 *                          ("(types)"), backend → project-model
 *                          ("(types only — the snapshot document)"),
 *                          exporter → workspace ("types only — the service
 *                          instance is injected"), protocol → project-model/commands
 *                          ("(types; pure code, no I/O)").
 *   forbidden edges        forbidden edges (any plane) — `runtime → three`,
 *                          `runtime → Node builtins`, `editor → workspace |
 *                          backend`, `backend → editor`, `mcp-adapter → backend`
 *                          (the `/services` subpath only), `mcp-adapter →
 *                          workspace | editor`, `exporter → backend | editor`,
 *                          relative imports into another package's internals
 *   public surface         the public surface is the package.json `exports`
 *                          map only — a specifier reaching a non-exported
 *                          subpath fails
 *   implemented units      units are created only when implemented — importing
 *                          a not-yet-implemented `@thirdlight/*` unit fails
 *   declared deps          a package must not declare a dependency on a
 *                          not-yet-implemented workspace package (checked for
 *                          every package manifest AND the root manifest)
 *   React scope            React is scoped to `editor` only — checked for
 *                          source imports AND declared dependencies (incl. the
 *                          React type packages, in every manifest including
 *                          the root)
 *   web frameworks         the forbidden web-framework list applies to imports
 *                          and to declared dependencies
 *   global services        no hidden global services — `globalThis`
 *                          assignments are flagged for review
 *
 * Test-file policy (narrow): designated package test files
 * (`.test.ts(x)` / `.spec.ts(x)`) may import the approved test runner
 * `vitest` (any subpath); every other rule applies to
 * test files unchanged, and a production file importing `vitest` fails
 * (`forbidden-external`). Tests are NOT exempt from boundary checking.
 *
 * Check 2 (`checkVocabulary`): no genre vocabulary in
 * every `packages/<name>/src/` file (the words and the reviewed allowlist are below).
 *
 * Plain Node using the already-pinned TypeScript compiler API; no new
 * dependency. Any violation ⇒ non-zero exit, `file:line: [rule] message`.
 *
 * Extraction uses the TS/TSX AST, preserving UTF-16 offsets and respecting
 * comments, regex literals, JSX, templates, escaped strings, and contextual
 * `type` bindings. Import/export declaration and binding isTypeOnly flags
 * distinguish erased type edges from executable ones. Import-type queries
 * are type-only; dynamic import calls are executable. Nonliteral dynamic
 * targets fail closed because their dependency boundary cannot be checked.
 * Production-to-test local imports/re-exports and public test exports fail;
 * test files retain all other boundary rules.
 *
 * Bounds: `require()` / `import = require()` remain outside the contract's
 * three scanned forms; the exports maps are flat (no wildcard patterns).
 * The globalThis assignment review scan still runs on raw source (including
 * commented-out assignments). These checks are not a hostile-code sandbox.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import ts from 'typescript'; // already pinned tooling

export const WORKSPACE_SCOPE = '@thirdlight/';

/** The unit list. */
export const UNITS = [
  'project-model',
  'commands',
  'workspace',
  'runtime',
  'three-adapter',
  'protocol',
  'backend',
  'editor',
  'mcp-adapter',
  'exporter',
  'asset-pipeline',
  'input',
  'physics-rapier',
  'character',
  'behavior-build',
  // The CPU reference semantics of visual-effect graphs.
  'effects',
  // The game host and its browser audio owner (the `.` entry).
  'game-host',
];

/**
 * Node-side allowed import edges (exact).
 * `packages`: allowed `@thirdlight/*` targets. `external`: allowed
 * non-workspace packages. `node`: allowed Node builtins. `subpaths`:
 * per-target subpath restriction (mcp-adapter → backend: `services` only).
 * `externalSubpaths`: the same restriction for an approved external package
 * (three-adapter may import only the `three` root and its GLTFLoader subpath;
 * any other `three/examples/jsm/...` module is a reviewed addition).
 * `typesOnly`: allowed targets whose edge the
 * allowed-edge table qualifies as types only — a value import of such a target
 * fails (`types-only-edge`). `valueSubpaths`: named subpaths of a types-only
 * target that may be value-imported (pure code that cannot mutate a project).
 */
export const NODE_SIDE_ALLOWED = {
  'project-model': { packages: [], external: [], node: [] },
  commands: { packages: ['project-model'], external: [], node: [] },
  workspace: {
    packages: ['project-model', 'commands', 'asset-pipeline', 'behavior-build'],
    external: [],
    node: ['fs', 'path', 'crypto', 'os'],
    // The compiler/inspector instances are
    // injected by the backend — workspace holds only their types.
    typesOnly: { 'asset-pipeline': true, 'behavior-build': true },
  },
  runtime: { packages: ['project-model'], external: [], node: [] },
  // The visual-effect evaluator (CPU reference semantics of the
  // `effect` graph kind). Runtime-safe and pure like the runtime: the kind
  // data and graph helpers of project-model only; no three.js, no Node
  // built-ins. Deliberately NOT inside the runtime: effects are visual only
  // and never part of the deterministic simulation.
  effects: { packages: ['project-model'], external: [], node: [] },
  'three-adapter': {
    // + effects — the visual-effect executors (WebGPU compute and
    // the CPU fallback) compile and step effect graphs with the shared
    // reference semantics of @thirdlight/effects (runtime-safe, pure).
    packages: ['runtime', 'effects'],
    external: ['three', '@types/three'],
    // Only the pinned three package's own GLTFLoader subpath is approved;
    // the empty subpath '' is the bare `three` specifier. For compressed
    // GLBs (owner go-ahead): three's own Draco/KTX2 loaders and meshopt
    // decoder, used only by the gltf-loader port.
    externalSubpaths: {
      three: [
        '',
        'examples/jsm/loaders/GLTFLoader.js',
        'examples/jsm/loaders/DRACOLoader.js',
        'examples/jsm/loaders/KTX2Loader.js',
        'examples/jsm/libs/meshopt_decoder.module.js',
        // Skinned meshes need SkeletonUtils.clone so each
        // instance gets its own skeleton (gltf-loader port only).
        'examples/jsm/utils/SkeletonUtils.js',
        // renderer-factory.ts, environment.ts: three's WebGPURenderer
        // (WebGPU with its WebGL 2 backend) and its node PMREM generator; TSL
        // for the node materials and post. Part of the
        // pinned three package, not examples; the export scan record
        // (exporter/src/scan.ts) is measured with them.
        'webgpu',
        'tsl',
        // environment-nodes.ts: the physical sky and the post
        // stack on WebGPURenderer — three's TSL sky mesh and node passes
        // (GTAO, depth of field, bloom, SMAA, FXAA) inside a RenderPipeline.
        'examples/jsm/objects/SkyMesh.js',
        'examples/jsm/tsl/display/GTAONode.js',
        'examples/jsm/tsl/display/DepthOfFieldNode.js',
        'examples/jsm/tsl/display/BloomNode.js',
        'examples/jsm/tsl/display/SMAANode.js',
        'examples/jsm/tsl/display/FXAANode.js',
      ],
    },
    node: [],
  },
  // The local composition. runtime (the accepted instantiateRuntime/
  // createSimulationRegistry/registerSimulationModule values + BUILTIN_MODULES
  // for the simulation registry + types), input (types only — the injected
  // owner's MenuSample seam; the attachBrowserInput VALUE edge is permission,
  // not obligation: the owner is injected). three-adapter is NOT imported
  // (the host defines the structural HostRenderAdapter surface; the adapter
  // instance is injected) — its types-only allowance stays unexercised.
  // The concrete physics-rapier port, three canvas and audio context are
  // injected (no value edge to them). No character edges — the
  // simulation module specs are injected by the composition entries (the
  // preview's module-specs.ts, the export's generated thirdlight:export-modules).
  'game-host': {
    packages: ['runtime', 'input'],
    external: [],
    node: [],
    typesOnly: { input: true },
  },
  // "project-model, commands (types; pure code, no I/O)".
  protocol: {
    packages: ['project-model', 'commands'],
    external: [],
    node: [],
    typesOnly: { 'project-model': true, commands: true },
    // The model's limits (plain constants) are defined once in project-model.
    valueSubpaths: { 'project-model': ['limits'] },
  },
  // "… project-model (types only — the snapshot document)".
  backend: {
    // + three-adapter — the backend runs `materialGraphProblems`
    // (a graph material built to TSL nodes without a renderer) on load and
    // after each change, the same check as the editor's Problems tab.
    packages: ['protocol', 'workspace', 'exporter', 'project-model', 'asset-pipeline', 'behavior-build', 'three-adapter'],
    // playwright-core: the headless editor for MCP play (headless.ts).
    // ktx2-encoder + jpeg-js + @jsquash/webp — KTX2 encoding on import.
    external: ['ws', 'playwright-core', 'ktx2-encoder', 'jpeg-js', '@jsquash/webp'],
    // child_process: FBX import runs headless Blender (fbx.ts; owner go-ahead).
    // Nothing else in the backend starts processes.
    // worker_threads (the KTX2 encoder off the event loop) and
    // zlib (the PNG decoder's inflate).
    node: ['http', 'fs', 'path', 'crypto', 'child_process', 'worker_threads', 'zlib'],
    typesOnly: { 'project-model': true },
    // The shared PNG decoder (pure; texture sources for KTX2 encoding and
    // packing) and the model's limits are the project-model values the
    // backend runs.
    valueSubpaths: { 'project-model': ['png', 'limits'] },
  },
  // "imports workspace types only"; the
  // project-model/protocol value edges are not injection-only service edges.
  exporter: {
    packages: ['project-model', 'protocol', 'workspace'],
    external: ['esbuild'],
    node: [],
    typesOnly: { workspace: true },
  },
  // "asset-pipeline | project-model (types: ImportProposal/recipe/
  // metrics shapes) — pure, no three and no GLTFLoader (it inspects bytes
  // itself)". The proposal/recipe/metrics shapes the importer shares with the
  // model are types only (the importer parses its own JSON and hashes bytes).
  'asset-pipeline': {
    packages: ['project-model'],
    external: [],
    node: [],
    typesOnly: { 'project-model': true },
    // The importer checks the model's own limits (plain constants) and decodes
    // EXT_meshopt_compression with the model's decoder (pure; the build reads
    // a model's collision parts with the same one).
    valueSubpaths: { 'project-model': ['limits', 'meshopt'] },
  },
  // "input | runtime (types)" — the pure mapping plus one browser
  // attachment entry; it knows runtime types only (no value edge, so the
  // types-only qualifier applies to the whole package).
  input: {
    packages: ['runtime'],
    external: [],
    node: [],
    typesOnly: { runtime: true },
  },
  // "physics-rapier | runtime (types) + @dimforge/rapier2d-compat
  // (the approved pin)". The adapter never imports a concrete runtime
  // value (the runtime owns stepping and hands it only the port shape), and it
  // may not reach editor/backend/protocol/workspace/three (of project-model,
  // only its types and the limits subpath).
  // + @dimforge/rapier3d-compat for the `./3d` subpath.
  'physics-rapier': {
    // + project-model's limits subpath only: the ports re-check the model's
    // collider shape limits, which are defined once there.
    packages: ['runtime', 'project-model'],
    external: ['@dimforge/rapier2d-compat', '@dimforge/rapier3d-compat'],
    node: [],
    typesOnly: { runtime: true, 'project-model': true },
    valueSubpaths: { 'project-model': ['limits'] },
  },
  // The character package: the controller algorithm over the injected
  // input/physics ports; it may not reach the concrete physics adapter, the
  // input package, three.js, authoring, backend or Node built-ins.
  character: {
    packages: ['runtime'],
    external: [],
    node: [],
    typesOnly: { runtime: true },
  },
  // "behavior-build | project-model (types +
  // parseSourceGraphContainer/validateDeclaration), esbuild (the pinned
  // parser)". Pure and Node-side: no Node builtins, no browser edge, and
  // never a value edge into runtime/three/editor/backend/workspace/commands.
  'behavior-build': {
    packages: ['project-model'],
    external: ['esbuild'],
    node: [],
  },
  'mcp-adapter': {
    // + project-model's limits subpath only: the tool descriptions state the
    // model's limits from their one definition.
    packages: ['protocol', 'backend', 'project-model'],
    external: ['@modelcontextprotocol/sdk'],
    node: [],
    subpaths: { backend: ['services'], 'project-model': ['limits'] },
    typesOnly: { 'project-model': true },
    valueSubpaths: { 'project-model': ['limits'] },
  },
  // "… project-model (types), commands (types) …".
  editor: {
    // + game-host, its `./ui-layer` subpath only — the UI
    // document preview draws with the very layer Play and exports use.
    packages: ['protocol', 'runtime', 'three-adapter', 'project-model', 'commands', 'game-host'],
    // + its `./dialogue-preview` subpath — the dialogue tab's
    // previewer plays a conversation with the runtime's runner, the host's UI
    // layer and audio owner (the same code as Play), outside Play.
    subpaths: { 'game-host': ['ui-layer', 'dialogue-preview'] },
    external: [
      'three',
      'react',
      'react-dom',
      '@types/react',
      '@types/react-dom',
      '@types/three',
      // The script editor (CodeMirror 6). Editor UI only — the
      // preview/export bundle graphs never include it.
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/commands',
      '@codemirror/autocomplete',
      '@codemirror/lint',
      '@codemirror/search',
      '@codemirror/lang-javascript',
      '@lezer/common',
      '@lezer/highlight',
      '@lezer/lr',
      '@lezer/javascript',
    ],
    node: [],
    typesOnly: { 'project-model': true, commands: true },
    // The model's limits (plain constants): the editor checks the same bounds
    // before it sends a command.
    valueSubpaths: { 'project-model': ['limits'] },
  },
};

/**
 * Forbidden web frameworks (no web framework anywhere — node:http only).
 */
export const FORBIDDEN_WEB_FRAMEWORKS = new Set([
  'express',
  'fastify',
  'koa',
  'hapi',
  'next',
  'nuxt',
  'vue',
  'svelte',
  'preact',
  'angular',
]);

/**
 * The browser-bundle entry files live in their app
 * packages ("one source for the bridge wiring"); their import edges are the
 * bundle graph, not the node-side table. The TRANSITIVE graph is
 * enforced by the esbuild `--metafile` check (the export instance runs at
 * export time); here the entry file's direct edges are checked against the
 * bundle's exact allowed graph.
 */
const BUNDLE_ENTRY_EDGES = {
  'packages/exporter/src/export-bootstrap.ts': {
    packages: ['runtime', 'three-adapter', 'project-model'],
    external: ['three'],
    node: [],
  },
  // The export bundle: `export-bootstrap-m2.ts`'s
  // direct edges are the runtime-bundle graph (runtime/three-adapter/
  // project-model/input/character/physics-rapier + three), plus the two
  // per-snapshot virtual modules the export build generates in memory
  // (`thirdlight:export-artifacts`, `thirdlight:export-behaviors` — they have
  // no package; the esbuild metafile check allows exactly those two keys).
  'packages/exporter/src/export-bootstrap-m2.ts': {
    packages: ['runtime', 'three-adapter', 'project-model', 'input', 'character', 'physics-rapier'],
    external: ['three', 'thirdlight:export-artifacts', 'thirdlight:export-behaviors'],
    node: [],
  },
  // The shared composition module is imported by `export-bootstrap-m2.ts`
  // and also runs in Node for the play/export trace evidence; it is
  // browser-safe and imports runtime + character only.
  'packages/exporter/src/export-composition.ts': {
    packages: ['runtime', 'character'],
    external: [],
    node: [],
  },
  // The v3 export bundle: `export-bootstrap-m3.ts` starts the game with the
  // shared game page (`game-host` and its `./game-page` subpath) and reads
  // the manifest's scene and catalog through project-model's hash. Its only
  // generated module is `thirdlight:export-modules` (the module specs the
  // manifest names; the esbuild metafile check allows exactly that key). The
  // bundle names no artifact path: files are read by the paths their rows give.
  'packages/exporter/src/export-bootstrap-m3.ts': {
    packages: ['runtime', 'project-model', 'game-host'],
    external: ['thirdlight:export-modules'],
    node: [],
  },
  // The game page (`game-host/game-page`): the composition Play's page and an
  // exported game's page share. It is browser bundle code, linked only into
  // those two bundles (the game-host root stays free of three and physics):
  // the scene adapter and its GLTFLoader port, the physics port, the browser
  // input, the model's pure helpers. Behavior outputs load from the URLs the
  // page gives it (manifest-declared paths).
  'packages/game-host/src/game-page.ts': {
    packages: ['runtime', 'three-adapter', 'project-model', 'input', 'physics-rapier'],
    external: [],
    node: [],
    computedDynamicImport: 'locator',
  },
  // The exported game's simulation worker entry (`js/sim-worker.js`):
  // the game host's worker core + physics-rapier (its WASM inlined). It
  // imports the project's compiled scripts by the absolute URLs the page
  // resolves from manifest-declared `behaviors/<digest>.js` paths.
  'packages/exporter/src/export-sim-worker.ts': {
    packages: ['physics-rapier', 'game-host'],
    // The generated module specs the manifest names.
    external: ['thirdlight:export-modules'],
    node: [],
    computedDynamicImport: 'locator',
  },
  // The Play preview's simulation worker entry (`dist/preview/sim-worker.js`,
  // served on the preview origin): the same two edges; scripts load from the locator.
  'packages/editor/src/preview/sim-worker.ts': {
    packages: ['physics-rapier', 'game-host'],
    external: [],
    node: [],
    computedDynamicImport: 'locator',
  },
  // The host's unit test composes like an entry (it injects the
  // platformer specs its game snapshot's modules name).
  'packages/game-host/src/host.test.ts': {
    packages: ['runtime', 'input', 'character'],
    external: [],
    node: [],
    typesOnly: { input: true },
  },
  // The preview's simulation module spec table (the composition
  // registers module specs; the game host imports no module package).
  'packages/editor/src/preview/module-specs.ts': {
    packages: ['runtime', 'character'],
    external: [],
    node: [],
  },
  // The 3D physics backend entries (`js/physics-3d.js` of a 3D
  // project's export; `dist/preview/physics-3d.js` on the preview origin):
  // physics-rapier's `./3d` port and the dependency-free hand-over module of
  // game-host (`./physics-3d-global`) only.
  'packages/exporter/src/export-physics-3d.ts': {
    packages: ['physics-rapier', 'game-host'],
    external: [],
    node: [],
  },
  'packages/editor/src/preview/physics-3d.ts': {
    packages: ['physics-rapier', 'game-host'],
    external: [],
    node: [],
  },
  // The play-preview bundle: the entry is
  // `editor/src/preview/**` and its graph may include protocol, runtime,
  // three-adapter (+ the GLTFLoader subpath), project-model, input, platformer
  // and physics-rapier. The checker validates this file's DIRECT edges against
  // that bundle graph instead of the narrower editor row (which names the
  // editor UI's edges); the transitive graph stays enforced by the esbuild
  // metafile check.
  //
  // `computedDynamicImport: 'locator'` records the OTHER accepted exception:
  // the preview loads the pinned behavior outputs from the read-only locator at
  // runtime (`./game.js`-relative behavior outputs are a
  // permitted engine fetch), so its `import()` specifier is built from the
  // artifact root and cannot be a string literal. The target is always a
  // manifest-declared relative artifact path — never a package/remote specifier.

  // The `preview-m3.ts` wrapper composes the
  // SINGLE shared production host (`createGameHost`) — the only editor file
  // allowed to import `game-host` (the preview wrapper, not the editor UI).
  // Same play-preview graph as preview-bootstrap.ts plus game-host. The
  // preview-bootstrap.ts row above stays byte-stable.
  'packages/editor/src/preview/preview-m3.ts': {
    packages: ['protocol', 'runtime', 'three-adapter', 'project-model', 'input', 'character', 'physics-rapier', 'game-host'],
    external: ['three'],
    node: [],
    // Behavior outputs load from the locator, as in preview-bootstrap.ts.
    computedDynamicImport: 'locator',
  },
  // The input exercise's frames resolved on the play page (a virtual gamepad read through the
  // project's bindings) — part of the same play-preview graph as preview-m3.ts.
  'packages/editor/src/preview/relay-frames.ts': {
    packages: ['runtime', 'input', 'game-host'],
    external: [],
    node: [],
  },
};

/** React is scoped to `editor` only. */
const REACT_EDITOR_ONLY = new Set(['react', 'react-dom']);

/** React declaration scope: only `editor` may declare these. */
const REACT_DECLARABLE = new Set(['react', 'react-dom', '@types/react', '@types/react-dom']);

/** Node builtins (bare and `node:`-prefixed forms), Node 22. */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

/**
 * Designated package test files (the narrow test-tooling policy): only these
 * may import the approved test runner `vitest`.
 */
const RE_TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx)$/;

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

// --- specifier extraction ----------------------------------------------------

/** `globalThis.x = …` / `globalThis['x'] = …` (plain `=` only). */
const RE_GLOBALTHIS =
  /globalThis\s*\.\s*[A-Za-z_$][\w$]*\s*=(?!=)|globalThis\s*\[\s*(['"])[A-Za-z_$][\w$.-]*\1\s*\]\s*=(?!=)/g;

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

function allTypeBindings(bindings) {
  return bindings !== undefined &&
    (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
    bindings.elements.length > 0 && bindings.elements.every((b) => b.isTypeOnly);
}

/** Parse TS/TSX rather than duplicating its lexical grammar. Null spec means
 * a dynamic target cannot be statically checked (reported, never ignored).
 * References: TS Compiler API wiki; pinned 5.9.3 typescript.d.ts.
 */
export function extractSpecifiers(src, fileName = 'source.ts') {
  const source = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const found = [];
  const add = (node, literal, kind, typeOnly) => {
    found.push({
      spec: literal && ts.isStringLiteralLike(literal) ? literal.text : null,
      kind,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      typeOnly,
    });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = Boolean(clause && (clause.isTypeOnly ||
        (!clause.name && allTypeBindings(clause.namedBindings))));
      add(node, node.moduleSpecifier, 'import', typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node, node.moduleSpecifier, 'export-from',
        node.isTypeOnly || allTypeBindings(node.exportClause));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node, node.arguments[0], 'dynamic-import', false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, 'import-type', true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// --- workspace discovery ----------------------------------------------------

function implementedPackages(root) {
  const dir = join(root, 'packages');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { pkgs: [], stray: [] };
  }
  const pkgs = [];
  const stray = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const pkgDir = join(dir, e.name);
    const pkgJsonPath = join(pkgDir, 'package.json');
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      stray.push(e.name);
      continue;
    }
    pkgs.push({ name: e.name, pkgDir, pkgJson });
  }
  return { pkgs, stray };
}

function tsFiles(pkgDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(pkgDir);
  return out.sort();
}

function splitPackageSpec(spec) {
  const i1 = spec.indexOf('/');
  if (spec.startsWith('@')) {
    // scoped: '@scope/name' — the package name spans through the second '/'
    if (i1 === -1) return { pkgName: spec, subpath: '' };
    const i2 = spec.indexOf('/', i1 + 1);
    if (i2 === -1) return { pkgName: spec, subpath: '' };
    return { pkgName: spec.slice(0, i2), subpath: spec.slice(i2 + 1) };
  }
  if (i1 === -1) return { pkgName: spec, subpath: '' };
  return { pkgName: spec.slice(0, i1), subpath: spec.slice(i1 + 1) };
}

function subpathExported(pkgJson, subpath) {
  const exports = pkgJson.exports;
  if (exports === undefined) return false;
  const key = subpath === '' ? '.' : `./${subpath}`;
  if (typeof exports === 'string') return subpath === '';
  return Object.prototype.hasOwnProperty.call(exports, key);
}

function isInside(p, dir) {
  const r = relative(dir, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

function canonicalPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function isTestSource(path) {
  return RE_TEST_FILE.test(canonicalPath(path));
}

// Use the package's actual TS resolution options (including moduleSuffixes).
// Typecheck owns config validation; fixture packages without configs use the
// adopted bundler resolution. Unresolved imports still fail in typecheck.
function resolutionOptions(pkgDir) {
  const defaults = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const path = join(pkgDir, 'tsconfig.json');
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) return defaults;
  return ts.parseJsonConfigFileContent(read.config, ts.sys, pkgDir).options;
}

// Every condition in an exports map must stay production-only. This also
// blocks self-imports through a public subpath pointing at a test file.
function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportTargets);
}

/**
 * Declared-dependency rules for one manifest (a package, or the workspace
 * root): unknown units, premature wiring, the React declaration
 * scope (only `editor` may declare react/react-dom + their @types/*),
 * and forbidden web frameworks.
 */
function checkDeclaredManifest(relFile, unitName, pkgJson, pkgsByName, addV) {
  for (const section of DEP_SECTIONS) {
    const deps = pkgJson[section] ?? {};
    for (const name of Object.keys(deps)) {
      if (name.startsWith(WORKSPACE_SCOPE)) {
        const unit = name.slice(WORKSPACE_SCOPE.length);
        if (!UNITS.includes(unit)) {
          addV(
            relFile,
            0,
            'unknown-unit',
            `${section} entry '${name}' is not a dependencies.md §2 unit`,
          );
        } else if (!pkgsByName.has(unit)) {
          addV(
            relFile,
            0,
            'premature-wiring',
            `${section} entry '${name}' references a workspace package that is ` +
              'not implemented yet (dependencies.md §2/§5.6: the lockfile cannot ' +
              'reference a non-existent workspace package)',
          );
        }
      } else if (REACT_DECLARABLE.has(name) && unitName !== 'editor') {
        addV(
          relFile,
          0,
          'react-declared-outside-editor',
          `${section} entry '${name}' — react/react-dom (and their @types/*) may ` +
            'be declared by the editor package only (dependencies.md §7 React ' +
            'scope rules; m1-acceptance.md §2.4)',
        );
      } else if (FORBIDDEN_WEB_FRAMEWORKS.has(splitPackageSpec(name).pkgName)) {
        addV(
          relFile,
          0,
          'forbidden-framework',
          `${section} entry '${name}' — web frameworks are forbidden ` +
            '(dependencies.md §7: node:http only; m1-acceptance.md §2.4)',
        );
      }
    }
  }
}

// --- the check ---------------------------------------------------------------

/**
 * Run the boundary check over one workspace root.
 * Returns { packages, filesScanned, specifiersChecked, violations }.
 * Each violation: { file (root-relative), line, rule, message }.
 */
export function checkWorkspace(root) {
  const violations = [];
  const addV = (file, line, rule, message) =>
    violations.push({ file, line, rule, message });

  const { pkgs, stray } = implementedPackages(root);
  const pkgsByName = new Map(pkgs.map((p) => [p.name, p]));

  for (const s of stray) {
    addV(
      join('packages', s),
      0,
      'stray-packages-dir',
      `directory packages/${s}/ has no package.json — units are created only ` +
        'when implemented with a package.json (dependencies.md §2)',
    );
  }

  // Root manifest declarations (workspace root package.json) — the same
  // declaration rules as the package manifests. The root is never the
  // `editor` package, so any React declaration there fails.
  let rootManifest = null;
  try {
    rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    // no root manifest — npm itself cannot operate here; not a boundary
    // violation to report.
  }
  if (rootManifest) {
    const rootName = typeof rootManifest.name === 'string' ? rootManifest.name : '(root)';
    checkDeclaredManifest('package.json', rootName, rootManifest, pkgsByName, addV);
  }

  let filesScanned = 0;
  let specifiersChecked = 0;

  for (const pkg of pkgs) {
    const relPkgJson = join('packages', pkg.name, 'package.json');
    const allowed = NODE_SIDE_ALLOWED[pkg.name];
    if (!allowed) {
      addV(
        relPkgJson,
        0,
        'unknown-unit',
        `unit '${pkg.name}' is not in the dependencies.md §2 unit list`,
      );
      continue;
    }

    // declared dependencies: no premature wiring, React scope,
    // no web frameworks.
    checkDeclaredManifest(relPkgJson, pkg.name, pkg.pkgJson, pkgsByName, addV);
    const options = resolutionOptions(pkg.pkgDir);
    for (const target of exportTargets(pkg.pkgJson.exports)) {
      if (isTestSource(resolve(pkg.pkgDir, target))) {
        addV(relPkgJson, 0, 'test-public-export',
          `exports target '${target}' exposes a test file — tests are not public production entry points (dependencies.md §3).`);
      }
    }

    // sources.
    for (const file of tsFiles(pkg.pkgDir)) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(root, file);
      const isTestFile = isTestSource(file);
      filesScanned += 1;
      // The bundle-entry override (if any) replaces the node-side
      // edges for this file's direct imports.
      const fileAllowed = BUNDLE_ENTRY_EDGES[rel] ?? allowed;

      for (const { spec, kind, line, typeOnly } of extractSpecifiers(src, file)) {
        specifiersChecked += 1;
        if (spec === null) {
          if (kind === 'dynamic-import' && fileAllowed?.computedDynamicImport === 'locator') {
            // Bounded, recorded exception (see BUNDLE_ENTRY_EDGES): the target is
            // a manifest-declared relative locator artifact path, not a package.
            continue;
          }
          addV(rel, line, 'unresolved-import-target',
            `${kind} target must be a string literal so its dependency boundary can be checked (dependencies.md §5.1).`);
          continue;
        }

        // Resolve actual local targets before checking isolation. Covers
        // extensionless, .js-to-.ts, directory and symlink imports, not just
        // filenames spelled with a test suffix at the import site.
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const resolved = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule;
          const abs = canonicalPath(resolved?.resolvedFileName ?? resolve(dirname(file), spec));
          if (!isInside(abs, canonicalPath(pkg.pkgDir))) {
            addV(
              rel,
              line,
              'cross-package-internal',
              `${kind} '${spec}' escapes '${pkg.name}' — another package's internal ` +
                'files are unreachable; import the target via its exports subpath ' +
                '(dependencies.md §3/§4.3)',
            );
          } else if (!isTestFile && isTestSource(abs)) {
            addV(rel, line, 'production-to-test',
              `${kind} '${spec}' resolves to '${relative(root, abs)}' — production must not import test helpers or the test runner (R5 test-only tooling boundary).`);
          }
          continue;
        }

        // Node builtins.
        if (spec.startsWith('node:')) {
          const b = spec.slice(5);
          if (!fileAllowed.node.includes(b)) {
            addV(
              rel,
              line,
              'node-builtin-forbidden',
              `'${spec}' — Node builtins are not in '${pkg.name}'s allowed edges ` +
                '(dependencies.md §4.1; runtime is three-free and I/O-free, §4.3)',
            );
          }
          continue;
        }

        const { pkgName, subpath } = splitPackageSpec(spec);
        if (NODE_BUILTINS.has(pkgName)) {
          if (!fileAllowed.node.includes(pkgName)) {
            addV(
              rel,
              line,
              'node-builtin-forbidden',
              `'${spec}' — Node builtins are not in '${pkg.name}'s allowed edges ` +
                '(dependencies.md §4.1; runtime is three-free and I/O-free, §4.3)',
            );
          }
          continue;
        }

        // workspace packages.
        if (pkgName.startsWith(WORKSPACE_SCOPE)) {
          const unit = pkgName.slice(WORKSPACE_SCOPE.length);
          if (!UNITS.includes(unit)) {
            addV(
              rel,
              line,
              'unknown-unit',
              `'${spec}' — '${pkgName}' is not in the dependencies.md §2 unit list`,
            );
            continue;
          }
          const target = pkgsByName.get(unit);
          if (!target) {
            addV(
              rel,
              line,
              'unimplemented-unit',
              `'${spec}' — '${pkgName}' is not implemented yet (dependencies.md §2: ` +
                'units are created only when implemented)',
            );
            continue;
          }
          if (target.pkgJson.exports === undefined) {
            addV(
              rel,
              line,
              'no-exports-map',
              `'${spec}' — '${pkgName}' has no exports map (dependencies.md §3: the ` +
                'public surface is the exports map only)',
            );
            continue;
          }
          if (!subpathExported(target.pkgJson, subpath)) {
            addV(
              rel,
              line,
              'non-exported-subpath',
              `'${spec}' — subpath '${subpath === '' ? '.' : `./${subpath}`}' is not in ` +
                `${pkgName}'s exports map (dependencies.md §3: internal files are ` +
                'unreachable by package name)',
            );
            continue;
          }
          if (unit === pkg.name) continue; // self-reference through own public subpath: internal
          if (!fileAllowed.packages.includes(unit)) {
            addV(
              rel,
              line,
              'forbidden-edge',
              `'${spec}' — '${pkg.name} → ${unit}' is not in the dependencies.md §4.1 ` +
                'allowed node-side edges (forbidden-edge table: §4.3)',
            );
            continue;
          }
          const sub = fileAllowed.subpaths?.[unit];
          // Test files may also use the backend's test-only `testing` subpath.
          if (sub && !sub.includes(subpath) && !(isTestFile && unit === 'backend' && subpath === 'testing')) {
            addV(
              rel,
              line,
              unit === 'backend' ? 'backend-services-only' : 'restricted-subpath',
              unit === 'backend'
                ? `'${spec}' — '${pkg.name} may import only the /services subpath of ` + '@thirdlight/backend (dependencies.md §3/§4.3)'
                : `'${spec}' — '${pkg.name} may import only the ${sub.map((x) => `/${x}`).join(', ')} subpath(s) of @thirdlight/${unit}`,
            );
          }
          // Types-only qualifiers: a value import of these edges is an
          // executable import (for editor → commands/project-model this is the
          // forbidden second mutation path).
          if (fileAllowed.typesOnly?.[unit] && !typeOnly && !fileAllowed.valueSubpaths?.[unit]?.includes(subpath)) {
            addV(
              rel,
              line,
              'types-only-edge',
              `'${spec}' — '${pkg.name} → ${unit}' is a types-only edge ` +
                '(dependencies.md §4.1: "types only"); value imports, value ' +
                're-exports, and dynamic import() of it are executable imports ' +
                '— use `import type` / `export type` for the type-only forms ' +
                '(the no-second-mutation-path rule, §4.3)',
            );
          }
          continue;
        }

        // external (non-workspace) packages.
        // Narrow test-tooling policy: the approved test runner in designated
        // test files only (production files fail as forbidden-external below).
        if (isTestFile && pkgName === 'vitest') continue;
        if (FORBIDDEN_WEB_FRAMEWORKS.has(pkgName)) {
          addV(
            rel,
            line,
            'forbidden-framework',
            `'${spec}' — web frameworks are forbidden (dependencies.md §7: ` +
              'node:http only; m1-acceptance.md §2.4)',
          );
          continue;
        }
        if (REACT_EDITOR_ONLY.has(pkgName) && pkg.name !== 'editor') {
          addV(
            rel,
            line,
            'react-outside-editor',
            `'${spec}' — react/react-dom are scoped to the editor package only ` +
              '(dependencies.md §7 React scope rules)',
          );
          continue;
        }
        if (!fileAllowed.external.includes(pkgName)) {
          addV(
            rel,
            line,
            'forbidden-external',
            `'${spec}' — '${pkgName}' is not in '${pkg.name}'s dependencies.md §4.1 ` +
              'allowed edges',
          );
          continue;
        }
        // Approved-subpath restriction for an allowed external package
        // (only the listed `three/examples/jsm` modules are approved for the
        // three-adapter).
        const externalSubpaths = fileAllowed.externalSubpaths?.[pkgName];
        if (externalSubpaths && !externalSubpaths.includes(subpath)) {
          addV(
            rel,
            line,
            'external-subpath-forbidden',
            `'${spec}' — '${pkg.name}' may import only '${pkgName}'` +
              `${externalSubpaths
                .filter((s) => s !== '')
                .map((s) => ` and its '${s}' subpath`)
                .join('')}` +
              ' (dependencies.md §4.2/§7: another examples/jsm module is a ' +
              'reviewed addition, not an incidental import)',
          );
        }
      }

      // No hidden global services.
      // Runs on the raw source (a commented-out assignment is flagged for
      // review — the conservative direction for this review rule).
      RE_GLOBALTHIS.lastIndex = 0;
      let gm;
      while ((gm = RE_GLOBALTHIS.exec(src)) !== null) {
        addV(
          rel,
          lineOf(src, gm.index),
          'globalthis-assignment',
          'assignment to globalThis — no hidden global services (dependencies.md ' +
            '§4.3); cross-package state sharing is by injection only — review required',
        );
      }
    }
  }

  return {
    packages: pkgs.map((p) => p.name),
    filesScanned,
    specifiersChecked,
    violations,
  };
}

// --- Check 2: genre vocabulary ------------------------------------
//
// The engine holds capabilities only; game rules live in game repos
// (docs/roadmap.md principle 1b, docs/plan-phase-24.md). Every text file under
// `packages/*/src/**` (tests inside src included) is scanned for the words of
// the deleted platformer layer. Matching is case-insensitive on whole words;
// identifiers are split first (`bestScore` → `best Score`, `enemy_count` →
// `enemy count`), so a camelCase or snake_case name cannot hide a word.

/** The genre words (one alternation; `\b` on both sides after identifier splitting). */
export const GENRE_VOCABULARY =
  /\b(coins?|gems?|lives|stomp(?:s|ed|ing|able)?|enem(?:y|ies)|boars?|checkpoints?|goals?|hazards?|scores?|level[- ]complete|platformers?|sprout|beacons?)\b/gi;

/**
 * The reviewed allowlist: a hit is allowed when its file is `file` and the
 * matched word matches `pattern`. Keep it short; every row names why the use
 * is not a game rule. A row that matches nothing fails (it is stale).
 */
export const VOCABULARY_ALLOWLIST = Object.freeze([
  {
    file: 'packages/project-model/src/upgrade-v24.ts',
    pattern: /^(coins?|gems?|lives|stomp|enemy|hazard|checkpoint|goal|score)$/i,
    reason: 'the schemaVersion 2 → 3 upgrade must name the removed components, pickup kinds and counters it converts or refuses',
  },
  {
    file: 'packages/project-model/src/upgrade-v24.test.ts',
    pattern: /^(coins?|gems?|lives|enemy|enemies|goal)$/i,
    reason: 'tests of that upgrade: old pickup kinds, the counters they become, the refused enemy component',
  },
  {
    file: 'packages/backend/src/format-upgrade.test.ts',
    pattern: /^(coins?|enemy)$/i,
    reason: 'the upgrade over HTTP: an old coin pickup becomes a counter, an old enemy component is refused by name',
  },
]);

const VOCABULARY_TEXT_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|css|json|html|md|txt|glsl|wgsl)$/i;

/** Split identifiers into words without moving line breaks (camelCase, snake_case, digits). */
export function splitIdentifiers(src) {
  return src
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ');
}

/** Vocabulary hits of one file's text: [{ line, word }]. */
export function vocabularyHits(src) {
  const text = splitIdentifiers(src);
  const hits = [];
  GENRE_VOCABULARY.lastIndex = 0;
  let m;
  while ((m = GENRE_VOCABULARY.exec(text)) !== null) {
    let line = 1;
    for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
    hits.push({ line, word: m[1] });
  }
  return hits;
}

/**
 * Check 2: genre vocabulary in `packages/*\/src/**`. Returns
 * `{ filesScanned, hits, allowed, violations }` (violations as check 1's).
 */
export function checkVocabulary(root, allowlist = VOCABULARY_ALLOWLIST) {
  const violations = [];
  const used = new Set();
  let filesScanned = 0;
  let hitCount = 0;
  let allowed = 0;
  const pkgRoot = join(root, 'packages');
  let pkgDirs = [];
  try {
    pkgDirs = readdirSync(pkgRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    pkgDirs = [];
  }
  for (const name of pkgDirs) {
    const files = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === 'node_modules') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (VOCABULARY_TEXT_FILE.test(e.name)) files.push(p);
      }
    };
    walk(join(pkgRoot, name, 'src'));
    for (const file of files.sort()) {
      filesScanned++;
      const rel = relative(root, file).split('\\').join('/');
      for (const hit of vocabularyHits(readFileSync(file, 'utf8'))) {
        hitCount++;
        const row = allowlist.findIndex((a) => a.file === rel && a.pattern.test(hit.word));
        if (row >= 0) {
          allowed++;
          used.add(row);
          continue;
        }
        violations.push({
          file: rel,
          line: hit.line,
          rule: 'genre-vocabulary',
          message: `'${hit.word}' — genre vocabulary in engine source: game rules live in game repos ` +
            '(docs/roadmap.md principle 1b; a generic use needs a reviewed VOCABULARY_ALLOWLIST row)',
        });
      }
    }
  }
  // A row whose file exists but matches nothing is stale (rows for files that
  // are not there are skipped, so fixture workspaces can run the CLI; the
  // tool's own test checks that every row's file exists in the repository).
  allowlist.forEach((a, i) => {
    if (!used.has(i) && existsSync(join(root, a.file))) {
      violations.push({ file: a.file, line: 0, rule: 'genre-vocabulary-stale-allowlist', message: `allowlist row ${a.pattern} matches nothing: remove it` });
    }
  });
  return { filesScanned, hits: hitCount, allowed, violations };
}

// --- CLI ---------------------------------------------------------------------

function main() {
  const root = process.cwd();
  const result = checkWorkspace(root);
  const vocabulary = checkVocabulary(root);
  result.violations.push(...vocabulary.violations);
  if (result.violations.length > 0) {
    console.error(
      `check-boundaries: FAIL — ${result.violations.length} violation(s):`,
    );
    for (const v of result.violations) {
      console.error(`  ${v.file}:${v.line}: [${v.rule}] ${v.message}`);
    }
    process.exit(1);
  }
  if (result.packages.length === 0) {
    console.log(
      'check-boundaries: OK — no implemented packages yet (units appear in ' +
        'packets 05–12, dependencies.md §2); nothing to check.',
    );
  } else {
    console.log(
      `check-boundaries: OK — ${result.packages.length} package(s) [${result.packages.join(', ')}], ` +
        `${result.filesScanned} source file(s), ${result.specifiersChecked} specifier(s) checked; ` +
        'no boundary violations.',
    );
  }
  console.log(
    `check-boundaries: OK — genre vocabulary: ${vocabulary.filesScanned} package source file(s), ` +
      `${vocabulary.allowed} allowlisted use(s) in ${VOCABULARY_ALLOWLIST.length} reviewed row(s), no other hits.`,
  );
}

// CLI guard — realpath-based, so it also works when the tool is invoked
// through a symlinked or relative path. (The naive
// `pathToFileURL(argv[1]) === import.meta.url` comparison silently skips
// main() for symlinked tool paths — a silent no-op check.)
function isMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}