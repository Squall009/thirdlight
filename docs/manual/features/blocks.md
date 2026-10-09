# Blocks

## Block layers

A **block layer** builds a level from blocks on a grid (terrain, buildings, a
tactics map, a dungeon, a voxel sandbox). This section covers its data,
storage, rendering, collision, script API and bulk commands; the editor's
brushes, overlays and stamp UI are in [Block layer editing](#block-layer-editing).
How to build a level step by step: [the block layers guide](../guides/block-layers.md).

- **Block types** (`content.blockTypes`, `setBlockType` / `deleteBlockType`):
  up to 8 weighted **looks** each — a model (asset and optional piece), a
  prefab's root model (or, on a **Live** type, the prefab itself: below), or a
  coloured stand-in shaped like the collision shape; a **collision shape** (`full`, `half`, `ramp`, `stairs` — both rising
  toward +Z —, `custom` boxes, `none`); `solid` (hides the faces of
  neighbours touching it; default for `full`); a **footprint** of several
  cells (stored at its min corner, the covered cells stay empty); the allowed
  **rotations**; default cell metadata; a material mapping.
- **Cell metadata schema** (`content.cellFields`, `setCellFields`): fields of
  type bool, enum, int, float or string with defaults, ranges and an overlay
  colour. The schema is the project's own; the engine knows no field names.
  A cell's effective metadata is the schema default, then its block's
  default, then the cell's own value. Cells may hold metadata only.
- **The `blockLayer` component** (Rendering): cell size per axis (e.g.
  `[1, 0.5, 1]`); cells are **square from above** — x must equal z (the
  validator refuses x ≠ z, the Inspector edits both together), only the
  height may differ, so a quarter-turned look always fits its cell; bounds in cells (at most 1024 × 256 × 1024), metadata-only,
  collision and shadow flags. The object's position is the min corner of cell
  `[0, 0, 0]`; a layer is a root (a folder may hold it) at identity rotation
  and unit scale. Deleting the layer object deletes its cells (undo restores
  them). Several layers per scene (up to 16 with cells). There is no count of
  cells: a layer holds as many as its bounds hold, and what bounds it is
  memory. Play diagnostics (`tl_diagnostics` with a play) show it as
  `runtime.blockMemory`: bytes in all, and per layer its chunks, columns,
  cells and bytes (4 bytes a cell plus about 270 bytes a column, so a layer's
  memory grows with its area more than its depth: 1,024 × 1,024 columns take
  about 280 MB). An undo step keeps only the chunks its edit changed, in
  their compact binary form (about 1.5 KB a chunk on a 512 × 512 layer).
- **Storage**: each chunk of 16 × 16 columns is its own file in
  `scenes/<sceneId>.blocks/`, listed by the scene file, in one of two forms
  set by the project setting **Project files → Block chunk files**
  (`block_chunk_storage`):
  - `0` (*JSON text*; what a project that never set it has):
    `<entityId>.<cx>.<cz>.json`, the palette and one run-length column per
    line, so a version-control diff shows the columns that changed;
  - `1` (*Binary*; what new projects are made with): `<entityId>.<cx>.<cz>.bin`,
    the same cells as varints, zstd-compressed — several times smaller and
    faster to open, but a diff only shows that a file changed (the editor's
    `queryBlocks` reads the cells either way).
  Changing the setting rewrites every chunk file in the new form in the same
  save (one undo step). Both forms are always read: a scene file says which
  form its chunks are in (`blockChunkFormat: "binary"`, absent: JSON), so a
  project whose scenes were written in different forms (after a merge, or by
  an older engine) opens as it is, and a scene the editor writes again moves
  to the project's form. Nothing is converted on open. A chunk's paint is
  kept in both forms. External-edit detection and the recovery snapshots
  cover these files like any project file.
- **Export**: Play and the export ship each layer's cells as one binary,
  gzip-compressed blob (`content/sha256/<digest>`, a `manifest.buffers` row);
  the scene files name it (`chunkData`) instead of holding the cells, and the
  game page decodes it with the browser's own gzip before the scene starts.
  On one game's village the exported scene files went from 1.42 MB to
  0.97 MB (its two layers: 11 KB of chunk data); a 512 × 512 test layer of
  1.8 M cells is 73 KB instead of 43 MB of pretty-printed JSON.
- **Editing** (`editBlocks {entityId, edits}`, one undo step, each request
  under 64 KiB): `fill` a box (set / keep / replace), `cells`, `array`
  (run-length data), `replace` a block type, `meta` (paint metadata), `flood`,
  `column` (raise / lower), `stamp`, `copy` (copy / move / mirror / turn a
  selection), `region` (named cell sets: set / add / remove / rename /
  delete), `heightmap` (a greyscale PNG → column heights, an optional colour
  PNG → blocks). Stamps: `setBlockStamp` (whole, or a layer selection) /
  `deleteBlockStamp`. The change names the chunks and regions touched;
  `queryBlocks` (MCP `tl_content_query target="blocks"`) reads layers, chunks,
  a box of cells (with effective metadata) or a region.
- **Rendering**: one merged mesh per block look and material per chunk; faces
  between neighbours are left out (a solid neighbour, or the same face
  profile — two half blocks, two ramps side by side); whole chunks are culled
  outside the view. The Scene view, Play and exports draw layers through the
  same code (WebGPU and WebGL 2).
- **Texture mapping** (`uv` on a block type, and optionally on each look;
  the block type form in the Blocks panel, MCP `setBlockType`): `model` (the
  default) keeps a model's own texture coordinates; `world` gives the look
  texture coordinates from its place in the layer, in **metres** from the
  layer's origin, so a texture runs on across cells without a seam (a kit
  whose pieces each map the whole texture no longer shows the same corner on
  every cell). It is box mapping, one flat projection per face chosen from
  the face's own normal: tops from above (u = x, v = z, the image's top
  toward −Z), walls facing ±X from the side (u along z, v down the wall),
  walls facing ±Z likewise (u along x); every wall shows the image upright
  and unmirrored from outside. A slope keeps the top's projection up to 45°
  and takes its wall's past it; a vertex where two projections meet is split,
  so no triangle mixes them. One texture sample per layer (no triplanar
  blend). A material's **tiling** sets the repeats per metre (0.25: one
  repeat per 4 m). World-mapped looks carry tangents along +u (their
  bitangent up the image, as glTF's), so normal maps light every face the
  same way; on a smooth model (rounded bevels) the tangent follows the
  face's +u, made perpendicular to each vertex's normal. Coloured stand-ins are always
  world-mapped (in metres), and a model piece without texture coordinates
  takes world ones (it used to read the texture's corner).
  On a large layer the UVs **wrap every 720 m** (per chunk, by whole
  720 m periods along x and z), so they stay precise far from the origin.
  A texture whose repeat divides 720 m — 1, 2, 3, 4, 5, 6, 8, 9, 10, 12,
  16 m … and those over a whole number (0.5, 0.25, 1.5 m …) — runs on
  without a seam; another repeat (7 m, 0.7 m, or an old layered material's
  cell-unit repeat on cells whose width does not divide 720 m) shows a seam
  every 720 m, where the period changes. Heights are not wrapped.
- **Collision** (3D projects): one triangle-mesh collider per chunk built from
  the collision shapes, rebuilt when cells change, before the step's physics
  sweep. A 2D-plane project draws layers but they do not collide.
- **Scripts** (`ctx.grid`): `layers`, `get`, `set`, `clear`, `columnTop`,
  `worldToCell`, `cellToWorld`, `meta`, `setMeta`, `pick` (a ray → cell and
  entered face; a deterministic walk over cells, independent of physics),
  `neighbours`, `regions` / `region` / `inRegion`, `changes` (last step's
  writes), `setTypeMaterials` / `typeMaterials` (a block type's material
  swap, shown once the material has loaded), `setCutaway` /
  `setCutawaySubject` / `setCutawayPoint` (cut-aways, below), `setKit` / `kit`
  (kit swaps, below), `walkNeighbours` / `path` / `reachable` (walking the
  layer, below), `diff` / `applyDiff` (plain
  data for a save, the type swaps and kits included). Writes are refused
  (`false`) when they do not fit; at most 4,096 per step. Visual-script nodes
  exist for the calls.
- **Live blocks**: a block type marked **Live** (`live: true`, the
  Blocks panel's block type form) spawns each of its prefab looks as real
  objects of the game, per cell — a door, a lamp, a trigger, a sound, with
  their scripts, movers, lights and children. What a door does is the
  prefab's scripts (the game's), not the engine's.
  - Only cells that need them have objects. They come with the cell and go
    with it: a layer loading or unloading, `ctx.grid.set` / `clear` (the
    objects are in the game from the end of the step that wrote the cell; the
    chunk's collider changes as before), a save loaded, a scene reloaded, a
    run restarted (fresh objects). A cell rewritten with the same prefab and
    rotation keeps its objects and their state.
  - Ids come from the cell — `<layer>-<x>_<y>_<z>` for the root (negative
    coordinates `m<n>`, a layer id over 40 characters shortened to a hash),
    `-<i>` after it for the prefab's i-th object — so they are the same in
    every run, replay and loaded save, and never use the scene's id space.
    Nothing of them is written into the scene file.
  - The prefab's root is the cell's **static part**: placed at the bottom
    centre of the block's footprint, turned with the cell, at unit scale (the
    prefab root's own transform is not used), its model drawn merged into the
    chunk with the other blocks (the spawned root carries no model). It may
    not carry a mover, patrol, gravity, animator, model animation or socket
    attachment; put moving parts on children. A root without a model is a
    logic-only cell (nothing drawn in the chunk, nothing in three.js). No
    object of a live prefab may be a player controller, a block layer or kept
    loaded.
  - `ctx.grid.entity(layer, x, y, z)` names a cell's root object (a covered
    cell names its block's); `ctx.grid.cellOf(id)` gives an object's cell, so
    a script reads and writes its own cell's metadata. Keep a live block's
    lasting state in its cell's metadata: the grid section of a save keeps
    it. Fields written with `ctx.entity(id).set` are kept by the components
    section as for any object. `ctx.destroy` refuses a live block's objects
    (clear the cell); the `spawned` save section leaves them out; they do not
    count against the spawned-object limit.
  - Play diagnostics show `runtime.blockMemory.liveObjects`. Measured:
    500 doors (a scripted root and a leaf with a box collider) cost about
    120 µs each to spawn (60 ms at once when a layer loads), 0.6–1.2 µs each
    per fixed step, and 16 KB of heap each; drawn, 500 leaves are one
    instanced batch (+2 draws with the shadow).
- **Edge pieces**: a block type with **Placement: Edge**
  (`placement: 'edge'`) stands on the edge between two cells instead of in
  a cell — a wall, door, window, fence or railing.
  - An edge is a cell side one row high: on an x grid line (`axis` 0, the
    cell's −x side) or a z grid line (`axis` 1, its −z side); the cell on the
    other side has it as its +x / +z side. A layer's edges reach one past its
    cells along their axis, so its outer border can carry walls. Stack edges
    for a taller wall. They are stored in their chunk beside its cells (the
    chunk file's `edgePalette` and `edges` rows `[lx, lz, y, axis, p]`, also
    in the binary form; additive: projects without edges keep their bytes).
  - A look is drawn with its origin at the bottom centre of the edge, its +X
    along the edge and +Z facing across it (+x or +z; `rot: 180` faces the
    other way — edge pieces turn end for end only). Collision shapes: `full`
    (a slab across the edge, an eighth of a cell thick), `half` (its lower
    half), `custom` boxes in a cell-sized frame centred on the edge, or
    `none`. Edge pieces are merged into the chunk mesh and collider like
    cells; they hide no faces and are never hidden. No footprint or `solid`.
  - **Blocks passage** (`blocking`, default on) says whether the piece stops
    movement across its edge; an **open** piece (`open: true`, a door) never
    does and has no collider. `ctx.grid.edge(layer, x, y, z, side)` reads the
    piece on a cell's side (`-x`, `+x`, `-z`, `+z`) with `blocked`;
    `ctx.grid.blocked(…)` answers just that, for grid movement and
    pathfinding; `setEdge` / `clearEdge` / `setEdgeOpen(…, open)` write them
    (the collider follows in the same step, refused writes return false, the
    4,096-writes-per-step limit counts them). `ctx.grid.changes()` lists edge
    writes with their `side`; the grid save section keeps changed edges
    (`edges` per layer).
  - A **Live** edge piece spawns its prefab on its edge like a live cell (ids
    `<layer>-<x>_<y>_<z>x` / `…z` by the edge's line; `ctx.grid.edgeEntity`,
    and `ctx.grid.cellOf(id)` gives the cell and `side`). Opening or closing
    it keeps its objects; turning or clearing it respawns or removes them.
    What a door does when used is the game's script (e.g. `setEdgeOpen` and
    animating its leaf child).
  - `editBlocks` edit `{kind: 'edges', at: [x, y, z, axis, …] | box, edge |
    null, mode?: 'set' | 'keep'}` (a box takes every edge on its outline and
    inside it); `queryBlocks` with a box lists the edges in it.
  - Copy, move, rotate, mirror, stamps (saved from a selection or placed) and
    paste into another layer carry the edge pieces on and inside the box with
    the cells, turned and mirrored with them; a piece whose type allows only
    one rotation keeps facing that way. A stamp stores them as `edgePalette` +
    `edges` rows `[x, z, y, axis, p]`; an `array` edit takes the same optional
    keys. Not yet: an edge on sloped ground stands at its row's bottom (it
    does not follow the slope).
  - Measured (Node, 40 × 40 terrain with walls 4 rows high on every
    fourth grid line, 356 edges a chunk): meshing 12.4 → 17.0 ms a chunk
    (about 13 µs an edge), collider 3.1 → 7.4 ms a chunk; an edge takes 28
    bytes of memory (`runtime.blockMemory` counts `edges`).
- **Auto-connect**: a block type's **Connections** (`connect`) make
  its look follow its neighbours, so painting "wall" draws the right pieces.
  - `connect.pieces` names the look (variant) of each piece and an optional
    extra turn (`rot`) for looks made facing another way; `connect.with`
    lists other block types (of the same placement) that count as connected
    (the type itself always does).
  - Cells: the four horizontal neighbours pick `single`, `end`, `straight`,
    `corner`, `t` or `cross`. Unturned, the pieces connect toward (the
    block's own frame, +Z the way ramps rise) `end` +Z; `straight` −Z, +Z;
    `corner` +X, +Z; `t` −X, +X, +Z; `cross` all four. The rotation that
    fits is used; where several fit (a straight run, a single post) the
    cell's own rotation is kept.
  - Edge pieces: each end of the edge is open, continues in a line, or turns
    (only edges across it meet there). `single` (both ends open), `end`
    (joined at its +X end only), `straight` (both joined), `corner` (a turn at
    its +X end, so the look can fill the corner; without one the straight
    piece is used). T-joins and crosses happen where several edges meet, so
    an edge piece has no `t` or `cross`. An end or corner piece faces the way
    its joined end decides.
  - Vertically, `base` (a connected one above, none below) and `cap` (one
    below, none above) win over the horizontal piece and keep its turn.
  - A piece not named keeps the ordinary look (weighted, or the cell's
    variant) and rotation. A cell or edge that names a variant is pinned and
    never resolved: paint connected blocks with **Random look** on.
  - Nothing is stored per cell: the look is resolved from the layer wherever
    it is needed (the mesher on the page and in the mesh workers, the
    collider, live blocks, `ctx.grid.get` / `edge`, which report the shown
    `variant` and `rot` and the `piece`), so a rule change shows at once and
    replays and saves need nothing new. A write re-resolves only its
    neighbours: their chunks re-mesh (an edge piece at a chunk border marks
    the next chunk too, opening or closing one does not), and a `ctx.grid`
    write re-resolves live neighbours in the same step (a live piece whose
    prefab or turn changes is respawned). A connected block fills one cell (no
    larger footprint).
  - Measured (Node, a 40 × 40 area with 1,533 connected wall cells and
    463 connected fence edges in 9 chunks): resolving a look takes about
    0.8 µs a cell or edge; meshing 7.5 → 7.9 ms a chunk against the same walls
    unconnected; the level `area` class is unchanged on both renderers.
- **Lightmaps**: a block layer object marked **Static** is baked
  like a static box or model — each chunk gets its own lightmap (one entry
  per chunk in the bake, browser preview and Blender final alike); a chunk
  changed after the bake is drawn without it (the bake shows stale); other
  layers shade baked objects only.
- **Sloped terrain**: a single-cell `full` block may carry
  `corners` — the heights of its top corners (−x−z, +x−z, +x+z, −x+z) in cell
  heights, 0–4 in steps of 1/64 — and is drawn and collides with that sloped
  top (walls where neighbours differ, one smooth surface where their edges
  meet; a slope may cross rows inside a column). `surface` edits set column
  tops by corner heights, `sculpt` dabs raise, lower, smooth or flatten under
  a round brush. The layer's **Max slope** (`maxSlope`, degrees) is the
  steepest ground: characters do not walk up steeper parts, and
  `ctx.grid.surface(layer, position)` / `columnSurface(layer, x, z)` report
  the ground's height, normal, slope and whether it is walkable.
- **Smooth tops**: the layer's **Smoothing angle** (`smoothAngle`, degrees
  0–180, Inspector and MCP) shades its tops smooth where they meet at the
  same height at less than that angle — across cells and chunk edges alike —
  and keeps sharper edges (a crest steeper than the angle, cliffs, walls)
  hard; 0 (the default) keeps flat-shaded tops. **Top subdivision**
  (`topSubdivision` 2) draws sloped tops cut 2 × 2 with the inner heights
  blended from the corners, so noise reads as rolling ground. Colliders and
  surface queries keep the corners' two triangles. Changing either makes a
  baked layer's chunks stale (bake again).
- **Levels of detail**: blocks shown by a model with `_LOD1..n`
  levels switch per chunk — each chunk's models at their coarser level past
  the models' own distance plus the chunk's size; stand-ins stay detailed.
- **Paint and wetness**: a layer's ground carries a paint of four
  material layers and a wetness per lattice vertex, stored with each chunk
  (`paint` edits: a round brush with radius, strength, falloff smooth /
  linear / constant and a channel — layer 1–4 or wetness — or `erase`). A
  painted layer's chunks carry it as vertex colours (COLOR_0 = the four
  layer weights, COLOR_1.r = wetness), so any graph material can read it; the
  **height-blended layers (painted terrain)** material template does: four
  PBR layers from three texture arrays (albedo + height, normal maps,
  occlusion/roughness/metalness) mixed by a Height blend, wet ground darker
  and glossier (a `wetness` parameter wets everything, e.g. rain from a
  script). Map it to a block type with **Materials** `*` → the material — a
  coloured stand-in takes the `*` material too. The paint is
  visual: scripts do not read it, replays do not depend on it.
- **Wall paint and wetness**: a block layer with **Wall paint**
  (`blockLayer.wallPaint: true`; off by default, then walls show the paint of
  the top above them as before) gives walls paint of their own: points
  about 0.5 m apart on the exposed wall faces (per cell side `round(cell
  width / 0.5)` steps across, per row `round(row height / 0.5)` up, 1–16
  each), stored sparsely with the chunk (`wallPaint`, 9 bytes a painted
  point, in JSON and binary chunk files). An unpainted wall shows material
  layer 2, an unpainted top layer 1; the top's paint wraps over the lip onto
  the wall's top row of points and fades to the wall's own one row of
  points down; wall faces are drawn cut at the points (more vertices: the
  paint shows between cell corners). `paint` edits take `target: "walls"`
  or `"both"` (absent: tops) and the brush centre's height `y` (rows): every
  exposed wall point within the radius, by distance in metres. In the
  editor: Paint texture, **On** Tops / Walls / Tops and walls, dragged over
  the wall's face. Wall points stay where they are when heights change.
  Templates made by this engine add the scene's **wetness** (the scene look's
  `wetness`, 0–1, rain; presets blend it) to the painted one, let water pool
  in the low parts of the blended height first (`wetPooling`, 0.5: 0 even, 1
  the cracks fill well before the tops) and flatten the normal maps where
  wet (`wetFlatten`, 0.7) — no extra texture read. A layered material made
  by an older engine keeps its graph and look (make a new one from the template for
  these).
- **Cut-aways (interiors)**: a layer's `cutaway` (Inspector
  **Cut-away**, MCP `setComponent blockLayer`) lists what is hidden from the
  view while the *subject* is under or inside it — by default the camera's
  target (the object the live virtual camera follows or frames; a camera
  without a target cuts nothing):
  - `regions: [{region, when?}]` — a named region of the layer: its cells are
    hidden while the subject stands under one of its boxes (within its
    columns, below its lowest row: the roof and upper floors over the
    player), or, with `when`, while the subject is inside that other region
    (the walls round the room it is in). Edge pieces on a region's outline go
    with it. A region that does not exist cuts nothing.
  - `planes: [row]` — every cell from the row up, across the layer, while
    the subject is below that row (the floors above a dungeon level).
  - `fade` — seconds a zone takes to fade out or back in (default 0.25, 0 at
    once). The first frame takes each zone's state at once (no fading roofs
    when a level starts).
  - Drawing only: collision, grid queries, the key light's shadow and baked
    probes are as if nothing were cut — a cut roof still shades the room
    under it (so the room keeps the light the probes baked for it, and the
    cached static shadow map is never drawn again for a cut). Interiors are
    lit by the probes and by lights in the layer's light layers as before.
  - Scripts: `ctx.grid.setCutaway(layer, zone, true | false | null)` forces a
    zone hidden or shown (null: back to the subject; a zone is a listed
    region's id or `"#<row>"` for a plane), `ctx.grid.setCutawaySubject(id |
    null)` and `ctx.grid.setCutawayPoint([x, y, z])` name what decides
    instead of the camera's target. A new run forgets them; saves do not
    keep them (set them again when a save loads).
  - Cost: a cut-away's cells are drawn as meshes of their own (a draw or two
    more per chunk a zone touches); a cut zone's meshes are left out of the
    view's draws; a fading one draws a dithered copy (one material variant per
    material, compiled while the level loads). The faces between a zone's
    cells and the rest are kept (the top of a wall under a cut roof).
    Measured (the level `area` class with a roof on each of its 10
    rooms, half held cut and half swapped every 2 s): WebGPU p50/p95 6.6/9.7
    ms against 6.5/9.3 with the same roofs never cut, GPU 10.33 vs 10.32 ms,
    main thread 6.62 vs 6.54 ms; WebGL 2 2.8/6.7 vs 2.6/6.9 ms; one shadow
    draw a frame throughout (the static map never drawn again).
- **Kit swaps**: one layout, several looks — a dungeon and its burnt
  or ruined state share their cells.
  - A block type's `kits` (Blocks panel type form **Kits**, MCP
    `setBlockType`) maps a kit name to what it shows under that kit:
    `{block, variant?, variants?}` — another block type of the same placement
    (cell or edge) and footprint (checked: a kit keeps the layout), and
    optionally its look (`variant`, or `variants`: one per look of this type).
    Without a look the cell keeps its own when the target has it, else one is
    picked by the target's weights, and a connected target resolves its
    pieces from its (swapped) neighbours. A kit is every type's entry under
    one name; a type without an entry keeps its look.
  - A layer's `kits: [{kit, region?}]` (Blocks panel **Kit** on the layer bar
    and per region, Inspector, MCP `setComponent blockLayer`) — one for the
    whole layer and one per region at most; a region's kit wins where it
    swaps a block (edge pieces on the region's outline go with it). The cells,
    saves, undo and `ctx.grid.get(…).block` stay the authored ones; what is
    drawn, collides (where the target's shape differs), spawns as a live
    block and answers surface queries is the swap (`get`/`edge` report it as
    `kitBlock`, with its rotation, look and piece; an edge's `blocked` is the
    swap's).
  - Scripts: `ctx.grid.setKit(layer, kit | null, region?)` shows a kit (null:
    none there, the authored one included), `ctx.grid.kit(layer, region?)`
    reads it; saved in the grid section (`diff().kits`), back to the authored
    kits on a new run. Live blocks respawn where the swap changes their
    prefab or turn (the same prefab keeps its objects and state).
  - Drawing a swap is a *restyle*: every chunk of the layer re-meshes in the
    mesh workers, each drawing its old meshes until its new ones arrive (a
    swap shows over a few frames, not in one), and the cached static shadow
    is held meanwhile and drawn again once, when the last chunk is in (until
    then the old chunks' shadow stays in it and the new chunks are drawn by
    the dynamic map). A block-type change (an edit, a script's
    `setTypeMaterials`) is a restyle too. Each is timed in the renderer's
    `blocks.restyles` diagnostics and a `tl:blocks:restyle` mark.
  - Measured (`node tools/perf/run.mjs level --classes area
    --kit-swap`: every block type has a burnt twin, a script shows and takes
    off the kit over the whole 100 × 100 m layer every 2 s; Iris Xe, 1080p):
    a swap re-meshes the layer's 49 chunks in 300–415 ms (two workers), the
    page's own work at most 4 ms a frame; frames over 16.7 ms during swaps
    0.7 % on WebGPU and 2.4 % on WebGL 2, the class's rate without swaps
    (1.3 % / 2.4 %); whole run WebGPU p50/p95 6.6/9.8 ms, GPU 10.4 ms, main
    6.59 ms, 259 draws. A layer with no kit is meshed as before (byte for
    byte).
  - Problems (Play, export): a layer whose cut-aways or kits name a region it
    does not have, or a kit no block type has, is a warning. Renaming a
    region in the Blocks panel renames it in the layer's cut-aways and kits
    (a second undo step); deleting it there removes those entries.
- **Walking a layer**: `ctx.grid.walkNeighbours(layer, [x, y, z],
  options?)`, `ctx.grid.path(layer, from, to, options?)` and
  `ctx.grid.reachable(layer, from, maxCost, options?)` (visual-script nodes
  Walk neighbours / Walk path / Walk reach). A *place* is a block top with
  free headroom over it on a walkable slope, named by the cell whose top it
  is (a walker's own cell names the top under it). A step goes to one of the
  four neighbouring columns (eight with `diagonal`, only where both ways
  round the corner walk) when the tops rise at most `maxStep` or drop at
  most `maxDrop` where they meet (a ramp's low end meets the floor, a stair's
  front is half a row), both columns are free to the higher top plus the
  `headroom`, and no edge piece that blocks (a wall, a closed door; under a
  kit, the swapped piece) stands between them in the rows passed through.
  Each result is a list of `{x, y, z, point, cost}` (the world point on the
  top at the cell's centre; the cost so far in metres). Options: `maxStep`,
  `maxDrop`, `headroom` (m), `maxSlope` (degrees), `diagonal`, `field` (a
  yes/no cell field: only tops where it is on are walked), `costField` (a
  number field: entering a cell costs its value per metre, 0 or less: never
  entered), `avoid` (cells taken, e.g. by units). Defaults come from the
  layer's **Walk** (Inspector, MCP `setComponent blockLayer` `walk`:
  `{from?, maxStep?, maxDrop?, headroom?, field?, diagonal?}`), else half a
  cell height up and down, one cell height of headroom and the layer's (or
  project's) slope limit. A query expands at most 65,536 places (`path` is
  null past it; `ctx.grid.pathOutcome()` then says `limit`, where a path
  that does not exist says `none`). The graph is kept between queries until the layer is
  written or its kits change, so asking again is cheap; measured on a
  100 × 100 m hilly layer: a path into a room 0.02 ms, a 20 m move range
  1.6 ms, a path across the whole layer 18–25 ms (37–83 ms the first time):
  path on an order, not every step. How units move along it is the game's.
- **Level checks in Problems**: after block edits settle, the backend
  checks each layer and lists, once per change: blocks that float
  (`block_floating`: not joined, through blocks or edge pieces, to the
  layer's lowest blocks), regions with no cell inside the layer's bounds
  (`block_region_empty`), and — when the layer's Walk names a **From region**
  — places to stand a walk from that region cannot reach
  (`block_unreachable`; wall tops and roofs are places too: mark walkable
  cells with a yes/no field and set it as the Walk's **Walkable field**).
  The editor's Problems window and `tl_diagnostics` show them; a whole
  100 × 100 m layer checks in about 0.15 s, off the editor's frame.
- **Corner shading**: a layer's `vertexAO` (Inspector **Corner
  shading**, 0–1; off by default) darkens corners and creases closed in by
  neighbouring blocks — the foot of a wall, an inside corner, where a hill
  meets a wall, the floor beside walls made of edge pieces — taking that
  much of their indirect light (sun light is not touched; shadows do that).
  It is worked out when a chunk is meshed (in the mesh workers: about 3–5 ms
  more a 16 × 16 chunk, 4 bytes a vertex) and costs no GPU time measured
  (the area class 6.6/9.7 ms with it, 6.6/9.6 without). Use it where
  indirect light dominates (interiors, shade, a quality level without SSAO);
  a layer with baked lightmaps has its occlusion in the bake already.
- **Material rules** (`blockLayer.rules`, the Blocks panel's **Rules…**):
  the terrain's rule list (see [Terrain: material rules](terrain.md#terrain)), for layers 0-3, plus **block types**
  and **cell metadata** conditions; evaluated at every vertex when a chunk is
  meshed (in the mesh workers) — walls and steep tops by their own slope,
  top or wall by the face's box-mapping side. Hand paint stays over them: a
  top's layer-0 share and a wall point's layer-1 share (the unpainted
  defaults) show the rules, so painting another layer covers them and
  erasing gives them back (painting layer 0 itself by hand also shows the
  rules there). Changing the rules or moving the layer re-meshes it in the
  workers like a kit swap. Measured: +16 ms a chunk of paint work in the
  workers (64 × 64 sloped rooms, 4 rules with cavity and noise; meshing
  itself ~31 ms); the Scene view while a 128 × 128 layer's rules change
  draws as during a block type change (worst 18.4 ms, none over 33 ms).
- **Per-layer settings**: the template's four layers each have a
  **tiling** (metres per repeat of the layer's textures, 1 by default), a
  **normal strength** (0: flat), and a **height contrast** and **height
  offset** for the blend (the layer's height becomes (height − 0.5) ×
  contrast + 0.5 + offset: a contrast above 1 pushes its peaks and cracks
  apart, an offset lifts it over the others). The Material editor shows them
  as a **Layers** table above the exposed parameters; they are four vec4
  parameters (`layerTiling`, `layerNormalStrength`, `layerContrast`,
  `layerOffset`, one component per layer), so instances, objects and scripts
  override them like any public parameter. **Projection** (`layerProjection`,
  templates made by this engine; older ones read at the top): **top**
  (the UV: world XZ on terrain and block tops — stretched on steep ground),
  **by slope** (the world plane the surface faces most: the top, or the side
  wall plane on steep ground — cliffs without stretching, still one read; a
  seam where a slope turns past 45°), or **biplanar** (the top and the side
  plane blended by the slope: two reads, only within `biplanarDistance`
  metres of the camera, 60 by default, past it by slope). No layer is
  triplanar. The table states the cost: 12 texture reads a pixel, 3 more
  for a biplanar layer where both its planes show near the camera. The
  projection is the material's own (objects cannot override it; instances
  can), so a layer left at the top compiles to the plain read and costs what
  it did. Measured (Iris Xe, 1080p, the landscape class with every terrain
  layer projected): the scene pass +0.13 ms by slope, +0.54 ms biplanar. A
  terrain draws more than four
  layers: **Add layer** in the table gives layer 5 on settings of its own
  (`extraLayers` on each of the four parameters; without a column, layer L
  takes column L % 4's). They are uniforms: still twelve
  texture reads. The Height blend node takes `contrast` and `offset` as
  inputs of its own (unwired: the heights as they are). A layered material
  made by an older engine keeps its one `tiling`, `blendDepth` and
  `normalStrength`, and its look: on a block layer its UVs stay in cells as
  they were then (its `tiling` repeats per cell width on tops, per cell
  width and height on walls); make a new one from the template to set the
  layers apart.
- **Normal maps** are read as OpenGL / glTF ones (green toward the top of
  the image; the Texture Designer writes them so): a bump lights from the
  same side on painted terrain, plain graph materials and the standard
  shader, on block cells, boxes and models alike. Older engines read
  the green of project materials the other way round on boxes, primitives and
  block cells, and graph materials also on models without tangents (a bump
  lit from the wrong side; a model's own glTF materials, and a standard
  material on a model, were right). A texture made to look right on those
  then needs its green turned around now. A kit material made from the
  template before it used Normal map nodes (its normal decoded by hand as
  texture × 2 − 1, nodes `detailDecoded` / `macroDecoded`) is read the same
  way: its green is turned around where a Normal map node's would be. A
  normal decoded by hand in a graph of your own is used as wired (its green
  as stored, in the mesh's tangent frame); use a Normal map node instead.
  A model's own normal scale keeps its sign (a glTF `normalTexture.scale`
  below 0 inverts the bumps, as the file says).

## Block layer editing

A block layer's tools show in its Inspector while it is selected (GameObject → Block layer makes one); they edit block layers in the Scene view. Every
action is an ordinary command — `editBlocks` for cells and regions,
`setBlockType` / `setCellFields` / `setBlockStamp` for content — so each
stroke or button is one undo step, and MCP can do the same.

- **Layer**: choose the layer the tools edit (+ Layer makes a 64 × 16 × 64
  layer of 1 m cells); Hide and Lock are the object's Active and Locked flags
  (the Hierarchy shows the same). **Slice**: the row the tools use where no
  block is under the pointer — PageUp / PageDown or ] / [, or the − / + and
  number box. The grid of that row and the layer's bounds are drawn.
- **Tools** (the left button; Alt+drag or the right button orbits while
  "Edit cells" is on): Paint and Erase (drag, cell by cell), Line,
  Rectangle, Box (the rectangle raised to the box height), Flood, Raise /
  lower (Ctrl held or "Lower / remove" lowers), Height, Smooth and Flatten
  (terrain, 25.20: a round brush over the ground with Radius and Strength —
  Height raises or, with Ctrl, lowers the ground with sloped tops, Smooth
  evens it out, Flatten levels it to the height where the drag starts; a
  drag is one undo step), Paint texture (the Paint mode, 25.21: a round
  brush painting material layer 1–4 or wetness with Radius, Strength and
  Falloff, **On** the tops, the walls (a layer with Wall paint) or both;
  Ctrl or "Lower / remove" erases; a drag is one undo step), Pick (the eyedropper takes a
  cell's block, rotation and look), Replace all (every block of the clicked
  type becomes the brush block), Metadata, Select, Paste, Stamp and Region.
  Adding tools place on the face under the pointer. A stroke previews at once
  and is stored when the button is released (Esc drops it). With an **edge
  piece** as the brush block, Paint and Erase take the cell edge nearest the
  pointer (on the row in front of the face under it) and every edge the drag
  passes, Line runs along the grid line between the press and release
  corners (in the longer direction), and Rectangle draws the edges of its
  outline (a room's walls); each is one undo step.
- **Brush**: Rotate (Q) steps through the block type's allowed rotations (an
  edge piece: 0 and 180);
  "Random look" lets every cell show a look picked by the variants' weights
  (stable by position), or a connected block's pieces; off paints the chosen
  look (pinned: a connected block's cell then does not follow its
  neighbours).
- **Palette**: the project's block types as colour swatches (a model's
  thumbnail when it has one); + Block type makes one; clicking a type opens
  its form (looks, collision shape, footprint, rotations, default metadata,
  materials) — the same fields as its content descriptor.
- **Metadata**: pick a cell field and a value (or Clear), Cells or Rectangle,
  "Occupied only"; the overlay toggles colour the fields on the cells (the
  field's colour, a palette per choice for an enum, a shade along the range
  for numbers) with a legend. "Cell fields" edits the schema.
- **Selection**: Select drags a box; Copy (Ctrl+C) / Move (Ctrl+X) then click
  with Paste (another layer works too); Mirror X / Z, Rotate 90°, Delete
  (Del); "Save as stamp". **Stamps**: the library places a stamp (turned or
  mirrored) with the Stamp tool, or deletes it.
- **Regions**: the layer's named regions are outlined; click one to paint it
  with the Region tool (Ctrl removes), + Region makes one (from the selection
  when there is one), Rename, delete, "Add / Remove selection". **Cut**
  marks a region cut away in the game (the layer's `cutaway.regions`, one
  undo step); **Preview** then shows the Scene view as the game does while
  it is cut (it fades out; editor only, nothing stored). The Scene view has
  no camera target, so nothing is cut there unless previewed. **Kit** (a
  region's, and the layer's on the bar) shows a kit there (the layer's
  `kits`, one undo step); the Scene view re-meshes with it. Rename and delete
  take the region's cut-away and kit along.
- **Props on blocks**: Edit → Snapping settings… sets the move, rotate and
  scale steps (per project, in this browser; defaults 0.25 m, 15°, 0.25) and
  "Snap objects to block cell tops": moved and dropped objects land on the
  top of the columns under them. The **Block footprint** component (`layer?`,
  `size` [x, z] cells, `set` {field: value}) writes its metadata into the
  cells beneath the object with the command that places, moves, turns or
  deletes it, or sets the component (clearing them where it stood), in the
  editor and over MCP alike: one undo step takes the object and its cells
  back together. The Inspector's "Write to cells" writes it again after the
  cells were edited by hand. Cells are picked from the object's world place
  (a parent's move counts). A prop that stays keeps its fields on cells it
  shares with a moved or deleted one. Setting a footprint with a field the
  cell schema lacks is refused (the message names the field and the layer);
  a field dropped from the schema later is skipped when the prop moves. The runtime ignores the component (scripts read
  the cells). An `editBlocks` with surface or sculpt edits reports
  `rebased`, the columns whose top row moved.
- **Measured**: a stroke on a 64 × 64 × 16 layer holding 32,768 cells
  previews in about 40–55 ms per pointer move and is stored about
  110–160 ms after release on the test host.

## Blocks on terrain

A block area (a block layer: a village, a courtyard, a dungeon mouth) stands
on a terrain that reaches the horizon. A **blocks** edit layer on the terrain
(`terrain.layers` kind `blocks`; the terrain tools' **Layers… → Add blocks
layer**, or MCP `setComponent terrain {layers}`) makes the ground meet it:

- **Where it meets**: a block layer's footprint is its columns holding a
  block with a surface (any shape but `none`; a larger block covers its
  footprint's columns). Its **ground** in a column is the top of the
  column's lowest run of blocks — a sloped top's corner heights, a ramp's
  rise — so rock under grass meets the terrain at the grass and a cliff at
  its top (a wall stacked of cells on the ground cells raises its column's
  ground to the wall's top: build walls on a border from edge pieces, which
  leave the ground alone). Where columns share an edge or corner the lowest
  of their tops counts, so the terrain never stands above a block's top edge.
- **The border**: the terrain's samples on the footprint's border take that
  ground exactly (no step, no crack); outside, within **`blend`** metres
  (default 8, 0–256), the ground fades from the nearest border point's
  height back to its own (smoothstep: it leaves the border level, so slopes
  meet smoothly).
- **Under the blocks** (`mode`): **`cut`** (default) makes holes of the
  terrain cells the footprint covers, a cell in from its border — that ring
  stays, 2 cm under the tops, so the hole's edge is never on the border
  itself (where the ground's last pixels, cut per pixel, would let the sky
  through beside side faces facing away) — and nothing else is drawn or
  collides under the blocks; **`flatten`** keeps the ground whole, 2 cm
  under the tops (`TERRAIN_BLOCKS_SINK`, at least one height step): no
  collider patches, and a stand-in for the block area where a streamed block
  layer is not drawn. With `cut`, keep a streamed block layer's render ring
  at least as far as the terrain is seen with the block area in it (past its
  ring the block area is not drawn and the holes show what is behind them).
- **Material**: the blocks' paint (the chunk's hand paint over the block
  layer's material rules, as its tops show it) carries across the border by
  the same fade (`paint: false` keeps it theirs); the terrain's own hand
  paint stays over it. Give the terrain and the block layer's ground types
  the same layered material: the terrain then counts its texture
  coordinates from the first block layer's origin (`terrain.uvOrigin`,
  written by the host whenever the blocks layer meets a block layer), so
  the textures line up across the border whatever their repeat.
- **Scatter**: the terrain's stored scatter and its ground cover keep off
  the footprint (the export ships the blocks layer's settings for the ground
  cover; the rest of the edit layers stays in the editor).
- **Which block layers**: `blockLayers` names them (absent: every block
  layer of the scene). Other settings: `enabled`, `strength` (the share of
  its change kept) and its place in the layer list, as every edit layer.
- **Edits re-bake round the edit**: a block edit (or a block layer moved,
  re-gridded, given other rules) is followed in the same command and undo
  step: the terrain is combined again (heights, holes, rules and paint,
  scatter) over the columns whose cells changed — a whole chunk when its
  paint changed — grown by 9 cells and the blend. Measured (this host, Node,
  `TL_PERF=1 npx vitest run tests/perf/terrain-blocks.test.ts`: 2 × 2 tiles
  of 257² at 1 m with the landscape's rules and scatter, a 100 × 100 m area):
  adding the blocks layer 480 ms (4 tiles); a border column raised a row
  162 ms (one tile, plan 144 ms, encode 17 ms); a 2 m repaint at the border
  140 ms; an edit deep inside that moves no ground 113 ms, nothing written.
  A wide blend costs by the ground it reaches (the nearest border is
  found among the footprint's columns near a sample, not over the blend's
  whole square): the same layer added at 32 m 0.4 s, 128 m 2.6 s, 256 m
  7.3 s (the area grown by the blend re-baked).
  The backend does it: no frame of the editor or a game waits on it.
- **Lighting**: both sides of the border are lit alike — the same
  material, normals that read across the border (the ground under the
  blocks is theirs within 2 cm), the same cached shadow, and the same
  probes: a probe bake over a scene without probe volumes grows its tiles
  past the static objects by the widest blend of a terrain's blocks layers
  and a spacing (and down by the blend), so the blended ground reads the
  block area's probes, not the flat ambient past them. The far ground uses
  its baked horizon light (see [Terrain](terrain.md#terrain), *Far ground*). The terrain is not yet an
  occluder or bounce surface in the probe bake.
- **Collision**: the terrain's edge is the blocks' top edge, so a character
  walks from the ground onto the blocks and off again without a step or a
  snag (terrain-cdlod e2e: a player crossing an 8 m area both ways never
  sank more than 2 cm below the ground). Scenery-only ground: `collision:
  false` on the terrain (gameplay queries, `ctx.grid`, stay on the block
  layer either way).
- **Not read**: kits — a kit's shapes are not the ground the terrain
  meets (the block types are); a block type's shape changed in the content
  reaches the terrain at the next edit there.
