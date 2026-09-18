# Gate B re-review (round 1) — reopened architectural gate, packets 04–07, post-repair

**Date:** 2026-09-18 (UTC). **Reviewer role:** independent architectural
reviewer (review-only; the only file created/committed is this document — no
source, contract, fixture, test, STATUS, or handoff edits).

**Scope.** Re-adjudication of Gate B (packets 04–07) after: the
2026-09-18 commit review that RE-OPENED the gate
(`docs/reviews/2026-09-18-commits.md`, R1–R17 + O1/O2; the 2026-09-18
acceptance in `docs/handoffs/07.md`/`gate-b.md` is historical), the R9/R1/R3
contract amendment (request → review → round-1 repair → re-review accepted →
round-2 N1/N2 → applied as `dabfcff`), the 12-step repair campaign
(`docs/handoffs/07-repair-2026-09-18.md` groups A1/A2/B1–B3/C/D/E1–E3 + BF +
O1/O2), and the ACCEPTED independent packet 07 re-review
(`docs/reviews/P-rereview1.md`).

**Tree.** HEAD `3d3b9d9` (clean; `git status` empty), `origin/main`
`87394e3`, **90 commits unpushed**. node v22.22.1, host user `dadmin`
(unprivileged).

**Method.** (1) Read the documents in the prescribed order. (2) Verified the
amended contract's applied text against the final accepted request text
(block extraction + occurrence counts, my own script). (3) Grep-level
layering verification (single mutation authority, single claim path, public
surfaces, builtins, global state). (4) Re-ran the four toolchain commands on
the live tree (real outputs below) plus fixture `--check` and the isolated
real-process claim suite. (5) Adjudicated every carried-forward item, with
**new independent probes** (esbuild bundles of the public
`project-model`/`workspace` APIs, disposable `mkdtemp` roots on ext4) against
the project-model carried-forward observations — those probes found the new
findings G1–G3 (§5.2). I did not re-derive P-rereview1's behavioral
findings (R1–R17, O1/O2, L1 are ACCEPTED there and are taken as verified).

---

## 1. Contract-amendment consistency (R9/R1/R3 amendment, `dabfcff`)

**Verdict: the amendment is internally consistent and the record is
complete.** No contradiction found between the amended §6.3 and any other
section; no stale reference to the pre-amendment rename+verify mechanism or
pre-amendment reopen semantics.

**Amendment record (complete, verified in git):** request `af4881c` (R9 §6
exclusivity) + `893a2fd` (R1/R3 state addendum) → independent review
(changes required, F1–F7; review file committed with `8ed35ad`) → repair
round 1 `8ed35ad` (mechanism re-selected to dep-free (a) O_EXCL claim file;
new §9 hunk; F1–F3) → `1dc2129` (F4–F7) → contract re-review `5f7ec28`
(ACCEPTED with bounded follow-ups N1/N2;
`docs/handoffs/2026-09-18-contract-rereview1.md`) → N1/N2 applied `1211149`
(pre-record claim-file verification step; non-ENOENT record read-failure
clause) → **applied `dabfcff`** (`docs/contracts/workspace.md` only,
+266/−41) → hash record `50c8cce`. Every step is recorded in
`docs/orchestration.md` with independent spot-checks. The request document is
frozen at `1211149` (no later change).

**Applied text = recorded decision (my verification, not re-quoting the
record):**

- All **22 After/insertion blocks** of the final (round-2) request text are
  present in `workspace.md` (extraction script over the current tree:
  **22 OK, 0 MISS** — matching the 19 After hunks + 3 insertions the
  application recorded).
- Superseded sentences are GONE (0 matches each): `concurrent claimers
  converge`, `without any lock file or unlink`, `holds no lock`, `on re-read
  mismatch re-evaluate (a concurrent claimer won)`, `oldest pruned to keep
  16`, and no `flock`/`lock file` anywhere in the contract.
- Normative anchors present exactly once: §6.2 liveness block line 440
  ("Liveness and the exclusion gate (normative)"); §6.3 line 463 (claim-file
  gate), line 518 (orphan recovery), line 534 (superseded-epoch cleanup),
  line 543 (single-winner norm); §7.4 line 754 (pruning exemption); §9 line
  849 (release unlinks the owner's own claim file); §11 line 940
  (`claim_inconsistent` row), lines 944/945 (the two external-change rows),
  lines 957–958 (holder `null` shape clause).
- The only changes to `workspace.md` **after** `dabfcff` are the two
  documented BF sentences (verified `git diff dabfcff..HEAD`): the BF-2
  "Scoped precisely" sentence (§9, line 862) and the BF-3 `project_unavailable`
  addendum to the §11 `takeoverWorkspace` row. Nothing else.

**Cross-section consistency (checked §5, §6.1, §6.2, §6.4, §7, §9, §10, §11,
§12 against §6.3):** no section still describes the old rename+verify claim
mechanism or pre-amendment reopen semantics. `grep re-evaluate` → only the
three new-mechanism occurrences (lines 421/473/566); `epoch` occurs only in
§6/§9/§11; §5.1's W definition (envelope + ownership record) matches §6.3
step 4; §10 "claims no ownership" is consistent with the claim-file
lifecycle; §12 "one owner; external writers detected/paused" remains true
(the claim file arbitrates concurrent *claimants*, not concurrent writers).
The §6.3 step-1 re-evaluation mapping ("owned + dead ⇒ `stale_ownership`" vs
orphan recovery scoped to "absent/released/older-epoch") is coherent: a
record owned at the *same* epoch as a held claim file (the crashed
record+claim pair) goes to the stale/takeover path at e+1, never to
orphan-reclaim; an *older-epoch* owned record under a higher-epoch claim file
is the crashed-takeover orphan case that orphan recovery handles. No
contradiction.

**Self-gaps flagged (completeness, not contradiction; all pre-recorded in
repair handoff §0 residual notes 1–3 — verified, not rewritten by me):**

1. §3 layout block (workspace.md lines 74–84) does not list the new
   `.thirdlight/claim-<e>` artifact, while §1/§3 state artifact locations
   are normative. The location is normative in §6.3 (line 463), §6.5
   (line 602), and §9 (line 849), and §3's "ownership and recovery only
   under `.thirdlight/`" is not contradicted (claim files are under
   `.thirdlight/`). **Documentation gap, no semantic conflict** — tracked as
   required-change item 4 below.
2. §3 line 83 "at most 16 kept, oldest pruned" predates the §7.4 pruning
   exemption (line 754); still true as stated (≤16 kept; pruning removes
   only non-exempt, oldest-first), flagged as a wording-alignment candidate
   in the same docs micro-fix.
3. The §6.2 table rows contain a literal `|` inside inline code
   `O_CREAT|O_EXCL` exactly as in the accepted After text; some Markdown
   renderers will display an extra column. Content is normative as written.

No inconsistency between the recorded decision and the applied text.

---

## 2. Layering / boundary verification (structural)

Behavioral conformance of the six-step primitive is P-rereview1's verified
territory (step-for-step check + 23/23 probes); my structural results:

**(a) Single mutation authority, single ownership-claim path (grep-verified).**

- `applyMutation` (commands) is called in **exactly one** place:
  `packages/workspace/src/service.ts:252` (the `runCommand` pipeline step
  4–6). No other mutation path exists.
- `claimOwnership` is **defined once** (`packages/workspace/src/
  ownership.ts:590`) and called from **exactly three** session call sites:
  `session.ts:632` (on-demand open, inside `ensureSession`, after
  `evaluateOwnership` returns `action: 'claim'`), `session.ts:1371`
  (`performClaimAndLoad` — takeover's fresh/claim path), `session.ts:1489`
  (takeover's stale path, §6.4 procedure). No second claim path.
- The ownership record's durable `W` writes exist only in `ownership.ts`
  (claim record write, `recPath` at ownership.ts:594; release record
  rewrite, recPath at ownership.ts:1005). No session/service code writes
  `.thirdlight/ownership.json` directly.
- No `globalThis` assignments in any package src; no timers/workers in
  workspace src; service instances are per-call (no hidden global service).
  `defaultWriteOps` remains the recorded config seam (adjudicated legitimate
  by the original gate).

**(b) Six-step primitive in one place.** `claimOwnership` implements the
amended §6.3 sequence in a single function with two private helpers
(`orphanRecovery` ownership.ts:470, `verifyClaimedFiles` ownership.ts:520):
self-reclaim row first (no O_EXCL against own claim file; content re-verify;
missing/foreign ⇒ refuse to serve); step 1 `O_CREAT|O_EXCL` acquire with
**no retry loop**, fail-closed on non-ENOENT record read failure (never
absence); step 2 durable stamp + fsync; step 3 pre-record by-path
verification (foreign/unparseable/missing ⇒ conflict, **no record
written**); step 4 record `W`; step 5 two-file verification re-read; step 6
epoch consistency; superseded-epoch cleanup (best-effort unlink of
`claim-(e−1)` **after** the successful record W); orphan reclaim only on
parseable content + proven-dead holder. Matches the contract text
step-for-step at the structural level.

**(c) Mandatory test suite (real processes, not mocks).**
`tests/ownership-claim-2026-09-18.test.ts` exists at the repo root: 6 tests —
T2 three **real two-process** races (absent / released / stale-SIGKILL
claim gates, file-gated `spawn` children, winner's second mutation + loser
refusal + byte-level on-disk assertions) and T3 **real SIGKILL** at the
three claim crash points (empty orphan ⇒ `claim_inconsistent` + operator
removal; proven-dead orphan ⇒ reclaim; absent record ⇒ normal path). The
child helper `tests/crash/ownership-child.ts` drives crash points through the
public `WriteOps` seam. Root placement is documented: `node:child_process` is
a forbidden package edge (dependencies.md §4.1). The seam suite
`packages/workspace/src/repair-2026-09-18-e1.test.ts` (7 deterministic
interleaving tests through the seam) complements it. **I re-ran the
real-process suite on the live tree: 6/6 passed, exit 0** (isolated
`vitest run`, 6.0 s). All 11 `repair-2026-09-18-*.test.ts` group files are
present in the tree.

**(d) Module-boundary discipline.** `npm run check-boundaries` (re-run on the
live tree): **OK — 3 package(s) [commands, project-model, workspace], 66
source file(s), 286 specifier(s) checked; no boundary violations** (exit 0).
Cross-package imports (src only) use the declared `.` subpath exclusively and
are within the dependencies.md §4.1 table: project-model = leaf (no
dependencies); commands → project-model; workspace → commands + project-model
(unchanged since the pre-repair state; `git diff 4493262..HEAD --
package.json package-lock.json` = **empty**). Node builtins in package src:
workspace `node:fs`/`node:path`/`node:crypto`/`node:os` (the §4.1 allowlist;
`node:child_process` only in root `tests/`, test plane, documented).
**Public surfaces unchanged:** all three `index.ts` exports verified —
project-model (§12.1 entry points + `ERROR_CODES`/`KNOWN_VERSIONS` +
`parseDocumentBytes`/`ByteParse` — the BF-4-documented already-public export),
commands (`applyMutation`, `createCommandState`, `ERROR_CODES`,
`MAX_REVISION`, wire types), workspace (`openWorkspaceService`, `ERROR_CODES`,
types, `defaultWriteOps`). No new export in any `index.ts` from the 12
repair steps.

---

## 3. BF closure table (BF-1…BF-5)

Byte-identity and wording probes below were independently re-verified by me;
the remainder cites P-rereview1 (its probes are accepted evidence per the
brief).

| BF | Spec (gate-b.md §5 / 2026-09-18 re-statement) | Status | Evidence |
|---|---|---|---|
| BF-1 | commands.md §5.2 hint + generator + scenario-04 fixture = project-model.md §12.5 hint, byte-identical; fixture regenerated, no test changes | **Applied per spec** | My `grep -o` extraction: one unique hint string ×4 (project-model §12.5, commands §5.2, generator literal, regenerated `scenarios/04-invalid-no-partial/messages.json`) — byte-identical. `generate-fixtures.mjs --check` = 73/73 byte-identical (re-run, exit 0). `git diff 275f472..HEAD -- commands.md` = exactly the one hint line. P-rereview1: same. |
| BF-2 | §9 one sentence: releasing backend's queries fail `workspace_closed` and never re-open; any backend's on-demand open claims at epoch+1 with new `openedAt`; **no** blanket "any query reopens" | **Applied per spec** | "Scoped precisely" sentence present (workspace.md line 862); the forbidden phrase occurs **0** times in workspace.md and 07.md (my grep). `git diff dabfcff..HEAD -- workspace.md` shows exactly this sentence + the BF-3 row. P-rereview1: same. |
| BF-3 | §11 `takeoverWorkspace` row admits `project_unavailable` (claim succeeded, §4.3 load failed ⇒ §7.5 block) | **Applied per spec** | §11 row verified in the tree with the exact documented parenthetical; premise (both takeover paths install a blocked session on claim-succeeded/load-failed) was code-verified by the BF step and re-confirmed structurally here (takeover's fresh path via `performClaimAndLoad`, stale path via the §4.3 `loadProjectDir` after the claim). |
| BF-4 | dependencies.md §3: add `parseDocumentBytes` (+ `ByteParse`), scoped as the strict pass-1 byte parser consumed by workspace loads | **Applied per spec** | §3 row present (dependencies.md line 79) with the documented scoping; export verified public (`packages/project-model/src/index.ts:42`) and consumed by 4 workspace files (ownership/service/session/envelope). Records an already-public export; no boundary change. P-rereview1: same. |
| BF-5 | 07.md interpretation #1 wording + request (1) broadened + item 9 (release refused while pending); 04.md N1 line; 05.md type list corrected | **Applied per spec** | All verified in tree by the BF step with code premise checks; P-rereview1 confirms 05.md's list matches the actual `export type` block (11 names) and 07.md interpretation #1 matches the BF-2 scope. The "12 vs 11" prose slip is in the repair handoff §11 verification prose only (see §5.1 item 4). |

**No silent contract-meaning change beyond the documented sentences:** the
entire contract delta since the original gate acceptance (`git diff
275f472..HEAD -- docs/contracts/`) is exactly: commands.md 1 line (BF-1),
dependencies.md 1 line (BF-4), workspace.md = the `dabfcff` amendment
(19 hunks + 3 insertions) + the BF-2 sentence + the BF-3 row. Nothing else in
any contract changed during the campaign.

---

## 4. New-architectural-risk judgment (repair campaign, `87394e3..HEAD` map)

The campaign's delta (workspace 17 src + 11 repair test files + 1 test,
commands 3 files, 3 contracts, 6 fixture files, 2 root test files, docs)
introduces **no new architectural risk of the classes the original gate
cleared**:

- **New global services:** none — no `globalThis` in src; no singletons; the
  workspace service is per-call; no background processes/workers.
- **Hidden state:** none new — the claim files are contract-defined on-disk
  state (§6.3/§6.5); the `ownershipReverify` flag (E2) is a documented
  from-disk re-verification, not hidden state; session state is explicit on
  the session object.
- **New cross-package dependencies:** none — dependency graph and `.`-subpath
  imports unchanged (verified above); no cross-package internal imports.
- **New runtime dependencies:** none — `package.json`/`package-lock.json`
  untouched for the entire campaign (0-line diff since `4493262`); builtin
  usage within the §4.1 allowlist; `node:child_process` confined to root
  `tests/` (test plane, documented rationale).
- **Widened public surfaces:** none — all three `index.ts` surfaces
  unchanged; the fixture delta is exactly the documented set (generator +
  hint line + `claimObj`/`claim-0` emissions; scenario-04 `messages.json` 1
  line; scenario-08 `messages.json`/`scenario.md` `snapshotState: "ok"` —
  the contract-required field; two new `claim-0` `disk-before` fixture files
  required by the amended §6.2 self-reclaim row).
- **Test-plane additions** (`tests/crash/ownership-child.ts`,
  `tests/ownership-claim-2026-09-18.test.ts`): legitimate (pinned esbuild +
  `node:child_process` in the test plane; disposable roots; documented
  placement).
- **`node-ambient.d.ts` growth:** typecheck-only ambient declarations for
  test-only `node:fs` surfaces — typecheck plane, no runtime dependency;
  recorded per repair group.

**`pointerSegment` adjudication.** The O2 helper
(`segment.replace(/~/g,'~0').replace(/\//g,'~1')`, RFC 6901 order) is
exported from `packages/workspace/src/errors.ts:581` and imported by
`service.ts`/`session.ts`/`envelope.ts` — **all within the workspace
package** — and is **not** re-exported from `index.ts` (verified absent from
the public surface). It is therefore a **legitimate in-package export**:
normal module decomposition inside one package, covered by
check-boundaries (in-package relative specifiers), with no public-surface
widening. Commands keeps its own module-local copy
(`validate-request.ts:102`, not exported) because the dependency direction
forbids commands→workspace and project-model's `escapePointer` is not a
public export; the two-line pure-function duplication is the recorded,
deliberate consequence of that edge direction (repair handoff §12) and is
acceptable — promoting it to a project-model public export would widen the
Gate-A-scoped §3 surface for a two-line helper (disproportionate). **Not a
boundary smell.**

---

## 5. Carried-forward adjudication

### 5.1 Item table

| # | Item | Blocks Gate B? | Where tracked |
|---|---|---|---|
| 1 | Live-workspace `node_modules` corruption (P-rereview1 carried item 1) | **No — CLOSED.** The orchestrator's env-fix (orchestration.md final line) root-caused it (stray self-referential `node_modules/node_modules` symlink; removed; no reinstall) — I verified the link is **absent** and re-ran `npm run check-deps` + `npm run build` on the live tree: both exit 0. The required pre-packet-08 environmental pre-step is done. | orchestration.md env-fix line; this review §6. |
| 2 | project-model O1/O2-class observations (P-rereview1 item 2; repair handoff §12) | **YES — escalated to BLOCKS (see §5.2, G1–G3).** The record's "separate gate" framing is inaccurate: project-model is packet 05, **inside** Gate B's scope (04–07); the contract clauses they violate (project-model.md §12.1/§12.5) were accepted at Gate A and are binding; my probes show one of the two classes is **service-critical** (P1-class), not merely diagnostic. | repair handoff §12 (verified present), P-rereview1 item 2, orchestration O1/O2 line — and, from this verdict, as required-change items 1–3 below. |
| 3 | Scan-time read-through-symlinked-child (P-rereview1 item 3) | **No.** With a valid external envelope behind a symlinked `scenes` child present at scan time, the scan's loadability probe reads the foreign bytes for its report but acts on nothing (no completion write, no claim; external bytes untouched; on-demand open refused via `verifyChildDir`). Within the documented B3 policy/limitation (2) — "the scan's single write is gated; an escaping child of a contained project is reported, never written". Minor report-accuracy nuance (`loadable: true` on a project whose open will be refused) — candidate for a later hardening note, not a contract violation. | repair handoff §5 limitation (2); P-rereview1 item 3. |
| 4 | "12 vs 11" type-count prose slip (P-rereview1 item 4) | **No.** Authoritative count is **11** (`BoxComponent, BoxMaterial, CameraComponent, Entity, EntityComponents, Manifest, Quat, Scene, SceneRef, TransformComponent, Vec3`); 05.md's corrected list matches the actual `export type` block; the wrong "12" occurs only in the repair handoff §11 BF-5 verification prose (a record, not a contract). Corrected in this review; the handoff record is not rewritten. | P-rereview1 item 4; this review. |
| 5 | Original gate's carried-forward non-gating items (gate-b.md §5): 04-N2 (bundler `moduleResolution` directory imports), 05-N2 (`serializeCanonical` kind dispatch), 05-N3 (wrong-length-array `found` = length), 06-F2 (32-detail cap unreachable; future regression test), 06-F3 (explicit `origin: null` — stricter reading), 06-F4 (args error key order — cosmetic), 07-F3 (invalid `projectId` code-set divergence — genuinely ambiguous, all entry points reject), 07-F5 (wrong cross-reference comment — source, fix when next touching the file) | **No — remain non-gating.** None was made worse by the repair (the 2026-09-18 re-statement explicitly did not close them; my structural checks introduced no contrary evidence). Note for the record: my §5.2 probes confirm 05-N3's behavior (wrong-length arrays report the length in `found`) — that summary is precisely what keeps the model's scene path from recursing into a length-1 deep chain at `position`; it does not bound the other reachable shapes. | gate-b.md §5 (all still listed there). |
| 6 | docs/STATUS.md staleness (new observation, this review): the packet 07 row still ends "independent packet 07 re-review pending" (superseded by `d19b3e6`, ACCEPTED) and the Gate B table row still carries the pre-reopen acceptance wording. | **No** (recording hygiene, not an acceptance criterion) — but the next orchestrator step must update the STATUS rows to record this round-1 verdict (CHANGES REQUIRED) so the gate state is accurate. Per my task constraints I do not edit STATUS. | this review; orchestrator's next step. |

### 5.2 New findings (gate round 1 — my own probes on the live tree)

The project-model carried-forward observations (§5.1 item 2) were recorded as
out-of-scope P2-class items "confirmed still present" by code inspection. My
independent probes (public APIs only; esbuild bundles of
`packages/project-model/src/index.ts` and `packages/workspace/src/index.ts`;
disposable `mkdtemp` roots; 4000-level nested arrays constructed as **JSON
text** and persisted — never as backend-written documents) establish that
they are reachable, normative violations, and — for one shape —
service-critical:

**G1 — P1 (R12 acceptance property not met): one corrupted *envelope* can
still abort the entire service startup.** A persisted `scenes/main.json`
that is valid JSON with `scene.entities` replaced by a 4000-level nested
array (length-1 chain) makes `openWorkspaceService` **throw
`RangeError: Maximum call stack size exceeded` during the startup scan** —
the stack originates in the model's `boundedFound`
(`packages/project-model/src/validate.ts:104–115`), reached via
`validateScene` from `validateEnvelope` (envelope.ts:164) with **no
try/catch** at the scan's envelope-load site (`scanEntry`, service.ts — the
manifest load above it *is* try/catch-wrapped; the envelope load is not).
Every project in the root — healthy ones included — is then unserved until
the operator finds and repairs the one corrupted file. This is the same
failure class the 2026-09-18 review rated **P1** as R12 ("one corrupt
project stops all projects from being served, contrary to workspace
§7.5/§10") and whose acceptance was "a startup test with a corrupt project
next to a healthy project … the healthy project usable" — the R12 repair
(`aa03976`) closed the discriminator-coercion shape (`{"toString":0}`) but
not the property: the startup-scan-abort property is still violated by the
deep-nested shape, and the orchestration's A2 line ("validateEnvelope total
on JSON data; startup scan never aborts from one corrupt project") is
refuted for this shape. Root cause is the model, not the workspace:
`boundedFound`'s per-level array cap (≤16 elements → recurse) is **not a
recursion bound** — a length-1 chain recurses one stack frame per level.
Reachable shapes I demonstrated (all throw through the public model API):
`entities[0]` = deep chain; `parentId` = deep chain; `position =
[deep, deep, deep]`; and through `validateManifest`: `scenes[0].path` = deep
chain. (A deep chain at `position` as a whole length-1 array is *not*
reachable into the recursion — the wrong-length-array error reports the
length in `found` (05-N3) — which is why the scene path looked guarded in
code inspection; the reachable shapes are the ones above.)

**G2 — P1 (workspace.md §7.5 block semantics): on-demand open on a corrupted
manifest throws from the public API instead of returning a structured
block.** With `project.json` valid-JSON but `scenes[0].path` a 4000-level
chain: the startup scan is guarded (reports
`corrupt manifest; retained until operator repair` — the scan-path
try/catch), but the on-demand query/mutation path goes through
`loadManifest` (session.ts:301–340, **no try/catch** around
`validateManifest`) and the public `query` **throws `RangeError`** instead
of the §7.5/§4.3-step-8 structured `project_unavailable
{ reason: "manifest_invalid" }` ("the project is **blocked**: commands
return `project_unavailable` … queries fail the same way"). Same root cause
as G1.

**G3 — P2 (project-model.md §12.5): model error `path` segments are not
RFC 6901-escaped.** A scene document with an unknown transform key `a/b`
yields `path: /entities/0/components/transform/a/b` (verified through public
`validateScene`) — an invalid JSON Pointer (must be `a~1b`). Violates
project-model.md §12.5 line 546 ("`path` — JSON Pointer (RFC 6901) to the
offending value"). Same class as the commands/workspace O2 that the campaign
fixed (`69b1a17`); the model sites were recorded out of the authorized fix
scope (repair handoff §12: validate.ts:395/421/426/460/479/804) and are now
behaviorally confirmed. The model's byte-parser side is already escaped
(`parse-bytes.ts:29`, pinned by `byte-input.test.ts` B6) — only the
validator's dynamic-key sites are unescaped. The pointers land in public
workspace payloads verbatim (`scene_invalid` carries the model error
objects, §4.3 step 6).

**Normative basis.** G1/G2 violate project-model.md §12.1 (line 451–453):
"Validation is pure and total: … it **never throws on malformed data**
(errors are returned values)" — and, at the workspace surface,
workspace.md §10 (the scan "claims no ownership" / performs no abortive
work) and §7.5 (block, never crash, never auto-repair). G3 violates
project-model.md §12.5 line 546. The violated clauses are **accepted
contract text** (Gate A, packet 01) — no contract diff is required; the
implementation must be brought into conformance, exactly as the campaign did
for the commands package (O1/O2).

**Severity.** P1 for G1/G2 (service-wide availability from a single
externally-corrupted file — the same class the reopened review rated P1 for
R12; no data loss: bytes are retained, and the corruption is reachable only
through external modification, since the backend never writes such
documents — but §7.5/§10 do not condition their guarantees on the corrupter
being non-malicious). P2 for G3 (diagnostic format in public payloads).

---

## 6. Packet 08 readiness

**Contract stability.** Packet 08 (Runtime and three.js adapter, Gate C)
consumes the Gate-A contract pack: `runtime.md` (packet 03),
`project-model.md` (packet 01), `export.md`, `sessions.md`, and
`dependencies.md` (§3 surface, §4.1 edges incl. the three-adapter row, §7
pins). `git log 87394e3..HEAD -- <those files>` shows **no campaign
changes**: they are unmodified since the 2026-09-17 Gate-A F1–F4 repair
(`b6422e4`); the only campaign contract edits are workspace.md (the
amendment + BF-2/3), commands.md (1 BF-1 line), dependencies.md (1 BF-4
line) — none of which touches the runtime/three-adapter rows or pins.
**The contract pack's text is stable.** However, the model *implementation*
on which the runtime's snapshot-integrity work builds (project-model.md
§12.1: `serializeCanonical` is "the single canonical-bytes source … the
runtime snapshot-integrity test") currently violates that accepted contract
(G1–G3 above). Contract authority is therefore stable **as text**, but the
implementation-conformance precondition is not met until the required
changes below land.

**Toolchain (all re-run by me on the live tree, HEAD `3d3b9d9`, real
outputs):**

| Command | Exit | Result |
|---|---|---|
| `npm test` | 0 | `Test Files 39 passed (39); Tests 551 passed (551)` (22.96 s) |
| `npm run build` | 0 | prerequisite chain ran: check-deps OK → check-boundaries OK → `tsc --noEmit` clean ×3 (strict) → `build: done (0 built, 2 skipped)` (editor/preview land in packet 10 — expected) |
| `npm run check-deps` | 0 | `check-deps: OK` — esbuild 0.28.2 / typescript 5.9.3 / vitest 5.0.1 `= §7 pin`; 8 pins pending (consumer units unimplemented, packets 08–11 — correct per §2 create-only-when-implemented); "declared dependency specs: all exact versions (no ranges)" |
| `npm run check-boundaries` | 0 | `OK — 3 package(s) [commands, project-model, workspace], 66 source file(s), 286 specifier(s) checked; no boundary violations` |
| (supplementary) `generate-fixtures.mjs --check` | 0 | `check OK: 73 files byte-identical, digests + canonical stability verified` |
| (supplementary) `vitest run tests/ownership-claim-2026-09-18.test.ts` | 0 | `6 passed (6)` — real two-process + SIGKILL claim suite |

**Environment.** Clean. The node_modules env-fix is recorded
(orchestration.md: stray self-referential `node_modules/node_modules`
symlink removed; no reinstall) — I verified the link is absent and
check-deps/build green on the live tree; no other outstanding environmental
item.

**Readiness statement.** Packet 08 is **NOT clear to start**: the gate
verdict below is CHANGES REQUIRED, and the required model/workspace
conformance fixes (items 1–3) are in packet 05/07 scope and land **before
packet 08** by gate discipline. The toolchain is green and the contract pack
is textually stable, so once the fix step is recorded and gate B re-review
round 2 renders its verdict, packet 08's prerequisite (Gate B accepted) will
be satisfiable without further toolchain or contract-pack work. STATUS
currently shows packet 08 as "pending; blocked" — consistent.

---

## 7. Overall verdict

**CHANGES REQUIRED** — post-repair architectural re-adjudication of Gate B
(packets 04–07), round 1.

The 12-step repair campaign and the R9 contract amendment are **verified
sound at the architectural level**: the amendment record is complete and
self-consistent (§1); layering and boundary discipline held across all 12
steps (§2); BF-1…BF-5 are closed exactly per spec with no silent
contract-meaning change (§3); no new architectural risk was introduced (§4).
The packet 07 findings (R1–R17, O1/O2, L1) stand as ACCEPTED by the
independent re-review, and I have found no reason to disturb that.

However, my gate-level adjudication of the carried-forward project-model
observations established new findings **G1–G3 (§5.2)**: a P1-class
availability defect of the same class the reopened review rated P1 (R12) —
one corrupted envelope can still abort the entire service startup, and one
corrupted manifest makes on-demand opens throw from the public API instead
of blocking — plus a P2 normative-contract violation (unescaped RFC 6901
segments in model error paths). All three are violations of **accepted,
binding contract clauses** (project-model.md §12.1/§12.5; workspace.md
§7.5/§10) inside this gate's package scope (packet 05, with the workspace
surface in packet 07). A P1-class in-scope defect with a refuted recorded
claim ("startup scan never aborts from one corrupt project") cannot be
carried forward as non-gating; the gate cannot be accepted while it is open.

**Required changes (specific and implementable; owner: one repair step
before packet 08, then gate B re-review round 2):**

1. **G1/G2 root cause — bound the model's `boundedFound`**
   (`packages/project-model/src/validate.ts:104–115`) with a depth/node
   budget, using the commands-O1 reference pattern already in the tree
   (`packages/commands/src/errors.ts`, `69b1a17`: depth ≤ 64 AND nodes ≤
   4096, fresh budget per error, degrade the whole `found` to the bounded
   marker string). Acceptance: `validateScene`/`validateManifest` are total
   on JSON-parseable input per project-model.md §12.1 — no throw escapes for
   the 12,000-level construction nor for 4000-level length-1 chains at
   `entities[0]`, `parentId`, `position` elements, `scenes[0].path`,
   `scenes[0].id` (the five shapes probed in §5.2); structured model errors
   with complete, valid pointers instead.
2. **Complete the R12 property at the workspace surface** (regression
   tests, RED-first before/after the model fix): a startup test with a
   corrupt project **next to a healthy project** covering both demonstrated
   shapes — corrupt envelope (deep `scene.entities` chain) and corrupt
   manifest (deep `scenes[0].path` chain) — asserting: the scan reports the
   corrupt project blocked with its bytes retained byte-identically (no
   auto-repair), the healthy project is created/queried/mutated in the same
   root through the same service, and on-demand open/query/mutation on the
   corrupt project returns structured `project_unavailable` (the §4.3 codes)
   — never a throw from the public API.
3. **G3 — RFC 6901-escape the model's dynamic-key `path` sites**
   (validate.ts:395/421/426/460/479/804) with the same `~`→`~0` then
   `/`→`~1` helper convention the campaign applied to commands/workspace
   (audit static segments as the O2 step did). Acceptance: an `a/b` key
   yields `…/a~1b`, an `a~b` key yields `…/a~0b`, at every dynamic site;
   pointers parse as valid RFC 6901 (sweep test, as in the O2 tests).
4. **Bounded docs line (non-blocking sub-item of the same step):** add
   `.thirdlight/claim-<e>` (claim file, §6.3) to the workspace.md §3 layout
   block (lines 74–84) and optionally align the line-83 "at most 16 kept,
   oldest pruned" note with the §7.4 exemption (line 754) — the §0 residual
   notes 1–2 recorded at application; small docs re-check, no source.

Owner step: a single pre-packet-08 repair step (packet 05 model scope +
packet 07 workspace regression tests + the §3 docs line), RED-first
regressions, full suite + fixture `--check` + the four toolchain commands,
handoff section + STATUS row recorded. **Then gate B re-review round 2
renders the final gate verdict.** Packet 08 remains not started and is not
auto-cleared (work order: "Only then start packet 08 — Runtime and
three.js adapter. Do not auto-start it.").

**Recording notes (for the orchestrator's next step, not for this commit):**
the docs/STATUS.md packet 07 row ("independent packet 07 re-review
pending") is stale since `d19b3e6`, and the Gate B table row should record
this round-1 verdict (CHANGES REQUIRED) with the four items above.

No reviewer approval by anyone is claimed or implied; this verdict is
rendered solely by this round's reviewer from the evidence above. Nothing
was pushed; exactly one commit stages only this document.

**Evidence limits (honest statement).** Established here: the amendment's
applied text vs the accepted decision (block-level extraction, 22/22);
contract self-consistency grep-level (stale-mechanism sentences: 0);
structural layering (single mutation/claim path, surfaces, builtins,
dependencies — real greps + check-boundaries re-run); the full toolchain on
the live tree (real outputs); BF closure (real greps/diffs); the G1–G3
behavior (real public-API probes on the live tree, disposable ext4 roots).
**Not re-established here:** the per-finding behavioral repairs R1–R17,
O1/O2, L1 (P-rereview1's accepted evidence is taken, not re-derived);
power-loss durability; visual/browser behavior (none exists yet); the
two-claimer race is now covered by real two-process tests (6/6 re-run), but
no new probabilistic race testing was performed. Probe artifacts live under
`/tmp/tl-gatebr/` (bundles + probe scripts); they are described above and
not required to be retained.