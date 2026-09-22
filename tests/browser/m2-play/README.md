# Packet 35 — browser Play verification (packet-37 procedure)

**Status in this container: UNVERIFIED.** There is no browser, no GPU and no
display here. Nothing in this file was executed; the packet-35 evidence records
only what really ran (real backend process, real filesystem, real HTTP/WS on
both origins, real stdio MCP SDK, real esbuild bundle scans). The rendered PNG
claim, the live preview composition and every pixel/WebGL statement are
**UNVERIFIED** and must be performed by the owner on a desktop browser.

## Why this is the packet-37 procedure

Packet 36 (export) and packet 37 (integrated M2 acceptance) own the manual
walkthrough. Packet 35 ships the production composition; the checks below are
the A17/A18/A19/A20 browser halves.

## Build and start (owner desktop)

```sh
cd <repo>
npm run build                     # dist/editor + dist/preview + dist/backend + dist/mcp
THIRDLIGHT_EDITOR_TOKEN=<authoring-token> \
THIRDLIGHT_PREVIEW_ORIGIN=http://127.0.0.1:8502 \
node dist/backend/backend.mjs     # prints {"ready":…} with both bound ports
```

Then open `http://127.0.0.1:8501/` in the desktop browser (the exact origin must
be in `authoringOrigins`), open a project with a pinned GLB + a published
behavior + a `collider`/`controller` character, and press **Play**.

## Checks and what to record

| # | Check | Record |
|---|---|---|
| B1 | The preview iframe loads `/play-content/<contentId>/game.js`; the console shows no CSP violation, no `import()` failure, no 404 | console + network panel |
| B2 | `tl.load.progress` reaches `runtime`; the editor only marks play **presented** after the manifest buildId matched, every declared asset read completed, the physics port initialized and the behavior output linked | devtools WS frames (`play.preview.ready` arrives after the last `tl.load.progress`) |
| B3 | The pinned GLB is visible (mesh + 2 materials) and the behavior's declared `speed` measurably changes the play (set `speed` low vs high, restart the play, compare the character's x after the same number of steps) | two screenshots + the diagnostics relay `stepIndex` |
| B4 | The course traverses: run right, jump, land on the static boxes; the 45° ramp is climbed, the 47° ramp is not; Z stays 0 | screen recording or stepped screenshots |
| B5 | Screenshot: call the MCP `tl_screenshot` tool (or the editor's relay) and save the returned `data:image/png;base64,…` **as a file** — this is the real rendered PNG (A20). Record its SHA-256 and dimensions | `png-<n>.png` + `sha256sum` |
| B6 | Network: filter the preview iframe's requests — only same-origin relative reads of `manifest.json`, the declared asset paths and the behavior outputs; **no** `/api/v1/`, no authoring origin, no cross-origin request. The bundle contains no credential (packet-35 scan already proves the bytes; the panel proves the runtime behaviour) | network panel HAR export |
| B7 | Repeated Play → Stop → Play (≥ 5 cycles): no leaked rAF loops, no stale GLB, no growing GPU memory; the editor shows a fresh `snapshotId`/capability each time and the old locator returns `play_locator_expired` after 15 min (or 404 after restart) | devtools performance/memory snapshots |
| B8 | Physical keyboard + gamepad: A/D/arrows/Space and a standard pad move the character; after an MCP `tl_input_exercise` relay the physical source is re-armed from neutral (a subsequent physical press is a fresh edge, no stuck input) | screen recording |
| B9 | Denied gamepad: block the Gamepad API (or use an insecure origin) — the preview degrades to keyboard-only and reports the structured `input_unavailable` diagnostic, never a crash | console + diagnostics relay |

## Explicitly not claimed here

- no packet-35 run captured a PNG or a pixel;
- no physical keyboard/gamepad was present;
- no tab-resume/hidden-tab behaviour was exercised;
- the preview's own `content.settings` handling is limited to the contract
  defaults (see C35-5 in `docs/handoffs/35.md`).
