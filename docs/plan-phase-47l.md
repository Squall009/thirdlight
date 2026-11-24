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
| 47L.1 | not started |
| 47L.2 | not started |
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

## 10. Open questions for the owner (each with the default that stands if unanswered)

1. **Is a tier setting an acceptable cure for patchy light on the low tier** (more rays or a wider filter above
   low, the cheapest clean result at low)? Default: yes, with the pictures of each tier's result on the page.
2. **If partial cells (47L.6) do not fit the low tier's lighting row**, default: on from medium, off at low, as a
   tier setting.
