# Scene environment

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Each scene document's `environment`: its look. Set with `setEnvironment {sceneId, environment}`.

<a id="scene-environment-sky"></a>
## sky — Sky

The background and the light it gives (image-based lighting).

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `sky` | object |  |  | **Sky.** The background and the light it gives (image-based lighting). (rules: A texture sky needs an image or six cube faces.) |
| `sky.mode` | enum: `procedural`, `gradient`, `texture`, `color` | `"procedural"` |  | **Sky.** Physically based, a three-colour gradient, an image, or one colour. (required) |
| `sky.turbidity` | number | `6` | 1 – 20, step 0.1 | **Haze.** Atmospheric haze. (applies when `mode` is `procedural`) |
| `sky.rayleigh` | number | `1.5` | 0 – 4, step 0.05 | **Rayleigh.** Blue-sky scattering. (applies when `mode` is `procedural`) |
| `sky.mieCoefficient` | number | `0.005` | 0 – 0.1, step 0.001 | **Mie.** Haze around the sun. (applies when `mode` is `procedural`) |
| `sky.mieDirectionalG` | number | `0.8` | 0 – 1, step 0.01 | **Mie direction.** How tight the sun glow is. (applies when `mode` is `procedural`) |
| `sky.sunFromLight` | bool | `true` |  | **Sun from light.** Place the sun opposite the scene's directional light. (applies when `mode` is `procedural`) |
| `sky.sunElevation` | number | `35` | -10 – 90, step 1, deg | **Sun elevation.** Sun height above the horizon. (applies when `mode` is `procedural` and `sunFromLight` is `false`) |
| `sky.sunAzimuth` | number | `160` | -180 – 180, step 1, deg | **Sun azimuth.** Sun direction around the horizon. (applies when `mode` is `procedural` and `sunFromLight` is `false`) |
| `sky.topColor` | color | `"#3d7cd6"` |  | **Top colour.** The sky overhead. (applies when `mode` is `gradient`) |
| `sky.horizonColor` | color | `"#bfe3ff"` |  | **Horizon colour.** The sky at the horizon. (applies when `mode` is `gradient`) |
| `sky.bottomColor` | color | `"#757575"` |  | **Bottom colour.** Below the horizon. (applies when `mode` is `gradient`) |
| `sky.color` | color | `"#7ec8ff"` |  | **Colour.** The one sky colour. (applies when `mode` is `color`) |
| `sky.texture` | asset id (texture) |  |  | **Image.** An equirectangular sky image. (applies when `mode` is `texture`) |
| `sky.cube` | list of asset id (texture), 6 items |  |  | **Cube faces.** Six images +x, −x, +y, −y, +z, −z (instead of one image). (applies when `mode` is `texture`) |
| `sky.rotation` | number | `0` | -360 – 360, step 1, deg | **Rotation.** Turns the sky image about the vertical axis (background and sky lighting alike). (applies when `mode` is `texture`) |
| `sky.intensity` | number | `1` | 0 – 8, step 0.05 | **Brightness.** Background brightness. |
| `sky.environmentIntensity` | number | `1` | 0 – 8, step 0.05 | **Sky lighting.** How much the sky lights the scene (0: none). |

<a id="scene-environment-fog"></a>
## fog — Fog

Distance fog.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `fog` | object |  |  | **Fog.** Distance fog. |
| `fog.mode` | enum: `none`, `linear`, `exp2` | `"none"` |  | **Fog.** None, linear (near to far) or exponential (density). (required; choices: `none` = None, `linear` = Linear, `exp2` = Exponential) |
| `fog.color` | color | `"#c8d2dc"` |  | **Colour.** The fog colour. (required) |
| `fog.near` | number | `10` | 0 – 10000, step 1, m | **Start.** Fog starts here. (applies when `mode` is `linear`) |
| `fog.far` | number | `120` | 0 – 10000, step 1, m | **Full.** Fog is full here. (applies when `mode` is `linear`) |
| `fog.density` | number | `0.01` | 0 – 1, step 0.001 | **Density.** Exponential fog density. (applies when `mode` is `exp2`) |

<a id="scene-environment-height-fog"></a>
## heightFog — Height fog

Exponential height fog: thickens with distance and lies low, thinning with height; it fogs the sky towards the horizon too, so the far edge of a level fades into it. Presets blend it.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `heightFog` | object |  |  | **Height fog.** Exponential height fog: thickens with distance and lies low, thinning with height; it fogs the sky towards the horizon too, so the far edge of a level fades into it. Presets blend it. |
| `heightFog.density` | number | `0.02` | 0 – 1, step 0.0005 | **Density.** Fog per metre at the base height. (required) |
| `heightFog.color` | color | `"#c8d2dc"` |  | **Colour.** The fog colour. (required) |
| `heightFog.height` | number | `0` | -10000 – 10000, step 1, m | **Base height.** World height where the fog has its density. |
| `heightFog.falloff` | number | `0.05` | 0 – 10, step 0.005 | **Falloff.** How fast it thins with height (per metre: halves every 0.69 / falloff m). |
| `heightFog.start` | number | `0` | 0 – 10000, step 1, m | **Start distance.** No fog nearer than this to the camera. |
| `heightFog.inscatterColor` | color |  |  | **Sun glow.** Added towards the sun (absent: no glow). |
| `heightFog.inscatterExponent` | number | `8` | 1 – 64, step 1 | **Sun glow size.** Higher: a tighter glow round the sun. |

<a id="scene-environment-post"></a>
## post — Post-processing

Tone mapping, exposure and screen effects.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `post` | object |  |  | **Post-processing.** Tone mapping, exposure and screen effects. |
| `post.toneMapping` | enum: `none`, `aces`, `agx`, `neutral` | `"agx"` |  | **Tone mapping.** How bright colours are mapped to the screen. |
| `post.exposure` | number | `1` | 0 – 8, step 0.05 | **Exposure.** Overall brightness. |
| `post.antialias` | enum: `none`, `fxaa`, `smaa` | `"none"` |  | **Anti-aliasing.** Smooths jagged edges. |
| `post.bloom` | object |  |  | **Bloom.** Bright parts glow. |
| `post.bloom.enabled` | bool | `true` |  | **On.** Turns bloom on. (required) |
| `post.bloom.strength` | number | `0.6` | 0 – 3, step 0.05 | **Strength.** Glow strength. |
| `post.bloom.radius` | number | `0.4` | 0 – 1, step 0.05 | **Radius.** Glow spread. |
| `post.bloom.threshold` | number | `0.85` | 0 – 2, step 0.05 | **Threshold.** Only brighter than this glows. |
| `post.grading` | object |  |  | **Colour grading.** Contrast, saturation, tint, lift/gamma/gain and a LUT. |
| `post.grading.contrast` | number | `0` | -1 – 1, step 0.05 | **Contrast.** −1 to 1 (0: unchanged). |
| `post.grading.saturation` | number | `0` | -1 – 1, step 0.05 | **Saturation.** −1 to 1 (0: unchanged). |
| `post.grading.brightness` | number | `0` | -1 – 1, step 0.05 | **Brightness.** −1 to 1 (0: unchanged). |
| `post.grading.tint` | color | `"#ffffff"` |  | **Tint.** Multiplied over the image (white: none). |
| `post.grading.lut` | asset id (texture) |  |  | **LUT.** A colour lookup texture. |
| `post.grading.lift` | number | `0` | -0.5 – 0.5, step 0.01 | **Lift.** Raises the blacks (0: unchanged). |
| `post.grading.gamma` | number | `1` | 0.2 – 5, step 0.05 | **Gamma.** Mid-tones (above 1 brightens; 1: unchanged). |
| `post.grading.gain` | number | `1` | 0 – 4, step 0.05 | **Gain.** Scales the whites (1: unchanged). |
| `post.vignette` | object |  |  | **Vignette.** Darkened corners. |
| `post.vignette.enabled` | bool | `true` |  | **On.** Turns vignette on. (required) |
| `post.vignette.darkness` | number | `0.5` | 0 – 1, step 0.05 | **Darkness.** How dark the corners get. |
| `post.vignette.offset` | number | `1` | 0 – 2, step 0.05 | **Size.** How far in it reaches. |
| `post.ssao` | object |  |  | **Ambient occlusion.** Contact shadows in creases. |
| `post.ssao.enabled` | bool | `true` |  | **On.** Turns ambient occlusion on. (required) |
| `post.ssao.radius` | number | `0.5` | 0.01 – 4, step 0.01, m | **Radius.** How far it looks. |
| `post.ssao.intensity` | number | `1` | 0 – 4, step 0.05 | **Intensity.** How dark. |
| `post.dof` | object |  |  | **Depth of field.** Blur away from the focus distance. |
| `post.dof.enabled` | bool | `true` |  | **On.** Turns depth of field on. (required) |
| `post.dof.focus` | number | `10` | 0.1 – 1000, step 0.1, m | **Focus.** Sharp at this distance. |
| `post.dof.aperture` | number | `0.002` | 0 – 0.1, step 0.0005 | **Aperture.** Blur amount. |
| `post.dof.maxBlur` | number | `0.01` | 0 – 0.05, step 0.001 | **Max blur.** Blur limit. |

<a id="scene-environment-wind"></a>
## wind — Wind

The global wind foliage and cloth sway in.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `wind` | object |  |  | **Wind.** The global wind foliage and cloth sway in. |
| `wind.direction` | vec2 [x, z] | `[1,0]` | -1 – 1, step 0.05, not 0 | **Direction.** Horizontal direction [x, z] (not both 0). (required) |
| `wind.strength` | number | `0.5` | 0 – 10, step 0.05 | **Strength.** Base strength (0: still air). (required) |
| `wind.gust` | number | `0.4` | 0 – 10, step 0.05 | **Gusts.** Extra strength of gusts. (required) |
| `wind.gustFrequency` | number | `0.3` | 0 – 10, step 0.05 | **Gust frequency.** Gusts per second. (required) |
| `wind.turbulence` | number | `0.3` | 0 – 1, step 0.05 | **Turbulence.** Small-scale variation over space. (required) |

<a id="scene-environment-wetness"></a>
## wetness — Wetness

How wet the scene is (rain): materials with a Scene wetness node (the height-blended layers template) darken and shine as if wet, water pooling in low parts first. Presets blend it.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `wetness` | number | `0` | 0 – 1, step 0.05 | **Wetness.** How wet the scene is (rain): materials with a Scene wetness node (the height-blended layers template) darken and shine as if wet, water pooling in low parts first. Presets blend it. |
