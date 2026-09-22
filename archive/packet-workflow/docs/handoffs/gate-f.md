# Gate F review — durable content and backend/MCP (packets 20–25)

2026-09-18/19. Reviewer: this session (not the authors of packets 20–25). No
implementation, contract, decision, fixture or tool was changed by this review;
no packet was started. Verdict is this record only — it is **not** a separate
reviewer approval, not owner approval, and not a claim of browser or desktop
verification.

## 1. Scope and method

Gate F covers packets 20–25 (model v2 + pure migration; pure
content/property commands; pure prefab capture/instantiation; workspace
content publication + migration-copy; bounded GLB inspection; content HTTP
services + projection + MCP parity) per `docs/planning/m2-plan.md` §5 and the
Gate review prompt in `docs/planning/m2-packets.md` (¶559–570).

Method: fresh reads of the accepted `docs/contracts/**` and decision 0002;
scoped diff review of the uncommitted packet 20–25 tree; execution of the
required root checks on the current tree; independent re-derivation of one
durability, one determinism and the security negatives; adjudication of every
recorded contract-change request against the binding text. Handoffs were read
as context only and were not treated as proof.

### 1.1 Executed by this review (raw results)

| Check | Result |
|---|---|
| `npm test` | **81 files / 1131 passed**, exit 0 (run twice: before and after the node_modules accident below) |
| `npm run typecheck` | exit 0 (all 11 packages) |
| `npm run check-deps` | `check-deps: OK`, all pins exact, exit 0 |
| `npm run check-boundaries` | `OK — 11 package(s), 187 source file(s), 680 specifier(s)`, exit 0 |
| `npm run build` | `build: done (4 built, 0 skipped)`, exit 0 |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | `check OK: 33 check group(s) passed, 0 problem(s)`, exit 0 |
| `npx vitest run tests/m2-crash.test.ts` | **6/6** real-subprocess `SIGKILL` boundary tests passed |
| `npx vitest run tests/integration/m2-content/content-security.test.ts` | **11/11** passed (real backend child + real fs + real stdio MCP + real WS) |
| `npx vitest run packages/protocol/src/content.test.ts` | 21/21 passed (U1–U7 re-derived) |
| `npx vitest run packages/workspace/tests/m2-storage.test.ts -t TTL` | stage-expiry/replay case passed |
| Own esbuild-bundled probe of `openWorkspaceService().migrateProjectCopy` | source v1 bytes unchanged after success **and** refusal; destination byte-equal to the accepted fixture; marker removed; second call `migration_destination_exists` |
| Python recompute of `recipeDigest` + `metadataDigest` | `dc148451…df2e` matches every index entry; metadata digests match for tiny-v1/tiny-v2/truncated; all 17 sidecar→`.glb`→index digests identical |
| `git diff --stat 5b746ee -- docs/contracts docs/decisions` | exactly the 7 promotion contracts (+5077/−145); decision 0002 untracked (new) |
| `git diff --stat 5b746ee -- fixtures/commands fixtures/project-model fixtures/runtime fixtures/three-adapter` | empty (M1 fixtures byte-unchanged) |

**Disclosure (review hygiene).** While probing lockfile consistency I ran
`npm ci --dry-run`, which emptied `node_modules/`. I restored it with
`npm ci --offline` from the unchanged lockfile (162 packages) and re-ran the
whole toolchain: all results above are green on the restored tree. The lockfile
is byte-identical to before (`cmp` IDENTICAL). This was my own artifact, not a
repository change; `dist/` and `node_modules/` are gitignored. The
`git status --porcelain` count (99) is unchanged.

### 1.2 Reported but not independently re-run

Packet-20's 147-test project-model detail, packet-24's 102-test detail, packets
21/22's fixture replays and the packet-25 flow suite (13 tests) ran inside
`npm test` (81 files) but were not separately re-executed; their counts are
consistent with the root totals. The raw HTTP transcript
(`evidence-m2/25/transcripts/http-asset-bytes.txt`) was inspected, not
re-generated.

### 1.3 Contracts/decisions untouched by packets 20–25 — confirmed

The tracked diff contains exactly the 7 promotion contracts, and
`docs/decisions/0002` is the only new decision file. All 7 contract mtimes and
the decision mtime fall in the promotion window (2026-09-19 01:55–02:05 UTC),
**before** packet 20's first evidence (02:23). Packet 22's recorded hashes for
`commands.md`, `project-model.md` and `dependencies.md` still match the current
files (`b84edfd2…`, `ee9d4204…`, `a67b46f1…`). No extra contract/decision
change is a finding.

## 2. Required-check results by area

- **Ownership / single mutation path — PASS.** `protocol` has no Node edge
  (`NODE_SIDE_ALLOWED.protocol.node = []`). `packages/backend/src/content.ts`
  imports only `node:crypto` + `node:http` types and calls
  `service.stageContent/publishBlob/inspectStage/readBlob`; the only
  `runCommand` call is the commands route (`backend.ts:813`). `content.ts`
  performs no filesystem write. Workspace remains the sole executor.
- **M1 regression boundary — PASS.** `fixtures/commands/**` (incl.
  `envelope/**`), `fixtures/project-model/**`, `fixtures/runtime/**`,
  `fixtures/three-adapter/**` are byte-unchanged vs `5b746ee`. Ownership,
  external-change and write-fault suites are green inside `npm test`. The two
  M1 test-file edits (`api-behavior.test.ts`, `api-surface.test.ts`) are the
  contract-mandated per-document `KNOWN_VERSIONS` / extended `ERROR_CODES`
  assertions, not behavior changes.
- **Revision/retry ordering — PASS.** `applyMutation` enforces envelope →
  revision → `revision_exhausted` → `request_bytes` → args, and the workspace
  runs the §6.1 step-2 dedup before it; the crash suite and the packet-25
  restart case prove `duplicated: true` replay and byte-stable envelopes.
- **Immutable-content durability — PASS (executed + re-derived).** Six real
  `SIGKILL` boundaries pass; my independent migration probe reproduces the
  "source byte-identical after success/failure" claim from on-disk hashes.
  Reimport/undo retain old bytes; no GC; tamper is detected and retained.
- **Version compatibility — PASS.** Protocol `ERROR_CODES` additions are
  additive; M1 codes unchanged; the editor session client ignores the additive
  `content` field (it reads named fields, and resync uses `queryEntities`), so
  the M1 client keeps working.
- **Resource disposal — PASS (with a note).** `ContentRoutes.dispose()` clears
  jobs/uploads; job slots release on `finish`/`fail`; `readBounded` stops
  buffering past the cap. Job *records* are TTL-pruned (900 s) but have no
  count cap — bounded only by request rate × TTL (see GF-6).
- **Script trust — not exercised by packets 20–25** (trusted-main-thread
  boundary is packet 33's code path); the model-level `behaviorTrust` shape
  and `publishBehavior{mode:"source"}` refusal were verified. Owner
  pre-approval pending final manual review (unchanged).
- **Input/physics behavior — out of Gate F scope**, unchanged; selection stays
  PROVISIONAL.
- **Export independence — PASS by construction** (no export code changed by
  20–25; the exporter edge set is unchanged and its boundary check is green).
  No export-runtime evidence was re-run here.

## 3. Findings (prioritized, concrete)

**P2-1 — the transport publishes the immutable blob before inspection
(flow deviation from `workspace.md` §13.3.2 / F2).**
`packages/backend/src/content.ts` publishes on upload completion
(`stageContent` → `publishBlob`, ~lines 632–648); `inspectStage` is a separate
route (~line 666). Accepted §13.3.2 orders preparation as *stage → refusal/caps
→ read → digest → import-profile validation → `publishBlob`*, and §13.4 F2
("malformed GLB") requires durable effect **"none"**. A malformed source
therefore leaves an unreferenced `sources/sha256/<digest>` blob and consumes
project quota (§13.9 counts retained bytes). This is bounded (content-addressed,
never referenced, never GC'd, quota-capped) and the accepted rows F17/F15
tolerate unreferenced bytes — but it is a real ordering deviation from F2's
"none". Repair scope: either move `publishBlob` into the successful
`inspectStage` path (small, backend-only) or record a contract diff that
permits upload-completion publication and amends F2. This is C25-5 (below).

**P2-2 — the accepted packet-19 content-service surface was not promoted into
`sessions.md`, so the route *limits* have no binding home.**
`delivery.md` §15 ("Content, job and query service surface (packet 25 shape)")
was accepted (inventory row I-9) and its routes are pinned by the accepted
fixture `fixtures/m2/contracts/delivery/protocol-surface.json` (14 routes;
re-derived by `p19-protocol`), but `docs/contracts/sessions.md` contains no
`content/stages`, `content/jobs` or `content/assets` list prose (grep: none),
and the inventory's "§15" destination landed as the pre-existing §15 "Change
rules". Consequently the numeric limits (assets 1–200, jobs 1–50, integrity
≤ 1024) exist only in the proposal; packet 25 used 128 (commands.md §4) —
correct-looking but contract-ambiguous. Repair scope: docs-only — promote
delivery §15 into `sessions.md` (e.g. a new §16.6 or a content-services §19)
and reconcile the limit with `commands.md` §4. Closes C25-4.

**P2-3 — accepted fixture `prefab-failures.json` F21 is internally wrong
(FD-22-1 confirmed).** F21 sets behaviour values on `model-0006`, but
`fixtures/m2/contracts/commands/prefab-scenario.after.json` shows
`model-0006` = "Ramp" with no `behavior` component, while `model-0005` =
"Lantern". The packet-22 test skips F21 and re-derives the intent with
`model-0005` (passing). Repair scope: fixture-only — correct F21's entity and
re-index its deletion expectation, then remove the skip. Fixture change is a
contract change (project-model §17), so it belongs in the repair step.

**P3-1 — F23 message/hint text contradicts the M1-pinned wording.**
`prefab-failures.json` F23 says `expectedRevision does not match the current
project revision`; the M1 fixture pins `expected revision does not match the
current project revision` (`fixtures/commands/tools/generate-fixtures.mjs:283`),
which is what `errors.ts revisionConflict()` emits. The test works around it by
deleting `message`/`hint` before comparison (C21-4). The implementation is
right; the fixture text should be corrected.

**P3-2 — `docs/STATUS.md` row 23 test count is stale.** The row says
`npm test 72 files/967`; handoff 23, its manifest and `raw/npm-test.txt` all
record **975**. Docs-only correction.

**P3-3 — stale harness comment.** `tests/integration/m2-content/harness.ts`
header says the MCP client uses an "in-memory transport"; the code uses a real
`StdioClientTransport` spawning the bundled server (the manifest's stronger
claim is the correct one). Comment-only.

**P3-4 — test-directory hygiene (pre-existing).** A full `npm test` leaves
~84 orphan `/home/dadmin/.tl07-tmp-*` roots (930 accumulated, M1-era
prefixes); `.tl23-crash-*` and `.tl25-*` roots were cleaned. Not introduced by
packets 20–25; bounded cleanup improvement.

**P3-5 — informational contract/implementation notes.** (a) C24-2's
implemented bufferView alignment is stricter than glTF's per-component rule
(any accessor-referenced bufferView must be 4-byte aligned); no committed
fixture is affected and the proposed diff records it. (b) The M2 extension
allowlist is frozen empty (no passing pinned-loader test could be recorded
in-container); this is the contract's explicit empty-branch. (c) The
decoded-geometry/triangle caps are unreachable inside the 32 MiB source cap;
only the cap-comparison logic is covered. (d) The lockfile's per-package
`dependencies` maps omit `@thirdlight/asset-pipeline` for `workspace`/`backend`
(C25-6); `npm install --package-lock-only --dry-run` reports "up to date",
`npm ci --dry-run` exits 0, and a real `npm ci --offline` from this lockfile
succeeded — so this is cosmetic drift, not a break.

## 4. Per-request contract-change adjudication

Legend: **A** accept as recorded (no contract change needed); **A+D** accept
with a specific docs-only diff; **R** reject. "Gate E portion" states whether
the reopened portion is settled by that diff or needs repair/re-review.

| Item | Decision | Diff / rationale | Gate E portion |
|---|---|---|---|
| C20-1 v2 scene validator naming | **A+D** | Name `validateSceneV2`/`normalizeSceneV2`/`parseSceneV2` in §12.1 and state that `validateScene`/`parseScene` are the **interchange** entry points (§8) while `KNOWN_VERSIONS.scene=[1,2]` covers the active workspace. Implementation follows §8 + the M1 `unsupported-version.json` fixture. | §12.1 naming only — settled by diff |
| C20-2 `migrateSceneV1ToV2` naming | **A+D** | Name the explicit M1→M2 conversion in §12.4; keep `migrateScene(v1,2) → no_migration_path` per the M1 pin. | §12.4 naming only — settled |
| Controller "at most one" wording | **A+D** | Contract is self-contradictory: §10.8/§21.1 say "exactly one", but the accepted §17 change-rule bullet says the packet-15/16 v2 scene *with no collider/controller* stays valid, and physics fixture V19 (zero controllers) maps to runtime `config_invalid`, not a model error. Change §10.8/§21.1 to "at most one in a document; runtime requires exactly one". | §10.8/§21.1 + §17 bullet — substantive wording repair, then settled |
| C21-1 three-block inputs | **A+D** | Name the `content` and `manifest` inputs in §6.1 step 5 (the workspace supplies both; the pure layer treats them as optional). | §6.1 clarification — settled |
| C21-2 `importedAt` required | **A+D** | Add `importedAt` to §3.1.1/§8.5 (project-model §18.4 already makes it a required `AssetVersion` field and the pure layer has no clock); state the reimport `displayName`-replaces rule. | §3.1.1/§8.5 omission — settled |
| C21-3 `includeDeclaration` shape | **A+D** | §5.6 says "adds the exact `declaration`"; the accepted packet-16 `queries.json` returns the full record (incl. `source`, `publishedRevision`). Align §5.6 with the binding fixture. | §5.6 prose — settled |
| C21-4 F22/F23 error text | **A+D** | F22 matches; correct F23's `message`/`hint` to the M1-pinned text and drop the test workaround. Implementation follows M1, not the new fixture. | Fixture defect — repair then settled |
| C21-5 F20 hint / helper location | **A** | F20 (`setting_unknown`, key `gravity`) is correct and byte-pinned; the stale "packet 17" hint is cosmetic. The declaration/property helpers living in `commands` (not `project-model`) is accepted; no duplicate implementation was added. | §5.4 helper surface — settled, no change |
| C22-1 prefab vocabulary collider/controller | **A+D** | §20.2's closed definition vocabulary excludes collider/controller; name them in §5.4's `prefab_component_forbidden` row and §20.2 so the code is unambiguous. | §5.4/§20.2 wording — settled |
| C22-2 `id_exhaustion` unreachable | **A** | Correct observation (1024-entity cap < 9999 ID space); the defensive code stays, no contract change. | None reopened |
| FD-22-1 F21 addresses `model-0006` (Ramp) | **A+D** | Confirmed against `prefab-scenario.after.json`; fixture-only correction to `model-0005`, then un-skip. Intent already re-derived and passing. | Fixture defect — repair then settled |
| C23-1 `inspectStage` absent | **A** | Packet 25 delivered `workspace.inspectStage` + injected inspector; `dependencies.md` §3 names it. **Settled.** | Settled, no repair |
| C23-2 `captureManifest` absent from the model | **A+D** | `dependencies.md` §3 names `captureManifest` for `project-model`/`workspace` but no accepted section defines it; `sessions.md` §17.1 requires it for play-content capture (a later packet). Either add it to the §19/§22 surface with an owning packet, or drop it from §3 until implemented. No packet-23/25 implementation exists, so this is not a deviation. | §3 vs §19/§17.1 gap — settled by the chosen diff |
| C24-1 `prepareImport` not in §3 | **A+D** | Extend the `asset-pipeline` row with `prepareImport`, `importRecipeDigest`, `importMetadataDigest`, `ImportJobPort`, the limit constants/types. Implemented surface matches the package exports. | §3 row completeness — settled |
| C24-2 §18.7.2 step 7 `byteOffset ≤ 3` | **A+D** | The literal clause rejects every real GLB (including both valid fixtures). The contract text is wrong; replace it with the glTF 2.0 alignment rule (implemented strictly: accessor-referenced bufferViews 4-byte aligned, image-bearing unaligned). | §18.7.2 step 7 — settled by diff |
| C24-3 §18.9.3 limit enum | **A+D** | Add `json_chunk_bytes` and `image_bytes` (both are normative caps in §18.7.2 steps 4/11). | §18.9.3 — settled by diff |
| C25-1 `content` field in §5.1 | **A+D** | Add the additive, bounded, v2-only `content` projection (summaries of `queryAssets`/`queryPrefabs`/`queryBehaviors`; no definitions, declarations, versions or bytes) to §5.1 and §8. M1 clients ignore unknown top-level fields (verified). | §5.1/§8 addition — settled |
| C25-2 `importedAt` in `publishAsset` args | **A+D** | Same diff as C21-2; one change closes both. | Covered by C21-2 — settled |
| C25-3 `blob_corrupt`/`asset_not_found` classes vs status | **A+D** | §11.3 says workspace codes surface "unchanged"; §16.1 mandates 500/503/404. Implementation applies the route-level override (matches §16.1). Reword §11.3's exception list to name the §16.1 status overrides. | §11.3 wording — settled |
| C25-4 assets `limit` 200 vs 128 | **A+D** | Same as P2-2: promote delivery §15 and reconcile to one value (recommend 128, matching `commands.md` §4). | Part of P2-2 promotion — repair then settled |
| C25-5 `publishBlob` at upload completion | **A+D (or repair)** | P2-1: genuine ordering deviation from §13.3.2/F2. Preferred repair: publish only after a successful `inspectStage`. If kept, a contract diff must amend F2 ("at most one unreferenced immutable blob") and note quota consumption. | §13.3.1/§13.3.2/§13.4 F2 — **needs a repair decision** (bounded) |
| C25-6 lockfile declarations | **A** | Not a defect under the recorded npm 9.2.0: `npm ci --dry-run` exits 0, `--package-lock-only` reports up to date, and a real offline `npm ci` from this lockfile succeeded. Cosmetic drift only. | None reopened |

**Totals: 22 adjudicated — 4 accept as recorded, 18 accept-with-diff, 0
rejected.** No request indicates a *silent* implementation deviation hidden
behind a contract change: C24-2, the controller wording, C21-3, C21-4 and
FD-22-1 are contract/fixture text defects the implementation correctly did not
follow; C25-5 is the one item where the implementation's flow, not the text,
should change (or the text must be explicitly amended). C23-1 is settled by
packet 25.

## 5. Blockers vs bounded follow-ups

**Blockers: none (no P1).** Nothing found breaks ownership, durability,
immutability, cross-project isolation, path safety, revision/retry ordering,
M1 compatibility, or export independence.

**Bounded follow-ups (repair step, docs-only unless noted):**

- **GF-1** Promote delivery §15's content-service surface into `sessions.md`
  and reconcile the assets/jobs/integrity limits (C25-4, C25-1, C25-3).
  Docs-only.
- **GF-2** Apply the naming/clarification diffs: §12.1/§12.4, §6.1 step 5,
  §3.1.1/§8.5, §5.6, §5.4/§20.2, dependencies §3 (asset-pipeline + project-model
  rows), §18.7.2 step 7, §18.9.3, §10.8/§21.1 controller wording,
  C23-2 disposition. Docs-only.
- **GF-3** Correct the two fixture defects (F21 → `model-0005`; F23
  message/hint → M1 wording) and remove the corresponding test skips/workaround.
  Fixture-only; needs the same review as contract text (project-model §17).
- **GF-4** Approve and apply GF-1/GF-2/GF-3 as the Gate E reopened-portion
  repair, then record re-acceptance of those sections. Because these are
  accepted-contract edits, the affected Gate E portions are reopened until
  this repair is applied.
- **GF-5 (code decision)** Resolve P2-1/C25-5: move `publishBlob` to the
  successful `inspectStage` path (recommended), or record the flow diff. Does
  not block packet 26; should be resolved before packet 27's reimport UI.
- **GF-6 (low)** Fix the STATUS row-23 count (975), the stale harness comment,
  and consider a job-record count bound; optionally clean the orphan temp
  roots.

## 6. Missing context / unverified targets

- **Browser/UI/pixel evidence is UNVERIFIED**: no browser exists in this
  container. All A02/A04/A07 UI claims are deferred to the packet-37
  procedure.
- **Physics selection remains PROVISIONAL**; desktop and gamepad evidence is
  UNVERIFIED. CPU figures are container/directional (BR-2).
- The **trusted-main-thread script boundary** is owner-pre-approved pending the
  final manual review; packets 20–25 did not exercise that path.
- **Power-loss durability beyond `fsync` ordering** is not proven (accepted
  device caveat); the crash suite proves process-`SIGKILL` boundaries only.
- The packet-25 flow suite (13 tests) and packet-20/21/22/24 per-file details
  were executed inside `npm test` but not independently re-run one by one.
- A clean-room `npm ci` was performed only as the node_modules restore
  disclosed in §1.1; it succeeded from the unchanged lockfile.

## 7. Verdict and next step

**ACCEPT WITH BOUNDED FOLLOW-UPS.** Operationally, Gate F's content is sound:
all required checks are green on the current tree; ownership and the single
mutation path hold; durability, determinism and the transport security matrix
were independently re-derived; M1 fixtures are byte-unchanged; and every
contract-change request is adjudicated (4 accept, 18 accept-with-diff, 0
reject). The only substantive gap is the upload-completion publication ordering
(P2-1/C25-5), which is bounded and does not block packet 26.

**Packet 26 is unblocked by this verdict**, but per gate discipline it is not
auto-started. Exact next step: a **repair step** applying GF-1…GF-4
(docs/fixture-only) and deciding GF-5 (recommended: move `publishBlob` after a
successful inspection), record it in a handoff, then start packet 26. Do not
start packet 26 automatically.
