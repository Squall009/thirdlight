# Contract review — 2026-09-18 contract-change request (independent architectural reviewer)

**Date:** 2026-09-18
**Reviewed:** `docs/handoffs/2026-09-18-contract-request.md` — sections 1–6 (R9
exclusive-claim mechanism, commit `af4881c`) and section 7 (R1/R3 unknown-I/O
and evidence-failure states + R16 contract side, commit `893a2fd`).
**Authority:** `docs/reviews/2026-09-18-commits.md` (findings R1, R3, R7, R9,
R16; work-order step 1). Working state: HEAD `44f0a49`; `origin/main` `87394e3`
(nothing pushed).
**Verdict: changes still required** — 4×P1, 3×P2. The proposed diff is NOT
applied to `docs/contracts/*`; no source/test/contract/fixture was touched in
this step (docs-only review). The review file is left UNCOMMITTED per the
changes-required rule. No reviewer approval is claimed anywhere.

## Findings

| ID | Sev | Location | Finding (expected vs actual) | Repair requirement |
|---|---|---|---|---|
| F1 | P1 | request §2(b)(v), §4.3 | **Mechanism (b) not implementable as specified on the pinned toolchain.** Pinned Node 22 (host v22.22.1, dependencies.md §7) exposes no flock(2) binding: `Object.keys(require('node:fs')).filter(/lock/i)` ⇒ `[]` (same for `fs.promises`). The requested `lockExclusiveNonBlocking` default has no real implementation. Evaluated options: (i) new dependency — a native flock(2) N-API wrapper requires a recorded owner decision + dependencies.md §7 pin + §5.6 check-deps; the request records none (a pure-JS O_EXCL+staleness locker is *not* the requested mechanism: no kernel auto-release on death). (ii) `child_process`-spawned `flock(1)` holder (binary present at `/usr/bin/flock` but unpinned): violates dependencies.md §4.1 (`workspace` allowed built-ins: `fs`, `path`, `crypto`, `os` — no `child_process`), and the lock is held by the *child*, not the backend — on backend SIGKILL the child is orphaned (reparented to init) and **keeps holding the lock**; the parent cannot run cleanup. That wedged-lock state contradicts the request's normative "kernel releases it on death … no orphan exclusive state" (§4.3) and §5.3(b) "directly claimable, no operator step". | Either (a) the request switches to mechanism (a) or (c) and redoes the §4 hunks for the chosen mechanism (the §2(a)(iv) row set — §6.2 orphan row + `claim_inconsistent`, §6.3 O_EXCL claim file, §6.4 operator orphan-resolution, §6.5 tombstones, §11 `resolveClaimFile`/`claim_inconsistent` rows — is already drafted and dep-free: `openTempFile` at write.ts:61 is `O_WRONLY|O_CREAT|O_EXCL`), or (b) the decision explicitly records a new pinned dependency (an owner decision the request can flag but not make) with full failure-mode analysis (holder lifetime, orphan-holder, self-reclaim). |
| F2 | P1 | request §2(b)(iii); §6.2 own-record row (workspace.md:410, unamended by 4.1) | **Self-reclaim rule undefined; §2(b)(iii) states wrong flock(2) semantics.** flock locks are per open-file-description: a second `open`+`flock(LOCK_EX|LOCK_NB)` on the same path fails with EWOULDBLOCK while the first fd is open — *including in the same process*. There is no "flock transfers to the new fd, no self-conflict" behavior as stated in §2(b)(iii). The unamended own-record row ("claimable (same procedure)") now inherits §6.3's lock-acquisition step: a same-process reopen whose original fd is still open self-conflicts on its own record. (Consequence: close→re-flock sequences open a release window; the contract must not rely on re-acquisition.) | The contract text must define the self-reclaim rule normatively: the session reuses its already-held lock fd (held fd = step 1 satisfied; no fresh open); a fresh open that cannot lock ⇒ `ownership_conflict`. Fix the §2(b)(iii) prose. Required under any (b) implementation (incl. a recorded native dependency); must appear in the §6.2/§6.3 hunks. |
| F3 | P1 | request §4.6 (After, new §6.5 bullet) + 4.6 parenthetical; workspace.md §9 (lines 641–661, unamended) | **Missing §9 hunk.** The proposed normative §6.5 states the lock is "released on release (§9) or process death". §9 step 1's effect list (envelope rewrite, ownership rewrite "same claim primitive", discard in-memory state) contains no lock-release step, and the request explicitly puts §9 out of diff scope. As written the contract is internally incomplete: a released project whose lock fd the old process failed to close stays locked with no owner; every subsequent claim fails `ownership_conflict` (holder `null`); no operator command resolves it short of killing the process — a new stuck state the contract never names. Also §9's "same claim primitive" now literally includes lock acquisition, which a releasing owner (already holding) would re-attempt ⇒ EWOULDBLOCK on its own release. | Add a §9 hunk: release closes the session lock fd (releases the session lock, §6.5) and clarifies that release's record rewrite does not re-acquire the already-held lock (close is the release act). |
| F4 | P1 | request 7.2 cross-state re-read rule, 7.2 `paused-unreadable` transition-out cell, 7.4(d) new bullet, 7.4(a) G1.3 | **ENOENT (file deleted) transition during/after pause is unspecified.** The re-read branches enumerate: non-ENOENT failure ⇒ `paused-unreadable`; bytes == `lastWrittenHash` ⇒ gone; other foreign bytes ⇒ fresh cycle — but not ENOENT (file deleted while paused). The fail-closed rule says "ENOENT is the only read result that means absence" without stating what a paused project then does: is pending cleared/unpaused? Is the deletion a fresh detection? What does the next write do against the absent target (W `allowAbsent` semantics)? And G1.3's After gives no snapshot obligation when there are no foreign bytes to snapshot (the current code's `allowAbsent: externalHash === EMPTY_HASH` discard path — write.ts:224-225/735 — is exactly the R1 fabrication this addendum must close). | Add the ENOENT branch to 7.2's cross-state rule and the 7.4(d) bullet: "file absent at re-read ⇒ foreign state gone ⇒ pending cleared, unpaused; absence is a known state — no snapshot is taken (absence is not content; no zero-byte snapshot stands for deletion), prior snapshots (if any) remain the evidence; the next write proceeds as a fresh write on the absent target per §5.2." Add the matching G1.3 clause. |
| F5 | P2 | request 7.3 vs 7.2 table / 7.4(f) row | Wire-shape ambiguity: 7.3 says null fields are "omitted from the wire when null", while the 7.2 query column and the 7.4(f) §11 row write `externalHash: null`, `externalValid: null`. | State exactly one convention (fields present as `null` vs absent on the wire) in one normative place so strict validators are unambiguous. |
| F6 | P2 | request 7.4(b) step 2 (After) | Bytes changing between step-1 read and step-2 snapshot is covered only by cross-reference. "Snapshots B byte-for-byte" binds the snapshot to step 1's in-memory bytes (so the artifact's `sha8` name matches content) and drift is re-detected by §5.2 / 7.4(d) — but that reading is implicit. | One explicit sentence in step 2 After: the snapshot is the bytes read in step 1, never a re-read; a concurrent change in between does not alter the snapshot and is re-detected at the next check. |
| F7 | P2 | request 4.1 (After, §6.2 rows, workspace.md:409–410) | The `absent` row gains "lock held ⇒ `ownership_conflict` (holder `null`)", but the `released` and own-record rows ("claimable: same claim procedure / same procedure") don't mention the new claim-time lock failure. | Add the same lock-held note (or a one-line table footnote) to the `released`/own-record rows for consistency. |

## Mechanism adjudication (section 4 / recommendation (b))

**Outcome: (b) requires re-selection (or a recorded dependency) — not feasible
as specified.** (1a) Evidence: Node v22.22.1; `fs`/`fs.promises` expose zero
lock-related exports; `flock(1)` exists on this host but is unpinned and the
coprocess route violates §4.1 edges and inverts the mechanism's central
crash-safety claim (orphaned holder keeps the lock after backend SIGKILL; the
parent's cleanup handlers never run). (1b) Even with a real flock(2) binding,
§2(b)(iii)'s self-conflict claim is false (per-OFD locking; F2) — the §6.2
own-record row and §6.5 lifecycle bullets contradict the kernel facts as
written. (1c) Residual risks, recorded: **wedged-live owner blocks takeover —
accepted** (contract's operator model is explicit commands on a single host;
the operator can kill the process; strictly safer than today's silent
split-brain; documented in 4.5 After — accepted *conditional on* the native
holder being the backend process itself, see F1). **Hostile lock-file
delete/recreate — accepted** as §7.1 non-claim class (documented in 4.5/4.6;
same exposure class as today's direct ownership-file tampering; degrades
safely via §5.2). **fd-lifetime discipline — accepted as normatively stated**
(4.3 After + 4.6 bullet), but its "until release" half is unenforceable without
the F3 §9 hunk. (1d) Diff completeness: no dangling superseded sentences —
"concurrent claimers converge to exactly one winner" / "without any lock file
or unlink" occur only in §6.3 (fully replaced by 4.3); §10/§12/§8.3
references stay consistent; §9's "same claim primitive" / "holds no lock"
(lines 646, 659) are the two sentences that *do* interact with the new
mechanism and are covered by F3. (1e) R9 acceptance mapping: §5.1 (deterministic
seam interleaving ⇒ exactly one winner, both pause schedules, regression shape),
§5.2 (real two-process file/signal-gated barriers for absent/released/stale;
winner mutation to revision 1 + second mutation anti-flap; loser failure codes),
§5.3 (SIGKILL after record write ⇒ stale, no false liveness, takeover;
SIGKILL between lock and rename ⇒ directly claimable, no operator step;
on-disk evidence assertions) — all three specified; §5.3(b) is satisfiable only
under a native-binding implementation (F1).

## Addendum adjudication (section 7, R1/R3/R16)

**(a) State-table completeness.** (i) file DELETED (ENOENT) during/after
detection: **not stated** — F4 (the flagged gap, confirmed). (ii) bytes change
between pre-write read and snapshot write: contract answer is implicit — step 2
"Snapshots B byte-for-byte" fixes B = step-1 bytes; drift is re-detected by the
§5.2 pre-write check and the 7.4(d) pre-answer re-read (fresh detection
cycle) — acceptable, F6 asks for the explicit sentence. (iii) retry semantics:
**specified** — 7.3 "Read-failure and retry semantics (normative)": the
triggering mutation wrote no record (§7.2 step 5: "No state, no record"), so a
same-`requestId` retry after restored readability is a fresh execution that
re-detects the real bytes and pauses normally (returns
`external_change_unresolved` with the true `pendingChange`, does not apply).
(iv) `paused-snapshot-failed` ⇒ fault cleared ⇒ re-issue: the
re-read-then-snapshot-then-resolve sequence **is** fully specified including
changed-meanwhile bytes (7.4(d) third branch: "other foreign bytes ⇒ the §7.2
protocol re-fires … a fresh detection cycle" — the re-issued resolution does
not complete in the same call; correct fail-closed behavior) — except the
ENOENT branch (F4). **(b) Code semantics.** One new code per state
(`external_change_unreadable` / `external_change_evidence_missing`);
`write_failed`'s `new-undurable`/`previous` explicitly *not* overloaded;
`external_change_unresolved` gains only the specified `snapshotState`
discriminator; `pendingChange` field sets are consistent across 7.2/7.3/7.4
(F5 null-vs-omitted ambiguity aside); §11 rows consistent with 7.3
preconditions. **(c) Verbatim audit.** All 22 "Before" quotes of both diffs
(re-verified independently at HEAD `44f0a49`, content not just anchors): 22/22
present verbatim — no P2. **(d) R16 contract side.** The 7.4(e) pruning change
fixes the probe's `RECOVERY_NEWEST_PRUNED newestRetained:false` failure via
the **current-pending exemption** (the just-created snapshot is exempt while
pending ⇒ retained; same-stamp ties by full file name, stated deterministically
rather than true creation order — acceptable; the review's behavioral
acceptance — newest 16 including the currently pending change survive — is met
without an artifact rename); does not contradict §7.4's retained
"16-oldest pruning" paragraph or the line-83 summary (total cap stays 16; the
exempted snapshot is by construction the newest).

## Evidence (real outputs at HEAD 44f0a49)

```text
$ node --version
v22.22.1
$ node -e "console.log(Object.keys(require('node:fs')).filter(k=>/lock/i.test(k)))"
[]                      # fs.promises: [] likewise — no flock(2) binding
$ command -v flock
/usr/bin/flock          # unpinned OS tool; child_process route barred by deps §4.1

$ git status --short / git rev-parse HEAD / origin/main
M docs/orchestration.md          # pre-existing uncommitted 1-line orchestrator
HEAD 44f0a499bb25eb9209ed5d9ba2181b320c2976f2   log entry (this review step); left untouched
origin/main 87394e3504d21f8168130f40d4ef20a455a5eefd   (nothing pushed)
$ git show --stat af4881c | tail -2    → docs/handoffs/2026-09-18-contract-request.md | 625 +
$ git show --stat 893a2fd | tail -2    → docs/handoffs/2026-09-18-contract-request.md | 498 + 1 -
# both docs-only, single file, claimed scope confirmed

$ npm test (run once)
Test Files  27 passed (27)   Tests  438 passed (438)   Duration 21.30s   exit 0

$ node docs/reviews/2026-09-18-probes.mjs   (disposable ~/.thirdlight-audit-*)
UNREADABLE_OVERWRITE {"pendingHash":"e3b0c44298fc…","snapshotBytes":0,"discard":true,"foreignLost":true}
SNAPSHOT_FAILURE {"error":"external_change_unresolved","discard":true,"snapshots":0,"foreignLost":true}
(+ all other R-lines as recorded)   exit 0; leftover roots: 0

$ esbuild … --outfile=/tmp/tl07-contract-review-44f0a49.mjs && node …   (~/.tl07-focus-*)
CLAIM_RACE {"a":true,"b":true,"bStillOpen":true,"owner":"tb-aaaa…"}
UNREADABLE_OWNER {"result":{"ok":true,…},"firstStillOpen":true}
PROC_EACCES {"query":{…,"reason":"stale_ownership",…},"takeover":{"ok":true,…},"realOwnerStillAlive":true}
RECOVERY_NEWEST_PRUNED {"error":"external_change_unresolved","count":16,"newest":"foreign-8","newestRetained":false,…}
exit 0; leftover roots: 0
# all request-cited probe lines reproduce at this HEAD

# dangling-sentence grep: "concurrent claimers converge" / "without any lock file"
# occur only at workspace.md:434-435 (§6.3 — replaced by hunk 4.3)
# verbatim audit (python, 22 Before-quotes of both diffs): 22 OK, 0 MISS
```

## Scope

Docs-only review: no source, test, contract, or fixture changes; the proposed
diff was NOT applied to `docs/contracts/workspace.md`. Scope discipline of the
request: every hunk maps to R9 (§6.2/§6.3/§6.4/§6.5/§11 ownership rows) or
R1/R3/R16 (§5.5 G1.3, §7.2, §7.3, §7.4, §11 resolution/error rows); §6.3's full
replacement is the defect locus itself; no hunk reaches into unrelated
contract text. Note: one pre-existing uncommitted line in
`docs/orchestration.md` (orchestrator log for this step) was preserved
untouched.

## Next action

Repair round 1 (max 2 per work order) — doc-only fixes to the request document
itself, before any diff is applied to workspace.md: resolve F1 (switch to
mechanism (a)/(c) with the §4 diff redone per the already-drafted §2(a)(iv)
rows, or record the new-dependency decision flagged for the owner), F2
(normative self-reclaim rule + corrected §2(b)(iii)), F3 (add the §9 release
hunk), F4 (ENOENT transition + G1.3 no-foreign-bytes clause); apply F5–F7 as
clarifications. Then independent re-review. Do not start packet 08 or any
implementation under this request until acceptance is recorded.