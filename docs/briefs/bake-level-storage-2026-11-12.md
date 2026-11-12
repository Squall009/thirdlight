# What a brick bake level costs: disk and bake time (2026-11-12)

For the owner, after your decision of today (`bake-level-2026-11-12.md`): a voxel world's bricks baked to 2 m (today),
1 m or 0.5 m. Measured, not estimated: the existing fine-brick builder (the one the GPU build is checked against)
baked two 1 km² slices of the 8 km realistic world, stored exactly as the far cache stores bricks today. Details and
every number: `docs/plan-phase-46d.md` §8 "46d.26".

## A km² on disk and to bake

| a km² of | 2 m (today) | 1 m | 0.5 m |
|---|---|---|---|
| terrain (valley, slopes, a ridge): disk | 5.4 MB | 19.6 MB | 71 MB |
| town (the bench's dense houses): disk | 3.8 MB | 10.6 MB | 30 MB |
| terrain: bake, one CPU thread | 1 min | 5 min | 12 min |
| town: bake, one CPU thread | 1 min | 5 min | 11 min |

The bake runs on up to 4 threads in the backend, so a quarter of those times on this host.

| the whole 8 km world (67 km²) | 2 m | 1 m | 0.5 m |
|---|---|---|---|
| far cache on disk | 355 MB | 1.4 GB | 5.0 GB |
| bake time on 4 threads | 24 min | ~1.6 h | ~3.7 h |

For scale: the world's own voxels are 644 MB. A level adds to the ones above it (0.5 m stores 0.5 m, 1 m and 2 m).

## What each level buys

- **2 m:** what you have now. Past the detail ring the GPU builds 1 m and 0.5 m bricks while you play (WebGPU only),
  which needs the voxels held out to 192 m: that holding is what made medium settle late after a fast flight.
- **1 m:** 1 m bricks come from disk; only 0.5 m is built while playing, and only as far as 0.5 m is drawn
  (~78 m at low), so the voxels need to be held only that far.
- **0.5 m:** nothing is built while playing except where something was edited. The voxels are held only for the
  detail ring and collision. This is your low-tier plan (detail ring as now, baked 0.5 m pushed out).

## Cheap savings, measured

- Already in: nodes that are all air or all solid are not stored (83 % of the terrain's 0.5 m nodes), and only
  bricks that hold a surface are stored.
- **Not storing the brick shading (occlusion) and working it out when loading** halves the disk (0.5 m world 5.0 →
  2.9 GB) but costs ~7 ms of CPU a node on load, 70× the decode. Loading is your bottleneck, so it stays stored
  (default chosen; the format can drop it later without a change).
- Packing harder when exporting (zstd 19 instead of 3) saves another 20 %. Not built.
- Many bricks repeat (37–77 % are copies of another); sharing them would need a region-file change. Not built.

## Recommended default per kind of game

- **2 m** for a game played in a browser over the network, or a world edited a lot while playing.
- **1 m** for most packaged games: about 4× today's cache, the slow part of loading gone.
- **0.5 m** for a packaged desktop game on low-end hardware, which is your low-tier plan: about 14× today's cache
  for this world, and nothing left to build while playing.

The engine default stays 2 m (your instruction). Each scene's voxel world picks its own; when two scenes share one
world, the world is baked to the finer of the two.
