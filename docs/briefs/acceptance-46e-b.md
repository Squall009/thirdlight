# acc46e-b — phase 46e-b: the voxel light volume built out, rooms, culling, the walk graph

46e-b is built (items 46e.9–46e.18). The phase gate is green, an independent review said "close after fixes" and
its fixes are made. Phase 47a has not been started.

Every number is from `docs/plan-phase-46e.md` on branch `phase-45` (§8c, §8d, and "46e.19 — the end-of-phase
reading"). **Low** = the Iris Xe: 1280 × 720, WebGPU, capped at 30 Hz. Medium and high were run once each on this
machine and are **unverified on target hardware**. Every picture is a still: **nobody has watched any of it move.**

## What exists now that did not

- **Soft light for voxel worlds, on at every tier**: sky light blocked by walls and one store of bounce light (the
  voxel light volume). The surface cache's voxel port and the hybrid are removed.
- **Every light type bounces**: point lamps, spots within their cone, rect and line area lights.
- **Glowing voxel materials**: a material's Glow colour and strength now draw on voxel surfaces and light their
  surroundings; a mask in the alpha of the occlusion-roughness-metal map limits where the surface glows.
- **A day cycle**: the light follows a moving sun (it lags by about 5–10 s).
- **Props block the soft light** (they did not at all before) and lit particles are dark indoors.
- **Rooms**: `ctx.voxels.regionAt` says room / outdoors / doorway with a size for sound; `portalsOf` lists doors and
  windows. See-through works on voxel houses and there is a roof-off **cut-away** camera mode.
- **Paths**: `ctx.voxels.findPath` and `reach` on voxel worlds, budgeted so a script cannot stall the game.
- **Not built, by measurement**: connectivity culling. On the town it removes nothing the depth pyramid leaves.

## What you would notice

- Interiors and caves are dark instead of as bright as the street; lamps light a room properly
  (`7-end-of-phase/final-lamps-room.png`).
- Dig a window and light comes in within 0.1 s, settling over some seconds. Switch a lamp off and its light goes.
- A glowing block lights the things round it softly, with no lamp object.
- Start and stop Play quickly over a voxel world: the editor no longer leaks memory (a real leak, fixed).

## Low tier at the 30 Hz cap, moving eye over the town

| | No store | Volume, town (5 lamps) | Volume, 128 lamps | Before the tuning (town / 128) |
|---|---|---|---|---|
| Room left in the frame (load copies, about 0.13 ms each) | 176 ≈ 22 ms | 128 ≈ 17 ms | 68 ≈ 10 ms | 30–88 / 36–64 |
| GPU near surfaces, with the volume's read, ms | 1.9–2.1 | 4.8–5.1 | 8.4–9.2 | 4.4–5.3 / 8.0–9.1 |
| GPU far field, ms | 3.3–3.4 | 2.8–3.5 | 3.1–3.5 | — |
| GPU lighting update, ms (budget 6.67 with shadows) | — | 5.0–5.5 | 5.3–5.5 | 6.9–8.2 / 7.1–8.0 |
| Page thread, ms; of it lighting (budget 2.0) | 5.0–5.2; 0.07 | 5.8–6.9; 0.9–1.1 | 6.9; 1.9–2.0 | — |
| Simulation thread, ms | 2.0–2.5 | 2.1–2.6 | 2.1–2.3 | — |

- It holds 30 Hz in every scene measured, with 512 lamps too (88 copies at the tuning's end).
- **Worst sensible case** (128 lamps, glowing materials and 200 lit props together): 48 copies left, no missed
  frame at no load, but page lighting 6.0 ms against its 2.0 ms budget.
- Memory: every budget row within its limit (the volume 34.8–35.0 of 36 MiB, the walk graph 5–10 of 16 MiB).
- Travel at 150 m/s: longest frame 48.6 / 57.9 ms, none over 100 ms, nothing fell through; nothing pending 8.5–8.6 s
  after the stop.
- A moving sun, 20-minute day: the room's picture changes in 0.1–1.4 % of its pixels a second (before: 2.7–7.6 %,
  never settling).

## What is not right (the honest list)

- **Rooms are dark, and cut-away shows a black box** (`4-dark-rooms-and-cut-away/`). No light was found to be lost;
  with auto-exposure the three-window room still reads about 8 of 255 (question 3).
- **The 128-lamp scene got slower after the tuning** and the cause was not found: near +2.4 ms (two A B A B pairs)
  between the tuning's end and now, in the per-pixel read, though the read's code is the same (D740, open).
- **The per-pixel read costs about +2 ms** where 1.5 was the aim; per pixel it cannot go lower (D724).
- **Edits take 8–13.5 s to settle fully** (first light under 0.2 s): the price of keeping the update inside its GPU
  budget (question 4). Full refinement of a view takes minutes.
- **Blotches are less, not gone** (D692): white gables under many lamps (`final-lamps-street.png`); the room looks
  slightly blotchier again at the end of the phase (not resolved).
- **The walk graph** carries a walker up to 0.25 m radius only (D735: narrower than an ordinary humanoid), knows no
  doors or props, and nothing steers along its paths yet.
- **Moving lit props are costly** (1,000 with 50 moving: simulation 9–11 ms; D728); a prop thinner than half a cell
  blocks no light (D727).
- **The Play-stop leak's fix waits a measured 250 ms** for workers to end; the browser gives no signal, so a slower
  machine could bring it back (D729, watch).
- Smaller open rows: D690, D712, D716, D717, D718, D722, D730, D731, D733, D736, D737–D739 (audit list).
- Missed frames at 150 m/s read 9–19 a minute with and without the volume, against 1–5 on the phase base a week
  earlier: the host's readings have been noisy and this is not resolved.

## Five questions (a default you leave stands)

1. **Confirm two notes that reached me relayed** through your other session: (a) emissive approved with changes
   (2026-11-17); (b) the mask in the ORM map's alpha approved, and no minimum brightness indoors (2026-11-18).
   Default: they stand as recorded in `docs/decisions/owner-decisions.md`.
2. **The mask was built slightly differently from the text you approved.** The volume uses the mean of
   colour × mask (what is drawn), where the approved text said "the mask's mean". On the bench material the two
   differ by 0.28 %. And a sharp mask costs more file size than I told you: +18.7 % on the bench's 1024² crack mask
   (the proposal measured +3.4 % on a smoother one). GPU memory is unchanged. Default: keep it as built.
3. **Dark rooms under cut-away.** With the roof hidden the room is near black, because the hidden roof still blocks
   the light and you decided against a minimum brightness. Options: leave it (a game puts lamps indoors); or let the
   sky light in while a roof is cut away (the room is lit as if roofless, only while cut). Default: leave it.
4. **Faster edits or a lighter frame?** The update's share is 3.5 ms of GPU on low (lighting within its budget;
   edits settle in 8–13.5 s). At 6.0 ms edits settle about twice as fast and the lighting runs over its budget on a
   moving eye. Default: keep 3.5 ms.
5. **The cheaper read.** Getting the volume's read under 2 ms needs a lower-rate screen pass (not built). Default:
   leave it for the performance phase after 49; until then low pays about +2 ms a frame for the volume's read.

Everything else decided on the way is logged in the plan's §9 as "default chosen, owner to confirm" (tier values,
the many-lamps scene's mix, the walk graph's rules, cut-away as a camera mode, `regionAt` extended rather than a
new call).

## The pictures

- `1-cameras-before-and-now/`: eight cameras, each no store | the volume before the tuning | after the tuning.
- `2-light-types/`: a spot's bounce before and after its cone (1, 2), the area light's bounce and the blotch fix (3),
  glowing materials at night and in a room (4, 5), the glow mask (6), every type in one 128-lamp street (7).
- `3-edit-in-the-light/`: a dug window and a glowing block: before | first light | settled.
- `4-dark-rooms-and-cut-away/`: the room at fixed and auto exposure; a house from above: off | see-through |
  cut-away; the L-shaped room (its notch roof is cut too: D730); a lamp-lit room.
- `5-moving-sun/`: the room two frames a second apart, before and after the fix.
- `6-rooms-culling-walk/`: far rooms before and now; three walk paths drawn by the overlay; a lit particle panel
  indoors with the read on and off.
- `7-end-of-phase/`: the eight cameras as the phase ends.

## What only you can judge

All of it in motion: the day moving over a room; a lamp fading over about 6 s; blotches calming while you stand;
walking into a house with cut-away on (the roof fading at the door, the eave strips left behind); the read's change
past 24 m; a cart's shade following it; light refilling after fast travel. And whether dark interiors are the look
you want.

Try it: Play a voxel world on staging; the volume is on. `?voxelLight=off` on the page's address shows the same
scene without it; `?walk=1` and `?regions=1` on the voxel world page draw the walk graph and the regions.
