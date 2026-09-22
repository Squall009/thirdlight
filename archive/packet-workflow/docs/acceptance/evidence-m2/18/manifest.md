# M2 evidence — packet 18: trusted behavior execution and compilation contract

Date 2026-09-18 (UTC) · runId `tl18-2026-09-18-a` · packet 18 of M2
(`docs/planning/m2-packets.md` §18). Gate E. All artifacts are sanitized: no
credentials, no project data, no owner content.

**Status: PROPOSED deliverables only.** Packet 18 is a contract-drafting packet.
Nothing here is accepted, nothing in `docs/contracts/` or `docs/decisions/`
changed, no code exists, no dependency was installed, no git commit was made.
Gate E records accept/reject per diff, and a separate docs-only promotion step
applies the accepted diffs before packet 20.

Owner pre-approval recorded in the drafts and diffs: **owner pre-approval
(autonomous M2 build instruction, 2026-09-18); final manual review pending** —
a pre-approval, **not** an independent review. This is the explicit owner
decision of this packet: the trusted-main-thread execution boundary with **no
hard runtime timeout and no hostile-code sandbox** (`behaviors.md` §2.2/§2.4).
If that disposition is rejected, the recorded next step is a separate
execution-boundary design packet (worker/process), not a packet-18 workaround.

## Environment (actual)

Same container host as the packet-14/15/16/17 runs (Proxmox LXC): Node v22.22.1 ·
repo-pinned TypeScript 5.9.3, esbuild 0.28.2, three 0.186.0, vitest 5.0.1 ·
`python3` 3.14.4 for the independent reference implementation. No browser, GPU or
gamepad was needed or used. No new dependency, no network access, no lockfile
change. HEAD `5b746ee`; the working tree carries the uncommitted M2 planning
docs and packet-15/16/17 outputs, which this packet preserved.

## Deliverables

| Claim | Artifact |
|---|---|
| Trust boundary, source record/container, static source rules + failure taxonomy, `compileBehavior`, compiler bounds, `behaviorTrust`, the staged publication pipeline and the "unavailable until packet 33" state, the `BehaviorSpec` lifecycle, the intent API and the runtime caps | `docs/planning/m2-contracts/behaviors.md` |
| Exact section-level diffs to the accepted runtime contract + cross-file change requests | `docs/planning/m2-contracts/diffs/runtime.md` §"Packet 18 additions" (R19–R30) |
| Packet-18 additions to the model diff (packet-15/16/17 sections preserved) | `docs/planning/m2-contracts/diffs/project-model.md` §"Packet 18 additions" (P18-A1–P18-A9) |
| New unit/edge/bundle-graph diffs (two new units, no new pin, no lockfile change) | `docs/planning/m2-contracts/diffs/dependencies.md` (D18-1–D18-10) |
| New export diff (static behavior linking, `meta.json`, scan binding) | `docs/planning/m2-contracts/diffs/export.md` (E18-1–E18-7) |
| Malicious-import and declared-behavior fixtures, source containers, one valid compiled example manifest with a declared numeric property | `fixtures/m2/contracts/behaviors/**`, `cases/constructed-cases.md` §C11, extended `expected.json` |
| Extended checker (five new independent check groups) | `fixtures/m2/contracts/tools/check-fixtures.mjs` (`p18-*`) |
| Independent python3 implementation of the source-graph rules, the intent model and the flood accounting | `independent-recompute.py` (this directory), `06-independent-recompute.txt` |

## Claims → artifacts

| # | Claim | Artifact | Status |
|---|---|---|---|
| 1 | Every fixture parses strictly/canonically, is indexed and every code it uses is declared | `01-fixture-check.json`, `02-fixture-check-run.txt` — 27/27 check groups, 0 problems, exit 0 | **verified** |
| 2 | Every committed source container is a real byte string whose SHA-256/length are recomputed and merged into the digest check | `p18-container-hash` — 16 containers re-hashed; `digest-claims` still green | **verified** |
| 3 | The source-graph failure taxonomy and the compiler bounds are re-derived, not restated | `p18-source-graphs` — 16 container cases + 25 constructed boundary rows re-derived from `behaviors.md` §4.3/§6 by the checker **and** by the python3 implementation | **verified (contract/fixture level)** |
| 4 | The intent validation order, quantization, ownership, duplicate/conflict rules, caps and the effective-frame identity are re-derived | `p18-intents` — 6 quantization rows, 18 two-phase step cases, 4 effective-frame rows; `platformer/traces.json`'s 178 rows stay the packet-17 identity case | **verified (fixture level)** |
| 5 | Exception/log/intent floods are bounded with exact accounting | `p18-runtime-failures` — 21 cases + 6 flood rows (e.g. 1 000 `ctx.log` calls in one step → 16 retained, 984 dropped, `errorCount` unchanged) | **specified (not executed — no implementation exists)** |
| 6 | The publication order, the unavailable-before-33 state and the two distinct build failures are pinned | `p18-publication` — 14 state-machine cases (staged-edit inertness, failed-compile preserves the last good publication, no preparer, missing/stale preparation, trust gate, retry replay, derived-cache regeneration, build-failure vs preparation-failure) | **specified (fixture level)** |
| 7 | One valid declared-property behavior manifest is complete and digest-bound | `p18-example` — (`sourceDigest`, `manifestDigest`, `outputDigest`) recomputed; a declared numeric property `speed` drives a quantized `control_move` trace | **verified (fixture level; the output artifact is an opaque stand-in)** |
| 8 | The new checks are not vacuous | `05-negative-control.txt` — six corrupted values (one per p18 group) fail `p18-source-graphs`, `p18-intents`, `p18-runtime-failures`, `p18-publication`, `p18-example`, `p18-container-hash` and `code-registry` (exit 1) | **verified** |
| 9 | Accepted contracts, decisions, packages and the lockfile are untouched; no install, no commit | `04-proposal-check.txt` — `git diff --stat HEAD` empty for `docs/contracts docs/decisions package.json package-lock.json packages tools`; decision 0002 sha256 `2d6aa6c9…` (unchanged since packet 17); lockfile `a71f4c0b…` | **verified** |
| 10 | The repository toolchain stays green | `03-toolchain.txt` — checker exit 0 (27/27), `npm test` 841/841 (66 files), `npm run typecheck` exit 0, `check-deps` OK, `check-boundaries` OK (10 packages / 150 files / 514 specifiers), `npm run build` exit 0 (4 built, 0 skipped) | **verified** |

## Acceptance criteria (m2-packets.md §18)

| Criterion | Status |
|---|---|
| No server-side source evaluation/build hooks | **PASS (proposed + pinned)**: `behaviors.md` §5.4 (closed esbuild option set, bytes-in/bytes-out, no filesystem/network/clock/eval/shell, memo key) and §8.1's mandatory order; `diffs/dependencies.md` D18-5/D18-10 forbid the edges and `runtime → behavior-compiler` |
| stage → validate/compile → prepare digest-bound result → `runCommand` publication is mandatory | **PASS (proposed)**: §8.1/§8.4 with the dedup/lock rules inherited from `content-storage.md` §6; fixtures P01–P14 replay the state machine |
| Source publication changes the revision; a compilation failure cannot replace a good publication | **PASS (proposed)**: §8.6 item 1 + the case fixtures P02/P04/P06/P07/P13 |
| Public publication stays unavailable until packet 33; that is distinct from a later full-snapshot build failure | **PASS (proposed)**: §8.3 (hard `unavailable` branch, no `args.source` write path) vs §8.7 (build failure preserves the last successful artifact); fixtures P03/P08/P11/P14 |
| Pinned modules work identically in play/export | **PASS (proposed)**: §5.3/§8.7 + `diffs/export.md` E18-1/E18-2 (static linking, same pins, `meta.json` evidence) |
| Compiler resource bounds specified separately from runtime trust | **PASS**: §6 (files/file bytes/graph bytes/import depth/imports/diagnostics/timeout/output bytes) vs §2 (trust) vs §10 (runtime intents/logs) |
| Trusted main-thread scripts have **no hard runtime timeout or hostile-code sandbox**, documented prominently | **PASS**: §2.2 (five normative limitations), §2.3 acknowledgment gate, §2.4 check-before-proceeding clause; fixtures F18/F21 and P09 |
| Owner acceptance required; if rejected, request a separate execution-boundary design packet | **recorded**: §2.4/§12.5; the handoff records the pre-approval tag and states that final manual review is pending |
| Failures specified: escape/cycle/size, forbidden bare/Node/network imports, dynamic eval/import, invalid intents, duplicate writers, exception/log floods, incompatible property update, compile timeout/failure | **PASS (proposed + replayed)**: §4.2/§4.3 taxonomy, §9.4 order, §10 caps, fixtures G03–G16/C01–C25/I01–I16/F01–F21/L01–L06/P02/P13 |
| No filesystem watcher implicitly changes a running snapshot; staged edits are inert | **PASS (proposed)**: §8.6 items 2–3 + fixture P01 |
| One tiny example behavior with a declared numeric property | **PASS (fixture level)**: `behaviors/compiled-example.json` (execution itself arrives in packets 33–35) |
| Observable failure outcomes | **PASS**: `behaviors.md` §14 table + `diffs/project-model.md` P18-A4 code rows |

## Not established by this packet (honest limits)

- No compiler, runtime host, command, bundle or UI exists; every packet-18 claim
  above is contract text plus replayed fixtures. No timing, byte count, browser or
  network measurement is claimed.
- No script was executed; the stand-in output artifact is labelled as such and is
  not a compiler product (`behaviors.md` §5.4/§8.4, `verification.md` §4b).
- The trust boundary is a **pre-approval pending final manual review**; the
  no-timeout/no-sandbox limitations are stated, not mitigated.
- `behavior_build_failed` and the `preparation_missing` reason are specified, not
  observed (packets 33/36 implement them).
- Worker/process isolation, hard preemption and hostile-code containment are out
  of scope by design; a separate design packet is the recorded path.
