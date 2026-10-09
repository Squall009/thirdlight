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
metre apart, heights −128 to 384 m, and selects it. Its Inspector shows the
fields, then the terrain tools.

**API:** [`createEntity`](../reference/ops-detail.md#op-createEntity) with a
[`terrain`](../reference/components-rendering.md#component-terrain)
component naming its tiles (a tile without data is flat at 0 m):

```json
{"sceneId": "scene-main", "kind": "group", "name": "Land", "transform": {"position": [-64, 0, -64]},
 "components": {"terrain": {"tileSamples": 129, "spacing": 1, "heightRange": [-64, 192], "tiles": [{"x": 0, "z": 0}]}}}
```

The object's position is the corner of tile `[0, 0]`; its rotation and
scale are not used.

## Sculpt

**Editor:** tick **Edit terrain**, pick **Raise**, **Lower**, **Smooth**,
**Flatten**, **Noise** or **Ramp**, set **Radius**, **Strength** and
**Falloff**, and drag on the ground. Ctrl lowers for one stroke. A stroke is
previewed on the GPU while you drag and stored as one command when you
release. **Import heightmap…** lays a 16-bit PNG or RAW file;
**Stamp** and **Erode** work through edit layers (**Layers…**).

**API:** [`editTerrain`](../reference/ops-detail.md#op-editTerrain)
([`EditTerrainArgs`](../reference/types-d-p.md#type-edit-terrain-args)),
points in world metres:

```json
{"entityId": "<terrain>", "kind": "raise", "dabs": [[-30, -30], [-25, -28]], "radius": 12, "strength": 6, "falloff": "smooth"}
```

The answer's `terrain` lists the tiles written and the samples changed.

## Rule materials

**Editor:** **Material rules…** in the terrain tools: each rule names a
material layer and its conditions (height, slope, cavity, noise, the share
of an earlier layer); **Apply** bakes them into every tile. **Paint** puts
hand paint over them.

**API:** `editTerrain` kind `bake` sets and bakes the rules in one command
([`SurfaceRule`](../reference/types-p-w.md#type-surface-rule)):

```json
{"entityId": "<terrain>", "kind": "bake", "rules": [
  {"layer": 1, "slope": {"min": 20, "fade": 5}},
  {"layer": 2, "height": {"min": 4, "fade": 1}}]}
```

Where no rule applies the ground is layer 0. Later sculpting bakes the
rules again where it moved the ground. To see the layers as textures, give
the object a [`materials`](../reference/components-rendering.md#component-materials)
component whose `*` names a material made from the **height-blended
layers** template; without one the first four layers show as plain colours.

## Rule scatter and ground cover

**Editor:** **Scatter rules…** in the terrain tools: each rule places a
model by density, spacing and the same conditions; **Apply** bakes the
copies. The **Scatter** brush adds or (Ctrl) removes copies by hand. A rule
marked as ground cover is never stored: it is made round the camera while
the game runs.

**API:** `editTerrain` kind `bake` with `scatter`
([`ScatterRule`](../reference/types-p-w.md#type-scatter-rule)):

```json
{"entityId": "<terrain>", "kind": "bake", "scatter": [
  {"id": "rocks", "asset": {"assetId": "<model>"}, "density": 0.01, "spacing": 6, "slope": {"max": 15}}]}
```

A bake that names only `scatter` leaves the baked materials as they are.
`queryTerrain {entityId, scatter: {}}` (MCP `tl_content_query target="terrain"`) counts
each rule's copies. Scripts find, hide and remove copies with
[`ctx.scatter`](../reference/script-api.md#ctx-scatter).

## A road or a river (splines)

**Editor:** **GameObject → Level → Road** (or **River**, **Spline**) makes a
spline; drag its handles in the Scene view: a point's grip, its height grip,
its width grip and its tangent. Each drag is one undo step, and the terrain
follows in the same step.

**API:** `createEntity` with a
[`spline`](../reference/components-rendering.md#component-spline):

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
2. Add a **blocks** edit layer to the terrain. **Editor:** **Layers… → Add
   blocks layer**. **API:** `setComponent` `{"entityId": "<terrain>",
   "component": "terrain", "value": {"layers": [{"id": "courtyard", "kind":
   "blocks", "blend": 8}]}}`
   ([`TerrainBlocksLayer`](../reference/types-p-w.md#type-terrain-blocks-layer)).

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
  `editTerrain` kind `bake` (or **Apply**).
- **`tileSamples` is fixed once tiles hold data.** Choose it first.
- **A spline never changes a block layer:** where cells are, it stops.
- **One terrain per landscape.** Large worlds stream their tiles: set the
  terrain's **Streaming** rings (see [World streaming](../features/streaming.md))
  and fog the far edge ([environment](environment.md)).
- **Limits are per command:** a stroke takes at most 1,024 dabs; a
  heightmap import at most 8,193² samples. There is no cap on tiles or
  rules. See [Limits](limits.md).
