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
