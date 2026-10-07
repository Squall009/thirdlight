/**
 * Cutting a wall face at the wall paint points' lines — a block layer with
 * wall paint draws its walls with a vertex at every point
 * (`block-wall-paint.ts`), so paint between the cell corners shows (vertex
 * colours only change at vertices).
 *
 * A vertical convex polygon (a triangle, or a quad the mesher put together
 * from the two triangles of a face, which cuts into half the triangles) is
 * split along the vertical lines `across = m · step` (layer metres along the
 * wall) and the horizontal lines `y = k · stepY`, then each convex piece is
 * fanned into triangles, wound as the polygon was. The lines are the same
 * for every wall of the layer, so two walls meeting in a plane get the same
 * vertices along their seam. A vertex on a line takes the line's value
 * exactly.
 */

/** A vertex while cutting: position and normal. */
export type CutVertex = [number, number, number, number, number, number];

/** A vertex closer than this (metres) to a line counts as on it. */
const ON_LINE = 1e-6;

function split(poly: CutVertex[], axis: number, value: number): [CutVertex[], CutVertex[]] {
  const below: CutVertex[] = [];
  const above: CutVertex[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = a[axis]! - value;
    const db = b[axis]! - value;
    const onA = Math.abs(da) <= ON_LINE;
    if (onA) {
      const v = [...a] as CutVertex;
      v[axis] = value;
      below.push(v);
      above.push(v);
    } else (da < 0 ? below : above).push(a);
    if (!onA && Math.abs(db) > ON_LINE && da < 0 !== db < 0) {
      const t = da / (da - db);
      const v = a.map((x, k) => x + (b[k]! - x) * t) as CutVertex;
      v[axis] = value;
      below.push(v);
      above.push(v);
    }
  }
  return [below, above];
}

/**
 * The pieces of a convex polygon cut on the lines along `across` (0 x, 2 z)
 * every `step` metres and along y every `stepY` metres, as triangles. A
 * polygon no line crosses comes back fanned whole.
 */
export function cutWallPolygon(poly: readonly CutVertex[], across: number, step: number, stepY: number): CutVertex[][] {
  let polys: CutVertex[][] = [poly.map((v) => [...v] as CutVertex)];
  const cut = (axis: number, s: number): void => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of poly) {
      lo = Math.min(lo, v[axis]!);
      hi = Math.max(hi, v[axis]!);
    }
    for (let m = Math.ceil(lo / s - 1e-9); m * s < hi - ON_LINE; m++) {
      const value = m * s;
      if (value <= lo + ON_LINE) continue;
      const next: CutVertex[][] = [];
      for (const poly of polys) for (const part of split(poly, axis, value)) if (part.length >= 3) next.push(part);
      polys = next;
    }
  };
  cut(across, step);
  cut(1, stepY);
  const out: CutVertex[][] = [];
  for (const poly of polys) {
    for (let i = 1; i + 1 < poly.length; i++) {
      const t: CutVertex[] = [poly[0]!, poly[i]!, poly[i + 1]!];
      // A fan over points in a row (a split point on an edge) gives slivers of no area: left out.
      const ex = t[1]![0] - t[0]![0], ey = t[1]![1] - t[0]![1], ez = t[1]![2] - t[0]![2];
      const fx = t[2]![0] - t[0]![0], fy = t[2]![1] - t[0]![1], fz = t[2]![2] - t[0]![2];
      if (Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx) > 1e-10) out.push(t);
    }
  }
  return out;
}
