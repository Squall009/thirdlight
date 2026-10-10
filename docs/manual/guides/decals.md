# Decals

**Goal:** dirt, cracks, stains, leaks, signs and scorch marks on a level's
surfaces without new unique textures. The full description is in
[Decals](../features/decals.md).

What draws today is **mesh decals**: a flat mesh — a quad, or a strip that
follows a curb or a wall's foot — laid on a surface and wearing a **decal
material**. The decal component (projected and clipped decals) is saved and
shipped but does not draw yet.

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
- Play diagnostics count the decal page arrays under `renderer.decals`
  when a decal component names a material; a mesh decal's material holds
  its pages itself (they count in `renderer.textures`).

Related: [Decals](../features/decals.md), [Trim sheets](trim-sheets.md),
[Material graphs](material-graphs.md).
