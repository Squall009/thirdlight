# Thirdlight — Command Contract

Version: 0.1 (normative, pending Gate A acceptance) · Packet 02 · 2026-09-17
Scope: M1 command set — `createEntity`, `setTransform`, `deleteEntity`, `undo`,
`redo`, and bounded queries. Request/result schemas, revision and retry
semantics, change/inverse data, history rules, and failure behavior.

Companion documents (same packet, review together):

- `docs/contracts/workspace.md` — on-disk envelope, durability, ownership,
  external-change handling (this document is normative for command semantics;
  workspace.md is normative for what is durable and how).
- `docs/contracts/project-model.md` v0.2 — the logical scene/manifest this
  contract mutates. Its validation codes, limits, hierarchy rules, and
  deletion semantics (§11.3) are reused, not redefined, here.
- Fixtures: `fixtures/commands/` (machine-readable index:
  `fixtures/commands/expected.json`).

Normative keywords **must**, **must not**, **should**, **may** are used in
the RFC 2119 sense. "The backend" means the single Thirdlight backend
process for the affected project (workspace.md §6: one live owner at a
time).

> Booleans appear in this protocol (queries, error payloads). The
> project-model "M1 uses no booleans" rule (§4) applies to **persisted
> authoring documents** only; transient protocol messages are not persisted
> documents.

---

## 1. Scope and ownership

This contract owns:

- The exact wire shape of M1 mutation requests and query requests, and of
  their results and structured errors.
- Revision checking, request deduplication/retry semantics, and the
  retry-record content and retention bounds (their durable *storage* is
  workspace.md §4).
- The M1 command set and per-operation semantics, including backend-assigned
  creation IDs, subtree deletion, and undo/redo with mixed human/agent
  history — extended by packets 15–18 with the M2 content operations
  (`publishAsset`, `createPrefab`, `instantiatePrefab`, `publishBehavior`,
  `setBehaviorProperties`, `setComponent`, `setSettings`) and the bounded
  content queries (`queryAssets`, `queryPrefabs`, `queryBehaviors`). Every new
  operation runs the same §6.1 pipeline, the same §6.2/§6.3 dedup/retry rules
  and the same §7 retry-record retention; they add no second mutation path.
- Change/inverse data shapes.
- The per-project serialization rule and the no-partial-change guarantee.

This contract does **not** own:

- Filesystem layout, the authoring-state envelope, atomic writes, crash
  recovery, ownership, external-change detection — workspace.md.
- Logical document shapes, validation codes, limits — project-model.md.
- Transport framing, authentication, session IDs, notification channels —
  packet 03 (`docs/contracts/sessions.md`). This contract defines payloads;
  packet 03 decides how they are carried (HTTP/WS/MCP) and who may send them.
- Renames, reordering, multi-entity batches, or any other command outside
  §2's table — deliberately not in this contract (project-model §14). Settings
  edits, component edits and prefab operations are now §8.5–§8.11; asset
  bytes/staging/publication storage remain `workspace.md`/packet 15's.

## 2. The M1 command set

| Op | Kind | Effect | Revision |
|---|---|---|---|
| `createEntity` | mutation | Append one new entity (`group`, `box` or `model`), optionally with the add-capable components of §3.1 | +1 |
| `setTransform` | mutation | Replace any non-empty subset of one entity's transform fields | +1 |
| `deleteEntity` | mutation | Remove one entity **and its entire subtree** (project-model §11.3) | +1 |
| `undo` | mutation | Apply the inverse of the most recent history entry | +1 |
| `redo` | mutation | Re-apply the most recent undone history entry | +1 |
| `queryProject` | query | Bounded project summary (no entity payloads) | — |
| `queryEntity` | query | One entity, its ancestry, its children, optional subtree | — |
| `queryEntities` | query | Paged entity list in document order | — |
| `publishAsset` | mutation | Create an asset record (`kind: "model" | "audio"`) or append one immutable `AssetVersion` (packet 15's delegated content mutation) | +1 |
| `applySurfacePreset` | mutation | Copy one built-in primitive preset's five surface values onto an entity, one undoable edit | +1 |
| `setGameConfig` | mutation | Create, partially edit or remove the bounded `content.game` block | +1 |
| `createPrefab` | mutation | Capture one selected subtree (excluding the required camera) as an immutable definition | +1 |
| `instantiatePrefab` | mutation | Materialize one definition as an independent copy: one transaction, deterministic ID allocation, recorded remap | +1 |
| `publishBehavior` | mutation | Create/update a behavior **declaration** (`mode: "source"` is unavailable — §8.11) | +1 |
| `setBehaviorProperties` | mutation | Attach, update or remove one entity's `components.behavior` declared-property values | +1 |
| `setComponent` | mutation | Typed partial edit, add or remove of one owned component (`box`, `camera`, `model`, `collider`, `controller`, `gameZone`, `playerSpawn`, `cameraFollow`, `light`, `surface`, `modelAnimation`) | +1 |
| `setSettings` | mutation | Typed edit of the bounded `content.settings` map | +1 |
| `acknowledgeBehaviorTrust` | mutation | Record one acknowledged behavior `sourceDigest` in `content.behaviorTrust` | +1 |
| `queryAssets` | query | Paged asset-catalog summaries (optional versions; each summary carries `kind`) | — |
| `queryGameConfig` | query | The full `content.game` block or `null` | — |
| `querySettings` | query | The explicit and resolved gameplay settings maps at one revision | — |
| `queryPrefabs` | query | Paged prefab-definition summaries (optional full definitions) | — |
| `queryBehaviors` | query | Paged behavior summaries (optional declarations) | — |

This contract excludes (normative non-goals): rename, reorder, camera
creation (a valid scene always contains exactly one camera, project-model
§10.3), arbitrary multi-entity batches, scene selection (single scene,
project-model §3), prefab update/delete/variants/nesting, behavior **source**
publication (§8.11), structural component add/remove for
`box`/`camera`/`model` (the physics and M3 components do support add/remove,
§8.10), and any general
JSON-Patch/eval/batch API. M3 adds: no new `createEntity` kind (the union stays
the closed `{"group","box","model"}` — zones/spawns/lights/surfaces/animation
profiles are components, commands.md §8.10), no game-config side document, no
command other than `setGameConfig` may write `content.game`, no asset deletion
or GC, and no script, expression, HTML or URL field. Where one operation cannot express a required
transaction, the operation itself is defined as one transaction (for example
`instantiatePrefab`), never a client-side batch. There is no per-message protocol version field in M1; this document's
version is the protocol version, and extensions require a reviewed contract
diff (AGENTS.md: accepted contracts are binding).

Queries are read-only: they carry no `expectedRevision`/`requestId`, never
mutate state, and are never deduplicated. They observe the **last
acknowledged** in-memory state (a query can never observe a mutation whose
ack has not been sent — workspace.md §5).

## 3. Mutation request

```json
{
  "op": "setTransform",
  "projectId": "demo-0001",
  "expectedRevision": 4,
  "requestId": "req-9f2c8a1d3b4e5f60718293a4b5c6d7e8",
  "origin": { "kind": "mcp", "clientId": "pi-harness" },
  "args": {
    "entityId": "box-0001",
    "transform": { "position": [1.5, 0.25, 0] }
  }
}
```

| Field | Type / constraint | Required |
|---|---|---|
| `op` | exactly one of the five mutation ops | yes |
| `projectId` | project-model ID syntax (§5.1 there) | yes |
| `expectedRevision` | integer, `0 ≤ v ≤ 2^53−1` (project-model §6) | yes |
| `requestId` | `^req-[0-9a-f]{32}$` — `req-` + 32 hex chars (128 random bits from a CSPRNG, client-generated) | yes |
| `origin` | `{ "kind": "browser" \| "mcp" \| "admin", "clientId": string 1–128, no control chars }` | no (absent ⇒ recorded as `null`) |
| `args` | op-specific object, strict (unknown fields ⇒ `field_unexpected`) | yes |

`requestId` rules:

- A client generates a fresh `requestId` for each **logical** command
  attempt and reuses the same value when retrying that attempt.
- 128 random bits make accidental collision negligible; if a collision ever
  occurs, the content check (§6.2) turns it into a structured
  `request_id_reused` error, never a silent replay of a different command.
- `requestId` is echoed back in every result for that request.

Strictness mirrors the data contract: unknown fields at any level of the
request or of `args` fail with `field_unexpected` (nothing is silently
dropped); missing required fields fail with `field_missing`; wrong JSON
types fail with `field_type`; right type, wrong value fails with
`field_value`. All four carry `path` (JSON Pointer into the request),
`found`, and `expected`.

### 3.1 `args` per operation

**`createEntity`**

| Field | Type / constraint | Required |
|---|---|---|
| `kind` | `"group"` \| `"box"` \| `"model"` (no `"camera"` — §2) | yes |
| `parentId` | existing entity ID in the current scene, or `null` | no (default `null`) |
| `name` | display name, 1–128 chars, no control chars | no |
| `transform` | partial transform: any non-empty subset of `position` (3 finite numbers, `|v| ≤ 1e6`), `rotation` (4 finite numbers, `|‖q‖−1| ≤ 1e-4`), `scale` (3 finite numbers, `0 < v ≤ 1e6`) — project-model §10.1 | no (default: identity) |
| `box` | `{ "size": 3 finite numbers `0 < v ≤ 1e6`?, "material": { "color": `^#[0-9a-fA-F]{6}$`? }? }` (project-model §10.2) — **only when `kind` is `"box"`** | no (default: unit box, `#b0b0b0`) |
| `model` | `{ "asset": { "assetId": <existing `content.assets` record> } }` (project-model §18.1/§20.2) — **only when `kind` is `"model"`**; the reference must resolve, else `asset_reference_missing` (§8.1 step 1) | yes when `kind` is `"model"` |
| `components` | object; keys ⊆ `{ "collider", "controller", "gameZone", "playerSpawn", "cameraFollow", "light", "surface", "modelAnimation" }`; each value is the corresponding §8.10 add value (never `null`); at most 8 keys | no |
| `surfacePreset` | `"matte-ground" | "hazard" | "beacon"`; only with `kind` ∈ `{box, model}` and not together with `components.surface` | no |

**`setTransform`**

| Field | Type / constraint | Required |
|---|---|---|
| `entityId` | existing entity ID in the current scene | yes |
| `transform` | partial transform as above, **at least one field present** (an empty object ⇒ `field_value`) | yes |

A present field **replaces** the whole field (arrays are not merged
component-wise). Absent fields are unchanged.

**`deleteEntity`** — `args: { "entityId": <existing entity ID> }`.

**`undo` / `redo`** — `args: {}` (exactly the empty object).

**§3.1.1 `publishAsset`** — `args: { mode, assetId, kind?, displayName?,
 sourceDigest, sourceByteLength, importRecipe, metrics, importedAt, animation? }`;
 `mode` is `"create" | "reimport"`; `kind` is `"model" | "audio"`, **required on
 `create`** (`field_missing`) and, on `reimport`, optional but if present must
 equal the record's `kind` (`asset_kind_mismatch`) — it is fixed at create
 (`authoring.md` §A3.5, packet 39's discriminator). `importRecipe`/`metrics` are
 the profile-matched shapes of `project-model` §18.5/§18.6 (the `pcm-wav`
 member is packet 41's, `presentation.md` §41.4.3). `animation` is the atomic
 reimport mapping of CMD41-2. `create` on an existing `assetId` ⇒
 `asset_id_duplicate`, reimport on an unknown one ⇒ `asset_not_found`;
 `importedAt` is a required project-model §7.2 timestamp (the pure layer has no
 clock — the caller supplies it); the args are **stage-free** (durable,
 digest-addressed facts only). On `reimport` a supplied `displayName`
 **replaces** the record's display name (absent ⇒ the existing name is kept); on
 `create` an absent `displayName` defaults to the `assetId`. Full
 order/dedup/inverse semantics: §8.5.
`kind` is `"model" | "audio"`, **required** on `mode: "create"` and optional on
`mode: "reimport"` where it must equal the record's kind (`asset_kind_mismatch`
otherwise). The kind binding is immutable (project-model §23.3.7). **CC-45-4
(promoted at Gate L):** on a `storageVersion` 1/2 state an absent `kind` on
`create` defaults to `"model"` (the committed M2 fixtures predate the
discriminator); on a v3 (`storageVersion` 3) state it is **required**
(`field_missing`).

**§3.1.2 `createPrefab`** — `args: { prefabId, displayName, sourceEntityId }`;
 `prefabId` must not already exist; `sourceEntityId` must exist. Full semantics:
 §8.6.

**§3.1.3 `instantiatePrefab`** — `args: { prefabId, parentId?, transform?,
 overrides? }`; `overrides` is ≤ 64 `{ localId, key, value }` with unique
 `(localId, key)`. Full semantics: §8.7.

**§3.1.4 `publishBehavior`** — `args: { behaviorId, displayName, mode,
 declaration, source? }`; `mode ∈ { declaration-create, declaration-update,
 source }`; `source` only with `mode: "source"`. `mode: "source"` is unavailable
 in M2 (see §8.8).

**§3.1.5 `setBehaviorProperties`** — `args: { entityId, behaviorId, values? }`;
 `values` is the declared-property map (or absent to remove the component). Full
 semantics: §8.9.

**§3.1.6 `setComponent`** — `args: { entityId, component, value }`; `component ∈
 { box, camera, model, collider, controller, gameZone, playerSpawn, cameraFollow,
 light, surface, modelAnimation }` (it never accepts `transform`, `behavior` or
 `prefab`). Full semantics: §8.10.

**§3.1.7 `setSettings`** — `args: { settings }`; a typed partial map over the six
 declared keys. Full semantics: §8.11.

**§3.1.8 `acknowledgeBehaviorTrust`** — `args: { sourceDigest }`; records one
 acknowledgment entry. Full semantics: §8.12.
**§3.1.9 `applySurfacePreset`** — `args: { entityId, preset }`;
`preset ∈ { "matte-ground", "hazard", "beacon" }`. Full semantics: §8.13.

**§3.1.10 `setGameConfig`** — `args: { game }`; `game` is `null` (remove), a
complete `GameConfig` (create when the block is `null`), or a non-empty partial
object of its top-level fields (edit). Full semantics: §8.14.

**§3.1.11 `queryGameConfig`** — `args: {}`; returns the full `content.game`
block or `null` (authoring.md §A6).

**§3.1.12 `querySettings`** (M4, C64-1) — `args: {}` (absent or empty; any
other field ⇒ `invalid_request`). Returns the gameplay settings **values**
at the current revision, the only source of settings values:

```json
{ "ok": true, "projectId": "demo-0003", "revision": 26,
  "explicit": { "run_speed": 5 },
  "resolved": { "gravity_y": -19.62, "run_speed": 5, "jump_velocity": 7,
                "max_fall_speed": -30, "max_slope_climb_deg": 45,
                "min_slope_slide_deg": 30 } }
```

- `explicit`: the `content.settings` map as authored (written values only,
  registry key order; never default-filled). A v1 envelope (no `content`) ⇒
  `{}`.
- `resolved`: `defaults ⊕ explicit` over the fixed M2 settings registry
  (this file §8.11's six keys and ranges, registry order) — the same
  resolution the capture uses (project-model §21.5). A v1 envelope ⇒ `{}`.
  Never a partial object: a resolution failure is `field_value`.
- Query semantics: read-only; no `expectedRevision`/`requestId`; never
  mutates; observes the last acknowledged state; carries the revision the
  values were read at. Bounds: ≤ 32 keys (the `settings_keys` bound; the
  registry is 6). Errors: `project_not_found`, `project_unavailable`,
  `invalid_request`, `field_value`.

Conventions that apply to every new `args` object (already accepted for M1):
unknown fields ⇒ `field_unexpected`; missing ⇒ `field_missing`; wrong type ⇒
`field_type`; right type/wrong value ⇒ `field_value`; the request's canonical
bytes must be ≤ 65 536 (`limits_exceeded` `request_bytes`, checked before
argument validation).
The same four `field_*` codes cover every v3 args object; `component_conflict`,
`component_missing`, `game_reference_missing`, `game_reference_in_use`,
`zone_transform_unsupported`, `spawn_transform_unsupported`,
`zone_checkpoint_count_invalid`,
`zone_goal_missing`, `asset_kind_mismatch` and `game_config_invalid` are the
semantic codes of §§8.13–8.14/§8.10.

Naming reconciliation (semantics unchanged): packet 15's proposal labels the
delegated authoritative content mutation `createAssetVersion`; this contract names
it `publishAsset` with packet 15's args plus the required `importedAt`
(`{ mode, assetId, displayName?, sourceDigest, sourceByteLength, importRecipe,
metrics, importedAt }`), its ordering (workspace.md §13.3.1) and its
dedup-before-stage-lookup rule (`docs/planning/m2-contracts/contract-diffs.md`
§3(a) resolves the name).

## 4. Query request

```json
{ "op": "queryEntity", "projectId": "demo-0001",
  "args": { "entityId": "box-0001", "includeSubtree": true } }
```

| Op | `args` |
|---|---|
| `queryProject` | none (field absent or `{}`) |
| `queryEntity` | `entityId` (required); `includeSubtree` (boolean, default `false`) |
| `queryEntities` | `limit` (integer 1–1024, default 100); `offset` (integer ≥ 0, default 0) |
| `queryAssets` | `limit` (integer 1–128, default 50); `offset` (integer ≥ 0, default 0); `includeVersions` (boolean, default `false`); `assetId` (optional) |
| `queryPrefabs` | `limit` (integer 1–128, default 50); `offset` (integer ≥ 0, default 0); `includeEntities` (boolean, default `false`); `prefabId` (optional) |
| `queryBehaviors` | `limit` (integer 1–128, default 50); `offset` (integer ≥ 0, default 0); `includeDeclaration` (boolean, default `false`); `behaviorId` (optional) |

Boundedness (charter §7: large scenes are not returned in full by default):
`queryEntities` is paged with a hard `limit` ceiling of 1024 (the M1 entity
limit); `queryEntity` returns one entity plus bounded lists, and a subtree
only when explicitly requested (still ≤ 1024 entities by the model limit);
`queryProject` returns counts and IDs only.
`queryEntities` accepts an optional `component` filter (one of the accepted
component names).

Content queries are bounded by the catalog/definition caps as well as by
`limit` (project-model §18/§20, `prefabs.md` §5): a page never carries more than
128 summaries, and `includeEntities`/`includeDeclaration` return the exact stored
values (definition ≤ 256 entities, declaration ≤ 32 properties). Queries never
return bytes, blobs or a staging handle.

## 5. Results

### 5.1 Mutation success

```json
{
  "ok": true,
  "op": "createEntity",
  "projectId": "demo-0001",
  "requestId": "req-9f2c8a1d3b4e5f60718293a4b5c6d7e8",
  "revision": 5,
  "duplicated": false,
  "createdId": "box-0001",
  "change": {
    "type": "createEntity",
    "id": "box-0001",
    "entity": {
      "id": "box-0001",
      "components": {
        "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "box": { "size": [1, 1, 1], "material": { "color": "#b0b0b0" } }
      }
    }
  },
  "history": { "undoDepth": 1, "redoDepth": 0 }
}
```

Fixed fields, in canonical key order (used for durable records, §7):
`ok`, `op`, `projectId`, `requestId`, `revision`, `duplicated`,
`createdId` (createEntity only), `change`, `appliedOf` /
`originOfApplied` (undo/redo only), `history`.

Every new §8.5–§8.12 operation uses this same success payload; `createdId`
remains `createEntity`-only, and the new ops carry their identity inside `change`
(`prefabId`/`rootId`, `behaviorId`, `id`/`component`, `assetId`).

| Field | Meaning |
|---|---|
| `revision` | the new project revision. Every successful M1 mutation advances it by exactly 1, so `revision = expectedRevision + 1`. |
| `duplicated` | `false` — first application; `true` — this is a replay of a recorded result (§6). A replay is byte-identical to the originally acked payload except that `duplicated` is `true`. |
| `change` | structured change data (§5.3). A client projection can be updated from `change` alone. |
| `history` | `undoDepth` / `redoDepth` after this command (§9). |
| `appliedOf` | undo/redo only: the `requestId` of the original command whose forward/inverse was applied. |
| `originOfApplied` | undo/redo only: the `origin` of that original command (or `null`). This is what makes mixed human/agent history legible to clients (§9.3). |

### 5.2 Mutation failure

```json
{
  "ok": false,
  "op": "setTransform",
  "projectId": "demo-0001",
  "requestId": "req-9f2c8a1d3b4e5f60718293a4b5c6d7e8",
  "error": {
    "code": "quaternion_invalid",
    "cls": "validation",
    "detailDocument": "result-scene",
    "details": [ { "code": "quaternion_invalid", "path": "/entities/1/components/transform/rotation", "message": "rotation quaternion must have unit length within 1e-4", "found": [0, 0, 0, 0], "expected": "finite [x,y,z,w] with |norm - 1| <= 1e-4", "hint": "normalize to unit length; e.g. 45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]" } ],
    "detailCount": 1,
    "message": "resulting scene failed validation; state unchanged",
    "hint": "fix the request arguments and re-issue with a new requestId"
  }
}
```

- Top level: `ok: false`, then echoes `op` (first 32 chars if the raw value is
  longer), `projectId`, `requestId` (first 64 chars if the raw value is
  longer; omitted when not a string) — each present only when parseable —
  then `error`.
- `error.code` — one of the stable codes in §5.4.
- `error.cls` — `conflict` | `validation` | `unavailable` | `not_found` |
  `internal` (client policy per §5.5).
- `error.message` — one actionable sentence, safe for logs, no secrets.
- `error.hint` — optional recovery advice.
- Code-specific fields per §5.4. Validation failures caused by the
  *resulting scene* (as opposed to request arguments) carry
  `detailDocument: "result-scene"` plus `details`: the project-model error
  objects (project-model §12.5 shape) in document order, capped at 32
  (`detailCount` holds the true total; `detailsTruncated: true` when
  capped). Argument-level failures carry their structured fields directly
  (e.g. `entityId`) instead of `details`.

### 5.3 `change` data

| `type` | Shape | When it appears |
|---|---|---|
| `createEntity` | `{ type, id, entity }` — the full created entity value | createEntity success; redo of a create |
| `setTransform` | `{ type, id, previous, next, changedFields }` — `previous`/`next` are **full** transforms (all three fields); `changedFields` lists the replaced field names in order `position`, `rotation`, `scale` | setTransform success; undo/redo of a setTransform (with `previous`/`next` in the direction actually applied) |
| `deleteEntity` | `{ type, rootId, deletedIds }` — `deletedIds` is the full subtree closure in pre-deletion array order | deleteEntity success; undo of a create; redo of a delete |
| `restoreSubtree` | `{ type, rootId, entities }` — the restored entity values in pre-deletion array order, root first | undo of a delete; (never a forward M1 operation) |
| `publishAsset` | `{ type, mode, assetId, previous, next }` — `previous`/`next` are full `AssetRecord` values (`null` on create) | `publishAsset` success; undo/redo of it |
| `createPrefab` | `{ type, prefabId, definition }` — the full definition value | `createPrefab` success; redo of it |
| `removePrefab` | `{ type, prefabId }` | undo of a `createPrefab` (never a forward operation) |
| `instantiatePrefab` | `{ type, prefabId, rootId, entries, mapping }` — full created entity values with their insertion indices and the exact localId→entityId map, definition document order (§8.7) | `instantiatePrefab` success; redo of it |
| `publishBehavior` | `{ type, behaviorId, previous, next }` — full behavior records (`previous: null` on create) | `publishBehavior` success; undo/redo of it |
| `setBehaviorProperties` | `{ type, id, previous, next, changedKeys }` — full component values (`null` = absent), `changedKeys` in declaration order | `setBehaviorProperties` attach/update/remove; undo/redo of it |
| `setComponent` | `{ type, id, component, previous, next, changedFields }` — full component values (`previous`/`next` are `null` when the component is absent), `changedFields` in canonical field order | `setComponent` success (edit/add/remove); undo/redo of it |
| `setSettings` | `{ type, previous, next, changedKeys }` — full settings maps, `changedKeys` in ascending key order | `setSettings` success; undo/redo of it |
| `acknowledgeBehaviorTrust` | `{ type, sourceDigest, previous, next }` — the full `behaviorTrust` entry arrays before/after | `acknowledgeBehaviorTrust` success; undo/redo of it |
| `applySurfacePreset` | `{ type, id, preset, previous, next, changedFields }` — full `surface` values (`previous: null` when absent), `changedFields` in the surface field order | `applySurfacePreset` success; undo/redo of it |
| `setGameConfig` | `{ type, previous, next, changedFields }` — full `GameConfig` values or `null`, `changedFields` = replaced top-level names in canonical order | `setGameConfig` success (create/edit/remove); undo/redo of it |

The inverse of every forward change is one of the other rows:
create↔delete, restore↔delete, setTransform is self-inverse with swapped
`previous`/`next`; `createPrefab`↔`removePrefab`; and
`setComponent`/`setSettings`/`setBehaviorProperties`/`publishBehavior` are
self-inverse with swapped `previous`/`next` (a `previous: null` value means the
component/record did not exist, so undo removes it). `instantiatePrefab`'s
inverse is the existing subtree `delete` (`{ kind: "delete", rootId }`), and its
redo re-inserts the recorded `entries` at their recorded indices with their
recorded IDs — the same LIFO argument as a redo of `createEntity` (§8.4).
`applySurfacePreset`’s inverse is the `setComponent` surface restore;
`setGameConfig` is self-inverse with swapped `previous`/`next`,
extended to a multi-entity entry.

### 5.4 Error codes (stable, normative for M1)

| Code | cls | Carries | Raised when |
|---|---|---|---|
| `invalid_request` | `validation` | `path`, `found`, `expected` | envelope-level schema failure of the request itself (bad `op`, bad `requestId` syntax, unknown field, etc.) |
| `field_missing` / `field_unexpected` / `field_type` / `field_value` | `validation` | `path`, `found`/`expected` | `args` schema failure |
| `project_not_found` | `not_found` | `projectId` | no project directory with a loadable manifest exists at the data root |
| `project_unavailable` | `unavailable` | `reason` (a permitted `project_unavailable.reason` value — workspace.md §11: its code table plus the §4.3 load-pipeline codes), `holder?` (ownership reasons: the ownership record), `details?` | the project exists but cannot be used right now (load failure, ownership conflict, closed for maintenance, …) |
| `workspace_closed` | `unavailable` | — | the project was explicitly released for external maintenance (workspace.md §9) |
| `revision_conflict` | `conflict` | `expectedRevision`, `currentRevision` | `expectedRevision ≠ currentRevision` (stale client view) |
| `request_id_reused` | `conflict` | `currentRevision` | same `requestId`, different content (§6.2) |
| `revision_exhausted` | `internal` | `currentRevision` | current revision is `2^53−1`; no mutation can be applied (unreachable in practice; defined for completeness) |
| `entity_not_found` | `validation` | `entityId` | `setTransform`/`deleteEntity` target does not exist in the current scene |
| `reference_missing` | `validation` | `found`, `expected` | `createEntity.parentId` does not resolve (project-model §11.2 semantics) |
| `camera_count_invalid` | `validation` | `cameraId` | `deleteEntity`'s subtree contains the scene's only camera (project-model §10.3/§11.3) |
| `limits_exceeded` | `validation` | `limit`, `current`, `max` | a declared limit is exceeded: `entities`/`depth` (project-model §10.4) or one of the packet-15/16/17/18 limits (`assets`, `asset_versions`, `version_records`, `content_bytes`, `source_bytes`, `nodes`, `meshes`, `primitives`, `materials`, `images`, `textures`, `vertices`, `triangles`, `animations`, `animation_channels`, `clip_duration`, `decoded_bytes`; `prefabs`, `prefab_entities`, `prefab_depth`, `prefab_bytes`, `behaviors`, `properties`, `enum_values`, `declaration_bytes`, `settings_keys`, `overrides`, `colliders`, `collider_vertices`, `collider_vertices_total`, `output_bytes`, `trust_entries`, `request_bytes`, `zones`, `player_spawns`, `lights_directional`, `lights_ambient`, `audio_assets`, `audio_versions`, `game_bytes`, `animation_profile_bytes`, `animation_clips`, `animation_tracks`, `animation_track_times`, `animation_clip_duration`, `audio_pcm_bytes`, `audio_cues`) |
| `id_exhaustion` | `internal` | `kind` | no free `<kind>-NNNN` ID for the derived `kind` (`group`/`box`/`model`/`zone`/`spawn`/`light`) in the current scene, including IDs already allocated earlier in the same `instantiatePrefab` transaction (§8.1, §8.7, `prefabs.md` §7.2) |
| `no_change` | `validation` | — | the mutation would leave the durable state byte-identical: **scene and content** canonical bytes, `revision` masked (§6.5) |
| `prefab_not_found` | `validation` | `prefabId` | an operation names a `prefabId` the catalog does not contain |
| `prefab_id_duplicate` | `validation` | `prefabId` | `createPrefab` names an existing definition (M2 has no prefab deletion, so reuse can never be legitimate) |
| `prefab_camera_capture_forbidden` | `validation` | `sourceEntityId`, `cameraId` | the captured subtree contains the scene camera |
| `prefab_nested_forbidden` | `validation` | `sourceEntityId`, `prefabInstanceIds` | the captured subtree contains an entity with `components.prefab` |
| `prefab_external_reference_forbidden` | `validation` | `sourceEntityId`, `localId`, `key`, `entityId` | a definition `entityRef` value names an entity outside the captured subtree |
| `prefab_local_unknown` | `validation` | `prefabId`, `localId` | an override names a `localId` the definition does not contain |
| `prefab_reference_missing` | `validation` | `prefabId`, `localId` | a `components.prefab` value does not resolve in `content.prefabs` |
| `prefab_component_forbidden` | `validation` | `prefabId`, `localId`, `component` | a definition entity carries `camera`, `prefab`, `collider` or `controller` (the definition vocabulary is closed to `transform`/`model`/`box`/`behavior` — project-model §20.2) |
| `behavior_not_found` | `validation` | `behaviorId` | an operation names a `behaviorId` the content block does not contain |
| `behavior_id_duplicate` | `validation` | `behaviorId` | `declaration-create` names an existing behavior |
| `behavior_reference_missing` | `validation` | `behaviorId` | a `components.behavior` value does not resolve in `content.behaviors` |
| `behavior_publication_unavailable` | `unavailable` | `behaviorId`, `mode`, `reason` | behavior **source** publication without the packet-33 digest-bound preparation record: `reason` `preparer_unavailable` (checked before any stage/digest/validation work) or `preparation_missing` (no prepared artifact for the supplied digest) (`behaviors.md` §8.3/§8.4) |
| `behavior_declaration_mismatch` | `validation` | `behaviorId`, `sourceDigest` | `publishBehavior{mode:"source"}` supplies a declaration or `sourceByteLength` that does not match the digest-bound prepared record (`project-model.md` §22.3.2/§8.4). **C33-3 (accepted with diff, Gate I):** the stable code is named normatively by project-model §22.3.2 and the packet-18 fixture table but was missing from this list; the command surface already constructs it. |
| `property_unknown` | `validation` | `behaviorId?`, `key` | an undeclared property key at any entry point (never silently dropped) |
| `property_type` | `validation` | `key`, `found`, `expected` | a value does not match its declared property type |
| `property_value` | `validation` | `key`, `found`, `expected` | a value violates its declared range/length/enum/bounds |
| `property_declaration_incompatible` | `validation` | `behaviorId`, `reason`, `uses` | a declaration update would invalidate existing stored values |
| `setting_unknown` | `validation` | `key` | a settings key the settings registry (packet 17) does not declare |
| `reference_in_use` | `validation` | `entityIds`, `referencingEntityIds` | a subtree deletion would dangle an `entityRef` property value from outside the closure |
| `asset_not_found` | `validation` | `assetId` | a `publishAsset` reimport/unresolved reference names an unknown asset (workspace code reused) |
| `asset_reference_missing` | `validation` | `assetId` | a `components.model`/`setComponent` `model` reference does not resolve in `content.assets` (project-model §11.2/§18.1) |
| `animation_role_out_of_range` | `validation` | `path`, `role`, `clipIndex`, `clips` | a `modelAnimation` binding's `clipIndex` ≥ the named version's `metrics.animations` (presentation.md §41.3.2 stage 3) |
| `animation_role_duplicate` | `validation` | `path`, `clipIndex`, `roles` | two roles of one `modelAnimation` share a `clipIndex` (stage 4) |
| `animation_role_mismatch` | `validation` | `path`, `role`, `expected`, `found` | `clipName ≠ clips[clipIndex].name` at publication (stage 5) |
| `animation_role_ambiguous` | `validation` | `path`, `role`, `clipName`, `matches` | the version's clip list has more than one clip named `clipName` (stage 6) |
| `animation_skin_unsupported` | `validation` | `path` | the animated-profile GLB carries `skins` or a `JOINTS_0`/`WEIGHTS_0` attribute (presentation.md §41.3.3 A2) |
| `animation_root_motion` | `validation` | `path`, `role`, `nodeIndex`, `nodeName` | a channel animates a scene root node's `translation` (A6) |
| `behavior_trust_unacknowledged` | `validation` | `sourceDigest` | source publication for a digest with no `content.behaviorTrust` entry (`behaviors.md` §2.3/§7) |
| `game_reference_missing` | `validation` | `path`, `reason` | a `content.game` reference or required role does not resolve (project-model §23.9) |
| `game_reference_in_use` | `validation` | `entityIds`, `references` | a deletion or component removal would dangle a game/checkpoint reference (project-model §23.6) |
| `zone_transform_unsupported` | `validation` | `path`, `reason` | a `gameZone` entity is parented, non-unit-scaled or rotated |
| `spawn_transform_unsupported` | `validation` | `path`, `reason` | a `playerSpawn` entity is parented, non-unit-scaled or rotated (project-model §23.3.2/§23.9; same conditions as `zone_transform_unsupported`, separate code) |
| `zone_checkpoint_count_invalid` | `validation` | `zoneIds` | more than one checkpoint zone exists |
| `zone_goal_missing` | `validation` | — | `content.game` is non-null and no goal zone exists |
| `asset_kind_mismatch` | `validation` | `assetId`, `expected`, `found` | a reference/reimport kind disagrees with the record |
| `game_config_invalid` | `validation` | `path`, `reason` | `content.game` is malformed at the block level; `reason` ∈ `field_missing`/`field_unexpected`/`field_type`/`field_value` (project-model §23.9). **CC-45-8 (promoted at Gate L):** this code is produced only by the envelope load (a persisted `content.game` block that is malformed); `setGameConfig` request validation reports the same problems as `field_missing`/`field_unexpected`/`field_type`/`field_value` at the request pointer. |
| `external_change_unresolved` | `unavailable` | `pendingChange` (`externalHash`, `externalValid`, `externalErrorCount`) | an unexpected external modification is pending resolution (workspace.md §7) |
| `history_empty` | `unavailable` | `which` (`"undo"` \| `"redo"`) | undo/redo with an empty stack (fresh process, after a reset boundary, or fully undone) |
| `history_invalid` | `internal` | `requestId` (of the history entry) | a stored inverse/forward failed re-validation; defensive, must not occur in M1 (§9.4) |
| `write_failed` | `internal` | `onDiskState` (`"previous"` \| `"new-undurable"`), `errno?` | the durable write sequence failed (workspace.md §5); no revision advanced in the durable state for `"previous"` |

Workspace load-time and operation codes (`envelope_invalid`,
`storage_version_unsupported`, `envelope_project_mismatch`,
`scene_invalid`, `retry_records_invalid`, `manifest_invalid`,
`ownership_conflict`, `stale_ownership`, `workspace_closed`,
`external_change_invalid`, `no_pending_change`,
`project_exists_invalid`) are defined in workspace.md §11 and surface to
clients through `project_unavailable.reason` or as results of the admin
workspace operations; the §4.3 load-pipeline codes listed with them in
workspace.md §11 (`encoding_invalid`, `json_parse_error`,
`duplicate_key`, `field_type`, `manifest_scene_mismatch`) are likewise
permitted `project_unavailable.reason` values.

### 5.5 Client policy per class (normative guidance)

- `conflict` — the client's view is stale or its `requestId` was reused.
  Re-read state via queries, then re-issue the logical command with a **new**
  `requestId` and the current `expectedRevision`. Never retry the same
  request unchanged and expect success.
- `validation` — fix the request; a new `requestId` is not required for a
  *different* command but the old request is permanently rejected (its
  `requestId` may be safely reused only with byte-identical content, which
  would just fail again).
- `unavailable` — transient or operator-gated; query to observe the reason,
  retry later (dedup replays remain available while paused, §6.1 step 2).
- `not_found` — create the project (workspace.md §9) or fix the ID.
- `internal` — safe to retry the same request as documented per code
  (`write_failed`: §7.3; `history_invalid`: do not retry blindly).

### 5.6 Query results

```json
{
  "ok": true,
  "projectId": "demo-0001",
  "revision": 5,
  "manifest": { "schemaVersion": 1, "engineVersion": "0.1.0", "id": "demo-0001", "name": "Demo Project", "createdAt": "2026-09-16T23:40:00Z", "scenes": [ { "id": "scene-main", "path": "scenes/main.json" } ] },
  "scene": { "sceneId": "scene-main", "schemaVersion": 1, "entityCount": 4, "cameraId": "cam-main" },
  "history": { "undoDepth": 3, "redoDepth": 0 },
  "workspace": { "writePaused": false }
}
```

- `queryProject`: the full normalized manifest (bounded by construction —
  fixed small shape), a scene summary (`sceneId`, **`schemaVersion`**, `entityCount`,
  `cameraId`),
  a bounded content summary `{ assets, prefabs, behaviors, settingsKeys }`
`queryProject`'s content summary carries `game` (boolean), `zones`, `spawns` and
`audioAssets` counts (commands.md §12). Exact count semantics (normative,
clarification — M4 C64-2; the accepted shape is unchanged): `assets` = the number of
`content.assets` records; `prefabs` = the number of `content.prefabs` records;
`behaviors` = the number of `content.behaviors` records; `settingsKeys` = the
number of authored `content.settings` keys (`0` for an empty map or a v1
envelope); `game` = `content.game !== null`; `zones` = the number of scene
entities carrying a `gameZone` component; `spawns` = the number of scene
entities carrying a `playerSpawn` component; `audioAssets` = the number of
`content.assets` records with `kind: "audio"`. Counts only — never
definitions, declarations or byte lengths (the accepted rule). v1 envelopes
carry no `content` field (the accepted rule).
  (counts only — never definitions, declarations or byte lengths), `history`
  depths, and `workspace`. **C35-5 / CC-48-3 (promoted at Gate L):** the scene
  summary's `schemaVersion` is the **scene document's** version — `3` for a
  `storageVersion 3` envelope, `2` for `storageVersion 2`, `1` otherwise — never
  the manifest's (always `1`). **CC-45-6 (promoted at Gate L):** the four-key
  content summary above is the v1/v2 shape; a v3 state adds the four
  game/content counts (`game`, `zones`, `spawns`, `audioAssets`, §12), so the
  example above stays the v2 shape. While an external change is pending,
  `workspace` is:
  `{ "writePaused": true, "pauseReason": "external_change", "pendingChange": { "externalHash": "<sha256 hex>", "externalValid": true, "externalErrorCount": 0, "externalErrors": [ … ≤ 10 project-model error objects … ] } }`
  (queries are still served — from the last known good state, §5 of
  workspace.md).
- `queryEntity`:
  `{ ok, projectId, revision, entity, parentChain, childIds, subtree? }`
  — `entity` is the full entity value; `parentChain` is the ancestor ID list
  root-first, excluding the entity itself (`[]` for a root); `childIds` are
  direct children in document order; `subtree` is present only when
  `includeSubtree` is true: `{ "count": n, "entities": [ … ] }` (the entity
  plus all descendants, document order).
- `queryEntities`:
  `{ ok, projectId, revision, total, offset, limit, entities }` — the page in
  document order; `offset > total` yields an empty page (not an error);
  `entities` are full entity values.
- `queryAssets`:
  `{ ok, projectId, revision, total, offset, limit, assets }` — summaries
  `{ assetId, kind, displayName, currentVersion, versionCount }` in ascending
  `assetId` order; with `includeVersions: true` each element adds
  `versions: [{ version, sourceDigest, sourceByteLength }]` (never bytes, never
  metrics arrays). `assetId` returns that one record (or `asset_not_found`).
- `queryPrefabs`:
  `{ ok, projectId, revision, total, offset, limit, prefabs }` — summaries
  `{ prefabId, displayName, createdRevision, entityCount, depth }`; with
  `includeEntities: true` each element is the full `PrefabDefinition`
  (`prefabs.md` §4.1). `prefabId` returns that one definition (or
  `prefab_not_found`).
- `queryBehaviors`:
  `{ ok, projectId, revision, total, offset, limit, behaviors }` — summaries
  `{ behaviorId, displayName, propertyCount, hasSource, publishedRevision }`;
  with `includeDeclaration: true` each element is the **full behavior record**
  — the summary fields plus the exact `declaration`, `source` and
  `publishedRevision` (never source bytes) — which is the packet-16
  `queries.json` `queryBehaviorDeclaration` shape. `behaviorId` returns that
  one record (or `behavior_not_found`).
- `querySettings` (M4, C64-1):
  `{ ok, projectId, revision, explicit, resolved }` — `explicit` is the
  authored `content.settings` map (registry key order; `{}` for a v1
  envelope or an empty map), `resolved` is `defaults ⊕ explicit` over the
  §8.11 registry in registry order (`{}` for a v1 envelope). No values
  appear anywhere else: the `queryProject` summary's `settingsKeys` is a
  count, and the full-state projection carries the map only through the
  §8 convergence change records.
- Query failure: `{ ok: false, projectId?, error }` — no `requestId`; `op`
  echoed when present. Codes: `project_not_found`, `project_unavailable`,
  `invalid_request`, `field_*`, `entity_not_found`, `asset_not_found`,
  `prefab_not_found`, `behavior_not_found`, `limits_exceeded`
  (only `limit` > 1024 for `queryEntities`, via `field_value`).

## 6. Execution semantics

### 6.1 The normative pipeline

For a mutation request `R` on project `P`, the backend executes, **holding
P's per-project mutation lock for the entire sequence** (serialized, FIFO,
workspace.md §5):

1. **Resolve project.** `P` must exist and be openable. Not found ⇒
   `project_not_found`. Load/ownership failure ⇒ `project_unavailable`
   (workspace codes). Explicitly released ⇒ `workspace_closed`.
2. **Deduplication (before any revision check).** Let `D` = SHA-256
   (lowercase hex) of the canonical serialization of `R` (§6.6).
   - If `R.requestId` is present in the retry record map:
     - stored `digest` == `D` ⇒ **identical retry**: return the stored
       recorded result with `duplicated: true`. **No revision is
       consumed, no state changes, no write.** This is served even while
       writes are paused (it is a pure read of the record map).
     - stored `digest` ≠ `D` ⇒ `request_id_reused` (§6.2). No write.
3. **Pause check.** If a pending external change exists ⇒
   `external_change_unresolved` (with `pendingChange`). No write. (Step 2
   still applies — a lost-ack retry during a pause replays cleanly.)
4. **Revision check.** `R.expectedRevision` must equal the current revision
   (else `revision_conflict` carrying both values). Revision checking
   precedes argument validation: a stale request is reported as stale, not
   validated.
5. **Validation and application (pure).** Validate `args` (§3.1) — including the
   65 536-byte request bound — apply the operation to an in-memory copy of the
   current durable state (scene and, for the content ops of §8.5–§8.12, the
   envelope's `content` block), then validate the *result*: the accepted
   project-model scene validation, the content/catalog validation
   (project-model §18/§20) and the cross-block reference checks. The pure
   layer takes the three-block inputs `(scene, content, manifest)`; the
   workspace supplies **both** `content` and `manifest`, while for the pure
   layer they are **optional** (absent ⇒ an empty catalog / no manifest is
   assumed, matching `createCommandState(scene, content?, manifest?)`). Any
   failure ⇒ structured validation error (§5.2); **no state change, no revision
   change, no write**.
6. **No-change check.** If the resulting durable state is byte-identical to the
   current state — canonical scene bytes **and** canonical content bytes, with
   `revision` masked (§6.5) ⇒ `no_change`. No state change, no record.
7. **Durability write.** Build the new envelope (scene at
   `revision+1`, retry block with the new record appended, workspace.md
   §4) and write it atomically (workspace.md §5). On failure ⇒
   `write_failed` (§7.3).
8. **Publish.** Update in-memory state (scene, revision, record map,
   history) — only after step 7's verification passed.
9. **Acknowledge.** Return the success result (`duplicated: false`) only
   after step 8. The ack timing contract: *a success ack implies the durable
   state already contains this command's record* (workspace.md §5.3).

Consequences:

- **Dedup precedes the revision check, normatively.** A retried request
  carries its *original* `expectedRevision`, which is stale by definition
  after the original application advanced the revision. Checking the
  revision first would turn every lost-ack retry into a
  `revision_conflict` and break idempotent retry. Fixtures:
  `fixtures/commands/scenarios/01-retry-lost-ack`.
- **No partial changes, normatively.** Every failure path returns before any
  durable write; the only durable write (step 7) is a single atomic envelope
  replacement carrying *both* the new scene and the new record. A command
  that fails validation, conflicts, or hits a write error leaves the durable
  state byte-identical (except the documented `new-undurable` case, §7.3).
  Fixtures: `04-invalid-no-partial`.

### 6.2 `request_id_reused`

A `requestId` is a *content-addressed lease*: once a request has been
recorded, that ID is permanently bound to its content digest. Reusing it
with different content fails with:

```json
{ "code": "request_id_reused", "cls": "conflict", "currentRevision": 5,
  "message": "requestId was already used with different content",
  "hint": "re-read the project, then re-issue the command with a fresh requestId and the current expectedRevision" }
```

This protects against the "same ID, edited args" retry bug and makes
accidental 128-bit ID collisions fail loudly instead of replaying the wrong
command. The conflicting request changes nothing. Fixture:
`scenarios/02-request-id-reused`.

### 6.3 Identical retry (replay)

Retrying a request byte-identical to a recorded one returns the recorded
result verbatim with `duplicated: true`, regardless of the current revision
(a record's `appliedRevision` may be far behind; the replay reports the
recorded `revision`). The client reconciles by comparing the reported
`revision` with its own expectation. Replay is available as long as the
record is retained (§7.1) and survives process restart (the record map is
loaded from the envelope, workspace.md §4).

### 6.4 Stale revision (recovery path)

`revision_conflict` responses always carry `currentRevision`, so the
recovery loop is: `queryProject` (or re-issue directly with the reported
`currentRevision`), then re-issue the logical command with a **new**
`requestId`. The old request is not recorded (failed commands are never
recorded, §7.1), so its `requestId` may even be reused later with
byte-identical content — but clients must generate fresh IDs. Fixture:
`scenarios/03-stale-revision`.

### 6.5 `no_change`

After applying (step 5), compare the current and resulting **durable state**:
canonical-serialize the scene **and** the content block with `revision` masked
to `0` (project-model §12.2 canonical form) and byte-compare both. Equal ⇒
`no_change` (`cls: validation`). Structural operations (create/delete,
`createPrefab`, `instantiatePrefab`) always change the state; the ops that can
reach `no_change` are `setTransform`, `setComponent`, `setSettings`,
`setBehaviorProperties`, `acknowledgeBehaviorTrust` and a byte-identical
`publishBehavior`/`publishAsset` re-publication. A `no_change` command consumes
no revision and is not recorded — a client may use it to confirm its projection
matches the backend.

### 6.6 Request canonicalization and digest

1. Parse the request JSON strictly (project-model §12.3 pass 1 rules apply
   to the bytes: encoding, syntax, duplicate keys).
2. Canonical serialization: JSON text with **object keys sorted in codepoint
   order at every level**, no insignificant whitespace, strings JSON-escaped
   in the shortest form, numbers serialized with JavaScript
   `JSON.stringify` double semantics (so `1` and `1.0` are the same value).
3. UTF-8 encode; `digest = SHA-256` lowercase hex.

Semantic equality of requests is digest equality. (`expectedRevision`
participates in the digest: the same logical edit at two different
revisions is two different requests.)

## 7. Retries, records, and durability interaction

### 7.1 Retry records

Each **successful** mutation appends one record to the project's retry block
(durable in the envelope — workspace.md §4):

```json
{
  "requestId": "req-9f2c8a1d3b4e5f60718293a4b5c6d7e8",
  "digest": "<64 hex chars, §6.6>",
  "appliedRevision": 5,
  "result": { …the full §5.1 success payload as originally acked, with "duplicated": false… }
}
```

Rules:

- **Only successful mutations are recorded.** Failed commands leave no
  record. This is safe: a failed command changed nothing, so re-evaluating
  the identical request later is deterministic (it fails the revision check,
  since revisions never decrease, or fails validation identically).
- **Retry-record content is op-agnostic.** The new §8.5–§8.12 operations store
  their full §5.1 result (including the `instantiatePrefab` mapping, or the
  `publishAsset` record) in the same single envelope `retry` block with the same
  128-record bound. A content publication's dedup replay is served **before any
  staging, blob or catalog lookup** (workspace.md §13.3.1), which is what makes
  an identical retry survive an expired stage.
- `appliedRevision` is per-record history metadata (the revision this
  command produced). It is **not** an alternative current revision — the
  only current revision is the embedded scene's `revision` field
  (project-model §3/§6); record values must never be used to infer current
  state. All records satisfy `appliedRevision ≤ scene.revision`, and
  revisions within the block are strictly ascending (envelope validation,
  workspace.md §4.3).
- **Retention bound: 128 records** (the envelope's `retry.retention` field
  records the bound). After appending, if more than 128 records exist, the
  oldest (lowest `appliedRevision`) are evicted in the same atomic write.
  128 covers realistic lost-ack retry windows (clients retry within
  seconds; 128 intervening commands is a very long gap) while bounding
  envelope size.
- **Evicted retry ⇒ safe failure.** If a record has been evicted when the
  client retries, the requestId is unknown to the map, so the request falls
  through to the revision check. Its `expectedRevision` is the revision
  *before* its own application, and the current revision is at least the
  revision it produced — strictly greater — so the retry fails with
  `revision_conflict`. It can never silently re-apply. Clients recover by
  re-reading (the edit is already in the scene, or the request was a
  no-op-relevant duplicate the client can detect from state).
- Records survive restart (durable) and are cleared by the history-boundary
  operations listed in §9.2 (release/reopen, accept/discard of an external
  change).

### 7.2 Restart-safe retry (why one file is enough)

The scene and its record are written in the **same atomic envelope
replacement** (workspace.md §5). There is no window in which the revision
has advanced but the record is missing:

- Crash before the rename ⇒ disk holds the old envelope; a retry re-executes
  the command fresh (no record, revision unchanged) ⇒ applied exactly once.
- Crash after the rename ⇒ disk holds the new envelope *with* the record; a
  retry replays (`duplicated: true`) ⇒ applied exactly once.

Fixtures: `scenarios/06-crash-before-replace`, `07-crash-after-replace`.

### 7.3 `write_failed` and the unproven-durability case

If the durability sequence fails after bounded retries (workspace.md
§5.1), the command returns `write_failed` with `onDiskState`:

- `"previous"` — the on-disk envelope is the old one (verified by hash).
  In-memory state is unchanged, no record exists. **Retrying the same
  request re-executes the command fresh** (not a replay — there is no
  recorded result). If state changed in between, a `createEntity` retry may
  yield a different `createdId` than the failed attempt would have; that is
  correct behavior (the failed attempt applied nothing), and clients must
  not assume an ID from an unacked attempt.
- `"new-undurable"` — the rename took effect (on-disk bytes equal the new
  envelope) but the directory flush failed, so durability across process
  crash is unproven. In-memory state is the new state (with its record) so
  the running system is self-consistent; subsequent dedup replays work
  normally. Worst case (process crash + the unflushed rename is lost): a
  restarted backend reports the *previous* revision; the client's next
  query/mutation surfaces the gap (a `revision_conflict` or a query with a
  lower revision), and the client re-issues the logical command with a new
  `requestId` at the true revision. At-most-once logical application still
  holds (no record was durable, so no double-apply; the gap is always
  observable, never silent).

In both cases the ack that was sent (if any) was `ok: false`; a success ack
is never sent for a failed write (workspace.md §5.3).

## 8. Per-operation semantics

### 8.1 `createEntity`

1. Preconditions: `kind` ∈ {`group`, `box`, `model`}; `parentId` resolves
   (else `reference_missing`); a `model` kind requires its
   `model.asset.assetId` to resolve in `content.assets` (else
   `asset_reference_missing`, project-model §11.2/§18.1); resulting entity
   count ≤ 1024 (else `limits_exceeded` `entities`); resulting depth
   (`parent depth + 1`, root = 1) ≤ 32 (else `limits_exceeded` `depth`); all
   provided values satisfy project-model §10.1/§10.2.
2. **ID assignment (backend-assigned).** The created entity's ID is chosen
   by the backend, not the client: the smallest `NNNN` in `0001..9999`
   (decimal, zero-padded) such that `<kind>-NNNN` does not exist in the
   current scene (`kind`-prefix `group`, `box` or `model`). Deterministic
   given the
   current state; exhaustion ⇒ `id_exhaustion`. Clients learn the ID from
   the result (`createdId`) and use it in later commands.
   - **Stability across retries:** a retried request returns the recorded
     result, whose `createdId` is the original ID — retries never re-run the
     scan (dedup, §6.1 step 2). A re-executed command after `write_failed`
     (§7.3) re-runs the scan against the *current* state, which may differ
     from the failed attempt's pre-state only by other applied commands —
     still deterministic, never colliding (the scan checks live IDs).
   - Deleted IDs may be re-assigned by later creations (uniqueness is
     per-document, project-model §5.2); immutable snapshots keep their own
     copies of old values.
3. Defaults: transform fields default to identity per field (a provided
   field replaces that field only); `box` defaults per project-model §10.2.
   The stored entity is always in full canonical form (defaults filled).
4. **Placement:** the new entity is appended at the **end** of the
   `entities` array. It is a leaf (no descendants), so appending preserves
   the parent-before-child invariant (project-model §11.1); document order
   is the sibling/display order (new entity = last sibling). The same
   "smallest free `<prefix>-NNNN`" rule (§8.1 step 2) extends to the
   multi-entity creation of §8.7: IDs are allocated in definition document
   order, each choosing the smallest free ID for its **derived** prefix
   (`model` when the entity carries `model`, else `box` when it carries `box`,
   else `group`), checking the live scene plus the IDs already allocated earlier
   in the same transaction. `camera` is never an allocatable prefix
   The derived prefix order is **first match**: `model` → `box` → `zone`
   (`gameZone`) → `spawn` (`playerSpawn`) → `light` (`light`) → `group`. A
   `components` argument is validated in the §3.1.1/§8.10 order and the entity is
   stored with all of its components in canonical order (one `createEntity`
   change; one revision; one history entry).
   (`prefabs.md` §7.2).
5. Result: `createdId`, `change.type = "createEntity"` with the full entity
   value.
6. Camera count is unaffected (kind is never `camera`), so
   `camera_count_invalid` cannot arise from creation.

### 8.2 `setTransform`

1. Preconditions: `entityId` exists (else `entity_not_found`); `transform`
   has ≥ 1 field; each provided field satisfies project-model §10.1
   (position/scale ranges; rotation finite with `|‖q‖−1| ≤ 1e-4`).
2. Application: each provided field replaces the field; others are
   unchanged. **Quaternion components are preserved exactly as accepted**
   (within the model's `1e-4` tolerance) — the command layer never
   renormalizes authoring quaternions (project-model §10.1: repeated
   division drifts; the renderer normalizes a derived copy, packets 03/08).
   Negative zero normalizes to zero under canonical serialization.
3. The resulting scene is re-validated (step 5 pipeline); in M1 only the
   transform's own constraints can newly fail, but the uniform pipeline is
   normative.
4. Result: `change.type = "setTransform"` with full `previous`/`next` and
   `changedFields`.

### 8.3 `deleteEntity`

1. Preconditions: `entityId` exists (else `entity_not_found`).
2. **Subtree closure.** Compute the full descendant closure (project-model
   §11.3: M1 deletion is always subtree deletion; no leaf-only mode). If
   the closure contains the scene's only camera ⇒ `camera_count_invalid`
   (carrying `cameraId`); the invariant "exactly one camera" must hold in
   every resulting document, so deleting a camera *or any of its
   ancestors* is rejected.
2b. **Entity-reference check.** If any `entityRef` property value in the
    scene names an entity inside the closure while its owning entity is
    **outside** the closure ⇒ `reference_in_use` carrying `entityIds` (the
    closure) and `referencingEntityIds`; the whole deletion is rejected. Values
    from inside the closure are fine (both disappear), and a value that names an
    entity outside the closure is unaffected. This is what keeps the
    no-dangling-reference invariant true now that references exist beyond parent
    links (`properties.md` §10).
3. Application: remove all closure members from the `entities` array.
   Cross-entity references are parent links plus `entityRef` property values;
   after step 2b every incoming reference of a deleted entity comes from inside
   its own subtree (project-model §11.3, extended), so no dangling reference can
   result. Surviving
   IDs and array order are otherwise unchanged; the parent-before-child
   invariant holds (descendants are removed with their ancestor).
4. Result: `change.type = "deleteEntity"` with `rootId` and `deletedIds`
   (closure, pre-deletion array order). The client needs only the IDs to
   update its projection (it already holds the entity values).

### 8.4 `undo` / `redo`

See §9 for the history model. Operation-level:

- No `args` beyond the envelope. Preconditions: the respective stack is
  non-empty (else `history_empty` with `which`); the standard revision check
  applies (an undo issued from a stale view is rejected — undo always
  targets the *last* applied command, and a stale client might not know
  what that is).
- A redo of an `instantiatePrefab` re-inserts the **recorded** `entries` values
  at their recorded indices with their recorded IDs, exactly like a redo of a
  create re-inserts the recorded entity value: no ID re-scan, no re-allocation,
  no new revision beyond the redo's own `+1` (`prefabs.md` §7.6). The
  corresponding undo is the subtree `delete` of `change.rootId`.
- Undo applies the **inverse** of the most recent history entry; redo
  re-applies the **forward** effect of the most recent undone entry using
  the recorded change data (a redo of a create re-inserts the *recorded*
  entity value at the end of the array — the original position by the LIFO
  argument — with its original ID; no ID re-scan).
- Each is a full mutation: revision +1, its own `requestId`/dedup record,
  its own `change` in the result, history depths updated.
- The inverse/forward application passes through the same pure pipeline
  (steps 5–6): in M1 it is provably valid (the state is exactly the state
  the entry was applied from, by LIFO), but if validation ever fails the
  command returns `history_invalid`, changes nothing, and leaves the
  history stacks untouched (§9.4).

### 8.5 `publishAsset`

The delegated authoritative content mutation (packet 15). `args` are
stage-free and digest-addressed (`§3.1.1`): `mode` is `"create"` or
`"reimport"`; `importedAt` is a required project-model §7.2 timestamp supplied
by the caller (the pure layer has no clock); the record published is a
`project-model` §18 `AssetRecord` in the
envelope's v2 `content` block.
Validation order, dedup-before-stage-lookup and the single atomic
envelope replacement are workspace.md §13.3.1–§13.3.3; `create` on an
existing `assetId` is `asset_id_duplicate`, `reimport` on an unknown one is
`asset_not_found`. On `reimport` a supplied `displayName` **replaces** the
record's display name (absent ⇒ unchanged); on `create` an absent `displayName`
defaults to the `assetId`. The change is `{ type, mode, assetId, previous, next }`
(full records, `null` on create); the inverse restores the previous record
(or removes the created one); the op can reach `no_change` only on a
byte-identical re-publication. `publishAsset` adds no second mutation path:
it runs the §6.1 pipeline and stores its full §5.1 result in the retry block.

#### 8.5.1 Atomic animated reimport (`animation`)

```ts
interface PublishAssetAnimation {
  entityId: string;
  roles: ModelAnimationRoles;   // presentation.md §41.3.1
}
```

`animation` is the **only** way a version-local role binding is written; there
is no separate `setComponent` step that could leave the bytes and the mapping
out of step.

**Presence rule.** `mode: "reimport"` **requires** `animation` when the current
scene contains at least one entity whose
`components.modelAnimation.assetId === args.assetId`; absent ⇒ `field_missing`
at `/args/animation`. It is rejected as `field_unexpected` for `mode: "create"`
and for a `kind: "audio"` reimport. A reimport of an asset no animated entity
references, and a reimport of an audio asset, omit it.

**Validation order** (extends §8.5's order; fail-fast):

1. accepted envelope/args checks, then the presence rule above;
2. `assetId` resolves (`asset_not_found`) and `kind` agrees (accepted);
3. `entityId` resolves (`entity_not_found`);
4. the entity carries `modelAnimation` (`component_missing`,
   `expected: "modelAnimation"`);
5. that component's `assetId` equals `args.assetId` (`component_conflict`,
   `reason: "animation_asset"`);
6. binding structure/range/duplicates (presentation.md §41.3.2 stages 1–4)
   against the **new** version's `metrics.animations`;
7. the GLB animated profile and name agreement/ambiguity (presentation.md
   §41.3.3 and §41.3.2 stages 5–6) against the supplied proposal;
8. resulting document validation → no-change → durability.

**Effect and atomicity.** One success appends exactly one `AssetVersion`,
updates the entity's `modelAnimation` component — `version` advances to the
newly appended version and `roles` is replaced with `args.roles` (the binding
is owned by that `(assetId, version)`, presentation.md §41.3.1: the submitted
mapping is only valid against the new version's clip list, so recording it
under the previous version would make capture keep resolving the entity to
the previous bytes, project-model §19.2 — a silent no-op success; CC-L-1,
Gate L) — advances `revision` by
one and records exactly one history entry. The change is

```ts
interface PublishAssetChange {          // extended
  type: 'publishAsset';
  mode: 'create' | 'reimport';
  assetId: string;
  previous: AssetRecord | null;
  next: AssetRecord;
  animation?: { entityId: string; previous: ModelAnimationComponent; next: ModelAnimationComponent };
}
```

where `ModelAnimationComponent` is the entity's full component (project-model
§23.3.6: `assetId`, `version`, `roles`) — full components, not roles only,
so the inverse restores the previous version binding exactly and the
recorded-value rule (§9.1) re-applies it. The inverse restores **both** the
previous record (or removes the created
one) and the previous `modelAnimation` component (full value). Undo/redo move both together or neither; a
redo re-applies the recorded `next` values (the recorded-value rule, §9.1). Any
rejection at steps 1–7 writes nothing: the previous `currentVersion`, the
previous bytes, the previous `roles`, the revision and the history stacks are
unchanged (`project-model` §18.1 rule 6). Reordered clips with an equivalent
new mapping are accepted and the entity keeps its ID, transform and every other
component (accepted §18.1 rule 5).
### 8.6 `createPrefab`

#### 8.6.1 Request

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

#### 8.6.2 Validation order (normative, fail-fast)

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

#### 8.6.3 Forbidden capture contents

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

#### 8.6.4 Result, change and inverse

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

### 8.7 `instantiatePrefab`

#### 8.7.1 Request

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

#### 8.7.2 Deterministic entity-ID allocation

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

#### 8.7.3 Declared-property overrides

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

#### 8.7.4 Remapping (once, recorded, durable)

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

#### 8.7.5 Validation order (normative, fail-fast)

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

#### 8.7.6 Result, change, one-undo removal, exact-ID redo and retry

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

#### 8.7.7 Worked example (pinned byte-exactly)

`fixtures/m2/contracts/commands/prefab-scenario.messages.json` M4 instantiates
the 4-entity definition above into a 6-entity scene (revision 5) with
`transform.position [6,0,0]` and one override (`model-0001/speed = 7.25`). The
allocated IDs are `group-0002, box-0002, model-0003, model-0004`; the recorded
mapping is the identity of those localIds; `model-0003`'s `target` value is
remapped from `group-0001` to `group-0002`. M5 creates a second, independent
instance (`group-0003, box-0003, model-0005, model-0006`) with the definition's
recorded `speed = 4.5`; the two instances share no entity, no value storage and
no link.

### 8.8 `publishBehavior`

#### 8.8.1 Declaration modes

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
  source: null;         // M2: only null is writable (see §8.8.2)
  publishedRevision: number; // == the resulting revision of the publishing command
}
```

Canonical key order: `behaviorId, displayName, declaration, source,
publishedRevision`; `content.behaviors` in ascending `behaviorId` codepoint
order. Packet 18 extends this record (source/build fields); it must not change
the declaration part or its canonical order without a reviewed change.

#### 8.8.2 Source mode is unavailable in M2

`mode: "source"` fails with `behavior_publication_unavailable`
(`cls: unavailable`, `reason: "preparer_unavailable"`) **until packet 33's
preparation path exists**, before any stage lookup, digest check or validation of
the supplied `source` value. It is
not an unchecked write path and it is not a "coming soon" success:

- `m2-plan.md` §3.5 and `docs/planning/m2-packets.md` §18 fix the order: stage
  source → validate/compile the captured graph → prepare a digest-bound
  successful result → atomic publication through `runCommand`.
- Until packet 33 supplies that preparation path, only the **declaration** part of
  a behavior can be published, and `source` stays `null`. A behavior with
  `source: null` executes nothing (packet 18 defines that); it exists so that
  declared properties, prefab behavior components and property editing are
  representable and testable now.
- Staging itself remains available and non-authoritative
  (`content-storage.md` §5): bytes may be staged and inspected without becoming
  authoritative.

#### 8.8.3 Validation order (`declaration-create` / `declaration-update`)

1. Envelope: request bytes ≤ 65 536, then `args` schema (unknown fields ⇒
   `field_unexpected`; `source` present without `mode: "source"` ⇒
   `field_unexpected`).
2. `mode` ⇒ `source` short-circuits to §5.2.
3. `behaviorId` syntax (`id_invalid`); existence: create ⇒ absent
   (`behavior_id_duplicate`), update ⇒ present (`behavior_not_found`).
4. `displayName` shape (`field_value`); declaration bounds
   (`limits_exceeded` `properties`/`enum_values`/`declaration_bytes`).
5. Every property: key syntax/uniqueness (`property_value`), label, type, default
   and constraint coherence — a `default` that violates its own constraints is
   `property_value`; `min > max`, a negative `maxLength`, duplicate enum members,
   missing `bounds` on a vec3 default are all rejected as data.
6. **Compatibility** (update only, §6.4): for every existing
   `components.behavior` value and every prefab-definition behavior value that
   references this `behaviorId`, the new declaration must accept the stored
   values (same key set plus any new defaulted keys, same type, still in range).
   A failure is `property_declaration_incompatible` carrying
   `{ behaviorId, reason, uses: [{ entityId, key }] }` — nothing is written and no
   stored value is dropped.
7. Resulting-state validation + no-change over scene **and** content.
8. Durability write, publish, ack.

#### 8.8.4 Result, change and inverse

```ts
interface PublishBehaviorChange {
  type: 'publishBehavior';
  behaviorId: string;
  previous: BehaviorRecord | null; // null for a create
  next: BehaviorRecord;            // the full new record (publishedRevision == result revision)
}
```

Inverse: `{ kind: 'publishBehavior', behaviorId, restore: previous }` — undo
restores the previous record value (`null` for a create removes the record); redo
re-applies the recorded `next` verbatim. A record removed by undo is invisible to
`setBehaviorProperties`, prefab capture (its declaration is gone) and validation
until restored.

**Source mode (C19-D2).** `mode: "source"` fails with
`behavior_publication_unavailable`, `reason: "preparer_unavailable"`, until
packet 33's preparation path exists (`project-model` §22.6, `behaviors.md`
§8.3). Additionally, `reason: "preparation_missing"` is returned when no
prepared artifact for the supplied `sourceDigest` exists — a *play/export*
composition check, not a document check. When a preparer exists, the trust
check runs **after** the preparer gate:
`behavior_trust_unacknowledged` when the supplied `sourceDigest` has no
`content.behaviorTrust` entry (`project-model` §22.5, `behaviors.md` §8.4).

### 8.9 `setBehaviorProperties`

Attach, update or remove one entity's behavior component. This is the **only**
mutation path for `components.behavior`.

```json
{
  "op": "setBehaviorProperties",
  "projectId": "demo-0003",
  "expectedRevision": 3,
  "requestId": "req-60200000000000000000000000000000",
  "origin": { "kind": "mcp", "clientId": "pi-harness" },
  "args": {
    "entityId": "model-0001",
    "behaviorId": "behavior-0001",
    "values": { "speed": 4.5, "target": "group-0001" }
  }
}
```

| Field | Type / constraint | Required |
|---|---|---|
| `entityId` | existing entity ID | yes |
| `behaviorId` | existing behavior ID, or `null` to remove the component | yes |
| `values` | partial map of declared keys; omitted keys take their declaration default | no (default `{}`) |

Validation order:

1. Envelope: request bytes ≤ 65 536, then `args` schema.
2. `entityId` resolves (`entity_not_found`). The camera entity may not carry a
   behavior component: `entityId` naming the camera ⇒ `field_value`.
3. `behaviorId` resolves (`behavior_not_found`), or is `null` (removal).
4. Every provided key is declared (`property_unknown`) and type-checks
   (`property_type`/`property_value`); `entityRef`/`assetRef` resolve
   (`reference_missing`/`asset_reference_missing`).
5. Application **replaces the whole component**: `components.behavior =
   { behaviorId, values }` with defaults filled for omitted keys, in declaration
   order. Switching `behaviorId` on an entity keeps only the keys declared by the
   new declaration (an undeclared stored key cannot exist because it would have
   failed step 4).
6. Resulting-state validation + no-change over scene and content (`no_change`
   when the component value is byte-identical).
7. Durability, publish, ack.

Change data:

```ts
interface SetBehaviorPropertiesChange {
  type: 'setBehaviorProperties';
  id: string;
  previous: BehaviorComponent | null;   // full previous component
  next: BehaviorComponent | null;       // full next component (null = removed)
  changedKeys: string[];                // declaration order
}
```

Inverse: `{ kind: 'setBehaviorProperties', id, restore: previous }` (restore
`null` removes the component). Self-inverse in the direction actually applied,
exactly like `setTransform`.

### 8.10 `setComponent`

Typed partial edit, add or remove of one **owned** component on one entity. It is
the only mutation path for `box`, `camera`, `model`, `collider` and
`controller`.

| `component` | Accepted fields (partial replacement, per field) | Notes |
|---|---|---|
| `box` | `size` (3 finite numbers, `0 < v ≤ 1e6`), `material` (`{ color: ^#[0-9a-fA-F]{6}$ }`, lowercased canonically) | accepted project-model §10.2; field edit only (never add/remove) |
| `camera` | `type` (`"perspective"`), `fovY` (`0 < v < 180`), `near` (`0 < v ≤ 1e6`), `far` (`near < v ≤ 1e6`) | only the single camera entity can carry it; this is a field edit, never add/remove |
| `model` | `asset` (full `{ assetId }` replacement, must resolve) | packet 15 pinned `components.model.asset.assetId`; field edit only (never add/remove) |
| `collider` | `shape` (a full project-model §10.7 `ColliderShape`: `{ type: "box", hx, hy }` or `{ type: "polygon", vertices }`) | **add** when the entity does not carry it, **edit** (field replacement) when it does, **remove** via `value: null`; validated by project-model §10.7/§21 (`collider_shape_invalid`, `colliders`/`collider_vertices`/`collider_vertices_total` limits) |
| `controller` | (none — the component is a field-less marker, project-model §10.8) | **add** with the exact empty object `{}` when the entity does not carry it, **remove** via `value: null`; a second controller is `controller_count_invalid` (project-model §21.1) |
| `gameZone` | `role` (`"hazard" | "checkpoint" | "goal"`), `size` (`[w,h]`, `0 < v ≤ 1e6`), `safeSpawnId` (iff `checkpoint`), `activation` (iff `checkpoint`) | **add**/**edit**/**remove** via `null`; `zone_transform_unsupported`, `component_conflict` with `collider`/`controller`, `game_reference_missing`, `game_reference_in_use` (project-model §23.3.1/§23.6) |
| `playerSpawn` | exactly `{}` | **add** with `{}`, **remove** via `null`; no field edit; `spawn_transform_unsupported` |
| `cameraFollow` | `deadZone`, `smoothing`, `bounds` | **add**/**edit**/**remove**; only on the `camera` entity |
| `light` | `type`, `color`, `intensity`, `direction` (iff `directional`), `castShadow` (iff `directional`) | **add**/**edit**/**remove**; count limits `lights_directional`/`lights_ambient` |
| `surface` | `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity` | **add**/**edit**/**remove**; only on a `box`/`model` entity |
| `modelAnimation` | `assetId`, `version`, `roles` | **add**/**edit**/**remove**; only on a `model` entity; `component_conflict` `animation_asset` |
| `transform` | — | rejected (`field_value`): owned by `setTransform` |
| `behavior` | — | rejected: owned by `setBehaviorProperties` |
| `prefab` | — | rejected: read-only provenance |

Request: `{ entityId, component, value }`. For `box`/`camera`/`model` `value` is
a non-empty partial object of that component's fields. For `collider` it is a
non-empty partial object (`{ shape }`) or `null`; for `controller` it is exactly
`{}` (add) or `null` (remove). A present field **replaces** the whole field (like
`setTransform`); absent fields are unchanged; unknown fields ⇒
`field_unexpected`; an empty `value` for `box`/`camera`/`model` ⇒ `field_value`.

Validation order: envelope → `entityId` resolves → `component` is one of the five
owned names → for `box`/`camera`/`model` the target entity actually carries that
component (`component_missing`); `collider`/`controller` may be absent (add) →
field validation (including `component_conflict`/`controller_count_invalid` for
the resulting scene and, for `camera`, the exactly-one invariant; a
physics-bearing entity's transform rules are project-model §21.2,
`physics_transform_unsupported`) → the v3 component rules (project-model §23.3,
§23.6) → resulting-state validation + no-change → durability.

Change data:

```ts
interface SetComponentChange {
  type: 'setComponent';
  id: string;
  component: 'box' | 'camera' | 'model' | 'collider' | 'controller'
           | 'gameZone' | 'playerSpawn' | 'cameraFollow' | 'light' | 'surface' | 'modelAnimation';
  previous: unknown | null;   // full previous component value; null = absent
  next: unknown | null;       // full next component value; null = removed
  changedFields: string[]; // canonical field order (box: size, material; camera: type, fovY, near, far; model: asset; collider: shape; controller: none)
}
```

Inverse: `{ kind: 'setComponent', id, component, restore: previous | null }` —
undo of an add removes the component, undo of a remove restores it, and undo of
an edit restores the previous value (self-inverse in the direction applied).

Normative non-goals: no add/remove for `box`/`camera`/`model` (`model`/`behavior`
presence is created by placement/instantiation and `setBehaviorProperties`
respectively); no material graph, texture or submesh editing.

### 8.11 `setSettings`

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

### 8.12 `acknowledgeBehaviorTrust`

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
  already running (`behaviors.md` §8.6).

### 8.13 `applySurfacePreset`
Normative text: [`../authoring.md`](../authoring.md) §A3.3 (preconditions,
effect, one edit/one revision/one history entry, exact inverse and redo rule).

### 8.14 `setGameConfig`
Normative text: [`../authoring.md`](../authoring.md) §A3.4 (create/edit/remove
rules, validation order, references, `previous`/`next`/`changedFields`, exact
inverse, no-change).
## 9. History model (undo/redo)

### 9.1 Structure

Per project, **in memory only** (M1), for the lifetime of the open session
(one backend process, one owner — workspace.md §6). The history is a list
`entries[0..n-1]` with a cursor `c` (`0 ≤ c ≤ n`): entries below `c` are
applied, entries at or above `c` are undone (the redo tail).

```json
{
  "seq": 12,
  "requestId": "req-…",
  "op": "setTransform",
  "origin": { "kind": "mcp", "clientId": "pi-harness" },
  "appliedRevision": 7,
  "change": { …forward change data, §5.3… },
  "inverse": { …inverse spec, below… }
}
```

| Operation | Effect on history |
|---|---|
| createEntity / setTransform / deleteEntity | truncate `entries[c..n-1]` (**fresh edits invalidate redo**), append the new entry, `c++` |
| undo | require `c > 0`; apply `entries[c-1].inverse`; `c--` |
| redo | require `c < n`; re-apply `entries[c].change` forward (recorded values, §8.4); `c++` |

Inverse specs:

- createEntity ⇒ `{ "kind": "delete", "rootId": <createdId> }` — subtree
  deletion at undo time. By LIFO, no later command exists when this entry
  is undone, so the closure is exactly the created entity itself (the
  subtree form is normative anyway, for uniformity).
- setTransform ⇒ `{ "kind": "setTransform", "id", "restore": <full previous transform> }`.
- deleteEntity ⇒ `{ "kind": "restoreSubtree", "entries": [ { "index": <pre-deletion array index>, "entity": <full entity value> } … ] (pre-deletion array order), "restoredParentId": <the root's parent, or null> }` —
  application inserts the entries in ascending `index` order, each at
  position `index` (its pre-deletion array index). Every entry inserted
  earlier has a strictly smaller index, so each original index is still a
  valid slot in the growing array, and this exactly reconstructs the
  pre-deletion array, in particular the parent-before-child order
  (project-model §11.1). `restoredParentId` is the root's parent, which
  always survives because subtree deletion removes only the root and its
  descendants (`null` when the root had no parent); internal links are
  unchanged because the whole subtree is restored together. (Storing the
  original index list, not the whole pre-deletion array, keeps inverse size
  proportional to the subtree.)
- `publishAsset` ⇒ `{ "kind": "publishAsset", "assetId", "restore": <full previous AssetRecord or null> }`.
- `createPrefab` ⇒ `{ "kind": "removePrefab", "prefabId" }`.
- `instantiatePrefab` ⇒ `{ "kind": "delete", "rootId" }` (the subtree form; by
  LIFO the closure is exactly the created entities).
- `publishBehavior` ⇒ `{ "kind": "publishBehavior", "behaviorId", "restore": <full previous BehaviorRecord or null> }`.
- `setBehaviorProperties` ⇒ `{ "kind": "setBehaviorProperties", "id", "restore": <full previous BehaviorComponent or null> }`.
- `setComponent` ⇒ `{ "kind": "setComponent", "id", "component", "restore": <full previous component value or null> }`.
- `setSettings` ⇒ `{ "kind": "setSettings", "restore": <full previous SettingsMap> }`.
- `acknowledgeBehaviorTrust` ⇒ `{ "kind": "acknowledgeBehaviorTrust", "sourceDigest", "restore": <the full previous entries array> }` — undo removes the entry (or restores the prior array).
- `applySurfacePreset` ⇒ `{ "kind": "setComponent", "id", "component": "surface", "restore": <full previous SurfaceComponent or null> }`.
- `setGameConfig` ⇒ `{ "kind": "setGameConfig", "restore": <full previous GameConfig or null> }`.

`seq` is a per-session diagnostic counter (not part of any durable record).

### 9.2 Reset boundaries (history is cleared, depths → 0)

- **Process restart.** Undo/redo does not survive restart in M1 (charter
  §6: explicitly not promised). After restart, `undo`/`redo` return
  `history_empty` until new commands are applied. Clients observe this via
  the `history` fields in results/queries (depths are 0 after restart).
- **Release/reopen** (maintenance, workspace.md §9).
- **Accept or discard of an unexpected external change**
  (workspace.md §7): an external file replacement establishes a new history
  boundary (charter §6; M1 has no reconciliation).
- History is never cleared by ordinary commands, by restart-safe retries,
  or by record eviction.

### 9.3 Mixed human/agent editing history (normative)

Human (browser) and agent (MCP) commands share **one history stack per
project**, in strict application order, regardless of `origin`:

- `undo` undoes the most recent entry **of any origin**; `redo` re-applies
  the most recent undone entry **of any origin**. There are no per-origin
  stacks.
  Rationale (normative): inverses only apply cleanly to the *last* applied
  command. Per-origin stacks would require undoing a command whose
  post-state no longer holds (e.g. A creates `x`, B deletes `x`, A's
  per-origin undo of the create would try to delete a non-existent `x`),
  producing a class of `history_invalid` failures the shared stack cannot
  have.
- Transparency: entries record `origin` (or `null`); undo/redo results carry
  `appliedOf` (original `requestId`) and `originOfApplied`, so a client can
  display what was undone and by whom (e.g. "AI edit undone"). Fixture:
  `scenarios/05-undo-redo-mixed` (undo crossing an agent→human boundary,
  redo invalidation by a fresh edit of the other origin).
- `origin` is metadata: it never changes validation, ordering, dedup, or
  revision behavior. It participates in the request digest (it is part of
  the request), so a retry with a changed `origin` is a *different*
  request (`request_id_reused`).

### 9.4 Defensive failure

If an inverse/forward application fails validation (which M1's LIFO
argument makes impossible for entries this backend applied), the command
returns `history_invalid`, changes neither state nor stacks, and does not
record. The operator can continue with fresh edits (which invalidate redo
and truncate the corrupted tail) or restart the backend.

## 10. Serialization and concurrency

- **One mutation at a time per project.** The pipeline (§6.1) runs under
  P's mutation lock; requests queue in arrival order (FIFO). The lock spans
  dedup through ack, so no two mutations of P interleave (no TOCTOU between
  the revision check and the write).
- **Queries do not take the mutation lock.** They read the published
  in-memory state — always a complete state at one acknowledged revision.
  A query during an in-flight mutation observes either the pre- or
  post-mutation state, never a partial state.
- **Across projects** there is no shared lock; projects are independent
  (separate files, separate queues). Process-level resource limits
  (concurrent durable writes) are an implementation concern, not a
  semantic one (per-file atomicity is independent).
- The per-project serialization + single-file atomic write is what makes
  "revision +1 per successful mutation" and the retry-record invariants
  hold without a global lock.

## 11. What is deliberately not in M1

- No rename, reorder, arbitrary batch/multi-entity commands (project-model §14;
  a required transaction is expressed by one op, e.g. `instantiatePrefab`), and
  no generic JSON-Patch/eval endpoint. Settings, component, property and prefab
  operations are §8.5–§8.12; prefab update/delete/variants/nesting and behavior
  source publication remain out of M2.
- No persisted history / cross-restart undo (charter §6; M2+ candidate).
- No per-origin history isolation (§9.3 rationale).
- No optimistic concurrency beyond `expectedRevision` (single-writer
  backend, one owner per project).
- No server-push change notifications (packet 03 owns sessions/events;
  clients poll or receive via the session protocol).
- No request `schemaVersion` field; protocol changes go through contract
  review (this document).
- No multi-project or cross-project atomicity (each command targets one
  project; workspace.md §12).

## 12. Fixture index

`fixtures/commands/` — normative examples with real SHA-256 digests and
byte-exact envelopes; index: `fixtures/commands/expected.json`.

| Scenario | Pins |
|---|---|
| `scenarios/01-retry-lost-ack` | identical retry returns the recorded result with `duplicated: true`; no revision consumed; disk unchanged |
| `scenarios/02-request-id-reused` | same `requestId`, different content ⇒ `request_id_reused`; disk unchanged |
| `scenarios/03-stale-revision` | `revision_conflict` with `currentRevision`; recovery re-issue with a fresh `requestId` |
| `scenarios/04-invalid-no-partial` | validation failures (`quaternion_invalid`, `entity_not_found`, `reference_missing`, `no_change`) leave the envelope byte-identical |
| `scenarios/05-undo-redo-mixed` | shared human/agent stack, undo crossing origins, redo invalidation by a fresh edit, depth progression, restart-independent record contents |
| `scenarios/06-crash-before-replace` | crash before rename: stale temp cleaned on open, retry re-executes fresh (deterministic ID) |
| `scenarios/07-crash-after-replace` | crash after rename: retry replays (`duplicated: true`), no double-apply |
| `scenarios/08-external-modification` | pre-write hash check fires, recovery snapshot retained, writes paused, `acceptExternalState` resolution, retry block cleared |
| `scenarios/09-second-backend-ownership` | live owner ⇒ `ownership_conflict`; dead owner ⇒ `stale_ownership` ⇒ explicit `takeoverWorkspace` (no automatic takeover) |
| `envelope/valid/*` | the atomic authoring-state envelope: fields, canonical bytes, retry records, retention eviction boundary (128) |
| `envelope/invalid/*` | envelope validation failures: storage version, `type`, project mismatch, embedded scene, retry monotonicity, duplicate key |
| `examples/commands.json` | one request/result pair per op (mainline history), query examples |
| `fixtures/m2/contracts/commands/prefab-scenario.*` | M1–M10 byte-exact request/result pairs: two independent materialized instances, one legal initial override, ordinary edits, one-undo subtree removal, exact-ID redo and retry, mixed human/MCP history |
| `fixtures/m2/contracts/commands/prefab-failures.json` | 24 atomic rejection cases + 10 constructed boundaries for §8.5–§8.12 |
| `fixtures/m2/contracts/commands/queries.json` | `queryProject` content summary, `queryAssets`, `queryPrefabs`, `queryBehaviors` |
| `fixtures/m2/contracts/tools/check-fixtures.mjs` | re-derives revision/history arithmetic, deterministic ID allocation and remapping from the scenario |
- Packet-39 v3 fixtures add `fixtures/m3/contracts/commands/*` (the
  create/add/edit/remove scenario, no-change and the reachable failure set) and
  `fixtures/m3/contracts/envelope/*` (byte-exact v3 envelopes), replayed by
  `fixtures/m3/contracts/tools/check-fixtures.mjs`. Contract-level fixture
  changes require the same review as contract text (project-model §17).