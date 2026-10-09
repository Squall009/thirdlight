# Components: Gameplay

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Gameplay components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-playerSpawn"></a>
## playerSpawn — Player spawn

Where the player starts (a level names its spawn).

- Category: Gameplay
- Added: from "+ Add component", starting as `{}`
- On prefab objects: no
- Cannot share an object with [`collider`](components-physics.md#component-collider): a player spawn is a marker
- Cannot share an object with [`controller`](components-physics.md#component-controller): the spawn marks where the player starts
- Cannot share an object with [`instances`](components-rendering.md#component-instances): an instance set is scenery
- Icon: spawn
- Rule: A zone or player spawn is a root object at unit scale with no rotation.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `yaw` | number |  | -360 – 360, step 5, deg | **Yaw.** The way the character faces on arrival, degrees about +Y (0: facing +Z; absent: as it was). (scripts read) |

GameObject menu: Spawn point

<a id="component-mover"></a>
## mover — Mover

Moves the object along waypoints (a moving platform, a door); with a collider it carries the player.

- Category: Gameplay
- Added: from "+ Add component", starting as `{"waypoints":[[4,0,0]],"speed":2,"mode":"pingpong","wait":0.5}`
- On prefab objects: yes
- Cannot share an object with [`controller`](components-physics.md#component-controller): the player moves by input, not along waypoints
- Cannot share an object with [`socketAttach`](components-object.md#component-socketAttach): a socket poses the object every step; a mover follows its waypoints
- Cannot share an object with [`patrol`](#component-patrol): a mover and a patrol would both move it
- Cannot share an object with [`gravity`](#component-gravity): a mover sets its position itself
- Icon: mover
- Rule: startOn, stopOn and toggleOn name different signals.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `waypoints` | list of vec3 [x, y, z], 1–16 items | `[[4,0,0]]` |  | **Waypoints.** 1–16 points, as offsets from where the object is placed (the start is not listed). (required; Scene handle: path; scripts read) |
| `speed` | number | `2` | 0.01 – 50, step 0.1, m/s | **Speed.** Travel speed. (required; scripts read and write) |
| `mode` | enum: `loop`, `pingpong`, `once` | `"pingpong"` |  | **Mode.** Loop back to the start, go back and forth, or move once. (required; scripts read; choices: `loop` = Loop, `pingpong` = Back and forth, `once` = Once) |
| `wait` | number | `0` | 0 – 60, step 0.1, s | **Wait.** Pause at each point. (scripts read) |
| `easing` | enum: `linear`, `smooth`, `gravity` | `"linear"` |  | **Easing.** Constant speed, smooth starts and stops, or gravity: from rest at each point, speeding up evenly until the next (each stretch takes as long as at its speed). (scripts read) |
| `startOn` | signal name |  |  | **Start on signal.** Wait for this signal before moving (absent: moves from the start). (scripts read) |
| `maxPush` | number | `60` | 1 – 1000, step 1, m/s | **Max push.** The fastest it shoves a player out of its way (a safety limit that keeps the player out of the platform). (scripts read) |
| `active` | bool | `true` |  | **Moving.** Off: it holds where it is (still solid) until a script, its start signal or its toggle signal moves it. (stored only when not the default; scripts read and write) |
| `stopOn` | signal name |  |  | **Stop on signal.** This signal holds it where it is (still solid); its start or toggle signal moves it again. (scripts read) |
| `toggleOn` | signal name |  |  | **Toggle on signal.** This signal moves it if it is held, and holds it if it moves. (scripts read) |
| `reverseOn` | signal name |  |  | **Reverse on signal.** This signal turns it around, back the way it came (a finished once-mover goes back to its start). (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Waypoints | path | points → `waypoints` | local |  |

GameObject menu: Gameplay → Moving platform (2D), Gameplay → Moving platform (3D), Gameplay → Door (opens on "open") (2D), Gameplay → Door (opens on "open") (3D)

<a id="component-trigger"></a>
## trigger — Trigger

Sends a signal when the player enters an area (a box or a circle; in a 3D project a box with a depth, a sphere or a capsule).

- Category: Gameplay
- Added: from "+ Add component", starting as `{"size":[2,2],"signal":"trigger"}`
- On prefab objects: yes
- Icon: sensor

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `shape` | enum: `box`, `circle`, `sphere`, `capsule` | `"box"` |  | **Shape.** Box or circle (2D plane); box, sphere or capsule (3D project). (scripts read) |
| `size` | vec3 [w, h, d] (last may be left out) | `[2,2]` | 0.05 – 500, step 0.1, m | **Size.** Width and height of the box (and its depth in a 3D project). (required; applies when `shape` is `box`; Scene handle: box2; scripts read) |
| `radius` | number | `1` | 0.025 – 250, step 0.05, m | **Radius.** Radius of the circle or sphere. (required; applies when `shape` is `circle` or `sphere`; Scene handle: radius; scripts read) |
| `radius` | number | `0.5` | 0.025 – 250, step 0.05, m | **Radius.** Radius of the capsule. (required; applies when `shape` is `capsule`; Scene handle: capsule; scripts read) |
| `height` | number | `2` | 0.05 – 500, step 0.05, m | **Height.** The capsule's total height along the object's Y (end caps included; at least twice the radius). (required; applies when `shape` is `capsule`; Scene handle: capsule; scripts read) |
| `signal` | signal name | `"trigger"` |  | **Signal.** Sent when the player enters. (required; scripts read) |
| `exitSignal` | signal name |  |  | **Exit signal.** Sent when the player leaves (absent: none). (scripts read) |
| `mode` | enum: `enter`, `stay` | `"enter"` |  | **Mode.** Enter: once per entry. Stay: every step while inside. (scripts read) |
| `once` | bool | `false` |  | **Once.** Only the first time. (scripts read) |
| `sceneTransition` | object |  |  | **Scene transition.** Entering loads a scene and moves the character to a spawn in it (absent: no transition). (scripts read) |
| `sceneTransition.scene` | scene id |  |  | **Load scene.** The scene loaded when the character enters. (required) |
| `sceneTransition.spawn` | object id (with `playerSpawn`), any scene |  |  | **Arrive at.** The player spawn the character is moved to once the scene is loaded (in that scene or this one; absent: it stays where it is). |
| `sceneTransition.unload` | list of scene id, ≤ 16 items, distinct |  |  | **Unload scenes.** Scenes unloaded once the loaded scene is in (they stay in view until then). |
| `sceneTransition.fade` | number |  | 0 – 5, step 0.05 | **Fade.** Seconds the view fades out before the swap and back in after it (absent or 0: no fade; the old scene stays in view until the new one is drawn). |
| `sceneTransition.fadeColor` | color |  |  | **Fade colour.** The colour the view fades to (absent: black). |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box2 | size → `size` | local | `shape` is `box` |
| Radius | radius | radius → `radius` | local | `shape` is `circle` |
| Sphere radius | radius | radius → `radius` | local (follows rotation) | `shape` is `sphere` |
| Capsule | capsule | radius → `radius`, height → `height` | local (follows rotation) | `shape` is `capsule` |

Presets:

- Box (3D) (3D): `{"size":[2,2,2],"signal":"trigger"}`
- Sphere (3D): `{"shape":"sphere","radius":1,"signal":"trigger"}`
- Capsule (3D): `{"shape":"capsule","radius":0.5,"height":2,"signal":"trigger"}`

GameObject menu: Gameplay → Trigger (2D), Gameplay → Trigger (3D), Gameplay → Scene transition (2D), Gameplay → Scene transition (3D)

<a id="component-switch"></a>
## switch — Switch

A lever or button (interact) or a pressure plate (stand) that sends a signal.

- Category: Gameplay
- Added: from "+ Add component", starting as `{"mode":"interact","signal":"open","size":[1,1]}`
- On prefab objects: yes
- Icon: switch

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `mode` | enum: `interact`, `stand` | `"interact"` |  | **Mode.** Interact: press its action nearby. Stand: step on it. (required; scripts read) |
| `signal` | signal name | `"open"` |  | **Signal.** Sent when used. (required; scripts read) |
| `size` | vec2 [w, h] | `[1,1]` | 0.05 – 100, step 0.1, m | **Size.** The area the player must be in. (required; Scene handle: box2; scripts read) |
| `once` | bool | `false` |  | **Once.** Only the first time. (scripts read) |
| `action` | string, identifier, 1–32 chars | `"interact"` |  | **Action.** The input action pressed nearby to use it. (applies when `mode` is `interact`; scripts read; format identifier) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box2 | size → `size` | local |  |

GameObject menu: Gameplay → Switch (2D)

<a id="component-health"></a>
## health — Health

The object's health (any object): scripts damage and heal it and hear when it is damaged or reaches 0; a hitbox with damage takes some on contact.

- Category: Gameplay
- Added: from "+ Add component", starting as `{"max":3}`
- On prefab objects: yes
- Icon: health
- Rule: start ≤ max

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `max` | int | `3` | 1 – 1000, step 1 | **Maximum.** The most health it can have. (required; scripts read) |
| `start` | int |  | 1 – 1000, step 1 | **Start.** Health at the start of a run (absent: the maximum). (scripts read) |

GameObject menu: Gameplay → Object with health

<a id="component-collectible"></a>
## collectible — Collectible

The character touching it adds an amount to a named counter; it hides, sends a signal and may come back after a while.

- Category: Gameplay
- Added: from "+ Add component", starting as `{"counter":"items"}`
- On prefab objects: yes
- Cannot share an object with [`controller`](components-physics.md#component-controller): the character collects; it is not collected
- Icon: collectible

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `counter` | string, counter, 1–32 chars | `"items"` |  | **Counter.** The counter it adds to (any name: a letter or _, then letters, digits or _). (required; scripts read; format counter) |
| `amount` | number | `1` | -1000000 – 1000000, step 1 | **Amount.** Added to the counter when collected (negative takes away). (scripts read) |
| `size` | vec3 [w, h, d] (last may be left out) | `[1,1,1]` | 0.05 – 500, step 0.05, m | **Size.** The area that collects it: width, height (and depth in a 3D project; absent: the width). (Scene handle: box2; scripts read) |
| `onCollect` | signal name |  |  | **On collect.** A signal sent when it is collected (absent: none). (scripts read) |
| `respawn` | number | `0` | 0 – 3600, step 0.5, s | **Comes back after.** Seconds until it comes back after being collected (0: never). (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box2 | size → `size` | local |  |

GameObject menu: Gameplay → Collectible

<a id="component-patrol"></a>
## patrol — Patrol

Walks by itself: along waypoints, or straight ahead turning around at walls and ledges.

- Category: Gameplay
- Added: from "+ Add component", starting as `{"mode":"edges","speed":1.5}`
- On prefab objects: yes
- Cannot share an object with [`controller`](components-physics.md#component-controller): the character moves by input, not by itself
- Cannot share an object with [`mover`](#component-mover): a mover and a patrol would both move it
- Cannot share an object with [`collider`](components-physics.md#component-collider): a patroller is not a physics body (give it a hitbox)
- Icon: patrol

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `mode` | enum: `waypoints`, `edges` | `"edges"` |  | **Mode.** Waypoints: along points placed from where it starts. Edges: straight ahead, turning at a wall or a ledge. (required; scripts read; choices: `waypoints` = Waypoints, `edges` = Edge to edge) |
| `waypoints` | list of vec3 [x, y, z], 1–16 items | `[[4,0,0]]` |  | **Waypoints.** 1–16 points, as offsets from where the object is placed (the start is not listed). (required; applies when `mode` is `waypoints`; Scene handle: path; scripts read) |
| `loop` | bool | `false` |  | **Loop.** From the last point straight back to the start (off: back and forth). (applies when `mode` is `waypoints`; scripts read) |
| `speed` | number | `1.5` | 0 – 50, step 0.1, m/s | **Speed.** Walking speed. (required; scripts read) |
| `wait` | number | `0` | 0 – 60, step 0.1, s | **Wait.** Pause at each waypoint, or after turning around. (scripts read) |
| `direction` | vec3 [x, y, z] | `[1,0,0]` | -1 – 1, step 0.1, not 0 | **Start direction.** The way it starts walking (the 2D plane: any direction in the plane — with a y part it moves up or down and does not look for ledges; a 3D project: the direction along the ground). (applies when `mode` is `edges`; Scene handle: direction; scripts read) |
| `size` | vec3 [w, h, d] (last may be left out) | `[1,1,1]` | 0.05 – 500, step 0.05, m | **Body.** Its body, centred on its position: width, height (and depth in 3D); the probes look from its front and underside. (applies when `mode` is `edges`; Scene handle: box2; scripts read) |
| `wallProbe` | number | `0.05` | 0 – 5, step 0.01, m | **Wall probe.** How far past its front it looks for a wall to turn at. (applies when `mode` is `edges`; scripts read) |
| `ledgeProbe` | number | `0.4` | 0.1 – 20, step 0.05, m | **Ledge probe.** How far down, from 0.1 m above its underside, it looks for floor just past its front (0.4: a drop deeper than 0.3 m is a ledge). (applies when `mode` is `edges`; scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Waypoints | path | points → `waypoints` | local | `mode` is `waypoints` |
| Body | box2 | size → `size` | local | `mode` is `edges` |
| Start direction | direction | direction → `direction` | local | `mode` is `edges` |

Presets:

- Edge to edge: `{"mode":"edges","speed":1.5}`
- Waypoints: `{"mode":"waypoints","waypoints":[[4,0,0]],"speed":1.5}`

GameObject menu: Gameplay → Patrolling object

<a id="component-hitbox"></a>
## hitbox — Hitbox

An area whose contacts with other hitboxes and the character are events for scripts (the other object and the contact normal); may take health on contact.

- Category: Gameplay
- Added: from "+ Add component", starting as `{"size":[1,1]}`
- On prefab objects: yes
- Icon: hitbox

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `shape` | enum: `box`, `sphere` | `"box"` |  | **Shape.** A box, or a sphere (a circle on the 2D plane). (scripts read) |
| `size` | vec3 [w, h, d] (last may be left out) | `[1,1]` | 0.05 – 500, step 0.05, m | **Size.** Width, height (and depth in a 3D project; absent: the width). (required; applies when `shape` is `box`; Scene handle: box2; scripts read) |
| `radius` | number | `0.5` | 0.025 – 250, step 0.05, m | **Radius.** Radius of the sphere (or circle). (required; applies when `shape` is `sphere`; Scene handle: radius; scripts read) |
| `damage` | int | `0` | 0 – 1000, step 1 | **Damage.** Health a new contact takes from the other object (its own health, or its nearest parent's; 0: none). (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box2 | size → `size` | local | `shape` is `box` |
| Radius | radius | radius → `radius` | local | `shape` is `sphere` |

Presets:

- Box (2D): `{"size":[1,1]}`
- Box (3D): `{"size":[1,1,1]}`
- Sphere: `{"shape":"sphere","radius":0.5}`

GameObject menu: Gameplay → Hitbox (2D), Gameplay → Hitbox (3D)

<a id="component-climbVolume"></a>
## climbVolume — Climb volume

A box the character climbs in (a ladder, a vine, a net, a climbing wall): up/down moves it along the box's up axis, sideways across it, at its climb speed and without gravity; jump or moving out leaves.

- Category: Gameplay
- Added: from "+ Add component", starting as `{"size":[1,4]}`
- On prefab objects: yes
- Cannot share an object with [`controller`](components-physics.md#component-controller): the character climbs in a climb volume; it is not one
- Icon: sensor

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `size` | vec3 [w, h, d] (last may be left out) | `[1,4]` | 0.05 – 500, step 0.05, m | **Size.** Width, height (and depth in a 3D project; absent: the width), centred on the object and turned with it. (required; Scene handle: box2; scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box2 | size → `size` | local (follows rotation) |  |

GameObject menu: Gameplay → Climb volume (2D), Gameplay → Climb volume (3D)

<a id="component-gravity"></a>
## gravity — Gravity

The object (not a character: a patroller, an item) falls under the project's gravity until its body rests on a collider below it, and falls again when the floor goes.

- Category: Gameplay
- Added: from "+ Add component", starting as `{}`
- On prefab objects: yes
- Cannot share an object with [`controller`](components-physics.md#component-controller): the character falls under its own controller
- Cannot share an object with [`mover`](#component-mover): a mover sets its position itself
- Cannot share an object with [`collider`](components-physics.md#component-collider): a gravity body is not a physics body (give it a hitbox)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `scale` | number | `1` | 0 – 10, step 0.1, × | **Scale.** Multiplies the project gravity (0: it does not fall). (scripts read) |
| `size` | vec3 [w, h, d] (last may be left out) | `[1,1,1]` | 0.05 – 500, step 0.05, m | **Body.** Its body, centred on its position: width, height (and depth in 3D); its underside rests on the floor. (Scene handle: box2; scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Body | box2 | size → `size` | local |  |

<a id="component-blockFootprint"></a>
## blockFootprint — Block footprint

The cell metadata this object writes into the block-layer cells beneath it when it is placed or moved (a house marks its cells blocked).

- Category: Gameplay
- Added: from "+ Add component", starting as `{"set":{}}`
- On prefab objects: yes
- Rule: The cells are written when the object is placed or moved in the editor (one metadata edit of the layer); moving it clears the fields it wrote where it stood.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `layer` | object id (with `blockLayer`) |  |  | **Layer.** The block layer written (none: every layer under the object). (scripts read) |
| `size` | vec2 [x, z] | `[1,1]` | 1 – 64, step 1 | **Size.** Cells along x and z, centred on the object and turned with its quarter turns. (scripts read) |
| `set` | JSON |  |  | **Metadata.** The metadata the cells take: field key → value (fields of the project's cell schema). (required; scripts read) |
