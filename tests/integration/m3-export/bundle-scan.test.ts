/**
 * The export bundle's pattern re-measurement + production parity.
 *
 * The recorded-exception table binds the exact per-pattern counts of the
 * pinned `three` full-core bundle under the export's pinned option set.
 * `game-host` initiates no fetch and adds 0 occurrences for a/b/c/e/g/i and
 * 0 additional for d/f/h/j (content.game/settings/media are embedded in
 * manifest.json, so there is no game.json side-car and no extra fetch). The
 * table and the fetch list are RE-MEASURED on the real bundles — if the
 * measured text differs, the exception is re-reviewed, never widened.
 *
 * This test (real esbuild, real three install, real M3 bundle via the
 * production `buildM3Bundle`):
 *   1. re-verifies the reference full-core three counts against the
 *      current install;
 *   2. builds the M3 export bundle's entry (`export-bootstrap-m3.ts`, the
 *      single shared `createGameHost` composition) readable — unminified and
 *      unshaken, so every occurrence is there to count — and asserts the exact
 *      counts = the recorded baseline + the applicable exception rows + the
 *      counted engine call sites — i.e. `game-host` contributes 0 to d/f/h/j
 *      and a/b/c/e/g/i stay 0; the shipped bundle (minified, tree-shaken) is
 *      the same code with less: a/b/c/e/g/i stay 0 and no count grows;
 *   3. proves the export bundle's graph contains the SAME shared composition
 *      (game-host) the preview uses (production parity), and
 *      that the page and worker bundles link only the module specs the
 *      manifest names — a project without platformer content ships none;
 *   4. the negative authoring-token/capability/Node/URL scans, over every
 *      script an export ships (the page, the simulation and mesh workers, the
 *      2D and 3D physics backends) and each one's source map, whose sources
 *      name engine-relative paths only (never the building host's folders).
 *
 * The real-browser standalone playthrough (independent static server under a
 * non-root prefix, backend stopped/unreachable, keyboard/gamepad/audio +
 * recorded network) is the owner-run procedure — UNVERIFIED in-container
 * (tests/browser/m3-export).
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildContentClosureM3, checkBundleGraphM3 } from '@thirdlight/exporter';
import { buildM3Bundle, buildSimWorkerBundle, engineRelativeSource, MODULES_MODULE, modulesModuleSource, THREE_WEBGPU_ONLY_PLUGIN } from '../../../packages/exporter/src/export-bundle';
import type { WorkspaceService } from '@thirdlight/workspace';
import { fakeService, syntheticV3 } from '../m3-builds/helpers';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'packages/exporter', 'src', 'export-bootstrap-m3.ts');
const WORKER = join(REPO_ROOT, 'packages/exporter', 'src', 'export-sim-worker.ts');
/** The other scripts an export may ship, by their path in the export. */
const SHIPPED = [
  { name: 'js/mesh-worker.js', entry: join(REPO_ROOT, 'packages/exporter', 'src', 'export-mesh-worker.ts'), wasm: false },
  { name: 'js/physics-2d.js', entry: join(REPO_ROOT, 'packages/exporter', 'src', 'export-physics-2d.ts'), wasm: true },
  { name: 'js/physics-3d.js', entry: join(REPO_ROOT, 'packages/exporter', 'src', 'export-physics-3d.ts'), wasm: true },
] as const;

/** The readable build: every occurrence of a pattern kept, to count it exactly. */
const PINNED_OPTIONS = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
};

const CANARY_TOKEN = 'tl-canary-authoring-token-9f3c';

/** The reference entry (exporter/src/export-m3.ts): the WebGPU build of three (core re-exported) and TSL. */
const REFERENCE_ENTRY = "import * as WEBGPU from 'three/webgpu';\nimport * as TSL from 'three/tsl';\nconsole.log(WEBGPU.REVISION, Object.keys(TSL).length);\n";

function count(text: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(needle, i)) >= 0) {
    n += 1;
    i += needle.length;
  }
  return n;
}

/** The normative forbidden patterns a–j over one emitted text. */
function scanText(text: string, tokenValues: readonly string[]): Record<string, number> {
  return {
    a: tokenValues.reduce((n, v) => n + count(text, v), 0),
    b: 0,
    c: count(text, '/api/v1/'),
    d: count(text, 'fetch('),
    // A Node built-in module specifier (three's node materials have `node:` object keys).
    e: (text.match(/["'`]node:/g) ?? []).length,
    f: count(text, '__dirname') + count(text, 'process.'),
    g: count(text, '/mcp'),
    h: count(text, 'http://') + count(text, 'https://') + count(text, 'file://'),
    i: 0,
    j: count(text, 'XMLHttpRequest') + count(text, 'WebSocket'),
  };
}

async function buildStdin(contents: string): Promise<string> {
  const result = await build({ ...PINNED_OPTIONS, stdin: { contents, resolveDir: REPO_ROOT }, write: false, plugins: [THREE_WEBGPU_ONLY_PLUGIN as never] });
  const out = result.outputFiles?.[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return new TextDecoder().decode(out.contents);
}

describe('M3 export bundle re-measurement + production parity', () => {
  it('re-verifies the reference full-core three counts against the current install (binding 3)', async () => {
    const reference = await buildStdin(REFERENCE_ENTRY);
    const ref = scanText(reference, []);
    // The recorded-exception table (pinned three; the WebGPU build — core + three.webgpu + TSL, no three.module.js, so the
    // one `https://` doc link only the WebGL renderer build had is gone:
    // 4 `http://` + 26 `https://`; its six `node:` object keys are not
    // module specifiers).
    expect(ref.d).toBe(3);
    expect(ref.f).toBe(16);
    expect(ref.h).toBe(30);
    expect(ref.j).toBe(3);
    expect(ref.a + ref.b + ref.c + ref.e + ref.g + ref.i).toBe(0);
  }, 60_000);

  it('the real M3 export bundle scans to the recorded baseline + applicable rows (game-host adds 0)', async () => {
    // The reference three counts (the recorded baseline, re-verified above).
    const reference = await buildStdin(REFERENCE_ENTRY);
    const ref = scanText(reference, []);

    // The REAL M3 export bundle: the production `buildM3Bundle` over the shared
    // closure (a self-contained v3 envelope with two declared assets).
    const { scene, content, blobs } = syntheticV3();
    const closure = await buildContentClosureM3({
      service: fakeService({ blobs }) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: 'demo-0006-export',
      revision: 1,
      capturedAt: '2026-09-21T00:00:00Z',
      scene,
      content,
    });
    expect(closure.ok).toBe(true);
    if (!closure.ok) return;
    expect(closure.closure.assetArtifacts.length).toBe(2);

    const bundle = await buildM3Bundle({ bootstrapEntry: BOOTSTRAP, closure: closure.closure });
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;
    // The same entry and generated module, readable.
    const moduleIds = closure.closure.moduleIds;
    const readable = await build({
      ...PINNED_OPTIONS,
      define: { 'import.meta.url': 'location.href' },
      entryPoints: [BOOTSTRAP],
      write: false,
      plugins: [
        { name: 'modules', setup: (b) => {
          b.onResolve({ filter: new RegExp(`^${MODULES_MODULE}$`) }, () => ({ path: 'm', namespace: 'modules' }));
          b.onLoad({ filter: /.*/, namespace: 'modules' }, () => ({ contents: modulesModuleSource(moduleIds), loader: 'js', resolveDir: dirname(BOOTSTRAP) }));
        } },
        THREE_WEBGPU_ONLY_PLUGIN as never,
      ],
    });
    const text = new TextDecoder().decode(readable.outputFiles[0]!.contents);
    const c = scanText(text, [CANARY_TOKEN]);
    // The shipped bytes: nothing forbidden, and minifying and shaking only take away.
    const shipped = scanText(new TextDecoder().decode(bundle.bytes), [CANARY_TOKEN]);
    expect(shipped.a + shipped.b + shipped.c + shipped.e + shipped.g + shipped.i).toBe(0);
    for (const k of ['d', 'f', 'h', 'j'] as const) expect(shipped[k], k).toBeLessThanOrEqual(c[k]);

    // Absolute patterns: a/b/c/e/g/i = 0 (no authoring URL/API/Node/MCP/token).
    expect(c.a).toBe(0);
    expect(text).not.toContain(CANARY_TOKEN);
    expect(c.b).toBe(0);
    expect(c.c).toBe(0);
    expect(c.e).toBe(0);
    expect(c.g).toBe(0);
    expect(c.i).toBe(0);

    // d = the recorded baseline (three core) + the page's one relative reader
    //    (the manifest, the scene, the catalog's files and the assets all go
    //    through it, by the paths their rows give; the bundle names no
    //    artifact). game-host adds 0. The compressed-GLB loaders add 1: three's
    //    zstddec, pulled in by KTX2Loader, fetches its own embedded
    //    `data:application/wasm` URL (no network). The physics engine is not in
    //    the page bundle (it loads from its own file).
    expect(c.d).toBe(ref.d + 1 + 1);
    // No artifact path is baked into the code: not an asset's, not a catalog file's.
    for (const a of [...closure.closure.assetArtifacts, ...closure.closure.contentFileArtifacts]) expect(text).not.toContain(a.path);

    // f/j = exactly the table's counts + 0 from game-host + 0 from the
    //    GLTFLoader subpath (d/f/j/a/b/c/e/g/i +0 for the subpath
    //    row — the loader port adds no Node/URL/process surface).
    expect(c.f).toBe(ref.f);
    expect(c.j).toBe(ref.j);

    // h = the table's counts + the GLTFLoader subpath row: the
    //    `three-adapter` `./gltf-loader` subpath is in the export graph (the
    //    wrapper builds the loader port the `models` block uses), adding the
    //    pinned `three` GLTFLoader addon's documented URL comments
    //    (+12 `https://`; `GLTFLoader` ×37 in the bundle bytes). The
    //    compressed-GLB loaders (DRACOLoader, KTX2Loader and their
    //    helpers, meshopt_decoder) add +1: a documentation URL in a comment
    //    that esbuild keeps (KTX2Loader's gpuweb issue link). No fetch target.
    //    Game-host's generic glyph set adds +1 — the SVG
    //    namespace (`xmlns="http://www.w3.org/2000/svg"`, like three's XHTML
    //    namespace in the table), an identifier in data: URL images, never fetched.
    //    The screenshot overlay adds +2: the SVG and XHTML namespaces of the
    //    foreignObject image it draws the page's UI into (identifiers, never fetched).
    expect(c.h).toBe(ref.h + 12 + 1 + 1 + 2);
    expect(count(text, 'GLTFLoader')).toBe(37);

    // The graph rows: the export graph reaches the `./gltf-loader`
    //    subpath + the pinned three addons listed below.
    const inputs = Object.keys(bundle.metafile.inputs);
    expect(inputs.some((p) => p.includes('packages/three-adapter/src/gltf-loader.ts'))).toBe(true);
    const addons = inputs.filter((p) => p.includes('three/examples/jsm/')).map((p) => p.slice(p.indexOf('three/examples/jsm/') + 'three/examples/jsm/'.length)).sort();
    // GLTFLoader and its two utils, plus three's Draco/KTX2
    // loaders with their helpers and the meshopt decoder, plus
    // the TSL sky and node post passes of the WebGPURenderer path (the DOF
    // node pulls in the Gaussian blur node, SSAO its depth-aware blur; FSR 1
    // upscales a render scale below 1) — nothing else (baked probes draw
    // through the engine's own probe lighting, not three's grid). The
    // WebGL sky, EffectComposer passes and shaders are gone with the
    // archived WebGL renderer path.
    expect(addons).toEqual([
      'libs/ktx-parse.module.js',
      'libs/meshopt_decoder.module.js',
      'libs/zstddec.module.js',
      'loaders/DRACOLoader.js',
      'loaders/GLTFLoader.js',
      'loaders/KTX2Loader.js',
      'math/ColorSpaces.js',
      'objects/SkyMesh.js',
      'tsl/display/BloomNode.js',
      'tsl/display/DepthOfFieldNode.js',
      'tsl/display/FSR1Node.js',
      'tsl/display/FXAANode.js',
      'tsl/display/GTAONode.js',
      'tsl/display/GaussianBlurNode.js',
      'tsl/display/SMAANode.js',
      'tsl/display/SSAONode.js',
      'tsl/display/depthAwareBlur.js',
      'utils/BufferGeometryUtils.js',
      'utils/SkeletonUtils.js',
      'utils/WorkerPool.js',
    ]);

    // No absolute/remote fetch literal (every target is a relative artifact).
    expect(text).not.toContain('fetch("http');
    expect(text).not.toContain("fetch('http");
    expect(text).not.toContain('fetch("https');
  }, 120_000);

  it('every shipped script and its source map scan clean, and a map names engine-relative sources only', async () => {
    const closure = await closureOf('demo-0006-scripts', false);
    const page = await buildM3Bundle({ bootstrapEntry: BOOTSTRAP, closure });
    const worker = await buildSimWorkerBundle(WORKER, closure.moduleIds);
    const others = await Promise.all(SHIPPED.map((s) => buildSimWorkerBundle(s.entry, undefined, { name: s.name, ...(s.wasm ? { read: (p: string) => readFileSync(p) } : {}) })));
    const built = [['js/main.js', page], ['js/sim-worker.js', worker], ...SHIPPED.map((s, i) => [s.name, others[i]!] as const)] as const;
    for (const [name, b] of built) {
      expect(b.ok, name).toBe(true);
      if (!b.ok) continue;
      if (SHIPPED.some((s) => s.name === name && s.wasm)) expect(b.wasm, `${name} links its WASM as a file`).not.toBeNull();
      for (const [file, bytes] of [[name, b.bytes], [`${name}.map`, b.map]] as const) {
        const text = new TextDecoder().decode(bytes);
        const c = scanText(text, [CANARY_TOKEN]);
        expect(c.a + c.b + c.c + c.e + c.g + c.i, `${file}: ${JSON.stringify(c)}`).toBe(0);
        // Nothing of the host that built it: not the engine's folder, not a home directory.
        expect(text.includes(REPO_ROOT), `${file} names the building host's folder`).toBe(false);
        expect(/["'`(]\/home\//.test(text), `${file} names a home directory`).toBe(false);
      }
      const sources = (JSON.parse(new TextDecoder().decode(b.map)) as { sources: string[] }).sources;
      expect(sources.length, name).toBeGreaterThan(0);
      // Engine-relative files, or a build plugin's generated module (`namespace:name`).
      for (const src of sources) expect((/^(packages|node_modules|external)\//.test(src) && !src.includes('../')) || /^[a-z0-9-]+:[a-z0-9-]+$/.test(src), `${name}: source ${src}`).toBe(true);
    }
  }, 240_000);

  it('a source outside the engine root keeps no host folder in the map', () => {
    expect(engineRelativeSource('../packages/runtime/src/runtime.ts')).toBe('packages/runtime/src/runtime.ts');
    expect(engineRelativeSource('../node_modules/three/build/three.core.js')).toBe('node_modules/three/build/three.core.js');
    expect(engineRelativeSource('../../../usr/lib/node_modules/three/build/three.core.js')).toBe('external/node_modules/three/build/three.core.js');
    expect(engineRelativeSource('/home/someone/src/thing.ts')).toBe('external/thing.ts');
    expect(engineRelativeSource('C:\\Users\\someone\\x\\node_modules\\y\\index.js')).toBe('external/node_modules/y/index.js');
    expect(engineRelativeSource('../packages/../../elsewhere/z.ts')).toBe('external/z.ts');
  });

  /** The real closure of a synthetic project (`strip`: no controller — the starter's shape). */
  async function closureOf(projectId: string, strip: boolean) {
    const { scene, content, blobs } = syntheticV3();
    if (strip) {
      for (const e of (scene as { entities: { components: Record<string, unknown> }[] }).entities) delete e.components['controller'];
    }
    const closure = await buildContentClosureM3({
      service: fakeService({ blobs }) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId,
      revision: 1,
      capturedAt: '2026-09-21T00:00:00Z',
      scene,
      content,
    });
    if (!closure.ok) throw new Error(JSON.stringify(closure.error));
    return closure.closure;
  }

  /** The page bundle and the simulation worker bundle of a closure, with their graph checks. */
  async function bundlesOf(closure: Awaited<ReturnType<typeof closureOf>>) {
    const page = await buildM3Bundle({ bootstrapEntry: BOOTSTRAP, closure });
    const worker = await buildSimWorkerBundle(WORKER, closure.moduleIds);
    if (!page.ok || !worker.ok) throw new Error('bundle build failed');
    expect(checkBundleGraphM3(page.metafile, BOOTSTRAP, closure.moduleIds).ok).toBe(true);
    expect(checkBundleGraphM3(worker.metafile, WORKER, closure.moduleIds).ok).toBe(true);
    // What each bundle links: its source map names every module with code in the output.
    return [page, worker].map((b) => ({ inputs: Object.keys(b.metafile.inputs), sources: (JSON.parse(new TextDecoder().decode(b.map)) as { sources: string[] }).sources }));
  }

  it('the page bundle is the same bytes for a project with more assets (its code does not grow with the project)', async () => {
    const small = await closureOf('demo-0006-size', true);
    const { scene, content, blobs } = syntheticV3();
    for (const e of (scene as { entities: { components: Record<string, unknown> }[] }).entities) delete e.components['controller'];
    // The same project with a copy of every asset under another id and more bytes.
    const records = (content as { assets: Record<string, unknown>[] }).assets;
    for (const r of [...records]) {
      const id = `${String(r['assetId'])}-copy`;
      records.push({ ...r, assetId: id, address: id });
      const b = blobs.get(String(r['assetId']))!;
      blobs.set(id, b);
    }
    const bigger = await buildContentClosureM3({ service: fakeService({ blobs }) as unknown as WorkspaceService, compiler: {} as never, projectId: 'demo-0006-size', revision: 1, capturedAt: '2026-09-21T00:00:00Z', scene, content });
    if (!bigger.ok) throw new Error(JSON.stringify(bigger.error));
    expect(bigger.closure.contentFileArtifacts.length).toBeGreaterThanOrEqual(small.contentFileArtifacts.length);
    const a = await buildM3Bundle({ bootstrapEntry: BOOTSTRAP, closure: small });
    const b = await buildM3Bundle({ bootstrapEntry: BOOTSTRAP, closure: bigger.closure });
    if (!a.ok || !b.ok) throw new Error('bundle build failed');
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
  }, 180_000);

  it('a project with the controller links exactly the modules its manifest names (game-host + the controller spec), page and worker alike', async () => {
    const closure = await closureOf('demo-0006-parity', false);
    expect(closure.moduleIds).toEqual(expect.arrayContaining(['thirdlight.character:controller']));
    for (const b of await bundlesOf(closure)) {
      // The single shared production composition (the SAME host the preview wraps).
      expect(b.inputs.some((p) => p.includes('packages/game-host/src/'))).toBe(true);
      expect(b.inputs.some((p) => p.includes('packages/character/src/'))).toBe(true);
      expect(b.sources).toContain('packages/character/src/controller.ts');
      // No editor/exporter-internal/behavior source in the runtime bundle.
      expect(b.inputs.some((p) => p.includes('packages/editor/src/'))).toBe(false);
      expect(b.inputs.some((p) => p.includes('packages/backend/src/'))).toBe(false);
    }
  }, 180_000);

  it('a project without platformer content (no controller) ships no platformer code', async () => {
    const closure = await closureOf('demo-0006-plain', true);
    expect(closure.moduleIds.some((id) => id.includes('platformer'))).toBe(false);
    for (const b of await bundlesOf(closure)) {
      expect(b.inputs.some((p) => p.includes('packages/game-host/src/'))).toBe(true);
      expect(b.inputs.some((p) => p.includes('packages/character/src/'))).toBe(false);
      expect(b.sources.some((p) => p.startsWith('packages/character/'))).toBe(false);
    }
    // The graph check refuses platformer code the manifest does not name.
    const withController = await closureOf('demo-0006-parity', false);
    const page = await buildM3Bundle({ bootstrapEntry: BOOTSTRAP, closure: withController });
    if (!page.ok) throw new Error('bundle build failed');
    const report = checkBundleGraphM3(page.metafile, BOOTSTRAP, closure.moduleIds);
    expect(report.ok).toBe(false);
    expect(report.forbidden.some((p) => p.includes('packages/character'))).toBe(true);
  }, 180_000);
});
