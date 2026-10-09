# Lighting

How to light and bake a scene step by step: [the lighting guide](../guides/lighting.md). Quality levels, ambient occlusion and render scale are described with the other render settings in [Deployment: Test and debug entry points](../../deployment.md#test-and-debug-entry-points-phase-238).

## Baked lighting

The Lighting window (Window → Lighting, floating over the Scene view; it
names the scene it edits and its picker makes another scene active) bakes
lightmaps for the active scene's static objects
(Inspector → Static; boxes, and models with a second UV set) from the lights
set to **baked** (direct + bounce; no longer realtime once baked) or
**mixed** (realtime direct light, baked bounce light). The atlases become
texture assets named `lightmap <scene> <n>`; a re-bake adds versions to them.

- **Bake preview** runs in the browser: direct light and sky occlusion from
  baked lights, no bounce. Seconds for a small scene.
- **Bake final** sends the scene to Blender Cycles on the bake host:
  `THIRDLIGHT_BAKE_HOST` is `user@host` (the backend copies the scene there
  with `scp` and runs Blender over `ssh`, so the service user needs a key
  login without a passphrase) or `local`; `THIRDLIGHT_BAKE_BLENDER` is Blender
  on that host; `THIRDLIGHT_BAKE_TIMEOUT_MINUTES` stops a bake (default 60).
  Cycles uses OptiX when the GPU has 4 GB free, else the CPU; the result is
  denoised. One bake runs at a time. Without a bake host the button explains
  what to set. Setting the bake host up is part of running the server
  ([Deployment](../../deployment.md)).

A bake whose static objects or baked/mixed lights changed since is shown as
stale; it is still used until it is baked again or cleared (Clear bake). A
scene with a bake cannot be deleted until the bake is cleared. MCP can clear
a bake (`setLighting {sceneId, lighting: null}`); bakes are made in an
editor (the headless one works too).

### Probe grids

**Bake probes** (Lighting window, next to the lightmap buttons) bakes the
active scene's light probes: points on a grid that hold the indirect light
(the sky, and the baked/mixed lights' light bounced off the static objects)
for 3D objects to sample. Without a **Probe volume** component in the scene
the probes cover its static objects' bounds (and half a spacing above);
with probe volumes (GameObject → Light → Probe volume: a box, its size and
an optional spacing of its own, axis-aligned in the world) they cover those
boxes instead.

- **Settings** (the window's settings): `probe spacing` — metres between
  probes horizontally, default 2 (0.25–32); in the lowest 2 spacings of each
  box (the ground band) probes are twice as dense vertically. `probe
  bounces` — extra bounce passes, default 2 (0–8). The scene's next bake
  starts from its last bake's settings.
- Large boxes are split into tiles of at most 64 probe intervals per axis;
  there is no cap on the number of probes or tiles. The window reports the
  probes, tiles, GPU memory (8 bytes × 6 per probe and padding) and file
  size of each bake; each tile is a texture asset named `probes <scene>
  <n>` (a 16-bit PNG of half floats; a re-bake adds versions). Files baked
  before the probes held walls (an older layout) no longer load: bake again.
- Probes inside geometry (seeing back faces in more than a quarter of their
  directions) are moved out by a quarter or half a spacing, or filled from
  their neighbours, so no light comes from inside walls. The bake also
  records **walls**: where a surface lies between two neighbouring probes
  (each sees it before the other), and where.
- The bake runs on the Scene view's renderer and needs **WebGPU**; on WebGL 2
  the button is off and the window says so. Baked probes load on both
  renderers (Play, export, the Scene view). Measured on this host (Iris Xe):
  the village perf class (8,712 probes) bakes in ~110 s, a 128 × 128 m block
  ground (38,025 probes) in ~135 s.

**Clear probes** removes them (Clear bake removes only the lightmaps).
Probes show stale like lightmaps (a stale bake is still used); turning an
image sky (`sky.rotation`) after the bake makes them stale too (the bake
records the turn it saw as `probes.skyRotation`). Lightmaps do not see the
sky's image and stay as they are.

**How the probes light the scene.** Every lit 3D object — models, boxes,
graph and kit materials, foliage and water, instance sets, block chunks,
skinned characters, moving or not — takes its indirect light per pixel from
the probes around it, in place of the flat ambient light, wherever it is
inside a tile; outside every tile the flat ambient light stays (the probes
fade out over one spacing past a tile's edge). What the probes replace: the
sky's image-based diffuse light and the ambient and hemisphere lights whose
mode is `baked` or `mixed` (the bake holds them); `realtime` ambient and
hemisphere lights are added on top, and direct light (sun, point,
spot, effect lights) is unchanged. The sky's reflections are darkened where
the probes are darker than the light they replace (a closed room does not
mirror the sky). Lightmapped surfaces keep their lightmap and ignore the
probes.

- A pixel samples the probes half a spacing off its surface, but never
  across a wall the bake found: an inside wall, floor or object standing by
  a closed wall reads only the probes on its own side, so sunlight outside
  does not leak in. Probes moved out of geometry count half, filled ones
  hardly at all.
- The probes hold first-order light (soft directional indirect light; four
  texture reads a pixel). Where tiles meet, the first tile of the scene
  holds the shared face (both hold the same probes there).
- **Large worlds stream their probes.** Only the tiles nearest the camera
  are loaded and on the GPU, as many as the probe memory budget holds
  (128 MB, `PROBE_RESIDENT_BYTES`; the tiles of every loaded scene compete
  by distance, never by scene order); surfaces beyond them get the flat
  ambient light, fading over one spacing past the last resident tile. As the
  camera moves, tiles ahead load and tiles behind are dropped: an arriving
  tile is uploaded into its own place of the shared texture and nothing else
  is touched. When the budget leaves tiles out the Problems list says so
  once (`probe_budget`; a tile that cannot be read: `probe_load`). Play
  diagnostics `renderer.probes`: `tiles` (of the loaded scenes), `resident`,
  `beyondBudget`, `loaded`, `budgetBytes`, `textureBytes` (the textures as
  allocated), `indexCells`/`indexEntries` (the lookup grid), `uploads` /
  `uploadedBytes`, `unplaced` (0 unless the texture's 2,048-texel edge is
  reached). Measured on this host's Iris Xe at 1920 × 1080: a synthetic
  2 km × 2 km world (512 tiles, 14 million probes, 663 MB if all were on the
  GPU) keeps 98 tiles resident in 128 MB, has them on the GPU 2.8 s after
  the page opened, and costs WebGPU 1.6 ms a frame over no probes (every
  pixel probe-lit); a tile's arrival costs the main thread 20–30 ms
  (34,000 probes: undoing the PNG row filters and packing; the file
  inflates natively, off the JavaScript thread).
- Light layers: the probes light every layer (they are indirect light).
- A light with mode `baked` that a lightmap bake holds is off for moving
  objects too: they get its bounce from the probes, not its direct light;
  `mixed` lights stay realtime for direct light and their bounce is in the
  probes.
- Cost, measured on this host's Iris Xe at 1920 × 1080 (village perf class,
  two tiles): about +0.8 ms GPU in the scene pass on WebGPU (2.7 → 3.5 ms;
  frame p50 6.2 → 7.0 ms), within noise on WebGL 2. A scene without baked
  probes builds exactly the shaders it built before (no cost).
- `?probes=off` on a game page draws without the probes (a diagnostic
  comparison, like `?shadowcache=off`).
- **Gizmos → Light probes** in the Scene view draws every probe as a small
  sphere lit by its own light; probes moved out of geometry have a yellow
  rim, filled ones a red rim, and both are drawn through the geometry they
  sit in.

## Light layers

Which lights light an object and whose shadows it casts (Godot's light cull
mask and shadow caster mask, Unity's rendering layers). There are 8 layers
(`LIGHT_LAYER_COUNT`, project-model `light-layers.ts`); every mask is a bit
mask, bit n = layer n + 1, 255 = every layer.

- **Objects** — a box, model, instance set or block layer has **Light
  layers** in the Inspector (`lightLayers`, 1–255; absent: every layer): the
  layers it is in. An object is in at least one layer.
- **Lights** — every light has a **Light mask** (`lightMask`, 0–255): it
  lights an object only when they share a layer; a directional, point or
  spot light also has a **Shadow caster mask** (`shadowCasterMask`, 0–255):
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

## Local lights per pixel or per vertex

How point, spot and effect lights reach an object (Unity's "Not Important"
lights, Godot's vertex shading). The sun, ambient light and probes are
always per pixel.

- **Objects** — a box, model or instance set has **Local lights** in the
  Inspector (`localLights`): **Per pixel** (highlights and
  shadows), **Per vertex** (the lights are evaluated at the mesh's vertices
  and interpolated: diffuse light only, no highlights or shadows) or
  **None** (no local light at all). "—" (absent) follows the material, else
  the default: per pixel for everything, instance sets included
  (`INSTANCES_LOCAL_LIGHTS_DEFAULT`, project-model `local-lights.ts`).
- **Materials** — standard, foliage and kit materials have a **Local lights**
  parameter (`object` follows the object), graph materials a **Local lights**
  field on their PBR and Custom-lit outputs. An object's own mode wins.
- **Lights** — a point or spot light has an **Importance**: **Auto** (as each
  object says), **Per pixel** (always, a hero light) or **Per vertex**
  (always, a cheap fill light). A spot light with a cookie stays per pixel.
  An effect's *Lights* block has the same **Importance**.
- Per-vertex light joins a surface's ambient light (Custom-lit graphs read it
  in their Ambient input), so ambient occlusion darkens it as it darkens the
  ambient light (Unity's built-in pipeline does the same with its vertex
  lights); per-pixel lamps are direct light and are not darkened. Light
  layers and flicker (a script's or effect's changing intensity) work as per
  pixel. A transparent double-sided surface is lit per vertex from the side
  each of its two passes shows. The probe bake ignores every object's and
  material's mode: a lamp's bounce off a surface set to **None** still
  reaches the probes.
- **When it pays** — per vertex costs per vertex instead of per pixel, so it
  is cheaper where a mesh has fewer vertices than the pixels it covers: big,
  coarse or close geometry (a grass field at your feet, large leaves, low-poly
  props in a torch-lit room). Dense scatter far from the camera has about as
  many vertices as pixels. Measured on this host's Iris Xe at 1920 × 1080:
  the village perf class with 12 lamps over its scatter
  (`node tools/perf/run.mjs village --point-lights 12 --switches
  vertexLights=off`) drew its scene pass in 6.88 ms with the scatter per
  vertex and 6.78 ms per pixel (frame 8.6 ms either way), so instance sets
  stay per pixel unless a set or its material asks.
- **Cost of the feature** — none unless used: the default draws the same
  shaders as without it (village: 52 shader modules and 34 pipelines). Each mode
  in use adds one program per material it is used with (light layers add
  none on top). Changing a light's importance rebuilds the lit shaders once.
- `?vertexLights=off` on a game page shades every local light per pixel (a
  diagnostic comparison, like `?probes=off`).
