# Plan — phase 47b: the world edit mode, the fill, fog as voxels, dressing rules and ground cover

**Status: APPROVED by the owner 2026-11-26, with the changes of that conversation (§8). A fresh session builds
it.** Branch `phase-45`. Start commit: the commit that records the approval. Next free D-number: D837.

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
| 47b.2 | done 2026-11-26: role `gas` = 10 (11 roles), its mip rule, material use `gas` (`voxel.gas`: colour, full density), the gas feed (`DERIVED_PART.gas`), spec text, derived 34. Town and hard-case row with gas in 224,397 open cells derive byte for byte as without. Besides the row: 6 places named liquid alone or assumed two media. Results §9 |
| 47b.3 | done 2026-11-26: edit command v3 (v2 read as written): `flood` (the water bodies' level fill, its role, fade and a floor as parameters; a leak refused with its places), brush modes `smooth` and `flatten` (the ground a column at a time; a gas's density), a paint that keeps roles. 30 unit tests, 2 over HTTP on the one undo line. D762 stays open for the tool. Results §9 |
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
- **2026-11-26 — 47b.2, defaults chosen, owner to confirm** (item agent): (1) **G2 read as: a coarse cell is gas when
  the mean density of its 8 cells (a cell that is not gas counting 0) rounds to at least 1, its shape that mean; and
  an opening holds a coarse cell before a gas does.** G2 names "no solid and no liquid"; with openings left out, mist
  in a doorway made the coarser cell gas, and the levels above no longer closed or measured that doorway, so the far
  field differed with the gas. With the opening first, a gas takes a coarse cell only where the same cells without it
  give air. (2) **A gas with wetness is refused wherever a value is checked** (as air with other fields is), and the
  writers that keep a role keep it dry; G1 says the bits are 0, this makes a reader hold it to that. (3) **No stored
  version moves**: record value form 2 stands (the fog note proposed a form bump; G1 says worlds before it stay
  valid, and a form bump would refuse them or need a read of both); derived data 33 → 34 (never stored). An older
  build refuses a world holding a gas cell. (4) **G3's two fields are one optional block** `voxel.gas: {color?,
  density?}` ("#rrggbb"; per metre, 0–8), white and 0.1 a metre when left out, refused on a material whose use is
  not gas; a gas names no kit; no project schema bump (add-only inside schema 8, as F1, F4 and F6 were). The range
  and the defaults are guesses nobody has seen drawn: 47b.7 may change them. (5) **The gas part is a feed bit with no
  builder yet** (`DERIVED_PART.gas` = 64; `ALL_DERIVED_PARTS` stays 63 until 47b.7): a gas-only change reads the
  changed chunks and derives nothing. (6) **Water takes fog's cells**: the level fill passes gas as air, and one
  medium written over the other feeds both parts. (7) The reference's materials page passed its size bound and the
  pages after it were renamed by the generator; 13 manual links were repointed.
- **2026-11-26 — 47b.3, defaults chosen, owner to confirm** (item agent; G4's words could be met more than one way,
  the smaller was taken each time):
  1. **The reach bounds a flood downward too**: ⌈reach⌉ rows under the cell it starts from, besides the circle round
     the seed's column a water body's reach is. Without it the cells a flood can touch are not known from the command,
     and every stroke path (the backend's load, a page's overlay, the edit worker) needs them before the first read.
     A flood counts its whole reach against the work bound of one stroke: about 120 cells (60 m) at most. A wider
     fog bank is several floods, or a later entry.
  2. **Fade**: G4's "metres under the level over which gas density falls to 0" is read as a soft top: full density
     `fade` metres or more under the level, falling in a straight line to none at the level, read at each cell's
     centre; a cell whose density rounds to none is not filled and not entered. `fade` is in metres as G4 says; the
     seed, the level and the reach are in cells like every position of the command.
  3. **A drain is the flood's own walk with air**: it passes air and every medium under the level and empties the
     media it reaches (liquid and gas alike), so the same seed and level take a flood back. In open ground it leaks
     as a flood does and is refused; fog painted on an open plain is erased with the dig brush.
  4. **What each value passes**: a liquid air, any gas and its own liquid (as water bodies since 47b.2); a gas air and
     its own gas only (a liquid and another gas bound it). A start cell the value does not pass is refused
     (`flood_blocked`) instead of answering `no_change`.
  5. **Smooth and flatten move the ground's height a column at a time**, inside the brush's own rows, by the brush's
     coverage (`smooth: true`: the soft rim's weight; `false`: all or nothing at half). Relaxing the fill of cells in
     three dimensions was tried on paper and dropped: flat ground is not a fixed point of it (every stroke blurs the
     surface cell and the air over it). Under an overhang the top surface inside the brush's rows is the one moved.
     No strength field: G4 names none.
  6. **`smooth` of a gas is chosen by the brush's existing `voxel` field** naming that gas (material and role); with no
     voxel it smooths the ground. One stroke never does both, so a fog brush cannot move ground and the gas answer
     stays the gas part alone. `flatten` takes its plane as `height` (cells), G4's "a plane's height".
  7. **Cells that are not ground**: a column whose first cell under the open ones is built or an opening is left
     whole, the ground under it too, and pulls no neighbour; ground that rises takes the material, role and wetness
     of the surface cell under it; a column with no ground in the brush's rows is left.
  8. **The paint that keeps roles is a `paint` whose voxel leaves `role` out** (v3), no new field; with a role it is
     v2's paint. D762 stays open: the command is there, structure mode's Paint still sends a role until 47b.5
     rebuilds the tool (editor tools are not this item's).
  9. **Versions**: a command keeps the `v` it was sent with (2 or 3); a build writes 3; nothing stores a command, so
     there is no upgrade step. The refusal of a leak carries `leaks` in the water bodies' form (cells in
     `EditRefused`, metres in the backend's error); they are where the fill crossed its bound, not the gap in the
     bank, as a water body's are.
  10. **The world's edge is the world's cell bounds** for a flood, the same in the backend and on a page; a water
      body's fill also stops at the listed region files. A flood on open ground at the edge of what is authored
      meets its reach, and creates no region past it.
  11. **No game API**: `ctx.voxels` gains no flood, smooth or flatten (G4 names the command only). A game's overlay
      applies them like any command if handed one.
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

### 47b.2

- **Where each entry's text went.** G1: format spec §1 (the summary's role list), §2.2 (the value table's role, shape
  and wetness rows, the role table's row 10, the bullet *Role `gas`, value 10*), the role spec §1 (its table's row
  and its solid/open lines; no case, slot or rule of that page changes), `format-versions.md` (the paragraph *The
  voxel value's roles*). G2: format spec §3.7 *Voxel mips* (the bullet *Gas*) and the render spec §4's line on
  openings at the coarser levels. G3: render spec §1 (the `voxel?` field list, `use`, `kit`, `gas`, the owner note),
  `format-versions.md` (the project schema's cell). G6: format spec §2.2 (the feeds table's row and the bullet *The
  gas rule*), §3.7 (the history's row 33 → 34 and the paragraph *Derived data 33 → 34* with the derived list's three
  entries: the surface fields a column, the gas part a derive section, cover points a chunk; each entry's layout is
  written by the item that builds it), §3.8's derived data version (it still said 32).
- **The schema step:** none. `voxel.use: "gas"` and `voxel.gas` are add-only inside project schema 8; nothing else
  stored changed (no record bit, no manifest key, no far-cache channel, no stored version). Staging's worlds stay
  valid: no regeneration.
- **The row** (`role-traits.ts`): `gas`, value 10: not a body, stops no light, blocks no walker, collides with
  nothing, medium `gas`, shape `density`, mip `share`. `VOXEL_ROLE.gas`, `VOXEL_ROLE_COUNT` 11; decoders take 10 and
  refuse 11–15 as before.
- **What reads gas as open by the row alone, untouched** (each asked the table since 47b.0): the placeholder,
  terrain, edge and world rule sets and the terrain mesher, kit cases and pieces, case forms, the roof words,
  collision, light coverage and occupancy, navigation and so the walk graph, open regions, face connectivity and sky
  columns, the shader data, the liquid part (a liquid's face toward gas is its face toward air), structure stamps,
  the grid resample, the far faces, the far ground, the far tree's uniform test, an `add` stroke (it fills gas as
  it fills air), the spline and world writers.
- **Places outside the table that had to change** (the findings the item asks for):
  1. **The change feed** (`record.ts` `changeFeeds`): it asked "air or a medium" and answered the liquid part,
     whichever medium. Converted: each medium's part comes from the row's `medium`, so air ↔ gas feeds the gas part,
     liquid ↔ gas both. `FIELD_FEEDS` (a role, shape or material change) names the gas part beside the liquid's.
  2. **The coarser levels' order** (`voxel-mips.ts`): media were tried before openings, so a gas took a parent an
     opening would have kept. Converted to one order from the rows' ranks over media and openings
     (`MIP_OPEN_ROLES`: liquid 7, opening 8, gas 9; the opening's rank was −1, and `checkRoleTraits` now asks a
     rank of every role that can hold a coarser cell).
  3. **A flag on the new part's bit** (`stream-sections.ts`): `PIECES_AT_CELLS` was `1 << 6`, the value
     `DERIVED_PART.gas` took, so a gas-only stroke read as "these cells' pieces moved" and derived its four
     sections whole. Found by the real-worker test, not by reading. The flag is `1 << 16` and the module refuses to
     load if it meets a part's bit. `SectionDerives.invalidate` also returns early for parts no derive builds.
  4. **The level fill** (`water/level-fill.ts` `fillPasses`): air or the fill's own liquid; fog in a basin was a
     wall to a lake's regenerate. It passes a gas (asked of the table) and takes its cells.
  5. **Wetness** (`record.ts`): a new cross-field rule (`heldWetness`), checked in `checkVoxel` and
     `checkRecordValue` (so in every decoder), applied in `savedValue`, the edit command's voxel parser, and the
     runtime's `set` and `paint` (`voxel-api.ts`, `voxel-world-host.ts`).
  6. **Material uses** (project-model `voxel-materials.ts`; editor): three `use === 'liquid'` tests (the rules, the
     kit badge, the kit binding), the spline tool's list of solid materials (`use !== 'liquid'`), the material
     section's kit field and a hand-written union of the three uses in `structure-shape.ts`. Converted to
     `voxelUseTakesKit` and `VoxelMaterialUse`.
  Also renamed, no behaviour: `world-writer.ts` `airOrLiquid` → `airOrMedium`.
- **The material use** (`voxel-materials.ts`): `VOXEL_MATERIAL_USES` gains `gas`; `voxel.gas` validated, canonical
  (last, colour then density, an empty look left out), merged along an instance chain field by field;
  `voxelGasLook` fills in the defaults; the descriptor (so the reference and MCP's text) and the material's Voxel
  use section in the editor (a colour and a number field, shown for a gas) carry it.
- **Tests** (new: `tools/voxel-bench/gas.test.ts`, 11; `voxel-materials.test.ts` +2; changed: `format-rules.test.ts`,
  `role-traits.test.ts`, `descriptors.test.ts`, `liquid.test.ts`):
  - conformance: the row; values 10 held and 11–15, a wet gas and a reserved bit refused (values, voxels, palette
    bytes packed and uniform, commands); a chunk of gas through the codec, the store and a `set`; a save's kept gas
    dry on a wet base; the mip cases (eight cells, half, densities 1–8 → 5, a summed density of 3 → air and of 4 →
    1, two materials; ground, a thin wall, a floor, water, a little water and a doorway each as without the gas;
    ground or water too thin to hold → gas); the feeds (air ↔ gas, density, material, liquid ↔ gas, ground dug
    beside gas; six stroke kinds on a made bank); the level fill through fog; the material use (round trip,
    inheritance, defaults, eight refusals).
  - **the proof the row names** (5.8 s): the town (96 cells square: ground, ponds, houses to their upper floors)
    and the hard-case row's arch and cave, gas written into 224,397 open cells (106,673 and 117,724; banks 4 cells
    across with gaps, a density a cell, two materials; 4,848 + 6,770 on ground, 163 over water, 2,486 against
    walls, 16,771 + 2,028 under cover). The same bytes with and without: 208 derive sections by consumer (mesh and
    pieces, collision, navigation, light stop, occupancy, open regions and sky columns, shader data, liquid faces),
    the walk graph made from them (15,922 + 8,688 standable cells, pieces, exits), 10 mesh-ring nodes at levels 1
    and 2, the far faces at 2 m and at one 1 m corner, 1,024 far ground columns (read from stored node bytes as the
    worker reads them; the last three for the town only). The coarser levels: every cell that is anything without
    the gas is the same with it; a cell that is air is air or gas, a gas cell's density the rounded mean of the gas
    under it (kept: 12,183 + 13,893 cells at 1 m, 1,247 + 1,758 at 2 m, 126 + 212 at 4 m).
  - **with real workers and region files** (`liquid.test.ts`, slow list, run once here: 40 s, green): a gas stroke
    over a lake across four chunks answers the gas part alone, derives nothing (no event, no counter moves), and
    every section standing equals a fresh derive of the world with the gas.
  - **Broken on purpose, each run once:** the gas ranked before the opening → the doorway case red; the shader
    data keeping a gas's material → 108 sections' shader data differ; the far faces not skipping gas → far faces
    differ; the far ground standing on gas → far ground differs; the flag on the part's bit (as found) → four
    sections derived.
  - **over HTTP** (`tests/integration/voxel-world/voxel-world.test.ts`): a gas `set`, a change of its density and
    material, and their undos each answer the gas part alone; a geometry change answers every part, the gas part
    among them (127: the test compared the 63 a derive builds).
- **Gate:** `tools/gate.sh check` once: RED in 250 s (build 25 s, lint 9 s, unit 189 s: 963 files passed, 2 failed;
  boot 5 passed, 27 s). Both failures real: the behaviour API's generated typings were not regenerated for the new
  use (`node tools/gen-behavior-api.mjs`), and the command route's test expected 63 for a geometry change's parts
  (two more tests of that file failed after it, on the state it left). Fixed in 496c249b. `check --failed` once:
  GREEN in 58 s.
- **Not built, and why:** the gas part's faces (47b.7), the surface fields (47b.4), cover points (47b.9): their
  entries are in the spec's list only. No stroke kind (47b.3): gas is written with `set`, `place`, `add`, `dig`.
- **Left as it is, to know:** (1) a gas-only edit leaves the coarser levels and the backend's far cache as a
  liquid-only one does (D782, D783, both rows extended). (2) No command checks a stroke's material use against the
  role it writes (none does for liquid): a gas material can be written as a wall, and the structure and spline
  panels list it among materials as they list liquids. (3) A gas material's shader family reads `standard`, and
  `ctx.voxels.materialOf` answers its use but not its look: 47b.7's. (4) The descriptor size ledger's bound rose
  389,600 → 390,200 with its line (the gas look, 0.6 KB), as each field before it.
- **Unverified:** the material section's two gas fields were not looked at in a browser. Nothing draws gas, so
  there is no picture.

### 47b.3

- **The command, as built** (`edit-command.ts`; spec §3.3 *Stroke command v3*; `format-versions.md`):
  - `{v: 3, grid, kind: "flood", seed: [x, y, z] (integer cell), level (cells), value: {material, role}, reach
    (cells ≥ 0), fade? (metres > 0, a gas only)}`. The value's role must be a medium by the traits table (`isMediumRole`:
    liquid, gas), or `{material: 0, role: 0}` for a drain; a body role, an opening, a fade on a liquid or a drain are
    refused (`invalid_args`).
  - `brush` gains `mode: "smooth"` (no `voxel`: the ground; a `voxel` naming a gas: that gas's density) and
    `mode: "flatten"` with `height` (cells; no `voxel`). `smooth: true` is their soft rim.
  - `paint` (brush, fill, stamp): `voxel: {material, wetness}` without `role` keeps each cell's role.
  - `v: 2` is read as before and stays 2; it is refused the additions. `VOXEL_EDIT_VERSION` 3, `VOXEL_EDIT_VERSIONS`
    [2, 3]. Refusals added: `flood_leaks` (with `leaks`), `flood_blocked`.
- **The level fill** (`water/level-fill.ts`): `LevelFillSpec` gained three optional fields, `role` (left out: a
  liquid), `fade` (cells; a gas) and `floor` (the lowest row); `fillPasses(v, spec)`, `fillShape`, `fillValue`,
  `fillTopRow` and `fillRole` carry them, and `walkFill` and `levelFill` are the same two functions for a water
  body and the stroke. `water/body.ts` and the workspace's `voxel-water.ts` are untouched. **Water bodies unchanged,
  shown two ways:** `level-fill.test.ts` (20 tests, bodies and follow-ups) passes untouched, as do
  `voxel-water.test.ts`'s seven over HTTP; and `level-fill-roles.test.ts` keeps the walk as it was written with the
  liquid inside it and compares it with the new one on 300 made worlds (rolling ground, pools of the same and
  another liquid, fog, openings, a roofed corner, a world's edge or a wall): status, start, cells, values, breaches
  and their order are equal in all 300, with and without the role named (filled, breached and blocked all reached).
- **Apply** (`edit-apply.ts`, `edit-surface.ts` new): a flood, a smooth and a flatten are computed whole from the
  voxels before the stroke and written with `writeCells` (the water bodies' writer), their undo record the existing
  cell deltas a chunk: no new record form. The cells each can read are its `editBounds` (the flood's reach box;
  a smoothing brush's box one cell wider), so `editChunks` loads them in the backend, a page's streamer requires
  them resident, and the edit worker is sent them: the same `applyEdit` on every path, a structure's grid by
  `command.grid`. The backend's refusal passes `leaks` in metres (`VoxelWorldError.leaks`).
- **Tests** (new: `packages/voxel/src/edit-strokes.test.ts`, 25; `water/level-fill-roles.test.ts`, 5; one test
  added to each of `tests/integration/voxel-world/voxel-world.test.ts` and `voxel-water.test.ts`):
  - flood: a basin to a level with liquid (300 cells, the level's row at 8/15, the liquid part alone) and with gas
    (full density; with a fade of 1 m densities 15, 11, 4 up a column; the gas part alone); a drain takes each back
    to the first bytes; a breached basin refused with places just past the reach and nothing written, filled once the
    hole is closed; the reach met sideways and down a shaft (the leak the one cell under the floor); the world's
    edge (every place `world`); a blocked seed; water through fog, fog on water; `editBounds` and `editChunks` from
    the command; a reach of 4,000 over budget; a chunk not loaded refused; a structure's grid.
  - smooth: a 4-cell cliff relaxed (largest step 4 → under 3, the profile still in order, nothing overshoots, far
    columns untouched, volume kept within a fifteenth of a cell a moved column, a second stroke never rougher);
    flat ground unchanged; a wall's column and a slab's columns byte for byte as before; a gas bank's edge thinned
    into the air beside it, density kept within a tenth, ground and another gas untouched, the gas part alone.
  - flatten: a mound to the plane (every column exactly 4); a pit raised with the ground's material, wetness and
    role; a soft rim (a column 0.475 covered moves 3/15 of a cell toward a plane 0.4 away; hard, it stays); only
    inside the brush's rows; a wall standing in the ground keeps its whole column.
  - paint without a role over terrain, wall, roof, liquid and gas cells: material and wetness change, role and
    shape stay, the gas stays dry; with a role, v2 and v3 write the one role.
  - every kind through `proven`: a twin world gives equal cells and equal chunk bytes, the undo gives the first
    bytes back, the redo the second. v2 strokes give the same voxels sent as v2 or v3.
  - over HTTP: eight strokes on a made world (liquid flood, fading gas flood, drain, gas flood, gas smooth, ground
    smooth, flatten, role-keeping paint), each the oracle's voxels read back through the range route, its `parts`
    as expected (a gas flood and a gas smooth answer 64 alone); a leak refused 400 `flood_leaks` with `leaks` in
    metres, the revision unmoved; `flood_blocked`; a body role and a v2 flood refused by field; then nine undos and
    eight redos on the project's line, each state byte for byte. Beside a water body: a drain of its water is
    written again by the body in the same stroke; fog flooded over the lake stays where it was when the bank is dug
    back, the lake's shore follows.
  - **Broken on purpose, each run once:** the fade ignored → 2 red; the floor ignored → 2 red; a role-less paint
    writing a role → 1 red; a leaking flood written anyway → 3 red; smooth reading its own column only → 2 red; a
    liquid fill not passing gas → 2 red (the 300-world comparison among them); a built column treated as ground →
    first green (the test's plane lay on the ground), sharpened, then 1 red.
- **Reference**: `tl_command`'s text (`tool-docs.ts`) and the generated pages (`node tools/gen-reference.mjs`:
  `FloodEdit`, `FloodValue`, `BrushEdit`, `VoxelEditCommand`); the types page passed its size bound and split
  (`types-s-w.md` → `types-s-v.md`, `types-v-w.md`), six manual links repointed. The behaviour API typings were
  regenerated and did not change. Manual: `features/voxel-worlds.md` (flood, smooth and flatten, paint).
- **Gate:** `tools/gate.sh check` once: RED in 248 s (build 26 s, lint 6 s, unit 189 s: 965 files passed, 2 failed;
  boot 5 passed, 26 s). (1) Real, this item's: `tools/manual-links.test.mjs`: the reference's type pages are cut by
  size, the new types moved `MaterialDef` to the next page and one guide's link pointed at the old one (the links to
  the renamed last page had been repointed, this one not looked for); repointed. (2) Not this item's code:
  `corrupt-project-startup.test.ts` threw `RangeError` in the shared worker and passes alone. Cause measured, not
  guessed: its document is nested 4,000 deep and the strict JSON parser reads about 4,100 levels before the stack
  ends while it is not yet compiled, about 8,400 once it is, so its answer was the files before it, which two new
  unit files moved. The file now runs in a process of its own (`ISOLATED_FILES`, with why), and the product's side
  is **D836** (the parser's recursion has no bound; a deeper document takes the startup scan down). `check
  --failed` once: GREEN in 33 s (5e5465ac). The two HTTP files grew by about 4 s together.
- **Not built, and why:** a strength for smooth and flatten, a 3D smooth of overhangs and cave walls, a flood wider
  than the work bound of one stroke, a flood on `ctx.voxels` (none named by G4; lines for after the merge). The
  structure tool's Paint still sends a role (D762, 47b.5).
- **Unverified:** nothing was looked at in a browser (no tool draws these yet, and gas is not drawn before 47b.7).
  A flood through a page's streamer and through the edit worker runs the same `applyEdit` but was not run there.
  Smoothed ground was judged by heights, never seen meshed.

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
