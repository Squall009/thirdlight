/**
 * The Rooms tool's geometry (browser-free): rooms and runs drawn on a block
 * layer as outlines of generated architecture, snapped to the layer's cell
 * corners.
 *
 * - Rectangle: two corners; polygon: corners clicked one by one (a segment
 *   may be an arc); path: an open run (a rail, a fence, a pipe). A room is
 *   stored with its inside to the right of travel (the generator's rule),
 *   whatever way it was drawn.
 * - Openings: a door, window or arch put on the wall nearest the pointer,
 *   whole cells wide, centred on the cells it covers.
 * - Wall drag: one straight side of an outline moved across itself by whole
 *   cells (its corners go with it).
 *
 * Points are metres in the rooms object's frame (its position is the
 * layer's, so they are also layer metres); y is the floor height drawn on.
 */
import type { ArchitectureComponent, ArchitectureOpening, ArchitectureOutline, ArchitecturePath } from '@thirdlight/project-model';

export type RoomToolMode = 'rect' | 'polygon' | 'path' | 'door' | 'window' | 'arch' | 'walls';

/** What the Rooms tool's options panel sets. */
export interface RoomToolOptions {
  mode: RoomToolMode;
  /** The preset new rooms and new runs wear. */
  roomPreset: string;
  pathPreset: string;
  /** The next polygon or path segment is an arc bulging this much (tan of a quarter of its angle; 0: straight). */
  bulge: number;
}

export const DEFAULT_ROOM_OPTIONS: RoomToolOptions = { mode: 'rect', roomPreset: 'starter-room', pathPreset: 'starter-fence', bulge: 0 };

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

/** The first free id `base-N` among the outlines. */
export function nextOutlineId(c: ArchitectureComponent | null, base: 'room' | 'run'): string {
  const taken = new Set((c?.outlines ?? []).map((o) => o.id));
  for (let i = 1; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** The component with one outline added (a new component on the layer when there is none yet). */
export function withOutline(c: ArchitectureComponent | null, layerId: string, o: ArchitectureOutline): ArchitectureComponent {
  const base: ArchitectureComponent = c ?? { elements: [], layer: layerId };
  return { ...base, outlines: [...(base.outlines ?? []), o] };
}

/** The component with one outline replaced (null removes it). */
export function withOutlineSet(c: ArchitectureComponent, id: string, next: ArchitectureOutline | null): ArchitectureComponent {
  const outlines = (c.outlines ?? []).flatMap((o) => (o.id !== id ? [o] : next !== null ? [next] : []));
  const { outlines: _o, ...rest } = c;
  return outlines.length > 0 ? { ...rest, outlines } : rest;
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
  for (const o of c?.outlines ?? []) {
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

/**
 * An opening on a side, `cells` cells wide, centred so it covers whole cells
 * (an odd count: on a cell's middle; even: on a cell line), kept inside the
 * side. Its id is the first free `<kind>-N` of the outline.
 */
export function openingOn(side: OutlineSide, along: number, kind: keyof typeof ROOM_OPENING_KINDS, cellSize: readonly number[], storey: number): ArchitectureOpening | null {
  const k = ROOM_OPENING_KINDS[kind];
  const cell = Math.abs(side.b[0] - side.a[0]) >= Math.abs(side.b[2] - side.a[2]) ? cellSize[0]! : cellSize[2]!;
  const width = k.cells * cell;
  if (width > side.length + 1e-9) return null;
  const odd = k.cells % 2 === 1;
  let mid = odd ? (Math.floor(along / cell) + 0.5) * cell : Math.round(along / cell) * cell;
  mid = Math.max(width / 2, Math.min(side.length - width / 2, mid));
  const taken = new Set((side.outline.openings ?? []).map((o) => o.id));
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n++;
  return { id: `${kind}-${n}`, at: round6(side.start + mid), width: round6(width), bottom: k.bottom, top: k.top, ...(k.pane ? { pane: true } : {}), ...(storey > 0 ? { storey } : {}) };
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

/** The outline with side `index` moved `offset` metres to the right of its travel (both its corners). */
export function moveSide(o: ArchitectureOutline, index: number, offset: number): ArchitectureOutline {
  const side = straightSides(o).find((s) => s.index === index);
  if (side === undefined || offset === 0) return o;
  const [rx, rz] = rightOf(side);
  const pts = o.path.points.map((p) => [...p] as Point3);
  const i0 = index;
  const i1 = (index + 1) % pts.length;
  for (const i of [i0, i1]) pts[i] = [round6(pts[i]![0] + rx * offset), pts[i]![1], round6(pts[i]![2] + rz * offset)];
  return { ...o, path: { ...o.path, points: pts } };
}

const samePoint = (p: readonly number[], q: readonly number[]): boolean => Math.abs(p[0]! - q[0]!) < 1e-6 && Math.abs(p[1]! - q[1]!) < 1e-6 && Math.abs(p[2]! - q[2]!) < 1e-6;

/**
 * A wall dragged: side `index` of outline `id` moved `offset` metres to the
 * right of its travel, and the same wall of any room beside it (a side
 * between the same two corners) moved with it, so a shared wall stays shared.
 */
export function moveWall(c: ArchitectureComponent, id: string, index: number, offset: number): ArchitectureComponent {
  const o = (c.outlines ?? []).find((x) => x.id === id);
  const side = o === undefined ? undefined : straightSides(o).find((s) => s.index === index);
  if (o === undefined || side === undefined || offset === 0) return c;
  const moved = moveSide(o, index, offset);
  const a2 = moved.path.points[index]!;
  const b2 = moved.path.points[(index + 1) % moved.path.points.length]!;
  const outlines = (c.outlines ?? []).map((x) => {
    if (x.id === id) return moved;
    const pts = x.path.points;
    const n = pts.length;
    const segs = x.path.closed === true ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % n]!;
      const forward = samePoint(p, side.a) && samePoint(q, side.b);
      const backward = samePoint(p, side.b) && samePoint(q, side.a);
      if (!forward && !backward) continue;
      const next = pts.map((r) => [...r] as Point3);
      next[i] = [...(forward ? a2 : b2)];
      next[(i + 1) % n] = [...(forward ? b2 : a2)];
      return { ...x, path: { ...x.path, points: next } };
    }
    return x;
  });
  return { ...c, outlines };
}

/**
 * The layer's cell edges an opening covers (layer cells: [x, y, z, axis]),
 * where an edge piece (a door) goes in it: the cells along its wall's line
 * whose middles it spans, in the rows between its sill and head above the
 * storey's floor (`floor`, object frame). Empty when its side is not on a
 * cell line. `offset`: the object's place in the layer (layer = object + offset).
 */
export function openingEdges(o: ArchitectureOutline, opening: ArchitectureOpening, floor: number, offset: readonly number[], cellSize: readonly number[]): [number, number, number, number][] {
  const L = straightSides(o).reduce((m, s) => Math.max(m, s.start + s.length), 0);
  const at = o.path.closed === true && L > 0 ? ((opening.at % L) + L) % L : opening.at;
  const side = straightSides(o).find((s) => at >= s.start - 1e-9 && at <= s.start + s.length + 1e-9);
  if (side === undefined) return [];
  const [ox, oy, oz] = [offset[0] ?? 0, offset[1] ?? 0, offset[2] ?? 0];
  const ax = side.a[0] + ox;
  const az = side.a[2] + oz;
  const bx = side.b[0] + ox;
  const bz = side.b[2] + oz;
  const [cs0, cs1, cs2] = [cellSize[0]!, cellSize[1]!, cellSize[2]!];
  const onLine = (v: number, c: number): boolean => Math.abs(v / c - Math.round(v / c)) < 1e-3;
  const along = at - side.start;
  const lo = along - opening.width / 2;
  const hi = along + opening.width / 2;
  const out: [number, number, number, number][] = [];
  const r0 = Math.ceil((floor + oy + opening.bottom) / cs1 - 0.5 - 1e-9);
  const r1 = Math.floor((floor + oy + opening.top) / cs1 - 0.5 + 1e-9);
  if (Math.abs(ax - bx) < 1e-9 && onLine(ax, cs0)) {
    const sign = bz >= az ? 1 : -1;
    for (let k = Math.floor(Math.min(az + sign * lo, az + sign * hi) / cs2); (k + 0.5) * cs2 < Math.max(az + sign * lo, az + sign * hi); k++) {
      if ((k + 0.5) * cs2 <= Math.min(az + sign * lo, az + sign * hi)) continue;
      for (let r = r0; r <= r1; r++) out.push([Math.round(ax / cs0), r, k, 0]);
    }
  } else if (Math.abs(az - bz) < 1e-9 && onLine(az, cs2)) {
    const sign = bx >= ax ? 1 : -1;
    for (let k = Math.floor(Math.min(ax + sign * lo, ax + sign * hi) / cs0); (k + 0.5) * cs0 < Math.max(ax + sign * lo, ax + sign * hi); k++) {
      if ((k + 0.5) * cs0 <= Math.min(ax + sign * lo, ax + sign * hi)) continue;
      for (let r = r0; r <= r1; r++) out.push([k, r, Math.round(az / cs2), 1]);
    }
  }
  return out;
}
