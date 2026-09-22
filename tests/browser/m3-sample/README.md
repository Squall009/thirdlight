# Packet 61 — Beacon Reach sample: owner-run browser procedure

**Status: UNVERIFIED in-container** (no browser / GPU / audio device — the
packet-38 baseline §1). The in-container-verified half is:

- the **self-generated original content** (`samples/beacon-reach/assets/`:
  five PCM WAV cues + two glTF 2.0 GLB models, a deterministic generator
  `tools/generate-assets.mjs`, per-asset `provenance.json` SHA-256 digests + an
  explicit reuse `LICENSE`; no downloaded third-party content, no external
  image/audio references, no fonts). The GLB gap is disclosed: the three-adapter
  realizes boxes/lights/surfaces/camera only, so the visible player is a BOX and
  the GLB courier/beacon are imported content (declared in the closure) not
  rendered as animated models.
- the **captured sample project** (`samples/beacon-reach/captured/project.json`):
  a real v3 project authored through the SAME `@thirdlight/commands
  applyMutation` the browser and MCP use (a reproducible command recipe in
  `recipe/commands.json`), with the game config (title/objective/instructions/
  spawn/killY/cues) and the accepted gameplay settings authored as content.
- the **traversable step trace with REAL physics**
  (`tests/integration/m3-sample/step-trace.test.ts`): the captured layout
  composed over the real `platformer` + `runtime` + `physics-rapier` (pinned
  0.20.0) + `platformer-game` modules at the ACCEPTED settings (no retuned
  constants) — a fall in the first pit before the checkpoint increments the
  death count once and respawns at the START spawn (X≈3); the full traversal
  clears the low step, both hazards and both pits, activates the checkpoint
  once, and reaches the beacon (goal) — the layout is traversable; a fall in the
  second pit after the checkpoint respawns at the CHECKPOINT spawn (X≈24).
- the **sample integrity tests** (`tests/integration/m3-sample/sample.test.ts`):
  the committed assets match their provenance digests and the WAVs are the
  accepted §41.4 PCM container (mono 48 kHz 16-bit, ≤ 2000 ms); re-running the
  generator is idempotent; replaying the command recipe reproduces the captured
  scene + content digests exactly; no hardcoded runtime IDs (every
  command-authored entity is auto-generated, every content reference resolves).

This checklist is the owner-run real-browser procedure that witnesses the
**visual + audible** half (B21): the full Beacon Reach game running in the
editor preview and the standalone export.

## Setup

- The real backend running, with the Beacon Reach sample project loaded (open the
  captured `samples/beacon-reach/captured/project.json` as a workspace project,
  or re-run the recipe `samples/beacon-reach/recipe/commands.json` through the
  editor). The project's assets are the generated WAVs + GLBs.
- A real browser (WebGL-capable) with a **physical keyboard** (A/D or ←/→ to
  move, Space to jump, Enter to start) and audio output.
- Optionally: the standalone export (`POST /api/v1/projects/:id/export`) served
  from a **separate static file server** with the editor backend unreachable.

## Checklist (B21 Beacon Reach scope)

- **S1 — preview title:** open the editor preview for the Beacon Reach project.
  The HUD shows the title screen (`content.game` title "Beacon Reach",
  objective, instructions "A/D move. Space jumps. Enter starts."). The scene
  renders: the start ground, the low step, the two hazard strips (red), the two
  pits, the checkpoint (green), the beacon (blue), the player box, and the key +
  ambient lights. No gameplay motion until the run starts.
- **S2 — start + first cue:** press Enter. The run starts; the `cue-start` audio
  plays (audible, short tone). The player box is at the start spawn (X≈3),
  grounded.
- **S3 — learn + jump:** hold A/D (right). The player runs right. Press Space to
  jump the low step (the `cue-jump` tone plays on the jump). The camera follows
  (the dead-zone + smoothing from `cameraFollow`).
- **S4 — hazard:** approach the first hazard strip (red, X≈10.5..11.3). Jump
  (Space) to clear it (the capsule's arc clears the strip's top). Walking into it
  at ground level would trigger a hazard death.
- **S5 — deliberate death before the checkpoint:** walk into the first pit
  (X≈16..17.5) WITHOUT jumping. The player falls below `killY` (-4); the
  `cue-death` tone plays; the death counter increments to 1; after the bounded
  respawn delay the player is re-placed at the START spawn (X≈3) with velocity
  stopped. The checkpoint is not yet activated.
- **S6 — checkpoint:** from the start, run right and clear the low step, the
  first hazard, and jump the first pit. Reach the checkpoint (green, X≈22): the
  `cue-checkpoint` tone plays, the checkpoint activates (the emissive appearance
  change), and the respawn point moves to the checkpoint's safe spawn (X≈24).
  The single-activation guard holds (re-crossing emits no second activation).
- **S7 — deliberate death after the checkpoint:** continue right, clear the
  second hazard, and walk into the second pit (X≈32..33.5) WITHOUT jumping. The
  player falls; the death counter increments to 2; after the respawn delay the
  player is re-placed at the CHECKPOINT spawn (X≈24) — not the start.
- **S8 — goal:** from the checkpoint, run right, clear the second hazard and the
  second pit, jump the final step, and reach the beacon (blue, X≈44..45): the
  `cue-goal` tone plays and the run is won (the HUD shows the goal / a replay
  affordance). The death counter is 2; the checkpoint is active.
- **S9 — replay:** a fresh Enter (the fresh-release cycle) replays from the start
  spawn with the counters reset.
- **S10 — standalone export parity (optional):** serve the standalone export from
  the separate static server (editor backend unreachable). The same S1–S9
  behavior holds from the static output with NO editor services reachable (the
  relative §17.5 fetch list; no editor-backend/authoring-origin request).

## Evidence to record (owner)

- A screen capture (or video) of S1, S5, S6, S8 (title, death-before-checkpoint,
  checkpoint activation, goal).
- A note on the audible cues (S2/S3/S5/S6/S8) — whether each cue was audible.
- The observed death counter values after S5 (1) and S7 (2), and the respawn
  positions (start X≈3 after S5; checkpoint X≈24 after S7).
- For S10: the network-recorder evidence that only the static server's relative
  paths are fetched.