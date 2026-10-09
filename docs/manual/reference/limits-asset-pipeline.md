# Limits and defaults: asset-pipeline

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/asset-pipeline` defines, by source file. Values are the running build's.

<a id="limits-asset-pipeline--inspect-font"></a>
## `inspect-font.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-font-family-name-max"></a>`FONT_FAMILY_NAME_MAX` | `64` | Longest family name kept (characters). |
| <a id="limit-font-source-bytes-max"></a>`FONT_SOURCE_BYTES_MAX` | `4194304` | Largest font file accepted (bytes). An engine limit, not a format one: the whole file is held in memory by the page and parsed by the browser at load, and 4 MiB covers a full Latin/Greek/Cyrillic family member with hinting. |
| <a id="limit-font-tables-max"></a>`FONT_TABLES_MAX` | `128` | Most tables a font's directory may list (real fonts carry about 10–30). |

<a id="limits-asset-pipeline--inspect-image"></a>
## `inspect-image.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-texture-edge-max"></a>`TEXTURE_EDGE_MAX` | `4096` | Largest texture edge (pixels). |
| <a id="limit-texture-source-bytes-max"></a>`TEXTURE_SOURCE_BYTES_MAX` | `16777216` | Largest texture file accepted (bytes). |

<a id="limits-asset-pipeline--limits"></a>
## `limits.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-animation-profile-max-clip-ms"></a>`ANIMATION_PROFILE_MAX_CLIP_MS` | `10000` |  |
| <a id="limit-animation-profile-max-clips"></a>`ANIMATION_PROFILE_MAX_CLIPS` | `8` |  |
| <a id="limit-animation-profile-max-track-times"></a>`ANIMATION_PROFILE_MAX_TRACK_TIMES` | `4096` |  |
| <a id="limit-animation-profile-max-tracks"></a>`ANIMATION_PROFILE_MAX_TRACKS` | `64` |  |
| <a id="limit-animation-profile-max-tracks-per-clip"></a>`ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP` | `32` |  |
| <a id="limit-m2-gltf-max-diagnostics"></a>`M2_GLTF_MAX_DIAGNOSTICS` | `10` | At most this many diagnostics are returned, plus the true count. |
| <a id="limit-m2-gltf-profile-limits"></a>`M2_GLTF_PROFILE_LIMITS` | `{"source_bytes":33554432,"json_chunk_bytes":8388608,"image_bytes":33554432,"nodes":4096,"meshes":1024,"primitives":8192,"materials":512,"images":64,"textures":512,"vertices":2000000,"triangles":4000000,"animations":256,"animation_channels":16384,"clip_duration":600000,"decoded_bytes":268435456,"total_decoded_bytes":536870912,"diagnostics":10}` | Decoded-resource caps keyed by the `limits_exceeded` limit name. |

<a id="limits-asset-pipeline--simplify"></a>
## `simplify.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-mesh-simplify-error-default"></a>`MESH_SIMPLIFY_ERROR_DEFAULT` | `0.01` | How far level 1 (half the triangles) may move the surface: 1 % of the mesh's extent. A coarser level is shown smaller on screen, so its bound grows with it: level n may deviate `MESH_SIMPLIFY_ERROR_DEFAULT × 0.5 / ratio` (2 % at a quarter, 4 % at an eighth). |
