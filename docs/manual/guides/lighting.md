# Lighting and baking

**Goal:** a scene lit by a sun, a sky and a few lamps, with baked indirect
light (light probes, and lightmaps where you want them), light layers to
keep lamps where they belong, and quality levels a player can pick. Every
detail is in [Lighting](../features/lighting.md).

## What lights a scene

- **Realtime lights:** at most one directional (the sun), one ambient and
  one hemisphere light per scene, and 16 point and spot lights across the
  loaded scenes ([`light`](../reference/components-lighting.md#component-light)).
- **Light probes** hold the indirect light (the sky, and light bounced off
  static objects) on a grid; every lit 3D object reads them per pixel, moving
  or not. Most scenes need probes and no lightmaps.
- **Lightmaps** bake light into textures for static objects (boxes, and
  models with a second UV set). A light set to **baked** is then no longer
  realtime; **mixed** keeps its direct light realtime and bakes its bounce.
- **Light layers** (8, named in Project Settings): a light lights only the
  objects that share a layer with its **Light mask**.
- **Quality levels** set what a player's machine draws: render scale,
  shadow map size, how many lamps cast shadows, ambient occlusion.

## In the editor

1. Add lights with **GameObject → Light**. Tick **Static** on the objects
   that never move (Inspector flags).
2. Optional: **GameObject → Light → Probe volume** to say where probes go
   (without one they cover the static objects' bounds).
3. **Window → Lighting**: the window names the scene it bakes. **Bake
   probes** bakes the probes (needs WebGPU; the window says so on WebGL 2).
   **Bake preview (browser)** bakes lightmaps without bounce light; **Bake
   final (Blender)** needs a bake host set up on the server. A bake shown
   *stale* is still used until you bake again or clear it.
4. **Gizmos → Light probes** draws every probe as a small sphere.
5. **File → Project Settings… → Light layers** names the layers; each
   object's and light's Inspector then shows them as checkboxes.
6. **Project Settings → Quality** lists the quality levels (*Customize
   levels* starts from the engine's low, medium and high).

## Through the API

Everything but the bake itself:

- Lights: [`createEntity`](../reference/ops-detail.md#op-createEntity) with
  `components.light`, e.g. `{"type": "point", "color": "#ffd9a0",
  "intensity": 30, "range": 8, "lightMask": 2, "mode": "mixed"}`.
- Static: [`updateEntity`](../reference/ops-detail.md#op-updateEntity)
  `{"entityId": "<id>", "static": true}`.
- A probe volume: `createEntity` with `components.probeVolume
  {"size": [32, 8, 16], "spacing": 2}`
  ([`probeVolume`](../reference/components-rendering-1.md#component-probeVolume)).
- Layer names: [`setLightLayers`](../reference/ops-detail.md#op-setLightLayers)
  `{"layers": ["World", "Interior"]}`; an object's layers are its
  `lightLayers` mask (bit n = layer n + 1).
- Quality levels: [`setEnvironment`](../reference/ops-detail.md#op-setEnvironment)
  without `sceneId`, `environment.qualityLevels`
  ([`QualityLevelConfig`](../reference/types-p-u.md#type-quality-level-config))
  and `environment.quality` (the starting level).
- Clear a bake: [`setLighting`](../reference/ops-detail.md#op-setLighting)
  `{"sceneId": "<scene>", "lighting": null}`.
- Check it in Play: `tl_diagnostics` shows `renderer.probes` (tiles,
  probes, resident, beyond the budget) and `renderer.quality`;
  `tl_game_control {command: "setQuality", level: "low"}` switches the level
  for the rest of the session.

The bakes run in an editor page (the backend's headless editor works too):
there is no command that bakes.

## Which to use

Set lights up whichever way you like, and bake in the editor: the bake needs
the editor's renderer. Script your setup (lights, probe volumes, layers,
quality levels) when you have many scenes to light the same way.

## Pitfalls

- **Bake probes needs WebGPU.** Lightmaps preview on either renderer.
- **A baked light is gone from moving objects too:** they get its bounce
  from the probes, not its direct light. Use `mixed` for lights that must
  light moving things.
- **Probes stream in large worlds** within 128 MB of GPU memory; past it
  surfaces get the flat ambient light, and Problems says so once
  (`probe_budget`).
- **Turning an image sky after a bake makes the probes stale.**
- **Lamps cost every lit object.** Give lamps a range, use **Importance:
  Per vertex** for cheap fill lights, and keep shadows for the few that need
  them: a quality level's `shadowedLights` budget (2–4) keeps only the
  largest on screen. Generated rooms keep a lamp's light inside its room;
  see the interior lighting best practice in
  [Generated architecture](../features/architecture.md#interior-lighting-best-practice-shadow-rules).
- **`setEnvironment` replaces the whole document it names:** send the
  quality levels together with the presets and the rest of the project's
  environment. See [environment](environment.md).
