**PROPOSED — not accepted.** Packet 39 (`docs/planning/m3-packets.md` §39)
output. Section-level diffs for `docs/contracts/workspace.md`. Normative text
lives in [`../storage.md`](../storage.md) §§S1–S11 and
[`../model.md`](../model.md) §23; this file names destinations, OLD/NEW text and
insertion anchors. `OLD` is accepted text exactly as it reads today. Accepted
section numbers are never renumbered; new material is appended as **§16**.

---

## A. Summary

| # | Destination | Kind | Normative text |
|---|---|---|---|
| W1 | §3 "Layout and artifacts" | insert bullet | this file |
| W2 | §4.2 "Fields" | insert v3 paragraph | storage.md §S3 |
| W3 | §4.5 "Envelope version compatibility (v2)" | insert rows + sentence | storage.md §S2 |
| W4 | §11 operations table | insert row | storage.md §S8 |
| W5 | §11 error codes | insert row + extend reason list | storage.md §S8 |
| W6 | §13.9 "Bounds" | insert row | storage.md §S7 |
| W7 | §14 "Migration: M1 project → M2 project copy" | insert bullet | this file |
| W8 | §15 "Artifact backup classification" | insert sentence | this file |
| W9 | **new §16** | insert section | storage.md §§S1–S11 |

Not changed: §§1, 2, 4.1, 4.3 (dispatch gains a branch, §W2), 4.4, 5–10, 12,
13.0–13.8, 13.10. The v1→v2 migration of §14 is unchanged; §16 is a second,
separate operator.

---

## B. Existing sections

### W1 — §3 "Layout and artifacts": insert one bullet

Anchor: after the M2 bullet that this diff's M2 counterpart added (the bullet
naming `.thirdlight/derived/` / `.thirdlight/staging/`).

```diff
+- In the M3 workspace the active envelope is `storageVersion` 3
+  (project-model §23, storage.md §S3). The game-configuration block is a
+  `content.game` key inside that envelope: **no new file, directory or artifact
+  class is introduced**, `sources/sha256/<digest>` remains the only
+  authoritative content path for model and audio bytes alike, and no artifact is
+  written outside the accepted layout.
```

### W2 — §4.2 "Fields": insert a v3 paragraph

Anchor: immediately after the paragraph beginning `In a `storageVersion` 2
envelope the envelope's own key set is exactly …`.

```diff
+A `storageVersion` 3 envelope keeps the **same** top-level key set
+(`{storageVersion, type, projectId, scene, content, retry}`) and adds exactly
+one required key inside `content`: `game`, which is `null` or the bounded
+`GameConfig` block (project-model §23.4). Its embedded scene must be
+`schemaVersion` 3 and its content key set is exactly
+`{assets, prefabs, behaviors, settings, behaviorTrust, game}`; a missing or
+unknown key is `envelope_invalid`. `scene.revision` is still the only revision,
+`retry` is unchanged, canonical serialization is §4.4 extended with the v3
+content key order and the §23.7 component/field orders, and the §4.5 v3 row is
+checked before any scene or content field validation. Normative text and the
+example envelope: [`../storage.md`](../storage.md) §S3.
```

### W3 — §4.5: rows and sentence

The section title is kept (accepted headings are not renumbered); the table
gains rows and the trailing paragraph gains one sentence.

```diff
 | 1 | 2 | 2 | **valid** — the only M2 combination (`content` present) |
+| 1 | 3 | 3 | **valid** — the v3 combination (`content.game` present; storage.md §S3) |
 | 1 | 1 | 2 | `version_combination_unsupported` (single error, stops before scene/content field validation) |
 | 1 | 2 | 1 | `scene_invalid` → `schema_version_unsupported` (the M1 validator knows scene `[1]`; accepted behavior unchanged) |
+| 1 | 1 | 3 | `version_combination_unsupported` (single error) |
+| 1 | 2 | 3 | `version_combination_unsupported` (single error) |
+| 1 | 3 | 1 | `version_combination_unsupported` (single error) |
+| 1 | 3 | 2 | `version_combination_unsupported` (single error) |
 | 2 | any | any | `manifest_invalid` → `schema_version_unsupported` for the manifest — **the manifest stays schemaVersion 1 in M2** |
-| any | any | ≥3 or ≤0 | `storage_version_unsupported` |
-| any | ≥3 | any | `schema_version_unsupported` for that document |
+| any | any | ≥4 or ≤0 | `storage_version_unsupported` |
+| any | ≥4 | any | `schema_version_unsupported` for that document |
```

```diff
-The storage-version dispatch is fixed: exactly two passable combinations, and a
-`schemaVersion`/`storageVersion` change is a reviewable contract change, never a
-same-version extension.
+The storage-version dispatch is fixed: exactly **three** passable combinations
+(v1/v2/v3), and a `schemaVersion`/`storageVersion` change is a reviewable
+contract change, never a same-version extension. The manifest stays
+`schemaVersion` 1 in M3; the runtime-content export `manifest.json`'s
+`manifestVersion` move (1→2) is a **different document** owned by packet 42 and
+is not a change to this table. Every v3 refusal is non-destructive: one error,
+bytes retained byte-identically, no repair, no rewrite (storage.md §S2).
```

### W4 — §11 operations table

Anchor: after the `migrateProjectCopy(sourceProjectId, newProjectId)` row.

```diff
+| `migrateProjectCopyV3(sourceProjectId, newProjectId)` | operator (§16) | `{ ok, sourceProjectId, newProjectId, sourceRevision, newRevision: 0, revisionPolicy: "reset-to-zero", historyReset: true, retryCleared: true, blobsCopied, blobsAlreadyPresent, resumed, sourceVersion: 2, newVersion: 3 }` | `migration_version_unsupported`, `migration_source_invalid`, `migration_destination_exists`, `migration_marker_conflict`, `path_rejected`, `content_publish_failed` |
```

### W5 — §11 error codes and permitted reasons

Anchor: after the `migration_resume_required` row.

```diff
+| `migration_version_unsupported` | the source is not a loadable `storageVersion` 2 / scene `schemaVersion` 2 project (v1 must use the accepted v1→v2 copy first), or the requested destination is not the v3 combination (single error; carries `sourceProjectId`, `foundVersion`, `expectedVersion`) |
```

And the `**Permitted `project_unavailable.reason` values (normative):**` sentence
gains the v3 model codes:

```diff
 `version_combination_unsupported` and `asset_reference_missing`
 (project-model.md §12.3/§12.6/§13 codes) —
+plus the v3 codes `game_reference_missing`, `game_reference_in_use`,
+`zone_transform_unsupported`, `spawn_transform_unsupported`,
+`zone_checkpoint_count_invalid`,
+`zone_goal_missing`, `asset_kind_mismatch`, `game_config_invalid`
+(project-model.md §23.9) —
 since a project that exists on disk but cannot load is exactly what
 `project_unavailable` reports.
```

### W6 — §13.9 "Bounds": insert row

Anchor: after the `content block, canonical` row.

```diff
+| byte | `content.game`, canonical | 16 384 B | `content_invalid` (`limits_exceeded` → `game_bytes`), no envelope write; counted inside `content_bytes` |
```

### W7 — §14: insert bullet

Anchor: after the §14.4 bullet ending `…(acceptance row A01).`

```diff
+- **v3 migration is a second, separate operator (§16).** `migrateProjectCopy`
+  (v1→v2) is unchanged and never writes v3. A v1 project reaches v3 only by the
+  chained copy `migrateProjectCopy` → `migrateProjectCopyV3`; there is no direct
+  v1→v3 operator and no in-place upgrade. `migrateProjectCopyV3` refuses a v1
+  source with `migration_version_unsupported`.
```

### W8 — §15: insert sentence

Anchor: after the restore-procedure paragraph ending `…no backup service exists
in M2.`

```diff
+**v3 adds no backup class.** The game-configuration block is inside the envelope
+and audio bytes are ordinary `sources/sha256/<digest>` blobs, so the same
+included/excluded sets apply verbatim: manifest + envelope + every source blob
+(model and audio) are included; staging, derived caches, ownership, recovery and
+the migration marker are excluded.
```

### W9 — New §16

Insert as the last section (after §15): normative text is
[`../storage.md`](../storage.md) §§S1–S11, heading renumbered from `## 16.` to
match, with its cross-references rewritten `model.md §23` → `project-model.md
§23`, `authoring.md §A…` → `commands.md`, and `§S…` → `§16`. The section is the
v3 envelope, its load-validation branch, the v2→v3 copy migration, the durable/
blob consequences, the storage bounds and the workspace operations/error codes.

---

## C. Superseded text (explicit)

- §4.5's closing sentence “exactly two passable combinations” is **replaced**
  (W3) — not redefined silently. The v1/v2 rows keep their accepted meaning.
- §4.5's rows `| any | any | ≥3 or ≤0 |` and `| any | ≥3 | any |` are replaced
  with `≥4` / `≥4` (W3): the numbers change because 3 is now a known version.
  This is the only accepted threshold that moves.
- §13.9's content-block bound is **not** changed; `game_bytes` is a new,
  nested bound.
- The packet-38 CSP finding (`sessions.md` §17.4) is **not** part of this diff;
  packet 42 owns it.
