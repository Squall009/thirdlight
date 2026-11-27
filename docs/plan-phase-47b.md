# Plan — phase 47b: the world edit mode, the fill, fog as voxels, dressing rules and ground cover

**Status: APPROVED by the owner 2026-11-26, with the changes of that conversation (§8). A fresh session builds
it.** Branch `phase-45`. Start commit: the commit that records the approval. Next free D-number: D849.

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

### 5b. Increment after the close (owner, 2026-11-27)

The owner, on reading the acceptance page: "We want the fog brush. That does need to be built with the world editor
phase that just happened so please plan on doing another dot increment … DO NOT RERUN the full gate. Just build the
tool and note it needs tested after the merge." And of the fill's 63 m bound (D850): "This needs solved during this
pass as well", by a fill "based on geometric shape like dragging a large cube of fog around the world so the undo
only has to act on the cube".

| # | Entry | What changes |
|---|---|---|
| G7 | **A gas brush on the edit command** (approved by the owner 2026-11-27: "We want the fog brush") | Add-only to command v3's brush: a mode that writes a gas into open cells only (air, or a gas), each cell's density the brush's `density` (1–15) times its coverage under the soft rim, never lowering what is there; and its erase, which lowers gas cells' density by the coverage and touches nothing else. Brush shapes, size and points as the other modes. v3 commands written before it read as before. |
| G8 | **The fog body record** (PROPOSED 2026-11-27; built only on the owner's yes) | A `fogBody` component on a scene object, as the water body's record is: a box (the object's position, a size in metres), a gas material, a density (1–15), an edge fade in metres (density falls to none toward the box's sides and top). Its voxels are the open cells inside the box, written by the backend from the record and written again when the box changes or the ground in it is edited; never exported as a definition (its voxels are). No leak: a fog body is not contained. |

| Item | Builds | Proven by |
|---|---|---|
| 47b.12 | **The fog brush** (G7): the brush mode and its erase in `@thirdlight/voxel` (parse, apply, undo and redo, the narrowed feed: the gas part alone), the reference text; the world mode's fog brush sends it (paint and erase by the soft rim, no cell lists, no read of the view's copy, the 8 m cap gone); D838 and D840 closed. No phase run: `tools/gate.sh check` once; to be tried by hand after the merge. | unit: the mode on made cases (open cells only, coverage as density, never lowering, erase touching gas alone), undo exact, over HTTP in Node; the tool with a fake pick; picture E8 retaken |
| 47b.13 | **The fog body** (G8, after the owner's yes): the component, the backend's writer (a chunk at a time, outside a stroke's undo budget, one undo step with the scene edit, written again by ground edits in its box), the world mode's Fill rail makes one by a drag and the Inspector edits it; the flood stays for small hollows. D850 closed by it. | unit: the writer on made cases, a box wider than 200 m, a ground edit inside it, undo; over HTTP in Node; a picture |

**If the phase runs long, cut in this order** (each a logged decision, never a silent one): the density overlay;
D829; the Rules rail's "why not"; the fog smooth-density brush.

## 6. Progress

| Item | Status |
|---|---|
| 47b.0 | done 2026-11-26: three.js still 0.187.0 (nothing newer); the three files split (1,909 → 1,347, 1,879 → 1,303, 1,857 → 1,730 lines); the role traits table (`role-traits.ts`, 16 rows) asked by every consumer, `tools/check-role-traits.mjs` in the build (10 owner files); 688 derived digests equal before and after. Results §9 |
| 47b.1 | done 2026-11-26: D827 (the far march wrote the edge ring's pushed depth into its own target), D825 (the first profile read over the bridge's 1 MiB bound, no cursor), D831 (the Scene view's grid 1 cm under the floor), D832 (33 debug commands declared, a game holds 32) found and fixed with tests; D829 restated: wall-top fill is off by design. L16, E1, E6 clean. D835 opened. Results §9 |
| 47b.2 | done 2026-11-26: role `gas` = 10 (11 roles), its mip rule, material use `gas` (`voxel.gas`: colour, full density), the gas feed (`DERIVED_PART.gas`), spec text, derived 34. Town and hard-case row with gas in 224,397 open cells derive byte for byte as without. Besides the row: 6 places named liquid alone or assumed two media. Results §9 |
| 47b.3 | done 2026-11-26: edit command v3 (v2 read as written): `flood` (the water bodies' level fill, its role, fade and a floor as parameters; a leak refused with its places), brush modes `smooth` and `flatten` (the ground a column at a time; a gas's density), a paint that keeps roles. 30 unit tests, 2 over HTTP on the one undo line. D762 stays open for the tool. Results §9 |
| 47b.4 | done 2026-11-26: `surface-fields.ts` (16 values a surface; the block form is the kernel at each column's top, the per-point form answers caves and storeys), a `surface-fields` job at level 0 and on the 2 m nodes (`farGroundFields`), `ctx.voxels.surfaceAt`. Never stored, no derive part, run when asked: 8–9 ms a chunk column. 2 m against 0.5 m within stated tolerances. Results §9 |
| 47b.5 | done 2026-11-26: the world mode (Edit world on a `voxelWorld`; Sculpt: add, dig, smooth, flatten; Paint: palette with variants, wetness, noise mask) on one voxel brush tool the structure mode's hand edits now use (D762 fixed). A drag is one v3 command of thinned dabs at the release. E7 read; a real pointer drag changed the ground. D837 opened. Results §9 |
| 47b.6 | done 2026-11-26: the Fill rail (fog to a dragged level with a fade and a reach, one `flood`; a leak refused and marked; drain; Water makes a water body), the fog brush on Paint (a `set` or `dig` of the cells it names, so ground and water stay; smooth) and a Splines rail, all on the one tool. No command or stored thing added. E8 read; fog is not drawn before 47b.7. D838–D840. Results §9 |
| 47b.7 | done 2026-11-26: the gas part (hull quads with the density behind them, and runs; the quads shared with liquid; derived 35) and its plain draw: flat colour, opacity from the scene's depth behind each face, a screen-wide layer with the eye in a bank, a density view in the world mode. In Play, exports and the Scene view. L23, L24, E8 read; cost not resolved (about 1 ms). D841. Results §9 |
| 47b.8 | done 2026-11-27: the dressing asset (format 1: ordered species, cover or large, ten conditions) as a resource file, `voxel.dressing` through instances, `setDressing` / `deleteDressing`, a recorded schema step; the rules' one arithmetic with "why not"; the voxel source of the scatter core (a chunk's point sets, same bytes in a worker); props kept clear. D842, D843. Results §9 |
| 47b.9 | done 2026-11-27: cover drawn on voxel chunks: a `voxel-cover` job a chunk column after its chunks' draws (the pool's background queue, never before a mesh), sent in the draw batch, drawn as point sources of the point-set path (rows of the culled table); made again by the feeds, dressings, stamps and static props; a memory entry and a slice a tier. L25, L26 read. D844–D846. Results §9 |
| 47b.10 | done 2026-11-27: the Dressing card on a material (pick, create, clear; species and the ten conditions, each edit the dressing's command), the world mode's Rules rail with "why not" built (the rules' own answer at the cursor), four starter cover plants and the dressings Meadow, Shore, Gravel in the Basic Kit, manual pages. E9, L25, L26 read. D847, D848. Results §9 |
| 47b.11 | done 2026-11-27: review (nothing stored beyond G1–G6; D849–D851); one phase run, 2,287 s: unit and boot green, RED on pictures (33 of 35: E8 the script's, fixed and retaken; L3 the cave, D852, open); 35 pictures read, 30 with something wrong; test time 87.5 min of 75; `acceptance-47b.md` published, five questions. 47p not begun |
| 47b.12 | not started (increment, owner 2026-11-27) |
| 47b.13 | waits for the owner's yes on G8 |

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
     fog bank is a later entry (corrected at the review: a second flood meets the same reach and is refused as
     the first, so an open hollow wider than about 120 m cannot be filled; D850).
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
- **2026-11-26 — 47b.4, defaults chosen, owner to confirm** (item agent; the row names the fields, these say what each
  means where it could be read more than one way):
  1. **Computed when asked, kept nowhere, no derive part.** No consumer reads the fields before 47b.8 and 47b.9, so
     no chunk's derive makes them and no bit joins the parts mask: a `surface-fields` job answers a chunk column (the
     derive workers' pool), `ctx.voxels.surfaceAt` reads a point. The feed is a constant a consumer checks
     (`SURFACE_FIELDS_FED_BY`: mesh, shader, liquid, gas), so a gas- or liquid-only edit still derives nothing.
  2. **A surface is any body cell with an open cell over it**; the block form answers each column's highest, the
     per-point form the one under the point (in it, or up to four open cells, 2 m, over it; water and gas are passed
     at any depth, so a swimmer reads the bed).
  3. **Height is the row plus the fill** (a block: whole), as the coarse floor and the smoothing strokes read ground,
     not the mesher's vertex.
  4. **Slope is the ground's**: degrees, from the four columns beside. A column where a block stands within 2 m over
     the surface is left out (grass grows to a wall's foot); a cliff of ground is steep; ground more than 16 rows (8 m)
     up or down a column is left out as a wall is.
  5. **Sky is yes or no**, read from the cells over the surface (a body or a structure's stamp closes it). How much
     sky light arrives is the light volume's. `surfaceAt` reads the cells, not the stitched sky heights, so it is
     never behind an edit; it reads as far up as chunks are loaded.
  6. **Water** is the run of liquid cells standing on the surface; **gas** the lowest bank over it of one material,
     its density the mean of its cells. Both name their material (two values the row does not list, kept because a
     game asks which liquid it stands in; with the surface cell's row, 16 values in all).
  7. **The two distances are measured on the surface's own sheet**: between column centres, searched and capped at
     8 m; a column `d` away counts within `d` rows of the surface (its surface nearest in row for the material; any
     construction cell there or up to 2 m higher). So a cave's floor does not read the meadow over it. It is a cone,
     not a walk along the ground: a storey 4 m up reads the ground outside from 4 m off, ground steeper than 45°
     leaves the sheet, and a block more than 2 m overhead is not near to the ground under it. A walk over the
     surface was weighed and left: its answer would depend on how much of the world the asker holds.
  8. **Construction is a block role or a structure's stopping stamp.** The world's cells see a structure only through
     its stamp (off by up to a cell on a turned house, as light is); a stamped cell is closed and never a surface of
     the world's (no ground under a house's floor). A structure's own surfaces are read in its own grid alone, which
     holds no ground: on a house's floor the nearest other material is the house's.
  9. **`surfaceAt`**: a structure's surface under the point answers before the world's (lower grid id first), not the
     nearer of the two; null where a cell it needs is not loaded; **the distances only with `{ distances: true }`**
     (they read over a hundred times the cells: counted on flat ground with 32 m of loaded air over it, 203 cell reads
     without them, 29,659 with).
  10. **The 2 m tolerances** (§9) are stated on ground (all sixteen 0.5 m surfaces and the 2 m one terrain), and the
      two distances one-sided: never nearer at 2 m by more than a 2 m cell's diagonal.
- **2026-11-26 — 47b.5, defaults chosen, owner to confirm** (item agent):
  1. **During a drag the ground does not change: the cursor and a line through the dabs show the stroke, and the
     release sends it.** One command a stroke is the row; nothing joins several commands into one undo step, and the
     Scene view has no local preview of voxels (its worker reads the backend's region files), so segments sent while
     dragging would be an undo step each. What the owner sees: the ring following the pointer, a thin line where the
     stroke went, the status line counting dabs, and the changed ground about a frame or two after the release
     (17–19 ms for the command on the picture's yard, then the chunks' derive).
  2. **Dabs sit on cells, on both lattices**: the cell under the pointer, Add's the cell in front of the face met (as
     the structure mode's hand edits did). The brush's size is a whole odd count of cells (4 m: 9 cells), so a dab is
     centred on a cell. A world brush is 0.5 m to 32 m, 4 m to start.
  3. **The spacing is the brush kit's Spacing setting** (a share of the size, 25 % for a voxel brush, shown in the
     panel), taken in whole cells and never under one; a gap between two picks wider than it is filled along the
     straight line between them, so a fast drag leaves no holes. A stroke keeps a cell once.
  4. **Flatten's plane is the surface under the first dab**: its cell's row plus its fill (a block: the cell's top).
     Each dab still sits where the pointer is, so the plane must lie within the brush's rows there: a mound taller
     than the brush comes down over several strokes.
  5. **Add's role comes from the material's use** in the world mode: a terrain material is written as ground, a
     construction material as plain wall blocks (the structure mode keeps its role picker). Add writes dry.
  6. **Paint writes the picked material and the wetness together, with no role** (v3's role-less paint). The command's
     paint has no way to change wetness and keep each cell's material, so **wetness alone cannot be painted**: that
     needs a command field, not built (owner stop; a line for after the merge).
  7. **The noise mask thins on the editor's side**: v3 has no mask field, so a Paint through the mask is sent as one
     brush command of one-cell-wide box columns, the brush's height, at every column under the dabs where the mask
     (read at the column's middle, in the grid's metres, the brush kit's `brushMask`) is at half weight or more. The
     mask is all or nothing a column (a cell holds one material), a ball brush paints its footprint's full height,
     and a mask that lets nothing through sends nothing and says so. Sculpt reads no mask. Cost not measured: a
     wide masked stroke is thousands of dabs for the backend's cover loop.
  8. **The palette** is the project's voxel materials whose use is terrain or construction; within a use the
     materials without variants first (heading Ground, Construction), then each base material with its instances
     that have a voxel id of their own, under the base's name. Liquids and gases are left out here: the same
     function lists them for another use (47b.6's fog paint).
  9. **Ctrl (or the panel's switch) swaps Add and Dig** for a stroke, as the other sculpt brushes invert. Smooth and
     Flatten have no inverse. The soft rim is one switch (the command's `smooth`), not the brush kit's falloff
     curves; a Paint is always hard.
  10. **The cursor is level on a world's lattice** (the brush's footprint from above, round the dab's cell, at the
      surface's height), on the face under the pointer on a structure. After the first take of E7, where it lay on
      whichever cell face the ray entered and stood upright on a slope. It does not follow the ground's height.
  11. **The mode is a scene's mode** (as decals): opened on a `voxelWorld` object by the Inspector's Edit world or a
      double-click in the Hierarchy, it edits that object's world, draws the whole scene, and takes only hits on the
      world's own lattice (over a structure a drag orbits). No menu entry or toolbar button was added.
- **2026-11-26 — 47b.6, defaults chosen, owner to confirm** (item agent):
  1. **Fog paint and erase name their cells; no command field was added.** No brush form writes a gas into open
     cells only at a chosen density, or empties gas cells only: `add` also takes a liquid's cells and writes full
     density (its coverage at a soft rim), `dig` takes ground, a `paint` never fills air (D838). So a fog stroke reads
     the cells under its dabs from the Scene view's worker at the release and sends one `set` (the gas at the
     density, dry) or one `dig` over the cells it may change. What follows from it: painted fog has one density and a
     hard edge (Smooth softens it); the fog brush is at most 8 m across, and a stroke whose list passes the command
     route's body bound is refused by the backend (D838); the cells are the view's copy, which can be an edit behind
     (D840). A brush mode that does this in the command is a line for after the merge.
  2. **Fog is painted into air and into any gas** (another fog is painted over; a cell already holding this fog at
     this density is left out); **Erase takes any gas**, not only the picked one. Ground, built cells, openings,
     liquids and cells the view has not loaded are never named.
  3. **The level gesture**: the press is the seed (the open cell in front of the face met); the level starts at the
     panel's Depth over the surface clicked (2 m to start) and follows the pointer up and down the screen by the
     view's scale at the seed's distance, in steps of 0.25 m, never under one step over the surface; the depth a
     gesture ends at is where the next click starts. It is a drag on the screen, not a handle in the scene: from
     straight above, up the screen still raises the level.
  4. **Reach and fade**: a fill's reach starts at 32 m; its most is the command's own bound, asked of `editChunks`
     (63 m on a world of 32-cell chunks) and said on the panel. The fade starts at 1 m; 0 sends none.
  5. **A drain is the flood with air** (47b.3): it takes fog and water alike; water of a water body is written again
     by the body in the same stroke. The manual says so.
  6. **Water is one `createEntity`** of a group object named Water at the seed cell's middle, with `waterBody`
     (world, level, the picked liquid); the reach is left to the component (256 m). The mode stays open; the body's
     own leak marks and Inspector do the rest. The tool never floods a liquid.
  7. **The spline entry is a rail of its own, Splines** (Road, Path, River), not a tile of Fill: a drag gives the
     spline's first two points (a click lays nothing), the object stands at the first, 4 m, 1.5 m and 4 m wide; a
     road or path of the picked ground or construction material on a metre of bed, a river of the picked liquid (the
     Inspector's own start, now one function); then **the mode closes with the spline selected**, where its handles
     are. Spline editing was not rebuilt and is not offered inside the mode.
  8. **No starter material went into the basic kit.** Neither the kit nor the two templates holds any voxel material
     (no liquid either: the item's brief assumed one). A voxel id is unique in a project and a kit is added whole or
     not at all, so a kit material with a fixed voxel id would make the kit's add fail in every project that uses
     that id. Instead the Fill and Splines panels offer **Make a mist material** / **Make a water material** when the
     project has none: one `setMaterial` of a plain material (Mist: gas, `#dfe6ea`, the default density; Water:
     liquid, `#2a5fc0`) with the project's next free voxel id.
  9. **A refused flood's marks stay** until a fill is taken or the fill tools are put down (another rail, Navigate,
     Done). They stand where the fill crossed its bound, as a water body's do, not at the gap in the bank.
  10. **Ctrl (or the panel's switch) swaps Fog and Erase** for a stroke, as it swaps Add and Dig.
  11. **Picture E8's stand-in for the fog itself** is the level ring, the leak mark and the status line; no overlay
      and no gas draw was built (47b.7's). Its script also drags one stroke of the fog brush, so the worker's cell
      read ran in a real page.
- **2026-11-26 — 47b.7, defaults chosen, owner to confirm** (item agent):
  1. **How "see-through by density" is made: the scene's depth behind each hull face, and two densities a quad.** A
     hull has no inside. Each gas face's pixel takes the length of gas behind it as the distance along the view ray
     from the face to the scene behind it (three's copy of the scene's depth, as river shores and soft particles
     read it), at most 64 m; the first cell at the face's own density, the rest at the density of the cell behind
     the face, which the derive writes on the quad (its spare byte). Opacity 1 − exp(−density a metre × that).
     Chosen over a thickness written by the derive (a face would read as many cells behind it as the fog is deep,
     which a section with a one-cell apron cannot, and equal neighbours would no longer merge) and over a second
     depth target for the hull's far side (a pass and a target more; 51 replaces the draw). What it gives: no line
     where fog meets the ground, a soft top that reads thin, a bank in a hollow as deep as the hollow. What it
     cannot: know where a bank ends in the air (D841).
  2. **From inside, one screen-wide layer.** With the eye in gas the hull is behind it and most rays end on ground
     without crossing a face, so back faces alone would leave the ground clear and the sky fogged. The eye's column
     of gas is taken as a level slab (its top and bottom the run's, without end sideways, at the run's mean
     density); a ray leaves through the top or bottom or ends at the scene; the layer comes in over the first metre
     under the run's top, and hull faces between the slab's heights are left out while it draws. To know the eye is
     in gas, the gas part carries **runs** (each column's touching gas cells of one material: 8 bytes a run), read
     on the page each render: derived, sent with the chunk's batch, never stored.
  3. **The gas part reads a liquid as the air it stands in** (the item's brief said "not against liquid"). With a
     face only against air, draining a pool under fog would change the fog's faces, and G6 says a change only
     between air and liquid feeds the liquid part alone. So fog lying on water has a face looking down at the
     water, which nothing sees (front faces only; water is opaque).
  4. **The part's layout** (format spec §3.7 *Derived data 34 → 35*): the liquid part's 16-byte quad, shared
     (`derived-medium.ts`), its spare byte the two densities; whole cell faces; faces merge within a cell layer by
     material and density pair. Derived data 34 → 35. **Nothing stored**: no record bit, file, manifest key,
     far-cache channel or material field.
  5. **Order and light**: blended, depth tested, no depth written, front faces; hull meshes sort with the scene's
     other transparent draws by three's order, the eye's layer after them all. Unlit: no sun, lamp, light volume
     or shadow, so a pale fog is as pale at night (q2's accepted look); the hull takes the scene's distance fog.
  6. **A gas's default density is 0.5 a metre** (47b.2 chose 0.1 unseen and said this item may change it): at 0.1
     the fill of a 1.5 m hollow hid about a tenth of its floor. 0–8 stands.
  7. **The density overlay is built** (not cut): a switch "Fog in the view" on the Fill panel and the fog brush's
     panel, As drawn or Density; the hull nearly opaque in a colour for each face's own cell's density (blue,
     magenta, yellow); shown only while a rail with fog tools shows, never in Play; a uniform, nothing rebuilt. It
     shows the hull's outer cells only, not densities inside a bank.
  8. **The look's two fields are a fifth block of the voxel surface's material table**, read by the gas draw alone.
  9. **`?voxelGas=off`** leaves the gas undrawn (as `voxelLiquid`), passed by the editor to Play: the cost
     comparison's other side.
  10. **The bench fog** (`bench-fog.ts`): a hollow dug into the town's empty lot (5, 6) and filled by one `flood`
      with a 1.5 m fade, the bench's gas material at the default density, placed last through the commands and
      taken out first by the project's undo (two steps, each checked to be a voxel step), the material deleted.
      `headroom --fog` orbits that hollow.
  11. To stay within the unit sizes: `VoxelWorldDraws` keeps its two view switches and its two walk-feed counters
      as one record each, `VoxelChunkView`'s tip scratch is the module's, the surface's table entry and gas row are
      module functions.
- **2026-11-27 — 47b.8, defaults chosen, owner to confirm** (item agent; G5 names the fields, these say what each is
  where it could be built more than one way; nothing is stored beyond G5):
  1. **The "project schema bump" is a recorded step of schema 8 named `dressing`**, not a schema 9. Every change since
     8 was written is such a step (`upgrade-schema-8.ts`: planes, light counts, bloom, interactor): it runs once on an
     older project and its name joins `project.json`'s `upgrades` list. This one changes no document. What the owner
     sees: an old project opens as it was, and its `project.json` gains one word on that open. A schema 9 would have
     touched every fixture and the 6 → 7 → 8 chain for the same effect; it is one constant if the owner wants it.
  2. **The asset is `{dressingFormat: 1, dressingId, name, species}`**: the three fields round the list are what every
     resource file has (the voxel kit's `kitFormat`, id and name). A resource kind `dressing`, list
     `content.dressings`, a file `<name>.dressing.json` in `assets/dressings/`, never loaded by address (shipped as a
     catalog block, as voxel kits are).
  3. **A species' placement fields are the scatter rule's own**, names, forms and bounds: `density` (0.0001–100 a m²),
     `spacing` (m), `scale` `[min, max]`, `yaw` (a random turn of 0 to this many degrees), `align` (0 upright to 1 along
     the normal), `seed`. So the core places a species with no code of its own. **"Yaw range" is 0 to a number**, the
     core's form: a turn range that starts elsewhere needs the core's copy changed, which this item may not touch.
     No `sink` and no drawing fields (shadows, wind, cover distance): G5 names none; 47b.9 and 47b.10 meet them.
  4. **`model` is a model asset id, unchecked** (as a kit's meshes: deleting an asset is never refused). A missing
     model grows nothing and reports nothing: D843.
  5. **The ten conditions' forms**: `material` a set of voxel material ids; `role` a set of role names a surface can
     have (terrain, wall, floor, roof, foundation, stair, pillar); `sky` true or false; `slope` (degrees), `height` (m,
     the grid's frame), `wetness` (0–7), `waterDepth` (m), `materialEdge` and `construction` (m, 0–8: the fields' cap,
     which also means "none nearer") ranges; `noise` a range over 0–1 with `scale` (m) and `seed`. **A range is the
     engine's rule range `{min?, max?, fade?}`** (moved to `@thirdlight/shared` `FadeRange`, one definition for
     material rules, scatter rules and these): the `fade` is what gives a share between none and all. A condition
     left out is any: grass with no `waterDepth` grows under a lake, so a starter dressing writes `{max: 0}`.
  6. **The noise is the brush mask's value noise at one octave, read flat** (`valueNoise01(x / scale, z / scale,
     seed)`, no height): a patch does not move when its ground is sculpted, and a cave under a meadow has the
     meadow's patches.
  7. **A species grows at the product of its conditions**, and a share under 1 keeps that share of the candidates,
     each picked by a hash of its own point and floor (never of the chunk that asks). **"Why not" names the first
     condition, in the vocabulary's order, whose value is 0**, then `prop`; both read one table of checks.
  8. **Order of the species**: an entry's place in the list is its identity to the core (its hashes mix `s<index>`
     with its seed), so two entries of one model never share candidates and **moving an entry moves its plants**.
     The order gives no priority between species: each keeps its own spacing only (G5 names no cross-species rule).
  9. **Variants**: `voxel.dressing` resolves along an instance chain exactly as `voxel.kit` does (the nearer level
     wins). A variant that names another dressing is "density by material variations". **A variant cannot name "no
     dressing"** over a parent that names one (nor "no kit"): bare ground of the same look is a material of its own,
     or a dressing with no species.
  10. **A dressing a material names cannot be deleted** (`dressing_missing`, as a kit a material names): clear the
      material's field first. A liquid or a gas names none (no surface).
  11. **The core is told whether a species grows through its layer-share condition.** `scatter.ts` and
      `cover-points.ts` are not touched: the species is handed over as a ground cover rule with one condition, "layer
      0 at least 1", and the voxel surface answers layer 0 as 1 or 0. Every surface of a column is answered in turn
      even where nothing grows, so a floor's place in its column (which the core's hashes read) does not change when
      the ground over it does.
  12. **Where the source lives**: the rules in `@thirdlight/voxel` (pure, no project-model), the surface and the job in
      project-model beside the core they feed (`voxel-dressing-source.ts`), because `@thirdlight/voxel` cannot import
      the core. So the cover job is **not** one of the voxel package's stream jobs: a worker entry adds
      `voxelCoverJobHandlers` beside them (47b.9: the editor's, the preview's and the export's voxel workers; a
      browser build of a worker serving it alone is 46 KB minified and passes the export scan).
  13. **A chunk's cover reads its column and the eight round it, whole** (a ring of a chunk, where the fields job
      keeps 8 m): a candidate a spacing past the border is judged from the cells its own chunk judges it from.
      Hence **a cover species' spacing is at most 8 m** (refused above it; a large species keeps the core's 100 m),
      and D842 on 16-cell chunks. A chunk whose neighbours are not loaded yet reads them as air: 47b.9 makes cover
      when the columns round are there, or again when they arrive.
  14. **A point belongs to the chunk that holds its surface's cell**, not the chunk its height falls in: a full cell's
      top face lies on the border of the chunk above, and stays with the cell.
  15. **Keep clear of props: the prop's box, nothing stored.** The signal is the one the light stamps use (the
      runtime's `propLightShape`: the object's collider, else its model's recorded bounds; `propBounds`). A point
      inside that box across the ground, from 0.5 m under its foot to its top, grows nothing. Chosen over a radius:
      a box follows a long prop (a cart, a fence panel) where a circle would clear a disc of its length; a turned
      prop clears its axis-aligned box, a little more than itself. A model with no collider clears its whole
      footprint (a tree's crown: give it a trunk collider). **Which objects count is the caller's list** (47b.9):
      proposed, every static object with a model, marked `affectsLighting` or not. No clearance field on the
      dressing or the prop.
  16. **A build ships the dressings its shipped materials name** (the catalog's `dressings` block, add-only in
      manifest 5) and their species' models, cover and large, as project-wide dependencies. A dressing nothing names
      is authoring data only.
- **2026-11-27 — 47b.9, defaults chosen, owner to confirm** (item agent; nothing is stored, no format entry, no
  command field):
  1. **Cover is a job of its own a chunk column, not a derive part.** The rule scatter core is project-model's and
     `@thirdlight/voxel` cannot import it (47b.8 12), so cover cannot be a part of a section's derive without a
     boundary change. `@thirdlight/voxel` `cover-stream.ts` (`ChunkCoverStream`) asks the `voxel-cover` job for a
     column once one of its chunks is drawn at level 0, for the rows of its drawn chunks; the answer leaves in the
     chunk draw batch (`ChunkDrawBatch.cover`, applied after the batch's chunks). **The unit is a column, not a
     chunk**: the point-set path's atlas is filed by column, and the job reads the whole column either way; a
     column's cover goes in the batch that removes its last drawn chunk, and the points of a chunk no longer drawn
     go with the next answer.
  2. **What makes a column's cover again**: a drawn chunk of it or of the eight columns round it changed in shape,
     material, wetness or liquid (`COVER_FED_BY`: the fields' feeds less gas); a chunk of it or beside it loaded;
     one of its chunks is drawn or no longer drawn (its own column alone); a structure's stamp landed or left; the
     table of what grows changed (every column, no chunk derived); a keep-clear box came, went or moved (the
     columns within 8 m of it). **The cost of an edit**: nine jobs for an edit inside one chunk (more where the
     mesher's reach makes a neighbour's sections again: each such chunk's event marks its own nine), about 13–24 ms
     of a worker each; an answer equal to the one sent last is not sent again, so the page hears only of columns
     whose plants changed. Narrowing it to the cells an edit touched needs the edit's box at the stream (not
     built).
  3. **Never before a mesh**: cover jobs wait in the pool's background queue (the far field's), at most a quarter
     of the workers at a time, and none is asked while a load or a derive waits for a worker. An answer of cells or
     a table that changed while its job ran is dropped and the column asked again.
  4. **The props kept clear are the objects marked Static that have a model** (the hierarchy flag `static`: "the
     object does not move"; a folder passes it down). A game reads each one's light shape box (its collider, else
     its model's recorded bounds: `propBounds`) where it stands when its scene loads and when it leaves; it is not
     followed after that (a static object is not moved while a game runs). The editor's Scene view reads the bounds
     of what it draws, again whenever the scene's objects change, so a prop moved there makes the cover round its
     old and new place again. An object not marked Static is grown over. Not chosen: every object with a model
     (a character, a cart on a mover and a pick-up would each leave a bare patch where they started).
  5. **Structures**: in a game the world's cells read a structure through its stamp (47b.4 8), so nothing grows
     under a house's floor and a stamp landing makes the cover there again. The Scene view runs no stamps: it keeps
     each structure's box clear (D846). **A structure's own surfaces grow nothing** (a dressing on a floor material
     grows in the world grid only): a structure grid's draws carry no cover.
  6. **The budget a tier is two entries of the shared tables and no new setting.** Memory: `voxelCover`
     (`VOXEL_COVER_BUDGET_BYTES_BY_TIER`: 32, 64, 96 MiB of the page, 96 bytes a resident point); past it every set
     hands the path only the share of its points with the lowest thresholds, in sixteenths, so cover thins evenly
     and never ends at a place. Time: the frame arbiter's `voxelCover` slice (1 ms of the page a frame) for handing
     arrived sets to the path. The existing tier settings do the rest: the level's `lodBias` scales the cover's
     reach and level switches as for any cover. No count cap.
  7. **How far cover is drawn is the scatter rule's default, 40 m**, thinning to nothing from 60 % of it: G5 gives a
     species no cover distance (47b.8 3), so every voxel species reads `SCATTER_COVER_DISTANCE_DEFAULT`. On the low
     tier that ends inside the detail ring (about 45 m), so cover fades out before the ring does; at medium and
     high (64 m) it still ends at 40 m. **Cover casts no shadow** (G5 names no such field; it receives them).
  8. **The derived data version stays 35**: no derive result's bytes or meaning changed (cover is outside them).
     The spec's entry gains its as-built pointer.
  9. **The pictures' plants are stand-ins made in code** (`tools/perf/village-assets.ts` `plantGlb`, `pebbleGlb`: a
     clump of 12 blades, 60 triangles; a flower tuft, 24; a reed clump, 40; a pebble, 10; one level, one flat
     colour, no texture), imported for the run and deleted after. Not art: 47b.10 retakes L25 and L26 with the
     starter plants. **L25 and L26 are a picture run of their own** (`cover`), so the 24 older world pictures keep
     their bare ground.
  10. **D842 stays open**: the scheme (a column and the eight round it) is 47b.8's.
- **2026-11-27 — 47b.10, defaults chosen, owner to confirm** (item agent; nothing is stored beyond G5, no command or
  command field was added; the phase's third cut, the Rules rail's "why not", was **not used**: it is built):
  1. **The card edits the dressing where the material is shown.** It sits in the material Inspector's voxel
     section, under the kit, for a ground or construction material; a dressing has no editor tab or window of its
     own (a dressing chosen in the Project window shows its name, file and delete, as every resource does). The card
     says who shares the dressing (the materials naming it and the variants that take it from their parent).
  2. **Every edit sends the whole dressing** (`setDressing`, 47b.8's command: one undo each); which dressing a
     material names is `setMaterial`. **New** is two commands and two undo steps: an empty dressing named after the
     material, then the material naming it.
  3. **Plain fields.** A range is three number fields (min, max, fade; an emptied field is an open end, a
     condition with none left is off), the material and role sets are ticks over the project's voxel materials
     and the role names, the sky a three-way choice. No sliders, no curve, no preview of its own: the Scene view
     grows each change (47b.9's re-make on a table change).
  4. **Reordering says what it costs**: the up and down buttons' hints say an entry's plants move with its place
     (47b.8 decision 8). A removed entry moves the ones after it too.
  5. **The Rules rail reads the world's own ground**: the pointer over a structure reads nothing (a structure's
     floors grow nothing: 47b.9 decision 5). Moving reads, a click holds the read (so the pointer can go to the
     column), Esc lets go. The read stands at the picked cell's middle: the noise is read there, and a species'
     real plants sit anywhere in the cell, so at a patch's very edge the rail and a plant can differ by a cell.
  6. **The surface read always carries the two distances** (a rule may ask either): about 30,000 cell reads a
     point in the view's worker, one read in flight, a cell asked once while the pointer rests on it. Not measured.
  7. **The keep-clear boxes the rail answers "a static prop stands here" from are the Scene view's own** (the ones
     it sent its cover job), so the rail agrees with what the view draws, and differs from a game where the view
     does (D846).
  8. **One source for the per-point form**: the streamer's cells as the kernel reads them moved from the runtime
     into `@thirdlight/voxel` (`streamerSurfaceSource`); `ctx.voxels.surfaceAt` reads through it (its tests green,
     no behaviour change) and so does the view's worker. A new page ↔ worker message, `surface`, beside `pick`
     and `cells`.
  9. **The starter plants are fully modelled strips and fans, no alpha cards**: the 3D starter's meadow grass is
     made the same way (`templates/starter-3d/tools/grass.py`), and see-through cards cost overdraw on the floor
     GPU. **One 128 × 128 colour atlas** for the four (a column a part, 3,995 bytes as ETC1S KTX2). **No normal
     map**: a blade is 3–4 cm wide and seen from 2 m to 40 m; a tangent-space map carries nothing there that the
     upward-bent vertex normals do not. No ORM map (one roughness on the material). **No collision** (cover never
     collides). Budgets a level are in the script and checked by it; the pebbles wear a standard material and
     carry no foliage data.
  10. **Where the art's source lives**: `packs/basic-kit/tools/cover-plants.py` (headless Blender through the art
      pipeline's `bpipe`, run from the engine repo; art-factory was not edited), its manifest kept as
      `packs/basic-kit/source/cover-plants.json`; `build-basic-kit.mts --cover <dir>` takes its output.
  11. **The Meadow also grows reeds in shallow water** (the item named reeds under Shore alone): a pond dug or
      filled in a meadow gets reeds without a second material, which is what the plan's §2 describes. Its flowers
      are two entries of one model (patches by noise; a verge by the distance to another material). Shore is for
      a bank material, Gravel for a road or yard.
  12. **The kit carries plants and dressings, never a voxel material** (47b.6 decision 8 stands): the dressings
      ride in the pack as `setDressing` commands and name no voxel material id. A fresh project gets a meadow by
      **Make a grass material** (an empty Add or Paint palette offers it; the Rules rail offers grass, shore and
      gravel while no material names their dressing). Checked, and said in the manual: a species with no
      `material` condition grows on every material that names its dressing.
  13. **A project that added the Basic Kit before this build does not get the starter cover**: a pack is added
      once, and a second add is refused naming the ids it already has. No pack upgrade was built (a line for after
      the merge).
  14. **The bench cover is the kit's own**: staging's project gets the kit by the pack route and loses it by the
      undo (five steps, newest first), and the code-made stand-in plants are deleted. The yard's side pictures of
      E7 (the Scene view with cover, 47b.9) are dropped: E9 shows that view.
  15. **The editor may import project-model's `dressing` module** (the boundary rule, changed in a commit of its
      own): the card edits inside the model's own bounds, classes and format.
  16. **A dressing is deleted in the Project window**, by the delete every resource kind has there
      (`deleteDressing`; refused, with the reason shown, while a material names it). Added after the item's check
      showed the editor could make a dressing and not remove one.
- **2026-11-26 — the proposed plan's five questions** (§10): 1 answered by the owner (two phases: 47b ends at
  ground cover, 47p follows); 5 answered (stamps go to 47p; the forest edge is 47p's and the rings phase's);
  2, 3 and 4 not answered one by one: their defaults stand under the roadmap's rule for unanswered defaults.

- **2026-11-27 — the independent review** (a fresh agent that built none of it; read only, `a22b8a99..79649d93`;
  the lead's actions after it: findings 1 and 2 corrected in the texts, D849–D851 opened and D840 extended, findings
  8b, 8d, 9 and the limits to the acceptance page's questions, 3 and 4 heeded on that page, 12 written into the
  roadmap as 47p's first item, the rest left as notes). Its page:

  **Verdict: the phase can close after two small text fixes; no stored thing beyond G1–G6 was found, scope held, the record is honest. Two new defect rows, four owner questions. The promise "a role costs a row" is not true for 47p's `prop` and the owner should be told so in plain words.****

  **Must fix before close (text only, no product code)**

  1. **The manual and the plan say a fog bank wider than one fill is "several fills"; it cannot be made that way.** `docs/manual/features/fog.md:61-62`, plan §8 47b.3 decision 1. A flood that meets its reach is refused as a leak (`edit-apply.ts` `floodPlan`, G4's own wording), and a gas flood passes its own gas, so in an open hollow wider than about 2 × 63 m every fill leaks, the second as the first. Correct both sentences (the hollow must be closed within the reach; a wider one is not fillable today) and open the row below.
  2. **One history comment**: `packages/project-model/src/voxel-dressing-source.test.ts:175` ("when 47p places the others"). The only hit in 27k added lines (grep for phase ids, D-numbers, §, dates, G/F entries). Nit beside it, product text not comment: "placed in a later phase" in `editor/src/session/world-rules.ts` and `ui/material/DressingCard.tsx` is roadmap wording in the UI.
  3. **The acceptance page must not repeat §2's "A new voxel role costs one row of a table"** (finding 6). Say what is true as built.
  4. **No export with fog or cover has been opened by anyone** (§9 47b.7 and 47b.9 say so; the boot check's export holds neither). The phase run should take one, or the page lists it under unverified.

  **Defect rows proposed (next free: D849)**

  5. **D849 | M | open** — Every cover job is handed the scene's whole keep-clear list, and every candidate scans it. `voxel/src/cover-stream.ts:372` puts `this.clear` (all static props with a model: `runtime/src/voxel-worlds.ts:400`) into each column's job input; `dressing-rules.ts:161` `clearedByProp` is a linear scan called per candidate per species (`voxel-dressing-source.ts:189`), before the material test's cheap exit only for materials that grow. Cost grows as props × candidates × species and the list is cloned to the worker with each job; `setClear` also re-keys every box by string each call. No test or bench holds more than a few props. A scene of a few thousand static props (what 47p brings) will show it. Fix: send a column only the boxes within its reach (the stream already computes that reach to mark columns), or bin them.
  6. **D850 | M | open** — A fog fill is held to about 63 m from its seed (32-cell chunks) and nothing wider can be filled. The bound is not a flood rule: `editChunks` counts the flood's whole reach box against the 64 MiB undo budget of one stroke (`edit-apply.ts:104, 517`), whatever it would write. A water body reaches 256 m by its own writer; fog in a valley cannot follow it. With the 8 m fog brush (D838) this is the second sample-sized cap on fog, and a real map hits it at once. Fix: count the cells a flood writes, not its box; or a gas body as water has (the plan's §10 q3).
  7. **D840, add to its text**: Erase is the worse side. A `dig` of named cells empties whatever is there, so a stale read can dig ground laid a moment before (the row names only `set`). Sound as a mutation path (commands only, sent with the projection's revision, one undo), so it stays L.

  **Owner questions**

  8. **(a) G2, "and no opening"**: fine, and inside G2's intent (gas takes a coarse cell only where the world without it has air). Derived data only. Tell, do not ask. **(b) G5's "project schema bump" built as a recorded step, schema still 8**: a departure from the approved words. Ask: one line, default stands (every change since 8 was such a step; an older build refuses the unknown `dressings` list rather than misreading it). **(c) 0.5 a metre and the runs**: no question; the default is not stored and the runs are derived. But the default was fitted to one bench hollow nobody but an agent saw: owner's eyes. **(d) Not on the lead's list: G5 says "scale and yaw ranges"; `yaw` is stored as one number (0 to n degrees)** (`dressing.ts:73`). Format 1 is now on disk in the Basic Kit; a real range later is a format step. Ask.
  9. **The starter plants against the owner's art rule** (baked normals, collision, LODs): three levels inside stated budgets, KTX2, counts and sizes reported, but **no normal map and no collision**, by the agent's decision (47b.10 d9). Reasonable for 4 cm blades; the rule's letter says otherwise, so the owner confirms. D847 (dark back-faced blades) is visible in L25 as I opened it: the grass reads as a mix of pale and near-black blades.
  10. **`MAX_DEBUG_COMMANDS = 32`** (`runtime/src/debug-commands.ts:17`): 47b.1 worked round it in the bench and kept it. It is a per-game count cap that fails with a log line. Keep, raise or remove?
  11. **About 100 "default chosen, owner to confirm" entries against a page of five questions.** The ones that change what a user can do, and deserve the five: wetness alone cannot be painted (47b.5 d6); the ground does not change during a drag (d1); one cover distance of 40 m for every species and no shadow (47b.9 d7); a variant cannot say "no dressing" (47b.8 d9); moving a species in the list moves its plants (d8).

  **Notes**

  12. **The role traits table: what "a row" really buys.** True for a role made of trait values that already exist. Not for `prop`: `checkRoleTraits` (`role-traits.ts:125`) refuses a row whose light stop, walkers or collision differ from `body`; `assembly.ts:293` maps rows to four classes and anything else falls to `empty`; `RoleMipHold` has no kind for "not drawn near, kept far"; `body` means both "the near mesher draws it" and "the far faces build it"; `FIELD_FEEDS` (`record.ts:334`) is by field, not by role; surface fields read sky as "a body closes it", so the starter Meadow's `sky: true` decides what grows under a stamped tree. Gas itself cost the row and six other places (§9 47b.2, honestly listed). Record it as 47p's first item.
  13. **The build check bites on what it names and has three holes.** It catches `VOXEL_ROLE.x` compared, listed, cased, aliased, and `role === 2`. It does not see: a comparison through a variable not named `role`/`…Role` (`const r = valueRole(v); r === 2`); string names (`roleTraits(r).name === 'gas'`; none exists today, I grepped); and `tools/`, `packs/`, `templates/` (stated). Beside it, the material `use` is a second role-like list compared by hand in 21 places of 10 files, unchecked. Note for after the merge; no hole is used today.
  14. **Size rule kept by the letter.** No ratchet entry changed and `check-size` is green, but `VoxelWorldHost`, `VoxelChunkView`, `VoxelWorldDraws` and `VoxelStreamer` each stood at exactly 80 members before and after while gaining gas and cover: fields were packed into records to fit (47b.7 d11). `createVoxelSurface` 396 of 400, `validateOpArgs` and `startGamePage` held at their ratchet numbers while their files grew. 47p adds to the same four classes: split first.
  15. **Copied paths**: one fill (checked, `level-fill.ts` shared by bodies and the stroke, 300-world comparison); one rule arithmetic and one "why not" (checked); one noise and one range (`FadeRange` moved to shared, `valueNoise01` reused); media quads and geometry shared. Copies that remain: `VoxelLiquidDraws` / `VoxelGasDraws` (mesh, shown, gone, set: about 40 parallel lines; 49 replaces the liquid side, leave); the Scene view's keep-clear versus Play's (D846, rightly open); the species reaches the scatter core disguised as "layer 0 ≥ 1" (`voxel-dressing-source.ts:226`), a workaround for not touching `scatter.ts`, to undo when 48 frees the core.
  16. **Limits, sorted.** Engine limits, documented, fine: the 8 m distance cap and the conditions' 0–8 bound (the job's read ring), cover spacing ≤ 8 m, the cover memory budget and frame slice a tier (thins evenly, no count cap: checked `voxel-cover.ts`). Sample-sized, a real project hits them: the 63 m fill (D850), the 8 m fog brush and the 1 MiB stroke body (D838), 40 m cover for all species, 32 debug commands. D842 (16-cell chunks) is real and rightly L.
  17. **Generic, not demo-shaped: mostly fine.** The engine's rules, fields and cover name no material or plant. One coupling: the editor hard-codes the pack's ids and three grounds with colours (`editor/src/session/world-mode.ts:182-186`: `basic-meadow`, `basic-shore`, `basic-gravel`), a second definition of ids that live in `packs/basic-kit/pack.json`. Better that the pack declares its starter grounds; after the merge.
  18. **Built to the row, read by nothing yet**: `farGroundFields` (2 m fields) and `roleTraitsWgsl`. Honestly reported; they are untested by use until the rings phase and 51.
  19. **Tests: good.** 53 test files changed, no `vi.mock`/`spyOn`, no wall-time assertion, no skip. "Real worker" means a Node `worker_threads` worker running the bundled worker, said so each time; no browser worker ran the cover job. The break-on-purpose lists are the strongest part. The role table's test compares against the old expressions kept in the test: a fair regression oracle now, dead weight once roles change.
  20. **Formats, checked independently**: canonicalizers and validators of `dressing.ts` and `voxel-materials.ts` (fields exactly G3's and G5's, unknown fields refused), `edit-command.ts` (flood: seed, level, value, reach, fade; brush: `height`; role-less paint: no new field), `format-versions.md`, the spec diffs, the world manifest (moved, unchanged), no record bit, no far-cache channel. Stored things that follow from G5 and the owner should simply know of: the `content.dressings` list and its files, `'dressing'` in `project.json`'s `upgrades`, the catalog block `dressings` in runtime manifest 5.
  21. **One mutation path, export: checked, fine.** Every editor tool ends in `editVoxels`, `createEntity`, `setMaterial`, `setDressing`, `deleteDressing`; the export worker imports only `@thirdlight/project-model/voxel-cover` (a boundary subpath added in its own commit) and its bundle passes the scan in a test.
  22. **Honesty, five claims checked, all hold**: ratchet unchanged (git diff); 10 owner files (the list); test counts 25 + 5, 18, 11, 8 + 9 (counted); parts mask 127 and derived 35 (`record.ts:316`, `derived-data.ts:264`); L25 and E9 as described (opened both). One soft spot: §6's 47b.10 row says "E9 read" while §9 says its final framing was not retaken.

  **Still needs the owner's eyes (nobody has seen these)**

  Anything in motion: brushing, wind, cover arriving at speed (D844's 949 ms hitch), walking into fog. Dig, Smooth, Flatten, Paint, Drain, Water, Erase, the three splines and every key with a real pointer; Ctrl+Z in the editor after a stroke or a fill. Fog and cover at night, under lamps, in an export, on medium and high. The Dressing card in use (reorder, remove, add, pickers, a variant's card). "Make a … material" in a browser. The structure mode's hand edits after their move. Any world larger than the 64 m yard in the mode. D837's cube corners and D841's fog cards, to judge whether they are acceptable until 51.

- **2026-11-27 — the close, defaults chosen, owner to confirm** (lead): (1) **the order of the close**: the
  review and its fixes first, then the one phase run on the final code, then the read, so no check follows the
  phase run. (2) **L3 stays on the picture list**, unsettled and named (D852): taking a picture off the list is
  removing a test, the owner's to decide (acceptance question 3). (3) **E7–E9 of the pack are retakes** made after
  the picture script's fix, in the screens' order; the rest is the phase run's own. (4) **Not built, by the
  owner's stops**: a brush form for media on the edit command (D838) and anything else a format entry does not
  name. (5) The phase closed over its test budget (87.5 min of 75): no check was skipped to hide it.

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

### 47b.4

- **The module** (`packages/voxel/src/surface-fields.ts`, foundation 1; no three, no `node:`; typed arrays in and
  out):
  - `surfaceTable(cells: SurfaceCells): SurfaceTable` (a box of record values, index `(x · sz + z) · sy + y`, its
    corner, `cellM`, and `built`: 1 where a structure's stamp stops) lists each column's surfaces and runs of
    construction cells.
  - `surfaceFieldsOf(table, x, z, row, distances, out: SurfacePoint)`: the kernel, one surface.
  - **Block form** `surfaceFields(cells, footprint?, table?): SurfaceFieldColumns`: the kernel at each column's
    highest surface, a typed array a field (`SURFACE_FIELD_NAMES`).
  - **Per-point form** `surfacePoint(src: SurfaceSource, x, y, z, distances, out): boolean | null` over a reader
    (`value(x, y, z)`, `built?`, `top(x, z)`): `surfaceRowUnder` finds the surface, `gatherSurfaceCells` reads only
    the cells the kernel reads for it (the column up to the top, the four beside it ± 16 rows; with distances every
    column within the cap in its sheet's rows), then the same kernel. `surfaceRows(table, x, z)` gives a column's
    surfaces to a consumer holding a block (47b.8's scatter surface).
  - **Fields**: `row` (cells), `height` (m), `slope` (degrees 0–90), `material`, `role`, `wetness` (0–7), `sky`
    (0/1), `waterTop`, `waterDepth` (m), `waterMaterial`, `gasBottom`, `gasTop` (m), `gasDensity` (0–1),
    `gasMaterial`, `materialEdge`, `construction` (m, capped at `SURFACE_DISTANCE_CAP_M` = 8: 16 cells of 0.5 m,
    `SURFACE_PAD_CELLS`; 4 of 2 m). Other constants, each once: `SURFACE_SHEET_RISE` 1 row a column,
    `SURFACE_WALL_M` 2, `SURFACE_SLOPE_ROWS` 16, `SURFACE_SNAP_CELLS` 4. Roles are asked of the traits table.
  - **What each field needs round it**: the slope the four columns beside; the distances the 16 columns round (so a
    chunk column needs the eight beside it); everything else its own column.
- **Where it runs.** (1) The derive workers: job kind `surface-fields` (`surface-fields-job.ts`,
  `SurfaceFieldsInput`: a chunk column of a level and the chunks that hold anything in it and the eight round it,
  as resident payloads or stored bytes, with stamps as `built`; `surfaceFieldsInputOf(store, cx, cz, cy0, cy1)`
  makes a level-0 input; `surfaceFieldsNow` is the same job in the calling thread). Nothing submits it yet: 47b.9's
  cover is its first consumer. (2) The 2 m far nodes: `farGroundFields` (`far-ground.ts`, job `far-ground-fields`):
  the coarse floor's decode (one shared `decodeStoredChunk`) read for every field over a node column and the eight
  round it. A function with tests; nothing draws from it. (3) The runtime: `ctx.voxels.surfaceAt`.
- **`ctx.voxels.surfaceAt(x, y, z, options?: { distances?: boolean }): VoxelSurface | null`** (runtime
  `voxel-surface-read.ts`): `{ grid, at, height, slope, material, role, wetness, sky, water: { top, depth,
  material } | null, gas: { bottom, top, density, material } | null, materialEdge, construction }` (the last two
  null unless asked). On `BehaviorVoxelWorld` and `ctx.voxels`; typings, the reference and
  `guides/voxel-scripts.md` (*Surfaces: `surfaceAt`*) written; a graph skip (an object output). The script type
  pages were re-cut by size (`script-types-save-meta.md` → `script-types-behavior-camera-state.md`); the manual's
  links hold.
- **Cost** (the unit bench's lines, this shared box, reported and not asserted; a box of 64 × 64 columns over
  160–192 rows, 45–47 chunks sent): `surface fields bench: 72 chunk columns in this thread, ms a column p50 8.959
  p95 12.143 max 25.677`; `in a worker, two chunk columns twice over (the town's, then the hills'), ms a column
  64.077, 52.135, 23.408, 11.514, 7.827, 7.497, 5.798, 5.539` (the first jobs are the worker's code's first run).
  Split, in this thread: reading the chunks sent about half (13 ms before payloads were read as whole values, a
  `RecordChunk.toValues`), the table 1.5–2.6 ms, the fields 3–10 ms (the town's, where construction is near
  everywhere). Nothing runs it a chunk, so the default path costs nothing more. `perf-recommendations.md` row 46.
- **2 m against 0.5 m** (`tools/voxel-bench/surface-fields.test.ts`; the cached town, 96 m square of it, and the
  hills at a lake's shore, each 2,304 columns of 2 m over 16 columns of 0.5 m; wet ground and mist painted on the
  hills). Tolerances, stated in the test, and what was measured:

  | Field | Tolerance (on ground: all sixteen surfaces and the 2 m one terrain) | Measured (town; hills) |
  |---|---|---|
  | height | within 0.25 m of the mean of the sixteen | 0.033; 0.11 |
  | slope | within 5° of the mean in 95 of 100 columns, 10° in all | 0 and 7.6 (beside the ponds); 1.4 and 2.7 |
  | material | one of the sixteen's in at least 95 of 100 columns | 1,126 of 1,146; all |
  | role | compared only where it is terrain at both scales | — |
  | sky | equal wherever the sixteen agree | all 2,304; all |
  | wetness | within 1 level of the mean | no wet ground; 0 on 64 wet columns |
  | water top, depth | within 0.25 m where all sixteen are wet and the 2 m column kept it | none kept; 0.16 and 0.10 on 960 |
  | material edge | never nearer at 2 m than the mean by more than 2.83 m (a 2 m cell's diagonal); both ways on the hills | −1.3 … +6.2; −0.75 … +2.04 |
  | construction | never nearer at 2 m than the nearest of the sixteen by more than 2.83 m | never nearer (0 … 8 farther) |

  **What cannot agree at 2 m:** (1) anything where a building stands: the 2 m surface is the roof, the sixteen are
  roof and ground. (2) Thin construction (the town's fences and posts) and materials narrower than a 2 m cell (a
  kerb, a pond's rim): not in the 2 m data, so both distances read farther, by up to the cap (construction near at
  0.5 m is also near at 2 m in 2,133 of 2,280 columns). (3) **Water** where a 2 m cell holds its bed: all 12 of the
  town's whole-pond columns and its 32 shore columns read dry; on the hills 65 of 84 shore columns kept it. (4)
  **Gas**: mist two cells thick on a slope is in the 2 m data in 41 of 64 columns (where its cells fall in a 2 m
  cell the ground does not hold), its bottom and top within 2 m of the 0.5 m ones, its density 0.47–0.93 lower.
  G2's "lost from the 2 m copy up" is what happens where the ground shares the cell, not everywhere.
- **Tests** (new: `packages/voxel/src/surface-fields.test.ts`, 18; `tools/voxel-bench/surface-fields.test.ts`, 2;
  one in `tools/voxel-bench/world-host-grids.test.ts`):
  - every field on a made case: a fill's height; slopes of atan ⅓ along each axis, 45°, across both, at the box's
    edge and in 2 m cells; a wall left out and a cliff steep; a material boundary 5, 1 and 16 columns off, one
    column 3 and 4 off, one past the cap inside the square searched, a tie between a surface over and under the
    sheet; a wall 6 and 1 columns off, past its end, its top, no ground under it, a block 5 and 10 rows overhead;
    a pond's top and depth; a gas bank's bottom, top and density, the lowest of two, over water; a roof and open
    sky; a stamp (no ground under it, no sky through it, construction beside it, never a surface); empty columns.
  - the per-point form: a cave's floor under a hill (stone, no sky, the moss 4 columns off, not the grass over
    it) against the same column's top; both storeys of a house and its roof; the point snap (4 cells over, inside
    the body, through 10 m of water, a stamped cell); null where a needed cell is not known, and no cell read
    that the kernel does not need.
  - one arithmetic: both distances against a plain scan of the definition on every surface of two made worlds
    (rolling ground of three materials, a pond, fog, a cave, a two-storey shell, a stamped shed: over 5,000
    surfaces, columns of several); the per-point form through a reader against the kernel on the whole box, every
    field, for every surface a ring inside it; the block form against the kernel value for value, and the same
    bytes twice.
  - page and worker alike: two chunk columns of each world through a real `worker_threads` worker running the
    bundled worker, a column with a stamp, and a 2 m node column: every array byte for byte as in this thread.
  - `ctx.voxels.surfaceAt` through a real runtime, region files and workers: open ground (every field), the ground
    beside house 1 reading its wall through the stamp at 1 m, each of three turned houses' floor (its own grid,
    its place's height) and roof, a pit dug, filled with a liquid and mist and wet ground painted in the same step
    (bed, top, depth, bank), the swimmer's read, another material 3 columns off, distances null unless asked, null
    under a house's floor, 2 m over the ground, where nothing is loaded.
  - the feeds: eleven kinds of change all feed the fields; a gas's and a liquid's change still answer their own
    part alone.
  - **Broken on purpose, each run once** (21): the height without the fill → 3 red; the slope keeping a wall → 2;
    a one-sided difference halved wrongly → 2; the search starting a ring late → 6; construction without the wall
    rows → 2; the material read off the sheet → 3; the sky ignoring a stamp → 1; a gas run across materials → 1;
    the water's top as a whole cell → 1; the gather a row short → 1; a stamp as a surface → 2; the snap a cell
    longer → 1; gas left out of the feeds → 1; the higher of two surfaces as near → first green, a tie case added,
    then 1 red; the cap's skip of columns past it removed → green (it only saves work: the result is capped
    again). The job: a far node read as 0.5 m cells → 2; the neighbour columns swapped → 2; stamps dropped → 1. The
    runtime: structures not asked first → 1; stamps not read → 1; a grid's height without its place → 1.
- **Gate:** before it, the generators (typings, graph API, reference), `npm run build` (79 s) and `npm run lint`
  (95 s, uncached) green, the manual's links test green. `tools/gate.sh check` once: GREEN in 253 s (build 25 s,
  lint 8 s, unit 194 s: 969 files passed; boot 5 passed, 26 s). No second call. The two new unit files take about
  7 s and 12 s alone (the fast set 189 → 194 s).
- **Stored:** nothing. No field cache, far-cache channel, manifest key or record bit; `DERIVED_FORMAT_VERSION` stays
  34 (the entry was listed by 47b.2; its layout is now in the format spec §3.7).
- **Not built, and why:** the fields a chunk by default, a cache of them, GPU field windows (no consumer: 47b.9, 49,
  51); a walk along the surface for the distances (decision 7); a shader port (49, 51: the kernel is plain
  arithmetic on typed arrays); the far fields past one node column at a time (the rings phase).
- **Unverified:** nothing here draws, so there is no picture. `surfaceAt` was run through the runtime in Node, not
  in a browser or an export (the boot check runs neither). The worker's cost was read from four jobs a world.
  Fields on a structure turned 30° and 45° were read on its floor and roof only.

### 47b.5

- **What exists.** A scene-scope edit mode `world` on a `voxelWorld` object (`ui/editmode/world-mode.tsx`): the
  Inspector's **Edit world**, or a double-click on the object in the Hierarchy. Rails **Sculpt** (Add A, Dig D,
  Smooth S, Flatten T; ball, box or cylinder; soft or hard rim; under Add the palette) and **Paint** (the palette,
  wetness 0–7, shape; the Brush panel with size and spacing, and the Noise mask panel). No other rail.
- **The one tool** (`viewport/voxel-brush-tool.ts`, 443 lines; arithmetic `session/voxel-brush.ts`; wiring
  `ui/shell/useVoxelBrush.ts`; the mode's state `session/world-mode.ts`). It extends, and names in its headers: the
  edit-mode shell, the brush store, `BrushControl` (keys, F drag, Ctrl), `BrushCursor`, `brushPanels` and
  `NoiseMask`, `LayerPalette`, `brushMask`, the worker's pick, the change feed. Its own: the dabs' trail (a line), a
  box outline for a box brush, `data-voxel-brush` on the canvas.
- **What moved out of the structure mode**: the hand stroke's code in `structure-tool.ts` (791 → 694 lines: the
  stroke drag, its cursor, `BrushControl` and store, `strokeCell`), `handStrokeCommand`, `HandStroke` and
  `brushCells` in `structure-shape.ts`, the `stroke` callback of `useStructureTools`. The Hand edits column arms the
  voxel brush on the structure's grid and keeps the structure tool in Navigate for its grid and outline. Its Paint
  sends `voxel: {material, wetness}` with no role (**D762 fixed**). Its commands are now `v: 3`.
- **No command, field or stored thing was added.** The mode sends `editVoxels` only.
- **Tests** (new: `session/voxel-brush.test.ts` 8, `viewport/voxel-brush-tool.test.ts` 10, one in
  `tests/integration/voxel-world/voxel-world.test.ts`; changed: `structure-tool.test.ts`, `structure-shape.test.ts`,
  which lost what moved):
  - the tool with a camera, a stand-in canvas and a fake pick: a 12 m drag of a 4 m brush in 97 picks is one dig
    command of 13 dabs two cells apart, nothing sent before the release; one pick 12 m on gives the same 13; each
    Sculpt tool's mode, voxel and rim; Add on the cell over the ground, refused in words with no material; Flatten's
    height 3 + 6/15 from the first dab on a slope the drag climbs; Paint role-less with material and wetness even
    when handed a role; through the mask a box of columns, and whole again for a brush that uses no mask; Ctrl
    swaps Add to Dig; a structure's grid 7 with its cells once each, Add in front of the wall; the ground, another
    world, a structure and the sky left to the view; Navigate takes no press; Escape drops the stroke and the
    release then sends nothing; a release with the last pick in flight sends once with that cell.
  - the arithmetic: odd cells, spacing in whole cells, the dab cell, the surface height, the trail's thinning, gap
    fill and once-only cells; every tool's command read back by `canonicalEditCommand`; the masked columns against a
    scan of the mask over the footprint; the palette's order, families and colours; what each rail arms.
  - **over HTTP, the tool itself driven** (pointer events, a pick answering from an oracle store) against a real
    backend: five drags (add, smooth, flatten, paint, masked paint) each answered 200 with the oracle's cell count
    and parts, the region files equal to `applyEdit`'s voxels; the ridge over 4 cells high, the step at its foot
    lower after Smooth, the ridge's end flat at the plane 1 where Flatten began; a painted wall still a wall and the
    ground under it ground, wetness 3; the masked paint took some columns and left some; five undos give the first
    bytes. About 0.5 s.
  - **Broken on purpose, each run once** (8): no thinning → 3 red; Flatten's height from the last pick → 1; Paint
    keeping the role handed → 1; the mask never read → 1; the grid always the world's → 1; Escape leaving the stroke
    → 1; a hit on another grid counted → 2; a release not waiting for its pick → 1.
- **Picture E7** (three takes: 21 s, 7 s, 7 s; low load; WebGPU). `~/.cache/thirdlight-phase47b/work/47b.5/`:
  - Take 1 (`pictures/E07-world-mode.png`): the mode open with its column, but the view inside the house (the yard
    object framed is its origin) and no hill, cursor or drag: the screen's script was wrong, and its settle did not
    ask for the cursor. Fixed: the hill in the yard's open corner, a curve over it framed by its bounds, the cursor
    required.
  - Take 2 (`pictures-2/`): the hill and the mode; the cursor stood upright on the slope (it lay on whichever cell
    face the ray entered) and the palette gave every lone material a heading and a row. Both fixed (§8 10, 8).
  - **Take 3, the picture** (`pictures-3/E07-world-mode.png`; settled). Sees: the World editor on "voxel world
    yard": a rounded green hill about 14 m wide and 5 m high with a tan cap (the Dry grass variant painted on its
    top), the road behind it; the Sculpt column with Navigate, Add (armed), Dig, Smooth, Flatten, the shape and rim
    switches, the palette under "Adds" (Ground: Road; Grass: Grass and Dry grass marked V; Construction below, cut
    by the column's end), the Brush panel (4.0 m, 25 %, Dig instead) docked over the view's right side, the status
    line's keys. At the hill's foot a grey mound about 4 m across with the amber ring, its dashed inner ring and
    dot on top of it. Wrong: a band of cell-sized cube corners where the hill meets the flat ground (D837); the
    tan patch's edge is toothed a cell at a time; the mound's base has a ragged fringe; the Brush panel covers part
    of the view. Sure: high for what is there, low for how any of it feels in use.
  - **A real pointer drag was driven** in that screen (Playwright's mouse on the canvas: move, press, 16 moves of
    8 px, release) with Add armed: the tool took it (3 dabs counted while dragging), its command answered ok in
    17 ms, the view's world went from revision 13 to 14, and the mound in the picture is not in
    `pictures-3.raw/screen-world-mode-before-drag.png` (flat grass and the level ring there). The mound is grey
    because the palette's first material is Road. That is one Add stroke on WebGPU in headless Chrome.
- **Gate:** before it, the generators (reference, typings: nothing changed, 6 s), `npm run build` (24 s), `npm run
  lint` (96 s, uncached) and the manual's links test (1 s) green. `tools/gate.sh check` once: GREEN in 249 s (build
  25 s, lint 7 s, unit 191 s: 971 files passed; boot 5 passed, 25 s). No second call. The two new unit files take
  about 4 s together; the HTTP file grew by about 0.5 s.
- **Unverified:** Dig, Smooth, Flatten and Paint with a real pointer; the noise mask's look (cursor fill and painted
  patches); Ctrl+Z in the editor after a brush stroke (the HTTP test undoes the tool's commands); Escape and the F
  drag in a browser; the structure mode's hand edits after the move (unit tests only, no picture); the trail's look
  while dragging (the picture is taken after the release); anything on a world bigger than the 64 m yard.
- **Left out, and why:** the Fill rail, fog paint, the spline entry (47b.6); the Rules rail (47b.10); a menu entry
  for the mode; a preview of the result while dragging and wetness painted alone (§8 1, 6); a strength for Smooth
  and Flatten (47b.3 named none); a cursor that follows the ground's height.

### 47b.6

- **What exists.** The world mode's rail is **Sculpt, Paint, Fill, Splines**.
  - **Fill** (`ui/editmode/world-mode.tsx` `FillColumn`): tools Fog (G), Drain (R), Water (L); the gas palette for
    Fog and the liquid palette for Water (the same `voxelPalette`, asked for one use); Depth, Fade and Reach; the
    reach's bound said in words. Gesture: press a point (the seed: the open cell in front of the face met), drag up
    or down (the level, in 0.25 m steps, drawn as the water bodies' level ring with a post at the seed, read out on
    the status line), release: **one command**. Fog: `{v: 3, kind: "flood", seed, level, value: {the gas, role gas},
    reach, fade?}`. Drain: the same with `{material: 0, role: 0}` and no fade. Water: `createEntity` of a group
    with `waterBody: {world, level, material}` at the seed cell's middle. A `flood_leaks` refusal: the water bodies'
    markers at each place the error names, the status line "The fog leaks past its reach at N places, first at … :
    nothing was written", nothing sent after it.
  - **The fog brush** (Paint, a gas picked in its palette, which now ends with the gases): Fog (P), Erase (E),
    Smooth (S), a Density of 1–15 (shown in per cent), its own brush size (0.5–8 m). **How erase is sent**: the
    cells under the stroke's dabs are read from the view's worker, and the stroke is `{v: 3, kind: "dig", cells:
    [the gas cells]}`; paint is `{v: 3, kind: "set", cells: [the open cells: air and gas], voxel: {the gas, role gas,
    wetness 0, shape: the density}}`; smooth is the brush's `mode: "smooth"` with `voxel` the gas (§8 1, 2).
  - **Splines**: Road (R), Path (P), River (V): a drag from a point to another is one `createEntity` of a spline
    (two points, a width, `voxels` preset), then the mode closes with it selected.
  - **Make a mist / water material** where the project has no gas or liquid (§8 8).
- **What it extends**: the voxel brush tool (`viewport/voxel-brush-tool.ts`, 443 → 545 lines; the gesture in
  `voxel-fill-gesture.ts`, 290, owned by it: one tool on the router, one pick, one arm); `session/voxel-fill.ts`
  (pure: the commands and the cell lists); `session/world-mode.ts` (state, arming, tools); `heightRingLines` moved
  out of the handles' `linesOf` so the fill draws the same ring; `WaterLeakMarkers` (a second group); the
  Inspector's spline start (`splineStartVoxels`, now one function for both); the Scene view worker's wire gained a
  `cells` message (a box of record values from the walk's `record`; nothing stored); the editor's refusal keeps an
  error's `leaks`; `EditModeHost.handOver`.
- **No command, command field or stored thing was added.** `editVoxels` v3 and `createEntity` as they were; the
  `cells` message is between the editor page and its own worker.
- **Tests** (new: `session/voxel-fill.test.ts` 16, `viewport/voxel-fill-tool.test.ts` 12; one added to each of
  `envelope.test.ts`, `tests/integration/voxel-world/voxel-world.test.ts`, `voxel-water.test.ts`):
  - the arithmetic: the flood as `canonicalEditCommand` reads it (seed, level in cells, the gas, reach in cells,
    fade in metres; a drain: air, no fade); the reach bound taken by `editChunks` and twice it refused; the seed,
    the level's step and the drag's scale; a water body's and a spline's create args; the cells a fog stroke names on
    a made box (ground, a wall, a doorway, water, two gases, a cell not loaded); the set and the dig as the backend
    reads them; the gas and liquid groups of the palette and Paint's with gases; what each rail arms; the starter
    material through the project model's check.
  - the tool with a camera, a stand-in canvas, a fake pick and a made world behind the cell read: a fog fill is one
    flood with the level the drag set, nothing sent before the release; a click fills to the depth, a drag down
    stops a step over the surface; a `flood_leaks` answer becomes markers at the places named (the marks' own
    vertices read), says so and sends nothing more, the marks go with a taken fill or when the fill tools are put
    down; a drain sends air; `flood_blocked` and `no_change` said without marks; Water sends exactly one
    `createEntity` and no stroke; no material picked begins nothing; Esc drops a fill; the spline entry's create and
    a click that lays nothing; fog paint a `set` at the density with no ground or water cell in it, erase a `dig` of
    the one gas cell there, smooth the brush's smooth with the gas; no read or nothing loaded sends nothing.
  - **over HTTP, the tool itself driven** against a real backend with `applyEdit` as the reference: a world of rock
    with a pond, a wall block and a basin; fog painted across rock, wall and pond (a `set`, the gas part alone),
    erased over part of it (a `dig`), smoothed, the basin flooded (243 cells: nine by nine by three) and drained;
    after each the region files equal the oracle and **every cell that is not gas is where and what it was** (a
    hash over ground, wall and water with their places); a fill over the rim refused 400 `flood_leaks`, the marks
    at the error's places, the revision unmoved; five undos give the first bytes. 2.5 s.
  - the objects over HTTP (`voxel-water.test.ts`): the tool's own args make a water body that fills its hollow
    (98 cells, `writeWater`, reach 256 from the component) and a road spline (`writeSplines`), each one undo step
    back to the same files.
  - **Broken on purpose, each run once** (12): the fade never sent → 2 red; the seed the cell met → 3 and the HTTP
    test; leaks not marked → 2 and HTTP; fog painted over anything → 2 and HTTP; erase digging any cell → 2 and
    HTTP; the level ignoring the drag → 2; a drain sending the gas → 1 and HTTP; fog smooth without its gas → 2 and
    HTTP; a click laying a spline → 2; water sent as a flood → 1; a refused flood written off as taken → 3 and
    HTTP; **cells not loaded read as air → green**: the marker's bits are neither air nor a gas, so the lists leave
    it out without the explicit line (which stays, for the reader).
- **Picture E8** (four takes: 130 s, 290 s, 21 s, 23 s; WebGPU, load about 1.5–2).
  `~/.cache/thirdlight-phase47b/work/47b.6/`:
  - Take 1 (`pictures/`): the near hollow's fill refused and marked by a real click, but the far hollow never
    filled: the script's scan of the view found no floor cell of it. Fixed (a finer scan).
  - Take 2 (`pictures-2/`): both fills by the real pointer; the facts of the second were the first's answer read
    again, the scan took four minutes, and the ring had two posts (the handle's at its rim and the seed's). Fixed:
    one scan for both hollows, the answer awaited by its change, the post at the seed only.
  - Take 3 (`pictures-3/`): as take 4 without the fog brush stroke.
  - **Take 4, the picture** (`pictures-4/E08-world-fill.png`; settled). Sees: the World editor on the yard, the
    rail Sculpt, Paint, Fill (shown), Splines; the column Navigate, Fog (armed), Drain, Water, the Fog palette with
    one tile (Mist · gas · 31), Depth 1.50 m, Fade 1.00 m, Reach 8 m and the line "One fill reaches at most 63 m";
    in the view two square hollows in the grass, the house's corner at the left, the lane behind; over the near
    hollow a thin orange ring half a metre under its rim with a post from its floor; its trench running to the
    lower left with a red cross and ring where the fill passed 8 m; the status line "The fog leaks past its reach
    at 1 place, first at (21.0, -1.3, 8.8) m: nothing was written. Close the gap, …". **The fog itself is not
    drawn**: the far hollow, which the facts say was filled (the command answered ok, the view's world went from
    revision 8 to 9), looks exactly like an empty one, and so does the fog the brush painted in the near one.
    Wrong: nothing shows a fill that worked; the ring is thin and easy to miss on the grass; the leak mark is large
    and partly behind the Project bar at the view's bottom; the editor's status bar also says "error
    flood_leaks" in red beside the mode's own sentence (D839); the Project bar covers the view's lower edge. Sure:
    high for what is there; nothing on how the gesture feels.
  - **Real pointer events drove it** (Playwright's mouse on the canvas): one stroke of the fog brush on the Paint
    rail with the Mist picked (3 dabs, the cells read from the view's worker, a `set` of 303 cells answered ok in
    34 ms, revision 7 → 8); a press on the far hollow's floor, a drag down until the level read -0.5 m, a release
    (flood ok, revision 8 → 9); a press and release on the near hollow's floor (400 `flood_leaks`, one place
    marked, revision unmoved); the Reach typed into its field. Drain, Water, the spline entry, Erase and Smooth
    were not driven in a browser.
- **Gate:** before it, the generators (reference, typings: nothing changed, 6 s), `npm run build` (24 s), `npm run
  lint` (96 s, uncached) and the manual's links test (1 s) green. `tools/gate.sh check` once: GREEN in 253 s (build
  26 s, lint 8 s, unit 191 s: 973 files passed; boot 5 passed, 28 s). No second call. The two new unit files take
  about 4 s together; the two HTTP files grew by about 3 s. Picture time: 464 s over four takes of E8 (a take is
  about 22 s now).
- **Unverified:** the fog and what any fill looks like (nothing draws gas); Drain, Water, Erase, Smooth and the
  three spline kinds with a real pointer; the hand-over to a spline's handles and the Make a material buttons in a
  browser; the keys G, R, L and P, E, S, V; Ctrl+Z in the editor after a fill; a fog stroke right after another
  edit of the same cells (D840); a fill dragged from straight above; anything on a world bigger than the 64 m yard.
- **Left out, and why:** the gas draw and the density overlay (47b.7); a fog body that follows ground edits (§10
  3); a soft rim or a density by coverage for painted fog, and a fog brush wider than 8 m (they need a brush mode
  in the command: owner); a starter material in the kit (§8 8); a preview of what a fill would cover before the
  release; a spline's later points inside the mode.

### 47b.7

- **What exists.** Fog is drawn. A derive section's **gas part** (`packages/voxel/src/derived-gas.ts`): its gas
  faces against open space as quads (material, the face's own cell's density, the density of the cell behind it),
  and its gas as runs up its columns. `DERIVED_PART.gas` has its builder (`ALL_DERIVED_PARTS` 127, derived 35); a
  gas-only change derives that part alone (`SURFACE_KEEPING_PARTS`, one cell of apron), the chunk's batch carries
  a `gas` entry and the page replaces the chunk's gas mesh alone. The draw (`three-adapter/src/voxel-gas-draw.ts`):
  one more mesh of the level-0 chunk draw in the gas material's colour, unlit, casting nothing, its opacity from the
  scene's depth behind each face; one screen-wide layer while the eye stands in gas; a density overlay; the
  programs made with the first gas part. In Play, exports and the Scene view through the one chunk view; structure
  grids the same way. The world mode has a **Fog in the view** switch (As drawn, Density).
- **Shared with liquid, not copied**: `derived-medium.ts` (the 16-byte quad and its writer, the rectangle merge, the
  join, what closes a medium's face) and `three-adapter/voxel-medium-geometry.ts` (a quad list as a geometry);
  `derived-liquid.ts` lost 94 lines to them and gives the same bytes (its tests untouched and green).
- **How opacity is made, the inside view, the order**: §8 "47b.7" 1, 2, 5.
- **Stored:** nothing. No record bit, file, manifest key, far-cache channel or material field; `voxel.gas`'s two
  fields as approved (the default density's value changed: §8 6).
- **Tests** (new: `packages/voxel/src/derived-gas.test.ts` 13, `packages/three-adapter/src/voxel-gas-draw.test.ts`
  10, `tools/voxel-bench/bench-fog.test.ts` 4; one added to `exporter/src/closure-materials.test.ts` and to
  `editor/src/session/voxel-fill.test.ts`; changed: `tools/voxel-bench/liquid.test.ts`, `voxel/src/chunk-batch.test.ts`):
  - the part on made cases: a box in the air (six quads, whole cells, both densities); a sheet a cell thick
    (nothing behind its faces); on ground, against a wall, against ground filled to the surface (no face) and
    below it (a face); over water (the faces it has over a dry hollow; the water's own unchanged; draining the
    pool leaves the gas part byte for byte); two densities and two gases side by side (no face between, the shared
    faces split); a fill's soft top (15, 11, 4: the top quad carries 4 and 11, a side a quad a row); density 0 as
    air; the runs (materials apart, densities summed; kept where gas is closed in and shows no face); across a
    chunk border (no inner face, the tops meet on the border); a chunk's eight sections joined against the whole
    chunk (same area a face, no quad on an inner border, the same gas cells by column, a run split at a section);
    the part alone from a one-cell apron, byte for byte the full derive's.
  - the narrowed feed through real workers and region files (`liquid.test.ts`, on the slow list, run once: 45 s):
    a gas stroke over a lake across four chunks answers the gas part alone and derives it for exactly the
    sections within one cell of the stroke (no `derived`, shader, liquid or collision derive; `gasDerives` = that
    count), every section standing equal to a fresh derive of the world with the gas, faces and runs.
  - the draw against the real derive, join and batcher: no gas, no program, layer or mesh; a bank is one mesh
    named for its material's look (26 triangles, the top's densities 4/15 and 11/15, transparent, no depth write,
    front faces, no lights, no shadow, counted in the chunk's bytes), the table holding the record's colour and
    density and the defaults for a gas no record names; a gas-only change: the batch is one `gas` entry, no mesh
    build, no grid upload, **the surface mesh the same object with the same geometry**, the old gas geometry
    disposed; erased: the mesh goes, the chunk stays; the eye's run joined across a section and a chunk border, its
    slab, the fade under the top, off above, beside and under, and off again once the bank is erased under a camera
    standing in it; gas closed in keeps the eye's fog; the overlay a switch with the same mesh and material; both
    programs build to WGSL (the hull reads the scene's depth and no light; the layer no model matrix); through
    `VoxelWorldDraws` (a batch's gas entry, the stats, the overlay for a world drawn later, a record's change with
    no new mesh); the page flag; dispose lets go of the hull's geometry and program and the layer's.
  - the export: a build with a voxel world ships its gas materials with `voxel.gas` (an instance's folded onto its
    base's, a look left out left out), nothing without a voxel world.
  - the editor: the overlay shows only while its switch is on and the rail has fog tools.
  - the bench fog: the lot is empty; the hollow's dig and the flood are commands the format takes, the flood stays
    in the hollow and thins to its top, a drain takes it back to the dug hollow cell for cell; the cameras stand in
    clear air and in the bank; placed and taken out through the commands in the order the undo needs, a leftover
    hollow not undone, a leak not swallowed.
  - **Broken on purpose, each run once** (13, all red): the density behind a face never written → 5; a face made
    toward a gas of another density → 2; a liquid closing a gas face → 1; runs joined without their section's
    origin → 2; the gas part not a surface-keeping part → 1; a gas-only change sending no gas entry → 2; a chunk
    keeping no runs → 6; the eye's run not looked up again when gas changes → 1; the layer and its program not let
    go → 1; the gas flag ignored → 1; the overlay not given to a world drawn later → 1; the overlay shown on every
    rail → 1; the bench's flood over the lot's ground → 2.
- **Pictures** (three takes: 130 s, 86 s, 24 s; low tier, WebGPU, staging's 8 km town and a fresh backend's yard).
  `~/.cache/thirdlight-phase47b/work/47b.7/`:
  - **L23** `pictures/L23-fog-bank.png` (take 1; streaming still after 5.5 s, the light volume settled; the hull
    130 triangles, the eye outside). Sees: the town at noon from 6 m up; in the empty lot a round hollow about 13 m
    across filled to just under its rim with a pale grey-white mist, the grass and four houses round it. The bank
    is opaque over most of its area and thins over the last metre toward the hollow's sides, where the earth of
    the wall shows through (brown at the far side, the ground's steps at the near rim); no line where it meets the
    ground, no box edge, no seam at the chunk borders it crosses. Wrong: it reads as a bowl of milk more than as
    mist: one flat colour with no shading or depth cue across its middle (the path through it from this height is
    over 10 m, so it is fully opaque there); the ground's cell steps show as dark teeth through the thin fog at
    the near rim (the ground's own, D837); faint radial streaks at the far side where the wall's steps show
    through. Sure: high for what is there; nothing on how it looks while the camera moves.
  - **L24** `pictures-2/L24-fog-inside.png` (take 2; settled; the facts say the eye stood in gas). Take 1
    (`pictures/L24-fog-inside.png`, looking 14° up) was one grey with two faint house shapes: too little to judge,
    so the camera was tilted to 29° up; nothing of the draw changed. Sees: from 1.7 m over the hollow's floor, a
    grey murk over the whole picture; through it the flat grey shapes of a gabled house with three faint windows
    and a roof to the right, and the sky, bluer and a little clearer toward the top of the picture; the lower
    third is even grey (the hollow's wall, about 8 m off, cannot be told from the fog). No clear patch, no seam or
    line where the bank's surface is, no hull face seen from behind. Wrong: the fog is mid grey here and near
    white in L23: the bench camera's exposure follows the picture, and a view that is all fog is brought to
    middle grey (the fog has one unlit colour; nothing adapts it); very little can be seen at all at this density
    (0.5 a metre: things fade within about 5 m); the houses are flat shapes. Sure: medium: it shows the layer
    covers the view evenly and thins upward; it cannot show the near ground against the far, or the crossing of
    the bank's surface.
  - **E8** `pictures-3/E08-world-fill.png` (take 3, as takes 1 and 2; settled; 290 gas triangles in the Scene
    view). Sees: the World editor's Fill rail on the yard; the far square hollow holds a pale mist, thin at its
    near edge and thicker toward its far side, the hollow's sides showing through; in the near hollow the fog
    brush's stroke is a pale blocky cloud; the level ring, the leak's red mark and status line as in 47b.6; the
    panel has a new section "Fog in the view" (As drawn / Density). Wrong: the brush's blob shows its cells: two
    bright square faces and a stepped outline (D841); the mist in the far hollow is faint at its near edge; the
    editor's red "error flood_leaks" is still there (D839). Sure: high.
  - **The density view** `pictures-3.raw/screen-world-fill-density.png` (the same view, the switch on Density;
    the view's attribute read `density`, then `off` again). Sees: the far hollow's fill a flat purple (its top
    cells' density, 4 of 15, between blue and magenta), the brush's blob pink-magenta (8 of 15), both nearly
    opaque and plain against the grass. Take 1's colours ran blue to yellow and gave grey at the fill's density;
    take 2's green was lost on the grass; each was changed for the next take. Wrong: the colours are pastel (the
    view's tone mapping); a bank shows only its outer cells' density. Sure: high.
- **Cost** (never a gate; `run.mjs headroom --quality low --fog --copies none --scales none`, one round a run, the
  camera orbiting the hollow 10 m out and 7 m up so the bank fills about a quarter of the view; WebGPU,
  1280 × 720, the 30 Hz cap; alone on this shared box, load 1.4–2.9; 213 s, 178 s, 183 s):

  | Run | Gas | `near` ms (spread) | Frame GPU ms | Room (ballast held) | Resolution ms |
  |---|---|---|---|---|---|
  | 1 | drawn (130 triangles) | 6.99 (0.29) | 17.01 | 60 | 1.73 |
  | 2 | drawn | ≥ 6.81 (1.44) | 14.54 | none held | 0.48 |
  | 3 | not drawn (`voxelGas=off`: 0 triangles, no program) | 5.93 (1.51) | 15.95 | none held | 0.67 |

  Run 2 was meant as the gas-off run: the editor did not pass Play the flag, so it is a second drawn reading (the
  flag is passed since 345e7c9c; run 3's facts show it off). **About 1 ms of `near` with the gas drawn, not
  resolved**: the difference is under the spread between samples, and two runs alike differ by more (the room 60
  copies and none; frame GPU 17.0 and 14.5 ms). The eye's layer (the camera inside a bank) was not measured.
  Medium and high: unverified on target hardware. `perf-recommendations.md` row 47.
- **Gate:** before it, the generators (reference, typings, graph API: nothing changed, 6 s), `npm run build`
  (24 s), `npm run lint` (97 s, uncached) and the manual's links test (1 s) green. `tools/gate.sh check` once:
  GREEN in 258 s (build 26 s, lint 10 s, unit 195 s: 976 files passed; boot 5 passed, 27 s). No second call. The
  three new unit files take about 8 s together; `liquid.test.ts` (slow list) was run once, 45 s. Picture time
  240 s over three takes; the cost runs 574 s.
- **Unverified:** anything in motion (walking into and out of a bank, the layer coming in, the temporal upscale
  on the hull and the layer); fog by night and under lamps; fog beside glass, particles or water in one view; a
  structure grid's gas; an exported game's fog (the boot check's export holds none; the batches and the material
  rows are the same); the density view anywhere but E8's yard; the eye's layer's cost.
- **Left out, and why:** light, shade, a march, drift, fog past the detail ring (51); where a bank ends in the
  air (D841: a second depth for the hull's far side, or 51's march); a density overlay of a bank's inner cells; a
  fog tint that follows the camera's exposure or the sky.

### 47b.8

- **What exists.** A material grows what its dressing says, as data and as points; nothing is drawn yet (47b.9) and
  nothing in the editor shows it (47b.10).
  - **The dressing asset, format 1** (project-model `dressing.ts`; spec: render spec §1 *The dressing asset*):
    `{dressingFormat: 1, dressingId, name, species: [...]}`, a species `{model, class: cover | large, density,
    spacing?, scale?: [min, max], yaw?, align?, seed?, conditions?}`, conditions `{material?: [voxel ids], role?:
    [role names], slope?, height?, sky?: boolean, wetness?, waterDepth?, materialEdge?, construction?, noise?: range +
    {scale, seed?}}`, a range `{min?, max?, fade?}`. A resource kind `dressing` (`content.dressings`, a file
    `assets/dressings/<id>.dressing.json`), unknown fields and an eleventh condition refused.
  - **`voxel.dressing`** on the material's voxel block, last in canonical order, resolved along an instance chain
    with the kit (`mergeMaterialVoxel`); `dressing_missing` for one the project lacks, refused on a liquid or a gas;
    `voxelDressingIds` gives each voxel id's dressing.
  - **Commands**: `setDressing {dressing}` (create or replace) and `deleteDressing {dressingId}`, one undo each, the
    same for the editor's route and MCP's `tl_command`; a material's dressing is `setMaterial`'s. Reference text in
    `tool-docs.ts` and the generated pages (content block `dressings`, the two ops, `DressingDef`, `DressingSpecies`,
    `DressingConditions`, `DressingNoise`, `FadeRange`); the behaviour API typings did not change.
  - **The schema**: stays 8, with the recorded step `dressing` (§8 "47b.8" 1): 37 fixture files and
    the two templates gained the name, by the fixtures' own generator.
  - **The rules' one arithmetic** (`@thirdlight/voxel` `dressing-rules.ts`, no three, no `node:`):
    `dressingRule(conditions): DressingRule` (the sets as lookups, `distances`: whether the fields must be read with
    theirs); `dressingShare(rule, p: SurfacePoint, x, z): number` (0 … 1, the product); `dressingWhyNot(rule, p, x,
    z, clear?): DressingConditionName | 'prop' | null`; `dressingConditionAt(rule, name, p, x, z)` (one condition's
    value, for the Rules rail); `dressingNoise`; `propClearances(shapes: PropShape[]): Float32Array` and
    `clearedByProp(clear, x, y, z)`. Share and reason read one table of checks.
  - **The voxel source of the scatter core** (project-model `voxel-dressing-source.ts`):
    `voxelScatterSurface(reader, species): ScatterSurface` (every floor of a column through `at` and `under`);
    `voxelCoverTable(content): VoxelCoverTable` (plain data: the named dressings and `[voxel id, dressing index]`
    pairs); `voxelCoverPoints(input: {fields: SurfaceFieldsInput, rows?: [cy0, cy1], table, clear?: Float32Array},
    decompress?): {sets: [{dressing, species, rule: ScatterRule, points: CoverPointSet}]}`; `voxelCoverOfCells`
    (the same from a box of cells); `voxelCoverJobHandlers` (`'voxel-cover'`) and `voxelCoverTransfer`.
  - **What 47b.9 is handed**: for a chunk column (or the rows of one chunk), one set a cover species that grows
    there, each the pair the point-set path takes today (`CoverRows`' `rule` and a `CoverPointSet`, 16 bytes a
    point, in the grid's metres, sorted by threshold), named by its dressing id and the species' place in the list.
    It sends `surfaceFieldsInputOf(store, cx, cz, cy0, cy1)`'s input with the table and the props' boxes, as a pool
    job of kind `voxel-cover` once a worker entry serves `voxelCoverJobHandlers`.
- **Reused, not rebuilt**: `bakeCoverPoints`, `ScatterSurface`, `ScatterRule` and their hashes untouched
  (`scatter.ts`, `cover-points.ts`: no line changed); the surface fields' kernel (one function added beside it,
  `surfaceNormal`, from the slope's own two gradients; `surfaceFieldsCells` takes its ring as an argument); the
  brush mask's noise (`valueNoise01`); the rule range (`ruleRangeAt` moved to `@thirdlight/shared` as `fadeRangeAt`,
  `RuleRange` now its alias: one definition, no behaviour change); the resource files, the record ops' shape and
  the catalog blocks as voxel kits use them; `propBounds`.
- **Stored beyond G5:** nothing. No per-plant list, no painted density, no record bit (the two reserved bits
  unspent), no clearance field, no manifest key of a voxel world. The build's catalog gains the block `dressings`
  (shipped, derived from what is stored).
- **Tests** (new: `packages/voxel/src/dressing-rules.test.ts` 13, `packages/project-model/src/dressing.test.ts` 9,
  `packages/project-model/src/voxel-dressing-source.test.ts` 8, `tools/voxel-bench/dressing-cover.test.ts` 14; one
  added to `tests/integration/voxel-world/voxel-world.test.ts` and to `exporter/src/closure-materials.test.ts`;
  changed for the new kind or step: `descriptors.test.ts`, `manifest-v5.test.ts`, `upgrade-interactor.test.ts`,
  `format-upgrade.test.ts`, `create-scan.test.ts`, `m41-platformer/upgrade.test.ts`, `editor-op-reach.test.ts`):
  - **the evaluator on the research's examples**, each a world of real cells read by the fields' kernel: grass on
    grass under sky (not the path, not under a roof, not under water); reeds in a depth range (dry and deep out, a
    faded edge a share); moss on a cave's wet floor (the meadow over it: `sky`; the dry half: `wetness`); flowers
    within 1.5 m of a path (and the converse, nothing within 2 m); a fringe within 1 m of a wall on both sides (the
    wall's top: `role`); nothing under a foundation (the ground there is no surface, the slab's top is not ground)
    nor in a stamped footprint (no surface at all); a prop's box (a turned crate, a chest on the storey above that
    does not clear the ground floor, a prop sunk half a metre); a slope limit and its fade; a height band, wetness
    and the product of two soft conditions; noise patches (about half the ground, neighbours a metre apart agree
    over 90 % at an 8 m scale and under 70 % at 0.5 m, another seed another pattern, unmoved by sculpting); each
    of the ten conditions alone named as the reason, the first in order when two fail.
  - **the asset**: every field kept through the content validator's canonical round trip given with every level's
    keys reversed, byte for byte; defaults left out; 46 bad values refused each at its path (38 of them a species'); the kind's row; the
    species as a scatter rule the core's own validator takes; `voxel.dressing` canonical, `dressing_missing`, a
    liquid and a gas refused; an instance's own dressing and its parent's; the models a build ships; **the recorded
    step on an old project's documents** (pending on an 8 without it, the content the same object, no note, named
    after), and through a real backend on files (`format-upgrade.test.ts`: a manifest set back to `['planes']`
    opens with `dressing` among its upgrades).
  - **over HTTP against a real backend** (about 1 s more in that file): a dressing made (its file on disk holding the
    record whole), four bad ones refused, edited and undone (the file follows), set on a material, a missing one
    refused, a variant naming another, both dressings refused deletion while named, the variant undone and redone,
    MCP's `tl_command` and `tl_content_query`, a spare one deleted (file gone) and undone, a restart reading the
    files, and **an export** shipping the two named dressings, the variant's voxel block folded, the species' model
    among the project-wide dependencies (the export's bundle scan ran as it does for every export).
  - **the source**: every floor of a column in turn with its height; the layer share's answer; the normal on a
    45° slope; 1,024 candidates of 16 m × 16 m at 4 a m² all kept, sized and turned in range, sorted by threshold;
    spacing held; a share of one half keeps 512 ± 96 of 1,024, a subset of the full set, the same again; the large
    class skipped where it stands (and placed when called cover). **On a made world in a real chunk store** (a
    rolling meadow, two road strips, a pond, a dry-grass variant, a hill with a wet cave, a house with an upper
    storey): each point on a surface whose material names its species' dressing; reeds only in the shallows; flowers
    at the verge, thistles nowhere within 7.8 m of it, clover in soft patches; moss on the cave floor and lichen on
    the hill over it in one column; dust on the storey's boards and no grass on the ground floor under them; the
    oak never; a cart's box clear, the same cart hung 6 m up clearing nothing; the same bytes twice and from the
    world built again; **chunk borders against one bake over the whole world** (four middle chunks, and the pair
    the thistle's reach straddles: every point has its twin, in either order; the same species judged from a box
    cut at the fields' own reach gives other points, asserted); the rows of a column part its points (a top face on
    the chunk border stays with its cells); **an edit elsewhere leaves five other chunks byte for byte**, the
    edited chunk loses only the repaved square's plants.
  - **same answer on page and worker**: five jobs (the cave's, the pond's and the house's chunks, a row range, a
    prop) through a real `worker_threads` worker running the bundled worker: every set's rule and point bytes equal
    this thread's. A browser build of a worker serving the job alone (46,414 bytes minified) passes the export scan.
  - **Broken on purpose, each run once** (30; `~/.cache/thirdlight-phase47b/work/47b.8/breaks.log`): 26 red at
    once (sky inverted → 14 tests; each distance, the water depth and the role never read → 3–4; the noise without
    its seed or its scale → 1; the reason the last failing condition → 2; the prop's box without its height, or
    never → 2; the share never thinning → 1; only the top floor → 4; the large class placed → 2; the material never
    checked → 7; the normal always up → 2; the canonical form dropping `align`, a condition, or `voxel.dressing` →
    1–3; an unknown condition accepted → 1; an instance unable to override → 4; `dressing_missing` unchecked → 2;
    the step unrecorded → 1; the undo restoring nothing, the export's block empty, the models not captured, a named
    dressing deletable → 1 each). **Four stayed green and their tests were sharpened until red**: the share's pick
    reading the box's origin (no species with a soft share crossed a border: clover added); rows cut by height
    (no surface lay on a chunk border: the hill's top moved to one); species reordered by model (the test's two
    were already in that order); the box cut at the fields' reach (a wrongly kept candidate past a border rarely
    outranks its neighbours: a case and a seed where it does, with the difference asserted).
- **Cost** (the bench test's line, this shared box, reported and not asserted): a chunk column of the made world,
  nine cover species in the table, in this thread: 10.4 ms for 936 points of 5 species, 9.7–10.1 ms for 751, 14.0 ms
  for 1,247 (the box of nine columns read and tabled each time: about half, by 47b.4's split). Not run on the town.
- **Gate:** before it, the generators (reference: 17 pages changed; typings and graph API: nothing), `npm run
  build` (24 s), `npm run lint` (97 s, uncached) and the manual's links test (1 s) green. `tools/gate.sh check`
  once: GREEN in 264 s (build 25 s, lint 12 s, unit 199 s: 980 files passed; boot 5 passed, 28 s). No second call.
  The four new unit files take about 9 s together; the HTTP file grew by about 1 s.
- **Found on the way:** the editor's icon registry asks a picture of every resource kind: `dressing.webp` is a
  copy of the kit's (as the voxel kit's is), a stand-in until 47b.10 draws one. The descriptor size ledger's bound
  rose 390,200 → 394,400 with its line (the dressings block and the field, 4.1 KB).
- **Not built, and why:** cover in the derive workers and any draw (47b.9: the worker entries do not serve the job
  yet, and nothing gathers a scene's props into boxes); the Dressing card, the Rules rail, a starter dressing and
  the manual page (47b.10); the large class's placement (47p); a yaw range that starts past 0, a sink, a priority
  between species, a clearance radius a prop, "no dressing" on a variant (none named by G5; lines for after the
  merge); a dressing check in Problems (D843).
- **Unverified:** nothing here draws, so there is no picture and nobody has seen a plant. The Scene view, Play
  and exports do not read `voxel.dressing` yet. The cover job was run in a Node worker, not in a browser's. Its
  cost was read on a made world of four chunks a side, three columns once each. D842's case (16-cell chunks) was
  reasoned, not run. The material section's voxel fields in the editor keep a `dressing` they are handed (the
  section spreads the block) but show no field for it, and were not opened in a browser.

### 47b.9

- **What exists.** Grass, flowers, reeds and pebbles are drawn on a voxel world by the dressings of its materials,
  in Play, in an export's worker entry and page (the same code; an export was not looked at) and in the editor's
  Scene view, and follow sculpting, painting, water, dressing edits and static props.
  - **Where the points are made**: `@thirdlight/voxel` `cover-stream.ts` (`ChunkCoverStream`), where the world
    runs. The draw batcher tells it of every level-0 chunk whose draw is sent, changed or removed
    (`ChunkDrawBatcherOptions.cover`); it asks 47b.8's `voxel-cover` job for the chunk's column (the surface
    fields job's input: the column and the eight round it, from a row under the lowest drawn chunk up to the
    highest loaded one, the game's changes laid over; the table; the keep-clear boxes; a structure's stamps as
    `built`) and hands the answer to the batcher (`ChunkDrawBatcher.cover` → `ChunkDrawBatch.cover`). A job a
    column: not a derive part (§8 "47b.9" 1). What makes it again and what an edit costs: §8 2, 3.
  - **How they are drawn** (foundation 6, nothing new): `three-adapter` `voxel-cover.ts` (`VoxelCover`, owned by the
    scene's `CoverView`) makes each cover species of a world one point source of `CoverGpu` (`setPoints`), the
    path block layers', models' and architecture's cover take: the rule's `CoverPointAtlas`, its `CoverRows` as
    rows of the scene's culled-instance table (`writeCoverPointRow`, the table's level, thinning and culling), the
    models' own materials (wind and the interaction field where a material asks). It holds the sets the batches
    brought and answers the path's `points` when it asks. Added to the path: `CoverGpu.dropPoints` /
    `CoverPointAtlas.drop` (a column let go frees its points at once instead of after 300 frames).
  - **Wiring**: Play and exports: `game-host` `voxel-play.ts` (the stream made with the batcher in `present`, the
    table from the build's catalog: `voxelCoverTable(manifest)`, `sim-protocol`'s `voxels.cover`), runtime
    `voxel-worlds.ts` (`coverKeepsClearOf`: the static models' boxes, to `VoxelWorldConnection.coverClear`), the
    page's `VoxelWorldDraws` (`cover` option → the adapter's `cover().voxels`). The Scene view:
    `scene-voxels-worker.ts` (a `cover` message: the table and the boxes), `scene-voxels.ts` (the table read with
    the kits by `queryGameConfig`, again on `setDressing` and on a material's dressing change; the boxes from
    `SceneQueries.staticModelBoxes` and the structures' boxes). The three worker entries serve the job
    (`editor/voxel-world/voxel-worker.ts`: the editor's, the Scene view's and Play's; `export-voxel-worker.ts`)
    through project-model's new `./voxel-cover` subpath.
  - **The budget a tier**: the memory table's `voxelCover` entry and the arbiter's `voxelCover` slice (§8 6).
- **Stored:** nothing. No file, manifest key, record bit, far-cache channel, command field or dressing field.
  `DERIVED_FORMAT_VERSION` stays 35.
- **Tests** (new: `tools/voxel-bench/cover-stream.test.ts` 6, `packages/three-adapter/src/voxel-cover.test.ts` 5,
  `tools/voxel-bench/bench-cover.test.ts` 7; one added to `tools/voxel-bench/world-host-grids.test.ts`; the made
  world of 47b.8's test moved to `dressing-world.ts` for both; changed for the new entries:
  `quality-levels.test.ts`, `page-memory.test.ts`, `profiler.test.ts`):
  - **the stream, with the real batcher and the cover job in a real worker**, on 47b.8's made world: every drawn
    column gets its cover after its draws (16 columns, 15,364 points; each column byte for byte what this thread
    gives; grass on grass at its cell's fill height); **a road painted across a meadow** (a shader-only change):
    its grass gone, flowers at its verge where none stood, nine jobs, fewer than nine columns sent, every column
    equal to a pass over the edited world and the untouched ones the same objects, no chunk joined again but the
    painted one; **a dig** (plants on the pit's floor, none in the air), **water in it** (a liquid-only change:
    reeds, no grass), **fog** (a gas-only change: no job, no wire); **a dressing change** (16 jobs, no chunk in any
    batch, no join; the same table again asks nothing; work of the near field waiting holds every job back; a
    second change overtakes the first's job, whose answer is never sent; no dressing lets every column go with no
    job); **a prop's box** (kept clear, 1–4 jobs; moved: the old place grows again, the new is clear; a stamp told
    to the stream clears the ground under it); **the column's end** (a chunk no longer drawn but resident loses its
    points; the last chunk's `remove` and the column's cover leave in one batch; a column drawn again asks one
    job; closed with a job out: given up, nothing sent, nothing asked after).
  - **the page, through the real cover view** (its atlas, its rows, a stand-in table): a point a row, each the
    copy `writeCoverPointRow` makes, drawn by the path's row draws (`rowsPlacement`, the rule's bend); a column's
    new set rewrites its 256 places alone; a column let go loses its rows at once; a species goes with its last
    column and the table forgets it; a rule that reads differently is taken again; a world closed and the view
    disposed let everything go (the resident-bytes reading back to what it was: the release test); the tier's
    entry read by its id, half the budget hands over the half of each set with the lowest thresholds; a slice of
    no time hands over one set a frame; a batch's cover reaches the path after its chunks, a structure grid's not,
    a closed world's is closed.
  - **a game through a real runtime** (region files, workers, three houses in their own grids at 0°, 30°, 45°):
    cover arrives in the world's batches, never before its column's draw; none inside any house; a crate marked
    Static kept clear and the same crate not marked grown over.
  - **the bench** (below): its strokes and dressings valid, what grows where on the town's own ground, its
    cameras in clear air, placed and taken out in the order the undo needs.
  - **Broken on purpose, each run once** (25; `~/.cache/thirdlight-phase47b/work/47b.9/breaks.log`): 22 red at
    once (gas feeding cover; a change making only its own column, or nothing; an equal answer sent again; a
    column's cover kept after its last chunk; a dressing or a box change making nothing; jobs not given up at
    close; the batcher not telling of a removed or a drawn chunk; a column let go keeping its points; the budget
    never weighed; the slice ignored; a closed world keeping its cover; a new rule not taken; a grid's cover drawn
    as the world's; the stamps not read by the job; every model kept clear; none kept clear; the bench's shelf a
    row short; its flowers anywhere). **Three stayed green and were sharpened until red**: the job answering every
    row (the test unloaded the chunk: now it is only no longer drawn), a stale answer sent (no change ever
    overtook a job), and a stamp landing making nothing again: that one is now tested at the stream
    (`builtChanged`), and **the line in `voxel-play.ts` that calls it for a real stamp is still green when
    removed** (in the runtime test the stamps land before the first cover job).
  - **Not tested by a unit test**: the Scene view's page and worker messages (seen in a picture, below); an
    export's page (the worker entry builds and passes the bundle scan in every build; 47b.8's HTTP test ships the
    dressings and their model, and `dressing.test.ts` shows the models are assets a build needs because a dressing
    names them; in Play the stand-in models, named by nothing else, were loaded and drawn).
- **The bench cover** (`tools/voxel-bench/bench-cover.ts`; §8 9): four stand-in models, two dressings (the meadow on
  the town's grass: grass under open sky on dry ground; flowers within 1.5 m of another material and 3 m from
  anything built; reeds where water stands 5–60 cm deep. The road on its gravel: pebbles within 0.75 m of its
  edge), a gravel road painted across lots (2, 6) and (3, 6) and a shelf set under the rim of lot (6, 4)'s pond
  (the town's ponds are as deep at the rim as in the middle: no shallows). Placed by commands, taken out by the
  undo and the commands; `headroom --meadow [--cover]`, `coverage --cover`.
- **Found on the way: staging's far cache was a revision behind** (left by 47b.7's last bench run: D845). The
  first two takes of L25 and L26 were so taken with no far field, and the first headroom run waited seven minutes
  and failed. The backend rebuilt the whole cache (about 25 minutes, in the background, while tests were
  written); its baked fine levels are gone (D644; no scene of the staging project asks for a bake). The benches
  now read the far route after their undo.
- **Pictures** (three takes of L25 and L26: 96 s, 93 s, 92 s; low tier, WebGPU, staging's 8 km town; all settled).
  `~/.cache/thirdlight-phase47b/work/47b.9/`:
  - Take 1 (`pictures-1/`): the cover drawn, every plant pale grey-green and the flowers nearly invisible: the
    stand-ins' colours were written as sRGB into glTF's linear factors. Fixed (the bench's colours).
  - Take 2 (`pictures-2/`): the colours right; no hills or mountains behind the town (the far cache stale, D845).
  - **L25** `pictures-3/L25-cover-meadow.png` (take 3; settled after 12.1 s; 5,058 clumps and 289,278 triangles
    drawn by the profiler's counters; 65,129 points resident in 76 column sets of 4 species). Sees: from 2.4 m up
    a meadow of dark grass clumps over the empty lots, a grey gravel road crossing it into the distance with
    yellow tufts along both its edges, eight houses round it, green hills and grey mountains behind. Every clump
    stands on the ground; none on the road, none on or in a house; the clumps get sparser with distance and are
    gone about 35–40 m off with no line where they end; no chunk-shaped patch. **Wrong**: the blades are bluer and
    darker than the grass they stand on (teal against yellow-green) and all one flat tone: no shading toward
    their roots and no shadow on the ground, so the meadow reads as strokes laid over a flat floor (the stand-in's
    near-vertical normals take the sky's light; cover casts no shadow); the ground shows between the clumps
    everywhere; the pebbles on the road's shoulder cannot be made out; past 40 m the lots are bare (the known
    limitation, soft here); the blades are soft at this render scale. Sure: high for what is there; nobody has
    seen it move.
  - **L26** `pictures-3/L26-cover-reeds.png` (take 3; settled after 5 s; 3,955 clumps, 235,120 triangles drawn).
    Sees: the pond in its stone rim from 8.5 m off; thin olive-tan reeds standing in the water all round inside
    the rim, the middle open water; grass clumps on the lot up to the rim; houses and a hill behind. No reed on
    dry ground or in the middle, no grass in the water. **Wrong**: the reeds are thin lines that are hard to read
    against the blue water, and where they meet the bed cannot be seen (the water is opaque); a few grass blades
    at the rim's foot cut into its stone blocks (a clump leans up to 0.16 m past its point; nothing keeps cover
    off a wall's foot unless a rule says so); the same flat teal blades with no shadow. The flat blue water is
    47a's. Sure: high.
  - **The Scene view** (not on the list; `pictures-e7b.raw/screen-world-mode-cover.png`, taken after E7 on the
    made yard, 12 s; the view's state: 2 species, 22,423 points in 23 sets, nothing pending). Sees: the editor on
    the yard with dark tufts all over the grass and up the sculpted hill, yellow tufts round the hill's tan cap
    (where the dry-grass variant meets the grass) and none on the grey mound of road material or the lane.
    `…-cover-house.png` frames the house: the whole yard from far above, its foot too small to judge (D846). The
    meadow was then taken off by the commands and the view's cover went to 0 points. Wrong: at this distance the
    tufts are specks. Sure: high that the Scene view draws cover and lets it go; low for anything close up.
- **Readings** (never a gate; alone on this shared box, capped, low tier, WebGPU, 1280 × 720, the 30 Hz cap; load
  1.1–2.8 at the starts; `uptime` 5 days 23 h; from committed, built code):
  - **Headroom** (`run.mjs headroom --quality low --meadow [--cover] --copies none --scales none --rounds 1`: the
    camera orbiting the empty lots 16 m out and 4 m up; three rounds: 207 s, 224 s, 194 s; one before them failed
    after 421 s on the stale far cache):

    | Run | Cover | Room (ballast held) | `near` ms (spread) | Sim ms a frame | Workers ms a frame | In view |
    |---|---|---|---|---|---|---|
    | A1 | none | 20 | 3.74 (0.85) | 7.2 | 4.8 | — |
    | B1 | the bench meadow | 34 | 2.42 (2.0) | 10.2 | 12.1 | 4,650 clumps, 272,032 triangles |
    | A2 | none | 3 | 4.61 (0.38) | 6.8 | 3.7 | — |

    **The GPU cost of the meadow is not resolved**: the room is larger with cover than without, and the two runs
    without differ by more (20 and 3). Resident: 65,617 points, 6.3 MB of the `voxelCover` entry's 32 MiB (share
    1). Against the soft targets (100k clumps, 1.2 M triangles in view): a twentieth and a quarter, with this
    dressing. **The simulation and the workers were busier with cover** (about +3 and +8 ms a frame while
    orbiting): read from it, a chunk drawn for the first time was making the eight columns round it again; fixed
    (3393b57b) and **not read again** (the three rounds were spent).
  - **The cover job**: 15.9–23.5 ms a chunk column in a worker on the made world (the stream test's line over
    five runs, other work on the box; nine species in its table); the bench meadow on the town 12.7 ms p50 in the
    calling thread (11.6–15.0; three cover species and a road's).
  - **Coverage at 150 m/s** (`run.mjs coverage --quality low --speed 150 [--cover]`, Play on staging; **two
    rounds, not the one the item names**: the plan's baseline was read on an export of a world baked to 0.5 m,
    and staging's far cache had just lost its fine levels, so a same-hour round without cover was flown; 117 s and
    116 s):

    | | With cover | Without |
    |---|---|---|
    | Longest frame | **949 ms** | 62 ms |
    | Frames over 100 ms | 2 | 0 |
    | Missed a minute, p95 | 28.4, 37.7 ms | 32.0, 38.1 ms |
    | After the stop: ground solid | 0.02 s | 0.03 s |
    | Full detail (level 0 still) | 8.0 s | 6.0 s |
    | Nothing pending | 13.2 s | 11.6 s |
    | Falls, holes | 0 of 34, 0 of 1,917 | 0 of 34, 0 of 1,964 |

    **Cover hitches the page where it is first drawn** (D844): both long frames are in the flight's first quarter
    second, where the world is still arriving. In flight nothing differs (no level 0, no cover). **Full detail
    came back 2 s later with cover**, one round each, so not resolved; a cover job was taking one worker in four
    while derives waited, and cover now asks for none then (e9d1269e): **not read again**.
  - Medium and high: unverified on target hardware.
- **Gate:** before it, the generators (reference: 5 pages changed; typings and graph API: nothing; 6 s), `npm run
  build` (25 s), `npm run lint` (96 s, uncached) green; the manual's links test red once (the reference's limits
  pages are cut by size and `MAX_INSTANCES` moved to the next page: one guide link repointed), then green (1 s).
  `tools/gate.sh check` once: GREEN in 265 s (build 26 s, lint 10 s, unit 204 s: 983 files passed; boot 5 passed,
  25 s). No second call. The three new unit files take about 20 s together (10, 5 and 5 s); the runtime file grew
  by about 6 s. Picture time 293 s (three takes of L25 and L26, two of the editor screen); the readings 1,279 s
  (four headroom runs, one failed; two coverage rounds).
- **Unverified:** anything in motion (wind, bending under an interactor, cover arriving round a walking camera,
  the thinning at the reach while moving); an exported game's cover; cover at night and under lamps; cover on a
  world of 16-cell chunks; the budget's thinning in a picture; the Scene view close up, round a structure and
  after a prop is dragged; both fixes made from the readings (the first-draw re-makes, the wait for near work) on
  the page.
- **Left out, and why:** cover past its 40 m reach and LODs, impostors and fades (the rings phase); a species'
  own cover distance, shadow casting and bend (G5 names none: owner); cover on a structure grid's own floors;
  narrowing an edit's re-make to the cells it touched; following a static prop a script moves; D844's fixes (the
  path's first draw: found by the last reading); the Dressing card, the Rules rail, the starter plants (47b.10).

### 47b.10

- **What exists.** A person can say what grows on a material and see why a spot is bare, and a fresh project can
  have a meadow without an artist.
  - **The Dressing card** (`ui/material/DressingCard.tsx`; its edits `session/dressing-edits.ts`): in the material
    Inspector's voxel section. The material's dressing picked, made new or cleared (an instance: its own, else
    "the parent's"); the dressing's name; who shares it; each species as a folded line with up, down and remove;
    unfolded: model, class (large says "stored; placed in a later phase"), density, spacing, scale, turn, lean,
    seed, and the ten conditions. Every change is `setDressing` or `setMaterial`.
  - **The Rules rail** (the world mode's fifth; `viewport/voxel-rules-probe.ts`, `session/world-rules.ts`): the
    Read tool reads the surface under the pointer from the Scene view's worker and lists, for the material there,
    each species as growing (with its share and what thins it) or not (the failing condition and the value read
    against what it asks), then the nine field values at that point. A click holds the read. **"Why not" is
    built.**
  - **Starter cover in the Basic Kit**: four plant models, two materials, three dressings (below).
  - **Make a grass / shore / gravel material** in the world mode.
  - **Manual**: `features/dressing.md`, `features/fog.md` (new), `features/world-editor.md` (the Rules rail, each
    tool's command), and the voxel materials' `voxel.dressing`. The reference was regenerated and did not change
    (its dressing entries are 47b.8's).
- **Stored beyond format 1:** nothing. No dressing or material field, no condition, no per-plant list, no voxel
  material in a kit. The Basic Kit's `pack.json` gains assets and commands of kinds it already carried, and
  `setDressing`.
- **The four assets** (game-ready ground cover; made by `packs/basic-kit/tools/cover-plants.py` in headless
  Blender 5.2 through the art pipeline; five runs of about 32 s; each file is the one the script wrote):

  | Asset | Triangles LOD0 / 1 / 2 (budget) | Size (m) | GLB | Material | Collision |
  |---|---|---|---|---|---|
  | `basic-grass` (a clump of 14 blades) | 42 / 15 / 3 (48 / 16 / 4) | 0.5 across, 0.32 tall | 7,804 B | foliage | none |
  | `basic-flower` (three daisies over leaves) | 39 / 14 / 5 (40 / 14 / 5) | 0.4 across, 0.56 tall | 7,076 B | foliage | none |
  | `basic-reed` (six leaves, two seed heads) | 42 / 16 / 5 (44 / 18 / 6) | 0.5 across, 1.25 tall | 7,616 B | foliage | none |
  | `basic-pebbles` (three stones) | 45 / 12 / 7 (48 / 14 / 7) | 0.45 across, 0.075 tall | 9,364 B | standard | none |

  - **Levels**: three each, nodes `<model>_LOD0..2`, switched by the engine's default screen sizes (8 % and 3 % of
    the view's height, the cover path's own switch with hysteresis and a cross-fade). By arithmetic from the
    models' bounds at the engine's 50° reference view, before a tier's bias: grass and flowers to LOD1 at about
    10 m and LOD2 at about 28 m, pebbles 8 m and 20 m, reeds 19 m and 50 m (past the cover's 40 m reach: reeds
    draw LOD0 and LOD1). Not measured in a run; the picture's count agrees in kind: 6,271 clumps drew 77,240
    triangles in L25, about 12 a clump.
  - **Texture**: one 128 × 128 colour atlas for all four, eight columns; **3,995 B** as KTX2 (ETC1S, sRGB, 8 mip
    levels), from a 14,330 B PNG that is not kept. No alpha, no normal map, no ORM map (§8 9).
  - **What an export ships**: the same bytes (a build re-encodes neither a GLB nor a KTX2): the three plants a
    Meadow names and the atlas, 26,491 B in all; pebbles only when a material names Gravel or Shore (the HTTP test
    reads the lengths from the export).
  - **Vertex data**: position, the upward-bent normal, one UV set, and on the three plants COLOR_0 as the foliage
    shader's data (bend, phase, flutter, thinness). No tangents. Pivot on the ground in the clump's middle; no
    hidden faces (single-sided strips drawn two-sided; stones have no underside).
  - **The kit with them**: 10 files, 2,783,311 B (it was 2,747,456 B: + 35,855 B), 20 commands.
- **How a fresh project gets a meadow** (a person's steps): Create → Basic Kit; select the voxel world object,
  **Edit world**; on Sculpt (Add) or Paint, **Make a grass material**; add or paint ground with it. Over MCP: the
  pack route, then one `setMaterial` naming `basic-meadow` (`features/dressing.md`).
- **Tests** (new: `session/dressing-edits.test.ts` 12, `session/world-rules.test.ts` 23,
  `viewport/voxel-rules-tool.test.ts` 6, `tools/voxel-bench/starter-cover.test.ts` 4; one added to
  `tests/integration/voxel-world/voxel-world.test.ts`; changed: `backend/src/packs.test.ts` (+5),
  `tools/voxel-bench/bench-cover.test.ts`):
  - **the card's commands**: every edit's result read by the model's validator and canonical form: a species
    added, removed, reordered (and no such move sending nothing), each placement field set and emptied, a cover
    spacing held to its bound, the ten conditions set in any order and stored in the format's, a condition gone
    with its last field, the noise's range, scale and seed, the sets' ticks, a row a range condition inside the
    format's bounds; a material naming, changing and clearing its dressing, a variant's override and its clearing,
    who shares a dressing.
  - **the Rules rail's answer**, made fields through the real rules: grows at full density; a variant by its
    parent's dressing; **each of the ten conditions alone named as the reason with the value read**; the first of
    two; a share where a condition fades and only the conditions that thin it named; the noise by where the
    cursor is; a prop's box; a large species; no dressing, a missing one, an empty one; the nine field rows; what
    the rail arms; the starter grounds.
  - **the probe on the real tool** (pointer events, a fake pick, the surface read the worker runs over a made
    world): the read under the pointer said once a cell; a click holds it while the pointer wanders and leaves,
    another click moves it, Esc lets go; nothing read over another world, in Navigate or once the rail is left; an
    overtaken answer dropped; nothing ever sent. **The page ↔ worker read**: the kernel's own fields for open
    ground, a verge, a pond's bed, a wall's foot and a half-filled cell; "not loaded" where a cell it needs is
    not, never a guess.
  - **the kit**: each plant three levels inside its budget, its counts and bytes the script's, on the ground, no
    collider, not moved, one mapped material, foliage data on the plants and none on the stones, no image in the
    file; the atlas 128 × 128 sRGB with its mips; the dressings valid, canonical, cover only, no material id;
    **on made ground through the real cover source**: the Meadow's grass off the road and out of the pond, its
    reeds in the pond alone, flowers thicker at the verge and in patches; the Shore's reeds at 0.5 m of water and
    none at 1 m; the Gravel's tufts within a metre of its edge.
  - **over HTTP against a real backend**: the kit added (36 commands, one undo and redo, the dressings with it,
    the models wearing the cover's materials, no voxel material brought); the world mode's grass made with the
    project's next free id; the Meadow grown on that material's cells by the cover source and on no other
    material; **seven card edits as commands** (density, a condition, noise, a species added, reordered, removed,
    made large), each stored, seven undos back to the kit's record, the same record again refused `no_change`; a
    variant inheriting, overriding and clearing; **an export** shipping the Meadow alone, its three plants and
    the atlas at the pack's own byte lengths.
  - **Broken on purpose, each run once** (31; `~/.cache/thirdlight-phase47b/work/47b.10/breaks.log`): **all red
    at once**: a move that moves nothing; a condition never set; a fade kept alone; a cleared material keeping
    its dressing; users without inheriting variants; a cover spacing past its bound; the slope's reason reading
    the height; a large species judged as cover; the prop boxes not passed; a variant not answered by its
    parent; the share always full; every faded condition named; the rail arming no probe; a starter ground
    naming no dressing; a held read following the pointer; an overtaken answer shown; a read asked every move;
    another world's ground read; a click not held; unloaded cells read as "no surface"; the read without its
    distances; an unloaded chunk read as air; a species growing on any material; the bench's undo unchecked, its
    files left, a kit it did not add undone; and in the pack's data: grass under water, reeds in deep water, a
    material id in a kit species, a budget lowered under the model, another file in a plant's place.
  - **Not tested by a unit test**: the card's and the column's React drawing (driven in a real page: below); the
    worker's `surface` message handler itself (four lines round the function the test calls; it answered in the
    page run).
- **Pictures** (three takes of E9, L25, L26 in one run each: 204 s, 121 s, 151 s; low tier, WebGPU; all settled;
  staging stopped after each, the kit taken out by the undo; `~/.cache/thirdlight-phase47b/work/47b.10/`):
  - Take 1 (`pictures-1/`): the meadow a carpet of pale straw-yellow blades lighter than the ground, no flower to
    be seen (the flowers were shorter than the grass), and E9 taken from inside the yard's house. Fixed: greens
    darkened, grass 0.40 → 0.34 m, flowers 0.36 → 0.56 m, the lane framed.
  - Take 2 (`pictures-2/`): flowers show; the grass's tips still pale against dark roots; E9 from about 25 m up
    (plants as specks); a range's fields stacked on the card. Fixed: the greens brought to the ground's own, the
    row laid out, the view moved in.
  - **L25** `pictures-3/L25-cover-meadow.png` (take 3; 6,271 clumps and 77,240 triangles drawn; 79,046 points
    resident in 141 sets of 6 species). Sees: from 2.4 m up a field of short grass over the empty lots, close to
    the ground's green; a grey gravel road across it with no meadow grass on it; small white flowers along both
    its verges and scattered beyond; eight houses, hills and mountains behind. Every clump stands on the ground,
    none on or in a house; the field thins with distance and is gone by about 40 m with no line and no
    chunk-shaped patch. **Wrong**: the grass is greyer than the ground it stands on and peppered with dark
    blue-green blades (blades seen from behind: D847), so it reads as a speckled layer, not as lit grass; near
    the camera the same clump shape repeats visibly, wide flat blades; the flowers are specks at this distance and
    the pebbles on the road cannot be made out; no shadow under anything; soft at this render scale. Triangles
    are a quarter of the stand-ins' (289,278 → 77,240) for more clumps. Sure: high for what is there.
  - **L26** `pictures-3/L26-cover-reeds.png` (take 3; 4,813 clumps, 54,980 triangles). Sees: the pond in its
    stone rim from 8.5 m; olive reeds with dark brown seed heads standing in the water all round inside the rim,
    readable against the blue; the middle mostly open; grass on the lot up to the rim; two white flower heads in
    the foreground. No reed on dry ground. **Wrong**: the flower heads close up are flat white hexagons (paper
    discs); a few blades at the rim's foot still cut into its stone; the grass's light and dark blades as in L25;
    a few reeds stand nearer the middle than a shore would have them (the bench's shelf is wide). Sure: high.
  - **E9** `pictures-3/E09-dressing-card.png` (take 3). Sees: the editor on the yard, the Scene view a close-up
    of grass blades and white flower heads from a few metres up, and in the Inspector the card: "Dressing: what
    grows on it", the picker on Meadow, new, the name, "Shared: a change here changes every material that names
    this dressing (Grass)…", the first species unfolded (Grass clump (Basic Kit) · cover · 7 /m² · 3 conditions;
    model, class, density 7, spacing, scale 0.75 and 1.3 in a row, turn, lean 0.3, seed) and the top of "Where it
    grows". The Project window shows the grass material chosen. **Wrong**: **the view is too close**: no house,
    no lane and no door for scale (take 2 was too far; the script now sits between, at 3 notches in, **not
    taken**); in this view the blades are dark blue-green on a bright flat green ground (D847 at its plainest);
    the flower heads are paper hexagons; the conditions are below the fold of the Inspector; the Inspector's own
    title bar is scrolled out. Sure: high for what is there; the card's look in use, low.
  - **The Rules rail** (`pictures-2.raw/screen-dressing-card-rules.png`, take 2's; take 3's is the same screen
    from closer). Sees: the world mode's Rules column: Read armed, "Here … held", a "Starter ground" section
    offering a shore material, "What grows here: Grass · Meadow" with four lines (✓ grass, ✓ flowers at 8 % "a
    condition is fading here", ✓ flowers at full density, ✗ reeds "does not grow: the water depth here is 0 m; it
    grows where it is 0.05–0.7 m"), and the field list; in the view the meadow with daisies along the lane's
    bank, the probe's ring on the bank. Take 3's read: verge flowers "does not grow: the distance to another
    material here is 3 m; it grows where it is at most 1.5 m, fading over 0.5 m".
  - **Driven with the real pointer** (Playwright's mouse and keys on the page; take 2, whole): the grass
    material found in the Project window and clicked; the card's first species unfolded; **density typed 7 → 2
    and Enter: the Scene view's cover went from 28,712 to 9,837 points**; the dressing cleared in the card's
    picker: 490 points left (the road's Gravel); picked again: 9,837; then Edit world, the Rules tab, Read, the
    pointer moved until a read with a growing and a not growing species, a click to hold it. In take 3 the
    script's last step (typing the density back) could not find its field, because the card folds its entries
    when the dressing is cleared and picked again; the script now unfolds first (**not run again**).
- **Found on the way:** an undo of the kit's add left its source files in staging's game folder (three runs: 30
  files, 8 MB, removed by hand; D848); the bench removes what its own add wrote. The voxel materials' manual line
  gave a gas's default density as 0.1 (it is 0.5 since 47b.7): corrected.
- **Gate:** before it, the generators (reference, behaviour API typings, graph API: nothing changed; 17 s), `npm
  run build` (25 s), `npm run lint` (96 s, uncached) and the manual's links test (1 s) green. `tools/gate.sh check`
  once: **RED in 262 s** (build 26 s, lint 10 s, unit 199 s: 986 files passed, 1 failed; boot 5 passed, 27 s):
  `tests/editor-op-reach.test.ts` still listed `setDressing` and `deleteDressing` as ops the editor never sends,
  and the card sends the first. The cause fixed: the list's two entries taken off, and the Project window's
  delete given `deleteDressing` (§8 16), so the editor sends both. `tools/gate.sh check --failed` once: **GREEN
  in 39 s** (build 28 s, lint 6 s, the one file 5 s). The four new unit files take about 9 s together; the HTTP
  file grew by about 3 s, `packs.test.ts` by about 1 s. Picture time 476 s (three takes); Blender about 160 s.
- **Unverified:** picture E9 at its final framing; the card with a real pointer beyond what is listed (reorder,
  remove, add species, the model picker, the condition rows, ticks, a variant's card, "new"); the Rules rail's Esc
  and its ring's look while moving; Make a grass / shore / gravel material in a browser (unit and HTTP tests only);
  the starter plants in motion (wind, bending under an interactor), at night, in an export's page, and on a
  ground texture other than the town's and the yard's flat colour; the LOD switch distances (arithmetic); a
  project that already holds the old Basic Kit; D847's cause (reasoned).
- **Left out, and why:** a fix of the foliage shading (D847: a lit program, measured; not this item's); a pack
  upgrade for projects that hold the kit (§8 13); a dressing editor of its own, a view of where a condition
  holds before a species grows there (an overlay), copying a species between dressings; a dressing check in
  Problems (D843 stays open); any large-class placement, cover past 40 m, new conditions, wind tuning.

### 47b.11 — the close

- **The review** (one fresh agent, read only): its page is in §8. Acted on before the phase run: two texts
  corrected, one history comment, D849–D851 opened, D840 extended.
- **The phase run**, once, at c86b5332 (`~/.cache/thirdlight-logs/gate-phase-20261127-035742/`): 2,287 s (38.1
  min; 47T's 1,713 s); build 27 s, lint 97 s, every unit file 449 s (1,012 passed, 13 skipped), the boot check 27 s
  (5 passed), the performance report 183 s, the pictures 1,503 s. **RED on the pictures**: 33 of 35 settled (the
  next section). Memory peak 10.9 GB of the 12 GB cap, load mean 3.9.
- **Test time against the budget of about 75 min: 87.5 min.** Checks 2,962 s: 47b.0 245 + 37, 47b.1 248, 47b.2
  250 + 58, 47b.3 248 + 33, 47b.4 253, 47b.5 249, 47b.6 253, 47b.7 258, 47b.8 264, 47b.9 265, 47b.10 262 + 39 (the
  second number a `--failed` run after a real fix: a stale generated file or list each time, and once an
  order-dependent file moved to `ISOLATED_FILES`). The phase run 2,287 s. Beside the gate: the items' picture
  runs about 35 min, their benches about 31 min.
- **Performance** (the run's report against 47T's, the town, low, 720p, the 30 Hz cap, host load 8 in both): 30
  fps and 0 frames missed in both; GPU frame 17.52 / 16.12 ms; near 4.89 / 5.38; far 3.43 / 3.86; shadows 0.99 /
  0.37; lighting 5.69 / 5.0; post not readable; page heap 640 / 636 MiB; GPU memory 1,003 / 989 MiB; world fill
  6.7 / 6.2 s. Recorded, not judged: within the host's noise but for shadows (+0.6 ms, not traced).
- **The pictures**: 35 (28 and E7–E9, L23–L26), pack `~/.cache/thirdlight-phase47b/work/final-pack/` (the phase
  run's, E7–E9 retaken), each opened by a fresh agent, its read in the pack's `read.md` and on the review page: 30
  with something wrong or doubtful; D827, D831 and D825 seen gone; the fog and the cover as the acceptance text
  says; D853 opened from it. Seen and not traced: L4 lacks the small orange glows of 47T's; the bench's fog
  hollow stands in L2 and L10–L13 (bench data in view of other cameras: the references of those five changed);
  E6 shows Problems 3 against 2.
- **Defects**: D825, D827, D831, D832 and D762 moved to `audit-closed.md`; D835–D853 opened in the phase (19);
  226 open (M 35, L 191); next free D854.
- **Acceptance**: `docs/briefs/acceptance-47b.md`, on the review page under `47b` (five questions, each with its
  default). The interim text moved to `archive/briefs/`.

### 47b.11 — the phase run's two unsettled pictures

The phase run at c86b5332 (`~/.cache/thirdlight-logs/gate-phase-20261127-035742/`) took 33 of 35 pictures settled.
Work folder `~/.cache/thirdlight-phase47b/work/close-fix/`.

- **E8 (the Fill rail): the script's, fixed (9f64e54f).** Cause: F keeps the view's distance, and every yard
  screen framed its object and then backed off some wheel notches on the one page they shared, so a screen's view
  depended on the screens before it. E8 had only ever been taken alone (from the editor's opening view); after
  E2–E4 and E7 it stood so far off that the yard was 350 px wide (the pack's `E08-world-fill-UNSETTLED.png`), the
  scan for a point over a hollow's floor found none, nothing was clicked (`fogBrushStroke`, `wholeHollow`,
  `breachedHollow`: no point; revision 17 throughout), and the wait for the level ring ran out. The product did
  what it was asked: no pick missed, no fill was sent. E9 in that run settled but showed the yard from far off
  with no meadow in view (the same cause); E7 showed the hill from far off. Fix: E7, E8 and E9 each open the
  editor anew in a browser context of their own, so each frames from the opening view whatever was taken before;
  E1–E4 keep their shared page (each framed from the one before, as since 47T). No unit test exists for the
  screens' script.
- **Run 2** (`pictures --only E1,E2,E3,E4,E7,E8,E9`, the fresh backend's screens in their order; 46 s; 7 of 7
  settled): `close-fix/pictures-2/`. Opened: **E8** the Fill rail with the Fog tool, the far hollow holding fog
  under its rim, a block-edged patch of fog in the near hollow (the brush stroke, 303 cells), a red ring with a
  post on the ground at the lower left, in front of the near hollow where the trench runs, the status line naming
  the leak at (21.0, −1.3, 8.8) m, `error flood_leaks`; the house's wall fills the left quarter and the hill shows
  behind it. Wrong: the brush stroke's fog is blocky at its edge (as in 47b.7's take); the picture does not say
  whether the red ring is the level ring or the leak's mark, and no second red mark is in view.
  Facts as the takes alone: fog stroke ok, the fill ok at −0.5 m, the breached fill refused with one leak, 290 gas
  triangles. **E7** the hill close by with its dry-grass top, the grey mound of the dragged stroke under the brush
  cursor, the Brush panel, the Sculpt column. Wrong: the mound's sides are faceted where it meets the hill.
  **E9** the meadow close by (grass clumps, white flowers, the gravel lane at the left edge), the Dressing card
  with the first species' fields. Wrong: the Problems tab shows a count of 1, not looked into; the Inspector's
  left edge is cut by the view's border. Sure: high for what is in each; nothing in motion was seen.
- **L3 (the cave): the product's, not fixed: D852.** The bench's fog is not it: its hollow and flood are written
  before Play, the volume's marks in the cave are 5,023 against 47T's 5,188, and **run 1** (`pictures --only
  L1,L2,L3`, no fog cameras, so no fog written; 236 s; L3 again not settled, 722 of 4,336 bricks stale after
  120 s) showed the same. No brick is restarted; the update is slow. The light volume's pacing takes a wait that
  nearly every reading holds in the cave (a dispatch reads 3–3.6 ms whether it holds 2 bricks or 5; two 2-brick
  dispatches of the same 16 read 0.07 ms) for the bricks' cost and falls to 4 bricks a dispatch; the same bricks
  went 34–40 a dispatch in the one run of 47T that settled in 23.8 s. 47T's other two runs were in the same
  state at 6 a dispatch and settled at 91 and 95 s of the bench's 120 s; this phase's two are at 3.9–4.1. The
  day run's cameras with full windows (street, room, night lamps, the cart, the houses, the four refs) cost what
  they did in 47T (0.05–0.13 ms a brick, each within 0.02). The walk, the volume
  and its pacing are unchanged since 47T (no diff); which change of 47b lengthened the wait is not traced, and
  near the live share a little is enough (`close-fix/pacing-model.ts` on the real `VolumePacing`: a wait of 2.6
  ms on every reading gives 10 bricks a frame, 3.0 ms gives 2). By reading only: a gas-only edit reaches the page
  as a `gas` entry and the volume is marked by walk blocks alone, which a gas does not change (gas is open space
  to the occupancy since derived 34); not put under a test here.
- **Why L3 is left red.** A pacing that tells a per-dispatch wait from the bricks' cost changes a measured
  default path (D690's history; headroom A B A B on the GPU): not a close's fix. The bench's 120 s was not
  widened: it would hide the difference. The lead decides between a pacing item and taking L3 off the list.
  L7 (`lamps-room`, 108–109 s in both phase runs, 5.7 bricks a dispatch) stands 11 s from the same red.
- **Runs:** two picture runs (236 s, 46 s), both in a capped scope; staging stopped after each by the command
  (run 1 wrote nothing to staging's world: the cave was there, the props are placed and taken off by the bench).

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
