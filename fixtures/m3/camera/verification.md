# Verification — packet 40 camera fixtures

**PROPOSED — not accepted.** The camera fixtures are verified by the packet-40
checker, which lives next to the gameplay fixtures:

```sh
node fixtures/m3/gameplay/tools/check-fixtures.mjs    # groups passed: 23, checks passed: 127, EXIT=0
node fixtures/m3/gameplay/tools/check-fixtures.mjs --report /tmp/m3-40-report.json
TL40_FIXTURE_ROOT=/tmp/m3-40-corrupt node fixtures/m3/gameplay/tools/check-fixtures.mjs   # EXIT=1 on the control
```

Groups covering this directory: `camera[follow.json]`, `camera[bounds.json]`,
`camera[snap.json]`, `camera[resize.json]`, `camera-owner`, `camera-viewport`,
plus `index[camera]` and `canonical[camera]`. The corruption control and the
closed-form derivations are recorded in
[`../gameplay/verification.md`](../gameplay/verification.md) §§2–3; the camera
arithmetic is §3(d)–(g) there.

## What each group re-derives

- `follow.json`: the dead-zone target `T = C + overflow(P − C, dz)`, the
  smoothing step `S = C + k·(T − C)` (with `k = 0`/snap as an exact target), the
  per-axis `CAMERA_MAX_STEP` cap, the authored-bounds clamp and the frustum
  clamp; `moved` is `false` when both axes stay within `CAMERA_SNAP_EPS`.
- `bounds.json`: the half-extents `halfH = CAMERA_Z·tan(fovY·π/360 …)` and
  `halfW = halfH·aspect`, the clamped ranges per axis, the
  `max − min < 2·half` centre fallback, and the order of operations (authored
  bounds first, frustum clamp last).
- `snap.json`: the snap pipeline (`k` forced to 1, cap skipped, bounds then
  frustum clamp) and the resulting framing, including the documented
  dead-zone-edge position.
- `resize.json`: that the clamp depends on the aspect, that the same player
  sequence yields different camera poses across a resize while no other state is
  touched, and the accepted/rejected viewport dimension sets.
- `owner.json`: the `gameplay.md` §3.4 validation order and codes.

## Limits of this evidence

The checked math is the *contract's* math, not a renderer. Nothing here proves
browser framing, pixel coverage, GPU behaviour, adapter integration, real
resize plumbing or the physics-identity claim end to end; packet 51 owns that
evidence (`m3-acceptance.md` B10) and `gameplay.md` §10 records the assertion it
must supply.
