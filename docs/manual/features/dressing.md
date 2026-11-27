# Dressing: what grows on a voxel material

A **dressing** says what grows on the ground of a voxel world: grass,
flowers, reeds, pebbles. A voxel material names one dressing, and wherever
that material is the surface, the dressing's plants appear by its rules.
Nothing is placed by hand and nothing is stored a plant: the plants are made
again from the voxels whenever the ground is sculpted, painted or flooded,
in the editor's Scene view, in Play and in an exported game alike.

What a voxel world and a voxel material are: [Voxel worlds](voxel-worlds.md).
The mode that sculpts and paints the ground, and reads the rules at a
point: [The world editor](world-editor.md).

## The short way: the Basic Kit's meadow

A new project has no plants and no dressing. The engine's Basic Kit brings
a starter set:

1. **Create → Basic Kit** in the Project window. Among its items are four
   plant models (`basic-grass`, `basic-flower`, `basic-reed`,
   `basic-pebbles`) and three dressings: **Meadow**, **Shore** and
   **Gravel**.
2. Select the scene's voxel world object and press **Edit world**.
3. On **Sculpt** (Add) or **Paint**, an empty palette offers **Make a grass
   material**: a plain green ground material that names the Meadow. The
   **Rules** rail offers the same for **Shore** and **Gravel**.
4. Add or paint ground with it. Grass grows on it under open sky; flowers in
   patches and along the edge of another material (a path); reeds where
   water stands 5 to 70 cm deep on it.

The kit brings no voxel material of its own, because a voxel material's id
belongs to the project (two materials with one id are refused). That is why
step 3 makes one. Through the API the same is one
[`setMaterial`](../reference/ops-detail.md#op-setMaterial):

```json
{"op": "setMaterial", "args": {"material": {"materialId": "grass", "name": "Grass",
  "shader": "standard", "params": {"color": "#6f8f45"}, "textures": {},
  "voxel": {"id": 3, "use": "terrain", "dressing": "basic-meadow"}}}}
```

| Dressing | Meant for | What it grows |
|---|---|---|
| **Meadow** (`basic-meadow`) | a grass ground | grass (7 clumps a m²) on dry ground under open sky, thinning on slopes over 40°; flowers in soft patches and within 1.5 m of another material's edge, never within 2 m of a building; reeds where water is 5–70 cm deep |
| **Shore** (`basic-shore`) | a bank of sand or mud | reeds in the shallows, pebbles in patches at the waterline, thin grass on the dry part |
| **Gravel** (`basic-gravel`) | a road or a yard | pebbles in patches, grass tufts within about a metre of its edge |

The four plants are small on purpose (42, 39, 42 and 45 triangles up close,
3 to 7 far off, one 128 px colour texture between them, no collision): they
are placeholders to build with, and a project replaces them with its own
models.

## A dressing

A dressing is its own file (`assets/dressings/<id>.dressing.json`) and an
item of the Project window. It is an **ordered list of species**. One
species:

| Field | What it is |
|---|---|
| `model` | the model asset placed |
| `class` | `cover`: small plants made near the camera (this page). `large`: trees, bushes, boulders; **stored, and placed by nothing yet** (a later phase) |
| `density` | candidates a square metre (0.0001–100). Each is kept where every condition holds; where a condition fades, that share of them |
| `spacing` | metres kept between this species' own plants (0: none; a cover species at most 8) |
| `scale` | `[min, max]`: each plant's random size |
| `yaw` | each plant is turned about up by a random angle from 0 to this (360 when left out) |
| `align` | 0 stands upright, 1 stands square on a slope |
| `seed` | another whole number gives other positions, sizes and turns |
| `conditions` | where it grows (below). None: on every surface of the materials naming the dressing |

Every field of the record:
[`DressingDef`](../reference/types-c-m.md#type-dressing-def).

**A species grows only on materials that name its dressing.** A species
with no `material` condition grows on all of them; that is how the kit's
dressings work in any project. The `material` condition narrows it further
(of the materials naming the dressing, only these ids).

**A dressing is shared.** Every material that names it grows by it, and a
change to it changes them all at once.

**The order matters to positions, not to priority.** A species' place in the
list picks where its candidates fall, so moving an entry up or down, or
removing one before it, moves its plants. No species gives way to another:
each keeps only its own spacing.

## The ten conditions

Each is checked against the surface under a candidate: the top of ground, a
cave's floor, a storey's floor, a roof. A condition left out is "any".

| Condition | Form | Reads |
|---|---|---|
| `material` | a list of voxel material ids | the surface cell's material |
| `role` | a list of `terrain`, `wall`, `floor`, `roof`, `foundation`, `stair`, `pillar` | what the surface cell is |
| `slope` | a range, degrees | 0 level to 90; a wall standing beside the ground does not count as slope |
| `height` | a range, metres | the surface's height in the world |
| `sky` | `true` or `false` | `true`: nothing solid over it; `false`: under cover (a cave, a room) |
| `wetness` | a range, 0–7 | the painted wetness |
| `waterDepth` | a range, metres | water standing on the surface; 0 dry |
| `materialEdge` | a range, metres, 0–8 | distance to the nearest surface of another material |
| `construction` | a range, metres, 0–8 | distance to the nearest wall, floor or building |
| `noise` | a range over 0–1, with `scale` (m) and `seed` | a patchy pattern across the ground; it stays put when the ground is sculpted |

A **range** is `{min?, max?, fade?}`. Inside it the condition holds fully.
With a `fade`, it falls off over that many units past an end instead of
stopping dead, which thins the plants there instead of ending them at a
line. The two distances are searched 8 m out: a value of 8 means "none
within 8 m".

Three things to know:

- **Leave `waterDepth` out and the species also grows under a lake.** Grass
  wants `{"max": 0}`.
- **Do not fade a water depth's lower end**: `{"min": 0.05, "fade": 0.1}`
  puts half the reeds on the dry bank.
- The distances are measured along the surface the plant stands on, not
  through the air: a cave's floor does not read the meadow over it.

## Recipes

Each is one species entry.

Grass on open, dry ground, thinning out on steep slopes:

```json
{"model": "basic-grass", "class": "cover", "density": 7, "scale": [0.75, 1.3], "align": 0.3,
 "conditions": {"slope": {"max": 40, "fade": 10}, "sky": true, "waterDepth": {"max": 0}}}
```

Reeds in the shallows:

```json
{"model": "basic-reed", "class": "cover", "density": 3, "spacing": 0.3,
 "conditions": {"waterDepth": {"min": 0.05, "max": 0.7}}}
```

Moss on a cave's wet floor (paint the wetness with the world editor):

```json
{"model": "moss", "class": "cover", "density": 5,
 "conditions": {"sky": false, "wetness": {"min": 3}}}
```

Flowers at a path's verge, not against a house:

```json
{"model": "basic-flower", "class": "cover", "density": 2, "spacing": 0.35,
 "conditions": {"sky": true, "waterDepth": {"max": 0}, "materialEdge": {"max": 1.5, "fade": 0.5}, "construction": {"min": 2}}}
```

A fringe of weeds where a wall meets the ground:

```json
{"model": "weeds", "class": "cover", "density": 6,
 "conditions": {"role": ["terrain"], "construction": {"max": 1}}}
```

Clover in patches about 8 m across:

```json
{"model": "clover", "class": "cover", "density": 4,
 "conditions": {"sky": true, "noise": {"min": 0.6, "fade": 0.1, "scale": 8, "seed": 2}}}
```

## Sparser, denser, different: variants

How much grows is the material's, not the brush's. To have the same ground
grow less, more or other plants, make a **material instance** of it with a
voxel id of its own and give the instance another dressing. Paint with the
variant where the meadow should be thin. A variant that names no dressing
grows what its parent grows. It cannot name "nothing": give it a dressing
with no species.

## In the editor

**The Dressing card** is on a material's Inspector, under **Voxel use**
(select the material in the Project window). It shows for ground and
construction materials, not for a liquid or a gas.

- **dressing**: pick one, or **new** to make an empty one and name it here,
  or "nothing grows" to clear it. On a variant the empty choice is "the
  parent's".
- **name**, and under it who shares the dressing.
- **Each species** is a folded line (its model, class, density and how many
  conditions it has) with **↑**, **↓** and **remove**. Unfolded: its model,
  class, density, spacing, scale, turn, lean and seed, then **Where it
  grows**: ticks for materials and roles, a choice for the sky, and a row of
  **min, max, fade** for each range (the noise also has its scale and seed).
  An emptied field is an open end; a condition with every field empty is
  off.
- **add species**: pick a model.

There is no Apply and no preview window: each change is one command and one
undo step, and the Scene view grows the cover again as it arrives. Cover
shows within about 40 m of where the view looks, so work close.

**The Rules rail** of the [world editor](world-editor.md#rules) answers "why
is nothing growing here": move over the ground and it lists every species of
that material's dressing as growing (with its share) or not, with the
condition that fails and the number read there.

## Through the API

The same commands, with `tl_command` over MCP:

- [`setDressing`](../reference/ops-detail.md#op-setDressing)
  `{dressing}` creates or replaces one dressing, whole:

  ```json
  {"op": "setDressing", "args": {"dressing": {"dressingFormat": 1, "dressingId": "heath", "name": "Heath",
    "species": [{"model": "basic-grass", "class": "cover", "density": 3,
                 "conditions": {"sky": true, "waterDepth": {"max": 0}}}]}}}
  ```

- A material names it with [`setMaterial`](../reference/ops-detail.md#op-setMaterial):
  `"voxel": {"id": 3, "use": "terrain", "dressing": "heath"}`. A dressing
  the project lacks is refused (`dressing_missing`), and so is one on a
  liquid or a gas.
- [`deleteDressing`](../reference/ops-detail.md#op-deleteDressing)
  `{dressingId}`: refused while a material names it; clear the material's
  field first.
- Read them with `tl_content_query` or `queryGameConfig` (`dressings`,
  and each material's `voxel.dressing`).
- The Basic Kit is added with `POST /api/v1/projects/<id>/packs/basic-kit`
  (the editor's Create → Basic Kit): one undo step.

A script reads the numbers a rule reads with
[`ctx.voxels.surfaceAt`](../guides/voxel-scripts.md#surfaces-surfaceat)
(`{ distances: true }` for the two distances).

## Which to use

Use the editor to tune: density and conditions are judged by eye, with the
Scene view growing each change and the Rules rail explaining a bare spot.
Use the API to copy dressings between projects or to write many species
from data.

## What cover does and does not do

- **It is drawn near the camera only**: within 40 m, thinning from 24 m. Past
  that the ground is bare. Level-of-detail rings beyond it come in a later
  phase.
- **It keeps clear of static props.** An object marked **Static** that has a
  model keeps the plants out of its box (its collider, else its model's
  bounds). An object not marked Static is grown over. A tree model with no
  collider clears its whole crown's footprint: give it a trunk collider.
- **It keeps clear of buildings.** Nothing grows under a structure's floor,
  and a structure's own floors grow nothing.
- **It follows edits**: sculpt, paint, flood or drain, and the plants of
  the chunks round the edit are made again.
- It does not collide, and it casts no shadow (it receives them). Plants
  wearing a foliage material sway in the scene's wind and part round
  interactors ([Grow a meadow](../guides/meadow.md) describes both).
- A species' `model` is not checked: a model that is missing grows nothing
  and reports nothing.
- **A blade seen from behind is shaded darker** than one seen from the
  front, so a clump has light and dark blades whatever its colours. This is
  how the foliage material lights a two-sided face today.
- Where cover is first drawn the page can stall for a moment (a long frame
  as the first plants of a place arrive).
- `large` species are stored and shown nowhere.

## Budget

Cover is cheap a plant and costly in number. The engine's guide for the
lowest quality level is at most about 100,000 clumps and 1.2 million
triangles in view. The Meadow and Gravel on the engine's test town draw
about 6,000 clumps and 77,000 triangles in view there. To stay inside:

- Give a cover model **levels** (`_LOD0`, `_LOD1`, `_LOD2` nodes): most
  clumps in view draw the far ones. A few dozen triangles up close and a
  handful far off is the starter plants' measure.
- Keep the **total density** of a dressing's cover species near 10 a m² or
  under.
- A model for cover has **no collision node** and one small texture.
