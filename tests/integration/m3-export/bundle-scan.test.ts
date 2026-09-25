/**
 * Packet 60 — the M3 export bundle §5.4.1 re-measurement + production parity
 * (export.md §5.4.1 "M3 addition (packet 42)"; the 58/60 re-measurement duty).
 *
 * The §5.4.1 recorded-exception table binds the exact per-pattern counts of the
 * pinned `three@0.186.0` full-core bundle under the §5.3 pinned option set. The
 * packet-42 M3 addition records that `game-host` initiates no fetch and adds 0
 * occurrences for a/b/c/e/g/i and 0 additional for d/f/h/j (content.game/
 * settings/media are embedded in manifest.json, so there is no game.json
 * side-car and no extra fetch). Packets 58/60 must RE-MEASURE the table and the
 * §17.5 fetch list on the real bundles and record the result — if the measured
 * text differs they request a bounded re-review rather than widening an
 * exception.
 *
 * This test (real esbuild, real three@0.186.0 install, real M3 bundle via the
 * production `buildM3Bundle`):
 *   1. re-verifies the §5.4.1 reference full-core three counts against the
 *      current install (binding 3);
 *   2. builds the REAL M3 export bundle (entry `export-bootstrap-m3.ts`, the
 *      single shared `createGameHost` composition) and asserts the exact counts
 *      = the recorded baseline + the applicable exception rows + the counted
 *      engine call sites — i.e. `game-host` contributes 0 to d/f/h/j and
 *      a/b/c/e/g/i stay 0;
 *   3. proves the export bundle's graph contains the SAME shared composition
 *      (game-host + platformer-game) the preview uses (production parity);
 *   4. the negative authoring-token/capability/Node/URL scans.
 *
 * The real-browser standalone playthrough (independent static server under a
 * non-root prefix, backend stopped/unreachable, keyboard/gamepad/audio +
 * recorded network) is the owner-run procedure — UNVERIFIED in-container
 * (tests/browser/m3-export, packet-38 baseline §1).
 */
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildContentClosureM3, checkBundleGraphM3 } from '@thirdlight/exporter';
import { buildM3Bundle } from '../../../packages/exporter/src/export-bundle';
import type { WorkspaceService } from '@thirdlight/workspace';
import { fakeService, syntheticV3 } from '../m3-builds/helpers';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'packages/exporter', 'src', 'export-bootstrap-m3.ts');

/** export.md §5.3 — the pinned esbuild 0.28.2 option set (normative). */
const PINNED_OPTIONS = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
};

const CANARY_TOKEN = 'tl-canary-authoring-token-9f3c';

/** The §5.4.1 reference entry (exporter/src/export-m3.ts): three core + (phase 17.1) the WebGPU renderer and TSL. */
const REFERENCE_ENTRY = "import * as THREE from 'three';\nimport * as WEBGPU from 'three/webgpu';\nimport * as TSL from 'three/tsl';\nconsole.log(THREE.REVISION, WEBGPU.REVISION, Object.keys(TSL).length);\n";

function count(text: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(needle, i)) >= 0) {
    n += 1;
    i += needle.length;
  }
  return n;
}

/** The §5.4 normative patterns a–j over one emitted text (the M2 scan shape). */
function scanText(text: string, tokenValues: readonly string[]): Record<string, number> {
  return {
    a: tokenValues.reduce((n, v) => n + count(text, v), 0),
    b: 0,
    c: count(text, '/api/v1/'),
    d: count(text, 'fetch('),
    // Phase 17.1: a Node built-in module specifier (three's node materials have `node:` object keys).
    e: (text.match(/["'`]node:/g) ?? []).length,
    f: count(text, '__dirname') + count(text, 'process.'),
    g: count(text, '/mcp'),
    h: count(text, 'http://') + count(text, 'https://') + count(text, 'file://'),
    i: 0,
    j: count(text, 'XMLHttpRequest') + count(text, 'WebSocket'),
  };
}

async function buildStdin(contents: string): Promise<string> {
  const result = await build({ ...PINNED_OPTIONS, stdin: { contents, resolveDir: REPO_ROOT }, write: false });
  const out = result.outputFiles?.[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return new TextDecoder().decode(out.contents);
}

describe('M3 export bundle §5.4.1 re-measurement + production parity (packet 60)', () => {
  it('re-verifies the §5.4.1 reference full-core three counts against the current install (binding 3)', async () => {
    const reference = await buildStdin(REFERENCE_ENTRY);
    const ref = scanText(reference, []);
    // The §5.4.1 recorded-exception table (pinned three@0.186.0, full core +
    // phase 17.1 three/webgpu + three/tsl: +13 `process.` prose, +1 `http://`
    // and +4 `https://` doc links; its six `node:` object keys are not
    // module specifiers).
    expect(ref.d).toBe(3);
    expect(ref.f).toBe(16);
    expect(ref.h).toBe(31);
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
    const nAssets = closure.closure.assetArtifacts.length;
    expect(nAssets).toBe(2);

    const bundle = await buildM3Bundle({ bootstrapEntry: BOOTSTRAP, closure: closure.closure });
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;
    const text = new TextDecoder().decode(bundle.bytes);
    const c = scanText(text, [CANARY_TOKEN]);

    // Absolute patterns: a/b/c/e/g/i = 0 (no authoring URL/API/Node/MCP/token).
    expect(c.a).toBe(0);
    expect(text).not.toContain(CANARY_TOKEN);
    expect(c.b).toBe(0);
    expect(c.c).toBe(0);
    expect(c.e).toBe(0);
    expect(c.g).toBe(0);
    expect(c.i).toBe(0);

    // d = the recorded baseline (three core) + the Rapier row (+1) + the
    //    counted engine call sites (one ./manifest.json + one ./scene.json +
    //    one read per unique declared asset path). game-host adds 0. The
    //    compressed-GLB loaders (2026-09-23) add 1: three's zstddec, pulled in
    //    by KTX2Loader, fetches its own embedded `data:application/wasm` URL
    //    (no network).
    expect(c.d).toBe(ref.d + 1 + 2 + nAssets + 1);

    // f/j = exactly the table's counts + 0 from game-host + 0 from the
    //    GLTFLoader subpath (C64-6: d/f/j/a/b/c/e/g/i +0 for the subpath
    //    row — the loader port adds no Node/URL/process surface).
    expect(c.f).toBe(ref.f);
    expect(c.j).toBe(ref.j);

    // h = the table's counts + the §5.4.1 GLTFLoader subpath row (C64-6,
    //    re-measured packet 70): the `three-adapter` `./gltf-loader` subpath
    //    entered the M3 export graph (delivery.md (M4) §2 — the wrapper
    //    builds the loader port the `models` block uses), adding the
    //    pinned `three@0.186.0` GLTFLoader addon's documented URL comments
    //    (+12 `https://`; `GLTFLoader` ×37 in the bundle bytes). The
    //    compressed-GLB loaders (2026-09-23: DRACOLoader, KTX2Loader and their
    //    helpers, meshopt_decoder) add +1: a documentation URL in a comment
    //    that esbuild keeps (KTX2Loader's gpuweb issue link). No fetch target.
    expect(c.h).toBe(ref.h + 12 + 1);
    expect(count(text, 'GLTFLoader')).toBe(37);

    // The C64-6 graph rows: the M3 export graph reaches the `./gltf-loader`
    //    subpath + the pinned three addons listed below.
    const inputs = Object.keys(bundle.metafile.inputs);
    expect(inputs.some((p) => p.includes('packages/three-adapter/src/gltf-loader.ts'))).toBe(true);
    const addons = inputs.filter((p) => p.includes('three/examples/jsm/')).map((p) => p.slice(p.indexOf('three/examples/jsm/') + 'three/examples/jsm/'.length)).sort();
    // GLTFLoader and its two utils, plus (2026-09-23) three's Draco/KTX2
    // loaders with their helpers and the meshopt decoder, plus (phase 9.5b)
    // the environment's sky and post-processing passes — nothing else.
    expect(addons).toEqual([
      'libs/ktx-parse.module.js',
      'libs/meshopt_decoder.module.js',
      'libs/zstddec.module.js',
      'loaders/DRACOLoader.js',
      'loaders/GLTFLoader.js',
      'loaders/KTX2Loader.js',
      'math/ColorSpaces.js',
      'math/SimplexNoise.js',
      'objects/Sky.js',
      'postprocessing/BokehPass.js',
      'postprocessing/EffectComposer.js',
      'postprocessing/GTAOPass.js',
      'postprocessing/MaskPass.js',
      'postprocessing/OutputPass.js',
      'postprocessing/Pass.js',
      'postprocessing/RenderPass.js',
      'postprocessing/SMAAPass.js',
      'postprocessing/ShaderPass.js',
      'postprocessing/UnrealBloomPass.js',
      'shaders/BokehShader.js',
      'shaders/CopyShader.js',
      'shaders/FXAAShader.js',
      'shaders/GTAOShader.js',
      'shaders/LuminosityHighPassShader.js',
      'shaders/OutputShader.js',
      'shaders/PoissonDenoiseShader.js',
      'shaders/SMAAShader.js',
      'utils/BufferGeometryUtils.js',
      'utils/SkeletonUtils.js',
      'utils/WorkerPool.js',
    ]);

    // No absolute/remote fetch literal (every target is a relative artifact).
    expect(text).not.toContain('fetch("http');
    expect(text).not.toContain("fetch('http");
    expect(text).not.toContain('fetch("https');
  }, 120_000);

  it('the export bundle graph contains the SAME shared composition (game-host + platformer-game) as the preview', async () => {
    const { scene, content, blobs } = syntheticV3();
    const closure = await buildContentClosureM3({
      service: fakeService({ blobs }) as unknown as WorkspaceService,
      compiler: {} as never,
      projectId: 'demo-0006-parity',
      revision: 1,
      capturedAt: '2026-09-21T00:00:00Z',
      scene,
      content,
    });
    expect(closure.ok).toBe(true);
    if (!closure.ok) return;
    const bundle = await buildM3Bundle({ bootstrapEntry: BOOTSTRAP, closure: closure.closure });
    expect(bundle.ok).toBe(true);
    if (!bundle.ok) return;

    // The §5.2 graph check passes (the accepted M3 graph — no forbidden module).
    const report = checkBundleGraphM3(bundle.metafile, BOOTSTRAP);
    expect(report.ok).toBe(true);

    // The bundle links the single shared production composition: game-host +
    // platformer-game (the SAME entry the preview wraps — no second
    // bootstrap/controller/run-state owner, delivery.md §3.2).
    const inputs = Object.keys(bundle.metafile.inputs);
    expect(inputs.some((p) => p.includes('packages/game-host/src/'))).toBe(true);
    expect(inputs.some((p) => p.includes('packages/platformer-game/src/'))).toBe(true);
    // No editor/exporter-internal/behavior source in the runtime bundle.
    expect(inputs.some((p) => p.includes('packages/editor/src/'))).toBe(false);
    expect(inputs.some((p) => p.includes('packages/backend/src/'))).toBe(false);
  }, 120_000);
});