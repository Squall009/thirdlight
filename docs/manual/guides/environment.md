# Sky, fog and environment presets

**Goal:** a scene with a sky, distance and height fog that hide the far
edge of the level, and named presets (day, night, storm) a script blends
between while the game runs. Every field is in
[Environment](../features/environment.md) and
[the scene look reference](../reference/scene-environment.md#scene-environment-sky).

Two documents hold the look:

- **A scene's look** — sky, fog, height fog, post-processing, wind, wetness.
  Each scene has its own; the **active** scene's applies (the first start
  scene, unless the game makes another active).
- **The project's environment** — the presets every scene can switch to,
  and the quality levels.

## In the editor

1. **Window → Environment**. Its **Scene** picker names the scene whose
   look you edit.
2. **Sky**: physical (sun and atmosphere, the sun following the scene's
   directional light), gradient, an image (equirect or six faces; turn it
   with *rotation*) or one colour.
3. **Fog**: linear or exponential distance fog. **Height fog**: fog that
   lies low and thickens with distance, and fogs the sky toward the
   horizon. Set the camera's far plane (`camera_far_m`) to where the level
   should end.
4. **Presets**: type a name and **capture current as preset**: the sky,
   fog, post and every scene light's colour, intensity and direction are
   stored. **preview** and the **blend preview** slider show a preset in the
   Scene view without storing anything.

## Through the API

- A scene's look: [`setEnvironment`](../reference/ops-detail.md#op-setEnvironment)
  with `sceneId`:
  ```json
  {"sceneId": "scene-main", "environment": {"sky": {"mode": "procedural"},
   "heightFog": {"density": 0.03, "height": 0, "falloff": 0.08, "color": "#c8d2dc", "inscatterColor": "#ffd9a0"}}}
  ```
- Presets: `setEnvironment` without `sceneId`, `environment.presets`
  (each `{presetId, name, sky?, fog?, heightFog?, post?, lights?, lightmap?, wetness?}`):
  ```json
  {"environment": {"presets": [{"presetId": "night", "name": "Night",
    "fog": {"mode": "exp2", "color": "#101828", "density": 0.02},
    "lights": [{"type": "directional", "intensity": 0.1, "color": "#8090ff"}],
    "lightmap": {"intensity": 0.2, "tint": "#8090ff"}}]}}
  ```
- While the game runs, a script switches with
  `ctx.environment.set("night", {blend: 5})` or holds a mix with
  `ctx.environment.blend("day", "night", t)`
  ([`ctx.environment`](../reference/script-api.md#ctx-environment)); visual
  scripts have **Set environment** and **Blend environments**. The blend is
  simulation state: it replays and saves.

## Which to use

Use the editor: a look is judged by eye, and the window previews presets
and blends without storing anything. Use the API to copy a look between
scenes or projects, or to generate presets (a day cycle's steps).

## Pitfalls

- **`setEnvironment` replaces the whole document it names.** Sending only
  `heightFog` for a scene removes its sky; sending only `qualityLevels` for
  the project removes its presets. Read the document first and send it
  back whole with your change.
- **Only the active scene's look shows.** Play from another scene still
  shows the first start scene's look, so put the look on the start scene
  or make the scene active from the game.
- **A preset's light colour does not change baked surfaces.** Give night
  presets a `lightmap` multiplier.
- **Some settings cannot blend** (tone mapping, anti-aliasing, AO, depth of
  field, the LUT): the heavier look's is used.
- **Presets name lights by id, tag or type**; an entry naming none changes
  every light.
