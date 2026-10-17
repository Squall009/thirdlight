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
| 33.3 | |
| 33.4 | |
| 33.5 | |
| 33.6 | Scope cut by 33.1: merged cells culled as whole draws, no per-member compaction (§7). |
| 33.7 | |
| 33.8 | |
| 33.9 | Dropped by 33.1 (§7, default chosen, owner to confirm). |
| 33.10 | |
| 33.11 | |
| 33.12 | |

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

