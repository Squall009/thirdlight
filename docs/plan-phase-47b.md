# Plan — phase 47b: the world edit mode, the fill, fog as voxels, dressing rules and ground cover

**Status: APPROVED by the owner 2026-11-26, with the changes of that conversation (§8). A fresh session builds
it.** Branch `phase-45`. Start commit: the commit that records the approval. Next free D-number: D836.

The roadmap's line (owner, 2026-11-12): "**47b World edit mode**: one mode on the brush kit in the Scene view;
fields derived from voxels; the height-based fill for water and fog; the fog role and fog painting with a plain
look; material dressing, scatter rules and vegetation rules as one item."

The owner's decisions it builds (register, 2026-11-12): "One unified underlying voxel system that everything is
based on from terrain, to building grids, water system, material and physics, fog, vegetation rules derived from
the voxel and material id." Water = liquid-role voxels; fog = a new non-solid role, fill bits as density, material
id as fog type; "both painted with the voxel brushes and one shared height-based fill". Vegetation: "rules from
the material are the default; a hand-placed tree is an ordinary prop that rule plants keep clear of; density by
material variations"; two reserved bits stay unspent.

**The owner, 2026-11-26, on the order from here:** the plan sticks through 48 and the merge to main, which is the
priority; nothing more is inserted before the merge; what comes up is noted for after it. Trees, rocks and every
large static object are not in this phase: they are the next phase's (**47p, props in the world**, `roadmap.md`),
where they are stamped into the voxel data.

Research inputs, frozen by this plan: `docs/research/derived-fields-and-shared-tools.md`, `fog.md`,
`vegetation.md`, `water.md`. Where this plan differs from them, this plan stands (§8).

## 1. Where things stand (read 2026-11-26)

- **No way to edit a voxel world in the editor.** The edit-mode shell has prefab, terrain, block, structure,
  vertex paint and decal; no mode applies to a `voxelWorld`. Structure mode digs, adds and paints single cells on
  its own grid. The separate voxel world page digs and adds a 1 m sphere on a click. Everything else is
  `tl_command editVoxels` by hand.
- **Strokes that exist** (`@thirdlight/voxel` `edit-command.ts` v2): `brush` (sphere, box, cylinder; place, add,
  dig, paint; a soft rim), `fill` (a plain box), `stamp`, `set`, `dig`. No smooth, no flatten, no level fill as a
  stroke. The level fill exists as one pure function for water bodies (`water/level-fill.ts`), with the liquid
  role written into it.
- **Roles**: 10 of 16 values of the record's 4 role bits are assigned; no gas or fog role. Each consumer compares
  role ids itself: liquid is special-cased in 14 separate places (`voxel-engine.md` §2 "known limits").
- **Derived fields**: none as a service. Sky columns and sun heights exist; height and slope for scatter exist
  only for heightfield terrain and block layers.
- **Materials**: the voxel block of a material has `use` (construction, terrain, liquid), kit, tiling and
  surfaces. No dressing field.
- **Vegetation**: nothing grows on a voxel world. The rule scatter core (`scatter.ts`), point-set ground cover as
  rows of the culled-instance table, wind and the interaction field exist and are generic; their only sources are
  the retiring terrain and block layers.
- **Fog today**: distance and height fog in the fog node, 16 unlit fog boxes a scene. The far field takes the
  fog node at its hit's depth.
- **Tests** (47T): `tools/gate.sh check` about 4 min; `tools/gate.sh phase` about 29 min once at the close, with
  the 28 pictures. Behaviour is proven by unit tests; looks by pictures.
- **Files to split before they grow**: `workspace/src/voxel-worlds.ts` (1,909 lines), `project-model/src/index.ts`
  (1,879), `runtime/src/runtime.ts` (1,857).

## 2. What exists at the end

A person opens a scene with a voxel world, presses the world mode, and can: raise, dig, smooth and flatten
ground with brushes; paint materials and wetness; fill a hollow with fog to a height and paint or erase fog by
hand; make a lake by clicking in a basin (a water body, as 47a built them); and see grass, flowers, reeds and
pebbles appear on the ground by the rules of the materials they painted, changing as they sculpt and paint.
Every one of these is the same `editVoxels` command an agent sends through MCP, on the one undo line.

A game reads the same derived fields a rule reads (`ctx.voxels`), and Play and an export show the same fog and
the same cover in the same places as the editor. A new voxel role costs one row of a table.

## 3. Scope

**In:** the items of §5.

**Out, with where it goes:**
- **Trees, bushes, rocks and every large static object**: **47p**. There they are stamped into the voxel data
  under a `prop` role, so light, paths, collision and the far bricks see them. 47b's dressing format already has
  the large class; its entries are placed by 47p.
- Stamps voxelized from models at import: **47p** (they are how a prop gets its voxels).
- Lit fog, the density march, painted fog seen at distance, the interactive ground fog, froxels: **51**. 47b's
  fog is a plain look near the eye only.
- The water surface shader, far water, flow, queries, buoyancy: **49**.
- Draw rings, LOD stages and smooth fades between them, ground cover past the detail ring: the rings phase
  after 51 (`roadmap.md`), tuned on the demo scene's real assets.
- The GPU field windows of the research (camera-centred field textures): their first consumer is 49's and 51's
  shaders; built there.
- Distance to a tagged spline as a rule condition: dropped. A road is a voxel material, so "nothing beside a
  road" is the distance-to-material-edge condition.
- The stairs tool in structure mode (D775), pillar and terrace options: 47c's plan decides.
- The world map, the full MCP guide and the manual's voxel chapter: **47c**. 47b writes the reference entries
  and one manual page a feature.
- Engine code of block layers, heightfield terrain and their scatter sources: **48** removes it; 47b adds a
  voxel source beside them and touches nothing of theirs.
- Painted 2D layers, fog splines: dropped by the owner (register).
- Main and the game repos.

**Known limitations at the end of 47b** (owner, 2026-11-26: noted, not fixed here):
- Ground cover ends at the detail ring (about 45 m on the low tier, 64 m at medium), because it is made from
  full-detail chunks. The rings phase after 51 decides what the ground shows past it.
- Painted fog is drawn inside the detail ring only, and is absent from the far data (G2).

## 4. Format entries (approved with this plan, 2026-11-26)

Each is add-only. The exact spec text is written in 47b.2 from these lines; anything a builder finds it needs
beyond them is a stop for the owner.

| # | Entry | What changes |
|---|---|---|
| G1 | **Role `gas`**, value 10 (`VOXEL_ROLE_COUNT` 11) | One more value of the existing 4 role bits (16 values, 10 used): no bit is added to the record. Non-solid. Shape = density in 16 levels (0 none, 15 the material's full density). Wetness and reserved bits 0. A cell is solid, liquid or gas, never two. Worlds written before it stay valid. |
| G2 | **Mip rule for gas** | The far field is drawn from coarser copies of the world (cells of 2 m, 4 m and up), each coarse cell holding one value, a solid winning it. Gas adds nothing to a coarse cell that holds a solid; with no solid and no liquid, a coarse cell is gas when its share rounds to one, its shape the mean. So fog lying on the ground is lost from the 2 m copy up, as shore water is today: no painted fog in the far field until 51. |
| G3 | **Voxel material use `gas`** | A fourth use beside construction, terrain and liquid, with two fields for the plain look: colour and full density (per metre). 51 adds its lighting and simulation fields. |
| G4 | **Edit command v3** | A stroke kind `flood`: a seed cell, a level, a value (material and a non-solid role), a reach in cells, an optional fade (metres under the level over which gas density falls to 0). Refused, naming where it leaked, when it meets the reach or the world's edge. Air as the value drains. Two brush modes: `smooth` (relaxes the surface, or gas density, under the brush) and `flatten` (toward a plane's height). A `paint` that keeps each cell's role (D762). v2 commands read as before. |
| G5 | **`voxel.dressing` on the material record, and the dressing asset (format 1)** | A material names one dressing asset. The asset is its own file: an ordered list of species entries, each a model, a class (cover or large), density, spacing, scale and yaw ranges, alignment, a seed and conditions. 47b places the cover class; the large class is stored and placed by 47p. Project schema bump with an upgrade step that adds nothing. |
| G6 | **Derived data, never stored** (add-only entries of the derived list) | The surface fields a column; a gas part a derive section (as the liquid part); cover points a chunk. A change only between air and gas, or of a gas cell's density or material, feeds the gas part alone (F7's rule extended). |

The two reserved bits held for vegetation density stay unspent. Nothing else in an approved spec changes. The
`prop` role is 47p's entry and is not built here.

## 5. Items (the contract; status goes in §6)

Order inside an item: schema and commands, then runtime, adapter and host, then editor, exporter, tests, docs.
Each names its foundation (`voxel-engine.md` §6) and how it is proven.

| Item | Builds | Proven by |
|---|---|---|
| 47b.0 | **Opening.** The three.js release check and its assessment (no update). The three files of §1 split where 47b will add. **The role traits table**: one table in `@thirdlight/voxel`, a row a role: drawn as a body, stops light, blocks walkers, collides, is a medium (liquid, gas), what its shape bits mean (fill, level, integrity, density), how it wins or loses in the coarser levels. Every consumer asks the table and none compares role ids; the GPU light walk reads the same rows as a 16-entry lookup; a build check refuses a role comparison outside the table and the files that own a role's own behaviour (the liquid part, openings as portals, stairs). Behaviour unchanged. | unit: all 16 values through every consumer; the old checks' answers against the table's on the test worlds; the build check's own test |
| 47b.1 | **The defects 47T's pictures placed here.** D827 (the broken band of slabs on near ground from 250 m), D825 (the Profiler opened during a running Play never answers), D831 (the wire grid beside a structure in the Scene view), D832 (the bench's dig after its last shot fails). Each found, then fixed or restated with its cause. D829 (gaps under stepped gables) looked at for a day at most. | unit tests at the cause; pictures L16, E1, E6 before and after, read by an agent |
| 47b.2 | **Formats and the gas role in the data** (G1–G3, G6's list): spec text, the role as a row of the traits table, the mip rule, the material use. By the table every consumer reads gas as open: mesher, kit cases, collision, occupancy and light, navigation, sky, far faces and ground. | unit: conformance tests; a world with gas derives the same meshes, collision, walk graph and light stop as the same world without it |
| 47b.3 | **Stroke kinds** (G4), foundations 2 and 5: the level fill takes its role and fade as parameters (one function for water bodies and the stroke); `flood`, `smooth`, `flatten`, role-keeping paint; apply, undo and redo, the leak report; `tl_command` reference text. | unit: each kind on made cases (a basin, a breached basin, a slope smoothed, a mound flattened), deterministic, undo exact; over HTTP in Node |
| 47b.4 | **Fields derived from voxels**, foundation 1: `surfaceFields` once in `@thirdlight/voxel`, in a block form (a column: height, slope, material, role, sky, wetness, water top and depth, gas bottom, top and density, distance to another material's edge, distance to construction) and a per-point form (cave floors and storeys answer right). Run on level 0 in the derive workers and on the 2 m far nodes (the far-ground decode widened), never stored. `ctx.voxels` gains the per-point read. | unit: every field on made cases; the 2 m result against the 0.5 m result of the same ground within a stated tolerance; page and worker alike |
| 47b.5 | **The world edit mode**, foundation 8: a scene-scope mode on a `voxelWorld` in the edit-mode shell; one voxel brush tool on the Scene view (cursor on the world's lattice or a structure's, the worker's pick, dabs thinned to a spacing, one command a stroke, the view re-derives through today's change feed); rails **Sculpt** (add, dig, smooth, flatten) and **Paint** (material palette with variants, wetness, the brush kit's noise mask). Structure mode's hand edits use the same tool. | unit: the tool with a camera, a stand-in canvas and a fake pick (as `structure-tool.test.ts`): a drag is one command of thinned dabs; picture E7 (the mode, a sculpted hill) |
| 47b.6 | **Fill, water and fog tools in the mode**: a **Fill** rail: fog to a level (click a point, drag the level, a fade; leak markers as water bodies have; drain), water by creating a water body at the click (47a's, so it follows later ground edits); fog paint, erase and smooth density on the Paint rail when a gas material is picked; a rail entry that starts a road, path or river spline. | unit: the tools as 47b.5; picture E8 (a hollow filled with fog, a leak marked) |
| 47b.7 | **Fog's plain look** (G6's gas part): each derive section's gas faces against air as one more mesh of the chunk's draw, the material's colour, see-through by density, unlit by lamps, no shadow cast, inside the detail ring only; a density overlay in the editor. In Play and exports as in the editor. A world without gas compiles nothing. | unit: the gas part's faces and the narrowed feed; pictures L23 (a fog bank in a hollow by day), L24 (the same from inside); cost recorded |
| 47b.8 | **Dressing and rules** (G5): the dressing asset and its commands, `voxel.dressing`, variants through material instances; the rule conditions (material, role, slope, height, sky, wetness, water depth, distance to a material's edge, distance to construction, noise with its own scale and seed) as one arithmetic written once; a voxel source for the scatter core (`ScatterSurface` over the per-point fields); rule plants keep clear of hand-placed props. | unit: the evaluator on the research's examples (grass, reeds in shallows, moss in caves, flowers at a verge, a fringe where a wall meets ground, nothing under a foundation, clear of a prop); same answer on page and worker |
| 47b.9 | **Ground cover on voxel chunks**, foundation 6: cover points a chunk from the derive workers (never stored), as rows of the culled-instance table through the existing point-set path; wind and the interaction field as they are; a chunk's cover made again with its mesh after an edit or a dressing change; a budget a tier. | unit: points for a made chunk, stable under an edit elsewhere, gone under a road material; pictures L25 (a meadow), L26 (reeds at a shore); headroom recorded with cover on |
| 47b.10 | **Authoring the rules**: a Dressing card on the material (species, class, density, conditions) with the Scene view as the live preview; the world mode's **Rules** rail (what grows here and why not: the conditions at the cursor); a starter dressing in the engine's basic kit (game-ready placeholder cover plants, reported with triangle counts, LODs, texture and file sizes); manual pages for the mode, fog and dressing; the reference entries. | unit: the card's commands; the "why not" answer; picture E9 (the card beside a meadow) |
| 47b.11 | **Close.** `tools/gate.sh phase` once; the pictures (28 and the new ones), each opened and read; one independent review; fixes; the end reading against 47T's performance report; `voxel-engine.md` brought up to date; the acceptance page with at most five questions. **Stop. 47p is not begun: its plan is written first.** | the phase run; the review; the page |

**If the phase runs long, cut in this order** (each a logged decision, never a silent one): the density overlay;
D829; the Rules rail's "why not"; the fog smooth-density brush.

## 6. Progress

| Item | Status |
|---|---|
| 47b.0 | done 2026-11-26: three.js still 0.187.0 (nothing newer); the three files split (1,909 → 1,347, 1,879 → 1,303, 1,857 → 1,730 lines); the role traits table (`role-traits.ts`, 16 rows) asked by every consumer, `tools/check-role-traits.mjs` in the build (10 owner files); 688 derived digests equal before and after. Results §9 |
| 47b.1 | done 2026-11-26: D827 (the far march wrote the edge ring's pushed depth into its own target), D825 (the first profile read over the bridge's 1 MiB bound, no cursor), D831 (the Scene view's grid 1 cm under the floor), D832 (33 debug commands declared, a game holds 32) found and fixed with tests; D829 restated: wall-top fill is off by design. L16, E1, E6 clean. D835 opened. Results §9 |
| 47b.2 | not started |
| 47b.3 | not started |
| 47b.4 | not started |
| 47b.5 | not started |
| 47b.6 | not started |
| 47b.7 | not started |
| 47b.8 | not started |
| 47b.9 | not started |
| 47b.10 | not started |
| 47b.11 | not started |

## 7. How this phase is run

- **Tests** (`AGENTS.md` "Tests and the gate"): unit tests at the boundary each item changes; `tools/gate.sh check`
  once an item, at its end (within an item a commit is green on the build and the unit files it touched);
  `tools/gate.sh phase` once, at 47b.11. A red is fixed or the test goes. No pixel or timing bound is written.
  **Budget: 11 checks at about 4 min and one phase run at about 30 min, about 75 min** (the owner's hour, over
  by a quarter: §10 question 4's default).
- **Pictures**: seven join the fixed list (E7–E9, L23–L26), 35 in all. An agent opens each and writes what it
  sees; the owner looks; nothing is called verified that nobody looked at.
- **Performance is recorded, never a gate**: the headroom reading on the town with cover on and with a fog bank
  in view, beside 47T's report. Soft targets from the research, to guide the tier budgets: cover at most about
  1.2 M triangles and 100k clumps in view on the low tier; cover and fog together within the frame at the 30 Hz
  cap on the Iris Xe (unverified on this host: it is not the target GPU).
- **Agents**: one at a time, in the foreground, with a written brief (the item's row quoted, out of scope, how it
  is checked, what to report); no timers; a `progress.txt` in `~/.cache/thirdlight-phase47b/work/<item>/`; each
  green part committed and pushed at once.
- **An interim page after 47b.7** (the mode, the fill and fog are usable then): pictures and a short note on the
  review page, no stop. The owner can open the editor and try the mode from there on.
- **Art**: the starter cover plants are game-ready assets made with the art pipeline's rules (triangle budget,
  baked normals, LODs, compressed textures), reported with their counts and sizes.
- **No scope is added in the phase.** What comes up is a line in `roadmap.md` under "noted for after the merge"
  (owner, 2026-11-26).
- **Estimate**: 20–28 hours of agent time. The uncertain parts: 47b.0 (how many places compare roles) and 47b.2
  (what a new non-solid role still touches after the table), 47b.9 (the first plants on voxel ground), and
  D827's cause.

## 8. Decision log

- **2026-11-26 — where this plan departs from the research notes** (lead; confirmed with the plan): no GPU field
  windows yet (no consumer in 47b); no spline-tag distance (the material-edge distance serves); cover from
  worker point sets through the existing culled-table path, compute placement left for later; the fog role's
  first look is a see-through mesh, the march left to 51; the gas material carries two fields only; the liquid
  fill in the editor makes a water body, never a one-off stroke, because the owner wants shorelines to follow
  ground edits (register, 2026-11-12).
- **2026-11-26 — 47T's defects placed** (owner's default of acceptance question 4): D827, D825 first, with D831
  and D832, in 47b.1; D829 looked at there. Left open with their reasons: D826 (the bench already handles it),
  D828 and D830 (far-field looks: with D808 and D692, the owner accepted these kinds for now), D833 (fixed
  waits: replaced where an item touches the file), D834 (the far field's transient budget: the performance
  pass).
- **2026-11-26 — the owner's changes to the proposed plan** (in conversation with the lead; register):
  1. **Large static objects are stamped into the voxel data**, not placed as a separate system: a `prop` role
     whose cells the near mesher skips (the object's own model is drawn there) while light, paths, collision and
     the far bricks read them, so a forest shows in the brick far field at no new draw path. Its own phase,
     **47p**, right after 47b; the proposed 47b.10 (large plants) left this plan.
  2. **Collision of props from the voxels**, cheap and rough, accepted for now; mesh colliders for a forest are a
     line on the performance page to measure.
  3. **The role traits table** (47b.0), so a role added later costs a row: the owner asked for the consumers'
     process to be made to take new voxel types without touching each of them.
  4. **A prop's colour in the far bricks is its cells' material ids**, as terrain's is; no new colour path.
  5. **Overlays**: a prop's voxels are a generated overlay over the base world, composed where the editor reads
     chunks and flattened at export, never authored voxels. Built in 47p for props; splines move onto it in 48
     when the old terrain splines are removed; structure grids keep their own lattice (a turned building cannot
     share the world's) and share the workflow, not the storage. No general layer stack that an edit targets.
  6. **Draw rings, LOD stages and fades are a phase of their own after 51**, tuned on the demo scene's assets;
     until then props turn to voxels where the bricks begin (about 45 m on the low tier) and ground cover ends at
     the detail ring: known limitations.
  7. **The order sticks through 48 and the merge; nothing more is inserted before it.** The demo scene stays at
     48 (its assets are being made ahead; its scenes and rules wait for the merged version).
- **2026-11-26 — 47b.0, defaults chosen, owner to confirm** (item agent): (1) **an unassigned role value reads as
  plain open space** in every consumer (before, each fell through differently: solid to the mesher's fill, a wall
  to the placeholder rules, open to the kit cases). No stored cell can hold one (decoders refuse it), so no world
  changes. (2) **The table refuses a row whose light stop, walkers or collision differ from "drawn as a body"**:
  level 0 derives all four from one class, so such a row would be read wrongly without an error; 47p's `prop` row
  needs the derive to carry them apart first, and removes the refusal then. (3) **The roof's special handling is a
  predicate in the roof's file, not a column** (it is the roof's own form, as the item's row allows). (4) **The build
  check reads `packages/*/src` only**: tests and `tools/voxel-bench` may compare roles.
- **2026-11-26 — 47b.1, defaults chosen, owner to confirm** (item agent): (1) **A profile answer over the bridge's
  bound loses its oldest frames**, never the newest; the kept long frames (spikes) are sent over the next reads, none
  lost. So the Profiler opened on a running Play starts with a timeline shorter than four seconds and fills within
  them. The bound itself (1 MiB) stands. (2) **The Scene view's grid sits lower the farther the camera is** (the
  farthest corner's horizontal distance ÷ the focal length in pixels; 9 cm from the yard overview, a centimetre up
  close) instead of being drawn another way; from far off it is that much under a floor at y = 0, which nobody
  sees. (3) **D829 is restated, not fixed**: wall-top fill off is the kit format's approved default; turning it on for
  the bench town is data (a roof kit), turning the default is the owner's. This is also the phase's second cut, used.
  (4) **Picture E6 now opens the Profiler on the settled Play** (the case that failed), not before Play starts.
  (5) **The bench's cameras are one debug command with an argument**; the engine's limit of 32 declared commands a
  game stands (a declaration past it is a log line, as before).
- **2026-11-26 — the proposed plan's five questions** (§10): 1 answered by the owner (two phases: 47b ends at
  ground cover, 47p follows); 5 answered (stamps go to 47p; the forest edge is 47p's and the rings phase's);
  2, 3 and 4 not answered one by one: their defaults stand under the roadmap's rule for unanswered defaults.

## 9. Results

(one section an item)

### 47b.0

- **three.js release check (2026-11-26):** `npm view three version` answers 0.187.0, the pinned version (its
  version list ends at 0.187.0; the registry entry last changed 2026-10-30). Nothing newer exists, so there are
  no release notes to read against `docs/three-upgrade-checklist.md`: no hook, pixel or fix to assess. three
  stays at 0.187.0; no update was made or proposed.
- **Splits** (pure moves; public exports unchanged; dede5a0c): `workspace/src/voxel-worlds.ts` 1,909 → 1,347 lines
  (the manifest in `voxel-world-manifest.ts` 158, the answers and the open world's state in `voxel-world-answers.ts`
  390, the kit test scene's write in `voxel-kit-scene-write.ts` 64); `project-model/src/index.ts` 1,879 → 1,303 (the
  names of block layers, terrain, splines, scatter and architecture in `index-level-building.ts` 582: the index is
  only re-exports, and those retire in 48); `runtime/src/runtime.ts` 1,857 → 1,730 (`RuntimeArgs` and the timing steps
  in `runtime-args.ts` 153, the voxel worlds' wiring in `runtime-voxels.ts` 70). The stroke path itself
  (`VoxelWorlds.apply`) stays in the class: it reads a dozen private members and 47b.3's kinds are added in
  `@thirdlight/voxel` (`edit-command.ts`, `edit-apply.ts`), not there. `ctx.voxels` already lives in
  `runtime/voxel-api.ts` (672 lines) and the material's voxel block in its own project-model module: 47b.2, 47b.4 and
  47b.8 add there. `tools/size-ratchet.json`: no entry changed (`RuntimeInstance` keeps its 147 members).
- **The role traits table** (392f086f): `packages/voxel/src/role-traits.ts`, no imports, 16 rows. Columns: `name`,
  `body` (drawn as a body), `stopsLight`, `blocksWalkers`, `collides`, `medium` (none, liquid, gas), `shape` (none,
  fill, level, integrity, density), `portal`, `frame` (the placeholder rules read beams and rails from it), `mip`
  (how it holds a coarser cell: cells, fill, share, gap, never) and `mipRank`. `record.ts` checks at load that the
  rows are its role ids and that no row past `VOXEL_ROLE_COUNT` is assigned. Gas (47b.2) is one row: `medium: gas`,
  `shape: density`, `mip: share` with a rank after liquid's (the test builds that table and reads its lookup).
- **Consumers converted** (87 role ids named on 59 lines in 27 source files, hand-made role lists among them): record
  (construction, fill level, integrity, the narrowed feeds), the placeholder rules' classes, the terrain rules' fill,
  the terrain mesher, kit cases, edge cases, case forms, roof words, kit rules, the liquid part, shader data,
  structure stamps, grid resample, open regions, the mips (priority, whole-cell bodies, the medium fallback as a loop
  over the media by rank, the opening fallback), far faces, far ground, far tree, edit strokes, the world and spline
  writers, the kit test scene's list; workspace water (two sites); runtime portals; the editor's edit label.
  `OPEN_ROLE` moved from `assembly.ts` into the table's module (made from the rows).
- **The GPU light walk tests no role** (found, not changed): `voxelWalkWgsl` reads the occupancy and cover words the
  CPU derives (from the classes the table now feeds), and no WGSL or TSL in three-adapter reads a role. So there was
  nothing to convert; the 16-entry lookup the row asks for exists, made from the same rows (`roleTraitBits`: a 16-bit
  word a column; `roleTraitsWgsl`: the consts and `role_has`), tested against the rows, and **read by no shader
  yet**. It was not added to the walk's text: unused there, it would only change stored WGSL digests.
- **Disagreements between consumers, kept as they were:** (1) the placeholder rules read beams and rails from the
  construction roles but the roof, the kit cases from all six: the `frame` column. (2) The far ground reads every
  cell that holds a material and is not a medium as ground, an opening's too, where collision reads only bodies:
  `!isMediumRole` there, not `roleCollides`. (3) A structure stamp stops light by half coverage (a block by its
  integrity's coverage, ground by half its fill) while the mesher's surface is at the iso: each keeps its own rule
  under `roleStopsLight`. (4) The editor's local edit label calls every filled cell that is not ground "built", a
  liquid too. (5) The roof is special in the mips, the far faces, the far tree and the kit rules: one predicate in the
  roof's own file (`isRoofRole`; the mips' `isRelaidRole`), not a column.
- **Behaviour unchanged, measured:** a one-off run on the tree before and after (the same test file, the packages
  stashed for the first run): 688 digests of everything derived from the town (128 m, with ponds, houses, openings),
  the hills (lakes) and the hard-case row, each chunk under four rule sets (placeholder, terrain, edges, world), its
  sections, the mips to level 3 under two, the far bricks from faces at two scales, and the value-level answers:
  **0 differ**. The worlds hold eight of the ten roles (no pillar, which shares its row's answers with the
  foundation but for its rank; air trivially).
- **The build check** (b82e5c27): `tools/check-role-traits.mjs`, a step of `npm run build` (1.4 s, 1,719 files).
  Owner files and why: `record.ts` (the format's constants), `role-traits.ts` (the table), `roof-words.ts` (roof:
  the roof's own form), `voxel-mips.ts` (roof: laid again at each level), `kit-cases.ts` (the six construction roles:
  the case vocabulary by name), `kit-case-catalogue.ts` (roof: its edge cases), `edge-cases.ts` (the six: piece order),
  `structures/building.ts` (the generator writes each part's role), `water/level-fill.ts` and `water/body.ts`
  (liquid). Openings as portals and stairs needed no entry: their files ask `isPortalRole` or only write.
  Scope: `packages/*/src`, no tests; `tools/voxel-bench` is not scanned (benches build worlds and compare roles).
- **Tests** (17 new): `tools/voxel-bench/role-traits.test.ts` (8: the rows against the record; 21 consumer
  questions for each assigned role against the old expression kept in the test; the six unassigned values through
  every consumer; whole-value consumers over every role, shape and material; the mips on made cases; the lookup and
  a table with a gas row; a broken table refused; every cell of the three cached worlds, 32 distinct values, against
  the old checks) and `tools/check-role-traits.test.mjs` (9: what counts, what passes, the owner list, the tool run
  on a failing and a passing checkout, this repository). Two rows broken by hand (wall and foundation ranks swapped;
  the roof made a frame role) each turned the first file red.
- **Gate:** `tools/gate.sh check` once: RED in 245 s (build 26 s, lint 9 s, unit 184 s: 961 files passed, 1 failed;
  boot 5 passed, 25 s). The failure was real: `tools/gen-reference.test.mjs` reads `VoxelWorldOpArgs` by file path and
  the split had moved it; the generator now names `voxel-world-answers.ts` (16c03bc0). `check --failed` once: GREEN in
  37 s.
- **Not done, and why:** the role spec has no pointer to the table (an approved spec is not edited for it; the
  design page carries it). `AGENTS.md` does not name the new check (the rules page is the lead's to change).

### 47b.1

Each defect was reproduced or read from 47T's pictures first; the diagnostic pictures and logs are in
`~/.cache/thirdlight-phase47b/work/47b.1/` (`before/`, `diag1/`, `diag2/`, `diagE1/`, `pictures/`, `pictures-e6/`).

- **D827, fixed (4ef43983).** A diagnostic run of `town-250m` with the near and the far field hidden in turn
  (`diag1/town-250m-near-hidden.png`, `-far-hidden.png`) showed the band in the far field alone: at that camera the
  near field draws houses only, no ground. Cause: the far bricks' visibility march wrote, as its depth, the near
  cover's edge-ring push (`FarCover.behindNear`: a depth behind all of the near field) into the far field's **own**
  target, whose depth sorts far hits against each other and holds nothing of the near field. An edge-ring hit so lost
  to every far node box behind it, which the ray enters under its surface and shades as the ground's inside (grey
  rock, dark where the sun field calls it shaded). The edge ring is normally the load ring's rim, with near geometry
  in front. From 91.5 m up the load cylinder's floor (96 m under the eye) put the near set's lowest chunk layer, all
  air and so an edge ring, on the ground: the slabs are where the coarser far surface rises into that layer, a band
  along the ground's contour, with node boxes' straight edges. At 150 m (56 m up) the layer is under the ground, at
  600 m no near chunk is drawn. Fix: the march writes the hit's own depth; the shade (which already pushed the kept
  hit when writing the frame's depth) is unchanged. Test: `voxel-far-view.test.ts`, the march's WGSL holds no
  `farBehindNear`, the shade's and the in-frame march's do; with the old line the test is red. Not fixed: the march
  shading in the frame (`?farPass=direct`, the comparison path) has one depth for both jobs and keeps the fault.
- **D825, fixed (d850dc30).** Cause: not the 2 s wait the row guessed. The panel's first read on a running Play is
  the page's full rings (120 frames a thread, up to 128 spans each, and up to eight kept long frames with their own
  frames): 1.3 MB on the town against `BRIDGE_PROFILE_RESULT_MAX_BYTES` = 1,048,576. The preview's bridge refused its
  own answer and sent an error in its place; the panel showed "the play page did not answer", kept no cursor and
  asked for everything again every 500 ms. Opened before Play, the first read is small and the cursor is set. The
  same happened to a panel paused past four seconds on a busy world. Fix: `fitProfileReport` (game-host): a read over
  the bound keeps the newest frames of all threads (a run back from now) and sends spikes oldest first in at most
  half the room, the cursor's spike count stopping at the last sent; `preview/profile-answer.ts` applies it to every
  answer. Tests: `profile-view.test.ts` (a real `PageProfile`: fits, newest kept, every spike arrives over the next
  reads, the cursor ends at the page's) and `profile-answer.test.ts` (full rings across a real `Bridge` pair: the
  read as it is comes out as the refusal error, the fitted one arrives with its cursor; without the fit the second
  half is red).
- **D831, fixed (741e4b04).** The grid is the Scene view's own (`ViewGround`: 20 m round the origin, a
  `GridHelper` a centimetre under y = 0), nothing of the structure: the house's footprint happens to cover part of
  it. The yard's ground top is exactly y = 0 (measured from the derived mesh). With the drop set to 25 cm the grid
  was gone (`diagE1/`), so its lines are depth tested and too near the floor: a line's pixels take their depth along
  the line, up to a pixel off the pixel's centre, and on a ground seen at a slant one pixel is (horizontal distance ÷
  focal length in pixels) of height: 7 cm at the overview's 35 m. The dark square under the grid has a slope-scaled
  polygon offset and stayed hidden, which is why only lines showed. Fix: `viewGroundDrop`, set before each frame.
  Test: `view-ground.test.ts` computes, by ray and plane, the line's range a pixel off against the floor's at the
  grid's corners from eight eyes; the fixed centimetre fails it from the overview and from 6 m over the origin.
- **D832, fixed (f613b2b3).** Cause: `MAX_DEBUG_COMMANDS` = 32 a game. `lightShotsSource` declared a command a
  camera (28 since 47T's picture cameras), the day's three, the L room's one, and only then `region_dig`: the 33rd,
  refused by the runtime with a log line, so the call after the shots was `game_command_invalid`. The lamp walls, the
  glow commands and the edit digs came after it and were lost the same way in such a run. Fix: one `shot` command,
  the camera's name its argument (`shotCall`). Test: `lighting-cameras.test.ts` transpiles the fullest script and
  steps it against the runtime's own `DebugCommands`; with a command a camera it throws "at most 32 debug commands
  per game". Seen: the pictures' day run now ends `exit 0` with "room wall dug → region changed" (102 ms, 4 steps).
- **D829, restated (about 15 minutes).** Not a mesher fault: the open triangles are what a roof without wall-top
  fill is specified to show (`voxel-kit-format.md` §3.9, default off; plan-46c "what shows when off"), and the bench
  town's roof material is in none of its kits, so nothing can turn it on there. The row now says so and what closes
  them (data, or the owner's default).
- **Pictures** (one run of L2, L16, E1, E6, 213 s, then E6 alone, 102 s; low tier, WebGPU; L2 was added so the day
  run makes D832's dig):
  - **L16** `pictures/L16-town-250m.png` (streaming still after 4.4 s; the light volume keeps no brick). Before
    (`before/L16-town-250m.png`): a curved band of grey and dark-green slabs across the ground in front of the town
    and an arc at the bottom edge. After: the ground is one unbroken green surface from the bottom edge to the town;
    no slab, line or arc. `diag2/town-250m.png` shows the same with the near set as 47T had it (56 level-0 chunks).
    Still wrong: the far ground is flat-coloured with faint contour ripples on the slopes behind (D830). Sure: high.
  - **E1** `pictures/E01-editor.png` (the Scene view settled). Before: a dark wire grid on the grass behind and
    beside the house. After: plain grass there; the house, its gizmo, the lake and the lane as before. Sure: high.
  - **E6** `pictures-e6/E06-play-profiler.png` (settled after 98.5 s): the Profiler opened on a Play at frame 2,810
    shows "Play running · low tier · cap 30 fps · 100 frames", page and simulation bars across the timeline, the
    frame's spans and "Spikes 8". Before, opened this way, it showed "the play page did not answer" (47T's probe;
    47T's E6 itself was taken with the tab opened first). The first run's E6
    (`pictures/E06-play-profiler-UNSETTLED.png`) shows the same filled Profiler at frame 3,439, but its Play had
    not settled its light volume in 120 s (D835), so that run was RED. Still wrong: the job workers' lane is empty
    (nothing was being derived; D799 not looked at). Sure: high for the Profiler answering, low for anything in
    motion.
  - L2 `pictures/L02-room-window.png`: the dark room as in 47T (not this item's).
- **Seen and not placed:** in `diag2/town-150m.png` a dark-green rectangle about a house lot wide lies on the middle
  street, in the picture before the fix too (`diag1/`); 47T's L15 read does not name it. Not traced.
- **Unverified:** nothing was seen in motion; the Profiler on a Play paused past four seconds and resumed (the unit
  test covers its read); the grid from under the ground or in a view at a render scale under 1; `?farPass=direct`.

## 10. The proposed plan's questions and how each stands

1. **One phase or two?** Two: 47b ends at ground cover; 47p (props in the world) follows with its own plan.
2. **Fog's first look**: a flat-coloured, see-through volume near the eye, gone past the detail ring, with no
   light or drift until 51. The default stands: accepted.
3. **A fog fill does not follow later ground edits** (a lake does, as a water body). The default stands:
   accepted; a regenerating fog body can come with 51.
4. **Test time is about 75 minutes**, against the hour, at one check an item. The default stands: accepted for
   a phase this size.
5. **Stamps from models, stairs, trees past the load ring.** Stamps and trees are 47p's; the stairs tool is for
   47c's plan; how far anything is drawn as a model is the rings phase's.
