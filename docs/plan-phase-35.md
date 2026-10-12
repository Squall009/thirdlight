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

## 2. Where things stand (recon 2026-10-12, at `47999af5`)

- **Seven fixed shader types** (`project-model/src/materials.ts:31`):
  `standard, foliage, kit, unlit, water, trim, decal`. Material instances
  (`instanceOf`) and Convert to graph exist.
- **The 4-layer height-blended material is a graph template,** not a type
  (`editor/src/session/material-graph.ts:405-520`, `TEMPLATE_LAYERS = 4`).
  - It reads `albedoHeight`, `normals` and `orm` texture arrays.
  - Terrain gets more layers through `extraLayers`.
- **Bug:** the template's `heightBlend` weights are wired to `vertexColor`
  `COLOR_0` (`material-graph.ts:493`), so the "unwired weights = vertex
  paint" fallback never fires. The stock layered material ignores vertex
  paint on props.
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
- **Vertex paint UI** is a floating window (`VertexPaintPanel.tsx`, 203
  lines). Channels are labelled R/G/B/A with no meaning, and nothing warns
  that the material doesn't read paint.
- **Decals** (phase 32):
  - a floating Decal tool (`DecalToolPanel.tsx`, `viewport/decal-tool.ts`);
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
| A wall with 4 layers + wetness | GPU scene pass + ≤ 1.0 ms at 1080p for a village-class view (measured in 35.1, recorded) |
| Unused layers | no texture read |
| Decal atlas composition | ≤ 2 s for 200 decal images, off the main thread |

## 5. Progress and measurements

| Item | Status |
|---|---|
| 35.0 | — |

## 6. Decision log

- 2026-10-12 — Planned from the owner's material questions: one layered
  type for terrain and walls, defaults to start from, Customize to graph,
  height in alpha, a decal editor with atlasing.
