# Phase 35 — One layered surface material, the vertex paint editor and the decal editor

Goal: terrain, block ground, block walls, generated architecture and painted
props all wear **one layered surface material**. It has four layers
height-blended by paint, plus wetness. A building can be:
- a base trim sheet,
- blended with a second trim sheet,
- then moss,
- then rust,
- then wet,

all with the same controls as terrain. Every material type says what it
reads (layer weights, trim rows, decals). The editors then show what a paint
channel means and warn when a material can't use it. Vertex paint and
decals get their own full-screen editors in phase 34's shell. The decal
editor shows and controls the decal atlas that Play uses.

Read `plan-phase-34.md` first (the shell, the brush kit and the palette).
The engine never reads the game repos; nothing here is fitted to one game.

**Release checks run when the phase starts (35.0):** three.js and Rapier,
as in 34.0.

## 1. Owner decisions (2026-10-12)

- **A dedicated decal editor:** selection, placement, auto-atlasing.
- **Every albedo texture of a blendable material carries height in its
  alpha.**
- **Standard defaults to start from, customizable later.** The engine ships
  a set of default materials you can create from and reuse. When you need
  something fancy (an emissive layer, a special blend), you make your own
  shader and material from a default and assign it to terrain or blocks.
- **Blocks blend four materials like terrain:** "a base trim sheet, another
  layer of a completely different trim sheet, then moss, then rust, then a
  wetness layer just like the terrain". **One shader layout for both**,
  because the trim sheet's tiling comes from geometry, not the shader.
- *Proposed, default chosen, owner to confirm:*
  - **Three core material types:**
    - **Layered surface** (terrain, blocks, walls, architecture, painted props);
    - **Standard** (props, models);
    - **Decal**.
    `foliage`, `water` and `unlit` stay as they are. The old `trim` shader
    becomes a layered surface with one trim layer and still loads (no
    format bump).
  - **The `kit` shader's UI name becomes "Atlas surface"**, so "kit" means
    only phase 36's kits. The data key stays.
  - **Paint channels everywhere:** layer 1 is the base (what the others
    leave); R, G and B are layers 2–4; A is wetness. This changes phase 32's
    vertex paint meaning (G grime, B wetness on trim). The games are checked
    read-only before it lands (35.3).
  - **Layer textures in one material share a size per group.** Trim layers
    form one group at the sheet's size; tiling layers (moss, rust) form one
    group at their own size. That makes at most two arrays per map, so a
    1k moss doesn't have to be stored at 2k.
  - **Opaque surfaces:** albedo A = height (linear). **Cut-out and
    transparent materials** (foliage, decals): A = opacity.

## 2. Where things stand (recon 2026-10-12 at `47999af5`, re-read at `eb3e6dc6` after phase 34)

- **Seven fixed shader types** (`project-model/src/materials.ts:31`):
  `standard, foliage, kit, unlit, water, trim, decal`. Material instances
  (`instanceOf`) and Convert to graph exist.
- **The 4-layer height-blended material is a graph template,** not a type
  (`editor/src/session/material-graph.ts:447-560`, `TEMPLATE_LAYERS = 4`).
  - It reads `albedoHeight`, `normals` and `orm` texture arrays.
  - Terrain gets more layers through `extraLayers`.
  - Since 34.9 a texture read says what it gives without a texture
    (`absent`: the ORM reads `orm`, a normal read a flat normal), and a slot
    list fills an empty normal/ORM slot with a constant layer.
  - Materials carry optional `layerNames` (`materials.ts:226`); the layer
    palette (`editor/src/ui/palette/`: `LayerPalette`, `LayerPicker`,
    `MaterialLayers`, `LayerSettings`) shows a layered material's layers;
    `setMaterial {material, assign: {entityId}}` makes and assigns one as one
    undo step.
- **Bug (still there at `eb3e6dc6`):** the template's `heightBlend` weights
  are wired to `vertexColor` `COLOR_0` (`material-graph.ts:498`), not the
  vertex paint set, so the stock layered material ignores vertex paint on
  props.
- **The trim shader** (`three-adapter/src/trim-material.ts`):
  - reads three textures and ignores albedo alpha;
  - grime and wetness are flat tints from `COLOR_0`, and vertex paint adds
    to them;
  - there are no texture layers and no height blending on walls.
- **Paint data:**
  - block ground stores 4 weights + wetness per lattice vertex
    (`block-paint.ts`), and wall faces optionally the same (`block-wall-paint.ts`);
  - terrain stores up to 256 layers as 4 indices + 4 weights;
  - vertex paint (`tlPaint`) stores 4 independent bytes per vertex, and on
    generated walls and splines a path-space grid.
- **Vertex paint UI** is a floating window (`ui/tools/VertexPaintPanel.tsx`,
  203 lines). Channels are labelled R/G/B/A with no meaning, and nothing warns
  that the material doesn't read paint. `paintVertices` already takes the
  brush kit's `opacity`, `mask` and `hardness` (34.5, 34.6); only the panel
  and ring are not on the kit.
- **Phase 34's shell** (`editor/src/ui/editmode/`: `EDIT_MODES`, one entry
  today, the terrain; `EditModeShell`, `ToolRail`, `ToolGrid`, `StatusHints`;
  the key map `session/edit-keys.ts`; isolation in the adapter), the brush kit
  (`ui/brush/`: `BrushPanel`, `SliderField`, `NoiseMask`, the settle queue)
  and the one cursor (`viewport/brush-cursor.ts`) are what 35.5 and 35.6 build
  on. `viewport/viewport.ts` (1,948 lines) and `three-adapter/src/adapter.ts`
  (1,976) are near the split line: the next change to either moves its area
  out first.
- **Decals** (phase 32):
  - a floating Decal tool (`ui/tools/DecalToolPanel.tsx`, `viewport/decal-tool.ts`);
  - **decal pages** pack every decal image into page arrays up to 2048² for
    Play and the export (`project-model/src/decal-pages.ts`,
    `backend/src/decal-page-compose.ts`);
  - the Scene view draws each material's own textures, so the atlas is
    invisible in the editor.

## 3. Items

Order: measure → material types → layered surface → height rule → vertex
paint editor → decal editor → atlas → acceptance.

Rules for every item:
- Format changes are additive on schema 7.
- Scenes that don't use a new feature build the same shader programs (WGSL
  compared), as in phase 32.
- Pixels on both renderers; the Scene view against Play.

**E2E budget (D181):** no new e2e file.
- Vertex paint and decal checks move into the existing
  `instance-brush.e2e.ts`, `handles.e2e.ts` and `layered-material.e2e.ts`,
  replacing their floating-window steps.
- Shader and blend maths are vitest.

| Item | What |
|---|---|
| 35.0 | Release checks; this plan re-read against 34's outcome. |
| 35.1 | **Measure first.** Add `--layered-walls N` to `level --classes area`: generated walls with 1, 2 and 4 layers, trim and tiling. Record the frame p50/p95 and GPU scene pass before anything changes. |
| 35.2 | **Material types and what they read.**<br>• **Declarations:** each type declares its inputs and outputs: `layerWeights`, `trimRows`, `vertexAO`, `writesDecal`, `alphaIsHeight` / `alphaIsOpacity`. Fixed shaders declare them in `materials.ts`. A graph material's are inferred from its nodes (a `heightBlend` reading paint ⇒ `layerWeights`) and shown on its output.<br>• **New material:** the dialog lists the defaults with previews: Layered surface, Standard, Decal, Foliage, Water, Unlit, Atlas surface. **Customize** turns a material into a graph you own (Convert to graph).<br>• **Checks:** an editor that paints or places checks the declaration and shows "this material doesn't read paint — Make it paintable" instead of silently drawing nothing.<br>• vitest: declarations; e2e: the dialog and one Customize. |
| 35.3 | **The layered surface.**<br>• **One shader layout** for terrain, block ground and walls, generated architecture and painted props: four layers (terrain more, as today). Each layer has a texture set (albedo + height, normal, ORM), a **UV source**, tiling, normal strength, height contrast and offset, and a mip clamp (on for trim layers). Wetness sits on top.<br>• **UV sources:** `geometry` (the mesh's UV0: trim strips, model UVs); `world` (a metres UV1 written by the block mesher, the architecture generator and splines); `top`, `slope`, `biplanar` (terrain's projections).<br>• **Trim layers in one material must share one row table;** a mismatch is a problem with the rows that differ.<br>• **Weights:** terrain and block ground from their stored weights; walls, architecture and props from paint, with base = 1 − (R+G+B) clamped and A = wetness.<br>• **Cost control:** only the layers a material uses are compiled. An unused layer reads nothing.<br>• **The `trim` shader loads as a layered surface** with one trim layer; old grime becomes "a layer of grime colour". Its existing pixels are matched in a test.<br>• The template wiring bug is fixed.<br>• **Before the paint meaning changes,** the games' folders are read for `vertexPaint` (read-only copies in `~/.cache`); anything found is reported to the owner, never edited.<br>• vitest: weights, WGSL identity for untouched scenes. e2e: `layered-material.e2e.ts` paints a wall with trim A, trim B, moss and rust plus wetness, on both renderers. |
| 35.4 | **Height in alpha.**<br>• An albedo used by a layer of a layered surface must carry height in A. When a texture is assigned (or packed into a slot), the backend checks A: missing or flat gives a problem ("no height in alpha — blends will be soft"), and the layer uses a height derived from brightness until a real one arrives.<br>• Cut-out and decal materials keep A as opacity and are never warned.<br>• The rule goes on a manual page, and the Texture Designer's albedo+height export is named as the way to make it.<br>• vitest: the check; integration: an import with and without height. |
| 35.5 | **The vertex paint editor.** An edit mode on a model, instance set, architecture object or spline:<br>• the palette shows the material's layers by declaration: Base, layer 2, 3, 4 with thumbnails and names, and Wetness;<br>• the brush kit with noise mask and opacity;<br>• a "doesn't read paint" banner with **Make it paintable** (swaps the material for a layered surface whose base is the old material's textures, as one undo step);<br>• a channel view;<br>• the stale-paint fix from 32.12.<br>The floating Vertex paint window and toolbar button are removed. The instance brush moves onto the brush kit. e2e: `instance-brush.e2e.ts` vertex-paint steps rewritten. |
| 35.6 | **The decal editor.** An edit mode on the scene, not one object: the whole scene draws, only decals are pickable.<br>• **Palette:** decal materials and trim-sheet decal cells as thumbnails; drop an image to make a decal material.<br>• **Placement:** click to place aligned to the surface; stamp; scatter with the brush kit (density, rotation and scale jitter, seeded); projected or clipped per decal.<br>• **Selection:** click, box, add/remove; filter by material and decal layer; edit size, blend, per-channel opacity and fades on many at once; the rotate/scale handles; Bake to model.<br>The floating Decal window and toolbar button are removed. e2e: `handles.e2e.ts` decal steps rewritten. |
| 35.7 | **The decal atlas.**<br>• A panel in the decal editor shows the decal pages Play and the export will use (from `decal-pages.ts`): each page, every decal's rectangle, page size, unused share, memory, and which decal forces the page size up.<br>• **Rebuild pages** composes them now. The Scene view then draws from the composed pages, as Play does, so the editor matches Play. Until composed, it draws the materials' own textures, as today.<br>• vitest: the panel's numbers equal the build's; e2e: the panel lists a scene's decals. |
| 35.8 | **Acceptance.**<br>• A real-browser pass: a building painted with two trim sheets, moss, rust and wetness; a terrain on the same material type; decals placed, scattered and atlased.<br>• Play and export; screenshots for the owner.<br>• §4's numbers after; manual pages for materials, vertex paint and decals. |
| 35.9 | **Review fixes.** |

**Done when:**
- A generated building and a block wall blend four layers (two trim sheets
  and two tiling materials) plus wetness by paint, on both renderers, in
  Play and the export (pixels; look: owner look pending).
- Terrain and walls wear the same material type.
- The vertex paint and decal editors replace the floating windows.
- The decal atlas is visible in the editor.
- Untouched scenes build the same programs.
- `tools/gate.sh full --both-renderers` is green.

## 4. Soft performance targets

| Measure | Target |
|---|---|
| A wall with one trim layer | within noise of today's trim shader |
| A wall with 4 layers + wetness | GPU scene pass + ≤ 1.0 ms at 1080p for a village-class view: `level --classes area --layered-walls 24 --wall-layers 4` against 35.1's 1-layer 5.66–5.72 ms (WebGPU), so ≤ ~6.7 ms; WebGL 2 has no pass timing, its frame p50 is compared instead |
| Unused layers | no texture read |
| Decal atlas composition | ≤ 2 s for 200 decal images, off the main thread |

## 5. Progress and measurements

| Item | Status |
|---|---|
| 35.0 | Done 2026-10-12: three.js 0.186.1 is still the latest on npm (no update); Rapier 0.21.0 (2026-09-25) exists, the pinned 0.20.0 stays (nothing here depends on it). §2 re-read at `eb3e6dc6`: line numbers, 34.9's `absent` reads and constant slot layers, `layerNames`, the palette, `setMaterial assign`, the shell and brush kit, panel paths updated; the template's weight bug is still there. Items unchanged. |
| 35.1 | Done 2026-10-12: `level --layered-walls N [--wall-layers 1\|2\|4]` (`tools/perf/level-walls.ts`): N generated buildings (starter room preset in and out, 1–2 storeys, door, windows with panes, hip/gable roof) as one static architecture object on the area's free ground, wearing one wall material; 1 layer = today's trim shader on a 1024² starter-layout sheet (albedo with height in A, normal, ORM); 2 and 4 layers are in `WALL_LAYER_SETS` (trim A + trim B; + moss and rust tiling, wetness) and refused until 35.3 builds the material. vitest `tests/perf/level-walls.test.ts` (7). **Baseline, area class, Iris Xe, 1080p, uncapped, 2 rounds:** without walls WebGPU p50/p95 6.8/9.7 ms, GPU 10.41 ms (scene pass 4.16), 260 draws, 271k tris; WebGL 2 p50/p95 2.7/7.0. **24 trim buildings (39 storeys):** WebGPU p50/p95 7.4/8.3 and 7.4/11.0 ms, GPU 11.71/12.02 ms, **scene pass 5.66/5.72 ms**, 343–346 draws, 330k tris, main thread 7.4–7.6 ms; WebGL 2 p50/p95 3.9/7.3 and 4.0/10.7 ms (no GPU pass timing on WebGL 2). The walls cost ~1.5 ms of scene pass. WebGL 2 p99 126–142 ms in every run, walls or not (the class's own hitches, not the walls). Screenshots looked at (both renderers): the buildings show the sheet's courses. Fast gate: build, lint, vitest 688, e2e 30 green; village WebGL 2 p50 5.0 > 4.84 ms twice (gate + rerun), the same miss as 34.10's tail. No A/B was run, because this change ships nothing: only `tools/perf`, `tests/perf` and docs differ from `eb3e6dc6`, so the village export is the same build. Host state (D199). |
| 35.2 | Done 2026-10-12: declarations (`layerWeights`, `vertexPaint`, `trimRows`, `vertexAO`, `writesDecal`, `alphaIsHeight`, `alphaIsOpacity`) — the shader table `MATERIAL_DECLARATIONS` and on-screen names `MATERIAL_SHADER_LABELS` in `materials.ts`, graph inference and `materialReads` in `project-model/src/material-reads.ts` (the editor's value subpath). **New material** dialog (Create → Material): 7 defaults with generated previews (`public/icons/materials`, 7 WebPs 160², 20.3 KiB in all), what each reads, Enter/double-click creates. **Customize (convert to graph)** in the Inspector, the reads listed there, under the graph's output and in the material toolbar; "kit" shows as Atlas surface. The terrain editor's Layers say when the material reads no paint, with **Make it paintable** (base layer keeps the old maps). vitest 13 + 10; e2e: `material-graph.e2e.ts` (dialog, Customize, terrain warning). Screenshots looked at (WebGPU; `~/.cache/thirdlight-phase34/work/shots352/`). Fast gate green (vitest 690 files, e2e 39, village WebGPU p50 5.6 / WebGL 2 4.8 ms within limits). |
| 35.3 | Done 2026-10-12: one layered surface layout (project-model `layered-surface.ts`): UV sources top / world / biplanar / mesh UVs, the Layer weights node (stored weights; else paint as layers, base 1 − (R+G+B), A wetness; else a model's own COLOR_0), `layerSheets` rows (mip cap, generator, mismatch problem, rows shipped in builds), only used layers read and trim/tiling layers in arrays of their own for materials with a trim layer; the template's paint bug fixed in the compile; the `trim` shader draws as a one-trim-layer surface (strips 179,62,53 / grime 55,47,38 / wet 141,23,19 = the trim shader's on both renderers, generated walls too: 86,21,80, 0,18,89); architecture's trim data moved to `tlTrimData`; side-projected normal maps on meshes without tangents fixed (they drew black). Layer table and Layer settings show UV source and trim sheet. Games: Sprout none; Skyforge's trim paint keeps its meaning (decision log). **Perf, area + 24 buildings, Iris Xe 1080p, 2 rounds, WebGPU scene pass:** 1 trim layer 5.71/5.71 ms (35.1: 5.66/5.72, within noise); 2 trim layers 5.95/5.79; 4 layers + wetness 6.51/6.37 ms (target ≤ ~6.7 ✓, +0.7–0.8 ms); WebGL 2 frame p50 1 layer 3.9/4.0, 2 layers 4.4/4.2, 4 layers 4.8/4.4 ms (35.1 3.9/4.0). Screenshots looked at: perf walls both renderers (rust under the eaves), the e2e wall (two sheets, moss, rust, wet). vitest 692 files; e2e `layered-material.e2e.ts` (the painted wall, both renderers, pixel checks; trim strips held to the shader's pixels). Fast gate green at the first commit; after the normal fix the area e2e and vitest green, village WebGL 2 p50 5.6/5.2 > 4.84 ms (HEAD 6 more runs 5.0–5.6, plain page p95 up to 10.9 ms: the slow host state, D199; the village draws no layered wall; an A/B against the phase start could not run: the archived tree's export linked no physics WASM). Owner look pending. |
| 35.4 | Done 2026-10-12: a texture parameter whose alpha feeds a Height blend's heights in a material that never reads alpha as opacity nor draws a decal (`heightAlphaParams`) is a height array (`TextureSlotSet.height`, key `color+height:…`); the assembly gives a layer whose texture's A is missing or flat (1st–99th percentile spread ≤ 8 levels) a brightness height (Rec. 709 luma stretched to 0–255) packed into A once, so Scene view, Play and export draw one array (export digest = route digest, tested); layers with height stay joined as stored. Backend check on load and after material/texture changes: problem `no_height_in_alpha` ("<texture>: no height in alpha — blends between layers will be soft (…)"), results cached per digest (memory + import-cache marker); route `…/content/textures/height-alpha`; the palette tile's "no height" badge (screenshot looked at, WebGPU: `~/.cache/thirdlight-phase34/work/shots354/`; the painted dirt's edge follows the pattern's brightness). Manual: `guides/height-in-alpha.md`. vitest: project-model 4, backend 8 + 1 (export), integration `m35-height-alpha` (PNG with height, RGB PNG, cut-out never warned, re-import with height); e2e `editor-window.e2e.ts` badge steps. Fast gate green first run (vitest 694 files, e2e 35, village WebGPU p50 5.7 / WebGL 2 4.8 ms within limits). WebGL 2 look unverified (same array, no shader change). |
| 35.5 | Done 2026-10-13: the vertex paint editor (`EDIT_MODES` `vertex-paint`, Inspector **Paint vertices** on a model, instance set, architecture or spline; rail Paint · Channels · Material): the palette by declaration (`session/vertex-paint-channels.ts`: layered surface Base/2/3/4/Wet with the palette's names, thumbnails and "no height" badges, R/G/B = layers 2–4, A = wetness, the base erasing R, G and B in one stroke through an additive `brush.channels`; trim sheet Grime G / Wetness B; paint tint; a graph's raw channels), MaterialCard, the shared brush kit (BrushPanel, NoiseMask, opacity, the one cursor laid flat on the face, keys and F/Shift+F drags in one shared `viewport/brush-control.ts` that the terrain editor now uses too; the preview holds the stroke's opacity across dabs), the "doesn't read paint" Banner + Toast + grey cursor with **Make it paintable** (one `setMaterial assign`, additive `assign.slots` for named slots), the channel view (chips over the view, V, the Channels list), stale paint removal in Paint and Channels; isolation and framing on entering. Floating Vertex paint window, toolbar button, Window entry and `VertexPaintPanel` removed. Instance brush on the kit (BrushPanel size, shared cursor and keys, SliderFields). vitest: paint channels 4, brush args 1, multi-channel 2, sizes under 1 m, `assign.slots` 1; e2e `instance-brush.e2e.ts` rewritten (27.6 → ~31 s: + Make it paintable, its undo/redo, a layer-2 stroke drawn red on WebGPU and WebGL 2), `level-acceptance` editor strokes through the editor. Release → stored paint drawn 25–35 ms, preview a dab 0.1–1.5 ms (unchanged). Screenshots looked at against 04/04b (`~/.cache/thirdlight-phase34/work/shots355/`, owner look pending). |

## 6. Decision log

- 2026-10-12 — Planned from the owner's material questions: one layered
  type for terrain and walls, defaults to start from, Customize to graph,
  height in alpha, a decal editor with atlasing.
- 2026-10-12 (35.0) — Plan re-read against phase 34's outcome: only §2's
  facts changed (listed in §5); the items stand. 35.5 is smaller than
  planned, since `paintVertices` already takes the brush kit's opacity, mask
  and hardness.
- 2026-10-12 (35.1) — The walls switch. Defaults chosen, owner to confirm:
  - **"Village-scale" is 24 buildings** on the area class's 100 × 100 m, 39
    storeys between them. The village perf class has no buildings, and the
    area's free ground holds about that many with 2 m between them. The
    switch says when the area is full instead of placing fewer.
  - **Generated buildings, not block walls**: the trim shader is what
    generated architecture wears, and 35.3's layered surface replaces it
    there first. One object holds every building, as the Rooms tool makes
    them. Props stay where the class put them (a few end up inside a
    building), so the class's own content never moves with the count.
  - **The baseline is unpainted.** Today's trim shader reads paint as grime
    and wetness tints at the same cost either way. 35.3 adds the paint
    strokes the 2- and 4-layer variants blend by, and measures them against
    this row.
  - **The variants wait as refusals** (`layeredWallsNotBuilt`), the way the
    marks switch's did. They are not a stand-in material. 35.3 fills
    `publishWalls` for 2 and 4 layers from `WALL_LAYER_SETS` and
    `wallLayerTextures` (trim layers at the sheet's 1024², tiling layers at
    512², as §1's per-group sizes say).
  - WebGL 2 gives no per-pass GPU time (three times only the outermost
    pass), so its target is read on frame p50, with host drift in mind.
- 2026-10-12 (35.2) — Material types. Defaults chosen, owner to confirm:
  - **`vertexPaint` is its own declaration** besides `layerWeights`: terrain and block ground supply weights through
    COLOR_0, vertex paint through the paint set, so the terrain editor asks one and the vertex paint editor (35.5) the
    other. Today's layered template reads COLOR_0 only (the wiring bug 35.3 fixes), so it declares `layerWeights` but
    not `vertexPaint` — the inference says what the shader does.
  - **Inference walks upstream** from where a value is used (a blend's weights, the output's occlusion/opacity/alpha
    clip, a Height blend's heights) to its source, through function calls and back out, counting only nodes that reach
    an output. Mix weights are not followed for occlusion, height or opacity (the template's ORM is mixed by painted
    weights; that is not vertex occlusion). A test holds every convertible shader's converted graph to the shader's
    own declaration.
  - **The table lives in `materials.ts`; the editor reads it through a new value subpath
    `@thirdlight/project-model/material-reads`** (editor → project-model is types-only; `limits`, `texture-slots` and
    `trim-sheet` are the precedent), so there is no editor copy.
  - **The dialog replaces Create → Material's in-place naming** (Standard picked, so Enter makes what it made before);
    the Graph material submenu (Empty, River, the templates) and Trim sheet material stay as they are. Foliage, Water,
    Unlit and Atlas surface start at their shader's defaults. The Layered surface opens in the material editor (it is a
    graph); the rest in the Inspector.
  - **Previews are generated pictures**, not live renders: the defaults have no textures, so a live sphere of each is a
    plain white ball. Made on the Studio's container backend (Qwen-Image Turbo, prompts and seeds in
    `tools/icons/editor-icons.tsv`, group `material`), packed by `pack-editor-icons.mjs`.
  - **Make it paintable** gives a layered material whose first layer takes the old shader material's colour, normal and
    ORM maps and its name, assigned in one command (`setMaterial assign`); 35.5 reuses `paintableMaterial`. A graph
    that mixes its own layers by the weights gets no warning (paint picks its layers by number).
  - The reference keeps the data key in its per-parameter rows ("The kit shader's …"); only the shader enum's text
    names Atlas surface — the descriptor registry is at its size budget.
- 2026-10-12 (35.3) — The layered surface. Defaults chosen, owner to confirm:
  - **One layout = one graph**, not a second shader: the layered template (and its graph builder) moved from the
    editor into project-model (`layered-surface.ts`, value subpath for the editor), compiled by the material graph
    compiler like any graph. The `trim` shader draws as that layout (`trimSurfaceMaterial`, made in the material
    library at draw time): one mesh-UV layer of the sheet plus a grime colour layer mixed by the old grime mask. The
    stored material stays `shader: "trim"` (generator, decal cells, Inspector unchanged; no format change).
  - **Pixels**: the trim strips read exactly as the trim shader's on both renderers (recorded before, asserted ±3 in
    `layered-material.e2e.ts` on the GPU host). Generated architecture also matches: the old shader multiplied the
    sheet by the colour of the material it was put over — on generated walls the generator's grey stand-in
    `#9a968c` (an accident, but the look projects have); kept as a per-object value of the graph's `color` when the
    trim material sets none. A fresh layered surface on architecture shows the sheet's own colour (brighter).
  - **UV sources** `top`, `world`, `biplanar`, `mesh UVs` (= `geometry`). `world` and `slope` are one projection —
    the world plane the surface faces most, from the world position — so no mesher writes a UV1: no attribute bytes,
    works on merged statics, models and generated meshes alike, stable on all that stands still (a moving prop's world
    layers slide: give it mesh-UV layers). Mesh-UV layers ignore tiling; with a row table they read with the trim
    shader's footprint cap and centroid UV.
  - **Weights**: a new Layer weights node — stored weights (COLOR_0 beside COLOR_1, a terrain's), else vertex paint as
    layers (base 1 − clamp(R+G+B), R/G/B layers 2–4, A wetness), else an unpainted model's own COLOR_0, else layer 1.
    Generated architecture now keeps its trim data (occlusion, wall-paint grime and wetness) in its own attribute
    `tlTrimData` instead of COLOR_0, so a model's vertex colours (the painted-terrain GLB) stay weights; trim data adds
    its grime to layer 2, its wetness, and its occlusion to the AO. The trim material reads it through a new Vertex
    colour set `trim` (that attribute, else COLOR_0).
  - **Template wiring bug**: fixed in the compile, so stored layered materials get it too: a Vertex colour node that is
    layer weights (`first`) or their wetness (COLOR_1 `zero`) reads the vertex paint where the mesh stores no weights.
    Unpainted meshes build the programs they did (vitest digests recorded at `e19307ec`: plain, stored, own colours).
  - **Paint meaning**: new layered surfaces use R/G/B = layers 2–4, A = wetness; a trim material keeps G grime,
    B wetness (an absent new field keeps the old look, and Skyforge paints that way). **Games, read-only**: Sprout — no
    `vertexPaint`, `paintVertices` or `paintTint`. Skyforge Tactics — `scene-shatterfall-camp`: the infirmary
    (architecture, `sf-trim-b`) has path paint G 0.65 and B 0.5 (`tools/showcase/paint_and_decals.py`); the march
    tent wears `sf-prop-trim` (standard, `paintTint`). Nothing breaks: trim keeps its meaning, paintTint is untouched.
    Moving the infirmary to a layered surface would need its strokes repainted (G → R, B → A) — the game's call.
  - **Side-projected normal maps on meshes without tangents** (generated walls, world-projected moss and rust) read
    three's world-tangent varying, made from a tangent attribute those meshes lack (zero → NaN: black walls in the
    perf class). They now take the frame their pixels derive, in view space; meshes with tangents and terrain build
    what they did.
  - **Only used layers**: for a material with a mesh-UV layer, up to its last filled colour slot (`layeredForDraw`):
    the reads past it take a "not read" layer (−1) and their weights are masked. Terrain, block ground and tiling-only
    materials read all four as before (a terrain's slots map to per-pixel layers; every stored material keeps its
    program).
  - **Size groups by UV source**: the used mesh-UV (trim) layers and the rest each get their own slot list of every
    array (`albedoHeight@trim` …), a draw-time graph rewrite inside `withAssembledSlots`/`materialTextureSlotSets`, so
    assembly, export and runtime are unchanged and a map has at most two arrays. A group's textures share a size (the
    assembler's rule, as before).
  - **Row table**: `layerSheets` (per layer, a trim material id; additive on schema 7). The first sheet's rows feed the
    compile's cap and the generator (`trimSheetOfMaterial`); sheets with other rows are a backend problem listing the
    rows; a build writes the rows onto the runtime material (`trim`), so the sheets need not ship. Picking a sheet in
    the layer table or Layer settings fills the layer's textures and sets mesh UVs.
  - The descriptor registry stays under its 328 000-character budget by a one-line `layerSheets` description.
  - Left for 35.5: a palette gesture to drop a layer (lists keep four slots; a trim material's empty trailing slots are
    simply not read).
- 2026-10-12 (35.4) — Height in alpha. Defaults chosen, owner to confirm:
  - **Which albedos**: worked out from the graph, not the parameter name: a texture parameter whose alpha reaches a
    Height blend's heights, in a material that reads no alpha as opacity and draws no decal (cut-out, transparent and
    decal materials are never checked or changed). For today's materials that is the layered surface's
    `albedoHeight` and its trim group. The fixed `trim` shader declares no height (its A is unused), so trim
    materials are not checked.
  - **Flat** = the spread of A between its 1st and 99th percentile is ≤ 8 of 255 levels (`FLAT_ALPHA_SPREAD`,
    backend `height-pixels.ts`): a missing A (opaque), a constant, ETC1S noise and a seam of stray texels are flat;
    painted heights span tens of levels.
  - **The stand-in height** is the texel's brightness (Rec. 709 weights in sRGB values) stretched so the image's
    1st–99th percentile fills 0–255 (a plain colour: 128). Made in the KTX2 encoder (a `height` pack source) when
    the array is assembled; which layers got one is in the array's cache key, so a re-import with a real height
    makes the array again, and an array whose layers all carry height keeps its old key and bytes (no re-encode).
  - **The badge asks a route** (`GET …/content/textures/height-alpha?ids=`) rather than a field on the asset: the
    check is the backend's, cached per file digest (memory and an import-cache marker), and no format change.
  - **The problem names the texture once** (the materials and layers using it in the line), logged when it
    appears or changes, as the other backend checks are. The art-factory preset that packs albedo + height is named
    after a game there; the manual says "a packing preset that puts the height in A" (35.5: engine docs name no game).
- 2026-10-13 (35.5) — The vertex paint editor. Defaults chosen, owner to confirm:
  - **Entered from the Inspector only** (`EditModeKind.activates: false`): every model is paintable, so a double-click
    keeps renaming in the Hierarchy and picking in the Scene view. It frames the object on entering unless the view
    already shows it (`framesOnEnter`, a 5 × 5 pick of the view): a small object shown alone is easily off screen.
  - **What the tiles mean comes from the material's declaration** (`vertexPaint` + `layerWeights` → layers; a fixed
    `trim` shader → Grime G / Wetness B, its 35.3 meaning; a standard material with paint tint → tint R/G/B and
    amount A; another graph that reads paint → its raw channels; none → painting off). The material is the object's
    "*" slot, else the one its named slots name (a spline's `spline`); Make it paintable puts the new material on
    those named slots too (additive `setMaterial assign.slots`: named slots draw before "*").
  - **The base is a tile you paint**: it is what R, G and B leave, so painting it erases all three by the dab's
    amount — one stroke, one command: an additive `brush.channels` (more channels painted alike) on
    `paintVertices`; X/Ctrl do not flip it (it always takes paint off), and its cursor stays the paint colour.
  - **Layer channels stay independent bytes** (as stored since 32.10): painting layer 3 over layer 2 does not lower
    layer 2; the shader's Height blend weighs them. Erase or the base takes a layer off.
  - **Make it paintable on a trim sheet** (Material → Make it a layered surface) gives the base layer the sheet
    (`withLayerSheet`: strips, rows, mesh UVs) rather than its three maps; a material with no project material
    (a model's own) gets an empty base — said in the banner.
  - **Rail**: Paint (palette, tools Paint B / Erase X, brush, noise), Channels (the channel view list, what R/G/B/A
    mean, what is stored, stale paint) and Material (the material card and the layer palette's editing). The brush is
    armed in Paint and Channels, not in Material. The channel view also sits over the view in every mode (V cycles).
    Blur and Fill (in the mockup) are not built (no core maths; 34.8's decision), nor the status line's cursor readout.
  - **One brush for every object** (`thirdlight.brush.vertex-paint.paint`): sizes go to 2 cm (centimetre steps under a
    metre, the size track reaching 5 cm); the tile picked and the channel shown are remembered per object while the
    page is open.
  - **A press on a material that reads no paint paints nothing** and says nothing new (the banner and toast say it);
    on a locked object it says why.
  - **The cursor fill's mask on generated walls** is read in the world, while path paint anchors its mask along and
    across the wall: the fill there is a hint, not the exact mask (models and copies match).
  - **The instance brush stays in the Inspector** on the kit: its footprint is the shared brush's size (radius half of
    it), paint/erase the store's invert (X, Ctrl for one stroke), the shared cursor (footprint only: no strength) and
    keys (routed from the editor's shortcuts while it is armed: `[ ]`, F, X); its copies' fields are SliderFields
    and the seed field. One brush key implementation now (`brush-control.ts`) for terrain, vertex paint and copies.
  - Found, not fixed (pre-existing, not docs): engine source comments name a game ("Skyforge's village") in
    `three-adapter` (render-graph, static-merge, material-library, a test) — for the phase review.

