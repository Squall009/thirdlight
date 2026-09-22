# Owned diff rows — `workspace.md` (packet 65, packet 66, packet 67)

Proposal: `../templates.md` §2, §5, §6, §11. Gate Q. **PROPOSED — not
accepted.** Every row below is the exact old/new text for the promotion
handoff. Single owner: the rows below are the only packet-65 changes to
`workspace.md`; packet 64 owns no `workspace.md` rows.

## C65-3 — the `createProjectFromTemplate` operator (new §8.4)

### Row 1: `workspace.md` §8 (after the accepted §8.3 creation sequence —
new §8.4)

OLD (nothing — the section does not exist; §8.3's crash-completion
paragraph is the end of §8):

NEW:

> **§8.4 `createProjectFromTemplate(projectId, name, templateId)`
> (template creation — M4, C65-3)**
>
> A template is an installed, verified directory (templates.md §1/§2:
> `descriptor.json` + `base/scene.json` + `recipe/commands.json` +
> `sources/**` + `NOTICE`, three independent digest checks, no archives,
> no symlinks, exact engine-version match). Preconditions: `projectId`
> matches project-model §5.1; `name` 1–128 chars, no control chars
> (`field_*`); the template installed + verified (else
> `template_not_found` / `template_content_mismatch` /
> `template_engine_version_mismatch` / `template_path_rejected`).
>
> **Outcome (exact — the idempotency/collision rules):**
>
> - Destination absent ⇒ create via the phase sequence below. Result:
>   `{ ok: true, created: true, projectId, revision: <N>, template:
>   { templateId, version, contentDigest } }` (`N` = the recipe command
>   count).
> - Destination present and loadable, and its manifest `template` block
>   equals the requested `(templateId, contentDigest)` **and** its
>   manifest `name` equals the requested `name` ⇒ **idempotent no-op**:
>   `{ ok: true, created: false, projectId, revision: <current>, template:
>   <recorded> }` (a retry after a publication crash converges; a retried
>   creation can never create two destinations).
> - Destination present, otherwise (different template/digest/name, a
>   non-template project, a partial destination of a different identity,
>   or an unloadable directory) ⇒ `template_destination_exists` (carries
>   `existing: "project" | "partial" | "unloadable"`); nothing written;
>   the existing project is never overwritten, renamed or upgraded.
>
> **Concurrent claim:** the `reserved` phase claims the destination with
> the atomic `mkdir` of `projects/<projectId>` (first creator wins; a
> concurrent same-identity creator observes the marker and converges to
> the no-op after publication, or reports
> `template_initialization_incomplete` with `phase` while creation is in
> flight; a different-identity concurrent creator gets
> `template_destination_exists` (`existing: "partial"`); a foreign marker
> observed at reservation ⇒ `template_reservation_conflict`). The
> reservation marker carries the request identity, so "same identity" is
> decidable without a live channel.
>
> **The phase sequence (normative):** `reserved` (atomic mkdir +
> `.thirdlight` dirs + `W(reservation.json)`) → `blobs` (each descriptor
> blob, inventory order: copy from the installed template — fresh `W`
> writes, no hardlink/symlink — to
> `.thirdlight/sources/sha256/<digest>`, post-write digest check; marker
> phase advance) → `envelope` (`W(project.json)` — manifest **schemaVersion
> 2** with the `template` block, project-model §7 C65-1; `W(scenes/
> main.json)` — the template base scene at `revision 0` + the empty v3
> content block, game `null`; marker phase advance) → `replayed` (open
> under the creation context; apply recipe commands `K+1…N` through the
> accepted command pipeline — each command: validation, revision +1,
> history entry, retry record, envelope `W`; deterministic requestIds
> `req-` + first 32 hex of `sha256("<templateId>@<templateVersion>#" + i)`,
> origin `{ kind: "template", clientId: "<templateId>@<version>" }`;
> marker phase advance with `recipeApplied N`) → `published` (claim
> ownership §6.3; `rm reservation.json`; log).
>
> **Crash completion (per phase boundary):** reserved-only ⇒ scan reports
> (resume on same identity, operator delete otherwise); blobs done, no
> manifest ⇒ resume (re-hash existing blobs, `alreadyPresent` per blob);
> manifest + revision-0 envelope, marker < `replayed` ⇒ write/verify the
> envelope (a pure function of the reservation identity) and continue;
> envelope at revision `K < N`, marker phase `replayed` ⇒ resume the
> replay at `K+1` (the recipe requestIds make every applied command
> dedup-safe — no command applies twice); `K = N` but unclaimed ⇒
> **deterministic completion** (verify the creation-context claim, unlink
> the marker). The marker and envelope disagreeing in an unrecoverable way
> (e.g. `recipeApplied` ≠ envelope revision, a corrupt `published` phase
> at `K < N`) ⇒ `template_marker_conflict` (no auto-completion). An
> in-flight creation whose marker `contentDigest` no longer matches any
> installed template (a replacement across the crash) ⇒ reported
> `template_source_unavailable` (never re-pointed, never auto-completed —
> operator restores the original template or deletes the destination).
>
> **Partial destinations are not projects:** a destination with a
> reservation marker (any phase < `published`) is refused by open/query/
> Play/list as `template_initialization_incomplete` (carries `phase`,
> `recipeApplied`, the resume/delete hint). Only the complete validated
> envelope + the published claim + the removed marker constitute a ready
> project. Disk-full in any phase: the accepted `write_failed` /
> `content_publish_failed` / `content_quota_exceeded` semantics, marker
> retained at the last completed phase (resumable or operator-deletable,
> never half-claimed, never ready).
>
> **Removal/replacement of the installed template:** created projects are
> unaffected (they hold their own bytes + the manifest `template` block —
> no live template reference); new creations record the replacement's
> identity; in-flight creations follow the `template_source_unavailable`
> rule above.

## C65-4 — scan, operations table, error codes, backup

### Row 2: `workspace.md` §10 (startup scan) — one paragraph added

OLD (the §10 scan paragraph list ends with the migration-destination
reporting rule — the accepted §8.3/§16.5.3 marker reporting):

NEW (one added paragraph):

```text
- **Template-creation destinations (C65-3):** a `projects/<id>` directory
  carrying `.thirdlight/reservation.json` (any `phase`) is **not a
  project**: it is reported with the marker's `phase` / `recipeApplied` /
  identity and is refused for open/edit/Play as
  `template_initialization_incomplete`. A marker at `phase "published"`
  with the envelope at the full recipe revision and a creation-context
  claim completes deterministically (claim verified, marker unlinked,
  logged). A marker whose `templateContentDigest` matches no installed
  template is reported `template_source_unavailable`. As with the accepted
  migration marker, the reservation marker is non-authoritative, is never
  restored over an envelope, and is excluded from every backup (§15).
```

### Row 3: `workspace.md` §11 (operator table) — one row added

OLD (the operator table ends with the `migrateProjectCopyV3` row — the
accepted last row):

NEW (one row appended):

```text
| `createProjectFromTemplate(projectId, name, templateId)` | operator (§8.4) | `{ ok, created, projectId, revision?, template: { templateId, version, contentDigest } }` | `field_*` (args), `template_not_found`, `template_content_mismatch`, `template_engine_version_mismatch`, `template_path_rejected`, `template_destination_exists`, `template_reservation_conflict`, `template_marker_conflict`, `template_initialization_incomplete`, `content_quota_exceeded`, `content_publish_failed` |
```

### Row 4: `workspace.md` §11 (error-code table) — the new-code rows

OLD (the code table ends with the `migration_version_unsupported` row):

NEW (the following rows appended — the exact code set of templates.md §11
that workspace raises; the `module_*` codes are raised by the resolver
(runtime/sessions surface) and are listed there, not here):

```text
| `template_not_found` | the `templateId` is not an installed, verified template |
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
```

The permitted `project_unavailable.reason` list gains
`template_initialization_incomplete` (a destination that exists but cannot
be opened because it is mid-creation).

## C65-5 — content store (adjudication row)

**No new artifact class.** The template's source blobs are published into
the destination's accepted content-store layout
(`.thirdlight/sources/sha256/<digest>`, workspace.md §13.1) as ordinary
immutable blobs during the `blobs` phase; the accepted §13.2/§13.3
publication invariants (content-addressed, digest-verified, no second
store) apply unchanged. The `queryAssets`/`readBlob`/`contentIntegrity`
surfaces see the starter assets exactly as authored assets. **No other
`workspace.md` change** beyond the rows above: the §5 durability protocol,
the §6 ownership primitives, the §14/§16 migration rules and the §15
backup classification (the v2 manifest is the manifest class; the
reservation marker is excluded with the accepted migration-marker rule)
are untouched.

## C66-3 — the game's project lives under the game's data root; the kit's
backend is an unmodified workspace service (no change)

Proposal: `../distribution.md` §2, §6, §10. Gate Q. **NO `workspace.md`
CHANGE** — adjudication, recorded for the promotion handoff:

- The game's project is a **plain workspace instance** under the game's
  data root (`game/data/`), owned by the kit's backend process (the
  accepted deployment bundle). The workspace service, its operator table,
  its ownership/claim/marker machinery and its error codes are unmodified
  by the kit; the game build tool spawns the backend with the accepted env
  contract (deployment.md) and speaks the accepted routes.
- **The template operator (C65-3) runs against the kit's `templates/` set:**
  the kit installs the template into the game data root's `templates/`
  directory (distribution.md §6 step 5) before the backend serves it; the
  packet-65 operator semantics (phases, marker, codes) are unchanged — the
  only new code on this surface is `template_install_mismatch` (a
  game-build-tool verification failure, distribution.md §9), raised by the
  tool, not the operator.
- **No new artifact class (the C65-5 adjudication extends to the kit):**
  `game.json` is game-owned data OUTSIDE the workspace (the game's
  identity, not a project file); `game/build/` outputs are the accepted
  export closure (export.md §3/§4); the kit itself is engine distribution
  data, not workspace content. The backup/scan machinery of `workspace.md`
  §16–§17 covers the game's project exactly as it covers any local
  project.

**No other `workspace.md` change (packet 66).**

## C67-1 — the backup/restore/create tools are the accepted §15
classification executed offline (no change)

Proposal: `../reliability.md` §1–§2, §10. Gate Q. **NO `workspace.md`
CHANGE** — adjudication, recorded for the promotion handoff:

- The 67-A backup/verify/restore/create procedures (reliability.md §1–§2)
  operate on the EXACT §15 included/excluded set (manifest + envelope +
  every `sources/sha256/<digest>` file, incl. superseded; staging/derived/
  ownership/recovery/migration/temp excluded) and its normative restore
  procedure (clean same-`projectId` destination, the 4 verification
  steps). They add **no workspace operation, route, artifact class, marker
  or error code** to the workspace contract: the backup manifest lives with
  the backup (outside the data root); the tool-surface codes
  (`backup_*`/`restore_*`/`source_blob_corrupt` — reliability.md §9) are
  raised by the offline tools, not the workspace service.
- **State ownership stands:** the tools run only after the project is
  released or the backend stopped (the live-project refusal, reliability.md
  §1.2, re-uses the accepted §6.2 liveness test — a live owned record with a
  live holder pid refuses `backup_live_project`; a dead/stale/released
  record proceeds). No new ownership primitive, no claim interaction.
- **Retention is manual (declared — reliability.md §0/§1.3):** no
  silent source/backup pruning exists or is added; the workspace's
  §13.7 retention rules (blob retention, retry retention) are untouched.
- Same-ID restore and new-ID creation are distinct tool operations
  (reliability.md §2.1/§2.2); the new-ID transform (manifest `id`, envelope
  `projectId`, directory name) is a documented operator copy — it is NOT a
  migration (no marker, no `revisionPolicy` reset, no source side effect)
  and enters no workspace operator table.

**No other `workspace.md` change (packet 67).**