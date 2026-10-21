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
| — | Not started. |

## 5. Decision log

- 2026-10-21: Planned from the owner's choice: one backend, a plane switchable
  at any time (Mario-pipe case), to cut complexity. Default chosen, owner to
  confirm: axis-aligned planes only for now.
