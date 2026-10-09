/**
 * Rooms and the portals between them: what each room of the generated
 * architecture can see of the others.
 *
 * - Rooms: every room storey of every architecture object (its floor plan:
 *   corners on the ground, floor, top of its walls), in world space. A point
 *   is in a room when it lies inside its corners and between its floor and
 *   its top.
 * - Portals: the holes rooms see through — an opening in a wall (between the
 *   room and whatever lies across it: another room, or the outside), a hole
 *   in a floor (the room below), and the top of a room nothing covers (the
 *   outside, the sky). A door piece standing in an opening (a layer edge
 *   piece, closed) shuts it: the portal names the cell edges across its
 *   foot. A covered room's top is a portal too, kept apart (`tops`): it is
 *   shut until a cut-away hides the roof or the floor above, and then the
 *   room lies open to the sky like a yard.
 * - What is seen: from the room the eye is in (or the outside), through
 *   each open portal whose picture on the screen still overlaps what is seen
 *   of the portal it was reached through (the screen rectangle narrows at
 *   each step), the classic portal walk. It is conservative: a room is
 *   left out only when no rectangle reaches it.
 *
 * This is the special case of occlusion that architecture makes cheap:
 * rooms whose walls hide them are found without reading depth.
 *
 * Pure.
 */
import { distanceToEdges, pointInPolygon } from './arch-mesh';
import type { ArchitectureRoomPlan } from './arch-style';

/** The outside: the portals' other side when no room lies across them. */
export const ROOM_OUTSIDE = -1;

/** Metres either side of an opening's middle the rooms across it are looked for (more than any wall's half thickness). */
const ACROSS = 0.5;
/** Metres below a hole in a floor the room it opens onto is looked for. */
const BELOW = 0.3;
/**
 * Metres from a portal within which the eye stands in it: its picture on the
 * screen is a sliver then (or behind the eye), so it narrows nothing.
 */
const IN_PORTAL = 0.6;
/** Metres from a room's walls within which an eye outside every room counts as in the room too (a camera grazing a wall). */
const NEAR_ROOM = 0.35;
/** The side of the ground grid that finds the rooms at a point (m). */
const GRID = 4;
/** Clip-space w below which a point is behind the eye. */
const W_MIN = 1e-4;
/** Steps a walk may take per portal before it gives up and sees everything (it never should). */
const STEPS_PER_PORTAL = 16;

export interface RoomGraphObject {
  /** The architecture object's id. */
  readonly id: string;
  /** Its position (its rooms' frame). */
  readonly origin: readonly number[];
  readonly rooms: readonly ArchitectureRoomPlan[];
  /** The block layer its rooms are drawn on (door pieces stand on its cell edges); null or absent: none. */
  readonly layer?: { readonly id: string; readonly origin: readonly number[]; readonly cellSize: readonly number[] } | null;
}

export interface GraphRoom {
  /** `<object>/<room id>`: unique over the objects. */
  readonly key: string;
  readonly object: string;
  readonly id: string;
  /** Corners on the ground, world (x, z pairs). */
  readonly poly: Float64Array;
  readonly floor: number;
  readonly top: number;
  /** Ground bounds (x0, z0, x1, z1). */
  readonly box: readonly [number, number, number, number];
  readonly covered: boolean;
}

export type GraphPortalKind = 'opening' | 'hole' | 'top';

export interface GraphPortal {
  /** The rooms either side (indices; {@link ROOM_OUTSIDE} for the outside). */
  readonly a: number;
  readonly b: number;
  readonly kind: GraphPortalKind;
  /** World corners, x y z each: an opening's four, a hole's or a room's top's outline. */
  readonly corners: Float64Array;
  /**
   * Its plane (nx, ny, nz, d: n·p + d > 0 on side `a`). Sight passes from one
   * side to the other only for an eye on the first side: a window in a
   * building's front is no way in for an eye behind the building.
   */
  readonly plane: Float64Array;
  /** The layer cell edges across an opening's foot a door piece stands on ([x, y, z, axis] each); null: none (not on cell lines, or no layer). */
  readonly door: { readonly layer: string; readonly edges: Int32Array } | null;
}

/** What a walk saw. */
export interface RoomVisibility {
  /** 1 per room seen. */
  rooms: Uint8Array;
  /** The outside was seen (through an opening or an open top, or the eye is in no room). */
  outside: boolean;
  /** The room the eye is in ({@link ROOM_OUTSIDE}: none). */
  eyeRoom: number;
  /** Portals crossed. */
  steps: number;
}

/** A view's matrix: projection × view, column-major (three.js's `elements`). */
export type ViewProjection = ArrayLike<number>;

export class RoomGraph {
  readonly rooms: GraphRoom[] = [];
  readonly portals: GraphPortal[] = [];
  /** Per room, its portals (indices). */
  readonly byRoom: number[][] = [];
  /** The portals onto the outside. */
  readonly outsidePortals: number[] = [];
  /** Per room, its top when something covers it (a portal to the outside opened only by a cut-away; null: the room is open, its top is in `portals`). */
  readonly tops: (GraphPortal | null)[] = [];
  private readonly grid = new Map<number, number[]>();

  /** Index a room (its ground cells of the lookup grid). */
  addRoom(r: GraphRoom): number {
    const i = this.rooms.length;
    this.rooms.push(r);
    this.byRoom.push([]);
    this.tops.push(null);
    const [x0, z0, x1, z1] = r.box;
    for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++) {
      for (let gz = Math.floor(z0 / GRID); gz <= Math.floor(z1 / GRID); gz++) {
        const k = gridKey(gx, gz);
        let list = this.grid.get(k);
        if (list === undefined) this.grid.set(k, (list = []));
        list.push(i);
      }
    }
    return i;
  }

  addPortal(p: GraphPortal): void {
    const i = this.portals.length;
    this.portals.push(p);
    if (p.a !== ROOM_OUTSIDE) this.byRoom[p.a]!.push(i);
    else this.outsidePortals.push(i);
    if (p.b !== ROOM_OUTSIDE) this.byRoom[p.b]!.push(i);
    else this.outsidePortals.push(i);
  }

  /** The room a world point is in ({@link ROOM_OUTSIDE}: none; the first listed where storeys or rooms overlap). */
  roomAt(x: number, y: number, z: number): number {
    const list = this.grid.get(gridKey(Math.floor(x / GRID), Math.floor(z / GRID)));
    if (list === undefined) return ROOM_OUTSIDE;
    for (const i of list) {
      const r = this.rooms[i]!;
      if (y < r.floor || y >= r.top) continue;
      if (x < r.box[0] || x > r.box[2] || z < r.box[1] || z > r.box[3]) continue;
      if (pointInPolygon(x, z, r.poly)) return i;
    }
    return ROOM_OUTSIDE;
  }

  /** The rooms within `margin` metres of a point (inside or out; between their floor and top, `margin` either way). */
  near(x: number, y: number, z: number, margin: number, out: number[] = []): number[] {
    out.length = 0;
    const seen = new Set<number>();
    for (let gx = Math.floor((x - margin) / GRID); gx <= Math.floor((x + margin) / GRID); gx++) {
      for (let gz = Math.floor((z - margin) / GRID); gz <= Math.floor((z + margin) / GRID); gz++) {
        for (const i of this.grid.get(gridKey(gx, gz)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const r = this.rooms[i]!;
          if (y < r.floor - margin || y >= r.top + margin) continue;
          if (x < r.box[0] - margin || x > r.box[2] + margin || z < r.box[1] - margin || z > r.box[3] + margin) continue;
          if (pointInPolygon(x, z, r.poly) || distanceToEdges(x, z, r.poly) <= margin) out.push(i);
        }
      }
    }
    return out;
  }
}

function gridKey(gx: number, gz: number): number {
  // Two 26-bit signed halves: ±130 km of 4 m cells, exact in a double.
  return (gx + (1 << 25)) * 67108864 + (gz + (1 << 25));
}

/** The rooms of every object and the portals between them (rooms in object order, each object's in plan order). */
export function buildRoomGraph(objects: readonly RoomGraphObject[]): RoomGraph {
  const g = new RoomGraph();
  const plans: { o: RoomGraphObject; p: ArchitectureRoomPlan; index: number }[] = [];
  for (const o of objects) {
    const [ox, oy, oz] = [o.origin[0] ?? 0, o.origin[1] ?? 0, o.origin[2] ?? 0];
    for (const p of o.rooms) {
      if (p.points.length < 3 || !(p.top > p.floor)) continue;
      const poly = new Float64Array(p.points.length * 2);
      let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
      p.points.forEach(([x, z], k) => {
        poly[k * 2] = x + ox;
        poly[k * 2 + 1] = z + oz;
        x0 = Math.min(x0, x + ox);
        z0 = Math.min(z0, z + oz);
        x1 = Math.max(x1, x + ox);
        z1 = Math.max(z1, z + oz);
      });
      const index = g.addRoom({ key: `${o.id}/${p.id}`, object: o.id, id: p.id, poly, floor: p.floor + oy, top: p.top + oy, box: [x0, z0, x1, z1], covered: p.covered });
      plans.push({ o, p, index });
    }
  }
  const seen: { a: number; b: number; x: number; y: number; z: number }[] = [];
  for (const { o, p, index } of plans) {
    const [ox, oy, oz] = [o.origin[0] ?? 0, o.origin[1] ?? 0, o.origin[2] ?? 0];
    for (const op of p.openings) {
      const [ax, az] = [op.from[0] + ox, op.from[1] + oz];
      const [bx, bz] = [op.to[0] + ox, op.to[1] + oz];
      const [y0, y1] = [op.bottom + oy, op.top + oy];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6 || !(y1 > y0)) continue;
      // Across the wall at the opening's middle: one side is this room, the other what lies there.
      const [mx, my, mz] = [(ax + bx) / 2, (y0 + y1) / 2, (az + bz) / 2];
      const [nx, nz] = [-(bz - az) / len, (bx - ax) / len];
      const s1 = g.roomAt(mx + nx * ACROSS, my, mz + nz * ACROSS);
      const s2 = g.roomAt(mx - nx * ACROSS, my, mz - nz * ACROSS);
      const other = s1 === index ? s2 : s2 === index ? s1 : s1 !== ROOM_OUTSIDE ? s1 : s2;
      if (other === index) continue;
      // The plane's normal toward this room's side.
      const toward = s2 === index && s1 !== index ? -1 : 1;
      const plane = Float64Array.of(nx * toward, 0, nz * toward, -(nx * toward * mx + nz * toward * mz));
      // An opening both rooms list (or a doorway cut once and listed twice) is one portal.
      if (seen.some((q) => ((q.a === index && q.b === other) || (q.a === other && q.b === index)) && Math.abs(q.x - mx) < 0.05 && Math.abs(q.y - my) < 0.05 && Math.abs(q.z - mz) < 0.05)) continue;
      seen.push({ a: index, b: other, x: mx, y: my, z: mz });
      const corners = Float64Array.of(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      g.addPortal({ a: index, b: other, kind: 'opening', corners, plane, door: doorEdges(o, ax, az, bx, bz, y0) });
    }
    const room = g.rooms[index]!;
    for (const h of p.holes) {
      if (h.length < 3) continue;
      let cx = 0;
      let cz = 0;
      for (const [x, z] of h) {
        cx += x + ox;
        cz += z + oz;
      }
      const below = g.roomAt(cx / h.length, room.floor - BELOW, cz / h.length);
      if (below === ROOM_OUTSIDE || below === index) continue;
      g.addPortal({ a: index, b: below, kind: 'hole', corners: ring(h, ox, oz, room.floor), plane: Float64Array.of(0, 1, 0, -room.floor), door: null });
    }
    const top: GraphPortal = { a: index, b: ROOM_OUTSIDE, kind: 'top', corners: ring(p.points, ox, oz, room.top), plane: Float64Array.of(0, -1, 0, room.top), door: null };
    if (!room.covered) g.addPortal(top);
    else g.tops[index] = top;
  }
  return g;
}

function ring(points: readonly (readonly number[])[], ox: number, oz: number, y: number): Float64Array {
  const out = new Float64Array(points.length * 3);
  points.forEach((q, k) => {
    out[k * 3] = q[0]! + ox;
    out[k * 3 + 1] = y;
    out[k * 3 + 2] = q[1]! + oz;
  });
  return out;
}

/** The layer cell edges across an opening's foot (one per cell column whose middle it spans), when it runs on a cell line. */
function doorEdges(o: RoomGraphObject, ax: number, az: number, bx: number, bz: number, y0: number): GraphPortal['door'] {
  const L = o.layer;
  if (L === undefined || L === null) return null;
  const [lx, ly, lz] = [L.origin[0] ?? 0, L.origin[1] ?? 0, L.origin[2] ?? 0];
  const [cs0, cs1, cs2] = [L.cellSize[0]!, L.cellSize[1]!, L.cellSize[2]!];
  const [pax, paz, pbx, pbz] = [(ax - lx) / cs0, (az - lz) / cs2, (bx - lx) / cs0, (bz - lz) / cs2];
  const row = Math.ceil((y0 - ly) / cs1 - 0.5 - 1e-9);
  const out: number[] = [];
  const onLine = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-3;
  if (Math.abs(pax - pbx) < 1e-6 && onLine(pax)) {
    const line = Math.round(pax);
    for (let k = Math.floor(Math.min(paz, pbz) - 0.5 + 1e-9) + 1; k + 0.5 < Math.max(paz, pbz) - 1e-9; k++) out.push(line, row, k, 0);
  } else if (Math.abs(paz - pbz) < 1e-6 && onLine(paz)) {
    const line = Math.round(paz);
    for (let k = Math.floor(Math.min(pax, pbx) - 0.5 + 1e-9) + 1; k + 0.5 < Math.max(pax, pbx) - 1e-9; k++) out.push(k, row, line, 1);
  } else return null;
  return out.length > 0 ? { layer: L.id, edges: Int32Array.from(out) } : null;
}

/** A visibility to fill (one per walker: the walk allocates nothing per frame but its stack). */
export function roomVisibility(rooms: number): RoomVisibility {
  return { rooms: new Uint8Array(rooms), outside: false, eyeRoom: ROOM_OUTSIDE, steps: 0 };
}

const _poly: number[] = [];
const _clip: number[] = [];

/**
 * The screen rectangle (NDC x0 y0 x1 y1, into `out`) a portal covers, cut to
 * the eye's side of the near plane; false when none of it is in front of the
 * eye.
 */
export function portalRect(corners: ArrayLike<number>, m: ViewProjection, out: Float64Array | number[]): boolean {
  _poly.length = 0;
  for (let k = 0; k < corners.length; k += 3) {
    const x = corners[k]!;
    const y = corners[k + 1]!;
    const z = corners[k + 2]!;
    _poly.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[3]! * x + m[7]! * y + m[11]! * z + m[15]!);
  }
  // Clip (x, y, w) to w ≥ W_MIN.
  _clip.length = 0;
  const n = _poly.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const wi = _poly[i * 3 + 2]!;
    const wj = _poly[j * 3 + 2]!;
    if (wi >= W_MIN) _clip.push(_poly[i * 3]!, _poly[i * 3 + 1]!, wi);
    if (wi >= W_MIN !== wj >= W_MIN) {
      const t = (W_MIN - wi) / (wj - wi);
      _clip.push(_poly[i * 3]! + (_poly[j * 3]! - _poly[i * 3]!) * t, _poly[i * 3 + 1]! + (_poly[j * 3 + 1]! - _poly[i * 3 + 1]!) * t, W_MIN);
    }
  }
  if (_clip.length === 0) return false;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < _clip.length; k += 3) {
    const w = _clip[k + 2]!;
    const x = _clip[k]! / w;
    const y = _clip[k + 1]! / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  out[0] = x0;
  out[1] = y0;
  out[2] = x1;
  out[3] = y1;
  return true;
}

/** Distance from a point to a portal's polygon (planar, convex or not: to its plane inside its outline, else to its edges). */
export function portalDistance(corners: ArrayLike<number>, x: number, y: number, z: number): number {
  const n = corners.length / 3;
  // Newell's normal.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, ay, az] = [corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!];
    const [bx, by, bz] = [corners[j * 3]!, corners[j * 3 + 1]!, corners[j * 3 + 2]!];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const l = Math.hypot(nx, ny, nz);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    best = Math.min(best, segmentDistance(x, y, z, corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!, corners[j * 3]!, corners[j * 3 + 1]!, corners[j * 3 + 2]!));
  }
  if (l < 1e-12) return best;
  nx /= l;
  ny /= l;
  nz /= l;
  const d = (x - corners[0]!) * nx + (y - corners[1]!) * ny + (z - corners[2]!) * nz;
  // The foot of the perpendicular inside the outline: project onto the plane's two widest axes.
  const [px, py, pz] = [x - nx * d, y - ny * d, z - nz * d];
  const drop = Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz) ? 0 : Math.abs(ny) >= Math.abs(nz) ? 1 : 2;
  const flat: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = [corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!];
    flat.push(drop === 0 ? c[1]! : c[0]!, drop === 2 ? c[1]! : c[2]!);
  }
  const p = [px, py, pz];
  const inside = pointInPolygon(drop === 0 ? p[1]! : p[0]!, drop === 2 ? p[1]! : p[2]!, flat);
  return inside ? Math.min(best, Math.abs(d)) : best;
}

function segmentDistance(x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const [dx, dy, dz] = [bx - ax, by - ay, bz - az];
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - x, ay + dy * t - y, az + dz * t - z);
}

/**
 * Walk the portals from the eye (world point) for the view `m`: the rooms
 * seen and whether the outside is. `open(p)` says whether portal `p` lets
 * sight through (a closed door does not). `cutOpen(r)` says whether a
 * cut-away hides what covers room `r` (absent: none does), opening its top
 * to the sky. `out` is filled (sized for the graph's rooms by
 * {@link roomVisibility}).
 */
export function walkRooms(g: RoomGraph, eye: ArrayLike<number>, m: ViewProjection, open: (portal: number) => boolean, out: RoomVisibility, cutOpen?: (room: number) => boolean): RoomVisibility {
  const n = g.rooms.length;
  if (out.rooms.length !== n) out.rooms = new Uint8Array(n);
  else out.rooms.fill(0);
  out.outside = false;
  out.steps = 0;
  const [ex, ey, ez] = [eye[0]!, eye[1]!, eye[2]!];
  // Per node (rooms, then the outside last): the union of the rectangles it was entered with.
  const seen = new Float64Array((n + 1) * 4);
  for (let i = 0; i <= n; i++) seen.set([Infinity, Infinity, -Infinity, -Infinity], i * 4);
  const stack: number[] = [];
  const push = (node: number, x0: number, y0: number, x1: number, y1: number): void => {
    const s = (node === ROOM_OUTSIDE ? n : node) * 4;
    // Nothing new: what it was entered with already holds this rectangle.
    if (seen[s]! <= x0 && seen[s + 1]! <= y0 && seen[s + 2]! >= x1 && seen[s + 3]! >= y1) return;
    seen[s] = Math.min(seen[s]!, x0);
    seen[s + 1] = Math.min(seen[s + 1]!, y0);
    seen[s + 2] = Math.max(seen[s + 2]!, x1);
    seen[s + 3] = Math.max(seen[s + 3]!, y1);
    stack.push(node, x0, y0, x1, y1);
  };
  out.eyeRoom = g.roomAt(ex, ey, ez);
  if (out.eyeRoom !== ROOM_OUTSIDE) push(out.eyeRoom, -1, -1, 1, 1);
  else {
    // In no room (outdoors, or inside a wall): the outside, and any room the eye grazes.
    push(ROOM_OUTSIDE, -1, -1, 1, 1);
    for (const r of g.near(ex, ey, ez, NEAR_ROOM)) push(r, -1, -1, 1, 1);
  }
  const rect = new Float64Array(4);
  const cap = STEPS_PER_PORTAL * (g.portals.length + g.rooms.length + 1);
  /** Sight from `node` (entered with x0 y0 x1 y1) through portal `p`; false when the walk gave up (everything is seen). */
  const through = (p: GraphPortal, node: number, x0: number, y0: number, x1: number, y1: number): boolean => {
    // A portal both of whose sides are the outside does not exist; an outside portal is reached from the outside's list.
    const other = p.a === node ? p.b : p.a;
    if (other === node) return true;
    // Only from the side the walk comes from (an eye in the portal's plane passes either way).
    const side = p.plane[0]! * ex + p.plane[1]! * ey + p.plane[2]! * ez + p.plane[3]!;
    if (p.a === node ? side < -IN_PORTAL : side > IN_PORTAL) return true;
    if (++out.steps > cap) {
      // Never expected: give up seeing less and see everything.
      out.rooms.fill(1);
      out.outside = true;
      return false;
    }
    let [a0, b0, a1, b1] = [x0, y0, x1, y1];
    if (portalDistance(p.corners, ex, ey, ez) > IN_PORTAL) {
      if (!portalRect(p.corners, m, rect)) return true;
      a0 = Math.max(a0, rect[0]!);
      b0 = Math.max(b0, rect[1]!);
      a1 = Math.min(a1, rect[2]!);
      b1 = Math.min(b1, rect[3]!);
      if (a0 >= a1 || b0 >= b1) return true;
    }
    push(other, a0, b0, a1, b1);
    return true;
  };
  while (stack.length > 0) {
    const y1 = stack.pop()!;
    const x1 = stack.pop()!;
    const y0 = stack.pop()!;
    const x0 = stack.pop()!;
    const node = stack.pop()!;
    if (node === ROOM_OUTSIDE) out.outside = true;
    else out.rooms[node] = 1;
    const list = node === ROOM_OUTSIDE ? g.outsidePortals : g.byRoom[node]!;
    for (const pi of list) {
      if (!open(pi)) continue;
      if (!through(g.portals[pi]!, node, x0, y0, x1, y1)) return out;
    }
    // Covered tops a cut-away opens: from a room to the sky, from the outside into every room opened so.
    if (cutOpen === undefined) continue;
    if (node !== ROOM_OUTSIDE) {
      const top = g.tops[node];
      if (top !== null && top !== undefined && cutOpen(node) && !through(top, node, x0, y0, x1, y1)) return out;
    } else {
      for (let r = 0; r < n; r++) {
        const top = g.tops[r];
        if (top !== null && top !== undefined && cutOpen(r) && !through(top, node, x0, y0, x1, y1)) return out;
      }
    }
  }
  return out;
}
