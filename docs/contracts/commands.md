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
  history.
- Change/inverse data shapes.
- The per-project serialization rule and the no-partial-change guarantee.

This contract does **not** own:

- Filesystem layout, the authoring-state envelope, atomic writes, crash
  recovery, ownership, external-change detection — workspace.md.
- Logical document shapes, validation codes, limits — project-model.md.
- Transport framing, authentication, session IDs, notification channels —
  packet 03 (`docs/contracts/sessions.md`). This contract defines payloads;
  packet 03 decides how they are carried (HTTP/WS/MCP) and who may send them.
- Renames, reordering, settings, or any other M1+ command — deliberately not
  M1 (project-model §14).

## 2. The M1 command set

| Op | Kind | Effect | Revision |
|---|---|---|---|
| `createEntity` | mutation | Append one new entity (`group` or `box`) | +1 |
| `setTransform` | mutation | Replace any non-empty subset of one entity's transform fields | +1 |
| `deleteEntity` | mutation | Remove one entity **and its entire subtree** (project-model §11.3) | +1 |
| `undo` | mutation | Apply the inverse of the most recent history entry | +1 |
| `redo` | mutation | Re-apply the most recent undone history entry | +1 |
| `queryProject` | query | Bounded project summary (no entity payloads) | — |
| `queryEntity` | query | One entity, its ancestry, its children, optional subtree | — |
| `queryEntities` | query | Paged entity list in document order | — |

M1 excludes (normative non-goals): rename, reorder, camera creation (a valid
M1 scene always contains exactly one camera, project-model §10.3), settings
edits, multi-entity batches, and scene selection (single scene, project-model
§3). There is no per-message protocol version field in M1; this document's
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
| `kind` | `"group"` \| `"box"` (no `"camera"` — §2) | yes |
| `parentId` | existing entity ID in the current scene, or `null` | no (default `null`) |
| `name` | display name, 1–128 chars, no control chars | no |
| `transform` | partial transform: any non-empty subset of `position` (3 finite numbers, `|v| ≤ 1e6`), `rotation` (4 finite numbers, `|‖q‖−1| ≤ 1e-4`), `scale` (3 finite numbers, `0 < v ≤ 1e6`) — project-model §10.1 | no (default: identity) |
| `box` | `{ "size": 3 finite numbers `0 < v ≤ 1e6`?, "material": { "color": `^#[0-9a-fA-F]{6}$`? }? }` (project-model §10.2) — **only when `kind` is `"box"`** | no (default: unit box, `#b0b0b0`) |

**`setTransform`**

| Field | Type / constraint | Required |
|---|---|---|
| `entityId` | existing entity ID in the current scene | yes |
| `transform` | partial transform as above, **at least one field present** (an empty object ⇒ `field_value`) | yes |

A present field **replaces** the whole field (arrays are not merged
component-wise). Absent fields are unchanged.

**`deleteEntity`** — `args: { "entityId": <existing entity ID> }`.

**`undo` / `redo`** — `args: {}` (exactly the empty object).

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

Boundedness (charter §7: large scenes are not returned in full by default):
`queryEntities` is paged with a hard `limit` ceiling of 1024 (the M1 entity
limit); `queryEntity` returns one entity plus bounded lists, and a subtree
only when explicitly requested (still ≤ 1024 entities by the model limit);
`queryProject` returns counts and IDs only.

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
    "details": [ { "code": "quaternion_invalid", "path": "/entities/1/components/transform/rotation", "message": "rotation quaternion must have unit length within 1e-4", "found": [0, 0, 0, 0], "expected": "finite [x,y,z,w] with |norm - 1| <= 1e-4", "hint": "identity rotation is [0, 0, 0, 1]" } ],
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

The inverse of every forward change is one of the other rows:
create↔delete, restore↔delete, setTransform is self-inverse with swapped
`previous`/`next`.

### 5.4 Error codes (stable, normative for M1)

| Code | cls | Carries | Raised when |
|---|---|---|---|
| `invalid_request` | `validation` | `path`, `found`, `expected` | envelope-level schema failure of the request itself (bad `op`, bad `requestId` syntax, unknown field, etc.) |
| `field_missing` / `field_unexpected` / `field_type` / `field_value` | `validation` | `path`, `found`/`expected` | `args` schema failure |
| `project_not_found` | `not_found` | `projectId` | no project directory with a loadable manifest exists at the data root |
| `project_unavailable` | `unavailable` | `reason` (a workspace.md §11 code), `holder?` (ownership reasons: the ownership record), `details?` | the project exists but cannot be used right now (load failure, ownership conflict, closed for maintenance, …) |
| `workspace_closed` | `unavailable` | — | the project was explicitly released for external maintenance (workspace.md §9) |
| `revision_conflict` | `conflict` | `expectedRevision`, `currentRevision` | `expectedRevision ≠ currentRevision` (stale client view) |
| `request_id_reused` | `conflict` | `currentRevision` | same `requestId`, different content (§6.2) |
| `revision_exhausted` | `internal` | `currentRevision` | current revision is `2^53−1`; no mutation can be applied (unreachable in practice; defined for completeness) |
| `entity_not_found` | `validation` | `entityId` | `setTransform`/`deleteEntity` target does not exist in the current scene |
| `reference_missing` | `validation` | `found`, `expected` | `createEntity.parentId` does not resolve (project-model §11.2 semantics) |
| `camera_count_invalid` | `validation` | `cameraId` | `deleteEntity`'s subtree contains the scene's only camera (project-model §10.3/§11.3) |
| `limits_exceeded` | `validation` | `limit` (`"entities"` \| `"depth"`), `current`, `max` | creation would exceed 1024 entities or depth 32 (project-model §10.4) |
| `id_exhaustion` | `internal` | `kind` | no free `<kind>-NNNN` ID (§8.1) |
| `no_change` | `validation` | — | the mutation would leave the scene byte-identical (§6.5) |
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
workspace operations.

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
  "scene": { "sceneId": "scene-main", "entityCount": 4, "cameraId": "cam-main" },
  "history": { "undoDepth": 3, "redoDepth": 0 },
  "workspace": { "writePaused": false }
}
```

- `queryProject`: the full normalized manifest (bounded by construction —
  fixed small shape), a scene summary (`sceneId`, `entityCount`, `cameraId`),
  `history` depths, and `workspace`. While an external change is pending,
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
- Query failure: `{ ok: false, projectId?, error }` — no `requestId`; `op`
  echoed when present. Codes: `project_not_found`, `project_unavailable`,
  `invalid_request`, `field_*`, `entity_not_found`, `limits_exceeded`
  (only `limit` > 1024, via `field_value`).

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
5. **Validation and application (pure).** Validate `args` (§3.1), apply the
   operation to an in-memory copy of the current scene, then run the
   project-model scene validation on the *result* document (project-model
   §12). Any failure ⇒ structured validation error (§5.2); **no state
   change, no revision change, no write**.
6. **No-change check.** If the resulting scene is byte-identical to the
   current scene (§6.5) ⇒ `no_change`. No state change, no record.
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

After applying (step 5), compare the current and resulting scenes:
canonical-serialize both **with `revision` masked to `0`** (project-model
§12.2 canonical form) and byte-compare. Equal ⇒ `no_change`
(`cls: validation`). Only `setTransform` can reach this (create/delete
always change structure; undo/redo always restore a different state, since
history entries exist only for actual changes). A `no_change` command
consumes no revision and is not recorded — a client may use it to confirm
its projection matches the backend.

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

1. Preconditions: `kind` ∈ {`group`, `box`}; `parentId` resolves (else
   `reference_missing`); resulting entity count ≤ 1024 (else
   `limits_exceeded` `entities`); resulting depth (`parent depth + 1`, root
   = 1) ≤ 32 (else `limits_exceeded` `depth`); all provided values satisfy
   project-model §10.1/§10.2.
2. **ID assignment (backend-assigned).** The created entity's ID is chosen
   by the backend, not the client: the smallest `NNNN` in `0001..9999`
   (decimal, zero-padded) such that `<kind>-NNNN` does not exist in the
   current scene (`kind`-prefix `box` or `group`). Deterministic given the
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
   is the sibling/display order (new entity = last sibling).
5. Result: `createdId`, `change.type = "createEntity"` with the full entity
   value.
6. Camera count is unaffected (kind is `group`/`box` only), so
   `camera_count_invalid` cannot arise from creation in M1.

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
3. Application: remove all closure members from the `entities` array.
   M1 cross-entity references are parent links only, and every incoming
   reference of a deleted entity comes from inside its own subtree
   (project-model §11.3), so no dangling reference can result. Surviving
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

- No rename, reorder, batch/multi-entity commands, or settings edits
  (project-model §14; future contract changes).
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