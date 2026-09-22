# Packet 06 re-review (round 1) — accepted

Date: 2026-09-18. Reviewed repair commit `b15786a` and handoff-record
commit `0972456` (parent `e94f44f`) against [06-review.md](06-review.md)
(findings F1 P1, F2–F4 P2), packet 06 (implementation-prompts §06), and
commands.md §3/§5/§6.1. Independent re-review after the round-1 repair;
the reviewer made **no code, tool, or contract changes** and made exactly
one docs-only commit (recorded at the end). Nothing was pushed
(`origin/main` still `87394e3`).

## Verdict

**Accepted — packet 06 complete.** F1 is closed: the pipeline is now
envelope → revision check → `revision_exhausted` → args schema → op
(apply.ts:131–157), exactly as the repair requirement demanded, and every
originally-failing repro now returns the contract-mandated code. Verified
with a fresh independent probe round — the original A1/A3/A5/A6 with my
OWN request variants (different ops/entityIds/revisions) plus five NEW
ordering probes the repair tests do not cover — 21/21 pass, no new P1
findings. No collateral damage: previously-green behaviors (no_change
non-advance, failure purity under deep freeze, success payload key order,
per-op preconditions after the revision check, scenario 03/04/05 replays)
spot-checked and re-verified in the full suite. 386/386 on the real tree
AND a clean `git archive 0972456` + `npm ci` copy. F2–F4 remain accurately
recorded carried-forward P2s; no code was (or was required to be) changed
for them.

## Provenance (verified)

- HEAD `0972456`; `git show b15786a --stat`: 6 files —
  `packages/commands/src/apply.ts`, `packages/commands/src/validate-request.ts`,
  new `packages/commands/src/revision-ordering.test.ts` (127 lines, 8
  tests), plus docs (`06-review.md` committed with the repair, `06.md`,
  `STATUS.md` packet-06 row only). `0972456`: docs only (the repair
  commit-ID line in `06.md`). No other files touched — in particular
  `errors.ts`, `ops.ts`, `history.ts` are **unchanged** (relevant to F2–F4).
- Working tree at start: one unrelated uncommitted change
  (`docs/orchestration.md`) — preserved, not staged.
- F1 code read: `validateRequestEnvelope` (validate-request.ts) is the
  envelope-only pass (op/projectId/expectedRevision/requestId/origin and
  `args`-is-an-object → `invalid_request`); `validateOpArgs` is the
  per-op `field_*` pass over the unchanged per-op validators;
  `validateMutationRequest` composes both (envelope, then args) and no
  longer sits in the pipeline — `applyMutation` owns the order: envelope
  (apply.ts:135) → `revision_conflict` (apply.ts:143) →
  `revision_exhausted` (apply.ts:151) → `validateOpArgs` (apply.ts:157) →
  op switch. The `failure()`/`success()` payload helpers are not in the
  diff (echo rules and §5.1 key order untouched).

## F1 closure — my own probes (not the repair child's recorded probes)

Public API only (`applyMutation`/`createCommandState`/`MAX_REVISION`/
`ERROR_CODES`; scenes built with the model's `validateScene`), disposable
`/tmp/tl06-rerev` workspace with the repo `node_modules` symlinked,
esbuild-bundled, host Node v22. **21 passed, 0 failed, exit 0.**

| Probe (my variant) | Required | Actual |
|---|---|---|
| RA1 (A1): rev 9, `deleteEntity` `entityId: 3.14`, stale 10 | `revision_conflict` {10, 9}, cls `conflict` | ✓ `revision_conflict`, `expectedRevision: 10`, `currentRevision: 9` |
| RA3 (A3): rev 1, `createEntity` kind box + `transform: {}`, stale 2 | `revision_conflict` {2, 1} | ✓ `revision_conflict`, {2, 1} |
| RA5 (A5): at `MAX_REVISION`, `createEntity` `kind: 42`, matching rev | `revision_exhausted`, cls `internal` | ✓ `revision_exhausted`, `currentRevision: 9007199254740991` |
| RA6 (A6 guard): bad `origin.kind` + stale 6 | `invalid_request` (envelope-first) | ✓ `invalid_request` at `/origin/kind` |
| N1 NEW: rev 3, `setTransform` missing required `transform`, stale 4 | `revision_conflict` (stale + `field_missing`) | ✓ `revision_conflict` {4, 3} |
| N2 NEW: stale 6 + `origin: { kind: "mcp" }` (no clientId) | `invalid_request` (origin is envelope-level) | ✓ `invalid_request` at `/origin/clientId` |
| N3 NEW: at `MAX_REVISION` + `expectedRevision: 2^53` (non-safe-integer) | `invalid_request` (envelope-level) | ✓ `invalid_request` at `/expectedRevision` |
| N3b NEW: at `MAX_REVISION` + stale (`MAX−1`) + `kind: 42` | `revision_conflict` (exhausted must NOT preempt conflict) | ✓ `revision_conflict` {MAX−1, MAX} |
| N4 NEW: rev 7, unknown args field, stale 8 | `revision_conflict` (stale + `field_unexpected`) | ✓ `revision_conflict` {8, 7} |
| N5 NEW: populated history, stale `redo` (rev 0 vs 1) | `revision_conflict` (not redo, not `history_empty`) | ✓ `revision_conflict` {0, 1} |
| S1: exact current values | `no_change` cls `validation`, revision NOT advanced | ✓ `no_change`; follow-up at the same revision then succeeded (rev 4 → 5) |
| S2: deep-frozen state + request (stale+bad args; and success) | no throw, input byte-identical | ✓ both, input untouched |
| S3: fresh `createEntity` success | §5.1 key order, revision 6, `createdId` | ✓ keys `ok,op,projectId,requestId,revision,duplicated,createdId,change,history`; `createdId: "box-0003"` |
| S4: stale + valid args + missing entity | `revision_conflict` (preconditions after revision check) | ✓ `revision_conflict` {6, 5} |
| S5: `args: null` + stale | `invalid_request` `/args` (envelope strictness) | ✓ `invalid_request` at `/args` |
| S6: fresh + `entityId: 42` | `field_type` `/args/entityId` (args pass runs when fresh) | ✓ `field_type` at `/args/entityId` |
| S7: stale `undo` (empty history) | `revision_conflict` | ✓ `revision_conflict` {4, 5} |
| S8: fresh 4-element `position` | `field_value` with `detailDocument: "result-scene"` (handoff one-off nuance) | ✓ both |

Constants: `MAX_REVISION === 2^53−1`, `ERROR_CODES` = 21 codes — both
invariant.

## No collateral damage

- Spot checks S1–S8 above: no_change semantics, failure purity (deep
  freeze), success payload shape/order/revision bump, per-op
  precondition ordering, envelope strictness, and the result-scene value
  constraint nuance all behave exactly as the original review recorded.
- The scenario replay suites (`scenario-03-revision`,
  `scenario-04-failures`, `scenario-05-history`) are still in the suite
  (9 commands test files incl. the new `revision-ordering.test.ts`) and
  pass — see full-suite evidence.
- `validate-request.ts` diff inspected in full: the per-op validators
  (`validateCreateArgs`/`validateSetTransformArgs`/`validateDeleteArgs`/
  `validateUndoRedoArgs`) and all `invalid_request`/`field_*` shapes are
  byte-identical to pre-repair; only the entry-point split and the
  `EnvelopeOk.args` carrier were added.

## Full suite and re-verified workspace checks

| Command (real commands, real results, 2026-09-18) | Result |
|---|---|
| `npm test` (real tree, run 1) | exit 0 — **386/386** (18 test files) |
| Clean copy (run 2): `git archive 0972456` → `npm ci` → `npm test` | `npm ci` exit 0 (0 vulnerabilities); exit 0 — **386/386** |
| `npm run typecheck` | exit 0 — `tsc --noEmit` both packages |
| `npm run check-boundaries` | exit 0 — 2 packages, 34 source files, 110 specifiers, no violations |
| `node fixtures/commands/tools/generate-fixtures.mjs --check` | exit 0 — 71 fixture files byte-identical, digests + canonical stability verified |

## F2–F4 status (carried-forward P2s, unchanged)

- **F2** (32-detail cap unreachable in M1): `errors.ts` untouched by the
  repair; my max-detail probe (`createEntity`, all-NaN transform + zero
  box size) returns `detailCount: 13`, `details.length: 13`, no
  `detailsTruncated` — matches the original review's measurement.
  Accurately recorded; no code required, none made.
- **F3** (explicit `origin: null` rejected): still `invalid_request` at
  `/origin` (re-probed) — the stricter reading stands. Accurately
  recorded; no code made.
- **F4** (args-level error key order vs scenario-04 fixture display
  order): `reference_missing` still emits `{code, cls, message,
  expected, found}` (re-probed) — cosmetic, failures never persisted.
  Accurately recorded; no code made.
- Confirmed via `git show b15786a --stat`: the repair changed no code
  file beyond `apply.ts`/`validate-request.ts`/the new test file.

## Records spot-check

- Handoff "Repair update" claims match my independent runs: 386/386
  (18 files), fixtures 71/71 byte-identical, check-boundaries "34 source
  file(s), 110 specifier(s)", and the A1/A3/A5 re-run results match my
  own repros code-for-code. The repair commit ID `b15786a` matches git
  history; `0972456` is the small docs-only follow-up (precedent: packet
  04 repair `0178800`).
- STATUS packet-06 row said **pending re-review** before this run —
  accurate; now updated to accepted.

## Scope, limits, next action

- Evidence: code read of the repair diff + my 21-probe round (own
  variants + new ordering probes) + F2–F4 re-probes + two full-suite
  runs (real tree, clean `npm ci` copy) + the four re-verified CLI
  checks. Not re-litigated: everything the original review closed green
  (envelope/args bypass matrices, value semantics, history edges, echo
  rules, fixture disk invariants, cross-contract drift handling) — those
  code paths are untouched by the repair, and the scenario replays +
  full suite re-confirmed them.
- **Not verified (honest limits):** no visual behavior exists (pure
  layer); durable pipeline steps 1–3/7–9 (dedup, pause, write, ack) are
  packet 07; the F2 cap branch remains unreachable by construction in M1.
- Disposable workspaces `/tmp/tl06-rerev` and `/tmp/tl06-clean2` removed
  after the run; no repository fixtures added or left.
- Next action: **packet 07 — "Durable workspace service"** is unblocked
  (packet 06 accepted). Gate B (covers 04–07) remains **pending** until
  its gate review. Nothing pushed; no reviewer approval is claimed
  beyond this record.