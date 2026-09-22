# Contract change request — exclusive ownership claim (review finding R9)

**Date:** 2026-09-18 (repair round 1: 2026-09-18)
**Authority:** owner-requested review `docs/reviews/2026-09-18-commits.md`,
finding **R9** (P1, CONTRACT BLOCKER: "rename plus verification does not
establish exclusive ownership"), and its **Suggested orchestration work order,
step 1** ("Record a contract decision for R9's actual exclusivity mechanism").
**Repair history (round 1 — 2026-09-18):** per
`docs/handoffs/2026-09-18-contract-review.md` F1/F2/F3, the mechanism is
re-selected from (b) `flock` to **(a) the epoch-scoped `O_EXCL` claim file
(dep-free)**; the §4 diff and §5 tests are redone for (a); §2(b)/(c) are
retained as evaluated-but-rejected with the review's reasons; the §3
recommendation and §4/§5 are replaced. F4–F7 (section 7) are addressed by a
subsequent repair step.
**Repair history (round 2 — 2026-09-18):** per
`docs/handoffs/2026-09-18-contract-rereview1.md` N1/N2 (P2), pre-record
claim-file verification + residual-state clause (4.3) and non-ENOENT record
read-failure clause (N2) added.
**Scope note:** R9 in full; R1/R3 state addendum to follow as a separate
section (section 7 — untouched in this repair step); nothing else in any
contract changes; no implementation under this request. This is a proposal
for the independent architectural review step — no reviewer approval is
claimed or implied. Working state: HEAD `44f0a49`; uncommitted: the review
file (`docs/handoffs/2026-09-18-contract-review.md`, left untouched) and the
orchestrator log (`docs/orchestration.md`, out of scope); docs only — no
source, test, fixture, or contract-document change.

## 1. The defect (precise)

Current §6.3 defines the claim primitive as `W(our-record, ownership.json)`
(write-temp → rename → directory fsync → verification re-read) plus "on
re-read mismatch, re-evaluate". A deterministic interleaving — not a
probabilistic race — defeats it: claimer **A** reads the record as absent and
pauses immediately before performing its ownership rename; claimer **B**
reads absent, claims, and verifies successfully; **A** resumes, its rename
unconditionally overwrites B's record, and A's verification re-read finds A's
own bytes. **Both opens succeed and both sessions remain open** — two active
writers on one project. This was reproduced as
`CLAIM_RACE {"a":true,"b":true,"bStillOpen":true}` through the public
`WriteOps` seam (`docs/reviews/2026-09-18-path-ownership-probes.ts`: the
seam's `renameFile` hook synchronously runs B's full claim between A's
absent-evaluation and A's rename). Envelope prechecks (§5.2) cannot
arbitrate: both sessions have already loaded the same envelope hash, so both
pass every subsequent write check.

**Why a second re-read or another finite hash check cannot make this
compare-and-swap.** A rename is an *unconditional* replace: it succeeds
regardless of the target's current bytes. A verification re-read (or any
finite number of them, or hash comparisons against observed bytes) only
certifies what the file contained *at the instant of the read*; it asserts
nothing about what a concurrent rename will do next. For any finite protocol
"write, then check n times", the interleaving where the rival renames
immediately after the nth check and before the claimant's next action yields a
false pass. Compare-and-swap requires a single kernel-atomic operation whose
*success* is conditional on current state (create-only-if-absent, or a
kernel-held lock released only by the holder or its death). No number of
post-hoc reads can convert an unconditional write into a conditional one;
the contract's "concurrent claimers converge to exactly one winner" sentence
is a TOCTOU false assertion.

## 2. Mechanism evaluation

Platform: local Linux ext4, self-hosted, single host (contract §2/§12 exclude
network filesystems); the code already has a `procRoot` seam for `/proc`
liveness. For each mechanism: (i) single-winner proof for the §1
interleaving (this request); (ii) SIGKILL crash behavior; (iii)
absent/released/stale transitions; (iv) exact §6.2/§6.3/§6.4/§6.5/§9/§11
text rows added/changed/removed (existing table style); (v) new `WriteOps`
primitives (against the current `WriteOps` at `write.ts:59`); (vi)
operational risks.

### (a) Epoch-scoped atomic claim file (`O_CREAT|O_EXCL`) — recommended (round 1)

The record file is unchanged in content (identity/epoch/openedAt, written
via `W` after the claim). New: a per-epoch claim file
`.thirdlight/claim-<lockEpoch>`, created with `O_CREAT|O_EXCL` (on Node:
`fs.open(path, 'wx')` — `O_WRONLY|O_CREAT|O_EXCL`, the same primitive
`openTempFile` at write.ts:61 already uses); **after** the exclusive create,
the claimer's identity `{ backendId, pid, UTC timestamp }` (canonical
serialization, the record's style) is written into it **durably** (write +
fsync) — a crash before the content write leaves an empty/absent-content
claim file (orphan, below). Claim files are unlinked by the protocol in
exactly two cases — the owner's own release (§9) and the next epoch's
successful claim (superseded-epoch cleanup, (iii) below); a crash orphans
the file (recovered by the orphan-recovery rule). Liveness stays the
conservative unknown⇒live rule for record evaluation. Claim at epoch e =
(1) `open(claim-e, O_CREAT|O_EXCL)` — the exclusive gate; EEXIST ⇒ a
different claimer holds epoch e: re-read the record and re-evaluate
(owned+live ⇒ `ownership_conflict`; owned+dead ⇒ `stale_ownership` — the
takeover path advances to e+1; record absent/released/older-epoch ⇒ the
**orphan-recovery rule** below); (2) stamp the identity into claim-e,
fsync, close; (3) `W` the record (owned, our identity, e); (4)
**verification re-read of both files** — the re-read record must contain
our `backendId`/`pid`/`lockEpoch`, and the re-read claim-e must contain our
step-2 content (`backendId`+`pid`+timestamp match): this re-read closes the
hostile/foreign unlink-recreate race for the claimant that lost its file;
(5) consistency: the re-read record's epoch must be e — while we hold
claim-e and the record's epoch is < e, no protocol write can advance the
record past e−1 (any advance requires a claim at that epoch, which requires
its own claim file; an advance to e requires claim-e itself, which we
exclusively hold), so a foreign epoch ⇒ out-of-protocol tampering ⇒ fail
closed (the claim fails; the claim file is left on disk and is recovered as
described below). Any failure before step 5 completes ⇒ no ownership.

**(i) Single-winner proof.** A and B both read the record absent ⇒ both
target epoch 0 ⇒ both target the *same path* `claim-0`.
`open(O_CREAT|O_EXCL)` is serialized by the kernel (ext4): at most one
caller succeeds. If A pauses before its open: B's open succeeds, B stamps
the content, writes the record (0, B live), and verifies both files; A's
open ⇒ EEXIST ⇒ A re-reads the record (B's owned, live) ⇒
`ownership_conflict`. If A pauses after its own successful open, before the
content write: B's open ⇒ EEXIST; the record is still absent (A mid-claim)
and A's claim-file content is absent/unparseable ⇒ A's holder identity is
unknown ⇒ treated as live ⇒ B fails (`claim_inconsistent`, the liveness
outcome reported) — no claim either way. If A pauses after the content
write, before the record write: B's open ⇒ EEXIST; the record is still
absent; A's content is parseable with A's pid — while A is live, B fails
(`claim_inconsistent`, a live holder mid-claim); only if A is *proven
dead* may B reclaim — and then A is not a live rival (it cannot complete
its claim). In every branch the winner is the unique `O_EXCL` success at
`claim-0` (or the unique reclaimant of a proven-dead holder's file); no
interleaving yields two holders of `claim-0`, and only the holder can write
the record at epoch 0 with a passing two-file verification. ∎

**(ii) SIGKILL crash behavior.** Crash points: (1) before the claim file —
nothing on disk, plain absent. (2) Claim file created, identity content not
(yet) written — claim-e present with absent/unparseable content ⇒ no holder
identity ⇒ unknown ⇒ treated as live ⇒ the next open fails with
`claim_inconsistent` (the documented stuck state; the raw claim-e bytes are
reported as evidence; the operator confirms the holder is dead and removes
the file — an operator file operation, no backend command). (3)
Claim-file content complete, record not (yet) written — **orphan state**:
record absent/older + claim-e present with a holder identity ⇒ the next
claimant at epoch e reclaims once the holder is proven dead
(orphan-recovery rule) and succeeds — no operator step; operator file
resolution only when the liveness outcome is not "dead". (4) After the
record write — the ordinary stale state (record owned, dead pid, claim-e
the consistent pair; the next takeover at e+1 removes claim-e via the
superseded-epoch cleanup).

**(iii) Transitions.** absent ⇒ claim 0 (the claim-0 gate; an existing
claim-0 ⇒ the orphan-recovery rule or `claim_inconsistent`). released-e ⇒
claim e+1 (claim-(e+1) is free; the superseded-epoch cleanup unlinks
claim-e — **safe because** a claim at e+1 occurs only against a record at e
that is released or stale (dead holder): in both cases the session that
created claim-e is no longer an active writer (a released session must not
serve; a dead pid cannot), so claim-e excludes no live writer and removing
it deletes no live claimant's token). owned+live ⇒ `ownership_conflict`.
owned+dead ⇒ `stale_ownership` ⇒ explicit takeover ⇒ e+1 (claim-e unlinked
by the cleanup). Own-record reopen ⇒ **self-reclaim** (not a re-claim): the
session does not re-run `O_EXCL` against its own claim file; it re-verifies
the claim file content matches its identity (`backendId`+`pid`); missing or
foreign content ⇒ `ownership_conflict` (holder `null`) and the session must
not serve. One claim file per epoch ever used; each is removed by the next
successful claim or by the owner's release (round 1 supersedes the original
(a) never-deleted-tombstone rule; a failed best-effort unlink leaves an
inert file no future claim targets — the epoch is monotonic).

**(iv) Rows.**
- §6.2 table: rows `absent`, `released`, and own-record **changed**: claim
  = acquire the claim file (`O_CREAT|O_EXCL`, §6.3) + write the record via
  `W` + verification re-read of the record *and* the claim file;
  claim-file contention/orphan ⇒ the new `claim_inconsistent` code (or
  `ownership_conflict` when a live owner is identified); own-record row:
  the self-reclaim rule (no re-run of `O_EXCL` against the own claim file;
  the content is re-verified against `backendId`+`pid`; missing/foreign ⇒
  `ownership_conflict`, the session must not serve). Liveness block
  **changed**: add the normative bullet — for concurrent claimers liveness
  is reporting/classification only (the `O_EXCL` claim-file creation, §6.3,
  is the only exclusion gate); the one liveness-referenced path is the
  orphan-recovery rule (proceed only on parseable content + a proven-dead
  pid; unknown ⇒ live ⇒ refuse, `claim_inconsistent`) — it reclaims a
  crashed claimant's file and is never a gate on a live rival (a live
  holder's file is never removed by a backend path).
- §6.3: **full replacement** (claim = `O_EXCL` claim-<e> → durable content
  write → `W` record → two-file verification re-read; the O_EXCL
  single-winner statement replaces the falsified "concurrent claimers
  converge" sentence; the orphan-recovery rule, `claim_inconsistent`, and
  the superseded-epoch cleanup are defined here).
- §6.4: procedure step (3) **changed** (claim at e+1 — the
  `O_CREAT|O_EXCL` on `claim-(e+1)` is the single-winner gate; a held claim
  file ⇒ `ownership_conflict`). Residual split-brain bullet **changed**
  (rewritten for (a): the orphan-recovery path is the only
  liveness-referenced path, bounded by unknown⇒live — a misclassification
  can delay or block a reclaim (operator-visible) but cannot create a
  second active writer; hostile unlink/recreate of the claim file or the
  record is the §7.1 non-claim class).
- §6.5: **changed** (claim-file lifecycle: created at claim with the
  identity content; held for the session lifetime — a file, not an fd: its
  existence is the token, no open descriptor is held; released by the
  owner's own unlink at release (§9); superseded-epoch cleanup unlinks
  claim-e at a successful claim at e+1; orphaned at crash; no
  fd-lifetime discipline needed — the advantage over (b)).
- §9: **new hunk** (the F3 fix): the release procedure gains an explicit
  step — after the released record is durably written, unlink the
  claimer's own claim file; no partial release (a failure before the record
  write leaves the project owned with the old session still the writer); a
  crash between the record write and the unlink leaves the documented
  orphan (`released@e` + `claim-e`), recovered by the superseded-epoch
  cleanup of the next claim at e+1; the old session must not issue further
  writes once the released record is durable; the release record write does
  not re-attempt the claim gate.
- §11 operations table: the `releaseWorkspace` outcome row **unchanged**,
  plus the new stuck-state note (the release-crash orphan is auto-recovered
  at e+1; the target-epoch orphan is `claim_inconsistent`, resolved by an
  operator **file operation** — **no new operation**: the original draft's
  `resolveClaimFile(projectId)` command is **not adopted** — fewer contract
  surface; the operator action is documented in the error hint). §11
  error-code table: row **added** `claim_inconsistent` (cls `unavailable`;
  carries `projectId`, the claim file path, the holder content if
  parseable, and the liveness outcome; hint: confirm the holder is dead,
  remove the orphan claim file, re-issue the open); row **changed**
  `ownership_conflict` (holder may be `null` when the claim file exists
  with foreign/absent content); `holder` shape line **changed** (the
  `null` case added).

**(v) New WriteOps primitives: none.** The existing `openTempFile`
(write.ts:61, `O_WRONLY|O_CREAT|O_EXCL` at 0644, throws on EEXIST) *is* the
claim-file gate; `writeAll`/`fsyncFile`/`closeFile` stamp and close the
identity; `removeFile` (write.ts, best-effort unlink, never throws)
performs the release unlink and the superseded-epoch cleanup (a failed
unlink leaves inert residue — the epoch is monotonic, so no future claim
ever targets a lower-epoch claim file; the residue gates nothing). Fault
injection reaches the gate through the existing seam.

**(vi) Operational risks.** **Orphan stuck state (narrower than the
original draft):** a crash between the claim-file create and the content
write leaves an empty claim file; the next open fails with
`claim_inconsistent` until the operator confirms the holder is dead and
removes the file (a new error code + an operator file procedure — failure
modes the current system does not have). A crash *after* the content write
self-recovers: the next claimant reclaims once the holder is proven dead.
**False-dead takeover of a live owner still splits the brain** (the O_EXCL
gate arbitrates only concurrent same-epoch claimers, not a sequential
false-dead takeover of a live holder at a higher epoch — the current §6.4
residual bound persists unchanged; the conservative unknown⇒live rule
bounds it exactly as it bounds the stale path today). NFS: cross-client
`O_CREAT|O_EXCL` is not a reliable atomicity guarantee (M1 excludes network
FS per §2/§12 — consistent, but the mechanism does not port). Two
operators: racing takeovers arbitrate to one winner (EEXIST on
claim-(e+1)), but a confused operator can still take over a live owner
(unblocked — the same bound as today). **Best-effort unlink residue:** a
failed release/cleanup unlink leaves an inert claim file (no future claim
targets the lower epoch) — harmless, documented.

### (b) Advisory exclusive lock (`flock`) held for the session lifetime — evaluated, not adopted (review F1)

> **Evaluated, not adopted (round 1 — review F1/F2).** (1) The requested
> mechanism has no implementation on the pinned toolchain: pinned Node 22
> (host v22.22.1, dependencies.md §7) exposes no flock(2) binding —
> `Object.keys(require('node:fs')).filter(/lock/i)` ⇒ `[]` (review F1's
> recorded evidence) — so the requested `lockExclusiveNonBlocking` default
> has no real implementation. The alternatives are outside the dependency
> pins: a new native flock(2) dependency requires a recorded owner decision
> + a dependencies.md §7 pin (dependencies.md §4.1 `workspace` edges:
> `fs`, `path`, `crypto`, `os`), and a `child_process`-spawned `flock(1)`
> holder violates §4.1 (no `child_process` for `workspace`) and inverts
> the mechanism's central crash-safety claim — the lock is held by the
> *child*, not the backend, so on backend SIGKILL the child is orphaned
> (reparented to init) and **keeps holding the lock** while the parent's
> cleanup handlers never run. (2) Even with a real flock(2) binding, the
> §2(b)(iii) self-conflict claim is false per-OFD: a second
> `open`+`flock(LOCK_EX|LOCK_NB)` on the same path fails with EWOULDBLOCK
> while the first fd is open — *including in the same process* — so any (b)
> contract text would require an explicit fd-reuse self-reclaim rule (the
> session reuses its already-held lock fd; a fresh open that cannot lock ⇒
> `ownership_conflict`), and the unamended §6.2 own-record row would
> self-conflict on its own record. Retained below as the evaluated design;
> see the §3 recorded-alternative note.

The existing record file is unchanged in content (identity/epoch/openedAt,
written via `W` after lock acquisition — an identity/audit layer, **no
longer the arbitration layer**). New: a dedicated per-project lock file
`.thirdlight/lock` (empty file, `O_RDWR|O_CREAT` at 0644, never deleted by
the backend; content carries no meaning). Claim = acquire
`flock(LOCK_EX|LOCK_NB)` on `.thirdlight/lock`, then `W` the record +
verification re-read; the lock fd is held by the owner session for the
**session lifetime**; release (§9) and process death close the fd ⇒ the
kernel releases the lock.

**(i) Single-winner proof.** The exclusivity check is the flock acquisition —
kernel-serialized per inode, and, critically, held for the *session
lifetime*, not per write. Place A's pause at every point of the §1
interleaving: **before** A's flock ⇒ B's flock succeeds and B holds it for
its whole session; A's flock ⇒ EWOULDBLOCK ⇒ A cannot claim, fails with
`ownership_conflict`. **Between** A's flock and A's record rename ⇒ A holds
the lock; B reads the record (absent — A has not renamed yet), B's flock ⇒
EWOULDBLOCK ⇒ B fails. **After** A's rename/verify ⇒ the record shows A live
⇒ B conflicts (or B's flock fails first). The rename no longer arbitrates
anything — it only records identity; the verification re-read is a tamper
check, not a winner check. At most one process holds the exclusive flock on
the inode (flock(2): a concurrent `LOCK_EX` is serialized; a second
`LOCK_EX|LOCK_NB` while held fails with EWOULDBLOCK). No interleaving yields
two owners. ∎

**(ii) SIGKILL crash behavior.** The kernel releases a flock when the
holding process dies (all fds close ⇒ lock released) — **at every crash
point**. Evidence on disk: only the record — either owned + dead pid (the
ordinary stale state) or the previous absent/released state. **No orphan
exclusive state exists**: a dead process cannot hold a flock. Who may write
next: absent/released states are claimable immediately (lock free, no
operator step — as today); owned+dead ⇒ stale ⇒ explicit operator takeover
(unchanged), whose lock acquisition trivially succeeds (kernel-released).

**(iii) Transitions.** absent ⇒ flock (free) + record 0. released-e ⇒ flock +
record e+1. owned+live ⇒ `ownership_conflict` (the live owner holds the
lock). owned+dead ⇒ `stale_ownership` ⇒ explicit takeover: flock (free —
kernel-released) + record e+1. Own-record reopen ⇒ (re)acquire the lock (same
process: the flock transfers to the new fd; no self-conflict) + record
unchanged. No tombstones, no orphan states, no new stuck states.
*(The "no self-conflict" sentence is the F2 error: flock locks are per
open-file-description; the same-process second open+flock fails with
EWOULDBLOCK while the first fd is open. Recorded here for the audit trail.)*

**(iv) Rows.**
- §6.2 table: row `absent` **changed**: "claim (§6.3): acquire the session lock, then write our record (`lockEpoch` 0) via `W` + verification re-read; lock held ⇒ `ownership_conflict` (`holder` = the record's owner, or `null` when the record is absent/unreadable)". Row **added**: none (lock contention is discovered at claim time, not record evaluation). Liveness block **changed**: add one normative bullet — liveness is reporting/classification only; exclusivity is enforced by the kernel-held session lock (§6.3); a liveness error can misclassify but cannot create a second active writer (claim and takeover both require the lock).
- §6.4: procedure bullet **changed** (step (3) note: the claim includes the session-lock acquisition, the single-winner gate; failure line: `ownership_conflict` *including when the session lock is held* — the recorded owner is live or a concurrent takeover completed first — or `stale_ownership` with the fresh holder). Residual split-brain bullet **changed**: racing takeovers yield exactly one winner via the session lock; a takeover of a *live* owner now fails mechanically (the live owner holds the lock for its session lifetime ⇒ `ownership_conflict`) — the false-dead split-brain path is removed; the only remaining split-brain path is a bypassing actor deleting/recreating the lock file from under the owner (§7.1 non-claim class), degrading safely via the §5.2 pre-write check as before.
- §6.5: bullet **added**: the session lock is acquired on claim, held for the owner session's lifetime, released on release (§9) or process death (kernel release on death — no orphan exclusive state); the lock file is never deleted by the backend (a deleted-and-recreated lock file is a different inode — §7.1 non-claim for bypassing writers); the session holds the lock fd open until release, no code path closes it earlier. Owner-crash bullet **changed**: "Owner crash: the kernel releases the session lock; the record persists with a dead pid ⇒ stale ⇒ explicit takeover (…)". Artifact bullet **changed** to cover the lock file.
- §11 operations table: **no rows added/changed/removed** (`takeoverWorkspace`/`releaseWorkspace` keep their signatures and codes; a held-lock failure maps to the existing `ownership_conflict`). §11 error-code table: row **changed**: `ownership_conflict` gains "or the session lock is held" and `holder` may be `null` (the session lock is held but no parseable owned record exists — a concurrent claimer is mid-claim, §6.3).

**(v) New WriteOps primitives** (against the current `WriteOps`, write.ts:59):
- `openLockFile(path: string): number` — open `.thirdlight/lock` with
  `O_RDWR|O_CREAT` at 0644 (no `O_EXCL`: the file persists across owners);
  throws on EACCES/EIO.
- `lockExclusiveNonBlocking(fd: number): void` — `flock(fd,
  LOCK_EX|LOCK_NB)`; throws on EWOULDBLOCK (the claim/takeover fails; never
  blocks).
- Release reuses the existing `closeFile(fd)` (close ⇒ lock released).
  Two new primitives; the record `W` + verification re-read is unchanged.
  *(Review F1: `lockExclusiveNonBlocking` has no real implementation on the
  pinned toolchain — no flock(2) binding in Node 22.22.1 `node:fs`.)*

**(vi) Operational risks.** **Wedged-but-alive owner blocks takeover** — a
live process holds the lock indefinitely; an operator who believes it dead
cannot take over until the process is killed (safer than today, not a
regression: today that same takeover silently splits the brain; the act
becomes a conscious kill-then-takeover). **Hostile lock-file deletion** — a
deleted-and-recreated `.thirdlight/lock` is a different inode: a new claimant
locks a different inode than the live owner ⇒ undetectable split brain (same
class as the current contract's exposure to direct deletion/overwrite of
`ownership.json`; §7.1 non-claim — documented, not solved). NFS: flock over
NFS relies on lockd/delegations and is unreliable (M1 excludes network FS per
§2/§12). Two operators: racing takeovers ⇒ one winner (the kernel lock); a
false-dead takeover is mechanically impossible (lock held) — the operator
sees `ownership_conflict` plus the live holder. **fd lifetime discipline**:
the session must keep the lock fd open for the session lifetime and close it
only on release/session end (a premature close drops the lock while the
record still says owned; the contract states the fd lifetime normatively in
§6.5 — an implementation invariant, same class as the current R4-style
session-state hazards).

### (c) Hybrid: (a) + (b) — evaluated, not adopted (inherits (b)'s rejection)

> **Evaluated, not adopted (round 1 — review F1).** (c) conjuncts the (a)
> gate with the (b) session-lock gate, so it inherits (b)'s rejection in
> full (no flock(2) binding on the pinned toolchain; the per-OFD
> self-conflict error of F2), and it adds (b)'s failure modes (wedged-live
> blocker, fd-lifetime discipline, a second inode to protect) to (a)'s with
> no additional exclusion — the (a) gate alone is already single-winner.
> Retained below as the evaluated design.

Claim = `O_CREAT|O_EXCL` on `claim-<e>` **and** a session-lifetime flock on
`.thirdlight/lock`; both gates must pass; the record is written as in (a);
the claim file provides tombstones/audit; the lock provides kernel
auto-release on death.

**(i) Single-winner proof.** The conjunction of two individually single-winner
gates (O_EXCL per path; flock per inode) is single-winner: no interleaving
passes both gates in two processes. The §1 interleaving fails at the loser's
first gate it reaches (EEXIST or EWOULDBLOCK), as in (a) and (b) above. ∎

**(ii) SIGKILL crash behavior.** The lock auto-releases (no orphan *lock*);
the claim file remains (tombstone + evidence). A crash between claim-file
creation and record write still leaves the (a)-orphan state — the lock is
free, but claim-e blocks the next claim at epoch e ⇒ the (a) operator
resolution is still required.

**(iii) Transitions.** (b)'s transitions plus (a)'s tombstones and orphan
state.

**(iv) Rows.** The union of (a) and (b): §6.2 `absent` row (both gates) +
orphan row (`claim_inconsistent`) + liveness bullet; §6.4 step (3) + orphan
resolution + the improved residual bound (the lock removes the false-dead
path); §6.5 lock bullet + tombstone bullet; §11 `claim_inconsistent` row +
the `ownership_conflict` row change + `holder` line.

**(v) New WriteOps primitives.** `openLockFile` + `lockExclusiveNonBlocking`
(as (b)); the claim-file gate reuses `openTempFile` (as (a)).

**(vi) Operational risks.** The union of both: the orphan stuck state **and**
the wedged-live blocker **and** hostile deletion of either file (two inodes
to protect) **and** the doubled operator-resolution surface. Strictly more
moving parts than (b) with no additional exclusion.

## 3. Recommendation

**Exactly one mechanism: (a) — the epoch-scoped `O_CREAT|O_EXCL` claim
file.**

Justification (≤200 words):

Single-winner: `open(O_CREAT|O_EXCL)` is serialized by the kernel per path —
at most one caller succeeds; in the §1 interleaving the loser fails at its
own O_EXCL (EEXIST) or at the §6.3 verification re-read (the record or
claim-file content is not ours); the record rename arbitrates nothing.
Dep-free: `fs.open(path, 'wx')` is `O_WRONLY|O_CREAT|O_EXCL` on POSIX — the
same primitive `openTempFile` (write.ts:61) already uses; no new `WriteOps`
primitive, no new dependency (dependencies.md §4.1/§7). Crash semantics: a
claim file left without content is a documented stuck state
(`claim_inconsistent`, operator file resolution); an orphan with a
proven-dead holder is reclaimed by the orphan-recovery rule; a crash before
the release unlink is recovered by the superseded-epoch cleanup at e+1. R9
acceptance fit: the seam interleaving ⇒ one winner; two-process barriers
(absent/released/stale) ⇒ one active writer; SIGKILL ⇒ no false liveness
(unknown ⇒ live), and only proven absence/death permits a claim/takeover.
(b)/(c) remain evaluated-but-rejected (§2): the requested flock is not
implementable on the pinned toolchain (review F1/F2).

**Recorded alternative, not adopted.** A native `flock(2)` dependency (an
N-API wrapper) remains a possible *future owner decision*: it would
implement mechanism (b) with kernel auto-release on death and remove the
orphan stuck state. It is **not a pin** and is not adopted or developed
here: adopting it requires a recorded owner decision, a dependencies.md §7
pin and §5.6 check-deps update, and the full failure-mode analysis of
review F1 (holder lifetime, orphaned-holder after SIGKILL, self-reclaim
under per-OFD semantics). Recorded only so the round-1 re-selection to (a)
is traceable.

## 4. Exact contract diff for `docs/contracts/workspace.md`

Before/after blocks. Current text quoted VERBATIM at HEAD `44f0a49` (every
anchor re-verified in this repair step — see §6). **Not applied** in this
step. Section numbers and wording style preserved; minimal — no unrelated
rewrites. Hunk set for mechanism (a): 4.1–4.3 (§6.2/§6.3), 4.4–4.5 (§6.4),
4.6 (§6.5), 4.7 (§9 — the F3 fix, new hunk), 4.8 (§11). Grep of the current
contract for the superseded sentences ("concurrent claimers converge",
"without any lock file or unlink", "exactly one winner"): every occurrence
is at lines 434–435 (§6.3 — fully replaced by hunk 4.3); "the claim
primitive yields one winner" (line 457, §6.4) is replaced by hunk 4.5.

### 4.1 §6.2 — open-time evaluation: rows `absent`, `released`, own-record (lines 408–410)

**Before:**

```
| absent | — | claim: write our record (`lockEpoch` 0) via `W` + verification re-read (§6.3); on re-read mismatch re-evaluate (a concurrent claimer won) |
| `state: "released"` | — | claimable: same claim procedure (`lockEpoch` = previous + 1) |
| `owned`, same `backendId` + `pid` as self | the same process re-opening (e.g. in-memory state was discarded) | claimable (same procedure) |
```

**After:**

```
| absent | — | claim (§6.3): acquire the epoch-0 claim file (`O_CREAT|O_EXCL` on `claim-0`), then write our record (`lockEpoch` 0) via `W` + verification re-read (record *and* claim file); EEXIST ⇒ re-read the record and re-evaluate (owned+live ⇒ `ownership_conflict`; owned+dead ⇒ `stale_ownership`; absent/released/older-epoch ⇒ the §6.3 orphan-recovery rule — reclaim, or `claim_inconsistent`; non-ENOENT record read failure ⇒ never treated as absence — orphan-recovery rule or `claim_inconsistent`) |
| `state: "released"` | — | claimable: same claim procedure (§6.3) at `lockEpoch` = previous + 1 (the gate is `claim-(e+1)`; the superseded-epoch cleanup unlinks `claim-e`, §6.3; claim-file contention or an unresolvable orphan ⇒ `claim_inconsistent`) |
| `owned`, same `backendId` + `pid` as self | the same process re-opening (e.g. in-memory state was discarded) | **self-reclaim, not a re-claim (normative):** the session does not re-run `O_CREAT|O_EXCL` against its own claim file (it would fail EEXIST against itself); it re-verifies the claim file content matches its identity (`backendId` + `pid`); missing or foreign content ⇒ `ownership_conflict` (`holder` `null`) and the session must not serve |
```

(The `live` and `stale` rows are unchanged: "same claim procedure" now
refers to the §6.3 procedure; claim-file contention is discovered at claim
time, not record evaluation.)

### 4.2 §6.2 — liveness rules block (after line 426)

**Before (final bullet, end of the block):**

```
- Present, started before `openedAt`, but cmdline unreadable or mismatched,
  or any error reading `/proc` ⇒ **unknown ⇒ treated as live** (reject; the
  operator investigates). A conservative false "live" costs an operator
  check; a false "dead" costs split-brain risk.
```

**After (same bullet, plus one added bullet):**

```
- Present, started before `openedAt`, but cmdline unreadable or mismatched,
  or any error reading `/proc` ⇒ **unknown ⇒ treated as live** (reject; the
  operator investigates). A conservative false "live" costs an operator
  check; a false "dead" costs split-brain risk.
- **Liveness and the exclusion gate (normative).** For concurrent claimers,
  liveness is reporting and classification only: it selects between
  `ownership_conflict` and `stale_ownership` and what the operator is
  shown. Exclusion never depends on it — the claim file's exclusive
  creation (`O_CREAT|O_EXCL`, §6.3) is the only exclusion gate, and it is
  enforced by the kernel: concurrent claimers are serialized by `O_EXCL`
  alone. The **one** liveness-referenced path is the §6.3 orphan-recovery
  rule: a claimant that finds an existing claim file at its target epoch
  (record absent/released/older-epoch) may proceed only if the file's
  content is parseable and its holder pid is proven dead under the rules
  above (unknown ⇒ live ⇒ refuse, `claim_inconsistent`). That path
  reclaims a *crashed* claimant's file — it is not a liveness safety gate:
  it never arbitrates a live rival (a live holder's claim file is never
  removed or rewritten by any backend path), and a false "live" here can
  only delay or block a reclaim (operator-visible via
  `claim_inconsistent`), never create a second active writer. Only proven
  absence/death permits a claim/takeover: no automatic claim ever depends
  on liveness to beat a live rival, and takeover is an explicit operator
  command.
```

### 4.3 §6.3 — claim primitive (full replacement, lines 428–436)

**Before:**

```
### 6.3 Claim primitive (the only ownership write)

Claim = `W(our-record, ownership.json)` followed by a **verification
re-read**: the on-disk record must contain *our* `backendId`, `pid`, and
`lockEpoch`. If it doesn't, another claimer renamed over us; we re-read and
re-evaluate that record (a live foreign owner ⇒ `ownership_conflict`). The
rename + verify sequence means concurrent claimers converge to exactly one
winner without any lock file or unlink: the loser observes the winner's
live record and aborts.
```

**After:**

```
### 6.3 Claim primitive (the only ownership write)

The exclusive gate is the **epoch-scoped claim file**:
`.thirdlight/claim-<e>`, one per `lockEpoch` e, created with
`O_CREAT|O_EXCL`. The record file (`ownership.json`) is the identity/audit
layer: writing it does not confer ownership, and no read or re-read of it
can arbitrate a claim.

Claim at `lockEpoch` e =

1. **Acquire the claim file** — `open(claim-e, O_CREAT|O_EXCL)` (on Node:
   `fs.open(path, 'wx')` — the same primitive `openTempFile` uses).
   Failure (EEXIST) ⇒ a different claimer holds epoch e: re-read the
   record and re-evaluate: owned + live ⇒ `ownership_conflict`; owned +
   dead ⇒ `stale_ownership` (the takeover path, §6.4); record
   absent/released/older-epoch ⇒ the **orphan-recovery rule** below. There
   is no retry loop. A non-ENOENT record read failure at the re-read is
   never treated as absence — the record's state is unknown; the claim
   proceeds only via the orphan-recovery rule (which requires parseable
   claim-file content and a proven-dead holder) or fails
   `claim_inconsistent`.
2. **Stamp the claim file (durable)** — write the claimer's identity
   `{ backendId, pid, UTC timestamp }` (canonical serialization, the
   record's style) into claim-e and fsync it. A crash before this step
   leaves an empty/absent-content claim file (orphan, below).
3. **Pre-record verification — claim file, by path**: re-read `claim-e`
   by path; its content must equal our step-2 identity (`backendId` +
   `pid` + timestamp match). Foreign, unparseable, or missing content ⇒
   the claim fails with `ownership_conflict` and **no record is written**
   (abort; the session does not serve).
4. **Write the record** via `W(our-record, ownership.json)` (state
   `owned`, our `backendId`/`pid`/`openedAt`, `lockEpoch` e).
5. **Verification re-read — record and claim file**: the on-disk record
   must contain our `backendId`, `pid`, and `lockEpoch`, and the on-disk
   claim-e must contain our step-2 identity (`backendId` + `pid` +
   timestamp match). A mismatch ⇒ a foreign actor unlinked/recreated or
   overwrote one of the files between our `O_EXCL` and this read ⇒ the
   claim fails with `ownership_conflict` and the session does not serve
   (this re-read closes the hostile unlink-recreate race for the claimant
   that lost its file).
6. **Consistency** — the re-read record's `lockEpoch` must be e. While we
   hold claim-e, the record's epoch can only advance through a claim at a
   higher epoch, which requires its own claim file; a re-read showing any
   other epoch ⇒ the record was changed outside the protocol ⇒ fail
   closed: the claim fails (the claim file is left on disk — recovered by
   the orphan-recovery rule or the next epoch's superseded-epoch cleanup)
   and `ownership_conflict` is reported with the fresh holder.

Any failure at steps 2–6 **fails the claim** (the claimant holds no
ownership; its claim file may remain on disk and is recovered as
described below). If the final two-file verification (step 5, after the
record `W`) detects foreign claim-file content, the residual on-disk
state is `record@e` with the claimant's identity + foreign `claim-e`; the
claimant holds no ownership and must not serve; the state resolves via
the §6.2 liveness path (live ⇒ `ownership_conflict` until death; dead ⇒
`stale_ownership` ⇒ e+1 takeover, whose superseded-epoch cleanup removes
`claim-e`); the envelope is untouched.

**Orphan recovery (the only liveness-referenced path, normative):** when
step 1 fails EEXIST and the record is absent/released/older-epoch, the
existing claim-e's content is read. The claimant may proceed (**reclaim**:
rewrite claim-e with its own step-2 identity, fsync, and continue at step
4; steps 5–6 then apply unchanged) **only** if the content is parseable
and its holder pid is proven dead under the §6.2 liveness rules (unknown
⇒ live ⇒ refuse). Otherwise the claim fails with **`claim_inconsistent`**
(holder `null`; carries `projectId`, the claim file path, the holder
content if parseable, and the liveness outcome) — the open fails; the
operator confirms the holder is dead, removes the orphan claim file, and
re-issues the open (an operator file operation — no backend command, §11).
This path consults liveness to reclaim a *crashed* claimant's file; it is
not a safety gate: concurrent claimers are serialized by `O_EXCL` alone,
and a live holder's file is never removed or rewritten by any backend
path.

**Superseded-epoch cleanup (normative):** a successful claim at epoch e+1
unlinks `claim-e` (best effort). This is safe because a claim at e+1
occurs only against a record at e that is `released` or stale (dead
holder): in both cases the session that created claim-e is no longer an
active writer (a released session must not serve; a dead pid cannot), so
claim-e excludes no live writer and its deletion removes no live
claimant's token. A failed unlink leaves inert residue: the epoch is
monotonic, so no future claim ever targets `claim-e` again.

**Single-winner (normative):** `open(O_CREAT|O_EXCL)` is serialized by the
kernel per path — at most one caller succeeds. In the interleaving of §1
(the defect), the loser fails either at its own `O_EXCL` (EEXIST — the
winner created claim-e first) or at the step-3 pre-record verification
or the step-5 verification re-read (the record or claim-file content is
not ours); the record rename arbitrates
nothing. No interleaving of two claimers yields two active owners. A
second re-read or any finite hash check cannot substitute for the
exclusive creation: a post-hoc read certifies only the file's state at
that instant, never that no concurrent rename follows.
```

### 4.4 §6.4 — stale-owner takeover: procedure bullet (lines 448–454)

**Before:**

```
- `takeoverWorkspace` procedure: (1) re-read the record; it must be
  byte-identical to the one that evaluated stale (same holder, same epoch)
  — otherwise re-evaluate from scratch (a concurrent takeover may have
  landed). (2) Evaluate liveness again (it must still be dead). (3) Claim
  (§6.3) with `lockEpoch` = previous + 1. (4) Load the project (§4.3).
  Success result: `{ ok: true, lockEpoch, backendId, pid }`; failure:
  `ownership_conflict` or `stale_ownership` (with the fresh holder).
```

**After:**

```
- `takeoverWorkspace` procedure: (1) re-read the record; it must be
  byte-identical to the one that evaluated stale (same holder, same epoch)
  — otherwise re-evaluate from scratch (a concurrent takeover may have
  landed). (2) Evaluate liveness again (it must still be dead). (3) Claim
  (§6.3) with `lockEpoch` = previous + 1 — the `O_CREAT|O_EXCL` on
  `claim-(e+1)` is the single-winner gate (a held claim file ⇒
  `ownership_conflict` — the recorded owner is live, or a concurrent
  takeover completed first); on success the superseded-epoch cleanup
  unlinks `claim-e`. (4) Load the project (§4.3).
  Success result: `{ ok: true, lockEpoch, backendId, pid }`; failure:
  `ownership_conflict` (including the held-claim-file case above) or
  `stale_ownership` (with the fresh holder).
```

### 4.5 §6.4 — residual split-brain bullet (lines 455–462)

**Before:**

```
- **Residual split-brain (honest bound):** two *simultaneous* takeovers of
  the same dead owner require two simultaneous operator actions; if both
  race, the claim primitive yields one winner (loser sees the winner's live
  record and aborts). The pathological remainder (a backend that believed
  it owned before a record was stolen from under it) degrades safely: its
  next envelope write's pre-write check (§5.2) finds foreign bytes,
  pauses, and snapshots them — no silent corruption of the envelope, and
  both envelopes involved are complete valid documents.
```

**After:**

```
- **Residual split-brain (honest bound):** two *simultaneous* takeovers of
  the same dead owner require two simultaneous operator actions; if both
  race, the `O_CREAT|O_EXCL` on `claim-(e+1)` yields exactly one winner
  (the loser's open fails EEXIST, re-reads the winner's live record, and
  aborts). A takeover of a *live* owner still rests on the same `/proc`
  trust assumptions as the stale path: the conservative unknown⇒live rule
  bounds it — a liveness misclassification can only delay or block a
  reclaim (operator-visible via `claim_inconsistent`), never create a
  second active writer, because a live holder's claim file still exists on
  disk (its `O_EXCL` token), so a concurrent same-epoch claimer never
  passes the gate, and the §6.3 verification re-read catches a foreign
  overwrite of either file. The orphan-recovery path is the only
  liveness-referenced path (§6.3) and is bounded by unknown⇒live. The only
  remaining split-brain path is a bypassing actor that unlinks/recreates
  the claim file or the record from under the owner (§7.1's explicit
  non-claim class, the same exposure as today's direct ownership-file
  tampering): the old owner's next envelope write's pre-write check (§5.2)
  finds foreign bytes, pauses, and snapshots them — no silent corruption
  of the envelope, and both envelopes involved are complete valid
  documents.
```

### 4.6 §6.5 — ownership lifecycle (lines 466–475)

**Before:**

```
- Written on claim (§6.3); rewritten on release with `state: "released"`
  (§9) — **the file is never deleted** (deletion would reintroduce the
  absent-record race).
- Owner crash: record persists with a dead pid ⇒ stale ⇒ explicit takeover
  (the envelope is untouched by any of this; its validity is re-checked at
  the new owner's open).
- The ownership file is a workspace artifact, not authoring data: it is
  excluded from logical reading, from external-change detection (§7
  monitors the envelope only), and from G1's authoring guarantees (its own
  writes use the same `W`, so it is torn-free too).
```

**After:**

```
- Written on claim (§6.3); rewritten on release with `state: "released"`
  (§9) — **the file is never deleted** (deletion would reintroduce the
  absent-record race).
- The claim file (`claim-<e>`, §6.3) is created at claim with the
  claimer's identity content, and is **held for the session lifetime — it
  is a file, not an fd**: a session does not need to hold an open
  descriptor; the file's existence (with its content) is the token. It is
  released at release by the owner's own unlink (§9), superseded by the
  next epoch's successful claim (the superseded-epoch cleanup unlinks
  `claim-e`, §6.3), and orphaned by a crash (recovered by the §6.3
  orphan-recovery rule or the next epoch's cleanup). No fd-lifetime
  discipline is needed — there is no descriptor to close early and drop
  the token (the advantage over a session-lifetime lock fd).
- Owner crash: the claim file persists (orphan, or a consistent pair with
  the stale record); the record persists with a dead pid ⇒ stale ⇒
  explicit takeover (the envelope is untouched by any of this; its
  validity is re-checked at the new owner's open; the takeover's
  superseded-epoch cleanup removes the old claim file).
- The ownership file and the claim files are workspace artifacts, not
  authoring data: they are excluded from logical reading, from
  external-change detection (§7 monitors the envelope only), and from
  G1's authoring guarantees (the record's own writes use the same `W`, so
  it is torn-free too; claim-file writes are the §6.3 identity stamp).
```

### 4.7 §9 — release procedure (NEW hunk — the F3 fix)

**4.7a. Step 1 effect list (lines 644–651).**

**Before:**

```
   - The current state is already durable (every command acked ⇒ written,
     §5.3); the backend rewrites the envelope via `W` with the **same
     scene and revision but `retry.records: []`** (a lost-ack retry of a
     pre-release command must not replay across the boundary — it will
     instead fail `revision_conflict` if stale, which is safe), then
   - rewrites the ownership record with `state: "released"` (same claim
     primitive), and
   - discards in-memory state (history and record map).
```

**After:**

```
   - The current state is already durable (every command acked ⇒ written,
     §5.3); the backend rewrites the envelope via `W` with the **same
     scene and revision but `retry.records: []`** (a lost-ack retry of a
     pre-release command must not replay across the boundary — it will
     instead fail `revision_conflict` if stale, which is safe), then
   - rewrites the ownership record with `state: "released"` via `W` — the
     release record write does **not** re-attempt the §6.3 claim gate
     (no `O_CREAT|O_EXCL`): the owner already holds its claim file, and
     the gate is for claimants, not for the releasing owner, then
   - **unlinks the owner's own claim file** (`claim-<e>`, §6.5), and
   - discards in-memory state (history and record map).
   A release that fails before the record write leaves the project owned
   with the old session still the writer — no partial release. A crash
   between the record write and the unlink leaves the documented orphan
   (`released@e` + `claim-e`), recovered by the next claim's
   superseded-epoch cleanup at `e+1` (§6.3/§6.5). Once the released
   record is durable, the old session **must not issue further writes**
   (its in-memory state is discarded in the same procedure; any later
   command is a fresh open — step 3 — not a continuation of the released
   session).
```

**4.7b. Step 2 sentence (lines 659–660) — the "lock" wording no longer
applies (mechanism (a) has no lock).**

**Before:**

```
   and holds no lock — the released record is what lets a later open claim
   the project.
```

**After:**

```
   and holds no claim file — the released record is what lets a later open
   claim the project.
```

### 4.8 §11 — operations and error codes

**Operations table (lines 691–697): no rows added/changed/removed.**
`takeoverWorkspace`/`releaseWorkspace` keep their kind, success results,
and failure codes — the new states map to the codes below. One new
**stuck-state note** (added after the table):

**Before:**

```
(Transport/auth for these operator commands is packet 09; in M1 they are
admin-scoped — never exposed as browser/MCP mutation commands.)
```

**After (original paragraph unchanged; one paragraph added):**

```
(Transport/auth for these operator commands is packet 09; in M1 they are
admin-scoped — never exposed as browser/MCP mutation commands.)

Stuck states and their resolution: a release that crashes after the
released-record write but before the claim-file unlink (§9) leaves the
documented orphan `released@e + claim-e` — recovered automatically by the
next claim at `e+1` (superseded-epoch cleanup, §6.3): no new failure
code, no operator step. An orphan claim file at the *target* epoch (a
crash between claim-file creation and content write) fails the open with
`claim_inconsistent` — resolved by an operator **file operation**
(confirm the holder is dead, remove the orphan claim file, re-issue the
open). **No new operation:** orphan resolution is deliberately not a
backend command — the original draft's `resolveClaimFile(projectId)` is
**not adopted** (fewer contract surface; the operator action is
documented in the error hint).
```

**Error-code table, row `ownership_conflict` (line 713).**

**Before:**

```
| `ownership_conflict` | live owner holds the project (§6.2; carries `holder`) |
```

**After:**

```
| `ownership_conflict` | live owner holds the project, or the claim file exists with foreign/absent content at the target epoch — incl. the self-reclaim refusal (§6.2/§6.3); carries `holder`, `null` when no parseable owned record exists |
```

**Error-code table — new row `claim_inconsistent` (inserted after the
`ownership_conflict` row, line 713; existing style).**

```
| `claim_inconsistent` | claim file exists at the target epoch but cannot be reclaimed: content unparseable, or holder pid not proven dead (§6.3 orphan recovery); `cls: "unavailable"`; carries `projectId`, the claim file path, the holder content if parseable, and the liveness outcome; hint: confirm the holder is dead, remove the orphan claim file, and re-issue the open (operator file operation — no backend command) |
```

**`holder` shape line (lines 728–729).**

**Before:**

```
`holder` in ownership errors: `{ backendId, pid, openedAt, lockEpoch,
state }`.
```

**After:**

```
`holder` in ownership errors: `{ backendId, pid, openedAt, lockEpoch,
state }`, or `null` (no parseable owned record — the claim file exists
with foreign/absent content, §6.3, incl. the self-reclaim refusal, §6.2).
```

## 5. Mandatory implementation tests implied by the mechanism

For the later implementation step (after the contract diff is accepted and
the architectural gate reopens). All tests assert against real on-disk
bytes on the pinned host; fault/crash timing is injected through the public
`WriteOps` seam (the `openTempFile` gate) and real `SIGKILL` of real
processes — mocks alone do not establish integration success.

1. **Deterministic seam interleaving through the public `WriteOps` (the
   `O_EXCL` hook) ⇒ exactly one winner.** Retain the §1 interleaving
   through the seam's `openTempFile` hook: (a) A passes the
   `O_CREAT|O_EXCL` on `claim-0`, then the hook runs B's full claim before
   A writes its content ⇒ B's `openTempFile` fails EEXIST, B re-reads the
   record (A's, live) ⇒ B's open fails `ownership_conflict` with `holder`
   = A's identity; A stamps + writes + verifies ⇒ A owns. (b) The inverse
   schedule: A pauses after its successful `O_EXCL`, before its content
   write; B attempts ⇒ B's `openTempFile` fails EEXIST; the record is
   absent and A's claim-file content is absent/unparseable ⇒ B fails
   `claim_inconsistent` (holder `null`, the liveness outcome reported); A
   completes ⇒ A owns. (c) A completes fully before B attempts ⇒ B's
   `openTempFile` fails EEXIST, the record is A's (live) ⇒ B fails
   `ownership_conflict` (holder = A). Assert in every schedule: exactly one
   `ok:true` open; the on-disk record is the winner's; the loser session is
   not open and its mutation is refused end-to-end (never both-opens-true:
   the probe's `CLAIM_RACE {a:true,b:true}` shape becomes the failing
   regression — expected `{a:true,b:false}` or `{a:false,b:true}`).
2. **Real two-process barrier tests** (two node processes, gated by a
   file/signal so both act after the gate; a shared disposable root; not
   mocks): for each of the **absent claim** (fresh project, record absent),
   the **released claim** (owner released), and the **stale claim** (owner
   SIGKILLed, then both processes issue `takeoverWorkspace` after the gate)
   — exactly one active writer: the winner's claim/takeover succeeds and its
   mutation reaches revision 1 (a second mutation confirms the claim did not
   flap); the loser's open fails (`ownership_conflict` /
   `stale_ownership`), and a concurrent mutation issued from the loser is
   refused end-to-end; the on-disk record and claim files are the winner's.
3. **SIGKILL crash tests** (real processes, `kill -9` at gated points):
   (a) Kill between the `O_EXCL` and the content write ⇒ an empty orphan
   `claim-e` ⇒ the next claim ⇒ `claim_inconsistent` (content unparseable,
   holder `null`, the liveness outcome reported) — the documented stuck
   state; after the operator removes the orphan file, the re-issued open
   succeeds. (b) Kill after the content write (before the record write) ⇒
   an orphan with a dead pid ⇒ the next claim reclaims (the holder is proven
   dead under the §6.2 rules) and succeeds — no operator step. (c) Kill
   mid-record-write after the claim ⇒ the record is absent (or stale at the
   previous epoch) ⇒ the normal claim path (reclaim or fresh claim)
   succeeds. After each crash, assert the on-disk evidence (record bytes,
   claim files) as defined by §6.3/§6.5 — nothing else.
4. **Release crash.** Kill between the released-record write and the
   claim-file unlink ⇒ on disk: `released@e` + `claim-e` ⇒ the next claim at
   `e+1` unlinks the superseded `claim-e` (the superseded-epoch cleanup) and
   succeeds; assert the residue (no `claim-e`) and exactly one active
   writer.
5. **Self-reclaim.** A same-process reopen of its own owned record does not
   fail on its own claim file (no self-conflict; the record is unchanged;
   the session serves). Tampered/foreign claim-file content (the content
   rewritten to a different `backendId`/`pid`, or the file deleted) ⇒ the
   reopen fails with `ownership_conflict` (holder `null`) and the session
   refuses to serve — a mutation from it is refused end-to-end.
6. **Hostile unlink-recreate.** A foreign process unlinks and recreates
   `claim-e` with foreign content between our `O_EXCL` and our record write
   ⇒ our §6.3 step-3 pre-record verification — or, if the foreign content
   lands after that check, the step-5 final verification re-read (record +
   claim file) — finds the claim file's content is not ours ⇒ the claim
   aborts with `ownership_conflict` — no double writer (the hostile actor
   completed no claim; exactly zero active writers until a clean claim
   succeeds).

## 6. Verification and provenance

Commands actually run at HEAD `44f0a49` (tree clean except the uncommitted
review file and the orchestrator log), docs-only repair step. Sections 1–6
reworked for mechanism (a); section 7 untouched (byte-identical — the
section-7 tail, line 627 to EOF, diffed before/after the rewrite: identical,
md5 `3563255b162d8d0b85f46a1a7c4df97b` both sides); no contract applied; no
push.

**1. Working state (before the rewrite):**

```
$ git status --short
 M docs/orchestration.md          # pre-existing uncommitted orchestrator log — left untouched
?? docs/handoffs/2026-09-18-contract-review.md
$ git rev-parse HEAD
44f0a499bb25eb9209ed5d9ba2181b320c2976f2
$ node --version
v22.22.1
```

**2. `O_EXCL` gate probe (disposable /tmp; verifies the mechanism (a)
primitive on the pinned host — two sequential opens, the second must fail
EEXIST):**

```
$ node -e 'const fs=require("node:fs");const p="/tmp/tl-oexcl-"+process.pid;try{fs.openSync(p,"wx",0o644);console.log("first open: created")}catch(e){console.log("first open FAILED:",e.code)};try{fs.openSync(p,"wx",0o644);console.log("second open: UNEXPECTED success")}catch(e){console.log("second open: rejected",e.code)};fs.rmSync(p)'
first open: created
second open: rejected EEXIST
exit 0
```

**3. Verbatim-anchor verification (every §4 "Before" block must appear
verbatim in the current `docs/contracts/workspace.md`; disposable python3
script over the reworked document):**

```
$ python3 /tmp/tl-anchor-check.py docs/handoffs/2026-09-18-contract-request.md docs/contracts/workspace.md
4.1 rows absent/released/own-record (408-410): OK
4.2 liveness final bullet (423-426): OK
4.3 §6.3 claim primitive (428-436): OK
4.4 §6.4 procedure bullet (448-454): OK
4.5 §6.4 residual bullet (455-462): OK
4.6 §6.5 lifecycle bullets (466-475): OK
4.7a §9 step-1 effect list (644-651): OK
4.7b §9 step-2 sentence (659-660): OK
4.8 §11 transport note (699-700): OK
4.8 §11 ownership_conflict row (713): OK
4.8 §11 holder shape line (728-729): OK
11/11 OK, 0 MISS
```

**4. Full test suite** (baseline only):

```
$ npm test
> vitest run

 RUN  v5.0.1 /home/dadmin/projects/thirdlight

 Test Files  27 passed (27)
      Tests  438 passed (438)
   Duration  21.34s (tests 93%, import 4%, transform 3%)
exit 0
```

Baseline only (as the review states: the green suite does not cover R9; no
two-process race test exists yet — that is required by §5 above). No other
verification is claimed for this docs-only step; no visual/browser check is
involved. No new dependencies installed; nothing pushed.

---

*Proposal for the independent architectural review step (work order step 1:
reopen packet 07/Gate B, record the contract decision, review before
implementing). No reviewer approval is claimed or implied by this document.*

## 7. Addendum — R1/R3: unknown-I/O and evidence-failure states (2026-09-18 review)

**Scope:** work-order step 1 for findings **R1** and **R3** (plus R16's
contract-side aspect) of `docs/reviews/2026-09-18-commits.md`: "Record a
contract decision for … R1/R3's unknown-I/O/evidence-failure states. Review
any needed error/state/artifact changes before implementation." This section
records DECISIONS and a proposed contract diff for the independent review
step — no reviewer approval is claimed. Sections 1–6 (the R9 mechanism) are
final and unchanged. All line anchors below were verified verbatim against
`docs/contracts/workspace.md` and the source files at HEAD `af4881c` (clean
tree). No source, test, fixture, or contract change under this request.

### 7.1 Defect summary (current behavior, with file:line evidence)

**R1 — every read failure is classified as absence.** `writeAtomic`'s
pre-write check swallows *every* read error into `null` (absence):
`write.ts:212–217` (`try { pre = ops.readFile(target) } catch { pre = null;
}`); `write.ts:224–225` (`pre === null` ⇒ `ok = allowAbsent`);
`write.ts:233–234` (mismatch ⇒ `external { bytes: pre ?? EMPTY_BYTES, ... }`
— for an unreadable file this manufactures **zero bytes** carrying the
SHA-256 of the empty string; `EMPTY_BYTES`/`EMPTY_HASH`, `write.ts:47–48`).
The final post-retry classification does the same: `write.ts:279–284`
(read failure ⇒ `onDisk = null`) and `write.ts:300–303` (target "existed
before" ⇒ `external { EMPTY_BYTES, EMPTY_HASH }` — a fabricated deletion).
Downstream, the discard path passes
`allowAbsent: pc.externalHash === EMPTY_HASH` (`session.ts:735`, in the
write at `session.ts:730–738`), so the same EACCES read is again treated as
absence, the pre-check passes, and the rename **destroys the unreadable
foreign file**. Evidence (real permissions, unprivileged user, retained
probe): `UNREADABLE_OVERWRITE {"pendingHash":"e3b0c44298fc…","snapshotBytes":0,
"discard":true,"foreignLost":true}` — `e3b0c442…` is the SHA-256 of empty
content; the "snapshot" holds zero bytes and discard overwrote the foreign
content. This discard path — `allowAbsent: externalHash === EMPTY_HASH`
(`write.ts:224–225`; the call site at `session.ts:735`) — plus the R1
zero-byte snapshot above (probe line `UNREADABLE_OVERWRITE
pendingHash=e3b0c4…` = SHA-256 of empty content) is exactly the
fabrication this addendum closes.

**R3 — a failed recovery snapshot is ignored; discard can succeed with zero
evidence.** `detectExternalChange` discards the snapshot result:
`session.ts:593` (`snapshotForeignBytes(...)` — the `string | null` return
is dropped); the pending change + pause are then set unconditionally
(`session.ts:621–626`). `snapshotForeignBytes` returns `null` on any
`ensureDir`/write failure (`recovery.ts:48–60`), and its JSDoc
(`recovery.ts:40–47`) claims "a write failure here is reported by the
caller via the write_failed/external outcomes of the triggering command" —
the caller reports nothing; the pause proceeds as if the snapshot succeeded.
Evidence (ENOSPC on recovery-file creation via the public `WriteOps` seam):
`SNAPSHOT_FAILURE {"error":"external_change_unresolved","discard":true,
"snapshots":0,"foreignLost":true}` — the ordinary unresolved code, no
evidence-failure signal, and discard destroyed the only foreign bytes on
disk with zero snapshots. This contradicts G1.3 (`workspace.md:343–346` —
"SHA-256-snapshotted into `.thirdlight/recovery/` before the project
pauses"), §7.2 step 2 (normative snapshot before the pause,
`workspace.md:507–511`), and §7.4 (snapshots are the evidence).

**R16's contract-side aspect.** §7.2 step 2 (`workspace.md:507–511`) says
"oldest pruned to keep 16", but the artifact name is
`scene-<UTCstamp>-<sha8>.json` and `pruneSnapshots` (`recovery.ts:105–115`)
sorts names lexicographically, so within one second the "newest first" order
is by `<sha8>` — **hash, not age** — and nothing exempts the snapshot of the
current pending change. Review-recorded probe: `RECOVERY_NEWEST_PRUNED
newestRetained:false` (path-ownership probe; not re-run in this step).

### 7.2 The decision: external-change pipeline state table

A detected external change is in exactly one of three states (normative):

| State | Meaning |
|---|---|
| `paused-snapshotted` | the foreign bytes `B` were read and ≥1 durable snapshot of exactly those bytes exists (today's §7.2 behavior, named) |
| `paused-unreadable` | the read failed with a **non-ENOENT** error (EACCES, EIO, ENOSPC, …); the on-disk bytes are **unknown** — not absent, not empty |
| `paused-snapshot-failed` | the bytes were read (and validated) but no snapshot is durable (the snapshot write failed) |

Per-state behavior:

| State | Triggering mutation returns | `acceptExternalState` | `discardExternalState` | Queries show | Transition out (exact) |
|---|---|---|---|---|---|
| `paused-snapshotted` | `external_change_unresolved` (carries `pendingChange`, `snapshotState: "ok"`); the mutation is not applied | if `externalValid`: success `{ ok: true, revision, historyReset: true, retryCleared: true }`; if invalid: `external_change_invalid` | success `{ ok: true, revision, historyReset: true }` | `writePaused: true`; `pendingChange { snapshotState: "ok", externalHash: sha256(B), externalValid, externalErrors }` | operator resolution completes ⇒ pending cleared, unpaused; a new foreign write ⇒ a fresh detection cycle |
| `paused-unreadable` | `external_change_unreadable` (§7.3); the mutation is not applied; **no snapshot exists** (certainly no zero-byte one) | `external_change_unreadable` (refused; nothing written) | `external_change_unreadable` (refused; nothing written) | `writePaused: true`; `pendingChange { snapshotState: "unreadable", externalHash: null, externalValid: null, externalErrors: null }` | operator restores readability ⇒ backend re-reads on the next command (mutation or resolution) ⇒ the real bytes are snapshotted + validated ⇒ `paused-snapshotted` ⇒ normal resolution. (If the restored bytes equal `lastWrittenHash`, the foreign state is gone: pending cleared, unpaused.) |
| `paused-snapshot-failed` | `external_change_unresolved` with `pendingChange.snapshotState: "snapshot_failed"` (bytes were read and validated; the evidence gap is reported, not silent); the mutation is not applied | `external_change_evidence_missing` (refused; nothing written) | `external_change_evidence_missing` (refused; nothing written) | `writePaused: true`; `pendingChange { snapshotState: "snapshot_failed", externalHash: sha256(B), externalValid, externalErrors }` | fault cleared ⇒ operator re-issues accept/discard (or any command) ⇒ re-read confirms the unchanged pending bytes (hash == `externalHash`) ⇒ the snapshot is (re)taken and is durable ⇒ `paused-snapshotted` ⇒ the re-issued resolution completes in the same call |

(From **any** paused state, file absent at the cross-state re-read (ENOENT)
⇒ pending cleared, unpaused — in addition to each row's restore-readability
/ fault-cleared paths above.)

Cross-state re-read rules (while paused, every command — mutations and both
resolutions — re-reads the target before acting): file absent at re-read
(ENOENT) ⇒ the foreign state is gone ⇒ pending cleared, unpaused — absence
is a known state (ENOENT is the only read result that means absence); no
snapshot is taken because there is no foreign content to preserve (a
zero-byte snapshot must never stand for deletion); snapshots taken in the
same detection cycle, if any, remain the evidence; the next write proceeds
as a fresh write on the absent target per §5.2; non-ENOENT read failure ⇒
(re)enter `paused-unreadable`, return `external_change_unreadable`; bytes
== `lastWrittenHash` ⇒ the foreign state is gone ⇒ pending cleared,
unpaused (a re-issued resolution then finds nothing pending ⇒
`no_pending_change`); other foreign bytes ⇒ a fresh detection cycle (the
pending change is replaced, a new snapshot is attempted). Dedup replays and
queries are unaffected by the state (pure reads); the query `workspace`
block carries the state's `pendingChange` shape.

**Fail-closed rule (normative):** while the exact foreign bytes are not
durably snapshotted, NO destructive resolution (accept/discard) is
permitted and no replacement write may be based on a failed read. ENOENT is
the only read result that means absence; any other read error means the
on-disk bytes are **unknown**, and unknown bytes are never snapshotted,
hashed, validated, or overwritten — they are reported as
`paused-unreadable`. A failed snapshot (bytes known but not durable)
likewise refuses both resolutions until the snapshot is durable.

### 7.3 Error semantics decision

Exactly one new code per new state. `write_failed`
(`onDiskState: "new-undurable" | "previous"`) is **not** overloaded for
these: those classify the on-disk state after a failed *write* attempt,
while these are *read/evidence* failures, and R1's repair explicitly forbids
falsely reporting `previous`/`new-undurable` here.

- **`paused-unreadable` ⇒ `external_change_unreadable`** — `cls:
  "unavailable"` (operator-gated state, the same class as
  `external_change_unresolved`; not `validation` — no operator precondition
  is wrong — not `internal` — the I/O fault is external to the backend).
  Field set (key order per the `errors.ts` convention: `code`, `cls`, then
  code-specific, `message`/`hint` last):
  - `code: "external_change_unreadable"`, `cls: "unavailable"`,
    `projectId: <string>`, `snapshotState: "unreadable"`,
    `pendingChange: { snapshotState: "unreadable", externalHash: null,
    externalValid: null, externalErrors: null }`
  - `message: "the scene file could not be read (a read error other than
    absence); the on-disk bytes are unknown and no snapshot exists"`
  - `hint: "restore read access to scenes/main.json (permissions or I/O),
    then re-issue; the file is left untouched and writes stay paused"`
  Returned by the triggering mutation whose read failed, and by both
  accept/discard while `paused-unreadable`.
- **`paused-snapshot-failed` ⇒ `external_change_evidence_missing`** —
  `cls: "unavailable"` (a pause awaiting operator action, not an internal
  invariant breach). Field set:
  - `code: "external_change_evidence_missing"`, `cls: "unavailable"`,
    `projectId: <string>`, `snapshotState: "snapshot_failed"`,
    `pendingChange: { snapshotState: "snapshot_failed", externalHash:
    sha256(B), externalValid, externalErrors }`
  - `message: "the pending external change has no durable recovery
    snapshot; destructive resolution is refused (G1.3)"`
  - `hint: "clear the recovery-directory fault (space, permissions, I/O),
    then re-issue; the snapshot is retried and, once durable, the
    resolution proceeds"`
  Returned by `acceptExternalState` and `discardExternalState` while
  `paused-snapshot-failed`. The triggering mutation for this state keeps
  returning `external_change_unresolved` (the bytes were read and
  validated; the pause report is unchanged) carrying the new
  `snapshotState` discriminator — the state is unambiguous without a third
  code and without overloading any existing one.

**`pendingChange` shape change (normative):** the pending-change state
(§7.2 step 4) and the `pendingChange` carried by external-change errors and
queries gain `snapshotState: "ok" | "unreadable" | "snapshot_failed"`;
when `snapshotState` is `"unreadable"`, `externalHash` is `null` and
`externalValid`/`externalErrors` are null. **Wire shape (normative — one
convention):** the `pendingChange` fields `externalHash` / `externalValid`
/ `externalErrors` are present as `null` on the wire when the state makes
them inapplicable — strict validators must accept `null` in those
positions — and the fields are never omitted. `external_change_unresolved`
gains the same `snapshotState` discriminator (values `"ok"` or
`"snapshot_failed"`). No other error changes; the ownership `holder` shape
is untouched.

**Read-failure and retry semantics (normative):** a mutation whose pre-write
or post-write-classification READ fails (non-ENOENT) returns
`external_change_unreadable` — never `external_change_unresolved` with a
fabricated empty hash, and never a zero-byte or deletion snapshot. A retry
of the same mutation after the operator restores readability re-detects the
real bytes, snapshots them, and proceeds through the normal pause/resolution
path (the retry now returns `external_change_unresolved` with the true
`pendingChange` and does not apply the mutation); the same read-then-resolve
rule applies to a re-issued accept/discard.

### 7.4 Exact contract diff for `docs/contracts/workspace.md`

Before/after blocks in the style of section 4. Current text quoted VERBATIM
at HEAD `af4881c` (every anchor verified against the file at this HEAD).
**Not applied** in this step. Line numbers are the verified current anchors.

#### 7.4(a) §5.5 G1.3 (line 343) — snapshot-before-destructive-resolution becomes normative; failure behavior named

**Before:**

````
3. **No silent loss of foreign bytes:** any on-disk content the backend did
   not write is SHA-256-snapshotted into `.thirdlight/recovery/` before the
   project pauses (§7), and the original file is never overwritten until an
   operator explicitly resolves (accept/discard).
````

**After:**

````
3. **No silent loss of foreign bytes:** any on-disk content the backend did
   not write is SHA-256-snapshotted into `.thirdlight/recovery/` before the
   project pauses (§7), and the original file is never overwritten until an
   operator explicitly resolves (accept/discard). A durable snapshot of the
   exact foreign bytes is a **precondition of every destructive resolution**
   (normative): while it is missing, accept/discard are refused
   (`external_change_unreadable` / `external_change_evidence_missing`, §11).
   A read failure other than ENOENT means the bytes are **unknown, never
   absent**: the project pauses in `paused-unreadable` (§7.2) and no
   zero-byte or fabricated snapshot may stand for the real content. A
   failed snapshot write pauses in `paused-snapshot-failed` (§7.2) and is
   reported by the triggering command and the queries — never silent.
   Where the foreign file is absent (ENOENT), there is no foreign content
   to snapshot (absence is a known, non-destructive state): the pending
   change is cleared and the project unpaused without any snapshot — the
   snapshot precondition above binds to the foreign **bytes**, not to the
   paused state.
````

#### 7.4(b) §7.2 steps 1–2 (lines 506–511) and the step-4 shape line (lines 516–517, forced by 7.3)

**Before (steps 1–2):**

````
1. Reads the on-disk bytes `B`; computes `sha256(B)`.
2. **Snapshots** `B` byte-for-byte to
   `.thirdlight/recovery/scene-<UTCstamp>-<sha8>.json`
   (`UTCstamp` = `YYYYMMDDTHHMMSSZ`; `sha8` = first 8 hex of the hash;
   oldest pruned to keep 16). The original file is left **in place** —
   it is not overwritten or "fixed" until an operator resolves.
````

**After:**

````
1. Reads the on-disk bytes `B`; computes `sha256(B)`. **A read failure
   other than ENOENT is not absence (normative):** the bytes are unknown,
   not empty. The project pauses in `paused-unreadable` and the triggering
   mutation returns `external_change_unreadable` (§11) — never
   `external_change_unresolved` with a fabricated hash, and never a
   zero-byte snapshot. ENOENT is the only read result that means absence.
2. **Snapshots** `B` byte-for-byte to
   `.thirdlight/recovery/scene-<UTCstamp>-<sha8>.json`
   (`UTCstamp` = `YYYYMMDDTHHMMSSZ`; `sha8` = first 8 hex of the hash;
   pruning per §7.4). The original file is left **in place** —
   it is not overwritten or "fixed" until an operator resolves.
   **Byte-binding (normative):** the snapshot is the bytes read in step 1
   (in memory), never a re-read of the target; the artifact's `sha8` name
   therefore matches the snapshot content; a concurrent change between
   step 1 and step 2 does not alter the snapshot and is re-detected at the
   next §5.2 check / 7.4(d) re-read.
   **If the snapshot cannot be written (normative):** the project pauses in
   `paused-snapshot-failed`; the triggering mutation returns
   `external_change_unresolved` with `pendingChange.snapshotState =
   "snapshot_failed"`, and accept/discard are refused with
   `external_change_evidence_missing` (§7.3/§11) until the snapshot is
   durably written.
````

**Before (step 4, lines 516–517):**

````
4. Sets the project's **pending change** state `{ externalHash, externalValid,
   externalErrors }` and **pauses writes**:
````

**After:**

````
4. Sets the project's **pending change** state `{ snapshotState, externalHash,
   externalValid, externalErrors }` and **pauses writes** (`snapshotState`:
   `"ok"` — the step-2 snapshot is durable; `"snapshot_failed"` — the bytes
   were read and validated but no snapshot is durable; `"unreadable"` —
   step 1 failed with a non-ENOENT error, in which case `externalHash` is
   `null` and `externalValid`/`externalErrors` are null):
````

(The remaining step-4 bullets, unchanged, apply as written in the
`paused-snapshotted` state; for the other two states the step 1/2 results
above and the §7.3 refusal bullet govern. The "oldest pruned to keep 16"
wording moves to §7.4 as diffed in 7.4(e).)

#### 7.4(c) §7.2 invalid-bytes paragraph (lines 526–530) — minimal adjustment, forced by 7.3

**Before:**

````
**Invalid external bytes** (e.g. a corrupted or mid-edit file): the
validation errors are reported through `pendingChange`, and only
`discardExternalState` is possible (accepting invalid data is refused with
`external_change_invalid`). The bytes are retained for repair; the project
stays paused.
````

**After:**

````
**Invalid external bytes** (e.g. a corrupted or mid-edit file): the
validation errors are reported through `pendingChange`, and only
`discardExternalState` is possible (accepting invalid data is refused with
`external_change_invalid`); both resolutions remain subject to the §7.3
evidence precondition (when unmet, the command reports
`external_change_unreadable` / `external_change_evidence_missing` and
nothing is written). The bytes are retained for repair; the project
stays paused.
````

#### 7.4(d) §7.3 both precondition lines (lines 534–535, 547–548) + new refusal bullet

**Before (accept):**

````
- **`acceptExternalState(projectId)`** — precondition: a pending change
  exists and `externalValid` is true.
````

**After (accept):**

````
- **`acceptExternalState(projectId)`** — precondition: a pending change
  exists, `snapshotState` is `"ok"`, and `externalValid` is true.
````

**Before (discard):**

````
- **`discardExternalState(projectId)`** — precondition: a pending change
  exists.
````

**After (discard):**

````
- **`discardExternalState(projectId)`** — precondition: a pending change
  exists and `snapshotState` is `"ok"` (a durable recovery snapshot of the
  exact foreign bytes).
````

**New bullet** (added after the `no_pending_change` bullet, lines 554–555):

````
- **Refusal while evidence is missing or unreadable (normative):** while
  `snapshotState` is not `"ok"`, both resolutions are refused — with
  `external_change_unreadable` in `paused-unreadable`, with
  `external_change_evidence_missing` in `paused-snapshot-failed` — and
  nothing is written: memory and disk are unchanged, and the pending state
  and the pause persist across the refusal. Before answering, the command
  re-reads the file: bytes now readable ⇒ (re)establish the pending change
  from the real bytes (§7.2 steps 2–4), attempt the snapshot, and, once it
  is durable, proceed with the resolution in the same call; file absent at
  re-read (ENOENT) ⇒ the foreign state is gone — pending cleared, unpaused:
  the paused project is unblocked, no operator action is needed, and no
  destructive write occurred (absence is a known state; no snapshot is
  taken, because there is no foreign content to preserve); bytes still
  unreadable (non-ENOENT) ⇒ `paused-unreadable`; other foreign bytes ⇒ the
  §7.2 protocol re-fires on them (a fresh detection cycle).
````

#### 7.4(e) §7.4 pruning (lines 561–566) — the contract-level fix for R16; artifact name unchanged

**Before:**

````
`.thirdlight/recovery/scene-<UTCstamp>-<sha8>.json` files are the
backend's evidence + repair aid for external bytes. They are: never read
automatically, never deleted except by the 16-oldest pruning, and **not a
backup** (charter §4's backup policy is a later deliverable). Operators
can compare a snapshot to `main.json` to see exactly what changed.
````

**After** (original paragraph unchanged; one normative paragraph added):

````
`.thirdlight/recovery/scene-<UTCstamp>-<sha8>.json` files are the
backend's evidence + repair aid for external bytes. They are: never read
automatically, never deleted except by the 16-oldest pruning, and **not a
backup** (charter §4's backup policy is a later deliverable). Operators
can compare a snapshot to `main.json` to see exactly what changed.

**Pruning order and exemption (normative):** the snapshot of the current
pending change — the snapshot whose content hash is the pending
`externalHash` — is **exempt from pruning while that change is pending**
and is retained until the change is resolved. Pruning keeps at most 16
snapshots in total, always including the exempt one: the other retained
snapshots are the newest by `UTCstamp`, and within one `UTCstamp` by full
file name lexicographically (a same-timestamp tie is broken by name, never
by guesswork, and no older-`UTCstamp` snapshot is pruned while a
same-`UTCstamp` one survives). Pruning runs after each successful snapshot
write and removes only non-exempt snapshots.
````

(The `scene-<UTCstamp>-<sha8>.json` name is kept — no artifact rename, no
schema change.)

#### 7.4(f) §11 operations and error codes

**Operations table — failure-code cells of the two resolution rows (lines
696–697);** the minimal consistency consequence of the new codes, since
these cells enumerate the codes the operation can return; no other
operations-table row changes.

**Before:**

````
| `acceptExternalState(projectId)` | operator | `{ ok, revision, historyReset, retryCleared }` | `no_pending_change`, `external_change_invalid`, `project_unavailable` |
| `discardExternalState(projectId)` | operator | `{ ok, revision, historyReset }` | `no_pending_change`, `project_unavailable` |
````

**After:**

````
| `acceptExternalState(projectId)` | operator | `{ ok, revision, historyReset, retryCleared }` | `no_pending_change`, `external_change_invalid`, `external_change_unreadable`, `external_change_evidence_missing`, `project_unavailable` |
| `discardExternalState(projectId)` | operator | `{ ok, revision, historyReset }` | `no_pending_change`, `external_change_unreadable`, `external_change_evidence_missing`, `project_unavailable` |
````

**Error-code table — two new rows** (inserted after the
`external_change_invalid` row, line 716; existing style):

````
| `external_change_unreadable` | scene file read failed with a non-ENOENT error: the on-disk bytes are unknown; `paused-unreadable` (§7.2); carries `projectId`, `snapshotState: "unreadable"`, `pendingChange` with `externalHash: null` |
| `external_change_evidence_missing` | pending change readable but not durably snapshotted: `paused-snapshot-failed` (§7.2); accept/discard refused until the snapshot is durable; carries `projectId`, `snapshotState: "snapshot_failed"` |
````

The `holder` shape line (lines 728–729) is **unchanged** — 7.3 requires no
ownership-shape change. The "Permitted `project_unavailable.reason`
values" block needs no change: it admits every code in this table. No other
contract text changes.

### 7.5 Mandatory implementation tests implied

For the later implementation step (after this diff is accepted); each is a
regression test using real faults, run as the unprivileged user (chmod
faults are meaningless as root; ENOSPC/EACCES/fsync faults on the recovery
write are injected through the existing public `WriteOps` seam, as in the
retained probe — all assertions are against real on-disk bytes):

1. **Unreadable scene file (chmod 000, directory writable).** Foreign bytes
   written, `chmod 000` on `scenes/main.json`, mutate ⇒ the mutation
   returns `external_change_unreadable` (`pendingChange.externalHash` is
   `null`); the recovery directory contains **no** snapshot (certainly no
   zero-byte one); `discardExternalState` is refused
   (`external_change_unreadable`); the foreign bytes on disk are
   byte-identical to what was written.
2. **Restore ⇒ retry ⇒ normal pause ⇒ both resolutions work (two separate
   projects).** Restore the permission and retry the same mutation ⇒
   ordinary pause (`external_change_unresolved`) with a real snapshot
   (byte-identical to the foreign bytes); on project A
   `acceptExternalState` succeeds; on project B (a fresh repro)
   `discardExternalState` succeeds, restoring the LKG bytes exactly.
3. **Recovery-write fault (ENOSPC, then EACCES, then fsync failure).**
   With the fault on recovery-file creation and foreign envelope bytes
   present, mutate ⇒ the mutation pauses in `paused-snapshot-failed`
   (`external_change_unresolved` with `snapshotState: "snapshot_failed"`);
   accept AND discard are both refused
   (`external_change_evidence_missing`); the foreign bytes are retained on
   disk.
4. **Fault removed ⇒ re-issued discard recovers.** Remove the fault;
   the operator re-issues `discardExternalState` ⇒ the snapshot is then
   taken (durable) and the discard succeeds in the same call: history
   reset, on-disk bytes exactly the LKG envelope.
5. **17 same-second detection/resolution cycles on distinct foreign
   values.** 17 cycles with a fixed/identical UTC stamp ⇒ in every cycle
   the current pending change's snapshot is retained; ≤16 older snapshots
   are pruned; after the 17th cycle the 17th snapshot is still on disk and
   the discard succeeds with its evidence intact.

### 7.6 Interaction notes, verification and provenance

- **Section 3 (R9 — the O_EXCL claim file, mechanism (a)):** no
  interaction beyond all of 7.2–7.5 running under an acquired claim file.
  The external-change states are a project-level write state, and the two
  concerns are orthogonal: a claim file can wedge `claim_inconsistent` but
  never blocks resolution of external changes (and a wedged
  `paused-unreadable` / `paused-snapshot-failed` never blocks acquiring or
  releasing the claim file); the §6 protocol (section 4's diff) is
  unchanged by this addendum.
- **R5 (operator envelope writes):** accept/discard are operator write
  boundaries. The refused-resolution path must leave memory and disk
  consistent and return the structured error — nothing written, nothing
  published — and the pending state persists across the refusal. R5's
  reconciliation requirement applies to the success path (where a write may
  land as `new-undurable`); the refusal path writes nothing by definition,
  and its fault tests must cover a refused resolution issued while a write
  fault is active.
- **R9 / section 4's §6 diff:** no change. The two diffs are independent (the
  §6 claim mechanism; the §7 external-change states); both contribute rows
  to the §11 error-code table and apply cleanly together.

**Verification and provenance.** Commands actually run at HEAD `af4881c`
(clean tree), docs-only step, as the unprivileged user `dadmin` (uid 1000):

1. **Retained main probe** (read-only run; it writes only under disposable
   `~/.thirdlight-audit-*` roots and removes them in `finally`; after the
   run `ls -d ~/.thirdlight-audit-*` matched nothing — no leftovers):

   ```
   $ node docs/reviews/2026-09-18-probes.mjs
   RETRY_OVERWRITE {"result":true,"foreignLost":true,"snapshots":0}
   UNREADABLE_OVERWRITE {"pendingHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","snapshotBytes":0,"discard":true,"foreignLost":true}
   SNAPSHOT_FAILURE {"error":"external_change_unresolved","discard":true,"snapshots":0,"foreignLost":true}
   CLOSE_FAILURE_ACK {"ok":true,"revision":1}
   ACCEPT_DIVERGENCE {"error":"new-undurable","diskRevision":10,"memoryRevision":1,"diskRetry":0}
   RELEASE_ENVELOPE_DIVERGENCE {"error":"new-undurable","diskRetry":0,"memoryReplay":true}
   RELEASE_OWNERSHIP_SPLIT {"release":"new-undurable","newOwner":true,"oldOwnerStillWrites":true,"newOwnerRevision":0,"oldOwnerRevision":1}
   NULL_DIGEST {"ok":true,"digest":null,"reopen":"retry_records_invalid"}
   QUERY_ALIAS non-command name edit persisted by unrelated command
   ACK_ALIAS mutating returned history corrupts retry records on next write
   STARTUP_THROW JSON change.type={toString:0} throws TypeError from openWorkspaceService
   INVALID_RECORD_REPLAY {"projectId":"another-project","entity":{"id":"box-0001"}}
   ERROR_JSON BigInt found in query validation error prevents JSON serialization
   exit 0
   ```

   Key lines for this addendum: `UNREADABLE_OVERWRITE` (R1 — zero-byte
   "snapshot" carrying the empty string's SHA-256, discard destroys the
   foreign bytes) and `SNAPSHOT_FAILURE` (R3 — zero evidence, discard
   succeeds). The R16 line `RECOVERY_NEWEST_PRUNED newestRetained:false`
is quoted from the review's recorded path-ownership-probe output; that
   probe was not re-run in this step (outside this addendum's scope).
2. **Full test suite** (baseline only):

   ```
   $ npm test
    Test Files  27 passed (27)
         Tests  438 passed (438)
      Duration  21.53s
   exit 0
   ```

No other verification is claimed for this docs-only step. This addendum is
a proposal for the independent review step — no reviewer approval is
claimed or implied. No source, test, fixture, or contract document was
changed; nothing was pushed.
