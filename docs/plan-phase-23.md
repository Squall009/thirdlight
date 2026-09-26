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
| 23.1 3D physics world, colliders, triggers | next |
| 23.2 3D character controller | planned |
| 23.3 Pointer input and 3D queries | planned |
| 23.4 Camera framework | planned |
| 23.5 Block layers — core | planned |
| 23.6 Block layers — editor | planned |
| 23.7 Scripting conveniences | planned |
| 23.8 Test and debug entry points | planned |
| 23.9a Project UI — runtime | planned |
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
