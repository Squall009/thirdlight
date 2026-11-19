# acc46e-b-interim — the lighting as it stands after the tuning (a look, not a stop)

Nothing here needs an answer; the run goes on (the glow mask, then props and particles, rooms, culling, the walk
graph). This page is so you can look at the lighting while it is fresh. The questions come with the closing page.

Every number is from `docs/plan-phase-46e.md` §8d ("46e.14c", the final table) on branch `phase-45`. **Low** = the
Iris Xe: 1280 × 720, WebGPU, capped at 30 Hz. Medium and high were run once each here and are **unverified on target
hardware**. Every picture is a still or a pair of stills: **nobody has yet watched any of this move.**

## What exists now

- **The voxel light volume is on at every tier** on WebGPU (`?voxelLight=off` turns it off for a comparison). The
  surface cache's voxel port and the hybrid are gone.
- **Every light type is in it:** point lamps, spots with their cone, rect and line area lights, and glowing voxel
  materials (your note of 2026-11-17; the mask in the ORM map's alpha, approved 2026-11-18, is being built now).
- **A day cycle works:** the volume follows a moving sun instead of starting over.
- **A removed lamp's light goes away** (it used to leave half behind), and the gable patches that came from that are gone.

## Low tier, at the cap: before the tuning and now

| | No store | Volume before the tuning | Volume now |
|---|---|---|---|
| Room left in the frame on a moving eye, town (load copies) | 176 | 30–88 | 120–128 |
| The same with 128 lamps | 152–176 | 36–64 | 76–104 |
| The same with 512 lamps | 176 | 28–30 | 88 |
| GPU lighting on a moving eye, ms (budget 6.67 with shadows) | — | 6.9–11.6 | 3.9–5.2 |
| The per-pixel read, ms (street / room / high view over the lit town) | — | +2.8–5.0 / +3.3–4.2 / +8.2–10.7 | +2.0–3.4 / +1.5–2.4 / +4.6–5.2 |
| Page lighting, ms (budget 2.0): town / 128 / 512 lamps | 0.1 / 0.5 / 0.9 | 0.9–1.5 / 1.3–2.1 / 2.1–2.9 | 0.9–1.0 / 1.8–1.9 / 2.6 |
| A moving sun, 20-minute day: the room's pixels changing a second | 0 | 2.7–7.6 %, never settled | 0.1–1.4 %, settled 0.8 s after the sun stops |
| A window dug into a room: first light / settled | — | 0.1 s / 3.7 s (town), 6.7–8.7 s (128 lamps) | 0.08 s / 8.1 s (town), 10.4 s (128 lamps) |
| A lamp switched off, 128 lamps: settled | — | 9.4 s | 6.0 s |
| Travel at 150 m/s, town: longest frame, ms; frames over 100 ms | 53.7, 77.2; 0 | — | 51.3, 56.1; 0 |
| The volume's memory (its own budget row, 36 MiB) | — | 35.5–35.9 MB | 36.5–36.8 MB |

It holds 30 Hz in every scene measured, with the volume taking about a third of the room the frame had.

## What it cost, and what is not right yet

- **Edits settle more slowly than before the tuning** (a dug window 8–13 s to fully settle; first light is still
  under 0.2 s). The update's share was cut from 6.0 to 3.5 ms to bring the measured GPU lighting inside its budget,
  because the update runs 1.1–1.7× over whatever it is given and nothing at the cap can see that (D690, open).
- **The per-pixel read did not reach the 1.5 ms I aimed for** and cannot per pixel: reading one cell costs what
  reading eight costs. Only a lower-rate screen pass would get under it; not built (D724).
- **Rooms are dark.** With auto-exposure the three-window room still reads about 8 of 255 (`4-room-and-sun/
  room-exposure.png`). No light was found to be lost; you decided against a minimum brightness. A lamp-lit room looks
  right (`1-cameras/cam-lamps-room.png`).
- **Blotches are less, not gone** (D692): look at the gables in `1-cameras/cam-lamps-street.png` — with many lamps the
  volume's bounce still mottles white walls. They calm over a minute of standing still.
- **Full refinement takes minutes.** Nothing reached "every brick refined" within 240 s.
- **512 lamps:** page lighting is over its 2.0 ms budget (2.6); most of that is the lamps' own per-pixel cost, which
  a scene pays with no store too.
- **With no store, a day cycle redraws the sun's cached shadow map several times a second** (D722, not fixed).
- **The leak test:** with the volume the editor page's memory comes back after Play; with the store off it grew
  1.5–2 MiB a Play for the first dozen in two runs and then held. Not traced (D725); the test now warms up first,
  which also hides that growth, so it stays an open row.
- **Missed frames at 150 m/s** are 9–17 a minute with and without the volume this week, against 1–5 a week ago on the
  phase base: the host's readings have been noisy (D654's kind) and this is not resolved.

## The pictures

- `1-cameras/`: eight cameras, each as three panels: no store | the volume before the tuning | the volume now.
  The five standing cameras and three in the 128-lamp town (street, a lamp-lit room, a high view).
- `2-light-types/`: every light type in one street shot; glowing materials at night and in the room (lava strip,
  crystal blocks: no lamp object lights those scenes).
- `3-edits/`: an edit in the light: before | first light | settled, and a glowing block placed.
- `4-room-and-sun/`: the room at fixed exposure and with auto-exposure; the room under a moving sun, two frames a
  second apart.

## What only you can judge (all of it in motion)

- The day moving over a room for a minute; a lamp switched off fading over about 6 s; the blotches calming while you
  stand; walking into a house (the read changes from eight cells to one past 24 m); the light refilling after fast
  travel.
- Whether the dark rooms are the look you want when a game has no lamps indoors.

Try it: Play a voxel world on staging; the volume is on. `?voxelLight=off` on the page's address shows the same
scene without it.
