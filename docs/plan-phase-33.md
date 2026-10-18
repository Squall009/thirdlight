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
  - **On by default for every project** (superseded by the review fixes,
    §7: `auto` and absent cull nothing, `2` turns culling on). The setting is additive: absent
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

## 2. Where things stand (checked at `a4e4a7fa`, 2026-10-09; re-checked at `60bd1f69`, 2026-10-17, after phases 34–37)

- **Frustum culling inside draws** (`three-adapter/src/view-cull.ts:1-26`).
  Instance-set chunks, automatic batches and merged static cells are tested
  item by item against the view. What the view sees is ordered first, and
  each draw's count is chosen per camera in `onBeforeRender`: the view's
  camera draws the leading part, every other camera (shadow maps, probes)
  draws everything (`attribute-instancing.ts:358-361`,
  `static-merge.ts:517-518`). The cached static shadow camera is marked
  (`view-cull.ts:36`) and draws every copy at full detail. This per-camera
  count is the hook occlusion uses: the view gets a culled draw, every
  other camera the full one.
- **Hidden from the view, kept in shadows** (`view-hidden.ts:21-55`). A
  mesh hidden by a cut-away or a room moves to layer 31, which shadow
  cameras see and the view does not. Reasons are bits: cut-away 1, room 2,
  isolation 4 (phase 34: hidden from the shadows too), occlusion 8
  (`HIDDEN_BY_OCCLUSION`, used by the oracle's ideal-culling measurement;
  33.2 uses it for real).
- **Edit-mode isolation** (`isolation-view.ts`, phase 34). An edit mode
  shows only the edited object: every other drawable leaves the view's and
  the shadows' layers; batches and merged cells are hidden whole and the
  isolated object's own meshes leave them meanwhile (`ISOLATED_DRAW_KEY`,
  `batching.ts:82`) and draw alone; once a frame, after the batcher and
  after rooms, the scene is swept (`adapter.ts:1502`, `:1511`). Occlusion
  must test only what isolation left drawn and never hide the isolated
  object (it is what is edited) or anything that belongs to no object
  (overlays, gizmos, brush cursors).
- **The borrowed Scene view** (`editor/src/ui/shell/useSceneViewLending.ts`,
  phases 34 and 37). Edit modes and preview panes draw on the Scene view's
  own canvas, renderer and scene, moved into their pane; docked panels lie
  over the view (the canvas keeps its size; framing fits the view minus the
  open panels). So the editor has one view path; culling in it is the
  Play path with the editor's camera, and panels over the view are drawn
  under, not culled.
- **Texture stand-ins** (phase 37: block layers, `block-layers.ts`, and
  material graphs, `material-graph.ts:142`). While texture arrays encode,
  surfaces draw with a stand-in and swap programs when the textures arrive.
  Pixel comparisons (culling on vs off) wait for the stand-ins to be gone,
  as `view-match.ts` already waits for a settled scene.
- **Room portals** (`project-model/src/arch-portals.ts`, walk at `:390`;
  page side `three-adapter/src/room-culling.ts`, update at `:306`, hiding at
  `:580`). The walk narrows a screen rectangle portal by portal, only when
  the view moved or a door changed. Drawables get a room from their bounds'
  middle; wall chunks get rooms per vertex. 30.27 measured the interior
  class: `portals=off` adds 277 draws and 0.5–1.0 ms on WebGPU (plan-phase-30
  §6). Instanced draws stay in no room and are not culled by rooms.
- **Static batching** (`static-merge.ts`): static meshes merged per material
  and 64 m cell (`batching.ts:245`, `BATCH_CELL_SIZE_M`), drawn first
  (`MERGED_RENDER_ORDER = -1`, `static-merge.ts:72`) so the level's dense
  geometry fills depth early. A cell's members are index ranges, re-ordered
  when the view changes.
- **Instance sets** (`instancing.ts`, `instance-prepare.ts:24`,
  `INSTANCE_CHUNK_COPIES = 2048`): LOD per chunk or per copy
  (`instance-lod.ts`), density falloff; scatter (`scatter-view.ts`) and
  ground cover (`cover-view.ts`, 32 m squares made on a worker) draw through
  them.
- **LOD** (`lod-switch.ts`): picked per frame on the CPU; only the picked
  level is attached.
- **Render graph** (`render-graph.ts:1-56`): only drawables are in the
  three.js scene; parked members draw through their batch or cell.
- **Terrain** (`terrain-view.ts:1313-1316`): CDLOD nodes drawn instanced, one
  draw per page; the view draws its nodes in view, shadow cameras all.
- **Generated architecture** (`architecture-view.ts`): one mesh per chunk
  per material slot, static, in the cached static shadow.
- **Streaming** (`three-adapter/src/world-stream.ts`): residency by
  distance from the eye under a memory budget; it does not look at
  visibility.
- **Frame order** (`adapter.ts:1473-1517`, the draw at `:1575`): streaming,
  block and architecture updates, LOD picks, isolation's batch hook, the
  batcher, `viewCull.update`, rooms, isolation's sweep, the shadow budget,
  terrain nodes, then the draw through the environment renderer
  (`environment.ts`, a three `RenderPipeline` whose scene pass has depth and
  normal outputs; AO reprojects last frame's depth already,
  `post-ao.ts:24-31`). Render scale and dynamic resolution
  (`dynamic-resolution.ts`) change the scene pass size. Depth may be
  standard, logarithmic or reversed (`renderer-factory.ts:334`).
- **File sizes**: `adapter.ts` is 1,979 lines (1,864 at `a4e4a7fa`), and
  `editor/src/viewport/viewport.ts` 1,990: occlusion lives in its own
  modules and each gains only its wiring; 33.2 and 33.10 move an area out
  first if their wiring would pass 2,000.
- **No occlusion culling exists**: no depth pyramid, no indirect draws, no
  occlusion queries (`grep occlusionTest` finds none). `_COL` and `_LOD<n>`
  node names are read in `three-adapter/src/pieces.ts:19-20`; there is no
  `_OCC`.
- **Measurement**: `node tools/perf/run.mjs village|blocks|level` with
  classes area, landscape, world, interior, `--switches` per page query,
  GPU pass timestamps on WebGPU (none on WebGL 2); the fast gate checks the
  village against `tests/perf/village-baseline.json`. 33.1 adds the
  occluded views (`--view street|valley`) and the oracle (`--oracle`).
- **Gate time**: the full gate takes 31 min against its 15 min budget
  (D181, D253: the owner's): no new e2e files and no net added e2e time;
  pixel checks extend existing rendering and level files.

## 3. How other engines do it (from their documentation; re-read 2026-10-11 and checked again 2026-10-17 in 33.0)

| Topic | Unreal | Unity 6 | Godot 4 | GPU-driven pipelines (AC Unity, Frostbite) | Thirdlight after phase 33 |
|---|---|---|---|---|---|
| Default method | Hardware occlusion queries per actor by default ("Dynamic Occlusion"; HZB is the more conservative option, `r.HZBOcclusion`), read back a frame later, so objects can pop in when the camera moves very fast [1] | GPU occlusion culling (URP with the GPU Resident Drawer: Forward+, compute shaders, SRP Batcher) on the GPU; the drawer still supports Dynamic Occlusion too [2][3] | CPU raster of occluder meshes into a low-resolution buffer (Embree), objects' boxes tested against it [4] | Depth pyramid, per-instance and per-cluster culling in compute, indirect draws (AC Unity: ~300 best occluders at 512 × 256 combined with last frame's reprojected depth) [6] | WebGPU: depth pyramid + compute + indirect draws; WebGL 2: queries on boxes |
| Depth used | HZB: a mipmapped scene depth [1]; Nanite: two passes, last frame's HZB first, then this frame's for what was culled [5] | Depth of the current and previous frames [2] | Occluders only, this frame | Last frame's depth reprojected plus this frame's occluders | Two passes: last frame's pyramid, then this frame's |
| Occluders | Everything opaque drawn | Everything opaque drawn | `OccluderInstance3D`: baked (simplified) from meshes, or quad, box, sphere, polygon, array shapes; MultiMesh, particles and CSG not baked; occluders should not move [4] | Selected large occluders plus the depth buffer | Everything opaque drawn; `_OCC` depth-only stand-ins |
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
  (`RenderList.js:317-322`); results are read asynchronously
  (`WebGLBackend.js` `resolveOccludedAsync`: `ANY_SAMPLES_PASSED`, polled by
  `requestAnimationFrame`; WebGPU maps a buffer) and answered by
  `renderer.isOccluded(object)` for the render context being drawn
  (`Renderer.js:2445`). So a result arrives at least a frame late, and an
  object that is not drawn gets no result: proxies (boxes) are needed. WebGL 2
  makes results available no earlier than a later task, never in the frame
  that issued them.
- **Release notes read (r185, r186; r186 is still the latest on
  2026-10-17):** occlusion queries made more robust and stale queries
  fixed (#33959, #33972), WebGPU checks render bundles against occlusion
  queries (#34286); read-write storage buffers and atomics allowed in
  non-compute stages (#33626: a vertex stage may read a compacted copy
  list), `compileComputeAsync()` (#32551), `updateBefore`/`updateAfter` on
  compute nodes (#34401), `batchIndirectIndex` for `BatchedMesh` (#34111,
  not used here); `PassNode` fixes the pixel ratio of derived passes
  (#34453) and no longer makes a depth texture with `depthBuffer: false`.
  Nothing changes `setIndirect` or adds multi-draw-indirect.

Sources:
[1] https://dev.epicgames.com/documentation/en-us/unreal-engine/visibility-and-occlusion-culling-in-unreal-engine
[2] https://docs.unity3d.com/6000.3/Documentation/Manual/urp/gpu-culling.html (Unity 6.3 LTS)
[3] https://docs.unity3d.com/6000.3/Documentation/Manual/urp/gpu-resident-drawer.html
[4] https://docs.godotengine.org/en/stable/tutorials/3d/occlusion_culling.html (Godot 4.7)
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
| 33.13 | **Review fixes.** The independent review's Medium findings and the cheap Lows (§7); `auto` culls nothing, `2` turns culling on (D282). |

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
| 33.0 | Done 2026-10-17: three.js 0.186.1 still the latest (r185/r186 notes in §3: no change to `setIndirect`, queries more robust, storage read-write in vertex stages); Rapier 0.21.0 exists, 0.20.0 stays; §2 re-checked at `60bd1f69` (isolation, the borrowed Scene view, stand-ins, docked panels added); the WIP branch's oracle and views ported by hand (isolation now takes bit 4, occlusion 8). |
| 33.1 | Done 2026-10-17: `--view street\|valley` on village and level, `--oracle` (per item and whole draws, then the wholly hidden draws left out and measured again); before table below. Occluded views hide 76–93 % of draws and 83–93 % of triangles; leaving every wholly hidden draw out saves ≤ 1.2 ms GPU and ≤ 1.7 ms main thread, frame p95 mostly within noise: the work is there, its time is small at these class sizes. Verdict in §7: all items go ahead except 33.9 (dropped) and 33.6's per-member merged cells (dropped). |
| 33.2 | Done 2026-10-17: `occlusion_culling` (0 off / 1 auto, absent auto) and a level's `occlusionCulling`, `?occlusion=off\|queries\|hiz` and the scene switch, the occludee registry (village: 604 on WebGPU, 608 on WebGL 2) and `occludeeClassOf` in runtime, diagnostics (Play, `ctx.stats.occlusion`, `data-tl-occlusion`), `expectOcclusionMatch` in rendering.e2e (export on vs off: strict); culling still a no-op. Village A/B (3 rounds, same browser) on vs `occlusion=off`: p50 equal (WebGL 2 4.7/4.7, WebGPU 5.5/5.5 ms), main thread +0.06–0.14 ms (≤ +0.2, §5). The fast gate's perf missed twice under another session's load (load 10–12), then passed at load 2: webgl2 p50 4.8 ms (limit 4.84). |
| 33.3 | Done 2026-10-17: `<piece>_OCC` stand-ins (project-model naming and import check, `occluderPointsOutside` with 1 mm; ignored ones → Problems `model_occluder_ignored` and dropped at load), drawn depth only, last among the opaque draws, for the view's camera only while a path is on (`data-tl-occlusion` 5th field: stand-in draws); occluder roles in runtime (`occluderRoleOf`), object `occluder` (box, model) and model `occluder: auto\|occ\|none`; terrain, block and architecture draws take the merged cells' order. vitest +3 files; rendering.e2e's export on/off check gained two fences with `_OCC` panels, one seen through the boxes' gaps, one behind the camera with the sun behind it (WebGPU: strict pixels equal, worst 0; stand-ins drawn only with culling on; seen in the frame: no panel colour, no panel shadow; WebGL 2 unverified). Before → after, same hour, load 2.7–3.6: village open p50 5.7→5.6 / 4.6→4.7 ms (WebGPU / WebGL 2), street 6.0→6.0 / 4.9→4.9, main 6.23→6.22 / 6.13→6.08 ms; landscape valley 10.0→10.0 / 3.3→3.0, GPU 14.87→14.73 ms; draws and oracle shares unchanged (nothing culls yet): equal within noise, no target applies yet. |
| 33.4 | Done 2026-10-17: on `hiz` the scene pass's render is drawn as two (`occlusion-passes.ts`: occluders and stand-ins, then role `none` opaques and transparents, no clear) with the depth pyramid between them (`occlusion-pyramid.ts`: two dispatches, 16 × 16 tiles in workgroup memory down to level 4, one workgroup for the rest; MSAA depth by its samples); frames on `hiz` always draw through the scene pass; `_OCC` stand-ins record into level 0 only (atomics from their fragments), never into the scene's depth; `?occlusion=pyramid[:level]` debug view; `gpuMs` and `pyramid` in the diagnostics. rendering.e2e's export: culling on vs off bit-identical (worst 0) with AO and glass behind a stand-in, plain MSAA, render scale 0.5 and three poses along a flown camera (a control with the stand-ins in the scene depth: mean 3.6, worst 137), pyramid read back (rule kept level over level), debug view drawn; vitest for the rule. Same hour, load 1.8–3.4, WebGPU on vs `occlusion=off`: village open p50 5.7/5.6 ms, main 6.42/6.21 (+0.21, §5 ≤ +0.2: at the limit); street p50 6.2, main 6.85; landscape open 10.4/10.4, main 10.56/10.51, valley 10.2; WebGL 2 unchanged (4.8/4.7). Pyramid GPU 0.31–0.44 ms (three's compute timestamps, §5 ≤ 0.4: at the limit), main 0.03–0.06 ms, second render 0.13–0.2 ms main; memory 2.76 MB at 1080p (+2.3 MB of stand-in records only in scenes with `_OCC`). Second pass's own GPU time not separable (unverified against ≤ 0.2 ms). Dynamic resolution not checked by pixels (it changes the same scene pass size the render scale does). |
| 33.5 | Done 2026-10-17: instance-set chunks (scatter, ground cover, kit copies) and automatic batches culled copy by copy on the GPU (`occlusion-instances.ts`; rule and CPU reference in `occlusion-instances-rule.ts`): shared pools (matrices as drawn, paint slot included; world spheres; slots), a dispatch before pass 1 lists last frame's visible copies of occluder draws, one in the pyramid's compute pass tests the rest and lists the newly visible, a workgroup a draw (order kept), indirect draws per pass, the view only (shadows, probes, the static shadow draw every copy from their columns); a draw is culled only when its copies in view draw ≥ `OCCLUSION_MIN_COPIES_TRIANGLES` (2048). WebGPU, on vs `occlusion=off`, same hour, load 2–4: village open p50 5.7/5.6 and 6.1/5.7 ms, main 6.28/6.26 and 6.61/6.20 (two rounds; noise ±0.3), culled 197 of 418 tested (oracle 649 hidden); village street culled 446 (oracle 842 hidden: 53 %), p50 6.5, main 6.93; landscape open p50 10.4/10.4, main 10.47/10.48, scene pass GPU 4.39/9.56 ms, culled 9178 (oracle 15911: 58 %); landscape valley culled 6932 (oracle 10565: 66 %), scene pass 2.83 ms. Pyramid + culling compute 0.44–0.51 ms GPU on landscape (§5 ≤ 0.4 missed), ~0.3 on the village. Frames are main-thread bound here, so frame times barely move (§5's p95 −25 % unmet; "half of the oracle's hidden culled" met in the occluded views). rendering.e2e's export: a 945-copy painted scatter set and batches, 862 of 879 copies culled at the still pose, culling on vs off bit-identical there, along the flown path, with AO, MSAA and render scale; no GPU validation errors. Fast gate green (village p50 5.9 ms, limit 6.16). Terrain nodes (the row's part B) not done: left for 33.6. WebGL 2 unchanged (no marker, no variant). |
| 33.6 | Done 2026-10-17: block and architecture chunks, merged cells (whole) and models alone culled whole on the GPU as rows of 33.5's table (`occlusion-whole.ts`; pass by the last read-back answer, `instanceCount` 0/1 in pass 2, tested as world boxes, ≥ `OCCLUSION_MIN_COPIES_TRIANGLES`), terrain nodes culled per node (`terrain-node-culling.ts`, boxes); fixed 33.5's rebuilt late kernel reading last frame's pyramid. WebGPU A/B against `00c4eef9`, same hour, load 1.1–3.6 (before the 2048 floor for whole draws): landscape valley triangles 287k → 43k, scene pass GPU 2.96 → 2.54 ms, main 10.16 → 10.05; area street 200k → 190k tris, main 7.33 → 7.36; village street main 7.20 → 6.79; village open on vs off unchanged; pyramid + culling compute on landscape 0.44–0.52 → 0.52–0.54 ms (§5 ≤ 0.4 still missed). Village gate check interleaved (9 rounds, load 2–4): before 6.0–6.1, after 6.0–6.3 ms p50, equal main thread; the fast gate's perf missed 6.2–6.3 ms three times, then passed at 6.1 (limit 6.16, host state: D199). rendering.e2e's export: 2 of 3 models culled whole, 2 of 10 terrain nodes culled, WebGPU on vs off bit-identical at the pose, along the path, with AO, MSAA and render scale. WebGL 2 unverified (unchanged path). |
| 33.7 | Done 2026-10-18: occlusion queries on boxes (`occlusion-queries.ts`; bookkeeping in `occlusion-queries-rule.ts`, vitest): WebGL's own `ANY_SAMPLES_PASSED_CONSERVATIVE` queries round each box's draw, drawn after the frame into the scene pass's target after the `_OCC` stand-ins (which never reach the depth AO, fog and transparent draws read); a draw is hidden after two answers in a row (the newer ≤ 2 frames old) and shown at the first that sees it; boxes grow by a depth margin and the camera's motion; cuts forget every answer; what is asked is `wholeTestOf` (shared with the GPU path: `occludeeClassOf`, the 2048-triangle floor) and instanced draws by their copies in view, hidden whole. Answers come 2 frames late at 60 Hz and 20–60 frames late uncapped (nothing culled there); box-measured lateness along the flown camera 2 frames: **WebGL 2's auto culls nothing, `?occlusion=queries` pins the queries** (§7, owner to confirm). rendering.e2e's export on WebGL 2 (pinned): on vs off bit-identical at the still pose (AO, glass behind the stand-in, 3 models hidden), in the plain frame and at two poses along the flight. WebGL 2 uncapped, before (`c62483bd`: auto = the no-op queries path) → after (auto = off), load 1–3.5, p50 / main ms: village open 4.7/4.7, 6.18/6.07; street 5.1/4.9, 6.71/6.71; area open 2.6/2.6, 7.02/7.05; landscape open 4.2/4.0, 11.15/11.16; valley 3.2/3.2, 10.77/10.83 (equal). Queries pinned, uncapped: 1–29 boxes a frame, 0 culled, main +0–0.1 ms; capped at 60 (`frameRateCap`): village street 2 culled, 139k → 135k triangles, main 4.70 → 4.80. With a 64-triangle floor (an experiment, not kept): 66 of 112 hidden in the street, but +75 boxes a frame: draws 265 → 275, main +1.5 ms (load 5–7). The oracle still counts 78 % of the street's draws hidden: what WebGL 2 could save stays unclaimed. |
| 33.8 | Done 2026-10-18: one ordering rule for both paths (`occlusionMayTest`, view-hidden.ts: what a cut-away, the rooms or isolation hid is never tested or queried, what occlusion hid is asked again); `_OCC` stand-ins follow their piece's surfaces (`standinFollowsSurfaces`); instanced draws of one copy (kit copies drawn per room often are) were culled by no path on WebGPU (the runtime calls them whole draws) and are now tested as their copy (`copiesWorthCulling`, vitest); the rooms' switch at run time (`scene.userData.tlRooms`). layered-material.e2e's export gained a dense kit copy in the shut room C: hidden by the portals it is not tested (`hiz\|47\|0\|0`, `queries\|47\|0\|0`), with the portals off it is culled by depth (`…\|1\|1`) on both paths, and occlusion on vs off with the portals on and off, and the portals on vs off, are bit-identical (worst 0; WebGL 2 with the queries pinned). WebGPU, before (`94d48bb5`) → after, load 0.5–3, p50 / main ms: interior 9.9/9.9, 9.97/9.98 (`occlusion=off` 9.6/9.6, 9.69/9.73; `portals=off` 10.2/10.2, 10.23/10.22, 384 draws); area open 7.1/7.1, 7.22/7.23; area street 7.2/7.3, 7.31/7.31: equal. The interior tests 0 of its 464 occludees: after the portals what is left is wall chunks taller than half the view and props under the 2048-triangle floor (the oracle's 21 hidden draws hold 7k triangles), and it has no instanced copies; with `portals=off` occlusion culls 1 draw of 2 tested: it does not stand in for the portals (+282 draws). Fast gate green (village p50 6.1 ms, limit 6.16). |
| 33.9 | Dropped by 33.1 (§7, default chosen, owner to confirm). |
| 33.10 | Done 2026-10-18: the Scene view culls through Play's culler (the project's `occlusion_culling`, the renderer's path; `?occlusion=` and `?portals=off` reach the Scene view and Play); a new View menu: Occlusion culling on/off (this view only), Show culled draws (magenta boxes round draws culled whole or hidden by queries; the view keeps drawing meanwhile), Depth pyramid; the selection's subtree and an edit mode's objects are never culled (a batch or merged cell holding one is drawn whole, untested; nothing regroups), the view's own drawing is no occludee (`markHostDrawing`); Inspector Occluder (box/model) and the asset inspector's model `occluder`. rendering.e2e's Scene view test (WebGPU, then WebGL 2 with the queries pinned): a dense block behind a wall culled and boxed, selected → outlined and drawn, the wall's Occluder off → drawn, vertex-paint mode with Context → never culled, culling on vs off bit-identical (worst 0) on both; +6.4 s (6.7 → 13.1 s, one editor reload). vitest: kept draws, host drawing, the overlay's edges, the menu switches. viewport.ts split first (effect preview, 1,990 → 1,897; now 1,942). The decal atlas flake fixed (§7). Fast gate: e2e green (D201 once, passed on rerun); its village perf check missed (WebGPU p50 7.9–8.2 ms, limit 6.16) with HEAD `b2950862` as slow: interleaved A/B, 4 rounds in both orders, main thread 7.96 (after) / 7.93 (before) ms, p50 7.1–8.2 / 7.0–8.1 ms, the second run of each pair the slower: host state (D199), baseline kept. |
| 33.11 | Done 2026-10-18: the manual's `features/occlusion.md` (when culling pays and where walls and `_OCC` stand-ins do not, the setting and the quality-level override, WebGPU `hiz` on and WebGL 2 queries off and why, `_OCC` with its import check and the model's `occluder`, an object's `occluder: false`, the View menu, the URL switches, the diagnostics), linked from the manual's and the features' indexes, editor, assets and both performance pages; a `_OCC` section and checklist note in the trim sheet spec (the kit editor's checks list no `_OCC` check: none exists); `occlusion_culling` in the MCP `setSettings` docs (values from `OCCLUSION_CULLING_SETTING_VALUES`); reference regenerated; deployment.md untouched (server-only); the skill names no node suffixes or render settings, unchanged. Export: bundle-scan.test.ts builds the real export page with `occlusion_culling: 0` and checks the manifest's setting reads off, the page links both paths' modules and no editor, backend, MCP, workspace, commands or protocol code (every export also runs `checkBundleGraphM3`); `data-tl-occlusion` with culled draws on both renderers was already covered by rendering.e2e's export (WebGPU auto, WebGL 2 pinned). No drawing change. Fast gate: build, lint, vitest, e2e (rendering.e2e) green; its village perf check missed twice (WebGPU p50 6.3, then 7.1 ms, limit 6.16; the plain three.js page slowed with it, 6.3 → 6.5 ms) while the export page bundle is byte-identical to HEAD's (sha256 compared with and without the change): host state (D199), baseline kept. |
| 33.12 | Done 2026-10-18: after numbers below (classes split by `occlusion=off`, `portals=off`, WebGPU `hiz` and WebGL 2 `auto` and pinned `queries`; the harness's `--switches` now also run at each view). Village A/B against `60bd1f69` (interleaved `village --gate`, load 3–4, fast host state): WebGPU p50 5.2–5.6 → 6.0–6.3 ms, HEAD with `occlusion=off` 5.6/5.7: a real cost of the hiz path, half from 33.4 and half from 33.5 (33.6 adds none), not host drift (D282); WebGL 2 4.6–4.9 both. One generated level (terrain with scatter and cover, block walls with a live door, generated rooms with a closed door piece, an `_OCC` hedge hiding a dense pillar) through the editor's Play button and File → Export game, both renderers, export at 1920 × 1080: 36 of 36 culling on/off comparisons bit-identical (four poses, a door opened by a script with the portals on and off, three stops after flights), the opened door's room drawn in the first shot after the key; the Scene view's culled boxes and depth pyramid looked at; the hidden pillar's shadow is not told apart by eye (it falls inside the hedge's own), only bit-identical. Not done: `level-acceptance.e2e.ts` not extended (no added e2e time; the driver covered it), the 2048-triangle floor not re-measured on denser content. Fixed: the culled boxes were never drawn on WebGL 2 (counted only; rendering.e2e now checks their pixels); a read-back finishing after Play stopped threw. §5 below: p95 −25 % missed everywhere (−2 to −8 %), half the oracle's hidden items culled in the landscape and world views (64–81 %), not in the village and area streets (45 %, 47 %); open view and draws missed (D282, D285); GPU numbers unverified (D283); D284 for the overlay. Screenshots in `~/.cache/thirdlight-phase33/acceptance/`. |
| 33.13 | Done 2026-10-18: review fixes (§7): `occlusion_culling` 0 off / 1 auto (culls nothing on either renderer) / 2 on (hiz on WebGPU, queries on WebGL 2), a level's `off`/`auto`/`on`; displaced vertices never culled unless they declare a reach (wind does); pass 2 hides only childless draws; slot-ordered pools (60 s landscape flight, culling on: 1705 → 1250 KiB uploaded a frame, main thread 7.10 → 7.11 ms, off 6.07 / 6.23: unchanged, D282); `_OCC` coverage check along the axes; one 2048-triangle floor; the door (layered-material's rooms export pose: taken away with culling on, C seen, on = off to the pixel) and a culled caster's shadow (rendering.e2e's Scene view, both renderers) as regressions. Village A/B against `60bd1f69`, 3 rounds interleaved, WebGPU p50 base 5.6/5.6/5.6 against after 5.6/5.6/5.7 ms, WebGL 2 4.7/4.7/4.8 against 4.6/4.7/4.8 ms (load 2.9–4.9): equal, inside the gate's limits (6.16 / 4.84 ms) again. Fast gate (rendering, layered-material, engine-stats, project-settings) GREEN: 33 e2e passed (3.2 min), village perf WebGPU p50 5.6 ms (limit 6.16), WebGL 2 4.8 ms (limit 4.84); the first run failed the two new steps (a stale rooms count read, a shadow cast too low to be seen), fixed. D282 updated, D286–D288 logged. |
| Phase gate | `full --both-renderers` at `7fc09308` (2026-10-18 06:37, 2 workers, before the review fixes): build, lint, vitest 731 files passed; e2e **390 passed** in 22.4 min; **26 min — OVER BUDGET** (15 min; D253 is still the owner's decision); memory peak **7.0 GB, at the 7G cap** (no OOM). Logs `~/.cache/thirdlight-logs/gate-full-20261018-063740`. Not rerun after 33.13 (fast gates of the touched areas). |

**33.1 before numbers** (HEAD `60bd1f69` plus the harness, Iris Xe, 1920 × 1080, DPR 1, uncapped; frame
p50/p95/p99 ms; GPU = three's pass timestamps per frame, WebGPU only, waits included; main = main-thread
task ms per frame; hidden = the oracle's share of the view's draws / triangles / items (copies, merged
members) with no visible pixel; "ideal" = the same page with every wholly hidden draw left out of the
view: what a perfect culler of whole draws saves). Village at load 3–4; level classes at load 10–14 (another
session's tests), so their frame times are noisy — compare within a row, not across rows.

| Class, view, renderer | frame | GPU | main | draws | tris | hidden (draws, tris, items) | ideal: frame, GPU, main, draws |
|---|---|---|---|---|---|---|---|
| village open webgpu | 5.5/8.2/15.3 | 9.33 | 6.05 | 222 | 107k | 44 %, 63 %, 84 % | 5.4/8.2/15.5, 9.18, 6.00, 142 |
| village open webgl2 | 4.7/6.1/38.9 | - | 6.01 | 224 | 106k | 44 %, 62 %, 84 % | 4.5/6.4/56.5, -, 5.93, 143 |
| village street webgpu | 6.0/9.6/12.4 | 10.15 | 6.55 | 265 | 139k | 78 %, 83 %, 93 % | 6.0/9.5/16.4, 9.82, 6.48, 92 |
| village street webgl2 | 5.0/7.1/22.4 | - | 6.71 | 265 | 139k | 78 %, 84 %, 93 % | 4.0/6.4/73.4, -, 6.29, 91 |
| area open webgpu | 6.3/13.7/22 | 10.54 | 6.98 | 260 | 271k | 14 %, 35 %, 71 % | 6.3/13/21.1, 10.17, 6.76, 226 |
| area open webgl2 | 3.9/10.7/144.6 | - | 7.51 | 260 | 271k | 14 %, 35 %, 71 % | 3.4/10/125.7, -, 6.81, 226 |
| area street webgpu | 6.8/14.8/22.5 | 12.31 | 7.48 | 259 | 275k | 76 %, 86 %, 95 % | 6.8/15.7/22.2, 11.26, 7.46, 79 |
| area street webgl2 | 3.3/10.1/176.2 | - | 7.57 | 259 | 275k | 76 %, 86 %, 95 % | 3.2/11.3/70.6, -, 6.85, 79 |
| landscape open webgpu | 9.7/17/28.3 | 15.69 | 10.01 | 343 | 547k | 29 %, 61 %, 85 % | 9.8/21.4/30.1, 14.75, 10.45, 252 |
| landscape open webgl2 | 4.3/9.9/281 | - | 10.37 | 343 | 547k | 29 %, 61 %, 85 % | 4.2/7.9/214.4, -, 10.19, 252 |
| landscape street webgpu | 10.5/12.7/28.3 | 15.30 | 10.72 | 344 | 558k | 79 %, 91 %, 97 % | 9.6/11/27.1, 14.54, 9.71, 92 |
| landscape street webgl2 | 4.0/11.7/175.8 | - | 8.52 | 344 | 557k | 79 %, 91 %, 97 % | 4.7/8.1/14.9, -, 7.85, 92 |
| landscape valley webgpu | 10/11.3/27 | 14.71 | 10.05 | 298 | 441k | 93 %, 90 %, 83 % | 9.3/10.4/26.4, 14.63, 9.36, 44 |
| landscape valley webgl2 | 3.2/12.7/211.3 | - | 10.66 | 298 | 441k | 93 %, 90 %, 83 % | 10/11.7/27.3, -, 10.16, 44 |
| world open webgpu | 8.9/11.4/26.6 | 13.64 | 9.05 | 384 | 565k | 22 %, 47 %, 70 % | 8.7/11.9/25.9, 13.08, 8.98, 304 |
| world open webgl2 | 4.5/8.8/178 | - | 9.25 | 384 | 565k | 22 %, 47 %, 70 % | 4.6/14.8/126.3, -, 9.19, 304 |
| world street webgpu | 8.3/11.5/17.8 | 12.87 | 8.55 | 381 | 571k | 83 %, 93 %, 97 % | 7.3/10.2/23, 11.66, 7.48, 83 |
| world street webgl2 | 4.5/9/198.3 | - | 8.88 | 384 | 576k | 84 %, 93 %, 98 % | 3.2/8.5/14.5, -, 7.22, 83 |
| world valley webgpu | 9.9/12.4/27.5 | 14.72 | 10.23 | 182 | 401k | 82 %, 87 %, 85 % | 9.1/10.3/26.3, 14.28, 9.19, 53 |
| world valley webgl2 | 3.1/9.9/26.9 | - | 9.27 | 182 | 401k | 82 %, 87 %, 85 % | 8.6/9.3/16.7, -, 8.96, 53 |
| interior webgpu | 8.6/11.9/25.7 | 13.64 | 8.66 | 102 | 132k | 52 %, 12 %, 61 % | 8.2/10.9/25.6, 14.56, 8.36, 67 |
| interior webgl2 | 8.7/9.3/26.5 | - | 9.31 | 102 | 132k | 52 %, 12 %, 61 % | 8.3/8.9/16.4, -, 8.30, 67 |

By kind (street views): instance copies are the bulk of the hidden items (94–97 % of copies, 87 % of their
triangles, but only 65–76 % of their draws hidden whole: a chunk with one copy in sight draws); merged
cells 70–74 % of draws; single draws 73–84 % of their triangles. Oracle runs 0.6–1.2 s, 0 stray ids. The
interior's 52 % hidden draws are left after the portals (instanced draws, which rooms never cull). The
WebGL 2 p99 outliers (70–280 ms) are the loaded host's long frames, in both columns.

**33.12 after numbers** (HEAD `c3a90933` plus the harness's switches at views, 2026-10-18, Iris Xe, 1920 × 1080, DPR 1,
uncapped, load 2.4–3.1; frame p50/p95 ms, main = main-thread ms a frame; culled/tested from `data-tl-occlusion`
(copies and terrain nodes, plus draws culled whole); "of hidden" = culled against the oracle's hidden items). WebGPU,
the setting's `auto` (= `hiz`) against `occlusion=off` in the same browser:

| Class, view | frame on / off | main on / off | draws on / off | tris on / off | culled / tested | of hidden |
|---|---|---|---|---|---|---|
| village open | 7.1/9.5 / 7.5/10.4 | 7.24 / 7.61 | 229 / 222 | 92k / 107k | 197 / 418 | 27 % |
| village street | 7.7/10.0 / 7.4/10.5 | 7.85 / 7.62 | 274 / 265 | 114k / 139k | 446 / 529 | 45 % |
| area open | 7.7/9.4 / 7.7/9.2 | 7.77 / 7.77 | 281 / 260 | 206k / 271k | 701 / 2784 | 20 % |
| area street | 8.4/10.1 / 8.2/10.9 | 8.44 / 8.30 | 280 / 259 | 200k / 275k | 2182 / 2829 | 47 % |
| landscape open | 10.4/10.9–11.5 / 10.4/10.9–11.4 | 10.48 / 10.49–10.53 | 367 / 343 | 228k / 547k | 9187 / 15276 | 57 % |
| landscape street | 9.0/10.8 / 9.2/11.8 | 9.05 / 9.23 | 368 / 344 | 203k / 557k | 14304 / 16399 | 76 % |
| landscape valley | 10.1/10.5 / 10.0/11.2 | 10.15 / 10.04 | 299 / 298 | 167k / 441k | 7002 / 10520 | 64 % |
| world open | 10.1/12.6 / 9.8/11.8 | 10.25 / 9.90 | 408 / 381 | 249k / 561k | 3325 / 13723 | 28 % |
| world street | 8.6/10.0 / 8.7/10.5 | 8.77 / 8.81 | 409 / 384 | 223k / 574k | 12845 / 14816 | 74 % |
| world valley | 10.0/11.2 / 10.2/11.0 | 10.10 / 10.25 | 193 / 182 | 44k / 401k | 13990 / 17803 | 81 % |
| interior | 9.9/10.4 / 9.6/10.3 | 9.95 / 9.70 | 102 / 102 | 132k / 132k | 0 / 0 | - |
| interior `portals=off` (culling on) | 10.2/10.8 | 10.23 | 384 | 344k | 1 / 2 | - |

The landscape open view's first run read 12.4 ms / 12.52 main with culling on, then four alternating runs on/off/on/off in
two pages read 10.4 ms and 10.48–10.53 main for both (the row's values): a one-off. The compute pass (pyramid and culling)
read 0.27 (village open), 0.47 (village street), 0.35–0.37 (area), 0.30 (interior), 0.53–0.62 ms (landscape, world), an
upper bound (D283). WebGL 2, `auto` (= off) / `occlusion=off` / `queries` pinned, frame p50/p95 and main: village open
4.6/7.2 6.40, 4.6/7.1 6.57, 4.9/6.5 6.48; street 4.9/7.2 6.95, 4.9/7.1 6.97, 5.3/7.9 6.93; area open 2.6/7.3 7.23,
2.6/8.1 7.46, 3.1/7.2 7.52; area street 2.6/7.8 7.35, 2.6/7.6 7.60, 3.0/7.4 7.53; landscape open 4.4/15.9 11.22, 4.0/12.7
11.00, 4.5/7.4 11.42; street 4.1/6.6 9.56, 4.0/10.2 9.55, 4.6/8.5 9.50; valley 3.2/11.2 10.87, 3.2/11.3 10.61, 3.6/11.1
10.67; world open 4.4/9.5 10.37, 4.5/12.3 10.29, 5.0/8.7 10.43; street 4.4/14.3 9.15, 4.4/11.6 8.81, 5.0/8.7 9.01; valley
3.2/11.5 10.59, 2.9/11.3 10.61, 10.9/11.8 11.01; interior 7.4/11.0 9.45, 7.9/10.8 9.47, 7.0/10.9 9.09 (`portals=off`
3.7/10.3 10.84, 384 draws). The pinned queries asked 0–30 boxes a frame and culled 0 everywhere uncapped (§7 33.7). A 60 s
flight over the landscape at 60 Hz: 0 refreshes missed with culling on, off and the queries pinned, on both renderers;
main thread WebGPU 7.06 on / 6.24 off, WebGL 2 5.84 auto / 5.80 off / 6.14 queries.

**§5 after the phase:**

| Measure | Result |
|---|---|
| Occluded views: p95 −25 %, or half the oracle's hidden culled | p95 missed (WebGPU −2 to −8 %, world valley +2 %); half culled met in the landscape and world views (64–81 % of the hidden items), missed in the village and area streets (45 %, 47 %); WebGL 2 culls nothing by default (§7 33.7) |
| Open view: GPU ≤ +0.3 ms, main ≤ +0.2 ms | main: area, landscape equal; village +0.20–0.27, interior +0.25, world +0.35 (one run): missed, and the village frame +0.6–0.8 ms p50 (D282); GPU unverified (D283) |
| Pyramid and culling compute ≤ 0.4 ms | met on the village open view, area and interior (0.27–0.37), missed on the village street, landscape and world (0.47–0.62), as an upper bound (D283) |
| Second pass ≤ 0.2 ms when nothing is uncovered | unverified (not separable, D283) |
| WebGL 2 queries ≤ 0.3 ms main | met within noise (queries pinned against off −0.38 to +0.42 ms; two readings +0.4 in the noisy landscape and world open views) |
| No visible object culled | met at still poses: 36 of 36 on/off comparisons bit-identical in Play and the export on both renderers (poses, a door opened, stops after flights); per-frame equality along a moving path is not observable this way (rendering.e2e's flown poses only) |
| Draws encoded ≤ culling off (+ proxies on WebGL 2) | missed on WebGPU: +7 to +27 draws (3–8 %, D285); WebGL 2 queries +2 to +31 proxies (allowed) |
| Pyramid memory ≤ 4 MB at 1080p | met: 2.76 MB (33.4) |
| Frames over 16.7 ms in a 60 s flight | met: 0 with and without culling, both renderers |
| Added e2e time ≤ 60 s | unverified until the phase's full gate (33.10 +6.4 s; 33.12 adds one picture poll per renderer to rendering.e2e) |

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
- 2026-10-17 (33.0): three.js 0.186.1 is still the latest release (no patch
  to take); Rapier 0.21.0 exists and the pin 0.20.0 stays (nothing here
  touches physics). The r185/r186 notes are summarised in §3; read-write
  storage buffers in vertex stages (#33626) are what 33.5's compacted copy
  list needs. The WIP branch `wip/33.1-measure` was ported by hand, not
  merged: isolation took bit 4 meanwhile, so `HIDDEN_BY_OCCLUSION` is 8;
  the eye height is defined once in the harness (`generate.ts`).
- 2026-10-17 (33.1, default chosen, owner to confirm): **the phase goes
  ahead.** Every occluded view hides most of its work (76–93 % of draws,
  83–93 % of triangles, 93–98 % of copies), so each class has hidden work
  that matters by count. Its time is small at these class sizes on this
  host: leaving every wholly hidden draw out saves ≤ 1.2 ms GPU and ≤ 1.7 ms
  main thread, and frame p95 moves mostly within noise; the frames are
  bound by the post stack and fixed per-frame work, not by these draws.
  So §5's "p95 25 % lower" is out of reach here; the occluded-view target
  that counts is the other one, "half of what the oracle says is hidden
  culled", together with the open-view cost limits (≤ +0.3 ms GPU,
  ≤ +0.2 ms main thread), which become the deciding guard: culling must
  cost less than the ≤ 1 ms it can save. The saving grows with denser
  content (a town, a forest behind a hill), which the classes do not have.
- 2026-10-17 (33.1, default chosen, owner to confirm): **33.9 (terrain
  horizon on the CPU) is dropped.** In the valley views the ideal culling
  of every hidden draw saves 0.5–0.7 ms main thread; 33.5–33.7 reach the
  same draws, and a second culling path for that is not worth its code.
- 2026-10-17 (33.1, default chosen, owner to confirm): **33.6's merged
  cells per member are dropped**; merged cells are culled as whole draws
  (one slot per cell) like block and architecture chunks. Hidden merged
  triangles are 11–18k per view (a few percent of the frame's), and a
  compacted index buffer per cell is the part most likely to need a
  three.js workaround.
- 2026-10-17 (33.1, default chosen, owner to confirm): **WebGL 2 (33.7)
  keeps its place and is where the CPU saving is**: leaving hidden draws
  out drops main thread by 0.4–1.7 ms there (village street p50 5.0 →
  4.0 ms at low load), while WebGPU's indirect draws still encode every
  draw and save GPU time only. 33.5 (instanced copies on the GPU) is the
  WebGPU item with the most to remove: 94–97 % of copies are hidden in
  the street views, more than whole-draw culling can reach.
- 2026-10-17 (33.2, default chosen, owner to confirm): **the setting is a
  project setting plus a quality level field**, layered like ambient
  occlusion through the render control: `occlusion_culling` (Rendering
  group, 0 off / 1 auto, absent auto) and a level's `occlusionCulling:
  off | auto` (absent: the project's). No player settings binding (none was
  asked for). New projects write nothing: absent already is the new
  default, and auto draws the same picture.
- 2026-10-17 (33.2): `?occlusion=off|queries|hiz` pins a path; a pinned path
  the renderer lacks (`hiz` on WebGL 2) draws with none, so a comparison
  never measures another path than the one it named. The same pin is on the
  scene (`scene.userData.tlOcclusion`: `path()`, `pin()`, `diagnostics()`),
  which the oracle reads; its ideal hiding pins culling off first, since both
  use `HIDDEN_BY_OCCLUSION`.
- 2026-10-17 (33.2, default chosen, owner to confirm): what is worth testing
  is `occludeeClassOf` in runtime `occlusion.ts`: under
  `OCCLUSION_MIN_TRIANGLES` = 64 a draw costs about what a WebGL 2 query's
  box does; over `OCCLUSION_MAX_SCREEN_SHARE` = 0.5 of the view's height a
  draw tested whole is almost never hidden; instanced copies and terrain
  nodes are tested one by one. 33.5–33.7 tune the numbers with measurements.
- 2026-10-17 (33.2): the occludee registry follows `scene.children` once a
  frame while a path is on (the render graph pushes drawables into the
  scene directly, so there are no add/remove events to hear); block,
  architecture and terrain draws are marked by their owners, the rest is told
  from its three.js type. The editor's Scene view is not wired yet (33.10),
  so `viewport.ts` was not split; editor Play does not forward `?occlusion=`
  (as `?portals=`). The manual page is 33.11's.
- 2026-10-17 (33.3, default chosen, owner to confirm): **`_OCC` stand-ins draw
  last among the opaque draws, not first.** The depth the next items read is
  the depth after the opaque draws (33.4's pyramid is built from pass 1's
  depth; 33.7's queries are drawn at the end of the opaque list), so a
  stand-in drawn last culls exactly as much as one drawn first, while this
  frame's colour stays what it is without it: drawn first, the background
  seen through a cut-out hedge's gaps would be lost in the same frame.
  Stand-ins draw only for the view's camera (no shadow map, probe, bake or
  other camera; their per-camera count, as `view-cull.ts` does) and only
  while a culling path is on. What later reads that depth (transparent
  draws behind a stand-in, ambient occlusion and fog at uncovered pixels)
  sees the stand-in: that is the author's promise that it lies inside the
  model's surfaces, which the import check can only bound (LOD0 bounds,
  1 mm).
- 2026-10-17 (33.3): occluder roles are one pure rule in runtime
  (`occluderRoleOf`: `early` level geometry and merged cells, `surface`,
  `standin`, `none`); terrain, block and architecture draws take the merged
  cells' order (`OCCLUDER_EARLY_RENDER_ORDER`, defined once in
  `occluders.ts`; a transparent chunk keeps its place among the transparent
  draws). Alpha-tested level geometry still counts (its cut-outs write the
  depth of what they draw); alpha-tested, double-sided and transparent
  models do not. An object's `occluder: false`, a model's `occluder: occ |
  none` and a piece with a stand-in (`auto`) mark the surfaces that do not
  count; batches and merged cells key on the marks, so one draw never mixes
  roles. Where a `none` draw goes (after the queries, pass 2 only) is 33.4's
  and 33.7's.
- 2026-10-17 (33.3, default chosen, owner to confirm): the import check
  reports through the project's Problems (`model_occluder_ignored`, checked
  at load and after imports), not as an import diagnostic: the importer's
  proposal is a validated protocol whose diagnostics reject a file, and an
  ignored stand-in should not reject the model. The same rule
  (`occluderPointsOutside`, project-model) drops the node when the adapter
  makes the model, so the export and Play never draw it. The object's
  `occluder` reaches the Inspector through its descriptor; the asset
  inspector's import field and the editor test of both are 33.10's.
- 2026-10-17 (33.4, default chosen, owner to confirm): **`_OCC` stand-ins go
  into the depth pyramid only, not into the scene's depth.** With them in the
  depth, what later reads it changed pixels with culling on: glass behind a
  stand-in disappeared and ambient occlusion darkened a cut-out's gaps
  (rendering.e2e's control: mean 3.6, worst 137). On WebGPU a stand-in now
  draws without depth test or write and its fragments record, per level-0
  texel, which pixels it covers and the farthest stand-in depth there
  (atomics); level 0 takes the nearer of scene and stand-in depth at the
  covered pixels, so it is never nearer than the stand-in. This replaces 33.3's
  "the author's promise" for AO, fog and transparent draws on WebGPU; WebGL 2's
  queries (33.7) still need the stand-ins in the depth they test against and
  must restore or avoid it for what reads the depth after them.
- 2026-10-17 (33.4, default chosen, owner to confirm): **frames on `hiz` always
  draw through the environment renderer's scene pass** (a plain one without
  post effects), not straight to the canvas: three's direct path keeps its
  depth in a private target, the scene pass's depth is a texture the pyramid
  reads. Pixels equal the direct path's to the bit (rendering.e2e, `ao=off`).
- 2026-10-17 (33.4): the passes are split by three's render-object function
  only. The renderer's `opaque` / `transparent` switches and the clear flags
  are left alone: a shadow map drawn inside a pass resets only part of the
  renderer's state, so it kept `transparent = false` and lost transparent
  casters (a 2-level edge on glass), or would keep `autoClearDepth = false`.
  The second render turns `autoClear` off and lifts a colour background for
  itself; the first pass's draws are hidden while three walks the scene for
  the second render and shown at its first draw, before a shadow map could be
  drawn.
- 2026-10-17 (33.5): **instanced copies are read through shared pools.** A draw's
  program is shared by every draw of its material and layout, so its vertex
  stage cannot bind each draw's own instance buffer; the culled draws' copies
  are copied (as drawn: 64 bytes a copy, the paint slot in the fourth row
  unchanged) into one pool, with world spheres and slots, and the vertex stage
  reads `pool[base + list[instance]]`. Ranges come from a first-fit allocator
  that grows by doubling (no cap). A draw is marked by a geometry attribute
  (`tlCulledCopies`) before its first render object is made, so its program is
  a variant only while `hiz` is on; WebGL 2 and culling off build what they
  built before (the WGSL digests are unchanged).
- 2026-10-17 (33.5): **both passes read the same per-draw uniforms**; which list a
  pass reads is a flag in the list buffer the two dispatches write (a uniform
  written per pass made every culled draw rewrite its object buffer twice a
  frame: +170 buffer writes, +0.3 ms main thread on the village). three
  refreshes an object's uniforms and bindings only when its observer sees a
  change it knows of; a culled draw's observer also refreshes it whenever what
  its vertex stage reads (list, range, pools) changed for that render object.
  Without it a draw of a plain material kept a pool buffer that had been
  replaced, and its pass was dropped by the GPU (validation errors in the
  landscape class; rendering.e2e now fails on any). Refreshing every draw
  instead cost +0.3 ms main thread on the village.
- 2026-10-17 (33.5, default chosen, owner to confirm): **instanced occluders are
  encoded in both passes** (as planned 2026-10-09). Measured: drawing them in the
  second pass only saved no main-thread time on the village and culled a third
  fewer copies, so they stay occluders. What did cost was culling the village's
  ~100 automatic batches of a few small props (each 2–5 copies, ~200
  triangles): the open village ran +0.3 ms main thread and failed the fast
  gate's perf check (p50 6.3 ms against 6.16). **A draw is culled only when its
  copies in view draw at least `OCCLUSION_MIN_COPIES_TRIANGLES` = 2048
  triangles** (runtime, defined once); smaller draws are drawn whole that
  frame. The village then measures on ≈ off (within noise) and the gate passes;
  scatter, cover and large batches keep their culling (landscape 58–66 % of the
  oracle's hidden copies). 33.12 re-measures the number with denser content.
- 2026-10-17 (33.5): the depth-pass dispatch runs in the pyramid's compute pass
  (one submit), the first-list dispatch only when a culled draw is an occluder
  (cut-out scatter and cover are second-pass only), and the drawn counts are
  read back once a second for diagnostics.
- 2026-10-17 (33.5): a culling dispatch that throws turns the culling of copies
  off for the page (reported once) instead of leaving the scene pass's targets
  set: a throw inside the pass once left the renderer's MRT on and every later
  frame black.
- 2026-10-17 (33.6, default chosen, owner to confirm): **draws culled whole are
  rows of the instanced copies' table** (one copy each, `occlusion-whole.ts`),
  not a second table and kernel: block and architecture chunks, merged cells
  (as whole draws, §7 above) and models drawn alone. Each is encoded once a
  frame: in the first pass, drawn whole, when it fills the depth and the last
  answer said seen (or none came yet); else in the second, through its
  indirect draw, whose instance count the late dispatch writes 0 or 1. The
  test runs for both, its answer is written into the row's unused first-pass
  instance count and read back every frame (one read in flight, into one
  `ReadbackBuffer`), so a draw hidden by the first pass's occluders moves to
  the second a few frames later and back at its first "seen". A late answer
  only delays a saving. A draw of several groups or a wireframe stays drawn
  whole (an indirect draw has one range). Worth a test by `occludeeClassOf`
  (≤ half the view's height) and the floor instanced copies use,
  `OCCLUSION_MIN_COPIES_TRIANGLES` (2048): with only the 64-triangle floor the
  village's small models alone and the late kernel's box branch cost +0.1–0.2 ms
  p50 and failed the fast gate; the box test is built into the kernel only
  while a frame has boxed rows. No new constant.
- 2026-10-17 (33.6): **draws culled whole and terrain nodes are tested as their
  world boxes, copies still as spheres.** A flat 32 m terrain node's sphere
  reaches 22 m above it and a wall chunk's far past its ends: in rendering.e2e's
  export no terrain node was culled as a sphere, 2 of 10 as boxes. The box
  rides in the copy's unused floats 8–14 (`COPY_BOX_FLOAT`), a table flag picks
  the test; the CPU rule `boxMayShow` shares the screen-rectangle part with
  `sphereMayShow`.
- 2026-10-17 (33.6): **terrain nodes are copies of the page's draw** (one draw a
  page stays): the node's eight floats ride in a copy's first half and the
  terrain's vertex stage reads them through the list (`culledCopyVec4`); a
  node's visibility is kept by its place in the selection, so a new selection
  costs the first pass some draws, never a seen node. The frame's occlusion
  update now runs after the terrains' node selection and the ground cover, so
  both are this frame's when the copies are listed.
- 2026-10-17 (33.6): fixed in 33.5's code: a late dispatch rebuilt that frame
  (the pools grew, the pyramid's size changed, the first frame) was submitted
  from inside the pyramid's build, before the reduction, so it tested against
  last frame's pyramid (an empty one at the first frame: everything hidden in
  the second pass for one frame). It now runs right after the pyramid's pass.
- 2026-10-18 (33.7, default chosen, owner to confirm): **WebGL 2 culls nothing by
  default; its occlusion queries are a pin (`?occlusion=queries`).** §1's rule:
  more than one frame of lateness on a moving camera turns WebGL 2 off. The
  answers come 2 frames after their query at 60 Hz, and 20–60 frames after it
  uncapped (Chrome queues frames ahead of the GPU), where the age bound (2
  frames) then culls nothing; along rendering.e2e's flown camera a hidden draw
  stayed hidden for 2 frames after its box showed (the box is larger than the
  draw, so an upper bound). The cost is the other half: a box is a draw through
  three (its render object, uniforms, bindings) and a hidden draw is asked every
  frame (so it shows at its first answer that sees it), so hidden draws are
  replaced by as many boxes: in the village street with a 64-triangle floor 66
  draws hidden for 75 boxes, main thread +1.5 ms; with the 2048-triangle floor
  the GPU path uses (kept, no new constant) 2 draws asked and culled, ±0.1 ms.
  What would make it pay, for the owner to weigh: boxes drawn without three
  (one program, a matrix uniform each), boxes over groups of draws, and only
  vsync'd frames (players' browsers) trusting answers. The setting's `auto`
  documents it; `occlusionPathOf('auto', 'webgl2')` is `off`.
- 2026-10-18 (33.7): **the queries are WebGL's own, not three's `occlusionTest`.**
  three makes and deletes a query per object a frame and answers per render
  context only once every query of a render has its answer, as a set with no
  frame to it: the two-in-a-row and age rules need each answer's query and frame.
  The queries are pooled and begun and ended round `renderObject` in the
  render-object function (the WebGL 2 backend draws inside that call); a box three
  did not draw (its program still building: the draw-call count did not move)
  loses its query, which breaks the run of answers.
- 2026-10-18 (33.7): **the boxes are drawn after the frame**, into the scene pass's
  target (frames on the queries path draw through the scene pass, as on `hiz`),
  with the stand-ins drawn into its depth first: ambient occlusion, fog, depth of
  field and transparent draws have read the depth by then, and the next frame
  clears it. The render resolves nothing (`resolveColorBuffer` /
  `resolveDepthBuffer` off). three's WebGL 2 `clear` sets the depth mask but not
  the colour mask, so the boxes' colourless draws left the next frame's colour
  uncleared (glass drawn over itself frame after frame, and the oracle's id
  target never cleared: 0.7 M stray pixels): the colour mask is set back after
  the boxes. The `queries` path is now WebGL 2 only
  (`occlusionPathAvailable`): WebGPU's pyramid answers in the same frame.
- 2026-10-18 (33.8): **one rule says what occlusion may test** (`occlusionMayTest`,
  view-hidden.ts, beside the reasons it reads): drawn, hidden by none of the
  reasons decided before it (`HIDDEN_BEFORE_OCCLUSION`: cut-away, room,
  isolation) and on the view's layers, or off them only by occlusion's own
  hiding. The GPU path's copies and whole draws and WebGL 2's queries all ask it
  (the queries had their own mask, the GPU path a layer test). A cut-away's
  hidden roof is off the view's layers, so neither path draws it into the depth
  they read; its fading copy draws its dithered depth, which is exact.
- 2026-10-18 (33.8, default chosen, owner to confirm): **an `_OCC` stand-in
  follows its piece's surfaces.** Cut-aways hide only block and generated
  architecture meshes, never models, so no stand-in is under a cut today; the
  rule is general: when every surface of its piece drawn on its own (in the
  scene now) is hidden by a cut-away, the rooms or isolation, the stand-in is
  not drawn on either path. A stand-in whose surfaces are all parked in a batch
  follows its own hiding (its own room, from its middle, which lies inside the
  piece). The link is a `WeakMap`, not `userData`, which clones copy as JSON.
- 2026-10-18 (33.8): a door opening shows the room behind in the same frame on
  both paths by construction: the walk runs in the frame the door changes;
  a whole draw listed again keeps its last answer (hidden: drawn in the second
  pass if this frame's pyramid shows it) or has none (drawn in the first), a
  copy's stale visible bit only moves it to the second pass, and WebGL 2's
  queries forget a draw while the rooms hide it, so it is drawn at once. No
  e2e opens a door with culling on (33.12's acceptance does).
- 2026-10-18 (33.8): **a one-copy instanced draw is culled as its copy.** The
  runtime's `occludeeClassOf` calls an instanced draw of one item a whole draw,
  and the GPU path culls whole only chunks, cells and models, so such draws were
  culled by no path on WebGPU (WebGL 2's queries already asked them). Kit copies
  drawn per room are often one copy a draw. `copiesWorthCulling` (the copies'
  rule, beside its CPU references) now takes every class but `never`; the
  2048-triangle floor is unchanged.
- 2026-10-18 (33.8): the e2e check rides the existing lit rooms' export pose
  (four settled shots 250 ms apart and the count's poll: a few seconds, no new
  page load), with one dense kit copy added to the shut room so something is
  culled.
- 2026-10-18 (33.8): the rooms have a run-time switch like occlusion's
  (`scene.userData.tlRooms`: `portals()`, `pinPortals(on)`), so one page
  compares the portals on and off without a second load; `?portals=off` stays
  the load-time pin the perf harness uses.
- 2026-10-17 (33.4): the pyramid is one float buffer, every level packed
  (`pyramidLayout`), reduced in two dispatches (one dispatch a level measured
  slower on the GPU and costs 11 encodes a frame at 1080p). A thread reads 2 × 2
  level-0 texels; a tile's texels past an edge are reduced from clamped reads
  and only repeat the edge's inputs. 33.5 reads the same buffer.
- 2026-10-18 (33.10, default chosen, owner to confirm): **the Scene view culls as Play does, and its View menu
  turns culling off for the view only.** Play follows the project's `occlusion_culling` (Project Settings); the
  menu is a view option like the Gizmos menu (not stored), so a comparison in the editor never changes the game.
  "Show culled draws" boxes what is culled whole (block, architecture and merged cells, models alone) or hidden
  by the queries; copies culled on the GPU are counted, not boxed (their visibility stays on the GPU). While the
  boxes show, the view draws every frame: the GPU's answers come frames after the draw that asked.
- 2026-10-18 (33.10): **what the user works on is never culled**: the selection with its subtree and the objects
  an edit mode edits (with Context too: then isolation hides nothing, so the viewport names them itself). Their
  draws are marked kept (`keepFromOcclusion`, read by `occlusionMayTest`: every path draws them whole); one drawn
  through a batch or a merged cell keeps that whole draw (`drawOf` on the batcher and the merger) instead of
  leaving it: a selection never regroups (rendering.e2e: the selected box stays in its batch). Gizmos, outlines,
  handles and brush cursors live in the view's overlay group or hang on objects (`attachOverlay`); both are marked
  a host's own drawing (`markHostDrawing`) and are never occludees.
- 2026-10-18 (33.10, default chosen, owner to confirm): **editor Play passes `?occlusion=` and `?portals=off` on**,
  as it does `?batching=off`, `?ao=` and the rest, and the Scene view reads them too: a comparison names one path
  in every view of the page.
- 2026-10-18 (33.10): the stand-ins' depth in an idle Scene view (33.7's note) is no defect: on a single-sampled
  scene pass target (the editor's low quality; a post stack without MSAA) the queries' render draws them into the
  depth texture itself, where they stay until the next frame's clear, also while the view is idle; nothing reads
  that texture between frames (ambient occlusion, fog, depth of field, transparent draws and the next boxes read it
  inside a frame, after its clear). The module's comment said they never reach it; corrected. Leaving them out of
  single-sampled targets would lose their culling wherever ambient occlusion runs.
- 2026-10-18 (33.10): **the decal atlas flake** (`layered-material.e2e.ts` via `projected-decals-scene.ts`, "the
  preview pages drawn from"; 2 of 7 runs in 33.8, once in 37.8): the 2026-10-17 gate log received `true false
  true`: no preview. The backend builds the next Play ahead once a file check ran and the project was left alone
  for a second (`PLAY_BUILD_AHEAD_IDLE_MS`); that build composes the decal pages into the import cache, and when
  it finished before Rebuild the atlas was warm, so Rebuild answered the pages themselves. The test now takes
  either: cold, the preview checks as before; warm, the pages drawn at once, "Made in", no request held. The
  backend's `decal-pages.test.ts` covers the cold preview every run.
- 2026-10-18 (33.12): **the village's slower frame is the hiz path, not the host.** Interleaved against the phase's
  start, the gate's WebGPU p50 is 0.6–0.8 ms higher and equal with `?occlusion=off`; 33.4's two-pass frame and 33.5's
  copy culling each add about half (D282). Default chosen, owner to confirm: the baseline is not re-recorded (the brief
  allows that only after a measured speedup) and `auto` stays `hiz`, so the fast gate's perf check misses about half its
  runs until D282 is worked; the owner weighs a cheaper open view against a new baseline.
- 2026-10-18 (33.12): fixed in 33.10's overlay: on WebGL 2 the culled draws' boxes were counted (`data-occlusion-view`)
  but never drawn: the line geometry was first drawn without a position buffer and the one set on it later was never
  drawn. The overlay now makes its geometry with the buffer and a new geometry when it grows; rendering.e2e's Scene view
  test counts the boxes' magenta pixels on both renderers, not only their number.
- 2026-10-18 (33.12): fixed in 33.5's read-back: a read in flight when Play stopped finished after the renderer was
  disposed, and three's dispose bookkeeping for its buffer threw an uncaught error on the page; the late release is now
  guarded.
- 2026-10-18 (33.12): the acceptance's level was driven through the UI by a one-off driver outside the repo (no new e2e
  file): the editor's Play button, script keys for poses, a flight and a door (`clearEdge`: a piece opened with
  `setEdgeOpen` keeps its look, so the room behind stays hidden by it), the View menu and File → Export game. The level
  has no animated water (a river's water mesh never settles for a strict picture comparison).
- 2026-10-18 (review fixes, default chosen, owner to confirm): **`occlusion_culling` gains `2` = on, and `auto`
  (and absent) culls nothing on either renderer** (D282, the review's recommendation). On is the depth pyramid on
  WebGPU and the occlusion queries on WebGL 2; a quality level's `occlusionCulling` is `off | auto | on`. The
  village baseline is not re-recorded. Interleaved `village --gate` against `60bd1f69` (3 rounds): WebGPU p50 base 5.6/5.6/5.6 against after 5.6/5.6/5.7 ms, WebGL 2 4.7/4.7/4.8 against 4.6/4.7/4.8 ms (load 2.9–4.9): equal, inside the gate's limits (6.16 / 4.84 ms) again.
  Adaptive auto is its own follow-up with the review's entry criteria (D286).
- 2026-10-18 (review fixes, default chosen, owner to confirm): **WebGL 2's occlusion queries stay, off by default**
  (on with the setting's 2): the owner put them in the phase's scope, so their removal is the owner's call; the
  reviewer's case is D287.
- 2026-10-18 (review fixes, default chosen, owner to confirm): **the `_OCC` import check is stricter than the LOD0
  bounds**: seen along each axis from both sides on a coarse grid (`OCCLUDER_COVERAGE_TEXELS` = 64 texels along the
  piece's longest side), a stand-in may cover only where the piece's LOD0 triangles are (within a texel) and never
  stand in front of them (`occluderCoverageBreaks`, project-model; the backend's Problems and the adapter's drop use
  it). It rejects a box over an arch's opening, an L-shaped piece's notch, the gap between a fence's posts, a plant
  of two crossed cards; it cannot see a texture's cut-outs or see-through materials, so a stand-in inside a hedge
  of leaf cards or behind glass still passes and what shows through it is culled: the manual now says so plainly
  (occlusion.md, assets.md, the trim sheet spec). Chosen over a convex-hull test (an arch's hull holds its
  opening) and a voxel inside/outside test (needs a watertight piece; cards are not). rendering.e2e's fence gained
  a panel in its LOD0 (posts and stand-in alone are now refused); its glass pane behind the fence no longer checks
  the stand-in's depth there (the panel hides it): the pyramid-only stand-ins stay covered by the on/off pixel
  equality at the fence.
- 2026-10-18 (review fixes): what moves its vertices past its bounds with no known bound is no occludee and never
  culled (`vertexReachOf`, vertex-reach.ts: skinned and morphed meshes, any position node without a declared
  reach: a graph's vertex offset or displacement, impostor billboards); the foliage shader declares its wind's reach
  from the wind now (strength + gust, bend, sag, flutter; its constants defined once), and both paths grow copies'
  spheres, whole draws' boxes and query boxes by it, asked each frame (a material compiled again in place is caught
  at the test). Terrain pages bound their own heights. The landscape flight still culls 5085 of 9222 tested.
- 2026-10-18 (review fixes): the second render hides only first-pass draws without children while it walks the
  scene (`liftedForSecondPass`): a glass, role-`none` or light child of an animated model's mesh is found again.
  vitest only (no animated-model fixture in an e2e file; unverified by pixels).
- 2026-10-18 (review fixes): **the pools keep copies by slot**: an instanced draw's matrices and spheres are written
  only when a copy changes (`InstanceViewDraw.slots`), and a moving view uploads only its order (4 bytes a copy);
  the vertex stage reads the slot at the listed place (the slots pool is bound beside the matrices; `instanceIndex`
  keeps meaning the place). 60 s landscape flight, WebGPU, 60 Hz, culling on, before → after: buffer writes 148 →
  124 a frame, 1705 → 1250 KiB a frame (off: 1174–1178 KiB), main thread 7.10 → 7.11 ms (off 6.07 / 6.23), 0
  refreshes missed both: the upload was not where the flight's +0.9 ms main thread goes (D282: the second pass's
  encode and the per-draw upkeep remain).
- 2026-10-18 (review fixes): **one triangle floor**: `OCCLUSION_MIN_TRIANGLES` is 2048 (the 64 was dead on every
  path; `OCCLUSION_MIN_COPIES_TRIANGLES` is gone), shared by `occludeeClassOf`, the copies' in-view check
  (`copiesInViewWorthCulling`, both paths) and the whole draws'. The queries ask no transparent draw (as the
  pyramid path) and use `occludeeScreenShare`. Leaving `hiz` frees the pyramid, pools and kernels (`dropFrame`). A
  three without `NodeMaterial.setupObserver` turns GPU culling off with a diagnostics error instead of drawing with
  stale pools. The editor's view keeps drawing while the queries path hides something. `INSTANCE_MATRIX_FLOATS`
  is the drawn buffer's stride, defined once (`COPY_FLOATS` is it).
- 2026-10-18 (review fixes, default chosen, owner to confirm): the hidden-caster regression is in rendering.e2e's
  Scene view occlusion test, not the rooms pose: the layered-material rooms scene has no shadow-casting light (its
  sun and lamp cast none) and one would move its lighting reads. There a culled block behind a wall, lit by a low sun
  from the side, shadows a panel beside the wall; its `castShadow` off changes the picture (both renderers; the
  shadow on the panel seen in the test's WebGPU shots). The door opening rides the rooms' export pose
  as asked: a script takes the door piece away on a key with culling on; C is counted seen and the picture equals
  culling off.
- 2026-10-18: **the phase review** (an independent agent, static review of `60bd1f69..7fc09308`; 14 findings, no
  High; full text `~/.cache/thirdlight-phase33/review.md`). Checked and fine: no file over 2,000 lines (adapter.ts
  1,943, viewport.ts 1,941), no history comments or new `eslint-disable`, the export imports no editor/server/MCP
  code, one culler for Play and the editor, shadows/probes/the static shadow draw every copy, MSAA/render
  scale/dynamic resolution follow the scene pass's size, painted copies keep their paint slot, a camera cut costs
  time not pixels, the read-back is safe after dispose, the colour-mask fix, one `_OCC` rule for backend and
  adapter, every new private hook on the upgrade checklist. Findings and what was done:
  - **M1** the second render's `visible = false` hid an animated mesh's glass, role-`none` and light children:
    fixed (only childless draws are hidden; vitest).
  - **M2** vertex displacement (wind, graph offsets, skinning, morphs) was in no bound: fixed (`vertexReachOf`:
    no bound → never culled; wind declares its reach and grows the bounds; vitest).
  - **M3** the flight's +0.82 ms main thread, blamed on re-uploading 84 bytes a copy: slot-ordered pools done
    (uploads −27 % a frame), main thread unchanged (7.10 → 7.11 ms): the upload was not the cause; D282 updated.
  - **M4** `_OCC` against "nothing visible is culled": the manual now says plainly that what shows through a
    stand-in's gaps or glass disappears; the import check also rejects stand-ins over openings or in front of the
    surfaces, seen along the axes (vitest; rendering.e2e's fence fixture adjusted).
  - **M5** no regression for a door opening and a hidden caster's shadow: door added to layered-material's rooms
    export pose; the shadow to rendering.e2e's Scene view occlusion test (the rooms scene has no shadow-casting
    light).
  - **D282 recommendation** taken: `auto` = off on both renderers, `2` = on; adaptive auto is D286. **WebGL 2
    queries** kept (owner's scope), the removal case is D287.
  - Lows fixed: L6 (no transparent queries, shared floor and screen share), L8 (one floor, 2048), L9 (pyramid and
    pools freed off `hiz`), L10 (no observer hook → GPU culling off, reported), L12 (one stride constant), L13 (the
    editor redraws while the queries hide). Left (D288): L7 kernel vs CPU twins, L8's dense re-measure, L9's
    page-wide counters, L11 the no-post-stack profile, L14 the e2e budget.
  - **Needs the owner's eyes:** D282 (culling off by default; on where measured), D287 (remove the WebGL 2
    queries?), the `_OCC` semantics (what shows through a stand-in'd hedge or glass is culled), D253 (the full gate
    at 26 min against 15), and the §7 defaults still to confirm (33.9 dropped, per-member merged cells dropped,
    stand-ins drawn last and only into the pyramid, the View menu for the view only, editor Play passing
    `?occlusion=`/`?portals=`). Unverified: a hidden caster's shadow by eye, frame-by-frame equality while the
    camera moves on WebGPU (stops only), the GPU ms targets (D283), dynamic resolution's pixels, WebGL 2 `_OCC`
    pixels, the overlay for copies (D284), M1's children by pixels.

