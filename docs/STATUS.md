# Thirdlight — Status (packets 00–13, gates A–D)

Updated: 2026-09-18 (Gate B accepted 2026-09-18 with bounded follow-ups
BF-1…BF-5 — docs/fixture consistency only, no source — see
docs/handoffs/gate-b.md; apply via a repair step before packet 08.
Gate A record below: accepted 2026-09-17 with bounded follow-ups
F1–F4 — see Notes; **F1–F4 applied 2026-09-17** (commit `b6422e4`) —
repair recorded in the handoff 03 "Gate A follow-up repair" section;
React ruling and pre-review pass recorded in handoff 03).

Gate discipline (docs/planning/implementation-prompts.md): at each gate, stop
dependent implementation until review findings are resolved. A contract change
during later work reopens the relevant review gate. Unrun packets stay
**pending**; a completed handoff never auto-starts the next packet.

## Review gates

| Gate | Covers | Status |
|------|--------|--------|
| A | 00–03 | **accepted 2026-09-17** — architectural review: accept with bounded follow-ups (F1–F4, Notes); apply via the "Repair prompt" before packet 04 — **F1–F4 applied 2026-09-17** (handoff 03 "Gate A follow-up repair") |
| B | 04–07 | **accepted 2026-09-18** — architectural review (docs/handoffs/gate-b.md): accept with bounded follow-ups BF-1…BF-5 (consistency fixes: docs + fixture regeneration only, no source) — apply via a separate repair step **before packet 08** with the small docs re-checks noted per item; no blocking findings |
| C | 08–12 | pending — prerequisite: Gate B accepted (for 08 onward) |
| D | 13 | pending — prerequisite: Gate C accepted |

## Packets

| ID | Packet | Gate | Prerequisite | Status | Handoff |
|----|--------|------|--------------|--------|---------|
| 00 | Repository intake and environment | A | — | done (2026-09-16); Gate A accepted 2026-09-17 | docs/handoffs/00.md |
| 01 | Project data contract | A | 00 | done; review corrections v0.2 (2026-09-17); Gate A accepted 2026-09-17 | docs/handoffs/01.md |
| 02 | Commands, persistence, and conflict contract | A | 01 | done; contracts + fixtures v0.1 (2026-09-17); Gate A accepted 2026-09-17 (follow-up F4 touches commands.md/workspace.md) | docs/handoffs/02.md |
| 03 | Runtime, session, export, and dependency contracts | A | 02 | done; contracts v0.1 + M1 acceptance plan (2026-09-17); Gate A pre-review pass 2026-09-17; Gate A accepted 2026-09-17 (follow-ups F1–F3 touch this packet's documents) | docs/handoffs/03.md |
| 04 | Minimal toolchain and dependency checks | B | Gate A accepted | re-repair review 2026-09-17 (docs/handoffs/04-rereview2.md): **accepted** — packet 04 complete, 141/141 tests, no new P1 findings (2 non-gating P2 observations recorded); **Gate B accepted 2026-09-18** (gate-b.md; N1/N2 accounted: N1 limitation line + N2 carried forward, both in the BF set) | docs/handoffs/04.md |
| 05 | Project model implementation | B | 04 | implemented 2026-09-17; review 2026-09-17 (docs/handoffs/05-review.md): **accepted** — 234/234 (real tree + clean npm ci copy), 113 independent probes pass, no P1 findings (4 non-gating P2 observations recorded); **Gate B accepted 2026-09-18** (gate-b.md; N1 → BF-4, N2/N3 carried forward, N4 → BF-5) | docs/handoffs/05.md |
| 06 | Pure commands and history | B | 05 | review 2026-09-17 (docs/handoffs/06-review.md): changes still required — 1 P1 (pipeline order vs §6.1 step 4), 3 non-gating P2s; repair (round 1) 2026-09-17 `b15786a`; **re-review 2026-09-18 (docs/handoffs/06-rereview.md): accepted** — F1 closed (independent 21-probe round incl. new ordering probes; 386/386 real tree + clean `npm ci` copy; fixtures 71/71); F2–F4 carried forward as recorded P2s (no code); **Gate B accepted 2026-09-18** (gate-b.md; hint-drift contract-change request → BF-1, F2–F4 carried forward) | docs/handoffs/06.md |
| 07 | Durable workspace service | B | 06 | **Follow-up commit review 2026-09-18: changes required before packet 08** — 17 findings (including ownership/data-preservation failures and an ownership-contract blocker); see docs/reviews/2026-09-18-commits.md and docs/handoffs/2026-09-18-commit-review.md. Reopen packet 07/Gate B for repair/re-review; prior acceptance below is historical. implemented 2026-09-18 (`be58767`, handoff `11ae4d3`, test fix `afd1467`): `packages/workspace` on the real FS (full §6.1 pipeline, ownership/takeover/release, durable retry records, atomic W + verification, recovery snapshots, scan/§8.3 completion, external-change pause/resolve); 52 new real tests (fixture-pinned scenarios 01–05/08/09, fault injection, 3 real-SIGKILL crash tests); **review 2026-09-18 (docs/handoffs/07-review.md): accepted** — 438/438 real tree + clean `npm ci` copy, 92 independent probes (exit 0), no P1 findings (5 non-gating P2s recorded); **Gate B accepted 2026-09-18** (gate-b.md; F1 → BF-2/BF-5, F2 → BF-3, F3/F5 carried forward, F4 → BF-5; requests (1)/(7) → BF-2/BF-1) — 2026-09-18 repair campaign in progress: approved contract diff applied to workspace.md (`dabfcff`), source repairs pending per docs/handoffs/07-repair-2026-09-18.md — repair group A1 (R10/R17) applied `7b4645a`; repair group A2 (R11/R12/R13) applied `aa03976`; repair groups B1 (R14) e9ebe6e + B2 (R15) applied `6b04dff`; repair groups B1–B3 (R14/R15/R7) applied (B3 `30d4015`); group C (R1/R2/R6) applied `4f31707`; group D (R3/R16) applied `0550a1d`; group E1 (R9) applied `9f9eff2`; group E2 (R4/R5) applied `6f2e48f`; group E3 (R8 + L1) applied `2f7f1c2` (+ `52f78aa` holder-null residual, spot-check); docs follow-ups (BF) + commands (O1/O2) pending | docs/handoffs/07.md |
| 08 | Runtime and three.js adapter | C | Gate B accepted | pending — prerequisite met (Gate B accepted 2026-09-18); blocked until the BF-1…BF-5 repair step (docs/fixture consistency) is recorded; not started, not auto-cleared | — |
| 09 | Backend API and live session transport | C | 08 | pending | — |
| 10 | Minimal visual editor and isolated play | C | 09 | pending | — |
| 11 | MCP adapter for the external harness | C | 10 | pending | — |
| 12 | Standalone export | C | 11 | pending | — |
| 13 | M1 integrated acceptance and local deployment | D | Gate C accepted | pending | — |

## Notes

- Owner ruling 2026-09-17: **React 19.3.0** (`react`, `react-dom`,
  `@types/react`, `@types/react-dom` — all registry-verified 2026-09-17) is
  the M1 editor UI framework — panels only; three.js viewport/gizmo/picking
  stays imperative and framework-free. Supersedes decision 0001's "no UI
  framework" proposal (recorded as decision 0001 §10). Implementation-prompts
  pack bumped to v0.1.1 with packets 04/10 clarified. No other stack changes;
  nothing installed yet (first install is packet 04).
- Packet 00 open items carried forward: TypeScript line RESOLVED — owner
  confirmed 5.9.3 (decision 0001 §3/§8). The one-time root action for
  `/etc/thirdlight` is withdrawn (data root moved to user home, 2026-09-16).
- Git (owner decision, 2026-09-16): engine repository is under version
  control with a public GitHub remote; game data root stays out of the repo.
- Owner rulings recorded 2026-09-16: no containerization (Docker/Podman)
  — the harness runs inside a Proxmox LXC and deployment is process-level;
  game project data lives in `/home/dadmin/thirdlight/projects/<project-id>/`
  (user home; first ruling had placed it in `/etc/thirdlight`, withdrawn the
  same day to avoid root permissions) — decision 0001 §6 (revised).
- No implementation has started. No dependencies installed. No services
  deployed. Git: initial commit + public remote created 2026-09-16 (owner
  decision; see handoff 00 revision note).
- Packet 01 defined `docs/contracts/project-model.md` (schemaVersion 1:
  manifest + single scene; Transform/box/camera; Y-up right-handed meters,
  2.5D plane XY with depth Z) plus `fixtures/project-model/` with a
  machine-readable `expected.json` index.
- **Gate A review (2026-09-17, architectural review of the M0 contract
  pack, packets 00–03): verdict — accept with bounded follow-ups.**
  Independently re-verified: both fixture verification suites re-run
  (project-model: 20 index entries / 22 JSON parses / 1 intentional syntax
  rejection; commands `--check`: 71 files byte-identical, digests +
  canonical stability; cross-language SHA-256 recomputation; scenario disk
  invariants), all stack pins against the npm registry, handoff-00
  environment facts and commit provenance, and the handoff-03 pre-review
  fixes (one-shot `play.started`, `clientInfo.kind` pin, session code
  mapping, dependencies edge/export table, scan pattern j, demo-math test
  points, project-model §12.1 declarations). Bounded follow-ups (consistency
  fixes, not new scope; apply via the "Repair prompt" **before packet 04** —
  **applied 2026-09-17**; handoff 03 "Gate A follow-up repair" section;
  both fixture verification suites re-run OK):
  - **F1 — export/preview scan vs pinned `three@0.186.0` (verified, larger
    than the handoff-03 risk note):** a default esbuild 0.28.2 bundle of the
    pinned three contains `fetch(` ×3 (two are real fetch calls in three's
    loader code), `http://` ×3, `https://` ×23, `process.` ×27, and
    `XMLHttpRequest` ×3 (inert strings/comments; `node:`, `__dirname`,
    `WebSocket`, `file://` absent). As written, export.md §5.4 patterns
    d/f/h/j and dependencies.md §5 check 4 (packet 10, not only 12) fail on
    the first preview/export build. Repair: a recorded-exception table in
    export.md §5.4 bound to the pinned version/hash, restate §5.3's
    single-fetch rule as "exactly one fetch initiated by engine code
    (bootstrap `./snapshot.json`)", apply the same table in dependencies.md
    §5 check 4, pin the exact esbuild option set for all three bundles
    (verified: default `format` is IIFE even for ESM entries — export.md
    §5.3/§7 must state it), and extend the handoff-03 risk note to patterns
    d/f/j and to packet 10.
  - **F2 — m1-acceptance §2.1 demo-math test points:** stepIndexes 0/120/240/
    360 do not yield the stated exact values under the runtime.md §7.1
    formula (`(stepIndex+1)` offset: x(120)=x0+0.499957, x(240)=x0−0.00654).
    Exact points: 119 (x0+A), 239 (x0), 359 (x0−A), 479 (x0). One-line fix
    in m1-acceptance.md; runtime.md unchanged.
  - **F3 — sessions.md §5.1 attach `workspace` shape:** the clean shape
    `{writePaused:false, pendingChange:null}` contradicts commands.md §5.6's
    clean shape `{writePaused:false}` and the committed scenario fixtures;
    the "exactly the commands.md §5.6 object" claim is false. Align
    sessions.md §5.1 with commands.md §5.6 + fixtures (drop
    `pendingChange: null`).
  - **F4 — `project_unavailable.reason` scope:** the workspace.md §4.3 load
    pipeline can surface project-model codes (`encoding_invalid`,
    `json_parse_error`, `duplicate_key`, `field_type`,
    `manifest_scene_mismatch`) as `reason`; the "(a workspace.md §11 code)"
    parenthetical (commands.md §5.4, sessions.md §11.3) is too narrow —
    one-sentence clarification.
  Later improvements (non-gating): no byte-exact fixtures for session/
  bridge/runtime-snapshot payloads (check map covers; small fixture set may
  be added in packet 09); handoffs 01/02 lack final commit IDs (9d1241a,
  21dd09e); `history_empty` cls `unavailable` with "retry later" guidance
  misfits a non-transient condition (commands.md §5.4/§5.5); charter
  first-release items (snapping, lights/shadows, material presets) have no
  explicit post-M1 milestone assignment — carry into the M2 planning prompt.
  **Evidence limits (docs-only gate):** no implementation exists; the
  acceptance record establishes contract self-consistency (modulo F1–F4),
  fixture self-consistency, stack-pin registry truth, environment facts, and
  the F1 scan measurement (throwaway /tmp install of the pinned
  esbuild/three). Durability under real crash/power loss, `/proc` liveness,
  runtime/browser behavior, and the M1 scenario remain unestablished (as
  honestly recorded in the handoffs). No reviewer approval is claimed beyond
  this record.