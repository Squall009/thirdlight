# Phase 47a — Structures and water bodies

Status: **the item list, its order, the seven format entries and the five defaults were approved by the owner on 2026-11-20** ("Everything as proposed is fine"); the owner's question on piece-defined structures was answered with an offer and its default (no piece list) stands (§9, 2026-11-22). 47a.0 and 47a.1 are done.
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
| 47a.0 | Done 2026-11-21 (docs only, no gate): baseline at 58fac9ba (§8a; page ms at 128 lamps +2 ms against 46e.19, the 128-lamp room unusable). D740 not fixed: the surface WGSL equal in loads, samples, loops; `level0` equal at both commits, so the extra is the coarse levels' read meeting other data; D740 rewritten |
| 47a.1 | (a) done (0980318c…42363e34). (b) done (3627dc6b, 06ecc288): stamp (share), rooms 24/24; D746, D747. (c) done (fe397a85, 5db10a23): a walk graph a grid linked at doorsteps, on: every room and storey at 0/30/45°, no cell in a wall; the stamp alone loses 4–7 stair tops; D748, D749. (d) done 2026-11-22 (654fae78): grids resampled into the far build: the town at 250 m–2 km as W's; D750 |
| 47a.2 | Proposed 2026-11-20 (f385e584, page `plan47a`); **owner's note 2026-11-20: F1–F7 approved as proposed**; the owner's question on piece-defined structures is open (§10): F1 may gain an add-only piece list, so 47a.3 waits for the answer |
| 47a.3 | Done 2026-11-22 (68fbec87, b4ff1315): `@thirdlight/voxel` `structures/`: generator contract, F1 record + checks, building generator (union walls, 45° roofs, hip over the outline), regenerate (undo/redo, fit rule), capture, regenerate-all; town house = bench pattern but beams, landing; small house 1.4 ms, 131 houses 78 ms, regenerate with 1,000 overrides 30 ms; D751, D752 |
| 47a.4 | Done 2026-11-22 (4059d423): `voxelStructure` (F1), its grid written by the backend through the commands, one undo step with the scene edit; create (next grid, anchor), regenerate, copy, delete, material swap, hand edits as overrides, `regenerateStructures`; Play/export read places from the objects. Small house 20 ms, L 60–76 ms; +0.8–2.2 s with a far cache (D754); D753, D755 |
| 47a.5 | Done 2026-11-22. (a) 6be74d26, ef33ad6f, 6003c541: Scene view draws, moves, picks grids; `ctx.voxels` by grid; spec §3.6. (b) d41e0c49, 7b83e3a0, 471d16bb, 894fb4e0: grids planned at ring crossings (G30 sim 1.4–1.5 × W, base 1.8–1.9), stamp sliced, far rebuild after the answer (house 27 ms, was 832), fine bake reads grids; lane reserve backed out; D759, D760 |
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

### 47a.0 — the baseline

At **58fac9ba** (code equal to 760c2aa0, the 46e.19 reading's commit; rebuilt with `node tools/build.mjs` in the 10G
scope first), 2026-11-20 22:42–23:36 UTC, uptime 28.3 d, 1-minute load **1.5–4.3** (46e.19: 0.74–3.0; another
session's process was seen on the host during the runs); low, WebGPU, 1280 × 720, the 30 Hz cap, each run alone
(gate inactive, no build or other run, `*.uptime` beside each raw file), `measureGpu` readings only, the second rounds
read (as 46e.19). Work folder `~/.cache/thirdlight-phase47a/work/47a.0/` (`lib.sh` and `summ.py` from 46e.19-end's,
`baseline.sh`, `progress.txt`, `m/` every raw run with its `.log` and `.uptime`). Commands, each in the 10G scope:
`run.mjs headroom --quality low --rounds 2 [--query '&voxelLight=off']` off, default, then `--lamps 128` default, the
three twice interleaved (`O-{town-off,town-def,128-def}-r{1,2}.json`); `run.mjs coverage --export --keep-export
--quality low`, then with staging stopped `coverage --dir <export> --quality low --speed 150` (`G-def-r1.json`; the
export deleted after, `exports/` empty). The off runs are proven off: their rounds hold no volume state, the default
runs' do.

| | 47a.0 | 46e.19 end of phase | raw |
|---|---|---|---|
| orbit room, town off (copies × ms a copy) | 176 × 0.129, 176 × 0.126 | 176 × 0.127, 176 × 0.126 | `O-town-off-*` |
| orbit room, town default | 128 × 0.126, 120 × 0.113 | 128 × 0.129, 128 × 0.132 | `O-town-def-*` |
| orbit room, 128 lamps default | 88 × 0.050, **3 × 0.125** | 68 × 0.143, 68 × 0.142 | `O-128-def-*` |
| missed at no load (of 89): town off; default; 128 | 0, 0; 0, 0; 0, 0 | 0, 1; 0, 1; 0, 0 | |
| GPU `near`: town off; default; 128 | 2.35, 2.05; 3.47, 3.63; **7.70, 6.55** | 2.10, 1.89; 5.07, 4.77; 8.42, 9.24 | |
| GPU `far`: town default; 128 | 3.15, 3.54; 2.81, 3.81 | 2.82, below; 3.46, 3.07 | |
| GPU `lighting` (row 6.67): town default; 128 | 5.64, 5.68; 5.11, 4.19 | 4.98, 5.44; 5.25, 5.54 | |
| resolution of the GPU reading: town default; 128 | 2.20, 2.82; 1.07, 1.00 | — | |
| page ms a frame; `render`; `lighting` (of 2.0): town off | 5.39, 5.62; 4.83, 4.95; 0.06, 0.14 | 4.95, 5.22; 4.33, 4.52; 0.07, 0.07 | |
| the same, town default | **7.40**, 6.71; **5.63**, 5.17; 1.07, 1.00 | 5.83, 6.85; 4.48, 5.06; 0.88, 1.13 | |
| the same, 128 | **8.95, 8.73; 5.84, 5.84; 2.43, 2.34** | 6.90, 6.86; 4.40, 4.41; 2.01, 1.86 | |
| simulation `voxelStream` ms: town default; 128 | 2.42, 2.14; 2.24, 2.40 | 1.85, 2.13; 1.82, 1.69 | |
| page heap / GPU process MiB (low's 1,536 / 2,560): off; default; 128 | 596, 621 / 939, 927; 603, 563 / 966, 965; 696, 621 / 1,006, 1,091 | 612, 599 / 963, 961; 571, 607 / 1,013, 1,025; 608, 653 / 1,108, 1,061 | |
| light volume MB (town; 128) | 36.45; 36.51, 36.57 | 36.45; 36.57 | |
| lamp lists over (bricks); lamps dropped (128) | 31, **0**; 356, **0** | 31; 356 | |
| travel 150 m/s, export: longest ms; > 100; missed a minute | 60.4; 0; 18.3 | 48.6, 57.9; 0; 16.5, 11.0 | `G-def-r1` |
| … ground s; full detail s; nothing pending s | 0.03; **4.77; 9.33** | 0.03, 0.03; 4.21, 4.37; 8.59, 8.45 | |
| … falls (of 34 drops); holes | through 0, one `lower` (drop 14, events in the raw file); 0 / 1,970 | through 0, one `lower` (r1); 0 | |

**Different from 46e.19 by more than its spread:** (1) **page ms a frame at 128 lamps, +1.9–2.1 ms** (8.95, 8.73
against 6.90, 6.86; `render` +1.4, `lighting` +0.4–0.5), and the town default's first run +1.6 ms (`render` +1.2);
the off runs +0.4. (2) The **128-lamp room readings are not usable**: the first run's ballast measured 0.050 ms a copy
(every other run 0.11–0.15), the second's edge search stopped at 3 copies after one window missed 3 of 89 frames at 4.
(3) The second 128-lamp run's lamp lists were never over (0 bricks, 0 lamps dropped; `mostReaching` 30 against 59)
with the same 112 lamps placed: not explained. (4) Travel: full detail 4.77 s and nothing pending 9.33 s against
4.2–4.4 and 8.5–8.6 (one run; 46e.19's two runs were 0.15 s apart). GPU `near` at the town default is 1.1–1.6 ms
lower and at 128 lamps 0.7–2.7 lower, but this hour's resolution at the town is 2.2–2.8 ms: not resolved. The
host's load was higher than in 46e.19's hour (above); that is recorded, not offered as the cause. Memory is within
the budget and equal to 46e.19's within its own spread.

### 47a.0 — D740

In a 2 h box (2026-11-20 23:36 – 2026-11-21 01:36 UTC; the work ended 00:55), at 58fac9ba against 481e0491, the
`--lamps 128` orbit, low, the same conditions as the baseline (load 0.8–4.0). 481e0491 built with `node tools/build.mjs`
in a scratch worktree with its own `@thirdlight` links (near128's `mkbase.sh`; `tlSunCovered` absent from its bundle,
present in the head's), served by staging from it, the head's bench driving both; the worktree removed after.

**The generated WGSL.** A scratch bench (`wgsl-dump.ts`, never committed: headroom's set-up and Play, with an init
script wrapping `GPUDevice.prototype.createShaderModule` so every module's code the page makes is kept; no product
change) dumped every module after 60 s of the 128-lamp orbit: 116 at 481e0491, 112 at the head. The voxel surface's
fragment program (the module with the `texture_3d` material grid and the read's `tlVolume*` variables) and its
vertex program, kit pieces' program and the second surface variant, copied to `wgsl-diff/` (`surface-481e0491.wgsl`,
`surface-head.wgsl`, `surface-vert-*.wgsl`, `kit-*.wgsl`, `surface2-*.wgsl`; `*.norm.diff` the diffs with the
generated names numbered out):

| surface fragment | bytes | lines | `textureLoad` | `textureSample` | loops | `if` |
|---|---|---|---|---|---|---|
| 481e0491 | 149,984 | 5,321 | 91 | 40 | 5 | 314 |
| head | 147,869 | 5,316 | 91 | 40 | 5 | 316 |
| head, `?surfaceRead=index` | 132,627 | 4,725 | 76 | 40 | 5 | 271 |
| head, `?surfaceRead=level0` | 125,836 | 4,622 | 76 | 40 | 2 | 268 |

The volume read's code is the same text at both (180 `tlVolume` names each, no line of it differs). What differs: the
ORM's projection-weighted blend is computed once at the head where 481e0491 repeated it in eight branches (`toVar` in
`textureSetAt`: less work, not more); the glow mask multiply; the indoor cover (`tlSunCovered`: one more interpolant,
one storage-buffer read a vertex, a `mix` with the indoor share). Kit pieces: 63 loads, 27 samples, 5 loops at both;
only the indoor cover differs. **No local cause in the program**: no duplicated read, no read moved out of a shared
node, no uniform turned into a per-pixel load. The two flag dumps prove the flags reach Play's programs (`index`: the
15 face loads gone; `level0`: the three coarse levels' loops gone).

**A B A B at the head, then 481e0491 in the same hour** (second rounds; `A-{def,index,level0}-r{1,2}.json`,
`B481-{level0,def}.json`):

| `--lamps 128` | GPU `near` ms | room (copies) |
|---|---|---|
| head, default | 8.40, 7.95 | 68, 80 |
| head, `surfaceRead=index` (no face loads, no decode) | 7.77, 8.24 | 76, 68 |
| head, `surfaceRead=level0` (level 0 alone) | no reading (r1: the ballast never passed the cap; its round 0 4.94), 5.99 (round 0 5.77) | 112, 112 |
| 481e0491, `level0` | 5.46 (round 0 5.17) | 128 |
| 481e0491, default | 7.00 (round 0 6.54) | 88 |

Read: the face loads and their decode cost nothing measurable (`index` = default). With level 0 alone the head and
481e0491 read the same (5.5–6.0 against 5.2–5.5, inside the 1–2.5 ms spread of a reading) and near the read-off 4.1 of
46e.19: **the head's extra is in the coarse levels' read** (levels 1–3: their window test, index loads and loops),
about 2.0–2.5 ms at the head against about 1.5 ms at 481e0491 this hour. Since that code is the same text at both,
what differs is how many pixels go on to the coarse levels (level 0 leaving more than `VOLUME_LEFT_MIN` of its weight)
or how many find coarse bricks: the data, not the program. This hour's gap between the commits' defaults is 1.0–1.9 ms
(7.95–8.40 against 6.54–7.00), smaller than 46e.19's 2.4 (481e0491 read 5.0–6.5 then). **Not fixed; nothing changed
in the product**; no gate (docs only). D740 rewritten with what is ruled out and the next step (a count, per pixel or
by a page counter, of the pixels that read each coarse level at both commits).

### 47a.1a — several grids in one world, drawn and solid

**Built** (0980318c, 185114b6, b565d54f; F2 as approved). The world manifest is format 3: `grids: [{ id, regions }]`
sorted by id, each grid's files in `grid-<id>/`, a listed file missing or of another grid damaged; format 2 reads as no
grids (add-only step). The backend serves a grid's files by range (`…/voxels/<world>/grids/<id>/regions/<file>`, editor
API and Play's locator) and lists their tags in the world's info. Where a grid stands is NOT stored: Play takes the
placements as one host option, `VoxelWorldConnection.grids` (`{ gridId, position, yawRad }` with the grid's source and
the chunks its files hold), which the presentation (`presentVoxelWorlds`) makes from the page's `?voxelGrids=` bench
switch until structure objects (47a.4) feed it. Per grid (runtime `voxel-grid-host.ts`, voxel `grid-place.ts`): its own
streamer (`worldStreamer` with `gridId`, the world's pool and job ids, an `extent`: the box of the chunks its region
tables name plus two chunks of air, so it never reads the empty load ring round it), the foci moved into its frame
(`GridFrame`), its own draw batches carrying where it stands; the page hangs its chunk view under a root at its position
turned by its yaw (surfaces, kit pieces, shadow casters reported where they stand), the GPU culler's piece spheres turned
with it; one compound static body a grid, built again at the end of the task a chunk's body changed in. Fixes found on
the way: a section waiting on a chunk past the extent waits for one never coming (`VoxelStreamer` `coming`), and row
neighbours of a read are clipped to the extent. The world grid alone is as before: the same fill on the orbit (158
chunks, 280,349 triangles, 8,686 kit instances at both commits) and the A B below.

**Bench** (`run.mjs town-grids --variant w|g0|g30|g45|restore`, staging stopped): the 8 km world's town four ways from the
same lots: W all 131 houses in the world grid at yaw 0 (the 11 turned lots of the storage benches included), G0 each in
its own grid at the same cells, G30 and G45 turned about their footprints' middles; ground, fences and ponds in the
world grid always. Only the town's four region columns of the world grid and the grids' folders are written, the
manifest keeps revision 0, so the far cache built for the world as first written stays current (it draws that town past
the mesh rings in every variant: aligned houses, turned lots empty). Placements go to the benches as `--query` (the JSON's
`query`, 3.4 kB). Anchor (F2): cell (0, 0, 0) at the minimum corner of the house's plan box (eaves, beams and balcony
included) at its foundation's row: **every house is one region file, 347–562 bytes (mean 427), 1–2 stored chunks**.

**Measured** 2026-11-21 04:30–06:18 UTC at 185114b6 (b565d54f's bench snapshot for the variants), low, WebGPU, 1280 × 720,
the 30 Hz cap, each run alone (`uptime` beside each, 1-minute load 0.9–2.5), `run.mjs headroom --quality low --rounds 2`,
second rounds read, two runs interleaved per variant (W G0 G30 G45, W G0 G30 G45). Work folder
`~/.cache/thirdlight-phase47a/work/47a.1a/` (`measure.sh`, `lib.sh`, `summ1a.py`, `m/` every raw run). The world-only A B
(head, base 0980318c built in a scratch worktree, the bench files with no placements): room 128, 128 against 128, 136;
GPU `near` 3.56, 4.05 against 4.27, 3.77; page ms 3.79, 3.87 against 4.39, 4.52 (lower at the head: not resolved); sim
2.17, 2.13 against 2.19, 2.31.

| town orbit, two runs | W | G0 | G30 | G45 |
|---|---|---|---|---|
| room (copies) | 128, 128 | −1, −1 (misses 7/89, 7/88 at no load) | −1, −1 (4/89, 3/89) | −1, −1 (4/89, 8/89) |
| GPU near / far / lighting ms | 5.27, 4.56 / 4.04, 2.82 / 4.71, 5.08 | below, 4.83 / below, 4.01 / below, 4.98 | 5.97, 5.90 / 2.76, 3.44 / 4.58, 4.59 | 5.98, 7.61 / 3.39, 4.49 / 4.57, 4.74 |
| page ms a frame; `render` | 6.49, 5.77; 4.78, 4.49 | 15.80, 16.14; 13.32, 13.84 | 15.24, 15.00; 13.14, 12.85 | 15.85, 16.56; 13.73, 14.21 |
| simulation ms a frame (`voxelStream`) | 2.22, 2.13 (1.80, 1.76) | 132.5, 132.2 (130.5, 130.1) | 142.3, 135.2 (140.1, 133.2) | 133.7, 128.7 (132.0, 126.8) |
| draw calls; triangles (a frame) | 80, 80; 117 k | 647, 589; 420 k, 396 k | 640, 679; 441 k, 464 k | 1,403, 632; 991 k, 436 k |
| grid draws: piece draws; kit instances | — (world: 49; 38,883) | 1,045, 907; 37.8 k, 34.2 k | 1,017, 1,057; 38.1 k, 39.4 k | 1,233, 1,050; 44.3 k, 39.0 k |
| page heap / GPU MiB | 602, 637 / 1,023, 1,038 | 661, 611 / 1,309, 1,221 | 671, 626 / 1,477, 1,250 | 608, 684 / 1,400, 1,481 |
| voxel streaming: world grid; grids (bytes a grid) | 69.5, 69.0 MB | 0.72 MB; 60.7, 51.2 MB (15 kB – 1.29 MB) | 0.72; 55.9, 55.5 | 0.72; 62.6, 60.6 |
| grids' resident chunks | — | 16,509, 16,495 | 16,499, 16,498 | 16,481, 16,472 |
| far field settled after Play (s) | 9.9, 8.1 | 24.0, 19.5 | 21.3, 20.0 | 21.3, 20.5 |

Light shots with the camera still (`light-shots --only street-noon,house-above,house-60m --edits 0`): simulation 18–25 ms
a frame in G0–G45 against 1.7–2.8 in W, page 10.7–13.2 against 4.0–7.1; G45's street picture was taken with the world
grid's near field not drawn yet (0 chunks). **Bodies**: the orbit and the shots stay above the collision ring's height, so
no body was made in any variant (0); the Play test's one grid house: one body, 11 collider parts, 3 builds in 7 ms.
**Derive of one house** (Node, `scratch/derive-house.ts`, `deriveFromStore` of every chunk of its box, median of 15, 12
houses): 12–26 ms in its own grid against 21–32 ms for the same house with the ground in the world grid.
Readings: the frame's cost is the grids' **count**, not their turn: G0, G30 and G45 are equal within their spread. A
streamer a grid costs about 1 ms of simulation a step while the camera moves (its plan, budget and coverage passes run
whatever it holds) and is the whole of the 130–150 ms; piece batches a grid multiply the draw calls (8–17 ×) and the
page's `render` (2–3 ×); the grids' 16.5 k resident chunks are their margins of air (125 a house).

**Pictures** (looked at; `m/S-<variant>/`, and `S-g30/` before the runs): `street-noon.png`, `house-60m.png`,
`house-above.png` of each variant; the Play test's `grid-house.png` (Playwright output, a 30° stone house in grid 1
seen square from its porch camera). Walls meet the flat ground: the grey foundation strip sits on the grass with no gap
or z-fight seen at the street camera in G30 and G45; the kit pieces (eave steps, window frames, fence-like beams; in the
test house the magenta boards at the door's jambs and front corners) sit on the turned edges; shadows fall from the turned
houses onto the grass (`house-above`). Plan 45 §1e's "foundation pieces skirt into the terrain and hide the seam": no
foundation piece exists, the seam is the foundation's bottom face on flat ground, not looked at on a slope. Seen wrong:
in G variants the windows show lit interiors where W's are dark (the light volume and the indoor cover see the world
grid alone); specks on the roof eaves of several grid houses at 60 m, at yaw 0 too (D744); the far field draws the
original aligned town past the mesh rings (the bench's far cache). **Collision** (Play test, pixels and positions): the
character pushed at the 30° house's front wall stopped at grid z 2.69 (its face at 3.0); pushed at its door it went
through to z 7.19 (the back wall's inside at 7.5).

**With a turned grid today** (each recorded, nothing guarded beyond the world grid; none crashed or drew garbage in the
runs except the specks):
- light volume, sun heights, indoor cover: walk the world grid's blocks alone; a grid house neither stops nor bounces
  light, its rooms are lit as open air, its roof covers nothing; the key light's maps and the atlas do see its casters;
- open regions, rooms, see-through and cut-away: the world grid's; `regionAt` in a grid house answers the outdoors, a
  camera's cut-away never cuts a grid house (its pieces are marked as room draws, the rooms never name them);
- the walk graph and `findPath`: the world grid's; a path goes through a grid house as through air (a walker then meets
  its body);
- the far field and far cache: the world grid's; a grid has no far nodes: past its own mesh rings (its levels 1–2, chosen
  in its frame) and its load ring it is not drawn; mips and mesh rings work per grid;
- `ctx.voxels` reads, rays, edits and saves: the world grid's; rays pass through grid houses; no edit reaches a grid;
- the coarse floor and `collisionReadyAt`: the world grid's;
- the editor's Scene view: the world grid alone; exports: ship the world grid alone (a shipped world has no grids);
- memory: each grid streamer has the world's budget (no shared budget); the resident-bytes row sums them.

**Unverified:** a turned house on a slope; bodies of the town's grids in Play (none made); anything in motion beyond
the orbit numbers; medium and high tiers; WebGL 2 (only its smoke test ran); the cause of D744. Gates: the manifest
commit's every-area fast gate (gate-fast-20261121-010349, RED on load flakes, gate-rerun-20261121-013806 GREEN), the
grids' fast gate with `voxel-world.e2e.ts` (gate-fast-20261121-040232 GREEN; `far-world.test.ts` D599 failed once and
passed alone), the Play test 1.8 min before, 1.9 min after (the first Play's checks 102.8 s alone), `area play` with the leak test (gate-area-20261121-062956, 24 passed, GREEN).

**D-rows** opened: D742 (an observation's counters cut at 32), D743 (a streamer a grid), D744 (specks on grid houses' eaves).

**Recommendation for 47a.5** (and slices b–d): keep the stored design (F2) and the frame arithmetic; do NOT keep a
streamer a grid: one streamer a world over all its grids (chunk keys by grid and chunk, as spec §3.6 plans), planning
only the grids whose boxes reach the ring; one set of piece batches a world with each copy's matrix carrying its grid's
transform, so the draws stay as W's; bodies a grid as built. Slice b: stamp each grid into the world's light and region
occupancy (the turn costs nothing measurable here, the count does); slice c: stitch the grids' walk graphs at doorsteps;
slice d: far nodes of grids from the same far cache runner, keyed by grid. The orbit numbers here are the cost of 131
streamers, not of turned grids.

### 47a.1a2 — many grids made cheap

**Where the per-grid time went** (measured first, Node, 2026-11-21: `work/47a.1a2/scratch/grids-node.ts`, the town's 131
houses each in its own grid at 30°, `VoxelGridHost` exactly as Play steps it, real workers, region files on disk, the
headroom orbit's focus at 120 steps a second, `--cpu-prof` and inspector profiles of the moving and still phases): 9.2 ms
a step moving, 5.4 still, for 131 grids. Every step ran every grid's streamer, and two scans ignored the grid's extent:
its **level choice** covered the top-level nodes over the whole unload ring round the focus (`chooseLevels`/`cover` over
an empty ring: 39 % of the step moving, nothing still), and its **collision-only planner** scanned the collision ring
round the camera every step (`wantedNow` from `look` and `request`, and again through `idle`: 35 %, moving and still);
then `stream-mips` `sendNodes`, section readiness (`chunkReady` → `stranded` → `neighboursComing`) and the collision
ring's `entering`. Mips, seams and section bookkeeping of the grid's own few chunks were small. The plan and reads were
already clipped to the extent (slice a).

**Built** (bfed4123, 42363e34): a streamer a grid is kept, made cheap where it ran for nothing (why not one streamer a
world: a grid's store, overlay, sections, mips, seams, relief and collision are all keyed in its own frame; putting
several grids behind one plan means a grid dimension in every one of those modules, and the measurement showed the cost
was the scans and the every-step updates, not a streamer's existence):
- `stream-lod`: the level choice's roots are clipped to the streamer's extent (`LodHost.extent`, from `MipHost`);
- `VoxelStreamer`: `counters.activity` (every event, every read, decode and job ending) and `idle(true)`: nothing that
  could be asked for now (stored chunks held for room, sections, nodes, seams asked again, bodies' ground) and nothing
  waiting on time (level 0 held or the ring narrowed for speed: `StreamReadPlan.atRest`); work already out is not
  counted, since its end moves `activity` (`pending(out)` on sections, mips, seams, the level choice, collision);
- `VoxelGridHost.step`: one distance test against the grid's world sphere while its streamer is quiet and nothing
  landed; the stream focus may move 1/8 of its gap to the grid's box (a cell at least, half the level rings'
  hysteresis at most: a grid 100 m off plans every 4 m) before the grid is told; a grid out of reach that holds nothing
  is never stepped; bodies count for a grid only within its collision keep bounds, the camera's own ground likewise;
- `VoxelWorldHost`: one budget (`worldBudgetBytes`, the world's `MEMORY_BUDGET_BY_TIER` entry) for the world grid and
  its grids, grids first: the world grid's share is the budget less what the grids hold;
- drawing: a grid's view draws with its world's surface (one material set and shader-grid store) and puts its kit
  pieces into its world's piece batches, each copy's matrix turned by the grid's yaw and moved to its place
  (`VoxelPieceBatches.set` with a `PiecePlace`; spheres for the chunk cull and the GPU culler's rows from the turned
  copies), so grids add their chunks' surfaces to a frame, never a draw a kind a grid;
- diagnostics: a grid's stats name what keeps it from quiet (`waits`), the world's pool lists its queue by kind and lane
  (`queuedKinds`); the headroom bench keeps both.

Node after (same harness): 0.35 ms a step moving, 0.022 still (from 9.2 and 5.4). **In Play the first build never
skipped** (V-g0 of the first round: 0 of 236 k grid updates skipped): the grids' coarse-level jobs waited at the back of
the shared queue behind the world's far and mip work (diagnosis `d/G30diag*.json`: 120 of 131 grids waiting on their
nodes, the queue 246 mip-lane jobs of 252) and `idle()` counted jobs out; 42363e34 made quiet look past work out.

**Keys by (grid, chunk):** already so in the job contract as built (the tracker's `DirtyChunk` and every job's `chunk`
carry the grid id; the grids' streamers share their world's tracker): no change of shape, spec §3.6 and
"stream job 1" untouched. Test: two grids' jobs on the same chunk coordinates stay apart in one tracker.

**Measured** 2026-11-22 03:23–05:23 UTC at 42363e34 (base 8253ff7c built in a scratch worktree with its own
`@thirdlight` links; the head's bench for both), low, WebGPU, 1280 × 720, the 30 Hz cap, each run alone (`uptime`
beside each, 1-minute load 0.95–3.85), `run.mjs headroom --quality low --rounds 2`, second rounds read, the A B A B
first then W G0 G30 G45 twice interleaved, then pictures, then coverage. Work folder `~/.cache/thirdlight-phase47a/work/
47a.1a2/` (`measure.sh`, `lib.sh`, `mkbase.sh`, `summ1a2.py`, `m/` every raw run, `m-first/` the first build's partial
round, `d/` the diagnosis runs, `scratch/` the Node harnesses).

World grid alone, head against 8253ff7c (the town as first written, no placements): room 128, 128 against 128, 128;
page ms 5.70, 5.93 against 5.63, 5.91; simulation 2.04, 2.22 against 2.19, 2.22; GPU `near` 4.37, 3.09 against 4.86,
4.39 (resolution 0.7–1.6 ms: not resolved); draw calls 86, 88 against 85, 85. Equal within the spread.

| town orbit, two runs | W | G0 | G30 | G45 | 47a.1a (G30) |
|---|---|---|---|---|---|
| room (copies; misses at no load) | 128, 128 (0/90, 0/89) | 128, 128 (0, 0) | 128, 128 (0, 0) | 128, 120 (0, 0) | −1, −1 |
| GPU near / far / lighting ms | 3.30, 3.89 / 2.92, 4.25 / 4.89, 4.16 | 4.82, 5.18 / 3.83, 3.60 / 5.17, 3.55 | 4.71, 4.60 / 3.80, 3.23 / 5.31, 4.02 | 5.18, 4.07 / 2.36, 2.67 / 4.44, 5.02 | 5.97, 5.90 / … |
| page ms a frame; `render` | 5.86, 5.85; 4.21, 4.41 | 6.56, 6.76; 5.10, 5.20 | 6.35, 7.04; 4.97, 5.44 | 6.61, 6.11; 5.07, 4.60 | 15.24, 15.00 |
| simulation ms a frame (`voxelStream`) | 2.12, 2.15 (1.73, 1.77) | 4.16, 3.98 (3.47, 3.36) | 4.38, 4.36 (3.59, 3.70) | 4.54, 4.05 (3.83, 3.35) | 142.3, 135.2 |
| draw calls; triangles (the frame after the fill) | 86, 86; 128 k, 130 k | 130, 44; 899 k, 81 k | 33, 153; 61 k, 802 k | 46, 34; 73 k, 70 k | 640, 679 |
| world piece draws (grids' copies in them); kit instances | 49, 49; 38.9 k | 52, 52; 49.2 k | 51, 50; 45.4 k, 40.5 k | 50, 51; 36.8 k, 52.8 k | 1,017–1,057 grid piece draws |
| page heap / GPU MiB | 698, 625 / 1,026, 1,004 | 619, 630 / 967, 1,164 | 606, 661 / 915, 1,097 | 628, 592 / 949, 962 | 671, 626 / 1,477, 1,250 |
| one budget (low 768 MiB): world grid; grids MB | 70.0, 72.8; — | 8.1, 12.3; 86.2, 84.2 | 0.7, 13.4; 67.9, 88.3 | 10.5, 0.8; 84.0, 81.7 | 0.72; 55.9, 55.5 (each its own budget) |
| grid updates; steps skipped (to the fill's snapshot) | — | 140 k, 112 k; 137 k, 126 k | 159 k, 104 k; 123 k, 87 k | 122 k, 154 k; 119 k, 130 k | every step, none skipped |
| fill (s) | 8.5, 8.3 | 19.1, 16.2 | 21.0, 13.9 | 16.6, 23.7 | 21.3, 20.0 |

Read: the **room** is the world grid's (128 everywhere; slice a: no room). **Page** ms 1.04–1.20 × W (target ≈ 1.3:
met); `render` +0.7–1.0 ms (the grids' chunk surfaces: a chunk a draw). **Draw calls** depend on how much of the world
grid's near field had arrived when the snapshot was taken (the fill's moment): 33–46 with it not yet drawn, 130–153 with
it arriving (stand-ins and seams); the grids' kit pieces are in the world's 49–52 piece draws (W 49): they no longer
multiply. **Simulation** 1.9–2.1 × W on the moving orbit: **target missed**. Its cause, from the coverage round's spans
(below) and the Node harness: the grids' updates as the focus moves (each grid near the orbit is told every cell or
few, each update 0.2–0.35 ms in Node: the level choice over its margin chunks and the section readiness walk), about
1.4–2 ms a frame of the 120 Hz steps at 30 Hz; and the world grid's queue: in every G run the pool's queue is full
(252 of 256) during the fill, mostly mip-lane node jobs, so the world grid's level 0 near the camera arrives after the
grids' (fill 14–24 s against 8.3–8.5; "world grid near field 0 chunks" at the snapshot, 147 in W). That is not a hole:
at the street camera after settling the world grid draws 159 chunks (89 at level 0, 70 at level 1) and the ground and
fences are there (`d/S-g30-diag/street-noon.png`, `m/S-g30/street-noon.png`). **With the camera still** (light shots,
after settling): simulation 3.87 (street), 3.94 (60 m), 2.57 (above) against W 2.90, 2.84, 1.87 (1.33–1.39 ×; slice a
18–25 ms); page 6.87, 8.69, 4.58 against 6.65, 6.65, 4.12.

**Coverage at 150 m/s** (Play on staging, `run.mjs coverage --quality low --speed 150 [--query G30]`, one each, same
hour): longest frame 64.5 ms G30 against 71.5 W, none over 100 ms in either, missed 39.3 against 35.7 a minute, p95
38.2 against 37.7; after the stop ground solid 0.04 against 0.03 s, full detail 5.07 against 4.27 s, nothing pending
10.6 against 9.56 s; falls 0 of 34 both; holes 1 of 1,968 against 0. Simulation in flight 14.9 against 9.5 ms a frame,
of which `structure grids streamed` 4.8 ms a frame (its longest frame 217 ms while the flight crossed the town: at
speed every grid in reach is told every step). Raw `m/C-w.*`, `m/C-g30.*`.

**Bodies** (direction 3; Node, `scratch/bodies-node.ts`: the G30 grids, the engine's Rapier port, a probe body walking
two streets at 1.5 m/s, 1 m up, for 60 s): 19–21 grid bodies at a time (the houses within the collision ring's keep
bounds), 2,033–2,389 collider parts in all, 82 body builds taking 166 ms in all (2.0 ms a build); the grids' share of a
step 0.75–0.8 ms with the body moving. The Play test's grid house: one body, 11 parts, 3 builds in 1.2 ms; the character
stops at grid z 2.69 before the front wall (alone; 1.85 once under the gate's load, still before the wall) and walks
through the door to 7.19.

**Far** (direction 4): a grid draws its own levels 1–2 inside its load ring (192 m on low, chosen in its frame); past it
it is not drawn. The far field proper (far nodes per grid) is slice d. In the bench the stale far cache still draws the
town as first written past the rings (aligned houses).

**Pictures** (looked at): `m/S-w/` and `m/S-g30/` `street-noon.png`, `house-60m.png`, `house-above.png`; `m/S-g0/
house-60m.png` and `m/S-g0-off/house-60m.png` (the same camera with `&voxelLight=off`); `d/S-g30-diag/street-noon.png`.
The ground is drawn in every picture; at 60 m every house of G30 is there, turned, with its roof and walls; the street
shows the turned houses' gables and kit pieces, the fences and grass of the world grid; from above the turned roof and
its eave pieces sit on the house. Seen wrong in G only: windows lit where W's are dark (the volume does not see grids,
slice b), and the eave and roof specks (D744, below).

**D744** (in its 45-minute box): the specks are the light volume's read on grid houses: with `?voxelLight=off` the same
camera shows none (`m/S-g0/house-60m.png` against `m/S-g0-off/house-60m.png`), and W's houses, which the volume sees,
show almost none. Ruled out: z-fighting of eave pieces (they draw with the volume off), the geometry at level 1 (open
edges of a house's surfaces counted in Node, `scratch/eaves.ts`: present at both lattice parities, at level 0 too, so not
what differs between W and G). Not fixed here: it is slice b's (light seeing grids).

**Unverified:** medium and high tiers; WebGL 2 (its smoke test only); anything in motion beyond the numbers; a turned
house on a slope; the grids' bodies in Play beyond the test house (the bodies above are Node's with the engine's port).
Gates: gate-fast-20261121-071239 GREEN (bfed4123's tree; Play test 1.8 min); gate-fast-20261122-030216 RED on the Export
test only ("the configured exportRoot is not a directory"), gate-rerun-20261122-032107 GREEN; Play test 1.8 min in the
gate, 2.0 min alone; `area play` (the leak test) gate-area-20261122-052436 GREEN (24 passed).

**D-rows**: D743 narrowed (below); D744 found; D745 opened (the shared queue).

**Recommendation** (unchanged in kind, now measured): one grid per structure stands on page cost, draw calls and memory;
the simulation's cost of a town of grids on a moving camera is about twice the world grid's (still camera 1.35 ×). What
is left to take: a grid's update itself (its level choice over its margin chunks, the readiness walk: 0.2–0.35 ms), and
a queue the world grid's near work cannot be crowded out of (D745). Neither needs a foundation rewritten.

### 47a.1b — light and rooms for structure grids: the stamp against exact stepping

**Built** (3627dc6b, 06ecc288; bench 0f4e6938, 973db982). **S, the stamp** (`@thirdlight/voxel` `structure-stamp.ts`,
held by `prop-channel.ts` beside the props, derived and never stored): a grid's cells are read from its resident chunks
(a class a cell from its record: stops light where a construction cell's integrity covers half or more or ground is
half full; `opening`; open), cut to the box of its non-open cells, and sampled into the world cells of its turned box at
4³ points a cell, as a prop is; a named rule makes each world cell's coverage byte (joined into the light stop with the
voxels' and the props') and its class (a chunk's structure classes, a stop winning over an opening). The open regions
read the classes with each unit (`stampedRegions`: a stamped stop is solid, a stamped opening a portal cell), so a
turned house's rooms, portals and roof (the sky heights: sun field, indoor cover) are the world's own; the walk's mip
levels read the stopping classes (a level's cell stops where one under it does, the world mips' rule), so rays past the
detail ring meet the house too. Fed by `VoxelGridHost.stamp` from `VoxelWorldHost` whenever a chunk of the grid arrives
or leaves (a moved or edited grid recombines only the chunks it left and entered), sampled in the derive slice
(`frameSliceMs('voxelDerive')`, the props' stamping), the changed chunks' walk blocks sent again at every level. On by
default where a world has grids (`STRUCTURE_STAMP_DEFAULT` = `share`); `?gridStamp=share|quarter|any|roles|majority|off`
for a bench (forwarded to Play by the editor; found missing in the first run of the off check below). Memory: the
channel's bytes and classes are the chunk's `propCoverage` budget part (the stream budget, `MEMORY_BUDGET_BY_TIER`); no
new entry. With no grid nothing is made: the regions get no stamps, no class array exists, the walk views are the same
objects (vitest), and the world-only A B below. **E, exact** (`grid-walk.ts` `walkWithGrids`, CPU only, the reference):
the world walked as before, then each grid whose box the ray meets walked in its own frame from where the ray enters it
to where it leaves or meets something nearer; nothing of it is on the GPU.

**Ray agreement** (Node, 2026-11-22, `work/47a.1b/scratch/stamp-rays.ts`, raw `rays-6.json`, 12 s: `node bundle.cjs &&
RAYS=1000 SOURCES=records node stamp-rays.mjs` in the 8G scope). The town box of the open-regions town test widened to
8 × 3 × 8 chunks; the 24 houses whose turned plan fits it at 0°, 30° and 45° each derived in its own grid with the world
rules; W = every house in the world grid, G = the world grid with ground, fences and ponds and each house in its grid
turned about its footprint's middle. A house: 1,000 sky rays (cosine-weighted, 24 m) from points inside its rooms,
1,000 rays from 3–6 m outside a wall cell to a point in a room, 1,000 rays from 2 m before a door or window cell through
its face to 1 m inside: 72,000 rays a variant, E's answer the truth. **Leak** = S passes where E stops (light in a
closed room); **block** = S stops where E passes; in brackets those with E's stop (or S's) **more than a cell from any
opening**: the rest are an opening's edge moved.

| yaw | rule | sky rays (of 24,000): leaks (away), blocks | across walls: leaks (away), blocks (away) | through openings: leaks, **blocks** | rooms, points lost | portals (houses with fewer) | room volume |
|---|---|---|---|---|---|---|---|
| 0° | every rule | 0, 0 | 0, 0 | 0, **0** | 24/24, 0 | 595/595 | 1.000 |
| 30° | share | 17 (0), 10 | 615 (7), 234 (2) | 62, **2,970 (12.4 %)** | 24/24, 0 | 592 (3) | 0.979 |
| 30° | quarter | 2 (0), 33 | 98 (0), 767 (4) | 0, **10,842 (45 %)** | 24/24, 0 | 586 (5) | 0.932 |
| 30° | any | 0, 57 | 9 (0), 1,337 (12) | 0, **19,599 (82 %)** | 24/24, 0 | 522 (20) | 0.886 |
| 30° | roles | 10 (0), 18 | 351 (0), 425 (16) | 11, **2,498 (10.4 %)** | 24/24, 0 | 592 (3) | 0.886 |
| 30° | majority | 1 (0), 29 | 66 (0), 742 (14) | 0, **8,562 (36 %)** | 24/24, 0 | 592 (1) | 0.886 |
| 45° | share | 18 (0), 13 | 665 (6), 258 (1) | 9, **4,429 (18.5 %)** | 24/24, 0 | 592 (2) | 0.982 |
| 45° | quarter | 6 (0), 29 | 214 (0), 670 (4) | 2, **10,588 (44 %)** | 24/24, 0 | 582 (5) | 0.953 |
| 45° | any | 0, 57 | 7 (0), 1,397 (13) | 0, **20,398 (85 %)** | 24/24, 0 | 495 (21) | 0.875 |
| 45° | roles | 7 (0), 28 | 291 (0), 523 (19) | 48, **3,110 (13.0 %)** | 24/24, 0 | 588 (4) | 0.875 |
| 45° | majority | 2 (0), 40 | 64 (0), 797 (16) | 0, **7,987 (33 %)** | 24/24, 0 | 583 (5) | 0.875 |

Read: **no rule leaks through a closed turned wall**: away from openings at most 7 of 24,000 rays across walls (share;
none for the conservative rules) and no sky ray; a one-cell wall turned 30° or 45° stamps as a staircase whose cells
join by faces, so neither a 6-connected ray nor the regions' labelling slips through it. What the rules trade is the
**openings**: share narrows a 1 m door or window so that 12–18 % of rays through its face stop (and its moved edge lets
some by beside it: the 615–665 "leaks" at openings); roles keeps them best (10–13 %) but thickens every wall by about a
cell (rooms 0.875–0.886 of their volume); any and quarter close most of them (45–85 %), so the regions lose portals.
**No rule lost a room** (every interior point of the 24 houses in an enclosed region of the same count). Rooms and
portals at 0° are the grid's own and W's for every house (24/24 rooms, 595/595 portals, the same cells), and S agrees
with E on all 72,000 rays at 0°; both differ from W on 12 sky rays that leave through a window and meet a house past
the 24 (W holds every house of the box; the grids only the 24): the test's set, not the stamp. A cell's class from its
record equals the derive's light stop on every cell of the 24 houses (0 differ either way: the thin forms of these
houses all stop light). **D741** (partial transmittance, 47a.12): of share's 694 (30°) and 692 (45°) leaks, all at an
opening's edge, a ray carrying (1 − coverage) through the stamp's partly covered cells would keep under half its light
on 347 and 229 and under a tenth on none: it would dim them, not close them; it changes no figure away from openings.

**E's cost** (the same rays, best of three, CPU): the world grid alone 573 rays a millisecond; the world and the 24
houses' grids 244 (1.02 grids entered a ray); the same rays with all 131 town houses' boxes tested 137; the stamped world
(S's CPU walk, the props' joined views kept per block until the channel changes) 714 (it stops earlier). On the GPU, E
would need, a ray: a box test against every grid in reach (two vec4 loads for the box, one for the place and yaw, about
12 multiply-adds and 6 min/max; 131 in reach on the town orbit: about 400 loads before the first step, against 2–3 loads
a step of a 20–60-step world walk) unless a 2D index of grids by tile is added (one or two lists a tile a ray crosses);
for each grid entered, a frame change (8 multiply-adds), a second walk loop with its own block table (one table load a
block, then the brick and cell words as today) and the branch between the two loops (divergent in a warp where
neighbouring rays enter different grids). From the CPU ratio, 2.3× the walk's cost with the grids it meets, 4.2× with a
town's boxes tested: the volume's update is paced to its GPU share, so that is 2–4× fewer rays a frame (slower settle
and refresh) or 2–4× its 4–5.5 ms lighting row. Not built.

**Stamp time and memory** (Node, `scratch/stamp-time.ts`, raw `stamp-time-30.json`): the town's 131 houses at 30°
arriving at once: reading every grid's cells 65 ms (0.31 ms a grid at the median), sampling 523 ms (2.9 ms a grid, 26 ms
the first), recombining about 90 ms: about 0.7 s of the derive slice spread over the steps; 240 world chunks hold a
stamp: 15.6 MB (7.7 MB of it the classes) and 3.7 MB of sampled stamps. In Play (headroom's snapshot, `gridStamps`):
131 samples (one a grid: no stamp made again on the orbit), 3.1 and 3.2 ms at the median, **18.4 and 35.5 ms the
longest** (one grid's sampling is one piece: D747). An edit in a grid house (a 1 × 1 m window dug by a direct write to
its grid's store: **no edit path into grids exists yet**) restamped in 6.3 ms (read 0.4, sample 3.4), one world chunk
changed; on the page that chunk's walk blocks go again and the volume restarts what they reach, the path a prop's move
takes (not measured for a grid in the browser: unverified).

**Play test** (`voxel-world.e2e.ts`): the grid house gains a flat roof and a door of opening cells; with the stamp
`ctx.voxels.regionAt` in it answers a room with one portal, and the light volume's 0.5 m cell over its floor holds
0.59 against 7.05 over its porch (all faces' brightness, the store switched on for the check with the house's camera
live: 3.1–3.6 s to light both). Run once with `&gridStamp=off` (`work/47a.1b/pw/play-off2.log`): it fails at the room
("2,1": the outdoors). Its picture through the door is no measure (the sun shines through the door onto the back wall:
`pw/grid-house-run1.png`). Play test 1.8–2.0 min before, 1.9–2.0 min after (alone and in the gate).

**Browser** 2026-11-22 06:38–08:21 UTC, head 973db982 (product code of 06ecc288), base 3e673ac0 built in a scratch
worktree with its own `@thirdlight` links (removed after), low, WebGPU, 1280 × 720, the 30 Hz cap, each run alone
(`uptime` beside each; 1-minute load 0.9–3.3), `run.mjs headroom --quality low --rounds 2`, second rounds read. Work
folder `~/.cache/thirdlight-phase47a/work/47a.1b/` (`measure.sh`, `lib.sh`, `mkbase.sh`, `summ.py`, `m/` every raw run).

World grid alone (the town as first written, no grids), head against 3e673ac0, A B A B: room 128, 128 against 128, 120;
page ms 5.53, 5.77 against 5.39, 5.80; simulation 2.15, 2.23 against 2.12, 2.10; GPU `near` 3.86, 5.12 against 2.76,
below; `lighting` 5.46, 3.76 against 4.57, 5.64 (resolution 0.2–2.0 ms); page `lighting` 1.02, 0.91 against 0.96, 0.96:
equal within the spread (not resolved).

| town orbit, two runs | W | G30, stamp (share) | G30, `&gridStamp=off` |
|---|---|---|---|
| room (copies; misses at no load) | 128, 128 (0, 0) | 128, 120 (0, 0) | 128, 128 (0, 0) |
| GPU near / far / lighting ms (resolution) | 4.71, 3.97 / 3.09, 4.57 / 4.80, 5.60 (2.5, 1.4) | 4.95, 4.99 / 3.39, 3.54 / 4.78, 5.39 (1.2, 0.7) | 4.10, 4.67 / 2.68, 3.09 / 3.85, 4.28 (0.7, 0.6) |
| page ms a frame; `render`; `lighting` (of 2.0) | 5.54, 5.42; 4.30, 4.04; 0.79, 0.97 | 6.84, 6.50; 5.03, 4.74; 0.90, 0.91 | 6.30, 7.01; 5.00, 5.35; 0.64, 0.79 |
| simulation ms a frame (`voxelStream`) | 2.23, 2.19 (1.80, 1.79) | 4.25, 3.86 (3.60, 3.31) | 4.25, 4.35 (3.39, 3.66) |
| page heap / GPU MiB | 624, 645 / 991, 972 | 620, 618 / 1,024, 1,068 | 735, 638 / 1,153, 1,018 |
| the stamp: channel MB (classes); grids stamped; sampling ms median, longest | — (0) | 15.6 (7.7); 131; 3.1, 18.4 / 3.2, 35.5 | — (0: proven off: no `gridStamps`, channel 0 B) |
| fill s | 8.3, 7.4 | 17.1, 17.0 | 23.2, 16.6 |

Read: with the stamp the volume's GPU `lighting` and page `lighting` read as W's (the volume sees the houses as it sees
W's; off, it lights open air there and reads 0.5–1.0 ms lower), the simulation is G30's own (the grids' streaming,
47a.1a2; the stamp runs at arrival, not on the orbit), room and page ms as without it. The orbit's region counts are
taken before the world grid's near field arrives in G (D745), so regions are compared settled, at the light shots:
**W 132 regions, 131 enclosed, 3,446 portals; G0 the same (131, 3,446); G30 131 enclosed, 3,487 portals; G45 131,
3,512** (an opening at 30°–45° can stamp as two portal pieces); the room camera's room: W 653 m³ and 24 portals, G0 653
and 24, G30 637 and 24, G45 625 and 24.

**Pictures** (`light-shots --only street-noon,room-window,house-60m,house-above,night-lamps --edits 0`, the room
cameras turned with the centre house by the new `--turn-room 30|45`: eye turned about the house's footprint middle,
look turned the same; `m/S-<variant>/`), looked at beside W's:
- `room-window`: W and G0 alike, the room dark, its windows bright, floor and walls dim; G30 and G45 as dark (the lit
  interiors of 47a.1a2 gone), their walls a shade lighter and bluer than W's; **G45 shows two thin bright vertical lines
  at the room's inner corners** (the volume's read beside a drawn corner falls in a world cell the stamp leaves outside:
  D746); no room lit by a window black; no light line along a turned wall.
- `house-60m`: windows of the grid houses dark as W's (bright in 47a.1a2's `m/S-g30/house-60m.png`); **specks on the
  eaves fewer but not gone** on several grid houses at 30° and 45° (and two or three on G0's, a few on W's): D744 stays
  open, narrowed.
- `street-noon`: G30 and G45 windows dark as W's, walls lit as W's, shade under the eaves, no leak line; `night-lamps`
  (W, G30): the lamps light the fronts alike, windows dark, a few small specks far down the G30 street; `house-above`
  (G30): the turned roof and its eave pieces, its shadow on the grass.
Not looked at: W and G45 `house-above`, G0 `street-noon` and `night-lamps`, G45 `night-lamps` (taken, in the folders).

**What S cannot do by design.** Its light, rooms and sun shade are the house resampled at 0.5 m: a surface it sees can
be up to a cell (0.5 m) off the drawn one, so a bounce or a shadow edge from a turned wall is up to 0.5 m off, and the
volume's read beside a drawn surface can fall in a cell on the stamp's other side (D746's corners at 45°). A door or
window turned 30° or 45° is narrowed by up to a cell at each edge: 12 % (30°) and 18 % (45°) of rays through a 1 m
opening's face stop under share; an opening narrower than about two cells would close. A wall is whole cells in its own
grid, so no wall is thinner than the one cell measured; it closes under every rule. The walk's far nodes do not see a
grid (slice d), the mips see it as stopping cells only.

**E's cost** (above): 2.3–4.2× the CPU walk with the town's grids, a GPU walk with a second loop, a second block table
and a box test a grid in reach; nothing built on the GPU.

**Recommendation:** stamp structure grids with the share rule (the props' own: 4³ samples, stop at half; no new
threshold) for light, sun heights and rooms, as built and on by default; keep E (`walkWithGrids`) for exact
`ctx.voxels.raycast` answers through grids (47a.5) and as the reference; neither 47a.5 nor 47a.8 needs exact stepping
on the GPU. If narrowed doors matter, the next step is the stamp's openings (an opening cell's samples counted toward
open before the share), not the GPU walk.

**D-rows**: D744 narrowed (open); D746 (corner lines at 45°), D747 (one grid's sampling in one piece). **Unverified:**
medium and high tiers; WebGL 2 (its smoke test only); anything in motion beyond the orbit numbers; edit → light for a
grid house in the browser (no edit path into grids); a turned house on a slope; the off run's light check (the off run
stopped at the room check). Gates: gate-fast-20261122-061112 (RED on `project-items.e2e.ts`, D410),
gate-rerun-20261122-063506 GREEN; `area play` with the leak test gate-area-20261122-082532 GREEN (24 passed).

### 47a.1c — paths into and round structure grids

**Built** (fe397a85, 5db10a23; bench 5e329148). Two candidates, the simpler first, each measured against W (the same
houses in the world grid):
- **P-stamp** (`@thirdlight/voxel` `walk-graph-stamp.ts`, `stampedNav`): the world graph's navigation with the grids'
  stamp classes (47a.1b's share rule, the prop channel's `rooms`) read as world cells: a stamped stop blocks a walker and
  carries one (`supports`). One graph, `findPath` unchanged. Kept only as the option the measurement below used.
- **P-own**, left on (fe397a85): the world graph reads the same stamps **blocking only**, so its walker goes round a
  turned house and stands nowhere inside its footprint; each structure grid keeps **its own walk graph** in its own frame
  from its own derived navigation (`VoxelGridHost.walk`, the existing per-chunk builder, made as its chunks arrive, change
  and leave); **links** (`walk-graph-links.ts`, `WalkGraphLinks`) join a grid's standable cell to the nearest world
  standable cell within `WALK_LINK_REACH_CELLS` (a diagonal, 0.71 m) between floor middles, one cell up or down, room for
  the walker at both ends (one cell more at the lower end) and the grid's own cells free at three points along the way
  (no jamb's corner cut); a grid chunk's links are made again when its part or a world part under it is made again or
  dropped (each graph's `onPart`), a grid chunk where nothing stands hears of no world chunk; `findPath` crosses graphs
  (`walk-graph-linked.ts`, `LinkedWalkQueries`; runtime `voxel-world-paths.ts`): an end lies in the graph whose
  standable cell under it is nearest, ends in one graph are that graph's own query, else the links are the exits: the
  best `LINKED_PATH_DOORS` (3) links more than 2 m apart, ranked by straight lines, have their legs searched by each
  graph's own queries (one A* first, the pieces' exits for a long leg) and the cheapest whole way answers, in world
  metres (a grid's cells placed by its frame). Derived, never stored; with no grid nothing is made (`WorldPaths` holds the
  world's queries alone; the stamp read is not made: `stampedNav` returns the section's own navigation, vitest).

**Node** (2026-11-22, `work/47a.1cd/scratch/paths.ts`, 47a.1b's box: world chunks −4…3, y −1…1, the 24 houses whole in
it at every yaw measured, the 44 touching it placed; `MODE=stamp|own node paths.mjs`, raw `paths-stamp-3.json`,
`paths-own-5.json`; i5-12600H). For each house a path from 2.5 m before its door to its ground floor's middle and to its
upper storey's middle (17 houses have one); **in a wall** = a cell walked whose walker column (its centre, the feet cell
and three over) lies in a stopping cell of the grid, read in the grid's own frame from its records.

| | W | P-stamp 0° | 30° | 45° | P-own 0° | 30° | 45° |
|---|---|---|---|---|---|---|---|
| street → room found (of 24) | 24 | 24 | 24 | 24 | 24 | 24 | 24 |
| street → upper storey found (of 17) | 17 | 17 | **13** | **10** | 17 | 17 | 17 |
| length against W: room; upper (least … most) | 1 | 1; 1 (the same cells, 24/24, 17/17) | 0.99–1.06; 0.94–1.08 | 1.00–1.10; 1.01–1.13 | 0.97–1.00; 0.97–1.00 (the same cells 21/24, 4/17) | 0.99–1.05; 0.96–1.02 | 0.98–1.09; 0.96–1.03 |
| cells in a wall (deepest, cells) | — | 0 | 4 (0.08) | 0 | 0 | 0 | 0 |
| across the box, two ways round the houses: found; length against W; cells in a wall | found 157.5, 172.2 m | 1, 1; 0 | 0.99, 1.01; 0 | 0.98, 0.99; 0 | 1, 1; 0 | 0.99, 1.01; 0 | 0.98, 0.99; 0 |
| query ms (cells) street → room, median; across | 0.07 (39); 12.9–17.5 (15.6 k–17.8 k) | 0.06 (39) | 0.09 (29) | 0.07 (54) | 0.13 (24) | 0.10 (32) | 0.09 (23); 6.7–8.6 (11 k–15 k) |
| graph build: the box's world graph; a house's own graph (median, most); links | 105–110 ms | 170 ms | 162 | 142 | 72 ms; 0.47, 1.17 ms; 87 ms (116 grid chunks, 78 links) | 58; 0.46, 1.15; 73 (90 links) | 54; 0.44, 1.09; 59 (91 links) |
| bytes: world graph; the grids' graphs; links | 1.15 MB | 1.19 MB | 1.24 | 1.25 | 0.68 MB; 0.51 MB; 33 kB | 0.69; 0.51; 37 kB | 0.69; 0.51; 37 kB |
| a house placed again (its chunks made again), ms; its stitch alone (all its links made again) | — | 1.9–9.6 | 1.9–6.6 | 1.6–6.1 | 1.5–3.6; 0.4–4.6 | 1.4–3.7; 1.2–4.3 | 1.3–3.2; 1.2–3.9 |
| the edit: a back wall dug 1 × 2 m (path from 2.5 m behind it to the room) | 22.5 → 7.6 m | 4.0 ms | 4.8 | 4.3 | 13.3 ms (derive 9.1, stamp 2.1, graph and links 1.3, query 0.4) | 13.4 | 13.7 |

Read: **P-stamp loses stairs by design.** Its rooms are all found and its turned doors pass, but 4 of 17 upper storeys
at 30° and 7 at 45° are not reached: the stair steps themselves stamp as standable cells (`DIAG=1`: every step of the
lost houses' stairs had its cells), but where the stair's top meets the floor beside it the share rule leaves world
columns whose cells the stop covers less than half at both heights, so a gap opens a cell wide that no step crosses. No
other stamp rule keeps them (`RULE=quarter`: 9 and 13 of 17; `roles`, `majority`, `any`: 0, the thickened steps take the
headroom; `paths-{roles,majority,any,quarter}.json`), and 4 cells of its upper paths at 30° grazed a wall (up to 0.08
cells inside). **P-own passes every house at every yaw**, no cell of the 72 + 51 measured paths in a wall, paths round
the houses as the stamp's. At 0° it is not W cell for cell (21 of 24 room paths, 4 of 17 upper the same cells; lengths
0.97–1.00 of W): diagonals are taken inside a chunk only (+0.29 m a chunk face crossed), and a house's own chunk faces
lie elsewhere than the world's; that is the walk graph's rule, not the link (the vitest house on chunk-aligned cells
gives W's cells and cost exactly). The edit is a direct write to the grid's store, the grid's chunk derived again, its
stamp and graph made again (there is no edit path into grids: 47a.5); its new way in 13–14 ms of work in Node, most of it
the derive.

**Play** 2026-11-22 08:58–11:10 UTC, low, WebGPU, 1280 × 720, the 30 Hz cap, each run alone (`uptime` beside each;
1-minute load 1.1–1.8, the first head run's start 3.0), `run.mjs headroom --quality low --rounds 2`, second rounds read;
work folder `~/.cache/thirdlight-phase47a/work/47a.1cd/` (`measure-c.sh`, `measure-c2.sh`, `summc.py`, `m/`). Base
533a62a7 (before fe397a85) built in a scratch worktree with its own `@thirdlight` links, removed after.

| town orbit, second rounds | room | page ms | simulation ms | GPU near / far / lighting (resolution) |
|---|---|---|---|---|
| world grid alone, head fe397a85 (A B A B) | 128, 128 | 5.71, 5.74 | 2.07, 2.29 | 4.19, 5.35 / 2.34, 2.84 / 3.92, 4.23 (1.2, 1.8) |
| world grid alone, base 533a62a7 | 128, 128 | 5.58, 5.58 | 2.17, 2.25 | 4.65, below / 3.36, below / 5.92, 4.61 (1.0, 4.0) |
| W (all houses in the world grid) | 128, 128 | 5.72, 6.29 | 2.10, 2.40 | 3.95, 4.17 / 3.74, 3.37 / 4.26, 5.68 (2.5, 1.8) |
| G30, head fe397a85 | 128, 128 | 6.48, 6.45 | 5.16, 4.12 | 3.90, 5.39 / 3.23, 2.45 / 5.87, 4.49 (0.8, 0.8) |
| G30, head 5db10a23 (A B A B) | 120, 128 | 6.48, 6.43 | **4.15, 3.91** | 5.65, 5.09 / below, 3.30 / 4.31, 5.43 (4.3, 2.0) |
| G30, base 533a62a7 (no walk graph in grids) | 120, 128 | 7.20, 6.12 | **4.38, 4.04** | 3.73, 3.90 / 3.31, 3.72 / 5.58, 4.04 (3.2, 2.5) |

Read: the world grid alone is unchanged (simulation 2.07–2.29 against 2.17–2.25, page 5.71–5.74 against 5.58: inside
the spread). G30 with the grids' own graphs and links costs no more simulation on the orbit than without them in the same
hour (3.91–4.15 against 4.04–4.38 ms); G30's simulation over W's is 47a.1a2's streaming of the grids (D743, D745). Walk
graph bytes at the fill's snapshot: W's world graph 5.5–6.4 MB; G30's grids' graphs 2.8–3.0 MB for the 131 houses with
their margin chunks (2,243–2,445 parts, 116–130 k cells), the world graph not arrived yet at that moment (D745), the
`walkGraph` row 16 MiB at low; links 0 at that snapshot (the world's near parts not there). The 5db10a23 snapshots lost
their host diagnostics (D749). **Play test**: the grid house's porch to its room by `ctx.voxels.findPath`, over the grid's
own graph: found, 4.5 m, its last waypoint in the room, none in a wall's cell, answered 76 ms after the command (the
command's round trip included); the Play test 1.9 min (gate-fast-20261122-085826; 1.8–2.0 before).

**What a 2-cell-wide walker would meet** (D735, 47a.8): in its own graph a grid's 1 m door is its two cells exactly at
every yaw, so clearance over two columns there is the grid's own; a link is a single cell's step, so a wide walker needs
the link to keep its footprint too. In P-stamp a turned 1 m door is narrowed by up to a cell at each edge (47a.1b:
12–18 % of rays through it stop): a 2-cell walker would not pass it.

**P-own's design limits:** a link reaches a diagonal and one cell up or down: a door whose outside lies more than a cell
below its threshold (a house on a slope, the Play test's porch over the hill) links nowhere (question 4: the ground is
left alone); the world's cells beside a turned wall are the stamp's, so a world cell's middle may lie up to 0.08 cells
(4 cm) inside a turned wall's corner (once, in the edit's path at 30°); a way between two points of one graph never goes
through a grid (in one door, out another), nor between two touching grids; the doors tried are the best three by straight
lines, so a house with more doors may be given the dearer one; walkers of another height or with drops, and `reach`,
search the world graph alone (D748).

**Recommendation:** P-own — each structure grid walks in its own graph, linked to the world's at its doorsteps and
foundation edges, the world's walker blocked by the grid's stamp — is on (47a.8 builds its door state and walker width on
it); the stamp alone (P-stamp) cannot carry a turned staircase and was measured, not kept on.

### 47a.1d — structure grids in the far field

Work folder `~/.cache/thirdlight-phase47a/work/47a.1cd/` (`measure-d.sh`, `summd.py`, `d/` every raw run and picture;
low, WebGPU, 1280 × 720, the 30 Hz cap, each run alone, staging; the world and its far cache restored after).

**Today** (before 654fae78): the far cache is built from the world grid's files alone and a structure grid is drawn
only by its own streamer inside its own rings (levels 0–2 in its frame, its load ring 192 m on low); the bench kept the
town as first written in the far cache. Pictures with the far cache's town built again from G30's files without its
houses (`run.mjs town-grids --variant g30 --far none`), at noon from the east of the town's middle at a distance and a
fifth of it up again (bench cameras `town-100m` … `town-2km`, `--only`, `light-shots`), looked at beside W's (all houses
in the world grid, the far cache's town built from W's files):
- 100 m (`d/S-g30-none/town-100m.png`): every house in view drawn by its own grid, turned, kit pieces on, the eave
  specks of D744; as W's but turned.
- 150 m (`town-150m.png`): the same; the mesh rings work per grid in its own frame (the confirmation slice a2 asked
  for: the houses 100–190 m away drawn whole, turned, roofs and walls in place).
- 250 m (`town-250m.png`): only the rows within about 190 m drawn; the rest of the town is bare ground with its fences
  and ponds (W's `d/S-w-none/town-250m.png`: the whole town, its far rows as far bricks).
- 600 m and 2 km (`town-600m.png`, `town-2km.png`): **nothing of the town**: an empty valley floor where W shows a field
  of small red roofs (600 m) and a red patch (2 km).

**Built** (654fae78): **F-stamp**, the far build reading placed grids. `@thirdlight/voxel` `grid-resample.ts`
(`resampleGridInto`): a grid's records sampled into a world chunk's cells where it stands, 2 × 2 points across each
cell's middle height (yaw is about the vertical), a cell taking the record most of its points hold where at least half
fall in cells that are not air (an opening counts), the world's own cell elsewhere; a grid at yaw 0 on the world's cells
copies its cells exactly. Workspace `FarWorldSource(worldDir, grids)`: each placed grid the manifest lists (its files'
chunks its box) joined over the world grid's chunks its turned box touches; `buildFarCache` (`grids` option) and
`rebuildFarCache` (`grids` argument) pass the placements. The far cache's format, fields and files are unchanged; its
content holds the houses. Where a grid stands is still not stored: nothing in the product passes placements yet (the
backend's far jobs build without them); the bench does (`town-grids --far grids`, the far cache as it was kept and put
back by `restore`). Vitest (`voxel-far-grids.test.ts`, files on disk): a grid at 0° gives the world-grid house's level-0
cells and far nodes (levels 2 and 3) exactly; at 30° 0.9–1.1 of its cells, none outside its turned box; no placement or
an unlisted grid: the world grid alone.

**After** (`d/S-g30-grids/`, looked at beside W's and today's): 250 m: the grids' own rows exact, the rows past them far
bricks of the turned houses (rounded red mounds, as W's far rows look); 600 m: the town as in W's picture; 2 km: the red
patch as in W's. 100 m and 150 m: the last rows past the grids' rings now far bricks where today's pictures had none; no
house drawn twice or missing at the boundary in these pictures. **The hand-over** (about 190 m on low): a house goes from
its own exact mesh (crisp gables, kit pieces) to far bricks (rounded, darker, no gable), the same change W's houses make
between their mesh rings and the same bricks at the same distance; a pop when it happens is expected as for W
(unverified: nothing seen in motion). All three variants' far-distance shots were refused by the bench as "streaming
never settled" for G30 (W's settled; pictures taken at the 180 s timeout, D750).

**Bake** (Node in the 10G scope, the far cache's town built again: 616 kept nodes and 1,312 baked bricks' nodes over the
town's four region columns, 328 bricks built, the rebuilt-by-content store cleared before each, two runs each, 2026-11-22
11:32–11:35 UTC; raw `d/tgt-*.json`): W 17.9, 17.6 s (nodes 3.2, 3.2 s; bricks 14.7, 14.4); G30 with grids 22.2, 19.0 s
(nodes 4.4, 4.5; bricks 17.8, 14.5); G30 without 16.3, 16.2 s (2.6, 2.6; 13.7, 13.6): the 131 houses' resampling adds
about 1.2 s (9 ms a house). Bytes of the 112 files written (the town's level files and their bricks): W 8,034,643 +
46,450,749; G30 with grids 8,041,713 + 46,527,303; without 8,020,047 + 46,272,225 (the houses add 22 kB and 255 kB
turned, 15 kB and 178 kB aligned). Disk: a copy of the 781 MB far cache while the bench ran, deleted at `restore`
(`far.json` after equal to before: level 2 101,572 nodes, 40,515,263 bytes).

**Orbit** (2026-11-22 12:22–12:59 UTC, the far caches as above, `run.mjs headroom --quality low --rounds 2`, A B A B,
second rounds; raw `d/F-*.json`; load 0.7–1.8):

| | W | G30 with grids in the far cache |
|---|---|---|
| room | 128, 128 | 128, 128 |
| GPU near / far / lighting ms (resolution) | 3.91, 4.30 / 2.93, 2.69 / 3.68, 5.56 (1.1, 1.3) | 4.73, below / 3.42, 3.88 / 4.25, 5.23 (1.3, 0.6) |
| page / simulation ms | 5.61, 5.97 / 1.86, 2.24 | 6.45, 6.20 / 4.00, 4.15 |
| GPU MiB; fill s | 981, 980; 7.5, 7.3 | 1,081, 954; 17.9, 17.2 |

Read: GPU `far` 0.5–1.2 ms higher with the turned town, about the readings' resolution (0.6–1.3): not resolved.

**At a bake level of 0.5 m or 1 m** the far bricks would be built from these resampled 0.5 m cells (1 m: from them
downsampled). Looked at as plans of one two-storey house (Node, `scratch/resample-plan.ts`, `scratch/plan.py`; exact
turned cells light, resampled world cells outlined dark; `d/plan-yaw{0,30,45}-y{2,9}.png`): at 0° the same cells; at 30°
each wall a staircase of cells joined by faces, 16 % more wall cells than the wall's area (79 against 68 at the door's
height); at 45° a one-cell wall becomes a chain of cells **touching by edges only**, 28 % fewer (48 against 66.5), the
openings 20 against 27: drawn at 0.5 m it would be a row of cubes with gaps between them at a grazing view. Not looked at
in Play: the bench world is drawn at its 2 m bake level (its fine levels, baked earlier from the town as first written,
were left as they were). The near field stays the grid's own, exact.

**F-own** (far nodes a grid, drawn with its transform): not built. It needs far nodes keyed by grid (a far cache or
level files a grid: a stored layout the approved far cache format does not have: an owner stop), the far runner run a
grid, and a row a node in the culled-instance table (131 houses: at least 131 more nodes at each kept level, against
616 town nodes today); it would draw a far house exact in its turn where F-stamp draws it a cell off.

**Design note for 47a.5:** the far cache records the world's revision, not where its grids stood, so a structure moved
without its far chunks rebuilt leaves its old place in the far field. Rebuilding the chunks a structure left and entered
as part of the command that moves it (as an edit rebuilds its chunks) needs no stored field; a cache that must prove it
matches the placements would need one in `far.json` (an owner stop; not built).

**Recommendation:** F-stamp — structure grids resampled into the world's cells the far build reads — draws a town of
turned houses past their own rings as W's is drawn, for 9 ms of bake a house and +0.2–0.6 % bytes; keep it, fed from the
structure objects' placements in 47a.5; at a 0.5 m bake level a 45° wall would be edge-joined cells (not seen in Play).

### 47a.3 — the structure core

**Built** (68fbec87, b4ff1315; F1 without a piece list, F3 as approved), `@thirdlight/voxel` `structures/`, pure,
no component, op or schema change (47a.4):
- **The contract** (`generator.ts`, `StructureGenerator<D>`): `kind`, `version`, `canonical(input)`, `box(def)` (every
  cell it writes, inclusive), `chunk(def, grid, cx, cy, cz, out)` (a chunk of the structure's own grid, every cell).
  A definition carries `generator`, the version that last wrote it. Nothing in it names buildings: splines and water
  bodies sit on the same terms.
- **The record** (`definition.ts`, `StructureDefinition`): F1's fields but `world` and `grid` (47a.4's), rebuilt field
  by field (`parseStructureDefinition`), unknown fields refused, no count caps; with the plan's checks in
  `canonicalStructureDefinition` (`building.ts`). It is defined in the voxel package: project-model may import voxel
  (`tools/check-boundaries.mjs`: `project-model: { packages: ['voxel'] }`), voxel imports nothing but shared, and the
  generator reads it; 47a.4's component imports the type and its canonical form from there (no copy). Refusals name
  the field (JSON pointer) and what to change: a diagonal edge, a point on a straight run, a repeated point, an
  outline crossing or touching itself (with "use a second polygon for a wing or a courtyard's side"), an opening on
  an edge two polygons share ("inside the building at cell (15, 4) … put it on an outside wall"), past its edge's
  end, its storey or the rows between floors, over another opening, a stair step in a wall or outside its polygon,
  from the top storey, over another stair or its landing over another's hole, a generator newer than the build's.
- **The building generator** (`building-plan.ts` union and walls, `building-roof.ts`, `building-features.ts`
  openings and stairs, `building.ts` the chunk writer; each under 200 lines): polygons rasterised (a cell inside
  when its middle is), joined as a union; walls are the union's cells with an outside cell among their eight
  neighbours (one cell thick, an L's or T's inner corner cell included, so every corner is closed face to face; no
  wall inside the union, so wings that touch or overlap are one building and a ring of four polygons leaves a
  courtyard); the foundation is the ground floor's row (0) over the union and `foundationDepth` rows under it (role
  foundation, as the bench house's slab); walls rows 1 … top − 1; each upper slab (row s · storeyHeight) inside the
  walls, role floor, open over the steps that climb to it; openings are the wall's cells along their edge, role
  `opening` in the wall's material; a stair is storeyHeight − 1 steps of a row a cell, two cells wide (`at` and the
  next cell toward +x climbing along z, +z along x), then its landing on the next floor; every cell full integrity
  (15), dry. The plan is laid out once a definition object (a `WeakMap`); a chunk is table reads a column.
- **Roofs** (one cell thick, 45°, the roof mesher's stair), over the union widened by the overhang (square: eave and
  verge reach the same): **flat** at the top row; **hip** over the whole outline at once, a column's row the top plus
  its chessboard distance in from the widened outline, so an L or T gets each wing's ridge along the wing, hips at
  the outer corners and a valley from each inner corner, and a courtyard ring its inner eaves sloping in (built first
  as a hip a polygon joined by the highest: that left a gutter where an L's polygons meet; b4ff1315 replaced it);
  **gable** a polygon each, ridge along the structure's one `axis` (F1 has one), joined by the highest over each
  column, every polygon's eave and verge kept outside the walls (dropping the lower one opened the attic at an L's
  inner corner: the closure test found it). Walls rise to meet a sloped roof: a gable end (its outside along the
  ridge) to the row under the roof, an eave wall to two rows under it (the eave cell a cell out and up, as the bench
  house and the role spec's "an eave wall stopping a cell under the roof"). Shown: `work/47a.3/roofs.png` (rows x,
  columns z; rectangle, L and T × flat, gable, hip; colour the rise, black the walls; looked at) and the text maps
  `L-hip.txt`, `L-gable.txt`, `T-gable.txt`. **What a designer may call wrong:** a gable over an L or T runs every
  ridge along the one axis, so the wing's ridge crosses the wing and meets the main roof in a valley along it (an
  M-shaped pair of parallel gables, closed and drawn as planes), not a cross gable; a per-polygon ridge axis would
  need an add-only F1 field (the owner's; D752).
- **The anchor rule (one rule, `definition.ts`, `anchoredDefinition`):** a definition's numbers are its grid's cells,
  as they are; nothing translates between them, ever. Point (x, z) is the lattice corner, y = 0 is the ground floor's
  row (its slab; F2's "ground floor's top" read as 47a.1a read it), storeys up from it, the foundation into negative
  rows. A new structure starts anchored: `anchoredDefinition` moves it by whole cells so the minimum x and z of all it
  writes (eaves and overhang included, as 47a.1a's houses) are 0. A regenerate never moves it: a wider overhang, a
  deeper foundation or a wing to the west write into negative cells (one more region file across x = 0 or y = 0 in a
  stacked layout), and every stored override keeps its cell. A plain 8 × 6 m house anchored is 2 chunks (the
  foundation below row 0 is the second; the 131 town houses anchored 137 chunks), unanchored 5.
- **Regenerate** (`regenerate.ts`, `regenerateStructure`): over every chunk the grid holds, the new box's, the
  previous definition's (when given) and the overrides': writes the generated chunk (cells no longer generated
  become air), `reapplyOverrides` (the fit rule as written), then compares each chunk with what it held: the undo
  record (`ChunkUndo[]`, a chunk's changed cells or its whole image when smaller, as an edit's) and the redo (the same
  chunks after), `cells`, `fields` and `parts` for the feeds, `materialSwaps`, `kept`, `absorbed`, the misfits with
  their grid cells, the rebased overrides and the definition with the generator's version. Nothing changed: `changed:
  false`, no record (the command layer's `no_change`).
- **Capture** (`captureOverrides`): after an edit, each chunk it changed is generated alone and its overrides become
  the cells where the grid now differs (`chunkOverridesOf`); a cell put back drops its override. TLVO v2 as written
  (F3): spec §3.5 and `format-versions.md` updated in 68fbec87 (draft → 2, the file `grid-<id>/overrides.tlvo` and its
  staged write for 47a.4, the owner's note of 2026-11-20).
- **Regenerate all** (`regenerateAll`): every structure whose `generator` is below the generator's version
  regenerated, one combined report (cells, kept, absorbed, misfits; each structure's own report and undo record), the
  current ones listed and left alone (R34; the command and its one undo step are 47a.4).

**Tests** (vitest, Node; `structures/building.test.ts` 11, `regenerate.test.ts` 6, `fit-rule.test.ts` 6,
`tools/voxel-bench/structure-house.test.ts` 3): the checks above with their messages; wings (L, T, two overlapping
rectangles, a ring): every wall cell exactly on the union's outline by the test's own reading of the rectangles, the
L's inner corner cell, no wall where wings meet, the courtyard open to the sky, foundation under the union only;
every roof shape on a rectangle at both axes (rows against the 45° formula, gable ends and eave walls), and on the
rectangle, L, T and ring at overhangs 0, 1, 2 (36 buildings): a roof over every column, one 45° surface over the
rooms, **no room or attic cell reached from outside** by a 6-connected flood (closed); the hip L's wing ridge and
valley; floors, holes, steps, landing, openings, and a room reached from outside only through its openings; the same
bytes twice, the same cells at chunk edges 16 and 32 and in reversed chunk order; the anchor. Regenerate: a fresh
write then no change; **12 random houses × 6 random changes** (scale, a wing, storeys, roof, a material, an opening
added, moved, removed; 50 changes checked): regenerated = generated fresh cell for cell, undo gives the grid before, redo
the grid after; a material swap of walls, roof and floor: `fields` = material only, every cell's role, shape and
wetness and the cell set unchanged, a painted cell kept painted, a dug hole kept; capture → encode → decode →
regenerate into an empty grid gives the edited grid and the same bytes; regenerate-all with a test generator one
version on. Bench: **every town house (131, balconies off) written by the generator equals `houseVoxel`** but for
its beams (the timber rows a cell out at each storey line: not in a structure record) and the stair's landing (the
pattern leaves the floor open one cell past the top step, a cell-wide gap; the generator floors it); so the bench's
town does **not** use the package's generator (its worlds would not stay byte-equal) and is left alone; the L-house
written by one-column `fill` commands (a command a run of equal voxels) derives (world rules, a full kit) to the same bytes in every chunk round
it; the L-house's pieces are all of the catalogue's cases.

**The fit rule on the building generator** (`fit-rule.test.ts`, a 16 × 12-cell two-storey gable house; each row a
test asserting what the rule gives today):

| Case | What happens (approved rule) | Right? |
|---|---|---|
| a hole cut in a wall, the house widened (that wall moved) | the hole in the wall that stayed: kept; the cells of the hole in the wall that moved are inside the room now, where the generator makes air: **absorbed, dropped without a report**; the new wall is whole | **no**: the designer's window is lost silently. Proposal: test fit before absorption (an override is absorbed only when the generated voxel is its value *and* the base's kind is unchanged; else a misfit, reported). A hole that follows its wall needs the hole as an opening in the definition, not a per-cell override (D751) |
| a wall cell painted, then a material swap | kept, the cell stays painted (the owner's words) | yes |
| … the wall swapped to the paint's own material, then back | the paint is absorbed at the first swap; at the swap back the cell goes with the wall | **no** in a common round trip: the paint is gone. Proposal: keep a painted override whose value equals the generated voxel when its base differs from it only in material (D751) |
| a shelf inside, then a storey added | a shelf in a room that stays a room: kept; one in the attic where the new floor's slab goes: misfit (reported, not written; the floor is there) | yes |
| a window hand-cut, then the same opening added to the definition | painted as `opening` cells: absorbed; **dug** (air): a misfit for each cell (air against the generated `opening`), the cells come out as the opening | half: the result is right, the report is noise. Proposal: air and `opening` count as one kind (both open) for the fit (D751) |
| the roof changed gable → hip under a hand-built chimney | the chimney's cells in the air and in the attic: kept; where the new hip roof lies: misfit, so **the roof runs through the chimney**; where the old gable roof was (base roof, now air): misfit, so **the chimney has a hole** | **no**. Proposal: a hand-added solid (value solid, base air or roof) stays wherever the generator now makes air or roof (D751) |
| overrides on cells that leave the box (the house shrunk) | a post added outside: kept; a hole in the wall that went: absorbed; a painted cell of it: misfit | yes (the misfit report is the designer's cue) |

The rule is unchanged (an approved spec); the proposals are for the lead and the owner.

**Measured** (Node 22, i5-12600H, 2026-11-22 14:16–14:18 UTC, load 1.6–2.8, one process in an 8G scope, nothing else
running; `work/47a.3/scratch/measure.ts`, `node bundle.cjs measure && node measure.mjs`; raw `measure-4.json`; medians
of 15 (5 for the town, 7 for the regenerates); bytes at rest as a region file holds them: each chunk zstd 3 or raw, a
12-byte entry, the 64-byte header):

| | ms | chunks | cells | bytes (codec / at rest) |
|---|---|---|---|---|
| small house 8 × 6 m, 2 storeys, door, stair, gable: generate (definition and plan included) | 1.42 (anchored 0.96) | 5 (anchored 2) | 1,624 | 32,893 / 545 (anchored 20,545 / 445) |
| large L 40 × 30 m, 4 storeys, 3 stairs, hip | 8.23 (anchored 7.15) | 24 (18) | 33,804 | 172,607 / 2,557 (147,911 / 2,463) |
| the town's 131 houses (definition from the pattern, anchor, generate) | 78.4 | 137 | — | 53,274 at rest (407 a house) |
| regenerate the large L + a storey, 1,000 overrides (500 dug, 500 painted wall cells) | 30.5 | 18 in the undo record | 13,672 changed | overrides 10,040 B; kept 1,000 |
| regenerate the same with nothing changed (`no_change`) | 21.3 | — | 0 | — |
| capture after a brush dab (sphere, radius 3 cells, through a wall across a chunk face) | 0.95 | 2 | 29 | — |

A regenerate's cost is the whole grid's chunks exported, generated and compared, whatever changed (21 ms for 24
chunks with nothing changed); a chunk-local regenerate (only the chunks a change can reach) is left for 47a.4 if the
editor needs it.

**The L-house through the real derive** (world rules, a full test kit bound to every material, the two-storey L of
`structure-houses.ts`: 12 × 8 m and a 5 × 6 m wing, a door, three windows, a stair; 8 chunks): hip 1,081 pieces, gable
1,064, **none of an unknown case** (every instance's piece is a case of the world rules' catalogue, as the kit tests
read them). Hip by case: edge-in-bottom 196, edge-out-bottom 160, edge-out-top 156, edge-out-vertical 140,
roof-eave 112, edge-in-top 96, edge-in-vertical 68, roof-hip 43, corner-out-bottom 32, corner-out-top 32,
roof-ridge 19, corner-in-bottom 16, corner-in-top 6, roof-valley 5. Gable: edge-in-bottom 202, edge-out-bottom 166,
edge-out-vertical 143, edge-out-top 106, edge-in-top 99, roof-eave 72, edge-in-vertical 71, roof-gable 60,
roof-ridge 47, corner-out-bottom 34, corner-out-top 28, corner-in-bottom 22, corner-in-top 9, roof-hip 4,
roof-valley 1.

**Unverified:** anything drawn (no browser in this item: the roofs are seen as plans only, not through the roof
mesher on screen); a turned or sloped site; a generator's output in Play or an export (47a.4–47a.5); the time of a
regenerate in the backend with its staged write. **Left out** (as the brief): the component, ops, undo step,
manifest, duplicate, export, props, splines and water.

**Gates:** gate-fast-20261122-135248 RED (the build: two test files' types), gate-fast-20261122-135529 RED (Play test:
the profiler's `jobs` lane had no bars under load peak 15.2; `tracer-terrain-rings.test.ts`, D411, passed alone),
gate-rerun-20261122-141124 GREEN (Play test passed); b4ff1315 with the docs: gate-fast-20261122-142034 GREEN (756 test files, 14 e2e).

**D-rows:** D751 (the fit rule's four designer-wrong cases above, with proposals), D752 (no cross gable: one ridge
axis a structure).

### 47a.4 — structures through the commands

**Built** (4059d423; F1 and F2 as approved, F3 as 47a.3 wrote it):
- **The component** (project-model `voxel-structure.ts`, `voxel-structure-descriptor.ts`): `voxelStructure` = `world`,
  `grid`, then the voxel package's definition, rebuilt field by field there (`parseStructureDefinition`: every field
  kept, an opening's `prop` too; vitest through the whole scene validator). Add-only within project schema 8 (as 46f's
  `interactor` and 46d's material fields were recorded: the register's row names it; the number does not move). Not in
  prefabs (a grid to one object), not read by scripts (authoring data). The scene validator refuses a structure object
  under an object with a transform, at a scale other than 1, or turned off the vertical axis (**a tilt is refused, not
  dropped**: `component_conflict` naming the transform's rotation; a yaw off by up to 1e−6 in x or z passes), and two
  structures of a world on one grid in a scene. That its scene holds its world's `voxelWorld` object is the backend's
  check (the descriptor tests build scenes one object at a time). The descriptor shows the numbers, roof and materials
  as plain fields; the footprint, openings and stairs as their JSON values. **No voxel material picker**: the generic
  Inspector has no widget for a voxel material id (an int field; 47a.6's), and the Inspector was not checked in a
  browser here (left to 47a.6).
- **Ops** (the editor and MCP send the same; `tl_command`): the existing `createEntity`, `createEntities`,
  `pasteEntities` (the editor's Duplicate and Paste), `setComponent`, `setTransform`, `deleteEntity`, `undo`, `redo`, and
  one new op, **`regenerateStructures`** (`STRUCTURE_OPS` in commands; args none). The backend
  (workspace `structure-commands.ts`, `StructureCommands`) completes a structure a command brings in before the project
  command runs, in the command's own arguments: the next free grid id, the definition anchored (`anchoredDefinition`)
  and the generator's version; a definition the generator refuses is refused naming its field
  (`invalid_structure`, `/args/…/voxelStructure/openings/0/at`); a pasted copy gets a new grid. After it, the scenes'
  structures are compared by (world, grid) with before: new → written (a copy: its source's voxels and overrides),
  definition changed → regenerated, gone → its grid emptied; each world's changes are one stroke
  (`VoxelWorlds.writeStructures`: region files, `grid-<id>/overrides.tlvo` and the manifest in one staged write),
  attached to the project entry on the one undo line (`UndoTimeline`: undo takes the entry back, then its strokes;
  redo the entry, then the strokes). A refused voxel write (`world_changed`, `region_damaged`, `reference_missing`
  for a world no `voxelWorld` object of the scene names) takes the project command back and is the command's answer.
  Answers: the project result plus `voxels` (each world's stroke: `structures` a grid each with `cells`, `kept`,
  `absorbed`, `misfits` [{x, y, z, base, value, generated, at: world metres}], `fields`, `materialSwaps`) and `far`.
  Misfits are held in the backend's memory only (the last regenerate a grid; dropped by its undo or redo) and answered
  again by the world's route (`grids[].lastRegenerate`); nothing stores them.
- **Hand edits**: `editVoxels` with `command.grid` = a structure's grid is applied to that grid (a grid the world does
  not list: `grid_not_found`), its chunks answered under `grids` (never as world chunks), its overrides captured
  (`captureOverrides`) and written in the same staged write; undo and redo put the overrides file back with the cells.
- **The grid-id rule**: one above every id the world's manifest lists, the project's structure objects name, a grid
  made in this process, and the highest this backend process has given that world before; never given twice in a
  process. An undo can bring a deleted structure back only while this process holds the history, so an id is never
  reused while that is possible; after a restart the files and objects alone decide (the test: grid 2 deleted, the
  next structure takes 3).
- **Regenerate all** (R34): `regenerateStructures` gives every structure whose `generator` is older one
  `setComponent` (`entityIds`, one transaction) of the generator's version, and the diff writes them: one undo step;
  none outdated: `no_change`; outdated structures in two scenes: refused, naming the count (one step a scene). The
  Problems list says "N structures need regenerating" when a project loads (a diagnostic; nothing is written).
- **Moving or turning** is a plain transform edit: no region file or manifest is rewritten (stat'ed in the test). (a)
  The Scene view does not draw structure grids yet (47a.6); Play reads the places when it opens the world (a structure
  object moved while a game runs moves nothing: structures are authoring objects; a script moving one at run time
  moves no grid). (b) The far cache: the backend passes the objects' places to every far build and rebuild
  (`FarCacheJobs.build/rebuild` `grids`, through the worker), and after any step that moves, makes, changes or deletes a
  structure (forward, undo or redo) it builds again the world chunks the grid lay over before (remembered, read from its
  files before the step) and lies over now (`StructureCommands.followFar`, `VoxelWorlds.farFollow`). It is awaited:
  0.8 s for the small house, 2.2 s for the L (below): too slow for a drag; the editor sends a move at the drag's end
  (47a.6; D754).
- **Placements from the project**: `VoxelWorldConnection.placements` (runtime), read from the world's route in Play
  (`grids[].place`, editor `range-world.ts`) and from the catalog in an export (`grids` of the world row,
  game-host `voxel-shipped.ts`, `openGrid` from the shipped files); `?voxelGrids=` stays for the bench and places a
  world's grids over the objects' when it names the world.
- **Export**: each placed grid ships its region files and its place in the world row (`grids`, add-only; the runtime
  manifest's version does not move); the scenes ship without `voxelStructure` (`withoutStructureDefinitions`); no
  overrides file is read. Never resampled into the world grid.
- **MCP**: `tl_command` takes the same ops (its op list includes `regenerateStructures`); `tl_inspect` shows the
  component; the reference generator reads the structure ops' union (`StructureOpArgs`) and the component's descriptor
  from the build: `tl_docs` topics `op.regenerateStructures` and `component.voxelStructure` (regenerated reference).

**Tests.** Vitest `project-model/src/voxel-structure.test.ts` (every field kept through the scene validator, field
refusals by pointer, tilt/scale/parent refused, a grid to one structure, placements). Integration
`tests/integration/voxel-world/voxel-structures.test.ts` (a real backend over HTTP, the world on disk; 11 tests):
create (grid 1, anchored, files and manifest as F2, no overrides yet, voxels equal the generator's fresh output;
refusals before anything is applied); regenerate equal to fresh, undo and redo exact (every file of the world folder
hashed, the manifest's lists), `no_change`; one line across a world stroke, a rename and a roof change (undo × 3, redo ×
3, the folder equal at each step); a hand dig and a hand-set shelf on the grid → `overrides.tlvo`, a storey added keeps
the hole and answers the shelf as a misfit with its world place, listed again by the route; a material swap changes
material ids only (`fields` = material, every changed cell's other bits equal); paste → grid 2 with equal voxels and
equal overrides cells, independent after; move → no region file rewritten, the manifest's revision unchanged; a tilt
refused; delete → grid files gone, undo brings back the same bytes, the next structure takes grid 3; a grid file
changed on disk → `world_changed` and the scene edit taken back; a listed grid file gone → `etag: null`,
`region_damaged`; regenerate-all with a generator one version on (`VoxelWorlds.generator` swapped in the test: no HTTP
switch exists) → one step, undone exactly; MCP `tl_command` and `tl_inspect`. The e2e house (`voxel-grid-house.ts`) is
now a structure object of the Play project (its porch a hand `set` on its grid, kept as overrides), placed by its
object (no `?voxelGrids=`): the Play test's grid checks run on it unchanged in kind; the Export test checks the shipped
grid (its place, its files), no overrides file's digest and no `foundationDepth` in the catalog or content files, the
house drawn in the export and the character pushed at its front wall stopping before it.

What each test does with the feature broken: the scene-diff writes nothing → create/regenerate/copy/delete tests fail
on the files; the attachment off → undo leaves the voxels (folder differs); capture off → no `overrides.tlvo`; the
placements feed off → Play's and the export's house is not drawn (`far#1` 0 chunks); the strip off → `foundationDepth`
found in the export.

**Measured** (2026-11-22 15:25–15:28 UTC, load 1.4–3.2, the in-process backend over HTTP in an 8G scope, nothing else
running, 5 runs each, medians; `work/47a.4/measure-structures.test.ts`, raw `measure-1.json`, `measure-nofar.json`;
the 47a.3 houses, placed at 30° on flat ground):

| | small house 8 × 6 m | large L 40 × 30 m, 4 storeys |
|---|---|---|
| create, command / voxels apply / staged write (ms), no far cache | 20.1 / 4.6 / 7.7 | 59.5 / 39.8 / 12.2 |
| regenerate (+1 storey), command / staged write | 18.4 / 5.2 | 76.3 / 9.1 |
| duplicate (paste), command / staged write | 17.4 / 7.2 | 59.2 / 11.7 |
| undo of the regenerate | 13.3 | 21.4 |
| move (setTransform) | 5.4 | 7.6 |
| bytes at rest (region files) | 509 in 2 files (D753) | 2,527 in 2 files |
| with the world's far cache built: create / regenerate / duplicate / undo | 835 / 788 / 806 / 164 | 1,874 / 1,941 / 1,932 / 834 |
| move with the far rebuild: command / rebuild (nodes) | 1,009 / 1,002 (14) | 2,212 / 2,204 (20) |

The integration test's single runs agree (create 38–43 ms, regenerate 21–23 ms, undo 15–17 ms, no far cache). The far
follow-up is the whole of the difference; the voxels are tens of milliseconds (D754).

**Unverified:** anything drawn in a browser beyond the gate's e2e (no picture looked at in this item); the Inspector
showing the component (not checked: 47a.6); a structure on a slope; more than one scene naming a world; a fine bake
with structures (D755). **Left out** (as the brief): the Scene view drawing grids, editor tools and handles (47a.6);
`ctx.voxels` in grids (47a.5); props, `pieces`, splines, water.

**Gates:** gate-fast-20261122-152801 (every area; vitest 793 files green) RED on e2e load flakes (block-editor,
terrain-cdlod, frame-rate-cap; the Play test at the GPU measure's ballast check, before its grid checks; load peak
12.4); gate-rerun-20261122-160524 RED (the Play test: the profiler's `jobs` lane without bars, as in 47a.3; the other
three passed); gate-rerun-20261122-161039 GREEN (the Play test 2.3 min, its grid checks on the structure house:
wall stop at grid z −0.31, door in to 4.19, the room darker than the porch, a path into it); the Export test passed in
the first run (32 s; the character stopped at −0.31 before the house's wall); `area play` with the leak test
gate-area-20261122-161421 GREEN (24 passed).

**D-rows:** D753 (two region files for an anchored house in a stacked world), D754 (the far follow-up's cost on a
structure command), D755 (the fine bake and columns outside the world grid's don't see grids).

### 47a.5a — structure grids in the Scene view and in ctx.voxels

**Built** (6be74d26, ef33ad6f, 6003c541; F2 as approved, no stored thing added):
- **The Scene view draws structure grids.** Each `voxelStructure` object of the open scenes has its grid streamed in
  the view's worker (`editor/src/voxel-world/scene-voxels-grids.ts`: a streamer a grid in its world's pool under its
  job ids, the view's focus moved into its frame and told only once it moved an eighth of its gap to the grid, as Play
  does) and drawn with its world's surface and piece batches under its place (`VoxelWorldDraws` and its grid views, the
  path 47a.1a2 built). The page reads each structure's place from the object's transform every drawn frame (a gizmo
  drag's override included): a move or turn moves the grid's root and places its kit copies again in the world's
  batches (`VoxelWorldDraws.placeGrid`, `VoxelChunkView.placed`), static shadows drawn again; nothing is read or
  derived. A change the backend applied to a grid (made, regenerated, edited by hand, pasted, deleted, undone, redone)
  reaches the view by `voxelsChanged`, which now carries the grids' changed chunks (`grids`, an optional field of the
  feed event, from the command's answer): only those are read and derived again; a grid made by the change is opened
  when its files arrive; a change reaching past the box its streamer reads opens the grid again (D758). A click selects
  a structure whose cells the pointer's ray meets nearer than any drawn object (the worker walks every world and its
  grids, `walkWithGrids`; the click waits for its answer); the selection outline wears the structure's box (its
  generator's box turned into the world). No tool, handle or mode (47a.6).
- **`ctx.voxels` reaches the grid a point lies in** (runtime `voxel-grid-access.ts`), by one rule: *a point lies in a
  structure where the structure's own cell holding it is not air; everywhere else it lies in the world's own cells;
  where structures overlap, the lower grid id wins.* Reads (`get`, `materialAt`, `coverageAt`: a structure's own
  coverage, else the world's with the lit props and without the grids' stamps) answer from that grid. `raycast` walks
  the world and each grid along the ray in its own frame (`walkWithGrids`), solid and light stops (a light ray reads the
  world's props without the stamps), and says which grid it met (`grid`, 0 the world's own), the cell in that grid
  (`cell`), the voxel's centre in world metres (`at`) and the face's normal turned into the world. Changes over a region
  act on each grid's own cells whose centres lie in it: `dig` and `paint` on the world's and every structure's (a dig
  through a house's wall into the ground empties both); `set` on a structure's cells that are not air and on the
  world's elsewhere, never a world cell whose centre lies in a structure's solid cell. Order: the world grid's stroke
  first, then each structure's by ascending grid id, all one change (one id; reported once every grid's swap is in:
  `VoxelChanges` keeps swap groups by grid and group). A grid's stroke writes its overlay (spec §2.3), derives its
  chunks again, reads its stamp again (light, sun heights, rooms), and its walk links and collision body follow its
  swap. `save()` holds every grid's changes (save file v2 already keys entries by grid; each grid chunk's base hash is
  its shipped chunk's); `restore` lays each grid's entries into that grid; a save's pieces of a grid the world does not
  hold are reported in `mismatches` (`grid`, never applied, whatever the choice); a grid's base mismatch follows R60 as
  the world's does. `regionAt` names the structure whose box (its cells that are not air, as read for its stamp) holds
  the point (`grid`); the object's id is not known in an export (D756). Reference text in `voxel-api.ts` (the
  generated `tl_docs` pages, `docs/manual/reference`).
- **Rays through a town** test only the grids along their way: `GridWalkIndex` (`grid-walk.ts`) files a world's grids by
  the 16 m tiles their turned boxes cover and walks the tiles a ray's path crosses (a 2D DDA). `walkWithGrids` now
  enters a grid a millimetre before its box, so a wall on the box's face (a house anchored on cell 0) is met by its
  face with its normal (it read as started inside: distance 0, no normal).
- **D748**: walkers of another height or with drops cross at the links (a taller one only where a link's two ends have
  room for it); `reach` still searches the world graph alone (what it needs: D748).
- **Spec §3.6**: the open contract gap replaced by "Across grids, as built" (keys by grid and chunk in the jobs, no
  cross-grid apron, the grids meet through the stamp, the links, the far resample and the ray walk, what invalidates
  what); the summary's M7 line closed. No format, field or version moved.

**Tests.** Vitest `tools/voxel-bench/world-host-grids.test.ts` (a real runtime, region files on disk, worker threads,
Rapier; three houses at 0°, 30° and 45°): the rule (wall, door and room cells, the ground under, coverage 1 and 0, a
room's `grid`); rays at each yaw meet cell (4, 2, 0) at 3 m with the normal (−sin, 0, −cos), solid and light, and
through the door the back wall; a dig ball over the wall's foot empties wall and ground as one change (two chunks), a
second dig changes 0 cells, a set over a wall and the air before it changes the wall in the house and the air in the
world grid (the ray from the street meets grid 0 first); a dug wall saved (every entry grid 2, base hashes of the
shipped chunks) and restored into a fresh run of the same files; a save made before the structures existed (restored,
nothing reported, the house stands), a save restored where its structure is gone (each of its pieces reported, grid 2,
not kept; the world's pit lands), one where the structure was rebuilt (a mismatch kept). `walk-graph-links.test.ts`:
other walkers (1.5 m tall, drops of 1 m, 2 m with drops of 2 m) go in by the door, a 2.5 m walker does not.
`structure-stamp.test.ts`: the tile index meets what testing every grid meets on 400 random rays over 64 houses (a few
boxes a ray). E2E: the Scene view test (`voxel-scene-structures.ts`, called from `voxel-world.e2e.ts`'s Scene view
test, one backend) makes a house by command and finds it in the pixels, moves it by `setTransform` (pixels move,
region files' times unchanged, nothing meshed again), adds a storey (the house's top row rises), undoes with Ctrl+Z (as
before within 80 px), clicks it (its row selected, the outline wears it); the Play test casts at the turned wall
(grid 1, row z 0, the turned normal, 150 cm), digs it, walks the character in through the hole (grid z 4.19) and reads
the room's light rise. What each does with the feature broken: without the feed's `grids` the storey never draws
(timeout); without the draws' move the pixels stay; without the grid rule reads answer the world's air, rays pass the
walls, digs leave them, saves hold no grid entry; without the link fit the other walkers' paths stop at the world
graph (unreachable).

**Measured.**
- *Scene view* (2026-11-22 17:33–17:46 UTC, a 256 m slice world in a fresh e2e backend, WebGPU, 1280 × 720 page with
  the editor's panels, load 2.4–3.5 (another process on the host); the view's own stats: `data-render-ms` (its p50 and
  p95 CPU ms of a drawn frame) while the left button orbits the view for 5 s (a move every 16 ms: 149–150 frames, the
  input's rate, not a cap), and the time from the page's load to every world and grid settled and drawn; the editor
  has no frame cap; scratch spec `work/47a.5a/scratch/zz-scene-measure.e2e.ts.keep`, raw `m/sv-*.json`; no kit in the
  project, so no kit pieces):

  | houses | W: in the world grid (yaw 0) | G: structure objects (own grids, 30°) |
  |---|---|---|
  | 1 | draw 34.1 s; render 3.00 / 4.60 ms | draw 34.3 s; render 3.00 / 3.80 ms; drag 16 moves in 2.05 s, 1 ms in all |
  | 20 | draw 34.0 s; render 2.80 / 4.30 ms | draw 34.8 s; render 3.60 / 5.40 ms |
  | 131 | draw 34.1 s; render 3.10 / 3.80 ms; 364 chunks | draw 26.0 s; render 4.10 / 6.50 ms; 464 chunks, 132 draw sets; drag 16 moves, 0.6 ms in all, render 4.00 / 4.80 |

  Read: the time to draw is the world's (34 s for the slice world at this view in every run; 26 s for G131 is not
  explained: one run each); the grids add about 1 ms to a frame's p50 at 131 (2.7 ms at p95: their chunk surfaces, a
  draw a chunk); a structure's move costs about 0.04–0.06 ms a move (16 moves: the snap's steps). The G20 drag's grab
  missed (0 moves; another house under the arrow). Pictures looked at: `m/sv-g-131.json.png` (131 turned houses drawn
  over the hills), `m/sv-w-131.json.png` (the same lots aligned), `m/sv-g-1.json-drag.png` (mid-drag: the house, its
  box outline and the gizmo together away from its stored place).
- *Rays* (Node 22, `work/47a.5a/scratch/rays.ts`: 47a.1b's town box and its 72,000 rays at 30°, best of three, CPU,
  raw `scratch/rays-1.json`, load 1.1): the world alone 523.9 rays a ms; with the box's 24 grids tested 206.6, filed by
  tile 222.5 (2.63 boxes tested a ray); with all 131 town houses' boxes tested 120.2 (47a.1b: 137), filed by tile 220.0
  (2.78 tested, 1.02 entered). The index takes a town's rays back to the cost of the grids they enter.
- *Edit → light, edit → mesh* (Play, the gate's Play test, WebGPU low): the dug wall moved the room's light 800 ms
  (alone: 866 ms) after the dig command, from 0.585 to 1.593 settled (0.571 → 1.304 alone);
  `pics/grid-house.png` (before, without the volume) and `pics/grid-house-dug.png` (after, with it) looked at: the
  hole is through the front wall and into the door beside it (the world box round the turned shape, D757), the room
  inside lit, the magenta boards at the hole's new edges. Edit → screen in the grid house (the play page's edit hook, the
  dig's swap in `far#1`): 81.8 ms, the swap 50.2 ms after the command, 8 chunks (gate-fast-20261122-182413; light there
  0.597 → 1.163, moved 842 ms after the dig).
- *Saves*: the round trip and the mismatch cases are vitest (above); their bytes and time were not measured.
- *The town orbit* (the default path, no grid): 2026-11-22 17:47–18:24 UTC, `run.mjs headroom --quality low --rounds 2`, the
  head 6003c541 against base fe171617 (built in a scratch worktree with its own `@thirdlight` links, removed after),
  A B A B, second rounds, each alone (load 0.6–2.6; `work/47a.5a/measure-ab.sh`, raw `m/O-*`): room 7 (the edge search
  stopped at 7 copies in the head's first run, 0 of 89 missed at no load; the run began at load 2.6), 128 against
  128, 128; page ms 5.33, 5.67 against 6.06, 5.67; simulation 1.88, 2.26 against 2.10, 2.09; GPU `near` 3.95, 4.94
  against 4.06, 4.32, `far` 3.31, 3.75 against 2.38, 4.17, `lighting` 4.77, 4.31 against 3.92, 3.74 (resolution
  0.4–2.2 ms); fill 7.1, 7.7 s against 8.4, 8.2. Equal within the spread but the head's first room, which is not
  resolved (one run; its second is 128). No lit program was touched: the 128-lamp reading was not run.
- The Play test 2.0 min alone and in the gate (1.8–2.3 before); the Scene view test 19–20 s.

**Unverified:** medium and high tiers; WebGL 2 (its smoke test only); a turned house on a slope; anything in motion
but the drag's numbers and its one picture; exports' `ctx.voxels` in grids (the runtime is the same code; no export
test casts or digs a grid); the editor's preview beyond Play's runtime; the Inspector.
**Left out** (slice b and later, as the brief): many grids' simulation on a moving camera (D743, D745), the stamp in
one piece (D747), the far rebuild blocking commands (D754), the fine bake (D755), eave specks and corner lines (D744,
D746); `reach` across grids (D748); an object id on hits (D756).

**Gates:** gate-fast-20261122-164434 (the Scene view commit; every touched area) RED on the Play test's profiler `jobs`
lane (known flaky), gate-rerun-20261122-165707 GREEN; gate-fast-20261122-171852 (`ctx.voxels`) GREEN (Play test 2.0
min). The docs commit 6eea8f2e: gate-fast-20261122-182413 GREEN (31 e2e files; Play test 2.0 min); `area play` with
the leak test gate-area-20261122-184436 GREEN (24 passed).

**D-rows:** D748 narrowed; D756 (hits and regions name the grid, not the object), D757 (a world-box region round a
turned wall), D758 (a Scene view grid reopened whole past its box).

### 47a.5b — what structure grids cost

**Built** (d41e0c49, 7b83e3a0, d8631caf, 471d16bb, 894fb4e0, a52faa00; the lane reserve d0e1da24 and c35c4b40
backed out by 84afba6b). Work folder `~/.cache/thirdlight-phase47a/work/47a.5b/` (`measure.sh`, `final.sh`,
`cov-*.sh`, `fill.sh`, `fine.sh`, `lib.sh`, `summ.py`, `m/` every raw run and picture, `scratch/` the Node harness and
the command measure).
- **A grid's update (D743).** Node first (`scratch/grids-node.ts`, the 131 G30 houses as Play steps them, timed by
  part): an update cost 0.27 ms, 0.17 of it the level choice, which covered every chunk under its level-2 roots (313
  readiness asks an update: a level-2 node over a house's corner is 64 chunks), and the margin sections, which asked
  again on every choice whether chunks past the read box were coming. Now exact cuts: the level choice covers no node
  past the read box (`LevelChoice.extent`), the collision-only scan of the camera's ring is cut to it, and a section
  reaching past it is known stranded once (`pastExtent`). Then the plan's reach (`stream-quiet.ts`,
  `VoxelStreamer.quietReach`): how far the focus may move before any ring decision about the grid's chunks could
  change (load and unload by the read box, with the lead's length off; levels, mips and the camera's collision bounds
  by the chunks that hold cells, the air round them drawing nothing); the grid host steps a quiet grid again only past
  that or past the old share of its gap, whichever is longer. Node: 0.36 → 0.12 ms a step moving (updates 1,320 →
  594 in 1,200 steps), 0.029 still.
- **The queue (D745).** A reserve by lane (`room(lane)`, the mip lane at half, far with mip at three quarters) was
  built and measured, then backed out: see below.
- **The stamp (D747).** `GridStampSampler`: one row of world cells (an x of the turned box) a step, on while the
  derive slice lasts; the prop channel steps a stamp's sampler first in line across updates (`LitStamp.sampler`),
  props behind it waiting. The result is the one-piece stamp's bytes and classes. The grid's cells are still read in
  one piece when its chunks arrive (`gridStampCellsOfChunks`: about 3 ms for the L in Node, 0.3 ms a house).
- **The far rebuild (D754).** Edits awaited theirs too (the same `farAfter`). The chunks a command changed are now
  gathered (`voxel-far-follow.ts`, `FarFollow`) and built in one rebuild in the world's queue once none came for
  `FAR_FOLLOW_SETTLE_MS` (250 ms); the answer's `far` is `{ queued }`. The far route and an export build what is gathered
  first, so nothing reads a cache a command made stale; the far info reports the last rebuild (`follow`: changes,
  chunks, result). A structure's move reads its grid's chunks outside the world's queue. Undo and redo gather the same
  way. Lost with the process: an edit's rebuild leaves the cache at an older revision than the world's (built whole on
  the next read); a structure's move, make or delete changes no revision, so its old place stays in the far field
  (D759: proving placements needs a stored field, an owner stop). No new stored field.
- **The fine bake (D755).** The fine levels are baked and rebuilt from the world with the placed grids
  (`FarFineTask.grids`, `rebakeFarFine`'s grids, every backend call), a fine node's content key holds each grid over
  it (its place and its files' entries), and the far build's columns and rows include the grids' turned boxes, so a
  house above the world's top region or off its columns is built (the integration test found the whole build missing
  the houses' row before this).
- **The Play test's `jobs` lane (item 6).** The check read the Profiler's job lane once, seconds after the dig, when
  its two-second window could hold no job (a still scene runs none; under load the wait before the read grew): a check
  of timing. The tab now opens before the dig and the lane is polled while the dig's derives are in its window; a lane
  that never draws still fails. The GPU-measure ballast check did not fail in this item's five gates (not
  investigated).

**Tests.** Vitest `stream-quiet.test.ts` (2,400 random moves shorter than the reach change no load, unload, level,
stand-in, mip or collision decision of a box's chunks and nodes; moved three times the reach, the check fails; the
level choice cut to a read box draws what it drew without it and covers no node past it); `structure-grid.test.ts`
(a grid whose plan holds is not updated while the focus moves less than its reach, and is past it);
`structure-stamp.test.ts` (the L at 0°, 30°, 45°: sliced equals whole, one row a step when no more is asked; in the
channel it waits first in line across updates and lands as the whole stamp does); `voxel-far-follow.test.ts` (ten
changes 5 ms apart are one rebuild after the last, a read builds at once, worlds apart, a dropped world builds
nothing); `voxel-far-grids.test.ts` (fine levels 0 and 1 of the house in grid 1 at 0° equal the world-grid house's
node for node, turned they differ, content keys follow the grid's place; a grid where the world has no region is in
the columns, rows and fine bake); the far tests that read an edit's far answer now read `farSettled`. Integration
`voxel-structures.test.ts`: with a far cache, a structure made answers `queued` and its rebuild follows; ten moves
answer each with `queued` and gather (the count is the vitest's: a loaded host may split them); after undo, redo,
undo the followed cache equals a whole build of the world and its structures where they stand, file for file.

**Measured** (low, WebGPU, 1280 × 720, the 30 Hz cap, each run alone, staging, `uptime` beside each, load 1.0–2.4;
2026-11-22 20:46–23:07 UTC; head* = 894fb4e0's code with the lane reserve at half for the mip lane, c35c4b40 = the
reserve on the far lane only (the queue of the final code is the base's: the reserve is backed out); base 863c6b5a built in `work/47a.5b/base`; `run.mjs headroom --quality low --rounds 2`, second
rounds; W = the town's houses in the world grid, G30 = each in its own grid at 30°):

| town orbit | W head* | W base | W c35c4b40 | G30 head* | G30 base | G30 c35c4b40 |
|---|---|---|---|---|---|---|
| room (copies) | 128, 128 | 128, 128 | 128 | 120, 120 | 128, 120 | 120 |
| page ms; `render` | 6.50, 5.91; 4.86, 4.19 | 6.39, 6.18; 4.70, 4.49 | 5.62; 4.12 | 6.92, 6.40; 5.02, 4.71 | 6.97, 6.16; 5.27, 4.60 | 6.94; 5.11 |
| simulation ms (`voxelStream`) | 2.27, 2.01 (1.82, 1.64) | 2.39, 2.16 (1.94, 1.75) | 2.13 (1.77) | 3.13, 2.91 (2.53, 2.37) | 4.35, 4.18 (3.66, 3.52) | 3.26 (2.59) |
| GPU near / lighting ms (resolution) | 4.53, 4.36 / 4.47, 5.42 (1.4, 1.3) | 3.34, 5.23 / 3.95, 3.86 (1.2, 2.2) | 4.68 / below (4.4) | 5.25, 4.61 / 5.71, 4.99 (0.9) | 4.74, 4.19 / 5.41, 4.58 (0.8, 0.5) | 5.69 / 5.30 (2.4) |
| world piece draws; kit instances at the fill | 50, 50; 72.4 k, 72.9 k | 49, 49; 38.9 k | 49; 38.6 k | 52, 52; 65.1 k, 70.9 k | 51, 52; 49.0 k, 45.3 k | 52; 53.5 k |
| fill s | 8.5, 8.6 | 7.4, 7.7 | 8.2 | 11.8, 10.7 | 24.4, 17.8 | 13.5 |

Read: **simulation** with the town's grids on the moving orbit 1.38–1.53 × W's (2.9–3.3 ms against 2.0–2.3) where the
base reads 1.8–1.9 × (4.2–4.4): the target of about 1.3 × is missed by a small margin; what is left is the grids'
updates where a ring crosses a house (Node: 0.12 ms a step at 120 steps a second, about 0.5 ms of a 30 Hz frame) and
the skip test of 131 grids. Page ms and room as before (room 120 in G30 at both commits in some runs). The world
grid alone (W) equal head against base within the spread, but its fill 8.2–8.6 s against 7.4–7.7 with more drawn at
the snapshot (166–201 chunks against 143–147): measured with the lane reserve in (the reserve is out of the final code;
W 8.2 s at c35c4b40, one run). **Fill** with grids 10.7–13.5 s against 17.8–24.4 at the base (W 8.2–8.6).
**Time to the ground's level 0 at the street camera** was not measured as such: the headroom snapshot holds the world
grid's chunks at the fill (36–87 chunks drawn in G30 head runs against 0–28 at the base) and the coverage round's
level-0 settle after the stop is below. Grid counters (updates, skips, the stamp's steps) were not read: the
snapshot's grid diagnostics came back empty in every head run (D749's relay bound).

**The lane reserve, measured and backed out** (coverage, 150 m/s, the same hour, one round each): level 0 drawn
again after the stop (`detailS`) W 9.9 s with the mip lane at half (and 9.91 again with the seams freed), 6.1 s at
three quarters, 4.0 s with only the far lane at three quarters, 4.65 s with no reserve, base 4.5 s; nothing pending
12.0, 11.6 s with the far lane capped against 9.0–9.2 without. G30's fill: 10.4 s (far capped), 13.8 s (no reserve),
10.7–11.8 (mip at half): the same within the runs' spread. The nearest mip nodes waited behind farther ones queued
first; the fill's gain is the grids' plan fixes. Backed out (84afba6b): the queue is as at the base. A reserve that
evicts a lane's farthest queued job would be the next thing to try (D745).

**Coverage at 150 m/s** (the final code 84afba6b, one round each, 23:40 UTC; base the same evening, `m/XF-*`,
`m/Cb-*`): W longest frame 76.1 ms (base 57.7), missed 35.7 a minute (30.2), p95 38.0 (37.8); G30 56.3 (77.9), 33.8
(35.7), 37.7 (38.2); none over 100 ms; after the stop ground solid 0.03–0.04 s in all, level 0 drawn W 4.45 s (4.5),
G30 4.71 s (4.8), nothing pending W 9.08 s (8.98), G30 9.84 s (11.08); holes 0 in all. Equal within one round's
spread. At speed every grid in reach is stepped every step (the plan's reach holds only at rest): the longest
simulation frame G30 223.9 ms crossing the town, its steps' `structure grids streamed` 16.7–20.8 ms each (47a.1a2:
217 ms): D743's part at speed is unchanged. With the far lane reserved (c35c4b40) nothing pending read 11.96 (W) and
14.61 s (G30), one more reason the reserve went.

**Structure commands with a far cache** (the in-process backend over HTTP, 5 runs each, medians, the 47a.3 houses at
30° on flat ground; `scratch/zz-measure-structures.test.ts`, raw `m/cmd-head.json`, `m/cmd-base.json`; head against
base, ms):

| | small house: head | base | large L: head | base |
|---|---|---|---|---|
| create; regenerate (+1 storey); duplicate | 27; 23; 19 | 832; 766; 824 | 69; 86; 56 | 1,943; 1,978; 1,941 |
| undo of the regenerate; move | 16; 7 | 180; 944 | 22; 12 | 877; 2,181 |
| the far route right after (builds what is gathered): create, regenerate, undo, duplicate, move | 837, 762, 159, 819, 1,025 | 1–2 (built in the command) | 1,923, 1,910, 864, 2,290, 2,852 | 1–2 |

So the command answers in its voxels' and scene's time, and the far cache is current a rebuild later (unasked: 250 ms
after the last change, then the rebuild); the rebuild itself is unchanged (0.8 s a small house, 1.9–2.9 s the L).
Bytes at rest: the small house 509 in 2 files, the L 2,527 in 2 (D753).

**The fine bake, looked at** (`fine.sh`): the far cache's town built again with the G30 grids, the 0.5 m fine levels
with it (45,136 fine nodes dirty, 5,080 built, 40,056 reused by content, 138 s; kept levels 616 nodes, bricks 326 of
1,312), then from W's files (151 s), pictures `m/SF-g30/town-{150m,250m,600m}.png` and `m/SF-w/…` looked at: at 250 m
the rows past the grids' rings are the 2 m far bricks (rounded red mounds, turned; W's aligned and sharper), exactly
47a.1d's `d/S-g30-grids/town-250m.png`: the low tier does not draw the 0.5 m fine bricks at that distance, so the
pictures do not show the fine bake (the shots also refused as "streaming never settled", D750). **The fine bake of a
turned house is unverified in Play**; in Node its nodes at 0° equal the world-grid house's, and 47a.1d's plans of a
45° wall at 0.5 m (edge-joined cells) stand as the only look at it. Whether that needs a fatter rule is not decided.

**D753** (item 7): F2's "a building under 256 m is one region file" should read "one region file, or two in a stacked
world when its foundation lies below its ground floor's region": a doc correction for the lead to take to the owner;
the cost is one more region file of about 200 bytes a house (opened and read with its other file).

**D711** (item 8): met three times, each a W run's first round (11 copies at the base, 7 at the base, 15 at the final
code's first run after a rebuild); staging starts fresh for every run, the browser's shader cache state is not known;
no G30 first round was low. Noted in D711.

**Unverified:** the stamp's longest step in Play (the snapshot's grid diagnostics empty, D749); the fine bake of a
turned house in Play; medium and high tiers; WebGL 2 (its smoke test only); anything in motion beyond the numbers; the
editor's view of `far: { queued }` (nothing in the editor reads a command's `far`).

**Gates:** gate-fast-20261122-191744 RED (the light volume's glow check 0.0293 against 0.0289, D760),
gate-rerun-20261122-193525 GREEN; gate-fast-20261122-195230 GREEN (the stamp, the jobs lane, the reserve); 
gate-fast-20261122-202436 RED (a bench test reading an edit's far answer), gate-rerun-20261122-203413 GREEN (42 e2e);
gate-fast-20261122-222538 GREEN; gate-fast-20261122-234509 (the back-out and the docs; the whole vitest suite, a test file
gone) RED on the behavior API's generated typings, stale since 47a.5a's `ctx.voxels` text (a hidden drift: related-files
runs never ran their checks; generated again, 36cd31a5) and `world-host-grids.test.ts` under load (it read a room
before the sliced stamps were stitched; it now waits for a known region, d673e358); gate-rerun-20261122-235732 (every
area, 180 e2e files) RED on `project-items` (D410), `terrain-cdlod` (D643: 0.566) and `frame-rate-cap` under load,
gate-rerun-20261123-002547 RED on the first two again, gate-rerun-20261123-002930 GREEN; `area play` with the leak test
gate-area-20261123-003454 GREEN (24 passed). The Play test 2.0–2.1 min in the gates.

**D-rows:** D743 narrowed; D745 left (the reserve backed out, measured); D747 narrowed; D754 fixed; D755 fixed;
D753, D711 noted; D759 (a lost far rebuild of a structure move), D760 (watch: the glow check under load).

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

- 2026-11-21 (47a.1a; default chosen, owner to confirm): **the anchor's "footprint box" is the house's whole plan
  box** (eaves, beams and balcony included) at its foundation's row, so nothing of a house lies below cell 0 and it is one
  region file; F2's "ground floor's top" read as the ground floor's row.
- 2026-11-21 (47a.1a; default chosen, owner to confirm): until structure objects exist, **placements reach Play as a
  host option** (`VoxelWorldConnection.grids`) fed only by the page's `?voxelGrids=` bench switch; nothing a project
  stores. Each grid streamer gets the world's memory budget (no shared budget yet).
- 2026-11-22 (47a.1a2; default chosen, owner to confirm): **a streamer a grid, made cheap, not one streamer a world**:
  the cost was the grid's scans of the ring and its every-step updates, not the streamer; one streamer over all grids
  would put a grid dimension into the store, sections, mips, seams, relief and collision (§8a, 47a.1a2).
- 2026-11-22 (47a.1a2; default chosen, owner to confirm): **one memory budget a world, grids first**: the world grid's
  share is the budget less what its grids hold, so past it the world grid evicts its far edge.
- 2026-11-22 (47a.1a2; default chosen, owner to confirm): a grid is told of the stream focus after it moved **1/8 of its
  gap to the grid** (a cell at least, half the level rings' hysteresis at most); bodies every cell.
- 2026-11-22 (47a.1a2; default chosen, owner to confirm): **a grid draws with its world's surface and piece batches**;
  a grid's relief ring is not drawn (the shared surface is placed by its world's ring; relief is off on every tier).
- 2026-11-22 (47a.1b; default chosen, owner to confirm, as plan §10 question 2 allows): **a turned building's soft
  light, rooms and sun shade come from a stamp of it in the world grid** (share rule, on wherever a world has grids);
  what is seen and collided with stays the grid's own. Exact stepping stays a CPU reference for rays (47a.5), not a GPU
  walk: it would cost 2–4× the volume's rays a frame for 0.03 % fewer leaks and 12–18 % fewer doors narrowed (§8a).
- 2026-11-22 (47a.1b; default chosen, owner to confirm): **a grid cell's class for its stamp comes from its record**
  (not from its derived light stop), so a grid far past its own detail ring is stamped too; on the town's houses the
  two agree on every cell.
- 2026-11-22 (47a.1b; default chosen, owner to confirm): **the stamp's memory is the chunk's prop channel part of the
  stream budget** (15.6 MB for the town's 131 houses at low), not a new budget entry.
- 2026-11-22 (47a.1b): the Play test's grid house has a roof and a door of opening cells (a portal), so its room is a
  room; its collision and picture checks are unchanged.
- 2026-11-21 (the lead, after 47a.1a; default chosen, owner to confirm): **a slice 47a.1a2 was put before slices b–d**:
  with a streamer a grid the town's 131 own-grid houses took 129–142 ms of simulation a frame, so light, paths and the
  far view could not be measured honestly until many small grids were cheap. Built as a streamer a grid that runs only
  with work (not one streamer a world: that would add a grid dimension to every streaming module), one budget, the
  world's batches. Result: page, draws, memory and room as the world grid's; simulation still about 2× on a moving
  camera (D743's remainder, D745): accepted for now, carried to 47a.5.
- 2026-11-22 (the lead, after 47a.1b, under the owner's accepted default on question 2): **a structure grid's soft
  light, sun shade and rooms come from its stamp in the world grid, by the share rule** (the props' own: 4³ samples a
  cell, stop at half). Evidence (§8a 47a.1b; pictures `work/47a.1b/m/S-w/room-window.png` and `S-g45/room-window.png`
  looked at by the lead: the turned room is as dark as the control's, its walls a shade lighter, two thin bright lines
  at its inner corners = D746): no rule leaks through a closed turned wall (at most 7 of 24,000 rays away from
  openings), no room is lost, the GPU walk is unchanged and the frame costs as without it; exact stepping would cost
  2.3–4.2× the walk and a second loop on the GPU. The price, for the owner's page: a door or window turned 30°–45°
  passes 12–18 % less light than drawn, and surfaces the light sees are up to 0.5 m off the drawn ones. The exact CPU
  walk (`walkWithGrids`) is kept for `ctx.voxels.raycast` through grids (47a.5).
- 2026-11-22 (47a.1c; default chosen, owner to confirm): **structure grids are walked in their own walk graphs,
  linked to the world's** (R40's "walk graph per grid stitched at doors/foundations"): the world's walker is blocked by
  the grids' stamps and carries nothing there; a link reaches a diagonal (0.71 m) and one cell up or down with the
  grid's own cells clear along it; a path between graphs searches the legs of the best three doors (by straight lines)
  and takes the cheapest. The stamp walked as world cells (P-stamp) loses 4–7 of 17 turned staircases' tops and is kept
  only as a measured option (§8a 47a.1c). Other walkers and `reach` stay on the world graph alone until 47a.8 (D748).
- 2026-11-22 (47a.1d; default chosen, owner to confirm): **a structure grid is in the far field as its cells
  resampled into the world's cells the far build reads** (F-stamp: 2 × 2 points a cell, the majority of what a cell
  holds), not far nodes of its own (F-own would need a far cache layout by grid: an owner stop); a cell off at most, at
  2 m and coarser as W's (§8a 47a.1d). The placements are a build input, not stored; 47a.5 feeds them from the
  structure objects and rebuilds a structure's far chunks with the command that moves it.
- 2026-11-22 (the lead, after 47a.1c and 47a.1d; default chosen, owner to confirm): **paths use a walk graph a grid
  linked to the world's at doorsteps and foundation edges** (R40): the stamp alone loses turned stair tops (13 and
  10 of 17 upper storeys reached at 30° and 45°). **The far view takes structure grids resampled into the far
  build's input** (the cache's format unchanged); far nodes a grid would need a stored layout a grid and were not
  built. Pictures looked at by the lead: `work/47a.1cd/d/S-g30-none/town-600m.png` (no town) and
  `S-g30-grids/town-600m.png` (the town). The owner's short page: `docs/briefs/result-47a.1.md` (`acc47a-1`).
- 2026-11-22 (the lead; default chosen, owner to confirm): **F1 is built without a `pieces` list**: the owner's
  question of 2026-11-20 was answered with that offer and its default; no answer came in two further exchanges. It
  remains an add-only step.
- 2026-11-22 (the lead): a gate's Export test failed three times in this phase with "the configured exportRoot is not
  a directory" and passed on rerun; the likely cause is an agent clearing the temp folder while a gate runs. The
  agents' brief now forbids cleaning `TMPDIR` during a gate; a watch row if it recurs after that.

- 2026-11-22 (47a.3; default chosen, owner to confirm): **a structure definition's numbers are its grid's cells,
  never translated**: point (x, z) a lattice corner, y = 0 the ground floor's row (its slab), the foundation in
  negative rows; F2's anchor (cell 0 at the minimum corner of all a structure writes, eaves included, as 47a.1a) is
  applied once when a structure is made (`anchoredDefinition`), never by a regenerate, so no change of overhang,
  foundation or wings moves a stored override (a wing to the west writes into negative cells: one more region file).
- 2026-11-22 (47a.3; default chosen, owner to confirm): **the structure record's type and checks are defined in
  `@thirdlight/voxel`** (`structures/definition.ts`), the generator's reader; project-model may import voxel and
  takes the type and its canonical form from there in 47a.4 (no copy, no boundary change).
- 2026-11-22 (47a.3; default chosen, owner to confirm): **a building is the union of its polygons**: walls only on the
  union's outline (an inner corner cell included), none where wings meet, a ring leaves a courtyard; an outline may
  not cross or touch itself and has no point on a straight run; polygons may overlap, touch or stand apart.
- 2026-11-22 (47a.3; default chosen, owner to confirm): **roofs**: 45°, one cell thick; a hip over the whole outline
  (chessboard distance in from the eave: an L gets wing ridges and valleys); a gable a polygon with the structure's
  one ridge axis, joined by the highest, every polygon's eave kept outside the walls; flat at the top row; gable ends
  rise to the row under the roof, eave walls to two rows under it. A cross gable needs a ridge axis a polygon (D752).
- 2026-11-22 (47a.3; default chosen, owner to confirm): **parts the record does not name**: the ground floor's slab is
  foundation (as the bench house); an opening takes the wall's material; a stair is two cells (1 m) wide toward +x or
  +z, storeyHeight − 1 steps, the next floor open over its steps and whole at its landing; every cell integrity 15.
- 2026-11-22 (47a.3): the bench town keeps its own `houseVoxel`: the package's generator writes every plain town house
  exactly but for its beams and stair landing, so the bench worlds would not stay byte-equal.

- 2026-11-22 (47a.4; default chosen, owner to confirm): **a structure object that would tilt or scale is refused**
  (the scene validator, `component_conflict` naming the transform), not silently levelled: the command's sender learns
  why; a yaw within 1e−6 of level in x and z passes.
- 2026-11-22 (47a.4; default chosen, owner to confirm): **grid ids are never given twice in a backend process** (one
  above the manifest's, the objects', the grids made and the ids this process gave the world); after a restart no undo
  can bring a deleted structure back, so the files and objects alone decide.
- 2026-11-22 (47a.4; default chosen, owner to confirm): **the backend completes a structure in the command's own
  arguments** (grid id, anchor, generator version), so the project history holds what was applied; a structure's
  `world` and `grid` cannot be changed by `setComponent` (copy it, or make a new one).
- 2026-11-22 (47a.4; default chosen, owner to confirm): **a structure object stands in its scene's frame** (a root or
  in a folder): its transform is its grid's place as it is, never composed with a parent's.
- 2026-11-22 (47a.4; default chosen, owner to confirm): **regenerate all is a structure op** (`regenerateStructures`)
  the backend runs as one `setComponent` over the outdated structures and their voxels, one step; outdated
  structures in two scenes are refused (one step a scene).
- 2026-11-22 (47a.4; default chosen, owner to confirm): **the far field follows a structure within its command**
  (awaited, so the cache is current when the command answers); it costs 0.8–2.2 s with a far cache (D754): a drag
  sends its move at its end.
- 2026-11-22 (47a.4; default chosen, owner to confirm): **a pasted structure whose source grid is gone is written
  fresh from its definition** (its hand edits are not there to copy).
- 2026-11-22 (47a.4): the e2e house is a structure object (its porch a hand edit kept as overrides), so its grid
  layout moved by the anchor: the front wall at z = 0, the porch at −3 … 0 m (`voxel-grid-house.ts`); the checks read
  the same geometry from `GRID_HOUSE_M`.

- 2026-11-22 (47a.5a; default chosen, owner to confirm): **the grid a point lies in**: a structure's cell that is not
  air, else the world's own cells; the lower grid id where structures overlap. Reads and rays follow it; `dig` and
  `paint` act on every grid's cells whose centres lie in the region; `set` replaces a structure's solid cells and fills
  the world's cells elsewhere (never a world cell inside a structure's solid one), so a script that sets air inside a
  room writes the world grid, not the house; strokes go world grid first, then grids by id, one change.
- 2026-11-22 (47a.5a; default chosen, owner to confirm): **`ctx.voxels` names a structure by its grid id** (hits,
  regions, mismatches), not its object: the object is not tied to its grid in an export without a stored key (D756).
- 2026-11-22 (47a.5a; default chosen, owner to confirm): **a save's pieces of a structure the world no longer holds
  are reported and never applied**, whatever the game chose for a mismatch (there are no cells to put them in).
- 2026-11-22 (47a.5a; default chosen, owner to confirm): **the Scene view streams structure grids in its own worker**
  as Play does, and follows each object's transform every drawn frame (a drag moves the draws, the worker's frame
  follows when the edit is stored); a click selects a structure whose cells are nearer than any drawn object.
- 2026-11-22 (47a.5a; default chosen, owner to confirm): **rays file grids by 16 m tiles** (`GRID_WALK_TILE_M`, a
  chunk's edge), built when a world opens in Play; the editor's pick tests every grid (one ray a click).
- 2026-11-22 (47a.5a; default chosen, owner to confirm): **other walkers cross at the links**, a taller walker only where
  a link's two ends have room for it (a link is made for the default walker; its middle is not checked again).
- 2026-11-22 (47a.5b; default chosen, owner to confirm): **a command's far rebuild follows its answer**, gathered per
  world and built once no change came for 250 ms (`FAR_FOLLOW_SETTLE_MS`: under a drag's move interval, so a drag is
  one rebuild of where it ends), the far route and exports building what is gathered first; a structure move lost
  with a restart before its rebuild is not caught (D759: the stored proof would be an owner stop).
- 2026-11-22 (47a.5b; default chosen, owner to confirm): **a structure grid is planned again only when the focus
  crosses a ring its chunks meet** (or moves the old share of its gap, whichever is longer); the air round a house
  (its read box's margin) counts for its loads only, not its levels or bodies.

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
