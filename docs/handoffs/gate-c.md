# Gate C — architectural review (covers packets 08–12)

Date: 2026-09-18 · Mode: single-session takeover (owner ruling RESUME-2026-09-18).
**This review and the implementation it covers were the SAME session (post-compact
honest-review passes); the recorded verdicts are the session's own — no external
reviewer approval is claimed (owner rule 4).**

Per the architectural review prompt: scope compliance, public boundaries, state
ownership, revision/retry behavior, durability/recovery, browser/runtime isolation,
export independence, evidence quality. Worked from the committed tree
(`e54c625` = HEAD after packet 12 review), the contract set
(runtime.md, project-model.md, sessions.md, commands.md, workspace.md, protocol.md
edges, export.md, dependencies.md, m1-acceptance.md), and FRESH cross-cutting
probes (not implementation memory).

## Verdict

**ACCEPT with bounded follow-ups (CF-1…CF-4)** — no blockers for packet 13.
All four follow-ups are bounded and non-blocking; CF-1 is settled by packet 13's
own browser-verification step, and CF-2/CF-3 are documented contract-change
requests awaiting owner disposition (they are implemented fail-closed and additive).

## Cross-cutting checks (fresh evidence this gate)

1. **State ownership — single mutation engine.** Exactly ONE
   `service.runCommand(` call site in the backend (backend.ts:766 — the command
   route both the browser WS and the MCP HTTP tools reach); revision advancement
   lives ONLY in the commands package (`history.ts` undo/redo, `ops.ts` ops —
   pure); no editor/MCP/exporter code touches the mutation surface
   (`grep runCommand|applyMutation` ⇒ backend + commands + workspace only). The
   exporter reads through the injected workspace service (types-only edge) and
   never opens a second authority; the browser is a projection (packet 10) with
   requestId dedup + gap-resync, never an authoritative DB.
2. **Public boundaries.** `check-boundaries` OK (10 packages, 150 files, 513
   specifiers); `exports` maps expose only the §3 rows (fresh: the exporter
   exposes `.` only — the browser bundle entry is unreachable by package name);
   fresh boundary-scoping probes: a normal exporter file importing
   `@thirdlight/backend/services` or `@thirdlight/runtime` ⇒ `forbidden-edge`
   FAIL (the §4.2 entry override is scoped to `export-bootstrap.ts` only); the
   mcp-adapter imports the backend via the `/services` subpath only; the editor
   has no node builtins; the runtime is three-free + I/O-free at the source
   level (0 three/fetch/WebSocket/XHR/`node:` hits in `packages/runtime/src`).
3. **Revision/retry behavior.** Optimistic concurrency end-to-end with fresh
   evidence at every layer (packets 09/11/12 review rounds): stale
   `expectedRevision` ⇒ `revision_conflict` carrying `currentRevision`, not
   applied; idempotency by `requestId` (duplicate ⇒ `duplicated: true`, same
   revision); editor envelope lost-ack retry (same requestId, ≤ 1); gesture
   commit ≤ 1 auto-rebase, second conflict surfaced; MCP `tl_command` injects
   `requestId` via Web Crypto and surfaces the structured conflict.
4. **Browser/runtime isolation.** `runtime` imports only
   `@thirdlight/project-model` (deep-freezes its input — the snapshot is
   immutable by construction); `three-adapter` owns Object3D/material/GPU
   lifetimes; the preview is separate-origin and credential-free (fresh scan of
   `dist/preview/preview.js`: `Bearer` 0, `/api/v1/` 0, `__thirdlightEditor` 0,
   `authoringToken` 0, `new WebSocket(` 0); the bridge enforces exact
   `event.origin` + trusted source + nonce (packet 10 review, 15/15 fresh
   probes); the editor's React scope is panel-only (decision 0001 §10).
5. **Export independence.** The exported tree (real export, on disk) is
   self-contained: fresh scan of all four files ⇒ 0 hits on credentials, both
   origins, `/api/v1/`, `node:`, `/mcp`, `file://`; the only engine network
   mechanism is the single relative `fetch("./snapshot.json")`; verified through
   an independent `python3 -m http.server` with the backend STOPPED (its
   authoring port refused connections); the bundle graph is exactly the §5.2 set
   (metafile check at export time) and the §5.4.1 table re-verified against the
   current install (reference full-core re-scan exact).
6. **Durability/recovery.** Gate B scope (packets 05–07); Gate C only observes
   it: the backend's play session routes and the export pipeline both read
   through the workspace service's last-acknowledged state (queries never see a
   partial state; the export re-reads the revision after the build and fails
   closed on a change).
7. **Evidence quality.** Full toolchain green this gate (fresh): `npm test`
   66 files / 840; `npm run typecheck` exit 0 (10 pkgs); `check-deps` OK (all
   specs exact); `check-boundaries` OK; `npm run build` exit 0. Per-packet
   review records exist with fresh probes (handoffs 08/09/10/11/12 + their
   review rounds). Honest UNVERIFIED marks with exact manual steps where no
   browser ran (CF-1). No invented tests/screenshots/backends.

## Bounded follow-ups (non-blocking)

- **CF-1 — browser visual/WebGL verification UNVERIFIED.** No browser in this
  container (missing `libnspr4`/`libnss3`, no root — the packet-08 constraint).
  Unverified surfaces: the editor's render/selection/gizmo/React panels; the
  preview WebGL oscillation + HUD + real-browser play/stop round-trip +
  screenshots; the export page's WebGL render, the demo oscillation, the HUD
  selected-backend line, and console/network inspection. **Settled by packet
  13's integrated browser-verification step** (m1-acceptance §1 steps 12–13);
  exact manual steps are recorded in handoffs 10/12.
- **CF-2 — contract-change request, sessions.md §13.7 (owner disposition
  required):** optional `engineRoot` backend config field (+ the
  `THIRDLIGHT_ENGINE_ROOT` env var in the executable entry). The export route
  needs the engine installation root and no config field exists for it.
  Implemented additive/optional; without it the route fails closed (structured
  `unavailable`). Backward-compatible; no other route affected.
- **CF-3 — contract-change request, export.md §5.4.1 (owner disposition
  required):** the literal reference-build entry
  `import * as THREE from 'three';` elides to a 15-byte empty IIFE under pinned
  esbuild 0.28.2 (unused namespace imports are dropped even with
  `treeShaking: false`), making binding 3 unsatisfiable. The implemented
  interpretation references the namespace
  (`…console.log(THREE.REVISION);`) to materialize the full-core bundle
  (1,777,839 B — consistent with the contract's re-measurement note); the
  §5.4.1 table's counts are UNCHANGED and remain the binding record.
- **CF-4 — open playwright pin request (packet 08).** If packet 13's
  browser-verification step is to use headless-browser automation, the pin
  needs owner approval (dependencies.md §9). If verification stays manual
  (no browser available), the request is moot and can be withdrawn.

## Limits of what the supplied evidence establishes

- Established (byte/HTTP/WS/protocol level): the full command/snapshot/relay
  protocol behavior; the single-mutation-engine property; the export pipeline
  incl. the scan + graph + atomic replacement; the exported artifact's
  self-containment and static-server servability; the reproducibility scope
  (byte-identity except `exportedAt`); the credential-free preview/export
  bundles.
- NOT established (pixel/real-browser level): anything that requires a WebGL
  context and a browser event loop — CF-1. "Mock alone is not integration":
  the real-browser flows (editor session over WS in a live tab, the preview
  bridge across real origins, the export page render) are the packet-13
  verification target, and are marked UNVERIFIED here, not claimed.

**Gate C: ACCEPT with bounded follow-ups CF-1…CF-4.** Gate D prerequisite
(Gate C accepted) is satisfied; packet 13 may proceed.