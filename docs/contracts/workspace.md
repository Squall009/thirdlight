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
  .thirdlight/
    ownership.json                 ownership record (§6)
    recovery/
      scene-<UTCstamp>-<sha8>.json recovery snapshots of external/foreign bytes (§7) — at most 16 kept, oldest pruned
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

### 4.2 Fields (storageVersion 1)

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
| `retry` | object | `{ "retention": 128, "records": [ … ] }` — the retry block of commands.md §7.1. `retention` is the constant 128 recorded for readers. `records` in strictly ascending `appliedRevision` order, each record `{ requestId, digest, appliedRevision, result }` well-formed per commands.md §7.1. |

Strictness: unknown fields at any level ⇒ invalid envelope
(`envelope_invalid`, nothing stripped). `scene` must satisfy the full
project-model scene validation (values, hierarchy, limits, exactly one
camera). Cross-document checks run against the manifest (project-model
§13): `manifest.scenes[0].id === scene.sceneId`, `manifest.id ===
envelope.projectId === directory name`.

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
3. `storageVersion` present and known: M1 knows `[1]`. Unknown (higher or
   lower) ⇒ exactly one `storage_version_unsupported`; deeper checks stop.
4. `type === "authoring-state"` else `envelope_invalid`.
5. `projectId` equals the directory name, else `envelope_project_mismatch`.
6. `scene` → `validateScene` (project-model). Failure ⇒ `scene_invalid`,
   carrying the project-model error objects (≤ 10 reported, count given).
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
(commands.md §9).

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
every `scenes/.main.json.tmp-*` file. Leftover temps exist only because a
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
   operator explicitly resolves (accept/discard).
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
| absent | — | claim: write our record (`lockEpoch` 0) via `W` + verification re-read (§6.3); on re-read mismatch re-evaluate (a concurrent claimer won) |
| `state: "released"` | — | claimable: same claim procedure (`lockEpoch` = previous + 1) |
| `owned`, same `backendId` + `pid` as self | the same process re-opening (e.g. in-memory state was discarded) | claimable (same procedure) |
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

### 6.3 Claim primitive (the only ownership write)

Claim = `W(our-record, ownership.json)` followed by a **verification
re-read**: the on-disk record must contain *our* `backendId`, `pid`, and
`lockEpoch`. If it doesn't, another claimer renamed over us; we re-read and
re-evaluate that record (a live foreign owner ⇒ `ownership_conflict`). The
rename + verify sequence means concurrent claimers converge to exactly one
winner without any lock file or unlink: the loser observes the winner's
live record and aborts.

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
  (§6.3) with `lockEpoch` = previous + 1. (4) Load the project (§4.3).
  Success result: `{ ok: true, lockEpoch, backendId, pid }`; failure:
  `ownership_conflict` or `stale_ownership` (with the fresh holder).
- **Residual split-brain (honest bound):** two *simultaneous* takeovers of
  the same dead owner require two simultaneous operator actions; if both
  race, the claim primitive yields one winner (loser sees the winner's live
  record and aborts). The pathological remainder (a backend that believed
  it owned before a record was stolen from under it) degrades safely: its
  next envelope write's pre-write check (§5.2) finds foreign bytes,
  pauses, and snapshots them — no silent corruption of the envelope, and
  both envelopes involved are complete valid documents.

### 6.5 Ownership lifecycle

- Written on claim (§6.3); rewritten on release with `state: "released"`
  (§9) — **the file is never deleted** (deletion would reintroduce the
  absent-record race).
- Owner crash: record persists with a dead pid ⇒ stale ⇒ explicit takeover
  (the envelope is untouched by any of this; its validity is re-checked at
  the new owner's open).
- The ownership file is a workspace artifact, not authoring data: it is
  excluded from logical reading, from external-change detection (§7
  monitors the envelope only), and from G1's authoring guarantees (its own
  writes use the same `W`, so it is torn-free too).

## 7. Unexpected external modification

### 7.1 What is and isn't guaranteed

The backend detects external edits **at the next envelope write** (pre-
write check, §5.2) and **after every rename** (verification read, §5.1
step 5); an optional inotify watcher may trigger *earlier* detection but
**is not normative** — correctness does not depend on it.

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

1. Reads the on-disk bytes `B`; computes `sha256(B)`.
2. **Snapshots** `B` byte-for-byte to
   `.thirdlight/recovery/scene-<UTCstamp>-<sha8>.json`
   (`UTCstamp` = `YYYYMMDDTHHMMSSZ`; `sha8` = first 8 hex of the hash;
   oldest pruned to keep 16). The original file is left **in place** —
   it is not overwritten or "fixed" until an operator resolves.
3. Parses/validates `B` through the full §4.3 pipeline (strict parse,
   `storageVersion`, `type`, `projectId`, `validateScene`, retry block,
   cross-document). Result: `externalValid: true` or the error objects
   (≤ 10 reported).
4. Sets the project's **pending change** state `{ externalHash, externalValid,
   externalErrors }` and **pauses writes**:
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
`external_change_invalid`). The bytes are retained for repair; the project
stays paused.

### 7.3 Resolution (operator commands)

- **`acceptExternalState(projectId)`** — precondition: a pending change
  exists and `externalValid` is true. Effect: the external scene becomes
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
  exists. Effect: the last known good envelope bytes (verified against
  `lastWrittenHash` before writing) are re-written via `W`, restoring the
  previous state exactly; the external bytes remain only in the recovery
  snapshot; history is cleared (new boundary — the file was replaced
  externally, charter §6, and M1 performs no reconciliation).
  Result: `{ ok: true, revision, historyReset: true }`.
- Re-issuing either with no pending change ⇒ `no_pending_change`.
  Resolving clears the pending state and unpauses writes.
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

### 7.5 Corrupt envelope at open (no last known good)

If §4.3 fails at open/load (fresh process, no in-memory LKG), the project
is **blocked**: commands return `project_unavailable` (reason = the
specific code), queries fail the same way. The file is retained
byte-for-byte; the backend **never auto-repairs, auto-reverts, or
auto-deletes**. Recovery is operator-driven: repair the file by hand (a
recovery snapshot or a backup, if available) and re-open. This is the
project-model §12.4 rule at the workspace level: no destructive rewrite,
ever.

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
- Crash after step 3 with no manifest (only possible if the manifest was
  deleted after the fact) ⇒ orphan: reported at startup scan, retained,
  operator removes.
- The creation is idempotent per §8.1, so a retried `createProject` after
  any crash converges to the same project state.

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
   - rewrites the ownership record with `state: "released"` (same claim
     primitive), and
   - discards in-memory state (history and record map).
   Result: `{ ok: true, revision, retryCleared: true }`. While released,
   commands return `workspace_closed` and queries fail with
   `project_unavailable { reason: "workspace_closed" }`.
2. **External edit.** The operator edits `scenes/main.json` by hand (it is
   the envelope — edit `scene` only; keep `storageVersion`, `type`,
   `projectId`, the revision semantics, and `retry.records: []`). The
   manifest stays untouched (immutable, §8.2). The backend is not involved
   and holds no lock — the released record is what lets a later open claim
   the project.
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
| orphan (no loadable manifest) | reported, retained |
| corrupt manifest/envelope | reported with the §4.3 codes, retained, blocked until operator repair |
| stale ownership record (dead pid) | reported; **no** action (takeover remains explicit) |
| leftover temps | **not** cleaned here — only the owner cleans temps, at open (§5.4) |

The scan performs no writes except the deterministic creation completion,
and claims no ownership.

## 11. Workspace operations and error codes

| Operation | Kind | Result on success | Failure codes |
|---|---|---|---|
| `createProject(projectId, name)` | operator | `{ ok, created, revision? }` | `field_*` (args), `project_exists_invalid` |
| `releaseWorkspace(projectId)` | operator | `{ ok, revision, retryCleared }` | `project_not_found`, `project_unavailable`, `ownership_conflict` |
| `takeoverWorkspace(projectId)` | operator (explicit, §6.4) | `{ ok, lockEpoch, backendId, pid }` | `ownership_conflict`, `stale_ownership`, `project_not_found` |
| `acceptExternalState(projectId)` | operator | `{ ok, revision, historyReset, retryCleared }` | `no_pending_change`, `external_change_invalid`, `project_unavailable` |
| `discardExternalState(projectId)` | operator | `{ ok, revision, historyReset }` | `no_pending_change`, `project_unavailable` |

(Transport/auth for these operator commands is packet 09; in M1 they are
admin-scoped — never exposed as browser/MCP mutation commands.)

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
| `ownership_conflict` | live owner holds the project (§6.2; carries `holder`) |
| `stale_ownership` | dead owner; explicit takeover required (§6.2/§6.4; carries `holder`) |
| `workspace_closed` | project released for maintenance (§9) |
| `external_change_invalid` | pending external change failed validation; `acceptExternalState` refused |
| `no_pending_change` | resolve command with nothing pending (§7.3) |
| `project_exists_invalid` | `createProject` onto an unloadable existing directory (§8.1) |

**Permitted `project_unavailable.reason` values (normative):** the codes
in this table **plus** the codes the §4.3 load pipeline surfaces from the
strict parse and cross-document checks — `encoding_invalid`,
`json_parse_error`, `duplicate_key`, `field_type`,
`manifest_scene_mismatch` (project-model.md §12.3/§12.6/§13 codes) —
since a project that exists on disk but cannot load is exactly what
`project_unavailable` reports.

`holder` in ownership errors: `{ backendId, pid, openedAt, lockEpoch,
state }`.

## 12. What is deliberately not in M1 (normative non-goals)

- **No multi-scene, no multi-file transactions.** M1 writes exactly one
  authoring file per transaction (the envelope) plus, once, the creation
  sequence (§8.3) with its completion rule. Any future capability that
  spans multiple files (multi-scene projects, assets, prefabs) **requires a
  new persistence contract** — journaling, a transaction log, or equivalent
  recovery semantics. It may not be bolted on as "several renames".
- No journaling/redo log on disk; history is in-memory (commands.md §9).
- No backups feature (recovery snapshots are evidence, §7.4).
- No concurrent-writer protocol (one owner; external writers are
  detected/paused, never synchronized).
- No network-filesystem support (§2), no cross-project atomicity, no
  replication, no automatic external-edit reconciliation (§7.3), no
  automatic ownership takeover (§6.4), no per-entity or per-component file
  storage, no compression/segmentation of the envelope.
- No watchers in the guarantees (§7.1): inotify is an optional early-warning
  aid, never a correctness dependency.