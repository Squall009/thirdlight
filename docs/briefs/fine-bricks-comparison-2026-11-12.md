# Past the detail ring: mesh rings, compute bricks or baked bricks — the final comparison (2026-11-13)

For the owner. One page; every number, run and picture is in `docs/plan-phase-46d.md` §8 "46d.26c" (earlier rounds:
"46d.25b-3", "46d.25c", "46d.26b"). Pictures: `~/.cache/thirdlight-phase46/work/46d.26c/shots/side-by-side/`.

## The three ways to draw the band past the detail ring

- **A — mesh rings** (today's default). The world is baked to 2 m. Past the detail ring the engine reads the voxels
  out to 192 m and builds coarser meshes from them while you play (levels 1 and 2, with seams between them). Works on
  WebGPU and WebGL 2.
- **B — compute bricks.** Still a 2 m world, but the band past the detail ring is drawn as 0.5 m and 1 m bricks that
  the GPU builds while you play (`fineBricks` on). Needs the voxels read out to 192 m as well. WebGPU only.
- **C — baked bricks.** The world is baked to 0.5 m (or 1 m) ahead of time (your bake-level setting). The bricks past
  the detail ring are read from disk and uploaded; nothing is built while playing, so the engine only reads voxels for
  the detail ring and collision. WebGPU draws them textured; WebGL 2 draws them in flat colours.

Same build, same hour, the Iris Xe alone on the host, 1280 × 720, low at its 30 Hz cap and medium at 60 Hz. Medium
numbers are this machine's: **unverified on target hardware**.

## Low tier (the Iris Xe floor)

| | A mesh rings | B compute bricks | C baked 0.5 m |
|---|---|---|---|
| full detail after a 60 m/s stop | 5.0–5.6 s | 6.1 s | **3.7–4.0 s** |
| full detail after a 150 m/s stop | 5.9–6.0 s | 6.7 s | **3.8–3.9 s** |
| nothing left loading (60 / 150 m/s) | 9.8–10.2 / 10.2–10.8 s | 6.7 / 6.7 s | **4.8 / 5.1–5.3 s** |
| longest frame in flight | 53–65 ms | 43–46 ms | 46–53 ms |
| missed frames a minute (60 / 150 m/s) | 8–11 / 10–15 | 4 / 11 | **3 / 5–9** |
| holes in the picture, falls through the ground | 0–1, none | 0, none | 0–1, none |
| memory at the town (page + GPU, of your 4 GB) | 1.5 GB | 1.6 GB | 1.8 GB |
| disk a km² (terrain / town) | 5.4 / 3.8 MB | the same | 71 / 30 MB |
| still frame room at 30 Hz | holds the cap | holds the cap | holds the cap |

## Medium tier (unverified on target hardware)

| | A | B | C |
|---|---|---|---|
| full detail after a 60 / 150 m/s stop | 16.7–19.9 / 22.7–over 30 s | 19.6 / 25.5 s | **11.8–13.5 / 11.6–12.4 s** |
| nothing left loading (60 / 150 m/s) | 21.6–23.4 / over 30 s | 23.5 / over 30 s | **13.8–15.5 / 23.5–25.9 s** |
| missed frames a minute (60 / 150 m/s) | 26–27 / 17–24 | 33 / 25 | 15–20 / 17–18 |
| holes after 150 m/s | 7–19 frames | 20 | **0–3** |
| memory at the town (page + GPU) | 2.0 GB | 2.1 GB | 2.5 GB |
| frame room at 60 Hz (still / moving) | 64 / 52 copies | — | 44 / 36 copies (~2.5 ms less) |

Baked bricks settle soonest in every cell, both rounds, both tiers. They pay in memory (+0.3 GB at low, the bricks'
atlas), in the far pass (~5 ms more GPU at low, still well inside 30 Hz; ~2.5 ms less room at medium) and in disk.

## Pictures, per pose (C against A)

| pose | low | medium |
|---|---|---|
| town-west, town-north, town-peak-4.5km | **better**: roofs past the ring are straight planes with clean edges where the rings show 0.5 m stair-stepped edges; fences show as outlines | better / same |
| town-street | **slightly worse**: roofs 70–100 m down the street have softer, rounder edges | same |
| near-border | **slightly worse**: the gully's rock outcrops rounder (D628) | same |
| near-valley | **slightly worse**: one short thin dark line across the gravel ~60–70 m out | same |
| near-river | **slightly worse**: faint dark dashes on the far river bed (~150 m) | same |
| near-boulders | **mixed**: the far slope's colours more natural, but thin dark contour lines on it (D631) | mixed, fainter |
| near-escarpment, near-outcrop, the three peak views | same | same |

The thin dark curves that floated over far roof ridges with fine bricks (D640) are **fixed**: the 2 m stand-ins were
still drawn just behind the edge of the detail ring and stuck out over the near roofs. Orbit and walk strips: no
shimmer or crawl; houses gain windows and kit pieces as they enter the detail ring, as with the mesh rings.

**B (compute)** looks like C everywhere except the town's back rows at low, where it draws 1 m bricks past ~78 m
(stepped roof edges again).

## 1 m against 0.5 m

On WebGPU a world baked to 1 m, with the 0.5 m band built by compute, looks the same as a 0.5 m bake (roof edges a hair
more stepped at low) and costs about a quarter of the disk (1 m: 19.6 MB a km² of terrain; the 8 km world 1.4 GB against
5.0 GB) and 40 % of the bake time. On WebGL 2 there is no compute, so a 1 m world draws 1 m bricks past ~78 m: roofs'
colour runs onto rounded walls, worse than 0.5 m and than the mesh rings. Baking a 6.55 km² piece of the world: the 1 m level took 11 minutes on 4 threads, the 0.5 m level 13 more.

## WebGL 2

A world baked to 0.5 m draws its fine bricks on WebGL 2 too, in flat colours (no textures): clean house shapes past the
detail ring, flat walls. A 2 m world keeps the mesh rings on WebGL 2 (without them it would draw 2 m blobs there).

## A baked world in an exported game

Measured on a 6.55 km² piece of the 8 km world (the town and the flight line's first 4.3 km), baked by the engine to
0.5 m and exported three ways, each played from a plain web folder with the editor stopped (low tier):

| | 2 m (mesh rings) | 1 m (+ 0.5 m by compute) | 0.5 m baked |
|---|---|---|---|
| the exported game on disk | 162 MB | 254 MB | 579 MB |
| extra a km² over a 2 m world | — | +14 MB | +64 MB |
| bake time for this piece (4 threads) | — | 11 min | 24 min |
| memory at the town (page + GPU, of 4 GB) | 0.86 GB | 0.90 GB | 0.93 GB |
| far field settled after a 60 / 150 m/s stop | 3.2 / 3.0–3.2 s | 0.8 / 1.0 s | 1.8–2.0 / 1.9–2.1 s |
| longest frame, frames over 100 ms | 40–52 ms, none | 42–47 ms, none | 42–58 ms, none |

Full detail after the stop could not be read in these exports: at the flight's stop point (next to the massif's
corner) no full-detail chunk came back in any of the three, mesh rings included (D641, open). Medium-tier runs gave
the same picture (far settled 2.9–3.1 s baked against 5.3 s with the rings).

## The < 2 s "full detail after a stop" target (low)

Baked bricks reach 3.7–4.0 s. What is left is the detail ring itself: after a stop the engine re-derives the ~90 chunks
low draws at full detail (about 6,600 section jobs); the bricks past it are done a second earlier. One cheap change
measured: **a detail ring of ~32 m instead of ~45 m at low gives 1.9–2.0 s** (half the jobs), but windows, frames and
fences then end ~13 m nearer (`town-west-low-C-vs-Cring05.png`: the middle houses lose them). Your call; the default
ring is unchanged.

## What retiring the mesh rings would remove, and what still needs them

Code only for the level-1/2 rings: ~2,800 lines in the voxel package (`stream-mips`, `stream-seams`, `lod-seam`,
`lod-select`, `stream-lod`, `mip-derive`), ~1,300 lines of bench tools, ~600 lines spread through shared files, ~1,300
lines of tests. Before any of it goes, the "detail ring only" mode needs its own small replacement for the part of
`stream-lod` / `lod-select` it still uses to pick the detail ring's chunks.

Still needing the mesh rings today:

1. **2 m worlds on WebGL 2**, and WebGPU devices without the features compute bricks need: without the rings they
   draw 2 m blobs past the detail ring.
2. **2 m worlds on WebGPU**: compute bricks (B) do not beat the mesh rings there (full detail 0.5–1 s later at low,
   up to ~3 s later at medium; same memory), so the rings are still the better 2 m path.
3. Worlds whose bake is not finished (the editor while it bakes) on WebGL 2.

## Recommendation (default chosen, for you to confirm)

**(ii), in this form:** make **baked 0.5 m the recommended setting for new worlds** shipped as packaged games (1 m
where disk matters and the game targets WebGPU), and **keep the mesh rings as the default for 2 m worlds** (WebGPU and
WebGL 2) instead of compute bricks, which did not beat them on a 2 m world. Retire nothing now; change no default
(`bakeLevel` stays 2 m, `fineBricks` off).

What stands in the way of **(iii) retiring the mesh rings**: a 2 m world would then have no good path on WebGL 2 (blobs)
nor a better one on WebGPU (B is slower to settle); a ring-free answer for 2 m worlds needs either a CPU build of the
same fine bricks in workers for WebGL 2 or requiring a 0.5 m bake for every world (disk: ~14× today's far cache);
the detail-ring-only mode's replacement for `stream-lod`/`lod-select`; the open look rows (D628 rocks, D631 contour
lines, the gravel and river-bed lines); and medium on real hardware.
