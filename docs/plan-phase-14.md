# Phase 14 — Finishing the platformer toolset

Owner request, 2026-09-24 (after looking at the phase 9 result): build the
items phase 9 left out (its §6 decision log lists them), starting with a
character collider the owner can see, select and resize in the Scene view.
A session should be able to follow this file from top to bottom without
asking the owner anything; where a choice is needed, take the default given
here and record it in §6.

Read `docs/roadmap.md` first: its principles apply here — above all,
every feature and default is generic (for all potential projects), never
fitted to the Sprout demo; Sprout's own values live in Sprout's data. The
material node graph moved to phase 18 (after the WebGPU renderer phase 17).

## 1. Where things stand (2026-09-24)

- Phase 9 is done (`docs/plan-phase-9.md`, `docs/STATUS.md` row 9). Storage
  v4 is the only storage; v3 projects upgrade on open.
- The Sprout demo (`~/projects/sprout`) has two levels built by
  `art/scripts/levels/meadow_levels_build.mjs` over the HTTP command API; a
  headless bot plays both (`tests/integration/sprout-meadows`), and an
  opt-in live test checks the editor, Play, the export and re-bakes
  (`tests/e2e/sprout-live.e2e.ts`, `TL_SPROUT_LIVE`, `TL_SPROUT_BAKE`).
- **The player's collision capsule is not data.** It is hard-coded as radius
  0.3 m and half-height 0.6 m (1.8 m tall, 0.6 m wide) in several places
  (all listed in `docs/plan-phase-15.md` §7, including
  `platformer-game/src/constants.ts` and `runtime/src/runtime.ts`), e.g.:
  `packages/platformer/src/constants.ts` (`capsuleRadius`,
  `capsuleHalfHeight`), `packages/physics-rapier/src/port.ts`
  (`CAPSULE_RADIUS`, `CAPSULE_HALF_HEIGHT`) and
  `packages/runtime/src/blocks.ts` (`PLAYER_HALF_W`, `PLAYER_HALF_H`). The
  `controller` component is empty (`{}`) and a `collider` may not sit on the
  same entity, so the Inspector shows "absent" for collision on the player
  and on its model, and the Scene view draws nothing for it. Sprout is about
  1 m tall, so the capsule is far too big for him; spawns are placed 0.91 m
  above the ground to fit the 1.8 m capsule.
- Enemies, pickups, triggers, switches and game zones have `size` boxes that
  are drawn in the Scene view but can only be changed by typing numbers.

## 2. Owner decisions (2026-09-24) — do not re-ask

- The character's collision shape lives on the character (the entity with
  `controller`), is shown in the Inspector and in the Scene view, can be
  selected and resized there with handles, and every system (physics,
  platformer, gameplay blocks, spawn clearance, camera, bots) uses it.
- All the phase 9 leftovers below are wanted in this pass.
- Sprout gets a capsule that fits him, and the demo uses the new features
  where they make it better.

## 3. How to work

Same rules as `docs/plan-phase-9.md` §3 (read it, including **Traps**):
work the items in order; schema/commands first, then runtime/adapter/host,
then editor, exporter, tests, docs; every editor change gets a Playwright
test against a real backend; green = the literal `build: done`, `npx vitest
run --exclude '.claude/**' --exclude 'archive/**'` passing, touched e2e
passing, the full `npx playwright test` after each item; commit to `main`,
push, `sudo systemctl restart thirdlight`, tick §5, one or two lines in the
STATUS row 14. Never claim visual or audible results you did not observe:
say "owner look pending". Sprout: commit there, never push (the owner
pushes). Never print the owner token (`~/thirdlight/owner-token`).

Extra traps learned in phase 9:

- Vitest also collects tests inside `.claude/worktrees/*` (agent worktrees):
  always pass `--exclude '.claude/**' --exclude 'archive/**'`.
- An edit that changes nothing is refused with `no_change` (also in v4 now);
  scripts that re-send values must treat it as done.
- Playwright: a `canvas.click()` never gets "stable" under the fixed menu
  overlay of an export — click by coordinates (`page.mouse.click`).
- The Scene view's default camera looks down below the horizon; check sky
  orientation in Play, not in the Scene view.
- Headless Play on this server renders on the CPU (~4.5 fps): check Play in
  the local e2e backend or the static export, not over the live relay.
- A level-script rerun replaces entity ids, which makes the lightmap bakes
  stale: rebake with the opt-in live bake test afterwards.

## 4. Work items, in order

### 14.0 The character collider (owner's first request)

Data:
- `controller` gains an optional capsule: `controller: { capsule?: { radius,
  height, offset? } }` — radius 0.05–5 m, height (total, ≥ 2 × radius) 0.1–20
  m, offset [x, y] 0–±5 m from the entity origin (default [0, 0]: the
  capsule's centre at the entity position, as today). Absent = the current
  0.3 / 1.8 so every existing project plays exactly as before. Validator and
  canonical form in project-model (remember the canonicalizer trap),
  commands field lists (`commands/src/v3.ts`, `validate-content-args.ts`),
  MCP tool text.

Runtime and physics:
- Remove every hard-coded copy (see `docs/plan-phase-15.md` §7): the platformer, platformer-game, the runtime, the Rapier port
  (character creation, clearance probes, `placeCharacter`, the feet offset,
  one-way checks) and the gameplay blocks (player overlap box, stomp test,
  push-out, chase height) read the player's capsule from the snapshot.
  The physics port gets it through its init config (`character` gains
  `radius`/`halfHeight`); the game host passes it from the player entity.
- Spawn placement and respawn use the capsule (feet on the ground), so a
  smaller capsule does not float or sink.
- Enemies keep their `size` box (they are not capsule characters).

Editor:
- Inspector: the player entity shows a "Collision" section: capsule radius,
  height and offset fields, and a "Fit to model" button that sizes the capsule
  to the bounding box of the entity's model children (height = model height,
  radius = half the smaller of width/depth, clamped; feet at the model's
  lowest point). A child model shows "collides with its parent's capsule"
  instead of "absent".
- Scene view: the capsule is drawn as an outline (collider outline colour,
  under the Gizmos menu's collider switch) whenever the player is in the
  scene; it is selectable (clicking it selects the player). While the player
  is selected, handles on the capsule's top and sides drag height and radius
  (one undo step per drag, snapping with the snap toggle, Shift to not snap),
  like the mover waypoint handles of 9.12.
- The same handle editing for the other area components while their entity is
  selected: enemy `size`, pickup `size`, trigger/switch `size`, game zone
  `size`, box colliders (`hx`, `hy`) and fog volume `size`.

MCP/export: nothing new beyond the data; `tl_inspect` shows the capsule.

Tests: runtime/physics unit tests with a small capsule (walks under a 1.2 m
ceiling that stops the default capsule; lands with its feet on the ground;
stomp and pickup overlap use its size); e2e: select the player, drag the
capsule's top handle down, the stored capsule changes, one undo restores it,
Play shows the player walking under a low ceiling afterwards.

### 14.1 Scripts: spawn and destroy

- `ctx.spawn(prefabId, { position, rotation?, scale? })` (gameplay or
  transform phase) instantiates a project prefab into the running game (not
  into the project): fresh runtime ids `spawn-<n>`, colliders added to
  physics, models realized by the adapter, gameplay blocks registered (a
  spawned enemy patrols, a spawned pickup can be collected). Returns the
  new root id. `ctx.destroy(entityId)` removes a spawned entity (and its
  children); destroying authored entities is refused (use
  `ctx.game.setVisible`).
- Limits: 64 spawns per step, 1024 live spawned entities; a new run removes
  them all. Saves do not keep spawned entities (record in §6).
- Needs the prefabs in the snapshot/manifest (Play and export) — reuse the
  scene-set loading path of phase 12 (c) for adding entities at runtime.
- Tests: runtime unit tests; integration test with Rapier (a spawned crate
  blocks the player; a spawned coin is collected and counted; destroy frees
  its collider); an e2e script that spawns a projectile every second in Play.

### 14.2 Scripts: timers and sensors

- `ctx.timers.after(name, seconds)`, `.every(name, seconds)`,
  `.fired(name)` (true in the step it fires), `.cancel(name)` — deterministic
  (step-counted), ≤ 64 per script instance, reset on a new run.
- Trigger shapes: `shape: box | circle` (circle: `radius`); `stay` events:
  a trigger may emit its signal every step while the player is inside
  (`mode: enter | stay`). Scripts get `ctx.events` entries
  `{ type: 'enter' | 'exit', trigger: entityId }` for triggers they own.
- Tests per feature; e2e: a timed door script and a circle trigger in Play.

### 14.3 Score rules

- `content.flow.score`: points per counter (`{ coins: 10, gems: 50,
  defeated: 100 }`), a time bonus (points per second under a target time),
  shown on the HUD ("Score 1230") and on the level complete / end screens;
  best score per level kept in the save (9.11 already stores per-level
  memory). Game flow window: a Score section.
- Tests: host unit tests; e2e: collect coins in an export, the HUD and the
  level-complete screen show the score, a reload keeps the best score.

### 14.4 Per-level environment

- `content.flow.levels[].environment?`: a partial environment (sky, fog,
  post, wind) laid over the project environment while the level plays (the
  9.5 plan's per-scene override, done per level). Game flow window: "Level
  look…" opens the Environment editor for that level's override. The editor
  Scene view shows the override of the level the active scene belongs to
  (toggle "level look" beside "light: game").
- Also from 9.5: fog volume `heightFalloff` (density fades with height) and
  grading lift/gamma/gain.
- Tests: environment unit tests; e2e: level 2 with a different sky colour
  shows it in the export after level 1 completes.

### 14.5 Input and menus

- Gamepad rebinding in the settings screen, and the platformer reading the
  rebound pad buttons for move/jump (today it uses the fixed standard
  layout; `input` and `platformer`), saved with the settings.
- A `ui` sound bus with menu sounds (move, confirm, back) chosen in the Game
  flow window, volume in the settings screen.
- The title screen's background: any scene (`flow.title.scene`), default
  level 1's start as today, with an optional slow camera pan.
- Per-level ambience: `flow.levels[].ambience` (audio assets looped on the
  sfx bus while the level plays).
- Tests: input unit tests with a fake pad; e2e: rebind jump to pad button 3
  (Playwright gamepad emulation or the input test hook), jump works with it
  in Play; menu sounds reach the audio owner.

### 14.6 Animation

- A second animator layer with a bone mask (`layers[1]: { mask: [bone
  names], weight, states… }`) — e.g. attack with the upper body while running.
  Animator window: a layer tab and a bone picker from the model's skeleton.
- Animation-only GLBs: a model asset marked "clips for rig of <asset>" whose
  clips play on another model with the same bone names.
- Migrate the old `modelAnimation` idle/run/airborne component into an
  Animator controller on open (the old component keeps reading until then).
- Tests: runtime state machine with two layers; adapter masks bones; e2e:
  the live preview shows the upper-body layer.

### 14.7 Physics fixes

- A player pressing against a rising gate is lifted and wedged (phase 9
  known limit): a mover moving mostly upward next to the player pushes the
  player out sideways (away from the mover), never up, unless the player is
  above it. Integration test with the Sprout gate layout.
- A player spawn inside a one-way platform counts as blocked (9.9 known
  limit): one-way colliders are ignored by the spawn clearance test.

### 14.8 Storage leftover

- A replayed v4 acknowledgement has no `sceneId` (the retry record does not
  store it). Add `sceneId` to the v4 retry record result (a record format
  change: bump the record version, keep reading the old one), regenerate the
  `fixtures/commands` corpus, update scenario 01.

### 14.9 Sprout pass

- `meadow_levels_build.mjs`: the player's capsule fitted to Sprout (use the
  editor's "Fit to model" result, about radius 0.25, height 1.0), spawns at
  the new feet height; level 2 gets its own look (the golden-hour sky from
  `assets/env/sky/`); menu sounds and a meadow ambience generated by
  `art/scripts/audio/sfx_meadow_build.py` (extend it; keep the PCM WAV rules);
  score rules; use a spawned object where it helps (e.g. a boar that drops a
  coin when stomped).
- Rerun the script, the bot play-through (update the bot for the smaller
  capsule), the live bake test and the live editor/Play/export test; record
  times and deaths in §6. Commit in Sprout (not pushed).

### 14.10 Wrap-up

- `docs/STATUS.md` row 14 done (owner look pending where visual/audible),
  `docs/deployment.md` sections for every new feature, the MCP tool text,
  the auto-memory phase-state file.

## 5. Progress (tick as you go)

| Item | Status | Commits |
|---|---|---|
| 14.0 character collider + handle editing | done 2026-09-24 | 81dea18 |
| 14.1 spawn / destroy | todo | |
| 14.2 timers, sensors | todo | |
| 14.3 score rules | todo | |
| 14.4 per-level environment, fog height, lift/gamma/gain | todo | |
| 14.5 pad rebinding, UI sounds, title scene, ambience | todo | |
| 14.6 animation layers, animation-only GLBs, modelAnimation migration | todo | |
| 14.7 physics fixes (gate lift, one-way spawn) | todo | |
| 14.8 replayed ack sceneId | todo | |
| 14.9 Sprout pass | todo | |
| 14.10 wrap-up | todo | |

## 6. Decision log

Add one dated line per decision taken during the run (what, why).

- 2026-09-24 (14.0): the capsule is v4-only data (`controller.capsule {radius, height, offset?}`); v3 scenes refuse it — v3 projects upgrade to v4 on open, and the other phase 9 fields are v4-only too.
- 2026-09-24 (14.0): positions stay the entity origin everywhere (transform, motion segments, spawn markers, `placeCharacter`, the physics port's reported position); the capsule's centre is origin + offset, applied inside each consumer — so an absent capsule (offset 0) computes exactly what the old constants did and every recorded replay stays valid.
- 2026-09-24 (14.0): "spawn and respawn put the feet on the ground" is done through the offset, not a new spawn rule: the origin goes to the spawn marker as before, and the top-handle drag keeps the capsule's bottom fixed (the offset follows), so a smaller capsule keeps its feet where they were; with the offset at half the height the origin is the feet and a spawn on the ground stands on the ground. Changing what a spawn marker means would have moved every existing spawn.
- 2026-09-24 (14.0): the default lives once, in project-model (`DEFAULT_CONTROLLER_CAPSULE`, 0.3 / 1.8: an adult human); the runtime derives the half-height nanometre-rounded (1.8/2 − 0.3 is exactly 0.6, the blocks' half height exactly 0.9) so the default is bit-identical to the old constants. physics-rapier keeps a fallback (`DEFAULT_CAPSULE_*`) only for callers that pass no capsule (tests); the hosts always pass the player's. The platformer's `CONTROLLER_CONSTANTS` and platformer-game's `CAPSULE_*`/`RUN_LIMITS` capsule fields are gone; `zoneOverlap`/`stepZones` take the capsule.
- 2026-09-24 (14.0): the camera keeps following the player's origin (unchanged framing for every existing project); a game that wants it on the capsule's centre sets the offset accordingly.
- 2026-09-24 (14.0): size handles snap sizes to 5 cm (`SNAP_SIZE_M`; the waypoint handles snap positions to the 0.25 m grid — a size needs a finer step to fit a small character); Shift or the snap toggle turn it off. Handles show for the selected object regardless of the Gizmos switches (they are editing tools); the capsule outline follows the collider switch.
- 2026-09-24 (14.0): top-handle drags keep the bottom fixed for the capsule and the enemy box (both stand on their feet) and keep the centre for centred boxes (trigger, switch, pickup, game zone, box collider — in its own rotated frame — and fog volume, whose depth is kept). The existing game-zone corner handle stays. A pickup without an explicit size has no handles (its area is not drawn either).
- 2026-09-24 (14.0): the Scene view drew an enemy's area centred on its position; the runtime tests it standing on the position (feet). The outline now matches the runtime.
- 2026-09-24 (14.0): clicking the capsule outline (within ~6 px) selects the player before any model drawn over it; clicking inside the capsule selects the player only when nothing else is hit, so the player's child models stay selectable.
- 2026-09-24 (14.0): "Fit to model" measures the player's own model and every child model instance as the Scene view draws them, relative to the origin; offset x is the box's centre, radius half the smaller of width and depth, all clamped to the capsule ranges; with no loaded model it reports that instead of guessing.
- 2026-09-24 (14.0): e2e fixture: the engine sample (Beacon Reach) with a neutral low ceiling added by command, as `blocks.e2e.ts` does; no Sprout data.
