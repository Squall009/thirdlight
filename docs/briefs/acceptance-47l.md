# acc47l — phase 47L, the lighting pass: the close

Phase 47L is closed (2026-11-25) at items 47L.0 to 47L.8. It fixed what you saw and the worst leaks; it did
**not** make indirect light clean, it costs GPU time on the 128-lamp scene, and one fix was found and taken back.
47b is not begun.

Every picture is a still from a browser test on the low tier (WebGPU, 1280 × 720). **Nobody has watched any of it
move.** Pictures are named before/after; "above/below" in a name means before above, after below.

## Your five requirements

| | | |
|---|---|---|
| Was it phase 47a? (R-L5) | **No.** | Both artefacts are the same at 46e-b's close, at 47a's start and at its end, on a clean, settled world. No earlier camera looked at houses 45–150 m away. |
| Parts of houses missing (R-L4) | **Fixed in stills.** | Gaps along roof ridges where a full-detail chunk meets a 1 m chunk: the seam hung a flap through the roof. `ref-100m`, `ridges-100m`. Two slivers a few pixels long remain at 100 m (D804). The missing brick front in `water/02` was the bench's own lake dig. |
| White and green specks (R-L3) | **Gone with the temporal upscale; not without it.** | The per-pixel read of the light volume made them, not the stored light. 0 at five cameras, twice; 781 → 0 on turned houses. With the upscale off, black clusters remain on shaded walls (D808). The GPU-side cause was never found (D805). |
| Light through walls and doors (R-L1) | **Mostly fixed.** | Inside faces reading outdoor light: 373 / 5,022 / 5,725 points at 0° / 30° / 45° → 0. Bright corner lines in turned rooms gone (`room-45deg`). A shut door closes its whole opening however wide, stops light far away too, and blocks the sun by its state. Left: the line of sun at wall feet (below), a faint glow at a shut door's threshold, openings dug by hand in the ground grid (they take no door yet). |
| Patchy indirect light (R-L2) | **Partly.** | The rectangles on turned walls are gone (`room-45deg-wall-rectangles`). **The soft blotches on room floors and the street's white gable are unchanged** (D692): they are ray noise in the stored cells; doubling the low tier's history did not visibly help the room (`history-64-vs-128`). |

## The line where walls meet the floor: found, fixed, taken back

The dashed bright line in every room picture is **direct sun, not the light volume**: three.js draws back faces
into the shadow map, which leaves a one-pixel sliver of sun along every wall facing away from the sun
(`wallfoot-before-above-after-below`). Casting front faces removes it on WebGPU (444 line pixels → 8). I reverted
it because the WebGL 2 smoke test then fails its own bound (the lit wall comes out 1–2 of 255 darker and the
test's "most common colour" flips to grass). Question 1.

## What it costs (low tier, the 30 Hz cap; start of the phase against its end, built the same way)

| | start | end | |
|---|---|---|---|
| 128 lamps: GPU lighting ms (row 6.67) | 5.66, 5.86 | 7.05, 8.72, 7.86 | **over the row in every run, +2.0–3.1 ms** |
| 128 lamps: GPU near ms | 7.94, 8.17 | 9.36, 8.81, 8.85 | +0.7–0.9 |
| 128 lamps: page lighting ms (row 2.0) | 2.08, 2.27, 2.26 | 2.46, 2.45, 2.54 | over on both sides, +0.2–0.4 |
| town: GPU lighting ms | 5.53, 5.31, 5.72 | 5.68, 5.47, 6.58 | higher in 3 of 3, under the row |
| town: GPU near ms | 4.37, 4.58, 3.48 | 5.27, 6.03, 5.07 | +0.9–1.6 |
| town: page lighting ms | 0.91, 1.25, 0.86 | 1.33, 1.45, 1.33 | +0.2–0.5, under the row |
| frames missed at no load | 0–1 | 0–2 | |
| light after an edit settles in | 9.1 s | 11.2 s | one run each |

The phase made lighting slower everywhere it is read; on the town it still fits, on the 128-lamp scene it no
longer does. The largest single step was light through partly covered cells (+0.8–1.3 ms there). Memory is
unchanged. The "lost headroom" of 47a's end reading (15 copies) was a bad reading, not a regression (D711).

## What else changed

- **Light passes partly covered cells** (D741, 47a's unbuilt item): a cell under half coverage lets the rest
  through (three 20 % rows pass 51 %). **Only under half**: a damaged wall still jumps to "stops all" at half
  (D818), and nothing in the bench town is partial, so no fence or shutter could be shown: the one picture is a
  wall damaged by a command.
- **A shut door casts the sun's shadow over its opening whatever its model** (a behaviour change beyond the item:
  a barred gate that "stops light" casts a solid slab). Not in the Scene view, which runs no door state.
- The speck count is now one bench command, in the repo.

## The record, plainly

- **Gates.** The closing gate was red on seven tests; six are old rows (two fail alone at the start commit too),
  the seventh was my reverted fix. Through the phase a gate was red after its rerun at five code commits, each
  time on the same recurring set. Two of those are not load flakes but bounds set inside their own noise (D643,
  D659). A suite that is never green is not a gate: question 5.
- **The independent review** (linked): real fixes with tests that fail without them; three "done" rows
  overstated (corrected to what is written above); the GPU's light read is checked against its CPU twin by the
  program's text only, never by value (D819), which is exactly where D805 and D808 live.
- One finding of mine was wrong and corrected: 47a's "strip of sun inside a shut door" was the volume's faint
  glow and a test script's misplaced leaf; a placed leaf always blocked the sun.
- Unverified: anything in motion (specks or sparkle on a moving camera, the level boundary crossing a roof, a door
  flipping); medium and high tiers; WebGL 2 beyond its smoke test; turned rooms after the last two items.
- Rows opened D802–D823; fixed D744, D746, D791, D802, D809, D812, D741 (under half); narrowed D692, D773, D727.

## Five questions (a default you leave stands)

1. **The line of sun at wall feet (D810).** **Default: apply the shadow fix on WebGPU only** and leave WebGL 2 as
   it is (your rule: WebGPU is the target, no parity). The other way is to re-derive the WebGL 2 smoke test's
   bound, which touches a test to pass a change.
2. **The 128-lamp scene is over its lighting row by 0.4–2.0 ms.** **Default: partial cells off at the low tier,
   on from medium** (a tier setting, about 1 ms back), and the rest accepted as the price of walls that do not
   leak; a perf pass comes after 49 anyway.
3. **Blotchy indirect light (D692) and specks without the upscale (D808).** Neither is solved and the cheap
   cures did not work. **Default: accept both for now; one item at the start of the next lighting work builds a
   value test of the GPU's read against the CPU (D819) before anything else is tuned**, since every unexplained
   artefact of this phase sat in that gap.
4. **The sun following a door's state rather than its model.** **Default: keep it.**
5. **The gate.** **Default: build the quarantine lane before 47b**: tests with an open flake row run in their
   own lane and are counted into their row; the rest must be green, and a red there is never accepted on a
   rerun. D643's and D659's bounds are re-derived first.

Smaller defaults are in the plan's §9 (`docs/plan-phase-47l.md`).

## What comes next

47b (the world edit mode) has no plan. A fresh session writes it first and stops for your approval; questions 1,
2 and 5 become its first small items if their defaults stand.
