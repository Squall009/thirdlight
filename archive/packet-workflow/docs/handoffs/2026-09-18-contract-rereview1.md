# Contract re-review (round 1) — repaired request, findings F1–F7

**Date:** 2026-09-18
**Reviewed:** `docs/handoffs/2026-09-18-contract-request.md` as repaired by
commits `8ed35ad` (sections 1–6; mechanism re-selected to (a) O_EXCL claim
file, F1/F2/F3) and `1dc2129` (section 7 + the 4.1 row fix, F4–F7), against
the findings of `docs/handoffs/2026-09-18-contract-review.md`. Working state:
HEAD `1dc2129`; `origin/main` `87394e3` (nothing pushed); tree clean except
the uncommitted `docs/orchestration.md` (orchestrator log, untouched).
**Scope:** independent re-review only — docs-only; no source, test, contract,
or fixture change; the proposed diff was NOT applied.

**Verdict: accepted, with bounded follow-ups** — 0×P1, 2×P2 (N1, N2), both
non-gating, doc-only fixes to the REQUEST document to be applied via a repair
step before the diff is applied to `workspace.md`. No reviewer approval is
claimed.

## F1–F7 closure

| ID | Closure | Evidence (request line = req; contract = workspace.md) |
|---|---|---|
| F1 | **closed** | Mechanism (a) is dep-free and implementable: host probe (real, this step) `fs.open(p,'wx')` on Node v22.22.1 — fresh path: create then `EEXIST`; existing **non-empty** file: `EEXIST`; existing empty file: `EEXIST` (existence, not emptiness). `openTempFile` (write.ts:61/73) already uses `'wx'`; deps.md §4.1 allows `fs` only — no new dependency. §2(a) "recommended (round 1)", §3 "Exactly one mechanism: (a)"; the "Recorded alternative, not adopted" paragraph (req 415–422) is correctly scoped: future owner decision, "**not a pin**", requires owner decision + §7 pin + §5.6 check-deps. |
| F2 | **closed** | Hunk 4.1 own-record row (req 453) states all three: no `O_EXCL` re-run against own claim file; content re-verified against `backendId`+`pid`; missing/foreign ⇒ `ownership_conflict` (holder `null`) + must not serve. Grep audit: every flock/EWOULDBLOCK/per-OFD/"session lock" occurrence is inside the §2(b) (req 242–346) or §2(c) (348–390) evaluated-rejected subsections, the header meta (line 10), or the §3 recorded-alternative note (412–422). The (b)(iii) error sentence is retained only with the F2-error annotation (req 305–309). No normative per-OFD prose in §4/§5/§7. |
| F3 | **closed** | §9 hunk present (4.7a/4.7b). Independent verbatim check: both Before blocks match workspace.md exactly once (lines 644–651, 659–660 — see applicability below). Coverage verified in the After text: no claim-gate re-attempt at release ("does **not** re-attempt the §6.3 claim gate (no `O_CREAT|O_EXCL`)"); unlink own claim file; no partial release; crash orphan `released@e + claim-e` recovered by superseded-epoch cleanup at e+1; old session "must not issue further writes" once the released record is durable. The "same claim primitive" wording issue is fixed: grep shows the phrase only in the 4.7a Before quote (req 724); 4.7b changes "holds no lock" → "holds no claim file". 4.8 stuck-state note documents the release-crash orphan (no new operation). |
| F4 | **closed** | All five sites present and mutually consistent (one normative meaning: ENOENT at re-read ⇒ cleared/unpaused from any paused state; no snapshot; prior snapshots remain evidence; next write fresh per §5.2): 7.1 evidence sentence (req ~1018, added by 1dc2129); 7.2 state-table note ("From **any** paused state…"); 7.2 cross-state re-read rule (full ENOENT branch incl. "a zero-byte snapshot must never stand for deletion"); 7.4(d) new-bullet ENOENT branch; 7.4(a) G1.3 ENOENT clause ("the snapshot precondition above binds to the foreign **bytes**, not to the paused state"). No contradictions among the five. |
| F5 | **closed** | Exactly one normative wire convention, one place (7.3, req ~1145): fields "present as `null` on the wire… and the fields are never omitted". Grep `omitted` (case-insensitive): the single occurrence is that sentence itself. 7.2 table and 7.4(f) shapes use explicit nulls, matching it. |
| F6 | **closed** | Byte-binding sentence present in 7.4(b) step-2 After (req ~1229): "the snapshot is the bytes read in step 1 (in memory), never a re-read of the target; the artifact's `sha8` name therefore matches the snapshot content; a concurrent change between step 1 and step 2 does not alter the snapshot and is re-detected at the next §5.2 check / 7.4(d) re-read." |
| F7 | **closed** | 4.1 released row carries the claim-time failure note ("claim-file contention or an unresolvable orphan ⇒ `claim_inconsistent`"); own-record row covered by the self-reclaim rule. `git show 1dc2129 \| grep '^@@'`: 8 hunks, exactly **one** pre-986 (`@@ -448` = hunk 4.1 — verified content: the released-row addition only); the other 7 are section-7 (7.1/7.2/7.3/7.4a/7.4b/7.4d/7.5). Section 4 changed only via hunk 4.1 in this commit. |

## New independent audit of the (a) design (not covered by the original review)

- **Orphan recovery (2a).** (i) No backend path removes a live owner's claim file: removals are (1) the owner's own release unlink (the released session must not serve — 4.7a norm), (2) superseded-epoch cleanup, which fires only against a `released`/stale-**dead** record at e, (3) operator file operations (not backend). The false-dead takeover variant (live holder misclassified dead ⇒ cleanup at e+1 removes its claim file) is the pre-existing §6.4 residual bound, explicitly carried over (a)(vi) + 4.5 After ("A takeover of a *live* owner still rests on the same `/proc` trust assumptions as the stale path"). Sound. (ii) proc stat EACCES ⇒ live: 4.2 After keeps the current §6.2 bullet verbatim ("any error reading `/proc` ⇒ **unknown ⇒ treated as live**", contract 423–426) and the orphan rule requires "parseable content + proven dead (unknown ⇒ live ⇒ refuse)" — matches the R8 §6.2 rule. (iii) The misclassification bound is in the text (4.2 After, 4.5 After, 4.3 orphan rule): a false "live" can only delay/block a reclaim (operator-visible via `claim_inconsistent`; operator file operation resolves it) — never create a second writer, because the live holder's O_EXCL file still exists (a concurrent same-epoch claimer fails EEXIST) and the step-4 re-read catches a foreign overwrite. Sound.
- **Superseded-epoch cleanup (2b).** Safety argument present and correct (4.3 After normative block + (a)(iii)): a claim at e+1 occurs only against a released/stale-dead record at e, so claim-e excludes no live writer; failed best-effort unlink leaves inert residue and "the epoch is monotonic, so no future claim ever targets `claim-e` again". Cleanup runs only after a *successful* claim (4.4: "on success the superseded-epoch cleanup unlinks `claim-e`"). Crash between record write and cleanup ⇒ `owned@e+1` (dead pid) + `claim-(e+1)` + inert `claim-e` ⇒ ordinary stale pair + inert residue: recoverable (next takeover at e+2 unlinks `claim-(e+1)`; `claim-e` gates nothing). No hole found.
- **Hostile unlink-recreate (2c).** Interleaving analysis: within a claimant's own window [O_EXCL, step-4 verification], the by-path two-file re-read catching foreign content and aborting with `ownership_conflict` (no serve) rules out a second writer — two protocol-following claimers serialize on the kernel O_EXCL (one winner); a hostile recreate inside the window leaves ≤1 writer (test 6's exact sequence verified). A hostile unlink-recreate **after** the victim's completed verification is outside the step-4 window and is the documented §7.1 bypassing-actor class (4.5 After: "the same exposure as today's direct ownership-file tampering"), bounded by the §5.2 pre-write check at the next envelope mutation — no silent corruption. The request's claims are correctly scoped to that window. **However, see N1 (ordering).**
- **Crash states (2d).** All four (a)(ii) crash points documented and recoverable. "No half-claim session serving" is normatively entailed: 4.3 After "Any failure at steps 2–5 **fails the claim** (the claimant holds no ownership…)" + ownership conferral only on full step-5 success ⇒ a survivor of the content write holds no ownership until it completes or aborts, and cannot serve without ownership. Accepted (entailed, not verbatim).
- **R8 interaction (2e).** The diff forbids treating unreadable claim-file **content** as absent: orphan recovery requires content *parseable* + proven-dead (4.3, 4.2 After bullet, `claim_inconsistent` row "content unparseable, or holder pid not proven dead"); the EEXIST precondition means the file's existence is already known, so unknown content can only refuse — never read as absence. The unknown⇒live norm extends to claim-file content reads (gaps: record side — N2).

## New findings

| ID | Sev | Location | Finding | Repair requirement (doc-only, request) |
|---|---|---|---|---|
| N1 | P2 | req 4.3 After steps 2–4 (claim sequence) | The prescribed verification order is deviated from: the claim file is re-verified by path **only after** the record `W` (step 4), not before it. In the exact hostile sequence (foreign unlink-recreate of `claim-e` between our O_EXCL and our content write), detection therefore happens **after** the record was already written with our identity; the text does not document that residual state ("Any failure at steps 2–5…" is silent on the record). Safety holds (verified: no second writer in any in-window interleaving; the state resolves via the normal liveness path — live ⇒ conflict until death, dead ⇒ stale ⇒ e+1 takeover whose cleanup removes `claim-e`; envelope untouched), hence non-gating. | In 4.3 After: insert a pre-record verification (after step 2: re-read `claim-e` **by path**; content must equal our step-2 identity; foreign ⇒ claim fails with `ownership_conflict`, **no record written**), keeping step 4 as the final two-file check; and/or explicitly document the step-4-failure residual state (record@e with the claimant's identity + foreign `claim-e` ⇒ claimant holds no ownership, must not serve; resolves via the §6.2 liveness path; e+1 cleanup removes `claim-e`). |
| N2 | P2 | req 4.3 After step 1; 4.1 rows | The EEXIST re-read enumeration ("owned+live / owned+dead / absent-released-older-epoch ⇒ orphan-recovery") does not cover a **non-ENOENT record read failure** (e.g. EACCES on `ownership.json`): an unreadable record is none of the enumerated outcomes, and the diff never states a read error is not absence for the record. Structurally safe under (a) — the exclusion gate is the claim file + liveness, and routing an unreadable record into the orphan-recovery rule fails closed (parseable content + proven-dead required) — so non-gating, but the normative text is incomplete. | Add one clause to 4.3 step 1 (and optionally the 4.1 rows): "a non-ENOENT record read failure at the re-read is never treated as absence — the record's state is unknown; the claim proceeds only via the orphan-recovery rule (which requires parseable claim-file content and a proven-dead holder) or fails `claim_inconsistent`." |

**Notes (not findings).** (1) The two 7.4(d) line-prefix Before quotes (accept/discard precondition lines end mid-line in the current file, before " Effect: …") — **adjudicated acceptable as-is**: each is a unique substring (count=1, verified), and substring replacement yields exactly the intended after-text with the "Effect: …" tail preserved; optional bounded improvement = extend the quotes to full lines, not required. (2) A resolution issued while paused whose pre-answer re-read finds ENOENT has no explicit return code in the 7.4(d) bullet; §7.3's existing rule ("Re-issuing either with no pending change ⇒ `no_pending_change`") determines it once the re-read clears the pending — no conflict; optional clarification. (3) Provenance: `8ed35ad` also committed the previously uncommitted review file (155 lines, added) alongside the repair — docs-only, noted, not a scope violation.

## Diff applicability (simulated, NOT applied)

Independent Python check of every `**Before**` block (19 total: 11 in
section 4, 8 in 7.4) against the current `workspace.md`: **19/19 match at
exactly one location** (unique substring; includes the new 4.7a/4.7b §9
blocks and the two 7.4(d) line-prefix quotes). No non-unique or non-matching
block — the full diff (section 4 + 7.4) would apply cleanly.

## Scope + provenance

Spot-checked hunks (4.4 After takeover procedure — (a) wiring only; 7.4(c)
invalid-bytes — evidence precondition; 4.6 After §6.5 — claim-file lifecycle;
7.4(f) resolution rows — the two new codes; 4.8 stuck-state note) — no hunk
changes contract meaning beyond R9 + R1/R3 + R16-contract-side; nothing
touches §8/§10/§12 or G1–G2 outside 7.4(a). `git show --stat`: 8ed35ad =
request.md + review.md (added); 1dc2129 = request.md only (62 lines).
`git diff --stat 44f0a49..HEAD` = request.md + review.md + orchestration.md
only — no source/test/fixture/contract change since the review's HEAD, so the
recorded probe outputs still reproduce. `origin/main` = `87394e3` (nothing
pushed); tree clean except the orchestrator log (untouched).

## Evidence (real outputs at HEAD 1dc2129)

```text
$ git rev-parse HEAD && git status --short && git rev-parse origin/main
1dc21290785bc46b36dd7c20ddf68bd55d158f1f
 M docs/orchestration.md
87394e3504d21f8168130f40d4ef20a455a5eefd

$ git show 1dc2129 | grep -c '^@@'        → 8
$ git show 1dc2129 | grep '^@@' | head -1 → @@ -448,7 +448,7 @@  (sole pre-986 hunk; content = released-row note)
$ git diff --stat 44f0a49..HEAD
 docs/handoffs/2026-09-18-contract-request.md | 933 +++++++++++++++------
 docs/handoffs/2026-09-18-contract-review.md  | 155 +++++
 docs/orchestration.md                        |   3 +
 (no packages/, docs/contracts/, fixtures touched)

$ node --version && <fresh /tmp O_EXCL probe, 3 cases>
v22.22.1
fresh: first open created
fresh: second open rejected EEXIST
nonempty: open rejected EEXIST (existence, not emptiness)
empty: open rejected EEXIST
probe complete, files removed; exit 0

$ python3 /tmp/tl-rereview1-apply.py   (19 Before blocks vs workspace.md)
Before blocks found: 19
req line  439: OK (unique) | '| absent | — | claim: write our record ...'
req line  461: OK (unique) | '- Present, started before `openedAt` ...'
req line  500: OK (unique) | '### 6.3 Claim primitive (the only ownership write)'
req line  598: OK (unique) | '- `takeoverWorkspace` procedure: ...'
req line  629: OK (unique) | '- **Residual split-brain (honest bound):** ...'
req line  669: OK (unique) | '- Written on claim (§6.3); ...'
req line  716: OK (unique) | '   - The current state is already durable ...'   (4.7a §9)
req line  757: OK (unique) | '   and holds no lock — ...'                       (4.7b §9)
req line  778: OK (unique) | '(Transport/auth for these operator commands ...'
req line  807: OK (unique) | '| `ownership_conflict` | live owner holds ...'
req line  828: OK (unique) | '`holder` in ownership errors: ...'
req line 1171: OK (unique) | '3. **No silent loss of foreign bytes:** ...'      (7.4a G1.3)
req line 1204: OK (unique) | '1. Reads the on-disk bytes `B`; ...'              (7.4b steps 1-2)
req line 1242: OK (unique) | "4. Sets the project's **pending change** ..."     (7.4b step 4)
req line 1267: OK (unique) | '**Invalid external bytes** ...'                   (7.4c)
req line 1292: OK (unique) | '- **`acceptExternalState(projectId)`** ...'       (7.4d accept, line-prefix)
req line 1306: OK (unique) | '- **`discardExternalState(projectId)`** ...'      (7.4d discard, line-prefix)
req line 1343: OK (unique) | '`.thirdlight/recovery/scene-<UTCstamp> ...'       (7.4e)
req line 1384: OK (unique) | '| `acceptExternalState(projectId)` | operator ...' (7.4f)
RESULT: 19/19 unique matches, 0 problems

grep audits (req = request doc): 'same claim primitive' literal: 0 lines
(same claim at 443/451/455 = "same claim procedure" + 724 = 4.7a Before quote);
'omitted' (case-insens): 1 line (1148 — the single normative wire-shape sentence);
flock/EWOULDBLOCK/per-OFD/"session lock": only lines 10, 242–346, 348–390, 412–422
(§2(b)/(c) evaluated-rejected + header meta + §3 recorded alternative); none in §4/§5/§7.
'unknown ⇒' at 465/474 (4.2 Before/After — §6.2 bullet verbatim incl. "any error
reading `/proc` ⇒ unknown ⇒ treated as live"), 486–487 (new 4.2 bullet: orphan
rule, claim-file content), 564 (4.3 orphan rule), 823 (claim_inconsistent row).

$ npm test
 Test Files  27 passed (27)
      Tests  438 passed (438)
   Duration  21.65s (tests 93%, import 4%, transform 3%)
exit 0 (baseline — the suite does not cover R9; §5 tests required post-acceptance)

$ node docs/reviews/2026-09-18-probes.mjs   (disposable ~/.thirdlight-audit-*)
UNREADABLE_OVERWRITE {"pendingHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","snapshotBytes":0,"discard":true,"foreignLost":true}
SNAPSHOT_FAILURE {"error":"external_change_unresolved","discard":true,"snapshots":0,"foreignLost":true}
(+ all other R-lines identical to the recorded outputs)   exit 0
leftover roots: 0; my /tmp O_EXCL files: removed
# R1 (zero-byte snapshot, foreign bytes destroyed) and R3 (discard with zero
# evidence) reproduce at this HEAD; source unchanged since 44f0a49 ⇒ the R9
# CLAIM_RACE interleaving (rename+verify without an exclusion gate; openTempFile
# 'wx' present at write.ts:61/73, unused by the claim path) stands unfixed by design.
```

## Next action

Bounded repair step (doc-only, request document): apply N1 (pre-record
claim-file verification and/or the step-4-failure residual-state sentence in
4.3 After) and N2 (non-ENOENT record read-failure clause in 4.3 step 1);
optionally the two line-prefix quote extensions and the 7.4(d) return-code
clarification. Then re-run the 19-block applicability check and apply the
accepted diff to `workspace.md` only after acceptance is recorded. Do not
start packet 08 or any implementation under this request until then.