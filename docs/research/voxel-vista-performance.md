# Voxel vista performance — research note (2026-11-10)

A review of the voxel branch's near and far pipelines, what Keen Games has published about Enshrouded, and a
proposed order of work. Written by a session that did not build 46d. **Not a plan and not authoritative:** the
phase plan decides what is built. Nothing here was measured anew; numbers are quoted from
`docs/plan-phase-46d.md` or derived from reading code. **§6 (same day) supersedes parts of §3 and §4:** WebGPU
first, steps 1–4 on compute, upscaling.

**Reviewed at:** commit 47cfbde4 plus the then-uncommitted far-field work (since landed as 3dff0720, 7a27b8a9;
46d.13c-3 closed D550, D551, D557, D573). Findings about selection, commits, uploads and atlas memory must be
re-checked against 511ae441 or later before they are acted on; they are marked *(re-check)*.

**Owner 2026-11-10:** the goal is an order of magnitude over today with fidelity kept or improved, leaving room
on the Iris Xe at 720p30 for detail, foliage, weather and volumetric fog at low quality. Steps 1–4 of §4 are
wanted in the phase now being worked on.

## 1. Where the cost is today

**The frame holds the cap; the headroom is unknown.** Medium holds 60 Hz on the Iris Xe on the 8 km world
(0–2 missed of ~480, plan 46d.13b). GPU timestamps are unusable at the cap (D544), so no pass has a known GPU
cost and nobody can say how much room foliage, fog and weather have. That is the first thing to fix.

### Far field (ray-marched bricks v3)

| # | Finding | Where | Status |
|---|---|---|---|
| F1 | Selection is screen error only: no frustum or occlusion term, `near: null`, so nodes behind the camera and under the near field are selected, built, uploaded and held | `voxel/src/far-tree.ts` (selection), `far-field.ts` | read in code *(re-check)* |
| F2 | Pixels the near field covers pay the whole march, then discard: the near-cover test runs after the march | `three-adapter/src/voxel-far-bricks.ts` march, `voxel-far-common.ts` cover | read in code |
| F3 | Fragment depth + discard: no early-Z. Back faces, three's frustum culling off, no draw order. A ray that misses in one node repeats the work in the node behind; worst case 12 page steps × 32 sphere steps a node | same; D555 | read in code |
| F4 | A hit pixel costs 6 more distance reads for the normal, 1 colour read, 2 cover loads, then full `MeshStandardNodeMaterial` lighting, at full resolution | `voxel-far-bricks.ts` | read in code |
| F5 | A brick job is ~4× a mesh job (50 / 90 ms p50 / p95 against 13 / 23): a 78³ distance transform, a material vote scanning 128 cells with `indexOf`, baked occlusion, six n³ Float32 arrays a job — all at runtime, for a world that was authored | `voxel/src/far-bricks-faces.ts`, `far-bricks-shade.ts` | measured (plan) + read |
| F6 | The 27 same-level cache entries are read, copied and transferred to the job but unused at scale 2 | `far-field.ts` job reads vs `far-bricks-faces.ts` | read in code |
| F7 | Uploads: two texture writes a brick on the page thread with a per-sample palette bake in JS (~87 k writes at medium) | `voxel-far-bricks.ts`; D557 | *(re-check: 7a27b8a9)* |
| F8 | 5 bytes a sample on the GPU (R8 distance + RGBA8 colour), 9³ samples for 8³ cells; a CPU copy of every brick is kept for re-baking | `voxel-far-bricks.ts`, `voxel-far-mesh.ts` | read; heap share inferred |
| F9 | Half resolution exists but only the voxel page wires it, with no temporal reuse (D574) | `voxel-far-half.ts` | read in code |

Measured (plan 46d.13b/13c-1, medium, 8 km world): 2,598 nodes, 43,681 bricks, 164 MB GPU, fill 48 s on the
page and 75–138 s in Play, page heap 0.6–1.1 GB. Mesh fallback: 4.8 M unsimplified triangles, 101 MB, fill 14 s,
0 missed, +0.7 GB heap.

### Near field (meshed chunks)

| # | Finding | Where | Status |
|---|---|---|---|
| N1 | The surface shader pays the worst case on every pixel: ~18 trilinear array samples at anisotropy 4 (albedo, normal, ORM × 3 projections × 2 materials), ~27 texel fetches (8 cells + column + owner; blend, depth, look tables), then full PBR. No branch for single-material ground, single-projection walls, or level 1–2 nodes at 64–192 m | `three-adapter/src/voxel-surface.ts`, `voxel-surface-sets.ts` | read in code; frame share inferred |
| N2 | No depth prepass and no occlusion for chunk surfaces; one mesh a 16 m chunk sorts coarsely, so N1 is multiplied by overdraw | `three-adapter/src/screen-history.ts`, `voxel-chunk-view.ts` | read in code |
| N3 | 12-byte wire vertices are unpacked to 32-byte float attributes on the page thread, a `DataView` loop with an array a vertex; the GPU can read u16×4 / snorm8×4 directly | `voxel-chunk-view.ts`, `voxel/src/derived-mesh.ts` | read in code |
| N4 | One geometry and draw a chunk, one a seam face, six per-object uniform callbacks a mesh a pass; whole geometry rebuilt on any change; a 34³ × 2 B grid upload a chunk | `voxel-chunk-view.ts`, `voxel-surface.ts` | read in code |
| N5 | Workers: every section result is encoded just to hash it; `deriveChunk` builds collision, navigation, light and occupancy for mip nodes that only draw; levels 1 and 2 are both derived to the full load radius | `voxel/src/derive-assembly.ts`, `derived-data.ts`, `stream-ring.ts` | read in code |
| N6 | Ring churn: a chunk crossing a level ring is disposed and later re-joined, transferred, unpacked and re-uploaded | `voxel/src/chunk-batch.ts` | read in code |

Triangle counts are small (town 0.8 M at low, flat rings ~0.2 M inferred), so the near field on this GPU is
fill-bound, not vertex-bound: N1 and N2 first.

## 2. What Enshrouded does (public sources)

Keen gave five Graphics Programming Conference talks (2024: GI, fog, Vulkan; 2025: fog rework, water) and an
official "Performance Improvements for 1.0" video. Stated by the developers unless marked.

- **Same data:** 0.5 m voxels, 10 × 10 × 4 km; terrain and buildings both voxels, both editable; hand-authored
  with brushes and stamps. The solid voxels' storage format is not public.
- **Brick renderer (1.0, October 2026):** until 1.0 voxels became triangle meshes at runtime, called "a big
  bottleneck", worst for distant detail. Now small bricks hold a compressed SDF of the surface, "streamed in or
  created on demand based on GPU feedback", much faster to build than meshes, with a visibility buffer inside
  the brick renderer to cut bandwidth.
- **The documented sibling (water talk):** a forest of sparse octrees (96 m each); leaves are 6³ 8-bit SDF
  bricks with a border (8³ = 512 B) in a 3D atlas; the GPU writes versioned LOD feedback and only the CPU
  changes the tree; bricks are instanced boxes sphere-traced in the pixel shader after compute frustum and
  depth-pyramid culling; 20 MB of nodes + 64 MB for 128 k bricks. That the terrain bricks work the same way is
  an inference.
- **Renderer:** Vulkan, GPU-driven (indirect count draws), deferred + TAA; texture streaming from the minimum
  object distance the GPU culling reports.
- **Lighting:** no hardware ray tracing; compute SDF marching into a cascaded probe cache with a fixed ray
  budget a frame; 1.0 merges all static objects into one world SDF (2–8× faster tracing). Sun shadows are
  cascades culled with the main view's depth.
- **Fog:** froxels near, a half-resolution march far (1 in 4 rays with reconstruction since 2025), precomputed
  atmosphere tables.
- **Steam Deck:** ~30 fps at 832 × 520 upscaled with FSR 2 on the lowest preset in early access (third party).
  Upscaling is part of how it fits.
- **Not public:** the isosurface method, foliage instancing and impostors, the terrain brick format.

**The gap to this engine** is not the brick idea but what surrounds it: (a) only visible bricks are built, by
GPU feedback; (b) boxes are culled by frustum and a depth pyramid before anything marches; (c) the march writes
a visibility buffer and shading runs once a pixel; (d) bricks are cheap to make.

Sources: GI https://www.youtube.com/watch?v=57F1ezwH7Mk · fog 2024 https://www.youtube.com/watch?v=OR8HbFnQdlk ·
Vulkan https://www.youtube.com/watch?v=2LLXC9xCST4 · fog 2025
https://static.graphicsprogrammingconference.com/public/2025/talks/the-fog-is-lifting-volumetric-rendering-enshrouded/Krause-the-fog-is-lifting-volumetric-rendering-enshrouded.pdf ·
water https://static.graphicsprogrammingconference.com/public/2025/talks/water-simulation-rendering-in-enshrouded/Mantler-Koenen-water-simulation-rendering-in-enshrouded.pdf ·
1.0 performance https://www.youtube.com/watch?v=4AQycxtpPno · 1.0 notes https://enshrouded.wiki.gg/wiki/1.0_Update ·
Deck https://steamdeckhq.com/game-reviews/steam-deck/enshrouded-early-access/

## 3. What the web platform allows

> **Superseded in part (2026-11-13).** The WebGL 2 workarounds here stopped binding the design on 2026-11-10 (§6). What is true now: `docs/architecture/voxel-engine.md`; what was decided and dropped: `docs/decisions/owner-decisions.md`.

- **Fragment depth kills early-Z on both renderers.** WebGL 2 has no conservative depth; WGSL's
  `frag_depth, less|greater` is listed as disabled in Chrome (155–156 notes). So rejection before the march must
  be done by hand: read a depth texture at the top of the shader (as Teardown does), or cull the box in the
  vertex stage. https://acko.net/blog/teardown-frame-teardown/ ·
  https://developer.chrome.com/blog/new-in-webgpu-155-156
- **No multi-draw indirect on WebGPU** (experimental flag only, no timeline); `WEBGL_multi_draw` exists on
  WebGL 2. Keep the far field to tens of instanced draws, as it is.
  https://developer.chrome.com/blog/new-in-webgpu-131
- **A depth pyramid can be read in a vertex shader on WebGL 2** (vertex texture fetch), so depth-pyramid
  culling of instanced boxes needs no compute: an occluded box is moved off screen.
- **Intel's Xe-LP guide:** avoid dependent texture reads, prefer non-anisotropic filtering, keep the
  primitive-to-pixel ratio under 1:4.
  https://www.intel.com/content/www/us/en/developer/articles/guide/lp-api-developer-optimization-guide.html
- **Upscaling:** three ships `FSR1Node` and `TAAUNode` (TSL; behaviour on the WebGL 2 backend unverified).
- **The proven low-end alternative** for far terrain is pre-simplified, border-locked LOD meshes with baked
  per-tile textures (meshoptimizer `SimplifyLockBorder`; Veloren, Distant Horizons, Voxel Plugin). The mesh
  fallback measured here was unsimplified. Kept as the fallback decision in §5.
- **Foliage in a browser:** ~1 M octahedral-impostor trees at a per-frame CPU cost independent of count has
  been shown (12 × 12 hemi-octahedral atlas); Horizon Zero Dawn and Ghost of Tsushima place vegetation on the
  GPU from density maps per tile.
  https://app.cinevva.com/blog/2026-05-04-open-world-browser-part-19-imposters
- **Froxel fog** needs compute or slice rendering; an analytic height fog is free in a deferred pass.

## 4. Proposed order of work

> **Superseded in part (2026-11-13).** Steps 0–4 were built as 46d.16–46d.26; steps 5–6 (foliage, fog) are replaced by `docs/research/vegetation.md` and `docs/research/fog.md` (the interactive ground fog first, froxels last). What is true now: `docs/architecture/voxel-engine.md`; what was decided and dropped: `docs/decisions/owner-decisions.md`.

Gains are estimates from sample and job counts unless a measurement is named. Each step is measured with step
0's meter before and after.

**Step 0 — a headroom meter that works at the cap.** D544 rules out timestamps and the owner rules out uncapped
runs. Instead load the GPU until frames miss: draw a chosen pass N times (or raise the render scale in steps)
and record the N at which the orbit starts missing; hiding a pass and repeating gives its share. Output: a
frame budget table per pass on the Iris Xe at 720p, the baseline every later step reports against.

**Step 1 — stop the far field's wasted work** (small changes to the current path).
- Frustum-cull node instances a frame (CPU, the tree's boxes); order the build list by visible first. Nodes
  outside the view may stay resident inside the GPU budget so a turn does not refill.
- Do not select nodes wholly under the near field's cover.
- Reject before the march: read the near field's depth at the ray's entry and discard first (F2).
- Bake the normal into the colour atlas (two octahedral bytes replace the occlusion-only alpha or add a
  texture): removes 6 reads a hit pixel (F4).
- A far shading function with one sun term, ambient and fog instead of the standard material.
- Drop the 27 unused reads (F6); one upload a node (F7, re-check).
- Expected: far pixel cost down 2–4×; fewer nodes built.

**Step 2 — bricks baked at world-bake time.** The far cache stores finished bricks (distance, colour, normal)
per node, written when the world is baked and re-baked for edited nodes only; the runtime job becomes decode +
upload. Removes F5 from the fill. Expected: fill from 48–138 s to under 10 s, workers free for the near field.
Needs a far cache version bump (format spec §3.8, owner note).

**Step 3 — near surface shader and submission.**
- Fast paths chosen per chunk or per draw, not per pixel where possible: single-material cells skip the second
  material and the blend fetches; faces with an axis-dominant normal take one projection; levels 1–2 drop
  anisotropy and take the cheapest path (N1).
- A depth prepass with a position-only program so the surface shader runs once a pixel (N2); check it against
  the three upgrade checklist.
- Packed vertex attributes read directly (N3); same-level chunks merged into few draws (N4).
- Mip nodes skip collision, navigation and light; hash without the full encode (N5).
- Expected: near pixel cost down 3–5×, less page-thread work per chunk.

**Step 4 — the far pass shaped like Enshrouded's.**
- The march writes a visibility target (brick id, hit depth) and no colour; one full-screen pass shades far
  pixels once, with fog.
- Depth-pyramid culling in the vertex stage from the last frame's depth (works on WebGL 2).
- Half resolution with temporal reuse (D574) as the low tier's default if step 0 says it is needed.
- Streaming by feedback: the visibility target says which nodes are seen and at what error; the tree builds
  those. Replaces screen error alone.
- Expected: overdraw bounded, memory follows what is seen. The largest step; start it on step 1's numbers.

**Step 5 — foliage** (after 1–4). Placement generated per cell at load from rules (never stored per instance);
instanced meshes near, octahedral impostors past ~100 m, the far canopy baked into the bricks' colour (plan
45's coverage fraction). Per-frame cost fixed by cell count, not instance count.

**Step 6 — fog and weather.** Analytic height fog in step 4's shading pass; low-resolution froxels near;
dynamic resolution with a spatial upscale as the safety valve.

## 5. Decisions for the owner

- **Bricks or meshes far away.** Recommendation: stay with bricks (the owner's direction; Enshrouded left
  runtime meshing for the reasons this engine has: edits and build cost). Gate after step 1: if step 0's meter
  shows the bricks cannot reach their budget, the top tree levels (past ~2 km) become a simplified height-field
  mesh, as plan 45 first said.
- **A frame budget** per pass at 720p30 on the Iris Xe, set from step 0's numbers.
- **Upscaling** as an accepted part of the low tier (Enshrouded on the Deck relies on it).

## 6. Addendum — WebGPU first, compute, upscaling (owner 2026-11-10, later the same day)

**Owner decision (2026-11-10):** "we keep webgl2 as a fallback for weird drivers but we move to a webgpu
everything and eventually clean up the gates as we get to them so we cut all the extra double passes out. Move
the steps 1-4 to compute shaders."

What it changes:

- **WebGPU is the renderer the voxel work is designed, built and measured for.** WebGL 2 stays as a fallback
  for drivers where WebGPU fails: it keeps what it draws today and must still load and draw a voxel world; it
  gets no new voxel feature and no parity requirement. This replaces the 2026-10-26 preference for one shared
  path on both renderers; it fits the charter's "WebGPU enhancements with a supported WebGL 2 baseline".
- **Gates and measurements:** new items measure and test on WebGPU only. Existing both-renderer e2e passes and
  "WebGPU / WebGL 2" measurement rounds are cut as each area is next touched (not in one sweep), down to one
  WebGL 2 smoke check per area: the world loads, draws, no console error.
- **Reach, for the record:** WebGPU works for roughly 74 % of web visitors (web3dsurvey: API present and an
  adapter created; ~69 % on Android), 76 % to the low 80s by caniuse as quoted second hand. The rest are mostly
  devices below the Iris Xe floor; a desktop build that ships its own Chromium loses almost none.
  https://web3dsurvey.com/webgpu · https://web.dev/blog/webgpu-supported-major-browsers

**The engine already has the compute pieces.** `three-adapter/src/occlusion-pyramid.ts` reduces the scene depth
to a pyramid in compute; `occlusion-instances.ts` tests instanced copies and whole draws against it and writes
indirect draws' instance counts (`geometry.setIndirect`), already used for kit pieces and terrain nodes. Steps
1–4 should extend these, not add a second culling path. Check each WebGPU and three r187 API against its docs
before building on it; §3's WebGL 2 workarounds (vertex-stage pyramid reads, by-hand depth reject as the only
option) no longer bind the design.

**Steps 1–4 on compute** (supersedes the matching bullets in §4; plan items 46d.17–46d.20):

- **Step 1 (46d.17).** Far node boxes become rows of the existing culled-instance table: frustum and
  depth-pyramid tests in compute, the far draws indirect. With the near field drawn first, the pyramid holds
  its depth, so boxes behind near geometry never reach the fragment stage; the per-pixel depth read before the
  march stays for boxes only partly hidden. Baked normal, cheap far shading, unused reads and uploads as
  written.
- **Step 2 (46d.18).** Bake at world-bake time as written (the bake itself may stay on the CPU: it runs once).
  For edited nodes at runtime, try the brick build in compute (distance field from the node's cells, colour and
  normal in the same pass, written straight into the atlas): it would remove the worker job, the transfer and
  the page-thread upload for edits. Unproven here; measure against the CPU job before choosing.
- **Step 3 (46d.19).** Near chunks and seams as rows of the same culled table (frustum + pyramid in compute,
  indirect draws), which also gives the merged draws of N4 a home: same-level chunks in shared buffers, one
  indirect draw a level. The shader fast paths, prepass and packed vertices are fragment and vertex work and
  stay as written. Meshing itself stays in workers: compute meshing of the rule-based surface is a research
  item, not part of this pass.
- **Step 4 (46d.20).** Culling in compute, not the vertex stage. Feedback in compute: a pass over the
  visibility target reduces it to per-node "seen, at this error" in a storage buffer the tree reads back a
  frame or two late (versioned, as Enshrouded's water does). The far shade may be a full-screen fragment pass
  or compute over the visibility target, whichever the meter favours. Half resolution only if 46d.16 asks.
- **Later steps** gain the same way: foliage placement and culling per cell in compute (step 5), froxel fog in
  compute (step 6).

**Upscaling is already in the engine** (`three-adapter/src/post-upscale.ts`: render scale + FSR 1, dynamic
resolution; `post-taau.ts`: temporal upscaling; medium renders below 720p with TAAU, low has no render scale
and no anti-aliasing). FSR 2/3 proper are native compute libraries with no browser build; TAAU is the
equivalent here. Two things for the voxel work:

- **Low tier:** a render scale with an upscale on the low tier is a settings change and the cheapest relief on
  the floor GPU; FSR 1 wants an anti-aliased input, so low would need FXAA with it, or TAAU as medium has.
- **Far bricks under TAAU:** no motion or velocity output was found in the far brick shaders, so reprojection
  would take the box's motion, not the marched hit's: possible ghosting on far terrain in motion. Inferred
  from code, not observed; check in a moving shot and write the hit's motion if it shows. With the whole frame
  at a render scale, the far field's own half-resolution path (D574) may not be needed.
