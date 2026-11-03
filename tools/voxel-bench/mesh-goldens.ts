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
