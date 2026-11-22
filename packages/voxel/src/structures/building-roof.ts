/**
 * Roofs over a building's plan: one cell thick, at 45° (one row up a cell
 * in from the eave), the kind of stair the roof mesher draws as planes.
 *
 * Each polygon is roofed on its own over its cells widened by the overhang
 * (a square widening: the eave and the verge reach the same distance), and
 * the roofs are joined in voxel space by taking the highest roof over each
 * column. A roof's row over a column is the top plus how many cells the
 * column lies in from that polygon's eave: across the ridge axis for a
 * gable (so the ridge runs along `axis` and the ends are gables), along any
 * of the four directions for a hip, none for a flat roof. Over an L or a T
 * the polygons' roofs meet where they are equally high (a valley), and the
 * lower roof inside the higher one is not written; the highest of 45° stairs
 * is a 45° stair again, so the joined roof stays one surface. Outside the
 * walls each polygon's eave and verge are all kept: one wing's verge may
 * rise over the other's eave, and that eave is what closes the wall under it
 * (dropping it opens the attic at an L's inner corner).
 *
 * Walls under a sloped roof rise to meet it: a gable end (a wall whose
 * outside lies along the ridge) up to the row under the roof; an eave wall
 * up to two rows under it, so the eave cell sits a cell out and up from the
 * wall's top, as the bench's houses and the roof mesher expect.
 */
import type { StructureDefinition } from './definition';
import { NO_ROOF, type PlanGrid } from './building-plan';

/** A polygon's cells widened by `r` cells in x and z (a square widening). */
function widen(mask: Uint8Array, w: number, d: number, r: number): Uint8Array {
  if (r === 0) return mask;
  const a = new Uint8Array(mask.length);
  for (let ix = 0; ix < w; ix++) for (let iz = 0; iz < d; iz++) {
    if (mask[ix * d + iz] === 0) continue;
    for (let o = -r; o <= r; o++) {
      const jx = ix + o;
      if (jx >= 0 && jx < w) a[jx * d + iz] = 1;
    }
  }
  const b = new Uint8Array(mask.length);
  for (let ix = 0; ix < w; ix++) for (let iz = 0; iz < d; iz++) {
    if (a[ix * d + iz] === 0) continue;
    for (let o = -r; o <= r; o++) {
      const jz = iz + o;
      if (jz >= 0 && jz < d) b[ix * d + jz] = 1;
    }
  }
  return b;
}

/** Per cell of `m`, how many cells of `m` follow it in a row before its edge, toward −x, +x, −z and +z. */
function runs(m: Uint8Array, w: number, d: number): [Int32Array, Int32Array, Int32Array, Int32Array] {
  const n = m.length;
  const mx = new Int32Array(n);
  const px = new Int32Array(n);
  const mz = new Int32Array(n);
  const pz = new Int32Array(n);
  for (let iz = 0; iz < d; iz++) {
    for (let ix = 1; ix < w; ix++) if (m[ix * d + iz] && m[(ix - 1) * d + iz]) mx[ix * d + iz] = mx[(ix - 1) * d + iz]! + 1;
    for (let ix = w - 2; ix >= 0; ix--) if (m[ix * d + iz] && m[(ix + 1) * d + iz]) px[ix * d + iz] = px[(ix + 1) * d + iz]! + 1;
  }
  for (let ix = 0; ix < w; ix++) {
    for (let iz = 1; iz < d; iz++) if (m[ix * d + iz] && m[ix * d + iz - 1]) mz[ix * d + iz] = mz[ix * d + iz - 1]! + 1;
    for (let iz = d - 2; iz >= 0; iz--) if (m[ix * d + iz] && m[ix * d + iz + 1]) pz[ix * d + iz] = pz[ix * d + iz + 1]! + 1;
  }
  return [mx, px, mz, pz];
}

/** The roof's row over each column of the plan, and each wall column's highest wall row. */
export function roofRows(def: StructureDefinition, g: PlanGrid, top: number): { roofY: Int32Array; wallTop: Int32Array; eaves: Map<number, number[]> } {
  const { w, d } = g;
  const n = w * d;
  const roofY = new Int32Array(n).fill(NO_ROOF);
  const rows: number[][] = [];
  const { shape, overhang, axis } = def.roof;
  for (const poly of g.polygons) {
    const m = widen(poly, w, d, overhang);
    const [mx, px, mz, pz] = shape === 'flat' ? [null, null, null, null] : runs(m, w, d);
    for (let i = 0; i < n; i++) {
      if (m[i] === 0) continue;
      let up = 0;
      if (shape === 'gable') up = axis === 'x' ? Math.min(mz![i]!, pz![i]!) : Math.min(mx![i]!, px![i]!);
      else if (shape === 'hip') up = Math.min(mx![i]!, px![i]!, mz![i]!, pz![i]!);
      if (top + up > roofY[i]!) roofY[i] = top + up;
      if (g.inside[i] === 0) (rows[i] ??= []).push(top + up);
    }
  }
  // Outside the walls every polygon's own eave and verge stay: where one wing's verge rises over another's eave,
  // the lower eave is what closes the wall under it.
  const eaves = new Map<number, number[]>();
  rows.forEach((r, i) => {
    const lower = [...new Set(r)].filter((y) => y !== roofY[i]).sort((a, b) => a - b);
    if (lower.length > 0) eaves.set(i, lower);
  });
  const wallTop = new Int32Array(n).fill(top - 1);
  if (shape === 'flat') return { roofY, wallTop, eaves };
  const outside = (ix: number, iz: number): boolean => ix < 0 || iz < 0 || ix >= w || iz >= d || g.inside[ix * d + iz] === 0;
  for (let ix = 0; ix < w; ix++) for (let iz = 0; iz < d; iz++) {
    const i = ix * d + iz;
    if (g.wall[i] === 0) continue;
    const gableEnd = shape === 'gable' && (axis === 'x' ? outside(ix - 1, iz) || outside(ix + 1, iz) : outside(ix, iz - 1) || outside(ix, iz + 1));
    wallTop[i] = Math.max(top - 1, roofY[i]! - (gableEnd ? 1 : 2));
  }
  return { roofY, wallTop, eaves };
}
