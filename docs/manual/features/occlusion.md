# Occlusion culling

Occlusion culling leaves out of the view what something solid in front of
it hides: the houses behind a wall, the scatter behind a hill, the props in
a room the camera cannot see into. The picture stays the same; the GPU has
less to draw. It needs WebGPU: on WebGL 2 everything in view is drawn. Shadows, the surface cache's traced light, the probes and the
cached static shadow always see everything, so a hidden object's shadow
still falls where you can see it.

## When it pays

It pays where much is drawn and much of it is hidden: a street between
buildings at eye height, a valley with a hill in front of dense scatter or
ground cover, a town seen through gaps. It saves little in an open view
(nothing is hidden), in small scenes, and in interiors whose rooms already
cull through their portals ([Rooms drive culling and lighting](architecture.md#rooms-drive-culling-and-lighting)):
what the rooms hide is never tested again.

What is tested is worth it by size: a draw needs at least
[`OCCLUSION_MIN_TRIANGLES`](../reference/limits-runtime.md#limit-occlusion-min-triangles)
triangles (an instanced draw: its copies in view together), and a draw
tested whole may cover at most
[`OCCLUSION_MAX_SCREEN_SHARE`](../reference/limits-runtime.md#limit-occlusion-max-screen-share)
of the view's height. Many small props stay drawn: testing them would cost
what drawing them does. What moves its vertices past its bounds with no
known limit (skinned and morphed meshes, a material graph's vertex offset or
displacement) is never culled; wind on foliage is, with its bounds grown by
how far the wind bends it now.

For a game:

- **Walls, terrain, block layers and generated architecture** hide by
  themselves and are drawn first. Solid buildings and hills between areas
  are where culling pays most.
- **Instance sets** (scatter, ground cover, kit copies) are culled copy by
  copy on WebGPU: dense foliage behind a hill is the biggest saving.
- **Thin or see-through things** (a hedge, a fence, a lattice, glass) hide
  nothing unless they have an `_OCC` stand-in (below). Give one to large
  ones that stand between areas; small ones are not worth it.

## The setting

**Project Settings → Quality → Rendering → Occlusion culling**
([`occlusion_culling`](../reference/content-blocks-settings.md#content-settings):
0 off, 1 auto, 2 on). A project that does not set it uses **auto**, which
for now culls nothing: in the scenes measured so far the
culling cost an open view more than it saved (the frame drawn in two passes
and the depth pyramid cost the open village about 0.6–0.8 ms, and its frames
are bound by the main thread, not by the draws culling leaves out). **On**
culls; turn it on where you measure a gain: a dense town between streets, a
forest behind a hill. **Off** draws everything in view. The picture is the
same either way.

A quality level may set its own
([`qualityLevels[].occlusionCulling`](../reference/content-blocks-environment.md#content-environment):
`off`, `auto` or `on`; absent: the project's setting). MCP:
`setSettings {occlusion_culling: 2}` and `setEnvironment` with a level's
`occlusionCulling`.

## How it culls

**On** culls with a depth pyramid on the GPU (`hiz`, WebGPU). The frame
draws in two passes. The first draws what was seen last frame; a compute
pass builds a pyramid of the farthest depth from it; the GPU tests the rest
against it and the second pass draws what shows. Nothing seen is ever left
out, also when the camera moves fast.

**WebGL 2 culls nothing.** It can only ask the GPU afterwards whether a box
round a draw showed any pixel; those answers come frames late and saved too
little to pay for themselves, so the engine has no WebGL 2 path. With the
setting on, a game drawn with WebGL 2 (`render_backend` 3, or a browser
without WebGPU) draws everything in view, and Play reports it once in
**Problems** (`occlusion_culling_unavailable`).

## `_OCC` stand-ins

A model's `<piece>_OCC` node (beside its `_LOD<n>` and `_COL` nodes) is a
simple solid mesh that counts as what hides in place of the model's own
surfaces: a box inside a hedge of leaf cards, a slab inside a glass wall. It
is drawn only into the depth culling tests against: never in colour, never
in shadows, never picked.

**Whatever a stand-in covers counts as hidden.** Anything seen through the
model where the stand-in is, through a hedge's gaps between leaves or
through glass, is culled while the stand-in is in front of it: it
disappears. Give a stand-in only to models whose see-through parts nobody
looks through (a dense hedge, frosted or dark glass), and keep it inside the
model's surfaces.

- **The import check:** a stand-in is ignored and named in **Problems**
  (`model_occluder_ignored`) when a vertex lies more than 1 mm outside its
  piece's LOD0 bounds, or when, seen along any axis from either side, it
  covers a place where the piece's LOD0 triangles are not (an opening in an
  arch, the notch of an L-shaped piece, the gap between two posts) or stands
  in front of them (checked on a grid of `OCCLUDER_COVERAGE_TEXELS` texels
  along the piece's longest side, with a texel's slack). What the
  check cannot see is a texture's cut-outs and see-through materials: those
  are the author's choice, as above.
- **The model's import setting `occluder`** (asset inspector, MCP
  `setAssetOptions {assetId, occluder}`): `auto` (the default) uses the
  `_OCC` nodes where a piece has any, else its opaque surfaces; `occ` only
  the `_OCC` nodes; `none` nothing.

How to author one: [Trim sheet spec: occluder stand-ins](../guides/trim-sheet-spec.md#occluder-stand-ins-_occ).
More on the node: [Assets: occluder stand-ins](assets.md#occluder-stand-ins-_occ).

## An object that hides nothing

A box's or model's **Occluder** field (Inspector; `occluder: false` in MCP
and `createEntity`) keeps it from hiding anything, its stand-ins too: for a
moving door, a curtain, a prop you want everything behind to stay drawn
for. It is still culled itself when something hides it. Transparent,
alpha-tested and double-sided materials never hide anything.

## In the editor

The Scene view culls as Play does (with the project's setting on). Its **View** menu turns culling off for
the view only (**Occlusion culling**), boxes what is culled now (**Show
culled draws**) and shows the depth pyramid (**Depth pyramid**, WebGPU).
The selection and what an edit mode edits are never culled. See
[the editor](editor.md).

## URL switches

On the game page (an export's `index.html`) or the editor's URL (passed on
to Play and used by the Scene view):

| Switch | What it does |
|---|---|
| `?occlusion=off` | draws everything in view |
| `?occlusion=hiz` | the depth pyramid path, whatever the setting (WebGPU; on WebGL 2 it culls nothing) |
| `?occlusion=pyramid` or `pyramid:<level>` | shows the depth pyramid (level 0 by default) instead of the picture |

The performance harness compares with `--switches occlusion=hiz` (or `occlusion=off` where a project turned it on)
([Performance](performance.md)); `--oracle` counts how much of a view is
hidden, the most culling could save.

## Diagnostics

- **Play diagnostics** (`tl_diagnostics`): `renderer.occlusion` gives the
  setting, the path and who chose it, the draws that could be culled (by
  kind and role), tested and culled, `_OCC` stand-ins drawn, the GPU and
  main-thread time, and the pyramid's size and memory.
- **Scripts:** `ctx.stats.occlusion` `{path, tested, culled}`.
- **The export's canvas** carries
  `data-tl-occlusion="<path>|<occludees>|<tested>|<culled>|<stand-ins>"`.
- On WebGPU tested and culled are read back from the GPU, a few frames late.
