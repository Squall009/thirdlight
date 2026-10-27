# Lighting

How to light and bake a scene step by step: [the lighting guide](../guides/lighting.md). Quality levels, ambient occlusion and render scale are described with the other render settings in [Testing, debugging and quality settings](debugging.md#ambient-occlusion-render-scale-and-dynamic-resolution).

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

- **What is saved** — the static surfaces' light (block layers and
  generated buildings; static models only where their distance-field files
  are loaded, which the editor's Scene view does not do yet, so a bake saves
  no model's light and models keep their per-pixel lights and the probes)
  and the probes (each room's grid and the bricks). The lights' modes decide what: a `baked` light's direct
  light and its bounce, a `mixed` light's bounce (its direct light stays per
  pixel, with its shadows), a `realtime` light nothing. The bake first lets
  the baked and mixed lights light the cache and the probes until both
  settle, then holds the probes and lets only the baked lights' direct light
  settle in the cache. Terrain and static boxes are not saved: terrain keeps
  its per-pixel lights and the saved probes over it, as before.
- **How fine** — every tile at one level, the finest whose pages fit 32 MiB
  (`SAVED_SURFACE_CACHE_MIB`, the low quality level's whole cache budget):
  10 cm texels for a small scene, coarser for a large one, so a low-tier
  device holds a scene's saved light whole.
- **Files** — the saved file (the cache's tiles and pages as RGBA half
  floats, the probes' tiles as the probe lighting holds them) travels as
  texture assets named `lighting <scene>` (16-bit PNGs used as byte
  containers, up to 4,096 rows of 8 KiB each; a large scene takes several);
  a re-bake adds versions to them. The scene's bake records them
  (`lighting[sceneId].surface`: `files`, `level`, `tiles`, `pages`,
  `probes`, `bytes`, `millis` — the run's time — and the hashes).
- **Who draws it** — WebGL 2, a quality level without a live budget
  (`surfaceLightMs` 0, the engine's low) and a live light still starting
  draw the saved light: each tile where the bake put it (a tile whose
  geometry changed since keeps its per-pixel lights), read by the same
  lookup and material variants as the live light, its light added to the
  per-pixel lights of mixed and realtime lights; the saved probes go to the
  probe lighting as live ones do. WebGPU at medium and high lights live (it
  draws the saved light until its live light starts). Baked lights are not
  drawn per pixel while a bake is used.
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

Measured on this host (Iris Xe, WebGPU, 1920 × 1080): see the plan's 42.10
row (`docs/plan-phase-42.md`) for the bake times and saved sizes of the
village and the look-reference scenes.

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
- **Gizmos → Light probes** in the Scene view draws every probe as a small
  sphere lit by its own light; probes moved out of geometry have a yellow
  rim, filled ones a red rim.
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
  light highlights. The lightmap bake does not take area lights.
- **No per-pixel budget** — area lights, like baked point and spot lights,
  are not counted in the scene's 16 realtime point and spot lights.

## The surface cache's live light

On WebGPU at medium and high quality (`surfaceLightMs` above 0 in the
quality level), the static surfaces' light is computed on the GPU into the
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
  stand inside geometry is left out (one just under the ground is moved up
  onto it), and a brick's probe standing in a room is left to the room's
  own grid. When the static scene changes (a block dug, a chunk streamed
  in) the probes are placed again within about a second, a little each
  frame, and the ones that kept their place keep their light. Each stale probe casts rays that read the
  cache's light where they hit, the probes' own light there and the sky
  where they hit nothing, so bounces build up over a few updates. Every lit material — moving objects, foliage and ground cover
  too — reads them through the usual probe lighting, in place of baked
  probes while the light is live. A bounce takes the colour of the surface
  it leaves: the surfaces that read the cache write their own colour beside
  it (one frame in 30, at half the cache's resolution, a quarter on
  terrain); where no material has drawn yet, it bounces as albedo 0.3.
- **Rooms and portals** — a point, spot or area light standing in a room of
  generated architecture lights only that room and the rooms its open
  doorways join to it; a shut door (a door piece across the doorway) holds
  its light in, though the door piece itself does not stop rays. A probe in
  a room sees out only through open doorways, no probe sees through a shut
  one, and a lamp switched in a room marks only its room and what it sees
  through its doorways. Interiors of blocks or models keep the probes'
  walls instead.
- **Light modes** — live, every light lights the cache whatever its mode.
  What "Bake lighting" saves follows the mode (see [Baked
  lighting](#baked-lighting)): a `baked` light's direct light and its
  bounce, a `mixed` light's bounce only, a `realtime` light nothing.
- **What surfaces draw** — block layers, terrain and generated buildings
  read their diffuse light from the cache: one filtered lookup a pixel,
  found from where the pixel is and which way it faces. Static models (in
  a built game, where their distance-field files are) read it too: a model
  with a second UV set (UV1) at its UV1, filtered; any other at the surfel
  nearest the pixel (one value per surfel, so the light steps at the
  model's surfel spacing). A model placed whole with several top-level
  pieces reads its first piece's light only. The cache gives the
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
- **What it is not yet** — WebGL 2 and the low tier compute nothing live
  (they draw the saved light, [Baked lighting](#baked-lighting)). Static boxes do not block the cache's light
  (only blocks, terrain, generated buildings and static models do).
- **Looking at it** — add `?surfaceCacheView=1` to a game page's address to
  draw every lit cache texel as a small square on its surface, shaded as a
  mid-grey surface would be by its light and its probes' bounce;
  `?probesView=1` draws the live probes, each a small sphere lit by its own
  light.

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

- **Setting** — the quality level's `contactShadows` (absent: on; the
  engine's low level has none, medium and high have them). They are drawn
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
  `high` (absent: medium; the engine's low, medium and high take off,
  medium and high; high marches more steps and casts more traced rays). As
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
- The probe bake ignores every object's and material's mode: a lamp's bounce
  off a surface set to **None** still reaches the probes.
- **Cost** — none unless used: the default draws the same shaders as without
  it. **None** adds one program per material it is used with (light layers
  add none on top).
- **No per-vertex lights.** Shading local lights at the vertices was measured
  no cheaper than per pixel (Iris Xe, 1080p, scene pass: the village perf
  class 2.718 vs 2.705 ms, with 12 lamps over its scatter 6.88 vs 6.78 ms)
  while it cost shader variants, so the engine does not offer it. A project that stored `localLights:
  "vertex"` (or a light's or a *Lights* block's `importance`) opens with
  them per pixel and one Problems line counting them.
