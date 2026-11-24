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
| 47L.0 | not started |
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

## 9. Decision log

- **2026-11-24 — the pass is placed and started on the owner's word** ("Write the lighting pass and get it
  started"): between 47a and 47b, named 47L; the item list above was not put to the owner first, by that
  instruction; the owner may reorder or cut at any time. 47a.12 (D741) is 47L.6: this is the owner's answer to
  question 1 of `acc47a` in substance (a lighting item before vegetation).
- **2026-11-24 — agents run in the foreground**, one at a time, never backgrounding a command: twice in 47a's
  close a background agent was cut by the chat server's 30-minute ceiling (cause of the difference unproven).

## 10. Open questions for the owner (each with the default that stands if unanswered)

1. **Is a tier setting an acceptable cure for patchy light on the low tier** (more rays or a wider filter above
   low, the cheapest clean result at low)? Default: yes, with the pictures of each tier's result on the page.
2. **If partial cells (47L.6) do not fit the low tier's lighting row**, default: on from medium, off at low, as a
   tier setting.
