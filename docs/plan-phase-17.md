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
