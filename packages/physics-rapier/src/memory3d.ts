/**
 * What a static collider costs Rapier's WebAssembly heap, estimated from
 * its shape. The heap itself (`physicsMemoryBytes3D`) grows in 64 KiB
 * pages and never shrinks, and freed bodies' bytes are reused by later
 * ones, so its growth cannot be attributed to one body; a memory budget
 * that frees bodies to make room needs a figure per body instead.
 *
 * The figures are heap growth per body over batches of identical static
 * bodies (rapier3d-compat 0.20.0, Node 22; memory3d.test.ts holds them to
 * 0.8–1.25× of the real heap): a body ~0.9 KB; a box,
 * sphere, capsule or cylinder ~0.7 KB; a convex hull ~0.75 KB + 230 B a
 * point; a heightfield ~1 KB + 5 B a node; a triangle mesh ~1.3 KB + 140 B
 * a triangle (its vertices, index, bounding tree and the topology the
 * internal-edge fix builds). Removing and adding the same bodies again
 * grows the heap at most once (the broad phase and collider arena keep
 * their larger capacity), then not at all.
 */
import type { ColliderPrimitive3D, ColliderShape3D } from './port3d';

const BODY_BYTES = 900;
const PRIMITIVE_BYTES = 700;
const HULL_BYTES = 750;
const HULL_POINT_BYTES = 230;
const FIELD_BYTES = 1_000;
const FIELD_NODE_BYTES = 5;
const MESH_BYTES = 1_300;
const MESH_TRIANGLE_BYTES = 140;

function primitiveBytes(s: ColliderPrimitive3D): number {
  switch (s.type) {
    case 'mesh':
      return MESH_BYTES + MESH_TRIANGLE_BYTES * Math.floor(s.indices.length / 3);
    case 'heightfield':
      return FIELD_BYTES + FIELD_NODE_BYTES * (s.cellsX + 1) * (s.cellsZ + 1);
    case 'convex':
      return HULL_BYTES + HULL_POINT_BYTES * Math.floor(s.points.length / 3);
    default:
      return PRIMITIVE_BYTES;
  }
}

/** Estimated bytes of Rapier's heap one static body of this shape takes (a compound: every part on one body). */
export function estimateStaticBodyBytes3D(shape: ColliderShape3D): number {
  if (shape.type !== 'compound') return BODY_BYTES + primitiveBytes(shape);
  let n = BODY_BYTES;
  for (const p of shape.parts) n += primitiveBytes(p.shape);
  return n;
}
