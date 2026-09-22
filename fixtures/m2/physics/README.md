# `fixtures/m2/physics` — Rapier 2D adapter fixtures (packet 31)

Committed, replayable fixtures for the packet-31 collision port. They are
executed by `packages/physics-rapier`'s vitest suite and by
`tests/m2-physics/**` through the **real** pinned library
(`@dimforge/rapier2d-compat@0.20.0`), and re-derived where derivable by
`tools/check-physics-fixtures.mjs` (plain Node, independent code path).

## Files

- `course.json` — the frozen packet-14 evaluation course
  (`tests/evaluations/m2-physics/course-spec.json`, runId `tl14-2026-09-18-a`)
  converted to `PhysicsInitConfig` static-collider specs: 64 colliders (flat
  floor with a 2 cm seam, 43°/47° ramp boxes, wall, ceiling, ledge, 57 filler
  boxes), 120 Hz, capsule r=0.3/hh=0.6, g=−19.62, run 4 m/s, jump 7 m/s,
  max fall −30 m/s, skin 0.01, snap 0.1, climb 45°, slide 30°.
- `snap-course.json` — a 0.05 m step down (inside the 0.1 m snap distance) and
  a 0.50 m drop (beyond it).
- `slope-course.json` — 2 m ramps at 29.9°, 30.0°, 44.9°, 45.0° and 45.1° plus
  a shared floor.
- `convex-course.json` — bounded convex-polygon colliders created through
  `ColliderDesc.convexHull`: two triangle ramps (≈30° and exactly 45°) and a
  quadrilateral wall.
- `cases.json` — 18 measurement cases: floor idle/run+seam, wall stop,
  high-speed wall, ceiling head bump, 43° climb, 47° refuse, convex ramps,
  ground snap within/beyond, five slope-threshold stands and the
  no-autonomous-slide case. Each carries the declared expectation bands, the
  packet-14 canonical driver segments and its contract pins.
- `failures.json` — 36 adapter failure cases: invalid shape (box/polygon
  vocabulary and limits), forbidden transforms (parented/scale/rotation/
  upright and non-finite transforms), non-constant config, init cancellation
  (pre-aborted and during preparation), stale-handle disposal and the
  collision-correction failure. Non-finite numbers are encoded as the strings
  `"NaN"`/`"Infinity"`/`"-Infinity"` (`nonFiniteEncoding`) because JSON cannot
  carry them.
- `tolerances.json` — the contract constants and the slope-threshold table with
  the `cos` values **re-derived** from the angles.
- `index.json` — SHA-256 of every fixture file (no orphans, no dangling
  entries).
- `tools/check-physics-fixtures.mjs` — the consistency checker.
- `tools/build-probe-bundle.mjs` — builds a probe entry that imports the
  adapter with the exact `export.md` §5.3 pinned esbuild option set and prints
  the measured byte count/digest (the production bundle entries are packets
  35/36).

## Pins

The cases pin the Gate-E-accepted contract text
(`docs/planning/m2-contracts/physics.md` §6/§7/§8 — promoted into
`docs/contracts/runtime.md` §12.6), `docs/contracts/project-model.md`
§10.7/§21.3, and the frozen packet-14 `course-spec.json` tolerances. Three
fixture notes record measured behavior that the accepted contract text does not
describe: the ground-offset push-out not appearing in `numComputedCollisions`
and the resulting `snapped`/allowance question (**C31-2**), the chained snap
descent over a bridged drop (**C31-3**), the absence of autonomous sliding at
the 30° minimum-slide angle (**C31-4**), and the contract's 45.1° `cos` value
(**C31-1**). See `docs/handoffs/31.md` and
`docs/acceptance/evidence-m2/31/manifest.md`.

## Verification status

Node-verified with the real library: every case in `cases.json` and
`failures.json` is executed against the pinned WASM build by
`packages/physics-rapier`/`tests/m2-physics`. **Browser execution, CSP
interaction and static packaging are UNVERIFIED** (no browser in this
container); the bundle probe proves only buildability under the pinned flags,
and the packet-37 procedure covers the browser items.
