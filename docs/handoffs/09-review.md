# Packet 09 — Independent review pass (round 1 of max 3)

**VERDICT: ACCEPTED** — single-session review pass per the owner's RESUME-2026-09-18
mode. Worked strictly from the committed tree (`795f950` impl + `0778cf9` record),
the contract text (`sessions.md`, `commands.md`, `dependencies.md` §3/§4.1,
`m1-acceptance.md` §2.2), and **fresh independent probes** — not from
implementation memory. No P1 findings. The only deltas found this round were
**review-probe errors on my side** (wrong field names / response-shape
assumptions); the backend matched the contract in every case. Those probe
corrections are recorded below for honesty; no backend source change was
required or made.

## Independent evidence (fresh, this round)

1. **Protocol purity (dependencies.md §4.1 "pure — no I/O, no Node builtins,
   no DOM")** — esbuild-bundled the public entry
   (`packages/protocol/src/index.ts`) and scanned the output (43,159 bytes)
   for 19 forbidden patterns (`require(`, `__dirname`, `node:*` specifiers,
   `process.env`, `Buffer.*`, `WebSocket`, `XMLHttpRequest`, `fetch(`,
   `document.`, `window.`, `globalThis`, `child_process`, `net.create`, …):
   **0 hits**. The only Web globals used are `TextDecoder`/`TextEncoder`
   (strict.ts:39,263) — correct.
2. **Strict pass-1 JSON (sessions.md §1/§6.1/§11.2, project-model §12.3)** —
   10 fresh edge inputs against `parseStrictJsonBytes`, all correct: BOM
   prefix, BOM-only, duplicate keys (top + nested), trailing garbage, trailing
   comma, invalid UTF-8, `NaN`, `Infinity`, empty bytes ⇒ all
   `invalid_request`; a valid strict object ⇒ `OK`.
3. **Live transport lifecycle (16 fresh assertions, real backend + disposable
   workspace)** — all PASS: bad-origin establish ⇒ 403 `bad_origin`; malformed
   `sessionId` ⇒ 400; wrong bearer ⇒ 401; establish ⇒ 200 + 64-hex `wsToken`;
   WS `attached` with `conn-…` + numeric `revision`; **re-attach closes the old
   socket 1000 `detached`** and the new socket attaches; **replayed `wsToken`
   ⇒ close 1008** (single-use); `createEntity` ⇒ 200 `ok`/`duplicated:false` and
   the revision advances exactly once; **duplicate `requestId` ⇒ `duplicated:
   true` + same revision** (no second advance); stale `expectedRevision` ⇒ 409
   `revision_conflict` **carrying `currentRevision`** (commands.md §6.4);
   `queryProject` passthrough ⇒ 200 `ok` + `manifest` (no `requestId` on the
   query); preview template at `/` ⇒ 200 and **contains neither token nor any
   `/api/` string** (no credential/config leakage).
4. **Play relay chain (fresh, self-contained editor stub)** — full chain PASS:
   `POST /play` ⇒ 200 `play-…` + `snapshotId = demo-0001@r<rev>`; the owner
   receives `play.started` with the full frozen `snapshot` (scene + matching
   `snapshotId`); after `play.preview.ready`, `POST …/screenshot` ⇒ the server
   sends `screenshot.request` carrying a `relay-…`, the stub's `screenshot.ack`
   (same `relayId`) is relayed back ⇒ the response carries `ok` +
   `playSessionId` + `snapshotId` + `revision` + `dataUrl` + `width`+`height`
   (a success body has **no** top-level `relayId` — it rides on the request and
   the timeout error, matching §12); `POST …/stop` ⇒ the server sends
   `play.stop.request { reason: 'request' }`, the `play.stopped.ack` is
   consumed, and the owner receives `play.stopped { reason: 'request' }` with
   **no** `stopUnconfirmed`.

## Contract conformance re-verified against source (normative reads)

- **§5.1/§5.3 establish + re-attach** — `SessionRegistry.establish` keeps the
  old socket bound until the new upgrade replaces it (so the server closes it
  1000 `detached`); a replaced socket's detach does not count as an owner loss
  (verified by the fresh re-attach probe + the `isReplaced` guard).
- **§4.3 token** — single-use + TTL + `(sessionId, connId)` binding; the log
  records result codes only (no token / query string). Fresh probe: replay
  ⇒ 1008.
- **§6.1/§6.2/§6.4 commands** — strict bytes first; mutations → workspace
  `runCommand` (sole executor — delegation is normative); queries → the
  workspace query path; the raw commands.md error passes through so
  `revision_conflict` keeps `currentRevision` (fresh probe confirmed).
- **§7.1/§10/§12 play** — lifecycle state machine, frozen
  `snapshotId`/`revision`, relayId-routed screenshot/diagnostics, present
  timer, inactivity TTL, stop-ack. The three bugs found *during implementation*
  (re-attach nulling `session.socket`, the inactivity TTL never arming, the
  `screenshot.ack`/`diagnostics.ack` payload being dropped before routing) were
  each root-caused and are now pinned by fresh integration tests; this round's
  fresh play probe re-confirmed the relay end-to-end.
- **§11.1/§11.5 bounded resources** — `SESSION_LOG_RING = 128`
  (sessions.ts:16) + log-endpoint `limit` bounds (establish.test:181–207);
  production `DEFAULT_TIMEOUTS` present (config.ts); the shortened test-clock
  seam is documented (handoff decision 8).
- **§5.2 frame + protocol-error bounds** — 64 KiB default / 1.5 MiB
  `screenshot.ack` / 1 MiB out; oversized non-ack frame ⇒ close 1009
  `frame_too_big` (ws.test:170–178); 10 errors in 60 s ⇒ close 1008
  `protocol_error` (backend.ts:483–487; config.ts:19–20).
- **§13.2/§13.5 preview + bridge** — the template injects exactly
  `{ v, authoringOrigin }` (no credentials, no `/api/`); the §13.5 allowlist +
  `v: 1` + nonce-echo + per-type validators are unit-tested in the protocol
  package (14 bridge tests). The editor/preview **postMessage wiring** is
  packet 10 (out of scope here, recorded).

## Toolchain (this round, fresh re-runs)

- `npx vitest run packages/protocol packages/backend` → **9 files / 146
  passed**.
- `npm test` (full) → **59 files / 776 passed** (stable ×2 during impl).
- `npm run check-deps` / `check-boundaries` (7 packages, 115 files, 423
  specifiers) / `build` (strict tsc ×7) → all **exit 0**.
- Negative boundary: the protocol bundle scan above (0 forbidden patterns) is
  the packet-09 analogue of the packet-08 runtime bundle scan.

## Findings this round

- **No P1.** No P2 requiring a backend source change.
- **Review-probe corrections (mine, not the backend's)** — recorded for
  honesty: (a) the command revision field is `expectedRevision` (not
  `revision`); (b) a successful screenshot response carries
  `snapshotId`+`revision`+`dataUrl`+`width`+`height` with **no** top-level
  `relayId` (it is on the request + the timeout error); (c) a successful stop
  is confirmed by the `play.stopped` WS event (`reason: 'request'`), not a
  `stopped` field in the HTTP body; (d) the preview template is served at `/`
  (not `/preview/index.html`). In every case the **contract and the backend
  were correct**; my probe's assumptions were wrong and were fixed, re-run,
  and passed. No backend file was modified this round.

## Non-gating notes (carried, not blocking)

- **Browser visual / WebGL of the preview** — UNVERIFIED (no browser in this
  container; the packet-08 `libnspr4`/`libnss3`/no-root constraint carries
  forward). The preview page + postMessage bridge wiring is **packet 10**, the
  first browser-verified surface. Nothing visual is claimed.
- The `export` admin route is delegated but lands with the exporter in packet
  12 (route present; the export itself is out of scope).
- Packet 08's `playwright` pin contract-change request remains open for the
  owner (needed for packet 10/13 browser verification).

**Acceptance:** m1-acceptance §2.2 packet-09 rows are all satisfied by the
integration suite + this round's fresh probes. Packet 09 is ACCEPTED.
**Next: packet 10** (minimal visual editor + isolated play) — the first packet
requiring a browser.