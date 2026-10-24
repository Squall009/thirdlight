# Runtime build format fixture

`legacy-v4-build/` — a runtime content build in manifest version 4 and the
project it was built from, written by the engine before the catalog (commit
`8c21bfa3`, the Play/export closure run through its own service): a project
(id `legacy-v4-assets`) with a model `crate` (two versions), a KTX2 texture
`wall`, a short WAV `beep`, a second scene with an object playing `beep`, a
prefab of the crate, the material `wall-mat` on the box and the label `sfx`
on `beep`. `project/` is the project after those commands (the import cache
left out; the KTX2 is made again on open), opened once more by the last
engine that upgraded older projects (`f3d40136`) so it is stored as
`project.json` schemaVersion 7 (its scene camera became the lowest-priority
shot); `build/` the manifest, its content file and the scene files,
`replay.json` the last command.

Used by `tests/integration/m26-catalog/catalog.test.ts`: the v4 build opens on
the game page's reader (`openRuntimeContent`) into the same asset rows,
blocks, scene rows and simulation inputs as the v5 export the engine now makes
of `project/`; the last command replays from its record.
