# Terrain

How to build terrain step by step: [the terrain guide](../guides/terrain.md).

## Terrain

A `terrain` component makes an object a heightfield of square tiles for
landscape (block layers stay the tool for authored structure). It is drawn in
the Scene view, Play and an export alike and collides in 3D games, and is
edited with the editor's Terrain tools.

- **The component** `{tileSamples, spacing, heightRange: [low, high], tiles:
  [{x, z, data?}]}`: each tile holds `tileSamples × tileSamples` samples
  (17, 33, 65, 129, 257, 513 or 1,025; neighbouring tiles share their edge
  samples) `spacing` metres apart; tile (x, z) covers x…x + 1 tile widths
  from the object's position (its rotation and scale are not applied).
  Heights are 16-bit steps between `low` and `high` metres above the object
  (a 512 m range is held to 8 mm; a narrower range is finer). A tile without
  `data` is flat at 0 m: a terrain is made by naming its tiles, e.g.
  `setComponent terrain {tileSamples: 257, spacing: 1, heightRange: [-128, 384],
  tiles: [{x: 0, z: 0}, {x: 1, z: 0}]}`. Changing `heightRange` later
  stretches the stored heights with it; `tileSamples` is fixed once tiles hold
  data (a tile of another size is refused). **`collision`** (optional,
  default on; stored only when off): the tiles are colliders in a 3D game —
  turn it off for scenery the player never reaches.
- **Tiles are files**: each tile's heights, baked layer weights (the four
  strongest layers per sample, so the number of layers is not tied to
  texture channels), hole mask and hand paint (kept apart from the baked
  weights, so rules can be baked again without losing it) are one
  content-addressed blob in the project's source store
  (`sources/sha256/<digest>`, gzip), named by `data`. An edit writes new
  blobs and the component names them; undo and redo point back at the old
  digests. Read a tile's bytes with `GET content/buffers/<digest>`.
- **`editTerrain {entityId, kind, …}`** is one edit and one undo, in the
  editor and over MCP alike; points are world metres:
  - `raise`, `lower`, `smooth`, `flatten` (`height`, world y), `noise`
    (`scale` m, `seed`): `dabs: [[x, z], …]`, `radius` (m), `strength`
    (metres at the centre for raise, lower and noise; the blend 0–1 for
    smooth and flatten), `falloff` smooth | linear | constant;
  - `ramp {from: [x, y, z], to: [x, y, z], radius (half the width), strength,
    falloff?}` lays the ground onto the slope between the two points;
  - `paint {dabs, radius, strength, layer 0–255, erase?}` paints hand paint
    over the baked layers (`erase` gives the samples back to the baked
    layers);
  - `holes {dabs, radius, erase?}` cuts the cells whose centres are within the
    radius out of the terrain (or fills them back);
  - `import {stageId, format: png16 | raw16, size?: [w, h], byteOrder?:
    little | big, at?: [tileX, tileZ], range?: [low, high]}` lays an uploaded
    16-bit heightmap one pixel per sample (rows go +z) from tile `at`, adding
    the tiles it reaches; its 0 and 65,535 stand for `range` (absent: the
    terrain's own, so the values copy straight across). RAW files are
    little-endian unless told (World Machine, Gaea and Unity write that); a
    square RAW needs no size;
  - `fromBlocks {source}` turns a block layer whose surface is corner heights
    into tiles: every sample over the layer takes the layer's top there,
    cells over columns without blocks become holes, painted layers 0–3 come
    as hand paint (wetness is not carried).
  The result names what it did: `terrain {tiles: [[x, z], …] written, added,
  changed (samples, or hole cells), clamped? (heights outside the range)}`.
  The same stroke gives the same tiles every time (squared distances and
  16-bit steps only).
- **Material rules** (`terrain.rules`; the terrain tools' **Material
  rules…**, MCP `editTerrain` kind `bake {rules}`): a list of rules, each a
  material layer, a strength (0-1), top or wall faces and conditions —
  **height** (world metres), **slope** (degrees), **cavity** (metres the
  ground `radius` metres around lies above the point: positive in hollows),
  a **noise** mask (0-1, its bumps `scale` metres apart, a seed) and the
  **share** another layer has from the rules before it — each a range
  (min, max, either open) with a **fade** past its ends. They apply in
  order, each taking its share of every layer so far; where none applies the
  ground is layer 0. **Apply** bakes them into every tile's baked weights
  (one command, one undo); a sculpt, ramp, import or conversion bakes them
  again where it moved the ground, in the same command. Hand paint is a map
  of its own and stays over the rules through every bake; erasing it shows
  the rules again. The game only reads the baked weights (no rule runs per
  frame). The same rules paint block layers (below); positions and heights
  are world ones, so a block area and the terrain round it match. A
  `setComponent` of `rules` alone stores them without baking. Measured (one
  backend, 4 rules with cavity and noise): about 0.4-0.8 µs a sample — a
  257² tile 54 ms, a 1,025² tile 0.45 s, a 16 m sculpt's re-bake 7-16 ms; the
  landscape perf class's 144 tiles 7.3 s for an Apply. Drawing cost: none
  (`level --rules`: GPU 12.8-13.0 ms with and without).
- **Reading**: `queryTerrain` (MCP `tl_content_query target="terrain"`)
  lists each terrain with its tiles, `storedBytes` and `memoryBytes` (what
  its tiles take decoded in a game: a terrain has no tile cap, its memory is
  what bounds it); with `entityId` the tiles one by one, and with `points:
  [[x, z], …]` the surface there (height, normal, slope, layers, hole).
- **The surface**: between samples each cell is two triangles split from
  its (+x, min z) corner to its (min x, +z) corner — the triangles the finest
  level draws, the colliders hold and `queryTerrain` / the terrain field
  answer, so they agree exactly near the camera (further out the coarser
  levels are an approximation of it, for the eye only). Older engines
  answered queries bilinearly: the two differ by at most a quarter of a
  cell's twist (|h00 + h11 − h10 − h01| / 4).
- **Play and export** ship each tile blob as it is stored (a
  `manifest.buffers` row, `content/sha256/<digest>`). The game page reads a
  start scene's tiles before the game starts (a scene loaded later: before
  it reaches the game), inflates, decodes and packs them for drawing on a
  worker (the view worker, `js/mesh-worker.js`, shipped with block layers or
  terrain; without it the page does it), and keeps one decoded copy of each,
  which the renderer, picking and the simulation's colliders share (a
  simulation in its worker gets a copy of the heights and holes).
- **Collision** (3D games): a tile is one heightfield collider; a tile with
  holes is cut into 16 × 16-cell patches — whole ones merged into
  rectangles, each a heightfield; cut ones a triangle mesh of their whole
  cells — so a character falls through a hole. Colliders are added and
  removed in the same batches as block layers' chunks, between steps; a tile
  whose data has not arrived has none yet. Rays (`ctx.physics.raycast3d`)
  hit the terrain and name its object. Without streaming rings every tile
  collides; with them, the tiles in the collision ring (see
  [World streaming](streaming.md)).
- **Picking** in the Scene view reads the terrain's heights (click to select
  it; drops land on it).
- **Terrain tools** (the Inspector of a selected terrain, beside where a
  block layer shows its Blocks tools; **GameObject → Terrain** makes a new
  one: 2 × 2 tiles of 257 samples a metre apart, heights −128 to 384 m):
  Raise, Lower, Smooth, Flatten (to the height where the stroke began),
  Noise (size, seed), Ramp (drag from one end to the other), Paint (pick a
  layer: eight swatches or any number 0–255) and Holes; Radius (m),
  Strength (metres for raise, lower and noise; a 0–1 blend for the others)
  and Falloff. Ctrl (or the Lower / erase / fill toggle) lowers, takes hand
  paint back or fills holes for one stroke. **Edit terrain** arms the tools:
  a left drag sculpts (Alt+drag or the right button orbits), Esc drops the
  stroke in flight. The cursor is a ring laid on the ground under the
  pointer. A stroke is previewed on the GPU while the pointer is held — each
  dab changes the drawn tiles' textures in place before the next frame, no
  tile is re-packed or meshed on the CPU and nothing is sent per dab — and
  the release stores one `editTerrain` (one undo); the tiles it changed are
  read and uploaded again over the preview, the others drawn from what they
  held. The preview's heights are the stored ones (to a step in rare
  rounding cases), its paint a close approximation the stored tiles settle
  (an erase previews toward layer 0, what ground without rules bakes),
  its holes exact. A stroke holds at most the dabs the command takes at its
  radius (992 at 64 m on a 1 m grid; more is the next stroke). **Import
  heightmap…** stages a 16-bit PNG or RAW file (a square RAW names its own
  size) and lays it from a chosen tile with the heights its 0 and 65,535
  stand for; **From block layer → Convert** turns a block layer's surface
  into the terrain's samples. Each is one undo step. Measured (Iris Xe, both
  renderers): a 64 m raise dragged over a 1,025² tile costs the page about
  0.25 ms a frame (at most 0.5 ms; no frame missed), is stored about 140 ms
  after the release and its stored tile replaces the preview about 150 ms
  after it; read back, the preview's heights match the stored ones (at most
  one sample a step off). The passes are built when a tool or terrain is
  chosen, not on the first dab. `?terrainCheck=1` on the editor's URL reads
  each stroke's preview back and compares it with the stored tiles
  (`data-terrain-stroke` on the Scene view; a test's measure).
- **Drawing** (CDLOD): each tile is a quadtree whose nodes are one shared
  16 × 16 grid drawn instanced, raised in the vertex shader from the tile's
  heights and morphed between levels by distance, so levels meet without
  cracks or pops; a page of up to 256 tiles (`TERRAIN_PAGE_LAYERS`, the
  texture-array layers both renderers guarantee) is one draw. The finest
  level reaches **`lodDistance`** metres (optional; each coarser level twice
  as far; absent or smaller: the least the tile size allows, 4.5 × 16 cells ×
  `spacing`); a quality level's or the project's **LOD bias** divides it. Past
  the coarsest level each tile is one node, so a terrain reaches the horizon
  (put fog there). A sculpt, paint or holes edit uploads only the changed
  tiles again; the sun's cached static shadow is drawn again once.
- **Material**: give the object a `materials` component with `"*"` naming a
  graph material (a script's material swap reaches it too) — the
  **height-blended layers** template draws any number of the terrain's
  layers: layer L is read from its texture arrays' layer L (put one array
  layer per terrain layer), through the template's four slots — a layer goes
  in slot L % 4. Its per-layer settings (tiling, normal strength, height
  contrast and offset) are its own once the material's layer table has a
  column for it (**Add layer**: the settings' `extraLayers`, values for
  layers 4, 5, … read per pixel from a uniform array, no extra texture
  read); a layer without its own column takes column L % 4's. Number layers
  that meet so they fall in different slots: two layers of one slot at
  neighbouring samples meet at a hard edge (at one sample, the stronger
  shows). Layer weights
  stand in for the template's painted vertex colours; texture coordinates are
  metres from the terrain's corner, +u along x, +v along z, as block layers'
  tops. The terrain's own reads are three a pixel (weights, layer indices,
  hole) beside the template's twelve. Without a graph material the four slots
  show as plain colours (green, brown, grey, sand). Holes are cut away (also
  from the shadow). Light layers and local-light modes come from the
  object's components as for any object; the terrain casts into the cached
  static shadow and receives the scene's probes and ambient occlusion.
- **Far ground** (`macroDistance`, metres; optional, absent: the material's
  layers everywhere): each tile's look is baked from straight above into a
  small **macro texture** — its albedo and world normal (heights and normal
  maps together), and its sunlight, at most 128 texels a side (a smaller tile: one a cell) —
  once its texels are up, again whenever it changes or its material does,
  on the GPU, within 2 ms of the page's time a frame. Holes are baked
  through (the ground's look under them; the far material cuts them itself),
  so no dark rim shows round a hole or a block area standing in one.
  **Horizon light**: each bake also measures the ground's horizon over the
  heights of the tile and its neighbours on the page (8 directions and one
  toward the sun, out to 256 m or a tile): the share of the sky a texel
  sees darkens the far ground's ambient and probe light (ambient occlusion),
  and the sun behind its horizon shadows it (with the shadow maps where they
  reach) — mountains shade valleys and cast long evening shadows where no
  shadow map goes. A tile's neighbours are baked again when it changes; a
  sun turned by more than 2° bakes every far tile's sunlight alone again
  (a third texture a tile, drawn over one node across the tile: one
  direction's reads), 8 tiles a frame at most, so a day cycle's sun costs
  no missed frames (landscape class, 60 s of a sun swept dawn to dusk
  and back every 2 min: 0 missed refreshes on both renderers, against 332
  and 58 when it baked whole tiles). The sky's share rides in the albedo's
  alpha; the sunlight's texture adds half again to the far ground's
  memory (64 KB a 128² tile). A bake's measure runs as loops in the shader
  (built ahead with the bake's other programs). Needs a key light that casts a shadow for its sun part.
  `?terrainHorizon=off` on a game page bakes without it (a comparison).
  Measured (terrain-cdlod e2e, export, the frame's far band): 1.3–1.9 of
  255 darker on average with it, the near ground unchanged; the most a
  frame spent baking at load 23–44 ms (the first bake's program use, as
  before: 23–27 ms without the horizon). Nodes wholly past the
  distance whose tile is baked are drawn by a second mesh per page from it:
  three texture reads instead of the material's dozen (one more draw per
  page). Both draw the same vertices, so they meet without a crack; the
  look switches where a node crosses the distance (put it where fog or
  distance hides the difference). Measured (Iris Xe, 1080p, the landscape
  perf class's 144 tiles of 512 m, `macroDistance` 400): scene pass
  6.30–6.39 → 5.90 ms, GPU 15.5 → 14.8 ms, +1 draw. The macro textures take
  128² × 8 bytes a tile on the GPU (no mipmaps: the far ground can shimmer
  a little where texels shrink under a pixel).
- **Diagnostics**: the adapter's `terrain` block (tiles drawn, texture bytes,
  `cpuBytes` — the page's decoded tiles, one copy —, nodes selected and in
  view per level, draws, main-thread ms of the last selection and uploads and
  the most a frame spent and uploaded lately, the last tile's decode and pack
  ms on the worker, tiles that failed to read, and with far ground `macro`:
  tiles baked and waiting, bakes and their main-thread ms, far nodes and
  draws); the runtime's
  `terrainMemory` in Play (the simulation's tile data and bytes, colliders,
  tiles with colliders, the last build's tiles and ms, tiles still waiting);
  `?terrain=off` on a game page draws none (to measure what a terrain
  costs). Arrived tiles are uploaded a texture layer at a time within 2 ms
  and 4 MiB a frame (at least one), so a large tile goes up over a few
  frames.
- **Measured** (landscape perf class: 12 × 12 tiles of 257² at 2 m, the
  layered material, Iris Xe at 1080p): the terrain adds 0.9 ms of GPU time,
  one draw and 0.5 ms (WebGPU) to 0.9 ms (WebGL 2) of main-thread time per
  frame; a CDLOD selection over its 144 tiles takes about 0.05 ms when the
  camera moves. Packing a tile runs on a worker (a 1,025² tile: about 17 ms
  to decode and 85–98 ms to pack there); the page only copies and uploads
  it, at most about 3 ms a frame, and a 60 Hz page misses no frame while a
  sculpted 1,025² tile goes up. Collision: a 257² tile's heightfield is made
  and added in about 7–9 ms, a 1,025² tile's in about 12 ms (one holed in
  patches about 23 ms), in the simulation's worker; a step with them costs
  under 0.1 ms.
- **Measured** (this host, Node): a dab on a 513² tile at 1 m costs 0.1–0.2 ms
  at 8 m radius, about 0.9 ms at 32 m and 3.7 ms at 64 m (paint 0.5 / 5.5 /
  23 ms); a 32-dab stroke as the backend runs it (read the tile, plan, encode,
  gzip, digest) about 36 ms. A 513² tile of rolling hills stores in about
  210 KB (526 KB of raw heights), 262 KB painted with four layers. A 4,097²
  16-bit PNG imports into 64 tiles of 513² in about 1.9 s (a 4,096² RAW
  1.5 s), 13.4 MB stored.

## Terrain edit layers, stamps and erosion

A terrain's heights are a stack of **edit layers** combined offline over the
ground as sculpted by hand. The Terrain tools' **Layers…** list shows it top
first, the hand-made ground (**Base**: what Raise, Lower, Smooth, Flatten,
Noise and Ramp edit) at the bottom.

- **Layer kinds** (`terrain.layers: [{id, kind, name?, enabled?, strength?,
  …}]`, applied in order): **stamps** — heightmap brushes; **erosion** — what
  an erode run changed; **splines** — every spline that shapes the terrain
  (on top when the list names no splines layer).
  Each layer can be switched off (`enabled: false`: it changes nothing) and
  weighed (`strength` 0–1: the share of its change kept). ▲/▼ move a layer
  (what it applies over changes), ✕ deletes it. A terrain without `layers`
  is one base layer with the splines on top: nothing to convert.
- **Stamps** (`{kind: "stamps", stamps: [{asset, at: [x, z], size, rotation?,
  height, mode?, y?, falloff?}]}`): a texture asset's first channel (a 16- or
  8-bit greyscale PNG; a KTX2's original PNG) laid on the ground as a square
  `size` m a side round `at`, turned `rotation`° about +y; white stands for
  `height` m (negative digs), black for 0. `mode` **add** (default) raises
  the ground by the shape, **max** raises it up to the shape standing on `y`
  (world; default the terrain object's height), **min** cuts it down to it;
  `falloff` (0–0.5 of the side, default 0.15) fades it in from its edges. The
  **Stamp** tool: choose the heightmap, its height, turn, mode, edge fade and
  layer, then click the terrain — a stamp of side twice the brush radius,
  one command (into the chosen stamps layer, the first, or a new one).
- **Erosion** (`editTerrain {kind: "erode", rect: [x0, z0, x1, z1], layerId?,
  hydraulic?: {droplets?, erosion?, deposition?, capacity?, evaporation?,
  inertia?, lifetime?, radius?}, thermal?: {iterations?, talus?, amount?},
  seed?}`): hydraulic erosion (water droplets that take up ground running
  downhill and drop it where they slow: channels and fans; `droplets` per
  sample, default 0.5) and thermal erosion (ground slides off slopes steeper
  than `talus`°, default 35: screes, softened ridges; `iterations` passes,
  default 40) over the rectangle, read from the ground below the erosion
  layer (layer `erosion` unless named; made on top, under the splines, when
  missing). Its result is kept per tile as a difference (blobs the layer's
  `tiles` name, never shipped), faded in over the rectangle's 8-sample
  border: sculpting below keeps the channels on the new ground; running it
  again over the same place replaces that place's result (the same settings
  and seed give the same ground — it is deterministic). The **Erode** tool:
  choose hydraulic and/or thermal and their settings, click the terrain — the
  square of side twice the brush radius, one command. The backend erodes on
  a worker thread before the command, so other requests are not held up; a
  run is bounded at 2,049² samples (erode a larger area in parts).
- **Only the changed rectangle is combined again**: a stamp placed, moved or
  removed, a layer switched, weighed, moved or deleted, an erode — each is
  one command and one undo step whose terrain heights, material rules and
  scatter are made again only where the change reaches (a stamp's square,
  the eroded tiles, all a moved layer reaches); the Scene view uploads the
  changed tiles as for any edit. Tiles a layer reaches keep their hand-made
  form beside the drawn one (`tiles[].base`).
- **What ships**: only the combined heights (`data`). The layers, the
  hand-made tiles and the erosion blobs stay in the project; the export and
  Play leave them out. A texture asset a stamp reads, changed later, reaches
  the ground at the next combine there (switch its layer off and on).
- **Costs** (measured on this host, Node): combining a 1,025² tile through
  four 300 m stamps 21 ms, through an erosion layer 4.6 ms; eroding a whole
  1,025² tile 0.9 s hydraulic, 1.5 s thermal, 2.3 s both (on the backend's
  worker); per tile the stack keeps the hand-made tile (a 1,025² tile of
  hills: 0.8 MB stored, 2.1 MB read) and each erosion layer's difference
  (0.66 MB stored, 2.1 MB read) — editor-side only.

## Rule scatter and ground cover

Terrains and block layers place models by rules — trees, rocks, shrubs that
are stored, and ground cover (grass, pebbles, small flowers) made near the
camera while the game runs — with one rule list format on both, so a block
area and the terrain around it are dressed alike.

- **Scatter rules** (`terrain.scatter`, `blockLayer.scatter`; the terrain
  tools' **Scatter rules…**, the Blocks panel's **Scatter…**): each rule has
  an `id` (1-32 of A-Z a-z 0-9 _ -), a model `asset {assetId, piece?}`, a
  `density` (candidate places per m² where every condition holds fully), a
  `spacing` (m; no two copies of the rule closer), a random `scale [min,
  max]`, `yaw` (degrees of random turn, default 360), `align` (0 upright, 1
  along the ground's normal), `sink` (m into the ground), a `seed`, and the
  conditions material rules have — `height`, `slope`, `cavity`, `noise`, on
  block layers `blocks` and `meta` — plus `layers: [{layer, min?, max?,
  fade?}]` (the share 0-1 the ground shows of a material layer, hand paint
  included) and `exclude` (block-layer region names kept clear: a region
  over the whole block area keeps the terrain's trees off it). Each
  condition fades past its ends; a place is kept with the probability its
  conditions give, and where no kept place of the rule within the spacing
  ranks higher. Copies stand on the highest top of a block layer's column
  or on the terrain's surface. Two more fields: `collide` (**Collides**:
  each copy carries its model's `_COL` colliders in the game, see below) and
  `impostorSize` (**Impostor below**: far copies smaller on screen than this
  share of the view's height draw as an impostor, see below; empty: their
  meshes all the way).
- **Stored copies**: a terrain bakes each tile's copies into a blob of its own
  (`tiles[].scatter`), a block layer into each chunk (`scatter`, written
  with the chunk's file). **Apply** (MCP `editTerrain bake {scatter}`; on a
  block layer `setComponent` then `editBlocks {kind: "bakeScatter"}`, two
  undo steps) bakes every tile or chunk. Then an edit that moves the ground,
  paints or cuts it bakes again only around what it changed (the rules'
  reach: spacing and cavity), in the same command and undo step, giving
  exactly the copies a whole bake gives; the game only reads the stored
  copies. Measured (Node): a 512 m tile with three tree and rock rules bakes
  in 7 ms (188 copies; 30 ms at 16 times the density), a 16 m raise's
  rectangle in 0.6-5 ms; the landscape perf class's 144 tiles in 0.9 s
  (one command).
- **The Scatter brush** (the terrain tools' **Scatter**, the Blocks tools'
  **Scatter**, MCP `editTerrain {kind: "scatter", rule, dabs, radius,
  erase?}` and `editBlocks {kind: "scatter", rule, at, radius, erase?}`):
  the rule's candidate places under the brush get a copy whatever the
  conditions, or (Ctrl / erase) none. These hand edits are kept apart from
  the rules and survive every bake (a sculpt under a hand-placed tree moves
  it with the ground). Copies placed one by one stay instance sets of their
  own.
- **Addresses**: every stored copy has an address — its rule and candidate
  cell — that stays the same through every bake that keeps it.
  `queryTerrain {entityId, scatter: {box?: [x0, z0, x1, z1]}}` lists each
  rule's copies and hand edits, and with a box the copies in it with their
  addresses; a block layer's are in its chunks (`queryBlocks`).
- **Ground cover** (a rule with `cover: true`, `coverDistance` m, default
  40): never stored. Squares of 32 m round the camera within its reach are
  made on a worker (the view worker, from the same rules and ground) and
  drawn one instance set per rule and square, thinning out to nothing over
  the last 40 % of the reach; squares the camera leaves are dropped, and an
  edit of the ground makes the squares over it again. No colliders, no hand
  edits. Measured: a 32 m square of grass at 2 per m² (712 copies) takes
  about 4 ms on the worker and 0.7-1.1 ms of the page.
- **Drawing**: per rule, the copies of 2,048 m squares of tiles or chunks
  are one instance set, 2,048 m chunks by default (`chunkSize`), each copy
  at its own level of detail (`lodPerCopy`, default on for scatter) and
  culled one by one inside its draw — a few draws per rule for a whole
  landscape. A re-bake makes only its square's sets again: their arithmetic
  (every copy's matrix, the bounds, the level inputs) on a worker, the draws
  on the page within 4 ms a frame, the old set drawn until the new one is
  in, so a re-bake never stalls a frame (a 2,048 m square of 16,000 copies:
  about 9 ms on the worker, 3.5 ms on the page). Density falloff and levels
  of detail work as for instance sets. Play and an export ship the tiles'
  scatter blobs with the tiles.
- **Far copies as impostors** (`impostorSize`, a screen size as the
  density falloff's: 0.03 is a good start for trees): a copy smaller on
  screen than that draws one camera-facing quad showing the model from the
  side it is seen from instead of its meshes — two triangles. The page bakes
  each model once, when a rule first asks for it: its most detailed meshes,
  in the project's materials, drawn from 64 directions over the upper half
  into a 1024² atlas of colour and normal (both renderers; about 10-25 ms
  once, 11 MB of GPU memory per model). The quad blends the three nearest
  directions and is lit by the atlas's normals (the meshes' surface normals:
  normal maps are below a far copy's pixels). It casts no shadow. Measured
  with the landscape perf class (`--impostors 0.03`): 542k → 452k triangles
  a frame, GPU 15.2 → 14.6 ms, no more draws; a merged mesh per tile (HLOD)
  would keep at least the coarsest level's triangles and add draws.
- `?scatter=off` on a game page draws no scatter (to measure what it
  costs); the adapter's diagnostics carry `scatter` (sources, cells,
  groups, sets, copies, bytes, sets being prepared, worker and page ms,
  hidden and removed copies, `impostors`: baked, bytes, the longest bake)
  and `cover` (squares, sets, copies, mean worker ms); the simulation's
  carry `scatterCopies` (copies held, colliders, hidden, removed, the last
  build's time).

### Scatter copies in the game (`ctx.scatter`)

Every stored copy has an address, `<object>#scatter:<rule>:<ix>,<iz>` (its
terrain or block layer, its rule and candidate cell), the same through
every bake that keeps it. A script finds and changes copies by it; what that
means (felling a tree, picking a flower, a fence that breaks) is the game's.

- `ctx.scatter.near(position, radius, {rule?, source?, hidden?, limit?})`:
  the copies within `radius` m across the ground, nearest first (default
  64, at most 1,024 a call), each `{address, source, rule, cell, position,
  rotation, scale, hidden}`; `get(address)` one copy.
- `hide(address)` / `show(address)`: not drawn and no collider until shown
  again (the renderer shrinks the copy to nothing in place: cheap, any
  number); `remove(address)`: gone for the run (its square's sets are made
  again on the worker). A new run brings every copy back. `changed()` lists
  the copies hidden or removed this run — a game that keeps felled trees
  keeps that list in its own save and puts it back with `hide`/`remove`.
- **Colliders**: the copies of a rule with `collide` each carry their
  model's `_COL` parts (the same as an object's `{type: "model"}` collider;
  a model without `_COL` gives none), one static collider per copy at its
  place, turn and size, added and removed in batches with the terrain's and
  block layers' colliders. Its id is the copy's address: a ray that hits one
  reports its object and `scatter: address` (`ctx.physics.raycast3d`,
  `pickAt`), so a script can name the tree the player aims at. Without
  streaming rings every tile and chunk has them; with them, those in the
  collision ring.
- The page reads and decodes a terrain's scatter blobs and hands them to the
  simulation (which never touches the network); a block layer's copies come
  with its chunks.

### Foliage best practice (the foliage policy)

Scattered foliage is most of a landscape's copies, and the shadow map is
where it costs most: every caster is drawn once more per shadow pass, and a
swaying one cannot live in the cached static map. The engine's scatter
defaults follow this policy, and games should too:

- **No map shadows by default.** Scatter copies cast nothing unless a rule
  says `castShadow`. Grass and small plants never should.
- **Shadows only near the camera.** A rule that casts sets `shadowDistance`
  (the editor writes 40 m when **Casts shadow** is ticked): only copies
  within it cast, from shadow-only squares round the camera into the moving
  shadow map. Without it every copy casts into the cached static map (fine
  for few, large, still things: a dozen boulders).
- **Contact or blob shadows instead.** `blobShadow` (m, at the copy's scale)
  puts a soft dark disc on the ground under each copy within 60 m — what the
  eye reads as "standing on the ground" far more than a shadow-map edge — at
  one extra instanced draw per rule and no shadow pass.
- **Wind only near.** A foliage material's `windDistance` (m; 40 m is the
  policy's near ring) moves vertices only that close to the camera; past it
  they skip the wind's work and stand still (it fades out over the last
  fifth). Absent or 0: everywhere.
- **Thin out with distance.** Set a density falloff (`densityMin` 0.25 is a
  good start): far copies are fewer, and ground cover thins to nothing at
  its reach on its own.

Measured with the landscape perf class (Iris Xe, 1080p, about 37,000 stored
copies and ground cover; `level --classes landscape` against `--foliage
off`): 542k against 641k triangles a frame, the moving shadow pass 0.26
against 0.38 ms a frame and a redraw of the cached static map 0.81 against
1.69 ms; all scatter and cover together cost 2.7 ms of GPU time and about 50
draws (WebGPU). With the camera flying a 60 s loop over the class 6 m above
the ground (`level --classes landscape --flight`, at the display's 60 Hz,
scripts hiding and removing copies on the way): no refresh missed on either
renderer, the page's main thread 5.6-5.9 ms a frame.

## Splines (roads, paths, rivers)

A **spline** is one generic curve component: points, each with an optional
tangent, width and roll. Roads, paths and rivers are splines that shape the
terrain and make a mesh along themselves; scripts read any spline as a path
(`ctx.splines`).

- **The component** (`spline`; GameObject → Level → **Spline**, **Road**,
  **River**; MCP `setComponent "spline"`): `points: [{at: [x, y, z], tangent?,
  width?, roll?}]` (2 or more; metres from the object's position — only the
  position places a spline, as it places a terrain), `closed?`, `width?`
  (where a point names none; default 4 m). Each segment is a cubic Hermite
  curve through its points; a point without a tangent takes the smooth
  (Catmull-Rom) one. Width and roll go linearly from point to point; roll
  turns the cross-section about the curve, right side up (a banked road).
  Absent parts mean "not used": a spline with only points changes nothing.
- **Scene-view handles** (select the object): each point has a grip on the
  curve (drag across the ground), one above it (drag up and down: its
  height), one at its right edge (its width) and one where its tangent pulls
  (Alt+click takes the tangent off: smooth again); the small grips between
  points add a point on the curve; Alt+click on a point deletes it. Each drag
  is one command and one undo step (the terrain and the mesh follow in the
  same step). Snapping follows the translate grid.
- **Shaping terrain** (`terrain: {shape?: flatten|carve|raise|none, falloff?
  (m, default 4), depth?, offset?, paint?: {layer, strength?, width?,
  falloff?}, order?}`): within the half width the ground goes to the curve's
  height (less `offset`; `depth` cuts a channel deepest at the middle; the
  roll tilts it), fading out over `falloff` past it; `carve` only lowers,
  `raise` only raises, `none` only paints. `paint` mixes a material layer in
  along it — over the material rules, under hand paint. Splines apply in
  `order`, then object id. A block layer is never changed: where its cells
  are, the spline stops. The terrain keeps each tile it shapes as sculpted
  by hand beside the drawn one (`tiles[].base`, never shipped): sculpting
  and painting under a road edit the hand-made ground and the road holds;
  moving or removing the road gives the ground back.
- **Scatter kept clear** (`scatter: {margin? (m past the half width, default
  1), rules?}`): no rule places a stored copy within the band, and terrain
  ground cover keeps off it too (hand-placed copies stay). Block-layer
  scatter is the layer's own and is not changed by splines.
- **One command, only the band re-baked.** The command that adds, moves,
  changes or removes a spline also shapes every terrain it crosses (heights,
  the rules and the spline's paint, the scatter), in boxes along the curve
  about 64 m long — before and after, and only round the segments a moved
  point changed — and makes its mesh: one revision, one undo step (the
  change's `follows` name the terrains and the spline written). Measured
  (Node, a 1 km road over a 2 km terrain of 512 m tiles with four material
  rules and three scatter rules): added 128 ms planning + 157 ms encoding
  (5 tiles), a point moved 5 m 51 + 31 ms, removed 31 + 80 ms; in the
  landscape perf class the whole command round trip is about 250 ms.
- **A mesh along it** (`mesh: {kind?: surface|water, profile?, offset?,
  tiling?, step?, collision?, castShadow?, receiveShadow?, flow?, foam?}`):
  `surface` sweeps the `profile` (`[[across, up], …]`, across in half widths
  −1…1, up in metres; default a flat strip) along the curve every `step` m
  (default 1), `offset` m above the points (default 0.05: on the flattened
  ground); `water` is a flat surface with points across that carries its
  flow (UV1: `flow` m/s along the curve as texture units a second) and its
  foam (COLOR_0 red: 1 at the banks, fading over `foam` m in). The backend
  makes it, cut into pieces about 64 m long, each with coarser levels made by
  the mesh simplifier (the pieces' ends kept, so they meet at every level),
  stored as one blob the spline's `data` names and shipped with the game. A
  surface collides (`collision`, default on; water off). It wears the
  object's material for slot `spline` (Materials `{"spline": id}`); without
  one a plain grey surface or a see-through blue water.
- **Pieces along it** (`pieces: [{asset, spacing, start?, offset?: [across,
  up], yaw?, upright?, collide?, castShadow?}]`): a model every `spacing` m
  (fence sections, posts, wall segments), its +X along the curve, upright
  unless told; drawn as an instance set, each copy carrying its model's
  `_COL` colliders (`collide`, default on).
- **Rivers**: the **River (spline water)** material template reads the
  flow, the foam and the new **Scene depth** graph node (Inputs; pixels of a
  transparent surface: metres from the camera to the scene behind and how
  far behind the surface it lies): ripples move along the flow in two
  phases half a cycle apart (no stretching), foam gathers at the banks and
  in the shallows, and the water fades out where the ground comes up to it
  (soft shores). The Scene depth node works on WebGPU and WebGL 2, with or
  without MSAA (a logarithmic depth buffer is not supported by it).
- **Scripts** (`ctx.splines`): `length(id)`, `at(id, distance)` (position,
  tangent, right, up, width, roll), `nearest(id, position, {level?})`
  (distance along, position, offset) — the loaded splines as placed.
- `?splines=off` on a game page draws nothing splines make (to measure what
  it costs); the adapter's diagnostics carry `splines` (mesh pieces,
  triangles, copies, blobs read), the simulation's `splines` (colliders,
  splines whose data has not arrived, the last build).
