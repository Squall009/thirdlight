# Voxel worlds

A **voxel world** is ground and buildings made of cells half a metre on a
side, streamed round the camera while a scene that names it is loaded. A
game digs, builds and paints it at run time; the editor and AI agents edit
its files through two commands. This page says what a world is, how it is
set up, streamed, shown at a distance and edited, and what is not built yet. Scripting
it: [Script a voxel world](../guides/voxel-scripts.md). Next to block
layers and terrain: [the migration note](migration.md#voxel-worlds-beside-block-layers-and-terrain).

## What a voxel world is

- **Cells.** Every cell is 0.5 m on each side, the same everywhere in the
  world. Cell 0 sits at the world origin: a world does not move with the
  object that names it. A world reaches about ±16 km across and ±4 km up
  and down; empty sky and depth cost nothing.
- **What a cell holds.** One value with four fields:
  - **material** — 0 is air (the whole cell is then empty), 1 to 4,095 a
    material id: what the surface looks like;
  - **role** — what the cell is for: 0 air, 1 terrain, 2 liquid, 3 wall,
    4 floor, 5 roof, 6 foundation, 7 stair, 8 pillar, 9 opening (a door's
    or window's gap: open like air, but the edge pieces round it are cut
    flush with its faces, so nothing stands in the doorway; a dug hole is
    air and its edges are dressed as any other). Edges, corners and roof edges are not
    roles: they follow from how the cells are arranged. Beams and banisters
    are not part of voxel worlds: cells laid as one are plain voxels. What
    collides, blocks walking and lets light through is the cells, never the
    look of a kit's piece;
  - **shape** — 0 to 15. For terrain and liquid, how full the cell is (15
    full), so ground can slope and round off instead of stepping. For the
    building roles (wall, floor, roof, foundation, stair, pillar) it is the
    cell's **integrity**: 15 intact, lower damaged (see *Damage* under
    [Voxel kits](#voxel-kits)); a building cell is always a whole block;
  - **wetness** — 0 (dry) to 7: as it rises the surface darkens, gets
    smoother and loses its fine relief, and water fills the low parts of its
    texture first (the cracks between stones, then more) until level 7
    stands as water in the low parts.
- **What a change rebuilds.** Shape and role change the world's form: its
  meshes and colliders are rebuilt round the change. Material and wetness
  only change how it looks: only the surface's shading data is rebuilt, no
  mesh or collider (rain over a whole valley is cheap).
- **How a surface is textured.** Terrain is projected from three axes, one
  repeat every 2 m. Walls, floors, roofs and the other building roles are
  mapped from the build grid in metres, one repeat every 4 m both ways (a
  full-size wall): a band of the texture sits at the same height on every
  wall, floors line up across the world, and a roof's texture runs up its
  slope, parallel to the eave. The voxel world page shows this with
  `?bands=1` (lines every 0.5 m, a thick red one at 0 m and a blue one at
  2 m of each 4 m tile, metres written beside them).
- **Files.** A world is the project folder `voxels/<world>/`: a
  `world.json` naming its region files and revision, and its region files
  (256 m a side each; inside them, chunks of 16 m). A region the world does
  not list is air. Scripts and the editor never see these files; they read
  and write cells.
- **Authored and runtime changes.** The files are the world as authored.
  While a game runs, its changes are kept apart from them, over the files,
  and are dropped when the game quits; what survives is what the game
  saves ([saves](../guides/voxel-scripts.md#save-and-restore)). The editor's
  commands, by contrast, write the files.

Thirdlight has no command yet to create a world or to turn terrain and
block layers into one (that comes with the converters, later). The worlds
there are today are written by tools: the engine's own test world comes
from `node tools/voxel-bench/run.mjs slice-world --project-dir <project>`.

## The `voxelWorld` component

Put a **Voxel world** component (**+ Add component → Voxel world**) on an
object of a scene; the world streams while that scene is loaded and goes
when it unloads ([`ctx.scenes`](../reference/script-api.md#ctx-scenes) is
how a game changes levels). All its fields:
[`voxelWorld`](../reference/components-rendering-2.md#component-voxelWorld).

| Setting | Default | What it does |
|---|---|---|
| **World** (`world`) | — | The folder's name, `voxels/<world>/` (lower-case letters, digits, `-` and `_`). |
| **Load ring** (`ring`) | 192 m across, 96 m up and down; goes past 224 m / 128 m | Where chunks load round the focus, and how far past that a loaded chunk may be before it goes (so a camera at the edge does not load and drop the same chunks). An unload distance below its load distance is taken as the load distance. |
| **Collision ring** (`collision`) | 48 m across, 24 m up and down | Where loaded chunks have colliders. Further out the world is only drawn. Never reaches past the load ring. |
| **Detail levels** (`levels`) | full detail to 64 m, 1 m voxels to 128 m, 2 m voxels past it; relief to 16 m | How far the world is drawn at full detail (`level0`, 0.5 m voxels, with its kit pieces: this is also the detail-piece ring) and at 1 m voxels (`level1`); past that, 2 m voxels to the load ring. Full detail always reaches 8 m past the collision ring, so what a character touches is what is drawn. Where a coarser level is not built yet (the far edge of the load ring), the finer one stands in. A level-1 distance below the full-detail one is taken as it. Within `relief` of the focus (0: none; never past full detail) surfaces are drawn with [relief](#relief). |
| **Per quality level** (`quality`) | — | By quality level id: a `scale` of the distances above at that level, or distances of its own (`ring`, `collision`, `levels`; each one set replaces the scaled one). A level the scene does not name scales by its own **Voxel ring scale** (below). |
| **Section edge** (`sectionEdge`) | 16 | Cells along the edge of the pieces a chunk is rebuilt in after a change (8, 16 or 32): smaller rebuilds less a change, larger draws fewer pieces. Leave it at 16 unless you measure. |
| **Saved fields** (`savedFields`) | material, role, shape | Which fields of the game's changes a save keeps. Wetness is left out by default: weather sets it again. A script can change it for a run (`ctx.voxels.setSavedFields`). |
| **Decal layers** (`decalLayers`) | every layer | The [decal layers](decals.md#decal-layers) the world's surfaces and kit pieces are in: a decal marks them when its layers share one. A draw setting: changing it reloads nothing. |
| **Material blend** (`blendMetres`) | 0.25 m | Metres over which neighbouring voxel materials blend where neither sets its own (`voxel.blendMetres`, below), 0 (hard cell lines) to 0.5 m (one cell); where two meet the smaller wins. A draw setting: it changes live, nothing is remeshed. |

Settings you leave empty follow the engine's defaults, so a later default
reaches every world that did not set its own. The component is not allowed
on prefab objects (a world streams per scene). One object names one world.

**Distances by quality level.** Every distance above (load, collision, the
detail levels) is scaled by the quality level the player runs: the level's
**Voxel ring scale** (`voxelRings` on a
[quality level](../reference/content-blocks-environment.md)), else its
lighting tier's — low 0.71, medium 1, high 1.41 (an integrated GPU such as
the Iris Xe starts at medium, where the defaults were measured), so the area loaded grows as
the tier's stream memory budget does (256 MiB, 512 MiB, 1 GiB, which the
world takes at that level). A tier never scales the load ring and the
level-1 distance under 1: past them the far field draws in 2 m cells, which
turn buildings into blobs until they are far enough to be small on screen. A scene sets its base distances (an indoor
scene small, a large outdoor one large) and, where it needs, its own scale
or distances per level (`quality`). A world opens at its scene's own
distances; once the game page reports its quality level (within half a
second), the distances and the budget follow it, and again whenever the
player changes the level, without a reload.

**Changing distances while the game runs.** A script reads the distances in
use with `ctx.voxels.rings()` and changes the scene's with
`ctx.voxels.setRings({ ring?, collision?, levels? })` (metres, `levels.relief`
included; each field it
gives replaces the scene's, the rest stay; `setRings(null)` goes back to the
component's own). The quality level still applies on top, and a distance the
scene sets for the running level wins over it. The change applies without a
reload: the levels drawn change in one swap between two frames, chunks past
a smaller load ring go (their colliders with them) and those inside a larger
one load. A field out of range refuses the whole change (`reason:
'invalid'`).

- **Two objects naming the same world** in the loaded scenes share one
  world, with the settings of the first to arrive; the Console warns when
  the second's settings differ.
- **Reloading the scene** that holds the world (`ctx.scenes.reload`) opens
  it again from its files: the game's changes go, as on a restart.
- **A world that cannot be opened** (no such folder, a damaged manifest)
  warns once in the Console and reads as not loaded; it holds nothing up.

### Props that block light

A model's **Affects lighting** (`affectsLighting`, on the
[model component](../reference/components-rendering-1.md#component-model))
marks it as blocking light in a voxel world: its collider's shape (else the
box of its model) is stamped into the world's light coverage, never into
its cells and never into a save. Turn it on for large static props
(boulders, trees), leave it off for small ones. Scripts read the result
with `ctx.voxels.coverageAt`. Nothing draws from it yet: the world's own
lighting comes later.

## Streaming and memory

- **The focus.** A world loads round where the live camera looks (its
  target, else the camera itself); with no camera, round the first object
  naming the world. Colliders are kept round the focus and round every
  player character, so a character far from the camera still stands on
  built ground.
- **Nothing to fall through.** A character over voxel ground that has not
  loaded yet waits there until the ground's colliders are in, then lands.
- **Reads.** Chunks are read from the world's files nearest first, a ring
  of ground ahead of a moving camera read before it gets there. Loading,
  decoding and building meshes happen in background workers; drawing
  happens on the page.
- **One memory budget a world** (256 MiB, the low-end machine's budget, until
  the page reports its quality level; then the level's tier's, above)
  holds everything the world keeps: its loaded cells, the game's changes,
  the meshes and shading data of every distance level, and the colliders at what the physics engine
  spends on them. Over budget, the farthest chunks go first, and loading
  stops short of them until there is room again. The game's own changes are
  never dropped to make room (a chunk that leaves gets them back when it
  loads again): a game that changes a great deal keeps a smaller ring
  loaded instead. This budget is the
  world's own, apart from the project's streaming budget for terrain tiles
  and block chunks ([streaming and budgets](../concepts/streaming-and-budgets.md)).
- **There is no count limit** on a world's size, chunks or changes; the
  budget is the only bound.
- **Far from the origin.** Voxel draws stay steady kilometres out (each
  chunk is placed relative to the camera in double precision); physics
  stays in world coordinates.

## Distance levels

A world is drawn in less detail the further it is from the camera and the
player characters, so a large view costs a fraction of drawing every cell:

- **Three rings.** Within 64 m (by default, at the low tier) the world is
  drawn at full detail, from its 0.5 m cells. Out to 128 m it is drawn as if
  its cells were 1 m, past that as if they were 2 m, up to the load ring. Set
  the distances with the component's **Detail levels** (`levels`); the quality
  level scales them (above). A ring is measured
  across the ground from the camera's focus and from every player character,
  and full detail always reaches 8 m past the collision ring.
- **What a game sees.** Far away the shapes are coarser: a slope or a cliff
  keeps its line, small bumps, one-cell spikes and pits leave, and a
  one-cell wall, floor or roof is drawn as thick as the level's cell, so a
  house keeps its walls and roof and looks a little larger. A sloped roof
  stays one smooth slope at every distance, its eaves at one height. Kit
  pieces (edges, corners, roof edges, damage) are drawn only at full
  detail; from the 1 m ring out the edges are plain square voxels; fences
  and lone posts thinner than the level's cell leave; damage shows near by
  only.
  The ground's colours are the same at every distance.
- **Changing level.** A ring moves with the camera and switches with 8 m of
  slack, so standing still at its edge does not flip it. A switch happens
  between two frames, only once everything it needs is built: the old
  detail stays on screen until then, and the two levels are joined without
  cracks.
- **Edits far away.** A change in a coarse ring shows there too, a few
  frames later than it would at full detail (the coarse level is rebuilt
  after the full-detail one).
- **Collision is always full detail.** Colliders exist only in the collision
  ring, and they are built from the full-detail shape, never from a coarse
  level. Most open ground there collides as height grids (much lighter on
  the physics engine than triangles); cliff faces, overhangs, cave roofs and
  buildings keep exact triangles and boxes. Scripts' rays and sweeps hit the
  same ground the characters stand on.
- Reading cells (`ctx.voxels`) always reads the full-detail cells, whatever
  ring they are drawn in.

### Relief

**Off by default on every quality level** (the owner's choice for now: fewer
triangles and a lighter mesher until the far field's bricks are done). No
relief mesh is made, streamed or drawn unless a quality level asks for it
with its own **Voxel relief**; the heights still shade every surface through
the normal maps and the height blend. What follows is what a level that sets
it gets.

Near the focus, surfaces are drawn **with relief**: their mesh is made finer
(per 8 m section of the world) so the vertex stage can move it inward by each
material's height (the albedo's alpha) times its **height depth**
(see [Voxel materials](#voxel-materials)), fading to none toward the relief
distance. What collides, what characters stand on and what scripts read stay
the plain surfaces: relief only ever recesses.

- **How fine, by quality level.** A quality level's **Voxel relief**
  (`voxelRelief`: 0, 2 = 25 cm, 4 = 12.5 cm or 8 steps a cell; absent: its
  tier's, 0 on every tier). At 0 no relief mesh is made at any distance; the
  normal maps still shade the heights everywhere.
- **How far.** The world's `levels.relief` (default 16 m, scaled by the quality
  level's own relief scale: medium 16 m, high 24 m; a level's **Voxel ring
  scale** scales it like every distance when the level sets one), changed at run time with
  `ctx.voxels.setRings({ levels: { relief } })`. The ring moves with the focus;
  a section turns relief or plain only where nothing of it is moved, and the
  sections that change swap in together between two frames, so its edge
  neither cracks nor pops.
- **Memory.** Relief has its own share of the world's stream budget (one
  eighth): the base world keeps the rest, so relief never pushes the world's
  own chunks out. When the relief meshes outgrow their share (a dense town at
  a fine setting), the relief ring shrinks to fit until the focus has moved
  on, and the displacement ends where it now stops.
- A material paint (material or wetness) never remeshes relief: heights and
  depths are shader data.
- **Where it is drawn.** Play (the simulation in its worker or on the page),
  exports, the editor's Scene view (at the view's quality level, round the
  point it orbits) and the voxel world page (the quality level's by default, none; `?relief=2` or `?relief=4` turns it on;
  `?relief=0` none; its **relief** switch, bottom right, draws the relief
  mesh flat to compare).
- **Shadows.** Where the world casts shadows (the voxel world page's
  `?shadows=1`; Play and exports do not cast voxel shadows yet), a relief
  chunk casts from its plain surfaces, not from the relief mesh: relief only
  ever recesses the surface, so the plain shape holds it, and the shadow map
  draws a fraction of the triangles. The relief surface looks its shadow up
  where the plain surface is. What is lost: the small shadows inside the
  relief itself (a stone's side in its own joint at a low sun); the
  surface's normals still shade it. `?reliefShadow=relief` casts from the
  relief meshes instead, to compare.

### The far field

Past the load ring the world is drawn by its **far field**, as far as the
world reaches: there is no distance past which nothing is drawn, and a
mountain kilometres away shows above the horizon. The far field draws the
world's coarser voxels (2 m cells and up, coarser with distance) from the
world's **far cache** as ray-marched distance bricks (or, as a fallback, meshed), which the backend builds beside the world (in the
project's `cache/` folder, never committed), keeps current with every edit
command, and an export ships with the world. A world's first build (minutes
for a world of kilometres) runs in the background: edits go on meanwhile and
are built into it when it lands, and the far field appears once it is there.
The far cache holds each node's bricks ready made (baked when it is built, and
built again for the nodes an edit changes), so a game only unpacks and uploads
them; a far cache from before baking still draws, its bricks made as the game
runs, and the backend builds it again.

- **Mode and detail, by quality level.** A quality level's **Voxel far
  field** is `bricks` (default on every tier), `mesh` (the fallback) or
  `off` (nothing past the load ring); its **Voxel far detail** is how many
  pixels a far voxel may cover before finer ones are drawn (low 8, medium 4,
  high 3; smaller is sharper and draws more).
- **Bricks.** Each far node is kept as a sparse distance field (8³-cell
  bricks where its surface passes), built from the faces of the next finer
  level's voxels so roofs, rocks and ledges a voxel or two across keep a
  body, and part-full ground cells count by their fill, so a gentle slope
  stays a smooth slope instead of contour bands of the voxel steps while a
  cliff or a scarp keeps its edge; each sample carries its colour and a soft
  ambient occlusion, baked when the node is built. The GPU draws a box a node and marches each
  pixel's ray through the node's bricks to the surface: smooth slopes, no
  triangles, and it writes the surface's own depth.
- **Meshes (the fallback).** `mesh` draws each far node as triangles
  (terraced, like the near ground) from its coarse voxels. Both modes take
  the material's colour, light the same way and hand over to the near field
  the same way; a mode switch makes every far node again and swaps it in
  node by node.
- **Where it meets the near field.** The far field draws under the near
  field and is hidden wherever the near field draws, chunk by chunk, so
  ground the near rings have not streamed in yet shows its far stand-in,
  never a hole; along the near field's edge both draw for one chunk, the far
  field behind all of the near field there, so the near ground always wins
  where it has geometry and the far field only fills gaps.
- **What it shows.** Each far voxel takes its material's colour (its texture
  set's mean colour where it has one) and its wetness; kit pieces, relief
  and openings narrower than 1 m are not drawn there. A game's runtime edits
  (`ctx.voxels`) show in the near field only; edit commands reach the far
  field too.
- On the voxel world page, `?farField=bricks|mesh|off` and `?farError=` (pixels)
  override the quality level's; `?farRes=half` marches the bricks at half
  resolution (a trial: silhouettes step and slopes shimmer); `?farShow=0`
  keeps the far draws hidden.

Limits today:

- **A rare gap between levels.** Where two caves meet in a saddle that the
  two levels join differently, a small hole (about 1 × 5 m) can show at a
  level boundary inside the cave.
- **Far field cost.** From the 8 km test world's town at medium the bricks
  hold about 44 k bricks in ~164 MB of GPU memory, which grows as the view
  travels and is not given back yet; they take about 50 s to fill after a
  world opens (the meshes ~15 s, with ~5 M triangles), and a fast flight
  drops a few frames while new nodes land. A larger **Voxel far detail**
  draws fewer.
- **Where the near field ends.** Within the near field's outermost chunk
  the far field draws too, and where its coarser surface lies higher it can
  show in front of the near ground there.

## In the editor

- **The Scene view draws the world** of every `voxelWorld` object in the
  open scenes, streamed round the point the view orbits (no colliders in
  the editor). Adding the component shows the world and deleting the
  object removes it at once, with no reload.
- **Edits show without a reload:** every applied `editVoxels` or
  `undoVoxels` (from any client, or an AI agent) reaches the open editor,
  and the Scene view rebuilds the chunks it changed.
- The editor has no voxel brush yet (brushes and role painting come
  later). Edits are sent by the voxel world page or over the API (below).
- **The voxel world page**, `/voxel-world.html?project=<id>&world=<name>`
  (optionally `&at=x,y,z`, `&renderer=webgl2`), opens one world on its own:
  drag to orbit, wheel to zoom, W A S D to move; a click digs a 1 m ball,
  shift-click adds one of the material picked bottom left (the picker lists
  the project's voxel materials only; with none it adds voxel id 2), Z
  undoes the newest edit. It sends the same commands as any client and
  never writes a file itself. It reads the material records again when the
  window gets the focus back.

## Edits: `editVoxels` and `undoVoxels`

A world's files change through two command ops, which the editor's pages
and MCP (`tl_command`) send alike:

- [`editVoxels`](../reference/ops-detail.md#op-editVoxels)
  `{world, command}` applies one **stroke**: a brush drag (`brush`: a
  sphere, box or cylinder through one or more points, to `place`, `add`,
  `dig` or `paint`), a box `fill`, a `stamp`, or exact cells (`set`,
  `dig`). The command format:
  [`VoxelEditCommand`](../reference/types-s-w.md#type-voxel-edit-command).
  **Positions here are cells (0.5 m), not metres.**
- [`undoVoxels`](../reference/ops-detail.md#op-undoVoxels) `{world}` takes
  back the world's newest edit.

An answer gives the world's new `revision`, the `cells` changed, the
changed `chunks`, the `box` of cells it can have touched, the rewritten
region files and how many edits can still be undone (`undoable`); the
connected editor gets the same as a `voxelsChanged` event. Over MCP, a dig
of a 1 m ball at cell (0, 4, 0):

```json
{"op": "editVoxels", "args": {"world": "slice", "command":
  {"v": 2, "grid": 0, "kind": "brush", "shape": "sphere", "size": [2, 2, 2],
   "points": [0, 4, 0], "mode": "dig", "smooth": false}}}
```

- **Not the project's history.** A world keeps its own revision and its
  own undo in the backend: the ops take no `expectedRevision`, and the
  project's `undo` does not take a voxel edit back.
- **Refusals:** `no_change` (the stroke changed no cell), `outside_world`
  (it reaches past the world's bounds), `over_budget` (one stroke too large
  to undo, about 64 MiB of undo), `nothing_to_undo`, `world_not_found`,
  and `invalid_args` naming the bad field. A request id sent again answers
  once and applies nothing.
- Edits made this way change the authored world; a running game's changes
  never reach the files.

## Decals

Dirt, moss, stains and cracks on a voxel world are [decals](decals.md) and
whole-voxel material changes (paint a cell another material); voxels carry
no paint layer of their own. Both decal kinds mark a world in the Scene
view, in Play and in an exported game, on WebGPU and WebGL 2:

- **Projected decals** mark every surface of the world inside their box —
  terrain and construction faces at every distance level, and kit pieces —
  blended into the surface's material before it is lit. Use them for marks
  on terrain, for marks that must follow the surface whatever is dug or
  built under them, and for marks on kit pieces.
- **Clipped decals** are cut from the world's full-detail chunks (level 0,
  the near ring) and drawn as their own mesh. A dig, a build or a paint
  that changes a chunk under a mark cuts it again from the new surface
  (a few milliseconds a mark on a worker, 3–5 ms on this engine's test host; the old mark stays drawn
  until the new one is in, never both); a chunk drawn coarser (past the
  full-detail distance) has no clipped marks, they come back with level 0.
  Kit pieces take no clipped marks (they are instanced).

A world 8 km from the origin takes both: projected marks as exactly as at the origin, clipped marks within half a millimetre.
The voxel object's **Decal layers** choose which decals mark the world.

## Exports

An export ships each world its scenes name with all of the world's region
files, whole (about 4–10 MB per km² for the test worlds), and its far cache's
files (about half of that again with the baked bricks; 355 MB for the 8 km test world). An export waits up to two minutes for a far
cache still being built; past that it ships the world without one (the game
draws nothing past the load ring) and its warnings say so: export again once
the cache is built. Each file is checked
against its digest when the game reads it. The exported game needs no
backend and makes no range requests. An export is refused when a world it
names is missing or has a missing or damaged region file. The project's
voxel kits ship whole in the build's catalog (`voxelKits`), with the model
versions their meshes name, and **every voxel material** ships (a world's
cells name materials by id, so a material only the world uses ships too;
Play builds the same way). The materials' texture sets ship as three
texture arrays (albedo, normal, ORM) the build assembles once and caches
(the catalog's `voxelTextures` names them); the sets' own textures ship
only when something else uses them.

## Voxel kits

> **v1:** the case list (the role spec) and the texture layout are v1,
> approved by the owner; kit format 1 is final. A later format only adds
> fields, and a new case only adds a slot.

**Making one:** [Make a voxel kit and a material set](../guides/voxel-kits.md)
(Blender templates, one-click export, the kit check, a sample kit) and
[the slot sheets](../guides/voxel-kit-slots/index.md) (one page a slot: where it
sits, its envelope, which slots can share its mesh).

**What a kit is.** Cells store only a role (wall, floor, roof …), never
"corner" or "window sill". Walls, floors, stairs and flat roofs are plain
voxel faces: no piece ever stands on a flat face. A piece goes only where
faces meet, each its own instance a 0.5 m edge or corner: the engine reads
the cells round every edge and corner of a built cell and gives it a
**case** (an outer top, vertical or bottom edge, an inner one where a wall
meets a floor or ceiling, an outer or inner corner; where outer and inner
edges meet, as at a stair's side or a wall's foot on a wider foundation, the
outer or inner corner the shape there asks for), the ridge, eave,
verge, hip and valley of a sloped roof, and **damage** (the faces round a
damaged hole). Every case is a
**slot** of a kit (the case id is the slot's name): a kit fills a slot with
one or more 3D meshes, or leaves it empty, and **an empty slot draws
nothing** (that edge stays a plain voxel edge). So a kit can start empty:
check the textures on plain voxels first, then add pieces one slot at a
time. One mesh can fill many slots, each turned its own way. A material
**without a kit draws plain voxel faces**: there is no engine default kit.
What collides, what blocks walking and how much light passes come from the
cells, never from a kit's pieces, so every kit of a material type plays the
same.

**Roofs.** Roof cells laid as a 45° stair (each row one cell up and one
across) or a 1:2 stair (two cells along at each level, then one up) are
drawn as flat sloped planes over the steps, not as steps: gables, hips
(the planes meeting at an outside corner) and valleys (an inside corner)
all close; one roof keeps one slope. The roof is a slab half a metre thick
with its underside parallel to its top. Walls under a roof keep their
stepped tops (a gable shows its steps, with a small gap between each step
and the slope) unless the roof's kit sets **wall-top fill**
(`wallTopFill: true`): then a wall under a roof (or one cell under it) is
cut to that underside, so no step shows in the attic or under the eaves,
and a gable's end wall follows the slope. The roof shows its own material
up to the wall and the wall its own up to the roof: the two never blend.
A wall or chimney through a roof keeps its own faces. Characters stand and walk on the drawn
slope; light and walking routes still use the stepped cells. A flat roof,
or a stair of another slope, keeps its plain block faces. Pieces go along
the roof's edges only: ridge, eave, verge (the sloped gable edge), hip and
valley. A kit makes each of them once, for a 45° roof: on a 1:2 roof the
engine tilts the same piece onto the shallower slope. One verge piece
serves both sides of a gable (the other side is drawn mirrored).

**Damage:** a built cell's shape is its integrity (15
intact, lower damaged, air broken), shown in three stages its kit sets (the
default split below; a material without a kit uses it too):

| Stage | Integrity | Drawn |
|---|---|---|
| 1, cracks | 11–14 | the block with its edge pieces; its faces show a crack overlay, stronger as the integrity drops |
| 2 | 6–10 | not drawn: a hole with no edge pieces round it; each intact neighbour face toward it carries 6 pieces of its own kit's `damage-stage-2` slot, spread over the face |
| 3 | 1–5 | the same hole with 3 pieces of `damage-stage-3` a face |

A damaged cell with every face against solid stays a plain block. Whatever
its stage, it collides and is walked on as a whole block until it is air;
light passes it by its integrity (a cell at 5 lets two thirds through).
Damage shows in the nearest ring only (1 m cells and coarser are intact),
and terrain has none (its shape is its fill). How much damage a cell takes
and when is the game's to decide
([scripting it](../guides/voxel-scripts.md#change-set-dig-paint)); a smooth
build stroke always places whole blocks, so damage is only ever written on
purpose.

A voxel kit is one project item (its own file under `assets/voxel-kits/`,
a `voxelkit` in the project index) holding the detail pieces a material
type draws a world's cases with. It belongs to a material *type* (wood,
stone), never to one material, so every material of the type shares its
pieces. Make, change and delete one with `setVoxelKit {kit}` and
`deleteVoxelKit {voxelKitId}` (one undo each, the editor, MCP and scripts
alike); `queryGameConfig` (MCP: `tl_content_query target="game"`) lists
them as `voxelKits`.

- **`kitFormat`** is 1. A kit of a newer format is refused whole, as is any
  field this engine does not know; fields are only ever added.
- **`slots`**: per slot (case id), its `meshes`, one or more, each a
  `mesh` (`{assetId, digest, node?}`: a model asset and the SHA-256 of the
  GLB version it was made from, so it ships as every model does; pieces
  draw only near the camera, so there is no lower-detail mesh), a
  `rotation` (one of the 24 cube rotations, 0–23, absent 0: how the mesh is
  turned into the slot's case), a `weight` (absent 1) and `mirror` (true:
  the mesh is drawn mirrored across its case's run, its normal map
  flipped with it, so one carving serves a left and a right side). A slot left out
  is empty; a slot holds no empty list. Which of a slot's meshes a piece
  draws follows the project's **voxel detail seed** (the project setting
  `voxel_piece_seed`, 0 unless set) and the piece's place in the world, so
  a scene draws the same on every load; change the seed for another
  arrangement of the same meshes.
- **`jitter`** (0–4, absent 1): how far every piece of the kit (edges,
  corners, roof edges, damage) is moved into the solid and twisted, as a
  share of the engine's stagger (1: 1/64–1/32 of a cell in, up to 2°; 0: on
  the lattice), so a long rim does not read as a ruled line. Always into
  the solid, never out: no gap opens between a piece and its faces.
- **`damage`** (absent: the engine's stages): `stage1`, `stage2`,
  `stage3`, each `{min, max}` (an integrity range within 1–14, stages never
  sharing one; stages 2 and 3 also `pieces`, 1–16 a face) or `null` to
  leave that stage out (an integrity in no stage draws intact), and
  `crackTexture` (`{assetId, digest}`: an image asset whose red channel
  replaces the engine's crack pattern: 0 no crack, bright cracks show at
  the first crack stage, dimmer ones join as the integrity drops; one image
  covers a 4 × 4 m construction tile, laid on the build grid like the
  material's own texture, so cracked blocks side by side show one pattern;
  any size: read into 512² by the brightest texel of each, so cracks a
  pixel wide in a 4096² map, the base tile's 1024 px/m, still show; a PNG,
  imported as it is).
  For example
  `{"stage1": null, "stage2": {"min": 1, "max": 14, "pieces": 4}, "stage3": null}`
  makes every damaged block a hole with four pieces a face.
- **One texture set a kit**: every piece of a kit uses the same one
  material (one trim sheet or one material); a kit whose pieces use two is
  a kit-check error. Timber on stone is two kits. That material is the
  pieces' GLB material, as exported: its base colour, normal map and ORM
  (occlusion R, roughness G, metal B) images inside the file, which the
  model import extracts into KTX2 textures (streamed like any model's);
  a kit with a trim layout reads every map at the world-anchored U. A GLB
  whose material has no image draws a stand-in colour a kit; the voxel
  world page's `?trimDebug=1` draws the labelled UV debug textures
  instead of the sheets.
- **`gameData`** on the kit and on each slot: any JSON (break, sound,
  physics defaults). The engine keeps it, ships it and never reads it; a
  game's scripts read it.
- **`materials`** is the kit's own list of voxel material ids it draws, from
  before materials named their kit. A material record names its kit
  (`voxel.kit`, see [Voxel materials](#voxel-materials)) and decides for its
  id; the list still binds the ids no material record names (the kit check
  shows an info row, *Set the binding on the material*). **`trimLayout`** names the
  trim layout the pieces' UVs follow; **`sheetLayout`** instead declares the
  kit's own sheet (`{size, pxPerMetre, regions: [{id, kind: field, strip,
  profiled or cap, metres, y: [top, end], x (caps only)}]}`), so its
  strips run on along an edge and the kit check reads its regions. With
  neither, the kit uses no trim sheet (its UVs draw as authored). Voxel
  faces always use the 4 × 4 m tiling textures.

**How worlds draw them.** The voxel world page, Play, the Scene view and an
exported game draw every world with the project's kits: a cell's pieces are
its material's kit's meshes in the slot of each of its edges and corners
(where two roles meet, the higher one's kit dresses the edge — roof, wall,
pillar, stair, floor, foundation in that order, so a wall on a foundation
dresses its foot; where two kits of the same role meet, the edge stays
plain and the material blend draws the seam),
picked by the seed and the cell (an edit elsewhere never reshuffles them),
turned to fit and jittered by the kit. Pieces draw only in the near ring
(level 0); from the middle ring out the edges are plain square voxel faces.
The stagger is drawing only, collision never sees it. A piece wears its
cell's wetness as the surface does (darker, smoother, its fine relief
flatter; water never stands on a piece). Pieces are drawn per piece kind
for the whole near ring, not per chunk, so the draw count follows the kinds
in view, and each pass (the view, a shadow map) draws only the chunks it
sees; they draw after the world's surfaces, so a piece behind a wall is not
shaded. With [occlusion culling](occlusion.md) on, WebGPU also leaves out
each piece the walls in front hide (in the town about seven in ten);
WebGL 2 draws every piece of the chunks in view. Kit pieces wear their
kit's one texture set: the material of the kit's GLB (base colour, normal,
occlusion/roughness/metal), its images imported as texture assets; a kit
naming a trim layout reads them at the world-anchored U of its run faces. A
kit without images draws a stand-in colour. To check UVs, the voxel world
page's `?trimDebug=1` draws the layout's debug set instead (each region its
own colour and id, a 3 cm checker, a tick every 0.125 m along U). A kit mesh still loading draws when it arrives; one that fails
draws nothing (the page's status names it). In the Scene view an open
world follows a kit edit and a change of the voxel detail seed as they
are made.

Painting cells another material of the same kit (oak to pine of a wood
kit) only changes the shading; painting them a material of another kit (a
log wall to stone) also rebuilds the pieces of the painted cells.

**Kit check.** Every kit is checked when the project opens and after a kit
or a model it names changes; problems show in the editor's **Problems** (and
MCP's `tl_diagnostics`) as `voxel_kit_check` lines, one a rule:

- **error** — something draws wrong or not at all: a slot the case list
  does not have, a mesh whose model is missing, unreadable or has no such
  node, a piece whose pivot is off its cell (turned by its slot rotation),
  pieces using more than one texture set, trim rules T1, T2 and T4;
- **warning** — a mesh past half a cell round its cell, a mesh made from a
  model version the project no longer has; never an empty slot (every slot
  is optional);
- how many slots are filled, triangle counts and texture sizes are
  reported, never capped.

A kit passes when it has no error. Trim rules (T1–T7, T9, T10) run only for
kits with a trim layout: one naming the example layout `detail-trim` (marked
"(draft layout)"), or one declaring its own `sheetLayout` (marked "(the
kit's layout)" and checked against its own regions).

**Kit test scene.** `writeKitTestScene {world, origin [x, y, z], material}`
(the editor, MCP and scripts alike; one undo with `undoVoxels`) empties a
box at `origin` and builds every case of the case list there from voxels,
all in `material`: a fixed sampler (a notched block for every edge and
corner case, a gable, a hip and an L-plan roof for the roof edges, a wall
with a cell at each damage stage), each case labelled at one cell that
has it. Pick a material your kit binds to see each slot drawn with its
meshes, and an empty one drawn as plain voxel edges. The answer lists each
label's cell, role and case; the voxel world page labels them
(`?kitScene=x,y,z,material`).
Writing the same scene again changes nothing (`no_change`).

## Voxel materials

A voxel material is an ordinary project material with a **`voxel`** part:
the same record dresses a prop and a wall, so there is one oak, not an
"oak (prop)" and an "oak (voxel)".

- **`voxel.id`** (1–4,095): the voxel material id cells store. Every world
  of the project shares the ids; two materials with one id are refused
  (`voxel_id_taken`).
- **`voxel.use`**: `construction` (grid-anchored tiles, 4 × 4 m by
  default), `terrain` (projected from three axes, 2 m) or `liquid`.
- **`voxel.kit`**: the voxel kit whose pieces its edges draw (a kit the
  project has: `kit_missing` otherwise, and deleting a kit a material names
  is refused). A liquid has no kit. A material without one draws plain
  voxel edges.
- **`voxel.tileMetres`** (0.5–64 m) and **`voxel.heightDepth`** (0–0.25 m,
  the depth between its height map's white and black: sand shallow, rock
  deep). Where two materials meet, the one whose surface stands higher in
  metres shows (rock tops break through sand, sand fills rock's cracks), so
  a deep material wins over a shallow one with the same map values.
- **`voxel.blendMetres`** (0–0.5 m; absent: the world's **Material blend**,
  0.25 m by default): how far it blends into a neighbouring material. Where
  two meet the smaller wins, from both sides, so cut stone stays crisp beside
  soft grass; 0 draws hard cell lines. The Inspector's voxel section has it
  as **blend m**. A change is live and remeshes nothing.
- **`voxel.surfaces`**: `{wall, floor, ceiling}` texture sets, each
  `{albedo, normal, orm}` (plain texture assets: the albedo with the
  **height in its alpha** (white the surface, black `heightDepth` below it;
  an albedo without one gets a height from its brightness, as on
  [layered surfaces](../guides/height-in-alpha.md)); a tangent-space normal
  map with green up, its alpha unused; occlusion, roughness and metalness in
  R, G and B); floor and ceiling use the wall's when left out. A set needs its albedo; a normal or ORM map left out is
  flat. All textures of the sets should be one size (the engine joins them
  into arrays): a construction tile is authored at 4096 × 4096 for its
  4 × 4 m wall, the image's top up the wall.

Any material may also carry **`physical`** (a profile and the numbers it
changes: `density` kg/m³, `friction`, `restitution`, `flowRate` for
liquids) and **`gameData`** (any JSON the game reads, such as a footstep
sound or block health; the engine never reads it). **Physical profiles**
hold the shared numbers: the engine has earth, glass, lava, metal, stone,
water and wood; `setMaterialProfile {profile: {profileId, name, density?,
friction?, restitution?, flowRate?, gameData?}}` adds the project's own (one
with an engine profile's id overrides it field by field) and
`deleteMaterialProfile {profileId}` removes one. A number a material leaves
out is its profile's, else density 1000, friction 0.5, restitution 0. A
build ships each material's physics with its profile's numbers filled in.

**Variants** are material instances: an instance takes its parent's
physics, game data and voxel fields and changes any. A voxel variant gives
its own `voxel: {id, …}` (an id is never inherited); an instance without a
`voxel` part is a mesh-only variant.

All of it goes through `setMaterial` (the editor, MCP's `tl_command` and
scripts send the same command; one undo).

**In the editor**, the material's Inspector has a **Voxel use** section:
its badges, the use (none, construction, terrain, liquid; on an instance,
"a variant" with the parent's use), the voxel id (a new voxel material gets
the smallest free one), the kit, the tile in metres and the height depth.
Wall, floor and ceiling texture sets are set over the API for now. The
project window shows each material's **badges**: `mesh` (draws on meshes),
`voxel` (has a voxel use: voxel tools list it), `kit` (its edges draw a
kit's pieces), `liquid`, `decal`, `graph` (a node graph that compiles its
own shader). Search with **`f:<badge>`** to list the materials that have it
(`f:voxel`, `f:kit stone`; several narrow it); MCP's index query takes
`badges: [...]`.

**What the world draws.** Each voxel id draws as its material record says:
its texture sets, its colour (the material's `color`: it tints the sets;
leave it out, or white, to draw them as authored), its tile (`tileMetres`,
on walls and terrain alike; a tile that does not divide the 512 m texture
phase is drawn at the nearest one that does, 3 m as 2.994 m) and its relief
depth. Construction faces looking up draw the floor set, faces looking down
the ceiling set, every other face (walls, roof slopes) the wall set, laid
on the build grid so a course at 2 m sits at 2 m on every wall; terrain
draws its wall set from three axes. Neighbouring materials blend in the
shader, their normal maps too. An id no material names, or a material
without sets, draws a flat colour (its stand-in's, or its `color`). A
material edit rewrites the world's material table only: nothing is derived,
meshed or uploaded again (the Scene view, Play, an export and the voxel
world page alike); a changed texture set loads the arrays again, and the
world keeps drawing the old ones until the new ones are there. The voxel
world page's `?patterns=1` draws the old test patterns instead.

**Texture detail by quality level.** Author one set, at 1024 texels a
metre (4096 × 4096 for a 4 × 4 m wall). Each quality level keeps the arrays
resident down to its **Voxel texel density** (`voxelTexelDensity` on a
[quality level](../reference/content-blocks-environment.md), 64–4096 in
powers of two; else its lighting tier's: low 256, medium 512, high 1024
texels a metre), so a 4096² set is drawn from its 1024², 2048² or 4096²
level. Within that the arrays stream like any large texture: the page's
[texture budget](tuning.md) (`texture_budget_mb`) keeps what fits, the
nearest surfaces' need first, and the smallest levels (128² and below)
always stay. Changing the level while the game runs drops the levels above
the new cap at once or streams the finer ones in, drawing the old ones
until they arrive, without a reload; Play, an export, the Scene view and
the voxel world page (`?quality=low|medium|high`, `?textureBudget=MiB`)
keep them the same way. A build ships each array cut into its mip levels,
as it ships any streamed texture.

**Scripts read the records:** `ctx.voxels.materialAt(x, y, z)` gives the
material of the voxel at a point and `ctx.voxels.materialOf(id)` the one a
voxel id is: `{id, materialId, name, use, kit, physical: {profile?,
density, friction, restitution, flowRate?}, gameData}`, as the build ships
it (null where the world is not loaded, the cell is air, or no material
has the id). Use it for footsteps, how much a block takes to break, or
what a liquid does. The engine itself reads none of it: chunk colliders
keep one friction (a triangle-mesh collider has no friction per
triangle).

## Not built yet

These come later; worlds made now keep working when they arrive:

- **Kits**: a kit page in the editor (slots assigned by drag and drop; for
  now through `setVoxelKit`); the fringe where buildings meet the ground and
  ground scatter come with the terrain tools.
  How to make a kit today: [Make a voxel kit and a material set](../guides/voxel-kits.md).
- **Materials**: texture sets in the material Inspector (set over the API),
  and the physical section in the Inspector (profiles are set over the API).
- **Lighting**: the world's own light and shadow, and what reads the light
  coverage props stamp; culling and navigation over voxels.
- **Structures** (rotated grids of their own, such as a ship or a moving
  building), voxel brushes and role painting in the editor, and more MCP
  voxel tools.
- **Converters** from terrain and block layers, and `ctx.grid` over voxels
  ([migration note](migration.md#voxel-worlds-beside-block-layers-and-terrain)).
