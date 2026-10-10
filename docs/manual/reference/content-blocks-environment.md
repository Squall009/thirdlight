# Content documents (environment to input)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content blocks and their fields. Paths with `[]` are list items and `{}` map values.

<a id="content-environment"></a>
## environment — Environment

The quality levels, the default level and the environment presets (each scene has its own look).

- In every project: no
- Written by: [`setEnvironment`](ops-detail.md#op-setEnvironment)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `quality` | string, ≥ 1 chars |  |  | **Quality.** The quality level a game starts at, one of the levels' ids (players change it in Settings; absent: the highest). |
| `qualityLevels` | list of objects, ≥ 1 items |  |  | **Quality levels.** The project's quality levels, lowest first (absent: the engine's low, medium and high: low draws no bloom, AO, depth of field, anti-aliasing or MSAA; medium no AO or depth of field). |
| `qualityLevels[]` | object |  |  | **Quality level.** Graphics settings players pick from. (rules: Level ids are unique.) |
| `qualityLevels[].id` | string, 1–32 chars |  |  | **Id.** Named by environment.quality, a player's setting and game-control setQuality. (required) |
| `qualityLevels[].name` | string, 1–64 chars |  |  | **Name.** Shown to players (absent: the id). |
| `qualityLevels[].post` | object |  |  | **Post-processing.** Per effect, what this level changes where the look has it on; Off turns it off (never on). |
| `qualityLevels[].post.antialias` | enum: `none`, `fxaa`, `smaa` | `"none"` |  | **Anti-aliasing.** Smooths jagged edges. |
| `qualityLevels[].post.bloom` | object |  |  | **Bloom.** Bright parts glow. |
| `qualityLevels[].post.bloom.enabled` | bool | `true` |  | **On.** Off: off at this level. |
| `qualityLevels[].post.bloom.strength` | number | `0.6` | 0 – 3, step 0.05 | **Strength.** Glow strength. |
| `qualityLevels[].post.bloom.radius` | number | `0.4` | 0 – 1, step 0.05 | **Radius.** Glow spread. |
| `qualityLevels[].post.bloom.threshold` | number | `0.85` | 0 – 2, step 0.05 | **Threshold.** Only brighter than this glows. |
| `qualityLevels[].post.ssao` | object |  |  | **Ambient occlusion.** Contact shadows in creases. |
| `qualityLevels[].post.ssao.enabled` | bool | `true` |  | **On.** Off: off at this level. |
| `qualityLevels[].post.ssao.radius` | number | `0.5` | 0.01 – 4, step 0.01, m | **Radius.** How far it looks. |
| `qualityLevels[].post.ssao.intensity` | number | `1` | 0 – 4, step 0.05 | **Intensity.** How dark. |
| `qualityLevels[].post.dof` | object |  |  | **Depth of field.** Blur away from the focus distance. |
| `qualityLevels[].post.dof.enabled` | bool | `true` |  | **On.** Off: off at this level. |
| `qualityLevels[].post.dof.focus` | number | `10` | 0.1 – 1000, step 0.1, m | **Focus.** Sharp at this distance. |
| `qualityLevels[].post.dof.aperture` | number | `0.002` | 0 – 0.1, step 0.0005 | **Aperture.** Blur amount. |
| `qualityLevels[].post.dof.maxBlur` | number | `0.01` | 0 – 0.05, step 0.001 | **Max blur.** Blur limit. |
| `qualityLevels[].renderScale` | number |  | 0.5 – 1, step 0.05 | **Render scale.** Drawn at this share of the resolution, FSR 1 upscaled (absent: render_scale). |
| `qualityLevels[].pixelRatio` | number |  | 1 – 2, step 0.25 | **Pixel ratio cap.** Most pixels per CSS pixel on HiDPI displays (absent: 1). |
| `qualityLevels[].msaa` | int (one of 0 = Off, 4 = 4×) |  | step 1 | **MSAA.** Multisampling without a post stack (absent: 4). |
| `qualityLevels[].shadowMapSize` | int (one of 512, 1024, 2048, 4096) |  | step 1 | **Largest shadow map.** Larger light shadow maps are lowered to it (absent: each light's own). |
| `qualityLevels[].localLights` | int |  | 0 – 16, step 1 | **Local lights.** Point and spot lights drawn at once (absent: 16). |
| `qualityLevels[].shadowedLights` | int |  | 0 – 16, step 1 | **Shadowed lights.** Point and spot lights drawing their shadow at once: largest on screen first, spot before point, fading with distance (absent: every one). |
| `qualityLevels[].ambientOcclusion` | enum: `off`, `ssao`, `gtao` |  |  | **Ambient occlusion.** Where a look has AO (absent: ambient_occlusion). |
| `qualityLevels[].lodBias` | number |  | 0.25 – 4, step 0.05 | **LOD bias.** Above 1 keeps finer LODs further (absent: lod_bias). |
| `qualityLevels[].dynamicResolution` | bool |  |  | **Dynamic resolution.** Lower the scale while the GPU is over budget (absent: dynamic_resolution). |
| `presets` | list of objects, ≤ 64 items |  |  | **Presets.** Named looks scripts switch or blend to at run time (ctx.environment), laid over the active scene's look. |
| `presets[]` | object |  |  | **Preset.** A named look: sky, fog, post-processing, light values, a lightmap multiplier and the wetness. (rules: Preset ids are unique.) |
| `presets[].presetId` | string, identifier, 1–64 chars |  |  | **Id.** A stable id scripts use: a-z, 0-9, _ or -. (required; format identifier) |
| `presets[].name` | string, 1–128 chars |  |  | **Name.** Shown in the editor. (required) |
| `presets[].sky` | object |  |  | **Sky.** The background and the light it gives (image-based lighting). (rules: A texture sky needs an image or six cube faces.) |
| `presets[].sky.mode` | enum: `procedural`, `gradient`, `texture`, `color` | `"procedural"` |  | **Sky.** Physically based, a three-colour gradient, an image, or one colour. (required) |
| `presets[].sky.turbidity` | number | `6` | 1 – 20, step 0.1 | **Haze.** Atmospheric haze. (applies when `mode` is `procedural`) |
| `presets[].sky.rayleigh` | number | `1.5` | 0 – 4, step 0.05 | **Rayleigh.** Blue-sky scattering. (applies when `mode` is `procedural`) |
| `presets[].sky.mieCoefficient` | number | `0.005` | 0 – 0.1, step 0.001 | **Mie.** Haze around the sun. (applies when `mode` is `procedural`) |
| `presets[].sky.mieDirectionalG` | number | `0.8` | 0 – 1, step 0.01 | **Mie direction.** How tight the sun glow is. (applies when `mode` is `procedural`) |
| `presets[].sky.sunFromLight` | bool | `true` |  | **Sun from light.** Place the sun opposite the scene's directional light. (applies when `mode` is `procedural`) |
| `presets[].sky.sunElevation` | number | `35` | -10 – 90, step 1, deg | **Sun elevation.** Sun height above the horizon. (applies when `mode` is `procedural` and `sunFromLight` is `false`) |
| `presets[].sky.sunAzimuth` | number | `160` | -180 – 180, step 1, deg | **Sun azimuth.** Sun direction around the horizon. (applies when `mode` is `procedural` and `sunFromLight` is `false`) |
| `presets[].sky.topColor` | color | `"#3d7cd6"` |  | **Top colour.** The sky overhead. (applies when `mode` is `gradient`) |
| `presets[].sky.horizonColor` | color | `"#bfe3ff"` |  | **Horizon colour.** The sky at the horizon. (applies when `mode` is `gradient`) |
| `presets[].sky.bottomColor` | color | `"#757575"` |  | **Bottom colour.** Below the horizon. (applies when `mode` is `gradient`) |
| `presets[].sky.color` | color | `"#7ec8ff"` |  | **Colour.** The one sky colour. (applies when `mode` is `color`) |
| `presets[].sky.texture` | asset id (texture) |  |  | **Image.** An equirectangular sky image. (applies when `mode` is `texture`) |
| `presets[].sky.cube` | list of asset id (texture), 6 items |  |  | **Cube faces.** Six images +x, −x, +y, −y, +z, −z (instead of one image). (applies when `mode` is `texture`) |
| `presets[].sky.rotation` | number | `0` | -360 – 360, step 1, deg | **Rotation.** Turns the sky image about the vertical axis (background and sky lighting alike). (applies when `mode` is `texture`) |
| `presets[].sky.intensity` | number | `1` | 0 – 8, step 0.05 | **Brightness.** Background brightness. |
| `presets[].sky.environmentIntensity` | number | `1` | 0 – 8, step 0.05 | **Sky lighting.** How much the sky lights the scene (0: none). |
| `presets[].fog` | object |  |  | **Fog.** Distance fog. |
| `presets[].fog.mode` | enum: `none`, `linear`, `exp2` | `"none"` |  | **Fog.** None, linear (near to far) or exponential (density). (required; choices: `none` = None, `linear` = Linear, `exp2` = Exponential) |
| `presets[].fog.color` | color | `"#c8d2dc"` |  | **Colour.** The fog colour. (required) |
| `presets[].fog.near` | number | `10` | 0 – 10000, step 1, m | **Start.** Fog starts here. (applies when `mode` is `linear`) |
| `presets[].fog.far` | number | `120` | 0 – 10000, step 1, m | **Full.** Fog is full here. (applies when `mode` is `linear`) |
| `presets[].fog.density` | number | `0.01` | 0 – 1, step 0.001 | **Density.** Exponential fog density. (applies when `mode` is `exp2`) |
| `presets[].heightFog` | object |  |  | **Height fog.** Exponential height fog: thickens with distance and lies low, thinning with height; it fogs the sky towards the horizon too, so the far edge of a level fades into it. Presets blend it. |
| `presets[].heightFog.density` | number | `0.02` | 0 – 1, step 0.0005 | **Density.** Fog per metre at the base height. (required) |
| `presets[].heightFog.color` | color | `"#c8d2dc"` |  | **Colour.** The fog colour. (required) |
| `presets[].heightFog.height` | number | `0` | -10000 – 10000, step 1, m | **Base height.** World height where the fog has its density. |
| `presets[].heightFog.falloff` | number | `0.05` | 0 – 10, step 0.005 | **Falloff.** How fast it thins with height (per metre: halves every 0.69 / falloff m). |
| `presets[].heightFog.start` | number | `0` | 0 – 10000, step 1, m | **Start distance.** No fog nearer than this to the camera. |
| `presets[].heightFog.inscatterColor` | color |  |  | **Sun glow.** Added towards the sun (absent: no glow). |
| `presets[].heightFog.inscatterExponent` | number | `8` | 1 – 64, step 1 | **Sun glow size.** Higher: a tighter glow round the sun. |
| `presets[].post` | object |  |  | **Post-processing.** Tone mapping, exposure and screen effects. |
| `presets[].post.toneMapping` | enum: `none`, `aces`, `agx`, `neutral` | `"agx"` |  | **Tone mapping.** How bright colours are mapped to the screen. |
| `presets[].post.exposure` | number | `1` | 0 – 8, step 0.05 | **Exposure.** Overall brightness. |
| `presets[].post.antialias` | enum: `none`, `fxaa`, `smaa` | `"none"` |  | **Anti-aliasing.** Smooths jagged edges. |
| `presets[].post.bloom` | object |  |  | **Bloom.** Bright parts glow. |
| `presets[].post.bloom.enabled` | bool | `true` |  | **On.** Turns bloom on. (required) |
| `presets[].post.bloom.strength` | number | `0.6` | 0 – 3, step 0.05 | **Strength.** Glow strength. |
| `presets[].post.bloom.radius` | number | `0.4` | 0 – 1, step 0.05 | **Radius.** Glow spread. |
| `presets[].post.bloom.threshold` | number | `0.85` | 0 – 2, step 0.05 | **Threshold.** Only brighter than this glows. |
| `presets[].post.grading` | object |  |  | **Colour grading.** Contrast, saturation, tint, lift/gamma/gain and a LUT. |
| `presets[].post.grading.contrast` | number | `0` | -1 – 1, step 0.05 | **Contrast.** −1 to 1 (0: unchanged). |
| `presets[].post.grading.saturation` | number | `0` | -1 – 1, step 0.05 | **Saturation.** −1 to 1 (0: unchanged). |
| `presets[].post.grading.brightness` | number | `0` | -1 – 1, step 0.05 | **Brightness.** −1 to 1 (0: unchanged). |
| `presets[].post.grading.tint` | color | `"#ffffff"` |  | **Tint.** Multiplied over the image (white: none). |
| `presets[].post.grading.lut` | asset id (texture) |  |  | **LUT.** A colour lookup texture. |
| `presets[].post.grading.lift` | number | `0` | -0.5 – 0.5, step 0.01 | **Lift.** Raises the blacks (0: unchanged). |
| `presets[].post.grading.gamma` | number | `1` | 0.2 – 5, step 0.05 | **Gamma.** Mid-tones (above 1 brightens; 1: unchanged). |
| `presets[].post.grading.gain` | number | `1` | 0 – 4, step 0.05 | **Gain.** Scales the whites (1: unchanged). |
| `presets[].post.vignette` | object |  |  | **Vignette.** Darkened corners. |
| `presets[].post.vignette.enabled` | bool | `true` |  | **On.** Turns vignette on. (required) |
| `presets[].post.vignette.darkness` | number | `0.5` | 0 – 1, step 0.05 | **Darkness.** How dark the corners get. |
| `presets[].post.vignette.offset` | number | `1` | 0 – 2, step 0.05 | **Size.** How far in it reaches. |
| `presets[].post.ssao` | object |  |  | **Ambient occlusion.** Contact shadows in creases. |
| `presets[].post.ssao.enabled` | bool | `true` |  | **On.** Turns ambient occlusion on. (required) |
| `presets[].post.ssao.radius` | number | `0.5` | 0.01 – 4, step 0.01, m | **Radius.** How far it looks. |
| `presets[].post.ssao.intensity` | number | `1` | 0 – 4, step 0.05 | **Intensity.** How dark. |
| `presets[].post.dof` | object |  |  | **Depth of field.** Blur away from the focus distance. |
| `presets[].post.dof.enabled` | bool | `true` |  | **On.** Turns depth of field on. (required) |
| `presets[].post.dof.focus` | number | `10` | 0.1 – 1000, step 0.1, m | **Focus.** Sharp at this distance. |
| `presets[].post.dof.aperture` | number | `0.002` | 0 – 0.1, step 0.0005 | **Aperture.** Blur amount. |
| `presets[].post.dof.maxBlur` | number | `0.01` | 0 – 0.05, step 0.001 | **Max blur.** Blur limit. |
| `presets[].lights` | list of objects, ≤ 32 items |  |  | **Lights.** Light values (later entries win per field). |
| `presets[].lights[]` | object |  |  | **Light.** The values this preset gives the lights it names (one of entity, tag or type; none: every light). (rules: A light entry names at most one of entity, tag or type (none: every light).) |
| `presets[].lights[].entity` | object id (with `light`) |  |  | **Entity.** One light by its entity. |
| `presets[].lights[].tag` | string, identifier, 1–32 chars |  |  | **Tag.** Every light with this tag. (format identifier) |
| `presets[].lights[].type` | enum: `directional`, `ambient`, `point`, `spot`, `hemisphere` |  |  | **Type.** Every light of this type. |
| `presets[].lights[].color` | color |  |  | **Colour.** The light colour. |
| `presets[].lights[].intensity` | number |  | 0 – 1000, step 0.05 | **Intensity.** The light intensity (candela for point and spot lights). |
| `presets[].lights[].direction` | vec3 [x, y, z] |  | -1 – 1, step 0.05, not 0 | **Direction.** Where a directional or spot light shines (not all 0). |
| `presets[].lights[].groundColor` | color |  |  | **Ground colour.** A hemisphere light's ground colour. |
| `presets[].lightmap` | object |  |  | **Lightmap.** Multiplies baked lighting (a bake keeps the light of the moment it was baked). |
| `presets[].lightmap.intensity` | number | `1` | 0 – 8, step 0.05 | **Intensity.** Multiplies the baked light (1: as baked). |
| `presets[].lightmap.tint` | color | `"#ffffff"` |  | **Tint.** Tints the baked light (white: as baked). |
| `presets[].wetness` | number | `0` | 0 – 1, step 0.05 | **Wetness.** How wet the scene is (rain): materials with a Scene wetness node (the height-blended layers template) darken and shine as if wet, water pooling in low parts first. Presets blend it. |

<a id="content-input"></a>
## input — Input

Actions and their bindings.

- In every project: no
- Written by: [`setInput`](ops-detail.md#op-setInput)

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `actions` | list of objects, ≤ 64 items |  |  | **Actions.** Up to 64 named actions. (required) |
| `actions[].name` | string, identifier, 1–32 chars |  |  | **Name.** The action name scripts and blocks read (a letter or _, then letters, digits or _). (required; format identifier) |
| `actions[].type` | enum: `button`, `axis1d`, `axis2d` | `"button"` |  | **Type.** A button, a 1D axis (left/right) or a 2D axis. (required; choices: `button` = Button, `axis1d` = Axis (1D), `axis2d` = Axis (2D)) |
| `actions[].map` | inputMap id | `"gameplay"` |  | **Map.** Read by the game (gameplay), the menus (ui) or one of the project's maps. (required) |
| `actions[].bindings` | list of objects, ≤ 8 items |  |  | **Bindings.** Up to 8 keys, buttons, axes or composites. (required) |
| `actions[].bindings[]` | object |  |  | **Binding.** One binding (it must fit the action type). (rules: A button takes keys, buttons and pointer buttons; a 1D axis also two-key, two-button, axis and pointer-axis bindings; a 2D axis four keys, a stick, the pointer position or the pointer movement.) |
| `actions[].bindings[].kind` | enum: `key`, `gamepadButton`, `gamepadAxis`, `keys1d`, `keys2d`, `gamepadButtons1d`, `gamepadStick`, `pointerButton`, `pointerPosition`, `pointerDelta`, `pointerAxis` | `"key"` |  | **Kind.** What is bound. (required; choices: `key` = Key, `gamepadButton` = Gamepad button, `gamepadAxis` = Gamepad axis, `keys1d` = Two keys (1D), `keys2d` = Four keys (2D), `gamepadButtons1d` = Two gamepad buttons (1D), `gamepadStick` = Gamepad stick, `pointerButton` = Pointer button, `pointerPosition` = Pointer position (2D), `pointerDelta` = Pointer movement (2D), `pointerAxis` = Pointer axis (1D)) |
| `actions[].bindings[].code` | string, keyCode, 1–32 chars |  |  | **Key.** A keyboard key (KeyboardEvent.code). (required; applies when `kind` is `key`; format keyCode) |
| `actions[].bindings[].button` | int |  | 0 – 31, step 1 | **Button.** A standard gamepad button index. (required; applies when `kind` is `gamepadButton`) |
| `actions[].bindings[].axis` | int |  | 0 – 7, step 1 | **Axis.** A standard gamepad axis index. (required; applies when `kind` is `gamepadAxis`) |
| `actions[].bindings[].negative` | string, keyCode, 1–32 chars |  |  | **Negative key.** The key for −1. (required; applies when `kind` is `keys1d`; format keyCode) |
| `actions[].bindings[].positive` | string, keyCode, 1–32 chars |  |  | **Positive key.** The key for +1. (required; applies when `kind` is `keys1d`; format keyCode) |
| `actions[].bindings[].negative` | int |  | 0 – 31, step 1 | **Negative button.** The gamepad button for −1. (required; applies when `kind` is `gamepadButtons1d`) |
| `actions[].bindings[].positive` | int |  | 0 – 31, step 1 | **Positive button.** The gamepad button for +1. (required; applies when `kind` is `gamepadButtons1d`) |
| `actions[].bindings[].up` | string, keyCode, 1–32 chars |  |  | **Up.** The key for up. (required; applies when `kind` is `keys2d`; format keyCode) |
| `actions[].bindings[].down` | string, keyCode, 1–32 chars |  |  | **Down.** The key for down. (required; applies when `kind` is `keys2d`; format keyCode) |
| `actions[].bindings[].left` | string, keyCode, 1–32 chars |  |  | **Left.** The key for left. (required; applies when `kind` is `keys2d`; format keyCode) |
| `actions[].bindings[].right` | string, keyCode, 1–32 chars |  |  | **Right.** The key for right. (required; applies when `kind` is `keys2d`; format keyCode) |
| `actions[].bindings[].x` | int |  | 0 – 7, step 1 | **X axis.** The stick's horizontal axis index. (required; applies when `kind` is `gamepadStick`) |
| `actions[].bindings[].y` | int |  | 0 – 7, step 1 | **Y axis.** The stick's vertical axis index. (required; applies when `kind` is `gamepadStick`) |
| `actions[].bindings[].button` | enum: `left`, `right`, `middle` | `"left"` |  | **Pointer button.** The mouse (or pen/touch) button. (required; applies when `kind` is `pointerButton`) |
| `actions[].bindings[].axis` | enum: `x`, `y`, `wheel` | `"x"` |  | **Pointer axis.** The pointer's movement along x or y (up positive; percent of the view per step), or the wheel (notches, positive towards the user). (required; applies when `kind` is `pointerAxis`) |
| `actions[].bindings[].hold` | number | `0.5` | 0.05 – 10, step 0.05, s | **Hold.** Hold instead of tap: the binding counts only after it has been held this long. (applies when `kind` is `key` or `gamepadButton` or `pointerButton`) |
| `actions[].bindings[].pad` | int |  | 0 – 3, step 1 | **Pad.** Only this gamepad (its slot, 0 for the first connected): each player of a local co-op game on a pad of their own. Absent: the pad used last. (applies when `kind` is `gamepadButton` or `gamepadAxis` or `gamepadButtons1d` or `gamepadStick`) |
| `actions[].deadZone` | number | `0.2` | ≥ 0, < 1, step 0.05 | **Dead zone.** Axis values within this count as 0 (then rescaled). |
| `actions[].invert` | bool | `false` |  | **Invert.** Flip the axis. |
| `actions[].scale` | number | `1` | > 0, ≤ 10, step 0.1, × | **Scale.** Multiply the value. |
| `maps` | list of string, identifier, 1–32 chars, ≤ 8 items, distinct |  |  | **Project maps.** Up to 8 input maps besides gameplay and ui (game modes activate maps). |
| `cursor` | map inputMap id → enum: `free`, `locked`, ≤ 10 entries |  |  | **Cursor.** The cursor while each map is active (absent: free): free, or locked (hidden and held in the view; its movement still counts, its position is the view's centre). The ui map's applies while a menu is open; during play the first of the active maps that sets one (a game mode's maps in their order). It is hidden while a gamepad drives the game. |
| `glyphs` | map key → asset id (texture), ≤ 128 entries |  |  | **Glyphs.** Glyph key → an image shown instead of the engine's generic icon. A key is an icon id (pad-south, pad-shoulder-left, mouse-left, key, …), optionally for one gamepad family (xbox:pad-south) or one key (key:Space). |
