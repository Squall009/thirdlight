# Gate L repair + docs-only promotion (GR-L-1, GR-L-2, accepted CC rows)

**Coordinator step, 2026-09-19. Product code, fixtures, docs. No commit, no
install, no lockfile/package change.** Follows the Gate L review verdict
(`handoffs/gate-l.md`: BLOCKED on GR-L-1) and its accepted contract-change
table. A fresh read-only re-review of this step and of the reopened sections is
the next action (`handoffs/gate-l-rereview.md`).

## GR-L-1 — resolved (product defect, no contract change)

The Gate L finding was re-derived: a v2 source carrying a prepared behavior
record migrated with `migration_source_invalid`
(`number_out_of_range /behaviors/0/source/publishedRevision found 0`) because
`packages/project-model/src/content.ts` enforced `>= 1` on a stored source
record's `publishedRevision` while `workspace.md` §16.5.2 resets it to `0` for
the copy. **The promoted contract text already states the correct reading**
(`project-model.md` §12 step 5 and §22.2 rule 4: "`publishedRevision ≥ 1` for a
record written by this preparation path — `≥ 0` for a record written by the
`workspace.md` §16.5.2 copy, which resets it to `0`"). So the defect was
implementation-only and **no contract edit was needed**.

- `packages/project-model/src/content.ts`: the stored `source.publishedRevision`
  lower bound is now `0` (message/`expected` updated, with a comment naming the
  two provenances; the preparation/publication command still writes `≥ 1`).
- `packages/workspace/tests/m3-migration.test.ts`: new non-vacuous test — a v2
  source seeded from the committed `migration/v2-source` fixture **plus** the
  committed prepared behavior record (`compiled-example.json` `record`,
  `source.publishedRevision 4`) and its real container blob
  (`source-preimages/drift-example.json`, digest `e75ed7cf…`) now migrates: the
  destination loads, `behaviors[0].publishedRevision === 0`,
  `behaviors[0].source.publishedRevision === 0`, and the behavior container blob
  is copied.

## GR-L-2 / CC-48-3 — resolved (accepted C35-5 clause implemented)

Accepted `sessions.md` §19.x required the **scene document's** `schemaVersion` in
`queryProject` and the full-state scene projection; the code reported the
manifest's (always `1`).

- `packages/workspace/src/session.ts` `queryProject`: the scene summary gains
  `schemaVersion: scene.schemaVersion`; `types.ts` `QueryProjectResult.scene`
  gains the field.
- `packages/backend/src/backend.ts`: the full-state scene projection reads
  `q.scene.schemaVersion`; the play snapshot's `scene.schemaVersion` reads the
  same value (so a v3 play snapshot carries `3` instead of a derived `2`).
- Tests: `packages/workspace/tests/m3-queries.test.ts` (v3 scene 3, manifest 1),
  `packages/backend/src/establish.test.ts` (default scene 1),
  `tests/integration/m3-content/content-v3.test.ts` (full-state scene 3 over the
  real transport).
- **M1 frozen fixture regeneration (consequence, recorded):** the
  `fixtures/commands` generator now emits the field; regenerating changed
  exactly five tracked M1 fixtures by one line each
  (`examples/commands.json`, `scenarios/{06,07,08,09}/messages.json`).
  `generate-fixtures.mjs --check` is green (73 files byte-identical). This is a
  shape change mandated by the accepted clause, not a relaxed expectation.

## Docs-only promotion of the accepted CC rows (Gate L table)

| CC | Applied |
|---|---|
| CC-44-1 | `workspace.md` §16.9 rewritten as normative: both the `project-model` bullet (v3 validators/`compose`/`canonicalContentV3`/`validateGameConfig`/envelope types) and the `workspace` bullet (`MigrationResultV3`, `MigrationMarkerV3`, `AnyMigrationMarker`, `migrateProjectCopyV3`; `buildEnvelopeBytesV3` stays internal) |
| CC-44-6 | `project-model.md` §19.2 step 1 **and** `workspace.md` §16.6 item 4: explicit `modelAnimation` version wins; first binding wins on conflict |
| CC-45-1 | fixture `commands/failures.json` F1 now records `references: ["/entities/7/components/gameZone/safeSpawnId"]` (the §5.4 row already declares `references`) |
| CC-45-2 | fixtures F8/F9/F12 now record the commands.md §3 request-pointer paths (`/args/value/…`); §3 already stated the convention |
| CC-45-3 | fixture F10 now records `{ "code": "ok" }`; the packet-45 replay's special case and `AUXILIARY` overrides removed (only F5's `reason` remains) |
| CC-45-4 | `commands.md` §3.1.1: `kind` required on a v3 state, `model` default on a v1/v2 state |
| CC-45-5 | **discharged, no change**: the frozen M2 `prefab-failures.json` F18 stays byte-exact (it pins the v2-state registry list; regenerating a frozen M2 artifact has no contract benefit and no engine path contradicts it) |
| CC-45-6 | `commands.md` §5.6: the four-key content summary is the v1/v2 shape; a v3 state adds `game`/`zones`/`spawns`/`audioAssets` |
| CC-45-8 | `commands.md` §5.4: `game_config_invalid` is produced only by the envelope load; `setGameConfig` reports `field_*` at the request pointer |
| CC-47-4 | `presentation.md` §41.7.3: the pipeline also carries the six §41.7.2 A codes; stages 1–2 stay model-owned |
| CC-47-5 | `presentation.md` §41.4.5/§41.7.1: `6` marked as a **structural maximum** (5 fixed cue keys + ≤1 checkpoint), not a reachable rejection bound |
| CC-48-2 | `sessions.md` §6.3 names the `migrate-copy-v3` admin route and its request/result/error set (the v1→v2 route does not exist on HTTP — stated) |
| CC-48-3 | `sessions.md` §19.x extended to `3`/`2`/`1`; `commands.md` §5.6 example + prose gain `schemaVersion` |
| CC-46-1, CC-48-1 | closed earlier (`repair-cc46-1.md`, `repair-cc48-1.md`) |

`fixtures/m3/contracts/index.json` was updated for the changed `failures.json`
digest/bytes; the packet-39 checker is green (39 groups).

## New finding — CC-L-1 (recorded, owner + checkpoint, NOT silently changed)

CC-45-7 asked §8.5.1 to state whether a reimport moves
`components.modelAnimation.version`. The implementation (packet 45, re-derived
by probe) replaces `roles` and **leaves `version` at the old version**, while
`presentation.md` §41.3.4 rules 4–6 validate the new mapping against the **new**
version's clip list and require reordered-clip reimports to work. A binding
`(assetId, version 1, roles matching version 2's order)` is not self-consistent:
load-time role checking (§41.3.6 rule 7, packet 53) would reject it. Proposed
section-level diff (for Gate L adjudication, then a bounded repair **before
packet 53 / Gate N**):

```diff
 commands.md §8.5.1 — replace "replaces the entity's `roles` value" with:
+  replaces the entity's whole `modelAnimation` value with
+  `{ assetId, version: <the newly appended version>, roles: args.roles }`
+  in the same transaction (the binding is version-local to the new bytes);
+  the recorded `animation.previous`/`animation.next` are the full component
+  values and the inverse restores the previous value.
 project-model.md §22.2 rule 4 — clarify: "a reimport appends a version and does
+  not move an existing binding *by itself*; the animated reimport command
+  explicitly re-points the referencing entity's binding to the new version in
+  the same atomic edit" (presentation.md §41.3.4).
```

Not applied: it changes the command's change data and needs its own accepted
diff; packet 53 depends on the resolution.

## Verification (this step)

`npm test` **147 files / 1867 tests exit 0**; `typecheck`/`check-deps`/`build`
exit 0; `check-boundaries` 15 packages, **297 files / 1167 specifiers, 0
violations**; `fixtures/commands` generator `--check` **73/73**; M2 contracts
**34/34**; all M3 checkers + controls exit 0 (contracts 39 groups incl. the
CC-46-1 control, gameplay 23/127, media 13/115 + 9/9, delivery 16/153, storage
9/10 + 6/6, audit/promotion); M2 input/course/runtime/behaviors/physics green.

## Next

**Fresh read-only Gate L re-review** (`docs/handoffs/gate-l-rereview.md`),
covering GR-L-1/GR-L-2, the promotion above, the reopened
§16.5.1/§16.5.2/§12/§13.2/§18.9.2/§22.2/§23.11 sections, and CC-L-1. Then packet
49 (not before the re-review accepts).
