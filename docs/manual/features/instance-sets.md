# Instance sets

How to dress a scene step by step: [the instance sets guide](../guides/instance-sets.md).

## Instance sets

An instance set is one object that draws many copies of one model (up to
65 536) with instancing. Use it for foliage, rocks and other repeated
detail. Copies have no ids, colliders or scripts.

- The copies' placements are a buffer: 10 float32 per copy (position xyz,
  rotation quaternion xyzw, scale xyz, local to the object). It is stored by
  its SHA-256 like an asset source. `POST .../content/buffers` publishes one
  from `{transforms: [...]}` (up to 4096 copies inline) or `{stageId}` (an
  uploaded stage); `GET .../content/buffers/<digest>` reads it.
- GameObject → **Instance set…** scatters copies of a model on the ground
  plane around the point the camera looks at. You choose the count, width,
  depth, scale range and random turn; a seed repeats the same layout. The
  object's transform moves, turns and scales the whole set.
- MCP: `tl_instance_buffer {transforms}` returns `{digest, count}`. Then
  `createEntity {kind: "group", components: {instances: {asset: {assetId},
  buffer, count}}}`.
- Single copies: with the set selected, click one of its copies
  in the Scene view. The gizmo then moves, turns or scales just that copy
  (W/E/R), **Del** (or **Delete copy**) removes it, **Whole set** goes back
  to the set. Every edit publishes a new buffer and stores it with one
  `setComponent instances {buffer, count}` — one undo step; the old buffer
  stays, so undo points back to it. MCP does the same: `tl_instance_buffer
  {digest}` reads a set's copies (`{digest, count, transforms}`, sets of up to
  4096 copies), edit the list, publish it, `setComponent`.
- **Instance brush**: with a set selected, the Inspector shows **Paint** and
  **Erase** and the brush's settings — **Radius** (m), **Density** (copies per
  m²), **Spacing** (no two copies closer across the ground, m), **Scale
  min/max** (a random size each), **Rotation** (a random turn about up, 0 to
  that many degrees), **Align** (0 upright, 1 leaning along the surface
  normal) and **Seed**; the settings are kept per browser. Drag in the Scene
  view: copies land on anything that collides — block layers (their
  colliders' shape) and objects with a collider (their drawn shape) — straight
  down within two radii above or below the stroke; nothing lands where
  nothing collides. Erase takes away the copies within the radius (and two
  radii up and down). Alt+drag orbits, Esc drops a stroke. One stroke is one
  command, `paintInstances {entityId, mode: paint|erase, dabs: [[x, y, z]],
  brush: {radius, density, spacing, scale: [min, max], yaw, align, seed},
  surface?}`, and one undo. Where copies may go comes from the seed: the
  world's XZ plane is cut into cells of 1/density m², each with one point
  jittered by the seed, and a stroke takes the points inside its dabs — so
  the same stroke gives the same copies, painting it again adds none, and a
  long stroke is as dense as one dab. The backend makes the copies (in the
  set's own space, after its copies, within its chunking); the editor sends
  the surface it found under each place (`surface`, `[y, nx, nz]` or null),
  and an MCP caller without one gets the scene's block layers. One stroke
  carries up to 256 dabs and 1,536 places (`INSTANCE_BRUSH_LIMITS`, so it fits
  one 64 KiB command); a longer drag in the editor goes on as the next
  stroke, so a long drag is several strokes and takes several undos to take
  back (one per stroke). A set has no count of its own beyond an instance
  set's 65,536 copies. GameObject → **Instance set…** (the rectangle fill) still makes a
  new set.
- **Chunks**: a set is drawn in chunks, each hidden when out of
  view. The copies are split
  by count (about 2048 per chunk) and by extent: no chunk is wider than the
  chunk size, 32 m unless the project sets **Quality → Rendering → Instance chunk
  size** (`setSettings {instance_chunk_m}`, 1–4096 m) or the set its own
  (Inspector → Instance set → **Chunk size**, `instances.chunkSize`; `null`
  puts it back to the project's). A set needs at most 256 chunks; a wider one
  gets larger chunks. The Inspector says how many chunks the selected set is
  drawn in. Smaller chunks cull more finely at the cost of more draw calls
  where many are in view. Play, the export and the Scene view chunk alike.
- **Levels of detail and density**: each chunk draws one level of the
  model for all its copies, picked at its centre for the copies' mean size
  (against the model's switch points: [Levels of detail](assets.md#levels-of-detail)); **Level per copy**
  (`lodPerCopy`, default off) has every copy pick its own level by its own
  distance and size instead — truer where a chunk spans a switch point, at
  one more draw per level in each such chunk (off by default: on one game's
  farm it cost 23 draws and ~0.35 ms of main thread a frame on WebGL 2). A
  copy past the model's cull size is not drawn; a chunk wholly past it is
  skipped. Copies thin out where they are small on screen: from
  **Thinning starts at** (`densityStart`, a share of the screen height,
  default 0.02) to **Thinnest at** (`densityEnd`, default 0.005) the share
  drawn falls to **Thinnest density** (`densityMin`; 1 or absent = no
  thinning, so a set made before thinning existed draws every copy as it
  did; the scatter dialog makes new sets with 0.25), linearly with distance,
  each copy keeping its place in the order (Inspector → Instance set). At
  0.25 a 0.5 m tuft starts thinning at ~27 m, a 6 m tree at ~320 m. Play diagnostics (`renderer.lod`) count the copies
  drawn, by level, culled and thinned, and the level switches of the last
  frame.
