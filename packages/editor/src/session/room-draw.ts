/**
 * The Rooms tool's geometry (browser-free): rooms and runs drawn on a block
 * layer as outlines of generated architecture, snapped to the layer's cell
 * corners.
 *
 * - Rectangle: two corners; polygon: corners clicked one by one (a segment
 *   may be an arc); path: an open run (a rail, a fence, a pipe); building: a
 *   footprint's corners clicked one by one, made a building (a room with a
 *   facade and a roof, `architecture.buildings`). A room or building is
 *   stored with its inside to the right of travel (the generator's rule),
 *   whatever way it was drawn. Openings, wall drags and the room inspector
 *   treat buildings as rooms.
 * - Openings: a door, window or arch put on the wall nearest the pointer,
 *   whole cells wide, centred on the cells it covers.
 * - Wall drag: one straight side of an outline moved across itself by whole
 *   cells (its corners go with it, a neighbour's wall along it too);
 *   openings on the other sides stay where they stood.
 * - Wall and corner pieces: a kit model in place of a straight segment or a
 *   corner of a generated wall (an override of the expanded element: the
 *   rooms' walls, else any sweep of the component).
 *
 * Points are metres in the rooms object's frame (its position is the
 * layer's, so they are also layer metres); y is the floor height drawn on.
 */
import type { ArchitectureBuilding, ArchitectureComponent, ArchitectureElement, ArchitectureModelRef, ArchitectureOpening, ArchitectureOutline, ArchitectureOverride, ArchitecturePath, ArchitectureSweep } from '@thirdlight/project-model';
import { ARCHITECTURE_STOREY_HEIGHT_FALLBACK, sampleArchitecturePath, type ArchitecturePathSamples } from '@thirdlight/runtime';

export type RoomToolMode = 'rect' | 'polygon' | 'path' | 'building' | 'door' | 'window' | 'arch' | 'walls' | 'piece' | 'corner';

/** What the Rooms tool draws with (Rooms & buildings sets it). */
export interface RoomToolOptions {
  mode: RoomToolMode;
  /** The preset new rooms and new runs wear. */
  roomPreset: string;
  pathPreset: string;
  /** The preset a new building's facade wears ("": its inside preset's own outer faces). */
  facadePreset: string;
  /** The next polygon or path segment is an arc bulging this much (tan of a quarter of its angle; 0: straight). */
  bulge: number;
  /** The kit pieces new doors and windows stand in, with the hole each takes (null: the style's reveals and frame). */
  doorPiece: OpeningPiece | null;
  windowPiece: OpeningPiece | null;
  /** The kit pieces a clicked wall segment and a clicked corner take (overrides; null: none picked yet). */
  wallModel: ArchitectureModelRef | null;
  cornerModel: ArchitectureModelRef | null;
}

export const DEFAULT_ROOM_OPTIONS: RoomToolOptions = { mode: 'rect', roomPreset: 'starter-room', pathPreset: 'starter-fence', facadePreset: '', bulge: 0, doorPiece: null, windowPiece: null, wallModel: null, cornerModel: null };

/** A new building: a hip roof over one storey (the inspector sets storeys, the roof and where the interior is). */
export const NEW_BUILDING_ROOF = Object.freeze({ shape: 'hip' as const });

/** A component's rooms, runs and buildings (buildings last), as the tool and the inspector edit them alike. */
export function allOutlines(c: ArchitectureComponent | null): ArchitectureOutline[] {
  return [...(c?.outlines ?? []), ...(c?.buildings ?? [])];
}

/** Whether an outline is one of the component's buildings. */
export function isBuilding(c: ArchitectureComponent | null, id: string): boolean {
  return (c?.buildings ?? []).some((b) => b.id === id);
}

/** A kit piece put in new openings: the model, and the hole it takes (cells wide, metres up from the wall's foot). */
export interface OpeningPiece {
  model: ArchitectureModelRef;
  /** Cells wide on the layer's x cells (what the column shows); a wall along z counts its own cells from `width`. */
  cells: number;
  /** The piece's own width in metres, when known: the hole is the whole cells that hold it, on the wall's axis. */
  width?: number;
  bottom: number;
  top: number;
}

/** The whole cells a piece `width` metres wide needs (at least one; a width a hair over a cell line is that many cells). */
export function cellsFor(width: number, cell: number): number {
  return Math.max(1, Math.ceil(width / cell - 1e-6));
}

/**
 * The hole a kit piece takes: the whole cells that hold its width (at
 * least one), from its slot's sill (`sill`) up its height; a piece whose
 * size is not known takes the opening kind's own size.
 */
export function openingPiece(model: ArchitectureModelRef, kind: 'door' | 'window', sill: number, size: readonly number[] | null, cellSize: readonly number[]): OpeningPiece {
  const k = ROOM_OPENING_KINDS[kind];
  const cells = size === null ? k.cells : cellsFor(size[0]!, cellSize[0]!);
  const height = size === null ? k.top - k.bottom : size[1]!;
  return { model: { ...model }, cells, ...(size !== null ? { width: size[0]! } : {}), bottom: sill, top: round6(sill + height) };
}

/** The openings the tool puts on walls: cells wide, metres up from the wall's foot, a pane or not. */
export const ROOM_OPENING_KINDS = Object.freeze({
  door: { cells: 1, bottom: 0, top: 2.1, pane: false },
  window: { cells: 1, bottom: 0.9, top: 2, pane: true },
  arch: { cells: 2, bottom: 0, top: 2.6, pane: false },
});

export type Point3 = [number, number, number];

/** A metre position snapped to the nearest cell corner (x, z), at height y. */
export function snapCorner(x: number, z: number, y: number, cellSize: readonly number[]): Point3 {
  return [round6(Math.round(x / cellSize[0]!) * cellSize[0]!), round6(y), round6(Math.round(z / cellSize[2]!) * cellSize[2]!)];
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Twice the signed area on the ground (x, z): positive when the inside is to the right of travel. */
export function groundArea2(points: readonly (readonly number[])[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p[0]! * q[2]! - q[0]! * p[2]!;
  }
  return a;
}

/** A closed path with its inside to the right of travel (reversed, arcs and all, when drawn the other way). */
export function roomPath(points: readonly Point3[], bulges: readonly number[]): ArchitecturePath {
  const any = bulges.some((b) => b !== 0);
  if (groundArea2(points) >= 0) return { points: points.map((p) => [...p] as Point3), closed: true, ...(any ? { bulges: [...bulges] } : {}) };
  const n = points.length;
  const pts = [...points].reverse().map((p) => [...p] as Point3);
  // Reversed segment k joins old points n-1-k and n-2-k: the old segment n-2-k walked back (its bulge negated).
  const b = any ? Array.from({ length: n }, (_, k) => -(bulges[(n - 2 - k + n) % n] ?? 0)) : null;
  return { points: pts, closed: true, ...(b !== null ? { bulges: b.map((v) => (v === 0 ? 0 : v)) } : {}) };
}

/** The rectangle between two corners as a room's path (null: no area). */
export function rectPath(a: Point3, b: Point3): ArchitecturePath | null {
  if (a[0] === b[0] || a[2] === b[2]) return null;
  const y = a[1];
  return roomPath(
    [
      [a[0], y, a[2]],
      [b[0], y, a[2]],
      [b[0], y, b[2]],
      [a[0], y, b[2]],
    ],
    [0, 0, 0, 0],
  );
}

/** The first free id `base-N` among the outlines and buildings. */
export function nextOutlineId(c: ArchitectureComponent | null, base: 'room' | 'run' | 'building'): string {
  const taken = new Set(allOutlines(c).map((o) => o.id));
  for (let i = 1; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** The component with one outline added (a new component on the layer when there is none yet). */
export function withOutline(c: ArchitectureComponent | null, layerId: string, o: ArchitectureOutline): ArchitectureComponent {
  const base: ArchitectureComponent = c ?? { elements: [], layer: layerId };
  return { ...base, outlines: [...(base.outlines ?? []), o] };
}

/** The component with one building added (a new component on the layer when there is none yet). */
export function withBuilding(c: ArchitectureComponent | null, layerId: string, b: ArchitectureBuilding): ArchitectureComponent {
  const base: ArchitectureComponent = c ?? { elements: [], layer: layerId };
  return { ...base, buildings: [...(base.buildings ?? []), b] };
}

/**
 * The component with one outline or building replaced (null removes it).
 * The pieces on its walls go with it: removed with it, renamed with it
 * (an override names its element by the outline's id, and one naming an
 * element nothing makes is refused).
 */
export function withOutlineSet(c: ArchitectureComponent, id: string, next: ArchitectureOutline | null): ArchitectureComponent {
  const out = withOutlineOnly(c, id, next);
  if (next !== null && next.id === id) return out;
  const mine = new Set(overridesOf(c, id).map((x) => x.index));
  if (mine.size === 0) return out;
  const overrides = (c.overrides ?? []).flatMap((o, i) => (!mine.has(i) ? [o] : next === null ? [] : [{ ...o, element: next.id + o.element.slice(id.length) }]));
  const { overrides: _v, ...rest } = out;
  return overrides.length > 0 ? { ...rest, overrides } : rest;
}

function withOutlineOnly(c: ArchitectureComponent, id: string, next: ArchitectureOutline | null): ArchitectureComponent {
  if (isBuilding(c, id)) {
    const buildings = (c.buildings ?? []).flatMap((o) => (o.id !== id ? [o] : next !== null ? [next as ArchitectureBuilding] : []));
    const { buildings: _b, ...rest } = c;
    return buildings.length > 0 ? { ...rest, buildings } : rest;
  }
  const outlines = (c.outlines ?? []).flatMap((o) => (o.id !== id ? [o] : next !== null ? [next] : []));
  const { outlines: _o, ...rest } = c;
  return outlines.length > 0 ? { ...rest, outlines } : rest;
}

/** The presets a component's rooms, runs and buildings wear (inside, outside or facade), each with how many outlines wear it, in first-use order. */
export function presetUses(c: ArchitectureComponent | null): { preset: string; outlines: number }[] {
  const counts = new Map<string, number>();
  for (const o of allOutlines(c)) for (const p of new Set([o.preset, ...(o.outside !== undefined ? [o.outside] : [])])) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts].map(([preset, outlines]) => ({ preset, outlines }));
}

/**
 * Every room, run and building wearing preset `from` (inside, outside or
 * facade) wears `to` instead; the outlines, openings and pieces stay as they
 * are — the "swap the style, keep the plan" edit, one component value so one
 * command. Unchanged when nothing wears `from`.
 */
export function withPresetSwapped(c: ArchitectureComponent, from: string, to: string): ArchitectureComponent {
  if (from === to) return c;
  const swap = <T extends ArchitectureOutline>(o: T): T => {
    if (o.preset !== from && o.outside !== from) return o;
    const next: T = { ...o, ...(o.preset === from ? { preset: to } : {}) };
    if (o.outside === from) next.outside = to;
    return next;
  };
  const out: ArchitectureComponent = { ...c };
  if (c.outlines !== undefined) out.outlines = c.outlines.map(swap);
  if (c.buildings !== undefined) out.buildings = c.buildings.map(swap);
  return out;
}

/** A straight side of an outline: its index, ends, and the distance along the outline to its start. */
export interface OutlineSide {
  outline: ArchitectureOutline;
  index: number;
  a: Point3;
  b: Point3;
  start: number;
  length: number;
}

/** An outline's straight sides (arcs and curves are left out: openings and drags go on straight walls). */
export function straightSides(o: ArchitectureOutline): OutlineSide[] {
  if (o.path.curve === true) return [];
  const pts = o.path.points;
  const closed = o.path.closed === true;
  const segs = closed ? pts.length : pts.length - 1;
  const out: OutlineSide[] = [];
  let d = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    // An arc's length is longer than its chord: sides after it cannot be placed by straight distances.
    if ((o.path.bulges?.[i] ?? 0) !== 0) return out;
    out.push({ outline: o, index: i, a: [...a], b: [...b], start: d, length: len });
    d += len;
  }
  return out;
}

/** The side nearest a ground point (x, z) within `reach` metres, and where along it the point falls (metres). */
export function nearestSide(c: ArchitectureComponent | null, x: number, z: number, reach: number, closedOnly: boolean): { side: OutlineSide; along: number; distance: number } | null {
  let best: { side: OutlineSide; along: number; distance: number } | null = null;
  for (const o of allOutlines(c)) {
    if (closedOnly && o.path.closed !== true) continue;
    for (const s of straightSides(o)) {
      const dx = s.b[0] - s.a[0];
      const dz = s.b[2] - s.a[2];
      const l2 = dx * dx + dz * dz;
      if (l2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[2]) * dz) / l2));
      const d = Math.hypot(s.a[0] + dx * t - x, s.a[2] + dz * t - z);
      if (d <= reach && (best === null || d < best.distance)) best = { side: s, along: t * s.length, distance: d };
    }
  }
  return best;
}

/** A side's cell along it: the layer's x cell for a side along x, its z cell for one along z. */
export function sideCell(side: OutlineSide, cellSize: readonly number[]): number {
  return Math.abs(side.b[0] - side.a[0]) >= Math.abs(side.b[2] - side.a[2]) ? cellSize[0]! : cellSize[2]!;
}

/**
 * Where an opening `cells` cells wide stands on a side near `along`
 * (metres from the side's start): centred so it covers whole cells (an
 * odd count: on a cell's middle; even: on a cell line), kept inside the
 * side; `at` is along the whole outline. Null: the side is too short.
 */
export function placeOnSide(side: OutlineSide, along: number, cells: number, cellSize: readonly number[]): { at: number; width: number } | null {
  const cell = sideCell(side, cellSize);
  const width = cells * cell;
  if (width > side.length + 1e-9) return null;
  let mid = cells % 2 === 1 ? (Math.floor(along / cell) + 0.5) * cell : Math.round(along / cell) * cell;
  mid = Math.max(width / 2, Math.min(side.length - width / 2, mid));
  return { at: round6(side.start + mid), width: round6(width) };
}

/** The cells a piece takes on a side: from its own width on the side's axis when known. */
function pieceCellsOn(side: OutlineSide, piece: Pick<OpeningPiece, 'cells' | 'width'>, cellSize: readonly number[]): number {
  return piece.width === undefined ? piece.cells : cellsFor(piece.width, sideCell(side, cellSize));
}

/**
 * An opening on a side, `cells` cells wide, centred so it covers whole cells
 * (an odd count: on a cell's middle; even: on a cell line), kept inside the
 * side. Its id is the first free `<kind>-N` of the outline; `piece`: the kit
 * piece that stands in it (its hole, no pane).
 */
export function openingOn(side: OutlineSide, along: number, kind: keyof typeof ROOM_OPENING_KINDS, cellSize: readonly number[], storey: number, piece: OpeningPiece | null = null): ArchitectureOpening | null {
  const k = piece === null ? ROOM_OPENING_KINDS[kind] : { ...piece, cells: pieceCellsOn(side, piece, cellSize), pane: false };
  const place = placeOnSide(side, along, k.cells, cellSize);
  if (place === null) return null;
  const taken = new Set((side.outline.openings ?? []).map((o) => o.id));
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n++;
  // A kit piece stands in the hole instead of the style's reveals, frame and pane.
  return { id: `${kind}-${n}`, at: place.at, width: place.width, bottom: k.bottom, top: k.top, ...(k.pane ? { pane: true } : {}), ...(storey > 0 ? { storey } : {}), ...(piece !== null ? { model: { ...piece.model } } : {}) };
}

/** The straight side an opening stands on (by its `at` along the outline; null: on an arc or curve, or past the end). */
export function sideOfOpening(o: ArchitectureOutline, at: number): OutlineSide | null {
  const sides = straightSides(o);
  const total = sides.reduce((t, s) => t + s.length, 0);
  const d = o.path.closed === true && total > 0 && sides.length === (o.path.points.length) ? ((at % total) + total) % total : at;
  return sides.find((s) => d >= s.start - 1e-9 && d <= s.start + s.length + 1e-9) ?? null;
}

/**
 * An opening given a kit piece's hole: the whole cells holding the piece on
 * its wall's axis, re-centred on whole cells near where it stood. A string
 * when it cannot be: the wall is too short, or it is not a straight wall.
 */
export function openingResized(o: ArchitectureOutline, opening: ArchitectureOpening, piece: Pick<OpeningPiece, 'cells' | 'width'>, cellSize: readonly number[]): { at: number; width: number } | string {
  const side = sideOfOpening(o, opening.at);
  if (side === null) return `${opening.id} is not on a straight wall: the piece cannot be sized to it.`;
  const cells = pieceCellsOn(side, piece, cellSize);
  const place = placeOnSide(side, opening.at - side.start, cells, cellSize);
  return place ?? `The wall is too short for this piece (${cells} cell${cells === 1 ? '' : 's'} wide).`;
}

/** The across direction of a side (right of travel, on the ground; unit). */
function rightOf(s: OutlineSide): [number, number] {
  const dx = s.b[0] - s.a[0];
  const dz = s.b[2] - s.a[2];
  const l = Math.hypot(dx, dz) || 1;
  return [-dz / l, dx / l];
}

/**
 * How far (metres, right of the side's travel) a drag from (x0, z0) to
 * (x1, z1) moves a side: the drag across it, in whole cells for a side along
 * an axis (else in steps of a cell's width).
 */
export function sideDragOffset(s: OutlineSide, x0: number, z0: number, x1: number, z1: number, cellSize: readonly number[]): number {
  const [rx, rz] = rightOf(s);
  const raw = (x1 - x0) * rx + (z1 - z0) * rz;
  const step = Math.abs(rx) > Math.abs(rz) ? cellSize[0]! : cellSize[2]!;
  return Math.round(raw / step) * step;
}

const samePoint = (p: readonly number[], q: readonly number[]): boolean => Math.abs(p[0]! - q[0]!) < 1e-6 && Math.abs(p[1]! - q[1]!) < 1e-6 && Math.abs(p[2]! - q[2]!) < 1e-6;

/**
 * An outline's openings after some of its corners moved, each kept where it
 * stood on its own side. An opening's `at` is a distance along the whole
 * outline, so a side that grew or shrank would slide every opening after it
 * (and leave their door pieces behind in the layer). A side whose start
 * corner stayed keeps its openings' distance from the start; one whose start
 * moved and end stayed keeps their distance from the end; a side moved whole
 * carries them along. An opening is kept inside its side when the side got
 * shorter than where it stood.
 */
function openingsKept(before: ArchitectureOutline, after: ArchitectureOutline): ArchitectureOpening[] | undefined {
  const list = before.openings;
  if (list === undefined || list.length === 0) return list;
  const pb = before.path.points;
  const pa = after.path.points;
  const n = pb.length;
  const closed = before.path.closed === true;
  const segs = closed ? n : n - 1;
  if (segs < 1 || pa.length !== n) return list;
  // The generator's own distances (arcs, chamfers and offsets in), so `at` keeps meaning what it draws.
  const sb = sampleArchitecturePath(before.path);
  const sa = sampleArchitecturePath(after.path);
  const startOf = (s: ArchitecturePathSamples, k: number): number => s.pointDist[k]!;
  const endOf = (s: ArchitecturePathSamples, k: number): number => (k + 1 < n ? s.pointDist[k + 1]! : s.length);
  let changed = false;
  const out = list.map((o) => {
    const at = closed && sb.length > 0 ? ((o.at % sb.length) + sb.length) % sb.length : o.at;
    let k = 0;
    while (k + 1 < segs && startOf(sb, k + 1) <= at) k++;
    const startMoved = !samePoint(pb[k]!, pa[k]!);
    const endMoved = !samePoint(pb[(k + 1) % n]!, pa[(k + 1) % n]!);
    if (!startMoved && !endMoved && startOf(sb, k) === startOf(sa, k)) return o;
    const s0 = startOf(sa, k);
    const s1 = endOf(sa, k);
    let next = startMoved && !endMoved ? s1 - (endOf(sb, k) - at) : s0 + (at - startOf(sb, k));
    const half = o.width / 2;
    next = s1 - s0 >= o.width ? Math.max(s0 + half, Math.min(s1 - half, next)) : (s0 + s1) / 2;
    next = round6(next);
    if (next === o.at) return o;
    changed = true;
    return { ...o, at: next };
  });
  return changed ? out : list;
}

/** The outline with new corners, its openings kept on their sides. */
function withCorners(o: ArchitectureOutline, points: Point3[]): ArchitectureOutline {
  const next: ArchitectureOutline = { ...o, path: { ...o.path, points } };
  const openings = openingsKept(o, next);
  return openings === o.openings ? next : { ...next, openings: openings! };
}

/**
 * A wall dragged: side `index` of outline `id` moved `offset` metres to the
 * right of its travel, and the wall of any room beside it that runs along
 * the same line over part of it or all (as the generator shares walls: one
 * wall, partly or wholly shared) moved with it, so a shared wall stays
 * shared. Openings stay where they stood on every other side.
 */
export function moveWall(c: ArchitectureComponent, id: string, index: number, offset: number): ArchitectureComponent {
  const o = allOutlines(c).find((x) => x.id === id);
  const side = o === undefined ? undefined : straightSides(o).find((s) => s.index === index);
  if (o === undefined || side === undefined || offset === 0) return c;
  const [rx, rz] = rightOf(side);
  const shift = (p: readonly number[]): Point3 => [round6(p[0]! + rx * offset), p[1]!, round6(p[2]! + rz * offset)];
  const ux = (side.b[0] - side.a[0]) / (side.length || 1);
  const uz = (side.b[2] - side.a[2]) / (side.length || 1);
  /** Where a point lies against the side's line: across it and along it (metres). */
  const across = (p: readonly number[]): number => (p[0]! - side.a[0]) * -uz + (p[2]! - side.a[2]) * ux;
  const along = (p: readonly number[]): number => (p[0]! - side.a[0]) * ux + (p[2]! - side.a[2]) * uz;
  const move = <T extends ArchitectureOutline>(x: T): T => {
    if (x.id === id) {
      const pts = x.path.points.map((p) => [...p] as Point3);
      for (const i of [index, (index + 1) % pts.length]) pts[i] = shift(pts[i]!);
      return withCorners(x, pts) as T;
    }
    if (x.path.curve === true) return x;
    const pts = x.path.points;
    const n = pts.length;
    const segs = x.path.closed === true ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      if ((x.path.bulges?.[i] ?? 0) !== 0) continue;
      const p = pts[i]!;
      const q = pts[(i + 1) % n]!;
      if (Math.abs(across(p)) > 1e-6 || Math.abs(across(q)) > 1e-6 || Math.abs(p[1] - side.a[1]) > 1e-6 || Math.abs(q[1] - side.a[1]) > 1e-6) continue;
      const lo = Math.max(0, Math.min(along(p), along(q)));
      const hi = Math.min(side.length, Math.max(along(p), along(q)));
      // Touching at a corner is not sharing: only a stretch of wall in common moves it.
      if (hi - lo < 1e-5) continue;
      const next = pts.map((r) => [...r] as Point3);
      next[i] = shift(p);
      next[(i + 1) % n] = shift(q);
      return withCorners(x, next) as T;
    }
    return x;
  };
  return { ...c, ...(c.outlines !== undefined ? { outlines: c.outlines.map(move) } : {}), ...(c.buildings !== undefined ? { buildings: c.buildings.map(move) } : {}) };
}


// ---- wall and corner pieces (overrides) --------------------------------------------------

/** A straight segment of an expanded element's path (point `segment` to the next), in the object's frame. */
export interface ElementSegment {
  element: string;
  segment: number;
  a: Point3;
  b: Point3;
}

/** A point of an expanded element's path (a corner a piece may stand in). */
export interface ElementCorner {
  element: string;
  corner: number;
  p: Point3;
}

/** The sweeps a piece is put on: the rooms' walls (the style's sweeps marked `wall`), else every sweep (raw elements). */
function pieceSweeps(elements: readonly ArchitectureElement[]): ArchitectureSweep[] {
  const sweeps = elements.filter((e): e is ArchitectureSweep => e.kind === 'sweep');
  const walls = sweeps.filter((e) => e.wall === true);
  return walls.length > 0 ? walls : sweeps;
}

/**
 * How near a wall point is to the pointer: on the ground within `reach`
 * metres, then by height when the pointer's is known (`y`: the floor it is
 * on), so an upper storey's wall, standing over the ground storey's, is
 * picked from its own floor.
 */
function pickDistance(ground: number, footY: number, y: number | undefined): number {
  return y === undefined ? ground : Math.hypot(ground, footY - y);
}

/** The straight segment of a wall nearest a point within `reach` metres on the ground (`y`: the pointer's floor height; arcs and curves are left out). */
export function nearestSegment(elements: readonly ArchitectureElement[], x: number, z: number, reach: number, y?: number): ElementSegment | null {
  let best: ElementSegment | null = null;
  let bestD = Infinity;
  for (const e of pieceSweeps(elements)) {
    if (e.path.curve === true) continue;
    const pts = e.path.points;
    const segs = e.path.closed === true ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i++) {
      if ((e.path.bulges?.[i] ?? 0) !== 0) continue;
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const dx = b[0] - a[0];
      const dz = b[2] - a[2];
      const l2 = dx * dx + dz * dz;
      if (l2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2));
      const g = Math.hypot(a[0] + dx * t - x, a[2] + dz * t - z);
      const d = pickDistance(g, a[1] + (b[1] - a[1]) * t, y);
      if (g <= reach && d < bestD) {
        bestD = d;
        best = { element: e.id, segment: i, a: [...a], b: [...b] };
      }
    }
  }
  return best;
}

/** The wall corner nearest a point within `reach` metres on the ground (`y`: the pointer's floor height). */
export function nearestCorner(elements: readonly ArchitectureElement[], x: number, z: number, reach: number, y?: number): ElementCorner | null {
  let best: ElementCorner | null = null;
  let bestD = Infinity;
  for (const e of pieceSweeps(elements)) {
    e.path.points.forEach((p, i) => {
      const g = Math.hypot(p[0] - x, p[2] - z);
      const d = pickDistance(g, p[1], y);
      if (g <= reach && d < bestD) {
        bestD = d;
        best = { element: e.id, corner: i, p: [...p] };
      }
    });
  }
  return best;
}

/** Whether an override stands on this segment or corner. */
const sameSpot = (o: ArchitectureOverride, at: { element: string; segment?: number; corner?: number }): boolean => o.element === at.element && o.segment === at.segment && o.corner === at.corner;

/**
 * The component with a kit piece on a segment or corner (`model` null:
 * the piece there taken off). One piece per spot: a new one replaces it.
 * A kit piece's origin is its bottom centre, so a segment's stands at the
 * segment's middle, stretched to it (the generator's default).
 */
export function withOverride(c: ArchitectureComponent, at: { element: string; segment: number } | { element: string; corner: number }, model: ArchitectureModelRef | null): ArchitectureComponent {
  const kept = (c.overrides ?? []).filter((o) => !sameSpot(o, at));
  const next: ArchitectureOverride[] = model === null ? kept : [...kept, { ...at, model: { ...model }, ...('segment' in at ? { centre: true } : {}) }];
  const { overrides: _o, ...rest } = c;
  return next.length > 0 ? { ...rest, overrides: next } : rest;
}

/** The outline (room, run or building) an expanded element was made from: the longest id it starts with (null: a raw element). */
export function outlineOfElement(c: ArchitectureComponent | null, element: string): ArchitectureOutline | null {
  let best: ArchitectureOutline | null = null;
  for (const o of allOutlines(c)) if ((element === o.id || element.startsWith(`${o.id}-`)) && (best === null || o.id.length > best.id.length)) best = o;
  return best;
}

/** The overrides on an outline's elements, with their place in the component's list. */
export function overridesOf(c: ArchitectureComponent | null, outlineId: string): { index: number; override: ArchitectureOverride }[] {
  return (c?.overrides ?? []).flatMap((o, index) => (outlineOfElement(c, o.element)?.id === outlineId ? [{ index, override: o }] : []));
}

/** Whether a ground point (x, z) is inside a closed outline's corners (even-odd). */
function insideCorners(pts: readonly (readonly number[])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a[2]! > z !== b[2]! > z && x < ((b[0]! - a[0]!) * (z - a[2]!)) / (b[2]! - a[2]!) + a[0]!) inside = !inside;
  }
  return inside;
}

/** Storey heights by outline id: the expansion's `rises` (what the runtime builds each storey to). */
export type OutlineRises = Readonly<Record<string, number>>;

/** An outline's storey height: as the runtime builds it (`rises`), else its own, else the fallback. */
export function storeyRiseOf(o: ArchitectureOutline, rises: OutlineRises | undefined): number {
  return rises?.[o.id] ?? o.storeyHeight ?? ARCHITECTURE_STOREY_HEIGHT_FALLBACK;
}

/**
 * The room, building or path a ray picks (the rooms object's frame; `dir`
 * need not be unit length), and the ray's parameter there. A room or
 * building is its footprint stood up to its storeys (`rises`: each one's
 * storey height); a path, its line stood up `runHeight` metres and, seen from
 * above, a ribbon `reach` metres either side of it. The nearest wins — but
 * `goIn` (a double-click) goes into the nearest room or building: it picks
 * what is drawn inside its footprint under the pointer (a room or path in a
 * building), each stood up to the outer one's top, since the building's
 * walls and roof hide it. So a click selects a building, a double-click the
 * room in it under the pointer, and a click there again the building.
 */
export function outlineUnderRay(c: ArchitectureComponent | null, origin: readonly number[], dir: readonly number[], rises: OutlineRises | undefined, runHeight: number, reach: number, goIn = false): { id: string; t: number } | null {
  const [ox, oy, oz] = [origin[0]!, origin[1]!, origin[2]!];
  const [dx, dy, dz] = [dir[0]!, dir[1]!, dir[2]!];
  /** Where the ray crosses the level y (null: never, or behind). */
  const atLevel = (y: number): number | null => (Math.abs(dy) < 1e-12 ? null : (y - oy) / dy);
  const topOf = (o: ArchitectureOutline): number => o.path.points[0]![1]! + (o.path.closed === true && o.path.points.length >= 3 ? (o.storeys ?? 1) * storeyRiseOf(o, rises) : runHeight);
  /** The ray's nearest hit on one outline (its top at `y1`), or null. */
  const hitOf = (o: ArchitectureOutline, y1: number): number | null => {
    // An arc or curve is taken by its chords: near enough to pick by.
    const pts = o.path.points;
    if (pts.length < 2) return null;
    let best: number | null = null;
    const take = (t: number): void => {
      if (t > 0 && (best === null || t < best)) best = t;
    };
    const y0 = pts[0]![1]!;
    const closed = o.path.closed === true && pts.length >= 3;
    // The sides stood up: where the ray crosses each between the floor and the top.
    const segs = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const ex = b[0]! - a[0]!;
      const ez = b[2]! - a[2]!;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a[0]! - ox) * ez - (a[2]! - oz) * ex) / den;
      const u = ((a[0]! - ox) * dz - (a[2]! - oz) * dx) / den;
      const y = oy + t * dy;
      if (u >= 0 && u <= 1 && y >= y0 && y <= y1) take(t);
    }
    if (closed) {
      // The floor and the top: a ray from above or below meets them inside the footprint.
      for (const y of [y0, y1]) {
        const t = atLevel(y);
        if (t !== null && insideCorners(pts, ox + t * dx, oz + t * dz)) take(t);
      }
      return best;
    }
    // A path from above: the ground within reach of its line.
    const t = atLevel(y0);
    if (t === null) return best;
    const x = ox + t * dx;
    const z = oz + t * dz;
    for (let i = 0; i < segs; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const ex = b[0]! - a[0]!;
      const ez = b[2]! - a[2]!;
      const l2 = ex * ex + ez * ez;
      const k = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]!) * ex + (z - a[2]!) * ez) / l2));
      if (Math.hypot(a[0]! + ex * k - x, a[2]! + ez * k - z) <= reach) take(t);
    }
    return best;
  };
  const all = allOutlines(c);
  let best: { o: ArchitectureOutline; t: number } | null = null;
  for (const o of all) {
    const t = hitOf(o, topOf(o));
    if (t !== null && (best === null || t < best.t)) best = { o, t };
  }
  const outer = best?.o;
  if (goIn && outer !== undefined && outer.path.closed === true && outer.path.points.length >= 3) {
    const top = topOf(outer);
    let inner: { o: ArchitectureOutline; t: number } | null = null;
    for (const o of all) {
      if (o === outer || !within(o, outer)) continue;
      const t = hitOf(o, Math.max(topOf(o), top));
      if (t !== null && (inner === null || t < inner.t)) inner = { o, t };
    }
    if (inner !== null) best = inner;
  }
  return best === null ? null : { id: best.o.id, t: best.t };
}

/** Whether outline `o` lies inside closed outline `outer`'s footprint (its corners within the footprint's box, its middle inside it). */
function within(o: ArchitectureOutline, outer: ArchitectureOutline): boolean {
  const box = outer.path.points;
  const eps = 1e-6;
  const [x0, x1] = [Math.min(...box.map((q) => q[0]!)) - eps, Math.max(...box.map((q) => q[0]!)) + eps];
  const [z0, z1] = [Math.min(...box.map((q) => q[2]!)) - eps, Math.max(...box.map((q) => q[2]!)) + eps];
  const pts = o.path.points;
  if (pts.some((q) => q[0]! < x0 || q[0]! > x1 || q[2]! < z0 || q[2]! > z1)) return false;
  const mx = pts.reduce((n, q) => n + q[0]!, 0) / pts.length;
  const mz = pts.reduce((n, q) => n + q[2]!, 0) / pts.length;
  return insideCorners(box, mx, mz);
}

/** The lines that outline a room, building or path stood up to its height: its floor and top rings and its corners' verticals (pairs of points, the rooms object's frame). */
export function outlineFrame(o: ArchitectureOutline, rises: OutlineRises | undefined, runHeight: number): Point3[] {
  const pts = o.path.points;
  const closed = o.path.closed === true && pts.length >= 3;
  const y0 = pts[0]?.[1] ?? 0;
  const y1 = y0 + (closed ? (o.storeys ?? 1) * storeyRiseOf(o, rises) : runHeight);
  const out: Point3[] = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    out.push([a[0]!, y0, a[2]!], [b[0]!, y0, b[2]!], [a[0]!, y1, a[2]!], [b[0]!, y1, b[2]!]);
  }
  for (const p of pts) out.push([p[0]!, y0, p[2]!], [p[0]!, y1, p[2]!]);
  return out;
}
