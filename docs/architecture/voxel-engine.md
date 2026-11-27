# The voxel engine as it stands

What is true now, in one place. Plans say what is being built and why; this page says what exists and what every
new system sits on. Owner decisions are in `docs/decisions/owner-decisions.md`; formats in
`voxel-format-spec.md`, `voxel-render-spec.md`, `voxel-role-spec.md`, `voxel-kit-format.md` and
`format-versions.md`; the order of work in `docs/roadmap.md`. When a phase changes something here, it edits this
page in the same commit.

## 1. Principles

- **Voxels are the single source of truth.** Terrain, buildings, water, fog, materials and physics are voxels;
  vegetation rules derive from the voxel and its material id. A system that needs world data derives it from
  voxels; it does not keep a second authored copy.
- **WebGPU is the renderer.** WebGL 2 is no longer checked or kept working (owner, 2026-11-25).
- **Targets.** The floor GPU (Intel Iris Xe) runs the low tier at 720p with a temporal upscale (render scale
  about 0.667), capped at 30 Hz, in about 4 GB (page 1,536 MiB + GPU 2,560 MiB) of an 8 GB machine. Medium and
  high are unverified on target hardware. Travel up to 150 m/s is judged by hitches and by the settle after a
  stop; nothing falls through.
- **Generic capability only.** A game's behaviour lives in the game's repo.
- **Name the foundation first.** A new system says which shared foundation of §6 it sits on before it is built.

## 2. Data

- **Cell** 0.5 m; **chunk** 32³ cells (16 m), derived in 16³ sections; region files in 256 m tiles.
- **Record** (32 bits): material 12 bits, role 4 bits (11 of 16 assigned: air, terrain, liquid, wall, floor,
  roof, foundation, stair, pillar, opening, gas), shape 4 bits (the fill for terrain, the fill level for liquid, the
  integrity for construction roles, the density for gas: 15 its material's full density), wetness 3 bits (0 for a
  gas: a gas with wetness is refused), 9 reserved bits (two are held, unspent, for a vegetation density value).
  A material's voxel use is construction, terrain, liquid or gas; a gas material carries its plain look's two
  fields, a colour and a full density per metre (`voxel.gas`); a construction or terrain material may name a
  **dressing** (`voxel.dressing`), the asset that says what grows on its surfaces (§6 row 6).
- **What a role does is one row of the role traits table** (`@thirdlight/voxel` `role-traits.ts`, a row for each of
  the 16 values of the role bits; the five unassigned read as plain open space): drawn as a body, stops light, blocks
  walkers, collides, the medium it holds (liquid, gas), what its shape bits mean (none, fill, level,
  integrity, density), a portal's gap, whether the placeholder rules read beams and rails from it, and how it holds a
  cell of a coarser level (by its cells, by any fill, by its share, as a gap, never) with its rank (bodies first; where
  no body holds, a liquid, then an opening, then a gas: `MIP_OPEN_ROLES`). Every consumer asks
  the table through its predicates (`isBodyRole`, `isMediumRole`, `isLiquidRole`, `isPortalRole`, `isFillRole`,
  `isConstructionRole`, `roleStopsLight`, the per-role lookups a hot loop indexes, the mips' `MIP_ROLE_PRIORITY` and
  `MIP_MEDIUM_ROLES` made from the rows) and none compares a role id; `npm run build` refuses a comparison outside the
  table and the files that own a role's own behaviour (`tools/check-role-traits.mjs`: the record's constants, the roof's
  words and its relay in the mips, the kit cases' vocabulary, catalogue and piece order, the building generator, the
  water fill and bodies; each entry names its roles and why, and one nothing needs fails). A role added later is a row:
  **gas** (47b.2) was one, and besides the row it met six places that named the liquid alone or assumed two media
  (plan-47b §9 "47b.2": the change feed, the coarser levels' order against openings, the level fill, the wetness a
  cell may hold, a flag sharing the new part's bit, the material uses).
  Two limits a new row meets: a level-0 cell's mesh, collision, navigation and light coverage are all read from the one
  class a body derives to, so the table refuses a row whose light stop, walkers or collision differ from `body` until
  the derive carries them apart (47p's `prop` needs that); and nothing on the GPU reads a role today (the walk reads the
  occupancy the CPU derives), so the 16-entry lookup made from the same rows (`roleTraitBits`, `roleTraitsWgsl`) has no
  shader reading it yet.
- **Derived data is never stored**: meshes, collision, navigation, light coverage, occupancy, detail pieces, the
  liquid and gas parts (§3), ground cover's points (§3 *Ground cover*) and open regions (region labels, chunk face connectivity, sky columns) are rebuilt in workers from voxels; the surface
  fields (§6 row 1) are computed from voxels when asked and kept nowhere. The one stored derivative is the **far cache** (levels 2 and up of the mips,
  and baked bricks down to the world's bake level).
- **The walk graph** (`@thirdlight/voxel` `walk-graph-cells.ts`, `walk-graph.ts`, `walk-graph-queries.ts`), derived
  where the world runs (the simulation's thread in Play and exports, the voxel world page's own), never stored: each
  storage chunk's standable cells (the derived navigation's: free, on a cell that supports) with their clearance
  counted to 8 m and, for walkers 2 to 4 cells across, their **footprint clearance** (a byte a span: the least, over
  the square of columns the walker stands on, of the free run from a step over its floor; read from column bits over
  a band of the neighbouring chunks, a chunk not known counting as free; a chunk whose face columns' blocking changed
  has the chunks beside and below-beside it made again), its **pieces** (cells joined by steps inside the chunk for the
  default walker: 2 m tall, two cells across, the default character's 0.3 m radius; a shut door's cells are pieces of
  their own, flagged) and between pieces of neighbouring chunks the **exits** (runs of crossing steps, an exit at a
  run's middle and, past six cells, its ends; with the steps into and out of a chunk's shut-door pieces as exits
  flagged `shut`), made in the derive slice after the open regions as chunks arrive, change and leave; a chunk made
  again with the same cells stands. A step goes to the eight columns round on the same level or one cell up or down,
  with room for the walker at both ends (its footprint's; a cell more at a step's lower end), diagonals only past two
  walkable sides and inside a chunk, drops off ledges only when a query allows them. **The walker** is `radius`
  (default `DEFAULT_CONTROLLER_CAPSULE.radius`, at most 1 m) as a square of ceil(2r / 0.5 m) cells (a disc fits it
  wherever its middle is between two cells it steps between: answers are conservative), so a 1 m door passes a 0.5 m
  radius and a 1.5 m door 0.75 m; its waypoints are where its middle stands (a cell's corner for an even span). Props
  are not in it; shut portals are (`doors`). `ctx.voxels.findPath` and `reach` queue queries served in order within the
  simulation frame's `pathfinding` share (span `path finding`): for the default walker (through shut doors or not) one
  A* over the cells first, a long path over the pieces' exits (straight-line costs across a piece, exits into shut
  doors only through shut doors) and then the cells of the route's pieces and their neighbours; any other walker one A*
  over the cells. **A query reads the world as it is:** a chunk an edit was sent for and not swapped in, or whose results
  are not made in the graph yet, is stale; a search that reads one waits (served again once it is made, then starts
  over), at most `WALK_QUERY_WAIT_SERVES` serves, after which it answers on what is made with `stale: true`; chunks not
  loaded are never waited for (past them the answer is `unknown`, never `unreachable`). With structure grids, each grid
  keeps a walk graph of its own in its own frame (exact floors, stairs and doors), the world's walker is blocked by the
  grids' stamps and stands nowhere inside a footprint, and **links** join a grid's standable cell to the nearest world
  one a step away for each footprint span (both ends fit it, the way between read in the grid's own cells and the
  world's; a wider walker's reach a little longer: doorsteps, foundation edges), made again with either side's chunk
  (`walk-graph-links.ts`); a path between graphs takes the cheapest of the best three doors' legs, each graph's own
  query, after waiting for the grids it reads and their links to be made (`walk-graph-linked.ts`, runtime
  `voxel-world-paths.ts`); a reach runs from its start's graph through the links into the grids and back
  (`walk-graph-linked-reach.ts`, at most four passes). Both caps are fixed constants, so a building of separate rooms
  with more doors can answer `unreachable` wrongly (D795).
- **Doors, windows and shutters: portal state** (F4, 47a.7): a prop with a `voxelPortal` (open; what it stops while
  shut: light, sight, walkers; `sight` is stored and reported and read by nothing yet, D792) stands in a structure's opening as the structure's child; the opening's record names it
  in the editor (`openings[].prop`, kept by the backend's follow-ups: `workspace/structure-prop-follows.ts`). Where
  the world runs it is joined to its opening by its place (its middle in a grid's `opening` cell, the face-joined
  opening cells joined to it, however far they run: the flood is bounded by the opening's own cells and the grid's
  resident chunks, waiting while the run goes on into one not resident; `runtime/voxel-portals.ts`), so an export needs no definition. Shut, the opening's cells
  are one more stamp in the prop channel (every world cell they reach stops light whole, at level 0 and at the walk's mip
  levels, `LitStamp.mipStop`; no structure class, so rooms keep the portal) and shut cells of the grid's walk graph (`WalkGraph.setShut`; `findPath` option `doors`; a shut
  cell keeps its link to the world, taken only by a walker through shut doors); a flip recombines only those cells.
  The sun's direct light follows too: a grid's shut openings that stop light (their cells) travel with the grid's
  draw batches (`ChunkDrawBatch.shut`, the whole set when it changes) and the page casts the key light's shadow over
  exactly those cells, a shadow-only static caster under the grid's view (`three-adapter/voxel-portal-casters.ts`;
  never in the colour pass, the cached map drawn again where it stands), so a prop with no model or one thinner than
  the map's texel and bias lets no sun in. The editor's Scene view runs no portal state and casts none.
  Two props whose middles lie in one run of opening cells (two openings side by side) each take the cells on their side
  of the cell boundary nearest the midpoint between them.
  The leaf itself is never stamped. Open or shut is state, never voxels; `portalsOf` names the prop and its state; a
  script writes `open`, a save keeps it. In the editor the structure mode's Openings column places, moves and deletes
  openings on walls and puts a prop from the project's models that fit (`queryAssets` answers a model's bounds).
- **Light coverage with props**: objects whose model is marked `affectsLighting` are stamped into the world's prop
  coverage channel (`prop-channel.ts`, a byte a cell over the resident chunks, never saved): each prop sampled once
  into its own cells where it stands (its collider, else its model's bounds; 4³ samples a cell), a chunk its props
  combined as 1 − (1 − a)(1 − b), a move recombining only the cells it left and entered, the stamps spread over
  steps in the derive slice on the simulation's thread. The walk's light stop reads one occupancy: a level-0 cell
  stops light where the voxels' coverage joined with the props' is at least half (`coverageAt`'s rule), and a light ray
  keeps 1 − the coverage of each cell it passes that a body covers in part (props' and stamps' cells under half, construction
  damaged under half its integrity; in fifteenths, the walk's `trans`; the ground's cells over its surface pass whole: their
  fill places the surface), so the light volume's rays (sky, sun, lamps, glow, bounce) and `ctx.voxels.raycast`'s light stop
  see lit props, moving ones too (a changed chunk's walk block
  is sent again and the volume restarts what it reaches, as for an edit). Structure grids are stamped into the same
  channel (above); the mips see their stopping cells, never props'; the far nodes are the voxels' alone; kit pieces
  stamp nothing (the voxels they dress do).
- **Edits** go through `editVoxels` strokes (command v3: set, dig, brush, fill, stamp, and `flood`, a medium filled
  to a level from a seed with the water bodies' level fill, refused with the places it leaks; a brush places, adds,
  digs, paints, with or without keeping each cell's role, and smooths or flattens the ground's surface a column at
  a time, or relaxes a gas's density; `edit-surface.ts`: computed whole from the voxels before the stroke, so every
  chunk a stroke can read is loaded first). The project's one `undo` /
  `redo` steps scene edits and strokes on one line in the order they were made (workspace `undo-timeline.ts`,
  in the backend, per project); a stroke's undo and redo write back the records its world's undo store keeps
  (redo exact, the same byte budget); a stroke whose world dropped it is skipped and named.
- **Structure grids**: a world may hold structure grids beside the world grid (manifest format 3: `grids`, each
  grid's region files in `grid-<id>/`, ids 1 to `VOXEL_GRID_ID_MAX` = 2³² − 1, the region header's u32), each the same 0.5 m cells in a frame of its own, placed by a position and a
  yaw that are not stored with the voxels: its structure object's transform (a `voxelStructure` object, a turn about
  the vertical axis only). Play reads the places from the world's route (`grids[].place`, the objects' as stored when
  the world opens), an export from its catalog's world row (`grids`: each grid's files and place); a bench's
  `?voxelGrids=` still places a world's grids over them. A structure's voxels are its generator's (a pure function of
  its definition, whose numbers are the grid's own cells) plus its hand edits as overrides (`structures/`,
  foundation 5), written by the backend through the commands (workspace `structure-commands.ts`: a structure made,
  changed, copied or deleted writes its grid's region files, `grid-<id>/overrides.tlvo` and the manifest in one
  staged write, one undo step with the scene edit; a write that refuses takes the scene edit back by an undo, and the
  editors' feeds hear of both steps; once a project holds a structure, body or voxel spline every project command
  reads its scenes before and after on this path, about 8 ms a command with 131 houses, D797; a hand edit is
  `editVoxels` with `command.grid`; misfits are
  answered and held in memory; exports never ship a definition or overrides). A road, path or river along a spline (its `voxels` section) is written into the world grid itself over the ground, and keeps what it replaced, `structures/<object id>.tlvo` beside the region files, so moving it gives the ground back (47a.11, foundation 5); exports ship its voxels only. In Play each is streamed by its own streamer in
  the world's pool under its job ids (one tracker: keys are (grid, chunk)), reading only round the chunks its files
  hold, the foci moved into its frame, its level choice, collision scan and section readiness cut to those chunks. A
  step runs a grid's streamer only when it has something to do: it could ask for work (`idle(true)`: jobs out end with
  a poke), something landed in it (`counters.activity`), or the focus moved past what its last plan holds (the least
  gap from its chunks and the nodes over them to a ring they are compared with, `stream-quiet.ts`
  `VoxelStreamer.quietReach`; at least the old share of the gap to the grid, 1/8); at speed every grid in reach is
  stepped every step; a grid out of reach that holds nothing is never stepped, and a grid is given only the bodies
  whose collision reaches it (runtime `voxel-grid-host.ts`; the Scene view tells its grids' streamers of the focus by
  its own copy of the 1/8 share, without the clamps, D796). The world grid and its grids share the world's one
  memory budget (grids first). Drawn under its place with its world's surface, its kit pieces in its world's piece
  batches turned and placed copy by copy (`voxel-world-draws.ts`, `VoxelPieceBatches`), so grids add chunk surfaces to
  a frame, not draws a kind; collided as one compound static body a grid. **Light, sun heights and rooms see a grid
  through its stamp** (`structure-stamp.ts`): its resident cells (a class a cell from its record: stopping, opening,
  open) sampled into the world cells where it stands at 4³ points a cell by the share rule (as props: it stops at
  half; `?gridStamp=` names another rule or `off` for a bench), held in the world's prop channel (coverage bytes joined
  into the light stop; a class a cell read by the open regions as solid and portal cells, hence rooms, portals and
  the sky heights, and by the walk's mip levels as stopping cells), made again when a chunk of the grid arrives or
  leaves, sampled a row of world cells at a time in the derive slice (`GridStampSampler`; the cells are read in one
  piece); nothing is stored, and with no grid nothing is made. It is off by up to a cell:
  a turned door or window is moved by up to a cell at each edge (12–18 % of rays through a 1 m one stop at 30°–45°,
  and as many pass beside it: a room turned 30° takes about 1.2× the sky exact stepping gives it, 45° about the same),
  closed turned walls let nothing through (no ray of 19 million from inside sealed houses at 0°–45°), rooms are found
  whole. Exact stepping of each grid in its own frame exists on the CPU only
  (`grid-walk.ts` `walkWithGrids`: the reference). Paths walk each grid in its own graph, linked to the world's (the walk
  graph above). The far build reads a world's placed grids resampled into its cells (`grid-resample.ts`, workspace
  `FarWorldSource(dir, grids)`: the majority of 2 × 2 points a cell; the backend passes its objects' places to every
  far build and rebuild, the fine bake too, and a structure made, moved, turned or deleted builds again the world
  chunks it left and entered; the far build's columns and rows include the grids' boxes), so past its own rings a grid
  is drawn as far bricks a cell off. **A command's far rebuild follows its answer** (workspace `voxel-far-follow.ts`:
  an edit's or a structure step's world chunks gathered per world and built in one rebuild once no change came for
  250 ms, `FAR_FOLLOW_SETTLE_MS` in `@thirdlight/voxel`, in the world's queue; the far route and an export build what
  is gathered first; a structure move's rebuild lost with the process is not caught, D759). An open page follows it
  the same way (editor `range-world.ts`: once its far field read the cache, it asks the far route that long after its
  last change and re-reads the far nodes over the changed chunks then; nothing near is derived for it, D761).
  **`ctx.voxels` sees structures by one rule: a point lies in a structure where the structure's own cell holding it is
  not air, else in the world's own cells** (the lower grid id where structures overlap; runtime `voxel-grid-access.ts`).
  Reads answer from that grid; `raycast` walks the world and each grid along the ray in its own frame (`walkWithGrids`,
  the grids filed by 16 m tiles in `GridWalkIndex`) and names the grid met (`grid`, `cell`; the normal turned into the
  world); `dig` and `paint` act on every grid's cells whose centres lie in the region, `set` on a structure's solid
  cells and the world's elsewhere (world grid first, then grids by id, one change); a grid's change writes its overlay,
  derives its chunks again and reads its stamp again, its links and body following its swap; saves hold every grid's
  changes (entries by grid, each against its shipped chunk's hash), a removed structure's pieces reported and left out;
  `regionAt` names the structure whose box holds the point (its grid id: the object id is not known in an export,
  D756). **The editor's Scene view** draws every structure object's grid where the object stands (its worker streams
  each grid in its own frame; a move or a gizmo drag moves the draws at once, nothing derived; a change reads only the
  grid's changed chunks, `voxelsChanged.grids`), and a click on a grid's cells selects its object (the worker's walk
  through the worlds and their grids). Measured: plan-47a §8a "47a.5a".
- **Known limits to design around:** mips keep a non-solid cell only where no solid shares its parent, so water and
  fog are in the 2 m level only where their cells fall in a 2 m cell the ground does not hold (measured in 47b.4: a
  lake over its bed kept, the town's ponds sunk three cells into the ground all lost, mist two cells thick on a slope
  kept thinned in 41 of 64 columns; far water and fog need a far-cache channel); a gas is kept
  there only where the cells without it give air, by the mean of its density, so nothing a coarser level draws,
  closes or stands on changes with it; a brick cannot
  hold rule-built crisp geometry exactly. A medium (`liquid`, `gas`) is open space by its row of the role traits table
  (above), which every consumer asks; the far ground alone reads every non-medium cell that holds a material as
  ground, an opening's too (as before the table). Since
  47a.9 (F7) every derived output but the liquid part reads a liquid cell as the air it stands in (proved on the
  test worlds' lakes and pools), so a change only between air and liquid, or of a liquid's fill or material, feeds
  the **liquid part** alone (`changeFeeds`, `EditOutcome.parts`): no mesh, collision, navigation, light, shader
  data, coarser level or fine far brick is derived again. Water blocks no light, collides with nothing (bodies
  fall through it to the bed) and walkers walk its bed; the coarser levels keep the liquid values a liquid-only
  edit left behind (nothing reads them before 49, D782); the backend's far cache still rebuilds such an edit's
  chunks (D783). **Gas** (47b.2) is the same with nothing drawn yet: every output reads a gas cell as air (proved on
  the town and the hard-case row with gas in their open cells: meshes, collision, navigation and the walk graph,
  light stop, occupancy, open regions and sky columns, shader data, liquid faces, the mesh rings' nodes, far faces
  and far ground, byte for byte), so a change only between air and gas, or of a gas cell's density or material,
  feeds the **gas part** alone (`DERIVED_PART.gas`; built since 47b.7, §3 *Gas*): such an edit derives the gas
  part of the sections within its one-cell reach and nothing else, and the page replaces the chunks' gas meshes
  alone. The gas part reads a liquid cell as air (as the liquid part reads a gas cell), so neither medium's change
  feeds the other's part. Water written over gas takes its cells (the level fill passes gas as air); the coarser
  levels and the backend's far cache treat a gas-only edit as they treat a liquid-only one (D782, D783). Fog is
  drawn inside the detail ring only and is one flat unlit colour (§3 *Gas*).

## 3. Drawing, near to far

| Band | Drawn as | Built |
|---|---|---|
| The detail ring: level 0 to 64 m at medium, about 45 m at low; collision to 48 m (34 m at low) | the terrain mesher's surface and merged construction faces, kit detail pieces instanced across chunks, the voxel surface shader (triplanar texture sets, material blend, wetness) | workers, from resident voxels |
| Past it on a world baked to 2 m | level 1 meshes to 128 m and level 2 meshes to 192 m (the mesh rings), then bricks | workers, from voxels downsampled at run time |
| Past it on a world baked to 0.5 m or 1 m | baked fine bricks, textured as the near surface; the read ring ends at the detail reach | decoded from the far cache, nothing built |
| Finer than the bake, where a world asks for it (`fineBuild: compute`) | fine bricks built on the GPU | compute, from the chunks' voxel grids |
| To the horizon | bricks at 2 m and coarser, chosen by screen error (8 px low, 4 medium, 3 high) | the far cache |

- **Seams between levels** (`lod-seam.ts`): where a level-0 chunk meets a level-1 node (and level 1 meets level 2) a
  seam joins the two levels' boundary edges; a coarse boundary vertex goes to the nearest fine edge, except that one
  whose nearest fine edge faces the other way (a thin slab's far side, cosine under −½) goes to the nearest fine edge
  facing its way (cosine over ½) when that lies at most a coarse cell farther, so a roof slab a fine cell thick that
  the two levels place a cell apart is closed side to side, never by a flap through it (plan-47l §8a 47L.2).

- **Liquid** (47a.9, the plain look; 49 replaces it): inside the detail ring each chunk's liquid part (its
  derive sections' liquid faces against open space, exact to the fill level, merged into quads with their
  material; `derived-liquid.ts`) is one more mesh of the chunk's draw (`voxel-liquid-draw.ts`): the material's
  colour (table colour times its texture set's mean, as the far field reads it), opaque, lit as any voxel surface
  (sun and its maps, lamps, the light volume's read), receiving shadows and casting none; replaced alone when only
  the liquid part changes (a chunk batch's `liquid` entry); its program made with the first liquid face, so a world
  without liquid compiles nothing. Past the ring a lake's bed shows dry (the far cache has no liquid channel until
  49; owner's default of 2026-11-20). Structure grids draw their liquid the same way (the same derive and chunk view; not looked at in a picture).
- **Gas** (47b.7, the plain look of fog; 51 replaces it): inside the detail ring each chunk's gas part (its derive
  sections' gas faces against open space, whole cell faces merged into quads with their material and two densities,
  the face's own cell's and the cell's behind it; and the sections' gas as runs up their columns; `derived-gas.ts`,
  the quads' bytes and merge shared with the liquid part in `derived-medium.ts`) is one more mesh of the chunk's
  draw (`voxel-gas-draw.ts`): the gas material's colour and full density per metre (`voxel.gas`, a fifth block of
  the surface's material table, `VoxelSurface.gasLook`; a record's change reaches it with no mesh change), blended,
  depth tested, no depth written, front faces only, **unlit** (no sun, lamp, light volume or shadow: a flat colour
  by day and by night; it takes the scene's distance fog at its own depth), casting nothing; replaced alone when
  only the gas part changes (a chunk batch's `gas` entry); its programs and the depth copy they read made with the
  first gas part, so a world without gas compiles nothing. **See-through by density**: a hull has no inside, so a
  pixel's opacity is 1 − exp(−density × metres of gas behind it), the metres from the face to the scene behind it
  along the view ray (three's copy of the scene's depth as drawn before transparent draws; at most
  `GAS_DEPTH_CAP_M` 64), the first cell at the face's own density and the rest at the density behind: fog thins to
  nothing where it meets the ground, a fill's soft top reads thin, a bank in a hollow as deep as the hollow.
  **From inside** (the eye in a gas cell, found in the chunk's runs each render; the hull is then behind the eye
  and most rays end on ground without crossing a face) one screen-wide layer draws the fog between the eye and the
  scene: the eye's column run taken as a level slab without end sideways, at the run's mean density, a ray leaving
  through its top or bottom; it comes in over the first metre under the run's top, and hull faces between the
  slab's heights are left out while it draws. **What it cannot do**: know where a bank ends in the air (fog
  standing free reads as thick as the scene behind it is far, and shows its cells: D841); light, shade or move;
  fog a transparent draw inside it per pixel (hull meshes sort with other transparent draws by three's order, the
  eye's layer after them all; liquid is opaque and in the depth, so fog over water is right); be seen past the
  detail ring (nothing in the mesh rings or the far field: G2). **The density overlay** (`VoxelWorldDraws
  .setGasOverlay`, the world mode's fog view switch): the same hull nearly opaque, a colour a density (blue,
  magenta, yellow), a uniform, nothing compiled or rebuilt. `?voxelGas=off` leaves gas undrawn (a cost
  comparison; the editor passes it to Play). Structure grids draw their gas the same way (the same derive and
  chunk view; not looked at in a picture). Looked at: pictures L23, L24, E8 (plan-47b §9 "47b.7").
- **Ground cover** (47b.9): what a material's dressing grows (§6 row 6) is drawn on the world grid's chunks inside
  the detail ring, as rows of the culled-instance table through the point-set cover path; no draw path, culling,
  wind or bending of its own. **Made where the world runs** (`@thirdlight/voxel` `cover-stream.ts`,
  `ChunkCoverStream`): a `voxel-cover` job a chunk column (project-model `voxelCoverPoints`, served by every voxel
  worker entry), asked once a chunk of the column is drawn at level 0, for the rows of its drawn chunks, from the
  column and the eight round it as the game sees them (its changes laid over), the build's cover table, the
  keep-clear boxes and the structures' stamps. Not a derive part (the scatter core is above the voxel package):
  the job waits in the pool's background queue, at most a quarter of the workers, and is not asked while a load or
  a derive waits for a worker, so a mesh never waits for cover. **Carried by the chunk draw batch**
  (`ChunkDrawBatch.cover`, applied after the batch's chunks): a column's cover comes after its chunks' draws and
  goes in the batch that removes the last of them. **Made again** when a drawn chunk of the column or of the eight
  round it changes in shape, material, wetness or liquid (`COVER_FED_BY`; never for a gas-only change), when a
  chunk beside it loads, when one of its chunks is drawn or no longer drawn, when a structure's stamp lands or
  leaves, when the table changes (a dressing, a material's dressing: every column, no chunk derived) and when a
  keep-clear box comes, goes or moves (the columns within 8 m); an answer equal to the one sent last is not sent.
  An edit inside one chunk is nine jobs of about 13–24 ms of a worker each. **Drawn** by `three-adapter`
  `voxel-cover.ts` (`VoxelCover`, the scene's `CoverView`): each species of a world is a point source of
  `CoverGpu`, its columns' sets stored in the rule's point atlas and written as rows by `CoverRows`
  (`writeCoverPointRow`), drawn with the species' model and its materials (wind and the interaction field where a
  material reads them), receiving shadows and casting none, out to the scatter rule's default cover distance
  (40 m, thinning from 60 % of it: a species has no distance of its own), which ends inside the low tier's detail
  ring. **Kept clear**: the boxes of the objects marked Static that have a model (a game: their light shape's box
  where they stand when their scene loads; the Scene view: the bounds of what it draws, again as objects change).
  **Structures**: a game's world reads a house through its stamp (nothing grows under its floor); the Scene view
  keeps each structure's box clear instead (D846); a structure grid's own surfaces grow nothing. **Budget**: the
  memory table's `voxelCover` entry (96 bytes a resident point; past it every set hands over the share of its
  points with the lowest thresholds, so cover thins evenly) and the frame arbiter's `voxelCover` slice for handing
  arrived sets to the path. In Play, exports and the Scene view through the one batch and the one path. **What it
  cannot do**: be seen past its reach or the detail ring (the rings phase); cast a shadow; draw its first frame
  without a hitch (D844); follow a static prop a script moves. Looked at: pictures L25, L26 and the Scene view
  (plan-47b §9 "47b.9").
- **Bricks**: 8³ cells with 9³ distance samples, 4³ bricks a node, a node 32³ cells of its level; two 3D
  atlases; drawn through a **visibility target** (brick id and depth) and **one deferred shade** with fog by
  the hit's depth; node boxes are rows of the **culled-instance table** (frustum and depth pyramid in compute,
  indirect draws); what is seen feeds back to what is built.
- **Bake level** per voxel world: 2 m (default), 1 m or 0.5 m; by region, resumable; exports ship what the level
  says. Measured on the 8 km test world: 355 MB at 2 m, 1.36 GB at 1 m, 5.0 GB at 0.5 m.
- **Relief displacement** is off on every tier and **detail-piece LODs** do not exist: both deferred by the
  owner. The **mesh far field** is a fallback behind a switch.
- **Lighting of voxels**: in Play and exports the near field's surfaces (level 0 and the level 1–2 mesh rings) and
  kit pieces cast and receive like any lit draw, as static casters of the key light's cached map and the shadow
  atlas, casting with their faces toward the sun (`shadowSide` front: with three's default, back faces, a wall's
  inner face shades the floor at its foot from within the shadow's bias, a lit line inside a shut room): each chunk, node or seam shown, replaced or taken away is reported where it stands, and only the cached map
  and the lamp faces it reaches are drawn again; the sun's square is centred on the voxel ground under the camera
  (sky heights). Past the square, and in the far field, the **sun heights** shade: the top of what is solid in each
  column round the camera (the sky heights, 0.5 m columns over 512 m; the far field's drawn bricks, 4 m columns over
  4 km), marched toward the sun in compute into two shade lines a column (every caster's; those past the map's reach),
  read by the key light's shadow node (near draws at their vertices, the far field's one shade at its pixels), the map
  fading into them across its edge (`voxel-sun-field.ts`, `sun-heights.ts`; the tier's `voxelSunSteps`). The far
  field's one shade lights every light at its hit. It casts nothing into the maps and carries baked occlusion. Sky
  occlusion and bounce from voxels come only from **the lighting store**, which is the **voxel light volume** (owner's choice
  after the 46e-a A/B; the surface cache's voxel port and the hybrid were removed, code at tag `ab-46e-a`), **on at
  every lighting tier** on game pages (Play, exports; the tier's `voxelLightVolume.enabled`, looked at each frame;
  not in the editor's Scene view); `?voxelLight=off|volume` overrides the tier for a comparison,
  `__tlVoxelPlay.light.setStore` changes it at run time, `?surfaceRead=0` lights it without reading it. WebGPU only
  (WebGL 2 never runs it): it
  keeps light in the open cells beside surfaces (a solid across a face or an edge: by a turned wall's staircase the notch cells hold light too, so a surface's read reaches four to six of its eight cells; `voxel-light-volume.ts`): six values a cell (an ambient cube), 2 m
  bricks in a pool texture round the camera, updated in compute by walk rays (the sky past 24 m; at a surface its
  colour (the look's tint times its albedo texture's mean for the side seen, measured once on the GPU when the arrays arrive) times the sun and lamps seen by walks, the lamps from a list per kept brick built in compute from the clustered lights' record (the hit's level-0 brick, else its finest coarse one, else the whole table) and lit as the per-pixel light lights them: points by three's falloff, spots within their cone (no cookie), area lights (rect and line) by their diffuse form factor on their facing side, walked toward a point of them each ray picks; the ambient and hemisphere lights are in its sky term; glowing materials' glow (each open cell keeps the mean glow of the solid faces it borders, a material's glow × the mean of what it draws, its colour × the glow mask in its ORM map's alpha (the mask draws per pixel; the volume takes its mean, measured with the texture means); and each kept brick's glowing faces are emitters in the lamp table that the cells of the bricks they reach aim at, each glow counted once); and the volume's own light there), and three coarse levels of 1, 2 and
  4 m cells for open air (a clipmap to ±24, ±48 and ±96 m), all in one pool made once (as many slots as the tier's
  `lightVolume` memory row holds); an edit, a lamp's change or a jump of the sun or sky (a look switched) restarts the
  bricks a ray can reach it from (half history while changes continue; past a changed lamp's reach, which saw only
  its bounce, to fewer updates), while a sun or sky that moves (a day: no faster than 10° a second) is **followed**:
  nothing restarts, every kept brick is refreshed in turn (near the eye and in front more often) with its estimate
  blended in by at least 1 / the tier's follow window, so the light lags the sun by a few refreshes without
  shimmer, and once it stops the refining converges from there; the update paced to
  the live light's share of the GPU frame (`gpuPassBudgetMs`), batches' work in its frame slice; while nothing is
  stale it keeps refining settled bricks (the view in front first) within its idle share (`gpuPassIdleBudgetMs`) until
  each has had the tier's history of updates, a face's light the mean of about the last quarter of them, and each write filtered with
  the same face of the cells beside it along the surface (a share that fades as the brick's updates grow). Its rays,
  reach, settle and history counts, follow window, lamp list size and level-0 window are the lighting tier's
  `voxelLightVolume` settings (project-model `VoxelLightVolumeSettings`); a brick's lamp list holds the lamps that can
  light it (a spot's cone, an area light's front) less those negligible against the rest; read per pixel by
  every lit draw (voxel surfaces, kit pieces, props, moving objects; the far shade opts out; lit particles once a
  vertex instead, below) in place of the flat ambient term (`voxel-light-volume-read.ts`): level 0, then each coarse level for what it left, a level read only
  where its window holds the point's bricks; the eight cells round the point half a cell off the surface at every
  distance (the far four of an axis face weigh 0: never across a wall), each written out with its own index load and
  its three faces toward the normal by n²; a surface counts only those of the eight reached from its point's cell a face
  step at a time through cells holding light (where that cell holds none, from the one beside it off the surface most
  toward the normal), so a thin solid whose cells touch by an edge (a roof's steps, a turned wall's staircase, a room's
  inner corner) is never read across, and a surface's level takes its share by the cells the level knows round the point
  where it reads some light (so the coarse levels, whose cells span a thin solid, do not light it from the other side;
  a particle's by its weight) (`volumeReadReach`; plan-47l §8a 47L.3). A shorter form (one loop, a shared index load, only the faces with a weight,
  one cell past a distance) drew white, green, magenta and black pixels at gables, ridges and wall feet on the Iris Xe
  with every value it computed sane; its cause was not found (plan-47l §8a 47L.1). Where no level holds light for a pixel (past the windows, or before its bricks are lit) the flat ambient, sky
and environment term stands in; under a roof (the sun field's near tops over the point taken two columns off its
surface, read at each vertex: `sunCovered`) it is taken at the tier's `indoorShare` (0.2), so a far house's rooms
seen through its windows are not lit as the street is; not a minimum (no light from the volume is changed). Its floor on the Iris Xe is about 2 ms of `near` at a street (the read's presence in the lit program, not its
  loads: one cell costs what eight do); a lower-rate read is not built (D724). Lit particles (an effect output whose
  shading is `lit` or a lit project material) read it in the vertex stage at the particle's centre facing the eye
  (level 0's one cell there, the coarse levels' eight round it) and their pixels take that: particles overdraw, so a
  read a pixel would be paid many times; `?surfaceRead=particlepixel` reads them per pixel for a comparison. Unlit
  particles read nothing. The sun's and lamps' direct light stay per pixel. Measured: plan-46e §8a 46e.6b, §8b, §8d (46e.14).

## 4. Streaming

- A load ring around each focus (192 m by default; it ends at the detail reach on a world baked to its drawn
  level), a memory budget per tier (768 MiB at low), far GPU budget (384 MiB at low); both are entries of the one
  memory budget table (`MEMORY_BUDGET_BY_TIER`, §6 row 7), as are the default path's own: the open regions'
  stitch (`regionStitch`, page), the walk graph (`walkGraph`, page), the sun field's GPU side (`sunField`), the walk's GPU blocks (`voxelWalk`), the
  light volume (`lightVolume`) and ground cover's resident points (`voxelCover`, page: 32 MiB at low, 64 at
  medium, 96 at high).
- **At speed:** no level 0 is built, stale queued work is dropped, the far field carries the view; level 0
  returns from the camera outward when the focus stops.
- **Collision** is on its own path round moving bodies; a **coarse floor** from the 2 m data stops anything
  falling through when fine collision is late.
- Measured at 150 m/s on the low tier (export): longest frame 40–49 ms, ground solid 0.03 s after a stop, full
  detail 3.7–4.0 s on a world baked to 0.5 m.

## 5. Measuring

- Always at the display's cap; GPU timestamps are not usable there (D544). **GPU ms per pass category** (near,
  far, shadows, lighting, post, effects) come from the page's own measurement (game-host `gpu-measure.ts`, on
  WebGPU): ballast loads the frame past its cap, each category's registered passes (three-adapter
  `gpu-pass-hides.ts`; a pass registers how to hide itself) are hidden in windows interleaved with windows that
  hide nothing, frames are timed by the GPU's own completions, and each category is a median with its spread or
  "below resolution" against a control that hides nothing (resolution about 0.2 ms on the low tier's 8 km town,
  §4b of plan-46e). One routine for the Profiler's **Measure GPU**, the overlay, `tl_diagnostics` (`gpu`,
  `gpuMeasure`) and the benches (`run.mjs headroom`, `light-shots --gpu`, perf `village --gpu-measure`); about
  80–130 s a run. The **headroom meter** loads the frame until it misses and gives the room (`run.mjs headroom`,
  the routine's reading beside it); the **coverage bench** gives
  hitches, settle times and fall-throughs (`run.mjs coverage`). The **lighting cameras** (`run.mjs light-shots`,
  `tools/voxel-bench/lighting-cameras.ts`) take five fixed pictures of the 8 km world's town (street at noon, a room
  with a window, a dug cave, night with lamps, the far view) once streaming settles, with the profile at each and
  the edit-to-screen time.
  The **many-lamps scene** (`tools/voxel-bench/many-lamps.ts`, `--lamps 32|128|512` in `light-shots`, `headroom` and
  `coverage`) puts lamps of every type in the town from its own layout (street points, spots under the eaves, door
  panels, fence lines, room lamps, and glowing patches painted at run time), nearest the scene's middle first, as
  bench data taken out after the run; with it `light-shots` also takes three night cameras (`lamps-street`,
  `lamps-room`, `lamps-high`) and times the lamp-lit room's edits. `light-shots --day slow|fast` moves the sun as a
  game's script does (`ctx.environment.blend` over day looks, `day-cycle.ts`) and reads the light following it.
  `?surfaceRead=` names parts of the light volume's read for a comparison (`level0`, `coarse`, `index`, `nodecode`,
  the draw kinds `surface`, `kit`, `prop`; the volume's diagnostics carry it; the read as first built is now the read).
- The **frame profile** (`window.__tlProfiler.read()` on a game page) gives each thread's CPU a frame (page,
  simulation worker, job workers) by budget category against the tier's budget, and the last long frames. It is
  shown in the editor's **Profiler** tab while Play runs, in the stats overlay (Shift+F3, Play and exports), saved
  as a capture file (`version: 1`) and read by agents as a digest (`tl_diagnostics` sections ['profile']).
- Tests: unit tests prove behaviour; `tools/gate.sh check` per commit (build, lint, the fast unit set, the five-test
  boot check), `tools/gate.sh phase` at a phase's close (AGENTS.md "Tests and the gate").

## 6. Shared foundations

| # | Foundation | Used by | State |
|---|---|---|---|
| 1 | Fields derived from voxels, one arithmetic for worker, page and tests (a shader port later) | vegetation rules (the dressing rules read them since 47b.8: `dressing-rules.ts`, row 6), water, fog, `ctx.voxels`, far placement | exists (47b.4): `@thirdlight/voxel` `surface-fields.ts`. **A surface** is a cell drawn as a body whose cell above is not closed (open ground, a cave's floor, each storey, a roof). **Its fields**: height (m: the row plus the fill), slope (degrees, from the ground in the four columns beside; a wall standing beside is left out, a cliff of ground is not), material, role and wetness of the surface cell, sky (0 or 1: nothing closed over it), the water standing on it (top, depth, material), the lowest bank of gas over it (bottom, top, mean density 0 … 1, material), and two distances in metres between column centres, searched and capped at 8 m (`SURFACE_DISTANCE_CAP_M`: 16 cells of 0.5 m): to another material and to construction (a block role or a structure's stamp), both on the surface's own **sheet** (a row up or down a column of distance, construction up to 2 m over it: a cave's floor does not read the meadow over it; a cone, not a walk, so a storey reads the ground outside from as many columns off as it lies rows under it). No spline distance: a road is a material. **Forms**: `surfaceFieldsOf` (one surface of a box's table), `surfaceFields` (the block form: that at each column's highest surface, typed arrays a column), `surfacePoint` (the per-point form: the surface under a point, reading only the cells the kernel reads for it). **Where it runs**: a `surface-fields` job in the derive workers on a chunk column and the eight round it (`surface-fields-job.ts`; level 0 from resident chunks' payloads, the far cache's 2 m nodes from stored bytes: `farGroundFields`, the coarse floor's decode read for every field), the same bytes in a worker and in the calling thread; and `ctx.voxels.surfaceAt` where the world runs (runtime `voxel-surface-read.ts`: a structure's surface under the point first, the world's cells reading structures through their stamps; the distances only when asked). **Never stored and not a derive part**: nothing is made a chunk by default and nothing is kept; a consumer asks for the columns it places on (47b.9's cover) and drops what it keeps when a change's parts are among mesh, shader, liquid, gas (`SURFACE_FIELDS_FED_BY`). No GPU field windows (their first consumers are 49 and 51). At 2 m: ground agrees with the 0.5 m result within stated tolerances; thin construction and narrow materials, shallow water and thin gas are not in a 2 m cell (plan-47b §9 "47b.4") |
| 2 | Open-region labelling (a walk through connected non-solid cells) | rooms, cut-away, audio room size, stream priority, the water and fog fill, water bodies | exists: `@thirdlight/voxel` `open-regions.ts` (per level-0 unit in the derive job: open cells, i.e. not drawn as a body, labelled 6-connected, `opening` cells as portals apart, faces reached, face connectivity, the highest solid cell a column) and `open-region-stitch.ts` (`OpenRegionStitch`: chunks' components joined across faces into regions and portals as chunks arrive, change and leave, structure grids' stamps read with each unit; enclosed, complete, sky, volume, portals, each region's box and surface against solid cells, its parts' boxes; sky heights a column, sent to the page with the draw batches, `sky-columns.ts`); `ctx.voxels.regionAt` (a room, the outdoors, a portal or unknown; box, surface, mean free path 4V/S for a game's audio) and `portalsOf`; the voxel world page's tint overlay (`?regions=1`). **Rooms** (an enclosed region) are used by see-through and the camera's cut-away (the page sends where its subjects stand, the batches answer each one's room and its parts' boxes: `ChunkDrawBatcher.setFocus`, three-adapter `voxel-focus-rooms.ts`, `see-through.ts`) and by the light volume's indoor share (below; by the sky heights alone). The level fill walks the voxels itself (`water/level-fill.ts`, bounded by a level and a reach), not the regions' labels: one function for the water bodies and the `flood` stroke, so the fog fill is that walk with a gas as its value (47b.3); stream priority does not use the labels yet |
| 3 | Far-node side channels and one bake runner | far water, far fog, forest canopy, baked occlusion | 49; the runner exists (far cache) |
| 4 | Camera-following window helper | wind, interaction field, ripples, water info, fog density and simulation | exists: `three-adapter` `camera-window.ts` (`CameraWindow`, `WindowTargets`); the wind map (`wind-field.ts`, its sample public as `MaterialLibrary.windSample`) and the interaction field (`interaction-field.ts`: 256² × 0.25 m, every `interactor` stamped by one compute pass, read by foliage; WebGPU only) sit on it |
| 5 | Regenerated structures (a definition → voxels + overrides) | buildings, road and river splines, water bodies | core exists: `@thirdlight/voxel` `structures/` (the generator contract: pure, a chunk at a time, a box, a version; the building record and its checks; the building generator: polygons' union, walls, floors, stairs, openings, 45° flat, gable and hip roofs; `regenerateStructure` with the fit rule, undo and redo records and the misfits; `captureOverrides`; `regenerateAll`); overrides `TLVO` v2 in use. Through the commands (47a.4): the `voxelStructure` component (project-model `voxel-structure.ts`), workspace `structure-commands.ts` (grid ids, anchor, the diff of a command's structures, one undo step with the scene edit, regenerate-all) and `voxel-structure-writes.ts` (write, copy, delete a grid; overrides captured after a hand edit). In the editor (47a.6): the structure mode (`ui/editmode/structure-mode.tsx`, the Scene view's `structure-tool.ts`): draw, reshape, extend, storeys, turn, a material a part, dig/add/paint on its grid (since 47b.5 with the voxel brush tool of row 8; a paint keeps each cell's role), the misfit list, openings (47a.7). Openings' props (47a.7): `structures/openings.ts` (an opening's cells and frame, the standard sizes, the fit rule), props kept with their openings by the backend's follow-ups, portal state where the world runs (`runtime/voxel-portals.ts`); the mode's Openings column (`session/structure-openings.ts`, `ui/structure/OpeningsPanel.tsx`: a size, a ghost on the wall, place, move along the wall, delete, a prop that fits, glass; no stairs tool yet, D775). Water bodies (47a.10): the level fill, one pure function (`@thirdlight/voxel` `water/level-fill.ts`: a seed, a level, a material, a reach; every leak reported; since 47b.3 its role, a gas's fade and a floor are parameters, a liquid by default, and the `flood` stroke calls the same function: a stroke follows no later edit, a body does), a body's regenerate and its local follow-up (`water/body.ts`), the `waterBody` component (F6), the backend's `voxel-water.ts` (a stroke in a body's reach rewrites it inside the stroke, a command's bodies and structures in a `writeWater` stroke after the structures', a breach drained and reported, never stored), the Inspector's water section, the level ring and the leak markers. Splines (47a.11): the world-writer core (`structures/world-writer.ts`: a writer over the ground of the world grid, a pure function of its definition and the ground, a chunk at a time; the record of what it replaced, F5, `TLVO` read as before and written, `voxels/<world>/structures/<object id>.tlvo`; a rewrite puts back what is still as written, writes the new course, keeps hand edits by the same fit rule, leaves the rest alone and reports it; chunks whose record comes out the same are not touched), the spline writer (`structures/spline-writer.ts`: roads and paths, surface, bed, shoulders cut and filled by slope, `clear`; rivers, liquid down their depth over a bed, the mouth written as a body's liquid at its level), the spline's `voxels` section (project-model `spline.ts`, `spline-voxels.ts`: its world its scene's one voxel world), the backend's `voxel-spline-writes.ts` and `spline-commands.ts` (a `writeSplines` stroke after the structures' and before the water's, one undo step with the scene edit; bodies read a river's cells as ground but at their mouth), the Inspector's spline voxels section and its markers |
| 6 | One culled-instance table for every instanced draw | kit pieces, terrain and far nodes; stored copies (trees, rocks, instance sets); ground cover from point sets; impostors | exists (`occlusion-instances.ts`, on every occlusion path on WebGPU); stored copies and point-set ground cover (block layers, models, architecture floors, and since 47b.9 voxel worlds' dressings: `cover-rows.ts`, a point expanded to a copy's 16 floats) are its rows (`copy-rows.ts`: level by the shared screen-size rule `lodLevelStep` with hysteresis and a cross-fade, thinning by rank or by the cover's share across the ground, frustum and depth pyramid, picked in compute). Not in it: terrain cover placed from heightfield texels (retires in 48); on WebGL 2 copies and point-set cover keep their vertex-stage paths. **Cover on voxel worlds** (47b.8: the data, the rules and the point sets; 47b.9: made a chunk column at a time where the world runs and drawn as point sources of this path, §3 *Ground cover*): a construction or terrain material names a **dressing** (`voxel.dressing`, resolved along its instance chain as its kit is, so a variant that names another dressing is the same ground grown sparser, denser or with other plants); a dressing is a project resource of its own file (`content.dressings`, format 1, `setDressing` / `deleteDressing`; project-model `dressing.ts`): an ordered list of species entries, each a model, a class (`cover`, or `large`: stored, shipped and placed by nothing until 47p), a density, a spacing, a scale range, a yaw, an align, a seed and conditions. **The conditions are ten and no more** (material, role, slope, height, sky, wetness, water depth, distance to another material's edge, distance to construction, noise with its own scale and seed), each a set, a yes or no, or a range with a soft end, read from row 1's fields of the surface a candidate stands on; **one arithmetic** answers them (`@thirdlight/voxel` `dressing-rules.ts`: `dressingShare`, the product of the conditions as a share of the density; `dressingWhyNot`, the first that says no, from the same table of checks) for the page, the workers and the tests. **The voxel source of the scatter core** (project-model `voxel-dressing-source.ts`): a box of cells as a `ScatterSurface` whose `at` and `under` answer every surface of a column in turn (open ground, a cave's floor, each storey), and `voxelCoverPoints`, a pure job over a chunk column and the eight round it (the surface fields job's input with its ring widened to a chunk, plus the dressings as plain data and props' boxes), that gives for each cover species one point set of the existing point-set path (`bakeCoverPoints`, unchanged: the species is handed to the core as a ground cover rule, `dressingSpeciesRule`, and the surface answers whether it grows through the core's layer share). A share under 1 keeps that share of the candidates by a hash of each candidate's own point and floor; a point belongs to the chunk holding its surface's cell; neighbouring chunks agree with one bake over them all, and the same world gives the same bytes in any chunk order, in a worker as on the page (a worker entry serves it with `voxelCoverJobHandlers`). **Rule plants keep clear of props**: a point in a prop's box across the ground, from 0.5 m under its foot to its top, is not grown; the box is the prop's light shape's (`propBounds`: its collider, else its model's bounds), passed as numbers (`propClearances`), nothing stored. The props are the objects marked Static that have a model (runtime `coverKeepsClearOf`; the Scene view's `staticModelBoxes`). A build ships the dressings its shipped materials name (the catalog's `dressings` block) and their species' models. Limits: a cover species' spacing is at most 8 m (what the columns beside a 32-cell chunk hold past the fields' own reach; on 16-cell chunks a species with both a spacing and a distance condition is judged across a border from a shorter search, D842); an instance cannot name "no dressing" over a parent that names one; a species whose model the project lacks grows nothing and reports nothing (D843) |
| 7 | Budget table, profiler and frame arbiter | everything | exists: spans on every thread (`threadProfiler`, shared), `__tlProfiler.read()` on game pages, `FRAME_BUDGET_BY_TIER`, `frameSliceMs` (the arbiter is one table the 13 per-frame slices read their ms from; it does not sum them against the frame, hand unused time on or react to load, so slices can still add past a frame; left outside: block layers', heightfield terrain's and `STREAM_ARRIVAL_MS`, all retiring in 48); memory too: `MEMORY_BUDGET_BY_TIER` (every memory budget as an entry, summed against the tier's page and GPU target) and the resident-bytes report (`residentBytes` registries per thread, game-host `page-memory.ts`, the Profiler tab's Memory table); views and capture in game-host `profile-view.ts` / `profile-capture.ts`; editor Profiler tab (`editor/src/ui/profiler`), overlay Shift+F3, `tl_diagnostics` profile; GPU ms per pass category on demand (`gpu-measure.ts`, passes registered in three-adapter `gpu-pass-hides.ts`) against the GPU budget rows (near and far → render, shadows and lighting → lighting, post → other, effects → effects: `GPU_PASS_BUDGET`) |
| 8 | One world edit mode on the brush kit, in the Scene view | sculpt, paint, fill, splines, rule preview | Sculpt and Paint exist (47b.5), Fill, the fog brush and the spline entry too (47b.6); the rule preview is 47b.10. **The mode** is a scene-scope edit mode on a `voxelWorld` (`ui/editmode/world-mode.tsx`: the Inspector's Edit world, a double-click in the Hierarchy; the whole scene drawn, the world of the object it was opened on edited). **One voxel brush tool** on the Scene view (`viewport/voxel-brush-tool.ts`, arithmetic in `session/voxel-brush.ts`) for a world's lattice and a structure's grid (`command.grid`; the structure mode's hand edits are this tool, with no copy of their own): the worker's pick (`walkWithGrids`; only a hit on the armed grid is the tool's), the shared brush's store, keys, panel and cursor, dabs on cells (Add's on the cell in front of the face met), thinned to the brush's spacing in whole cells with gaps between picks filled along the line, **one `editVoxels` command (v3) a stroke at the release**, drawn when the change feed brings its chunks (`voxelsChanged`): nothing is written or previewed while dragging but the cursor and the dabs' trail. **Sculpt**: add (the palette's material; ground for a terrain material, wall blocks for a construction one), dig (Ctrl swaps the two), smooth, flatten (its plane the surface under the stroke's first dab: row plus fill); a ball, box or cylinder, a soft or hard rim (`smooth`). **Paint**: the palette (the project's terrain and construction voxel materials; a base with its material instances as its variants, `voxelPalette`; a gas or liquid palette is the same function asked for another use), a wetness level, and the brush kit's noise mask, which the command has no field for: a masked paint is laid as one-cell columns of the brush's height where the mask is at half weight or more, still one command. A paint names no role, so each cell keeps its own. **The fog brush** (Paint, a gas picked: `PAINT_PALETTE_USES` adds the gases): Fog writes the gas into the open cells under the dabs at a density (1 … 15), Erase takes gas cells out, Smooth is the command's `smooth` with the gas as its `voxel`. The brush has no form for the first two (`add` takes a liquid's cells and writes full density, `dig` takes ground: D838), so a fog stroke **names its cells**: the box under its dabs is read from the Scene view's worker (a `cells` message beside the pick, `walk.record`), `fogCells` keeps the open ones (air and gas) or the gas ones, and the one command is a `set` of the gas at the density or a `dig` of the cells (`session/voxel-fill.ts`); ground, built cells, openings, liquids and cells not loaded are never named. A fog brush is at most 8 m across (`FOG_BRUSH_BOUNDS`: a command names its cells one by one). **Fill** (`viewport/voxel-fill-gesture.ts`, owned by the brush tool: the same pointer, pick and grid): a press takes the open cell in front of the face met as the seed, the level starts a set depth over the surface clicked and follows the pointer up and down the screen in quarter metres (drawn as the water bodies' level ring, `heightRingLines`, with a post at the seed), the release sends one command: a `flood` (v3) with the picked gas, a reach and a fade for Fog, with air for Drain, and for Water one `createEntity` of a `waterBody` at the seed (never a liquid flood: a body follows later ground edits, a stroke does not). The reach's bound is asked of the command (`floodReachBoundM`: `editChunks` on the widest flood that fits one stroke's work, 63 m on 32-cell chunks) and said on the panel. A refusal `flood_leaks` marks its places with the water bodies' markers (`WaterLeakMarkers`, group `flood-leaks`) until a fill is taken or the fill tools are put down; the editor's refusal keeps the error's `leaks`. **Splines**: a rail entry for Road, Path and River: a drag gives the first two points, one `createEntity` makes the spline with its `voxels` section preset (`splineStartVoxels`, the Inspector's own start), and the mode closes with it selected (`EditModeHost.handOver`) for the spline's handles. **The fog view switch** (47b.7; on the Fill panel and the fog brush's): As drawn, or Density (the gas draw's overlay, §3 *Gas*; `gasOverlayShown`: only while a rail with fog tools shows, never in Play). Not in it: a fog body that follows ground edits, a soft rim or a density by coverage for painted fog, a wetness painted without a material (the command's paint writes both), a strength for smooth and flatten, a cursor that follows the ground's height (it is level, round the dab's cell) |

Also shared already and to be reused, not rebuilt: the editor's brush settings, cursor, keys and panel; the
preview renderer; the node-graph canvas; asset pickers; the edit-mode shell (modes: prefab, terrain, block, structure, world, vertex paint, decal); the voxel brush tool (row 8: every hand edit of voxels in the Scene view); `paint-brush.ts`; the scatter rule
core (`scatter.ts`; its voxel source: row 6); the spline format and curve maths; the voxel `WorkerPool` and `job-queue`; `view-cull.ts`; the level-of-detail rule by screen size with hysteresis (`@thirdlight/shared` `lodLevelOf` / `lodLevelStep`, for the CPU and shaders; voxel rings keep their own);
`screen-history.ts`; `dither-fade.ts`; one search core for paths and reaches (`@thirdlight/shared` `PathSearch`: A* and Dijkstra over integer nodes, typed
arrays reused by generation, bounded and resumable runs; the walk graph's searches; block layers' `block-walk.ts`
keeps its own until it retires); one buffer grow (`@thirdlight/shared` `grownCapacity` / `grownArray`;
`grownGpuBuffer` for raw GPU scratch buffers); one region-texture helper for a texture three owns (`region-texture.ts`:
partial upload, grow by copy, the texture version rule; the private three hooks for it live there alone); one occupancy walk for rays (`@thirdlight/voxel` `occupancy-walk.ts`, 6-connected, level 0 then the mips and far nodes; on the GPU `voxelWalkWgsl` over the blocks the draw batches carry while something on the page reads that walk (the light volume, a bench's check; none, and nothing is packed), to the mips only: a second copy of the loop sharing three step helpers (`walk-steps.ts`), held equal by a 1,200-ray check, not one definition; `ctx.voxels.raycast` and the editor's picks; light rays stop at half coverage, the voxels', lit props' and structure stamps' joined at level 0, and carry a transmittance through the cells a body covers in part under that (a block's cover, 4 bits a cell in two page slots beside its page, found by the table entry's fourth word; the GPU walk reads the same words); `walkWithGrids` walks a world and its structure grids each in its own frame, CPU only, the grids along a ray from a
tile index, `GridWalkIndex`: `ctx.voxels.raycast` and the Scene view's pick); one scene realizer for the editor and games; one content closure for
Play and export.

## 7. What is planned on top (see the roadmap)

Water is liquid-role voxels: drawn plain near the eye with narrowed feeds (47a.9) and bodies that regenerate when
the ground is edited in the editor (47a.10) exist (§2, §6 row 5); a surface shader, far water, flow and falls,
queries and buoyancy come in 49, extending the liquid part. Fog is the `gas` role with the shape bits as density
and the material id as fog type: the role, its mip rule, the `gas` material use and the narrowed feed exist (47b.2,
§2), and it is painted, erased and smoothed with the voxel brush and filled to a level by the fill shared with water
(47b.6, §6 row 8), and drawn near the eye in a plain look (47b.7, §3 *Gas*: a see-through hull in one flat unlit colour; the fields a rule reads exist: §6 row 1); lit fog, a march through its density, fog past the detail ring and an interactive ground fog on the interaction field come in 51. Vegetation is rules hanging off the
material record as a dressing (the asset, `voxel.dressing`, the rules' one arithmetic and the voxel source of the
scatter core exist: 47b.8, §6 row 6); a hand-placed prop is kept clear by its box; density by material variations
(an instance naming another dressing); cover drawn on voxel chunks inside its 40 m reach (47b.9, §3 *Ground cover*); the rules' authoring and starter plants (47b.10); large plants and every large static object stamped into the voxel data under a `prop`
role, read by light, paths, collision and the far bricks, drawn near as their own models (47p); LODs (50); draw
rings and fades between model, mesh ring and brick (after 51).
