# Decals

**Goal:** dirt, cracks, stains, leaks, signs and scorch marks on a level's
surfaces without new unique textures. The full description is in
[Decals](../features/decals.md).

Two kinds draw today:

- **projected decals**: a decal component — a box that marks every surface
  inside it (blocks, terrain, props, generated walls) channel by channel;
  the quickest way to put a mark anywhere, and the only one that can change
  just the roughness or just the normal;
- **mesh decals**: a flat mesh — a quad, or a strip that follows a curb or
  a wall's foot — laid on a surface and wearing a **decal material**.

Both use a **decal material**. Clipped decals (the component's `clipped`
mode) are saved and shipped but do not draw yet.

## Make a decal material

1. In the project window, **create → Material**, then set its **shader** to
   `decal`.
2. Pick its **source**: its own textures — `map` (colour with opacity in
   alpha), and if you have them `normalMap`, `ormMap` (occlusion, roughness,
   metalness) and `emissiveMap` — or **a trim sheet's decal cell** (a trim
   material and a cell by name; see [Trim sheets](trim-sheets.md)).
3. Set **blend**:
   - `blend` — the decal's lit colour over the surface by its opacity
     (signs, painted marks, leaves);
   - `multiply` — its colour stains what is under it, white leaves it as it
     is (dirt, soot, water marks);
   - `add` — its lit colour is added (glow, light spill).
4. Where two decals overlap, the one with the higher **sortOrder** draws on
   top (−1000 to 1000; decals always draw before water and effects).

## Project it onto a surface

1. Create an empty object where the mark goes and **+ Add component →
   Decal**; pick the decal material.
2. Turn the object so its −Z looks at the surface (for a floor: rotate it
   −90° about X, the image's top then points along −Z). The box is
   centred on the object: put the object on the surface, so the surface
   lies in the middle of the box's depth (the edge fade is weakest there).
3. Set **size**: the mark's width and height, and a depth a little more
   than the bumps it must reach over (0.5–2 m on a floor).
4. Choose what it changes with **Channel opacity**:
   - a stain, a sign: the colour (the default: every channel its material
     has an image for);
   - a crack or a seam: a material with only a normal map, or albedo
     opacity 0;
   - a wet patch: a material with only a roughness value (or an ORM
     image), every other channel at 0.
5. Keep a mark off an object: give the decal a **layer** the object is not
   in (the object's **Decal layers**). Characters (skinned models) take no
   projected decal unless their decal layers are set.

Overlapping decals blend lowest **sortOrder** first. A spot covered by more
than 16 decals keeps the 16 highest sort orders (the overlap budget); spread
dense marks out or merge them into one image.

```json
{ "op": "createEntity", "args": { "sceneId": "scene-main", "kind": "group", "name": "Puddle",
  "transform": { "position": [4, 0, -2], "rotation": [-0.7071, 0, 0, 0.7071] },
  "components": { "decal": { "size": [2, 1.5, 1], "material": "mat-puddle",
    "opacity": { "albedo": 0.3, "normal": 0 } } } } }
```

A projected decal on an object that moves (a mover, a moving parent)
moves with it.

## Leave marks from a script

Bullet holes, footprints and scorch marks come and go while the game runs:

1. Make the mark once: an empty object with a **Decal** component (a decal
   material, a size, the channel opacities you want), then **make it a
   prefab** (keep it in a scene the game never loads, or delete the object
   afterwards).
2. In the script, leave one where something hit:

   ```ts
   const hit = ctx.physics.raycast3d(from, dir, 50);
   if (hit !== null) ctx.decals.spawn('bullet-hole', { position: hit.point, normal: hit.normal, angle: ctx.stepIndex * 37 % 360 });
   ```

   Pass `entityId` (with `position` and `normal` in that object's space) to
   stick the mark to an object that moves; `scale` sizes it, `lifetime`
   (seconds) fades it out by itself.
3. Let the budget clean up: past 256 spawned marks the oldest fade out, so
   a script never has to count them. `ctx.decals.remove(handle)` fades one
   out sooner.

Spawned marks are drawn only: they are not saved and change nothing the game
computes. A visual script has the **Spawn decal** and **Remove decal**
nodes.

## Put it on a mesh

- **A model:** author the mark as geometry in your modelling tool, its UVs
  0–1 over the image, laid on the surface or a few millimetres above it (no
  need to lift it further: the engine pushes decals toward the camera so
  they never flicker into the surface, at any distance and with every depth
  precision setting). Map its glTF material to the decal material in the
  asset's **materials** (every placement) or the object's. A glTF material
  whose name ends in `_decal` already draws as a decal with the file's own
  textures, so a file made that way needs no mapping.
- **A box:** a flat box (a few millimetres tall) on the floor with the
  decal material on it — handy for quick marks and tests.
- **A graph material:** set its output node's **Decal** field to `blend`,
  `multiply` or `add` (and **Decal sort order**): the graph then draws as a
  decal.

A decal casts no shadow and writes no depth; it is lit like the surface
under it (light layers, probes, its room). Make decals that never move
**static**: a cell's static decals of one material merge into one draw,
and copies of one mark mesh are drawn together however many there are.

## Through the API

```json
{ "op": "setMaterial", "args": { "material": { "materialId": "mat-soot", "name": "Soot",
  "shader": "decal", "params": { "blend": "multiply", "color": "#3a3028" },
  "textures": { "map": "soot-albedo" } } } }
```

```json
{ "op": "setAssetOptions", "args": { "assetId": "curb-marks", "materials": { "mark": "mat-soot" } } }
```

## Check it

- In Play, decals that lie in a surface show whole at every distance; a
  mark that flickers is not on the surface (more than a few centimetres off
  it) or faces away from the camera.
- A projected decal that does not show: is the surface inside the box
  (its middle), facing the projector (within `normalFade`), in one of its
  layers? Play diagnostics `renderer.projectedDecals` count the loaded and
  drawn decals, the spawned and fading ones and the ones over the overlap
  budget (Play's Problems say `decal_overlap` too); `?decals=off` on the
  Play URL hides them all to compare.
- A spawn that returns 0: the prefab has no projected decal, or the script
  asked for more than 32 in one step.
- Play diagnostics count the decal page arrays under `renderer.decals`
  when a decal component names a material; a mesh decal's material holds
  its pages itself (they count in `renderer.textures`).

Related: [Decals](../features/decals.md), [Trim sheets](trim-sheets.md),
[Material graphs](material-graphs.md).
