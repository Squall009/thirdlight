# Content documents (materials to effects)

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
| `materials[].shader` | enum: `standard`, `foliage`, `kit`, `unlit`, `water`, `trim`, `decal` | `"standard"` |  | **Shader.** Standard, foliage (wind), kit (world-space detail), unlit, water, trim (a trim sheet: its row table in trim) or decal (a mark decals and decal meshes draw with: its own textures or a trim sheet's decal cell in decal). (required) |
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
| `materials[].params.localLights` | enum: `object`, `pixel`, `vertex`, `none` | `"object"` |  | **Local Lights.** The standard shader's local lights (absent: the file's value or the shader default). (applies when `../shader` is `standard`) |
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
| `materials[].params.localLights` | enum: `object`, `pixel`, `vertex`, `none` | `"object"` |  | **Local Lights.** The foliage shader's local lights (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.windBend` | number | `1` | 0 – 4, step 0.1 | **Wind Bend.** The foliage shader's wind bend (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.windFlutter` | number | `1` | 0 – 4, step 0.1 | **Wind Flutter.** The foliage shader's wind flutter (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.flutterFrequency` | number | `6` | 0 – 30, step 0.1 | **Flutter Frequency.** The foliage shader's flutter frequency (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.subsurface` | number | `0.3` | 0 – 1, step 0.01 | **Subsurface.** The foliage shader's subsurface (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
| `materials[].params.windDistance` | number | `0` | 0 – 10000, step 0.1 | **Wind Distance.** The foliage shader's wind distance (absent: the file's value or the shader default). (applies when `../shader` is `foliage`) |
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
| `materials[].params.localLights` | enum: `object`, `pixel`, `vertex`, `none` | `"object"` |  | **Local Lights.** The kit shader's local lights (absent: the file's value or the shader default). (applies when `../shader` is `kit`) |
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
| `materials[].params.grimeColor` | color | `"#3b3328"` |  | **Grime Color.** The trim shader's grime color (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.grime` | number | `1` | 0 – 2, step 0.1 | **Grime.** The trim shader's grime (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.wetness` | number | `0` | 0 – 1, step 0.01 | **Wetness.** The trim shader's wetness (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.wetFlatten` | number | `0.7` | 0 – 1, step 0.01 | **Wet Flatten.** The trim shader's wet flatten (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.alphaMode` | enum: `opaque`, `cutout` | `"opaque"` |  | **Alpha Mode.** The trim shader's alpha mode (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.alphaCutoff` | number | `0.5` | 0 – 1, step 0.01 | **Alpha Cutoff.** The trim shader's alpha cutoff (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.doubleSided` | bool | `false` |  | **Double Sided.** The trim shader's double sided (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
| `materials[].params.localLights` | enum: `object`, `pixel`, `vertex`, `none` | `"object"` |  | **Local Lights.** The trim shader's local lights (absent: the file's value or the shader default). (applies when `../shader` is `trim`) |
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
| `materials[].trim.size` | vec2 [width, height] | `[1024,1024]` | 1 – 4096, step 1, px | **Size.** The sheet's width and height in pixels (its textures' level 0). (required) |
| `materials[].trim.texelDensity` | number | `256` | 1 – 65536, step 1, px | **Texel density.** Pixels per metre along a strip (each row may set its own). (required) |
| `materials[].trim.padding` | int | `8` | 0 – 256, step 1, px | **Padding.** Pixels above and below every row that repeat its edge (or continue its wrap), so filtering and mips read only the row. (required) |
| `materials[].trim.rows` | list of objects |  |  | **Rows.** The rows, each a slot and its pixel bounds; rows do not overlap. (required) |
| `materials[].trim.rows[].slot` | string, id, 1–64 chars |  |  | **Slot.** The semantic slot it fills (the starter layout: floor, lower_wall, upper_wall, baseboard, crown, frame, column, bevel, emissive); unique on the sheet. (required; format id) |
| `materials[].trim.rows[].top` | int |  | ≥ 0, step 1, px | **Top.** Its first pixel row (inside the sheet). (required) |
| `materials[].trim.rows[].bottom` | int |  | ≥ 1, step 1, px | **Bottom.** The pixel row below its last (exclusive; inside the sheet, below top). (required) |
| `materials[].trim.rows[].texelDensity` | number |  | 1 – 65536, step 1, px | **Texel density.** Its own pixels per metre (absent: the sheet's). |
| `materials[].trim.rows[].tileV` | bool | `false` |  | **Tiles in v.** It tiles in v too: its padding continues its wrap. (stored only when not the default) |
| `materials[].trim.cells` | JSON: `TrimCell[]` ([TrimCell](types-p-u.md#type-trim-cell)) |  |  | **Decal cells.** Marks placed once on the sheet (signs, cracks, stains): [{name, rect: [x, y, width, height]}], each a named rectangle in whole pixels from the image's top-left corner, inside the sheet, that decal materials draw (read from the Texture Designer's layout.json; empty: none). |
| `materials[].decal` | object |  |  | **Decal cell.** A decal material that draws one decal cell of a trim sheet (its textures are the sheet's; empty: its own texture slots). (applies when `shader` is `decal`) |
| `materials[].decal.sheet` | material id |  |  | **Sheet.** The trim material whose sheet holds the cell. (required) |
| `materials[].decal.cell` | string, id, 1–64 chars |  |  | **Cell.** The cell's name in the sheet's decal cells. (required; format id) |

<a id="content-animators"></a>
## animators — Animator controllers

State machines for model animation.

- In every project: no
- Written by: [`setAnimator`](ops-detail.md#op-setAnimator), [`deleteAnimator`](ops-detail.md#op-deleteAnimator)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `animators` | list of objects | `[]` |  | **Animator controllers.** The project's controllers (each its own file). |
| `animators[]` | object |  |  | **Animator controller.** A state machine for model animation. (rules: Parameter names and state ids are unique; references name parameters and states of this controller.) |
| `animators[].controllerId` | string, id, 1–64 chars |  |  | **Id.** The stable controller id. (required; format id) |
| `animators[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in pickers. (required; format name) |
| `animators[].parameters` | list of objects, ≤ 32 items | `[]` |  | **Parameters.** Up to 32 parameters (speed and grounded are set for the player automatically). (required) |
| `animators[].parameters[].name` | string, identifier, 1–64 chars |  |  | **Name.** A letter or _, then letters, digits or _. (required; format identifier) |
| `animators[].parameters[].type` | enum: `float`, `int`, `bool`, `trigger` | `"float"` |  | **Type.** Float, int, bool or trigger. (required) |
| `animators[].parameters[].default` | number | `0` | -1000000 – 1000000, step 0.1 | **Default.** The starting value. (applies when `type` is `float`) |
| `animators[].parameters[].default` | int | `0` | -1000000 – 1000000, step 1 | **Default.** The starting value. (applies when `type` is `int`) |
| `animators[].parameters[].default` | bool | `false` |  | **Default.** The starting value. (applies when `type` is `bool`) |
| `animators[].states` | list of objects, 1–64 items |  |  | **States.** 1–64 states. (required) |
| `animators[].states[].id` | string, id, 1–64 chars |  |  | **Id.** The stable state id (unique across layers). (required; format id) |
| `animators[].states[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the graph. (required; format name) |
| `animators[].states[].motion` | object |  |  | **Motion.** A clip or a blend tree. (required) |
| `animators[].states[].motion.kind` | enum: `clip`, `blend1d` | `"clip"` |  | **Motion.** What plays. (required; choices: `clip` = Clip, `blend1d` = Blend tree (1D)) |
| `animators[].states[].motion.clip` | object |  |  | **Clip.** A named clip of a model asset. (required; applies when `kind` is `clip`) |
| `animators[].states[].motion.clip.assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].states[].motion.clip.clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].states[].motion.clip.duration` | number |  | 0.001 – 600, s | **Length.** The clip length (read from the file). (required; written by a tool) |
| `animators[].states[].motion.parameter` | animatorParameter id (float, int) |  |  | **Parameter.** The float or int parameter the tree blends by. (required; applies when `kind` is `blend1d`) |
| `animators[].states[].motion.children` | list of objects, 2–16 items |  |  | **Clips.** 2–16 clips by threshold (increasing). (required; applies when `kind` is `blend1d`) |
| `animators[].states[].motion.children[].threshold` | number |  | -1000000 – 1000000, step 0.1 | **Threshold.** The parameter value where this clip plays fully. (required) |
| `animators[].states[].motion.children[].clip` | object |  |  | **Clip.** A named clip of a model asset. (required) |
| `animators[].states[].motion.children[].clip.assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].states[].motion.children[].clip.clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].states[].motion.children[].clip.duration` | number |  | 0.001 – 600, s | **Length.** The clip length (read from the file). (required; written by a tool) |
| `animators[].states[].motion.children[].speed` | number |  | 0 – 1000, step 0.1, m/s | **Ground speed.** The ground speed the clip was authored for. Set on every clip, the tree reads its parameter as a ground speed and scales time so the blended speed matches it (feet stay planted between the thresholds). |
| `animators[].states[].motion.children[].position` | vec2 [x, y] |  | -1000000 – 1000000, step 1 | **Graph position.** Where the blend tree graph draws the clip (editor only). |
| `animators[].states[].speed` | number | `1` | 0 – 10, step 0.05, × | **Speed.** Playback speed (× the speed parameter when set). (required) |
| `animators[].states[].speedParameter` | animatorParameter id (float) |  |  | **Speed parameter.** A float parameter the speed is multiplied by. |
| `animators[].states[].loop` | bool | `true` |  | **Loop.** Loops (else holds the last frame). (required) |
| `animators[].states[].position` | vec2 [x, y] |  | -1000000 – 1000000, step 1 | **Graph position.** Where the editor draws the state. |
| `animators[].transitions` | list of objects, ≤ 256 items | `[]` |  | **Transitions.** Up to 256 transitions. (required) |
| `animators[].transitions[]` | object |  |  | **Transition.** From a state (or any state) to a state, on conditions or at an exit time. (rules: A transition needs a condition or an exit time.) |
| `animators[].transitions[].from` | animatorState id or `*` |  |  | **From.** A state of this layer, or * (any state). (required) |
| `animators[].transitions[].to` | animatorState id |  |  | **To.** A state of this layer. (required) |
| `animators[].transitions[].conditions` | list of objects, ≤ 8 items | `[]` |  | **Conditions.** Up to 8; all must hold. (required) |
| `animators[].transitions[].conditions[].parameter` | animatorParameter id |  |  | **Parameter.** The parameter tested. (required) |
| `animators[].transitions[].conditions[].op` | enum: `greater`, `less`, `equals`, `notEquals`, `true`, `false`, `trigger` | `"greater"` |  | **Test.** Numbers: greater/less/equals/not equals; bools: true/false; triggers: trigger. (required; choices: `greater` = Greater, `less` = Less, `equals` = Equals, `notEquals` = Not equals, `true` = True, `false` = False, `trigger` = Trigger) |
| `animators[].transitions[].conditions[].value` | number | `0` | -1000000 – 1000000, step 0.1 | **Value.** Compared with. (required; applies when `op` is `greater` or `less` or `equals` or `notEquals`) |
| `animators[].transitions[].duration` | number | `0.2` | 0 – 10, step 0.05, s | **Crossfade.** Blend time. (required) |
| `animators[].transitions[].exitTime` | number |  | 0 – 100, step 0.05 | **Exit time.** Only after this normalized time of the source state (absent: any time). |
| `animators[].transitions[].interruption` | enum: `none`, `source` | `"none"` |  | **Interruption.** None, or a newer transition from the current state may cut in. |
| `animators[].entry` | animatorState id |  |  | **Entry state.** The state the base layer starts in. (required) |
| `animators[].events` | list of objects, ≤ 64 items | `[]` |  | **Events.** Up to 64 named events at clip times (scripts hear them). (required) |
| `animators[].events[].assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].events[].clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].events[].time` | number | `0` | 0 – 600, step 0.01, s | **Time.** Seconds into the clip. (required) |
| `animators[].events[].name` | string, identifier, 1–64 chars |  |  | **Name.** A letter or _, then letters, digits or _. (required; format identifier) |
| `animators[].morphs` | list of objects, ≤ 32 items |  |  | **Morph targets.** Up to 32 morph targets (blend shapes) whose weight follows a float parameter (clamped to 0–1); scripts may set others. |
| `animators[].morphs[].target` | string, name, 1–128 chars |  |  | **Target.** The morph target's name in the model. (required; format name) |
| `animators[].morphs[].parameter` | animatorParameter id (float) |  |  | **Parameter.** The float parameter whose value (0–1) is the weight. (required) |
| `animators[].layers` | list of objects, 1–3 items |  |  | **Layers.** 1–3 override layers over the base layer (absent: the base layer only). |
| `animators[].layers[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the editor. (required; format name) |
| `animators[].layers[].mask` | list of string, boneName, 1–128 chars, ≤ 128 items, distinct | `[]` |  | **Bones.** The bones this layer drives (up to 128; empty: every bone). (required) |
| `animators[].layers[].weight` | number | `1` | 0 – 1, step 0.05 | **Weight.** How much the layer replaces the ones under it. (required) |
| `animators[].layers[].weightParameter` | animatorParameter id (float) |  |  | **Weight parameter.** A float parameter (0–1) the weight is multiplied by. |
| `animators[].layers[].states` | list of objects, 1–64 items |  |  | **States.** 1–64 states. (required) |
| `animators[].layers[].states[].id` | string, id, 1–64 chars |  |  | **Id.** The stable state id (unique across layers). (required; format id) |
| `animators[].layers[].states[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the graph. (required; format name) |
| `animators[].layers[].states[].motion` | object |  |  | **Motion.** A clip, a blend tree, or nothing (the layers under it show through). (required) |
| `animators[].layers[].states[].motion.kind` | enum: `clip`, `blend1d`, `empty` | `"clip"` |  | **Motion.** What plays. (required; choices: `clip` = Clip, `blend1d` = Blend tree (1D), `empty` = Empty) |
| `animators[].layers[].states[].motion.clip` | object |  |  | **Clip.** A named clip of a model asset. (required; applies when `kind` is `clip`) |
| `animators[].layers[].states[].motion.clip.assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].layers[].states[].motion.clip.clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].layers[].states[].motion.clip.duration` | number |  | 0.001 – 600, s | **Length.** The clip length (read from the file). (required; written by a tool) |
| `animators[].layers[].states[].motion.parameter` | animatorParameter id (float, int) |  |  | **Parameter.** The float or int parameter the tree blends by. (required; applies when `kind` is `blend1d`) |
| `animators[].layers[].states[].motion.children` | list of objects, 2–16 items |  |  | **Clips.** 2–16 clips by threshold (increasing). (required; applies when `kind` is `blend1d`) |
| `animators[].layers[].states[].motion.children[].threshold` | number |  | -1000000 – 1000000, step 0.1 | **Threshold.** The parameter value where this clip plays fully. (required) |
| `animators[].layers[].states[].motion.children[].clip` | object |  |  | **Clip.** A named clip of a model asset. (required) |
| `animators[].layers[].states[].motion.children[].clip.assetId` | asset id (model) |  |  | **Model.** The model the clip is in. (required) |
| `animators[].layers[].states[].motion.children[].clip.clip` | clip id |  |  | **Clip.** The clip name. (required) |
| `animators[].layers[].states[].motion.children[].clip.duration` | number |  | 0.001 – 600, s | **Length.** The clip length (read from the file). (required; written by a tool) |
| `animators[].layers[].states[].motion.children[].speed` | number |  | 0 – 1000, step 0.1, m/s | **Ground speed.** The ground speed the clip was authored for. Set on every clip, the tree reads its parameter as a ground speed and scales time so the blended speed matches it (feet stay planted between the thresholds). |
| `animators[].layers[].states[].motion.children[].position` | vec2 [x, y] |  | -1000000 – 1000000, step 1 | **Graph position.** Where the blend tree graph draws the clip (editor only). |
| `animators[].layers[].states[].speed` | number | `1` | 0 – 10, step 0.05, × | **Speed.** Playback speed (× the speed parameter when set). (required) |
| `animators[].layers[].states[].speedParameter` | animatorParameter id (float) |  |  | **Speed parameter.** A float parameter the speed is multiplied by. |
| `animators[].layers[].states[].loop` | bool | `true` |  | **Loop.** Loops (else holds the last frame). (required) |
| `animators[].layers[].states[].position` | vec2 [x, y] |  | -1000000 – 1000000, step 1 | **Graph position.** Where the editor draws the state. |
| `animators[].layers[].transitions` | list of objects, ≤ 256 items | `[]` |  | **Transitions.** Up to 256 transitions. (required) |
| `animators[].layers[].transitions[]` | object |  |  | **Transition.** From a state (or any state) to a state, on conditions or at an exit time. (rules: A transition needs a condition or an exit time.) |
| `animators[].layers[].transitions[].from` | animatorState id or `*` |  |  | **From.** A state of this layer, or * (any state). (required) |
| `animators[].layers[].transitions[].to` | animatorState id |  |  | **To.** A state of this layer. (required) |
| `animators[].layers[].transitions[].conditions` | list of objects, ≤ 8 items | `[]` |  | **Conditions.** Up to 8; all must hold. (required) |
| `animators[].layers[].transitions[].conditions[].parameter` | animatorParameter id |  |  | **Parameter.** The parameter tested. (required) |
| `animators[].layers[].transitions[].conditions[].op` | enum: `greater`, `less`, `equals`, `notEquals`, `true`, `false`, `trigger` | `"greater"` |  | **Test.** Numbers: greater/less/equals/not equals; bools: true/false; triggers: trigger. (required; choices: `greater` = Greater, `less` = Less, `equals` = Equals, `notEquals` = Not equals, `true` = True, `false` = False, `trigger` = Trigger) |
| `animators[].layers[].transitions[].conditions[].value` | number | `0` | -1000000 – 1000000, step 0.1 | **Value.** Compared with. (required; applies when `op` is `greater` or `less` or `equals` or `notEquals`) |
| `animators[].layers[].transitions[].duration` | number | `0.2` | 0 – 10, step 0.05, s | **Crossfade.** Blend time. (required) |
| `animators[].layers[].transitions[].exitTime` | number |  | 0 – 100, step 0.05 | **Exit time.** Only after this normalized time of the source state (absent: any time). |
| `animators[].layers[].transitions[].interruption` | enum: `none`, `source` | `"none"` |  | **Interruption.** None, or a newer transition from the current state may cut in. |
| `animators[].layers[].entry` | animatorState id |  |  | **Entry state.** The state the layer starts in. (required) |

<a id="content-effects"></a>
## effects — Effects

Visual effects: particle systems authored as node graphs.

- In every project: no
- Written by: [`setEffect`](ops-detail.md#op-setEffect), [`deleteEffect`](ops-detail.md#op-deleteEffect), [`renameEffect`](ops-detail.md#op-renameEffect), [`graphEdit`](ops-detail.md#op-graphEdit)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `effects` | list of objects | `[]` |  | **Effects.** The project's effects (each its own file). |
| `effects[].effectId` | string, id, 1–64 chars |  |  | **Id.** The stable effect id. (required; written by a tool; format id) |
| `effects[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in pickers and the Effects list. (required; format name) |
| `effects[].duration` | number | `2` | 0.01 – 3600, step 0.1, s | **Duration.** One cycle of the effect (bursts and the effect time refer to it). (required) |
| `effects[].loop` | bool | `true` |  | **Loop.** Restart the cycle at its end (off: spawning stops and the effect ends when its particles are gone). (required) |
| `effects[].seed` | int | `1` | 0 – 4294967295, step 1 | **Seed.** The random seed: the same seed gives the same particles. (required) |
| `effects[].bounds` | object |  |  | **Bounds.** The culling box around the origin: the effect is skipped when this box is off screen. (required) |
| `effects[].bounds.center` | vec3 [x, y, z] | `[0,1,0]` | -10000 – 10000, step 0.1, m | **Centre.** The box centre relative to the origin. (required) |
| `effects[].bounds.size` | vec3 [x, y, z] | `[4,4,4]` | > 0, ≤ 10000, step 0.1, m | **Size.** The box size. (required) |
| `effects[].parameters` | list of objects, ≤ 32 items |  |  | **Exposed parameters.** Up to 32 parameters the systems read (Parameter nodes); objects may override the public ones. |
| `effects[].parameters[].key` | string, identifier, 1–32 chars |  |  | **Key.** The name Parameter nodes and overrides use. (required; format identifier) |
| `effects[].parameters[].type` | enum: `float`, `vec3`, `color` | `"float"` |  | **Type.** The value type. (required) |
| `effects[].parameters[].default` | JSON (typed by effectParameter) |  |  | **Default.** The effect's own value (a number, 3 numbers or "#rrggbb"). (required) |
| `effects[].parameters[].min` | number |  |  | **Min.** The lowest value, within ±1e6 (numbers and vectors). (applies when `type` is `float` or `vec3`) |
| `effects[].parameters[].max` | number |  |  | **Max.** The highest value, within ±1e6 and at least min (numbers and vectors). (applies when `type` is `float` or `vec3`) |
| `effects[].parameters[].visibility` | enum: `public`, `private` | `"public"` |  | **Visibility.** Public: objects may override it. Private: the effect's value only. (stored only when not the default) |
| `effects[].parameters[].label` | string, 1–64 chars |  |  | **Label.** Shown instead of the key. |
| `effects[].parameters[].group` | string, 1–64 chars |  |  | **Group.** A foldable group in the Inspector. |
| `effects[].parameters[].tooltip` | string, 1–256 chars |  |  | **Tooltip.** Help text. |
| `effects[].systems` | list of objects, ≤ 16 items | `[]` |  | **Systems.** Up to 16 particle systems, in evaluation order. (required) |
| `effects[].systems[].systemId` | string, id, 1–64 chars |  |  | **Id.** The stable system id (unique in the effect). (required; written by a tool; format id) |
| `effects[].systems[].name` | string, name, 1–128 chars |  |  | **Name.** Shown in the Effect tab. (required; format name) |
| `effects[].systems[].maxParticles` | int | `1000` | 1 – 1048576, step 1 | **Max particles.** The most living particles (executors may cap lower; the CPU fallback does). (required) |
| `effects[].systems[].space` | enum: `local`, `world` | `"local"` |  | **Simulation space.** Local: particles move with the object. World: they stay where they were born. (required) |
| `effects[].systems[].graph` | JSON |  |  | **Graph.** The system graph (graph kind "effect": Spawn, Initialize, Update and Output chains), edited in the Effect tab with graph edits. (required; written by a tool) |
