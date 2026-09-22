PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# PROPOSED section-level diffs — `docs/contracts/workspace.md`

**PROPOSED — pending Gate E.** Packet 15 (`docs/planning/m2-packets.md` §15)
output. No accepted text is changed here: every destination section is named, old
→ new text is given for existing sections, and new sections state their anchor and
their normative text source.

Read with: [`../content-storage.md`](../content-storage.md) (normative text for
the new sections), [`project-model.md`](project-model.md) (the version/catalog
side), [`../assets.md`](../assets.md) (asset records, import profile).
Promotion is docs-only, per diff, at Gate E. Owner pre-approval:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending.**

This diff is also the resolution of the architectural plan review's
**BR-4** finding (`docs/handoffs/m2-plan-review.md`) and of its non-gating
observation **(a)** (the `.thirdlight/` namespace reuse): §7.6 defines the staging
area as a supported edit path, and the §3 diff adds the two new
sub-namespaces explicitly.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| W1 | §3 "Layout and artifacts" | modify block + insert rules | `../content-storage.md` §2 |
| W2 | §4.2 "Fields (storageVersion 1)" → "(storageVersion 1 and 2)" | retitle, insert row, modify example | `../content-storage.md` §3 |
| W3 | §4.3 "Load validation pipeline" step 3 + insertion of 6a–6h | reword + insert | `../content-storage.md` §3.2 |
| W4 | §4.4 "Envelope serialization" | insert key-order line | `../content-storage.md` §3 |
| W5 | **new §4.5** "Envelope version compatibility (v2)" | insert subsection | `../content-storage.md` §3.1 |
| W6 | §5.1 "The write procedure" | insert note | `../content-storage.md` §4 |
| W7 | §5.4 "Temp-file hygiene" | reword | `../content-storage.md` §4 rule 5 |
| W8 | §5.5 "Guarantees" | insert addendum G3 + crash-point table | `../content-storage.md` §6.4 |
| W9 | **new §7.6** "The supported staging area (BR-4)" | insert subsection | `../content-storage.md` §5 (verbatim) |
| W10 | §7.1/§7.2 | insert one scope sentence each | this file |
| W11 | §8.3 + §10 scan table | insert clause + row | `../content-storage.md` §12.3 |
| W12 | §9 maintenance procedure | insert cross-reference | this file |
| W13 | §11 operations + error tables | insert rows | `../content-storage.md` §13 |
| W14 | §12 "What is deliberately not in M1" | reword two bullets + insert two bullets | this file |
| W15 | **new §13** "Content storage, publication and retention" | insert section (10 subsections) | `../content-storage.md` §§2,4,6,7,8,9,10,15,16 |
| W16 | **new §14** "Migration: M1 project → M2 project copy" | insert section | `../content-storage.md` §12 |
| W17 | **new §15** "Artifact backup classification" | insert section | `../content-storage.md` §11 |

Not changed: §§1, 2, 6 (ownership), 8.1/8.2/8.3 (except W11), the §5.1 write
steps 1–5, §5.2 pre-write check, §5.3 ack timing, §5.5 G1/G2 (extended, not
altered), §7.3/§7.4/§7.5 (external-change resolution, recovery artifacts, corrupt
envelope).

---

## B. Existing sections

### W1 — §3 "Layout and artifacts"

Replace the layout block:

```diff
 <root>/projects/<projectId>/
   project.json                     manifest — IMMUTABLE after creation (§8)
   scenes/
     main.json                      the atomic authoring-state envelope (§4) — the ONLY mutable authoring file
     .main.json.tmp-<pid>-<nonce>   temp file, exists only during one write sequence; cleaned on open (§5.4)
+  sources/
+    sha256/
+      <64-lowercase-hex>           AUTHORITATIVE immutable source bytes; the file name IS its SHA-256 (new §13.2)
+      .<digest>.tmp-<pid>-<nonce>  temp file during blob publication; cleaned on open (§5.4)
   .thirdlight/
     ownership.json                 ownership record (§6)
     claim-<e>                      claim file (claim gate, §6.3/§6.5) — one per epoch; unlinked on release (§9)
     recovery/
       scene-<UTCstamp>-<sha8>.json recovery snapshots of external/foreign bytes (§7) — at most 16 kept, oldest pruned
+    staging/
+      <stageId>/
+        source.bin                 staged source bytes — non-authoritative INPUT, supported edit path (new §7.6)
+        stage.json                 optional { "displayName": … } — non-authoritative input
+    derived/
+      <sourceDigest>/<recipeDigest>/
+          import.json              derived, regenerable decoded-import description (new §13.6)
+          <name>.bin               derived, regenerable binary caches
+    migration.json                 migration-copy marker — exists ONLY while a destination is being created (new §14)
```

and insert after the bullet ending `…excluded from any logical-document reading.`

```diff
+- `sources/` holds the **only** authoritative content bytes: immutable,
+  content-addressed, write-once files under `sources/sha256/<digest>`. The
+  `derived/`, `staging/` and `migration.json` entries are the **new M2
+  sub-namespaces** added to the `.thirdlight/` namespace this section reserves
+  for ownership/claim/recovery. They are not authoring documents, are excluded
+  from every logical-document read, and their absence or corruption is never a
+  project-blocking error. `.thirdlight/migration.json` exists only inside a
+  destination that is being created (new §14.3).
+- Content artifact paths are addressed only by project ID plus a model-level
+  identifier (`assetId`, `version`, `stageId`, `digest`); no public operation
+  accepts a filesystem path. Every artifact directory must be a real directory
+  whose resolved path stays under the project root, and authoritative blobs are
+  opened with `O_NOFOLLOW`; a violation is `path_rejected` before the first read
+  or write (new §13.1).
```

### W2 — §4.2 fields

**(a) Retitle**

```diff
-### 4.2 Fields (storageVersion 1)
+### 4.2 Fields (storageVersion 1 and 2)
```

**(b) Insert into the example envelope** — after the `scene` member, before
`retry`:

```diff
+  "content": {
+    "assets": [ /* AssetRecord values; project-model §18 */ ],
+    "prefabs": [],
+    "behaviors": [],
+    "settings": {}
+  },
```

**(c) Insert a table row** after the `scene` row:

```diff
+| `content` | object | **v2 only** (`storageVersion` 2): `{ "assets": [ … ], "prefabs": [], "behaviors": [], "settings": {} }` — all four keys required; `assets` is `project-model` §18 (≤ 128 records), the other three are reserved containers that must be empty in v2. Bounded: canonical `content` bytes ≤ 1 048 576. Validated by `validateContent`; failures ⇒ `content_invalid` (≤ 10 model errors + true count). **Envelope state only** — there is no standalone catalog file, and `scene.revision` remains the only revision in the envelope. |
```

**(d) Insert strictness prose** after the paragraph beginning `Strictness: unknown
fields at any level ⇒ invalid envelope`:

```diff
+In a `storageVersion` 2 envelope the envelope's own key set is exactly
+`{storageVersion, type, projectId, scene, content, retry}` (missing or unknown
+key ⇒ `envelope_invalid` with the corresponding `field_missing` /
+`field_unexpected`), and the §4.5 combination check runs **before** any scene or
+content field validation. A `storageVersion` 1 envelope keeps the accepted
+five-key set exactly and never carries `content`.
```

### W3 — §4.3 load pipeline

**(a) Step 3**

```diff
-3. `storageVersion` present and known: M1 knows `[1]`. Unknown (higher or
-   lower) ⇒ exactly one `storage_version_unsupported`; deeper checks stop.
+3. `storageVersion` present and known: M2 knows `[1, 2]`. Unknown (higher or
+   lower) ⇒ exactly one `storage_version_unsupported`; deeper checks stop. The
+   value selects the pipeline branch (step 6a).
```

**(b) Insert the v2 branch after step 6 (`scene` → `validateScene`)** — the
accepted step 6 statement stays as the `storageVersion` 1 path; add:

```diff
+   **6a–6h — `storageVersion` 2 branch (new §4.5/§13).** For a v2 envelope:
+   a. envelope key set exactly
+      `{storageVersion, type, projectId, scene, content, retry}` ⇒ else
+      `envelope_invalid`;
+   b. version-combination check (§4.5): `scene.schemaVersion` must be `2` and
+      `content` must be present ⇒ else exactly one
+      `version_combination_unsupported`, deeper checks stop;
+   c. `scene` → v2 scene validation ⇒ `scene_invalid` (≤ 10 errors);
+   d. `content` → `validateContent` ⇒ `content_invalid` (≤ 10 errors); c and d
+      are both evaluated and both error sets reported when both fail;
+   e. cross-block check (`validateProjectV2`, project-model §13.1): only when c
+      and d both pass ⇒ `asset_reference_missing` (`document: "scene"`);
+   f. canonical `content` byte budget ≤ 1 048 576 ⇒ `content_invalid`
+      (`limits_exceeded`, `limit: "content_bytes"`);
+   g. the retry block check of the accepted step 7 runs unchanged ⇒
+      `retry_records_invalid`;
+   h. the manifest (must be `schemaVersion` 1) and the accepted step 8
+      cross-document checks run unchanged ⇒ `manifest_invalid` /
+      `manifest_scene_mismatch`, plus `manifest.id === envelope.projectId ===
+      directory name`.
```

**(c) On success** the backend additionally holds the normalized content catalog,
the per-asset `currentVersion` map and a bounded content integrity report
(§13.5). History is still empty.

### W4 — §4.4 envelope serialization

```diff
-- Fixed key order: envelope `storageVersion, type, projectId, scene,
-  retry`; scene/entities/components per project-model §12.2; `retry`:
+- Fixed key order: envelope `storageVersion, type, projectId, scene,
+  content (storageVersion 2 only), retry`; scene/entities/components per
+  project-model §12.2; `content` per project-model §12.2 (assets ascending by
+  `assetId`); `retry`:
```

### W5 — new §4.5 "Envelope version compatibility"

Insert **after §4.4** (before §5). Normative text: `../content-storage.md` §3.1
(the exhaustive matrix, the "no silent upgrade on open" rule and the "no
downgrade" rule), plus a sentence fixing the storage-version dispatching rule
("exactly two passable combinations; `schemaVersion`/`storageVersion` changes are
reviewable contract changes, never same-version extensions").

### W6 — §5.1 "The write procedure `W(bytes, target, dir)`"

Insert before the "Steps 1–5 are retried as a whole" paragraph:

```diff
+**M2 application (new §13.2).** Content blob publication reuses `W`
+byte-for-byte with `target = sources/sha256/<digest>` and
+`dir = sources/sha256/`. The workspace computes the digest from the bytes it
+read (a caller-supplied digest is never authoritative), and an existing path
+whose content is read and re-hashed: match ⇒ no write (idempotent retry),
+mismatch ⇒ `blob_corrupt` and **no overwrite** — refusing to overwrite a
+content-addressed path is what makes a foreign write or an external tamper
+detectable. Blob publication changes no authoritative state: no reference, no
+revision, no retry record, and it requires no mutation lock.
```

### W7 — §5.4 temp-file hygiene

```diff
-On a successful open (after ownership is acquired, §6.2), the owner deletes
-every `scenes/.main.json.tmp-*` file.
+On a successful open (after ownership is acquired, §6.2), the owner deletes
+every `scenes/.main.json.tmp-*` file **and** every
+`sources/sha256/.<digest>.tmp-*` file (the blob-publication temps of §13.2).
```

### W8 — §5.5 guarantees

Insert after the accepted crash-point table (before §6):

```diff
+**G3 — content publication addendum (M2, new §13.3).** For a content
+publication, a successful ack implies that (i) the referenced immutable bytes
+exist durably under `sources/sha256/<digest>` and (ii) the new scene revision,
+the catalog version and the retry record are in the same atomic envelope
+replacement, verified by `W` step 5. A failure or crash before the envelope
+commit may leave **unreferenced immutable bytes** (retained; never deleted, and
+never an acked dangling reference: the commit-time application step re-verifies
+that the referenced blob exists and matches its digest, failing closed with
+`blob_missing` / `blob_corrupt` otherwise). The content crash-point table is
+§13.3.4; it extends the table above with the blob phase and never weakens it.
```

### W9 — new §7.6 "The supported staging area (BR-4)"

Insert **after §7.5**. Normative text: `../content-storage.md` §5 verbatim
(definition, `source.bin`, the six invariants — in particular that §5.2 and §7
are scoped to the authoring files and must never be extended to `.thirdlight/**`,
so a harness staging edit causes no pause, no recovery snapshot and no
quarantine — plus lifecycle, TTL, cleanup and bounds). This is the contract
answer to `docs/handoffs/m2-plan-review.md` BR-4; the fixtures that pin it are
`fixtures/m2/contracts/cases/staging-harness-edit-publish-succeeds.json`,
`…/staging-crash-mid-publish-retry.json` and `…/staging-traversal-symlink-rejected.json`.

### W10 — §7.1 and §7.2 scope sentences

In §7.1, after the sentence ending `…correctness does not depend on it.`:

```diff
+**Scope (M2):** this section and §5.2 apply to the **authoring files** —
+`scenes/main.json` (and the manifest at creation). They must never be extended
+to any path under `.thirdlight/**`; the staging area is a supported edit path
+with its own invariants (§7.6).
```

In §7.2, in the step-4 list item beginning `- Mutations ⇒ …`, no change; insert
before it:

```diff
+   Only the authoring file's bytes can trigger this protocol. A write to
+   `.thirdlight/staging/**` (or `.thirdlight/derived/**`) is not a pending
+   change and never sets `writePaused`.
```

### W11 — §8.3 and §10: the migration marker

Extend §8.3's completion rule:

```diff
+**Migration destinations are exempt (M2, new §14.3):** a directory that carries
+a valid `.thirdlight/migration.json` marker is an interrupted migration
+destination, not an interrupted project creation, and the deterministic
+default-envelope completion above **must not** run for it (it would create an
+empty default project and destroy the migration intent). Such a directory is
+reported by the scan (below) and completed only by resuming
+`migrateProjectCopy` or by the operator deleting it.
```

Add a startup-scan row (§10 table):

```diff
+| directory with a valid `.thirdlight/migration.json` marker and no envelope (interrupted migration destination) | reported as an interrupted migration destination with `migration_resume_required`; **no** action, **no** §8.3 completion; resumable or deletable |
```

### W12 — §9 maintenance procedure

Insert a sentence after step 2 (`**External edit.** …`):

```diff
+Staging a source file for a content publish is a **different, supported** path
+that needs no release (§7.6): it writes only under `.thirdlight/staging/**`,
+never touches the envelope, and therefore cannot conflict with the pause
+protocol. Use this procedure (§9) only for hand edits of the envelope itself.
```

### W13 — §11 operations and error codes

**(a) Operation rows** (append to the operations table):

```diff
+| `stageContent(projectId, { stageId, bytes, displayName? })` | caller/harness input (non-authoritative) | `{ ok, stageId, byteLength, digest, expiresAt }` | `stage_limits_exceeded`, `path_rejected`, `project_not_found`, `project_unavailable` |
+| `inspectStage(projectId, stageId)` | proposal (non-authoritative) | `{ ok, proposal }` (project-model §19/`assets.md` §8) | `stage_not_found`, `stage_expired`, `import_rejected`, `derived_cache_unavailable` (non-fatal) |
+| `publishBlob(projectId, { digest, byteLength, source })` | immutable publication (no lock) | `{ ok, digest, byteLength, published, alreadyPresent }` | `blob_corrupt`, `content_quota_exceeded`, `content_publish_failed`, `path_rejected`, `stage_not_found`, `stage_expired` |
+| `discardStage(projectId, stageId)` | cleanup | `{ ok, discarded }` | `stage_not_found` |
+| `readBlob(projectId, { assetId, version })` | verified read | `{ ok, assetId, version, digest, byteLength, verified: true, bytes }` | `asset_not_found`, `asset_version_not_found`, `blob_missing`, `blob_corrupt`, `path_rejected` |
+| `contentIntegrity(projectId)` | read | `{ ok, entries, summary }` | `project_not_found`, `project_unavailable` |
+| `captureContentView(projectId)` | pure read | `{ ok, view }` | `project_not_found`, `project_unavailable` |
+| `migrateProjectCopy(sourceProjectId, newProjectId)` | operator (§14) | `{ ok, sourceProjectId, newProjectId, sourceRevision, newRevision: 0, revisionPolicy: "reset-to-zero", historyReset: true, retryCleared: true, blobsCopied, resumed }` | `migration_source_invalid`, `migration_destination_exists`, `migration_marker_conflict`, `migration_resume_required`, `path_rejected`, `content_publish_failed` |
```

**(b) Error-code rows** (append to the code table):

```diff
+| `content_invalid` | the `content` block fails validation (carries ≤ 10 project-model errors + true count) |
+| `version_combination_unsupported` | a `storageVersion` 2 envelope whose `scene.schemaVersion` is not 2 (single error, deeper checks stop) |
+| `stage_not_found` | the staging directory does not exist |
+| `stage_expired` | the staging directory exists but is older than the 3 600 s stage TTL |
+| `stage_limits_exceeded` | a staging bound is exceeded (`limit`: `stage_bytes` / `frame_bytes` / `open_stages` / `staged_bytes_per_project`) |
+| `path_rejected` | an artifact path is a symlink, escapes the project root, or is not a real directory/file under the project |
+| `import_rejected` | the M2 import profile rejects the bytes (carries the ordered `asset_*` diagnostics, ≤ 10 + count) |
+| `asset_id_duplicate` | a create targets an existing `assetId` |
+| `asset_not_found` | an operation names an unknown `assetId` |
+| `asset_version_not_found` | an operation names an unknown version of a known asset |
+| `blob_missing` | a referenced authoritative blob does not exist |
+| `blob_corrupt` | a blob's content does not match its digest, or an existing content-addressed path holds other bytes |
+| `content_quota_exceeded` | project quota or device free space is insufficient (`kind`: `project_quota` / `device_space`; carries used/limit/needed) |
+| `content_publish_failed` | a non-envelope publication phase failed (`reason`: `write` / `timeout` / `busy`, with `onDiskState` for the blob phase) |
+| `derived_cache_unavailable` | a derived cache is missing/corrupt and could not be regenerated |
+| `migration_source_invalid` | the source project is missing or does not load under the M1 pipeline |
+| `migration_destination_exists` | the destination already contains a loadable project |
+| `migration_marker_conflict` | a marker exists for different source/new IDs |
+| `migration_resume_required` | an interrupted migration destination must be resumed (informational) |
```

**(c)** In the "Permitted `project_unavailable.reason` values" paragraph, add
`content_invalid`, `version_combination_unsupported` and `asset_reference_missing`
to the listed pipeline-surfaced codes.

### W14 — §12 "What is deliberately not in M1 (normative non-goals)"

**(a) Reword the multi-file bullet:**

```diff
-- **No multi-scene, no multi-file transactions.** M1 writes exactly one
-  authoring file per transaction (the envelope) plus, once, the creation
-  sequence (§8.3) with its completion rule. Any future capability that
-  spans multiple files (multi-scene projects, assets, prefabs) **requires a
-  new persistence contract** — journaling, a transaction log, or equivalent
-  recovery semantics. It may not be bolted on as "several renames".
+- **No multi-scene, no multi-file transactions.** M1 writes exactly one
+  authoring file per transaction (the envelope) plus, once, the creation
+  sequence (§8.3) with its completion rule. Any future capability that
+  spans multiple files (multi-scene projects, assets, prefabs) **requires a
+  new persistence contract** — journaling, a transaction log, or equivalent
+  recovery semantics. It may not be bolted on as "several renames".
+  **That contract is new §13/§14 for M2 content, and it adds no authoritative
+  file:** immutable blobs are written before one atomic envelope replacement
+  (a bounded, idempotent, crash-tested sequence with an explicit completion
+  rule), and the migration copy is a new project written with a marker and an
+  authoritative-last ordering. Multi-scene projects and any other
+  multi-authoring-file transaction remain excluded.
```

**(b) Reword the backups bullet:**

```diff
-- No backups feature (recovery snapshots are evidence, §7.4).
+- No backups feature (recovery snapshots are evidence, §7.4). M2 defines only
+  the **artifact backup classification** of new §15 — which files constitute a
+  complete source backup and how a restore is verified. No backup service,
+  scheduler or destination exists.
```

**(c) Insert two bullets:**

```diff
+- **No garbage collection, no blob or version deletion in M2** (new §13.7):
+  retained versions and their bytes are what keep undo, history, retained
+  snapshots, retained retry records and running play/export valid.
+- **No in-place migration, no automatic upgrade on open, no downgrade** (new
+  §14): converting a project always creates a new project and retains the
+  original byte-for-byte.
```

---

## C. New sections

### W15 — new §13 "Content storage, publication and retention"

Insert **after §12** (end of document). Subsections and their normative text:

| New subsection | Text source |
|---|---|
| §13.0 intro + ownership table | `../content-storage.md` §1 |
| §13.1 On-disk layout, artifact classes and path rules | `../content-storage.md` §2 |
| §13.2 Immutable blob publication | `../content-storage.md` §4 |
| §13.3 Publication pipeline, lock scope, durability addendum, crash-point table | `../content-storage.md` §6 (as §13.3.1–§13.3.4; §6.4 becomes §13.3.4) |
| §13.4 Failure and recovery matrix | `../content-storage.md` §7 |
| §13.5 Reads, integrity, tamper handling | `../content-storage.md` §8.1/§8.2 |
| §13.6 Derived caches | `../content-storage.md` §8.3 |
| §13.7 Ownership, disposal and retention | `../content-storage.md` §10 |
| §13.8 Compatibility and change rules | `../content-storage.md` §15 |
| §13.9 Bounds | `../content-storage.md` §9 |
| §13.10 What is deliberately not in M2 (content) | `../content-storage.md` §16 |

The staging area (§5 of the draft) is promoted as **§7.6** (W9), not inside §13,
because it is a scoping rule for the accepted external-modification protocol.
The workspace operations and error codes of the draft's §13.1/§13.2 are promoted
into the accepted §11 tables (W13), not duplicated in §13.

### W16 — new §14 "Migration: M1 project → M2 project copy"

Insert **after §13**. Normative text: `../content-storage.md` §12 verbatim
(preconditions, the identity/revision-policy table, the ordered write sequence and
marker, crash completion and resume, the marker-conflict/destination-exists
refusals, and the no-silent-upgrade/no-downgrade rules). Cross-referenced from
`project-model.md` §12.4 (A9) and from the §10 scan row (W11).

### W17 — new §15 "Artifact backup classification"

Insert **after §14**. Normative text: `../content-storage.md` §11 verbatim
(the class table, the "complete backup = manifest + envelope + **all** blobs"
rule, the exclusions, and the restore + verification procedure).

---

## D. Explicitly not changed (no silent reinterpretation)

- §5.1 write steps 1–5, §5.2 pre-write check, §5.3 ack timing, §5.5 G1/G2: the
  blob publication **reuses** them; no step is weakened, and the envelope remains
  the only authoritative file.
- §6 ownership, claims, stale-owner recovery, release: unchanged. Blob
  publication deliberately does **not** claim ownership (an unreferenced
  content-addressed file is inert), and every authoritative content change still
  happens under the owner's claim in the command pipeline.
- §7's external-change protocol, evidence precondition and recovery artifacts:
  unchanged; W10 only fixes its scope.
- §§8.1/8.2/8.3 (except the W11 exemption) and §9's release/reopen procedure:
  unchanged. Staging does not replace or bypass them.
- §10 startup scan: unchanged except the one added row (W11).
- `docs/contracts/dependencies.md` §3: **not** diffed by packet 15. The new
  workspace/content public-surface rows (content-storage.md §14, assets.md §12)
  must be recorded there by packet 19's consolidated inventory before packet 20
  implements them. Recorded as a handoff note, not applied here.
- `docs/contracts/commands.md`: **not** diffed by packet 15. The authoritative
  content mutation's op name, args (stage-free), inverse/history entries,
  projection, retry serialization and MCP coverage are packets 21/23's diffs;
  this proposal only fixes the invariants they must satisfy (content-storage.md
  §6, §13.1, §14).
