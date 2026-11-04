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
    4 floor, 5 roof, 6 foundation, 7 stair, 8 pillar, 9 opening (the door
    or window there is a kit piece). Beams, banisters, posts and mouldings
    are not roles: they follow from how the cells are arranged, and so does
    the shape collision, walking and light use there (an open banister lets
    a ball through between its posts, a balcony's open edge is a thinner
    slab), never the look of a kit's piece;
  - **shape** — how full the cell is, 0 (empty) to 15 (full), so ground can
    slope and round off instead of stepping;
  - **wetness** — 0 (dry) to 7: the surface darkens as it rises.
- **What a change rebuilds.** Shape and role change the world's form: its
  meshes and colliders are rebuilt round the change. Material and wetness
  only change how it looks: only the surface's shading data is rebuilt, no
  mesh or collider (rain over a whole valley is cheap).
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
| **Detail levels** (`levels`) | full detail to 64 m, 1 m voxels to 128 m, 2 m voxels past it | How far the world is drawn at full detail (`level0`, 0.5 m voxels) and at 1 m voxels (`level1`); past that, 2 m voxels to the load ring. Full detail always reaches 8 m past the collision ring, so what a character touches is what is drawn. Where a coarser level is not built yet (the far edge of the load ring), the finer one stands in. A level-1 distance below the full-detail one is taken as it. |
| **Section edge** (`sectionEdge`) | 16 | Cells along the edge of the pieces a chunk is rebuilt in after a change (8, 16 or 32): smaller rebuilds less a change, larger draws fewer pieces. Leave it at 16 unless you measure. |
| **Saved fields** (`savedFields`) | material, role, shape | Which fields of the game's changes a save keeps. Wetness is left out by default: weather sets it again. A script can change it for a run (`ctx.voxels.setSavedFields`). |

Settings you leave empty follow the engine's defaults, so a later default
reaches every world that did not set its own. The component is not allowed
on prefab objects (a world streams per scene). One object names one world.

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
- **One memory budget a world** (256 MiB, the low-end machine's budget)
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

- **Three rings.** Within 64 m (by default) the world is drawn at full
  detail, from its 0.5 m cells. Out to 128 m it is drawn as if its cells were
  1 m, past that as if they were 2 m, up to the load ring. Set the distances
  with the component's **Detail levels** (`levels`). A ring is measured
  across the ground from the camera's focus and from every player character,
  and full detail always reaches 8 m past the collision ring.
- **What a game sees.** Far away the shapes are coarser: a slope or a cliff
  keeps its line, small bumps, one-cell spikes and pits leave, and a
  one-cell wall, floor or roof is drawn as thick as the level's cell, so a
  house keeps its walls and roof and looks a little larger. Beams, rails and
  posts are drawn whole near by, simpler in the 1 m ring and not at all
  further out; fences and lone posts thinner than the level's cell leave.
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

Limits today:

- **Tall ground far away.** The load ring reaches 96 m above and below the
  focus, and the coarse rings stop short of its top and bottom. A mountain or
  cliff rising more than about 64 m above the camera loses its top beyond
  about 96 m. The 2 m ring is not drawn with the default 192 m load ring:
  the 1 m ring stands in to its edge.
- **A rare gap between levels.** Where two caves meet in a saddle that the
  two levels join differently, a small hole (about 1 × 5 m) can show at a
  level boundary inside the cave.
- Nothing is drawn past the load ring.

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
  shift-click adds one, Z undoes the newest edit. It sends the same
  commands as any client and never writes a file itself.

## Edits: `editVoxels` and `undoVoxels`

A world's files change through two command ops, which the editor's pages
and MCP (`tl_command`) send alike:

- [`editVoxels`](../reference/ops-detail.md#op-editVoxels)
  `{world, command}` applies one **stroke**: a brush drag (`brush`: a
  sphere, box or cylinder through one or more points, to `place`, `add`,
  `dig` or `paint`), a box `fill`, a `stamp`, or exact cells (`set`,
  `dig`). The command format:
  [`VoxelEditCommand`](../reference/types-t-w.md#type-voxel-edit-command).
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

## Exports

An export ships each world its scenes name with all of the world's region
files, whole (about 4–6 MB per km² for the test world). Each file is checked
against its digest when the game reads it. The exported game needs no
backend and makes no range requests. An export is refused when a world it
names is missing or has a missing or damaged region file. The project's
voxel kits ship whole in the build's catalog (`voxelKits`), with the model
versions their meshes name.

## Voxel kits

> **Draft:** the case list and the kit format may still change. Both wait
> for the owner's approval of the role spec (and, for kits that use a trim
> sheet, the trim layout for detail pieces); worlds draw with kits now.

**What a kit is.** Cells store only a role (wall, floor, roof …), never
"beam" or "corner" or "window sill". The engine reads each built cell's
neighbourhood (two cells round it) and gives it a **case**: a plain wall, a
wall's top, its end, an outside corner, a beam under a floor's edge, a
banister rail, a soffit under an overhang, and so on. A kit is the set of
3D pieces a material type draws those cases with: a log kit lays half-logs
along plain walls and log ends out of the corners, a stone kit lays ashlar,
copings and quoins. Runs (a beam, a coping, a rail) are built from short
sections (start, body, end, corner, junction), so any length works, and
where the run ends, the kit's end piece goes. What collides, what blocks
walking and how much light passes come from the case, never from a kit's
pieces, so every kit of a material type plays the same.

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
- **`cases`**: per case id, its run `sections` (body, corner, termination …
  by section id), each with one or more weighted `variants` of a `high` mesh
  and an optional `low` one. A mesh is a model asset and the SHA-256 of the
  GLB version it was made from (`{assetId, digest, node?}`), so it ships as
  every model does. A case may hold only game data.
- **`joinProfiles`**: the outline a section's end has, in whole sixteenths
  of a cell; a section's `ends` name them, so neighbouring sections can be
  checked to meet.
- **`gameData`** on the kit and on each case: any JSON (break, sound,
  physics defaults). The engine keeps it, ships it and never reads it; a
  game's scripts read it.
- **`materials`** binds the kit to materials, for now: the voxel material
  ids the kit draws. Once materials have records of their own, a material
  names its kit and this field is no longer read. **`trimLayout`** names the
  trim layout the pieces' UVs follow; absent, the kit uses no trim sheet.

**How worlds draw them.** The voxel world page, Play, the Scene view and an
exported game draw every world with the project's kits: a cell's piece is
its material's kit's piece for the cell's case and run section, its variant
picked from the cell (an edit elsewhere never reshuffles it), turned and
mirrored to fit. Near the camera a piece's `high` mesh draws, one level out
its `low` one (its `high` one where none is authored), farther out none:
the cells draw as blocks. A material no kit binds draws the engine's
**default kit**: plain procedural boxes (copings, plinths, sills, edges,
mouldings, skirts, frames) with a labelled debug UV texture, and the engine's
stand-in beams, rails and posts. Kit pieces draw with a stand-in material a
kit and that debug texture until materials arrive; a kit naming a trim layout
draws with that layout's debug set instead (each region its own colour and
id, a 3 cm checker, a tick every 0.125 m along U), so a face mapped to the
wrong region or stretched shows at once. A kit mesh still loading
draws when it arrives; one that fails draws nothing (the page's status names
it). In the Scene view a kit edited while a world is open shows once the
world is opened again (another scene, or a reload).

Painting cells another material of the same kit (oak to pine of a wood
kit) only changes the shading; painting them a material of another kit (a
log wall to stone) also rebuilds the pieces of the painted cells.

**Kit check.** Every kit is checked when the project opens and after a kit
or a model it names changes; problems show in the editor's **Problems** (and
MCP's `tl_diagnostics`) as `voxel_kit_check` lines, one a rule:

- **error** — something draws wrong or not at all: a case or section id
  the case list does not have, a mesh whose model is missing, unreadable or
  has no such node, a piece whose pivot is off its cell, trim rules T1, T2
  and T4;
- **warning** — something draws, just not from the kit: a required case
  the kit leaves to its role's plain piece, the base surface or the
  engine's stand-in (the line names which), a role without its fallback
  piece, a low mesh heavier than its high one, a mesh past half a cell
  round its cell, section ends whose outlines differ, a mesh made from a
  model version the project no longer has;
- triangle counts and texture sizes are reported, never capped.

A kit passes when it has no error. Trim rules (T1–T10) run only for kits
naming a trim layout and are marked "(draft layout)".

**Kit test scene.** `writeKitTestScene {world, origin [x, y, z], material}`
(the editor, MCP and scripts alike; one undo with `undoVoxels`) empties a
box at `origin` and builds every case of the case list there from voxels,
one row a role, one exhibit a case, all in `material`: pick a material your
kit binds to see each case drawn with its pieces, and a missing one drawn
by its fallback. The answer lists each exhibit's cell, role, case and run
section; the voxel world page labels them (`?kitScene=x,y,z,material`).
Writing the same scene again changes nothing (`no_change`).

## Not built yet

These come later; worlds made now keep working when they arrive:

- **The far field**: the world past the load ring, and tall ground far
  away (above).
- **Kits and cases**: the approved case list and trim layout for detail
  pieces (the drafts draw now), a kit page in the editor, and the guide to
  making a kit.
- **Materials**: material records, texture arrays and wetness beyond
  darkening (shine and filled-in crevices). Today's surface shader is a
  stand-in.
- **Lighting**: the world's own light and shadow, and what reads the light
  coverage props stamp; culling and navigation over voxels.
- **Structures** (rotated grids of their own, such as a ship or a moving
  building), voxel brushes and role painting in the editor, and more MCP
  voxel tools.
- **Converters** from terrain and block layers, and `ctx.grid` over voxels
  ([migration note](migration.md#voxel-worlds-beside-block-layers-and-terrain)).
