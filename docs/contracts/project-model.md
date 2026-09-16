# Thirdlight — Project Data Contract

Version: 0.1 (normative) · Packet 01 · 2026-09-16
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
  ownership — packet 02 (`docs/contracts/workspace.md`); note that M1
  persistence places the manifest and the scene as described in §6, and that
  packet 02's single atomic authoring-state envelope wraps the scene document
  and its revision.
- Runtime snapshots, sessions, export, module boundaries — packet 03.

Explicit non-goals for M1 (charter §3, packet 01 instruction): no full ECS,
no physics schema, no prefab/instance inheritance, no shader or material
graphs, no assets (boxes are procedural primitives with an inline material),
no lights, no multi-scene projects.

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

A project is a directory under the workspace data root
(`/home/dadmin/thirdlight/projects/<projectId>/`, decision 0001 §6) containing
exactly these documents (schemaVersion 1):

```text
<projectId>/
  project.json           ← project manifest (document type: "project-manifest")
  scenes/
    main.json            ← the single active scene (document type: "scene")
```

- File names are **normative** for schemaVersion 1.
- M1 supports exactly **one** active scene per project. The manifest lists it
  (length of `scenes` is exactly 1). Multi-scene support is a future contract
  change (packet 02 already anticipates that multi-scene transactions require
  a new persistence contract).
- Documents are standalone strict-JSON files (UTF-8, no BOM, LF line
  endings). The project-level view (manifest + scene validated together) is
  defined in §13.

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

Project IDs, scene IDs, and entity IDs all use one syntax:

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

### 5.3 References

| Reference | From | To | Form |
|---|---|---|---|
| `scenes[i].id` | manifest | scene document `sceneId` | ID string, equality |
| `scenes[i].path` | manifest | scene document file | project-relative POSIX path; M1: exactly `"scenes/main.json"` |
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
| **Schema version** | `schemaVersion`, integer | The data format of this contract. M1 known versions: `[1]`. | Contract authors; a new component type, a new required field, or any meaning change **requires** a new `schemaVersion` (same-version extensions are forbidden in M1). | Manifest and scene documents. | Unknown (higher **or** lower) → single actionable `schema_version_unsupported` error, document retained untouched (§12.3). No field-level validation is attempted against an unknown version. |
| **Engine version** | `engineVersion`, string, semver `MAJOR.MINOR.PATCH[-prerelease]` (regex `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`) | Which Thirdlight build wrote the manifest. M1 baseline: `0.1.0`. | The writing engine at project creation. | Manifest only. | Any well-formed semver is accepted — the engine version **never blocks** validation (forward compatibility within a known schema version). |
| **Authoring revision** | `revision`, integer | The project's editing state. Project-level monotonically increasing counter; M1 carries it in the scene document because there is exactly one scene (packet 02's project-level revision **is** this field). Starts at `0`. | The command/workspace layer (packets 02/07); the data contract only constrains type/range. | Scene document. | `0 ≤ revision ≤ 2^53−1` (`Number.MAX_SAFE_INTEGER`); violation → `revision_invalid`. Monotonicity and conflict rules are packet 02, **not** data validation. |
| **Runtime snapshot ID** | derived string: `<projectId>@r<revision>` (e.g. `demo-0001@r12`) | An immutable, deep-frozen copy of the scene document (normalized form, §12.2) at a given authoring revision. Consumed by play (packets 08–10) and export (packet 12). | Derived deterministically; never stored as authoring state. | Nowhere in manifest/scene documents; the snapshot consumer derives it and records it in export metadata (packet 12). | Not validated as a persisted field (it is not persisted). |

Rules:

- `schemaVersion` and `engineVersion` coexist in the manifest; a future
  engine may read a document with an unknown `engineVersion` fine as long as
  `schemaVersion` is known.
- A document pair whose manifest and scene `schemaVersion` differ →
  `schema_mixed_versions` (§13).
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
| `schemaVersion` | integer | yes | exactly `1` (known: `[1]`) | — |
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

### 7.2 Timestamps

- Format: `YYYY-MM-DDTHH:mm:ssZ` — UTC, second precision, literal `Z`, no
  fractional seconds. Regex: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`, and the
  value must denote an existing calendar date (no month 13, no Feb 30).
- M1 carries only `createdAt` (manifest). The scene document carries **no**
  timestamps (revision is its ordering token). The normalizer never
  rewrites or regenerates timestamps.

## 8. Scene — `scenes/main.json`

Document type: `scene`. Top-level shape (schemaVersion 1):

```json
{
  "schemaVersion": 1,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [ /* entity objects, §9 */ ]
}
```

### 8.1 Fields

| Field | Type | Required | Constraint | Default |
|---|---|---|---|---|
| `schemaVersion` | integer | yes | exactly `1` | — |
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

`box` and `camera` are **mutually exclusive** on one entity (`component_conflict`).
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
A component unknown to the registry → `component_unknown` with the list of
known types in the error (§12.6). For an unknown component type the validator
reports `component_unknown` and performs **no field-level validation** of
that component's contents (its format is unknown). Adding a component type
requires a new `schemaVersion` (§6). Canonical component key order in
serialized documents: `transform`, `box`, `camera`.

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
- The normalizer renormalizes to unit length (divides by ‖q‖).
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

## 12. Validation and normalization

### 12.1 Entry points (normative API shape; implementation in packet 05)

- `validateManifest(doc)`, `validateScene(doc)` — pure check over a parsed
  JSON value; the validator must **not** trust any parser's guarantees and
  re-checks every rule at the boundary (charter §5; packet 05: types alone
  are insufficient).
- `validateProject(manifest, scene)` — both documents, then cross-document
  checks (§13).
- `normalizeManifest(doc)`, `normalizeScene(doc)` — validate, then return a
  **new** canonical document (§12.2). Never mutates the input.
- `migrateManifest(doc, target)`, `migrateScene(doc, target)` — migration
  entry points (§12.4).
- Validation is pure and total: same input → same result; it never reads or
  writes the filesystem and never throws on malformed data (errors are
  returned values).

### 12.2 Canonical form (stable for diffs)

The normalizer produces byte-stable output for a logical document:

1. Fill missing optional fields with defaults (§7–§10); strip nothing
   else (unknown fields are errors, not stripped — §12.6).
2. Renormalize quaternions to unit length (§10.1). No other numeric
   re-expression (numbers are IEEE-754 doubles; serialized with the
   platform's shortest round-trip decimal form, e.g. JavaScript
   `JSON.stringify` semantics — deterministic per value).
3. Lowercase `material.color` hex.
4. Emit fixed key order:
   - manifest: `schemaVersion`, `engineVersion`, `id`, `name`,
     `createdAt`, `scenes`;
   - scene: `schemaVersion`, `sceneId`, `revision`, `entities`;
   - entity: `id`, `name` (if present), `parentId` (if non-null),
     `components`;
   - components in registry order, fields per §10.
5. Preserve `entities` array order; never sign-flip quaternions; never
   rewrite timestamps or IDs.
6. Output: UTF-8, LF, 2-space indentation, no trailing spaces, one trailing
   newline, no BOM.
7. Idempotence: `normalize(normalize(x)) == normalize(x)` (byte-identical).

### 12.3 Validation passes (normative order)

Per document:

1. **Parse** (strict JSON, RFC 8259): non-UTF-8 bytes, a BOM, duplicate
   object keys, trailing garbage, or non-strict tokens (`NaN`, `Infinity`,
   `undefined`) → `encoding_invalid` / `duplicate_key` / `json_parse_error`;
   the original bytes are **retained** untouched (workspace recovery,
   packet 07). No deeper validation follows a parse failure.
2. Document root is a JSON object, else `field_type` at `""`.
3. `schemaVersion` present and known. Unknown → **exactly one** error
   `schema_version_unsupported` (with `found`, `knownVersions: [1]`, and the
   action hint §12.5); validation of that document stops (field errors are
   meaningless against an unknown format).
4. Known version → full validation, **collecting all independent errors**
   (not fail-on-first): field presence/type, ID syntax, duplicate IDs,
   references, hierarchy (§11), numbers/finite/ranges, quaternions,
   component registry and combinations, camera count, limits, timestamps,
   paths.

Duplicate-ID reporting: first occurrence wins; the error points at the later
occurrence.

### 12.4 Migration entry points (described, not implemented)

- M1 ships **no migrations**. `migrate*(doc, target)` is an identity
  operation when the document's `schemaVersion` equals `target` (and both
  equal `1`); any other pair returns a structured `no_migration_path`
  result (from-version, to-version, `action`: open in an engine that knows
  the format, or convert manually; the original document is retained).
- A future migration is a pure function keyed on
  `(schemaVersion from → schemaVersion to)` operating on parsed documents,
  writing a **new** file version and never rewriting the original in place.
  Hypothetical migrations are out of scope for M1; this section is the
  binding entry-point shape for them.
- **No destructive rewrite, ever:** a document that fails validation or
  migration is retained on disk byte-for-byte; errors are reported against
  it. (Charter §6: invalid external data is reported and retained for
  repair.)

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
{ "ok": true,  "normalized": <doc> }   ← validate*/normalize* success
{ "ok": false, "errors": [ <error>, … ] }
```

### 12.6 Error codes (stable, normative for M1)

| Code | Raised when |
|---|---|
| `encoding_invalid` | file is not valid UTF-8 or contains a BOM |
| `json_parse_error` | strict JSON parse failure (incl. `NaN`/`Infinity` tokens, trailing garbage) |
| `duplicate_key` | duplicate object key in the JSON text |
| `schema_version_unsupported` | `schemaVersion` not in known versions `[1]` (single error, stops document validation) |
| `schema_mixed_versions` | manifest and scene `schemaVersion` differ (§13) |
| `field_missing` | required field absent |
| `field_unexpected` | unknown field (strict: M1 silently drops nothing) |
| `field_type` | wrong JSON type (e.g. string where a number is required) |
| `field_value` | right type, wrong value (e.g. `scenes[i].path` ≠ `"scenes/main.json"`, `type` ≠ `"perspective"`, color not `#rrggbb`) |
| `id_invalid` | ID fails §5.1 syntax |
| `id_duplicate` | two entities with the same `id` |
| `reference_missing` | `parentId` does not resolve to an existing entity |
| `hierarchy_cycle` | parent-chain cycle (§11.2) |
| `order_parent_before_child` | an entity precedes its parent in the array |
| `number_not_finite` | non-finite numeric value (runtime-only cases, §12.7) |
| `number_out_of_range` | finite value outside its range (§7–§10 constraints) |
| `quaternion_invalid` | rotation not a finite unit quaternion within `1e-4` |
| `component_unknown` | component key not in the registry (error lists known types) |
| `component_missing` | `transform` absent from an entity |
| `component_conflict` | `box` and `camera` on the same entity |
| `camera_count_invalid` | scene does not contain exactly one `camera` |
| `limits_exceeded` | §10.4 limit exceeded (error carries `limit`: `entities` / `depth`) |
| `revision_invalid` | `revision` not an integer in `[0, 2^53−1]` |
| `manifest_scene_mismatch` | §13 cross-document failure |
| `no_migration_path` | migration requested for an unsupported version pair (§12.4) |

### 12.7 Runtime (non-JSON) validation cases

JSON cannot encode `NaN` or `±Infinity`, so these cases are specified
separately and exercised in memory (packet 05 tests), not as JSON fixtures:

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

Note: strict `JSON.parse` cannot produce `NaN` from valid JSON (it rejects
those tokens), so R1–R3 arise from in-memory construction (runtime API,
command application, future lenient parsers). The validator's per-value
finiteness check is the boundary defense for all paths.

## 13. Cross-document (project-level) validation

`validateProject(manifest, scene)` runs both single-document validations,
then, only if both pass:

1. `manifest.scenes[0].id === scene.sceneId` — else
   `manifest_scene_mismatch` (path `/scenes/0/id` in the manifest).
2. `manifest.scenes[0].path === "scenes/main.json"` — else
   `field_value` (covered by single-document validation; re-asserted here).
3. `manifest.schemaVersion === scene.schemaVersion` — else
   `schema_mixed_versions`.
4. (Workspace-enforced, packet 07, stated here for completeness): project
   directory name equals `manifest.id`; no other files exist in the M1
   project directory.

## 14. What is deliberately not in this contract

- No ECS generalization: the component registry is a fixed M1 table
  (§10); no dynamic registration, no component inheritance.
- No physics, no input, no gameplay components (M2).
- No prefabs/instances, no variants (M2).
- No assets or asset references; no lights; no materials beyond
  `box.material.color` (M2+).
- No world-transform persistence, no per-entity visibility flags, no
  per-entity tags.
- No rename/reorder in M1 documents' command surface (packet 02); the
  invariants §11.1 must nevertheless hold.
- No second scene, no scene naming (the manifest `name` is the only M1
  display name).
- No multi-file transactions, no journaling (packet 02/07).

## 15. Default scene (project-creation template, normative)

Creating a project writes the manifest (§7) plus exactly this scene
(revision `0`):

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
| `runtime/non-finite-cases.md` | runtime | R1–R6 cases from §12.7 (in-memory, not JSON fixtures) |

Packet 05 must pass every valid fixture through validation + normalization
(round-trip) and every invalid fixture through validation expecting exactly
the listed codes (superset matching: all listed codes present; unexpected
additional codes are a contract/implementation bug to report, not to paper
over).

## 17. Change rules

- Any change that old readers could misinterpret (new required field, changed
  meaning, new component type, new document) → new `schemaVersion` and a
  reviewed contract diff (AGENTS.md: accepted contracts are binding).
- Additive, always-optional, always-defaulted fields are **not** permitted in
  M1 (strict `field_unexpected`); they become a version bump.
- Fixtures are part of the contract: changing a fixture's expected codes
  requires the same review as the contract text.