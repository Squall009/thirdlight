# Packet 32 — 2.5D platformer controller and diagnostic course: evidence manifest

Packet 32 (`docs/planning/m2-packets.md` §32), gate H. Owner pre-approval:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final
manual review pending.** Selection per decision 0002 §1. No git commit was
made. Not started: packet 33, the Gate H review.

## Outcome (one line)

`@thirdlight/platformer` exists as the pure fixed-step controller module
`thirdlight.platformer:controller` (`platformer.md` §7 A–K + `physics.md` §8
grounding) over the injected input/physics ports, and it traverses the frozen
packet-14 diagnostic course in real Node runs through the real packet-31
Rapier adapter and the real packet-30 mapping, within the approved tolerances.

## Artifacts and what each establishes

| Artifact | Claim |
|---|---|
| `01-toolchain.txt` | Node 22.22.1 / npm / tsc 5.9.3 / esbuild 0.28.2 / vitest 5.0.1 / i5-12600H container; **no browser, no GPU/WebGL, no gamepad, no monitor** |
| `02-controller-tests.txt` | `npx vitest run packages/platformer` — 2 files / 26 tests: constants, §7 A–K order, single jump, variable height, coyote/buffer edges, head clamp, max fall speed, grounding classification, slide policy, staging and module metadata |
| `03-course-cases.txt` + `03b-measured-table.txt` | `tests/m2-controller/course-cases.test.ts` — 27 tests over the real adapter + real mapping: the measured per-case table quoted below |
| `04-contract-traces.txt` | `tests/m2-controller/contract-traces.test.ts` — all 16 accepted packet-17 traces × **178 sampled rows** replayed exactly (position/velocity ≤1e-9, counters/flags/contacts exact) against the real TypeScript controller + the fixture's scripted analytic port |
| `05-failures.txt` | A13 stall/dropped wall time (≤ 8 steps, 592 dropped, no phantom port step), one jump edge across the catch-up burst, stop/start state retention, A14 fail-stop after a physics mutation with the last committed state retained and no resume, snapshot deep-freeze/immutability, disposal |
| `06-cpu.json` + `06-cpu-raw.txt` | **directional (BR-2)** composed-fixed-step CPU on the packet-14 fixture (64 statics, 120 Hz), 3 runs × 5 s warmup + 30 s sample, `hrtime.bigint()`; recorded percentiles below |
| `07-checks.txt` | the full toolchain: `npm test`, `typecheck` (14 packages), `check-deps`, `check-boundaries` (14 / 251 / 908), `build` 4 built, the contracts checker 34/34 and the physics/input/runtime/course fixture checkers |
| `08-course-fixture-checker.txt` | `fixtures/m2/course` re-derived independently: 64 statics from the packet-14 spec, byte-identical packet-31 slope/snap geometry, slope `cos` table, 28 cases, 24 sequences, credential scan — 9/9 |
| `09-negative-boundary-probe.txt` | the disposable probe (`node:fs`, `three`, a runtime **value** import, `physics-rapier`) fails check-boundaries 4/4; removed; tree green afterwards |
| `10-browser-harness-build.txt` | the manual browser host bundles under the pinned esbuild option set (3,513,230 bytes, sha256 `e352e98d…`) — a build check only |
| `11-lockfile-and-diff.txt` | the scoped diff and the lockfile delta (the `@thirdlight/platformer` link/entry only, +11 lines) |
| `fixtures/m2/course/**` + `tools/check-course-fixtures.mjs` | the frozen course, tolerance table, raw input atoms/sequences, 28 diagnostic cases, SHA-256 index and the independent checker |

## Measured results vs the approved tolerances (real adapter, real mapping)

| Case | Measured | Tolerance | Verdict |
|---|---|---|---|
| `idle-settle` | rest centre 0.909998733, max Δy 0 | 0.910 ± 0.0005, ≤ 0.001/step | PASS |
| `flat-run` | mean speed 3.999369, max Y deviation 0.003563, 0 ungrounded | 4 m/s ± 5 %, ≤ 0.005 | PASS |
| `accel-decel-steps` | vx = 4.0000002 at step 11, 0 at the 8th deceleration step | 12 steps / 8 steps | PASS |
| `seam-cross` | 0 ungrounded steps, grounded fraction 1.0 | ≤ 2 ungrounded | PASS |
| `jump-hold` | apex gain **1.2196625** from the settled rest centre (the `platformer.md` §7 contract-order value), max vy 6.8365, lands back at rest | 1.249 ± 0.05 | PASS |
| `jump-tap` | release halves the ascending vy exactly (6.673 → 3.25475), apex below hold | factor 0.5 | PASS |
| `no-air-jump` | exactly 1 jump start, max vy ≤ 7 | single jump | PASS |
| `wall-stop` | stops at x = 9.19016, 0 penetration | 9.19 ± 0.05, ≤ 0.005 | PASS |
| `high-speed-wall` | achieved approach 8.67 m/s (runway-limited, C32-4), stop 1 step after contact, 0 penetration | ≤ 0.005, ≤ 10 steps | PASS (approach speed recorded) |
| `high-speed-ledge` | approach 12.0 m/s, max x 9.19037, stop 2 steps after contact | 12 m/s, ≤ 0.005, ≤ 10 | PASS |
| `ceiling-head-bump` | max centre y 3.089910, max rise after the strike 0 | ≤ 3.095, ≤ 5e-4 | PASS |
| `ledge-block-and-jump` | blocked max Δx 0.006568, lands at y 1.309999 | ≤ 0.02, 1.31 ± 0.05 | PASS |
| `ramp-a43-climb` | +2.1209 m gain, grounded fraction of the ascent 1.0 | ≥ 1.0 m, ≥ 0.95 | PASS |
| `ramp-b47-refuse` | +0.007645 m over 1 s of pushing | ≤ 0.3 m | PASS |
| `slope-threshold` | 29.9° 0.8668967 / 30.0° 0.8660254 / 44.9° 0.7083398 / 45.0° 0.7071068 grounded, 45.1° 0.7058716 grounded-per-library but `steepSlope` ⇒ not grounded by the controller | cos table ± 0.002, 45.1° refused | PASS |
| slide (C32-1) | 29.9° drift (0, 0); 30.0° drift (−0.678, −0.277); 44.9° (−0.350, −0.144); 45.0° (−0.350, −0.143); 45.1° (0, 0) | below the minimum slide angle: no drift; at/above: slides downhill | PASS |
| `snap-within` | 0.05 m step absorbed, 0 ungrounded, min y 0.859638 | never airborne | PASS |
| `snap-beyond` | 0.50 m drop is descended over a chain of grounded + `snapped` steps (10 `snapped` descent steps; max single-step drop 0.0572), **then 20 ungrounded free-fall steps**, landing at 0.36000; 22 `snapped` steps total in the deep region (x > 10) | ≤ snap+skin per step; lands on the lower floor ±0.05 | PASS (see C32-5) |
| `jump-buffer-*` | press 6 steps before landing fires; 10 steps before does not | 8-step window | PASS |
| `coyote-*` | last grounded step 86: press at 93 fires, at 94 does not (m+7 / m+8) | fixture model; §7.1 prose corrected to `m+1 .. m+7` (C32-3) | PASS |
| `no-z-drift` | z = 0, rotation/scale unchanged over 120 steps; no result object carries a `z` key | bit-identical | PASS |
| device parity | gamepad 3.791891 = keyboard 3.791891 | equal | PASS |
| A13 stall | 8 executed, 592 dropped, `physicsSteps == stepIndex`, one jump edge | ≤ 8 steps, no phantom step | PASS |
| A14 fail-stop | `failed`, 1 `physics_port_error`, last committed state retained, no resume, dispose ×1 | fail-stop without rollback | PASS |

**CPU (directional, BR-2 — container/Node, not the reference desktop, no
browser/GPU claim):** composed fixed step on the packet-14 fixture, 3 runs ×
3 600 samples, exactly as committed in `06-cpu.json`: p50 0.021423 / 0.017361 /
0.016667 ms, p95 0.065137 / 0.029758 / 0.025263 ms, p99 0.116521 / 0.088128 /
0.060646 ms against the 8.333 ms tick budget. The composed step is the whole
`runtime.tick(one step)` (phases + write guard + diagnostics + controller +
real Rapier), so it is not comparable one-to-one with packet 14's
controller+`world.step` probe.

## UNVERIFIED (no browser/hardware in this container)

1. **Real browser course with a physical keyboard and a physical gamepad**
   (A12/A13's device half), including real-tab-resume behaviour with hardware.
2. Real-browser WASM initialization, CSP interaction and static packaging of
   the controller composition (packet 31 carried the same item).
3. All visual/rendering claims (there is no WebGL context here) and any
   browser-side CPU number.
4. GPU performance — no GPU timing claim is made anywhere in packet 32.

Procedure: `tests/browser/m2-controller/README.md` (build the `.browser.ts`
host with the pinned esbuild, serve the repo root, run the keyboard and
physical-gamepad passes, collect `window.__m2Controller.collectEvidence()`),
recorded under `docs/acceptance/evidence-m2/37/` by packet 37. The harness
itself only **builds** here (`10-browser-harness-build.txt`).

## Contract-change requests

- **C32-1 — the slide policy is absent from `platformer.md` §7.** The
  controller implements the declared `min_slope_slide_deg` threshold
  (settings-derived; support normal at/below `cos(min_slide)` **or** a bounded
  downward ground-contact correction whose slope is ≥ `tan(min_slide)`, gated
  on `moveX === 0`), staged as a downhill horizontal command that the port's
  ground snap turns into along-surface motion. Proposed diff: add the rule as
  a normative step in §7 (the ratio guard is required — without it, flat-ground
  snap noise drives a resting character, which was measured and fixed before
  the fixture was frozen). Related adapter note: the real 0.20.0 adapter
  reports the support normal as (0, 1) on resting/snapped steps (C31-2), so the
  steep-normal branch only fires on a fresh contact; the descent branch carries
  steady-state sliding. A packet-31-scope change (retain the true contact
  normal while snapping) would make the policy independent of the correction.
  **Applied in the Gate H bounded repair (2026-09-19):** the rule now lives in
  `platformer.md` §7.4 (with the §7 algorithm step H reference and the
  `physics.md` §8 attribution corrected) and as a `project-model.md` §21.6
  contract row.
- **C32-2 — the runtime constant exports proposed by `runtime.md` §12.8**
  (`JUMP_BUFFER_STEPS`, `COYOTE_STEPS`, `JUMP_RELEASE_FACTOR`, `MOVE_ACCEL`,
  `MOVE_DECEL`; only `SETTLE_PREROLL_STEPS` exists) are not implemented.
  Packet 32 owns them in `@thirdlight/platformer`'s `CONTROLLER_CONSTANTS`
  (the `platformer → runtime` edge is types-only, so it cannot re-export
  runtime values). Proposed diff: amend §12.8 / the `dependencies.md` §3 row.
- **C32-3 — `platformer.md` §7.1's coyote prose is one step short of the
  replayed fixture.** `jump-coyote-last-step` (last grounded result m = 14)
  permits the press at step 21 = m+7 and refuses m+8, while the prose says
  "m .. m+5". Packet 32 follows the fixture (and the fixture's independent
  checker); proposed diff: correct the prose. **Applied in the Gate H bounded
  repair (2026-09-19):** the prose is corrected to `m+1 .. m+7` (refuse `m+8`)
  in `platformer.md` §7.1 and `project-model.md` §21.6.
- **C32-4 — `T9_highSpeed`'s 12 m/s approach is unreachable on the frozen
  course from rest.** The corridor from the authored start to the wall face is
  1.29 m; the contract's 40 m/s² acceleration needs 1.8 m to reach 12 m/s, so
  the measured approach is 8.67 m/s (stop/penetration tolerances still PASS).
  A second case (`high-speed-ledge`) reaches 12.0 m/s against the ledge face
  over a longer run-up. Proposed diff: record the achieved approach speed in
  the tolerance, or add runway to the frozen course (a fixture re-freeze).
- **C32-5 — `physics.md` §9 / packet-31's snap note.** Packet 31 recorded "a
  0.50 m drop produces 19 free-fall steps"; the committed artifacts show the
  composed run **agrees**: the drop is descended over a chain of grounded +
  `snapped` steps (10 `snapped` descent steps; max single-step drop 0.0572 m),
  then ~20 ungrounded free-fall steps, landing at 0.36 (C31-3 snap chaining).
  The earlier "22 grounded + `snapped` steps" row here conflated the descent
  with every `snapped` step in the deep region; the corrected row above
  describes both phases. **C32-5's requested edit to packet 31 is rejected** —
  the packet-31 note is consistent with this run, not contradicted by it.
- **C32-6 (confirmation, no change requested)** — the measured jump apex gain
  from the settled rest centre is 1.219662501127459 m, which is exactly the
  `platformer.md` §7 contract-order model value (1.2196625 m) to 1e-9.

## Acceptance criteria (`docs/planning/m2-packets.md` §32; A12/A13/A14)

- **PASS (real adapter/Node)** — the numerical contract tests: single jump,
  variable height, grounding from support normals, sliding at the
  `min_slope_slide_deg` threshold, seam/snap/ledge/ceiling/fast-wall, coyote
  and buffer boundaries, repeated-jump rejection, Z locked, snapshot unchanged.
- **PASS (Node, injected fake DOM)** — packet-30 mapping parity for keyboard
  and standard gamepad raw snapshots and the focus-suspension rule.
- **UNVERIFIED** — the actual browser course with a physical keyboard and a
  physical gamepad, real-device tab resume, real WebGL rendering, real WASM
  init/CSP and any browser CPU claim (items 1–4 above).
- **Out of scope as required** — no M3 camera follow, respawn, hazards,
  animation state machine or complete game.
