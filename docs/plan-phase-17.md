# Phase 17 — Renderer: WebGPU with a WebGL2 fallback

Goal: the Scene view, the asset previews, Play and exported games render
with three.js's `WebGPURenderer` on WebGPU where available and on its
WebGL2 backend otherwise, with all shading written once in TSL (three's node
shading language). This is the base for the material graph (18) and GPU
effects (20). Read `docs/roadmap.md` (principles) first.

## 1. Where things stand

- `three` 0.186, `THREE.WebGLRenderer` in `three-adapter/src/adapter.ts`
  (Play/export), `editor/src/viewport/viewport.ts` (Scene view) and
  `editor/src/viewport/preview-stage.ts` (asset preview, Animator preview).
- Custom shading: `three-adapter/src/material-library.ts` (shader types
  standard, foliage with COLOR_0 wind, kit with world-X UV + macro normal,
  unlit, water — `onBeforeCompile`/`ShaderMaterial` style), lightmaps
  (`lightmaps.ts`), the post stack (`environment.ts`: EffectComposer with
  GTAO, Bokeh, UnrealBloom, a custom grading/LUT/vignette pass, SMAA/FXAA,
  AgX tone mapping), fog volumes, PMREM environment, shadows.
- This server has no GPU: headless Chromium renders WebGL2 on SwiftShader
  (~4.5 fps for the Sprout level). Headless WebGPU may work through Dawn's
  SwiftShader adapter (`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`
  or current equivalents — check the pinned Playwright Chromium).

## 2. Decisions (owner, 2026-09-24)

- WebGPU is the target renderer; WebGL2 is the fallback; both from the same
  TSL shading. No separate hand-written GLSL path is kept once ported.

## 3. How to work

`docs/roadmap.md` → "How every phase is worked". Check three.js's official
docs and examples for the pinned version before using WebGPU/TSL APIs
(`three/webgpu`, `three/tsl`); if an upgrade of `three` is needed for a
required feature, pin it exactly, re-run everything, and log it.

## 4. Work items

### 17.0 Spike and decision record

- A throwaway branch renders the Beacon Reach template and a Sprout level
  through `WebGPURenderer` (WebGPU and forced WebGL2 backends) in the pinned
  Chromium here (SwiftShader) and record: what works headless, frame time,
  what breaks. Decide how tests run WebGPU here (fallback adapter or
  WebGL2-only with WebGPU unit coverage) and log it. Check the export
  bundle-size impact and the export scan rules (`exporter/src/scan.ts`).

### 17.1 Renderer abstraction

- One renderer factory in three-adapter used by Play/export, the Scene view
  and previews: backend `auto | webgpu | webgl2`, with the chosen backend
  and the reason in diagnostics (`tl_diagnostics`, the Play HUD debug line)
  and a project setting / URL flag to force WebGL2. Context/device loss
  handling for both (the existing WebGL context-loss behaviour is the
  contract: see `three-adapter/src/context-loss.test.ts`).

### 17.2 Materials and lighting in TSL

- Port every shader type of the material library to node materials (TSL):
  standard, foliage wind (vertex displacement from COLOR_0 and global wind),
  kit (world-X UV, macro normal), unlit, water; lightmaps (UV1, range
  scaling); the selection highlight and checkpoint glow without touching
  shared materials (9.4 rule).
- Pixel-comparison tests: each shader type renders within a tolerance of
  the WebGL reference images captured before the port (capture them first).

### 17.3 Environment and post in TSL

- Sky modes (physical, gradient, colour, texture equirect/cube — keep the
  upright-sky fix and its e2e), fog and fog volumes, PMREM, shadows
  (including the follow-camera shadow), and the post stack on three's node
  post-processing (`PostProcessing` + TSL passes): AO, DOF, bloom,
  grading/LUT/vignette, SMAA/FXAA, tone mapping (AgX/ACES/Neutral),
  per quality level.
- e2e: `environment`, `lights`, `lightmaps`, `sky-texture`, `materials`,
  `textures` pass on the forced WebGL2 backend (and WebGPU if 17.0 found a
  way); pixel checks as today.

### 17.4 Switch over

- Scene view, previews, Play and export use the factory with `auto`;
  `WebGLRenderer` code paths are archived (`git mv` to `archive/`).
- Thumbnails and the browser lightmap baker work on both backends.
- Performance smoke: the Sprout level and Beacon Reach frame times on both
  backends here recorded in §6 (real-GPU numbers: owner look pending).

### 17.5 Wrap-up

- `docs/deployment.md`: renderer backends, forcing WebGL2, browser support;
  STATUS row 17.

## 5. Progress

| Item | Status | Commits |
|---|---|---|
| 17.0 spike | todo | |
| 17.1 renderer factory | todo | |
| 17.2 materials in TSL | todo | |
| 17.3 environment and post in TSL | todo | |
| 17.4 switch over | todo | |
| 17.5 wrap-up | todo | |

## 6. Decision log

- 2026-09-24 (17.0): Spike done on a throwaway commit (`archive/spike-17/`, own Playwright config, not in the suites): Beacon Reach (template export) and Sprout Meadow 1 (a read-only live export) rebuilt from source with three-adapter patched at bundle time to render through `WebGPURenderer` (WebGPU, `forceWebGL`) and the post stack as a TSL `RenderPipeline` (bloom, vignette, SMAA), plus a neutral micro scene and a break probe. three stays 0.186.0: everything needed exists in it.
- 2026-09-24 (17.0): Headless WebGPU works in the pinned Chromium 151 (headless shell) with `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader` next to today's ANGLE/SwiftShader flags: Dawn's SwiftShader adapter (`isFallbackAdapter: true`). With `--enable-unsafe-webgpu` alone an adapter is returned but the device dies at first use ("Instance dropped in popErrorScope", black canvas). `navigator.gpu` exists only in a secure context (https or localhost): a plain-http LAN deployment always gets the WebGL2 fallback, so `auto` must test `navigator.gpu` + `requestAdapter()`.
- 2026-09-24 (17.0): Pixels are observable on both backends: `page.screenshot`, `canvas.toDataURL()` straight after `render()` (the screenshot relay path) and `readRenderTargetPixelsAsync` all return the rendered colours. Beacon Reach and Sprout Meadow 1 rendered recognisably on WebGPU and on WebGL2, with no page errors (screenshots checked).
- 2026-09-24 (17.0): Test decision: the default e2e launch stays as today (no WebGPU flags), so `auto` takes the WebGL2 backend and the whole suite covers the fallback. A second Playwright project `webgpu` (the three extra flags) runs the renderer-sensitive specs (materials, environment, lights, lightmaps, sky-texture, textures, play-export, the 17.1 renderer-diagnostics spec) with the same pixel checks. Vitest has no WebGPU in Node, so unit tests cover the factory's backend choice and the TSL node construction with stubs. The WebGPU project is slower here (see table): run it as its own step, not per test file.
- 2026-09-24 (17.0): Breaks (both backends): `onBeforeCompile`/`customProgramCacheKey` are silently ignored, so foliage wind, kit world-X UV + macro normal, water and the lightmap no-ambient hook are lost without an error. Seen in the Sprout screenshot: the kit dirt texture tiles per box, not world-aligned. `ShaderMaterial` logs "Material ShaderMaterial is not compatible" and draws nothing: the gradient sky, `Sky.js` and the post `ShaderPass`es (fog volumes, grading/LUT/vignette, FXAA). three's WebGL `PMREMGenerator` throws (`reading 'buffers'`); `three/webgpu`'s `PMREMGenerator` works, and so does an equirect texture as `scene.environment` (auto PMREM node). `EffectComposer` does not throw but is WebGL-only, so it gets replaced. The lightmap baker's sync `readRenderTargetPixels` does not exist; `readRenderTargetPixelsAsync` works. On the renderer, `capabilities`, `info.programs`, `forceContextLoss` and `capabilities.isWebGL2` are absent; `render()` throws before `await renderer.init()`. The default canvas is transparent (the page background showed through where WebGLRenderer cleared black), so the factory sets the clear colour/alpha explicitly.
- 2026-09-24 (17.0): Works unchanged under node materials (both backends): MeshStandard/MeshBasic via the automatic node conversion, `lightMap` on uv1 (`channel = 1`), SkinnedMesh, InstancedMesh, PCF directional shadows, Fog/FogExp2, `SkyMesh` (the TSL procedural sky), and node post `bloom`/`smaa`/`fxaa`/`ao` (GTAO)/`dof`. In r183 three renamed `PostProcessing` to `RenderPipeline` (the old name warns): 17.3 uses `RenderPipeline`.
- 2026-09-24 (17.0): Export scan: the `three/webgpu` build trips the export. Pattern e (`node:`) is strict 0 and gets 6 hits, all object keys in three's node code: `bufferData = { node: this }` ×2, `{ previousInstanceMatrix, node: createInstanceMatrixNode(…) }`, `{ previousMatricesTexture, node: createBatchingMatrixNode(…) }`, `node: buffer(previousBoneMatrices, "mat4", …)`, `node: getBoneTextureMatrices(…)`. Against the §5.4.1 record: `process.` 16 (record 3; the 13 extra are prose like "the build process."), `http://` 4 (record 3; +`http://www.jcgt.org/published/0008/01/03/` comment), `https://` 26 (record 23; +TSL wiki, cloudflare/workerd issue and MDN withCredentials doc links). `fetch(` 3, `XMLHttpRequest` 3, `WebSocket`/`file://`/`__dirname`/`/api/v1/`/`/mcp` 0 are unchanged. Fix in 17.1 (with a scan unit test): pattern e matches only module specifiers (`"node:`, `'node:`, `` `node: ``), which is the risk it guards; the reference build (binding 3) imports `three/webgpu` + `three/tsl`; the record table gets the new exact counts.
- 2026-09-24 (17.0): Export bundle size (pinned options, unminified / gzip): today's three core 1755 / 305 KiB; `three/webgpu` + `three/tsl` + node post 3191 / 595 KiB (about +1.4 MB / +290 KiB after the switch; minified 726 → 1162 KiB). During the transition, with both renderers linked, the Sprout export's `main.js` grows 5427 → 7406 KiB (gzip 1469 → 1851). `three` and `three/webgpu` share `three.core.js`, so classes are identical across both. 17.4 drops `three.module.js` and the EffectComposer passes. New `three/examples/jsm/tsl/display/*` and `objects/SkyMesh.js` imports need `check-boundaries` allowlist entries; `@types/three` 0.186 has typings for `three/webgpu`, `three/tsl` and the TSL display nodes.
- 2026-09-24 (17.0): Performance: on SwiftShader here, WebGPURenderer is slower than today's WebGLRenderer on both backends. The main cost in the simple scene is MSAA (`antialias: true`); with MSAA off the two backends are equal. Sprout with no post on WebGPURenderer matches today's WebGLRenderer with post. These are CPU-rendering numbers, not a GPU verdict (real-GPU numbers: owner look pending); keep MSAA a quality-level choice in 17.3.
- 2026-09-24 (17.0): Recommended porting order. 17.1: the factory with async `init()` (frames skip until ready), backend `auto | webgpu | webgl2` + reason, diagnostics from `backend.isWebGPUBackend`/`info.memory`, device loss (`onDeviceLost`) next to the WebGL context events, explicit clear colour, and the scan fix; WebGLRenderer stays the default. 17.2: capture the WebGL reference images first; standard, unlit and lightmaps come almost free; then kit (world-X UV, macro normal), foliage (COLOR_0 wind), water, and the highlight/checkpoint glow as per-mesh node overrides (9.4 rule). 17.3: the hard breaks first (PMREM → `three/webgpu`, `Sky.js` → `SkyMesh`, gradient/colour/texture skies), then fog, shadows and the follow shadow, then `RenderPipeline` passes: output/tone mapping, bloom, grading/LUT/vignette, SMAA/FXAA, AO, DOF, and fog volumes last (depth from `pass().getTextureNode('depth')`). The lightmap baker moves to `readRenderTargetPixelsAsync`. 17.4: switch to `auto`, archive the WebGL paths, rerun the table below.

Spike 17.0 results (pinned Chromium 151 headless, SwiftShader, 1280×720, rAF median ms per frame over ≥ 8 s after warm-up, two back-to-back rounds; load average 13–19 on 10 cores from parallel e2e runs, so compare only within a row). Beacon Reach shows its awaiting-start view (the scene renders every frame); Sprout is Meadow 1 playing, with texture sky, fog, bloom, vignette and SMAA.

| Scene | WebGLRenderer (today) | WebGPURenderer · WebGPU | WebGPURenderer · WebGL2 |
|---|---|---|---|
| Beacon Reach, MSAA on (default) | 16.7 / 16.7 (vsync cap) | 150 / 150 | 117 / 133 |
| Beacon Reach, MSAA off | 16.7 / 16.7 | 33 / 33 | 33 / 33 |
| Sprout Meadow 1, post on | 567 / 583 | 850 / 750 | 1050 / 767 |
| Sprout Meadow 1, no post | — | 550 / 450 | 567 / 433 |
| Sprout Meadow 1, MSAA off | 433 / 567 | 683 / 667 | 683 / 700 |
| Micro scene (200 lit boxes + 400 instances, PCF shadows, MSAA), single run | 64 | 250 | 316 |
| Micro scene, 20 boxes, no shadows, no MSAA, single run | 120 (load spike) | 86 | 69 |
