# Graph: Visual script (part 5, from Edge object (`api.grid.edgeEntity`))

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Visual script node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

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
| `blend` | blend | enum | `"cut"` | `cut`, `linear`, `eased` |

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
| `blend` | blend | enum | `"cut"` | `cut`, `linear`, `eased` |

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

<a id="graph-behavior--saves"></a>
## Saves

- Save version (`api.saves.version`): The save document's schema version (0: the project declares no save schema).
- Save slot count (`api.saves.slotCount`): How many slots the game offers.
- Write save document (`api.saves.write`): Replace the project's save document (any JSON value); false when it is not JSON or larger than 1 MiB.
- Save document (`api.saves.read`): The project's save document (a copy; null before one is written or loaded).
- Save to slot (`api.saves.save`): Save to a slot at the end of this step (the document and the engine sections of the schema); the outcome arrives in `results()`. `meta.meta`: the game's own fields for the slot card (names → texts; the record at most 4 KiB as JSON). False for a slot the game does not have or a meta that does not fit.
- Load slot (`api.saves.load`): Load a slot: when storage answers, the document is migrated and restored at the end of that step (the outcome in `results()`).
- Delete slot (`api.saves.delete`): Delete a slot (the outcome in `results()`).
- Save slots (`api.saves.slots`): The used slots with what they show (title, chapter, location, play time, when, picture, the game's own `meta` fields).
- Save slots ready (`api.saves.ready`): Whether the slot list has arrived from storage (it is empty before).
- Save results (`api.saves.results`): The outcomes that arrived this step (saves, loads and deletes).
- Save storage (`api.saves.storage`): The player's storage: whether the browser keeps the game's saves under disk pressure (`persisted`, asked for at the first save) and the site's `usage` and `quota` in bytes; null where the browser does not say.
- Play time (`api.saves.playSeconds`): Play time in seconds (restored with a loaded save).
- Setting (`api.saves.setting`): A value of the project settings document (its default until the player changes it).
- Settings document (`api.saves.settings`): The whole project settings document (a copy).
- Set setting (`api.saves.setSetting`): Change a value of the project settings document (kept in the player's browser; an engine setting it drives — volume, quality — applies at once). False when the key is unknown or the value does not fit.

<a id="node-behavior--api-saves-version"></a>
### Save version (`api.saves.version`)

The save document's schema version (0: the project declares no save schema).

Outputs:

- `value` (number)

<a id="node-behavior--api-saves-slot-count"></a>
### Save slot count (`api.saves.slotCount`)

How many slots the game offers.

Outputs:

- `value` (number)

<a id="node-behavior--api-saves-write"></a>
### Write save document (`api.saves.write`)

Replace the project's save document (any JSON value); false when it is not JSON or larger than 1 MiB.

Inputs:

- `in` "" (exec): takes several wires
- `doc` (number): type from field `doc_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `doc_type` | doc type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |
| `doc` | doc | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-saves-read"></a>
### Save document (`api.saves.read`)

The project's save document (a copy; null before one is written or loaded).

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--api-saves-save"></a>
### Save to slot (`api.saves.save`)

Save to a slot at the end of this step (the document and the engine sections of the schema); the outcome arrives in `results()`. `meta.meta`: the game's own fields for the slot card (names → texts; the record at most 4 KiB as JSON). False for a slot the game does not have or a meta that does not fit.

Inputs:

- `in` "" (exec): takes several wires
- `slot` (number)
- `title` (string)
- `chapter` (string)
- `location` (string)
- `thumbnail` (boolean)
- `meta` (map)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `slot` | slot | number | `0` | -1000000000 – 1000000000 |
| `title` | title | string | `""` | ≤ 256 chars |
| `chapter` | chapter | string | `""` | ≤ 256 chars |
| `location` | location | string | `""` | ≤ 256 chars |
| `thumbnail` | thumbnail | boolean | `false` |  |

<a id="node-behavior--api-saves-load"></a>
### Load slot (`api.saves.load`)

Load a slot: when storage answers, the document is migrated and restored at the end of that step (the outcome in `results()`).

Inputs:

- `in` "" (exec): takes several wires
- `slot` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `slot` | slot | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-saves-delete"></a>
### Delete slot (`api.saves.delete`)

Delete a slot (the outcome in `results()`).

Inputs:

- `in` "" (exec): takes several wires
- `slot` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `slot` | slot | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-saves-slots"></a>
### Save slots (`api.saves.slots`)

The used slots with what they show (title, chapter, location, play time, when, picture, the game's own `meta` fields).

Outputs:

- `value` (list)

<a id="node-behavior--api-saves-ready"></a>
### Save slots ready (`api.saves.ready`)

Whether the slot list has arrived from storage (it is empty before).

Outputs:

- `value` (boolean)

<a id="node-behavior--api-saves-results"></a>
### Save results (`api.saves.results`)

The outcomes that arrived this step (saves, loads and deletes).

Outputs:

- `value` (list)

<a id="node-behavior--api-saves-storage"></a>
### Save storage (`api.saves.storage`)

The player's storage: whether the browser keeps the game's saves under disk pressure (`persisted`, asked for at the first save) and the site's `usage` and `quota` in bytes; null where the browser does not say.

Outputs:

- `persisted` (boolean)
- `usage` (number)
- `quota` (number)

<a id="node-behavior--api-saves-play-seconds"></a>
### Play time (`api.saves.playSeconds`)

Play time in seconds (restored with a loaded save).

Outputs:

- `value` (number)

<a id="node-behavior--api-saves-setting"></a>
### Setting (`api.saves.setting`)

A value of the project settings document (its default until the player changes it).

Inputs:

- `key` (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |

<a id="node-behavior--api-saves-settings"></a>
### Settings document (`api.saves.settings`)

The whole project settings document (a copy).

Outputs:

- `value` (map)

<a id="node-behavior--api-saves-set-setting"></a>
### Set setting (`api.saves.setSetting`)

Change a value of the project settings document (kept in the player's browser; an engine setting it drives — volume, quality — applies at once). False when the key is unknown or the value does not fit.

Inputs:

- `in` "" (exec): takes several wires
- `key` (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="graph-behavior--assets"></a>
## Assets

- Load assets (`api.assets.load`): Start loading the asset or resource with this id or address, or every one with this label. Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading' until the assets are ready, a later step.
- Release assets (`api.assets.release`): Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.
- Assets state (`api.assets.state`): A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.
- Assets ready (`api.assets.ready`): True once a handle's assets are loaded.
- Assets error (`api.assets.error`): Why a failed handle failed ('' otherwise).

<a id="node-behavior--api-assets-load"></a>
### Load assets (`api.assets.load`)

Start loading the asset or resource with this id or address, or every one with this label. Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading' until the assets are ready, a later step.

Inputs:

- `in` "" (exec): takes several wires
- `key` "id, address or label" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | id, address or label | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-assets-release"></a>
### Release assets (`api.assets.release`)

Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-assets-state"></a>
### Assets state (`api.assets.state`)

A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.

Inputs:

- `handle` (number)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-assets-ready"></a>
### Assets ready (`api.assets.ready`)

True once a handle's assets are loaded.

Inputs:

- `handle` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-assets-error"></a>
### Assets error (`api.assets.error`)

Why a failed handle failed ('' otherwise).

Inputs:

- `handle` (number)

Outputs:

- `value` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="graph-behavior--ui"></a>
## UI

- Set UI value (`api.ui.set`): Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.
- UI value (`api.ui.get`): The published value at a path (null when there is none).
- Clear UI value (`api.ui.clear`): Remove a path from the view model (`false` when it was not there).
- Show UI (`api.ui.show`): Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.
- Hide UI (`api.ui.hide`): Hide a shown UI document (`false` when it was not shown).
- UI shown (`api.ui.isShown`): The document is shown.
- Play UI tween (`api.ui.play`): Play a tween of a document (on a widget, or the whole document). Presentation only.
- Focus UI widget (`api.ui.focus`): Move the keyboard/gamepad focus to a widget of a shown document; `index` names the list item the widget is in (absent: the first such widget). `false` for an unknown document, a bad widget id or index.
- UI view (`api.ui.view`): The view the UI is drawn over: its size in CSS px, its aspect (width / height) and the device pixels per CSS px. Read from the page each frame (not simulation state: a replay in another window reads that window's); 1280 × 720 at 1 until the page reported it.
- UI events (`api.ui.events`): The UI events of this step (clicks, submits, focus changes, shows and hides), in order.
- UI event (`api.ui.event`): The first UI event of this step with this name (a button's or an input's event), or null.

<a id="node-behavior--api-ui-set"></a>
### Set UI value (`api.ui.set`)

Publish a value at a view-model path ("hud.hp", "party.0.name"): a number, text (≤ 1024), true/false, null, a list (≤ 256) or an object (≤ 64 keys). `false` for a bad path or value, or past the view model's 64 KiB.

Inputs:

- `in` "" (exec): takes several wires
- `path` (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `path` | path | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-get"></a>
### UI value (`api.ui.get`)

The published value at a path (null when there is none).

Inputs:

- `path` (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `path` | path | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--api-ui-clear"></a>
### Clear UI value (`api.ui.clear`)

Remove a path from the view model (`false` when it was not there).

Inputs:

- `in` "" (exec): takes several wires
- `path` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `path` | path | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-show"></a>
### Show UI (`api.ui.show`)

Show a UI document (on top of its layer; `layer` and `modal` override the document's). `false` when there is no such document.

Inputs:

- `in` "" (exec): takes several wires
- `docId` "document" (string)
- `layer` (number)
- `modal` (boolean)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |
| `modal` | modal | boolean | `false` |  |

<a id="node-behavior--api-ui-hide"></a>
### Hide UI (`api.ui.hide`)

Hide a shown UI document (`false` when it was not shown).

Inputs:

- `in` "" (exec): takes several wires
- `docId` "document" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-is-shown"></a>
### UI shown (`api.ui.isShown`)

The document is shown.

Inputs:

- `docId` "document" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-play"></a>
### Play UI tween (`api.ui.play`)

Play a tween of a document (on a widget, or the whole document). Presentation only.

Inputs:

- `in` "" (exec): takes several wires
- `docId` "document" (string)
- `tween` (string)
- `widgetId` "widget" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |
| `tween` | tween | string | `""` | ≤ 256 chars |
| `widgetId` | widget | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-focus"></a>
### Focus UI widget (`api.ui.focus`)

Move the keyboard/gamepad focus to a widget of a shown document; `index` names the list item the widget is in (absent: the first such widget). `false` for an unknown document, a bad widget id or index.

Inputs:

- `in` "" (exec): takes several wires
- `docId` "document" (string)
- `widgetId` "widget" (string)
- `index` "list item" (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `docId` | document | string | `""` | ≤ 256 chars |
| `widgetId` | widget | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-ui-view"></a>
### UI view (`api.ui.view`)

The view the UI is drawn over: its size in CSS px, its aspect (width / height) and the device pixels per CSS px. Read from the page each frame (not simulation state: a replay in another window reads that window's); 1280 × 720 at 1 until the page reported it.

Outputs:

- `width` (number)
- `height` (number)
- `aspect` (number)
- `pixelRatio` "pixel ratio" (number)

<a id="node-behavior--api-ui-events"></a>
### UI events (`api.ui.events`)

The UI events of this step (clicks, submits, focus changes, shows and hides), in order.

Outputs:

- `value` (list)

<a id="node-behavior--api-ui-event"></a>
### UI event (`api.ui.event`)

The first UI event of this step with this name (a button's or an input's event), or null.

Inputs:

- `name` (string)

Outputs:

- `kind` (string)
- `doc` (string)
- `widget` (string)
- `name` (string)
- `value` (number): type from field `value_type`
- `index` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | name | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |

<a id="graph-behavior--stats"></a>
## Stats

- Stats fps (`api.stats.fps`): Frames drawn per second over the window.
- Stats frame ms (`api.stats.frameMs`): The time from one frame to the next (ms).
- Stats cpu ms (`api.stats.cpuMs`): The page thread's work per frame (ms): the simulation's steps when it runs on the page, the frame's host work and the draw calls' submission.
- Stats gpu ms (`api.stats.gpuMs`): The GPU's time per frame (ms) from timestamp queries; null where the browser or GPU has none (not measured).
- Stats draw calls (`api.stats.drawCalls`): Draw calls of the last frame.
- Stats triangles (`api.stats.triangles`): Triangles of the last frame.
- Stats texture bytes (`api.stats.textureBytes`): Texture bytes resident on the GPU (streamed and fixed, images inside models included).
- Stats texture budget bytes (`api.stats.textureBudgetBytes`): The texture budget (bytes; the setting texture_budget_mb).
- Stats geometry bytes (`api.stats.geometryBytes`): Geometry bytes of the loaded models.
- Stats entities (`api.stats.entities`): Objects in the simulation.
- Stats quality (`api.stats.quality`): The quality level drawn: its id ("low", "medium", "high", or one of the project's own levels).
- Stats frame rate cap (`api.stats.frameRateCap`): The frame-rate cap the page draws under (30, 60 or 120 fps), or null for none (the display's rate).
- Stats window ms (`api.stats.windowMs`): The window the times are measured over (ms).

<a id="node-behavior--api-stats-fps"></a>
### Stats fps (`api.stats.fps`)

Frames drawn per second over the window.

Outputs:

- `value` (number)

<a id="node-behavior--api-stats-frame-ms"></a>
### Stats frame ms (`api.stats.frameMs`)

The time from one frame to the next (ms).

Outputs:

- `avg` (number)
- `worst` (number)
