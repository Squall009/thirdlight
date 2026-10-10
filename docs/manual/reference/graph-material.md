# Graph: Material graph

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Material graph node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-material"></a>
## Material graph

- Graph kind: `material`
- Stored in: the `material` documents that own it
- Node budget: 512
- Cycles: refused
- Results: `pbr`, `unlit`, `customLit`, `vertexOffset` (a node reaching none gets a warning)

Port types:

| Type | Label |
|---|---|
| `float` | float |
| `vec2` | vec2 |
| `vec3` | vec3 |
| `vec4` | vec4 |
| `texture` | texture |
| `data` | data |

Implicit conversions:

- float → vec2 (every component)
- float → vec3 (every component)
- float → vec4 (every component)
- vec2 → float (x)
- vec2 → vec3 (pad z = 0)
- vec2 → vec4 (pad z = 0, w = 1)
- vec3 → float (x)
- vec3 → vec2 (xy)
- vec3 → vec4 (pad w = 1)
- vec4 → float (x)
- vec4 → vec2 (xy)
- vec4 → vec3 (xyz)

<a id="graph-material--inputs"></a>
## Inputs

- Parameter (`parameter`): An exposed parameter of the material (objects may override public ones); its type is the declaration's.
- Float (`float`): A constant number.
- Vector 2 (`vec2`): A constant two-component vector.
- Vector 3 (`vec3`): A constant three-component vector.
- Vector 4 (`vec4`): A constant four-component vector.
- Colour (`color`): A constant colour (sRGB, converted to linear) and an alpha.
- Time (`time`): Seconds since the game started (scaled by the game clock).
- UV (`uv`): A texture coordinate set of the mesh.
- Vertex colour (`vertexColor`): A vertex colour set of the mesh (COLOR_0, or COLOR_1: a second set, e.g. a painted block layer's wetness); a mesh without it reads white (a neutral tint), zero with alpha 1 (vertex colours used as data, e.g. wind weights) or first — (1, 0, 0, 0), all weight on the first channel (vertex colours used as layer weights: an unpainted mesh shows its first layer).
- Position (`position`): The surface position in object, world or view space.
- Normal (`normal`): The surface normal in object, world or view space.
- View direction (`viewDirection`): The direction from the surface to the camera (normalized).
- Object position (`objectPosition`): The object's origin in world space (in an instance set, the drawn instance's own origin) — the same for every pixel of one piece.
- Camera distance (`cameraDistance`): Metres from the camera to the surface.
- Screen UV (`screenUV`): The position on the screen (0–1 in both axes).
- Instance index (`instanceIndex`): The index of the drawn instance in an instance set (0 for a single object).
- Global wind (`wind`): The project's wind (Environment): direction on the ground plane, the current strength with gusts, and turbulence.
- Scene wetness (`sceneWetness`): How wet the scene is (its Environment wetness, 0 dry – 1 soaked: rain), as environment presets blend it.
- Scene depth (`sceneDepth`): For a transparent surface (water): metres from the camera to the opaque scene behind the pixel, and how far behind the surface that scene lies — 0 where water meets the shore, for soft shorelines and foam. Pixels only.

<a id="node-material--parameter"></a>
### Parameter (`parameter`)

An exposed parameter of the material (objects may override public ones); its type is the declaration's.

Outputs:

- `value` (float): type from field `key`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | Parameter | string | `""` | ≤ 32 chars; matches `[A-Za-z_][A-Za-z0-9_]{0,31}` |

<a id="node-material--float"></a>
### Float (`float`)

A constant number.

Outputs:

- `value` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | number | `0` | -1000000 – 1000000 |

<a id="node-material--vec2"></a>
### Vector 2 (`vec2`)

A constant two-component vector.

Outputs:

- `value` (vec2)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | vector | `[0,0]` | -1000000 – 1000000; 2 components |

<a id="node-material--vec3"></a>
### Vector 3 (`vec3`)

A constant three-component vector.

Outputs:

- `value` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | vector | `[0,0,0]` | -1000000 – 1000000; 3 components |

<a id="node-material--vec4"></a>
### Vector 4 (`vec4`)

A constant four-component vector.

Outputs:

- `value` (vec4)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | vector | `[0,0,0,0]` | -1000000 – 1000000; 4 components |

<a id="node-material--color"></a>
### Colour (`color`)

A constant colour (sRGB, converted to linear) and an alpha.

Outputs:

- `rgb` (vec3)
- `alpha` (float)
- `rgba` (vec4)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `color` | Colour | color | `"#ffffff"` |  |
| `alpha` | Alpha | number | `1` | 0 – 1 |

<a id="node-material--time"></a>
### Time (`time`)

Seconds since the game started (scaled by the game clock).

Outputs:

- `time` (float)

<a id="node-material--uv"></a>
### UV (`uv`)

A texture coordinate set of the mesh.

Outputs:

- `uv` (vec2)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `set` | Set | enum | `"uv0"` | `uv0`, `uv1` |

<a id="node-material--vertex-color"></a>
### Vertex colour (`vertexColor`)

A vertex colour set of the mesh (COLOR_0, or COLOR_1: a second set, e.g. a painted block layer's wetness); a mesh without it reads white (a neutral tint), zero with alpha 1 (vertex colours used as data, e.g. wind weights) or first — (1, 0, 0, 0), all weight on the first channel (vertex colours used as layer weights: an unpainted mesh shows its first layer).

Outputs:

- `rgba` (vec4)
- `rgb` (vec3)
- `alpha` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `absent` | Without the set | enum | `"white"` | `white`, `zero`, `first` |
| `set` | Set | enum | `"COLOR_0"` | `COLOR_0`, `COLOR_1` |

<a id="node-material--position"></a>
### Position (`position`)

The surface position in object, world or view space.

Outputs:

- `position` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `space` | Space | enum | `"world"` | `object`, `world`, `view` |

<a id="node-material--normal"></a>
### Normal (`normal`)

The surface normal in object, world or view space.

Outputs:

- `normal` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `space` | Space | enum | `"world"` | `object`, `world`, `view` |

<a id="node-material--view-direction"></a>
### View direction (`viewDirection`)

The direction from the surface to the camera (normalized).

Outputs:

- `direction` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `space` | Space | enum | `"world"` | `world`, `view` |

<a id="node-material--object-position"></a>
### Object position (`objectPosition`)

The object's origin in world space (in an instance set, the drawn instance's own origin) — the same for every pixel of one piece.

Outputs:

- `position` (vec3)

<a id="node-material--camera-distance"></a>
### Camera distance (`cameraDistance`)

Metres from the camera to the surface.

Outputs:

- `distance` (float)

<a id="node-material--screen-uv"></a>
### Screen UV (`screenUV`)

The position on the screen (0–1 in both axes).

Outputs:

- `uv` (vec2)

<a id="node-material--instance-index"></a>
### Instance index (`instanceIndex`)

The index of the drawn instance in an instance set (0 for a single object).

Outputs:

- `index` (float)

<a id="node-material--wind"></a>
### Global wind (`wind`)

The project's wind (Environment): direction on the ground plane, the current strength with gusts, and turbulence.

Outputs:

- `direction` (vec3)
- `strength` (float)
- `turbulence` (float)

<a id="node-material--scene-wetness"></a>
### Scene wetness (`sceneWetness`)

How wet the scene is (its Environment wetness, 0 dry – 1 soaked: rain), as environment presets blend it.

Outputs:

- `wetness` (float)

<a id="node-material--scene-depth"></a>
### Scene depth (`sceneDepth`)

For a transparent surface (water): metres from the camera to the opaque scene behind the pixel, and how far behind the surface that scene lies — 0 where water meets the shore, for soft shorelines and foam. Pixels only.

Outputs:

- `depth` (float)
- `behind` (float)

<a id="graph-material--lighting"></a>
## Lighting

- Main light (`mainLight`): The main directional light — the brightest one that casts shadows, else the first: the direction from the surface to it (world space), its colour × intensity, and N·L (the shading normal · that direction, −1 to 1; quantize it for bands). Without a directional light: up, black, 0.
- Shadow (`lightShadow`): The main light's shadow on this pixel: 0 fully shadowed, 1 lit (1 when the light casts no shadow or the object receives none).
- Diffuse light (`diffuseLight`): The light every light source puts on the surface: total (direct + ambient + environment + lightmap), its luminance (one number to quantize), and direct — every directional, point and spot light × its N·L × its shadow and falloff.
- Ambient light (`ambientLight`): The indirect light: ambient, hemisphere lights and light probes (at the surface normal), the environment's image-based light (black without one), and a baked lightmap's light (black without one).

<a id="node-material--main-light"></a>
### Main light (`mainLight`)

The main directional light — the brightest one that casts shadows, else the first: the direction from the surface to it (world space), its colour × intensity, and N·L (the shading normal · that direction, −1 to 1; quantize it for bands). Without a directional light: up, black, 0.

Outputs:

- `direction` (vec3)
- `color` "colour" (vec3)
- `ndotl` "N·L" (float)

<a id="node-material--light-shadow"></a>
### Shadow (`lightShadow`)

The main light's shadow on this pixel: 0 fully shadowed, 1 lit (1 when the light casts no shadow or the object receives none).

Outputs:

- `shadow` (float)

<a id="node-material--diffuse-light"></a>
### Diffuse light (`diffuseLight`)

The light every light source puts on the surface: total (direct + ambient + environment + lightmap), its luminance (one number to quantize), and direct — every directional, point and spot light × its N·L × its shadow and falloff.

Outputs:

- `total` (vec3)
- `luminance` (float)
- `direct` (vec3)

<a id="node-material--ambient-light"></a>
### Ambient light (`ambientLight`)

The indirect light: ambient, hemisphere lights and light probes (at the surface normal), the environment's image-based light (black without one), and a baked lightmap's light (black without one).

Outputs:

- `ambient` (vec3)
- `environment` (vec3)
- `lightmap` (vec3)

<a id="graph-material--maths"></a>
## Maths

- Add (`add`): a + b.
- Subtract (`subtract`): a − b.
- Multiply (`multiply`): a × b (per component).
- Divide (`divide`): a ÷ b (per component).
- Minimum (`min`): The smaller of a and b (per component).
- Maximum (`max`): The larger of a and b (per component).
- Power (`power`): a raised to b (per component).
- Dot product (`dot`): a · b.
- Cross product (`cross`): a × b (three components).
- Normalize (`normalize`): The vector scaled to length 1.
- Length (`length`): The length of a vector (the absolute value of a number).
- Lerp (`lerp`): Blends a to b by t (t = 0: a, t = 1: b).
- Clamp (`clamp`): Limits the value to [min, max].
- Saturate (`saturate`): Limits the value to [0, 1].
- Smoothstep (`smoothstep`): A smooth 0→1 ramp of x between edge0 and edge1.
- Step (`step`): 0 where x < edge, else 1.
- Absolute (`abs`): The value without its sign.
- Floor (`floor`): Rounds down to a whole number.
- Fraction (`fract`): The part after the decimal point (x − floor x).
- Sine (`sin`): sin(x), x in radians.
- Cosine (`cos`): cos(x), x in radians.
- One minus (`oneMinus`): 1 − x.
- Weighted mix (`weightedMix`): a × w.x + b × w.y + c × w.z + d × w.w: four layers' values (colours, normals, roughness…) mixed by weights that sum to 1 (a Height blend's, vertex colours, a mask).
- Remap (`remap`): Maps the value from [inMin, inMax] to [outMin, outMax].

<a id="node-material--add"></a>
### Add (`add`)

a + b.

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--subtract"></a>
### Subtract (`subtract`)

a − b.

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--multiply"></a>
### Multiply (`multiply`)

a × b (per component).

Inputs:

- `a` (float): unconnected: `1`, type from field `type`
- `b` (float): unconnected: `1`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--divide"></a>
### Divide (`divide`)

a ÷ b (per component).

Inputs:

- `a` (float): unconnected: `1`, type from field `type`
- `b` (float): unconnected: `1`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--min"></a>
### Minimum (`min`)

The smaller of a and b (per component).

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--max"></a>
### Maximum (`max`)

The larger of a and b (per component).

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--power"></a>
### Power (`power`)

a raised to b (per component).

Inputs:

- `a` (float): unconnected: `1`, type from field `type`
- `b` (float): unconnected: `1`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--dot"></a>
### Dot product (`dot`)

a · b.

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--cross"></a>
### Cross product (`cross`)

a × b (three components).

Inputs:

- `a` (vec3): unconnected: `[1,0,0]`
- `b` (vec3): unconnected: `[0,1,0]`

Outputs:

- `out` (vec3)

<a id="node-material--normalize"></a>
### Normalize (`normalize`)

The vector scaled to length 1.

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--length"></a>
### Length (`length`)

The length of a vector (the absolute value of a number).

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--lerp"></a>
### Lerp (`lerp`)

Blends a to b by t (t = 0: a, t = 1: b).

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `1`, type from field `type`
- `t` (float): unconnected: `0.5`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--clamp"></a>
### Clamp (`clamp`)

Limits the value to [min, max].

Inputs:

- `in` (float): unconnected: `0`, type from field `type`
- `min` (float): unconnected: `0`, type from field `type`
- `max` (float): unconnected: `1`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--saturate"></a>
### Saturate (`saturate`)

Limits the value to [0, 1].

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--smoothstep"></a>
### Smoothstep (`smoothstep`)

A smooth 0→1 ramp of x between edge0 and edge1.

Inputs:

- `edge0` (float): unconnected: `0`, type from field `type`
- `edge1` (float): unconnected: `1`, type from field `type`
- `x` (float): unconnected: `0.5`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--step"></a>
### Step (`step`)

0 where x < edge, else 1.

Inputs:

- `edge` (float): unconnected: `0.5`, type from field `type`
- `x` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--abs"></a>
### Absolute (`abs`)

The value without its sign.

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--floor"></a>
### Floor (`floor`)

Rounds down to a whole number.

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--fract"></a>
### Fraction (`fract`)

The part after the decimal point (x − floor x).

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--sin"></a>
### Sine (`sin`)

sin(x), x in radians.

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--cos"></a>
### Cosine (`cos`)

cos(x), x in radians.

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--one-minus"></a>
### One minus (`oneMinus`)

1 − x.

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--weighted-mix"></a>
### Weighted mix (`weightedMix`)

a × w.x + b × w.y + c × w.z + d × w.w: four layers' values (colours, normals, roughness…) mixed by weights that sum to 1 (a Height blend's, vertex colours, a mask).

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`
- `c` (float): unconnected: `0`, type from field `type`
- `d` (float): unconnected: `0`, type from field `type`
- `weights` (vec4): unconnected: `[1,0,0,0]`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--remap"></a>
### Remap (`remap`)

Maps the value from [inMin, inMax] to [outMin, outMax].

Inputs:

- `in` (float): unconnected: `0`, type from field `type`
- `inMin` "in min" (float): unconnected: `0`, type from field `type`
- `inMax` "in max" (float): unconnected: `1`, type from field `type`
- `outMin` "out min" (float): unconnected: `0`, type from field `type`
- `outMax` "out max" (float): unconnected: `1`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="graph-material--vectors"></a>
## Vectors

- Split (`split`): The components of a vector (a narrower vector pads with 0 and w = 1).
- Combine (`combine`): A vector from components.
- Swizzle (`swizzle`): Picks and reorders components by a mask (x y z w or r g b a, 1–4 letters); the result has the mask's width.

<a id="node-material--split"></a>
### Split (`split`)

The components of a vector (a narrower vector pads with 0 and w = 1).

Inputs:

- `in` (vec4): unconnected: `[0,0,0,0]`

Outputs:

- `x` (float)
- `y` (float)
- `z` (float)
- `w` (float)

<a id="node-material--combine"></a>
### Combine (`combine`)

A vector from components.

Inputs:

- `x` (float): unconnected: `0`
- `y` (float): unconnected: `0`
- `z` (float): unconnected: `0`
- `w` (float): unconnected: `1`

Outputs:

- `xyzw` (vec4)
- `xyz` (vec3)
- `xy` (vec2)

<a id="node-material--swizzle"></a>
### Swizzle (`swizzle`)

Picks and reorders components by a mask (x y z w or r g b a, 1–4 letters); the result has the mask's width.

Inputs:

- `in` (vec4): unconnected: `[0,0,0,0]`

Outputs:

- `out` (vec3): type from field `mask`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `mask` | Mask | string | `"xyz"` | ≤ 4 chars; matches `[xyzw]{1,4}\|[rgba]{1,4}` |

<a id="graph-material--textures"></a>
## Textures

- Sample texture (`sampleTexture`): Reads a texture (its field, or a texture wire such as a parameter) at a UV; of a texture array, the given layer.
- Normal map (`normalMap`): Reads a tangent-space normal map (of a texture array, the given layer) and scales its strength (feeds a surface normal).
- Triplanar (`triplanar`): Projects a texture (of a texture array, the given layer) along the three axes and blends by the normal (no UVs needed).
- Projected sample (`projectedSample`): Reads a texture (of a texture array, the given layer) the way a ground layer wants it, scale metres per repeat. Mode 0: at the UV (on terrain and block tops, world XZ). Mode 1: on the world plane the surface faces most — the top, or the side wall plane on steep ground — one read, no stretching on cliffs (a seam where a slope turns past 45°). Mode 2: biplanar — the top and the side plane blended by the slope (sharpness), two reads, only within near metres of the camera (past it, mode 1). Decode normal: reads a tangent-space normal map and turns a side-projected one into the surface's frame, scaled by strength. The mode may differ per pixel (a per-layer setting on terrain).
- Height blend (`heightBlend`): Blend weights for up to four layers shaped by their height maps: where layers meet, the higher one shows through (stones poke out of sand, moss fills the cracks) instead of a soft cross-fade. Weights come from any input (vertex colours, painted layers, a mask, noise); heights are the layers' height maps (0–1, one per component); depth is how far below the highest layer another still shows (0: a hard edge by height). Contrast and offset reshape each layer's height first (height − 0.5) × contrast + 0.5 + offset, one component per layer: a contrast above 1 makes a layer's peaks and cracks stand further apart, an offset lifts the whole layer over the others. A layer of weight 0 never shows. Feed the weights to Weighted mix nodes.
- Flipbook (`flipbook`): The UV of one frame of a grid of frames (connect Time × frames per second to play it).
- Noise (`noise`): Procedural noise: value, gradient (Perlin-like) or Voronoi (distance to the nearest cell, and a random value per cell).
- Gradient (`gradient`): A 0–1 ramp over the UV: linear (along u), radial (from the centre) or angular (around the centre).
- Colour ramp (`colorRamp`): Maps t (0–1) to a colour between two colours.
- Sample data (`sampleData`): Reads one cell of a data parameter (a small grid of RGBA values scripts write per object): at a UV (cell [0, 0] at UV (0, 0), no filtering) or at integer cell coordinates. Channels are 0–1 (byte / 255); outside the grid reads the nearest edge cell.

<a id="node-material--sample-texture"></a>
### Sample texture (`sampleTexture`)

Reads a texture (its field, or a texture wire such as a parameter) at a UV; of a texture array, the given layer.

Inputs:

- `tex` "texture" (texture)
- `uv` (vec2): unconnected: `"uv0"`
- `layer` (float): unconnected: `0`

Outputs:

- `rgba` (vec4)
- `rgb` (vec3)
- `r` (float)
- `g` (float)
- `b` (float)
- `a` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `texture` | Texture | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a texture asset |
| `wrap` | Wrap | enum | `"repeat"` | `repeat`, `clamp`, `mirror` |
| `filter` | Filter | enum | `"linear"` | `linear`, `nearest` |
| `colorSpace` | Colour space | enum | `"srgb"` | `srgb`, `linear` |

<a id="node-material--normal-map"></a>
### Normal map (`normalMap`)

Reads a tangent-space normal map (of a texture array, the given layer) and scales its strength (feeds a surface normal).

Inputs:

- `tex` "texture" (texture)
- `uv` (vec2): unconnected: `"uv0"`
- `strength` (float): unconnected: `1`
- `layer` (float): unconnected: `0`

Outputs:

- `normal` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `texture` | Texture | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a texture asset |
| `wrap` | Wrap | enum | `"repeat"` | `repeat`, `clamp`, `mirror` |
| `filter` | Filter | enum | `"linear"` | `linear`, `nearest` |

<a id="node-material--triplanar"></a>
### Triplanar (`triplanar`)

Projects a texture (of a texture array, the given layer) along the three axes and blends by the normal (no UVs needed).

Inputs:

- `tex` "texture" (texture)
- `position` (vec3): unconnected: `"positionWorld"`
- `normal` (vec3): unconnected: `"normalWorld"`
- `scale` (float): unconnected: `1`
- `sharpness` (float): unconnected: `4`
- `layer` (float): unconnected: `0`

Outputs:

- `rgba` (vec4)
- `rgb` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `texture` | Texture | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a texture asset |
| `wrap` | Wrap | enum | `"repeat"` | `repeat`, `clamp`, `mirror` |
| `filter` | Filter | enum | `"linear"` | `linear`, `nearest` |
| `colorSpace` | Colour space | enum | `"srgb"` | `srgb`, `linear` |

<a id="node-material--projected-sample"></a>
### Projected sample (`projectedSample`)

Reads a texture (of a texture array, the given layer) the way a ground layer wants it, scale metres per repeat. Mode 0: at the UV (on terrain and block tops, world XZ). Mode 1: on the world plane the surface faces most — the top, or the side wall plane on steep ground — one read, no stretching on cliffs (a seam where a slope turns past 45°). Mode 2: biplanar — the top and the side plane blended by the slope (sharpness), two reads, only within near metres of the camera (past it, mode 1). Decode normal: reads a tangent-space normal map and turns a side-projected one into the surface's frame, scaled by strength. The mode may differ per pixel (a per-layer setting on terrain).

Inputs:

- `tex` "texture" (texture)
- `uv` (vec2): unconnected: `"uv0"`
- `scale` (float): unconnected: `1`
- `mode` (float): unconnected: `0`
- `sharpness` (float): unconnected: `4`
- `near` (float): unconnected: `60`
- `strength` (float): unconnected: `1`
- `position` (vec3): unconnected: `"positionWorld"`
- `normal` (vec3): unconnected: `"normalWorld"`
- `layer` (float): unconnected: `0`

Outputs:

- `rgba` (vec4)
- `rgb` (vec3)
- `r` (float)
- `g` (float)
- `b` (float)
- `a` (float)
- `normal` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `texture` | Texture | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a texture asset |
| `wrap` | Wrap | enum | `"repeat"` | `repeat`, `clamp`, `mirror` |
| `filter` | Filter | enum | `"linear"` | `linear`, `nearest` |
| `colorSpace` | Colour space | enum | `"srgb"` | `srgb`, `linear` |
| `decode` | Decode | enum | `"color"` | `color`, `normal` |

<a id="node-material--height-blend"></a>
### Height blend (`heightBlend`)

Blend weights for up to four layers shaped by their height maps: where layers meet, the higher one shows through (stones poke out of sand, moss fills the cracks) instead of a soft cross-fade. Weights come from any input (vertex colours, painted layers, a mask, noise); heights are the layers' height maps (0–1, one per component); depth is how far below the highest layer another still shows (0: a hard edge by height). Contrast and offset reshape each layer's height first (height − 0.5) × contrast + 0.5 + offset, one component per layer: a contrast above 1 makes a layer's peaks and cracks stand further apart, an offset lifts the whole layer over the others. A layer of weight 0 never shows. Feed the weights to Weighted mix nodes.

Inputs:

- `weights` (vec4): unconnected: `[1,0,0,0]`
- `heights` (vec4): unconnected: `[0,0,0,0]`
- `depth` (float): unconnected: `0.2`
- `contrast` (vec4): unconnected: `[1,1,1,1]`
- `offset` (vec4): unconnected: `[0,0,0,0]`

Outputs:

- `weights` (vec4)

<a id="node-material--flipbook"></a>
### Flipbook (`flipbook`)

The UV of one frame of a grid of frames (connect Time × frames per second to play it).

Inputs:

- `uv` (vec2): unconnected: `"uv0"`
- `frame` (float): unconnected: `0`

Outputs:

- `uv` (vec2)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `columns` | Columns | number | `4` | 1 – 64 |
| `rows` | Rows | number | `4` | 1 – 64 |

<a id="node-material--noise"></a>
### Noise (`noise`)

Procedural noise: value, gradient (Perlin-like) or Voronoi (distance to the nearest cell, and a random value per cell).

Inputs:

- `uv` (vec2): unconnected: `"uv0"`
- `scale` (float): unconnected: `10`

Outputs:

- `value` (float)
- `cell` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `noise` | Noise | enum | `"gradient"` | `value`, `gradient`, `voronoi` |

<a id="node-material--gradient"></a>
### Gradient (`gradient`)

A 0–1 ramp over the UV: linear (along u), radial (from the centre) or angular (around the centre).

Inputs:

- `uv` (vec2): unconnected: `"uv0"`

Outputs:

- `value` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `shape` | Shape | enum | `"linear"` | `linear`, `radial`, `angular` |

<a id="node-material--color-ramp"></a>
### Colour ramp (`colorRamp`)

Maps t (0–1) to a colour between two colours.

Inputs:

- `t` (float): unconnected: `0.5`

Outputs:

- `rgb` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `from` | From | color | `"#000000"` |  |
| `to` | To | color | `"#ffffff"` |  |
| `interpolation` | Interpolation | enum | `"linear"` | `linear`, `smooth`, `constant` |

<a id="node-material--sample-data"></a>
### Sample data (`sampleData`)

Reads one cell of a data parameter (a small grid of RGBA values scripts write per object): at a UV (cell [0, 0] at UV (0, 0), no filtering) or at integer cell coordinates. Channels are 0–1 (byte / 255); outside the grid reads the nearest edge cell.

Inputs:

- `data` (data)
- `uv` (vec2): unconnected: `"uv0"`
- `cell` (vec2): unconnected: `[0,0]`

Outputs:

- `rgba` (vec4)
- `rgb` (vec3)
- `r` (float)
- `g` (float)
- `b` (float)
- `a` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `address` | Address by | enum | `"uv"` | `uv`, `cell` |

<a id="graph-material--utility"></a>
## Utility

- Fresnel (`fresnel`): (1 − n·v)^power: bright where the surface turns away from the camera.
- Rim (`rim`): A soft band at the silhouette: width is how far it reaches in, softness how smooth its inner edge is.
- Posterize (`posterize`): Quantizes the value to a number of steps.
- Dither (`dither`): 1 where the value beats an ordered (Bayer) threshold at the screen position, else 0 — fades without transparency.
- World-aligned UV (`worldUV`): A UV from the world position on a plane, so a texture flows across separate pieces.
- Parallax (`parallax`): Simple parallax offset: shifts the UV along the view direction by height × scale.
- Vertex displacement (`displace`): An offset along a direction (the object normal by default) by height × scale — feed a Vertex offset output.
- Alpha clip (`alphaClip`): Discards the pixel where alpha is below the threshold; passes alpha on.

<a id="node-material--fresnel"></a>
### Fresnel (`fresnel`)

(1 − n·v)^power: bright where the surface turns away from the camera.

Inputs:

- `normal` (vec3): unconnected: `"normalWorld"`
- `view` "view dir" (vec3): unconnected: `"viewDirWorld"`
- `power` (float): unconnected: `5`

Outputs:

- `out` (float)

<a id="node-material--rim"></a>
### Rim (`rim`)

A soft band at the silhouette: width is how far it reaches in, softness how smooth its inner edge is.

Inputs:

- `normal` (vec3): unconnected: `"normalWorld"`
- `view` "view dir" (vec3): unconnected: `"viewDirWorld"`
- `width` (float): unconnected: `0.3`
- `softness` (float): unconnected: `0.1`

Outputs:

- `out` (float)

<a id="node-material--posterize"></a>
### Posterize (`posterize`)

Quantizes the value to a number of steps.

Inputs:

- `in` (float): unconnected: `0`, type from field `type`
- `steps` (float): unconnected: `4`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec2`, `vec3`, `vec4` |

<a id="node-material--dither"></a>
### Dither (`dither`)

1 where the value beats an ordered (Bayer) threshold at the screen position, else 0 — fades without transparency.

Inputs:

- `in` (float): unconnected: `0.5`
- `screen` "screen uv" (vec2): unconnected: `"screenUV"`

Outputs:

- `out` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `pattern` | Pattern | enum | `"bayer4"` | `bayer4`, `bayer8` |

<a id="node-material--world-uv"></a>
### World-aligned UV (`worldUV`)

A UV from the world position on a plane, so a texture flows across separate pieces.

Inputs:

- `position` (vec3): unconnected: `"positionWorld"`
- `scale` (float): unconnected: `1`

Outputs:

- `uv` (vec2)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `plane` | Plane | enum | `"xz"` | `xz`, `xy`, `zy` |

<a id="node-material--parallax"></a>
### Parallax (`parallax`)

Simple parallax offset: shifts the UV along the view direction by height × scale.

Inputs:

- `uv` (vec2): unconnected: `"uv0"`
- `height` (float): unconnected: `0`
- `scale` (float): unconnected: `0.05`
- `view` "view dir (tangent)" (vec3): unconnected: `"viewDirTangent"`

Outputs:

- `uv` (vec2)

<a id="node-material--displace"></a>
### Vertex displacement (`displace`)

An offset along a direction (the object normal by default) by height × scale — feed a Vertex offset output.

Inputs:

- `height` (float): unconnected: `0`
- `scale` (float): unconnected: `1`
- `direction` (vec3): unconnected: `"normalObject"`

Outputs:

- `offset` (vec3)

<a id="node-material--alpha-clip"></a>
### Alpha clip (`alphaClip`)

Discards the pixel where alpha is below the threshold; passes alpha on.

Inputs:

- `alpha` (float): unconnected: `1`
- `threshold` (float): unconnected: `0.5`

Outputs:

- `alpha` (float)

<a id="graph-material--functions"></a>
## Functions

- Function call (`call`): Runs a material function; its ports are the function's inputs and outputs (unconnected inputs use the function's defaults).

<a id="node-material--call"></a>
### Function call (`call`)

Runs a material function; its ports are the function's inputs and outputs (unconnected inputs use the function's defaults).

(its ports are the interface of the `material-function` graph named by `function`)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `function` | Function | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |

<a id="graph-material--output"></a>
## Output

- PBR output (`pbr`): A lit, physically based surface. Normal is tangent space; alpha clip > 0 discards pixels below it. Specular intensity and colour scale a non-metal's reflectance (F0 0.04 × colour × intensity; glTF KHR_materials_specular): connected, the surface draws with the physical shading model, which costs a little more; left alone, they change nothing.
- Unlit output (`unlit`): A surface that ignores lights (its colour is what you see).
- Custom-lit output (`customLit`): A surface whose colour the graph computes from the Lighting inputs (toon bands, painterly, hatching); fog, tone mapping and the post stack still apply. Normal is tangent space and shapes N·L and the diffuse light (it cannot read them); emissive is added; alpha clip > 0 discards pixels below it.
- Vertex offset (`vertexOffset`): Moves the mesh's vertices (the vertex stage), in object or world space.

<a id="node-material--pbr"></a>
### PBR output (`pbr`)

A lit, physically based surface. Normal is tangent space; alpha clip > 0 discards pixels below it. Specular intensity and colour scale a non-metal's reflectance (F0 0.04 × colour × intensity; glTF KHR_materials_specular): connected, the surface draws with the physical shading model, which costs a little more; left alone, they change nothing.

(every graph needs one; one node of the `surface` group)

Inputs:

- `baseColor` "base colour" (vec3): unconnected: `[1,1,1]`
- `metalness` (float): unconnected: `0`
- `roughness` (float): unconnected: `0.8`
- `normal` (vec3): unconnected: `[0,0,1]`
- `emissive` (vec3): unconnected: `[0,0,0]`
- `ao` "ambient occlusion" (float): unconnected: `1`
- `opacity` (float): unconnected: `1`
- `alphaClip` "alpha clip" (float): unconnected: `0`
- `specularIntensity` "specular intensity" (float): unconnected: `1`
- `specularColor` "specular colour" (vec3): unconnected: `[1,1,1]`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `doubleSided` | Double-sided | boolean | `false` |  |
| `transparent` | Transparent | boolean | `false` |  |
| `castShadows` | Casts shadows | boolean | `true` |  |
| `localLights` | Local lights | enum | `"object"` | `object`, `pixel`, `vertex`, `none` |

<a id="node-material--unlit"></a>
### Unlit output (`unlit`)

A surface that ignores lights (its colour is what you see).

(one node of the `surface` group)

Inputs:

- `color` "colour" (vec3): unconnected: `[1,1,1]`
- `opacity` (float): unconnected: `1`
- `alphaClip` "alpha clip" (float): unconnected: `0`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `doubleSided` | Double-sided | boolean | `false` |  |
| `transparent` | Transparent | boolean | `false` |  |
| `castShadows` | Casts shadows | boolean | `true` |  |

<a id="node-material--custom-lit"></a>
### Custom-lit output (`customLit`)

A surface whose colour the graph computes from the Lighting inputs (toon bands, painterly, hatching); fog, tone mapping and the post stack still apply. Normal is tangent space and shapes N·L and the diffuse light (it cannot read them); emissive is added; alpha clip > 0 discards pixels below it.

(one node of the `surface` group)

Inputs:

- `color` "colour" (vec3): unconnected: `[1,1,1]`
- `emissive` (vec3): unconnected: `[0,0,0]`
- `normal` (vec3): unconnected: `[0,0,1]`
- `opacity` (float): unconnected: `1`
- `alphaClip` "alpha clip" (float): unconnected: `0`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `doubleSided` | Double-sided | boolean | `false` |  |
| `transparent` | Transparent | boolean | `false` |  |
| `castShadows` | Casts shadows | boolean | `true` |  |
| `localLights` | Local lights | enum | `"object"` | `object`, `pixel`, `vertex`, `none` |

<a id="node-material--vertex-offset"></a>
### Vertex offset (`vertexOffset`)

Moves the mesh's vertices (the vertex stage), in object or world space.

(at most 1 per graph)

Inputs:

- `offset` (vec3): unconnected: `[0,0,0]`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `space` | Space | enum | `"object"` | `object`, `world` |
