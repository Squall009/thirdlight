# Thirdlight — Project Data Contract

Version: 0.2 (normative, pending Gate A acceptance) · Packet 01 · 2026-09-17
Revision: pre-Gate A review alignment 2026-09-17 — §12.1 now declares the
canonical byte serializer and constant exports that
docs/contracts/dependencies.md §3 names as the public surface (see
docs/handoffs/03.md, Gate A pre-review findings). No behavior change.
Scope: M1 (single project manifest + single active scene).
Companion fixtures: `fixtures/project-model/` (machine-readable index:
`fixtures/project-model/expected.json`).

This contract is normative for the M1 project data format. It is documentation
and fixtures only — no implementation exists yet (packet 05 implements the
validator/serializer against this document and its fixtures).

Inputs read: `AGENTS.md`, `docs/STATUS.md`,
`docs/architecture/charter.md`, `docs/decisions/0001-stack-and-deployment.md`,
planning packet 01. No other contract existed at the time of writing.

Normative keywords: **must**, **must not**, **should**, **may** are used in
the RFC 2119 sense.

---

## 1. Scope and ownership

This contract owns:

- The exact serialized shape of the **project manifest** and the single
  **active scene** document (M1).
- Identifier and reference rules, the component registry, hierarchy and
  deletion semantics, validation and normalization rules, and version
  semantics.
- The JSON fixtures under `fixtures/project-model/`.

This contract does **not** own (later packets, binding contracts to be
reviewed separately):

- Command envelopes, revision checking, retry/dedup, undo/redo — packet 02
  (`docs/contracts/commands.md`).
- Filesystem persistence, atomicity, recovery, external-change handling,
  ownership — packet 02 (`docs/contracts/workspace.md`). The scene shape
  below is a logical document, not the complete mutable on-disk state;
  packet 02's single atomic authoring-state envelope embeds that document
  (including its revision) and retry metadata. See §3.
- Runtime snapshots, sessions, export, module boundaries — packet 03.

Explicit non-goals for M1 (charter §3, packet 01 instruction): no full ECS,
no physics schema, no prefab/instance inheritance, no shader or material
graphs, no assets (boxes are procedural primitives with an inline material),
no lights, no multi-scene projects — all scoped to M1's schemaVersion 1. Scene schemaVersion 3 adds the bounded `light`/`surface` components of §23.3.4/§23.3.5; this M1 sentence is not a v3 non-goal.

## 2. Coordinate convention

- **Axes:** Y-up, right-handed world coordinates — the three.js default
  convention. X right, Y up, Z toward the viewer (out of the screen) for a
  default camera.
- **Units:** meters. All length-valued numbers in this contract are meters
  unless stated otherwise. Angles (only `fovY`) are degrees.
- **Local transforms:** an entity's `transform` is expressed in its parent's
  local frame. A root entity's transform is expressed in the world frame.
  World transforms are derived by composing the ancestor chain; **world
  transforms are never persisted** (charter §5: no second mutation path, no
  derived data in the authoritative document).
- **2.5D platformer plane (binding for the first game):** gameplay movement
  occurs on the **XY plane** (X = horizontal, Y = vertical/up); **depth runs
  along Z** (charter §1 confirmed decision; decision 0001 §1).
- **Default camera orientation:** a camera with identity rotation
  (`[0, 0, 0, 1]`) looks down world **−Z** with **+Y up** (three.js default
  view). This orientation is the M1 default for the main camera and is
  consistent with the 2.5D plane: with the camera on the +Z side looking
  toward −Z, the XY plane is seen with +X right and +Y up. The default
  camera uses identity rotation and position `[0, 0.5, 4]` (§15).

## 3. Documents and layout

A project has exactly two **logical authoring documents** in schemaVersion 1.
Their standalone **interchange/fixture layout** is:

```text
<projectId>/
  project.json           ← project manifest (document type: "project-manifest")
  scenes/
    main.json            ← the single active scene (document type: "scene")
```

- Logical document paths are **normative** for schemaVersion 1.
- M1 supports exactly **one** active scene per project. The manifest lists it
  (length of `scenes` is exactly 1). Multi-scene support is a future contract
  change (packet 02 already anticipates that multi-scene transactions require
  a new persistence contract).
- In interchange/fixtures, each path contains the standalone document shown
  in §7–§8 (strict JSON, UTF-8, no BOM; canonical output uses LF). The
  project-level logical view is defined in §13.
- In the **active workspace** under
  `/home/dadmin/thirdlight/projects/<projectId>/` (decision 0001 §6),
  `project.json` contains the immutable manifest. `scenes/main.json` contains
  the **single atomic authoring-state envelope**, not a bare scene. Packet 02
  owns that envelope's exact fields and independent storage version, including
  the embedded scene, its revision, and required retry metadata. The scene's
  `revision` is the project revision; an independently mutable duplicate
  revision is not permitted. There is no second authoritative bare scene file.
- The workspace layer decodes/validates the envelope and passes its embedded
  scene to `validateScene`; it must not pass the entire envelope to the scene
  validator. A standalone scene parser is for interchange input, not an
  envelope decoder. No auto-detection or fallback between formats is implied.
- Workspace ownership records, temporary files, and recovery artifacts are
  governed by packet 02, not prohibited by this logical-document contract.
  The workspace contract must define their locations and validation policy.
- In the M2 workspace the active workspace envelope is `storageVersion` 2 and
  its embedded scene is `schemaVersion` 2 (workspace.md §4.2): the envelope gains
  a bounded `content` block beside `scene` and `retry`. The content block is
  **envelope state only**: it has no standalone logical document, no
  interchange file and no byte parser, because a second mutable catalog file is
  exactly what §14 (no multi-file transactions) excludes. The interchange
  layout and the logical documents above are unchanged, and a `schemaVersion` 1
  document is still exactly as defined in §7–§10.
- In the M3 workspace the active envelope is `storageVersion` 3 and its embedded
  scene is `schemaVersion` 3 (workspace.md §4.5/§16): the envelope keeps the M2
  `content` block and adds exactly one required key, `game`, which is `null` or
  a bounded game-configuration block (§23.4). It is **envelope state only** —
  there is still one mutable file, no standalone game document and no JSON blob.
  `schemaVersion` 1 and 2 documents remain valid exactly as accepted.

## 4. General value rules

- Every persisted value **must** be JSON-serializable: `string`, finite
  `number`, finite `integer`, `null`, array, or object. `M1 uses no booleans`;
  a future schema version may introduce them.
- Every number **must** be finite (no `NaN`, no `±Infinity`) — see §12.7 for
  the runtime-only non-finite cases, which JSON cannot encode.
- **Forbidden in persisted documents** (any document, any version of this
  contract):
  - Object3D / three.js instances or object identity of any kind;
  - functions, symbols, `undefined`;
  - absolute filesystem paths, `file://` / `http(s)://` URLs, or any
    host-specific locator; references are **project-relative** only;
  - transient state: selection, hover, gizmo state, play mode state, session
    or connection IDs (owned by the session contract, packet 03);
  - credentials, tokens, or other secrets (AGENTS.md).
- Strings are UTF-8. `name` fields: length 1–128, no control characters
  (U+0000–U+001F, U+007F).

## 5. Identifiers and references

### 5.1 ID syntax (all IDs)

Project IDs, scene IDs, entity IDs, asset IDs, stage IDs, prefab IDs, prefab
local entity IDs and behavior IDs all use one syntax:

```text
id := 1–64 chars, first char [a-z0-9], remaining chars [a-z0-9_-]
     regex: ^[a-z0-9][a-z0-9_-]{0,63}$
```

Examples: `demo-0001`, `scene-main`, `cam-main`, `ground-2`.

### 5.2 Stability and semantics

- IDs are **opaque**: the engine never parses them for meaning; the charset is
  a uniformity/stability choice (JSON-, log-, and URL-path-safe).
- IDs are **stable**: they are never regenerated on rename, reorder, retry, or
  restore. Creation assigns an ID exactly once (packet 02 makes creation IDs
  stable across command retries; the data contract only requires that a
  document's IDs uniquely identify its entities).
- Entity IDs are unique **within one scene**. Project IDs are unique within
  the workspace (enforced by the workspace layer, packet 07).
- IDs are keys; `name` fields are display labels only — **names are not
  unique, not stable, and never used as references**.
- **Asset IDs are stable, opaque and never reused.** A reimport, rename, undo,
  restore or retry keeps an `assetId`; it is assigned once at creation from a
  caller-supplied valid ID, never derived from a file name, display name, content
  digest or import order, and never reassigned within a project (M2 has no asset
  deletion; a later version that adds one must add a never-reuse rule —
  assets.md §3.7). Internal glTF node/material/clip names and indices are **not**
  engine IDs and are never persisted as references (assets.md §3.3).
- **Stage IDs are not persisted identities.** A stage ID names a non-authoritative
  staging directory; it is never stored in a document and never referenced by a
  command's arguments (workspace.md §7.6).
- **Prefab IDs, local entity IDs and behavior IDs are stable.** A `prefabId` is
  assigned once at creation, is unique in `content.prefabs` and is never reused
  (M2 has no prefab deletion). A definition's `localId` values are its source
  entity IDs, stored verbatim and never reassigned. A `behaviorId` is assigned
  once per declaration and never reused. None of the three is derived from a
  display name (prefabs.md §4, properties.md §5).

### 5.3 References

| Reference | From | To | Form |
|---|---|---|---|
| `scenes[i].id` | manifest | scene document `sceneId` | ID string, equality |
| `scenes[i].path` | manifest | logical scene location (§3: bare scene in interchange, envelope in workspace) | project-relative POSIX path; M1: exactly `"scenes/main.json"` |
| `parentId` | entity | entity (same scene) | ID string or `null` (root) |

Project-relative paths: POSIX separators, no leading `/`, no `..` segments, no
`.` segments. The only path value permitted in M1 documents is
`scenes/main.json` (validator error `field_value` otherwise — §12.6).

The project ID must equal the project directory name under the data root
(enforced by the workspace layer, packet 07).

## 6. Version taxonomy

Four distinct version concepts. They never substitute for each other.

| Concept | Field / form | Identifies | Who advances it | Where it lives | Validator behavior |
|---|---|---|---|---|---|
| **Schema version** | `schemaVersion`, integer | The data format of this contract. Known versions are **per document type**: manifest `[1, 2]` (M4 adds manifest `2` — the template-creation path only; §7.1 C65-1); scene `[1, 2, 3]` (M2 adds scene `2`; M3 adds scene `3`, §23). | Contract authors; a new component type, a new required field, or any meaning change **requires** a new `schemaVersion` (same-version extensions are forbidden). | Manifest and scene documents. | Unknown (higher **or** lower) for that document type → single actionable `schema_version_unsupported` error, document retained untouched (§12.3). No field-level validation is attempted against an unknown version. |
| **Engine version** | `engineVersion`, string, semver `MAJOR.MINOR.PATCH[-prerelease]` (regex `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`) | Which Thirdlight build wrote the manifest. M1 baseline: `0.1.0`. | The writing engine at project creation. | Manifest only. | Any well-formed semver is accepted — the engine version **never blocks** validation (forward compatibility within a known schema version). |
| **Authoring revision** | `revision`, integer | The project's editing state. Project-level monotonically increasing counter; M1 carries it in the scene document because there is exactly one scene (packet 02's project-level revision **is** this field). Starts at `0`. | The command/workspace layer (packets 02/07); the data contract only constrains type/range. | Scene document. | `0 ≤ revision ≤ 2^53−1` (`Number.MAX_SAFE_INTEGER`); violation → `revision_invalid`. Monotonicity and conflict rules are packet 02, **not** data validation. |
| **Runtime snapshot ID** | derived string: `<projectId>@r<revision>` (e.g. `demo-0001@r12`) | An immutable, deep-frozen copy of the scene document (normalized form, §12.2) at a given authoring revision. Consumed by play (packets 08–10) and export (packet 12). | Derived deterministically; never stored as authoring state. | Nowhere in manifest/scene documents; the snapshot consumer derives it and records it in export metadata (packet 12). | Not validated as a persisted field (it is not persisted). |

Rules:

- `schemaVersion` and `engineVersion` coexist in the manifest; a future
  engine may read a document with an unknown `engineVersion` fine as long as
  `schemaVersion` is known.
- Version support is checked per logical document before cross-document
  checks (§13). A version-1/version-2 pair fails with the unsupported
  document's `schema_version_unsupported`, not a second mixed-version error.
  With M1 known versions `[1]`, every passing pair necessarily matches.
- **Version combinations are checked explicitly, not assumed.** The active
  workspace accepts exactly two combinations — manifest `1` + scene `1` +
  `storageVersion` `1` (M1, unchanged), and manifest `1` + scene `2` +
  `storageVersion` `2` (M2, workspace.md §4.5). A v2 envelope whose scene is
  `schemaVersion` 1 fails with a single `version_combination_unsupported` before
  any field validation; a v1 envelope whose scene is `schemaVersion` 2 fails with
  the M1 pipeline's `scene_invalid` → `schema_version_unsupported`. The manifest
  stays `schemaVersion` 1 in M2.
- **M3 adds one passable combination, not a new rule.** `manifest 1 + scene 3 +
  storageVersion 3` joins the two rows above (§23.2, workspace.md §4.5); its
  envelope carries `content.game`. Every other v3 pair is a single
  `version_combination_unsupported` (storage side) or `schema_version_unsupported`
  (per document) and is refused non-destructively with the bytes retained
  untouched. The authoring manifest still never moves.
- The runtime snapshot ID contains no timestamp, UUID, or machine-specific
  data, so the same revision in the same project always yields the same
  snapshot ID (reproducibility input for packet 12).

## 7. Project manifest — `project.json`

Document type: `project-manifest`. Top-level shape (schemaVersion 1):

```json
{
  "schemaVersion": 1,
  "engineVersion": "0.1.0",
  "id": "demo-0001",
  "name": "Demo Project",
  "createdAt": "2026-09-16T23:40:00Z",
  "scenes": [
    { "id": "scene-main", "path": "scenes/main.json" }
  ]
}
```

### 7.1 Fields

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `schemaVersion` | integer | yes | exactly `1` or `2` (known: `[1, 2]`; `2` adds the required `template` block — the M4 C65-1 note below) | — |
| `engineVersion` | string | yes | semver regex (§6) | — |
| `id` | string | yes | ID syntax (§5.1) | — |
| `name` | string | yes | 1–128 chars, no control chars | — |
| `createdAt` | string | yes | timestamp format (§7.2) | — |
| `scenes` | array | yes | length exactly 1 (M1) | — |
| `scenes[i].id` | string | yes | ID syntax; must equal the scene document's `sceneId` (§13) | — |
| `scenes[i].path` | string | yes | project-relative; M1: exactly `"scenes/main.json"` | — |

There are **no other top-level or nested fields** in schemaVersion 1;
unknown fields → `field_unexpected` (§12.6). The manifest is **immutable during
M1 editing** (project creation is the only M1 writer path for it; name edits
and settings are future contract extensions). The mutable M1 authoring state
lives in the scene document.

**schemaVersion 2 (M4, C65-1):** the v1 field set plus one **required**
field, `template` (a v2 manifest is the v1 shape plus exactly one field):

```json
{
  "schemaVersion": 2,
  "engineVersion": "0.1.0",
  "id": "starter-0001",
  "name": "My Platformer",
  "createdAt": "2026-09-22T00:00:00Z",
  "scenes": [ { "id": "scene-main", "path": "scenes/main.json" } ],
  "template": {
    "templateId": "platformer-starter",
    "version": 1,
    "contentDigest": "<64 lowercase hex>",
    "engineVersion": "0.1.0"
  }
}
```

| Field | Type | Required | Constraint |
|---|---|---|---|
| `template` | object | yes **in `schemaVersion 2` only** (absent in v1) | exactly the four keys below; canonical key order `templateId`, `version`, `contentDigest`, `engineVersion` |
| `template.templateId` | string | yes | ID syntax (§5.1) |
| `template.version` | integer | yes | ≥ 1 (the template descriptor's `version`) |
| `template.contentDigest` | string | yes | 64 lowercase hex (the template descriptor's `contentDigest`) |
| `template.engineVersion` | string | yes | semver (§6); the template's declared engine version (provenance — distinct from the manifest's own `engineVersion`, which is the creating backend's) |

- `schemaVersion 2` is written **only** by the template-creation path
  (workspace.md §8.4, C65-3); plain `createProject` still writes a
  `schemaVersion 1` manifest, and the v2→v3 migration copy still keeps the
  destination manifest at `schemaVersion 1` (the accepted "never
  re-versioned" rule, workspace.md §16.5.2 — unchanged).
- The manifest remains **immutable after creation** in both schema
  versions (the accepted §7 rule); the `template` block is written once at
  creation and never edited. Project title/objective edits are
  `setGameConfig` edits of the envelope content, never manifest writes.
- **Named combinations (C65-2):** `(manifest 2, storage 3, scene 3)` is
  valid (the only new row); `(manifest 2, storage ≤ 2)` is
  `version_combination_unsupported` with reason
  `manifest_storage_mismatch`; `(manifest 1, storage 3)` stays valid
  (migrated projects). A pre-M4 engine meeting a v2 manifest reports the
  accepted unknown-field/`manifest_invalid` refusal (the standard schema
  bump consequence).
- `queryProject` (commands.md §5.6) carries the full normalized manifest —
  the v2 manifest (incl. `template`) flows through with **no query-shape
  change** (commands.md C65-9 adjudication).

### 7.2 Timestamps

- Format: `YYYY-MM-DDTHH:mm:ssZ` — UTC, second precision, literal `Z`, no
  fractional seconds. Regex: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`, and the
  value must denote an existing calendar date (no month 13, no Feb 30).
- M1 carries only `createdAt` (manifest). The scene document carries **no**
  timestamps (revision is its ordering token). The normalizer never
  rewrites or regenerates timestamps.

## 8. Scene — `scenes/main.json`

Document type: `scene`. Top-level **logical** shape (schemaVersion 1):
this is the whole interchange file, or the embedded scene value in the
workspace envelope (§3), never the envelope's top-level shape.

```json
{
  "schemaVersion": 1,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [ /* entity objects, §9 */ ]
}
```

The **logical** scene shape above is `schemaVersion` 1. In the M2 active
workspace the embedded scene is `schemaVersion` 2: the same top-level fields
(`schemaVersion`, `sceneId`, `revision`, `entities`) with the §18 component
registry, which is a superset of the §10 registry. §8.1 below states both
versions; a standalone interchange file remains `schemaVersion` 1 until a
separate contract change says otherwise.
In the M3 workspace the embedded scene is `schemaVersion` 3: the same top-level
fields (`schemaVersion`, `sceneId`, `revision`, `entities`) with the §23
component registry, a superset of the §18(v2) registry. No field or meaning of
scene `1`/`2` changes.

### 8.1 Fields

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `schemaVersion` | integer | yes | `1` (interchange, M1 workspace), `2` (M2 active workspace) or `3` (M3 active workspace; required there — workspace.md §4.2, §4.5/§16) | — |
| `sceneId` | string | yes | ID syntax (§5.1) | — |
| `revision` | integer | yes | `0 ≤ v ≤ 2^53−1` | `0` for a newly created project |
| `entities` | array | yes | `1 ≤ length ≤ 1024` (M1 limit); at least one entity because exactly one camera is required (§10.3) | — |

Unknown top-level fields → `field_unexpected`.

## 9. Entity

An entity is a named, IDed node in the scene hierarchy carrying a small fixed
set of components (§10). M1 entity combinations (normative, enforced):

| Combination | Meaning |
|---|---|
| `{ transform }` | Group node (organizes children; renders nothing) |
| `{ transform, box }` | Box primitive with simple material |
| `{ transform, camera }` | Camera |
| `{ transform, behavior }` | Entity carrying declared-property values for one behavior declaration |
| `{ transform, box, behavior }` / `{ transform, model, behavior }` | as above, attached to a primitive/model |
| `{ transform, box, collider }` / `{ transform, model, collider }` | Static physics body: the authored collider plus its visual primitive/model |
| `{ transform, box, controller }` / `{ transform, model, controller }` | The single kinematic character: the marker plus its visual primitive/model |

`box`, `model` and `camera` are **pairwise mutually exclusive** on one entity
(`component_conflict`), and `collider` is mutually exclusive with `controller`
(`component_conflict`). `behavior` and `prefab` are non-structural: they may
coexist with one of the three, and `prefab` is written only by
`instantiatePrefab` (`prefabs.md` §8). Inside a prefab **definition** the
permitted component set is smaller (`transform`, `box`, `model`, `behavior`) —
`prefabs.md` §3.
`transform` is required on every entity (`component_missing` when absent).
`{ transform, box, camera }` is impossible (the conflict fires first).

### 9.1 Fields

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `id` | string | yes | ID syntax; unique within the scene | — |
| `name` | string | no | 1–128 chars, no control chars; display only | absent |
| `parentId` | string or `null` | no | must reference an existing entity `id` in the same scene; `null` (or absent) = root | `null` |
| `components` | object | yes | keys ⊆ `{ "transform", "box", "camera" }`; each key at most once; `transform` present; combination per §9 | — |

Unknown entity fields → `field_unexpected`. The normalizer emits `parentId`
only when it is non-null.

## 10. Component registry (schemaVersion 1)

The registry for schemaVersion 1 is **exactly** `{ transform, box, camera }`.
A `schemaVersion` 2 scene's registry is
`{ transform, model, box, camera, behavior, prefab, collider, controller }`
(packet 15 pinned `model`; `behavior`/`prefab` are packet 16's; `collider` and
`controller` are packet 17's — `physics.md` §4; packet 20 owns the final
registry and its order).
The `behavior` component's payload is packet 16's `{ behaviorId, values }`; it
is **unchanged** by packet 18. A behavior's *source*, compiler record, manifest
and trust acknowledgment live in `content.behaviors[i].source` and
`content.behaviorTrust` (§12.2/§22) — never in a scene component, never in a
command argument, never in a component field. The scene therefore cannot address
code, a digest or a staging handle.
A component unknown to the registry → `component_unknown` with the list of
known types in the error (§12.6). For an unknown component type the validator
reports `component_unknown` and performs **no field-level validation** of
that component's contents (its format is unknown). Adding a component type
requires a new `schemaVersion` (§6). Canonical component key order in
serialized documents: `transform`, `box`, `camera`.
`behavior` and `prefab` are appended in that order; a definition entity never
carries `camera`/`prefab` (`prefab_component_forbidden`).
`collider` and `controller` are appended last, in that order. Only the
`controller` entity may be physics-driven; a `collider` entity is static
(`physics.md` §3).

A `schemaVersion` 3 scene's registry is the v2 registry **plus six components
appended in this order**: `gameZone`, `playerSpawn`, `cameraFollow`, `light`,
`surface`, `modelAnimation` (§23.3). No accepted component is renumbered or
reinterpreted; the canonical v3 component order is exactly §23.3's list.
### 10.1 `transform` (required on every entity)

Local transform, relative to the parent frame (roots: world frame), §2.

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `position` | array of 3 finite numbers (meters, local) | no | each `|v| ≤ 1e6` | `[0, 0, 0]` |
| `rotation` | array of 4 finite numbers, quaternion in order `[x, y, z, w]` | no | finite; unit length: `|‖q‖ − 1| ≤ 1e-4` | `[0, 0, 0, 1]` (identity) |
| `scale` | array of 3 finite numbers (meters, local) | no | each `0 < v ≤ 1e6` (no zero or negative scale; negative scale would flip handedness) | `[1, 1, 1]` |

Quaternion rules:

- Serialization order is **`[x, y, z, w]`** (three.js `Quaternion` order).
- `q` and `−q` denote the same rotation; **both are accepted**; the
  normalizer does **not** sign-flip (no canonical sign).
- A zero quaternion (`[0,0,0,0]`) fails `quaternion_invalid` (norm 0).
- Authoring normalization **preserves all validated quaternion components**
  (apart from negative zero becoming zero under §12.2). It must not divide
  by the norm: repeated floating-point division can oscillate between double
  values and violate byte-idempotence. The tolerance above defines accepted
  authoring rotations, not a demand for an exactly representable unit norm.
- Consumers requiring a unit quaternion (the three.js adapter, packet 08)
  normalize a **derived copy** before composing/rendering transforms. That
  numerical adjustment must never be written back to authoring state or its
  immutable snapshot. This applies to near-unit values throughout the full
  accepted tolerance, not only floating-point roundoff.
- No other rotational representation (Euler angles, matrices) is persisted.

Field-order canonicalization: `position`, `rotation`, `scale`.

### 10.2 `box`

Procedural axis-aligned box primitive, extent in the entity's local frame.
The geometry is a unit box scaled by `size` (the three-adapter maps this in
packet 08; the data contract stores only `size` and `material`).

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `size` | array of 3 finite numbers (meters) — local X, Y, Z extents | no | each `0 < v ≤ 1e6` | `[1, 1, 1]` |
| `material` | object | no | only known field `color` (M1) | `{}` |
| `material.color` | string | no | `^#[0-9a-fA-F]{6}$`; canonical form is lowercase | `#b0b0b0` |

No asset references, no textures, no shader parameters in M1.
Field-order canonicalization: `size`, `material` (`color`).

### 10.3 `camera`

Perspective camera. **Exactly one entity in the scene carries `camera`** —
zero → `camera_count_invalid`; two or more → `camera_count_invalid`.

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `type` | string | no | exactly `"perspective"` (only M1 value) | `"perspective"` |
| `fovY` | number (degrees) | no | `0 < v < 180`; vertical field of view (Y is the screen-vertical/up axis, §2) | `60` |
| `near` | number (meters) | no | `0 < v ≤ 1e6` | `0.1` |
| `far` | number (meters) | no | `near < v ≤ 1e6` | `100` |

- `aspect` is **not** persisted: it is a render-time property of the
  viewport, not authoring data.
- Orientation comes from the entity's `transform` quaternion; there is no
  separate look-at target field in M1.
- Field-order canonicalization: `type`, `fovY`, `near`, `far`.

### 10.4 M1 limits

| Limit | Value | Error |
|---|---|---|
| Entities per scene | ≤ 1024 | `limits_exceeded` (limit: `entities`) |
| Hierarchy depth (root = 1) | ≤ 32 | `limits_exceeded` (limit: `depth`) |
| Components per entity | ≤ 3 (registry size) | implied by §9 |

### 10.5 `behavior`

1. **Schemas** live in `content.behaviors[i].declaration.properties`
   (the record part; the source/trust fields live in §22).
2. **Values** live in the scene component `components.behavior`:

```ts
interface BehaviorComponent {
  behaviorId: string;                     // must resolve in content.behaviors
  values: Record<string, PropertyValue>;  // every declared key, declaration order
}
```

Canonical key order: `behaviorId`, `values`; `values` in declaration order;
`components` in registry order (`transform, model, box, camera, behavior,
prefab, collider, controller`).

3. **Prefab-definition entities** may carry `components.behavior`; their recorded
   `values` are the materialization source for instantiation
   (prefabs.md §7.3).
4. `components.behavior` is validated on every load: an unresolvable
   `behaviorId` is `behavior_reference_missing`; an undeclared key is
   `property_unknown`; a type/value failure is `property_type`/`property_value`.
   A document is **invalid**, not silently repaired: unknown keys are never
   dropped.
5. **One mutation path per component.** `transform` is owned by the accepted
   `setTransform`; `behavior` by `setBehaviorProperties`; `prefab` is written only
   by `instantiatePrefab` and is read-only afterwards; `box`, `camera` and `model`
   by `setComponent`. No operation accepts a component it does not own
   (`field_value`).

### 10.6 `components.prefab` (informational provenance)

```ts
interface PrefabProvenanceComponent {
  prefabId: string; // must resolve in content.prefabs
  localId: string;  // must exist in that definition's entities
}
```

- Canonical key order: `prefabId`, `localId`.
- It is written **only** by `instantiatePrefab`; it is read-only for every other
  operation (`setComponent` must not accept `prefab`; `prefab_component_forbidden`
  inside a definition).
- Validation: it must resolve (`prefab_reference_missing`); it never participates
  in rendering, runtime, inheritance, override or revert behavior.
- It is what makes `prefab_nested_forbidden` decidable at capture time, and what
  lets the UI show "Copy of <displayName> — copies are independent".
- Because M2 has no prefab deletion, a provenance reference can never dangle. A
  future deletion operation must define a never-reuse/tombstone rule and a
  policy for live provenance references (contract change).

### 10.7 `collider`

```ts
type ColliderShape =
  | { type: 'box'; hx: number; hy: number }                  // 0 < v ≤ 1e6
  | { type: 'polygon'; vertices: [number, number][] };       // 3–8 strict-convex vertices, |v| ≤ 1e6

interface ColliderComponent { shape: ColliderShape }
```

0–256 entities may carry `collider` (`limits_exceeded` limit `colliders`);
`collider` may coexist with `box` (an authored box that renders and collides) or
`model` (a GLB visual with an authored collider); `collider` and `controller` on
one entity is `component_conflict`. Polygon validation: vertices in
counter-clockwise order, finite, no duplicate adjacent vertices, convex within
`1e-9` (collinear triples allowed), area ≥ `1e-6` m², bounding half-extent ≤
`64` m; a violation is `collider_shape_invalid`. M2 caps: 8 vertices per polygon
and 1024 polygon vertices per scene (`limits_exceeded` limits
`collider_vertices`, `collider_vertices_total`). A `collider` entity is static
(`physics.md` §3) and its transform rules are §21.2.

### 10.8 `controller`

```ts
interface ControllerComponent { }                            // marker; no fields in M2
```

At most one entity in a document carries `controller` (a second one is
`controller_count_invalid`); it is the **single** kinematic character. The
**runtime** requires exactly one — a document with zero controllers is valid
model data, but runtime instantiation fails closed as invalid configuration
(`config_invalid`; physics fixture V19). Only the `controller` entity may be
physics-driven. The capsule/skin/snap/window constants are
contract constants (§21.6), not component fields. The controller must be a root,
at unit scale and upright (§21.2).

## 11. Hierarchy semantics

### 11.1 Structure

- Entities form a **forest of rooted trees** (`parentId: null` = root).
- An entity has at most one parent; every non-root parent reference resolves
  to an existing entity in the same scene.
- **Parent-before-child order:** in the `entities` array, an entity must
  appear **before** each of its descendants. Array order among siblings is
  the hierarchy display order and the deterministic render (paint) order:
  earlier = painted first. The validator does **not** reorder; a document
  violating the invariant is invalid (`order_parent_before_child`), and the
  writer must emit it correctly.
- M1 commands include no reorder/rename (packet 02), so the invariant is
  stable under the M1 command set; a future reorder command must re-emit the
  array satisfying §11.1.

### 11.2 Missing references and cycle rejection

- `parentId` naming a non-existent entity → `reference_missing`.
- **Cycle rejection (normative algorithm):** because each node has ≤ 1
  parent, the graph is a functional graph. Walk each entity's parent chain
  with three states (`unvisited`, `visiting`, `done`). Reaching a node in
  state `visiting` on the current walk → cycle → `hierarchy_cycle`, error
  listing the node IDs of the cycle in walk order (e.g. `["a", "b"]` for
  `a → b → a`). A self-parent (`parentId === id`) is a cycle
  (`["a"]`). Complexity is O(n). A document with a cycle is invalid as a
  whole; no entity is silently dropped.

### 11.3 Deletion semantics (M1, normative for the command layer)

- Deleting an entity removes it **and its entire subtree** (all
  descendants, recursively). M1 defines no leaf-only deletion mode.
- The scene's single camera **cannot** be deleted: any command whose result
  would leave zero cameras is invalid (the §10.3 invariant must hold in
  every valid document).
- M1 cross-entity references are parent links only, and all of an entity's
  incoming references come from inside its subtree (children) — so subtree
  deletion **cannot** produce dangling references. (Future cross-referencing
  components must define their own deletion policy in a contract change.)
- Remaining entity IDs are unchanged; array order of survivors is unchanged;
  the parent-before-child invariant holds after deletion.
- Revision advancement for the resulting document is the command layer's job
  (§6); the data contract only defines the surviving document's validity.
- **Entity-reference property values (M2).** With `components.behavior` values of
  declared type `entityRef`, deletion performs one extra check before removing
  anything: if an `entityRef` value in the scene names an entity inside the
  deletion closure while its owner is outside the closure, the whole deletion is
  rejected with `reference_in_use` (`entityIds`, `referencingEntityIds`). Values
  owned inside the closure are removed with it, so the resulting document still
  satisfies the no-dangling-reference rule (`properties.md` §10).
- **The camera cannot be deleted; the controller is an ordinary deletion.**
  A deletion whose closure contains the scene's only camera is rejected with
  `camera_count_invalid` (the §10.3 invariant must hold in every valid
  document). The `controller` component has **no** exactly-one document
  invariant (§10.8: at most one), so deleting the controller entity — or its
  subtree — is accepted and yields a valid document with zero controllers; the
  **runtime** then refuses to instantiate it (`config_invalid`, physics fixture
  V19). Removing a `collider` entity is an ordinary deletion; it removes a
  static body and cannot create a dangling reference (`physics.md` §4).

## 12. Validation and normalization

### 12.1 Entry points (normative API shape; implementation in packet 05)

- `parseManifest(bytes: Uint8Array)`, `parseScene(bytes: Uint8Array)` — pure
  byte-input entry points owned by the project-model package. Run §12.3 pass 1,
  then the corresponding value validator. Return the same result shape as
  `validate*` (§12.5). Do not mutate or consume the caller's bytes; retaining
  failed source bytes on disk is the caller/workspace's responsibility.
- `validateManifest(doc: unknown)`, `validateScene(doc: unknown)` — pure
  checks over in-memory values, starting at §12.3 pass 2. Re-check all value
  rules, including finiteness: parsed values are not inherently safe. These
  APIs cannot detect lost duplicate keys, encoding, or syntax; persisted or
  interchange bytes must first use the appropriate strict byte parser.
  No filesystem access or three.js dependency is introduced.
- `validateProject(manifest, scene)` — both documents, then cross-document
  checks (§13).
- `normalizeManifest(doc)`, `normalizeScene(doc)` — validate, then return a
  **new** canonical document (§12.2). Never mutates the input.
- `parseSceneV2(bytes)`, `validateSceneV2(doc)`, `normalizeSceneV2(doc)` — the
  **explicit** `schemaVersion` 2 entry points (packet 20). The name carries the
  version because there is **no standalone v2 interchange file**: the v2 scene
  is the envelope-embedded value, and only the V2 validators accept it.
  `validateScene`/`parseScene` remain the §8 **interchange** entry points — a
  standalone scene file is `schemaVersion` 1 (`INTERCHANGE_SCENE_VERSIONS`),
  and the M1 fixture `invalid/unsupported-version.json` pins the single
  `schema_version_unsupported` refusal of a standalone v2 file. The
  per-document `KNOWN_VERSIONS.scene = [1, 2]` (alias
  `SCHEMA_VERSIONS_BY_DOCUMENT`) covers the **active workspace**, where a v2
  envelope may embed either a v1 or a v2 scene.
- `migrateManifest(doc, target)`, `migrateScene(doc, target)` — migration
  entry points (§12.4).
- `validateContent(doc: unknown)`, `normalizeContent(doc: unknown)` — pure value
  checks and canonicalization of the envelope's `content` block (assets.md §4–§6,
  §10). There is deliberately **no** `parseContent(bytes)`: the content block has
  no standalone file, so its bytes are governed by the envelope's strict parse
  (workspace.md §4.3).
- `validateProjectV2(manifest, scene, content)` — three-block composition with the
  §13.1 cross-block reference check.
- `captureContent(scene, content, ctx)` → `CapturedContent` — the pure captured
  immutable content view (new §19).
- `serializeCanonical(doc) → Uint8Array` — emits the §12.2 canonical byte
  form (fixed key order, UTF-8, LF, 2-space indent, one trailing newline,
  no BOM) of a validated manifest or scene document. Pure and byte-stable
  (idempotent in the §12.2 sense). This is the single canonical-bytes source
  consumers compare for byte identity: the workspace envelope's embedded
  scene (workspace.md §4.4), the export `snapshot.json` scene part
  (export.md §3), and the runtime snapshot-integrity test (runtime.md
  §2/§4).
- Constants: `ERROR_CODES` (the §12.6 stable code set, extended by §18.9) and
  `KNOWN_VERSIONS` — the single source of truth for consumers (workspace,
  runtime, exporter, protocol — dependencies.md §3). `KNOWN_VERSIONS` becomes a
  per-document structure: `{ manifest: [1], scene: [1, 2] }`, with
  `SCHEMA_VERSIONS_BY_DOCUMENT` as the same value under a descriptive name
  (this is a **breaking change to the constant's type**; it is part of the same
  reviewed diff and packet 20 implements it).
- Validation is pure and total: same input → same result; it never reads or
  writes the filesystem and never throws on malformed data (errors are
  returned values).

### 12.2 Canonical form (stable for diffs)

The normalizer produces byte-stable output for a logical document:

1. Fill missing optional fields with defaults (§7–§10); strip nothing
   else (unknown fields are errors, not stripped — §12.6).
2. Preserve finite numeric values, including accepted near-unit quaternions
   (§10.1); convert negative zero to zero. Numbers are IEEE-754 doubles,
   serialized with JavaScript `JSON.stringify` shortest round-trip decimal
   semantics. No quaternion renormalization, rounding, or quantization occurs.
3. Lowercase `material.color` hex.
4. Emit fixed key order:
   - manifest: `schemaVersion`, `engineVersion`, `id`, `name`,
     `createdAt`, `scenes`;
   - scene: `schemaVersion`, `sceneId`, `revision`, `entities`;
   - entity: `id`, `name` (if present), `parentId` (if non-null),
     `components`;
   - components in registry order, fields per §10; in a `schemaVersion` 2 scene
     the registry order is `transform`, `model`, `box`, `camera` (only
     `transform` plus the reference shape `components.model.asset.assetId` is
     fixed by the M2 content contract; the remaining v2 component fields and
     their internal key order are packet 20's, and they are appended after
     `model` in that same registry);
   - content block: `assets`, `prefabs`, `behaviors`, `settings`; each
     `assets[i]`: `assetId`, `kind`, `displayName`, `currentVersion`, `versions`;
     each `versions[j]`: `version`, `sourceDigest`, `sourceByteLength`,
     `importRecipe`, `metrics`, `importedAt`, `publishedRevision`;
     `importRecipe`: `profile`, `recipeVersion`, `toolchain`, `extensions`;
     `metrics` in the field order of §18.6. `content.assets` is emitted in
     ascending `assetId` codepoint order.
   - prefab definition: `prefabId`, `displayName`, `createdRevision`,
     `entityCount`, `depth`, `entities`; each entity `localId`, `name` (if
     present), `parentLocalId` (if non-null), `components` (registry order,
     definition-component subset); `content.prefabs` ascending `prefabId`;
   - behavior record: `behaviorId`, `displayName`, `declaration`, `source`,
     `publishedRevision`; `declaration`: `properties`; each property `key`,
     `label`, `type`, `default`, `min`, `max`, `step`, `maxLength`, `values`,
     `bounds` (present fields only); `components.behavior.values` in declaration
     order; `content.behaviors` ascending `behaviorId`;
   - `content.settings`: ascending key codepoint order.
   - `components.collider`: `shape`; `shape`: `type` then `hx`, `hy` (box) or
     `vertices` (polygon; each vertex `[x, y]` in input order);
     `components.controller`: `{}` (no fields);
   - `content.settings`: packet 17's six keys, emitted in ascending key
     codepoint order (the container rule above already covers it).
   - `content.behaviors[i].source` (when non-null): `sourceDigest`,
     `sourceByteLength`, `entryPath`, `fileCount`, `manifestDigest`,
     `outputDigest`, `outputByteLength`, `requiredModules` (ascending),
     `publishedRevision` (§22.2); `source: null` is emitted as `null`
     (the earlier record shape is preserved verbatim);
   - `content.behaviorTrust`: `entries` in ascending `sourceDigest` order, each
     entry `sourceDigest` then `acknowledgedRevision` (§22.5);
   - content key order is `assets, prefabs, behaviors, settings, behaviorTrust`
     (the earlier order plus one key).
   - **v3 additions.** The content key order becomes
     `assets, prefabs, behaviors, settings, behaviorTrust, game`; `content.game`
     is emitted last, as `null` or the canonical §23.4 block. Components are
     emitted in the §23.3 registry order with the field orders of
     §§23.3.1–23.3.6 and §23.4. Only the §23.7 defaults are filled (present
     `surface` fields; `light.castShadow` on a directional light); `activation`
     sub-fields and a `null` `content.game` are never invented or expanded.
     `surface.color`, `surface.emissive`, `light.color` and
     `activation.emissive` are lowercased like §12.2 rule 3.
5. Preserve `entities` array order; never sign-flip quaternions; never
   rewrite timestamps or IDs.
6. Output: UTF-8, LF, 2-space indentation, no trailing spaces, one trailing
   newline, no BOM.
7. Idempotence: `normalize(normalize(x)) == normalize(x)` (byte-identical).

### 12.3 Validation passes (normative order)

Per document (`parse*` begins at pass 1; `validate*` begins at pass 2):

1. **Parse bytes** (RFC 8259 syntax plus duplicate-key rejection):
   - Decode UTF-8 without replacement of malformed bytes. Invalid UTF-8 or
     a leading UTF-8 BOM → exactly one `encoding_invalid` at `""`.
   - Check the complete JSON syntax. Trailing garbage or non-strict tokens
     (`NaN`, `Infinity`, `undefined`) → exactly one `json_parse_error` at `""`.
   - For syntactically valid JSON, reject repeated object member names after
     JSON escape decoding, separately within each object. Return one
     `duplicate_key` for the first repeated name in source order, at its
     decoded, JSON-Pointer-escaped path. Equal names in different objects are
     allowed. `JSON.parse` alone cannot perform this check; it discards all
     but the last value. Do not materialize a last-key-wins value and then
     attempt duplicate detection.
   - This order is normative: encoding, syntax, duplicates, then value
     validation. Parse failures stop deeper checks, even for unknown schema
     versions. Original bytes remain untouched (workspace recovery, packet 07).
   - Valid numeric tokens may overflow binary64 (`1e400` → `Infinity`).
     Decode numbers with JavaScript `JSON.parse` semantics and let the
     value validator return `number_not_finite`, not `json_parse_error`.
2. Document root is a JSON object, else `field_type` at `""`.
3. `schemaVersion` present and known **for that document type**. Unknown →
   **exactly one** error `schema_version_unsupported` (with `found`,
   `knownVersions` = the known set for that document type, and the action hint
   §12.5); validation of that document stops (field errors are meaningless
   against an unknown format).
4. Known version → full validation, **collecting all independent errors**
   (not fail-on-first): field presence/type, ID syntax, duplicate IDs,
   references, hierarchy (§11), numbers/finite/ranges, quaternions,
   component registry and combinations, camera count, limits, timestamps,
   paths.
5. `content.behaviors[i].source` (when non-null) is validated against §22.2:
   digest syntax (`digest_invalid`), `entryPath` exactly `"src/index.ts"`
   (`field_value`), `fileCount` 1–16 (`limits_exceeded` `files`),
   `outputByteLength` 1–131072 (`limits_exceeded` `output_bytes`),
   `requiredModules` ascending/unique/subset-of-`enginePins`
   (`behavior_import_unpinned`), `publishedRevision ≥ 1` for a record written by
   this preparation path — `≥ 0` for a record written by the
   `workspace.md` §16.5.2 copy, which resets it to `0` (`number_out_of_range`).
   The check never reads the filesystem and never claims a hash of bytes it
   cannot read (`behaviors.md` §3.4 item 4).
6. `content.behaviorTrust` is validated against §22.5: ≤ 64 entries
   (`limits_exceeded` `trust_entries`), ascending unique digests
   (`digest_invalid` / `id_duplicate`), `acknowledgedRevision ≥ 0`.
7. **v3 documents add one collected pass** (a v3 scene has no `source`/trust
   steps unless the catalog contains behaviors, in which case steps 5–6 run
   unchanged): the registry/combination rules, per-component values, the
   `modelAnimation` role container, counts/limits, scene-level game references
   and cross-block cue/animation resolution, in exactly the §23.8 order. This
   pass is additive; a v1/v2 document never enters it.

Duplicate-ID reporting: first occurrence wins; the error points at the later
occurrence.

### 12.4 Migration entry points (described, not implemented)

- M1 ships **no migrations**. `migrate*(doc, target)` is an identity
  operation when the document's `schemaVersion` equals `target` (and both
  equal `1`); any other pair returns a structured `no_migration_path`
  result (from-version, to-version, `action`: open in an engine that knows
  the format, or convert manually; the original document is retained).
  The M1 entry point `migrateScene(doc, 2)` therefore keeps returning
  `no_migration_path` for `(1 → 2)` — the M1 pin (`fixtures/commands`)
  binds that behavior even though M2 defines a conversion.
- The explicit M1→M2 conversion is **`migrateSceneV1ToV2(doc)`** (packet 20):
  a pure, lossless conversion of a validated v1 scene that retains every
  entity ID and publishes the result as a **new** v2 document (never a
  destructive rewrite). It is a separate, version-named entry point, so the
  M1 `migrateScene` contract above is untouched.
- A future migration is a pure function keyed on
  `(schemaVersion from → schemaVersion to)` operating on parsed documents,
  writing a **new** file version and never rewriting the original in place.
  Hypothetical migrations are out of scope for M1; this section is the
  binding entry-point shape for them.
- **No destructive rewrite, ever:** a document that fails validation or
  migration is retained on disk byte-for-byte; errors are reported against
  it. (Charter §6: invalid external data is reported and retained for
  repair.)

- `migrateSceneV3(scene)` is the pure v2→v3 logical migration (§23.11): it sets
  `schemaVersion: 3` and carries every entity value verbatim (the v3 registry is
  a superset). It is identity on a v3 input, pure and total, and never touches
  disk. The envelope-level v2→v3 **copy** operator (new identity, revision/retry
  reset, resumable crash boundaries) is workspace.md §16.
### 12.5 Error object shape

```json
{
  "code": "quaternion_invalid",
  "path": "/entities/2/components/transform/rotation",
  "message": "rotation quaternion must have unit length within 1e-4",
  "found": [1, 0, 0, 1],
  "expected": "finite [x,y,z,w] with |norm - 1| <= 1e-4",
  "hint": "normalize to unit length; e.g. 45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]"
}
```

- `code` — one of the stable codes in §12.6.
- `path` — JSON Pointer (RFC 6901) to the offending value; `""` for the
  document root; e.g. `/entities/0/components/transform/position/1`,
  `/scenes/0/path`.
- `message` — one actionable human sentence (safe for logs; no secrets).
- `found` — the offending value (present when it exists and is bounded).
- `expected` — the machine-checkable expectation in short form.
- `hint` — optional; for `schema_version_unsupported` it **must** state the
  known versions and the action ("written by a newer/older Thirdlight; open
  with a matching engine, or convert the document; original retained").

Results:

```text
{ "ok": true,  "normalized": <doc> }   ← parse*/validate*/normalize* success
{ "ok": false, "errors": [ <error>, … ] }
```

For `validateProject`, successful `normalized` is
`{ "manifest": <normalized manifest>, "scene": <normalized scene> }`.
Project errors additionally carry the `document` discriminator (§13);
single-document errors do not.

### 12.6 Error codes (stable, normative for M1)

| Code | Raised when |
|---|---|
| `encoding_invalid` | input bytes are not valid UTF-8 or have a leading UTF-8 BOM |
| `json_parse_error` | strict JSON parse failure (incl. `NaN`/`Infinity` tokens, trailing garbage) |
| `duplicate_key` | duplicate object key in the JSON text |
| `schema_version_unsupported` | `schemaVersion` not in known versions `[1]` (single error, stops document validation) |
| `field_missing` | required field absent |
| `field_unexpected` | unknown field (strict: M1 silently drops nothing) |
| `field_type` | wrong JSON type (e.g. string where a number is required) |
| `field_value` | right type, wrong value (e.g. `scenes[i].path` ≠ `"scenes/main.json"`, `type` ≠ `"perspective"`, color not `#rrggbb`) |
| `id_invalid` | ID fails §5.1 syntax |
| `id_duplicate` | two entities with the same `id` |
| `reference_missing` | `parentId` does not resolve to an existing entity |
| `hierarchy_cycle` | parent-chain cycle (§11.2) |
| `order_parent_before_child` | an entity precedes its parent in the array |
| `number_not_finite` | non-finite numeric value (in-memory input or parsed numeric overflow, §12.7) |
| `number_out_of_range` | finite value outside its range (§7–§10 constraints) |
| `quaternion_invalid` | rotation not a finite unit quaternion within `1e-4` |
| `component_unknown` | component key not in the registry (error lists known types) |
| `component_missing` | `transform` absent from an entity |
| `component_conflict` | `box` and `camera` on the same entity |
| `camera_count_invalid` | scene does not contain exactly one `camera` |
| `limits_exceeded` | a declared limit is exceeded; the error carries `limit`: `entities` / `depth` (§10.4) or, in a `schemaVersion` 2 document: the §18.6/§18.4 import-metric limits (`assets`, `asset_versions`, `version_records`, `content_bytes`, `source_bytes`, `nodes`, `meshes`, `primitives`, `materials`, `images`, `textures`, `vertices`, `triangles`, `animations`, `animation_channels`, `clip_duration`, `decoded_bytes`), the prefab/property limits (`prefabs`, `prefab_entities`, `prefab_depth`, `prefab_bytes`, `behaviors`, `properties`, `enum_values`, `declaration_bytes`, `settings_keys` — `prefabs.md` §5, `properties.md` §4), the packet-17 physics limits (`colliders` 256, `collider_vertices` 8 per polygon, `collider_vertices_total` 1024 per scene — `physics.md` §4) the packet-18 limit names `output_bytes` / `trust_entries` (`behaviors.md` §6/§7),
or the v3 limit names `zones` / `player_spawns` / `lights_directional` /
`lights_ambient` / `audio_assets` / `audio_versions` / `game_bytes` /
`animation_profile_bytes` (§23.9/§23.10). |
| `revision_invalid` | `revision` not an integer in `[0, 2^53−1]` |
| `manifest_scene_mismatch` | §13 cross-document failure |
| `no_migration_path` | migration requested for an unsupported version pair (§12.4) |
| `version_combination_unsupported` | a `storageVersion` 2 envelope whose embedded scene is not `schemaVersion` 2 (**or a manifest `schemaVersion 2` paired with `storageVersion ≤ 2`** — M4 C65-2, reason `manifest_storage_mismatch`); single error; the check precedes field validation |
| `asset_reference_missing` | a scene `components.model.asset.assetId` resolves to no record in the envelope's `content.assets` (§13.1) |
| `digest_invalid` | a `sourceDigest` is not exactly 64 lowercase hexadecimal characters |
| `asset_version_invalid` | an asset's `versions` array is not contiguous strictly ascending `1..N`, or a version value is out of range or duplicated |
| `recipe_invalid` | an `importRecipe` is malformed, names an unknown profile or recipe version, or omits a required toolchain entry |
| `prefab_reference_missing` | a `components.prefab` value does not resolve to a definition/localId (`prefabs.md` §8) |
| `prefab_component_forbidden` | a prefab definition entity carries `camera` or `prefab` (`prefabs.md` §3) |
| `behavior_reference_missing` | a `components.behavior.behaviorId` does not resolve in `content.behaviors` |
| `property_unknown` | a `components.behavior.values` key is not declared by the resolved declaration (never silently dropped) |
| `property_type` | a stored or incoming value does not match its declared property type |
| `property_value` | a value violates its declared range/length/enum/bounds |
| `setting_unknown` | a `content.settings` key is not declared by the settings registry (packet 17) |
| `collider_shape_invalid` | a `components.collider.shape` is malformed, degenerate, non-convex, has duplicate/too many vertices or exceeds a polygon bound (`physics.md` §4) |
| `controller_count_invalid` | the scene contains **more than one** `components.controller` entity (the document rule is at most one; zero is valid model data that the runtime rejects at instantiation) (`physics.md` §4) |
| `physics_transform_unsupported` | a physics-bearing entity is parented, has non-unit scale, is rotated outside the Z axis, or (for `controller`) is not upright; carries `reason`: `parented` / `scale` / `rotation` / `upright` (`physics.md` §4) |
| `behavior_source_invalid` | a behavior source container is malformed or is not canonical: bad `graphVersion`, unknown field, bad path/extension/encoding, unsorted `files`, absent entry file, or a TypeScript syntax error; carries `reason` (`behaviors.md` §4.2) |
| `behavior_source_duplicate` | the container declares the same `path` twice (`behaviors.md` §3.1 rule 5) |
| `behavior_source_missing` | a relative import resolves to a path that is not in `files`; carries the resolved `path` (`behaviors.md` §4.2) |
| `behavior_source_escape` | a relative import resolves above the graph root; carries the resolved `path` (`behaviors.md` §4.2) |
| `behavior_source_cycle` | the relative-import graph contains a cycle; carries the cycle path list (`behaviors.md` §4.2) |
| `behavior_import_forbidden` | a forbidden import specifier: `reason` `bare` / `node_builtin` / `absolute` / `network` / `engine_value_import` (`behaviors.md` §4.1/§4.2) |
| `behavior_import_unpinned` | a `requiredModules` entry (or a `source` record's `requiredModules`) is not in the pinned module set; carries the module ID (`behaviors.md` §5.3) |
| `behavior_dynamic_code` | dynamic code generation is present: `reason` `dynamic_import` / `eval` / `function_constructor` / `require` (`behaviors.md` §4.2) |
| `behavior_source_limits_exceeded` | a compiler/preparation bound is exceeded: `limit` `files` / `file_bytes` / `graph_bytes` / `import_depth` / `imports` / `owned_transforms` (`behaviors.md` §6) |
| `behavior_compile_timeout` | the compile wall-clock bound was exceeded (`behaviors.md` §6) |
| `behavior_compile_failed` | the pinned compiler threw; carries a bounded message (`behaviors.md` §4.2) |
| `behavior_output_limits_exceeded` | the compiled output exceeds the byte bound: `limit` `output_bytes` (`behaviors.md` §6) |
| `behavior_output_forbidden_content` | the compiled output contains a forbidden pattern; carries the first ≤ 4 pattern letters (`behaviors.md` §5.5) |
| `behavior_declaration_mismatch` | a stored `source` record is inconsistent with its declaration/manifest/pins: `reason` `digest` / `manifest` / `declaration` / `pins` (`behaviors.md` §4.2/§8.4) |
| `behavior_trust_unacknowledged` | the exact `sourceDigest` is not acknowledged in `content.behaviorTrust.entries`; blocks preparation, publication, play and export (`behaviors.md` §2.3/§7) |
| `game_reference_missing` | `content.game` names an entity/asset that does not resolve, or a required role is absent; carries `path`, `reason` (`player`/`camera`/`camera_follow`/`spawn`/`safe_spawn`/`cue`) (§23.9) |
| `game_reference_in_use` | a deletion or component removal would dangle a game/checkpoint reference; carries `entityIds`, `references` (JSON Pointer paths) (§23.6) |
| `zone_transform_unsupported` | a `gameZone` entity is parented, non-unit-scaled or rotated; carries `path`, `reason` (`parented`/`scale`/`rotation`) (§23.3.1/§23.9) |
| `spawn_transform_unsupported` | a `playerSpawn` entity is parented, non-unit-scaled or rotated; carries `path`, `reason` (`parented`/`scale`/`rotation`) (§23.3.2/§23.9). Registered by the Gate K repair (B3/FU-3): same conditions and reason vocabulary as `zone_transform_unsupported`, separate code |
| `zone_checkpoint_count_invalid` | more than one `role: "checkpoint"` zone in the scene; carries `zoneIds` (§23.3.1) |
| `zone_goal_missing` | `content.game` is non-null and the scene has no `role: "goal"` zone (§23.3.1) |
| `asset_kind_mismatch` | a reference expects one `kind` and the resolved record has another, or a reimport changes `kind` (§23.3.7) |
| `game_config_invalid` | `content.game` is malformed at the block level (`configVersion`, missing/wrong-typed field, string bound, `level`/`killY` relation); carries `path`, `reason` (`field_missing`/`field_unexpected`/`field_type`/`field_value`) (§23.4/§23.9) |

### 12.7 Runtime (non-JSON) validation cases

JSON has no literal `NaN` or `±Infinity` tokens. The directly constructed
cases below exercise the in-memory boundary (packet 05 tests); R6 and numeric
overflow separately exercise byte input:

- **R1** — document value with `position: [NaN, 0, 0]` →
  `number_not_finite` at `/entities/…/position/0`.
- **R2** — `scale: [0, Infinity, 1]` → `number_not_finite` (finiteness is
  checked before range; a separate `number_out_of_range` for the `0` is
  reported as well — all independent errors are collected).
- **R3** — `rotation: [0, -Infinity, 0, 1]` → `number_not_finite`.
- **R4** — `fovY: 1e308` (finite, out of range) → `number_out_of_range`
  at the `fovY` path. This case is JSON-encodable and is exercised
  in-memory here; the `invalid/invalid-numbers.json` fixture carries the
  finite-but-out-of-range class concretely (`fovY: 200`, `far: 2000000`).
- **R5** — a serializer/normalizer handed a non-finite value must reject the
  document (`number_not_finite`); it must **never** emit `NaN`/`Infinity`
  tokens, even as "best effort" output.
- **R6** — a file containing `NaN`/`Infinity` tokens (see
  `invalid/non-strict-json.json`) → strict parse fails →
  `json_parse_error`; bytes retained.

Strict JSON has no literal `NaN` or `Infinity` tokens, but a valid numeric
literal such as `1e400` or `-1e400` overflows to ±Infinity in `JSON.parse`.
`invalid/numeric-overflow.json` pins that byte-input path: syntax succeeds,
value validation returns `number_not_finite`. NaN still requires in-memory
construction. The per-value finiteness check protects **both** byte-input
and in-memory paths. Encoding and duplicate-key byte cases are specified in
`fixtures/project-model/runtime/byte-input-cases.md`.

## 13. Cross-document (project-level) validation

`validateProject(manifest, scene)` accepts logical values and runs both
single-document validations. If either fails, return their errors in manifest
then scene order; do not run cross-document checks. Each project-level error
adds `document: "manifest" | "scene"` to the §12.5 shape so its `path` remains
relative to that document. An unknown version produces exactly one error for
that document; independent errors in the other document are still returned.
Both unsupported documents produce two errors, even if their versions match.

Only if both pass:

1. `manifest.scenes[0].id === scene.sceneId` — else
   `manifest_scene_mismatch` (`document: "manifest"`, path `/scenes/0/id`).
2. Both versions are necessarily `1`; there is no M1 `schema_mixed_versions`
   code. Supporting multiple known versions and compatibility between them
   requires a future contract change.
3. (Workspace-enforced, packet 07): project directory name equals
   `manifest.id`; the workspace envelope/artifact rules are owned by packet 02
   (§3), not by `validateProject`.

For interchange project bytes, call both `parse*` entry points. If either
fails, combine/tag their errors as above without cross-document checks;
otherwise pass their logical normalized values to `validateProject`. This
composition introduces no filesystem operation in the project-model package.

### 13.1 Three-block composition (`validateProjectV2`, v2 envelopes only)

`validateProjectV2(manifest, scene, content)` accepts logical values and runs
`validateManifest` (v1), the v2 scene validation and `validateContent`. If any
block fails, the error sets are returned in manifest, scene, content order and
the cross-block check is **skipped**. Only if all three pass:

1. every `assetId` referenced by a `components.model` value in the scene resolves
   in `content.assets`; otherwise one `asset_reference_missing` per unresolved
   reference, with `document: "scene"` and path
   `/entities/<i>/components/model/asset/assetId`;
2. every `components.behavior.behaviorId` in the scene **and inside every prefab
   definition entity** resolves in `content.behaviors`; every stored
   `components.behavior.values` key is declared by that declaration and
   type-checks; every `entityRef` value in a scene resolves to an existing scene
   entity and every `entityRef` value inside a definition resolves to a
   `localId` of that definition (`behavior_reference_missing`,
   `property_unknown`, `property_type`, `property_value`, `reference_missing`);
3. every `components.prefab` value resolves to a definition and a `localId` of
   it (`prefab_reference_missing`); every definition's `entityCount`/`depth`
   equal the derived values and its component set is the definition subset
   (`prefab_component_forbidden`, `limits_exceeded`);
4. `content.settings` keys are all declared (`setting_unknown`);
5. `content.settings` resolves to a valid gameplay settings object:
   `setting_unknown` for an undeclared key, `field_value` for a value of the
   wrong type or outside its declared range, and `field_value` at
   `/settings/min_slope_slide_deg` when `min_slope_slide_deg >
   max_slope_climb_deg` (new §21.4);
6. every `components.collider`/`components.controller` entity passes the §21.2
   physics-transform rules (`physics_transform_unsupported`) and the §21.1
   count rule (`controller_count_invalid`);
7. the existing §13 checks 1–3 run unchanged.

The check is one-way by design: an unreferenced catalog record is valid retained
content, while a dangling reference is not. The workspace calls this function
after its own envelope-level checks (workspace.md §4.3 steps 6a–6h).

### 13.2 Behavior source, trust and linked-output composition

1. Every `components.behavior.behaviorId` resolves in `content.behaviors`
   (`behavior_reference_missing`), unchanged.
2. A behavior with `source: null` composes with nothing further: no digest, no
   trust entry and no prepared artifact is required, and no runtime module is
   registered for it (`behaviors.md` §9.1).
3. A behavior with a non-null `source` requires, in this order:
   (a) `behavior_trust_unacknowledged` if `source.sourceDigest` has no entry in
   `content.behaviorTrust.entries`; (b) `behavior_publication_unavailable`
   (`preparation_missing`) if no prepared artifact for the digest exists in the
   environment — a *play/export* composition check, not a document check (a
   document is valid without the derived artifact, exactly as
   `content-storage.md` §1 treats derived caches); (c) `behavior_declaration_mismatch`
   if the artifact's manifest does not match the declaration and pins.
4. `behaviorTrust.entries` entries whose digest matches no behavior record are
   **allowed** (they are inert history, exactly like an unreferenced blob: they
   do not make a document invalid and they do not need GC — `behaviors.md` §7).
5. `source.publishedRevision` must not exceed the envelope revision
   (`number_out_of_range`); a record with a future revision is rejected rather
   than repaired. (A `workspace.md` §16.5.2 migration destination is a fresh
   project whose records carry `0`; the destination's asset and behavior
   `publishedRevision` values are reset to `0` for the same reason.)

### 13.2 Three-block composition (`validateProjectV3`, v3 envelopes only)

Normative text: [`../model.md`](../model.md) §23.5/§23.8 step 6 — the v2
cross-block check (`components.model.asset.assetId` → `kind: "model"`) plus the
v3 game/cue/animation reference checks. Error objects keep the accepted
`document: "manifest" | "scene" | "content"` tagging. A v3 project never runs
the v2-only composition and vice versa.
## 14. What is deliberately not in this contract

- No ECS generalization: the component registry is a fixed M1 table
  (§10); no dynamic registration, no component inheritance.
- No physics, no input, no gameplay components (M2).
- No prefabs/instances, no variants (M2).
- No assets or asset references **in `schemaVersion` 1**; the M2
  `schemaVersion` 2 scene adds whole-GLB asset references (new §18) — still no
  subresource references, no lights, and no materials beyond `box.material.color`
  and the imported GLB's own core-PBR materials. That bullet is scoped to scene schemaVersion 1/2. Scene schemaVersion 3 adds the reviewed bounded `light` component (one directional key + one ambient fill, §23.3.4) and the copied-value `surface` component (§23.3.5, §18.1 rule 3's single version-local exception aside); it adds no material graph, no light beyond those two and no linked material resource.
- No prefab updates/deletion/variants/nesting, no linked-instance inheritance, no
  property expressions/computed values/arbitrary object graphs, no component
  add/remove outside the defined operations, and no behavior source publication
  or execution (`prefabs.md` §15, `properties.md` §15; packets 18/20/33).
- No dynamic bodies, joints, sensors, moving or one-way platforms,
  mesh-derived colliders, character tilt/rotation, multiple characters, Z-axis
  collisions or Rapier 3D; no collider scaling, per-entity capsule tuning or
  friction/restitution authoring (`physics.md` §3/§13).
- No behavior source storage format beyond the single canonical source-graph
  container (§22.1): no multi-file staging protocol, no source directories in
  the project tree, no globs, no archives and no per-file addresses in any
  document.
- No trust, compilation, linking, build or execution semantics for behaviors —
  those belong to the runtime, command, workspace, exporter and UI contracts;
  this document validates shapes and digests only.
- No property write-back, no entity mutation and no physics data written by a
  behavior: the scene is authored data and stays read-only at play time
  (`runtime.md` §4/§10).
- No world-transform persistence, no per-entity visibility flags, no
  per-entity tags.
- No rename/reorder in M1 documents' command surface (packet 02); the
  invariants §11.1 must nevertheless hold.
- No second scene, no scene naming (the manifest `name` is the only M1
  display name).
- No multi-file transactions, no journaling (packet 02/07).

- **v3 adds no document and no second mutable file.** The game-configuration
  block lives inside the envelope's `content` (`content.game`), is typed, bounded
  and authored only by `setGameConfig` (commands.md). There is no game JSON blob,
  no script/HTML/expression field, no remote asset reference and no per-entity
  arbitrary data map.
## 15. Default scene (project-creation template, normative)

Creating a project initializes the manifest (§7) and exactly this logical
scene (revision `0`). In active storage, the scene is embedded in the atomic
authoring-state envelope (§3); this template does not define that envelope:

```json
{
  "schemaVersion": 1,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [
    {
      "id": "cam-main",
      "name": "Main Camera",
      "components": {
        "transform": {
          "position": [0, 0.5, 4],
          "rotation": [0, 0, 0, 1],
          "scale": [1, 1, 1]
        },
        "camera": { "type": "perspective", "fovY": 60, "near": 0.1, "far": 100 }
      }
    }
  ]
}
```

Camera defaults recap (§2): identity rotation → looks down −Z, +Y up;
position `[0, 0.5, 4]` places the camera on the +Z side of the origin,
consistent with the 2.5D XY movement plane. `fovY 60`, `near 0.1`, `far 100`.

## 16. Fixture index

`fixtures/project-model/` (index: `fixtures/project-model/expected.json`):

| Fixture | Kind | Expectation |
|---|---|---|
| `valid/demo-project/` (manifest + scene) | project | valid; demonstrates hierarchy, local vs world frames, non-identity quaternion, box materials, camera |
| `valid/minimal-scene.json` | scene | valid; equals the §15 default scene |
| `valid/defaults-omitted.json` | scene | valid; omits all defaulted optional fields — pins §12.2 rule 1 (defaults are filled on load; strict output always includes them) |
| `valid/quaternion-round-trip.json` | scene | valid; roundoff-sensitive and near-unit rotations preserved; exact canonical output in `expected/quaternion-round-trip.json` |
| `invalid/duplicate-ids.json` | scene | `id_duplicate` |
| `invalid/hierarchy-cycle.json` | scene | `hierarchy_cycle` (a ↔ b) |
| `invalid/missing-reference.json` | scene | `reference_missing` |
| `invalid/invalid-numbers.json` | scene | `field_type`, `number_out_of_range`, `quaternion_invalid` (all collected in one document) |
| `invalid/unknown-component.json` | scene | `component_unknown` |
| `invalid/two-cameras.json` | scene | `camera_count_invalid` |
| `invalid/missing-transform.json` | scene | `component_missing` |
| `invalid/unsupported-version.json` | scene | `schema_version_unsupported` (future version 2; single error, no field errors) |
| `invalid/unsupported-version-past.json` | scene | `schema_version_unsupported` (past version 0) |
| `invalid/non-strict-json.json` | manifest | **intentionally not strict JSON** (`NaN`/`Infinity` tokens) → `json_parse_error`; see its README note |
| `invalid/manifest-scene-mismatch/` | project | `manifest_scene_mismatch` |
| `invalid/mixed-schema-versions/` | project | one `schema_version_unsupported` attributed to scene; no cross-document errors |
| `invalid/duplicate-key.json` | scene bytes | `duplicate_key` before version checking; duplicate names are compared after escape decoding |
| `invalid/numeric-overflow.json` | scene bytes | valid JSON syntax; ±Infinity from numeric overflow → `number_not_finite` |
| `runtime/non-finite-cases.md` | runtime | R1–R6 cases from §12.7 (in-memory, not JSON fixtures) |
| `runtime/byte-input-cases.md` | bytes | encoding, syntax/duplicate precedence, and project error attribution cases |

Packet 05 must pass fixture bytes through `parse*` (project composition per
§13), valid values through validation + normalization twice and a serialized
round-trip, and invalid fixtures expecting exactly the listed **set** of
codes. The index may also pin error count, paths, and document attribution.
Compare canonical bytes to `expectedNormalized` golden files where supplied.
Unexpected additional codes are a contract/implementation bug, not ignored.
In-memory and constructed byte cases exercise their respective entry points.

## 17. Change rules

- After Gate A acceptance, any change that old readers could misinterpret
  (new required field, changed meaning, new component type, new logical
  document) → new `schemaVersion` and a reviewed contract diff (AGENTS.md:
  accepted contracts are binding). Workspace envelope versions are owned
  separately by packet 02 and never substitute for logical `schemaVersion`.
- Additive, always-optional, always-defaulted fields are **not** permitted in
  M1 (strict `field_unexpected`); they become a version bump.
- Fixtures are part of the contract: changing a fixture's expected codes
  requires the same review as the contract text.
- M2's scene `schemaVersion` 2 / `storageVersion` 2 material (new §§18–19,
  workspace.md §4.5) follows these rules exactly: the manifest stays
  `schemaVersion` 1, `schemaVersion` 1 documents remain valid and unmodified, no
  same-version extension is added to either version, and the new bound values
  (assets.md §6, workspace.md §13.9) are part of the contract because fixtures
  and tests reference them.
- The packet-16 `schemaVersion` 2 material (new §20; `prefabs.md`/`properties.md`)
  follows these rules exactly: it is a new known version combination, not a
  same-version extension of `schemaVersion` 2's packet-15 subset — the packet-15
  v2 scene/material stays valid (empty `prefabs`/`behaviors`, `{}` settings), and
  the new element shapes, limits and codes are part of the contract because
  fixtures and tests reference them.
- The packet-17 v2 material (new §21) is additive on top of packets 15/16: the
  packet-15/16 v2 scene stays valid (no collider/controller entity, `{}`
  settings — the physics **document** rule is *at most one* controller, while
  the **runtime** requires exactly one, so a controller-less document remains
  valid model data that fails only at instantiation), the two new components
  are appended to the v2 registry without
  renumbering any existing field, and the component shapes, transform rules,
  limits and settings registry are contract material because fixtures and
  acceptance A12/A13 reference their exact values.
- The packet-18 v2 material (new §22) is additive on top of packets 15/16/17:
  `source` keeps packet 16's canonical key order and gains a value shape,
  `content.behaviorTrust` is appended as a fifth content key, and no existing
  field is renumbered or reinterpreted. Every v2 envelope fixture gains
  `"behaviorTrust": { "entries": [] }` in the same promotion step (a recorded
  change request, `behaviors.md` §13 C18-8).
- **The packet-39 v3 material (new §23) is a new known version combination**, not
  a same-version extension: v1/v2 scene documents stay valid and unmodified,
  `manifest schemaVersion` stays 1, and no v2 field is renumbered or
  reinterpreted. The added components, the `content.game` block, the reference/
  deletion rules, the limits and the new error codes are contract material
  because fixtures, the checker and acceptance rows B02/B03/B12/B16/B17/B18
  reference their exact values. Every v3 envelope fixture carries the six-key
  `content` block with `game`.
- The source-graph container's rules (version, path grammar, ordering, bounds,
  the import/dynamic-code taxonomy) are contract material: fixtures and the
  compiler's codes reference their exact values (`behaviors.md` §4/§6).
- A `source` value may be written only by the preparation path
  (`behaviors.md` §8.3/§8.4). A change that lets a caller-supplied digest or
  manifest reach the document is a contract violation, not an implementation
  detail.
- Revision 0.2 is an explicit pre-acceptance correction of packet 01 review
  findings: logical/storage separation, byte parser boundary, preservation of
  accepted quaternions, and per-document version-error precedence. No accepted
  schema or implemented reader exists yet; logical `schemaVersion` stays `1`.
  Gate A remains pending; see `docs/handoffs/01.md` for evidence and limitations.

## 18. Content catalog, asset records and the M2 import profile (scene schemaVersion 2 / storageVersion 2)

### 18.0 Envelope-only state


The envelope file, its atomic replacement and its guarantees are unchanged
(`workspace.md` §§4/5). `storageVersion` **2** adds exactly one bounded
top-level `content` block alongside `scene` and `retry`:

```json
{
  "storageVersion": 2,
  "type": "authoring-state",
  "projectId": "demo-0002",
  "scene": { "schemaVersion": 2, "sceneId": "scene-main", "revision": 7, "entities": ["…"] },
  "content": {
    "assets": ["…AssetRecord…"],
    "prefabs": [],
### 18.1 Asset identity model


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

   **One reviewed exception (M3, packet 41).** The scene value
   `components.modelAnimation.roles[role]` (`presentation.md` §41.3.1) may carry
   the immutable, version-local clip binding `{ clipIndex, clipName }` for the
   asset version named by that same component's `assetId` and `version`. The
   exception is bounded exactly by these rules:
   (a) **scene data only** — it appears in no `content` block, prefab
       definition, `AssetRecord`, derived cache, captured manifest, export
       identity, proposal or diagnostic;
   (b) **version-scoped and reimport-invalidated** — both fields describe one
       immutable `(assetId, version)`; a reimport appends a new version and never
       moves or inherits the binding, and a reimport of a referenced animated
       asset must submit the new binding with the new bytes in one transaction
       (`presentation.md` §41.3.4);
   (c) **validated, never a lookup key** — the pair is validated against the
       version's real clip list at publication and re-validated at load; the
       runtime selects exclusively by `clipIndex`, and `clipName` is a bounded
       consistency/display value that must equal `clips[clipIndex].name`;
   (d) **no other internal name or index is permitted anywhere**, and adding a
       role key or a binding field requires a `schemaVersion` change.
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

**M2 realization note (bounded).** An M2 model instance realizes one whole GLB
under one entity holder; the shared visualization path clones the parsed GLB
hierarchy (`Object3D.clone(true)`). Three's `clone(true)` shares `SkinnedMesh`
skeletons between clones, so per-instance **skeletal** animation is not claimed
in M2 (no M2 fixture carries a skin, and A12 excludes skeletal animation). A
future packet that needs independent skeletons must use a reviewed
skeleton-aware clone and re-validate this note.

### 18.2 `ContentCatalog`


| Field | Type | Required | Constraint |
|---|---|---|---|
| `assets` | array of `AssetRecord` | yes | 0–128 (cap); ascending `assetId` codepoint order in canonical form; `assetId` unique |
| `prefabs` | array | yes | `[]`, or elements per §20.1/§20.2 (an empty container remains valid; ≤ 64 definitions) |
| `behaviors` | array | yes | `[]`, or elements per §20.8/§22.2 (an empty container remains valid; ≤ 64 records) |
| `settings` | object | yes | `{}`, or the ≤ 32 declared keys per §20.9 (an empty container remains valid) |
| `game` | `GameConfig` or `null` | yes **in a `storageVersion` 3 envelope only** | `null`, or the bounded §23.4 block; ≤ 16 384 canonical bytes (`limits_exceeded` `game_bytes`). Absent in a v2 envelope (where the key set stays exactly five) |

Canonical key order: `assets, prefabs, behaviors, settings, behaviorTrust,
game` (v3; a v2 envelope stops at `behaviorTrust`). Unknown fields ⇒
`field_unexpected` at any level.

### 18.3 `AssetRecord`


| Field | Type | Required | Constraint |
|---|---|---|---|
| `assetId` | string | yes | §3; ID syntax; unique within the catalog |
| `kind` | string | yes | `"model"` (whole-GLB model kind) or `"audio"` (bounded PCM-WAV cue kind; §23.3.7). Fixed at create; a reimport with a different kind is `asset_kind_mismatch`. Any other value is `field_value` |
| `displayName` | string | yes | 1–128 chars, no control characters; display only, renameable, never an identity |
| `currentVersion` | integer | yes | equals the **last** element's `version` (the list is contiguous) — a derived pointer; a disagreeing value is `field_value`, never normalized |
| `versions` | array of `AssetVersion` | yes | 1–32 (cap); strictly ascending, contiguous `1..N`; append-only in M2 (no gaps, no reorder, no removal) |

Canonical key order: `assetId, kind, displayName, currentVersion, versions`.

### 18.4 `AssetVersion`


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

### 18.5 `ImportRecipe`


```json
{ "profile": "gltf-glb", "recipeVersion": 1, "toolchain": { "three": "0.186.0" }, "extensions": [] }
```

| Field | Type | Constraint |
|---|---|---|
| `profile` | string | exactly `"gltf-glb"` or `"pcm-wav"`. `"gltf-glb"` is the
  M2/M3 model profile (§18.7); `"pcm-wav"` is the M3 audio profile
  (`presentation.md` §41.4.3). A recipe's other fields depend on its profile |
| `recipeVersion` | integer | exactly `1` in M2; advances when the recipe's *decisions* change (which extensions are decoded, which fields feed `metrics`, how quantization is handled) |
| `toolchain` | object | 1–8 entries `name → exact version string` (semver, project-model §6 regex where the tool uses one); keys sorted codepoint order; must name **every** tool whose version can change the decoded result (in M2: `three`, i.e. the pinned GLTFLoader major line). The repository's pinned versions are the only accepted values until a reviewed dependency change |
| `extensions` | array of string | **present iff `profile === "gltf-glb"`**; ascending codepoint order; the extensions **actually used** by this source, each member of the profile allowlist (§7.3); `[]` when none. For `profile === "pcm-wav"` the key is absent (`field_unexpected` if present) — a WAV has no glTF extensions |
| `toolchain` | object | 1–8 entries `name → exact version string`; keys sorted codepoint order; must name **every** tool whose version can change the inspected result. For `"gltf-glb"` that is `three` (§18.5 accepted); for `"pcm-wav"` it is exactly `asset-pipeline` — the bounded pure inspector, with no decoder/library/`three` in the path (`presentation.md` §41.4.3) |

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

### 18.6 Decoded-resource metrics and caps


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
**Audio metric member (`presentation.md` §41.4.3).** For `kind: "audio"`
(`profile: "pcm-wav"`) `metrics` is `PcmWavMetrics`, whose fields are
`container: "riff-wave"`, `encoding: "pcm-s16le"`, `channels: 1`,
`sampleRate: 48000`, `bitsPerSample: 16`, `frames`, `durationMs`, `pcmBytes`,
`dataChunkBytes`, `riffChunkBytes`, in exactly that canonical order. Its caps
are the exact arithmetic of `presentation.md` §41.4.2: `frames ≤ 96 000`,
`pcmBytes ≤ 192 000`, `durationMs = floor(frames / 48) ≤ 2000`,
`dataChunkBytes === pcmBytes`, `riffChunkBytes === 36 + pcmBytes`, and
`sourceByteLength === 44 + pcmBytes ≤ 192 044`. Like the GLB member, the audio
member is **re-validated against every cap on load**; a disagreeing record is
invalid (`limits_exceeded` / `field_value`), never normalized.

### 18.7 M2 import profile (glTF 2.0 GLB) and validation order


§18.7 defines the **model** profile (`gltf-glb`) only. The M3 audio profile
`pcm-wav` is `presentation.md` §41.4: RIFF/WAVE linear PCM, mono, signed
16-bit little-endian, 48 000 Hz, exactly two chunks, `44 + pcmBytes` bytes with
`pcmBytes ≤ 192 000`, inspected by pure bounded byte arithmetic in
`asset-pipeline` (no decoder, no Node built-in, no network). Nothing in §18.7's
GLB order applies to a WAV.
#### 18.7.1 Accepted subset

- **glTF 2.0 binary (GLB) only.** No `.gltf` + sidecar, no archive, no URL, no
  plugin importer, no glTF 1.0.
- Exactly two chunks: a JSON chunk followed by a BIN chunk; all buffers and
  images are embedded in the BIN chunk (`bufferView`s).
- Core PBR materials (`pbrMetallicRoughness`, `normalTexture`,
  `occlusionTexture`, `emissiveTexture`, `emissiveFactor`, `alphaMode`,
  `alphaCutoff`, `doubleSided`), plus the small allowlisted extension set (§7.3).
- Embedded animation data (samplers/channels) within the caps of §6.
- Bounded meshes/nodes/images/textures (§6). Triangle `mode` 4 only.

#### 18.7.2 Normative validation order

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
| 7 | **BufferViews:** index in range; `byteOffset + byteLength ≤ buffers[0].byteLength`; every bufferView referenced by an accessor starts at a 4-byte boundary (`byteOffset % 4 === 0` — the glTF 2.0 alignment rule; a bufferView used only by an image need not be aligned); no `target` outside `{34962, 34963}` | `asset_buffer_invalid` |
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

**`kind: "behavior-source"` preparation profile (C19-D1).** In addition to the
`"model"` GLB profile above, the workspace's content preparation accepts a
`kind: "behavior-source"` profile whose staged bytes are the canonical
source-graph container of §22.1; its validation is §22.3, its prepared output is a
**derived cache** (§22.4, regenerateable from the immutable container blob, never
authoritative), and its publication is unavailable until packet 33's preparation
path exists (`behaviors.md` §8.3; workspace.md §13.3.1).

### 18.8 Extension allowlist and import diagnostics

#### 18.8.1 Extension allowlist

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

#### 18.8.2 Import diagnostics (stable code set)

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

#### 18.8.3 Determinism

For fixed `(bytes, profile, recipeVersion, toolchain)` the inspection result
(`metrics`, used extensions, ordered diagnostics) must be byte-deterministic —
it feeds the preserved `importRecipe` and therefore the derived-cache key. No
clock, PRNG, environment variable, locale or network access may influence it.
Wall-clock accounting appears only in the bounded job timeout and is never
persisted.

### 18.9 Validation, normalization and error codes


#### 18.9.1 Entry points (proposed shapes)

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

#### 18.9.2 Validation order (content block)

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
   (`number_out_of_range`, and `≤ scene.revision` ⇒ `field_value`; a
   `workspace.md` §16.5.2 migration copy writes it as `0`, which satisfies this
   bound at the destination's `revision` 0).
5. Total version records ≤ 1 024 else `limits_exceeded`
   (`limit: "version_records"`).
6. Containers: `prefabs`/`behaviors` must be arrays (`field_type`) whose elements validate per §20 (`prefab_*`/`behavior_*`/`property_*` codes, §20.1–§20.8); `settings` must be an object (`field_type`) whose keys are declared per §20.9/§21.4 (`setting_unknown`/`field_value`); an empty container remains valid. `behaviorTrust` is required and validates per §22.5 (`field_missing` when omitted).
7. Canonical `content` bytes ≤ 1 048 576 else `limits_exceeded`
   (`limit: "content_bytes"`).

All independent errors are collected (not fail-on-first), matching the accepted
project-model behavior. Validation is pure and total: same input → same result,
never throws, never reads files.

#### 18.9.3 New model error codes

| Code | Raised when |
|---|---|
| `version_combination_unsupported` | a v2 envelope with `scene.schemaVersion !== 2` (single error, stops) |
| `asset_reference_missing` | a scene model reference resolves to no catalog record (`document: "scene"`, path at the component) |
| `digest_invalid` | `sourceDigest` is not 64 lowercase hex |
| `asset_version_invalid` | versions are not contiguous/ascending, duplicated, or out of range |
| `recipe_invalid` | the import recipe is malformed, of an unknown profile/recipe version, or missing a required toolchain entry |
| `animation_role_out_of_range` | `modelAnimation.roles[role].clipIndex` ≥ the named version's `metrics.animations`; carries `path`, `role`, `clipIndex`, `clips` |
| `animation_role_duplicate` | two roles of one `modelAnimation` share a `clipIndex`; carries `path`, `clipIndex`, `roles` |
| `animation_role_mismatch` | `clipName ≠ clips[clipIndex].name` (inspection/publication/load); carries `path`, `role`, `expected`, `found` |
| `animation_role_ambiguous` | the version's clip list has more than one clip named `clipName`; carries `path`, `role`, `clipName`, `matches` |
| `animation_skin_unsupported` | the animated-profile GLB carries `skins` or a `JOINTS_0`/`WEIGHTS_0` attribute; carries `path` |
| `animation_root_motion` | a channel animates a scene root node's `translation`; carries `path`, `role`, `nodeIndex`, `nodeName` |

`limits_exceeded` gains the `limit` values of `assets.md` §4/§6 and
`content_bytes`; the enum becomes
`'entities' | 'depth' | 'assets' | 'asset_versions' | 'version_records' |
'content_bytes' | 'source_bytes' | 'nodes' | 'meshes' | 'primitives' |
'materials' | 'images' | 'textures' | 'vertices' | 'triangles' | 'animations' |
'animation_channels' | 'clip_duration' | 'decoded_bytes' | 'json_chunk_bytes' |
'image_bytes' | 'animation_clips' | 'animation_tracks' |
'animation_track_times' | 'animation_clip_duration' | 'audio_pcm_bytes' |
'audio_cues'`.

### 18.10 Observable failure outcomes


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


## 19. Captured immutable content view


#### 19.1 Shape

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

#### 19.2 Derivation (normative, pure)

`captureContent(scene, content, { projectId, revision })`:

1. Collect every `assetId` referenced by the captured scene's v2 model
   components (prefab/behavior definition references join the closure), **plus
   in v3** every `components.modelAnimation.assetId` and every non-null
   `content.game` cue / checkpoint `activation.cueAssetId`. A `modelAnimation`
   binding contributes its recorded `version` explicitly; all other entries
   resolve through `currentVersion` as accepted. **CC-44-6 (promoted at Gate
   L):** a `modelAnimation` binding's recorded `version` **wins** over the
   asset's `currentVersion` for the same `assetId`. If two reachable bindings
   record different explicit versions for one `assetId`, the first in scene
   document order (then prefab definition order) wins deterministically:
   conflicting bindings are not valid authoring state and capture neither merges
   nor fails on them.
2. Resolve each to `(currentVersion, sourceDigest, sourceByteLength,
   importRecipe)` from the captured catalog.
3. Sort by `assetId`; emit the view; compute `contentDigest`.
4. A reference that does not resolve is `asset_reference_missing` and is reported
   before any capture (the envelope would not have loaded otherwise).

Unreferenced catalog records are **not** included in the view: the view is a
closure over what the captured scene needs, which is exactly what play and export
must fetch. The full catalog remains in the envelope for editing and for the
backup classification (`content-storage.md` §11).

#### 19.3 Pinning rules

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


## 20. Prefab definitions, declared properties and content-component validation (scene schemaVersion 2)

### 20.1 Prefab identity, immutability and copy semantics


1. **`prefabId` is opaque, caller-supplied and never reused.** It uses
   project-model §5.1 ID syntax, is unique within `content.prefabs`, and is
   validated at creation. M2 has no prefab deletion, so reusing an ID can never
   be legitimate (`prefab_id_duplicate`).
2. **Definitions are immutable in M2.** No operation edits a definition. Changing
   a design means creating a new definition with a new `prefabId`; there is no
   `updatePrefab`, no variants, no apply/revert, no propagation.
3. **Local entity IDs are stable.** `localId` values are the **source scene
   entity IDs** at capture time, stored verbatim. They are scoped to their own
   definition (two definitions may both contain `model-0001`), are never
   reassigned, and are the addressing space for instantiation overrides and for
   the internal-reference remap.
4. **Definitions are materialized, not inherited.** Instantiation produces
   ordinary scene entities with their own scene IDs. There is no live link:
   editing a definition after instantiation does not change any existing
   instance, and editing an instance never writes back. `components.prefab` is
   informational metadata (§8); it grants no inheritance, override or revert
   behavior.
5. **Copy semantics are explicit in API and UI.** The operation names are
   `createPrefab` (capture a definition) and `instantiatePrefab` (materialize
   independent copies). Proposed UI terminology: *"Create Prefab Definition"*
   and *"Place Copy"*; the inspector must label the provenance
   "Copy of <displayName> — copies are independent" and must never offer
   "Link", "Apply", "Revert" or instance inheritance affordances.

### 20.2 `PrefabDefinition` and `PrefabEntity`


```ts
interface PrefabDefinition {
  prefabId: string;        // ID syntax, unique in content.prefabs, never reused
  displayName: string;     // 1–128 chars, no control chars; display only
  createdRevision: number; // == the resulting revision of createPrefab (history metadata)
  entityCount: number;     // derived; must equal entities.length
  depth: number;           // derived; 1 ≤ depth ≤ 16
  entities: PrefabEntity[];// 1–256; definition document order, parent before child
}

interface PrefabEntity {
  localId: string;              // ID syntax, unique in the definition
  name?: string;                // 1–128 chars, no control chars
  parentLocalId?: string;       // null/absent = definition root; must be an earlier localId
  components: PrefabComponents; // transform required; box/model/behavior optional; no camera, no prefab, no collider, no controller
}
```

Canonical key order: `prefabId, displayName, createdRevision, entityCount, depth,
entities`; per entity `localId, name` (if present), `parentLocalId` (if non-null),
`components`; components in registry order (`transform`, `model`, `box`,
`behavior`). The definition vocabulary is **closed**: `camera`, `prefab`,
`collider` and `controller` are forbidden in a definition entity and rejected
as `prefab_component_forbidden` (never silently dropped) — that matches
`commands.md` §5.4. `content.prefabs` is emitted in ascending `prefabId`
codepoint order; `entities` keeps definition document order.
The v3 components `gameZone`, `playerSpawn`, `cameraFollow`, `light`, `surface`
and `modelAnimation` are likewise **not** in the definition vocabulary and are
rejected with the same code. No v3 component is capturable; copying a model
keeps its stable `assetId` and gains no surface or animation profile.

### 20.3 Prefab/instantiation limits


All values are exact proposals; packets 20–28 and Gate E pin them. Exceeding a
declared limit is `limits_exceeded` carrying `limit`, `current` and `max`.

| Class | Bound | Value | Failure |
|---|---|---|---|
| definitions | `content.prefabs` length | ≤ 128 | `limits_exceeded` (`prefabs`) |
| definition size | entities per definition | ≤ 256 | `limits_exceeded` (`prefab_entities`) |
| definition shape | hierarchy depth (definition root = 1) | ≤ 16 | `limits_exceeded` (`prefab_depth`) |
| definition size | canonical definition bytes | ≤ 131 072 | `limits_exceeded` (`prefab_bytes`) |
| instantiation | overrides per request | ≤ 64 | `limits_exceeded` (`overrides`) |
| instantiation | resulting scene entities | ≤ 1024 (accepted) | `limits_exceeded` (`entities`) |
| instantiation | resulting scene depth | ≤ 32 (accepted) | `limits_exceeded` (`depth`) |
| request | canonical request JSON bytes (all packet-16 ops) | ≤ 65 536 | `limits_exceeded` (`request_bytes`) |
| ID space | `<kind>-NNNN`, `0001..9999` per derived kind | 9999 | `id_exhaustion` (`kind`) |

`request_bytes` is measured on the §6.6 digest-canonical serialization of the
request (the same bytes dedup hashes) and is checked before argument validation.
It is a new, additive bound over M1; a request above it changes nothing.

### 20.4 `components.prefab` (informational provenance)


```ts
interface PrefabProvenanceComponent {
  prefabId: string; // must resolve in content.prefabs
  localId: string;  // must exist in that definition's entities
}
```

- Canonical key order: `prefabId`, `localId`.
- It is written **only** by `instantiatePrefab`; it is read-only for every other
  operation (`setComponent` must not accept `prefab`; `prefab_component_forbidden`
  inside a definition).
- Validation: it must resolve (`prefab_reference_missing`); it never participates
  in rendering, runtime, inheritance, override or revert behavior.
- It is what makes `prefab_nested_forbidden` decidable at capture time, and what
  lets the UI show "Copy of <displayName> — copies are independent".
- Because M2 has no prefab deletion, a provenance reference can never dangle. A
  future deletion operation must define a never-reuse/tombstone rule and a
  policy for live provenance references (contract change).
- Realization note (bounded, §18.1): a prefab copy that carries a `model`
  component is realized by the same shared GLB path; `clone(true)` shares
  `SkinnedMesh` skeletons, so independent per-copy skeletal animation is not
  claimed in M2.

### 20.5 Property type vocabulary, defaults and ranges


Exactly seven types. No functions, no arbitrary object graphs, no accessor
execution, no schema discovery by evaluating code, no JSON-Schema machinery, no
unions, no arrays-as-values (a `vec3` is a fixed-length numeric triple, not a
general array), no `null` except as the declared default/unset value of
`entityRef` and `assetRef`.

```ts
type PropertyType = 'number' | 'boolean' | 'string' | 'enum' | 'vec3' | 'entityRef' | 'assetRef';
type PropertyValue = number | boolean | string | [number, number, number] | null;

interface DeclaredProperty {
  key: string;            // ^[a-z][a-z0-9_]{0,63}$ (1–64 chars), unique in its declaration
  label: string;          // 1–64 chars, no control chars
  type: PropertyType;
  default: PropertyValue; // must satisfy this property's own constraints
  min?: number;           // number: finite, |v| ≤ 1e12
  max?: number;           // number: finite, |v| ≤ 1e12; min ≤ max
  step?: number;          // number: > 0, ≤ 1e6 (UI increment only; never validated as a grid)
  maxLength?: number;     // string: integer 1–1024 (default 256)
  values?: string[];      // enum: 1–32 members, each 1–64 chars, no control chars, unique
  bounds?: { min: Vec3; max: Vec3 }; // vec3: finite, component-wise min ≤ max, |v| ≤ 1e6
}
```

Canonical field order: `key, label, type, default, min, max, step, maxLength,
values, bounds` (only present fields are emitted). Declaration key order is
`properties`; the array preserves declaration order, which is the canonical
order of `values` maps everywhere (a value map always contains **every** declared
key, in declaration order).

| Type | Value constraint | Absent/`null` default | Failure codes |
|---|---|---|---|
| `number` | finite; `min ≤ v ≤ max` when given; JSON number | no | `property_type`, `property_value` |
| `boolean` | exactly `true`/`false` | no | `property_type` |
| `string` | string; `length ≤ maxLength` (code points); no control chars; the empty string is allowed | no | `property_type`, `property_value` |
| `enum` | string, exactly one member of `values` | no | `property_type`, `property_value` |
| `vec3` | array of exactly 3 finite numbers; component-wise within `bounds` when given | no | `property_type`, `property_value` |
| `entityRef` | entity ID (project-model §5.1) present in the same scene, or `null` | yes (`null`) | `property_type`, `reference_missing` |
| `assetRef` | `assetId` present in `content.assets`, or `null` | yes (`null`) | `property_type`, `asset_reference_missing` |

Normative notes:

- `entityRef`/`assetRef` are **whole-reference** values (like
  `components.model.asset.assetId`): no sub-entity, submesh, material-slot or clip
  references exist anywhere in M2 (`assets.md` §3.3).
- Enum membership and lengths are validated as data; no value is ever `eval`'d or
  used to look up code.
- A `number` with a `step` is still validated by `min`/`max` only; `step` is a UI
  hint and never a rounding rule on the stored value.
- Inside a **prefab definition**, an `entityRef` value must name a `localId` of
  that definition or be `null` (`prefabs.md` §3); in a scene it must name an
  existing scene entity.
- Values are stored in canonical form with defaults filled: a persisted
  `components.behavior.values` always contains all declared keys.

### 20.6 `components.behavior` and where schemas/values live


1. **Schemas** live in `content.behaviors[i].declaration.properties`
   (this contract's record part; the rest of the behavior record is packet 18's).
2. **Values** live in the scene component `components.behavior`:

```ts
interface BehaviorComponent {
  behaviorId: string;                     // must resolve in content.behaviors
  values: Record<string, PropertyValue>;  // every declared key, declaration order
}
```

Canonical key order: `behaviorId`, `values`; `values` in declaration order;
`components` in registry order (`transform, model, box, camera, behavior,
prefab`).

3. **Prefab-definition entities** may carry `components.behavior`; their recorded
   `values` are the materialization source for instantiation
   (`prefabs.md` §7.3).
4. `components.behavior` is validated on every load: an unresolvable
   `behaviorId` is `behavior_reference_missing`; an undeclared key is
   `property_unknown`; a type/value failure is `property_type`/`property_value`.
   A document is **invalid**, not silently repaired: unknown keys are never
   dropped.
5. **One mutation path per component.** `transform` is owned by the accepted
   `setTransform`; `behavior` by `setBehaviorProperties`; `prefab` is written only
   by `instantiatePrefab` and is read-only afterwards; `box`, `camera` and `model`
   by `setComponent`. No operation accepts a component it does not own
   (`field_value`).

### 20.7 Property/declaration limits


Exact proposals; pinned at Gate E.

| Class | Bound | Value | Failure |
|---|---|---|---|
| request | canonical request JSON bytes (all packet-16 ops, `prefabs.md` §5) | ≤ 65 536 | `limits_exceeded` (`request_bytes`) |
| behaviors | `content.behaviors` length | ≤ 64 | `limits_exceeded` (`behaviors`) |
| declaration | properties per declaration | ≤ 32 | `limits_exceeded` (`properties`) |
| declaration | enum members | ≤ 32 | `limits_exceeded` (`enum_values`) |
| declaration | string `maxLength` | ≤ 1024 | `number_out_of_range` |
| declaration | `label` / `key` / enum member length | ≤ 64 | `property_value` |
| declaration | canonical declaration bytes | ≤ 32 768 | `limits_exceeded` (`declaration_bytes`) |
| values | keys per `components.behavior.values` | = declared count | `property_unknown` / `property_value` |
| settings | keys in `content.settings` | ≤ 32 | `limits_exceeded` (`settings_keys`) |
| settings | key length / syntax | ≤ 64, `^[a-z][a-z0-9_]{0,63}$` | `setting_unknown` / `field_value` |
| query | `limit` for `queryAssets`/`queryBehaviors` | 1–128 (default 50) | `field_value` |
| query | `queryAssets` versions included per record | ≤ 32 (accepted per-asset cap) | — |

### 20.8 Behavior record (declaration part) and declaration compatibility

#### 20.8.1 Declaration modes

```json
{
  "op": "publishBehavior",
  "projectId": "demo-0003",
  "expectedRevision": 2,
  "requestId": "req-60100000000000000000000000000000",
  "origin": { "kind": "browser", "clientId": "browser-demo" },
  "args": {
    "behaviorId": "behavior-0001",
    "displayName": "Lantern Glow",
    "mode": "declaration-create",
    "declaration": { "properties": [ /* DeclaredProperty[] */ ] }
  }
}
```

| Field | Type / constraint | Required |
|---|---|---|
| `behaviorId` | ID syntax; unique for `declaration-create`; must exist for `declaration-update` and `source` | yes |
| `displayName` | 1–128 chars, no control chars | yes |
| `mode` | `"declaration-create"` \| `"declaration-update"` \| `"source"` | yes |
| `declaration` | `{ properties: DeclaredProperty[] }`, 1–32 properties | yes |
| `source` | `{ sourceDigest, sourceByteLength }` — only with `mode: "source"`; the digest-bound preparation record is packet 33's | only for `source` |

`mode` is explicit: a create never silently upgrades into an update. The record
written for a declaration mode is:

```ts
interface BehaviorRecord {
  behaviorId: string;
  displayName: string;
  declaration: { properties: DeclaredProperty[] };
  source: null;         // M2: only null is writable (see §22.6)
  publishedRevision: number; // == the resulting revision of the publishing command
}
```

Canonical key order: `behaviorId, displayName, declaration, source,
publishedRevision`; `content.behaviors` in ascending `behaviorId` codepoint
order. Packet 18 extends this record (source/build fields); it must not change
the declaration part or its canonical order without a reviewed change.



#### 20.8.2 Stable keys

`key` is the stable identifier for a property value; `label` is display-only and
renameable without affecting values. Renaming a `key` is a **removal + addition**
and is therefore governed by §6.4 (it cannot silently drop stored values).

#### 20.8.3 Defaults

A default is part of the schema and is materialized when a value map is created
(`setBehaviorProperties` and instantiation). Changing a default affects **new**
values only; existing stored values are untouched (canonical form stores values,
not "unset" markers).

#### 20.8.4 Unknown overrides are never dropped

Every entry point — `setBehaviorProperties`, instantiation overrides, load
validation and `publishBehavior` updates — fails on an undeclared key
(`property_unknown`) rather than discarding it. There is no "ignore extra keys"
mode in M2.

#### 20.8.5 Compatibility rules

`declaration-update` is accepted only if **all** of the following hold for every
existing use (scene components and prefab-definition components that reference
this `behaviorId`):

1. Every stored key remains declared with the same `type`.
2. Every stored value still satisfies its constraints (range, length, enum
   membership, reference resolution).
3. A changed `entityRef`/`assetRef` default may not be applied to a stored value
   (stored values win); changing a default is compatible because it only affects
   new values.
4. Removing a declared key is compatible **only if no stored value uses it**; the
   failure carries the offending `(entityId|localId, key)` pairs.
5. `properties: []` (an empty declaration) is invalid for both modes: a behavior
   with no declared properties executes nothing meaningful and would make every
   stored value unknown.

This is what makes "definition/source compatibility changes cannot silently erase
user data" observable: the update either validates every use or fails with the
list of uses it would have broken.

### 20.9 Settings container, value vocabulary and key registry


Bounded typed project settings live in `content.settings`:

```ts
type SettingsValue = number | boolean | string;
interface SettingsMap { [key: string]: SettingsValue }  // ≤ 32 keys, key ^[a-z][a-z0-9_]{0,63}$
```

Request: `{ settings: SettingsMap }` — a partial map applied field-wise (a present
key replaces its value; absent keys are unchanged; there is no removal in M2, and
an empty object ⇒ `no_change`/`field_value` as configured below: an empty
`settings` object is `field_value`).

**The key registry is fixed by packet 17 (six keys).** `M2_SETTINGS_KEYS` is
exactly the table below; every other key is `setting_unknown`.

| Key | Type | Default | Range | Unit |
|---|---|---|---|---|
| `gravity_y` | number | `-19.62` | `[-100, -1]` | m/s² |
| `run_speed` | number | `4` | `(0, 50]` | m/s |
| `jump_velocity` | number | `7` | `[0, 50]` | m/s |
| `max_fall_speed` | number | `-30` | `[-100, 0)` | m/s |
| `max_slope_climb_deg` | number | `45` | `[0, 89.9]` | degrees |
| `min_slope_slide_deg` | number | `30` | `[0, 89.9]` | degrees |

A value of the wrong type or outside its range is `field_value` with the key's
path; `min_slope_slide_deg > max_slope_climb_deg` is `field_value`
(`path: /settings/min_slope_slide_deg`). The registry is a fixed M2 table: adding
a key is a reviewed contract change, and capsule dimensions, skin, snap, autostep
and jump windows are contract constants, not settings (`project-model`
§21.4/§21.6).

Change data: `{ type: 'setSettings', previous: SettingsMap, next: SettingsMap,
changedKeys: string[] }` (both are full maps; `changedKeys` in ascending key
codepoint order). Inverse:
`{ kind: 'setSettings', restore: previous }`. No-change compares the full
`content.settings` value.

### 20.10 Deletion/reference rule for entity references


Entity-reference property values are the first cross-entity references beyond
parent links, so deletion needs an explicit rule (the accepted contract defers it:
project-model §11.3 "future cross-referencing components must define their own
deletion policy").

1. **Subtree deletion** (`deleteEntity`) computes the closure as accepted, then
   checks every `entityRef` property value in the scene (and inside
   prefab-definition behavior values, which are local and cannot leak):
   - a value that names an entity **inside** the closure is fine (both disappear);
   - a value that names an entity **outside** the closure blocks the whole
     deletion with `reference_in_use`, carrying
     `{ entityIds: <closure ids>, referencingEntityIds: [<entity ids>] }`.
2. The result document therefore never contains a dangling `entityRef`
   (`reference_missing` would be a load failure) — the invariant is maintained by
   rejection, not by silent clearing.
3. Removing a behavior component (`setBehaviorProperties` with `behaviorId: null`)
   removes its values, so it also removes any references it held; that is an
   ordinary edit and needs no special deletion rule.
4. `assetRef` values are unaffected by entity deletion; M2 has no asset deletion.
5. `components.prefab` references follow `prefabs.md` §8 (no deletion in M2).
6. **v3 game references** are the first content→scene references, so
   `deleteEntity` and component removal consult the game block and reject with
   `game_reference_in_use` exactly as [`../model.md`](../model.md) §23.6
   specifies. Values inside the closure disappear with it; the whole deletion is
   rejected otherwise. No reference is ever silently cleared.


## 21. Physics-bearing components and the M2 gameplay settings registry (scene schemaVersion 2)

### 21.1 The two components and the controller-count rule


Shapes (proposed `schemaVersion` 2 components; exact validation in
`diffs/project-model.md` §"Packet 17 additions", new §21):

```ts
type ColliderShape =
  | { type: 'box'; hx: number; hy: number }                  // 0 < v ≤ 1e6
  | { type: 'polygon'; vertices: [number, number][] };       // 3–8 strict-convex vertices, |v| ≤ 1e6

interface ColliderComponent { shape: ColliderShape }
interface ControllerComponent { }                            // marker; no fields in M2
```

Canonical component key order: `transform`, `model`, `box`, `camera`,
`behavior`, `prefab`, `collider`, `controller` (the two packet-17 components are
appended last; packet 20 owns the final v2 registry order — `diffs/project-model.md`).

An entity is **physics-bearing** iff it carries `collider` or `controller`.
At most one entity in the scene carries `controller` (a second one is
`controller_count_invalid`); the **runtime** requires exactly one, so a
document with zero controllers is valid model data but fails runtime
instantiation as invalid configuration (`config_invalid`,
`reason: "controller_target"`). A scene with more than one controller never
reaches module validation: it fails snapshot validation first as
`snapshot_invalid` (`reason: "scene_validation"`, first project-model error
`controller_count_invalid`). 0–256 entities may carry `collider`
(`limits_exceeded` limit `colliders`).
### 21.2 Physics-transform rules (`parented` / `scale` / `rotation` / `upright`)

physics-bearing entity must be:

1. a **root** — `parentId` absent or `null`; a parented collider is
   `physics_transform_unsupported` (`reason: "parented"`), because the solver
   re-syncs a parented collider toward its body and the character loop is only
   defined for the parentless pattern (§6). A parent *group* may exist in the
   scene; the physics-bearing entity simply cannot be inside it;
2. at **unit scale** — `scale === [1, 1, 1]` exactly; any other scale is
   `physics_transform_unsupported` (`reason: "scale"`). M2 does not shrink or
   stretch colliders by an authored scale factor: the geometry is authored in
   meters in the collider shape itself. Flattening a non-unit scale into the
   shape would silently change collision meaning and is forbidden;
3. **rotated about Z only** — quaternion `[x, y, z, w]` with `|x| ≤ 1e-6` and
   `|y| ≤ 1e-6` (the project-model near-unit tolerance applies to `z, w`);
   anything else is `physics_transform_unsupported` (`reason: "rotation"`). The
   character must in addition be upright in the sense of §3: **any** authored
   rotation on the `controller` entity other than the identity quaternion is
   `physics_transform_unsupported` (`reason: "upright"`) — the capsule is never
   tilted in M2.
### 21.3 Collider shape vocabulary, polygon constraints, limits and validation order

or `model` (a GLB visual with an authored collider); `controller` may coexist
with `box`/`model`. `collider` and `controller` on one entity is
`component_conflict`. Polygon validation: vertices in counter-clockwise order,
finite, no duplicate adjacent vertices, convex within `1e-9` (collinear triples
allowed), area ≥ `1e-6` m², bounding half-extent ≤ `64` m; a violation is
`collider_shape_invalid`. M2 caps: 8 vertices per polygon and 1024 polygon
vertices per scene (`limits_exceeded` limits `collider_vertices`,
`collider_vertices_total`).
### 21.4 The gameplay settings key registry (six keys, types, defaults, ranges, cross-check)


`content.settings` (packet 16's container, values `number | boolean | string`)
is bounded to exactly these keys in M2. The registry is the packet-17 diff that
supersedes packet 16's "empty until packet 17" placeholder
(`diffs/project-model.md` §"Packet 17 additions", P17-A6).

| Key | Type | Default | Range | Unit |
|---|---|---|---|---|
| `gravity_y` | number | `-19.62` | `[-100, -1]` | m/s² |
| `run_speed` | number | `4` | `(0, 50]` | m/s |
| `jump_velocity` | number | `7` | `[0, 50]` | m/s |
| `max_fall_speed` | number | `-30` | `[-100, 0)` | m/s |
| `max_slope_climb_deg` | number | `45` | `[0, 89.9]` | degrees |
| `min_slope_slide_deg` | number | `30` | `[0, 89.9]` | degrees |

### 21.5 Settings resolution (`defaults ⊕ content.settings`, deep-frozen)

Rules:

- Resolution at `instantiateRuntime`: `settings = defaults ⊕ content.settings`
  (a present key wins); the resolved object is deep-frozen and becomes
  `StepContext.settings`. An unlisted key is `setting_unknown` (packet 16);
  a value outside its range or of the wrong type is `field_value` with the key's
  path (same code as packet 16's container rule);
  `min_slope_slide_deg > max_slope_climb_deg` is `field_value`
  (`path: /settings/min_slope_slide_deg`).
- The registry is a **fixed M2 table**: adding a key is a reviewed contract
  change (packet 16 §14) and no key exists for anything outside physics/movement
  tuning. Capsule dimensions, skin, snap, autostep, jump windows, acceleration
  and deceleration are **contract constants, not settings** — changing them
  changes replay semantics and the frozen-course evidence.
- The registry is exported as `M2_SETTINGS_KEYS` (packet 16's placeholder
  becomes the six keys above) and resolved by
  `resolveGameplaySettings(content) → ModelResult<GameplaySettings>`.
### 21.6 Capsule/skin/snap/window constants are contract constants, not settings


| Rule | Value | Exact observable |
|---|---|---|
| coyote window | `COYOTE_STEPS = 6` | a jump may start at any of the **7 executed steps** after the last step `m` whose result was grounded (`m+1 .. m+7`); `COYOTE_STEPS = 6` is the counter's step budget and the refresh step `m+1` is itself permitted because the jump check precedes the decrement, so `m+8` cannot jump (C32-3) |
| jump buffer window | `JUMP_BUFFER_STEPS = 8` | a `pressed` at step `k` permits a jump at steps `k .. k+7`; a new press refreshes it |
| variable height | `JUMP_RELEASE_FACTOR = 0.5` | `released` while airborne and `vy > 0` halves `vy` once; a further `released`/`none` does nothing |
| single jump | — | a jump start requires `groundedPrev || coyote > 0` **and** `!airborne`; `coyote` is zeroed at the start, so a second press while airborne cannot jump (no air jump, no wall jump, no double jump) |
| buffered jump | — | a jump start consumes the buffer (`buffer = 0`), so one press starts at most one jump |
| head contact | — | the controller does not add upward movement while `contacts.head` is reported and clamps `vy` to ≤ 0 (step E); no ceiling hover |
| stair climbing | — | autostep is disabled (physics.md §6) and the controller never raises the character outside the port result; a `≤ 0.4 m` step is blocked while walking (fixtures `traces.json` `ledge-block-and-jump-on`) |
| slope slide | `min_slope_slide_deg` | with `moveX === 0` and the character grounded, the controller slides downhill at `run_speed` when the previous support normal is at/below `cos(min_slope_slide)` **or** a bounded descending ground-contact correction has slope ≥ `tan(min_slope_slide)` (ratio guard) — `platformer.md` §7.4 (C32-1); the adapter itself produces no autonomous slide (C31-4) |
| wall contact | — | the controller keeps its horizontal intent; the port clamps the applied delta; there is no wall slide, wall stick or wall jump |


- The registry is a **fixed M2 table**: adding a key is a reviewed contract
  change (packet 16 §14) and no key exists for anything outside physics/movement
  tuning. Capsule dimensions, skin, snap, autostep, jump windows, acceleration
  and deceleration are **contract constants, not settings** — changing them
  changes replay semantics and the frozen-course evidence.

## 22. Behavior source records, trust acknowledgment and the compilation/publication boundary (storageVersion 2)

### 22.1 The canonical source-graph container (`thirdlight-behavior-source` v1)


The harness's declared source graph is captured as **one canonical JSON
container**, so it fits packet 15's single-file staging model
(`.thirdlight/staging/<stageId>/source.bin`, `content-storage.md` §5.1) with no
new staging mechanism:

```json
{
  "graphVersion": 1,
  "entryPath": "src/index.ts",
  "requiredModules": ["@thirdlight/runtime"],
  "ownedTransforms": [],
  "files": [
    { "path": "src/index.ts", "text": "import type { BehaviorStepContext } from '@thirdlight/runtime';\n\nexport default {\n  prepare() {\n    return { t: 0 };\n  },\n  step(state, ctx) {\n    state.t += 1;\n    ctx.emit({ kind: 'control_move', value: ctx.properties.speed / 10 });\n  },\n  dispose() {}\n};\n" }
  ]
}
```

Canonical key order: `graphVersion, entryPath, requiredModules, ownedTransforms,
files`; each file entry is `path, text`; `files` is emitted in ascending `path`
codepoint order; `requiredModules` and `ownedTransforms` ascending and unique. The **container bytes are the declaration
of the source graph**: the digest covers file paths and file contents, so a rename
or a whitespace change is a different publication.

Rules:

1. `graphVersion` is exactly `1` (`behavior_source_invalid`, `reason:
   "graph_version"` otherwise). No forward compatibility: an unknown version is a
   bounded rejection, never a partial parse.
2. `path` matches `^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$`, length
   1..128, and must be in ascending order (`reason: "path"` / `"file_order"`).
   `..` segments, a leading `/`, a backslash, an empty segment and a trailing
   slash are therefore unrepresentable in a *stored* path; an **import
   specifier** that resolves outside the graph root is still possible and is a
   specified failure (`reason: "escape"`, §4.2).
3. `text` is a JSON string; the compiler receives the exact UTF-8 bytes of each
   file. A `text` containing invalid UTF-16 (an unpaired surrogate) is
   `behavior_source_invalid` (`reason: "encoding"`).
4. The entry file must exist in `files` (`reason: "entry_missing"`).
5. Duplicate `path` values are `behavior_source_duplicate`.
6. `ownedTransforms` is the behavior's declared entity ownership (§9.6):
   ascending, unique, ≤ 16 entries, each ID syntax (project-model §5.1). It is
   part of the **digest-bound declaration** — changing ownership is a new
   publication, never a runtime option.
7. The container is data. It is parsed with the accepted strict parser (unknown
   fields are invalid, never stripped) and **never evaluated**.

---

### 22.2 `BehaviorSourceRecord`


`BehaviorRecord` keeps packet 16's exact shape and canonical key order
`behaviorId, displayName, declaration, source, publishedRevision`. Only the
`source` value changes from "always `null` in M2" to "`null` or a prepared
source record"; the declaration part and its order are untouched.

```ts
type BehaviorSource = BehaviorSourceRecord | null;

interface BehaviorSourceRecord {
  sourceDigest: string;      // 64 lowercase hex: sha256 of the canonical container bytes
  sourceByteLength: number;  // integer 1..262144 (the container bytes length)
  entryPath: string;         // exactly "src/index.ts"
  fileCount: number;         // integer 1..16: must equal the container's files.length
  manifestDigest: string;    // 64 lowercase hex: sha256 of the canonical BehaviorManifest bytes
  outputDigest: string;      // 64 lowercase hex: sha256 of the prepared output bytes
  outputByteLength: number;  // integer 1..131072
  requiredModules: string[]; // ascending, unique, subset of the pinned module set (§5.3)
  publishedRevision: number; // == the resulting revision of the publishing command
}
```

Canonical key order: `sourceDigest, sourceByteLength, entryPath, fileCount,
manifestDigest, outputDigest, outputByteLength, requiredModules,
publishedRevision`. `content.behaviors` stays in ascending `behaviorId` codepoint
order (`properties.md` §5.1).

Normative rules:

1. **`source: null` executes nothing.** A declaration-only behavior is a
   validated, fully representable, editable behavior that links no code and
   contributes no runtime module (§9.1). This is the only state M2 can *write*
   (§8.3) and the only state any M2 document may hold before packet 33.
2. **A non-null `source` is written only by the preparation path** (§8.4). Every
   field of a `BehaviorSourceRecord` is derived from durable bytes by the
   preparer; **no caller-supplied `source` field is ever copied into a record**.
3. **Digest binding.** `sourceDigest` is the SHA-256 of the exact canonical
   container bytes (§4.1). `manifestDigest` is the SHA-256 of the canonical
   `BehaviorManifest` bytes, and the manifest itself carries `sourceDigest`, so
   manifest and container bind each other. `outputDigest`/`outputByteLength`
   address the prepared output bytes stored as a **derived cache**
   (`content-storage.md` §2/§8.3) — regenerable from the container, never
   authoritative, never required for a document to load.
4. **Validation on load** (`diffs/project-model.md` P18-A4): digest syntax
   (`digest_invalid`), `fileCount` 1..16, `entryPath` fixed, `outputByteLength`
   ≤ 131072, `requiredModules` ascending/unique/subset-of-the-recorded-pins,
   `publishedRevision ≥ 1` for a record written by this preparation path —
   `≥ 0` for a record written by the `workspace.md` §16.5.2 copy, which resets it
   to `0` — and `sourceByteLength` equal to the container's real
   length **when the container bytes are available to the check**. Byte
   availability is a workspace concern (`content-storage.md` §8.1); the document
   check validates shape and the internal digest/manifest consistency the
   document itself asserts, never a claimed hash of bytes it cannot read.
5. **A behavior with `source: null` may not carry a stale non-null output
   reference** (there is no field for one) and a `source`-bearing behavior may
   not omit `outputDigest` (`field_missing`).

### 22.3 Static source rules and the exhaustive failure taxonomy


All rules in this section are enforced by the **compiler** on the supplied bytes
(§5) and, for the load-time subset, by `project-model` on a stored record. They
are static: no source is executed to decide them.

#### 22.3.1 Language and imports

1. The graph is TypeScript/TSX-free TypeScript (`esbuild`'s `ts` loader). `.ts`
   only: a `path` not ending in `.ts` is `behavior_source_invalid` (`reason:
   "extension"`). No `.tsx`, no JSX (no UI dependency — §9.7), no `.js`.
2. **Only relative imports inside the graph.** A value import specifier must
   start with `./` or `../` and resolve (POSIX normalization, then `.ts` added
   when omitted) to a path in `files`.
3. **Type-only imports** (`import type …`, `export type …`) may additionally name
   a module ID from `requiredModules`; they are erased by the compiler and must
   contribute **no bytes** to the output (verified by the §5.5 output scan
   containing no engine specifier). A value import of an engine module ID is
   `behavior_import_forbidden` (`reason: "engine_value_import"`): the behavior
   API arrives as the injected `ctx` object, not as an import.
4. `requiredModules` entries must be present in the compile input's pinned
   module set (§5.3) (`behavior_import_unpinned`).
5. No other specifier form exists in M2. `node:*`, bare npm ids, absolute paths,
   `http:`/`https:`/`data:`/`file:`/`blob:` URLs and `#`-imports are all
   `behavior_import_forbidden` with `reason` `node_builtin` / `bare` / `absolute`
   / `network`.

#### 22.3.2 Failure taxonomy (exhaustive for M2)

| Condition | Code | `reason` / `limit` |
|---|---|---|
| container not canonical/parseable, unknown field, bad `graphVersion`, bad path, bad extension, bad encoding | `behavior_source_invalid` | `graph_version` / `container` / `path` / `file_order` / `extension` / `encoding` / `syntax` |
| entry file absent | `behavior_source_invalid` | `entry_missing` |
| duplicate `path` | `behavior_source_duplicate` | — |
| relative import whose target is not in `files` | `behavior_source_missing` | the resolved path |
| relative import resolving above the graph root (leading `..`) | `behavior_source_escape` | the resolved path |
| import cycle | `behavior_source_cycle` | the cycle path list |
| bare / Node built-in / absolute / URL import | `behavior_import_forbidden` | `bare` / `node_builtin` / `absolute` / `network` |
| value import of a pinned engine module | `behavior_import_forbidden` | `engine_value_import` |
| `requiredModules` entry not in the pinned set | `behavior_import_unpinned` | the module ID |
| `import(…)`, `eval(…)`, `new Function(…)`, `Function(…)`, `require(` | `behavior_dynamic_code` | `dynamic_import` / `eval` / `function_constructor` / `require` |
| any bound of §6 exceeded | `behavior_source_limits_exceeded` | `files` / `file_bytes` / `graph_bytes` / `import_depth` / `imports` / `owned_transforms` |
| compile wall-clock bound exceeded | `behavior_compile_timeout` | — |
| compiler internal failure (pinned tool throws) | `behavior_compile_failed` | the bounded message |
| output bound exceeded | `behavior_output_limits_exceeded` | `output_bytes` |
| output bytes contain a forbidden pattern (§5.5) | `behavior_output_forbidden_content` | the pattern letter |
| stored `source` digest/manifest/pins inconsistent with `declaration` | `behavior_declaration_mismatch` | `digest` / `manifest` / `declaration` / `pins` |
| trust not acknowledged for the exact digest | `behavior_trust_unacknowledged` | `digest` |
| published source not available for play/export (no prepared artifact, or its bytes are gone) | `behavior_publication_unavailable` | `preparation_missing` / `preparer_unavailable` (packet 16 code, extended reasons) |
| a later full-snapshot bundle build fails (packet 33/36) | `behavior_build_failed` | `link` / `toolchain` / `artifact_missing`; a play/export-layer `unavailable` code, never a document error |

Detection is **static and textual-then-structural**: the scanner is a bounded
tokenizer over the file text (import/export declarations, `import(`/`eval(`/
`new Function`/`require(` occurrences), and the *set* of detected specifiers is
what decides the rule. A specifier assembled from string concatenation at runtime
is **not** detected — §2.2's honest limitation.

#### 22.3.3 Validation order (normative, exhaustive)

The order below is the order a preparation/compile reports failures in: the
**first** violation found wins, and exactly one `code` (+ `reason`) is the
outcome. Fixtures and the compiler must agree on this order.

| # | Step | Failure |
|---|---|---|
| 1 | strict parse of the container bytes; unknown fields; canonical parse | `behavior_source_invalid` (`container`) |
| 2 | `graphVersion === 1` | `behavior_source_invalid` (`graph_version`) |
| 3 | `entryPath` present and matching `files` | `behavior_source_invalid` (`entry_missing`) |
| 4 | per-path grammar and `.ts` extension | `behavior_source_invalid` (`path` / `extension`) |
| 5 | `files` ascending by `path`; `requiredModules`/`ownedTransforms` ascending and unique | `behavior_source_invalid` (`file_order`) |
| 6 | duplicate `path` | `behavior_source_duplicate` |
| 7 | bounds: `files`, `file_bytes`, `graph_bytes`, `owned_transforms` | `behavior_source_limits_exceeded` (`files` / `file_bytes` / `graph_bytes` / `owned_transforms`) |
| 8 | `requiredModules ⊆ pinnedModules` | `behavior_import_unpinned` |
| 9 | import scan, **file order then text position**, one ordered classification pass per construct: dynamic forms ⇒ `behavior_dynamic_code`; `node:`/bare/absolute/URL specifiers ⇒ `behavior_import_forbidden` (`node_builtin` / `bare` / `absolute` / `network`); a value import of a pinned engine id ⇒ `behavior_import_forbidden` (`engine_value_import`); a type-only import of a pinned engine id is accepted and erased; import count per file | `behavior_dynamic_code` / `behavior_import_forbidden` / `behavior_source_limits_exceeded` (`imports`) |
| 10 | relative resolution against `files` | `behavior_source_missing` / `behavior_source_escape` |
| 11 | cycle detection over the resolved relative graph | `behavior_source_cycle` |
| 12 | import depth (longest chain from the entry) | `behavior_source_limits_exceeded` (`import_depth`) |
| 13 | parse/transform by the pinned compiler | `behavior_source_invalid` (`syntax`) / `behavior_compile_timeout` / `behavior_compile_failed` |
| 14 | output bytes bound | `behavior_output_limits_exceeded` (`output_bytes`) |
| 15 | output content scan (§5.5) | `behavior_output_forbidden_content` |

Steps 1–7 are the **load-time subset** a stored record can also be checked
against (without bytes); steps 8–15 are compile-time. A failure at any step
produces **no** output bytes, **no** prepared artifact and **no** state change
(§8.4).

---

### 22.4 Compiler resource bounds and the derived-cache class of prepared outputs


These bounds protect the **server process** that runs the preparer; they are
distinct from runtime trust (§2) and from the runtime caps (§10).

| Bound | Value | Failure (`limit`) |
|---|---|---|
| files per source graph | 16 | `behavior_source_limits_exceeded` (`files`) |
| bytes per file (`text` UTF-8) | 65 536 | `behavior_source_limits_exceeded` (`file_bytes`) |
| `ownedTransforms` entries | 16 | `behavior_source_limits_exceeded` (`owned_transforms`) |
| total container bytes (`sourceByteLength`) | 262 144 | `behavior_source_limits_exceeded` (`graph_bytes`) |
| import depth (longest relative chain from the entry) | 8 | `behavior_source_limits_exceeded` (`import_depth`) |
| import declarations per file | 16 | `behavior_source_limits_exceeded` (`imports`) |
| diagnostics per compile | 32 | excess diagnostics are dropped; `truncated: true` is recorded once |
| compile wall-clock | 2 000 ms | `behavior_compile_timeout` |
| output bytes | 131 072 | `behavior_output_limits_exceeded` (`output_bytes`) |
| properties per declaration | 32 | `limits_exceeded` (`properties`) — enforced by `properties.md` §4, re-checked here |
| declaration canonical bytes | 32 768 | `limits_exceeded` (`declaration_bytes`) — `properties.md` §4 |

Rules: the byte/limit checks run **before** parsing the file text they bound
(a 1 MiB file is rejected as `graph_bytes`/`file_bytes`, never parsed); the
timeout is measured inside the preparer around the pinned esbuild call and is a
**cooperative** bound (esbuild's synchronous transform cannot be preempted mid-
call — the preparer must therefore run the compile in a bounded way that it can
abandon, and a timeout is reported as a failed preparation, never as a partial
artifact). The timeout number is a proposal for the container host and is
re-measured at packet 33; it is not evidence of any measurement here.

> **C33-1 (accepted with diff, Gate I).** `compileBehavior` is
> **asynchronous**: the implementation signature is
> `(input: BehaviorCompileInput) => Promise<BehaviorCompileResult>` (see
> `planning/m2-contracts/behaviors.md` §5.1). The §6 in-memory resolver is an
> esbuild plugin and esbuild 0.28.2 rejects plugins in the synchronous
> `buildSync` API. The result shape, `COMPILER_ID` and the digest-binding rules
> are unchanged.

---


#### 22.4.1 Preparation (packet 33) — the digest-bound result

When a preparer exists, `prepareBehaviorSource(projectId, stageId, declaration)`
(new workspace **preparation** operation, `content-storage.md` §6.1's
preparation layer — no lock, repeatable, idempotent per digest) must:

1. resolve the stage (refusal checks, caps, traversal/symlink refusal);
2. read the bytes, compute `sourceDigest`/`sourceByteLength` from **the bytes on
   disk**;
3. check `behavior_trust_unacknowledged` (`reason: "digest"`) — the digest is
   only knowable after reading the bytes, so this refusal is **after hashing and
   before compiling/writing** (the enforceable order; **C33-5** accepted with
   diff, Gate I, reconciling `workspace.md` §13.3.1's "before staging
   resolution" wording). A preparation for an unacknowledged digest is refused
   (no bytes, no artifact), so the acknowledgment always precedes the first
   compile;
4. parse the container, apply §4's static rules, enforce §6's bounds, and call
   `compileBehavior` with the durable bytes, the declaration and the pinned module
   set;
5. on failure: write **nothing** authoritative, produce a bounded diagnostic
   result (`ok: false`, ≤ 32 diagnostics), and stop;
6. on success: publish the container bytes as an immutable blob
   (`sources/sha256/<sourceDigest>`, `content-storage.md` §4, write-once) and the
   output bytes as a **derived cache** entry keyed by `outputDigest`; return
   `{ sourceDigest, sourceByteLength, manifestDigest, outputDigest,
   outputByteLength, fileCount, requiredModules }`.

The preparation-time compile is the **asynchronous** `compileBehavior` of §22.4
(**C33-1** accepted with diff, Gate I): esbuild 0.28.2 supports the mandated
in-memory resolver plugin only in the async `build` API, so the preparer
`await`s it. The preparation layer is lock-free and repeatable, so awaiting is
safe; the pure result shape is unchanged.

The **published record is then built from the preparation result alone**:
`publishBehavior{mode: "source"}` args carry only
`{ sourceDigest, sourceByteLength }` (packet 16's shape); the command verifies
that a prepared artifact for that digest exists and that its recomputed values
match, and writes the `BehaviorSourceRecord` derived from it. A stale or absent
preparation is `behavior_publication_unavailable` (`reason:
"preparation_missing"`); a manifest/declaration mismatch is
`behavior_declaration_mismatch`. The command never recompiles (a mutation must
not hold the lock across CPU/IO work, `content-storage.md` §6.3).

### 22.5 `content.behaviorTrust` and its canonical form


```ts
interface BehaviorTrust {
  entries: { sourceDigest: string; acknowledgedRevision: number }[]; // ≤ 64, ascending sourceDigest
}
```

Canonical position in `content`: `assets, prefabs, behaviors, settings,
behaviorTrust` (packet 15's content key order, extended by one key). Canonical key
order: `entries`; per entry `sourceDigest, acknowledgedRevision`. A v2 envelope
that omits `behaviorTrust` is invalid (`field_missing`) — like the other empty
containers (`migration-minimal-v2.json` gains `"behaviorTrust": { "entries": [] }`
in the same promotion step, a recorded change request).

`acknowledgeBehaviorTrust` (proposed, `diffs/commands.md` change request C18-2):

```json
{ "op": "acknowledgeBehaviorTrust", "projectId": "demo-0003",
  "expectedRevision": 4, "requestId": "req-60300000000000000000000000000000",
  "origin": { "kind": "browser", "clientId": "browser-demo" },
  "args": { "sourceDigest": "<64 hex>" } }
```

- `sourceDigest` syntax (`digest_invalid`); the entry is appended when absent
  (`acknowledgedRevision = result revision`), and an existing entry is
  `no_change`. Inverse removes the entry; an undo of the first acknowledgment
  removes it, so acknowledgment is revocable by history exactly like any edit.
- Bounds: ≤ 64 entries (`limits_exceeded` `trust_entries`); request bytes ≤ 65 536.
- It is a **mutation**: it advances the revision and is validated, projected,
  retried and undone like every other command. It never blocks a play instance
  already running (a running instance is unchanged by any command, §8.6).

> **C34-4 / C36-4 (accepted with diff, Gate I) — the bounded read.**
> `content.behaviorTrust` is exposed in the full-state payload and by
> `queryProject` as `behaviorTrust: { entries: [{ sourceDigest,
> acknowledgedRevision }] }` (≤ 64 entries, ascending by `sourceDigest`;
> `sessions.md` §19.4). The editor therefore keeps acknowledged digests across
> reloads instead of losing them with the `acknowledgeBehaviorTrust` change
> records. The export path does not depend on that read: the publication-time
> gate above means a source-bearing behavior record cannot exist
> un-acknowledged, so `export.md` §6 records the relied-on
> `behaviorTrust.acknowledgedSourceDigests` structurally.

---

### 22.6 The mandatory publication order and the "unavailable until packet 33" state


Publishing behavior source is **exactly** this order — each arrow is a distinct
layer with its own atomicity:

```
stage source bytes + declaration        (preparation, no lock, repeatable)
  → validate + compile the captured graph  (pure, no lock, repeatable)
  → prepare a digest-bound successful result (derived cache, durable, no lock)
  → command publication through runCommand  (authoritative, mutation lock, +1 revision)
```

Simplified or reordered variants are contract violations: in particular (a)
publishing bytes that were never compiled, (b) resolving a stage *inside* the
command, (c) writing `source` from caller-supplied fields, and (d) holding the
mutation lock while reading staging/compiling (§8.5).



- `publishBehavior{mode: "declaration-create" | "declaration-update"}` works
  exactly as packet 16 specifies (`properties.md` §5). `source` stays `null`.
- **`publishBehavior{mode: "source"}` always fails** with
  `behavior_publication_unavailable`, `cls: "unavailable"`, `reason:
  "preparer_unavailable"`, **before** any stage resolution, digest check or
  validation of the supplied `source` value (`properties.md` §5.2, unchanged).
- There is **no** registered preparer in M2-packet-18..32. The source branch of
  the command **must** be a hard `unavailable` return; an implementation must not
  contain a code path that assigns a `source` field from `request.args.source`,
  and must not accept a `source` object that names a manifest/output the
  workspace did not derive itself. "Unchecked write is impossible" is a
  structural requirement, not a scheduling note.
- No public surface may claim a working source publisher: no route, no MCP tool,
  no UI enablement, no success fixture. `properties.md` §5.2's "a behavior with
  `source: null` executes nothing" remains the honest state, and packet 33's
  preparation path is the only addition that may lift this — under a reviewed
  contract diff plus Gate E/I acceptance.

### 22.7 The two distinct build failures (preparation vs full-snapshot bundle)


Two different failures must never be conflated:

| # | Failure | What happens | What is preserved |
|---|---|---|---|
| A | **Preparation/compile failure** (staging/validate/compile) | the command is refused or never issued; `ok: false` diagnostics ≤ 32; **no** record, **no** revision change | the entire previous publication; the running instance; the last derived build artifact |
| B | **Full snapshot bundle build failure** (packet 33/36: linking N behavior outputs + engine modules into one immutable browser bundle) | the publication **stands** (record, revision, blobs unchanged); the build reports bounded diagnostics; the new revision is not playable/exportable until a build succeeds | **the last successful derived artifact** (the previous immutable bundle + its locator), which stays served/exportable (`m2-plan.md` §3.6: build failure preserves the previous output) |

- A snapshot whose behaviors all have `source: null` needs **no** build: it links
  no behavior code and play/export proceed as today (M1/M2-without-behaviors).
- A snapshot with any `source`-bearing behavior requires the build path
  (packets 33/35/36). Until it exists, such a snapshot is authorable and
  publishable but **not playable/exportable** — the honest unavailable state,
  reported as `behavior_publication_unavailable` (`reason:
  "preparation_missing"`) or the play/export equivalent, never as a silent empty
  behavior.
- **Pinned modules work identically in play and export**: both bundles are
  produced by the same pipeline from the same (snapshot, `sourceDigest`s, engine
  pins, pinned option set) and therefore link the same behavior output digests
  against the same engine build (`export.md` §5.1, `diffs/export.md`).

---


## 23. M3 v3 data: scene schemaVersion 3 / storageVersion 3

### 23.0 Scope, ownership and which document is versioned

This section defines the v3 scene data, the game-configuration block and the
reference/deletion rules. It does **not** define runtime behaviour (packet 40),
media/import fields (packet 41) or the delivery manifest (packet 42).

**Naming rule (plan-review PR-4) — exactly one document moves per field:**

| Document | Version field | v2 value | v3 value | Owner of the v3 value |
|---|---|---|---|---|
| authoring manifest `project.json` (`project-model` §7) | `schemaVersion` | 1 | **1 (unchanged)** | this section; the authoring manifest is **not** the runtime manifest |
| authoring scene `scenes/main.json` embedded value | `schemaVersion` | 2 | **3** | this section |
| workspace envelope `scenes/main.json` top level | `storageVersion` | 2 | **3** | [`workspace.md`](workspace.md) §16 |
| runtime-content export `manifest.json` (`sessions.md` §13, `export.md` §5) | `manifestVersion` | 1 | 2 | **packet 42** — not defined here; referenced only |

A reader must never infer one field from another. `storageVersion` versions the
envelope format, `scene.schemaVersion` versions the scene data,
`manifest.schemaVersion` versions the authoring manifest, and the export
`manifestVersion` versions the runtime-content delivery document.

### 23.1 Version taxonomy additions

`SCHEMA_VERSIONS_BY_DOCUMENT` becomes: manifest `[1]`; scene `[1, 2, 3]`.
Envelope `storageVersion` known set becomes `[1, 2, 3]`
([`workspace.md`](workspace.md) §16). v1 and v2 readers/validators are unchanged and
remain selectable by their version.

### 23.2 Legal version combinations (supersedes nothing; adds one row)

The exhaustive combination table of `project-model` §6 and `workspace` §4.5 gains
exactly one passable row. `manifest 1 + scene 3 + storage 3` is the v3
combination; its envelope carries `content` with the additional required key
`game` ([`workspace.md`](workspace.md) §16).

| `manifest.schemaVersion` | `scene.schemaVersion` | `storageVersion` | Result |
|---|---|---|---|
| 1 | 1 | 1 | **valid** — accepted M1 row, unchanged |
| 1 | 2 | 2 | **valid** — accepted M2 row, unchanged |
| 1 | 3 | 3 | **valid** — **new v3 row** (`content.game` present, `null` or an object) |
| 1 | 1 | 2 | `version_combination_unsupported` (accepted row, unchanged) |
| 1 | 2 | 1 | `scene_invalid` → `schema_version_unsupported` (accepted row, unchanged) |
| 1 | 1 | 3 | `version_combination_unsupported` — single error, checked before any scene/content field validation |
| 1 | 2 | 3 | `version_combination_unsupported` — single error |
| 1 | 3 | 1 | `version_combination_unsupported` — single error |
| 1 | 3 | 2 | `version_combination_unsupported` — single error |
| 2 | any | any | `manifest_invalid` → `schema_version_unsupported` — the authoring manifest stays `schemaVersion` 1 |
| any | any | ≥ 4 or ≤ 0 | `storage_version_unsupported` |
| any | ≥ 4 | any | `schema_version_unsupported` for that document |

Refusal is **non-destructive and non-repairing**: the combination error is a
single error at the envelope's `storageVersion` path, deeper scene/content checks
stop, the bytes are retained byte-identically, and no rewrite, normalization,
upgrade or downgrade occurs at open, on startup scan, or on any query. An
unsupported project is reported as unavailable with that code as the reason
(`workspace.md` §11).

### 23.3 Scene v3 component registry and canonical order

The v3 registry is the v2 registry plus six components, **appended in this
order** (no accepted component is renumbered or reinterpreted):

```text
transform, model, box, camera, behavior, prefab, collider, controller,
gameZone, playerSpawn, cameraFollow, light, surface, modelAnimation
```

`transform` remains required on every entity (`component_missing`). A component
name outside this list is `component_unknown`. Adding a component after v3
requires a new `schemaVersion` (§6/§17 — same-version extensions are forbidden).

Entity combinations added in v3 (all other accepted combinations unchanged):

| Combination | Meaning |
|---|---|
| `{ transform, gameZone }` / `+ box` / `+ model` / `+ surface` | gameplay zone, optionally with a visual marker |
| `{ transform, playerSpawn }` / `+ box` / `+ model` / `+ surface` | spawn marker, optionally with a visual marker |
| `{ transform, camera, cameraFollow }` | the single gameplay camera (the `camera` entity) |
| `{ transform, light }` / `+ box` / `+ model` | light entity |
| `{ transform, box, surface }` / `{ transform, model, surface }` | lit primitive/GLB surface values |
| `{ transform, model, modelAnimation }` | animated model instance |

### 23.3.1 `components.gameZone`

```ts
type GameZoneRole = 'hazard' | 'checkpoint' | 'goal';

interface CheckpointActivationAppearance {
  emissive: string;            // ^#[0-9a-f]{6}$ ; canonical lowercase
  emissiveIntensity: number;   // [0, 4]
  cueAssetId: string | null;   // null = use content.game.cues.checkpoint
}

interface GameZoneComponent {
  role: GameZoneRole;
  size: [number, number];      // [widthX, heightY] full extents, meters
  safeSpawnId?: string;        // REQUIRED iff role === 'checkpoint'
  activation?: CheckpointActivationAppearance; // REQUIRED iff role === 'checkpoint'
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `role` | string | yes | exactly `hazard` \| `checkpoint` \| `goal` | — |
| `size` | array of 2 finite numbers | yes | each `0 < v ≤ 1e6` (full extent, not half-extent) | — |
| `safeSpawnId` | string | iff `role === 'checkpoint'` | ID syntax; must resolve to an entity carrying `playerSpawn` | — |
| `activation` | object | iff `role === 'checkpoint'` | §23.3.1a | — |

Canonical key order: `role`, `size`, `safeSpawnId`, `activation` (present fields
only). `activation` key order: `emissive`, `emissiveIntensity`, `cueAssetId`.
Defaults are **not** filled for `activation` sub-fields: a checkpoint writes all
three fields explicitly (the normalizer never invents a presentation value).

Geometry and transform rules (normative):

- A zone is an **axis-aligned XY rectangle** centred on the entity's world
  position; half-extents are `size / 2`. Z is presentation depth only.
- A zone entity must be a **root** (`parentId` absent/`null`), at **unit scale**
  (`[1,1,1]` exactly) and with the **identity rotation** (`[0,0,0,1]`). A
  violation is `zone_transform_unsupported` carrying `path` and `reason`:
  `parented` / `scale` / `rotation` (§23.9). (Distinct from
  `spawn_transform_unsupported`, which is reserved for `playerSpawn`, and from
  `physics_transform_unsupported`, which stays reserved for
  `collider`/`controller`.)
- A zone never blocks movement and is never a physics body: `gameZone` with
  `collider` or `controller` on one entity is `component_conflict`.
- Zone overlays are authoring-only; nothing in the document marks an overlay as
  a game collider.

Counts: ≤ 64 `gameZone` entities per scene (`limits_exceeded` `zones`); ≤ 1 with
`role === 'checkpoint'` (`zone_checkpoint_count_invalid`); ≥ 1 with
`role === 'goal'` **when `content.game !== null`** (`zone_goal_missing`);
`hazard` count is bounded only by `zones`.

#### 23.3.1a `CheckpointActivationAppearance`

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `emissive` | string | yes | `^#[0-9a-fA-F]{6}$`, canonical lowercase | — |
| `emissiveIntensity` | number | yes | `[0, 4]` | — |
| `cueAssetId` | string or `null` | yes (may be `null`) | when non-null must resolve to an asset with `kind: "audio"` | — |

This is the plan-review PR-1 **activation-appearance slot**
(`m3-plan.md` §2.1): packet 41 owns the read-only presentation view bit the
adapter consumes and may extend or replace the value shape **by diff**; 39 owns
the slot's presence, requiredness, reference rule and canonical order. Session
HUD text alone is explicitly not this value.

### 23.3.2 `components.playerSpawn`

```ts
interface PlayerSpawnComponent { }   // field-less marker
```

- Canonical value: `{}` (exactly, no fields; unknown fields ⇒ `field_unexpected`).
- A spawn entity must be a **root** (`parentId` absent/`null`), at **unit scale**
  (`[1,1,1]` exactly) and with the **identity rotation** (`[0,0,0,1]`). A
  violation is `spawn_transform_unsupported` carrying `path`
  (`/scene/entities/<i>/parentId`, `/scene/entities/<i>/components/transform/scale`
  or `/scene/entities/<i>/components/transform/rotation`) and `reason`:
  `parented` / `scale` / `rotation` (§23.9). The rule mirrors the accepted
  `project-model.md` §21.2 physics-transform rule and the §23.3.1 zone rule
  exactly (same three conditions, same reason vocabulary); it is a **distinct
  code** from `zone_transform_unsupported` so a fixture or diagnostic names the
  bearer unambiguously. There is **no** `upright` reason for a spawn: the
  identity-rotation condition above is the whole tilt rule.
- `playerSpawn` with `gameZone`, `collider` or `controller` is
  `component_conflict`.
- ≤ 16 `playerSpawn` entities per scene (`limits_exceeded` `player_spawns`).
- The **start spawn** is the one named by `content.game.spawnId`; a
  **safe-checkpoint spawn** is one named by a checkpoint's `safeSpawnId`. A
  spawn not named by either is legal, unreferenced authoring data.

### 23.3.3 `components.cameraFollow`

```ts
interface CameraFollowComponent {
  deadZone: { x: number; y: number };                        // half-extents, meters
  smoothing: number;                                         // [0, 1]
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `deadZone` | object | yes | `x`, `y` finite, `0 ≤ v ≤ 1e6` | — |
| `smoothing` | number | yes | `[0, 1]`; `0` = hard snap | — |
| `bounds` | object | yes | finite, `|v| ≤ 1e6`, `minX < maxX`, `minY < maxY`, `maxX − minX ≥ 1e-6`, `maxY − minY ≥ 1e-6` | — |

Canonical key order: `deadZone`, `smoothing`, `bounds`; `deadZone`: `x`, `y`;
`bounds`: `minX`, `maxX`, `minY`, `maxY`.

- `cameraFollow` may appear **only** on the entity that carries `camera`
  (`component_conflict` otherwise — there is no parented or secondary camera in
  v3).
- When `content.game !== null`, the camera entity **must** carry
  `cameraFollow` (`game_reference_missing`, `reason: "camera_follow"`).
- The plan's camera **math** (fixed -Z view, Y up, clamp to frustum, hard snap,
  fixed-step smoothing) is packet 40's; this component stores data only.

### 23.3.4 `components.light`

```ts
interface LightComponent {
  type: 'directional' | 'ambient';
  color: string;                        // ^#[0-9a-f]{6}$
  intensity: number;                    // [0, 8]
  direction?: [number, number, number]; // directional only
  castShadow?: boolean;                 // directional only
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `type` | string | yes | `directional` \| `ambient` | — |
| `color` | string | yes | `^#[0-9a-fA-F]{6}$`, canonical lowercase | — |
| `intensity` | number | yes | `[0, 8]` | — |
| `direction` | array of 3 finite numbers | iff `type === 'directional'` | each `|v| ≤ 1`; `‖v‖ ≥ 1e-6`; **not** renormalized (the adapter normalizes a derived copy, like §10.1 quaternions) | — |
| `castShadow` | boolean | iff `type === 'directional'` (may be `false`) | — | `false` |

Canonical key order: `type`, `color`, `intensity`, `direction`, `castShadow`
(present fields only); `direction` is emitted only for `directional`. Present
`direction`/`castShadow` on an `ambient` light ⇒ `field_value`. A `light` entity
has no transform rule (it may be parented or scaled; only the value matters).

Counts: ≤ 1 `directional` (`limits_exceeded` `lights_directional`) and ≤ 1
`ambient` (`limits_exceeded` `lights_ambient`) per scene. The bounded one
key/fill shadow profile, the three primitive presets' realization and
shadow-degradation behaviour are packet 41/52's; v3 stores ordinary numbers.

### 23.3.5 `components.surface` and the three built-in presets

```ts
interface SurfaceComponent {
  color: string;              // ^#[0-9a-f]{6}$
  roughness: number;          // [0, 1]
  metalness: number;          // [0, 1]
  emissive: string;           // ^#[0-9a-f]{6}$
  emissiveIntensity: number;  // [0, 4]
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `color` | string | yes | `^#[0-9a-fA-F]{6}$`, canonical lowercase | `#b0b0b0` |
| `roughness` | number | yes | `[0, 1]` | `0.9` |
| `metalness` | number | yes | `[0, 1]` | `0` |
| `emissive` | string | yes | `^#[0-9a-fA-F]{6}$`, canonical lowercase | `#000000` |
| `emissiveIntensity` | number | yes | `[0, 4]` | `0` |

Canonical key order: `color`, `roughness`, `metalness`, `emissive`,
`emissiveIntensity`. `surface` may appear only on an entity carrying `box` or
`model` (`component_missing`, `expected: "box|model"`); `surface` + `camera` is
`component_conflict`.

The three built-in presets are **frozen value rows**, not linked resources
(copying a preset writes the five values; editing one copy cannot change another
or the table):

| Preset name | color | roughness | metalness | emissive | emissiveIntensity |
|---|---|---|---|---|---|
| `matte-ground` | `#6f6f6f` | `0.95` | `0` | `#000000` | `0` |
| `hazard` | `#d42a1e` | `0.55` | `0` | `#3a0703` | `0.35` |
| `beacon` | `#2f7fd4` | `0.4` | `0.1` | `#1bc8ff` | `1.2` |

Preset application is the `applySurfacePreset` mutation
([`commands.md`](commands.md)): one edit, one history entry, one
revision, exact inverse. No preset id or asset reference is persisted.

### 23.3.6 `components.modelAnimation`

```ts
interface ModelAnimationComponent {
  assetId: string;    // must resolve in content.assets with kind === 'model'
  version: number;    // 1 ≤ version ≤ that record's currentVersion
  roles: {            // exactly these three keys, each an AnimationRoleBinding
    idle: AnimationRoleBinding;
    run: AnimationRoleBinding;
    airborne: AnimationRoleBinding;
  };
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `assetId` | string | yes | ID syntax; resolves to a `kind: "model"` record | — |
| `version` | integer | yes | `1 ≤ v ≤ currentVersion` of that record | — |
| `roles` | object | yes | exactly the keys `idle`, `run`, `airborne`; each an `AnimationRoleBinding`; canonical bytes ≤ 4096 | — |

Canonical key order: `assetId`, `version`, `roles`; `roles` in the fixed order
`idle`, `run`, `airborne`.

`AnimationRoleBinding` and its media fields are **packet 41's**
(`planning/m3-contracts/presentation.md`, project-model §24 proposal). 39 fixes
only: the role key set, all-three-required, that each binding is a non-empty JSON
object owned by that version, the `assetId`/`version` binding, and that no role
key may be added without a new `schemaVersion`. A binding is validated by
packet 41's rules; 39's load order validates the container first (§23.8).

- `modelAnimation` may appear only on an entity carrying `model`
  (`component_missing`, `expected: "model"`), and its `assetId` must equal that
  entity's `components.model.asset.assetId` (`component_conflict`,
  `reason: "animation_asset"`).
- This is the plan's **narrow exception** to `project-model` §18.1 rule 3
  (no persisted subresources): the binding is version-local and immutable, so a
  reordered reimport cannot create a false persistent reference. Packet 41
  supplies the exact replacement text for §18.1 rule 3; 39 does not.

### 23.3.7 `AssetRecord.kind` gains `audio`

`kind` becomes `"model" | "audio"` (`field_value` for anything else). All other
`AssetRecord`/`AssetVersion` rules (§§18.3/18.4) are unchanged: opaque
`assetId`, append-only `versions`, digest-addressed immutable bytes, no paths.
`kind` is fixed at create; a reimport that supplies a different `kind` for an
existing `assetId` is `asset_kind_mismatch` ([`commands.md`](commands.md)).
The WAV import profile, decoded/PCM bounds and recipe fields for `audio` are
packet 41's; 39 fixes the discriminator, the cue-assignment data (§23.4) and the
limits `audio_assets` ≤ 16 / `audio_versions` ≤ 8 (§23.10). `components.model`
keeps resolving to `kind: "model"` only.

### 23.4 The game-configuration block `content.game`

One bounded block in the same content catalog — **no second mutable document, no
side-car file, no JSON blob**. In a v3 envelope the content key set is exactly
`assets, prefabs, behaviors, settings, behaviorTrust, game`; `game` is required
and is `null` or a `GameConfig`.

```ts
type CueRef = string | null;   // assetId (kind "audio") or null

interface GameConfig {
  configVersion: 1;
  title: string;         // 1–64 chars
  objective: string;     // 1–160 chars
  instructions: string;  // 1–320 chars
  playerId: string;      // entity id (the controller entity)
  cameraId: string;      // entity id (the camera + cameraFollow entity)
  spawnId: string;       // entity id (playerSpawn, the start spawn)
  level: { minX: number; maxX: number; minY: number; maxY: number };
  killY: number;
  cues: { start: CueRef; jump: CueRef; checkpoint: CueRef; death: CueRef; goal: CueRef };
}
```

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `configVersion` | integer | yes | exactly `1`; a shape change is a version change, not a same-version extension | — |
| `title` | string | yes | 1–64 chars, no control characters; display only | — |
| `objective` | string | yes | 1–160 chars, no control characters | — |
| `instructions` | string | yes | 1–320 chars, no control characters (no `\n`, no HTML, plain text only) | — |
| `playerId` | string | yes | must resolve to the scene's single `controller` entity | — |
| `cameraId` | string | yes | must resolve to the scene's single `camera` entity **carrying `cameraFollow`** | — |
| `spawnId` | string | yes | must resolve to an entity carrying `playerSpawn` | — |
| `level` | object | yes | `minX < maxX`, `minY < maxY`, each finite `|v| ≤ 1e6` | — |
| `killY` | number | yes | finite, `-1e6 ≤ v < level.maxY` | — |
| `cues` | object | yes | exactly the five keys; each `null` or an `assetId` resolving to `kind: "audio"` | all `null` (in a freshly created block the caller supplies them) |

Canonical key order: `configVersion`, `title`, `objective`, `instructions`,
`playerId`, `cameraId`, `spawnId`, `level`, `killY`, `cues`; `level`:
`minX`, `maxX`, `minY`, `maxY`; `cues`: `start`, `jump`, `checkpoint`, `death`,
`goal` (the sample's cue order — Start, jump, checkpoint, death, goal).

`instructions` is the plan-review PR-1 **bounded instructions string**
(`m3-plan.md` §2.1): 39 owns the field and its 320-char bound; it is authored
through `setGameConfig`, stored here and rendered as a text node by 55/56. It is
**not** a `game-host` constant.

`title`/`objective`/`instructions` are plain text: no HTML, markdown or markup is
interpreted; `<`, `>` and `&` are literal (the HUD must escape/insert as a text
node — packet 55's rule). No remote font or HTML is a v3 non-goal (§23.12).

### 23.5 Reference rules

Exactly one of each required role, and every reference resolves:

| # | Rule | Failure |
|---|---|---|
| 1 | ≤ 1 entity carries `controller` (accepted). When `content.game !== null`, **exactly one** is required and `game.playerId` must name it | `controller_count_invalid` (0 or ≥ 2) / `game_reference_missing` (`reason: "player"`) |
| 2 | exactly one entity carries `camera` (accepted); it must carry `cameraFollow` and be named by `game.cameraId` when `game !== null` | `camera_count_invalid` / `game_reference_missing` (`"camera"` / `"camera_follow"`) |
| 3 | `game.spawnId` resolves to a `playerSpawn` entity | `game_reference_missing` (`"spawn"`) |
| 4 | every checkpoint's `safeSpawnId` resolves to a `playerSpawn` entity | `game_reference_missing` (`"safe_spawn"`) |
| 5 | ≤ 1 `goal` zone when `game !== null` is **≥ 1**; checkpoints ≤ 1 (any time) | `zone_goal_missing` / `zone_checkpoint_count_invalid` |
| 6 | every `surface` sits on a `box`/`model` entity | `component_missing` |
| 7 | every `modelAnimation.assetId` equals its entity's `model` asset and `version` is in range | `component_conflict` (`"animation_asset"`) / `asset_version_invalid` |
| 8 | `components.model.asset.assetId` resolves to `kind: "model"` | `asset_reference_missing` / `asset_kind_mismatch` |
| 9 | every non-null cue asset reference and `activation.cueAssetId` resolves to `kind: "audio"` | `asset_reference_missing` / `asset_kind_mismatch` |
| 10 | no document contains a dangling reference of any kind after any load or command | (load) `reference_missing`/`game_reference_missing`; (command) rejection, never silent clearing |

What may reference what (closed):

- scene → content: `model.asset.assetId`, `modelAnimation.assetId`,
  `behavior.behaviorId`, `prefab.{prefabId,localId}`, cues/activation
  `assetId`s. Nothing else.
- scene → scene: `parentId` (accepted), `gameZone.safeSpawnId` (entities).
- content → scene: `game.playerId`/`cameraId`/`spawnId` — the **only** content
  block that may name entities. It is the sole reason deletion must consult the
  content block.
- There is **no** scene→export, scene→runtime, session, path, digest, URL, code
  or HTML reference; no second mutable document; no JSON blob field.

### 23.6 Deletion and mutation rules (rejection-first)

`deleteEntity` (accepted subtree deletion) gains a v3 reference check **before**
application, alongside the accepted camera/`entityRef` checks:

1. Compute the subtree closure as accepted. Reject with
   `game_reference_in_use` if the closure contains:
   - the entity named by `content.game.playerId`, `cameraId` or `spawnId`; or
   - the camera entity (already `camera_count_invalid`); or
   - any entity named by a checkpoint's `safeSpawnId`.
   `game_reference_in_use` carries
   `{ entityIds: [<closure ids>], references: [<JSON Pointer paths>] }` where each
   path is into the envelope document (`/game/playerId`,
   `/game/spawnId`, `/entities/<i>/components/gameZone/safeSpawnId`, …) and the
   list is in ascending codepoint order.
2. Component-level removals that would dangle a reference are rejected with the
   same code: `setComponent(entityId, 'playerSpawn', null)` for `game.spawnId` or
   a checkpoint's `safeSpawnId`; `setComponent(entityId, 'controller', null)`
   for `game.playerId`; `setComponent(entityId, 'cameraFollow', null)` for the
   camera entity while `game !== null`; `setComponent(entityId, 'model', …)` is
   never a removal (accepted).
3. Replacing `content.game` (a `setGameConfig` edit) never dangles anything, and
   removing the whole block (`value: null`) frees every reference; both are
   ordinary edits. A `setGameConfig` value whose references do not resolve is
   rejected (`game_reference_missing`) — never stored and repaired later.
4. **Assets are never deleted** in v3 (accepted M2 rule unchanged), so
   asset references cannot dangle. A reimport appends a version; a
   `modelAnimation.version` binding keeps pointing at its recorded immutable
   version and is never silently moved. Packet 41 owns role-binding reimport
   validation.
5. No operation silently clears a reference. Every rejection preserves the
   envelope bytes and the revision.

### 23.7 Canonical form additions

Extending §12.2: (a) fill the §23.3 defaults for present components only —
`surface` fields when a `surface` component is present; `light.castShadow` when a
`directional` light omits it; never fill a component that is absent, never fill
`activation` sub-fields, never fill `content.game` from `null`; (b) lowercase
`surface.color`, `surface.emissive`, `light.color`, `activation.emissive`;
(c) emit components in the §23.3 registry order and the field orders stated in
§§23.3/23.4; (d) `content.game` is emitted after `behaviorTrust`, as `null` or the
canonical block; (e) emit `entities` order unchanged and `content.assets` in
ascending `assetId` order as accepted; (f) byte output rules (§12.2 rule 6) and
idempotence (rule 7) unchanged.

Canonical key-order constant for a v3 content block:
`assets, prefabs, behaviors, settings, behaviorTrust, game`.

### 23.8 Validation order (v3 branch)

For a v3 scene the accepted per-document order (§12.3) is unchanged; the v3
additions run inside pass 4's collection step, in this order (all errors are
collected, not fail-fast, except where a single-error rule is stated):

1. component registry and combinations (§23.3, including the `gameZone`
   `zone_transform_unsupported` and the `playerSpawn` `spawn_transform_unsupported`
   of §23.9, and `component_conflict`);
2. per-component field values, ranges, canonical field order (§§23.3.1–23.3.6);
3. `modelAnimation` container: role keys/required/canonical bytes (§23.3.6);
4. counts and limits (§23.10);
5. entity-level `game` references that need only the scene: `playerId`/
   `cameraId`/`spawnId` existence and role match, checkpoint `safeSpawnId`
   resolution, `surface`/`modelAnimation` target rules, goal/checkpoint counts;
6. cross-block checks (with `content.game`): cue and `activation.cueAssetId`
   resolution, `kind` checks, `modelAnimation` asset/version resolution
   (§13 v3 extension);
7. `content.game` field validation (`configVersion`, strings, `level`, `killY`,
   `cues` shape) fails as one block-level `game_config_invalid` carrying `path`
   and `reason` (§23.9).

**Effective per-document order** (matches [`workspace.md`](workspace.md) §16 and the
packet-39 fixture checker): combination check → envelope/content key set →
`content.assets` records and `kind` discriminators → `content.game` structural
validation (step 7) → scene validation (steps 1–5 above) → cross-block
resolution (step 6). Steps 1–5 collect independent errors; the combination
check, the envelope/content key set and `game_config_invalid` are single-error
rules that stop the pipeline.

Envelope-level order (`storageVersion` known → combination check → scene →
content → cross-block) is [`workspace.md`](workspace.md) §16. A v3 combination
mismatch stops before any of the above.

### 23.9 New error codes

Added to §12.6 (model) and mirrored in `commands.md` §5.4 /
`workspace.md` §11 where a command or load reports them:

| Code | Raised when |
|---|---|
| `game_reference_missing` | `content.game` names an entity/asset that does not resolve, or a required role is absent; carries `path`, `reason` (`player`/`camera`/`camera_follow`/`spawn`/`safe_spawn`/`cue`) |
| `game_reference_in_use` | a deletion or component removal would dangle a game/checkpoint reference; carries `entityIds`, `references` (JSON Pointer paths) |
| `zone_transform_unsupported` | a `gameZone` entity is parented, non-unit-scaled or rotated; carries `path` and `reason` (`parented`/`scale`/`rotation`) (§23.3.1) |
| `spawn_transform_unsupported` | a `playerSpawn` entity is parented, non-unit-scaled or rotated/tilted; carries `path` and `reason` (`parented`/`scale`/`rotation`) (§23.3.2). Same three conditions, reason vocabulary and `path` forms as `zone_transform_unsupported`, but a separate code so the offending component is named; mirrors the accepted `physics_transform_unsupported` style (`project-model.md` §21.2) |
| `zone_checkpoint_count_invalid` | more than one `role: "checkpoint"` zone in the scene (single error; carries `zoneIds`) |
| `zone_goal_missing` | `content.game` is non-null and the scene has no `role: "goal"` zone |
| `asset_kind_mismatch` | a reference expects one `kind` and the resolved record has another (e.g. cue → `model`, animation → `audio`), or a reimport changes `kind` |
| `game_config_invalid` | `content.game` is malformed at the block level. Carries `path` and `reason`: `field_missing` (a required block field absent), `field_unexpected` (unknown block/cue field), `field_type`, or `field_value` (bad `configVersion`, string length/control char, `level`/`killY` relation). **Document rule:** envelope/content loading reports this one block-level code for structural failures; *commands* validate the same fields as request `args` and report the `field_*` codes of `commands.md` §5.4. References inside the block report `game_reference_missing` / `asset_reference_missing` / `asset_kind_mismatch`, never `game_config_invalid` |

`limits_exceeded` gains the limit names of §23.10. All new codes are additive:
no accepted code changes meaning or carries-shape.

### 23.10 Limits (v3 additions; reviewable at K)

All finite; exceeding one is `limits_exceeded` with `limit`, `current`, `max`.
Defaults are chosen for the sample and are **reviewable at Gate K** — the table
is contract material because fixtures reference the exact values.

| Class | Bound | Value | Failure |
|---|---|---|---|
| scene | zones per scene (`gameZone`) | 64 | `limits_exceeded` (`zones`) |
| scene | checkpoint zones per scene | 1 | `zone_checkpoint_count_invalid` |
| scene | goal zones per scene when `game !== null` | ≥ 1 | `zone_goal_missing` |
| scene | spawn markers per scene (`playerSpawn`) | 16 | `limits_exceeded` (`player_spawns`) |
| scene | directional lights | 1 | `limits_exceeded` (`lights_directional`) |
| scene | ambient lights | 1 | `limits_exceeded` (`lights_ambient`) |
| scene | entities per scene | 1024 (accepted) | `limits_exceeded` (`entities`) |
| content | `audio` asset records | 16 | `limits_exceeded` (`audio_assets`) |
| content | versions on an `audio` record | 8 | `limits_exceeded` (`audio_versions`) |
| content | canonical `content.game` bytes | 16 384 | `limits_exceeded` (`game_bytes`) |
| content | canonical `content` bytes | 1 048 576 (accepted) | `limits_exceeded` (`content_bytes`) |
| component | canonical `roles` bytes | 4 096 | `limits_exceeded` (`animation_profile_bytes`) |
| strings | `title` / `objective` / `instructions` | 64 / 160 / 320 chars | `field_value` (length) |
| numbers | `size`, `level`, `killY`, `deadZone`, `bounds` | `|v| ≤ 1e6` | `number_out_of_range` |
| numbers | `roughness`, `metalness`, `smoothing` | `[0, 1]` | `number_out_of_range` |
| numbers | `intensity` | `[0, 8]` | `number_out_of_range` |
| numbers | `emissiveIntensity` | `[0, 4]` | `number_out_of_range` |
| numbers | `light.direction` component | `|v| ≤ 1`, `‖v‖ ≥ 1e-6` | `number_out_of_range` |

### 23.11 Migration entry points (pure, v3)

Extending §12.4: `migrateSceneV3(scene)` accepts a logical v2 scene and returns
a logical v3 scene with `schemaVersion: 3`; every entity value, order, ID,
transform and component is carried **verbatim** (the v3 registry is a superset,
so no v2 entity needs editing). It is identity when the input is already v3.
It is pure, total and never touches disk. The envelope-level v2→v3 **copy**
operator (new identity, revision/retry/history reset, resumable crash
boundaries, no in-place upgrade) is [`workspace.md`](workspace.md) §16.

“Superset” means every **v2-valid** entity is a valid v3 entity without editing;
it does **not** license a `schemaVersion: 2` scene that carries a v3-only
component (`gameZone`, `playerSpawn`, `cameraFollow`, `light`, `surface`,
`modelAnimation`). Such a document is not a v2 scene (`component_unknown` under
the v2 pipeline), so it is not a legal input to this operator and never a legal
migration source ([`workspace.md`](workspace.md) §16.5.1,
`migration_source_invalid`).

### 23.12 Non-goals (v3)

No second mutable document; no JSON blob, script, expression, URL or HTML field;
no remote fonts/textures; no user-authored shader; no general event/behaviour
scripting; no light other than one directional + one ambient; no camera other
than the single gameplay camera with `cameraFollow`; no second physics owner; no
asset deletion/GC (accepted M2 non-goal unchanged); no runtime dependency on
editor/server/MCP code; no new numeric/gameplay tuning keys in
`content.settings` (the accepted six keys stand — packet 40/58 may propose a
reviewed change, 39 does not).