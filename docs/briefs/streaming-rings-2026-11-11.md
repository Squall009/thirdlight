# Streaming at speed and the ring layout — notes for the voxel session (2026-11-11)

From session thirdlight-65, worked through with the owner. Nothing in the repo was touched and nothing was
measured: numbers are from plan-46d, the format spec and the code as read at 1d3a9013; estimates say so. Yours to
place in the plan (a 46d-c, or the start of the next sub-phase) and to correct where the code disagrees.

## 1. Owner decisions (2026-11-11)

- **The 150 m/s test measures the wrong thing; replace its criterion.** Owner: "the more important thing during
  that test is that there are no large spike hiccups that would make player experience feel sluggish and second,
  how long does it take after stopping for the detail to fill in and settle around the camera." The count behind
  D598 and review finding H3 (full-detail data under a flying camera missing in 15–16 % of updates) is dropped as
  a pass criterion: at 150 m/s a 16 m chunk is left in a tenth of a second, so building it is wasted work that
  causes the hitches and slows the settle. The screen already holds (0 hole frames).
- **Fine bricks from a GPU compute build.** Owner: "I do think the gpu compute stage for brick generation at the
  0.5/1m level should be attempted for anything beyond the detail ring. Could save us a great deal in
  simplification and compute."
- **Deferred to a later stage, not now:** detail-piece LODs (the owner removed them on purpose, to keep the focus
  on the voxel stage); relief (the owner turned it off because it made about 8 M triangles and added too little
  in the example shots); GPU compute tessellation of the near mesh by distance. Do not revive any of them in
  this work.
- **Whole-map baking of near detail is off the table** (storage): estimated 2–6 GB compressed for the 8 km world
  against 644 MB of voxels, from 11–69 KB of derived data a chunk. The format rule "derived data is never
  stored" stays as it is.

## 2. The new measures for travel at speed

The coverage bench keeps its hole check and adds, per run:

| Measure | Starting target, low tier (to adjust after the first measured run) |
|---|---|
| Longest frame in flight; frames over 100 ms; missed frames a minute | longest under 100 ms |
| After a stop: seconds until the ground under the player is solid (collision ready) | under 0.5 s |
| After a stop: seconds until full detail stands round the player (about 50 m) | under 2 s |
| After a stop: seconds until the near ring and the far view have nothing pending | under 10 s |
| A body resting on or moving over ground falls through | never |

Today's runs give missed-frame counts but not the longest frame: add it. Mechanisms, in the order I would try them:

- **Build less at speed.** Above a speed, the near field asks for no level 0 (it is thrown away before it is
  seen); detail returns from the camera outward when the speed falls. `speedRing` narrows the ring today but
  still builds level 0 in it.
- **Drop stale work.** Queued loads, decodes and derives for chunks no longer wanted are cancelled when the
  focus has left them, or the settle pays for them (D584 saw the queue stay full in flight).
- **Collision on its own path.** Physics needs a surface, not meshes, navigation, light or pieces: a
  collision-only derive, asked for round the bodies that move and along their velocity, not round the camera.
- **A coarse floor everywhere.** The far field's 2 m data is resident wherever anything is drawn: a fallback
  collision surface from it means nothing falls through when the fine collision is late.
- **D585** (the camera inside a coarse far stand-in shows a grey grid, seen hugging the ground at speed) is the
  one visible fault at speed; it matters more than the dropped count.

For a game whose route is known (the owner's racing example), two generic engine features, the route itself
staying in the game: **pinned regions** ("keep this loaded": a track corridor is built during the loading
screen and held; about 2,500 chunks for 5 km × 64 m, which the 4 GB low budget plausibly holds; no disk cost)
and **path hints** ("I will be along here soon"). Neither exists today: the only prefetch is the one-second lead
along the camera's velocity (`stream-reads.ts`).

## 3. The rings today, and what stands out

| Ring (medium defaults; low scales level 0 and collision by 0.71) | Reach | Built from | On disk |
|---|---|---|---|
| Collision | 48 m | level-0 derive | no |
| Relief | 16 m | — | off on every tier |
| Detail pieces | the level-0 ring | level-0 derive | no |
| Level 0 mesh (0.5 m cells) | 0–64 m | voxels | no |
| Level 1 mesh (1 m) | 64–128 m | level-0 voxels downsampled at run time | no |
| Level 2 mesh (2 m) | 128–192 m | level-0 voxels downsampled at run time | no |
| Voxel load ring | 192 m, ±96 m | region files | the source (644 MB, 8 km world) |
| Far bricks (level 2 and up, by screen error) | near edge to horizon | far cache | 355 MB with baked bricks |

- The load ring holds full-detail voxels to 192 m only so levels 1 and 2 can be downsampled from them: about
  1,000 chunks a second at 60 m/s (D584). Most of it is never drawn at full detail.
- 2 m cells exist twice: near meshes at 128–192 m and the finest far bricks.
- Bricks stop at 2 m (`FAR_MIN_LEVEL = 2`), which is why buildings turned to blobs where bricks took over
  (D593) and why the level-1 ring had to be pushed back out to 128 m on low.
- What the owner sees in Enshrouded: detail meshes near; farther, the detail meshes go but 0.5 m voxels
  remain; then coarser approximations. Keen has not published where their bricks begin; my inference is that
  the 0.5 m band past the detail meshes is already bricks.

## 4. The proposed layout

| Band | Drawn as | Built |
|---|---|---|
| The detail ring (today's level-0 ring, about 64 m) | level 0 mesh + detail pieces, as now | workers, as now |
| Past it, while a 0.5 m or 1 m cell is worth its pixels | **bricks at levels 0 and 1** | **GPU compute, on demand, from the chunks' voxels; never stored** |
| Beyond | bricks at level 2 and up, as now | baked in the far cache, as now |
| Collision | its own path (§2) | |

What it would retire if the pictures and numbers hold: the level 1 and 2 mesh rings, their run-time downsample
and derive (D601's wasted collision/nav/light on mip nodes goes with them), the seams between mesh levels
(`lod-seam.ts`, `stream-seams.ts`), and one of the two 2 m representations. One representation from the detail
ring to the horizon, its resolution chosen by screen error and the feedback you built in 46d.20.

Points to settle when you design it (I have not):

- **Input.** A fine brick needs its chunk's voxels on the GPU. The near surface already uploads a 34³ × 2-byte
  grid a chunk (`voxel-surface.ts`); the brick build could read the same kind of grid, so a chunk past the
  detail ring costs a decode and an upload, no worker derive.
- **The build.** The bricks hold distance over ±2 cells, so a narrow-band search in a small neighbourhood per
  sample may be enough in compute; colour from the look palette and the baked occlusion in the same pass. The
  CPU job is the reference for what a brick must contain (`far-bricks-faces.ts`, `far-bricks-shade.ts`).
- **Same bricks from the same voxels.** Levels 0–1 would only ever be built on the GPU and levels 2+ only by
  the CPU builder (baked, or run for edits), so no level mixes two builders; the level 1 → 2 boundary gets the
  lip and skirt rule as any level change does. Say if that boundary shows.
- **Edits.** A fine brick is rebuilt from the edited chunk's grid at once, so an edit shows past the detail ring
  without the worker rebuild; the coarse levels keep 46d.18's path.
- **The load ring.** It can shrink toward the detail ring for worker-derived data, but fine bricks still need
  voxels out to where they are drawn: the saving is the derive and the downsample, not the read. Measure both.
- **Memory.** My estimate for level-0 bricks to 128 m is 20–40 MB of atlas (5–10 k bricks × 3.6 KB): inside
  low's 384 MiB far budget. Unmeasured.
- **Hand-off at the detail ring** uses the near cover you have; where detail pieces end the silhouette changes
  (no LODs by the owner's choice): look at it in the town.

**How to decide:** build it behind a switch beside the mesh rings and compare, on WebGPU, low and medium: the
D593 poses (the town's back row at 92–192 m) and the 46d.12b poses by picture; pass shares with the headroom
meter; fill time; the §2 measures at 60 and 150 m/s; memory. If it holds, the mesh rings and seams go (the
owner prefers one path); if a pose is worse, say which and why before retiring anything.

## 5. Also noted, lower priority

- Relief's ring and code stay off and untouched (owner, above); retiring the code is a later call.
- Storing a 1 m mip level beside the far cache (about 150–200 MB estimated for the 8 km world) was my earlier
  idea for the same problem; the compute bricks replace it. Keep it only as the fallback if the compute build
  does not pay.
