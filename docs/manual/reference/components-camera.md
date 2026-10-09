# Components: Camera

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Camera components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-virtualCamera"></a>
## virtualCamera — Virtual camera

A camera shot the game cuts or blends to: follow/orbit a target, orbit a point in snapped turns, top-down, fixed/look-at, along a rail, or track a target with a dead zone and bounds. The live one is the enabled camera with the highest priority (on a tie the one activated last); it is what the game shows (without one the view holds a default pose and Play warns).

- Category: Camera
- Added: from "+ Add component", starting as `{"rig":"follow"}`
- On prefab objects: no
- Icon: camera
- Rule: pitchMin ≤ pitchMax, minDistance ≤ maxDistance and near < far when both are set

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `rig` | enum: `follow`, `orbitPoint`, `topDown`, `fixed`, `rail`, `track` | `"follow"` |  | **Rig.** How the camera moves: follow/orbit a target, orbit a point, straight down onto the target, fixed where it is placed, along a camera path, or track a target without turning (dead zone, bounds). (required; scripts read; choices: `follow` = Follow / orbit, `orbitPoint` = Orbit a point, `topDown` = Top-down, `fixed` = Fixed / look-at, `rail` = Rail (path), `track` = Track (dead zone)) |
| `priority` | int | `0` | -1000 – 1000, step 1 | **Priority.** The enabled camera with the highest priority is live (on a tie: the one activated last, then the first in the scene). (scripts read) |
| `enabled` | bool | `true` |  | **Enabled at start.** Takes part from the start; scripts activate and deactivate cameras (ctx.camera). (scripts read) |
| `target` | object id, any scene |  |  | **Target.** The object it follows, circles or looks at (none: the rig centres on where the camera is placed; fixed and rail cameras look ahead). (scripts read) |
| `targetOffset` | vec3 [x, y, z] | `[0,0,0]` | -1000 – 1000, step 0.1, m | **Target offset.** Added to the target's position (e.g. a character's head height). (scripts read) |
| `distance` | number | `5` | 0.1 – 10000, step 0.5, m | **Distance.** How far from the target (or point) it sits; top-down: the height above it. (applies when `rig` is `follow` or `orbitPoint` or `topDown`; scripts read) |
| `minDistance` | number | `0.5` | 0 – 10000, step 0.1, m | **Min distance.** The closest it zooms, and the closest a wall pulls it in. (applies when `rig` is `follow` or `orbitPoint`; scripts read) |
| `maxDistance` | number | `100` | 0.1 – 10000, step 1, m | **Max distance.** The farthest it zooms out. (applies when `rig` is `follow` or `orbitPoint`; scripts read) |
| `yaw` | number | `0` | -360 – 360, step 5, deg | **Yaw.** The heading around the target (0: on its +Z side looking toward −Z). (applies when `rig` is `follow` or `orbitPoint` or `topDown`; scripts read) |
| `pitch` | number | `20` | -89 – 90, step 1, deg | **Pitch.** How far above the target it looks down (negative: from below). (applies when `rig` is `follow` or `orbitPoint`; scripts read) |
| `pitchMin` | number | `-30` | -89 – 90, step 1, deg | **Pitch min.** The lowest a player tilts it. (applies when `rig` is `follow` or `orbitPoint`; scripts read) |
| `pitchMax` | number | `80` | -89 – 90, step 1, deg | **Pitch max.** The highest a player tilts it. (applies when `rig` is `follow` or `orbitPoint`; scripts read) |
| `yawAction` | string, identifier, 1–32 chars |  |  | **Turn action.** An input action (axis) that turns it around the target (a 2D axis: x turns, y tilts). (applies when `rig` is `follow`; scripts read; format identifier) |
| `pitchAction` | string, identifier, 1–32 chars |  |  | **Tilt action.** An input action (axis) that tilts it. (applies when `rig` is `follow` or `orbitPoint`; scripts read; format identifier) |
| `rotateSpeed` | number | `120` | 0 – 1440, step 10, deg | **Turn speed.** Turning and tilting speed at full input (degrees per second). (applies when `rig` is `follow` or `orbitPoint`; scripts read) |
| `zoomAction` | string, identifier, 1–32 chars |  |  | **Zoom action.** An input action (axis) that moves it closer (negative) or farther (positive). (applies when `rig` is `follow` or `orbitPoint`; scripts read; format identifier) |
| `zoomSpeed` | number | `10` | 0 – 1000, step 1, m/s | **Zoom speed.** Zoom speed at full input. (applies when `rig` is `follow` or `orbitPoint`; scripts read) |
| `turnLeftAction` | string, identifier, 1–32 chars |  |  | **Turn left action.** An input action (button): each press turns one step to the left. (applies when `rig` is `orbitPoint`; scripts read; format identifier) |
| `turnRightAction` | string, identifier, 1–32 chars |  |  | **Turn right action.** An input action (button): each press turns one step to the right. (applies when `rig` is `orbitPoint`; scripts read; format identifier) |
| `yawStep` | number | `90` | 1 – 180, step 5, deg | **Turn step.** How far one press turns (the yaw snaps to whole steps). (applies when `rig` is `orbitPoint`; scripts read) |
| `turnTime` | number | `0.25` | 0 – 10, step 0.05, s | **Turn time.** How long a snapped turn takes (0: at once). (applies when `rig` is `orbitPoint`; scripts read) |
| `point` | vec3 [x, y, z] |  | -1000000 – 1000000, step 0.5, m | **Point.** The world point it circles (absent: the target, else where the camera is placed). (applies when `rig` is `orbitPoint`; Scene handle: point; scripts read) |
| `collision` | bool | `true` |  | **Collision.** Pulled in front of colliders between it and the target (3D projects). (applies when `rig` is `follow`; scripts read) |
| `collisionRadius` | number | `0.2` | 0 – 5, step 0.05, m | **Collision radius.** The clearance it keeps from what it is pulled in by. (applies when `rig` is `follow`; scripts read) |
| `trackOffset` | vec3 [x, y, z] |  | -1000 – 1000, step 0.5, m | **Offset.** Where the camera sits relative to the point it frames (absent: where it is placed relative to the target at the start). (applies when `rig` is `track`; scripts read) |
| `deadZone` | vec3 [w, h, d] | `[0,0,0]` | 0 – 1000, step 0.1, m | **Dead zone.** The box (width, height, depth) around the framed point the target moves in before the camera follows (0: always follows). (applies when `rig` is `track`; Scene handle: box3; scripts read) |
| `boundsMin` | vec3 [x, y, z] |  | -1000000 – 1000000, step 0.5, m | **Bounds min.** The framed point never goes below this on any axis (absent: no limit). (applies when `rig` is `track`; Scene handle: bounds; scripts read) |
| `boundsMax` | vec3 [x, y, z] |  | -1000000 – 1000000, step 0.5, m | **Bounds max.** The framed point never goes above this on any axis (absent: no limit). (applies when `rig` is `track`; Scene handle: bounds; scripts read) |
| `lookAhead` | vec3 [x, y, z] | `[0,0,0]` | 0 – 10, step 0.05, s | **Look-ahead.** Frames this many seconds of the target's movement ahead of it, per axis (0: none; a vertical look-ahead [0, t, 0] shows the ground below a fall). (applies when `rig` is `track`; scripts read) |
| `lookAheadMax` | vec3 [x, y, z] | `[3,3,3]` | 0 – 1000, step 0.5, m | **Look-ahead max.** The farthest it looks ahead, per axis. (applies when `rig` is `track`; scripts read) |
| `lookAheadSmoothing` | number | `0.2` | 0 – 10, step 0.05, s | **Look-ahead smoothing.** How long a change of the target's speed takes to show in the look-ahead (0: at once). (applies when `rig` is `track`; scripts read) |
| `damping` | number | `0` | 0 – 10, step 0.05, s | **Damping.** How long it lags behind a moving target (0: rigid; the track rig's smoothing). (applies when `rig` is `follow` or `orbitPoint` or `topDown` or `track`; scripts read) |
| `path` | object id (with `cameraPath`), any scene |  |  | **Path.** The object carrying the camera path it rides (none: it stays where it is placed). (applies when `rig` is `rail`; scripts read) |
| `progress` | number | `0` | 0 – 1, step 0.01 | **Progress.** Where along the path it starts (0: the first point, 1: the end). (applies when `rig` is `rail`; scripts read) |
| `railSpeed` | number | `0` | -1000 – 1000, step 0.5, m/s | **Rail speed.** How fast it rides the path (negative: backwards; 0: stays until a script moves it). (applies when `rig` is `rail`; scripts read) |
| `railMode` | enum: `once`, `loop`, `pingpong` | `"once"` |  | **At the end.** Stop at the end, loop to the start, or ride back and forth. (applies when `rig` is `rail`; scripts read; choices: `once` = Stop, `loop` = Loop, `pingpong` = Back and forth) |
| `fovY` | number |  | 1 – 179, step 1, deg | **Field of view.** Vertical field of view (absent: the project's camera setting). (scripts read) |
| `near` | number |  | 0.001 – 100000, step 0.01, m | **Near.** The near clipping plane (absent: the project's camera setting). (scripts read) |
| `far` | number |  | 0.01 – 10000000, step 10, m | **Far.** The far clipping plane (absent: the project's camera setting). (scripts read) |
| `blend` | enum: `cut`, `linear`, `eased` | `"eased"` |  | **Blend in.** How the view moves to this camera when it goes live: a cut, a constant-speed move or an eased move. (scripts read) |
| `blendTime` | number | `0.5` | 0 – 30, step 0.1, s | **Blend time.** How long the move to this camera takes. (applies when `blend` is `linear` or `eased`; scripts read) |
| `letterbox` | number | `0` | 0 – 0.5, step 0.01 | **Letterbox.** Black bars over the top and bottom while it is live (each a share of the view height). (scripts read) |
| `shakeAmplitude` | number | `0` | 0 – 10, step 0.01, m | **Shake.** A constant shake while it is live (0: none). (scripts read) |
| `shakeFrequency` | number | `8` | 0.1 – 60, step 0.5, Hz | **Shake frequency.** How fast it shakes. (scripts read) |
| `shakeRotation` | number | `0` | 0 – 45, step 0.5, deg | **Shake rotation.** How much the shake also turns it. (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Orbit point | point | point → `point` | world | `rig` is `orbitPoint` |
| Dead zone | box3 | size → `deadZone` | local | `rig` is `track` |
| Bounds | bounds | min → `boundsMin`, max → `boundsMax` | world | `rig` is `track` |

Presets:

- Follow / orbit: `{"rig":"follow"}`
- Orbit a point (snapped turns): `{"rig":"orbitPoint","distance":15,"pitch":45}`
- Top-down: `{"rig":"topDown","distance":15}`
- Fixed / look-at: `{"rig":"fixed"}`
- Track (dead zone): `{"rig":"track","deadZone":[2,1,2],"damping":0.2}`

GameObject menu: Cameras → Camera, Cameras → Camera track

<a id="component-cameraPath"></a>
## cameraPath — Camera path

A path rail cameras ride (points as offsets from where this object is placed).

- Category: Camera
- Added: from "+ Add component", starting as `{"points":[[0,0,0],[6,0,0]]}`
- On prefab objects: no

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `points` | list of vec3 [x, y, z], 2–64 items | `[[0,0,0],[6,0,0]]` |  | **Points.** 2–64 points, as offsets from where the object is placed. (required; Scene handle: path; scripts read) |
| `closed` | bool | `false` |  | **Closed.** The path runs back from the last point to the first. (scripts read) |
| `smooth` | bool | `true` |  | **Smooth.** A smooth curve through the points (off: straight segments). (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Path | path | points → `points` | local |  |

<a id="component-cameraRegion"></a>
## cameraRegion — Camera region

While a track camera's target is inside this box, the camera uses the region's dead zone, bounds and distance (each absent: the camera's own); entering or leaving blends between them. A room, a corridor, an arena, a vista: any place that frames differently.

- Category: Camera
- Added: from "+ Add component", starting as `{"size":[10,6]}`
- On prefab objects: no
- Icon: camera

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `size` | vec3 [w, h, d] (last may be left out) | `[10,6]` | 0.05 – 100000, step 0.5, m | **Size.** Width, height (and depth; absent: every depth), centred on the object along the world axes (its rotation is not used). (required; Scene handle: box2; scripts read) |
| `camera` | object id (with `virtualCamera`), any scene |  |  | **Camera.** The track camera it applies to (none: every track camera). (scripts read) |
| `priority` | int | `0` | -1000 – 1000, step 1 | **Priority.** Where regions overlap the highest wins (on a tie: the one entered last). (scripts read) |
| `deadZone` | vec3 [w, h, d] |  | 0 – 1000, step 0.1, m | **Dead zone.** The camera's dead zone in here (absent: its own). (Scene handle: box3; scripts read) |
| `boundsMin` | vec3 [x, y, z] |  | -1000000 – 1000000, step 0.5, m | **Bounds min.** The framed point stays at or above this in here, from the region's position (absent: the camera's own). (Scene handle: bounds; scripts read) |
| `boundsMax` | vec3 [x, y, z] |  | -1000000 – 1000000, step 0.5, m | **Bounds max.** The framed point stays at or below this in here, from the region's position (absent: the camera's own). (Scene handle: bounds; scripts read) |
| `distance` | number |  | 0.1 – 10000, step 0.5, m | **Distance.** The camera's distance from the framed point in here, along its offset (absent: its own offset). (scripts read) |
| `blendTime` | number | `0.5` | 0 – 30, step 0.1, s | **Blend time.** How long entering or leaving blends the camera to its new framing (0: at once). (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Size | box2 | size → `size` | local (follows position) |  |
| Bounds | bounds | min → `boundsMin`, max → `boundsMax` | local |  |
| Dead zone | box3 | size → `deadZone` | local |  |

GameObject menu: Cameras → Camera region (2D), Cameras → Camera region (3D)
