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
| 47a.0 | Done 2026-11-21 (docs only, no gate): baseline at 58fac9ba (§8a; page ms at 128 lamps +2 ms against 46e.19, the 128-lamp room unusable). D740 not fixed: the surface WGSL equal in loads, samples, loops; `level0` equal at both commits, so the extra is the coarse levels' read meeting other data; D740 rewritten |
| 47a.1 | (a) done 2026-11-22 (0980318c…42363e34). (b) done 2026-11-22 (3627dc6b, 06ecc288): grids stamped into the world's light, mips, sun heights, rooms (share rule, on): 0–7 of 24,000 rays leak through closed turned walls, 12–18 % through doors stopped, rooms 24/24, interiors dark as W; exact stepping 2.3–4.2× CPU rays, not on GPU. D746, D747. c–d not started |
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
