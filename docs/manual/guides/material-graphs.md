# Material graphs

**Goal:** a graph material with a tint and a glowing rim (a Fresnel term),
worn by two objects, one of them with its own tint, and a material instance
that changes the tint without copying the graph. Every node and setting:
[Material graphs](../features/material-graphs.md); every node's ports and
fields: [Material graph nodes](../reference/graph-material.md).

## In the editor

1. In the project window, **create ▾ → Graph material → Empty (PBR
   output)** (or start from a template: Standard, Foliage wind,
   Atlas surface, Unlit, Water, River, Height-blended layers). Name it
   `Glow`. It opens in the editor window as a **Material** tab; the preview
   pane above the Inspector shows it on a sphere.
2. **Exposed parameters** (left of the graph): **+ Parameter**, then its
   key, type, default and public/private: `tint` (color), `rim` (color)
   and `power` (float, default 2). Public ones can be set per object. (A
   float's `min` and `max` are set over the API; the panel has no fields
   for them.)
3. Add nodes (right-click, Space or **+ Node**; type to search, Enter
   adds): three **Parameter** nodes, a **Fresnel** and a **Multiply**. A new
   Parameter node reads the first parameter; set each one's key (`tint`,
   `rim`, `power`) in its Inspector. Wire
   `tint` → PBR output **base colour**; `power` → Fresnel **power**;
   `rim` and the Fresnel output → Multiply; Multiply → **emissive**. The
   preview updates with each wire.
4. Select an object (a box or a model). Its Inspector has a
   **Materials** section: pick the material under **all materials** (on
   another object, **+ Add component → Materials** first). The Inspector's **Materials** section lists
   the public parameters: set this object's `tint`; ↺ goes back to the
   material's.
5. Choose the material in the project window and press **+ new
   instance**: change only `tint` in the instance's Inspector, and give
   the instance to a third object.

## Through the API

1. The material with its graph ([`setMaterial`](../reference/ops-detail.md#op-setMaterial),
   [`MaterialDef`](../reference/types-c-m.md#type-material-def)):
   ```json
   {"material": {"materialId": "glow", "name": "Glow", "shader": "standard", "params": {}, "textures": {},
    "parameters": [
      {"key": "tint", "type": "color", "default": "#3060c0"},
      {"key": "rim", "type": "color", "default": "#ffb040"},
      {"key": "power", "type": "float", "default": 2, "min": 0.5, "max": 8}],
    "graph": {"nodes": [
      {"id": "tint", "type": "parameter", "position": [0, 0], "data": {"key": "tint"}},
      {"id": "rim", "type": "parameter", "position": [0, 120], "data": {"key": "rim"}},
      {"id": "power", "type": "parameter", "position": [0, 240], "data": {"key": "power"}},
      {"id": "fres", "type": "fresnel", "position": [220, 200]},
      {"id": "mul", "type": "multiply", "position": [440, 140]},
      {"id": "out", "type": "pbr", "position": [660, 40]}],
     "edges": [
      {"id": "e1", "from": {"node": "tint", "port": "value"}, "to": {"node": "out", "port": "baseColor"}},
      {"id": "e2", "from": {"node": "power", "port": "value"}, "to": {"node": "fres", "port": "power"}},
      {"id": "e3", "from": {"node": "rim", "port": "value"}, "to": {"node": "mul", "port": "a"}},
      {"id": "e4", "from": {"node": "fres", "port": "out"}, "to": {"node": "mul", "port": "b"}},
      {"id": "e5", "from": {"node": "mul", "port": "out"}, "to": {"node": "out", "port": "emissive"}}]}}}
   ```
2. Wear it ([`setComponent`](../reference/ops-detail.md#op-setComponent),
   [`materials`](../reference/components-rendering-1.md#component-materials)):
   `{"entityId": "<object>", "component": "materials", "value": {"*": "glow"}}`.
3. One object's own tint ([`materialParams`](../reference/components-rendering-1.md#component-materialParams)):
   `{"entityId": "<object>", "component": "materialParams", "value": {"glow": {"tint": "#20a040"}}}`.
4. An instance: `setMaterial` with
   `{"material": {"materialId": "glow-red", "name": "Glow red", "shader": "standard", "params": {}, "textures": {}, "instanceOf": "glow", "values": {"tint": "#c02020"}}}`.
5. Later graph edits ([`graphEdit`](../reference/ops-detail.md#op-graphEdit)):
   `{"owner": {"kind": "material", "id": "glow"}, "ops": [{"op": "addNodes", "nodes": [...]}, {"op": "connect", "edges": [...]}]}`,
   one undo step for the whole list.
6. Play and take a screenshot: both objects show the rim; the override's
   tint differs.

A script changes a public parameter per object while the game runs:
`ctx.materials.set(entityId, 'tint', '#ff4000')` ([`ctx.materials`](../reference/script-api.md#ctx-materials)).

## Which to use

Build and tune graphs in the editor: the preview pane shows each change on
the material at once, and colours are judged by eye. Use the API to create
materials in bulk from a template graph, or to make instances for a palette
of variants. Prefer an instance to a copied graph: every instance follows a
later change of its parent's graph.

## Reading vertex paint

**Goal:** a prop and some copies of it painted with a stain where a wall
meets the ground, without a new texture. The data and the command:
[Vertex paint](../features/vertex-paint.md).

1. Pick how the material reads the paint:
   - a standard material: switch on **Paint tint** in its Inspector
     (`paintTint: true`). Paint RGB is the tint, A how much of it;
   - a graph: a **Vertex colour** node with **Set** `paint`, wired where
     the paint should act — for a stain, `rgb` → a **Lerp** between the
     base colour and a dirt colour with `alpha` as its `t`;
   - layered surfaces: a **Height blend** node with its weights unwired
     reads the paint as its layers' weights (R, G, B, A one layer each);
   - generated walls on a trim sheet need nothing: paint A adds wetness
     (for dirt, wear them with a layered surface and paint its layers).
2. Paint the objects: one `paintVertices` stroke per channel over MCP,
   e.g. `{ "entityId": "rock-000001", "dabs": [[10, 0.2, 4]], "brush":
   { "radius": 0.8, "strength": 1, "channel": 3 } }` for A, then the same
   with `channel` 0 for R. An instance copy takes `copy` (its place in the
   set's buffer); a wall takes `path` and `side`.
3. Press **Play**: the painted copies are drawn in the same draw as the
   others (Play's `renderer.vertexPaint` diagnostics count them).

## Pitfalls

- **A material that does not read paint shows none.** Painting a prop
  that wears a plain standard material changes nothing until **Paint
  tint** is on (or a graph reads it).

- **A graph material ignores the model file's own material and textures.**
  Only what the graph contains is drawn; **Remove graph** brings the shader
  material back.
- **A model exported with `KHR_materials_specular` loses it under a graph.**
  The file's material is replaced, so its highlights go back to F0 0.04.
  Wire its specular factor into the PBR output's **specular intensity** (and
  its colour into **specular colour**), as constants or parameters. Wire them
  only where the difference shows: a wired port makes the material a
  physical one, a separate and slightly dearer shader program.
- **An input takes one wire.** Over the API a `connect` to an input that is
  already wired is refused (`field_value`, "takes one connection");
  `disconnect` the old edge first. The editor replaces it for you.
- **Rules:** at most 512 nodes, one surface output (PBR, Unlit or
  Custom-lit) and one Vertex offset; no cycles. A refused edit changes
  nothing.
- **Only public parameters** can be set per object or from a script.
- **A texture parameter an object overrides** gets its own compiled copy of
  the material; colour and number overrides share one.
- **Lighting nodes** (Main light, Shadow, Diffuse and Ambient light) work
  under a Custom-lit output only.

Related: [trim sheets](trim-sheets.md), [effects](effects.md),
[the graph editor](../features/editor.md#graph-editing).
