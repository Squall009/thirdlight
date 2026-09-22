# Gate I re-review (second pass) — packets 33–36 after the R-I-1/R-I-2 required-changes repair

**Tree:** HEAD `5b746ee` + the uncommitted M2 working tree (packets 14–36; no
commit after `5b746ee`). **Scope:** packets 33–36 only, re-reviewing the
`docs/handoffs/gate-i.md` **changes required** verdict after
`docs/handoffs/gate-i-repair.md`. **Reviewer:** fresh session; the review and
repair handoffs were treated as claims, not proof. **Verdict is this record
only** — not owner approval and not a separate reviewer's approval.

Method: read `docs/planning/m2-packets.md` "Gate review prompt (E–J)", the
packet 33–36 briefs, `gate-i.md`, `gate-i-repair.md`, the accepted contracts
and the raw evidence under `docs/acceptance/evidence-m2/33–36`; then re-ran the
toolchain, re-derived P1-1 and P1-2 from the tree and from the **pre-repair
artifacts left by the first review** (`/tmp/gatei/sha/bb-canonical.mjs`,
`/tmp/gatei/probe/container-951.json`), and checked the 29 docs diffs at their
destination sections.

## 1. Executed evidence (re-run in this session)

| Check | Executed result |
|---|---|
| `npm test` | **135 files / 1701 passed**, exit 0 (36.96 s) |
| `npm run typecheck` | exit 0 (15 packages) |
| `npm run check-deps` | exit 0, all §7 pins exact |
| `npm run check-boundaries` | OK — 15 pkgs, 283 files, 1068 specifiers, 0 violations |
| `npm run build` | 4 built / 0 skipped, exit 0 |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | 34/34, 0 problems |
| domain checkers (behaviors/course/input/physics/runtime) | all pass (`behaviors`: all rows re-derived; `course`: 9/9; `input`/`physics`/`runtime`: OK) |
| targeted `tests/m2-builds` + `integration/m2-builds` + `integration/m2-play` + `integration/m2-export` + `browser/m2-behaviors` + `m2-controller` | **15 files / 104 tests passed** |
| packet-36 reproducibility/trace (`integration/m2-export`) | 9/9; "two same-input exports" and "same fixed action sequence produces the same trace" pass |
| packet-32 frozen traces (`m2-controller`) | `[traces] 16 traces / 178 sampled rows replayed exactly` |
| P2-3 evidence durability | `sha256sum` of every file under `docs/acceptance/evidence-m2` **byte-identical before and after `npm test`** (empty diff) |

These numbers equal the repair handoff's claims (`135/1701`, 15 pkgs, 15/283/1068,
4 built, 34/34, 15/283/1068) and the committed `evidence-m2/36/artifacts/toolchain.txt`.

## 2. Independent re-derivation of P1-1 (behavior-build SHA-256 padding)

**Padding inspected:** `packages/behavior-build/src/canonical.ts:67` now reads
`new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)` — the correct FIPS
180-4 block count. **No other hand-rolled SHA-256 remains:** the only other
implementations in the tree are `packages/project-model/src/sha256.ts`
(`(((len + 8) >> 6) + 1) << 6`, algebraically `ceil((len+9)/64)`) and
`packages/asset-pipeline/src/sha256.ts` (`rem < 56 ? 1 : 2`); both are correct.
`grep` for the SHA-256 constants / `rotr` finds only those three sources, and
the `dist/` bundles built here carry the corrected forms.

**Cross-check my own probe (esbuild bundle of the source vs `node:crypto`):**
lengths `0…320`, extra `439/823/1000/2007/4103/8199/100000`, every
`len ≡ 55 (mod 64)` from 55 to 20 000 — **640 lengths checked, 0 mismatches**.
Named: `55 → e7313d33…`, `119 → 9ce7368e…`, `183 → 80e7b84a…`,
`247 → 47446187…`, `951 → c4af940f…`, all `== node:crypto`.

**Negative control against the actual pre-repair bundle** left by the first
review (`/tmp/gatei/sha/bb-canonical.mjs`, the old expression
`(((len + 9) >> 6) + 1) << 6`):

- mismatching lengths in `0..400`: `55,119,183,247,311,375`; `len 55` old
  `87e873f639ebf6c3…` vs `node:crypto e7313d33…` — exactly the number
  `gate-i.md` recorded;
- the real 951-byte canonical container (`/tmp/gatei/probe/container-951.json`,
  951 bytes, `951 % 64 = 55`): **old `1066eae3…` vs node:crypto `4459c410…`**;
  the repaired implementation returns **`4459c410…` == node:crypto**.

**End-to-end through the real workspace path (not a unit test):**
`tests/integration/m2-builds/publication.test.ts` (real fs, real compiler, real
`workspace` service) passes 7/7, including *"publishes a 951-byte canonical
container (the `len == 55 (mod 64)` digest class)"*: the staged blob is written
under the `node:crypto` digest and `prepared.prepared.sourceDigest` equals that
blob address, and `publishBehavior{mode:"source"}` then succeeds. Before the
repair this case failed `behavior_publication_unavailable` /
`reason:"preparation_missing"` (the old digest missed the prepared-map lookup),
which the pre-repair bundle reproduction above independently confirms.

**P1-1: fixed, independently re-derived at unit, container-byte and
end-to-end workspace levels.**

## 3. Independent re-derivation of P1-2 (§14.5 effective input in production)

**Contract/implementation agreement:** `docs/contracts/runtime.md` §14.5 now
names `StepContext.intents` as the controller-phase effective-input source
(C34-3), and `packages/platformer/src/controller.ts:283–288` builds
`effective = { stepIndex: ctx.action.stepIndex, moveX: ctx.intents.move ??
ctx.action.moveX, jump: ctx.intents.jump ?? ctx.action.jump }` for the
`controller` phase only, leaving `ctx.action` the sampled frame. The runtime
populates `intents` for **every** phased module
(`runtime.ts:1259 intents: this.intentView()`), so this is a production field,
not a test-only consumer; the only consumers are the controller and the
behavior host (`behavior.ts:502`).

**§14.5 `stepIndex` fidelity:** the runtime rejects a sampled frame whose
`stepIndex` differs from the executed step (`validateActionFrame`, actions.ts
`expectedStepIndex`), so `ctx.action.stepIndex === n`; `effective.stepIndex`
is therefore `n` as the contract requires.

**Production composition:** `packages/exporter/src/export-composition.ts`
`composeExportRuntime` registers the real `platformerSpec`; it is the composition
used by the export bundle (`export-bootstrap-m2.ts:296`) and the preview
(`preview-bootstrap.ts:471`). No separate controller exists.

**Production measurement re-run myself** (`TL_R_I_2_EVIDENCE` set, real backend
+ real fs + real published artifact compiled from
`fixtures/m2/behaviors/valid/sample.json` + real Rapier + production
`composeExportRuntime`; sampled `moveX = 0` for 120 steps so only the behavior
`control_move` intent drives the character):

```
xSlow (speed 3.5) = -0.499564501689747
xFast (speed 6.5) =  0.7639840019401163
delta             =  1.2635485036298633
```

These are byte-identical to the committed
`docs/acceptance/evidence-m2/34/effective-input.json`. The module-level unit
test (`packages/platformer/src/api-surface.test.ts`) independently proves the
rule both ways: a committed `control_move: -1` overrides sampled `moveX = +1`,
and with no intent the sampled frame is used unchanged. With an empty
`IntentSet` the effective frame is exactly the sampled frame, so the packet-17
algorithm is unchanged; the 178-row fixture
(`fixtures/m2/contracts/platformer/traces.json`, sha256 `7e1db6be…`, mtime
01:02 — untouched by the repair) replays exactly, and all packet-32 course/CPU
tolerances pass.

**P1-2: fixed, independently re-derived from the production composition with
fresh raw numbers.**

## 4. Docs-diff spot-check (29 accept-with-diff adjudications)

`git diff --stat 5b746ee -- docs/contracts docs/decisions` = **7 files,
+5657/−161**; the first review recorded +5456/−160, so the repair added
**+201/−1**. `docs/decisions` is unchanged (only the untracked `0002`, mtime
`2026-09-19 02:00:48`, i.e. before the repair window). The only files whose
mtimes fall in the repair window are the 7 promotion contracts,
`docs/planning/m2-contracts/behaviors.md`, `docs/planning/m2-acceptance.md`
and `docs/planning/m2-contracts/diffs/dependencies.md` — exactly the repair
handoff's list, no unexpected contract/decision edits. All 29 labels are
present at their adjudicated destinations (`C33-2` correctly in the planning
`behaviors.md §5.4`, not `docs/contracts`) and `C34-6` remains diff-free.

Spot-checked destination sections (≥6, each matches its adjudicated diff):

| Item | Destination | Verified |
|---|---|---|
| C36-7 | `sessions.md` §17.1.1 (line 1104) + `export.md` §7 + `m2-acceptance.md` A22 | `capturedAt` "**IS** a digest input", capture-second-dependent wording; A22 restated; `manifest.ts` `MANIFEST_KEYS` still includes it (code/text agree) |
| C34-1 | `runtime.md` §12.2 (lines 869/871) | `StepContext.intents` + `emit()` rows and note |
| C34-3 | `runtime.md` §14.5 | names `ctx.intents` as the controller effective-input source, platformer-owned |
| C35-5 | `sessions.md` §17.1.1/§19.4 + `runtime.md` §3.1 | scene `schemaVersion` exposure + the honest `content.settings` deferral |
| C36-6 | `export.md` §5.4.1 | Rapier, trust-notice, `./scene.json` and static-behavior rows + binding |
| C35-1 | `workspace.md` §13.5 + `dependencies.md` §3/§4.1 | `readSourceBlob` digest-addressed `O_NOFOLLOW` verified read |
| + C33-3, C33-6, C34-8/C35-4, C36-2, C36-3, C36-5 | `commands.md §5.4`, `dependencies.md §3`, `sessions.md §19.1`, `export.md §5.2/§6` | present and correct |

## 5. Regression check

Green: full suite 135/1701 (up from the pre-repair 133/1693 by the two new
canonical tests only), typecheck, check-deps, check-boundaries (15/283/1068 —
unchanged), build, contracts checker 34/34, domain checkers, targeted suites.
The only source files changed by the repair are
`packages/behavior-build/src/canonical.ts` and
`packages/platformer/src/controller.ts` (mtimes 10:39/10:42), plus the named
tests (10:38–10:41) — no other code, contract, decision, fixture or tool file
changed. Committed fixture digests did not move (the defect class `len ≡ 55`
does not occur in the committed behavior/container fixtures; the contracts
checker re-hashes all 16 containers against `node:crypto`).

## 6. P2 dispositions

- **P2-1 (packet-35 scope exceptions)** — `C35-1` (`workspace.md` §13.5,
  `dependencies.md` §3/§4.1) and `C35-3` (`dependencies.md` §4.1/§4.2/§5 check 1)
  contracted; the `check-boundaries.mjs` computed-import carve-out remains but
  is now named text.
- **P2-2 / C36-7 (`capturedAt`/A22)** — chosen adjudication applied: `capturedAt`
  stays in the `buildId` preimage; §17.1.1/`export.md §7`/A22 restated as
  capture-second-dependent. Committed `double-export-diff.json` records
  `sameCaptureSecond:true`, `differingFiles:[]`,
  `rederivedBuildIdMatchesFirst:true` (same-second run); the text is honest
  about the different-second case.
- **P2-3 (evidence overwritten by `npm test`)** — fixed: writes are gated behind
  `TL_EVIDENCE_DIR` / `TL_R_I_2_EVIDENCE`; my `npm test` left every committed
  evidence byte unchanged (verified by hash).
- **P2-4 (`project-model` scope exception + `content.settings`)** — exception
  recorded in `gate-i-repair.md`; the `content.settings` deferral is honestly
  stated in `runtime.md` §3.1 with a proposed diff, and the code is consistent
  with the deferral (`preview-bootstrap.ts:330`, `export-bootstrap-m2.ts:128`
  and `play-content.ts` still use the contract defaults). Not faked.

## 7. Residual findings (prioritised, non-gating)

- **P3-1 (docs nit).** `tests/browser/m2-behaviors/README.md` attributes the
  missing editor preparation wire route to "C34-3"; the request was C34-8,
  superseded by C35-4. The substance (the panel surfaces
  `behavior_publication_unavailable` honestly) still matches the code — the
  editor client has not adopted the §19.1 source route — so this is a stale
  label, not a false claim. Pre-existing; no repair requirement.
- **P3-2 (informational).** `export.md` §5.4.1's GLTFLoader row reads
  "h `https://` +12 (⇒ 35 total)" while the scan's aggregate `h` count is 38
  (`3 http://` + `35 https://`); the raw evidence (`scan.json` h=38) is
  consistent with the aggregate wording. Pre-existing from packets 26/35/36,
  not introduced here.

## 8. Blockers vs bounded follow-ups

- Blockers: **none.** Both P1s are fixed and independently re-derived; no new
  P1/P2.
- Bounded follow-ups: none required by this review. P3-1/P3-2 may be corrected
  opportunistically; they do not block packet 37.

## 9. Unverified targets

No browser, GPU, display or physical input hardware in this container.
UNVERIFIED and honestly recorded: live Play (WebGL, ready/progress), course
traversal in a browser, physical keyboard/gamepad incl. denied-gamepad
degradation and injected-vs-physical re-arm, tab resume, the **real rendered
PNG** (A19/A20), the export walkthrough with the backend stopped from an
independent static server, WASM/CSP/static packaging, browser `crypto.subtle`,
`BehaviorPanel` render, pixels. `find docs/acceptance/evidence-m2 -iname '*.png'`
= **0** (and no `data:image/png;base64` anywhere in the evidence) — no
browser/hardware evidence was fabricated. The packet-37 procedures in
`tests/browser/m2-behaviors/README.md`, `tests/browser/m2-play/README.md` and
`evidence-m2/36` §9 remain sufficient and honest.

## 10. Verdict

**ACCEPT.** The two Gate I P1 blockers are genuinely and independently fixed
(P1-1: `len ≡ 55 (mod 64)` digests now equal `node:crypto`, including the real
951-byte container `4459c410…` vs the old `1066eae3…`, and publication now
succeeds end-to-end; P1-2: the production `composeExportRuntime` composition
consumes `ctx.intents` per §14.5 and the committed sample's `speed` moves the
character by `1.2635485` with a zero sampled `moveX`). All 29 accepted
docs diffs are applied to the correct sections with no unexpected
contract/decision change; the P2 follow-ups are disposed honestly; the
toolchain is green with no regression. Packet 37 is unblocked. This verdict is
this review record only — not owner approval and not a separate reviewer's
approval.

## 11. Exact next step

Start packet 37 (integrated M2 acceptance) — the owner desktop/browser
walkthrough per the packet-37 procedures, followed by Gate J review. No
automatic start.
