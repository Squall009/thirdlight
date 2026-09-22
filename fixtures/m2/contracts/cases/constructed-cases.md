# Constructed content-storage cases (packet 15)

Cases that cannot be expressed as small committed JSON fixtures, because they
need hundreds of records or tens of megabytes of bytes. They follow the
project-model `runtime/non-finite-cases.md` / `byte-input-cases.md` precedent:
the case is specified here and the limit it exercises lives in
`docs/planning/m2-contracts/content-storage.md` §9 and
`docs/planning/m2-contracts/assets.md` §6/§7.

Everything here is **PROPOSED** (pending Gate E) and, like the declarative
`cases/*.json`, is not executable until packets 23/24 implement the operations.
Each case names the exact code and the exact bound so the implementing packet
cannot pick a different threshold after observing a result.

## C1 — catalog count caps

| # | Constructed state | Expected |
|---|---|---|
| C1.1 | a content block with exactly 128 assets (the cap) | valid |
| C1.2 | 129 assets | `content_invalid` → `limits_exceeded` with `limit: "assets"`, path `/content/assets/128`; the previous catalog is untouched |
| C1.3 | one asset with exactly 32 versions (the cap) | valid |
| C1.4 | one asset with 33 versions | `content_invalid` → `limits_exceeded` with `limit: "asset_versions"` |
| C1.5 | 1 024 total version records (the cap), spread over the catalog | valid |
| C1.6 | 1 025 total version records | `content_invalid` → `limits_exceeded` with `limit: "version_records"` |

## C2 — content-block byte budget

| # | Constructed state | Expected |
|---|---|---|
| C2.1 | a canonical `content` block of exactly 1 048 576 bytes | valid |
| C2.2 | a canonical `content` block of 1 048 577 bytes (reachable with ~1 024 long display names) | workspace `content_invalid` → `limits_exceeded` with `limit: "content_bytes"`; the envelope is **not** written and the previous revision/content stays authoritative |
| C2.3 | the same oversize block produced by a publish | `content_publish_failed`? **No** — the budget is a pre-commit validation, so the result is the C2.2 validation failure with no durable effect. A blob already published in that attempt stays as unreferenced bytes (documented, never acked) |

## C3 — source/staging byte caps

| # | Constructed state | Expected |
|---|---|---|
| C3.1 | staged source of exactly 33 554 432 bytes | accepted by the stage caps; then subject to the import profile |
| C3.2 | staged source of 33 554 433 bytes | `stage_limits_exceeded` (`limit: "stage_bytes"`); the stage file is **not** written at all (the cap is enforced while framing the upload, before the file is created) |
| C3.3 | 9 concurrently open stages for one project | `stage_limits_exceeded` (`limit: "open_stages"`); existing stages are unaffected |
| C3.4 | staged bytes for one project totalling 134 217 729 bytes | `stage_limits_exceeded` (`limit: "staged_bytes_per_project"`) |
| C3.5 | the same bytes duplicated across 9 stage directories | the per-project byte cap is measured over all live stage directories, not per stage |

## C4 — quota and device space

| # | Constructed state | Expected |
|---|---|---|
| C4.1 | retained authoritative bytes + the new blob exactly equal `maxSourceBytesPerProject` | accepted |
| C4.2 | one byte over | `content_quota_exceeded` (`kind: "project_quota"`, with used/limit/digest fields) **before** any write |
| C4.3 | project quota satisfied but free device space < `blobBytes + 67 108 864` | `content_quota_exceeded` (`kind: "device_space"`) before any write |
| C4.4 | free space falls below the floor *between* the pre-flight check and the blob write (injected ENOSPC) | `content_publish_failed` (fixture `publish-enospc-during-blob.json`); the envelope is unchanged and the leftover temp is removed on the next open |
| C4.5 | quota exhaustion is permanent in M2 (no blob deletion exists) | reported as the documented M2 limitation: the operator raises the configured quota or removes the whole project; the backend never evicts retained versions to make room |

## C5 — path and symlink trees

| # | Constructed state | Expected |
|---|---|---|
| C5.1 | `sources/` is a real directory, `sources/sha256` is a real directory | normal operation |
| C5.2 | `sources/sha256` replaced by a symlink to a directory outside the project | `path_rejected` on the first read **and** on the first publish; the link is never followed and never repaired |
| C5.3 | `sources/sha256/<digest>` is a symlink to the correct bytes elsewhere | `path_rejected` (authoritative blobs are opened with `O_NOFOLLOW`); the target is not read |
| C5.4 | `.thirdlight/staging/<stageId>` is a symlink | `path_rejected`; nothing is written through it |
| C5.5 | a stage directory containing extra hard links to a staged file | the stage bytes are read once, hashed, and published under the digest; extra names are irrelevant (the published blob is a new immutable file, never a link to the staged inode) |
| C5.6 | `<project>` itself reached through a symlinked data root | the project realpath is resolved once at open; every artifact path is checked to stay under it |

## C6 — frames and jobs

| # | Constructed state | Expected |
|---|---|---|
| C6.1 | an upload frame of exactly 1 048 576 bytes | accepted; a 32 MiB source is 32 frames |
| C6.2 | an upload frame of 1 048 577 bytes | `stage_limits_exceeded` (`limit: "frame_bytes"`) |
| C6.3 | an `ImportProposal` response above 262 144 bytes (bounded name lists truncated, with a `truncated` flag) | never produced: proposal name lists are truncated to the bound instead |
| C6.4 | an inspection that exceeds 30 s wall clock | `import_rejected` (`reason: "timeout"`), no blob, no envelope change |
| C6.5 | a publish that exceeds 120 s wall clock between the blob phase and the commit | cancelled at the next phase boundary with `content_publish_failed` (`reason: "timeout"`); nothing durable is half-written because each phase is atomic |
| C6.6 | 3 concurrent publishes for one project, 5 globally | the third project-level request is refused with `content_publish_failed` (`reason: "busy"`); the mutation lock is never held while waiting for the job cap |

## C7 — integrity and derived caches

| # | Constructed state | Expected |
|---|---|---|
| C7.1 | a referenced blob present with the correct digest | open reports `contentIntegrity: { ok: true }` |
| C7.2 | one referenced blob missing; unrelated operations continue | `contentIntegrity` lists `{ assetId, version, status: "missing" }`; `readBlob` fails `blob_missing`; the project is not blocked and the envelope is never rewritten |
| C7.3 | one referenced blob present but with different bytes | `{ status: "corrupt" }` + `blob_corrupt` on read; the tampered bytes are retained |
| C7.4 | an unreferenced (superseded/retention-only) blob missing | reported as `{ status: "missing", referenced: false }`; not an error for play (nothing pins it) but never silently deleted evidence either |
| C7.5 | `.thirdlight/derived/**` present but truncated/corrupt | `derived_cache_unavailable`; regenerated from the pinned recipe; no revision change |
| C7.6 | `.thirdlight/derived/**` regenerated while a play session is running | play reads the captured view + `sources/` only; its bytes and digest are unchanged |

## C8 — storageVersion / version-combination matrix

| # | storageVersion | scene.schemaVersion | manifest.schemaVersion | Expected |
|---|---|---|---|---|
| C8.1 | 1 | 1 | 1 | valid (M1 path, unchanged; see `fixtures/commands/envelope/`) |
| C8.2 | 2 | 2 | 1 | valid (the only M2 combination) |
| C8.3 | 2 | 1 | 1 | `version_combination_unsupported` (single error) |
| C8.4 | 2 | 2 | 2 | `manifest_invalid` → `schema_version_unsupported` for the manifest (the v2 envelope's combination check passes, the manifest stays v1) |
| C8.5 | 1 | 2 | 1 | `scene_invalid` → `schema_version_unsupported` (M1 path is unchanged; the M1 scene validator knows `[1]`) |
| C8.6 | 3 | 2 | 1 | `storage_version_unsupported` (single error, bytes retained) |
| C8.7 | 1 | 1 | 1, opened by an M1-only engine that lacks `sources/` | unchanged M1 behavior; content paths are never consulted |

## C9 — packet-16 prefab / property boundaries (PROPOSED, pending Gate E)

Appended by packet 16. Normative text: `docs/planning/m2-contracts/prefabs.md`
§5/§7.2/§7.3 and `docs/planning/m2-contracts/properties.md` §4. The
machine-readable list is `fixtures/m2/contracts/commands/prefab-failures.json`
(`constructed`); every case leaves the durable state byte-identical.

| # | Constructed state | Expected |
|---|---|---|
| C9.1 | a definition with exactly 256 local entities | valid |
| C9.2 | a definition with 257 local entities | `limits_exceeded` (`limit: "prefab_entities"`, current 257, max 256) |
| C9.3 | a definition of depth 16 | valid |
| C9.4 | a definition of depth 17 | `limits_exceeded` (`limit: "prefab_depth"`, 17/16) |
| C9.5 | a canonical definition of exactly 131 072 bytes | valid |
| C9.6 | a definition above 131 072 canonical bytes | `limits_exceeded` (`limit: "prefab_bytes"`) |
| C9.7 | 128 definitions in `content.prefabs` (the cap) | valid |
| C9.8 | a 129th definition | `limits_exceeded` (`limit: "prefabs"`) |
| C9.9 | instantiation that takes the scene to exactly 1024 entities | valid |
| C9.10 | instantiation that would take it past 1024 | `limits_exceeded` (`limit: "entities"`); nothing is created |
| C9.11 | instantiation under a depth-32 parent with a depth-2 definition | `limits_exceeded` (`limit: "depth"`); nothing is created |
| C9.12 | a request whose canonical bytes are exactly 65 536 | accepted; 65 537 → `limits_exceeded` (`limit: "request_bytes"`) before argument validation |
| C9.13 | a declaration with 32 properties (the cap) / 33 | valid / `limits_exceeded` (`limit: "properties"`) |
| C9.14 | 32 enum members (the cap) / 33 | valid / `limits_exceeded` (`limit: "enum_values"`) |
| C9.15 | a `string` property with `maxLength` 1024 (the cap) and a 1024-character value | valid; 1025 characters → `property_value` (the declaration bound itself may not exceed 1024) |
| C9.16 | 64 overrides (the cap) / 65 | valid / `limits_exceeded` (`limit: "overrides"`) |
| C9.17 | 32 settings keys (the cap, once packet 17 pins a registry) / 33 | valid / `limits_exceeded` (`limit: "settings_keys"`) |
| C9.18 | every `group-NNNN` ID in `0001..9999` taken and an instantiation whose root derives the `group` prefix | `id_exhaustion` (`kind: "group"`); no partial subtree and no revision change |
| C9.19 | a prefab definition whose `entityRef` value names a `localId` that is removed by an accepted fallback | not representable: definitions are immutable, and `validateContent` rejects an unresolved local reference (`reference_missing`) rather than repairing it |

## C10 — packet-17 runtime/input/physics boundaries (PROPOSED, pending Gate E)

Appended by packet 17. Normative text:
`docs/planning/m2-contracts/{input,physics,platformer}.md` §7/§10/§9 and
`docs/planning/m2-contracts/diffs/runtime.md`. The machine-readable lists are
`fixtures/m2/contracts/{input/action-sequences,physics/numerics,platformer/traces,
platformer/failures,runtime/catchup}.json`; those fixtures are replayed by
`tools/check-fixtures.mjs` (check groups `p17-*`), so every row below already has
an executable equivalent where a small fixture suffices.

| # | Constructed state | Expected |
|---|---|---|
| C10.1 | a scene whose only floor body is 1 000 m wide, 64 static boxes and one capsule | valid; the physics caps are shape/vertex based, not byte based |
| C10.2 | 257 `components.collider` entities | valid at the document level, but the adapter build fails with `limits_exceeded` (`limit: "colliders"`, current 257, max 256) before any world is created |
| C10.3 | one polygon with 8 vertices (the cap) / 9 vertices | valid / `limits_exceeded` (`limit: "collider_vertices"`) |
| C10.4 | 128 polygons of 8 vertices (1 024 polygon vertices, the cap) / one more vertex | valid / `limits_exceeded` (`limit: "collider_vertices_total"`) |
| C10.5 | 1 024 static colliders each with 8 vertices | `limits_exceeded` (`limit: "colliders"`) before the vertex cap |
| C10.6 | a polygon with two vertices 1e-7 m apart (self-degenerate) | `collider_shape_invalid` (area below 1e-6 m²) |
| C10.7 | a polygon whose vertices are counter-clockwise but nearly collinear at every vertex | `collider_shape_invalid` unless the signed area is ≥ 1e-6 m² and each cross product has a consistent sign within 1e-9 |
| C10.8 | a polygon with coordinates at ±1e6 m | `number_out_of_range` |
| C10.9 | a `components.controller` entity at 800 m from the nearest collider | valid; the character simply free-falls to the maximum fall speed; no teleport or "rescue" logic exists in M2 |
| C10.10 | a character standing on a 43° ramp with `moveX = 0` and `min_slope_slide_deg = 30` | slides down (grounded but idle-sliding); with `moveX = 1` it can climb (packet 14 T4) |
| C10.11 | a 47° ramp with `moveX = 1` for 1 s | height gain ≤ 0.3 m (packet 14 T5 measured 0.0067 m) |
| C10.12 | a 20 000-step flat-ground run with `moveX` alternating every step | every step grounded, Y unchanged, `position.z` bit-identical; no accumulated drift in the authoritative trace |
| C10.13 | a 10-minute play session (72 000 steps) with one 30 s stall | `droppedSteps` > 0 and each stall frame executes ≤ 8 steps; no step index repeats and no frame is sampled twice |
| C10.14 | 64 recorded action frames with `pressed` at every step | the controller starts at most one jump per landing; the phase chain validator rejects the sequence at source construction (`input_frame_invalid`) before any step runs |
| C10.15 | a recorded sequence whose frames start at `stepIndex` 500 (a resumed replay) | every index below 500 is a neutral frame; the settle pre-roll is unaffected (it happens before any sampling) |
| C10.16 | an `ActionSource` that returns a frame whose `stepIndex` does not match the sampled index | `module_error` (`reason: "input_frame_invalid"`) at that step → fail-stop; the last completed render state is retained |
| C10.17 | a 1e6-vertex polygon stream fed through the import path | rejected by the polygon vertex cap before allocation; no adapter state is created |

## C11 — packet-18 behavior source/compilation/execution boundaries (PROPOSED, pending Gate E)

Appended by packet 18. Normative text: `docs/planning/m2-contracts/behaviors.md`
§3/§4/§6/§9/§10 and `docs/planning/m2-contracts/diffs/runtime.md` §"Packet 18
additions". The machine-readable lists are
`fixtures/m2/contracts/behaviors/{source-graphs,intents,runtime-failures,
publication-cases}.json`; those fixtures are replayed by
`fixtures/m2/contracts/tools/check-fixtures.mjs` (check groups `p18-*`), so every
row below already has an executable equivalent where a small fixture suffices.

| # | Constructed state | Expected |
|---|---|---|
| C11.1 | a source graph with exactly 16 files / 17 files (cap 16) | valid / `behavior_source_limits_exceeded` (`limit: "files"`); the check precedes any parse |
| C11.2 | a 65 536-byte file / a 65 537-byte file (cap 65 536) | valid / `behavior_source_limits_exceeded` (`limit: "file_bytes"`), reported before the file text is parsed |
| C11.3 | a 262 144-byte container / one byte more (cap 262 144) | valid / `behavior_source_limits_exceeded` (`limit: "graph_bytes"`) |
| C11.4 | import depth 8 / 9 (cap 8) | valid / `behavior_source_limits_exceeded` (`limit: "import_depth"`) |
| C11.5 | 16 import declarations in one file / 17 (cap 16) | valid / `behavior_source_limits_exceeded` (`limit: "imports"`) |
| C11.6 | 16 `ownedTransforms` entries / 17 (cap 16) | valid / `behavior_source_limits_exceeded` (`limit: "owned_transforms"`) |
| C11.7 | a compile that takes 2 000 ms / 2 001 ms (bound 2 000) | valid / `behavior_compile_timeout`; the timeout is cooperative and reports a failed preparation, never a partial artifact |
| C11.8 | a compiler internal failure with 40 diagnostics (cap 32) | `behavior_compile_failed`, 32 diagnostics stored and `truncated: true` |
| C11.9 | 131 072 output bytes / 131 073 (cap 131 072) | valid / `behavior_output_limits_exceeded` (`limit: "output_bytes"`) |
| C11.10 | an output containing `fetch(` (pattern d) | `behavior_output_forbidden_content` (`reason: "d"`); the scan is defense in depth, not a sandbox |
| C11.11 | a `requiredModules` entry outside the pinned set / a duplicated entry | `behavior_import_unpinned` / `behavior_source_invalid` (`reason: "duplicate"`) |
| C11.12 | a TypeScript syntax error in the entry | `behavior_source_invalid` (`reason: "syntax"`) |
| C11.13 | a container whose byte bound is exceeded **and** whose `requiredModules` is unpinned | `behavior_source_limits_exceeded` (`limit: "graph_bytes"`): the byte bound is validation step 7, the pinned-set check step 8 |
| C11.14 | 14 instances committing 70 intents in one step (cap 64) | fail-stop `module_error` (`reason: "behavior_intent_limit"`, `detail: "per_step"`); the 65th commit is the first failure |
| C11.15 | one instance committing 6 intents in one step (closed maximum 5) | fail-stop `module_error` (`reason: "behavior_intent_limit"`, `detail: "per_instance"`) |
| C11.16 | 1 000 `ctx.log` calls in one step (per-step cap 16, ring 32) | `logCount` 1 000, `logDropped` 984, 16 entries retained, `errorCount` unchanged; the diagnostics payload cannot grow |
| C11.17 | one `ctx.log` call per step for 40 steps (ring 32) | `logCount` 40, `logDropped` 0, 32 entries retained (the ring keeps the last 32) |
| C11.18 | a behavior emitting an intent for an entity it does not own, in the transform phase | fail-stop `module_error` (`reason: "behavior_transform_forbidden"`, `detail: "not_owner"`) |
| C11.19 | a behavior holding a transform lock for an entity that carries a `collider`/`controller` component | `transform_owner_forbidden` (`reason: "behavior_ownership_forbidden"`, `detail: "physics_entity"`) at instantiate: no instance, no port use |
| C11.20 | a published `source` whose derived build artifact was deleted, then played | `behavior_publication_unavailable` (`reason: "preparation_missing"`); the publication, revision and last good artifact are untouched, and a re-preparation regenerates the artifact |
| C11.21 | a full-snapshot build failure after a valid source publication | the publication stands (`+1` revision), the previous immutable build artifact stays servable, and the new revision is not playable until a build succeeds (`behavior_build_failed`, `reason: "link"`) — distinct from a preparation failure, which publishes nothing |
| C11.22 | a `publishBehavior{mode:"source"}` with no registered preparer | `behavior_publication_unavailable` (`reason: "preparer_unavailable"`) before any stage resolution, digest check or argument validation; no revision change |
| C11.23 | 64 acknowledged trust entries / 65 (cap 64) | valid / `limits_exceeded` (`limit: "trust_entries"`) |
| C11.24 | an acknowledgment whose `sourceDigest` matches no behavior record | valid and inert: an unreferenced acknowledgment is history, exactly like an unreferenced blob; it is not garbage-collected in M2 |
| C11.25 | a source graph whose only file is a `.tsx` file | `behavior_source_invalid` (`reason: "extension"`); M2 has no JSX/UI dependency in behavior code |
