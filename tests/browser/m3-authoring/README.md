# Packet 56 — gameplay & camera authoring: real-backend browser verification

**Status in this container: UNVERIFIED.** There is no browser here (packet 38
baseline §1: the in-container browser has software WebGL2/DOM/network but no
display; nothing in this directory was rendered). Every browser statement of
packet 56 — the rendered zone overlay, the placement gestures, the panel
forms, the real-backend authoring convergence below — is **UNVERIFIED** until
the owner runs this procedure. The verified halves are the pure planning/gesture
layers in Node:

- `packages/editor/src/session/gameplay.test.ts` — the 6-key settings registry
  (bounds + cross-field rule), the game-config form parse (string bounds, ID
  syntax, level rules), the reference preflight (controller / camera+
  cameraFollow / spawn / ≥1 goal / ≤1 checkpoint), `setGameConfig` planning
  (create = complete block with null cues; edit = changed fields only; cues
  never touched), zone create/edit plans (the checkpoint field rules, the
  two-step checkpoint role switch), camera-follow parse/plan.
- `packages/editor/src/session/zone-gesture.test.ts` — the gesture's
  observable contract: zero decisions during the drag, one on a committing
  release, zero on cancel; the bounded `revision_conflict` rebase (≤ 1, move
  only); the negligible-drag create fallback (default size at the anchor); the
  unplannable checkpoint create decides nothing.
- `packages/editor/src/session/projection.test.ts` (v3 block) — hydration and
  change convergence for `gameZone` / `playerSpawn` / `cameraFollow`, and the
  `setGameConfig` / `applySurfacePreset` revision advancement.

`dist/editor/index.html` (the workspace build output) is the host page — the
editor bundle with the config injected at build time. No separate host bundle
is needed; the checks below are performed on the real editor against a real
backend.

## Procedure (owner desktop)

Prerequisites: Node 22, a Chromium/Firefox with WebGL (software WebGL2
counts), the repository built, a fresh project in the backend's data root with
an `authoring:<projectId>` token (the backend deployment procedure,
sessions.md §13.7 — the m2-play README shows the exact environment-variable
invocation).

1. From the repository root:

   ```sh
   npm run build
   THIRDLIGHT_PROJECT_ID=<projectId> \
   THIRDLIGHT_EDITOR_TOKEN=<authoring-token> \
   THIRDLIGHT_PREVIEW_ORIGIN=http://127.0.0.1:8502 \
   npm run build        # re-emit dist/editor/index.html with the injected config
   ```

2. Start the backend with the project and the token on the authoring origin
   (per the deployment env), then open `http://127.0.0.1:8501/` (the exact
   origin must be in `THIRDLIGHT_AUTHORING_ORIGINS`). The editor establishes,
   hydrates the scene, and shows the Hierarchy + Inspector + **Gameplay**
   panels (the new M3 panel with the Game / Zones / Camera / Settings tabs).

3. Author a minimal playable game **through the UI only** (the packet's
   authorability rows, authoring.md §A8):

   - Hierarchy: create the player box (add the `controller` component), the
     camera entity (add `cameraFollow` via the Camera tab), a spawn (Zones
     tab → Spawns → Add at origin, or arm the spawn tool and click the
     viewport), a `goal` zone (Zones tab → Add at origin or the viewport
     tool), a `hazard` zone, and a `checkpoint` zone (select its safe spawn
     first — the arm button is disabled without one).
   - Game tab: fill title / objective / instructions, pick the player /
     camera / spawn, set the level bounds + killY, **Save** → the
     `setGameConfig` command lands.
   - Camera tab: pick the camera entity, set the dead zone / smoothing /
     bounds, **Save** → `setComponent(cameraFollow, …)`.
   - Settings tab: change `run_speed` (e.g. 5) and **Save** →
     `setSettings` with only the touched key.

4. Record the evidence table below. For every check, capture the devtools WS
   frames (command → `mutationApplied` change) plus a screenshot of the panel
   + viewport state into `docs/acceptance/evidence-m3/56/`, and record the
   browser/OS/version.

## Checks and what to record

| # | Check (the packet's failure modes + convergence) | Record |
|---|---|---|
| Z1 | **Zone placement in the viewport**: arm the hazard tool, drag an extent on the game plane — one local preview during the drag (zero WS traffic), exactly one `createEntity` with `components.gameZone` on release; a plain click places the default-size zone at the anchor | WS frames + screenshot |
| Z2 | **Zone move/resize**: drag a zone body (one `setTransform`), drag the selected zone's SE handle (one `setComponent(gameZone, {size})`); Esc mid-drag reverts the preview and sends nothing; the Hierarchy/Inspector never shows a transform edit for a zone from the panel (the overlay owns it) | WS frames + screenshot |
| Z3 | **The checkpoint rule**: a checkpoint zone always carries `safeSpawnId` + `activation` (the default activation appears at add time); switching a checkpoint to another role issues the two-step remove/re-add (two `setComponent` frames, two undo entries); the game-config save is refused while a second checkpoint exists (the preflight error lists it) | WS frames + the error text |
| Z4 | **Game config create + edit**: the first Save sends the complete block (cues all null); a later title-only Save sends `{title}` only; Remove sends the removal; reopening the editor (fresh page load) shows the authored title/objective/level — the block survived a full resync | WS frames + two page loads |
| Z5 | **Invalid references/coordinates**: point `playerId` at a non-controller, `cameraId` at an entity without `cameraFollow`, remove the last goal and Save — each is refused by the preflight (the panel lists the errors, no command is sent); type `minX > maxX` / a non-finite killY / a 65-char title — the same, at parse time | the panel error text, zero WS commands |
| Z6 | **Duplicate roles / illegal deletions**: with the game config present, try to delete the only goal, the referenced spawn, or the camera entity — the backend rejects with the structured error and the editor shows it; the failed edit preserves the prior state (the entity is still there after the error is dismissed) | the error text + the Hierarchy state |
| Z7 | **Stale MCP edits during a gesture**: in a second client (the MCP adapter over stdio, or a second editor session), move the zone while a gesture is in flight — the commit returns `revision_conflict`; the editor rebases **at most once** (the zone ends at the MCP's new position + the user's delta) and explains a second conflict in the panel instead of retrying | two-client WS trace + screenshot |
| Z8 | **Disconnect/resync + ack-loss**: drop the editor's WS mid-session (devtools offline toggle or kill/restart the backend's connection) — the projection flags stale, the full resync re-hydrates the scene **and** the game-config block (`queryGameConfig` on establish), and a pending unacked command is retried exactly once with its original `requestId` (duplicate responses dedupe, no double mutation) | WS trace (requestId equality) + the resync frame |
| Z9 | **MCP/browser convergence**: apply an MCP `setComponent` (a new hazard zone) and an MCP `setGameConfig` title change from the second client — the open editor's overlay + Game tab converge without a reload (the change records update the projection exactly like a browser-origin edit; sessions.md §6.2) | before/after screenshots |
| Z10 | **Undo/redo**: undo each of the authored mutations (zone creates, the game-config save, the camera follow, the settings) — each restores the prior state; redo re-applies; the revision is monotonic and the overlay tracks every step | the revision sequence |
| Z11 | **Screenshot**: save the final authored scene (zones + spawn marker + camera bounds + the Gameplay panel) as `m3-authoring-evidence.png` (SHA-256 recorded) | the PNG + its digest |

## Explicitly not claimed here

- no packet-56 run rendered the overlay (no browser in the container);
- no physical pointer gestures were executed (the gesture DECISIONS are the
  Node-verified pure layer; the pointer → world-plane conversion is the
  three.js raycast, exercised only in a browser);
- the media panel's cue pickers and the checkpoint activation appearance are
  packet 57's surface (this packet's cue fields stay null and the activation
  is the default);
- nothing here runs the authored game — the play path is the export/runtime
  packets' evidence (the authoring packet proves the project is authored, not
  that it plays).