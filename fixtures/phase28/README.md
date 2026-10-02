# Engine-owned view upgrade fixtures (schemaVersion 6 → 7)

Data-root projects in the format with a scene `camera` entity (`project.json`
schemaVersion 6), written by that engine (commit `7cef0542`) through its own
backend from neutral inputs. Each is shaped like one game's project, never a
copy of its content; `replay.json` is the last command each one recorded.

- `legacy-v6-start-camera/` — shaped like Skyforge Tactics: the start scene
  `scene-main` holds the camera (moved to `[0, 12, 14]`, tilted down 40°, lens
  50° / 0.3 m / 400 m) and two lights; a second scene `battle` holds an
  orbit-a-point virtual camera without a lens of its own and a tile. A 3D
  project. The last command set the camera's lens.
- `legacy-v6-title-player/` — shaped like Sprout: the start scene
  `scene-main` (the title) holds the camera (the default lens), the player (a
  box with the controller) and a spawn; a second scene `meadow` holds a spawn
  and the ground. The last command created the ground in `meadow`.

Used by `packages/backend/src/format-upgrade.test.ts`: opened over HTTP each
becomes schemaVersion 7 in one new revision — the scene camera becomes a
fixed virtual camera at the lowest priority (its lens the project's camera
settings where it differs from the default), the camera and the player keep
loaded, the upgrade is reported in Problems, the recorded command replays from
its record and the export ships the shots and the lens settings.

`move-frame/` — two schemaVersion 6 documents shaped the same way but 3D with
a scene camera turned about Y (`title-player.json`: the title scene holds the
camera and the player, no virtual camera anywhere; `start-camera.json`: the
camera in a start scene, a level with an orbit-a-point virtual camera and the
player). Each carries a recorded input and `v6.path`, the character's origin
every 30th step as the engine at `7cef0542` (schemaVersion 6) played it.
Used by `tests/integration/m23-3d/upgrade-move-frame.test.ts`: upgraded and
played again, the character walks the same path.
