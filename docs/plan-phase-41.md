# Phase 41 — One physics backend; 2D as a plane you can switch to at any time

Status: planned 2026-10-21.

Goal: every project and scene runs on one physics backend, Rapier 3D. "2D" is
no longer a kind of project. It is a **plane constraint** on objects, which a
game can switch on and off at any moment, even mid-scene. A 3D platformer
where the player goes down a pipe, the world locks to a 2D plane, and later
opens back into 3D just works, with no reload. This removes the second
backend and the roughly 365 places the code branches on the project's
dimension. Read `docs/roadmap.md` and `docs/decisions/0005-3d-physics.md`
first.

## 1. Owner decisions (2026-10-21)

- **One physics backend for everything.**
  - The 2D backend (`rapier2d-compat`, `physics-rapier/src/port.ts`) goes.
  - So does the project setting `physics_dimension`.
  - Decision 0005's reason for two backends was that 2D replays and step
    digests would change. That reason is accepted as a one-time cost: 2D
    games re-baseline their digests once.
- **Switching between 3D and a 2D plane is seamless and possible at any
  time**: per object, mid-scene, with no reload and no hitch (the Mario-pipe
  case).
- **Why:** less complexity when designing features and maintaining them.
  - Every feature has been built twice (colliders, triggers, movers, queries,
    character controllers) or only for one dimension. Terrain, scatter,
    splines and architecture don't collide in 2D.
  - Phase 38.9 had to write a plane cut so blocks collide in 2D.

## 2. Design

**A decision record, 0007, supersedes 0005.**

### The plane constraint

- An object's body can be locked to a **plane**: an origin and an axis-aligned
  normal (world X or Z).
  - It can't move along the normal.
  - It can only rotate about the normal.
- In Rapier 3D this uses per-body locked translations and rotations (the
  plane's depth is held by a position correction). Default chosen, owner to
  confirm: **axis-aligned planes only**, since rotated planes need a joint
  frame. That covers side-scrollers and Mario-style sections. An arbitrary
  plane is a later extension.
  **Confirmed by the owner 2026-10-22.**
- Set it with:
  - a `plane` field on the body and character components (static, kinematic
    and dynamic bodies, and characters);
  - a scene-level **default plane**: new objects in a 2D-style scene get it,
    and the editor's gizmos and Scene view lock to it;
  - scripts at runtime: `ctx.physics.setPlane(id, {axis, origin} | null)` and
    `ctx.character.setPlane(id, …)`.
- **Switching.**
  - Locking an object snaps it onto the plane (its position along the normal
    is set to the plane's).
  - Its velocity along the normal is zeroed and its rotation reduced to the
    plane's axis.
  - Unlocking frees all six degrees of freedom.
  - Both take effect at the step boundary (deterministic, page and worker
    equal).
  - Camera and input changes are the game's (`ctx.camera`, input maps). The
    engine provides the primitives and doesn't decide a "2D camera".

### Shapes

- Every collider shape is a 3D shape. The 2D shapes become thin 3D shapes:
  - a 2D box is a box with a depth (default 1 m, set per collider);
  - a polygon is an extruded convex prism (or a compound of prisms for
    concave outlines);
  - a circle is a cylinder along the plane's normal.
- 3D shapes work against plane-locked bodies as is. Terrain, block layers,
  scatter, splines and architecture collide everywhere.
- The block plane cut (38.9) is removed.
- **One-way platforms and drop-through** are a filter in the character
  controller and the contact pipeline, on contact normals against the
  platform's "up". They work in 3D too: one-way floors in a 3D game.

### Character controllers

- **One controller system on the 3D port.**
- The 2D platformer controller's behaviour moves onto it as a movement
  profile on the same controller:
  - autostep;
  - jump buffering and coyote time;
  - wall slide and wall jump;
  - climb volumes;
  - one-way platforms;
  - movers carrying the character.
- Behaviour is kept within measured tolerances (jump heights, run speeds,
  slope limits, stair steps, mover carry). Any movement profile works in
  either mode.

### Queries and API

- **One `ctx.physics` surface.**
  - `raycast` and `overlap*` take Vec3.
  - The Vec2 forms stay as conveniences on a plane: z comes from the caller's
    plane or 0.
  - The "3D projects:" caveats in the typings go.
- **One set of trigger, mover and door components** (3D shapes, optionally
  plane-locked). The 2D-only switches become generic.

### Editor and data

- **Editor:** no dimension filtering. The Inspector shows every shape. A scene
  with a default plane gets the plane-locked gizmo and a side view preset.
- **Data:**
  - `physics_dimension` is retired.
  - Projects upgrade on load to a new schema version (8). A 2D project's
    scenes get a default plane (Z axis at z = 0). Its colliders become
    their 3D forms with the default depth.
  - The default input maps and the audio panning default move to the scene's
    plane setting.

### Bodies outside the loaded world (owner, 2026-10-21)

Streaming loads collision only around the camera, its target and players.
- A dynamic or kinematic body (an NPC, a prop, a future ragdoll) that is not
  over loaded collision is **suspended**: no gravity, no movement and no
  contacts. Its state is kept.
- It resumes in the step its area's collision arrives.
- This is one rule in the physics bridge, deterministic and the same on page
  and worker.
- Diagnostics count suspended bodies, and a script can read whether a body
  is suspended.

### Telling game teams what to migrate (owner, 2026-10-21)

Every upgrade on load writes a Problems line for each converted item, so a
game team can review and fix it properly in the unified system. Converted
items include:
- a 2D collider (with the depth it was given);
- a polygon split into prisms;
- a one-way platform;
- a 2D trigger, mover or switch;
- the project's former 2D setting.

Each line names the object and the new field to check. The lines stay until
the item is saved in its new form. Lines are grouped by kind, so a large
project gets a readable list, not thousands of rows.

### Export and removal

- One physics wasm ships.
- `rapier2d-compat`, `port.ts`, the 2D character package (after its
  behaviour moves), the 38.9 plane cut and the dimension branches are
  removed.

## 3. Items

**E2E budget (D253):** no new e2e file; e2e files that drive 2D projects are
rewritten, not duplicated. Behaviour parity is tested in vitest/integration
with real Rapier on page and worker.

| Item | What |
|---|---|
| 41.0 | **Release checks; decision record 0007** (supersedes 0005). **Measure first:** step cost and memory of today's 2D backend on the 2D classes and Sprout-shaped fixtures, as the baseline. |
| 41.1 | **The plane constraint** on the 3D port: per-body lock, switching at step boundaries, snapping and velocity projection, `ctx.physics.setPlane`. Tests: lock, unlock and re-lock mid-run, page and worker equal. |
| 41.2 | **2D shapes as 3D shapes**: box depth, polygon prisms (convex and concave), circle cylinders, one-way platforms and drop-through in the controller and contact filtering. |
| 41.3 | **One character controller:** the platformer behaviour as a movement profile on the 3D controller, plane-aware. A parity suite against the 2D controller's recorded behaviour (jump apex, air time, run speed, slopes, stairs, wall moves, climb, one-way, movers) within stated tolerances. |
| 41.4 | **One query, trigger, mover and door surface:** `ctx.physics` Vec3 with Vec2 conveniences, unified components, switches made generic, typings without dimension caveats. |
| 41.4b | **Suspend bodies outside loaded collision** (above): one rule, tests with an NPC walking out of the rings and back, page and worker equal. |
| 41.5 | **Scene default plane, editor and upgrade:** retire `physics_dimension`; scene plane setting; schema 8 upgrade of 2D projects (fixtures shaped like Sprout's); the Inspector without dimension filtering; gizmos locked to a scene's plane; templates updated (the 2D starter becomes a scene with a default plane). |
| 41.6 | **Remove the 2D backend:** `rapier2d-compat`, the 2D port, the old 2D controller package, the 38.9 plane cut, dimension branches (target: none left outside the upgrade code); export ships one wasm; the licence list updated. |
| 41.7 | **The pipe test (acceptance scene):** a 3D level where the player enters a pipe, the game locks player and level section to a plane (camera to a side view by script), plays a 2D stretch (one-way platforms, movers, a block-built floor), and leaves back into 3D. No frame over 16.7 ms at the 60 Hz cap during either switch. A how-to guide built from it. |
| 41.8 | **Performance:** 2D-style scenes on the 3D backend within 10 % of the 41.0 baseline step cost; download size change recorded. |
| 41.9 | **The manual and migration notes:** 2D and 3D concepts rewritten ("planes, not project kinds"), the controller profiles, one-way, the upgrade (what changes for 2D games, digests to re-baseline). |
| 41.10 | **Acceptance** in a real browser on both renderers at the cap: the pipe scene and an upgraded 2D project. Owner look pending. Full gate, then the phase review. |
| 41.11 | **Review fixes.** |

**Done when:**
- One physics backend.
- Any object can be switched between free 3D and a plane at any time, and
  the pipe scene is seamless.
- 2D projects upgrade on load and play within the parity tolerances.
- No dimension branches are left outside the upgrade.
- `tools/gate.sh full --both-renderers` is green.

## 4. Progress

| Item | Status |
|---|---|
| 41.0 | Done. three.js 0.186.1 still latest. Rapier 0.21.0 code-compatible (suites green) but not taken: wasm 1974→3010 KiB (soft bodies/FEM), step +25–60 %; pin stays 0.20.0 (0007 §9). Decision 0007 written, 0005 superseded. Baseline (`~/.cache/thirdlight-phase41/baseline.md`): 2D full step p50 small 0.044 / medium 0.105 / script-heavy 0.039 ms; physics-only side-scroller (`run.mjs plane-step`) 2D 0.037 ms (1 level) / 0.056 ms (4), same layout on 3D 0.053 / 0.106 ms (1.4–1.9×); export wasm 2D 1451 KiB (541 gzip), 3D 1974 KiB (744 gzip). No e2e touched. |
| 41.1 | Done. Plane lock on the 3D port (`plane3d.ts`): statics made/snapped on the plane, movers posed on it, characters' moves and depth held exactly, Rapier locks + position correction for dynamic bodies (port-level: the engine has no dynamic bodies yet). `plane` on collider/controller; `ctx.physics.setPlane/planeOf`, `ctx.character.setPlane`, applied at step boundaries. Tests: port (lock/unlock/re-lock, mover, dynamic stack, two runs equal), model, integration page+worker+2 page runs digests equal. `plane-step` p50 1 level 3D 0.052 → plane-locked 0.057 ms, 4 levels 0.109 → 0.113 ms (2D 0.037 / 0.061). No e2e touched; fast gate green (9 min). |
| 41.2 | Done. `shape2DTo3D` (project-model `shape-2d-3d.ts`, the mapping 41.5's upgrade calls, with a change list per converted shape): box without `hz` → box `depth` deep (collider `depth`, default 1 m), polygon → convex prism or compound of prisms (`convexPieces`: ear clipping + Hertel–Mehlhorn, deterministic, ≤ 32 corners), circle → `cylinder` (new 3D primitive in model, runtime and port) along the plane normal. 3D projects take depthless boxes, polygons and `oneWay`. One-way on the 3D port (`oneway3d.ts`): the character sweep filter and drop-through (`dropThrough`, down + jump routed to the 3D port), and `OneWayContacts` hooks for dynamic bodies (port-level). Tests: model (decomposition L/U/comb tile exactly, cylinder axis Z/X), port (land from above, pass from below and the side, drop-through, free and on a plane, turned one-way wall, dynamic ball, cylinders), integration 2D port vs plane-locked 3D port on box/ramp/concave/one-way (worst 5.8 mm, tolerance 10 mm), game host 3D project shelf + drop-through + prism ramp. `plane-step` p50 plane-locked 1 level 0.057 → 0.055 ms, 4 levels 0.113 → 0.115 ms (noise). No e2e touched; fast gate (colliders, physics-3d) green, 9 min (D307 watch hit once, passed alone). |
| 41.3 A | Done (part A). Reference traces of the 2D controller (`fixtures/phase41/platformer-traces/`, 11 Sprout-tuned side-view cases: jump apex/hop, run, slopes, slope slide, stairs+autostep, wall slide/jump, ladder, one-way+drop-through, lift, sideways platform, coyote+buffer; per step x, y, vx, vy, grounded, state; `tests/integration/m41-platformer/`, reproduced exactly, `TL_RECORD_TRACES=1` re-records). `profile: 'arcade'` on the 3D controller (`runtime/src/character-arcade.ts`): the 2D algorithm in its order on the 3D port, same tuning fields. Plane-locked vs the traces, worst in-plane: jump 8 mm, run 14, slopes 10, slide 8, walls 2, climb 7, one-way 2, coyote/buffer 1.3, side platform 33 (carry a step early), lift 64 (walk-off), stairs 1.0 m (3D step-up climbs earlier) — part B's to fix. X plane = Z plane within 10.2 mm. E2E: one assertion in `character-3d.e2e.ts` (the 3D Inspector now shows Profile and Autostep), no step added. Fast gate (character-3d, colliders) green after that fix, 9 min. |
| 41.3 B | Done. Parity suite `tests/integration/m41-platformer/parity.test.ts`, tolerances in `PARITY`: the 2D trace's key events (grounding/state changes) in order on the same step (±1 allowed, 0 measured) within 1 cm; every step within 1.5 cm of the 2D path ±1 step; the controller's velocity equal (1e-6) but at the stairs' last edge and the lift's edge; apex, air time, run speed, slope stops, stair treads (±1 step), wall slide/jump, ladder, one-way, carry. Fixes: arcade step-up by the 2D rule (`autostepRide`, `physics-rapier/src/3d/step-up3d.ts`), at a rising mover's edge it rests, 3D spawn clearance's one-way rule, D321 (not the port). Worst event / path (mm): jump 8.3/8.3, run 0/12.6 (the 2D's own 1.1 cm bumps), slopes 0/10.1, slide 0/7.7, stairs 0/10.0 up to the stop and 43.8 at rest (≤ 50), walls 1.9/1.9, climb 5.2/5.9, one-way 0/1.9, lift 1.4/1.4, side platform y 0.1, x 33.3 = the 2D port's 4 stalled carry steps (3D carried on every step), coyote 0.4/1.3. `plane-step --arcade` p50 1/4 levels: 2D 0.060/0.085, 3D plane-locked 0.113/0.156 ms (41.0 2D baseline, no autostep, 0.037/0.056; 41.0 3D/2D 1.4×/1.9×, now 1.9×/1.8×). No e2e touched (character-3d + colliders 3.0 min). Fast gate green, 9 min, 4.0 GB. |
| 41.4 | Done. One `ctx.physics` surface: `raycast`/`overlapBox` take `[x, y, z]` (world) or `{x, y}` on the caller's plane (its object's lock, else z = 0), `overlapCircle` a disc on it; filters on every form; typings without "3D projects:" caveats; nodes Set plane, Set character plane, Plane of. Switches, circle and `[w, h]` triggers work on the 3D port unchanged (no data moves); `blocks2DTo3D` (project-model) gives 41.5 the Problems notes. Tests: integration (game host, page = worker, free and z-plane, X-plane queries), model, catalogue. E2E: create-menu 3D step +1 entry (2.7 → 2.9 s), blocks 9.4 → 9.7 s. Fast gates green, 10 min, 4.1 GB (D307 hit once, passed alone). |
| 41.4b | Done. Bodies outside loaded collision suspended (`runtime/src/body-suspension.ts`, `SimWorldStream.loadedAt`, port `suspendCharacter`): characters, patrols, gravity bodies; state kept, resume in the step the ground's collision arrives; `ctx.physics.isSuspended`, node Is suspended, `runtime.worldStream.suspended`. Tests: integration `m23-3d/suspended-bodies` (NPC + falling rock held while the player is away, rock resumes with its fall speed to 1e-6, NPC waits at the loaded edge and walks on; page ×2 = worker digests), port, loaded-column unit. No e2e touched (physics-3d + primitives 2.9 min). Fast gate green, 9 min, 4.0 GB; village at the cap 0 missed on both renderers. |
| 41.5 A | Done (part A). `physics_dimension` retired (refused; `physicsDimensionOf` is 3: every build runs on the 3D port). Scene `defaultPlane` (scene data, `setScenePlane` op, one undo): bodies without their own `plane` take it at the scene→runtime boundary, `{x, y}` queries fall back to it (manifest scene row `plane`), a start scene's plane picks the side-view input and audio defaults. Upgrade = recorded step `planes` of 8 (`upgrade-planes.ts`, marker in project.json `upgrades`; 7s and pre-step 8s alike, once): Z plane, `shape2DTo3D` 1 m, `profile: 'arcade'`, `blocks2DTo3D` and plane-cut notes, prefab bodies their own plane; per-scene `migratedFrom2D` notes → grouped Problems lines (`migrated_from_2d`), each cleared by the edit that saves its component. Test `m41-platformer/upgrade.test.ts` (HTTP, Sprout-shaped schema-7 2D project: upgraded files, grouped lines, export's scenes play jump/slopes/one-way/movers within `PARITY.path`, edit clears, reopen idempotent, pre-step 8 gets it once); a copy of Sprout opens upgraded (17 scenes, 11 boxes, 52 prisms, 12 one-way, 1 controller; 11 grouped lines). E2E: no file added; 2D-only steps dropped (physics-3d settings field, colliders' refused 2D switch, create-menu's 3D test folded into the first: one backend fewer), labels to the 3D presets (inspector, menus). Fast gate: vitest green (scan-bounded-log failed once under load, passed alone), e2e 8.1 min, 9 fixed then rerun green; 4.1 GB. |
| 41.5 B | Done. Descriptors without `dimension` tags: every shape (Box, Flat box (depth), Polygon (prism), Sphere, Capsule, Cylinder, Hull, Mesh), One-way platform, depth, plane, profile in every project; flat shapes drawn as their solids. Window → Scene settings (axis none/Z/X + origin → `setScenePlane`), bodies on a plane held by the gizmo (no normal arrow, only the normal's ring), toolbar "side view"; `queryProject` rows carry `plane`. 2D starter = plane scene: 1 m deep boxes, setup sets Z plane + arcade (ids kept); templates take no `planes` step. Acceptance: `~/.cache/thirdlight-phase41/acceptance/41.5-starter-{editor,play}-{webgpu,webgl2}.jpg` looked at (same level both renderers, side view across the plane); owner look pending. E2E: no file added; 2D-preset steps rewritten in 17 files; 13 touched files 158.8 → 158.7 s vs phase 40's full gate (colliders' outline test +1.4 s for the plane gizmo/side view steps). Fast gate green, 10 min, 4.1 GB; village 0 missed both renderers. |

## 5. Decision log

- 2026-10-21: Planned from the owner's choice: one backend, a plane switchable
  at any time (Mario-pipe case), to cut complexity. Default chosen, owner to
  confirm: axis-aligned planes only for now.
  **Confirmed by the owner 2026-10-22.**
- 2026-10-25 (41.0): Rapier 3D stays at 0.20.0. 0.21.0 needs no code change, but
  its npm build ships soft bodies and the FEM solver: +1,036 KiB raw / +397 KiB
  gzip of WASM and a slower step on the side-scroller bench. Taken later as its
  own item if a release is a drop-in in size and cost or a feature needs it.
- 2026-10-25 (41.0): the 3D-on-a-plane prototype runs at port level only
  (`tools/perf/plane-step.ts`): 1.4× the 2D step at one level, 1.9× at four.
  41.8's 10 % target is against the full runtime step (medium 0.105 ms), so
  41.8 profiles the 3D port's per-step work (movers, queries, broad phase) first.
- 2026-10-25 (41.0): the headless sim bundle loaded the root's transitive
  rapier3d-compat 0.12.0 (from `@types/three`), not the package's 0.20.0 pin,
  so earlier headless 3D sim numbers were on 0.12.0. The perf bundler now
  resolves `@dimforge/*` from the importing package.
- 2026-10-25 (41.1): default chosen, owner to confirm: a plane is `{ axis: 'x' | 'z', origin }`
  with `origin` a number (where the plane lies along its normal), not a point: an axis-aligned
  plane needs nothing else. `ctx.character.setPlane(id, plane)` takes the id first as the plan
  writes it (absent or null: the first player), unlike its siblings' id-last order.
- 2026-10-25 (41.1): the engine has no dynamic bodies (verdict 2026-10-04); the lock is
  body-type-agnostic (`lockBody`/`holdOnPlane`) and tested on a Rapier dynamic stack at port level.
  A dynamic-body component is its own future item, not part of this phase.
- 2026-10-25 (41.1): default chosen, owner to confirm: locking a child object snaps its body only;
  its transform stays where its parent puts it (a root object's transform snaps with its body). A
  script-set plane lasts until changed, the object leaves the game or the run restarts.
- 2026-10-25 (41.1): `setPlane`/`planeOf` have no visual-script nodes yet (a plane is an object or
  null, which the node generator does not flatten); 41.4 (one query surface) or 41.7 adds them.
- 2026-10-25 (41.2): default chosen, owner to confirm: a 2D shape's 3D depth is the collider's
  `depth` (m, absent 1 m, at most 128 m), centred on its plane. A 2D outline on an X plane stands in
  Y/Z with its x along −Z (right of a camera on the plane's +X side looking back, as x is right of
  one on +Z) and its depth along X. The orientation comes from the collider's authored plane only: a
  plane a script sets later moves the body and never reshapes it.
- 2026-10-25 (41.2): default chosen, owner to confirm: one-way is decided by position, not by the
  contact normal: a one-way collider holds a shape only while the shape's lowest point along the
  collider's local +Y is at or above its top (within the 2D tolerance, 0.06 m) and the shape is not
  moving up through it. A normal test catches a character that is half way through on the
  platform's top face. "Up" is the collider's own +Y, so a turned one-way box is a one-way wall.
- 2026-10-25 (41.2): 3D projects now accept a box without `hz`, a polygon and `oneWay` (refused
  before; additive). The model's polygon stays convex with ≤ 8 corners, so the 2D port is unchanged;
  concave outlines reach `shape2DTo3D` from code (the upgrade, `_COL` outlines). The model has no 2D
  circle collider: `shape2DTo3D` takes `{ type: 'circle' }` for the upgrade and later use.
- 2026-10-25 (41.2): the contact-pipeline one-way filter (`OneWayContacts`, Rapier
  `filterContactPair` hooks) is port-level like 41.1's dynamic lock: the engine has no dynamic bodies.
  Rapier runs hooks only in a step with an event queue. Not done here: 3D spawn clearance still counts
  one-way colliders (the 2D probe ignores them; 41.3), and the editor draws a depthless box or polygon
  in a 3D project as its 2D outline (41.5).
- 2026-10-25 (41.3): default chosen, owner to confirm: the movement profile is `controller.profile`,
  `character` (default) or `arcade`. "platformer" is genre vocabulary the engine's boundary check
  refuses in package source; `arcade` names the feel (one speed, the same acceleration in the air, a
  jump cut that ends the rise). The arcade profile reads the 2D controller's fields with their
  meanings (acceleration, deceleration, coyoteTime, jumpBuffer, jumpRelease, groundSnap, skin,
  autostep, autostepHeight, climb and wall fields), so 41.5's upgrade only adds `profile: 'arcade'`;
  it ignores walkSpeed, airControl, stepHeight and ledge climb, does not raise the ground snap to the
  step height, and does not face its movement unless `faceMovement` is set. The Inspector now shows
  Autostep in 3D projects too.
- 2026-10-25 (41.3): default chosen, owner to confirm: on a plane the arcade profile reads the move
  input's x along the plane's right (+X on a Z plane, −Z on an X plane), whatever the camera; free in
  3D it reads the move as the character profile does (`moveFrame`). Its acceleration rule (up while
  below the target, down while above) runs per axis on +X and −Z, so a Z plane and an X plane move alike.
- 2026-10-25 (41.3): free in 3D the arcade profile presses a resting character down by one step of
  gravity, as the character profile does (without it a free runner sank 3.7 cm into the floor); on a
  plane it stages none, as the 2D controller did (the press moved ledge and stair timing up to 0.9 m).
  D321: free, a drop-through of a 1 m deep one-way shelf pushes the character 0.5 m along the depth.
  Not done in A: 3D spawn clearance still counts one-way colliders (41.2's note), the parity suite.
- 2026-10-25 (41.3 B): the parity tolerances (owner to confirm): key events on the same step within
  1 cm, every step within 1.5 cm of the 2D path a step either side (the 2D port's own flat-ground
  bumps reach 1.1 cm), the controller's velocity equal; per measure 1 cm, timings ±1 step (8.3 ms).
  Two cases are held otherwise, for the 2D port's own reasons: the stair rest within 5 cm (each
  riser's ride over the edge amplifies the last millimetre; the slide off the last edge starts a step
  later), and the sideways platform within the 2D's 4 stalled carry steps (33 mm: Rapier 2D read the
  platform's top as tilted and stopped the carry; the 3D port's sweep fixes that), the 3D carried on
  every step the 2D was.
- 2026-10-25 (41.3 B): default chosen, owner to confirm: under the arcade profile the 3D port climbs
  steps by the 2D rule (`autostepRide`, Rapier's stair rule on the port's own probe): lifted where the
  sweep met the riser to touch its top, moved on by up to its radius, the rest of the move swept from
  there without the ground snap while it rises, so the capsule rides over the edge across ~15 steps
  and loses speed, as in 2D. Rapier 3D's own autostep was tried and stalls at risers (one stayed stuck
  for good); the character profile keeps the port's instant lift. Measured: one riser alike to 4.7 mm,
  four risers to 1.6 cm (the ride amplifies small differences).
- 2026-10-25 (41.3 B): a rising mover that lifts an arcade character standing on its edge (support
  steeper than the slope limit, its fall cancelled by the carry) leaves it at rest, not with the fall
  speed it gathered there (64 mm low at walk-off before; 1.4 mm now). D321 was not the port: free in
  3D the case's down press was also the move's y, which walks in depth; the cases send down as the
  `navigate` action only for a free character, and the free check includes the one-way case. 3D spawn
  clearance now ignores one-way colliders in the way and counts one as support only under a capsule on
  its top, the 2D probe's rule.
- 2026-10-25 (41.3 B): with autostep on, both backends' side-scroller runner sticks at the same wall
  (x 129.9 m) and tries a step every step there; that is most of `plane-step --arcade`'s cost (2D +60 %,
  3D +110 % over autostep off), 0.16 ms per step at four levels.

- 2026-10-25 (41.4): default chosen, owner to confirm: one `ctx.physics` surface by argument shape:
  `raycast` and `overlapBox` take `[x, y, z]` arrays (a world query, filter included; the old
  `raycast3d`/`overlapBox3d` stay as names for the same, and their visual-script nodes stay) or
  `{x, y}` (on a plane). The `{x, y}` forms run on the plane the calling script's object is locked
  to, else z = 0 (41.5's scene default plane goes in between); x runs along the plane's right (−Z on
  an X plane), the hit's normal comes back in the plane. An overlap on a plane is a 2 cm sliver (box
  or disc) across it, so it finds what crosses the plane, not what stands beside it. Engine modules
  have no calling object: z = 0. The 2D forms take the query filter too.
- 2026-10-25 (41.4): default chosen, owner to confirm: no gameplay-block data moves. On the 3D
  backend a circle trigger is the sphere of its radius and a `[w, h]` box (trigger, switch) is as deep
  as it is wide — on a plane through them the same area as in 2D. Switches now work in 3D: the
  player's capsule in the switch's box, turned with its object, as box triggers are tested. Two
  differences from the 2D plane, for 41.5's Problems lines: a box trigger or switch tests the capsule
  exactly where 2D tested its bounding box (later at a corner, by at most r(1 − 1/√2), 9 cm at the
  default radius), and a box trigger, switch or hitbox on a turned object turns with it (2D ignored
  the turn). A patrol's start direction with a y part walks up or down in 3D as on the plane.
- 2026-10-25 (41.4): visual-script nodes Set plane, Set character plane (axis `none` frees: the
  node generator gives a nullable options object a "none" choice that passes null) and Plane of.
  A model's "polygon" collider is offered in 3D too (a prism, 41.2).
- 2026-10-25 (41.4): for 41.5's upgrade, `blocks2DTo3D(components)` lists per entity, without
  changing data, Problems notes of five kinds: `trigger-circle` (a circle trigger is a sphere),
  `area-depth` (a `[w, h]` trigger, switch, hitbox, collectible, climb volume, patrol or gravity
  area is as deep as wide), `capsule-test` (box trigger and switch), `turned-area` (box trigger,
  switch, hitbox, collectible on a turned object) and `depth-motion` (mover or patrol waypoints, or a
  patrol direction, with a z part: 2D moved only the look in depth, 3D moves the collision too unless
  the collider is plane-locked).
- 2026-10-25 (41.4b): default chosen, owner to confirm: "over loaded collision" is the body's ground
  column (x, z), decided once at each step boundary right after the rings move: every streamed object
  (terrain, block layer) with a cell there (a tile; a chunk holding cells, as of the last ring look)
  must hold it in its collision ring, and a terrain tile must have its data (so it is built at this
  step's flush). Ground no streamed object covers is loaded. Height is not looked at (a body above or
  below a layer still waits for it). One set lookup per streamed object per body per step; nothing
  when no object streams.
- 2026-10-25 (41.4b): default chosen, owner to confirm: suspended are what the engine moves under
  gravity or along the ground — player characters (the port holds the capsule, its controller module
  skips the step, fall speed and last result kept; impulses given meanwhile are dropped), patrols
  (edge and waypoint) and gravity bodies; a suspended body's hitbox and a suspended character take
  no part in contacts or collectibles. Path movers never stop (no ground needed; one stopped far away
  would come back out of step). An edge walker whose next step is over unloaded ground waits there
  suspended instead of turning (it would otherwise turn at the loaded world's edge, which depends on
  where the camera is). The engine has no dynamic bodies; a future dynamic-body item uses the same
  rule. 2D controllers (the 2D port) are not held: that backend goes in 41.6. Players are ring sources,
  so a player is held only when its own cell waits (a terrain tile whose data has not arrived after
  a teleport, or the per-step admission budget).
- 2026-10-25 (41.4b): `ctx.physics.isSuspended(id)` (node Is suspended) reads it; diagnostics
  `runtime.worldStream.suspended` = { bodies (now), suspensions, resumes }.

- 2026-10-25 (41.5 A): default chosen, owner to confirm: a scene's default plane is inherited, not copied: a collider
  or controller without a `plane` key takes its scene's (`plane: null`, now kept by the canonical form, frees one), so a
  new object in such a scene is on it and moving the scene's plane moves them all. It is applied where scenes become
  runtime entities (the start scenes' merge, a loaded scene's document), so the physics code reads one `plane` as before.
  A prefab is in no scene: the upgrade gives a 2D project's prefab bodies the plane themselves; a prefab made later from
  objects in a plane scene spawns free unless its bodies name a plane. `{x, y}` queries: the caller's lock, else its
  scene's default plane (the manifest scene row carries it), else Z at 0.
- 2026-10-25 (41.5 A): default chosen, owner to confirm: a game without its own input gets the side-view input (1D move)
  and, with `audio_spatial` unset, the distance-along-the-plane audio when its first start scene has a default plane;
  else the 3D ones. New empty projects are 3D (no plane). A template that named `physics_dimension: 3` is 3D, any other
  takes the `planes` step at creation without notes (it is a new project, nothing to check); part B rewrites the
  templates.
- 2026-10-25 (41.5 A): the upgrade is a recorded step of 8: `Schema8Step.recorded`, its name in project.json `upgrades`
  (like `trim-data`); it runs on a 7 and on an 8 whose list lacks it, and never where the list names it (whatever the
  version). New projects and the corpus fixtures (`fixtures/commands`, its generator) record it. A project without the
  setting was 2D (the setting's old default), so an 8 without the marker and without the setting is upgraded as 2D:
  Sprout is exactly that.
- 2026-10-25 (41.5 A): default chosen, owner to confirm: the "stays until saved" notes are per scene (`migratedFrom2D:
  {plane?, objects: {id: ['collider:box', …]}}`), cleared in the command layer when an edit changes that component's
  value or removes the object, and the plane note when `setScenePlane` runs (even to the same plane: that confirms it);
  an undo does not bring a note back. The backend logs one Problems line per kind (`migrated_from_2d`) once per backend
  run while any is open, and again with what is left after an edit; the field to check comes before the names (the log
  keeps 256 characters), five names then "and N more". Prefab parts and linked copies' overrides are converted and
  named once in the upgrade's notes (`project_upgraded`), not kept as notes: no edit path settles them per part. A 3D
  project's open says once that the setting was retired.
- 2026-10-25 (41.5 A): the editor acts as on the 3D backend everywhere (the menus and Inspector offer the 3D collider
  helpers only); the scene plane control, the plane-locked gizmo and the side view preset are part B, so `setScenePlane`
  is API-only (MCP) until then. Runtime tests that build the 2D port themselves (`physics2DConfigOf`) keep the 2D
  modules (`tests/game-modules.ts` reads the physics config) until 41.6 removes that port; production never takes it.
  An export no longer links `packages/character` (the bundle-scan case for refusing it was dropped with it).
- 2026-10-25 (41.5 B): the descriptors lose their `dimension` tags (fields, handles, create entries, presets): every
  shape, one-way, depth, plane and profile shows in every project. The 2D-only duplicate create entries go (the 3D one
  of each stays); the collider presets are Box, Flat box (depth), Polygon (prism), Sphere, Capsule, Cylinder, Convex
  hull, Mesh; the One-way platform entry is a 3 × 0.2 × 2 m box (`hz: 1`). The editor draws a flat box or polygon as the
  solid `shape2DTo3D` makes of it (its collider's depth, its plane's orientation); the camera bounds handle is 3D.
- 2026-10-25 (41.5 B): default chosen, owner to confirm: the scene's default plane is edited in a third floating tool
  window, Window → Scene settings (axis none / Z / X and the origin; one `setScenePlane` each), beside Lighting and
  Environment. The plane-locked gizmo applies to bodies only: an object whose collider or controller is on a plane (its
  own, or its scene's) loses the normal's arrow and planes in Move and every ring but the normal's in Rotate (world
  axes; Scale stays free); scenery, lights and markers stay free, so props can stand at any depth. The toolbar's "side
  view" button (shown while the active scene has a plane) puts the camera on the plane's normal (+Z / +X), level, at the
  same distance; the lens stays perspective (orthographic was optional, not done).
- 2026-10-25 (41.5 B): default chosen, owner to confirm: the 2D starter stays "2D starter" (a side-view level) and is
  authored for the one backend: 1 m deep boxes (`hz: 0.5`), and its setup (`templates/starter/setup/pack.json`, by
  the build script) sets the scene's plane Z at 0 and the character's `profile: 'arcade'` (a v3 capture holds
  neither). Its objects keep their shipped ids (`box-0001`, `model-0001`, …; the id format grew to six digits since).
  Templates no longer take the `planes` step at creation: every template is made for the one backend, the retired
  setting a template names is dropped. The project picker never asked 2D/3D: it shows Empty scene, 2D starter and 3D
  starter cards (unchanged). `queryProject`'s scene rows carry each scene's `plane`; the editor tracks them from
  `setScenePlane` changes.
