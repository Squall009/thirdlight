# Graph: Visual script (part 5, from Set cell metadata (`api.grid.setMeta`))

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Visual script node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="node-behavior--api-grid-set-meta"></a>
### Set cell metadata (`api.grid.setMeta`)

Set one metadata value of a cell (null removes the override; an empty cell becomes a metadata-only cell). False when refused.

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `key` (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-pick"></a>
### Pick cell (`api.grid.pick`)

The first block cell a ray enters (every layer, or one), with the face it entered through; null when none within maxDistance (default 100 m).

Inputs:

- `origin` (vector)
- `direction` (vector)
- `maxDistance` "max distance" (number)
- `layer` (string)

Outputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `normal_x` "normal x" (number)
- `normal_y` "normal y" (number)
- `normal_z` "normal z" (number)
- `distance` (number)
- `point_x` "point x" (number)
- `point_y` "point y" (number)
- `point_z` "point z" (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `origin` | origin | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `direction` | direction | vector | `[0,-1,0]` | -1000000000 – 1000000000; 3 components |
| `layer` | layer | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-neighbours"></a>
### Neighbour cells (`api.grid.neighbours`)

The cells next to [x, y, z] inside the layer's bounds: the 6 face neighbours, or all 26 with diagonal.

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `diagonal` (boolean)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `diagonal` | diagonal | boolean | `false` |  |

<a id="node-behavior--api-grid-walk-neighbours"></a>
### Walk neighbours (`api.grid.walkNeighbours`)

The places one step away from the place a cell names (the top it is, or the top a walker in that cell stands on): to the four neighbouring columns (eight with diagonal), within the step, drop and headroom limits, not across a wall or closed door; each with its cost (metres, times any cost field).

Inputs:

- `layer` (string)
- `cell` (list)
- `maxStep` "max step" (number)
- `maxDrop` "max drop" (number)
- `headroom` (number)
- `maxSlope` "max slope" (number)
- `diagonal` (boolean)
- `field` (string)
- `costField` "cost field" (string)
- `avoid` (list)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `diagonal` | diagonal | boolean | `false` |  |
| `field` | field | string | `""` | ≤ 256 chars |
| `costField` | cost field | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-path"></a>
### Walk path (`api.grid.path`)

The cheapest walk between the places two cells name ([x, y, z] each), start and end included, each with the cost so far; null when there is none (or the search passes 65,536 places: `pathOutcome` tells which).

Inputs:

- `layer` (string)
- `from` (list)
- `to` (list)
- `maxStep` "max step" (number)
- `maxDrop` "max drop" (number)
- `headroom` (number)
- `maxSlope` "max slope" (number)
- `diagonal` (boolean)
- `field` (string)
- `costField` "cost field" (string)
- `avoid` (list)

Outputs:

- `value` (list)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `diagonal` | diagonal | boolean | `false` |  |
| `field` | field | string | `""` | ≤ 256 chars |
| `costField` | cost field | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-path-outcome"></a>
### Walk path outcome (`api.grid.pathOutcome`)

Why the last `path` call answered as it did: "found"; "none" (no walk joins the two places); "limit" (the search passed 65,536 places first: a path may still exist, e.g. ask for a nearer cell); "invalid" (a layer, cell or option that does not fit, or no place at a cell). Null before the first call.

Outputs:

- `value` (string)
- `found` (boolean)

<a id="node-behavior--api-grid-reachable"></a>
### Walk reach (`api.grid.reachable`)

The places reachable from the place a cell names within a cost (metres, times any cost field), cheapest first, the start included (at most 65,536).

Inputs:

- `layer` (string)
- `from` (list)
- `maxCost` "max cost" (number)
- `maxStep` "max step" (number)
- `maxDrop` "max drop" (number)
- `headroom` (number)
- `maxSlope` "max slope" (number)
- `diagonal` (boolean)
- `field` (string)
- `costField` "cost field" (string)
- `avoid` (list)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `maxCost` | max cost | number | `0` | -1000000000 – 1000000000 |
| `diagonal` | diagonal | boolean | `false` |  |
| `field` | field | string | `""` | ≤ 256 chars |
| `costField` | cost field | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-regions"></a>
### Regions (`api.grid.regions`)

The region ids of a layer (each room drawn on it is one too: its outline's id, and "-s1", "-s2"… for its upper storeys).

Inputs:

- `layer` (string)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-region"></a>
### Region cells (`api.grid.region`)

The cells of a named region (at most 65,536), or null when the layer has no such region.

Inputs:

- `layer` (string)
- `regionId` "region" (string)

Outputs:

- `value` (list)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `regionId` | region | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-in-region"></a>
### In region (`api.grid.inRegion`)

Whether a cell lies in a named region.

Inputs:

- `layer` (string)
- `regionId` "region" (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `regionId` | region | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-grid-set-cutaway"></a>
### Set cut-away (`api.grid.setCutaway`)

Force a cut-away zone of a layer hidden (true) or shown (false) whatever the subject does, or give it back to the subject (null). A zone is a region the layer's cutaway lists, or "#<row>" for one of its height planes. Drawing only (it fades like any cut-away). False when refused (an unknown layer or zone).

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `zone` (string)
- `cut` (boolean)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `zone` | zone | string | `""` | ≤ 256 chars |
| `cut` | cut | boolean | `false` |  |

<a id="node-behavior--api-grid-set-cutaway-subject"></a>
### Set cut-away subject (`api.grid.setCutawaySubject`)

The object whose position decides the layers' cut-aways (what is cut while it stands under or inside it), or null for the camera's target (the default). False when the id is not a string.

Inputs:

- `in` "" (exec): takes several wires
- `targetId` "target" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `targetId` | target | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-set-cutaway-point"></a>
### Set cut-away point (`api.grid.setCutawayPoint`)

A world point [x, y, z] that decides the layers' cut-aways in place of an object. False when it is not three finite numbers.

Inputs:

- `in` "" (exec): takes several wires
- `point` (vector)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `point` | point | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-grid-set-kit"></a>
### Set kit (`api.grid.setKit`)

Show a kit over a layer (no region) or one of its regions: its block types are drawn, collide and spawn as each type's swap under the kit, without changing the cells (a dungeon burnt in place). Null shows no kit there (the authored one included); the layer re-meshes in the background, the old look drawn until the new is ready. False when refused (an unknown layer, kit or region). Saved with the gr

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `kit` (string)
- `region` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `kit` | kit | string | `""` | ≤ 256 chars |
| `region` | region | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-kit"></a>
### Kit (`api.grid.kit`)

The kit a layer (no region) or one of its regions shows now (null: none).

Inputs:

- `layer` (string)
- `region` (string)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `region` | region | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-set-architecture-preset"></a>
### Set architecture preset (`api.grid.setArchitecturePreset`)

Restyle generated architecture: every outline styled by preset `from` is made by preset `to` instead (its style, values and trim sheet), in every loaded and later loaded scene, without touching the outlines; null puts `from` back. The page makes the changed chunks in the background, the old ones drawn until the new are in, and the colliders follow. False when refused (not preset ids, `to` not a pr

Inputs:

- `in` "" (exec): takes several wires
- `from` (string)
- `to` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `from` | from | string | `""` | ≤ 256 chars |
| `to` | to | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-architecture-preset"></a>
### Architecture preset (`api.grid.architecturePreset`)

The preset shown in place of `from` now (null: `from` itself).

Inputs:

- `from` (string)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `from` | from | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-door-link"></a>
### Door link near (`api.grid.doorLink`)

The linked door nearest a world point within `reach` metres (absent: 2) on the ground, or null.

Inputs:

- `point` (vector)
- `reach` (number)

Outputs:

- `id` (string)
- `building` (string)
- `door` (string)
- `entity` (string)
- `scene` (string)
- `side` (string)
- `to_position` "to position" (vector)
- `to_spawn` "to spawn" (vector)
- `to_facing` "to facing" (number)
- `to_scene` "to scene" (string)
- `position` (vector)
- `spawn` (vector)
- `facing` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `point` | point | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `reach` | reach | number | `2` | -1000000000 – 1000000000 |

<a id="node-behavior--api-grid-edge"></a>
### Get edge (`api.grid.edge`)

The edge piece on a side of a cell (a wall, door or fence between it and its neighbour), or null when none stands there.

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `block` (string)
- `rot` (number)
- `variant` (number)
- `piece` (string)
- `kitBlock` "kit block" (string)
- `open` (boolean)
- `blocked` (boolean)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `side` | side | enum | `"-x"` | `-x`, `+x`, `-z`, `+z` |

<a id="node-behavior--api-grid-blocked"></a>
### Edge blocked (`api.grid.blocked`)

Whether an edge piece blocks moving from a cell across one of its sides (a wall or a closed door does; an open door, a non-blocking piece or no piece does not). Where no piece stands, a room's wall drawn on the layer blocks (its doorways and windows do not).

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `side` | side | enum | `"-x"` | `-x`, `+x`, `-z`, `+z` |

<a id="node-behavior--api-grid-set-edge"></a>
### Set edge (`api.grid.setEdge`)

Put an edge piece on a side of a cell. False when refused (not an edge block type, outside the bounds, a rotation other than 0 or 180).

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `block` (string)
- `rot` (number)
- `variant` (number)
- `open` (boolean)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `side` | side | enum | `"-x"` | `-x`, `+x`, `-z`, `+z` |
| `block` | block | string | `""` | ≤ 256 chars |
| `open` | open | boolean | `false` |  |

<a id="node-behavior--api-grid-clear-edge"></a>
### Clear edge (`api.grid.clearEdge`)

Remove the edge piece on a side of a cell. False when refused or none stands there.

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `side` | side | enum | `"-x"` | `-x`, `+x`, `-z`, `+z` |

<a id="node-behavior--api-grid-set-edge-open"></a>
### Open edge (`api.grid.setEdgeOpen`)

Open or close the edge piece on a side of a cell (a door): open, it blocks no passage and has no collider. False when none stands there or it already is.

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `open` (boolean)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `side` | side | enum | `"-x"` | `-x`, `+x`, `-z`, `+z` |
| `open` | open | boolean | `false` |  |

<a id="node-behavior--api-grid-edge-entity"></a>
### Edge object (`api.grid.edgeEntity`)

The id of the object a live edge piece spawns (its prefab's root), or null when the edge shows no live piece.

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `side` | side | enum | `"-x"` | `-x`, `+x`, `-z`, `+z` |

<a id="node-behavior--api-grid-entity"></a>
### Cell object (`api.grid.entity`)

The id of the object a live block's cell spawns (its prefab's root; a cell a larger block covers names the block's), or null when the cell shows no live block. The id is the cell's from the write on; the object is in the game from the end of the step that wrote the cell.

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-grid-cell-of"></a>
### Object cell (`api.grid.cellOf`)

The cell a live block's object belongs to (its root or any of its children; the block's anchor cell; for a live edge piece the cell whose side it stands on, with that side), or null for any other object. An empty entity means this object.

Inputs:

- `entityId` "entity" (string)

Outputs:

- `x` (number)
- `y` (number)
- `z` (number)
- `layer` (string)
- `side` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="graph-behavior--scatter"></a>
## Scatter

- Scatter copies near (`api.scatter.near`): The copies standing within `radius` metres of a world position (measured across the ground, x and z), nearest first: of one rule or object only, hidden ones too (`hidden: true`), at most `limit` (default 64, at most 1,024).
- Scatter copy (`api.scatter.get`): The copy at an address (hidden ones too), or null when there is none or it was removed.
- Hide scatter copy (`api.scatter.hide`): Hide a copy: it is not drawn and does not collide until shown again. False when there is no such copy or it is hidden already.
- Show scatter copy (`api.scatter.show`): Show a hidden copy again. False when it is not hidden.
- Remove scatter copy (`api.scatter.remove`): Remove a copy for the rest of the run (not drawn, no collider). False when there is no such copy (or it is gone already).

<a id="node-behavior--api-scatter-near"></a>
### Scatter copies near (`api.scatter.near`)

The copies standing within `radius` metres of a world position (measured across the ground, x and z), nearest first: of one rule or object only, hidden ones too (`hidden: true`), at most `limit` (default 64, at most 1,024).

Inputs:

- `position` (vector)
- `radius` (number)
- `rule` (string)
- `source` (string)
- `hidden` (boolean)
- `limit` (number)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `radius` | radius | number | `10` | -1000000000 – 1000000000 |
| `rule` | rule | string | `""` | ≤ 256 chars |
| `source` | source | string | `""` | ≤ 256 chars |
| `hidden` | hidden | boolean | `false` |  |

<a id="node-behavior--api-scatter-get"></a>
### Scatter copy (`api.scatter.get`)

The copy at an address (hidden ones too), or null when there is none or it was removed.

Inputs:

- `address` (string)

Outputs:

- `address` (string)
- `source` (string)
- `rule` (string)
- `cell` (vector)
- `position` (vector)
- `rotation` (list)
- `scale` (number)
- `hidden` (boolean)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `address` | address | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-scatter-hide"></a>
### Hide scatter copy (`api.scatter.hide`)

Hide a copy: it is not drawn and does not collide until shown again. False when there is no such copy or it is hidden already.

Inputs:

- `in` "" (exec): takes several wires
- `address` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `address` | address | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-scatter-show"></a>
### Show scatter copy (`api.scatter.show`)

Show a hidden copy again. False when it is not hidden.

Inputs:

- `in` "" (exec): takes several wires
- `address` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `address` | address | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-scatter-remove"></a>
### Remove scatter copy (`api.scatter.remove`)

Remove a copy for the rest of the run (not drawn, no collider). False when there is no such copy (or it is gone already).

Inputs:

- `in` "" (exec): takes several wires
- `address` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `address` | address | string | `""` | ≤ 256 chars |

<a id="graph-behavior--splines"></a>
## Splines

- Spline length (`api.splines.length`): Metres along an object's spline (null when the object carries none or is not loaded). An empty entity means this object.
- Spline point at (`api.splines.at`): The place and cross-section `distance` metres along an object's spline (clamped to its ends; a closed one wraps), or null without one. An empty entity means this object.
- Nearest on spline (`api.splines.nearest`): The nearest place on an object's spline to a world position (`level`: measured across the ground, x and z only), or null without one. An empty entity means this object.

<a id="node-behavior--api-splines-length"></a>
### Spline length (`api.splines.length`)

Metres along an object's spline (null when the object carries none or is not loaded). An empty entity means this object.

Inputs:

- `entityId` "entity" (string)

Outputs:

- `value` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-splines-at"></a>
### Spline point at (`api.splines.at`)

The place and cross-section `distance` metres along an object's spline (clamped to its ends; a closed one wraps), or null without one. An empty entity means this object.

Inputs:

- `entityId` "entity" (string)
- `distance` (number)

Outputs:

- `distance` (number)
- `position` (vector)
- `tangent` (vector)
- `right` (vector)
- `up` (vector)
- `width` (number)
- `roll` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `distance` | distance | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-splines-nearest"></a>
### Nearest on spline (`api.splines.nearest`)

The nearest place on an object's spline to a world position (`level`: measured across the ground, x and z only), or null without one. An empty entity means this object.

Inputs:

- `entityId` "entity" (string)
- `position` (vector)
- `level` (boolean)

Outputs:

- `distance` (number)
- `position` (vector)
- `offset` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `level` | level | boolean | `false` |  |

<a id="graph-behavior--surface"></a>
## Surface

- Surface at (`api.surface.at`): The ground at or below a world position (a point inside blocks gives their top), or null where no block layer or loaded terrain tile has ground (a hole, off the level).
- Top surface (`api.surface.top`): The highest ground at world x, z, or null where there is none.

<a id="node-behavior--api-surface-at"></a>
### Surface at (`api.surface.at`)

The ground at or below a world position (a point inside blocks gives their top), or null where no block layer or loaded terrain tile has ground (a hole, off the level).

Inputs:

- `position` (vector)

Outputs:

- `source` (string)
- `object` (string)
- `height` (number)
- `point` (vector)
- `normal` (vector)
- `slope` (number)
- `layers` (vector)
- `weights` (vector)
- `wetness` (number)
- `cell` (vector)
- `block` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-surface-top"></a>
### Top surface (`api.surface.top`)

The highest ground at world x, z, or null where there is none.

Inputs:

- `x` (number)
- `z` (number)

Outputs:

- `source` (string)
- `object` (string)
- `height` (number)
- `point` (vector)
- `normal` (vector)
- `slope` (number)
- `layers` (vector)
- `weights` (vector)
- `wetness` (number)
- `cell` (vector)
- `block` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="graph-behavior--camera"></a>
## Camera

- Activate camera (`api.camera.activate`): Enable a virtual camera and bring it in front of the cameras of its priority (it goes live unless a higher priority is enabled). `false` when there is no such camera.
- Deactivate camera (`api.camera.deactivate`): Disable a virtual camera (the view blends to the next one, or to the default pose when none is left).
- Set camera priority (`api.camera.setPriority`): Set a camera's priority (−1000–1000; the enabled camera with the highest is live).
- Set camera target (`api.camera.setTarget`): Point a camera at another target entity ('' for none). An empty entity means this object.
- Set camera rig (`api.camera.set`): Set a camera's rig values (each optional): distance, yaw, pitch (kept within its pitch limits), progress and railSpeed of a rail camera, field of view, letterbox, the orbit point, the target offset.
- Turn camera (`api.camera.turn`): Turn a camera by whole steps (an orbit-a-point camera: its turn step; positive turns left).
- Shake camera (`api.camera.shake`): Shake the view: up to `amplitude` metres (and `rotation` degrees), `frequency` times a second (default 8), fading out over `seconds`. Seeded: the same run shakes the same way (`seed` picks another pattern).
- Set see-through (`api.camera.setSeeThrough`): Change see-through (each field optional; the rest stay as the project or an earlier call set them): what stands between the camera and a subject thins to a dither in a soft circle round it. `subjects` are entity ids (as many as you like; the view fades round the nearest few); null or an empty list goes back to the live camera's target. Radius and softness are shares of the view's height and of the
- Live camera (`api.camera.live`): The live virtual camera, or null while none is (the view holds the default pose).
- Camera blending (`api.camera.blending`): A blend between two cameras is in progress.
- Camera state (`api.camera.get`): A virtual camera's live rig values, or null when there is no such camera.
- World to screen (`api.camera.worldToScreen`): Where a world point appears on screen (x, y 0–1 from the top left), how far in front of the camera it is, and whether it is in view.
- Screen to ray (`api.camera.screenToRay`): The ray from the camera through a screen point (x, y 0–1 from the top left): its origin and unit direction.

<a id="node-behavior--api-camera-activate"></a>
### Activate camera (`api.camera.activate`)

Enable a virtual camera and bring it in front of the cameras of its priority (it goes live unless a higher priority is enabled). `false` when there is no such camera.

Inputs:

- `in` "" (exec): takes several wires
- `cameraId` "camera" (string)
- `time` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `cameraId` | camera | string | `""` | ≤ 256 chars |
| `blend` | blend | enum | `"cut"` | `cut`, `linear`, `eased`, `none` |

<a id="node-behavior--api-camera-deactivate"></a>
### Deactivate camera (`api.camera.deactivate`)

Disable a virtual camera (the view blends to the next one, or to the default pose when none is left).

Inputs:

- `in` "" (exec): takes several wires
- `cameraId` "camera" (string)
- `time` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `cameraId` | camera | string | `""` | ≤ 256 chars |
| `blend` | blend | enum | `"cut"` | `cut`, `linear`, `eased`, `none` |

<a id="node-behavior--api-camera-set-priority"></a>
### Set camera priority (`api.camera.setPriority`)

Set a camera's priority (−1000–1000; the enabled camera with the highest is live).

Inputs:

- `in` "" (exec): takes several wires
- `cameraId` "camera" (string)
- `priority` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `cameraId` | camera | string | `""` | ≤ 256 chars |
| `priority` | priority | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-camera-set-target"></a>
### Set camera target (`api.camera.setTarget`)

Point a camera at another target entity ('' for none). An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `cameraId` "camera" (string)
- `entityId` "target" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `cameraId` | camera | string | `""` | ≤ 256 chars |
| `entityId` | target | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-camera-set"></a>
### Set camera rig (`api.camera.set`)

Set a camera's rig values (each optional): distance, yaw, pitch (kept within its pitch limits), progress and railSpeed of a rail camera, field of view, letterbox, the orbit point, the target offset.

Inputs:

- `in` "" (exec): takes several wires
- `cameraId` "camera" (string)
- `distance` (number)
- `yaw` (number)
- `pitch` (number)
- `progress` (number)
- `railSpeed` "rail speed" (number)
- `fovY` "fov y" (number)
- `letterbox` (number)
- `point` (vector)
- `targetOffset` "target offset" (vector)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `cameraId` | camera | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-camera-turn"></a>
### Turn camera (`api.camera.turn`)

Turn a camera by whole steps (an orbit-a-point camera: its turn step; positive turns left).

Inputs:

- `in` "" (exec): takes several wires
- `cameraId` "camera" (string)
- `steps` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `cameraId` | camera | string | `""` | ≤ 256 chars |
| `steps` | steps | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-camera-shake"></a>
### Shake camera (`api.camera.shake`)

Shake the view: up to `amplitude` metres (and `rotation` degrees), `frequency` times a second (default 8), fading out over `seconds`. Seeded: the same run shakes the same way (`seed` picks another pattern).

Inputs:

- `in` "" (exec): takes several wires
- `amplitude` (number)
- `seconds` (number)
- `frequency` (number)
- `rotation` (number)
- `seed` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `amplitude` | amplitude | number | `0.2` | -1000000000 – 1000000000 |
| `seconds` | seconds | number | `0.5` | -1000000000 – 1000000000 |
| `frequency` | frequency | number | `8` | -1000000000 – 1000000000 |
| `rotation` | rotation | number | `0` | -1000000000 – 1000000000 |
| `seed` | seed | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-camera-set-see-through"></a>
### Set see-through (`api.camera.setSeeThrough`)

Change see-through (each field optional; the rest stay as the project or an earlier call set them): what stands between the camera and a subject thins to a dither in a soft circle round it. `subjects` are entity ids (as many as you like; the view fades round the nearest few); null or an empty list goes back to the live camera's target. Radius and softness are shares of the view's height and of the

Inputs:

- `in` "" (exec): takes several wires
- `enabled` (boolean)
- `subjects` (list)
- `radius` (number)
- `softness` (number)
- `maxFade` "max fade" (number)
- `depthMargin` "depth margin" (number)
- `fadeTime` "fade time" (number)
- `padding` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `enabled` | enabled | boolean | `true` |  |

<a id="node-behavior--api-camera-live"></a>
### Live camera (`api.camera.live`)

The live virtual camera, or null while none is (the view holds the default pose).

Outputs:

- `value` (string)
- `found` (boolean)

<a id="node-behavior--api-camera-blending"></a>
### Camera blending (`api.camera.blending`)

A blend between two cameras is in progress.

Outputs:

- `value` (boolean)

<a id="node-behavior--api-camera-get"></a>
### Camera state (`api.camera.get`)

A virtual camera's live rig values, or null when there is no such camera.

Inputs:

- `cameraId` "camera" (string)

Outputs:

- `rig` (string)
- `enabled` (boolean)
- `priority` (number)
- `live` (boolean)
- `target` (string)
- `distance` (number)
- `yaw` (number)
- `pitch` (number)
- `progress` (number)
- `railSpeed` "rail speed" (number)
- `fovY` "fov y" (number)
- `letterbox` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `cameraId` | camera | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-camera-world-to-screen"></a>
### World to screen (`api.camera.worldToScreen`)

Where a world point appears on screen (x, y 0–1 from the top left), how far in front of the camera it is, and whether it is in view.

Inputs:

- `position` (vector)

Outputs:

- `x` (number)
- `y` (number)
- `depth` (number)
- `onScreen` "on screen" (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-camera-screen-to-ray"></a>
### Screen to ray (`api.camera.screenToRay`)

The ray from the camera through a screen point (x, y 0–1 from the top left): its origin and unit direction.

Inputs:

- `x` (number)
- `y` (number)

Outputs:

- `origin` (vector)
- `direction` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `x` | x | number | `0.5` | -1000000000 – 1000000000 |
| `y` | y | number | `0.5` | -1000000000 – 1000000000 |

<a id="graph-behavior--sockets"></a>
## Sockets

- Attach to socket (`api.sockets.attach`): Attach an object to a node of the target's model, with an optional offset in the node's space (position [x, y, z], rotation quaternion [x, y, z, w], scale [x, y, z]). Without a target the object's own Socket component is used. False (and a warning in the play log) when refused: an unknown object, target or node, a loop, or a physics body. An empty entity means this object.
- Detach from socket (`api.sockets.detach`): Detach an object from its socket: it stays where the node left it (keepWorld, the default) or snaps back to its transform from before the attach. False when it was not attached. An empty entity means this object.
- Socket of (`api.sockets.attachedTo`): The socket an object rides on (the target object and the node's name), or null. An empty entity means this object.
- Node pose (`api.sockets.nodePose`): A node's world position and rotation now (the target's model posed by its animator), or null when the target, its model or the node is missing — e.g. where a muzzle or a hand is.

<a id="node-behavior--api-sockets-attach"></a>
### Attach to socket (`api.sockets.attach`)

Attach an object to a node of the target's model, with an optional offset in the node's space (position [x, y, z], rotation quaternion [x, y, z, w], scale [x, y, z]). Without a target the object's own Socket component is used. False (and a warning in the play log) when refused: an unknown object, target or node, a loop, or a physics body. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `targetId` "target" (string)
- `node` (string)
- `position` (vector)
- `rotation` (vector)
- `scale` (vector)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `targetId` | target | string | `""` | ≤ 256 chars |
| `node` | node | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-sockets-detach"></a>
### Detach from socket (`api.sockets.detach`)

Detach an object from its socket: it stays where the node left it (keepWorld, the default) or snaps back to its transform from before the attach. False when it was not attached. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `keepWorld` "keep world" (boolean)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `keepWorld` | keep world | boolean | `true` |  |

<a id="node-behavior--api-sockets-attached-to"></a>
### Socket of (`api.sockets.attachedTo`)

The socket an object rides on (the target object and the node's name), or null. An empty entity means this object.

Inputs:

- `entityId` "object" (string)

Outputs:

- `target` (string)
- `nodeName` "node name" (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-sockets-node-pose"></a>
### Node pose (`api.sockets.nodePose`)

A node's world position and rotation now (the target's model posed by its animator), or null when the target, its model or the node is missing — e.g. where a muzzle or a hand is.

Inputs:

- `targetId` "target" (string)
- `node` (string)

Outputs:

- `position` (vector)
- `rotation` (list)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `targetId` | target | string | `""` | ≤ 256 chars |
| `node` | node | string | `""` | ≤ 256 chars |

<a id="graph-behavior--materials"></a>
## Materials

- Set material parameter (`api.materials.set`): Set a parameter on one object: a number (float), 2–4 numbers (vec2–4), "#rrggbb" (colour) or a texture asset id of the game ("" for none). Other objects wearing the material keep their values. False when refused. An empty entity means this object.
- Material parameter (`api.materials.get`): A parameter's value on an object now: what a script set, else the object's authored override, else the material's default (null: no such parameter, or a data parameter). An empty entity means this object.
- Reset material parameter (`api.materials.reset`): Put a parameter (or, without one, every parameter scripts set) of an object back to its authored value; a data parameter back to its starting cells. An empty entity means this object.
- Write material data (`api.materials.setData`): Write a rectangle of cells of a data parameter: x, y, width, height in cells (cell [0, 0] sits at UV (0, 0)); bytes = RGBA 0–255 per cell, row by row from y (width × height × 4 numbers). False when refused (outside the grid, wrong length). An empty entity means this object.
- Material data cell (`api.materials.getData`): One cell of a data parameter on an object as [r, g, b, a] (0–255), or null (no such parameter or cell). An empty entity means this object.

<a id="node-behavior--api-materials-set"></a>
### Set material parameter (`api.materials.set`)

Set a parameter on one object: a number (float), 2–4 numbers (vec2–4), "#rrggbb" (colour) or a texture asset id of the game ("" for none). Other objects wearing the material keep their values. False when refused. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `param` "parameter" (string)
- `value` (number): type from field `value_type`
- `materialId` "material" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `param` | parameter | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |
| `value` | value | string | `""` | ≤ 256 chars |
| `materialId` | material | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-materials-get"></a>
### Material parameter (`api.materials.get`)

A parameter's value on an object now: what a script set, else the object's authored override, else the material's default (null: no such parameter, or a data parameter). An empty entity means this object.

Inputs:

- `entityId` "entity" (string)
- `param` "parameter" (string)
- `materialId` "material" (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `param` | parameter | string | `""` | ≤ 256 chars |
| `materialId` | material | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--api-materials-reset"></a>
### Reset material parameter (`api.materials.reset`)

Put a parameter (or, without one, every parameter scripts set) of an object back to its authored value; a data parameter back to its starting cells. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `param` "parameter" (string)
- `materialId` "material" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `param` | parameter | string | `""` | ≤ 256 chars |
| `materialId` | material | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-materials-set-data"></a>
### Write material data (`api.materials.setData`)

Write a rectangle of cells of a data parameter: x, y, width, height in cells (cell [0, 0] sits at UV (0, 0)); bytes = RGBA 0–255 per cell, row by row from y (width × height × 4 numbers). False when refused (outside the grid, wrong length). An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `param` "parameter" (string)
- `x` (number)
- `y` (number)
- `w` (number)
- `h` (number)
- `bytes` (list)
- `materialId` "material" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `param` | parameter | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `w` | w | number | `1` | -1000000000 – 1000000000 |
| `h` | h | number | `1` | -1000000000 – 1000000000 |
| `materialId` | material | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-materials-get-data"></a>
### Material data cell (`api.materials.getData`)

One cell of a data parameter on an object as [r, g, b, a] (0–255), or null (no such parameter or cell). An empty entity means this object.

Inputs:

- `entityId` "entity" (string)
- `param` "parameter" (string)
- `x` (number)
- `y` (number)
- `materialId` "material" (string)

Outputs:

- `value` (vector)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `param` | parameter | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `materialId` | material | string | `""` | ≤ 256 chars |
