/**
 * World transforms over the scene hierarchy, for moves that keep
 * an entity where it is in the world.
 *
 * Folders have no transform (identity). A world-keeping move sets the new
 * local transform to `inverse(newParentWorld) * world`, decomposed back into
 * position / rotation / scale. Like any TRS editor, a parent with rotation
 * and non-uniform scale can produce shear that TRS cannot hold; the
 * decomposition then keeps the closest TRS. Results are rounded to 1e-9 so
 * float noise does not show up in the scene file.
 *
 * Column-major 4x4 matrices (the three.js convention). Pure.
 */

import { compose, decompose, IDENTITY, invert, multiply, worldMatrix, type HierarchyNode, type Mat4, type TransformComponent } from '@thirdlight/project-model';

export { compose, decompose, invert, multiply, worldMatrix, type HierarchyNode };

function isIdentity(m: Mat4): boolean {
  return m.every((v, i) => Math.abs(v - (IDENTITY[i] as number)) < 1e-12);
}

/**
 * The local transform that keeps `id` where it is in the world under
 * `newParentId`. Returns the current local transform unchanged when both
 * parents have the same world matrix (for example moving between folders),
 * and null for a folder (no transform) or a singular new parent.
 */
export function worldKeepingLocal(
  byId: ReadonlyMap<string, HierarchyNode>,
  id: string,
  newParentId: string | null,
): TransformComponent | null {
  const e = byId.get(id);
  const local = e?.components.transform;
  if (e === undefined || local === undefined) return null;
  const oldParent = worldMatrix(byId, e.parentId ?? null);
  const newParent = worldMatrix(byId, newParentId);
  if (oldParent.every((v, i) => Math.abs(v - (newParent[i] as number)) < 1e-12)) return local;
  const inv = invert(newParent);
  if (inv === null) return null;
  const world = multiply(oldParent, compose(local));
  return decompose(isIdentity(inv) ? world : multiply(inv, world));
}
