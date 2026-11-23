/**
 * The structure mode's openings, as maths the Openings tool and its panel
 * share: the wall under the pointer, an opening of a chosen size snapped to
 * that wall's cells at that storey, its cells (the ghost), the reason one is
 * refused, and the props that fit it.
 *
 * An opening sits on a polygon's edge, `at` cells from the edge's start (the
 * voxel package's `openingCells`). The tool keeps an opening off the edge's
 * two end cells (a wall's corner belongs to both walls that meet there) and a
 * cell away from any other opening on its wall: two openings side by side
 * would be one hole, one portal joined to one prop where the world runs. The
 * building generator's checks refuse the rest (off its storey, inside the
 * building where wings meet, over another opening).
 *
 * Pure (no DOM, no three.js).
 */
import { openingCells, openingFrame, OPENING_SIZES, propFitsOpening, VOXEL_SIZE_M, yawQuaternion, type OpeningSize, type StructureDefinition, type StructureOpening } from '@thirdlight/voxel';

import { structureProblem } from './structure-shape';

/** A wall of a structure: a polygon's edge on one storey. */
export interface StructureWall {
  readonly polygon: string;
  readonly edge: number;
  readonly storey: number;
  /** Cells along the edge. */
  readonly length: number;
  /** The cell under the pointer: its index along the edge from its start, and its row over the storey's floor. */
  readonly along: number;
  readonly row: number;
}

/** What an opening is made as: a door (sill 0) or a window, its width, height and sill in cells. */
export interface OpeningShape {
  readonly kind: 'door' | 'window';
  readonly width: number;
  readonly height: number;
  readonly sill: number;
}

/** An edge's end points, whether it runs along x, its length (cells) and its step (+1 / −1). */
function edgeOf(def: StructureDefinition, polygon: string, edge: number): { a: readonly [number, number]; b: readonly [number, number]; alongX: boolean; length: number; step: number } | null {
  const poly = def.footprint.find((p) => p.id === polygon);
  if (poly === undefined || edge >= poly.points.length) return null;
  const a = poly.points[edge]!;
  const b = poly.points[(edge + 1) % poly.points.length]!;
  const alongX = a[1] === b[1];
  const d = alongX ? b[0] - a[0] : b[1] - a[1];
  return { a, b, alongX, length: Math.abs(d), step: Math.sign(d) };
}

/**
 * The wall a structure cell belongs to (null: no wall there: a roof, a floor's slab, a cell inside). A corner cell
 * belongs to two walls: the one whose outside the face `normal` (the pick's, in the grid) looks along is taken.
 */
export function wallUnderCell(def: StructureDefinition, cell: readonly [number, number, number], normal: readonly [number, number, number] = [0, 0, 0]): StructureWall | null {
  const h = def.storeyHeight;
  const storey = Math.floor(cell[1] / h);
  const row = cell[1] - storey * h - 1;
  if (storey < 0 || storey >= def.storeys || row < 0) return null;
  let best: StructureWall | null = null;
  let bestScore = -1;
  for (const p of def.footprint) {
    for (let k = 0; k < p.points.length; k++) {
      const e = edgeOf(def, p.id, k)!;
      // The edge's cells as an opening the whole edge long would take them (inside row, outward direction).
      const c = openingCells(def, { id: '', polygon: p.id, edge: k, storey, at: 0, width: e.length, height: 1, sill: 0 });
      if (c === null) continue;
      const j = c.columns.findIndex((q) => q[0] === cell[0] && q[1] === cell[2]);
      if (j < 0) continue;
      // Facing: the face looks out of (or into) this wall; a corner's other wall looks across it.
      const score = Math.abs(c.out[0] * normal[0] + c.out[1] * normal[2]);
      if (score > bestScore) {
        bestScore = score;
        best = { polygon: p.id, edge: k, storey, length: e.length, along: j, row };
      }
    }
  }
  return best;
}

/** The cell along a wall (from its start) an opening of `width` starts at to be centred on `along`, kept off the wall's end cells. */
export function snapAlong(wall: Pick<StructureWall, 'length' | 'along'>, width: number): number {
  const at = Math.round(wall.along - (width - 1) / 2);
  return Math.max(1, Math.min(wall.length - 1 - width, at));
}

/** The next free id for an opening of a kind (`door-1`, `window-2`, …). */
export function nextOpeningId(def: StructureDefinition, kind: 'door' | 'window'): string {
  const taken = new Set(def.openings.map((o) => o.id));
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

/** An opening of `shape` on `wall`, centred on the cell under the pointer (snapped to the wall's cells). */
export function openingOnWall(def: StructureDefinition, wall: StructureWall, shape: OpeningShape, id = nextOpeningId(def, shape.kind)): StructureOpening {
  return { id, polygon: wall.polygon, edge: wall.edge, storey: wall.storey, at: snapAlong(wall, shape.width), width: shape.width, height: shape.height, sill: shape.sill };
}

/** The definition with an opening added, or put in place of the one of its id. */
export function withOpening(def: StructureDefinition, o: StructureOpening): StructureDefinition {
  const i = def.openings.findIndex((x) => x.id === o.id);
  const openings = i < 0 ? [...def.openings, o] : def.openings.map((x, k) => (k === i ? o : x));
  return { ...def, openings };
}

/** The definition without an opening. */
export function withoutOpening(def: StructureDefinition, id: string): StructureDefinition {
  return { ...def, openings: def.openings.filter((o) => o.id !== id) };
}

/** The opening `id` of `def` moved `cells` along its wall. */
export function movedOpening(def: StructureDefinition, id: string, cells: number): StructureOpening | null {
  const o = def.openings.find((x) => x.id === id);
  return o === undefined ? null : { ...o, at: o.at + cells };
}

/**
 * Why the structure mode does not send an opening (null: it may): off a wall's end cells, touching another opening on
 * its wall, then whatever the building generator's checks say of the definition with it (each said in words).
 */
export function openingProblem(def: StructureDefinition, o: StructureOpening): string | null {
  const e = edgeOf(def, o.polygon, o.edge);
  if (e === null) return `The opening's wall (edge ${o.edge} of polygon "${o.polygon}") is not in the footprint.`;
  if (o.width < 1 || o.height < 1 || o.sill < 0) return 'An opening is at least one cell wide and one tall, its sill at or over the floor.';
  if (o.at < 1 || o.at + o.width > e.length - 1) return `The opening reaches a corner of its wall: keep it within cells 1 to ${e.length - 2} of this ${e.length}-cell wall (the end cells are the corners), or make it narrower.`;
  for (const x of def.openings) {
    if (x.id === o.id || x.polygon !== o.polygon || x.edge !== o.edge || x.storey !== o.storey) continue;
    const apart = Math.max(x.at - (o.at + o.width), o.at - (x.at + x.width));
    const rowsMeet = x.sill <= o.sill + o.height && o.sill <= x.sill + x.height;
    if (apart < 0 && rowsMeet) return `The opening overlaps "${x.id}" on this wall.`;
    if (apart === 0 && rowsMeet) return `The opening touches "${x.id}": leave at least one cell of wall between two openings (side by side they would be one hole with one prop).`;
  }
  return structureProblem(withOpening(def, o));
}

/** An opening's cells as a box in its structure's grid (metres; null: its wall is not in the footprint). */
export function openingBox(def: StructureDefinition, o: StructureOpening): { min: [number, number, number]; max: [number, number, number] } | null {
  const c = openingCells(def, o);
  if (c === null) return null;
  const m = VOXEL_SIZE_M;
  return { min: [c.min[0] * m, c.min[1] * m, c.min[2] * m], max: [(c.max[0] + 1) * m, (c.max[1] + 1) * m, (c.max[2] + 1) * m] };
}

/** The opening a structure cell is in (null: none). */
export function openingAtCell(def: StructureDefinition, cell: readonly [number, number, number]): StructureOpening | null {
  for (const o of def.openings) {
    const c = openingCells(def, o);
    if (c === null || cell[1] < c.y0 || cell[1] > c.y1) continue;
    if (c.columns.some((q) => q[0] === cell[0] && q[1] === cell[2])) return o;
  }
  return null;
}

/** The standard sizes the mode offers, then "custom" (cells set by hand). */
export const OPENING_CHOICES: readonly OpeningSize[] = OPENING_SIZES;

/** A size as the list and the status line say it: "Door 1.5 × 2.5 m", "Window 1 × 1 m, sill 1 m". */
export function openingWords(o: Pick<StructureOpening, 'width' | 'height' | 'sill'>): string {
  const m = (c: number): string => String(c * VOXEL_SIZE_M);
  return o.sill === 0 ? `Door ${m(o.width)} × ${m(o.height)} m` : `Window ${m(o.width)} × ${m(o.height)} m, sill ${m(o.sill)} m`;
}

/** A model asset as the prop picker reads it: its bounds in its own frame (null: not recorded at its import). */
export interface PropAsset {
  readonly assetId: string;
  readonly displayName: string;
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] } | null;
}

/** A model offered for an opening: whether it fits (null: its size is unknown). */
export interface PropChoice {
  readonly asset: PropAsset;
  readonly fits: boolean | null;
}

/**
 * The project's models for an opening: those that fit it (bounds within the opening, one cell deep, the voxel
 * package's fit rule) first, then those whose size is unknown (imported before bounds were recorded); models that
 * do not fit are left out.
 */
export function propChoices(assets: readonly PropAsset[], o: Pick<StructureOpening, 'width' | 'height'>): PropChoice[] {
  const out: PropChoice[] = [];
  for (const a of assets) {
    if (a.bounds === null) {
      out.push({ asset: a, fits: null });
      continue;
    }
    const size: [number, number, number] = [0, 1, 2].map((k) => a.bounds!.max[k]! - a.bounds!.min[k]!) as [number, number, number];
    if (propFitsOpening(size, o)) out.push({ asset: a, fits: true });
  }
  return out.sort((x, y) => (x.fits === true ? 0 : 1) - (y.fits === true ? 0 : 1) || x.asset.displayName.localeCompare(y.asset.displayName));
}

/**
 * Where a prop of a model stands in an opening (its structure's frame): its bounds centred on the opening's width and
 * the wall's thickness, their bottom on the sill, its +x along the wall and +z out (a model of unknown bounds: its
 * origin at the frame).
 */
export function propPlacement(def: StructureDefinition, o: StructureOpening, bounds: PropAsset['bounds']): { position: [number, number, number]; rotation: [number, number, number, number] } | null {
  const f = openingFrame(def, o);
  if (f === null) return null;
  const off = bounds === null ? [0, 0, 0] : [-(bounds.min[0]! + bounds.max[0]!) / 2, -bounds.min[1]!, -(bounds.min[2]! + bounds.max[2]!) / 2];
  const c = Math.cos(f.yawRad);
  const s = Math.sin(f.yawRad);
  // R(yaw) about +y: x' = c x + s z, z' = −s x + c z.
  const position: [number, number, number] = [f.position[0] + c * off[0]! + s * off[2]!, f.position[1] + off[1]!, f.position[2] - s * off[0]! + c * off[2]!];
  return { position, rotation: yawQuaternion(f.yawRad) };
}

/** Whether a prop whose bounds are known no longer fits its opening (after a resize; false: it fits or its size is unknown). */
export function propOutgrown(bounds: PropAsset['bounds'], o: Pick<StructureOpening, 'width' | 'height'>): boolean {
  if (bounds === null) return false;
  return !propFitsOpening([0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!) as [number, number, number], o);
}
