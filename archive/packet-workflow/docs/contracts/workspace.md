# Thirdlight — Workspace & Persistence Contract

Version: 0.1 (normative, pending Gate A acceptance) · Packet 02 · 2026-09-17
Scope: M1 durable workspace — the atomic authoring-state envelope, atomic
write/recovery protocol, ownership, external-change handling, project
creation, and artifact locations.

Companion documents (same packet, review together):

- `docs/contracts/commands.md` — command semantics, revision/retry rules
  (this document is normative for what is durable and how; commands.md is
  normative for command behavior).
- `docs/contracts/project-model.md` v0.2 — the logical documents embedded
  in / validated against the envelope.
- `docs/environment.md` — the supported host (Linux, ext4, Node v22.22.1).
- Fixtures: `fixtures/commands/` (envelope fixtures and crash/ownership/
  external-change scenarios).

Normative keywords **must**, **must not**, **should**, **may** are used in
the RFC 2119 sense. "The backend" is the single Thirdlight backend process;
"the owner" is the backend process that currently holds a project's
ownership record (§6).

---

## 1. Scope and ownership

This contract owns:

- The on-disk layout of a project, and every workspace artifact (ownership
  record, temp files, recovery snapshots) — exact locations and names.
- The **atomic authoring-state envelope**: its exact fields, its
  independent `storageVersion`, its canonical serialization, and its load
  validation pipeline. The envelope is the *only* mutable authoring file.
- The atomic write procedure (temp/flush/replace/directory-flush),
  acknowledgement timing, crash recovery, and the exact durability
  guarantees (process crash vs power loss).
- Project ownership: second-backend rejection, stale-owner detection, and
  the explicit (non-automatic) takeover.
- Unexpected-external-edit detection, the pause/snapshot protocol, and the
  supported maintenance procedure (release → external edit → reopen).
- The project-creation write sequence and its crash completion.

This contract does **not** own: command shapes/semantics (commands.md),
logical document shapes (project-model.md), transport or session mechanics
(packet 03), backups as a feature (the recovery snapshot is evidence and a
repair aid, **not** a backup — charter §4's documented backup policy comes
later), or multi-scene / multi-file transactions (§12: explicitly a future
contract).

## 2. Supported platform

- **OS:** Linux — the recorded deployment target is the environment in
  `docs/environment.md` (Ubuntu 26.04.1 LTS, kernel 7.0.2, x86_64, Proxmox
  LXC, no containers — decision 0001 §6). The spec relies only on POSIX
  primitives: atomic same-filesystem `rename(2)`, `fsync(2)` on files and
  directories, `O_EXCL`, `stat`, and `/proc/<pid>` inspection.
- **Filesystem:** the game data root
  `/home/dadmin/thirdlight/projects/` (decision 0001 §6) is on **ext4**
  (measured 2026-09-16: `/dev/mapper/vmdata-vm--10223--disk--0`, ext4).
  M1 acceptance targets ext4 (xfs has the same semantics for the
  primitives used and is expected to behave identically, but only ext4 is
  acceptance-tested). **Network filesystems (NFS/SMB/CIFS) are explicitly
  unsupported** — `rename` atomicity and `fsync` semantics are not
  guaranteed there.
- **Runtime:** Node.js ≥ 22 (recorded: v22.22.1) — `fs.writeFileSync`,
  `fs.fsyncSync`, `fs.renameSync`, `fs.openSync(dir, O_RDONLY)` +
  `fs.fsyncSync` for directory flush, `crypto` for hashing.
- All paths are project-relative or under the configured data root; the
  backend never accepts absolute client-supplied paths (charter §4).

## 3. Layout and artifacts

```text
<root>/projects/<projectId>/
  project.json                     manifest — IMMUTABLE after creation (§8)
  scenes/
    main.json                      the atomic authoring-state envelope (§4) — the ONLY mutable authoring file
    .main.json.tmp-<pid>-<nonce>   temp file, exists only during one write sequence; cleaned on open (§5.4)
  sources/
    sha256/
      <64-lowercase-hex>           AUTHORITATIVE immutable source bytes; the file name IS its SHA-256 (new §13.2)
      .<digest>.tmp-<pid>-<nonce>  temp file during blob publication; cleaned on open (§5.4)
  .thirdlight/
    ownership.json                 ownership record (§6)
    claim-<e>                      claim file (claim gate, §6.3/§6.5) — one per epoch; unlinked on release (§9)
    recovery/
      scene-<UTCstamp>-<sha8>.json recovery snapshots of external/foreign bytes (§7) — at most 16 kept, oldest pruned
    staging/
      <stageId>/
        source.bin                 staged source bytes — non-authoritative INPUT, supported edit path (new §7.6)
        stage.json                 optional { "displayName": … } — non-authoritative input
    derived/
      <sourceDigest>/<recipeDigest>/
          import.json              derived, regenerable decoded-import description (new §13.6)
          <name>.bin               derived, regenerable binary caches
    migration.json                 migration-copy marker — exists ONLY while a destination is being created (new §14)
```

- `<root>` is the backend's configured data root
  (`/home/dadmin/thirdlight`); `<projectId>` uses project-model ID syntax
  and **must equal the manifest's `id`** (project-model §13.3).
- Artifact locations are normative: the owner writes temps only inside the
  target file's own directory (so the replacing `rename` is
  same-filesystem and atomic), ownership and recovery only under
  `.thirdlight/`, and nothing else into the project tree. Hidden
  (`.`-prefixed) artifacts are never authoring documents and are excluded
  from any logical-document reading.
- The backend is the **only supported writer** of active authoring state
  (charter §6). Harness code edits are direct filesystem work on the engine
  repository (a different tree); editing *authoring* files outside this
  contract is exactly the "unexpected external modification" this document
  defines (§7), and the supported manual path is the release/reopen
  procedure (§9).
- `sources/` holds the **only** authoritative content bytes: immutable,
  content-addressed, write-once files under `sources/sha256/<digest>`. The
  `derived/`, `staging/` and `migration.json` entries are the **new M2
  sub-namespaces** added to the `.thirdlight/` namespace this section reserves
  for ownership/claim/recovery. They are not authoring documents, are excluded
  from every logical-document read, and their absence or corruption is never a
  project-blocking error. `.thirdlight/migration.json` exists only inside a
  destination that is being created (new §14.3).
- Content artifact paths are addressed only by project ID plus a model-level
  identifier (`assetId`, `version`, `stageId`, `digest`); no public operation
  accepts a filesystem path. Every artifact directory must be a real directory
  whose resolved path stays under the project root, and authoritative blobs are
  opened with `O_NOFOLLOW`; a violation is `path_rejected` before the first read
  or write (new §13.1).

## 4. The atomic authoring-state envelope

### 4.1 Why one envelope

M1 durability is a deliberately small scheme (packet 02 instruction;
project-model §3/§14):

- The **manifest is immutable during M1 editing** — project creation is
  its only writer (§8). No mutation ever touches `project.json`.
- Scene content, the project revision, and the retry metadata required for
  safe retry therefore live in **ONE file**: `scenes/main.json` contains a
  single atomic authoring-state **envelope**. One file ⇒ one atomic rename
  per transaction; the scene and its retry records can never disagree
  (no "revision advanced but record lost" window — commands.md §7.2).
- **There is no second authoritative scene file** and **no independently
  mutable duplicate revision** (project-model §3): the embedded scene's
  `revision` field *is* the project revision; the envelope carries no other
  current-revision field.
- **Multi-file transactions do not exist in M1**, and multi-file atomicity
  must never be simulated with several renames (charter §6: "multi-file
  transactions require recovery semantics, not merely one atomic rename per
  file"). The only two-file write in M1 is project creation, which gets an
  explicit ordered procedure + crash completion instead of pretending
  atomicity (§8.3). **Future multi-scene transactions require a new
  persistence contract** (project-model §3 anticipates exactly this);
  nothing in M1 may be read as permitting a second mutable scene.

### 4.2 Fields (storageVersion 1 and 2)

```json
{
  "storageVersion": 1,
  "type": "authoring-state",
  "projectId": "demo-0001",
  "scene": {
    "schemaVersion": 1,
    "sceneId": "scene-main",
    "revision": 5,
    "entities": [ "…" ]
  },
  "content": {
    "assets": [ /* AssetRecord values; project-model §18 */ ],
    "prefabs": [],
    "behaviors": [],
    "settings": {}
  },
  "retry": {
    "retention": 128,
    "records": [
      {
        "requestId": "req-9f2c8a1d3b4e5f60718293a4b5c6d7e8",
        "digest": "<64 hex>",
        "appliedRevision": 5,
        "result": { "…" }
      }
    ]
  }
}
```

| Field | Type | Constraint |
|---|---|---|
| `storageVersion` | integer | exactly `1` in M1. **Independent of the logical `schemaVersion`** (project-model §17): envelope-format changes bump `storageVersion`, never the scene's `schemaVersion`, and vice versa. |
| `type` | string | exactly `"authoring-state"`. A discriminator so the standalone scene parser (interchange input, project-model §3) is never misapplied; there is **no auto-detection or fallback** between a bare scene and an envelope. |
| `projectId` | string | must equal the project directory name (and, by §8, the manifest `id`). |
| `scene` | object | the complete logical scene document (project-model §8/§15 shape, including its `revision`). Validated by `validateScene` — the workspace **decodes the envelope and passes only the embedded scene to the scene validator**; it never passes the envelope itself (project-model §3). |
| `content` | object | **v2 only** (`storageVersion` 2): `{ "assets": [ … ], "prefabs": [], "behaviors": [], "settings": {} }` — all four keys required; `assets` is `project-model` §18 (≤ 128 records), the other three are containers whose element shapes are packets 16/17/18's (an empty container remains valid). Bounded: canonical `content` bytes ≤ 1 048 576. Validated by `validateContent`; failures ⇒ `content_invalid` (≤ 10 model errors + true count). **Envelope state only** — there is no standalone catalog file, and `scene.revision` remains the only revision in the envelope. |
| `retry` | object | `{ "retention": 128, "records": [ … ] }` — the retry block of commands.md §7.1. `retention` is the constant 128 recorded for readers. `records` in strictly ascending `appliedRevision` order, each record `{ requestId, digest, appliedRevision, result }` well-formed per commands.md §7.1. |

Strictness: unknown fields at any level ⇒ invalid envelope
(`envelope_invalid`, nothing stripped). `scene` must satisfy the full
project-model scene validation (values, hierarchy, limits, exactly one
camera). Cross-document checks run against the manifest (project-model
§13): `manifest.scenes[0].id === scene.sceneId`, `manifest.id ===
envelope.projectId === directory name`.

In a `storageVersion` 2 envelope the envelope's own key set is exactly
`{storageVersion, type, projectId, scene, content, retry}` (missing or unknown
key ⇒ `envelope_invalid` with the corresponding `field_missing` /
`field_unexpected`), and the §4.5 combination check runs **before** any scene or
content field validation. A `storageVersion` 1 envelope keeps the accepted
five-key set exactly and never carries `content`.
A `storageVersion` 3 envelope keeps the **same** top-level key set
(`{storageVersion, type, projectId, scene, content, retry}`) and adds exactly
one required key inside `content`: `game`, which is `null` or the bounded
`GameConfig` block (project-model §23.4). Its embedded scene must be
`schemaVersion` 3 and its content key set is exactly
`{assets, prefabs, behaviors, settings, behaviorTrust, game}`; a missing or
unknown key is `envelope_invalid`. `scene.revision` is still the only revision,
`retry` is unchanged, canonical serialization is §4.4 extended with the v3
content key order and the §23.7 component/field orders, and the §4.5 v3 row is
checked before any scene or content field validation. Normative text and the
example envelope: [`../storage.md`](../storage.md) §S3.

`scene.revision` is the **only** current-revision value. Records'
`appliedRevision` fields are per-record historical metadata (commands.md
§7.1): they are validated to be ascending and `≤ scene.revision`, and must
never be used to infer current state.

Size bound: ≤ 1024 entities + ≤ 128 records (model limits) — the envelope
is always a bounded document (order of hundreds of KB worst case).

### 4.3 Load validation pipeline (normative order)

At every open/reopen (and at startup scan, §10), `scenes/main.json` bytes
are processed in this order; the first failing step produces the stated
result and stops:

1. **Strict parse** — project-model §12.3 pass 1 on the raw bytes: UTF-8
   (no BOM) ⇒ `encoding_invalid`; strict JSON syntax ⇒ `json_parse_error`;
   duplicate object keys (after escape decoding) ⇒ `duplicate_key`. The
   original bytes are retained untouched (no destructive rewrite, ever —
   project-model §12.4).
2. Root is an object, else `envelope_invalid` (`field_type`).
3. `storageVersion` present and known: M2 knows `[1, 2]`. Unknown (higher or
   lower) ⇒ exactly one `storage_version_unsupported`; deeper checks stop. The
   value selects the pipeline branch (step 6a).
4. `type === "authoring-state"` else `envelope_invalid`.
5. `projectId` equals the directory name, else `envelope_project_mismatch`.
6. `scene` → `validateScene` (project-model). Failure ⇒ `scene_invalid`,
   carrying the project-model error objects (≤ 10 reported, count given).
   **6a–6h — `storageVersion` 2 branch (new §4.5/§13).** For a v2 envelope:
   a. envelope key set exactly
      `{storageVersion, type, projectId, scene, content, retry}` ⇒ else
      `envelope_invalid`;
   b. version-combination check (§4.5): `scene.schemaVersion` must be `2` and
      `content` must be present ⇒ else exactly one
      `version_combination_unsupported`, deeper checks stop;
   c. `scene` → v2 scene validation ⇒ `scene_invalid` (≤ 10 errors);
   d. `content` → `validateContent` ⇒ `content_invalid` (≤ 10 errors); c and d
      are both evaluated and both error sets reported when both fail;
   e. cross-block check (`validateProjectV2`, project-model §13.1): only when c
      and d both pass ⇒ `asset_reference_missing` (`document: "scene"`);
   f. canonical `content` byte budget ≤ 1 048 576 ⇒ `content_invalid`
      (`limits_exceeded`, `limit: "content_bytes"`);
   g. the retry block check of the accepted step 7 runs unchanged ⇒
      `retry_records_invalid`;
   h. the manifest (must be `schemaVersion` 1) and the accepted step 8
      cross-document checks run unchanged ⇒ `manifest_invalid` /
      `manifest_scene_mismatch`, plus `manifest.id === envelope.projectId ===
      directory name`.
7. `retry` block: `retention === 128`; `records` is an array of
   well-formed records (fields, types, digest shape, result shape per
   commands.md §5.1), `appliedRevision` strictly ascending and
   `≤ scene.revision`, `requestId` values unique. Failure ⇒
   `retry_records_invalid`. (A retry block that overflows the retention
   bound or is malformed means the file was not last written by a healthy
   backend; it is not "repaired" by dropping records — the project is
   blocked per §7.5.)
8. Manifest loaded and validated the same way (its own strict parse +
   `validateManifest`), then cross-document checks (project-model §13).
   Failure ⇒ `manifest_invalid` (the manifest itself) or
   `manifest_scene_mismatch` (cross-document), as applicable.

On success the backend holds in memory: the normalized scene, the current
revision, the record map (requestId → record), the envelope's exact bytes
and their SHA-256 (`lastWrittenHash`, §5.2), and an empty history
(commands.md §9). For a v2 envelope it additionally holds the normalized content
catalog, the per-asset `currentVersion` map and a bounded content integrity
report (§13.5). History is still empty.

### 4.4 Envelope serialization (canonical, byte-stable)

The backend always writes the envelope in this canonical form (stable for
diffs; same style as project-model §12.2):

- Fixed key order: envelope `storageVersion, type, projectId, scene,
  retry`; scene/entities/components per project-model §12.2; `retry`:
  `retention, records`; record: `requestId, digest, appliedRevision,
  result`; result objects per commands.md §5.1 key order.
- UTF-8, LF, 2-space indentation, no trailing spaces, one trailing newline,
  no BOM. Numbers with `JSON.stringify` shortest round-trip semantics.
- Envelope fixtures (`fixtures/commands/envelope/valid/`) are byte-exact
  under this rule.

### 4.5 Envelope version compatibility (v2)

The active workspace accepts exactly two passable version combinations, and a
`schemaVersion`/`storageVersion` change is a **reviewable contract change**, never
a same-version extension:

| `manifest.schemaVersion` | `scene.schemaVersion` | `storageVersion` | Result |
|---|---|---|---|
| 1 | 1 | 1 | **valid** — the accepted M1 combination, M1 pipeline unchanged |
| 1 | 2 | 2 | **valid** — the only M2 combination (`content` present) |
| 1 | 3 | 3 | **valid** — the v3 combination (`content.game` present; storage.md §S3) |
| 1 | 1 | 2 | `version_combination_unsupported` (single error, stops before scene/content field validation) |
| 1 | 2 | 1 | `scene_invalid` → `schema_version_unsupported` (the M1 validator knows scene `[1]`; accepted behavior unchanged) |
| 1 | 1 | 3 | `version_combination_unsupported` (single error) |
| 1 | 2 | 3 | `version_combination_unsupported` (single error) |
| 1 | 3 | 1 | `version_combination_unsupported` (single error) |
| 1 | 3 | 2 | `version_combination_unsupported` (single error) |
| 2 | any | any | `manifest_invalid` → `schema_version_unsupported` for the manifest — **the manifest stays schemaVersion 1 in M2** |
| any | any | ≥4 or ≤0 | `storage_version_unsupported` |
| any | ≥4 | any | `schema_version_unsupported` for that document |

No other combination is passable. There is **no silent upgrade on open**: a
`storageVersion 1` envelope is loaded by the M1 pipeline exactly as accepted and
is never rewritten in place; converting a project is the explicit operator
workflow of §14. There is **no downgrade**: M2 writes only `storageVersion 2`
envelopes, and an M1-only engine opening one reports
`storage_version_unsupported` and retains the bytes (accepted rule). The
storage-version dispatch is fixed: exactly **three** passable combinations
(v1/v2/v3), and a `schemaVersion`/`storageVersion` change is a reviewable
contract change, never a same-version extension. The manifest stays
`schemaVersion` 1 in M3; the runtime-content export `manifest.json`'s
`manifestVersion` move (1→2) is a **different document** owned by packet 42 and
is not a change to this table. Every v3 refusal is non-destructive: one error,
bytes retained byte-identically, no repair, no rewrite (workspace.md §16.2).

## 5. Durability protocol

### 5.1 The write procedure `W(bytes, target, dir)`

Every durable file write (envelope, ownership record) uses exactly this
sequence:

1. `tmp = <dir>/.<basename(target)>.tmp-<pid>-<nonce>` (nonce: process-
   unique counter). `open(tmp, O_WRONLY|O_CREAT|O_EXCL, 0644)` — `EEXIST`
   ⇒ new nonce (≤ 3 attempts).
2. Write all of `bytes`; `fsync(fd)`; `close(fd)`.
3. `rename(tmp, target)` — atomic same-filesystem replacement (POSIX: the
   target path instantaneously shows the old or the new inode).
4. **Directory flush:** `open(dir, O_RDONLY)`, `fsync(dirfd)`, `close` —
   makes the rename itself durable.
5. **Verification read:** read back `target`; `SHA-256` must equal
   `SHA-256(bytes)`. Mismatch ⇒ a foreign writer won a race ⇒ the
   external-change protocol (§7) — the write is *not* retried and the
   command fails with `external_change_unresolved`.

**M2 application (new §13.2).** Content blob publication reuses `W`
byte-for-byte with `target = sources/sha256/<digest>` and
`dir = sources/sha256/`. The workspace computes the digest from the bytes it
read (a caller-supplied digest is never authoritative), and an existing path
whose content is read and re-hashed: match ⇒ no write (idempotent retry),
mismatch ⇒ `blob_corrupt` and **no overwrite** — refusing to overwrite a
content-addressed path is what makes a foreign write or an external tamper
detectable. Blob publication changes no authoritative state: no reference, no
revision, no retry record, and it requires no mutation lock.

Steps 1–5 are retried as a whole on I/O error (ENOSPC, EIO, …), up to
**3 attempts** total with a fresh nonce. If the sequence still fails:

- Read `target` and classify its hash:
  - `previous` (== `lastWrittenHash`) ⇒ in-memory state is unchanged, no
    record exists; return `write_failed { onDiskState: "previous" }`.
    Retrying the same request re-executes the command fresh (commands.md
    §7.3).
  - `new-undurable` (== the intended hash; the rename took effect but step 4
    failed) ⇒ in-memory state is advanced (with its record) so the running
    system is self-consistent, durability is flagged unproven; return
    `write_failed { onDiskState: "new-undurable" }`. Worst case: a process
    crash loses the unflushed rename; the gap is always observable through
    queries (commands.md §7.3) and at-most-once still holds.
  - `foreign` (neither) ⇒ the external-change protocol (§7).
- A leftover `tmp` is removed best-effort; any residue is cleaned at the
  next open (§5.4).

### 5.2 Pre-write check (external-change detection)

Immediately **before** step 1 of any envelope write, the backend re-reads
`scenes/main.json` and compares its SHA-256 to the **expected state(s)**:

- If the target does not exist yet (creation's first envelope write), the
  check passes only while it stays absent; if it has appeared, the value
  is evaluated against the same rules below (an unexpected appearance is
  an unexpected external modification).
- **All established writes** (mutation writes, the release rewrite): the
  on-disk hash must equal `lastWrittenHash` — the hash of the last envelope
  this backend wrote or loaded.
- **Resolution writes** (`acceptExternalState` / `discardExternalState`
  rewrites, which run while a pending change exists): the on-disk hash may
  equal **either** `lastWrittenHash` (the file was concurrently restored)
  **or** the pending `externalHash` (the foreign bytes are still there).
  Any other value ⇒ the external-change protocol (§7) fires again on the
  new foreign bytes (fresh snapshot; the resolution command fails with
  `external_change_unresolved` and the operator re-resolves).

Mismatch on a non-resolution write ⇒ an unexpected external modification
(§7): snapshot, pause, fail the triggering command with
`external_change_unresolved`. No temp file is written, no state changes.

The post-write verification read (§5.1 step 5) remains strict for every
write — it accepts only the intended bytes — so a write that races a
concurrent writer is caught there and routed to §7.

`lastWrittenHash` is set: at load (§4.3); after every successful envelope
write (the intended hash); on `new-undurable` (the intended hash); after
`acceptExternalState` (the accepted write's hash); unchanged by
`discardExternalState` (it rewrites exactly the last known good bytes).

### 5.3 Acknowledgement timing (normative)

| Operation | Ack is sent only after |
|---|---|
| mutation success | `W` completed including step 4 (directory flush) **and** step 5 (verification read); in-memory state published at the same point |
| mutation failure | before any file write (validation/conflict classes) — nothing to acknowledge durably |
| query | immediate (in-memory read of the last acknowledged state) |
| `write_failed` | after the on-disk state has been classified (§5.1) |

Consequences (normative):

- **A success ack implies the durable state contains the command's record**
  (process-crash durability on the supported platform, §5.5 G2). A client
  that lost the ack can always retry and either replay the recorded result
  or re-execute fresh (commands.md §7.2) — both converge, never double-
  apply.
- The in-memory state is published **only** at the ack point, so queries
  never observe an unacked (possibly un-durable) mutation (commands.md
  §10).

### 5.4 Temp-file hygiene

On a successful open (after ownership is acquired, §6.2), the owner deletes
every `scenes/.main.json.tmp-*` file **and** every
`sources/sha256/.<digest>.tmp-*` file (the blob-publication temps of §13.2).
Leftover temps exist only because a
previous owner crashed mid-write; only the owner ever writes temps, and the
previous owner is by definition gone (ownership semantics, §6), so the
cleanup is safe. The cleanup happens before any command for the project is
processed. Fixture: `scenarios/06-crash-before-replace` (leftover temp
removed on open).

### 5.5 Guarantees (normative, stated exactly)

**G1 — integrity & ordering (holds under process crash *and* power loss,
on the supported platform):**

1. `scenes/main.json` is always a **complete** document — either the
   previous or the new envelope, never torn or partial. Rationale: file
   content is `fsync`ed before the rename; the rename is atomic; a power
   loss before the file fsync completes loses only the temp file.
2. Every logical mutation is applied **at most once**. Rationale: the
   record is durable in the same atomic unit as the revision; crash before
   rename ⇒ no record ⇒ retry re-executes fresh; crash after rename ⇒
   record present ⇒ retry replays (commands.md §7.2).
3. **No silent loss of foreign bytes:** any on-disk content the backend did
   not write is SHA-256-snapshotted into `.thirdlight/recovery/` before the
   project pauses (§7), and the original file is never overwritten until an
   operator explicitly resolves (accept/discard). A durable snapshot of the
   exact foreign bytes is a **precondition of every destructive resolution**
   (normative): while it is missing, accept/discard are refused
   (`external_change_unreadable` / `external_change_evidence_missing`, §11).
   A read failure other than ENOENT means the bytes are **unknown, never
   absent**: the project pauses in `paused-unreadable` (§7.2) and no
   zero-byte or fabricated snapshot may stand for the real content. A
   failed snapshot write pauses in `paused-snapshot-failed` (§7.2) and is
   reported by the triggering command and the queries — never silent.
   Where the foreign file is absent (ENOENT), there is no foreign content
   to snapshot (absence is a known, non-destructive state): the pending
   change is cleared and the project unpaused without any snapshot — the
   snapshot precondition above binds to the foreign **bytes**, not to the
   paused state.
4. The manifest is untouched by the editing path (immutable, §8).

**G2 — durability of acked writes:**

- **Process crash:** an acked write is durable (file fsync + rename +
  directory fsync, ext4). A restarted backend loads exactly the acked
  state.
- **Power loss:** an acked write survives **to the extent the underlying
  device honors `fsync`**. A disk with a volatile write cache and no
  battery-backed protection *may* lose even fsynced data on power loss;
  that is a device-contract failure outside what this protocol can
  guarantee, and it is **explicitly not claimed** here. G1 holds regardless
  (the envelope found after power loss is still complete and consistent,
  and the retry protocol converges).

**Crash-point table** (envelope write for command C; the client may have
lost the ack — it retries C with the same `requestId`):

| Crash point | On disk after restart | Retry of C |
|---|---|---|
| before temp write / temp write / before rename | old envelope (+ maybe a dead temp) | re-executes fresh (no record) ⇒ applied once, `duplicated: false` |
| after rename, before/failed directory flush | new envelope (durability unproven on power loss; on plain process crash the rename is in the stable VFS and effectively durable) | record present ⇒ replay, `duplicated: true` (or, if the rename was lost, the fresh-execution row above — both safe) |
| after directory flush, before ack | new envelope + record | replay, `duplicated: true` |
| after ack | new envelope + record | replay, `duplicated: true` |

Fixtures pin the two dominant rows: `scenarios/06-crash-before-replace` and
`scenarios/07-crash-after-replace`.

**G3 — content publication addendum (M2, new §13.3).** For a content
publication, a successful ack implies that (i) the referenced immutable bytes
exist durably under `sources/sha256/<digest>` and (ii) the new scene revision,
the catalog version and the retry record are in the same atomic envelope
replacement, verified by `W` step 5. A failure or crash before the envelope
commit may leave **unreferenced immutable bytes** (retained; never deleted, and
never an acked dangling reference: the commit-time application step re-verifies
that the referenced blob exists and matches its digest, failing closed with
`blob_missing` / `blob_corrupt` otherwise). The content crash-point table is
§13.3.4; it extends the table above with the blob phase and never weakens it.

## 6. Ownership

### 6.1 Record

`<project>/.thirdlight/ownership.json`, canonical serialization
(2-space, LF, trailing newline), key order:

```json
{
  "storageVersion": 1,
  "state": "owned",
  "backendId": "tb-<32 hex, CSPRNG, generated once per backend process>",
  "pid": 4242,
  "openedAt": "2026-09-17T09:00:00Z",
  "lockEpoch": 0
}
```

| Field | Meaning |
|---|---|
| `state` | `"owned"` (active) or `"released"` (§9). `"released"` records are claimable by any backend. |
| `backendId` | stable per backend *process* (fresh on every process start; not persisted outside this file). |
| `pid` | the owner process's PID (same LXC ⇒ same `/proc` namespace; no containers — decision 0001 §6). |
| `openedAt` | UTC timestamp (project-model §7.2 format) when this record was written. |
| `lockEpoch` | monotonic audit counter: initial claim = 0, each subsequent claim/takeover = previous + 1. |

### 6.2 Open-time evaluation (normative)

When the backend needs a project (on-demand open) it reads the ownership
record (if any) and evaluates:

| Record state | Evaluation | Outcome |
|---|---|---|
| absent | — | claim (§6.3): acquire the epoch-0 claim file (`O_CREAT|O_EXCL` on `claim-0`), then write our record (`lockEpoch` 0) via `W` + verification re-read (record *and* claim file); EEXIST ⇒ re-read the record and re-evaluate (owned+live ⇒ `ownership_conflict`; owned+dead ⇒ `stale_ownership`; absent/released/older-epoch ⇒ the §6.3 orphan-recovery rule — reclaim, or `claim_inconsistent`; non-ENOENT record read failure ⇒ never treated as absence — orphan-recovery rule or `claim_inconsistent`) |
| `state: "released"` | — | claimable: same claim procedure (§6.3) at `lockEpoch` = previous + 1 (the gate is `claim-(e+1)`; the superseded-epoch cleanup unlinks `claim-e`, §6.3; claim-file contention or an unresolvable orphan ⇒ `claim_inconsistent`) |
| `owned`, same `backendId` + `pid` as self | the same process re-opening (e.g. in-memory state was discarded) | **self-reclaim, not a re-claim (normative):** the session does not re-run `O_CREAT|O_EXCL` against its own claim file (it would fail EEXIST against itself); it re-verifies the claim file content matches its identity (`backendId` + `pid`); missing or foreign content ⇒ `ownership_conflict` (`holder` `null`) and the session must not serve |
| `owned`, `pid` **live** and plausibly our owner | see liveness rules | **`ownership_conflict`** — the open (and every command) fails; **no automatic takeover, ever** |
| `owned`, `pid` **dead** (stale owner) | — | **`stale_ownership`** — open fails; the operator must explicitly `takeoverWorkspace` (§6.4) |

Liveness rules (conservative — ambiguity resolves to "live"):

- `/proc/<pid>` absent ⇒ **dead**.
- `/proc/<pid>` present but the process start time (`/proc/<pid>/stat`
  field 22) is **after** `openedAt` ⇒ pid reuse ⇒ **dead** (the original
  owner is gone).
- Present, started before `openedAt`, and `/proc/<pid>/cmdline` matches the
  configured process marker (default: argv[0] contains `thirdlight`) ⇒
  **live**.
- Present, started before `openedAt`, but cmdline unreadable or mismatched,
  or any error reading `/proc` ⇒ **unknown ⇒ treated as live** (reject; the
  operator investigates). A conservative false "live" costs an operator
  check; a false "dead" costs split-brain risk.
- **Liveness and the exclusion gate (normative).** For concurrent claimers,
  liveness is reporting and classification only: it selects between
  `ownership_conflict` and `stale_ownership` and what the operator is
  shown. Exclusion never depends on it — the claim file's exclusive
  creation (`O_CREAT|O_EXCL`, §6.3) is the only exclusion gate, and it is
  enforced by the kernel: concurrent claimers are serialized by `O_EXCL`
  alone. The **one** liveness-referenced path is the §6.3 orphan-recovery
  rule: a claimant that finds an existing claim file at its target epoch
  (record absent/released/older-epoch) may proceed only if the file's
  content is parseable and its holder pid is proven dead under the rules
  above (unknown ⇒ live ⇒ refuse, `claim_inconsistent`). That path
  reclaims a *crashed* claimant's file — it is not a liveness safety gate:
  it never arbitrates a live rival (a live holder's claim file is never
  removed or rewritten by any backend path), and a false "live" here can
  only delay or block a reclaim (operator-visible via
  `claim_inconsistent`), never create a second active writer. Only proven
  absence/death permits a claim/takeover: no automatic claim ever depends
  on liveness to beat a live rival, and takeover is an explicit operator
  command.

### 6.3 Claim primitive (the only ownership write)

The exclusive gate is the **epoch-scoped claim file**:
`.thirdlight/claim-<e>`, one per `lockEpoch` e, created with
`O_CREAT|O_EXCL`. The record file (`ownership.json`) is the identity/audit
layer: writing it does not confer ownership, and no read or re-read of it
can arbitrate a claim.

Claim at `lockEpoch` e =

1. **Acquire the claim file** — `open(claim-e, O_CREAT|O_EXCL)` (on Node:
   `fs.open(path, 'wx')` — the same primitive `openTempFile` uses).
   Failure (EEXIST) ⇒ a different claimer holds epoch e: re-read the
   record and re-evaluate: owned + live ⇒ `ownership_conflict`; owned +
   dead ⇒ `stale_ownership` (the takeover path, §6.4); record
   absent/released/older-epoch ⇒ the **orphan-recovery rule** below. There
   is no retry loop. A non-ENOENT record read failure at the re-read is
   never treated as absence — the record's state is unknown; the claim
   proceeds only via the orphan-recovery rule (which requires parseable
   claim-file content and a proven-dead holder) or fails
   `claim_inconsistent`.
2. **Stamp the claim file (durable)** — write the claimer's identity
   `{ backendId, pid, UTC timestamp }` (canonical serialization, the
   record's style) into claim-e and fsync it. A crash before this step
   leaves an empty/absent-content claim file (orphan, below).
3. **Pre-record verification — claim file, by path**: re-read `claim-e`
   by path; its content must equal our step-2 identity (`backendId` +
   `pid` + timestamp match). Foreign, unparseable, or missing content ⇒
   the claim fails with `ownership_conflict` and **no record is written**
   (abort; the session does not serve).
4. **Write the record** via `W(our-record, ownership.json)` (state
   `owned`, our `backendId`/`pid`/`openedAt`, `lockEpoch` e).
5. **Verification re-read — record and claim file**: the on-disk record
   must contain our `backendId`, `pid`, and `lockEpoch`, and the on-disk
   claim-e must contain our step-2 identity (`backendId` + `pid` +
   timestamp match). A mismatch ⇒ a foreign actor unlinked/recreated or
   overwrote one of the files between our `O_EXCL` and this read ⇒ the
   claim fails with `ownership_conflict` and the session does not serve
   (this re-read closes the hostile unlink-recreate race for the claimant
   that lost its file).
6. **Consistency** — the re-read record's `lockEpoch` must be e. While we
   hold claim-e, the record's epoch can only advance through a claim at a
   higher epoch, which requires its own claim file; a re-read showing any
   other epoch ⇒ the record was changed outside the protocol ⇒ fail
   closed: the claim fails (the claim file is left on disk — recovered by
   the orphan-recovery rule or the next epoch's superseded-epoch cleanup)
   and `ownership_conflict` is reported with the fresh holder.

Any failure at steps 2–6 **fails the claim** (the claimant holds no
ownership; its claim file may remain on disk and is recovered as
described below). If the final two-file verification (step 5, after the
record `W`) detects foreign claim-file content, the residual on-disk
state is `record@e` with the claimant's identity + foreign `claim-e`; the
claimant holds no ownership and must not serve; the state resolves via
the §6.2 liveness path (live ⇒ `ownership_conflict` until death; dead ⇒
`stale_ownership` ⇒ e+1 takeover, whose superseded-epoch cleanup removes
`claim-e`); the envelope is untouched.

**Orphan recovery (the only liveness-referenced path, normative):** when
step 1 fails EEXIST and the record is absent/released/older-epoch, the
existing claim-e's content is read. The claimant may proceed (**reclaim**:
rewrite claim-e with its own step-2 identity, fsync, and continue at step
4; steps 5–6 then apply unchanged) **only** if the content is parseable
and its holder pid is proven dead under the §6.2 liveness rules (unknown
⇒ live ⇒ refuse). Otherwise the claim fails with **`claim_inconsistent`**
(holder `null`; carries `projectId`, the claim file path, the holder
content if parseable, and the liveness outcome) — the open fails; the
operator confirms the holder is dead, removes the orphan claim file, and
re-issues the open (an operator file operation — no backend command, §11).
This path consults liveness to reclaim a *crashed* claimant's file; it is
not a safety gate: concurrent claimers are serialized by `O_EXCL` alone,
and a live holder's file is never removed or rewritten by any backend
path.

**Superseded-epoch cleanup (normative):** a successful claim at epoch e+1
unlinks `claim-e` (best effort). This is safe because a claim at e+1
occurs only against a record at e that is `released` or stale (dead
holder): in both cases the session that created claim-e is no longer an
active writer (a released session must not serve; a dead pid cannot), so
claim-e excludes no live writer and its deletion removes no live
claimant's token. A failed unlink leaves inert residue: the epoch is
monotonic, so no future claim ever targets `claim-e` again.

**Single-winner (normative):** `open(O_CREAT|O_EXCL)` is serialized by the
kernel per path — at most one caller succeeds. In the interleaving of §1
(the defect), the loser fails either at its own `O_EXCL` (EEXIST — the
winner created claim-e first) or at the step-3 pre-record verification
or the step-5 verification re-read (the record or claim-file content is
not ours); the record rename arbitrates
nothing. No interleaving of two claimers yields two active owners. A
second re-read or any finite hash check cannot substitute for the
exclusive creation: a post-hoc read certifies only the file's state at
that instant, never that no concurrent rename follows.

### 6.4 Stale-owner recovery (explicit takeover)

- **No automatic takeover, normative.** A dead owner's record is never
  claimed automatically: the open fails with `stale_ownership` (carrying
  the stale `holder`), and recovery is the operator command
  `takeoverWorkspace(projectId)`.
  Rationale: automatic takeover of "dead" pids is the classic split-brain
  trigger (zombies, delayed `/proc` visibility, a backend that wedged but
  didn't die). An explicit operator action makes the hazard a conscious
  decision.
- `takeoverWorkspace` procedure: (1) re-read the record; it must be
  byte-identical to the one that evaluated stale (same holder, same epoch)
  — otherwise re-evaluate from scratch (a concurrent takeover may have
  landed). (2) Evaluate liveness again (it must still be dead). (3) Claim
  (§6.3) with `lockEpoch` = previous + 1 — the `O_CREAT|O_EXCL` on
  `claim-(e+1)` is the single-winner gate (a held claim file ⇒
  `ownership_conflict` — the recorded owner is live, or a concurrent
  takeover completed first); on success the superseded-epoch cleanup
  unlinks `claim-e`. (4) Load the project (§4.3).
  Success result: `{ ok: true, lockEpoch, backendId, pid }`; failure:
  `ownership_conflict` (including the held-claim-file case above) or
  `stale_ownership` (with the fresh holder).
- **Residual split-brain (honest bound):** two *simultaneous* takeovers of
  the same dead owner require two simultaneous operator actions; if both
  race, the `O_CREAT|O_EXCL` on `claim-(e+1)` yields exactly one winner
  (the loser's open fails EEXIST, re-reads the winner's live record, and
  aborts). A takeover of a *live* owner still rests on the same `/proc`
  trust assumptions as the stale path: the conservative unknown⇒live rule
  bounds it — a liveness misclassification can only delay or block a
  reclaim (operator-visible via `claim_inconsistent`), never create a
  second active writer, because a live holder's claim file still exists on
  disk (its `O_EXCL` token), so a concurrent same-epoch claimer never
  passes the gate, and the §6.3 verification re-read catches a foreign
  overwrite of either file. The orphan-recovery path is the only
  liveness-referenced path (§6.3) and is bounded by unknown⇒live. The only
  remaining split-brain path is a bypassing actor that unlinks/recreates
  the claim file or the record from under the owner (§7.1's explicit
  non-claim class, the same exposure as today's direct ownership-file
  tampering): the old owner's next envelope write's pre-write check (§5.2)
  finds foreign bytes, pauses, and snapshots them — no silent corruption
  of the envelope, and both envelopes involved are complete valid
  documents.

### 6.5 Ownership lifecycle

- Written on claim (§6.3); rewritten on release with `state: "released"`
  (§9) — **the file is never deleted** (deletion would reintroduce the
  absent-record race).
- The claim file (`claim-<e>`, §6.3) is created at claim with the
  claimer's identity content, and is **held for the session lifetime — it
  is a file, not an fd**: a session does not need to hold an open
  descriptor; the file's existence (with its content) is the token. It is
  released at release by the owner's own unlink (§9), superseded by the
  next epoch's successful claim (the superseded-epoch cleanup unlinks
  `claim-e`, §6.3), and orphaned by a crash (recovered by the §6.3
  orphan-recovery rule or the next epoch's cleanup). No fd-lifetime
  discipline is needed — there is no descriptor to close early and drop
  the token (the advantage over a session-lifetime lock fd).
- Owner crash: the claim file persists (orphan, or a consistent pair with
  the stale record); the record persists with a dead pid ⇒ stale ⇒
  explicit takeover (the envelope is untouched by any of this; its
  validity is re-checked at the new owner's open; the takeover's
  superseded-epoch cleanup removes the old claim file).
- The ownership file and the claim files are workspace artifacts, not
  authoring data: they are excluded from logical reading, from
  external-change detection (§7 monitors the envelope only), and from
  G1's authoring guarantees (the record's own writes use the same `W`, so
  it is torn-free too; claim-file writes are the §6.3 identity stamp).

## 7. Unexpected external modification

### 7.1 What is and isn't guaranteed

The backend detects external edits **at the next envelope write** (pre-
write check, §5.2) and **after every rename** (verification read, §5.1
step 5); an optional inotify watcher may trigger *earlier* detection but
**is not normative** — correctness does not depend on it.

**Scope (M2):** this section and §5.2 apply to the **authoring files** —
`scenes/main.json` (and the manifest at creation). They must never be extended
to any path under `.thirdlight/**`; the staging area is a supported edit path
with its own invariants (§7.6).

**Explicit non-claim:** no watcher, and no hash check, prevents or detects
*all* races with a bypassing writer. A writer can replace the file between
the pre-write check and the rename (our rename then atomically wins, and
*their* bytes are surfaced by the post-rename verification read — which
finds foreign bytes exactly when someone else wrote during our write
sequence), or after the verification read (surfaced at the next mutation's
pre-write check). Detection latency is therefore bounded by the next
mutation (or by the watcher, when present). What the protocol **does**
guarantee (normative): the backend never writes over unknown on-disk
content without an immediately preceding hash check; any foreign bytes it
encounters are snapshotted before the project pauses; no acked state is
ever silently replaced; and the pre-write check plus rename ordering means
a foreign writer's bytes are never *atomically intermixed* with ours
(the file is always one complete writer's document).

### 7.2 Detection and pause protocol

On detection (pre-write mismatch, or post-rename verification mismatch),
the triggering mutation:

1. Reads the on-disk bytes `B`; computes `sha256(B)`. **A read failure
   other than ENOENT is not absence (normative):** the bytes are unknown,
   not empty. The project pauses in `paused-unreadable` and the triggering
   mutation returns `external_change_unreadable` (§11) — never
   `external_change_unresolved` with a fabricated hash, and never a
   zero-byte snapshot. ENOENT is the only read result that means absence.
2. **Snapshots** `B` byte-for-byte to
   `.thirdlight/recovery/scene-<UTCstamp>-<sha8>.json`
   (`UTCstamp` = `YYYYMMDDTHHMMSSZ`; `sha8` = first 8 hex of the hash;
   pruning per §7.4). The original file is left **in place** —
   it is not overwritten or "fixed" until an operator resolves.
   **Byte-binding (normative):** the snapshot is the bytes read in step 1
   (in memory), never a re-read of the target; the artifact's `sha8` name
   therefore matches the snapshot content; a concurrent change between
   step 1 and step 2 does not alter the snapshot and is re-detected at the
   next §5.2 check / 7.4(d) re-read.
   **If the snapshot cannot be written (normative):** the project pauses in
   `paused-snapshot-failed`; the triggering mutation returns
   `external_change_unresolved` with `pendingChange.snapshotState =
   "snapshot_failed"`, and accept/discard are refused with
   `external_change_evidence_missing` (§7.3/§11) until the snapshot is
   durably written.
3. Parses/validates `B` through the full §4.3 pipeline (strict parse,
   `storageVersion`, `type`, `projectId`, `validateScene`, retry block,
   cross-document). Result: `externalValid: true` or the error objects
   (≤ 10 reported).
4. Sets the project's **pending change** state `{ snapshotState, externalHash,
   externalValid, externalErrors }` and **pauses writes** (`snapshotState`:
   `"ok"` — the step-2 snapshot is durable; `"snapshot_failed"` — the bytes
   were read and validated but no snapshot is durable; `"unreadable"` —
   step 1 failed with a non-ENOENT error, in which case `externalHash` is
   `null` and `externalValid`/`externalErrors` are null):
   Only the authoring file's bytes can trigger this protocol. A write to
   `.thirdlight/staging/**` (or `.thirdlight/derived/**`) is not a pending
   change and never sets `writePaused`.
   - Mutations ⇒ `external_change_unresolved` (with `pendingChange`).
   - Dedup replays still work (pure read, commands.md §6.1 step 2).
   - Queries are served from the **last known good** in-memory state with
     `workspace.writePaused: true` and `pendingChange` (commands.md §5.6) —
     the in-memory projection is never silently discarded (charter §6).
5. Returns the error to the triggering client. No state, no record, no
   revision change.

**Invalid external bytes** (e.g. a corrupted or mid-edit file): the
validation errors are reported through `pendingChange`, and only
`discardExternalState` is possible (accepting invalid data is refused with
`external_change_invalid`); both resolutions remain subject to the §7.3
evidence precondition (when unmet, the command reports
`external_change_unreadable` / `external_change_evidence_missing` and
nothing is written). The bytes are retained for repair; the project
stays paused.

### 7.3 Resolution (operator commands)

- **`acceptExternalState(projectId)`** — precondition: a pending change
  exists, `snapshotState` is `"ok"`, and `externalValid` is true. Effect: the external scene becomes
  authoritative — the envelope is rewritten via `W` from the *parsed*
  external bytes, re-serialized canonically (§4.4; canonicalization is
  value-preserving per project-model §12.2) with `retry.records` set to
  `[]` (new retry boundary — commands.md §7.1), ownership unchanged (we
  remain the owner). The accepted `scene.revision` is whatever the external
  document carries: the operator may deliberately roll the revision back
  (e.g. restoring an old backup) — a mutation can never roll revisions
  back, but an explicit operator accept is a declared re-base. History is
  cleared (new boundary, commands.md §9.2). Subsequent mutations proceed at
  the accepted revision. Result: `{ ok: true, revision, historyReset: true,
  retryCleared: true }`.
- **`discardExternalState(projectId)`** — precondition: a pending change
  exists and `snapshotState` is `"ok"` (a durable recovery snapshot of the
  exact foreign bytes). Effect: the last known good envelope bytes (verified against
  `lastWrittenHash` before writing) are re-written via `W`, restoring the
  previous state exactly; the external bytes remain only in the recovery
  snapshot; history is cleared (new boundary — the file was replaced
  externally, charter §6, and M1 performs no reconciliation).
  Result: `{ ok: true, revision, historyReset: true }`.
- Re-issuing either with no pending change ⇒ `no_pending_change`.
  Resolving clears the pending state and unpauses writes.
- **Refusal while evidence is missing or unreadable (normative):** while
  `snapshotState` is not `"ok"`, both resolutions are refused — with
  `external_change_unreadable` in `paused-unreadable`, with
  `external_change_evidence_missing` in `paused-snapshot-failed` — and
  nothing is written: memory and disk are unchanged, and the pending state
  and the pause persist across the refusal. Before answering, the command
  re-reads the file: bytes now readable ⇒ (re)establish the pending change
  from the real bytes (§7.2 steps 2–4), attempt the snapshot, and, once it
  is durable, proceed with the resolution in the same call; file absent at
  re-read (ENOENT) ⇒ the foreign state is gone — pending cleared, unpaused:
  the paused project is unblocked, no operator action is needed, and no
  destructive write occurred (absence is a known state; no snapshot is
  taken, because there is no foreign content to preserve); bytes still
  unreadable (non-ENOENT) ⇒ `paused-unreadable`; other foreign bytes ⇒ the
  §7.2 protocol re-fires on them (a fresh detection cycle).
- M1 has **no automatic reconciliation, no timeout, and no
  auto-resolution**: the project stays paused until an operator resolves
  (charter §6: "pauses conflicting writes until a reload/reconciliation
  completes").

### 7.4 Recovery artifacts

`.thirdlight/recovery/scene-<UTCstamp>-<sha8>.json` files are the
backend's evidence + repair aid for external bytes. They are: never read
automatically, never deleted except by the 16-oldest pruning, and **not a
backup** (charter §4's backup policy is a later deliverable). Operators
can compare a snapshot to `main.json` to see exactly what changed.

**Pruning order and exemption (normative):** the snapshot of the current
pending change — the snapshot whose content hash is the pending
`externalHash` — is **exempt from pruning while that change is pending**
and is retained until the change is resolved. Pruning keeps at most 16
snapshots in total, always including the exempt one: the other retained
snapshots are the newest by `UTCstamp`, and within one `UTCstamp` by full
file name lexicographically (a same-timestamp tie is broken by name, never
by guesswork, and no older-`UTCstamp` snapshot is pruned while a
same-`UTCstamp` one survives). Pruning runs after each successful snapshot
write and removes only non-exempt snapshots.

### 7.5 Corrupt envelope at open (no last known good)

If §4.3 fails at open/load (fresh process, no in-memory LKG), the project
is **blocked**: commands return `project_unavailable` (reason = the
specific code), queries fail the same way. The file is retained
byte-for-byte; the backend **never auto-repairs, auto-reverts, or
auto-deletes**. Recovery is operator-driven: repair the file by hand (a
recovery snapshot or a backup, if available) and re-open. This is the
project-model §12.4 rule at the workspace level: no destructive rewrite,
ever.

### 7.6 The supported staging area (BR-4)


`m2-plan.md` §3.5 states that the harness can edit source files in a declared
staging area. `m2-plan-review.md` BR-4 records the failure to prevent: the
harness edits behavior/source files under the project tree, the accepted
external-change protocol (`workspace.md` §7) treats that as an unexpected
external modification, pauses writes and writes a recovery snapshot, and the
publish then conflicts or the staged bytes are quarantined as "external".
**This section removes that failure mode by contract.**

#### 7.6.1 Definition and invariants (normative)

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

#### 7.6.2 Lifecycle, bounds and cleanup

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


**`kind: "behavior-source"` staging (C19-D1).** A behavior source is staged in
exactly the same way — `source.bin` under `<stageId>/`, untrusted input, caps
and traversal/symlink refusal applied at every use. It is never authoritative
and never read to determine state; publication is the separate preparation path
of §13.3.1. The behavior-source container's own rules are `project-model` §22.

## 8. Project creation

### 8.1 `createProject(projectId, name)` (operator command)

Preconditions: `projectId` matches project-model ID syntax; `name`
1–128 chars, no control chars. Outcome:

- Directory absent ⇒ create (procedure below). Result: `{ ok: true,
  created: true, revision: 0 }`.
- Directory present and the project loads (§4.3 + manifest) ⇒ idempotent
  no-op: `{ ok: true, created: false, revision: <current> }`.
- Directory present but unloadable ⇒ `project_exists_invalid` (with the
  load errors); nothing written.

`createProject` is a workspace operation, not a mutation: it has no
`expectedRevision`/`requestId` (it cannot conflict with an existing
revision — idempotency above handles the retry case).

### 8.2 Manifest (the immutable document)

Written **once** at creation, in canonical form (project-model §12.2):
`schemaVersion 1`, `engineVersion` = the backend's engine version (M1
baseline `0.1.0`), `id` = `projectId`, `name`, `createdAt` = current UTC
second, `scenes: [{ "id": "scene-main", "path": "scenes/main.json" }]`.

**Immutability (normative, M1):** after creation, no backend operation
ever writes `project.json`. Name edits and settings are future contract
extensions (project-model §7.1). In-session manifest edits are therefore
irrelevant to command correctness (commands do not re-read the manifest at
runtime; scene identity/revision are authoritative in the envelope), and
manifest changes are detected at the next open, where the §4.3 pipeline
applies to them too.

### 8.3 Creation write sequence (two files — explicitly not "atomic")

1. `mkdir <project>` (0755), `mkdir <project>/scenes` (0755),
   `mkdir <project>/.thirdlight` and `.thirdlight/recovery` (0755).
2. `W(manifest bytes → project.json)`.
3. `W(initial envelope → scenes/main.json)` — the project-model §15
   default scene (`sceneId` from the manifest) at `revision 0`, `retry`
   empty.
4. Claim ownership (§6.3); load in memory.

This is a **deliberately non-atomic** two-file sequence with defined crash
completion — not multi-file atomicity simulated by renames:

- Crash before step 3 completes ⇒ on startup scan (§10): valid manifest,
  no envelope ⇒ **deterministic completion**: write the initial envelope
  (a pure function of the manifest — default scene at revision 0) and log.
  The creation is completed, never half-finished.
  **Migration destinations are exempt (M2, new §14.3):** a directory that carries
  a valid `.thirdlight/migration.json` marker is an interrupted migration
  destination, not an interrupted project creation, and the deterministic
  default-envelope completion above **must not** run for it (it would create an
  empty default project and destroy the migration intent). Such a directory is
  reported by the scan (below) and completed only by resuming
  `migrateProjectCopy` or by the operator deleting it.
- Crash after step 3 with no manifest (only possible if the manifest was
  deleted after the fact) ⇒ orphan: reported at startup scan, retained,
  operator removes.
- The creation is idempotent per §8.1, so a retried `createProject` after
  any crash converges to the same project state.

### 8.4 `createProjectFromTemplate(projectId, name, templateId)` (template creation — M4, C65-3)

A template is an installed, verified directory (templates.md §1/§2:
`descriptor.json` + `base/scene.json` + `recipe/commands.json` +
`sources/**` + `NOTICE`, three independent digest checks, no archives,
no symlinks, exact engine-version match). Preconditions: `projectId`
matches project-model §5.1; `name` 1–128 chars, no control chars
(`field_*`); the template installed + verified (else
`template_not_found` / `template_content_mismatch` /
`template_engine_version_mismatch` / `template_path_rejected`).

**Outcome (exact — the idempotency/collision rules):**

- Destination absent ⇒ create via the phase sequence below. Result:
  `{ ok: true, created: true, projectId, revision: <N>, template:
  { templateId, version, contentDigest } }` (`N` = the recipe command
  count).
- Destination present and loadable, and its manifest `template` block
  equals the requested `(templateId, contentDigest)` **and** its
  manifest `name` equals the requested `name` ⇒ **idempotent no-op**:
  `{ ok: true, created: false, projectId, revision: <current>, template:
  <recorded> }` (a retry after a publication crash converges; a retried
  creation can never create two destinations).
- Destination present, otherwise (different template/digest/name, a
  non-template project, a partial destination of a different identity,
  or an unloadable directory) ⇒ `template_destination_exists` (carries
  `existing: "project" | "partial" | "unloadable"`); nothing written;
  the existing project is never overwritten, renamed or upgraded.

**Concurrent claim:** the `reserved` phase claims the destination with
the atomic `mkdir` of `projects/<projectId>` (first creator wins; a
concurrent same-identity creator observes the marker and converges to
the no-op after publication, or reports
`template_initialization_incomplete` with `phase` while creation is in
flight; a different-identity concurrent creator gets
`template_destination_exists` (`existing: "partial"`); a foreign marker
observed at reservation ⇒ `template_reservation_conflict`). The
reservation marker carries the request identity, so "same identity" is
decidable without a live channel.

**The phase sequence (normative):** `reserved` (atomic mkdir +
`.thirdlight` dirs + `W(reservation.json)`) → `blobs` (each descriptor
blob, inventory order: copy from the installed template — fresh `W`
writes, no hardlink/symlink — to
`.thirdlight/sources/sha256/<digest>`, post-write digest check; marker
phase advance) → `envelope` (`W(project.json)` — manifest **schemaVersion
2** with the `template` block, project-model §7 C65-1; `W(scenes/
main.json)` — the template base scene at `revision 0` + the empty v3
content block, game `null`; marker phase advance) → `replayed` (open
under the creation context; apply recipe commands `K+1…N` through the
accepted command pipeline — each command: validation, revision +1,
history entry, retry record, envelope `W`; deterministic requestIds
`req-` + first 32 hex of `sha256("<templateId>@<templateVersion>#" + i)`,
origin `{ kind: "template", clientId: "<templateId>@<version>" }`;
marker phase advance with `recipeApplied N`) → `published` (claim
ownership §6.3; `rm reservation.json`; log).

**Crash completion (per phase boundary):** reserved-only ⇒ scan reports
(resume on same identity, operator delete otherwise); blobs done, no
manifest ⇒ resume (re-hash existing blobs, `alreadyPresent` per blob);
manifest + revision-0 envelope, marker < `replayed` ⇒ write/verify the
envelope (a pure function of the reservation identity) and continue;
envelope at revision `K < N`, marker phase `replayed` ⇒ resume the
replay at `K+1` (the recipe requestIds make every applied command
dedup-safe — no command applies twice); `K = N` but unclaimed ⇒
**deterministic completion** (verify the creation-context claim, unlink
the marker). The marker and envelope disagreeing in an unrecoverable way
(e.g. `recipeApplied` ≠ envelope revision, a corrupt `published` phase
at `K < N`) ⇒ `template_marker_conflict` (no auto-completion). An
in-flight creation whose marker `contentDigest` no longer matches any
installed template (a replacement across the crash) ⇒ reported
`template_source_unavailable` (never re-pointed, never auto-completed —
operator restores the original template or deletes the destination).

**Partial destinations are not projects:** a destination with a
reservation marker (any phase < `published`) is refused by open/query/
Play/list as `template_initialization_incomplete` (carries `phase`,
`recipeApplied`, the resume/delete hint). Only the complete validated
envelope + the published claim + the removed marker constitute a ready
project. Disk-full in any phase: the accepted `write_failed` /
`content_publish_failed` / `content_quota_exceeded` semantics, marker
retained at the last completed phase (resumable or operator-deletable,
never half-claimed, never ready).

**Removal/replacement of the installed template:** created projects are
unaffected (they hold their own bytes + the manifest `template` block —
no live template reference); new creations record the replacement's
identity; in-flight creations follow the `template_source_unavailable`
rule above.

**Content store (C65-5 adjudication):** no new artifact class — the
template's source blobs are published into the destination's accepted
content-store layout (`.thirdlight/sources/sha256/<digest>`, §13.1) as
ordinary immutable blobs during the `blobs` phase; the accepted
§13.2/§13.3 publication invariants apply unchanged; the
`queryAssets`/`readBlob`/`contentIntegrity` surfaces see the starter
assets exactly as authored assets.

## 9. Supported maintenance procedure (release → edit → reopen)

The supported way for a human (or the harness) to hand-edit active authoring
state while the backend is out of the way:

1. **`releaseWorkspace(projectId)`** (operator command; preconditions: no
   in-flight mutation — the serialization makes this a queue drain; the
   project is owned). Effect:
   - The current state is already durable (every command acked ⇒ written,
     §5.3); the backend rewrites the envelope via `W` with the **same
     scene and revision but `retry.records: []`** (a lost-ack retry of a
     pre-release command must not replay across the boundary — it will
     instead fail `revision_conflict` if stale, which is safe), then
   - rewrites the ownership record with `state: "released"` via `W` — the
     release record write does **not** re-attempt the §6.3 claim gate
     (no `O_CREAT|O_EXCL`): the owner already holds its claim file, and
     the gate is for claimants, not for the releasing owner, then
   - **unlinks the owner's own claim file** (`claim-<e>`, §6.5), and
   - discards in-memory state (history and record map).
   A release that fails before the record write leaves the project owned
   with the old session still the writer — no partial release. A crash
   between the record write and the unlink leaves the documented orphan
   (`released@e` + `claim-e`), recovered by the next claim's
   superseded-epoch cleanup at `e+1` (§6.3/§6.5). Once the released
   record is durable, the old session **must not issue further writes**
   (its in-memory state is discarded in the same procedure; any later
   command is a fresh open — step 3 — not a continuation of the released
   session).
   Result: `{ ok: true, revision, retryCleared: true }`. While released,
   commands return `workspace_closed` and queries fail with
   `project_unavailable { reason: "workspace_closed" }`. Scoped precisely:
   the **releasing backend's** queries — the process whose session released
   the project — fail `project_unavailable { reason: "workspace_closed" }`
   and never re-open the project, while **any** backend's on-demand open (a
   query included, for a different/other backend identity) claims the
   released record at `lockEpoch` + 1 with a new `openedAt` (per §6.1/§6.2).
2. **External edit.** The operator edits `scenes/main.json` by hand (it is
   the envelope — edit `scene` only; keep `storageVersion`, `type`,
   `projectId`, the revision semantics, and `retry.records: []`). The
   manifest stays untouched (immutable, §8.2). The backend is not involved
   and holds no claim file — the released record is what lets a later open
   claim the project. Staging a source file for a content publish is a
   **different, supported** path that needs no release (§7.6): it writes only
   under `.thirdlight/staging/**`, never touches the envelope, and therefore
   cannot conflict with the pause protocol. Use this procedure (§9) only for
   hand edits of the envelope itself.
3. **Reopen** — the next command (on-demand open) or an explicit open:
   §4.3 validation runs on the edited file; success loads the state (empty
   history — new boundary; commands.md §9.2), re-claims ownership
   (`state: "owned"`, `lockEpoch` + 1). Failure ⇒ the §7.5 block (file
   retained, operator repairs and retries).

A released project is safe to open while a hand edit is *in progress* only
in the sense that validation will catch whatever is on disk at open time;
the procedure exists so the operator controls **when** the backend looks,
not to serialize against a concurrent editor.

## 10. Startup scan (backend process start)

Before serving, the backend scans the data root once (bounded log: ≤ 100
project entries, then a count):

| Found | Action |
|---|---|
| complete, loadable project | listed; opens on demand later |
| manifest without envelope (interrupted creation) | deterministic completion (§8.3), logged |
| directory with a valid `.thirdlight/migration.json` marker and no envelope (interrupted migration destination) | reported as an interrupted migration destination with `migration_resume_required`; **no** action, **no** §8.3 completion; resumable or deletable |
| orphan (no loadable manifest) | reported, retained |
| corrupt manifest/envelope | reported with the §4.3 codes, retained, blocked until operator repair |
| stale ownership record (dead pid) | reported; **no** action (takeover remains explicit) |
| leftover temps | **not** cleaned here — only the owner cleans temps, at open (§5.4) |
| a `projects/<id>` directory carrying `.thirdlight/reservation.json` (any `phase`) — template creation, C65-3 | **not a project**: reported with the marker's `phase` / `recipeApplied` / identity and refused for open/edit/Play as `template_initialization_incomplete`; a marker at `phase "published"` with the envelope at the full recipe revision and a creation-context claim completes deterministically (claim verified, marker unlinked, logged); a marker whose `templateContentDigest` matches no installed template is reported `template_source_unavailable`; as with the accepted migration marker, the reservation marker is non-authoritative, is never restored over an envelope, and is excluded from every backup (§15) |

The scan performs no writes except the deterministic creation completion,
and claims no ownership.

## 11. Workspace operations and error codes

| Operation | Kind | Result on success | Failure codes |
|---|---|---|---|
| `createProject(projectId, name)` | operator | `{ ok, created, revision? }` | `field_*` (args), `project_exists_invalid` |
| `releaseWorkspace(projectId)` | operator | `{ ok, revision, retryCleared }` | `project_not_found`, `project_unavailable`, `ownership_conflict` |
| `takeoverWorkspace(projectId)` | operator (explicit, §6.4) | `{ ok, lockEpoch, backendId, pid }` | `ownership_conflict`, `stale_ownership`, `project_not_found`, `project_unavailable` (claim succeeded, the §4.3 scene/manifest load failed ⇒ the §7.5 block) |
| `acceptExternalState(projectId)` | operator | `{ ok, revision, historyReset, retryCleared }` | `no_pending_change`, `external_change_invalid`, `external_change_unreadable`, `external_change_evidence_missing`, `project_unavailable` |
| `discardExternalState(projectId)` | operator | `{ ok, revision, historyReset }` | `no_pending_change`, `external_change_unreadable`, `external_change_evidence_missing`, `project_unavailable` |
| `stageContent(projectId, { stageId, bytes, displayName? })` | caller/harness input (non-authoritative) | `{ ok, stageId, byteLength, digest, expiresAt }` | `stage_limits_exceeded`, `path_rejected`, `project_not_found`, `project_unavailable` |
| `inspectStage(projectId, stageId)` | proposal (non-authoritative) | `{ ok, proposal }` (project-model §19/`assets.md` §8) | `stage_not_found`, `stage_expired`, `import_rejected`, `derived_cache_unavailable` (non-fatal) |
| `publishBlob(projectId, { digest, byteLength, source })` | immutable publication (no lock) | `{ ok, digest, byteLength, published, alreadyPresent }` | `blob_corrupt`, `content_quota_exceeded`, `content_publish_failed`, `path_rejected`, `stage_not_found`, `stage_expired` |
| `discardStage(projectId, stageId)` | cleanup | `{ ok, discarded }` | `stage_not_found` |
| `readBlob(projectId, { assetId, version })` | verified read | `{ ok, assetId, version, digest, byteLength, verified: true, bytes }` | `asset_not_found`, `asset_version_not_found`, `blob_missing`, `blob_corrupt`, `path_rejected` |
| `contentIntegrity(projectId)` | read | `{ ok, entries, summary }` | `project_not_found`, `project_unavailable` |
| `captureContentView(projectId)` | pure read | `{ ok, view }` | `project_not_found`, `project_unavailable` |
| `migrateProjectCopy(sourceProjectId, newProjectId)` | operator (§14) | `{ ok, sourceProjectId, newProjectId, sourceRevision, newRevision: 0, revisionPolicy: "reset-to-zero", historyReset: true, retryCleared: true, blobsCopied, resumed }` | `migration_source_invalid`, `migration_destination_exists`, `migration_marker_conflict`, `migration_resume_required`, `path_rejected`, `content_publish_failed` |
| `migrateProjectCopyV3(sourceProjectId, newProjectId)` | operator (§16) | `{ ok, sourceProjectId, newProjectId, sourceRevision, newRevision: 0, revisionPolicy: "reset-to-zero", historyReset: true, retryCleared: true, blobsCopied, blobsAlreadyPresent, resumed, sourceVersion: 2, newVersion: 3 }` | `migration_version_unsupported`, `migration_source_invalid`, `migration_destination_exists`, `migration_marker_conflict`, `path_rejected`, `content_publish_failed` |
| `createProjectFromTemplate(projectId, name, templateId)` | operator (§8.4) | `{ ok, created, projectId, revision?, template: { templateId, version, contentDigest } }` | `field_*` (args), `template_not_found`, `template_content_mismatch`, `template_engine_version_mismatch`, `template_path_rejected`, `template_destination_exists`, `template_reservation_conflict`, `template_marker_conflict`, `template_initialization_incomplete`, `content_quota_exceeded`, `content_publish_failed` |

(Transport/auth for these operator commands is packet 09; in M1 they are
admin-scoped — never exposed as browser/MCP mutation commands.)

Stuck states and their resolution: a release that crashes after the
released-record write but before the claim-file unlink (§9) leaves the
documented orphan `released@e + claim-e` — recovered automatically by the
next claim at `e+1` (superseded-epoch cleanup, §6.3): no new failure
code, no operator step. An orphan claim file at the *target* epoch (a
crash between claim-file creation and content write) fails the open with
`claim_inconsistent` — resolved by an operator **file operation**
(confirm the holder is dead, remove the orphan claim file, re-issue the
open). **No new operation:** orphan resolution is deliberately not a
backend command — the original draft's `resolveClaimFile(projectId)` is
**not adopted** (fewer contract surface; the operator action is
documented in the error hint).

Workspace error codes (stable; surfaced via `project_unavailable.reason` or
as operation results):

| Code | Raised when |
|---|---|
| `envelope_invalid` | §4.3 step 2/4 (structure/`type` failure) |
| `storage_version_unsupported` | `storageVersion` not in `[1]` (single error, stops the pipeline) |
| `envelope_project_mismatch` | `projectId` ≠ directory name |
| `scene_invalid` | embedded scene fails `validateScene` (carries ≤ 10 project-model errors) |
| `retry_records_invalid` | retry block malformed / non-ascending / over retention / duplicate requestId |
| `manifest_invalid` | manifest fails strict parse / `validateManifest` (carries ≤ 10 errors) |
| `ownership_conflict` | live owner holds the project, or the claim file exists with foreign/absent content at the target epoch — incl. the self-reclaim refusal (§6.2/§6.3); carries `holder`, `null` when no parseable owned record exists |
| `claim_inconsistent` | claim file exists at the target epoch but cannot be reclaimed: content unparseable, or holder pid not proven dead (§6.3 orphan recovery); `cls: "unavailable"`; carries `projectId`, the claim file path, the holder content if parseable, and the liveness outcome; hint: confirm the holder is dead, remove the orphan claim file, and re-issue the open (operator file operation — no backend command) |
| `stale_ownership` | dead owner; explicit takeover required (§6.2/§6.4; carries `holder`) |
| `workspace_closed` | project released for maintenance (§9) |
| `external_change_invalid` | pending external change failed validation; `acceptExternalState` refused |
| `external_change_unreadable` | scene file read failed with a non-ENOENT error: the on-disk bytes are unknown; `paused-unreadable` (§7.2); carries `projectId`, `snapshotState: "unreadable"`, `pendingChange` with `externalHash: null` |
| `external_change_evidence_missing` | pending change readable but not durably snapshotted: `paused-snapshot-failed` (§7.2); accept/discard refused until the snapshot is durable; carries `projectId`, `snapshotState: "snapshot_failed"` |
| `no_pending_change` | resolve command with nothing pending (§7.3) |
| `project_exists_invalid` | `createProject` onto an unloadable existing directory (§8.1) |
| `content_invalid` | the `content` block fails validation (carries ≤ 10 project-model errors + true count) |
| `version_combination_unsupported` | a `storageVersion` 2 envelope whose `scene.schemaVersion` is not 2 (single error, deeper checks stop) |
| `stage_not_found` | the staging directory does not exist |
| `stage_expired` | the staging directory exists but is older than the 3 600 s stage TTL |
| `stage_limits_exceeded` | a staging bound is exceeded (`limit`: `stage_bytes` / `frame_bytes` / `open_stages` / `staged_bytes_per_project`) |
| `path_rejected` | an artifact path is a symlink, escapes the project root, or is not a real directory/file under the project |
| `import_rejected` | the M2 import profile rejects the bytes (carries the ordered `asset_*` diagnostics, ≤ 10 + count) |
| `asset_id_duplicate` | a create targets an existing `assetId` |
| `asset_not_found` | an operation names an unknown `assetId` |
| `asset_version_not_found` | an operation names an unknown version of a known asset |
| `blob_missing` | a referenced authoritative blob does not exist |
| `blob_corrupt` | a blob's content does not match its digest, or an existing content-addressed path holds other bytes |
| `content_quota_exceeded` | project quota or device free space is insufficient (`kind`: `project_quota` / `device_space`; carries used/limit/needed) |
| `content_publish_failed` | a non-envelope publication phase failed (`reason`: `write` / `timeout` / `busy`, with `onDiskState` for the blob phase) |
| `derived_cache_unavailable` | a derived cache is missing/corrupt and could not be regenerated |
| `migration_source_invalid` | the source project is missing or does not load under the M1 pipeline |
| `migration_destination_exists` | the destination already contains a loadable project |
| `migration_marker_conflict` | a marker exists for different source/new IDs |
| `migration_resume_required` | an interrupted migration destination must be resumed (informational) |
| `migration_version_unsupported` | the source is not a loadable `storageVersion` 2 / scene `schemaVersion` 2 project (v1 must use the accepted v1→v2 copy first), or the requested destination is not the v3 combination (single error; carries `sourceProjectId`, `foundVersion`, `expectedVersion`) |
| `template_not_found` | the `templateId` is not an installed, verified template (§8.4, C65-3) |
| `template_descriptor_invalid` | the installed descriptor fails the templates.md §1 shape/digest checks (carries `reason`) |
| `template_content_mismatch` | a recipe/base/blob re-hash ≠ its digested value (carries the file/field) |
| `template_engine_version_mismatch` | the backend engine version ≠ the descriptor's (carries both) |
| `template_path_rejected` | a template path escapes the root, uses `..`, or is a symlink |
| `template_recipe_invalid` | the recipe fails the templates.md §4 rules (op not whitelisted, a bound, or a replayed command fails — carries the 1-based index + the command error) |
| `template_destination_exists` | §8.4 identity mismatch on an existing destination (carries `existing`) |
| `template_reservation_conflict` | a foreign reservation marker for the same destination |
| `template_marker_conflict` | the reservation marker and the on-disk state disagree unrecoverably |
| `template_initialization_incomplete` | the destination carries a marker with phase < `published` (carries `phase`, `recipeApplied`, the hint) |
| `template_source_unavailable` | an in-flight creation's marker digest matches no installed template |

**Permitted `project_unavailable.reason` values (normative):** the codes
in this table **plus** the codes the §4.3 load pipeline surfaces from the
strict parse and cross-document checks — `encoding_invalid`,
`json_parse_error`, `duplicate_key`, `field_type`,
`manifest_scene_mismatch`, `content_invalid`,
`version_combination_unsupported` and `asset_reference_missing`
(project-model.md §12.3/§12.6/§13 codes) —
plus the v3 codes `game_reference_missing`, `game_reference_in_use`,
`zone_transform_unsupported`, `spawn_transform_unsupported`,
`zone_checkpoint_count_invalid`,
`zone_goal_missing`, `asset_kind_mismatch`, `game_config_invalid`
(project-model.md §23.9) —
plus the M4 template code `template_initialization_incomplete` (§8.4,
C65-3 — a destination that exists but cannot be opened because it is
mid-creation) —
since a project that exists on disk but cannot load is exactly what
`project_unavailable` reports.

`holder` in ownership errors: `{ backendId, pid, openedAt, lockEpoch,
state }`, or `null` (no parseable owned record — the claim file exists
with foreign/absent content, §6.3, incl. the self-reclaim refusal, §6.2).

## 12. What is deliberately not in M1 (normative non-goals)

- **No multi-scene, no multi-file transactions.** M1 writes exactly one
  authoring file per transaction (the envelope) plus, once, the creation
  sequence (§8.3) with its completion rule. Any future capability that
  spans multiple files (multi-scene projects, assets, prefabs) **requires a
  new persistence contract** — journaling, a transaction log, or equivalent
  recovery semantics. It may not be bolted on as "several renames".
  **That contract is new §13/§14 for M2 content, and it adds no authoritative
  file:** immutable blobs are written before one atomic envelope replacement
  (a bounded, idempotent, crash-tested sequence with an explicit completion
  rule), and the migration copy is a new project written with a marker and an
  authoritative-last ordering. Multi-scene projects and any other
  multi-authoring-file transaction remain excluded.
- No journaling/redo log on disk; history is in-memory (commands.md §9).
- No backups feature (recovery snapshots are evidence, §7.4). M2 defines only
  the **artifact backup classification** of new §15 — which files constitute a
  complete source backup and how a restore is verified. No backup service,
  scheduler or destination exists.
- **No garbage collection, no blob or version deletion in M2** (new §13.7):
  retained versions and their bytes are what keep undo, history, retained
  snapshots, retained retry records and running play/export valid.
- **No in-place migration, no automatic upgrade on open, no downgrade** (new
  §14): converting a project always creates a new project and retains the
  original byte-for-byte.
- No concurrent-writer protocol (one owner; external writers are
  detected/paused, never synchronized).
- No network-filesystem support (§2), no cross-project atomicity, no
  replication, no automatic external-edit reconciliation (§7.3), no
  automatic ownership takeover (§6.4), no per-entity or per-component file
  storage, no compression/segmentation of the envelope.
- No watchers in the guarantees (§7.1): inotify is an optional early-warning
  aid, never a correctness dependency.


## 13. Content storage, publication and retention

### 13.0 Scope, ownership and non-goals


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

### 13.1 On-disk layout, artifact classes and path rules


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
- In the M3 workspace the active envelope is `storageVersion` 3
  (project-model §23, storage.md §S3). The game-configuration block is a
  `content.game` key inside that envelope: **no new file, directory or artifact
  class is introduced**, `sources/sha256/<digest>` remains the only
  authoritative content path for model and audio bytes alike, and no artifact is
  written outside the accepted layout.
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

### 13.2 Immutable blob publication


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

### 13.3 Publication pipeline, lock scope, durability addendum and crash-point table

#### 13.3.1 Two layers, one authoritative step


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


**Behavior-source preparation profile (C19-D1).** `stageContent` accepts a
`kind: "behavior-source"` profile: the staged `source.bin` is the canonical
source-graph container (`project-model` §22.1) and is staged byte-for-byte like
any other source. `prepareBehaviorSource(projectId, stageId | { bytes },
declaration)` is the preparation-layer operation for this profile (no lock,
repeatable, idempotent per digest): it resolves the stage (refusal checks, caps,
traversal/symlink refusal), verifies the container, runs the static rules and
`compileBehavior`, and stores the prepared output as a **derived cache** under
`.thirdlight/derived/<sourceDigest>/<recipeDigest>/` — regenerable from the
immutable container blob, never authoritative (`behaviors.md` §8.4,
`project-model` §22.4). The trust-aware refusal runs **before** staging
resolution **at the command layer**: `publishBehavior{mode:"source"}` fails with
`behavior_trust_unacknowledged` when the supplied `sourceDigest` has no
acknowledgment entry, and with `behavior_publication_unavailable`
(`preparer_unavailable`) while no preparer is registered — before any stage,
digest or validation work (`behaviors.md` §8.3/§8.4; `commands.md` §8.11).
**C33-5 (accepted with diff, Gate I) — the enforceable preparation order:** at
the **preparation** layer the digest is only knowable after the staged bytes
are read, so `prepareBehaviorSource` reads and hashes the bytes **first**, then
refuses an unacknowledged digest (before compiling and before writing anything),
and only then parses/compiles. The full enforceable order is therefore
**stage resolve → read + hash → trust refusal → parse/compile → immutable blob +
derived record → command publication**. Neither layer writes authoritative state
before its refusal.
#### 13.3.2 Client-visible ordering


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

#### 13.3.3 Lock scope (normative)


The per-project mutation lock is held only for step 4 and the read operations
that need a consistent snapshot. It is **never** held while: framing/reading
staged bytes, inspecting/decoding a GLB, hashing a source blob, publishing a
blob, waiting for a job slot, or performing any filesystem or CPU work whose
duration scales with the content. No long job holds the lock. Any implementation
that holds the lock across inspection or blob publication violates this section
even if its observable results happen to match.

#### 13.3.4 Crash-point table (content publication)


| Crash/failure point | On disk after restart | Retry of the same requestId |
|---|---|---|
| during staging read / inspection | unchanged (+ possibly a partial staged temp, removed on open) | fresh execution (no record); nothing published |
| during `publishBlob` | envelope unchanged; possibly a leftover `sources/sha256/.<digest>.tmp-*` (removed on open) | fresh execution; blob re-published |
| after `publishBlob`, before the command | envelope unchanged; one unreferenced blob | fresh execution; blob write skipped after digest verification |
| inside the envelope write | accepted `workspace.md` §5.1 table (old or new envelope; complete document) | replay (record present) or fresh execution (record absent) |
| after the envelope commit, before the ack | new envelope with the record | replay, `duplicated: true`; **no** stage or blob lookup |
| after the ack | as committed | replay, `duplicated: true` |

### 13.4 Failure and recovery matrix


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

### 13.5 Reads, integrity and tamper handling


- `readBlob(projectId, { assetId, version })` — the only public byte read **by catalog version**. It
  resolves the version's `sourceDigest` from the last acknowledged catalog,
  checks the artifact-path rules, reads `sources/sha256/<digest>`, **verifies the
  digest before returning**, and returns bytes plus `{ digest, byteLength }`.
  There is no public read by path, and no read of a version that the catalog does
  not contain (`asset_not_found` / `asset_version_not_found`).
- `readSourceBlob(projectId, { digest })` — the digest-addressed verified read
  (**C35-1** accepted with diff, Gate I). Behavior-source containers are not
  catalog assets, so the play/export build cannot use `readBlob`; this read
  resolves `sources/sha256/<digest>` directly, opens it with `O_NOFOLLOW`
  (refusing a symlink at the blob path as `path_rejected`), **verifies the
  SHA-256 before returning** and returns the bytes plus `{ digest, byteLength }`.
  It is read-only, does not consult or advance the catalog, and never mutates.
  A missing/orphan blob is `blob_missing`; a digest mismatch is `blob_corrupt`.
- Reads never mutate: no temp file, no derived write, no envelope write, no
  revision change. A failed read leaves every artifact untouched.



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

### 13.6 Derived caches


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

### 13.7 Ownership, disposal and retention


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

### 13.8 Compatibility and change rules


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

### 13.9 Bounds


All values are proposed and must be pinned at Gate E before the packet-24/25
fixtures and tests choose thresholds. Exceeding a bound fails **before**
publication whenever the bound is knowable then.

| Class | Bound | Value | Failure |
|---|---|---|---|
| byte | source blob / staged source / upload request | 33 554 432 B (32 MiB) | `stage_limits_exceeded` (`stage_bytes`), `content_invalid` (`limits_exceeded` → `source_bytes`, persisted) |
| byte | content block, canonical | 1 048 576 B (1 MiB) | `content_invalid` (`limits_exceeded` → `content_bytes`), no envelope write |
| byte | `content.game`, canonical | 16 384 B | `content_invalid` (`limits_exceeded` → `game_bytes`), no envelope write; counted inside `content_bytes` |
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

### 13.10 What is deliberately not in M2 (content)


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


## 14. Migration: M1 project → M2 project copy


Migration is **explicit, operator-driven and non-destructive**. It is never an
open-time side effect.

#### 14.1 Preconditions

- The source project ID exists, is loadable under the **accepted M1 pipeline**
  (`storageVersion 1`, scene `schemaVersion 1`, manifest v1), and is not
  currently owned by a live *other* backend (the migration reads the source; it
  does not write it).
- The destination project ID is a new, valid ID syntax value and
  `<root>/projects/<newProjectId>` does not already contain a loadable project or
  a migration marker for different IDs.
- Operator-scoped only: never exposed to the browser or MCP as a mutation.

#### 14.2 Result and identity/revision policy

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

#### 14.3 Ordered write sequence and crash completion

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

#### 14.4 No silent upgrade, no downgrade

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
- **v3 migration is a second, separate operator (§16).** `migrateProjectCopy`
  (v1→v2) is unchanged and never writes v3. A v1 project reaches v3 only by the
  chained copy `migrateProjectCopy` → `migrateProjectCopyV3`; there is no direct
  v1→v3 operator and no in-place upgrade. `migrateProjectCopyV3` refuses a v1
  source with `migration_version_unsupported`.


## 15. Artifact backup classification


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
**v3 adds no backup class.** The game-configuration block is inside the envelope
and audio bytes are ordinary `sources/sha256/<digest>` blobs, so the same
included/excluded sets apply verbatim: manifest + envelope + every source blob
(model and audio) are included; staging, derived caches, ownership, recovery and
the migration marker are excluded.


## 16. Storage v3 and the v2→v3 copy migration

### 16.1 Scope and non-goals

This section defines the v3 authoring envelope, its durable/blob consequences and
the explicit v2→v3 **copy** migration. It does not define scene data
([`project-model.md`](project-model.md)), commands ([`commands.md`](commands.md)), publication
internals (accepted §13), the WAV import profile or audio bytes (packet 41), or
the runtime-content export `manifest.json` (`manifestVersion` 1→2, **packet 42**).

Non-goals (unchanged from §§12/13.10 and M2): in-place upgrade, downgrade,
garbage collection, blob deletion, version eviction, a second mutable document,
a catalogue side-car, multi-file authoring transactions, remote/URL content, and
any authoring path outside the project tree.

### 16.2 Envelope version compatibility (v3)

`storageVersion` known set is `[1, 2, 3]`. The exhaustive table of §4.5 gains
exactly one passable row (`manifest 1 + scene 3 + storage 3`); all other new
pairs are single-error refusals checked **before** scene/content field
validation. The v3 combination's envelope carries the six-key `content` block of
§16.3.

| `manifest.schemaVersion` | `scene.schemaVersion` | `storageVersion` | Result |
|---|---|---|---|
| 1 | 1 | 1 | **valid** — M1, unchanged |
| 1 | 2 | 2 | **valid** — M2, unchanged |
| 1 | 3 | 3 | **valid** — **v3** (`content.game` present) |
| 1 | 1 | 2 | `version_combination_unsupported` (accepted, unchanged) |
| 1 | 2 | 1 | `scene_invalid` → `schema_version_unsupported` (accepted, unchanged) |
| 1 | 1 or 2 | 3 | `version_combination_unsupported` |
| 1 | 3 | 1 or 2 | `version_combination_unsupported` |
| 2 | any | any | `manifest_invalid` → `schema_version_unsupported` |
| any | any | ≥ 4 or ≤ 0 | `storage_version_unsupported` |
| any | ≥ 4 | any | `schema_version_unsupported` for that document |

Non-destructive refusal rule (normative, restated for v3): the refusal is exactly
one error at the envelope's `storageVersion` (or the document's
`schemaVersion`) path; deeper scene/content checks stop; the on-disk bytes are
retained **byte-identically**; the startup scan, open and every query perform no
normalization, upgrade, downgrade, repair or write. An unsupported project is
reported under `project_unavailable.reason` with that code. A v3 project opened
by a v2-only engine behaves exactly as an M2 project opened by an M1 engine:
`storage_version_unsupported`, bytes retained.

### 16.3 Storage v3: the authoring-state envelope

The envelope file, atomic replacement and durability guarantees are unchanged
(§§4/5). `storageVersion` **3** has the same top-level key set as v2:
`{storageVersion, type, projectId, scene, content, retry}`.

```json
{
  "storageVersion": 3,
  "type": "authoring-state",
  "projectId": "demo-0003",
  "scene": { "schemaVersion": 3, "sceneId": "scene-main", "revision": 0, "entities": ["…"] },
  "content": {
    "assets": [],
    "prefabs": [],
    "behaviors": [],
    "settings": {},
    "behaviorTrust": { "entries": [] },
    "game": null
  },
  "retry": { "retention": 128, "records": [] }
}
```

Differences from §4.2's v2 row (additive only):

| Aspect | v3 rule |
|---|---|
| key set | exactly the six keys above; a missing or unknown key ⇒ `envelope_invalid` |
| `scene.schemaVersion` | must be exactly `3` (combination check §16.2 precedes field validation) |
| `content` keys | exactly `assets, prefabs, behaviors, settings, behaviorTrust, game` |
| `content.game` | **required key**; `null`, or a `GameConfig` value ([`project-model.md`](project-model.md) §23.4) |
| everything else | unchanged: `scene.revision` is the sole revision; `retry` unchanged; `projectId` = directory name = manifest `id`; canonical §4.4 serialization extended with the v3 content key order and the §23.7 component/field orders |
| buffers | the backend holds the normalized v3 scene, the normalized content catalog (including the normalized `game` block or `null`), `currentVersion` maps, integrity report, retry map, last-written hash, empty history |

`content` byte budget: §13.9's 1 048 576 B stands, unchanged. The `game` block
adds its own ≤ 16 384 B bound (`game_bytes`, [`project-model.md`](project-model.md) §23.10) and
is counted inside `content_bytes`. No new envelope size class exists.

### 16.4 Load validation pipeline (v3 branch, normative order)

The §4.3 pipeline dispatches on `storageVersion`. The v3 branch is the v2 branch
with these substitutions; every other step (strict parse, `envelope_invalid`,
retry block, manifest, cross-document, ownership, external change) is unchanged:

1. step 2: envelope structure/`type`, v3 six-key set ⇒ `envelope_invalid`;
2. step 3 (§4.5): `scene.schemaVersion === 3` and `storageVersion === 3` ⇒ else
   exactly one `version_combination_unsupported`, deeper checks stop;
3. step 4: `scene` → v3 scene validation ([`project-model.md`](project-model.md) §23.8) ⇒
   `scene_invalid` (≤ 10 model errors);
4. step 4: `content` → `validateContent` for the six-key v3 block ⇒
   `content_invalid`, and canonical `content` bytes ≤ 1 048 576 ⇒
   `content_invalid` (`limits_exceeded` `content_bytes`), `content.game` bytes ≤
   16 384 ⇒ `limits_exceeded` `game_bytes`; both error sets are reported when
   both fail;
5. step 4: cross-block check `validateProjectV3` = accepted v2 cross-block check
   **plus** the §23.5/§23.8-step-6 game/cue/animation reference checks ⇒
   `asset_reference_missing` / `asset_kind_mismatch` / `game_reference_missing`
   (`document: "scene"` or `"content"` as appropriate);
6. steps 7–8 unchanged: retry block, manifest (must be `schemaVersion` 1),
   `manifest_scene_mismatch`, `manifest.id === envelope.projectId === directory
   name`.

A v3 combination mismatch stops before any scene/content field validation. A v2
envelope is loaded by the unchanged v2 branch; no v3 code path runs on it.

### 16.5 Migration: v2 project → v3 project copy

Migration is **explicit, operator-driven and non-destructive**. It is never an
open-time side effect and is never exposed to the browser or MCP as a mutation.

#### 16.5.1 Preconditions

- The source project ID exists and is loadable under the **v2 pipeline**
  (`storageVersion 2`, scene `schemaVersion 2`, manifest `schemaVersion 1`), and
  is not currently owned by a live *other* backend (the migration reads it; it
  never edits, claims, releases or rewrites it). “Loadable under the v2
  pipeline” includes the **v2 component registry**: a `schemaVersion 2` scene
  that carries a v3-only component (`gameZone`, `playerSpawn`, `cameraFollow`,
  `light`, `surface`, `modelAnimation`) is `component_unknown` there, so it is
  refused as `migration_source_invalid` (`project-model.md` §23.11); it is not a
  v2 project and is never silently upgraded by the copy.
- The destination project ID is a new, valid ID-syntax value, and
  `<root>/projects/<newProjectId>` contains neither a loadable project nor a
  migration marker for different IDs.
- A v1 source is **refused** by this operator (`migration_version_unsupported`,
  `sourceVersion: 1`). v1 projects use the accepted v1→v2 copy
  (`migrateProjectCopy`, §14) **first**, then this v2→v3 copy on the resulting
  destination; chaining two copy operators is the only supported v1 route. There
  is no direct v1→v3 operator and no in-place upgrade.
- An unsupported **new** mix is refused: a destination request that would have to
  write a combination outside §16.2 fails before any write with
  `migration_version_unsupported`.

#### 16.5.2 Result and identity/revision policy

| Aspect | Policy |
|---|---|
| destination identity | **new project** (`newProjectId`); new manifest, `id = newProjectId`, source `name` carried over, new `createdAt` |
| manifest `schemaVersion` | stays **1** (the authoring manifest is never re-versioned) |
| scene | `schemaVersion` 2 → **3**; every entity value/order/ID/hierarchy/transform/component carried **verbatim** (byte-identical values) |
| content | carried **verbatim** — `assets` (records, versions, recipes, metrics, timestamps), `prefabs`, `behaviors`, `settings`, `behaviorTrust` are copied byte-identically **except** for the derived revision metadata reset in the next row; `game` is added as **`null`** |
| derived revision metadata | **reset to 0** on copy: every `content.assets[i].versions[j].publishedRevision`, every `content.behaviors[i].publishedRevision`, every `content.behaviors[i].source.publishedRevision` (when `source` is non-null) and every `content.behaviorTrust.entries[k].acknowledgedRevision` is written as `0` |
| storage | `storageVersion` 2 → **3** |
| revision | **reset to 0** (`revisionPolicy: "reset-to-zero"`) |
| retry records | **cleared** (`retry.records: []`), `retention: 128` |
| history | not carried (in-memory only); the destination starts with empty history |
| source project | **retained byte-for-byte** after success **and** after refusal (`sourceTreeHash` recorded before and after by the operator; the executable test hashes every source file) |
| reported | `{ sourceProjectId, newProjectId, sourceRevision, newRevision: 0, revisionPolicy: "reset-to-zero", historyReset: true, retryCleared: true, blobsCopied, blobsAlreadyPresent, resumed, sourceVersion: 2, newVersion: 3 }` |

Rationale for reset-to-zero is the accepted §14.2 rationale, unchanged: a new
project identity starts its own revision history, and snapshot identity
(`<projectId>@r<revision>`) already distinguishes the projects. Carrying
`assets` verbatim (rather than re-importing) is required because blobs are
immutable and content-addressed: the destination's catalog names the same
digests, so the copy can re-verify bytes instead of re-inspecting them.

**Why the derived revision metadata is also reset.** `publishedRevision` and
`acknowledgedRevision` are per-record *history* metadata: each names the
revision at which that record landed. The destination is a **new project
identity** whose `revision` restarts at 0 with empty history (row above,
§14.2 rationale), so a carried value would name a revision that does not exist
in the destination and would be refused as a future revision by the
`§13.2` rule 5 / `§18.9.2` rule 4 bounds (`≤ scene.revision`,
[`project-model.md`](project-model.md)). Writing `0` keeps the copy honest
(“landed at the destination baseline”, `project-model.md` §18.4) and keeps the
destination loadable: for a `source`-bearing behavior record this copy writes
the one `publishedRevision` value that is below the `project-model.md` §12
step 5 / §22.2 rule 4 preparation bound (`≥ 1`), so those rules read the bound
as `≥ 0` for a record this copy writes. Everything else in
`content` — `sourceDigest`, `sourceByteLength`, recipes, metrics, timestamps,
the whole behavior `source` block, `settings` — is copied byte-identically, and
the **source project keeps its own revision and its own values** (row “source
project”: no file in the source tree is written, so its
`publishedRevision: 2` is untouched; the copy is one-directional).

#### 16.5.3 Ordered write sequence and crash completion

Writes go **destination-first, authoritative-last** — the same discipline as §6
and accepted §14.3:

1. `mkdir <dest>`, `mkdir <dest>/.thirdlight` (0755).
2. **Write `.thirdlight/migration.json`** (marker):
   `{ storageVersion: 3, type: "migration-copy", sourceProjectId, newProjectId,
   sourceVersion: 2, newVersion: 3, phase, startedAt }`; `phase` records the last
   completed step (`created` → `manifest` → `blobs` → `envelope`). The marker is
   non-authoritative, is never restored over an envelope, and is excluded from
   every backup (§15).
3. Write the destination manifest (`project.json`) via `W`.
4. Copy every **reachable and unreachable** source blob
   (`sources/sha256/<digest>` for every version of every asset record) via `W`,
   verifying each digest after write; an existing destination blob with the same
   digest is verified and counted `alreadyPresent`. Audio blobs use the same
   layout — there is **no new artifact class**.
5. **Write the destination envelope last** (`scenes/main.json`, §16.5.2 values via
   `W`). This is the commit point: before it the destination is not a loadable
   project.
6. **Remove the marker.** The destination is reported complete only after this.

Crash completion (normative):

- A directory containing a valid v3 migration marker and **no envelope** is
  reported by the startup scan as an interrupted migration destination. The §8.3
  deterministic default-envelope completion is **suppressed** for it (creating an
  empty default project would destroy the migration intent).
- `migrateProjectCopyV3(sourceProjectId, newProjectId)` is **idempotent and
  resumable**: it re-verifies existing destination files against their expected
  canonical bytes, re-verifies/copies blobs, and continues from the recorded
  `phase`. Alternatively the operator deletes the destination directory — always
  safe because nothing in it was ever authoritative.
- Marker mismatch (`sourceProjectId`/`newProjectId`/`sourceVersion` not matching
  the request) ⇒ `migration_marker_conflict`; an existing loadable destination ⇒
  `migration_destination_exists`; a v1 or unknown source ⇒
  `migration_version_unsupported`; all refuse **without writing** and leave both
  trees byte-identical.
- `phase: "envelope"` with a loadable v3 envelope means step 5 succeeded and only
  step 6 was interrupted: the resume path verifies the envelope equals the
  expected canonical bytes and removes the marker without rewriting.
- `phase: "blobs"` with all expected blobs present verifies digests and skips to
  step 5. `phase: "created"` with an unexpected non-marker file ⇒
  `migration_destination_exists` unless the file is a temp file (§5.4), which is
  cleaned.

#### 16.5.4 No silent upgrade, no downgrade, no mixed state

- Opening a v1 or v2 project under M3 uses the unchanged v1/v2 pipeline; M3 never
  rewrites it and never writes a v3 envelope into it.
- Migration always creates a **new** project; there is no in-place conversion, no
  partial manifest/envelope upgrade and no "upgrade on save".
- Downgrade does not exist: v3 writes only `storageVersion 3` envelopes, and a
  v2-only engine reports `storage_version_unsupported` while retaining the bytes.
- There is no supported state in which a project holds a v2 envelope with v3
  scene data or a v3 envelope with v2 scene data: the combination check of §16.2
  refuses such a document and the migration operator never writes one.
- M1/M2 loading, editing, publication, capture and export paths are unaffected by
  this section (acceptance rows B01/B18).

### 16.6 Durable/blob consequences

1. **One mutable file.** The v3 envelope is still the only mutable authoritative
   file; `content.game` lives inside it. There is no `game.json`, no
   `settings.json` and no side-car.
2. **Blob layout is unchanged.** `sources/sha256/<digest>` remains the only
   authoritative content path; audio bytes are content-addressed exactly like
   model bytes. Publication ordering, lock scope and the crash-point table
   (accepted §13.3) are unchanged.
3. **Integrity.** `contentIntegrity` covers every version of every record,
   `model` and `audio` alike; there is no new integrity state. `readBlob` is
   unchanged and kind-agnostic.
4. **Captured view.** The captured content view (`project-model` §19) is
   extended, not re-versioned: `captureContent` collects references from the
   captured scene's `model` **and** `modelAnimation` components, and from the
   captured `content.game` cues/activation references, resolves them to
   `(version, sourceDigest, sourceByteLength, importRecipe)`, sorts by `assetId`
   and computes `contentDigest` unchanged. `contentVersion` stays `1`; the view
   has no new field, so play/export pinning keeps working by revision
   (§19.3 unchanged). A `modelAnimation` binding pins its recorded `version`
   explicitly in addition to the asset's `currentVersion`. **CC-44-6 (promoted
   at Gate L):** a `modelAnimation` binding's recorded `version` **wins** over
   the asset's `currentVersion` for the same `assetId`. If two reachable
   bindings record different explicit versions for one `assetId`, the first in
   scene document order (then prefab definition order) wins deterministically:
   conflicting bindings are not valid authoring state and capture neither merges
   nor fails on them.
5. **Backup classification** (§15) is unchanged: manifest + envelope +
   every `sources/sha256/<digest>` (model and audio) are included; staging,
   derived caches, ownership, recovery and the migration marker are excluded.
6. **Retention.** v3 has no GC and no version eviction (accepted rule). A
   `modelAnimation` binding to an older version is therefore always deliverable.

### 16.7 Bounds (storage-side v3 additions)

Scene/component bounds are [`project-model.md`](project-model.md) §23.10. Storage adds:

| Class | Bound | Value | Failure |
|---|---|---|---|
| byte | canonical `content.game` | 16 384 B | `content_invalid` (`limits_exceeded` → `game_bytes`), no envelope write |
| byte | canonical `content` (incl. `game`) | 1 048 576 B (unchanged) | as accepted |
| job | migration copy wall clock | 120 s | `content_publish_failed` (`timeout`), destination not authoritative |
| count | migration marker phases | 4 (`created`, `manifest`, `blobs`, `envelope`) | malformed marker ⇒ `migration_marker_conflict` |

These are finite defaults and are **reviewable at Gate K**.

### 16.8 Workspace operations and error codes (v3 additions)

One operation is added, mirroring accepted `migrateProjectCopy` (§11/§14):

| Operation | Kind | Success result | Failure codes |
|---|---|---|---|
| `migrateProjectCopyV3(sourceProjectId, newProjectId)` | operator (§16.5) | the §16.5.2 reported object | `migration_version_unsupported`, `migration_source_invalid`, `migration_destination_exists`, `migration_marker_conflict`, `path_rejected`, `content_publish_failed` |

New codes (additive; surfaced via `project_unavailable.reason` or as operation
results): `migration_version_unsupported` (source/new version pair not a v2→v3
copy), plus the model codes of [`project-model.md`](project-model.md) §23.9 (`game_reference_missing`,
`game_reference_in_use`, `zone_transform_unsupported`,
`spawn_transform_unsupported`,
`zone_checkpoint_count_invalid`, `zone_goal_missing`, `asset_kind_mismatch`,
`game_config_invalid`), which join the permitted `project_unavailable.reason` set
and the `commands.md` §5.4 table.

### 16.9 Public exports

No new package. Additions to the existing public surfaces (implemented by
packets 44–48; **promoted at Gate L**, CC-44-1):

- `project-model` — `SCHEMA_VERSIONS_BY_DOCUMENT`/`KNOWN_VERSIONS` gain `3`;
  `migrateSceneV3`, `validateSceneV3`/`validateContentV3`/`validateProjectV3`
  (names mirroring the accepted v2 entry points), `validateEnvelopeV3`/
  `normalizeEnvelopeV3`/`parseEnvelopeV3`/`parseSceneV3`, `validateGameConfig`,
  the v3 envelope result/error types (`EnvelopeV3Load`, `EnvelopeV3Error`,
  `EnvelopeV3ErrorCode`), `GAME_ZONE_ROLES`, `SURFACE_PRESETS`,
  `GAME_ZONE_LIMITS`, and the v3 types (`GameZoneComponent`,
  `PlayerSpawnComponent`, `CameraFollowComponent`, `LightComponent`,
  `SurfaceComponent`, `ModelAnimationComponent`, `GameConfig`, `CueRef`).
  `canonicalContentV3` is exported from its module but **not** re-exported at the
  package entry (the v3 envelope is built by `workspace`; packet 47's audio
  validation calls it internally).
- `commands` — the §A2–§A6 ops/args/change/inverse types, the
  `queryGameConfig`/`filterEntitiesByComponent` query helpers, and the
  `GAME_CONFIG_FIELDS` constant (exported from its module; the package entry
  re-exports the query helpers and the change types).
- `workspace` — `MigrationResultV3` (the §16.5.2 reported object), the v3
  migration marker `MigrationMarkerV3` (`storageVersion: 3`, `sourceVersion: 2`,
  `newVersion: 3`) and `AnyMigrationMarker` (the union of both marker versions
  `readMigrationMarker` returns and the startup scan reports), and the
  `migrateProjectCopyV3` service method. The v3 envelope builder
  (`buildEnvelopeBytesV3`) and `ENVELOPE_STORAGE_VERSIONS` stay package-internal,
  exactly like `buildEnvelopeBytesV2`.
The v3 envelope is deliberately **not** consumed through
`project-model`'s `validateEnvelopeV3`: the workspace owns the envelope's retry
block, `UnavailableReason` mapping and key-set order (packet 46).

### 16.10 Compatibility and change rules

- v3 is a new known combination, not a same-version extension: v1/v2 documents
  stay valid and unmodified, and no v2 field changes meaning.
- The accepted `content` key order gains `game` **after** `behaviorTrust`; every
  v3 envelope fixture carries all six keys. A v2 envelope keeps its five-key set
  and never carries `game`.
- The added limits and codes are contract material because fixtures and the
  checker reference their exact values.
- Every v3 field, op, code, limit and artifact has exactly one owner
  (`model.md` / this file / `authoring.md`); no downstream packet invents a
  missing field or lifetime rule.

### 16.11 Fixture index

`fixtures/m3/contracts/envelope/valid/*.json` (byte-exact v3 envelopes),
`envelope/invalid/*.json` (one rule each), `migration/{v2-source,expected-v3-destination,
interrupted-copy}/*` (identity/reset/crash outcomes), `commands/*` (legal
edit/inverse/redo, no-change, reachable failures). `index.json` records every
fixture's expectation and SHA-256; `tools/check-fixtures.mjs` replays them and
has a deliberate-corruption negative control.