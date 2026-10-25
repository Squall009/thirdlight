# Decision 0007 — One physics backend; 2D is a plane

Status: **ACCEPTED — owner decisions 2026-10-21 (one backend, a plane
switchable at any time, suspended bodies, Problems lines per converted
item) and 2026-10-22 (axis-aligned planes only).** Supersedes decision
0005 (two backends) and the 2D pin of decision 0002 §1 once phase 41
removes the 2D backend. Plan: `docs/plan-phase-41.md`.

| § | Topic | Status |
|---|-------|--------|
| 1 | One backend: Rapier 3D | accepted |
| 2 | 2D is a plane constraint, switchable per object at any time | accepted |
| 3 | 2D shapes become thin 3D shapes | accepted |
| 4 | One character controller, a platformer movement profile | accepted |
| 5 | One query surface | accepted |
| 6 | Bodies outside loaded collision are suspended | accepted |
| 7 | The one-time digest re-baseline for 2D games | accepted |
| 8 | Problems lines for every converted item | accepted |
| 9 | The pin and the measured baseline | measured 2026-10-25 |

## 1. One backend

Every project and scene runs on `@dimforge/rapier3d-compat` through the
3D port (`@thirdlight/physics-rapier/3d`). The 2D backend
(`rapier2d-compat`, `physics-rapier/src/port.ts`), the project setting
`physics_dimension`, the 2D platformer character package (once its
behaviour has moved), the block plane cut and the dimension branches are
removed; an export ships one physics script and one WASM.

Why: every feature was built twice (colliders, triggers, movers, queries,
character controllers) or only for one dimension; terrain, scatter,
splines and architecture never collided in 2D, and blocks needed a plane
cut to collide there. One backend halves that work for every future
feature.

## 2. The plane constraint

- A body (static, kinematic, dynamic, or a character) may be locked to a
  **plane**: an origin and an axis-aligned normal, world X or Z. It cannot
  move along the normal and only rotates about it. In Rapier 3D this is the
  body's locked translations and rotations, the plane's depth held by a
  position correction.
- Only axis-aligned planes (owner, 2026-10-22). A rotated plane needs a
  joint frame and is a later extension.
- Set by a `plane` field on body and character components, a scene's
  **default plane** (new objects get it; the editor's gizmos and Scene view
  lock to it), and scripts: `ctx.physics.setPlane(id, {axis, origin} | null)`
  and `ctx.character.setPlane(id, …)`.
- **Switching** works at any time, mid-scene, with no reload. Locking snaps
  the object onto the plane, zeroes its velocity along the normal and
  reduces its rotation to the plane's axis; unlocking frees all six degrees
  of freedom. Both take effect at the step boundary, so page and worker stay
  equal. Camera and input changes stay the game's (`ctx.camera`, input
  maps): the engine has no "2D camera".

## 3. Shapes

Every collider is a 3D shape. A 2D box becomes a box with a depth (default
1 m, per collider); a polygon an extruded convex prism, or a compound of
prisms for a concave outline; a circle a cylinder along the plane's normal.
3D shapes (terrain, block layers, scatter, splines, architecture) collide
with plane-locked bodies as they are. One-way platforms and drop-through
become a filter on contact normals against the platform's "up", in the
character controller and the contact pipeline, so they work in 3D too.

## 4. One character controller

One controller on the 3D port. The 2D platformer's behaviour (autostep, jump
buffering, coyote time, wall slide and wall jump, climb volumes, one-way
platforms, movers carrying the character) becomes a **movement profile** of
that controller, usable on a plane or in free 3D. It is kept within measured
tolerances of today's 2D controller (jump apex, air time, run speed, slopes,
stairs, wall moves, climb, one-way, movers).

## 5. One query surface

One `ctx.physics`: `raycast` and `overlap*` take Vec3; the Vec2 forms stay
as conveniences on a plane (z from the caller's plane, or 0). One set of
trigger, mover and door components; the 2D-only switches become generic;
the typings lose their "3D projects:" caveats.

## 6. Bodies outside loaded collision

Streaming loads collision only around the camera, its target and the
players. A dynamic or kinematic body not over loaded collision is
**suspended**: no gravity, movement or contacts, its state kept. It resumes
in the step its area's collision arrives. One rule in the physics bridge,
deterministic, the same on page and worker; diagnostics count suspended
bodies and a script can read whether a body is suspended.

## 7. The one-time digest re-baseline

Decision 0005 kept two backends because a 3D world locked to a plane cannot
reproduce rapier2d's f32 results: recorded 2D replays, pinned traces and
games' step digests would move. That cost is accepted once: a 2D game's
digests and replays recorded before the upgrade are re-recorded once on the
3D backend. After that they are as stable as any 3D digest (two runs and
page vs worker identical).

## 8. Upgrade and Problems lines

`physics_dimension` is retired by a step appended to the schema 8 upgrade
(`SCHEMA_8_STEPS`), recorded once per project so a project already at 8
gets it once. A 2D project's scenes get a default plane (Z axis at z = 0)
and its colliders their 3D forms with the default depth. Every converted
item writes a **Problems line** naming the object and the field to check:
a 2D collider and the depth it got, a polygon split into prisms, a one-way
platform, a 2D trigger, mover or switch, the project's former 2D setting.
Lines are grouped by kind, so a large project gets a readable list, not
thousands of rows, and each stays until the item is saved in its new form.
The default input maps and the audio panning default follow the scene's
plane setting.

## 9. The pin and the baseline (2026-10-25)

**Pin: stays `@dimforge/rapier3d-compat` 0.20.0.** 0.21.0 (24 Sep 2026,
Rapier 0.36) was tried as a drop-in: the code needed no change (the
soft-body set it adds to `PhysicsPipeline.step` / `ColliderSet.remove` sits
below the `World` API the port uses) and the physics and determinism suites
passed. It is not taken because its npm build includes soft bodies and the
FEM solver:

| | 0.20.0 | 0.21.0 |
|---|---:|---:|
| export `physics-3d.wasm` raw / gzip / brotli (KiB) | 1,974 / 744 / 545 | 3,010 / 1,141 / 832 |
| side-scroller step, 1 level, p50 (ms) | 0.053 | 0.066 |
| side-scroller step, 4 levels, p50 (ms) | 0.106 | 0.170 |

A larger download and a slower step for features the engine does not use.
A later Rapier release is taken as its own item when it is a drop-in in
size and step cost, or when a feature needs it.

Baseline of today's 2D backend (the one-backend target of phase 41 is a
2D-style scene within 10 % of it): `docs/plan-phase-41.md` §4, row 41.0.
