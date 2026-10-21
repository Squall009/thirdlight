# Phase 40 — Ground cover at scale, and wind

Status: planned 2026-10-21.

Goal: dense ground cover (grass, and any other small mesh) is a standard tool
of the engine. It scales to large scenes and works on any surface, indoors and
out, not just as an outdoor special case. Wind is one engine system, set per
scene with local zones. The phase proves both with one target scene. Read
`docs/roadmap.md` (principles 1, 1b and 7) first.

## 1. Owner decisions (2026-10-21)

- **The target.**
  - A 1 × 1 km terrain with blended, textured layers, covered with
    geometry-grass fields that look like dense, tall, wind-moved blade grass
    over rolling hills. The owner's reference was a screenshot of a field in
    Zelda: Tears of the Kingdom.
  - It must **hold 60 fps at 1080p** on this host's Iris Xe, on both
    renderers: frame p95 ≤ 16.7 ms and no missed frames, **measured at the
    display's 60 Hz cap, never uncapped**. Uncapped runs throttle and give
    inconsistent frame rates.
- **Generic through and through.** The engine adds no art-style features:
  - no colour sheen;
  - no grass-like terrain shading;
  - no stylised tip gradients built into the engine.
  
  What makes it look good comes from content: the grass model, its material
  and the existing foliage shader with physically sensible values. For
  example, an accurate roughness on a blade already catches more light as it
  bends. Nothing hard-codes a look a future game would have to undo.
- **Ground cover is standard and scales.** It is not only for outdoor games.
  The current cover system works per copy on the CPU (the landscape class
  already spends about 11 ms of main thread, D212) and ends at
  `coverDistance`. It is replaced by a GPU-driven path.
- **Grass receives shadows but casts none.** Contact darkening at the roots
  comes from the existing SSAO pass, not from shadow casting.
- **Wind is one system.**
  - A global wind per scene, plus wind zones placed in the scene that
    override it locally and blend at their edges.
  - Wind is a world-space, top-down scrolling noise texture that the foliage
    shader samples to bend vertices. Changing the wind means changing its
    texture, scroll speed and direction, UV scale and strength.
- **The subject list bends foliage away.** This is the same per-view subject
  list as phase 39's see-through (players, units).
- **Stretch:**
  - ground-cover roots can take the colour of the surface under them, so the
    blades blend into the terrain;
  - it is an opt-in material setting, off by default, and kept only if it
    stays inside the budget.
- **The grass model and its LODs** are made in Blender (the art-factory
  pipeline). It is a game-ready asset: triangle budget met, LODs, no hidden
  geometry, compressed textures if any. Its triangles, LODs, texture sizes and
  file size are reported.

## 2. Design

### Ground cover

**One GPU-driven path for every cover rule.**

- The existing scatter rule data (`cover: true`, density, layer weights,
  scale and tilt ranges, models) stays the authoring model. Only the runtime
  path changes.
- **Placement on the GPU.**
  - The surface is split into patches (cells) in rings around each view.
  - Each patch draws its cover instances in one instanced draw per mesh LOD.
  - An instance's position, rotation, scale and density test are computed in
    the vertex shader from its instance index, a per-patch seed and the
    surface data.
  - No per-instance data lives on the CPU, and nothing per frame grows with
    the number of instances.
  - This is the same on WebGL 2 (no compute) and on WebGPU.
- **Surfaces.**
  - **Terrain:** read the heightfield and layer-weight textures the terrain
    already has on the GPU. This is fully procedural, with nothing stored, so
    it scales to any terrain size.
  - **Other surfaces** (block-layer tops, meshes, architecture floors —
    interiors included): the backend bakes a compact per-chunk point set (a
    quantised position, a normal and a weight) at the rule's maximum density.
    The GPU thins it by distance. The bake runs when the surface changes,
    never per frame.
- **Distance.**
  - Density thins continuously with distance (a per-instance random
    threshold, so there is no popping).
  - Mesh LODs switch by distance per patch ring.
  - Cover ends at the rule's distance, with no hard cap of its own (the
    current 1000 m `coverDistance` cap is revisited).
- **Culling.** Patches are frustum-culled on the CPU; there are a few hundred,
  not millions. Occlusion culling (phase 33) applies to patches where it is
  on.
- **Shadows.** A cover rule's `castShadows` defaults to false. Cover always
  receives shadows. Contact darkening comes from SSAO.

### Wind

- **One wind field.** The scene's environment has a global wind:
  - a noise texture asset;
  - direction and scroll speed;
  - UV scale (metres per tile);
  - strength;
  - a second octave (scale and speed ratio) so the pattern doesn't visibly
    repeat.
- **Wind zones.** A `windZone` component on an object:
  - a box or sphere shape;
  - overrides any of the global values;
  - a blend distance at its edge;
  - a priority.
- **How the zones reach the shaders.** They are combined into a small
  camera-centred wind map, a low-resolution texture covering the view's
  surroundings. It is updated only when zones or the camera's area change.
  Shaders sample it together with the noise. There is no per-zone uniform
  array, so there is no cap on zones.
- **Who reads the wind.** The foliage shader samples the wind for every
  foliage mesh: cover, scatter trees, placed models. Its bend scales with the
  vertex's bend weight (COLOR_0 R, as today) and the instance's height, so
  tall grass bends further than short grass. The current fixed sway of about
  0.1 m becomes a fallback for meshes with no weights.
- **Scripts:**
  - `ctx.environment.setWind({…}, {blend})` changes the global wind at
    runtime;
  - zones are ordinary objects (move, enable, disable).

### Bending away from subjects

The foliage shader pushes vertices away from each subject in the per-view
subject list (phase 39's array), within a radius and by a strength set on the
cover rule and the subject. It recovers over time through the same per-view
uniforms. There is no simulation and no per-instance state.

### The grass asset

Made in Blender through the art-factory pipeline (`blender-pipeline`):
- 2–3 clump variants of about 10–15 blades each;
- LOD0 about 40–80 triangles, LOD1 about 20, LOD2 about 6;
- wind weights in COLOR_0;
- no hidden geometry and no `_COL`, since cover doesn't collide;
- colour from a small texture or vertex colour.

The material uses the foliage shader with physically sensible roughness and
translucency. The asset ships as a template asset, not as engine art.

## 3. Items

**E2E budget (D253):** no new e2e file and no net added e2e time. Shader and
placement maths get vitest checks against CPU references. The editor surface
is one step in the terrain or scatter e2e.

| Item | What |
|---|---|
| 40.0 | **Release checks.** **Measure first:** a new perf class `meadow`: a 1 km² terrain with 4 blended layers and grass cover at the target density (on the current CPU cover path, as the baseline), plus a near/mid density sweep on the GPU. Run at the 60 Hz cap on both renderers. Record frame p95, GPU ms per pass, main thread, draws and triangles. This sets the density and LOD budgets the later items must meet. |
| 40.1 | **The grass asset** in Blender (the clump variants and LODs above), imported through the job export. Its report: triangles per LOD, texture sizes, file size. Looked at in the editor. |
| 40.2 | **GPU cover on terrain:** patch rings per view, procedural placement from the heightfield and layer weights, density thinning, per-ring LODs, frustum culling of patches, no shadow casting. The old CPU cover path is removed once this covers its cases; there are not two paths. |
| 40.3 | **GPU cover on other surfaces:** baked point sets per chunk for block layers, meshes and architecture, thinned on the GPU through the same renderer. An interior case (moss and debris on a block-built floor) is a test scene. |
| 40.4 | **Wind:** the global wind in the scene environment, `windZone` with blend and priority, the camera-centred wind map, the foliage shader reading it (bend by weight and height), `ctx.environment.setWind`, and the editor (environment panel, zone gizmo). Scatter trees and placed foliage models move with the same wind. |
| 40.5 | **Bending away from subjects** in the foliage shader from the per-view subject list, with radius and strength per rule and per subject. |
| 40.6 | **Editor:** cover rules on the GPU path in the terrain and block editors (density and layer weights painted as today), a live preview in the Scene view, wind zones placeable and shown, and a Scene view "wind preview" toggle. One step in an existing e2e. |
| 40.7 | **Stretch: roots take the surface colour** (opt-in material setting, off by default): each instance reads the surface colour at its root and blends the blade base toward it. Kept only if it stays in budget. |
| 40.8 | **Performance to target** on `meadow` at the 60 Hz cap, both renderers, 1080p, Iris Xe: frame p95 ≤ 16.7 ms and no missed frames. Main thread for cover ≤ 0.5 ms. Draws for cover ≤ 64. Every other perf class must not regress. |
| 40.9 | **The manual:** ground cover (rules, surfaces, density, distance, shadows), wind (global, zones, script), bending, the grass asset as an example, and the art-direction note (look comes from content). |
| 40.10 | **Acceptance.** In a real browser on both renderers at 1920×1080, at the cap: the 1 km² meadow with a player walking and running through grass, wind changing through a zone, the view from a hill to the far edge, and an interior with cover. Screenshots and a short capture to `~/.cache/thirdlight-phase40/acceptance`. Owner look pending; the owner judges the look. Full gate, then the phase review. |
| 40.11 | **Review fixes.** |

**Done when:**
- The meadow holds the 60 Hz cap at 1080p on both renderers.
- Cover works on terrain and on other surfaces through one GPU path.
- Wind is one system with a global value and blending zones.
- Grass bends away from subjects.
- No art-style feature is built into the engine.
- `tools/gate.sh full --both-renderers` is green.

## 4. Progress

| Item | Status |
|---|---|
| — | Not started. |

## 5. Decision log

- 2026-10-21: Planned from the owner's goal and choices: generic only (no
  sheen, no grass-like terrain shading), a world-space scrolling noise wind
  with a global value and local zones, no shadow casting with SSAO for
  contact, bending from the subject list, root colour as a stretch, and the
  frame rate measured at the cap.
