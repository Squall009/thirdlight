# Decision 0003 — M3 sample game (Beacon Reach)

Status: **PROMOTED — accepted by the Gate K architectural review; owner review
pending.** Created by packet 38 (2026-09-19) under the owner's M3 execution
authorization. Sections are added by the packets that own them, exactly as
decision 0002 was built. No M2 pre-approval carries over. The Gate K review
(`docs/handoffs/gate-k.md`, 2026-09-19) adjudicated the pack row by row and the
Gate K bounded repair (`docs/handoffs/gate-k-repair.md`, 2026-09-19) applied
FU-1…FU-7 to the proposal text; the docs-only promotion
(`docs/handoffs/m3-promotion.md`, 2026-09-19) then applied the
accepted/repaired rows into `docs/contracts/**` and the two new contract homes.

**Honest status wording.** The accepted text was accepted by the Gate K
architectural review — a **session review, not owner approval and not an
independent human review** — under the owner's M3 execution authorization;
**final manual review is pending.** No production code, dependency, install or
lockfile change is part of that promotion.

| § | Topic | Drafting packet | Status |
|---|-------|-----------------|--------|
| 1 | M3 verification environment and browser topology | 38 | **promoted on the Gate K review verdict; owner review pending** (the browser/hardware UNVERIFIED labels below stand) |
| 2 | Game data, storage, migration and authoring | 39 | **promoted on the Gate K review verdict; owner review pending** |
| 3 | Game flow, triggers, respawn and camera | 40 | **promoted on the Gate K review verdict; owner review pending** |
| 4 | Rendering, animation and audio | 41 | **promoted on the Gate K review verdict; owner review pending** |
| 5 | Host, controls, delivery and dependencies | 42 | **promoted on the Gate K review verdict; owner review pending** |

## Promotion record (2026-09-19, docs-only)

Recorded by the promotion step; normative text lives in `docs/contracts/**`.
No production code, package, dependency, install, commit or service restart was
part of this step.

- **Applied rows.** Every row of `docs/planning/m3-contracts/contract-diffs.md`
  §2 that Gate K accepted or accepted-with-bounded-repair was applied to its
  exact destination section: **109 rows** (97 verdicts left `open` — the 96
  accepted rows plus the repair-authored R40-17 — and 12 rows repaired as
  `repaired (FU-…/K-…)`). The **110th row, PM13, stays rejected** (superseded by
  PM41-1) and was **not** applied; the §18.1 rule-3 exception is PM41-1's text.
- **Contract files.** `docs/contracts/{project-model,commands,workspace,runtime,
  sessions,export,dependencies}.md` were edited in the pack's §6 promotion
  order, and the two new accepted homes **`docs/contracts/gameplay.md`** and
  **`docs/contracts/presentation.md`** were created from the promoted proposal
  text (PROPOSED status lines dropped, accepted headers with the status wording
  above). Superseded accepted text was replaced, not extended additively (the
  M2/GE-2 lesson): workspace §4.5's threshold (`≥3`→`≥4`), runtime §12.1's
  `SimulationPhase`/`ModuleConfig`, runtime §12.4's camera row for M3 sets,
  runtime §3.1's C35-5 deferral blockquote, sessions §17.4's one CSP line,
  sessions §17.1.1's `manifestVersion`/`assets` rows, project-model §6/§8.1's
  version rows, and the PM43-* obsolete M1/M2 non-goal sentences.
- **C38-1 and C38-2 defect repairs (packet 38 findings).** `sessions.md` §17.4's
  preview CSP now reads `script-src 'self' 'wasm-unsafe-eval'` (one-token diff;
  WebAssembly compilation only, never `eval`), and §13.1 requires
  `allow="gamepad"` on **every** play `<iframe>` (preview wrapper and locator
  shell) with the measured `SecurityError` evidence recorded. The standalone
  export states the same token (`export.md` §3).
- **K-3 coordinator adjudication — flagged for owner confirmation.** The
  `platformer-game` module-spec export name was resolved by the coordinator to
  `platformerGameSessionSpec` + `platformerGameCameraSpec` (the packet-42
  fixture's reading; `@thirdlight/platformer` already exports `platformerSpec`,
  so a near-identical `platformerGameSpec` would be ambiguous in the shared
  `game-host` composition). This is a bounded coordinator decision recorded as
  such, **not an owner acceptance**: `gameplay.md` §11, `delivery.md` §3.4, the
  D42-2 row and `fixtures/m3/delivery/deps/dependency-rows.json` move together
  if the owner reverses it.
- **Rejected row.** **PM13** (the reserved §18.1 rule-3 slot) has no text and
  stays rejected; the machine check
  `fixtures/m3/audit/tools/check-promotion.mjs` asserts its reserved-slot
  wording is absent while PM41-1's version-local exception is present.
- **Machine check.** `fixtures/m3/audit/tools/check-promotion.mjs` asserts one
  marker per accepted row in its destination, PM13's absence, the two new homes
  and their registration, the `manifest 1 + scene 3 + storage 3` agreement
  across project-model/workspace/runtime/gameplay, and the CSP token; its
  `--corrupt-control` removes accepted text from a copy and requires a non-zero
  exit (all four removals detected).
- **Gate K adjudication record.** Gate K adjudicated every proposed diff row in
  [`../planning/m3-contracts/contract-diffs.md`](../planning/m3-contracts/contract-diffs.md)
  (105 section-diff rows incl. R40-17 + 3 packet-43 reconciliation rows + 2
  new-contract rows = **110 inventory rows**); the bounded repair recorded 97
  rows `open`, 13 `repaired`/`rejected` (that file §8). Only the Gate K reviewer
  wrote the verdicts. Prompting this promotion changes **no** verdict.
- **Owner confirmation still owed.** (a) the K-3 rename above; (b) the final
  owner manual review of the promoted contracts; (c) every browser/hardware
  acceptance row already labelled UNVERIFIED in §1 and
  `docs/acceptance/m3-*.md` (physical gamepad, audible output, hardware GPU,
  desktop walkthrough) remains UNVERIFIED — promotion does not verify them.


## 1. Verification environment and browser topology

Recorded from executed probes (raw evidence `docs/acceptance/evidence-m3/38/`),
not from documentation.

- **Authoring/browser origin topology.** Authoring origin `http://127.0.0.1:<port>`
  (the backend's editor origin, loopback ⇒ secure context); preview origin a
  **separate** loopback origin; standalone export served from an independent
  static server under a non-root path. `http://127.0.0.1` is a secure context, so
  the Gamepad API and `crypto.subtle` are available without TLS — but a real
  physical gamepad is still required to observe input.
- **Renderer.** Desktop WebGL 2 baseline; in this container only
  **ANGLE/SwiftShader software rasterisation** is available. Every visual claim
  made here is labelled software rasteriser. A hardware-GPU claim requires the
  owner's desktop and stays UNVERIFIED otherwise.
- **Container browser.** Chrome for Testing 151.0.7922.34, `headless=new`, driven
  over CDP by the repository's own pinned `ws`. No browser or system package was
  installed: the binary and an extracted library tree already existed locally, and
  two absent avahi SONAMEs are satisfied by locally compiled no-op stubs used
  only so Chrome's `libcups` dependency resolves (printing is never exercised).
- **Audio.** `AudioContext` is present and PCM decode works; the context reaches
  `running` after a real gesture and the sample graph produces the expected
  amplitude. There is **no audio device**, so audibility is UNVERIFIED in this
  container and requires owner observation.
- **Gamepad.** API present, zero devices; inside a frame without
  `allow="gamepad"` the API throws a permissions-policy `SecurityError`.
  Physical-controller claims are UNVERIFIED here.
- **Screenshots.** The composited page screenshot carries DOM text but not WebGL
  canvas content under SwiftShader; canvas evidence comes from an in-page
  `toDataURL()` read. Acceptance therefore keeps two separate evidence classes:
  page screenshot (HUD/DOM) and canvas PNG (render).
- **Known accepted-contract defect found by this packet.** The preview-origin CSP
  in `sessions.md` §17.4 lacks `'wasm-unsafe-eval'`, which makes the pinned
  `rapier2d-compat` WASM initialization impossible in a real browser. Proposed
  one-token diff and the isolation evidence are recorded in
  `planning/m3-contracts/baseline.md` §2 and owned by packet 42. No contract
  file was edited before Gate K; the docs-only promotion applied the C38-1/S42-8
  one-token fix on 2026-09-19 (promotion record above).

## Packet 43 — integrated proposal map for §§2–5 (pre-promotion record)

Packet 43 did **not** write decision sections 2–5: they were drafted by packets
39–42. This table records, for Gate K, which proposal sections already existed
and what each committed this decision file to. It is retained as the
**pre-promotion** record: the statuses below were written at packet 43 and the
docs-only promotion of 2026-09-19 (record above) has since applied the accepted
rows, so no M2 pre-approval carries over and no status here overrides the
promotion record.

| § | Topic (drafting packet) | Proposed decision content | Destination contracts proposed by the same packets | Status |
|---|---|---|---|---|
| 2 | Game data, storage, migration and authoring (39) | scene `schemaVersion` 3 / envelope `storageVersion` 3 and the `manifest 1 + scene 3 + storage 3` row; the v3 components and `content.game`; reference/deletion rules; the v2→v3 copy-migration identity/reset policy; the create/edit/remove command surface and the three PR-1 values' creation paths | `project-model` §§3/6/8/10/12/13/14/17/18/19/20 + new §23; `workspace` §§3/4.2/4.5/11/13.9/14/15 + new §16; `commands` §§2/3.1/4/5.3/5.4/8.x/9.1/12 | **promoted on the Gate K review verdict; owner review pending** (39's proposal, `handoffs/39.md`) |
| 3 | Game flow, triggers, respawn and camera (40) | the M3 run state machine, phase order, swept zone predicate, runtime-owned reset transaction and committed read-only `GameView`; camera ownership and math | new `gameplay` contract; `runtime` §§1/2/3.2/4/5/6/8/9/11/12.x/13/14.5 + new §15 | **promoted on the Gate K review verdict; owner review pending** (40's proposal, `handoffs/40.md`) |
| 4 | Rendering, animation and audio (41) | lighting/shadow profile and degradation, copied primitive presets, rigid animation roles with atomic reimport, the §18.1 rule-3 exception, bounded PCM-WAV inspection/publication and the injected browser audio owner, checkpoint activation appearance | new `presentation` contract; `project-model` §18.1/§18.4/§18.5/§18.6/§18.7/§18.9.3/§23.9; `runtime` §§2/9/12.3/13; `commands` §3.1.1/§5.4/§8.5.1 | **promoted on the Gate K review verdict; owner review pending** (41's proposal, `handoffs/41.md`) |
| 5 | Host, controls, delivery and dependencies (42) | manifest `manifestVersion` 1→2 with resolved settings/game/media identity, the C35-5 closure, one shared `createGameHost` composition, the C38-1 CSP token and C38-2 `allow="gamepad"`, the bounded control/observe relay and the static closure; the two new dependency units | `sessions` §§7/10.5/11.5/13/15/17 + new §20; `export` §§2/3/5.1/5.2/5.4.1/5.5/6/7; `dependencies` §§2/3/4.1/4.2/4.3/5/9; `runtime` §3.1/§12.5 | **promoted on the Gate K review verdict; owner review pending** (42's proposal, `handoffs/42.md`) |

Gate K adjudicated every proposed diff row (110 inventory rows) and the
docs-only promotion has now applied the 109 promotable rows (PM13 alone stays
rejected). The §1–§5 statuses above are therefore
**promoted on the Gate K review verdict; owner review pending** — accepted by the
Gate K architectural review (a session review, not owner approval and not an
independent human review) under the owner's M3 execution authorization. The
Packet 43 table below is retained as the **pre-promotion** proposal map: its
per-row "not started" strings record the state at packet 43 and are superseded
by the promotion record above.
