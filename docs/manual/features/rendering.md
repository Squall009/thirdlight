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
standard, foliage wind (COLOR_0 + the scene's wind field: [Wind](environment.md#wind)), kit (world-X UVs, the
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
[Ambient occlusion, render scale and dynamic resolution](debugging.md#ambient-occlusion-render-scale-and-dynamic-resolution)).

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

## See-through

What stands between the camera and a **subject** (the player, a unit) thins
to a dither in a soft circle round it, so rooms, doorways and paths behind
walls stay readable while the rest of the scene is drawn as before: the
occluder fade (x-ray) of isometric and third-person games. It is a camera
feature and works on everything drawn: boxes, models, characters, instance
sets, block layers, terrain, generated architecture, scatter copies, decals
and graph materials. It does not hide whole zones; that is what a block
layer's [cut-aways](blocks.md#block-layers) do, and the two combine
(see [the interiors guide](../guides/interiors.md)).

**Turning it on.** Project Settings → Quality → Rendering (MCP:
[`setSettings`](../reference/ops-detail.md#op-setSettings)):

| Setting | Key | Default | |
|---|---|---|---|
| **See-through** | `see_through` | 0 (off) | 1: on in Play and the export |
| **See-through radius** | `see_through_radius` | 0.2 | the circle's radius as a share of the view's height at the subject; never less than 0.75 × the subject's height, so it covers the body when zoomed in |
| **See-through softness** | `see_through_softness` | 0.4 | the share of the radius the edge softens over (0: a hard edge) |
| **See-through max fade** | `see_through_max_fade` | 0.75 | how far what is in front thins at most (up to 0.95) |
| **See-through depth margin** | `see_through_depth_margin_m` | 0.25 m | metres a surface must be nearer the camera than the subject's body, measured along that pixel's own view ray (what the subject touches stays solid) |
| **See-through fade time** | `see_through_fade_s` | 0.25 s | how long the fade eases in or out round a subject (0: at once) |
| **See-through padding** | `see_through_padding_m` | 0.3 m | metres the space from the camera to the subject's body is widened by when its occluders are found (larger: pieces just beside the line of sight fade too) |

The defaults and ranges are `SEE_THROUGH_DEFAULTS` and `SEE_THROUGH_LIMITS`
in [the limits reference](../reference/limits-project-model-2.md#limits-project-model--see-through).

**What fades: only true occluders.** Each frame (only when the camera or a
subject moved) the engine finds what really stands between the camera and
each subject: the space from the camera to the subject's body (its capsule),
widened by the padding and ending at the body. A block layer's hits are
grown into whole pieces (a wall run, a pillar, a slab), so a whole wall in
front fades, not a ragged part of it; a placed model counts by its bounds
(a merged cell or an instance set by each member's own). A pixel then
fades only when all of these hold: it belongs to one of the subject's
occluders, it is inside the subject's circle (centred on the middle of its
body), it is nearer the camera than the body **along its own view ray** by
more than the depth margin, and it is **higher than half the subject's
height above its feet**. A subject's height is its character controller's
capsule, else the bounds of its meshes. So under a pitched follow camera a
wall 0.3 m or 1 m behind the subject, or one beside it, stays solid even
though the circle covers it; only the wall in front dithers. The height
rule is the same everywhere, in a side view, from above and in 3D, in
every project kind: floors, ground and anything low round the subject never
fade. On a multi-storey level a character on the stairs fades the slab of
the storey above, never the one it stands on or those below; walking up
hands the fade to the next slab up. Each occluder fades in and out over the
fade time on its own. The shader holds `SEE_THROUGH_OCCLUDERS` (6) boxes per
subject, a GPU constant, not a cap: when more pieces stand in front, the
nearest boxes merge, so none is ever left out.

**A dither, never gone.** The fade stops at the max fade (below 1), so a
wall, a door or a tree in front stays visible as a see-through pattern. All
fades share one dither pattern: a faded wall behind another faded wall is
hidden by the front one's kept pixels, so what is in front is never thinner
than the max fade, however many layers stand there. The cut-away's fading
zones use the same pattern, so a pixel both fade is thinned as the larger
of the two.

**Subjects.** By default the subject is the live
[virtual camera](scenes-and-cameras.md#cameras-virtual-cameras)'s target (a
camera without a target fades nothing). A script names any objects instead
with `ctx.camera.setSeeThrough({subjects: [ids]})` (below). Each view fades
round the subjects nearest the camera, up to `SEE_THROUGH_SUBJECTS` (4): the
size of the shader's subject array, a GPU constant, not a cap on the
project. Ask for more and the farthest are left out, with one Problems line
`see_through_subjects`. A subject never fades itself or its children; while
it is a subject it is drawn on its own, out of any automatic batch or merged
cell (a draw or two), and it rejoins once its fade has gone.

**Opting out.** Everything takes part unless it says otherwise: the
**See-through** checkbox (`seeThrough: false`) in the Inspector section of a
box, a model, an instance set, a block layer (per layer), terrain and an
architecture object (its rooms' walls, floors and ceilings follow it), and
the toggle on a scatter rule's card (`seeThrough` on the
[rule](../reference/types-p-t.md#type-scatter-rule)). Off draws it solid
always: a sign that must stay readable, a glass case. It is a per-draw
value, so it adds no shader per object, and automatic batching and merged
statics keep objects that opt out apart from the rest.

**Shadows** are unaffected: a faded wall still casts its full shadow, and
the shadow maps never take the mask.

**Scripts.** `ctx.camera.setSeeThrough({enabled?, subjects?, radius?,
softness?, maxFade?, depthMargin?, fadeTime?, padding?})` (the visual-script node
**Set see-through**) changes it while the game runs. Each field is optional;
the rest stay as the project or an earlier call set them, numbers are
clamped to their ranges, and a wrong argument changes nothing and returns
`false`. `subjects: null` or an empty list goes back to the camera's
target. The change lasts until a new run (loading a scene keeps it) and is
simulation state like the rest of the camera, so replays and the simulation
worker give the same view; `tl_game_observe` shows it as
`camera.seeThrough` once a script set it. See
[Scenes and cameras](scenes-and-cameras.md#cameras-virtual-cameras).

**The setting decides what is built.** With Rendering → See-through on,
Play and the export build every shader with the mask at load (a draw no
subject can reach skips it), so a script can turn see-through off and on at
any time without a hitch. A game that wants it only in some places keeps
the setting on and turns it off from a script at the start; the fade's
easing hides the first frame. With the setting off nothing is built and
nothing is paid, and a script that turns it on anyway makes every shader be
built again in the middle of the game: the picture holds meanwhile (about
half a second on a large interior, a frame or two missed) and Problems says
once `see_through_rebuild`, with the fix (turn the setting on).

**In the editor.** The Scene view's **see-through** toolbar switch (beside
the light switch, so it stays in reach in the full-screen edit modes)
previews it with the project's settings round the selected object — a box,
a model, a character or an object with drawn children — and otherwise round
the target of the enabled virtual camera with the highest priority; in the
edit modes, which select nothing, that camera's target. The switch only
changes the view: it starts off on each page load and nothing is stored.
As in Play, the project's setting decides when the view's shaders get the
mask: with it on, at load, so the switch costs nothing; with it off, the
first switch-on builds every shader of the view again (a short hold).
Switching the preview off keeps them (the view then pays what Play pays
with the setting on while nothing fades) rather than holding again to
build them back.

**Comparing.** `?seethrough=on|off` on an export's URL, or on the editor's
for its Play (the Scene view's preview has its own switch), pins it on or
off over the project, the host and scripts; `off` also builds the shaders
without the mask, as a project with the setting off (see
[the switches](performance.md#performance)).

**Cost.** Measured with 4 subjects on an Iris Xe at 1920 × 1080 at the 60 Hz
cap, both renderers: no added draws, no added shaders after load, p95
16.7–16.8 ms and no missed frames, as with see-through off. Finding the
occluders on the main thread: about 0.1 ms a frame on WebGPU (0.27 ms on
WebGL 2) in the village with three subjects moving. GPU time (WebGPU
timestamps): the village's open view costs nothing measurable; a two-storey
interior (rooms stacked, stairs, 800 props, seen from above like a follow
camera) costs **1.43 ms** with see-through on against off, of which 0.41 ms
is the shaders carrying the mask while nothing fades (paid by every project
with the setting on). Before the true-occluder rule the same interior cost
0.90 ms (0.23 ms idle): the box tests for each pixel inside a circle are
the extra price of never fading what is behind. Both are over the engine's
soft 0.3 ms target (D297 in the audit list); whether the truer look is worth
the ~0.5 ms is the owner's call. On WebGL 2 the GPU process time moved by no
more than ±0.2 ms. A script turning it on with the setting off costs the
rebuild above.
