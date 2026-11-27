# Content documents (materials to materials)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content blocks and their fields. Paths with `[]` are list items and `{}` map values.

<a id="content-materials"></a>
## materials — Materials

Project materials.

- In every project: no
- Written by: [`setMaterial`](ops-detail.md#op-setMaterial), [`deleteMaterial`](ops-detail.md#op-deleteMaterial)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `materials` | list of objects | `[]` |  | **Materials.** The project's materials (each its own file). |
| `materials[].materialId` | string, id, 1–64 chars |  |  | **Id.** The stable material id. (required; format id) |
| `materials[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in pickers. (required; format name) |
| `materials[].shader` | enum: `standard`, `foliage`, `kit`, `unlit`, `water`, `trim`, `decal` | `"standard"` |  | **Shader.** Standard, foliage (wind), kit (shown as Atlas surface: world-aligned atlas detail), unlit, water, trim (a trim sheet: its row table in trim) or decal (a mark decals and decal meshes draw with: its own textures or a trim sheet's decal cell in decal). (required) |
| `materials[].params` | object | `{}` |  | **Parameters.** Shader parameter overrides. (required) |
| `materials[].params.color` | color | `"#ffffff"` |  | **Color.** The standard shader's color (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.roughness` | number | `0.8` | 0 – 1, step 0.01 | **Roughness.** The standard shader's roughness (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.metalness` | number | `0` | 0 – 1, step 0.01 | **Metalness.** The standard shader's metalness (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.emissive` | color | `"#000000"` |  | **Emissive.** The standard shader's emissive (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.emissiveIntensity` | number | `0` | 0 – 16, step 0.1 | **Emissive Intensity.** The standard shader's emissive intensity (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.alphaMode` | enum: `opaque`, `cutout`, `blend` | `"opaque"` |  | **Alpha Mode.** The standard shader's alpha mode (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.alphaCutoff` | number | `0.5` | 0 – 1, step 0.01 | **Alpha Cutoff.** The standard shader's alpha cutoff (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.opacity` | number | `1` | 0 – 1, step 0.01 | **Opacity.** The standard shader's opacity (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.doubleSided` | bool | `false` |  | **Double Sided.** The standard shader's double sided (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.tiling` | vec2 [x, y] | `[1,1]` | 0.001 – 1000, step 0.01 | **Tiling.** The standard shader's tiling (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.offset` | vec2 [x, y] | `[0,0]` | -1000 – 1000, step 0.01 | **Offset.** The standard shader's offset (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.normalScale` | number | `1` | 0 – 4, step 0.1 | **Normal Scale.** The standard shader's normal scale (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.aoIntensity` | number | `1` | 0 – 2, step 0.1 | **AO Intensity.** The standard shader's ao intensity (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.localLights` | enum: `object`, `pixel`, `none` | `"object"` |  | **Local Lights.** The standard shader's local lights (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.paintTint` | bool | `false` |  | **Paint Tint.** The standard shader's paint tint (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
| `materials[].params.color` | color | `"#ffffff"` |  | **Color.** The foliage shader's color (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.roughness` | number | `0.8` | 0 – 1, step 0.01 | **Roughness.** The foliage shader's roughness (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.metalness` | number | `0` | 0 – 1, step 0.01 | **Metalness.** The foliage shader's metalness (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.emissive` | color | `"#000000"` |  | **Emissive.** The foliage shader's emissive (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.emissiveIntensity` | number | `0` | 0 – 16, step 0.1 | **Emissive Intensity.** The foliage shader's emissive intensity (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.alphaMode` | enum: `opaque`, `cutout`, `blend` | `"opaque"` |  | **Alpha Mode.** The foliage shader's alpha mode (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.alphaCutoff` | number | `0.5` | 0 – 1, step 0.01 | **Alpha Cutoff.** The foliage shader's alpha cutoff (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.opacity` | number | `1` | 0 – 1, step 0.01 | **Opacity.** The foliage shader's opacity (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.doubleSided` | bool | `true` |  | **Double Sided.** The foliage shader's double sided (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.tiling` | vec2 [x, y] | `[1,1]` | 0.001 – 1000, step 0.01 | **Tiling.** The foliage shader's tiling (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.offset` | vec2 [x, y] | `[0,0]` | -1000 – 1000, step 0.01 | **Offset.** The foliage shader's offset (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.normalScale` | number | `1` | 0 – 4, step 0.1 | **Normal Scale.** The foliage shader's normal scale (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.aoIntensity` | number | `1` | 0 – 2, step 0.1 | **AO Intensity.** The foliage shader's ao intensity (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.localLights` | enum: `object`, `pixel`, `none` | `"object"` |  | **Local Lights.** The foliage shader's local lights (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.windBend` | number | `1` | 0 – 4, step 0.1 | **Wind Bend.** The foliage shader's wind bend (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.windFlutter` | number | `1` | 0 – 4, step 0.1 | **Wind Flutter.** The foliage shader's wind flutter (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.flutterFrequency` | number | `6` | 0 – 30, step 0.1 | **Flutter Frequency.** The foliage shader's flutter frequency (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.subsurface` | number | `0.3` | 0 – 1, step 0.01 | **Subsurface.** The foliage shader's subsurface (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.windDistance` | number | `0` | 0 – 10000, step 0.1 | **Wind Distance.** The foliage shader's wind distance (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.rootColour` | number | `0` | 0 – 1, step 0.01 | **Root Colour.** The foliage shader's root colour (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.rootColourHeight` | number | `0.4` | 0.01 – 1, step 0.01 | **Root Colour Height.** The foliage shader's root colour height (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.color` | color | `"#ffffff"` |  | **Color.** The kit shader's color (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.roughness` | number | `0.8` | 0 – 1, step 0.01 | **Roughness.** The kit shader's roughness (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.metalness` | number | `0` | 0 – 1, step 0.01 | **Metalness.** The kit shader's metalness (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.emissive` | color | `"#000000"` |  | **Emissive.** The kit shader's emissive (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.emissiveIntensity` | number | `0` | 0 – 16, step 0.1 | **Emissive Intensity.** The kit shader's emissive intensity (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.alphaMode` | enum: `opaque`, `cutout`, `blend` | `"opaque"` |  | **Alpha Mode.** The kit shader's alpha mode (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.alphaCutoff` | number | `0.5` | 0 – 1, step 0.01 | **Alpha Cutoff.** The kit shader's alpha cutoff (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.opacity` | number | `1` | 0 – 1, step 0.01 | **Opacity.** The kit shader's opacity (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.doubleSided` | bool | `false` |  | **Double Sided.** The kit shader's double sided (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.tiling` | vec2 [x, y] | `[1,1]` | 0.001 – 1000, step 0.01 | **Tiling.** The kit shader's tiling (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.offset` | vec2 [x, y] | `[0,0]` | -1000 – 1000, step 0.01 | **Offset.** The kit shader's offset (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.normalScale` | number | `1` | 0 – 4, step 0.1 | **Normal Scale.** The kit shader's normal scale (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.aoIntensity` | number | `1` | 0 – 2, step 0.1 | **AO Intensity.** The kit shader's ao intensity (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.localLights` | enum: `object`, `pixel`, `none` | `"object"` |  | **Local Lights.** The kit shader's local lights (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.uvPeriod` | number | `4` | 0.25 – 64, step 0.1 | **Uv Period.** The kit shader's uv period (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.macroNormalScale` | number | `1` | 0 – 4, step 0.1 | **Macro Normal Scale.** The kit shader's macro normal scale (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
| `materials[].params.color` | color | `"#ffffff"` |  | **Color.** The unlit shader's color (absent: the file's value or the shader default). (applies when `../shader` is `unlit`) |
| `materials[].params.opacity` | number | `1` | 0 – 1, step 0.01 | **Opacity.** The unlit shader's opacity (absent: the file's value or the shader default). (applies when `../shader` is `unlit`) |
| `materials[].params.alphaMode` | enum: `opaque`, `cutout`, `blend` | `"opaque"` |  | **Alpha Mode.** The unlit shader's alpha mode (absent: the file's value or the shader default). (applies when `../shader` is `unlit`) |
| `materials[].params.alphaCutoff` | number | `0.5` | 0 – 1, step 0.01 | **Alpha Cutoff.** The unlit shader's alpha cutoff (absent: the file's value or the shader default). (applies when `../shader` is `unlit`) |
| `materials[].params.doubleSided` | bool | `false` |  | **Double Sided.** The unlit shader's double sided (absent: the file's value or the shader default). (applies when `../shader` is `unlit`) |
| `materials[].params.tiling` | vec2 [x, y] | `[1,1]` | 0.001 – 1000, step 0.01 | **Tiling.** The unlit shader's tiling (absent: the file's value or the shader default). (applies when `../shader` is `unlit`) |
| `materials[].params.offset` | vec2 [x, y] | `[0,0]` | -1000 – 1000, step 0.01 | **Offset.** The unlit shader's offset (absent: the file's value or the shader default). (applies when `../shader` is `unlit`) |
| `materials[].params.vertexTint` | bool | `false` |  | **Vertex Tint.** The unlit shader's vertex tint (absent: the file's value or the shader default). (applies when `../shader` is `unlit`) |
| `materials[].params.color` | color | `"#1d5f8a"` |  | **Color.** The water shader's color (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.shallowColor` | color | `"#4fb3c9"` |  | **Shallow Color.** The water shader's shallow color (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.opacity` | number | `0.8` | 0 – 1, step 0.01 | **Opacity.** The water shader's opacity (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.roughness` | number | `0.1` | 0 – 1, step 0.01 | **Roughness.** The water shader's roughness (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.normalScale` | number | `0.6` | 0 – 4, step 0.1 | **Normal Scale.** The water shader's normal scale (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.flow` | vec2 [x, y] | `[0.05,0.02]` | -10 – 10, step 0.01 | **Flow.** The water shader's flow (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.waveScale` | number | `2` | 0.01 – 100, step 0.1 | **Wave Scale.** The water shader's wave scale (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.fresnel` | number | `3` | 0 – 10, step 0.1 | **Fresnel.** The water shader's fresnel (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.doubleSided` | bool | `false` |  | **Double Sided.** The water shader's double sided (absent: the file's value or the shader default). (applies when `../shader` is `water`) |
| `materials[].params.color` | color | `"#ffffff"` |  | **Color.** The trim shader's color (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.roughness` | number | `1` | 0 – 1, step 0.01 | **Roughness.** The trim shader's roughness (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.metalness` | number | `1` | 0 – 1, step 0.01 | **Metalness.** The trim shader's metalness (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.normalScale` | number | `1` | 0 – 4, step 0.1 | **Normal Scale.** The trim shader's normal scale (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.aoIntensity` | number | `1` | 0 – 2, step 0.1 | **AO Intensity.** The trim shader's ao intensity (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.occlusion` | number | `1` | 0 – 1, step 0.01 | **Occlusion.** The trim shader's occlusion (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.wetness` | number | `0` | 0 – 1, step 0.01 | **Wetness.** The trim shader's wetness (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.wetFlatten` | number | `0.7` | 0 – 1, step 0.01 | **Wet Flatten.** The trim shader's wet flatten (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.alphaMode` | enum: `opaque`, `cutout` | `"opaque"` |  | **Alpha Mode.** The trim shader's alpha mode (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.alphaCutoff` | number | `0.5` | 0 – 1, step 0.01 | **Alpha Cutoff.** The trim shader's alpha cutoff (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.doubleSided` | bool | `false` |  | **Double Sided.** The trim shader's double sided (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.localLights` | enum: `object`, `pixel`, `none` | `"object"` |  | **Local Lights.** The trim shader's local lights (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.color` | color | `"#ffffff"` |  | **Color.** The decal shader's color (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.opacity` | number | `1` | 0 – 1, step 0.01 | **Opacity.** The decal shader's opacity (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.roughness` | number | `1` | 0 – 1, step 0.01 | **Roughness.** The decal shader's roughness (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.metalness` | number | `0` | 0 – 1, step 0.01 | **Metalness.** The decal shader's metalness (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.normalScale` | number | `1` | 0 – 4, step 0.1 | **Normal Scale.** The decal shader's normal scale (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.aoIntensity` | number | `1` | 0 – 2, step 0.1 | **AO Intensity.** The decal shader's ao intensity (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.emissive` | color | `"#000000"` |  | **Emissive.** The decal shader's emissive (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.emissiveIntensity` | number | `0` | 0 – 16, step 0.1 | **Emissive Intensity.** The decal shader's emissive intensity (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.blend` | enum: `blend`, `multiply`, `add` | `"blend"` |  | **Blend.** The decal shader's blend (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].params.sortOrder` | number | `0` | -1000 – 1000, step 0.1 | **Sort Order.** The decal shader's sort order (absent: the file's value or the shader default). (applies when `../shader` is `decal`) |
| `materials[].textures` | object | `{}` |  | **Textures.** Texture slots. (required) |
| `materials[].textures.map` | asset id (texture) |  |  | **Map.** The standard shader's map texture. (applies when `../shader` is `standard`) |
| `materials[].textures.normalMap` | asset id (texture) |  |  | **Normal Map.** The standard shader's normalMap texture. (applies when `../shader` is `standard`) |
| `materials[].textures.ormMap` | asset id (texture) |  |  | **Orm Map.** The standard shader's ormMap texture. (applies when `../shader` is `standard`) |
| `materials[].textures.emissiveMap` | asset id (texture) |  |  | **Emissive Map.** The standard shader's emissiveMap texture. (applies when `../shader` is `standard`) |
| `materials[].textures.map` | asset id (texture) |  |  | **Map.** The foliage shader's map texture. (applies when `../shader` is `foliage`) |
| `materials[].textures.normalMap` | asset id (texture) |  |  | **Normal Map.** The foliage shader's normalMap texture. (applies when `../shader` is `foliage`) |
| `materials[].textures.ormMap` | asset id (texture) |  |  | **Orm Map.** The foliage shader's ormMap texture. (applies when `../shader` is `foliage`) |
| `materials[].textures.emissiveMap` | asset id (texture) |  |  | **Emissive Map.** The foliage shader's emissiveMap texture. (applies when `../shader` is `foliage`) |
| `materials[].textures.map` | asset id (texture) |  |  | **Map.** The kit shader's map texture. (applies when `../shader` is `kit`) |
| `materials[].textures.normalMap` | asset id (texture) |  |  | **Normal Map.** The kit shader's normalMap texture. (applies when `../shader` is `kit`) |
| `materials[].textures.ormMap` | asset id (texture) |  |  | **Orm Map.** The kit shader's ormMap texture. (applies when `../shader` is `kit`) |
| `materials[].textures.emissiveMap` | asset id (texture) |  |  | **Emissive Map.** The kit shader's emissiveMap texture. (applies when `../shader` is `kit`) |
| `materials[].textures.macroNormalMap` | asset id (texture) |  |  | **Macro Normal Map.** The kit shader's macroNormalMap texture. (applies when `../shader` is `kit`) |
| `materials[].textures.map` | asset id (texture) |  |  | **Map.** The unlit shader's map texture. (applies when `../shader` is `unlit`) |
| `materials[].textures.normalMap` | asset id (texture) |  |  | **Normal Map.** The water shader's normalMap texture. (applies when `../shader` is `water`) |
| `materials[].textures.map` | asset id (texture) |  |  | **Map.** The trim shader's map texture. (applies when `../shader` is `trim`) |
| `materials[].textures.normalMap` | asset id (texture) |  |  | **Normal Map.** The trim shader's normalMap texture. (applies when `../shader` is `trim`) |
| `materials[].textures.ormMap` | asset id (texture) |  |  | **Orm Map.** The trim shader's ormMap texture. (applies when `../shader` is `trim`) |
| `materials[].textures.map` | asset id (texture) |  |  | **Map.** The decal shader's map texture. (applies when `../shader` is `decal`) |
| `materials[].textures.normalMap` | asset id (texture) |  |  | **Normal Map.** The decal shader's normalMap texture. (applies when `../shader` is `decal`) |
| `materials[].textures.ormMap` | asset id (texture) |  |  | **Orm Map.** The decal shader's ormMap texture. (applies when `../shader` is `decal`) |
| `materials[].textures.emissiveMap` | asset id (texture) |  |  | **Emissive Map.** The decal shader's emissiveMap texture. (applies when `../shader` is `decal`) |
| `materials[].parameters` | list of objects, ≤ 64 items |  |  | **Exposed parameters.** Up to 64 parameters the graph reads (Parameter nodes); objects may override the public ones. |
| `materials[].parameters[].key` | string, identifier, 1–32 chars |  |  | **Key.** The name Parameter nodes and overrides use. (required; format identifier) |
| `materials[].parameters[].type` | enum: `float`, `vec2`, `vec3`, `vec4`, `color`, `texture`, `data` | `"float"` |  | **Type.** The value type (colour is a vec3 edited as a colour; a texture names a texture asset). (required) |
| `materials[].parameters[].default` | JSON (typed by materialParameter) |  |  | **Default.** The material's own value (a number, 2–4 numbers, "#rrggbb", a texture asset id / "", or a data parameter's starting RGBA bytes). (required) |
| `materials[].parameters[].min` | number |  |  | **Min.** The lowest value, within ±1e6 (numbers and vectors). (applies when `type` is `float` or `vec2` or `vec3` or `vec4`) |
| `materials[].parameters[].max` | number |  |  | **Max.** The highest value, within ±1e6 and at least min (numbers and vectors). (applies when `type` is `float` or `vec2` or `vec3` or `vec4`) |
| `materials[].parameters[].size` | vec2 [width, height] | `[8,8]` | 1 – 64, step 1 | **Size.** A data parameter's cells [width, height], 1–64 each. (required; applies when `type` is `data`) |
| `materials[].parameters[].visibility` | enum: `public`, `private` | `"public"` |  | **Visibility.** Public: objects may override it. Private: the material's value only. (stored only when not the default) |
| `materials[].parameters[].label` | string, 1–64 chars |  |  | **Label.** Shown instead of the key. |
| `materials[].parameters[].group` | string, 1–64 chars |  |  | **Group.** A foldable group in the Inspector. |
| `materials[].parameters[].tooltip` | string, 1–256 chars |  |  | **Tooltip.** Help text. |
| `materials[].graph` | JSON |  |  | **Graph.** The node graph (graph kind "material"): nodes, wires, groups and comments, edited in the Material tab with graph edits. (written by a tool) |
| `materials[].instanceOf` | string, id, 1–64 chars |  |  | **Instance of.** A material instance: the parent material (or instance) whose look it takes. (format id) |
| `materials[].values` | JSON |  |  | **Parameter values.** An instance of a graph material: its values for the parent's parameters (parameter key → value). |
| `materials[].trim` | object |  |  | **Trim sheet.** A trim material's row table: where each row (a strip that tiles along u) lies on the sheet, in pixels from the image's top. Generated architecture asks for rows by slot. (required; applies when `shader` is `trim`) |
| `materials[].trim.size` | vec2 [width, height] | `[2048,2048]` | 1 – 4096, step 1, px | **Size.** The sheet's width and height in pixels (its textures' level 0). (required) |
| `materials[].trim.texelDensity` | number | `512` | 1 – 65536, step 1, px | **Texel density.** Pixels per metre along a strip (each row may set its own). (required) |
| `materials[].trim.padding` | int | `8` | 0 – 256, step 1, px | **Padding.** Pixels above and below every row that repeat its edge (or continue its wrap), so filtering and mips read only the row. (required) |
| `materials[].trim.rows` | list of objects |  |  | **Rows.** The rows, each a slot and its pixel bounds; rows do not overlap. (required) |
| `materials[].trim.rows[].slot` | string, id, 1–64 chars |  |  | **Slot.** The semantic slot it fills (the starter layout: floor, lower_wall, upper_wall, baseboard, crown, frame, column, bevel, emissive); unique on the sheet. (required; format id) |
| `materials[].trim.rows[].top` | int |  | ≥ 0, step 1, px | **Top.** Its first pixel row (inside the sheet). (required) |
| `materials[].trim.rows[].bottom` | int |  | ≥ 1, step 1, px | **Bottom.** The pixel row below its last (exclusive; inside the sheet, below top). (required) |
| `materials[].trim.rows[].texelDensity` | number |  | 1 – 65536, step 1, px | **Texel density.** Its own pixels per metre (absent: the sheet's). |
| `materials[].trim.rows[].tileV` | bool | `false` |  | **Tiles in v.** It tiles in v too: its padding continues its wrap. (stored only when not the default) |
| `materials[].trim.cells` | JSON: `TrimCell[]` ([TrimCell](types-s-v.md#type-trim-cell)) |  |  | **Decal cells.** Marks placed once on the sheet (signs, cracks, stains): [{name, rect: [x, y, width, height]}], each a named rectangle in whole pixels from the image's top-left corner, inside the sheet, that decal materials draw (read from the Texture Designer's layout.json; empty: none). |
| `materials[].trim.realHeight` | bool | `false` |  | **Rows at their real height.** Rows draw at their own metres (fields repeat, trims keep their scale). Off: parts are fitted to whole rows, as older sheets draw. (stored only when not the default) |
| `materials[].decal` | object |  |  | **Decal cell.** A decal material that draws one decal cell of a trim sheet (its textures are the sheet's; empty: its own texture slots). (applies when `shader` is `decal`) |
| `materials[].decal.sheet` | material id |  |  | **Sheet.** The trim material whose sheet holds the cell. (required) |
| `materials[].decal.cell` | string, id, 1–64 chars |  |  | **Cell.** The cell's name in the sheet's decal cells. (required; format id) |
| `materials[].layerNames` | list of string, ≤ 64 chars, ≤ 256 items |  |  | **Layer names.** A layered material's names for its texture-array layers, as the layer palette shows them (index i = layer i; "" or past the end: the layer's texture's name). At most 256. |
| `materials[].layerSheets` | list of string, ≤ 64 chars, ≤ 256 items |  |  | **Trim sheets.** Per layer, the trim material whose rows the layer follows ("": none). At most 256. |
| `materials[].physical` | object |  |  | **Physical.** Its physics: a profile and the numbers it changes (absent numbers: the profile's, else density 1000, friction 0.5, restitution 0). The engine reads friction and restitution where its physics has a slot; games read all of them. |
| `materials[].physical.profile` | string, id, 1–64 chars |  |  | **Profile.** A physical profile: an engine one (earth, glass, lava, metal, stone, water, wood) or one of the project's. (format id) |
| `materials[].physical.density` | number |  | > 0, ≤ 30000, step 10, kg/m³ | **Density.** Mass density. |
| `materials[].physical.friction` | number |  | 0 – 4, step 0.05 | **Friction.** Friction coefficient (0: ice-smooth). |
| `materials[].physical.restitution` | number |  | 0 – 1, step 0.05 | **Restitution.** Bounciness (0: none, 1: perfectly elastic). |
| `materials[].physical.flowRate` | number |  | 0 – 100, step 0.05 | **Flow rate.** How fast a liquid spreads, relative to water (1); solids leave it out. |
| `materials[].gameData` | JSON |  |  | **Game data.** The game's own data for the material (sounds, break tags …): JSON nested at most 32 deep, shipped as it is, never read by the engine. An instance's keys override its parent's. |
| `materials[].voxel` | object |  |  | **Voxel use.** It is also a voxel material: its voxel id, what it is used for, its kit and its texture sets on walls, floors and ceilings. An instance with its own (and its own id) is a voxel variant. |
| `materials[].voxel.id` | int | `1` | 1 – 4095, step 1 | **Voxel id.** Its voxel material id (1-4095), unique in the project; every world shares it. (required) |
| `materials[].voxel.use` | enum: `construction`, `terrain`, `liquid`, `gas` | `"construction"` |  | **Use.** Construction (grid-anchored tiles), terrain (triplanar), liquid or gas (fog, smoke: cells of the gas role). An instance may leave it to its parent. (required) |
| `materials[].voxel.kit` | string, id, 1–64 chars |  |  | **Kit.** The voxel kit whose detail pieces its edges draw (absent: plain voxel edges; never with liquid or gas). (format id) |
| `materials[].voxel.tileMetres` | number |  | 0.5 – 64, step 0.5, m | **Tile.** Metres one texture repeat covers (absent: 4 construction, 2 terrain and liquid). |
| `materials[].voxel.heightDepth` | number |  | 0 – 0.25, step 0.005, m | **Height depth.** Metres between its height map's 1 (the surface) and 0 (absent: 0.02): sand shallow, rock deep. |
| `materials[].voxel.blendMetres` | number |  | 0 – 0.5, step 0.05, m | **Blend.** Metres over which it blends into a neighbouring voxel material (0: a hard cell line; absent: its world's blend, else 0.25); where two meet, the smaller wins. |
| `materials[].voxel.surfaces` | JSON: `Partial<Record<VoxelSurface, VoxelTextureSet>>` ([VoxelSurface](types-v-w.md#type-voxel-surface), [VoxelTextureSet](types-v-w.md#type-voxel-texture-set)) |  |  | **Surfaces.** Texture sets by surface: {wall?, floor?, ceiling?: {albedo?, normal?, orm?: a plain texture asset}} (role and face direction pick one; floor and ceiling fall back to wall, wall to the material's own look). |
| `materials[].voxel.gas` | object |  |  | **Gas look.** A gas's plain look (only with the gas use): its colour and how dense it is at full density. (applies when `use` is `gas`) |
| `materials[].voxel.gas.color` | color | `"#ffffff"` |  | **Colour.** The gas's colour (absent: #ffffff). (stored only when not the default) |
| `materials[].voxel.gas.density` | number |  | 0 – 8, step 0.01 | **Full density.** Density per metre of a cell at full density, shape 15 (absent: 0.5); a cell of density d holds d/15 of it. |
| `materials[].voxel.dressing` | string, id, 1–64 chars |  |  | **Dressing.** The dressing whose species grow on its surfaces (a dressingId; absent: nothing grows; never with liquid or gas). A variant that names another one grows the same ground sparser, denser or with other plants. (format id) |
