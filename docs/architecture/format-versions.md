# Format versions — the register

Every stored or exchanged format with a version number, where the number lives, and what it was last raised
for where that is recorded. A phase that raises one edits its row in the same commit and writes the owner's note
where the format is an owner hard stop (the voxel formats: `voxel-format-spec.md`, `voxel-render-spec.md`,
`voxel-kit-format.md`). "—" in the last column: not traced when this page was written (2026-11-13); see
`git log -S` on the constant.

## Voxel world

| Format | Constant (package/file) | Value | Last raised for |
|---|---|---|---|
| Voxel world record | `VOXEL_WORLD_FORMAT` (workspace/voxel-world-manifest.ts) | 3 | structure grids listed in the manifest, F2 (47a.1; owner 2026-11-20) |
| Region file | `REGION_FORMAT_VERSION` (voxel/region-file.ts) | 2 | — |
| Palette codec | `PALETTE_CODEC_VERSION` (voxel/palette-codec.ts) | 2 | value v2 (45.10a) |
| Edit command | `VOXEL_EDIT_VERSION` (voxel/edit-command.ts) | 3 | the `flood` kind, the brush modes `smooth` and `flatten`, a `paint` that keeps each cell's role, G4 (47b.3; owner 2026-11-26). Add-only: version 2 is read as written (`VOXEL_EDIT_VERSIONS`); no command is stored, so no upgrade step |
| Undo record | `UNDO_RECORD_VERSION` (voxel/undo-store.ts) | 2 | — |
| Save file / base form codec | `SAVE_FORMAT_VERSION`, `BASE_FORM_CODEC_VERSION` (voxel/save-file.ts) | 2 / 2 | — |
| Structure overrides | `OVERRIDE_FORMAT_VERSION` (voxel/structure-overrides.ts) | 2 | from draft to used, F3 (47a.3; owner 2026-11-20); its layout also holds what a world-grid structure replaced, F5 (`voxels/<world>/structures/<object id>.tlvo`, before and written; 47a.11) |
| Building generator (a structure record's `generator`, F1) | `BUILDING_GENERATOR_VERSION` (voxel/structures/building.ts) | 1 | the first building generator (47a.3) |
| Derived data (never stored; a version of the rules) | `DERIVED_FORMAT_VERSION` (voxel/derived-data.ts) | 34 | the gas role open to every output, its mip rule, and three entries of the derived list (surface fields, the gas part, cover points), G1, G2, G6 (47b.2; owner 2026-11-26) |
| Piece table | `PIECE_TABLE_FORMAT` (voxel/piece-table.ts) | 5 | — |
| Far cache | `FAR_CACHE_FORMAT` (voxel/far-tree.ts) | 3 | the bake level: fine levels by region (46d.26) |
| Baked bricks blob | `FAR_BRICKS_BLOB_VERSION` (voxel/far-bricks-baked.ts) | 1 | — |
| Distance bricks | `DISTANCE_BRICKS_VERSION` (project-model/distance-bricks.ts) | 2 | — |
| Stream job | `STREAM_JOB_VERSION` (voxel/stream-job.ts) | 1 | — |
| Voxel kit | `VOXEL_KIT_FORMAT` (project-model/voxel-kit.ts) | 1 | kit format 1 (46c) |

Voxel values and stores are upgraded by the `liftVersion` chain in `@thirdlight/voxel`; proposals waiting for the
owner are listed in `docs/decisions/owner-decisions.md`.

**The voxel value's roles** are not a version: `VOXEL_ROLE_COUNT` (voxel/record.ts) is 11 since the `gas` role, value
10 of the existing role bits (G1, 47b.2; owner 2026-11-26). Record value form 2 and every stored version above stand:
a world written before it holds no value 10 and reads as before; a build before it refuses a world that holds one.

## Project, content and protocol

| Format | Constant (package/file) | Value |
|---|---|---|
| Project schema | `PROJECT_SCHEMA_VERSION` (project-model/project-schema.ts) | 8 (the `voxelStructure` component, F1, added within it: add-only, 47a.4; owner 2026-11-20. The `voxelPortal` component, F4, added within it: add-only, 47a.7; owner 2026-11-20: `voxelPortal: { open: false, stops: { light: true, sight: true, walk: true } }` on a prop standing in a structure's opening as the structure's child, the opening's record naming it (`openings[].prop`); open or shut is state, never voxels; a pane of glass stops no light; a script flips `open` and a game saves it as any written field; no door behaviour in the engine; a share of light passed is not in it (D741). The `waterBody` component, F6, added within it: add-only, 47a.10; owner 2026-11-20: `waterBody: { world, level, material, reach }` (level in metres, the liquid's material id, reach in metres, default 256), the seed the object's own position; its liquid voxels written by the level fill from the seed through every non-solid cell below the level, bounded by solid voxels and the reach, the top cells at their partial fill (16 levels); a body owns the liquid of its material connected to its seed (regenerate clears it and fills again, no cell list stored, liquid painted against it becomes part of it); in the editor a ground edit or a structure regenerated inside its reach writes it again in the same undo step (ground, buildings, water, R41); a breach writes nothing past the bound and is flagged (a warning on the object, a marker where it leaks), reported, never stored; exports ship the liquid voxels, never the record; nothing regenerates at run time. The `spline` component's `voxels` section, F5, added within it: add-only, 47a.11; owner 2026-11-20: `voxels: { kind: "road" | "path" | "river", material, bed?: { material, depth }, shoulder?: { width, slope }, clear?: height }` (the surface or a river's liquid material; what lies under a road, a river's bed material and depth; how the sides meet the ground; air cleared above); the per-point width that exists is used and a river's surface follows the spline's height; the heightfield `terrain` section is untouched; the record of what it replaced is spec §3.5's, authoring data, never exported. The voxel material use `gas` and its look `voxel.gas: { color?, density? }`, G3, added within it: add-only, 47b.2; owner 2026-11-26: a fourth `voxel.use` beside construction, terrain and liquid, with two fields for the plain look, the colour and the full density per metre (render spec §1)) |
| Content storage | `CONTENT_STORAGE_VERSION` (workspace/store-v4.ts) | 5 |
| Asset sidecar | `SIDECAR_FORMAT` (workspace/asset-files.ts) | 3 |
| Resource file | `RESOURCE_FORMAT` (workspace/resource-files.ts) | 1 |
| Runtime content manifest | `RUNTIME_CONTENT_MANIFEST_VERSION_5` (project-model/manifest-v5.ts) | 5 (a world row's `grids`, F2, added within it: add-only, 47a.4) |
| Game save | `PROJECT_SAVE_FORMAT_VERSION` (project-model/save-schema.ts) | 2 |
| Binary container | `BINARY_CONTAINER_VERSION` (project-model/binary-container.ts) | 1 |
| Decal clip | `DECAL_CLIP_VERSION` (project-model/decal-clip.ts) | 1 |
| Surface light bake | `SURFACE_BAKE_VERSION` (three-adapter/surface-bake-file.ts) | 1 |
| Action frames (replays) | `ACTION_FRAME_VERSION` (runtime/actions.ts) | 2 |
| Editor bridge | `BRIDGE_VERSION` (protocol/bridge.ts) | 2 |
| Behaviour API / game host API | `BEHAVIOR_API_VERSION`, `GAME_HOST_API_VERSION` | 1 / 1 |
| Ownership store, retry record | `OWNERSHIP_STORAGE_VERSION`, `RETRY_RECORD_VERSION` (workspace) | 1 / 2 |

Retiring with phase 48: `BLOCK_CHUNK_BINARY_VERSION` 4, `ARCHITECTURE_GENERATOR_VERSION` 4.
