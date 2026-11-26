# acc46e-a — what you decide for 46e-a (the lighting storage)

46e-a gave voxel worlds shadows, and built two ways of storing soft light (sky light blocked by walls, bounce
light) on the same town so you can pick one. Until you pick, neither is on: a voxel world draws with shadows only.
Nothing was retired; 46e-b has not started.

Every number is from `docs/plan-phase-46e.md` (§8b the A/B, §8a the items) on branch `phase-45`; every picture was
opened and looked at before it went in. **Low** = the Iris Xe target: 1280 × 720, WebGPU, capped at 30 Hz. Medium and
high were run once each on this machine and are **unverified on target hardware**. Every picture is a still:
nothing here shows motion.

Words: **off** = shadows only (today's default). **Cache** = phase 42's surface cache ported to voxel surfaces
(light kept in texels on the surfaces, plus probes for bounce). **Volume** = the voxel light volume (light kept in
the air cells beside surfaces, six directions a cell). **Hybrid** = the cache's probes within 12 m of the eye, the
volume beyond.

## The recommendation, by "performance first": the volume

On a moving eye the volume is the only store that keeps the frame at the 30 Hz cap. It also uses the least memory,
answers an edit fastest, and travels at 150 m/s like no store at all. Its weak point is the cost of reading it per
pixel when nothing moves; that is the first thing to cut in 46e-b.

| Low tier, at the cap (median, range in brackets) | Off | Cache | Volume | Hybrid |
|---|---|---|---|---|
| Moving eye: room left in the frame (load copies held) | 136 [60–192] | 1 [−1–6]: none | 76 [60–88] | −1 [−1–3]: none |
| Moving eye: GPU lighting, ms (budget 6.67 with shadows) | no pass | 10.3 (one round of three resolved) | 6.0 [5.8–6.3] | 13.3 [13.2–13.4] |
| Moving eye: page lighting, ms (budget 2.0) | 0.16 | 2.7 [2.4–3.2] | 1.1 | 3.8 [2.9–4.0] |
| Standing still: near pass over off, ms, five cameras (the per-pixel read) | — | +1.2 to +3.3 | +3.2 to +5.3 | +3.7 to +7.2 |
| While light is being computed: GPU lighting, ms | — | 6.7–19.7 | 9.2–12.4 | 3.8–18.3 |
| Store memory | — | 3–22.5 MiB texels, 5.8–12.7 MiB probes, 25–68 MB hashes on the page | 29.8 MB GPU fixed, 8–12 MB page | the volume's, plus 0.3–11 MB texels and 4–8 MB hashes |
| A window dug into the room: first changed light / settled | — | 0.29–0.34 s / 2.5 s | 0.12–0.13 s / 1.7 s | 0.11 s / 4.7 s |
| Play start to light settled | 18.5 s (the scene alone) | 19 s | 19 s | 27–30 s |
| Travel at 150 m/s: longest frame, ms (two rounds) | 49.3, 52.5 | 77.1, 95.9 | 56.0, 46.9 | 46.4, 145.8 |
| Travel at 150 m/s: missed frames a minute | 6.4, 2.7 | 11.0, 11.0 | 6.4, 2.7 | 5.5, 7.3 |

How to read it:

- **The cache loses on a moving eye by design.** Its texel density follows the distance to the eye, so walking
  re-levels and relights tiles all the time: no room left at the cap, page lighting over its budget.
- **The volume's read is the largest single cost measured.** At the room camera: the volume's per-pixel read +4.1 ms,
  the cache's texel read +1.9 ms, the cache's probes +0.1–0.25 ms. Earlier "read off" numbers in the plan were wrong
  (the switch never reached Play, D698) and are marked invalid there.
- **Both overrun the GPU lighting budget while they compute** (after arriving somewhere or after an edit): neither is
  paced properly yet (D685, D690).
- **The hybrid is not quite what you described.** With both stores' per-pixel reads a voxel surface needs 17
  textures and the Iris Xe allows 16; the engine then draws it white
  (`5-hybrid-texel-read-white/`). So the hybrid measured here uses the cache's probes near the eye, not its texels,
  and lamps stay per pixel everywhere. As built it costs more than either store alone.
- **Not resolved:** on the moving eye, the near, far and shadow passes with the cache or hybrid on; the cache's GPU
  lighting in two of three rounds; the hybrid's 145.8 ms travel frame (one 133 ms gap with 14 ms of page work in
  it, cause not traced).
- **Fairness:** both stores got one round of wiring fixes and no tuning. The volume alone got one more fix after the
  A/B (a 200 ms frame at the start of a flight, D694); the travel rows above were measured again after it for all
  four.

## The pictures

- `1-side-by-side/`: one sheet a camera, five panels: before the phase | shadows only | cache | volume | hybrid.
- `2-full-size/<camera>/`: the same five, each at 1280 × 720.
- `3-edits/`: a window dug into the room's wall, a wall put between a lamp and a lit wall and taken away again;
  for each store: before | first changed light | settled.
- `4-arrival/`: the room 2 s and 10 s after arriving, for off, cache, volume, hybrid.
- `5-hybrid-texel-read-white/`: what the hybrid draws when the cache's texel read is forced on.
- `6-far-lamp-D607/`: a lamp on a far hillside from two cameras 60 m apart (the far field is now lit where the lamp
  is, not as if at the camera).
- `7-regions-overlay/`: the open-region tint (a room one colour, windows and doors marked).

What the five cameras show:

| Camera | Before | Shadows only | Cache | Volume | Hybrid |
|---|---|---|---|---|---|
| Street at noon | no shadow anywhere | houses and fences cast | dark window and door interiors, shade under eaves; a black sliver at the brick house's edge (D683) | the same look; the white gable mottled (D692) | the cache's look near, the volume's past 12 m; no seam seen |
| Room with windows | as bright as the street | floor a step darker | dim grey, lit near the windows, stairs dark | darker still, soft blotches round the windows (D692) | like the cache |
| Cave | as bright as outdoors | the tube shadowed | darkens inward; two black slits on a wall (D683) | darkens inward; hard-contrast steps; no slits | mixed |
| Night with lamps | lamp pools, no shadows, unlit fronts black | posts and rails cast | softer pools; the eave pieces' shadow missing (D679) | per-pixel pools with shadows, some bounce on the fronts | as the volume |
| Far view | no shadows | darker ground beside houses | near houses' openings black | darker patches on the near gables (D695) | the volume's patches past 12 m |

With either store a room reads 5–10 of 255 against the street's ~100: the bench runs with auto-exposure off, so
interiors look near black in these stills.

## The five questions

Answer **yes / no / change**. A default you leave stands.

1. **Which store?** **Default: the volume** for voxel worlds, switched on per tier in 46e-b.
2. **What happens to the other one?** The voxel port of the cache (charts, face hashes, the chart worker) and the
   hybrid switch exist only for this A/B. **Default: remove them at the start of 46e-b.** Phase 42's own stack is
   untouched and still retires in phase 48 with the old systems it lights.
3. **Do you want your hybrid (cache texels near, volume far) measured for real?** It needs about 50–100 lines to
   fit both reads in 16 textures, with no texture left over, then a re-measure. **Default: no**: the hybrid as built
   already costs more than either store alone on a moving eye, and the texel read would add about 1.9 ms on top.
4. **First work in 46e-b.** **Default:** before building anything else, cut the volume's per-pixel read (+3.2 to
   +5.3 ms standing still) and pace its update inside the lighting budget, with a cheaper read as the low tier's
   setting if it still does not fit.
5. **What this phase costs with no store at all.** Shadows and the sun's far shade are on by default: +0.5–0.6 ms of
   GPU, about +1 ms on the page thread, about 90 MB more streaming memory, and more missed frames at 150 m/s than
   the phase's base (4.6 and 3.7 a minute against 0.9 and 1.8; full detail 1–2 s later after a stop; D667, D675,
   D701). **Default: keep them on at every tier** and fix the travel cost in 46e-b's first item, alongside
   question 4.

## Before and after, low tier, no store (the default path)

| | Before (46e.0, 46e.1) | After (048f1f83) |
|---|---|---|
| GPU near / far / shadows, ms, moving eye | 1.61 / 3.49 / 0.09 | 1.80, 1.81 / 3.13, 3.50 / 0.60, 0.69 |
| GPU lighting budget row used (of 6.67 ms) | ≤ 0.2 | 0.60–0.69 |
| Room left in the frame | 176 copies (23.1 ms), both rounds | 176 copies in one round; 7 in the other (that round missed 8 of 89 frames with no load) |
| Page thread a frame, ms | 4.57, 4.13 | 6.32, 5.03 |
| Simulation a frame, ms | 2.05, 1.82 | 2.23, 1.88 |
| Page heap / GPU process, MiB | 594 / 936 | 611 / 923 |
| Voxel streaming memory at the cameras (of 768 MiB) | 47–98 MiB | 137–186 MiB |
| Edit to changed mesh / to changed shadow | 22–53 ms / no light changed | 30–59 ms / 61–93 ms |
| Phase gate | 30 min (46f) | 37 min |

## What only you can judge

- The look of each store, above all how dark a room should be.
- Anything in motion: flicker, the volume settling as you walk, the hand-over moving with the eye, the sun's near
  shade coming back after a fast flight (none of it was seen: stills only).
- Edits live: light follows a dug window in about 0.1–0.3 s and settles in 1.7 s (volume) or 2.5 s (cache).

Try it: Play any voxel world on staging and add `?voxelLight=volume` (or `cache`, `hybrid`, `off`) to the page's
address; the editor passes it to Play.
