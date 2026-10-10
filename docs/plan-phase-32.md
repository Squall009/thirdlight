# Phase 32 — Decals and vertex paint

Goal: a level gets the detail that breaks up repetition (dirt, cracks, stains,
leaks, signs, puddles, scorch marks, worn edges) without new unique
textures. Four generic tools do it:

- mesh decals: decal geometry authored in a GLB or generated, drawn over a
  surface with a depth offset and a blend;
- projected decals: a box projector that marks any surface under it (blocks,
  terrain, generated architecture, props) on WebGPU and WebGL 2;
- clipped decals: the editor's placement tool clips a decal mesh onto the
  surfaces under a projector (the `DecalGeometry` idea), and static ones
  merge into the static cells;
- vertex paint: per-vertex colour and blend weights painted on props and
  generated meshes, stored beside the mesh, read by material graphs.

All of it holds 60 fps at 1080p on an integrated GPU.

**Release checks run when the phase starts (32.0), not in this plan:** the
three.js release check (a patch is taken in the first item after reading
its notes; a minor is its own item) and the Rapier check (`0.20.0` pinned,
`packages/physics-rapier/package.json:12-13`). This plan was written against
three `0.186.1`.

Read `docs/roadmap.md` (principles 1, 3 and 7) first. Phase 32 starts after
phase 31 (documentation). It uses phase 28c's render graph and static
merging, phase 29's light layers, probes and cached shadows, and phase 30's
trim sheets, generated architecture, rooms, terrain and streaming. Requests:
the owner (2026-09-29, 2026-10-03, 2026-10-06) and Skyforge Tactics E63
part 3 (`specular` on the graph `pbr` output; `docs/plan-phase-28.md:50`).
No game has asked for decals; nothing here is fitted to one game.

## 1. Owner decisions (2026-09-29 / 2026-10-03 / 2026-10-06)

- **The four tools are the phase** (roadmap row 32): mesh decals, projected
  decals, `DecalGeometry`-style placement, and mesh vertex painting with the
  25.21 paint brush. Scene depth as a material input was brought forward to
  30.14 (river shorelines) and exists (`sceneDepth`, §2).
- **Projected decals are evaluated in the material** (Godot-style, roadmap
  row 32): three.js r186 has no deferred G-buffer and no decal buffer, so a
  decal changes the receiving surface's albedo, normal, roughness, metalness,
  occlusion and emission before it is lit. Works the same on both renderers.
- **Painted copies stay in their instanced draw** (roadmap row 32): paint is a
  per-copy stream the shader reads by instance and vertex index (Unity's
  additional vertex streams, §3).
- **Performance first, with soft targets** (roadmap principle 7, §5). A miss is
  recorded with its cause and a follow-up, never a reason to throw an item
  away.
- **Formats stay additive** (verdict 2026-10-04 §7): new fields and
  components are optional on schema 7 (`PROJECT_SCHEMA_VERSION`,
  `project-model/src/upgrade-v24.ts:35`); an absent field keeps the old
  look and the old bytes. No schema bump unless an item proves it needs one.
- **No per-project count caps** on decals or painted objects. Budgets for
  cost (overlaps a pixel pays for, decal texture memory, transient decals in
  view) are fine, each defined once in the package that owns it.

Defaults this plan chooses, owner to confirm (repeated in §7):

- **Default chosen, owner to confirm:** projected decals are found per pixel
  through a world-space grid index (the `probe-index.ts` pattern), not a
  per-frame screen-cluster build and not a per-draw list. Batches and merged
  cells span many objects, so a per-draw list would be the union of all
  their decals.
- **Default chosen, owner to confirm:** mesh and clipped decals blend their
  own lit colour over the surface (`blend`, `multiply` for stains, `add` for
  glow). Per-channel blending (normal only, roughness only: wet patches,
  scratches) is for projected decals. A forward renderer can't blend a
  normal into a surface that is already lit (Unreal's mobile forward path
  likewise applies only base colour and emissive to the lit colour, §3).
- **Default chosen, owner to confirm:** clipped decals store the projector,
  not the triangles. Their mesh is clipped at load from the receivers'
  current geometry (on a worker, cached by a hash of the inputs), as
  generated architecture is. A "Bake to model" action writes a GLB for hand
  editing.
- **Default chosen, owner to confirm:** vertex paint is a separate 4-byte
  stream (`tlPaint`). Absent, it reads (0, 0, 0, 0): no change. It never
  replaces a model's own `COLOR_0`. Generated meshes keep paint in path
  space (distance along the path × height or width), so it survives
  regeneration.
- **Default chosen, owner to confirm:** receivers carry a `decalLayers` mask
  (8 layers, absent = all; HDRP decal layers, Godot `cull_mask`). Skinned
  meshes default to none: a world projector does not follow skin.

## 2. Where things stand (checked at `a4e4a7fa`, 2026-10-09)

- **No decal system.** The only `decal` key in the code is a test fixture
  that checks unknown components' texture references are followed
  (`game-host/src/asset-reader.test.ts:139`). The `castShadow` help text
  names decals (`project-model/src/descriptor-components.ts:75`, `:100`).
- **Depth offset is used twice, ad hoc:** scatter blob shadows
  (`three-adapter/src/scatter-shadows.ts:38-45`: transparent, no depth write,
  `polygonOffset` −2/−2, a 3 cm lift) and the block editor's preview
  (`editor/src/viewport/block-editor.ts:1138`). On WebGPU, three turns
  `polygonOffset` into the pipeline's `depthBias`
  (`node_modules/three/src/renderers/webgpu/utils/WebGPUPipelineUtils.js:238-241`),
  so each distinct offset is another pipeline. The project can pick a
  standard, reversed or logarithmic depth buffer
  (`three-adapter/src/renderer-factory.ts:332`, `adapter.ts:890`). A
  logarithmic buffer writes depth in the fragment shader, which slope
  offsets don't reach.
- **Scene depth exists** as a graph input: `sceneDepth`
  (`project-model/src/material-graph-kinds.ts:171-178`; compiled at
  `three-adapter/src/material-graph.ts:1099-1107` from three's
  `viewportDepthTexture`, a copy of the depth buffer before the surface
  draws). Soft particles read the depth the same way (`effects-draw.ts:348`).
- **Materials:** shader types `standard | foliage | kit | unlit | water |
  trim` (`project-model/src/materials.ts:29`). There is no decal type, no
  blend mode beyond `alphaMode` opaque/cutout/blend, and no depth offset. Graph
  surfaces have only `doubleSided`, `transparent` and `castShadows`
  (`material-graph-kinds.ts:89-95`). The `pbr` output has no `specular`
  (`material-graph-kinds.ts:500-520`; E63 part 3). A model maps its glTF
  material names to project materials (`materials` in the asset record,
  `manifest-v2.ts:257`; `three-adapter/src/material-library.ts:1-40`).
- **Hooks into every material:** the engine already patches three's
  `NodeMaterial` prototype for attribute instancing and per-vertex lights
  (`attribute-instancing.ts:71-74`, `local-lights.ts:449`). three r186's
  `NodeMaterial` has `setupDiffuseColor`, `setupNormal` and `setupVariants`
  (`node_modules/three/src/materials/nodes/NodeMaterial.js:819`, `:936`,
  `:914`; `MeshStandardNodeMaterial.js:149`). A decal node can enter there.
  Probe light enters every lit material through one light that is present
  only while a bake has probes (plan-phase-29 §7). So a scene without probes
  builds the same programs as before.
- **Vertex colours today:**
  - Model `vertexColors: 'tint'` multiplies albedo; absent, `COLOR_0` is
    shader data (`manifest-v2.ts:254-255`, `descriptor-content.ts:667`).
  - The foliage shader reads `COLOR_0` as wind (`materials.ts:67-69`).
  - The trim shader reads `COLOR_0` as R occlusion, G grime, B wetness
    (`materials.ts:109-111`, `trim-sheet.ts:35-38`, `:83-86`). The generator
    writes AO into R (`arch-generate.ts:4`). The block layer's wall paint is
    sampled onto trim vertices in world space (`trim-paint.ts:1-10`).
  - Block chunks carry paint weights in `COLOR_0` and wetness in `COLOR_1`
    (`block-paint.ts:15`, `block-paint-mesh.ts:2`).
  - The graph's `vertexColor` node reads `COLOR_0` or `COLOR_1`, with a value
    for meshes that lack the set (`material-graph-kinds.ts:126-140`).
- **No mesh vertex painting.** The brush is its own module "so painting other
  targets (mesh vertex colours, a later phase) reuses it"
  (`project-model/src/paint-brush.ts:1-5`, limits `:24`). Strokes are
  deterministic bytes, the same in the editor's preview and on the backend.
  Instance-brush strokes show the command pattern: a stroke becomes one
  command and one undo step. The backend publishes a new content-addressed
  buffer, so undo points back to the old one (`commands/src/instance-stroke-ops.ts:1-14`).
- **Trim sheets have decal cells, which import skips:** the Texture
  Designer's `layout.json` lists a `decals` layer of square cells with
  `uv_rect` and `size_m` (art-factory `studio/service/texdesign/trim.py:12`,
  `:615-640`). `trimSheetFromLayout` lists them in `skipped`
  (`project-model/src/trim-sheet.ts:417`, `:433`).
- **Drawing constraints:**
  - The three.js scene holds only drawables (`render-graph.ts:1-10`).
  - The batcher refuses transparent meshes (`batching.ts:123`), so today
    every blended mesh is its own draw.
  - Static merging keys cells by material, shadow flags, light layers,
    local-light mode, room, cell and vertex layout (`static-merge.ts:508-513`).
    It refuses materials that read the object frame (`:130-135`). Merged cells
    draw first (`MERGED_RENDER_ORDER` −1, `:66`).
  - View culling reorders instance matrices and merged indices per view
    (`view-cull.ts` header). So per-copy data must travel with the copy, not
    sit at its draw index.
  - Rooms give drawables a room key and cull unseen rooms
    (`room-culling.ts:1-25`).
  - Light layers test each object on the CPU with a per-object uniform, so
    they add no shader variants (`light-layers.ts:1-25`).
- **three's `DecalGeometry`** (`node_modules/three/examples/jsm/geometries/DecalGeometry.js`)
  clips one mesh's triangles against the six faces of a box and writes
  world-space positions, normals and box UVs. Its limits:
  - one target mesh per call;
  - a JS object per vertex (slow on big meshes);
  - no index and no tangents in the output;
  - no rejection by surface angle (it projects onto back and side faces);
  - base positions only (no skinning or morphs).

  Its example draws the result with `polygonOffset` −4 and no depth write.
- **Big files near the split line:** `three-adapter/src/adapter.ts` 1,864
  lines, `editor/src/viewport/viewport.ts` 1,878,
  `three-adapter/src/material-graph.ts` 1,678. An item that grows one of them
  past 2,000 lines first moves its area into its own module.

## 3. How other engines do it (from their documentation, 2026-10-09; re-read 2026-10-10)

| Topic | Unreal 5 | Unity URP / HDRP | Godot 4 | three.js r186 | Thirdlight after phase 32 |
|---|---|---|---|---|---|
| Projected decals | Decal actor (box). Deferred Decal material domain. The DBuffer is the default: decals are written into a decal buffer before the base pass, and base-pass materials read it. The GBuffer path blends after the base pass [1] | URP Decal Projector. Techniques: DBuffer (needs a depth-normal prepass; surface data Albedo / +Normal / +MAOS) or Screen Space (decals lit as meshes over the opaque scene, normals rebuilt from depth with 1/3/5 samples) [3]. HDRP projector: thousands of instanced decals, a decal atlas (opaque receivers), decal layers; transparent receivers through clustered structures, only with the Decal shader and without emission [4] | `Decal` node: an AABB projected along −Y. Albedo, normal, ORM and emission textures. `cull_mask`, `normal_fade`, upper/lower fade, distance fade, `albedo_mix`. Clustered decals are evaluated while the mesh draws. Forward+ only (512 clustered elements, lights included); Mobile 8 per mesh; not in Compatibility [5] | None (no G-buffer) | Box projector. Evaluated in every receiving material before lighting. Found per pixel through a world-grid index. Per-channel opacities, normal fade, edge and distance fades. Both renderers (32.6) |
| Mesh decals | Mesh decals: geometry placed just off the surface; there is no adjustable depth bias (offset the mesh or use World Position Offset). They update the DBuffer/GBuffer after the opaque geometry without writing depth, and are cheaper than projected ones (fewer draws; a flat decal facing away covers no pixels). No artist sort order (sort by depth) [2] | HDRP decal meshes: only on opaque surfaces, no decal layers [4] | None built in | Any transparent mesh with `polygonOffset` (the `DecalGeometry` example) [6] | `decal` material mode: blend / multiply / add, a depth push in the vertex stage, a sort order, merged into static cells (32.5) |
| Placement by clipping | Not built in (mesh decals are authored) | Not built in | Not built in | `DecalGeometry` (one mesh, CPU) [6] | Typed-array clipper over several receivers, run at load, cached; Bake to model (32.7, 32.8) |
| Vertex paint | Mesh Paint mode: per-instance vertex colours stored on the component, not the asset; can be copied between instances [7] | `MeshRenderer.additionalVertexStreams`: a second mesh whose attributes override or add to the first, used by vertex painters; not with GPU instancing or dynamic batching [8] | None built in (add-ons) | — | `tlPaint` stream per object, per copy in instance sets (still one instanced draw), path-space paint on generated meshes (32.10–32.12) |

Re-read 2026-10-10: Unreal's mesh-decal page says there is no adjustable
depth bias and no artist sort order (the table above is corrected); its
decal-materials page says mobile forward applies only base colour and
emissive to the lit colour, and mobile deferred uses GBuffer decals without
AO. HDRP's transparent receivers take projectors only with the Decal shader,
without emission. URP, Godot (stable docs now 4.7) and three's
`DecalGeometry` and `webgl_decals` (`polygonOffsetFactor` −4, no depth
write) are as written. Nothing changes the plan: our mesh decals keep their
vertex-stage push and their sort order (32.5).

Notes. Every engine's projected decals need either a prepass and an extra
buffer (Unreal DBuffer, URP DBuffer), a lit pass over rebuilt normals (URP
Screen Space), or decals evaluated in the receiving material from a list
(Godot clustered, HDRP clustered on transparent surfaces). Thirdlight's
frames are CPU-bound on draw calls (plan-phase-29 §6), so a depth-normal
prepass that draws everything twice is out. URP Screen Space blends the
decal's lit colour, so it loses per-channel blending. That leaves the
in-material list, the design the roadmap chose.

Sources:
[1] https://dev.epicgames.com/documentation/en-us/unreal-engine/decal-materials-in-unreal-engine, https://dev.epicgames.com/documentation/unreal-engine/decal-actors-in-unreal-engine
[2] https://dev.epicgames.com/documentation/unreal-engine/using-mesh-decals-in-unreal-engine
[3] https://docs.unity3d.com/6000.3/Documentation/Manual/urp/renderer-feature-decal-reference.html, https://docs.unity3d.com/Packages/com.unity.render-pipelines.universal@17.0/manual/renderer-feature-decal.html
[4] https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/understand-decals.html
[5] https://docs.godotengine.org/en/stable/classes/class_decal.html, https://docs.godotengine.org/en/stable/tutorials/3d/using_decals.html
[6] `node_modules/three/examples/jsm/geometries/DecalGeometry.js`, https://threejs.org/docs/pages/DecalGeometry.html, https://github.com/mrdoob/three.js/blob/dev/examples/webgl_decals.html
[7] https://dev.epicgames.com/documentation/en-us/unreal-engine/mesh-paint-overview-in-unreal-engine, https://dev.epicgames.com/documentation/en-us/unreal-engine/paint-vertex-colors-tool-in-unreal-engine
[8] https://docs.unity3d.com/ScriptReference/MeshRenderer-additionalVertexStreams.html

## 4. Items

Order: measure → data → textures → mesh decals → projected decals → clipper
→ clipped decals → editor placement → vertex paint (data, drawing, editor)
→ acceptance. Within an item: data and commands → runtime and adapter →
editor → export → tests.

Rules for every item:
- Format changes are additive on schema 7.
- Every editor change has a Playwright test against a real backend.
- Drawing changes check pixels on both renderers, and the Scene view against
  Play where the item draws in both.
- Every item records its numbers against §5 in its progress row, before and
  after, in the same session (A/B against the phase start, D199).

**E2E budget (D181):** the full gate is over its 15 min budget. The phase
adds no new e2e file. Its browser checks extend the files named in each
item, about 60 s of e2e time for the whole phase. Clipping, indexing, paint
bytes, streams and blends are vitest checks, without a browser.

| Item | What |
|---|---|
| 32.0 | This plan, and its rows in `docs/STATUS.md` and `docs/roadmap.md`. The three.js release check (a patch is taken here after reading its notes; a minor is its own item). The Rapier release check (nothing in this phase depends on it; recorded). §3's pages re-read. |
| 32.1 | **Measure first.** Switches on the existing `level --classes area` class (`tools/perf/level.ts`), not a new class:<br>• `--decals N` (projected, spread over blocks, props and generated walls, ~30 % overlapping in pairs);<br>• `--mesh-decals N`, `--clipped-decals N`;<br>• `--painted N` (placed props and instance copies with paint).<br>Record the before numbers in §6 at N = 0: frame p50/p95, GPU passes, main thread, draws, shader modules and pipelines, WGSL size. Both renderers, Iris Xe, 1080p uncapped. The switches do nothing until their item lands; each item fills in its row. |
| 32.2 | **`specular` on the graph `pbr` output** (E63 part 3). Optional `specularIntensity` (float) and `specularColor` (vec3) ports. Only a graph that connects one compiles to a physical node material. Others stay `MeshStandardNodeMaterial` with byte-identical WGSL (vitest on the compiled source). A GLB's `KHR_materials_specular` survives a graph that maps its inputs. Pixels in `material-graph-render.e2e.ts` on both renderers: a highlight at F0 0.024 vs 0.04. |
| 32.3 | **Decal data.**<br>• A `decal` component:<br>  – `size` (box, metres; projects along the entity's −Z);<br>  – `mode` `projected \| clipped`;<br>  – `material` (a decal material);<br>  – per-channel opacities: albedo, normal, roughness, metalness, occlusion, emission;<br>  – `normalFade` (degrees);<br>  – edge fades near the box's ends, `fadeDistance`;<br>  – `sortOrder`;<br>  – `layers` (8-bit mask).<br>• A `decalLayers` field on box, model, instances, blockLayer, terrain, architecture and spline (absent = all; skinned meshes default to 0).<br>• A material shader `decal`: albedo + opacity, normal, ORM, emissive; or a trim sheet and a cell name; `blend` `blend \| multiply \| add` for mesh use.<br>• `trimSheetFromLayout` keeps the decal cells as named rectangles (`cells`, additive) instead of skipping them.<br>• Descriptors, validation, Inspector fields, MCP through `setComponent`.<br>• Vitest: round trips, absent fields, old projects unchanged.<br>**Done when** a project with decals saves, reopens and exports, and a project without them is byte-identical. |
| 32.4 | **Decal textures.**<br>• Decal textures go into decal pages: texture arrays per channel set (albedo + opacity, normal, ORM + emissive mask), packed with 28b's KTX2 array packing. Each decal is a rectangle on a page.<br>• A trim sheet's decal cells are rectangles on a page made from that sheet (no copy when its size matches the page size).<br>• Rectangles keep a gutter. Sampling caps the mip at the rectangle's safe level, as the trim shader does with its rows.<br>• Pages load and stream through phase 26's resource manager under the project's texture budget. They are counted in diagnostics (`renderer.decals.pages`, bytes).<br>• Vitest: packing, gutters, the mip cap.<br>**Done when** decal textures from loose images and from a trim sheet's cells reach the GPU as pages in Play and the export, within the texture budget. |
| 32.5 | **Mesh decals.**<br>• **How a decal draws.** A mesh whose material is a `decal` material:<br>  – is transparent, writes no depth and casts no shadow;<br>  – is lit like any surface (probes, light layers, its room);<br>  – is pushed toward the camera in the vertex stage by a view-space bias that grows with distance, so it works with every depth buffer mode, plus one fixed `polygonOffset` where the depth is standard (one pipeline, not one per value);<br>  – blends with `blend`, `multiply` (an albedo stain over the lit colour) or `add` (glow);<br>  – draws in the transparent list before other transparent surfaces (water), in `sortOrder`.<br>• **GLBs.** The asset's material map assigns decal materials. On import, a glTF material named `*_decal` maps to one by default.<br>• **Graph materials.** A graph material's surface flags gain `decal` (the blend and the bias).<br>• **Merging.** Static decal meshes merge into static cells: the merge key gains the sort order. The batcher's `transparent` refusal lets decal materials through. Inside a cell, indices follow sort order.<br>• **Tests.** Pixels in `materials.e2e.ts` on both renderers and every depth mode: no z-fighting at 2 m and at 80 m on a grazing floor; `multiply` darkens and `add` brightens the surface under it; Scene view = Play. |
| 32.6 | **Projected decals.**<br>Part A, drawing:<br>• A decal table (each decal's world-to-box matrix, rectangles, opacities, fades, layers, sort order) and a world-grid index of decals by cell (the `probe-index.ts` layout: a header per cell, then entries), both data textures.<br>• A decal node enters every lit node material through the `setupDiffuseColor` / `setupNormal` / `setupVariants` hooks. It is present only while the scene has a projected decal, so a scene without decals builds the same programs and WGSL as before.<br>• Per pixel:<br>  – look up the cell, loop over its entries;<br>  – test the box, the receiver's `decalLayers` (a per-object uniform, as light layers do) and the normal fade;<br>  – sample the pages with gradients from the world position's derivatives (correct mips inside the loop);<br>  – blend each channel by its opacity, in sort order.<br>• Normals: the decal's tangent-space normal in a frame built from the surface normal and the projector's axes, blended with the surface's normal.<br>• Works on blocks, terrain (CDLOD heights are per pixel), generated architecture, props, instance copies and merged cells alike.<br>• `?decals=off`.<br>• Pixels in `layered-material.e2e.ts` on both renderers: a projected decal crossing a block wall, terrain and a generated wall; normal-only and roughness-only decals change only their channel; a receiver outside the decal's layers stays clean; Scene view = Play.<br>Part B, change:<br>• A decal parented to a moving entity is re-indexed when it moves (only its cells).<br>• Decals spawned at run time from prefabs (bullet holes, footprints) fade out oldest-first past the transient budget.<br>• A cell over its overlap budget drops the lowest sort order and counts it (`renderer.decals.dropped`, a `decal_overlap` problem). Distance fade.<br>• Vitest: index updates and budgets. One pixel check in Play for a spawned decal. |
| 32.7 | **The clipper.** A pure, typed-array clipper in project-model (no three.js; runs on the backend, in workers and on the page):<br>• clips the triangles of several receivers inside a box;<br>• rejects faces past the normal fade;<br>• welds and indexes;<br>• writes positions relative to the decal entity, normals, box UVs into the decal's rectangle, and tangents;<br>• lifts vertices along the normal by a millimetre-scale amount.<br>Receivers: models (base pose), block chunk meshes, generated architecture chunks, spline meshes. Terrain is left to projected decals, because its CDLOD levels change the surface with distance. Deterministic (no `Math.sin`, the generator's own trig).<br>Vitest: a box over a corner, a curved model, an architecture moulding, faces past the fade; output stable across runs; time per receiver triangle measured. |
| 32.8 | **Clipped decals at load.**<br>• A `clipped` decal is clipped on a worker (the architecture worker pool) at load and when a receiver it touches changes: a block chunk re-meshed, an architecture group re-expanded, a model reimported.<br>• Cached by a hash of the projector, the receivers' geometry hashes and the clipper version (the editor's cache, IndexedDB in the export), like generated architecture.<br>• Static ones merge into the static cells through 32.5's decal key. Dynamic ones (parented to a mover) follow their parent as a child mesh.<br>• "Bake to model" writes the clipped mesh as a GLB asset with its decal material mapped, and turns the component into a placed model.<br>• Pixels in `level-acceptance.e2e.ts` (both renderers): a clipped decal across a generated wall's corner and its moulding survives a regeneration of the wall.<br>**Done when** a level's clipped decals are ready before the first frame in Play and the export, within §5. |
| 32.9 | **Editor placement.**<br>• A Decal tool in the Scene view: click a surface to place a projector aligned to its normal; rotate about the normal and scale with handles; a live preview (projected or clipped).<br>• A picker of decal materials and page rectangles (trim cells by name).<br>• Shift+click stamps more with a random rotation and scale (seeded).<br>• Every placement is one `createEntity` + `setComponent` through the command path, so MCP places decals the same way.<br>• Playwright in `handles.e2e.ts`: place, rotate, scale, undo, switch mode, Bake to model; the result in Play. |
| 32.10 | **Vertex paint data and command.**<br>• A `vertexPaint` component on a model entity: per mesh (node path), a content-addressed blob of 4 bytes a vertex, tied to the model version's vertex count and position hash.<br>• On an instance set: a sparse table (copy address → paint slot) and a slot pool.<br>• On generated meshes (architecture outlines, spline meshes): path-space paint, a 2D grid per path side (distance along × height or across, ~0.25 m), sampled onto vertices whenever they are made (the `trim-paint.ts` way).<br>• One `paintVertices` command: the brush's dabs (`paint-brush.ts`; channel, strength, falloff, erase), applied on the backend; one command and one undo step per stroke (the `instance-stroke-ops.ts` pattern).<br>• A reimport that changes a mesh's vertices keeps the old blob and reports `paint_mismatch` in Problems; the paint is not drawn.<br>• MCP through the same command. Vitest: dabs → bytes, undo, the reimport rule, path paint surviving a regeneration. |
| 32.11 | **Vertex paint drawing.**<br>• **Placed models:** paint is an extra `tlPaint` attribute when drawn alone. In automatic batches each member's paint slot rides in the instance buffer next to its matrix, so it survives view culling's reordering, and the shader reads the stream by slot and vertex index (storage buffer on WebGPU, data texture on WebGL 2). Static merging copies the paint into the merged vertices (unpainted members get 0).<br>• **Instance copies:** the same slot read. Painted copies stay in their instanced draw.<br>• **Materials:** the graph's `vertexColor` node gains set `paint` (appended option). The trim shader adds paint G and B to its grime and wetness. Height blend takes paint as weights. Standard materials gain `paintTint` (absent = off).<br>• No new program when nothing is painted (WGSL compared in vitest).<br>• Pixels in `instances.e2e.ts` on both renderers: two copies of one mesh painted differently in one draw (draw count unchanged), a painted prop merged, a painted generated wall after regeneration. |
| 32.12 | **Vertex paint editor.**<br>• A Paint mode for objects in the Scene view: the shared brush UI (radius in metres, strength, falloff, channel, erase), dabs on the picked surface's vertices within the radius, a local preview on the GPU, then one `paintVertices` per stroke.<br>• Targets: placed models, instance copies (the copy under the cursor), architecture and splines (path paint).<br>• A channel view (show R/G/B/A as greyscale).<br>• Playwright in `instance-brush.e2e.ts`: a stroke on a prop, a copy and a generated wall, undo, the result in Play and the export. |
| 32.13 | **Acceptance.**<br>• 32.1's switches after the phase, split in §6; each item's cost shown by switching it off (`?decals=off`, `?paint=off`).<br>• The limits and budgets in `docs/deployment.md` and the manual, with best practice for decals (projected for per-channel and terrain, clipped or mesh for many static marks, overlap budget).<br>• One level in `level-acceptance.e2e.ts` with every kind on blocks, terrain, generated architecture and props, in Play and the export, on both renderers. |

**Done when:**
- A level shows mesh, projected and clipped decals and painted props, copies
  and generated walls, in Play and the export, on both renderers (pixels;
  look: owner look pending).
- A scene without decals or paint builds the same shader programs as
  before the phase (WGSL compared) and is within noise of its before
  numbers.
- 32.1's switches are measured after the phase on the Iris Xe and recorded
  against §5, with the split saying where any miss comes from.
- The phase adds no e2e file. Its added e2e time is recorded.
- `tools/gate.sh full` is green.

## 5. Soft performance targets

Measured at 1920 × 1080 uncapped on this host's Iris Xe in 32.1's switches
on the `area` class, WebGPU, with WebGL 2 recorded. They guide design; a miss
is recorded with its cause and a follow-up (owner, 2026-10-03).

| Measure | Target |
|---|---|
| A scene without decals or paint | the same programs and WGSL; frame within noise |
| 200 projected decals in view | scene pass + ≤ 0.6 ms GPU; main thread + ≤ 0.1 ms a still frame |
| A pixel under no decal, in a scene with decals | ≤ one index read and a branch |
| Index update for a spawned or moved decal | ≤ 0.2 ms main thread |
| 1,000 static mesh or clipped decals | one draw per cell per decal material; scene pass + ≤ 0.5 ms GPU |
| Clipping | ≤ 5 ms per decal on a worker for 50k receiver triangles; a level's clipped decals ready before the first frame |
| Paint | 4 B a painted vertex; painted copies add no draw; ≤ 0.1 ms GPU for 10k painted copies |
| A brush stroke | preview within the frame; the command p95 ≤ 100 ms |
| Decal pages | inside the texture budget, counted in diagnostics |

## 6. Progress and measurements

| Item | Status |
|---|---|
| 32.0 | Done 2026-10-10: plan committed, STATUS/roadmap rows; three.js 0.186.1 still the latest (r186, no update); Rapier 0.21.0 exists, pinned 0.20.0 kept (nothing here depends on it); §3 re-read and corrected (Unreal mesh decals: no depth bias, no sort order; HDRP transparent receivers). |
| 32.1 | Done 2026-10-10: `level --classes area` (any outdoor class) takes `--decals/--mesh-decals/--clipped-decals/--painted N` (`tools/perf/level-marks.ts`; vitest `tests/perf/level-marks.test.ts`); at 0 the plan is unchanged. Projected, clipped and copy paint are refused until their items land. Mesh decals and painted props have stand-ins, see §7. **Before (N = 0, HEAD 5c630012, two runs, Iris Xe, 1080p, DPR 1, uncapped).** WebGPU: p50/p95 6.6/9.4–9.6 ms; GPU 10.34 ms (scene 4.16, SSAO 1.38, SMAA weights 1.16, output 0.84, RTT 0.72, bloom ~1.3 in total, shadow 0.27); main thread 6.56–6.60 ms; 259–260 draws (scene 237–238); 48 shader modules, 317 KiB WGSL (largest 42 KiB); 27 pipelines. WebGL 2: p50/p95 2.6–2.7/6.8–7.8 ms (p99 123–175 ms: occasional 280–300 ms stalls); main thread 6.64–6.75 ms; 260 draws; 26 programs; GPU not timed (three times only the outer pass). **Stand-ins.** `--mesh-decals 1000`, blended quads: 1029 draws (+769 in view, each its own draw). WebGPU scene pass +0.4 ms GPU, main thread +0.23 ms, +2 modules (+42 KiB WGSL), +1 pipeline. WebGL 2 main thread +0.46 ms, p50 2.7→5.7 ms. 32.5's target is one draw per cell per material. `--painted 300`, an unread 4 B/vertex `COLOR_0`: no change in draws or frame time; merged vertex data 492→532 KiB; 2 more pipelines (the merged layout). Look of the stand-ins seen in the run's screenshots on both renderers; not judged. |
| 32.2 | Done 2026-10-10: `specularIntensity` (float) and `specularColor` (vec3) appended to the graph `pbr` output; a graph that wires either compiles to `MeshPhysicalNodeMaterial` (specular nodes only, no other physical term), every other graph stays `MeshStandardNodeMaterial`. **WGSL identity:** vitest `material-graph-specular.test.ts` digests the WGSL of five graphs without specular (plain, parameter + texture, every slot + flags, unlit, custom-lit), recorded at 90ce82fd before the change: identical after. **Pixels** (`material-graph-render.e2e.ts` `specular`, both renderers): black sphere highlight peak 133 at F0 0.04, 102 at intensity 0.6; a GLB material with KHR_materials_specular 0.6 (three's loader, mirrored placement) 102: equal. **Area class without specular, before/after (same session, Iris Xe, 1080p, uncapped):** WebGPU 48/48 shader modules, 317/317 KiB WGSL, 27/27 pipelines, p50 6.6/6.6 ms, main thread 6.63/6.55 ms; WebGL 2 26/26 programs, p50 2.7/2.6 ms. Also: `tools/perf` is now typechecked by `tools/typecheck.mjs` (it was not; its 8 errors fixed); WebGL 2 uncapped stalls → D235. |
| 32.3 | Done 2026-10-10: data only, nothing draws a decal yet. `decal` component (`project-model/src/decals.ts`, descriptor in `decal-descriptor.ts`: size, mode, material, per-channel `opacity`, `normalFade`, `edgeFade`, `fadeDistance`, `sortOrder`, `layers`); `decalLayers` on box, model, instances, blockLayer, terrain, spline, architecture (absent = every layer, a skinned model none: `decalLayersOf`); `decal` material shader (own map/normal/ORM/emissive or `decal: {sheet, cell}`, `blend`); trim sheets keep layout.json decal cells as `cells` (named pixel rects). Validation (scene, material list, project references), `setComponent`/MCP, Inspector fields, decal source picker and cell list in the material Inspector, export ships the decal material and its sheet. Tests: vitest `decals.test.ts` (round trips, refusals, absent = old bytes), descriptor probes, trim cells, `export.test.ts` (HTTP export ships decal + sheet, not an unused material); the v7 fixtures in `project-files-v4.test.ts` still rebuild byte-identically; Playwright in `inspector.e2e.ts` (decal add/edit/undo/remove, decal layer checkboxes) and `layered-material.e2e.ts` (cells imported, decal source picked). No drawing change, so no perf numbers of its own (village check in the fast gate). |
| 32.4 | Done 2026-10-10: decal pages (`project-model/src/decal-pages.ts` plans rectangles, 8 px gutters, 16 px boxes, per-decal mip caps; backend `decal-page-compose.ts`/`decal-page-assembly.ts` make one UASTC KTX2 per page, join each set's pages into arrays as stored, cache both; the build ships `decals-…` arrays and gives each decal material a `decalPage`; the page holds them per decal entity through the resource manager and uploads them on arrival; diagnostics `renderer.decals`, export canvas `data-tl-decal-pages`). Vitest: packing, gutters, mip cap, composed pixels byte for byte, a UASTC sheet's layer equal to its file level by level, a second export composing nothing; Playwright `layered-material.e2e.ts` (a sheet cell's page in Play and the export, auto + WebGL 2) and `inspector.e2e.ts` (a skinned model's absent decal layers show none). **Numbers (this host):** a composed 2048² page of 49 rects 12.0 s cold (37.8 s at the encoder's default effort), 1024² 2.6 s; joining 8 2048² layers 61 ms; cached: export of the test project 1.1 s vs 1.3 s cold. GPU: 1 B a texel with mips — 5.3 MiB a 2048² page per set; the e2e's 256² page 87,408 B of a 512 MiB budget (fixed textures 0.44 MiB). Nothing draws, so no frame numbers of its own (village check green: WebGPU p50 5.6 ms = baseline). Pixels: none (nothing samples the pages yet; owner look n/a). |
| 32.5 | — |
| 32.6 | — |
| 32.7 | — |
| 32.8 | — |
| 32.9 | — |
| 32.10 | — |
| 32.11 | — |
| 32.12 | — |
| 32.13 | — |

## 7. Decision log

- 2026-10-09: planned from the owner's scope (roadmap row 32, 2026-09-29;
  2026-10-03 and 2026-10-06 notes). Decals moved from phase 30 to 32 on
  2026-10-03. Scene depth was built in 30.14. E63 part 3 is 32.2.
- 2026-10-09 (projected decals, default chosen, owner to confirm): evaluated
  in the receiving material (Godot clustered style, HDRP's path for
  transparent receivers), not as screen-space boxes (URP Screen Space) and
  not with a decal buffer (Unreal and URP DBuffer).
  - A decal buffer needs a depth-normal prepass, which draws everything
    twice; the frames are CPU-bound on draws.
  - Screen-space boxes blend a lit colour, so they lose per-channel
    blending. Receiver masks would need a stencil, and every decal is
    another draw.
  - In the material, each decal costs only the pixels under it. Light,
    probes, rooms and shadows stay the receiver's own. Transparent surfaces
    receive decals too.
- 2026-10-09 (decal index, default chosen, owner to confirm): a world-space
  grid built on change, not a per-frame camera-cluster build and not
  per-draw lists.
  - Static decals cost no main-thread work per frame.
  - Batches, merged cells and instance chunks spread over the scene, so a
    per-draw list would be the union of their decals.
  - Cell size follows the decals' sizes, as the probe index does. A cell's
    list has an overlap budget (`DECAL_CELL_BUDGET`, project-model limits);
    past it, the lowest sort order drops and is reported. That is a cost
    budget per pixel, not a cap on decals in a project.
- 2026-10-09 (mesh decals, default chosen, owner to confirm): they blend
  their own lit colour (`blend`, `multiply`, `add`). Per-channel blending is
  projected decals' only. `*_decal` glTF material names map to a decal
  material on import (a game may rename; the mapping is the asset's
  data).
- 2026-10-09 (depth offset, default chosen, owner to confirm): a view-space
  push in the vertex stage, plus one fixed `polygonOffset` on standard depth.
  Per-material offsets would make one WebGPU pipeline each. Slope offsets
  don't reach a logarithmic depth buffer, which writes depth per fragment.
- 2026-10-09 (clipped decals, default chosen, owner to confirm): parameters
  are stored and the mesh is made at load, as with generated architecture.
  A stored mesh would go stale whenever a chunk re-meshes or a wall
  regenerates. Bake to model is the way out for hand editing. Terrain takes
  projected decals only. Our own clipper, not three's `DecalGeometry` (§2:
  one mesh, objects per vertex, no index, tangents or angle rejection).
- 2026-10-09 (decal textures, default chosen, owner to confirm): decal pages
  (texture arrays of rectangles). Trim sheets' decal cells are the
  first source, so a level restyled by swapping a sheet also swaps its
  decals. Whether trim decal cells carry opacity (an alpha channel or a mask)
  is a Texture Designer question for the art-factory owner. Until then a
  cell without opacity uses its albedo's alpha, or 1.
- 2026-10-09 (vertex paint, default chosen, owner to confirm): a separate
  `tlPaint` stream, 4 bytes a vertex, read by graph materials (`vertexColor`
  set `paint`), trim (grime, wetness), height blend (weights) and an optional
  standard tint. It never overwrites a model's `COLOR_0`, which is wind for
  foliage and AO for trim. Paint on generated meshes is path-space, so it
  survives regeneration. A changed model leaves the paint unused and
  reported; carrying it over by nearest position is a follow-up if games ask.
- 2026-10-09 (receivers, default chosen, owner to confirm): `decalLayers`,
  8 layers, absent = all. Skinned meshes default to none: a world-space
  projector slides over a moving skin. Characters that want marks use mesh
  decals parented to a bone.
- 2026-10-10 (releases): three.js 0.186.1 is still the latest (GitHub r186 of 2026-09-24); no update. `@dimforge/rapier3d` 0.21.0 exists; the pinned 0.20.0 stays, because nothing in this phase depends on it. Its upgrade is a later item's job.
- 2026-10-10 (32.13): "the limits and budgets in `docs/deployment.md`" now means the manual. Since phase 31, deployment.md covers only the server. The limits go to `docs/manual/features/decals.md`, `vertex-paint.md` and the manual's limits guide.
- 2026-10-10 (measure-first switches, default chosen, owner to confirm):
  - The switches mark the area inside every outdoor class (area, landscape, world). The interior refuses them.
  - The area class has no generated architecture, so its decals go on the ground, the block walls (both faces of every room wall, door gaps kept clear) and the props. Projected and clipped decals split 50/30/20 between those three; mesh decals split 60/40 between ground and walls (they are flat).
  - Decals on generated walls are measured in the interior class: 32.6 and 32.8 extend the placement to its outlines.
  - 30 % of each kind come as overlapping pairs: the second decal is moved 0.4 of the first's width along the same surface.
  - Each kind has its own generator, so the class's content never moves with the counts.
- 2026-10-10 (honest stand-ins, default chosen):
  - A kind the engine can't draw yet stops the build with the part it waits for (`--decals`, `--clipped-decals`, and `--painted` past the 300 props). It is never measured as something else.
  - Mesh decals are measured with a stand-in: quads with one blended standard material (`mat-level-mark`), lifted 3 cm off the surface. Today every one is its own draw, because the batcher takes no transparent mesh. That is the "before" 32.5 replaces.
  - Painted props are measured with a stand-in: their files' twins, with a normalised 4-byte `COLOR_0` that no material reads. That gives the memory and vertex layout of a paint stream, not its look. 32.10/32.11 replace both stand-ins with the real thing.
- 2026-10-10 (specular, default chosen, owner to confirm): the ports are appended to the `pbr` output, defaults 1 and white (the standard surface's F0 0.04). Only a wired port switches the material to three's physical model, so no existing graph changes its program. Nothing maps a model file's `KHR_materials_specular` into a graph automatically: a graph replaces the file's material, so the game wires the values it wants (constants or parameters), as for every other channel. The manual's material-graph page and guide say so.
- 2026-10-10 (decal data, default chosen, owner to confirm):
  - A decal box is centred on its object and projects along −Z, its image in the XY plane (+Y up); defaults 1 m cube, `normalFade` 90° (faded over the last fifth of the angle), `edgeFade` 0.3 at each end (Godot's), no distance fade, sort order 0, every layer. `fadeDistance` fades over its last fifth, like the foliage wind distance.
  - A decal may sit on any object (no exclusions): a mark on a prop can travel with it. Not in the prefab vocabulary yet: 32.6 (spawned decals) adds it with the transient budget.
  - Decal layers have no project names (light layers do): the Inspector shows "Layer 1–8". Receivers may take 0 (no projected decal); a decal marks at least one layer. A skinned model's absent mask is none, so its field stores every layer when set (no omitted default); the Inspector shows its unset mask as every layer, which is wrong for a skinned model until the Inspector knows the model is skinned (32.9 or later).
  - A decal material draws its own textures or one trim sheet cell, not both (refused); an instance uses its root's cell and may change params only. Factors follow glTF: roughness 1 and metalness 0 multiply the ORM.
  - Trim cells are `{name, rect: [x, y, w, h]}` in pixels from the image's top-left (the Texture Designer's `px_rect`), checked inside the sheet and unique; not checked against the rows (the designer keeps them in their own band). An empty list is not stored, so sheets without cells keep their bytes.
  - Until 32.5 draws mesh decals, a mesh wearing a decal material draws it as a plain see-through surface (no depth write, its own textures, tint and opacity); the manual says so.
- 2026-10-10 (decal textures, default chosen, owner to confirm):
  - Pages are UASTC in every set, sRGB for albedo. ETC1S layers cannot be joined into an array (each file has its own codebook), so a page as it is needs a UASTC texture with a full chain; an ETC1S or PNG sheet is copied onto a page and encoded once, from its PNG original when the backend knows it (else transcoded, a second lossy generation, reported per texture). GPU memory is the same either way (1 B a texel as BC7/ASTC).
  - One page size per build: the largest image, rounded up to a power of two, at least 256. Composed pages are at most 2048² (the encoder's 12 Mpix); a larger image is copied at a reduced size and the build says so. Copied rectangles: 8 px gutter repeating the edge, padded box aligned to 16 px; each decal's mip cap is the deepest level whose bilinear reads stay in its box (pages clamp at their edges). A sheet cell on a sheet the page size uses the sheet's padding as its gutter, never past halfway to a neighbouring cell or into a row's padding.
  - ORM + emissive mask: the mask is the largest of the emissive map's R, G and B (a coloured sign keeps its shape), else the ORM's alpha; the glow's colour is the material's `emissive` × `emissiveIntensity`.
  - Composed pages are encoded at Basis Universal's "faster" UASTC level (`DECAL_PAGE_UASTC_LEVEL`): on a noisy 1024² image 2.4 s at 31.57 dB vs 8.2 s at 31.63 dB by default (the fastest level: 0.7 s, 24.0 dB). Imports keep the default.
  - No decal page budget of its own: pages count against the project's texture budget like every texture that does not stream. A set is split into several arrays only when one would pass the join limit (256 MiB level 0, 256 layers).
  - Pages are held per decal entity (a projected decal has no mesh), streamed with their scenes through the resource manager, and uploaded with `initTexture` as they arrive. Until 32.5 draws from the pages, Play and the export also keep a decal material's own textures (the interim see-through surface draws them); 32.5 drops them from the runtime material.
  - A skinned model's absent decal layers show as none in the Inspector: the editor reads `skins` from the model's GLB with its node names.
- Open for the owner: whether runtime-spawned decals (bullet holes,
  footprints) need an effects-graph output (an effect system that leaves
  decals). The plan gives prefabs and a transient budget only.
