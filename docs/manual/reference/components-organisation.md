# Components: Organisation

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Organisation components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-prefab"></a>
## prefab — Prefab link

Which prefab this object is a copy of: a linked copy (its parts made from the prefab and its overrides), or one part of a placed copy.

- Category: Organisation
- Added: by a tool: instantiatePrefab
- On prefab objects: no
- Icon: prefab

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `prefabId` | prefab id |  |  | **Prefab.** The prefab this object came from. (required; written by a tool; scripts read) |
| `localId` | string, id, 1–64 chars |  |  | **Prefab entity.** The prefab entity this object is a copy of (absent on a linked copy, which is the whole prefab). (written by a tool; scripts read; format id) |
| `overrides` | JSON: `PrefabOverride[]` ([PrefabOverride](types-o-t.md#type-prefab-override)) |  |  | **Overrides.** A linked copy's differences from its prefab, each on one part (by its local-id path): a changed, added or removed field or component, or a removed part. (written by a tool; scripts read) |
| `partIds` | JSON: `Record<string, string>` () |  |  | **Part ids.** A linked copy's parts that keep the ids they had as plain objects (by local-id path; a copy made by the schema 8 upgrade). Absent: each part's id is derived from the copy's id and its path. (written by a tool; scripts read) |

<a id="component-folder"></a>
## folder — Folder

Organises objects in the Hierarchy; carries nothing else.

- Category: Organisation
- Added: by a tool: createFolder
- On prefab objects: no
- Rule: A folder carries no transform and no other component.
