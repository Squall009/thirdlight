# Gate E review — M2 packets 14–19 (contracts, evaluated physics, owner decisions)

2026-09-18 · reviewer session, independent of the packets 14–19 authoring runs.
Baseline: accepted M1 at `5b746ee` (`git rev-parse HEAD` in this tree =
`5b746eebc8be22feb921909dc3f5b849c2560ccb`). Scope: packet 14's evaluated
physics selection plus the exact proposed contracts/diffs/fixtures produced by
packets 15–19. No packet 20, no code, no install, no promotion, no contract,
fixture, decision, package or tool file was modified by this review.

Prompt followed: `docs/planning/m2-packets.md` §"Gate review prompt (E–J)".

## 1. Scope and method

Read from the tree and the accepted contracts: `docs/decisions/0002-...md`
§§1–6 (PROPOSED), all `docs/planning/m2-contracts/*.md` and `.../diffs/*.md`,
`docs/planning/m2-contracts/contract-diffs.md`, `docs/planning/m2-acceptance.md`,
`fixtures/m2/contracts/**` + `tools/check-fixtures.mjs`, `docs/acceptance/
evidence-m2/{14..19}/**`, handoffs 14–19, and the accepted `docs/contracts/**`
(unchanged) for destination sections. Every check below was re-run in this
session; nothing relies on a packet handoff as proof.

Recorded digests at review time: HEAD `5b746eeb…`; `package-lock.json`
`a71f4c0b…`; `docs/decisions/0002-...md` `c7ecffe6…`;
`contract-diffs.md` `acf3780a…`.

## 2. Re-run checks (executed evidence, this session)

| # | Check | Result |
|---|---|---|
| 1 | `node fixtures/m2/contracts/tools/check-fixtures.mjs` | exit 0 — `check OK: 33 check group(s) passed, 0 problem(s)` |
| 2 | Checker negative control (corrupt `sources[0].sourceDigest` in a copy) | exit 1 — non-vacuous: `cross-ref` + `digest-claims` fail as intended |
| 3 | `npm test` | exit 0 — 66 files / 841 passed |
| 4 | `npm run typecheck` | exit 0 — all 10 packages clean |
| 5 | `npm run check-deps` | exit 0 — all pins exact |
| 6 | `npm run check-boundaries` | exit 0 — 10 packages / 150 files / 514 specifiers |
| 7 | `npm run build` | exit 0 — 4 built, 0 skipped |
| 8 | `git diff --stat 5b746ee -- docs/contracts packages package.json package-lock.json tools` | **empty** (M1 contracts/packages/tools/lockfile unchanged) |
| 9 | `node docs/acceptance/evidence-m2/19/inventory-check.mjs` | exit 0 — 6/6 (16 proposal/diff files resolve, 7 destination docs present, 22 packet refs) |
| 10 | `python3 evidence-m2/17/independent-recompute.py --verify` | exit 0 — 5 fixture sets |
| 11 | `python3 evidence-m2/18/independent-recompute.py` | exit 0 — 5 groups |
| 12 | Re-ran `probe-rapier2d.mjs phases` ×2 (candidate still installed in `/tmp/tl-m2-eval-14`) | byte-identical to each other **and** to the recorded `05-phases-run1.json` (md5 `80075b51…`) |

### 2.1 Independently re-derived (not reported)

- Re-hashed both packet-15 preimages (`dc3e9a88…`/26 B, `e5a1ea14…`/26 B) — match
  `expected.json.sourceHashes` neighbours and the delivery manifest.
- Recomputed, in Python with an independent canonical-JSON implementation, the
  p19 `manifest-example.json` `buildId` (`5d374b60…`), `buildOptionsDigest`
  (`f4520cb0…`) and `sceneDigest` (`335edff2…`) — all three match the fixture.
- Re-hashed the packet-18 behavior containers: `drift-example.json`
  `e75ed7cf…`/677 B and `drift-example.output.js` `fd6fa9a1…`/489 B match the
  manifest `sourceDigest`/`outputDigest`/byte lengths (claim→artifact links true).
- Re-ran the packet-14 course probe twice in this container and reproduced the
  recorded phase result byte-for-byte (claim 1 + determinism claim 2 confirmed
  independently). Confirmed `T12_degenerateDown.pass:false` is a *hard-coded
  informational marker* (`probe-rapier2d.mjs` line ~455), not a measured
  failure; its sub-checks (`maxPenetrationM 0`, `groundedFlagMisses 0`) are
  clean and the manifest/decision/handoff descriptions are accurate.
- Verified pin integrity against the npm registry for all four candidates:
  `@dimforge/rapier2d-compat@0.20.0` `sha512-FFYwGrfJ…prip4wdWQ==`,
  `@dimforge/rapier2d@0.20.0` `sha512-AfbRbiu7…`, `planck@1.5.0`,
  `cannon-es@0.20.0` — integrity strings, licenses (Apache-2.0/MIT/MIT) and
  `dependencies: null` all match `02-candidate-registry.json` and decision 0002
  §1.2. No install performed.

### 2.2 Reported-only (not independently executed)

Implementation behavior (no implementation exists), browser/GPU/gamepad,
desktop CPU re-measurement, real bundle/locator/export/scan runs, and the
packets 15–19 checker groups beyond the two independent Python re-derivations
and the p19 digests recomputed above.

## 3. Contract-content assessment (gate's core concerns)

- **Single authoritative commit + retry-before-stage-lookup** — correct.
  `content-storage.md` §6.1–§6.4 make the authoritative step a stage-free
  `publishAsset`; dedup happens at `commands.md` §6.1 step 2 (before revision
  check, argument validation and any staging resolution), including while writes
  are paused. F14 (retry with expired/cleaned stage) replays; F17 crash table
  shows unreferenced-immutable-bytes at worst. Crash points are enumerated.
- **Ownership / external-change interaction (BR-4)** — resolved.
  `content-storage.md` §5 + `diffs/workspace.md` W9 (new §7.6) scope the §5.2
  pre-write check and §7 unexpected-external-modification protocol to authoring
  files only; staging under `.thirdlight/**` never pauses, snapshots or
  quarantines. Staging is non-authoritative, never read for state, and the
  mutation lock is never held across staging/GLB/blob I/O (§6.3).
- **No-GC / immutability** — correct and honest: content-addressed write-once
  blobs (`O_NOFOLLOW`, verified on read), no blob deletion, no overwrite on
  mismatch; the quota cliff is explicit (`§10`), backup = manifest + envelope +
  all `sources/sha256/**`.
- **Version compatibility** — exhaustive matrix `content-storage.md` §3.1
  (manifest 1 / scene 1→2 / storage 1→2), no silent upgrade, no downgrade,
  explicit original-preserving `migrateProjectCopy` with reset-to-zero revision.
- **Strict shapes / limits / defaults / errors** — present per contract; limits
  are enumerated (`content-storage.md` §9, `delivery.md` §11) and surfaced in
  `m2-acceptance.md` §5 with artifact names; the refinements only *add* values
  (§5 header) and weaken no row.
- **Script-trust honesty** — `behaviors.md` §2 states normatively: trusted
  main-thread code, **no hard runtime timeout**, **no hostile-code sandbox**,
  restrictions are defense-in-depth only; §2.4 records that rejection means a
  separate execution-boundary packet. Compiler bounds (§6) are separated from
  runtime trust. This is the required honesty, recorded under the owner
  pre-approval tag.
- **Export independence** — `delivery.md` §4.3/§9 + `diffs/export.md`
  E19-1/E19-2/E19-5/E19-6: same pipeline for play/export, relative-only closure,
  no credentials/host paths/CDN/Node/backend; M1's one-fetch rule is replaced
  only via the explicit diff, with the count rule `1 + |unique declared
  artifacts|`. Export independence holds.
- **Format-aware scans replace the M1 textual regex** — correct:
  `delivery.md` §4.4 defines GLB/WASM/closure validators and states text scans
  apply only to JS/text bytes; `p19-scans` enforces `textScanApplied: false` for
  binaries; `diffs/export.md` E19-6 wires it into `export.md` §5.3/§5.4 without
  changing §5.4.1 counts.
- **Preview credential isolation** — `delivery.md` §6.3: read-only capability
  only, no authoring token / `/api/v1` / listing / traversal / cross-project,
  redaction, CSP, origin/frame restrictions, immutable cache, reload never newer.
- **Per-package edges/pins for approval** — `diffs/dependencies.md` D19-1…D19-10
  plus D18 rows: units `asset-pipeline`, `input`, `physics-rapier`,
  `platformer`, `behavior-build`; `runtime` carries behavior types; the Rapier
  pin is lockfile-only at packet 31; no new GLB pin. Edges are types-only where
  claimed and each unit has negative probes.

## 4. Per-item disposition over `contract-diffs.md`

Legend: **A** = accept for docs-only promotion; **A-fu** = accept with the named
bounded follow-up applied during promotion; no row is rejected.

| Item | Destination | Verdict |
|---|---|---|
| I-1 `content-storage.md` | `workspace.md`, `project-model.md`, `commands.md` | **A-fu** — apply C19-D1/D5/D8 and §3(a) `publishAsset` rename |
| I-2 `assets.md` | `project-model.md`, `commands.md`, `workspace.md`, `dependencies.md` | **A-fu** — C19-D1/D5; `dependencies.md` rows via D19-2 |
| I-3 `prefabs.md` | `project-model.md`, `commands.md` | **A-fu** — §3(b) container supersession (C19-D5), §3(a) |
| I-4 `properties.md` | (same) | **A-fu** — C19-D4 (source-mode wording), C19-D6 (settings registry) |
| I-5 `input.md` | `runtime.md`, `dependencies.md`, `delivery.md` | **A** |
| I-6 `physics.md` | `project-model.md`, `runtime.md`, `dependencies.md` | **A** — pin PROVISIONAL, lockfile only at packet 31 |
| I-7 `platformer.md` | `project-model.md`, `runtime.md`, `dependencies.md` | **A-fu** — C19-D3 |
| I-8 `behaviors.md` | `project-model.md`, `runtime.md`, `commands.md`, `dependencies.md`, `export.md`, `content-storage.md`, `assets.md` | **A-fu** — C19-D1/D2/D7; unit rename (§3(d)) |
| I-9 `delivery.md` | `sessions.md`, `export.md`, `dependencies.md` | **A** |
| D-PM `diffs/project-model.md` | `project-model.md` | **A-fu** — §3(c)/(c2) heading/fence handling; apply in A/P16/P17/P18 order |
| D-WS `diffs/workspace.md` | `workspace.md` | **A** |
| D-CMD `diffs/commands.md` | `commands.md` | **A-fu** — §3(a); C19-D2; resolve §C items 1–3 |
| D-RT `diffs/runtime.md` | `runtime.md` | **A** |
| D-DEP `diffs/dependencies.md` | `dependencies.md` | **A-fu** — §3(d) must be materialized as replacement text (see GE-2) |
| D-EXP `diffs/export.md` | `export.md` | **A** |
| D-SES `diffs/sessions.md` | `sessions.md` | **A** |
| §3 resolutions (a)–(i), (c2) | inventory | **A** — (d) carries follow-up GE-2 |
| C19-D1…C19-D8 | promotion-pass text edits | **A** — no fixture byte changes, envelopes stay valid |
| §5.1–§5.3 owner decisions | decision 0002 §§2–4 | **A** — under the recorded owner pre-approval |
| §5.4 owner decision (trust) | decision 0002 §5 | **A** — honesty verified; owner pre-approval recorded; final manual review pending |
| §5.5 (§6 delivery + units/pins; U-4 both) | decision 0002 §6 | **A** — U-4 accepted fail-closed |

No conflicting destination sections were found: the inventory check resolves all
16 proposal/diff files to real files and all named destination documents exist
(`docs/contracts/{project-model,workspace,commands,runtime,sessions,export,
dependencies}.md`); new sections are unique per contract (§18–§22
project-model; §4.5/§7.6/§13–§15 workspace; §12–§14 runtime; §16–§18 sessions).
The one conflict that is not fully materialized is the unit-name one (GE-2).

## 5. Prioritized failure cases and minimal repair scope

- **GE-1 (P2, docs-only, bounded).** Packet-14 raw evidence is in the wrong
  path. `docs/acceptance/evidence-m2/14/` contains **only** `manifest.md`; the
  14 artifacts (`01`–`12`, `10-probe-iife.js`, `course-spec.json`) are at
  `tests/evaluations/m2-physics/docs/acceptance/evidence-m2/14/`. Handoff 14,
  decision 0002 §1.1, `m2-physics.md` §Packet-14 and `m2-acceptance.md` §5.5 all
  name `docs/acceptance/evidence-m2/14/`. Minimal repair: move those 14 files to
  `docs/acceptance/evidence-m2/14/` (or, if the nested layout is intended,
  correct all four references and the manifest's "in this directory" claim).
  Not a selection blocker: the evidence was located and the course probe
  reproduced byte-for-byte from this tree.
- **GE-2 (P2, docs-only, promotion precision).** `contract-diffs.md` §3(d)
  resolves `behavior-compiler`/`behaviors` → `behavior-build`/`runtime` as a
  *reading rule* only. The literal D18-1/D18-2/D18-3/D18-5/D18-6 diff blocks
  still insert units/rows named `behavior-compiler` and `behaviors`, while
  D19-1/D19-2/D19-3/D19-5/D19-6 insert `behavior-build` and `runtime` additions.
  Applying "exactly the accepted diffs" literally would double-insert
  conflicting rows. Minimal repair: state in D19-A / §3(d) (or as explicit
  replacement text in the D19 rows) that the D18 `behavior-compiler`/`behaviors`
  items are **superseded and not inserted verbatim**.
- **GE-3 (P3, docs-only).** Recorded negative-control evidence is stale:
  `docs/acceptance/evidence-m2/15/05-negative-control.txt` shows `2 problem(s)`,
  but the current checker reports `3` (the `digest-claims` check emits the same
  fixture twice — a cosmetic duplicate-entry bug in `check-fixtures.mjs`). The
  checker is non-vacuous; only the recorded transcript differs. Minimal repair:
  re-record the transcript and de-duplicate the `digest-claims` failure entries.
- **GE-4 (P3, observation, optional).** `02-candidate-registry.json`
  `unpackedBytes` are approximations that do not match registry `unpackedSize`
  exactly (e.g. `rapier2d` "3.1M" vs 2 744 411 B). Cosmetic; the pin/licence/
  integrity facts that matter are exact.

No P1 defects were found in the contract pack; no failure case is a Gate E
blocker for docs promotion.

## 6. Blockers vs bounded follow-ups

- **Blockers: none** for the docs-only promotion of the accepted rows.
- **Bounded follow-ups: GE-1, GE-2** (docs/fixture-path and promotion-precision
  only), plus GE-3/GE-4 as non-gating observations.
- **Contract changes requested: none.** The proposals are internally consistent
  with accepted M1 contracts; no accepted contract is contradicted.
- If a later packet changes any accepted contract section, Gate E's affected
  portion reopens (packet rule).

## 7. Missing context and unverified targets (recorded honestly)

- **UNVERIFIED, not a Gate E blocker (owner authorization, 2026-09-18):**
  desktop/browser/gamepad evidence (render M1 + probe bundle, WASM init under
  real CSP, `getGamepads`/secure-context, preview-iframe gamepad policy). The
  manual procedure is recorded in `evidence-m2/14/manifest.md` §"Manual desktop
  evidence procedure" and rolls into the final owner checklist. The physics
  selection is therefore treated as the owner-pre-approved working decision,
  still labelled PROVISIONAL; the pin enters the lockfile only at packet 31.
- **CPU/init numbers are container/Node and directional** (BR-2); a labelled
  desktop re-measurement is available via the same probes and is required for
  the *performance claim*, not for the selection.
- **Script-execution trust boundary** is owner-pre-approved pending final manual
  review; no sandbox/timeout claim is made anywhere (verified honest).
- No implementation exists: every behavioral, persistence, scan, protocol and
  export claim in packets 15–19 is contract text + fixture re-derivation, not
  executed behavior. Bounds are proposals pinned here for later packets.
- The tree carries uncommitted M1 planning docs (`docs/STATUS.md`,
  `docs/planning/implementation-prompts.md`) that are outside this gate's scope.

## 8. Verdict

**ACCEPT WITH BOUNDED FOLLOW-UPS (GE-1, GE-2).** The packets 15–19 contract pack
is coherent, complete enough to promote, honest about its limits, and
independently corroborated where it makes recomputable claims; packet 14's
physics selection is reproduced and its pin/licence/integrity verified against
the registry. No contract change is required, no blocker exists, and no
implementation should start from this review.

This is my own review record. It is **not** owner approval beyond the recorded
owner pre-approval and **not** a separate independent reviewer's approval.

## 9. Exact next step

1. Apply the bounded docs-only follow-ups (GE-1, GE-2; GE-3 optional) — or fold
   GE-2 into the promotion step's instructions.
2. Run the explicit **docs-only promotion** step: apply only the accepted rows
   above into `docs/contracts/**` in the `contract-diffs.md` §4 order, and record
   the owner pin/trust decisions in `decisions/0002-m2-content-and-behavior.md`
   §§1–6.
3. **Then** packet 20 (Model v2 and pure migration), Gate F. Do not auto-start.

---

## 10. Repair applied (2026-09-18, post-review — does not alter §1–§9)

Applied by the docs-only promotion step under the owner pre-approval
(**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final
manual review pending**); the findings and verdict above are unchanged.

- **GE-1 closed.** The 14 packet-14 raw evidence artifacts were moved from
  `tests/evaluations/m2-physics/docs/acceptance/evidence-m2/14/` to
  `docs/acceptance/evidence-m2/14/`; `manifest.md` was already there and was not
  duplicated, and the now-empty misplaced directory tree was removed. The probe
  scripts remain under `tests/evaluations/m2-physics/` and still run. The four
  references named in §5 (handoff 14, decision 0002 §1.1, `m2-physics.md`,
  `m2-acceptance.md` §5.5) already cited the correct path and needed no edit; the
  manifest's "in this directory" claim is now true.
- **GE-2 closed.** `diffs/dependencies.md` §D19-A gained explicit replacement
  text (item 4): D18's `behavior-compiler` rows are superseded by D19's
  `behavior-build` rows and every D18 `behaviors` row/bullet is folded into
  `runtime`, so promotion inserts only the final unit names.
- **GE-3 closed as observed:** the packet-15 negative-control transcript was
  re-recorded with the current checker (`31 passed / 3 problems`; the second
  `digest-claims` line is the same single corrupted fixture reported twice — the
  cosmetic duplicate-entry defect §5 describes). The fixture checker itself was
  not modified (no-code rule); the duplicate is noted in the transcript header.
- **GE-4 closed:** the `unpackedBytes` values in
  `docs/acceptance/evidence-m2/14/02-candidate-registry.json` and the manifest
  claim row are labelled **approximate registry `unpackedSize`**; the exact
  integrity/license/dependency facts are unchanged.
