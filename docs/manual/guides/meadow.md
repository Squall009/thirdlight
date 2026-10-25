# Grow a meadow: ground cover, wind and grass that gives way

**Goal:** a terrain covered in dense, tall grass that sways in the scene's
wind, calms down in a sheltered spot, parts round the player and holds
60 fps. Every field is in [Ground cover](../features/terrain.md#ground-cover),
[Wind](../features/environment.md#wind) and
[Foliage gives way to subjects](../features/environment.md#foliage-gives-way-to-subjects).

The steps use the 3D starter, whose project already holds a terrain (layer
0 shows grass, 1 soil, 2 rock) and grass for ground cover: the model
`meadow-grass` with three clump pieces, `grass_a` (0.85 m), `grass_b`
(0.65 m) and `grass_c` (0.5 m), and its foliage material. Any project can
do the same with its own model: a few clumps of blades with levels of
detail (`_LOD0`, `_LOD1`, …) and wind weights in the vertex colour
(COLOR_0 red: 0 at the root, 1 at the tip), worn by a foliage material.

## In the editor

1. **The grass.** Double-click the **Terrain** to open the terrain editor,
   pick the **Scatter** mode and add a rule. On its card: the model
   `meadow-grass`, **Piece** `grass_a`; **Density** 3 (clumps per m²);
   **Spacing** 0 (a new card starts at 4 m, meant for trees and rocks:
   it would keep the grass to one clump per 16 m²); **On layer** the
   grass layer with a **share** over 0.4 (`>0.4`), so it thins where soil
   or rock shows; **Slope** up to 35° (`<35`); **Lean** 50 %; tick
   **Ground cover** and set its **Reach** (40–60 m). Add two more
   rules the same way for `grass_b` and `grass_c` (density 3 and 2): three
   heights read as a field, one as a lawn. **Bake rules**: the grass shows
   in the Scene view at once.
2. **Look at it.** Ground cover is made round the camera, so fly low over
   it. Sculpting and painting show in the cover at once; rule changes show
   after **Bake rules**.
3. **The wind.** **Window → Environment → Wind**: the direction, the
   **strength** (the base bend; the default 0.5 is a light breeze, the
   meadow perf class blows at 3), the **gusts**, and the **gust size** and
   **gust speed** of the pattern of gusts that sweeps over the field. The
   toolbar's **wind** switch makes the Scene view sway as Play does (off by
   default, so the editor does not redraw every frame).
4. **A sheltered spot.** **GameObject → Light → Wind zone**, placed in a
   hollow. In its Inspector: **Shape** sphere, **Radius** 25 m, **Blend**
   10 m, **Strength** 0 and **Gusts** 0.05. The Scene view draws the zone
   and, dashed, where its blend ends; with the wind switch on, the grass
   inside stills.
5. **Grass that gives way.** The camera's target (the player) already
   parts the grass. To change how much, select the player, **Add component
   → Foliage bend**: **radius** (m), **strength** (1: a tip leans by about
   its own height at the body), **recovery** (seconds for the path behind
   it to stand up). A rule's **Gives way** slider scales it per rule (0 for
   rocks or trunks that wear a foliage material).
6. **Play** and walk through it.

## Through the API

1. The cover rules: [`editTerrain`](../reference/ops-detail.md#op-editTerrain)
   kind `bake` with `scatter`
   ([`ScatterRule`](../reference/types-p-t.md#type-scatter-rule)):
   ```json
   {"entityId": "<terrain>", "kind": "bake", "scatter": [
     {"id": "grass_a", "asset": {"assetId": "meadow-grass", "piece": "grass_a"}, "density": 3,
      "scale": [0.8, 1.3], "align": 0.5, "layers": [{"layer": 0, "min": 0.4, "fade": 0.2}],
      "slope": {"max": 35, "fade": 5}, "cover": true, "coverDistance": 60},
     {"id": "grass_b", "asset": {"assetId": "meadow-grass", "piece": "grass_b"}, "density": 3,
      "scale": [0.8, 1.3], "align": 0.5, "layers": [{"layer": 0, "min": 0.4, "fade": 0.2}],
      "slope": {"max": 35, "fade": 5}, "cover": true, "coverDistance": 60}]}
   ```
   Send every rule the terrain should keep: the list replaces the old one.
   On a block layer the same rules go in `blockLayer.scatter`; on a model
   or an architecture object in `model.scatter` / `architecture.scatter`
   (cover rules only), through `setComponent`.
2. The wind: [`setEnvironment`](../reference/ops-detail.md#op-setEnvironment)
   with `sceneId` and the scene's whole look, its `wind` changed
   ([wind fields](../reference/scene-environment.md#scene-environment-wind)):
   ```json
   {"direction": [0.6, 0.8], "strength": 3, "gust": 2.4, "gustFrequency": 0.3, "turbulence": 0.3, "scale": 20}
   ```
3. A wind zone: `createEntity`, then `setComponent`:
   ```json
   {"entityId": "<zone>", "component": "windZone",
    "value": {"shape": "sphere", "radius": 25, "blend": 10, "strength": 0, "gust": 0.05}}
   ```
4. A subject's bend: `setComponent` `foliageBend` `{"radius": 1.2,
   "strength": 1, "recovery": 1}`. Scripts name other subjects with
   `ctx.camera.setSeeThrough({ subjects: [...] })` (the nearest four per
   view bend the grass).
5. While the game runs, a storm:
   `ctx.environment.setWind({ strength: 5, gust: 4 }, { blend: 8 })`, and
   back with `ctx.environment.setWind(null, { blend: 8 })`
   ([`ctx.environment`](../reference/script-api.md#ctx-environment)). It is
   simulation state: it replays and saves. Physical-sky clouds drift with
   it.

## Which to use

Use the editor: a field is judged by eye (density, heights, how it moves),
and the Scene view shows the cover and, with the wind switch, the wind.
Use the API to copy rules between terrains or projects, or to make many
zones from data.

## Budget

The engine's measured target is the `meadow` perf class: a 1 × 1 km
terrain covered with this grass at 8 clumps a m² to 60 m, wind, a walker
and a cloudy sky, which holds 60 fps at 1920 × 1080 on an integrated GPU
(Iris Xe) on both renderers, with 13 cover draws and about 0.5 ms of main
thread for the cover ([Performance](../features/performance.md#meadow-class)).
To stay inside it:

- Keep the **total density** near 8 clumps a m² and the **reach** near
  60 m; past it the terrain's grass layer reads as grass. In the engine's
  density sweep the first missed frames came at 32 clumps a m² near the
  camera, or 8 a m² carried out to 150 m.
- Give the model **levels of detail**: rings past the first level switch
  draw the cheaper level (the template's 55–70, 21 and 6 triangles).
- Leave **Casts shadow** off: cover receives shadows, and ambient occlusion
  darkens its roots.
- Keep the material's `windDistance` (the template's 40 m): far grass skips
  the wind's work.
- Smooth edges with **SMAA** (Window → Environment, **Anti-aliasing**; the 3D
  starter's scene already does). A scene without post effects draws with
  4× MSAA, which the thin blades make about 5 ms of GPU time a frame dearer:
  past a 60 Hz frame on WebGL 2 on an integrated GPU, where walking through
  the grass then drops frames.

## Pitfalls

- **Nothing grows:** check the rule's layer condition against what the
  ground shows there, the slope limit, and that the reach is past the
  camera's distance from the ground.
- **Sparse grass whatever the density:** the rule's **Spacing** wins over
  its density (no two copies closer than it); set it to 0 for cover.
- **The grass does not move:** its material is not a foliage one, or the
  model has no COLOR_0 (it then sways only a little, by its height share
  of its first metre), or the Scene view's wind switch is off (Play always
  moves).
- **`setEnvironment` replaces the scene's whole look.** Read it first and
  send it back with the wind changed.
- **A zone's edge is soft:** zones are baked into a map of 4 m texels
  round the camera, so an edge is never sharper than 4 m. Zones are read
  from above; their height does nothing.
- **Cover has no colliders or addresses.** For copies the player can cut,
  pick or bump into, use a stored scatter rule (`ctx.scatter`) instead.
- **The look is yours.** The engine adds no stylised grass shading: the
  colour, the blade shapes and how they catch light come from the model and
  its material.
