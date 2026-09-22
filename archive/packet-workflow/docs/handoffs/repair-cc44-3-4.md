# Bounded repair — CC-44-3 and CC-44-4

**2026-09-19.** Both repairs applied; every check green except `npm test` (1
failing: a packet-44 test pins the behaviour repaired here). Docs+fixtures only:
no `packages/**`, no install, no lockfile change, no commit.

## Repairs

### CC-44-3 — the v2-source fixture is not a loadable v2 scene → option (a)

Chose **(a)**: corrected the fixture; the v3-superset case is not required (a
valid v2 source cannot carry a v3-only component).

- Removed `cameraFollow` from `cam-main` in `migration/v2-source/envelope.json`
  and (verbatim carry, §16.5.2) `…/expected-v3-destination/envelope.json`.
  Source 3926 → 3629 B (`5dc63193…7820`), destination 3695 → 3398 B
  (`5cd03e73…8cba`).
- `workspace.md` §16.5.1, appended to the first bullet (verbatim; component
  list elided):
  > “Loadable under the v2 pipeline” includes the **v2 component registry**: a
  > `schemaVersion 2` scene that carries a v3-only component … is
  > `component_unknown` there, so it is refused as `migration_source_invalid`
  > (`project-model.md` §23.11); it is not a v2 project and is never silently
  > upgraded by the copy.
- `project-model.md` §23.11, appended (verbatim; same elision):
  > “Superset” means every **v2-valid** entity is a valid v3 entity without
  > editing; it does **not** license a `schemaVersion: 2` scene that carries a
  > v3-only component … Such a document is not a v2 scene (`component_unknown`
  > under the v2 pipeline), so it is not a legal input to this operator and
  > never a legal migration source (`workspace.md` §16.5.1,
  > `migration_source_invalid`).
- `index.json`: `expect {"sceneSchemaVersion":2,"v3OnlyComponents":0}`.

### CC-44-4 — the contracted migration destination is not loadable

- `workspace.md` §16.5.2, new normative row (verbatim):
  > | derived revision metadata | **reset to 0** on copy: every
  > `content.assets[i].versions[j].publishedRevision`, every
  > `content.behaviors[i].publishedRevision`, every
  > `content.behaviors[i].source.publishedRevision` (when `source` is non-null)
  > and every `content.behaviorTrust.entries[k].acknowledgedRevision` is written
  > as `0` |

  The `content` row now reads “…byte-identically **except** for the derived
  revision metadata reset in the next row; `game` is added as **`null`**”. A new
  paragraph (“**Why the derived revision metadata is also reset.**”) gives the
  reason: those fields name the revision a record landed at, while the
  destination restarts `revision` at 0 with empty history, so a carried value
  names a nonexistent revision and fails the §13.2 rule 5 / §18.9.2 rule 4
  bound. Everything else stays byte-identical; the source keeps its own values.
- `project-model.md`: §18.9.2 rule 4 and §13.2 rule 5 note the `0`; §12 step 5
  and §22.2 rule 4 read “`publishedRevision ≥ 1` for a record written by this
  preparation path — `≥ 0` for a record written by the `workspace.md` §16.5.2
  copy, which resets it to `0`” (else the reset is itself
  `number_out_of_range`).
- Fixture `publishedRevision` 2 → 0; `index.json`:
  `expect {"sceneSchemaVersion":3,"revision":0,"derivedRevisionsReset":true,"loadable":true}`;
  the checker re-derives the reset and `publishedRevision ≤ scene.revision`;
  `verification.md` gains controls C/D.

## Verification

| Command | Exit |
|---|---|
| contracts checker | **0** — 39 groups |
| negative controls A/B/C/D (≠0) | **1**/**1**/**1**/**1** |
| gameplay / media / delivery / audit / promotion checkers | **0** (23/127, 13/85, 16/153, 8 gr, 5 gr/110) |
| typecheck / check-deps / check-boundaries / build | **0**/**0**/**0** (15 pkgs, 292 files, 1131 specifiers)/**0** (4 built) |
| `npm test` | **1** — 138 files / 1768 tests, **1 failed (packet-46 blocker)** |

Controls C/D fail the repaired rule. Versus the
pre-step snapshot, `git diff --stat docs/contracts packages` changes only
`workspace.md` (+22) and `project-model.md` (+16); no product file changed.

**Blocking follow-up → 46.** `packages/project-model/src/v3-model.test.ts:234`,
`expect(projectResult.ok).toBe(false)` (received `true`). Not edited (product
code). Recommended: assert `toBe(true)` and the destination asset
`publishedRevision === 0` (source stays `2`).

## Routed requests

| CC | Section / diff | Owner | Checkpoint |
|---|---|---|---|
| CC-44-1 | `workspace.md` §16.9 + `project-model.md` §3: name the v3 envelope entry points (the four v3 validators/parsers, `EnvelopeV3Load`/`EnvelopeV3Error`, `canonicalContentV3`/`validateGameConfig`, six component validators) | **46** | Gate L |
| CC-44-2 | §18.5/§18.6 vs the packet-41-placeholder audio fixtures: regenerate the two placeholder fixtures, then enforce `pcm-wav` | **47** | Gate L |
| CC-44-5 | §23.9/§23.10 `animation_*`/media codes+limits in `ERROR_CODES`/`LimitName`; needs a **granted** bounded re-open of `packages/project-model/src/errors.ts` | **47** (decision recorded) | Gate L |
| CC-44-6 | §19.1/§19.2/§16.6 item 4 capture-version precedence (explicit `modelAnimation` version wins; first binding wins on a tie) | **46** (§16.6); 47 must not diverge | Gate L |

## Reopened sections

**Reopened:** `workspace.md` §16.5.1/§16.5.2 and `project-model.md` §12 step 5,
§13.2 rule 5, §18.9.2 rule 4, §22.2 rule 4, §23.11. A **fresh architectural
re-review of exactly those sections is owed before Gate L acceptance**; no
reviewer approved this session repair. §19.1/§19.2 are unchanged (CC-44-6
routed).

**Limitations.** The packet-39 planning pack
(`docs/planning/m3-contracts/storage.md` §16.5.2) still shows pre-repair text;
`docs/contracts/**` is authoritative.

## Exact next step

**Packet 46 — durable v3 workspace and migration-copy (L). Do not start it
automatically.** Fix the failing test above first; the reopened sections need
the fresh re-review before Gate L acceptance.
## Coordinator verification and follow-through (2026-09-19)

Verified by the coordinator after the repair sub-session reported (a handoff is
not proof):

- `node fixtures/m3/contracts/tools/check-fixtures.mjs` → exit 0 (39 groups); the
  documented corruption controls exit 1, including the two that reintroduce
  exactly the repaired defects.
- `fixtures/m3/{gameplay,media,delivery}` checkers, `audit/check-audit` and
  `audit/check-promotion` → exit 0. `npm run typecheck`, `npm run check-deps`,
  `npm run check-boundaries` (15 packages, 0 violations) and `npm run build` →
  exit 0.
- Diff scope confirmed: only `docs/contracts/{workspace,project-model}.md` plus
  the migration fixtures, `index.json`, checker and `verification.md`.

**The repair left the test suite red and the coordinator repaired it.** Packet
44's `packages/project-model/src/v3-model.test.ts` pinned the *contradictory*
behaviour explicitly (it asserted the committed destination was **not**
loadable, documenting CC-44-4). With §16.5.2 now resetting the derived revision
metadata, those assertions were wrong. The bounded test repair (coordinator
applied, contract text unchanged) replaces them with the repaired expectation:
`validateProjectV3(dstProject, dstScene, dstEnvelope.content).ok === true` and
the destination asset's `versions[0].publishedRevision === 0`. Full suite after
the repair: **138 files / 1768 tests passed**, exit 0.

**Reopened sections (owe a fresh architectural re-review before Gate L
acceptance):** `workspace.md` §16.5.1/§16.5.2; `project-model.md` §12 step 5,
§13.2 rule 5, §18.9.2 rule 4, §22.2 rule 4, §23.11. This repair is a session
repair and is **not** independently reviewed; the promotion status line for these
sections remains "accepted by the Gate K architectural review … final manual
review pending" until that re-review.

**Still routed (Gate L checkpoint):** CC-44-1 → packet 46 (v3 envelope entry-point
naming), CC-44-2 → 47 (packet-41 audio-recipe fixtures vs the promoted `pcm-wav`
rules), CC-44-5 → 47 (granted bounded re-open of
`packages/project-model/src/errors.ts` for the `animation_*`/media codes and
limits), CC-44-6 → 46 (capture-version precedence in §19.1/§19.2/§16.6 item 4).
CC-44-3 and CC-44-4 are **resolved** subject to the re-review above. Packet 46 is
unblocked.
