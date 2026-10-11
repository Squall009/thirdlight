/**
 * The descriptor of the `vertexPaint` component and of an instance set's
 * `paint` field (their format is `vertex-paint.ts`). Both are written by
 * the `paintVertices` command, never typed in: the Inspector shows them.
 *
 * Pure data.
 */
import { json, obj } from './descriptor-builders';
import type { ComponentDescriptor, JsonFieldDescriptor } from './descriptor-types';
import { PATH_PAINT_CELL } from './vertex-paint';

/** An instance set's painted copies (shown, written by paintVertices with `copy`). */
export const instancePaintField: JsonFieldDescriptor = json(
  'paint',
  'Vertex paint',
  'The painted copies: {copies, painted, slots, meshes}: copies the SHA-256 of a table of (copy address, slot) entries, a copy\'s address its place in the buffer; per mesh a pool of slots, each 4 bytes (R, G, B, A) a vertex. Absent: no copy is painted (written by paintVertices; the table follows the copies when the brush or an edit takes some out).',
  { readOnly: true, shape: 'InstancePaint' },
);

export const vertexPaint: ComponentDescriptor = {
  name: 'vertexPaint',
  label: 'Vertex paint',
  tooltip: 'Paint on the object\'s vertices, 4 bytes (R, G, B, A) each, beside the mesh: its materials read it (colour, grime, wetness, blend weights). Painted with paintVertices.',
  category: 'Rendering',
  value: obj('vertexPaint', 'Vertex paint', 'Per model mesh a blob of 4 bytes a vertex, or per generated path a grid in path space.', [
    json('meshes', 'Meshes', 'A model\'s painted meshes: [{mesh, vertices, positions, paint}]: mesh the node path and primitive ("Body/Hull#0"), vertices and positions (a hash) what it was painted on, paint the SHA-256 of 4 bytes a vertex. A reimport that changes a mesh keeps its paint but does not draw it (Problems: paint_mismatch).', { readOnly: true, shape: 'VertexPaintMesh[]' }),
    json('paths', 'Paths', `Generated architecture's or a spline's paint in path space, which survives regeneration: [{path, side, origin, size, paint}]: path outline:<id>, building:<id>, element:<id> or spline; side left, right (wall faces) or top (faces looking up or down); a grid of points ${PATH_PAINT_CELL} m apart along the path and up or across it, origin and size in points; paint the SHA-256 of 4 bytes a point.`, { readOnly: true, shape: 'PathPaintGrid[]' }),
  ]),
  add: { kind: 'tool', tool: 'paintVertices (the vertex paint brush)' },
  handles: [],
  excludes: [],
  rules: ['meshes need the object\'s model component', 'paths need the object\'s architecture or spline component'],
  prefab: false,
};
