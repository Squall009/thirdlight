# Brick bake level per scene, and the low tier's layout — notes for the voxel session (2026-11-12)

From session thirdlight-65, worked through with the owner after reading 46d.24 and 46d.25's results (plan-46d at
1a0d90c1). Nothing in the repo was touched and nothing was measured by me; estimates say so. Yours to place.

## 1. Owner decision (2026-11-12)

Owner: "brick compute and storage should be tunable per scene. Just select how fine grained scene gets baked
with 2m being default but you can change it to one or 0.5 and have it all cached. At any level chosen the
runtime brick compute is based on that so no realtime needed if 0.5 is selected or only 0.5 if 1 is selected."

And for the low tier: "At 720p30hz we have a lot of frame time available but the streaming and load speed are
the current bottlenecks. If we keep the current detail zone on low, bake down to 0.5m we can cut out the
additional detail voxels that are going so far out and use the precomputed 0.5 pushed out to keep the detail
reasonable."

- **A bake level per voxel world** (so per scene that holds it): 2 m (today's far cache, the default), 1 m or
  0.5 m. Levels at or above the bake level come from the cache; only levels finer than it are built at run time
  by 46d.25's compute build. Baked to 0.5 m, nothing is built at run time except edited places.
- The setting is the game's choice of disk against load speed. A later export option may override it per build
  (the owner's earlier thought: compute for a game hosted on the web, baked for a packaged desktop install);
  not needed now.

## 2. Why, from your own numbers

- 46d.24 removed the hitches (low 150 m/s: longest frame 152–208 → 40–44 ms, 0 over 100 ms, ground 0.03 s, never
  through). What is left is settle and load.
- 46d.25's compute bricks met the detail target at low 60 m/s (1.35–1.43 s) but: medium settles later and did
  not settle in 30 s after 150 m/s (D632: ~750 fine nodes through 4 build slots); the frame is about neutral at
  low and +3 ms at medium (near shrinks, far grows); and **the load ring's work did not fall**: the reads are the
  same 877, the downsample still runs for the whole ring (D633), because fine bricks built on demand need the
  voxels out to where they are drawn.
- A bake removes the build and, with it, the reason to hold voxels past the detail ring. That is the saving the
  compute path could not reach.

## 3. The low tier's target layout

| Band | Drawn as | Needs at run time |
|---|---|---|
| The detail ring as it is today on low | level 0 mesh, detail pieces, collision | voxels read, derived |
| Past it | baked level-0 (0.5 m) bricks, held farther than the 8 px error gives today | a cache read and an upload |
| Beyond | level 1, 2 and coarser bricks by screen error | the same |

- **The voxel read ring shrinks to what the detail ring and collision need** when the world is baked to the
  level drawn past it. That is where the win is: measure loads, downsample jobs, queue depth, fill, and
  46d.24's settle measures before and after (the 150 m/s full-detail time, 5.7–6.4 s with compute bricks, is the
  one I would expect to move most).
- **Spend low's spare frame time on reach.** Low loses windows and fences where it drops to level 1 at ~78 m
  (D629). With baked level 0 the cost of holding 0.5 m farther is march time and atlas memory, no build: set
  the reach with the headroom meter (the far pass read 4.8 ms at low with fine bricks on), e.g. D629's
  construction-weighted error or a lower error for the fine levels.
- Medium and high: same mechanism; their reach unverified on target hardware.

## 4. Things to settle

- **Storage, measured first.** Bake a slice (say 1 km² with the town in it) at 1 m and at 0.5 m and
  extrapolate. My estimates for the 8 km world (about 1.3 GB at 1 m, 4–5 GB at 0.5 m, from the 2 m cache's
  ~300 MB of bricks × 4 a level) predate textured bricks keeping their look words: expect more. Report bytes a
  km² for terrain and for town, so a game can choose.
- **One builder.** 46d.25a's test has the GPU build byte-equal to the CPU build of the same block; the bake of
  levels 0–1 must stay that builder (roof planes of 25b-2 included), so a baked node and a node rebuilt after
  an edit do not differ. Edited nodes rebuild at run time by the compute build (WebGPU) and are kept beside the
  save as 46d.18 designed for the coarse levels.
- **The pictures are a builder problem, not a bake problem.** D628 (rock outcrops rounded), D629 (thick eaves
  at level 1), D631 (streaks, the dashed line) stay whether bricks are baked or computed. An offline bake can
  afford a slower, more exact build (more samples, the mesher's creases) if byte-equality with the run-time
  build is given up for baked-only nodes: say which you choose and why. The mesh rings stay behind the switch
  until the D593 and 46d.12b poses match; today they still look better at low.
- **WebGL 2.** Marching baked bricks needs no compute, so on a world baked to 0.5 m the fallback could draw
  fine bricks too and the mesh rings would have no user left. On a world left at 2 m the fallback has no fine
  build: either it keeps the mesh rings or it draws 2 m bricks past the detail ring. Owner's call when you have
  pictures; do not delete the rings on this ground alone.
- **Bake time and the editor.** The 2 m cache took 1,421 s for the 8 km world; 0.5 m is 16× the nodes. Bake by
  region, resumable, edited regions only; the editor keeps working on compute bricks while a bake is stale.
- **Format.** A far cache version bump (add-only, owner note), the world's bake level in its record, and the
  export shipping what the level says.
- **Streaming the cache.** A hosted export reads region and cache files over HTTP: fine bricks entering view
  at walking pace are small, at 150 m/s large (my estimate 2–3 MB/s for the 0.5 m band). 46d.24's "no fine
  detail at speed" rule should cover brick reads as it covers level 0.
