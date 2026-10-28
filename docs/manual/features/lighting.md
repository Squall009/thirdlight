# Lighting

How to light and bake a scene step by step: [the lighting guide](../guides/lighting.md). Quality levels, ambient occlusion and render scale are described with the other render settings in [Testing, debugging and quality settings](debugging.md#ambient-occlusion-render-scale-and-dynamic-resolution).

## How lighting works

One system lights every static surface: the **surface cache**. It holds the
diffuse light falling on block layers, terrain, generated buildings and
static models, a texel about every 10 cm near the camera and coarser
farther away. Everything else reads from it: the surfaces themselves, the
light probes (bounced light), and the reflections. The cache is computed
only where something changed, so a still scene costs almost nothing once
its light has settled. The same system, run until it settles and saved, is
the bake: there is one baker, not two.

**What is cached, what is per pixel.**

| Light | Where it is computed | Notes |
|---|---|---|
| Direct diffuse light of point, spot and area lights and static glowing boxes, with soft traced shadows | Surface cache texels | Every light in the scene counts, past the 16 drawn per pixel too |
| The sun's diffuse light on static surfaces | Per pixel, with its shadow map (the cached static map with moving casters on top) | Sharper than a cache texel; the cache keeps the sun's share for the probes and reflections |
| Bounced light | Probes, updated by rays that read the cache where they hit | Static surfaces, moving objects, foliage and ground cover all read the probes |
| Contact shadows | Per pixel, screen space | The sun's fine detail its map misses |
| Highlights (specular) | Per pixel | Point and spot lights as three draws them; area lights with three's rectangle-light maths; each scaled by the cache's shadowing |
| Reflections | Per pixel: screen-space rays, then rays traced through the static world reading the cache | Glossy surfaces only; rough ones keep the environment and probes |

**Who reads what.**

| Surface | Diffuse light | Bounce |
|---|---|---|
| Block layers, terrain, generated architecture | The cache (one filtered lookup a pixel) | Probes |
| Static models with a second UV set (UV1) | The cache at their UV1 | Probes |
| Static models without UV1 | The cache at surfels spread over them at import (no unwrap needed; the light steps at the surfel spacing) | Probes |
| Static boxes, moving objects, skinned characters, foliage, ground cover, particles | Per-pixel sun, point and spot lights (at most 16 drawn) | Probes |

A surface with no cache texel under it yet (not resident, a trim off its
wall's plane) is lit per pixel until it has one. Moving objects **receive**
all of this but do not **block or bounce** it: they cast the sun's and
local lights' per-pixel shadows, not the cache's, and a character in a
doorway darkens nothing in the room's bounced light.

**Light kinds.** Directional (the sun), point, spot and `area` (rect or
line, [Area lights](#area-lights)) lights light the cache; the sky's light
and `baked` or `mixed` ambient and hemisphere lights are held in the probes,
`realtime` ones are added on top (see [Probes](#probes)); a static box
that glows lights the cache as rectangle lights ([Emissive
light](#emissive-light)). Each light's `mode` (`realtime`, `baked`, `mixed`)
decides only what a bake saves; live, every light lights the cache.

**Live or saved.** Which one a device draws is its quality level's
[lighting tier](debugging.md#lighting-tiers):

- **Low** (WebGL 2 always; any device on a level whose `surfaceLightMs` is
  0): the saved bake — cache pages and probes — plus the sun's shadow map and
  the per-pixel lights. Nothing is lit live; a scene without a bake has its
  per-pixel lights and the sky's, ambient and hemisphere light only (no
  bounce).
- **Medium** (WebGPU, integrated GPU, the engine's default): the cache and
  the probes are lit live within 1.5 ms of GPU a frame, contact shadows,
  reflections, temporal upscaling from a 0.667 render scale (where the
  project sets no render scale of its own).
- **High** (WebGPU, discrete GPU): medium with 3 ms, twice the rays a texel,
  the finest texels twice as far out, more reflection rays, a 128 MiB cache.

A WebGPU device at medium or high starts from the scene's bake where it has
one and lights live from there: only what the bake lacks is lit again.

**Updates follow changes.** A light switched, dimmed, recoloured (2 % or
more) or moved (1 cm or more), the sun or time of day turning half a degree,
a block placed or dug (in the editor or by a script), terrain heights or
holes changed, generated architecture made again, a static object moved, a
chunk streamed in or out: each marks the cache units and probes it touches
stale. The level's GPU time a frame re-lights stale work nearest the camera
first (work that waits long moves up). Measured on the Iris Xe at the
medium tier: a lamp switched in a closed block room re-lights the room's
texels in about 270 ms and its probes with it in about 450 ms; a sun step
re-lights the whole village perf class's surfaces in about 2.5 s and its
probes in about 16 s. A large change (a sun sweep, much terrain dug at
once) shows the light catching up over frames.

**Memory.** The cache's size is the quality level's `surfaceCacheMiB`
(32 / 64 / 128 MiB by tier): a budget, never a count of surfaces or lights.
Tiles stay resident round the camera at texel sizes from 10 cm (to 12 m;
24 m on high) to 3.2 m, coarser with distance; when the budget is full the
farthest tiles take coarser texels, then are let go. Terrain takes at most a
quarter of it in rings round the camera (7 rings of 512² texels, 14 MiB,
whatever the terrain's size). The village and landscape perf classes use
12–15 MiB.

**What it traces.** Shadow and bounce rays go through the static scene as
the engine knows it: block layers cell by cell (a block whose type fills its
cell stops light; half blocks, ramps, stairs and custom shapes let it
through), terrain exactly within about 512 of its cells round the camera and
from coarser rings beyond, generated architecture as boxes of its pieces'
real thickness (every piece but detail: ceilings and roofs stop light whether
or not they collide; glass and trims let it through), and static models as
distance-field bricks made at import (cached with the model and shipped in
the export for models placed static). Static boxes, moving objects, foliage
and ground cover are not traced.

## Emissive light

What glows into the cache today, and what does not:

- **Static glowing boxes** — a box with **Static** ticked and a `surface`
  whose `emissive` colour and `emissiveIntensity` are above 0 lights the
  cache: each of its faces is a one-sided rectangle light as bright as the
  box glows (radiance × the face's area), with soft traced shadows; faces
  under 5 % of its largest face (a sign's edges) are left out. Its light
  bounces through the probes like any other. It gives no per-pixel
  highlight (a polished floor shows it through the reflections). Its
  surface's **Glow mode** (`emissiveMode`) is its light mode, as a light's
  `mode`: `baked` by default (a bake saves its direct light and bounce, so
  WebGL 2 and the low tier draw its pool), `mixed` (only its bounce is
  saved: on WebGL 2 and the low tier it lights only through the probes, as
  it has no per-pixel light) or `realtime` (nothing saved: there it lights
  nothing around it).
- **Everything else that glows** — a model whose material is emissive, a
  block type with an emissive material, generated architecture's glowing
  trims, a graph material's emission: they draw their glow on their own
  pixels (and bloom takes it) but light nothing around them, neither in the
  cache nor through the probes. A neon sign that should light the street
  needs a static glowing box behind it or an area light in front of it.

Emissive surfaces do show in reflections where the screen shows them (the
screen-space rays take the frame's own colour).

## Baked lighting

The lighting a scene saves is the live lighting itself (see [the surface
cache's live light](#the-surface-caches-live-light)), run until it settles:
**Bake lighting** in the Lighting window (Window → Lighting, floating over
the Scene view; it names the scene it edits and its picker makes another
scene active), or `tl_bake_lighting {sceneId}` from an agent (the backend
asks the editor — the connected browser, else a headless one — to run the
same bake; the editor's changes go through the commands). It runs on the
Scene view's renderer and needs **WebGPU**; on WebGL 2 the button is off and
the window says so.

This is the only baker. The earlier ones — the browser lightmap bake
(*Bake preview*, *Bake final*), the probe-grid bake and the Blender (Cycles)
final bake with its backend service and `THIRDLIGHT_BAKE_*` settings — are
gone; what they baked still draws (below).

- **What is saved** — the static surfaces' light (block layers, generated
  buildings and static models: the Scene view reads each static model's
  distance-field file from the backend, which makes it first for a model
  imported before such files existed; a model with nothing to make one of
  keeps its per-pixel lights and the probes)
  and the probes (each room's grid and the bricks). The lights' modes decide what: a `baked` light's direct
  light and its bounce, a `mixed` light's bounce (its direct light stays per
  pixel, with its shadows), a `realtime` light nothing. The bake first lets
  the baked and mixed lights light the cache, then starts the probes over
  from it (none of the light they held live before is kept) until both
  settle, then holds the probes and lets only the baked lights' direct light
  settle in the cache. Terrain is saved as its rings: the finest ring has
  the bake's texel size and they stand round the scene's content (the
  middle of its saved surfaces and lights; a scene of bare terrain, the
  terrain's middle), out to the terrain's far edge; WebGL 2 and the low
  tier read them through the same lookup, and terrain past the last ring
  keeps its per-pixel lights. Static boxes are not saved (they never read
  the cache, live or saved). With
  several scenes open, all are lit together (each lights and shades the
  others) but only the baked scene is saved: its surfaces at the level
  that fits them, the probes over them and its own lights.
- **How fine** — every tile at one level, the finest whose pages and
  terrain rings (2 MiB each) fit 32 MiB together (`SAVED_SURFACE_CACHE_MIB`,
  the low lighting tier's whole cache budget): 10 cm texels for a small
  scene, coarser for a large one, so a low-tier device holds a scene's
  saved light whole.
- **Files** — the saved file (the cache's tiles and pages as RGBA half
  floats, the probes' tiles as the probe lighting holds them) travels as
  texture assets named `lighting <scene>` (16-bit PNGs used as byte
  containers, up to 4,096 rows of 8 KiB each; a large scene takes several).
  Each bake publishes new assets; the previous bake's are deleted only once
  the new record is taken, so a bake that fails or is refused leaves the
  previous one whole, and undo (the deletes, then the record) brings it back
  with its own files. The scene's bake records them
  (`lighting[sceneId].surface`: `files`, `level`, `tiles`, `pages`,
  `probes`, `bytes`, `millis` — the run's time — and the hashes).
- **Who draws it** — WebGL 2, a quality level without a live budget
  (`surfaceLightMs` 0: the low [lighting tier](debugging.md#lighting-tiers)) and a live light still starting
  draw the saved light: each tile where the bake put it (a tile whose
  geometry changed since keeps its per-pixel lights), read by the same
  lookup and material variants as the live light, its light added to the
  per-pixel lights of mixed and realtime lights; the saved probes go to the
  probe lighting as live ones do. WebGPU at medium and high lights live (it
  draws the saved light until its live light starts), and the live light
  starts from the bake: tiles at the bake's level and probes take their
  saved light, and only what the bake lacks is lit again — the direct light
  of mixed and realtime lights, the bounce of realtime lights, and lights
  changed since the bake (the bake records its lights). A tile whose
  geometry changed since, one added since and one gone since (where the bake
  saved it) are marked as an edit is: the light round them is lit again,
  the rest keeps the bake. Baked lights are not drawn per pixel while a bake is used.
- **What stops light** — generated architecture stops light with every
  piece that is not detail, whether or not it collides: ceilings, vaults and
  roofs close their rooms though nobody walks on them. Glass panes and trims
  let it through.
- **The Scene view as Play** — both draw through the same adapter: the same
  quality level decides saved or live, the same lookup and the same probe
  lighting. The editor keeps drawing while the live light settles.

A bake whose static objects (generated buildings included), baked or mixed
lights or the sky's turn changed since is shown as stale; it is still drawn
until it is baked again or cleared (Clear bake). A bake made by the earlier
bakers (lightmaps and probe grids, before "Bake lighting") keeps drawing as
it did — lightmaps on the objects they were baked for, probe tiles streamed
round the camera — and the window shows it as stale until the scene is
baked again. A scene with a bake cannot be deleted until the bake is
cleared. MCP clears a bake with `setLighting {sceneId, lighting: null}`.

Measured on this host (Iris Xe, WebGPU, 1920 × 1080; the run to settled,
then saving): the village perf class 2.4 s (16 tiles at 10 cm, 10,240
probes, 195 KB of files), the landscape class 17.6 s (49 tiles at 20 cm,
30,016 probes, 394 KB), the interior class 12.8 s (13 tiles, 9,984 probes,
244 KB), the look-reference scenes 3.3–4.9 s (41–258 KB). On WebGL 2 the
saved light costs the main thread about 0.3–2 ms a frame (most of it with
many saved probes).

### Probes

**How the probes light the scene.** Every lit 3D object — models, boxes,
graph and kit materials, foliage and water, instance sets, block chunks,
skinned characters, moving or not — takes its indirect light per pixel from
the probes around it, in place of the flat ambient light, wherever it is
inside a probe tile (a room's grid or a brick); outside every tile the flat
ambient light stays. What the probes replace: the sky's image-based diffuse
light and the ambient and hemisphere lights whose mode is `baked` or
`mixed` (the probes hold them); `realtime` ambient and hemisphere lights are
added on top, and direct light (sun, point, spot, effect lights) is
unchanged. The sky's reflections are darkened where the probes are darker
than the light they replace (a closed room does not mirror the sky).
Lightmapped surfaces of an earlier bake keep their lightmap and ignore the
probes.

- A pixel samples the probes half a spacing off its surface, but never
  across a wall: an inside wall, floor or object standing by a closed wall
  reads only the probes on its own side, so sunlight outside does not leak
  in. Moved probes count half, filled ones hardly at all.
- The probes hold first-order light (soft directional indirect light; four
  texture reads a pixel).
- Light layers: the probes light every layer (they are indirect light).
- A light with mode `baked` that a bake holds is off for moving objects
  too: they get its bounce from the probes, not its direct light; `mixed`
  lights stay per pixel for direct light and their bounce is in the probes.
- An earlier bake's probe tiles stream: only the tiles nearest the camera
  are loaded, as many as the probe memory budget holds (128 MB,
  `PROBE_RESIDENT_BYTES`); Play diagnostics `renderer.probes` report them.
  The saved probes of "Bake lighting" are all on the GPU while their scene
  is loaded (not streamed).
- `?probes=off` on a game page draws without probes (a diagnostic
  comparison, like `?shadowcache=off`).
- **View → Light probes** in the Scene view draws every probe as a small
  sphere lit by its own light (the live probes, else the saved ones);
  probes moved out of geometry have a yellow rim, filled ones a red rim.
- A **Probe volume** component (GameObject → Light → Probe volume) placed
  the earlier probe bake's probes; it is not read now (the live probes stand
  where the scene's geometry and rooms put them).

## Light layers

Which lights light an object and whose shadows it casts (Godot's light cull
mask and shadow caster mask, Unity's rendering layers). There are 8 layers
(`LIGHT_LAYER_COUNT`, project-model `light-layers.ts`); every mask is a bit
mask, bit n = layer n + 1, 255 = every layer.

- **Objects** — a box, model, instance set or block layer has **Light
  layers** in the Inspector (`lightLayers`, 1–255; absent: every layer): the
  layers it is in. An object is in at least one layer.
- **Lights** — every light has a **Light mask** (`lightMask`, 0–255): it
  lights an object only when they share a layer; a directional, point,
  spot or area light also has a **Shadow caster mask** (`shadowCasterMask`, 0–255):
  only objects sharing a layer with it cast its shadow (the cached static map
  and the dynamic one alike). 0 lights nothing / takes no shadow.
- **Names** — Project Settings → **Light layers** names the 8 layers
  (`content.lightLayers`, `setLightLayers {layers}` from MCP); the names are
  only labels for the Inspector's checkboxes, the data holds the masks.
- **Scripts** — `ctx.entity(light).set('light', { lightMask, shadowCasterMask })`
  while the game runs (page, worker and replay alike).
- **Cost** — the defaults (every layer) cost nothing: such a light is an
  ordinary three.js light and the shaders are the same as without layers
  (village class: same 52 shader modules and 34 pipelines, frame time
  unchanged). A light with a narrower mask tests each drawn object's layers
  on the CPU and multiplies its colour by the result: one shader for every
  mask combination, so changing a mask builds nothing; a light turning from
  every layer to fewer (or back) rebuilds the lit shaders once, as adding a
  light does. Batching, static merging and instancing keep objects of
  different layers in different draws.
- **Rooms** — generated rooms are a light layer of their own, set by the
  engine, not one of the 8 (see [Rooms drive culling and lighting](architecture.md#rooms-drive-culling-and-lighting)): a lamp
  in a room lights only that room. A drawable a light leaves out skips the
  light's work altogether (a branch on the draw's own test), so layers and
  rooms make lit pixels cheaper, not dearer.

## Area lights

An area light (`light` with `type: "area"`) is a light with a size: a lit
ceiling panel, a window, a light strip down a hall. Its light and shadows
soften with its size, and close by it lights a surface from its whole face
rather than one point. Add one with **GameObject → Light → Area light** (a
1.2 × 0.6 m warm-white ceiling panel, 40 cd, reaching 10 m).

- **Fields** — `shape`: `rect` (absent) or `line`; `width` (metres, 0–50,
  absent 1): a rect's side along the object's local X, or a line's length;
  `height` (metres, 0–50, absent 0.5, rect only): its side along local Z;
  `twoSided` (absent false). Like point and spot lights it has `color`,
  `intensity` (candela along its facing axis, for the whole light: far away
  it lights like a point light of that intensity; 0–1000), `range` (0:
  unlimited), `castShadow` (absent **true**: soft shadows are what an area
  light is for), `mode` (realtime, baked, mixed), `lightMask` and
  `shadowCasterMask`.
- **Where it faces** — the object's transform places it: a rect lies in the
  object's local XZ plane, centred on it, a line runs along its local X, and
  it shines toward local −Y (both ways when two-sided). Unrotated, an area
  light is a ceiling panel shining down; rotate the object to aim it (it has
  no direction field). The Scene view draws its outline and a tick on the
  side it shines toward.
- **How it lights** — through the surface cache, the static surfaces' light:
  on WebGPU at medium and high quality its light and soft shadows are traced
  into the cache of the static surfaces around it, and block layers,
  terrain, generated buildings and static models draw it from there.
  Moving objects and static boxes get its light only as bounce through the
  probes. Its highlights are drawn per pixel on the surfaces that read the
  cache (standard, physical, graph and layered materials; Lambert ones have
  none), with three.js's rectangle-light maths; a line light's highlight is
  drawn as a 2 cm strip along it. The 4 area lights that matter most at the
  camera (brightest over distance squared) give highlights each frame; every
  one lights the cache. WebGL 2 draws the cache's saved light and no area
  light highlights. Bake lighting saves its light by its `mode`, as any
  light's.
- **No per-pixel budget** — area lights, like baked point and spot lights,
  are not counted in the scene's 16 realtime point and spot lights.

## The surface cache's live light

On WebGPU at the medium and high [lighting tiers](debugging.md#lighting-tiers)
(`surfaceLightMs` above 0 in the quality level; high also casts twice the
rays a texel and keeps the finest texels twice as far out), the static surfaces' light is computed on the GPU into the
surface cache, a little each frame within the level's GPU time, and again
only where something changed:

- **What lights it** — the sun (soft shadows over its disc), point and spot
  lights, area lights (soft shadows over their shape) and static glowing
  boxes (a `surface` with an emissive colour: each face lights as a
  rectangle light as bright as the box glows). Every light in the scene
  counts, including lights past the 16 drawn per pixel and baked ones.
- **Shadows** — traced through the static scene (blocks, terrain,
  generated buildings, static models). A light with **Cast shadows** off
  lights through everything. **Light mask** and **Shadow caster mask** work
  as they do per pixel: a light lights only surfaces sharing a layer with
  its mask, and only objects in its caster mask cast its shadow. Terrain
  casts its shadows exactly within about 512 of its cells round the eye;
  farther ground casts them from rings of coarser samples (each ring
  twice as coarse and twice as wide), so a large terrain costs the same
  memory as a small one, and walking moves the rings a little at a time,
  never in one frame.
- **Bounced light** — live probes carry it: a grid inside each room of
  generated architecture, and elsewhere bricks of 4 × 4 × 4 probes placed
  by the geometry — 2 m apart where surfaces meet (a wall on a floor,
  steps, props, buildings), 6 m over flat ground, 18 m in the open above
  it, none far up in the sky; over terrain only near the eye (6 m within
  about 25 m, 18 m to about 100 m, moving with you). A probe that would
  stand inside geometry is left out, a room's too (one just under the ground is moved up
  onto it), and a brick's probe standing in a room is left to the room's
  own grid. When the static scene changes (a block dug, a chunk streamed
  in) the probes are placed again within about a second, a little each
  frame, and the ones that kept their place keep their light. Each stale probe casts rays that read the
  cache's light where they hit, the probes' own light there and the sky
  where they hit nothing, so bounces build up over a few updates. The
  updates share the level's GPU time: a third of it while the surface light
  has stale work, all of it once that is done; an update that costs more
  (its least cost is its slowest rays, through models' distance fields)
  is followed by frames without one, so a scene of many models settles its
  probes more slowly (the village perf class: about 16 s after a sun step,
  its surface light in about 2.5 s). Every lit material — moving objects, foliage and ground cover
  too — reads them through the usual probe lighting, in place of baked
  probes while the light is live. A bounce takes the colour of the surface
  it leaves: the surfaces that read the cache write their own colour beside
  it (one frame in 30, at half the cache's resolution, a quarter on
  terrain); where no material has drawn yet, it bounces as albedo 0.3.
  When colours change — the scene comes in, a surface is made again (a
  block edit, architecture restyled), a material is edited — the colours
  are written on the next frame and the probes round the change update
  once more, so their bounce takes the new colours.
- **Rooms and portals** — a point, spot or area light standing in a room of
  generated architecture lights only that room and the rooms its open
  doorways join to it; a shut door (a door piece across the doorway) holds
  its light in, though the door piece itself does not stop rays. A probe in
  a room sees out only through open doorways, no probe sees through a shut
  one, and a lamp switched in a room marks only its room and what it sees
  through its doorways. Interiors of blocks or models keep the probes'
  walls instead. Details and measured leaks: [Rooms, portals and
  leaks](#rooms-portals-and-leaks).
- **Light modes** — live, every light lights the cache whatever its mode.
  What "Bake lighting" saves follows the mode (see [Baked
  lighting](#baked-lighting)): a `baked` light's direct light and its
  bounce, a `mixed` light's bounce only, a `realtime` light nothing; a
  static glowing box's surface names its own (`emissiveMode`, absent
  `baked`).
- **What surfaces draw** — block layers, terrain and generated buildings
  read their diffuse light from the cache: one filtered lookup a pixel,
  found from where the pixel is and which way it faces. Static models (in
  a built game and in the editor's Scene view, from their distance-field
  files) read it too: a model
  with a second UV set (UV1) at its UV1, filtered; any other at the surfel
  nearest the pixel (one value per surfel, so the light steps at the
  model's surfel spacing). A model placed whole with several top-level
  pieces reads each piece's own light. The cache gives the
  light of point, spot, area lights and glowing boxes with their soft
  traced shadows; the sun is still drawn per pixel with its shadow map
  (sharper than a cache texel), so the cache's share of it is left out; the
  probes give the bounce; point and spot lights drawn per pixel keep their
  highlights and area lights add theirs (see Area lights). Highlights are
  shadowed by the cache: each is scaled by the share of those lights' light
  the cache's texel sees (its traced, soft-shadowed light over the light the
  same lights would give the pixel unshadowed), so a lamp's highlight fades
  in its shadow. It is one share for all of them: a pixel in one lamp's
  shadow and another's light takes the mix. Add `?surfaceHighlights=0` to
  a game page's address to draw no area light highlights (to compare). A pixel with no cache texel under it (its surface not
  resident yet, a trim off its wall's plane) is lit per pixel as before. A
  surface that has a baked lightmap keeps drawing it until the scene is
  baked again. Static boxes, moving objects, foliage and ground cover are
  lit as before (probes and per-pixel lights). Add
  `?surfaceRead=0` to a game page's address to light the cache without any
  surface reading it (to compare), or name the kinds that read it,
  `?surfaceRead=blocks,terrain,arch,model` (any of them: each kind's cost).
- **What it is not** — WebGL 2 and the low tier compute nothing live
  (they draw the saved light, [Baked lighting](#baked-lighting)). The rest
  is in [What the lighting does not cover](#what-the-lighting-does-not-cover).
- **Looking at it** — add `?surfaceCacheView=1` to a game page's address to
  draw every lit cache texel as a small square on its surface, shaded as a
  mid-grey surface would be by its light and its probes' bounce;
  `?probesView=1` draws the live probes, each a small sphere lit by its own
  light. The editor's Scene view has the same views in its **View** menu
  (see [In the Scene view](#in-the-scene-view)).

### In the Scene view

The Scene view draws the same lighting Play does, through the same path:
on WebGPU at a level with live-light time the light runs live (static
models included), elsewhere it draws the saved light. The toolbar's
**light: game** shows the scene's own lights (it switches to them once the
scene has a light; **light: editor** is a fixed rig).

**View** menu (each switch on or off; view only, nothing is saved):

- **Cache texels** — every lit cache texel as a small square on its
  surface (`?surfaceCacheView=1`).
- **Light probes** — every probe as a small sphere lit by its own light
  (`?probesView=1`; the saved probes where the light is not live).
- **Rooms and portals** — the rooms light keeps to: each room's outline
  from floor to top in cyan, each portal's outline green while light passes
  it and red, crossed, while a door piece shuts it.
- **Stale pages** — an orange box round each unit of the cache still to be
  lit (none once the light has settled).
- **Lighting pass times** — an overlay in the view's corner: the level and
  tier drawn, live or saved (and why), the cache's re-lighting GPU time a
  frame against its budget and the stale pages, the probes' update time and
  stale probes, the reflections' traced rays and their time, whether TAAU
  draws (the Scene view draws SMAA in its place), and whether the light has
  settled. A time reads "—" until the GPU has measured one.

**Lighting window** (Window → Lighting), above the bake:

- **Preview level** — the quality level the Scene view draws at, with its
  lighting tier; *As Play* is the project's starting level, else this
  device's (view only).
- **Live lighting** — off draws the saved light only, as WebGL 2 and the
  low tier do (view only).
- The previewed level's **Surface cache (MiB)**, **Live light (ms a
  frame)**, **Contact shadows** and **Reflections** — the project's quality
  level settings (empty or *Tier*: the tier's value). An edit is
  `setEnvironment` on the project's quality levels, the command Project
  Settings → Quality and MCP send; with the engine's levels it saves a copy
  of them first, and an edit that takes the copy back to the engine's
  removes it again.

## Rooms, portals and leaks

Light must not leak through a closed wall. Two mechanisms see to it:

- **Rooms and portals (generated architecture).** The rooms a building's
  floor plans make, and the portals between them (doorways, openings, holes,
  open tops), are what the lighting keeps light to. A point, spot or area
  light standing in a room whose open portals do not reach the outside
  lights only the rooms those portals join: the cache's texels are tested
  per room, so its light stops at the room's walls even where a wall piece
  is thin. A **shut door** (a door piece across a doorway) closes that
  portal: the lamp's light stays in, and no probe ray passes it. The door
  piece itself does not stop rays (it opens and shuts); the portal does.
  Probes inside a room are a grid of the room's own (probes that would
  stand inside geometry are dropped), their rays end at the room's walls
  unless they leave by an open portal, and a pixel in a room reads only its
  room's probes. A lamp switched in a room re-lights only its room and what
  it sees through its open doorways. A light with **Cast shadows** off
  lights only its own room too, in the cache as per pixel.
- **The probes' walls (`edgeWalls`), everywhere else.** Interiors built
  from block layers or imported models have no rooms. There the probes
  record how far each one sees along its axes, and a pixel samples the
  probes on its own side of a wall only: an inside wall, floor or object by
  a closed wall does not read the sunlit probes outside. The cache's direct
  light needs nothing extra there: its shadow rays meet the blocks and the
  models' distance fields.

Measured (a lamp behind a shut generated door, WebGPU live and the saved
light on both renderers): 0.07 % of the outside picture's pixels brighter by
more than 8 of 255 — the 10 cm gap over the door piece, seen directly — and
5–6.5 % with the door gone. A closed starter room's saved probes keep
nothing of the sunlit yard next to it.

Rooms and portals show in the Scene view's **View → Rooms and portals**
([In the Scene view](#in-the-scene-view)); culling uses the same rooms
([Rooms drive culling and lighting](architecture.md#rooms-drive-culling-and-lighting)).

## Contact shadows

Screen-space contact shadows add the sun's shadow detail its shadow map is
too coarse for: where a small thing meets the ground, a crease, a seam
between a wall and the floor where the map lets light through. After the
scene is drawn each pixel looks 0.3 m toward the sun through the frame's
depth (6 steps, at half the render scale); a step behind something there
darkens the sun's light at that pixel on the next frame (moving objects' contact shadows lag a frame,
as ambient occlusion does). They fade out from 25 to 40 m away, where the
map's own texels are as fine. Only the sun's direct light darkens; lamps,
sky and bounce do not.

- **Setting** — the quality level's `contactShadows` (absent: its lighting
  tier's — low none, medium and high on). They are drawn
  with the look's post effects: a look with any post effect or
  anti-aliasing has them, a look with none has none (a render scale,
  occlusion culling or MSAA off change nothing). Perspective cameras only; a
  logarithmic depth buffer has none.
- **What casts them** — everything in the depth buffer, an object whose own
  **Cast shadows** is off included (the depth holds no caster flags);
  transparent surfaces receive none.
- **Both renderers** — WebGPU and WebGL 2 alike. Add `?contactShadows=0` to
  a game page's address to draw none at any level (to compare).

## Reflections

Glossy surfaces (a standard or graph material's roughness up to 0.5)
reflect what is around them, on WebGPU.

- **On screen** — each glossy pixel, at half the render scale, casts one
  ray turned at random within its roughness and marches it through the
  frame's depth; where it meets something the picture shows, the reflection
  is that point's own lit colour (emissive surfaces included).
- **Off screen** — where the screen has no answer (the ray left it or went
  behind something), one pixel in every few casts its ray through the static
  world instead and reads the surface cache where it hits: the direct light
  of every light the cache holds, its soft shadows and the probes' bounce,
  times the surface's colour. So a polished floor shows the lit ceiling
  above the camera. How many rays depends on the GPU time they cost: the
  quality's budget (medium 0.5 ms, high 1 ms) sets one ray per 2 × 2 to
  16 × 16 pixels. Rays that meet nothing within 32 m fall back to the
  environment.
- **Blending** — each frame's rays are blended into the last frames'
  (reprojected with the camera), which turns a glossy surface's scattered
  rays into its blur; while the view stands still the rays stop turning, so
  a still view settles. From roughness 0.35 to 0.5 the reflection fades into
  the environment's light (as the probes darken it indoors); rougher
  surfaces only have that. Fresnel, metalness and ambient occlusion apply as
  to any reflection.
- **Setting** — the quality level's `reflections`: `off`, `medium` or
  `high` (absent: its lighting tier's — low off, medium medium, high high;
  high marches more steps and casts more traced rays). As
  contact shadows, they are drawn with the look's post effects; a look with
  none has none. Perspective cameras only.
- **What it is not** — WebGL 2 keeps the environment and probes (no
  reflections). The traced rays see only what the surface cache holds:
  blocks, terrain, generated buildings and static models; glowing boxes,
  moving objects and foliage show only where the screen shows them. Mirror-
  sharp reflections of things off screen are out of scope.
- **Comparing** — add `?reflections=0` to a game page's address to draw none,
  `?reflections=screen` for screen-space rays only, `?reflections=view` to
  draw the reflections alone.

## Local lights per object

Whether point, spot and effect lights reach an object. The sun, ambient
light and probes reach every object.

- **Objects** — a box, model or instance set has **Local lights** in the
  Inspector (`localLights`): **Per pixel** (highlights and shadows) or
  **None** (no local light at all: a far backdrop, a sky dome, a look lit by
  the sun and sky alone). "—" (absent) follows the material, else per pixel.
- **Materials** — standard, foliage and kit materials have a **Local lights**
  parameter (`object` follows the object), graph materials a **Local lights**
  field on their PBR and Custom-lit outputs. An object's own mode wins.
- The surface cache and the probes ignore every object's and material's
  mode: a lamp's bounce off a surface set to **None** still reaches the
  probes.
- **Cost** — none unless used: the default draws the same shaders as without
  it. **None** adds one program per material it is used with (light layers
  add none on top).
- **No per-vertex lights.** Shading local lights at the vertices was measured
  no cheaper than per pixel (Iris Xe, 1080p, scene pass: the village perf
  class 2.718 vs 2.705 ms, with 12 lamps over its scatter 6.88 vs 6.78 ms)
  while it cost shader variants, so the engine does not offer it. A project that stored `localLights:
  "vertex"` (or a light's or a *Lights* block's `importance`) opens with
  them per pixel and one Problems line counting them.

## What the lighting does not cover

The design's limits, and what is not built yet:

- **Moving objects add nothing to the light.** They receive the cache's
  bounce through the probes and the per-pixel lights, and cast per-pixel
  shadows, but they do not block or bounce the cached light: a crate pushed
  in front of a lamp shades nothing in the cache, a red car lends no red to
  the wall beside it.
- **Lights on what does not read the cache.** Moving objects, static boxes,
  foliage, ground cover and surfaces with an earlier bake's lightmap get
  point and spot lights per pixel (at most 16 drawn at once,
  `MAX_LOCAL_LIGHTS`) and area lights and glowing boxes only as bounce
  through the probes: no direct area light and no area highlight on them.
- **Static boxes** neither stop the cache's light nor read it, and a bake
  does not save their light: a lamp behind a static box lights the wall
  behind it through the box. Use block layers, generated architecture or a
  model for walls that must stop light.
- **Emissive materials** light nothing but their own pixels; only static
  glowing boxes light the cache ([Emissive light](#emissive-light)).
- **What a bake leaves out.** Static boxes (they read no cache); terrain
  past its last saved ring, and the live light starts terrain over (its
  rings are drawn from the bake only where the light is not live); an
  environment preset's `lightmap`
  multiplier does not reach the saved light (only an earlier bake's
  lightmaps); the saved probes are all on the GPU while their scene is
  loaded, not streamed; the **Probe volume** component is not read.
- **Reflections** are screen-space with a traced fallback that sees only
  what the cache holds (blocks, terrain, generated buildings, static
  models). Mirror-sharp reflections of things off screen are out of scope;
  WebGL 2 has no reflections and no area-light highlights.
- **Approximations you may see.** A large change shows the light catching
  up over frames; a probe keeps some (10–30 %) of the light it held before a
  change for a few updates; light can step in brightness where one cache
  chart meets the next; models without UV1 show their light in steps of
  their surfel spacing; a level built mostly of imported models is traced
  through distance fields, coarser than blocks' exact cells; contact shadows
  are cast by everything in the depth, an object with **Cast shadows** off
  included; a pixel's highlights share one shadowing value for all its
  lights. A bright procedural sky can wash out the probes' bounce (open).
- **Cost on an integrated GPU.** Measured on the Iris Xe at medium, 1080p
  from 1280 × 720, at the 60 Hz cap: every perf class holds 60 frames a
  second (p95 16.7 ms, no missed frames), and WebGL 2 at low is no slower
  than before the surface cache. Reading the cache costs more than a
  lightmap lookup (+0.7–1.6 ms of scene pass); a light change on a scene of
  many models runs a little over its 1.5 ms while it re-lights; temporal
  upscaling takes about 1 ms. The high tier has not been measured on a
  discrete GPU.
- **Clustered lighting** (many lamps per pixel on moving objects) is not
  part of this system; it is planned separately.
