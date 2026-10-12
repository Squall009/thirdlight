# Phase 34 — Level editors: the edit-mode shell, brushes and the terrain editor

Goal: editing a terrain is its own full-screen editor, not a block of
fields in the Inspector. While you edit a terrain you see the terrain and
its tools and nothing else. Every brush in the engine shares one set of
settings, one panel, one cursor and one shortcut map. Painting picks layers
from a palette of the material's actual textures, and can paint through a
noise mask to break up tiling. Every object in the hierarchy and the Scene
view shows what it is at a glance.

This is the first of three phases from the owner's 2026-10-12 review of the
level-building workflow ("everything is crammed into the inspector"):
- 34 builds the shell, the shared brush kit, the palette and the terrain editor;
- 35 builds one layered surface material for terrain, blocks and walls, the
  vertex paint editor and the decal editor (`plan-phase-35.md`);
- 36 builds the block editor, kits and the trim sheet spec (`plan-phase-36.md`).

All three run before phase 33 (occlusion), whose WIP stays parked on
`wip/33.1-measure`. The engine never reads the game repos; nothing here is
fitted to one game.

**Release checks run when the phase starts (34.0):** three.js (pinned
`0.186.1`; a patch is taken in 34.0 after reading its notes, a minor is its
own item) and Rapier (pinned `0.20.0`; nothing here depends on it).

## 1. Owner decisions (2026-10-12)

- **Full-screen editors, as with the material editor**, for terrain, block
  layers, vertex paint, material mixing and decals. They share common UI:
  brush size, strength and opacity indicators, palettes, panels. Anything
  the editors have in common looks and works the same in each.
- **Only the edited object is shown while editing it** ("you should only see
  the terrain and terrain tools when editing a terrain, just like with
  block layers").
- **Reuse the Scene view's viewport.** The edit mode borrows the live Scene
  view canvas with input. There is no second renderer.
- **Layer painting picks from a palette** of the materials in the terrain's
  texture-array slots, and can **paint with noise** to break up the tiling.
- **Every object type has its own icon** in the hierarchy and the Scene view:
  block layers, terrains, lights by type, and so on.
- **Order 34 → 35 → 36, then 33** (owner approved 2026-10-12).
- *Proposed, default chosen, owner to confirm:*
  - **A layout mockup first (34.2).** Static screenshots of the terrain,
    vertex paint, decal and block editor layouts, for the owner to approve
    before the shell is built.
  - **Opacity and strength are separate.** Strength is how much one dab adds
    (flow). Opacity is the most one stroke can reach (Photoshop and Substance
    behaviour).
  - **Selecting a terrain no longer arms a brush.** Brushes are live only
    inside the terrain editor.
  - **Brush settings persist per editor and per tool** in the browser
    (localStorage), not in the project.

## 2. Where things stand (recon 2026-10-12, at `47999af5`)

- **Full-screen editors exist for documents only** (`ui/workspace/EditorWindow.tsx`,
  the `DOCUMENT_KINDS` registry in `kinds.tsx`). They share a header,
  toolbar and empty state (`ui/chrome/EditorChrome.tsx`) and the one
  Inspector. They have no interactive 3D view:
  - `PreviewPane` is a small renderer of its own;
  - `useSceneViewLending` moves the Scene view canvas into a pane but takes
    no input (`viewport.setLent(true)`, `viewport.ts:1094`).
  Phase 27 put Blocks and Terrain in the Inspector for that reason
  (`plan-phase-27.md` decision log, ~line 324).
- **Terrain UI** is `ui/TerrainPanel.tsx` (395 lines), mounted in
  `InspectorDock.tsx:446-458`, plus `SurfaceRulesEditor`,
  `ScatterRulesEditor`, `TerrainLayersPanel`, `viewport/terrain-editor.ts`
  (373) and `session/terrain-brush.ts` (212). Problems found:
  - paint swatches are four placeholder colours repeated (`TerrainPanel.tsx:180`),
    not the material's textures;
  - layers are bare numbers in paint, rules and scatter;
  - nothing in the panel creates or assigns the terrain's material;
  - "Strength" is metres for raise/lower/noise and a 0–1 blend for the rest;
  - selecting the terrain arms the brush (`TerrainPanel.tsx:61`);
  - tiles can only be added by a heightmap import;
  - stamps can be removed but not moved or resized;
  - many scatter and erosion fields are API-only.
- **Four brush UIs, nothing shared above the maths.** Each has its own
  settings, panel and viewport class: terrain, block paint
  (`BlocksPanel.tsx`, `block-editor.ts`), vertex paint
  (`VertexPaintPanel.tsx`, `vertex-paint-tool.ts`) and the instance brush
  (`InstanceBrush.tsx`, `instance-brush.ts`).
  - Only the stroke maths is shared (`project-model/src/paint-brush.ts`,
    121 lines) and the ring line (`viewport/helper-shapes.ts`).
  - No brush has size/strength keys, an opacity setting, a falloff ring or
    sliders. Ctrl erases in some tools; vertex paint has an Erase toggle.
  - Number inputs are raw `<input type=number class="tl-blocks__num">`;
    there are about seven separate slider/number components.
- **No noise in painting.** Noise exists as a sculpt tool and as a rule
  condition (`surface-rules.ts:245`), never in a paint dab.
- **Hierarchy icons:**
  - Descriptors can name an icon (`descriptor-components.ts`, `icon:`), and
    `iconKindFor` picks it (`viewport/icons.ts`).
  - Terrain, blockLayer, architecture, spline, decal, instances, probe grids
    and other level objects have none, so they show the plain entity icon.
  - Every light shows `sun` (`Hierarchy.tsx:717`, `ROW_ICON.light`), although
    `light-point`, `light-spot` and `light-hemisphere` icons exist.
- **Files near the split rule:** `viewport/viewport.ts` 1,991 lines (touched
  by the shell's input routing: split first), `session/client-core.ts`
  1,866, `graph/GraphEditor.tsx` 1,398, `ui/App.tsx` 1,266.

## 3. How other editors do it (to re-read in 34.0)

- **Unreal landscape mode, Unity terrain tools:**
  - a mode that replaces the details panel with a tool palette;
  - brush size, strength and falloff shown on an inner and outer ring;
  - `[`/`]` for size;
  - a layer palette with texture thumbnails;
  - a "noise" brush and paint-with-mask.
- **Substance Painter:**
  - size, flow and opacity as three separate settings;
  - `F` / `Ctrl+drag` resizes in the view;
  - procedural masks on a brush (noise, grunge).
- **Blender sculpt and paint modes:**
  - the header holds the brush settings;
  - `F` and `Shift+F` resize and set strength in the view;
  - the cursor shows the radius and its falloff curve.

## 4. Items

Order: icons → mockup → split → shell → brush kit → noise → palette →
terrain editor → acceptance. Within an item: data and commands → adapter →
editor → tests.

Rules for every item:
- Format changes are additive on schema 7. This phase adds only command
  arguments and optional fields.
- Every editor change has a Playwright test against a real backend.
- Brush maths stays in `project-model/src/paint-brush.ts`, so the editor's
  preview and the backend's bytes are identical (vitest compares them).

**E2E budget (D181):** the full gate is already over budget. The phase adds
no new e2e file. Tests that drive the Inspector's terrain panel
(`terrain-cdlod-steps.ts` `terrainTools`, `materialRules`, `scatterRules`,
`editLayers`) are **rewritten** to drive the terrain editor. The added time
is recorded.

| Item | What |
|---|---|
| 34.0 | This plan and plans 35 and 36, their rows in `docs/STATUS.md` and `docs/roadmap.md`. The three.js and Rapier release checks. §3 re-read. |
| 34.1 | **An icon for every object type.**<br>• Every component descriptor that defines what an object *is* names an icon: terrain, block layer, architecture (rooms/buildings), spline (road, river, plain by its `terrain.shape` / mesh), decal, instance set, probe grid, reflection probe, light layer volume, audio source, camera, light by type (directional, point, spot, hemisphere, ambient), model, prefab instance, UI.<br>• **One order decides** which icon an object with several components shows (`iconKindFor`); the light row reads the light's type instead of always `sun`.<br>• The Scene view's billboards use the same table.<br>• A tooltip names the type ("Terrain · 4 tiles").<br>• Icons are made the 7b way (generated, alpha cleaned with `tools/png-alpha-clean.py`, one style), as WebP under `public/icons`.<br>• e2e: extend `placeholders.e2e.ts` (icons load, each kind's row shows its icon). |
| 34.2 | **Layout mockup for the owner.** Static pages styled with the editor's tokens (no product code), screenshotted with Playwright:<br>• the terrain editor in Sculpt and Paint mode;<br>• vertex paint;<br>• the decal editor;<br>• the block editor.<br>Each shows the tool rail, the settings column, the brush panel, the palette, the cursor with its rings, and the status line. Saved under `~/.cache/thirdlight-phase34/mockup/` and shown to the owner. **34.3 starts after the owner's look**; changes go into §7. |
| 34.3 | **Split before growing.** `viewport/viewport.ts` (1,991 lines): move pointer routing and the tool arming (`setVertexPaintTool`, the terrain/block/decal/instance hooks at 1554/1615/1646) into `viewport/tool-input.ts` with no behaviour change. `npm run build` and the existing e2e files of the area stay green. |
| 34.4 | **The edit-mode shell.**<br>• **Entering it:** an object type registers an edit mode, like `DOCUMENT_KINDS`. You enter by double-clicking the object in the hierarchy or Scene view, with **Edit** in its Inspector header, or straight after creating it from the GameObject menu.<br>• **Layout:** the shell takes the work area over, as the editor window does (menus stay, the default view goes `inert`). It has:<br>  – a header: icon, name, **Done** (Esc);<br>  – a left tool rail;<br>  – the Scene view canvas in the centre, lent with input;<br>  – a right settings column;<br>  – a status line with the current tool's hints and keys.<br>• **The viewport:** the live Scene view renderer and scene, not a copy. `useSceneViewLending` gains an interactive mode in which pointer and keys reach the mode's tool and the camera (orbit, fly, frame-selected).<br>• **Isolation:** only the edited object draws (others move to the hidden view layer, as cut-aways do). A **Context** toggle shows the rest ghosted and unpickable.<br>• **Behaviour:** one undo history (the backend's); MCP edits arrive live; starting Play sets the mode aside and returns to it; the selection is restored on Done. Edits are the same commands as before.<br>• e2e: extend `editor-window.e2e.ts` (enter, isolate, context toggle, Esc, Play aside, MCP edit visible, undo). |
| 34.5 | **The shared brush kit.**<br>• **Settings** (`session/brush.ts`, one type for every brush): size (metres), strength (per dab), opacity (per-stroke ceiling), falloff (smooth, linear, constant, plus a curve), spacing (fraction of the size), invert, and a noise mask (34.6). Each editor declares which settings its tools use. A sculpt tool's height step is its own labelled setting, not "strength".<br>• **Panel** (`ui/brush/BrushPanel.tsx`): sliders with number fields, from one new `SliderField`. The same component replaces the raw number inputs in the panels this phase touches.<br>• **Cursor** (`viewport/brush-cursor.ts`): an outer ring at the size, an inner ring where the falloff starts, and a strength fill, laid on the surface. Colour for paint, red for invert/erase. One helper for every tool (closes the copies in `terrain-editor.ts` and `block-editor.ts`).<br>• **Keys** (one map, listed in the status line): `[`/`]` size, `Shift+[`/`]` strength, `F` drag to resize in the view, `Shift+F` drag strength, `Ctrl` held inverts, `X` paint/erase, `Alt`+drag orbits, Esc cancels a stroke.<br>• **Opacity** is applied in `paint-brush.ts`: a stroke carries its start values and a ceiling, so preview and backend agree. It is an additive argument on `editTerrain`, `editBlocks paint` and `paintVertices`.<br>• Settings persist in localStorage per editor and tool.<br>• The terrain editor uses it first. Vertex paint and the instance brush move onto it in 35.5, block paint in 36.5.<br>• vitest: settings, opacity bytes equal between preview and command. |
| 34.6 | **Paint through noise.**<br>• A brush mask in `paint-brush.ts`: world-anchored fractal value noise (the terrain noise hash) with scale (metres), contrast, threshold, octaves and seed. A dab's weight is multiplied by the mask at each sample, so tiles and repeated strokes stay seamless.<br>• Additive `mask` argument on every paint command; byte-identical preview.<br>• The brush panel shows the mask live as a small swatch, and the cursor's fill shows it too.<br>• vitest: same bytes in preview and backend, seam-free across a tile edge. e2e: one masked stroke in the terrain editor (pixels differ from an unmasked one; undo). |
| 34.7 | **The layer palette.**<br>• `ui/palette/LayerPalette.tsx` shows a layered material's layers as tiles: a thumbnail of each layer's albedo (from the texture-array slot), its name and its index.<br>• **Names:** an optional per-layer `layerNames` on the material (additive); absent = the slot texture's name.<br>• An empty slot is a drop target for a texture (the existing per-layer slots, `texture-slots.ts`). A layer's tiling, normal strength, height contrast, offset and projection are edited in place (the `LayerSettings.tsx` table moves here and is reused by the material document).<br>• **Set up material:** when the object has no layered material, one button creates one from the Height-blended layers template and assigns it (one undo step; two commands sent as one history entry, see §7).<br>• Thumbnails come from the backend's texture thumbnails, never a second renderer.<br>• Terrain uses it here; vertex paint and block paint in 35 and 36. |
| 34.8 | **The terrain editor.** An edit mode with these modes on the rail:<br>• **Sculpt:** raise, lower, smooth, flatten, noise, ramp; a height step in metres.<br>• **Paint:** the palette (34.7), the brush kit, noise mask, erase.<br>• **Holes.**<br>• **Material rules:** the rules list with layers picked from the palette by thumbnail, not by number; a live preview of the bake.<br>• **Scatter:** every rule field the API has (yaw, sink, seed, density falloff, all `layers` conditions); a hand-scatter brush.<br>• **Stack:** edit layers and stamps; stamps get move, turn and resize handles in the view; erosion runs here.<br>• **Tiles:** the tile grid drawn in the view; click an empty neighbour to add a tile, remove a tile; heightmap import.<br>• **Settings:** tile size, spacing, height range, LOD, collision.<br>The Inspector shows only the terrain's plain fields and an **Edit terrain** button. `TerrainPanel` and its inline forms are removed from the Inspector. Creating a terrain enters the editor, as one undo step. e2e: the rewritten `terrain-cdlod-steps.ts` steps. |
| 34.9 | **Acceptance.**<br>• A real-browser pass on this host: create a terrain, set up its material from four textures, sculpt, paint with and without noise, add rules and scatter, add a tile, undo through it, Play, export.<br>• Screenshots for the owner.<br>• The manual: `docs/manual/guides/terrain.md` rewritten around the editor; the shared brush keys on one page.<br>• The terrain editor's perf in §5. |
| 34.10 | **Review fixes.** The phase review's findings (one fresh reviewer, AGENTS.md) and the full gate's real failures. |

**Done when:**
- A terrain is created, given a material, sculpted, painted from the palette
  with a noise mask, ruled, scattered and extended by a tile entirely in the
  terrain editor, in a real browser, with nothing else drawn while it is
  open (pixels; look: owner look pending).
- The hierarchy and Scene view show a distinct icon per object type.
- No terrain tool is left in the Inspector.
- The phase adds no e2e file; its added time is recorded.
- `tools/gate.sh full --both-renderers` is green.

## 5. Soft performance targets

Iris Xe, 1080p, WebGPU (WebGL 2 recorded).

| Measure | Target |
|---|---|
| Entering or leaving the edit mode | ≤ 150 ms to first frame, no shader recompiles for unchanged objects |
| Isolated terrain view | frame ≤ the same view with every other object present |
| A paint dab with a noise mask | preview within the frame; the command p95 ≤ 100 ms, as today |
| Palette thumbnails | loaded once per texture, ≤ 64 KB each |

## 6. Progress and measurements

| Item | Status |
|---|---|
| 34.0 | — |

## 7. Decision log

- 2026-10-12 — Planned from the owner's review and four recon reports
  (full-screen editors, block kits and trim sheets, terrain, vertex paint).
  The vertex paint editor moved to 35 because its channel labels come from
  35's layered surface material.
- Open: whether "Set up material" may send two commands as one history
  entry or needs a combined command. Decided in 34.7 against
  `docs/architecture/commands`.
