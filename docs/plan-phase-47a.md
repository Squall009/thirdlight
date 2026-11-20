# Phase 47a — Structures and water bodies

Status: **the item list, its order, the seven format entries and the five defaults were approved by the owner on 2026-11-20** ("Everything as proposed is fine"); one question on how a structure is defined is open (§10, 47a.3 waits for its answer). Building started with 47a.0.
Branch `phase-45` (worktree `~/projects/thirdlight-p45`); start commit b5093d11 (the handoff's commit, for
`tools/gate.sh start phase b5093d11` at the close). Planned from `docs/roadmap.md` (voxel order, item 3), plan 45
§1b, §1d, §1e and its 47a line, requirements R30–R45 (`docs/architecture/voxel-format-requirements.md`),
`docs/architecture/voxel-engine.md` §6 (foundation 5), `docs/research/water.md`,
`docs/research/derived-fields-and-shared-tools.md` and `docs/briefs/handoff-47a.md`. The format proposals are in
`docs/briefs/proposal-47a-formats.md`.

## 1. Scope

- **In:** foundation 5, *regenerated structures*: a definition → voxels + hand-edit overrides, one regenerate step.
  Three users of it:
  - **buildings**: a structure object with footprint, storeys, roof, materials and openings, on its own 0.5 m grid at
    any yaw; material swap, copy and paste, scale in 0.5 m steps, extend, drag up, hand edits kept as overrides;
    openings with door and window props whose open or shut is portal state; one static body a structure; the walk
    graph per grid, stitched at doors and foundations; light, rooms and rays seeing each grid;
  - **splines** for roads, paths and rivers that write voxels and are written again when they change;
  - **water bodies**: a definition (seed, level, liquid material) whose liquid voxels are written again when the
    ground in its reach is edited, in the editor only, bounded, flagged when breached, with a plain liquid look.
- **In, carried defects:** D740, D735, D736, D727, D728, D729 (watch), D741 (placement is question 1).
- **Out, with the phase that takes it:** the world edit mode on the brush kit, the height-based fill as a brush
  stroke, the fog role, dressing, scatter and vegetation rules (47b); the world map, MCP docs and the manual's
  chapter (47c); converters and the retirement of block layers, heightfield terrain, generated architecture and
  `terrain-splines.ts` (48); the liquid derive with flow, the surface shader, far water, queries and buoyancy, the
  run-time settle (49). Nothing inside block layers, heightfield terrain or generated architecture is touched.
  WebGL 2 keeps what it draws.
- **Open and decided, not to be "fixed":** rooms under cut-away stay dark (D737); no minimum brightness indoors.

## 2. Owner requirements (quoted; REQUIREMENTS, never silently dropped)

- Roadmap item 3: "Regenerated structures (a definition → voxels + overrides) for buildings and for road, path and
  river splines; water bodies as definitions (seed, level, liquid material) whose liquid voxels are regenerated when
  the ground in their reach is edited, in the editor only, bounded and flagged when breached, with a plain liquid
  look; the regenerate step is what a later run-time settle calls."
- 2026-11-12: "I want to be able to edit in the world tools and have the shoreline updated, not see a wall of water
  that I then have to refill with the water tools."
- Plan 45 §1b: "You pick a material, draw the layout (footprint), and place windows and doors. The tool writes the
  voxels and roles." "The building stays an editable structure (a source definition), not loose voxels." Change the
  material, copy and paste, scale "in 0.5 m steps. It never stretches pieces", extend, "drag upward for another
  floor". "Hand edits on top are kept as overrides… Regenerating keeps the overrides that still fit the new shape
  and reports the ones that don't." "Structures are authoring-time objects. Exports ship the resolved voxels."
  "Doors and windows use the portal state, not voxels."
- Plan 45 §1e: "Every structure owns a local 0.5 m voxel grid, anchored by its foundation", any yaw, floors level.
  "Two grids at different angles never merge voxels." "Exports keep structures as voxel objects with transforms.
  They are never resampled into the world grid." "47a measures the same houses aligned in the world grid and in
  their own rotated grids (30°, 45°)."
- Plan 45 §1d: "Doors, windows and glass are props, not trim… placed into the opening automatically, picked by
  opening size… A door prop drives its portal's open/shut state."
- R30–R35 (structure, material swap, overrides, generator upgrades apply to every structure with one undoable
  regenerate-all step, authoring-time only), R36–R39 (own grid, exports keep grids), R40 ("Collision is one static
  body per structure; walk graph per grid stitched at doors/foundations; tracer steps each grid in its own space"),
  R41 ("Water bodies… are structure objects until export; resolve order ground → buildings → water"), R45.
- R93 with D741: "each voxel stores a coverage fraction rather than solid/empty: a tree canopy might block 30 %".
- 2026-11-12: voxels are the single source of truth; one undo path; name the foundation first. 2026-11-10: WebGPU
  first, the low tier at 720p capped at 30 Hz. 2026-11-11: hobby pace, gates by affected area.

## 3. What exists (survey of 2026-11-20)

- **Grids.** Region files carry a grid id (`voxel/src/region-file.ts`, `WORLD_GRID_ID` 0); the streamer, its
  mips, collision, sections, seams and overlay, `RegionChunkSource`, `EditGrids.store(gridId)`, the edit command
  (`{v: 2, grid}`), `saveChunkOf` and `RegionWorld` all take one. **Every caller passes 0**: `workspace/src/
  voxel-worlds.ts` (manifest, writes, `openShippedWorld`), `voxel-far-cache.ts`, `voxel-far-fine.ts`,
  `editor/src/voxel-world/range-world.ts`. The manifest (`world.json`, format 2) lists the world grid's regions
  only. **No transform exists anywhere**: chunk bodies are added with an identity rotation
  (`runtime/src/voxel-world-host.ts` `PortBodies`, though the physics port takes one), the Scene view puts cell 0
  at the origin. A project may hold several worlds, but `ctx.voxels` answers from the first.
- **Rotated test grids** exist as bench data only: `tools/voxel-bench/town.ts` makes the lots with yaw 30° and 45°
  as extra `TestGrid`s (`world-kit.ts` `yawDeg`, `originM`); only storage measurements read them.
- **A house generator** exists as a bench function: `town.ts` `houseVoxel(h, x, y, z, out)`, pure a cell: foundation,
  walls, `opening` cells for doors and windows, stairs, floors with a stair hole, beams, a balcony, a 45° roof with
  an overhang. There is no generator in `packages/` and no authoring package.
- **Overrides**: `voxel/src/structure-overrides.ts` (`TLVO` v2: `overridesOf`, `reapplyOverrides`, encode, decode;
  the fit rule absorbed / kept / misfit) is in the approved format spec §3.5 and has tests but no user.
- **The cross-grid contract** is an open gap of the spec (§3.6, review M7 of 45): keys by (grid id, chunk),
  read-only occupancy strips of other grids resampled into a job's frame, edit boxes moved into each grid's frame.
- **The old architecture component** (`project-model/src/architecture.ts`: outlines, openings, roofs flat, gable,
  hip, mansard; the editor's `room-tool.ts`, `room-draw.ts`) writes its own meshes and retires in 48. Its
  definition shape and handles are the pattern; none of its code is extended.
- **Splines**: the `spline` component (`project-model/src/spline.ts`: points with width and roll, `terrain`
  flatten, carve or raise, `mesh` surface or water), `spline-curve.ts`, the editor's `spline-handle.ts`,
  `runtime/src/splines.ts`. They shape heightfield terrain (`terrain-splines.ts`, `commands/src/
  terrain-spline-ops.ts`) and sweep meshes; **no spline code names voxels**.
- **Edits**: `editVoxels` strokes (`voxel/src/edit-command.ts`: brush, fill, stamp, set, dig) applied by
  `edit-apply.ts`, the backend's `VoxelWorlds.apply` (`workspace/src/voxel-worlds.ts`), one undo line
  (`undo-timeline.ts`). Many commands as one undoable stroke exist as `writeScene` (the `writeKitTestScene` op). A
  `set` writes one value to its cells; the undo budget is 64 MiB a stroke.
- **Liquid**: role 2, shape the fill level; open for the mesher, collision, navigation and light; skipped by the far
  bricks; lost from the 2 m mip up beside ground. **Nothing draws it.** A change of role or shape feeds mesh,
  collision, nav, light and shader data (`record.ts` `FIELD_FEEDS`), so an air ↔ liquid edit re-derives all five.
  Lakes in the test worlds are written at generation (`world-kit.ts` `fillGroundColumn`). There is no flood over
  voxel cells bounded by a level.
- **Regions and portals**: `open-regions.ts`, `open-region-stitch.ts` (`regionAt`, `portalsOf`); an `opening` cell
  is a portal. **No open or shut state exists** for a voxel portal; the old stack's (`room-culling.ts`
  `portalOpen`, `surface-rooms.ts`) reads block edges and retires.
- **Props in the light**: `prop-channel.ts` (`PropLightChannel`), `walk-sources.ts` `propStopView`; a model's
  `affectsLighting`. Thin props stop nothing (D727); a mover re-packs a walk block (D728).
- **The walk graph**: `walk-graph-cells.ts`, `walk-graph.ts`, `walk-graph-queries.ts`: one grid, exits between
  chunks of that grid, a walker one cell wide (D735), no doors.
- **The editor**: voxels are edited only on the voxel world page (`editor/src/voxel-world/page.ts`: dig, add,
  undo). The Scene view draws voxel worlds read-only (`viewport/scene-voxels.ts`). The edit-mode shell
  (`ui/editmode/`) has the modes prefab, terrain, block, vertex paint and decal; no voxel mode (47b's).

## 3a. three.js check

2026-11-20 (the lead): `npm view three version` gave 0.187.0, equal to the pin in
`packages/three-adapter/package.json`. Nothing to assess; no update.

## 4. Budgets and how each item is judged

Low tier, WebGPU, 1280 × 720, the 30 Hz cap, each run alone, committed built code, A B A B in the same hour
(`docs/briefs/handoff-46e-b.md`, "How lighting items are measured"). Budgets from `FRAME_BUDGET_BY_TIER` and
`MEMORY_BUDGET_BY_TIER`; a new memory use gets a table entry, a tuned constant becomes a tier setting. Targets are
soft: a miss is recorded with its cause.

| What | Judged by |
|---|---|
| Every item that touches a lit program or the default path | the town orbit and `run.mjs headroom --quality low --lamps 128` against the item before it; one coverage round at 150 m/s if it adds per-frame work |
| Rotated grids (47a.1) | the same houses in the world grid and in their own grids at 0°, 30° and 45°: room in the frame, GPU near and lighting, page and simulation ms, memory rows, bodies and contacts, pictures of each house's light (leaks looked for), paths through the doors |
| A regenerate | time and bytes for one house, for the town's 19 houses at once, for 1 km of road, for a lake of 250 m; the result equal to the same definition generated fresh; undo and redo exact |
| Water after a ground edit | the time from the stroke to the shore redrawn (aim: under 0.5 s for a brush dab on a 250 m lake); never a wall of water after a dig inside a body's reach; a breach flagged, not spilled |
| Editor work | a Playwright test on the real page against a real backend; a picture someone looked at |
| Play | the leak test (`gate.sh start area play`) for anything that adds a worker, buffer or texture |

## 5. Where things live (reuse first; never copy)

| Thing | Home | Reuse |
|---|---|---|
| The structure core: the generator contract, regenerate, override capture | `@thirdlight/voxel` (a `structures/` folder) | `structure-overrides.ts`, `cell-delta.ts`, `edit-apply.ts`'s grids and undo records |
| The building generator | `@thirdlight/voxel` `structures/` | the bench's `houseVoxel` is the pattern; the bench then calls the package's |
| Structure, water body and spline records | `project-model` (components with descriptors, so the Inspector and handles are the generic ones) | `voxel-world.ts`, `spline.ts`, the descriptor machinery; `architecture.ts` read as a pattern only |
| Regenerate as a command | `commands` (ops), `workspace/src/voxel-worlds.ts` | `writeScene`'s many-commands-one-stroke, `undo-timeline.ts`, the staged write |
| Grids of a world | `workspace` (manifest), `voxel` (`voxel-streamer.ts` already takes a grid id), `runtime/src/voxel-world-host.ts`, `three-adapter` `voxel-chunk-view.ts` | the per-grid parameters that exist; the physics port's rotation; the culled-instance table for kit pieces |
| Cross-grid reads | `@thirdlight/voxel` | spec §3.6's contract; `occupancy-walk.ts`; `prop-channel.ts` if 47a.1 chooses stamps |
| Portal state | `@thirdlight/voxel` (`open-region-stitch.ts`, `prop-channel.ts`, the walk graph), `runtime` (`ctx.voxels`) | regions' portals, the prop channel's recombine |
| The level fill | `@thirdlight/voxel` (one pure function) | `open-regions.ts`' labelling walk; 47b's fill stroke and a later settle call the same function |
| The plain liquid look | `@thirdlight/voxel` derive (a liquid part), `three-adapter` `voxel-chunk-view.ts` | the derive job and its parts, the surface batches |
| Splines to voxels | `@thirdlight/voxel` (generator), `project-model` (`spline.ts` sections) | `spline-curve.ts`, `terrain-splines.ts` `rasterizeSpline` as the pattern |
| The structure edit mode | `editor/src/ui/editmode` (a mode), `editor/src/viewport` | the edit-mode shell, `spline-handle.ts`, the asset pickers, the voxel page's dig and add |
| Time slices and budgets | `shared` `frame-arbiter.ts`, `project-model` tables | no new constant |

## 6. Items (the contract; status goes in §7)

Order: by dependency. An item that stores something waits for the owner's note on its entry (§8); when a note is
missing the lead takes the next item whose notes are in, and says so in §9.

| Item | Builds | Needs |
|---|---|---|
| 47a.0 | **Start.** The baseline on the low tier (town orbit off and default, 128 lamps, one coverage round at 150 m/s); the "47a" section of the agents' brief; **D740** in a 2 h box: the generated WGSL of the surface programs at 481e0491 and at the head compared, `?surfaceRead=index` and `level0` A B. Fixed if the cause is local, else the row says what was ruled out. | — |
| 47a.1 | **Rotated grids, measured first.** The town's houses three ways: in the world grid (today), and each in its own grid at 0°, and at 30° and 45°. (a) A world holds more than one grid, each with a place and a yaw, streamed, meshed, drawn with its kit pieces and collided as one static body (bench data; nothing a project stores). (b) Light: the volume's rays, the sun heights and the regions with two candidates, each grid stepped in its own space against the grid stamped into the world's coverage, with pictures of each house looked at for leaks. (c) The walk graph across the seam at a door and a foundation. (d) The far field. Reported: frame, memory, bodies, light, paths, and a recommendation. **The answer may change 47a.5 and 47a.8**; it goes to the owner as a short page and the run goes on with what it does not affect. | — |
| 47a.2 | **The format proposals** F1–F7 (§8), published with this plan. The owner's notes are recorded in the register and the proposal as they arrive; each approved entry goes into its spec in the commit that builds it. | the owner |
| 47a.3 | **The structure core.** A generator is a pure function of a definition, a chunk at a time; **regenerate** writes what it makes, reapplies the overrides by the fit rule and reports misfits; hand edits on a structure are captured as overrides when they are made; a generator's version is kept so "regenerate all" is one undoable step (R34). The building generator: footprint polygons on the 0.5 m grid, storeys and storey height, foundation, roof (flat, gable, hip), a material a part, openings by wall and size, stairs between storeys. Tests in Node: fresh = regenerated, the same house by `fill` commands derives the same, the fit rule on a real generator. | F1, F3 |
| 47a.4 | **Structures through the commands.** The structure component and its grid in the world's manifest; a change of the definition regenerates in the backend as one undo step with the scene edit; create, delete, duplicate (copy and paste: a new grid, voxels and overrides copied), material swap (only material ids change); the editor and MCP send the same commands; an export ships the resolved grids with their transforms and no definitions or overrides. | F1–F3, 47a.3 |
| 47a.5 | **Grids where the world runs,** as 47a.1 decided: every grid of a world streamed and drawn in Play, exports and the Scene view, one static body a structure, `ctx.voxels` reads and rays, edits and saves reaching the grid a point lies in, light, sun heights, rooms and the far field seeing structures. The cross-grid contract of spec §3.6 written as built. | F2, 47a.1 |
| 47a.6 | **The structure mode in the editor.** A full-screen mode on the Scene view: draw a footprint, handles for scale (0.5 m steps), extend (a second polygon), drag up (a storey), move and turn; roof and materials in the Inspector; dig, add and paint on the structure as hand edits; the misfit report after a regenerate, each misfit shown where it was. A Playwright test makes a house, edits it, grows it and undoes all of it. **The interim look page for the owner follows this item.** | 47a.4, 47a.5 |
| 47a.7 | **Openings, doors and windows.** The mode places openings on a wall in standard sizes; the opening's prop (leaf, pane, shutter) is put in by size and follows the structure. A prop's **portal state** (open, shut; what it stops: light, sight, walkers) closes its portal exactly and at once: the portal's cells stop light while shut (D727: the leaf's thickness no longer matters; D728: a door costs a flip, not a stamp every ⅛ m), `portalsOf` says it, `ctx` sets it. Glass passes light. | F4, 47a.5 |
| 47a.8 | **The walk graph with structures.** Clearance over a footprint of columns so an ordinary humanoid (radius 0.3–0.4 m) is answered truly and passes a 1 m door (D735); a query waits for the chunks it reads to be current (D736); a shut door is an edge a query may or may not take; a graph a grid, stitched where a structure's standable cells meet the world's (doorsteps, foundations) (R40). | 47a.5, 47a.7 |
| 47a.9 | **Liquid: narrowed feeds and a plain look.** An air ↔ liquid change feeds a liquid part alone (no mesh, collision, nav or light derive); the liquid part is the liquid's faces against air, drawn flat in the material's colour inside the detail ring. Measured: derives after a liquid edit before and after. | F7 |
| 47a.10 | **Water bodies.** The level fill as one pure function (from a seed through non-solid cells, never above the level, bounded; the top cells take the partial fill; it reports where it leaves its bound). The water body component (seed, level, liquid material, reach); in the editor's backend a stroke or a regenerate inside a body's reach writes the body's liquid again in the same undo step, locally where it can; a breach is flagged on the object and drawn at its place, never spilled; order ground → buildings → water. | F6, 47a.9 |
| 47a.11 | **Splines write voxels.** Road and path sections (material, width, bed, shoulders) and river sections (width, depth, liquid material) on the `spline` component; a changed spline puts back what it replaced and writes again, as one undo step; a river meeting a body writes down to its level; hand edits on a road kept by the same fit rule. The heightfield path is left as it is (48). | F5, 47a.3, 47a.9 |
| 47a.12 | **Light through partial cells (D741),** if the owner places it here (question 1): a ray carries what is left after each partly covered cell, on the CPU walk and its WGSL twin; cost on the town with trees; a tier setting if it does not fit. | question 1 |
| 47a.13 | **Close.** The phase gate once, an independent review, fixes, the end-of-phase reading against 47a.0, the design page, the acceptance page `acc47a` with at most five questions. **Stop. 47b is not begun.** | all |

## 7. Progress

| Item | Status |
|---|---|
| 47a.0 | not started |
| 47a.1 | not started |
| 47a.2 | Proposed 2026-11-20 (f385e584, page `plan47a`); **owner's note 2026-11-20: F1–F7 approved as proposed**; the owner's question on piece-defined structures is open (§10): F1 may gain an add-only piece list, so 47a.3 waits for the answer |
| 47a.3 | not started |
| 47a.4 | not started |
| 47a.5 | not started |
| 47a.6 | not started |
| 47a.7 | not started |
| 47a.8 | not started |
| 47a.9 | not started |
| 47a.10 | not started |
| 47a.11 | not started |
| 47a.12 | not started |
| 47a.13 | not started |

## 8. Format and spec steps (owner stops)

Each is an add-only entry, proposed in `docs/briefs/proposal-47a-formats.md` with what a designer sets, what is
stored and a mock. **Nothing of an entry is built before the owner's note on it.** A note relayed by another
session is recorded as relayed and confirmed at the next page.

| Entry | What it adds | Where | Needed by |
|---|---|---|---|
| F1 | The structure record: a `voxelStructure` component (the building's definition) | project schema, add-only | 47a.3, 47a.4 |
| F2 | A structure's grid: the grid list in the world manifest (format 3), the transform on the object, the anchor rule | `voxel-format-spec.md` §2.1, §3.2 | 47a.4, 47a.5 |
| F3 | Overrides: `TLVO` v2 as it stands in spec §3.5 goes from draft to used; where its file lives; the generator version | spec §3.5, `format-versions.md` | 47a.3 |
| F4 | Opening props and portal state: a `voxelPortal` component on the prop; an opening's prop in the definition | project schema, add-only | 47a.7 |
| F5 | Spline sections that write voxels, and the record of what a world-grid structure replaced | project schema; spec §3.5 | 47a.11 |
| F6 | The water body record: a `waterBody` component | project schema, add-only | 47a.10 |
| F7 | Narrowed feeds for liquid edits and the liquid part (derived, never stored) | spec §2.2 feeds table, §3.7 | 47a.9 |

No change to the voxel value (32 bits), the chunk codec, the region file's bytes, the edit command, the undo
record, the save file, the far cache, the render, role or kit specs is planned. One that turns out to be needed is
a stop.

## 8a. Results

(Each item's results go here as it closes.)

## 9. Decision log

- 2026-11-20 (the lead, planning; default chosen, owner to confirm): **a structure is a scene object** with a
  `voxelStructure` component, in the scene of its voxel world; its transform is the object's place and yaw. Not a
  list inside the world's manifest: principle 2 (everything that affects the game is an object in the editor), and
  select, move, duplicate, delete, undo and prefabs then work as for any object.
- 2026-11-20 (default chosen, owner to confirm): **one structure = one grid.** Extending a building adds a polygon
  to its structure; a new structure at another angle is a new grid; two structures never share a grid in 47a
  (plan 45 §1e's "building next to an existing foundation joins its grid" is met by extending).
- 2026-11-20 (default chosen, owner to confirm): **water is ordered before splines** and after the first look at a
  structure, so the owner's shoreline wish is met early; rivers need the liquid look (47a.9) and the fill.
- 2026-11-20 (default chosen, owner to confirm): **a building does not change the ground under it** in 47a
  (question 4); **hand edits on a structure are dig, add and paint** in its mode, the full brush kit comes with
  47b's world edit mode (question 5).
- 2026-11-20 (**owner**): "Everything as proposed is fine": the item list and order (§6), the entries F1–F7 (§8) and
  the five defaults (§10) stand. The owner asked whether structures are defined by simple shapes that dictate the
  voxel fill, as in Enshrouded (a wall is a box; a wall with a window is the same box with a cut-out), and whether
  that is how edits are preserved. Answered by the lead (§10, "The owner's question"); 47a.0 and 47a.1 do not
  depend on the answer and start now.
- 2026-11-20: the measurement (47a.1) is built on bench data and the draft formats only; what it adds to
  `packages/` is the per-grid plumbing 47a.5 keeps if the design stands.

## 10. Open questions for the owner (five, each with the default that stands if unanswered)

1. **Where does light through partial cells (D741) go?** It first shows on panes, shutters and, later, trees.
   47a's doors do not need it (a shut door stops light whole by its portal state; glass passes it whole).
   Options: the last build item of 47a (47a.12); or a lighting item before vegetation (50). **Default: 47a.12,
   and it is the first thing cut if 47a runs long.**
2. **Rotated buildings and soft light.** If stepping each grid in its own space costs too much on the Iris Xe,
   may a rotated building's light, rooms and sun shade be taken from a stamp of it in the world grid (off by up to
   a cell; what you see and collide with stays exact)? **Default: the lead chooses by 47a.1's numbers and
   pictures and shows you the page; exact where it is affordable.**
3. **Water is drawn only near you until phase 49.** The plain look covers the detail ring (about 45 m on low,
   64 m on medium); past it a lake's bed shows dry, because far water needs the far cache's liquid channel (49).
   **Default: accept it for 47a.**
4. **The ground under a building.** A house on a slope has ground coming through its floor uphill until you dig
   it. Options: leave the ground alone and give the foundation a depth (the designer levels the site); or let a
   building clear and fill its site itself, put back when it moves. **Default: leave the ground alone in 47a.**
5. **Hand edits before the world edit mode exists.** 47a gives dig, add and paint on a selected structure; the
   full brushes arrive with 47b. **Default: accept.**

### Answered 2026-11-20

All five defaults stand (owner: "Everything as proposed is fine"): D741 is 47a.12 and the first thing cut; the lead
chooses the rotated buildings' light by 47a.1's numbers and shows the page; water is drawn near only until 49; a
building leaves the ground alone; hand edits are dig, add and paint until 47b.

### The owner's question (2026-11-20), open

"In Enshrouded, structures are defined by simple mesh geometry that dictates voxel fill. Is that the plan here as
well? … Is that how we are preserving the edits or some other planned way?" As planned: no. A structure is defined
by its outline and numbers (F1), the generator fills the whole building from them, and hand edits are kept as a
per-cell delta over what the generator makes (F3). The lead's offer: an add-only `pieces` list on F1 (boxes that
add or cut, each with a role and a material, replayed in order after the outline), so a building can also be made
and changed wall by wall. **Default if unanswered: as proposed, no piece list.**
