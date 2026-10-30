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
- *Proposed, default chosen, owner to confirm (**confirmed by the owner 2026-10-22**; how trim sits in the layered surface is reworked by 39b.6c):*
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
| 35.6 | Done 2026-10-13: the decal editor, a **scene's** edit mode (`SceneEditModeKind`: the whole scene drawn, only objects with its component — decals — pickable, other icons hidden; `viewport/view-isolation.ts` split out of `viewport.ts`, 1,948 → 1,935 lines) from Window → Decals, the toolbar's decal button and a double-click on a decal (opens in Select with it selected); rail Place · Scatter · Select. Palette (decal materials + free trim cells on the layer palette's tiles, a cell cropped from its sheet, checker; drop or pick an image → a decal material), place/stamp/grips as before, scatter with the shared brush (`ScatterStroke`: density per m², seeded turn/size, dropped along the dab's normal; one `createEntities` a stroke), select (click, box, Shift/Ctrl, material/layer filter, drag to move), the selection's fields on many in **one** `setComponent` (additive `entityIds` + `values`, generic, follow-ups), blend on the material, Bake to model, Delete. Floating Decal window, `DecalToolPanel` and the Inspector's bake button removed. Found and fixed: the Scene view's decal pages dropped image alpha (every view-page decal drew as its rectangle). vitest: commands 3, decal editor 7; e2e `layered-material.e2e.ts` decal steps drive the editor (+ bake via a double-click, scatter, box/Shift/Ctrl, one multi-edit and its undo): 43.5 → 45.7 s (auto), 46.2 s WebGL 2; preview drawn 129–142 ms, clipped preview cut 60–80 ms. Screenshots looked at against 05 (`~/.cache/thirdlight-phase34/work/shots356/`, owner look pending). Fast gate: vitest 697 files, e2e 39 (rendering's dynamic-resolution step failed once, passed on rerun), village WebGPU p50 5.5 / WebGL 2 4.6 ms within limits. D256 found (below). |
| 35.7 | Done 2026-10-13: the decal atlas, a drawer along the decal editor's view (`ui/decals/AtlasDrawer.tsx`, the shell's new scene-mode `drawer`): pages, images/materials, unused share, GPU memory (block-compressed, every mip), the images that set every page's size with what halving them gives, each page with its images' rectangles (hover names, click selects their decals); **Rebuild pages** composes them on the backend (`decal-atlas.ts`: `GET`/`POST …/content/decal-pages`, arrays served from the last composition) and the Scene view draws from them as Play does while they are current (`decalpages:` texture keys). The plan is the build's: the shipped materials moved into exporter `shippedMaterials` (the closure and the route call it), project-model `decalPageReport` reads `planDecalPages`. vitest: report 2, editor 2, backend 1 (the atlas's size, pages, rectangles equal a real export's; Rebuild gives the export's arrays from the cache; a new decal material makes it stale). e2e `layered-material` decal steps: the drawer lists the 3 images, hover, click-select, Rebuild → drawn from the pages (`data-tl-decal-pages` 2 arrays, 262,224 B — the drawer's number) on WebGPU and WebGL 2; made in 34–54 ms there (3 small images, pages already in the cache from Play's build ahead); a cold 2-page compose in the backend test 1.5 s (the export); the 200-image ≤ 2 s target not measured. **D256 closed** (one more frame after an in-place decal write; box-floor preview/placement steps). **Delete of many decals is one `deleteEntity`** (additive `entityIds`, `DELETE_ENTITIES_MAX`; MCP docs), used by the decal editor and the Scene view's delete; e2e: a scatter stroke box-selected, deleted, one undo. Screenshots looked at against 05 (`~/.cache/thirdlight-phase34/work/shots357/`: both renderers, the warning row; decal alpha right on WebGL 2 from view pages and composed pages). Fast gate green first run (vitest 701 files, e2e 32, village WebGPU p50 5.6 / WebGL 2 4.7 ms within limits). Owner look pending. |
| 35.8 | Done 2026-10-13: real-browser pass on both renderers, all through the editor (MCP/commands only for the imports — the import route as the project window's —, the scene's gradient sky, Play's camera and the export route): two Studio trim sheets (stone, wood: 2048², albedo with height in A, normal, ORM; layout.json imported in each trim material's table, the rows the room doesn't use deleted so both share one table), a building drawn with the Rooms tool (2 storeys, door, windows) wearing the stone sheet, **Make it a layered surface** in the vertex paint editor, layer 2 the wood sheet, 3/4 moss and rust (512², world, tiled) from the texture browser, painted wood, moss through the noise mask, rust under the eaves, a wet corner; a block wall of a block type wearing the same material, painted with Paint texture on its walls; a terrain (GameObject → Terrain, Set up material: grass, soil, moss, cliff; painted through noise, sculpted); decals from two images (drop zone → texture), placed, a 41-decal scatter stroke, two selected and edited at once, **Rebuild pages** (2 pages 512², 699 KB, composed 1.9–2.0 s); Play from five cameras (wide and close-ups) and the static export. 56 JPEGs in `~/.cache/thirdlight-phase35/acceptance/` (looked at; owner look pending). Found and fixed: texture-array requests starved the editor's connections (D257, at most 2 in flight), a block type's Materials could not be added in the Inspector (D258, e2e `block-world-uv`). Found, logged: trim layers on block walls show the whole sheet per cell face (D259), height-in-alpha sheets draw their decal cells invisible (D260), stale material warnings in Problems (D262). §4 after: layered walls unchanged since 35.3 (no drawing code changed: 5.71 / 6.51 ms 1 / 4 layers); decal atlas, 200 images (100 pages 512²) cold **22.2 s** vs ≤ 2 s (miss, D261), warm 24 ms, off the main thread (backend pings p50 1 ms, max 276 ms). Building layer arrays (two 2048² sheets + two 512² sets) in ~104 s after the last pick. Manual: decals (New material dialog, cell opacity), trim sheets (shared rows, block walls, decal cells), layered surface UV sources checked against the editor; vertex paint matches. |
| 35.9 | Done 2026-10-13: review fixes (decision log): the full gate's 3 failures (New material dialog in `project-items`; constant heights read as "no height" in `painted-terrain`) fixed and rerun green alone (3 passed, both renderers); block walls wear trim strips (D259, e2e `block-world-uv` pixels on both renderers, screenshot looked at); generator grime a grime effect, converted trim keeps its base tint, export-safe trim group keys (real export), byte-bounded command batches, instance resolution, neutral empty slots, terrain without mesh UVs, D260 cells opaque, the wall-stroke notice; encoder pool: atlas 200 images 52.8 → 20.2 s (D263 still over ≤ 2 s), slot arrays 107 → 31 s (D264). Fast gates: vitest 703 files, e2e 41 (area files; one expectation updated for the cell-only page), village WebGPU p50 5.5 / WebGL 2 4.8 ms within limits. Unverified by eye: the converted building's tint and grime in the editor, the Scene view's opaque sheet cells, the stretched row on cells taller than a row. |
| Phase gate | `full --both-renderers` at `c338acd5` (2026-10-13 05:47, 2 workers): build, lint, vitest 702 passed; e2e 387 passed, 3 failed (also alone) in 24.6 min; 36 min with the rerun — **OVER BUDGET** (15 min), peak 6.7 GB, no OOM. The 3 fixed in 35.9 (`f21ab60c`) and `tools/gate.sh rerun` green (3 passed). D253 stays open with these numbers. |

## 6. Decision log

- 2026-10-12 — Planned from the owner's material questions: one layered
  type for terrain and walls, defaults to start from, Customize to graph,
  height in alpha, a decal editor with atlasing.
- 2026-10-12 (35.0) — Plan re-read against phase 34's outcome: only §2's
  facts changed (listed in §5); the items stand. 35.5 is smaller than
  planned, since `paintVertices` already takes the brush kit's opacity, mask
  and hardness.
- 2026-10-12 (35.1) — The walls switch. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**; its numbers were uncapped, re-baseline at the 60 Hz cap if needed):
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
- 2026-10-12 (35.2) — Material types. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**):
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
- 2026-10-12 (35.3) — The layered surface. Defaults chosen, owner to confirm (**reversed in part by the owner 2026-10-22 → 39b.6c:** trim is just another layer with its own UV source, vertex A = wetness over every layer, and there is no built-in grime):
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
- 2026-10-12 (35.4) — Height in alpha. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**):
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
- 2026-10-13 (35.5) — The vertex paint editor. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**):
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
- 2026-10-13 (35.6) — The decal editor. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**):
  - **A scene's edit mode**, not an object's: `SceneEditModeKind` (scope `scene`, the component whose objects it edits,
    a header icon, a note and the isolation chip's words) beside the object modes; the shell skips framing, Home and
    Context for it (the whole scene is already drawn), and the isolation names a component instead of ids
    (`ViewIsolation.component`, followed as decals come and go). Every other object's icon and light gizmo stands
    aside meanwhile (they would stand over the decals and pick nothing).
  - **The decal selection is the editor's own** (`useDecalTools`), drawn by the tool (outline in the selection
    colour, screen-sized corner squares, the ring and grips on the primary = last picked); entering clears the app's
    selection and Done restores it, as in every edit mode. Esc clears the decal selection first, then leaves.
  - **One command for many:** `setComponent` takes additive `entityIds` (more objects, the same partial value merged
    into each one's own component) and `values` (each one's own value, for a field whose other parts differ: one
    width over different heights) — one revision, one undo, the further objects as the command's follow-ups (the
    clients take them from the change). Generic, in the MCP docs. `CREATE_ENTITIES_MAX` and the new
    `SET_COMPONENT_ENTITIES_MAX` (request sizes, not project caps) moved to project-model's limits so the editor can
    read them; a longer scatter stroke or larger selection goes as more commands.
  - **Scatter:** density is decals per m² of surface; places are random points of each dab's disc on the surface's
    plane, at least `0.5 / √density` apart, new ground only (a dab skips what earlier dabs covered), seeded per dab;
    each is dropped onto the surface along the dab's normal (walls and slopes as floors). A stroke is one
    `createEntities` with the scene on the batch. No erase brush (Delete in Select removes).
  - **Blend is the material's** (`setMaterial`; disabled while the selection is projected, which blends per channel,
    and for mixed materials or instances). A palette pick with decals selected gives them that material.
  - **Move** drags only the pressed (selected) decal; Ctrl+D duplicate and W/E/R handle keys (in the mockup) are
    not built. Delete is one `deleteEntity` per decal, as the editor's delete (there is no batch delete op).
  - **Bake to model** moved from the Inspector to the Selection section (the Inspector keeps the plain fields and
    the mode's **Edit decals** button). The toolbar's **decal** button stays (it opens and closes the editor; the lead's
    brief) although the row said it goes.
  - **No Atlas rail mode yet:** 35.7 puts its drawer in the mode's view extra (`decal-mode.tsx` marks the place).
  - The plan's "`handles.e2e.ts` decal steps": there were none; the decal tool steps lived in
    `projected-decals-scene.ts` (driven by `layered-material.e2e.ts`, both renderers) and are rewritten there.
  - Found and fixed: the Scene view's decal pages are drawn by an opaque node material, which writes alpha 1, so every
    projected decal in the Scene view drew as its whole rectangle (Play's built pages were right); the page quads now
    draw with `NoBlending`. Seen fixed in WebGPU screenshots; WebGL 2 not looked at. A Shift+click in an edit mode's
    view selected the page's text (`user-select: none` on the view; the tool's presses prevent it too).
  - Found, not fixed: D256 (projected decals added in the Scene view after load do not draw on a box floor until a
    reload; terrain and block tops draw them at once). Engine source comments no longer name a game (three-adapter).

- 2026-10-13 (35.7) — The decal atlas. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**):
  - **A drawer, not a rail mode** (the mockup's decision 5): along the view's bottom in every mode, its head always
    shown, open/folded remembered per browser. The mockup's "Atlas" rail item is not built (the drawer is always
    there). The shell gained a scene mode's `drawer` slot (the view extra sits in the top chip row).
  - **The pages are the build's, read on the backend**: `GET …/content/decal-pages` takes the captured project,
    finds the shipped materials as the closure does (exporter `shippedMaterials`, now the closure's own code path)
    and reports project-model `decalPageReport` of `planDecalPages` on the same inputs (`decalPageInput`). Plan
    entries gained `source` and `side` (additive, build output unchanged).
  - **"Unused"** is page area no image rectangle covers (a whole sheet page counts only the cells drawn);
    **GPU memory** is 1 byte a texel (16 bytes a 4 × 4 block, the KTX2 pages' transcode) with every mip level,
    over every set's pages; it equalled the adapter's own count in the e2e (262,224 B).
  - **The offender** is every image whose page side is the pages' size, when that is above the smallest page;
    the hint re-plans with their textures (and their sheets' tables) halved and says the pages and memory then.
    There is no "Halve" button (the mockup's): shrinking an image is a texture edit outside the editor.
  - **Rebuild pages** runs the closure's own `closureDecalPages` with the backend's decal page assembly (encoding on
    the KTX2 worker thread, cached in the import cache — the next Play and export find them made). The last
    composition is remembered per project in memory with a signature of the plan and its textures' digests; the
    `GET` answers it only while the signature matches, so an edit that changes the pages puts the Scene view back
    on the materials' own textures until the next rebuild (the editor reads again after decal-relevant edits,
    debounced, only while the drawer shows or composed pages are drawn). A restarted backend composes again on
    request. **"Scene view draws from the pages"** (on by default) chooses between them.
  - **A click on a rectangle selects** every decal of its materials (the editor's selection; it shows in Select).
  - **D256** was a frame, not the box: on WebGL 2 the frame that writes a decal row in place draws without it, and
    the on-demand view drew no other. Fixed by asking for one more frame after an in-place write; the e2e
    box-floor step does not fail without the fix (other frames follow there), the vitest pins the frame request.
  - **Delete of a multi-selection** (decal editor and Scene view) is one `deleteEntity` with additive
    `entityIds` (union of the subtrees, one revision, one undo; the inverse puts each object back at its index);
    `DELETE_ENTITIES_MAX` (1,024, a request size like `SET_COMPONENT_ENTITIES_MAX`) in project-model's limits; a
    larger selection goes as more commands. The undone placement's id may come back on the next create (the e2e
    tells decals apart by place).

- 2026-10-13 (35.8) — Acceptance. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**):
  - **Real trim sheets from the Studio** (two sheets of one game's set, rendered with the packing that puts height in
    the albedo's A): they come from different layouts, so their row tables differ past the six rows a room uses
    (moss_edge, column, bevel, emissive vs column, bevel, emissive, end_grain, stave at other pixels). The pass deletes
    the other rows in both Inspector tables (and the wood crown's "tiles in v", whose padding check then warns), as a
    user would; a layered surface reads every trim layer with the first sheet's rows.
  - **The building wears the sheet through the Inspector's Materials component ("*")**, then the vertex paint editor's
    Make it a layered surface (base = the sheet); the block wall's block type takes the same material in the block
    type form (D258 fixed for it). Block walls are painted with the Blocks panel's Paint texture (walls), the only
    wall paint for blocks; it has no noise mask.
  - **Look notes** (owner look pending): vertical walls under the gradient sky read paler than their textures (the
    near-white horizon in the specular of moss rough 0.53 and rust's metal parts); the stone sheet's dark grey makes
    the building dark overall; the window panes show the sky band. A Paint texture stroke along the block wall at 2.2 m
    stored nothing in three runs (the same stroke at 2.4 m did; not investigated further). The vertex paint editor frames
    the building small at 1080p (the wheel zooms in).

- 2026-10-13 (35.9) — **Phase review** (fresh reviewer, `eb3e6dc6..c338acd5`, one page). High: the done-when is
  unmet for block walls (D259: trim layers show the whole sheet per face) and a block-wall Paint texture stroke stored
  nothing; decal scatter strokes of ≥ ~318 decals were refused whole (count-only chunks under the 64 KiB request cap).
  Medium: e2e time grew despite D253; a converted trim building brightens (the grey stand-in tint dropped); generator
  grime leaks into layer 2; D260/D261; layer arrays ~104 s with no D-row; layered trim + tiling exports fail validation
  (`albedoHeight@trim`); an unwired Height blend's labels disagree with its compile; Make it paintable on an instance
  gives a blank base; batch `setComponent` leaves other instance sets' paint stale; terrain + "mesh UVs" reads past
  its arrays. Low: empty slots black/white, a failed delete chunk clears the selection, the atlas lock and its `last`
  map, stale composed pages, `sheetProblems` on instances, `assign.slots` duplicates, instance paint-tint labels, a
  history-style comment, `modesOf` constants, self-recorded WGSL digests, uncancellable fetch-gate requests.
  **Fixed in 35.9**: every High and Medium except as noted below, and the Lows but the last three (D267). The phase's
  full gate (36 min, 3 failures, each also failing alone) was fixed and its failures rerun green alone.
  Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**, except the two marked reversed below):
  - **The full gate's three failures** were real: `project-items` still typed into Create → Material's old in-place
    name (35.2 put the New material dialog there; the test now names it in the dialog), and `painted-terrain`'s
    per-layer slots drew a cross-fade because 35.4's check called a **constant A** flat and replaced it by the
    brightness height (128 for a plain colour), so layers whose heights are uniform (230 vs 20) blended evenly. Now
    only an opaque A (≥ 255 − `FLAT_ALPHA_SPREAD`, give or take noise) counts as "no height"; a constant below
    opaque is a deliberate height (a layer that is uniformly high or low wins or loses every blend crisply). The
    import-cache marker's version went up, so files checked under the old rule are checked again.
  - **Block walls wear trim strips (D259)**: the renderer turns a block chunk's metre UVs into strip UVs for a
    material with a row table (a trim material, a layered surface with trim layers), as it already turned them into
    cells for old layered materials (`block-cell-uv.ts`, kept per mesh, swapped as the material changes): a wall
    triangle takes u along the wall in metres × its row's density ÷ the sheet's width (continuous along the wall, as
    a generated wall's) and v across its row from the bottom to the top of the cells it spans; the layer's first
    storey of cells wears `lower_wall`, the storeys above `upper_wall`, tops and undersides `floor` (falling back
    along that list, then the sheet's first row). One row per cell face: the mesher makes one quad a face and a row
    cannot repeat inside a quad, so a row shorter than the cell is stretched up the face (a generated wall stacks it
    instead) — the owner's eyes; cutting faces at row height is the mesher's job if the stretch looks wrong.
    Stand-ins and world-mapped model looks; a model's own UVs are left alone. e2e `block-world-uv` checks the
    colours of a three-row sheet on a wall (lower wall only) and the tops (floor only), both renderers.
  - **The Paint texture stroke that "stored nothing"** (35.8): the backend answers an edit that changes nothing with
    `no_change`, which the editor took quietly while the stroke's preview vanished. An unpainted wall point already
    holds layer 2 in full (the walls' own default), so painting layer 2 there changes nothing; the editor now says
    so in a notice (e2e `terrain-paint`). Not the whole story: a model-level repro of the acceptance's strokes stores
    both, and the acceptance could not be rerun (its textures are gone) — D266, watch.
  - **Generator grime is grime, not layer 2**: the Layer weights node no longer adds the trim data's G to layer 2
    (with a second trim sheet there the path paint showed as that sheet); it has a `grime` output (trim data G,
    0 elsewhere) and the layered template pulls the colour toward `grimeColor` (`GRIME_COLOUR`, the trim material's
    default, now defined once) and the surface toward matte by `grime`. Stored layered materials don't wire it: on
    them the generator's grime simply stops showing.
    **Reversed by the owner 2026-10-22 → 39b.6c:** no built-in grime; grime is a painted layer like any other.
  - **A converted trim building keeps its look**: the layered template has a base-layer tint (`color`, white), and a
    layered surface whose base layer is a trim sheet takes the tint of the material it is put over, as a trim
    material does (generated architecture's grey stand-in `#9a968c`) — only the base layer, so moss and rust keep
    their own colours. Layered materials made before (no `color`) stay as they are. The alternative — drop the grey
    for trim too, so both are the sheet's own colour (brighter) — changes every trim building's look; owner decides.
    **Reversed by the owner 2026-10-22 → 39b.6b:** trim sheets draw at their own colour; a material's tint is a visible field, white by default, and nothing inherits the grey stand-in.
  - **Request batches by bytes too**: one chunker (`session/request-batches.ts`) cuts scatter strokes, multi-edits and
    deletes by the op's count and by `MAX_REQUEST_BYTES` (moved to project-model's limits so the editor reads the
    one value; commands re-exports it), keeping 1,024 bytes for the envelope. A long stroke is then several
    commands (several undo steps), not refused whole; a refused batch ends the run and keeps what was stored and
    still selected. `assign.slots` refuses a slot named twice but takes names the object does not draw with (slot
    names are an open set). Batch `setComponent` refreshes the paint table of every instance set it names.
  - **Export-safe trim groups**: the draw-time trim group key is `<key>_trim` (`TRIM_GROUP_KEY`, an identifier as the
    runtime's key rule wants; a material that already has that key keeps one array) and drawn node ids are valid
    ids — layered materials with trim + tiling layers failed export validation before (proved by a real export).
  - **An unwired Height blend declares vertex paint, raw** (R–A = layers 1–4, its documented compile), not layer
    weights, so stored programs stay and the vertex paint editor shows raw channels.
  - **Empty slots are neutral** in a drawn layered surface (mid grey, height 0: never wins a blend; an all-empty
    group borrows that constant layer from the other group's array).
  - **Terrain**: a material with more than four layers draws as it is (no trim/tiling regrouping), and the terrain
    editor offers no "mesh UVs" nor trim sheet (D265 keeps the Material editor's case).
  - **Instances**: Make it paintable, the paint meaning and the sheet check resolve a material instance first.
  - **Decal cells of a sheet read as a layer** are copied onto pages with A opaque, and the Scene view draws them
    opaque before Rebuild pages (D260; owner's rule: a cell follows its sheet's declaration).
  - **Encoding**: a KTX2 encoder pool (cores − 2, ≤ ¼ of the memory the process may use — its cgroup's cap where one
    applies, so capped test runs keep one worker a backend — at 1.25 GiB a worker, ≤ 4); decal pages and UASTC slot
    layers encoded side by side (joined texel-identically); ETC1S level 1 for arrays assembled on request (1.8×
    faster, −0.09 dB; imports keep the default). Bench (`TL_BENCH=1 texture-assembly.bench.test.ts`, noisy
    synthetic images): 200-image atlas cold 52.8 → 20.2 s (still over ≤ 2 s: D263), six slot arrays 107.2 → 31.3 s
    (D264). The atlas composes once per project at a time with one waiting (concurrent requests share it); the last
    compositions are kept for 16 projects; a failed re-read drops composed pages from the Scene view.
