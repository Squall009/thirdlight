# Gate B — Architectural review of packets 04–07 — **accepted with bounded follow-ups**

Date: 2026-09-18. Independent architectural review (docs-only; no code, tool, or
contract changes made during this review). Scope: cross-packet consistency, gate
discipline, verification suite, sampled recorded repros, carried-forward
accounting, provenance — not a re-run of the per-packet reviews.

## Verdict

**Accepted — Gate B (packets 04–07), with bounded follow-ups BF-1…BF-5
(consistency fixes: docs + fixture regeneration only, no source).** No blocking
findings: every P2 observation and contract-change request across 04–07 is
either non-gating (carried forward, listed below) or a bounded consistency fix
recorded below. Apply BF-1…BF-5 via a separate repair step **before packet 08**,
then the small docs re-checks noted per item. Packet 08 (Gate C) stays not
started until that repair step is recorded; this gate acceptance does not
auto-clear it.

## 1. Cross-packet consistency (verified)

- **Module ownership end-to-end:** `packages/*/package.json` — project-model:
  **no dependencies** (leaf); commands: `@thirdlight/project-model@0.1.0`
  only; workspace: `@thirdlight/commands@0.1.0` + `@thirdlight/project-model@0.1.0`
  only. All cross-package imports use the `.` subpath (the only declared
  subpath) and are within the dependencies.md §4.1 table (grep-verified per
  edge). Node built-ins appear only in workspace src (`node:fs` ×5,
  `node:path` ×5, `node:crypto` ×1 — within the §4.1 allowlist
  `fs`/`path`/`crypto`/`os`); project-model and commands sources have none.
- **Public surfaces vs §3:** project-model index.ts exports the full §12.1
  entry set + `ERROR_CODES`/`KNOWN_VERSIONS`/types, **plus one extra**:
  `parseDocumentBytes` (05-review N1 — now consumed by workspace for
  envelope/manifest/ownership loads per workspace.md §4.3 step 1; recorded,
  see BF-4). commands index.ts: `applyMutation`, `createCommandState`,
  `ERROR_CODES`, `MAX_REVISION`, wire types — within §3 scoping as the 06
  review adjudicated. workspace index.ts: `openWorkspaceService`,
  `WorkspaceService` (runCommand, query, all five §11 operator operations,
  scan, dispose, backendId, lastScan), `ERROR_CODES`, types + type-level
  re-exports + `defaultWriteOps` (config seam, 07-review adjudicated
  legitimate). No internal-file or test/fixture imports across packages.
- **Edge tables vs code:** `npm run check-boundaries` (check 1, mechanical)
  passes — see §3; the §4.1 table itself was row-by-row verified against the
  tool at 04-rereview2. Spot greps above agree with the table.
- **Toolchain/pins vs §7:** `npm run check-deps` — installed
  esbuild@0.28.2, typescript@5.9.3, vitest@5.0.1 = §7 pins; the 8 remaining
  pins are *pending* because their consumer units are unimplemented
  (packets 08–11) — correct per §2 create-only-when-implemented; all
  declared specs exact (no ranges).
- **No hidden global services / single mutation path:** no `globalThis`
  assignments in any package source; `applyMutation` is called in exactly one
  place — `packages/workspace/src/service.ts:182` (`runCommand`), the sole
  command executor (dependencies.md §4.3). Mutation path: workspace
  `runCommand` → commands `applyMutation` (envelope → revision check →
  `revision_exhausted` → args → op → result-scene re-validation via the
  model) → durable `W` → publish → ack. The model is the single value
  authority (re-validation of the resulting scene inside `applyMutation`;
  `validateScene` at envelope load). No second mutation or value authority.

## 2. Gate discipline (verified)

Per-packet precedents honored: **04** — review (R1–R7) → repair `8daa214` →
re-review (F1–F4, changes still required) → re-repair `42a4032`/`90428d7` →
rereview2 **accepted** at `862fb10` (2 non-gating P2s N1/N2). **05** —
implementation `097e560`, **accepted first review** at `dd85ff0` (4 non-gating
P2s N1–N4). **06** — implementation `a4e8b2a`, review **1 P1** (F1 pipeline
order vs commands.md §6.1 step 4) + 3 P2s → repair `b15786a` → **re-review
accepted** at `7ca05cc` (independent 21-probe round; F2–F4 carried forward).
**07** — implementation `be58767`/`11ae4d3`/`afd1467`, **accepted** at
`3ba1661` (5 non-gating P2s F1–F5; requests (1)/(7) stand).

Commit chain `862fb10..HEAD` verified with `git log --oneline` — exactly the
16 commits in the recorded sequence (862fb10 → 2ff892b → 097e560 → 9287f7a →
dd85ff0 → 4018e97 → a4e8b2a → e94f44f → b15786a → 0972456 → 7ca05cc → b655d2c
→ be58767 → 11ae4d3 → afd1467 → 3ba1661 → c3c9217), none missing or extra.
`git show --stat` spot-checks: `097e560` (project-model package + lockfile
registration only), `a4e8b2a` (commands package only), `b15786a` (apply.ts /
validate-request.ts / new ordering test + docs; no other code files),
`be58767` (workspace package + root crash tests + lockfile name fix only),
`3ba1661` (docs-only: 07-review.md, 07.md note, STATUS row) — all match their
records.

## 3. Verification suite (re-run by this review, real outputs)

| Command | Exit | Key output |
|---|---|---|
| `npm run check-deps` | 0 | `check-deps: OK` — esbuild 0.28.2 / typescript 5.9.3 / vitest 5.0.1 `= §7 pin`; 8 pins pending (consumers unimplemented); "declared dependency specs: all exact versions (no ranges)" |
| `npm run check-boundaries` | 0 | `OK — 3 package(s) [commands, project-model, workspace], 54 source file(s), 220 specifier(s) checked; no boundary violations.` |
| `npm run typecheck` | 0 | `tsc --noEmit` clean per package (commands, project-model, workspace) |
| `npm run build` | 0 | prerequisite chain (check-deps → check-boundaries → typecheck) runs first; `done (0 built, 2 skipped)` — editor/preview entries land in packet 10 (expected) |
| `npm test` (full, once) | 0 | `Test Files 27 passed (27); Tests 438 passed (438)` — matches the recorded 438/438 |
| `node fixtures/commands/tools/generate-fixtures.mjs --check` | 0 | `check OK: 71 files byte-identical, digests + canonical stability verified` |

## 4. Sampled recorded repros (independent, public APIs only)

One disposable `/tmp/tl-gateb` workspace (repo `node_modules` symlinked;
probe bundled from source with pinned esbuild 0.28.2; throwaway project roots
under `/tmp/tl-gateb/roots`; fixtures read-only). **15 passed, 0 failed,
exit 0:**

- **05 golden-byte stability:** quaternion-round-trip fixture →
  `serializeCanonical` output **byte-identical to the golden**
  `expected/quaternion-round-trip.json` (1800 B); scrambled key order
  (reversed at every level) → byte-identical canonical output;
  `ERROR_CODES` = exactly 24 §12.6 codes.
- **06 revision ordering (06-rereview RA1/RA3/S6 class):** stale
  `expectedRevision` + wrong-type `entityId` ⇒ `revision_conflict`
  (cls `conflict`, both revisions carried); stale + `transform: {}` ⇒
  `revision_conflict`; **fresh** + wrong-type `entityId` ⇒ `field_type` at
  `/args/entityId` (args pass runs only when fresh).
- **07 dedup/retry (07-review A-group):** `createProject` → rev 0; first
  `createEntity` ⇒ rev 1, `createdId box-0001`, `duplicated:false`;
  byte-identical re-issue ⇒ `duplicated:true`, recorded rev 1; **same
  `requestId`, different content ⇒ `request_id_reused`** (cls `conflict`,
  `currentRevision:1`); disk envelope a complete document (rev 1, 1 record).
- **07 stale-ownership takeover (07-review B1 class):** ownership record
  naming an absent pid (4194297 < pid_max, real `/proc`) ⇒ query fails
  `project_unavailable {reason: stale_ownership}` (no automatic takeover);
  explicit `takeoverWorkspace` ⇒ `ok`, `lockEpoch:1`, new backendId; query
  then serves rev 0.

## 5. Carried-forward items — accounting (all of 04–07)

**Blocking: none.** All P2s were adjudicated non-gating in their per-packet
reviews; none changes measured behavior.

**Bounded follow-ups (consistency-only; apply via a repair step before
packet 08; NOT applied by this review):**

- **BF-1 — scenario-04 quaternion hint drift** (contract-change request
  (7); recorded in 06, re-recorded in 07). The commands.md §5.2 example and
  the fixture generator carry the stale hint `"identity rotation is [0, 0,
  0, 1]"`; the accepted project-model (project-model.md §12.5, line 541;
  pinned by the model's own tests) emits `"normalize to unit length; e.g.
  45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]"`.
  Runtime behavior is already correct (commands passes the model's error
  objects through verbatim, as §5.2 mandates; the scenario-04 test blurs
  exactly this one hint). **Judgment: does not block Gate B — bounded
  consistency fix.** Exact files (docs + fixture regeneration only, no
  source): `docs/contracts/commands.md` (§5.2 example hint, line 222),
  `fixtures/commands/tools/generate-fixtures.mjs` (hardcoded hint, line
  678), `fixtures/commands/scenarios/04-invalid-no-partial/messages.json`
  (regenerated by the generator). **Re-review:** touches commands.md
  (packet 02 / Gate A scope) + a fixture ⇒ per STATUS discipline the
  relevant gate re-opens; it is a **small docs re-check** (diff = one hint
  string that must match project-model.md §12.5 byte-for-byte; re-run
  `generate-fixtures.mjs --check` — 71/71 after regeneration — and the
  scenario-04 suite; no test changes).
- **BF-2 — workspace.md §9 clarification** (contract-change request (1),
  broadened per 07-review F1): one sentence — the releasing backend's
  queries fail `workspace_closed` and never re-open; **any** backend's
  on-demand open (query included) claims a released record at epoch+1 with a
  new `openedAt` (per §6.1/§6.2, which the code already follows). File:
  `docs/contracts/workspace.md`. Re-review: small docs re-check (Gate B
  scope, packet 07 contract).
- **BF-3 — workspace.md §11 code-table addendum** (07-review F2): permit
  `project_unavailable` as a `takeoverWorkspace` outcome (claim succeeded,
  §4.3 load failed ⇒ §7.5 block). File: `docs/contracts/workspace.md`
  (same docs re-check as BF-2).
- **BF-4 — dependencies.md §3 surface list** (05-review N1, now consumed
  cross-package): add `parseDocumentBytes` (+ `ByteParse` type) to the
  project-model `.` subpath list, scoped as the strict pass-1 byte parser
  (project-model §12.3 pass 1) consumed by the workspace's envelope/
  manifest/ownership loads (workspace.md §4.3 step 1). Records an
  already-public export (the option N1 itself proposed); no boundary
  change. File: `docs/contracts/dependencies.md` (§3 row). Re-review: small
  docs re-check (Gate A scope, packet 03 contract).
- **BF-5 — handoff wording fixes (no contract text ⇒ no gate re-open):**
  `docs/handoffs/07.md` — correct interpretation #1's wording per 07-F1
  (releasing backend vs any backend; re-claim writes a new `openedAt`) and
  broaden the recorded request (1) text to the cross-backend case; add one
  line (07-F4): `releaseWorkspace` is refused while a pending external
  change is unresolved (resolve first). Optional, cheap:
  `docs/handoffs/04.md` — one-line N1 limitation (typecheck validation is
  config-plane; per-file `@ts-nocheck`/`@ts-ignore` are honored by tsc and
  not blocked); `docs/handoffs/05.md` — correct the type-export list per N4
  (actual: BoxComponent, BoxMaterial, CameraComponent, Entity,
  EntityComponents, Manifest, Quat, Scene, SceneRef, TransformComponent,
  Vec3, …).

**Non-gating, carried forward, no action at this gate (recorded so nothing
is lost):** 04-N2 (directory imports pass the boundary lexical fallback but
fail under bundler resolution tsc — no action while the base config keeps
`moduleResolution: bundler`); 05-N2 (`serializeCanonical` heuristic
document-kind dispatch — correct for every valid document; no M1 action);
05-N3 (wrong-length-array errors report the length, not the value, in
`found` — cosmetic vs §12.5); 06-F2 (the 32-detail cap is unreachable
through the public API in M1 — add a regression test when a future op can
exceed 32); 06-F3 (explicit `origin: null` rejected — stricter defensible
reading; one-line contract clarification only if the owner wants acceptance);
06-F4 (args-level error key order vs the scenario-04 fixture display order —
cosmetic; failures are never persisted); 07-F3 (syntactically invalid
`projectId` in mutations ⇒ `project_not_found` vs `invalid_request` in
queries — contract genuinely ambiguous; all three entry points reject and
traversal is unreachable (anchored ID regex + realpath containment);
optional one-line clarification, not safety-relevant); 07-F5 (wrong
cross-reference in a code comment — a **source** change, so excluded from
the docs-only follow-up set; fix when next touching the file).

## 6. Provenance (verified)

- Working tree: **clean** (`git status`: nothing to commit). Note: the
  prompt expected an uncommitted `docs/orchestration.md`; in fact it is
  tracked and was last committed by the orchestrator at `c3c9217` — the tree
  is clean even without it. Nothing staged, committed by this review, or
  touched.
- Nothing pushed: `git ls-remote origin main` =
  `87394e3504d21f8168130f40d4ef20a455a5eefd` (origin/main still `87394e3`);
  local main is 32 commits ahead.
- This review makes one docs-only commit (gate-b.md + STATUS rows).

## 7. Evidence limits (honest statement)

Established by this gate: cross-packet module-ownership/edge/pin
consistency for the implemented units (real check outputs + source
inspection); the single-mutation-path property; the verification suite
reproducing the recorded 438/438 + 71/71 fixture invariants; the 15 sampled
repros on the real public APIs; gate discipline and commit provenance.
**Not established here (unchanged from the per-packet records):**
power-loss durability (only real-SIGKILL process-crash is tested, at both
crash points, as honestly recorded in handoff 07); any visual/browser
behavior (none exists yet — packets 08–10); bundle graph + forbidden-content
checks 3–4 (deferred to packets 10/12 per dependencies.md §5); CI (none
configured in this repo); and the two-simultaneous-claimer rename race on
the claim primitive (bounded-retry logic exercised by design, not by a real
two-process race — recorded in 07-review). No reviewer approval is claimed
beyond this record.

**Next action:** repair step applying BF-1…BF-5 (docs + fixture
regeneration only) with its small docs re-checks, **before packet 08**.
Packet 08 (Runtime and three.js adapter, Gate C) remains not started and is
not auto-cleared by this acceptance.