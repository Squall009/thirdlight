# Phase 33 — Occlusion culling

Goal: what walls, hills, buildings and other solid objects hide is not
drawn, so a view at eye height in a village, a block area or a valley costs
much less than everything in front of the camera. Nothing the player could
see is ever left out: the picture with occlusion culling on equals the
picture with it off. On WebGPU a depth pyramid and a compute pass decide
what is drawn, on the GPU, through indirect draws. On WebGL 2 occlusion
queries on bounding boxes do it, a frame late and conservatively. Occluders
come from static objects, terrain, block chunks and generated architecture,
with optional `_OCC` nodes in models. 30.24's room portals stay the first
and cheapest test. All of it is measured at 1080p on an integrated GPU.

Read `docs/roadmap.md` (principles 1, 5, 6 and 7) first. Phase 33 starts
after phase 32 (decals). Requests: the owner (roadmap, 2026-09-29). The
engine never reads the game repos; nothing here is fitted to one game.

**Release checks run when the phase starts (33.0), not when this plan was
written:** three.js (pinned `0.186.1`; a patch release is taken in 33.0
after reading its notes, a minor release is its own item, read first for
changes to indirect draws, compute, occlusion queries and `PassNode`) and
Rapier (pinned `0.20.0`; the notes are read, nothing in this phase is
expected to need it).

## 1. Owner decisions (2026-09-29, roadmap; the rest proposed here)

- **Scope (owner):** GPU Hi-Z occlusion with indirect draws on WebGPU;
  occlusion queries on WebGL 2; occluders from static objects and terrain;
  an optional `_OCC` node per model as an authored occluder; CPU occluders
  (Godot style) only if the measurements need them; measured first, with
  perf classes for open and occluded views.
- **Room portals are the special case this phase builds on** (30.24) and
  keep working: they run first, and what they hide is never tested again.
- **Shadow maps are never occlusion culled by the camera's depth.** A
  caster hidden from the view still casts into the view. The cached static
  sun map, the dynamic map, point and spot maps and probe bakes draw as
  today.
- **No visible object is culled.** Tests prove it by pixel equality with
  culling on and off, at a still camera and along a moving one.
- **Performance first, with soft targets** (principle 7, §5): each item is
  measured on this host's Iris Xe at 1080p uncapped and records its numbers;
  a miss is a follow-up note, never a reason to drop an item.
- *Proposed, default chosen, owner to confirm:*
  - **On by default for every project.** The setting is additive: absent
    means `auto`, and `auto` draws the same pixels as before (that is the
    rule this phase proves), so "absent = the old behaviour" holds for what
    a player sees. A project or a quality level may turn it off.
  - **Two passes on WebGPU** (Nanite, Unity 6, §3), so nothing appears a
    frame late. No separate occluder depth prepass: the pyramid is built
    from the real scene depth, which is exact and costs no extra geometry.
  - **WebGL 2 accepts at most one frame of lateness** when something comes
    out from behind an occluder, hidden by inflating the tested boxes by
    the camera's motion. If 33.1's moving-camera check shows more than that,
    WebGL 2 defaults to off and the owner decides.
  - **Occlusion is presentation only.** The simulation, colliders, scripts,
    animation mixers and streaming residency never see it. Skipping the
    animation of hidden characters is left for later (§5, out of scope).
  - **`_OCC` meaning:** a mesh drawn into depth only, never in colour,
    never casting a shadow, that must lie inside the model's own surfaces
    (checked at import). It stands in for models whose own surfaces do not
    write solid depth (cut-out hedges, glass, thin detail) or are too
    detailed to be worth testing against.

## 2. Where things stand (checked at `a4e4a7fa`, 2026-10-09)

- **Frustum culling inside draws** (`three-adapter/src/view-cull.ts:1-26`).
  Instance-set chunks, automatic batches and merged static cells are tested
  item by item against the view. What the view sees is ordered first, and
  each draw's count is chosen per camera in `onBeforeRender`: the view's
  camera draws the leading part, every other camera (shadow maps, probes)
  draws everything (`attribute-instancing.ts:325-328`,
  `static-merge.ts:487-488`). The cached static shadow camera is marked
  (`view-cull.ts:36`) and draws every copy at full detail. This per-camera
  count is the hook occlusion uses: the view gets a culled draw, every
  other camera the full one.
- **Hidden from the view, kept in shadows** (`view-hidden.ts:13-39`). A
  mesh hidden by a cut-away or a room moves to layer 31, which shadow
  cameras see and the view does not. Reasons are bits (cut-away 1, room 2);
  occlusion adds a third.
- **Room portals** (`project-model/src/arch-portals.ts`, walk at `:390`;
  page side `three-adapter/src/room-culling.ts`, update at `:251`, hiding at
  `:530`). The walk narrows a screen rectangle portal by portal, only when
  the view moved or a door changed. Drawables get a room from their bounds'
  middle; wall chunks get rooms per vertex. 30.27 measured the interior
  class: `portals=off` adds 277 draws and 0.5–1.0 ms on WebGPU (plan-phase-30
  §6). Instanced draws stay in no room and are not culled by rooms.
- **Static batching** (`static-merge.ts`): static meshes merged per material
  and 64 m cell (`batching.ts:222`, `BATCH_CELL_SIZE_M`), drawn first
  (`MERGED_RENDER_ORDER = -1`, `static-merge.ts:66`) so the level's dense
  geometry fills depth early. A cell's members are index ranges, re-ordered
  when the view changes.
- **Instance sets** (`instancing.ts`, `instance-prepare.ts:25-27`): chunks of
  about 2,048 copies, LOD per chunk or per copy (`instance-lod.ts`), density
  falloff; scatter (`scatter-view.ts`) and ground cover (`cover-view.ts`,
  32 m squares made on a worker) draw through them.
- **LOD** (`lod-switch.ts`): picked per frame on the CPU; only the picked
  level is attached.
- **Render graph** (`render-graph.ts:1-55`): only drawables are in the
  three.js scene; parked members draw through their batch or cell.
- **Terrain** (`terrain-view.ts:1263-1266`): CDLOD nodes drawn instanced, one
  draw per page; the view draws its nodes in view, shadow cameras all.
- **Generated architecture** (`architecture-view.ts`): one mesh per chunk
  per material slot, static, in the cached static shadow.
- **Streaming** (`three-adapter/src/world-stream.ts`): residency by
  distance from the eye under a memory budget; it does not look at
  visibility.
- **Frame order** (`adapter.ts:1394-1431`): streaming, block and
  architecture updates, LOD picks, the batcher, `viewCull.update`, rooms,
  the shadow budget, terrain nodes, then the draw through the environment
  renderer (`environment.ts`, a three `RenderPipeline` whose scene pass has
  depth and normal outputs; AO reprojects last frame's depth already,
  `post-ao.ts:24-34`). Render scale and dynamic resolution
  (`dynamic-resolution.ts`) change the scene pass size. Depth may be
  standard, logarithmic or reversed (`renderer-factory.ts:332`).
- **`adapter.ts` is 1,864 lines**; occlusion lives in its own module and the
  adapter gains only its wiring (split first if it would pass 2,000).
- **No occlusion culling exists**: no depth pyramid, no indirect draws, no
  occlusion queries (`grep occlusionTest` finds none). `_COL` and `_LOD<n>`
  node names are read in `three-adapter/src/pieces.ts:20-21`; there is no
  `_OCC`.
- **Measurement**: `node tools/perf/run.mjs village|blocks|level` with
  classes area, landscape, world, interior, `--switches` per page query,
  GPU pass timestamps on WebGPU (none on WebGL 2); the fast gate checks the
  village against `tests/perf/village-baseline.json`. No class looks from
  eye height at an occluded view, and nothing measures how much of what is
  drawn is hidden.
- **Gate time**: the full gate is over its 15 min budget (D181, open).

## 3. How other engines do it (from their documentation; 33.0 re-reads the current pages before design)

| Topic | Unreal | Unity 6 | Godot 4 | GPU-driven pipelines (AC Unity, Frostbite) | Thirdlight after phase 33 |
|---|---|---|---|---|---|
| Default method | Hardware occlusion queries per actor, read back a frame later; "can cause them to pop in if the camera is moving very fast" [1] | GPU occlusion culling (URP/HDRP with GPU Resident Drawer), on the GPU from a downsampled depth buffer [2][3] | CPU raster of occluder meshes into a low-resolution buffer (Embree), objects' boxes tested against it [4] | Depth pyramid, per-instance and per-cluster culling in compute, indirect draws [6] | WebGPU: depth pyramid + compute + indirect draws; WebGL 2: queries on boxes |
| Depth used | HZB: a mipmapped scene depth [1]; Nanite: two passes, last frame's HZB first, then this frame's for what was culled [5] | Depth of the current and previous frames [2] | Occluders only, this frame | Last frame's depth reprojected plus this frame's occluders | Two passes: last frame's pyramid, then this frame's |
| Occluders | Everything opaque drawn | Everything opaque drawn | `OccluderInstance3D`: baked from meshes or boxes, quads, polygons; MultiMesh not baked [4] | Selected large occluders plus the depth buffer | Everything opaque drawn; `_OCC` depth-only stand-ins |
| Occludee bounds | Actor bounds | Bounding spheres, so long thin objects cull poorly [2] | Boxes; must be fully hidden [4] | Instance and cluster bounds | Boxes per chunk, copy, object or merged member |
| When it hurts | Query cost per actor | "If occlusion culling doesn't have a big effect … rendering time might increase" [2] | Simplify occluders to save CPU [4] | Setup cost | Measured per class against an open view (§5) |
| Precomputed | Precomputed visibility for static actors [1] | Umbra baked occlusion (built-in pipeline) | Portals were Godot 3 rooms | — | Room portals (30.24) |

three.js r186 (pinned) provides, read in `node_modules/three`:
- **Indirect draws on WebGPU only.** `BufferGeometry.setIndirect(attribute,
  offset | offsets[])` with an `IndirectStorageBufferAttribute`; the WebGPU
  backend issues one `drawIndexedIndirect`/`drawIndirect` per offset
  (`renderers/webgpu/WebGPUBackend.js:2150-2190`). There is no
  multi-draw-indirect. The offset is read per draw
  (`renderers/common/Geometries.js:356-358`), so one geometry can use a
  different slot per camera. The WebGL 2 backend ignores the indirect
  buffer and draws by its counts. `renderer.info` counts the CPU's numbers,
  not what an indirect draw really drew.
- **Compute on WebGPU**: TSL compute with storage buffers, atomics
  (`nodes/gpgpu/AtomicFunctionNode.js`), storage textures with a mip level
  (`StorageTextureNode.setMipLevel`), indirect dispatch. All supported device
  features are requested, `indirect-first-instance` included where the
  adapter has it (`WebGPUBackend.js:231-246`). No depth pyramid helper.
- **Occlusion queries on both backends**: an object with
  `occlusionTest = true` has its own draw wrapped in a query
  (`RenderList.js:313-319`); results are read asynchronously
  (`WebGLBackend.js` `resolveOccludedAsync`: `ANY_SAMPLES_PASSED`, polled by
  `requestAnimationFrame`; WebGPU maps a buffer) and answered by
  `renderer.isOccluded(object)` for the render context being drawn
  (`Renderer.js:2445`). So a result arrives at least a frame late, and an
  object that is not drawn gets no result: proxies (boxes) are needed. WebGL 2
  makes results available no earlier than a later task, never in the frame
  that issued them.

Sources:
[1] https://dev.epicgames.com/documentation/en-us/unreal-engine/visibility-and-occlusion-culling-in-unreal-engine
[2] https://docs.unity3d.com/6000.0/Documentation/Manual/urp/gpu-culling.html
[3] https://docs.unity3d.com/6000.0/Documentation/Manual/urp/gpu-resident-drawer.html
[4] https://docs.godotengine.org/en/stable/tutorials/3d/occlusion_culling.html
[5] B. Karis et al., "Nanite: A Deep Dive", SIGGRAPH 2021 Advances; summary https://www.elopezr.com/a-macro-view-of-nanite/
[6] U. Haar, S. Aaltonen, "GPU-Driven Rendering Pipelines", SIGGRAPH 2015 Advances (Assassin's Creed Unity); Frostbite: G. Wihlidal, "Optimizing the Graphics Pipeline with Compute", GDC 2016
[7] `node_modules/three/src/renderers/webgpu/WebGPUBackend.js`, `…/webgl-fallback/WebGLBackend.js`, `…/common/Renderer.js`, `…/common/RenderList.js`, `…/core/BufferGeometry.js:250-256`

## 4. Items

Order: measure → groundwork and occluders → the WebGPU path (frame split,
pyramid, instanced draws, single draws) → the WebGL 2 path → rooms →
terrain horizon (only if needed) → editor → acceptance. All occlusion code
lives in its own module (`three-adapter/src/occlusion*.ts`); the adapter
gains its wiring only. Constants and limits are defined once, in the package
that owns them (thresholds in `@thirdlight/runtime`, settings in
project-model), and imported elsewhere. Format fields are additive and
optional. Every drawing change checks pixels on both renderers; every
editor change has a Playwright test against a real backend.

**How it fits together (the design 33.3–33.7 build).**
- *Occludees* are what can be culled: instance-set copies (scatter, ground
  cover, batches), terrain nodes, block chunks, architecture chunks, models
  drawn alone and the members of merged static cells. What the frustum or
  the rooms already hide is never tested.
- *Occluders* on WebGPU are simply everything opaque in the depth buffer,
  plus `_OCC` stand-ins drawn into depth only. On WebGL 2 the occluders are
  what is drawn before the queries: static geometry draws first (merged
  cells already do), then the proxies are queried at the end of the opaque
  list.
- *Per camera*: the view's camera gets the culled draw; every other camera
  (shadow maps, probe bakes, the static shadow camera) gets the full one,
  through the same `onBeforeRender` choice as today (`view-cull.ts`).

**Done when** (for the phase):
- Each occluded class of 33.1 draws measurably less with culling on, on
  both renderers, recorded against §5 with the split saying where any miss
  comes from; the open view costs no more than §5 allows.
- Pixels with culling on equal pixels with it off, at fixed poses and along
  a scripted camera path, in Play and the export, on both renderers (WebGL 2
  within the one-frame bound of §1).
- Room portal culling, the cached static shadow and cut-aways behave as
  before (their existing e2e checks pass unchanged).
- `tools/gate.sh full` is green, with the phase's added e2e time inside its
  budget (§5).

| Item | What |
|---|---|
| 33.0 | This plan and its rows in `docs/STATUS.md` and `docs/roadmap.md`. The three.js release check (a patch is taken here after reading its notes; a minor is its own item, read for indirect draws, compute, queries and `PassNode` changes) and the Rapier release notes. Re-read §3's sources. **Done when** the checks are recorded in §7 and §3 is current. |
| 33.1 | **Measure first.** <br>• Occluded views as options of the existing classes, not new scenes: `village --view street` (eye height between houses), `level --classes area --view street` (between the walled rooms), `landscape --view valley` (a hill in front of scatter and the block area), `world --view valley`, and `interior` as it is. Each keeps its open view as the control.<br>• **An oracle**: a harness pass that draws every drawable and every instance copy with an id into an id target and counts the ids with at least one visible pixel. It gives how much of what is drawn is hidden (triangles, draws, copies): the most occlusion could save.<br>• Before numbers (p50/p95/p99, GPU passes on WebGPU, main thread, draws, triangles, oracle share hidden) in §6, both renderers, Iris Xe.<br>• vitest for the oracle's counting on a small synthetic scene.<br>**Done when** §6 has the before table and says which classes have enough hidden work to matter. If none does, the phase stops here and the owner decides. |
| 33.2 | **Groundwork.**<br>• Settings: `occlusion` in the environment's quality settings and per quality level (`auto` \| `off`; absent: `auto`), validator, Inspector field in Project Settings, MCP docs.<br>• Page switch `?occlusion=off\|queries\|hiz` for comparisons (like `?portals=off`), and a perf `--switches occlusion=off`.<br>• `HIDDEN_BY_OCCLUSION` as the third reason in `view-hidden.ts`.<br>• Occludee classes as one pure function in runtime (by kind, size on screen, triangles): what is worth testing; thresholds defined once there.<br>• Diagnostics: tested, culled, culled in pass 1 / drawn in pass 2, GPU ms; Play diagnostics, `ctx.stats` and the export's `data-tl-occlusion` canvas attribute.<br>• A shared e2e helper that renders a pose with culling on and off and compares the pixels (the tolerance `view-match.ts` uses).<br>**Done when** the settings round-trip (vitest), the switch and diagnostics show on a page with culling still a no-op, and the helper passes on a plain scene in an existing e2e file. |
| 33.3 | **Occluders.**<br>• **`_OCC` nodes**: `<piece>_OCC` read beside `_LOD<n>` and `_COL` (`pieces.ts`), never drawn in colour and never in shadows; drawn into depth only, first, by the view. Import check: every `_OCC` vertex lies inside the piece's LOD0 bounds (else a warning and the node is ignored). Model import settings `occluder: auto \| occ \| none` (sidecar; absent: auto = use `_OCC` if present, else the model's own opaque surfaces).<br>• An object field `occluder: false` to opt a static object out (Inspector, MCP, `createEntity`); transparent, alpha-tested and double-sided thin materials never count as occluders unless they have `_OCC`.<br>• Terrain pages, block chunks and generated wall chunks are occluders by kind and draw early (the merged cells' order), so WebGL 2's queries see them.<br>• vitest: piece parsing, the import check, the classification; one model with `_OCC` added to an existing model-import e2e.<br>**Done when** an `_OCC` hedge hides what is behind it in the depth the next items read, and draws no colour and no shadow (pixels, both renderers). |
| 33.4 | **WebGPU part A: the frame in two passes, and the depth pyramid.**<br>• The scene pass draws in two renders into the same targets (colour, depth, the normal output AO reads): pass 1, then pass 2 without clearing; transparent objects only in pass 2. Done in the environment renderer's scene pass and on the direct path, at every quality level (with and without the post stack and MSAA, render scale and dynamic resolution).<br>• Between them a compute pass builds a depth pyramid from pass 1's depth: farthest depth per texel (conservative), odd sizes covered, standard, reversed and logarithmic depth; it follows the internal size.<br>• A debug view of the pyramid (`?occlusion=pyramid`).<br>• No culling yet: pass 1 draws everything, pass 2 nothing but transparents.<br>**Done when** pixels equal the one-pass frame at each quality level (both pass layouts, WebGPU), the pyramid's reduction matches a CPU reference (vitest on the rule; one read-back in an e2e), and the extra pass costs ≤ §5 on the open village. This is the item most likely to need a three.js workaround; if two renders into one pass's targets are not possible in r186, it records why and 33.5 falls back to last frame's pyramid in one pass, with the WebGL 2 lateness rule. |
| 33.5 | **WebGPU part B: instanced draws culled on the GPU.**<br>• Instance-set chunks (scatter, ground cover, kit copies) and automatic batches: a compute pass tests each copy's bounds against the pyramid; it keeps a visible bit per copy on the GPU. Pass 1 draws the copies visible last frame that are in the frustum; pass 2 draws the rest that this frame's pyramid shows. Each writes a compacted list of copy indices and the draw's `instanceCount` (`IndirectStorageBufferAttribute`, `geometry.setIndirect`).<br>• The WebGPU vertex path reads the copy's matrix through the compacted index (a program variant only when culling is on; WebGL 2 keeps its attributes).<br>• LOD and density thinning stay the CPU's picks; the compute only removes.<br>• Other cameras use a full slot (shadows, probes, the static shadow camera).<br>• Part B: terrain nodes the same way (one draw per page stays).<br>**Done when** the street and valley views draw fewer copies (GPU counters read back for diagnostics), pixels equal culling off at the poses and along the path (WebGPU), shadows of hidden copies still fall in view, and the main thread gains no more than §5. |
| 33.6 | **WebGPU part C: single draws culled on the GPU.**<br>• Block chunks, architecture chunks and models drawn alone get a slot each in one shared indirect buffer; the compute writes `instanceCount` 0 or 1.<br>• So each draw is encoded once a frame: the CPU lists a draw in pass 1 when the last read-back said it was visible, else in pass 2, where it is tested against this frame's pyramid. A late read-back only delays a saving, it never hides what is seen.<br>• Merged static cells per member: a compacted index list written by compute if three accepts a storage index buffer, else members' runs as several indirect offsets; the spike decides and §7 records it.<br>**Done when** the area street view draws fewer triangles (GPU counters), pixels equal culling off (WebGPU, poses and path), and the read-back adds no frame over 16.7 ms. |
| 33.7 | **WebGL 2: occlusion queries.**<br>• A proxy box (one shared geometry, depth test on, colour and depth writes off) per occludee worth a query: block and architecture chunks, instance-set chunks, merged cells, large models. Queried at the end of the opaque list through three's `occlusionTest`.<br>• Latency hidden and kept conservative: a draw is hidden only after two occluded answers in a row and shown at the first visible one; boxes grow by the camera's motion over the answers' latency; a camera cut, a teleport or a fast turn shows everything for that frame; a box the eye is inside is never queried.<br>• Hidden draws leave the view through `HIDDEN_BY_OCCLUSION`; an instance chunk is hidden whole.<br>• Queries are spread over frames when there are many (a per-frame time slice, not a content cap: every occludee is asked within a bounded number of frames).<br>**Done when** the street and valley views draw fewer draws on WebGL 2, pixels equal culling off at still poses, and along the path no frame differs for more than one frame per uncovering (§1). |
| 33.8 | **Rooms and occlusion together.** Portal culling runs first; what it hides is not tested or queried. Instanced copies inside rooms, which rooms never culled, are now culled by depth. A cut-away's hidden roof is not an occluder; an `_OCC` under a cut-away follows it. A door opening shows the room behind in the same frame (WebGPU) or within the bound (WebGL 2). **Done when** the existing rooms checks (`layered-material.e2e.ts` with `rooms-lighting.ts`) pass unchanged and gain one on/off pixel comparison, and the interior class records `portals=off` and `occlusion=off` separately. |
| 33.9 | **Terrain horizon on the CPU** (dropped if 33.1 and 33.5–33.7 show no need). A coarse height grid per terrain tile gives, from the eye, a horizon per direction; streamed scatter groups, block chunks and far tiles wholly under it are not encoded at all, on both renderers, with no latency. Conservative by construction (heights rounded up, bounds rounded down). **Done when** the valley view's main thread drops on WebGL 2 (or the item is dropped with the reason in §7). |
| 33.10 | **Editor.** The Scene view culls through the same path as Play (one realization). Selected objects, and anything a gizmo or outline draws, are never culled. View menu: "Occlusion culling" on/off, and an overlay that shows what is culled (tinted boxes) and the pyramid. Inspector: the object's `occluder`, the model's import `occluder`. **Done when** an editor e2e (an existing Scene view file) toggles it, sees the overlay, sees a selected object behind a wall stay drawn, on both renderers. |
| 33.11 | **Export, settings and documentation.** The export ships the setting and the culling (no editor code); `docs/deployment.md` gets the settings, the switch and the `_OCC` rule (the manual of phase 31 picks them up); the best practice for games: where walls and `_OCC` pay, where they do not. **Done when** an exported class page reports `data-tl-occlusion` with culled draws on both renderers. |
| 33.12 | **Acceptance.** 33.1's classes after the phase, split in §6 by switches (`occlusion=off`, `portals=off`, each path); the village baseline check unchanged or better. One generated level in Play and the export, on both renderers, extending `level-acceptance.e2e.ts`: pixels with culling on and off at three poses and along a short scripted path; a hidden caster's shadow still in view; a door opening shows its room. **Done when** the phase's done-when holds and the full gate is green. |

## 5. Soft performance targets

Measured at 1920 × 1080 uncapped on this host's Iris Xe in 33.1's classes,
WebGPU, WebGL 2 recorded. They guide design; a miss is recorded with its
cause and a follow-up, never a reason to throw an item away.

| Measure | Target |
|---|---|
| Occluded views (street, valley) | frame p95 at least 25 % lower than `occlusion=off`, or half of what the oracle says is hidden culled |
| Open view (nothing hidden) | GPU ≤ +0.3 ms, main thread ≤ +0.2 ms against `occlusion=off` |
| Depth pyramid and culling compute | ≤ 0.4 ms GPU at 1080p |
| Second pass on WebGPU | ≤ 0.2 ms GPU when nothing new is uncovered |
| WebGL 2 queries | ≤ 0.3 ms main thread a frame |
| Visible objects culled | none: pixels equal at still poses (both); along a path none on WebGPU, at most one frame per uncovering on WebGL 2 |
| Draws encoded per frame | no more than with culling off, plus the proxies on WebGL 2 |
| Pyramid memory | ≤ 4 MB at 1080p |
| Frames over 16.7 ms in a 60 s flight | no more than with culling off |
| Added e2e time for the phase | ≤ 60 s on the full gate, all in existing files |

Out of scope, written down for later: precomputed visibility, a CPU
software rasterizer of occluders for WebGL 2 (Godot style), cluster or
meshlet culling, occlusion culling of shadow casters in light space, and not
animating hidden characters.

## 6. Progress and measurements

| Item | Status |
|---|---|
| 33.0 | |
| 33.1 | |
| 33.2 | |
| 33.3 | |
| 33.4 | |
| 33.5 | |
| 33.6 | |
| 33.7 | |
| 33.8 | |
| 33.9 | |
| 33.10 | |
| 33.11 | |
| 33.12 | |

## 7. Decision log

- 2026-10-09: planned (doc only). Two passes on WebGPU rather than an
  occluder depth prepass: the pyramid comes from the real depth, so it is
  exact and needs no second draw of the occluders; a prepass at low
  resolution can cover more than the full-resolution occluder and cull
  something seen.
- 2026-10-09: indirect draws are WebGPU only in three r186 (one draw per
  offset, no multi-draw); WebGL 2 keeps today's counts and uses three's
  occlusion queries on proxy boxes.
- 2026-10-09: single draws are encoded once a frame, in pass 1 or 2 by the
  last read-back, so the CPU does not encode the scene twice; instanced
  draws are encoded in both passes, with the copy visibility kept on the GPU.
- 2026-10-09 (default chosen, owner to confirm): on by default, absent =
  `auto` (same pixels as before); WebGL 2 with at most one frame of
  lateness; `_OCC` as depth-only stand-ins inside the model; presentation
  only.
