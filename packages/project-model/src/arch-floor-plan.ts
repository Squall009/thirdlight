/**
 * Floor plans: a building's footprint split into rooms by a room program
 * (`arch-plan-kinds.ts`), with doors between them and stairs between
 * storeys. Deterministic: the same footprint, program and seed give the
 * same plan on every machine (plain arithmetic, the generator's seeded
 * random).
 *
 * - The footprint must have only sides along x and z (cell-drawn
 *   buildings do). It is cut into rectangles (zones), and each storey's
 *   rooms are shared out among the zones by area and split from them by
 *   recursive cuts across the longer side (a treemap), cuts on the
 *   program's grid from the zone's corner. Several seeded orders are tried
 *   and the plan scoring best is kept: rooms near their share, not
 *   narrower than the smallest side, square rather than long, the wired
 *   types beside each other, the entrance at the front door, and the stair
 *   room long and wide enough for its flights.
 * - Stairs: the room type holding them is on every storey in one place;
 *   flights run along its longer side, switching back across it storey by
 *   storey, so no flight stands over the hole the one below cuts.
 * - Doors: one between each pair of rooms a wire asks for (when they
 *   touch), then, until every room is reached from the entrance (the
 *   stairs above the ground), one from an unreached room to a reached one
 *   it touches (wired types first, then the widest wall). A door starts on
 *   the grid.
 *
 * Pure.
 */
import { hashString, seededRandom } from './arch-math';
import { pointInPolygon } from './arch-mesh';
import type { RoomProgramDef, RoomTypeDef } from './arch-plan-kinds';

/** [x0, z0, x1, z1], x0 < x1, z0 < z1 (metres, the object's frame). */
export type PlanRect = [number, number, number, number];

export interface FloorPlanRoom {
  /** `<building>-r<n>`: numbered in plan order. */
  id: string;
  type: string;
  /** The storey it is on (the stair room: its lowest; it spans every storey). */
  storey: number;
  storeys: number;
  rect: PlanRect;
  /** Its inside preset ("" for the building's). */
  preset: string;
}

/** A door between two rooms of one storey (or a room and the outside: `b` = ""). */
export interface FloorPlanDoor {
  a: string;
  b: string;
  storey: number;
  /** Its middle on the wall line (x, z) and the line's direction. */
  at: [number, number];
  along: 'x' | 'z';
  width: number;
  height: number;
}

/** A flight of stairs from one storey's floor to the next (x, z of the foot's and the head's middles). */
export interface FloorPlanStair {
  room: string;
  storey: number;
  from: [number, number];
  to: [number, number];
  width: number;
}

export interface FloorPlan {
  rooms: FloorPlanRoom[];
  doors: FloorPlanDoor[];
  stairs: FloorPlanStair[];
  problems: string[];
}

export interface FloorPlanInput {
  /** The building's id (rooms are named after it). */
  id: string;
  /** Its footprint's corners (x, z). */
  footprint: readonly (readonly [number, number])[];
  storeys: number;
  /** Metres from one storey's floor to the next (the stairs' rise). */
  storeyHeight: number;
  /** The ground storey's doors in the footprint's walls (x, z of the middle, width): the entrance is at the first. */
  frontDoors: readonly (readonly [number, number, number])[];
  program: RoomProgramDef;
  seed: number;
}

/** Seeded orders tried per storey (the best scoring plan is kept). */
export const FLOOR_PLAN_TRIES = 16;
/** Metres a flight's run takes per metre of rise (a 0.18 m riser on a 0.29 m tread). */
const RUN_PER_RISE = 1.6;
/** Metres kept between a flight and its room's walls, and a landing at either end. */
const STAIR_MARGIN = 0.15;
const STAIR_LANDING = 1;
/** The widest flight (m), and the width a stair room is made for. */
const STAIR_WIDTH_MAX = 1.1;
const STAIR_WIDTH = 1;
/** The narrowest flight a stair room may have (m). */
const STAIR_WIDTH_MIN = 0.6;
/** Metres of wall kept either side of a door. */
const DOOR_JAMB = 0.1;
const EPS = 1e-6;

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const area = (r: PlanRect): number => (r[2] - r[0]) * (r[3] - r[1]);

/** The rectangles (zones) a footprint with sides along x and z (minus `minus`) is cut into: maximal strips, row by row. */
export function footprintZones(footprint: readonly (readonly [number, number])[], minus: readonly PlanRect[] = []): PlanRect[] | null {
  const n = footprint.length;
  for (let i = 0; i < n; i++) {
    const a = footprint[i]!;
    const b = footprint[(i + 1) % n]!;
    if (Math.abs(a[0] - b[0]) > EPS && Math.abs(a[1] - b[1]) > EPS) return null;
  }
  const xs = [...new Set([...footprint.map((p) => p[0]), ...minus.flatMap((r) => [r[0], r[2]])])].sort((p, q) => p - q);
  const zs = [...new Set([...footprint.map((p) => p[1]), ...minus.flatMap((r) => [r[1], r[3]])])].sort((p, q) => p - q);
  const poly = footprint.flatMap((p) => [p[0], p[1]]);
  const W = xs.length - 1;
  const H = zs.length - 1;
  const inside = new Uint8Array(Math.max(0, W * H));
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const cx = (xs[i]! + xs[i + 1]!) / 2;
      const cz = (zs[j]! + zs[j + 1]!) / 2;
      const cut = minus.some((r) => cx > r[0] && cx < r[2] && cz > r[1] && cz < r[3]);
      inside[j * W + i] = !cut && pointInPolygon(cx, cz, poly) ? 1 : 0;
    }
  const out: PlanRect[] = [];
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      if (inside[j * W + i] !== 1) continue;
      let i1 = i;
      while (i1 + 1 < W && inside[j * W + i1 + 1] === 1) i1++;
      let j1 = j;
      while (j1 + 1 < H && [...Array(i1 - i + 1).keys()].every((k) => inside[(j1 + 1) * W + i + k] === 1)) j1++;
      for (let jj = j; jj <= j1; jj++) for (let ii = i; ii <= i1; ii++) inside[jj * W + ii] = 2;
      out.push([xs[i]!, zs[j]!, xs[i1 + 1]!, zs[j1 + 1]!]);
    }
  return out;
}

interface Want {
  type: RoomTypeDef;
  /** Its share of the storey's floor (m²). */
  target: number;
}

/** Splits a zone among rooms by recursive cuts across its longer side (cut positions on the grid from the zone's corner). */
function treemap(rect: PlanRect, wants: readonly Want[], grid: number, out: { rect: PlanRect; want: Want }[], unplaced: Want[]): void {
  if (wants.length === 0) return;
  if (wants.length === 1) {
    out.push({ rect, want: wants[0]! });
    return;
  }
  const w = rect[2] - rect[0];
  const h = rect[3] - rect[1];
  const total = wants.reduce((s, x) => s + x.target, 0);
  let best: { k: number; along: boolean; at: number; cost: number } | null = null;
  for (const along of w >= h ? [true, false] : [false, true]) {
    const len = along ? w : h;
    const cross = along ? h : w;
    if (len < 2 * grid - EPS) continue;
    let acc = 0;
    for (let k = 1; k < wants.length; k++) {
      acc += wants[k - 1]!.target;
      const raw = (len * acc) / total;
      const at = Math.min(len - grid, Math.max(grid, Math.round(raw / grid) * grid));
      // Each side's worst aspect after the cut, and how far the cut is from the shares.
      const a = Math.max(at / cross, cross / at);
      const b = Math.max((len - at) / cross, cross / (len - at));
      const cost = Math.max(a, b) + (Math.abs(at - raw) / len) * 4 + (along === w >= h ? 0 : 0.5);
      if (best === null || cost < best.cost - EPS) best = { k, along, at, cost };
    }
  }
  if (best === null) {
    // Too small to cut: the first room takes the zone, the rest go unplaced.
    out.push({ rect, want: wants[0]! });
    unplaced.push(...wants.slice(1));
    return;
  }
  const { k, along, at } = best;
  const [x0, z0, x1, z1] = rect;
  const left: PlanRect = along ? [x0, z0, r6(x0 + at), z1] : [x0, z0, x1, r6(z0 + at)];
  const right: PlanRect = along ? [r6(x0 + at), z0, x1, z1] : [x0, r6(z0 + at), x1, z1];
  treemap(left, wants.slice(0, k), grid, out, unplaced);
  treemap(right, wants.slice(k), grid, out, unplaced);
}

/** Where two rooms' rectangles touch: the shared stretch of wall (null: they do not, or it is shorter than `min`). */
function touching(a: PlanRect, b: PlanRect, min: number): { along: 'x' | 'z'; line: number; lo: number; hi: number } | null {
  if (Math.abs(a[2] - b[0]) < EPS || Math.abs(b[2] - a[0]) < EPS) {
    const lo = Math.max(a[1], b[1]);
    const hi = Math.min(a[3], b[3]);
    if (hi - lo >= min - EPS) return { along: 'z', line: Math.abs(a[2] - b[0]) < EPS ? a[2] : a[0], lo, hi };
  }
  if (Math.abs(a[3] - b[1]) < EPS || Math.abs(b[3] - a[1]) < EPS) {
    const lo = Math.max(a[0], b[0]);
    const hi = Math.min(a[2], b[2]);
    if (hi - lo >= min - EPS) return { along: 'x', line: Math.abs(a[3] - b[1]) < EPS ? a[3] : a[1], lo, hi };
  }
  return null;
}

/** Whether a door (its middle x, z and width) lies wholly on one of a rectangle's sides. */
function onBoundary(r: PlanRect, x: number, z: number, width = 0): boolean {
  const tol = 1e-3;
  const w = width / 2 - tol;
  const inX = x - w > r[0] - tol && x + w < r[2] + tol;
  const inZ = z - w > r[1] - tol && z + w < r[3] + tol;
  return (inX && (Math.abs(z - r[1]) < tol || Math.abs(z - r[3]) < tol)) || (inZ && (Math.abs(x - r[0]) < tol || Math.abs(x - r[2]) < tol));
}

/** The side lengths (long, short; metres on the grid) a stair room takes. */
function stairSize(rise: number, storeys: number, grid: number): [number, number] {
  const strips = storeys > 2 ? 2 : 1;
  const up = (v: number): number => r6(Math.ceil(v / grid - EPS) * grid);
  return [up(rise * RUN_PER_RISE + 2 * STAIR_LANDING), up(strips * STAIR_WIDTH + 2 * STAIR_MARGIN)];
}

/**
 * The stair room's rectangle: at a corner of a zone, its long side along the
 * zone's, the corner nearest the front door that does not take the door (the
 * seed picks between equals); null when no zone is big enough.
 */
function carveStairs(zones: readonly PlanRect[], input: FloorPlanInput, storeys: number): PlanRect | null {
  const [long, short] = stairSize(input.storeyHeight, storeys, input.program.grid);
  const door = input.frontDoors[0];
  const rng = seededRandom(hashString(`${input.id}:stairs`, input.seed >>> 0));
  let best: { r: PlanRect; cost: number } | null = null;
  for (const z of zones) {
    const w = z[2] - z[0];
    const h = z[3] - z[1];
    for (const [sx, sz] of [[long, short], [short, long]] as const) {
      if (sx > w + EPS || sz > h + EPS) continue;
      for (const [ax, az] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const x0 = ax === 0 ? z[0] : r6(z[2] - sx);
        const z0 = az === 0 ? z[1] : r6(z[3] - sz);
        const r: PlanRect = [x0, z0, r6(x0 + sx), r6(z0 + sz)];
        const cx = (r[0] + r[2]) / 2;
        const cz = (r[1] + r[3]) / 2;
        let cost = rng();
        if (door !== undefined) cost += Math.hypot(cx - door[0], cz - door[1]) + (onBoundary(r, door[0], door[1], door[2]) ? 100 : 0);
        if (best === null || cost < best.cost) best = { r, cost };
      }
    }
  }
  return best?.r ?? null;
}

/** The flights of a stair room: along its longer side, switching back across it (null: it is too small). */
function flightsIn(rect: PlanRect, storeys: number, rise: number): { strips: number; width: number; run: number } | null {
  const w = rect[2] - rect[0];
  const h = rect[3] - rect[1];
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const run = rise * RUN_PER_RISE;
  if (long < run + 2 * STAIR_LANDING - EPS) return null;
  const strips = storeys > 2 ? 2 : 1;
  const width = Math.min(STAIR_WIDTH_MAX, (short - 2 * STAIR_MARGIN) / strips);
  return width < STAIR_WIDTH_MIN - EPS ? null : { strips, width, run };
}

interface Candidate {
  placed: { rect: PlanRect; want: Want }[];
  unplaced: Want[];
  cost: number;
}

/** One storey's rooms (by type and share) split over its zones: the best of the seeded orders. */
function splitStorey(zones: readonly PlanRect[], wants: readonly Want[], input: FloorPlanInput, storey: number, fixed: { rect: PlanRect; want: Want } | null): Candidate {
  const P = input.program;
  let best: Candidate | null = null;
  for (let t = 0; t < FLOOR_PLAN_TRIES; t++) {
    const rng = seededRandom(hashString(`${input.id}:${storey}:${t}`, input.seed >>> 0));
    const order = [...wants];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    // Rooms to zones: each to the zone with the most floor left (a zone's first room always fits).
    const left = zones.map((z) => area(z));
    const lists: Want[][] = zones.map(() => []);
    const zoneOrder = zones.map((_z, i) => i).sort((p, q) => left[q]! - left[p]! || p - q);
    const scale = zones.reduce((s, z) => s + area(z), 0) / Math.max(EPS, order.reduce((s, w) => s + w.target, 0));
    order.forEach((w, i) => {
      const zi = i < zoneOrder.length ? zoneOrder[i]! : left.indexOf(Math.max(...left));
      lists[zi]!.push(w);
      left[zi]! -= w.target * scale;
    });
    const placed: { rect: PlanRect; want: Want }[] = fixed !== null ? [fixed] : [];
    const unplaced: Want[] = [];
    zones.forEach((z, i) => {
      const list = lists[i]!;
      if (list.length === 0) return;
      // A zone too small for its rooms keeps the first: the others are reported.
      treemap(z, list.map((w) => ({ ...w, target: w.target * scale })), P.grid, placed, unplaced);
    });
    // Zones without a room become the spare-space type's.
    zones.forEach((z, i) => {
      if (lists[i]!.length > 0) return;
      const filler = P.rooms.find((r) => r.type === P.filler) ?? P.rooms[0];
      if (filler !== undefined) placed.push({ rect: z, want: { type: filler, target: area(z) } });
    });
    let cost = unplaced.length * 50;
    for (const p of placed) {
      const w = p.rect[2] - p.rect[0];
      const h = p.rect[3] - p.rect[1];
      cost += Math.max(w / h, h / w) - 1;
      cost += Math.max(0, P.minSide - Math.min(w, h)) * 10;
      cost += Math.abs(area(p.rect) / Math.max(EPS, p.want.target * scale) - 1) * 2;
    }
    for (const [a, b] of P.links) {
      const As = placed.filter((p) => p.want.type.type === a);
      const Bs = placed.filter((p) => p.want.type.type === b);
      if (As.length === 0 || Bs.length === 0) continue;
      if (!As.some((x) => Bs.some((y) => x !== y && touching(x.rect, y.rect, P.doorWidth + 2 * DOOR_JAMB) !== null))) cost += 8;
    }
    if (storey === 0 && P.entrance !== '' && input.frontDoors.length > 0) {
      const [dx, dz, dw] = input.frontDoors[0]!;
      if (!placed.some((p) => p.want.type.type === P.entrance && onBoundary(p.rect, dx, dz, dw))) cost += 15;
    }
    if (best === null || cost < best.cost - EPS) best = { placed, unplaced, cost };
  }
  return best!;
}

/** The rooms one storey holds (the stair room aside), each with its share as given. */
function wantsOn(P: RoomProgramDef, storey: number, storeys: number): Want[] {
  const out: Want[] = [];
  for (const t of P.rooms) {
    if (t.stairs && storeys > 1) continue;
    const on = t.storeys === 'every' || (t.storeys === 'ground' ? storey === 0 : storey > 0 || storeys === 1);
    if (!on) continue;
    for (let k = 0; k < t.count; k++) out.push({ type: t, target: t.area });
  }
  return out;
}

/** Shares scaled to fill a floor area. */
function scaled(wants: readonly Want[], floorArea: number): Want[] {
  const total = wants.reduce((s, w) => s + w.target, 0);
  return wants.map((w) => ({ ...w, target: total > 0 ? (w.target / total) * floorArea : 0 }));
}

/**
 * A building's floor plan by its program: rooms per storey, doors and
 * stairs. Problems name what could not be honoured (a footprint with
 * slanted sides is not split).
 */
export function splitFloorPlan(input: FloorPlanInput): FloorPlan {
  const P = input.program;
  const problems: string[] = [];
  const zones = footprintZones(input.footprint);
  const empty: FloorPlan = { rooms: [], doors: [], stairs: [], problems };
  if (zones === null) {
    problems.push(`building ${input.id}: program ${P.id} needs a footprint whose sides run along x and z`);
    return empty;
  }
  const storeys = Math.max(1, input.storeys);
  const floorArea = zones.reduce((s, z) => s + area(z), 0);
  const stairType = storeys > 1 ? P.rooms.find((r) => r.stairs) : undefined;
  if (storeys > 1 && stairType === undefined) problems.push(`building ${input.id}: program ${P.id} has no room holding the stairs, so its upper storeys are not reached`);
  const rooms: FloorPlanRoom[] = [];
  const doors: FloorPlanDoor[] = [];
  const stairs: FloorPlanStair[] = [];
  // The stair room first: a strip long and wide enough for its flights, in one place on every storey.
  const stairRect = stairType !== undefined ? carveStairs(zones, input, storeys) : null;
  if (stairType !== undefined && stairRect === null) problems.push(`building ${input.id}: no part of the footprint is long and wide enough for the stairs (${stairSize(input.storeyHeight, storeys, P.grid).join(' × ')} m)`);
  let stairRoom: FloorPlanRoom | null = null;
  let n = 0;
  const name = (): string => `${input.id}-r${++n}`;
  const rest = stairRect !== null ? (footprintZones(input.footprint, [stairRect]) ?? zones) : zones;
  for (let s = 0; s < storeys; s++) {
    const fixed = stairRect !== null ? { rect: stairRect, want: { type: stairType!, target: area(stairRect) } } : null;
    const wants = scaled(wantsOn(P, s, storeys), floorArea - (stairRect !== null ? area(stairRect) : 0));
    if (wants.length === 0 && fixed === null) continue;
    const got = splitStorey(rest, wants, input, s, fixed);
    for (const u of got.unplaced) problems.push(`building ${input.id}: a ${u.type.type} does not fit storey ${s}`);
    const here: FloorPlanRoom[] = [];
    for (const p of got.placed) {
      if (fixed !== null && p === fixed) {
        if (s > 0) continue;
        stairRoom = { id: name(), type: stairType!.type, storey: 0, storeys, rect: p.rect, preset: stairType!.preset };
        rooms.push(stairRoom);
        here.push(stairRoom);
        continue;
      }
      const room: FloorPlanRoom = { id: name(), type: p.want.type.type, storey: s, storeys: 1, rect: p.rect, preset: p.want.type.preset };
      rooms.push(room);
      here.push(room);
    }
    const on = stairRoom !== null && s > 0 ? [stairRoom, ...here] : here;
    doors.push(...doorsOf(on, s, input, s === 0 ? null : stairRoom));
  }
  const f = stairRoom !== null ? flightsIn(stairRoom.rect, storeys, input.storeyHeight) : null;
  if (stairRoom !== null && f !== null) stairs.push(...flightsOf(stairRoom, storeys, f));
  return { rooms, doors, stairs, problems };
}

/** The flights in a stair room: strip A from one end, strip B (or A again) back from the other, storey by storey. */
function flightsOf(room: FloorPlanRoom, storeys: number, f: { strips: number; width: number; run: number }): FloorPlanStair[] {
  const [x0, z0, x1] = room.rect;
  const z1 = room.rect[3];
  const alongX = x1 - x0 >= z1 - z0;
  const out: FloorPlanStair[] = [];
  for (let k = 0; k + 1 < storeys; k++) {
    const strip = f.strips === 2 ? k % 2 : 0;
    const across = STAIR_MARGIN + f.width * (strip + 0.5);
    const a = STAIR_LANDING;
    const b = STAIR_LANDING + f.run;
    // Odd flights start where the even ones end and run back on the other strip.
    const [s0, s1] = k % 2 === 0 ? [a, b] : [b, a];
    const pt = (d: number): [number, number] => (alongX ? [r6(x0 + d), r6(z0 + across)] : [r6(x0 + across), r6(z0 + d)]);
    out.push({ room: room.id, storey: k, from: pt(s0), to: pt(s1), width: r6(f.width) });
  }
  return out;
}

/** One storey's doors: the wired pairs that touch, then one per unreached room until all are reached. */
function doorsOf(rooms: readonly FloorPlanRoom[], storey: number, input: FloorPlanInput, root: FloorPlanRoom | null): FloorPlanDoor[] {
  const P = input.program;
  const min = P.doorWidth + 2 * DOOR_JAMB;
  const linked = (a: string, b: string): boolean => P.links.some(([p, q]) => (p === a && q === b) || (p === b && q === a));
  const out: FloorPlanDoor[] = [];
  const has = new Set<string>();
  const key = (a: FloorPlanRoom, b: FloorPlanRoom): string => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  const add = (a: FloorPlanRoom, b: FloorPlanRoom): boolean => {
    if (has.has(key(a, b))) return false;
    const t = touching(a.rect, b.rect, min);
    if (t === null) return false;
    // The door starts on the grid, as near the stretch's middle as the grid allows.
    const g = P.grid;
    const room = t.hi - t.lo - P.doorWidth;
    const start = t.lo + Math.max(DOOR_JAMB, Math.min(room - DOOR_JAMB, Math.floor(room / 2 / g) * g));
    const mid = r6(start + P.doorWidth / 2);
    has.add(key(a, b));
    out.push({ a: a.id, b: b.id, storey, at: t.along === 'x' ? [mid, t.line] : [t.line, mid], along: t.along, width: P.doorWidth, height: P.doorHeight });
    return true;
  };
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) if (linked(rooms[i]!.type, rooms[j]!.type)) add(rooms[i]!, rooms[j]!);
  // The entrance: the room the front door opens into (the program's type there first), else the largest.
  let start = root;
  if (start === null && input.frontDoors.length > 0) {
    const [dx, dz, dw] = input.frontDoors[0]!;
    const at = rooms.filter((r) => onBoundary(r.rect, dx, dz, dw));
    start = at.find((r) => r.type === P.entrance) ?? at[0] ?? null;
  }
  start ??= rooms.find((r) => r.type === P.entrance) ?? [...rooms].sort((p, q) => area(q.rect) - area(p.rect))[0] ?? null;
  if (start === null) return out;
  const reached = new Set<string>([start.id]);
  const grow = (): void => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const d of out) {
        if (reached.has(d.a) !== reached.has(d.b)) {
          reached.add(d.a);
          reached.add(d.b);
          changed = true;
        }
      }
    }
  };
  grow();
  // Rooms whose front-door wall opens them to the outside count as reached too (their own way in).
  for (const r of rooms) if (input.frontDoors.some(([dx, dz, dw]) => storey === 0 && onBoundary(r.rect, dx, dz, dw))) reached.add(r.id);
  grow();
  while (reached.size < rooms.length) {
    let best: { a: FloorPlanRoom; b: FloorPlanRoom; rank: number } | null = null;
    for (const a of rooms) {
      if (reached.has(a.id)) continue;
      for (const b of rooms) {
        if (!reached.has(b.id)) continue;
        const t = touching(a.rect, b.rect, min);
        if (t === null) continue;
        const rank = (linked(a.type, b.type) ? 1000 : 0) + (b.type === P.filler || b.type === P.entrance ? 100 : 0) + (t.hi - t.lo);
        if (best === null || rank > best.rank + EPS) best = { a, b, rank };
      }
    }
    if (best === null) break;
    add(best.a, best.b);
    reached.add(best.a.id);
    grow();
  }
  return out;
}

/** A room's outline corners (x, z) with its inside to the right of travel, starting at its min corner. */
export function planRectCorners(r: PlanRect): [number, number][] {
  return [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ];
}

/** Metres along a room's outline (from {@link planRectCorners}' first corner) to a point on its boundary. */
export function distanceAlongRect(r: PlanRect, x: number, z: number): number {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const tol = 1e-3;
  if (Math.abs(z - r[1]) < tol) return r6(x - r[0]);
  if (Math.abs(x - r[2]) < tol) return r6(w + (z - r[1]));
  if (Math.abs(z - r[3]) < tol) return r6(w + h + (r[2] - x));
  return r6(2 * w + h + (r[3] - z));
}
