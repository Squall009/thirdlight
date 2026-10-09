# Components: Animation

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Animation components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-animator"></a>
## animator — Animator

Plays the model's animations with an animator controller (a state machine).

- Category: Animation
- Added: from "+ Add component" after picking `controller` (the rest starts as `{}`)
- On prefab objects: yes
- Needs one of [`model`](components-rendering.md#component-model) on the same object: an animator plays the object's model

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `controller` | animator id |  |  | **Controller.** The animator controller. (required; scripts read) |
| `parameters` | map animatorParameter id → JSON (typed by animatorParameter), ≤ 32 entries |  |  | **Parameters.** Starting values for the controller's parameters (absent: the controller's defaults). (scripts read) |
| `startTime` | number |  | 0 – 1, step 0.05 | **Start time.** Where the entry states start, in normalized time (0–1 of their length). (applies when `randomStart` is `false`; scripts read) |
| `randomStart` | bool | `false` |  | **Random start.** Start at a random time from the game's seeded random numbers (the project's random seed and this object's id), so copies do not move in step and a replay starts them alike. (scripts read) |
| `lookAt` | object |  |  | **Look at.** Turns the head (and the neck and chest) toward a target after the clips pose them; scripts set the target and the weight (ctx.animator(id)?.setLookTarget / setLookWeight). (scripts read) |
| `lookAt.head` | object |  |  | **Head.** The head bone: it ends facing the target (within the limits). (required) |
| `lookAt.head.bone` | string, ownBone, 1–128 chars |  |  | **Bone.** A bone (node) of this object's model (the list shows its nodes). (required; format ownBone) |
| `lookAt.head.yaw` | number | `45` | 0 – 180, step 5, deg | **Yaw limit.** How far it turns left or right. (required) |
| `lookAt.head.pitch` | number | `30` | 0 – 90, step 5, deg | **Pitch limit.** How far it tilts up or down. (required) |
| `lookAt.neck` | object |  |  | **Neck.** An optional neck bone that takes part of the turn. |
| `lookAt.neck.bone` | string, ownBone, 1–128 chars |  |  | **Bone.** A bone (node) of this object's model (the list shows its nodes). (required; format ownBone) |
| `lookAt.neck.yaw` | number | `45` | 0 – 180, step 5, deg | **Yaw limit.** How far it turns left or right. (required) |
| `lookAt.neck.pitch` | number | `30` | 0 – 90, step 5, deg | **Pitch limit.** How far it tilts up or down. (required) |
| `lookAt.chest` | object |  |  | **Chest.** An optional chest bone that takes part of the turn. |
| `lookAt.chest.bone` | string, ownBone, 1–128 chars |  |  | **Bone.** A bone (node) of this object's model (the list shows its nodes). (required; format ownBone) |
| `lookAt.chest.yaw` | number | `45` | 0 – 180, step 5, deg | **Yaw limit.** How far it turns left or right. (required) |
| `lookAt.chest.pitch` | number | `30` | 0 – 90, step 5, deg | **Pitch limit.** How far it tilts up or down. (required) |
| `lookAt.target` | object id, any scene |  |  | **Target.** The object looked at (its origin; none: the point, or nothing). |
| `lookAt.point` | vec3 [x, y, z] |  | -1000000 – 1000000, step 0.1, m | **Point.** A world position looked at when there is no target object. |
| `lookAt.weight` | number | `1` | 0 – 1, step 0.05 | **Weight.** How much of the turn applies (0: the clip pose alone). |
| `lookAt.weightParameter` | animatorParameter id (float) |  |  | **Weight parameter.** A float parameter of the controller (0–1) the weight is multiplied by. |
| `lookAt.turnSpeed` | number | `360` | 1 – 7200, step 10, deg/s | **Turn speed.** How fast the head turns to a new target and back. |

<a id="component-faceMovement"></a>
## faceMovement — Face movement

Turns this model to face where its parent (or, at the top, itself) is going: to one of two yaws by the side it moves to, or toward its motion in any direction.

- Category: Animation
- Added: from "+ Add component", starting as `{"yawRight":90,"yawLeft":-90,"turnSeconds":0.12}`
- On prefab objects: yes

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `mode` | enum: `sides`, `velocity` | `"sides"` |  | **Mode.** Sides: one yaw moving right, another moving left. Velocity: faces the way it moves, in any direction. (stored only when not the default; scripts read; choices: `sides` = Two sides, `velocity` = Face velocity) |
| `yawRight` | number | `90` | -360 – 360, step 5, deg | **Yaw moving right.** Rotation about +Y while the parent moves right. (required; applies when `mode` is `sides`; scripts read) |
| `yawLeft` | number | `-90` | -360 – 360, step 5, deg | **Yaw moving left.** Rotation about +Y while the parent moves left. (required; applies when `mode` is `sides`; scripts read) |
| `yawOffset` | number | `0` | -360 – 360, step 5, deg | **Yaw offset.** Added to the motion's yaw (0: the model is authored facing +Z). (applies when `mode` is `velocity`; scripts read) |
| `turnSeconds` | number | `0.12` | 0 – 5, step 0.01, s | **Turn time.** Time to turn around (a half turn). (scripts read) |

Presets:

- Two sides: `{"yawRight":90,"yawLeft":-90,"turnSeconds":0.12}`
- Face velocity: `{"mode":"velocity","turnSeconds":0.12}`

<a id="component-modelAnimation"></a>
## modelAnimation — Model animation (old)

The old idle/run/airborne clip roles. Projects are moved to an animator when opened; this stays only where the clips could not be measured.

- Category: Animation
- Added: never by hand: replaced by the animator (kept for old data)
- On prefab objects: no
- Legacy: kept working for old data, not offered for new objects
- Needs one of [`model`](components-rendering.md#component-model) on the same object: it animates the object's model
- Cannot share an object with [`instances`](components-rendering.md#component-instances): an instance set is not animated

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `assetId` | asset id (model) |  |  | **Model.** The entity's model asset. (required; written by a tool; scripts read) |
| `version` | int |  | ≥ 1, step 1 | **Version.** The model version the roles were made for. (required; written by a tool; scripts read) |
| `roles` | object |  |  | **Roles.** The clip per role. (required; written by a tool; scripts read) |
| `roles.idle` | JSON |  |  | **Idle.** The idle clip binding. (required; written by a tool) |
| `roles.run` | JSON |  |  | **Run.** The run clip binding. (required; written by a tool) |
| `roles.airborne` | JSON |  |  | **Airborne.** The airborne clip binding. (required; written by a tool) |
