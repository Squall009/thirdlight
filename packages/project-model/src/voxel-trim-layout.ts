/**
 * The trim layout for voxel kit detail pieces, as the kit check reads it:
 * **DRAFT — not v1** (docs/architecture/voxel-trim-layout.md, awaiting the
 * owner). Its regions, sheet size and density are the draft's numbers
 * (its sheet and regions tables); nothing but the kit check's draft rows
 * reads them, and they change with the draft until the owner approves it.
 *
 * Pixels are on the authored sheet (glTF convention: v from the top). A
 * field or strip tiles in u (any u is inside it); a cap is one square
 * cell. A UV must stay half a texel inside its region.
 */

export interface TrimRegion {
  readonly id: string;
  readonly kind: 'field' | 'strip' | 'profiled' | 'cap';
  /** The region's real height (field, strips) or side (caps), metres. */
  readonly metres: number;
  /** Usable pixel rows, top to bottom (exclusive end). */
  readonly y: readonly [number, number];
  /** Usable pixel columns of a cap cell (absent: tiles in u). */
  readonly x?: readonly [number, number];
}

export interface TrimLayout {
  readonly id: string;
  readonly draft: boolean;
  /** Authored sheet side, pixels. */
  readonly size: number;
  /** Authored pixels a metre. */
  readonly pxPerMetre: number;
  readonly regions: readonly TrimRegion[];
}

const strip = (id: string, kind: TrimRegion['kind'], metres: number, y0: number, y1: number): TrimRegion => Object.freeze({ id, kind, metres, y: Object.freeze([y0, y1] as const) });
const caps = (size: string, metres: number, y: [number, number], xs: [number, number][]): TrimRegion[] =>
  xs.map(([x0, x1], k) => Object.freeze({ id: `C${size}${'abcd'[k]}`, kind: 'cap' as const, metres, y: Object.freeze(y), x: Object.freeze([x0, x1] as const) }));

/** The draft layout `detail-trim` (v0): a 4096² sheet at 1024 px/m, field, plain and profiled strips, caps in three sizes × four cells. */
export const DRAFT_TRIM_LAYOUT: TrimLayout = Object.freeze({
  id: 'detail-trim',
  draft: true,
  size: 4096,
  pxPerMetre: 1024,
  regions: Object.freeze([
    strip('F1', 'field', 1, 32, 1056),
    strip('S50', 'strip', 0.5, 1120, 1632),
    strip('S50p', 'profiled', 0.5, 1696, 2208),
    strip('S25', 'strip', 0.25, 2272, 2528),
    strip('S25p', 'profiled', 0.25, 2592, 2848),
    strip('S12', 'strip', 0.125, 2912, 3040),
    strip('S12p', 'profiled', 0.125, 3104, 3232),
    ...caps('50', 0.5, [3296, 3808], [[32, 544], [608, 1120], [1184, 1696], [1760, 2272]]),
    ...caps('25', 0.25, [3296, 3552], [[2336, 2592], [2656, 2912], [2976, 3232], [3296, 3552]]),
    ...caps('12', 0.125, [3616, 3744], [[2336, 2464], [2528, 2656], [2720, 2848], [2912, 3040]]),
  ]),
});

/** Trim layouts by id (a kit's `trimLayout` names one). */
export const TRIM_LAYOUTS: ReadonlyMap<string, TrimLayout> = new Map([[DRAFT_TRIM_LAYOUT.id, DRAFT_TRIM_LAYOUT]]);

/** The region holding a UV (u, v in sheet units, glTF v), half a texel inside, or null (a gutter or reserved space). */
export function trimRegionAt(layout: TrimLayout, u: number, v: number): TrimRegion | null {
  const inset = 0.5;
  const px = u * layout.size;
  const py = v * layout.size;
  for (const r of layout.regions) {
    if (py < r.y[0] + inset - 1e-6 || py > r.y[1] - inset + 1e-6) continue;
    if (r.x === undefined) return r;
    if (px >= r.x[0] + inset - 1e-6 && px <= r.x[1] - inset + 1e-6) return r;
  }
  return null;
}
