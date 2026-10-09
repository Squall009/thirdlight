# Graph: Material function

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Material function node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-material-function"></a>
## Material function

- Graph kind: `material-function`
- Stored in: standalone graphs (`content.graphs`)
- Node budget: 512
- Cycles: refused
- Results: `functionOutput` (a node reaching none gets a warning)
- Callable from other graphs: `functionInput` nodes are its inputs, `functionOutput` nodes its outputs

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

<a id="graph-material-function--interface"></a>
## Interface

- Function input (`functionInput`): An input of the function (a port of every call); its default is used when a call leaves the port unconnected.
- Function output (`functionOutput`): An output of the function (a port of every call).

<a id="node-material-function--function-input"></a>
### Function input (`functionInput`)

An input of the function (a port of every call); its default is used when a call leaves the port unconnected.

Outputs:

- `value` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 32 chars; matches `[A-Za-z_][A-Za-z0-9_]{0,31}` |
| `type` | Type | enum | `"float"` | `float`, `vec2`, `vec3`, `vec4`, `texture` |
| `default` | Default | vector | `[0,0,0,0]` | -1000000 – 1000000; 4 components |

<a id="node-material-function--function-output"></a>
### Function output (`functionOutput`)

An output of the function (a port of every call).

Inputs:

- `value` (float): unconnected: `0`, type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `name` | Name | string | `""` | ≤ 32 chars; matches `[A-Za-z_][A-Za-z0-9_]{0,31}` |
| `type` | Type | enum | `"float"` | `float`, `vec2`, `vec3`, `vec4` |

<a id="graph-material-function--inputs"></a>
## Inputs

- [Float](graph-material.md#node-material--float) (`float`, as in `material`): A constant number.
- [Vector 2](graph-material.md#node-material--vec2) (`vec2`, as in `material`): A constant two-component vector.
- [Vector 3](graph-material.md#node-material--vec3) (`vec3`, as in `material`): A constant three-component vector.
- [Vector 4](graph-material.md#node-material--vec4) (`vec4`, as in `material`): A constant four-component vector.
- [Colour](graph-material.md#node-material--color) (`color`, as in `material`): A constant colour (sRGB, converted to linear) and an alpha.
- [Time](graph-material.md#node-material--time) (`time`, as in `material`): Seconds since the game started (scaled by the game clock).
- [UV](graph-material.md#node-material--uv) (`uv`, as in `material`): A texture coordinate set of the mesh.
- [Vertex colour](graph-material.md#node-material--vertex-color) (`vertexColor`, as in `material`): A vertex colour set of the mesh (COLOR_0, or COLOR_1: a second set, e.g. a painted block layer's wetness); a mesh without it reads white (a neutral tint), zero with alpha 1 (vertex colours used as data, e.g. wind weights) or first — (1, 0, 0, 0), all weight on the first channel (vertex colours used as layer weights: an unpainted mesh shows its first layer).
- [Position](graph-material.md#node-material--position) (`position`, as in `material`): The surface position in object, world or view space.
- [Normal](graph-material.md#node-material--normal) (`normal`, as in `material`): The surface normal in object, world or view space.
- [View direction](graph-material.md#node-material--view-direction) (`viewDirection`, as in `material`): The direction from the surface to the camera (normalized).
- [Object position](graph-material.md#node-material--object-position) (`objectPosition`, as in `material`): The object's origin in world space (in an instance set, the drawn instance's own origin) — the same for every pixel of one piece.
- [Camera distance](graph-material.md#node-material--camera-distance) (`cameraDistance`, as in `material`): Metres from the camera to the surface.
- [Screen UV](graph-material.md#node-material--screen-uv) (`screenUV`, as in `material`): The position on the screen (0–1 in both axes).
- [Instance index](graph-material.md#node-material--instance-index) (`instanceIndex`, as in `material`): The index of the drawn instance in an instance set (0 for a single object).
- [Global wind](graph-material.md#node-material--wind) (`wind`, as in `material`): The project's wind (Environment): direction on the ground plane, the current strength with gusts, and turbulence.
- [Scene wetness](graph-material.md#node-material--scene-wetness) (`sceneWetness`, as in `material`): How wet the scene is (its Environment wetness, 0 dry – 1 soaked: rain), as environment presets blend it.
- [Scene depth](graph-material.md#node-material--scene-depth) (`sceneDepth`, as in `material`): For a transparent surface (water): metres from the camera to the opaque scene behind the pixel, and how far behind the surface that scene lies — 0 where water meets the shore, for soft shorelines and foam. Pixels only.

<a id="graph-material-function--lighting"></a>
## Lighting

- [Main light](graph-material.md#node-material--main-light) (`mainLight`, as in `material`): The main directional light — the brightest one that casts shadows, else the first: the direction from the surface to it (world space), its colour × intensity, and N·L (the shading normal · that direction, −1 to 1; quantize it for bands). Without a directional light: up, black, 0.
- [Shadow](graph-material.md#node-material--light-shadow) (`lightShadow`, as in `material`): The main light's shadow on this pixel: 0 fully shadowed, 1 lit (1 when the light casts no shadow or the object receives none).
- [Diffuse light](graph-material.md#node-material--diffuse-light) (`diffuseLight`, as in `material`): The light every light source puts on the surface: total (direct + ambient + environment + lightmap), its luminance (one number to quantize), and direct — every directional, point and spot light × its N·L × its shadow and falloff.
- [Ambient light](graph-material.md#node-material--ambient-light) (`ambientLight`, as in `material`): The indirect light: ambient, hemisphere lights and light probes (at the surface normal), the environment's image-based light (black without one), and a baked lightmap's light (black without one).

<a id="graph-material-function--maths"></a>
## Maths

- [Add](graph-material.md#node-material--add) (`add`, as in `material`): a + b.
- [Subtract](graph-material.md#node-material--subtract) (`subtract`, as in `material`): a − b.
- [Multiply](graph-material.md#node-material--multiply) (`multiply`, as in `material`): a × b (per component).
- [Divide](graph-material.md#node-material--divide) (`divide`, as in `material`): a ÷ b (per component).
- [Minimum](graph-material.md#node-material--min) (`min`, as in `material`): The smaller of a and b (per component).
- [Maximum](graph-material.md#node-material--max) (`max`, as in `material`): The larger of a and b (per component).
- [Power](graph-material.md#node-material--power) (`power`, as in `material`): a raised to b (per component).
- [Dot product](graph-material.md#node-material--dot) (`dot`, as in `material`): a · b.
- [Cross product](graph-material.md#node-material--cross) (`cross`, as in `material`): a × b (three components).
- [Normalize](graph-material.md#node-material--normalize) (`normalize`, as in `material`): The vector scaled to length 1.
- [Length](graph-material.md#node-material--length) (`length`, as in `material`): The length of a vector (the absolute value of a number).
- [Lerp](graph-material.md#node-material--lerp) (`lerp`, as in `material`): Blends a to b by t (t = 0: a, t = 1: b).
- [Clamp](graph-material.md#node-material--clamp) (`clamp`, as in `material`): Limits the value to [min, max].
- [Saturate](graph-material.md#node-material--saturate) (`saturate`, as in `material`): Limits the value to [0, 1].
- [Smoothstep](graph-material.md#node-material--smoothstep) (`smoothstep`, as in `material`): A smooth 0→1 ramp of x between edge0 and edge1.
- [Step](graph-material.md#node-material--step) (`step`, as in `material`): 0 where x < edge, else 1.
- [Absolute](graph-material.md#node-material--abs) (`abs`, as in `material`): The value without its sign.
- [Floor](graph-material.md#node-material--floor) (`floor`, as in `material`): Rounds down to a whole number.
- [Fraction](graph-material.md#node-material--fract) (`fract`, as in `material`): The part after the decimal point (x − floor x).
- [Sine](graph-material.md#node-material--sin) (`sin`, as in `material`): sin(x), x in radians.
- [Cosine](graph-material.md#node-material--cos) (`cos`, as in `material`): cos(x), x in radians.
- [One minus](graph-material.md#node-material--one-minus) (`oneMinus`, as in `material`): 1 − x.
- [Weighted mix](graph-material.md#node-material--weighted-mix) (`weightedMix`, as in `material`): a × w.x + b × w.y + c × w.z + d × w.w: four layers' values (colours, normals, roughness…) mixed by weights that sum to 1 (a Height blend's, vertex colours, a mask).
- [Remap](graph-material.md#node-material--remap) (`remap`, as in `material`): Maps the value from [inMin, inMax] to [outMin, outMax].

<a id="graph-material-function--vectors"></a>
## Vectors

- [Split](graph-material.md#node-material--split) (`split`, as in `material`): The components of a vector (a narrower vector pads with 0 and w = 1).
- [Combine](graph-material.md#node-material--combine) (`combine`, as in `material`): A vector from components.
- [Swizzle](graph-material.md#node-material--swizzle) (`swizzle`, as in `material`): Picks and reorders components by a mask (x y z w or r g b a, 1–4 letters); the result has the mask's width.

<a id="graph-material-function--textures"></a>
## Textures

- [Sample texture](graph-material.md#node-material--sample-texture) (`sampleTexture`, as in `material`): Reads a texture (its field, or a texture wire such as a parameter) at a UV; of a texture array, the given layer.
- [Normal map](graph-material.md#node-material--normal-map) (`normalMap`, as in `material`): Reads a tangent-space normal map (of a texture array, the given layer) and scales its strength (feeds a surface normal).
- [Triplanar](graph-material.md#node-material--triplanar) (`triplanar`, as in `material`): Projects a texture (of a texture array, the given layer) along the three axes and blends by the normal (no UVs needed).
- [Projected sample](graph-material.md#node-material--projected-sample) (`projectedSample`, as in `material`): Reads a texture (of a texture array, the given layer) the way a ground layer wants it, scale metres per repeat. Mode 0: at the UV (on terrain and block tops, world XZ). Mode 1: on the world plane the surface faces most — the top, or the side wall plane on steep ground — one read, no stretching on cliffs (a seam where a slope turns past 45°). Mode 2: biplanar — the top and the side plane blended by the slope (sharpness), two reads, only within near metres of the camera (past it, mode 1). Decode normal: reads a tangent-space normal map and turns a side-projected one into the surface's frame, scaled by strength. The mode may differ per pixel (a per-layer setting on terrain).
- [Height blend](graph-material.md#node-material--height-blend) (`heightBlend`, as in `material`): Blend weights for up to four layers shaped by their height maps: where layers meet, the higher one shows through (stones poke out of sand, moss fills the cracks) instead of a soft cross-fade. Weights come from any input (vertex colours, painted layers, a mask, noise); heights are the layers' height maps (0–1, one per component); depth is how far below the highest layer another still shows (0: a hard edge by height). Contrast and offset reshape each layer's height first (height − 0.5) × contrast + 0.5 + offset, one component per layer: a contrast above 1 makes a layer's peaks and cracks stand further apart, an offset lifts the whole layer over the others. A layer of weight 0 never shows. Feed the weights to Weighted mix nodes.
- [Flipbook](graph-material.md#node-material--flipbook) (`flipbook`, as in `material`): The UV of one frame of a grid of frames (connect Time × frames per second to play it).
- [Noise](graph-material.md#node-material--noise) (`noise`, as in `material`): Procedural noise: value, gradient (Perlin-like) or Voronoi (distance to the nearest cell, and a random value per cell).
- [Gradient](graph-material.md#node-material--gradient) (`gradient`, as in `material`): A 0–1 ramp over the UV: linear (along u), radial (from the centre) or angular (around the centre).
- [Colour ramp](graph-material.md#node-material--color-ramp) (`colorRamp`, as in `material`): Maps t (0–1) to a colour between two colours.

<a id="graph-material-function--utility"></a>
## Utility

- [Fresnel](graph-material.md#node-material--fresnel) (`fresnel`, as in `material`): (1 − n·v)^power: bright where the surface turns away from the camera.
- [Rim](graph-material.md#node-material--rim) (`rim`, as in `material`): A soft band at the silhouette: width is how far it reaches in, softness how smooth its inner edge is.
- [Posterize](graph-material.md#node-material--posterize) (`posterize`, as in `material`): Quantizes the value to a number of steps.
- [Dither](graph-material.md#node-material--dither) (`dither`, as in `material`): 1 where the value beats an ordered (Bayer) threshold at the screen position, else 0 — fades without transparency.
- [World-aligned UV](graph-material.md#node-material--world-uv) (`worldUV`, as in `material`): A UV from the world position on a plane, so a texture flows across separate pieces.
- [Parallax](graph-material.md#node-material--parallax) (`parallax`, as in `material`): Simple parallax offset: shifts the UV along the view direction by height × scale.
- [Vertex displacement](graph-material.md#node-material--displace) (`displace`, as in `material`): An offset along a direction (the object normal by default) by height × scale — feed a Vertex offset output.
- [Alpha clip](graph-material.md#node-material--alpha-clip) (`alphaClip`, as in `material`): Discards the pixel where alpha is below the threshold; passes alpha on.

<a id="graph-material-function--functions"></a>
## Functions

- [Function call](graph-material.md#node-material--call) (`call`, as in `material`): Runs a material function; its ports are the function's inputs and outputs (unconnected inputs use the function's defaults).
