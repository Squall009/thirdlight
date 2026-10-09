# Graph: Visual script (part 3, from World transform of (`api.world.worldTransform`))

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Visual script node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="node-behavior--api-world-world-transform"></a>
### World transform of (`api.world.worldTransform`)

The entity's world transform this step so far: its transform composed up its parents, where it is drawn. Under a parent scaled unevenly and turned, the scale is the length of each world axis. `undefined` when it is not loaded. An empty entity means this object.

Inputs:

- `entityId` "entity" (string)

Outputs:

- `position` (vector)
- `rotation` (list)
- `scale` (vector)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-world-find"></a>
### Find object by name (`api.world.find`)

The first loaded entity whose name is exactly `name` (case-sensitive), or `undefined`. Entities are searched in load order: the start scene in document order, then later scenes and spawned copies as they arrived.

Inputs:

- `name` (string)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | name | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-world-find-all"></a>
### Find objects by name (`api.world.findAll`)

Every loaded entity whose name is exactly `name` (case-sensitive), in load order (spawned copies included).

Inputs:

- `name` (string)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | name | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-world-with-component"></a>
### Find objects with component (`api.world.withComponent`)

Every loaded entity carrying a component of this kind (as stored on the entity, e.g. `'collider'`, `'light'`, `'behavior'`), in load order (spawned copies included).

Inputs:

- `kind` (string)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `kind` | kind | string | `""` | ≤ 256 chars |

<a id="graph-behavior--scenes"></a>
## Scenes

- Load scene (`api.scenes.load`): Request a load; it completes at a later step boundary. Loading or loaded ⇒ no-op.
- Unload scene (`api.scenes.unload`): Request an unload at the next step boundary. Unloaded ⇒ no-op.
- Reload scene (`api.scenes.reload`): Request a reload at the next step boundary: the scene's objects return as authored (where it was loaded), the copies its objects spawned go, its scripts start over (as at a run restart), its sounds stop. Kept objects, `ctx.save`, the counters and the other scenes stay as they are. An unloaded scene loads; a loading one ⇒ no-op. Refused for a scene holding a player that is not kept loaded.
- Scene status (`api.scenes.status`): Where a scene is in its load cycle.
- Loaded scenes (`api.scenes.loaded`): The loaded scene ids, in load order.
- Loading scenes (`api.scenes.loading`): The scenes being loaded (asked for, not yet in), in request order.
- Scene transition (`api.scenes.transition`): The scene transition in progress (its scene, `out` while the view fades out, `loading` while the scene loads), or null.
- Active scene (`api.scenes.active`): The active scene: its sky, fog, post-processing and wind are the look (the first start scene at first; a transition that unloads it makes its scene active).
- Set active scene (`api.scenes.setActive`): Make a loaded scene the active one: its look blends in over `blend` seconds (0: at once). Applies with the step.

<a id="node-behavior--api-scenes-load"></a>
### Load scene (`api.scenes.load`)

Request a load; it completes at a later step boundary. Loading or loaded ⇒ no-op.

Inputs:

- `in` "" (exec): takes several wires
- `sceneId` "scene" (string)
- `at` (vector)
- `unload` (list)
- `fade` (number)
- `fadeColor` "fade color" (string)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `sceneId` | scene | string | `""` | ≤ 256 chars |
| `fadeColor` | fade color | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-scenes-unload"></a>
### Unload scene (`api.scenes.unload`)

Request an unload at the next step boundary. Unloaded ⇒ no-op.

Inputs:

- `in` "" (exec): takes several wires
- `sceneId` "scene" (string)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `sceneId` | scene | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-scenes-reload"></a>
### Reload scene (`api.scenes.reload`)

Request a reload at the next step boundary: the scene's objects return as authored (where it was loaded), the copies its objects spawned go, its scripts start over (as at a run restart), its sounds stop. Kept objects, `ctx.save`, the counters and the other scenes stay as they are. An unloaded scene loads; a loading one ⇒ no-op. Refused for a scene holding a player that is not kept loaded.

Inputs:

- `in` "" (exec): takes several wires
- `sceneId` "scene" (string)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `sceneId` | scene | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-scenes-status"></a>
### Scene status (`api.scenes.status`)

Where a scene is in its load cycle.

Inputs:

- `sceneId` "scene" (string)

Outputs:

- `value` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `sceneId` | scene | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-scenes-loaded"></a>
### Loaded scenes (`api.scenes.loaded`)

The loaded scene ids, in load order.

Outputs:

- `value` (list)

<a id="node-behavior--api-scenes-loading"></a>
### Loading scenes (`api.scenes.loading`)

The scenes being loaded (asked for, not yet in), in request order.

Outputs:

- `value` (list)

<a id="node-behavior--api-scenes-transition"></a>
### Scene transition (`api.scenes.transition`)

The scene transition in progress (its scene, `out` while the view fades out, `loading` while the scene loads), or null.

Outputs:

- `scene` (string)
- `phase` (string)
- `fade` (number)
- `seconds` (number)
- `color` (string)
- `unload` (list)
- `found` (boolean)

<a id="node-behavior--api-scenes-active"></a>
### Active scene (`api.scenes.active`)

The active scene: its sky, fog, post-processing and wind are the look (the first start scene at first; a transition that unloads it makes its scene active).

Outputs:

- `value` (string)
- `found` (boolean)

<a id="node-behavior--api-scenes-set-active"></a>
### Set active scene (`api.scenes.setActive`)

Make a loaded scene the active one: its look blends in over `blend` seconds (0: at once). Applies with the step.

Inputs:

- `in` "" (exec): takes several wires
- `sceneId` "scene" (string)
- `blend` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `sceneId` | scene | string | `""` | ≤ 256 chars |
| `easing` | easing | enum | `"linear"` | `linear`, `easeIn`, `easeOut`, `easeInOut` |

<a id="graph-behavior--input"></a>
## Input

- Input value (`api.input.value`): A button 0/1, a 1D axis −1..1, a 2D axis's length; 0 for an unknown name.
- Input vector (`api.input.vector`): A 2D axis as [x, y] ([value, 0] for others).
- Input pressed (`api.input.pressed`): Pressed in this step.
- Input released (`api.input.released`): Released in this step.
- Input held (`api.input.held`): Down this step (pressed or held).
- Pointer (`api.input.pointer`): The pointer this step — where it is in the view (x, y 0–1 from the top left), how far it moved since the last step, the wheel, whether it is over the view (and entered or left it this step), whether the cursor is locked and whether it is over a UI element (`overUi`: a click there went to the UI); null before the pointer is first seen.
- Pointer pressed (`api.input.pointerPressed`): A pointer button (default left) went down this step — a click.
- Pointer released (`api.input.pointerReleased`): A pointer button (default left) went up this step.
- Pointer held (`api.input.pointerHeld`): A pointer button (default left) is down this step.
- Any button pressed (`api.input.anyPressed`): Any key, mouse or pad button that went down this step, bound to an action or not — its device (keyboard, mouse, gamepad) and code (a key's code such as `KeyK` or `Space`, `left`/`right`/`middle`, `button0`…), or null. A key or pad button before a mouse button when several went down.
- Set cursor (`api.input.setCursor`): Ask for a free or a locked cursor (locked: hidden and held in the view — its movement still counts); 'auto' goes back to the active input map's setting. Takes effect after the step (the player may have to click the view once before the browser locks it).
- Using gamepad (`api.input.usingGamepad`): The player used a gamepad last (else the keyboard or mouse).
- Action glyph label (`api.input.glyphLabel`): An action's glyph label for the device used last ('' when it has no binding there) — e.g. "Space", "A", "Cross".
- Action glyph icon (`api.input.glyphIcon`): An action's glyph icon id for the device used last ('' when it has no binding there) — e.g. key, pad-south, mouse-left.
- Rebinding (`api.input.rebinding`): The rebind listening for input now (action, binding index, part), or null.
- Cancel rebind (`api.input.cancelRebind`): Stop listening for a rebind.
- Reset bindings (`api.input.resetBindings`): Reset one action's bindings (or all, without a name) to the project's defaults.
- Use binding profile (`api.input.useBindingProfile`): Use another player profile's saved bindings (a name of 1–32 letters, digits, _ or -; 'default' first).
- Binding profile (`api.input.bindingProfile`): The player profile whose bindings are in effect.

<a id="node-behavior--api-input-value"></a>
### Input value (`api.input.value`)

A button 0/1, a 1D axis −1..1, a 2D axis's length; 0 for an unknown name.

Inputs:

- `name` "action" (string)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | action | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-vector"></a>
### Input vector (`api.input.vector`)

A 2D axis as [x, y] ([value, 0] for others).

Inputs:

- `name` "action" (string)

Outputs:

- `value` (vector)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | action | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-pressed"></a>
### Input pressed (`api.input.pressed`)

Pressed in this step.

Inputs:

- `name` "action" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | action | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-released"></a>
### Input released (`api.input.released`)

Released in this step.

Inputs:

- `name` "action" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | action | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-held"></a>
### Input held (`api.input.held`)

Down this step (pressed or held).

Inputs:

- `name` "action" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | action | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-pointer"></a>
### Pointer (`api.input.pointer`)

The pointer this step — where it is in the view (x, y 0–1 from the top left), how far it moved since the last step, the wheel, whether it is over the view (and entered or left it this step), whether the cursor is locked and whether it is over a UI element (`overUi`: a click there went to the UI); null before the pointer is first seen.

Outputs:

- `x` (number)
- `y` (number)
- `dx` (number)
- `dy` (number)
- `wheel` (number)
- `over` (boolean)
- `entered` (boolean)
- `left` (boolean)
- `locked` (boolean)
- `overUi` "over ui" (boolean)
- `found` (boolean)

<a id="node-behavior--api-input-pointer-pressed"></a>
### Pointer pressed (`api.input.pointerPressed`)

A pointer button (default left) went down this step — a click.

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `button` | button | enum | `"left"` | `left`, `right`, `middle` |

<a id="node-behavior--api-input-pointer-released"></a>
### Pointer released (`api.input.pointerReleased`)

A pointer button (default left) went up this step.

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `button` | button | enum | `"left"` | `left`, `right`, `middle` |

<a id="node-behavior--api-input-pointer-held"></a>
### Pointer held (`api.input.pointerHeld`)

A pointer button (default left) is down this step.

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `button` | button | enum | `"left"` | `left`, `right`, `middle` |

<a id="node-behavior--api-input-any-pressed"></a>
### Any button pressed (`api.input.anyPressed`)

Any key, mouse or pad button that went down this step, bound to an action or not — its device (keyboard, mouse, gamepad) and code (a key's code such as `KeyK` or `Space`, `left`/`right`/`middle`, `button0`…), or null. A key or pad button before a mouse button when several went down.

Outputs:

- `device` (string)
- `code` (string)
- `found` (boolean)

<a id="node-behavior--api-input-set-cursor"></a>
### Set cursor (`api.input.setCursor`)

Ask for a free or a locked cursor (locked: hidden and held in the view — its movement still counts); 'auto' goes back to the active input map's setting. Takes effect after the step (the player may have to click the view once before the browser locks it).

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `mode` | mode | enum | `"free"` | `free`, `locked`, `auto` |

<a id="node-behavior--api-input-using-gamepad"></a>
### Using gamepad (`api.input.usingGamepad`)

The player used a gamepad last (else the keyboard or mouse).

Outputs:

- `value` (boolean)

<a id="node-behavior--api-input-glyph-label"></a>
### Action glyph label (`api.input.glyphLabel`)

An action's glyph label for the device used last ('' when it has no binding there) — e.g. "Space", "A", "Cross".

Inputs:

- `action` (string)

Outputs:

- `value` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `action` | action | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-glyph-icon"></a>
### Action glyph icon (`api.input.glyphIcon`)

An action's glyph icon id for the device used last ('' when it has no binding there) — e.g. key, pad-south, mouse-left.

Inputs:

- `action` (string)

Outputs:

- `value` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `action` | action | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-rebinding"></a>
### Rebinding (`api.input.rebinding`)

The rebind listening for input now (action, binding index, part), or null.

Outputs:

- `action` (string)
- `index` (number)
- `part` (string)
- `found` (boolean)

<a id="node-behavior--api-input-cancel-rebind"></a>
### Cancel rebind (`api.input.cancelRebind`)

Stop listening for a rebind.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire

<a id="node-behavior--api-input-reset-bindings"></a>
### Reset bindings (`api.input.resetBindings`)

Reset one action's bindings (or all, without a name) to the project's defaults.

Inputs:

- `in` "" (exec): takes several wires
- `action` (string)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `action` | action | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-use-binding-profile"></a>
### Use binding profile (`api.input.useBindingProfile`)

Use another player profile's saved bindings (a name of 1–32 letters, digits, _ or -; 'default' first).

Inputs:

- `in` "" (exec): takes several wires
- `profile` (string)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `profile` | profile | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-input-binding-profile"></a>
### Binding profile (`api.input.bindingProfile`)

The player profile whose bindings are in effect.

Outputs:

- `value` (string)

<a id="graph-behavior--animator"></a>
## Animator

- Set animator parameter (`api.animator.set`): Set a float/int/bool parameter; false for an unknown name or a wrong type. An empty entity means this object.
- Set animator trigger (`api.animator.trigger`): Set a trigger (it resets when a transition uses it). An empty entity means this object.
- Animator parameter (`api.animator.get`): A parameter's value (undefined for an unknown name). An empty entity means this object.
- Animator state (`api.animator.state`): The current state's name (of the base layer, or of override layer `layer` — 1 is the first). An empty entity means this object.
- Play animator state (`api.animator.play`): Go to a state by name over `fade` seconds (0: at once), on layer `layer` (0: the base layer, 1 the first override layer), the state starting at normalized time `time` (0–1 of its length; 0: its beginning). False for an unknown state or layer, or a time below 0. An empty entity means this object.
- Set look target (`api.animator.setLookTarget`): The object the look-at constraint turns the head toward (its origin), or null for nothing (the head turns back at its turn speed). False when the animator has no look-at. An empty entity means this object.
- Set look point (`api.animator.setLookPoint`): A world point [x, y, z] the look-at constraint turns the head toward (in place of a target object). False when the animator has no look-at or the point is not three finite numbers. An empty entity means this object.
- Set look weight (`api.animator.setLookWeight`): The look-at constraint's weight (0–1; 0: the clip pose alone — the head turns back at its turn speed). False when the animator has no look-at or the weight is outside 0–1. An empty entity means this object.
- Set animation speed (`api.animator.setSpeed`): Set this animator's playback speed (× every clip and crossfade; 1 as authored, 0.5 half speed, 0 holds the pose; 0–10). False for a value outside 0–10. An empty entity means this object.
- Animation speed (`api.animator.speed`): This animator's playback speed. An empty entity means this object.
- Set morph weight (`api.animator.setMorph`): Set a morph target's weight (0–1) by its name in the model (over the controller's parameter binding of that target, if any). An empty entity means this object.
- Morph weight (`api.animator.morph`): A morph target's weight now (0 when nothing sets it). An empty entity means this object.

<a id="node-behavior--api-animator-set"></a>
### Set animator parameter (`api.animator.set`)

Set a float/int/bool parameter; false for an unknown name or a wrong type. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `name` "parameter" (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `name` | parameter | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-animator-trigger"></a>
### Set animator trigger (`api.animator.trigger`)

Set a trigger (it resets when a transition uses it). An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `name` "trigger" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `name` | trigger | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-animator-get"></a>
### Animator parameter (`api.animator.get`)

A parameter's value (undefined for an unknown name). An empty entity means this object.

Inputs:

- `entityId` "entity" (string)
- `name` "parameter" (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `name` | parameter | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean` |

<a id="node-behavior--api-animator-state"></a>
### Animator state (`api.animator.state`)

The current state's name (of the base layer, or of override layer `layer` — 1 is the first). An empty entity means this object.

Inputs:

- `entityId` "entity" (string)
- `layer` (number)

Outputs:

- `value` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-animator-play"></a>
### Play animator state (`api.animator.play`)

Go to a state by name over `fade` seconds (0: at once), on layer `layer` (0: the base layer, 1 the first override layer), the state starting at normalized time `time` (0–1 of its length; 0: its beginning). False for an unknown state or layer, or a time below 0. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `state` (string)
- `fade` (number)
- `layer` (number)
- `time` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `state` | state | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-animator-set-look-target"></a>
### Set look target (`api.animator.setLookTarget`)

The object the look-at constraint turns the head toward (its origin), or null for nothing (the head turns back at its turn speed). False when the animator has no look-at. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `targetId` "target" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `targetId` | target | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-animator-set-look-point"></a>
### Set look point (`api.animator.setLookPoint`)

A world point [x, y, z] the look-at constraint turns the head toward (in place of a target object). False when the animator has no look-at or the point is not three finite numbers. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `point` (vector)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `point` | point | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-animator-set-look-weight"></a>
### Set look weight (`api.animator.setLookWeight`)

The look-at constraint's weight (0–1; 0: the clip pose alone — the head turns back at its turn speed). False when the animator has no look-at or the weight is outside 0–1. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `weight` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `weight` | weight | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-animator-set-speed"></a>
### Set animation speed (`api.animator.setSpeed`)

Set this animator's playback speed (× every clip and crossfade; 1 as authored, 0.5 half speed, 0 holds the pose; 0–10). False for a value outside 0–10. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `speed` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `speed` | speed | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-animator-speed"></a>
### Animation speed (`api.animator.speed`)

This animator's playback speed. An empty entity means this object.

Inputs:

- `entityId` "entity" (string)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-animator-set-morph"></a>
### Set morph weight (`api.animator.setMorph`)

Set a morph target's weight (0–1) by its name in the model (over the controller's parameter binding of that target, if any). An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `name` "morph target" (string)
- `weight` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `name` | morph target | string | `""` | ≤ 256 chars |
| `weight` | weight | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-animator-morph"></a>
### Morph weight (`api.animator.morph`)

A morph target's weight now (0 when nothing sets it). An empty entity means this object.

Inputs:

- `entityId` "entity" (string)
- `name` "morph target" (string)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `name` | morph target | string | `""` | ≤ 256 chars |

<a id="graph-behavior--timers"></a>
## Timers

- Start timer (`api.timers.after`): Fire once, `seconds` from this step. Returns `false` (and changes nothing) when a one-shot timer of that name and length is already running — a script may call it every step; a different length restarts it.
- Start repeating timer (`api.timers.every`): Fire every `seconds`, the first time `seconds` from this step. Returns `false` (and changes nothing) when a repeating timer of that name and period is already running.
- Timer fired (`api.timers.fired`): True in the step the timer fires (in every phase of that step).
- Cancel timer (`api.timers.cancel`): Stop a timer; `false` when none of that name was running.

<a id="node-behavior--api-timers-after"></a>
### Start timer (`api.timers.after`)

Fire once, `seconds` from this step. Returns `false` (and changes nothing) when a one-shot timer of that name and length is already running — a script may call it every step; a different length restarts it.

Inputs:

- `in` "" (exec): takes several wires
- `name` "timer" (string)
- `seconds` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | timer | string | `""` | ≤ 256 chars |
| `seconds` | seconds | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timers-every"></a>
### Start repeating timer (`api.timers.every`)

Fire every `seconds`, the first time `seconds` from this step. Returns `false` (and changes nothing) when a repeating timer of that name and period is already running.

Inputs:

- `in` "" (exec): takes several wires
- `name` "timer" (string)
- `seconds` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | timer | string | `""` | ≤ 256 chars |
| `seconds` | seconds | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-timers-fired"></a>
### Timer fired (`api.timers.fired`)

True in the step the timer fires (in every phase of that step).

Inputs:

- `name` "timer" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | timer | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-timers-cancel"></a>
### Cancel timer (`api.timers.cancel`)

Stop a timer; `false` when none of that name was running.

Inputs:

- `in` "" (exec): takes several wires
- `name` "timer" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | timer | string | `""` | ≤ 256 chars |

<a id="graph-behavior--signals"></a>
## Signals

- Emit signal (`api.signals.emit`): Send a named signal; switches, doors and scripts see it in the next step.
- Signal received (`api.signals.on`): Emitted in the previous step (by a switch, a trigger or a script).

<a id="node-behavior--api-signals-emit"></a>
### Emit signal (`api.signals.emit`)

Send a named signal; switches, doors and scripts see it in the next step.

Inputs:

- `in` "" (exec): takes several wires
- `name` "signal" (string)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | signal | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-signals-on"></a>
### Signal received (`api.signals.on`)

Emitted in the previous step (by a switch, a trigger or a script).

Inputs:

- `name` "signal" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | signal | string | `""` | ≤ 256 chars |

<a id="graph-behavior--messages"></a>
## Messages

- Send message (`api.messages.send`): Send a message (name: 1–64 letters, digits or _ . : -) with an optional value (a number, text of at most 256 characters or true/false) to every script, or only to the scripts on entity `target`. `false` when it is refused (a bad name or value, or the step's limit).
- Messages received (`api.messages.received`): The messages of that name sent in the previous step to every script or to this entity, in send order.

<a id="node-behavior--api-messages-send"></a>
### Send message (`api.messages.send`)

Send a message (name: 1–64 letters, digits or _ . : -) with an optional value (a number, text of at most 256 characters or true/false) to every script, or only to the scripts on entity `target`. `false` when it is refused (a bad name or value, or the step's limit).

Inputs:

- `in` "" (exec): takes several wires
- `name` "message" (string)
- `value` (number): type from field `value_type`
- `target` "to entity (empty: every script)" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | message | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |
| `value` | value | string | `""` | ≤ 256 chars |
| `target` | to entity (empty: every script) | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-messages-received"></a>
### Messages received (`api.messages.received`)

The messages of that name sent in the previous step to every script or to this entity, in send order.

Inputs:

- `name` "message" (string)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | message | string | `""` | ≤ 256 chars |

<a id="graph-behavior--game"></a>
## Game

- Counter value (`api.game.counter`): The current value of one of the run's counters (0 when it was never added to).
- Add to counter (`api.game.add`): Add to one of the run's named counters; HUD documents read them (`$flow.counters.<name>`). A name is a letter or _, then up to 31 letters, digits or _ (what a save keeps): any other name is refused (false, one Problems line) and no counter changes.
- Player health (`api.game.health`): A player character's health (a controller's object: `entityId`, absent: the first player controller), or null when it has none. An empty entity means this object.
- Set visible (`api.game.setVisible`): Show or hide an entity (and its children) until the next run; it still collides and triggers. An empty entity means this object.

<a id="node-behavior--api-game-counter"></a>
### Counter value (`api.game.counter`)

The current value of one of the run's counters (0 when it was never added to).

Inputs:

- `name` "counter" (string)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | counter | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-game-add"></a>
### Add to counter (`api.game.add`)

Add to one of the run's named counters; HUD documents read them (`$flow.counters.<name>`). A name is a letter or _, then up to 31 letters, digits or _ (what a save keeps): any other name is refused (false, one Problems line) and no counter changes.

Inputs:

- `in` "" (exec): takes several wires
- `name` "counter" (string)
- `amount` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | counter | string | `""` | ≤ 256 chars |
| `amount` | amount | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-game-health"></a>
### Player health (`api.game.health`)

A player character's health (a controller's object: `entityId`, absent: the first player controller), or null when it has none. An empty entity means this object.

Inputs:

- `entityId` "player" (string)

Outputs:

- `current` (number)
- `max` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-game-set-visible"></a>
### Set visible (`api.game.setVisible`)

Show or hide an entity (and its children) until the next run; it still collides and triggers. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "entity" (string)
- `visible` (boolean)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `visible` | visible | boolean | `true` |  |

<a id="graph-behavior--health"></a>
## Health

- Health of (`api.health.get`): The object's health now, or null when it has no Health component. An empty entity means this object.
- Damage (`api.health.damage`): Take `amount` (> 0) from the object's health, not below 0 (a `damaged` event, and `died` when it reaches 0). `source` names what did it (an object id or any text). False without health, when it is already at 0, or for a bad amount. An empty entity means this object.
- Heal (`api.health.heal`): Give `amount` (> 0) back, not above its maximum (a `healed` event). False without health, at its maximum, or for a bad amount. An empty entity means this object.
- Health events (`api.health.events`): Every object's health events of the previous step (damaged, healed, died), in the order they happened.

<a id="node-behavior--api-health-get"></a>
### Health of (`api.health.get`)

The object's health now, or null when it has no Health component. An empty entity means this object.

Inputs:

- `entityId` "object" (string)

Outputs:

- `current` (number)
- `max` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-health-damage"></a>
### Damage (`api.health.damage`)

Take `amount` (> 0) from the object's health, not below 0 (a `damaged` event, and `died` when it reaches 0). `source` names what did it (an object id or any text). False without health, when it is already at 0, or for a bad amount. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `amount` (number)
- `source` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `amount` | amount | number | `1` | -1000000000 – 1000000000 |
| `source` | source | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-health-heal"></a>
### Heal (`api.health.heal`)

Give `amount` (> 0) back, not above its maximum (a `healed` event). False without health, at its maximum, or for a bad amount. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `amount` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `amount` | amount | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-health-events"></a>
### Health events (`api.health.events`)

Every object's health events of the previous step (damaged, healed, died), in the order they happened.

Outputs:

- `value` (list)

<a id="graph-behavior--patrol"></a>
## Patrol

- Patrol state (`api.patrol.get`): The way a patroller walks now (a unit vector) and whether it walks at all; null for an object without a patrol. An empty entity means this object.
- Set patrol active (`api.patrol.setActive`): Stop a patroller where it is, or let it walk on. False for an object without a patrol. An empty entity means this object.
- Turn patroller (`api.patrol.turn`): Turn a patroller around now (a `turned` event). False for an object without a patrol, or a waypoint loop (it only goes forward). An empty entity means this object.

<a id="node-behavior--api-patrol-get"></a>
### Patrol state (`api.patrol.get`)

The way a patroller walks now (a unit vector) and whether it walks at all; null for an object without a patrol. An empty entity means this object.

Inputs:

- `entityId` "object" (string)

Outputs:

- `direction` (vector)
- `active` (boolean)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-patrol-set-active"></a>
### Set patrol active (`api.patrol.setActive`)

Stop a patroller where it is, or let it walk on. False for an object without a patrol. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `active` (boolean)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `active` | active | boolean | `true` |  |

<a id="node-behavior--api-patrol-turn"></a>
### Turn patroller (`api.patrol.turn`)

Turn a patroller around now (a `turned` event). False for an object without a patrol, or a waypoint loop (it only goes forward). An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="graph-behavior--hitbox"></a>
## Hitbox

- Set hitbox active (`api.hitbox.setActive`): Switch a hitbox off (it touches nothing: its contacts end) or on again. False for an object without a hitbox. An empty entity means this object.
- Touching (`api.hitbox.touching`): The objects a hitbox (or the character) touches now, sorted by id. An empty entity means this object.

<a id="node-behavior--api-hitbox-set-active"></a>
### Set hitbox active (`api.hitbox.setActive`)

Switch a hitbox off (it touches nothing: its contacts end) or on again. False for an object without a hitbox. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `active` (boolean)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `active` | active | boolean | `true` |  |

<a id="node-behavior--api-hitbox-touching"></a>
### Touching (`api.hitbox.touching`)

The objects a hitbox (or the character) touches now, sorted by id. An empty entity means this object.

Inputs:

- `entityId` "object" (string)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="graph-behavior--collectible"></a>
## Collectible

- Is collected (`api.collectible.collected`): Whether a collectible has been collected (and not come back yet). An empty entity means this object.
- Restore collectible (`api.collectible.restore`): Bring a collected collectible back now (shown, collectable again; a `restored` event). False when it is not collected. An empty entity means this object.

<a id="node-behavior--api-collectible-collected"></a>
### Is collected (`api.collectible.collected`)

Whether a collectible has been collected (and not come back yet). An empty entity means this object.

Inputs:

- `entityId` "object" (string)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-collectible-restore"></a>
### Restore collectible (`api.collectible.restore`)

Bring a collected collectible back now (shown, collectable again; a `restored` event). False when it is not collected. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="graph-behavior--character"></a>
## Character

- Character impulse (`api.character.impulse`): Add `velocity` [x, y, z] (m/s, each at most 100 either way) to a player character's velocity at its next move (`entityId`, absent: the first player controller) — a push, a launch, a knock back or a bounce; its own acceleration then brings it back to what the input asks. A positive y lifts it off the ground. The 2D plane ignores z. Impulses in one step add up. False without that character or for a  An empty entity means this object.

<a id="node-behavior--api-character-impulse"></a>
### Character impulse (`api.character.impulse`)

Add `velocity` [x, y, z] (m/s, each at most 100 either way) to a player character's velocity at its next move (`entityId`, absent: the first player controller) — a push, a launch, a knock back or a bounce; its own acceleration then brings it back to what the input asks. A positive y lifts it off the ground. The 2D plane ignores z. Impulses in one step add up. False without that character or for a  An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `velocity` (vector)
- `entityId` "player" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `velocity` | velocity | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="graph-behavior--look"></a>
## Look

- Set look (`api.look.set`): Give an object (and every mesh under it) a look override — a glow (emissive colour and intensity) and/or a tint — replacing any it had, until cleared or a new run. False for an object not loaded or a bad value. An empty entity means this object.
- Clear look (`api.look.clear`): Give an object its own look back. False when it had no override. An empty entity means this object.
- Look of (`api.look.get`): The object's look override now, or null when it has none. An empty entity means this object.

<a id="node-behavior--api-look-set"></a>
### Set look (`api.look.set`)

Give an object (and every mesh under it) a look override — a glow (emissive colour and intensity) and/or a tint — replacing any it had, until cleared or a new run. False for an object not loaded or a bad value. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `emissive` (string)
- `emissiveIntensity` "emissive intensity" (number)
- `tint` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `emissive` | emissive | string | `""` | ≤ 256 chars |
| `tint` | tint | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-look-clear"></a>
### Clear look (`api.look.clear`)

Give an object its own look back. False when it had no override. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-look-get"></a>
### Look of (`api.look.get`)

The object's look override now, or null when it has none. An empty entity means this object.

Inputs:

- `entityId` "object" (string)

Outputs:

- `emissive` (string)
- `emissiveIntensity` "emissive intensity" (number)
- `tint` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
