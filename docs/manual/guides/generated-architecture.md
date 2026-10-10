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

1. Build or select a [block layer](block-layers.md) with a floor. In its
   tools pick **Rooms**.
2. **Rectangle**: drag a room from corner to corner on the current slice;
   **Polygon** clicks corners (the **arc bulge** makes the next side an
   arc); **Path** draws a run. The first room makes the rooms object.
3. **Door**, **Window** and **Arch** put an opening on the nearest wall;
   **Walls** drags a straight wall (a wall two rooms share moves with both).
4. **Building** mode: click the footprint's corners and close it. The
   building inspector sets storeys, the facade preset, the roof shape and
   the interior (in place or **New interior scene**).
5. Select the rooms object: its Inspector lists the outlines with their
   presets and the sliders of the presets they use. **Restyle** swaps every
   outline of one preset for another. A starter's sliders are read-only:
   **Derive a preset** makes a project preset from it and moves the
   outlines onto it.
6. Your own styles, presets, room programs and furnishing sets: the project
   window's **create** menu → **Graph**.

## Through the API

1. Rooms and a building on a block layer, one
   [`createEntity`](../reference/ops-detail.md#op-createEntity) with an
   [`architecture`](../reference/components-rendering.md#component-architecture)
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
4. While the game runs, a script swaps a preset level-wide with
   `ctx.grid.setArchitecturePreset(from, to)` and reads door links with
   `ctx.grid.doorLink(point)` (see [`ctx.grid`](../reference/script-api.md#ctx-grid)).

## Which to use

Draw rooms in the editor: the Rooms tool snaps to cells, shares walls and
puts openings on walls for you, and you see the result at once. Use the API
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
