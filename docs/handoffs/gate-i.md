# Gate I review — packets 33–36 (script execution boundary, immutable play delivery, input relay, standalone content/gameplay export)

**Tree:** HEAD `5b746ee` + the uncommitted M2 working tree (packets 14–36; no commit
after `5b746ee`). **Scope:** packets 33–36 only. **Reviewer:** fresh session; the
handoffs were treated as claims, not proof. **Verdict is this record only** — not
owner approval and not a separate reviewer's approval.

Method: read `docs/planning/m2-packets.md` "Gate review prompt (E–J)", the packet
33–36 briefs, `m2-plan.md` §5, `m2-acceptance.md` A15–A23, decision 0002 §5–§6,
the accepted contracts (`project-model.md` §22, `runtime.md` §12/§14, `sessions.md`
§7/§13.5/§17/§18/§19, `export.md` §3/§5/§6, `dependencies.md` §3/§4), the raw
evidence under `docs/acceptance/evidence-m2/33–36`, then re-ran the toolchain and
re-derived the security/identity claims from the tree.

**Method note (side effect).** `tests/integration/m2-export/export-m2.test.ts`
writes its own evidence into `docs/acceptance/evidence-m2/36/artifacts/**`
(lines 452/548/598/675/838). The required re-run of `npm test` (and the targeted
m2-export suite) therefore **regenerated those artifacts in place**. The values
quoted below are the freshly measured ones; the pre-review copies are not
recoverable from the tree (untracked). This is itself finding P2-3.

## 1. Executed evidence (re-run in this session)

| Check | Executed result | Matches handoff? |
|---|---|---|
| `npm test` | **133 files / 1693 passed**, exit 0 (36.6 s) | yes (36) |
| `npm run typecheck` | exit 0 (15 packages) | yes |
| `npm run check-deps` | exit 0, all §7 pins exact | yes |
| `npm run check-boundaries` | OK — 15 pkgs, 283 files, 1068 specifiers, 0 violations | yes |
| `npm run build` | 4 built / 0 skipped, exit 0 | yes |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | 34/34, 0 problems | yes |
| packet-domain checkers (behaviors/assets/course/input/physics/runtime) | all exit 0 | yes |
| `tests/{m2-builds,integration/m2-builds,integration/m2-play,integration/m2-export,browser/m2-behaviors}` | **9 files / 62 tests passed** | yes |
| cold harness (my own esbuild build, 6 fresh `node` processes) | 6/6 ok, identical `outputDigest 55ff57e0…`/`manifestDigest 86ebf51f…`, 14–15 ms, 0 failures; sentinel `executed:false` | yes |
| hostile probes through the same deployed harness | `network`→`behavior_import_forbidden`/`network`; `node-builtin`→/`node_builtin`; `eval`→`behavior_dynamic_code`/`eval`; `dynamic-import`; `escape`→`behavior_source_escape`; all exit 1 | yes |
| committed container digest/length table vs `node:crypto` | 33/33 cases match | yes |
| behavior VM host (`P34_*`) | `speed 3.5→x=0.14900000000000002`, `6.5→x=0.279`, 52 intents, digests unchanged; fail-stop `module_error`; `logCount 208/logDropped 312/ring 32` | yes |
| play locator/delivery suite | 13/13 (manifest/`buildId`, routes+digests, traversal/listing/undeclared/cross-capability, redaction, unpaired, frozen pins, MCP relay provenance/limits/timeout/no-simulated-success, repeated start/stop, disconnect grace, restart 404) | yes |
| store units | 10/10 (TTL/grace/caps/prune/capability) | yes |
| preview bundle scan (my own pinned esbuild build) | 4 531 027 B; `a/c/d/e/f/g/h/i/j = 0/0/6/0/3/0/38/0/3`; `GLTFLoader`×37; `Bearer`/`authoringToken`/`__thirdlightEditor`/`/api/v1/` = 0/0/0/0; `node:` 0 | yes (counts) |
| export bundle scan (fresh) | 4 455 999 B, sha256 `c00e265f…`; `a–j = 0/0/0/7/0/3/0/38/0/5`; GLTFLoader×37, scanHits 0 | yes |
| double export (fresh) | all artifact bytes identical except `manifest.json`+`meta.json`; `sameCaptureSecond:false`; normalised `capturedAt` re-derives the first `buildId` | conditional (see P2-2) |
| play-vs-export trace (fresh) | 120 steps, **max |Δ| = 0**, tolerance 1e-9 | yes |
| cold export builds (fresh) | 3/3 ok, 334/338/347 ms | yes |
| `project-model` sha256 vs `node:crypto` (my esbuild probe) | lengths 0–1200 + 2047…1 000 000 incl. every `len ≡ 55 mod 64` class: **1234/1234 agree, 0 mismatches** | — |

## 2. Contract/decision integrity

`git diff --stat 5b746ee -- docs/contracts docs/decisions` = the 7 promotion
contracts, **+5456/−160**, decisions empty. Gate H recorded +5292/−157 pre-repair;
the Gate H repair added +164/−3 → the current tree **equals the post-Gate-H-repair
state exactly**. mtimes corroborate: no contract file after 08:20:10, no decision
after 02:00:48, while every packet 33–36 artifact is ≥ 08:54:55. **Packets 33–36
did not change any contract or decision.** The C33–C36 items below are recorded
requests, not silent edits.

## 3. Findings (prioritised)

### P1-1 — `behavior-build`'s SHA-256 still has the padding defect that packet 36 repaired in `project-model`; legitimate behavior publication fails for `len ≡ 55 (mod 64)` containers

`packages/behavior-build/src/canonical.ts:46` computes
`(((bytes.length + 9) >> 6) + 1) << 6`, which allocates an extra zero block
whenever `(len + 9) % 64 === 0` and writes the length field into it.
`packages/project-model/src/sha256.ts:57` was repaired to
`ceil((len + 9) / 64)` in packet 36; `packages/asset-pipeline/src/sha256.ts:114`
uses the correct `rem < 56 ? 1 : 2` form; **the `behavior-build` copy was not
repaired**.

Re-derived independently (esbuild-bundled `canonical.ts` vs `node:crypto`):
lengths 55/119/183/247/311/375 … mismatch; e.g. len 55 →
`87e873f6…` (impl) vs `e7313d33…` (node:crypto). Concretely, a canonical
container of 951 bytes compiled by the real compiler reports
`sourceDigest 1066eae3…` while `node:crypto` says `4459c410…`.

Consequence, re-derived end-to-end on the real workspace (disposable probe,
removed): `prepareBehaviorSource` publishes the blob under the **correct**
workspace digest (`content-store.ts` `digest.ts` = `node:crypto`) but stores
`prepared.sourceDigest` = the compiler's wrong digest
(`packages/workspace/src/behavior.ts` → `preparedSourceFromCompile`). The
publication facade then passes that wrong digest
(`packages/backend/src/behavior.ts:96`) and the command's prepared-map lookup
misses → **`behavior_publication_unavailable` / `reason:"preparation_missing"`**
for a fully valid, acknowledged source. So no user can publish (and therefore
never play/export) such a behavior. The registry of affected inputs is not
limited to containers: per-file `digest`, `manifestDigest` and `outputDigest`
are wrong for any input of that class, so `behaviors/<outputDigest>.js` and the
manifest identity carry non-standard digests (no other path re-hashes those
bytes with `node:crypto`, which is why the suite stayed green).

The committed fixtures do not hit the class (container 922, output 500,
manifestBytes 1417, file texts 476/156), which is why
`fixtures/m2/behaviors/tools/check.mjs` (plain `node:crypto`) and all tests pass.

**Minimal repair:** fix the padding in `packages/behavior-build/src/canonical.ts`
to `ceil((len + 9) / 64)` (or the `asset-pipeline` form), and add a
`node:crypto` cross-check/known-answer regression test for the `len ≡ 55 (mod 64)`
class at the `behavior-build` unit level (mirroring
`packages/project-model/src/sha256-length.test.ts`), plus one end-to-end
publication case with such a container. Scope: `packages/behavior-build/**` +
its tests (packet 33 read/edit set). No committed fixture digest changes.

### P1-2 — the accepted §14.5 "effective input" rule is not implemented in the production play/export composition; A15's production claim rests on a test-only consumer module

`docs/contracts/runtime.md` §14.5 (line 1436) is normative: for step `n` the
controller phase's input is
`effective = { stepIndex: n, moveX: intents.move ?? action.moveX, jump: intents.jump ?? action.jump }`.

The implementation only stores `control_move`/`control_jump` into the
`IntentSet` (`packages/runtime/src/runtime.ts:1300–1320`); `runPhase`
(runtime.ts:1239) passes the **sampled** `action` to every phase with no
substitution, and `packages/platformer/src/controller.ts` (line 276) reads
`ctx.action` only — it never reads `ctx.intents`. A grep for a production
consumer of `ctx.intents` finds none (only the runtime's own `intentView()`).

The packet-34 measurement that demonstrates "property → measured behavior" is
produced by a **bespoke test consumer**
(`tests/browser/m2-behaviors/behavior-host.test.ts:186`, module id
`thirdlight.test:move-consumer`) that reads `ctx.intents.move ?? ctx.action.moveX`;
that module does not exist in the preview (`preview-bootstrap.ts:470–477`:
`BUILTIN_MODULES` + `platformerSpec` + behavior specs) or in the export
(`exporter/src/export-composition.ts:147–154`). The committed sample behavior
emits **only** `control_move` (`fixtures/m2/behaviors/valid/sample.json`), so in
real Play/export its declared `speed` property has **no visible effect**. The
play/export trace test uses a fixed action sequence and no behavior, so nothing
covers the gap.

`A15` ("a published behavior's declared property actually affects play state" /
"property changes visibly affect fresh play") is therefore unmet in production,
and an accepted normative rule is unimplemented. Packet 34 recorded this as
C34-3 ("packet 35 owns play composition") but packet 35's may-edit list and its
scoped diff contain neither `packages/platformer` nor the runtime controller
phase.

**Minimal repair:** implement §14.5 where the controller phase is composed —
either substitute the effective `ActionFrame` for controller-phase modules in
`packages/runtime/src/runtime.ts` (keeping `ctx.action` the sampled frame, per
§14.5), or have `platformerSpec` consume `ctx.intents.move ?? ctx.action.moveX`
/ `ctx.intents.jump ?? ctx.action.jump`. Add production-composition evidence
(preview or export composition) that the committed sample's `speed` changes a
measured character/play state, and confirm the 178 frozen trace rows stay
bit-identical with an empty `IntentSet` (the §14.5 compatibility condition).
Scope: `packages/runtime/**` (packet 34) and/or `packages/platformer/**`
(packet 32) + tests. This is a gameplay failure → blocks packet 37 / Gate J run
of A15 as written.

### P2-1 — packet-35 scope exceptions are real but under-contracted

Recorded exceptions outside packet 35's may-edit list: (a)
`packages/workspace/src/content-store.ts` `readSourceBlob` (additive,
`O_NOFOLLOW`, digest-verified — C35-1); (b) `tools/check-boundaries.mjs`
`BUNDLE_ENTRY_EDGES` + a computed-dynamic-import carve-out for
`preview-bootstrap.ts` (`check-boundaries.mjs:614`), i.e. a **narrow check
relaxation** for the locator behavior import (C35-3); (c)
`packages/editor/tsconfig.json` `esnext.disposable` (Rapier d.ts). Each is
bounded and justified by the acceptance need, but none is in an accepted
contract; the checker relaxation must be paired with the §4.3/§5.1 text before
packet 37, or a later refactor can widen it silently. Bounded follow-up (docs).

### P2-2 — `capturedAt` in the `buildId` preimage contradicts `sessions.md` §17.1.1 and makes export reproducibility conditional (C36-7)

`docs/contracts/sessions.md:1100` says `capturedAt` is "Not a digest input",
but the promoted `MANIFEST_KEYS`/`manifestBuildIdInput` include it
(`packages/project-model/src/manifest.ts:352`). Freshly measured: two real exports
of the same revision differed in `manifest.json` (`capturedAt` **and**
`buildId`) and `meta.json`, `sameCaptureSecond:false`; only with the capture
second normalised does the tree re-derive byte-identically, and the unit test
pins a fixed clock. `A22`'s literal "repeated same-input exports differ only by
the contracted timestamp" is therefore conditional on the wall-clock second, and
the packet-36 manifest §4's "landed in the same capture second" sentence is not
independently verifiable now that the artifact is regenerated. Bounded
follow-up: choose the diff — exclude `capturedAt` from the preimage or restate
§17.1.1/A22 as capture-second-dependent — and make the recorded evidence
reproducible.

### P2-3 — the packet-36 raw evidence is not durable: ordinary test runs overwrite it

`export-m2.test.ts` writes `cold-builds.json`, `double-export-diff.json`,
`export-files.json`, `failure-injection.json`, `manifest.json`, `meta.json`,
`scan.json`, `trace-diff.json` into `docs/acceptance/evidence-m2/36/artifacts/`
at each run. Any `npm test` (including the Gate-review required run) replaces the
"raw evidence" the handoff cites. Bounded follow-up: gate the writes behind an
explicit env flag (or write to a temp dir and copy deliberately), so recorded
evidence is append/attest-once.

### P2-4 — packet-36 unlisted `project-model` edits, and play ignores authored `content.settings`

`packages/project-model/src/{manifest.ts,sha256.ts,sha256-length.test.ts,index.ts}`
are outside packet 36's may-edit list. The additive manifest owner
(C36-2) and the P1 sha256 repair justify touching the leaf, but this is a scope
exception like the C35-* set and is not recorded as one; it should be named in
the repair/handoff or the manifest derivation moved to `exporter`.

Separately (C35-5), the play/export runtime does not carry resolved
`content.settings`: `preview-bootstrap.ts:330` hard-uses `DEFAULT_GRAVITY_Y`,
and `play-content.ts` has no settings field, so authored gameplay settings do
not affect Play. No acceptance row pins this, but it is a user-visible gap;
record it as a bounded follow-up or a contract diff.

## 4. Adjudication of recorded contract-change requests (30)

Legend: **A** = accept as recorded (no diff); **AD** = accept with the specific
diff named; **R** = reject. "Reopens" names the Gate E portion a diff would
reopen. "Required by" is the checkpoint.

| Item | Verdict | Specific diff | Reopens | Required by |
|---|---|---|---|---|
| C33-1 async `compileBehavior` | **AD** | state `Promise<BehaviorCompileResult>` in the compiler signature (esbuild 0.28.2 `buildSync` rejects plugins) | planning `behaviors.md` §5.1 + `project-model.md` §22.4 API text | docs promotion |
| C33-2 `absWorkingDir` pin | **AD** | add `absWorkingDir:"/"` to the closed option set (it is in the recipe digest) | planning `behaviors.md` §5.4 | docs promotion |
| C33-3 `behavior_declaration_mismatch` | **AD** | add the stable-code row to §5.4 | `commands.md` §5.4 | before Gate J |
| C33-4 scan letter table | **AD** | state a–j (export §5.4), k–o behavior-only, `p` engine id | planning `behaviors.md` §5.5 + `export.md` §5.4 | docs promotion |
| C33-5 trust-check order | **AD** | state the enforceable order: hash → trust refusal → compile → blob (before any write) | `project-model.md` §22.4.1, `workspace.md` §13.3.1 | docs promotion |
| C33-6 `project-model` container exports absent | **AD** | either implement `SourceGraphContainer`/`parseSourceGraphContainer`/`BEHAVIOR_SOURCE_LIMITS` or move the row to `behavior-build` | `dependencies.md` §3 | docs promotion |
| C33-7 edge row / extra limit keys | **AD** | record the actual edge (`parseDocumentBytes` value edge) and the extra `COMPILER_LIMITS` keys | planning `dependencies.md` §4.1 | docs promotion |
| C34-1 `StepContext.intents`/`emit` | **AD** | add both rows to the §12.2 block (required by §14.5) | `runtime.md` §12.2 | before packet 37 (paired with P1-2) |
| C34-2 `ModuleConfig.behaviorLog` | **AD** | add the bounded log sink field | `runtime.md` §7.2/§12.2 | docs promotion |
| C34-3 §14.5 effective input | **AD** | name `ctx.intents` as the controller-phase effective-input source | `runtime.md` §14.5 | **with P1-2, before Gate J** |
| C34-4 no `behaviorTrust` read | **AD** | add bounded `behaviorTrust.entries` to the full-state `content` projection (or a read query) | `project-model.md` §22.5, `sessions.md` §19.4 | docs promotion |
| C34-5 §12.1 inventory row | **AD** | correct behavior phases to `["intent","transform"]` + owners | `runtime.md` §12.1 | docs promotion |
| C34-6 per-instance intent cap unreachable | **A** | none — keep as defence in depth, record like O7 | — | — |
| C34-7 `duplicate_writer` both IDs | **AD** | add `writers:[committedBy, attemptedBy]` to the fail-stop entry | `runtime.md` §14.4 | docs promotion |
| C34-8 no source-preparation route | **AD** | superseded by C35-4 (one prepare/publish route) | `sessions.md` §19.1 | with C35-4 |
| C35-1 `readSourceBlob` | **AD** | add the digest-addressed verified read row | `dependencies.md` §3/§4.1, `workspace.md` §13.5 | docs promotion |
| C35-2 manifest behavior row | **AD** | add `declaration`/`ownedTransforms`/`requiredModules` | `sessions.md` §17.1.1 | docs promotion |
| C35-3 preview entry + locator import | **AD** | name the §4.2 preview entry; define the bounded locator dynamic-import rule (replaces the checker carve-out) | `dependencies.md` §4.1/§4.2/§5.1 | before Gate J (P2-1) |
| C35-4 behavior-source route | **AD** | add `POST …/content/behaviors/source` to §19.1 (runs the packet-33 facade) | `sessions.md` §19.1 | docs promotion |
| C35-5 scene `schemaVersion` + `content.settings` | **AD** | expose the scene document `schemaVersion`; state how `content.settings` reaches the runtime (or that defaults are contracted) | `sessions.md` §17.1.1/§19.4, `runtime.md` §8 | before Gate J (P2-4) |
| C35-6 preview `fetch(` rule | **AD** | restate §5.4.1 binding 4 as baseline + loader row + counted preview call sites | `export.md` §5.4.1 | docs promotion |
| C35-7 Rapier §5.4.1 row | **AD** | add the `@dimforge/rapier2d-compat` recorded-exception row (`fetch(` +1, inert) | `export.md` §5.4.1 | docs promotion |
| C35-8 `input.request`/`input.result` | **AD** | add the two WS rows to the §7 catalog (they exist only in code + §13.5/§18) | `sessions.md` §7.1/§7.2 | docs promotion |
| C36-1 no `scene.json` in §3 | **AD** | add `scene.json` to the export layout + the §17.5 export fetch row | `export.md` §3/§17.5 | docs promotion |
| C36-2 `captureManifest` owner | **AD** | name `project-model` the single pure owner; `protocol`/`workspace` drop or re-export the duplicate | `dependencies.md` §3 | docs promotion (also P2-4 scope note) |
| C36-3 `outputDigest` undefined | **AD** | write the definition (sorted emitted closure, per-file `path\ndigest\nbyteLength\n`, excluding `meta.json`) | `export.md` §6 | docs promotion |
| C36-4 `behaviorTrust` read absent | **AD** | expose the bounded read **or** state the structural publication-time enforcement in §6 | `export.md` §6, `project-model.md` §22.5 | docs promotion |
| C36-5 M2 bundle entry file list | **AD** | add the M2 row with its exact three exporter files (no wildcard) | `export.md` §5.2/§4.2 | docs promotion |
| C36-6 §5.4.1 rows | **AD** | add the Rapier, mandatory-trust-notice-text, `./scene.json` and static-behavior rows | `export.md` §5.4.1 | docs promotion |
| C36-7 `capturedAt` digest input | **AD** | exclude `capturedAt` from the `buildId` preimage **or** restate §17.1.1/A22 as capture-second-dependent | `sessions.md` §17.1.1, `project-model.md` manifest | before Gate J (P2-2) |

**Counts: 29 accept-with-diff, 1 accept-as-recorded (C34-6), 0 rejected.** Every
diff is docs-only except C34-3/C34-1/C35-5, which are paired with the two P1
repairs.

## 5. Blockers vs bounded follow-ups

**Blockers (Gate I cannot be accepted; packet 37 must not start):**
- **P1-1** `behavior-build` SHA-256 padding defect (wrong digests; valid
  publications fail).
- **P1-2** §14.5 effective input unimplemented; A15 production claim unmet.

**Bounded follow-ups (named owner/checkpoint):**
- P2-1 packet-35 scope exceptions → contract text for C35-1/C35-3 (docs
  promotion; before Gate J).
- P2-2/C36-7 `capturedAt`/A22 reproducibility (docs; before Gate J).
- P2-3 packet-36 evidence writes during `npm test` (test-only change; packet 36
  scope; before Gate J).
- P2-4 packet-36 `project-model` scope exception + authored `content.settings`
  not reaching Play (with C35-5/C36-2; before Gate J).
- All 29 accepted diffs applied in one docs-only Gate E portion re-acceptance
  step (as Gate F/G/H repairs did).

## 6. Missing context / unverified targets

- **No browser, GPU or input hardware in this container.** UNVERIFIED and
  honestly recorded (no placeholder/fabricated screenshot exists; `find
  docs/acceptance/evidence-m2 -iname '*.png'` = 0): live Play (pinned GLB +
  behavior, WebGL, ready/progress), course traversal, physical keyboard/gamepad
  including denied gamepad permission and injected-vs-physical re-arm, tab
  resume, the **real rendered PNG** (A19), the export walkthrough with the
  backend stopped from an independent non-root static server, WASM/CSP/static
  packaging, browser `crypto.subtle`, `BehaviorPanel` render, pixels.
- The packet-37 procedures in `tests/browser/m2-behaviors/README.md`,
  `tests/browser/m2-play/README.md` and evidence-m2/36 §9 are sufficient and
  honest for those items; they must run after the P1 repairs.
- `content.settings` in Play (P2-4); pre-review copies of the regenerated
  packet-36 evidence (P2-3).
- No M1 regression: M1 tests/fixtures pass unmodified; the sha256 repair file is
  new in M2 (absent at `5b746ee`), so it cannot have changed M1 behaviour.

## 7. Verdict

**CHANGES REQUIRED.** Both P1s are concrete, reproducible and on Gate I's own
subject matter (artifact identity/durability and the script/play boundary). The
executed toolchain is green and most acceptance rows A16–A23 are met at the
process/fs/HTTP/WS/SDK level, but P1-1 rejects valid content and P1-2 leaves
A15 unmet in production. Do not accept Gate I and do not start packet 37 until
both repairs land and are re-verified.

## 8. Exact next step

Apply two bounded repairs in the packets' own read/edit sets, then re-run the
toolchain and the targeted suites and return for a Gate I re-review:

1. **R-I-1 (packet 33 scope).** Correct
   `packages/behavior-build/src/canonical.ts` padding to `ceil((len + 9) / 64)`;
   add a `len ≡ 55 (mod 64)` known-answer/`node:crypto` cross-check plus one
   real workspace publication case with a 951-byte canonical container.
2. **R-I-2 (packet 34/35 scope).** Implement §14.5 effective input in the
   controller phase (runtime substitution or `platformerSpec` reading
   `ctx.intents`); add production-composition evidence that the committed
   sample's `speed` changes measured play state; keep the 178 frozen traces
   bit-identical.
3. Apply the 29 accepted docs diffs as one Gate E portion re-acceptance step.

Then re-review Gate I; packet 37 stays **not started**.
