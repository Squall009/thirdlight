# Rendering

## Renderer backends

Play, the exported game, the Scene view, the asset/Animator previews, the
asset thumbnails and the browser lightmap baker get their renderer from one
factory. Everything draws with three's `WebGPURenderer`, all shading
written once in TSL (node materials and node post-processing); three's
older `WebGLRenderer` is not used. Three backends:

| Name | What draws | |
|---|---|---|
| `auto` | WebGPU when the browser gives a working adapter and device within 5 s, else the WebGL 2 backend | the default |
| `webgpu` | WebGPU (the adapter gets up to 30 s); where WebGPU cannot start it runs on WebGL 2 and says why | |
| `webgl2` | the WebGL 2 backend, even where WebGPU would work | |

Choose one in **Gameplay → settings → Renderer** (the `render_backend`
project setting: 1 auto, 2 WebGPU, 3 WebGL 2; MCP:
`setSettings {render_backend: 3}`). The Scene view switches at once; the
next Play and the next export use it. A URL flag overrides the setting for
one page: `?renderer=auto|webgpu|webgl2` on the editor URL (the editor
passes it on to Play) or on an exported game's `index.html`. To force WebGL 2
(an older GPU driver, a WebGPU bug, comparing the two), set the setting to
"WebGL 2" or add `?renderer=webgl2`. A project that stored 0 (the removed
WebGL renderer, "legacy") and an old `?renderer=legacy` link get `auto`.

Browser support: WebGPU needs a browser with WebGPU and a secure context —
https, or `localhost`/`127.0.0.1`. Every other page (plain http on a LAN
address, a browser without WebGPU) gets the WebGL 2 backend at once, with the
reason; a browser without WebGL 2 cannot draw (Play reports
`render_unsupported`).

What was chosen and why is shown in the status bar ("scene view: …", the
reason as its tooltip), in the Play label above the game, in
`tl_diagnostics` (the play's `renderer.renderer` block: requested backend,
where the choice came from, the backend that draws, its state and the
reason), in `tl_game_observe` (`renderer`) and on every render canvas
(`data-tl-renderer`, `data-tl-renderer-state`, `data-tl-renderer-reason`).

If the GPU device is lost the
renderer is rebuilt on a new one (at most 3 times, then it reports `failed`:
reload the page); a lost WebGL context is rebuilt when the browser restores
it.

Project materials draw the same on both backends: the material library
builds node materials (TSL) for each shader type —
standard, foliage wind (COLOR_0 + the global wind), kit (world-X UVs, the
UV1 macro normal), unlit, water — and lightmaps (UV1, the bake's range, the
lights a bake holds left out), the Scene view's selection tint and look
overrides work there too. A pixel test compares each against the
reference images the old WebGL renderer drew (`tests/e2e/shader-parity/`).

The environment draws the same on both backends too: every sky
mode (physical — three's TSL sky —, gradient, colour, texture as an equirect
image or six cube faces) with its image-based lighting, fog, fog volumes
(with the height falloff), shadows (also the square that follows the camera
in games without level bounds) and the whole post stack per quality level —
ambient occlusion, depth of field, bloom, grading with lift/gamma/gain, the
LUT and the vignette, SMAA/FXAA and AgX/ACES/Neutral tone mapping — as
three's node post-processing. A level's own look works the same. A pixel
test compares 21 environments with the old WebGL renderer's reference images
(`tests/e2e/env-parity/`). Differences from the old WebGL renderer you may
see: scene fog is mixed before tone mapping (the WebGL renderer mixed it
after when there was no post stack), so its tint is a little different;
ambient occlusion has a different noise pattern and depth of field a
slightly different blur shape; the low quality level also turns MSAA off.
A game view (Play, the export, the Scene view) renders one drawing-buffer
pixel per CSS pixel on any display, so a HiDPI or scaled screen costs no more
than a plain one. Under a post stack the scene is drawn without MSAA (the
stack's SMAA or FXAA anti-aliases) and ambient occlusion at half resolution
(it darkens only the indirect light: see the render settings in
[Deployment: Test and debug entry points](../../deployment.md#test-and-debug-entry-points-phase-238)).

**Shadows.** Boxes, models and instance sets cast and receive
the sun's (the directional light's) realtime shadow when the light has "Cast
shadows" on. Each has **Casts shadows** and **Receives shadows** checkboxes
in its Box / Model / Instance set section (on by default for boxes and
models — turn them off for a decal, a glow or a distant backdrop; an
instance set casts only when it says so, see
[Performance](performance.md#performance)). The sun's shadow is tuned in its Light
section: **Shadow map size** (512–4096, default 1024), **Shadow bias**
(default −0.0005), **Shadow normal bias** (default 0.02 m) and **Shadow
extent** (half the side of the shadowed square that follows the camera in a
game without level bounds, default 24 m).
The Scene view shows no realtime shadows (Play and the export do).

The gradient sky is drawn inside every camera's far plane and tone mapped
like the rest of the picture. The browser lightmap baker ("Bake preview")
draws with the editor's renderer backend (it reads the atlases back
asynchronously), and a lightmapped object in Play picks up its
project material's texture even when the texture arrives after the
lightmap.

Kit materials apply their macro normal map. Thumbnails render with the backend the editor had
when it drew the first one.

Exported games link only three's WebGPU build (`three/webgpu`, which carries
the whole three core, plus TSL); three's WebGL renderer code is not in the
bundle.
