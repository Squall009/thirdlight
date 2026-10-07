/**
 * Cut-aways: parts of a block layer hidden from the view while the subject
 * (the camera's target, or what a game names) is under or inside them — the
 * roof over the room the player walks in, the floors above a dungeon level.
 * They change what is drawn only: collision, grid queries, shadows and baked
 * lighting stay as if nothing were cut.
 *
 * A layer marks them in its component (`blockLayer.cutaway`):
 * - a region (`regions[].region`, one of the layer's named regions): its
 *   cells are hidden while the subject stands under one of its boxes (within
 *   the box's columns, below its lowest row) — the roof and upper floors over
 *   the subject; with `when`, while the subject is inside that other region
 *   instead (the walls round a room the player is in);
 * - a height plane (`planes[]`, a row): every cell from that row up is hidden
 *   while the subject is below the row.
 *
 * Each is a zone, named by its region id or `#<row>` for a plane (a region
 * id never holds `#`); scripts force zones by these names. `fade` is the
 * seconds a zone takes to fade out or back in.
 *
 * Pure data: validation, the canonical form, the zones a component and its
 * regions make, and whether a subject cuts a zone.
 */
import type { ModelErrorV2 } from './errors';
import { BLOCK_LIMITS, REGION_ID_RE, type BlockLayerComponent } from './block-layers';

export interface BlockCutawayRegion {
  /** The region whose cells are hidden. */
  region: string;
  /** Cut while the subject is inside this region (absent: while it is under `region`). */
  when?: string;
}

export interface BlockCutaway {
  regions?: BlockCutawayRegion[];
  /** Rows: every cell from the row up is hidden while the subject is below it. */
  planes?: number[];
  /** Seconds a zone takes to fade out or back in (absent: {@link CUTAWAY_FADE_SECONDS}; 0: at once). */
  fade?: number;
}

/** A zone's fade when the layer names none (seconds): quick enough to follow a walk through a door. */
export const CUTAWAY_FADE_SECONDS = 0.25;
export const CUTAWAY_FADE_RANGE = Object.freeze({ min: 0, max: 10 });

/** The zone name of a height plane. */
export const cutawayPlaneKey = (row: number): string => `#${row}`;

/** A box of cells `[x0, y0, z0, x1, y1, z1)` (min inclusive, max exclusive). */
export type CutawayBox = readonly [number, number, number, number, number, number];

export interface CutawayZone {
  /** Its name: the region's id, or `#<row>`. */
  readonly key: string;
  /** The cells it hides (a plane: from its row up, every column). */
  readonly boxes: readonly CutawayBox[];
  /** It cuts while the subject is inside these boxes (`when`); null: while the subject is under one of `boxes`. */
  readonly inside: readonly CutawayBox[] | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void => {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
};

export function validateBlockCutaway(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'cutaway is {regions?, planes?, fade?}', v);
  for (const k of Object.keys(v)) if (!['regions', 'planes', 'fade'].includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown cutaway field "${k}"`, k);
  const regions = v['regions'];
  if (regions !== undefined) {
    // As many as a layer has regions.
    if (!Array.isArray(regions) || regions.length > BLOCK_LIMITS.regions) err(errors, 'field_value', `${path}/regions`, `regions is a list of at most ${BLOCK_LIMITS.regions}`, Array.isArray(regions) ? regions.length : regions);
    else {
      const seen = new Set<string>();
      regions.forEach((r, i) => {
        const p = `${path}/regions/${i}`;
        if (!isPlainObject(r)) return err(errors, 'field_type', p, 'a cut-away region is {region, when?}', r);
        for (const k of Object.keys(r)) if (k !== 'region' && k !== 'when') err(errors, 'field_unexpected', `${p}/${k}`, `unknown cut-away region field "${k}"`, k);
        if (typeof r['region'] !== 'string' || !REGION_ID_RE.test(r['region'])) err(errors, 'id_invalid', `${p}/region`, 'region is a region id (1-64 letters, digits, "_", "." or "-")', r['region']);
        else if (seen.has(r['region'])) err(errors, 'id_duplicate', `${p}/region`, 'a region is cut away once', r['region']);
        else seen.add(r['region']);
        if (r['when'] !== undefined && (typeof r['when'] !== 'string' || !REGION_ID_RE.test(r['when']))) err(errors, 'id_invalid', `${p}/when`, 'when is a region id (1-64 letters, digits, "_", "." or "-")', r['when']);
      });
    }
  }
  const planes = v['planes'];
  if (planes !== undefined) {
    // One per row at most.
    if (!Array.isArray(planes) || planes.length > BLOCK_LIMITS.layerHeight) err(errors, 'field_value', `${path}/planes`, `planes is a list of at most ${BLOCK_LIMITS.layerHeight} rows`, Array.isArray(planes) ? planes.length : planes);
    else {
      const seen = new Set<number>();
      planes.forEach((row, i) => {
        if (typeof row !== 'number' || !Number.isSafeInteger(row) || Math.abs(row) > BLOCK_LIMITS.coordinateY) err(errors, 'field_value', `${path}/planes/${i}`, `a plane is a row within ±${BLOCK_LIMITS.coordinateY}`, row);
        else if (seen.has(row)) err(errors, 'field_value', `${path}/planes/${i}`, 'a row has one plane', row);
        else seen.add(row);
      });
    }
  }
  const fade = v['fade'];
  if (fade !== undefined && (typeof fade !== 'number' || !Number.isFinite(fade) || fade < CUTAWAY_FADE_RANGE.min || fade > CUTAWAY_FADE_RANGE.max)) err(errors, 'field_value', `${path}/fade`, `fade is seconds in ${CUTAWAY_FADE_RANGE.min}-${CUTAWAY_FADE_RANGE.max}`, fade);
}

/** The stored form: regions by id, planes ascending, empty lists left out (undefined: nothing to store). */
export function canonicalBlockCutaway(c: BlockCutaway | undefined): BlockCutaway | undefined {
  if (c === undefined) return undefined;
  const regions = [...(c.regions ?? [])].sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0)).map((r) => ({ region: r.region, ...(r.when !== undefined ? { when: r.when } : {}) }));
  const planes = [...(c.planes ?? [])].sort((a, b) => a - b);
  const out: BlockCutaway = { ...(regions.length > 0 ? { regions } : {}), ...(planes.length > 0 ? { planes } : {}), ...(c.fade !== undefined ? { fade: c.fade === 0 ? 0 : c.fade } : {}) };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The zone names a layer's cut-away defines (what scripts may force). */
export function cutawayZoneKeys(c: Pick<BlockLayerComponent, 'cutaway'>): string[] {
  return [...(c.cutaway?.regions ?? []).map((r) => r.region), ...(c.cutaway?.planes ?? []).map(cutawayPlaneKey)];
}

const asBox = (b: readonly number[]): CutawayBox => [b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!];

/**
 * The zones of a layer: its cut-away regions that exist among `regions`
 * (id → boxes; a missing one, or one whose `when` is missing, makes no zone)
 * and its planes.
 */
export function cutawayZones(c: Pick<BlockLayerComponent, 'cutaway'>, regions: ReadonlyMap<string, readonly (readonly number[])[]>): CutawayZone[] {
  const out: CutawayZone[] = [];
  for (const r of c.cutaway?.regions ?? []) {
    const boxes = regions.get(r.region);
    if (boxes === undefined || boxes.length === 0) continue;
    let inside: CutawayBox[] | null = null;
    if (r.when !== undefined) {
      const w = regions.get(r.when);
      if (w === undefined || w.length === 0) continue;
      inside = w.map(asBox);
    }
    out.push({ key: r.region, boxes: boxes.map(asBox), inside });
  }
  for (const row of c.cutaway?.planes ?? []) out.push({ key: cutawayPlaneKey(row), boxes: [[-Infinity, row, -Infinity, Infinity, Infinity, Infinity]], inside: null });
  return out;
}

/**
 * Whether a subject at `(x, y, z)` — in cells of the layer, fractional (a
 * point 1.5 m up on 0.5 m rows is y 3) — cuts the zone: inside its `when`
 * region, or within the columns of one of its boxes and below that box.
 */
export function cutawayCuts(zone: CutawayZone, x: number, y: number, z: number): boolean {
  if (zone.inside !== null) {
    for (const b of zone.inside) if (x >= b[0] && x < b[3] && y >= b[1] && y < b[4] && z >= b[2] && z < b[5]) return true;
    return false;
  }
  for (const b of zone.boxes) if (x >= b[0] && x < b[3] && z >= b[2] && z < b[5] && y < b[1]) return true;
  return false;
}

/**
 * The seam group of each cell for the mesher (`BlockTopOptions.seams`): the
 * zones whose boxes hold it, as bits (zones past the 30th share bits: such a
 * pair keeps a face between them that it could have hidden). Undefined
 * without zones.
 */
export function cutawaySeams(zones: readonly CutawayZone[]): ((x: number, y: number, z: number) => number) | undefined {
  if (zones.length === 0) return undefined;
  return (x, y, z) => {
    let bits = 0;
    for (let i = 0; i < zones.length; i += 1) {
      for (const b of zones[i]!.boxes) {
        if (x >= b[0] && x < b[3] && y >= b[1] && y < b[4] && z >= b[2] && z < b[5]) {
          bits |= 1 << i % 30;
          break;
        }
      }
    }
    return bits;
  };
}
