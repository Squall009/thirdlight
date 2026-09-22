# M4 reliability contract — backup, diagnostics, recovery and the measured budget

**Status:** ACCEPTED at Gate Q (2026-09-22) — promotion applied per
`docs/handoffs/m4-promotion.md` (owner pre-approval under the standing M4
authorization; final owner manual review pending). Packet 67 (two bounded
parts, one handoff). Owner (2026-09-22): "continue until all of M4 is
implemented — do not stop until it is finished."

**Acceptance rows:** C09 (creation/recovery publication survives crashes; no
ready partial), C10 (backup incl. provenance), C11 (audio/presentation on the
reference device), C13 (the measured budget on the owner device).

## 0. Framing and the two parts

- **67-A** (this packet, fully specified + fixtures): the consistent
  backup inventory/verify/restore contract, the diagnostic report envelope
  (limits + redaction), and the recovery fault matrix.
- **67-B** (protocol frozen here; **numerical table BLOCKED**): the named
  device, the digest-frozen budget scenes, the measurement protocol and the
  threshold table for plan §2.6. Representative media/hardware is not yet
  available (packet 63: no physical desktop, display, audio, keyboard or
  gamepad in this container; SwiftShader is never a hardware GPU claim), so
  **Q accepts 67-B as protocol only**, with every numerical threshold
  explicitly marked *blocked, unmeasured* — never invented
  (reference-device.md §2/§3). 67-B resumes after 76/78 on the completed
  independent game: 79's candidate-assembly **preflight may run first, but
  no scored run until target review/promotion and owner confirmation in
  `docs/handoffs/67-budget-ratification.md`**. Early box-only data is not
  representative calibration (the container timing samples of baseline.md §6
  stay samples).
- **State ownership (normative, restated):** the existing workspace owns all
  project state; the offline backup/restore tools operate **only after the
  project is released or the backend is stopped** (they never run against a
  live owner). Same-ID restore and new-ID creation are **distinct**
  operations (§2/§3). **Backup retention is manual** — no silent
  source/backup pruning anywhere (the tools never delete; deletion is an
  operator file operation, documented per action).

## 1. 67-A.1 — The consistent backup

### 1.1 The consistent set (the accepted classification, applied)

A backup of a project is exactly the workspace.md §15 included set: the
manifest (`project.json`), the envelope (`scenes/main.json`) and **every
file under `sources/sha256/` (all versions, including superseded)**.
Excluded, always: `.thirdlight/staging/**`, `.thirdlight/derived/**`,
`.thirdlight/ownership.json` + `claim-*`, `.thirdlight/recovery/**` (optional
evidence retention — a separate operator action, never part of the
consistent set), `.thirdlight/migration.json`, temp files. For a v2-manifest
template project (packet 65) the same set applies — the `template` block
lives inside the manifest, so **the backup carries the template provenance
with no extra class** (C10).

### 1.2 Precondition and the live-project refusal

The tool verifies the precondition before reading any file:

- no ownership record, or a `released` record, or a dead-owner (stale)
  record (the accepted §6.2 liveness test) ⇒ proceed;
- a **live** owner (owned record, holder pid alive, holder ≠ the tool's own
  process) ⇒ refuse `backup_live_project` — **the project bytes are
  untouched** (the refusal retains the original — the fixture obligation).

The backend-stopped case is always safe: a stopped backend cannot hold an
ownership that outlives the process (dead pid ⇒ stale ⇒ the accepted rule).

### 1.3 The backup manifest (the new operator data file)

A backup is a directory (operator-chosen location — outside the data root):

```
<backupDir>/
  backup-manifest.json
  projects/<projectId>/project.json
  projects/<projectId>/scenes/main.json
  projects/<projectId>/sources/sha256/<digest>   (every file)
  exports/<tree>/…                               (optional: the exportRoot closure)
```

```json
{
  "v": 1,
  "backupId": "bkp-<32hex>",
  "createdAt": "<UTC ISO>",
  "engineVersion": "0.1.0",
  "dataRootLabel": "thirdlight-data",
  "inventory": [ { "path": "projects/demo-0001/project.json",
                   "byteLength": 1234, "sha256": "…64hex…" }, … canonical
                  ascending path order … ],
  "inventoryDigest": "sha256:<blockDigest of the inventory rows>",
  "projects": [ { "projectId": "demo-0001", "manifestDigest": "…",
                  "envelopeDigest": "…", "revision": 42,
                  "template": { "templateId": "platformer-starter",
                                 "version": 1, "contentDigest": "…" }? ,
                  "blobCount": 7, "catalogComplete": true } ],
  "retention": "manual"
}
```

- `backupId` = `bkp-` + 32 hex of the operator's CSPRNG (a record, not an
  identity claim); the **identity** is `inventoryDigest` (the accepted
  block-digest rule).
- The manifest is written **last** (after every data file) — a backup
  directory without a valid manifest is **incomplete** and is refused by
  every 67 tool (`backup_incomplete`; delete-and-recreate is the recovery;
  the crash-before-final-publication failure mode).
- `retention: "manual"` is a constant — declared, never acted on by any
  tool (no pruning, no eviction, no silent deletion).

### 1.4 Verify (offline, before any restore/creation)

`verify(backupDir)` — read-only, ordered:

1. the manifest parses (strict shape) — else `backup_manifest_invalid`;
2. every inventory row exists at its exact byteLength — a shorter file is
   `backup_truncated` (a longer one `backup_hash_mismatch` territory — the
   hash step catches it);
3. every row's sha256 matches — `backup_hash_mismatch`;
4. for every project: the envelope catalog's every `sourceDigest` (every
   version, incl. superseded) is present in the inventory —
   `backup_blob_missing` (carries `assetId`, `version`,
   `superseded: true|false`); on-disk files not named by any catalog
   version are **orphan blobs — included and reported
   `orphan_blob` (informational, not a failure — retained history is
   legal)**;
5. no inventory path names an excluded class (`ownership.json`, `claim-*`,
   `staging/`, `derived/`, `migration.json`, temp files) —
   `backup_ownership_included` (the "ownership included" failure — such a
   backup must never be created; a tool that would create it is defective);
6. no inventory path escapes its root (`..`, absolute, symlink-resolved
   outside) — `backup_path_rejected`.

Any failure: the backup is **not usable**; the original project (source) is
never touched by verification (read-only).

### 1.5 Backup creation

`backup(projectIds, destDir)`: precondition (§1.2) → copy the consistent
set (verified source digests as copied — a source file that fails its
catalog hash during copy is `source_blob_corrupt`, the accepted `blob_corrupt`
class, and the backup is marked incomplete, never published) → write the
manifest last. **A partial `destDir` without a valid manifest = not a
backup** (`backup_incomplete`); the tool never overwrites an existing
`destDir` (`backup_destination_exists` — the nonempty-destination failure).

## 2. 67-A.2 — Restore (same-ID) and create (new-ID)

### 2.1 Same-ID restore (the accepted §15 procedure, tool-bound)

`restore(backupDir, destProjectDir, projectId)`:

1. `verify` (§1.4) — a bad backup never reaches the filesystem;
2. `destProjectDir` must **not exist or be empty** — `restore_destination_nonempty` (the nonempty destination failure; **the existing destination is never modified**);
3. copy the project's included set with the accepted atomic per-file
   discipline (temp + rename, fsync — workspace.md §5.1 `W`); no symlink
   creation, path containment as in §1.4 step 6;
4. **identity agreement (checked before the first write):** the backup
   manifest `id` = envelope `projectId` = `destProjectDir`'s basename —
   `restore_identity_mismatch`;
5. re-hash every written file against the inventory; write nothing else;
6. the accepted post-restore verification (workspace.md §15):
   `contentIntegrity` all `ok`, load pipeline success, same digests as the
   backup's envelope, no network. (Steps 1–5 are tool-owned; step 6 is the
   backend's, on next open — the tool reports its own 1–5 result and hands
   off.)

**Ownership after restore:** none is restored (excluded by rule); the
released/dead-owner rules of §6.2 apply (released ⇒ auto-claim on first
open; stale ⇒ explicit takeover). A crash between file writes leaves a
partial directory with no valid identity ⇒ the operator deletes the
directory (a documented file operation) and re-runs; **re-runs are safe
because step 2 refuses a nonempty destination** — no merge, no partial
adoption. The original (source) project is untouched by a restore (a
restore targets a destination, never the source — the source is preserved by
construction).

### 2.2 New-ID creation from a backup (distinct operation)

`create(backupDir, newProjectId)`: `verify` → the **exact identity
transform** (and nothing else):

| Location | Transformation |
|---|---|
| manifest `id` | → `newProjectId` |
| envelope `projectId` | → `newProjectId` |
| directory name | → `newProjectId` |

All other bytes are copied verbatim (the `template` block is preserved —
provenance follows the content; `revision` and history are preserved as
authored — creation is a **copy with a new identity**, not a reset:
contrast the migration operators' `revisionPolicy: "reset-to-zero"`).
`newProjectId` must not collide (destination empty rule, §2.1 step 2).
This is the operator's fork operation — distinct from same-ID restore in
the transform (none vs the 3-field identity rewrite) and documented as
such.

## 3. 67-A.3 — The diagnostic report envelope

A single bounded, redacted, machine-readable point-in-time report — the
operator/harness view across workspace + sessions + play:

```
GET /api/v1/admin/health          (admin scope — the sessions.md §6.3 admin
                                   group; read-only)
MCP tool `tl_health`              (admin-scoped; the 7-tool set gains this
                                   read-only row — C67-2)
→
{
  "v": 1,
  "ts": "<UTC ISO>",
  "backendId": "tb-<32hex>",
  "engineVersion": "0.1.0",
  "process": { "pid": 1234, "nodeVersion": "22.22.1",
               "memoryKb": { "rss": 8192, "heapUsed": 4096 } },
  "workspace": { "projectsScanned": 3, "projectsOk": 2,
                 "blocked": [ { "projectId": "demo-0002",
                                 "reason": "envelope_invalid" } ] },
  "sessions": { "active": 1, "logEntries": 37 },
  "play": { "activePlaySessions": 1, "presented": 1 },
  "content": { "jobsActive": 0, "uploadsActive": 0 },
  "errors": [ { "code": "project_unavailable", "cls": "unavailable",
                "at": "<ts>" } ]
}
```

**Limits (closed):** total serialized ≤ **32 KiB**; `blocked` ≤ 100 entries
(the accepted startup-scan log bound, sessions-clipped); `errors` ≤ the last
**32** (the runtime ring bound); all counters are bounded integers; no field
may exceed its shape. **Overflow behavior:** a serializer that would exceed
a bound clips the bounded list (keeping the most recent) and sets
`truncated: true` — it never throws into the response and never returns an
unbounded document (sessions.md §11.6 boundedness argument, extended).

**Redaction (normative):** the report contains **no** credentials/tokens
(the §4.1 discipline), **no absolute paths** (data-root-relative or
digest/counter only — the §11.1 "no secrets, no absolute paths" rule),
**no content bytes** (digests/counters only), no user names. The envelope is
typed so an unredacted value cannot be represented; a code path that would
emit one is a defect caught by the serializer test (the
"secret/log overflow" failure mode — the bound + redaction make overflow
impossible by construction, and the ring guarantees the log never grows
unbounded).

**Stale identity (normative):** the report is a **point-in-time snapshot**
tagged with `backendId` + `ts` + `engineVersion`. A consumer (harness,
budget run) MUST re-fetch on any identity change (a restart changes
`backendId`) and MUST NOT cache across a `backendId` change; a relayed
diagnostic whose session/play no longer exists after a restart surfaces the
accepted codes (`session_not_found`/`play_not_found`) — the report never
asserts a state older than its `ts` (the "stale diagnostic identity" failure
mode). The report asserts nothing about hardware (no GPU/audio/keyboard
capabilities — those are the 67-B/79 device records, never the backend's).

## 4. 67-A.4 — The recovery fault matrix (normative, consolidated)

One row per crash/fault point across the accepted machinery (workspace §5/§6.3/
§7.5/§9/§13.3/§16.5, packet 65's template phases, packet 66's kit install)
and the 67 operations. Every row names: the on-disk state, the detection
(who, at what point), the recovery (resume / delete-and-retry / operator
file action), and the original-preservation outcome (the fixture
obligation). The matrix (the fixtures carry the full table; representative
rows here):

| # | Fault point | State | Detection | Recovery | Originals |
|---|---|---|---|---|---|
| F1 | crash mid-envelope write (any revision) | the pre-write envelope intact (§5.1 atomic `W`) | open: load succeeds at the previous revision | none | intact |
| F2 | crash between claim-file create and content write | orphan claim at target epoch | open: `claim_inconsistent` | operator file op (prove holder dead, remove claim, re-open — the accepted hint) | intact |
| F3 | crash in a template phase (packet 65 §5) | reservation + partial per-phase state | open/scan: `template_initialization_incomplete` (phase recorded in the marker) | resume (the operator re-issues the same call) or delete the destination | the template sources and every other project untouched |
| F4 | crash mid-backup (67) | partial `destDir`, no valid manifest | the tool: `backup_incomplete` | delete-and-recreate (the tool refuses the nonempty destination — no merge) | the source project byte-identical (read-only during backup) |
| F5 | crash mid-restore/create (67) | partial destination directory | the tool: nonempty-destination refusal on re-run | delete the destination (operator file op), re-run | the source backup + any existing project untouched |
| F6 | disk/write fault during any durable write | the `W` procedure surfaces the fault | the operation's `content_publish_failed`/`write_failed` class; the envelope hash check on next open | the accepted retry/takeover rules; the file is either the old or the new whole document — never a torn write (§5.5) | intact (atomic replacement) |
| F7 | kit file tampered between build and use (66) | vendored kit ≠ `kit.json` | the build tool's pre-build re-hash | `kit_tampered` — re-vendor | the game project + `game.json` untouched |
| F8 | a source blob corrupts (disk rot) | catalog digest ≠ file hash | `contentIntegrity` (open/scan): `blob_corrupt` | the accepted §13.5 handling; a backup taken before the rot restores the bytes | the envelope intact (the blob is the recoverable class) |

Rows F1–F8 pin the **no-ready-partial** invariant (C09): no fault point can
leave a destination that opens as valid while actually partial; every
partial state is detected with a named code before any valid-open claim.

## 5. 67-B.1 — The named reference device (owner decision)

The device of record is the owner's choice (reference-device.md §2 — the
proposed minimum: x86-64 desktop, real (non-SwiftShader) WebGL2 GPU with
recorded `GL_RENDERER`, ≥ 1080p/60 Hz display, ≥ 4 cores/8 GB, physical
keyboard + gamepad, an audio output, warm-cache conditions recorded).
**Status: BLOCKED — owner pending.** Until confirmed, 79 runs preflight only
(no scored run), per §0.

## 6. 67-B.2 — The frozen budget scenes (digest-pinned)

The budget scenes are frozen by **envelope digest** (the canonical
serialization bytes, sha256) — the fixtures record the exact digests:

| Scene | Identity (fixture-recorded) | Why |
|---|---|---|
| S1 — the v3 demo envelope | `fixtures/m3/storage/project-v3-demo-0003/scenes/main.json` sha256 | the committed baseline scene (2 zones, 2 spawns, no assets) |
| S2 — the Beacon Reach captured project | `samples/beacon-reach/captured/project.json` sha256 | the Gate P content scene (r26, the full M3 content set) |
| S3 — the template starter final scene | the 30-command recipe replayed from the packet-65 base scene through the real command engine; the canonical final envelope sha256 (fixture re-derived) | the M4 canonical game scene (20 entities, 7 assets, 1 prefab, 2 decoration instances, the animated courier) |

A budget run names its scene by digest; a digest that does not match a
frozen row is `budget_scene_unfrozen` (79 enforces — the "invalid scene"
failure mode at run time).

## 7. 67-B.3 — The measurement protocol (frozen here)

1. **Environment record (every run):** OS/kernel, CPU model + core count +
   throttling state, GPU + `GL_RENDERER` (software GL ⇒ the run is
   invalidated, not scored), display resolution/refresh, Node version, the
   engine pin (kit identity per packet 66), the game pin, the scene digest,
   browser + real (non-headless software-GL) viewport, cache state
   (warm-cache-only claims require the cache record — the 79 failure mode),
   clock source + resolution, observer tooling.
2. **Trial protocol:** 10-minute warmup; N ≥ 30 scored trials per metric
   (soak metrics: the §2.6 duration); per-trial records: the metric value,
   `ts`, trial index, the environment record hash. Statistics of record:
   **median and p95** (the p99 requires N ≥ 100 and is marked
   `insufficient_samples` below that). No trial averaging beyond the stated
   statistics; no outlier discarding (recorded, not removed).
3. **Metric list (closed for M4):** play-present latency (POST →
   `presented`), scene load time (iframe src → first frame presented),
   frame-time p95/p99 (rAF delta, the runtime `frameCount`-tagged samples),
   input-to-visible latency (key event → first rendered step with that
   input — the 63 input-latency row), export duration (route → complete
   closure), memory high-water (process RSS, per-phase), soak stability
   (30-min run: dropped steps, error count, GC pauses observable via the
   frame-time ring).
4. **No early box data:** the container samples (baseline.md §6) are
   reproducibility samples only; any box-only number submitted as a
   threshold candidate is refused (`budget_source_not_representative`).

## 8. 67-B.4 — The threshold table (BLOCKED — unmeasured)

Every plan §2.6 budget row carries a threshold column that is **explicitly
`BLOCKED — unmeasured`** in this proposal (the fixtures pin the table with
every threshold marked blocked — the "unmeasured thresholds stay explicitly
blocked, not invented" acceptance rule). The table's rows (metric, scene,
condition, threshold, source-of-record) are the frozen shape; filling them
is the post-ratification 67-B resume (owner device confirmed, 76/78
complete, the 79 scored runs, and the owner's ratification in
`docs/handoffs/67-budget-ratification.md`).

## 9. New error codes (closed list)

`backup_live_project`, `backup_manifest_invalid`, `backup_truncated`,
`backup_hash_mismatch`, `backup_blob_missing`, `backup_path_rejected`,
`backup_ownership_included`, `backup_incomplete`, `backup_destination_exists`,
`source_blob_corrupt`, `restore_destination_nonempty`,
`restore_identity_mismatch`, `budget_scene_unfrozen`,
`budget_source_not_representative` — plus the reused accepted codes
(`blob_corrupt`, `content_publish_failed`, `claim_inconsistent`,
`template_initialization_incomplete`, `kit_tampered`, …). Tool-surface codes
(`backup_*`/`restore_*`/`budget_*`) are raised by the offline/budget tools
and the `tl_health`-adjacent surfaces; they enter no accepted contract's
code table without the Gate Q promotion.

## 10. Owned contract diffs (Gate Q — PROPOSED)

- **C67-1 — workspace.md (no change, adjudicated):** the backup/restore/
  create tools are **offline operator tools** on the accepted §15
  classification — they add no workspace operation, route, artifact class or
  error code to the workspace contract (the backup manifest lives with the
  backup, outside the data root; the tools' codes are tool-surface codes).
  The §15 text stands; the 67 tools are its normative execution.
- **C67-2 — sessions.md (one admin route + one MCP tool):** new
  `GET /api/v1/admin/health` (admin scope, read-only, the §3 envelope, the
  §11.2 error discipline) and the admin-scoped MCP read row `tl_health`.
  The §11.5 constants gain the report bounds (32 KiB total; 100/32 list
  bounds — the existing scan/ring bounds re-used, no new constant values).
  No other sessions change (the auth model, the error table, the relay chain
  are untouched).
- **C67-3 — runtime.md (no change, adjudicated):** the runtime §8
  diagnostics are the per-play source the report aggregates; no runtime
  field, bound or code changes (the report never adds a runtime state).
- **C67-4 — dependencies.md (no change + tooling edge):** no new package or
  dependency (the backup/restore/budget tools are plain-Node scripts,
  `node:*` only — the packet-66 tooling-edge pattern; CCR-67-1: they ship
  with the packet-75/79 tooling).
- **C67-5 — deployment.md §5 REPLACEMENT PROPOSAL:** the accepted text's
  "stop the backend … `tar czf tl-backup.tgz <dataRoot> <exportRoot>`" is
  replaced by the 67-A procedure: the inventory-based backup (the consistent
  set only — the raw tar includes the excluded staging/derived/ownership
  classes and carries no verification), `verify` before any restore,
  same-ID restore / new-ID creation with the nonempty-destination refusal,
  the manual-retention declaration, and the `GET /api/v1/admin/health`
  diagnostic route. The restore-takeover note is preserved (dead owners
  still need the explicit takeover).

## 11. Fixtures (packet 67 — `fixtures/m4/reliability/`)

- the backup-manifest example re-derived from the committed v3 fixture
  (real bytes/digests: manifest + envelope, 0 blobs — the consistent set);
- the refusal cases **executed by the checker's reference implementation**
  of the §1–§2 procedures against temp project trees (truncated file, bad
  hash, missing catalog blob, missing *superseded* blob, ownership-included
  inventory, nonempty destination, symlink escape, live-project refusal via
  a live ownership record) — **each case proves the original tree is
  byte-identical after the refusal** (the acceptance obligation);
- the same-ID vs new-ID transform cases (the 3-field identity rewrite,
  verified byte-exactly on a temp project);
- the fault matrix F1–F8 (the full table, with the 65/66 rows);
- the diagnostic envelope example + the overflow/redaction/stale-identity
  cases (the serializer rules as pure logic);
- the 67-B tables: the named device (BLOCKED placeholder), the 3 frozen
  scene digests (re-derived: S1/S2 from committed bytes, S3 by replaying
  the packet-65 recipe through the real command engine), the protocol, and
  the threshold table with **every row marked `blocked`**.

## 12. CCRs

- **CCR-67-1** — the backup/restore/budget tool scripts ship with the
  packet-75/79 tooling (plain Node, no dependencies) — the tooling-unit-edge
  pattern of CCR-66-2; Q record.
- **CCR-67-2** — the 67-B numerical table stays BLOCKED until the owner
  device + ratification; Q records that independent non-performance work
  proceeds meanwhile (the reference-device.md §3 record, re-affirmed here).