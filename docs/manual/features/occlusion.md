# Occlusion culling

Occlusion culling leaves out of the view what something solid in front of
it hides: the houses behind a wall, the scatter behind a hill, the props in
a room the camera cannot see into. The picture stays the same; the GPU (and
on WebGL 2 the main thread) has less to draw. Shadows, probe bakes and the
cached static shadow always draw everything, so a hidden object's shadow
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
triangles, one culled on the GPU at least
[`OCCLUSION_MIN_COPIES_TRIANGLES`](../reference/limits-runtime.md#limit-occlusion-min-copies-triangles)
in view, and a draw tested whole may cover at most
[`OCCLUSION_MAX_SCREEN_SHARE`](../reference/limits-runtime.md#limit-occlusion-max-screen-share)
of the view's height. Many small props stay drawn: testing them would cost
what drawing them does.

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
([`occlusion_culling`](../reference/content-blocks-effects.md#content-settings):
0 off, 1 auto). A project that does not set it uses **auto**: it draws the
same picture, so an existing game keeps its look. Off draws everything in
view.

A quality level may turn it off for itself
([`qualityLevels[].occlusionCulling`](../reference/content-blocks-environment.md#content-environment):
`off` or `auto`; absent: the project's setting). MCP:
`setSettings {occlusion_culling: 0}` and `setEnvironment` with a level's
`occlusionCulling`.

## The two paths

**Auto** picks a path by renderer:

- **WebGPU: a depth pyramid on the GPU (`hiz`), on.** The frame draws in two
  passes. The first draws what was seen last frame; a compute pass builds a
  pyramid of the farthest depth from it; the GPU tests the rest against it
  and the second pass draws what shows. Nothing seen is ever left out, also
  when the camera moves fast.
- **WebGL 2: occlusion queries (`queries`), off.** WebGL 2 can only ask the
  GPU afterwards whether a box round a draw showed any pixel. The answers
  come frames late (two at 60 Hz, 20–60 frames uncapped), so a moving camera
  could miss something for a frame or more, and each box costs about what the
  draw it replaces costs. So auto culls nothing on WebGL 2. The queries can
  be turned on for one page with `?occlusion=queries`, for a comparison.

## `_OCC` stand-ins

A model's `<piece>_OCC` node (beside its `_LOD<n>` and `_COL` nodes) is a
simple solid mesh that counts as what hides in place of the model's own
surfaces: a box inside a hedge, a slab inside a lattice wall. It is drawn
only into the depth culling tests against: never in colour, never in shadows,
never picked. Keep it inside the model: whatever it covers counts as hidden.

- **The import check:** a stand-in with a vertex more than 1 mm outside its
  piece's LOD0 bounds is ignored and named in **Problems**
  (`model_occluder_ignored`).
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

The Scene view culls as Play does. Its **View** menu turns culling off for
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
| `?occlusion=hiz` | the depth pyramid path (WebGPU; on WebGL 2 it culls nothing) |
| `?occlusion=queries` | the occlusion queries (WebGL 2 only) |
| `?occlusion=pyramid` or `pyramid:<level>` | shows the depth pyramid (level 0 by default) instead of the picture |

The performance harness compares with `--switches occlusion=off`
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
