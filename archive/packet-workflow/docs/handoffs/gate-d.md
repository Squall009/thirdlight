# Gate D — M1 acceptance evidence review

Round 1 (max 2) · 2026-09-18 · single-session pass.

**Reviewer identity (honest record):** this review was run in a **fresh single
session** — not the implementation lineage (the M1 implementation ran in the
sessions recorded in `docs/orchestration.md`; this session performed only the
owner-observation record commit `934a842` and this review). Worked strictly
from the **committed tree** (`3f5bc50` at review start), the **contract and
planning documents**, and the **raw evidence** (`/tmp/tl-m1/out/` 59 files,
`ws-events.jsonl`, on-disk data root, the 8765-served export tree) — not from
implementation memory. **No external reviewer approval is claimed or implied;
the verdict below is this session's own.**

**Scope (per the RESUME-GATE-D work order):** verify the M1 acceptance
evidence (`docs/acceptance/m1-report.md` v0.2 incl. §1B,
`docs/acceptance/deployment.md`, handoff 13) against the raw outputs, the
committed tree, and the normative `docs/planning/m1-acceptance.md` §1; re-run
the toolchain; confirm hygiene. ≤ 2 repair rounds then stop-and-report.

---

## 1. Fresh probes and results (all performed this round)

### 1.1 Raw-evidence cross-check (report claims vs `/tmp/tl-m1/out/`)

Every major step was re-derived from the raw files (not from the report's
narrative). All match:

| Step | Raw evidence re-checked | Result |
|---|---|---|
| 1 | `s1-createProject.txt` (201 `{ok,created,r0}`) + `s1-disk.txt` (manifest, envelope r0, ownership `lockEpoch 0`) | match |
| 2 | `s2-stub.log` (establish r0 + connId) | match (render UNVERIFIED → §1B-2 transport confirmed post-run) |
| 3 | `s3-createEntity.txt` (r1, `box-0001`, `duplicated:false`) | match |
| 4 | `s4-setTransform.txt` (r2) | match (network-panel assertion UNVERIFIED) |
| 5 | `s5a/b/c` (undo r3, redo r4, fresh-edit r5) + `s5d` (`history {undo:3,redo:0}`) | match |
| 6 | `s6-establish-stale.txt` (503 `stale_ownership` + holder + hint, pre-takeover) · `s6-takeover.txt` (`lockEpoch:1`) · `s6-reopen-attach.txt` (r5) · **envelope md5 re-hashed: `8dd99e4c0a9c26405e8872678026d916` pre AND post** | match (incl. the byte-identical-envelope claim) |
| 7 | `s7-play-start.txt` (`snapshotId demo-m1@r5`) · `ws-events.jsonl`: `play.started` (4 across cycles) carries the full frozen snapshot `{snapshotId, revision:5, scene: 2 entities}` + `startedBy` · `s7-query-during-play.txt` (r5, authored state) | match (render/HUD UNVERIFIED) |
| 8 | `s8b-stop-sequence.txt` (`stop.request` → `stopped.ack` → `play.stopped {reason:"request"}`) | match |
| 9 | `s9-mcp.txt` (real stdio MCP, 7 tools, createEntity r6 `box-0002`) · `ws-events.jsonl`: **both r6 and r7 `mutation.applied` carry `origin {kind:"mcp", clientId:"m1-harness"}`** to the connected session (9 total, revisions 1–8,10 — r9 is the post-S13b discard mutation) | match (hierarchy paint UNVERIFIED) |
| 10 | `s10-stale-edit.txt` (409 `revision_conflict` carrying `currentRevision:7`; re-issue r8) | match |
| 11 | `s11-screenshot.txt` (relay response with `snapshotId demo-m1@r8`, `revision:8`, 1×1 PNG stand-in — honestly labeled synthetic) · `s11-no-browser2.txt` (WS killed ⇒ 503 `session_unavailable`, structured) · `s11-no-browser.txt` (stale psid ⇒ 404 `play_not_found`) | match (real capture UNVERIFIED) |
| 12 | `s12-export1.txt` (records the U-2 first-attempt `__filename` failure) · `s12-static-server.txt` (backend stopped; 4×200 with exact sizes, unknown 404; scan: `fetch("./snapshot.json")`=1, `fetch(`=4, http(s)=26, credentials/origins/`node:`/`/api/v1/`=0) · **file sizes re-measured `wc -c`: 626 / 1859797 / 2015 / 497 — exact** · **reproducibility trees re-diffed: only `meta.json exportedAt` differs** | match |
| 13 | `s13a-release.txt` (`{ok,r8,retryCleared:true}`) · `s13a-reopen2.txt` (new process claims, r8, history `{0,0}`) · `s13b-mutation.txt` (503 `external_change_unresolved`, `externalHash 87ed675e…`, writes paused) · **recovery snapshot re-hashed: sha256 `87ed675ecd0d…` = filename suffix** · `s13b-resolve.txt` (`discard-external` ⇒ `{ok,r8,historyReset:true}`, next mutation r9) | match (incl. the byte-exact-recovery claim) |
| 14 | `s14-reconnect.txt` (re-attach r10, new connId, `attached {revision:10}`) · `s14-commandA.txt`/`s14-retry.txt` (**same requestId `req-12a7925e…`**, `duplicated:true` replay) · **on-disk envelope re-read: `scene.revision: 10`, 3 entities** | match |

### 1.2 Owner real-browser evidence (recorded as `m1-report.md` §1B in `934a842`)

- **B-1 (export, S12):** the owner ran the static tree
  `/home/dadmin/thirdlight/exports/demo-0001@r1` at `http://10.0.10.223:8765/`
  (`python3 -m http.server`, **no backend**) and reported verbatim: *"I see
  the demo box moving back and forth on the x axis."* This round re-verified
  the cross-link freshly: served `js/main.js` sha256 `977a031d…` (1,859,113 B)
  vs the acceptance `demo-m1@r8` bundle sha256 `26e85c0d…` (1,859,797 B) —
  **every differing line is an esbuild section-banner source-path comment**
  (build-cwd artifact: `packages/…` vs `../../home/dadmin/…`); the diff with
  banner comments filtered is **0 lines**. Both `meta.json` record the same
  pinned set. Fresh scan of the 8765 tree (all 4 files): credential markers,
  both origins, `/api/v1/`, `node:`, `mcp`, `file://` = **0 hits**;
  `fetch("./snapshot.json")`=1, `fetch(`=4, http(s)=26 — identical to the
  acceptance run's recorded scan.
- **B-2 (editor, S2/S3/S7/S8):** the owner's browser loaded
  `http://10.0.10.223:8501/`. The backend session log (fetched live before the
  instance was shut down; 7 entries, 22:25:38–22:28:00Z): `registered` → play
  `started` (r1) → `stop_requested` → play stop (`request`) → `command` r2 →
  `command` r3 → `detached`. Establishes, from the real browser: page load,
  WS attach, the full isolated-Play round trip, and two UI-committed edits
  (r1→3, durable). The owner's qualitative scope report is recorded verbatim.
- Residuals (honest): pixel-level items — renderer-backend report,
  console-clean, network-panel zero-traffic assertions, preview HUD, real
  screenshot capture (S11) — remain **UNVERIFIED** (the owner did not
  individually confirm them); U-1 is now *partially* resolved.

### 1.3 Toolchain (fresh re-run, committed tree)

- `npm test`: **66 files / 841 tests passed** (two independent runs, 27.79 s /
  27.99 s — report §4's count is exact)
- `npm run typecheck`: exit 0 (10 packages)
- `check-deps`: all exact — lockfile versions re-verified live: three 0.186.0,
  esbuild 0.28.2, typescript 5.9.3, ws 8.21.3, @modelcontextprotocol/sdk
  1.30.0, react/react-dom 19.3.0, vitest 5.0.1 (Node v22.22.1, npm 9.2.0 —
  both verified live, matching the report)
- `check-boundaries`: OK — 10 packages, 150 files, 514 specifiers
- `npm run build`: **4 built, 0 skipped**, exit 0 (editor, preview, MCP stdio,
  backend deployment bundle)

### 1.4 Hygiene and claim audits

- `git status` clean; no unexpected top-level entries; no temp/debug
  artifacts in the tree.
- **Contracts untouched:** `git diff e9e52d7..HEAD -- docs/contracts/
  packages/ tools/` = empty; the last contract change is from the Gate B
  repair era (`1e9e910`). The report's "No contract was changed" holds.
- The U-2 transient fault is present in the raw evidence (`s12-export1.txt`)
  and honestly bounded; the successful export and reproducibility evidence
  stand independently of it.
- `deployment.md` config table verified against the live backend startup this
  session (the B-2 instance used exactly the documented env shape; the
  `THIRDLIGHT_TOKENS` last-colon split worked for
  `authoring:demo-0001:<token>`).

## 2. Findings

**No P1 findings.**

- **FD-1 (P2, documentation-only):** `docs/planning/m1-acceptance.md` §1
  steps 6 and 7 state the expected re-attach/snapshot revision as `revision:
  4` / `demo-m1@r4`, but step 5 of the **same table** ends at **r5** (undo r3,
  redo r4, fresh edit r5 — the redo-truncation edit is required by
  commands.md §9.1 and was executed). The actual run is self-consistent at
  r5 everywhere (reopen @r5, play snapshot `demo-m1@r5`, S10's
  "pre-step-9 `expectedRevision`" = 5). The normative document's expected
  values are off by one; **the report is correct**. Repair: set steps 6/7 to
  r5 / `demo-m1@r5` in `m1-acceptance.md`. No source, contract, or evidence
  impact.

## 3. Verdict

**ACCEPT — with bounded follow-up FD-1 (documentation-only).**

The M1 acceptance evidence stands as recorded: 14/14 steps PASS at the
protocol/HTTP/WS/process level, every re-derived raw-output claim matches, the
toolchain is green on a fresh run, contracts are untouched, the tree is clean,
and the report's UNVERIFIED marks are honest (with precise manual steps).
The charter §9 M1 evidence clauses are each covered by the recorded evidence,
and one of them — *exported scene runs without backend* — now additionally
has a **real-browser render confirmation** from the owner (§1B-1, verbatim),
with the observed bundle verified code-identical to the acceptance export.
The editor/Play clauses gained real-browser **transport** confirmation
(§1B-2). The remaining pixel/WebGL residuals are unverified, not failed
(U-1, partially resolved).

**Gate D accepted 2026-09-18. M1 is accepted.** Per the gate discipline and
the work order: **stop** — do not automatically start M2. FD-1 is applied via
a separate repair step (documentation-only; no dependent implementation is
gated on it).

**Same-session caveat:** this review is a fresh-session single-pass review of
its own prior-lineage work product (the implementation ran in earlier
sessions; this session did the owner-record + review). Per campaign protocol,
that lineage is recorded here instead of claiming independence from it, and no
external reviewer approval is claimed.