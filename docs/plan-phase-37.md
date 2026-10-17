# Phase 37 — Level editor polish

Goal: the four level editors (terrain, blocks, vertex paint, decals) and the
kit editor are **easy to use**, not only capable. The owner looked at phases
34–36 on 2026-10-16 and liked the direction: "a very solid foundation". Three
things hold the workflow back:
- a tool is always armed, so you can't just move around the scene or click
  something to select it;
- the settings column has to be scrolled to reach the items you use most;
- blocks draw white and the decal atlas is slow while textures encode.

Read `plan-phase-34.md` (the edit-mode shell) first. The engine never reads
the game repos; nothing here is fitted to one game.

**Release checks run when the phase starts (37.0).**

## 1. Owner decisions (2026-10-16)

- **Tools can be deselected.** With no tool, the editor is in **Navigate**:
  a left drag orbits and a click selects what the editor edits. For example,
  in Rooms & buildings a click on a building selects that building instead of
  drawing a new one inside it.
- **Esc drops the tool first. Esc again, with no tool, leaves the editor.**
  Clicking the active tool's tile also drops it.
- **No scrolling to reach common items.** Whatever sits below the fold of a
  mode's settings column moves out into **docked, collapsible panels** over
  the viewport:
  - panels snap to the viewport's edges and corners;
  - each collapses to its title bar;
  - a panel can be dragged from one dock to another;
  - panels never cover each other;
  - the layout is remembered per editor.
- **The load-time defects are in this phase:**
  - D264/D270: blocks draw white while layer arrays encode;
  - D263: a cold decal atlas is slow;
  - D251: leaving an editor on WebGL 2 is slow.

  Phase 33 (occlusion) follows this phase.
- *Proposed, default chosen, owner to confirm:*
  - **Editors open in Navigate.** Afterwards the editor remembers the last
    tool, and it comes back with one key or click.
  - **With a drawing tool armed, a click without a drag on an existing
    room or building selects it.** A drag still draws, so a room can still be
    drawn inside a building.
  - **The settings column keeps the tool grid and the palette.** The
    selection's properties, the brush, the noise mask and the layer settings
    become panels. 37.1's mockup settles this per mode.
  - **The fit rule:** at 1920×1080 the column needs no scroll in a mode's
    default state. Panels may scroll inside themselves.
- **Still open for the owner, not decided here:** D253, the full gate's
  budget (28 min against 15).

## 2. Where things stand (recon 2026-10-16, at `8cde51d2`)

- **Shell:** `ui/editmode/EditModeShell.tsx`. It has the left rail, the
  borrowed Scene canvas with `ViewportChrome`, a right column 340 px wide, and
  a detail column 300 px wide (folded into the column below 1440 px).
  `viewExtra` and `drawer` (the decal atlas) are the only in-view UI. **There
  is no floating or docked panel component.**
- **A tool is always armed:**
  - `DEFAULT_TILES` (`session/block-tool-state.ts`) and
    `terrain-column.ts:62-79` arm a tile whenever a column mounts;
  - block and terrain pointerDown take every left press, even off target
    (`viewport/block-editor.ts:458`, `viewport/terrain-editor.ts:291`);
  - orbiting needs Alt+drag;
  - `setBlockToolsActive` (`viewport/tool-input.ts:239`) has no callers.
- **Selection:**
  - **Rooms & buildings:** Rect, Polygon and Building always start a new
    outline (`viewport/room-tool.ts:~128-160`). A room gets picked only from
    the Rooms list, or as a side effect of Move walls, openings or pieces.
  - **Decals:** the Select rail mode handles click and box selection.
  - **Blocks:** the Build "Select" tile picks a cell box.
  - **Terrain:** stamps are picked in Stack; tiles are picked in Tiles.
- **Columns that need scrolling (1920×1080):**
  - Rooms & buildings: the Rooms list and the whole `RoomInspector` sit
    below the fold.
  - Block Build: Selection, Stamps and Layer.
  - Terrain Stack: the picked stamp's ~20 sliders.
  - Decal Select: Selection, ~8 sliders.
  - Vertex paint Channels.
  - The kit editor's settings live in the global Inspector (`KitInspector`).
- **Esc** leaves at once (`session/edit-keys.ts`). It cancels an active
  stroke first.
- **Files near 2,000 lines:**
  - `viewport/viewport.ts` (1,944) and `editor.css` (1,814): split first if
    this phase grows them;
  - `App.tsx` 1,409; `viewport/block-editor.ts` 1,325.
- **Load times:**
  - D264: arrays ~31 s on the bench;
  - D270 (1): plain white blocks for 10–20 s after **Make it paintable**;
  - D263: a cold 200-decal atlas takes 20 s against a 2 s target;
  - D251: the WebGL 2 leave takes 0.6–1.2 s against a 150 ms target.

## 3. Items

Order: mockup → Navigate → panels → modes → load times → small lows →
manual → acceptance.

**E2E budget (D181, D253):**
- No new e2e file, and the phase adds no net e2e time.
- The Navigate, selection and column-fit checks are steps in the existing
  editor files (`block-editor`, `terrain-paint`, the decal and vertex-paint
  drives, `editor-window` for Esc).
- Key handling, dock layout maths and the layout memory get vitest checks.

| Item | What |
|---|---|
| 37.0 | Release checks; §2 re-read. |
| 37.1 | **Mockup** (added to phase 34's `~/.cache/thirdlight-phase34/mockup`, hosted on the review page):<br>• Navigate (no tool), hover and selection highlight;<br>• docked panels: collapsed and open, dragged to another dock;<br>• each editor's column and panel split: Rooms & buildings with a building selected, Block Build, terrain Paint and Stack, vertex paint, decal Select, and the kit editor.<br>**Owner look before 37.3.** |
| 37.2 | **Navigate and selection in every editor.**<br>• The no-tool state: a left drag orbits, a click selects, and the cursor shows hover.<br>• Esc order: an active stroke or drawing first, then the selection inside the mode, then the tool, then leaving.<br>• Clicking the active tile drops it.<br>• Selectable things per editor:<br>&nbsp;&nbsp;– rooms, buildings and paths;<br>&nbsp;&nbsp;– block cells (the box) and block types (shown in the detail panel);<br>&nbsp;&nbsp;– decals;<br>&nbsp;&nbsp;– terrain stamps and tiles;<br>&nbsp;&nbsp;– the painted object in vertex paint.<br>• A click without a drag on a room or building with a drawing tool selects it (§1).<br>• `setBlockToolsActive` is removed or used. |
| 37.3 | **Docked panels.** A shell component:<br>• docks on the viewport's four edges and four corners, with panels stacked inside a dock;<br>• collapse to the title bar; drag a title bar to another dock;<br>• keyboard: focus and collapse;<br>• layout remembered per editor (editor preferences, not project state);<br>• a reset to the default layout.<br>Panels never overlap, and the view's input area excludes them. Clicks on a panel never reach a tool. |
| 37.4 | **The block editor on panels** (the most-used editor first):<br>• **Rooms & buildings:** Rooms list and the selected room's properties (`RoomInspector`) in panels, and New rooms and Kit pieces in the column.<br>• **Build:** Selection, Stamps and Layer.<br>• **Paint:** Brush, Noise mask and Layer.<br>• **Regions:** Theme, Metadata and Layer size.<br>• The block type editor (the detail column) becomes a panel.<br>• The column fits at 1920×1080. |
| 37.5 | **The other editors on panels:**<br>• **Terrain:** Brush, Noise mask, the picked stamp, Settings.<br>• **Vertex paint:** Brush, Noise mask, Channels.<br>• **Decals:** Placement, Scatter, Selection, with the atlas drawer as a bottom-dock panel.<br>• **The kit editor:** `KitInspector`'s settings move into the kit document's own panels; the global Inspector keeps only a link to them.<br>• Every column fits at 1920×1080. |
| 37.6 | **Load times.**<br>• **No white blocks (D270 1):** until a layer's arrays arrive, the layer draws its base colour, the average of its albedo, which the backend sends ahead of the encode.<br>• **D264:** the remaining 2 × 2048² ETC1S colour job is split or encoded at a preview size first, with the final arrays swapped in.<br>• **D263:** a cold atlas shows quick preview pages within the 2 s target and swaps the final pages in, in the background.<br>• **D251:** the static shadow map is redrawn after the first frame home, or the drawing-buffer size is kept; measured with `level --edit-mode`. |
| 37.7 | **Small lows (D270 2–4):**<br>• a trim sheet material's Material tab shows its rows and the checker;<br>• the decal palette tells same-named cells apart (by sheet);<br>• the Rooms preset pickers group presets by source: kit or starter.<br>**Added by the lead:**<br>• framing a selection (Home in any editor, F on an object) puts the camera outside its bounds at a sensible angle, looking at it (a selected building, a decal, a terrain stamp);<br>• D274: a layered surface with four 2048² tiling layers can be assembled (an over-limit colour array encoded UASTC layer by layer and joined), and a refusal that remains is in Problems. |
| 37.8 | **The manual:**<br>• `guides/level-editors.md` gets Navigate, the Esc order and panels;<br>• the block editor, vertex paint and decal guides are updated;<br>• the reference keys are regenerated.<br>**Added by the lead** (found in 37.7):<br>• framing respects the panels: a frame fits and centres in the view minus the open docked panels (measured, collapsed ones not counted);<br>• opening an editor gives a usable view: a view inside the object, below it, nearly level or looking away is framed on entry; one that shows it is kept. |
| 37.9 | **Acceptance.** The owner's flow in a real browser, on this host, both renderers, 1920×1080:<br>• enter each editor, orbit with no tool, select a building and edit it from its panel;<br>• drag a panel to another dock and collapse it; leave and come back (the layout is kept);<br>• Make it paintable (base colour, never white);<br>• a cold decal atlas.<br>Screenshots go to `~/.cache/thirdlight-phase37/acceptance`. Look: owner look pending. |
| 37.10 | **Review fixes.** |

**Done when:**
- Every editor has a no-tool state where a drag orbits and a click selects.
- Esc drops the tool, and a second Esc leaves.
- No editor's settings column needs a scroll at 1920×1080 in its default
  state; the rest is in docked, collapsible panels.
- No block draws white while its textures encode.
- A cold decal atlas shows within 2 s.
- `tools/gate.sh full --both-renderers` is green.

## 4. Soft performance targets

| Measure | Target |
|---|---|
| Base colour on blocks after a layer change | next frame (no white) |
| Cold decal atlas, 200 images, preview pages | ≤ 2 s |
| Leaving an editor on WebGL 2, landscape class | ≤ 150 ms to first frame |
| Docking or collapsing a panel | no re-render of the view; ≤ 1 frame |

## 5. Progress

| Item | Status |
|---|---|
| 37.0 | Done 2026-10-16: three.js 0.186.1 is still the latest on npm (no update); Rapier 0.21.0 is out, the pinned 0.20.0 stays (nothing here needs it). §2 recon is at `8cde51d2`, current. |
| 37.1 | Mockup done 2026-10-16 (`~/.cache/thirdlight-phase37/mockup`, 12 screens at 1920×1080 + SPEC.md, on the review page); the owner approved it 2026-10-16. |
| 37.2 | Done 2026-10-16: one Navigate state in the shell (`editmode/edit-tool.tsx`) for all four editors — Navigate tile, click-select with hover (rooms/buildings/paths outlined, blocks, decals, stamps, tiles), Space, the SPEC's Esc order with Done's badge dimming, a click on a room with a drawing tool selects it; vitest for the keys, Esc order and the room pick. E2E (2 workers, last full gate → this fast gate): block-editor 7.4 → 8.4 s, editor-window 11.3 → 10.8, terrain-paint 11.0 → 10.9, terrain-brushes 5.3 → 4.7, layered-material 52.1 → 50.2, instance-brush 31.7 → 31.2, level-acceptance 28.2 → 25.5, terrain-cdlod 3.4 → 3.2 min (net −17 s); village perf in its limits. |
| 37.3 | Done 2026-10-16: one docked-panel component in the shell (`editmode/docks.tsx`, maths and memory in `session/dock-layout.ts`, CSS in `styles/docks.css`): 8 docks, stacking, title click / Enter collapse, title drag with drop targets (Esc cancels), Panels switch + Reset layout chip, layout per editor in browser storage; Rooms & buildings moved onto it (Rooms list top right collapsed, the picked room's properties right edge). Vitest 7 checks; e2e steps in the rooms helpers: layered-material 50.2 → 49.7 s (block-editor untouched; one Make-it-paintable undo poll failed once and passed on rerun); village perf in its limits. |
| 37.4 | Done 2026-10-16: the block editor on panels per the SPEC (Build: Selection, Block type, Stamps, Layer; Shape/Paint: Brush, Noise mask, Layer; Regions: Theme, Metadata, Layer size; Rules: Scatter brush, Layer; Rooms: Layer); the detail column removed from the shell; every block mode's column fits at 1920×1080 (an e2e step measures all six). E2E (2 workers, previous → this fast gate): block-editor 8.4 → 8.4 s, block-world-uv 8.7 → 9.5, layered-material 49.7 → 50.2, terrain-brushes 4.7 → 4.5, terrain-paint 10.9 → 10.2, block-layers → 15.6 (net +0.4 s, host noise); the Make-it-paintable undo passed in all 3 runs; village perf in its limits. Screens on WebGPU and WebGL 2 looked at against mockup 02/04/04b.
| 37.5 | Done 2026-10-16: terrain (every mode), vertex paint, decals (the atlas a collapsed bottom-edge panel; the shell's drawer slot removed) and the kit editor (its own docks: the slot's panel and Preview, which holds the window's one preview pane; the Inspector keeps a link) on panels; one shared `brushPanels` in `editmode/`; every column fits at 1920×1080 (e2e steps in terrain-cdlod, instance-brush, the decal drive). 37.4's Rooms sighting is no regression (the building draws, selected or not, both renderers; F had framed the view inside its walls). E2E (2 workers, previous → this fast gate): terrain-cdlod 3.2 → 3.2 min, editor-window 10.8 → 10.7 s, layered-material 50.2 → 50.7, instance-brush 31.2 → 31.8, level-acceptance 25.5 → 27.1 (unchanged file), block-editor 8.4 → 8.2, block-world-uv 9.5 → 8.7, terrain-paint 10.2 → 10.4, terrain-brushes 4.5 → 4.9, project-items 9.0 → 9.0 (net +2.2 s, host noise); village perf in its limits. Screens of all four editors on WebGPU and WebGL 2 looked at against mockups 05a–d and 06. |
| 37.6 | Done 2026-10-16: **no white layers** — a slot array being made draws its layers' known mean colours at once (mid grey unknown), then the means the backend reads in the height check's decode, then a 256 px preview encoded ahead of the rest, then the array (layered wall, arrays held: grey → means, never white, both renderers); **D264** bench (3 threads) first textured view 27.2 s → every preview 1.4 s (real 2048² albedos 8.1 → 0.38 s), all arrays 30.6 → 32.2 s; in the editor a real 2048² trim sheet: means 0.55 s, preview 1.06 s, array 6.9 s (white until then before); **D263** cold 200-image atlas: preview pages 1.36 s (3 threads; 2.7 s on one), the pages 18.9 s, never stored, an export meanwhile ships the pages; **D251** leave 827/469/1,035 ms (uncapped: a GPU queue the resize waited on) → 48/34/29 ms timed with vsync, setSize 786 → 8 ms; **Make-it-paintable undo** was a real race (an undo overtook the request joining the step), fixed. D274 new. E2E (2 workers, previous → this fast gate): layered-material 50.7 → 51.2 s, block-editor 8.2 → 8.4 s, terrain-cdlod 3.2 → 3.1 min, material-graph 9.7 s (unchanged file); net about +0.4 s; village perf in its limits. |
| 37.7 | Done 2026-10-17: a trim sheet's Material tab is the Inspector's row table and padding check; decal palette grouped by sheet (headings); Rooms preset pickers in optgroups by source; Home frames the selection (building, decal, stamp) from outside at a 20–65° pitch, F frames what it would land inside (`viewport/frame-view.ts`, vitest); **D274** fixed: four 2048² albedos refused → 18.1 s / 15.2 MiB UASTC on 3 threads (33.8 s on 1), 442 MiB a layer job, refusals to Problems. Looked at 1920×1080 on WebGPU and WebGL 2 (framing both). E2E (previous → this fast gate): layered-material 51.2 → 51.4 s, block-editor 8.4 → 8.4, terrain-cdlod 3.1 → 3.2 min, material-graph 9.7 → 9.9 s, editor-window unchanged file; village perf in its limits. |
| 37.8 | Done 2026-10-17: **frames beside the panels** (fit and centred in the view minus the open panels, measured) and **entering frames the object** unless the view shows it from outside, above and aimed (`frame-view.ts`, vitest); 3D starter's block editor checked on WebGPU and WebGL 2; Home frames selected block cells. Manual: `level-editors.md` (Navigate, Esc order, panels, framing, texture stand-ins, atlas preview pages), each editor guide's column/panel table, old layout wording gone; Help → Keyboard shortcuts has Space, the Esc order and Home (the reference has no generated key list). E2E (previous → this fast gate): block-editor 8.4 → 9.3 s, projects 11.5 → 14.8, layered-material 51.4 → 51.6, terrain-paint 10.4 → 10.2, editor-window unchanged (net +4.5 s); one decal-atlas preview poll failed once in layered-material and passed on rerun; village perf in its limits. |
| 37.9 | Done 2026-10-17: the owner's flow through the UI on a new 3D starter, Iris Xe, 1920×1080, WebGPU and WebGL 2 — **130 JPEGs** (`~/.cache/thirdlight-phase37/acceptance/`, 65 a renderer): every block mode, terrain, vertex paint on a building, decals and the kit editor entered (each shows its object); Navigate orbit, hover, click-select a building, storeys + facade preset from its panel, Home beside the panel; Rect click selects, drag draws a room inside; Esc deselect → drop → leave, Done's badge dim/lit, Space; panel collapse, drag (mid-drag targets), Esc mid-drag, Panels switch, layout kept, Reset; every column fits (865/865 px, all modes); Make it paintable grey → means → preview → array, never white (no white pixel in a 2 s burst, both renderers); cold atlas of 200 images: preview pages 2.5–2.9 s (over 2 s: D275), pages 45–49 s; four 2048² layers built and painted (D274 verified); trim Material tab, palette groups, preset optgroups, Help rows; Play and export. Fixed: vertex paint entry framed the generated object's origin (it ignored chunks drawn outside the node), the atlas status showed the last request's "Made in 41 ms" instead of the wait, the Rooms hints listed Finish/Undo corner/Take off with no tool armed, the trim sheet's checkbox stood apart from its label. D275–D278 logged. The decal-atlas preview poll did not fail again. E2E (fast gate, host load ~13 from another session's tests): layered-material 51.6 s → 1.2 min, level-acceptance 27.1 → 35.2 s, block-editor 9.3 → 11.7 s (unchanged file: load); village perf missed WebGL 2 p50 twice (6.1, 5.5 ms vs 4.84): interleaved A/B against 8cde51d2 equal (5.3/5.4/5.3 vs 5.6/5.5/7.5 ms, both missing) — host state (D199). Owner look pending. |

## 6. Decision log

- 2026-10-16: Planned from the owner's look at phases 34–36. The owner
  chose: Esc drops the tool and a second Esc leaves; docked, collapsible
  panels; and the load-time defects in this phase. Phase 33 follows.

- 2026-10-16 (37.1): The owner looked at the mockup ("I like it") and asked
  for all of phase 37 to be built, then they will use it and give feedback.
  The mockup's `SPEC.md` (`~/.cache/thirdlight-phase37/mockup/SPEC.md`) is
  the layout to build. Its open choices are taken as shown:
  - a lit **Navigate** tile in the tool grid (screen 01), not the no-tile
    variant;
  - **Space** brings back the last tool;
  - the default docks: settings on the right edge, lists collapsed at the
    top right, Layer at the bottom left;
  - the brush is a panel in every editor;
  - the Rooms list is a collapsed panel;
  - decal Select's separate Click tile is dropped (Navigate selects), and
    the atlas is a bottom-dock panel, collapsed by default;
  - the kit editor has a picked-slot panel and a preview panel, and the
    global Inspector keeps only a link;
  - Done's Esc badge dims while Esc would not leave.

- 2026-10-16 (37.2): Navigate is one state in the edit-mode shell
  (`ui/editmode/edit-tool.tsx`, the edit mode's `armed` flag): every editor
  opens with none, the tool grid's first tile is Navigate, and a column
  arms its Scene-view tool in Navigate or with its tile. Defaults chosen,
  owner to confirm:
  - whether a tool is armed is kept across the rail's modes (switching
    mode keeps Navigate, or arms that mode's remembered tile); a mode with
    no tool grid, or a disabled one (a locked layer, a material that reads
    no paint), is in Navigate and its column keeps the status line;
  - decal Place and Scatter get a one-tile tool grid (Navigate + Place /
    Scatter, key B; Box is B too) so Esc can drop them and Navigate selects
    decals in every decal mode — the SPEC's table showed no grid there;
  - terrain Stack's Select tile goes like decal Select's Click tile: in
    Navigate a click picks a stamp and the picked one's square, corner and
    knob drag it (as grips do);
  - a block click in Navigate selects the block's cell (the box) and opens
    its type in the block type editor, in every block mode but Rooms &
    buildings, where it selects the room, building or path;
  - vertex paint: the painted object is the edited one, so Navigate only
    orbits; Channels (no tool grid) no longer paints;
  - with a drawing tool, a press on an outline that becomes a drag draws
    from the press point (a polygon's first corner too);
  - a mouse click on a tile, rail mode, button or switch leaves no keyboard
    focus on it, so Space and the letters reach the editor next; a control
    reached by Tab keeps its Space;
  - Enter and Backspace now reach the Rooms tool (they were never routed);
    `setBlockToolsActive` (no callers) is removed.

- 2026-10-16 (37.3): Docked panels. Defaults chosen, owner to confirm:
  - a mode's column declares its panels (`EditPanels`: id, title, default
    dock, collapsed, badge, shown-when, render), not the mode registry: the
    content needs the column's state, so it renders in the column and is
    put into the panel's body (it keeps its state when the panel moves);
    a collapsed panel keeps its content mounted;
  - the layout stores only what the user changed (dock, open, order per
    panel id) under `thirdlight.docks.<editor>` in the browser; an unknown
    or stale entry falls back to the mode's default; the picked room's
    panel has the id `selection`, so the block editor's other selection
    panels (37.4) share its place;
  - the view's chip has a **Panels** switch (hides every panel, remembered)
    and **Reset layout** (disabled while nothing differs from the
    defaults); the drag ghost shows the title bar, not a copy of the
    content;
  - panel stylesheets go in `packages/editor/src/styles/*.css`, inlined
    after `editor.css` by the build;
  - Rooms & buildings' Layer section stays in the column until 37.4.

- 2026-10-16 (37.4): The block editor on panels, split as the SPEC's
  table says (Build: Selection, Block type, Stamps, Layer; Shape: Brush,
  Layer; Paint: Brush, Noise mask, Layer; Regions: Theme, Metadata, Layer
  size; Rooms & buildings: Layer added). The detail column is gone: only
  the block editor used it, so the shell's support for it went too.
  Defaults chosen, owner to confirm:
  - **Rules:** the column keeps the Tool grid (Navigate + Scatter) and
    the two rule lists; the scatter brush's rule picker and settings are
    the **Scatter brush** panel (right edge, open), sharing the Brush
    panel's id so it keeps one place across Shape, Paint and Rules;
  - the Block type panel is open in Build; in Shape, Paint, Regions and
    Rules it shows only while a block clicked in Navigate is selected (the
    37.2 rule that a click opens the block's type);
  - panels whose tool needs them open with it: Stamps with the Stamp tool,
    Metadata with the Metadata tool, Noise mask while the mask is on, Layer
    while the layer is locked (until the user opens or closes them, which
    is remembered);
  - Build's tool grid is five tiles wide (as the mockup), the column's
    pickers sit beside their labels, and in Navigate the column shows the
    "No tool" note instead of the remembered tile's hint: that is what
    makes Build and Rooms & buildings fit at 1920 × 1080 (Rooms was
    210 px over);
  - a short panel's kept height now counts its frame's borders (it
    scrolled by 2 px under a fade that hid its last row).

- 2026-10-16 (37.5): The terrain, vertex paint and decal editors and the
  kit editor on panels, split as the SPEC's tables say. The brush and noise
  mask panels are one function for every editor (`editmode/brush-panels.tsx`,
  moved out of the block editor). Defaults chosen, owner to confirm:
  - **Terrain:** Sculpt's column is its tool grid alone (four wide), Brush
    and Noise mask are panels, and the Noise tool's bump size and seed a
    Noise panel shown with that tool; Paint's mask panel starts open (the
    SPEC), the others' collapsed unless the mask is on. **Material rules**
    keeps the cards with Bake and Revert in the column (the cards are the
    block editor's Rules cards too, which 37.4 kept in the column); the
    preview's switches are a Preview panel (top right, open) — the SPEC's
    "open rule's settings" panel is not made. **Scatter**: tool grid and
    rule cards in the column, the rule it places and the brush in the
    Scatter brush panel (the brush's place). **Stack**: Picked stamp
    (right edge, in the selection's colour, while one is picked with no
    tool), New stamp and Erode (each with its brush size) shown with their
    tool. **Tiles**: Import heightmap and From a block layer are collapsed
    panels. **Settings** fits and has none.
  - **Vertex paint:** the channel chips over the view are gone: Paint has
    the Channel view panel (top left), Channels its list in the column with
    What the channels mean (open) and Stored paint (collapsed) as panels;
    Material none (it paints nothing, so no channel view).
  - **Decals:** Place: Placement (open) and Stamps (collapsed, its own
    panel); Scatter: Brush, Scatter and Placement (collapsed, the same
    panel id, so one place); Select: Selection while decals are selected.
    The atlas is a bottom-edge panel, collapsed, stretching between the side
    columns (a new `wide` flag on a panel); its title bar says the pages and
    the unused share; its switch and Rebuild sit in a row at the top of its
    body (a click on the title bar only collapses). Its open state is the
    panel's (the old remembered drawer state is dropped); the pages are read
    while the decal editor is open, as with the drawer open by default. The
    shell's `drawer` slot is removed.
  - **Kit editor:** the kit document holds its own dock host over its centre
    (`useDockHost('kit')`; `--dock-top` puts the docks under the centre's
    head row); the picked slot's panel (named after the slot: Piece, Piece
    checks, Placement, Placed by; or the block type's summary) on the right
    edge, Preview at the top right. The editor window's one preview pane is
    moved into the Preview panel (`PreviewPlace`: the same element, so the
    same renderer), and goes back above the Inspector for other editors.
    The global Inspector keeps a note and **Show the Door slot's panels**,
    which turns the panels on, opens the slot's panel and focuses it
    (`DockHost.reveal`). The trim checker's grid leaves the right 340 px
    for the panels: the sheet, its rows beside it, the checks under the rows.
  - **37.4's Rooms check:** not a regression. In the same kind of scene (a
    layer, a two-storey building on a Basic Kit preset) the building draws in
    Rooms & buildings on both renderers, selected or not (Home frames the
    layer). The view framed with F on the rooms object lands inside the
    building's walls, where the floor and the selection outline are what
    shows — which matches what 37.4 saw.

- 2026-10-16 (37.6): Load times. Defaults chosen, owner to confirm:
  - a layer's stand-ins come in this order — its mean colour (mid grey while
    not known), the means the backend reads, a 256 px preview of the array
    (`SLOT_PREVIEW_SIDE`), the array — and replace the array a changed slot
    list replaces (drawing the old array meanwhile now comes second);
    only colour arrays get mean colours (a normal or data array's absent
    value is neutral already); a stand-in is never stored, and a texture that
    cannot be made keeps its last stand-in (D274);
  - the means come from the height check's decode (one decode a texture,
    kept in the import cache as an 8-byte marker); decodes and previews go
    ahead of the encodes queued on the encoder pool;
  - a decal atlas preview is every page at a quarter of its side
    (`DECAL_PREVIEW_DIVISOR`), composed small from the sources (as-stored and
    cached pages too), fastest UASTC, held in memory (the last per project,
    readable after the pages replace it); the Rebuild button stays disabled
    until the pages themselves are in, the status says "Preview in … ms ·
    composing the pages…"; the pages' arrays are decoded before the view
    swaps to them;
  - D251 was the uncapped harness, not the editor: the perf tool times enter
    and leave with vsync (orbit frames stay uncapped); no engine change.
    Bounding the GPU queue of uncapped rendering (frame pacing) is left;
  - an undo or redo waits for grouped actions still being joined into one
    step (`SessionClient.grouped`);
  - the Material editor's preview pane takes the same stand-ins.

- 2026-10-17 (37.7): The lead added two parts to the item: framing a
  selection from outside it (37.5's finding: F or Home on the rooms object or
  a building landed inside its walls), and D274 (four 2048² tiling layers
  could not be assembled). Defaults chosen, owner to confirm:
  - **framing** is one function for every frame (`viewport/frame-view.ts`):
    the camera outside the box's bounding sphere, fitted to the narrower view
    angle, the view's heading kept and its pitch held between 20° and 65°
    down. Home frames the mode's selection when there is one (each editor's
    `useEditSelection` gives its box: a room or building to its top storey and
    roof, decals by their projector boxes, a stamp's square to its height),
    else the whole object as before; in the decal editor (a scene's mode)
    Home now frames the selected decals. Scene F keeps its orbit-around
    behaviour unless that would put the camera inside what the object draws,
    then it frames it. The frame centres on the whole view: the right column
    of panels can cover part of a wide building (not changed);
  - **D274:** an over-limit colour array is encoded UASTC a layer at a time and
    joined (constant layers too, at the textures' size); ETC1S stays wherever
    the array fits one job, and the 12 Mpix source limit stays. Four 2048²
    albedos: 15.2 MiB, 18.1 s on 3 encoder threads (UASTC at the assembled
    effort is slower per layer than the ETC1S job, not faster as D274
    guessed); the preview covers the wait. A refusal (layers of two sizes) is
    one Problems line (`texture_array_refused`);
  - **the trim sheet's tab** is the Inspector's `TrimSheetTable` (rows,
    density, Equal rows, Import layout.json, Check padding); a double-click on
    a trim sheet in the project window now opens it (other shader materials
    still show in the Inspector);
  - **the decal palette** groups by source with a heading row (own images
    first, then each sheet in project order with the materials drawn from
    its cells and its free cells) — read clearer than a sub-label at 75 px
    tiles; headings show only when pictures come from more than one place;
  - **the preset pickers** (new room/path/facade, a room's inside and outside,
    the swap) list optgroups: the rooms' kit ("Basic Kit · the rooms' kit"),
    other kits, "This project", "Engine starters".


- 2026-10-17 (37.8): The lead added two view fixes to the item (found in
  37.7). Defaults chosen, owner to confirm:
  - **framing beside the panels:** every frame (Home, F, entering) fits and
    centres the box in the view minus the open panels, measured from the
    dock layer when it frames (`panelInsets`: a side's widest open panel;
    corners count with their side; collapsed panels and a hidden Panels
    switch count nothing). The orbit target moves sideways with the frame
    (no view offset), so picking and orbiting stay as they were; at least a
    quarter of the view's width and height is always framed into. The
    terrain's entry view (a work area) is not shifted;
  - **the view on entry** is kept only when it shows the object sensibly
    (`viewShowsBox`): not from inside its box, not from below it, looking
    down at least 10° (`ENTRY_LEVEL_DEG`), and aimed at it. A block layer's
    box includes the air above its cells, so a close view a few metres over
    the ground, inside that box (the 3D starter's first view), is framed;
    the terrain keeps its work-area view only when aimed and not nearly
    level;
  - **Home on selected block cells** frames them (the block editor gave no
    box before, so Home framed the whole layer).
  - **the manual:** the reference has no generated key list (it is built
    from the code's ops, components and limits), so the keys live in
    `level-editors.md`'s table and in Help → Keyboard shortcuts, whose
    stale block rows (Q to turn, Alt or right drag always) were replaced
    with Space, the Esc order, Home and T.

- 2026-10-17 (37.9): Acceptance. Defaults chosen, owner to confirm:
  - the 200-image decal corpus is fixture content seeded through the content
    routes (200 images through the palette by hand is not a flow anyone
    runs); the Rebuild, the panel and every other step go through the page;
  - Make it paintable's stages were shot by holding the slot requests at the
    network and letting them go one stage at a time (the real stages take
    0.3–7 s, too quick to shoot reliably); real timings are in the row;
  - the atlas status after a Rebuild through preview pages reads "Preview in
    … ms · the pages in … s" (the time the user waited), not the last
    request's "Made in 41 ms (100 reused)";
  - framing an object now counts what it generates outside its node (a
    building's or a spline's chunks): vertex paint on a building framed the
    rooms object's origin at the layer's corner before.

