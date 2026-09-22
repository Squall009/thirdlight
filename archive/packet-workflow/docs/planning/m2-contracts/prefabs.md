PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Thirdlight — Prefab Definitions, Capture and Materialized Instantiation

**PROPOSED — pending Gate E.** Packet 16 output
(`docs/planning/m2-packets.md` §16). Companion documents:

- [`properties.md`](properties.md) — declared properties, behavior declarations,
  `setComponent`/`setBehaviorProperties`/`setSettings`, bounded content queries.
- [`assets.md`](assets.md), [`content-storage.md`](content-storage.md) — packet 15's
  asset identity/publication pipeline; prefab definitions are stored inside the
  same envelope `content` block and use the same command/durability path.
- [`diffs/commands.md`](diffs/commands.md) — exact section-level changes to the
  accepted `docs/contracts/commands.md`.
- [`diffs/project-model.md`](diffs/project-model.md) §"Packet 16 additions" — the
  model-side registry/validation/error additions.

Nothing in `docs/contracts/` or `docs/decisions/` changes until the Gate E
promotion step. Owner pre-approval: **owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.**

Normative keywords **must**, **must not**, **should**, **may** are used in the
RFC 2119 sense.

---

## 1. Scope and ownership

This contract owns:

- The `PrefabDefinition`/`PrefabEntity` logical records stored in
  `content.prefabs` (including their immutability, bounds and canonical order).
- The `createPrefab` and `instantiatePrefab` operations: args, validation order,
  deterministic entity-ID allocation, internal-reference remapping, the durable
  mapping record, inverse/redo/retry semantics and atomic failure.
- The **informational** `components.prefab` provenance component.
- The parts of deletion semantics that entity-reference property values require.
- The `queryPrefabs` query and the `content` summary of `queryProject`.

It does not own:

- Declared property types/values, `components.behavior`, `publishBehavior`,
  `setBehaviorProperties`, `setComponent`, `setSettings`, `queryAssets`,
  `queryBehaviors` — [`properties.md`](properties.md).
- Asset records, source blobs, staging, blob publication, migration —
  packet 15 (`assets.md`, `content-storage.md`).
- The behavior component's non-property fields, behavior execution/compilation —
  packets 18/33.
- The final v2 component registry and any v2 scene field beyond this contract's
  pinned components — packet 20 (this contract pins only what its own semantics
  require; see §3).

| Unit | Proposed ownership |
|---|---|
| `project-model` | `PrefabDefinition`, `PrefabEntity`, `capturePrefabDefinition`, `instantiatePrefabValue` (pure value helpers), the new model codes and `limits_exceeded.limit` values |
| `commands` | the `createPrefab`/`instantiatePrefab` request validation, change/inverse data, ID allocation and remapping |
| `workspace` | the sole executor and durable envelope commit (accepted `runCommand`); no prefab-specific storage |
| `editor`/`mcp-adapter` | projection and UI terms (§12); no direct writes |

## 2. Carried constraints from packet 15 (binding on this contract)

1. **One mutable document.** Prefab definitions live in the envelope's `content`
   block (`content-storage.md` §3) — there is no prefab file, no second catalog,
   no byte parser. Any observable definition change must advance `scene.revision`
   in the same atomic envelope replacement.
2. **Only `manifest 1 + scene 2 + storageVersion 2` is passable.** All prefab
   records exist only in that combination (`content-storage.md` §3.1).
3. **Commands, not file edits.** Definitions are created only by the
   `createPrefab` command through the accepted pipeline; a harness or panel that
   writes files is not an implementation (AGENTS.md: no duplicate mutation paths).
4. **Identifiers are validated data, never paths.** `prefabId` and `localId` use
   project-model §5.1 syntax. No argument and no persisted value is a filesystem
   path, a stage handle or a byte offset.
5. **Durability is the accepted envelope write.** Dedup, revision check, no-change
   check, one atomic envelope replacement, retry record, ack
   (`commands.md` §6.1/§7). Prefabs add no new durability mechanism.
6. **Content is never garbage-collected in M2.** A definition is retained even
   when no instance remains (undo/history/export can pin it).

## 3. Version and registry additions

The **v2 scene component registry** is `transform, model, box, camera, behavior,
prefab` (canonical key order; packet 15 pinned `model`; `behavior` is
`properties.md` §3, `prefab` is §8 here; packet 20 owns the final registry and
any further v2 component). `components.prefab` and `components.behavior` are the
only additions this contract requires.

- `box`, `model` and `camera` remain **pairwise mutually exclusive** on one
  entity (`component_conflict`). `behavior` and `prefab` are non-structural and
  may coexist with one of them.
- A **prefab definition entity** may carry only `transform`, `box`, `model` and
  `behavior`. A `camera` or `prefab` component inside a definition is
  `prefab_component_forbidden` (definitions cannot contain cameras or other
  instances); everything else is `component_unknown`.
- Entity references inside a definition are **local**: a `components.behavior`
  value of declared type `entityRef` must name a `localId` of the same
  definition, or be `null`. Anything else is
  `prefab_external_reference_forbidden` at capture and `reference_missing` when
  validating a persisted definition.

## 4. Identity and immutability

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

### 4.1 `PrefabDefinition` and `PrefabEntity`

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
  components: PrefabComponents; // transform required; box/model/behavior optional; no camera, no prefab
}
```

Canonical key order: `prefabId, displayName, createdRevision, entityCount, depth,
entities`; per entity `localId, name` (if present), `parentLocalId` (if non-null),
`components`; components in registry order (`transform`, `model`, `box`,
`behavior`). `content.prefabs` is emitted in ascending `prefabId` codepoint order;
`entities` keeps definition document order.

## 5. Limits

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

## 6. `createPrefab`

### 6.1 Request

```json
{
  "op": "createPrefab",
  "projectId": "demo-0003",
  "expectedRevision": 4,
  "requestId": "req-60300000000000000000000000000000",
  "origin": { "kind": "browser", "clientId": "browser-demo" },
  "args": {
    "prefabId": "prefab-0001",
    "displayName": "Station Kit",
    "sourceEntityId": "group-0001"
  }
}
```

| Field | Type / constraint | Required |
|---|---|---|
| `prefabId` | ID syntax; not already in `content.prefabs` | yes |
| `displayName` | 1–128 chars, no control chars | yes |
| `sourceEntityId` | existing entity ID in the current scene | yes |

Unknown fields anywhere ⇒ `field_unexpected`; missing ⇒ `field_missing`; wrong
type ⇒ `field_type`; right type/wrong value ⇒ `field_value`.

### 6.2 Validation order (normative, fail-fast)

1. Envelope: request bytes ≤ 65 536 (`request_bytes`), then the accepted
   `args` schema checks.
2. `prefabId` syntax (`id_invalid`) and uniqueness (`prefab_id_duplicate`).
3. `displayName` shape (`field_value`).
4. `sourceEntityId` resolves (`entity_not_found`).
5. **Subtree closure** = the source entity plus all descendants, in scene
   document order (which already satisfies parent-before-child).
6. Forbidden contents (§6.3): camera, prefab instance, external entity reference.
7. Bounds: `entityCount ≤ 256`, `depth ≤ 16`, canonical definition bytes
   ≤ 131 072, `content.prefabs` length ≤ 128.
8. Build the definition value: `localId` = source entity ID; `createdRevision` =
   `expectedRevision + 1`.
9. Resulting-state validation (project-model v2 + content + cross-block) and the
   **no-change check over scene *and* content** (`commands.md` §6.5 extension).
10. Durability write, publish, ack (accepted pipeline).

### 6.3 Forbidden capture contents

The definition is a self-contained materializable value. The following reject
the **whole** operation atomically, before any write:

| Condition | Code | Carries |
|---|---|---|
| the closure contains the scene camera, or any `camera` component | `prefab_camera_capture_forbidden` | `sourceEntityId`, `cameraId` |
| the closure contains any entity with `components.prefab` | `prefab_nested_forbidden` | `sourceEntityId`, `prefabInstanceIds` |
| a `behavior` `entityRef` value in the closure names an entity **outside** the closure | `prefab_external_reference_forbidden` | `sourceEntityId`, `localId`, `key`, `entityId` |

Rationale (normative): a definition that contained the required camera would
make every scene that instantiates it invalid (`camera_count_invalid`); a
definition that contained an instance would be a nested instance (explicitly not
in M2); and an external entity reference cannot be remapped at instantiation, so
it must be rejected rather than silently copied as a scene-local ID that may
disappear. Asset references (`assetRef` values) are global and are **allowed** —
they are remapped by nothing and remain valid because M2 has no asset deletion.

### 6.4 Result, change and inverse

```ts
interface CreatePrefabChange {
  type: 'createPrefab';
  prefabId: string;
  definition: PrefabDefinition;   // full definition value
}
```

- `revision` = `expectedRevision + 1`; the scene is **unchanged** (the content
  block changes, so the mutation is not a `no_change`).
- Inverse (history): `{ kind: 'removePrefab', prefabId }` — undo removes the
  definition; redo re-inserts the **recorded** definition value verbatim (no
  re-capture). A definition that is removed by undo is invisible to instantiation
  and to validation until it is restored.
- `content.prefabs` is re-sorted into ascending `prefabId` order on every write
  (canonical form), so insertion order is never observable.

## 7. `instantiatePrefab`

### 7.1 Request

```json
{
  "op": "instantiatePrefab",
  "projectId": "demo-0003",
  "expectedRevision": 5,
  "requestId": "req-60400000000000000000000000000000",
  "origin": { "kind": "browser", "clientId": "browser-demo" },
  "args": {
    "prefabId": "prefab-0001",
    "parentId": null,
    "transform": { "position": [6, 0, 0] },
    "overrides": [ { "localId": "model-0001", "key": "speed", "value": 7.25 } ]
  }
}
```

| Field | Type / constraint | Required |
|---|---|---|
| `prefabId` | existing definition | yes |
| `parentId` | existing entity ID in the current scene, or `null` | no (default `null`) |
| `transform` | partial transform (accepted project-model §10.1 rules), applied to the **instance root only** | no (default: identity) |
| `overrides` | array ≤ 64 of `{ localId, key, value }`; `(localId, key)` unique | no (default `[]`) |

Only these three things are configurable at instantiation: the root's parent, the
root's transform fields, and declared-property values. There is no structural
override, no per-entity transform override, no component replacement and no
instance naming.

### 7.2 Deterministic entity-ID allocation

Instantiation creates one scene entity per definition entity, in **definition
document order**. For each, the new ID is the **smallest `NNNN` in `0001..9999`**
such that `<prefix>-NNNN` is free in the current scene *and* has not been
allocated earlier in this same command, where the prefix is derived from the
definition entity's components:

| Components | Prefix |
|---|---|
| `model` | `model` |
| else `box` | `box` |
| else | `group` |

This extends the accepted `createEntity` rule (`commands.md` §8.1: backend-assigned,
smallest free `<kind>-NNNN`, deterministic given the current state) to a
multi-entity creation, and it is the *only* ID source for instantiation: the
command never accepts caller-supplied scene IDs. Exhaustion of the prefix's range
is `id_exhaustion` carrying that `kind`; the whole operation fails (no partial
allocation). Deleted IDs may be reassigned later, exactly as in M1 — uniqueness is
per-document.

The first allocated ID is the **instance root** (`rootId`); its `parentId` is
`args.parentId` (absent when `null`).

### 7.3 Declared-property overrides

An override addresses one `components.behavior` value inside one definition
entity: `(localId, key)`.

- `localId` must exist in the definition (`prefab_local_unknown` otherwise).
- The named entity must carry `components.behavior` and `key` must be declared by
  that behavior's declaration (`property_unknown` otherwise).
- `value` must satisfy the declared type/range/length/enum
  (`property_type`/`property_value`) — see `properties.md` §2.
- Duplicate `(localId, key)` pairs are `field_value`.
- An `entityRef` override may name a definition `localId` (remapped like any
  internal reference, §7.4) or an **existing scene entity ID**; anything else is
  `reference_missing`.
- An `assetRef` override must resolve in `content.assets`
  (`asset_reference_missing`).
- Undeclared keys are **never** silently dropped: they fail. The same rule
  applies to a stored value whose declaration no longer exists.

Everything not overridden is materialized from the **definition's recorded
values** (not re-read from the declaration's defaults): an instance copies the
definition, and the definition recorded actual values at capture time.

### 7.4 Remapping (once, recorded, durable)

1. Every definition entity's `localId` is mapped to its newly allocated scene ID.
2. `parentLocalId` → the mapped parent ID (the root → `args.parentId`).
3. Every declared `entityRef` property value inside the definition that names a
   `localId` → the mapped ID. Values that are `null` stay `null`. Overridden
   values are remapped by the same rule when they name a `localId`.
4. Every created entity receives the **informational** provenance component
   `components.prefab = { prefabId, localId }` (§8).
5. The exact mapping is recorded in the durable result, in definition document
   order: `mapping: [{ localId, entityId }]`. It is part of the change data, the
   retry record and the history entry; no separate mapping file exists.

Remapping happens **once**, at instantiation. Later definition changes cannot
alter an instance (definitions are immutable anyway), and later scene edits are
ordinary edits that never re-run the mapping.

### 7.5 Validation order (normative, fail-fast)

1. Envelope: request bytes ≤ 65 536 (`request_bytes`), then the accepted `args`
   schema checks; `overrides.length ≤ 64` (`overrides`).
2. `prefabId` resolves (`prefab_not_found`).
3. `parentId` resolves (`reference_missing`).
4. `transform` fields (project-model §10.1); it is applied to the root entity
   only and is otherwise a normal partial transform.
5. **Overrides** (§7.3) resolve and type-check against the definition's recorded
   behavior components and the current declarations.
6. **Atomic preconditions on the whole operation** (nothing is created if any
   fails): resulting entity count ≤ 1024 (`limits_exceeded` `entities`);
   resulting depth ≤ 32 (`limits_exceeded` `depth`); ID allocation possible for
   every entity (`id_exhaustion`); resulting-state validation
   (project-model v2 + content + cross-block, including `reference_missing` for
   `entityRef` values and `camera_count_invalid` for the scene).
7. **One transaction.** All entries are appended to `entities` at the end in
   definition document order (each new root/last sibling), which preserves the
   parent-before-child invariant. There is no partial expansion: a failure at any
   point in steps 1–6 leaves the scene, content, revision, history and retry map
   byte-identical.
8. Durability write → publish → ack (accepted pipeline).

### 7.6 Result, change, one-undo removal, exact-ID redo and retry

```ts
interface InstantiatePrefabChange {
  type: 'instantiatePrefab';
  prefabId: string;
  rootId: string;                                  // the first allocated ID
  entries: { index: number; entity: EntityV2 }[];  // ascending insertion index, definition order
  mapping: { localId: string; entityId: string }[];// definition document order
}
```

- `entries[i].index` = the pre-insertion `entities` length + `i` (the M1
  "append at the end" placement, `commands.md` §8.1 step 4).
- **One undo removes the entire subtree**: the inverse is
  `{ kind: 'delete', rootId }`, i.e. the accepted `deleteEntity` subtree closure.
  By LIFO, no later command exists when the entry is undone, so the closure is
  exactly the created entities.
- **Redo restores exactly those IDs**: redo re-inserts the recorded `entries`
  values at their recorded indices with their recorded IDs — no ID re-scan, no
  new allocation (`commands.md` §8.4 semantics extended to a multi-entity entry).
- **Retry is an exact replay**: an identical retry returns the recorded result
  with `duplicated: true` before the revision check and before any ID allocation
  (`commands.md` §6.1 step 2), so retries never consume IDs or revisions.
- Undo/redo are ordinary mutations: revision +1, their own `requestId`/record,
  their own `change` (`restoreSubtree` for undo, `instantiatePrefab`/`deleteEntity`
  for redo) and updated history depths. `appliedOf`/`originOfApplied` identify the
  original command and its origin, so mixed human/MCP history is legible.

### 7.7 Worked example (pinned byte-exactly)

`fixtures/m2/contracts/commands/prefab-scenario.messages.json` M4 instantiates
the 4-entity definition above into a 6-entity scene (revision 5) with
`transform.position [6,0,0]` and one override (`model-0001/speed = 7.25`). The
allocated IDs are `group-0002, box-0002, model-0003, model-0004`; the recorded
mapping is the identity of those localIds; `model-0003`'s `target` value is
remapped from `group-0001` to `group-0002`. M5 creates a second, independent
instance (`group-0003, box-0003, model-0005, model-0006`) with the definition's
recorded `speed = 4.5`; the two instances share no entity, no value storage and
no link.

## 8. `components.prefab` (informational provenance)

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

## 9. Execution semantics

- Both operations are ordinary mutations: accepted pipeline `commands.md` §6.1
  steps 1–9 verbatim, under the per-project mutation lock, with dedup before the
  revision check, one atomic envelope write carrying scene **and** content
  **and** retry record, ack after durability.
- **No-change** is evaluated over the whole durable state: byte-identical scene
  **and** content ⇒ `no_change`. `createPrefab` is therefore always a change;
  `instantiatePrefab` always is (it creates entities).
- **Atomic failure.** Every rejection in §6.2/§7.5 returns before the durability
  write; the durable state (scene, content, revision, retry map) is byte-identical.
  No partial subtree is ever created.
- **Content-induced failure of a retried command** (e.g. the declaration a stored
  instance references was removed by an identical-args replay that cannot happen
  under immutability) is not possible in M2: a success record replays without
  revalidation, and every later failure is a normal fresh-command failure.
- History is the accepted in-memory model (`commands.md` §9): one shared stack,
  no per-origin stacks, `history_invalid` if an inverse ever fails validation
  (defensive; the LIFO argument holds).

## 10. Queries

`queryPrefabs` is read-only: no `expectedRevision`/`requestId`, never deduplicated,
never mutating, always served from the last acknowledged state.

| Field | Type / constraint | Required |
|---|---|---|
| `limit` | integer 1–128, default 50 | no |
| `offset` | integer ≥ 0, default 0 | no |
| `prefabId` | when present, return that one definition (or `prefab_not_found`) | no |
| `includeEntities` | boolean, default `false` | no |

Result: `{ ok, projectId, revision, total, offset, limit, prefabs }`. Summaries are
`{ prefabId, displayName, createdRevision, entityCount, depth }`; with
`includeEntities: true` each element is the full `PrefabDefinition`
(≤ 256 entities, bounded by the definition caps). `offset > total` yields an empty
page. Bundle-level bounds: the response never exceeds the definition byte cap plus
its own summary, and a page is at most 128 definitions.

`queryProject` gains one bounded summary object:

```ts
content: { assets: number; prefabs: number; behaviors: number; settingsKeys: number }
```

It carries **counts only** — never definitions, declarations or byte lengths
(those come from the bounded queries or the workspace read operations).

## 11. Ownership, disposal and retention

- The workspace owns the envelope, the commit and the paths; `project-model`
  owns the pure value shapes/helpers; `commands` owns request validation and
  change/inverse data. No panel, MCP tool or harness writes a definition.
- In-memory `undo`/`redo` history is discarded at the accepted boundaries
  (`commands.md` §9.2: process restart, release/reopen, accept/discard of an
  external change). This never affects definitions or instances, which are
  durable.
- Definitions and provenance references are retained for the life of the project
  (no GC in M2, `content-storage.md` §10). Undo of a `createPrefab` removes the
  definition from the durable content block and redo restores the recorded value
  byte-for-byte.
- Module/UI disposal: the editor's prefab panels hold only projected values; a
  closed panel disposes nothing authoritative.

## 12. Public exports (proposed)

`@thirdlight/project-model` (additions; nothing accepted is removed):

```ts
export type { PrefabDefinition, PrefabEntity, PrefabComponents, PrefabProvenanceComponent } from './prefab-types';
export function capturePrefabDefinition(scene: SceneV2, args: { prefabId: string; displayName: string; sourceEntityId: string }): ModelResult<PrefabDefinition>;
export function instantiatePrefabValue(definition: PrefabDefinition, ctx: { scene: SceneV2; parentId: string | null; transform?: PartialTransform; overrides?: PropertyOverride[]; content: ContentCatalog }): ModelResult<InstantiatePlan>;
export interface InstantiatePlan { rootId: string; entries: { index: number; entity: EntityV2 }[]; mapping: { localId: string; entityId: string }[]; }
```

`@thirdlight/commands` (additions to `ERROR_CODES`/types; `applyMutation` remains
the only mutation path):

```ts
export type { CreatePrefabArgs, InstantiatePrefabArgs, PropertyOverride, CreatePrefabChange, InstantiatePrefabChange } from './types';
```

`@thirdlight/editor` projection (packets 27/28): `queryPrefabs` summaries plus the
full definition on demand; the hierarchy shows a "copy" marker from
`components.prefab`; no linked-instance UI exists.

`@thirdlight/mcp-adapter` (packet 25): the same `createPrefab`/`instantiatePrefab`
commands and `queryPrefabs` query over the accepted backend path; no filesystem
bypass.

## 13. Observable failure outcomes

Every row is observable at the transport boundary and leaves the durable state
byte-identical unless stated.

| Class | Observable outcome | Durable effect |
|---|---|---|
| duplicate `prefabId` | `prefab_id_duplicate` | none |
| unknown `prefabId` | `prefab_not_found` (instantiate) | none |
| camera in the captured subtree | `prefab_camera_capture_forbidden` (`cameraId`) | none |
| prefab instance in the captured subtree | `prefab_nested_forbidden` (`prefabInstanceIds`) | none |
| external entity reference in the captured subtree | `prefab_external_reference_forbidden` (`localId`, `key`, `entityId`) | none |
| unknown override/localId | `prefab_local_unknown` | none |
| undeclared property key | `property_unknown` | none |
| wrong property type/value | `property_type` / `property_value` | none |
| entity reference that does not resolve | `reference_missing` | none |
| asset reference that does not resolve | `asset_reference_missing` | none |
| prefab/scene count, depth or byte limit | `limits_exceeded` (`limit`, `current`, `max`) | none |
| ID range exhausted | `id_exhaustion` (`kind`) | none |
| request payload over 65 536 B | `limits_exceeded` (`request_bytes`) | none |
| stale `expectedRevision` | `revision_conflict` (`currentRevision`) | none |
| reused `requestId` with different content | `request_id_reused` | none |
| identical retry | `duplicated: true` replay at the recorded revision | none |
| delete of a subtree referenced from outside | `reference_in_use` (`referencingEntityIds`) | none |
| validation of the resulting scene/content | the model codes inside `error.details` | none |
| write failure | accepted `write_failed` semantics | old/new envelope per accepted table |

## 14. Compatibility and change rules

- Both operations are **new** ops; no accepted M1 behavior changes. `createEntity`
  keeps its own rule; §7.2 extends the same rule to a multi-entity creation.
- Changing the `PrefabDefinition` shape, a limit, the prefix-derivation table, the
  remap rule or the provenance shape is a reviewed contract change
  (`storageVersion` bump where it changes meaning; no same-version extension).
- Adding a prefab-editing or -deletion operation requires: a definition-update
  compatibility rule analogous to `properties.md` §6.4 (never silently drop
  values), a never-reuse rule for `prefabId`, and an explicit policy for live
  `components.prefab` references. None of that is M2.
- Fixture bytes and expected codes are part of the contract; changing one requires
  the same review as the contract text.
- The packet-15 statement that `content.prefabs` is `[]` in v2
  (`assets.md` §4.1/§10.2 step 6) is **superseded** by this contract and must be
  updated in the same Gate E promotion step (recorded as a change request in
  `diffs/project-model.md` §"Packet 16 additions" P16-A8).

## 15. What is deliberately not in M2

- No linked instances, live inheritance, variants, nesting, automatic propagation,
  apply/revert overrides, structural overrides, prefab update/patch operations,
  prefab deletion, prefab renaming, or per-instance component replacement.
- No per-entity transform override at instantiation beyond the explicit root
  transform; no instance naming; no instance ID.
- No cross-scene prefab references (single scene, accepted).
- No prefab binary/parametric generation, no mesh merging, no geometry baking.
- No filesystem access: definitions are validated data, never paths or file reads.

## 16. Fixture index (packet 16 additions)

All under `fixtures/m2/contracts/` (one checker, one index; packet 15's fixtures
are unchanged):

| Fixture | Pins |
|---|---|
| `commands/prefab-scenario.before.json` | the v2 start state (revision 2, two model references, one box, camera under a root group) |
| `commands/prefab-scenario.messages.json` | M1–M10 byte-exact request/result pairs: declaration publication, behavior attach, prefab capture, two independent instances with one legal initial override, ordinary component edit, one-undo subtree removal, exact-ID redo, exact-ID retry, mixed browser/MCP history |
| `commands/prefab-scenario.after.json` | the durable state after M10, deep-equal to the checker's replay |
| `commands/prefab-failures.json` | 24 atomic rejection cases (§13 + nested/camera/external capture, incompatible declaration update, unavailable source publication, `reference_in_use`, `no_change`, stale/reused requests) and 10 constructed count/byte/depth/ID boundaries |
| `commands/queries.json` | bounded `queryProject`/`queryAssets`/`queryPrefabs`/`queryBehaviors` examples against the after envelope |
| `tools/check-fixtures.mjs` | re-derives revision/history arithmetic, deterministic ID allocation, remapping, closure/restore equality and the final state; verifies codes/pins |
