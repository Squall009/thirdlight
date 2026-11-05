/**
 * Where a roof-edge piece belongs in its case's own orientation (metres about
 * its cell's centre; roof-mesher.ts `roofEdgesOf`): the height of the roof
 * mesher's top planes over (x, z) near the edge the case dresses. A ridge
 * runs along x on the cell's +z side (the plane rises toward +z, the other
 * slope beyond), an eave's plane rises toward −z, a verge's toward +x, a hip
 * and a valley run from the low +x +z corner up to the −x −z corner. Tests
 * read a piece's vertices against it: the pieces that follow a slope (ridge,
 * verge, hip, valley) lie within a small distance of it.
 */
/**
 * How near the planes a slope-following piece's every vertex stays (metres): a board's lower edge hangs about a
 * quarter cell (measured up and down) under the plane's edge to cover the slab's side, a cap stands a little above.
 */
export const ROOF_EDGE_NEAR_M = 0.16;

export type RoofEdgeCaseId = 'roof-ridge' | 'roof-eave' | 'roof-gable' | 'roof-hip' | 'roof-valley';

/** The top planes' height (metres) at (x, z) for a roof-edge case, in its own orientation. */
export function roofCaseTop(caseId: RoofEdgeCaseId, x: number, z: number): number {
  switch (caseId) {
    case 'roof-ridge':
      return 0.75 - Math.abs(z - 0.25);
    case 'roof-eave':
      return 0.5 - z;
    case 'roof-gable':
      return 0.5 + x;
    case 'roof-hip':
      return 0.5 - Math.max(x, z);
    case 'roof-valley':
      return 0.5 - Math.min(x, z);
  }
}

/** The largest |y − top| over a mesh's positions (metres, xyz triples), x and z held to the cell (a board's ends and lips reach a little past it). */
export function roofCaseOffset(caseId: RoofEdgeCaseId, positions: ArrayLike<number>): number {
  let worst = 0;
  const clamp = (v: number): number => Math.max(-0.25, Math.min(0.25, v));
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const z = positions[i + 2]!;
    // A verge's square-cut end runs on past the cell along the slope: read the plane where the vertex is along x.
    const top = caseId === 'roof-gable' ? roofCaseTop(caseId, x, 0) : roofCaseTop(caseId, clamp(x), clamp(z));
    worst = Math.max(worst, Math.abs(positions[i + 1]! - top));
  }
  return worst;
}
