# Graph: Visual script (part 7, from Environment weight (`api.environment.weight`))

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Visual script node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="node-behavior--api-environment-weight"></a>
### Environment weight (`api.environment.weight`)

How much of a preset is in the look now (0–1; '' = the base look).

Inputs:

- `presetId` "preset" (string)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `presetId` | preset | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-environment-presets"></a>
### Environment presets (`api.environment.presets`)

The project's environment preset ids.

Outputs:

- `value` (list)

<a id="node-behavior--api-environment-set-wind"></a>
### Set wind (`api.environment.setWind`)

Change the scene's global wind: any of its fields (direction [x, z], strength, gust, gustFrequency, turbulence, speed m/s, scale m, noise texture), added to the last change's, blending over `blend` seconds; null goes back to the scene's own wind. Wind zones keep laying their values over it. False when a value or an option is refused.

Inputs:

- `in` "" (exec): takes several wires
- `direction` (vector)
- `strength` (number)
- `gust` (number)
- `gustFrequency` "gust frequency" (number)
- `turbulence` (number)
- `speed` (number)
- `scale` (number)
- `noise` (string)
- `blend` "blend (seconds)" (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `noise` | noise | string | `""` | ≤ 256 chars |
| `easing` | easing | enum | `"linear"` | `linear`, `easeIn`, `easeOut`, `easeInOut`, `none` |

<a id="graph-behavior--entity"></a>
## Entity

- Get component (`api.entity.get`): A read-only snapshot of a component's script-readable fields as they stood at the start of the step (`'object'`: the object's own fields — id, name, parentId, active, visible, static, tags). Null when the object has no such component (`'materialParams'`: when it wears no graph material with public parameters). A component scripts cannot read throws. An empty entity means this object.
- Set component (`api.entity.set`): Write fields of a component, applied at the end of the step (in script order; a later write of the same field wins and the conflict is reported in diagnostics). Writable now: object `active` and `visible`, transform `position`/`rotation`/`scale` (not a physics body, the camera or a static object), light `color`/`intensity`/`range`, mover `speed`/`active`, `materialParams` ({ material: { parameter: An empty entity means this object.

<a id="node-behavior--api-entity-get"></a>
### Get component (`api.entity.get`)

A read-only snapshot of a component's script-readable fields as they stood at the start of the step (`'object'`: the object's own fields — id, name, parentId, active, visible, static, tags). Null when the object has no such component (`'materialParams'`: when it wears no graph material with public parameters). A component scripts cannot read throws. An empty entity means this object.

Inputs:

- `entityId` "object" (string)
- `component` (string)

Outputs:

- `value` (map)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `component` | component | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-entity-set"></a>
### Set component (`api.entity.set`)

Write fields of a component, applied at the end of the step (in script order; a later write of the same field wins and the conflict is reported in diagnostics). Writable now: object `active` and `visible`, transform `position`/`rotation`/`scale` (not a physics body, the camera or a static object), light `color`/`intensity`/`range`, mover `speed`/`active`, `materialParams` ({ material: { parameter: An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `component` (string)
- `patch` (map)

Outputs:

- `then` "" (exec): one wire
- `ok` (boolean)
- `field` (string)
- `code` (string)
- `message` (string)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `component` | component | string | `""` | ≤ 256 chars |

<a id="graph-behavior--shell"></a>
## Shell

- Next scene (deprecated) (`api.shell.nextScene`): Deprecated (one Problems line per Play): moves to the next entry of the shell's scene list at the next step boundary, as the shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene, the entry's scene loads, the character arrives at its spawn). False when the list has no next entry; a second call in the same step asks for the same move.
- Scene list entry (deprecated) (`api.shell.sceneIndex`): Deprecated (one Problems line per Play): the scene list entry the run is at (-1: none); only the list's own moves change it.
- Scene list length (deprecated) (`api.shell.sceneCount`): Deprecated (one Problems line per Play): how many entries the shell's scene list has (0: none).

<a id="node-behavior--api-shell-next-scene"></a>
### Next scene (deprecated) (`api.shell.nextScene`)

Deprecated (one Problems line per Play): moves to the next entry of the shell's scene list at the next step boundary, as the shell's `nextScene` UI action (the previous listed scene unloads unless it is a start scene, the entry's scene loads, the character arrives at its spawn). False when the list has no next entry; a second call in the same step asks for the same move.

Inputs:

- `in` "" (exec): takes several wires

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

<a id="node-behavior--api-shell-scene-index"></a>
### Scene list entry (deprecated) (`api.shell.sceneIndex`)

Deprecated (one Problems line per Play): the scene list entry the run is at (-1: none); only the list's own moves change it.

Outputs:

- `value` (number)

<a id="node-behavior--api-shell-scene-count"></a>
### Scene list length (deprecated) (`api.shell.sceneCount`)

Deprecated (one Problems line per Play): how many entries the shell's scene list has (0: none).

Outputs:

- `value` (number)
