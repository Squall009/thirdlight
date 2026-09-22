# Packet 60 — M3 standalone export: owner-run browser procedure

**Status: UNVERIFIED in-container** (no browser / GPU / audio device — the
packet-38 baseline §1). The in-container-verified half is:

- the **§5.4.1 + §17.5 re-measurement** (`tests/integration/m3-export/bundle-scan.test.ts`:
  the reference full-core three re-scans to the §5.4.1 table — d=3, f=3, h=26,
  j=3, a/b/c/e/g/i=0 — and the REAL M3 export bundle scans to exactly the
  recorded baseline + applicable rows: **d = three(3) + Rapier(1) +
  `./manifest.json`(1) + `./scene.json`(1) + one per unique declared asset
  path; f/h/j = the three baseline + 0 from `game-host`; a/b/c/e/g/i = 0**; the
  graph contains the SAME shared `game-host` + `platformer-game` composition
  as the preview, no editor/backend/behavior source).
- **two-tree determinism + preview/export parity** (`tests/integration/m3-export/
  determinism.test.ts`: two exports of the same captured state — a fixed wall
  clock — into two DIFFERENT output trees are byte-identical (the accepted
  timestamps are the only time-dependent bytes; the `buildId` is re-derived from
  the manifest content); the M3 EXPORT manifest and the v3 PLAY manifest for the
  same capture are the SAME build — identical `buildId`/`sceneDigest`/
  `contentDigest`/`settingsDigest`, the resolved six-key `settings` reach both
  hosts).
- the existing **declared==emitted relative closure** (`tests/integration/m3-builds/
  m3-builds.test.ts`) + the **closed failure modes** (missing/corrupt media and
  a rejected hostile source preserve the previous output; `export_snapshot_
  mismatch` leaves the prior tree byte-untouched) + the export pipeline's
  **negative authoring-token/capability/Node/URL scans** over every emitted file.

This checklist is the owner-run real-browser procedure that witnesses the
**standalone** half (B21/B22/B23): the full game running from static output with
**no editor services reachable**.

## Setup

- The real backend (or the packet-58 `demo-0003` v3 project) to produce the
  export ONCE: `POST /api/v1/projects/:id/export` → the relative output tree
  (`index.html`, `js/main.js`, `manifest.json`, `scene.json`, `meta.json`,
  `content/sha256/<digest>` assets).
- A **separate independent static file server** (e.g. `python3 -m http.server`
  or Caddy) serving the export tree **under a NON-ROOT prefix** (e.g.
  `http://127.0.0.1:8080/exports/m3demo@r1/`).
- The editor backend **stopped / unreachable** (kill the process, or point the
  origin at a dead port). The authoring origin is likewise unreachable.
- A real browser (WebGL-capable) with a **physical keyboard** and a **gamepad**.
- A network recorder (DevTools Network / mitmproxy) to witness every request.

## Checklist (B21/B22/B23 standalone scope)

- **X1 — cold standalone start:** open
  `http://127.0.0.1:8080/exports/m3demo@r1/index.html`. The page loads
  `./manifest.json`, `./scene.json`, and every declared asset by **relative**
  fetch (the §17.5 list — nothing else). **No request** reaches the editor
  backend or the authoring origin (the network recorder shows ONLY the static
  server's own relative paths). WebGL initializes; the **title screen** (the HUD
  title/objective/instructions from `content.game`) is shown as `ready` — not
  gameplay.
- **X2 — the shared host, standalone:** the bundle composes the SINGLE
  `createGameHost` (the same entry the preview wraps). The resolved `settings`
  reach the controller and the physics port from the same in-memory object
  (`solver.gravityY = settings.gravity_y`). No editor/MCP/SDK import resolves
  at runtime.
- **X3 — physical keyboard + gamepad play:** title → **Enter** (or a fresh pad
  button 0) → `start` (`movementSteps: 0`, spawn position). Drive with the
  **physical keyboard** (arrows/WASD + space) and the **gamepad** (axes +
  button 0). Reach the goal → win → `replay` (the runId epoch bumps, counters
  reset, re-placed at spawn). A held Start at the title produces no phantom
  jump (the fresh-release + first-live-step gate).
- **X4 — audio owner, standalone:** the audio owner (`createGameAudioOwner`)
  plays the declared cues (jump / land / win) through the browser audio device.
  No audio asset is fetched from the backend (all cue bytes are the relative
  `content/sha256/<digest>` artifacts).
- **X5 — the recorded network is fully relative:** the complete recorded
  network for the playthrough is exactly the §17.5 fetch list (manifest +
  scene + the declared asset paths), all relative to the non-root prefix, all
  served by the independent static server. **Zero** `http://`/`https://`
  absolute or remote fetches; **zero** requests to the (dead) backend/authoring
  origins.
- **X6 — metadata + licenses:** `meta.json` carries the versioned metadata
  (engine/version hashes, the exact licenses for the bundled three + Rapier +
  the game composition). The `manifest.json` `buildId` is the self-identifying
  digest of the manifest content (re-verifiable from the emitted bytes).
- **X7 — determinism witness (optional):** re-run the export into a second tree;
  the two trees are byte-identical (the accepted timestamps are the only
  time-dependent bytes). The `buildId` re-derives to the same value.

## Evidence

- The recorded network capture (a HAR or a mitmproxy flow) proving the fully
  relative, backend-free request set.
- A short screen capture / screenshots of the title → play → win → replay on
  the physical keyboard + gamepad.
- An audible witness (recording) of the cue playback.
- The two exported trees + their per-file hashes (the determinism witness).

All of the above is **UNVERIFIED in-container** — the in-container half is the
Node build/scan/parity evidence cited at the top.