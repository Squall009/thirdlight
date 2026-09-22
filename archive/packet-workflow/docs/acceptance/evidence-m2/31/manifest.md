# Packet 31 — Rapier 2D adapter: evidence manifest

Packet 31 (`docs/planning/m2-packets.md` §31), gate H. Owner pre-approval:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final
manual review pending.** Selection per decision 0002 §1. No git commit was
made. Not started: packet 32.

## Outcome (one line)

The approved collision port exists as a real package: `@thirdlight/physics-rapier`
backs `createPhysicsPort(config, signal?)` with `@dimforge/rapier2d-compat@0.20.0`
— cancellable async initialization, one `World` per game with static box/convex
colliders, the parentless kinematic capsule with ground snap, collision-result
grounding/support normals, bounded diagnostics and idempotent disposal; the
runtime core still imports no Rapier.

## Artifacts and what each establishes

| Artifact | Claim |
|---|---|
| `01-toolchain.txt` | environment (Node 22.22.1, npm 9.2.0, tsc 5.9.3, esbuild 0.28.2, vitest 5.0.1, i5-12600H container); **no browser/GPU/gamepad** |
| `02-pin-and-lockfile.txt` | the installed pin (`0.20.0`, Apache-2.0, zero runtime deps), lockfile/registry/decision integrity all equal, `npm ls` healthy, and the packet-31-only lockfile delta (3 hunks, +16 lines) |
| `03-adapter-tests.txt` | `npx vitest run packages/physics-rapier` — 4 files / 39 tests passed against the real WASM library |
| `04-fixture-tests.txt` + `08-measured-cases.txt` | `npx vitest run tests/m2-physics` — 3 files / 61 tests: 18 case replays + 36 failure cases + boundary assertions, with the measured per-case summary |
| `05-checks.txt` | `npm test` 113 files / 1501 passed; `npm run typecheck` clean (13 packages incl. `packages/physics-rapier`); `check-deps` OK; `check-boundaries` OK (13 packages / 246 files / 895 specifiers, 0 violations); `build` 4 built / 0 skipped; contracts checker 34/34; physics/input/runtime fixture checkers green |
| `06-negative-boundary-probe.txt` | the disposable probe (`three`, runtime **value** import, `node:fs`) fails check-boundaries 3/3; removed; tree green afterwards |
| `07-bundle-probe.json` | browser-IIFE probe build under the exact export.md §5.3 pinned esbuild option set: 2,191,202 bytes, sha256 `e319125d…`, graph contains the adapter and Rapier |
| `09-resource-cycles.txt` | 100 create/dispose cycles: 62 colliders / 61 bodies per cycle asserted from the library's own sets, stale-handle throw after every dispose, fresh port afterwards; JS heap flat within ~2 MB while RSS grows 14–90 MB run-dependently (the non-shrinking WASM linear memory — bounded-growth smoke check, stated limits) |
| `fixtures/m2/physics/{course,snap-course,slope-course,convex-course,cases,failures,tolerances,index}.json` + `tools/check-physics-fixtures.mjs` | the frozen course re-derived from the packet-14 spec, 18 measurement cases, 36 failure cases, the slope-threshold table, SHA-256 index, and an independent plain-Node consistency checker |

## Acceptance criteria (`docs/planning/m2-packets.md` §31; A12/A13/A14/A20 rows)

- **PASS (real library, Node)** — capsule against floor (grounded every step,
  rest center 0.9099987 ≈ the contract's 0.910 ± 0.0005, support normal (0, 1)),
  wall (center stops at 9.1901 ≤ face 9.5 − radius 0.3 − skin 0.01 + 5 mm, wall
  contact reported), ceiling (head contact, center ≤ 3.095 + tolerance, rise
  after contact ≤ 5e-4 m/step), box ramps (43° climbs: +1.70 m; 47° refuses:
  +0.0167 m gain, far below the 0.3 m contract limit) and convex-polygon ramps
  (`ColliderDesc.convexHull`, 4-vertex quad wall + two triangle ramps).
- **PASS (real library, Node)** — slope normals and the just-below/just-above
  threshold: 44.9° (0.70833984) and 45.0° (0.70710678) grounded and not steep;
  45.1° (0.70587157) grounded per the library but flagged `steepSlope`, which
  the controller treats as not grounded (physics.md §8 items 2/4). Ground snap:
  a 0.05 m step is snapped (grounded, `snapped=true`); a 0.50 m drop produces 19
  free-fall steps and `snapped` is never reported without a ground contact.
- **PASS (real library, Node)** — no Z dimension: every port method/result
  carries only `x`/`y`; no result object contains a `z` key (asserted for all
  18 cases). No second frame driver: the adapter owns no loop/timer and calls
  `world.step()` exactly once inside `step()`.
- **PASS (real library, Node)** — many create/dispose cycles release world
  resources: the library's own collider/body counts are asserted every cycle,
  `World.free()` provably ran (any later world call throws
  `physics_port_disposed`), a fresh port works afterwards, and the JS heap stays
  flat; RSS growth is attributed to the WASM linear memory, which Rapier never
  shrinks (limit recorded in `09-resource-cycles.txt`).
- **PASS (Node)** — the runtime core imports no Rapier implementation:
  `packages/runtime` declares only `@thirdlight/project-model` and contains no
  import of the pin, and `physics-rapier` is the only package that declares or
  imports it (test + check-boundaries).
- **PASS (Node)** — the failure surface: init cancellation (pre-aborted and
  during preparation, then a later init succeeds), invalid shape (15 cases),
  forbidden transform (`parented`/`scale`/`rotation`/`upright`/
  `invalid_transform`; never flattened), non-constant config, stale world handle
  (`physics_port_disposed`), collision-correction failure (non-finite delta →
  `physics_port_error`/`collision_correction_failed`, capsule unmoved) and
  dispose during preparation (`physics_init_cancelled`, nothing allocated).
- **PASS (build only)** — a probe entry importing the adapter builds under the
  pinned esbuild flags (2,191,202 bytes).
- **UNVERIFIED — browser**: real-browser WASM initialization, real CSP
  interaction, standalone subpath/static packaging, the
  preview/export bundle entries (packets 35/36) and any browser-side CPU claim.
  No browser exists in this container (U-5 open). Procedure: packet 14's
  `docs/acceptance/evidence-m2/14/manifest.md` §"Manual desktop evidence
  procedure" (static servers on two origins, console marker, CSP verbatim) plus
  the packet-37 walkthrough. The `-compat` distribution embeds the WASM as
  base64 (no separate WASM fetch/CORS surface); that is a distribution fact,
  not a browser test.

## Measured facts carried into the packets 32/35 handoffs (contract-change requests)

`docs/handoffs/31.md` records C31-1…C31-5. The two that matter for integration:
the 0.20.0 controller's one-time ground-offset/penetration push-out (up to
`skin + penetration`, measured 11.3 mm) is not reported in
`numComputedCollisions()` and exceeds the runtime's non-`snapped` allowance
(1 mm), so the adapter reports `snapped=true` for a bounded ground-contact
correction in either direction and refuses anything beyond `snap + skin`
(C31-2); and the contract's 45.1° `cos` value is a typo (C31-1).

## Sanitization note

All artifacts contain only numbers, package identities, file digests and build
outputs. No credentials, session tokens or project data. The disposable build
output lives in `/tmp/tl31-bundle/` (entry under the gitignored `dist/` is
removed by the tool); every claimed value is reproduced by a committed command.
