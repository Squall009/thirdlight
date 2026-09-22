PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# PROPOSED section-level diffs — `docs/contracts/project-model.md`

**PROPOSED — pending Gate E.** Packet 15 (`docs/planning/m2-packets.md` §15)
output. This file contains *no* accepted text: it names the exact destination
sections, gives old → new text for every existing section that changes, and gives
insertion instructions (anchor + normative text source) for new sections.

Read with: [`../assets.md`](../assets.md) (normative text for the new sections),
[`workspace.md`](workspace.md) (the storage/version side of the same change).
Promotion is docs-only, per diff, at Gate E; nothing here is applied by packet 15.
Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

Convention: `OLD` is the accepted text exactly as it reads today (shortest unique
quote); `NEW` is the replacement. `+` blocks are pure insertions at the stated
anchor. Section numbers of accepted sections are **never renumbered**: new
material is appended as §18/§19. Cross-references written `§n` inside promoted
text refer to the new numbering.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| A1 | §3 "Documents and layout" | insert bullet | this file |
| A2 | §5.1 "ID syntax" | reword | this file |
| A3 | §5.2 "Stability and semantics" | insert bullets | this file |
| A4 | §6 "Version taxonomy" (Schema version row + rules) | reword + insert | this file |
| A5 | §8 "Scene" / §8.1 fields | reword + insert note | this file |
| A6 | §12.1 "Entry points" | insert items | `../assets.md` §10.1, §12 |
| A7 | §12.2 "Canonical form" | insert rules | `../assets.md` §4/§5/§6/§9 |
| A8 | §12.3 "Validation passes" step 3 | reword | this file |
| A9 | §12.4 "Migration entry points" | insert paragraph | this file |
| A10 | §12.6 "Error codes" | insert rows | `../assets.md` §10.3 |
| A11 | §13 "Cross-document validation" | insert subsection | `../assets.md` §11 |
| A12 | §14 "What is deliberately not in this contract" | reword bullet | this file |
| A13 | §17 "Change rules" | insert bullet | this file |
| A14 | **new §18** | insert section | `../assets.md` §§3–8, 10, 11 (verbatim, headings renumbered) |
| A15 | **new §19** | insert section | `../assets.md` §9 (verbatim, heading renumbered) |

Not changed: §§1, 2, 4, 7, 9, 10, 11, 15, 16 (manifest v1, entity/component v1
semantics, fixtures of v1, default scene).

---

## B. Existing sections

### A1 — §3 "Documents and layout": insert one bullet

Anchor: the bullet that ends `…No auto-detection or fallback between formats is implied.`

```diff
 - Workspace ownership records, temporary files, and recovery artifacts are
   governed by packet 02, not prohibited by this logical-document contract.
   The workspace contract must define their locations and validation policy.
+- In the M2 workspace the active workspace envelope is `storageVersion` 2 and
+  its embedded scene is `schemaVersion` 2 (workspace.md §4.2): the envelope gains
+  a bounded `content` block beside `scene` and `retry`. The content block is
+  **envelope state only**: it has no standalone logical document, no
+  interchange file and no byte parser, because a second mutable catalog file is
+  exactly what §14 (no multi-file transactions) excludes. The interchange
+  layout and the logical documents above are unchanged, and a `schemaVersion` 1
+  document is still exactly as defined in §7–§10.
```

### A2 — §5.1 "ID syntax (all IDs)"

```diff
-Project IDs, scene IDs, and entity IDs all use one syntax:
+Project IDs, scene IDs, entity IDs, asset IDs and stage IDs all use one syntax:
```

(`assetId` and `stageId` are opaque identifiers of the same lexical form; the
syntax is a uniformity/stability choice, and neither is derived from a file name
or a content hash — see A3 and assets.md §3.)

### A3 — §5.2 "Stability and semantics": insert two bullets

Anchor: after the bullet that ends `…names are not unique, not stable, and never
used as references.`

```diff
+- **Asset IDs are stable, opaque and never reused.** A reimport, rename, undo,
+  restore or retry keeps an `assetId`; it is assigned once at creation from a
+  caller-supplied valid ID, never derived from a file name, display name, content
+  digest or import order, and never reassigned within a project (M2 has no asset
+  deletion; a later version that adds one must add a never-reuse rule —
+  assets.md §3.7). Internal glTF node/material/clip names and indices are **not**
+  engine IDs and are never persisted as references (assets.md §3.3).
+- **Stage IDs are not persisted identities.** A stage ID names a non-authoritative
+  staging directory; it is never stored in a document and never referenced by a
+  command's arguments (workspace.md §7.6).
```

### A4 — §6 "Version taxonomy"

**(a) Schema version row:**

```diff
-| **Schema version** | `schemaVersion`, integer | The data format of this contract. M1 known versions: `[1]`. | Contract authors; a new component type, a new required field, or any meaning change **requires** a new `schemaVersion` (same-version extensions are forbidden in M1). | Manifest and scene documents. | Unknown (higher **or** lower) → single actionable `schema_version_unsupported` error, document retained untouched (§12.3). No field-level validation is attempted against an unknown version. |
+| **Schema version** | `schemaVersion`, integer | The data format of this contract. Known versions are **per document type**: manifest `[1]`; scene `[1, 2]` (M2 adds scene `2`). | Contract authors; a new component type, a new required field, or any meaning change **requires** a new `schemaVersion` (same-version extensions are forbidden). | Manifest and scene documents. | Unknown (higher **or** lower) for that document type → single actionable `schema_version_unsupported` error, document retained untouched (§12.3). No field-level validation is attempted against an unknown version. |
```

**(b) Rules list:** insert one bullet after the bullet ending
`…With M1 known versions `[1]`, every passing pair necessarily matches.`

```diff
+- **Version combinations are checked explicitly, not assumed.** The active
+  workspace accepts exactly two combinations — manifest `1` + scene `1` +
+  `storageVersion` `1` (M1, unchanged), and manifest `1` + scene `2` +
+  `storageVersion` `2` (M2, workspace.md §4.5). A v2 envelope whose scene is
+  `schemaVersion` 1 fails with a single `version_combination_unsupported` before
+  any field validation; a v1 envelope whose scene is `schemaVersion` 2 fails with
+  the M1 pipeline's `scene_invalid` → `schema_version_unsupported`. The manifest
+  stays `schemaVersion` 1 in M2.
```

### A5 — §8 "Scene" / §8.1 fields

**(a)** After the `schemaVersion 1` example in §8, add:

```diff
+The **logical** scene shape above is `schemaVersion` 1. In the M2 active
+workspace the embedded scene is `schemaVersion` 2: the same top-level fields
+(`schemaVersion`, `sceneId`, `revision`, `entities`) with the §18 component
+registry, which is a superset of the §10 registry. §8.1 below states both
+versions; a standalone interchange file remains `schemaVersion` 1 until a
+separate contract change says otherwise.
```

**(b) §8.1 field table:**

```diff
-| `schemaVersion` | integer | yes | exactly `1` | — |
+| `schemaVersion` | integer | yes | `1` (interchange, M1 workspace) or `2` (M2 active workspace; required there — workspace.md §4.2, §4.5) | — |
```

### A6 — §12.1 "Entry points"

Insert after the `migrateManifest(doc, target), migrateScene(doc, target)` bullet:

```diff
+- `validateContent(doc: unknown)`, `normalizeContent(doc: unknown)` — pure value
+  checks and canonicalization of the envelope's `content` block (assets.md §4–§6,
+  §10). There is deliberately **no** `parseContent(bytes)`: the content block has
+  no standalone file, so its bytes are governed by the envelope's strict parse
+  (workspace.md §4.3).
+- `validateProjectV2(manifest, scene, content)` — three-block composition with the
+  §13.1 cross-block reference check.
+- `captureContent(scene, content, ctx)` → `CapturedContent` — the pure captured
+  immutable content view (new §19).
```

and change the constants bullet:

```diff
-- Constants: `ERROR_CODES` (the §12.6 stable code set) and `KNOWN_VERSIONS`
-  (M1: `[1]`) — the single source of truth for consumers (workspace,
-  runtime, exporter, protocol — dependencies.md §3).
+- Constants: `ERROR_CODES` (the §12.6 stable code set, extended by §18.9) and
+  `KNOWN_VERSIONS` — the single source of truth for consumers (workspace,
+  runtime, exporter, protocol — dependencies.md §3). `KNOWN_VERSIONS` becomes a
+  per-document structure: `{ manifest: [1], scene: [1, 2] }`, with
+  `SCHEMA_VERSIONS_BY_DOCUMENT` as the same value under a descriptive name
+  (this is a **breaking change to the constant's type**; it is part of the same
+  reviewed diff and packet 20 implements it).
```

### A7 — §12.2 "Canonical form (stable for diffs)"

In rule 4 (fixed key order) add the v2 lines:

```diff
    - scene: `schemaVersion`, `sceneId`, `revision`, `entities`;
    - entity: `id`, `name` (if present), `parentId` (if non-null),
      `components`;
-   - components in registry order, fields per §10.
+   - components in registry order, fields per §10; in a `schemaVersion` 2 scene
+     the registry order is `transform`, `model`, `box`, `camera` (only
+     `transform` plus the reference shape `components.model.asset.assetId` is
+     fixed by the M2 content contract; the remaining v2 component fields and
+     their internal key order are packet 20's, and they are appended after
+     `model` in that same registry);
+   - content block: `assets`, `prefabs`, `behaviors`, `settings`; each
+     `assets[i]`: `assetId`, `kind`, `displayName`, `currentVersion`, `versions`;
+     each `versions[j]`: `version`, `sourceDigest`, `sourceByteLength`,
+     `importRecipe`, `metrics`, `importedAt`, `publishedRevision`;
+     `importRecipe`: `profile`, `recipeVersion`, `toolchain`, `extensions`;
+     `metrics` in the field order of §18.6. `content.assets` is emitted in
+     ascending `assetId` codepoint order.
```

### A8 — §12.3 step 3

```diff
-3. `schemaVersion` present and known. Unknown → **exactly one** error
-   `schema_version_unsupported` (with `found`, `knownVersions: [1]`, and the
-   action hint §12.5); validation of that document stops (field errors are
-   meaningless against an unknown format).
+3. `schemaVersion` present and known **for that document type**. Unknown →
+   **exactly one** error `schema_version_unsupported` (with `found`,
+   `knownVersions` = the known set for that document type, and the action hint
+   §12.5); validation of that document stops (field errors are meaningless
+   against an unknown format).
```

### A9 — §12.4 "Migration entry points"

Insert a paragraph after the "No destructive rewrite, ever" bullet:

```diff
+- **Scope precision (M2).** These entry points remain the *logical document*
+  migration shape: pure functions over parsed documents, keyed on a version pair,
+  writing a new file version. The M1-project → M2-project change is deliberately
+  **not** one of them: it is an operator workflow that creates a **new project**
+  (new identity, new revision policy) and copies bytes, so it lives in the
+  workspace contract (workspace.md §14) and performs no in-place logical rewrite.
+  `migrateManifest`/`migrateScene` continue to return `no_migration_path` for
+  every version pair M2 does not know, including `2 → 1` (no downgrade).
```

### A10 — §12.6 error-code table: insert rows

```diff
 | `no_migration_path` | migration requested for an unsupported version pair (§12.4) |
+| `version_combination_unsupported` | a `storageVersion` 2 envelope whose embedded scene is not `schemaVersion` 2 (single error; the check precedes field validation) |
+| `asset_reference_missing` | a scene `components.model.asset.assetId` resolves to no record in the envelope's `content.assets` (§13.1) |
+| `digest_invalid` | a `sourceDigest` is not exactly 64 lowercase hexadecimal characters |
+| `asset_version_invalid` | an asset's `versions` array is not contiguous strictly ascending `1..N`, or a version value is out of range or duplicated |
+| `recipe_invalid` | an `importRecipe` is malformed, names an unknown profile or recipe version, or omits a required toolchain entry |
```

and extend the `limits_exceeded` row:

```diff
-| `limits_exceeded` | §10.4 limit exceeded (error carries `limit`: `entities` / `depth`) |
+| `limits_exceeded` | a declared limit is exceeded; the error carries `limit`: `entities` / `depth` (§10.4) or, in a `schemaVersion` 2 document, one of the §18.6/§18.4 limits (`assets`, `asset_versions`, `version_records`, `content_bytes`, `source_bytes`, `nodes`, `meshes`, `primitives`, `materials`, `images`, `textures`, `vertices`, `triangles`, `animations`, `animation_channels`, `clip_duration`, `decoded_bytes`) |
```

### A11 — §13 cross-document validation: insert §13.1

Anchor: after the bullet list ending `…otherwise pass their logical normalized
values to `validateProject`. This composition introduces no filesystem operation
in the project-model package.`

```diff
+### 13.1 Three-block composition (`validateProjectV2`, v2 envelopes only)
+
+`validateProjectV2(manifest, scene, content)` accepts logical values and runs
+`validateManifest` (v1), the v2 scene validation and `validateContent`. If any
+block fails, the error sets are returned in manifest, scene, content order and
+the cross-block check is **skipped**. Only if all three pass:
+
+1. every `assetId` referenced by a `components.model` value in the scene resolves
+   in `content.assets`; otherwise one `asset_reference_missing` per unresolved
+   reference, with `document: "scene"` and path
+   `/entities/<i>/components/model/asset/assetId`;
+2. the existing §13 checks 1–3 run unchanged.
+
+The check is one-way by design: an unreferenced catalog record is valid retained
+content, while a dangling reference is not. The workspace calls this function
+after its own envelope-level checks (workspace.md §4.3 steps 6a–6h).
```

### A12 — §14 "What is deliberately not in this contract"

```diff
-- No assets or asset references; no lights; no materials beyond
-  `box.material.color` (M2+).
+- No assets or asset references **in `schemaVersion` 1**; the M2
+  `schemaVersion` 2 scene adds whole-GLB asset references (new §18) — still no
+  subresource references, no lights, and no materials beyond `box.material.color`
+  and the imported GLB's own core-PBR materials.
```

### A13 — §17 "Change rules": insert a bullet

```diff
+- M2's scene `schemaVersion` 2 / `storageVersion` 2 material (new §§18–19,
+  workspace.md §4.5) follows these rules exactly: the manifest stays
+  `schemaVersion` 1, `schemaVersion` 1 documents remain valid and unmodified, no
+  same-version extension is added to either version, and the new bound values
+  (assets.md §6, workspace.md §13.9) are part of the contract because fixtures
+  and tests reference them.
```

---

## C. New sections

### A14 — new §18 "Content catalog, asset records and the M2 import profile (scene schemaVersion 2 / storageVersion 2)"

Insert **after** §17 (end of document). Normative text, verbatim:

| New subsection | Text source |
|---|---|
| §18.0 intro (envelope-only state) | `../content-storage.md` §3, first two paragraphs |
| §18.1 Asset identity model | `../assets.md` §3 (including the pinned `components.model.asset.assetId` reference shape and the *not-an-engine-ID* rule) |
| §18.2 `ContentCatalog` | `../assets.md` §4.1 |
| §18.3 `AssetRecord` | `../assets.md` §4.2 |
| §18.4 `AssetVersion` | `../assets.md` §4.3 |
| §18.5 `ImportRecipe` | `../assets.md` §5 |
| §18.6 `AssetMetrics` and caps | `../assets.md` §6 (the `limits_exceeded` values referenced by A10) |
| §18.7 M2 import profile + validation order | `../assets.md` §7.1/§7.2 |
| §18.8 Extension allowlist and import diagnostics | `../assets.md` §7.3/§7.4/§7.5 |
| §18.9 Validation order and new error codes | `../assets.md` §10 (with §12's export list moved to the §12.1 bullet text of A6) |
| §18.10 Observability of failures | `../assets.md` §13 (kept as normative prose: it states what a consumer may observe) |

If Gate E prefers the import profile to live in a dedicated
`docs/contracts/asset-pipeline.md` (packet 24's package), the §18.7/§18.8 text
moves there unchanged instead; the schemaVersion-2 catalog/version/metrics text
(§18.1–§18.6) stays in `project-model.md` either way.

### A15 — new §19 "Captured immutable content view"

Insert **after** §18. Normative text: `../assets.md` §9 (`CapturedAssetVersion`,
`CapturedContent`, derivation, the `contentDigest` rule and the pinning rules),
plus the `captureContent` signature from `../assets.md` §10.1.

---

## D. Explicitly not changed (no silent reinterpretation)

- `§6` authoring-revision and runtime-snapshot rows: `scene.revision` remains the
  sole current revision and `<projectId>@r<revision>` remains the snapshot
  identity. M2 adds no new identity, because §18/`workspace.md` §13 require every
  observable content change to advance `scene.revision` in the same atomic
  envelope write.
- `§7` manifest: still `schemaVersion` 1, still immutable during editing.
- `§9`–`§11` entity/hierarchy/deletion semantics: unchanged for `schemaVersion` 1;
  the v2 registry is a superset (§18) and packet 20 owns any v2 additions beyond
  the `model` reference.
- `§12.4` M1 `migrate*` identity behavior: unchanged (A9 adds scope prose only).
- `§12.5` error object shape: unchanged; new codes use it as-is.
- `§15`–`§16` default scene and v1 fixture index: unchanged.
- `docs/contracts/dependencies.md` §3 (public-surface rows) is **not** diffed by
  packet 15: the new exports of A6/A14/A15 and `content-storage.md` §14 must be
  recorded there by packet 19's consolidated inventory before packet 20
  implements them. Recorded as a handoff note, not applied here.

---

# Packet 16 additions — prefabs, declared properties and content-component validation

**PROPOSED — pending Gate E.** Appended by packet 16
(`docs/planning/m2-packets.md` §16) to the same diff file. **Packet 15's sections
A1–A15 and §D above are unchanged and remain in force**; every item below is an
addition that applies *on top of* them (each says which packet-15 diff it
follows). Normative text sources: [`../prefabs.md`](../prefabs.md) (§§3–8),
[`../properties.md`](../properties.md) (§§2–4), and
[`commands.md`](commands.md) for the command side.

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

## P16-A. Summary

| # | Destination | Kind | Normative text |
|---|---|---|---|
| P16-A1 | §5.1 "ID syntax" | reword (after packet-15 A2) | this file |
| P16-A2 | §5.2 "Stability and semantics" | insert bullet | this file |
| P16-A3 | §9 "Entity" combinations | insert rows + reword | `../prefabs.md` §3, `../properties.md` §3 |
| P16-A4 | §10 "Component registry" | reword + insert registry row | `../prefabs.md` §3/§8, `../properties.md` §3 |
| P16-A5 | §11.3 "Deletion semantics" | insert bullet | `../properties.md` §10 |
| P16-A6 | §12.2 "Canonical form" rule 4 | insert lines (after packet-15 A7) | `../prefabs.md` §4.1, `../properties.md` §2/§3 |
| P16-A7 | §12.6 "Error codes" | insert rows + reword `limits_exceeded` (after packet-15 A10) | `../prefabs.md` §13, `../properties.md` §13 |
| P16-A8 | §13.1 cross-block composition | insert checks | `../prefabs.md` §3/§8, `../properties.md` §3 |
| P16-A9 | §14 "What is deliberately not in this contract" | insert bullet | this file |
| P16-A10 | §17 "Change rules" | insert bullet | this file |
| P16-A11 | **new §20** | insert section | `../prefabs.md` §§3–8 + `../properties.md` §§2–4 |
| P16-A12 | packet-15 packet text (NOT this file) | change request | `../assets.md` §4.1/§10.2, `../content-storage.md` §3 |

Not changed by packet 16: §6 version taxonomy, §7 manifest, §8 scene fields, §11.1
hierarchy/order, §11.2 cycle rejection, §12.1 entry-point list (packet 20 adds the
new `project-model` exports), §12.3 validation passes/order, §12.4 migration, §12.5
error object shape, §13 checks 1–3, §15 default scene, §16 v1 fixture index.

## P16-B. Existing sections

### P16-A1 — §5.1 "ID syntax" (applies after packet-15 A2)

The packet-15 line already reads `Project IDs, scene IDs, entity IDs, asset IDs
and stage IDs all use one syntax:`. Packet 16 extends it once more:

```diff
-Project IDs, scene IDs, entity IDs, asset IDs and stage IDs all use one syntax:
+Project IDs, scene IDs, entity IDs, asset IDs, stage IDs, prefab IDs, prefab
+local entity IDs and behavior IDs all use one syntax:
```

(`prefabId`, `localId` and `behaviorId` are opaque identifiers of the same lexical
form. `localId` values are copied from source scene entity IDs at capture, so they
share the entity-ID namespace *inside their definition only*; a `localId` is never
a scene reference — see `prefabs.md` §4.3.)

### P16-A2 — §5.2 "Stability and semantics": insert one bullet

Anchor: after packet-15 A3's stage-ID bullet.

```diff
+- **Prefab IDs, local entity IDs and behavior IDs are stable.** A `prefabId` is
+  assigned once at creation, is unique in `content.prefabs` and is never reused
+  (M2 has no prefab deletion). A definition's `localId` values are its source
+  entity IDs, stored verbatim and never reassigned. A `behaviorId` is assigned
+  once per declaration and never reused. None of the three is derived from a
+  display name (`prefabs.md` §4, `properties.md` §5).
```

### P16-A3 — §9 "Entity": component combinations

**(a) Combination table:** append rows

```diff
+| `{ transform, behavior }` | Entity carrying declared-property values for one behavior declaration |
+| `{ transform, box, behavior }` / `{ transform, model, behavior }` | as above, attached to a primitive/model |
```

**(b) Mutual-exclusivity sentence:**

```diff
-`box` and `camera` are **mutually exclusive** on one entity (`component_conflict`).
+`box`, `model` and `camera` are **pairwise mutually exclusive** on one entity
+(`component_conflict`). `behavior` and `prefab` are non-structural: they may
+coexist with one of the three, and `prefab` is written only by
+`instantiatePrefab` (`prefabs.md` §8). Inside a prefab **definition** the
+permitted component set is smaller (`transform`, `box`, `model`, `behavior`) —
+`prefabs.md` §3.
```

### P16-A4 — §10 "Component registry"

**(a) Registry sentence:**

```diff
-The registry for schemaVersion 1 is **exactly** `{ transform, box, camera }`.
+The registry for schemaVersion 1 is **exactly** `{ transform, box, camera }`.
+A `schemaVersion` 2 scene's registry is
+`{ transform, model, box, camera, behavior, prefab }` (packet 15 pinned
+`model`; `behavior` and `prefab` are packet 16's — `properties.md` §3,
+`prefabs.md` §8; packet 20 owns the final registry).
```

**(b) Canonical component key order sentence** (which packet-15 A7 already extends
with the v2 order): insert one line after it:

```diff
+`behavior` and `prefab` are appended in that order; a definition entity never
+carries `camera`/`prefab` (`prefab_component_forbidden`).
```

**(c) New component subsections** (after §10.3 `camera`): insert §10.5
`behavior` and §10.6 `prefab` with normative text from `../properties.md` §3 and
`../prefabs.md` §8 (shapes, canonical key order, defaults, validation codes).

### P16-A5 — §11.3 "Deletion semantics": insert one bullet

Anchor: after the bullet ending `(Future cross-referencing components must define
their own deletion policy in a contract change.)`

```diff
+- **Entity-reference property values (M2).** With `components.behavior` values of
+  declared type `entityRef`, deletion performs one extra check before removing
+  anything: if an `entityRef` value in the scene names an entity inside the
+  deletion closure while its owner is outside the closure, the whole deletion is
+  rejected with `reference_in_use` (`entityIds`, `referencingEntityIds`). Values
+  owned inside the closure are removed with it, so the resulting document still
+  satisfies the no-dangling-reference rule (`properties.md` §10).
```

### P16-A6 — §12.2 rule 4 (applies after packet-15 A7)

Insert after packet-15 A7's content-block lines:

```diff
+   - prefab definition: `prefabId`, `displayName`, `createdRevision`,
+     `entityCount`, `depth`, `entities`; each entity `localId`, `name` (if
+     present), `parentLocalId` (if non-null), `components` (registry order,
+     definition-component subset); `content.prefabs` ascending `prefabId`;
+   - behavior record: `behaviorId`, `displayName`, `declaration`, `source`,
+     `publishedRevision`; `declaration`: `properties`; each property `key`,
+     `label`, `type`, `default`, `min`, `max`, `step`, `maxLength`, `values`,
+     `bounds` (present fields only); `components.behavior.values` in declaration
+     order; `content.behaviors` ascending `behaviorId`;
+   - `content.settings`: ascending key codepoint order.
```

### P16-A7 — §12.6 error-code table (applies after packet-15 A10)

Insert rows after `no_migration_path`/packet-15's rows:

```diff
+| `prefab_reference_missing` | a `components.prefab` value does not resolve to a definition/localId (`prefabs.md` §8) |
+| `prefab_component_forbidden` | a prefab definition entity carries `camera` or `prefab` (`prefabs.md` §3) |
+| `behavior_reference_missing` | a `components.behavior.behaviorId` does not resolve in `content.behaviors` |
+| `property_unknown` | a `components.behavior.values` key is not declared by the resolved declaration (never silently dropped) |
+| `property_type` | a stored or incoming value does not match its declared property type |
+| `property_value` | a value violates its declared range/length/enum/bounds |
+| `setting_unknown` | a `content.settings` key is not declared by the settings registry (packet 17) |
```

and extend the `limits_exceeded` row (which packet-15 A10 already broadened) with
the packet-16 limit values:

```diff
-| `limits_exceeded` | a declared limit is exceeded; the error carries `limit`: … |
+| `limits_exceeded` | a declared limit is exceeded; the error carries `limit`: … plus, in a `schemaVersion` 2 document, `prefabs`, `prefab_entities`, `prefab_depth`, `prefab_bytes`, `behaviors`, `properties`, `enum_values`, `declaration_bytes`, `settings_keys` (`prefabs.md` §5, `properties.md` §4) |
```

### P16-A8 — §13.1 cross-block composition: insert checks

Packet 15's §13.1 already adds the three-block composition with the asset check.
Insert after its check 1:

```diff
+2. every `components.behavior.behaviorId` in the scene **and inside every prefab
+   definition entity** resolves in `content.behaviors`; every stored
+   `components.behavior.values` key is declared by that declaration and
+   type-checks; every `entityRef` value in a scene resolves to an existing scene
+   entity and every `entityRef` value inside a definition resolves to a
+   `localId` of that definition (`behavior_reference_missing`,
+   `property_unknown`, `property_type`, `property_value`, `reference_missing`);
+3. every `components.prefab` value resolves to a definition and a `localId` of
+   it (`prefab_reference_missing`); every definition's `entityCount`/`depth`
+   equal the derived values and its component set is the definition subset
+   (`prefab_component_forbidden`, `limits_exceeded`);
+4. `content.settings` keys are all declared (`setting_unknown`, packet 17's
+   registry);
+5. the existing §13 checks 1–3 (packet-15 numbering: manifest/scene id, implicit
+   single version, workspace-enforced identity) run unchanged.
```

### P16-A9 — §14 "What is deliberately not in this contract": insert bullet

```diff
+- No prefab updates/deletion/variants/nesting, no linked-instance inheritance, no
+  property expressions/computed values/arbitrary object graphs, no component
+  add/remove outside the defined operations, and no behavior source publication
+  or execution (`prefabs.md` §15, `properties.md` §15; packets 18/20/33).
```

### P16-A10 — §17 "Change rules": insert bullet

```diff
+- The packet-16 `schemaVersion` 2 material (new §20; `prefabs.md`/`properties.md`)
+  follows these rules exactly: it is a new known version combination, not a
+  same-version extension of `schemaVersion` 2's packet-15 subset — the packet-15
+  v2 scene/material stays valid (empty `prefabs`/`behaviors`, `{}` settings), and
+  the new element shapes, limits and codes are part of the contract because
+  fixtures and tests reference them.
```

## P16-C. New section

### P16-A11 — new §20 "Prefab definitions, declared properties and content-component validation (scene schemaVersion 2)"

Insert **after** packet-15's §19. Normative text, verbatim:

| New subsection | Text source |
|---|---|
| §20.1 Prefab identity, immutability and copy semantics | `../prefabs.md` §4 |
| §20.2 `PrefabDefinition`/`PrefabEntity` shapes | `../prefabs.md` §4.1 |
| §20.3 Prefab/instantiation limits | `../prefabs.md` §5 |
| §20.4 `components.prefab` (informational provenance) | `../prefabs.md` §8 |
| §20.5 Property type vocabulary, defaults and ranges | `../properties.md` §2 |
| §20.6 `components.behavior` and where schemas/values live | `../properties.md` §3 |
| §20.7 Property/declaration limits | `../properties.md` §4 |
| §20.8 Behavior record (declaration part) and declaration compatibility | `../properties.md` §5.1/§6 |
| §20.9 Settings container, value vocabulary and key registry | `../properties.md` §9 |
| §20.10 Deletion/reference rule for entity references | `../properties.md` §10 |

`project-model`'s pure entry points for this section are the exports listed in
`../prefabs.md` §12 and `../properties.md` §12
(`capturePrefabDefinition`, `instantiatePrefabValue`, `validateDeclaration`,
`declarationAccepts`, `fillPropertyDefaults`, `M2_SETTINGS_KEYS`); the command
side is `commands.md` §8.5–§8.11. Packet 20 must implement §20 without adding a
component add/remove path or a prefab update path.

## P16-D. Change requests against packet 15's text (not applied here)

### P16-A12 — supersession of the reserved-container rule

Packet 15 pins `content.prefabs`, `content.behaviors` and `content.settings` as
**empty in v2** (`assets.md` §4.1: `prefabs`/`behaviors` `[]`, `settings` `{}`;
`assets.md` §10.2 step 6; `content-storage.md` §3). Packet 16 defines non-empty
element shapes for `prefabs` and `behaviors` and a non-empty settings container.
At the Gate E promotion step, the following packet-15 text must be updated in the
same pass (a docs-only change request; the committed packet-15 envelope fixtures
stay valid because an empty container remains valid):

1. `assets.md` §4.1 `ContentCatalog` rows: `prefabs`/`behaviors` gain
   "element shapes per `prefabs.md`/`properties.md`" and `settings` gains
   "typed map per `properties.md` §9", keeping the empty values valid.
2. `assets.md` §10.2 step 6: replace "must be … empty" with the packet-16
   validation order plus the packet-16 container checks.
3. `content-storage.md` §3 `content` row: the parenthetical "(an empty container
   is the only v2-valid value until those packets are accepted)" is replaced by a
   reference to §20.

No other packet-15 statement changes: the version combination, blob/staging
pipeline, publication ordering, caps, migration and backup classification are
untouched by packet 16.

---

# Packet 17 additions — physics-bearing components and the gameplay settings registry

**PROPOSED — pending Gate E.** Appended by packet 17
(`docs/planning/m2-packets.md` §17) to the same diff file. **Packet 15's sections
A1–A15 and packet 16's P16-A1…P16-A12 above are unchanged and remain in force**;
every item below applies *on top of* them (each says which earlier item it
follows). Normative text sources: [`../physics.md`](../physics.md) (§4/§7),
[`../platformer.md`](../platformer.md) (§10), [`../platformer.md`](runtime.md) is
the runtime diff (not this file), and [`../input.md`](../input.md) §1 for unit
ownership.

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

**Physics selection: `@dimforge/rapier2d-compat` at exactly 0.20.0, kinematic
character controller — selection per decision 0002 §1, owner pre-approval
(autonomous M2 build instruction, 2026-09-18); final manual review pending.**
PROVISIONAL until packet 14's desktop evidence and Gate E accept it.

## P17-A. Summary

| # | Destination | Kind | Normative text |
|---|---|---|---|
| P17-A1 | §9 "Entity" combinations (after P16-A3) | insert rows + reword | `../physics.md` §4 |
| P17-A2 | §10 "Component registry" (after P16-A4) | reword + append registry entries | `../physics.md` §4 |
| P17-A3 | §10.7/§10.8 (new component subsections, after P16-A4(c)) | insert | `../physics.md` §4 |
| P17-A4 | §11.3 "Deletion semantics" | insert bullet | `../physics.md` §4 |
| P17-A5 | §12.2 "Canonical form" rule 4 (after P16-A6) | insert lines | `../physics.md` §4 |
| P17-A6 | §12.6 "Error codes" (after P16-A7) | insert rows + reword `limits_exceeded` | `../physics.md` §4/§10 |
| P17-A7 | §13.1 cross-block composition (after P16-A8) | insert check | `../platformer.md` §10 |
| P17-A8 | §14 non-goals | insert bullet | this file |
| P17-A9 | §17 change rules | insert bullet | this file |
| P17-A10 | **new §21** | insert section | `../physics.md` §4, `../platformer.md` §10 |
| P17-A11 | `../properties.md` §9/§12 (NOT this file) | change request: fill the settings registry placeholder | `../platformer.md` §10 |

Not changed by packet 17: §2 coordinate convention (the 2.5D plane rule is
already there), §5 IDs, §6 versions, §7 manifest, §8 scene fields, §11.1/§11.2
hierarchy, §12.1 entry points (packet 20 adds the exports), §12.3 validation
order, §12.4 migration, §12.5 error shape, §13 checks 1–3, §15/§16.

## P17-B. Existing sections

### P17-A1 — §9 "Entity": component combinations (applies after P16-A3)

**(a) Combination table:** append rows

```diff
+| `{ transform, box, collider }` / `{ transform, model, collider }` | Static physics body: the authored collider plus its visual primitive/model |
+| `{ transform, box, controller }` / `{ transform, model, controller }` | The single kinematic character: the marker plus its visual primitive/model |
```

**(b) Conflict sentence** (which P16-A3 already rewrote to name `box`/`model`/
`camera`): extend once more

```diff
-`box`, `model` and `camera` are **pairwise mutually exclusive** on one entity
-(`component_conflict`). `behavior` and `prefab` are non-structural: they may
+`box`, `model` and `camera` are **pairwise mutually exclusive** on one entity
+(`component_conflict`), and `collider` is mutually exclusive with `controller`
+(`component_conflict`). `behavior` and `prefab` are non-structural: they may
```

### P17-A2 — §10 "Component registry" (applies after P16-A4)

**(a) Registry sentence** (quoted as P16-A4 leaves it):

```diff
-`{ transform, model, box, camera, behavior, prefab }` (packet 15 pinned
-`model`; `behavior` and `prefab` are packet 16's — `properties.md` §3,
-`prefabs.md` §8; packet 20 owns the final registry).
+`{ transform, model, box, camera, behavior, prefab, collider, controller }`
+(packet 15 pinned `model`; `behavior`/`prefab` are packet 16's; `collider` and
+`controller` are packet 17's — `physics.md` §4; packet 20 owns the final
+registry and its order).
```

**(b) Canonical component key order** (P16-A4(b) appended `behavior`/`prefab`):
append once more

```diff
+`collider` and `controller` are appended last, in that order. Only the
+`controller` entity may be physics-driven; a `collider` entity is static
+(`physics.md` §3).
```

### P17-A3 — new component subsections §10.7 `collider` and §10.8 `controller`

Insert after P16-A4(c)'s §10.6 `prefab`. Normative text, verbatim:

| Subsection | Text source |
|---|---|
| §10.7 `collider` | `../physics.md` §4 (shape union, box/polygon constraints, canonical key order, mutual exclusivity, limits) |
| §10.8 `controller` | `../physics.md` §4 (empty marker shape, exactly-one rule, capsule constants are contract constants not component fields) |

### P17-A4 — §11.3 "Deletion semantics": insert one bullet

Anchor: after P16-A5's `entityRef` bullet.

```diff
+- **The controller entity cannot be deleted in M2.** A deletion whose closure
+  contains the single `components.controller` entity is rejected with
+  `controller_count_invalid` (the §10.8 exactly-one invariant must hold in
+  every valid document, exactly like the §10.3 camera rule). Removing a
+  `collider` entity is an ordinary deletion; it removes a static body and
+  cannot create a dangling reference (`physics.md` §4).
```
+
+### P17-A5 — §12.2 rule 4 (applies after P16-A6)
+
+Insert after P16-A6's behavior/settings lines:
+
+```diff
+   - `components.collider`: `shape`; `shape`: `type` then `hx`, `hy` (box) or
+     `vertices` (polygon; each vertex `[x, y]` in input order);
+     `components.controller`: `{}` (no fields);
+   - `content.settings`: packet 17's six keys, emitted in ascending key
+     codepoint order (P16-A6's rule already covers the container).
```
+
+### P17-A6 — §12.6 error-code table (applies after P16-A7)
+
+Insert rows after P16-A7's rows:
+
+```diff
+| `collider_shape_invalid` | a `components.collider.shape` is malformed, degenerate, non-convex, has duplicate/too many vertices or exceeds a polygon bound (`physics.md` §4) |
+| `controller_count_invalid` | the scene does not contain exactly one `components.controller` entity, or a deletion would leave a different count (`physics.md` §4) |
+| `physics_transform_unsupported` | a physics-bearing entity is parented, has non-unit scale, is rotated outside the Z axis, or (for `controller`) is not upright; carries `reason`: `parented` / `scale` / `rotation` / `upright` (`physics.md` §4) |
```
+
+and extend the `limits_exceeded` row (which P16-A7 already broadened):
+
+```diff
+| `limits_exceeded` | a declared limit is exceeded; the error carries `limit`: … plus the packet-17 limits `colliders` (256), `collider_vertices` (8 per polygon) and `collider_vertices_total` (1024 per scene) (`physics.md` §4) |
```
+
+### P17-A7 — §13.1 cross-block composition: insert check
+
+After P16-A8's checks, before the existing §13 checks:
+
+```diff
+6. `content.settings` resolves to a valid gameplay settings object:
+   `setting_unknown` for an undeclared key, `field_value` for a value of the
+   wrong type or outside its declared range, and `field_value` at
+   `/settings/min_slope_slide_deg` when `min_slope_slide_deg >
+   max_slope_climb_deg` (new §21.4).
+7. every `components.collider`/`components.controller` entity passes the §21.2
+   physics-transform rules (`physics_transform_unsupported`) and the §21.1
+   count rule (`controller_count_invalid`).
```
+
+### P17-A8 — §14 "What is deliberately not in this contract": insert bullet
+
+```diff
+- No dynamic bodies, joints, sensors, moving or one-way platforms,
+  mesh-derived colliders, character tilt/rotation, multiple characters, Z-axis
+  collisions or Rapier 3D; no collider scaling, per-entity capsule tuning or
+  friction/restitution authoring (`physics.md` §3/§13).
```
+
+### P17-A9 — §17 "Change rules": insert bullet
+
+```diff
+- The packet-17 v2 material (new §21) is additive on top of packets 15/16: the
+  packet-15/16 v2 scene stays valid (no collider/controller entity, `{}`
+  settings), the two new components are appended to the v2 registry without
+  renumbering any existing field, and the component shapes, transform rules,
+  limits and settings registry are contract material because fixtures and
+  acceptance A12/A13 reference their exact values.
```
+
+## P17-C. New section
+
+### P17-A10 — new §21 "Physics-bearing components and the M2 gameplay settings registry (scene schemaVersion 2)"
+
+Insert **after** packet 16's §20. Normative text, verbatim:
+
+| New subsection | Text source |
+|---|---|
+| §21.1 The two components and the exactly-one controller rule | `../physics.md` §4 |
+| §21.2 Physics-transform rules (`parented` / `scale` / `rotation` / `upright`) | `../physics.md` §4 |
+| §21.3 Collider shape vocabulary, polygon constraints, limits and validation order | `../physics.md` §4 |
+| §21.4 The gameplay settings key registry (six keys, types, defaults, ranges, cross-check) | `../platformer.md` §10 |
+| §21.5 Settings resolution (`defaults ⊕ content.settings`, deep-frozen, `setting_unknown`/`field_value`) | `../platformer.md` §10 |
+| §21.6 Capsule/skin/snap/window constants are contract constants, not settings | `../platformer.md` §7/§10 |
+
+The pure `project-model` entry points for this section are
+`validateCollider`, `validateController`, `CONTROLLER_CAPSULE`,
+`M2_SETTINGS_KEYS` and `resolveGameplaySettings` (`../physics.md` §11,
+`../platformer.md` §12). Packet 20 implements §21 without adding a component
+add/remove path, without a second scene mutation path, and without touching
+the accepted §12 validation order.
+
+## P17-D. Change request against packet 16's text (not applied here)
+
+### P17-A11 — supersession of the empty settings-registry placeholder
+
+`../properties.md` §9 currently says the key registry is packet 17's and that
+`M2_SETTINGS_KEYS` is **empty** until Gate E pins it (so `setSettings` can only
+fail), and §12 exports `M2_SETTINGS_KEYS` as the empty placeholder. Packet 17
+fills it (`../platformer.md` §10: six keys). At the Gate E promotion step the
+following packet-16 text must be updated in the same pass (a docs-only change
+request; packet 16's committed fixtures stay valid because they exercise the
+`setting_unknown` path with an undeclared key):
+
+1. `properties.md` §9: replace the "Until Gate E pins that registry,
+   `M2_SETTINGS_KEYS` is **empty**" paragraph with the six-key table, its
+   types/defaults/ranges, the `field_value` failure code for type/range and the
+   cross-key rule (§21.4/§21.5 here).
+2. `properties.md` §12: `M2_SETTINGS_KEYS` gains the table's keys; the
+   placeholder comment is removed.
+3. `properties.md` §16: add the packet-17 settings success fixtures (see
+   packet 17's `fixtures/m2/contracts/physics/numerics.json`
+   `settingsRegistry` and its resolution cases).
+
+No other packet-16 statement changes: the container shape, the settings value
+vocabulary (`number | boolean | string`), the key syntax, the 32-key cap and
+the command/inverse/projection semantics are untouched.

---

# Packet 18 additions — behavior source records, trust acknowledgment and the compilation/publication boundary

**PROPOSED — pending Gate E.** Appended by packet 18
(`docs/planning/m2-packets.md` §18) to the same diff file. **Packet 15's sections
A1–A15, packet 16's P16-A1…P16-A12 and packet 17's P17-A1…P17-A11 above are
unchanged and remain in force**; every item below applies *on top of* them (each
says which earlier item it follows). Normative text source:
[`../behaviors.md`](../behaviors.md) §3/§4/§7/§8, plus
[`runtime.md`](runtime.md) §"Packet 18 additions" and
[`dependencies.md`](dependencies.md).

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** (A pre-approval, not an independent
review.)

## P18-A. Summary

| # | Destination | Kind | Normative text |
|---|---|---|---|
| P18-A1 | §10 "Component registry" (after P17-A2) | insert note | `../behaviors.md` §3 |
| P18-A2 | §12.2 rule 4 (after P17-A5) | insert lines | `../behaviors.md` §3/§7 |
| P18-A3 | §12.3 validation order (after packet 15's A8) | insert two steps | `../behaviors.md` §3.4/§7 |
| P18-A4 | §12.6 "Error codes" (after P17-A6) | insert rows | `../behaviors.md` §4.2 |
| P18-A5 | §13 cross-document validation: insert §13.2 | insert subsection | `../behaviors.md` §3.4/§8.4 |
| P18-A6 | §14 non-goals | insert bullets | `../behaviors.md` §15 |
| P18-A7 | §17 change rules | insert bullets | `../behaviors.md` §12 |
| P18-A8 | **new §22** | insert section | `../behaviors.md` §3–§8 |
| P18-A9 | `../properties.md`, `../content-storage.md`, `../assets.md`, `../commands.md`(diff), `../platformer.md` (NOT this file) | change requests | §P18-D below |

Not changed by packet 18: §2 coordinate convention, §5 IDs (behavior source
paths are **not** model IDs — they live inside the container), §6 versions, §7
manifest, §8/§8.1 scene fields, §9 entity/component combinations (a `behavior`
component's shape is packet 16's), §10.1–§10.8 component subsections, §11
hierarchy/deletion (P16-A5/P17-A4 stand), §12.1 entry points (packet 20 adds the
exports), §12.4 migration, §12.5 error shape, §13.1's packet-15/16/17 checks,
§15/§16.

## P18-B. Existing sections

### P18-A1 — §10 "Component registry" (after P17-A2): insert one note

Anchor: after P17-A2's registry entries, before P17-A3's new subsections.

```diff
+The `behavior` component's payload is packet 16's `{ behaviorId, values }`; it
+is **unchanged** by packet 18. A behavior's *source*, compiler record, manifest
+and trust acknowledgment live in `content.behaviors[i].source` and
+`content.behaviorTrust` (P18-A2/P18-A8) — never in a scene component, never in a
+command argument, never in a component field. The scene therefore cannot address
+code, a digest or a staging handle.
```

### P18-A2 — §12.2 rule 4 (applies after P17-A5)

Insert after P17-A5's `content.settings` line:

```diff
+   - `content.behaviors[i].source` (when non-null): `sourceDigest`,
+     `sourceByteLength`, `entryPath`, `fileCount`, `manifestDigest`,
+     `outputDigest`, `outputByteLength`, `requiredModules` (ascending),
+     `publishedRevision` (P18-A8 §22.2); `source: null` is emitted as `null`
+     (the packet-16 shape is preserved verbatim);
+   - `content.behaviorTrust`: `entries` in ascending `sourceDigest` order, each
+     entry `sourceDigest` then `acknowledgedRevision` (P18-A8 §22.5);
+   - content key order is `assets, prefabs, behaviors, settings, behaviorTrust`
+     (packet 15's order plus one key).
```

### P18-A3 — §12.3 validation order (applies after packet 15's A8)

Insert as new ordered steps **after** the existing content-block steps, so that a
behavior's own shape is checked before any cross-block composition:

```diff
+11. `content.behaviors[i].source` (when non-null) is validated against §22.2:
+    digest syntax (`digest_invalid`), `entryPath` exactly `"src/index.ts"`
+    (`field_value`), `fileCount` 1–16 (`limits_exceeded` `files`),
+    `outputByteLength` 1–131072 (`limits_exceeded` `output_bytes`),
+    `requiredModules` ascending/unique/subset-of-`enginePins`
+    (`behavior_import_unpinned`), `publishedRevision ≥ 1` (`number_out_of_range`).
+    The check never reads the filesystem and never claims a hash of bytes it
+    cannot read (`../behaviors.md` §3.4 item 4).
+12. `content.behaviorTrust` is validated against §22.5: ≤ 64 entries
+    (`limits_exceeded` `trust_entries`), ascending unique digests
+    (`digest_invalid` / `id_duplicate`), `acknowledgedRevision ≥ 0`.
```

### P18-A4 — §12.6 "Error-code table" (applies after P17-A6)

Insert rows after P17-A6's rows:

```diff
+| `behavior_source_invalid` | a behavior source container is malformed or is not canonical: bad `graphVersion`, unknown field, bad path/extension/encoding, unsorted `files`, absent entry file, or a TypeScript syntax error; carries `reason` (`../behaviors.md` §4.2) |
+| `behavior_source_duplicate` | the container declares the same `path` twice (`../behaviors.md` §3.1 rule 5) |
+| `behavior_source_missing` | a relative import resolves to a path that is not in `files`; carries the resolved `path` (`../behaviors.md` §4.2) |
+| `behavior_source_escape` | a relative import resolves above the graph root; carries the resolved `path` (`../behaviors.md` §4.2) |
+| `behavior_source_cycle` | the relative-import graph contains a cycle; carries the cycle path list (`../behaviors.md` §4.2) |
+| `behavior_import_forbidden` | a forbidden import specifier: `reason` `bare` / `node_builtin` / `absolute` / `network` / `engine_value_import` (`../behaviors.md` §4.1/§4.2) |
+| `behavior_import_unpinned` | a `requiredModules` entry (or a `source` record's `requiredModules`) is not in the pinned module set; carries the module ID (`../behaviors.md` §5.3) |
+| `behavior_dynamic_code` | dynamic code generation is present: `reason` `dynamic_import` / `eval` / `function_constructor` / `require` (`../behaviors.md` §4.2) |
+| `behavior_source_limits_exceeded` | a compiler/preparation bound is exceeded: `limit` `files` / `file_bytes` / `graph_bytes` / `import_depth` / `imports` / `owned_transforms` (`../behaviors.md` §6) |
+| `behavior_compile_timeout` | the compile wall-clock bound was exceeded (`../behaviors.md` §6) |
+| `behavior_compile_failed` | the pinned compiler threw; carries a bounded message (`../behaviors.md` §4.2) |
+| `behavior_output_limits_exceeded` | the compiled output exceeds the byte bound: `limit` `output_bytes` (`../behaviors.md` §6) |
+| `behavior_output_forbidden_content` | the compiled output contains a forbidden pattern; carries the first ≤ 4 pattern letters (`../behaviors.md` §5.5) |
+| `behavior_declaration_mismatch` | a stored `source` record is inconsistent with its declaration/manifest/pins: `reason` `digest` / `manifest` / `declaration` / `pins` (`../behaviors.md` §4.2/§8.4) |
+| `behavior_trust_unacknowledged` | the exact `sourceDigest` is not acknowledged in `content.behaviorTrust.entries`; blocks preparation, publication, play and export (`../behaviors.md` §2.3/§7) |
```

and extend the packet-16 `behavior_publication_unavailable` row:

```diff
+| `behavior_publication_unavailable` | `publishBehavior{mode:"source"}` is refused: `reason` `preparer_unavailable` (packet 16, before any stage/digest/validation work) or `preparation_missing` (no prepared artifact for the supplied digest) (`../behaviors.md` §8.3/§8.4) |
```

`limits_exceeded` gains the packet-18 limit names `output_bytes` and
`trust_entries` in its `limit` enumeration (the code and error shape are
packet-16's).

### P18-A5 — §13 "cross-document validation": insert §13.2

After P17-A7's checks (packet 17 wrote them into §13.1's numbering), append a new
subsection:

```diff
+### 13.2 Behavior source, trust and linked-output composition
+
+1. Every `components.behavior.behaviorId` resolves in `content.behaviors`
+   (packet 16's `behavior_reference_missing`), unchanged.
+2. A behavior with `source: null` composes with nothing further: no digest, no
+   trust entry and no prepared artifact is required, and no runtime module is
+   registered for it (`../behaviors.md` §9.1).
+3. A behavior with a non-null `source` requires, in this order:
+   (a) `behavior_trust_unacknowledged` if `source.sourceDigest` has no entry in
+   `content.behaviorTrust.entries`; (b) `behavior_publication_unavailable`
+   (`preparation_missing`) if no prepared artifact for the digest exists in the
+   environment — a *play/export* composition check, not a document check (a
+   document is valid without the derived artifact, exactly as
+   `content-storage.md` §1 treats derived caches); (c) `behavior_declaration_mismatch`
+   if the artifact's manifest does not match the declaration and pins.
+4. `behaviorTrust.entries` entries whose digest matches no behavior record are
+   **allowed** (they are inert history, exactly like an unreferenced blob: they
+   do not make a document invalid and they do not need GC — `../behaviors.md` §7).
+5. `source.publishedRevision` must not exceed the envelope revision
+   (`number_out_of_range`); a record with a future revision is rejected rather
+   than repaired.
```

### P18-A6 — §14 "What is deliberately not in this contract": insert bullets

```diff
+- No behavior source storage format beyond the single canonical source-graph
+  container (P18-A8 §22.1): no multi-file staging protocol, no source
+  directories in the project tree, no globs, no archives and no per-file
+  addresses in any document.
+- No trust, compilation, linking, build or execution semantics for behaviors —
+  those belong to packet 18's diff (`../behaviors.md`) and to the runtime,
+  command, workspace, exporter and UI contracts; this document validates shapes
+  and digests only.
+- No property write-back, no entity mutation and no physics data written by a
+  behavior: the scene is authored data and stays read-only at play time
+  (`runtime.md` §4/§10).
```

### P18-A7 — §17 "Change rules": insert bullets

```diff
+- The packet-18 v2 material (new §22) is additive on top of packets 15/16/17:
+  `source` keeps packet 16's canonical key order and gains a value shape,
+  `content.behaviorTrust` is appended as a fifth content key, and no existing
+  field is renumbered or reinterpreted. Every v2 envelope fixture gains
+  `"behaviorTrust": { "entries": [] }` in the same promotion step (a recorded
+  change request, `../behaviors.md` §13 C18-8).
+- The source-graph container's rules (version, path grammar, ordering, bounds,
+  the import/dynamic-code taxonomy) are contract material: fixtures and the
+  compiler's codes reference their exact values (`../behaviors.md` §4/§6).
+- A `source` value may be written only by the preparation path
+  (`../behaviors.md` §8.3/§8.4). A change that lets a caller-supplied digest or
+  manifest reach the document is a contract violation, not an implementation
+  detail.
```

## P18-C. New section

### P18-A8 — new §22 "Behavior source records, trust acknowledgment and the compilation/publication boundary (storageVersion 2)"

Insert **after** packet 17's §21. Normative text, verbatim:

| New subsection | Text source |
|---|---|
| §22.1 The canonical source-graph container (`thirdlight-behavior-source` v1: fields, ordering, path grammar, bounds) | `../behaviors.md` §3.1 |
| §22.2 `BehaviorSourceRecord` (field list, canonical order, digest binding, validation, `source: null` semantics) | `../behaviors.md` §3 |
| §22.3 Static source rules and the exhaustive failure taxonomy | `../behaviors.md` §4 |
| §22.4 Compiler resource bounds and the derived-cache class of prepared outputs | `../behaviors.md` §6/§8.4 |
| §22.5 `content.behaviorTrust` and its canonical form | `../behaviors.md` §7 |
| §22.6 The mandatory publication order and the "unavailable until packet 33" state | `../behaviors.md` §8.1/§8.3 |
| §22.7 The two distinct build failures (preparation vs full-snapshot bundle) | `../behaviors.md` §8.7 |

The pure `project-model` entry points for this section are
`parseSourceGraphContainer`, `validateBehaviorSource` and
`BEHAVIOR_SOURCE_LIMITS` (`../behaviors.md` §11). Packet 20 implements §22
without adding a component add/remove path, without a second scene mutation path,
without reading the filesystem in a validator, and without touching the accepted
§12 validation order.

## P18-D. Change requests against other drafts (not applied here)

### P18-A9 — properties / content-storage / assets / commands / platformer

1. `../properties.md` §5.2 and §15: replace "`mode: "source"` fails … **always**"
   with "fails until packet 33's preparation path exists (reason
   `preparer_unavailable`)", and point at `../behaviors.md` §8.3; drop §15's
   "No behavior source publication, compilation, execution, scheduling, intents,
   sandboxing, worker isolation, watchdog or hard timeout (packets 18/33/34)"
   line in favour of "specified in packet 18 (`../behaviors.md`), implemented in
   packets 33–36" (`../behaviors.md` §13 C18-4).
2. `../content-storage.md` §5/§6.1 and `../assets.md` §7: add the
   `kind: "behavior-source"` preparation profile (the §22.1 container staged as
   `source.bin`), the `prepareBehaviorSource` preparation-layer operation, the
   derived-cache class for prepared outputs (regenerable from the immutable
   container blob) and the trust-aware refusal that runs **before** staging
   resolution (`../behaviors.md` §13 C18-1).
3. `../diffs/commands.md` (packet-16 additions): add `acknowledgeBehaviorTrust`
   (args, change/inverse, no-change, bounds) and extend
   `publishBehavior{mode:"source"}` with the `preparation_missing` reason and the
   trust validation step **after** the preparer gate
   (`../behaviors.md` §13 C18-2).
4. `../platformer.md` §2/§2.1/§3/§7: extend the behavior-module inventory row,
   add `readonly intents: IntentSet` to `StepContext` and state the
   effective-input rule; §7's algorithm text is unchanged
   (`../behaviors.md` §13 C18-3).
5. Packet-15 fixtures: `envelope/valid/*.json` and `envelope/invalid/*.json` v2
   envelopes gain `"behaviorTrust": { "entries": [] }` in the same promotion
   step, with `expected.json` notes updated
   (`../behaviors.md` §13 C18-8).
