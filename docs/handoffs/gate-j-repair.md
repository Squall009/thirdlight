# Gate J bounded close-out

2026-09-19 · docs/evidence-only · no commit, no product/contract/decision change.

**P2-1 applied** — UNVERIFIED list = the 16-row union A02, A03, A04, A05, A07,
A08, A11, A12, A13, A15, A16, A17, A18, A19, A20, A21, identical in
`m2-report.md` §2/§4, `handoffs/37.md` and STATUS rows 37/J; A03 (browser
images), A04 (UI error display) and A16 (UI evidence) marked, each pointing at
its §8 procedure.
**P2-2 applied** — `journey/run.mjs` now performs two genuinely separate exports
into distinct disposable roots (`exports`, `exports-2`; backend restarted with
the second `THIRDLIGHT_EXPORT_ROOT`, stale claim explicitly taken over) and
hashes both trees; re-run.
**P3-1 applied** — A20 asserts each stop's HTTP 200 `{ok:true}` plus the
owner-acked `play.stopped`.
**P3-2 applied** — `noBrowser` renamed to the unknown-play probe; the real
no-browser negative cited to `packages/backend/src/play.test.ts` +
`packages/mcp-adapter/src/mcp.e2e.test.ts`.
**P3-3 applied** — 12 security tests; 27/27/0 cited to
`evidence-m2/26/raw/ownership-counters.txt`; `no-png.txt` regenerated.

**Files**: `acceptance/m2-report.md` (v1.1), `handoffs/37.md`, `STATUS.md`
(37/J), `evidence-m2/37/journey/run.mjs`, regenerated
`journey/*` (results/transcript/09-export/06-play), `judgement/no-png.txt`,
`manifest.md`.

**Commands + actual results**

- Journey re-run: **18/18 PASS, exit 0**, root `/tmp/tl37-journey-Nf4j3V`.
  - A22: `exportRootsDistinct=true sameFileSet=true
    differing=manifest.json,meta.json timestampCarriersOnly=true
    nonTimestampBytesIdentical=true buildIdEqual=false
    rederivedBuildIdMatchesFirst=true`.
  - A20: `cycles=5 stopStatuses=200/200/200/200/200/200
    stopResponsesOk=true ownerStoppedEvents=6 stopUnconfirmed=0
    allStopsConfirmedRequestReason=true`.
- `npm test` 135 files/1701 passed, exit 0; `typecheck` exit 0; `check-deps`
  exit 0; `check-boundaries` OK 15/283/1068/0; `check-fixtures.mjs` 34/34.
- `find docs/acceptance/evidence-m2 -iname '*.png'` → 0 (other images 0); the
  37 evidence tree is byte-unchanged by `npm test`.
- `git diff --stat 5b746ee -- docs/contracts docs/decisions packages` unchanged:
  83 files, +15396/−1473, diff sha256 `dc47f355…`.

**Not applied**: none.
