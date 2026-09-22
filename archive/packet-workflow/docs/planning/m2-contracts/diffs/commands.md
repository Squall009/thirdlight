PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# PROPOSED section-level diffs — `docs/contracts/commands.md`

**PROPOSED — pending Gate E.** Packet 16 (`docs/planning/m2-packets.md` §16)
output. This file contains *no* accepted text: it names the exact destination
sections, gives old → new text for every existing section that changes, and gives
insertion instructions (anchor + normative text source) for new material.

Read with: [`../prefabs.md`](../prefabs.md) (prefabs, instantiation, ID allocation,
`queryPrefabs`), [`../properties.md`](../properties.md) (declared properties,
`publishBehavior`, `setBehaviorProperties`, `setComponent`, `setSettings`,
`queryAssets`/`queryBehaviors`), [`../assets.md`](../assets.md) and
[`../content-storage.md`](../content-storage.md) (packet 15's publication
pipeline, which these ops reuse unchanged), and
[`project-model.md`](project-model.md) §"Packet 16 additions".

Promotion is docs-only, per diff, at Gate E; nothing here is applied by packet 16.
Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.**

Convention: `OLD` is the accepted text exactly as it reads today (shortest unique
quote); `NEW` is the replacement. `+` blocks are pure insertions at the stated
anchor. Accepted section numbers are **never renumbered**: new operations become
§8.5–§8.11; new queries are appended to §4/§5.6; new change types are appended to
§5.3; new error codes are appended to §5.4.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| A1 | §1 "Scope and ownership" | reword two bullets | this file |
| A2 | §2 "The M1 command set" | insert rows + reword non-goals | this file |
| A3 | §3.1 "`args` per operation" | insert subsections §3.1.1–§3.1.7 | `../prefabs.md`, `../properties.md` |
| A4 | §4 "Query request" | insert rows + one bound note | `../prefabs.md` §10, `../properties.md` §11 |
| A5 | §5.1 "Mutation success" | insert note | this file |
| A6 | §5.3 "`change` data" | insert rows + reword closing sentence | this file |
| A7 | §5.4 "Error codes" | insert rows + reword three rows | `../prefabs.md` §13, `../properties.md` §13 |
| A8 | §5.6 "Query results" | insert bullets | `../prefabs.md` §10, `../properties.md` §11 |
| A9 | §6.1 pipeline steps 5/6 | reword | this file |
| A10 | §6.5 "`no_change`" | reword | this file |
| A11 | §7.1 "Retry records" | insert bullet | this file |
| A12 | §8.1 "`createEntity`" | insert paragraph | `../prefabs.md` §7.2 |
| A13 | §8.3 "`deleteEntity`" | insert step | `../properties.md` §10 |
| A14 | §8.4 "`undo` / `redo`" | insert bullet | `../prefabs.md` §7.6 |
| A15 | §9.1 "Structure" (inverse specs) | insert items | `../prefabs.md` §6.4/§7.6, `../properties.md` §7/§8/§9 |
| A16 | new §8.5–§8.11 | insert subsections | `../prefabs.md` §6/§7, `../properties.md` §5/§7/§8/§9 |
| A17 | §11 "What is deliberately not in M1" | reword bullets | this file |
| A18 | §12 "Fixture index" | insert rows | this file |

Not changed (no silent reinterpretation): §3 envelope fields (`op`, `projectId`,
`expectedRevision`, `requestId`, `origin`, `args`) and the `requestId` rules; §4's
"queries are read-only" rule; §5.1's fixed field list and canonical key order;
§5.2's failure envelope shape; §6.2/§6.3/§6.4/§6.6 (reuse, digest, stale
recovery); §7.1 retention bound 128 and record shape; §7.2/§7.3 (restart-safe
retry, `write_failed`); §9.2 reset boundaries; §9.3 mixed-origin history; §9.4
defensive failure; §10 serialization/concurrency.

---

## B. Existing sections

### A1 — §1 "Scope and ownership"

**(a) Owned list:**

```diff
-- The M1 command set and per-operation semantics, including backend-assigned
-  creation IDs, subtree deletion, and undo/redo with mixed human/agent
-  history.
+- The M1 command set and per-operation semantics, including backend-assigned
+  creation IDs, subtree deletion, and undo/redo with mixed human/agent
+  history — extended by packets 15–18 with the M2 content operations
+  (`publishAsset`, `createPrefab`, `instantiatePrefab`, `publishBehavior`,
+  `setBehaviorProperties`, `setComponent`, `setSettings`) and the bounded
+  content queries (`queryAssets`, `queryPrefabs`, `queryBehaviors`). Every new
+  operation runs the same §6.1 pipeline, the same §6.2/§6.3 dedup/retry rules
+  and the same §7 retry-record retention; they add no second mutation path.
```

**(b) Not-owned bullet** (the last one):

```diff
-- Renames, reordering, settings, or any other M1+ command — deliberately not
-  M1 (project-model §14).
+- Renames, reordering, multi-entity batches, or any other command outside
+  §2's table — deliberately not in this contract (project-model §14). Settings
+  edits, component edits and prefab operations are now §8.5–§8.11; asset
+  bytes/staging/publication storage remain `workspace.md`/packet 15's.
```

### A2 — §2 "The M1 command set"

**(a) Table:** append rows after `| queryEntities | query | Paged entity list in document order | — |`

```diff
+| `publishAsset` | mutation | Create an asset record or append one immutable `AssetVersion` (packet 15's delegated content mutation) | +1 |
+| `createPrefab` | mutation | Capture one selected subtree (excluding the required camera) as an immutable definition | +1 |
+| `instantiatePrefab` | mutation | Materialize one definition as an independent copy: one transaction, deterministic ID allocation, recorded remap | +1 |
+| `publishBehavior` | mutation | Create/update a behavior **declaration** (`mode: "source"` is unavailable — §8.11) | +1 |
+| `setBehaviorProperties` | mutation | Attach, update or remove one entity's `components.behavior` declared-property values | +1 |
+| `setComponent` | mutation | Typed partial edit of one owned component (`box`, `camera`, `model`) | +1 |
+| `setSettings` | mutation | Typed edit of the bounded `content.settings` map | +1 |
+| `queryAssets` | query | Paged asset-catalog summaries (optional versions) | — |
+| `queryPrefabs` | query | Paged prefab-definition summaries (optional full definitions) | — |
+| `queryBehaviors` | query | Paged behavior summaries (optional declarations) | — |
```

**(b) Non-goals paragraph:**

```diff
-M1 excludes (normative non-goals): rename, reorder, camera creation (a valid
-M1 scene always contains exactly one camera, project-model §10.3), settings
-edits, multi-entity batches, and scene selection (single scene, project-model
-§3).
+This contract excludes (normative non-goals): rename, reorder, camera
+creation (a valid scene always contains exactly one camera, project-model
+§10.3), arbitrary multi-entity batches, scene selection (single scene,
+project-model §3), prefab update/delete/variants/nesting, behavior **source**
+publication (§8.11), structural component add/remove, and any general
+JSON-Patch/eval/batch API. Where one operation cannot express a required
+transaction, the operation itself is defined as one transaction (for example
+`instantiatePrefab`), never a client-side batch.
```

### A3 — §3.1 "`args` per operation"

Insert seven subsections after the `**`undo` / `redo`** — `args: {}` (exactly the
empty object).` bullet. Normative text:

| New subsection | Text source |
|---|---|
| §3.1.1 `publishAsset` | `../content-storage.md` §6.1 (the delegated authoritative row), `../assets.md` §4/§5/§10 |
| §3.1.2 `createPrefab` | `../prefabs.md` §6.1 |
| §3.1.3 `instantiatePrefab` | `../prefabs.md` §7.1 |
| §3.1.4 `publishBehavior` | `../properties.md` §5.1 |
| §3.1.5 `setBehaviorProperties` | `../properties.md` §7 |
| §3.1.6 `setComponent` | `../properties.md` §8 |
| §3.1.7 `setSettings` | `../properties.md` §9 |

Conventions that apply to every new `args` object (already accepted for M1, restated
because the new ops are strict): unknown fields ⇒ `field_unexpected`; missing ⇒
`field_missing`; wrong type ⇒ `field_type`; right type/wrong value ⇒ `field_value`;
the request's canonical bytes must be ≤ 65 536 (`limits_exceeded`
`request_bytes`, checked before argument validation).

Naming reconciliation (semantics unchanged): packet 15's proposal labels the
delegated authoritative content mutation `createAssetVersion`; this contract names
it `publishAsset` with **exactly** packet 15's args
(`{ mode, assetId, displayName?, sourceDigest, sourceByteLength, importRecipe,
metrics }`), its ordering (§6.2 of `content-storage.md`) and its
dedup-before-stage-lookup rule. `mode` is `"create" | "reimport"`; create on an
existing `assetId` is `asset_id_duplicate`, reimport on an unknown one is
`asset_not_found`. Recorded as a naming note for packet 19's consolidated
inventory, not as a semantic diff.

### A4 — §4 "Query request"

Append rows to the `args` table:

```diff
 | `queryEntities` | `limit` (integer 1–1024, default 100); `offset` (integer ≥ 0, default 0) |
+| `queryAssets` | `limit` (integer 1–128, default 50); `offset` (integer ≥ 0, default 0); `includeVersions` (boolean, default `false`); `assetId` (optional) |
+| `queryPrefabs` | `limit` (integer 1–128, default 50); `offset` (integer ≥ 0, default 0); `includeEntities` (boolean, default `false`); `prefabId` (optional) |
+| `queryBehaviors` | `limit` (integer 1–128, default 50); `offset` (integer ≥ 0, default 0); `includeDeclaration` (boolean, default `false`); `behaviorId` (optional) |
```

and append one boundedness sentence after the existing one:

```diff
+Content queries are bounded by the catalog/definition caps as well as by
+`limit` (project-model §18/§20, `prefabs.md` §5): a page never carries more than
+128 summaries, and `includeEntities`/`includeDeclaration` return the exact stored
+values (definition ≤ 256 entities, declaration ≤ 32 properties). Queries never
+return bytes, blobs or a staging handle.
```

### A5 — §5.1 "Mutation success"

Insert one sentence after the fixed-field paragraph:

```diff
+Every new §8.5–§8.11 operation uses this same success payload; `createdId`
+remains `createEntity`-only, and the new ops carry their identity inside `change`
+(`prefabId`/`rootId`, `behaviorId`, `id`/`component`, `assetId`).
```

### A6 — §5.3 "`change` data"

Append rows to the table:

```diff
+| `publishAsset` | `{ type, mode, assetId, previous, next }` — `previous`/`next` are full `AssetRecord` values (`null` on create) | `publishAsset` success; undo/redo of it |
+| `createPrefab` | `{ type, prefabId, definition }` — the full definition value | `createPrefab` success; redo of it |
+| `removePrefab` | `{ type, prefabId }` | undo of a `createPrefab` (never a forward operation) |
+| `instantiatePrefab` | `{ type, prefabId, rootId, entries, mapping }` — full created entity values with their insertion indices and the exact localId→entityId map, definition document order (§8.7) | `instantiatePrefab` success; redo of it |
+| `publishBehavior` | `{ type, behaviorId, previous, next }` — full behavior records (`previous: null` on create) | `publishBehavior` success; undo/redo of it |
+| `setBehaviorProperties` | `{ type, id, previous, next, changedKeys }` — full component values (`null` = absent), `changedKeys` in declaration order | `publishBehavior`-style attach/update/remove; undo/redo of it |
+| `setComponent` | `{ type, id, component, previous, next, changedFields }` — full component values, `changedFields` in canonical field order | `setComponent` success; undo/redo of it |
+| `setSettings` | `{ type, previous, next, changedKeys }` — full settings maps, `changedKeys` in ascending key order | `setSettings` success; undo/redo of it |
```

and reword the closing paragraph:

```diff
-The inverse of every forward change is one of the other rows:
-create↔delete, restore↔delete, setTransform is self-inverse with swapped
-`previous`/`next`.
+The inverse of every forward change is one of the other rows:
+create↔delete, restore↔delete, setTransform is self-inverse with swapped
+`previous`/`next`; `createPrefab`↔`removePrefab`; and
+`setComponent`/`setSettings`/`setBehaviorProperties`/`publishBehavior` are
+self-inverse with swapped `previous`/`next` (a `previous: null` value means the
+component/record did not exist, so undo removes it). `instantiatePrefab`'s
+inverse is the existing subtree `delete` (`{ kind: "delete", rootId }`), and its
+redo re-inserts the recorded `entries` at their recorded indices with their
+recorded IDs — the same LIFO argument as a redo of `createEntity` (§8.4),
+extended to a multi-entity entry.
```

### A7 — §5.4 "Error codes"

**(a)** Insert rows after `| no_change | validation | — | ... |`:

```diff
+| `prefab_not_found` | `validation` | `prefabId` | an operation names a `prefabId` the catalog does not contain |
+| `prefab_id_duplicate` | `validation` | `prefabId` | `createPrefab` names an existing definition (M2 has no prefab deletion, so reuse can never be legitimate) |
+| `prefab_camera_capture_forbidden` | `validation` | `sourceEntityId`, `cameraId` | the captured subtree contains the scene camera |
+| `prefab_nested_forbidden` | `validation` | `sourceEntityId`, `prefabInstanceIds` | the captured subtree contains an entity with `components.prefab` |
+| `prefab_external_reference_forbidden` | `validation` | `sourceEntityId`, `localId`, `key`, `entityId` | a definition `entityRef` value names an entity outside the captured subtree |
+| `prefab_local_unknown` | `validation` | `prefabId`, `localId` | an override names a `localId` the definition does not contain |
+| `prefab_reference_missing` | `validation` | `prefabId`, `localId` | a `components.prefab` value does not resolve in `content.prefabs` |
+| `prefab_component_forbidden` | `validation` | `prefabId`, `localId`, `component` | a definition entity carries `camera` or `prefab` |
+| `behavior_not_found` | `validation` | `behaviorId` | an operation names a `behaviorId` the content block does not contain |
+| `behavior_id_duplicate` | `validation` | `behaviorId` | `declaration-create` names an existing behavior |
+| `behavior_reference_missing` | `validation` | `behaviorId` | a `components.behavior` value does not resolve in `content.behaviors` |
+| `behavior_publication_unavailable` | `unavailable` | `behaviorId`, `mode`, `reason` | behavior **source** publication without the packet-33 digest-bound preparation record (§8.11) |
+| `property_unknown` | `validation` | `behaviorId?`, `key` | an undeclared property key at any entry point (never silently dropped) |
+| `property_type` | `validation` | `key`, `found`, `expected` | a value does not match its declared property type |
+| `property_value` | `validation` | `key`, `found`, `expected` | a value violates its declared range/length/enum/bounds |
+| `property_declaration_incompatible` | `validation` | `behaviorId`, `reason`, `uses` | a declaration update would invalidate existing stored values |
+| `setting_unknown` | `validation` | `key` | a settings key the settings registry (packet 17) does not declare |
+| `reference_in_use` | `validation` | `entityIds`, `referencingEntityIds` | a subtree deletion would dangle an `entityRef` property value from outside the closure |
+| `asset_not_found` | `validation` | `assetId` | a `publishAsset` reimport/unresolved reference names an unknown asset (workspace code reused) |
```

**(b)** Reword three existing rows:

```diff
-| `limits_exceeded` | `validation` | `limit` (`"entities"` \| `"depth"`), `current`, `max` | creation would exceed 1024 entities or depth 32 (project-model §10.4) |
+| `limits_exceeded` | `validation` | `limit`, `current`, `max` | a declared limit is exceeded: `entities`/`depth` (project-model §10.4) or one of the packet-15/16 limits (`assets`, `asset_versions`, `version_records`, `content_bytes`, `source_bytes`, `nodes`, `meshes`, `primitives`, `materials`, `images`, `textures`, `vertices`, `triangles`, `animations`, `animation_channels`, `clip_duration`, `decoded_bytes`; `prefabs`, `prefab_entities`, `prefab_depth`, `prefab_bytes`, `behaviors`, `properties`, `enum_values`, `declaration_bytes`, `settings_keys`, `overrides`, `request_bytes`) |
-| `id_exhaustion` | `internal` | `kind` | no free `<kind>-NNNN` ID (§8.1) |
+| `id_exhaustion` | `internal` | `kind` | no free `<kind>-NNNN` ID for the derived `kind` (`group`/`box`/`model`) in the current scene, including IDs already allocated earlier in the same `instantiatePrefab` transaction (§8.1, §8.7, `prefabs.md` §7.2) |
-| `no_change` | `validation` | — | the mutation would leave the scene byte-identical (§6.5) |
+| `no_change` | `validation` | — | the mutation would leave the durable state byte-identical: **scene and content** canonical bytes, `revision` masked (§6.5) |
```

### A8 — §5.6 "Query results"

Append bullets after the `queryEntities` bullet:

```diff
+- `queryAssets`:
+  `{ ok, projectId, revision, total, offset, limit, assets }` — summaries
+  `{ assetId, kind, displayName, currentVersion, versionCount }` in ascending
+  `assetId` order; with `includeVersions: true` each element adds
+  `versions: [{ version, sourceDigest, sourceByteLength }]` (never bytes, never
+  metrics arrays). `assetId` returns that one record (or `asset_not_found`).
+- `queryPrefabs`:
+  `{ ok, projectId, revision, total, offset, limit, prefabs }` — summaries
+  `{ prefabId, displayName, createdRevision, entityCount, depth }`; with
+  `includeEntities: true` each element is the full `PrefabDefinition`
+  (`prefabs.md` §4.1). `prefabId` returns that one definition (or
+  `prefab_not_found`).
+- `queryBehaviors`:
+  `{ ok, projectId, revision, total, offset, limit, behaviors }` — summaries
+  `{ behaviorId, displayName, propertyCount, hasSource, publishedRevision }`;
+  with `includeDeclaration: true` each element adds the exact `declaration`
+  value (never source bytes). `behaviorId` returns that one record (or
+  `behavior_not_found`).
```

and change the `queryProject` bullet:

```diff
 - `queryProject`: the full normalized manifest (bounded by construction —
   fixed small shape), a scene summary (`sceneId`, `entityCount`, `cameraId`),
-  `history` depths, and `workspace`.
+  a bounded content summary `{ assets, prefabs, behaviors, settingsKeys }`
+  (counts only — never definitions, declarations or byte lengths), `history`
+  depths, and `workspace`.
```

and the query-failure code list:

```diff
 - Query failure: `{ ok: false, projectId?, error }` — no `requestId`; `op`
   echoed when present. Codes: `project_not_found`, `project_unavailable`,
-  `invalid_request`, `field_*`, `entity_not_found`, `limits_exceeded`
-  (only `limit` > 1024, via `field_value`).
+  `invalid_request`, `field_*`, `entity_not_found`, `asset_not_found`,
+  `prefab_not_found`, `behavior_not_found`, `limits_exceeded`
+  (only `limit` > 1024 for `queryEntities`, via `field_value`).
```

### A9 — §6.1 pipeline steps 5 and 6

```diff
-5. **Validation and application (pure).** Validate `args` (§3.1), apply the
-   operation to an in-memory copy of the current scene, then run the
-   project-model scene validation on the *result* document (project-model
-   §12). Any failure ⇒ structured validation error (§5.2); **no state
-   change, no revision change, no write**.
+5. **Validation and application (pure).** Validate `args` (§3.1) — including the
+   65 536-byte request bound — apply the operation to an in-memory copy of the
+   current durable state (scene and, for the content ops of §8.5–§8.11, the
+   envelope's `content` block), then validate the *result*: the accepted
+   project-model scene validation, the content/catalog validation
+   (project-model §18/§20) and the cross-block reference checks. Any failure ⇒
+   structured validation error (§5.2); **no state change, no revision change,
+   no write**.
-6. **No-change check.** If the resulting scene is byte-identical to the
-   current scene (§6.5) ⇒ `no_change`. No state change, no record.
+6. **No-change check.** If the resulting durable state is byte-identical to the
+   current state — canonical scene bytes **and** canonical content bytes, with
+   `revision` masked (§6.5) ⇒ `no_change`. No state change, no record.
```

### A10 — §6.5 "`no_change`"

```diff
-After applying (step 5), compare the current and resulting scenes:
-canonical-serialize both **with `revision` masked to `0`** (project-model
-§12.2 canonical form) and byte-compare. Equal ⇒ `no_change`
-(`cls: validation`). Only `setTransform` can reach this (create/delete
-always change structure; undo/redo always restore a different state, since
-history entries exist only for actual changes). A `no_change` command
-consumes no revision and is not recorded — a client may use it to confirm
-its projection matches the backend.
+After applying (step 5), compare the current and resulting **durable state**:
+canonical-serialize the scene **and** the content block with `revision` masked
+to `0` (project-model §12.2 canonical form) and byte-compare both. Equal ⇒
+`no_change` (`cls: validation`). Structural operations (create/delete,
+`createPrefab`, `instantiatePrefab`) always change the state; the ops that can
+reach `no_change` are `setTransform`, `setComponent`, `setSettings`,
+`setBehaviorProperties` and a byte-identical `publishBehavior`/
+`publishAsset` re-publication. A `no_change` command consumes no revision and is
+not recorded — a client may use it to confirm its projection matches the
+backend.
```

### A11 — §7.1 "Retry records"

Insert one bullet after the "Only **successful** mutations are recorded." bullet:

```diff
+- **Retry-record content is op-agnostic.** The new §8.5–§8.11 operations store
+  their full §5.1 result (including the `instantiatePrefab` mapping, or the
+  `publishAsset` record) in the same single envelope `retry` block with the same
+  128-record bound. A content publication's dedup replay is served **before any
+  staging, blob or catalog lookup** (packet 15 `content-storage.md` §6.1), which
+  is what makes an identical retry survive an expired stage.
```

### A12 — §8.1 "`createEntity`" step 4

```diff
 4. **Placement:** the new entity is appended at the **end** of the
    `entities` array. It is a leaf (no descendants), so appending preserves
    the parent-before-child invariant (project-model §11.1); document order
    is the sibling/display order (new entity = last sibling).
+   The same "smallest free `<prefix>-NNNN`" rule (§8.1 step 2) extends to the
+   multi-entity creation of §8.7: IDs are allocated in definition document
+   order, each choosing the smallest free ID for its **derived** prefix
+   (`model` when the entity carries `model`, else `box` when it carries `box`,
+   else `group`), checking the live scene plus the IDs already allocated earlier
+   in the same transaction. `camera` is never an allocatable prefix
+   (`prefabs.md` §7.2).
```

### A13 — §8.3 "`deleteEntity`"

Insert a new step after step 2 (camera check) and renumber the following steps:

```diff
+2b. **Entity-reference check (new).** If any `entityRef` property value in the
+    scene names an entity inside the closure while its owning entity is
+    **outside** the closure ⇒ `reference_in_use` carrying `entityIds` (the
+    closure) and `referencingEntityIds`; the whole deletion is rejected. Values
+    from inside the closure are fine (both disappear), and a value that names an
+    entity outside the closure is unaffected. This is what keeps the
+    no-dangling-reference invariant true now that references exist beyond parent
+    links (`properties.md` §10).
```

and amend step 3's justification sentence:

```diff
-3. Application: remove all closure members from the `entities` array.
-   M1 cross-entity references are parent links only, and every incoming
-   reference of a deleted entity comes from inside its own subtree
-   (project-model §11.3), so no dangling reference can result.
+3. Application: remove all closure members from the `entities` array.
+   Cross-entity references are parent links plus `entityRef` property values;
+   after step 2b every incoming reference of a deleted entity comes from inside
+   its own subtree (project-model §11.3, extended), so no dangling reference can
+   result.
```

### A14 — §8.4 "`undo` / `redo`"

Insert one bullet before the inverse-validation bullet:

```diff
+- A redo of an `instantiatePrefab` re-inserts the **recorded** `entries` values
+  at their recorded indices with their recorded IDs, exactly like a redo of a
+  create re-inserts the recorded entity value: no ID re-scan, no re-allocation,
+  no new revision beyond the redo's own `+1` (`prefabs.md` §7.6). The
+  corresponding undo is the subtree `delete` of `change.rootId`.
```

### A15 — §9.1 "Structure" (inverse specs)

Append items to the inverse-spec list:

```diff
+- `publishAsset` ⇒ `{ "kind": "publishAsset", "assetId", "restore": <full previous AssetRecord or null> }`.
+- `createPrefab` ⇒ `{ "kind": "removePrefab", "prefabId" }`.
+- `instantiatePrefab` ⇒ `{ "kind": "delete", "rootId" }` (the subtree form; by
+  LIFO the closure is exactly the created entities).
+- `publishBehavior` ⇒ `{ "kind": "publishBehavior", "behaviorId", "restore": <full previous BehaviorRecord or null> }`.
+- `setBehaviorProperties` ⇒ `{ "kind": "setBehaviorProperties", "id", "restore": <full previous BehaviorComponent or null> }`.
+- `setComponent` ⇒ `{ "kind": "setComponent", "id", "component", "restore": <full previous component value> }`.
+- `setSettings` ⇒ `{ "kind": "setSettings", "restore": <full previous SettingsMap> }`.
```

### A16 — new §8.5–§8.11

Insert after §8.4, before §9. Normative text:

| New subsection | Text source |
|---|---|
| §8.5 `publishAsset` | `../content-storage.md` §6.1/§6.2, `../assets.md` §3/§4/§5; naming note in A3 |
| §8.6 `createPrefab` | `../prefabs.md` §6 (args, validation order, forbidden capture contents, result/inverse) |
| §8.7 `instantiatePrefab` | `../prefabs.md` §7 (args, ID allocation, overrides, remapping, validation order, result, exact-ID redo/retry) |
| §8.8 `publishBehavior` | `../properties.md` §5 (declaration modes, §5.2 unavailable source mode, validation order, result/inverse) |
| §8.9 `setBehaviorProperties` | `../properties.md` §7 |
| §8.10 `setComponent` | `../properties.md` §8 |
| §8.11 `setSettings` | `../properties.md` §9 |

Each subsection must state, in the promoted text: its `args` table, its normative
validation order, its result/`change` shape, its inverse, its `no_change`
reachability, its error codes, and (for `instantiatePrefab`) the atomic
all-or-nothing rule and the deterministic ID rule. The Bounds tables live in
`prefabs.md` §5 and `properties.md` §4 and are normative for these subsections.

### A17 — §11 "What is deliberately not in M1"

```diff
-- No rename, reorder, batch/multi-entity commands, or settings edits
-  (project-model §14; future contract changes).
+- No rename, reorder, arbitrary batch/multi-entity commands (project-model §14;
+  a required transaction is expressed by one op, e.g. `instantiatePrefab`), and
+  no generic JSON-Patch/eval endpoint. Settings, component, property and prefab
+  operations are §8.5–§8.11; prefab update/delete/variants/nesting and behavior
+  source publication remain out of M2.
```

### A18 — §12 "Fixture index"

Append rows to the table:

```diff
+| `fixtures/m2/contracts/commands/prefab-scenario.*` | M1–M10 byte-exact request/result pairs: two independent materialized instances, one legal initial override, ordinary edits, one-undo subtree removal, exact-ID redo and retry, mixed human/MCP history |
+| `fixtures/m2/contracts/commands/prefab-failures.json` | 24 atomic rejection cases + 10 constructed boundaries for §8.5–§8.11 |
+| `fixtures/m2/contracts/commands/queries.json` | `queryProject` content summary, `queryAssets`, `queryPrefabs`, `queryBehaviors` |
+| `fixtures/m2/contracts/tools/check-fixtures.mjs` | re-derives revision/history arithmetic, deterministic ID allocation and remapping from the scenario |
```

---

## C. Change requests recorded (not applied here)

1. **Naming reconciliation (`publishAsset`).** Packet 15's delegated content
   mutation is labelled `createAssetVersion`. Packet 16 names it `publishAsset`
   with identical args/ordering/semantics; packet 19's consolidated inventory must
   carry the single name forward.
2. **`content.prefabs`/`content.behaviors`/`content.settings` supersession.**
   Packet 15 pins those containers as empty in v2 (`assets.md` §4.1/§10.2 step 6,
   `content-storage.md` §3). Packet 16 defines their element shapes (prefabs,
   behavior declarations) and the settings container. The Gate E promotion step
   must update packet 15's text/fixtures in the same pass (see
   `project-model.md` §"Packet 16 additions" P16-A8); the already-committed
   packet-15 envelopes remain valid because an empty container stays valid.
3. **`dependencies.md` §3 public-surface rows** for the new exports
   (`prefabs.md` §12, `properties.md` §12) are packet 19's consolidated
   inventory, not this diff.
