# World streaming

The idea in short: [Streaming and budgets](../concepts/streaming-and-budgets.md).

## World streaming (terrain tiles and block chunks)

A terrain or a block layer with **Streaming** rings keeps only what is round
the camera loaded in Play and the export; the editor's Scene view keeps
everything (editing needs every tile and chunk).

- **The rings** (`terrain.streaming` / `blockLayer.streaming: {render,
  collision?, scatter?, live?, hysteresis?}`, metres across the ground to
  each tile's or chunk's square; the Inspector's **Streaming** group):
  **render** — drawn at full detail (a terrain's ring never reaches less far
  than where its tiles draw only their coarsest level — the finest level's
  reach doubled once per level: 72 m for 65-sample tiles 0.5 m apart,
  1,152 m for 257-sample tiles 2 m apart; past it the terrain is drawn from
  its **overview**); **collision** — colliders (empty: the render ring), round
  the camera, its target and every player character, so a character walking
  far from the camera stands on built ground too (the simulation tells the
  page which terrain tiles its collision rings want, and the page reads them
  wherever its camera is: a co-op player or a detached camera's character
  is not left over a tile with no data; a tile still being read when a
  character reaches it has no collider for those frames); **scatter** — stored scatter
  drawn (empty: the render ring; by 2,048 m groups); **live** (block layers)
  — live blocks' objects in the game (empty: the collision ring);
  **hysteresis** — how far past a ring something loaded may be before it goes
  (empty: a tenth of each ring), so a camera at a ring's edge does not load
  and drop the same tiles. No `streaming`: everything loaded.
- **The overview**: a build (Play and the export) ships, for each streamed
  terrain, every tile at its coarsest level (17 × 17 samples, a few KB a
  tile) in one blob; the game draws it wherever a full tile is not resident,
  so the terrain reaches the horizon from the first frame. A tile coming in
  is drawn from the overview until its data are up, then replaces it in the
  same frame (the same vertices at that distance: no crack, no jump); a tile
  going is let go only once the overview draws its place. The editor never
  stores an overview.
- **Collision**: the simulation decides which tiles and chunks collide from
  its own state at each step (replays and the simulation worker do the
  same), its rings reaching a few metres further than asked (how far a
  source may move before it looks again), so a walking character's next
  tile is built before it gets there. New colliders are built nearest first,
  about one 257² tile or two chunks a step; a scene's first look builds all
  of its ring at once. Edits inside a ring collide at once. A
  terrain tile's colliders need its data on the page: the page reads the
  tiles in the render ring round the camera (and the collision ring's), so
  characters far from the camera may find a tile still waiting (counted in
  Play's diagnostics, `runtime.terrainMemory.waiting`).
- **Live blocks** of a streamed layer are in the game only within the live
  ring; at most 16 objects spawn a step for cells entering it (the rest the
  next steps), and they go when their chunk leaves it. A live block's lasting
  state belongs in its cell's metadata (as ever): an object that went and
  came back starts over.
- **The budget** (Project settings → Rendering → **Streaming budget**,
  `streaming_budget_mb`, default 768 MiB): the memory streamed tiles (decoded
  data and their texture layers), chunk meshes and scatter groups may take.
  When it is full, what is kept past a ring (within its hysteresis) is let go
  first, farthest first. What is inside a ring is never cut: rings that alone
  need more than the budget are reported once as a problem
  (`world_streaming_over_budget`: Play's Problems; the browser console in an
  export) and stay. There is no count cap on tiles or chunks.
- **Diagnostics** (Play, `tl_diagnostics`): `renderer.streaming` — the
  budget, resident bytes (and the most so far), per kind (`terrain-tile`,
  `block-chunk`, `scatter-group`) what is resident, in the rings, kept past
  them and let go for the budget, and the main-thread time spent deciding;
  `renderer.terrain.streamed` — tiles resident, the overview's tiles and
  those it draws, the render ring's reach; `runtime.worldStream` — the
  simulation's sources and the tiles and chunks in its collision and live
  rings and waiting to be built. Streamed cells are resources of the page's
  resource manager (`resources.resident['terrain-tile' | 'block-chunk' |
  'scatter-group']`), freed after the frame they were let go in.
- **Costs** (measured on this host's Iris Xe at 1080p, the level harness's
  `world` class: 8 × 8 km of 257-sample terrain, a square kilometre of block
  fields, `node tools/perf/run.mjs level --classes world --flight-plain`):
  a 60 s flight at 63 m/s streamed 81 tiles and 1,070 chunks in;
  resident 40–64 MiB of the 768 MiB budget (31 of 256 tiles); deciding what
  to hold 0.05 ms a frame (at most 0.7); tile uploads at most 2 ms a frame,
  chunk meshes swapped in at most 4.6 ms a frame (both spread over frames);
  one frame in 60 s missed a 60 Hz refresh on each renderer (a dense scatter
  group of 42,000 copies entering the scatter ring, made on the page in one
  frame).
- **Best practice**: size the render ring to what the fog lets you see and
  the collision ring to how far characters move in a second or two plus a
  tile; keep scatter groups light (density falloff, impostors) where the
  camera moves fast; one terrain per landscape (each streams on its own).
