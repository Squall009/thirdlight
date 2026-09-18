# Packet 07 review — accepted

Date: 2026-09-18. Reviewed implementation commit `be58767` (parent
`b655d2c`), handoff-record commit `11ae4d3`, and test-cleanup commit
`afd1467` against packet 07 (implementation-prompts §07),
docs/contracts/workspace.md (v0.1, authoritative), docs/contracts/commands.md
(§3/§5/§6/§7), and the handoff's "Limitations / interpretations" 1–8 and
contract-change requests. Independent review; the reviewer made **no code,
tool, or contract changes** and made exactly one docs-only commit (recorded
at the end). Nothing was pushed.

## Verdict

**Accepted — packet 07 complete.** No P1 findings; five non-gating P2
observations (F1–F5 below). The `@thirdlight/workspace` package is a faithful
implementation of workspace.md: 438/438 tests re-verified on the real tree
**and** in a clean `git archive afd1467` + `npm ci` disposable copy (the 3
real-SIGKILL crash tests pass in both), plus **92 independent probe
observations** (exit 0) against the public `openWorkspaceService` API on
disposable ext4 roots covering dedup/retry edges, real-`/proc` liveness
(subsets the suites don't pin: absent-pid, real pid-reuse, unreadable-stat
conservative-live, cmdline mismatch), release/re-claim across identities,
external-change accept/discard incl. a revision **rollback** rebase and a
foreign-deletion-during-write edge, creation/scan edges (interrupted-creation
completion at open, traversal + symlink-to-valid-project escapes,
unloadable-manifest split), and new write-sequence fault points (fsyncFile,
post-attempt classification of a foreign deletion). Contract-alignment spot
checks against the contract text (§4.2/§4.3 load pipeline, §5.1
classification, §5.2 pre-write/resolution hashes, §6.1–§6.4, §7.2–§7.4,
§8.1/§8.3, §9.1/§9.3, §10, §11) found no divergence; the handoff's
interpretations #2–#6 and #8 were independently confirmed, and #1 was
confirmed with one precision correction (F1).

## Provenance (verified)

- HEAD `afd1467`; `git show be58767 --stat`: 24 files —
  `packages/workspace/` (9 src, 9 test, package.json, tsconfig.json),
  root `tests/crash-recovery.test.ts` + `tests/crash/child.ts`,
  `package-lock.json` (+12, workspace entry `name` fix only — no new
  dependency), `docs/STATUS.md` row 07, handoff 07. `11ae4d3`: docs only
  (commit-ID line in 07.md). `afd1467`: 3 lines in
  `packages/workspace/tests/query.test.ts` (remove symlink before recursive
  `rmSync` — the traversal test's temp-root cleanup; behavior-neutral).
- Working tree at start: one unrelated uncommitted change
  (`docs/orchestration.md`) — preserved, not staged, not committed.
- Public surface (`packages/workspace/src/index.ts`): `openWorkspaceService`,
  types, `ERROR_CODES`, `defaultWriteOps` + re-exported commands/model types —
  matches the handoff; no internal exports leaked (check-boundaries clean).

## Re-verified gates (real CLIs, 2026-09-18)

| Command | Result |
|---|---|
| `npm test` (real tree) | exit 0 — **Test Files 27 passed (27); Tests 438 passed (438)**, 21.25s |
| Clean copy: `git archive afd1467 \| tar -x` → `npm ci` → `npm test` | `npm ci` exit 0 (0 vulnerabilities); exit 0 — **438/438**, 21.77s — crash tests included (`tests/crash/child.ts` present in the archive) |
| `npm run check-deps` | exit 0 — `check-deps: OK` |
| `npm run check-boundaries` | exit 0 — "3 package(s) [commands, project-model, workspace], 54 source file(s), 220 specifier(s) checked; no boundary violations." |
| `npm run typecheck` | exit 0 — `tsc --noEmit` per package (commands, project-model, workspace) |

## Independent probes (not covered by the implementer's suites)

Public API only (`openWorkspaceService` + `defaultWriteOps` seam; fixture
files read-only), disposable roots on ext4 (`/home/dadmin/.tl07rev-*`),
probe scripts under `/tmp/tl07-review` with the repo `node_modules`
symlinked and esbuild-bundled, host Node v22.22.1. **92 passed, 0 failed,
exit 0** (round 2; round 1's 28 failures were all reviewer-probe bugs —
malformed `req-` IDs, wrong scan-report reference, a persistent fault
masking the discard — re-run clean after fixes).

| Group (probe IDs) | What it pins | Result |
|---|---|---|
| A0–A6 dedup/retry | recorded-id + different content ⇒ `request_id_reused {currentRevision}` (§6.2); fresh command advances from the recorded revision; **failed requestId re-issued with different valid content applies fresh** (§7.1); **NaN content on a recorded id ⇒ fail-closed `request_id_reused`** (null-digest leg the suite doesn't hit); disk a complete document (rev 3, 3 records) | all pass |
| B1a–f real /proc, absent pid (4194297 < pid_max) | dead ⇒ `stale_ownership` for query **and** command (no automatic takeover); explicit `takeoverWorkspace` ⇒ epoch 1, new record (state owned, ours, new `openedAt`); authoring bytes byte-identical; serves rev 5 | all pass |
| B2a/b real /proc pid-reuse | record naming a **live** `sleep 300` pid with `openedAt` 2 days ago ⇒ starttime > openedAt ⇒ dead ⇒ `stale_ownership`, takeover ok (real `btime` + jiffies path) | all pass |
| B3a–c conservative liveness | fake procRoot with `chmod 000 <pid>/stat` (started before `openedAt`) ⇒ unknown ⇒ **`ownership_conflict`, takeover refused** (not stale); real /proc record naming the probe process itself, default marker `thirdlight`, argv0 `node` ⇒ mismatch ⇒ unknown ⇒ live ⇒ conflict | all pass |
| B4a–i release / re-claim | release: record `state: released`, epoch 0 and `openedAt` **preserved** (only `state` changed); releaser's query ⇒ `project_unavailable {reason: workspace_closed}`; **different identity's** on-demand open **claims** the released record (epoch 1, its backendId/pid) and re-claim **re-writes `openedAt` to the write time** (01:36:20Z → 01:36:22Z) — matches §6.1 "when this record was written" and scenario 09's "openedAt later" | all pass (see F1 for the handoff wording) |
| B5a–c takeover + load failure | stale record + **corrupt envelope** (`{ broken`): takeover **claims** (record ours, epoch 1) then returns `project_unavailable {reason: json_parse_error}`; envelope retained byte-for-byte; session blocked (§7.5) — see F2 | all pass |
| C0–C2, C5, C6 external change | external valid rewrite (rev 5) detected at next write with exact `externalHash`; snapshot `scene-<UTCstamp>-<sha8>.json` byte-identical; foreign file left in place; paused query serves LKG rev 1 with `writePaused: true`; **dedup replay served while paused** (`duplicated: true`, recorded rev); `acceptExternalState` ⇒ `{ok, revision 5, historyReset, retryCleared}`, disk records `[]`, mutation proceeds at 5→6; resolve w/o pending ⇒ `no_pending_change` (both ops) | all pass |
| C3a–d accept as **rollback** | external doc at **lower** revision (1) accepted ⇒ revision re-bases to 1 (§7.3 declared re-base), mutation at accepted revision proceeds 1→2 | all pass |
| C4a–h invalid external | garbage bytes ⇒ `externalValid: false`, `externalErrorCount ≥ 1`; accept ⇒ `external_change_invalid`; **discard-only path**: LKG bytes restored exactly, **snapshot retained** (byte-identical to the garbage), unpaused, mutation proceeds | all pass |
| D1–D5 creation/envelope | `createProject` on existing valid dir ⇒ `{ok, created: false, revision}` no-op, envelope byte-identical; traversal/absolute IDs (`../evil`, `/abs/path`, `..`, `a/../b`) rejected at **all** entry points (`field_value`/`project_not_found`/`invalid_request` — see F3); **symlink to a VALID project outside the root** ⇒ `project_not_found` (query + command) / `project_exists_invalid` (createProject) and **zero writes through the escape** (realpath containment, session.ts:180–192); **unloadable manifest** (interpretation #8): garbage `project.json` ⇒ `project_not_found` for commands/queries but `project_exists_invalid` with detail `json_parse_error` for `createProject`, nothing written; unknown envelope field (fresh open) ⇒ `envelope_invalid`, foreign bytes retained | all pass |
| E0–E3 scan/§8.3 | **initial scan (at open)** deterministically completes an interrupted creation (valid manifest, no scene): entry `completion: "completed"`, initial envelope written (rev 0, `cam-main` at `[0,0.5,4]`, records `[]`), project immediately usable (command 0→1); leftover `.main.json.tmp-*` **reported, not cleaned**; orphan retained; report `{entries, total, truncated}` | all pass |
| F1a–f fsyncFile fault (W step 2 — new point) | `write_failed {previous}`; disk byte-identical; no leftover temps; in-memory unchanged (query rev 5); same requestId re-executes fresh (fails again — no record); after fault cleared the **same request applies fresh** (rev 6, `duplicated: false`) | all pass |
| F3a–f foreign deletion during write (classification edge) | pre-check passes, 3 renames fault while a foreign writer deletes the target ⇒ post-attempt classification ⇒ `external_change_unresolved` with **empty** foreign content; empty-byte snapshot retained (`…-e3b0c442.json`); envelope absent (no torn state); LKG served while paused; discard restores LKG exactly | all pass |

Key output lines (real):

```text
PASS B1a query vs dead-pid record (real /proc, absent pid 4194297) -> project_unavailable/stale_ownership
PASS B2a real /proc pid-reuse (live pid 1653386, openedAt 2d ago) -> stale_ownership
PASS B3a unreadable /proc/<pid>/stat (conservative) -> ownership_conflict (expect conflict, not takeover)
PASS B4f different backend on-demand open claims released record (§6.1/§6.2): query ok=true, record state=owned epoch=1
PASS B4h re-claim record openedAt re-written (write time, §6.1): 2026-09-18T01:36:20Z -> 2026-09-18T01:36:22Z
PASS B5a takeover claims then load fails: code=project_unavailable, record now ours (epoch 1) …
PASS C1b snapshot scene-20260918T013622Z-aa099b5f.json byte-identical to foreign bytes
PASS C3c accept rolls revision back -> {"ok":true,"revision":1,"historyReset":true,"retryCleared":true}
PASS D3c createProject via symlink escape -> project_exists_invalid (in code set; contract silent on this edge)
PASS E1a initial scan (at open) completes interrupted creation: {"projectId":"probe-e1","kind":"project","completion":"completed","loadable":true,…}
PASS F3c empty-content snapshot retained: scene-20260918T013622Z-e3b0c442.json
SUMMARY: 92 passed, 0 failed
```

**No destructive rewrite (project-model §12.4 at the workspace level):**
every failure path probed (D2/D3/D4/D5, B5, C4, F1, F3) left the on-disk
authoring bytes either unchanged or a complete valid document — verified by
byte comparison in each probe; G1/§6.4's "both envelopes complete valid
documents" bound held throughout.

## Findings

| # | Sev | Finding (evidence) | Expected vs actual | Repair requirement |
|---|-----|--------------------|--------------------|--------------------|
| F1 | P2 | Handoff interpretation #1 overstates + imprecise wording. "queries … never re-open" holds only for the **releasing** backend (in-memory released session, `ensureSession` query branch, session.ts:418–421); a **different** backend's on-demand open — including a query — claims the released record (workspace.md:395 "claimable by any backend"; §6.2 table; ownership.ts:217–218). Repro: probe B4 (releaser query ⇒ `workspace_closed`; other identity's query ⇒ record `owned`, epoch 1). Also the parenthetical "record keeps original `openedAt`" is true of the **released** record only — the re-claim writes a new `openedAt` (probe B4h: 01:36:20Z → 01:36:22Z), which is exactly what workspace.md:398 prescribes and scenario 09 pins ("openedAt later"). | Code matches the contract's normative open-time evaluation; the handoff sentence is narrower than both the code and the contract. | Docs only: correct interpretation #1's wording ("the releasing backend's queries fail `workspace_closed`; any on-demand open — by any backend — claims a released record at epoch+1 with a new `openedAt`") and broaden contract-change request (1) to state the cross-backend case explicitly. |
| F2 | P2 | `takeoverWorkspace` can return `project_unavailable` (claim succeeded, §4.3 load failed — session.ts:892/957), which workspace.md:695 does not list for that op (`ownership_conflict`, `stale_ownership`, `project_not_found` only). Repro: probe B5 (stale record + `{ broken` envelope ⇒ claim at epoch 1, result `{ok:false, error:{code:'project_unavailable', reason:'json_parse_error'}}`, bytes retained, session blocked per §7.5). | Contract's §11 code table is silent on claim-then-load-failure; behavior is safe and in-code-set. | Docs only: one-line contract addendum (permit `project_unavailable` for `takeoverWorkspace`) or an explicit ruling that the §7.5 block applies without a new code. No code change required. |
| F3 | P2 | Code-set divergence for syntactically invalid `projectId` in **mutations**: `runCommand` resolves first (service.ts:148 → resolveProjectDir, session.ts:180) ⇒ `project_not_found`, while the query path (session.ts:1234) and the pure commands layer both answer `invalid_request` (probe D2/D2p), and the module's own docstring (service.ts:691) claims `invalid_request`. Repro: `runCommand({projectId:'../evil',…})` ⇒ `project_not_found`; `queryProject('../evil')` ⇒ `invalid_request`; `createProject('../evil')` ⇒ `field_value`. All three entry points reject; `ID_RE` is anchored (envelope.ts:35) and realpath containment (session.ts:180–192) rejects symlink escapes — no traversal reach (probes D2/D3). | Both codes are within commands.md §5.4; the contract is genuinely ambiguous (§3 strictness / §5.4 "envelope-level" vs §6.1 step 1 "Not found ⇒ project_not_found"). | Optional: one-line contract clarification, or align the mutation path to `invalid_request` for syntactically invalid IDs (matching the query path, the pure layer, and the docstring). Not safety-relevant. |
| F4 | P2 | `releaseWorkspace` while a pending external change exists ⇒ `project_unavailable {reason: external_change_unresolved}` (session.ts:994–1001) — conservative and safe (release would otherwise silently discard the foreign bytes via the LKG rewrite) and in-code-set, but contract §9.1's preconditions mention only "no in-flight mutation", and the handoff's interpretation list doesn't record this choice. | Behavior exceeds (safely) the documented preconditions; undocumented interpretation. | Docs only: add one line to handoff 07's "Limitations / interpretations" (release is refused while a pending change is unresolved; resolve first). |
| F5 | P2 | Wrong contract cross-reference in a code comment: `dispose()` cites "workspace.md §9.4" (service.ts:495), but workspace.md §9 has no subsections (commands.md §9.4 "Defensive failure" is a different document). | Cosmetic; no behavior impact. | Fix the comment reference when next touching the file. |

No P1 findings: nothing is wrong or silently passing. In particular, the
dedup-before-revision ordering (§6.1), the pause-then-revision ordering,
`request_id_reused` as a content-addressed lease, at-most-once under both
crash points (suite's 3 real-SIGKILL tests + probes), the conservative
liveness rule in all three directions, the no-automatic-takeover bound,
§8.3's deterministic completion, and the no-destructive-rewrite rule all
hold under independent repro.

## Handoff interpretations — adjudication

- **#1** released-project queries: confirmed for the releasing backend
  (probe B4e); precision correction per F1 — the code follows §6.2's
  normative table for other backends, which is the contract-correct reading
  (contract-change request (1) stands and should be broadened per F1).
- **#2** own-record re-open byte-identical: confirmed (suite pins it; the
  `existingBytes` short-circuit in `claimOwnership`, ownership.ts:237–247,
  is the mechanism; scenario 08 pins "record unchanged").
- **#3** second external change while pending: confirmed (suite covers
  re-fire at the resolution pre-check; my probes confirm detection at the
  next envelope write otherwise).
- **#4** `json_parse_error` for garbage envelopes: confirmed (suite;
  permitted reason per workspace.md §11).
- **#5** `btime`-based liveness: confirmed on the **real** /proc (probes
  B1/B2/B3 use the host kernel clock; container-masked `/proc/uptime` is
  correctly avoided).
- **#6** config test seams: legitimate — I exercised the `ops`/`procRoot`/
  `pid` seams myself; production defaults are the real /proc, wall clock,
  and real pid (service.ts:120–131).
- **#7** scenario-04 fixture hint divergence: **not re-litigated** — both
  artifacts are accepted, the workspace suite blurs only model-owned
  `message`/`hint`/`expected` text inside `details` and pins everything
  else (helpers.ts `deepEqualModelLoose`), and the model's own suite pins
  the model text. The contract-change request (regenerate the fixture hint)
  remains open for the owner; AGENTS.md handling (pass-through + documented
  request, no silent change) was followed.
- **#8** unloadable-manifest split: confirmed by probe D4a/D4b exactly as
  recorded (`project_not_found` vs `project_exists_invalid` +
  `json_parse_error` detail), consistent with commands.md §5.4 and
  workspace.md §8.1.

## Contract-change requests (from handoff 07) — status

- (1) workspace.md §9 one-sentence clarification (released projects):
  **stand, with the F1 broadening** — it must also state that any backend's
  on-demand open (query included) claims a released record at epoch+1 with a
  new `openedAt` (per §6.1/§6.2, which the code already follows).
- (7) regenerate the scenario-04 fixture's model hint from the accepted
  project-model output: **stand** (open; owner/contract-level decision).
- New, from this review: F2 (one-line §11 addendum for
  `takeoverWorkspace`) and, optionally, F3 (clarify the
  invalid-`projectId` code choice for mutations).

## Evidence limits (honest statement)

- Power-loss durability remains untested (the handoff states this;
  process-crash guarantees are tested with real SIGKILL at both points,
  re-verified in two full-suite runs).
- Concurrent-claimer races on the claim primitive are bounded-retry logic
  (ownership.ts:250–290) exercised by design, not by a real two-process
  rename race; the crash tests do exercise a real second live backend
  against the conflict path.
- The F1/F2/F3/F4 contract gaps are documentation-level; none changes a
  behavior this review measured.

## Scope, records, next action

- Evidence: full read of the `be58767` workspace source (11 files) and both
  new test files; the workspace.md and commands.md §3/§5/§6/§7 contract
  text; the pinned scenario fixtures 08/09; 92 independent probes (two
  rounds; round 1 failures were reviewer probe bugs, re-run clean); two full
  suite runs + gates (real tree and clean `npm ci` copy). Not re-litigated:
  packet 05/06 layer behavior (commands/project-model are reviewed and
  accepted; the workspace consumes their public exports only —
  check-boundaries clean).
- The handoff's recorded commands/results match my independent runs
  (438/438, gate outputs verbatim above). The uncommitted
  `docs/orchestration.md` working-tree change is the orchestrator's running
  log and was left untouched.
- Records: `docs/handoffs/07.md` gained a verdict section; `docs/STATUS.md`
  row 07 updated to accepted. Exactly one docs-only commit:
  `Packet 07 review: accepted (07-review.md, handoff note, STATUS row)` —
  made after this file was written.
- Next action: **packet 08 — Runtime and three.js adapter** remains
  **blocked on Gate B** (packets 04–07); do not start before the Gate B
  review. Nothing pushed; no reviewer approval is claimed beyond this
  record.