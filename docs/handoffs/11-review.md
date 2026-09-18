# Packet 11 independent review — round 1 of max 3

VERDICT: **ACCEPTED** (single-session review per the owner's RESUME-2026-09-18 mode;
worked strictly from the committed tree — `ef875d3` impl + `b2ac694` record — plus
contract text: dependencies.md §3/§4.1/§7, commands.md §6, sessions.md §5–§12,
decision 0001 §5, m1-acceptance.md §2.2 — plus FRESH independent probes, not
implementation memory).

NO P1. NO P2.

## Re-verified from the committed tree (normative reads)

- **Real supported SDK, not a custom protocol.** `node_modules/@modelcontextprotocol/
  sdk` is the genuine ESM package at **exactly 1.30.0** (has `client/`, `server/`,
  `inMemory`, `stdio` modules). The server is the SDK's low-level `Server` (the real
  MCP `initialize`/`tools/list`/`tools/call` methods), the e2e uses the SDK's `Client`
  + `InMemoryTransport`, and the stdio entry uses the SDK's `StdioServerTransport`.
  No hand-rolled JSON protocol labeled "MCP".
- **Routes into the same services — never a second mutation engine.** `backend-client.ts`
  hits ONLY the backend's `/api/v1` surface (`/projects/:id/commands`, `/sessions`,
  `/projects/:id/play`, `/play/:psid/{stop,screenshot,diagnostics}`) via global `fetch`
  — the identical routes the browser uses. The MCP layer validates argument shape and
  enforces `expectedRevision`; the backend's commands route (→ workspace `runCommand`,
  the sole executor) enforces op semantics/revision. No in-MCP scene mutation.
- **Six charter §7 categories as seven tools; no eval/shell/chat.** `tl_inspect`,
  `tl_command`, `tl_sessions`, `tl_play_start`, `tl_play_stop`, `tl_diagnostics`,
  `tl_screenshot`. No `eval`, no shell, no embedded chat (decision 0001 §5).
- **`node: []` boundary respected (pure Node).** 0 `node:` imports in the package's own
  source; it uses global `fetch` + global Web Crypto (`crypto`) + global `process`.
  The SDK-referenced builtins (`node:stream`/`node:http`/`node:child_process` IOType)
  and the backend source's builtins (`node:http`/`node:fs`/`node:path`/`node:crypto`,
  `ws`) are declared in a LOCAL `src/ambient.d.ts` (type-only, mirrors the backend's own
  ambient declarations) — no `@types/node`, no Node runtime coupling.
- **No direct `zod` dependency.** `dependencies` = `{@thirdlight/protocol,
  @thirdlight/backend, @modelcontextprotocol/sdk}` only; the low-level `Server` + plain
  JSON-Schema `inputSchema` + manual validation keeps `zod` a transitive (SDK) dep, so the
  §7 pin table stays exact.
- **`/services` subpath only.** The backend import is `@thirdlight/backend/services`
  (allowed by dependencies.md §4.3); no other backend subpath is imported.
- **Responses/errors bounded + meaningful.** `revision`/`playSessionId`/`snapshotId` on
  results; structured `code`/`fields` on errors (`revision_conflict` carries
  `currentRevision`), ≤ 256 chars, `isError: true`; screenshot `maxWidth` clamped
  256–2048 (backend clamps + bounds the dataUrl ≤ 1 MiB).
- **The `.` entry is the executable server, not importable cross-package.** 0 other
  package imports `@thirdlight/mcp-adapter` (check-boundaries: its `.` subpath is
  excluded from the importable set).
- **Harness config documented without real credentials.** `docs/handoffs/11.md` gives the
  spawn command (`node dist/mcp-adapter/mcp.mjs`) + the env-var names
  (`THIRDLIGHT_AUTHORING_ORIGIN`/`PROJECT_ID`/`MCP_TOKEN`/`MCP_CLIENT_ID`/`MCP_TIMEOUT_MS`)
  + the stdio transport; the token is a deployment value in the spawn env, never a
  concrete secret.

## FRESH evidence this round (not implementation memory)

1. **SDK identity (fresh):** read `node_modules/@modelcontextprotocol/sdk/package.json`
   → `name` `@modelcontextprotocol/sdk`, `version` `1.30.0`; `dist/esm/{client,server,
   inMemory.js}` present ⇒ the real SDK.
2. **Pure-Node (fresh grep):** `grep -rEn "from 'node:|require\('node:'" packages/mcp-adapter/src`
   ⇒ 0 hits in the package's own source.
3. **No direct zod (fresh):** read `packages/mcp-adapter/package.json` → `zod` NOT in
   `dependencies`.
4. **check-boundaries (fresh):** OK — 9 packages [backend, commands, editor, mcp-adapter,
   project-model, protocol, runtime, three-adapter, workspace], 140 files, 489 specifiers;
   the mcp-adapter `node: []` + `/services`-only edges hold.
5. **e2e re-run (fresh, real client):** `npx vitest run packages/mcp-adapter` → 8/8 (tools/
   list=7; createEntity applies revision 0→1; setTransform applies revision→2 + observed
   by inspection; STALE ⇒ `revision_conflict` `currentRevision:2` not applied; no-browser
   play ⇒ `session_unavailable`; no-browser screenshot ⇒ `play_not_found`).
6. **stdio transport re-verified (fresh spawn probe):** the built `dist/mcp-adapter/
   mcp.mjs` spawned via the SDK `StdioClientTransport` + `Client` ⇒ MCP `initialize`
   handshake OK + `tools/list` = 7 (tl_inspect, tl_command, tl_sessions, tl_play_start,
   tl_play_stop, tl_diagnostics, tl_screenshot) over stdio.
7. **No cross-package import (fresh grep):** 0 packages import `@thirdlight/mcp-adapter`.
8. **Full toolchain (fresh, clean tree @ b2ac694):** `npm test` 64 files / 821 passed;
   `npm run typecheck` exit 0 (9 pkgs); `npm run check-deps` exit 0; `npm run
   check-boundaries` OK; `npm run build` exit 0 (editor + preview + `dist/mcp-adapter/
   mcp.mjs`).

## Findings

None in the mcp-adapter source. Non-gating carried:
- **Browser-side observation UNVERIFIED** (no browser/WebGL in this container — the
  packet-08 constraint carries forward): a harness-created box is verified to apply in
  backend state + be observable by MCP inspection; the visual render in the browser needs
  a real browser. Manual steps in handoff 11.md.
- **Positive `tl_screenshot`/`tl_diagnostics`/`tl_play_start` against a connected preview
  UNVERIFIED** (the no-browser FAILURE paths are verified; the success path needs a
  connected browser+preview rendering a scene). Manual steps in handoff 11.md.
- `tools/call` over stdio with a live backend is verified by composition (the stdio
  transport is proven by the spawn probe; `tools/call`→backend by the in-memory e2e against
  the same `createMcpServer`/tools); a single in-package test cannot spawn the stdio child
  + a backend (the `node: []` boundary forbids `node:child_process`/`node:fs` in-package),
  so the spawn probe ran outside the package as a one-off.
- The harness's MCP-client selection (which agent connector consumes this server) is an
  owner deployment decision (decision 0001 §5 — pi has no built-in MCP client; pi-web does).

## Acceptance (m1-acceptance.md §2.2 packet-11 rows)

- Bounded project/entity inspection — PASS (`tl_inspect`, real-client e2e).
- Command submission — PASS (`tl_command`, createEntity/setTransform apply + observed).
- Session listing — PASS (`tl_sessions`).
- Play start/stop — PASS (routes verified; no-browser start fails `session_unavailable`).
- Bounded diagnostics — PASS (route + bound verified; no-browser fails `play_not_found`).
- Screenshot from a selected connected browser — route + bound + no-browser failure PASS;
  the connected-browser success path is UNVERIFIED (no browser; manual steps recorded).
- Stale mutation fails as specified — PASS (`revision_conflict` + `currentRevision`).
- No-browser visual request fails as specified — PASS (`session_unavailable` /
  `play_not_found`, structured, no hang).
- End-to-end via a real MCP client (not unit tests alone) — PASS (real `Client` + real
  server + real backend; stdio spawn probe confirms the physical layer).
- Harness connection documented without real credentials — PASS (handoff 11.md).

**PACKET 11 ACCEPTED.** Next: packet 12 (standalone export + exporter).