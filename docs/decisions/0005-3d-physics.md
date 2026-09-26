# Decision 0005 — 3D physics (phase 23.0)

Status: **ACCEPTED — phase 23 owner approval (2026-09-26: "phase 23 approved
from the Skyforge gap list"); the design was decided by the main session
(`docs/plan-phase-23.md` 23.0 "Design"); final owner manual review
pending.** Binding for the 3D simulation; decision 0002 §1 (the 2D pin and
its controller pattern) stays binding for the 2D plane.

| § | Topic | Status |
|---|-------|--------|
| 1 | The pin: `@dimforge/rapier3d-compat@0.20.0` | accepted |
| 2 | Two backends, not one 3D world constrained to a plane | accepted |
| 3 | The port, the setting and the data | accepted |
| 4 | Distribution: a separate backend script | accepted |
| 5 | Measured bundle size and step cost | measured 2026-09-26 (directional numbers) |

## 1. The pin

- `@dimforge/rapier3d-compat` at exactly **`0.20.0`** — the same version as
  the 2D pin (decision 0002 §1), so both backends are the same Rapier
  release (same character-controller semantics, same `-compat` distribution:
  the WASM is inlined in the JavaScript as base64, no separate WASM fetch,
  no URL). Integrity
  `sha512-X4W9pJBdGRX5CO3c/gUNjBFEFG2fn4nYxp9k8STdBDaLa0/w5XTW2ArpayS+9jGFojTi3uFSOWAElCd4rkpekA==`,
  Apache-2.0, zero runtime dependencies.
- Declared by `packages/physics-rapier` only and imported only under its
  `./3d` subpath (`src/3d/`); pinned in `tools/check-deps.mjs` and allowed
  for that package in `tools/check-boundaries.mjs`; installed with
  `npm install --save-exact` (the lockfile diff is the one package). The
  root `node_modules/@dimforge/rapier3d-compat@0.12.0` is a dev-only
  transitive of `@types/three` and is never linked: the package's own pin
  resolves from `packages/physics-rapier/node_modules`, and the export reads
  the license row's version from the path the 3D bundle actually linked.
- The export's license rows gain `@dimforge/rapier3d-compat 0.20.0`
  (Apache-2.0) **only** when the export ships the 3D backend; a 2D export's
  `meta.json` is unchanged.

## 2. Two backends

A rapier3d world locked to a plane (translations locked on Z, rotations on
X/Y) cannot reproduce rapier2d's f32 results: the narrow phase, the capsule
maths and the character controller's internals differ, so every recorded 2D
replay, pinned trace and Sprout's compiled-behavior digests would move. The
2D plane therefore keeps the existing rapier2d adapter untouched —
byte-identical by construction — and 3D is a second adapter beside it:

- `physics_dimension` 2 (or absent): `@thirdlight/physics-rapier` (2D), the
  platformer controller, the game session — exactly as before.
- `physics_dimension` 3: `@thirdlight/physics-rapier/3d`, the runtime's 3D
  character phase (gravity along −Y from `gravity_y`, capped at
  `max_fall_speed`; walking, jumping and turning are phase 23.2).

The cost is two adapters to maintain; the gain is that no 2D number moves
and 3D is not bent around a plane.

## 3. The port, the setting and the data

- **Port.** `PhysicsPort3D` (runtime `ports.ts`, beside the unchanged 2D
  `PhysicsPort`): Vec3 positions, quaternion rotations, `dimension: 3` as
  the discriminant, `stageCharacterMove(Vec3)` / `step()` returning a
  `CharacterMoveResult3D` validated by `validateCharacterMoveResult3D` (the
  2D rules on three axes), scene-load collider add/remove, raycast,
  diagnostics. The runtime holds one port or the other; with the 3D one it
  commits the full position (x, y, z) to the controller's transform and
  steps the physics in scene mode too (the 2D scene mode is unchanged).
- **Setting.** Optional engine setting `physics_dimension`, values 2
  ("2D plane") / 3 ("3D"), absent = 2 — the `sim_thread` / `render_backend`
  mechanism, so the settings, manifest, buildId and replays of every existing
  project stay byte-identical. Not added to the scripts' `GameplaySettings`
  type (the public script `.d.ts` stays the same).
- **Data.** Box colliders gain an optional `hz` (half depth); the capsule
  offset an optional third component. In a 3D project a box without `hz` is
  a validation problem (no guessed depth), a polygon collider is refused
  (3D shapes are 23.1) and colliders may take any rotation; the 2D plane
  keeps its rules (rotation about Z only).
- **Modules.** `thirdlight.physics-rapier:3d` next to `:2d`; in 3D a
  `controller` needs `:3d` (not the 2D platformer controller) and a game
  block is refused until 3D game modes exist (23.10).

## 4. Distribution: a separate backend script

The play and export bundles are IIFE scripts (the pinned esbuild option set
of export.md §5.3: no code splitting), so the 3D backend is **its own
script**, `physics-3d.js` (`dist/preview/physics-3d.js` on the preview
origin; `js/physics-3d.js` in a 3D project's export only). It registers
itself on the global object through game-host's dependency-free
`physics-3d-global` module and the host picks it up with `loadPhysics3D`: a
script element in the page (single thread), `importScripts` in the
simulation worker (the file next to the worker's script). A 2D project never
fetches it; `preview-m3.js`, `sim-worker.js` and the export's `js/main.js` /
`js/sim-worker.js` carry no rapier3d code (checked by the e2e test). The
export gates the new bundle like the worker: import graph (the allow-list
gains `@dimforge/rapier3d-compat`), forbidden-text scan, closure digest.

## 5. Measured (2026-09-26, the CPU-rendered build host; directional)

Bundle sizes (`npm run build`, pinned options, unminified):

| File | Bytes | gzip |
|---|---:|---:|
| `physics-3d.js` (rapier3d-compat 0.20.0 + the 3D adapter) | 2,934,025 | 1,093,434 |
| `sim-worker.js` (2D; before 23.0: 3,434,451) | 3,454,226 | 1,093,018 |
| `preview-m3.js` (before 23.0: 7,634,227) | 7,655,466 | — |

The 2D bundles grew ~20 KB (the runtime's 3D phase, the scene-mode
observation, the loader); a 3D project downloads the extra ~2.9 MB
(~1.1 MB gzip) once. For comparison the inlined WASM is 2,021,200 bytes in
3D and 1,486,188 in 2D.

Step cost, phase 21 harness (`tools/perf/sim.ts`, the production host
headless, 2,400 timed steps after 240 warm-up steps, `--expose-gc`):

| Scene | Colliders | step p50 | p95 | p99 | bytes / step |
|---|---:|---:|---:|---:|---:|
| 3D scene: capsule resting on a floor among turned boxes | 198 | 0.064 ms | 0.087 ms | 0.098 ms | ~8 KB |
| same, more boxes | 991 | 0.358 ms | 0.387 ms | 0.405 ms | ~8 KB |
| 2D `medium` benchmark (2,000 entities, 5 scripts, a game) | — | 0.117 ms | — | — | 29 KB |

All far inside the 8.33 ms step of 120 Hz. Measuring showed the plain
(scene-mode) step path copying every transform per step (~0.5 KB per entity
per step); it now reuses the phase 21.2 step buffers like the game path.
Determinism: two runs and page vs worker give identical step digests
(`tests/integration/m23-3d`), and the adapter's own runs are bit-identical
(`packages/physics-rapier/src/3d/port3d.test.ts`).
