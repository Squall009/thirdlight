# Content documents (behaviors to lighting)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content blocks and their fields. Paths with `[]` are list items and `{}` map values.

<a id="content-behaviors"></a>
## behaviors — Behaviors

Published scripts and their declared properties.

- In every project: yes
- Written by: [`publishBehavior`](ops-detail.md#op-publishBehavior), [`deleteBehavior`](ops-detail.md#op-deleteBehavior)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `behaviors` | list of objects |  |  | **Behaviors.** The project's scripts (each its own file). (required) |
| `behaviors[].behaviorId` | string, id, 1–64 chars |  |  | **Id.** The stable behavior id. (required; written by a tool; format id) |
| `behaviors[].displayName` | string, name, 1–128 chars |  |  | **Name.** Shown in pickers. (required; format name) |
| `behaviors[].declaration` | object |  |  | **Declaration.** The properties objects set. (required) |
| `behaviors[].declaration.properties` | list of objects |  |  | **Properties.** The declared properties (none or more; the declaration is at most 32768 bytes). (required) |
| `behaviors[].declaration.properties[]` | object |  |  | **Property.** A property the script declares (shown per object). (rules: min ≤ max; the default fits the type and its limits.) |
| `behaviors[].declaration.properties[].key` | string, identifier, 1–64 chars |  |  | **Key.** The property key the script reads (a lowercase letter, then lowercase letters, digits or _). (required; format identifier) |
| `behaviors[].declaration.properties[].label` | string, 1–64 chars |  |  | **Label.** Shown in the Inspector. (required) |
| `behaviors[].declaration.properties[].type` | enum: `number`, `boolean`, `string`, `enum`, `vec3`, `entityRef`, `assetRef` | `"number"` |  | **Type.** The value type. (required; choices: `number` = Number, `boolean` = Boolean, `string` = String, `enum` = Enum, `vec3` = Vector, `entityRef` = Object, `assetRef` = Asset) |
| `behaviors[].declaration.properties[].default` | JSON (typed by propertyType) |  |  | **Default.** The value when an object sets none (of the declared type). (required) |
| `behaviors[].declaration.properties[].min` | number |  | -1000000000000 – 1000000000000 | **Min.** Smallest number. (applies when `type` is `number`) |
| `behaviors[].declaration.properties[].max` | number |  | -1000000000000 – 1000000000000 | **Max.** Largest number. (applies when `type` is `number`) |
| `behaviors[].declaration.properties[].step` | number |  | > 0, ≤ 1000000 | **Step.** Increment of the number field. (applies when `type` is `number`) |
| `behaviors[].declaration.properties[].maxLength` | int | `256` | 1 – 1024, step 1 | **Max length.** Longest string (default 256). (applies when `type` is `string`) |
| `behaviors[].declaration.properties[].values` | list of string, 1–64 chars, 1–32 items, distinct |  |  | **Values.** 1–32 choices. (required; applies when `type` is `enum`) |
| `behaviors[].declaration.properties[].bounds` | object |  |  | **Bounds.** Per-axis limits of a vector. (applies when `type` is `vec3`; rules: min ≤ max per axis) |
| `behaviors[].declaration.properties[].bounds.min` | vec3 [x, y, z] |  | -1000000 – 1000000 | **Min.** Smallest per axis. (required) |
| `behaviors[].declaration.properties[].bounds.max` | vec3 [x, y, z] |  | -1000000 – 1000000 | **Max.** Largest per axis. (required) |
| `behaviors[].declaration.properties[].visibility` | enum: `public`, `private` | `"public"` |  | **Visibility.** Public: shown in the Inspector of every object with this script and set per object. Private: not shown, not settable; the script reads the default. |
| `behaviors[].declaration.properties[].group` | string, 1–64 chars |  |  | **Group.** The Inspector section the property is listed in. |
| `behaviors[].declaration.properties[].header` | string, 1–64 chars |  |  | **Header.** A heading shown above the property in the Inspector. |
| `behaviors[].declaration.properties[].tooltip` | string, 1–256 chars |  |  | **Tooltip.** The help shown when hovering the property. |
| `behaviors[].source` | JSON |  |  | **Source.** The compiled source record (written by the behavior build; none: declaration only). (required; may be null; written by a tool) |
| `behaviors[].publishedRevision` | int |  | ≥ 0, step 1 | **Published at.** The project revision it was published at. (required; written by a tool) |

<a id="content-behaviorTrust"></a>
## behaviorTrust — Script trust

Which script sources the owner acknowledged.

- In every project: yes
- Written by: [`acknowledgeBehaviorTrust`](ops-detail.md#op-acknowledgeBehaviorTrust), [`revokeBehaviorTrust`](ops-detail.md#op-revokeBehaviorTrust)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `entries` | list of JSON |  |  | **Entries.** Acknowledged source digests. (required; written by a tool) |

<a id="content-lighting"></a>
## lighting — Baked lighting

Each scene's lightmap bake (written by the baker).

- In every project: no
- Written by: [`setLighting`](ops-detail.md#op-setLighting)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `lighting` | map scene id → JSON: `LightingBake` ([LightingBake](types-d-p.md#type-lighting-bake)) |  |  | **Baked lighting.** Scene → its bake. (written by a tool) |
