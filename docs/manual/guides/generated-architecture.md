# Generate rooms and buildings

**Goal:** rooms and a building with a roof, drawn on a block layer and
styled by presets, then restyled without redrawing them. Every field is in
[Generated architecture](../features/architecture.md).

Generated architecture stores only parameters — outlines, presets, openings
— and makes the meshes when the scene loads, on worker threads. Its walls
block the layer's grid walks, its rooms are the layer's regions, and its
rooms drive culling and lighting (a lamp stops at its room's walls).

## The parts

- **Outline:** a room (a closed path, its inside to the right of travel) or
  a run (an open path: a rail, a fence, a pipe).
- **Building:** a room outline with storeys, a facade and a roof; its
  interior is made in place or in a scene of its own.
- **Style:** a graph of the generator's operators (walls, bands, mouldings,
  sweeps, repeats, fills) with exposed sliders.
- **Preset:** a style plus slider values and a trim sheet. A preset may
  derive from another; the engine ships neutral starters (`starter-room`,
  `starter-room-tall`, `starter-hall`, `starter-rail`, `starter-fence`,
  `starter-pipe`).
- **Room program** and **furnishing set:** graphs your game makes to split a
  building into rooms and place props and lights by room type.

## In the editor

Rooms are drawn in the [block editor](block-layers.md)'s **Rooms &
buildings** mode (Shift+5): double-click a block layer (or **Edit blocks**
in its Inspector), then pick the mode on the rail. Selecting the rooms
object itself shows **Edit in block editor**, which opens the same place.

The column holds the **Tool** grid (with the slice), **New rooms** and
**Kit pieces**; the **Rooms** list and the picked room, building or path
are panels over the view, and so is the layer's lock (**Layer**, bottom
left). The mode opens with no tool (**Navigate**): a drag orbits, a click
picks a room, building or path, and **Home** frames it from outside.

1. **Tool** (letters on the tiles): **Rect** (R) drags a room from corner to
   corner on the slice's floor (PageUp / PageDown move the slice);
   **Polygon** (P) clicks corners (**Arc** bends the next side); **Path** (L)
   draws a run; **Building** (B) clicks a footprint and closes it on the
   first corner. Enter finishes, Backspace takes the last corner back. The
   first room makes the rooms object.
2. **New rooms** sets the presets new rooms, paths and buildings wear (a
   building's facade too).
3. **Kit pieces**: the rooms take their pieces from a [kit](../features/blocks.md)
   — the rooms object's, else the layer's (pick one in the section's corner).
   Pick a **door piece** and a **window piece**: **Door** (D) and **Window**
   (W) then put that piece in the clicked wall, the hole sized to the piece
   (from its slot's sill, as wide as its whole cells; the line under the
   pickers shows it). With none picked they make the style's frame and pane.
   **Arch** (A) cuts a two-cell opening.
4. **Wall piece** (O) and **Corner piece** (K): pick a piece from the kit's
   *wall override* or *corner* slot, then click a wall segment or corner
   (the one under the pointer is lit); the piece replaces that part of the
   generated wall. Ctrl+click takes it off.
5. **Move walls** (M) drags a straight wall by whole cells (a wall two rooms
   share moves with both); a click picks the room.
6. A click on a room, path or building picks it (with no tool, or a click
   without a drag with a drawing tool); the **Rooms** panel over the view
   (top right, collapsed to its title bar until you click it) lists them all
   too. The picked one is edited in its own panel on the view's right edge:
   its inside and outside (or facade) presets, **Preset sliders**
   (a starter's are read-only: **Derive a preset** makes a project preset
   from it and moves the rooms onto it; a slider tied to a trim row offers
   **Snap to row**), storeys, its openings (where each stands, its size, a
   pane, the kit piece in it, a live door block of the layer), its wall and
   corner pieces (stretched to the segment or not), a path's **repeated
   piece** from the kit's *railing* slot, a building's roof, interior (in
   place or **New interior scene**) and floor plan, stairs and floor holes.
7. Your own styles, presets, room programs and furnishing sets: the project
   window's **create** menu → **Graph**. A preset opened there shows its
   sliders in the Inspector.

8. **Presets in use** (in the Rooms panel) swaps one preset for another on every room, path and
   building at once (**rooms wearing** → **wear instead** → **Swap**): the
   outlines, openings and pieces stay, the look changes — the trim sheet a
   preset names comes with it. To swap the sheet under a whole kit instead,
   use the [kit editor](kit-editor.md#swap-the-trim-sheet).

A rooms object drawn on no layer (made over the API) has no outlines to
draw here; its Inspector lists its rooms' presets with the same swap and
the presets' sliders, and new rooms are drawn on a layer.

Every change is one undo step; so is Derive (the preset and the rooms that
take it).

## Through the API

1. Rooms and a building on a block layer, one
   [`createEntity`](../reference/ops-detail.md#op-createEntity) with an
   [`architecture`](../reference/components-rendering-2.md#component-architecture)
   component (outlines are [`ArchitectureOutline`](../reference/types-a-d.md#type-architecture-outline)s,
   buildings [`ArchitectureBuilding`](../reference/types-a-d.md#type-architecture-building)s;
   points in metres from the object, which stands at the layer's place):
   ```json
   {"sceneId": "scene-main", "kind": "group", "name": "Rooms", "components": {"architecture": {
     "layer": "<block layer id>", "elements": [],
     "outlines": [{"id": "hall", "preset": "starter-room",
       "path": {"points": [[11, 1, 1], [15, 1, 1], [15, 1, 7], [11, 1, 7]], "closed": true},
       "openings": [{"id": "door", "at": 2, "width": 1, "bottom": 0, "top": 2.1}]}],
     "buildings": [{"id": "house", "preset": "starter-room", "storeys": 2, "roof": {"shape": "hip"},
       "path": {"points": [[18, 1, 2], [28, 1, 2], [28, 1, 10], [18, 1, 10]], "closed": true}}]}}}
   ```
   An opening's `at` is metres along the path to its middle.
2. A preset of your own: [`setGraph`](../reference/ops-detail.md#op-setGraph)
   with a graph of kind `architecture-preset`
   ([nodes](../reference/graph-architecture-preset.md#graph-architecture-preset)):
   ```json
   {"graph": {"graphId": "low-room", "kind": "architecture-preset", "name": "Low room", "graph": {"nodes": [
     {"id": "p", "type": "preset", "position": [0, 0], "data": {"base": "starter-room", "sheet": "<trim material>"}},
     {"id": "v1", "type": "value", "position": [0, 120], "data": {"parameter": "ceiling_height", "value": 2.6}}],
     "edges": []}}}
   ```
   The starter room's sliders are `ceiling_height`, `wall_thickness`,
   `dado_height`, `baseboard_height` and `moulding_depth`.
3. Restyle: [`setComponent`](../reference/ops-detail.md#op-setComponent)
   `architecture {outlines}` with the outlines naming the new preset.
   Kit pieces: an opening's `model`, an outline's `repeatModel` (a run's
   railing) and `overrides` `[{element, segment | corner, model, stretch?,
   centre?}]` on the walls the outlines make (their element ids start with
   the outline's id; `centre` for a piece whose origin is its bottom
   centre, as kit pieces are).
4. While the game runs, a script swaps a preset level-wide with
   `ctx.grid.setArchitecturePreset(from, to)` and reads door links with
   `ctx.grid.doorLink(point)` (see [`ctx.grid`](../reference/script-api.md#ctx-grid)).

## Which to use

Draw rooms in the editor: Rooms & buildings snaps to cells, shares walls,
puts openings and kit pieces on walls for you, and you see the result at
once. Use the API
for buildings that come from data (a generated town, a floor plan from
another tool) and for presets you keep under version control. Restyling is
the same either way: change presets, never the outlines.

## Pitfalls

- **`setComponent architecture` replaces each list you send.** `outlines`
  replaces every outline (the buildings stay unless you send `buildings`).
- **The trim sheet needs the rows the style asks for.** A sheet without a
  `baseboard`, `bevel` or `crown` row is listed in Play's architecture
  problems (`renderer.architecture.problems`): give the sheet every row the
  presets you use name. See [trim sheets](trim-sheets.md).
- **Roofs need a footprint the generator can roof:** a rectangle, any
  convex polygon, or one with only right angles. Others are reported in the
  object's problems and get no roof.
- **Room programs need sides along x and z.**
- **Furnished lights share the scene's budget** of 16 point and spot
  lights.
- **Generated at load:** an export ships parameters, and the player's
  browser makes the meshes. To ship meshes instead, turn on
  **Project Settings → Gameplay → Engine → Generated architecture**
  (`architecture_ship_meshes`): a larger download, nothing to generate.
