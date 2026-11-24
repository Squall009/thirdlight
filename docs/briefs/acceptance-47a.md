# acc47a — phase 47a, structures and water bodies: the close

Phase 47a is closed (2026-11-24) at items 47a.0 to 47a.11 and the close 47a.13. **47a.12 (light through partly
covered cells, D741) was not built**: it was the item agreed to be cut first if the phase ran long, and it did
(question 1). 47b is not begun.

Every picture is a still from the real editor or from Play, taken by a browser test on WebGPU. **Nobody has
watched any of it move, and nobody has used the tools by hand.** The earlier page `acc47a-interim` covers making
and editing a building (pictures 01–12 there); this page adds what came after it.

## What exists that did not

1. **Buildings as scene objects** (interim page): footprint, wings, storeys, roof, a material a part, hand edits
   kept as overrides, each building in its own grid, turned freely; drawn, solid, lit, in rooms, paths and the far
   view; exports ship voxels, never definitions.
2. **Doors and windows** (`doors/`): the structure mode places openings on a wall and fits a prop (leaf, pane,
   shutter) by size. A prop's `open` state closes its portal exactly: shut, the room's light falls to 0.06 of open
   and walkers are refused unless they ask for shut doors; glass passes light. A script sets it; saves keep it.
3. **Paths that know buildings**: a walker has a width (default 0.3 m radius), passes a 1 m door at 0.4 m and is
   refused a 0.5 m gap; a path crosses from the ground into a turned house and up its stairs (131 of 131 houses at
   30°).
4. **Water you can see** (`water/01–07`): liquid voxels are drawn, flat and in the material's colour, inside the
   detail ring; editing water no longer rebuilds the ground round it.
5. **Water bodies** (`bodies/20–28`): an object with a level, a liquid and a reach. Dig the bank back and the
   shore follows in the same undo step (`21` → `22`); raise or lower the level with a handle; a leak is flagged
   with a warning and a red mark and nothing spills (`26`).
6. **Roads, paths and rivers on splines** (`splines/40–45`): a spline with a `voxels` section writes its course
   into the ground with bed, shoulders and cleared air; move a point and the old cut is gone and the ground is
   back (`40` → `41`); a river reaching a lake joins it at the lake's level (`43`); a dig on a road survives a
   widening (`44a`, `44b`).

## What you would notice in the editor

- GameObject → Structure and the full-screen structure mode, now with an **Openings** tool.
- "+ Add component → Water body": level, liquid and reach in the Inspector, a level handle in the Scene view.
- A spline's Inspector has a voxels section (road, path or river).
- **Flipping a door's `open` does not move the leaf**: the engine has no door behaviour; a game swings or hides it.
- Dig next to a lake and the water follows at once; cut through its last bank and **the whole lake drains** with a
  warning (question 2).

## What is not right

- **Looks**: water is one flat colour and past the detail ring a lake's bed shows dry; road and river edges are a
  saw of half-metre steps on diagonals (D790); a gable on an L or a wing is wrong (D752); roof edges are
  staircases without kit pieces.
- **Editor**: no stairs tool in the structure mode (D775); the prop picker offers models, not prefabs (D776);
  handles draw and grab through walls (D764); a spline's voxel fields show twice in the Inspector (D793); the
  spline's "left alone" and misfit marks were never seen in a picture or test (D794); a breach mark can lie outside
  the view (D801); pressing undo and redo quickly can be refused as a conflict (D788, D774: the phase's own test
  fails about one run in four).
- **Limits found by the review**: a shut door only closes an opening up to 4 m either side of its prop (D791); a
  path through one building tries at most three doors (D795); a door's "stops sight" is stored and read by nothing
  (D792, question 4).
- **Light**: turned doors and windows pass 12–18 % less light; corner lines at 45° (D746); eave specks (D744);
  coarse light past the detail ring does not see a shut door (D773).
- **Unverified by anyone**: anything in motion; a house on a slope; medium and high tiers; WebGL 2 beyond its
  smoke test; a 1 m door in the browser; stairs at 45°; the Add tool in a browser; a turned house in the far
  bricks of a world baked to 0.5 m; a 250 m lake and a long road dragged in a browser (their times below are the
  backend's); water round a turned building; water or a road drawn in an export.

## Measured, low tier (WebGPU, 1280 × 720, the 30 Hz cap)

The end-of-phase reading repeats 47a.0's baseline on the town, which uses none of the phase's features: it says
what the phase cost a world without them (plan §8a "47a.13", all rows there).

| | 47a end | 47a.0 | 46e.19 |
|---|---|---|---|
| town, default: page ms a frame | 5.77, 7.20 | 7.40, 6.71 | 5.83, 6.85 |
| town, default: GPU near ms | 4.45, 4.57 | 3.47, 3.63 | 5.07, 4.77 |
| 128 lamps: page ms a frame | 7.56, 7.35 | 8.95, 8.73 | 6.90, 6.86 |
| 128 lamps: GPU near ms | 9.83, 8.41 | 7.70, 6.55 | 8.42, 9.24 |
| 128 lamps: orbit room (copies) | 15, 14 | not usable | 68, 68 |
| page heap, town default MiB (budget 1,536) | 724, 666 | 603, 563 | 571, 607 |
| travel at 150 m/s: longest frame ms; missed a minute | 59.1; 13.7 | 60.4; 18.3 | 48.6, 57.9; 16.5, 11.0 |

Frames missed at no load: 0 in every run. **The 128-lamp scene has lost most of its room** (15 copies against 68
at 46e.19) and its near GPU cost is +2 ms against 47a.0; neither is traced (D740 is the same scene). Page heap at
the town is up 60–160 MiB. Memory budgets are met; the GPU lighting row (6.67 ms) is missed in one 128-lamp run.

Where the phase's features are used (from each item's own runs):

| | cost |
|---|---|
| many buildings on a moving camera, against the same houses in the world grid | simulation 1.4–1.5× (aim 1.3×, D743); one 224 ms simulation frame crossing a town at 150 m/s |
| walk graph on the town | 18.0 MB against a 16 MiB row (D778) |
| a door flipped | light follows in 0.7–1.7 s; 100 doors at once is one 14–16 ms step |
| a bank dab on a 251 m lake | 7–23 ms; 611 ms for the first dab after an undo (D787); 620–730 ms when queued behind another command's far rebuild (D786) |
| a 251 m lake filled whole | 1.4 s |
| one spline point moved | 0.4 s at 250 m, 1.0 s at 1 km, 1.7 s at 2 km (D789) |
| every command, once a project holds a structure, body or voxel spline | +8 ms (D797) |

Never explained: 47a.0's page time at 128 lamps; the "first round after Play start" low headroom (D711); D740.

## The close

- **Phase gate** once, from b5093d11: green in 37 min (36 for 46e-b's); four tests failed once under load and
  passed alone (D419, D659, and two now rowed: D798 watch, D799 open). Watch rows opened in the phase: D760, D768,
  D777, D785, D798, D801.
- **Independent review** (linked on this page): nothing blocks the close; 16 findings. Fixed: the grid id maximum
  defined five times; requirement ids in comments; **a refused structure, spline or water command left a connected
  editor a revision behind, so its next command and undo were refused** (D800, proven by a test and fixed). Rowed:
  D791–D799, D801. Clean: only what F1–F7 name is stored, exports carry no definitions or records, one fit rule,
  one mutation path, no ratchet grew, nothing added inside the retiring systems.
- The bench's 131-house town uses the bench's own house pattern, not the package's generator: the town numbers
  measure those houses.

## Two session stops, and why

The closing agent was stopped twice with its work unfinished (nothing was lost; it was resumed, and the last
write-up ran in the foreground). Both stops were an interrupt at an exact multiple of 30 minutes after the lead's
turn ended: the chat server's 30-minute background-wait ceiling. The two long item agents before it ran over two
hours in the same process without being cut. What differed is not proven; the server logs nothing about the
timer. See the lead's summary for what would settle it.

## Five questions (a default you leave stands)

1. **47a.12, light through partly covered cells (D741).** Not built. **Default: it moves to a lighting item
   before vegetation**, where trees and shutters make it matter; the plan's §9 and the register record it.
2. **Water bodies' behaviour beyond F6's text.** A breached body is **drained whole** (no wall of water, but one
   slip at the far shore empties a lake until the gap is closed; refilling a 250 m lake takes 1.4 s); deleting a
   body clears its water; a lake treats a river's channel as ground, so it cannot spill into a lower river.
   **Default: all three stand** and F6's text is extended to say so.
3. **Splines beyond F5's text.** A spline writes into the scene's one voxel world (none or two is refused; nothing
   stored names the world); a path is written like a road; an open river end stops square; there is no
   "regenerate all" for splines; F5's size estimate becomes about 1.3 MB a km of 6 m road. **Default: all stand.**
4. **A door's "stops sight" (D792).** Stored, shown in the Inspector, reported to scripts, read by nothing in the
   engine. **Default: keep it as stored data a game reads; the engine's own use waits for see-through's next
   pass.**
5. **The six decisions of `acc47a-interim`** (the fit rule D751, cross gables D752, F2's sentence D753, a stored
   key a grid D756, a stale far view D759, a material-only paint D762) and the `pieces` list question are still
   yours; none was built. **Default: they stay unbuilt and are asked again with 47b's plan.**

About 70 smaller "default chosen, owner to confirm" entries are in the plan's §9; questions 2 and 3 carry the
ones that touch approved entry text.

## What comes next

47b (the world edit mode, the fill as a brush stroke, fog, dressing, scatter) has no plan yet and is not begun.
A fresh session writes its plan first and stops for your approval. `voxel-world.e2e.ts` (1,990 lines) and
`voxel-worlds.ts` (1,910) must be split before 47b adds to them.
