# Components: Object

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Object components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-transform"></a>
## transform — Transform

Where the object is, how it is turned and how big it is (relative to its parent).

- Category: Object
- Added: never by hand: every object has a transform (a folder has none)
- On prefab objects: yes

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `position` | vec3 [x, y, z] | `[0,0,0]` | -1000000 – 1000000, step 0.1, m | **Position.** Offset from the parent (metres). (scripts read and write) |
| `rotation` | quat | `[0,0,0,1]` |  | **Rotation.** Orientation as a unit quaternion [x, y, z, w] (the Inspector shows degrees). (scripts read and write) |
| `scale` | vec3 [x, y, z] | `[1,1,1]` | > 0, ≤ 1000000, step 0.1, × | **Scale.** Size multiplier per axis (above 0). (scripts read and write) |

<a id="component-socketAttach"></a>
## socketAttach — Socket

Rides on a named node (a bone or any node) of another object's model, with an offset: equipment in a hand, a rider on a mount, a pilot in a cockpit. The simulation places it every step, following the target's animation; scripts attach and detach at run time (ctx.sockets).

- Category: Object
- Added: from "+ Add component" after picking `target` (the rest starts as `{}`)
- On prefab objects: no
- Cannot share an object with [`collider`](components-physics.md#component-collider): a physics body is posed by physics, not by a socket
- Cannot share an object with [`controller`](components-physics.md#component-controller): a physics body is posed by physics, not by a socket
- Cannot share an object with [`mover`](components-gameplay.md#component-mover): a physics body is posed by physics, not by a socket

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `target` | object id (with `model`) |  |  | **Target.** The object whose model carries the node. (required; scripts read) |
| `node` | string, socketNode, 1–128 chars |  |  | **Node.** The node (or bone) of the target's model it rides on (the list shows the model's nodes). (required; scripts read; format socketNode) |
| `position` | vec3 [x, y, z] | `[0,0,0]` | -10000 – 10000, step 0.05, m | **Offset.** The offset from the node, in the node's space. (scripts read) |
| `rotation` | quat | `[0,0,0,1]` |  | **Rotation offset.** The rotation from the node's (the Inspector shows degrees). (scripts read) |
| `scale` | vec3 [x, y, z] | `[1,1,1]` | 0.001 – 1000, step 0.05 | **Scale.** Scale relative to the node. (scripts read) |
| `attached` | bool | `true` |  | **Attached at start.** Rides on the node from the start (off: a script attaches it later with ctx.sockets.attach). (scripts read) |
