# Components: Lighting

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Lighting components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-light"></a>
## light — Light

A light: directional (the sun), ambient, point, spot, hemisphere (sky and ground) or area (a panel or strip with a size, shining toward the object's local −Y: unrotated, a ceiling panel shining down).

- Category: Lighting
- Added: from "+ Add component", starting as `{"type":"point","color":"#ffd9a0","intensity":30,"range":8,"decay":2}`
- On prefab objects: yes
- Cannot share an object with [`instances`](components-rendering-1.md#component-instances): an instance set is scenery
- Icon: sun as Directional light, ambient as Ambient light, spot as Spot light, hemisphere as Hemisphere light, area as Area light, point as Point light, else point
- Rule: At most one directional, one ambient and one hemisphere light and 16 realtime or mixed point/spot lights per scene (baked point/spot lights and area lights are not counted); any scene may hold any light.
- Rule: With scenes loaded together, the most recently loaded scene's directional, ambient and hemisphere light is on (each kind on its own); the others come back when it unloads.
- Rule: Realtime and mixed point and spot lights of all loaded scenes share the budget of 16; past it the most recently loaded scenes' lights are on.
- Rule: An area light lights static surfaces through the surface cache (on WebGPU at medium and high quality its light and soft shadows are traced into the cache); WebGL 2 draws the cache's saved light.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `type` | enum: `directional`, `ambient`, `point`, `spot`, `hemisphere`, `area` | `"point"` |  | **Type.** The kind of light. (required; scripts read) |
| `color` | color | `"#ffffff"` |  | **Colour.** The light colour (a hemisphere light: the sky colour). (required; scripts read and write) |
| `intensity` | number | `1` | 0 – 8, step 0.05 | **Intensity.** Brightness. (required; applies when `type` is `directional` or `ambient` or `hemisphere`; scripts read and write) |
| `intensity` | number | `30` | 0 – 1000, step 1, cd | **Intensity.** Brightness in candela (an area light: the whole light along its facing axis). (required; applies when `type` is `point` or `spot` or `area`; scripts read and write) |
| `direction` | vec3 [x, y, z] | `[0.4,-1,-0.3]` | -1 – 1, step 0.05, not 0 | **Direction.** Where the light shines (need not be unit length; not all 0). (required; applies when `type` is `directional`; Scene handle: direction; scripts read) |
| `direction` | vec3 [x, y, z] | `[0,-1,0]` | -1 – 1, step 0.05, not 0 | **Direction.** Where the spot points (not all 0). (required; applies when `type` is `spot`; Scene handle: cone; scripts read) |
| `castShadow` | bool | `false` |  | **Cast shadows.** The light casts shadows. (applies when `type` is `directional` or `point` or `spot`; scripts read) |
| `castShadow` | bool | `true` |  | **Cast shadows.** The light casts soft shadows (its size softens them). (applies when `type` is `area`; scripts read) |
| `shadowMapSize` | int (one of 512, 1024, 2048, 4096) | `1024` | step 1 | **Shadow map size.** Shadow resolution in texels per side (sharper, more memory). (applies when `type` is `directional`; stored only when not the default; scripts read) |
| `shadowBias` | number | `-0.0005` | -0.01 – 0.01, step 0.0001 | **Shadow bias.** Depth offset of the shadow test (more negative: less acne, shadows may detach). (applies when `type` is `directional`; stored only when not the default; scripts read) |
| `shadowNormalBias` | number | `0.02` | 0 – 1, step 0.005, m | **Shadow normal bias.** Offset along the surface normal (removes stripes on grazing surfaces). (applies when `type` is `directional`; stored only when not the default; scripts read) |
| `shadowExtent` | number | `24` | 1 – 64, step 1, m | **Shadow extent.** Half the side of the shadowed square around the camera (v4 games; a v3 game uses its level bounds). (applies when `type` is `directional`; stored only when not the default; scripts read) |
| `range` | number | `0` | 0 – 1000, step 0.5, m | **Range.** Light reaches this far (0: unlimited). (applies when `type` is `point`; Scene handle: radius; scripts read and write) |
| `range` | number | `0` | 0 – 1000, step 0.5, m | **Range.** Light reaches this far (0: unlimited). (applies when `type` is `spot`; Scene handle: cone; scripts read and write) |
| `range` | number | `0` | 0 – 1000, step 0.5, m | **Range.** Light reaches this far (0: unlimited). (applies when `type` is `area`; scripts read and write) |
| `decay` | number | `2` | 0 – 4, step 0.1 | **Decay.** How fast it fades with distance (2: physically correct). (applies when `type` is `point` or `spot`; scripts read) |
| `angle` | number | `30` | 1 – 89, step 1, deg | **Angle.** Half-angle of the spot cone. (applies when `type` is `spot`; Scene handle: cone; scripts read) |
| `penumbra` | number | `0.2` | 0 – 1, step 0.05 | **Soft edge.** How soft the cone edge is (0: hard). (applies when `type` is `spot`; scripts read) |
| `cookie` | asset id (texture) |  |  | **Cookie.** A texture projected through the cone (the light is tinted and masked by it: a window frame, leaves, a logo). (applies when `type` is `spot`; scripts read) |
| `groundColor` | color | `"#444444"` |  | **Ground colour.** The colour from below. (applies when `type` is `hemisphere`; scripts read) |
| `shape` | enum: `rect`, `line` | `"rect"` |  | **Shape.** A rect (a panel in the object's local XZ plane, centred on it) or a line (a strip along its local X). (applies when `type` is `area`; scripts read) |
| `width` | number | `1` | > 0, ≤ 50, step 0.05, m | **Width.** The rect's side along the object's local X, or the line's length. (applies when `type` is `area`; scripts read) |
| `height` | number | `0.5` | > 0, ≤ 50, step 0.05, m | **Height.** The rect's side along the object's local Z (rect only). (applies when `type` is `area` and `shape` is `rect`; scripts read) |
| `twoSided` | bool | `false` |  | **Two-sided.** Shines from both faces (off: only toward the object's local −Y). (applies when `type` is `area`; scripts read) |
| `mode` | enum: `realtime`, `baked`, `mixed` | `"realtime"` |  | **Mode.** Realtime, baked into lightmaps, or both (mixed). (stored only when not the default; scripts read) |
| `lightMask` | int (light layer mask) | `255` | 0 – 255, step 1 | **Light mask.** The light layers it lights: an object is lit only when it is in one of them. (stored only when not the default; scripts read and write) |
| `shadowCasterMask` | int (light layer mask) | `255` | 0 – 255, step 1 | **Shadow caster mask.** Only objects in one of these light layers cast its shadow. (applies when `type` is `directional` or `point` or `spot` or `area`; stored only when not the default; scripts read and write) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Direction | direction | direction → `direction` | world | `type` is `directional` |
| Cone | cone | direction → `direction`, angle → `angle`, range → `range` | local (follows rotation) | `type` is `spot` |
| Range | radius | radius → `range` | local | `type` is `point` |

Presets:

- Directional light: `{"type":"directional","color":"#ffffff","intensity":1.2,"direction":[0.4,-1,-0.3],"castShadow":true}`
- Ambient light: `{"type":"ambient","color":"#8090a8","intensity":0.6}`
- Point light: `{"type":"point","color":"#ffd9a0","intensity":30,"range":8,"decay":2}`
- Spot light: `{"type":"spot","color":"#ffffff","intensity":80,"range":12,"decay":2,"angle":30,"penumbra":0.3,"direction":[0,-1,0]}`
- Hemisphere light: `{"type":"hemisphere","color":"#bcd7ff","groundColor":"#444444","intensity":0.8}`
- Area light: `{"type":"area","color":"#fff4e0","intensity":40,"shape":"rect","width":1.2,"height":0.6,"range":10,"castShadow":true}`
