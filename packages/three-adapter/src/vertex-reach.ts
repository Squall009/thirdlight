/**
 * How far a draw's vertices may move past its geometry when it is drawn:
 * what occlusion culling must grow a draw's bounds by before it may say the
 * draw is hidden. A skinned or morphed mesh poses its vertices anywhere its
 * bones or targets take them; a material's position node (wind, a graph's
 * vertex offset or displacement, a billboard) moves them as its code says.
 * None of that is in the geometry's bounds.
 *
 * A material whose owner knows the most its position node moves a vertex
 * declares it here (the foliage shader's wind: from the wind's strength
 * now). Anything else that moves its vertices has no bound and is never
 * culled; terrain pages place their vertices from heights their owner's
 * bounds already hold, and are not asked.
 *
 * Kept beside the materials, not in `userData`, which a clone copies as JSON:
 * a cloned material has no declared reach and is never culled.
 */
import type * as THREE from 'three';

const reaches = new WeakMap<THREE.Material, () => number>();

/** Say that `material`'s position node moves a vertex at most `reach()` metres (in the world, now). */
export function declareVertexReach(material: THREE.Material, reach: () => number): void {
  reaches.set(material, reach);
}

/**
 * How far (world metres) `mesh`'s vertices may lie past its geometry's
 * bounds when drawn: 0 when nothing moves them; null when nothing bounds it
 * (skinned, morphed, or a position node with no declared reach).
 */
export function vertexReachOf(mesh: THREE.Mesh): number | null {
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true) return null;
  const morphs = mesh.geometry?.morphAttributes;
  if (morphs !== undefined && ((morphs['position']?.length ?? 0) > 0 || (morphs['normal']?.length ?? 0) > 0)) return null;
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let reach = 0;
  for (const m of list) {
    const node = (m as { positionNode?: unknown } | undefined)?.positionNode;
    if (node === null || node === undefined) continue;
    const declared = reaches.get(m);
    if (declared === undefined) return null;
    const r = declared();
    if (!(r >= 0)) return null;
    reach = Math.max(reach, r);
  }
  return reach;
}
