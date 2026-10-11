# Vertex paint

> **Growing.** This page grows as vertex paint is built. What exists now:
> the data and the command — paint on placed models, instance copies and
> generated meshes (architecture and splines) is stored, undone, checked
> against reimports, reached through MCP and shipped with an export. Not
> yet: drawing it (materials do not read it yet) and the editor's paint
> brush.

Vertex paint puts per-vertex values on meshes — colour, grime, wetness,
blend weights for a height blend — without new textures. Each painted
vertex holds 4 bytes (R, G, B, A, 0–255). What a channel means is up to
the material that reads it; an unpainted vertex reads (0, 0, 0, 0), which
changes nothing.

Paint is a stream of its own, stored beside the mesh. It never replaces a
model's own vertex colours (`COLOR_0`), which keep their meaning (a tint,
the foliage shader's wind, the trim shader's occlusion, grime and wetness).

## Painting: `paintVertices`

One brush stroke is one [`paintVertices`](../reference/ops-detail.md#op-paintVertices)
command and one undo step. The editor's brush (coming) and MCP send the
same command; the backend turns the stroke into bytes, so both get the same
result.

```json
{ "op": "paintVertices", "args": {
  "entityId": "rock-000001",
  "dabs": [[10, 0.2, 4], [10.3, 0.2, 4.1]],
  "brush": { "radius": 0.5, "strength": 0.8, "channel": 1, "falloff": "smooth" } } }
```

- **dabs**: the world points the brush touched (up to 256 a stroke).
- **brush.radius**: metres in the world, 0.01–64 (a scaled object is
  painted with the brush's real size).
- **brush.strength** (0–1]: how far one dab moves a vertex at its centre
  toward 255 (with **erase**: toward 0).
- **brush.falloff**: `smooth` (default), `linear` or `constant`, the same
  brush as block layer paint.
- **brush.channel**: 0–3 (R, G, B, A). The channels stand alone: painting
  one leaves the others.

What the stroke paints depends on the object:

| Object | Stroke | Stored |
|---|---|---|
| a model | every mesh of its model (or `mesh`: one, e.g. `"Body/Hull#0"`) | `vertexPaint.meshes` |
| an instance set | `copy`: one copy, by its place in the set's buffer | `instances.paint` |
| generated architecture | `path` (`outline:<id>`, `building:<id>`, `element:<id>`) and `side` | `vertexPaint.paths` |
| a spline | `path: "spline"` and `side` | `vertexPaint.paths` |

A stroke that reaches nothing is refused with `no_change`. Painting back to
zero removes what it stored; when nothing is left the component goes too.

## Models

A model object's paint is the [`vertexPaint`](../reference/components-rendering-1.md#component-vertexPaint)
component: per mesh its name (the node's path from the file's root, then
`#` and the primitive: `Body/Hull#0`; a second sibling of one name is
`Name~1`), the vertex count and a hash of the positions it was painted on,
and the blob of its paint (4 bytes a vertex). Every level of detail is a
mesh of its own; collision (`_COL`) meshes are not painted.

**Reimports.** A reimport that changes a painted mesh (other vertices, moved
vertices, the mesh gone) keeps the old paint as it was but does not draw
it: the paint was made for other vertices. Problems (and `tl_diagnostics`)
report it as `paint_mismatch`, naming the object and the mesh. Undoing the
reimport brings the fit back. A stroke over such a mesh is refused until
its paint is removed (`setComponent vertexPaint` without it, or `null`);
then it paints again from zero. A reimport that keeps the mesh's vertices
(new materials, new textures, the node moved) keeps the paint drawn.

## Instance copies

An instance set's paint is its `paint` field: a table of the painted copies
(copy → slot) and, per mesh, a pool of slots, each holding one copy's 4
bytes a vertex. Copies that are not painted cost nothing, so a set of
thousands of copies with a few painted stays small.

A copy is addressed by its place in the set's buffer. When the buffer
changes, the table follows the copies in the same change: copies the
instance brush erases or the editor deletes lose their paint and the others
keep theirs; moved, turned or scaled copies keep their paint; copies added
at the end start unpainted. A buffer that is not the old one edited (a new
scatter, an import) drops the paint; undo brings it back.

## Generated meshes

Generated architecture and spline meshes are made again whenever their
parameters change, so their paint is kept along the path that makes them,
not on their vertices: a grid per side of a path, a point every 0.25 m
along the path and up a wall face (`left`, `right` of travel) or across a
face looking up or down (`top`: a road surface, a wall's top). Faces within
2 m of the path take its paint. A wall cut by a new door, raised a storey,
lengthened or given another profile keeps its paint where it was painted;
vertices that come out where there was no paint stay unpainted. Generated
walls have a vertex about every metre along, so paint on them is soft.

Paint names its path by key: an outline, a building or a sweep element of
the object's `architecture` (`outline:<id>`, `building:<id>`,
`element:<id>`), or `spline`. A path that is deleted leaves its paint
unused.

## Shipping

An export ships every paint blob the scenes name (`content/sha256/…`, each
of the size its record says), beside the instance buffers; Play serves them
the same way.

## Limits

No cap on painted objects or meshes. A mesh's blob is 4 bytes a vertex (an
instance set's pool: that times its slots); a path grid's size follows the
painted length and height. The brush's bounds are in the
[limits reference](../reference/limits-project-model-2.md#limits-project-model--vertex-paint-stroke).
