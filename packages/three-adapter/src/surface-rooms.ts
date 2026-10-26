/**
 * Rooms and portals for the surface cache's light (project-model
 * `arch-portals.ts` has the rooms of generated architecture and the portals
 * between them; room-culling.ts keeps which doors are shut).
 *
 * Light leaves a room only through its open portals:
 *
 * - **Direct light.** A point, spot or area light standing in a room lights
 *   only that room and the rooms its open portals join it to
 *   (`lightRooms`); when they reach the outside it is not held back (its
 *   shadow rays still meet every wall). A closed door is an edge piece the
 *   tracer lets rays through, so without this a lamp in a shut room would
 *   light the yard through its door. Texels are tested one by one on the
 *   GPU against the few rooms their unit's box touches (`unitRooms`).
 * - **Probe rays.** A probe in a room casts its rays only as far as the
 *   room's boundary, unless they leave through an open portal
 *   (`roomExitCpu`, the shaders' `roomExit`), and no probe sees through a
 *   shut doorway (`closedPortalCpu`, `closedPortal`); a ray stopped there
 *   meets a wall or a door (the probe's own light falls back on it).
 * - **Marks.** A switched lamp marks only the units its rooms touch.
 *
 * Words (`SurfaceRooms.words`, appended to a pass's word buffer; offsets
 * within them): a header (rooms, portals, room records, portal records),
 * per room `ROOM_WORDS` (its outline's first point and count, floor, top,
 * ground box x0 z0 x1 z1, its portal list and count), per portal
 * `PORTAL_WORDS` (kind | open << 8, its corners' first word and count),
 * then the outlines (x, z) and corners (x, y, z) as floats and the lists.
 *
 * Pure (no three.js, no device).
 */
import { ROOM_OUTSIDE, type RoomGraph } from '@thirdlight/runtime';

/** Rooms and which of their portals are open now (room-culling.ts reads the doors). */
export interface LightingRooms {
  readonly graph: RoomGraph;
  open(portal: number): boolean;
  /** Changes when the rooms or a door changed. */
  readonly version: number;
}

/** How far (m) a texel's point is moved along its normal before its room is found: a wall's room side is in the room, its far side not. */
export const TEXEL_ROOM_LIFT = 0.05;
/** How far (m) past a room's boundary a probe ray that does not leave by a portal still runs: further than any wall is thick, so the wall itself is met. */
export const ROOM_EXIT_MARGIN = 0.5;
/** How far (m) a unit's box may lie outside a room's box and still have texels in it (a wall's room side, a floor's edge). */
export const ROOM_BOX_MARGIN = 0.1;
/** How far (m) from an opening's line its exit point may lie and still pass through it (more than any wall's half thickness). */
const OPENING_SLACK = 0.6;
/** How far (m) from a room's floor or top a hole's or top's exit point may lie. */
const PLANE_SLACK = 0.05;

export const ROOMS_HEADER_WORDS = 4;
export const ROOM_WORDS = 10;
export const PORTAL_WORDS = 3;
export const PORTAL_OPENING = 0;
export const PORTAL_HOLE = 1;
export const PORTAL_TOP = 2;
/** A texel or probe in no room (the outside). */
export const NO_ROOM = 0xffffffff;

const KIND = { opening: PORTAL_OPENING, hole: PORTAL_HOLE, top: PORTAL_TOP } as const;

function pointInPoly(x: number, z: number, poly: ArrayLike<number>, at: number, n: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[at + i * 2]!, zi = poly[at + i * 2 + 1]!;
    const xj = poly[at + j * 2]!, zj = poly[at + j * 2 + 1]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export class SurfaceRooms {
  readonly words: Uint32Array;
  private readonly f: Float32Array;

  constructor(readonly rooms: LightingRooms) {
    const g = rooms.graph;
    const nr = g.rooms.length;
    const np = g.portals.length;
    const polyFloats = g.rooms.reduce((s, r) => s + r.poly.length, 0);
    const cornerFloats = g.portals.reduce((s, p) => s + p.corners.length, 0);
    const lists = g.byRoom.reduce((s, l) => s + l.length, 0);
    const roomAt = ROOMS_HEADER_WORDS;
    const portalAt = roomAt + nr * ROOM_WORDS;
    let data = portalAt + np * PORTAL_WORDS;
    this.words = new Uint32Array(data + polyFloats + cornerFloats + lists);
    this.f = new Float32Array(this.words.buffer);
    const u = this.words;
    const f = this.f;
    u.set([nr, np, roomAt, portalAt]);
    g.rooms.forEach((r, i) => {
      const at = roomAt + i * ROOM_WORDS;
      u[at] = data;
      u[at + 1] = r.poly.length / 2;
      f.set(r.poly, data);
      data += r.poly.length;
      f[at + 2] = r.floor;
      f[at + 3] = r.top;
      f.set(r.box, at + 4);
    });
    g.portals.forEach((p, i) => {
      const at = portalAt + i * PORTAL_WORDS;
      u[at] = KIND[p.kind] | ((rooms.open(i) ? 1 : 0) << 8);
      u[at + 1] = data;
      u[at + 2] = p.corners.length / 3;
      f.set(p.corners, data);
      data += p.corners.length;
    });
    g.byRoom.forEach((list, i) => {
      const at = roomAt + i * ROOM_WORDS;
      u[at + 8] = data;
      u[at + 9] = list.length;
      u.set(list, data);
      data += list.length;
    });
  }

  get count(): number {
    return this.rooms.graph.rooms.length;
  }

  /** The room a point is in (`NO_ROOM`: the outside). */
  roomAt(p: readonly number[]): number {
    const r = this.rooms.graph.roomAt(p[0]!, p[1]!, p[2]!);
    return r === ROOM_OUTSIDE ? NO_ROOM : r;
  }

  /**
   * The rooms a light at `p` may light: its room and every room its open
   * portals join to it; null when it stands outside or its light reaches
   * the outside (nothing then holds it back but its shadow rays).
   */
  lightRooms(p: readonly number[]): number[] | null {
    const start = this.roomAt(p);
    if (start === NO_ROOM) return null;
    const g = this.rooms.graph;
    const seen = new Set<number>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const r = queue.pop()!;
      for (const pi of g.byRoom[r]!) {
        if (!this.rooms.open(pi)) continue;
        const portal = g.portals[pi]!;
        const other = portal.a === r ? portal.b : portal.a;
        if (other === ROOM_OUTSIDE) return null;
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  /** The rooms whose box (± `ROOM_BOX_MARGIN`) a world box touches: the only rooms its texels can be in. */
  unitRooms(min: readonly number[], max: readonly number[]): number[] {
    const out: number[] = [];
    const m = ROOM_BOX_MARGIN;
    this.rooms.graph.rooms.forEach((r, i) => {
      if (max[0]! < r.box[0] - m || min[0]! > r.box[2] + m || max[2]! < r.box[1] - m || min[2]! > r.box[3] + m) return;
      if (max[1]! < r.floor - m || min[1]! > r.top + m) return;
      out.push(i);
    });
    return out;
  }

  /** Whether a world box can hold texels in any of `allowed`. */
  touches(min: readonly number[], max: readonly number[], allowed: readonly number[]): boolean {
    const m = ROOM_BOX_MARGIN;
    const rooms = this.rooms.graph.rooms;
    return allowed.some((i) => {
      const r = rooms[i]!;
      return !(max[0]! < r.box[0] - m || min[0]! > r.box[2] + m || max[2]! < r.box[1] - m || min[2]! > r.box[3] + m || max[1]! < r.floor - m || min[1]! > r.top + m);
    });
  }
}

/** Whether room `r` of packed room words holds `p` (the shaders' `roomHolds`). */
export function roomHoldsCpu(u: Uint32Array, r: number, p: readonly number[]): boolean {
  const f = new Float32Array(u.buffer, u.byteOffset, u.length);
  const at = u[2]! + r * ROOM_WORDS;
  if (p[1]! < f[at + 2]! || p[1]! >= f[at + 3]!) return false;
  if (p[0]! < f[at + 4]! || p[0]! > f[at + 6]! || p[2]! < f[at + 5]! || p[2]! > f[at + 7]!) return false;
  return pointInPoly(p[0]!, p[2]!, f, u[at]!, u[at + 1]!);
}

/** The first of `list` that holds `p` lifted along `n` (`NO_ROOM`: none): a texel's room (the shaders' `texelRoom`). */
export function texelRoomCpu(u: Uint32Array, list: readonly number[], p: readonly number[], n: readonly number[]): number {
  const q = [p[0]! + n[0]! * TEXEL_ROOM_LIFT, p[1]! + n[1]! * TEXEL_ROOM_LIFT, p[2]! + n[2]! * TEXEL_ROOM_LIFT];
  for (const r of list) if (roomHoldsCpu(u, r, q)) return r;
  return NO_ROOM;
}

/**
 * Where a ray from `o` along `d` (unit) inside room `r` leaves it, and
 * whether it leaves through an open portal (the shaders' `roomExit`): the
 * nearest wall of its outline, its floor or its top.
 */
export function roomExitCpu(u: Uint32Array, r: number, o: readonly number[], d: readonly number[]): { t: number; open: boolean } {
  const f = new Float32Array(u.buffer, u.byteOffset, u.length);
  const at = u[2]! + r * ROOM_WORDS;
  const poly = u[at]!;
  const n = u[at + 1]!;
  let t = 1e30;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = f[poly + j * 2]!, az = f[poly + j * 2 + 1]!;
    const ex = f[poly + i * 2]! - ax, ez = f[poly + i * 2 + 1]! - az;
    const den = d[0]! * ez - d[2]! * ex;
    if (Math.abs(den) < 1e-9) continue;
    const wx = ax - o[0]!, wz = az - o[2]!;
    const tt = (wx * ez - wz * ex) / den;
    const s = (wx * d[2]! - wz * d[0]!) / den;
    if (tt > 1e-4 && s >= 0 && s <= 1) t = Math.min(t, tt);
  }
  if (d[1]! < -1e-9) t = Math.min(t, (f[at + 2]! - o[1]!) / d[1]!);
  if (d[1]! > 1e-9) t = Math.min(t, (f[at + 3]! - o[1]!) / d[1]!);
  const q = [o[0]! + d[0]! * t, o[1]! + d[1]! * t, o[2]! + d[2]! * t];
  return { t, open: exitOpen(u, f, at, q) };
}

function exitOpen(u: Uint32Array, f: Float32Array, at: number, q: readonly number[]): boolean {
  const list = u[at + 8]!;
  for (let k = 0; k < u[at + 9]!; k += 1) {
    const p = u[3]! + u[list + k]! * PORTAL_WORDS;
    if (((u[p]! >>> 8) & 1) === 0) continue;
    const kind = u[p]! & 0xff;
    const c = u[p + 1]!;
    const nc = u[p + 2]!;
    if (kind === PORTAL_OPENING) {
      const ax = f[c]!, ay = f[c + 1]!, az = f[c + 2]!;
      const ex = f[c + 3]! - ax, ez = f[c + 5]! - az;
      const l2 = ex * ex + ez * ez;
      const s = ((q[0]! - ax) * ex + (q[2]! - az) * ez) / l2;
      const dist = Math.abs((q[0]! - ax) * ez - (q[2]! - az) * ex) / Math.sqrt(l2);
      if (s >= 0 && s <= 1 && q[1]! >= ay && q[1]! <= f[c + 7]! && dist <= OPENING_SLACK) return true;
      continue;
    }
    // A hole or a top: on its plane and inside its outline.
    if (Math.abs(q[1]! - f[c + 1]!) > PLANE_SLACK) continue;
    let inside = false;
    for (let i = 0, j = nc - 1; i < nc; j = i++) {
      const xi = f[c + i * 3]!, zi = f[c + i * 3 + 2]!;
      const xj = f[c + j * 3]!, zj = f[c + j * 3 + 2]!;
      if (zi > q[2]! !== zj > q[2]! && q[0]! < ((xj - xi) * (q[2]! - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/**
 * How far a ray runs before it meets a shut doorway (any room's opening
 * whose portal is closed), else `tmax` (the shaders' `closedPortal`): a
 * probe outside a shut room does not see into it.
 */
export function closedPortalCpu(u: Uint32Array, o: readonly number[], d: readonly number[], tmax: number): number {
  const f = new Float32Array(u.buffer, u.byteOffset, u.length);
  let t = tmax;
  for (let i = 0; i < u[1]!; i += 1) {
    const p = u[3]! + i * PORTAL_WORDS;
    if ((u[p]! & 0xff) !== PORTAL_OPENING || ((u[p]! >>> 8) & 1) === 1) continue;
    const c = u[p + 1]!;
    const ax = f[c]!, ay = f[c + 1]!, az = f[c + 2]!;
    const ex = f[c + 3]! - ax, ez = f[c + 5]! - az;
    const den = -ez * d[0]! + ex * d[2]!;
    if (Math.abs(den) < 1e-9) continue;
    const tt = (-ez * (ax - o[0]!) + ex * (az - o[2]!)) / den;
    if (!(tt > 1e-4 && tt < t)) continue;
    const qx = o[0]! + d[0]! * tt, qy = o[1]! + d[1]! * tt, qz = o[2]! + d[2]! * tt;
    const s = ((qx - ax) * ex + (qz - az) * ez) / (ex * ex + ez * ez);
    if (s >= 0 && s <= 1 && qy >= ay && qy <= f[c + 7]!) t = tt;
  }
  return t;
}

/**
 * The shaders' room functions over packed room words read through
 * `word(i)` (a u32) at offset `base` (a WGSL expression): `roomHolds`,
 * `texelRoom` over a list of rooms in the same buffer, and `roomExit`
 * (the leaving distance, negative when it leaves by an open portal).
 */
export function roomsWgsl(word: string, base: string): string {
  return /* wgsl */ `
fn rmU(i: u32) -> u32 { return ${word}(${base} + i); }
fn rmF(i: u32) -> f32 { return bitcast<f32>(${word}(${base} + i)); }
fn rmInPoly(x: f32, z: f32, at: u32, n: u32, stride: u32, zoff: u32) -> bool {
  var inside = false;
  var j = n - 1u;
  for (var i = 0u; i < n; i++) {
    let xi = rmF(at + i * stride); let zi = rmF(at + i * stride + zoff);
    let xj = rmF(at + j * stride); let zj = rmF(at + j * stride + zoff);
    if ((zi > z) != (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) { inside = !inside; }
    j = i;
  }
  return inside;
}
fn roomHolds(r: u32, p: vec3f) -> bool {
  let at = rmU(2u) + r * ${ROOM_WORDS}u;
  if (p.y < rmF(at + 2u) || p.y >= rmF(at + 3u)) { return false; }
  if (p.x < rmF(at + 4u) || p.x > rmF(at + 6u) || p.z < rmF(at + 5u) || p.z > rmF(at + 7u)) { return false; }
  return rmInPoly(p.x, p.z, rmU(at), rmU(at + 1u), 2u, 1u);
}
// The first room of the list (words 'list'.. in the same buffer, absolute) holding p lifted along n.
fn texelRoom(listAt: u32, count: u32, p: vec3f, n: vec3f) -> u32 {
  let q = p + n * ${TEXEL_ROOM_LIFT};
  for (var k = 0u; k < count; k++) {
    let r = ${word}(listAt + k);
    if (roomHolds(r, q)) { return r; }
  }
  return ${NO_ROOM}u;
}
fn rmExitOpen(at: u32, q: vec3f) -> bool {
  let list = rmU(at + 8u);
  for (var k = 0u; k < rmU(at + 9u); k++) {
    let p = rmU(3u) + rmU(list + k) * ${PORTAL_WORDS}u;
    let head = rmU(p);
    if (((head >> 8u) & 1u) == 0u) { continue; }
    let c = rmU(p + 1u);
    if ((head & 255u) == ${PORTAL_OPENING}u) {
      let a = vec3f(rmF(c), rmF(c + 1u), rmF(c + 2u));
      let e = vec2f(rmF(c + 3u) - a.x, rmF(c + 5u) - a.z);
      let w = vec2f(q.x - a.x, q.z - a.z);
      let l2 = dot(e, e);
      let s = dot(w, e) / l2;
      let dist = abs(w.x * e.y - w.y * e.x) / sqrt(l2);
      if (s >= 0.0 && s <= 1.0 && q.y >= a.y && q.y <= rmF(c + 7u) && dist <= ${OPENING_SLACK}) { return true; }
      continue;
    }
    if (abs(q.y - rmF(c + 1u)) > ${PLANE_SLACK}) { continue; }
    if (rmInPoly(q.x, q.z, c, rmU(p + 2u), 3u, 2u)) { return true; }
  }
  return false;
}
// How far a ray runs before it meets a shut doorway, else tmax.
fn closedPortal(o: vec3f, d: vec3f, tmax: f32) -> f32 {
  var t = tmax;
  for (var i = 0u; i < rmU(1u); i++) {
    let p = rmU(3u) + i * ${PORTAL_WORDS}u;
    let head = rmU(p);
    if ((head & 255u) != ${PORTAL_OPENING}u || ((head >> 8u) & 1u) == 1u) { continue; }
    let c = rmU(p + 1u);
    let a = vec3f(rmF(c), rmF(c + 1u), rmF(c + 2u));
    let e = vec2f(rmF(c + 3u) - a.x, rmF(c + 5u) - a.z);
    let den = -e.y * d.x + e.x * d.z;
    if (abs(den) < 1e-9) { continue; }
    let tt = (-e.y * (a.x - o.x) + e.x * (a.z - o.z)) / den;
    if (!(tt > 1e-4 && tt < t)) { continue; }
    let q = o + d * tt;
    let s = dot(vec2f(q.x - a.x, q.z - a.z), e) / dot(e, e);
    if (s >= 0.0 && s <= 1.0 && q.y >= a.y && q.y <= rmF(c + 7u)) { t = tt; }
  }
  return t;
}
// How far a ray inside room r runs before it leaves the room; negative (−t) when it leaves by an open portal.
fn roomExit(r: u32, o: vec3f, d: vec3f) -> f32 {
  let at = rmU(2u) + r * ${ROOM_WORDS}u;
  let poly = rmU(at);
  let n = rmU(at + 1u);
  var t = 1e30;
  var j = n - 1u;
  for (var i = 0u; i < n; i++) {
    let a = vec2f(rmF(poly + j * 2u), rmF(poly + j * 2u + 1u));
    let e = vec2f(rmF(poly + i * 2u), rmF(poly + i * 2u + 1u)) - a;
    j = i;
    let den = d.x * e.y - d.z * e.x;
    if (abs(den) < 1e-9) { continue; }
    let w = a - o.xz;
    let tt = (w.x * e.y - w.y * e.x) / den;
    let s = (w.x * d.z - w.y * d.x) / den;
    if (tt > 1e-4 && s >= 0.0 && s <= 1.0) { t = min(t, tt); }
  }
  if (d.y < -1e-9) { t = min(t, (rmF(at + 2u) - o.y) / d.y); }
  if (d.y > 1e-9) { t = min(t, (rmF(at + 3u) - o.y) / d.y); }
  if (rmExitOpen(at, o + d * t)) { return -t; }
  return t;
}
`;
}
