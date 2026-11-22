# acc47a-1 — 47a.1: rotated buildings on their own grids, measured (a short page; no stop)

47a.1 is done (2026-11-22). It measured the town three ways before anything of structures was designed in: every
house in the world grid (the control), and each of the 131 houses in its own 0.5 m grid at 0°, 30° and 45°. Low tier
(Iris Xe), WebGPU, 1280 × 720, the 30 Hz cap. Everything is a still: **nobody has watched any of it move.** Full
numbers: `docs/plan-phase-47a.md` §8a ("47a.1a" to "47a.1d"), decisions in §9.

**Nothing here needs your answer.** It tells you what the measurement decided, under the defaults you accepted, and
what it costs you. If something here is not what you want, say so and it changes at the next item.

## The answer in one line

**One grid per building stands.** Turning a building costs nothing measurable; having many grids was unaffordable
as first built and is now close to the control, except the simulation thread, which is still about twice the
control's on a moving camera.

## What exists now

- A world holds any number of structure grids (stored as you approved in F2: one small region file a house, a grid
  list in the world's manifest). In Play each is placed by a position and a yaw, drawn with its kit pieces and
  shadows, and solid: a character stops at a turned wall and walks through a turned door.
- Soft light, sun shade and rooms see turned buildings; paths go into them and round them; the far view shows them.
- **Not yet** (47a.5): editing a building's voxels, script reads and rays into a building, the Scene view, exports,
  and placements coming from structure objects instead of a bench switch.

## The numbers (town orbit, 131 houses)

| | All houses in the world grid | Own grids, first build | Own grids, now (0° / 30° / 45°) |
|---|---|---|---|
| Room left in the frame (load copies) | 128 | none | 128 / 128 / 120 |
| Page thread, ms a frame | 5.85 | 15.0 | 6.76 / 7.04 / 6.11 |
| Simulation thread, ms a frame | 2.15 | 135 | 3.98 / 4.36 / 4.05 |
| Kit-piece draws | 49 | over 1,000 | 50–52 |
| Travel at 150 m/s: longest frame; settle after the stop | 71.5 ms; 9.6 s | — | 64.5 ms; 10.6 s (30°) |

## Three decisions the measurement made

1. **Soft light, sun shade and rooms of a turned building come from a stamp of it in the world grid** (your
   accepted default on question 2). Exact stepping would cost 2.3–4.2 times the light's ray walk and a second loop on
   the GPU; it was not built there.
   - No light leaks through a closed turned wall (at most 7 of 24,000 rays); no room was lost in 24 houses.
   - **The price:** a door or window turned 30°–45° lets 12–18 % less light through than drawn, and what the light
     sees can be up to 0.5 m off what is drawn. At 45° a room shows two thin bright lines at its inner corners
     (D746). Pictures 3: the control's room and the 45° room.
2. **Paths use a walk graph a building, linked to the world's at doorsteps** (the owner requirement R40's own
   words). The cheaper way, one graph built from the stamp, **loses turned staircases**: 4 of 17 upper storeys at
   30° and 7 of 17 at 45° could not be reached. With a graph a building every room and every upper storey is reached
   at 0°, 30° and 45°, and no path touches a wall. Cost: about 3 MB of the 16 MiB path budget for the town, no
   measurable frame cost.
3. **The far view shows buildings by resampling them into the far cache when it is baked** (no format change).
   Before, a town of own-grid houses vanished past about 190 m (picture 4, 600 m before); now it looks like the
   control's at 250 m, 600 m and 2 km. Bake time +9 ms a house, files +0.2–0.6 %.

## What is not right (the honest list)

- **Simulation about 2× the control** with many grids on a moving camera (1.35× standing still): each grid's own
  update, and one shared job queue that fills while a world loads, so the ground's full detail arrives after the
  houses' work (D743, D745). Carried into 47a.5.
- **Specks on some roof eaves** of own-grid houses at 60 m: fewer since the stamp, not gone (D744; picture 2).
- **One building's light stamp is sampled in one piece**: up to 35 ms once, when a building arrives (D747).
- **A far-cache building is as old as its last bake**: when a structure moves, its far chunks must be rebuilt by the
  command that moves it (47a.5 does this; proving a cache matches would need a stored field, which I have not
  proposed).
- Path queries for walkers of another height, and `reach`, still search the world's graph only (D748).
- **Unverified:** anything in motion (the change from crisp to far bricks at about 190 m, a door at 45° in
  daylight); a turned house on a slope; how fast light follows an edit inside a building in the browser; medium and
  high tiers; a world baked to 0.5 m with turned houses in its far bricks.
- Host readings: one export test in the gate failed three times with an environment error and passed on rerun each
  time; the readings of 47a.0 that differed from 46e-b's (page time at 128 lamps) are still unexplained.

## Your open question (the `pieces` list)

You asked whether a structure is defined by simple shapes that dictate the fill, as in Enshrouded. I answered that
the plan is an outline with numbers plus a per-cell record of hand edits, and offered an optional add-only `pieces`
list on F1 (boxes that add or cut, replayed after the outline). **No answer has come, so the stated default
applies: 47a.3 is built as proposed, without the piece list.** It stays an add-only step: saying "add pieces" later
costs a list on the record and a tool in the structure mode, and changes nothing built before.

## The pictures

- `1-street-*`: the street with houses in the world grid, and with each house in its own grid at 45°.
- `2-town-own-grids-30deg-from-above`: the 30° town on its ground (before the stamp: lit windows, eave specks).
- `3-room-*`: a room in the control and in a 45° house with the stamped light.
- `4-far-*`: the town from 600 m before and after the houses went into the far cache, and from 250 m after.
