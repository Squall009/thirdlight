# M2 evidence — packet 17: stateful runtime, input and 2.5D physics contract

Date 2026-09-18 (UTC) · runId `tl17-2026-09-18-a` · packet 17 of M2
(`docs/planning/m2-packets.md` §17). Gate E. All artifacts are sanitized: no
credentials, no project data, no owner content.

**Status: PROPOSED deliverables only.** Packet 17 is a contract-drafting packet.
Nothing here is accepted, nothing in `docs/contracts/` or `docs/decisions/`
changed, no code exists, no dependency was installed, no git commit was made.
Gate E records accept/reject per diff, and a separate docs-only promotion step
applies the accepted diffs before packet 20.

Owner pre-approval recorded in the drafts and diffs: **owner pre-approval
(autonomous M2 build instruction, 2026-09-18); final manual review pending.**

Mandatory recorded line: **selection per decision 0002 §1, owner pre-approval.**

## Environment (actual)

Same container host as the packet-14/15/16 runs (Proxmox LXC): Node v22.22.1 ·
repo-pinned TypeScript 5.9.3, esbuild 0.28.2, three 0.186.0, vitest 5.0.1 ·
`python3` 3.14.4 for the independent reference implementation. No browser, GPU
or physical gamepad was needed or used. No new dependency, no network access,
no lockfile change.

## Deliverables

| Claim | Artifact |
|---|---|
| Input/ActionFrame proposal (strict shape, sampling, latch, mapping, dead zone, arbitration, suppression/lifecycle, replay tolerances, failure outcomes) | `docs/planning/m2-contracts/input.md` |
| 2.5D physics port proposal (engine/distribution decision reference, XY/Z convention, shapes, physics-transform validation, injected port, init/cancellation/parentless trap, numeric defaults, grounding rule, settle pre-roll, failure outcomes) | `docs/planning/m2-contracts/physics.md` |
| Controller/lifecycle proposal (module phases, canonical step order, transform ownership, exact step algorithm, jump windows, static camera, fail-stop, gameplay settings registry, public exports) | `docs/planning/m2-contracts/platformer.md` |
| Exact section-level diffs to the accepted runtime contract + cross-file change requests | `docs/planning/m2-contracts/diffs/runtime.md` (R1–R18) |
| Packet-17 additions to the model diff (packet-15/16 sections preserved) | `docs/planning/m2-contracts/diffs/project-model.md` §"Packet 17 additions" (P17-A1…P17-A11) |
| Replayed fixtures + extended index/registry | `fixtures/m2/contracts/{input/action-sequences,physics/numerics,platformer/traces,platformer/failures,runtime/catchup}.json`, `expected.json`, `cases/constructed-cases.md` §C10 |
| Extended checker (independent reference model, negative-control-proven) | `fixtures/m2/contracts/tools/check-fixtures.mjs` (check groups `p17-*`) |
| Independent python3 implementation of the proposed input mapping, controller, scripted port and scheduler | `independent-recompute.py` (this directory), `06-independent-recompute.txt` |

## Claims → artifacts

| # | Claim | Artifact | Status |
|---|---|---|---|
| 1 | Every fixture parses strictly/canonically, is indexed, and every code it uses is declared | `01-fixture-check.json`, `02-fixture-check-run.txt` — 21/21 check groups, 0 problems, exit 0 | **verified** |
| 2 | The packet-17 checks are not vacuous | `05-negative-control.txt` — five corrupted values in a copy fail `code-registry`, `p17-numerics`, `p17-traces`, `p17-input`, `p17-catchup`, `p17-failures` (exit 1); the parser/vacuity self-test group runs on every checker run | **verified** |
| 3 | Numerical expectations are table-driven and independently re-derived | `platformer/traces.json` (16 traces, 178 sampled step rows, 48 derived expectations) re-derived by a second python3 implementation (`06-independent-recompute.txt`, verdict OK) **and** by the JS checker | **verified (contract/fixture level)** |
| 4 | The contract model reproduces packet-14's measured jump trajectory | apex gain `1.2196625 m` from the settled `0.910 m` rest center, which is the probe's reported `1.2297 m` measured from the nominal `0.900 m` center over a settled start of `0.9099987 m` (agree to `3e-7 m`); the `±0.05 m` tolerance around the `1.249 m` theory also holds | **verified (model vs recorded evidence)** |
| 5 | Wall, head, ledge, seam, snap, high-speed and no-Z-drift expectations are pinned numerically | traces `wall-stop` (stop center `9.190` = face `9.5` − `0.31` skin, contact step 47, no penetration), `head-bump` (max center `2.670` = `3.58` − `0.91`, `maxVyAfterContact 0`, no sustained rise), `ledge-block-and-jump-on` (blocked at center `11.690`, `maxDxWhileBlocked 0`, landing center `1.310` = `0.4` + `0.91`), `high-speed-wall-approach` (12 m/s, no penetration), `no-z-drift` (expectation table carries authored z/rotation/scale on every row), `seam-cross` (0 ungrounded steps over a 2 cm gap against the allowed 2), `snap-within-distance` (0.06 m step down absorbed, final center `0.850`), `snap-beyond-distance` (first ungrounded at step 51, landing at step 66 at center `0.760`) | **verified (contract/fixture level)** |
| 6 | Jump windows, release, buffer, coyote and no-air-jump are integer-step exact | `jump-hold-full-height`, `jump-tap-release`, `jump-buffer-lands-in-window` (lands at step 18, jump fires at the last buffered step 19), `jump-buffer-expired` (landing at 45, no jump), `jump-coyote-last-step` (jump at the last coyote step 21), `jump-coyote-one-step-late` (no jump), `no-air-jump` (one start, `maxVy = jump_velocity − g·dt`) | **verified (contract/fixture level)** |
| 7 | Focus/disconnect/hidden-tab, invalid parenting/scale/rotation, duplicate writer, unsupported combination, module-throw-after-physics, init cancellation, repeated catch-up edges and dropped wall time all have specified outcomes | `platformer/failures.json` (21 cases with code, runtime state, durable effect) + `input/action-sequences.json` (15 mapping cases, 5 sequences) + `runtime/catchup.json` (7 scheduler + 8 ownership cases) | **specified (not executed — no implementation exists)** |
| 8 | Neutral-input / fresh-resume rules and replay tolerances are exact | `input.md` §5.3/§6 (neutral frames, `awaitingRelease`, no pre-suspension edge, exact same-engine replay, `1e-3 m` cross-engine bound), replayed in `input/action-sequences.json` Q4/Q5 | **verified (fixture level)** |
| 9 | No phantom steps after dropped wall time; ≤ 8-step catch-up retained | `runtime/catchup.json` C3/C7 re-derived by the checker (8 executed, 112/52 dropped, contiguous indices, one sample per executed step) | **verified (fixture level)** |
| 10 | Engine/distribution decision referenced, not re-decided; pin not installed | `physics.md` §"selection per decision 0002 §1"; `04-proposal-check.txt` — `docs/decisions` untouched (sha256 `2d6aa6c9…`), no `packages/` change, lockfile `98bf340a…` unchanged, `git diff --stat HEAD -- docs/contracts docs/decisions package.json package-lock.json` empty | **verified** |
| 11 | Container numbers stay labeled directional (BR-2) | `physics/numerics.json` constants carry `packet-14-directional (BR-2, not a reference-desktop claim)` labels for the p99 step cost and cold-init range | **verified** |
| 12 | Repository toolchain stays green | `03-toolchain.txt` — checker exit 0 (21/21), `npm test` 841/841 (66 files), `npm run typecheck` exit 0 (10 packages), `check-deps` OK, `check-boundaries` OK (10 packages / 150 files / 514 specifiers), `npm run build` exit 0 (4 built, 0 skipped) | **verified** |

## Acceptance criteria (m2-packets.md §17)

| Criterion | Status |
|---|---|
| Step-indexed `ActionFrame`, injected input/physics ports, fixed phase registration, module-owned transform policy, fail-stop lifecycle specified | **PASS** (input.md, physics.md, platformer.md; runtimes diffs R1–R17) |
| Exact collision tolerances and movement defaults selected from packet-14 evidence, with contract-selected values labeled | **PASS** (physics.md §7; numerics fixture source labels) |
| Table-driven numerical expectations (flat ground, slope thresholds, slide/snap, seams, ledges, jump windows, head/wall, high-speed, no Z drift) | **PASS** (traces fixture; seam/ramp phases remain packet-14 evidence because the scripted analytic port covers axis-aligned statics only) |
| Neutral-input/fresh-resume rules, replay tolerances, no phantom steps after dropped wall time | **PASS** (specified + replayed) |
| All private-state failure paths require safe restart, not transform-only rollback | **PASS** (platformer.md §9; failures fixture state machine) |
| Fixed static camera convention included | **PASS** (platformer.md §8) |
| Module phase registration/ownership consistent with dependencies.md §6 and runtime.md §5.1/§5.2 | **PASS** (runtime diff R8/R16; dependencies change request R18) |
| Rapier 2D compat 0.20.0 kinematic-controller working decision recorded with the parentless-collider trap and snap | **PASS** (physics.md §6; mandatory line in every draft) |

## Limitations

- The traces replay a **scripted analytic port** (flat ground and axis-aligned
  statics), not Rapier: no WASM, no collider, no browser and no gamepad are
  involved. The seam and ground-snap traces use that analytic model (the seam gap
  and the snap distances are authored in the fixture), so they pin the *contract's*
  snap rule and the "no ungrounded step on a 2 cm seam" expectation, not Rapier's
  realised contact behaviour. The 43°/47° ramps and the climb/slide split remain
  packet-14 evidence plus the contract's normal-based classification table; the
  real adapter course is packet 32's.
- The contract's slider thresholds are normal-based (`supportNormal.y` vs
  `cos(45°)`), while packet 14 measured Rapier's `setMaxSlopeClimbAngle`
  behaviour at 43° (climb) and 47° (refuse). The 44.9°/45.0°/45.1° rows are
  classification arithmetic, not new engine measurements.
- Acceleration/deceleration, jump-release factor and the coyote/buffer windows
  are contract-selected (the probe commanded instantaneous velocity and had no
  windows); they are labeled as such in `physics.md` §7 and in the fixtures.
- No browser, CSP, WASM-init, gamepad, secure-context or desktop CPU evidence
  exists in this packet; packet 14's provisional selection and BR-2 labels stand.
- Fixture/table consistency and the independent recompute are established; no
  contract conformance by code, and no acceptance trace from a real physics
  world, is claimed.

## Artifacts in this directory

| File | Content |
|---|---|
| `01-fixture-check.json` | checker `--report` output (checks, failures, `ok: true`) |
| `02-fixture-check-run.txt` | full checker run (21 check groups) |
| `03-toolchain.txt` | checker, `npm test`, `typecheck`, `check-deps`, `check-boundaries`, `build` with exit codes |
| `04-proposal-check.txt` | proof that no accepted contract/decision/lockfile/package changed; explicit packet-17 file list |
| `05-negative-control.txt` | five-value corruption in a copy → 7 failures, exit 1 |
| `06-independent-recompute.txt` | python3 `--verify` on every fixture + spot values |
| `independent-recompute.py` | the second implementation (also the fixture generator) |
