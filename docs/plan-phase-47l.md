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
| 47L.3 | not started |
| 47L.4 | not started |
| 47L.5 | not started |
| 47L.6 | not started |
| 47L.7 | not started |
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

## 10. Open questions for the owner (each with the default that stands if unanswered)

1. **Is a tier setting an acceptable cure for patchy light on the low tier** (more rays or a wider filter above
   low, the cheapest clean result at low)? Default: yes, with the pictures of each tier's result on the page.
2. **If partial cells (47L.6) do not fit the low tier's lighting row**, default: on from medium, off at low, as a
   tier setting.
