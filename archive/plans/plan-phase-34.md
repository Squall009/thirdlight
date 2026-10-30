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
- *Proposed, default chosen, owner to confirm (**owner 2026-10-22:** the brush rules confirmed; the mockup-first rule is moot (phase 37's ruling and mockup)):*
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
- Brush maths stays in `project-model/src/paint-brush.ts`, one function for
  the editor's CPU path and the backend. The GPU preview is its own shader
  code: it matches the stored bytes within 1 byte of weight (e2e, both
  renderers), not byte for byte.

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
| 34.6 | **Paint through noise.**<br>• A brush mask in `paint-brush.ts`: world-anchored fractal value noise (the terrain noise hash) with scale (metres), contrast, threshold, octaves and seed. A dab's weight is multiplied by the mask at each sample, so tiles and repeated strokes stay seamless.<br>• Additive `mask` argument on every paint command; the preview matches the stored result (measured: the GPU preview within 1 byte of weight of the backend's, e2e on both renderers; the JS mask is one function for both sides).<br>• The brush panel shows the mask live as a small swatch, and the cursor's fill shows it too.<br>• vitest: the mask's bytes seam-free across a tile edge. e2e: the GPU preview within 1 byte of the stored weights. e2e: one masked stroke in the terrain editor (pixels differ from an unmasked one; undo). |
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
| 34.0 | Done 2026-10-12: plans 34–36 and their STATUS/roadmap rows (19a20f40). three.js 0.186.1 is still the latest on npm (no update). Rapier 0.21.0 exists (2026-09-25); the pinned 0.20.0 stays (nothing here depends on it). §3 re-read; it stands. |
| 34.1 | Done 2026-10-12: one icon order (`COMPONENT_ICONS`, 29 icons) in the descriptors, value variants (light by type, spline → road/river) and a tooltip count; hierarchy rows and billboards share `objectIconFor`. 12 new 96 px WebPs in `public/icons/objects` (47.9 KiB). Billboards were squashed by the aspect (drawn ~½ wide); now square. e2e: `placeholders.e2e.ts` extended (13 types). |
| 34.2 | Done 2026-10-12, owner look pending: 8 static pages (terrain sculpt/paint/rules, vertex paint + "doesn't read paint" variant, decal editor with atlas drawer, block editor, kit editor) on the editor's own tokens and icons, Studio textures, a three.js stand-in Scene view; screenshots and `SPEC.md` (sizes, components, colours, key map) in `~/.cache/thirdlight-phase34/mockup/` (1.8 MB of JPEG at 1920×1080). |
| 34.3 | Done 2026-10-12: `viewport.ts` 1,987 → 1,777 lines; pointer routing, Esc and tool arming moved to `viewport/tool-input.ts` (440): a `SceneTool` interface (press/move/release/click/leave/cancel/key, armed) and a `ToolRouter` the viewport asks first (priority paint → block → terrain → decal → handles → brush; Esc in its old order). No behaviour change; router order covered in vitest (`tool-input.test.ts`, 7 tests); fast gate green with block-editor, instance-brush, terrain-brushes, handles, window-tools, and layered-material (decal tool) alone. |
| 34.4 | Done 2026-10-12: the edit-mode shell (`ui/editmode/`: registry `EDIT_MODES`, `EditModeShell`, `EditModeHeader`, `ToolRail`, `StatusHints`, `ViewportChrome`, one key map `session/edit-keys.ts`); the live canvas lent with input (`borrow(host, 'edit')`); isolation in the adapter (`isolation-view.ts`, a sweep of the scene's drawables: 11 swept, 6 hidden in the e2e scene); the terrain is the first mode, its old panel split by rail mode as the interim column. e2e: `editor-window.e2e.ts` extended (layout sizes, isolation and Context pixels, rail keys, a stroke and undo/redo, MCP rename and hole, Play aside and back, Esc, Inspector and Scene-view double-click entries, delete closes); `terrain-cdlod-steps.ts` drives the editor. Enter/leave to first frame 8.7–13.5 ms over 3 rounds each (target ≤ 150 ms), 37 programs before and after (no rebuild); small e2e scene, WebGPU, Iris Xe, 1920×1080 — a large level unmeasured. Fast gate green (10 min). |
| 34.5 | Done 2026-10-12: one `BrushSettings` (`session/brush.ts`: size across, strength, opacity, falloff + curve hardness, spacing, invert, height step; per editor and tool in localStorage, invert not kept), one `SliderField` (stamp/erode fields moved onto it), `BrushPanel`, `FalloffPicker`, shared `Section`/`Toggle`/`Segmented`; one cursor (`viewport/brush-cursor.ts`: ring + dark halo, dashed half-strength ring, fill, dot; `BrushHud`) for the terrain and block editors; brush keys in `edit-keys.ts` (`[ ]`, Shift, F/Shift+F drag, X, Ctrl) listed per mode. Opacity is a per-stroke coverage in `paint-brush.ts` (additive `opacity`, `hardness` on `editTerrain` paint, `editBlocks` paint, `paintVertices`); the GPU preview keeps a per-tile byte coverage. vitest: brush 5, paint-brush 7, terrain-ops +2; e2e: `editor-window` keys/F/X, `terrain-cdlod` on the new fields (+1.7 s on editor-window). |
| 34.6 | Done 2026-10-12: fractal value-noise mask (`value-noise.ts`, the terrain hash; scale, contrast, threshold, octaves 1–5, seed), additive `mask` on every paint command and the sculpt kinds, anchored to the target; masked GPU passes are their own variants (built when the mask turns on); `NoiseMask` with a live swatch; the cursor's fill shows the mask. Masked + 50 % opacity stroke, preview vs stored: weight ≤ 1 byte on WebGPU and WebGL 2, dab preview ≤ 1.1 ms a frame, commit 19 / 51 ms (targets: in the frame, p95 ≤ 100 ms). Seam-free: the same bytes per sample with 33² tiles as with one 65² tile (vitest). e2e: a masked stroke's pixels differ from the unmasked one, undo. Fast gate green (9 min; village p50 5.6 / 4.8 ms). |
| 34.7 | Done 2026-10-12: `ui/palette/` — `LayerPalette` (tiles: the slot texture's backend thumbnail, number, name, sub line; picked = brush ring; 1–9 keys; drop target), `LayerPicker` (chip + compact palette in a popover beside the column), `MaterialLayers` (the Paint column's Layers section: material chip, picked-layer line, **Layer settings…** popover, **Set up material**), `LayerSettings.tsx` moved here (the material document's table and the popover's `LayerFields` share `session/layer-palette.ts`). Additive `layerNames` on materials; `setMaterial {material, assign: {entityId}}` = one undo step. Material rules pick their layer with `LayerPicker`. Thumbnail of a 64² PNG texture: 128 px PNG well under 64 KB (asserted ≤ 64 KB), read once per texture version (the tile cache). e2e: `editor-window` (stand-ins, key pick, Set up + one undo/redo, drop, picker, name + tiling, paint the material's layer 2: stored index and pixels), `terrain-cdlod` (palette tile, rules' picker). The editor-window terrain test takes 7.6 s in the gate (terrain-cdlod 2.9 min, both renderers). Fast gate green (rendering's dynamic-resolution step failed once, passed on rerun; village p50 5.6 / 4.7 ms within its limits). Screenshots looked at against 02/03 (owner look pending): the paint column, the settings popover and the rules picker. |
| 34.8 | Done 2026-10-12: the terrain editor's columns rebuilt (`ui/terrain/`, one per rail mode, Settings added): tool grids with letter keys (`ToolGrid`), Paint/Erase and Cut/Fill as one tool each, rule cards shared with the Blocks panel (`ui/rules/`, `RangeField`, `ChipsField`; `SurfaceRule.name` additive), a live preview of the bake (the bake's own function over the drawn tiles, `TerrainView.previewLayers`), every scatter field, stamp move/turn/resize handles, the tile grid with click-to-add (`editTerrain addTiles`, edges carried on) and remove, every erosion setting; a layer's colour/normal/ORM slots with a texture browser and name-matched sets; `TerrainPanel`, `TerrainLayersPanel`, `SurfaceRulesEditor`, `ScatterRulesEditor` deleted; Inspector keeps the plain fields; a new terrain is one command. D248 fixed (a grown page uploaded only the queued layer). e2e: `terrain-cdlod` steps rewritten + `tiles` (3.0 min, was 2.9), `editor-window` green. Blur/Fill not built (no core maths). |
| 34.9 | Done 2026-10-12 (owner look pending): D249 (the grid's ground square at y = 0 fighting the isolated terrain; isolation hides grid and square) and D250 (unset normal/ORM arrays and empty slots read white; now a flat normal and occlusion 1 / roughness 0.8 / metal 0, a constant layer in the slot array; Scene view, Play, export; pixels on both renderers) fixed with e2e in `editor-window`. Real-browser pass on both renderers (create, four Studio texture sets with normal/ORM by name, sculpt, paint plain and through noise, a rule previewed and baked, scatter, a tile added by a click, 16 commands undone and redone, Play, the static export): 34 JPEGs in `~/.cache/thirdlight-phase34/acceptance/`. Found and fixed: name-matched normal/ORM missed multi-word stems; the backend's material check called filled slot lists "no texture". §5 on the landscape class (`level --edit-mode`, Iris Xe, 1080p): enter 16–68 ms WebGPU / 23–118 ms WebGL 2, leave 27–34 ms WebGPU but 576–1,184 ms WebGL 2 (miss, D251); programs 84 → 84 (WebGPU), 77 → 79 once (WebGL 2); isolated orbit frame p50/p95 6.9/9.2 ms vs full 7.3/10.0 (WebGPU), 5.2/8.1 vs 8.2/9.9 (WebGL 2); masked dab command p95 142–171 ms paint, 155 sculpt, unmasked control 182 (the mask adds nothing; the landscape's 257² tiles with scatter are over 100 ms either way); thumbnails 25–39 KB, read once per texture. Manual: `guides/brushes.md` (settings, cursor, keys), `guides/terrain.md` checked against the editor. Slot arrays of PNG layers take ~60 s to assemble after four picks (D252). Blur/Fill not built (still logged). |
| 34.9b | Done 2026-10-12 (owner look pending): visual polish after the acceptance shots. The black void was no isolation bug: the e2e project has no sky (new projects have none; sky, fog and lights are already kept by isolation — now asserted by pixels: the sky in the top tenth isolated and with Context, a bump's sun-facing slope ≥ 12 brighter than its far slope isolated, the same ±4 with Context). The edited object's icon no longer draws in its mode (icon crop with Gizmos icons on vs off: 19.2 → < 1). Entering frames a working view (64 m of ground round the middle, horizon 12 % below the top: about 20° down with the 50° lens; a view already aimed at the terrain is kept; Home still frames all); a terrain's new material starts its layers at 4 m tiling (was 1 m; existing materials keep theirs). D252: four picks → all arrays 58–62 s → 16.2–16.8 s, the replaced texture drawn meanwhile (not white); vitest for the stand-in. Acceptance JPEGs re-shot on both renderers with a scene sky (gradient) and a player-eye Play camera: sky, lit relief and readable textures (looked at: sculpt, paint, Play, WebGPU and WebGL 2). D251 not investigated (time box). |
| 34.10 | Done 2026-10-12: review Mediums 1–2 — one settle implementation (`ui/brush/settle.ts`: `SettledEdits` + `useSettledEdits`, `SLIDER_SETTLE_MS` once): edits wait as functions of the stored value by key and are applied together to the value the project holds when they rest, the handed-over ones drawn on until shown back or refused; SliderField no longer settles itself, LayerFields' copy deleted, Stack (sliders, clicks, stamp handles), Settings and the layer popover use it. vitest: two sliders within the wait both stick, an undo within it is built on, a refused save is undrawn. Lows: Paint's status line names 1–N for the layers there are, the rules line the card's title, Settings' height range on `RangeField` (new `closed` mode, Set button kept), isolation follows children added or removed while open (e2e in `editor-window`, pixels), "byte-identical" reworded to what is measured. `gate.sh`: `wait` reads the unit's result (OOM → RED), `--both-renderers` on 2 workers (D253). Fast gate: e2e 35 passed; village WebGL 2 p50 5.0 > 4.84 ms twice (tail run, this gate) → interleaved A/B against 19a20f40, 3 rounds, same quarter hour: HEAD WebGL 2 4.8/5.3/5.1 vs 5.5/5.5/5.7 ms, WebGPU 5.8/5.6/5.8 vs 5.9/5.7/5.9 ms (plain three.js page 6.5–8.1 ms, up from 6.2–6.5 this morning): host state (D199), not the phase. |
| Phase gate | `full --both-renderers` started 15:59 at 86533e2f: build, lint, vitest 686 passed; e2e 336 passed, none failed, when the 7 G cap's OOM killer ended the unit after 18.4 min (3 workers; `terrain-cdlod`, `frame-rate-cap`, `textures`, `timeline` in flight). The 13 files not reached ran separately: 54 passed (both renderers, 2 workers, 5.4 min, 5.4 GB peak). E2E all green. Over the 15 min budget (~21 min by extrapolation at 3 workers). Cause: 3 workers with every test in both renderers' browsers and the leak test; fix: 2 workers for `--both-renderers` and `wait` says RED for a killed unit (D253, open until the next full gate proves it). |

## 7. Decision log

- 2026-10-12 — Planned from the owner's review and four recon reports
  (full-screen editors, block kits and trim sheets, terrain, vertex paint).
  The vertex paint editor moved to 35 because its channel labels come from
  35's layered surface material.
- 2026-10-12 (34.1) — Icons: the plan's "probe grid, reflection probe, light layer volume and UI" are not object
  components in the engine (probe grids are baked data, reflection probes and light-layer volumes do not exist,
  UI documents are content, not objects); the probe volume, effect, prefab copy, model and box got icons instead, and
  patrol, hitbox and health (SVG glyphs until now) got generated art. Order (default chosen, owner to confirm; **confirmed by the owner 2026-10-22**):
  what an object is (camera, spawn, light, level geometry, volumes, effect, audio) before what it does (gameplay)
  before what it is made of (prefab, model, box) — so a box with a mover shows the mover. Value variants are data
  on the descriptor (`iconVariants`, dot-path conditions), not editor special cases; the light's type switch in
  `iconKindFor` is gone. The 12 new icons came from the Studio's container backend (Qwen-Image Turbo, 8 steps; the
  GPU was in LLM mode), with the kinds prompt; prompts, seeds and job ids are in `tools/icons/editor-icons.tsv`.
  Billboards: `fitSprite` divided the width by the aspect although a distance-free sprite is already projected
  with it, so every billboard drew about half as wide as tall since they were added; fixed (seen in a screenshot).
- 2026-10-12 (34.2) — Layout mockup made; **owner look pending**; 34.3 onward proceed with it (the owner was
  asleep; the brief says go on). Contract in `~/.cache/thirdlight-phase34/mockup/SPEC.md`: header 46 px with a
  brand stripe and Done (Esc), rail 76 px, settings column 340 px, optional detail column 300 px, hints 30 px;
  menus, toolbar and status bar stay, as with the editor window. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**; Esc, the atlas drawer and the brush's place were replaced by phase 37 (moot)): the rail
  holds an editor's modes and a tool grid holds a mode's tools in every editor (the block editor's "grouped
  rail" is its five groups as modes); modes switch with Shift+number (Unreal's precedent) so number keys pick
  palette entries; the brush is the brand amber, erase red, state and selection stay blue; frame is Home
  because F is the brush resize; Esc cancels a stroke, then a popover, then leaves the mode; the decal atlas is
  a drawer in the decal editor's view; the kit editor is an editor-window document with the normal Inspector.
- Decided (34.7): "Set up material" is **one command**, not two sent as one history entry. There is no
  `docs/architecture/commands` and no batch or grouping in the history (`commands/src/history.ts`: one entry per
  command); the history does have *follow-ups* (components a command writes besides its own change, undone ahead
  of its inverse: the spline/decal ones). `setMaterial` takes an additive `assign: {entityId}` that puts the
  material on that object's `materials` "*" slot (other slots kept) as such a follow-up (`'materials'` added to
  the followed components). MCP gets the same argument (tool docs).
- 2026-10-12 (34.3) — The tool registry is a list in priority order, not one "active tool": today several tools can
  be armed at once (vertex paint over block tools, the Decal tool over both) and their old precedence is kept. A
  release goes first to the tool whose gesture it ends, then to a tool that acts on a plain click (the Decal tool
  places on click, after a handle drag or brush stroke has had its release). `SceneTool.key` and `ToolRouter.key`
  exist for the edit-mode shell's key map; no tool takes keys yet (34.4 wires them).
- 2026-10-12 (34.4) — The edit-mode shell. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**; "entering keeps the camera" was replaced by phase 37):
  - **The terrain's interim column is its old panel split by rail mode** (Sculpt, Paint, Holes, Material rules, Scatter,
    Stack, Tiles), not a placeholder: every tool and rule editor works from the editor; 34.8 rebuilds the column with
    the brush kit and the palette. "Settings" (tile size, spacing, …) stays in the Inspector until then.
  - **Isolation hides the others from the shadows too.** First built as the cut-aways do (still casting), the
    screenshot showed the shadows of objects that were not drawn on the terrain — confusing. `view-hidden.ts` now has
    reasons that also leave the shadow cameras (isolation); the cached static shadow is drawn again once on entering
    and once on leaving. Lights stay switched on (no programs rebuilt).
  - **Context shows the rest as drawn, not faded.** A faded ghost needs a second pass in the adapter (or a material
    change on every object, which rebuilds programs); the rest is unpickable and the chip says "Whole scene · only X
    can be picked". The faded look is left for the owner's call.
    **Drawn as is: confirmed by the owner 2026-10-22.**
  - **No fly camera:** the Scene view has none; the mode has what it has (orbit, pan, zoom) plus Home to frame.
    Entering keeps the camera (a test or a user framed it on purpose).
  - **Entering clears the selection, Done restores it**; the mode stays open while the Game view, the editor window or
    Project Settings is in front (Play sets it aside) and closes by itself when its object is gone or loses what it
    edits. A double-click on a Hierarchy row opens the object's mode when it has one, else renames as before (rename a
    terrain in the Inspector). Notices show over the lent view.
  - **Tools:** a mode names the router's `SceneTool`s its keys reach (`ToolRouter.key(e, sel, names)`); the terrain's is
    the existing `terrain` tool.
  - Found: an MCP tile change while the terrain brush is armed stops the terrain drawing (predates the shell) — D248,
    for 34.8.
- 2026-10-12 (34.5, 34.6) — The brush kit. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**):
  - **Size is metres across**, the stroke's radius half of it; a stamp's side and an erosion square are the size.
  - **A sculpt dab moves the ground by height step × strength** (strength is one dab's share for every tool; the
    height step is its own labelled row).
  - **Opacity is a per-stroke coverage**, not a snapshot of the start: each point's coverage grows as blends compound
    (c' = c + (1 − c)·a) and stops at the opacity; the blend applied is (c' − c)/(1 − c). The same function runs in the
    commands and (in bytes) in the GPU preview, so no start values travel. Paint tools only (terrain, block, vertex);
    the block command takes one coverage per request and an editor preview can pass one for the whole stroke.
  - **The inner ring is where the falloff is at half strength** (smooth and linear fall from the centre, so "where it
    starts" says nothing); **curve** = full strength out to a hardness, then the smooth falloff.
  - **The mask is anchored to the target, not the brush**: the terrain's frame (its object's position), the block
    layer's metres, vertex paint in the world, path paint along/across the side. Walls and meshes use 3D noise that is
    the 2D noise at y = 0. The sculpt kinds take a mask too (the mockup shows it in Sculpt); ramp and holes do not.
  - **Settings are per tool** (the plan's rule; Unreal shares one brush across tools) and the fill is drawn only for
    tools with a strength and never during a stroke (it would hide the preview being laid). The swatch spans one brush.
  - Found: a TSL `If` inside the sculpt pass changed its normals (WebGPU); the masked passes became separate shader
    variants instead (also no hashing for dabs without a mask). Ping-ponged half-float coverage targets read wrong on
    WebGL 2; the coverage now goes the way the other passes do (a scratch rectangle copied into a byte texture).
  - Limit kept from before: the preview moves the drawn weights only, so on ground where several layers mix (the
    flattened strips in the e2e scene) partial paint — now common with a mask or an opacity — is settled by the stored
    tiles on release. For 35's layered surface material.
  - Not yet on the kit: the vertex paint and instance brush panels and rings (35.5), block paint's panel (36.5); their
    commands take `opacity`, `mask`, `hardness` now.
- 2026-10-12 (34.7) — The layer palette. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**, except the one marked reversed below):
  - **Layers are numbered from 1 on screen** (badges, "Layer 3", the rules' chip; the mockup's), the stored index is
    one less. The old rule hint "where none applies, layer 0" says "the first layer" for terrains.
  - **Without a layered material** the tiles are the four stand-in colours named "Layer 1–4" with "no material" as
    their sub line (the full "Layer 1 (no material)" truncated in a 3-column tile), under a brand-coloured note with
    **Set up material** first. The new material is called "<object> layers".
  - **The project window is under the edit mode** (the shell makes the default view inert, as the editor window
    does), so a texture cannot be dragged in from it while the mode is open. Tiles take drops anyway (from a future
    docked project window, and the test drives a real drop event), and a click on an empty slot or **Add layer**
    picks the texture in a popover — the path that works today. Whether the project window should stay usable
    beside an edit mode is the owner's call.
    **Reversed by the owner 2026-10-22 → 39b.6b:** the project window stays usable in edit modes (drag-in).
  - **Thumbnails** are the backend's texture tile thumbnails (`content/thumbnails/:digest?asset=`), read through
    the one `TileThumbnails` cache: a texture imported as a plain image or encoded to KTX2 from one has a picture;
    a KTX2 imported as is, or a prebuilt texture array, has none (the backend has no image to make one from and
    the editor draws none itself) — those tiles show their number and name only.
  - **A material instance** shows its parent's layers and edits nothing (open the parent from the chip); a
    **prebuilt array** shows its layers (`image.layers`) and takes names and settings but no textures.
  - **Layer settings** in the popover are sliders; a value is stored once the control rests 250 ms (a drag is one
    command). The table in the material document stays for editing all layers at once.
  - Not done here: Erase/Blur/Fill paint tools and the rules' cards and live preview (34.8), the palette in vertex
    paint (35) and blocks (36). The slots' normal and ORM arrays are not filled from the palette (the albedo's only).
- 2026-10-12 (34.8) — The terrain editor. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**; tile extension is revisited with D254):
  - **Paint's tools are Paint and Erase; Blur and Fill (in the mockup) are not built.** A blur of hand paint and a
    fill need maths in `paint-brush.ts`/`terrain-edit.ts` and a GPU pass whose preview equals the stored bytes; none
    exists yet, so the buttons are left out rather than shown doing something else. Erase is the paint tool inverted
    (one brush; X switches; the tiles follow the brush's invert). Holes likewise: Cut and Fill.
  - **A new terrain is one command:** `createEntity` with its `terrain` in `components` (the op already takes it), not
    a combined command or a follow-up. One undo takes the object and its terrain away and closes the editor.
  - **Adding a tile carries the ground on** (`editTerrain addTiles`, additive kind): each sample takes the nearest
    sample of a tile that was there (its 8 neighbours), shared-edge samples their weights and paint too — no crack,
    no cliff; rules bake it in the same command. Removing is `setComponent terrain {tiles}` without it. The grid shows
    a tile's 8 empty neighbours; a click on one adds, on a tile picks.
  - **The rules' live preview** runs the command's bake function (`bakeTerrainRules`, re-exported by the runtime) over
    the Scene view's decoded tiles nearest the view, up to `RULES_PREVIEW_SAMPLES` (1.1 M samples: all of a usual
    terrain) on the main thread after the draft rests 180 ms, and the view draws the result in place of the stored
    layers (`previewLayers`; the stored layers come back when the draft equals what is stored, the mode is left or the
    bake lands). It leaves the splines' paint out (the bake has it). **"Highlight the selected rule"** is "Only the open
    rule": that rule alone over the first layer — where it applies — rather than a hatch overlay (no second pass).
    The mockup's per-card eye is not built (it needs an `enabled` field). Rules get an optional `name` (additive).
  - **One rule-card editor for terrain and block layers** (`ui/rules/`): the Blocks panel's rules and scatter use the
    same cards (layers 1–4 by number there) with Apply/Revert until 36 rebuilds that panel; the old list editors are
    gone. Conditions are range sliders (drag a thumb to its end to open that end; typing `35–90`, `>35`, `<90`, `any`)
    with a softness each; "only where" and scatter's layers pick layers from the palette by picture.
  - **Settings sliders that store** (`SliderField settle`): a drag shows at once and sends one command once it rests
    250 ms (the layer list, the picked stamp, Settings).
  - **A layer's full set:** the layer settings popover shows its colour (+height), normal map and ORM slots, each
    picked in the texture browser (also the empty-slot picker and the stamp heightmap). Picking a colour texture fills
    normal/ORM from textures named alike (`rock_albedo`/`rock_basecolor` → `rock_normal`, `rock_orm`; the stem and the
    role word, never a near stem), overwriting those slots when a match exists, in the same command. Unset normal/ORM
    arrays still read white: D250.
  - **Inspector:** the terrain section skips the fields only the editor edits (tiles, rules, scatter, layers, overview;
    `EditModeKind.inspectorSkips`); the plain fields stay.
  - **Stamps are picked and dragged on screen** (their squares' projected corners), the drag measured on the level of
    the stamp's corners: a raycast onto the stamp's own steep mountain missed it in the e2e (the press found ground
    40 m behind). Handles are sprites of a fixed screen size.
  - Found and fixed: D248 — `TerrainView.grow` made new arrays and the next layer queued (the new tile's) made three's
    first upload write only that layer; every used layer is queued now. The backend's JPEG decode capped at
    `maxPixels / 1024²` MP while jpeg-js counts 1,000² — a slot array of 512² JPEGs refused its own size (layer
    textures from JPEGs never drew); fixed with a test. Found, not fixed: D249 (dark shapes under hidden objects in
    isolation), D250 (unset normal/ORM arrays read white).
  - Screenshots looked at against 01–03 (owner look pending): Sculpt, Paint (palette, settings with slots, texture
    browser), Holes, Material rules (cards, picker, preview), Scatter, Stack (stamp handles), Tiles (grid), Settings;
    kept in `~/.cache/thirdlight-phase34/work/shots/348-*.png`.
- 2026-10-12 (34.9) — Acceptance. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**):
  - **A texture read says what it gives without a texture** (`absent`: white, black or orm), an additive node field;
    the template's ORM reads say `orm` (occlusion 1, roughness 0.8 — the PBR output's default — metal 0) and a normal
    read gives a flat normal. A slot list fills an empty normal/ORM slot with that value as a constant layer
    (`#rrggbbaa` in the layer list) the backend assembles at the textures' size, so the Scene view, Play and the
    export agree. Albedo arrays keep filling an empty slot with the first texture (no change). Materials made from
    the template before keep their graph: their unset ORM still reads white until made again.
  - **Isolation hides the grid and its ground square**: they sit at y = 0, where terrains usually are, and showed
    through the edited terrain as dark shapes (D249). Context shows them again.
  - **The edit-mode perf check is a switch of the landscape class** (`level --edit-mode`): enter/leave to the first
    frame, programs, orbit frames in the default view, isolated and with Context, masked and plain dab round trips,
    and the first leave's main thread by function. It found the WebGL 2 leave in `setSize` (D251).
  - The acceptance drove the editor as a user does except for importing (the textures and the scatter model came in
    through the import route, as the project window's import does) and the Play camera (placed by a command).
  - Look (owner look pending): from the editor's default distance the 1 m-tiled layers read as their average
    colours (flat olive grass); close up is unverified (not looked at). The default scene has no sky, so Play and the export show black
    above the horizon.
- 2026-10-12 (34.9b) — Visual polish. Defaults chosen, owner to confirm (**confirmed by the owner 2026-10-22**, except the one marked reversed below):
  - **No default sky for new projects (unchanged).** The acceptance's black void was the project having no sky, not
    isolation (it keeps what belongs to no object: sky, fog dome, lights; asserted now). A sky in every new project
    would change the lighting and pixels of every test project; proposed for the owner instead. The acceptance shots
    set a gradient sky in the scene's look, as a user does in Window → Environment.
    **Reversed by the owner 2026-10-22 → 39b.6b:** every new project has the physical sky; the pixel baselines are re-recorded once.
  - **Relief reads with the default lights.** The flat look came from the far, top-down view and 1 m tiling, not from
    isolation: lights are skipped by the sweep and light the isolated terrain exactly as with Context (pixels).
  - **The working view on entering** (`EditModeKind.workArea`, `Viewport.frameWorkArea`): the middle of the terrain's
    tiles on the ground there, `TERRAIN_WORK_SPAN_M` = 64 m across, looking down from the present heading with the
    horizon `WORK_VIEW_SKY` = 12 % of the view below its top (20.5° with the editor's 50° lens). A new terrain always
    gets it; entering an existing one keeps a view already aimed inside its footprint (the user framed it: F on it, or
    working there before). Only on entering, not when Play hands the mode back. Home frames all, as before. Centring on
    a Scene-view double-click's point: not done. `terrain-cdlod`'s 1,025² step now zooms to its 130 m by distance (the
    view it starts from is the working view of that tile, entered earlier from elsewhere).
  - **4 m layer tiling for a terrain's new material** (`TERRAIN_LAYER_TILING_M`, the Set up button's material only):
    the template's 1 m suits a block face; landscape layers are usually tiled every few metres (the mockup's 5 m). The
    template and existing materials are unchanged.
  - **The edited object's icon is hidden** while its mode is open (with Context too); the other objects' icons go
    with their objects in isolation as before.
  - **Slot arrays at the faster UASTC effort** (`ASSEMBLED_UASTC_LEVEL`, renamed from the decal pages' constant, which
    shares it): ~3.6× faster at a negligible PSNR cost; the colour array stays ETC1S. The replaced texture stands in
    while the new one loads (generic: any graph material's texture parameter).
  - The editor-window terrain test zooms in with the wheel after the new checks, so its brush checks keep their old
    scale; its Context ground-square bound is 0.003 (a thin strip at the working view's angle).
- 2026-10-12 (34.10) — Review fixes. Decisions:
  - **The settle queue sits beside SliderField, not inside it** (`ui/brush/settle.ts`): the stale state was never one
    slider's — two sliders, a click or an undo between a move and its rest all edit one stored value — so the queue
    belongs to the value (one `useSettledEdits` per stored value: the Stack column's layer list, the Settings
    sliders, a layer's popover) and SliderField only reports moves. Clicks in the Stack column go through the same
    queue at once (so they carry a waiting slider with them); its "busy" lock is gone (it disabled a slider mid-drag).
  - **Settings' height range** is a two-thumb `RangeField` in a new `closed` mode (no open ends, typing "low–high"
    only), its track ±1 km (or ten times the range), typing to ±100 km; changing it still waits for **Set the
    range**, because it rescales every stored height.
  - `data-isolation` gains `drawn` (the objects isolation draws) for the test of children added while open.
  - **Gate:** 2 workers for `--both-renderers` (measured 5.4 GB on the files in flight at the kill) rather than
    moving one heavy file out: the in-flight set at the kill had four files, and no per-file memory log exists to
    name one.
  - Left for next time (review Low 4): `viewport/viewport.ts` is 1,948 lines and `three-adapter/src/adapter.ts`
    1,976 — the next change to either splits its area out first.
- 2026-10-12 — **Phase review** (one fresh reviewer, 19a20f40..86533e2f). Findings:
  - Medium 1: SliderField's settle kept the `onChange` of the render it moved in and called it 250 ms later; Stack
    built whole layer lists from that stale state, so a second slider (or an undo / MCP edit) inside the wait was
    reverted. **Fixed (34.10).**
  - Medium 2: two settle implementations (LayerSettings' copy of `SLIDER_SETTLE_MS`). **Fixed (34.10):** one.
  - Low 3: the brush parity vitest compares the JS core with itself; the real preview is GPU code, matched only
    within 1 byte in e2e, while the plan said byte-identical. **Reworded (34.10).**
  - Low 4: `viewport.ts` back to 1,933 lines, `adapter.ts` 1,976 — split before they grow. **Noted above.**
  - Low 5: Paint's status line always said "1–9 Layer". **Fixed.** Low 6: the rules status line said "rule N" while
    the card shows its derived title. **Fixed.** Low 7: Settings' height range was two raw text inputs. **Fixed.**
    Low 8: isolation collected descendants only on entering. **Fixed.**
  - Needs the owner's eyes: the mockup (not approved); Context is not ghosted (the rest drawn as is); the project
    window is inert in an edit mode (no drag into the palette); Blur/Fill not built; D251 (WebGL 2 leave 0.6–1.2 s);
    dab command p95 142–182 ms on the landscape class; webgpu-06 the pale layer repeats strongly at 4 m; webgl2-07
    rock on a steep slope blurred; webgpu-11 the tile grid hard to read; webgl2-15 Play shows 3 Problems (D255); no
    close-up checked; an added tile copies edge heights straight → long streaks (D254); pre-phase template
    materials keep white unset ORM (absent = white, as before, by design); slot arrays at the faster UASTC effort
    (small quality loss); no sky in new projects; the defaults to confirm (icons and their order, 1-based layer
    numbers, brush size across, per-tool memory, Shift+number, Home frames all, the 64 m working view). **Owner 2026-10-22:** the defaults decided (marked above;
    the project window and the sky reversed → 39b.6b); the looks wait for the review page.
