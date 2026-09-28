# Phase 25.7 legacy project fixture

`legacy-v3-ids/` — a minimal storage v4 project written by hand in the
format before phase 25.7 (`project.json` schemaVersion 3), neutral (not
copied from any game): two scenes whose objects carry the old four-digit
ids (`box-0001`, `group-0001` with a child `box-0002`, `spawn-0001`; a
second scene with `box-0003` and `spawn-0002`). Opening it writes the
project back as schemaVersion 4 with every id and reference unchanged; new
objects get six-digit ids (`box-000001`), unique across both scenes.

Used by `packages/backend/src/format-upgrade.test.ts` (copied into a test
backend's data root and opened over HTTP, then played and exported).
