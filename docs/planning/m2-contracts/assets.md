PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Thirdlight — Asset Identities, Content Catalog and the M2 GLB Import Profile

**PROPOSED — pending Gate E.** Companion to
[`content-storage.md`](content-storage.md) (paths, staging, publication, migration);
both are packet 15 outputs. Section-level contract changes are in
[`diffs/project-model.md`](diffs/project-model.md) and
[`diffs/workspace.md`](diffs/workspace.md). Nothing in `docs/contracts/` changes
until the Gate E promotion step.

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

---

## 1. Scope and ownership

This section defines **what an asset is, how its identity survives reimport,
what is persisted about it, what the M2 importer may accept, and how a running
play or an export pins content**. It does not define the importer implementation
(packet 24), the placement component's full field set (packets 16/20), prefab or
behavior records (packets 16/18), or any transport (packet 25).

| Unit | Owns |
|---|---|
| `project-model` | `ContentCatalog`, `AssetRecord`, `AssetVersion`, `ImportRecipe`, `AssetMetrics`, `CapturedContent`, `validateContent`/`normalizeContent`/`validateProjectV2`, `captureContent`, the new model error codes |
| new `asset-pipeline` (packet 24) | `inspectGlb(bytes, options) → ImportProposal`, the import diagnostics, the profile constants and the extension allowlist |
| `workspace` | which digest is authoritative, blob paths, catalog commits, `readBlob`/`contentIntegrity`/`captureContentView` (`content-storage.md` §13) |
| `commands` (packets 21/23) | the content mutation's args, inverse/history, retry serialization, projection, MCP coverage |

## 2. Version axes and the supported combination

Project-model §6's version taxonomy is unchanged and gains one document-specific
rule: **known versions are per document type** — manifest `[1]`, scene `[1, 2]`.
`KNOWN_VERSIONS` therefore becomes a per-document structure
(`diffs/project-model.md`). The content block introduces **no third version
axis**: it is versioned by the envelope's `storageVersion` (2), so a content-shape
change is a `storageVersion` change and never a silent same-version extension.

The only passable M2 combination is **manifest `schemaVersion` 1 + scene
`schemaVersion` 2 + storage `storageVersion` 2**; the exhaustive matrix,
including every mismatch outcome, is `content-storage.md` §3.1.

## 3. Asset identity model

Normative:

1. **`assetId` is opaque and independent** of file name, display name, content
   digest, import order and tool version. It is assigned exactly once, by the
   creating command's caller-supplied value (validated by the project-model §5.1
   ID syntax and uniqueness), and never regenerated: renaming, reimport,
   reordering, undo/redo, restore and retry all keep it.
2. **A scene references a whole GLB by `assetId`.** In v2 the reference value is
   `components.model.asset.assetId` (the minimal reference shape this packet
   pins because the catalog↔scene check depends on it; additional v2 component
   fields belong to packets 16/20 and require the §6 version discipline).
   The scene does **not** record a digest, a path, a version field per entity
   placement or a subresource reference.
3. **Internal glTF names and indices are not engine IDs.** Node names, mesh
   names, primitive/material/slot indices, clip names and joint order may change
   arbitrarily on reimport (including a version bump inside the file). They may be
   inspected and displayed (from the derived cache), but **no persisted value may
   reference them** — not in the scene, not in the catalog, not in a prefab, not
   in an export's identity. Reimport therefore never creates a false persistent
   reference when internal ordering changes (acceptance row A03).
4. **Versions, not placements, pin bytes.** `AssetRecord.versions[]` is an
   append-only list of immutable versions; `currentVersion` is the version that
   new and existing placements resolve through. A reimport appends one version and
   moves `currentVersion`; it never edits an existing version record and never
   rewrites a blob.
5. **Reimport keeps entity identity.** Referencing entities keep their entity
   IDs, names, transforms, hierarchy and every other component; only the resolved
   version changes. Undo of the reimport restores the previous `currentVersion`
   (the recorded inverse), and all versions and blobs remain on disk, so
   undo/redo can never be invalidated by content removal (M2 has no GC,
   `content-storage.md` §10).
6. **Failure preserves everything.** A rejected import, a failed publish, a
   conflict or a crash leaves the catalog, scene, revision, reference set and all
   previously published bytes unchanged.
7. **`assetId` is never reused.** M2 has no asset deletion; if a later version
   adds one it must add a tombstone/never-reuse rule (`content-storage.md` §10).

## 4. `ContentCatalog` and `AssetRecord`

The content block is the envelope's `content` member
(`content-storage.md` §3). It has no standalone file and no byte-parse entry
point (there is no place from which a second mutable catalog could be read).

### 4.1 `ContentCatalog`

| Field | Type | Required | Constraint |
|---|---|---|---|
| `assets` | array of `AssetRecord` | yes | 0–128 (cap); ascending `assetId` codepoint order in canonical form; `assetId` unique |
| `prefabs` | array | yes | `[]` in v2 — element shapes are packet 16's |
| `behaviors` | array | yes | `[]` in v2 — element shapes are packet 18's |
| `settings` | object | yes | `{}` in v2 — keys are packet 17's |

Canonical key order: `assets, prefabs, behaviors, settings`. Unknown fields ⇒
`field_unexpected` at any level.

### 4.2 `AssetRecord`

| Field | Type | Required | Constraint |
|---|---|---|---|
| `assetId` | string | yes | §3; ID syntax; unique within the catalog |
| `kind` | string | yes | exactly `"model"` in M2 (the whole-GLB model kind); other kinds are a future version |
| `displayName` | string | yes | 1–128 chars, no control characters; display only, renameable, never an identity |
| `currentVersion` | integer | yes | equals the **last** element's `version` (the list is contiguous) — a derived pointer; a disagreeing value is `field_value`, never normalized |
| `versions` | array of `AssetVersion` | yes | 1–32 (cap); strictly ascending, contiguous `1..N`; append-only in M2 (no gaps, no reorder, no removal) |

Canonical key order: `assetId, kind, displayName, currentVersion, versions`.

### 4.3 `AssetVersion`

| Field | Type | Required | Constraint |
|---|---|---|---|
| `version` | integer | yes | index `i` ⇒ value `i+1` |
| `sourceDigest` | string | yes | 64 lowercase hex; = SHA-256 of the complete source file; = the file name under `sources/sha256/` |
| `sourceByteLength` | integer | yes | 1 … 33 554 432; must equal the real blob length, verified at commit |
| `importRecipe` | `ImportRecipe` | yes | §5 |
| `metrics` | `AssetMetrics` | yes | §6; recorded by the bounded inspector and re-checked against the caps on load |
| `importedAt` | string | yes | project-model §7.2 timestamp format |
| `publishedRevision` | integer | yes | the revision this version landed at; equals the publication command's resulting revision; per-record history metadata, **never** used to infer current state (same rule as retry `appliedRevision`) |

Canonical key order: `version, sourceDigest, sourceByteLength, importRecipe,
metrics, importedAt, publishedRevision`.

Explicitly **not** stored in a version record: internal glTF names/indices
(§3.3), the source file name, the staging id, any absolute or project-relative
path, the import job/proposal id, the decoding wall time, and any preview image.

## 5. `ImportRecipe` and the derived-cache key

```json
{ "profile": "gltf-glb", "recipeVersion": 1, "toolchain": { "three": "0.186.0" }, "extensions": [] }
```

| Field | Type | Constraint |
|---|---|---|
| `profile` | string | exactly `"gltf-glb"` in M2 |
| `recipeVersion` | integer | exactly `1` in M2; advances when the recipe's *decisions* change (which extensions are decoded, which fields feed `metrics`, how quantization is handled) |
| `toolchain` | object | 1–8 entries `name → exact version string` (semver, project-model §6 regex where the tool uses one); keys sorted codepoint order; must name **every** tool whose version can change the decoded result (in M2: `three`, i.e. the pinned GLTFLoader major line). The repository's pinned versions are the only accepted values until a reviewed dependency change |
| `extensions` | array of string | ascending codepoint order; the extensions **actually used** by this source, each member of the profile allowlist (§7.3); `[]` when none |

Rules:

- The recipe is recorded per version, so the derived-cache key changes whenever
  the decoded result could change: `recipeDigest = SHA-256(canonical JSON of
  importRecipe)` with canonical JSON as in commands.md §6.6 rule 2. The derived
  path is `.thirdlight/derived/<sourceDigest>/<recipeDigest>/`
  (`content-storage.md` §8.3).
- The recipe is part of the version record and therefore part of the envelope and
  of every captured content view: a pinned version can always be re-derived
  without guessing tool versions.
- A recipe whose `profile` is unknown, whose `recipeVersion` is beyond the known
  set, whose `toolchain` is missing a required name, whose version strings are
  malformed, or whose `extensions` are outside the allowlist ⇒ `recipe_invalid`
  (or, at import time, `asset_extension_unsupported`).

## 6. Decoded-resource metrics and caps

`AssetMetrics` is the bounded, decoded-resource description of one version. It is
recorded at import and **re-validated against the caps on every load** (a record
claiming more than a cap is invalid: `limits_exceeded`).

| Field | Meaning | Cap |
|---|---|---|
| `nodes` | glTF node count | 4 096 |
| `meshes` | mesh count | 1 024 |
| `primitives` | primitive count over all meshes | 8 192 |
| `materials` | material count | 512 |
| `images` | image count | 64 |
| `textures` | texture count | 512 |
| `vertices` | summed vertex count of all primitives | 2 000 000 |
| `triangles` | summed triangle count (`mode` 4 only) | 4 000 000 |
| `animations` | animation clip count | 64 |
| `animationChannels` | channel count over all clips | 4 096 |
| `clipDurationMs` | longest clip duration in **integer milliseconds** (no float durations: reproducible) | 600 000 |
| `decodedGeometryBytes` | decoded vertex+index bytes | 268 435 456 |
| `decodedImageBytes` | decoded pixel bytes of all images | 268 435 456 |
| total decoded | `decodedGeometryBytes + decodedImageBytes` | 536 870 912 |

All values are non-negative integers; `0` is valid for counts a source does not
use (e.g. `animations: 0`), except that a version with `meshes: 0` or
`vertices: 0` is rejected as `asset_empty_model` (§7.4) — an import that carries no
geometry is not a model.

## 7. M2 import profile (glTF 2.0 GLB)

### 7.1 Accepted subset

- **glTF 2.0 binary (GLB) only.** No `.gltf` + sidecar, no archive, no URL, no
  plugin importer, no glTF 1.0.
- Exactly two chunks: a JSON chunk followed by a BIN chunk; all buffers and
  images are embedded in the BIN chunk (`bufferView`s).
- Core PBR materials (`pbrMetallicRoughness`, `normalTexture`,
  `occlusionTexture`, `emissiveTexture`, `emissiveFactor`, `alphaMode`,
  `alphaCutoff`, `doubleSided`), plus the small allowlisted extension set (§7.3).
- Embedded animation data (samplers/channels) within the caps of §6.
- Bounded meshes/nodes/images/textures (§6). Triangle `mode` 4 only.

### 7.2 Normative validation order

`inspectGlb(bytes, options)` runs these steps in order and stops on the first
failing step, returning an `ImportProposal` with `status: "rejected"` and the
diagnostics collected for that step (a step may report several independent
diagnostics; earlier steps' diagnostics are never re-reported).

| # | Step | Rejects with |
|---|---|---|
| 1 | **Size:** `1 ≤ bytes.length ≤ 33 554 432` | `asset_size_exceeded` |
| 2 | **Container:** ≥ 12 bytes; magic `glTF`; version `2`; declared length == actual length | `asset_container_invalid` |
| 3 | **Chunk framing:** chunk 0 exists and is `JSON`; exactly one further chunk, type `BIN`; each chunk length a multiple of 4; chunk bytes exactly fill the declared length; no trailing bytes | `asset_container_invalid` |
| 4 | **JSON:** strict parse of the JSON chunk (UTF-8, no BOM, duplicate keys rejected), root is an object, JSON chunk ≤ 8 388 608 bytes | `asset_json_invalid` |
| 5 | **glTF version & extensions:** `asset.version === "2.0"`; `extensionsUsed` ⊆ allowlist; every `extensionsRequired` entry is in the allowlist and declared in `extensionsUsed`; no `KHR_draco_mesh_compression`, no `EXT_meshopt_compression` | `asset_version_unsupported`, `asset_extension_unsupported`, `asset_compression_unsupported` |
| 6 | **Buffers:** exactly one buffer, **no `uri`**, `byteLength` ≤ BIN chunk length with `chunkLength − byteLength ≤ 3` | `asset_buffer_invalid`, `asset_uri_rejected` |
| 7 | **BufferViews:** index in range; `byteOffset + byteLength ≤ buffers[0].byteLength`; `byteOffset ≤ 3`; no `target` outside `{34962, 34963}` | `asset_buffer_invalid` |
| 8 | **Accessors:** index in range; `componentType` ∈ {5120…5126}; `type` ∈ {SCALAR, VEC2, VEC3, VEC4, MAT2, MAT3, MAT4}; `count ≥ 1`; byte range inside its bufferView; `byteOffset` aligned to the component size; **no `sparse` accessor** | `asset_accessor_invalid`, `asset_accessor_unsupported` |
| 9 | **Meshes/primitives:** `meshes.length ≥ 1`; every primitive's `mode` absent or `4`; attributes ⊆ {POSITION, NORMAL, TANGENT, TEXCOORD_0, TEXCOORD_1, COLOR_0, JOINTS_0, WEIGHTS_0} with `POSITION` present; `indices` (when present) resolves to an unsigned accessor; no primitive `extensions` | `asset_mesh_invalid`, `asset_primitive_unsupported` |
| 10 | **Materials:** only the core PBR fields of §7.1; every texture reference resolves; `alphaMode` ∈ {OPAQUE, MASK, BLEND}; `pbrMetallicRoughness` factors finite and in range | `asset_material_invalid` |
| 11 | **Images:** every image has `bufferView` and **no `uri`**; `mimeType` ∈ {`image/png`, `image/jpeg`}; the declared mime type **must match the actual magic bytes** of the image data; each image ≤ 33 554 432 bytes | `asset_uri_rejected`, `asset_image_invalid`, `asset_image_mime_mismatch` |
| 12 | **Textures/samplers:** references resolve; `wrapS`/`wrapT` ∈ {33071, 33648, 10497}; filters ∈ the glTF enum | `asset_texture_invalid` |
| 13 | **Animations:** every channel targets an existing node with a supported path (`translation`, `rotation`, `scale`, `weights`); sampler `input` is `SCALAR`/`FLOAT` with strictly increasing times, `output` type matches the path; no `KHR_animation_pointer`; clip count/channels/duration within §6 | `asset_animation_invalid` |
| 14 | **Nodes/scenes:** `children` resolve, no cycles, one `matrix` **or** TRS per node (not both); at least one scene; every `scenes[i].nodes[j]` resolves; `scene` (when present) is a valid index | `asset_node_invalid`, `asset_scene_invalid` |
| 15 | **Decoded limits:** compute `AssetMetrics` and compare with every cap of §6 (mesh/vertex/triangle/decoded-byte totals) | `asset_limits_exceeded` |
| 16 | **Non-empty:** `meshes ≥ 1` and `vertices ≥ 1` | `asset_empty_model` |
| 17 | **Accept:** emit `metrics` (exact), the used extensions (sorted), and a bounded inspection summary (§8) | — |

**MIME/extension checks alone are insufficient (explicit):** the profile never
trusts a file extension, a caller-declared mime type or the glTF `mimeType` field.
The GLB container framing, the JSON chunk contents, the buffer/accessor/bufferView
arithmetic, the image magic bytes and the decoded caps are all verified; step 11
exists precisely because a declared `image/png` with JPEG content must be rejected.

### 7.3 Extension allowlist

- The allowlist is a named, versioned constant of `asset-pipeline`
  (`M2_GLTF_EXTENSION_ALLOWLIST`), proposed by packet 24 **only after** testing the
  pinned loader, and pinned at Gate E.
- **Proposed initial membership: `KHR_materials_unlit` (candidate).** Until packet
  24 records a passing pinned-loader test for it, the **effective allowlist is
  empty** and any `extensionsUsed` entry is rejected with
  `asset_extension_unsupported`.
- Any extension outside the allowlist — including `KHR_texture_transform`,
  `KHR_materials_*` beyond the allowlist, `KHR_animation_pointer`, Draco and
  meshopt — is rejected. Extensions are never silently ignored, because ignoring
  one changes what the file means.
- Adding an extension is a contract change (it changes what a version's recipe can
  contain and therefore the recipe/derived key semantics), reviewed like a schema
  change.

### 7.4 Import diagnostics (stable code set)

`ImportProposal.diagnostics[].code` is one of: `asset_size_exceeded`,
`asset_container_invalid`, `asset_json_invalid`, `asset_version_unsupported`,
`asset_uri_rejected`, `asset_extension_unsupported`,
`asset_compression_unsupported`, `asset_buffer_invalid`, `asset_accessor_invalid`,
`asset_accessor_unsupported`, `asset_mesh_invalid`, `asset_primitive_unsupported`,
`asset_material_invalid`, `asset_image_invalid`, `asset_image_mime_mismatch`,
`asset_texture_invalid`, `asset_animation_invalid`, `asset_node_invalid`,
`asset_scene_invalid`, `asset_limits_exceeded`, `asset_empty_model`,
`asset_timeout`.

Each diagnostic carries `path` (a JSON Pointer into the GLB JSON chunk, or `""`
for container-level facts), one actionable `message`, the offending value where
bounded (`found`), the machine expectation (`expected`) and the failed limit where
applicable (`limit`). Diagnostics never contain file paths, staged bytes or
credentials. At most 10 diagnostics are returned per proposal plus a true count.

### 7.5 Determinism

For fixed `(bytes, profile, recipeVersion, toolchain)` the inspection result
(`metrics`, used extensions, ordered diagnostics) must be byte-deterministic —
it feeds the preserved `importRecipe` and therefore the derived-cache key. No
clock, PRNG, environment variable, locale or network access may influence it.
Wall-clock accounting appears only in the bounded job timeout and is never
persisted.

## 8. `ImportProposal` (transient job result)

An `ImportProposal` is the bounded result of inspecting staged bytes. It is
**never persisted** and **never authoritative**: nothing in the envelope, scene,
catalog, history or an export may reference a proposal id.

| Field | Type | Constraint / meaning |
|---|---|---|
| `proposalId` | string | `p-` + 32 hex, unique per job; identifies the proposal for the client's UI |
| `stageId` | string | the staged source it describes |
| `sourceDigest` | string | 64 lowercase hex, computed from the actual staged bytes |
| `sourceByteLength` | integer | actual byte length |
| `status` | string | `"ok"` or `"rejected"` |
| `kind` | string | `"model"` when `status: "ok"` |
| `importRecipe` | `ImportRecipe` | the recipe that produced this proposal (allowlist-verified) |
| `metrics` | `AssetMetrics` | present only when `status: "ok"` |
| `suggestedDisplayName` | string | sanitized from the caller's name or the stage's `stage.json`; 1–128 chars, no control characters; never used as a path or an identity |
| `inspection` | object | bounded display data: `nodeNames`, `materialNames`, `clipNames` (each ≤ 64 entries, each ≤ 128 chars), `sceneCount`; explicit **non-persistent** diagnostic data (§3.3); truncated lists set `truncated: true` |
| `diagnostics` | array | ≤ 10 plus a true count (§7.4); non-empty when `status: "rejected"` |
| `expiresAt` | string | timestamp; the proposal is invalid after the stage TTL (3 600 s from staging) |
| `limits` | object | the caps that were applied (profile, recipe version, §6 caps, byte caps), so a client can explain a rejection without guessing |

Rules:

- Proposals are **not** state: an identical request may be re-inspected and the
  result must be identical (§7.5). The response size is bounded by §9
  (`fixtures/m2/contracts/cases/constructed-cases.md` C6.3): lists are truncated
  rather than the response growing.
- A stale proposal may be re-submitted only as a **fresh command** against the
  current revision (`content-storage.md` §6, F16). A stale proposal never
  overwrites newer work, and its `sourceDigest` is re-verified at commit time.
- Proposal inspection may use or populate `.thirdlight/derived/` caches; it never
  writes outside `.thirdlight/derived/` and never touches `sources/`, the
  envelope or the catalog.

## 9. Captured immutable content view

### 9.1 Shape

```json
{
  "contentVersion": 1,
  "projectId": "demo-0002",
  "revision": 7,
  "assets": [
    { "assetId": "asset-2b11d4a76c9f0e35", "version": 1, "sourceDigest": "e5a1…", "sourceByteLength": 26, "importRecipe": { "…": "…" } },
    { "assetId": "asset-7f3a2c9e1b4d5068", "version": 2, "sourceDigest": "e5a1…", "sourceByteLength": 26, "importRecipe": { "…": "…" } }
  ],
  "contentDigest": "<64 hex>"
}
```

| Field | Constraint |
|---|---|
| `contentVersion` | exactly `1`; versioning the view shape itself (a shape change is a version change, not a silent extension) |
| `projectId` | the project the view was captured from |
| `revision` | the envelope revision it was captured at |
| `assets` | one entry per **reachable** asset: ascending `assetId` order; each names the resolved `version`, its `sourceDigest`, `sourceByteLength` and `importRecipe` |
| `contentDigest` | `SHA-256` of the canonical JSON (commands.md §6.6 rule 2) of this value with the `contentDigest` member removed |

Per-entry key order: `assetId, version, sourceDigest, sourceByteLength,
importRecipe`. Metrics are deliberately **not** copied into the view (they are
catalog display facts, not delivery facts), and no path is present.

### 9.2 Derivation (normative, pure)

`captureContent(scene, content, { projectId, revision })`:

1. Collect every `assetId` referenced by the captured scene's v2 model
   components (once prefabs/behaviors exist, their definitions' references join
   the closure — packets 16/18 keep this rule).
2. Resolve each to `(currentVersion, sourceDigest, sourceByteLength,
   importRecipe)` from the captured catalog.
3. Sort by `assetId`; emit the view; compute `contentDigest`.
4. A reference that does not resolve is `asset_reference_missing` and is reported
   before any capture (the envelope would not have loaded otherwise).

Unreferenced catalog records are **not** included in the view: the view is a
closure over what the captured scene needs, which is exactly what play and export
must fetch. The full catalog remains in the envelope for editing and for the
backup classification (`content-storage.md` §11).

### 9.3 Pinning rules

1. **Play, export, history-driven restore and any replay must resolve content
   through a captured view, never through the live catalog.** Because the view
   pins `sourceDigest` per asset, a reimport during play (which appends a version
   and moves `currentVersion`) cannot change what the running play or a running
   export reads.
2. **Snapshot identity stays `<projectId>@r<revision>`** (project-model §6). No
   new identity is needed: §3/`content-storage.md` §3 require that every
   observable content change advances `scene.revision` in the same atomic commit,
   so a revision uniquely determines the catalog that was current at it, and the
   `contentDigest` is reproducible from it.
3. **No GC can invalidate a view:** every version named by a view is retained for
   the life of the project (`content-storage.md` §10) and its blob is never
   deleted, so a captured view is always deliverable. A blob that is missing or
   tampered fails closed (`blob_missing`/`blob_corrupt`) instead of rendering
   something else.
4. **Fresh Play after a reimport uses the new version;** a reload that re-captures
   the view at the same revision must produce byte-identical content (acceptance
   rows A17/A22).

## 10. Validation, normalization and error codes

### 10.1 Entry points (proposed shapes)

```ts
validateContent(doc: unknown): ModelResult<ContentCatalog>;       // pure value validation
normalizeContent(doc: unknown): ModelResult<ContentCatalog>;      // validate + canonical new value (never mutates input)
validateProjectV2(manifest, scene, content): ModelResult<{ manifest; scene; content }>;
captureContent(scene, content, ctx: { projectId: string; revision: number }): ModelResult<CapturedContent>;
```

There is **no** `parseContent(bytes)`: the content block has no standalone file
(the envelope's strict parse governs its bytes). `serializeCanonical` gains the
content form (fixed key order of §4/§5/§6) so the workspace can build envelope
bytes; it stays pure and byte-stable, and it rejects invalid documents rather
than emitting best-effort output (project-model §12.7 R5).

### 10.2 Validation order (content block)

Starting from the envelope pipeline's step 6d (`content-storage.md` §3.2):

1. `content` is an object, else `field_type` at `/content`.
2. Key set exactly `{assets, prefabs, behaviors, settings}`; missing ⇒
   `field_missing`; unknown ⇒ `field_unexpected`.
3. `assets` is an array; `0 ≤ length ≤ 128` else `limits_exceeded`
   (`limit: "assets"`) at the offending index.
4. Per asset, in array order: `assetId` present/syntax/unique (`id_invalid`,
   `id_duplicate`, first occurrence wins); `kind === "model"` (`field_value`);
   `displayName` (`field_type`/`field_value`); `currentVersion` integer and equal
   to the last version (`field_value`); `versions` array with
   `1 ≤ length ≤ 32` (`field_missing`/`limits_exceeded`), versions contiguous
   `1..N` and strictly ascending (`asset_version_invalid`), each version's
   `sourceDigest` (`digest_invalid`), `sourceByteLength` (`number_out_of_range`),
   `importRecipe` (`recipe_invalid`), `metrics` (`field_*` + `limits_exceeded` per
   §6 cap), `importedAt` (timestamp rules), `publishedRevision`
   (`number_out_of_range`, and `≤ scene.revision` ⇒ `field_value`).
5. Total version records ≤ 1 024 else `limits_exceeded`
   (`limit: "version_records"`).
6. Reserved containers: `prefabs`/`behaviors` must be arrays and, in v2, empty
   (`field_value` with `expected: "[]"`); `settings` must be an object and, in
   v2, empty.
7. Canonical `content` bytes ≤ 1 048 576 else `limits_exceeded`
   (`limit: "content_bytes"`).

All independent errors are collected (not fail-on-first), matching the accepted
project-model behavior. Validation is pure and total: same input → same result,
never throws, never reads files.

### 10.3 New model error codes

| Code | Raised when |
|---|---|
| `version_combination_unsupported` | a v2 envelope with `scene.schemaVersion !== 2` (single error, stops) |
| `asset_reference_missing` | a scene model reference resolves to no catalog record (`document: "scene"`, path at the component) |
| `digest_invalid` | `sourceDigest` is not 64 lowercase hex |
| `asset_version_invalid` | versions are not contiguous/ascending, duplicated, or out of range |
| `recipe_invalid` | the import recipe is malformed, of an unknown profile/recipe version, or missing a required toolchain entry |

`limits_exceeded` gains the `limit` values of `assets.md` §4/§6 and
`content_bytes`; the enum becomes
`'entities' | 'depth' | 'assets' | 'asset_versions' | 'version_records' |
'content_bytes' | 'source_bytes' | 'nodes' | 'meshes' | 'primitives' |
'materials' | 'images' | 'textures' | 'vertices' | 'triangles' | 'animations' |
'animation_channels' | 'clip_duration' | 'decoded_bytes'`.

## 11. Cross-block validation

`validateProjectV2(manifest, scene, content)` runs the manifest validator (v1),
the v2 scene validator and `validateContent`. If either document fails, their
error sets are returned (manifest, then scene, then content) and the cross-block
check is skipped — the accepted project-model §13 rule, extended to three blocks.

Only if all three pass:

1. Every `assetId` referenced by a v2 model component resolves in
   `content.assets` ⇒ else `asset_reference_missing` (`document: "scene"`, path
   `/entities/<i>/components/model/asset/assetId`), one error per unresolved
   reference.
2. `manifest.scenes[0].id === scene.sceneId` ⇒ `manifest_scene_mismatch`
   (accepted).
3. `manifest.id === envelope.projectId === directory name` (workspace-enforced,
   accepted).

The check is intentionally **one-way**: an unreferenced catalog record is valid
(it is retained content), while a dangling reference is not.

## 12. Public exports

`@thirdlight/project-model` (v2 additions; nothing accepted is removed):

```ts
export type {
  ContentCatalog, AssetRecord, AssetVersion, ImportRecipe, AssetMetrics,
  CapturedAssetVersion, CapturedContent,
} from './content-types';
export { validateContent, normalizeContent, validateProjectV2, captureContent } from './content';
export { KNOWN_VERSIONS, SCHEMA_VERSIONS_BY_DOCUMENT, ERROR_CODES } from './errors'; // extended values
```

`@thirdlight/asset-pipeline` (new, packet 24; pure, no I/O):

```ts
export interface ImportProposal { /* §8 */ }
export type ImportDiagnostic = { code: ImportDiagnosticCode; path: string; message: string; found?: unknown; expected?: string; limit?: string };
export function inspectGlb(bytes: Uint8Array, options: { profile: 'gltf-glb'; recipeVersion: 1; toolchain: Record<string, string> }): ImportProposal;
export const M2_GLTF_EXTENSION_ALLOWLIST: readonly string[];
export const M2_GLTF_PROFILE_LIMITS: Readonly<Record<string, number>>;
```

`@thirdlight/workspace` re-exports the content types and exposes the operations
of `content-storage.md` §14 (including `inspectStage`, `publishBlob`,
`readBlob`, `contentIntegrity`, `captureContentView`, `migrateProjectCopy`).

## 13. Observable failure outcomes

This table is the acceptance-facing summary for packet 15's failure list
(`docs/planning/m2-packets.md` §15). Every row is observable at the transport
boundary without reading internals, and every row leaves the acknowledged state
byte-identical unless stated. Detailed matrices: `content-storage.md` §7, §6.4.

| Class | Observable outcome | Durable effect |
|---|---|---|
| malformed GLB | `import_rejected` with ordered `asset_*` diagnostics; prior catalog/scene/revision unchanged | none |
| remote/external/`data:` URI | `import_rejected` → `asset_uri_rejected` | none |
| unsupported required extension | `import_rejected` → `asset_extension_unsupported` (names the extension) | none |
| compression (Draco/meshopt) | `import_rejected` → `asset_compression_unsupported` | none |
| decoded-resource cap | `import_rejected` → `asset_limits_exceeded` with the failed limit and found value | none |
| persisted metrics above a cap | `content_invalid` → `limits_exceeded` | none |
| missing blob | `blob_missing` on read/commit; integrity report names assetId/version/digest/path | none (project still opens) |
| tampered/corrupt blob | `blob_corrupt`; bytes retained; every read re-verifies | none |
| corrupted derived cache | `derived_cache_unavailable`; regenerated from `sources/` with no network | derived directory rewritten only |
| missing/nonexistent source | `blob_missing` at commit; the command fails closed and records nothing | none |
| path traversal / symlink | `path_rejected` before any read/write of the target | none |
| stale/abandoned job (new request) | `stage_expired`; the proposal is re-inspectable after re-staging | none |
| stale/abandoned job (identical retry) | `duplicated: true` replay from the retry record; no staging or blob lookup | none |
| ownership loss | `ownership_conflict` at the commit | possibly unreferenced blobs |
| crash at any publication boundary | after reopen: envelope unchanged or committed; at worst unreferenced bytes; the retry converges | see `content-storage.md` §6.4 |
| full disk | `content_quota_exceeded` before publication, or `content_publish_failed` in the blob phase | none / leftover temp |
| v1/v2 or unknown version | `version_combination_unsupported`, `storage_version_unsupported`, `scene_invalid`, `manifest_invalid`; bytes retained | none |
| interrupted migration copy | scan reports the interrupted destination; never auto-completed; resumable or deletable | partial destination only |
| reimport + undo | one new version, pointer moves; undo restores the previous version; **all bytes retained** | none removed |

## 14. Compatibility and change rules

- The accepted M1 scene/catalog-less model is unchanged for `schemaVersion 1`
  documents; v2 is a new known version, not an extension of v1.
- Adding a catalog/version field, a new `kind`, a new metric, a new extension in
  the allowlist, or a changed bound: reviewed change, `storageVersion`/profile
  version bump where it changes meaning (no same-version extensions by default).
- Fixture bytes and expected codes are part of the contract.
- The v2 scene registry (beyond `components.model`'s reference shape, §3.2) is
  packet 20's; a v2 scene must remain a superset of v1's `{transform, box,
  camera}` components so that migration can carry entities verbatim.

## 15. What is deliberately not in M2

- No persistent references to submeshes, material slots, bones, joints or
  animation clips; no name/index stability promise for anything inside a GLB.
- No `.gltf`, no sidecar files, no archives, no URL/remote import, no plugin or
  user-supplied importer, no Draco/meshopt/quantization, no texture compression,
  no `KHR_texture_transform`, no glTF 1.0 or `KHR_techniques` materials.
- No asset editing, no material graph, no texture authoring, no mesh surgery, no
  animation authoring (clip play/pause/scrub is local preview state only).
- No asset deletion, no blob deletion, no GC, no cross-project deduplication.
- No thumbnails/previews persisted in the catalog, no decoded bytes in the
  envelope, no derived data in a backup.
- No per-placement content overrides (a placement is a whole model reference plus
  its transform; packet 16 owns prefab-level overrides).
