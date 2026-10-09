# Material graphs

Materials built as node graphs: templates, instances, the Material editor,
custom-lit surfaces, the node catalogue, exposed parameters (also set from
scripts), material functions, and trim sheets. Step by step:
[the material graph guide](../guides/material-graphs.md). Every node:
[Material graph](../reference/graph-material.md).

## Graph materials

A material can be built as a node graph. The project window
lists every material (`t:material`): Create → **Graph material** makes one
and opens it in the editor window as a **Material: <name>** tab — from the
submenu, an empty graph (a **PBR output**) or a
built-in template: *standard*, *foliage wind*, *world-aligned kit*, *unlit*
or *water* (the shader types as graphs, with their defaults), *river
(spline water)* (flow along a spline's water mesh, foam at its banks and in
the shallows, soft shores), or *height-blended layers (painted terrain)* — four layers from texture arrays,
weighted by vertex colours (a painted block layer's paint, or a mesh's own:
trim sheets blending clean → dirt → moss). Any shader
material's **Convert to graph** rebuilds it as a graph that looks the same:
its values and textures wired in, and for foliage, kit and water their wind,
UV period / macro normal and water values as public exposed parameters
(objects may override them). The pixel parity test draws every shader type
both ways on WebGL 2 and WebGPU and holds them to the renderer's parity rule.
Values a shader material leaves unset convert to what it draws with on a
box (three's standard material: roughness 1, emissive intensity 1, normal
scale 1); a material on a model also used the file's own values and
textures, which a graph does not contain. Double-click a graph material's
tile (or **Open graph**) to open its tab. The tab is the graph editor (every
gesture in [Graph editing](editor.md#graph-editing)) with the material catalogue; the Inspector on
the right edits the selected node (texture fields pick from the project's
textures, colours use a colour picker). **Remove graph** turns it back into
its shader material.

**Material instances**: select a material and press **+ new
instance** — an instance draws as its parent with the values you change in its
inspector (a shader material's parameters and texture slots, a graph
material's parameters; unset rows show the parent's value, ↺ goes back to it).
It is a material like any other: pick it for an object, as a model asset's
default materials (every placement), or in a block type's `materials`; an
instance may have instances. The game ships each used instance already
resolved. MCP: `setMaterial {material: {…, instanceOf, values?}}`.

**The Material editor**: the editor window's **preview pane**
(above the Inspector) shows the material live on a *sphere*, *plane*, *cube*
or a *model* of the project, in the active scene's look (sky, image-based light, fog, tone
mapping and post; a neutral backdrop when the project has none), drawn on
the editor's renderer and compiled exactly as the Scene view and the game do
(drag to orbit; the line under it names the backend and counts compile
errors); the editor shows the **exposed parameters** and the graph. A
problem shows as a badge on its node (the graph's rules and the compiler's:
a missing texture, function or parameter, a sampling node without a
texture, a pixel-only input in a vertex offset) and in the bottom dock's
**Problems** tab ("material error"/"material warning"; a click opens the
material's tab at the node).

**Rendering.** The Scene view, Play and exports compile a
graph material's graph to a three.js node material (TSL) in the browser, on
WebGPU and on WebGL 2 alike — nothing generated is stored; the export
carries the graph (and the material functions it calls) in its manifest,
without comments and groups. A PBR output becomes a standard node material
(base colour, metalness, roughness, a tangent-space normal, emissive, AO,
opacity, alpha clip), an Unlit output a basic one, a Vertex offset moves
the vertices; *Double-sided*, *Transparent* and *Casts shadows* are the
output's fields (an object whose material casts no shadow casts none,
whatever its own flag says, while it wears it). A graph material uses only
what its graph contains: the model file's own material and textures are not
used (the `shader`/`params`/`textures` part comes back with **Remove
graph**). Moving a node or editing a comment never recompiles; editing the
graph, a parameter or a called function does. An object's value for a
public parameter is drawn for that object only (one shared material, the
value read per object); a texture parameter an object overrides gets its own
compiled copy. Problems found while compiling (a missing texture, a pixel-
only input such as Screen UV used in a Vertex offset, which reads a fixed
stand-in there) show on the node. Selected objects and look overrides
(`ctx.look`) still glow (the object's own emissive is added to the graph's).

**Custom-lit surfaces**: a **Custom-lit output** takes a
colour the graph computes itself (plus emissive, a tangent-space normal,
opacity and alpha clip) — cel bands, painterly, hatching — and still gets
fog, tone mapping and the post stack. Under it the *Lighting* inputs read
the scene's lights: **Main light** (the brightest shadow-casting
directional light, else the first: direction to it in world space, colour ×
intensity, N·L from −1 to 1 — step or posterize it for bands), **Shadow**
(the main light's shadow on the pixel, 0 shadowed … 1 lit), **Diffuse
light** (total — every directional, point and spot light with its N·L,
shadow and falloff, plus ambient, environment and lightmap —, its
luminance, and the direct part alone) and **Ambient light** (ambient,
hemisphere and light probes; the environment's image-based light; a baked
lightmap's light). Every light value is on the diffuse scale: a colour ×
a light value is what a matte surface of that colour shows (the PBR
output's diffuse), so a point light near a custom-lit object brightens it
exactly as it would a standard one. A lightmapped custom-lit object adds its
lightmap to the total. Used under a PBR or Unlit output (which light
themselves) the Lighting inputs read no light and show a compile error on
the node; in a vertex offset a warning; a Custom-lit normal cannot read
them. The Material editor's preview, the Scene view, Play and exports draw
custom-lit graphs with their lights.

**The catalogue** (generic, any genre): *Inputs* — Float, Vector 2/3/4,
Colour, Parameter, Time, UV (set 0/1), Vertex colour (set COLOR_0 or
COLOR_1; a mesh without it reads white, zero with alpha 1 — for vertex
colours used as data — or `first`, all weight on the first channel — for
layer weights), Position and Normal (object/world/view), View
direction, Object position (the object's or instance's origin in the
world), Camera distance, Screen UV, Instance index, Global wind (direction,
strength with gusts travelling across the world, turbulence), Scene wetness
(the active scene's look's `wetness`, 0–1, as presets blend it); *Lighting*
— Main light, Shadow, Diffuse light, Ambient light (Custom-lit only, see
above); *Maths* — add, subtract, multiply, divide, min, max,
power, dot, cross, normalize, length, lerp, clamp, saturate, smoothstep,
step, abs, floor, fraction, sin, cos, one minus, remap, Weighted mix (four
values by four weights); *Vectors* — split,
combine, swizzle (mask `xyzw`/`rgba`); *Textures* — Sample texture (wrap,
filter, colour space; a texture array's layer), Normal map, Triplanar, Height
blend (up to four layers' weights shaped by their height maps — the
higher layer shows through where they meet; depth sets how soft), Flipbook, Noise (value,
gradient, Voronoi), Gradient (linear/radial/angular), Colour ramp, Sample data (a data parameter's cell);
*Utility* — Fresnel, Rim, Posterize, Dither, World-aligned UV, Parallax,
Vertex displacement, Alpha clip; *Functions* — Function call; *Output* —
PBR output (base colour, metalness, roughness, normal, emissive, AO,
opacity, alpha clip), Unlit output or Custom-lit output (colour, emissive,
normal, opacity, alpha clip) — one of them per material —, Vertex
offset; the render flags (double-sided, transparent, casts shadows) are
fields of the surface output. Port types are float, vec2, vec3, vec4,
texture and data (a data parameter, which feeds only Sample data); every value width converts to every other (a float fills every
component, a wider vector keeps its first components, a narrower one is
padded with 0 and w = 1 — shown dashed on the wire); a texture only feeds a
texture input. Maths nodes have a **Type** field, `auto` by default: they
take the widest width among their wires (a texture's rgb × a colour is a
vec3). Every input has a default (a constant, or the mesh's UV, position,
normal, view direction, screen position or time), so nothing is left
undefined. Rules (a refused edit changes nothing): known node types and
fields, compatible port types, no cycles, at most 512 nodes, one surface
output, one vertex offset.

**Exposed parameters** (left of the graph): key, type (float, vec2–4,
colour, texture, data), default, range, visibility (public/private, like script
properties). A **Parameter** node reads one (its type is the parameter's).
Objects override the **public** ones: select an object that uses the
material (its own material mapping or its model's default one) — the
Inspector's **Materials** section lists each graph material's public
parameters; a value set there is stored on the object (the
`materialParams` component) and ↺ goes back to the material's value.

**Material parameters from scripts**: while the game runs a
script sets a graph material's public parameters **per object** —
`ctx.materials.set(entityId, 'tint', '#ff4000')` (a number, 2–4 numbers,
`"#rrggbb"`, or a texture asset id that travels with the game — referenced
by a material, an object override or a script property), `get`, and
`reset(entityId, param?)` back to the object's authored value. Other objects
wearing the material keep theirs: the material stays one shared compiled
material and the value is read per drawn object (no recompile; a texture
value takes the texture-override path, a compiled copy). The call applies
to every graph material of the object that declares the key (or to one:
the optional last argument `materialId`). A **data** parameter is a small
grid of RGBA cells (its **size**, up to 64 × 64 — the engine limit — and a
default: the bytes every cell starts with): scripts write cells or
rectangles per object with `ctx.materials.setData(entityId, 'cells', x, y,
w, h, bytes)` (w × h × 4 values 0–255, row by row; `getData` reads a cell)
and the **Sample data** node reads one cell — at a UV (cell [0, 0] at UV
(0, 0), no filtering) or at integer cell coordinates — so one mesh can show
per-cell state without an object per cell. Values are part of the
simulation (deterministic, in replays and the step digest, identical in the
simulation worker and the page), go to the renderer only when they change
(a data grid uploads once per change) and start from the authored values at
every new run. At most 4,096 writes per step; a refused call returns
`false`. The visual-script nodes are under **Materials** (Set material
parameter, Material parameter, Reset material parameter, Write material
data, Material data cell).

**Material functions** (reusable sub-graphs) are standalone graphs of kind
**Material function** (project window: Create → **Graph** → **Material function**). Their
**Function input** (name, type, default) and **Function output** (name,
type) nodes become the ports of every **Function call** node (field
*Function* = the function's graph id; a new call runs the first function).
Functions may call functions, but never in a cycle; a function cannot drop a
port a material wires, and a used function cannot be deleted.

MCP: `setMaterial` takes `graph` and `parameters`; `graphEdit {owner:
{kind: "material", id: materialId}, ops}` edits the graph (one undo);
`setComponent "materialParams" {<materialId>: {<key>: value}}` sets
overrides; functions are `setGraph` with kind `material-function`. The
catalogues are in `tl_content_query target="game" includeDescriptors`
(`graphKinds.material`, `graphKinds["material-function"]`) and in the
reference ([Material graph](../reference/graph-material.md),
[Material function](../reference/graph-material-function.md)).

## Trim sheets

A **trim sheet** is one 2D texture set — albedo, normal and ORM, three reads
a pixel — whose rows are strips that tile along u (floors, wall bands,
baseboards, crowns, frames, columns, bevels). Generated architecture draws
every row as its own strip of geometry, so one sheet restyles a whole level
for a fraction of a texture array's memory, and rows may differ in height.
Create → **Trim sheet material** makes one (shader type `trim`) in the
engine's starter layout; its Inspector has the usual values and textures and
the **Trim sheet** table:

- the sheet's size (pixels), texel density (pixels per metre along a strip)
  and **padding** (pixels above and below every row that repeat its edge —
  the Texture Designer's gutter, 8 px by default);
- one line per row: its **slot** (`floor`, `lower_wall`, `upper_wall`,
  `baseboard`, `crown`, `frame`, `column`, `bevel`, `emissive` in the starter
  layout; any id), its pixel bounds **top**/**bottom** from the image's top
  (rows equal by default, any heights allowed, never overlapping), its own
  density (empty: the sheet's) and **tiles v** (its padding continues its
  wrap); the row's height in metres and the deepest mip level it reads
  cleanly are shown;
- **Equal rows** splits the sheet again (bands aligned to the padding's
  power of two), **Import layout.json** reads a Texture Designer trim
  export's table (strip layers become rows; decal cells are left out and
  named), **Check padding** compares the albedo's padding pixels with each
  row's edge on the backend (a PNG as imported, a KTX2's lossless original,
  else the KTX2 transcoded with a looser tolerance) and says which row and
  side differ. A table the model refuses is not saved; warnings (no or thin
  padding, a shallow safe mip level, a size that is not a power of two,
  missing starter slots) are listed under it.

Any sheet with the slots a generator asks for swaps in for another.
Bleeding is handled three ways: the padding, a half-texel inset of v at the
row's edges (the generator's coordinates), and the material, which caps
each read's footprint at the sheet's safe mip level (distant trims alias a
little rather than read their neighbours; more padding raises the cap) and
interpolates the coordinates at the centroid (a far strip covering part of a
multisampled pixel never reads past its row). Textures are sampled without
anisotropy.

The mesh's COLOR_0 is data: **R occlusion** (0 open), **G grime**, **B
wetness** (a mesh without it is clean and dry). The material blends them
with no texture read of its own: grime takes the **grimeColor** and roughens
(crevices of the ORM's occlusion first; **grime** scales it), wetness — the
vertex's or the material's **wetness**, the larger, plus the scene's —
darkens the albedo ×0.55, smooths toward roughness 0.1 and flattens the
normal map (**wetFlatten**), occlusion darkens the indirect light
(**occlusion** strength). **roughness**/**metalness** scale the ORM's (1:
the sheet's own). No lightmaps: probes and the generator's vertex occlusion
light it. Generated meshes on a block layer take the layer's wall paint
([Blocks](blocks.md)) at their vertices each time they are made (grime from the third
paint layer by default, the painted wetness), so paint survives
regeneration.

Cost (`node tools/perf/run.mjs trim`, one mesh of strips filling ~85 % of a
1920 × 1080 view on the Iris Xe): WebGPU scene pass 2.76 ms against 2.51 ms
for the standard material with the same three textures (+0.25 ms, +10 %);
WebGL 2 4.33 against 4.18 ms per frame (no pass timings there).

MCP: `setMaterial {material: {shader: "trim", textures: {map, normalMap,
ormMap}, trim: {size, texelDensity, padding, rows: [{slot, top, bottom,
texelDensity?, tileV?}]}}}`; `POST …/content/textures/trim-check {texture,
trim}` is the padding check.
