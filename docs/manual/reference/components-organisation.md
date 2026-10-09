# Components: Organisation

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Organisation components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-prefab"></a>
## prefab — Prefab link

Which prefab (and which of its entities) this object was placed from.

- Category: Organisation
- Added: by a tool: instantiatePrefab
- On prefab objects: no

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `prefabId` | prefab id |  |  | **Prefab.** The prefab this object came from. (required; written by a tool; scripts read) |
| `localId` | string, id, 1–64 chars |  |  | **Prefab entity.** The prefab entity this object is a copy of. (required; written by a tool; scripts read; format id) |

<a id="component-folder"></a>
## folder — Folder

Organises objects in the Hierarchy; carries nothing else.

- Category: Organisation
- Added: by a tool: createFolder
- On prefab objects: no
- Rule: A folder carries no transform and no other component.
