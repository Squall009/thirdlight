# Packet 06 review — changes still required

Date: 2026-09-17. Reviewed implementation commit `a4e8b2a` (parent
`4018e97`) and handoff-record commit `e94f44f` against packet 06
(implementation-prompts §06), docs/contracts/commands.md (v0.1,
authoritative), docs/contracts/workspace.md (ownership boundaries), and
docs/contracts/project-model.md (§12.5 value-authority error shape).
Independent review; the reviewer made no code, tool, or contract changes and
made **no commit** (verdict: changes still required — diff left uncommitted
per established precedent). Nothing was pushed.

## Verdict

**Changes still required — one P1 finding (F1: pipeline ordering, commands.md
§6.1 step 4), three non-gating P2 observations (F2–F4).** The
`@thirdlight/commands` package is otherwise a faithful implementation: 378/378
tests re-verified on the real tree **and** in a clean `git archive` + `npm ci`
disposable copy; 137 independent probe observations against the public API
envelope/args bypass forms, op value semantics, history edges, no_change,
echo rules, purity under deep freeze, and the recorded cross-contract drift
all behave per the contract text — except the one ordering violation below.
The recorded contract-change request (scenario-04 quaternion hint) was
independently verified on all four legs (a–d) and is judged to be correctly
handled per AGENTS.md (pass-through + documented request; no silent change).

## Provenance (verified)

- HEAD `e94f44f`; `git show a4e8b2a --stat`: 22 files, +4558 — the
  `packages/commands/` package (7 source, 8 test, 3 test-only/config files),
  `package-lock.json` (workspace registration only, +11 lines, no new
  dependency — diff inspected), no other changes.
- Working tree at start: one unrelated uncommitted change
  (`docs/orchestration.md`) — preserved, not staged.
- Public surface (`packages/commands/src/index.ts`): `applyMutation`,
  `createCommandState`, `ERROR_CODES`, `MAX_REVISION`, wire types only —
  matches the handoff and dependencies.md §3 scoping.

## Re-verified workspace checks (real tree, real CLIs)

| Command | Result |
|---|---|
| `npm run check-deps` | exit 0 — all specs exact; pins match §7 (esbuild 0.28.2, typescript 5.9.3, vitest 5.0.1) |
| `npm run check-boundaries` | exit 0 — 2 packages, 33 source files, 106 specifiers, no violations |
| `npm run typecheck` | exit 0 — `tsc --noEmit` both packages |
| `npm run build` | exit 0 — no bundle entries yet (expected until packets 10/12) |
| `npm test` (full suite, run 1) | exit 0 — **378/378** (144 commands + 234 project-model) |
| `node fixtures/commands/tools/generate-fixtures.mjs --check` | exit 0 — 71 fixture files byte-identical |
| Clean copy (run 2): `git archive a4e8b2a` → `npm ci` (exit 0) → `npm test` | exit 0 — **378/378** |

Fixture disk invariants (independent hash/parse checks): scenario 04
`disk-before` ≡ `disk-after` (sha256 `3a7148e8…`, same envelope: rev 5, 5
records) — "no partial change" holds on disk; scenario 03 rev 5/5 records →
rev 6/6 (last record = the recovery re-issue `req-3…0002`, strictly
ascending); scenario 05 rev 0/0 → rev 9/9 (last = step 9 `req-2…0009`,
ascending, 3 entities as scenario.md describes).

## Independent probes (not covered by the implementer's suites)

137 observations across two rounds, via the public API only
(`applyMutation`/`createCommandState`/constants; scenes built with the
model's `validateScene`) in a disposable `/tmp` workspace (repo `node_modules`
symlinked, removed after review):

- **Envelope bypass (34 probes, all correct):** `op` casing
  (`"UNDO"`), query op, numeric/missing `op`; `requestId` uppercase/31/33/
  short hex, missing; `expectedRevision` −1, 2^53, 2^53+2, 4.5, boolean
  (all `invalid_request` at the right pointer; 0 accepted); `projectId`
  uppercase/65 chars/leading dash rejected, 64 chars accepted, numeric
  omitted from echo; `origin` bad kind, wrong case, empty/129-char/control
  clientId rejected, 128 accepted, missing clientId rejected, explicit
  `origin: null` rejected (see F3); unknown top-level field; `args`
  null/array/string/missing → `invalid_request` `/args`.
- **Args bypass (all correct):** `transform: {}` on create and setTransform
  → `field_value`; name 0/129/control chars → `field_value`, 128 accepted;
  box on group, unknown box/material fields → `field_unexpected` at exact
  pointers; wrong types → `field_type`; `kind: "camera"` → `field_value`;
  `parentId` null accepted (root), numeric/object rejected; unknown fields
  at every args level per op; `undo`/`redo` with any arg →
  `field_unexpected`; empty `entityId` passes schema → `entity_not_found`.
- **Value semantics via result-scene (all correct):** 2/5-element position →
  `field_value` "array of exactly 3 numbers" at the entity path, and **no
  component-wise merge** (a 1-element `position: [0]` failed and left the
  stored position `[1.5, 0.25, 0]` intact); NaN components → per-component
  `number_not_finite`; scale 0 / position 1e7 / box size 0 →
  `number_out_of_range`; bad colors (`#xyz`, `#GGG`) → `field_value`;
  quaternion norm 1.001 → `quaternion_invalid` carrying the model's §12.5
  hint; `setTransform` on the camera succeeds (revision 6).
- **no_change (correct):** exact current values and `-0` normalization →
  `no_change` (cls validation); revision NOT advanced (a follow-up undo at
  the pre-no_change revision succeeded and undid the *previous* edit),
  history NOT recorded; undo/redo round trip and the no_change-free chain
  are byte-identical to the pre-edit scene with `revision` masked to 0.
- **History edges (correct):** undo/redo success payloads carry
  `appliedOf`/`originOfApplied` equal to the **original forward** command's
  requestId/origin (verified with an origin; `null` with key present when
  absent); redo after a fresh edit → `history_empty` (`which: "redo"`);
  fresh-state undo → `history_empty` (`which: "undo"`); stale undo/redo →
  `revision_conflict` before the history check; revision advances by exactly
  1 per successful mutation incl. undo/redo (6,7,8,9,10 chain);
  `history_invalid` is **unreachable through the public API** (every inverse
  passes the same result-scene gate on LIFO state) — the implementer's
  internal-state tests are the only route; recorded, consistent with §9.4
  "defensive, must not occur in M1".
- **Echo rules / payload shape (correct):** 100-char `requestId` → 64-char
  echo; 40-char `op` → 32-char echo; non-string `op`/`projectId` omitted;
  bad-syntax string `projectId` echoed verbatim; success key order
  `ok, op, projectId, requestId, revision, duplicated, createdId?, change,
  appliedOf?/originOfApplied?, history` and failure top level
  `ok, op?, projectId?, requestId?, error` match §5.1/§5.2 in every payload
  observed; `ERROR_CODES` is exactly the 21 §5.4 codes; `MAX_REVISION` =
  2^53−1.
- **Purity/totality (correct):** deep-frozen input state and deep-frozen
  request — successful and failing applies both complete without throwing,
  return a NEW state object on success, and leave the input scene bytes and
  history bit-for-bit unchanged on every failure.
- `id_exhaustion` unreachability claim confirmed by code order (the 1024
  entity cap precedes the 9999-per-kind ID scan).

## New findings

**F1 — P1: args schema validation runs BEFORE the revision check
(commands.md §6.1 step 4 violated for `field_*` failures).**

- Contract text: §6.1 step 4 — "Revision checking **precedes argument
  validation**: a stale request is reported as stale, not validated";
  scenario 03 `scenario.md` — "No validation of the args is attempted — the
  request is stale, full stop."
- Code: `applyMutation` calls `validateMutationRequest(request)`
  (`packages/commands/src/apply.ts:126`) — which validates the envelope
  **and** the op-specific args schema
  (`packages/commands/src/validate-request.ts:622` switch) — before the
  revision check (`apply.ts:132`) and the exhaustion check (`apply.ts:140`).
  The `apply.ts` docstring claims "revision check BEFORE argument
  validation" — the claim does not hold for `field_*` codes.
- Probes (state at rev 5):
  - **A1** stale `expectedRevision: 6` + `entityId: 42` (wrong type) →
    actual `field_type` at `/args/entityId` (cls `validation`).
    Expected: `revision_conflict` `{expectedRevision: 6,
    currentRevision: 5}` (cls `conflict`).
  - **A3** stale + `transform: {}` → actual `field_value` at
    `/args/transform`. Expected: `revision_conflict`.
  - **A5** `expectedRevision = 2^53−1` (== current, max-revision scene) +
    `entityId: 42` → actual `field_type`. Expected: `revision_exhausted`
    (a state-level condition; §5.4 "no mutation can be applied").
- In-scope behavior is correct: envelope failures must precede the revision
  check (probe A6: bad `requestId` + stale → `invalid_request`, as
  required), and per-op **preconditions** are correctly ordered after the
  revision check (probes A2/A4/L1: stale + missing entity, stale undo →
  `revision_conflict`).
- Why the suite missed it: scenario 03 fixture message 1 carries *valid*
  args; the stale-UNDO test uses empty (valid) args. No test pins
  stale + schema-invalid args.
- **Repair requirement:** split `validateMutationRequest` into an
  envelope-only pass (op/projectId/expectedRevision/requestId/origin and
  `args`-is-an-object → `invalid_request`) and the per-op args-schema pass
  (`field_*`); in `applyMutation` run envelope → revision check
  (`revision_conflict`) → `revision_exhausted` → args schema → op. Add tests:
  stale + `field_type` args ⇒ `revision_conflict` carrying both revisions;
  stale + `transform: {}` ⇒ `revision_conflict`; `expectedRevision` =
  current = `MAX_REVISION` + invalid args ⇒ `revision_exhausted`.

**F2 — P2: the 32-detail cap (§5.2) is unreachable through the public API
in M1; the cap path is code-read only.** Maximum observed detail count from
a single request: 13 (createEntity with all transform components NaN + box
`size: [0,0,0]` → 7 `number_not_finite` + 6 `number_out_of_range`);
setTransform max 10. `detailCount` always equaled the true total;
`detailsTruncated` never emitted. The cap logic (`errors.ts
resultSceneError`: `slice(0, 32)`, `detailCount`, `detailsTruncated` when
capped) matches the contract on code reading. Honest record: an M1 op can
never produce >32 result-scene details from a valid input scene, so the cap
branch has no public-API regression test; if a future op can, add one.
Non-blocking.

**F3 — P2: explicit `origin: null` is rejected.** Probe B27:
`invalid_request` at `/origin`. The contract table marks `origin` optional
with "absent ⇒ recorded as `null`" and never pins an explicit `null`;
rejection is the stricter, defensible strictness reading (nothing silently
accepted). Observation only — a one-line contract clarification if the
intended behavior is to accept it. Non-blocking.

**F4 — P2: args-level error key order differs from the scenario-04 fixture
display order (deep-equal, never persisted).** The fixture shows
`{code, cls, found, expected, message}` for `reference_missing`; the
implementation emits `{code, cls, message, expected, found}`
(`errors.ts referenceMissing` + `withFound` appends `found` last). Failures
are never durably recorded (§7.1: only successes), and commands.md pins key
order only for §5.1 success payloads, so this is cosmetic; note that the
`errors.ts` header ("the scenario fixtures pin it" re: error key order) is
overstated for args-level codes. Non-blocking.

## Cross-contract drift (handoff "Contract-change requests") — verified

Independently verified all four legs:

- **(a)** commands.md §5.2 mandates it: "details: **the project-model error
  objects** (project-model §12.5 shape) in document order, capped at 32" —
  so the details must carry the model's hint.
- **(b)** project-model.md §12.5 (line 541) pins the hint
  `"normalize to unit length; e.g. 45-degree yaw about Y is [0,
  0.3826834323650898, 0, 0.9238795325112867]"`.
- **(c)** The stale hint `"identity rotation is [0, 0, 0, 1]"` is pinned by
  `fixtures/commands/tools/generate-fixtures.mjs:678` and
  `fixtures/commands/scenarios/04-invalid-no-partial/messages.json:45`
  (and the commands.md §5.2 example itself, line 222).
- **(d)** Ran it: the accepted project-model emits the §12.5 wording for a
  zero quaternion (probe G1), and `applyMutation` passes it through
  verbatim (probes G2/D6) — pass-through is the §5.2-mandated behavior.

**Judgment:** the implementer's handling is **correct per AGENTS.md** — the
accepted contract (project-model as value authority, packet 05 accepted) was
not silently changed, no workaround was built, and the specific issue +
proposed contract diff (commands.md §5.2 example, generator line 678,
regenerated `messages.json`) is documented in the handoff. The commands-side
strings are stale docs/fixture bytes relative to the accepted model; the fix
is docs-only, belongs in the contract fix queue, and reopens the relevant
review gate per STATUS gate discipline. Not a finding against this packet.

## Evidence, scope, and next action

- Host: Node v22 (npm workspaces); pinned typescript 5.9.3, esbuild 0.28.2,
  vitest 5.0.1 via the lockfile.
- Full suite run exactly twice as allowed: real tree (378/378, exit 0) and
  clean `git archive a4e8b2a` + `npm ci` copy (378/378, exit 0).
- Probes: `/tmp/tl06-probe` (disposable copy at `a4e8b2a`, repo
  `node_modules` symlinked; two vitest probe files against the public API;
  137 logged observations; no repository fixtures added or left);
  `/tmp/tl06-clean` (clean copy). Both removed after review.
- **Not verified (honest limits):** no visual behavior exists (pure layer);
  the durable pipeline steps 1–3/7–9 (dedup, pause, write, ack) are packet 07;
  the F2 cap branch is unreachable by construction in M1.
- Review-only diff (UNCOMMITTED, per the changes-required precedent): this
  report, a short verdict note at the top of `docs/handoffs/06.md`, and
  packet 06's row in `docs/STATUS.md`. No implementation, tooling, or
  contract changes. No reviewer approval is claimed beyond this record.
- Next action: **implementer repairs F1** (reorder per the repair
  requirement + ordering tests; F2–F4 non-gating), then a re-review run.
  Packet 07 remains blocked on this packet's acceptance. Gate B stays
  **pending**.