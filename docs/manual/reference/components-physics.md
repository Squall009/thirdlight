# Components: Physics

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Physics components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-collider"></a>
## collider — Collider

A solid shape the player stands on and bumps into (a box or a convex polygon in the X/Y plane; in a 3D project a box with a depth, a sphere, a capsule, a convex hull or a triangle mesh), placed anywhere in the object's frame; several shapes as a compound, or the convex parts of its model's _COL node.

- Category: Physics
- Added: from "+ Add component", starting as `{"shape":{"type":"box","hx":0.5,"hy":0.5}}`
- On prefab objects: yes
- Cannot share an object with [`terrain`](components-rendering.md#component-terrain): a terrain is its own level geometry
- Cannot share an object with [`socketAttach`](components-object.md#component-socketAttach): a socket poses the object every step; a physics body is posed by physics
- Cannot share an object with [`blockLayer`](components-rendering.md#component-blockLayer): a block layer is its own level geometry
- Cannot share an object with [`controller`](#component-controller): the player controller has its own capsule
- Cannot share an object with [`playerSpawn`](components-gameplay.md#component-playerSpawn): a player spawn is a marker
- Cannot share an object with [`instances`](components-rendering.md#component-instances): an instance set is scenery without its own body
- Cannot share an object with [`patrol`](components-gameplay.md#component-patrol): a patroller is not a physics body (give it a hitbox)
- Cannot share an object with [`gravity`](components-gameplay.md#component-gravity): a gravity body is not a physics body (give it a hitbox)
- Rule: A physics body (collider or controller) is at unit scale [1, 1, 1] on a 2D plane and rotated about Z only there (any axis and scale in a 3D one); the player controller and a mover are root objects and the controller stands upright; a collider on a child follows its parent.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `shape` | object |  |  | **Shape.** A box (half extents) or a convex polygon; in a 3D project also a sphere, a capsule, a convex hull or a triangle mesh; a compound of several; or the model's _COL parts. (required; scripts read; rules: A polygon is convex, counter-clockwise, has no repeated corner, an area of at least 1e-6 m² and stays within 64 m of the origin.; Sphere, capsule, convex hull and mesh are 3D shapes (physics_dimension 3); a mesh is static level geometry (not on a mover).; A model shape needs a model on the same object; a build makes one convex hull of each mesh part of its _COL node.) |
| `shape.type` | enum: `box`, `polygon`, `sphere`, `capsule`, `convex`, `mesh`, `compound`, `model` | `"box"` |  | **Shape.** Box or convex polygon (2D plane); box, sphere, capsule, convex hull or mesh (3D project); a compound of shapes; or the convex parts of the model's _COL node (read when the game is built). (required) |
| `shape.hx` | number | `0.5` | > 0, ≤ 1000000, step 0.05, m | **Half width.** Half the box width. (required; applies when `type` is `box`; Scene handle: box2) |
| `shape.hy` | number | `0.5` | > 0, ≤ 1000000, step 0.05, m | **Half height.** Half the box height. (required; applies when `type` is `box`; Scene handle: box2) |
| `shape.hz` | number |  | > 0, ≤ 1000000, step 0.05, m | **Half depth.** Half the box depth along Z (needed in a 3D project; a 2D plane ignores it). (applies when `type` is `box`; Scene handle: box2) |
| `shape.vertices` | list of vec2 [x, y], 3–8 items |  |  | **Vertices.** 3–8 corners [x, y], counter-clockwise, convex. (required; applies when `type` is `polygon`; Scene handle: polygon) |
| `shape.radius` | number | `0.5` | > 0, ≤ 64, step 0.05, m | **Radius.** The sphere's radius. (required; applies when `type` is `sphere`; Scene handle: radius) |
| `shape.radius` | number | `0.5` | > 0, ≤ 64, step 0.05, m | **Radius.** The capsule's radius. (required; applies when `type` is `capsule`; Scene handle: capsule) |
| `shape.height` | number | `2` | > 0, ≤ 128, step 0.05, m | **Height.** The capsule's total height along the object's Y (end caps included; at least twice the radius). (required; applies when `type` is `capsule`; Scene handle: capsule) |
| `shape.points` | list of vec3 [x, y, z], 4–64 items |  |  | **Hull points.** 4–64 points [x, y, z] whose convex hull is the shape (made from a model). (required; applies when `type` is `convex`; written by a tool) |
| `shape.vertices` | list of vec3 [x, y, z], 3–1024 items |  |  | **Mesh vertices.** 3–1024 vertices [x, y, z] (made from a model). (required; applies when `type` is `mesh`; written by a tool) |
| `shape.triangles` | list of vec3 [x, y, z], 1–2048 items |  |  | **Mesh triangles.** 1–2048 triangles [a, b, c] (vertex indices; made from a model). (required; applies when `type` is `mesh`; written by a tool) |
| `shape.center` | vec3 [x, y, z] |  | -64 – 64, step 0.05, m | **Center.** The shape's centre from the object origin (metres; a 2D plane reads x and y). (applies when `type` is `box` or `polygon` or `sphere` or `capsule` or `convex` or `mesh`) |
| `shape.rotation` | quat |  |  | **Rotation.** The shape's rotation in the object's frame (a unit quaternion; about Z only on a 2D plane; the Inspector shows degrees). (applies when `type` is `box` or `polygon` or `sphere` or `capsule` or `convex` or `mesh`) |
| `shape.shapes` | list of objects, ≥ 1 items |  |  | **Shapes.** The compound's shapes (one body), each with its own centre and rotation. (required; applies when `type` is `compound`) |
| `shape.shapes[].type` | enum: `box`, `polygon`, `sphere`, `capsule`, `convex`, `mesh` | `"box"` |  | **Shape.** Box or convex polygon (2D plane); box, sphere, capsule, convex hull or mesh (3D project). (required) |
| `shape.shapes[].hx` | number | `0.5` | > 0, ≤ 1000000, step 0.05, m | **Half width.** Half the box width. (required; applies when `type` is `box`; Scene handle: box2) |
| `shape.shapes[].hy` | number | `0.5` | > 0, ≤ 1000000, step 0.05, m | **Half height.** Half the box height. (required; applies when `type` is `box`; Scene handle: box2) |
| `shape.shapes[].hz` | number |  | > 0, ≤ 1000000, step 0.05, m | **Half depth.** Half the box depth along Z (needed in a 3D project; a 2D plane ignores it). (applies when `type` is `box`; Scene handle: box2) |
| `shape.shapes[].vertices` | list of vec2 [x, y], 3–8 items |  |  | **Vertices.** 3–8 corners [x, y], counter-clockwise, convex. (required; applies when `type` is `polygon`; Scene handle: polygon) |
| `shape.shapes[].radius` | number | `0.5` | > 0, ≤ 64, step 0.05, m | **Radius.** The sphere's radius. (required; applies when `type` is `sphere`; Scene handle: radius) |
| `shape.shapes[].radius` | number | `0.5` | > 0, ≤ 64, step 0.05, m | **Radius.** The capsule's radius. (required; applies when `type` is `capsule`; Scene handle: capsule) |
| `shape.shapes[].height` | number | `2` | > 0, ≤ 128, step 0.05, m | **Height.** The capsule's total height along the object's Y (end caps included; at least twice the radius). (required; applies when `type` is `capsule`; Scene handle: capsule) |
| `shape.shapes[].points` | list of vec3 [x, y, z], 4–64 items |  |  | **Hull points.** 4–64 points [x, y, z] whose convex hull is the shape (made from a model). (required; applies when `type` is `convex`; written by a tool) |
| `shape.shapes[].vertices` | list of vec3 [x, y, z], 3–1024 items |  |  | **Mesh vertices.** 3–1024 vertices [x, y, z] (made from a model). (required; applies when `type` is `mesh`; written by a tool) |
| `shape.shapes[].triangles` | list of vec3 [x, y, z], 1–2048 items |  |  | **Mesh triangles.** 1–2048 triangles [a, b, c] (vertex indices; made from a model). (required; applies when `type` is `mesh`; written by a tool) |
| `shape.shapes[].center` | vec3 [x, y, z] |  | -64 – 64, step 0.05, m | **Center.** The shape's centre from the object origin (metres; a 2D plane reads x and y). (applies when `type` is `box` or `polygon` or `sphere` or `capsule` or `convex` or `mesh`) |
| `shape.shapes[].rotation` | quat |  |  | **Rotation.** The shape's rotation in the object's frame (a unit quaternion; about Z only on a 2D plane; the Inspector shows degrees). (applies when `type` is `box` or `polygon` or `sphere` or `capsule` or `convex` or `mesh`) |
| `oneWay` | bool | `false` |  | **One-way.** The player can jump up through it and land on top (a platform). (stored only when not the default; scripts read) |
| `layers` | list of string, identifier, 1–32 chars, 1–16 items, distinct |  |  | **Collision layers.** The collision layers it is in (3D; absent: "default"). Script queries filter by layer; name layers in the project's collision layers. (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Box size | box2 | halfX → `shape/hx`, halfY → `shape/hy`, halfZ → `shape/hz` | local (follows rotationZ) | `shape/type` is `box` |
| Polygon | polygon | vertices → `shape/vertices` | local (follows rotationZ) | `shape/type` is `polygon` |
| Sphere radius | radius | radius → `shape/radius` | local (follows transform) | `shape/type` is `sphere` |
| Capsule | capsule | radius → `shape/radius`, height → `shape/height` | local (follows transform) | `shape/type` is `capsule` |

Presets:

- Box (2D): `{"shape":{"type":"box","hx":0.5,"hy":0.5}}`
- Polygon (2D): `{"shape":{"type":"polygon","vertices":[[-0.5,-0.5],[0.5,-0.5],[0,0.5]]}}`
- Box (3D) (3D): `{"shape":{"type":"box","hx":0.5,"hy":0.5,"hz":0.5}}`
- Sphere (3D): `{"shape":{"type":"sphere","radius":0.5}}`
- Capsule (3D): `{"shape":{"type":"capsule","radius":0.5,"height":2}}`
- Convex hull (3D): `{"shape":{"type":"convex","points":[[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5],[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]]}}`
- Mesh (3D): `{"shape":{"type":"mesh","vertices":[[-0.5,0,-0.5],[0.5,0,-0.5],[0.5,0,0.5],[-0.5,0,0.5]],"triangles":[[0,2,1],[0,3,2]]}}`
- Model's _COL parts (needs `model`): `{"shape":{"type":"model"}}`

GameObject menu: Gameplay → One-way platform (2D)

<a id="component-controller"></a>
## controller — Player controller

Makes this object the player: it runs, jumps and collides with a capsule.

- Category: Physics
- Added: from "+ Add component", starting as `{}`
- On prefab objects: no
- Cannot share an object with [`terrain`](components-rendering.md#component-terrain): a terrain is its own level geometry
- Cannot share an object with [`socketAttach`](components-object.md#component-socketAttach): a socket poses the object every step; the player is moved by its controller
- Cannot share an object with [`blockLayer`](components-rendering.md#component-blockLayer): a block layer is its own level geometry
- Cannot share an object with [`collider`](#component-collider): the player controller has its own capsule
- Cannot share an object with [`mover`](components-gameplay.md#component-mover): the player moves by input, not along waypoints
- Cannot share an object with [`playerSpawn`](components-gameplay.md#component-playerSpawn): the spawn marks where the player starts
- Cannot share an object with [`instances`](components-rendering.md#component-instances): an instance set is scenery
- Cannot share an object with [`collectible`](components-gameplay.md#component-collectible): the character collects; it is not collected
- Cannot share an object with [`patrol`](components-gameplay.md#component-patrol): the character moves by input, not by itself
- Cannot share an object with [`climbVolume`](components-gameplay.md#component-climbVolume): the character climbs in a climb volume; it is not one
- Cannot share an object with [`gravity`](components-gameplay.md#component-gravity): the character falls under its own controller
- Rule: A physics body (collider or controller) is at unit scale [1, 1, 1] on a 2D plane and rotated about Z only there (any axis and scale in a 3D one); the player controller and a mover are root objects and the controller stands upright; a collider on a child follows its parent.
- Rule: The steepest walkable slope is the project setting max_slope_climb_deg; run speed, jump speed and gravity are project settings too (a 3D character may override them).

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `capsule` | object |  |  | **Capsule.** The collision capsule (absent: 0.3 m radius, 1.8 m tall — an adult human). (scripts read; rules: height ≥ 2 × radius) |
| `capsule.radius` | number | `0.3` | 0.05 – 5, step 0.01, m | **Radius.** Half the capsule width. (required; Scene handle: capsule) |
| `capsule.height` | number | `1.8` | 0.1 – 20, step 0.01, m | **Height.** Total height, both end caps included. (required; Scene handle: capsule) |
| `capsule.offset` | vec3 [x, y, z] (last may be left out) | `[0,0]` | -5 – 5, step 0.01, m | **Offset.** The capsule centre from the object origin (z: in a 3D project). (Scene handle: capsule) |
| `acceleration` | number | `40` | 0.1 – 1000, step 1, m/s² | **Acceleration.** How fast it speeds up toward the run speed (40: a 4 m/s run in 0.1 s). (scripts read) |
| `deceleration` | number | `60` | 0.1 – 1000, step 1, m/s² | **Deceleration.** How fast it slows down when the input eases or stops. (scripts read) |
| `coyoteTime` | number | `0.05` | 0 – 1, step 0.01, s | **Coyote time.** A jump still starts this long after walking off an edge. (scripts read) |
| `jumpBuffer` | number | `0.06666666666666667` | 0 – 1, step 0.01, s | **Jump buffer.** A jump pressed this long before landing still happens on landing. (scripts read) |
| `jumpRelease` | number | `0.5` | 0 – 1, step 0.05, × | **Jump release.** Share of the upward speed kept when jump is released early (1: a fixed jump height). (scripts read) |
| `groundSnap` | number | `0.1` | 0 – 1, step 0.01, m | **Ground snap.** Pulls the character down onto ground this close below it (walking down slopes and bumps). (scripts read) |
| `skin` | number | `0.01` | 0.001 – 0.1, step 0.001, m | **Skin.** The small gap the character keeps from walls and floors. (scripts read) |
| `autostep` | bool | `false` |  | **Autostep.** Climb low steps without jumping. (2D projects only; scripts read) |
| `autostepHeight` | number | `0.25` | 0.01 – 2, step 0.01, m | **Step height.** The highest step it climbs. (applies when `autostep` is `true`; 2D projects only; scripts read) |
| `walkSpeed` | number | `2` | 0 – 50, step 0.1, m/s | **Walk speed.** Speed with the move input fully pushed (2: a brisk walk). (3D projects only; scripts read) |
| `runSpeed` | number |  | 0 – 50, step 0.1, m/s | **Run speed.** Speed while the "run" input action is held (absent: the project run speed setting). (3D projects only; scripts read) |
| `airControl` | number | `0.5` | 0 – 1, step 0.05, × | **Air control.** Share of the acceleration it has in the air (0: no steering mid-jump, 1: as on the ground). (3D projects only; scripts read) |
| `gravityScale` | number | `1` | 0 – 10, step 0.1, × | **Gravity scale.** Multiplies the project gravity for this character. (3D projects only; scripts read) |
| `turnSpeed` | number | `720` | 0 – 36000, step 10, deg/s | **Turn speed.** How fast it turns to face where it moves (0: at once). (3D projects only; scripts read) |
| `faceMovement` | bool | `true` |  | **Face movement.** Turn the object about its up axis to face the direction it moves (its +Z forward). (3D projects only; scripts read) |
| `moveFrame` | enum: `view`, `world` | `"view"` |  | **Move relative to.** What the move input is read against: the live camera's heading (up walks away from the camera; world axes while no camera is live) or the world axes (up pushes along −Z, right along +X). (3D projects only; scripts read; choices: `view` = Camera, `world` = World axes) |
| `jump` | bool | `true` |  | **Can jump.** The jump input makes it jump (off: a character that only walks). (3D projects only; scripts read) |
| `jumpSpeed` | number |  | 0 – 50, step 0.1, m/s | **Jump speed.** Upward speed at a jump (absent: the project jump velocity setting). (applies when `jump` is `true`; 3D projects only; scripts read) |
| `slopeLimit` | number |  | 1 – 89, step 1, deg | **Slope limit.** The steepest slope it walks up (absent: the project max_slope_climb_deg setting). (3D projects only; scripts read) |
| `stepHeight` | number | `0.3` | 0 – 1, step 0.01, m | **Step-up height.** Steps up to this height are climbed without a jump (0.3: a stair riser; 0: off). The ground snap is at least this, so it walks down them too. (3D projects only; Scene handle: height; scripts read) |
| `ledgeClimb` | bool | `false` |  | **Ledge climb.** Pushing against a ledge higher than a step pulls the character up onto it. (3D projects only; scripts read) |
| `ledgeHeight` | number | `1.2` | 0.1 – 5, step 0.05, m | **Ledge height.** The highest ledge it climbs (above its feet). (applies when `ledgeClimb` is `true`; 3D projects only; Scene handle: height; scripts read) |
| `ledgeClimbTime` | number | `0.6` | 0.05 – 5, step 0.05, s | **Climb time.** How long a ledge climb takes. (applies when `ledgeClimb` is `true`; 3D projects only; scripts read) |
| `moveAction` | string, identifier, 1–32 chars | `"move"` |  | **Move action.** The input action (an axis) that moves it. (scripts read; format identifier) |
| `jumpAction` | string, identifier, 1–32 chars | `"jump"` |  | **Jump action.** The input action (a button) that makes it jump. (scripts read; format identifier) |
| `runAction` | string, identifier, 1–32 chars | `"run"` |  | **Run action.** The input action (a button) that makes it run while held. (3D projects only; scripts read; format identifier) |
| `climbSpeed` | number | `2` | 0.1 – 50, step 0.1, m/s | **Climb speed.** How fast it moves inside a climb volume (up/down along it, sideways across it; jump leaves). (scripts read) |
| `climbAction` | string, identifier, 1–32 chars |  |  | **Climb action.** The input action (an axis) that climbs: its value, or a 2D axis' up/down (absent: the move action's up/down — a 2D project whose move is left/right only names another action here). (scripts read; format identifier) |
| `wallSlide` | bool | `false` |  | **Wall slide.** Falling while pushing into a wall, it slides down no faster than the wall slide speed. (scripts read) |
| `wallSlideSpeed` | number | `2` | 0 – 50, step 0.1, m/s | **Wall slide speed.** The fastest it slides down a wall. (applies when `wallSlide` is `true`; scripts read) |
| `wallJump` | bool | `false` |  | **Wall jump.** In the air, jump pushes it off a wall it touches (away from the wall and up). (scripts read) |
| `wallJumpAway` | number |  | 0 – 50, step 0.1, m/s | **Wall jump away.** Speed away from the wall at a wall jump (absent: its run speed). (applies when `wallJump` is `true`; scripts read) |
| `wallJumpUp` | number |  | 0 – 50, step 0.1, m/s | **Wall jump up.** Upward speed at a wall jump (absent: its jump speed). (applies when `wallJump` is `true`; scripts read) |
| `wallJumpLock` | number |  | 0 – 5, step 0.05, s | **Wall jump lock.** How long after a wall jump the input does not steer (absent: until the top of the jump; 0: steers at once; a landing always ends it). (applies when `wallJump` is `true`; scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Capsule | capsule | radius → `capsule/radius`, height → `capsule/height`, offset → `capsule/offset` | local |  |
| Step-up height | height | height → `stepHeight` | local | 3D |
| Ledge height | height | height → `ledgeHeight` | local | `ledgeClimb` is `true`; 3D |
