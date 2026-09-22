# Owned diff rows — `docs/acceptance/deployment.md` §5 (packet 67)

Proposal: `../reliability.md` §1–§3, §10 (C67-5). Gate Q. **PROPOSED — not
accepted.** This is a **replacement proposal for an acceptance document**
(`docs/acceptance/deployment.md` is the M1/M2 deployment record, not an
accepted engineering contract — the promotion handoff applies it only on the
owner's Gate Q acceptance, alongside the contract diffs).

## C67-5 — `deployment.md` §5 (Backup / restore) — REPLACEMENT

### OLD (the accepted text as written today)

```
## 5. Backup / restore

The durable state is plain files: `<dataRoot>` (workspace) + `<exportRoot>`
(exported trees).

- **Backup:** stop the backend (SIGTERM) or take the copy while it runs
  (atomic per-file writes ⇒ a copy sees whole documents; for a consistent
  multi-project snapshot, stop first), then `tar czf tl-backup.tgz
  <dataRoot> <exportRoot>`.
- **Restore:** stop the backend, replace the directories, start the backend.
  Projects whose owner died during the outage need the explicit **takeover**
  (above); `released` projects are claimed automatically on first open.
  The `.thirdlight/recovery/` snapshots (byte-exact external-change evidence)
  are preserved by the copy and remain resolvable after restore.
```

### Problems of record (why the replacement)

1. The raw `tar` of `<dataRoot>` copies the **entire** tree — including the
   classes the accepted `workspace.md` §15 **excludes** from a complete
   backup (`.thirdlight/ownership.json`, `claim-*`, `staging/`, `derived/`,
   `migration.json`, temp files). Restoring that tar restores a
   live-looking **ownership record**, which §15 says must never be restored
   ("restoring a live-looking ownership record would create false
   ownership").
2. The tar carries **no verification**: a truncated/corrupt backup is
   discovered at open time, per project, with no manifest to check against.
3. "Replace the directories" has no destination guard (a nonempty
   destination is silently overwritten) and no same-ID vs new-ID
   distinction.

### NEW (the replacement text)

```
## 5. Backup / restore (M4: the reliability.md §1–§2 procedure)

The durable state is plain files: `<dataRoot>` (workspace) + `<exportRoot>`
(exported trees). The M4 backup is an **inventory-based, verified** copy of
the accepted consistent set (workspace.md §15: the manifest, the envelope
and every `sources/sha256/<digest>` file — all versions, including
superseded; staging/derived/ownership/recovery/migration/temp files are
excluded and must never be restored):

- **Backup** (`backup` — the packet-75 tooling, reliability.md §1): the
  backend stopped (or the project released) — a project with a LIVE owner
  is refused (`backup_live_project`, bytes untouched). The tool copies the
  consistent set into `<backupDir>/projects/<projectId>/…` with per-file
  digests and writes `backup-manifest.json` LAST (a directory without a
  valid manifest is `backup_incomplete` — never a backup). `retention` is
  **manual**: no tool prunes sources or backups.
- **Verify** (`verify` — before any restore): re-hash the inventory
  (truncation / bad hash / missing-or-superseded blob / ownership-included /
  path-escape checks — reliability.md §1.4). A bad backup never reaches the
  filesystem.
- **Restore (same ID)** (`restore`): the verified set into a **clean,
  empty, same-`projectId`** destination (a nonempty destination is refused —
  `restore_destination_nonempty`; the existing destination is never
  modified). No ownership is restored; `released` projects are claimed
  automatically on first open; projects whose owner died during the outage
  still need the explicit **takeover** (unchanged — the old text's note
  stands). The accepted post-restore verification (workspace.md §15)
  applies.
- **Create (new ID)** (`create`): the same verified set with a new identity
  (manifest `id`, envelope `projectId` and directory name rewritten to the
  new id — a documented operator copy, distinct from restore).
- **Diagnostics:** `GET /api/v1/admin/health` (admin scope) returns the
  bounded, redacted point-in-time report (reliability.md §3: ≤ 32 KiB, no
  credentials, no absolute paths, `backendId`-tagged — re-fetch after any
  restart).
- The `.thirdlight/recovery/` snapshots remain optional operator-retained
  evidence (unchanged: never part of the consistent set, never restored over
  the envelope).
```

**Scope:** the replacement changes the §5 text only. §4 (startup/shutdown —
the SIGTERM stop, the takeover) and every other deployment section are
untouched.