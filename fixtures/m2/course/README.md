# fixtures/m2/course — packet-32 diagnostic course

Frozen inputs for packet 32 (`docs/planning/m2-packets.md` §32, gate H). The
controller, the Node course suite and the browser procedure all read these
files; the packet-32 checker re-derives every derivable value:

```
node fixtures/m2/course/tools/check-course-fixtures.mjs            # check
node fixtures/m2/course/tools/check-course-fixtures.mjs --write    # canonicalize index.json
```

| File | Contents |
|---|---|
| `course.json` | the bounded diagnostic course: the 64 static colliders of the packet-14 frozen spec (`tests/evaluations/m2-physics/course-spec.json`, identical derivation to `fixtures/m2/physics/course.json`), the solver/capsule/controller constants and the six resolved gameplay settings |
| `slope-course.json` | the packet-31 slope-threshold course (29.9/30.0/44.9/45.0/45.1°) copied byte-identically for the controller's climb/slide classification |
| `snap-course.json` | the packet-31 ground-snap course (0.05 m and 0.50 m step-downs) copied byte-identically |
| `tolerances.json` | the frozen tolerance table (packet-14 `T*` numbers plus the contract's window/constant values), declared before any controller measurement |
| `input-sequences.json` | `RawInputSnapshot` atoms (keyboard + a standard gamepad) and inclusive step spans; spans expand to one step-source entry per executed step |
| `cases.json` | 28 diagnostic cases: course, start, input sequence (or a declared window/relative press), settings override and the tolerance reference |
| `index.json` | SHA-256 of every fixture file |

Notes:

- Steps `0..11` are the runtime's settle pre-roll (`platformer.md` §6); the
  first sampled gameplay step is `12`, which is where every span starts.
- `cases.json` never contains a measured value: the `expect` fields name
  tolerance keys (or the contract's theoretical bands) and the tests compare
  the real run against them.
- The 12 m/s `T9_highSpeed` figure is the packet-14 *instantaneous-velocity*
  probe. On this course the run-up to the wall face is shorter than the
  distance the 40 m/s² acceleration needs from rest (`C32-4`), so
  `high-speed-wall` records the achieved approach speed and `high-speed-ledge`
  provides a true 12 m/s collision on the longer run-up.
- No credentials, no project data, no on-disk game data: everything here is
  self-generated or derived from the committed packet-14/31 fixtures.
