# Packet 10 — independent review pass (round 1 of max 3)

**VERDICT: ACCEPTED** — no P1, no P2 requiring an editor source change.

Single-session review per the owner's RESUME-2026-09-18 mode (no compact
available mid-run): worked strictly from the committed tree
(`873f134` impl + `5ea16b5` record) + contract text (sessions.md §13,
commands.md §6, runtime.md §2/§7/§10, dependencies.md §3/§4.1/§5.4/§7,
m1-acceptance.md §2.2) + FRESH independent probes — not implementation memory.

## Scope re-verified (contract conformance, from source)

- **React is editor-scoped only** (decision 0001 §10): `react`/`react-dom`
  are declared in `packages/editor/package.json` (exact pins) and imported
  **only** by `src/ui/*.tsx` (the React panels). The viewport (`viewport/
  viewport.ts`), gizmo (`viewport/gizmo.ts`), and preview bootstrap make NO
  React import; the three.js scene/camera/renderer and picking are imperative.
  `check-boundaries` confirms the editor's value edges are protocol/runtime/
  three-adapter (+ react/react-dom/three externals) and it has no Node
  builtins.
- **The preview is separate-origin and credential-free** (sessions.md §13.2):
  `preview/preview-bootstrap.ts` reads `window.__thirdlightPreview`
  (`{ v, authoringOrigin }`) + `?play=<id>`; it carries **no** authoring
  token, no API URL, and makes **zero** backend calls (the only `fetch(`/
  `XMLHttpRequest` tokens in the bundle are dormant three.js loader code/docs;
  the preview's own source greps 0). The backend preview template injects
  exactly `{ v, authoringOrigin }` (packet 09).
- **The bridge enforces §13.3/§13.5** (`preview/bridge.ts`): exact
  `event.origin === expectedOrigin` (a wildcard is impossible — it is an
  equality compare) **and** a trusted-source predicate (pre-handshake only
  parent/opener; post-handshake the stored trusted source); a JSON-object
  body; the §13.5 protocol allowlist validator for the direction; and the
  nonce handshake (a `tl.snapshot` with a nonce ≠ the handshake nonce is
  dropped; a `tl.handshake.ack` with a nonce ≠ the editor's nonce is dropped).
  `postLocal` re-validates locally and **never** posts `targetOrigin:"*"`.
  The bridge delegates wire-shape validation to the pure `protocol`
  validators (single source of truth) — confirmed by a fresh probe.
- **Browser state is a backend projection** (`session/projection.ts`):
  hydrated from full state; `mutation.applied` applied with `requestId`
  dedup (a replayed/unknown ack never double-applies); the **gap rule**
  (`revision > lastSeen+1 ⇒ needsResync, change NOT applied`) is the
  browser-side "trust the backend, resync on a gap" enforcement — the browser
  is never the authoritative DB.
- **The gesture is no-per-frame-traffic + one commit** (`session/gesture.ts`):
  `setLocal` updates a display-only preview (no command); `decideCommit`
  returns exactly one `setTransform` with the **base** `expectedRevision`
  (or a noop if unchanged); `handleResult` auto-rebases **once** on
  `revision_conflict` (to `currentRevision`) and **surfaces** (not loses) a
  second conflict.
- **esbuild TSX loader** (decision 0001 §10): `tools/build.mjs` builds the
  editor + preview entries with the TSX loader; `tsc --noEmit -p
  packages/editor` passes under the strict base. The preview entry lives at
  `packages/editor/src/preview/preview-bootstrap.ts`, matching the
  packet-04 `build.mjs` + `build.test.mjs` path contract (the initial
  `src/play/preview/` layout was moved to respect it — this is a build
  choice, not a contract change).

## Fresh evidence this round

1. **15/15 fresh public-API probes** (a temporary suite importing
   `@thirdlight/editor/{gesture,projection,bridge}` — removed after passing,
   per the packet-09 pattern): gesture no-preview-traffic + noop-on-unchanged
   + exactly-one-commit-at-base-revision + idempotent decide + one auto-rebase
   then surfaced second conflict; projection hydrate/apply/dedup + the
   gap-resync rule (a `revision:8` event after `lastSeen:5` sets `stale` and
   does NOT apply); bridge no-`*`-origin posting, origin-mismatch drop,
   untrusted-source drop, nonce-mismatch snapshot drop, nonce-match delivery,
   and allowlist-unknown-type drop. All PASS.
2. **Fresh preview-bundle credential scan** (re-counted): `Bearer`=0,
   `/api/v1/`=0, `__thirdlightEditor`=0, `authoringToken`=0,
   `new WebSocket(`=0 — the preview receives no credentials (m1-acceptance
   §2.2 row).
3. **Fresh editor-bundle Node-builtin scan** (re-counted): `__dirname`=0,
   `node:fs/http/crypto/os`=0, `process.env`=0, `child_process`=0 — the editor
   bundle is browser-only.
4. **Toolchain (fresh)**: `npm test` 64 files / 828 tests (the 37 editor
   tests + the 15 temporary probes); `check-deps` exit 0 (all specs exact —
   the react pins are exact in `packages/editor/package.json`);
   `check-boundaries` OK (8 packages, no violations); `npm run build` exit 0
   (strict tsc ×8 + `dist/editor/{main.js,index.html}` + `dist/preview/
   preview.js`).

## Findings

**None in the editor source.** The only round deltas were **review-probe
shape errors on my side**: the first draft of the bridge probes used
`playSessionId: "play-1"` and `snapshot: { scene: {} }`, which the protocol
validator (correctly) rejects — `playSessionId` must be `play-`+32 hex and
`snapshot` must be the runtime.md §2 document `{ snapshotId, projectId,
revision, scene }`. Fixed the probes to conforming shapes and re-ran (15/15
PASS). In every case the **contract and the editor were correct**; no editor
file was modified this round.

## Non-gating / carried

- **Browser visual / WebGL UNVERIFIED** (no browser in this container — the
  packet-08 `libnspr4`/`libnss3`/no-root constraint carries forward). The
  imperative viewport render, gizmo drag, React panel layout, preview WebGL
  oscillation + snapshot-revision HUD, the real-browser play/stop round-trip +
  screenshots, and the reload/orphaned-preview re-handshake flows are marked
  UNVERIFIED with exact manual steps in `docs/handoffs/10.md`. The pure logic
  (gesture/projection/envelope/bridge) is unit-tested and the browser wiring
  is type-checked, but nothing visual is claimed.
- The **live WS authoring transport** (`session/client.ts`) is browser code
  (WebSocket); its pure decision logic (envelope) is unit-tested and the
  server side was verified in packet 09. The end-to-end browser↔backend WS
  session is exercised only in a real browser — carried to the browser-
  verification step (packet 13 / Gate C).

## Acceptance

m1-acceptance §2.2 packet-10 rows: gesture no-per-frame-traffic + one-commit
+ conflict recovery (PASS, fresh probe); preview receives no credentials
(PASS, fresh bundle scan); bridge exact origin/source/nonce (PASS, fresh
probe); browser state is a backend projection (PASS, fresh probe); esbuild
TSX loader (PASS, build + typecheck); preview/bridge isolation + relay
(PASS, unit + packet-09 backend integration).

**PACKET 10 ACCEPTED.** Next: packet 11 (MCP adapter).