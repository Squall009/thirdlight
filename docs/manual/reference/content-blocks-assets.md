# Content documents (assets to lighting)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content blocks and their fields. Paths with `[]` are list items and `{}` map values.

<a id="content-assets"></a>
## assets — Assets

Imported models, audio, textures and fonts (their versions are written by the importer).

- In every project: yes
- Written by: [`publishAsset`](ops-detail.md#op-publishAsset), [`setAssetOptions`](ops-detail.md#op-setAssetOptions), [`deleteAsset`](ops-detail.md#op-deleteAsset), [`importAssets`](ops-detail.md#op-importAssets), [`setLabels`](ops-detail.md#op-setLabels), [`setAddress`](ops-detail.md#op-setAddress)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `assets` | list of objects |  |  | **Assets.** The asset catalog. (required) |
| `assets[].assetId` | string, id, 1–64 chars |  |  | **Id.** The stable asset id. (required; written by a tool; format id) |
| `assets[].kind` | enum: `model`, `audio`, `texture`, `font` |  |  | **Kind.** Model, audio, texture or font. (required; written by a tool) |
| `assets[].displayName` | string, name, 1–128 chars |  |  | **Name.** Shown in the asset browser. (required; written by a tool; format name) |
| `assets[].currentVersion` | int |  | ≥ 1, step 1 | **Version.** The current version (the last). (required; written by a tool) |
| `assets[].versions` | list of JSON, ≥ 1 items |  |  | **Versions.** Every imported version (append-only, written by the importer). (required; written by a tool) |
| `assets[].vertexColors` | enum: `data`, `tint` | `"data"` |  | **Vertex colours.** Data: COLOR_0 feeds shaders (wind weights). Tint: multiplies the colour. (applies when `kind` is `model`; stored only when not the default) |
| `assets[].materials` | map materialSlot → material id, 1–32 entries |  |  | **Default materials.** Material slot → project material, for every placement. (applies when `kind` is `model`) |
| `assets[].extractTextures` | bool | `false` |  | **Extract textures.** Import setting: the file's images become texture assets the model draws with (they count and stream like any texture). Set when the model is imported or re-imported. (applies when `kind` is `model`; stored only when not the default; written by a tool) |
| `assets[].textures` | map key → asset id (texture), 1–64 entries |  |  | **Extracted textures.** The file's image index → the texture asset it was extracted into (written by the importer). (applies when `kind` is `model`) |
| `assets[].clipsFor` | asset id (model) |  |  | **Clips for.** An animation-only file: its clips play on this model's rig. (applies when `kind` is `model`) |
| `assets[].labels` | list of string, 1–64 chars, ≥ 1 items, distinct |  |  | **Labels.** Names a script may load the asset by, with every other asset carrying them (ascending; set with setLabels). (written by a tool) |
| `assets[].address` | string, 1–128 chars |  |  | **Address.** The one name a script may load the asset by (unique in the project; set with setAddress). (written by a tool) |

<a id="content-prefabs"></a>
## prefabs — Prefabs

Captured object groups placed as independent copies.

- In every project: yes
- Written by: [`createPrefab`](ops-detail.md#op-createPrefab), [`instantiatePrefab`](ops-detail.md#op-instantiatePrefab), [`deletePrefab`](ops-detail.md#op-deletePrefab)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `prefabs` | list of objects |  |  | **Prefabs.** The project's prefabs (each its own file). (required) |
| `prefabs[].prefabId` | string, id, 1–64 chars |  |  | **Id.** The stable prefab id. (required; written by a tool; format id) |
| `prefabs[].displayName` | string, name, 1–128 chars |  |  | **Name.** Shown in the prefab list. (required; written by a tool; format name) |
| `prefabs[].createdRevision` | int |  | ≥ 0, step 1 | **Created at.** The project revision it was captured at. (required; written by a tool) |
| `prefabs[].entityCount` | int |  | 1 – 1024, step 1 | **Objects.** How many objects it holds (derived). (required; written by a tool) |
| `prefabs[].depth` | int |  | ≥ 1, step 1 | **Depth.** Hierarchy depth (derived). (required; written by a tool) |
| `prefabs[].entities` | list of objects, 1–1024 items |  |  | **Objects.** 1–1024 objects, parents first. (required; written by a tool) |
| `prefabs[].entities[].localId` | string, id, 1–64 chars |  |  | **Local id.** The id inside the prefab. (required; written by a tool; format id) |
| `prefabs[].entities[].name` | string, name, 1–128 chars |  |  | **Name.** The object name. (written by a tool; format name) |
| `prefabs[].entities[].parentLocalId` | string, id, 1–64 chars |  |  | **Parent.** The parent inside the prefab (none: a root). (may be null; written by a tool; format id) |
| `prefabs[].entities[].components` | components (24 kinds) |  |  | **Components.** The prefab component vocabulary. (required; written by a tool; allowed: `transform`, `model`, `box`, `behavior`, `collider`, `surface`, `materials`, `animator`, `mover`, `trigger`, `switch`, `audioSource`, `faceMovement`, `materialParams`, `effect`, `blockFootprint`, `behaviorGroup`, `health`, `collectible`, `patrol`, `hitbox`, `climbVolume`, `gravity`, `decal`) |

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
