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
| 37.7 | **Small lows (D270 2–4):**<br>• a trim sheet material's Material tab shows its rows and the checker;<br>• the decal palette tells same-named cells apart (by sheet);<br>• the Rooms preset pickers group presets by source: kit or starter. |
| 37.8 | **The manual:**<br>• `guides/level-editors.md` gets Navigate, the Esc order and panels;<br>• the block editor, vertex paint and decal guides are updated;<br>• the reference keys are regenerated. |
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

## 6. Decision log

- 2026-10-16: Planned from the owner's look at phases 34–36. The owner
  chose: Esc drops the tool and a second Esc leaves; docked, collapsible
  panels; and the load-time defects in this phase. Phase 33 follows.
