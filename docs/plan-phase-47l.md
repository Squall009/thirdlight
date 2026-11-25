# Plan — phase 47L: the lighting pass (after 47a, before 47b)

Owner, 2026-11-24, after reading `acc47a`: "I looked at the review page and see some very nasty light leaking
through walls, doors, extremely patchy gi. I agree it needs it's own pass to try and clean some of this up first
before we continue. There is either corruption in some of the town images or something broke during this phase.
Entire parts of homes did not render further out in the middle and there is garbled white specs that look like
corruption where the house meets the ground and the roof gables in some areas. You can see this very clearly at
water/02-lake-plain-water.png", then: "Write the lighting pass and get it started."

Start commit: **41bbcf38** (47a's close). Branch `phase-45`. Next free D-number: D802 (block to D899).

## 1. Scope

**In:** what the voxel light volume and the near/far hand-over draw wrong today, on what exists (the town, turned
structure grids, doors and windows, caves, the 128-lamp scene): the mid-distance artefacts the owner saw; light
through walls, corners and shut doors; patchy indirect light; light through partly covered cells (D741, 47a's
unbuilt 47a.12); the 128-lamp scene's lost headroom (D740).

**Out:** a new lighting model or a second light path (the voxel light volume stays, owner 2026-11-16); rooms under
cut-away and a minimum brightness indoors (D737: decided, not a defect); water's look and far water (49);
vegetation (47b brings trees: this pass makes partial cells ready for them, on fences, shutters and damaged
construction); block layers, heightfield terrain, generated architecture (retire in 48); WebGL 2 beyond its smoke
test; medium and high tiers beyond "not worse". Nothing stored: **no format entry is expected**; if a fix needs a
stored thing, it stops for the owner as always.

## 2. The owner's requirements (quoted in the header; never silently dropped)

R-L1 no light through walls or shut doors; R-L2 indirect light that is not patchy; R-L3 no specks or garbage
where a house meets the ground or at gables; R-L4 no parts of houses missing at mid distance; R-L5 it must be
known whether 47a broke something. Standing: iGPU low tier is the floor (720p30 accepted in voxel phases, record
and never block on thresholds); measure at the cap only; WebGPU first; nothing in motion counts as seen until
someone watched it.

## 3. What exists (survey of 2026-11-24)

- The light volume, its rays and stamps: `packages/voxel/src` (light walk, `prop-channel.ts`, structure stamps of
  47a.1b), `packages/runtime/src/voxel-portals.ts` (portal cells), the surface programs' volume read in
  `packages/three-adapter` (`?voxelLight=off`, `?surfaceRead=…` switches exist).
- The bench: `tools/voxel-bench/run.mjs light-shots` with the fixed cameras of `lighting-cameras.ts` (`--gpu`,
  `--only`, `--query`), `headroom` (town off / default / `--lamps 128`), `coverage`.
- Evidence so far: `water/01-lake-before.png` and `02-lake-plain-water.png` (47230d51 and 85c412e3: the same specks
  and the same missing house front in both, so 47a.9 did not cause them; no earlier picture has this open 60–100 m
  view); the 47a end reading (plan-47a §8a "47a.13").
- Open rows this pass owns: D692 (blotches of 32 rays a face), D727 (thin props stop no light), D740, D741, D744
  (specks at eaves, gone with the volume off), D746 (bright corner lines at 45°), D747, D750 and D784 (the far
  field never settles with grids or after edits), D773 (coarse levels do not see a shut door), D791 (a portal's
  reach of 4 m), the strip of sun inside a shut door and the 12–18 % loss at turned openings (47a.7, 47a.1b
  results), D711 (watch).

## 3a. three.js check

2026-11-24: npm's latest is 0.187.0 = the pin. Nothing to assess. No update.

## 4. Budgets and how an item is judged

- Low tier, WebGPU, 1280 × 720, the 30 Hz cap, each run alone, committed built code, A B A B in the same hour
  (`docs/briefs/handoff-46e-b.md`, "How lighting items are measured"). The rows: GPU lighting 6.67 ms, page
  lighting 2.0 ms, low's memory rows, the light volume's MB. A fix that costs is reported with its number; a
  tuned constant becomes a tier setting or a table entry.
- **Every item ends with before-and-after pictures from the same fixed cameras, opened and looked at**, with what
  is still wrong written down. A picture taken while the world had not settled is not evidence: the settle state
  is recorded with each shot.
- After every item that touches a lit program: the town orbit and `headroom --lamps 128` against the reading
  before it.
- Tests at the boundary: a leak fix has a test that fails without it (a light cell behind a wall, a shut door, a
  turned corner), in Node where the walk can be driven, in Play where the picture is the proof.

## 5. Where things live (reuse first)

The light walk and its WGSL twin stay one rule in two places already paired by tests: a change lands in both in
one commit. Stamps through the existing structure stamp; portal cells through `voxel-portals.ts`; cameras added to
`lighting-cameras.ts`, never a second camera list; bench worlds through the commands, restored after.

## 6. Items (the contract; status goes in §7)

| Item | Builds | Needs |
|---|---|---|
| 47L.0 | **Date the artefacts; the reference cameras.** New fixed cameras with an open view of the town's houses at 30, 60, 100 and 150 m (gables, ground contact, a brick front), on a clean world (no bench dig). Shots at 760c2aa0 (46e-b's reading), b5093d11 (47a's start) and the head, each with the volume on and `?voxelLight=off`, settle state recorded. Says for the specks and for the missing house parts: present at each commit or not, and with the light off or not; if 47a brought either in, a bisect over 47a's commits names the commit. Also whether the missing house front in `water/02` is the bench's dig. The brief's "47L" section. No fix. | — |
| 47L.1 | **Specks at gables and ground contact** (R-L3; D744 and whatever 47L.0 finds): the cause in the volume's read at the surface (which cell a fragment reads at an edge, at what level), fixed in the walk and its WGSL twin or in the read; for world-grid and structure-grid houses. | 47L.0 |
| 47L.2 | **Missing house parts at mid distance** (R-L4): the near/far hand-over and settle. What is not drawn and why (a chunk never arriving, a level swap leaving a hole, a far brick over a near chunk); D750 and D784 traced in the same box, since a far field that never settles cannot be told from one that is wrong. Fixed where the cause is local; else rows that say what was ruled out. | 47L.0 |
| 47L.3 | **Light through walls and corners** (R-L1): a leak census on the reference cameras and rooms (world grid, grids at 0°, 30°, 45°): bright corner lines (D746), light cells behind walls, the turned openings' 12–18 % loss; the stamp's rule at a turned wall corrected so a wall a cell thick stops light at any yaw; a Node test a yaw that fails today. | 47L.0 |
| 47L.4 | **Shut doors and windows stop light everywhere** (R-L1): the strip of sun inside a shut door; coarse levels past the detail ring see a shut portal (D773); a portal's cells found over the whole opening, not 4 m (D791, no cap in its place); thin props (D727) where the same change covers them. | 47L.3 |
| 47L.5 | **Patchy indirect light** (R-L2; D692): where the blotches come from on the reference cameras (ray count a face, the sequence across updates, the filter at the read, the accumulation), and the cheapest change that removes them at the low tier's budget; a tier setting if the cure costs. | 47L.1 |
| 47L.6 | **Light through partly covered cells** (D741, was 47a.12): a ray carries what is left after each partly covered cell, on the CPU walk and its WGSL twin; shown on a fence, a shutter and damaged construction; its cost on the town; a tier setting if it does not fit. | 47L.3 |
| 47L.7 | **The 128-lamp scene** (D740 and the room lost in 47a: 15 copies against 68): a bisect of the orbit room over 47a's commits and the coarse levels' read; fixed if local, else the row says what was ruled out. | — |
| 47L.8 | **Close.** The affected-area gates, an independent review, fixes, the end reading against 47a's, the design page, the acceptance page `acc47l`: the reference cameras before and after side by side, at most five questions. **Stop. 47b is not begun.** | all |

Order: 47L.0, then 47L.1 and 47L.2 (what the owner saw), 47L.3, 47L.4, 47L.5, 47L.6, 47L.7, 47L.8. If 47L.0
finds a regression from 47a, fixing it comes first, whichever item it falls in.

## 7. Progress

| Item | Status |
|---|---|
| 47L.0 | Done 2026-11-24 (no fix, no gate): reference cameras `ref-30m`…`ref-150m` (4230f8e7); clean world proven by regeneration; 30 shots settled. Specks and roof-ridge gaps are old: the same at 760c2aa0, b5093d11 and the head; specks gone with the volume off (a light read), gaps not (level 1 geometry, D802). Not 47a, no bisect. water/02's missing front is the lake dig (§8a) |
| 47L.1 | Done 2026-11-24 (07eee3c8): the shipped read's form (one loop, shared index load, faces by weight, one cell past readFullM) drew the specks; no expression found (GPU dumps: every value finite, in range). Every level now read as first built, early-out kept; readFullM, readFaceFloor gone. Specks 0 at all cameras twice, grid houses 781 to 0; cost within spread |
| 47L.2 | Done 2026-11-24 (9d9a88da): not the 1 m level (its meshes and grids equal Node's) but the L0\|L1 seam where a level-0 chunk meets a level-1 node along a ridge: a flap stood out through the roof slab. Fixed in lod-seam.ts (a coarse vertex lands on a fine edge facing its way); test in derived.test.ts; roofs whole at 60–150 m, light off. D802 fixed; D750, D784 traced |
| 47L.3 | Done 2026-11-25 (52b31126): no ray passes a sealed wall or corner at any yaw (the stamp is tight); the leaks were the read: cells across thin solids, and the coarse levels at turned corners (D746). A surface reads only its own side, level 0 whole where it reads light: inside points reading outside light 5,725 → 0 of 95,552; G45's corner lines gone. Left: D809–D811 |
| 47L.4 | Done 2026-11-25 (e7c04aa6, 60c1e5f7): a shut door's cells over the whole opening (D791), stopping light at the walk's mips (D773, grids), and the sun's shadow over a shut opening's cells (D812: shadow-only casters sent with the grid's draws). No strip with a placed leaf even before; a prop with no model let sun in. Not built: world-grid openings, the Scene view, thin props (D727) |
| 47L.5 | Done 2026-11-25 (9dfbb292): turned walls' blocks (D809) were the read reaching one column of a wall's staircase (its notch cells held no light). A cell now holds light with a solid across a face or an edge (CPU twin and WGSL): steps along a turned wall 0.30–0.44 → 0.04 of its mean. Blotches (D692) are stored ray noise, left for the owner; wall-foot line (D810) narrowed |
| 47L.6 | Done 2026-11-25 (9492710d): a light ray keeps 1 − coverage of each cell the stop passes in part (damaged construction, props and stamps under half), CPU walk and WGSL twin, every level; what stops light still stops it whole (census 0, no solid leakier); ground passes as its surface. GPU=CPU walk with partial cells; cost not resolved. Smooth damage past half needs a derived step (D818) |
| 47L.7 | Done 2026-11-25 (measurement, no code): the 128-lamp room is back (second rounds 44, 44, 64 ballast copies with the copies search at the head, 56–76 without); 47a.13's 15 and 14 were the edge search stopping at 16 copies on 2–3 missed frames of 89 (single spikes), as 47a.0’s 3, 47L.3’s 7: D711’s kind in second rounds. No bisect. D740: level 0 alone still reads ~1 ms under the default |
| 47L.8 | not started |

## 8. Format and spec steps

None expected. D741's coverage fraction is already in the data (R93). A stored thing found necessary is an owner
stop.

## 8a. Results

(one section an item)

### 47L.0 — the artefacts dated; the reference cameras

**The cameras** (4230f8e7, `lighting-cameras.ts`, taken with `--only`): `ref-30m`, `ref-60m`, `ref-100m`, `ref-150m`, one
brick house of the town (lot (9, 6): two storeys, x 55–66 m, z −4–4 m, its west gable lit at noon) from the south-west
along one bearing (−145°) at 30, 60, 100 and 150 m, 1.7, 8, 16 and 30 m up (as low as the generated town lets each eye
see over the houses between: a sight-line search over town.ts's houses), looking at its first storey. The test marches
the town's cells from each eye to the house's gable foot, gable top and front foot (it fails with an eye moved into a
house or 18 m lower at 150 m). For the base the same block was applied to the base worktree's bench
(`work/47L.0/scripts/apply-cameras.py`, `ref-cameras-block.ts`: the names appended to `LIGHT_CHECK_NAMES`, the block before
`moved`, `...REF_CAMERAS` in `LIGHT_CHECK_CAMERAS`; nothing else).

**The world.** Staging's far world regenerated with `run.mjs far-world --no-cache` (the head's bench) and compared file by
file: all 3,056 region files byte-equal except `r.-2.0.2.vxr` (the bench's cave, 700 m north-west); `world.json` differs
only in format 2, revision 1 (one edit: the cave) against a fresh format 3, revision 0. No lake, no dig in the town. The
project was backed up before the base runs and restored byte-equal after.

**The shots** (2026-11-24 14:01–15:02 UTC, 1-minute load 0.7–3.1 at the runs’ starts and ends; low, WebGPU, 1280 × 720, each run alone, staging served from
each commit's own build; `work/47L.0/shots/<commit>/<camera>-{on,off}.png` with a `.json` each, raw runs in `raw/`).
760c2aa0 and b5093d11 differ only in docs: their builds are byte-identical (1,279 files, `dist-*.sha`); both were shot
anyway. The head's dist was rebuilt at 4230f8e7 (code equal to 6c1dec96). **Every one of the 30 shots settled** (streaming
and far field still, nothing pending, in 3.6–11.8 s; the volume lit in 6–16 s; `voxelLight=off` runs hold no volume
state). Speck pixels counted (all channels ≥ 235 / green 40 over red and blue and ≥ 150), whole frame, light on; light
off is 0 / 0 in all 15:

| camera | 760c2aa0 on | b5093d11 on | head on | specks: gables, ridges | specks: ground | parts missing (on and off) |
|---|---|---|---|---|---|---|
| street-noon | 15 / 0 | 22 / 0 | 7 / 0 | a few on far gables | one or two by a far fence | none seen (far houses hidden by the near ones) |
| ref-30m | 49 / 6 | 27 / 2 | 7 / 2 | a few on the gable and roof of houses ~45 m out; the 30 m house clean | none | none |
| ref-60m | 70 / 0 | 144 / 0 | 107 / 0 | yes: inside far gables, on roofs, ~70–90 m | few | a ridge gap on a house ~75 m out |
| ref-100m | 181 / 82 | 141 / 101 | 243 / 138 | yes: along two ridges, white and green | yes, beside houses | two ridge gaps (~110–130 m) |
| ref-150m | 478 / 160 | 447 / 166 | 380 / 114 | yes | yes: on the grass beside houses | ridge gaps; a black wedge under a roof (grey band with the light off) |

Read by eye on every picture and on the crops (`work/47L.0/crops/`, `<commit>-<camera>-<on|off>-*.png`): the three
commits show the same specks in the same places and the same gaps; counts move run to run (b5093d11 and 760c2aa0 are
one build: 49 against 27 at `ref-30m`).

**Verdicts.** *Specks*: (i) old: present at 760c2aa0 (46e-b's reading), not brought by 47a; gone in every shot with the
volume off: a light read. *Missing house parts*: (i) old: gaps along roof ridges (and a wedge under one roof) at 45–130 m,
present with the volume on and off at all three commits: geometry. No bisect (nothing came in with 47a). **The missing
brick front in `water/02` is the bench's dig**: the lake's cylinder (centre x 0, z −28 m, radius 30 m, y −2 to 30 m;
`work/47a.9/water-edits2.mjs`) reaches house (7, 6)'s south-west corner (brick, three storeys, x 15–28, z −4–8; its
nearest point 28.3 m from the axis), and the crop (`crops/owner02-right.png`) shows its floors and stairs cut open, not a
part left undrawn. The dig also took the houses within 30 m of the street, which opened the 60–100 m view.

**What 47L.1 starts from** (specks): a light read, not geometry (none with `voxelLight=off`). With `&surfaceRead=level0`
(head, `raw/head-on-level0/`, `crops/head-ref-1{00,50}m-level0-*.png`) the same pixels go black and fewer (white 33–126
against 107–380): they are pixels whose level-0 read finds no cell holding light and whose coarse-level read (levels
1–3) answers bright white or grass green. They start about 45 m out (the 30 m house is clean; a house ~45 m behind it has
a few), on gables, along ridges and on the ground within a few metres of walls; many sit on the attic faces seen through
the ridge gaps below. Not determined: which coarse cell a speck reads and why it holds sky or grass light.
**What 47L.2 starts from** (missing parts): level 1 (1 m cells), not the far field and not settling: at the low tier
level 0 ends about 45 m out (128 cells × 0.71) and level 1 at 128 m, the gapped houses lie between, and at the high tier
(level 0 to about 90 m; `raw/head-off-high/`, `crops/head-ref-{60,100}m-off-high-*.png`) the same roofs are whole. Not
determined: which step of the level-1 roof mesh (the mip of a one-cell 45° roof, the roof mesher's ridge case) drops the
cells. D802 opened; D744 and D784 written with this evidence; D803 (the bench camera's auto-exposure) opened.
**Unverified**: nothing in motion was watched; the specks' frame-to-frame flicker was not looked at; whether the
camera's auto-exposure (D803) changes the pictures; the gaps' cause at level 1 is inferred from the tier comparison, not
traced.

### 47L.2 — the missing house parts: the seam between level 0 and level 1 across a roof

**Not the 1 m level.** In Node (scripts in `work/47L.2/scripts/`) every world-grid house of the town at level 1 has one
roof cell a column, steps of one (`scan.ts`), whole top-down and oblique coverage (`rays.ts`) and every roof triangle
showing roof tiles (`shown.ts`). In the browser (a diagnostic hook, kept only as `work/47L.2/diag-hooks.patch`) the 47
level-1 nodes drawn at `ref-100m` have exactly Node's index counts and their shader grids read back from the GPU equal
Node's texel for texel (`raw/diag-region-off/`, `scripts/grids.ts`); with the far field hidden the bands stay
(`crops/diag-100m-far-hidden.png`): near geometry. And the gapped houses change from run to run
(`crops/diag-60m.png` against 47L.0's): the level choice.

**The cause.** At `ref-100m` house (7, 6) (three storeys, x 15–28 m, z −4–8 m) is cut along its ridge by the face z = 0
m between a level-1 node drawn split into level-0 chunks (the part within the level-0 ring) and one drawn at level 1.
Level 1 lays the roof a fine cell or two higher than level 0 (by design: the coarse stair's eave is the parent of the
fine eave), so the seam (lod-seam.ts) joins two slabs a fine cell thick that do not line up: by distance alone the
coarse underside's boundary landed on the fine top's, the fine underside's boundary was reached by no strip, and its
flap, hung a coarse cell inward along its normal, stood out through the fine roof's top facing down and out. Camera rays
through the band's pixels on the drawn set rebuilt in Node (`scripts/cam.ts`, back faces culled) meet that flap first
(rows 291–297, normal (0, −0.71, −0.71), above the level-0 roof): the grey band (sky-lit underside) with the light off,
the dark band with specks with it on.

**The fix** (9d9a88da, `packages/voxel/src/lod-seam.ts`): a coarse boundary vertex whose nearest fine edge faces the
other way (cosine below −½: a thin slab's far side) moves to the nearest fine edge facing its way (cosine above ½)
when that lies at most a coarse cell farther; rims and creases, whose normals lean between, keep the nearest. Generic:
any slab a fine cell thick that the two levels place differently (sloped roofs at 45° and 1:2; a floor or a wall is
already matched by distance, the levels' faces lining up within a fine cell). Nothing stored changes; seams are derived.

**Test** (`tools/voxel-bench/derived.test.ts`, "closes a gabled roof cut by a level-1 node face…"): the town's
three-storey house cut by a level-1 node face along its ridge on the near slope, at the ridge, on the far slope, and
across it; rays from above at 8°–70° and every azimuth aimed at the roof within four cells of the face, against the
level-1 node, the level-0 chunks and the seam as the page draws them; a ray level 0 alone shows the roof to must not meet
a face looking down. Without the fix 100 of 5,120 rays fail on the near-slope cut; with it none. The seam patch test,
stream-levels and mesh-cases stay green.

**Cost.** The level-1 derive is untouched (its meshes and bytes are what they were). The seam bench (`run.mjs seams
--patches features,town --levels 0,1 --sparse 4`, `work/47L.2/seams/{base,fixed}/seams.md`): no crack ray on any patch
before or after; on the town L0|L1 the seam adds 1,585 triangles instead of 1,754, unmatched edges 56 instead of 218,
open edges 524 m instead of 714 m; L1|L2 1,278 triangles instead of 2,840. Triangles drawn at mid distance fall
slightly, so the orbit and the 128-lamp headroom were not run again (the plan's rule: only when they grow by a few
percent).

**Pictures** (2026-11-24 15:58–16:01 UTC, low, WebGPU, 1280 × 720, built at 9d9a88da, every shot settled in 3.8–12.4 s
with nothing pending; `work/47L.2/shots/after/<camera>-{on,off}.png` and `.json`; before: 47L.0's `shots/head/`; crops
before above after in `work/47L.2/crops/`: `ref-100m-{on,off}-ridges.png`, `ref-60m-{on,off}-gables.png`,
`ref-150m-{on,off}-mid.png`, `street-noon-{on,off}-far.png`). Opened and looked at: with the light off the grey bands on
the 60 m and 100 m houses are gone and the roofs are whole at 150 m. **Still wrong:** at 100 m two grey slivers a few
pixels long remain where the seam meets a verge (D804); with the light on the specks stay (47L.1), some of them now
along the line where the seam joins the two levels' roofs.

**D750 and D784** (the box, 30 minutes). D750: at 47a.1cd's refused shots of the 131-grid town the job queue, jobs in
flight and the far field's pending work and jobs were all 0 (`work/47a.1cd/d/S-g30-*/light-shots.json`), so the settle
check waited either for the simulation's state (read as null when the diagnostics call fails, which the record cannot
tell from 0) or for a draw count still moving; light-shots now records what it waited for on a refused shot
(`waiting`), and a G30 run was not made (it rewrites staging's world). D784: the headroom meter's fill trace
(`work/47a.9/m/lake-head-r1.json`) shows the far field selecting and drawing nothing for the whole 7 minutes after the
lake edits (selected 0, drawn 0, pending 0, jobs 0, far nodes 0) while the near cover grew: not a settle that never
comes but a far field that is empty; the meter's error now names that state. Its cause was not looked for.
**Unverified:** nothing in motion; the level boundary moving across a house while the camera moves; houses on structure
grids (their seams are the same code, not looked at in a picture).

### 47L.1 — the specks: the surfaces' read as first built (07eee3c8)

**First session** (stopped for the lead): Counted as 47L.0 counted them (white / green, whole frame) on the after-pictures of 47L.2 (built at 9d9a88da, light on,
settled): street 4/0, `ref-60m` 99/6, `ref-100m` 268/116, `ref-150m` 399/115 (47L.0's head: 7/0, 107/0, 243/138,
380/114). Work folder `work/47L.1/`.

**Not stored light.** Speck pixels were mapped to their surfaces in Node (the town's level-0 and level-1 meshes from the
reference camera, `scripts/where.ts`) and the volume's cells there read back from the GPU at levels 0–3 (light-shots'
new `--cells-at`, `raw/probe-on/`, `probe/table-nearest.txt`): a speck and a control pixel a few pixels away read the
same cells and the same light. Dense boxes round six speck sites (about 13,000 level-0 cells and the coarse cells round
them, `raw/box-on/`) hold no word out of range: the brightest face is the sky on a +y face (luminance 2.2), the
greenest the ground's bounce on a −y face (0.37 green), and no cell holds light the CPU's rule says it cannot.

**Made in the read.** One run each of `ref-100m` and `ref-150m` (white / green), every other part of the read as
shipped unless named; the variants were source changes kept only in this folder (`read.orig.ts` is the shipped read):

| read | 100 m | 150 m |
|---|---|---|
| as shipped (two runs) | 268/116, 248/147 | 399/115, 517/145 |
| `surfaceRead=coarse` (levels 1–3 only) | 0/0 | 0/0 |
| `surfaceRead=allfaces` (the read as first built: eight cells, every face; two runs) | 0/0, 0/0 | 0/0, 0/0 |
| as built **with** the one-cell read past `readFullM` (24 m at low) | 9/51 | 13/39 |
| as shipped **without** the one-cell read | 124/0 | 165/0 |
| eight-cell loop only, no one-cell branch | 58/0 | 172/7 |
| the same, faces read as built, no shared slot | 90/0 | 114/21 |
| the same, the eight cells unrolled | 34/0 | 14/0 |
| the same, face weights n² in place of `ambientCubeFaceWeights` | 0/0 | 0/0 |
| as shipped, faces read as built / no shared slot / face floor a constant 0 / no window guard | 202/97, 207/103, 246/97, 202/119 | 368/159, 535/230, 388/232, 430/307 |

A probe in place of the light showed the read's normals (shading and geometric) unit length everywhere and no NaN.
So: (1) level 0's **one-cell read past `readFullM`** makes the green specks (and some white) on grass beside walls, on
gables and roofs: one cell in front of the surface, where the eight round it give the surface's light; (2) the
**eight-cell loop** of the shipped read makes white, black and magenta pixels at gable undersides and wall feet that the
as-built read over the same cells does not (`crops/exp-150m-varC.png`, `exp-*-varE.png`): random-looking colours, so
something reads a word that is not the cell's light or a weight that is not finite; which expression does it is not
determined (none of the single changes above removes it; the unrolled loop with n² weights does, which may be chance).
Pictures: `work/47L.1/crops/exp-150m-ground.png` (shipped, without the one-cell read, as built, coarse only),
`exp-100m-varM.png` (as built with the one-cell read).

**The lead's decision**: trace for at most an hour, then fix by the evidence; if the cause is not found, the read as
first built with no one-cell read.

**The trace (not found in the box).** The surface program three builds from the shipped read was dumped in Node
(`work/47L.1/trace/frag-shipped.wgsl`): it is the intended WGSL (every variable assigned before each use, no stale or
uninitialised path; the one read-before-write, the kept irradiance, is the probe light's and set in the page). On the GPU
a mask dump (`?surfaceRead=dumpN`, kept only as `work/47L.1/trace/dump-probe.patch`: flagged pixels drawn black, the rest
as drawn; one run each of `ref-100m` and `ref-150m`, `raw/trace-*`) answered at the speck pixels: level 0's weight is 0
there (`dump9`: everything level 0 reads goes black, the specks stay); no level's light or weight, the summed light, the
final irradiance, radiance, environment term, direct diffuse or specular is non-finite or above 2.5 (`dump4`, 10–13,
17–21, 25–28); no window index falls outside its level's window (`dump32`); every counted level-0 cell holds all six words
(`dump1`). Yet the pixels are white, green, magenta or black (`crops` in `trace/`). With the temporal upscale off
(`&taau=0`) every read variant, the coarse levels alone and the read as first built included, shows the same kind of
pixels along roof bands (`trace/pair-t-coarse-normal.png`; light off: none, `pair-t-off-on.png`): there the sharpening
makes counts meaningless, so the comparisons below are with it on, as shipped. Mixed reads (`dump30`: level 0 as first
built, the coarse levels as shipped: 64/0, 228/0 at 100/150 m, white, magenta and black along an eave,
`trace/pair-a30-150m.png`; `dump31`: the reverse, 12/45, 15/73) put the fault in the shipped form at every level, not in
one expression found: the same arithmetic in a different program shape (one loop, a shared index load, faces skipped by
weight, the one-cell branch) draws them, the written-out form does not. Not determined: why (a compiler or driver
behaviour on the Iris Xe is the remaining candidate; not shown). The CPU twin cannot reproduce it.

**The fix** (option (a), at every level): `voxel-light-volume-read.ts` reads each level as first built: eight cells
written out, each its own index load (inside its window) and its three faces toward the normal by the ambient cube's
n², a cell counted where its first face's word is not 0; the level's window early-out kept (it is what made the read
cheaper at a high view in 46e.14); no distance branch. Lit particles keep the one cell at their centre (a build-time
choice, not a branch). `volumeReadAt` takes `ambientCubeSteps` (equal to the face-floor weights at floor 0 for a unit
normal); `readFullM` and `readFaceFloor` had no reader left and went from the tier settings with
`VOXEL_LIGHT_VOLUME_FACE_FLOOR_MAX` and the `allfaces` flag (§9).

**Tests.** `voxel-light-volume-read.test.ts` builds the lit program in Node and holds the read's form: no loop, no
camera distance, per level eight index loads and the faces' loads, the index probe none; at c16a8ca3 it fails (a loop
found; 9 loads for 32). `voxel-light-volume-layout.test.ts` holds the twin on the town scrap's 2,000+ surface points
(axis faces and normals up to 70° off) to the read written out on its own, a surface's read to the eight cells' blend at
any distance (the one cell in front differs from it at more than a quarter of the points: what far pixels took before),
a particle's one cell, and the leak rule for 1,200 normals with a weight on both sides. The twin's tests pass at the
base too (the GPU's shape is what changed); the made case for a cause was not written: no cause was found.

**Cost** (2026-11-24 18:49–19:45 UTC, low, WebGPU, 1280 × 720, 30 Hz cap, each run alone, A = c16a8ca3 in its own
worktree, B = 07eee3c8, A B A B, second rounds; `--copies none --scales none` on all eight: two rounds with them did not
fit the agent's 9-minute call; `work/47L.1/m/*.{json,log,uptime}`, 1-minute load 0.9–1.5, one 2.9 at a start):

| | GPU near (ms) | GPU lighting (6.67) | page ms a frame | page lighting (2.0) | room (copies) | missed |
|---|---|---|---|---|---|---|
| town A | 3.84 ±0.4, 4.73 ±2.1 | 5.33, 5.46 | 5.42, 5.74 | 0.71, 0.83 | 128, 120 | 0, 0 |
| town B | 3.94 ±1.2, 4.65 ±0.8 | 5.41, 5.06 | 5.67, 6.22 | 0.93, 0.94 | 128, 128 | 0, 0 |
| 128 lamps A | 8.44 ±0.9, 7.98 ±1.6 | 4.96, 5.01 | 6.62, 6.89 | 2.04, 2.00 | 80, 96 | 0, 0 |
| 128 lamps B | 8.37 ±3.5, 8.77 ±1.0 | 4.86, 4.60 | 7.53, 6.90 | 1.99, 1.93 | 76, 76 | 0, 0 |

Every row within its spread (±: the GPU measurement's spread of five samples). The first B 128-lamp run ended with "no
GPU frame times arrived" (14 missed frames at no load while its programs compiled) and was run again (`m/lamps-B-r1-failed.*`).
**D740**: the read's form does not move the 128-lamp scene's `near` (8.4, 8.8 against 8.4, 8.0); its room is 76–96 copies
at both commits, not 47a.13's 15 and 14 (the world was regenerated in 47L.0 and the seam changed in 47L.2 since):
written into D740, not looked into (47L.7).

**Pictures** (2026-11-24, low, WebGPU, 1280 × 720, built at 07eee3c8, light on, two runs, every shot settled in 3.8–12.2 s
with nothing waiting and the volume settled; `work/47L.1/shots/after/<camera>-on-r{1,2}.png`, `light-shots-r{1,2}.json`):
white/green 0/0 at every camera in both runs (before, 47L.2's pictures: street 4/0, `ref-60m` 99/6, `ref-100m` 268/116,
`ref-150m` 399/115). Crops before above after (`work/47L.1/crops/after-*.png`: `ref-100m-ridges`, `ref-100m-wallfoot`,
`ref-60m-gables`, `ref-150m-mid`, `ref-150m-eave`, `street-noon-far`, `ref-30m-house`): opened; the specks are gone from
gables, ridges, eaves and the grass by walls. Nothing lit became darker or flatter: the sunlit gable and the shaded walls
keep their light, the grass by a wall its green; the 30 m house's brick front is smoother (it read one cell a pixel past
24 m before: its blocky patches are gone); the rooms seen through windows at 30 m stay dark. **Still wrong:** the grey
slivers of D804 at `ref-100m`, small notches along one ridge at `ref-60m` (level-1 geometry, seen with the light off too).
**Indoors** (`shots/indoor/<camera>-{A,B}.png`, crops `after-indoor-*.png`, same build pair): `room-window` and
`room-window-2m` alike in brightness, the floor's blotches (D692, 47L.5) a little softer, no new leak; `cave` the same;
`house-above` the same. **Grid houses** (`town-grids --variant g30`, every house in its own grid turned 30°, the world
restored after and its voxel files byte-equal, `raw/grids-{A,B}-on/`, `crops/after-grids-g30-lroom-above.png`):
`lroom-above` (looking down on the grid houses from 38 m) 781 white/green at c16a8ca3 (gables, ridges, eaves of the turned
houses, one gable drawn half see-through), 0 at the fix; `ref-60m` at the fix (its view blocked by turned houses within
10–60 m): none. Both shots were refused by the settle check (D750: "simulation state not read"), the volume settled
in each. **Gates**: `npm run build` and `npm run lint` green; the fast gate at 07eee3c8
(`gate-fast-20261124-200637`: build, lint, vitest 799 passed with `retry-scene-id.test.ts` failing once and passing
alone (D807), 326 of 327 e2e in 28 min over every area the read reaches) red only on `frame-rate-cap` (D659's
load-sensitive check: 64 fps uncapped against > 90, load mean 6.0), green on `gate.sh rerun`
(`gate-rerun-20261124-204644`, with the perf check). No expectation changed. **Unverified:** nothing in motion; the 45°
grids; medium and high (same code); the cause on the GPU.

### 47L.3 — light through walls and corners: the read, not the stamp (52b31126)

**The census, before any fix** (Node, `work/47L.3/scripts/`: `census.ts`, `exact.ts`, `wall.ts`; the real light walk with
the stamps in a real prop channel by the default rule, the volume update's model `volumeRayRadiance` for the cells, its
CPU read for the surfaces; sky and sun at noon and at 11°). The volume's **cells**: no cell inside a sealed house holds
light. Generator houses (four shapes, one-cell walls, gable and hip roofs, no opening) at 0°, 7°, 15°, 30°, 38°, 45°,
noon and low: 0 lit of 3,658–3,947 room cells a yaw. The bench town's houses with their openings filled (8 houses, 0°,
30°, 45°, noon and low): 0 of 15,784–17,759. The same houses at every 3° from 0° to 45°, 16 rays a face: none of 19
million rays escapes. One wall a cell thick, and an L of two, in an empty world at every degree 0°–90° and four sub-cell
places, 2,000 rays each across it: none passes. Cells straddling a wall (middle in a wall cell, held): 0–6, none lit. So
**the stamp is tight; no yaw fails there** and it was left as it is. The **surfaces' read** on the inside faces (four
points a face, 95,552 a variant for the town): it took light from outside at 373 / 5,022 / 5,725 points at 0° / 30° /
45° (gable tops, under roofs, eaves, inner corners, floor edges; brightest 0.12–0.57 against 0.7–0.8 on outside walls),
the generator houses at 64 / 1,188 / 1,230 / 1,561 of 22,312 at 0° / 15° / 30° / 45°. Two causes, both in the read:

1. **Across a thin solid.** The eight cells round a point beside a solid one cell thick whose cells touch by an edge (a
   roof's steps even at 0°, a turned wall's staircase, a room's inner corner) hold cells of both sides; read whole, the
   outside's light showed inside. The light walk never passes such a solid (6-connected); the read did.
2. **The coarse levels at a corner (D746).** At a room's inner corner turned 45°, level 0's weight is 0.14–0.41 (GPU
   cells read back with `--cells-at` at 104 points, `raw/probe-G45-corner/`: level-0 light 0.007–0.05 there): level 0
   took its share by that weight and the coarse levels, whose 1–4 m cells span the walls, lit the rest from outside
   (`surfaceRead=coarse` lights the walls by the corners brightly, `raw/diag-G45-coarse/`; `surfaceRead=level0` keeps the
   line, the flat term filling the rest). The line is a voxel surface's (`surfaceRead=surface` keeps it).

**The fix** (52b31126, `voxel-light-volume-read.ts` and its CPU twin in `voxel-light-volume-layout.ts`, one commit with
the tests that pair them): a surface counts only the cells of the eight reached from its point's cell a face step at a
time through cells holding light (`volumeReadReach`; where the point's cell holds none, from the cell off the surface most
toward the normal less the point's distance to it, else the nearest; four steps cross any such way); and a surface's
level takes its share by the weight of the cells the level knows (in its window, in a kept brick) where it reads some
light, a particle's by its weight as before. No load was added (eight index loads, five pool loads a cell, as 47L.1's form
test holds); the cells' light is untouched (the update, the walk and the stamp did not change). A conservative stamp or
exact stepping was not needed: nothing passes the stamp.

**After** (same census): the town's inside faces read light from outside at 0 / 0 / 0 points (noon and low); the
generator houses at 0 at 0°, 15°, 30°, 38°, 45° and **12 of 22,312 at 7°** (one shape: points whose eight cells are all
solid but one past the eave). With the coarse level 1 in the read (edge points, 0.01–0.06 of a cell from an edge): 299
/ 389 points at 30° / 45° with the share by held weight, 2 / 41 with the share by known cells (points where level 0
holds nothing reachable and the coarse levels answer). Points left with no weight (the flat term): inside 0 / 6 / 29,
outside 2 / 2–8 / 8–12 of 73,920–77,128, the same as before.

**The controls** (the town's houses with their openings as they are). The light cells are the same before and after (the
read changed). The read on the inside faces, mean, noon: 0° 0.01294 → 0.01262 (−2.5 %), 30° 0.01682 → 0.01548 (−8 %),
45° 0.0156 → 0.01369 (−12 %): what was read from outside. Outside walls 0.785 → 0.785 at 0°, 0.709 → 0.714 at 30°. **The
turned openings' loss**: with exact stepping as the truth (`exact.ts`, the same rays), the stamp lets the light cells of
rooms turned 30° see 1.18× the sky they should (2,644 rays pass beside openings where the wall stands, 1,470 stop inside
them), 45° 0.99× (1,702 / 1,770); a room with one window turned 15°–45° reads 1.04–1.42× the unturned one: the opening is
moved more than narrowed, so "12–18 % loss" is half of it. **Kept** by this item (the stamp is unchanged): D811.

**Tests.** `voxel-light-volume-rooms.test.ts` (new, Node, 7 s): a generator house with no opening at 0°, 7°, 15°, 30°,
38°, 45°, placed off the cell lattice, noon and low sun: more than 1,000 room cells, none lit; more than 5,000 inside face
points, none reading light; a house with one window turned 15°–45° within 0.75–1.5 of its room's mean unturned (sky
alone; measured 1.04–1.42). `voxel-light-volume-layout.test.ts`: the read never takes a cell across a roof's steps
(1,600 points, the slope's normal and the steps' own), a surface beside a thin solid takes level 0 whole where it reads
some light (and leaves a place level 0 does not know to the coarse levels); the twin's written-out read now walks the
eight cells itself. **Without the fix** (the layout at dbcb1a1e, `base-check/fail-at-base.txt`): every yaw of the room
test fails (359–615 inside points reading light), the roof-step and level-share tests fail, and the town-scrap twin
tests fail; the "no room cell lit" half passes at the base (the stamp was always tight). The particle test's written-out
rule now skips cells under the read's least weight (1e-4), as the GPU always did.

**Cost** (2026-11-24 23:00–23:45 UTC, low, WebGPU, 1280 × 720, 30 Hz cap, each run alone, A = dbcb1a1e in its own
worktree, B = 52b31126, `--copies none --scales none` on all (two rounds did not fit the 9-minute call with them);
`work/47L.3/m/`, 1-minute load 1.3–4.9 at starts):

| | GPU near (ms) | GPU lighting (6.67) | page ms a frame | page lighting (2.0) | room (copies) | missed |
|---|---|---|---|---|---|---|
| town A | 4.40 ±1.3, 4.65 ±2.2 | 5.26 ±0.9, 5.28 ±0.4 | 7.97, 30.0 | 1.03, 1.40 | 128, 120 | 0, 1 |
| town B | 4.43 ±0.4, 5.00 ±1.0 | 6.00 ±1.8, 5.62 ±0.8 | 39.0, 6.36 | 1.40, 0.90 | 128, 128 | 2, 0 |
| 128 lamps A | 8.63 ±2.3, 7.58 ±0.7 | 6.23 ±0.6, 4.87 ±1.0 | 8.99, 9.26 | 2.15, 2.61 | 88, 7 | 1, 2 |
| 128 lamps B | 10.32 ±2.6, 8.89 ±0.1 | 6.19 ±0.6, 5.63 ±0.2 | 8.16, 8.41 | 2.03, 2.50 | 68, 88 | 0, 1 |

Not resolved within the spreads; the town's GPU lighting read 0.3–0.7 ms higher at B in both rounds (the read's added
arithmetic, no added load), and the lamps' `near` 1.3–1.7 ms higher (spread 0.1–2.6): reported, not claimed. Two page
readings of 30 and 39 ms (one A, one B) are rounds whose frames stalled (sim 6 ms in both), not the read. Retries: B's
first town run was served from a dist built before the commit (dirty at dbcb1a1e, `m/town-B-r1-failed.*`), B's first
128-lamp run ended "no GPU frame times arrived" (17 missed frames at no load, D806, `m/lamps-B-r1-failed.*`). The stamp's
simulation time was not measured: no stamp changed.

**Pictures** (2026-11-24 21:24–22:52 UTC, low, WebGPU, 1280 × 720; `work/47L.3/raw/{before,after}-{W,G0,G30,G45}/`,
`room-window`, `room-window-2m`, `props-table`, `house-above` (+ `lroom-above` after, W); W settled in 3.2–16.6 s with
nothing pending; the grid towns' shots refused by the settle check (D750: "simulation state not read") with the volume
settled, every level's stale count 0; before at dbcb1a1e's code, after at 52b31126's; crops before above after in
`work/47L.3/crops/`). Opened and looked at. **Before**: G45's two bright vertical lines at the room's inner corners and a
bright line along the floor's edge at the right corner (`G45-room-window-full.png`); a dashed bright line at the walls'
feet in W and every G; no leak line seen in W's or G0's rooms beyond it. **After**: G45's corner lines and its floor-edge
line at the corner are gone; W and G0 look as before (the floor's blotches, D692, vary run to run); the dashed line at the
walls' feet is fainter in W, the same in the turned rooms. **Still wrong:** the dashed wall-foot line and a bright line
along the floor's edge in G45's `props-table` (D810, system not determined); turned walls show light in blocks a cell or
two wide (D809: level 0's own structure, no longer smoothed by the coarse levels); open turned rooms take more sky than
they should (D811). **Did a room get wrongly darker?** No room went dark: the windows light W, G0, G30, G45 as before; the
turned walls' blocks are darker and lighter both. The sun's direct light: no strip of sun on a floor inside a closed room
in these pictures (the town's rooms have windows; their patches of sun are through them); the strip inside a shut door is
47L.4's. Reference cameras after (`raw/after-ref/`, settled, light on): speck counts 0/0 at `street-noon`, `ref-30m` …
`ref-150m`, as 47L.1 left them (D805's condition for a change of the read's program).

**Gates**: `npm run build`, `npm run lint` green. `gate-fast-20261124-235705` (build, lint, vitest 801 files, 327 e2e
over every area the read reaches) RED on `frame-rate-cap` (D659), `sockets` (D639), `structure-mode`'s redo (D774/D788),
`terrain-cdlod` (D643), the Scene view's top row (D798) and the Play test's door (its "open" reading 0.746 taken before the
room's cell settled, against 0.58–0.60 in every earlier gate; reopened 0.584 as always; the cells are not touched by this
item); `gate-rerun-20261125-003914` RED on D659, D768 (`memory`), D320 (`rendering`'s dynamic resolution), D643, the door
0.586 / 0.581; `gate-rerun-20261125-011703` RED on D659, D639, D643 only. D643 placed: alone at the head 0.615, 0.605, 0.592
(post pixels of the impostors against the meshes', > 0.6), alone at dbcb1a1e 0.587, 0.597 (`work/47L.3/tcdlod-*.log`):
the same at the base. No expectation changed in an e2e file.

**`taau=0` box** (30 minutes, `raw/taau0-*`, `crops/taau0-ref-100m-*.png`): `ref-100m` at 52b31126 without the upscale:
white/green 4/183 on, 0/85 off (grass aliasing makes green "specks" with the light off: the counts mean nothing without
the upscale); 0/133 at dbcb1a1e on. Looked at: clusters of black pixels on a recessed, shaded wall under an eave about
100 m out, 549 black pixels in the house's box at the head, 406 at dbcb1a1e (with a magenta patch on a roof there), none
with the light off, none with the upscale on. The kind 47L.1 traced (pixels whose read differs from their neighbours' on
the Iris Xe, D805) that the upscale's blend hides; not a seam. D808, not fixed.

**Unverified:** nothing in motion; medium and high (same code); WebGL 2 (its smoke in the gate); the turned rooms'
pictures were taken refused by D750's settle (the volume settled in each).

### 47L.4 — shut doors: the whole opening, the coarse levels and the sun's shadow

**Built** (e7c04aa6, `voxel-portals.ts`, `prop-channel.ts`, game-host `voxel-play.ts`; nothing stored):
- **A portal's cells over the whole opening (D791).** The join floods the face-joined `opening` cells from the prop's
  cell with no reach bound: the flood is bounded only by the opening's own cells and the grid's resident chunks; when the
  run goes on into a chunk of the grid that is not resident the join waits (`later`) and joins once it is. Not a
  per-project cap: the bound is the opening itself. A 6 m barn door shuts whole.
- **Coarse levels see a shut door (D773, structure grids).** A shut portal's stamp is marked `mipStop`: the prop
  channel's `mipStops` (what the walk's mip levels stop at) takes its cells that stop light whole, with no structure class
  (the regions keep their portal); a flip tells the chunk's listeners `mips`, and the page's batcher sends the chunk's
  mip blocks again as for a structure stamp. **World-grid openings** still take no prop (the join reads structure grids
  only): not done.
- **Thin props (D727)**: not covered (these changes stamp an opening's cells, not a prop's shape); the row stays open.

**Tests** (`runtime/voxel-portals.test.ts`, the real prop channel, a wall turned 30°): a barn door 13 cells (6.5 m) wide
and a slot 9 cells (4.5 m) tall shut whole: the walk graph is given every cell, every world cell whose middle lies in the
opening stops light at level 0 and its level-1 cell at the mips, the listeners hear `mips` and never `classes`, a light
ray walked at the mip levels only (no level 0 known) from 3 m before the opening to 3 m behind it stops shut and passes
open, and opened every byte and mip stop goes. Without the changes: 54 of 78 cells joined (the 4 m reach); without the
`mipStop` flag the coarse ray passes the shut door. `prop-channel.test.ts`, `world-host-grids.test.ts`,
`occupancy-walk.test.ts` green.

**Measured in the first session** (the 47a.7 scratch `zz-door-look.e2e.ts` copied into `tests/e2e` for the run and removed, low, WebGPU, the
editor's Play at the 30 Hz cap; before at 52b31126's code, after with these changes; `work/47L.4/m-{before,after}/`):
flip → the room's light cell moving a fifth: shut 36 (a cell already moving), 713, 722 ms before, 710, 1,120, 1,015 ms
after; open 1,937, 1,866, 1,613 before, 1,502, 1,495, 979 after. A hundred doors shut in one step: the simulation's
longest step 13.8 / 13.2 ms before, 13.2 / 11.6 after; the peak step and ten after 69.1 / 35.1 against 59.1 / 60.1 ms;
page lighting's longest 5.5 / 5.1 against 5.7 / 5.8 ms: within the runs' spread. Room cell: open 0.347 / 0.338, shut
0.041 / 0.065 (before / after). Pictures `work/47L.4/shots/{before,after}/06*–08*.png`, opened: the same in both; the
strip of sun and its fan stay (D812).

**The sun's shadow over a shut opening (D812; second session).** The shut state lived in
the simulation and never reached the page, so only the prop's own model cast the sun's shadow. Now
`WorldPortals` gives each grid's set of shut openings that stop light (their cells, the grid's frame) whenever it
changes (`shutChanged`, the host's connection `shutOpenings`); game-host `voxel-play.ts` hands it to the grid's own
`ChunkDrawBatcher.setShut`, which sends the whole set with the next batch when it differs (`ChunkDrawBatch.shut`: the
channel the grid's draws already travel on, in Play's worker or page and in an export; nothing stored); the page's
draws of the grid (`VoxelWorldDraws`, its view's root; new `three-adapter/voxel-portal-casters.ts`) make one mesh of the cells'
outer faces a shut opening, on the off-view layer the shadow cameras see (as the relief chunks' plain casters), a
static caster whose coming and going is reported where it stands, so the cached map is drawn again only there; glass
(`stops.light` false) sends nothing. No private three hook, no `jsm` module. The Scene view runs no portal state and
casts none (its leaf model casts as drawn): not built. **World-grid openings** still take no prop (47b's world edit
mode or a later item). **Thin props (D727)**: not covered: the casters follow an opening's cells, not a prop's shape.

**What the pictures found: no strip with a placed leaf, before or after.** The scratch spec
(`work/47L.4/scratch/zz-door-look.e2e.ts`, copied into `tests/e2e` for each run and removed; low, WebGPU, the editor's
Play maximized, the preview 1280 × 668; base = fffd12ca in its own worktree, head = this change; `shots/{base,head}/`,
`door-*.log`, `m-{base,head}/`) shows the strip of 47a.7 was not the sun's shadow map: (1) `07b` of 47a.7 and 47L.4's first session
was taken after the scratch's script put the leaf back with `transform: { position }` alone; in this session's first
run that left a lit jamb and a fan of light at the threshold that the same room shut without the round trip did not
show (`crops/dbg-07-07b.png`, D814); with the leaf's rotation written too, `07b` equals `07` (`crops/cmp-07b.png`: base
above head, alike); (2) the look house's door does not face the scene's sun (light along (0.4, −1, −0.3)): with the door open and
the leaf away no sun lies on its floor (`06b`), and the glow left at the threshold shut is the light volume's (gone
with the store off: `07c`). A door turned 135° faces the sun: open, a sun patch lies on the floor inside (`15`); shut
with its 0.1 m leaf in place, none at the base already (`crops/sun-shut-base-head.png`, `15c` with the store off): the
low tier's map does shade a placed 0.1 m leaf. What the casters cure is a shut prop whose model does not fill the
opening: a portal prop with no model, shut, left the sun's patch on the floor of an otherwise dark room at the base and
leaves none now (`16b`, `crops/bare-shut-base-head.png`: base above, head below; the floor patch's mean luminance 155
of 165 open at the base, 0 at the head); the same holds for a leaf thinner than a texel and its bias, a model with
holes, or one drawn out of place while the portal is shut. So clause (f)'s "no strip" holds at both commits; the
change makes the sun follow portal state rather than the model (decided in §9, owner to confirm).

**Tests.** `runtime/voxel-portals.test.ts`: the grid's set given once shut (the 15 cells, the grid's frame), empty
once opened, nothing for a shut pane. `voxel/chunk-batch.test.ts`: the set sent whole when it changes, never the same
twice, the empty set when every door opens. `three-adapter/voxel-portal-casters.test.ts`: a closed surface over
exactly the cells (46 faces for a 3 × 5 × 1 opening, every edge shared once each way), not in the view's layer and in
the off-view layer, a static caster reported at its place under the grid's root, gone when opened. Play e2e
(`voxel-shadows.ts` door checks, in `voxel-world.e2e.ts`'s Play test): no caster open, one in the grid's draws shut
with the static map drawn again, none reopened, none for the shut pane; Export: one caster once the console shuts
the door (served statically, backend stopped). The e2e house's door does not face the sun, so the e2e checks the
caster, not a floor pixel (the pixels are the scratch's, above). Without the change the casters count is 0 and every
one of these fails.

**Cost** (the scratch, one Play each at the 30 Hz cap, base then head, 2026-11-25 03:57–04:28 UTC, load 0.6–1.5):
flip → sun (the bare door facing the sun, the floor patch crossing halfway, screenshots polled 60–130 ms apart):
shut 406, 130, 392 ms, open 137, 133, 137 ms. Flip → the room's light cell moving a fifth: shut 72, 41, 39 ms, open
59, 93, 65 ms (base 68, 42, 649 and 62, 67, 71; faster than 47a.7's 0.7–1.7 s at both commits with this scene: whether
the cell was still moving from the flip before was not determined). A hundred doors shut in one step: the simulation's
longest step 20.0 / 14.8 ms (base 13.2 / 15.0), the peak and ten after 80.3 / 69.0 (65.8 / 63.4), page lighting's longest
3.8 / 3.4 (2.8 / 2.6): within the runs' spread, not resolved. The page's `shadows` GPU reading (`measureGpu`, only
shadows, 3 repeats, the yard of 100 doors in view from 30 m, A B A B in one Play): head open 0.49 ±0.18, 0.81 ±0.10,
100 shut 0.75 ±0.16, 0.62 ±0.35; base open 0.44 ±0.32, 0.34 ±0.15, shut 0.70 ±0.20, 0.45 ±0.13: not resolved (the casters
draw into the cached map only when it is drawn again).

**Gates**: `npm run build`, `npm run lint` green. `gate-fast-20261125-042553` (build, lint, vitest 802 files, 327 e2e over
every area) RED on `rendering.e2e.ts:491` (D813: its 240 s timeout), `start.e2e.ts:62` (D815: the backend's close timed
out), `ui-editor.e2e.ts:114` (D816), the Play test at its profile's jobs lane (D799, before the door) and the Scene view's
top row (D798); the Export test with its door and caster check passed. Placed alone before the rerun: start 1 of 9 failed
at the head, 0 of 9 at fffd12ca; ui-editor 0 of 3 at the head, 1 of 3 at fffd12ca; rendering:491 passed alone at both (42 s,
41 s). `gate-rerun-20261125-050942` RED on D813 alone; the Play test (door: open 0.591, shut 0.028, reopened 0.636, pane
0.592; the casters as checked) and the Scene view green. The Play test 4.3 min in the rerun's five files (its own time not
split out). The leak test: `gate-area-20261125-051709` (area play, 24 e2e with `memory.e2e.ts`) GREEN. No expectation
changed.

**Pictures** (`work/47L.4/shots/{base,head}/`, opened): `06`/`07` the look room open and shut with the leaf in;
`06b`/`07b` the honest pair (leaf away open, leaf in shut): no strip; `09`/`09b`/`09c` the 6 m door open with its leaf in,
shut, and from outside: whole, no strip at either commit (its door does not face the sun); `10` a shut pane: the room
lit as open (no caster); `11`/`12` the 45° pair from 60 m and 150 m (left: open doorway, the control; right: shut
leaf): **still wrong**: the scratch's world has no far field, so past the ground's edge the pair floats in the sky and
the pictures say little about the coarse levels (D773's mips are proven in Node); `15`–`15e` and `16`/`16b` the sun-facing
doors. Settle: each picture taken 3–8 s after its change with the cells read updated (no settle record of the bench's
kind: these are Play pictures). **Still wrong:** a faint glow of the light volume at the threshold of a shut door
(`07b`, both commits: the read of the cells at the stamp's edge, D810's kind, 47L.5). **Unverified:** nothing in motion;
medium and high (same code); WebGL 2 (casters are built the same way; not looked at).

### 47L.5 — patchy indirect light: a turned wall's read reached one column of its cells (9dfbb292)

**Where the patchiness comes from** (Node, `work/47L.5/scripts/wallread.ts`: a one-storey generator house with a 2 × 1.5 m
window, stamped by the default rule off the cell lattice, lit by the update's model (sky and the noon sun); its back
wall's inside face read every 5 cm along a row 1.2 m over the floor, 151 points; the cells' light at 32 rays a face (one
update's worth), 256 (the low tier's settled history: 4 rays × 64 updates), 1,024 and 2,048 (near converged)):

| yaw | read's largest step between points 5 cm apart, over the mean (2,048 rays) | cells a point reads: mean, least | read's CV (the light's own fall) | stored cells' CV by the wall, 32 / 256 / 2,048 rays |
|---|---|---|---|---|
| 0° (W, G0) | 0.048 | 4, 4 | 0.225 | 2.04 / 0.38 / 0.25 |
| 17° | 0.299 | 3.3, 2 | 0.214 | 0.86 / — / 0.22 |
| 30° | 0.402 | 2.79, 2 | 0.229 | 0.73 / 0.45 / 0.21 |
| 45° | 0.442 | 2.0, 2 | 0.208 | 0.97 / — / 0.23 |

So there are two things, and they are not one. **D809 is the read's** (with the cells converged the turned walls still
step by 0.30–0.44 of their mean, the straight one by 0.05): the eight cells round a point beside a turned wall, which is
stamped as a staircase, hold light only where a solid lies across one of their faces; the open cells in the
staircase's notches touch it only by an edge, hold none, and so the cells on the room's side touch one another only
through them. The reach rule of 47L.3 (a face step at a time through cells holding light) then counted one column of
the staircase's cells or the other (two cells of eight at every point at 45°), and a point's light jumped where the
column changed: the blocks a cell wide. Before 47L.3 the coarse levels' 1–4 m cells blurred it (and lit it from outside).
**D692 is the stored cells'**: one update's 32 rays leave neighbouring cells of one evenly lit wall 0.7–2.0 apart (CV),
the low tier's settled history of 256 rays 0.38–0.45, converged 0.21–0.25 (the light's own fall over the wall); the
update's same-face filter (not in this model) softens it further; 46e.6b had ruled out the accumulation weight and the
sequence. Not measured on the GPU: the cells' CV per variant (`--cells-at` along a wall) was not taken in this session's
time; the Node numbers stand for it.

**Rejected on the way:** letting the reach pass the cell of the eight farthest along the normal where it holds nothing
(open air off the surface, by geometry): the rooms census found 1–88 inside points reading outside light at 0°–45° (the
far corner can be solid: an inner corner's wall), so that cell's emptiness cannot be told from solidity in the read.

**The fix** (9dfbb292; `voxel-light-volume-layout.ts` `volumeCellHolds`, `VOLUME_HOLD_STEPS`, and the update's WGSL
`volume_holds` from the same list, one commit with the tests): a level-0 cell holds light where it is open with a solid
across one of its faces **or edges**. The notch cells now hold light; the read is unchanged (its program, its reach, its
loads): it walks through them to both columns and reads four to six of its eight cells. The read still never passes a
solid (a solid cell never holds light). A cell holding only by an edge across a brick's edge may lie in a brick not kept
(no slot; it then holds nothing, rare). Nothing stored; no new constant (the eighteen steps are the rule).

**After** (the same model): largest step 0.040 / 0.040 / 0.036 at 17° / 30° / 45° (0.048 unturned); cells read 5.25 / 5.7 /
6.0 on average, at least 4 / 4 / 6; the read's CV 0.20 / 0.21 / 0.16. Held cells round the house +39 % (0°) to +48 % (turned):
the update's rays go to more cells of the bricks it already updates.

**Tests.** `voxel-light-volume-rooms.test.ts`: new, "a turned wall reads its light as smoothly as a straight one" (the house
above at 0°, 17°, 30°, 45°, 1,024 rays a face): the largest step between points 5 cm apart under 0.2 of the mean (with
the face rule 0.61, 0.68, 0.92 at 17°, 30°, 45°: fails; 0.05–0.09 now), every point reading at least 4 cells (2 with the
face rule), the wall's CV within 1.25× the unturned wall's and its mean over 0.6 of it; the census of 47L.3 now uses the
update's own rule (`volumeCellHolds`) and stays 0 (no room cell lit, no inside face reading outside light at six yaws).
`voxel-light-volume-layout.test.ts`: the update's `volume_holds` walks exactly the CPU twin's eighteen steps in order; the
cell-by-cell reference holds by a face or an edge (fails with the face rule). Every light-volume test file green (12, 87
tests).

**Speck counts** (the read's program did not change; its cells did): `street-noon`, `ref-30m` … `ref-150m` at 9dfbb292, two
runs, all settled: white / green 0 / 0 at every camera in both (`raw/B-ref-r{1,2}/`); `lroom-above` 0 / 0 at G0, G30, G45 at
both commits.

**Cost** (2026-11-25 06:50–07:20 UTC, low, WebGPU, 1280 × 720, 30 Hz cap, each run alone, A = a42eff9d in its own worktree, B
= 9dfbb292, A B A B, `--copies none --scales none` on all (two rounds with them do not fit the 9-minute call);
`work/47L.5/m/`, 1-minute load 0.9–2.0):

| | GPU near (ms) | GPU lighting (6.67) | page ms a frame | page lighting (2.0) | room (copies) | missed |
|---|---|---|---|---|---|---|
| town A | below ±0.6, 5.42 ±2.5 | 6.21 ±1.2, 5.21 ±0.4 | 5.32, 5.56 | 0.77, 0.78 | 128, 120 | 0, 0 |
| town B | 4.91 ±0.5, 5.01 ±1.2 | 4.85 ±0.2, 5.65 ±1.6 | 6.07, 6.33 | 0.95, 1.04 | 120, 120 | 0, 0 |
| 128 lamps A | 9.66 ±3.0, 9.03 ±1.9 | 6.03 ±1.9, 6.77 ±1.6 | 6.95, 6.91 | 2.08, 1.82 | 68, 68 | 0, 0 |
| 128 lamps B | 9.77 ±0.5, 8.81 ±0.2 | 7.22 ±0.8, 5.12 ±4.1 | 6.37, 6.94 | 1.86, 2.21 | 80, 76 | 1, 1 |

GPU lighting not resolved within the spreads (town B no higher; lamps one reading each side of 6.67); the town's page
lighting read 0.17–0.26 ms higher at B in both rounds (inside its 2.0 row; not explained: the change is on the GPU).
Where the town's GPU lighting row stands: 4.9–6.2 ms against 6.67 at both commits (47L.3's 5.3–6.0). No tier setting
was needed.

**Gates**: `npm run build`, lint (the changed files; the gate's whole lint) green. `gate-fast-20261125-072018` (build, lint,
vitest 802 files, 327 e2e) RED on `frame-rate-cap` (D659), `project-items.e2e.ts:183` (alone 3 of 3 at the head, 2 of 3 at
a42eff9d: an old flake, D410's kind), `resource-manager.e2e.ts:97` (3 of 3 alone at both), `rendering.e2e.ts:878`
(D320: 1 of 3 alone failed at the head, 0 of 3 at a42eff9d; no voxel world in it) and `voxel-world.e2e.ts:1652`'s switch-off proof
("switched off, the picture is the store-off one": 1,056 px apart against < 40). That test alone at the head passed 3 of 3 (0 px);
at a42eff9d in its worktree it failed 3 of 3 before reaching the proof (the character on the pad, the roof's stale bricks: that
worktree's run, not comparable). `gate-rerun-20261125-081722`: every other file green, the proof again 49 px apart: the pixels lie
along the far hills' skyline against the sky (`work/47L.5/gate-1652/pair.png`: the far field's edge drawn a pixel differently with the
store off before and after), not in what the volume lights; D817. No expectation changed; the bound was not widened.

**Pictures** (low, WebGPU, 1280 × 720; `work/47L.5/raw/{A,B}-{W,G0,G30,G45}/`, before = a42eff9d, after = 9dfbb292; W settled
in 3.6–11.6 s with nothing pending; the G variants refused by the settle check, D750 "simulation state not read", every
level's stale count 0 in each; the staging world set by `town-grids` and restored after, its 3,074 voxel files
byte-equal; crops before above after in `work/47L.5/crops/`). Opened: `G45-room-window-wall.png` and
`G30-room-window-wall.png`: the dark and light rectangles beside the windows are gone, the wall's light falls off smoothly
from each window (faint broad patches remain); `G0-*`, `W-*` alike before and after (axis walls: nothing changed there);
`G45-props-table-full.png` the same light, the floor-edge line still there; `W-cave-full.png` alike; `W-street-noon-gable.png`
the white gable's soft blotches as before (D692); `G45-lroom-above-full.png` no speck, no change outside. **Still wrong:**
the floor's and the gable's soft blotches (D692: stored ray noise); the dashed bright line at the walls' feet in W and every
G and the floor-edge line in G45's `props-table` (D810: with `&surfaceRead=surface` the dashes stay, so not the kit pieces;
with the volume off none, so the voxel surfaces' read at the wall's foot, `crops/W-wallfoot-surfaceonly.png`,
`W-wallfoot-on-off.png`; which cells it reads there was not traced); no room got leakier, darker or flatter in these
pictures. **Unverified:** nothing in motion; medium and high (same code); the cells' spread on the GPU.

### 47L.5b — the wall-foot line and the switch-off proof

**D810, the wall-foot line (60-minute box; cause not found).** W's `room-window` at the head (built at 9dfbb292's code; low,
WebGPU, settled in 11.2 s; `work/47L.5b/raw/W-*`). The line is the pixels right at the junction of the west wall and the
floor where no level reads light, so the flat term shows: the dashes are about 95 of 255 grey, the floor and wall round
them 10–30. It stays with `&surfaceRead=surface,level0` and with `surface,coarse` (each level alone has nothing there),
and with `&taau=0` it is one unbroken aliased line a pixel high: the upscale breaks it into the dashes
(`crops/W-wallfoot-variants.png`: default, level 0 only, coarse only, `taau=0`). **Ruled out:** (1) the read's rule over
the GPU's own cells: the room's cells read back at four levels (`--cells-at`, `cells-W.json`: 1,851 cells; the solids and
holds equal the Node derive's) fed to the CPU twin (`scripts/gpuread.ts`, `sweep*.ts`: `volumeReadLevels`) read the foot
dark and smooth (0.007–0.2, level 0 whole) at floor points 0.01–0.5 m from the wall and wall points 0.01–0.5 m over the floor
along the whole wall, and never give no weight within ±20 mm of the corner with up, +x, diagonal or tilted normals; the one
odd place is a 0.4 m stretch where floor points 0.1–10 mm under the wall's plane read a window cell (1.1); (2) the
geometry: the level-0 base surface there (`scripts/tris.ts`, Node derive of the bench town) is axis-aligned triangles
sharing the edge's vertices, no T-junction, no slanted normal; (3) the update's model on a Node build of the same house
(`scripts/wallfoot.ts`) reads the foot dark; (4) the sun and the kit pieces (47L.5). So the twin cannot make the line and
the GPU's read differs from it at those fragments (D805's kind). **Next step** (not taken): a dump of the GPU fragment's
point, normal and each level's weight at the line's pixels. No fix, no test; D810 left open with this table.

**D817, the switch-off proof** (`voxel-world.e2e.ts:1652`, run alone in a 10 G scope, `work/47L.5b/d817/*.log`):

| commit | runs | off before and after (px, bound 40) |
|---|---|---|
| 583ef62f (head) | 3 | 0, 0, 107 |
| a42eff9d | 3 | 0, 0, 0 |
| dbcb1a1e (before 47L.3) | 3 | 0, 0, 212 |
| head with the wait | 4 (the last 2 with the fine bricks counted) | 0, 0, 0, 0 |

47L.5's base failure at a42eff9d was its worktree (the packages' own `node_modules`, `@dimforge` among them, were not
linked: `scripts/mkbase.sh` links them). The two failures, at the head and before 47L.3, lie along the left hill's skyline
(`d817/pairs-top.png`: before, after at the head, then at dbcb1a1e): the far field drawn otherwise minutes later, nothing the
volume lights, so not a defect of 47L.3–47L.5. **The test now waits** before both store-off stills until the far field has
nothing pending (the simulation's nodes and jobs, the page's fine bricks) and what the page draws of it (nodes, bricks,
triangles, draws, trims, covered, fine bricks) stays the same for 2 s (`farStill`, `tests/e2e/voxel-shadows.ts`); the bound
is unchanged. With it alone at the head 4 of 4 at 0 px, every wait at its 2 s floor: the failure was not reproduced with
the wait in place, so that it cures it is **unverified** (D817 stays a watch row; D785, the same test's earlier row, placed
with it).
**Gate** (74f674e2): `gate-fast-20261125-093310` (build, lint, vitest 802 files, 327 e2e) RED on `start.e2e.ts:62` (D815) and
`frame-rate-cap` (D659) only, the proof passing in it at 0 px (the far wait 2.15 s, load mean 6.5); `gate-rerun-20261125-101407`
GREEN. No expectation changed.

### 47L.6 — light through partly covered cells (9492710d)

**What the data holds.** Ground: its density, every cell (`coverage()` in `derived-data.ts`; shape × 17; drawn and stopping
from 128). Construction: its form's share (`LIGHT_COVERAGE`: box 255, panel 64, bar 100, post 16 — but no class takes a thin
form since derived 22: `classForm` makes walls, beams and rails boxes) and, damaged, the least of that and its integrity's
share (`integrityCoverage`, 17 × integrity, 1–14; a stage-2/3 hole is `FORM_HOLE`, a box for every consumer but the base
surface, so drawn as a body for the walk). Props marked to light: the sampled share (4³ points a cell) in the prop channel,
joined 1 − (1 − a)(1 − b); structure grids' stamps write their share of samples in stopping grid cells into the same channel.
Kit pieces: nothing (they stamp nothing). The bench town's fences are timber walls (whole cells) and it has no shutter: in
the default town only the ground's fill and the turned grids' stamps are partial. Before this item nothing used partial
coverage: the walk stopped a cell at half or more and passed the rest whole. `light-shots --walk-check` at the six default
cameras: 0 rays crossing a partly covered cell (`raw/B-ref-r{1,2}`).

**The rule** (default chosen, §9). What stops light today stops it whole: drawn bodies at half or more, props and stamps
joined at half or more, shut portals, the mips' stopping cells. So 47L.3's census stays 0, no solid gets leakier, and a
turned wall's stamp stays tight (its cells at half or more are what keep a 6-connected ray out of the staircase). Every other
cell a body covers in part keeps 1 − its coverage of the light crossing it: construction damaged under half (integrity
1–7), props' and stamps' cells under half (a prop's joined with a damaged cell's own share). The ground's cells over its
surface pass whole: their fill places the surface the walk already stops at (counted, every grazing ray over terrain would
darken). Coverage goes in fifteenths (`walkCoverStep`: 4 bits a cell on the GPU), the product along the ray, the cell it
starts in left out, spent under 1/256 (`WALK_SPENT`, under what the volume's words tell from none). Coarse levels: a mip
cell's coverage is its downsampled voxel's by the same rule; a parent of construction is intact (`downsampleMip`), so a coarse
cell half full of a damaged wall stops whole (tested); a ground parent takes the mean fill (passes as ground does). The hold
rule and the read use the stop bit only, so they are unchanged.

**Built** (9492710d; nothing stored, no derived step): the CPU walk (`occupancy-walk.ts`: `trans`, `WalkBlockView.partial`),
the views (`walk-sources.ts`), the page form (`walk-pages.ts`: a block holding such cells carries a cover in two page slots
beside its page, 16 brick words then 4 bits a cell, found by the table entry's fourth word; other blocks carry none), the WGSL
walk (`voxel-walk-wgsl.ts`), the volume's update (`volume_pass` for the sun, lamps and glows; `ray_radiance`'s sky, coarse
light and hit scaled by what the walk let on), its CPU reference, the GPU walk check comparing transmittance, and
`light-shots --walk-check`.

**Tests** (`voxel/occupancy-walk-partial.test.ts`, `three-adapter/voxel-walk-wgsl.test.ts`): a row at 20 % lets on 0.8,
three rows 0.512, a 70 % cell 0.333 (within a step of 0.3), a wall behind keeps what reached it; the start cell is the ray's
own, a spent ray ends with 0, the solid stop reads none; the packed table (the GPU's words) walks the views' transmittance on
400 rays (over 100 partial); props' cells under half keep the rest, at half they stop; a wall damaged at integrity 1…15 (real
derive): 1 − i/15 for 1–7 in equal steps of 1/15, stopped from 8 on; a coarse cell half full of a damaged wall stops whole.
Without the walk's multiply 5 of the 6 fail (the coarse guard passes, as it should). The WGSL test holds the twin's constants,
the cover's words and the update's products. 47L.3's census and 47L.5's smoothness test green; every light-volume and walk
test file green (19 files). **GPU = CPU** (`--walk-check`, 1,200 rays from each eye): 0 mismatches everywhere; rays with
transmittance under 1: 3 at `props-cart` (props), 5 and 1 at `room-window` and `room-window-2m` with the damaged patch.

**The clause that does not hold** (clause e, "no jump at one half" for a damaged wall): above, a damaged wall lets on
1 − i/15 up to integrity 7 and nothing from 8 (a jump of 0.53 at half). The derived light output cannot tell a damaged body
from ground at or past its surface (both drawn, coverage 128–254, both shape × 17), so passing damaged construction above half
while keeping the ground whole needs one more derived output (a bit a cell for bodies whose coverage is their integrity: a
derived version step in §3.7's light output) and a choice of what the hold rule does with such a cell (open, it holds light
and the read reaches through it). Options: (a) that step as its own item (a version step, the hold rule's choice, pictures);
(b) leave it: the owner's F4 ("light by integrity") then holds under half only. Not taken here (D818).

**Pictures** (low, WebGPU, 1280 × 720; `work/47L.6/shots/{before,after}/`, raw in `raw/`; A = 74f674e2 in its own worktree,
B = 9492710d; every shot settled in 3.5–13.4 s with nothing waiting). Opened and looked at:
- the default town (nothing partial): `street-noon`, `room-window`, `ref-30m`…`ref-150m` at B, two runs: white/green 0/0 at
  every camera in both (`raw/B-ref-r{1,2}`); `room-window` as before (D810's line as in 47L.5b).
- props (`--props 2`, `crops/props-table-full.png`, before above after): alike by eye; the floor under the table against its
  control (`propShade`) 1.47 (looking up 1.45) before, 0.95 (0.81) after, one run each, inside D727's earlier spread.
- a damaged wall: the room camera's west wall, cells x −10, y 1–5, z 2–4, set to integrity 5 through `editVoxels` and
  restored after (`crops/room-window-damaged5.png`: intact, before, after): drawn as a stage-3 hole; after, the room behind it
  a little darker (the volume takes two thirds of the outside's light there). **Still wrong**: the hole is drawn open and the
  sun's map lets the sun through it whole while the volume takes its integrity (F4 by design); above half a drawn-open hole
  passes nothing (D818).
- fences and shutters: none in the town gives partial coverage (fences are whole timber walls); not shown beyond the props
  and the damaged wall.
- turned grids (G45): not taken (the base run timed out at the grid settle); the stamps' notch cells under half now take their
  share: **unverified** in a picture (the rooms test holds a turned wall's read smooth, its mean over 0.6 of the unturned).
The world restored after each change: its 3,074 voxel files byte-equal (`world-before.sha1`, `world-after*.sha1`).

**Cost** (2026-11-25 10:50–11:20 UTC, low, WebGPU, 1280 × 720, 30 Hz cap, each run alone, A = 74f674e2, B = 9492710d, A B A
B, `--copies none --scales none`, second rounds; load 0.7–3.1; `work/47L.6/m/`, `scripts/summ2.py`):

| | GPU near (ms) | GPU lighting (6.67) | page ms a frame | page lighting (2.0) | room | missed |
|---|---|---|---|---|---|---|
| town A | 4.65 ±1.6, — | 5.36 ±2.1, — | 5.10, 5.80 | 0.87, 0.73 | 120, 120 | 0, 0 |
| town B | 5.53 ±1.4, 5.52 ±2.0 | 5.14 ±0.9, 5.93 ±3.2 | 5.28, 5.50 | 1.05, 0.95 | 120, 120 | 0, 0 |
| 128 lamps A | 9.62 ±0.4, 9.55 ±1.1 | 6.02 ±1.3, 6.68 ±3.1 | 5.89, 5.82 | 1.92, 2.06 | 56, 76 | 0, 1 |
| 128 lamps B | 8.33 ±2.5, 9.31 ±0.6 | 6.87 ±0.9, 7.50 ±3.2 | 5.83, 6.05 | 1.97, 2.17 | 56, 72 | 0, 1 |

—: A's second run's second round read nothing on the GPU (its first: near 4.90 ±3.1, lighting 4.59 ±0.6). A third 128-lamp
pair (12:52–13:05 UTC, load 1.1–1.4): A 6.92 ±1.6, B 8.17 ±2.7 (near 10.71, 9.86). The town's GPU lighting within the
spreads. The 128-lamp scene's read higher at B in all three pairs (+0.8, +0.8, +1.3 ms; spreads 0.9–3.2) and 7.3–8.9 in 47L.7's
three runs at B: not resolved by the rule, but every B reading sits over the 6.67 row and every A reading at or under 6.92.
**Open for the lead**: if that is taken as the walk's cost, the remedy is the tier setting of §10's question 2 (partly
covered cells off at low: the walk built without the cover branch, the CPU twin and the GPU check told the tier); not built. The default scenes have no partly covered cell, so what a walk adds there is a branch a step and
the entry's fourth word. The town's page lighting 0.15–0.2 ms higher at B in both rounds (inside 2.0; as in 47L.5, not
explained). Edit → light (`--cache-edits`, the room's window dug, one run each): first light 88 ms A, 84 ms B; settled 9.1 s
A, 11.2 s B (the night wall step was refused at both: the camera list lacked the night camera). No tier setting (§9).
**Gates**: `npm run build`, lint green; `gate-fast-20261125-113718` (build, lint, vitest 800 files, 26 e2e over core, voxel and
lighting) GREEN; its Play test's GPU walk = CPU walk check met 6 rays with transmittance under 1 and 0 mismatches; the Play
test 2.4 min (2.4 min at 74f674e2's gate). No expectation changed.
**Unverified:** nothing in motion; medium and high (same code); the turned grids' pictures; WebGL 2 (never runs the volume).

### 47L.7 — the 128-lamp scene: the room was a reading, not a regression

**What each reading was.** The "room" is `headroom`'s edge: the ballast copies the frame holds at the 30 Hz cap before a
window of 89 frames misses 2 % (a doubling, then halving search), times the ballast's measured ms a copy. Every second-round
reading of the 128-lamp orbit on disk (`work/*/m/{O-128-*,lamps-*}.json`, both phases): 46e.14c 96, 88, 104, 76; 46e.19 68,
68; 47a.0 88, **3**; 47a.9 88, 76, 96, 88; 47a.13 (6c1dec96) **15, 14**; 47L.1 80, 96, 76, 76; 47L.3 88, **7**, 68, 88; 47L.5
68, 68, 80, 76; 47L.6 56, 76, 56, 72, 60, 72. 46e–47a.13 ran with the copies search (`copies` and `scales` on), 47L.1–47L.6
with `--copies none --scales none`; the edge is searched before the copies in each round, so both measure the same thing.
So 47L.1's 76–96 were the same edge, and the room never went: three readings in nine runs fell to 3–15.
**Why 15 and 14** (`~/.cache/thirdlight-phase47a/work/47a.13/m/O-128-def-r{1,2}.json`, second rounds): the search held 4 and 8
copies, then missed at 16 — 2 of 89 frames in r1 (one 82.7 ms frame, a page spike with draw submit 12.8 ms), 2 of 89 in r2
(p95 37.9 ms) — and halved down to 15 (r1) and to 14 (r2, its 15 missing 3 with a 74.6 ms frame, draw submit 31.8 ms). 47a.0's
3 (4 copies: 3 missed, max 50.9 ms, p95 38.8) and 47L.3's 7 (8 copies: 2 missed, p95 38.2) are the same: a window's two or three
late frames, not the frame running out. D711 described it for first rounds; it reaches second rounds too.

**Now** (the head, built at 9492710d, `--lamps 128 --scales none` with the copies search, two rounds, each run alone, 12:00–12:24
UTC, load 1.1–2.5; `work/47L.7/m/copies-r{1,2,3}`): second rounds 64 × 0.129, 44 × 0.100, 44 × 0.126 (8.2, 4.4, 5.5 ms of
room); first rounds −1, 6, 4 (D711). Near copies 0–1, far copies 3–32. No GPU measurement failed (D806 not seen). The
second rounds' misses come from the doubling's next step (64 or 128 copies: 11–41 missed frames, max 58–99 ms): an edge, not a
spike. So the room is back near the 56–96 of 47L.1–47L.6 at about 44–64 copies: **no bisect** (clause i). Whether 46e.19's
68 and these 44–64 differ is inside the run-to-run spread seen here (44–76 at one commit in one hour).

**D740's near** (clause j; the same orbit, `--copies none --scales none`, second rounds, 12:25–12:52 UTC, head):

| read | near (ms) | GPU lighting |
|---|---|---|
| default (47L.6 B, 11:00–11:20; the copies runs 12:00–12:24) | 8.33 ±2.5, 9.31 ±0.6; 9.91 ±1.4, 9.54 ±3.8, 9.37 ±1.1 | 6.87, 7.50; 7.43, 8.88, 7.28 |
| `surfaceRead=level0` | 7.00 ±3.7, 8.18 ±2.6 | 6.88, 5.97 |
| `surfaceRead=index` | 6.75 ±2.3, 8.19 ±3.2 | 8.16, 6.07 |

D740's row has 481e0491 at 5.0–6.5 (default) and 5.5 (`level0`), 47a.0's head 7.95, 8.40 (default), 6.0 (`level0`), 7.8, 8.2
(`index`). So: level 0 alone still reads about 1 ms under the default (the coarse levels' read, as 47a.0 found; within the
spreads here), and `index` now reads with `level0` rather than with the default; the default itself reads 8.3–9.9 against
47a.0's 7.95–8.40 (different days; not an interleaved comparison). **Where it stands: the same in kind** (the coarse levels'
read costing about a millisecond on this scene), not resolved in size. No hunt beyond that (clause j). Not proven: that the
`level0` and `index` switches took effect in these runs (the near readings moved, the runs record no off-state reading).
**Unverified:** nothing in motion.

## 9. Decision log

- **2026-11-24 — the pass is placed and started on the owner's word** ("Write the lighting pass and get it
  started"): between 47a and 47b, named 47L; the item list above was not put to the owner first, by that
  instruction; the owner may reorder or cut at any time. 47a.12 (D741) is 47L.6: this is the owner's answer to
  question 1 of `acc47a` in substance (a lighting item before vegetation).
- **2026-11-24 — agents run in the foreground**, one at a time, never backgrounding a command: twice in 47a's
  close a background agent was cut by the chat server's 30-minute ceiling (cause of the difference unproven).
- **2026-11-24 — 47L.0: no regression from 47a, so no fix comes first.** The specks and the roof gaps are the same at
  760c2aa0, b5093d11 and the head on a clean world; 47L.1 and 47L.2 start from 46e-b's code paths (the volume's coarse
  read; level-1 roofs), not from 47a's commits. 760c2aa0 was shot although its build equals b5093d11's byte for byte.
- **2026-11-24 — lead's order: 47L.2 before 47L.1**, since many specks sit on faces only visible through the ridge gaps.
- **2026-11-24 — 47L.2: the roof gaps are fixed in the seam, not in level 1** (default chosen, owner to confirm): the
  level-1 roof stays a fine cell or two above level 0's (the mips' roof rule) and the seam joins the two slabs
  side to side; the alternative, laying level 1's roof on level 0's planes, changes every far roof and was not needed.

- **2026-11-24 — 47L.1: the surfaces' read as first built at every level, its cause not found** (lead's decision; default
  chosen, owner to confirm): the shipped read's form drew the specks while every value it computed tested sane; the
  written-out form draws none at the same cost on the orbit. `readFullM` and `readFaceFloor` had no reader left and were
  removed with their tier entries rather than left as dead knobs; the `allfaces` bench flag went with them.

- **2026-11-24 — 47L.3: the leak through walls fixed in the read, the stamp left as it is** (default chosen, owner to
  confirm): the census found no ray through a sealed turned wall or corner at any yaw, and every leak in what a surface
  reads: across a thin solid's edge-touching cells, and the coarse levels where level 0's weight is low (D746). A surface
  now reads only the cells on its own side and takes level 0 whole where it reads some light. Cost: turned walls show
  level 0's cells in blocks (D809), the GPU lighting row perhaps 0.3–0.7 ms higher on the town (not resolved). The
  turned openings' moved edges (D811) are the stamp's and stay.

- **2026-11-25 — 47L.4: the sun's direct light follows portal state, not the prop's model** (default chosen, owner to
  confirm): a shut opening that stops light casts the sun's shadow over its cells on the page, whatever its prop draws.
  A placed 0.1 m leaf already shaded the sun at the low tier (no strip was found once the scratch's leaf stood as
  authored), so what this changes is a shut prop with no model, holes or a thinner model: the sun now stops there as
  the light volume does. The alternative, leaving the sun to the model, keeps a door's look the model's alone but
  lets a bare or lattice prop shut the room's light and not its sun. The Scene view (no portal state) is left as is.

- **2026-11-25 — 47L.5: a cell holds light with a solid across a face or an edge** (default chosen, owner to confirm): the
  blocks on turned walls (D809) were the read reaching one column of a staircase's cells; holding light in the notch
  cells lets it reach all of them with the read unchanged. The update's rays go to 39–48 % more cells round a house; the
  GPU lighting reading did not resolve a cost. **D692 left for the owner**: the remaining blotches are the cells' own ray
  noise (low's settled history of 4 rays × 64 updates); the cheapest cure is a longer history on low (`historyUpdates` 64 →
  128, high's value: no cost a frame, twice the time to refine; stored spread 0.38 → 0.33 in the Node model), or more rays a
  face (a cost a frame): not changed here, under §10's question 1.

- **2026-11-25 — 47L.6: a light ray keeps what partly covered cells let on, and what stops light still stops it whole**
  (default chosen, owner to confirm): cells under half (construction damaged under half, props' and stamps' cells under
  half) keep 1 − their coverage in fifteenths; cells at half or more stop as before, so no solid gets leakier and the turned
  stamp stays tight; the ground's cells over its surface pass whole (its fill places a surface, not a share of the cell).
  Damaged construction above half still stops whole: passing it needs a derived step (D818). No tier setting: the cost was
  not resolved (the 128-lamp scene's GPU lighting read 0.8–1.3 ms higher at B in three pairs within spreads of 0.9–3.2 ms,
  every B reading over the 6.67 row): §10's question 2 stands, open for the lead.

## 10. Open questions for the owner (each with the default that stands if unanswered)

1. **Is a tier setting an acceptable cure for patchy light on the low tier** (more rays or a wider filter above
   low, the cheapest clean result at low)? Default: yes, with the pictures of each tier's result on the page.
2. **If partial cells (47L.6) do not fit the low tier's lighting row**, default: on from medium, off at low, as a
   tier setting.
