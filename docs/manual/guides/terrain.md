# Build terrain

**Goal:** a landscape: a heightfield you sculpt, ground materials laid by
rules, trees or rocks scattered by rules, a road that flattens and paints
its way across, and a block-built courtyard the ground meets without a
seam. Every field and edge case is in [Terrain](../features/terrain.md) and
[Blocks on terrain](../features/blocks.md#blocks-on-terrain).

Use a terrain for open ground that reaches the horizon; use a
[block layer](block-layers.md) for built structure (see
[which tool](which-tool.md)).

## Make the terrain

**Editor:** **GameObject → Terrain** makes 2 × 2 tiles of 257 samples a
metre apart, heights −128 to 384 m (one command: one undo takes it away),
and opens it in the **terrain editor**: a full-screen editor on the Scene
view that shows only the terrain. Its rail on the left holds the modes
(**Sculpt**, **Paint**, **Holes**, **Material rules**, **Scatter**,
**Stack**, **Tiles**, **Settings**; Shift+1 … Shift+8), the column on the
right the mode's tools (a letter key on each tool's tile picks it), and the
line at the bottom the tool, what to do and the keys. **Context** (C) shows
the rest of the scene around it (it cannot be picked). The sky, fog and
lights are no objects: they draw and light the terrain as in the scene, and
the terrain's own icon is not drawn while you edit it. Entering looks
obliquely at the middle of the terrain, about 64 m of ground across (near
enough to see its textures), unless the view already looks at the terrain
(then it stays); **Home** frames the whole terrain, **Done**
(Esc) goes back. A project without a sky shows the editor's dark backdrop
above the horizon: give the scene a sky in its look ([**Window → Environment**](environment.md)). Later, double-click the terrain in the
Hierarchy or the Scene view, or press **Edit terrain** in its Inspector (the
Inspector keeps only the terrain's plain fields). Play sets the editor aside
and comes back to it.

**API:** [`createEntity`](../reference/ops-detail.md#op-createEntity) with a
[`terrain`](../reference/components-rendering-1.md#component-terrain)
component naming its tiles (a tile without data is flat at 0 m):

```json
{"sceneId": "scene-main", "kind": "group", "name": "Land", "transform": {"position": [-64, 0, -64]},
 "components": {"terrain": {"tileSamples": 129, "spacing": 1, "heightRange": [-64, 192], "tiles": [{"x": 0, "z": 0}]}}}
```

The object's position is the corner of tile `[0, 0]`; its rotation and
scale are not used.

## Give it a material

**Editor:** in the **Paint** mode, **Set up material** makes a material
from the height-blended layers template and gives it to the terrain (one
undo step); its layers start tiled every 4 m (change it per layer in
**Layer settings…**). Click a layer tile (or **Add layer**) and pick its texture in
the **texture browser** — the project's textures as pictures, with a search
— or drop a texture on the tile. A colour texture brings its normal map and
ORM along when the project has textures named alike (`rock_albedo` →
`rock_normal`, `rock_orm`; `tl34_grass_albedo` → `tl34_grass_normal`). A
layer without a normal map is drawn flat, without an ORM map unoccluded,
fairly rough and not metal. The backend joins a layer list's textures into
one array once (seconds for PNG textures; KTX2 textures join at once);
meanwhile the terrain keeps drawing the textures it had. **Layer settings…** shows the picked layer's
three textures (colour with height, normal map, ORM), its name, tiling and
blend settings.

**API:** [`setMaterial`](../reference/ops-detail.md#op-setMaterial) with
`assign: {entityId}` makes a material and gives it to the terrain in one
command; its `albedoHeight`, `normals` and `orm` parameters take one texture
id per layer.

## Sculpt

**Editor:** in the **Sculpt** mode pick **Raise** (Q), **Lower** (W),
**Smooth** (E), **Flatten** (R), **Noise** (T) or **Ramp** (Y), set the brush
(**Height step**: metres one dab at full strength moves the ground; **Size**
across, **Strength**, **Falloff**, **Spacing**, and a **Noise mask** to break
the edit up) and drag on the ground. `[` / `]` change the size, `Shift+[` /
`Shift+]` the strength, **F** then a drag resizes on the ground (Shift+F:
strength; a click keeps it, Esc puts it back), Ctrl held lowers for one
stroke and **X** switches raise and lower. Each tool remembers its own brush
in this browser; every setting and key is on one page:
[Brushes](brushes.md). A stroke is previewed on the GPU while you drag and stored
as one command when you release.

**API:** [`editTerrain`](../reference/ops-detail.md#op-editTerrain)
([`EditTerrainArgs`](../reference/types-d-p.md#type-edit-terrain-args)),
points in world metres:

```json
{"entityId": "<terrain>", "kind": "raise", "dabs": [[-30, -30], [-25, -28]], "radius": 12, "strength": 6, "falloff": "smooth"}
```

The answer's `terrain` lists the tiles written and the samples changed.
Every brush kind but ramp takes a `mask` (`{scale, contrast, threshold,
octaves, seed}`: noise anchored to the terrain, seamless across tiles and
strokes) and, with `falloff: "curve"`, a `hardness`.

## Paint and holes

**Editor:** the **Paint** mode's tools are **Paint** (B) and **Erase** (X:
takes hand paint off, so the rules' layers show again); pick the layer from
the palette by its picture or its number key (1–9). **Opacity** is the most
one stroke paints however long you drag; **Paint through noise** breaks the
paint up with the noise mask. The **Holes** mode cuts holes (**Cut**, B) and
closes them (**Fill**, X).

**API:** `editTerrain` kind `paint {dabs, radius, strength, layer, erase?,
opacity?, mask?}` and kind `holes {dabs, radius, erase?}`.

## Rule materials

**Editor:** the **Material rules** mode: each rule is a card — its name, the
layer it paints (picked from the palette by its picture), its conditions as
range sliders (slope, height, cavity, noise, "only where" another layer's
share holds), each with its softness. Drag a card's grip to reorder (later
rules paint over earlier ones). While you edit, the terrain shows the rules
as they would bake (**Live preview of the bake**); **Only the open rule**
shows where that rule applies. **Bake rules** stores and bakes them in one
command; **Revert to last bake** throws the edits away. Hand paint stays
over the rules.

**API:** `editTerrain` kind `bake` sets and bakes the rules in one command
([`SurfaceRule`](../reference/types-p-u.md#type-surface-rule)):

```json
{"entityId": "<terrain>", "kind": "bake", "rules": [
  {"name": "Rock on slopes", "layer": 1, "slope": {"min": 20, "fade": 5}},
  {"layer": 2, "height": {"min": 4, "fade": 1}}]}
```

Where no rule applies the ground is layer 0. Later sculpting bakes the
rules again where it moved the ground.

## Rule scatter and ground cover

**Editor:** the **Scatter** mode: each rule is a card with every field it
has — the model, density, spacing, random scale, turn, lean and sink, a
seed; where (the material rules' conditions, the layers the ground must
show, picked by their pictures, regions kept clear); drawing (shadows, a
blob shadow, ground cover or colliders, far copies as impostors, thinning
far copies, the chunk size). **Bake rules** bakes the copies. **Scatter by
hand** places the chosen rule's copies under the brush (**Place**, B) or
takes them off (**Take off**, X, or Ctrl held); hand edits survive every
bake. A rule marked as ground cover is never stored: it is made round the
camera while the game runs.

**API:** `editTerrain` kind `bake` with `scatter`
([`ScatterRule`](../reference/types-p-u.md#type-scatter-rule)):

```json
{"entityId": "<terrain>", "kind": "bake", "scatter": [
  {"id": "rocks", "asset": {"assetId": "<model>"}, "density": 0.01, "spacing": 6, "slope": {"max": 15}}]}
```

A bake that names only `scatter` leaves the baked materials as they are.
`queryTerrain {entityId, scatter: {}}` (MCP `tl_content_query target="terrain"`) counts
each rule's copies. Scripts find, hide and remove copies with
[`ctx.scatter`](../reference/script-api.md#ctx-scatter).

## Stamps and erosion (Stack)

**Editor:** the **Stack** mode lists the edit layers the heights are made
of, over the ground as sculpted by hand: switch a layer off, weigh it, move
it, delete it. **Stamp** (W) places a heightmap (picked by its picture) as
wide as the brush with a click; **Select** (Q) draws the stamps' squares on
the ground — drag one's body to move it, a corner to resize it, the knob to
turn it, or set its numbers in the column. **Erode** (E) erodes the square
under the brush with a click (hydraulic and thermal, every setting of each).

**API:** `setComponent` of the terrain's `layers`
([`TerrainLayer`](../reference/types-p-u.md#type-terrain-layer)) and
`editTerrain` kind `erode`.

## Tiles and heightmaps

**Editor:** the **Tiles** mode draws the tile grid on the ground: click an
empty square beside the terrain (dashed, with a "+") to add a tile there —
it carries the ground on from its neighbours' edges — or click a tile to
pick it and **Remove** it. **Import heightmap** lays a 16-bit PNG or RAW file
from the picked tile; **From a block layer** converts a block layer's
surface. The **Settings** mode holds the tile size, the height range, the
detail distance and collision.

**API:** `editTerrain` kind `addTiles {tiles: [[x, z]]}` and kind `import`
(a staged file).

## A road or a river (splines)

**Editor:** **GameObject → Level → Road** (or **River**, **Spline**) makes a
spline; drag its handles in the Scene view: a point's grip, its height grip,
its width grip and its tangent. Each drag is one undo step, and the terrain
follows in the same step.

**API:** `createEntity` with a
[`spline`](../reference/components-rendering-1.md#component-spline):

```json
{"sceneId": "scene-main", "kind": "group", "name": "Road", "components": {"spline": {
  "points": [{"at": [-60, 0, 10]}, {"at": [-20, 0, 0]}, {"at": [40, 0, 20]}], "width": 5,
  "terrain": {"shape": "flatten", "falloff": 4, "paint": {"layer": 3}},
  "scatter": {"margin": 1}, "mesh": {"kind": "surface"}}}}
```

The same command flattens the ground under it, paints layer 3 along it,
keeps scatter off it and makes its mesh. Moving or deleting the spline gives
the ground back. Scripts read it as a path with
[`ctx.splines`](../reference/script-api.md#ctx-splines).

## A block area on terrain

1. Build the area as a [block layer](block-layers.md) standing on the
   terrain (a courtyard, a village square).
2. Add a **blocks** edit layer to the terrain. **Editor:** the terrain
   editor's **Stack** mode → **Meet block layers**. **API:** `setComponent` `{"entityId": "<terrain>",
   "component": "terrain", "value": {"layers": [{"id": "courtyard", "kind":
   "blocks", "blend": 8}]}}`
   ([`TerrainBlocksLayer`](../reference/types-p-u.md#type-terrain-blocks-layer)).

The terrain then cuts a hole under the blocks, meets their top edge exactly
at the border and fades back to its own height over `blend` metres. Later
block edits re-bake the ground round them in the same command. Give the
terrain and the block types the same layered material so the textures line
up across the border.

## Which to use

Sculpt and paint in the editor: it is a brush job, and you judge it by eye.
Use the API for what is data: importing a heightmap, setting rules and
scatter you keep in a build script, laying roads from a list of points.
Rules and splines are the parts worth keeping in code, because the ground
is baked again from them.

## Pitfalls

- **Rules, scatter rules and edit layers are whole lists:** `editTerrain
  bake` with `rules` (or `scatter`) replaces every rule of that list; a
  `setComponent` of `layers` replaces every edit layer. Read them first
  (`queryTerrain`) and send the full list.
- **`setComponent` of `rules` alone stores them without baking.** Use
  `editTerrain` kind `bake` (or **Bake rules**).
- **`tileSamples` is fixed once tiles hold data.** Choose it first.
- **A spline never changes a block layer:** where cells are, it stops.
- **One terrain per landscape.** Large worlds stream their tiles: set the
  terrain's **Streaming** rings (see [World streaming](../features/streaming.md))
  and fog the far edge ([environment](environment.md)).
- **Layer textures are joined into arrays.** Textures imported as PNG or
  JPEG are encoded into the terrain's three arrays each time a layer's
  texture changes (seconds for four 512² layers; the ground draws plain
  until they arrive). Textures encoded to KTX2 (UASTC) at import are joined
  as they are.
- **Limits are per command:** a stroke takes at most 1,024 dabs; a
  heightmap import at most 8,193² samples. There is no cap on tiles or
  rules. See [Limits](limits.md).
