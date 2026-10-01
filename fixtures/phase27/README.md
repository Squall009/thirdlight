# Per-scene environment upgrade fixture

`legacy-v5-environment/` — a data-root project in the format with one
project-wide environment (`project.json` schemaVersion 5: the sky, fog,
post-processing and wind in `content.json`'s `environment`), written by that
engine (commit `c3e18b9d`) through its own backend from neutral inputs: a box
in `scene-main`, a second scene `scene-two` with a box, then one
`setEnvironment` with a gradient sky, linear fog, post (ACES, exposure 1.2,
bloom), wind, quality `medium` and a preset `dusk` (its own
`assets/environment/dusk.envpreset.json`). `replay.json` is that last command.

Used by `packages/backend/src/format-upgrade.test.ts`: opened over HTTP it
becomes schemaVersion 6 in one new revision — the sky, fog, post and wind are
copied into both scene files, `content.json` keeps `{quality, presets}`, the
upgrade is reported in Problems, the recorded command replays from its record,
the file check finds nothing, and the export ships the project part in the
manifest and each scene's look in its scene file.
