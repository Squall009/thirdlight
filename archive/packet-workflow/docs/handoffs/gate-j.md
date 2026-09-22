# Gate J review — packet 37 and integrated M2 acceptance

Fresh session, 2026-09-19. Reviewer: this session (not the packet-37 author).
**This record is the Gate J verdict only; it is not owner or independent
approval.** No code, contract, decision, fixture, report or evidence file was
modified by this review; the only write is `docs/STATUS.md` row J.

## 1. Scope and method

Packet **37** ("Integrated M2 acceptance and bounded deployment documentation")
and the integrated M2 acceptance claim: `docs/planning/m2-acceptance.md`
A01–A24, §3 journey, U-1…U-5. Method per `docs/planning/m2-packets.md` "Gate
review prompt (E–J)": reviewed from the tree, the accepted contracts and raw
evidence, re-ran what is runnable in this container, and treated handoff 37 as
a claim to test, not proof. Scoped diff re-checked: packet 37 is docs-only
(`acceptance/m2-report.md`, `evidence-m2/37/**` 52 files, `handoffs/37.md` new;
`acceptance/deployment.md` + `STATUS.md` row 37 modified). No `packages/**`,
`fixtures/**`, `tests/**`, `tools/**`, contract, decision, `package.json` or
lockfile file has an mtime after the packet-37 run (all ≤ 10:52 vs 12:44–12:47);
`docs/contracts` diff is still exactly the Gate I re-review state (7 files,
+5657/−161) and `docs/decisions` diff is empty.

## 2. Executed vs reported evidence

**Executed by this review (raw results retained):**

1. Repo toolchain (`/tmp/gatej/toolchain.log`): `npm test` **135 files / 1701
   passed**, exit 0; `npm run typecheck` exit 0 (15 packages, 30 tsc
   invocations across typecheck+build); `npm run check-deps` OK;
   `check-boundaries` OK **15 packages / 283 files / 1068 specifiers / 0
   violations**; `npm run build` **4 built, 0 skipped**; fixture checker
   **34/34**; every command exit 0. Evidence tree byte-hashes and `git status`
   unchanged by the run.
2. Disposable clean install (`/tmp/gatej/clean-install.log`, tree copied to
   `/tmp/gatej/replay`; repo lockfile/`node_modules` untouched): `npm ci`
   **added 167 packages**, then the full suite **135/1701**, typecheck,
   check-deps, check-boundaries, build (**4 built/0 skipped**) and fixtures
   **34/34**, all exit 0. The copy's freshly built bundles are **byte-identical
   to the repo's deployed artifacts** (`dist/backend/backend.mjs`
   `b3cf2f5a…c808c`, `dist/mcp-adapter/mcp.mjs` `53f30550…1d7d`, `editor/main.js`
   `bfce6f2f…eaf9`, `preview/preview.js` `88c1d6cd…879b`) — I hashed both myself;
   they match the committed `suites/07-dist-hashes.txt`.
3. **Independent journey re-run** (`/tmp/gatej/journey.log`, run in the /tmp
   copy so no repo evidence was overwritten; driver unmodified, so
   `REPO` = the copy): **18/18 PASS, exit 0**, root `/tmp/tl37-journey-LskojJ`.
   Includes A01 migration-copy (source byte-identical, destination byte-equal to
   the accepted fixture), M1 v1 edit + unknown-`storageVersion` refusal with the
   file unchanged, import/reimport/undo/redo, prefab + override, MCP typed edit
   + `revision_conflict`, behavior publish + `behavior_import_forbidden`,
   Play pinning, delivery-security negatives, MCP relay steps 100–102,
   `SIGKILL` → `stale_ownership` → takeover → lost-ack replay
   `duplicated:true`, tamper/missing/cache/backup restore, export + failure
   isolation + backends-stopped static serving, pins.
4. **Export claim re-derived independently**: my own fresh run of
   `tests/integration/m2-export` (9/9, exit 0) with my own
   `TL_EVIDENCE_DIR` produced `failure-injection.json` **byte-identical** to the
   committed packet-36 artifact and `trace-diff.json` with **120 steps,
   max |Δ| = 0**; `double-export-diff.json` shows only `meta.json` differing
   (`sameCaptureSecond: true`, equal `buildId`, `rederivedBuildIdMatchesFirst:
   true`).
5. **A15 claim re-derived independently**: re-ran the production
   `composeExportRuntime` measurement into my own directory; output is
   **byte-identical** to `evidence-m2/34/effective-input.json`
   (`xSlow = -0.499564501689747`, `xFast = 0.7639840019401163`, `delta =
   1.2635485036298633`).
6. Honesty checks: `find docs/acceptance/evidence-m2 -iname '*.png'` → **0**
   (also 0 jpg/webp/gif/bmp/webm/mp4); no credential-like string in
   evidence/handoffs (only the documented disposable `tl37-*` test tokens in
   the replay driver); no unredacted play-content capability; CPU numbers are
   labelled container/directional (BR-2) in `evidence-m2/32/06-cpu.json` and
   `m2-report.md` §6.

**Reported only (not re-executed here; their own gate reviews re-derived
them, and nothing in packet 37 changed them):** packets 14–36 raw evidence; the
browser/GPU/keyboard/gamepad rows; the packet-14 desktop physics evidence.

## 3. A01–A24 spot-check (8+ classes)

| Row / class | Claimed | Cited evidence | My verification | Agree |
|---|---|---|---|---|
| A01 migration-copy | PASS | `journey/01-migration.json`, `02-m1-v1.json` | Re-ran journey; fixture digests re-hashed independently (`73c4cd1f…`, `475e6318…`); source bytes identical; refusal left file unchanged | yes |
| A03 reimport/undo | PASS | `journey/03-import-reimport.json` | Re-ran; v1/v2 digests equal the committed `tiny-v1/v2.glb` SHA-256; IDs/transforms stable; undo→v1, redo→v2 | yes (but browser half unmarked, see P2-1) |
| A09/A10 durability/crash | PASS | `journey/07-crash-takeover.json`, `08-durability.json` | **Re-derived**: real `SIGKILL` → structured `stale_ownership` (holder pid = killed pid) → takeover 200 → replay of the same `requestId` `duplicated:true`, revision 26, entity durable; tamper/missing detected, derived cache recoverable, backup restore → fresh Play 200 | yes |
| A15/A16 behavior build/execution | PASS | `journey/05-behavior.json`, `evidence-m2/34/effective-input.json` | **Re-derived** the production property→`x` measurement byte-identically; hostile import refused `behavior_import_forbidden`; old publication retained; trust text states no timeout/no sandbox | yes |
| A17 play-pinning | PASS | `journey/06-play.json`, `suites/10-m2-play.txt` | Re-ran; manifest bytes byte-identical across a real scene change; fresh Play adopts a new `buildId`/revision; source-publish-during-play covered by m2-play | yes |
| A18 security/negative | PASS | `journey/06-play.json`, `suites/10-m2-content.txt` | Re-ran; traversal 400, undeclared 400, foreign 404, listing 400, capability redacted; 12 real security tests (report says "11", see P3-3) | yes |
| A22/A23 export | PASS | `journey/09-export.json`, `suites/10-m2-export.txt`, `evidence-m2/36/artifacts/**` | **Re-derived**: my own 9/9 m2-export run — only timestamp carrier differs, buildId re-derives, trace max\|Δ\| = 0, failure-injection byte-identical; journey re-run served the export with backends stopped, `model/gltf-binary`, 0 external requests | yes |
| A24 clean-install | PASS | `clean-install/**`, `suites/**` | **Re-performed** a fresh `npm ci` copy: 167 packages, full suite + all tools + build + fixtures green | yes |
| A12 physics/course | PASS (Node) | `tests/m2-controller`, `evidence-m2/32/03b-measured-table.txt` | Suite counts match (controller 35, physics 61); measured table present; browser course unverified as marked | yes |

## 4. Findings (prioritized; minimal repair scope)

**No P1 / no blocker.** Every P2/P3 below is docs/evidence-only; each affected
underlying claim was independently re-derived by execution above.

- **P2-1 (GJ-F1) — the UNVERIFIED row list is not complete or consistent.**
  `m2-acceptance.md` A03 requires "browser images" and A16 requires "UI
  evidence", but `m2-report.md` §2 marks neither (A03 reads plain PASS; A16
  reads PASS (process+Node)); A04 is marked UNVERIFIED inline in §2 but omitted
  from §4 U-1's "every … row" list; §4 lists A03 (14 rows) while handoff 37 and
  STATUS row 37 list 13 rows without A03/A04. Minimal repair (docs-only, one
  pass): add the A03 browser-visual, A04 UI and A16 UI caveats to §2, make §4
  U-1's list the union (16 rows), and mirror it in handoff 37 and STATUS. No
  fabricated claim exists; the owner checklist already covers the procedures
  (`m2-assets`, `m2-behaviors`).
- **P2-2 (GJ-F2) — the journey's A22 reproducibility check is vacuous.** In
  `evidence-m2/37/journey/run.mjs` (~lines 895–925) both exports return the same
  deterministic `outputDir`, and the before/after trees are hashed only *after*
  both writes, so `differing=[]` / `fileSetsEqual=true` cannot fail; the report's
  "same-second real exports differed in nothing at all" leans on this. The claim
  itself is sound — my fresh `tests/integration/m2-export` run compares
  before/after on the same tree and re-derives the `buildId`. Minimal repair:
  hash the tree between the two exports in the driver and re-run, or drop the
  journey A22 detail in favour of `suites/10-m2-export.txt`.
- **P3-1 — journey A20 detail overstates the assertion:** "each stopped
  cleanly" is not checked (the stop HTTP status is ignored; only `cycles===5` is
  asserted). Stop-cleanliness is covered by `tests/integration/m2-play`.
- **P3-2 — driver naming:** the A19 `noBrowser` probe is actually the
  unknown-play case; the real no-browser `session_unavailable` negative lives in
  `packages/backend/src/play.test.ts` and `packages/mcp-adapter/src/mcp.e2e.test.ts`
  (both executed by `npm test`). No false report claim.
- **P3-3 — citation nits:** `10-m2-content` security tests are 12, not the
  report's "11"; the A20 "27/27/0" ownership figure is from
  `evidence-m2/26/raw/ownership-counters.txt`, not the cited package suite;
  `judgement/no-png.txt` embeds an earlier run's results (`tl37-journey-zX0Dym`)
  rather than the final one.

## 5. Blockers vs bounded follow-ups

- **Blockers: none.** Ownership/public edges (packet 37 added no product API;
  no source/dependency change), revision/retry ordering, immutable-content
  durability, resource disposal, script trust, input/physics behaviour and
  export independence were all re-checked and are consistent with the accepted
  contracts. No contract change was made and no Gate E portion is reopened; no
  contract-change request remains undisposed (packets 33–36 all adjudicated by
  Gate I; packet 37 raises none).
- **Bounded follow-ups:** P2-1, P2-2, P3-1…P3-3 (docs/evidence-only; do not
  change any accepted behaviour or threshold).

## 6. Complete UNVERIFIED list (after P2-1 repair)

Browser/GPU/pixel/interaction, pending the owner walkthrough:
**A02, A03, A04, A05, A07, A08, A11, A12, A13, A15, A16, A17, A18, A19, A20,
A21** (16 rows). The report currently enumerates 14 (§4) / 13 (§2, handoff 37,
STATUS). Also unverified/owner-open: the PROVISIONAL physics selection and the
packet-14 desktop CPU evidence (BR-2/BR-3); the U-3 production process-marker
naming; browser WASM-init/CSP/static packaging. Real rendered PNG: unverified
(no placeholder substituted).

## 7. U-1…U-5 disposition

- **U-1 (browser verification):** explicit — partially resolved, carried to the
  owner. Consistent with the rows, subject to P2-1's completeness gap.
- **U-2 (transient export build fault):** explicit — not reproduced; my clean
  install + journey add 5 more cold builds (0 failures) to the 16 recorded.
- **U-3 (process marker):** explicit — unchanged/documented; my journey
  reproduced the stale-ownership + explicit-takeover behaviour.
- **U-4 (M1 contract-change requests):** **closed for real.** Decision 0002
  §6.8 accepts both; `sessions.md` §13.7 (`engineRoot`/`THIRDLIGHT_ENGINE_ROOT`)
  and `export.md` §5.4.1 (reference entry, counts unchanged) carry the text; the
  backend fails closed when `engineRoot` is absent. m1-report §6's "remain open"
  is the M1-era state, superseded by that accepted disposition — no residual
  item.
- **U-5 (playwright pin):** explicit — withdrawn/moot; no playwright package is
  installed (only vitest's optional peer metadata in the lockfile).

## 8. Verdict

**Accept with bounded follow-ups (P2-1, P2-2, P3-1…P3-3). No blocker.**

Milestone acceptance is recorded as **(a): accepted for the executed
process/filesystem/HTTP/WS/SDK/Node scope, with the 16 browser/hardware rows
above UNVERIFIED and pending the owner walkthrough.** Per `m2-acceptance.md` §4
and the owner's 2026-09-18 authorization, M2 milestone completion stays formally
pending until that walkthrough is recorded; the report already states this and
does not claim completed milestone acceptance. The physics selection remains
PROVISIONAL. This verdict is this review record only — no separate reviewer
approved it.

## 9. Exact next step

1. Owner runs `m2-report.md` §8 items 1–8 on a desktop (WebGL 2 browser +
   physical keyboard and gamepad, recorded secure-context status, device
   mapping, console/network captures, real screenshots) and records the results
   under `docs/acceptance/evidence-m2/**`.
2. Apply the P2/P3 follow-ups as a bounded docs/evidence-only close-out
   (`m2-report.md` v1.1, `handoff 37`, `STATUS` row 37/row J) and mark the
   remaining rows PASS/UNVERIFIED from the recorded walkthrough.
3. **Stop.** M3 is a separately requested planning task in
   `implementation-prompts.md`, only on explicit owner request.
