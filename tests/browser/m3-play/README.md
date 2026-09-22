# Packet 59 — M3 Play: owner-run browser procedure

**Status: UNVERIFIED in-container** (no browser / GPU / audio device — the
packet-38 baseline §1). The in-container-verified half is the Node play build
(`tests/integration/m3-play/m3-play.test.ts`: the v3 play artifact set + the
closed failure modes) + the backend v3 play integration (`buildPlayContentM3`
+ the `startPlay` v3 branch). This checklist is the owner-run real-backend +
real-browser + real-SDK procedure that witnesses the browser half.

## Setup

- The real backend (committed `demo-0003` v3 project, a v3 authoring envelope
  with a model + audio + a controller + a goal), a real browser, and a second
  SDK/MCP client for the stale-edit + relay traces.
- The preview iframe is embedded with the C38-1 CSP diff (`script-src 'self'
  'wasm-unsafe-eval'`) + `allow="gamepad"` (delivery §6).

## Checklist (B04–B16 integrated preview scope)

- **P1 — truthful ready:** starting Play for a v3 project shows the **title
  screen loaded** (the HUD title/objective/instructions from `content.game` as
  text nodes) as `ready` — NOT gameplay started. The manifest v2 `buildId` is
  WebCrypto-verified; the v3 `scene.json` re-hashes to `manifest.sceneDigest`;
  every declared asset read is digest-verified. No gameplay step runs until the
  start confirm.
- **P2 — the shared host:** the preview composes the SINGLE `createGameHost`
  (the same entry the M3 export uses) — no second bootstrap/controller/run-state
  owner (delivery §3.2). The resolved `settings` reach the controller **and**
  the physics port from the same in-memory object (`solver.gravityY =
  settings.gravity_y`).
- **P3 — start/win/replay:** title → Enter (or a fresh pad button 0) → `start`
  (`movementSteps: 0`, spawn position); a win → `replay` (the runId epoch
  bumps, counters reset, re-placed at spawn). A held Start at the title produces
  **no phantom jump** (the fresh-release + first-live-step gate).
- **P4 — controls over the relay:** `tl_game_control` (start/replay/mute/unmute)
  and `tl_game_observe` over the real backend + the selected browser. The
  identity tuple `(playSessionId, snapshotId, buildId, runId, stepIndex)` is
  carried on every control result + observation + the canvas screenshot.
  `expectedRunId` mismatch → `game_run_stale` (409, no command applied).
- **P5 — the closed failure set:** wrong origin → `bad_origin`; wrong bridge
  source/nonce → `game_relay_rejected` (dropped + counted, never a fabricated
  result); expired locator → `play_locator_expired`; no registered browser /
  owner WS detached / not presented → `session_unavailable`; no `tl.game.result`
  in time → `game_relay_timeout`; physical input during exclusive test mode →
  `input_relay_conflict`.
- **P6 — no fake user activation:** a relay-originated action **cannot** unlock
  audio — with no local gesture the sound status is `blocked` (`unlocked:
  false`) and the relay never fabricates a `ready`/`running` sound state.
- **P7 — stop during load/respawn, tab hide, ten cycles:** stopping during load
  or respawn is a clean no-op; a hidden tab suspends sampling + audio + resets
  the accumulated frame time (bounded catch-up on resume, no fast-forward); ten
  start/stop cycles leave no leaked runtime/physics/audio/context.
- **P8 — the pin is honored:** capture Play, edit the content live (an authoring
  `setSettings`/`setComponent` advances the revision), verify the OLD pinned
  Play keeps its `snapshotId`/`buildId`/`runId`/`run_speed`/`gravity_y`/locator
  bytes and its `stepIndex` continues; a FRESH start adopts the new capture. No
  live settings reload and no mid-run mutation.
- **P9 — nothing sensitive crosses:** a relay request/result/bridge message/log
  carries no GLB/WAV bytes, no base64 media, no authoring token, no `contentId`
  capability (redacted), no absolute workspace path. Audio is referenced by
  `assetId` only; bytes load from the locator by the preview itself.
- **P10 — evidence:** the actual rendered **PNG** (canvas only — a separate
  full-page screenshot or recorded walkthrough for the title/HUD/goal, since a
  composited page screenshot does not carry WebGL content, packet-38 recorded)
  + separate **DOM HUD** evidence + the **redacted network** capture.

## Not in container

The real WebGL render, the real audio (audibility by §41.4.7/§41.4.8), the
physical gamepad, the real browser CSP/gamepad behaviour, and the real relay
round-trip are all owner-run; they upgrade the UNVERIFIED rows only with
witnessed evidence.