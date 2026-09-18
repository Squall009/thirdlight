# Contract change request — exclusive ownership claim (review finding R9)

**Date:** 2026-09-18
**Authority:** owner-requested review `docs/reviews/2026-09-18-commits.md`,
finding **R9** (P1, CONTRACT BLOCKER: "rename plus verification does not
establish exclusive ownership"), and its **Suggested orchestration work order,
step 1** ("Record a contract decision for R9's actual exclusivity mechanism").
**Scope note:** R9 in full; R1/R3 state addendum to follow as a separate
section; nothing else in any contract changes; no implementation under this
request. This is a proposal for the independent architectural review step —
no reviewer approval is claimed or implied. Working state: HEAD `ed714c2`,
clean tree; docs only — no source, test, fixture, or contract-document change.

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
absent/released/stale transitions; (iv) exact §6.2/§6.4/§6.5/§11 table rows
added/changed/removed (existing table style); (v) new `WriteOps` primitives
(against the current `WriteOps` at `write.ts:59`); (vi) operational risks.

### (a) Epoch-scoped atomic claim file (`O_CREAT|O_EXCL`)

The record file is unchanged (identity/epoch/openedAt, written via `W` after
the claim). New: a per-epoch claim file `.thirdlight/claim-<lockEpoch>`,
created with `O_CREAT|O_EXCL`; the claimer's identity (backendId, pid,
openedAt, epoch) is stamped into it before the record write; claim files are
never deleted (past-epoch files are **tombstones**); liveness stays the
conservative unknown⇒live rule for record evaluation; operator takeover
advances the epoch. Claim at epoch e = (1) `open(claim-e, O_CREAT|O_EXCL)` —
the exclusive gate; EEXIST ⇒ a different claimer holds epoch e: re-read the
record and re-evaluate (owned+live ⇒ conflict; owned+dead at e ⇒ stale at e;
record absent/released/older-epoch ⇒ **orphan state** below — the open fails,
never auto-resolved); (2) stamp identity into claim-e, fsync, close; (3)
`W` the record (owned, our identity, e) + verification re-read; (4)
consistency: the re-read record's epoch must be e — while we hold claim-e and
the record's epoch is < e, no protocol write can advance the record past
e−1 (any advance requires a claim at that epoch, which requires its own claim
file; an advance to e requires claim-e itself, which we exclusively hold), so
a foreign epoch ⇒ out-of-protocol tampering ⇒ fail closed, release. Any
failure before step 4 completes ⇒ no ownership.

**(i) Single-winner proof.** A and B both read the record absent ⇒ both
target epoch 0 ⇒ both target the *same path* `claim-0`.
`open(O_CREAT|O_EXCL)` is serialized by the kernel (ext4 inode lock): at most
one caller succeeds. If A pauses before its open: B's open succeeds, B
completes the claim (record 0, B live); A's open ⇒ EEXIST ⇒ A re-reads the
record (B's owned, live) ⇒ `ownership_conflict`. If A paused after its own
successful open: B's open ⇒ EEXIST; the record is still absent (A mid-claim)
⇒ B fails (in-flight holder — no claim either way). Ownership is conferred by
the exclusive creation, not by the record write; no interleaving yields two
holders of `claim-0`, and only the holder can write the record at epoch 0. ∎

**(ii) SIGKILL crash behavior.** Crash points: (1) before the claim file —
nothing on disk, plain absent. (2) Claim file created, identity stamp
partial/absent — claim-e present with unparseable identity ⇒ holder unknown
⇒ conservatively treated as in-flight/live ⇒ the open fails; evidence = the
raw claim-e bytes, reported to the operator. (3) Claim file complete, record
not (yet) written — **orphan state**: record absent/older + claim-e present.
*No process may write next automatically*: the next claimant at epoch e hits
EEXIST, sees record epoch < e, and fails with a structured inconsistent
error. An **operator** resolves explicitly: the resolution adopts the record
from the claim file's identity (record becomes owned-e, dead holder) — no
unlink — after which the normal stale-takeover path (epoch e+1; claim-(e+1)
is free) proceeds. (4) After the record write — the ordinary stale state
(record owned, dead pid, claim-e a consistent tombstone pair).

**(iii) Transitions.** absent ⇒ claim 0 (claim-0 must be free; else orphan
failure). released-e ⇒ claim e+1. owned+live ⇒ `ownership_conflict`.
owned+dead ⇒ `stale_ownership` ⇒ explicit takeover ⇒ e+1. Own-record reopen
⇒ no write. One tombstone file per epoch ever used; never deleted.

**(iv) Rows.**
- §6.2 table: row `absent` **changed**: "claim: create `claim-0` via
  `O_CREAT|O_EXCL` (§6.3), then write the record via `W` + verification
  re-read; EEXIST ⇒ re-read the record and re-evaluate (a concurrent claimer
  won, or orphan/inconsistent state — the open fails)". Row **added**:
  `| record epoch < highest existing claim-file epoch (record absent while a claim file exists) | crash between claim-file creation and record write (or a bypassing act) | **`claim_inconsistent`** — open fails; operator resolution required (§6.4) |`. Liveness block **changed**: add "liveness is reporting/classification only; the exclusion gate is the claim-file creation (§6.3)".
- §6.4: procedure step (3) **changed**: "Claim (§6.3) with `lockEpoch` = previous + 1 (the `O_CREAT|O_EXCL` on `claim-(e+1)` is the single-winner gate; a held claim file ⇒ `ownership_conflict`)". Bullet **added** (orphan resolution, operator command, explicit, liveness reported as evidence, never automatic). Residual split-brain paragraph **unchanged** — a takeover of a *live* owner is still possible (the gate arbitrates only concurrent same-epoch claimers, not a sequential false-dead takeover of a live holder).
- §6.5: bullet **added**: "Claim files are never deleted (tombstones); they are workspace artifacts like the record". Owner-crash bullet **changed**: "…⇒ stale ⇒ explicit takeover (claim-e persists as a tombstone)". Artifact bullet **changed** to cover claim files.
- §11 operations table: row **added**:
  `| `resolveClaimFile(projectId)` | operator (explicit, §6.4) | `{ ok, lockEpoch, holder }` | `claim_inconsistent`, `ownership_conflict`, `project_not_found` |`.
  §11 error-code table: row **added**:
  `| `claim_inconsistent` | record and claim files disagree (orphan claim file); operator resolution required (§6.4) |`.

**(v) New WriteOps primitives: none.** The existing `openTempFile`
(write.ts:61, `O_WRONLY|O_CREAT|O_EXCL` at 0644, throws on EEXIST) *is* the
claim-file gate; `writeAll`/`fsyncFile`/`closeFile` stamp and close the
identity. Fault injection reaches the gate through the existing seam.

**(vi) Operational risks.** **Orphan stuck state**: a crash between
claim-file creation and record write leaves the project un-openable until an
operator resolution (a new error code + a new operator procedure — failure
modes the current system does not have). **False-dead takeover of a live
owner still splits the brain** (the O_EXCL gate does not block a sequential
takeover at a higher epoch — the current §6.4 residual bound persists
unchanged). NFS: cross-client `O_CREAT|O_EXCL` is not a reliable atomicity
guarantee (M1 excludes network FS per §2/§12 — consistent, but the mechanism
does not port). Two operators: racing takeovers arbitrate to one winner
(EEXIST), but a confused operator can still take over a live owner
(unblocked). Tombstone files accumulate (one per epoch; harmless but
unbounded in principle).

### (b) Advisory exclusive lock (`flock`) held for the session lifetime

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

**(iv) Rows.**
- §6.2 table: row `absent` **changed**: "claim (§6.3): acquire the session lock, then write our record (`lockEpoch` 0) via `W` + verification re-read; lock held ⇒ `ownership_conflict` (`holder` = the record's owner, or `null` when the record is absent/unreadable)". Row **added**: none (lock contention is discovered at claim time, not record evaluation). Liveness block **changed**: add one normative bullet — liveness is reporting/classification only; exclusivity is enforced by the kernel-held session lock (§6.3); a liveness error can misclassify but cannot create a second active writer (claim and takeover both require the lock).
- §6.4: procedure bullet **changed** (step (3) note: the claim includes the session-lock acquisition, the single-winner gate; failure line: `ownership_conflict` *including when the session lock is held* — the recorded owner is live or a concurrent takeover completed first — or `stale_ownership` with the fresh holder). Residual split-brain bullet **changed**: racing takeovers yield exactly one winner via the session lock; a takeover of a *live* owner now fails mechanically (the live owner holds the lock for its session lifetime ⇒ `ownership_conflict`) — the false-dead split-brain path is removed; the only remaining split-brain path is a bypassing actor deleting/recreating the lock file from under the owner (§7.1 non-claim class), degrading safely via the §5.2 pre-write check as before.
- §6.5: bullet **added**: the session lock is acquired on claim, held for the owner session's lifetime, released on release (§9) or process death (kernel release on death — no orphan exclusive state); the lock file is never deleted by the backend (a deleted-and-recreated lock file is a different inode — §7.1 non-claim for bypassing writers); the session holds the lock fd open until release, no code path closes it earlier. Owner-crash bullet **changed**: "Owner crash: the kernel releases the session lock; the record persists with a dead pid ⇒ stale ⇒ explicit takeover (…)". Artifact bullet **changed** to cover the lock file.
- §11 operations table: **no rows added/changed/removed** (`takeoverWorkspace`/`releaseWorkspace` keep their signatures and codes; a held-lock failure maps to the existing `ownership_conflict`). §11 error-code table: row **changed**:
  `| `ownership_conflict` | live owner holds the project **or the session lock is held** (§6.2/§6.3; carries `holder`, `null` when the record is absent/unreadable) |`. `holder` shape line **changed**: add "or `null` (the session lock is held but no parseable owned record exists — a concurrent claimer is mid-claim, §6.3)".

**(v) New WriteOps primitives** (against the current `WriteOps`, write.ts:59):
- `openLockFile(path: string): number` — open `.thirdlight/lock` with
  `O_RDWR|O_CREAT` at 0644 (no `O_EXCL`: the file persists across owners);
  throws on EACCES/EIO.
- `lockExclusiveNonBlocking(fd: number): void` — `flock(fd,
  LOCK_EX|LOCK_NB)`; throws on EWOULDBLOCK (the claim/takeover fails; never
  blocks).
- Release reuses the existing `closeFile(fd)` (close ⇒ lock released).
  Two new primitives; the record `W` + verification re-read is unchanged.

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

### (c) Hybrid: (a) + (b)

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
`resolveClaimFile` row + the `ownership_conflict` row change + `holder` line.

**(v) New WriteOps primitives.** `openLockFile` + `lockExclusiveNonBlocking`
(as (b)); the claim-file gate reuses `openTempFile` (as (a)).

**(vi) Operational risks.** The union of both: the orphan stuck state **and**
the wedged-live blocker **and** hostile deletion of either file (two inodes
to protect) **and** the doubled operator-resolution surface (orphan
resolution *and* the lock-held error path). Strictly more moving parts than
(b) with no additional exclusion.

## 3. Recommendation

**Exactly one mechanism: (b) — a session-lifetime advisory exclusive
`flock` on a dedicated per-project lock file `.thirdlight/lock`, with the
existing record file kept as the identity/epoch/openedAt audit layer.**

Justification (≤200 words):

Single-winner: the flock is kernel-serialized per inode, held for the
session lifetime, not per write. In the §1 interleaving the loser is refused
at lock acquisition at every pause point; the record rename arbitrates
nothing. No interleaving yields two active owners — proven in §2(b)(i), not
asserted. Crash safety without a pid-liveness safety gate: the kernel
releases the lock on holder death at every crash point; no orphan exclusive
state exists, no liveness check gates automatic claims, and the stale path
is the existing explicit operator takeover. Liveness only classifies
`ownership_conflict` vs `stale_ownership` (reporting/UX). R9 acceptance fit:
the seam interleaving yields one winner; two-process barriers
(absent/released/stale) yield one active writer; SIGKILL ⇒ no false
liveness, no orphan state. Why the runner-up (a) was not chosen: it is
single-winner too (O_EXCL atomicity) and needs no new WriteOps primitives,
but it retains the false-dead split brain of taking over a live owner (its
gate arbitrates only concurrent same-epoch claimers) and adds the
orphan-claim-file stuck state plus a new operator-resolution command — new
contract surface, operator burden, and exactly the orphan state R9's
acceptance prefers not to exist. (c) is dominated by (b): it unions the
failure modes, adding no safety.

## 4. Exact contract diff for `docs/contracts/workspace.md`

Before/after blocks. Current text quoted verbatim at HEAD `ed714c2`.
**Not applied** in this step. Section numbers and wording style preserved;
minimal — no unrelated rewrites.

### 4.1 §6.2 — open-time evaluation: row `absent` (line 408)

**Before:**

```
| absent | — | claim: write our record (`lockEpoch` 0) via `W` + verification re-read (§6.3); on re-read mismatch re-evaluate (a concurrent claimer won) |
```

**After:**

```
| absent | — | claim (§6.3): acquire the session lock, then write our record (`lockEpoch` 0) via `W` + verification re-read; lock held ⇒ `ownership_conflict` (`holder` = the record's owner, or `null` when the record is absent/unreadable) |
```

(The `released`, own-record, live, and stale rows are unchanged: "same claim
procedure" now refers to the §6.3 procedure; lock contention is discovered
at claim time, not record evaluation.)

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
- **Liveness is reporting and classification only (normative).** It selects
  between `ownership_conflict` and `stale_ownership` and what the operator
  is shown. Exclusivity never depends on it: the session lock (§6.3) is the
  only exclusion gate, and it is enforced by the kernel. A liveness error can
  misclassify (a live owner reported stale), but it cannot create a second
  active writer — claim and takeover both require the lock, which a live
  owner holds for its session lifetime. Only proven absence/death permits a
  claim/takeover: no automatic claim ever consults liveness, and takeover is
  an explicit operator command.
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

The exclusive gate is the **session lock**: a per-project lock file
`.thirdlight/lock` (an empty file, created with `O_RDWR|O_CREAT` at 0644,
never deleted by the backend; its content carries no meaning) held under an
exclusive advisory `flock` for the **owner session's lifetime**. The record
file (`ownership.json`) is the identity/audit layer: writing it does not
confer ownership, and no read or re-read of it can arbitrate a claim.

Claim at `lockEpoch` e =

1. **Acquire the session lock** — `flock(LOCK_EX|LOCK_NB)` on
   `.thirdlight/lock`. Failure (held) ⇒ the claim fails with
   `ownership_conflict` (`holder` = the record's owner when the record is a
   parseable owned record, else `null` — a concurrent claimer is mid-claim,
   or a live holder holds the lock); the open fails, the operator retries.
   There is no retry loop.
2. **Write the record** via `W(our-record, ownership.json)` (state `owned`,
   our `backendId`/`pid`/`openedAt`, `lockEpoch` e) with the verification
   re-read: the on-disk record must contain our `backendId`, `pid`, and
   `lockEpoch`.
3. **Consistency** — the re-read record's `lockEpoch` must be e. The epoch
   can only advance through claim/takeover, and each advance requires the
   session lock; while we hold it, no other backend can advance the
   record's epoch. A re-read showing any other epoch ⇒ the record was
   changed outside the protocol ⇒ fail closed: release the lock, report
   `ownership_conflict` with the fresh holder.

Any failure at steps 2–3 **releases the session lock** (a failed claimant
holds no ownership). On success the lock is held until release (§9) or
process death — the kernel releases it on death, so a crashed owner leaves
no orphan exclusive state.

**Single-winner (normative):** `flock` is serialized by the kernel — at most
one process holds the exclusive lock, and it is held for the session
lifetime, not per write. A concurrent claimer either (a) reads the record
before our rename and is refused at step 1 (we hold the lock), or (b) reads
it after and evaluates a live owner ⇒ `ownership_conflict`. No interleaving
of two claimers yields two active owners. A second re-read or any finite
hash check cannot substitute for the lock: a post-hoc read certifies only
the file's state at that instant, never that no concurrent rename follows.
```

### 4.4 §6.4 — stale-owner takeover: procedure bullet (lines 447–454)

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
  (§6.3) with `lockEpoch` = previous + 1 — including the session-lock
  acquisition, which is the single-winner gate. (4) Load the project (§4.3).
  Success result: `{ ok: true, lockEpoch, backendId, pid }`; failure:
  `ownership_conflict` (including when the session lock is held — the
  recorded owner is live or a concurrent takeover completed first) or
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
  race, the session lock yields exactly one winner (the loser's lock
  acquisition fails and the takeover aborts). A takeover of a *live* owner
  no longer splits the brain: a live owner holds the session lock for its
  session lifetime, so the takeover's lock acquisition fails with
  `ownership_conflict` — the false-dead split-brain path is removed. The
  only remaining split-brain path is a bypassing actor that deletes and
  recreates the lock file from under the owner (§7.1's explicit non-claim
  class, the same exposure as today's direct ownership-file tampering): the
  old owner's next envelope write's pre-write check (§5.2) finds foreign
  bytes, pauses, and snapshots them — no silent corruption of the envelope,
  and both envelopes involved are complete valid documents.
```

### 4.6 §6.5 — ownership lifecycle (lines 464–477)

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
- The session lock (§6.3) is acquired on claim, **held for the owner
  session's lifetime**, and released on release (§9) or process death — the
  kernel releases it on death, so a crashed owner leaves no orphan exclusive
  state. The lock file is never deleted by the backend (a deleted-and-
  recreated lock file is a different inode; see §7.1's non-claim for
  bypassing writers). The session holds the lock fd open until release; no
  code path closes it earlier.
- Owner crash: the kernel releases the session lock; the record persists
  with a dead pid ⇒ stale ⇒ explicit takeover (the envelope is untouched by
  any of this; its validity is re-checked at the new owner's open).
- The ownership file and the lock file are workspace artifacts, not
  authoring data: they are excluded from logical reading, from
  external-change detection (§7 monitors the envelope only), and from G1's
  authoring guarantees (the record's own writes use the same `W`, so it is
  torn-free too).
```

(§9's release procedure performs the lock release; the normative statement
lives in §6.5. §9 itself is outside this request's diff scope.)

### 4.7 §11 — operations and error codes

**Operations table (lines 690–697): no rows added/changed/removed.**
`takeoverWorkspace` and `releaseWorkspace` keep their kind, success results,
and failure codes — a held-lock failure maps to the existing
`ownership_conflict`.

**Error-code table, row `ownership_conflict` (line 713).**

**Before:**

```
| `ownership_conflict` | live owner holds the project (§6.2; carries `holder`) |
```

**After:**

```
| `ownership_conflict` | live owner holds the project **or the session lock is held** (§6.2/§6.3; carries `holder`, `null` when the record is absent/unreadable) |
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
state }`, or `null` (the session lock is held but no parseable owned record
exists — a concurrent claimer is mid-claim, §6.3).
```

## 5. Mandatory implementation tests implied by the mechanism

For the later implementation step (after the contract diff is accepted and
the architectural gate reopens):

1. **Deterministic interleaving through the public seam ⇒ exactly one
   winner.** The retained probe's interleaving (A evaluates the record as
   absent and pauses before its claim completes; B claims fully) must now
   yield exactly one winner: with A's lock held, B's
   `lockExclusiveNonBlocking` throws EWOULDBLOCK ⇒ B's open fails
   (`ownership_conflict`); A owns. The inverse schedule (A pauses after
   lock acquisition, before the record write; B attempts) ⇒ B fails; A
   owns. Assert: exactly one `ok:true` claim; the on-disk record is the
   winner's; the loser session is not open and writes nothing. The probe's
   `CLAIM_RACE {a:true,b:true}` shape becomes the failing regression
   (expected `{a:true,b:false}` or `{a:false,b:true}`, never both true).
2. **Real two-process barrier tests** (two node processes, gated by a
   file/signal so both act after the gate; not mocks): for each of
   **absent claim** (fresh project, record absent), **released claim**
   (owner released), and **stale claim** (owner SIGKILLed, then both
   processes issue `takeoverWorkspace` after the gate) — exactly one active
   writer: the winner's claim/takeover succeeds and its mutation reaches
   revision 1 (a second mutation confirms the lock did not flap); the
   loser's open/mutation fails with `ownership_conflict` /
   `stale_ownership`; the on-disk record is the winner's.
3. **SIGKILL crash tests.** (a) Claim → SIGKILL the owner (after the record
   write) → a second identity reopens: the open reports `stale_ownership`
   with the dead holder — **no false liveness** (the crashed pid is never
   reported as a live holder) — the operator takeover succeeds; exactly one
   writer. (b) Claim interrupted **before** the record write (crash between
   lock acquisition and rename, via the fault seam or a SIGKILL timing
   gate) → reopen: the state is directly claimable — the lock is
   kernel-released and the record still shows the previous
   absent/released state — **no orphan exclusive state, no liveness-gated
   lock, no operator step required** (a plain claim succeeds). (c) Assert
   the on-disk evidence after each crash: record bytes and lock file as
   defined by §6.3/§6.5, nothing else.

## 6. Verification and provenance

Commands actually run at HEAD `ed714c2` (clean tree), docs-only step.

**1. Retained path-ownership probe (read-only run of the review's retained
harness; it writes only under disposable `~/.tl07-focus-*` mkdtemp roots on
ext4 and removes them in `finally` — no leftovers remained after the run):**

```
$ node_modules/.bin/esbuild docs/reviews/2026-09-18-path-ownership-probes.ts \
    --bundle --platform=node --format=esm --outfile=/tmp/tl07-contract-review.mjs
/tmp/tl07-contract-review.mjs  169.6kb
⚡ Done in 6ms
$ node /tmp/tl07-contract-review.mjs
...
CLAIM_RACE {"a":true,"b":true,"bStillOpen":true,"owner":"tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
...
exit 0
```

Key line: `CLAIM_RACE {"a":true,"b":true,"bStillOpen":true,"owner":"tb-aaa…"}`
— the R9 interleaving reproduces: both claimers end up open (current buggy
behavior, pinned by the probe). Companion lines from the same run:
`UNREADABLE_OWNER {"result":{"ok":true,...},"owner":"tb-bbb…","firstStillOpen":true}`,
`PROC_EACCES {"query":{...,"reason":"stale_ownership",...},"takeover":{"ok":true,...},"realOwnerStillAlive":true}`
(R8 context, unchanged here).

**2. Full test suite:**

```
$ npm test
> vitest run
 Test Files  27 passed (27)
      Tests  438 passed (438)
   Duration  21.38s
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