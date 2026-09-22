# Packet 25 evidence manifest — Content HTTP services, projection data and MCP parity

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** No commit made.

All evidence below was produced by the commands recorded in
`transcripts/checks.txt` on the real repository tree. No browser exists in this
container: every browser/UI-facing part of the packet is **UNVERIFIED** (pointer
to the packet-37 procedure in the handoff).

## Claims → artifacts

| Claim | Artifact |
|---|---|
| Authenticated committed asset bytes are served only by immutable `(project, asset, version)` with `X-Thirdlight-Digest`/`ETag`/immutable cache, and the served body hashes to the declared digest | `transcripts/http-asset-bytes.txt` (raw `curl -D -` headers + `sha256sum` of the body: both `e0189bd4…d76a20`) |
| Unauthenticated reads are `401`; path-shaped identifiers are `path_rejected` before any storage call | `transcripts/http-asset-bytes.txt` (last two exchanges) |
| The actual stdio MCP server exposes the M1 tools plus `tl_content_query`/`tl_content_upload`/`tl_content_job`, routes them over `/api/v1`, and surfaces structured errors | `transcripts/mcp-stdio-and-ws.txt` (`tools/list`, `tl_content_query` success, `tl_content_job` → `job_not_found` 404) |
| The full-state payload carries a bounded content projection (summaries, never bytes) | `transcripts/mcp-stdio-and-ws.txt` (`POST /sessions` `content` block) |
| `mutation.applied` carries complete change data and no binary content | `transcripts/mcp-stdio-and-ws.txt` (final frame for a browser-origin `setTransform`) |
| Upload framing, path escapes, staged-file reads, oversize payloads, disconnect, restart replay | `tests/integration/m2-content/content-security.test.ts` (11 cases) |
| Import/query/instantiate/edit/retry flow, browser/MCP parity, projection convergence, bounded jobs | `tests/integration/m2-content/content-flow.test.ts` (13 cases) |
| Upload-bound arithmetic matches the accepted `delivery/upload-bounds.json` cases | `packages/protocol/src/content.test.ts` (U1–U7 re-derived) |
| Job cancellation/expiry/late results and publish concurrency | `packages/backend/src/content.test.ts` |
| Toolchain green | `transcripts/checks.txt` |

## What really ran (not mocked)

- A **real backend child process** (`esbuild`-bundled `backend-child.ts`,
  spawned with `node`) with its own listeners, ownership record and workspace on
  a **disposable data root** on the real filesystem; the v2 project and its
  `sources/sha256/**` blobs are copied from `fixtures/m2/storage/**`.
- A **real stdio MCP process** (bundled `packages/mcp-adapter/src/index.ts`)
  driven by a real `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`
  — every tool call crosses a process boundary and reaches the backend over
  HTTP; there is no filesystem bypass.
- A **real WS connection** (the `ws` client) for the `mutation.applied`
  projection-convergence assertion.
- Real GLB bytes from `fixtures/m2/assets/tiny-v1.glb` / `tiny-v2.glb` are
  uploaded in 1 MiB-bounded frames, inspected by the injected `asset-pipeline`
  inspector, published as immutable blobs and read back byte-identically.
- The restart case stops the backend with `SIGTERM`, respawns it on the same
  root, performs the explicit admin takeover, and proves the durable retry
  record replays (`duplicated: true`) while the in-memory upload stage is gone.

## Counts (actual)

`npm test`: 81 files / **1131 passed**. New packet-25 tests: protocol 21,
backend units 9, integration flow 13, integration security 11 (54 total).
`typecheck`/`check-deps`/`check-boundaries`/`build` exit 0;
`check-fixtures.mjs` 33/33.

## Scope note (workspace/protocol edits beyond the packet's "May edit" shorthand)

The packet's `May edit` list names `packages/{protocol,backend,mcp-adapter}/**`.
Packet 25 additionally closes **C23-1** and satisfies the accepted
`dependencies.md` §3/§4 rows that name the packet-25 public surface:
`workspace` gains the injected `asset-pipeline` inspector (`inspectStage`,
types-only edge) and routes the bounded M2 content queries
(`queryAssets`/`queryPrefabs`/`queryBehaviors`) through its one query path —
without that, `POST /commands` with those ops is unreachable and the packet's
"UI and MCP can query M2 content through backend" outcome is unsatisfiable.
The `workspace` edits are additive (a new method, a new optional config field,
an extended op union); no accepted M1 behavior changed (the full suite,
including the 255 protocol/workspace tests, stays green).

## Redaction

Test tokens are synthetic (`evidence-authoring-token`,
`evidence-admin-token`, `m2-content-*`). No real credential, capability URL or
host path appears in any artifact; the asset-byte digest is a fixture digest.
