PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Thirdlight — Content Storage, Staging, Publication and Migration (M2 storage v2)

**PROPOSED — pending Gate E.** This document is a *proposal*: it does not change
any accepted contract. It is one of packet 15's two outputs
(`docs/planning/m2-packets.md` §15); its companion is
[`assets.md`](assets.md) (asset identity, catalog records, the GLB import
profile and the captured content view). The exact section-level changes it
requires in the accepted contracts are in
[`diffs/workspace.md`](diffs/workspace.md) and
[`diffs/project-model.md`](diffs/project-model.md). Accepted diffs are applied
in the docs-only promotion step before packet 20; contract text in
`docs/contracts/` is binding until then.

Owner pre-approval for this autonomous M2 build:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending.** No decision entry is added to `docs/decisions/0002` by this
packet (packet 19 owns the consolidated draft).

Read basis (packet 15 read set): `AGENTS.md`; `docs/STATUS.md` (M2 section);
`docs/planning/m2-packets.md` §15 + the common instructions; `docs/planning/m2-plan.md`
§§2/3.1/3.2/4; `docs/planning/m2-acceptance.md` §1 and rows A01/A03/A04/A09/A10;
`docs/contracts/project-model.md` §§3–6/10/12–14/17; `docs/contracts/workspace.md`
§§3–9/11/12; `docs/contracts/commands.md` §§6/7/9; `docs/handoffs/14.md`;
`docs/handoffs/m2-plan-review.md` (BR-4 + non-gating observation (a)); the public
exports of `packages/project-model` and `packages/workspace`.

---

## 1. Scope, ownership and non-goals

This section defines **where authoritative content bytes live, how they are
published, how they are read, how a crash or an operator mistake is bounded, and
how an M1 project becomes an M2 project**. It does not define the GLB importer
(packet 24), the content commands' wire shape (packets 21/23), the HTTP/MCP
transport (packet 25) or any rendering (packet 26).

Ownership (unchanged from `m2-plan.md` §4, made explicit here):

| Unit | Owns | Must not |
|---|---|---|
| `workspace` | every project-relative path, ownership and the envelope write, immutable blob publication, staging, quota accounting, integrity reports, migration-copy | hold the project mutation lock across inspection/blob I/O; accept a caller-supplied path or digest as authoritative |
| `project-model` | v2 catalog record shapes, content validation/normalization, the captured content view, the cross-block reference check | perform I/O; know about paths, sockets or caches |
| new `asset-pipeline` (packet 24) | bounded pure GLB inspection and the import recipe over **supplied bytes**, emitting `ImportProposal` | read the filesystem, decide asset IDs, commit state, cache anything on disk |
| `commands` (packets 21/23) | the content mutation's typed args, inverse/history, retry serialization, projection | reference a staging handle or any non-authoritative path |
| `backend` (packet 25) | framing uploads, bounded job coordination, serving verified bytes | implement a second storage path or bypass the workspace |

Non-goals for M2 in this document: garbage collection, blob deletion, version
eviction, in-place migration, downgrade, remote/URL content fetch, a second
mutable catalog file, multi-file transactions for authoring state, and any
content path outside the project tree.

## 2. On-disk layout and artifact classes

```text
<root>/projects/<projectId>/
  project.json                      manifest — IMMUTABLE after creation (workspace.md §8)
  scenes/
    main.json                       storageVersion 2 authoring-state envelope (§3) — the ONLY mutable authoring file
    .main.json.tmp-<pid>-<nonce>    temp file (workspace.md §5.4)
  sources/
    sha256/
      <64-lowercase-hex>            AUTHORITATIVE immutable source bytes; the file name IS its SHA-256
      .<digest>.tmp-<pid>-<nonce>   temp file during publication (§4); cleaned on open
  .thirdlight/
    ownership.json                  ownership record (workspace.md §6) — unchanged
    claim-<e>                       claim file (workspace.md §6.3) — unchanged
    recovery/                       recovery snapshots (workspace.md §7.4) — unchanged
    migration.json                  migration-copy marker — exists ONLY while a destination is being created (§12)
    staging/
      <stageId>/
        source.bin                  staged source bytes — non-authoritative INPUT, supported edit path (§5)
        stage.json                  optional { "displayName": … } — non-authoritative input
    derived/
      <sourceDigest>/
        <recipeDigest>/
          import.json               derived, regenerable decoded-import description
          <name>.bin                derived, regenerable binary caches
```

Artifact classes (normative):

| Path | Class | Authoritative? | In a complete backup? | Writer |
|---|---|---|---|---|
| `project.json` | immutable manifest | yes | yes | workspace (§8.3 of the accepted contract) |
| `scenes/main.json` | atomic authoring-state envelope | yes | yes | workspace only |
| `sources/sha256/<digest>` | immutable content-addressed source bytes | yes | **yes, all of them** (§11) | workspace only, write-once |
| `.thirdlight/staging/**` | staged input | **no** | no | the caller/harness or the workspace (§5) |
| `.thirdlight/derived/**` | derived cache | **no** (regenerable) | no | any content worker |
| `.thirdlight/ownership.json`, `claim-*` | ownership state | operational | **no** | workspace |
| `.thirdlight/recovery/**` | external-change evidence | no (evidence) | no (never restored over the envelope) | workspace |
| `.thirdlight/migration.json` | in-progress migration marker | no | no | workspace (§12) |
| `scenes/.main.json.tmp-*`, `sources/sha256/.<digest>.tmp-*` | temp files | no | no | workspace; cleaned on open |

Rules:

1. **The only mutable authoritative file is the envelope.** Content bytes are
   immutable and content-addressed; there is no second mutable catalog file, no
   side-car index, and no mutable content state outside the envelope
   (`m2-plan.md` §2.1/§3.1, `workspace.md` §4.1/§12).
2. `.thirdlight/derived/` and `.thirdlight/staging/` are **new sub-namespaces**
   inside the namespace the accepted `workspace.md` §3 reserves for
   ownership/claim/recovery (`m2-plan-review.md`, non-gating observation (a)).
   The `diffs/workspace.md` §3 diff adds them explicitly. They are not authoring
   documents, are excluded from every logical-document read, and their absence
   or corruption is never a project-blocking error.
3. Hidden (`.`-prefixed) artifacts are never authoring documents (accepted rule,
   unchanged). No content artifact is written outside the paths above.
4. **No public operation accepts a filesystem path.** Every content operation is
   addressed by project ID plus a model-level identifier (`assetId`, `version`,
   `stageId`, `digest`). `stageId` uses project-model §5.1 ID syntax, so path
   separators and `..` are unrepresentable. Digest-addressed reads are internal
   to the workspace.
5. Every artifact directory used by content storage (`sources`, `sources/sha256`,
   `.thirdlight`, `.thirdlight/staging`, `.thirdlight/derived` and their per-stage
   /per-digest children) must be a **real directory** whose resolved realpath stays
   under the project root; authoritative blobs are opened with `O_NOFOLLOW`.
   Any violation ⇒ `path_rejected` before the first write or read of the target
   (§7, C5). Symlinks are never followed and never repaired.
6. `.thirdlight/migration.json` exists only inside a destination that is being
   created and is removed before that destination is reported complete (§12).

## 3. Storage v2: the authoring-state envelope

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
    "behaviors": [],
    "settings": {}
  },
  "retry": { "retention": 128, "records": [] }
}
```

Byte-exact examples: `fixtures/m2/contracts/envelope/valid/demo-0002-rev7-v2.json`
(full) and `…/migration-minimal-v2.json` (empty containers).

| Field | Type | Constraint |
|---|---|---|
| `storageVersion` | integer | `1` or `2` in M2. `1` selects the accepted M1 pipeline **unchanged**; `2` selects the v2 pipeline below. Unknown ⇒ `storage_version_unsupported` (single error, deeper checks stop, bytes retained untouched). |
| `type` | string | exactly `"authoring-state"`. |
| `projectId` | string | equals the project directory name (and the manifest `id`). |
| `scene` | object | the logical scene; **in a v2 envelope `schemaVersion` must be exactly `2`** (§3.2). Validated by the v2 scene validation (project-model v2 registry, packet 20). |
| `content` | object | the content catalog: `assets`, `prefabs`, `behaviors`, `settings` — **all four keys are required in v2** (`[]`, `[]`, `{}`). `assets` is owned by `assets.md`; `prefabs`/`behaviors`/`settings` are reserved containers whose element/field shapes are packets 16/17/18's (an empty container is the only v2-valid value until those packets are accepted). |
| `retry` | object | unchanged: `{ "retention": 128, "records": [ … ] }` (commands.md §7.1). |

Normative rules:

- **`scene.revision` remains the sole project revision** and the sole ordering
  token. The content block carries no revision, no counter, no timestamp that
  orders state, and no digest of the project. Every content change happens in
  **one** atomic envelope replacement that also advances `scene.revision` by the
  command pipeline (`workspace.md` §4.1: one file ⇒ one rename per transaction).
- **No-opens-without-bump:** a change to `content` that a consumer can observe
  must advance `scene.revision`. Regenerating a derived cache, staging bytes and
  writing an unreferenced blob are **not** such changes and must not touch the
  envelope.
- Canonical key order (`workspace.md` §4.4 extended): envelope
  `storageVersion, type, projectId, scene, content, retry`; content block
  `assets, prefabs, behaviors, settings`; each `assets[i]` and its `versions[j]`
  per `assets.md` §4. `content.assets` is emitted in ascending `assetId`
  codepoint order; `versions` ascending by `version`.
- Strictness: unknown fields at any level ⇒ invalid (`envelope_invalid` for the
  envelope's own keys, `content_invalid` for the content block). Nothing is
  stripped, nothing is auto-migrated on load.

### 3.1 Version compatibility matrix (exhaustive)

| `manifest.schemaVersion` | `scene.schemaVersion` | `storageVersion` | Result |
|---|---|---|---|
| 1 | 1 | 1 | **valid** — the accepted M1 combination, M1 pipeline unchanged |
| 1 | 2 | 2 | **valid** — the only M2 combination (`content` present) |
| 1 | 1 | 2 | `version_combination_unsupported` (single error, stops before scene/content field validation) |
| 1 | 2 | 1 | `scene_invalid` → `schema_version_unsupported` (the M1 validator knows scene `[1]`; accepted behavior unchanged) |
| 2 | any | any | `manifest_invalid` → `schema_version_unsupported` for the manifest — **the manifest stays schemaVersion 1 in M2** |
| any | any | ≥3 or ≤0 | `storage_version_unsupported` |
| any | ≥3 | any | `schema_version_unsupported` for that document |

No other combination is passable. There is **no silent upgrade on open**: a
`storageVersion 1` envelope is loaded by the M1 pipeline exactly as accepted and
is never rewritten in place; converting a project is the explicit operator
workflow of §12. There is **no downgrade**: M2 writes only `storageVersion 2`
envelopes, and an M1-only engine opening one reports
`storage_version_unsupported` and retains the bytes (accepted rule).

### 3.2 Load validation pipeline (v2 branch, normative order)

At every open/reopen and at the startup scan, `scenes/main.json` bytes are
processed in this order; the first failing step produces the stated result and
stops. Steps 1–2 are shared with the accepted pipeline:

1. **Strict parse** — project-model §12.3 pass 1 (UTF-8, no BOM, strict JSON,
   duplicate keys). Bytes are retained untouched.
2. Root is an object, else `envelope_invalid` (`field_type`).
3. `storageVersion` present and known ∈ `{1, 2}`; unknown ⇒
   `storage_version_unsupported` (single error, stop).
4. `type === "authoring-state"` else `envelope_invalid`.
5. `projectId` equals the directory name, else `envelope_project_mismatch`.
6. **Branch on `storageVersion`:**
   - **`1` — the accepted M1 pipeline, verbatim**: fields exactly
     `{storageVersion, type, projectId, scene, retry}`; `scene` → `validateScene`;
     retry block; manifest and cross-document checks. No content path is read and
     no `sources/` directory is required to exist.
   - **`2` — the v2 pipeline (this proposal):**
     a. Envelope field set exactly
        `{storageVersion, type, projectId, scene, content, retry}`;
        missing/unknown key ⇒ `envelope_invalid`
        (`field_missing` / `field_unexpected`).
     b. **Version-combination check** (§3.1) — `scene.schemaVersion === 2` and
        `content` present. Failure ⇒ exactly one
        `version_combination_unsupported`; stop (field errors against a
        different version are meaningless).
     c. `scene` → v2 scene validation ⇒ `scene_invalid` (carries ≤ 10 model
        errors).
     d. `content` → `validateContent` (assets.md §10) ⇒ `content_invalid`
        (carries ≤ 10 model errors). Both c and d are evaluated and both error
        sets reported when both fail.
     e. **Cross-block check** — only when c and d both pass: every `assetId`
        referenced by a v2 model component resolves in `content.assets`, else
        `asset_reference_missing` (`document: "scene"`, path at the component).
     f. `content` canonical byte budget ≤ 1 048 576 ⇒ `content_invalid`
        (`limits_exceeded`, `limit: "content_bytes"`, §9).
     g. retry block (unchanged) ⇒ `retry_records_invalid`.
     h. manifest (must be `schemaVersion 1`) + cross-document checks ⇒
        `manifest_invalid` / `manifest_scene_mismatch`, and
        `manifest.id === envelope.projectId === directory name`.

On success the backend holds in memory additionally: the normalized content
catalog, a per-asset `currentVersion` map, and the content integrity report
(§8). History is empty, as before.

Error wrapping is unchanged in style (`workspace.md` §11): envelope-level codes
for the envelope, `scene_invalid` / `content_invalid` wrappers for the embedded
documents, each carrying at most 10 model error objects and a true count.

## 4. Immutable blob publication

Publishing an authoritative blob is exactly `workspace.md` §5.1
`W(bytes, target, dir)` with `target = sources/sha256/<digest>` and
`dir = sources/sha256/` — temp file in the same directory, file fsync, atomic
rename, directory fsync, verification read.

Normative rules:

1. **The workspace computes the digest** from the bytes it read; a caller-supplied
   digest is never authoritative. A named-but-mismatched digest is
   `blob_corrupt`, never a write.
2. **Write-once.** If `sources/sha256/<digest>` already exists, its content is
   read and hashed: match ⇒ **no write** (`alreadyPresent: true`, idempotent
   retry of a crash); mismatch ⇒ `blob_corrupt` and **no overwrite**. Refusing to
   overwrite a content-addressed path is what makes a foreign write or an
   external tamper detectable instead of silently absorbed.
3. **A blob publication changes no authoritative state.** It creates no
   reference, advances no revision, writes no retry record and requires no
   mutation lock. An unreferenced blob is inert; a referenced one is created only
   by the command pipeline (§6). This is why a crash between blob publication and
   the commit is safe.
4. **Durable before referenced:** a successful `W` includes the directory flush
   and the verification read, so an acked reference always has durable bytes
   (published *before* the command, §6).
5. **Temp hygiene** is extended by the same rule as `workspace.md` §5.4: on a
   successful open, after ownership is acquired and before any command, the owner
   removes every `sources/sha256/.<digest>.tmp-*` file. Only the owner ever writes
   them and the previous owner is gone, so the cleanup is safe.
6. Blobs are never truncated, rewritten, renamed away, hard-linked elsewhere or
   deleted in M2 (§10).

## 5. The supported staging area (BR-4)

`m2-plan.md` §3.5 states that the harness can edit source files in a declared
staging area. `m2-plan-review.md` BR-4 records the failure to prevent: the
harness edits behavior/source files under the project tree, the accepted
external-change protocol (`workspace.md` §7) treats that as an unexpected
external modification, pauses writes and writes a recovery snapshot, and the
publish then conflicts or the staged bytes are quarantined as "external".
**This section removes that failure mode by contract.**

### 5.1 Definition and invariants (normative)

The staging area is `<project>/.thirdlight/staging/<stageId>/`:

- `stageId` uses project-model §5.1 ID syntax (no path separators, so traversal
  through a stage ID is unrepresentable).
- The staged source file has the **fixed** name `source.bin`. A caller-provided
  file name is never used as a path; it may only be sanitized into a suggested
  `displayName` (1–128 chars, no control characters) recorded in `stage.json`.
- Staged bytes are written by the workspace with `O_NOFOLLOW` and the artifact
  directory checks of §2 rule 5; the checks run *before* the first write.

Invariants:

1. **Staging is a supported edit path.** `workspace.md` §5.2's pre-write check
   and §7's unexpected-external-modification protocol are scoped to the
   **authoring files** (`scenes/main.json`; the manifest at creation). They
   **must not** be extended to any path under `.thirdlight/**` — including
   `.thirdlight/staging/**`. Creating, replacing, truncating or removing files
   under the staging area therefore triggers **no pause, no recovery snapshot,
   no `external_change_unresolved`** and no quarantine. This binds both the
   backend and any future watcher.
2. **Staging is never authoritative and never read to determine state.** No
   load, validation, query, projection, snapshot, play, export or recovery path
   reads staging. Deleting the whole staging area at any time loses nothing
   authoritative; a client that loses its stage re-stages from its own source of
   truth.
3. **Staged bytes are untrusted input.** At every use the workspace recomputes
   the digest from the bytes actually on disk, enforces the caps of §9, applies
   the traversal/symlink refusal of §2 rule 5, and runs the full import profile
   (`assets.md` §7). A concurrent edit between read and publish can at most change
   *which* of the observed byte strings is published — never corrupt one: the
   published blob is the exact byte string the workspace hashed.
4. **The mutation lock is never held while reading staging.** Staging reads,
   inspection and blob publication happen outside the lock (§6.3).
5. **A pause does not quarantine staging.** While an external change to the
   envelope is unresolved, staging writes and inspection still work; the
   *command* that would commit content is refused with
   `external_change_unresolved` (the accepted pipeline's step 3) and the staged
   bytes remain exactly where they are. After the operator resolves the change,
   the same staged bytes can be published.
6. **No command argument ever references a staging handle** (§6.2). The
   authoritative content command is addressed by `assetId` + `sourceDigest`, so a
   lost-ack retry never needs a stage.

### 5.2 Lifecycle, bounds and cleanup

- A stage handle is `(projectId, stageId)`. It is valid while the directory
  exists and is younger than the **stage TTL** of 3 600 s; after the TTL a *new*
  request that resolves it fails `stage_expired` (§9).
- **A successful publish does not delete the stage.** Deletion is not part of the
  commit path, so no commit/cleanup ordering can affect replay. The caller may
  `discardStage` explicitly; otherwise the abandoned-stage retention removes the
  directory once its mtime is older than 24 h.
- Cleanup runs on a successful open (after ownership) and only ever removes
  directories under `.thirdlight/staging/`. It never touches authoritative paths.
- Bounds: ≤ 32 MiB per stage, ≤ 8 open stages per project, ≤ 128 MiB of staged
  bytes per project, ≤ 1 048 576 bytes per upload frame (§9). Exceeding a bound
  fails **before** the file is created or extended whenever the bound is
  knowable from the frame/dir listing.

## 6. Publication pipeline and crash boundaries

### 6.1 Two layers, one authoritative step

Content publication is deliberately split so that the *authoritative* step is a
pure, stage-free command:

| Layer | Operation | Authoritative? | Mutation lock? | Repeatable? |
|---|---|---|---|---|
| preparation | `stageContent` (§5) | no | no | yes (idempotent per digest) |
| preparation | `inspectStage` → `ImportProposal` (`assets.md` §8) | no | no | yes |
| preparation | `publishBlob` (§4) | creates immutable bytes only | no | yes (write-once + verify) |
| **authority** | the content mutation command (`DELEGATED`: packets 21/23), args `{ mode, assetId, displayName?, sourceDigest, sourceByteLength, importRecipe, metrics }` | **yes** | **yes** (commands.md §6.1, §10) | yes (retry record / dedup) |
| read | `readBlob`, `contentIntegrity`, `captureContentView` (§8) | read-only | no | yes |

Consequence (normative, and the packet's dedup requirement):
**deduplication precedes every staging or blob lookup.** The command carries no
staging handle, and its args contain only durable, digest-addressed facts, so an
identical retry is served from the retry record map at commands.md §6.1 step 2 —
before the revision check, before argument validation, before any staging
resolution, and even while writes are paused (accepted behavior) — and it neither
re-publishes bytes nor needs the stage to exist. Any composition that resolves a
stage before issuing the command must first establish that the command is not a
replay; that probe is the same pure retry-map read.

### 6.2 Client-visible ordering

For a fresh (non-replay) publication of a created/reimported asset version:

1. **Preparation (no lock).** Resolve the stage ⇒ refusal checks ⇒ caps ⇒ read
   bytes ⇒ digest ⇒ import-profile validation (`ImportProposal`).
2. **Immutable publication (no lock).** `publishBlob` creates
   `sources/sha256/<digest>` durably (write-once, verified).
3. **Quota pre-flight (no lock, re-checked under the lock).** Project quota and
   device free space (§9); failure ⇒ `content_quota_exceeded` with nothing
   written by the command.
4. **Command pipeline (lock held).** commands.md §6.1 steps 1–9: project/
   ownership resolution, dedup, pause check, revision check, pure validation and
   application (which **verifies that the referenced blob exists and matches its
   digest** — `blob_missing` / `blob_corrupt` ⇒ no state change), no-change check,
   the single atomic envelope write carrying the new scene revision **and** the
   new content block **and** the new retry record, in-memory publish, ack.
5. **Ack.** After the envelope write completed including directory flush and the
   verification read (workspace.md §5.3). A success ack implies the catalog
   reference and its bytes are both durable.

A crash or failure before step 4 may leave **unreferenced immutable bytes**
(never an acked dangling reference). A crash after step 4's rename is the accepted
envelope crash semantics.

### 6.3 Lock scope (normative)

The per-project mutation lock is held only for step 4 and the read operations
that need a consistent snapshot. It is **never** held while: framing/reading
staged bytes, inspecting/decoding a GLB, hashing a source blob, publishing a
blob, waiting for a job slot, or performing any filesystem or CPU work whose
duration scales with the content. No long job holds the lock. Any implementation
that holds the lock across inspection or blob publication violates this section
even if its observable results happen to match.

### 6.4 Crash-point table (content publication)

| Crash/failure point | On disk after restart | Retry of the same requestId |
|---|---|---|
| during staging read / inspection | unchanged (+ possibly a partial staged temp, removed on open) | fresh execution (no record); nothing published |
| during `publishBlob` | envelope unchanged; possibly a leftover `sources/sha256/.<digest>.tmp-*` (removed on open) | fresh execution; blob re-published |
| after `publishBlob`, before the command | envelope unchanged; one unreferenced blob | fresh execution; blob write skipped after digest verification |
| inside the envelope write | accepted `workspace.md` §5.1 table (old or new envelope; complete document) | replay (record present) or fresh execution (record absent) |
| after the envelope commit, before the ack | new envelope with the record | replay, `duplicated: true`; **no** stage or blob lookup |
| after the ack | as committed | replay, `duplicated: true` |

## 7. Failure and recovery matrix

Every row is normative; "no state change" means no scene, content, revision or
retry-record change and no envelope write. Fixtures in
`fixtures/m2/contracts/cases/` and `cases/constructed-cases.md`.

| # | Failure | Detected at | Result | Durable effect | Recovery |
|---|---|---|---|---|---|
| F1 | path traversal / symlinked artifact dir or blob | artifact path checks (§2 rule 5, §5.1) | `path_rejected`, no read/write of the target | none | fix the path by hand; the backend never follows, repairs or deletes it |
| F2 | malformed GLB (magic/version/length/chunks/JSON/accessors/meshes/materials/images/animations/nodes) | import-profile validation (`assets.md` §7) | `import_rejected` with ordered diagnostics | none | fix the source and re-stage |
| F3 | remote/external/data URI in the GLB | `assets.md` §7 step 7/11 | `import_rejected` → `asset_uri_rejected` | none | embed the resources; no URL fetch exists in M2 |
| F4 | unsupported required extension / compression | `assets.md` §7 step 5/9/10 | `import_rejected` → `asset_extension_unsupported` / `asset_compression_unsupported` | none | re-export without the extension |
| F5 | decoded-resource cap exceeded | `assets.md` §6 caps | `import_rejected` → `limits_exceeded` (+ `limit`) or `content_invalid` for persisted metrics | none | reduce the model or raise the contract cap at Gate E |
| F6 | source over the byte cap / frame cap | staging caps (§5.2, §9) | `stage_limits_exceeded` | none (the stage file is not created/extended) | split or reduce the source |
| F7 | quota or device space insufficient | quota pre-flight (§6.2 step 3) and again under the lock | `content_quota_exceeded` (`kind: "project_quota" | "device_space"`) | none | free space / raise the configured quota; M2 never evicts to make room |
| F8 | ENOSPC/EIO during `publishBlob` | `W` failure classification | `content_publish_failed` | envelope unchanged; at most a leftover temp (removed on open) | retry the same request |
| F9 | ENOSPC/EIO during the envelope write | accepted `workspace.md` §5.1 | `write_failed` (`onDiskState`) | old or new envelope; at most the documented `new-undurable` case | accepted retry semantics |
| F10 | missing authoritative blob | commit-time verification (§6.2 step 4) / `readBlob` / integrity report | `blob_missing`; commit refused | none (or, for a later read, no change) | restore from backup or re-import the version |
| F11 | corrupted/tampered authoritative blob | digest verification on every read (`§8`) | `blob_corrupt`; bytes retained | none | restore the correct bytes; never auto-repaired |
| F12 | derived cache missing/corrupt | derived lookup | `derived_cache_unavailable` (warning) | regenerated from `sources/` | automatic regeneration; never fetched from a URL |
| F13 | stale/abandoned stage | stage resolve / TTL | `stage_expired` (`stage_not_found` if never staged) | none | re-stage and re-issue |
| F14 | identical retry with an expired/cleaned stage | dedup, commands.md §6.1 step 2 | **replay** (`duplicated: true`) | none | none needed |
| F15 | ownership lost / conflict at commit | pipeline step 1 + claim verification at write time | `ownership_conflict` | possibly one unreferenced blob | re-open/takeover, then retry (idempotent blob write) |
| F16 | stale revision (inspection long past, concurrent publish) | pipeline step 4 | `revision_conflict` (+ `currentRevision`) | none | re-read and re-issue with a fresh requestId; the proposal stays a proposal |
| F17 | crash at any publication boundary | restart/open | see §6.4 | unreferenced bytes at worst | retry; temps cleaned on open |
| F18 | v1/v2 mismatch / unknown version | load pipeline §3.1/§3.2 | `version_combination_unsupported`, `storage_version_unsupported`, `scene_invalid`, `manifest_invalid` | none; bytes retained | open with a matching engine; migration is explicit (§12) |
| F19 | interrupted migration-copy creation | startup scan / open | reported as an interrupted migration destination; **never auto-completed** | partial destination (marker + manifest [+ blobs]) | resume `migrateProjectCopy` (§12) or delete the destination directory |
| F20 | migration source invalid or destination occupied | migration preconditions | `migration_source_invalid` / `migration_destination_exists` | none | fix the source / choose a new ID |
| F21 | migration marker conflict | resume check | `migration_marker_conflict` | none | inspect the destination by hand; nothing is overwritten |
| F22 | external tamper of a superseded (non-current) version blob | integrity report / read | `blob_corrupt`, `referenced: false` in the report | none | restore from backup; undo/history that pins it stays failing closed |

## 8. Reading content: integrity, tamper and derived caches

### 8.1 Reads

- `readBlob(projectId, { assetId, version })` — the only public byte read. It
  resolves the version's `sourceDigest` from the last acknowledged catalog,
  checks the artifact-path rules, reads `sources/sha256/<digest>`, **verifies the
  digest before returning**, and returns bytes plus `{ digest, byteLength }`.
  There is no public read by path, and no read of a version that the catalog does
  not contain (`asset_not_found` / `asset_version_not_found`).
- Reads never mutate: no temp file, no derived write, no envelope write, no
  revision change. A failed read leaves every artifact untouched.

### 8.2 Integrity report and missing/corrupt handling

- `contentIntegrity(projectId)` returns, for every catalog record version:
  `{ assetId, version, sourceDigest, referenced, status: "ok" | "missing" |
  "corrupt" | "unreadable" }`, plus a bounded summary. It is computed at open
  (bounded by the catalog caps, §9) and on demand.
- **Fail closed, not block:** a missing/corrupt blob never blocks opening,
  querying, or mutations that do not read those bytes, and it never causes the
  envelope, catalog or scene to be rewritten. Operations that need the bytes fail
  with `blob_missing` / `blob_corrupt` and an actionable message naming the
  assetId, version, digest, project-relative path and the two supported repairs
  (restore the authoritative bytes from a backup, or re-import the version as a
  new version). No silent substitution of another version, no degraded placeholder
  geometry, no fabricated bytes.
- **External-source tamper handling:** `sources/sha256/<digest>` is authoritative
  and content-addressed, so (a) a modified file no longer matches its name and is
  detected by hashing on every read; (b) the tampered bytes are retained
  byte-for-byte and never auto-deleted or auto-repaired; (c) a symlink at the blob
  path is refused (`path_rejected`) rather than followed; (d) because all pinned
  readers (play, export, history, retries) verify, an external tamper can never
  silently change rendered or exported content — it becomes a loud, actionable
  failure.

### 8.3 Derived caches

- Key: `.thirdlight/derived/<sourceDigest>/<recipeDigest>/`, where
  `recipeDigest = SHA-256(canonical JSON of the importRecipe value)` with
  canonical JSON as in commands.md §6.6 rule 2 (keys sorted codepoint-safe, no
  insignificant whitespace). `importRecipe` pins the profile, the recipe version
  and the exact tool versions (`assets.md` §5), so the key changes whenever the
  decoded result could change.
- Contents: `import.json` (the bounded decoded-import description: names,
  indices, metrics — display/diagnostic data, **never a reference source**) and
  optional binary caches.
- **Regenerable and deterministic:** for a given `(sourceDigest, recipeDigest)`
  the derived result must be byte-deterministic; deletion of `.thirdlight/derived/**`
  is always recoverable by re-running the pinned recipe over the authoritative
  blob with **no network access**. Derived content is never fetched from a URL and
  never read to determine project state.
- **Never authoritative:** a derived cache can be deleted or regenerated at any
  time, including while the project is open or play is running; it is not in a
  complete backup (§11) and it never participates in the revision or in any
  digest a snapshot/export records.
- Names/indices inside a derived cache (glTF node/material/clip names, indices)
  are **not** engine IDs and must never be persisted as references
  (`assets.md` §3).

## 9. Bounds

All values are proposed and must be pinned at Gate E before the packet-24/25
fixtures and tests choose thresholds. Exceeding a bound fails **before**
publication whenever the bound is knowable then.

| Class | Bound | Value | Failure |
|---|---|---|---|
| byte | source blob / staged source / upload request | 33 554 432 B (32 MiB) | `stage_limits_exceeded` (`stage_bytes`), `content_invalid` (`limits_exceeded` → `source_bytes`, persisted) |
| byte | content block, canonical | 1 048 576 B (1 MiB) | `content_invalid` (`limits_exceeded` → `content_bytes`), no envelope write |
| byte | upload frame (transport) | 1 048 576 B | `stage_limits_exceeded` (`frame_bytes`) |
| byte | import-proposal response | 262 144 B (bounded name lists, `truncated: true`) | never produced (truncated instead) |
| byte | GLB JSON chunk / BIN chunk | 8 388 608 B / 33 554 432 B | `import_rejected` (`limits_exceeded`) |
| decoded | per version: nodes / meshes / primitives / materials / images / textures | 4 096 / 1 024 / 8 192 / 512 / 64 / 512 | `import_rejected` / `content_invalid` (`limits_exceeded` + `limit`) |
| decoded | per version: vertices / triangles | 2 000 000 / 4 000 000 | as above |
| decoded | per version: animations / animation channels / clip duration | 64 / 4 096 / 600 000 ms | as above |
| decoded | per version: geometry bytes / image bytes / total | 268 435 456 / 268 435 456 / 536 870 912 B | as above |
| catalog | assets / versions per asset / total version records | 128 / 32 / 1 024 | `content_invalid` (`limits_exceeded`), no envelope write |
| staging | open stages per project / staged bytes per project / stage TTL | 8 / 134 217 728 B / 3 600 s | `stage_limits_exceeded`, `stage_expired` |
| staging | abandoned-stage retention | 24 h by directory mtime | silent non-authoritative cleanup on open |
| job | concurrent publishes per project / globally / inspection / publish | 2 / 4 / 30 s / 120 s | `content_publish_failed` (`busy` / `timeout`), `import_rejected` (`timeout`) |
| quota | authoritative bytes per project (`maxSourceBytesPerProject`), default | 536 870 912 B (512 MiB), deployment-configurable | `content_quota_exceeded` (`project_quota`) |
| quota | free device space required before a blob write | `blobBytes + 67 108 864` | `content_quota_exceeded` (`device_space`) |

Bounds are counted over **retained** bytes: superseded versions stay inside the
project quota, because M2 has no GC (§10).

## 10. Ownership, disposal and retention

- The workspace owns every path, blob publication and envelope commit. Content
  workers (import/build) receive **bounded bytes and configuration** and return
  proposals; they never receive authority over project state, never write the
  envelope, and never choose asset IDs.
- **M2 has no garbage collection.** No operation deletes an authoritative blob or
  removes a catalog version. Superseded versions and their bytes are retained
  because undo/redo, history, retained retry records, retained snapshots and any
  running play or export can still pin them; "no GC can invalidate play/history"
  is therefore structural, not a policy promise.
- The only disposal in M2 is non-authoritative: abandoned staging directories
  (§5.2) and derived caches (§8.3). Both are safe to delete at any moment,
  including while the backend runs.
- Unreferenced blobs left by a crash between blob publication and the commit are
  **retained**, not cleaned: deleting them would require the workspace to prove
  that nothing (including a retained retry record or a snapshot it cannot see)
  references them, which M2 does not attempt. They are reported only as
  "unreferenced" in a scan summary.
- In-memory history is discarded by `releaseWorkspace`/process exit as accepted
  (commands.md §9.2); that never affects blobs.
- Asset deletion, if a later version adds it, must (a) retain all blobs,
  (b) define a never-reuse rule for `assetId` (or a tombstone), and (c) be a
  reviewed version change — none of which is M2.
- **Quota cliff (stated limitation):** because M2 provides no blob deletion and
  no eviction, a project that reaches `maxSourceBytesPerProject` cannot import
  more content until the operator raises the configured quota or removes
  authoritative bytes by hand outside this contract. The backend fails closed with
  an actionable message; it never evicts retained versions to make room.

## 11. Artifact backup classification

A "complete M2 source backup" of a project means exactly this set, copied
consistently (the project must be released or the backend stopped):

| Class | Included | Reason |
|---|---|---|
| `project.json` (manifest) | **yes** | needed to open at all; immutable |
| `scenes/main.json` (envelope: scene + content + retry) | **yes** | the sole mutable authoritative state; contains the catalog that names every blob |
| `sources/sha256/<digest>` — every file, including superseded versions | **yes** | history/undo, retained snapshots, retained retry records, play and export pins; also the *only* copy of the content bytes |
| `.thirdlight/staging/**` | no | caller-owned input; re-stage |
| `.thirdlight/derived/**` | no | regenerable from sources + recipe, no network |
| `.thirdlight/ownership.json`, `claim-*` | no | restoring a live-looking ownership record would create false ownership; ownership is re-established by claim/takeover |
| `.thirdlight/recovery/**` | no (optional evidence retention) | repair aid; must never be restored *over* the envelope |
| `.thirdlight/migration.json` | no | describes an in-progress destination only |
| temp files | no | cleaned on open |

Restore procedure (normative): restore the included set into a clean project
directory with the **same `projectId`** (the manifest `id`, the envelope
`projectId` and the directory name must agree), then open. Verification after
restore: (1) `contentIntegrity` reports every catalog record version `ok`; (2)
the load pipeline succeeds; (3) a fresh play/export uses the same digests as the
backup's envelope names; (4) no network access is needed. A restore that omits
any authoritative blob is reported as `blob_missing` per §8.2 — never silently
degraded. Backups are an operator procedure; no backup service exists in M2.

## 12. Migration: M1 project → M2 project copy

Migration is **explicit, operator-driven and non-destructive**. It is never an
open-time side effect.

### 12.1 Preconditions

- The source project ID exists, is loadable under the **accepted M1 pipeline**
  (`storageVersion 1`, scene `schemaVersion 1`, manifest v1), and is not
  currently owned by a live *other* backend (the migration reads the source; it
  does not write it).
- The destination project ID is a new, valid ID syntax value and
  `<root>/projects/<newProjectId>` does not already contain a loadable project or
  a migration marker for different IDs.
- Operator-scoped only: never exposed to the browser or MCP as a mutation.

### 12.2 Result and identity/revision policy

| Aspect | Policy |
|---|---|
| destination identity | **new project** (`newProjectId`); a new manifest with `id = newProjectId`, the source `name` carried over, a new `createdAt` |
| manifest schemaVersion | stays **1** (M2 combination) |
| scene | `schemaVersion` 1 → **2**, entities carried over **verbatim** (byte-identical values: IDs, names, order, transforms, components, materials) |
| storage | `storageVersion` 1 → **2**, with empty `content` containers (`assets: []`, `prefabs: []`, `behaviors: []`, `settings: {}`) |
| revision | **reset to 0** (`revisionPolicy: "reset-to-zero"`) |
| retry records | **cleared** (`retry.records: []`), `retention` 128 |
| history | not carried (it is in-memory only in M1; the destination starts with empty history) |
| source project | **retained byte-for-byte**; never claimed, released, rewritten or touched |
| reported | `{ sourceProjectId, newProjectId, sourceRevision, newRevision: 0, revisionPolicy, historyReset: true, retryCleared: true, blobsCopied: n, resumed: boolean }` |

Rationale for reset-to-zero: the destination is a different project identity, so
carrying the source's revision would import a counter from another revision
history while history and retry records are explicitly cleared; a reset makes the
"new project, new boundary" statement unambiguous and reproducible, exactly like
the accepted release/reopen boundary (commands.md §9.2). Snapshot identity
(`<projectId>@r<revision>`) already distinguishes the two projects.

### 12.3 Ordered write sequence and crash completion

Writes go **destination-first, authoritative-last** — the same blob-before-
envelope discipline as §6:

1. `mkdir <dest>`, `mkdir <dest>/.thirdlight` (0755).
2. **Write `.thirdlight/migration.json`** (marker) — `{ storageVersion: 1,
   type: "migration-copy", sourceProjectId, newProjectId, phase, startedAt }`
   with `phase` recording the last completed step (`created` → `manifest` →
   `blobs` → `envelope`).
3. Write the destination manifest (`project.json`) via `W`.
4. Copy every source blob to `sources/sha256/<digest>` via `W`, verifying each
   digest after the write (M1 sources have none today, so this step is usually a
   no-op; it exists because a numbered future source version may).
5. **Write the destination envelope last** (`scenes/main.json`, §12.2 values via
   `W`). This is the commit point: before it, the destination is not a loadable
   project.
6. **Remove the marker.** The destination is reported complete only after this.

Crash completion (normative):

- A directory containing a valid migration marker and **no envelope** is
  reported by the startup scan as an interrupted migration destination. The
  accepted `workspace.md` §8.3 deterministic completion (default envelope) is
  **suppressed** for such a directory — auto-completing it would create an empty
  default project and destroy the migration intent. (This is one clause added to
  §8.3 and one startup-scan row; see `diffs/workspace.md`.)
- The operator either re-runs `migrateProjectCopy(sourceProjectId,
  newProjectId)` — idempotent: it re-verifies existing files against their
  expected canonical bytes (`project.json`), re-verifies/copies blobs, and
  continues from the recorded `phase` — or deletes the destination directory,
  which is always safe because nothing in it was ever authoritative.
- A marker whose `sourceProjectId`/`newProjectId` do not match the request ⇒
  `migration_marker_conflict`; an existing loadable destination ⇒
  `migration_destination_exists`; both refuse without writing.
- `phase: "envelope"` with a loadable envelope means step 5 succeeded and only
  step 6 (marker removal) was interrupted: the resume path verifies the envelope
  equals the expected canonical bytes and removes the marker without rewriting it.

### 12.4 No silent upgrade, no downgrade

- Opening a v1 project under M2 uses the M1 pipeline unchanged; M2 never rewrites
  it and never writes a v2 envelope into it.
- Migration always creates a **new** project; there is no in-place conversion, no
  partial manifest/envelope upgrade, and no "upgrade on save".
- Downgrade does not exist: M2 has no v1 writer, and an M1-only engine reports
  `storage_version_unsupported` for a v2 envelope while retaining the bytes
  (accepted non-destructive rule).
- M1 loading, editing and export paths are unaffected by this section: they
  continue to operate on `storageVersion 1` projects exactly as accepted
  (acceptance row A01).

## 13. Workspace operations and error codes

### 13.1 Operations

| Operation | Kind | Lock | Success result | Failure codes |
|---|---|---|---|---|
| `stageContent(projectId, { stageId, bytes, displayName? })` | caller/harness input | none | `{ ok, stageId, byteLength, digest, expiresAt }` | `stage_limits_exceeded`, `path_rejected`, `project_not_found`, `project_unavailable` |
| `inspectStage(projectId, stageId)` | proposal | none | `InspectStageResult` = `{ ok: true, proposal }` (`assets.md` §8) | `stage_not_found`, `stage_expired`, `import_rejected`, `derived_cache_unavailable` (non-fatal warning) |
| `publishBlob(projectId, { digest, byteLength, source })` | immutable publication | none | `{ ok, digest, byteLength, published, alreadyPresent }` | `blob_corrupt`, `content_quota_exceeded`, `content_publish_failed`, `path_rejected`, `stage_not_found`, `stage_expired` |
| content mutation command (`createAssetVersion` … `DELEGATED` to packets 21/23) | **authoritative** | pipeline §6.1 | the commands.md §5.1 success payload (`revision`, `change`, `history`, …) | commands.md §5.4 codes plus `content_invalid`, `asset_id_duplicate`, `asset_not_found`, `blob_missing`, `blob_corrupt`, `content_quota_exceeded` |
| `discardStage(projectId, stageId)` | cleanup | none | `{ ok, discarded }` | `stage_not_found` |
| `readBlob(projectId, { assetId, version })` | verified read | none | `{ ok, assetId, version, digest, byteLength, verified: true, bytes }` | `asset_not_found`, `asset_version_not_found`, `blob_missing`, `blob_corrupt`, `path_rejected` |
| `contentIntegrity(projectId)` | read | none | `{ ok, entries, summary }` | `project_not_found`, `project_unavailable` |
| `captureContentView(projectId)` | pure derivation | none | `{ ok, view: CapturedContent }` (`assets.md` §9) | `project_not_found`, `project_unavailable` |
| `releaseWorkspace`, `takeoverWorkspace`, `acceptExternalState`, `discardExternalState`, `createProject`, `scan` | accepted, unchanged | — | as accepted | as accepted |
| `migrateProjectCopy(sourceProjectId, newProjectId)` | operator | source read only | §12.2 result | `migration_source_invalid`, `migration_destination_exists`, `migration_marker_conflict`, `migration_resume_required`, `path_rejected`, `content_publish_failed` |

`migrateProjectCopy` is not a browser/MCP mutation and is not exposed through the
command pipeline (like the accepted operator commands).

### 13.2 New workspace error codes

| Code | Raised when |
|---|---|
| `content_invalid` | the `content` block fails validation (carries ≤ 10 model errors, true count) |
| `version_combination_unsupported` | a v2 envelope with `scene.schemaVersion !== 2` (single error, stops) |
| `stage_not_found` | the stage directory does not exist |
| `stage_expired` | the stage exists but is older than the stage TTL (a new request must re-stage) |
| `stage_limits_exceeded` | a staging bound is exceeded (`limit`: `stage_bytes` / `frame_bytes` / `open_stages` / `staged_bytes_per_project`) |
| `path_rejected` | an artifact path is a symlink, escapes the project root, or is otherwise not a real directory/file under the project |
| `import_rejected` | the import profile rejects the bytes (carries the ordered diagnostics from `assets.md` §7, ≤ 10 plus a count) |
| `asset_id_duplicate` | a `create` targets an `assetId` that already exists |
| `asset_not_found` | an operation names an `assetId` the catalog does not contain |
| `asset_version_not_found` | an operation names a version the record does not contain |
| `blob_missing` | a referenced authoritative blob does not exist |
| `blob_corrupt` | a blob's content does not match its digest (or an existing path holds other bytes) |
| `content_quota_exceeded` | project quota or device free space is insufficient (`kind`: `project_quota` / `device_space`; carries used/limit/needed) |
| `content_publish_failed` | a non-envelope phase of publication failed (`reason`: `write` / `timeout` / `busy`; carries `onDiskState` for the blob phase) |
| `derived_cache_unavailable` | a derived cache is missing/corrupt and could not be regenerated |
| `migration_source_invalid` | the source project is missing or does not load under the M1 pipeline |
| `migration_destination_exists` | the destination already contains a loadable project |
| `migration_marker_conflict` | a marker exists for different source/new IDs |
| `migration_resume_required` | an interrupted destination must be resumed (informational, returned with the scan entry and the operation result) |

New model error codes (`project-model.md`): `version_combination_unsupported`,
`asset_reference_missing`, `digest_invalid`, `asset_version_invalid`,
`recipe_invalid`, plus new `limits_exceeded.limit` values. Full list and shapes in
`assets.md` §10/§12 and `diffs/project-model.md`.

## 14. Public exports (proposed)

`@thirdlight/workspace` (additions to the accepted service interface; nothing
accepted is removed or renamed):

```ts
// non-authoritative preparation (no lock, repeatable)
stageContent(projectId: string, request: StageRequest): StageResult;
inspectStage(projectId: string, stageId: string): InspectStageResult;
publishBlob(projectId: string, request: BlobPublishRequest): BlobPublishResult;
discardStage(projectId: string, stageId: string): StageDiscardResult;

// verified reads (no lock)
readBlob(projectId: string, request: BlobReadRequest): BlobReadResult;
contentIntegrity(projectId: string): ContentIntegrityResult;
captureContentView(projectId: string): CaptureViewResult;

// operator
migrateProjectCopy(sourceProjectId: string, newProjectId: string): MigrationResult;

// types
export type {
  StageRequest, StageResult, StageDiscardResult, InspectStageResult,
  BlobPublishRequest, BlobPublishResult, BlobReadRequest, BlobReadResult,
  ContentIntegrityResult, ContentIntegrityEntry, CaptureViewResult, MigrationResult,
};
export type { ImportProposal } from '@thirdlight/asset-pipeline'; // packet 24
export type { ContentCatalog, AssetRecord, AssetVersion, ImportRecipe, AssetMetrics, CapturedContent } from '@thirdlight/project-model';
```

The authoritative content mutation is deliberately **not** on this surface as a
new named operation: it is an ordinary command executed by the accepted
`runCommand` (packets 21/23 add its op, args, inverse, projection and MCP
coverage as commands.md diffs).

`@thirdlight/project-model` (v2 additions): `ContentCatalog`, `AssetRecord`,
`AssetVersion`, `ImportRecipe`, `AssetMetrics`, `CapturedAssetVersion`,
`CapturedContent`, `captureContent(...)`, `validateContent`, `normalizeContent`,
`validateProjectV2`, the extended error constants — exact shapes and signatures in
`assets.md` §4/§9/§12 and `diffs/project-model.md`.

`@thirdlight/asset-pipeline` (new, packet 24): `inspectGlb(bytes, options) →
ImportProposal`, the `ImportProposal`/diagnostic types, the profile constants
(including the extension allowlist). It is pure: no filesystem, no cache writes.

## 15. Compatibility and change rules

- The accepted M1 pipeline and the accepted v1 envelope semantics are unchanged.
  A v2-only behavior must never be reachable from a `storageVersion 1` envelope.
- Adding a field to the `content` block, changing an existing field's meaning, or
  changing a bound is a reviewable change. Field-level changes require a new
  `storageVersion` unless the field is optional **and** always defaulted, and even
  then only where the accepted contract's own rules allow it — by default this
  proposal follows the M1 strictness (no same-version extensions).
- Changing a bound (§9) is a contract change with the same review as a schema
  change, because fixtures and tests reference the exact values.
- Fixtures are part of the contract: changing an expected code or a byte-exact
  fixture requires the same review.
- `workspace.md` §12's "no multi-file transactions / assets require a new
  persistence contract" is satisfied **by this document**: content adds no
  authoritative file beyond the envelope, and the only multi-file sequence
  (immutable blobs before one atomic envelope replacement, and the migration
  copy) has an explicit ordering and crash-completion rule here.

## 16. What is deliberately not in M2

- No garbage collection, blob deletion, version eviction, refcounting or
  compaction (a later milestone may propose them; they must not invalidate
  history, snapshots, retries or play).
- No second mutable catalog, no side-car index, no database, no journal/WAL
  beyond the accepted single-envelope scheme.
- No in-place migration, no automatic upgrade on open, no downgrade, no partial
  envelope/manifest upgrades.
- No content fetch from the network: no URL import, no remote source, no CDN
  cache, no telemetry on read.
- No filesystem paths in any public operation; no `file://`, `http(s)://` or
  absolute path values in any persisted document.
- No compression/compaction of blobs, no deduplication across projects, no
  content-addressable store beyond the project tree.
- No watcher-based correctness: staging is safe because it is out of the
  authoring scope, not because a watcher exists.

## 17. Fixture index

`fixtures/m2/contracts/` (machine-readable index:
`fixtures/m2/contracts/expected.json`; checks:
`fixtures/m2/contracts/tools/check-fixtures.mjs`, recorded in
`docs/acceptance/evidence-m2/15/`):

| Fixture | Pins |
|---|---|
| `envelope/valid/demo-0002-rev7-v2.json` | the M2 combination, content block shape and canonical key order (§3) |
| `envelope/valid/migration-minimal-v2.json` | required empty containers; the migration destination shape (§12) |
| `envelope/invalid/version-combination-v2-v1-scene.json` | the combination check running before field validation (§3.1/§3.2) |
| `envelope/invalid/content-*.json` | strict content validation, digest/version/pointer rules, `limits_exceeded`, wrapper codes (§3.2, `assets.md` §10) |
| `envelope/invalid/asset-reference-missing.json` | the cross-block reference check (§3.2e) |
| `envelope/invalid/scene-invalid-v2.json` | `scene_invalid` wrapping in v2 (§3.2c) |
| `catalog/content-block-example.json` | the content block value alone |
| `catalog/captured-content-view.json` | the captured view and a recomputable `contentDigest` (`assets.md` §9) |
| `migration/v1-source/**`, `migration/expected-v2-destination/**` | non-destructive migration: identity, versions, revision policy, verbatim entities, source hashes (§12) |
| `migration/interrupted-copy/**` | the marker and the never-auto-complete rule (§12.3) |
| `cases/publish-*.json` | one authoritative commit, dedup-before-stage, crash points, quota/ENOSPC, ownership loss, stale import (§6/§7) |
| `cases/staging-*.json` | the supported staging path and traversal/symlink refusal (§5) — BR-4 |
| `cases/blob-*.json`, `cases/derived-cache-*.json`, `cases/reimport-undo-*.json` | integrity, tamper, regeneration, retention (§8/§10) |
| `cases/migration-interrupted-copy-resume.json` | crash completion and resume (§12.3) |
| `cases/constructed-cases.md` | count/byte boundaries, symlink trees, version matrix (§9, §3.1) |

Packet 20/21/23/24 must turn the declarative cases into executable tests and must
not weaken a declared code, ordering or bound to make a test pass.
