# Per-scene look fixture

`scene-looks/` — a data-root project (id `legacy-v5-environment`, the id it
was written with; copy it to a folder of that name) with two scenes, each
with its own look. It was written by the engine with one project-wide
environment (commit `c3e18b9d`, from neutral inputs: a box in `scene-main`, a
second scene `scene-two` with a box, then one `setEnvironment` with a
gradient sky, linear fog, post (ACES, exposure 1.2, bloom), wind, quality
`medium` and a preset `dusk`, its own `assets/environment/dusk.envpreset.json`),
then opened once by the last engine that upgraded older projects
(`f3d40136`), so it is stored as `project.json` schemaVersion 7: the look in
both scene files, `content.json` keeping `{quality, presets}`. `replay.json`
is that last command, which must replay its recorded result.

Used by `packages/backend/src/format-upgrade.test.ts` (each scene's look in the
queries, the replay, the file check, the export and new scenes; the base
project of the open-time upgrades) and `tests/e2e/project-upgrade.e2e.ts`.
