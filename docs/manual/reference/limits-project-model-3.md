# Limits and defaults: project-model (part 3, from `validate.ts`)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/project-model` defines, by source file. Values are the running build's.

<a id="limits-project-model--validate"></a>
## `validate.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-entity-depth"></a>`MAX_ENTITY_DEPTH` | `32` | The deepest an entity may sit in a scene's hierarchy (the root is depth 1). |
| <a id="limit-max-len"></a>`MAX_LEN` | `1000000` |  |
| <a id="limit-max-revision"></a>`MAX_REVISION` | `9007199254740991` |  |
| <a id="limit-name-max"></a>`NAME_MAX` | `128` |  |
| <a id="limit-name-min"></a>`NAME_MIN` | `1` |  |

<a id="limits-project-model--vertex-paint-stroke"></a>
## `vertex-paint-stroke.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-vertex-paint-brush-limits"></a>`VERTEX_PAINT_BRUSH_LIMITS` | `{"dabs":256,"radius":{"min":0.01,"max":64},"strengthMax":1}` | The vertex brush's bounds: a stroke fits one command. Strength is the shared brush's blend per dab (its bound is that brush's); the radius is metres in the world, not the block brush's cells, so it is bounded here. |

<a id="limits-project-model--vertex-paint"></a>
## `vertex-paint.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-vertex-paint-limits"></a>`VERTEX_PAINT_LIMITS` | `{"meshKey":512,"vertices":4000000,"along":400000,"across":4000}` | What one painted mesh and one path's paint grid may hold: a mesh's name, its vertices (as many as a model read decodes, so any mesh the engine draws can be painted), and a path grid's points along and across its path. Bounds of one record, not a cap on painted objects. |

<a id="limits-project-model--voxel-kit"></a>
## `voxel-kit.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-voxel-kit-limits"></a>`VOXEL_KIT_LIMITS` | `{"gameDataDepth":32,"materialIdMax":4095,"weightMax":1000,"jitterMax":4,"sheetSizeMin":16,"sheetSizeMax":16384}` |  |

<a id="limits-project-model--voxel-materials"></a>
## `voxel-materials.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-voxel-material-limits"></a>`VOXEL_MATERIAL_LIMITS` | `{"idMin":1,"idMax":4095,"tileMetresMin":0.5,"tileMetresMax":64,"heightDepthMax":0.25,"heightDepthDefault":0.02,"blendMetresMax":0.5,"blendMetresDefault":0.25,"gasColorDefault":"#ffffff","gasDensityDefault":0.1,"gasDensityMax":8}` |  |

<a id="limits-project-model--voxel-portal"></a>
## `voxel-portal.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-voxel-portal-defaults"></a>`VOXEL_PORTAL_DEFAULTS` | `{"open":false,"stops":{"light":true,"sight":true,"walk":true}}` | A door: shut, stopping light, sight and walkers (what a new portal starts as). |

<a id="limits-project-model--voxel-world"></a>
## `voxel-world.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-voxel-piece-seed-max"></a>`VOXEL_PIECE_SEED_MAX` | `4294967295` | The largest voxel piece seed (a voxel piece table holds a u32). |
| <a id="limit-voxel-world-defaults"></a>`VOXEL_WORLD_DEFAULTS` | `{"ring":{"loadRadius":192,"unloadRadius":224,"loadHeight":96,"unloadHeight":128},"collision":{"radius":48,"height":24},"levels":{"level0":64,"level1":128,"relief":16},"sectionEdge":16,"savedFields":["material","role","shape"],"blendMetres":0.25,"bakeLevel":2,"fineBuild":"off"}` | The voxel format's defaults in metres, as a world without its own settings streams. |

<a id="limits-project-model--water-body"></a>
## `water-body.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-water-body-reach-default-m"></a>`WATER_BODY_REACH_DEFAULT_M` | `256` | A body's reach when none is set (metres): a lake of half a kilometre across. |

<a id="limits-project-model--wind"></a>
## `wind.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-wind-defaults"></a>`WIND_DEFAULTS` | `{"scale":20,"octave":{"scale":0.27,"speed":1.6},"zoneBlend":2,"zonePriority":0,"zoneSize":[20,10,20],"zoneRadius":10}` | Defaults of the optional values. A 20 m pattern is a field's gust size; the second layer is about a quarter of it and a little faster, at a ratio that is not a whole number so the two never line up. |
| <a id="limit-wind-limits"></a>`WIND_LIMITS` | `{"strengthMax":10,"gustMax":10,"gustFrequencyMax":10,"speedMax":100,"scaleMin":0.5,"scaleMax":10000,"octaveScaleMin":0.05,"octaveScaleMax":4,"octaveSpeedMax":8,"zoneSizeMax":100000,"blendMax":10000,"priorityMin":-1000,"priorityMax":1000}` | The bounds of the wind's values (validation, the editor's sliders). |

<a id="limits-project-model--world-streaming"></a>
## `world-streaming.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-streaming-budget-default-mb"></a>`STREAMING_BUDGET_DEFAULT_MB` | `768` | The memory streamed world cells may take on the page (MiB): decoded terrain tiles and their texture layers, block chunks' meshes. The default holds the render rings of an 8 km landscape of 512 m tiles and a 1 km block area many times over beside the texture budget on a laptop sharing 8–16 GiB with its integrated GPU; a ring that holds more is reported. |
| <a id="limit-streaming-budget-max-mb"></a>`STREAMING_BUDGET_MAX_MB` | `65536` |  |
| <a id="limit-streaming-budget-min-mb"></a>`STREAMING_BUDGET_MIN_MB` | `1` |  |
| <a id="limit-streaming-radius-limits"></a>`STREAMING_RADIUS_LIMITS` | `{"min":1,"max":100000}` | A ring's radius and a hysteresis (metres). |
