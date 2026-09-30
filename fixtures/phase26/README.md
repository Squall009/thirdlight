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

`legacy-v5-music/` — a data-root project in the files format before one audio
kind (`project.json` schemaVersion 5, asset records in `.tlasset` sidecars),
written by that engine (commit `e235e907`) through its own backend: a folder
import of `fixtures/music/chord.ogg` (`Theme.ogg`, Ogg Vorbis), `chord-opus.ogg`
(`Voice.ogg`, Ogg Opus), a generated 3 s 48 kHz mono WAV (`Rain.wav`) — all three
`music` records — and `fixtures/m3/media/wav/cue-jump.wav` (`Hit.wav`, an `audio`
record of the fixed short-sound profile), then a box with an audio source
playing `rain`. `replay.json` is that last command.

Used by the same test file: opened over HTTP, every record becomes `audio`
with its id, file and header facts kept (the short-sound record's PCM
arithmetic dropped), the sidecars are written back with their load settings,
the replay is answered from its record, and the export's manifest carries
each audio file's load type and preload.
