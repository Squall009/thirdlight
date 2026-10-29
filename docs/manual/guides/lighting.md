# Lighting and baking

**Goal:** a scene lit by a sun, a sky and a few lamps, its light baked for
WebGL 2 and the low quality level, light layers to keep lamps where they
belong, and quality levels a player can pick. Every
detail is in [Lighting](../features/lighting.md).

## What lights a scene

- **Realtime lights:** at most one directional (the sun), one ambient and
  one hemisphere light per scene, and any number of point, spot and area
  lights ([`light`](../reference/components-lighting.md#component-light)):
  each pixel loops over the lights of its light cluster, so the cost is the
  lights reaching a pixel, not the lights in the scene.
- **Area lights** (panels and strips with a size, aimed by the object's
  rotation) light the static surfaces through the surface cache, with soft
  shadows, and moving objects per pixel through the light clusters
  ([Area lights](../features/lighting.md#area-lights)).
- **The live light** (WebGPU, medium and high quality) lights the static
  surfaces and the light probes as the scene changes: direct light with soft
  shadows, and bounced light; every lit 3D object reads the probes per
  pixel, moving or not. The sun stays per pixel with its shadow map and
  contact shadows; moving objects receive the light but do not block or
  bounce it ([How lighting works](../features/lighting.md#how-lighting-works)).
- **Glow** lights its surroundings only from a static box with an emissive
  `surface` ([Emissive light](../features/lighting.md#emissive-light)).
- **Bake lighting** saves that light for WebGL 2, the low quality level and
  exports: a light set to **baked** keeps its direct light and bounce in the
  bake (and no longer lights per pixel); **mixed** keeps its direct light
  per pixel and its bounce in the bake; **realtime** is never baked.
- **Light layers** (8, named in Project Settings): a light lights only the
  objects that share a layer with its **Light mask**.
- **Quality levels** set what a player's machine draws: render scale,
  shadow map size, how many lamps cast shadows, ambient occlusion, and the
  **lighting tier** — low (saved light), medium (live within a budget) or
  high (more rays, reach and memory). A device starts at the highest level
  whose tier it fits (WebGL 2 low, an integrated GPU medium, a discrete one
  high) unless the player or the game picks one ([Lighting tiers](../features/debugging.md#lighting-tiers)).
  Scripts wait for the light with `ctx.lighting.settled` / `justSettled`.

## In the editor

1. Add lights with **GameObject → Light**. Tick **Static** on the objects
   that never move (Inspector flags).
2. **Window → Lighting**: the window names the scene it bakes. **Bake
   lighting** runs the live light until it settles and saves it (needs
   WebGPU; the window says so on WebGL 2). A bake shown *stale* is still
   used until you bake again or clear it; a bake of the earlier bakers
   (lightmaps, probe grids) shows as stale and draws until you bake again.
3. **View** menu: **Cache texels**, **Light probes**, **Rooms and
   portals**, **Stale pages**, **Light clusters** and **Lighting pass times** show what the
   lighting holds and what each pass costs. The Lighting window previews a
   quality level, turns live lighting off for the view, and sets the
   level's lighting budgets ([In the Scene view](../features/lighting.md#in-the-scene-view)).
4. **File → Project Settings… → Light layers** names the layers; each
   object's and light's Inspector then shows them as checkboxes.
5. **Project Settings → Quality** lists the quality levels (*Customize
   levels* starts from the engine's low, medium and high).

## Through the API

Everything the editor does, the bake included:

- Lights: [`createEntity`](../reference/ops-detail.md#op-createEntity) with
  `components.light`, e.g. `{"type": "point", "color": "#ffd9a0",
  "intensity": 30, "range": 8, "lightMask": 2, "mode": "mixed"}`.
- Static: [`updateEntity`](../reference/ops-detail.md#op-updateEntity)
  `{"entityId": "<id>", "static": true}`.
- Layer names: [`setLightLayers`](../reference/ops-detail.md#op-setLightLayers)
  `{"layers": ["World", "Interior"]}`; an object's layers are its
  `lightLayers` mask (bit n = layer n + 1).
- Quality levels: [`setEnvironment`](../reference/ops-detail.md#op-setEnvironment)
  without `sceneId`, `environment.qualityLevels`
  ([`QualityLevelConfig`](../reference/types-o-t.md#type-quality-level-config))
  and `environment.quality` (the starting level). A level's `lighting` names
  its tier; its own `surfaceCacheMiB`, `surfaceLightMs`, `contactShadows`
  and `reflections` lay over the tier's, e.g. `{"id": "medium", "name":
  "Medium", "lighting": "medium", "surfaceLightMs": 1}` for a slower but
  cheaper live light.
- Scripts: `ctx.lighting.tier`, `.live`, `.settled` and `.justSettled`
  (true for one step after the light settled: lift a loading screen then).
- Bake: `tl_bake_lighting {"sceneId": "<scene>"}` asks the project's editor
  (the connected browser, else the backend's headless one, on WebGPU) to run
  the Lighting window's bake on the scene it has open, and waits for it
  ([`tl_bake_lighting`](../reference/mcp-tools-1.md#tool-tl_bake_lighting)).
- Clear a bake: [`setLighting`](../reference/ops-detail.md#op-setLighting)
  `{"sceneId": "<scene>", "lighting": null}`.
- Check it in Play: `tl_diagnostics` shows `renderer.probes` (tiles,
  probes, resident, beyond the budget) and `renderer.quality`;
  `tl_game_control {command: "setQuality", level: "low"}` switches the level
  for the rest of the session.

The bake runs in an editor page (the backend's headless editor works too),
on its WebGPU renderer: it is the live light itself, saved.

## Which to use

Set lights up whichever way you like, and bake in the editor or with
`tl_bake_lighting`: the bake needs the editor's renderer. Script your setup
(lights, layers, quality levels) when you have many scenes to light the same
way.

## Pitfalls

- **Bake lighting needs WebGPU** (the saved light draws on both renderers).
- **Terrain and static boxes are not baked**: they keep their per-pixel
  lights and the probes on WebGL 2 and the low level. Glowing boxes are not
  baked either: on WebGL 2 they light nothing around them.
- **Static boxes do not stop light** in the surface cache: build walls that
  must hold light in from block layers, generated architecture or models.
- **Emissive materials light nothing around them** (models, blocks, trims):
  add a static glowing box or an area light where the glow should fall.
- **Area lights on moving objects are unshadowed** for now: a lamp that
  must cast a character's shadow is a spot light with a shadow.
- **A baked light is gone from moving objects too:** they get its bounce
  from the probes, not its direct light. Use `mixed` for lights that must
  light moving things.
- **Turning an image sky after a bake makes the bake stale.**
- **Lamps cost every lit object** drawn per pixel. Give lamps a range, set
  **Local lights: None** on objects no lamp needs to reach, and keep shadows
  for the few that need them: shadowed spot, point and area lights share the
  quality level's shadow atlas (`shadowAtlas`; the largest on screen get the
  most texels, a lamp without room lights unshadowed; a point light takes six
  faces, so prefer a spot where one view will do). Generated rooms keep a lamp's light inside its room;
  see the interior lighting best practice in
  [Generated architecture](../features/architecture.md#interior-lighting-best-practice-shadow-rules).
- **`setEnvironment` replaces the whole document it names:** send the
  quality levels together with the presets and the rest of the project's
  environment. See [environment](environment.md).
