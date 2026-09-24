// SPIKE 17.0 (throwaway, not for main): rebuild an existing Thirdlight export's
// js/main.js from the current engine source with the export's pinned esbuild
// options, optionally patching three-adapter so that `?spike=webgpu|webgl2` in
// the page URL renders through three's WebGPURenderer (WebGPU backend or the
// forced WebGL2 backend) and the post stack through a TSL RenderPipeline.
//
//   node archive/spike-17/build-variant.mjs <exportDir> <outDir> [--patch]
//
// The export dir is only read (its files are hard-linked/copied into outDir).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { build } from 'esbuild';

const REPO = resolve(import.meta.dirname, '..', '..');
const ENTRY = join(REPO, 'packages/exporter/src/export-bootstrap-m3.ts');
/** export.md §5.3 (copied from packages/exporter/src/export-bundle.ts). */
export const PINNED_OPTIONS = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
  define: { 'import.meta.url': 'location.href' },
};

/** Exact-anchor replacements; every anchor must match exactly once. */
function patchText(file, text, edits) {
  let out = text;
  for (const [from, to] of edits) {
    const n = out.split(from).length - 1;
    if (n !== 1) throw new Error(`spike patch: anchor matched ${n}× in ${file}: ${from.slice(0, 80)}`);
    out = out.replace(from, to);
  }
  return out;
}

const ADAPTER_EDITS = [
  [
    "import * as THREE from 'three';",
    "import * as THREE from 'three';\nimport { WebGPURenderer as __SpikeWebGPURenderer } from 'three/webgpu';\n" +
      "const __spikeMode: string | null = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('spike') : null;\n" +
      "const __spikeNoAA: boolean = typeof location !== 'undefined' && new URLSearchParams(location.search).get('aa') === '0';",
  ],
  [
    'const renderer = new THREE.WebGLRenderer({',
    "const renderer: any = __spikeMode === 'webgpu' || __spikeMode === 'webgl2'\n" +
      "        ? new __SpikeWebGPURenderer({ canvas: canvasLike as unknown as HTMLCanvasElement, antialias: __spikeNoAA ? false : (opts.antialias ?? true), powerPreference: 'high-performance', forceWebGL: __spikeMode === 'webgl2' })\n" +
      '        : new THREE.WebGLRenderer({',
  ],
  [
    'antialias: opts.antialias ?? true,\n        powerPreference',
    'antialias: __spikeNoAA ? false : (opts.antialias ?? true),\n        powerPreference',
  ],
  [
    "renderBackend = renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1';",
    "if (renderer.isWebGPURenderer) {\n" +
      "        const t0 = performance.now();\n" +
      "        (globalThis as any).__tlSpike = { mode: __spikeMode, renderer, init: renderer.init().then(() => ({ ok: true, ms: performance.now() - t0, backend: renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2' }), (e: unknown) => ({ ok: false, error: String(e) })) };\n" +
      '      }\n' +
      "      renderBackend = renderer.isWebGPURenderer ? 'webgl2' : renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1';",
  ],
  [
    "if (!renderer) return { ok: false, error: adapterError('render_failed', 'renderer unavailable') };",
    "if (!renderer) return { ok: false, error: adapterError('render_failed', 'renderer unavailable') };\n" +
      '    // SPIKE: WebGPURenderer.render() throws before `await init()`; skip frames until it is ready.\n' +
      '    if ((renderer as any).isWebGPURenderer && (renderer as any)._initialized !== true) return { ok: true };',
  ],
  ['let probeOk = renderer.capabilities.maxTextureSize >= SHADOW_PROFILE.mapSize;', 'let probeOk = ((renderer as any).capabilities?.maxTextureSize ?? 16384) >= SHADOW_PROFILE.mapSize;'],
];

const ENV_EDITS = [
  [
    "import * as THREE from 'three';",
    "import * as THREE from 'three';\n" +
      "import * as __W from 'three/webgpu';\n" +
      "import { pass as __pass, uv as __uv, vec4 as __vec4, float as __float, smoothstep as __smoothstep, renderOutput as __renderOutput } from 'three/tsl';\n" +
      "import { bloom as __bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';\n" +
      "import { smaa as __smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';\n" +
      "import { fxaa as __fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';",
  ],
  [
    'const pmrem = new THREE.PMREMGenerator(renderer);',
    'const pmrem: any = (renderer as any).isWebGPURenderer ? new __W.PMREMGenerator(renderer as any) : new THREE.PMREMGenerator(renderer);\n' +
      '  let __spikePipe: any = null;\n' +
      '  // SPIKE: the post stack as a TSL RenderPipeline (bloom, vignette, SMAA/FXAA; tone mapping in the output transform).\n' +
      '  const __spikeBuildPipeline = (camera: THREE.Camera, w: any, post: any): void => {\n' +
      "    if (new URLSearchParams(location.search).get('post') === 'off') { passNames = ['spike-direct']; return; }\n" +
      '    const pipe = new __W.RenderPipeline(renderer as any);\n' +
      '    const scenePass = __pass(scene, camera);\n' +
      "    let out: any = scenePass.getTextureNode('output');\n" +
      "    const names = ['render'];\n" +
      "    if (w.bloom) { out = out.add(__bloom(out, post?.bloom?.strength ?? 0.6, post?.bloom?.radius ?? 0.4, post?.bloom?.threshold ?? 0.85)); names.push('bloom'); }\n" +
      '    if (post?.vignette?.enabled === true) {\n' +
      '      const d = post.vignette.darkness ?? 0.5;\n' +
      '      const v = __smoothstep(__float(0.8), __float(0.8 * (post.vignette.offset ?? 1)).mul(0.5), __uv().sub(0.5).length());\n' +
      "      out = __vec4(out.rgb.mul(__float(1).sub(__float(d)).add(v.mul(d))), out.a); names.push('vignette(approx)');\n" +
      '    }\n' +
      "    if (w.aa === 'smaa') { out = __smaa(out); names.push('smaa'); }\n" +
      "    else if (w.aa === 'fxaa') { pipe.outputColorTransform = false; out = __fxaa(__renderOutput(out)); names.push('fxaa'); }\n" +
      '    pipe.outputNode = out;\n' +
      '    __spikePipe = pipe;\n' +
      '    passNames = names;\n' +
      '  };',
  ],
  ['const disposeComposer = (): void => {', 'const disposeComposer = (): void => {\n    if (__spikePipe !== null) { __spikePipe.dispose(); __spikePipe = null; }'],
  [
    'const c = new EffectComposer(renderer);',
    'if ((renderer as any).isWebGPURenderer) { __spikeBuildPipeline(camera, w, post); return; }\n      const c = new EffectComposer(renderer);',
  ],
  [
    'if (composer === null) {\n        renderer.render(scene, camera);',
    'if (__spikePipe !== null) { __spikePipe.render(); return; }\n      if (composer === null) {\n        renderer.render(scene, camera);',
  ],
];

function patchPlugin() {
  return {
    name: 'spike-17-webgpu-patch',
    setup(b) {
      b.onLoad({ filter: /three-adapter[\\/]src[\\/](adapter|environment)\.ts$/ }, (a) => {
        const text = readFileSync(a.path, 'utf8');
        const edits = a.path.endsWith('adapter.ts') ? ADAPTER_EDITS : ENV_EDITS;
        return { contents: patchText(a.path, text, edits), loader: 'ts', resolveDir: dirname(a.path) };
      });
    },
  };
}

function artifactsPlugin(assetPaths) {
  const rows = assetPaths.map((p) => `  case ${JSON.stringify(p)}: return fetch(${JSON.stringify(`./${p}`)}, { credentials: "omit", signal });`);
  const src = [`export const assetPaths = ${JSON.stringify(assetPaths)};`, 'export function readAsset(path, signal) {', '  switch (path) {', ...rows, '    default: return null;', '  }', '}', ''].join('\n');
  return {
    name: 'thirdlight-export-closure-m3',
    setup(b) {
      b.onResolve({ filter: /^thirdlight:export-artifacts$/ }, () => ({ path: 'export-artifacts', namespace: 'thirdlight-export' }));
      b.onLoad({ filter: /.*/, namespace: 'thirdlight-export' }, () => ({ contents: src, loader: 'js' }));
    },
  };
}

export async function buildVariant(exportDir, outDir, patch) {
  const main = readFileSync(join(exportDir, 'js/main.js'), 'utf8');
  const m = /var assetPaths = (\[[^\n]*\]);/.exec(main);
  if (m === null) throw new Error('assetPaths not found in the export bundle');
  const assetPaths = JSON.parse(m[1]);
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(dirname(outDir), { recursive: true });
  cpSync(exportDir, outDir, { recursive: true });
  const r = await build({
    ...PINNED_OPTIONS,
    absWorkingDir: REPO,
    entryPoints: [ENTRY],
    write: false,
    metafile: true,
    logLevel: 'error',
    plugins: [artifactsPlugin(assetPaths), ...(patch ? [patchPlugin()] : [])],
  });
  const bytes = r.outputFiles[0].contents;
  writeFileSync(join(outDir, 'js/main.js'), bytes);
  return { bytes: bytes.length, inputs: Object.keys(r.metafile.inputs).length };
}

if (process.argv[1] === import.meta.filename) {
  const [exportDir, outDir, flag] = process.argv.slice(2);
  console.log(await buildVariant(resolve(exportDir), resolve(outDir), flag === '--patch'));
}
