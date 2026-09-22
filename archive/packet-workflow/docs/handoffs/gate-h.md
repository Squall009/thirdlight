# Gate H review — stateful runtime, input, physics and controller (packets 29–32)

Reviewer: Gate H review session (independent of the packet 29–32 authors).
Prompt: `docs/planning/m2-packets.md` §"Gate review prompt (E–J)".
Tree: HEAD `5b746ee` + the uncommitted M2 working tree (no commit since
`5b746ee`). Scope: packets 29–32 only. Owner pre-approval tag applies to the
underlying packets (autonomous M2 build, 2026-09-18; final manual review
pending); this record is **this review only**, not owner or separate-reviewer
approval, and does not claim one.

## 1. Scope and method

Reviewed from the tree, the accepted contracts/decisions and the raw evidence —
not from the handoffs. Read: `docs/contracts/runtime.md` §8/§12/§13,
`docs/contracts/project-model.md` §21, `docs/contracts/dependencies.md` §3–§5,
`docs/contracts/sessions.md` §13.1, `docs/decisions/0002` §1,
`docs/planning/m2-contracts/{input,physics,platformer}.md`,
`docs/acceptance/evidence-m2/{14,29,30,31,32}/**`, the packet sources
(`packages/runtime`, `packages/input`, `packages/physics-rapier`,
`packages/platformer`), the fixtures under `fixtures/m2/{runtime,input,physics,course}`
and the suites under `tests/m2-{runtime,physics,controller}` /
`tests/browser/m2-{input,controller}`. Every required check was re-run; three
independent probes were written under `/tmp/gateh/` (no repository file was
modified by this review).

## 2. Executed evidence (re-run on the current tree)

| Check | Result |
|---|---|
| `npm test` | **119 files / 1562 passed**, exit 0 (matches packet 32's claim) |
| `npm run typecheck` | exit 0, 14 packages |
| `npm run check-deps` | exit 0 (installed pin table includes `@dimforge/rapier2d-compat 0.20.0 = §7 pin`) |
| `npm run check-boundaries` | exit 0 — 14 packages / 251 files / 908 specifiers, 0 violations |
| `npm run build` | exit 0 — 4 built / 0 skipped |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | 34/34 groups, 0 problems |
| runtime / input / physics / course fixture checkers | all exit 0 |
| targeted real-Rapier suites (`packages/{physics-rapier,platformer,input,runtime}`, `tests/m2-*`) | 29 files / 339 passed, exit 0 |
| `packages/physics-rapier` create/dispose cycles | reproduced: 100 cycles, **62 colliders / 61 bodies per cycle**, stale-handle throw after each dispose, fresh port works; JS heap +2.04 MB, RSS +95 MB (non-shrinking WASM memory) |
| packet-32 course measurements (`--reporter=verbose`) | reproduced byte-for-byte vs the manifest table (see §3) |
| contracts/decisions untouched by 29–32 | `git diff --stat 5b746ee -- docs/decisions` **empty**; contracts = 7 files +5292/−157; no contract/decision file has an mtime after 06:09 (Gate G repair), while all packet 29–32 artifacts are 06:41–08:00 → **no contract/decision edit by 29–32** |
| pin | lockfile, `node_modules/.package-lock.json` and the live registry all report `0.20.0`, `sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`, Apache-2.0 — equal to decision 0002 §1 |
| ownership edges | `runtime` imports only `@thirdlight/project-model`; `platformer` and `input` import `@thirdlight/runtime` **types only**; `physics-rapier` imports runtime types + the pin — no concrete physics/input implementation in `runtime`/`platformer` |
| M1 regression | `packages/runtime/src/{demo,demo.test,fixed-step,lifecycle,interp,snapshot,registry,diagnostics}.ts` and all pre-M2 fixtures are **unchanged** vs `5b746ee`; the frozen §7.1 demo points replay bit-exactly |

### Independently re-derived numbers (not taken from the handoffs)

- **Fixed-step discipline** from `fixtures/m2/runtime/scheduler-traces.json` +
  `tests/m2-runtime/runtime-fixtures.test.ts` and the accepted
  `catchup.json`: `S2` stall 1 s → `stepIndex 22`, `droppedSteps 112`,
  `sampledStepIndices 12..21` (8 executed + 2), no dropped index sampled and
  every executed index sampled once; `S3` press → `pressedCount 1` at index 12;
  `A13` stall 5 s → 8 executed, 592 dropped, `physicsSteps == stepIndex`,
  one jump start. ≤ 8 steps/frame, no phantom step/edge: **PASS**.
- **Fail-stop** (F1, step 13): a transform write followed by a throw is not
  observable; `runtime.start()`/`tick()` refuse with `runtime_failed`; dispose
  is idempotent, module/port dispose exactly once. **PASS for failures after a
  completed step** — see finding F1 for the pre-commit window.
- **Course numbers vs the approved tolerances** (recomputed): idle rest
  `0.909998733` (±0.0005), flat run `3.999369` / Y-dev `0.003563`, accel 12 /
  decel 8, seam 0 ungrounded, jump apex gain `1.219662501` (contract model
  recomputed independently in Python: **1.2196625**, diff <1.2e-9; tolerance
  1.249 ± 0.05), release `vy33 = 0.5·(vy32 + g·dt)` = `3.25475` exactly,
  wall stop `9.190162` (≤5 mm penetration), ceiling `3.089910` ≤ 3.095 with 0
  rise after contact, ledge `0.006568` blocked Δx, ramps `+2.1209 m` / `+0.007645 m`,
  Z-lock `z = 0` and no `z` key in any result, stall ≤ 8. Slope table measured
  29.9° `0.8668967` / 30.0° `0.8660254` / 44.9° `0.7083398` / 45.0° `0.7071068`
  grounded, 45.1° `0.7058716` raw-grounded but `steepSlope` ⇒ not grounded;
  cos values recomputed independently. Snap-within `minY 0.859638`, 0 ungrounded.
  Snap-beyond: reproduced **9 grounded+snapped descent steps, then ~20
  ungrounded free-fall steps**, landing `0.36000` (see F6).
- **Resource release**: per-cycle library counts and post-dispose throw
  reproduced (§2). The RSS growth is correctly labelled a bounded-growth smoke
  check, not a leak proof.
- **Real-library character controller**: parentless capsule collider (created
  with no parent rigid body, moved by `setTranslation`), `createCharacterController(0.01)`,
  `computeColliderMovement`/`computedMovement`, snap 0.1, autostep never
  enabled; `grounded` from `computedGrounded()` and support normals from
  `computedCollision(i).normal1`. Confirmed in `packages/physics-rapier/src/port.ts`.

### Reported-only evidence

The packet-14 desktop procedure, packet-30 physical keyboard/gamepad logs and
the packet-32 browser course are **not run** (no browser, WebGL, GPU, monitor
or gamepad in this container). Their recordings are procedure text only. The
`06-cpu.json`/`06-cpu-raw.txt` numbers are real container/Node measurements but
directional (BR-2) and are not re-quoted here (see F7).

## 3. Findings (prioritized)

**F1 (P1 — code, runtime core). Fail-stop before the first committed step
publishes the abandoned step's state.** `RuntimeInstance` initialises
`committed = null` and only sets it after a successful step
(`packages/runtime/src/runtime.ts`), while `getInterpolatedState()` falls back
to the live `prev`/`curr` when `committed === null`. M2 fail-stop abandons the
step without restoring `curr` (unlike M1's `stepOnce` backup). A throw during
the 12-step settle pre-roll therefore renders the abandoned transform.
Reproduced by two probes: (a) a transform-phase module writes
`curr.x = 9` then throws on step 0 → rendered `x = 9`; (b) a mere transform-phase
throw after the runtime committed the port's step-0 result → rendered
`x = 0.05` with `stepIndex = 0`. This violates `runtime.md` §13 item 1
("`prev`/`curr` keep the values committed at the end of the last fully
completed step") and item 4 ("the last completed render state is retained"),
and overstates packet 29's "fail-stop renders only last committed state" (its
tests only throw after step 13). *Minimal repair:* initialise
`committed = cloneCurr(args.curr)` at instantiate **or** restore `curr` from the
per-step `backup` in `failStop`; add a fail-stop fixture case for a first-step
throw (F1b) and re-derive `fixtures/m2/runtime/failstop.json`. Owner: runtime.
Required before packet 34's behaviour fail-stop acceptance and Gate J; does
**not** block packet 33.

**F2 (P2 — code, `@thirdlight/input`). Lower-index gamepad takeover produces a
phantom `pressed`.** In `packages/input/src/browser.ts` `pickActiveGamepad()`,
the "a lower-index standard pad takes over" branch switches `activeIndex`/
`activeId` without entering the `awaitingRelease` fresh-activation state that
the disconnect and index-reuse paths set (via `deviceLost`). A new lower-index
pad whose face button is already held yields `pressed` on the takeover sample.
Reproduced with a probe: `f12 (index 1) moveX 1 jump none` → `f13 (index 0
takeover, button0 held) moveX −1 **jump pressed**`. `input.md` §4.4/§5.4
require the takeover to be "subject to the same `awaitingRelease` rule (no
phantom `pressed` from a button that was already down)"; A11 claims hot-plug
correctness. The existing test
(`packages/input/src/browser.test.ts` "…lets a lower one take over") asserts
only `moveX`. *Minimal repair:* route every active-pad change through the
`deviceLost`-style fresh-activation transition (or suppress the latch on a
device change) and add a jump-asserting takeover test. Owner: input. Required
before the packet-37 A11 physical-device run; not blocking packet 33.

**F3 (P2 — test integrity/fixture). Accepted fixture O7 is not exercised as
written.** `fixtures/m2/contracts/runtime/catchup.json` `O7-controller-count`
declares `controllerCount: 2` → `config_invalid`/`controller_target`; the real
runtime first rejects a 2-controller scene as `snapshot_invalid`
(`controller_count_invalid`) — verified by probe. `tests/m2-runtime/runtime-fixtures.test.ts`
maps `controllerCount !== 1` to `0`, so the test passes with a substituted
scene and never exercises the declared fixture. This is a test workaround that
masks a fixture/contract mismatch (recorded as C29-8). *Minimal repair:* make
O7 the reachable 0-controller case, add a scene-validation case for count 2,
remove the coercion from the test. Owner: runtime + fixtures. Gate-H repair.

**F4 (P2 — contract integrity; C30-1). The accepted input device-binding
contract is not in `docs/contracts/`.** `input.md` §4–§5 (mapping, dead zone,
arbitration, suppression, suspension/fresh activation, hot disconnect,
unavailable API, attach/dispose) exist only in `docs/planning/m2-contracts/`,
while accepted text cites them normatively: `runtime.md` §8
(`inputSuspendCount` … "`input.md` §5"), §12.5 ("`input.md` §3"),
`dependencies.md` §3 (`input` row home "runtime.md §12.5", which contains only
the sampling model). Packet 30 therefore implemented against a Gate-E-accepted
**proposal**, not a promoted contract. *Minimal repair:* promote the exact
`input.md` §4–§5 text into `docs/contracts/runtime.md` §12.5.4–§12.5.8 (or a new
`docs/contracts/input.md`) and repoint the references. Docs-only; reopens the
Gate E I-5 destination portions. Required before Gate J and before packet 35
wires the binding; not blocking packet 33.

**F5 (P2 — contract integrity; C32-1/C31-4). The slide policy is normative
behaviour absent from the accepted controller contract.** `packages/platformer/src/controller.ts`
implements a `min_slope_slide_deg`-driven slide (steep normal **or** a bounded
descending ground-contact correction whose slope ≥ `tan(min_slide)`, gated on
`moveX === 0`), while `platformer.md` §7 A–K defines no slide and
`physics.md` §8 wrongly attributes sliding to "the adapter's
`setMinSlopeSlideAngle`". Packet 31 measured no autonomous adapter sliding at
30° (C31-4). The rule is measured and reasonable but unauthorized by the
accepted contract. *Minimal repair:* promote the exact rule (including the
ratio guard that prevents flat-ground snap noise from driving a resting
character) into the promoted §7 location and correct the `physics.md` §8
attribution; optionally follow up the packet-31-scope change (retain the true
contact normal while snapping) so the policy no longer depends on the
correction. Docs + bounded note; no code change. Required before Gate J; not
blocking packet 33.

**F6 (P3 — reporting accuracy; C32-5). The snap-beyond row and C32-5's premise
are wrong.** The committed artifacts show the 0.50 m drop is descended over
9 grounded+snapped steps **and then ~20 ungrounded free-fall steps**
(probe output), landing at 0.36. Packet-31's "19 free-fall steps" note is
therefore *consistent* with the packet-32 run, not contradicted by it.
`docs/acceptance/evidence-m2/32/manifest.md` ("descended over 22 grounded +
`snapped` steps") and `docs/handoffs/32.md` should describe both phases; C32-5's
requested edit to packet 31 should be rejected (see adjudication). Test name/
`minUngroundedSteps` in `fixtures/m2/course/cases.json` are fine.

**F7 (P3 — reporting accuracy).** The packet-32 manifest's CPU paragraph quotes
percentiles (`p50 0.021403/0.017575/0.017188`, `p99 0.107875/0.085281/0.060668`)
that do not appear in the committed `06-cpu.json`/`06-cpu-raw.txt`
(`p50 0.021423/0.017361/0.016667`, `p99 0.116521/0.088128/0.060646`), and the
handoff's "p99 0.061–0.108 ms" omits the committed 0.1165. Quote the committed
artifact or re-record. Same class: `packages/physics-rapier/src/index.ts`
attributes its additive type exports to C31-2 (they are a separate additive
note); `packages/input/src/index.ts` says "promoted from `input.md` §1–§9"
contradicting C30-1; `tests/browser/m2-input/m2-input.browser.ts` exports a
pointer to a manifest section title that does not exist.

**F8 (P3 — observations, no repair required).** (a) The 45.1° steady state is
frozen (drift `(0,0)`) because the controller classifies it as not grounded
while the adapter clamps the downward command; the contract defines no
observable, so this is acceptable M2 diagnostic behaviour but should be stated
if a future packet relies on it. (b) After any downward snap the adapter's
`retainedSupport` is overwritten with the (downward) correction direction and
the reported normal is forced to (0,1), so `physics.md` §8 item 1's "support
normal of the contact" is not satisfied in steady-state slope contact; this is
the root of C31-2 and is covered by that diff. (c) `snapped` gates the 0.11 m
allowance on a *vertical* extra while the bound is on the 2D magnitude
(`runtime.ts` validation), so a snapped step could in principle carry a larger
horizontal correction; the real adapter's own bound makes it unreachable today.

## 4. Contract-change adjudication (all 26 recorded requests)

Legend: **A** = accept as recorded (no contract diff required); **D** =
accept-with-diff; **R** = reject as recorded. "Reopened portion" = the Gate E
destination text that a change reopens. "Required by" = when the repair must
land (all are docs-only unless stated).

| Item | Verdict | Reopened portion / minimal diff | Required by |
|---|---|---|---|
| C29-1 `requiresPhysicsPort` | D | `runtime.md` §12.1 `SimulationModuleSpec`: add optional field | Gate H repair |
| C29-2 `inputSamples` | D | `runtime.md` §8: `inputSamples` = executed-step samples = `stepIndex − settleSteps` | Gate H repair |
| C29-3 hard-coded platformer ID | A | none — §12.1 already declares the demo's `excludes`; the inversion alternative is declined | — |
| C29-4 `SimulationModule`/`phases` | D | `runtime.md` §12.1: name the M2 interface `SimulationPhaseModule`; `phases` optional ⇒ implicit M1 `transform` | Gate H repair |
| C29-5 `ctx.state` | D | `runtime.md` §12.2 `StepContext` block: add `state` | Gate H repair |
| C29-6 M2-only diagnostics | D | `runtime.md` §8: qualify the M1 key set and the example | Gate H repair |
| C29-7 §12.4 header codes | D | `runtime.md` §12.4 header: replace "fails with `config_invalid`" with the table's codes | Gate H repair |
| C29-8 O7 unreachable | D | `fixtures/m2/contracts/runtime/catchup.json` O7 + `runtime.md` §12.4 row 7 / project-model §21.1 note + remove the test coercion (F3) | Gate H repair |
| C29-9 §12.0 promotion artifact | D | `runtime.md` §12.0 body: drop the platformer-scope ownership text | Gate H repair |
| C30-1 input promotion gap | D | promote `input.md` §4–§5 into `docs/contracts`; repoint §8/§12.5/§13/dependencies §3 (F4) | before 35 / Gate J |
| C30-2 both-keys-cancel prose | D | promoted device-binding §4.3 item 1: keys cancel, stick still applies | with C30-1 |
| C30-3 `createStepInputSource` row | D | `dependencies.md` §3 `input` row: add the names or mark non-exhaustive | Gate H repair |
| C30-4 rounding direction | D | `runtime.md` §12.5.3: state `Math.round` (half toward +∞); keep the runtime quantizer | Gate H repair |
| C30-5 iframe `allow="gamepad"` | D | `sessions.md` §13.1 + `packages/editor/src/ui/App.tsx` when packet 35 attaches input; `gamepad`'s default allowlist is `*`, so this is required hardening once a `Permissions-Policy` exists | before 35 / A11 |
| C30-6 latch in awaiting-release | D | promoted §5.3: state the tap is dropped (no latent edge) | with C30-1 |
| C31-1 45.1° cos typo | D | `physics.md` §8 table: `0.70587157`; fixture note already correct | Gate H repair |
| C31-2 `snapped` vs 1 mm | D | `runtime.md` §12.6 + `physics.md` §8 item 5: `snapped` = any bounded ground-contact correction (either direction) ≤ `snap + skin`, beyond which the adapter throws. **The contract tolerance needs the diff**, not the implementation: the 11.3 mm push-out is real 0.20.0 behaviour and the alternative (non-`snapped` 1 mm) would refuse a legitimate library result | Gate H repair |
| C31-3 snap chaining | A | none (consistent with §8 item 5); wording covered by F6 | — |
| C31-4 no adapter slide at 30° | A | closed by packet 32's controller slide (C32-1); the `physics.md` §8 attribution is fixed by C31-5 | — |
| C31-5 Rapier grounded at 45.1° | D | `physics.md` §8 item 4: remove the false "Rapier does not produce it for a refused slope" parenthetical | Gate H repair |
| C31 additive notes *(bounded note, not a numbered `C31-n` request)*: extra type exports/`PhysicsPortError`; optional config fields | D (bounded) | `dependencies.md` §3 `physics-rapier` row: mark non-exhaustive; fix the `index.ts` misattribution (F7) | Gate H repair |
| C32-1 slide policy absent | D | promote the exact slide rule (steep normal **or** bounded descending correction with the `tan(min_slide)` ratio guard, gated on `moveX === 0`) into the promoted §7 location; fix the `physics.md` §8 attribution (F5) | before Gate J / 35 |
| C32-2 window constants | D | `dependencies.md` §3 `runtime` row: remove `CONTROLLER_CONSTANTS`/window constants (owned by `platformer`) | Gate H repair |
| C32-3 coyote prose | D | `project-model.md` §21.6 coyote row: the prose is **two** steps short — the fixture/algorithm permit `m+1..m+7` and refuse `m+8`, not `m..m+5`; reconcile the "6 executed steps" label | Gate H repair |
| C32-4 12 m/s runway | D | `fixtures/m2/course/tolerances.json` T9: record the achieved 8.67 m/s (or add runway); no code change | bounded, before Gate J |
| C32-5 packet-31 snap note | **R** | no packet-31 change: the probe shows ~20 ungrounded steps, consistent with "19 free-fall steps". Correct the packet-32 manifest/handoff instead (F6) | — |
| C32-6 apex confirmation | A | none (independently verified 1.2196625) | — |

Counts across the 26 numbered requests (C29-1…9, C30-1…6, C31-1…5, C32-1…6): **21 accept-with-diff, 4 accept as recorded, 1 rejected**; the extra `physics-rapier` additive-notes row above is a bounded note, not one of the 26.
Every "D" reopens the named Gate E destination portion; per the gate prompt
those portions are re-accepted only when the docs-only repair lands (owner
pre-approval tag; final manual review pending).

## 5. Blockers vs bounded follow-ups

- **No blocker for packet 33.** Packet 33 (immutable behaviour builds) depends
  on the behaviours contract (`project-model.md` §22, `runtime.md` §14) and
  workspace publication — none of the reopened Gate E portions (§12.0–§12.6,
  §8, `physics.md`/`platformer.md`/`input.md`/`dependencies.md` rows) lie on its
  dependency path.
- **Required repairs before their dependents** (bounded, named owners):
  - R1 = F1 (runtime `committed` initialisation + fixture) — before packet 34's
    fail-stop acceptance and Gate J.
  - R2 = F2 (input takeover fresh activation + test) — before the packet-37 A11
    physical-device run.
  - R3 = F3 (O7 fixture + test coercion) — Gate H repair.
  - R4 = F4/C30-1 (input promotion) + C30-2/C30-6 — before packet 35 and Gate J.
  - R5 = F5/C32-1 (slide promotion) — before Gate J.
  - R6 = the docs-only "D" rows §4 (C29, C30-3/4/5, C31, C32-2/3/4) — the
    Gate H repair step; C30-5 lands with packet 35 if it touches `App.tsx`.
  - R7 = F6/F7 reporting corrections — Gate H repair.
- **Gate-J-blocking carry-over:** the physics selection remains PROVISIONAL
  (decision 0002 §1) and the BR-3 topology decision (secure-context gamepad on
  the plain-HTTP LAN vs localhost/TLS) is still owner-open; until it is
  recorded the A11/A12/A21 hardware rows cannot pass.

## 6. Missing context / unverified targets

Executed evidence is Node/CI only. No browser, WebGL/GPU, monitor, physical
keyboard or physical gamepad exists in this container, so the following remain
**UNVERIFIED** and must not be claimed:

1. physical keyboard behaviour and real-browser event/focus/suppression logs
   (A11 hardware half);
2. physical gamepad: standard mapping, dead zone/parity, hot disconnect,
   index reuse, iframe permissions, secure-context availability (A11; BR-3);
3. real tab-resume behaviour with hardware (A13's real-resume half);
4. real-browser WASM initialization, CSP interaction and standalone/static
   packaging of the adapter/controller composition (packets 14/31/32);
5. WebGL rendering, pixel/visual checks and any GPU timing (no GPU claim is
   made anywhere in 29–32);
6. total browser-side CPU (the packet-32 CPU is container/Node directional,
   BR-2); repeated-play resource release in a browser (A20);
7. the preview/export bundle graphs that will actually carry input/platformer/
   physics (packets 35/36) — only two probe bundles were built (2,191,202 B and
   the 3,513,230 B host).

The packet-14/30/32 procedures and the BR-3 note are **sufficient and honest**
for the owner: they name the environment to record, the secure-context/
Permissions-Policy question, the iframe `allow` attribute, real-PNG/log
collection and the evidence destination, and they never claim a synthetic
trace substitutes for hardware. The BR-3 owner decision must be recorded
before the packet-37 physical run.

## 7. Verdict

**Accept with bounded follow-ups.** Packets 29–32 are functionally complete,
their toolchain is green on a fresh run, the accepted contracts/decisions and
the M1 freeze are untouched, the pin and module boundaries are correct, and the
course/fixed-step/fail-stop/resource claims are reproducible — with the
exceptions recorded above. F1 and F2 are real, reproducible code defects with
one-line repairs; F3 is a masked fixture; F4/F5 are genuine Gate E promotion
gaps for text the implementations were built against; F6/F7 are reporting
inaccuracies. None blocks packet 33. Gate H is **not** owner- or
separate-reviewer approval; the reopened Gate E portions are re-accepted only
when R1–R7 land.

## 8. Exact next step

Apply the Gate H repair step **R1–R7 as one bounded, docs-and-test-first
change** (owner/implementer session): (1) initialise `committed` at instantiate
and add the first-step fail-stop fixture (F1); (2) fix the input takeover
fresh-activation path with a jump-asserting test (F2); (3) repair O7 and remove
the test coercion (F3); (4) promote `input.md` §4–§5 and apply the `D`-row
diffs in §4 plus the F6/F7 wording corrections. Then re-run the §2 checks and
record the repair under `docs/handoffs/gate-h-repair.md`; only after that
re-accept the reopened Gate E portions. Packet 33 is unblocked **now** and may
start independently of the repair, but R1 must precede packet 34 and R2/R5
must precede the packet-37 A11/A12 runs. Do not auto-start packet 33.
