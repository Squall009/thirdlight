# Generated architecture

How to generate rooms and buildings step by step: [the generated architecture guide](../guides/generated-architecture.md).

## Generated architecture

The **architecture** component stores only parameters; the meshes are made
when a scene loads (and again when the parameters change), on generator
workers, a chunk at a time nearest the camera first. Two primitives and
fills build everything (MCP `setComponent "architecture"`; the Inspector
shows its fields as JSON, and outlines styled by presets with their
sliders — see [Architecture styles and presets](#architecture-styles-and-presets)):

- **Paths** `{points: [[x, y, z], …] (m from the object's position; its
  rotation and scale are not used), closed?, bulges? (per segment: an arc,
  tan of a quarter of its angle, + bulges right of travel; 1 = a half
  circle), curve? (a smooth curve through the points, as a spline), step?
  (m between samples on arcs and curves, default 0.5), offset? (m to the
  right, corners mitred), chamfer? (m cut off each corner)}`.
- **Profiles** (`profiles: {name: {points: [[across, up], …], slots: [one
  trim row per segment, "" leaves it open], closed?, smooth? (round
  mouldings drawn with many points), chamfer?}}`): faces look to the right
  of each segment's direction (a wall drawn bottom to top faces +across);
  across is to the right of the path's travel.
- **Sweep** `{id, kind: "sweep", path, profile, openings?, material?,
  detail?, collide?}`: the profile carried along the path, placed on the
  mitre plane at every corner, so mouldings meet at corners, T-junctions
  and frames. Each profile segment is a strip of its row: u along it in
  metres, v spanning the row once (a taller segment stacks strips; smooth
  segments of one row are one strip). **Openings** `[{id, at (m along),
  width, bottom, top, reveal? (slot, default "frame"; "" none), frame?
  (a profile swept round it, mitred), frameSides? outer|inner|both,
  model? (a kit model instead of reveals and frame), pane? (a glass quad
  across the hole on the `glass` material slot: a second draw), storey?
  (outlines' openings: the room storey they are in)}]` cut the strips.
  `wall: true` marks a room's wall (shared between rooms, blocking grid
  walks on a block layer); `stepped: true` gives a box under each level
  face of the profile instead of one round it (stairs); `segmentSlots:
  {"<segment>": [slot per profile segment]}` wears other rows along one
  path segment. A profile's `cap` slot closes a closed profile's ends on
  an open path (a stair's sides, a pipe's ends).
- **Repeat** `{id, kind: "repeat", path, spacing, start?, end?, corners?,
  align? (default true: +X along the path), offset? [across, up], yaw?,
  jitter? {yaw?, along?} (seeded by `seed`), piece}`: `piece: {elements:
  [sweeps and fills]}` is made once in the copy's frame and stamped at every
  copy (a column: a profile swept round a small square); `piece: {model:
  {assetId, piece?}}` places a kit model's copies (instances; `_COL`
  colliders).
- **Fill** `{id, kind: "fill", path (closed), shape, slot, trimSlot?,
  height?, rise?, face?, axis?, cell?, depth?, overhang?, breakRise?,
  inset?}`: `flat` (any polygon: floors face up, `face: "down"` for a
  ceiling), `coffered` (a ceiling and beams every `cell` m, `depth` deep),
  `barrel` and `groin` vaults (`rise` above `height`; vaults face in),
  `gable`, `hip`, `mansard` roofs (eaves at `height`, `overhang`; gable ends
  wear `trimSlot`). Vaults and roofs need a rectangular path (four corners
  at right angles); any other is reported and left unfilled. `holes:
  [closed paths]` cut a flat or coffered fill (a stairwell).
- **Overrides** `[{element, segment | corner, reach?, model, stretch?}]`: a
  kit model UV'd against the row layout in place of a segment (made 1 m
  long along +X, stretched to the segment unless `stretch: false`) or a
  corner (the sweep left out `reach` m either side).
- **The rest**: `chunkSize` (m, default 16: one worker job and one draw per
  material per chunk; 32 halves the draws again, its dense chunks take
  longer than 5 ms to make), `seed`, `ao: {strength? (0.6), radius? (0.5 m)}`
  (vertex occlusion baked into COLOR_0 red: inside corners of profiles and
  paths, where walls meet the ground, fill edges; 0 turns it off),
  `lodDistance` (m, default 40: past it a chunk draws its far level — the
  same vertices without detail elements, opening frames and coffer beams),
  `castShadow`, `receiveShadow`.
- **Materials.** Every element wears a material slot (`material`, default
  `architecture`); the object's Materials map it (`{"architecture": id}` or
  `{"*": id}`), and a trim material's row table lays the strips out —
  swapping the sheet (or the material) restyles the geometry without
  touching the parameters. A slot without a trim material is laid out on
  the engine's starter sheet.
- **Deterministic.** The generator is plain arithmetic with its own trig
  (no `Math.sin`, `hypot`, …): the same parameters give the same bytes on
  the page, in a worker and in another browser. Generated objects' ids are
  stable (element id and place: `wall:seg2`, `columns:7`).
- **Cached by a hash of the parameters.** Each chunk's key hashes the
  generator version, the sheets, and only the elements that reach it (with
  the profiles they sweep), so changing one room re-makes only its chunks; made chunks stay
  in memory (64 MiB) and, in an exported game, in the player's IndexedDB
  (`thirdlight-architecture`), so a second visit draws without generating.
  The old meshes stay drawn until the new ones are in.
- **Colliders** are made by the simulation from the same parameters: a box
  per wall segment (cut round openings, closing outer corners), meshes for
  floors (`collide` on roofs and vaults adds theirs), a box per stamped
  piece copy, kit copies' `_COL` parts.
- **Exports** ship the parameters; the game generates at load. Project
  setting `architecture_ship_meshes` 1 (Project Settings → Gameplay → Engine, **Generated
  architecture**) ships the meshes the same generator made too (one blob
  per object, named by the component's `baked`; larger download, nothing to
  generate).
- **Measured** (Iris Xe; Node for the generator alone, warm): a village of 64
  test rooms (walls with a door and a window, frames, a crown moulding, a
  floor, a barrel vault, four stamped columns; 240,000 triangles) in 32 m
  chunks: 9 draws, 5.0 ms median / 7.2 ms worst per chunk; in 16 m chunks 36
  draws, 1.4 / 2.9 ms; keying every chunk 3.7 ms on the page; one room
  changed (its chunks keyed and made again) 10 ms (16 m chunks: 5.5 ms); a
  shipped-meshes blob of 16.8 MB. In the browser (layered-material e2e, both
  renderers): a chunk 1.5–11 ms on a cold worker, the spawn's chunks drawn
  42–74 ms after the scene's parameters were set (of which 32–67 ms is the
  wait for the first frame); while the workers are still loading their
  script the page makes the chunks round the camera itself.
- Roofs over other footprints than a rectangle: see [Buildings](#buildings).
  Wall paint on generated faces: see [Rooms and paths](#rooms-and-paths).
- `?architecture=off` on a game page draws nothing generated (to measure
  what it costs); the adapter's diagnostics carry `architecture` (chunks,
  draws, triangles, queued, made on workers/the page/memory/the store,
  generation ms), the simulation's `architecture` (colliders, last build).
  Each chunk made marks `tl:arch:chunk` and each object drawn whole
  `tl:arch:ready` (detail: ms) in the page's performance timeline.

## Architecture styles and presets

Outlines (`architecture.outlines: [{id (at most 48 characters), path,
preset, openings?}]`) are made by their preset's **style**: a graph of the
generator's operators, so restyling a level swaps presets (and the trim
sheet a preset names) and never touches an outline.

- **A style** is a standalone graph (Create → Graph → **Architecture
  style**, MCP `setGraph` kind `architecture-style`, opened in the graph
  editor): **Outline** (the path it is drawn on), **Parameter** (an exposed
  slider: name, default, min, max), Constant, Add, Multiply, Mix, paths
  (**Offset** to the right of travel, **Raise**, **Chamfer**, a **Square**
  round a repeated piece's middle), profiles (**Wall**: thickness, height,
  dado, chamfer, inside/outside/lower/top slots; **Band**: a baseboard or
  rail on a face; **Cove**: a cove moulding under a ceiling; **Shaft**: a
  column's face; **Frame**: round openings), elements (**Sweep**, with
  Openings on: the outline's doors and windows framed by its frame input;
  **Repeat** of pieces; **Fill**) and one **Output**. Every number field
  has an input port of its key: a wire replaces the field. A profile of 0
  depth or height makes nothing (a slider at 0 leaves a moulding out).
- **A preset** is a standalone graph too (Create → Graph → **Architecture
  preset**, kind `architecture-preset`; a new one derives from the starter
  room): one **Preset** node (its style, the preset it **derives from**, the
  **trim sheet** material it wears) and a node per value it sets (**Value**
  {parameter, value}) or drives (**Mask** {parameter, to, source noise |
  height | painted, mask, scale, seed, low, high}). A preset's values sit
  over its base's (prefab-variant style): a change to the base reaches
  every preset derived from it. Presets deriving from each other in a
  cycle are refused.
- **Masks** vary one slider across the level, read at each outline's
  middle: world noise (the material rules' lattice noise, `scale` m),
  the middle's world height, or a **painted mask** on the object
  (`architecture.masks: {name: {points: [[x, z, radius, weight], …]}}`, soft
  dabs). The value goes from the preset's where the mask is 0 (`low`) to
  `to` where it is 1 (`high`), within the parameter's range.
- **The engine's starters** are in every project (neutral, no game look):
  `starter-room` (walls with a dado, baseboard, cove crown, floor, flat
  ceiling), `starter-room-tall` (derives from it), `starter-hall` (a barrel
  vault and pilasters; a rectangular outline) and `starter-rail` (posts and
  a rail along any path), with their `-style` graphs. A project's graph of
  the same id replaces one; a project preset may derive from them.
- **The Inspector**: an architecture object's **Outlines** (each outline's
  preset; **Add room outline**; **Restyle** every outline of one preset with
  another) and the sliders of the presets it uses; a preset open in the
  graph editor shows the same sliders, its style, base and trim sheet. While
  a slider is dragged the Scene view regenerates only the objects whose
  outlines the preset reaches (and of those only the chunks whose elements
  changed); releasing stores the value (one undo); ↺ takes the preset's own
  value away. A starter's sliders are read-only: **Derive a preset** makes a
  project preset from it and moves the object's outlines onto it.
- **At run time**: `ctx.grid.setArchitecturePreset(from, to | null)` shows
  preset `to` wherever an outline names `from` (style, values and trim
  sheet), level-wide, in the background (old chunks drawn until the new are
  in), the colliders following; saved with the grid (`diff()`), undone by
  `null`, read with `ctx.grid.architecturePreset(from)`. A script may also
  swap the object's own sheet with a material swap (`set("materials", …)`).
  Exports ship the project's style and preset graphs (`architectureStyles`
  in the catalog) and the trim sheets presets name; an export that ships
  meshes generates a swapped preset at run time.
- **Measured** (Node, warm; 64 styled starter rooms with a door, 320
  elements): expanding every outline 2.0 ms (16 m chunks) – 2.8 ms; one
  preset's slider moved over one room (expand, keys, its changed chunk made)
  7.3 ms median / 7.9 ms worst in 16 m chunks, 12.8 / 14.7 ms in 32 m chunks
  (the soft target: 16 ms). Editor measurements: `docs/plan-phase-30.md`, §6.

## Rooms and paths

Rooms and paths are outlines of generated architecture drawn on a **block
layer** (`architecture.layer` names the layer's object; the object stands
at the layer's place): a **room** is a closed outline (its inside to the
right of travel), a **path** an open one (a rail, a fence, a pipe). The
layer reads them back: their walls block its grid walks, the rooms are
its regions, its wall paint shows on their faces.

- **Drawing** (the layer's Inspector → **Rooms** tool; the slice sets the
  floor drawn on): **Rectangle** (drag corner to corner), **Polygon**
  (click the corners; the **arc bulge** makes the next side an arc; click
  the first corner, double-click or Enter to close), **Path** (click the
  points; double-click or Enter ends it), **Door**, **Window** (a pane)
  and **Arch** (two cells, no door) put on the nearest straight wall,
  whole cells wide; **Walls** drags a straight wall across itself by whole
  cells (a wall two rooms share moves with both), the Scene view
  regenerating only that object's changed chunks while dragging. Points
  snap to cell corners. Every gesture is one command (one undo); the first
  room makes the rooms object. Backspace takes a corner back, Esc drops it.
- **The room inspector** (pick a room in the list or with Walls): its
  inside **preset**, an **outside preset** (dresses the walls' outer faces
  in its wall's inside rows and runs its trims — not its walls or fills —
  along the stretches no other room shares), **storeys** and **storey
  height** (absent: the walls' top), each opening's place, size and pane,
  **stairs** (Add stair: a flight along the first wall rising a storey)
  and floor **holes**; **door piece**: an edge block type put on the
  layer's cell edges in an opening (a live type spawns its object; scripts
  open and close it with `ctx.grid.setEdgeOpen`).
- **Data** (`architecture.outlines[]`, additive): `outside?`, `storeys?`
  (1-1000), `storeyHeight?`, `holes? [{storey?, path (closed)}]`, `stairs?
  [{id, from [x, y, z], to [x, y, z], width, steps?}]` (the middle of the
  bottom step's front and of the top step's back; steps of about 0.18 m
  unless named), openings' `storey?` and `pane?`. A stair cuts the floor of
  the storey it reaches; its treads wear `floor`, risers and sides
  `lower_wall`, and it collides step by step.
- **Shared walls**: where two rooms' outlines run along one line at one
  height, the wall (the style's sweep marked **Wall**, drawn on the
  outline) is made once, by the room listed first; its face toward the
  other room wears that room's inside rows; the other room's wall stops at
  its face. A door either room puts there is cut once, framed both sides,
  and cuts both rooms' trims (a moulding inset from the walls takes an
  opening at its nearest point). Only straight, level rooms share walls.
- **On the block layer**: walls standing on cell lines block passage
  across the edges they cover, in their rows (`ctx.grid` paths, reach and
  `blocked`); a doorway lets passage through unless an edge piece stands
  in it (a door: its own open state decides). Each room storey is a region
  (`ctx.grid.regions/region/inRegion`: the outline's id, `-s1`, `-s2`… up).
  A room's ground floor lies 1 cm over the cells it stands on. The layer's
  **wall paint** (Paint texture, On: Walls) reaches the rooms' walls and is
  read onto the generated vertices (paint layer 3 as grime, the wetness as
  wetness), made again with them, so it stays where it was painted; a
  chunk's key carries the paint it reads (a stroke re-makes only those).
- **Starters**: `starter-fence` (posts and a rail) and `starter-pipe` (a
  round section, capped) join the room, hall and rail; the style graph has
  a **Round** profile and the Sweep's **Wall** flag.
- **Glass and emissive**: panes go on the `glass` material slot; a style
  element may name any slot (`emissive`…): each slot is one draw per chunk.
- **Measured**: `docs/plan-phase-30.md`, §6.

## Rooms drive culling and lighting

The rooms of generated architecture (every room storey of every object
with outlines, *Rooms and paths*) and their openings make a **portal
graph** the page reads each drawn frame. Nothing is stored: it is made from
the outlines at load, in the editor's Scene view, Play and the export alike.

- **Portals** — a door, window or arch opening (between the room and what
  lies across it: another room, or the outside), a hole in a floor (the room
  below; stairs cut one), and the top of a room nothing covers (no ceiling,
  no roof, no storey above: the sky). A **closed door piece** (an edge piece
  of the layer that blocks passage, `open` false) standing across a
  doorway's foot shuts it; an open one, or none, lets sight through.
- **Culling** — from the room the eye is in (or the outside), through every
  open portal whose picture still overlaps what is seen of the portal before
  it, and only from the side the sight comes from: the rooms reached are
  seen. A drawable in a room not seen (its bounds' middle in the room), or
  outside while the outside is not seen, is not drawn by the view — it still
  casts its shadow. A chunk of generated walls or of the layer under the
  rooms is drawn while any room its faces look into is seen. Lights are
  never switched off (that would rebuild every lit shader): a lamp in a
  room not seen lights only that room's drawables, which are not drawn. The
  walk runs when the view moves or a door opens or shuts (about 0.1 ms).
  `?portals=off` on a game page draws everything (a diagnostic comparison;
  the lights' room test stays). Instanced copies (instance sets, scatter)
  belong to no room: they are culled by the view only.
- **Lighting by room** — rooms are a light layer of their own, beside the 8
  named ones: every point and spot light on a page with rooms is bound to
  the room it stands in (the outside: room 0), and lights only drawables of
  that room; a chunk spanning rooms is lit per face by the room each face
  looks into. So a lamp without a shadow stops at its room's walls, and a
  street lamp does not light the rooms behind the walls it stands by. The
  sun, the ambient and the hemisphere light light every room. Each room has
  its own key: any number of rooms, no two sharing a layer. An object
  spanning rooms counts as in the room of its middle; a moving one follows
  the rooms it walks through.
- **Probes** — a probe bake gives each room a probe volume of its own
  (inside its walls, listed first: a point in a room reads its room's
  probes) and bakes the generated walls, so a room's indirect light is not
  read through a wall from the next room's probes.
- **Cut-aways** — a block layer's cut-aways (`blockLayer.cutaway.regions`)
  may name the rooms drawn on it as regions (the outline's id, `-s1`,
  `-s2`… for the storeys above): e.g. `{region: "hall-s1"}` hides the
  hall's upper storey while the camera's target is below it. They cut the
  generated walls, floors and ceilings in the zone as they cut cells.
- **Diagnostics** — Play's `renderer.rooms`: rooms, portals, doors (closed),
  the eye's room, rooms seen and whether the outside is, draws hidden, the
  walk's and sweep's time, meshes with rooms per vertex, lamps in rooms not
  seen, and the mesh–light pairs lit (with the rooms, and as without them).
  The canvas' `data-tl-rooms` = `<rooms seen>/<rooms> <draws hidden>
  <pairs lit>/<pairs without rooms>` (an export's only diagnostics surface).
- **Measured**: the `interior` level class (`node tools/perf/run.mjs level
  --classes interior --switches portals=off`); the numbers are in
  `docs/plan-phase-30.md`, §6.

### Interior lighting best practice (shadow rules)

Interiors are lit by many small lamps, and a lamp's shadow is the dearest
thing it does (a point light's is six views of the scene, a spot's one).
The engine follows these rules, and games should too:

- **No shadow by default.** A light casts only when its `castShadow` says
  so. Rooms keep an unshadowed lamp's light inside its room (above), so most
  lamps need no shadow at all.
- **A budget of shadowed lamps per view.** A quality level's
  `shadowedLights` (2–4 is a good start; absent: every lamp that casts)
  keeps the shadows of the lamps largest on screen (their reach over their
  distance), in rooms that are seen and in view; the rest draw none. A spot
  ranks ahead of a point light of the same size: prefer spots where a shadow
  matters.
- **Fade with distance.** Budgeted shadows fade out between 30 and 40 m
  (`LOCAL_SHADOW_DISTANCE`), so a lamp leaving the budget far away does not
  pop.
- **Cached maps.** A budgeted lamp's map is drawn when it enters the
  budget, when it moves, when the static casters change, and while
  something that moves is within its reach; a lamp in a still room draws its
  map once. The sun's shadow keeps its cached static map and dynamic map.
- Play diagnostics: `renderer.lights.localShadows` {budget, casting,
  shadowed, drawn (maps drawn this frame)}.

## Buildings

A **building** is a room outline with a facade and a roof whose interior is
made from the same definition, in place or in a scene of its own
(`architecture.buildings`, additive; drawn on a block layer like rooms).

- **Drawing** — the layer's **Rooms** tool, **Building** mode: click the
  footprint's corners (an L, a T, any polygon; click the first corner,
  double-click or Enter to close). A new building wears the **new room
  preset** inside, the **new facade preset** outside (none: the inside's own
  outer faces) and a hip roof. Door, Window, Arch and Walls work on its
  walls as on a room's; a window or door on an upper storey is put from the
  slice at that storey's height.
- **The building inspector** — inside and **facade preset**, **storeys**
  and **storey height**, openings (place, size, pane), stairs and holes as a
  room's; **roof shape** (none, flat, gable, hip, mansard), **roof rise**
  (absent: half the footprint's deepest inset — a quarter of a rectangle's
  width), **roof overhang** (absent: `ARCHITECTURE_ROOF_OVERHANG_DEFAULT`
  0.3 m), **roof slot** (absent: `upper_wall`, as the starter row layout
  has no roof row; a sheet with one names it); **interior**: in place or a
  scene of the project (**New interior scene** makes one), and the
  **interior offset** (metres the interior stands from the building).
- **Roofs** over any footprint — a rectangle; any convex polygon
  a hip (each eave's plane kept where it is lowest: the straight skeleton of
  a convex polygon); a footprint with only right angles (L, T, U, stepped)
  the roofs of its largest rectangles at one slope, which is its straight
  skeleton roof for hips and mansards (gables cross: each wing's ridge runs
  to its own gable). Other footprints (slanted concave sides) are reported in
  the object's problems and get no roof. Plain fills (`kind: "fill"`,
  `shape` gable/hip/mansard) take the same footprints.
- **One definition, two sides** — with an interior scene the building's
  object makes the exterior (walls, floors and ceilings so windows show
  rooms, the facade and the roof; no inside trims or stairs) and the build
  (Play, the export, and the editor's Scene view while that scene is open)
  makes the interior into the interior scene: an object at the building's
  place moved by the offset, carrying the building (`interiorOf`), wearing
  the building object's materials (everything but the facade's trims and
  the roof). Both are made from the same walls and openings, so windows,
  doors and storeys line up. The interior is not stored: edit the building
  and both sides follow; place props in the interior scene by hand. The
  interior scene must be another scene of the project (a reference check).
- **Doors and their links** — a ground-storey opening whose sill is at the
  floor (`ARCHITECTURE_DOOR_SILL_MAX`, 5 cm) is a door. Scripts read
  `ctx.grid.doorLinks()` (every loaded side) or `ctx.grid.doorLink(point,
  reach = 2)` (the nearest): `{id ("<building>/<door>", the same both
  sides), building, door, entity, scene, side ("outside" | "inside"),
  position, spawn, facing, to: {scene, position, spawn, facing}}` — the
  spawn stands `ARCHITECTURE_DOOR_SPAWN_DISTANCE` (1 m) in front of the door
  on its side, `facing` turns +Z out of the door (degrees, as
  `character_place`'s). What using a door does is the game's, e.g.
  `ctx.scenes.load(link.to.scene, { unload: [link.scene], fade: 0.3 })`,
  then placing its kept player at `link.to.spawn` once the scene is loaded.
  The visual-script node is **Door link near**.
- **Made before the door is used** — a game page reads ahead the interior
  scenes of the doors within `BUILDING_READ_AHEAD_METRES` (50 m) of the
  camera, nearest first (among the `SCENES_READ_AHEAD` scenes read ahead);
  reading one ahead also makes its generated chunks on the generator
  workers into the cache, so the frame the scene arrives in draws the
  interior whole. Play's observation lists the scenes read ahead
  (`scenes.preloaded`); its scene timings give a load's time from the
  request to drawn.
- **Measured**: `docs/plan-phase-30.md`, §6.

## Floor plans and furnishing

A building's footprint can be split into rooms by a **room program** and the
rooms furnished by a **furnishing set**, both made at load from the
building's parameters (additive fields; nothing generated is stored).
Programs and sets are **the game's data** — standalone graphs the project
makes (Create → Graph → **Room program** / **Furnishing set**); the engine
ships none.

- **Room program** (graph kind `room-program`): one **Program** node —
  **grid** (walls on it from the footprint's corner; default 1 m),
  **smallest side** (2.4 m), **door width** / **height** (1 / 2.1 m),
  **entrance room** (the type the front door opens into), **spare space**
  (the type leftover parts become; default the first room's) — and a
  **Room** node per room type: **type**, **share** of the storey's floor,
  **count**, **storeys** (`ground`; `upper`: each storey above the ground,
  the ground when there is none; `every`), **holds the stairs** (on every
  storey in one place; flights along its longer side switching back storey
  by storey) and its own **inside preset** (empty: the building's). A wire
  between two Room nodes asks for a door between rooms of those types; every
  room is joined to the entrance (upstairs: the stairs) by doors whether
  wired or not. The footprint's sides must run along x and z (cell-drawn
  ones do); others are reported in the object's problems and stay one room.
- **Furnishing set** (graph kind `furnishing-set`): one **Furnishing**
  node — **door clearance** (metres kept free in front of each door, both
  sides; 1), **path width** (a walkable path this wide is kept joining each
  room's doors and stairs; 0.8), **wall gap** (0.02) and **lights** (the
  most one building gets, largest rooms first; 4) — **Prop** nodes (**room
  type**, empty for any; a kit **model** and **piece**; **place**: `wall`
  (its back to a wall, facing the room), `corner`, `centre` (facing the
  room's first door); its footprint **width** along its X and **depth**
  along its Z in metres (the model's pivot at its base's middle, its front
  +Z), **height** (taller than a window's sill: not in front of it),
  **count** and the **space round it**) and **Light** nodes (one point light
  in each room of the type, **height** over the floor, **colour**,
  **intensity**, **range**; no shadow).
- **The building inspector** (Rooms tool → a building) — **room program**
  and **furnishing set** pickers, **layout seed** and **New layout** (the
  next seed: rooms and props laid out again), the props list with **Pin** /
  **Unpin**: a pinned prop (`buildings[].pins [{id, model, position, facing,
  size?}]`) stays where it is whatever is made again; the furnishing places
  the rest around it. **Lock plan** stores the program's rooms as the
  building's rooms (outlines with `building` and `roomType`: edited with
  the Rooms tool like any room, furnished by type; the program no longer
  runs); **Detach** also pins every prop; **Unlock plan** removes the stored
  rooms.
- **How it is made** — the rooms are room outlines inside the building: the
  building makes its walls on the footprint once (each room's face of them
  in the room's rows), partitions are shared walls (made once, a door cut
  once and framed both sides), and on the storeys the rooms fill the
  building makes only its walls (the rooms make floors, ceilings and trims).
  Rooms are rooms everywhere else too: grid regions, portals and light
  layers, cut-aways, with their type in `ArchitectureRoomPlan.type`. Props
  are the generator's kit copies: one instance set per model per chunk,
  with the model's colliders. Lights are light objects the build (Play and
  the export) and the Scene view add as children of the building's object,
  within the scene's budget of point and spot lights (`MAX_LOCAL_LIGHTS`,
  16: the scene's own first) — many furnished buildings in one scene share
  it; interiors in scenes of their own each get theirs.
- **Generated at load, not baked**: a building's split takes about 0.08 ms
  and its furnishing under 1 ms (`docs/plan-phase-30.md`, §6), so
  only the parameters ship; plans and furnished rooms are remembered while
  their inputs stay the same (the editor's edits make only the building
  they touch again).
