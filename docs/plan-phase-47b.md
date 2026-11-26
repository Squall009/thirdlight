# Plan — phase 47b: the world edit mode, the fill, fog as voxels, dressing and vegetation rules

**Status: proposed 2026-11-26, waiting for the owner's approval. Nothing is built before it.** Branch `phase-45`.
Start commit: the commit of this plan's approval. Next free D-number: D835.

The roadmap's line (owner, 2026-11-12): "**47b World edit mode**: one mode on the brush kit in the Scene view;
fields derived from voxels; the height-based fill for water and fog; the fog role and fog painting with a plain
look; material dressing, scatter rules and vegetation rules as one item."

The owner's decisions it builds (register, 2026-11-12): "One unified underlying voxel system that everything is
based on from terrain, to building grids, water system, material and physics, fog, vegetation rules derived from
the voxel and material id." Water = liquid-role voxels; fog = a new non-solid role, fill bits as density, material
id as fog type; "both painted with the voxel brushes and one shared height-based fill". Vegetation: "rules from
the material are the default; a hand-placed tree is an ordinary prop that rule plants keep clear of; density by
material variations"; two reserved bits stay unspent.

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
- **Roles**: 10 of 16 assigned; no gas or fog role. Liquid is special-cased in 14 separate places, not by one
  predicate (`voxel-engine.md` §2 "known limits").
- **Derived fields**: none as a service. Sky columns and sun heights exist; height and slope for scatter exist
  only for heightfield terrain and block layers.
- **Materials**: the voxel block of a material has `use` (construction, terrain, liquid), kit, tiling and
  surfaces. No dressing field.
- **Vegetation**: nothing grows on a voxel world. The rule scatter core (`scatter.ts`), point-set ground cover
  and stored copies as rows of the culled-instance table, wind and the interaction field all exist and are
  generic; their only sources are the retiring terrain and block layers.
- **Fog today**: distance and height fog in the fog node, 16 unlit fog boxes a scene. The far field takes the
  fog node at its hit's depth.
- **Tests** (47T): `tools/gate.sh check` about 4 min a commit an agent calls green; `tools/gate.sh phase` about
  29 min once at the close, with the 28 pictures. Behaviour is proven by unit tests; looks by pictures.
- **Files to split before they grow**: `workspace/src/voxel-worlds.ts` (1,909 lines), `project-model/src/index.ts`
  (1,879), `runtime/src/runtime.ts` (1,857).

## 2. What exists at the end

A person opens a scene with a voxel world, presses the world mode, and can: raise, dig, smooth and flatten
ground with brushes; paint materials and wetness; fill a hollow with fog to a height and paint or erase fog by
hand; make a lake by clicking in a basin (a water body, as 47a built them); and see grass, flowers, reeds, rocks
and trees appear on the ground by the rules of the materials they painted, changing as they sculpt and paint.
Every one of these is the same `editVoxels` command an agent sends through MCP, on the one undo line.

A game reads the same derived fields a rule reads (`ctx.voxels`), and Play and an export show the same fog and
the same plants in the same places as the editor.

## 3. Scope

**In:** the items of §5.

**Out, with where it goes:**
- Lit fog, the density march, far fog, the interactive ground fog, froxels: **51**. 47b's fog is a plain look
  near the eye only.
- The water surface shader, far water, flow, queries, buoyancy: **49**.
- Vegetation LODs beyond the models' own, impostors, forest canopy in the far bricks, compute placement of
  cover: **50**. 47b draws plants to the load ring with what exists.
- The GPU field windows of the research (camera-centred field textures): their first consumer is 49's and 51's
  shaders; built there.
- Distance to a tagged spline as a rule condition: dropped. A road is a voxel material, so "nothing beside a
  road" is the distance-to-material-edge condition.
- Stamps voxelized from models at import, the stairs tool in structure mode (D775), pillar and terrace options:
  not in 47b (question 5).
- The world map, the full MCP guide and the manual's voxel chapter: **47c**. 47b writes the reference entries
  and one manual page a feature.
- Engine code of block layers, heightfield terrain and their scatter sources: **48** removes it; 47b adds a
  voxel source beside them and touches nothing of theirs.
- Painted 2D layers, fog splines: dropped by the owner (register).
- Main and the game repos.

## 4. Format entries (the hard stop: approved with this plan or not built)

Each is add-only. The exact spec text is written in 47b.2 from these lines; anything a builder finds it needs
beyond them is a stop for the owner.

| # | Entry | What changes |
|---|---|---|
| G1 | **Role `gas`**, value 10 (`VOXEL_ROLE_COUNT` 11) | Non-solid. Shape = density in 16 levels (0 none, 15 the material's full density). Wetness and reserved bits 0. A cell is solid, liquid or gas, never two. Worlds written before it stay valid. |
| G2 | **Mip rule for gas** | Gas adds nothing to a parent that holds a solid; with no solid and no liquid, a parent is gas when its share rounds to one, its shape the mean. So fog over ground is gone from 2 m up, as shore water is today: no far fog until 51's far channel. |
| G3 | **Voxel material use `gas`** | A fourth use beside construction, terrain and liquid, with two fields for the plain look: colour and full density (per metre). 51 adds its lighting and simulation fields. |
| G4 | **Edit command v3** | A stroke kind `flood`: a seed cell, a level, a value (material and a non-solid role), a reach in cells, an optional fade (metres under the level over which gas density falls to 0). Refused, naming where it leaked, when it meets the reach or the world's edge. Air as the value drains. Two brush modes: `smooth` (relaxes the surface, or gas density, under the brush) and `flatten` (toward a plane's height). A `paint` that keeps each cell's role (D762). v2 commands read as before. |
| G5 | **`voxel.dressing` on the material record, and the dressing asset (format 1)** | A material names one dressing asset. The asset is its own file: an ordered list of species entries, each a model, a class (cover or large), density, spacing, scale and yaw ranges, alignment, a seed and conditions. Project schema bump with an upgrade step that adds nothing. |
| G6 | **Derived data, never stored** (add-only entries of the derived list) | The surface fields a column; a gas part a derive section (as the liquid part); cover points a chunk; large-plant cells. A change only between air and gas, or of a gas cell's density or material, feeds the gas part alone (F7's rule extended). |

The two reserved bits held for vegetation density stay unspent. Nothing else in an approved spec changes.

## 5. Items (the contract; status goes in §6)

Order inside an item: schema and commands, then runtime, adapter and host, then editor, exporter, tests, docs.
Each names its foundation (`voxel-engine.md` §6) and how it is proven.

| Item | Builds | Proven by |
|---|---|---|
| 47b.0 | **Opening.** The three.js release check and its assessment (no update). The three files of §1 split where 47b will add. One predicate for "a cell that is not a body" in `@thirdlight/voxel`, replacing the 14 scattered liquid checks, behaviour unchanged. The picture set's baseline is 47T's. | unit: the predicate against every old check on the test worlds; the check green |
| 47b.1 | **The defects 47T's pictures placed here.** D827 (the broken band of slabs on near ground from 250 m), D825 (the Profiler opened during a running Play never answers), D831 (the wire grid beside a structure in the Scene view), D832 (the bench's dig after its last shot fails). Each found, then fixed or restated with its cause. D829 (gaps under stepped gables) looked at for a day at most. | unit tests at the cause; pictures L16, E1, E6 before and after, read by an agent |
| 47b.2 | **Formats and the gas role in the data** (G1–G3, G6's list): spec text, the role, the mip rule, the material use, every consumer that must read gas as open (through 47b.0's predicate): mesher, kit cases, collision, occupancy and light, navigation, sky, far faces and ground. | unit: conformance tests; a world with gas derives the same meshes, collision, walk graph and light stop as the same world without it |
| 47b.3 | **Stroke kinds** (G4), foundation 2 and 5: the level fill takes its role and fade as parameters (one function for water bodies and the stroke); `flood`, `smooth`, `flatten`, role-keeping paint; apply, undo and redo, the leak report; `tl_command` reference text. | unit: each kind on made cases (a basin, a breached basin, a slope smoothed, a mound flattened), deterministic, undo exact; over HTTP in Node |
| 47b.4 | **Fields derived from voxels**, foundation 1: `surfaceFields` once in `@thirdlight/voxel`, in a block form (a column: height, slope, material, role, sky, wetness, water top and depth, gas bottom, top and density, distance to another material's edge, distance to construction) and a per-point form (cave floors and storeys answer right). Run on level 0 in the derive workers and on the 2 m far nodes (the far-ground decode widened), never stored. `ctx.voxels` gains the per-point read. | unit: every field on made cases; the 2 m result against the 0.5 m result of the same ground within a stated tolerance; page and worker alike |
| 47b.5 | **The world edit mode**, foundation 8: a scene-scope mode on a `voxelWorld` in the edit-mode shell; one voxel brush tool on the Scene view (cursor on the world's lattice or a structure's, the worker's pick, dabs thinned to a spacing, one command a stroke, the view re-derives through today's change feed); rails **Sculpt** (add, dig, smooth, flatten) and **Paint** (material palette with variants, wetness, the brush kit's noise mask). Structure mode's hand edits use the same tool. | unit: the tool with a camera, a stand-in canvas and a fake pick (as `structure-tool.test.ts`): a drag is one command of thinned dabs; picture E7 (the mode, a sculpted hill) |
| 47b.6 | **Fill, water and fog tools in the mode**: a **Fill** rail: fog to a level (click a point, drag the level, a fade; leak markers as water bodies have; drain), water by creating a water body at the click (47a's, so it follows later ground edits); fog paint, erase and smooth density on the Paint rail when a gas material is picked; a rail entry that starts a road, path or river spline. | unit: the tools as 47b.5; picture E8 (a hollow filled with fog, a leak marked) |
| 47b.7 | **Fog's plain look** (G6's gas part): each derive section's gas faces against air as one more mesh of the chunk's draw, the material's colour, see-through by density, unlit by lamps, no shadow cast, inside the detail ring only; a density overlay in the editor. In Play and exports as in the editor. A world without gas compiles nothing. | unit: the gas part's faces and the narrowed feed; pictures L23 (a fog bank in a hollow by day), L24 (the same from inside); cost recorded |
| 47b.8 | **Dressing and rules** (G5): the dressing asset and its commands, `voxel.dressing`, variants through material instances; the rule conditions (material, role, slope, height, sky, wetness, water depth, distance to a material's edge, distance to construction, noise with its own scale and seed) as one arithmetic written once; a voxel source for the scatter core (`ScatterSurface` over the per-point fields); rule plants keep clear of hand-placed props. | unit: the evaluator on the research's examples (grass, reeds in shallows, moss in caves, flowers at a verge, a fringe where a wall meets ground, nothing under a foundation, clear of a prop); same answer on page and worker |
| 47b.9 | **Ground cover on voxel chunks**, foundation 6: cover points a chunk from the derive workers (never stored), as rows of the culled-instance table through the existing point-set path; wind and the interaction field as they are; a chunk's cover made again with its mesh after an edit or a dressing change; a budget a tier. | unit: points for a made chunk, stable under an edit elsewhere, gone under a road material; pictures L25 (a meadow), L26 (reeds at a shore); headroom recorded with cover on |
| 47b.10 | **Large plants** (trees, bushes, rocks): placed a 64 m cell on a worker from the 2 m fields, so a plant never moves when detail arrives; height refined against real voxels in the detail ring; drawn as stored-copy rows with the models' own LODs to the load ring; trunk colliders from the model's `_COL` inside the collision ring; generated alike in the editor, Play and an export. A count read for agents (`tl_inspect`). | unit: placement stable across levels and across an unrelated edit; a felled ground loses its tree; colliders where trunks stand; picture L27 (a wood's edge), L16 again with trees; headroom recorded |
| 47b.11 | **Authoring the rules**: a Dressing card on the material (species, class, density, conditions) with the Scene view as the live preview; the world mode's **Rules** rail (what grows here and why not: the conditions at the cursor); a starter dressing in the engine's basic kit (game-ready placeholder plants, reported with triangle counts, LODs, texture and file sizes); manual pages for the mode, fog and dressing; the reference entries. | unit: the card's commands; the "why not" answer; picture E9 (the card beside a meadow) |
| 47b.12 | **Close.** `tools/gate.sh phase` once; the pictures (28 and the new ones), each opened and read; one independent review; fixes; the end reading against 47T's performance report; `voxel-engine.md` brought up to date; the acceptance page with at most five questions. **Stop. 47c is not begun.** | the phase run; the review; the page |

**If the phase runs long, cut in this order** (each a logged decision, never a silent one): 47b.10's trunk
colliders; the density overlay; D829; the Rules rail's "why not"; 47b.10 whole (trees wait for 50, cover stays).

## 6. Progress

| Item | Status |
|---|---|
| 47b.0 | not started |
| 47b.1 | not started |
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
| 47b.12 | not started |

## 7. How this phase is run

- **Tests** (`AGENTS.md` "Tests and the gate"): unit tests at the boundary each item changes; `tools/gate.sh check`
  once an item, at its end (within an item a commit is green on the build and the unit files it touched);
  `tools/gate.sh phase` once, at 47b.12. A red is fixed or the test goes. No pixel or timing bound is written.
  **Budget: 12 checks at about 4 min and one phase run at about 30 min, about 80 min** — over the hour by a
  third, because the phase has twelve build items (question 4).
- **Pictures**: nine join the fixed list (E7–E9, L23–L27 and L16 with trees), 37 in all. An agent opens each and
  writes what it sees; the owner looks; nothing is called verified that nobody looked at.
- **Performance is recorded, never a gate**: the headroom reading on the town with cover and trees on and with a
  fog bank in view, beside 47T's report. Soft targets from the research, to guide the tier budgets: cover at most
  about 1.2 M triangles and 100k clumps in view on the low tier, mesh trees at most about 400, plants and fog
  together within the frame at the 30 Hz cap on the Iris Xe (unverified on this host: it is not the target GPU).
- **Agents**: one at a time, in the foreground, with a written brief (the item's row quoted, out of scope, how it
  is checked, what to report); no timers; a `progress.txt` in `~/.cache/thirdlight-phase47b/work/<item>/`; each
  green part committed and pushed at once.
- **An interim page after 47b.7** (the mode, the fill and fog are usable then): pictures and a short note on the
  review page, no stop. The owner can open the editor and try the mode from there on.
- **Art**: the starter plants are game-ready assets made with the art pipeline's rules (triangle budget, baked
  normals, LODs, collision, compressed textures), reported with their counts and sizes.
- **Estimate**: 25–35 hours of agent time. The uncertain parts: 47b.2 (how many consumers a new non-solid role
  touches), 47b.9 and 47b.10 (the first plants on voxel ground), and D827's cause.

## 8. Decision log

- **2026-11-26 — where this plan departs from the research notes** (lead; owner to confirm with the plan):
  no GPU field windows yet (no consumer in 47b); no spline-tag distance (the material-edge distance serves);
  cover from worker point sets through the existing culled-table path, compute placement left to 50; the fog
  role's first look is a see-through mesh, the march left to 51; the gas material carries two fields only; the
  liquid fill in the editor makes a water body, never a one-off stroke, because the owner wants shorelines to
  follow ground edits (register, 2026-11-12).
- **2026-11-26 — 47T's defects placed** (owner's default of acceptance question 4): D827, D825 first, with D831
  and D832, in 47b.1; D829 looked at there. Left open with their reasons: D826 (the bench already handles it),
  D828 and D830 (far-field looks: with D808 and D692, the owner accepted these kinds for now; the performance
  and looks pass after 49), D833 (fixed waits: replaced where an item touches the file), D834 (the far field's
  transient budget: the performance pass).

## 9. Results

(one section an item)

## 10. Questions for the owner (each with the default that stands if unanswered)

1. **One phase or two?** Twelve build items is the largest phase of the voxel programme. Default: one phase,
   with the interim page after 47b.7 so you can use the mode while the plants are built; no stop between.
2. **Fog's first look**: a flat-coloured, see-through volume near the eye, gone past the detail ring (about
   45–64 m), with no light or drift until 51. Default: accept; it is there to make fog paintable and visible.
3. **A fog fill does not follow later ground edits** (a lake does, as a water body). Dig a channel out of a
   fogged hollow and the fog stays where it was until you fill again. Default: accept; a regenerating fog body
   can come with 51 if you miss it.
4. **Test time is about 80 minutes for this phase**, against the hour, at one check an item. Default: accept
   for a phase this size; the alternative is a check every second item, which finds a break one item later.
5. **Not in 47b**: stamps voxelized from models, the stairs tool in structure mode, pillar and terrace options;
   and trees are drawn only to the load ring (about 192 m), so a forest ends there until 50's impostors and
   canopy. Default: stamps and stairs go to 47c's plan; the forest edge is accepted until 50.
