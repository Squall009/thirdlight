# Components: Rendering (part 2)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Rendering components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-architecture"></a>
## architecture — Architecture

Walls, mouldings, floors, vaults, roofs and repeated pieces generated at load from parameters: profiles swept along paths, things repeated along paths, and fills, on one trim sheet (Materials slot "architecture").

- Category: Rendering
- Added: from "+ Add component", starting as `{"profiles":{"wall":{"points":[[0.1,0],[0.1,3],[-0.1,3],[-0.1,0]],"slots":["lower_wall","bevel","upper_wall"]}},"elements":[{"id":"wall","kind":"sweep","path":{"points":[[0,0,0],[6,0,0]]},"profile":"wall"}]}`
- On prefab objects: no
- Cannot share an object with [`blockLayer`](components-rendering-1.md#component-blockLayer): generated architecture is its own object beside the level geometry
- Cannot share an object with [`terrain`](components-rendering-1.md#component-terrain): generated architecture is its own object beside the level geometry
- Cannot share an object with [`spline`](components-rendering-1.md#component-spline): generated architecture is its own object beside the level geometry

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `elements` | JSON: `ArchitectureElement[]` ([ArchitectureElement](types-a-d.md#type-architecture-element)) |  |  | **Elements.** Sweeps {id, kind: "sweep", path, profile, openings?}, repeats {id, kind: "repeat", path, spacing, piece} and fills {id, kind: "fill", path, shape, slot}. (required; scripts read) |
| `profiles` | JSON: `Record<string, ArchitectureProfile>` ([ArchitectureProfile](types-a-d.md#type-architecture-profile)) |  |  | **Profiles.** Named cross-sections {points: [[across, up], …], slots: [row per segment], closed?, smooth?, chamfer?}. (scripts read) |
| `overrides` | JSON: `ArchitectureOverride[]` ([ArchitectureOverride](types-a-d.md#type-architecture-override)) |  |  | **Overrides.** Kit models in place of a segment or a corner: [{element, segment \| corner, model: {assetId}}]. (scripts read) |
| `outlines` | JSON: `ArchitectureOutline[]` ([ArchitectureOutline](types-a-d.md#type-architecture-outline)) |  |  | **Outlines.** Rooms (closed) and runs (open) styled by presets: [{id, path, preset, openings?, outside?, storeys?, storeyHeight?, holes?, stairs?}] (the preset's style graph makes their elements; a block layer's Rooms tool draws them). (scripts read) |
| `buildings` | JSON: `ArchitectureBuilding[]` ([ArchitectureBuilding](types-a-d.md#type-architecture-building)) |  |  | **Buildings.** Rooms with a roof: [{id, path, preset, outside?, storeys?, openings?, roof?: {shape, rise?, overhang?, slot?}, interior?: {scene, offset?}}] (the Rooms tool draws them). (scripts read) |
| `masks` | JSON: `Record<string, ArchitectureMask>` ([ArchitectureMask](types-a-d.md#type-architecture-mask)) |  |  | **Masks.** Painted masks presets read: {name: {points: [[x, z, radius, weight], …]}}. (scripts read) |
| `chunkSize` | number | `16` | 4 – 1024, step 1, m | **Chunk size.** Metres a generated chunk covers (one draw per material each). (scripts read) |
| `seed` | int | `0` | 0 – 4294967295, step 1 | **Seed.** Seeds the variation of repeated copies. (scripts read) |
| `ao` | object |  |  | **Baked AO.** Vertex ambient occlusion in inside corners and where walls meet the ground. (scripts read) |
| `ao.strength` | number | `0.6` | 0 – 1, step 0.05 | **Strength.** How dark a right-angled inside corner gets (0: none). |
| `ao.radius` | number | `0.5` | 0.01 – 10, step 0.05, m | **Radius.** Metres the darkening reaches. |
| `lodDistance` | number | `40` | 0 – 100000, step 1, m | **Far level from.** Metres from the camera where detail (mouldings, frames, chamfers) is left out. (scripts read) |
| `castShadow` | bool | `true` |  | **Casts shadows.** Blocks the directional light. (scripts read) |
| `receiveShadow` | bool | `true` |  | **Receives shadows.** Shows the shadows falling on it. (scripts read) |
| `layer` | string, ≤ 128 chars |  |  | **Block layer.** The block layer object the rooms are drawn on: their walls block its grid walks, rooms are its regions, its wall paint shows on them. (scripts read) |
| `decalLayers` | int | `255` | 0 – 255, step 1 | **Decal layers.** The decal layers projected decals mark it in: a decal marks it when their layers share one (none: no projected decal marks it). Absent: every layer. (stored only when not the default; scripts read) |
| `baked` | string, sha256, 64 chars |  |  | **Shipped meshes.** SHA-256 of the generated meshes an export shipped (written by the export). (written by a tool; scripts read; format sha256) |
