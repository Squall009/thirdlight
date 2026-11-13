# Format versions — the register

Every stored or exchanged format with a version number, where the number lives, and what it was last raised
for where that is recorded. A phase that raises one edits its row in the same commit and writes the owner's note
where the format is an owner hard stop (the voxel formats: `voxel-format-spec.md`, `voxel-render-spec.md`,
`voxel-kit-format.md`). "—" in the last column: not traced when this page was written (2026-11-13); see
`git log -S` on the constant.

## Voxel world

| Format | Constant (package/file) | Value | Last raised for |
|---|---|---|---|
| Voxel world record | `VOXEL_WORLD_FORMAT` (workspace/voxel-worlds.ts) | 2 | — |
| Region file | `REGION_FORMAT_VERSION` (voxel/region-file.ts) | 2 | — |
| Palette codec | `PALETTE_CODEC_VERSION` (voxel/palette-codec.ts) | 2 | value v2 (45.10a) |
| Edit command | `VOXEL_EDIT_VERSION` (voxel/edit-command.ts) | 2 | — |
| Undo record | `UNDO_RECORD_VERSION` (voxel/undo-store.ts) | 2 | — |
| Save file / base form codec | `SAVE_FORMAT_VERSION`, `BASE_FORM_CODEC_VERSION` (voxel/save-file.ts) | 2 / 2 | — |
| Structure overrides (draft, no users) | `OVERRIDE_FORMAT_VERSION` (voxel/structure-overrides.ts) | 2 | — |
| Derived data (never stored; a version of the rules) | `DERIVED_FORMAT_VERSION` (voxel/derived-data.ts) | 31 | narrow openings closing in the downsample (46d.7a) |
| Piece table | `PIECE_TABLE_FORMAT` (voxel/piece-table.ts) | 5 | — |
| Far cache | `FAR_CACHE_FORMAT` (voxel/far-tree.ts) | 3 | the bake level: fine levels by region (46d.26) |
| Baked bricks blob | `FAR_BRICKS_BLOB_VERSION` (voxel/far-bricks-baked.ts) | 1 | — |
| Distance bricks | `DISTANCE_BRICKS_VERSION` (project-model/distance-bricks.ts) | 2 | — |
| Stream job | `STREAM_JOB_VERSION` (voxel/stream-job.ts) | 1 | — |
| Voxel kit | `VOXEL_KIT_FORMAT` (project-model/voxel-kit.ts) | 1 | kit format 1 (46c) |

Voxel values and stores are upgraded by the `liftVersion` chain in `@thirdlight/voxel`; proposals waiting for the
owner are listed in `docs/decisions/owner-decisions.md`.

## Project, content and protocol

| Format | Constant (package/file) | Value |
|---|---|---|
| Project schema | `PROJECT_SCHEMA_VERSION` (project-model/project-schema.ts) | 8 |
| Content storage | `CONTENT_STORAGE_VERSION` (workspace/store-v4.ts) | 5 |
| Asset sidecar | `SIDECAR_FORMAT` (workspace/asset-files.ts) | 3 |
| Resource file | `RESOURCE_FORMAT` (workspace/resource-files.ts) | 1 |
| Runtime content manifest | `RUNTIME_CONTENT_MANIFEST_VERSION_5` (project-model/manifest-v5.ts) | 5 |
| Game save | `PROJECT_SAVE_FORMAT_VERSION` (project-model/save-schema.ts) | 2 |
| Binary container | `BINARY_CONTAINER_VERSION` (project-model/binary-container.ts) | 1 |
| Decal clip | `DECAL_CLIP_VERSION` (project-model/decal-clip.ts) | 1 |
| Surface light bake | `SURFACE_BAKE_VERSION` (three-adapter/surface-bake-file.ts) | 1 |
| Action frames (replays) | `ACTION_FRAME_VERSION` (runtime/actions.ts) | 2 |
| Editor bridge | `BRIDGE_VERSION` (protocol/bridge.ts) | 2 |
| Behaviour API / game host API | `BEHAVIOR_API_VERSION`, `GAME_HOST_API_VERSION` | 1 / 1 |
| Ownership store, retry record | `OWNERSHIP_STORAGE_VERSION`, `RETRY_RECORD_VERSION` (workspace) | 1 / 2 |

Retiring with phase 48: `BLOCK_CHUNK_BINARY_VERSION` 4, `ARCHITECTURE_GENERATOR_VERSION` 4.
