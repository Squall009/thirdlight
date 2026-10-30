/**
 * The surface cache's addressing of imported static models: per placed
 * piece one chart, its UV1 square when the model has UV1 (sized by its
 * surface area at the placed scale, as a lightmap is), else its surfels, one
 * texel each (`project-model` `surfels.ts`).
 *
 * The tracer meets a model's distance field, not its triangles, so a hit is
 * a point in the field: the nearest surfel of the hit's facing says where
 * the light is (its own texel, or its UV1 point). A piece without surfels
 * has no chart and is lit from the probes only.
 *
 * Pure (no three.js).
 */
import { DISTANCE_BRICK_CELLS, surfelCellKey, surfelFacing, type DistanceBrickSet, type SurfelSet } from '@thirdlight/project-model';

import { surfelLevelFor, type SurfaceChart } from './surface-cache-atlas';
import { invertAffine, type Affine } from './tracer-words';

/** A placed piece's chart (null: the piece has no surfels). */
export function modelChart(set: DistanceBrickSet, worldToLocal: Affine): SurfaceChart | null {
  const s = set.surfels;
  if (s === null || (s.levels[0] ?? 0) === 0) return null;
  if (s.uv1 === null) return { kind: 'surfels', levels: s.levels, spacing: s.spacing };
  const side = Math.sqrt(s.area * areaScale(worldToLocal));
  return { kind: 'area', w: side, h: side };
}

/** How a placement scales areas: the local → world map's determinant to the power ⅔. */
export function areaScale(worldToLocal: Affine): number {
  const m = invertAffine(worldToLocal);
  const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
  return Math.abs(det) ** (2 / 3);
}

/** Per set and surfel level: surfel index by cell and facing (each level keeps one per cell and facing). */
const lookups = new WeakMap<SurfelSet, Map<number, Map<number, number>>>();

function lookupOf(s: SurfelSet, k: number): Map<number, number> {
  let byLevel = lookups.get(s);
  if (byLevel === undefined) lookups.set(s, (byLevel = new Map()));
  let m = byLevel.get(k);
  if (m === undefined) {
    m = new Map();
    const cell = s.spacing * 2 ** k;
    const n = s.levels[k] ?? 0;
    for (let i = 0; i < n; i += 1) {
      const p = [s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!];
      m.set(surfelCellKey(p, cell, surfelFacing([s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!])), i);
    }
    byLevel.set(k, m);
  }
  return m;
}

/**
 * The surfel of level `k` nearest local point `p` with `facing`, among its
 * cell and the 26 around it (−1: none that near).
 */
export function nearestSurfel(s: SurfelSet, k: number, p: readonly number[], facing: number): number {
  const m = lookupOf(s, k);
  const cell = s.spacing * 2 ** k;
  let best = -1;
  let bestD = Infinity;
  for (let dz = -1; dz <= 1; dz += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const i = m.get(surfelCellKey([p[0]! + dx * cell, p[1]! + dy * cell, p[2]! + dz * cell], cell, facing));
    if (i === undefined) continue;
    const d = (s.positions[i * 3]! - p[0]!) ** 2 + (s.positions[i * 3 + 1]! - p[1]!) ** 2 + (s.positions[i * 3 + 2]! - p[2]!) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** A brick hit's point in the set's root space: `a0` holds 11, 11 and 10 bits of x, y, z over the field. */
export function brickHitPoint(set: DistanceBrickSet, a0: number): [number, number, number] {
  const size = set.voxel * DISTANCE_BRICK_CELLS;
  const q = [a0 & 2047, (a0 >>> 11) & 2047, (a0 >>> 22) & 1023];
  const bits = [2048, 2048, 1024];
  return [0, 1, 2].map((k) => set.min[k]! + ((q[k]! + 0.5) / bits[k]!) * set.dims[k]! * size) as [number, number, number];
}

/** A world normal in the set's root space (through the world → local map's inverse transpose). */
export function localNormal(worldToLocal: Affine, n: readonly number[]): [number, number, number] {
  const m = invertAffine(worldToLocal);
  const v = [0, 1, 2].map((c) => m[c]! * n[0]! + m[4 + c]! * n[1]! + m[8 + c]! * n[2]!);
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

/**
 * Where a point of a placed piece keeps its light at cache level `level`:
 * metres along its UV1 chart, or its surfel's index (null: no surfel near).
 */
export function locateModelPoint(set: DistanceBrickSet, chart: SurfaceChart, p: readonly number[], normal: readonly number[], level: number): { u: number; v: number } | { index: number } | null {
  const s = set.surfels;
  if (s === null) return null;
  const k = chart.kind === 'surfels' ? surfelLevelFor(chart, level) : 0;
  const i = nearestSurfel(s, k, p, surfelFacing(normal));
  if (i < 0) return null;
  if (chart.kind === 'surfels') return { index: i };
  return { u: s.uv1![i * 2]! * chart.w, v: s.uv1![i * 2 + 1]! * chart.h };
}
