# Phase 23 — 3D game foundations

Goal: close the engine gaps a 3D game needs — 3D movement and collision,
cameras, pointer input and 3D queries, block layers for level building,
project UI, game modes, dialogue, a sequencer and the rest — so a game in a
different genre from the platformer demos can be built on Thirdlight without
being gated. Read `docs/roadmap.md` (principles) first.

Source of the gap list: the Skyforge Tactics dogfooding project,
`~/projects/skyforge-tactics/docs/engine-gaps.md` (rev. 2, 2026-09-26; gap ids
E1–E18 below refer to it). Skyforge is a **consumer**, like Sprout: every item
here is a generic capability; Skyforge's rules, shaders, screens, values and
maps are its own project content, and its acceptance checks (Thistledown, the
tea-with-Bram conversation, the refusal scene) run in the Skyforge repo, not
in Thirdlight's tests. Thirdlight tests use neutral fixtures.

## 1. Where things stand and why this order

- The engine renders 3D, but the simulation is 2D: physics is
  `@dimforge/rapier2d-compat`, runtime ports use x/y vectors, overlap shapes
  are 2D boxes/circles and rotation is one angle derived from the z/w
  quaternion (`runtime/src/ports.ts`). That was a demo-shaped foundation the
  phase 15 defaults audit did not catch (it audited values, not
  dimensionality) — see the decision log. E1, E2, E3 and E8 all sit on it, so
  **23.0 settles the dimensional model first**.
- The slice is staged S1–S6 in Skyforge's `docs/slice-plan.md`. Items are
  grouped into tranches A–F so each tranche unblocks one stage and the
  consumer can progress while later tranches are built.

## 2. Decisions

- **3D is a first-class simulation, 2D is a plane in it.** A per-project
  `physics.dimension: 'plane2d' | '3d'`. Runtime ports move to 3D vectors and
  quaternions; `plane2d` keeps today's behaviour exactly. Existing 2D projects
  (Beacon Reach, Sprout, fixtures) and their recorded replays stay
  byte-identical — a test pins it. 23.0 decides the concrete mechanism
  (one port with two Rapier backends vs. one 3D backend constrained to a
  plane) and logs it.
- Determinism and replay hold for everything new: pointer samples, UI events
  and camera state that feeds screen rays live in the simulation step.
- Engine defaults are genre-neutral with a reason next to them (e.g.
  step-up 0.3 m: "a stair riser"), never Skyforge's values.
- Everything a designer tunes is data with Inspector fields and Scene
  handles (principle 2); new assets get a document tab (phase 16 framework).
- Project UI: DOM/CSS UI documents drawn by the game host (recommended
  default; 23.9a confirms and logs). Scripts publish view-model values from
  the worker per step; UI events come back as input-frame entries.

## 3. Work items

### Tranche A — unblocks S1 (walk a graybox)

#### 23.0 Dimensional model (E1 base)
- Spike and decide: add `@dimforge/rapier3d-compat` pinned to the same
  version as the 2D package; choose the port shape; make runtime vectors and
  rotations 3D with `plane2d` as a constraint.
- Prove: rapier3d deterministic across runs and in the simulation worker
  (phase 22); 2D replays unchanged; bundle size and step cost measured with
  the phase 21 harness.
- Done when: the decision is logged, `physics.dimension` exists as data,
  the 3D backend steps a trivial scene deterministically in Play and export,
  and every existing 2D replay/test is green.
- **Design (main session, 2026-09-26, from the 2D-seam survey):**
  - **Two backends, not one constrained world.** A rapier3d world locked
    to a plane cannot reproduce rapier2d's f32 results (different
    narrow-phase, capsule maths, character-controller internals), so
    `plane2d` keeps the existing rapier2d adapter untouched — byte-identical
    by construction. `3d` is a new adapter on
    `@dimforge/rapier3d-compat@0.20.0` (same version as the 2D pin), in
    `physics-rapier` behind its own subpath export (`./3d`) so 2D preview
    and export bundles never carry the 3D WASM. Module id
    `thirdlight.physics-rapier:3d`, next to `:2d`.
  - **A separate 3D port type**, `PhysicsPort3D` (Vec3 + quaternion), in
    the runtime next to today's `PhysicsPort`; the runtime holds one or the
    other, chosen by the setting. The 2D port, its fakes, the platformer
    controller, the graph codegen and the public script `.d.ts` stay as they
    are (Sprout's pinned behavior output digests must not move). In 3D the
    runtime commits the full position (not only `[0..1]`) back to the
    transform.
  - **Setting:** optional engine setting `physics_dimension`, values
    `[2, 3]` with labels "2D plane" / "3D", absent = 2 — the same mechanism
    as `sim_thread` / `render_backend`, so settings, manifest, buildId and
    replays of every existing project stay byte-identical. Shown in project
    settings through its descriptor.
  - **3D collider data (additive):** collider `box` gains optional `hz`;
    absent keeps today's canonical bytes. In a 3D project a box without `hz`
    is a validation problem (no silent guessed depth). 3D colliders take the
    entity's full rotation; the z-only rotation rule stays for `plane2d`.
    Box Scene handle becomes 3-axis when `hz` is present. Controller capsule
    `offset` gains an optional third component. Other 3D shapes, mesh
    colliders and triggers are 23.1.
  - **3D character in 23.0:** the existing controller capsule as a Rapier
    kinematic character controller with the existing tuning (slope, snap,
    autostep, skin) and gravity along −Y, no movement input yet — it falls
    and rests. Movement, input and the full settings are 23.2.
  - **Hosts:** preview page, simulation worker and export load the 3D
    backend only when the setting is 3; exporter allow-list, probe and
    license rows, `tools/check-deps.mjs`, `tools/check-boundaries.mjs`, and
    a decision record `docs/decisions/0005-3d-physics.md` for the pin.
  - **Bug found in the survey, fixed first as its own commit:** 2D
    colliders collide unrotated while the editor draws them rotated. The
    collider has no `rotationZ` field; every consumer reads
    `collider.rotationZ ?? 0`, so physics always gets 0. Fix: pass the
    entity's z-angle. Only scenes with rotated colliders change; list any
    fixture or replay that moves in the decision log.
  - **Tests:** unit tests for the 3D adapter (a capsule falls and rests on
    a box, rotated box, raycast); an integration test proving a neutral 3D
    scene gives identical step digests over two runs and page vs worker;
    every existing 2D suite unchanged and green; e2e: Play and the static
    export of a neutral 3D fixture where the capsule lands on a box,
    observed through the game-observe path, on both Playwright projects.

#### 23.1 3D physics world, static colliders, triggers (E1)
- Static colliders from level geometry, `_COL` nodes and primitive
  components; 3D trigger volumes (box, sphere, capsule) feeding the existing
  trigger/signal system.
- Lift the rule that scripts may not own entities with a collider or
  controller (`runtime/src/behavior.ts`), driving them through intents.

#### 23.2 3D kinematic character controller (E1)
- Built on Rapier's kinematic character controller: walk/run speed, ground
  snap, slope limit, step-up height, optional short ledge climb. Kinematic
  only. All settings data with handles; deterministic under
  `tl_input_exercise` replay.

#### 23.3 Pointer input and 3D queries (E3)
- Pointer actions in action maps (position, delta, buttons, wheel,
  hover/click edges); cursor free/locked, auto-hidden while a gamepad drives.
- Script queries: raycast, sphere/box overlap, screen-point ray from the
  active camera, tag/layer filters. Pointer samples recorded per step for
  replay.

#### 23.4 Camera framework (E2)
- Virtual camera component with priority; rigs: follow/orbit (distance,
  pitch limits, player-rotatable, collision pull-in), orbit-around-point
  (snapped yaw, zoom, tilt), top-down, fixed/look-at, path/rail.
- Blends: cut, linear, eased. Shake; letterbox as an overlay property.
  `ctx.camera` (activate, set params/target, screen↔world). The active camera
  is resolved in the simulation so screen rays replay identically.

#### 23.5 Block layers — core (E8)
- Block definitions as content: mesh/prefab, collision shape (full, half,
  ramp, stairs, custom, none), footprint, allowed rotations, default cell
  metadata, weighted variants.
- `blockLayer` component: cell size per axis, origin, bounds; sparse chunks
  (16×16 columns), one diff-friendly JSON file per chunk; several layers per
  scene incl. metadata-only layers.
- Project-defined cell metadata schema (bool, enum, int, float, string),
  block defaults + cell overrides, metadata-only cells, named regions.
- Rendering: instanced/merged per block type per chunk, hidden-face removal,
  frustum culling and LOD per chunk, lightmap baking works.
- Collision: merged per-chunk colliders into 23.1, rebuilt incrementally.
- `ctx.grid`: cell get/set/clear (render, collision and queries updated in
  the same step), column top, world↔cell, metadata read/write, pick from a
  ray (cell + face normal), neighbours, regions by name, change events,
  runtime diff for saves. Deterministic.
- Commands (so `tl_command` works): fill region, set cells from array,
  paint metadata, place stamp, import heightmap; `tl_content_query` reads
  cells and regions.

#### 23.6 Block layers — editor (E8)
- Grid display with movable height slice; brushes: single, line, rectangle,
  box fill, flood fill, raise/lower column, erase, eyedropper,
  replace-all-of-type; rotate brush, randomize variants.
- Metadata paint mode with a colour-coded overlay per field and toggles;
  select/move/copy/paste/mirror; stamps; visibility and lock per layer; undo
  through the normal command path.
- Props snap to cell tops and can declare an occupancy footprint that writes
  metadata. Snapping becomes configurable (today fixed in
  `editor/src/session/snapping.ts`).
- Target: interactive at 64 × 64 columns × 16 height steps.

#### 23.7 Scripting conveniences (E13)
- Shared script libraries importable by any behavior, compiled once;
  seeded replay-safe `ctx.random` with sub-streams; entity queries by name and
  component; quaternion/facing helpers on pose/transform intents.

#### 23.8 Test and debug entry points (E16)
- `tl_play_start` with scene, mode, injected variables or a save document;
  project-registered debug commands callable from `tl_game_control` and an
  in-game console.

### Tranche B — unblocks S2 (battle core)

#### 23.9a Project UI — runtime (E4)
- UI documents: anchors, stacks, grids, 9-slice, project fonts, inline rich
  text (colour, bold, icon glyphs), bars/gauges; view-model binding across the
  worker boundary; events back to scripts; focus navigation for keyboard and
  gamepad, pointer hover/click, input-map switching while UI has focus;
  world-anchored widgets with off-screen clamp; tweens (fade, slide, scale,
  stamp); projects can replace or extend title, pause and settings screens.

#### 23.9b Project UI — editor (E4)
- A UI document tab with live preview and handles.

#### 23.10 Game modes (E5)
- `content.modes`: active input maps, camera, UI documents, ticking behavior
  groups; `ctx.modes.switch` with enter/exit hooks and no scene load. The
  closed `FlowScreen` set becomes engine-provided modes; menus can still use
  the engine pause.

#### 23.11 Sockets and animation speed (E14)
- Attach/detach an entity to a named bone or node of another model at
  runtime with an offset; per-instance playback speed from scripts; morph
  target weights (optional).

#### 23.12 Runtime material parameters (E9)
- Set material graph parameters per entity from scripts (float, vec, colour,
  texture ref); a small data-texture parameter (e.g. 64×64 RGBA8) scripts can
  write.

#### 23.13 Script audio and 3D audio (E12)
- Playback handles (stop, fade, loop, pitch, volume, finished event); music
  crossfade/stinger/duck from scripts; 3D panner with distance models and the
  listener on the active camera.

### Tranche C — unblocks S3

#### 23.14 Input rebinding API and glyphs (E11)
- List every action with bindings, listen-for-input rebind, conflict
  detection, reset; bindings per player profile; hold modifier; last-active
  device detection; action → glyph lookup. The screen itself is game content.

#### 23.15 Lighting inputs in the material graph (E10; P0 by S5)
- Input nodes: main directional light direction/colour, accumulated diffuse
  split into terms, shadow attenuation, ambient/hemisphere; a custom-lit
  output that still gets fog and tone mapping.

### Tranche D — unblocks S4

#### 23.16 Dialogue with voice (E6)
- Dialogue asset (lines with speaker, expression, voice clip; choices;
  conditions/effects on project variables; jumps; signals); speaker registry;
  voice bus with automatic ducking; auto-advance per line/global; advance,
  skip-if-seen, backlog, text speed, instant reveal, mid-line pauses; default
  dialogue UI on 23.9a that projects reskin or replace; line/choice events for
  scripts and 23.17; room for string tables; a previewer tab that plays with
  portraits and voice outside Play.

#### 23.17 Sequencer and timeline (E7)
- Timeline asset with tracks: camera, transform, animator, audio, dialogue,
  effects, entity activation, signals, fade/letterbox, wait-for-input;
  entities bound by reference; play/pause/skip from scripts, skip applies each
  track's end state; a timeline tab with scrubbing. Runs as an engine system;
  scripts wait on its signals.

### Tranche E — unblocks S5

#### 23.18 Runtime environment changes (E17)
- Switch or blend environment presets (sky, fog, light colour/intensity,
  grading) from scripts and the sequencer.

### Tranche F — unblocks S6

#### 23.19 Project-defined save documents (E15)
- Project save document with versioned migrations; configurable slot count;
  slot metadata (chapter, location, play time, image); a project settings
  document; a larger size cap.

#### 23.20 Wrap-up
- Budgets for block layers (a 40 × 40 × 12 map at 60 fps on WebGPU, a few
  draw calls per chunk) in the phase 21 harness; leak re-sweep; docs.

### Not in this phase (backlog)
- E18 asset-pipeline import; E8 should-haves (autotiling, map validation in
  Problems, per-vertex block AO, grid graph/A* helpers); `side: back`
  materials; sub-step input timestamps.

## 4. Order and parallel work

23.0 → 23.1 → 23.2 → 23.3 strictly. After 23.0: 23.4, 23.5, 23.7, 23.8 in
parallel worktrees; 23.6 after 23.5; 23.5 collision after 23.1. Tranche B:
23.9a before 23.10 and 23.16; 23.11–23.13 independent. Rules of
`docs/roadmap.md` "How every phase is worked" apply (tiered gate, Playwright
for editor items, commit/push/restart, decision log).

## 5. Progress

| Item | Status |
|---|---|
| 23.0 Dimensional model | done 2026-09-26 — two backends (rapier2d untouched for plane2d, rapier3d 0.20.0 for 3d), `physics_dimension`, box `hz`, PhysicsPort3D; 2D rotated-collider bug fixed (no pinned values moved) |
| 23.1 3D physics world, colliders, triggers | done 2026-09-26 — sphere/capsule/hull/mesh colliders (3D), `_COL`/model-derived colliders stored as data, 3D triggers, kinematic movers carry, scripts may own colliders in 3D; gameZone/respawn in 3D wait for 23.10 |
| 23.2 3D character controller | done 2026-09-27 — built-in module `thirdlight.character3d:controller` (walk/run, accel, air control, jump, slope, step-up, optional ledge climb, facing), camera-relative input, `ActionFrame.moveY`, script intents |
| 23.3 Pointer input and 3D queries | in progress |
| 23.4 Camera framework | done 2026-09-26 — `virtualCamera` (follow/orbit, orbit-point snapped, top-down, fixed/look-at, rail on `cameraPath`), priority + cut/linear/eased blends, seeded shake, letterbox, `ctx.camera` + VS nodes; brain in the sim step; `depth_buffer` setting; owner look pending |
| 23.5 Block layers — core | done 2026-09-27 — block types, schema-driven cell fields, stamps, chunked per-file storage, `editBlocks` bulk ops incl. heightmap, merged chunk meshes with hidden-face removal, per-chunk trimesh colliders, `ctx.grid`; block-layer lightmaps and chunk LOD not done |
| 23.6 Block layers — editor | planned |
| 23.7 Scripting conveniences | done 2026-09-26 — `@lib/<id>` shared libraries (recompile dependents atomically), `.json` imports, seeded `ctx.random` + streams, `ctx.world.find/findAll/withComponent`, quaternion/facing on intents |
| 23.8 Test and debug entry points | done 2026-09-26 — one Play-start path (editor "Play from…" and `tl_play_start`: scene, variables, save/slot, mode noted until 23.10); `ctx.debug.command` on input frames, `tl_game_control debugCommand`, in-game console (exports only with `debug_console`) |
| 23.9a Project UI — runtime | in progress |
| 23.9b Project UI — editor | planned |
| 23.10 Game modes | planned |
| 23.11 Sockets and animation speed | planned |
| 23.12 Runtime material parameters | planned |
| 23.13 Script audio and 3D audio | planned |
| 23.14 Input rebinding API and glyphs | planned |
| 23.15 Lighting inputs in the material graph | planned |
| 23.16 Dialogue with voice | planned |
| 23.17 Sequencer and timeline | planned |
| 23.18 Runtime environment changes | planned |
| 23.19 Project-defined save documents | planned |
| 23.20 Wrap-up | planned |

## 6. Results and decision log

### Decision log

- 2026-09-26 (owner): finish all of phase 23 in one autonomous run. Worktree agents in parallel waves of about three (host load); one `tools/gate.sh full` may cover a batch of merged items before they are ticked.

- 2026-09-26 (owner): phase 23 approved from the Skyforge gap list; one
  phase in tranches A–F. Charter scope widened from "2.5D platformer proving
  ground" to 3D games of any genre.
- 2026-09-26: **miss recorded.** A 2D-only simulation (rapier2d, x/y ports,
  single-angle rotation) in an engine that was always 3D is exactly the
  demo-shaped foundation roadmap principle 1 forbids; the phase 15 defaults
  audit checked values, not dimensionality or genre assumptions in APIs.
  Principle 1 now names dimensionality and API shape explicitly.
- 2026-09-26 (23.0): **2D collider rotation fixed** — one shared helper,
  `staticColliderOf` / `colliderRotationZ` in `runtime/src/scene-set.ts`
  (2·atan2(z, w) of the entity quaternion, exactly 0 for the identity), is
  now used by scene loads, the Play preview, the export bootstrap, the perf
  harness and the render probe instead of four copies reading the
  nonexistent `collider.rotationZ`; a mover's kinematic pose keeps its
  entity's angle too (it was reset to 0 every step). Values changed: none —
  no fixture, template, replay or Sprout scene has a rotated collider (a
  scan of every JSON document found only two validation cases in
  `fixtures/m2/contracts/physics/numerics.json`, which never reach physics);
  the physics course fixtures carry `rotationZ` directly and were already
  right. All pinned suites stay unchanged.
- 2026-09-26 (23.0): **setting and 3D collider data.** `physics_dimension`
  is an optional engine setting (values 2 "2D plane" / 3 "3D", absent = 2)
  in the settings registry and `M3_OPTIONAL_SETTINGS_KEYS` (before
  `sim_thread`, registry order), read through `physicsDimensionOf`; it is
  not added to the `GameplaySettings` interface, so the public script
  `.d.ts` and the graph node list stay byte-identical. Box colliders take
  an optional `hz`, the capsule `offset` an optional third component (the
  canonicalizer keeps both; absent keeps the old bytes); a 2D plane ignores
  them (the runtime's `staticColliderOf` drops `hz` before the untouched
  rapier2d adapter sees the shape).
- 2026-09-26 (23.0): **where the dimension rules live.** A scene document is
  validated without the content block, so for v4 documents the rotation
  rules moved from per-entity validation to the cross-document composition
  (`composeSceneV4` for scene entities, `composeV4` for prefab entities),
  which every command, project load and `setSettings` passes through:
  2D keeps exactly the old errors (rotation about Z only, controller
  upright); 3D allows any collider rotation, keeps the controller upright,
  and refuses a box without `hz` and a polygon collider (3D shapes are
  23.1). Switching a project to 3D is therefore refused until its boxes have
  a depth. v2/v3 documents keep the rule in place.
- 2026-09-26 (23.0): **editor.** `hz` is an Inspector field (via its
  descriptor); the collider's box handle binds `halfZ` too and becomes a
  3-axis box that follows the whole rotation once `hz` is set (kind stays
  `box2`, a new role set `halfX/halfY/halfZ`); the capsule offset descriptor
  is a `vec3` with the new `optionalLast` flag (`[x, y]` stays valid and
  shows z = 0; a capsule drag keeps a stored z).
- 2026-09-26 (23.0): **port and adapter.** `PhysicsPort3D` (runtime
  `ports.ts`) carries `dimension: 3` as the discriminant; its vector types are
  named `PhysicsVec3` / `PhysicsQuat` (project-model already exports
  tuple-typed `Vec3`/`Quat`). The 3D character phase lives in the runtime
  (gravity along −Y from `gravity_y`, capped at `max_fall_speed`, zeroed on
  landing or a head bump; a module-staged move replaces the fall) because no
  controller module drives a 3D character before 23.2. The adapter mirrors
  the 2D pattern (parentless capsule, `computeColliderMovement`, the double
  kept as the authoritative position) and runs one pipeline update at
  creation and after collider adds/removes so the first sweep and rays see
  the colliders. Kinematic movers, overlap queries and clearance/respawn are
  not in the 3D port yet (23.1–23.3).
- 2026-09-26 (23.0): **scene mode steps 3D physics.** A 3D scene plays
  without a game block (the platformer game set is refused in 3D until
  23.10), i.e. on the runtime's plain step path, which never stepped physics;
  it now runs the 3D phase there when the port is 3D (the 2D scene mode is
  unchanged). Measuring it showed that path cloning every transform per step
  (~0.5 KB/entity/step, 515 KB/step at 1,000 entities); it now reuses the
  phase 21.2 step buffers (≈8 KB/step, flat).
- 2026-09-26 (23.0): **observing a scene.** `tl_game_observe` answered only
  for a game (it needs the game view), so a 3D scene could not be observed:
  the host gained `observeScene()` and the relay reports a scene play as
  `state: "scene"` (added to the closed run-state set) with its step and
  `player {x, y, z}` (every observation's player now carries `z`). The
  static export has no relay; it exposes the same host observation as
  `window.__thirdlightObserve()` (the e2e reads it with the backend stopped).
- 2026-09-26 (23.0): **distribution.** The play/export bundles are IIFE
  (no code splitting), so the 3D backend is its own script (`physics-3d.js`)
  that registers on the global object through game-host's dependency-free
  `./physics-3d-global` subpath; `loadPhysics3D` loads it with a script
  element in the page or `importScripts` in the worker (next to the worker's
  own script). The export builds, gates and ships it — and the rapier3d
  license row and probe — only when the resolved modules contain
  `thirdlight.physics-rapier:3d`. Measured sizes and step costs are in
  decision 0005 §5. (npm's hidden lockfile `node_modules/.package-lock.json`
  of the main checkout was rewritten through the worktree's hardlinked copy
  by the install; `npm ci` after the merge regenerates it.)
- 2026-09-26 (23.4): **virtual cameras beside the scene camera, not instead of it.** A `virtualCamera` component (v4, any entity; not on the scene camera: it excludes `camera`/`cameraFollow`) is a shot; the scene camera entity keeps its transform and its `cameraFollow` module exactly as before and is the fallback view ("base") when no virtual camera is enabled. So existing projects (no virtual camera) are byte-identical — nothing steps, no digest, observation or frame field changes — and "follow → orbit" works both from a `cameraFollow` and from a follow rig. Rig types are one component with a `rig` enum (follow, orbitPoint, topDown, fixed, rail) and `when`-conditioned fields rather than five components: one priority/blend/lens vocabulary, one Inspector section, and a script changes a rig's values without knowing its type.
- 2026-09-26 (23.4): **resolution and blends.** Live = the enabled camera with the highest priority; ties go to the one `activate`d last, then load order (Cinemachine's rule; `activate` enables and bumps). A change blends from what is on screen: from the previous camera still moving (or the base view) when no blend runs, from the frozen blended pose when a blend is interrupted or its source left. The blend is the incoming camera's (`blend`, `blendTime`), the outgoing camera's when going back to the base view, or the one the script passes with `activate`/`deactivate`. Position/lens/letterbox lerp, rotation slerps; eased = smoothstep. Blends, snapped turns and shake impulses count whole steps (`round(seconds·hz)`), so they end exactly and replay bit for bit.
- 2026-09-26 (23.4): **the brain runs in the simulation.** `CameraBrain` (runtime `camera-brain.ts`, pure maths in `camera-rig.ts`, no three.js) steps at the end of every fixed step after the camera phase — plain (scene-mode) and phased steps alike — only while a virtual camera is loaded. It keeps prev/curr poses; the renderer applies the pose interpolated with the step alpha (`Runtime.readCameraView`), and the worker sends it per frame (`FrameState.cam`) with the committed view. The resolved camera is part of the step digest (only when a brain exists). Input: only the live camera reads its actions (turn/tilt/zoom axes, turn-button `pressed` edges) and only it rides its rail. Collision pull-in uses `PhysicsPort3D.raycast` (which excludes the character, so a follow camera on the player works); in a 2D plane there is no pull-in — its colliders lie in the plane the camera looks at, never between camera and target. Targets and paths are entity ids resolved each step (world pose composed up the parents); a missing one is warned once in the play log and the rig centres on the camera's own entity.
- 2026-09-26 (23.4): **conventions and defaults.** Cameras look down −Z; yaw turns about +Y (0 = on the target's +Z side), pitch is how far the view looks down; positive turn input turns right (yaw decreases), positive tilt raises the camera, positive zoom moves out; a snapped left press adds one `yawStep`. Defaults and their reasons are in project-model `VIRTUAL_CAMERA_DEFAULTS` (5 m, 20° above, pitch −30…80°, 90° steps over 0.25 s, 0.2 m collision radius, eased 0.5 s blend, 8 Hz shake); priority 0 for all. `path` is optional on a rail (the Inspector picks it after the rig; without one the camera stays where it is placed). `cameraPath` is its own component (points as offsets from its entity, like a mover's waypoints; ≥ 2 points; uniform Catmull-Rom when smooth, arc-length progress) so several cameras and the 23.17 sequencer can share one path. Not prefab components yet (a vehicle's chase camera in a prefab can come later).
- 2026-09-26 (23.4): **shake and letterbox.** Shake = the live camera's constant shake (weighted by the blend) plus script impulses (`ctx.camera.shake(amplitude, seconds, frequency?, rotation?, seed?)`, quadratic fade, at most 16 live), seeded value noise (a camera's seed is its id's hash; an impulse's is its seed or its serial number), offset in the camera's own frame — simulation state, so it replays. Positional parameters rather than an options object because the visual-script generator reads a 2–3-number options object as a vector. Letterbox is a blended per-camera amount (each bar's share of the view height, 0–0.5) drawn by the game host as two black DOM bars over the view (styled through the CSSOM: the preview's content security policy refuses style attributes) — an overlay, so `tl_screenshot` (the canvas) does not include them; the page screenshots do.
- 2026-09-26 (23.4): **screen↔world.** `ctx.camera.worldToScreen` / `screenToRay` use the camera committed at the end of the previous step and normalized screen coordinates (0–1 from the top left). The aspect comes from the renderer through a new `Runtime.setCameraViewport(w, h)` (a worker command in threaded Play), not `setViewport`: nothing called `setViewport` in production, and wiring it would change the platformer follow camera's frustum clamp (it assumes 16:9) — i.e. every recorded 2D replay. Until the renderer reports, the aspect is 16:9; replays match when the viewport matches (the aspect only feeds projection, never the camera pose).
- 2026-09-26 (23.4): **script API and nodes.** `ctx.camera` is present on every phased step context (scene loads may bring cameras later); it is the last member of `BehaviorContext`, so the generated script typings and the visual-script catalogue only gain entries (the 12 Camera nodes are generated from the doc tags; existing node types and codegen are unchanged). Script changes apply to the brain immediately and are resolved at the end of the step; reads use the last resolved step.
- 2026-09-26 (23.4): **view distance (E2).** Per-camera `fovY`, `near`, `far` (absent: the scene camera's), blended like the pose. Depth precision, which E2 asked to confirm: three r186's WebGPURenderer offers `logarithmicDepthBuffer` and `reversedDepthBuffer` (reversed needs WebGPU or WebGL 2 `EXT_clip_control`, else three falls back to standard); Thirdlight used standard depth everywhere. New optional engine setting `depth_buffer` (1 Standard — absent, every existing project — 2 Logarithmic, 3 Reversed Z), appended last in the settings registry and `M3_OPTIONAL_SETTINGS_KEYS`, applied by Play and the export when the renderer is made; the canvas reports the mode actually in use (`data-tl-depth`). Not added to `GameplaySettings` (typings unchanged). The Scene view keeps standard depth.
- 2026-09-26 (23.4): **editor.** Inspector sections come from the descriptors; the orbit point is the first user of the `point` handle kind (world space, orbitPoint only), the camera path uses the `path` handle. A selected virtual camera shows a world-space frustum at the pose its rig gives from the authored transforms, computed by the runtime's own brain (`CameraBrain.previewPose`, no input or damping), and the view element reports it (`data-virtual-camera`).
- 2026-09-26 (23.1): **3D collider shapes.** `collider.shape` gains
  `sphere {radius}`, `capsule {radius, height}` (total height, end caps
  included, along the object's Y — the controller capsule's convention),
  `convex {points}` (4–64 `[x, y, z]`, must span a volume) and
  `mesh {vertices, triangles}` (≤ 1,024 / ≤ 2,048, three distinct in-range
  indices), all coordinates within the 64 m collider extent; a scene holds at
  most 32,768 hull points and mesh vertices (`COLLIDER_3D_LIMITS`). Limits
  keep one collider inside a 64 KiB command request. They are 3D-only (a 2D
  plane refuses them in the project composition, as 3D refuses polygons); a
  mesh is static (refused on a mover or controller), a one-way collider is a
  2D-plane platform (refused in 3D). The runtime resolves a shape for the
  port (`colliderShape3DOf`: scale applied, capsule height → centre-segment
  half height, flat point lists); the port keeps its own validation.
- 2026-09-26 (23.1): **colliders from model geometry are baked data**, like
  the 2D plane's `_COL` outline polygon: the editor computes a mesh or hull
  from the model's `_COL` node(s) (else its LOD0 geometry, `pieceCollider3D`
  in three-adapter; 1 mm grid, merged vertices, a hull reduced to the six
  axis extremes plus 58 evenly spread directions) and stores it in the
  collider. Why: the runtime never loads models (worker, export), the
  collider stays editable data, one mutation path, replays hold. A drop in a
  3D project makes a mesh from `_COL` (a hull when too big); "Box / Convex
  hull / Mesh from model" in the Inspector, the add menu, the palette and the
  context menu make one on demand (a box from the bounds, an 8-corner hull
  when the model is off-centre). The asset importer is unchanged.
- 2026-09-26 (23.1): **scale.** In 3D the unit-scale rule moved to the
  project composition (`physicsScaleErrors`, like 23.0's rotation rule): a
  box, hull or mesh collider takes any positive scale per axis, a sphere or
  capsule a positive uniform one (a non-uniformly scaled sphere is no
  sphere); controllers and every 2D-plane body keep unit scale with the same
  error as before. Physics bodies stay roots. A pose intent's scale stays
  visual (as documented).
- 2026-09-26 (23.1): **3D triggers** feed the existing trigger/signal system
  in `GameplayBlocks`: `shape` gains `sphere` and `capsule` (`radius`,
  `height`), a box's `size` an optional depth (`[w, h, d]`, required in 3D; a
  2D plane ignores it; `circle` is refused in 3D). The player's capsule
  (a segment swept by its radius) is tested exactly: segment–point for a
  sphere, segment–segment for a capsule, segment–box in the box's frame for a
  box (a fixed 80-round golden-section search of the convex distance:
  deterministic). A trigger turns with its entity's own rotation and sits at
  its world position (parents' offsets summed, as in 2D); scale is ignored
  (sizes are world metres, as in 2D). Signals, exit signals, `stay`, `once`
  and `ctx.triggerEvents` are the 2D code path (`updateTrigger`). A 3D scene
  plays without a game session, so triggers always run there. `gameZone`
  (checkpoint, goal, hazard, exit) needs the game session — it stays 2D
  until game modes (23.10); switches, pickups and enemies test on the plane
  only, so a 3D project refuses them (`blockDimensionErrors`) rather than
  ignoring depth.
- 2026-09-26 (23.1): **3D movers.** Movers advance in the runtime as before;
  in 3D they are kinematic bodies on the 3D port (`setKinematicPoses`,
  position and the entity's fixed rotation, applied after the character's
  sweep like the 2D port's), the player standing on one is carried
  (`carryDelta3`, added to a staged move and to the runtime's fall), and a
  mover moving into the player pushes it out along the axis of least overlap
  of the boxes (the 2D rule in 3D, including "a rising mover pushes a player
  beside it sideways, never up"). The port reports `kinematicSlack` (the
  3D validator accepts it, as in 2D). Measured: Rapier's 3D sweep sometimes
  takes a kinematic support's numerically tilted normal inside its skin for
  a block (a character riding a sliding lift stalled — no motion, 20
  iterations — about one step in three); the port then re-sweeps only the
  horizontal part without that one support body (walls still block), and
  keeps every kinematic body at rest during the sweep (the runtime carries
  and pushes). Static worlds never take that path.
- 2026-09-26 (23.1): **port methods for 23.3 and 23.10**: `overlap(shape,
  center, rotation?)` (box, sphere, capsule; sorted, ≤ 64, character
  excluded), `characterClearance` / `placeCharacter` (the 2D probe's rules:
  blocked by the deepest overlap, else supported straight below, else
  `no_support`) and the existing `raycast`. Scripts' queries are wired in
  23.3; respawn/spawn clearance in 3D needs the game session (23.10).
- 2026-09-26 (23.1): **the behavior ownership rule is lifted in 3D only.**
  A script (any transform-phase module) may own a collider no mover moves;
  the runtime re-adds it to the 3D port as a kinematic body at the first
  step boundary after it is owned and poses it every step from its
  committed transform (one step behind the transform intent, like a mover's
  pose), and a player standing on it rides along. The controller and movers
  stay off limits. The 2D plane keeps the rule exactly: lifting it there
  would need the host-built 2D init config to know script owners and a
  change in the untouched rapier2d adapter path, so no existing 2D result
  could move only by keeping it. `ModuleConfig.physicsDimension` (3, else
  absent) tells the behavior host.
- 2026-09-26 (23.1): **editor.** Collider and trigger descriptors carry the
  new fields (hull and mesh lists read-only: they come from a model); the
  radius handle edits a sphere, the capsule handle (new role set without an
  offset: a centred capsule grows both ways) a capsule; a trigger box with a
  depth is a 3-axis box turning with its object; a collider box with `hz`
  now follows the object's whole transform (it scales in 3D). The Scene
  view draws 3D colliders (box, sphere, capsule, hull edges, mesh edges) in
  the merged collider outlines and 3D trigger areas as dashed wires. Presets
  carry an optional `dimension`, so "+ Add component" offers the project's
  (`addEntries(..., { dimension })`, absent = 2 — the 2D lists are
  unchanged). A vec3 field with `optionalLast` no longer writes a made-up
  last component when x or y of a two-component value is edited.
- 2026-09-26 (23.7): **`ctx.random`.** Per script instance a main stream
  and named sub-streams (`stream(name)`, 1–64 timer-name characters, at most
  64 per instance — an engine limit), each seeded by cyrb128 of
  `random_seed`, behavior id, entity id and stream name, drawn with sfc32
  (32-bit integer maths only, so the page, the worker and Node agree; 12
  warm-up draws). Members `next`, `range`, `int` (inclusive, bounds rounded
  inward), `chance`, `pick`; a bad argument is a script error
  (`behavior_random_invalid` / `behavior_random_limit`) and never advances a
  stream. Streams are made on first use and reseeded in place at every new
  run (start, replay — when the host re-instantiates the state), so a replay
  draws the same numbers and a handle a script kept stays valid. The runtime
  has no mid-run checkpoint of script state (worker handoff, rewind or save
  of behavior state), so there is no RNG state to round-trip; the numbers
  are pinned by a unit test so the generator never drifts.
- 2026-09-26 (23.7): **seed setting.** `random_seed` is an optional engine
  setting (0–4294967295 integer, absent = 0, group Engine, label "Random
  seed") appended after `sim_thread` in the registry and in
  `M3_OPTIONAL_SETTINGS_KEYS`, so unset projects keep their settings bytes,
  manifests and digests; read with `randomSeedOf` from the resolved
  settings the behavior host already receives (no new plumbing to the
  worker or the export). Not added to the `GameplaySettings` interface
  (like `physics_dimension`).
- 2026-09-26 (23.7): **entity queries.** `ctx.world.find(name)`,
  `findAll(name)` and `withComponent(kind)` read the runtime's live entity
  list (`state.order`: the start scenes in document order, then loaded
  scenes and spawned copies as attached) — exact, case-sensitive names;
  component kinds as stored (`Object.keys(components)`, kept on the entity
  data as `componentKinds` when it is attached). Results are frozen and
  cached per entity list (the runtime replaces `order` on every change),
  at most 256 remembered queries per kind; a non-text argument is a script
  error (`behavior_query_invalid`).
- 2026-09-26 (23.7): **rotation forms.** New optional fields `quaternion`
  ([x, y, z, w], normalized when applied) and `facing` (+Z forward, the
  glTF forward; optional `up`, default +Y; a vertical facing without `up`
  leans the top away from/towards +Z, as pitching would) on the `pose`
  intent (order kind, entityId, rotation, quaternion, facing, up, scale) and
  on the `transform` intent after `position` — separate fields rather than a
  union on `rotation`, so the existing declarations, their graph nodes and
  the public `.d.ts` stay as they were. Exactly one rotation form per
  intent (shape error), all-zero vectors and an `up` parallel to `facing`
  are value errors; a quaternion/facing writes the rotation channel (bit 8),
  so a pose rotation and a transform facing in one step conflict. The old
  shapes take the exact old code paths (a legacy transform still parses
  through the strict three-key check; the Euler maths is untouched).
  `facingQuaternion` / `normalizedQuaternion` are exported pure helpers.
- 2026-09-26 (23.7): **graph nodes.** The generated node table gains
  Seeded random / range / integer / chance (main stream, category Random),
  their "(stream)" variants (a handle inside a namespace now keeps the
  namespace's category and names its factory in the label — no existing
  node is a nested handle) and Find object(s) by name / with component.
  `pick` is skipped (Seeded random integer + Get item does it). The
  rotation fields are skipped per field (new generator rule: an optional
  union-member field tagged `@graphNode skip` is not an input), because a
  new input would add a local to every existing Pose/Move object node's
  code and move pinned output digests. The older Random nodes keep their
  per-object seed. Sprout's pinned outputs and the catalogue suite are
  unchanged/green.
- 2026-09-26 (23.7): **script libraries are project data stored inline.**
  `content.scriptLibraries[] {libraryId, name, files[{path, text}]}` (v4,
  absent = none, so existing content bytes stay the same), imported as
  `@lib/<libraryId>` (its `src/index.ts`). Stored inline rather than as
  source blobs so MCP creates and edits them with plain commands
  (`setScriptLibrary` / `deleteScriptLibrary`) and undo covers them. A
  library's digest is the sha256 of its canonical source-graph container
  (the behavior container format, no required modules/owned transforms) and
  goes through the same per-digest trust entries as a behavior source;
  each library has a behavior source's bounds (16 files, 64 KiB per file,
  256 KiB per container), a project at most 32 libraries and 1 MiB of
  library text. `setScriptLibrary` is a patch (`files: [{path,
  text|null}]`, unmentioned files kept) because the command request cap is
  64 KiB — an edit sends only the changed files.
- 2026-09-26 (23.7): **pins, and dependents move with the library.** A
  published behavior that imports libraries records the versions it was
  compiled against (`BehaviorSourceRecord.libraries` `[{libraryId,
  sourceDigest}]`, direct and transitive, absent when none — older records
  and every existing output digest are unchanged, pinned by a test that a
  library-free source compiles to the same manifest whatever libraries
  exist). The content validation requires every pin to name an existing
  library at its current digest, so a library change must republish its
  dependents in the same command: the backend's command route, before
  `setScriptLibrary`, compiles each dependent against the library set the
  command will commit (`prepareScriptLibraryDependents`) and files the
  prepared facts under `<sourceDigest>|<librarySetKey>`; the command builds
  the new records only from those facts. One change record carries the
  library and the dependents' records, so undo/redo move them together
  and the closure always recompiles to the recorded digests. The patched
  digest must be acknowledged first when there are dependents (trust
  precedes the compile); a dependent that no longer compiles refuses the
  save with its id and diagnostics and records a Problem. Deleting a library
  a published script imports is refused (`reference_in_use`).
- 2026-09-26 (23.7): **compiled once.** Each behavior output stays a
  self-contained module (the runtime loads one module per behavior; a
  shared runtime module would need an import map in the worker and the
  export), so a library's code is linked into each dependent's bundle. What
  is shared is the library compile: the compiler instance keeps a bounded
  cache (64) of parsed, checked and transpiled libraries keyed by digest
  (esbuild `transform` once, then linked as JS), so a Play/export build that
  recompiles N dependents compiles each library once. Missing libraries and
  library cycles are compile failures naming the chain (a cycle between
  libraries is refused even when the file-level graph would be acyclic);
  the library chain is bounded by the import-depth limit. The import scan
  stays textual, so an import written in a comment counts (the new-library
  template avoids one).
- 2026-09-26 (23.7): **`.json` data modules.** A behavior or library
  container may hold `.json` files (the entry stays `.ts`), imported with a
  relative path as their parsed value (esbuild's json loader); the file must
  parse (`behavior_source_invalid` `json`, naming it). Containers without
  `.json` files are unaffected (a `.tsx` is still refused).
- 2026-09-26 (23.7): **editor.** A Libraries bottom tab (create → id from
  the name, rename, delete — disabled while imported, open) and a
  "Library: <name>" centre tab reusing the code editor: file list (+ File for
  `.ts`/`.json`, rename, delete; the entry stays), an idle/Ctrl+S check
  through `POST content/libraries/check` (the draft compiled alone against
  the project's other libraries, nothing written; answers the scripts that
  import it) and Save (one patch command; the trust prompt when a dependent
  will link the new digest; "Recompiled …" on success).
- 2026-09-26 (23.2): **where the 3D controller lives.** A runtime built-in
  simulation module, `thirdlight.character3d:controller` (package
  `@thirdlight/runtime`, like the demo module; `runtime/src/character3d.ts`),
  phases controller and transform, owning the controller entity — not a new
  package (it needs only runtime and project-model, and a package would add a
  lockfile, pin, boundary and export-closure row for no isolation gain) and
  not a part of `@thirdlight/platformer` (2D by construction, its frozen
  traces untouched). In 3D the project model resolves a `controller` to this
  module (which requires the 3D backend and input), so a 3D project's
  manifest selects it and its scene runs on the M2 step path (input sampled,
  controller → physics → transform); the runtime's 23.0 gravity-only phase
  stays as the fallback for a module set without it. The host registers it
  like the platformer specs.
- 2026-09-26 (23.2): **settings are controller data, 3D-only fields.** New
  optional controller fields (canonical order after the tuning fields):
  walkSpeed 2 m/s, runSpeed, airControl 0.5, gravityScale 1, jump true,
  jumpSpeed, slopeLimit, stepHeight 0.3 m (0: off), ledgeClimb false,
  ledgeHeight 1.2 m, ledgeClimbTime 0.6 s, turnSpeed 720°/s (0: at once),
  faceMovement true — reasons in `DEFAULT_CHARACTER_3D`. runSpeed, jumpSpeed
  and slopeLimit are absent by default and then read the project settings
  (`run_speed`, `jump_velocity`, `max_slope_climb_deg`), gravity is the
  project's × gravityScale, so a project has one source per value;
  acceleration, deceleration, coyote time, jump buffer/release, ground snap
  and skin are shared with the 2D controller. Descriptor fields and handles
  gained an optional `dimension` (the Inspector shows a project's own: the 3D
  fields in 3D, autostep/autostepHeight only on the 2D plane); commands accept
  every field in both (a 2D plane ignores the 3D ones, as it ignores `hz`).
  In 3D the ground snap is at least the step-up height (a character that
  climbs a riser walks down it without a fall) — no separate field.
- 2026-09-26 (23.2): **stepping up is the port's own.** Rapier's autostep
  (rapier3d-compat 0.20.0) missed risers above about 0.15 m with a capsule
  whatever its minimum width (measured: a 0.2 m riser blocked a walking 0.3 m
  capsule). The 3D port now probes a riser it is blocked by (grounded, less
  than half the move across): up by the step height plus two skins, across
  by the capsule radius plus two skins, down; when that lands grounded on
  walkable ground ≤ step height + skin higher, the character is lifted by the
  rise this step and moves on at that height, snap off, until the ground
  under its centre is the top (a capsule's rounded bottom would otherwise
  slide back off the edge) — ends when it stops pushing that way, jumps, or
  after one second. The measured result: 0.3 m climbs, 0.31 m and 0.6 m block
  with the default. Two more port changes found while walking: the grounded
  character's small downward request is now swept as it is (the 23.0 port
  dropped it like the 2D port, which made Rapier's grounded status flicker
  every other step), and a grounded character asked for nothing across and
  moving less than its skin on a non-kinematic support stays exactly where it
  is (Rapier's sweep and snap alternated it by ~0.1 mm per step, so it never
  came to rest). The runtime's 3D result check allows the step height, the
  snap and the skin. All 23.0/23.1 tests stay green unchanged.
- 2026-09-26 (23.2): **input.** `ActionFrame.moveY` is optional (absent: 0;
  `validateActionFrame` accepts it like moveX, so every recorded replay and
  2D frame validates and digests exactly as before). The browser input owner
  fills moveX/moveY from the project's `move` action when that is a 2D axis
  (a 1D `move` keeps the M2 mapping bit for bit). A 3D project without its own
  input gets `DEFAULT_INPUT_3D` (move as a 2D axis on W/A/S/D, arrows and the
  left stick; a `run` button on Shift and the left-stick press; the rest as
  the 2D defaults) in Play, the export and the editor's input defaults. The
  worker's live input (`TickInputSource`), the exclusive-test relay and the
  whole `tl_input_exercise` chain (MCP tool, backend route, WS event, bridge,
  preview, worker) carry `moveY` — and now the named `actions`, which the MCP
  tool accepted but dropped before and the bridge refused.
- 2026-09-26 (23.2): **camera yaw is a small input** — `StepContext.cameraYaw`
  (radians about +Y, 0 looking along −Z, three.js' default camera). With
  23.4 merged it is the camera brain's committed view (resolved in the
  simulation at the end of the previous step, so replays read the same yaw;
  looking straight down, the screen's up gives the heading); without virtual
  cameras it is absent and the input moves along world axes (+x → +X,
  forward → −Z). An internal `cameraYawSource` override exists for tests. The
  controller turns the move vector by it (right = (cos, 0, −sin), forward =
  (−sin, 0, −cos)).
- 2026-09-26 (23.2): **facing.** With faceMovement the controller turns the
  entity about +Y toward the pushed direction at turnSpeed (+Z forward, the
  glTF forward, as 23.7's facing), writing the controller entity's rotation
  in the transform phase (it owns it); off leaves the authored rotation.
- 2026-09-26 (23.2): **ledge climb** (module): pushing into a wall (last
  step: wall contact, less than half the move across) with ledgeClimb on, a
  ray down from ledgeHeight + 5 cm above the feet, one capsule width ahead,
  must find a walkable top higher than the step-up height and at most
  ledgeHeight up, the capsule must fit on top (`characterClearance` ok) and
  have room to rise (not blocked); then the character rises alongside the
  wall for 60% of ledgeClimbTime and moves onto the top for the rest, input
  and gravity ignored, each step a staged move the port sweeps (never
  through geometry). The module gets read-only ray/clearance queries through
  `ModuleConfig.character3D` (not part of the scripts' context; scripts'
  3D queries are 23.3).
- 2026-09-26 (23.2): **scripts drive the character through intents**
  (intent phase, one writer per channel per step, refused on a 2D plane):
  `character_move {x, z, run?}` (a world direction this step, replacing the
  input), `character_place {position: [x, y, z]}` (the runtime calls the
  port's `placeCharacter` after the intent phase and commits the origin; the
  controller starts from rest), `character_enable {enabled}` (lasting; off:
  no input, no gravity, a zero move staged so what it stands on still carries
  it), and `control_move` takes an optional `y` (`@graphNode skip`, so the
  existing node and pinned graph code are unchanged). Reading:
  `ctx.physics.characterState(id)` (position, velocity = the last applied
  motion × step rate, grounded, contacts, support normal, ground entity,
  enabled, climbing, facing in degrees); `characterResult` returns the 3D
  result in 3D. New graph nodes: Walk character, Place character, Enable
  character, Character state (additive; no existing node's code moved).
  Respawn/spawn clearance in 3D stays with 23.10.
- 2026-09-26 (23.5): **where the cells live.** A layer is an entity with the `blockLayer` component (settings only); its cells and regions are scene data (`scene.blocks[]`, one entry per layer holding any), not a component field — Inspector edits and entity copies stay small and the 64 KiB command cap never meets a layer. The origin is the entity's position (the min corner of cell 0), the layer a root at identity rotation and unit scale (the cell size carries the scale; blocks turn per cell). Deleting the entity drops its entry (undo restores it); removing the component while cells remain is refused (clear first); copying a layer entity copies its settings, not its cells.
- 2026-09-26 (23.5): **storage.** Each chunk (16 × 16 columns) is its own file `scenes/<sceneId>.blocks/<entityId>.<cx>.<cz>.json` (palette one value per line, one run-length column per line); the scene file lists them (`blockChunks`) and keeps the revision and retry records, so every cell change rewrites the scene file plus the changed chunk files in one journaled transaction. Chunk files are known files: external-edit detection, accept/discard and leftover temps work as for scene files; the journal accepts chunk paths.
- 2026-09-26 (23.5): **commands.** One scene op `editBlocks {entityId, edits[]}` with compact edit kinds (fill, cells, array runs, replace, meta, flood, column, stamp, copy/move/mirror/turn, region CRUD, heightmap) — 23.6's brushes, selections, stamps and paste are these. Its change is compact (`chunks`, `regions`, `cells`); clients read chunks back with `queryBlocks`, so a big fill stays small in events and retry records; undo/redo restore whole layer entries. Content ops `setBlockType`/`deleteBlockType`, `setCellFields`, `setBlockStamp` (whole, or saved from a selection)/`deleteBlockStamp`. References (block types, rotations, variants, fields, footprints) are project rules, so a type or field still in use cannot be deleted.
- 2026-09-26 (23.5): **metadata is schema-driven** (owner rule: generic only). `content.cellFields` defines every field (bool/enum/int/float/string, default, range, overlay colour); the engine has no built-in field names. Effective value = schema default, then the block's default, then the cell's override.
- 2026-09-26 (23.5): **variants and footprints.** A cell without a variant shows one picked from the weights by a hash of its coordinates (stable everywhere, nothing stored). A multi-cell block is stored at its footprint's min corner; covered cells stay empty (validated; `ctx.grid.get` of a covered cell reports the anchor). Footprint blocks neither hide nor lose faces.
- 2026-09-26 (23.5): **prefab looks** use the prefab's root model (visual only): entities per cell would not merge and would add scripts/colliders per cell; props with behaviour sit on top of cells (23.6 snapping).
- 2026-09-26 (23.5): **hidden faces by profile.** A triangle on a cell boundary plane is dropped when the neighbour is solid or shows the same face profile (points + area) on the opposite side — works for stand-ins and kit models whose outer faces lie on the boundary; nothing visible is dropped. The same mesher builds collision triangles from the collision shapes (neighbour rule: a full single-cell shape), vertices merged, split into pieces within the port's mesh limits (1,024 vertices / 2,048 triangles).
- 2026-09-26 (23.5): **rendering** is one `BlockLayerView` (three-adapter) used by the Play/export adapter and the editor's Scene view: merged geometry per look and material per chunk rather than instancing (instances cannot drop hidden faces); per-chunk bounds give frustum culling. **No chunk LOD**: kit models' LOD1 would need per-cell LOD choice inside merged meshes; merged chunks at hidden-face counts measured cheap (below). Runtime cell writes reach the renderer as chunk changes (`takeGridChanges`, through the worker frame like effect requests).
- 2026-09-26 (23.5): **light baking does not target block layers**: chunk meshes carry no lightmap UV1 and the bake assigns atlases per entity (≤ 4,096 entries); layers are occluders of the bake and keep realtime lighting. Gap for 23.20 / the owner.
- 2026-09-26 (23.5): **collision timing.** Script writes change cells and queries at once; the touched chunks' colliders are rebuilt before the step's 3D physics sweep (and at step end for later writes) with one batched remove/add. Measured: the digging step's sweep already has no support; the player's position first moves one step later because the 23.0 character phase starts a fall from rest at the step after support goes away (as when walking off an edge). 2D-plane projects draw layers without collision.
- 2026-09-26 (23.5): **`ctx.grid`** takes positions/directions as `[x, y, z]` arrays (the graph generator's vector input) and returns `{x, y, z}`; `pick` is a DDA over cells (deterministic, physics-independent; half blocks and ramps pick by their cell). `changes()` shows the previous step's writes; `diff()`/`applyDiff()` give plain data for saves (23.19 decides where saves keep it). 4,096 writes per step (engine limit). A new run restores the authored cells.
- 2026-09-26 (23.5): **heightmap PNGs** are decoded by a small pure decoder in project-model (inflate included), so the import is an ordinary command edit (MCP sends base64): grey value → `round(v / 255 × scale)` cells; an optional colour PNG picks each column's cell by nearest listed colour.
- 2026-09-26 (23.5): **measured** (`TL_PERF=1 npx vitest run tests/perf/block-layers.test.ts`, this host): editing a 64 × 64 × 16 layer (65,536 cells) through the command path — one cell 8.1 ms, a 5 × 5 × 2 stroke 8.0 ms, undo 8.9 ms, a whole-layer fill 105 ms; a 40 × 40 × 12 terrain (11,146 cells, 9 chunks, 3 types, grass with 3 looks) — 4.9 merged meshes per chunk, 9,976 triangles (133,752 without hidden-face removal), meshing 219 ms and collision 96 ms for the whole map. Frame rate on WebGPU is 23.20's budget run (the phase 21 harness has no block class yet).
- 2026-09-27 (23.6): **UI only on 23.5's commands.** Every brush, selection op, stamp and region action is one `editBlocks` (or a content op) — no new command. A stroke previews locally and commits once on release (one undo step per gesture): freehand strokes (paint, erase, raise/lower) apply their new cells to a copy of the layer with the project-model's own `applyBlockEdits` and re-mesh only the touched chunks; shape tools (line, rectangle, box, select, region, stamp, paste) draw a ghost; click tools (flood, replace-all, eyedropper) act on release. The editor may only import project-model types, so the runtime re-exports `applyBlockEdits`, `effectiveCellMeta` and `pickCell` (it already re-exported `BlockGrid` for the renderer) — a local preview of the gesture, never a second mutation path; the backend's result replaces it (identical chunks re-mesh nothing).
- 2026-09-27 (23.6): **targets and the slice.** The pointer's cell comes from the project-model DDA (`pickCell`, what `ctx.grid.pick` uses) against the stroke-start cells, so a stroke never climbs onto what it just painted: adding tools take the empty cell in front of the face under the pointer, the others the block itself; with no block before it, the height-slice plane (PageUp/PageDown or ] / [, and a panel control) gives the cell. Rectangle-shaped strokes stay on the press cell's row. The slice is a working plane, not a cut-away (hiding the cells above it would need per-cell filtering inside merged chunk meshes).
- 2026-09-27 (23.6): **brush semantics.** Box = the dragged rectangle raised to the brush height (a numeric field), so rectangle and box share one gesture; raise/lower adds the brush block (or a copy of each column's top) or removes the top (Ctrl held or the Lower toggle); flood is 4-connected in the row (`xz`); replace-all replaces the clicked cell's type in the whole layer keeping metadata overrides. "Randomize looks" paints cells without a variant, so each shows a look picked by the variants' weights from its position (23.5's stable hash — the same in the editor, Play and exports, nothing stored); off paints the chosen look index. Rotate (Q) steps through the type's allowed rotations. While the tools are on, the left button paints and Alt+drag / the right button orbit.
- 2026-09-27 (23.6): **selections.** Select drags a box (inclusive of both picked cells); copy/cut and paste are a `copy` edit (move: true for cut) within the layer, or an `array` edit (−1 for empty source cells, so they do not erase) into another layer; mirror and rotate are `copy` edits in place with `move: true` (the source is cleared first; a rotated box keeps its min corner and swaps width and depth). "Save as stamp" is `setBlockStamp` from the selection; the stamp library places with rotation and mirror.
- 2026-09-27 (23.6): **metadata overlay.** Colours come from the schema: a field's `color` (bool true, a set string, int/float off their default shaded along min–max), or a generated palette of evenly spaced hues for an enum's choices (from the field's colour when set, else its key's hash). One instanced plate per coloured cell on its top face, one mesh per shown field, with a legend. The metadata brush paints `meta` edits by cells or rectangle, optionally occupied cells only, or clears the field.
- 2026-09-27 (23.6): **layer visibility and lock are the object's Hierarchy flags** (`active`, `locked`; `updateEntity`): an inactive layer is not drawn in the Scene view and the tools refuse a locked or hidden layer. Named regions: listed per layer, painted with the Region tool (`region add` / `remove` with Ctrl), made from the selection, renamed (double-click or Rename) and deleted — all `region` edits.
- 2026-09-27 (23.6): **prop footprint = a `blockFootprint` component** `{layer?, size? [x, z], set: {field: value}}` (v4 scenes and prefabs; validated shape only — fields are the project's schema, checked when written). The editor writes it: when the object is moved with the gizmo (after its `setTransform` is stored), from the Inspector's "Write to cells", or "Snap to cell top": one `editBlocks` per layer clearing the component's fields (null) on the cells it left and setting them on the cells beneath it (the footprint rectangle centred on the object, turned by its quarter turns about +Y, on the row its base stands on). Two undo steps (the move, then the cells), not one atomic command — a combined op would be a new cross-document command; logged as a known limit. Deleting the prop does not clear its cells. The runtime ignores the component.
- 2026-09-27 (23.6): **snapping is editor settings** (Edit → Snapping settings…): move step (m), rotate step (°), scale step, and "snap objects to block cell tops"; remembered per project in this browser (`localStorage`), not project data — they never reach the game, its build id or other users; defaults are the old constants (0.25 m, 15°, 0.25), so existing behaviour and tests hold. The gizmo, drops, handles and the gesture maths read `getSnapSettings()`. Cell-top snapping moves a translated or dropped object onto the highest column top under its footprint (a cell centre for odd sides, a corner for even ones); the object's origin is taken as its base.
- 2026-09-27 (23.6): **measured** (e2e `tests/e2e/block-editor.e2e.ts`, a 64 × 64 × 16 layer holding 32,768 cells, this host under other agents' load, WebGL 2): a three-cell paint stroke's worst pointer-move preview 38–54 ms (the first move also copies the layer for the preview; each move applies its cells and re-meshes the touched chunk), release → stored 107–159 ms.
- 2026-09-26 (23.8): **one start path.** "Play from…" and `tl_play_start`
  send the same play-start body (`options.sceneId / mode / variables / save /
  saveSlot`); the backend resolves it against the captured project
  (`backend/src/play-start.ts`) and puts the result on the play's snapshot as
  `start` (the bridge accepts it; the preview strips it before the runtime
  snapshot, which stays strict), so the browser, MCP and the headless editor
  share one path and the preview only applies what was already checked.
- 2026-09-26 (23.8): **what "start at a scene" means.** A game with levels
  starts a new game at the first level that loads the scene (the title is
  skipped; a scene no level loads is refused) — the flow's own start path; a
  game without levels runs `startLevel` with its start scenes plus the scene
  (the start set holds the camera, player and lights, so the scene alone
  could not play) at the scene's first player spawn, else the game's; a
  scene-only project loads it through `requestScene`. The runtime snapshot,
  manifest and buildId stay those of an ordinary Play.
- 2026-09-26 (23.8): **variables are `ctx.save`.** Injected variables are the
  scripts' saved values from step 0 (`InstantiateConfig.variables`, the
  worker's init, ctx.save's rules: 64 keys, 4 KB JSON each); no second store.
  With a save start they are merged over the save's `run.values` (the save's
  restore replaces the store). A save start needs a game with levels (the
  save document is the flow's; 23.19 brings project save documents); a scene
  and a save together are refused (the save decides where).
- 2026-09-26 (23.8): **mode before modes exist.** `mode` is an optional id
  string: checked against `content.modes` (`modeId`/`id`) when a project has
  them, otherwise ignored, logged by the backend and returned in
  `start.notes`; the host notes it in `start.applied` — 23.10 applies it.
- 2026-09-26 (23.8): **debug commands are declared in code, received per
  step.** `ctx.debug.command(name, {description, args: [{name, type:
  number|string|boolean, optional}]}, handler?)` both declares (first
  declaration wins, a different one is a script error; 32 per game) and
  returns this step's calls in the intent phase, running the optional
  handler once per call there — poll-shaped like `ctx.messages`, so no
  callback ever runs outside a step, and declarative enough for the console
  and tools to list and type-check. Every declaring instance receives each
  call. No graph node (a typed spec and a handler are code; skipped in the
  catalogue, like `random.pick`).
- 2026-09-26 (23.8): **commands are input.** A call is an entry of the
  step's `ActionFrame.commands` (≤ 8 per frame, ≤ 8 typed args, text ≤ 256;
  absent keeps every older frame and recording byte-identical). The host
  queues calls in the runtime (`queueDebugCommand`, ≤ 16 waiting); the
  runtime attaches them to the next sampled frame, so the frame it records
  and replays (`createRecordedActionSource`) carries them; in the worker the
  mirror checks the call against the mirrored registry and the worker's
  runtime queues it (same step as single-thread, pinned by a digest test).
  A recorded call no script declared is dropped with a diagnostic entry.
  The applied log (last 16 `{stepIndex, name, args}`) is what a playtest
  needs to rebuild the recording.
- 2026-09-26 (23.8): **console.** A game-host overlay (plain DOM,
  constructed stylesheet) toggled with the backquote key — the common PC
  console key, bound by no engine default; lines are `name a b` (declared
  order) or `name k=v`, quoted text keeps spaces. Play always passes
  `debugConsole: true`; an export only with the new optional engine setting
  `debug_console` (values 0/1, absent = off, after `sim_thread` in the
  optional-settings order) so a release build never ships it by accident;
  the setting is not added to the `GameplaySettings` interface (the public
  script `.d.ts` stays as it was apart from `ctx.debug`).
- 2026-09-26 (23.9a): new asset kind `font` (TTF, OTF, WOFF2, WOFF) with its own `font` recipe profile (recipeVersion 1, `FONT_TOOLCHAIN`) — the project UI loads fonts through the browser FontFace API, so the importer only checks the container (magic, table directory / declared length) and never parses glyphs.
- 2026-09-26 (23.9a): a font file is at most 4 MiB (`FONT_SOURCE_BYTES_MAX`, an engine limit: the page holds the whole file and the browser parses it at load), at most 16 fonts per project and 8 versions per font (limit names `font_assets` / `font_versions`) — a UI needs a handful of faces, not a library.
- 2026-09-26 (23.9a): the family name is read only from the `name` table of an uncompressed TTF/OTF (typographic family 16, else 1; printable, ≤ 64 characters) and is optional in the metrics — WOFF/WOFF2 tables are compressed and decompressing them just for a label is not worth it.
- 2026-09-26 (23.9a): fonts travel like other assets: closure content type `font/x-font`, container check `scanFontContainer` (the export-m3 dispatch moved into `scanAssetContainer`), and Play/export hand them to the game host through the existing generic `assetPaths` / `assetKinds` maps (kind `"font"`). A font enters the closure only when something references it (the UI documents of 23.9a); no reference path is added here.
- 2026-09-26 (23.9a): the test fixture is an ASCII subset of DejaVu Sans made with fontTools (`fixtures/fonts/neutral-sans.ttf` 10 KiB, `.woff2` 5 KiB) with the Bitstream Vera / DejaVu license copied next to it; the asset tile reuses the generic `empty.png` icon.
- 2026-09-27 (23.9a): **plan decision confirmed** — UI documents are project content (`content.uiDocuments[]`, `content.uiThemes[]`, v4, inline JSON widget trees) drawn by the game host as DOM/CSS on the main thread in Play and exports; the runtime never draws and nothing of the editor ships. Stored inline (like 23.7's libraries) so MCP and the editor edit them with `setUiDocument` / `deleteUiDocument` / `setUiTheme` / `deleteUiTheme` (whole value, one undo each, change type `setUi`); the resulting-state check refuses deleting a document that a show/hide action or `flow.screens` names, or a theme in use.
- 2026-09-27 (23.9a): **widgets and styles are a closed data vocabulary** — panel (anchor/pivot/offset/size/stretch+margin), stack, grid, list (a template repeated from a bound array, ≤ 256 drawn, no nested list), text (markup `[b] [i] [color=#…] [size=N] [icon=name]`, `{path}` values), image (texture, 9-slice, fit, tint on unsliced images via a mask), bar (linear right/left/up/down or radial conic gauge), button, input (submit). Styles are a fixed set of properties plus hover/focus/pressed/disabled variants, never raw CSS (no injection, no remote URL); they compile to a constructed stylesheet (the Play page's CSP refuses inline `<style>`), layout goes through the CSSOM. Game concepts (health, coins, lives…) are not widgets: projects build them from these (owner rule, 2026-09-27).
- 2026-09-27 (23.9a): **engine limits** (`UI_LIMITS`): 64 documents, 16 themes, 48 KiB canonical JSON per document or theme (fits one 64 KiB command), 512 widgets, depth 16, 128 children, 64 styles / icons, 32 tweens, 1024 characters per text; view model 64 KiB, a value's text ≤ 1024, lists ≤ 256, objects ≤ 64 keys, depth 8; 32 documents shown at once; 16 UI events per input frame.
- 2026-09-27 (23.9a): **binding = one global view model written by scripts with `ctx.ui.set(path, value)`** (chosen over per-document view-model objects: several documents share values and a path is simple to author in JSON and graph nodes). Paths are dotted (`party.0.name`); the runtime keeps the model and the stack of shown documents as simulation state (in the step digest once used), and sends each frame one diff (`UiOutput`: writes coalesced by path — a later write replaces an earlier one's whole subtree —, the shown list when it changed, tween/focus commands) — through the worker's frame state in threaded Play. A new run (start, replay) empties the model and hides every document. `$item`/`$index` read a list item, `$flow.*` the game flow's values (screen, level, lives, volumes, result, save slots) for replaced screens — presentation only.
- 2026-09-27 (23.9a): **UI events ride on the next input frame** (`ActionFrame.ui`, additive like 23.8's `commands`; `@graphNode skip`): click (a button's `event` action), submit (an input), focus (the focus moved to a widget with an id, sim documents only), custom (a document's cancel / a widget's onFocus actions), show/hide/toggle (a button's action — applied by the runtime to the stack before any script runs). The host queues them with `Runtime.queueUiEvent` (a worker command in threaded Play); scripts read them in the intent phase only (`ctx.ui.events()`, `ctx.ui.event(name)`), so a script running in both phases sees them once. Recorded frames replay them exactly (unit test: two runs; integration: page vs worker digests).
- 2026-09-27 (23.9a): **navigation** — the focused document is a flow screen's document, else the topmost shown document that is modal or has `focus: true`; it takes the input owner's ui edges (arrows/WASD, Enter, Backspace, the pad's D-pad/stick/A/B) — pause still reaches the flow, and a built-in flow menu keeps its own navigation over a document a script left focused. Explicit `nav` targets first, else spatial (nearest centre in the direction, distance + 2 × sideways offset), document order without layout. The pointer uses DOM events: hovering a focusable widget of a focused document moves the focus; pointerdown keeps the keyboard on the game surface. A modal document adds a backdrop that blocks the pointer for documents under it.
- 2026-09-27 (23.9a): **action maps** — a document's `actionMap` (a project-model input map: gameplay | ui) is the only map feeding the frame while it has the focus (`HostInputOwner.setActiveMaps`; the browser owner neutralizes the other maps' actions and, with gameplay off, the platformer move/jump). When gameplay comes back, a control still held must be released before it acts (no jump from the A press that closed a menu). The switch happens at sampling, so recordings keep it.
- 2026-09-27 (23.9a): **world anchors** use the renderer's camera (`SceneAdapter.projectToScreen`, the three camera after the frame is rendered, so title offsets and virtual cameras are included): an entity (static or bound id) or a point plus an offset; off screen it hides, or with `clamp` sits at the edge (margin, default 24 px: a thumb's width) with class `is-clamped` and `--tl-angle` for an `indicator` child. Anchored widgets are placed in their document's own box whatever their parent lays out.
- 2026-09-27 (23.9a): **tweens** (fade, slide, scale, stamp = scale-in overshoot with a fade) are data per document, played on show (`showTween`), on hide (`hideTween`, the document leaves after it), by a `play` action or `ctx.ui.play` — through the Web Animations API on the individual `scale` / `translate` properties so they compose with the layout transform. Presentation only.
- 2026-09-27 (23.9a): **replaced screens** — `flow.screens` maps title / paused / settings / levelComplete / gameOver / finished / load / save to documents; the built-in panel hides for a replaced screen, the document is drawn on top and focused, and its buttons use engine actions (resume, pause, restartLevel, newGame, continue, nextLevel, quitToTitle, settings, load/save with an optional slot, back, setSetting music|sfx|ui|quality with a value or ±1 step, mute/unmute). Back/pause edges keep the flow's own meaning (pause → resume). Scene-mode games (no flow until 23.10) have project UI but no engine screen actions except mute.
- 2026-09-27 (23.9a): **fonts and images** — a style's `font` is a font asset (loaded once with `new FontFace(family, bytes)` and added to `document.fonts`; it works under the Play page's `font-src 'none'` because no URL is fetched) or a generic family; textures become blob: URLs. Both enter the export closure through `collectAssetRefsV3` (`uiAssetRefs`); an image path bound at run time (`image: {bind}`) must name a texture some document or theme also references statically, or it is not in the export.
- 2026-09-27 (23.9a): observation — the host observation gains `ui {shown, screen, focus, actionMap}` and Play's relay adds `values` (the view model when ≤ 4 KiB, else `valueKeys`), so `tl_game_observe` can check UI state. Graph nodes are generated for `ctx.ui` (category "UI", a new acronym rule in the generator; existing nodes unchanged).
- 2026-09-27 (23.11): **sockets are resolved in the simulation, on rigs shipped as data.** The runtime's animator state machine decides clips, times and weights, but node poses were only computed by three.js in the renderer, so a socket resolved there would not exist in the worker, the export's simulation or a replay. The play/export closure (the one builder both use) now reads each model's rig from its digest-verified GLB (`readModelRig`, project-model: the default scene's nodes depth-first with rest TRS, and every clip's translation/rotation/scale channels, normalized integers scaled like three.js) and ships it in the manifest's new optional `rigs` key; the runtime poses a node from the animator pose with three.js's rules (`RigPoser`: linear/slerp, step and glTF cubic-spline sampling, PropertyMixer's weighted running mix with the rest pose making up a total weight under 1, the same-clip crossfade merge, override layers with bone masks and their Π(1 − L) factors). An integration test loads the same GLB with the real GLTFLoader, poses it with the renderer's own `createAnimatorPlayer` and matches every named node's world matrix (1e-5). Node names follow GLTFLoader's naming (sanitized, repeats `_1`, `_2` in its reservation order: scene names, then nodes depth-first with their camera and light names) — the parity test pins a clash with the scene name.
- 2026-09-27 (23.11): **rigs only when a project uses sockets.** A rig for every model would change the manifest (and buildId) of every existing project with models; the closure adds `rigs` only when a scene or prefab entity has `socketAttach` or a compiled script names `sockets` (a false positive only ships data). Budgets: 262,144 key numbers per model, 1,048,576 per project (clips past them are dropped, the rig is `truncated`, a socket on it warns once). Clips of animation-only files ("clips for" a model) join that model's rig and bind by node name, as in the renderer.
- 2026-09-27 (23.11): **when and how a socket is resolved.** At the end of every fixed step, right after the animators step (plain and phased steps alike; the committed copy is patched too), so an attached entity uses the pose drawn in that frame; its transform is written relative to its own parent (`W_parent⁻¹ · W_target · node · offset`, full 4×4 matrices decomposed like three.js, so non-uniform scale behaves as in the renderer). Chains (an object on an object on a socket) resolve in dependency order; a loop is refused at attach time. Authored sockets attach at load and are settled before the first frame (prev = curr, no streak); a new run (start/replay) re-attaches the authored ones and lets scripted ones go where they are. A camera following a socketed object sees it one step late (the camera brain runs before the animators) — accepted, 8 ms at 120 Hz. Removing a target lets go of what rides on it (keeping world poses).
- 2026-09-27 (23.11): **API shape.** A `socketAttach` component (target, node, position/rotation/scale offset, `attached` — absent true) and `ctx.sockets` (`attach(entityId, targetId?, node?, position?, rotation?, scale?)`, `detach(entityId, keepWorld = true)`, `attachedTo` → `{target, nodeName}` (not `node`: the behavior compiler refuses the text `node:` in script output), `nodePose`) rather than transform intents: attaching is a relation that persists across steps, not a per-step write, and positional arguments because the visual-script generator reads small option objects as vectors. Without a target, `attach` uses the entity's own component (a socket authored as data, attached by a script later). A detach keeps the world pose, or snaps back to the transform the entity had when it was attached. Physics bodies (collider, controller, mover) and the scene camera (camera, cameraFollow) cannot ride on sockets (a validation conflict and a runtime refusal): they are posed by physics or their module, and 2D bodies must stay roots — kinematic socketed colliders in 3D are not built (backlog). Not a prefab component: its target is a scene entity; spawned copies attach by script. The component's canonical position is last (existing entities keep their bytes).
- 2026-09-27 (23.11): **per-instance playback speed** multiplies the time every layer of one animator advances by (clip time and crossfades; transitions still test every step), 0–10: 0 holds the pose, negative speeds are refused (crossfades and exit times only run forwards). ×1 leaves `dt` untouched, so every existing pose and digest is unchanged; the speed is not part of the pose (the pose's JSON is in the step digest). The Animator live preview has a speed slider over the same machine.
- 2026-09-27 (23.11): **morph targets** (optional in the plan, done because it was small): a controller's optional `morphs: [{target, parameter}]` (≤ 32, float parameters, clamped 0–1) and `setMorph/morph` on the script handle (≤ 64 names per animator; a script value overrides a binding of the same target). The pose carries `morphs` only when there are some (existing digests unchanged); the renderer's animator player sets `morphTargetInfluences` by name on every mesh of the model after the mixer. The binding list has no dedicated Animator-tab UI yet (MCP `setAnimator` and the content descriptor carry it).
- 2026-09-27 (23.11): **the Inspector's node list** comes from `readModelRig` on the GLB bytes the editor already reads (re-exported by the runtime: the editor's project-model edge is types-only), so it lists exactly the names the game resolves; a `socketNode` string format shows a select when the target's model is known, a text field otherwise. The Scene view still draws an attached object at its own authored transform (Play places it on the node) — not built.
- 2026-09-27 (23.11): **observing sockets.** `tl_game_observe` / `__thirdlightObserve()` report `sockets: [{entityId, target, node, position}]` (the drawn world position) while any object rides on a socket; the worker sends the list in the frame state only when it changes (`FrameState.sockets`).
- 2026-09-27 (23.12): **`ctx.materials`, keyed by object and parameter key.** `set(entityId, param, value, materialId?)` / `get` / `reset(entityId, param?, materialId?)` / `setData(entityId, param, x, y, w, h, bytes, materialId?)` / `getData`; a call applies to every graph material the object wears (its `materials` mapping over its model asset's default mapping, as the renderer resolves it) that declares the key as public — the optional `materialId` limits it to one. Private parameters stay the material's own (as for `materialParams`). `value` is typed `unknown` in the script API so one visual-script node takes any value type; the runtime checks it against the declaration (float/vec2–4 in range, `#rrggbb`, a texture asset of the game's closure or ""), refusing with `false`. `get` answers the effective value (script value, else the object's authored override, else the default). A texture a script names must travel with the game (referenced by a material, an override or a script property — the closure has no way to see script strings); the runtime refuses others. Last member of `BehaviorContext`, so the generated typings and catalogue only gain entries (5 Materials nodes); the generator gained `@graphType <arg> list` on a method (a parameter carries no tags of its own) for `setData`'s bytes.
- 2026-09-27 (23.12): **values are simulation state.** `RuntimeMaterials` (runtime `material-params.ts`) holds them per object; writes apply in call order and reads see them at once; a new run starts from the authored values; objects that leave (unload, destroy) take theirs along. The step digest includes them only while any is set (existing digests unchanged). The catalogue it checks against (graph materials with a public parameter, model assets' default mappings, the closure's textures) is a new optional snapshot field `materialCatalog`, built from the verified manifest by Play and the export (`materialCatalogOf`); no manifest or buildId change. Engine limit 4,096 writes per step (as `ctx.grid`).
- 2026-09-27 (23.12): **renderer diffs.** `Runtime.takeMaterialChanges()` gives one change per changed (object, material, key): the latest value, a `clear` back to the authored value, or a data parameter's whole grid (≤ 16 KiB: three re-uploads a whole data texture on change anyway, and a whole grid coalesces trivially in the worker mirror, where rectangles would need a copy of every grid). In threaded Play they ride the worker frame (`FrameState.mat`, the grid bytes as a transfer), coalesced per key on the page until the adapter takes them.
- 2026-09-27 (23.12): **per-object values without recompiles.** Numbers, vectors and colours go on the object's meshes (`userData.__tlMaterialRuntime`, a colour pre-converted to linear) and the existing per-object uniforms read them before the authored override (the library records which material id each compiled digest stands for, `__tlMaterialIds`): the compiled material stays shared and no program is added (e2e: one compiled graph material for both boxes; programs and draw calls unchanged while values keep changing, WebGL 2 and WebGPU). A texture value takes the phase 18.3 texture-override path (a compiled variant, same program). Objects carrying script values leave automatic instancing like objects with `materialParams`. Block-layer chunk meshes are not addressable by object (a layer's cells are one object's; a data parameter on an overlay mesh covers the per-cell case).
- 2026-09-27 (23.12): **the data parameter.** New parameter type `data` (appended last) with a required `size` [w, h] (1–64, `MATERIAL_DATA_MAX`, engine limit: 16 KiB per object) and a default of 4 bytes every cell starts with; not overridable by `materialParams` (scripts write it). New port type `data` feeding only the new **Sample data** node (Textures; material graphs only — a function has no data inputs): address by UV (cell [0, 0] at UV (0, 0); floor(uv × size)) or by integer cell, clamped to the grid, read with an exact texel load (no filtering or mipmaps; channels byte/255) in both stages. The compile makes a placeholder data texture holding the starting cells; a public parameter's load node picks the drawn object's own data texture per object (a `TextureNode` whose update runs per object; the object group is per render object on both backends, so each object keeps its own binding). The adapter makes an object's texture on its first change and updates it in place (a reset writes the starting cells into it), so a binding never switches back to the placeholder; the object's texture starts one version past a fresh placeholder so three's generation check always rebinds on the first swap.
- 2026-09-27 (23.12): **editor.** The material document's parameter list offers `data` with a size field (default 8 × 8 for a new one) and the 4-byte default; the Inspector's object overrides skip data parameters. Covered by `material-runtime.e2e.ts` (both projects), which also checks the Scene view (both objects in the default tint), Play and the static export in pixels (the 4 × 4 checker cell by cell, bottom-left origin).
- 2026-09-27 (23.3): **pointer samples are input.** `ActionFrame.pointer`
  (optional: `x, y` 0–1 of the view from the top left — the camera's screen
  coordinates — `dx, dy` in view fractions, `wheel` in notches, `buttons` /
  `pressed` / `released` masks 1 left, 2 right, 4 middle, `over`, `locked`),
  quantized to 1e-4 by the browser owner and strictly validated (old frames
  and replays stay valid; nothing changes until a pointer is seen). The
  runtime keeps the pointer between samples (a relay or recording may be
  sparse: position and held buttons hold, no movement, no edges) and derives
  the edges (pressed/released from the held mask as well as from the sample —
  a click between two samples still counts; `entered`/`left` from `over`), so
  modules and scripts see a complete pointer. The worker's tick source spends
  movement, wheel and edges on the first step of a tick and adds them up when
  two samples meet before a step; action values that are amounts per sample
  carry `i: 1` for the same rule (a mouse-look axis would otherwise count
  twice at 120 Hz steps).
- 2026-09-27 (23.3): **pointer bindings and hover edges.** Binding kinds
  `pointerButton {button}`, `pointerAxis {axis: x|y|wheel}` (movement in
  percent of the view per step, so 1 % a step drives like a full stick; up
  positive like a stick), `pointerPosition` and `pointerDelta` (axis2d, not
  clipped to length 1). "Hover edges" in the engine are the pointer entering
  or leaving the view; which object is hovered is a pick the script compares
  with its last one — a per-object hover state in the engine would need a
  pick every step for every project and one filter for all scripts.
- 2026-09-27 (23.3): **cursor.** `content.input.cursor {gameplay?, ui?}`
  (free/locked, absent free: a pointer-driven game needs a visible cursor;
  mouse-look opts in). The host resolves the mode every frame: the ui map's
  while a menu is open or the game is paused, else a script's request
  (`ctx.input.setCursor`, simulation state carried per frame from the worker,
  cleared at a run start), else the gameplay map's. The browser owner locks
  (pointer lock, asked again on the next click in the view because browsers
  want a gesture), releases and hides the cursor (locked, or a gamepad used
  last — pointer movement counts as the keyboard/mouse device) and reports
  `data-tl-cursor` / `data-tl-pointer-lock` / `data-tl-cursor-hidden`. A
  locked pointer's position is the view's centre. Real pointer lock was not
  exercised in a browser (unit tests with fake DOM; owner look pending on a
  desktop).
- 2026-09-27 (23.3): **script queries (3D).** New `PhysicsStepClient`
  members appended after the 2D ones (the 2D methods, their graph nodes and
  types are unchanged): `raycast3d`, `overlapSphere`, `overlapBox3d`
  (rotation), `overlapCapsule`, `pickAt`, `pickAtPointer`; vectors as
  `[x, y, z]` arrays so `ctx.camera.screenToRay` chains into them; hits
  `{entityId, point, normal, distance}` — the hit collider's entity, so a
  23.5 block-layer chunk collider is reported by its entity and `ctx.grid`
  can map it to a cell later. Filters `{tags?, layers?, exclude?}`: tag
  names resolve like `ctx.tags.mask` (unknown = script error). Budget 64
  queries a step for all scripts (twice the 2D plane's 32: a 3D scene picks,
  tests line of sight and probes several objects a step), then nothing,
  warned once. Without a live virtual camera `pickAt` and
  `ctx.camera.screenToRay/worldToScreen` use the scene camera's current pose
  (the brain answered with a default pose before). Graph nodes generated
  (Raycast 3D, Overlap sphere / box 3D / capsule, Pick at screen point /
  pointer, Pointer, Pointer pressed / released / held, Set cursor); no
  existing node changed.
- 2026-09-27 (23.3): **collision layers** are project data:
  `content.collisionLayers` (≤ 15 names; "default" implicit — bit 0), op
  `setCollisionLayers {layers}` (whole list, undoable), collider `layers`
  (v4, 1–16 names, checked against the list in the project composition;
  refused on the 2D plane, which is unchanged). The manifest carries the list
  (`collisionLayers`, after `input`; absent keeps every existing buildId).
  Rapier groups: a collider is a member of its layers and filters nothing,
  so contacts and the character's sweep are unchanged; a query's groups are
  all memberships filtering to the named layers; tags and exclusions are the
  query's predicate. Editor: a Collision layers list under the tags
  (File → Project tags); the collider's field comes from its descriptor.
- 2026-09-27 (23.3): **a 3D world without a player.** `physics3DConfigOf`
  returns a `noCharacter` config (a disabled placeholder capsule; its step
  poses movers and updates the world) when the start scene has colliders but
  no controller — a pointer-picked scene need not have a player; with
  neither it stays null. Module resolution wants the 3D backend for a
  collider in 3D too. Colliders that only arrive with a later-loaded scene
  do not make a physics world (as before).
- 2026-09-27 (23.3): **relay fixes found on the way:** the MCP
  `tl_input_exercise` dropped `actions`, and the backend→editor relay event
  and the preview bridge stripped/refused them; `actions` and `pointer` now
  travel end to end (validated by the backend's relay parse). Observations
  gain `pointer`, `cursor` and `hidden` (the objects scripts hid).
- 2026-09-27 (23.3, after 23.5): **a 3D hit on a block layer maps to its
  cell.** A block layer's chunk colliders (`<layer>#blocks:<chunk>:<piece>`)
  are reported by the layer's entity id in every 3D query (hits, overlaps —
  once — and the tag/exclude filters), and a hit carries `cell: [x, y, z]`,
  the cell just inside the surface (1 mm behind the hit along the normal —
  `ctx.grid` coordinates, the same cell `ctx.grid.pick` finds on that ray).
  So `ctx.physics.pickAtPointer()` picks cells too (no separate
  `ctx.grid.pickAtPointer`: `ctx.grid.pick(ctx.camera.screenToRay(...))`
  covers grid-only picks). Chunk colliders are triangle meshes, so an
  overlap finds a layer where the volume crosses its surface, not deep
  inside it. A 3D scene whose only collision is a block layer gets a physics
  world (and the 3D backend) too.
- 2026-09-27 (23.19): **schema as project data.** `content.saveSchema` (v4, optional, absent = no project saves and every existing project's bytes, manifests and digests unchanged): `version`, `slots` (1–99, engine limit), `migrations [{from, name}]`, `sections`, `thumbnail`, `settings [fields]`; one command `setSaveSchema {schema | null}` (whole object, one undo step), a **Saves** bottom tab, manifest key `saveSchema` and snapshot field `saveSchema` (only when declared). The flow's platformer save (`game-host/src/save.ts`, slots auto/1–3) is untouched and not extended (owner rule 10); a project with a schema reads `tl_play_start` `saveSlot` 1–99 as its own slots (`auto` stays the flow's).
- 2026-09-27 (23.19): **migrations are script functions registered by name.** The schema lists `{from, name}` per older version; a behavior registers `ctx.saves.migration(name, fn)` (the last registration counts, cleared at a new run). A load runs them one version at a time in the simulation at the load's step boundary; a missing registration, a throwing function or a non-JSON result refuses the load and changes nothing. Chosen over 23.7 library exports because a library is linked into each behavior bundle (no runtime handle to call it by name) — a registration works in page, worker and replay alike. Engine sections have their own format version and are not migrated by the project.
- 2026-09-27 (23.19): **sections are all opt-in**: `grid` (`ctx.grid.diff()`; restore = every layer back to authored, then the diff, atomic, not counted against the 4,096-writes limit), `materials` (script-set values per object/material, data grids whole), `spawned` (each copy's prefab, ids and root placement — restored at the next step boundary with the same `spawn-<n>` ids; children keep prefab-local transforms and their scripts start fresh: the runtime has no behavior-state checkpoint), `storage` (`ctx.save`). Opt-in because each costs bytes and a game may keep the equivalent in its own document; a section the schema includes but a save lacks resets to the run's start. Play time is always saved (`playSeconds`, restored with a load).
- 2026-09-27 (23.19): **storage enters as input.** The runtime never touches storage: requests leave like sounds (`takeSaveRequests`; the worker's `FrameState.saveReq`), and the host's answers — the slot list, save/delete outcomes, a loaded document — enter as `ActionFrame.saves` entries of the next sampled step (`queueSaveEvent`; worker command `saveEvent`), like 23.8's debug commands, so a recording replays them and page/worker agree (pinned by an integration test with a recorded load). `savedAt` is the player's clock, stamped by the host. A save is assembled at the end of the step it was asked for; a load is restored at the end of the step its answer arrives (so a migration registered in that step, e.g. at a `tl_play_start` load in step 1, exists). The step digest gains the saves state only for a project with a schema once it is used.
- 2026-09-27 (23.19): **IndexedDB for slots, localStorage for settings.** 99 slots × 1 MiB exceed localStorage's ~5 MB per origin, so slots go to IndexedDB (`thirdlight-saves`/`kv`; per slot a metadata record, the body with an FNV-1a checksum, and the thumbnail — the list reads records only); without IndexedDB they last for the page (memory). The settings document (≤ 64 fields) must be known before step 0 (it is injected into the runtime like 23.8's variables), so it stays in synchronous localStorage next to the flow's settings. Caps: 1 MiB JSON per slot (UTF-8), thumbnail ≤ 64 KiB data URL, ≤ 512 px a side (default 256 × 144 JPEG, captured by the adapter right after a render in the same task), 8 requests per step, 16 entries per frame. Settings fields may drive an engine setting (music/sfx/ui volume through the audio owner's buses, quality through the renderer), applied at start and on every change.
- 2026-09-27 (23.19): **observing.** `tl_game_observe` / `__thirdlightObserve()` report `saves {slotCount, storage, slots (first 32 used, picture type/size, keeping the 16 KiB observation bound), settings}`; the picture itself is `__thirdlightSaveThumbnail(slot)` on the game page (a load screen of 23.9a's project UI can bind it; not wired here because 23.9a is not on main yet). The ctx.saves API adds 14 visual-script nodes (Saves category); `migration` is code-only.
