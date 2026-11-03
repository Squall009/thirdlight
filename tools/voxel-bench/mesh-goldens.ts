/**
 * Goldens of the hard-case world (features.ts) per case, measured by the
 * harness (mesh-cases.ts) on the reference surface nets: the "before" a
 * terrain mesher is held to. Errors are rounded up to the micrometre;
 * triangles are those in each case's measuring box. The reference keeps
 * every probe, so no case lists a lost one.
 */
import type { CaseGolden } from './mesh-cases';

export const REFERENCE_GOLDENS: Readonly<Record<string, CaseGolden>> = {
  'slope-1:20': { triangles: 5768, maxErrorM: 0.049505, meanErrorM: 0.026723, lost: [] },
  'slope-1:5': { triangles: 6885, maxErrorM: 0.043671, meanErrorM: 0.018402, lost: [] },
  'bank-1:1': { triangles: 8052, maxErrorM: 0.119939, meanErrorM: 0.017362, lost: [] },
  'cliff-20m': { triangles: 9568, maxErrorM: 0.172787, meanErrorM: 0.028068, lost: [] },
  'terraces-1': { triangles: 6344, maxErrorM: 0.150001, meanErrorM: 0.038817, lost: [] },
  'terraces-2': { triangles: 6864, maxErrorM: 0.150001, meanErrorM: 0.043159, lost: [] },
  'overhang': { triangles: 9568, maxErrorM: 0.150001, meanErrorM: 0.026284, lost: [] },
  'arch': { triangles: 7544, maxErrorM: 0.233334, meanErrorM: 0.026629, lost: [] },
  'cave': { triangles: 12316, maxErrorM: 0.233334, meanErrorM: 0.026617, lost: [] },
  'wall-1': { triangles: 6332, maxErrorM: 0.166504, meanErrorM: 0.026917, lost: [] },
  'spike-1': { triangles: 5488, maxErrorM: 0.166504, meanErrorM: 0.026369, lost: [] },
  'pit-1': { triangles: 5432, maxErrorM: 0.166504, meanErrorM: 0.025548, lost: [] },
  'hole-1': { triangles: 7052, maxErrorM: 0.166504, meanErrorM: 0.025022, lost: [] },
  'bumps': { triangles: 6384, maxErrorM: 0.132553, meanErrorM: 0.026261, lost: [] },
};

/** A case's shading-normal bounds (degrees from the analytic solid's normal, harness `measureNormals`). */
export interface NormalGolden {
  readonly p50Deg: number;
  readonly p95Deg: number;
  readonly maxDeg: number;
}

/**
 * The terrain mesher's normals per case, rounded up to 0.1°: smooth lattice
 * normals over 4 × 4 columns, creases split with face normals. Where a
 * crease's placement sits off the true corner, the face normals show that
 * offset, so the p95/max at creases measure the placement as much as the
 * normals (a straight step's edge is placed on the column tops, so the
 * terraces and the cliff top are nearly exact; a step's corner and a cave's
 * rim still carry the QEF's offset).
 */
export const TERRAIN_NORMAL_GOLDENS: Readonly<Record<string, NormalGolden>> = {
  'slope-1:20': { p50Deg: 0.3, p95Deg: 1.3, maxDeg: 1.5 },
  'slope-1:5': { p50Deg: 0.8, p95Deg: 1.2, maxDeg: 1.6 },
  'bank-1:1': { p50Deg: 0.3, p95Deg: 9.8, maxDeg: 35.3 },
  'cliff-20m': { p50Deg: 0.1, p95Deg: 0.1, maxDeg: 45.1 },
  'terraces-1': { p50Deg: 0.1, p95Deg: 4.6, maxDeg: 4.6 },
  'terraces-2': { p50Deg: 0.1, p95Deg: 45.1, maxDeg: 45.1 },
  'overhang': { p50Deg: 0.1, p95Deg: 11.4, maxDeg: 68.3 },
  'arch': { p50Deg: 0.1, p95Deg: 11.4, maxDeg: 76.9 },
  'cave': { p50Deg: 0.1, p95Deg: 11.4, maxDeg: 75.9 },
  'wall-1': { p50Deg: 0.1, p95Deg: 4.1, maxDeg: 68.3 },
  'spike-1': { p50Deg: 0.1, p95Deg: 0.1, maxDeg: 20.3 },
  'pit-1': { p50Deg: 0.1, p95Deg: 0.1, maxDeg: 79.2 },
  'hole-1': { p50Deg: 0.1, p95Deg: 11.4, maxDeg: 84.3 },
  'bumps': { p50Deg: 0.1, p95Deg: 16.3, maxDeg: 55.7 },
};
