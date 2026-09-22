# Thirdlight — M3 camera fixtures (packet 40)

**PROPOSED — not accepted.** Camera fixtures for packet 40's proposed
[`gameplay.md`](../../../docs/planning/m3-contracts/gameplay.md) §7 (follow,
dead zone, bounded fixed-step smoothing, authored bounds, frustum-aware
clamping, hard snap, resize) and §3.4 (single camera owner).

- Machine-readable index: [`index.json`](index.json)
- Checker: [`../gameplay/tools/check-fixtures.mjs`](../gameplay/tools/check-fixtures.mjs)
  (one self-contained plain-Node checker replays every gameplay **and** camera
  fixture — no second tool, no dependency)
- Repeatable commands, negative control and the closed-form arithmetic:
  [`verification.md`](verification.md)

| Fixture | Covers |
|---|---|
| `follow.json` | dead zone (inside/degenerate), `k = 0` hard target, `k = 0.25` and `k = 0.2` bounded fixed-step sequences, the per-step safety cap, the no-op band |
| `bounds.json` | authored bounds vs frustum clamp at 16:9 and 4:3, bounds tighter than the frustum, a level smaller than the frustum (centre fallback), no oscillation |
| `snap.json` | hard snap on `start`/`spawn`/`replay`, the snap-edge framing, cap bypass on the snap step |
| `resize.json` | aspect change changes the clamp only, physics-identity case, rejected non-finite/non-positive/oversized dimensions |
| `owner.json` | instantiate-time owner validation: missing/multiple/`owner_mismatch` camera module, two gameplay modules, wrong scene version, `game === null`, no `cameraFollow` |

Camera constants: `fovY 45`, `CAMERA_Z 12`, `near 0.1`, `far 100`,
`CAMERA_MAX_STEP 4`, `CAMERA_SNAP_EPS 1e-9`, `DEFAULT_ASPECT 16/9`. Only the
camera entity's `position.x`/`position.y` are ever written; `position.z` stays
the authored view depth and rotation/scale are never written. Pixel-level framing
at a real viewport remains packet 51's browser evidence.
