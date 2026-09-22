# Verification — packet 40 gameplay fixtures

**PROPOSED — not accepted.** Repeatable checks for `fixtures/m3/gameplay/` and
`fixtures/m3/camera/`. All commands run from the repository root with the pinned
Node (`package.json` engines: `node 22`; host recorded 22.22.1).

## 1. Positive check (must exit 0)

```sh
node fixtures/m3/gameplay/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Recorded result (packet 40; re-recorded after the packet-43 Gate K repair
2026-09-19): `groups passed: 23`, `checks passed: 127`, `all checks passed`,
`EXIT=0`. The repair added the three `view-player-motion-*` cases to
`run/game-view.json` (+3 checks).

Groups: `index[gameplay]`, `index[camera]`, `canonical[gameplay]`,
`canonical[camera]`, `constants`, `zone-sweep`, `zone-precedence`,
`zone-spawn-check`, `run[run/states.json]`, `run[run/respawn-timing.json]`,
`run[run/events-bound.json]`, `run[run/failure-phases.json]`,
`run[zones/run-semantics.json]`, `run-held-jump`, `segment-source`, `game-view`,
`error-codes`, `camera[follow.json]`, `camera[bounds.json]`, `camera[snap.json]`,
`camera[resize.json]`, `camera-owner`, `camera-viewport`. Optional
machine-readable report: `--report /tmp/m3-40-report.json`.

## 2. Negative control — deliberate corruption (must exit non-zero)

```sh
rm -rf /tmp/m3-40-corrupt && cp -r fixtures/m3 /tmp/m3-40-corrupt
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('/tmp/m3-40-corrupt/camera/follow.json'); d = json.loads(p.read_text())
for c in d['cases']:
    if c['id'] == 'camera-follow-smoothing-0.25': c['expect']['positions'][0] = [2.5, 0.1025]
p.write_text(json.dumps(d, indent=2) + "\n")
p = pathlib.Path('/tmp/m3-40-corrupt/gameplay/zones/sweep.json'); d = json.loads(p.read_text())
for c in d['cases']:
    if c['id'] == 'sweep-touch-edge-tangent': c['expect']['overlap'] = True
p.write_text(json.dumps(d, indent=2) + "\n")
p = pathlib.Path('/tmp/m3-40-corrupt/gameplay/run/respawn-timing.json'); d = json.loads(p.read_text())
d['cases'][0]['expect']['final']['respawnAtStep'] = 131
p.write_text(json.dumps(d, indent=2) + "\n")
PY
TL40_FIXTURE_ROOT=/tmp/m3-40-corrupt node fixtures/m3/gameplay/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Recorded result (packet 40): `EXIT=1`, `failed checks: 13 in 7 groups`, with the
semantic failures

```text
FAIL [zone-sweep] sweep-touch-edge-tangent.overlap: false != expected true
FAIL [run[run/respawn-timing.json]] respawn-timing-100.respawnAtStep: null != expected 131
FAIL [camera[follow.json]] camera-follow-smoothing-0.25.positions[0][0]: 2 != expected 2.5
```

plus the `[index[…]]`/`[canonical[…]]` digest and byte-form failures for the
three edited files. `TL40_FIXTURE_ROOT` points the checker at a fixture copy; the
committed tree is never modified by the control. The corruption is a *deliberate*
mutation of both a value and its expectation so that the semantic group checks —
not only the digests — must fail.

Packet 39's fixtures were re-run in the same step and still pass:

```sh
node fixtures/m3/contracts/tools/check-fixtures.mjs   # groups passed: 37, EXIT=0
```

## 3. Independent closed-form arithmetic (the checker recomputes, this derives)

These are the derivations the fixture numbers were computed from; the checker
re-derives every case from the rules of `gameplay.md` and compares, so the two
must agree.

**(a) bounded respawn delay** (`gameplay.md` §2.4, fixture
`run/respawn-timing.json`, `firstStep` 99). Death decided in the gameplay phase
of executed step `n = 100`:

- `respawnAtStep = n + 1 + RESPAWN_DELAY_STEPS = 100 + 1 + 30 = 131`;
- neutral executed steps `n+1 … n+30 = 101 … 130`, i.e. exactly 30 steps;
- reset boundary before step 131, first live step 131; the fixture's retained
  timeline records `state = respawning, evaluated = false` on 101–130 and
  `playing, evaluated = true` on 131, and the final view is
  `state = playing`, `stepIndex = 132`, `deathCount = 1`, `eventCount = 3`
  (`runStarted`, `died@100`, `respawned@131`).

**(b) event bound** (`gameplay.md` §6, fixture `run/events-bound.json`). 40 death
cycles produce `1 + 40 + 39 = 80` events (the last death has no following
respawn); retained `32` ⇒ `eventDropped = 80 − 32 = 48`, `deathCount = 40`. The
first retained event is the 49th emitted one (`respawned@756`) and the last is
`died@1221`.

**(c) swept capsule / zone threshold** (`gameplay.md` §4.2). With
`r = 0.3`, `HH = 0.6`, a standing capsule centre at `y = 0.91` against a zone with
`y ∈ [0, 0.25]`: `dy = (0.91 − 0.6) − 0.25 = 0.06`, so the horizontal trigger
boundary is

`dx_max = sqrt(r² − dy²) = sqrt(0.09 − 0.0036) = sqrt(0.0864) = 0.29393876913398137`.

With the zone's left edge at `x = 10.5` the threshold is
`x = 10.5 − 0.29393876913398137 = 10.206061230866018`: fixture `sweep-stand-outside`
(`x = 10.2`, `d = 0.3059411708155678 > 0.3`) is `separate`, fixture
`sweep-stand-inside` (`x = 10.21`, `d = 0.2961418578992161 < 0.3`) is `overlap`.
The tangency fixture uses `dx = 21 − 20.7 = 0.3000000000000007`, i.e.
`|d − r| = 7e-16 ≤ ZONE_OVERLAP_EPS = 1e-9` ⇒ `tangent`, `overlap = false`.

**(d) camera half-extents and clamps** (`gameplay.md` §7.3, fixtures
`camera/bounds.json`, `camera/follow.json`). With `fovY = 45°`,
`CAMERA_Z = 12`:

- `halfH = 12·tan(45°/2) = 12·tan(22.5°) = 12(√2 − 1) = 4.970562748477141`;
- 16:9 (`1280×720`, aspect `16/9`): `halfW = 4.970562748477141·16/9 = 8.836555997292695`,
  so a level `X ∈ [0, 48]` clamps `Cx` to `[8.836555997292695, 39.16344400270731]`;
  with `Y ∈ [−4, 8]`, `Cy ∈ [0.9705627484771409, 3.029437251522859]`;
- 4:3 (`1024×768`, aspect `4/3`): `halfW = 6.6274169979695206`, so
  `Cx ∈ [6.6274169979695206, 41.37258300203048]`;
- a level narrower than the frustum (`X ∈ [10, 12]`, width 2 < 2·halfW) makes the
  clamp fall back to the level centre `11` (fixture
  `bounds-level-smaller-than-frustum`, both axes: `(11, 0.5)`).

**(e) bounded fixed-step smoothing** (`gameplay.md` §7.2, fixture
`camera-follow-smoothing-0.25`). Dead-zone target `T = 8` with `C₀ = 0`,
`k = 0.25`: remaining distance decays geometrically,
`C_m = 8·(1 − (3/4)^m)` — an exact binary-rational closed form. The recorded
sequence is `2, 3.5, 4.625, 5.46875, 6.1015625, 6.576171875, 6.93212890625,
7.1990966796875, 7.399322509765625, 7.549491882324219`, and
`8·(1 − 0.75¹⁰) = 7.549491882324219` matches to the last bit. With `k = 0.2` the
same target gives `1.6, 2.8800000000000003, 3.904, …` (float64, not a closed
binary form — recorded as computed).

**(f) safety cap** (`gameplay.md` §7.2, fixture `camera-follow-max-step-cap`).
`T − C = 79.5`, `k = 0.5` ⇒ smoothed displacement `39.75 > CAMERA_MAX_STEP = 4`
⇒ the per-axis cap leaves `C = 4`.

**(g) snap** (`gameplay.md` §7.4, fixture `camera-snap-edge`). `C = (30, 2)`,
`P = (24, 0.91)`, `dz = 0.5`: `T = (30 + (−6 + 0.5), 2 + (−1.09 + 0.5)) = (24.5, 1.41)`
— the snap adopts `T` exactly, so the player sits on the dead-zone edge; the
following step with normal smoothing (`k = 0.25`) is a no-op
(`moved = [true, false]`).

## 4. What these fixtures do not prove

They are a contract-consistency replay: they prove the committed numbers agree
with the committed rules, not that any implementation exists. No physics world,
no Rapier port, no browser, no renderer and no performance claim is exercised
here; packets 49–51 own that evidence, and `gameplay.md` §10 lists the
implementation assertions they must add.
