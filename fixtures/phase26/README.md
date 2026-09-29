# Asset-file format upgrade fixture

`legacy-v4-assets/` — a data-root project in the format before the asset
files (`project.json` schemaVersion 4), written by the engine of that format
(commit `48a7bf98`) through its own service and commands from neutral inputs:
`fixtures/m2/assets/tiny-v1.glb` and `tiny-v2.glb` as the two versions of a
model `crate` (v2 current), `fixtures/import-ext/fbx/crate_checker.png`
encoded to KTX2 (`color`) as the texture `wall` (the PNG stored as its
`convertedFrom` original), a generated 0.1 s 440 Hz WAV `beep`, a material
using `wall`, and two objects. Every stored version is in `sources/sha256/`;
`content.json` and the scene file carry their retry records, and
`replay.json` is the last command, which must replay its recorded result.

Used by `packages/backend/src/format-upgrade.test.ts`: copied into a test
backend's data root and opened over HTTP, it becomes schemaVersion 5 with
`assets/Crate.glb`, `assets/Wall-checker.png` and `assets/Beep.wav` next to
their `.tlasset` sidecars, the KTX2 in the import cache, crate v1 left in
`sources/` and listed in `upgrade-report.json`, the replay answered from its
record, and the export shipping the same bytes.
