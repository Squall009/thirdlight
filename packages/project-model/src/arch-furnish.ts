/**
 * Furnishing: a furnishing set's props (`arch-plan-kinds.ts`) placed in a
 * building's rooms by type, deterministic per building seed.
 *
 * - Each room is read on a grid of {@link FURNISH_CELL} cells over its
 *   inside (the walls' inner faces). Kept free of props: a clearance in
 *   front of each door (both sides of a door between rooms), the stairs and
 *   holes in the floor, and windows for props taller than their sill.
 * - A prop stands with its back against a wall facing the room, in a
 *   corner (against the wall it faces out of, its side at the next wall),
 *   or in the middle facing the room's first door; the candidates are tried
 *   in a seeded order and the first that fits is kept: inside the room,
 *   clear of other props by its spacing, and leaving a walkable path (the
 *   set's path width) joining every door and stair foot the room had
 *   before (a flood fill over the cells).
 * - Pinned props (hand edits) stand first, where they were pinned; a
 *   generated prop of the same id is not placed again.
 * - Lights: one per room whose type a Light node names, largest rooms
 *   first, up to the set's light count per building.
 *
 * Pure.
 */
import { detSinCos, DEG, hashString, seededRandom } from './arch-math';
import { distanceToEdges, pointInPolygon } from './arch-mesh';
import type { FurnishingPropDef, FurnishingSetDef } from './arch-plan-kinds';

/** Metres per cell of a room's furnishing grid (the walkable-path test's resolution). */
export const FURNISH_CELL = 0.2;
/** Metres between candidate places along a wall. */
const STEP = 0.25;
/** Metres out from a wall a window keeps free of props taller than its sill. */
const WINDOW_DEPTH = 0.6;

/** A door or window in one of a room's walls (x, z of its middle on the wall line). */
export interface FurnishOpening {
  at: [number, number];
  width: number;
  /** Its sill over the floor (doors: 0). */
  sill: number;
  door: boolean;
}

/** A room to furnish (the object's frame). */
export interface FurnishRoom {
  id: string;
  type: string;
  /** The outline's corners (x, z), inside to the right of travel. */
  points: readonly (readonly [number, number])[];
  /** Metres from the outline to its walls' inner faces. */
  half: number;
  floor: number;
  top: number;
  openings: readonly FurnishOpening[];
  /** Kept free: stairs' and floor holes' footprints (x, z corners). */
  obstacles: readonly (readonly (readonly [number, number])[])[];
  /** Where the walkable path must reach besides the doors: stair feet and arrivals (x, z). */
  anchors: readonly (readonly [number, number])[];
}

/** A pinned prop (stored on the building): kept where it is. */
export interface FurnishPin {
  id: string;
  model: { assetId: string; piece?: string };
  position: [number, number, number];
  /** Degrees about +Y turning +Z (the prop's front) toward +X. */
  facing: number;
  /** Its footprint (metres; absent: half a metre square). */
  size?: [number, number];
}

/** A prop placed (or pinned). */
export interface FurnishedProp {
  /** `<room>-<prop node>-<n>`: the same prop of the same room under any seed. */
  id: string;
  room: string;
  model: { assetId: string; piece?: string };
  position: [number, number, number];
  facing: number;
  size: [number, number];
  pinned: boolean;
  /** The building it stands in (set by the expansion). */
  building?: string;
}

export interface FurnishedLight {
  id: string;
  room: string;
  position: [number, number, number];
  color: string;
  intensity: number;
  range: number;
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3;
const PIN_SIZE: [number, number] = [0.5, 0.5];

/** The facing angle (degrees, +Z toward (dx, dz)) of a direction on the ground. */
export function facingOf(dx: number, dz: number): number {
  if (Math.abs(dx) < 1e-9) return dz >= 0 ? 0 : 180;
  if (Math.abs(dz) < 1e-9) return dx > 0 ? 90 : -90;
  return r6((Math.atan2(dx, dz) * 180) / Math.PI);
}

/** The direction (x, z) a facing angle turns +Z to. */
export function facingDir(facing: number): [number, number] {
  const sc: [number, number] = [0, 0];
  detSinCos(facing * DEG, sc);
  return [sc[0], sc[1]];
}

/** A room's walls' inner faces: the outline moved in by `half`, corners mitred. */
function innerPolygon(points: readonly (readonly [number, number])[], half: number): [number, number][] {
  const n = points.length;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = points[(i - 1 + n) % n]!;
    const q = points[i]!;
    const r = points[(i + 1) % n]!;
    const d0 = norm(q[0] - p[0], q[1] - p[1]);
    const d1 = norm(r[0] - q[0], r[1] - q[1]);
    // Right of travel (the inside): (-dz, dx).
    const n0: [number, number] = [-d0[1], d0[0]];
    const n1: [number, number] = [-d1[1], d1[0]];
    const mx = n0[0] + n1[0];
    const mz = n0[1] + n1[1];
    const dot = mx * n1[0] + mz * n1[1];
    const k = Math.abs(dot) < 1e-9 ? half : half / dot;
    out.push([q[0] + mx * k, q[1] + mz * k]);
  }
  return out;
}

function norm(x: number, z: number): [number, number] {
  const l = Math.sqrt(x * x + z * z) || 1;
  return [x / l, z / l];
}

/** A rectangle on the ground (centre, half sizes along its own X and Z, its X axis). */
interface Box {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  ax: number;
  az: number;
}

const boxOf = (cx: number, cz: number, width: number, depth: number, facing: number, grow = 0): Box => {
  const [fx, fz] = facingDir(facing);
  // +X is +Z turned a right angle the other way: (fz, -fx).
  return { cx, cz, hx: width / 2 + grow, hz: depth / 2 + grow, ax: fz, az: -fx };
};

/** The furnishing grid of one room: which cells are inside, taken, near a prop, and windows' sills. */
class RoomGrid {
  readonly x0: number;
  readonly z0: number;
  readonly W: number;
  readonly H: number;
  readonly inside: Uint8Array;
  /** Props may not stand here (props, door clearances, obstacles). */
  readonly taken: Uint8Array;
  /** Not walkable: props and obstacles grown by half the path width. */
  readonly near: Uint8Array;
  /** The lowest window sill over a cell near a window (Infinity: none). */
  readonly sill: Float32Array;
  readonly poly: Float64Array;

  constructor(inner: readonly [number, number][], walkReach: number) {
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of inner) [x0, z0, x1, z1] = [Math.min(x0, x), Math.min(z0, z), Math.max(x1, x), Math.max(z1, z)];
    this.x0 = x0;
    this.z0 = z0;
    this.W = Math.max(1, Math.ceil((x1 - x0) / FURNISH_CELL));
    this.H = Math.max(1, Math.ceil((z1 - z0) / FURNISH_CELL));
    const N = this.W * this.H;
    this.inside = new Uint8Array(N);
    this.taken = new Uint8Array(N);
    this.near = new Uint8Array(N);
    this.sill = new Float32Array(N).fill(Infinity);
    this.poly = Float64Array.from(inner.flatMap((p) => p));
    // Rooms of a plan are rectangles along the axes: their cells' tests are a box's.
    const box = inner.length === 4 && inner.every((p, i) => {
      const q = inner[(i + 1) % 4]!;
      return Math.abs(p[0] - q[0]) < 1e-9 || Math.abs(p[1] - q[1]) < 1e-9;
    });
    for (let j = 0; j < this.H; j++)
      for (let i = 0; i < this.W; i++) {
        const [x, z] = this.centre(i, j);
        const k = j * this.W + i;
        if (box ? x < x0 || x > x1 || z < z0 || z > z1 : !pointInPolygon(x, z, this.poly)) continue;
        this.inside[k] = 1;
        // A walker's middle stays half the path width from the walls.
        const d = box ? Math.min(x - x0, x1 - x, z - z0, z1 - z) : distanceToEdges(x, z, this.poly);
        if (d < walkReach) this.near[k] = 1;
      }
  }

  centre(i: number, j: number): [number, number] {
    return [this.x0 + (i + 0.5) * FURNISH_CELL, this.z0 + (j + 0.5) * FURNISH_CELL];
  }

  cellAt(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / FURNISH_CELL);
    const j = Math.floor((z - this.z0) / FURNISH_CELL);
    return i < 0 || j < 0 || i >= this.W || j >= this.H ? -1 : j * this.W + i;
  }

  /** The cells whose middles lie in a box (out-of-grid parts reported by `outside`). */
  cells(b: Box, out: number[]): { outside: boolean } {
    out.length = 0;
    const ex = Math.abs(b.ax) * b.hx + Math.abs(b.az) * b.hz;
    const ez = Math.abs(b.az) * b.hx + Math.abs(b.ax) * b.hz;
    const i0 = Math.floor((b.cx - ex - this.x0) / FURNISH_CELL);
    const i1 = Math.floor((b.cx + ex - this.x0) / FURNISH_CELL);
    const j0 = Math.floor((b.cz - ez - this.z0) / FURNISH_CELL);
    const j1 = Math.floor((b.cz + ez - this.z0) / FURNISH_CELL);
    let outside = false;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + (i + 0.5) * FURNISH_CELL - b.cx;
        const z = this.z0 + (j + 0.5) * FURNISH_CELL - b.cz;
        const u = x * b.ax + z * b.az;
        const v = -x * b.az + z * b.ax;
        if (Math.abs(u) > b.hx || Math.abs(v) > b.hz) continue;
        if (i < 0 || j < 0 || i >= this.W || j >= this.H || this.inside[j * this.W + i] !== 1) outside = true;
        else out.push(j * this.W + i);
      }
    return { outside };
  }

  /** Marks a polygon's cells (and those within `grow` of it) in a grid. */
  markPolygon(pts: readonly (readonly [number, number])[], grid: Uint8Array, grow: number): void {
    const poly = Float64Array.from(pts.flatMap((p) => [p[0], p[1]]));
    for (let k = 0; k < grid.length; k++) {
      if (this.inside[k] !== 1) continue;
      const [x, z] = this.centre(k % this.W, Math.floor(k / this.W));
      if (pointInPolygon(x, z, poly) || (grow > 0 && distanceToEdges(x, z, poly) < grow)) grid[k] = 1;
    }
  }

  /** The walkable cells reached from `from` (a flood fill; `extra` cells counted as not walkable). */
  reach(from: number, extra: ReadonlySet<number> | null): Uint8Array {
    const seen = new Uint8Array(this.inside.length);
    const ok = (k: number): boolean => this.inside[k] === 1 && this.near[k] !== 1 && (extra === null || !extra.has(k));
    if (from < 0 || !ok(from)) return seen;
    const stack = [from];
    seen[from] = 1;
    while (stack.length > 0) {
      const k = stack.pop()!;
      const i = k % this.W;
      const j = (k - i) / this.W;
      const visit = (q: number): void => {
        if (seen[q] !== 1 && ok(q)) {
          seen[q] = 1;
          stack.push(q);
        }
      };
      if (i > 0) visit(k - 1);
      if (i + 1 < this.W) visit(k + 1);
      if (j > 0) visit(k - this.W);
      if (j + 1 < this.H) visit(k + this.W);
    }
    return seen;
  }
}

/** The side of a room's outline an opening's middle lies on (its index), or -1. */
function sideOf(points: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = -1;
  let bestD = 0.05;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    const d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** A candidate place of a prop: its middle and facing. */
interface Place {
  x: number;
  z: number;
  facing: number;
}

function candidates(p: FurnishingPropDef, inner: readonly [number, number][], gap: number, doorFacing: number | null): Place[] {
  const out: Place[] = [];
  const n = inner.length;
  if (p.place === 'centre') {
    let cx = 0;
    let cz = 0;
    for (const [x, z] of inner) {
      cx += x;
      cz += z;
    }
    cx /= n;
    cz /= n;
    const facing = doorFacing ?? 0;
    for (let ring = 0; ring <= 4; ring++)
      for (let a = -ring; a <= ring; a++)
        for (let b = -ring; b <= ring; b++) if (Math.max(Math.abs(a), Math.abs(b)) === ring) out.push({ x: cx + a * 0.5, z: cz + b * 0.5, facing });
    return out;
  }
  for (let i = 0; i < n; i++) {
    const a = inner[i]!;
    const b = inner[(i + 1) % n]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < p.width + 2 * gap) continue;
    const [dx, dz] = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const nx = -dz;
    const nz = dx;
    const facing = facingOf(nx, nz);
    const off = gap + p.depth / 2;
    const at = (t: number): Place => ({ x: a[0] + dx * t + nx * off, z: a[1] + dz * t + nz * off, facing });
    if (p.place === 'corner') {
      out.push(at(gap + p.width / 2), at(L - gap - p.width / 2));
      continue;
    }
    for (let t = gap + p.width / 2; t <= L - gap - p.width / 2 + 1e-9; t += STEP) out.push(at(t));
  }
  return out;
}

/** Rooms furnished, per set (a set read again is a new object): the editor expands the same buildings at every edit. */
const furnished = new WeakMap<FurnishingSetDef, Map<string, FurnishedProp[]>>();
/** Rooms remembered per set before the memory starts over. */
const FURNISHED_KEPT = 4096;

/**
 * Props for one room: pins first, then the set's props for its type in
 * their order, each copy at the first seeded candidate that fits.
 */
export function furnishRoom(room: FurnishRoom, set: FurnishingSetDef, seed: number, pins: readonly FurnishPin[]): FurnishedProp[] {
  let memo = furnished.get(set);
  if (memo === undefined) furnished.set(set, (memo = new Map()));
  const key = JSON.stringify([room, seed, pins]);
  const known = memo.get(key);
  if (known !== undefined) return known;
  if (memo.size >= FURNISHED_KEPT) memo.clear();
  const made = placeProps(room, set, seed, pins);
  memo.set(key, made);
  return made;
}

function placeProps(room: FurnishRoom, set: FurnishingSetDef, seed: number, pins: readonly FurnishPin[]): FurnishedProp[] {
  const inner = innerPolygon(room.points, room.half);
  const reachR = set.pathWidth / 2;
  const g = new RoomGrid(inner, reachR);
  const out: FurnishedProp[] = [];
  const cells: number[] = [];
  const grown: number[] = [];
  // Doors: a clearance in front (props not there, walkers welcome); their walking anchors just inside.
  const anchors: number[] = [];
  let doorFacing: number | null = null;
  for (const o of room.openings) {
    const side = sideOf(room.points, o.at[0], o.at[1]);
    if (side < 0) continue;
    const a = room.points[side]!;
    const b = room.points[(side + 1) % room.points.length]!;
    const [dx, dz] = norm(b[0] - a[0], b[1] - a[1]);
    const [nx, nz] = [-dz, dx];
    const facing = facingOf(nx, nz);
    if (o.door) {
      const depth = set.doorClearance;
      const c = boxOf(o.at[0] + nx * (room.half + depth / 2), o.at[1] + nz * (room.half + depth / 2), o.width + 0.2, depth, facing);
      g.cells(c, cells);
      for (const k of cells) g.taken[k] = 1;
      anchors.push(g.cellAt(o.at[0] + nx * (room.half + reachR + FURNISH_CELL), o.at[1] + nz * (room.half + reachR + FURNISH_CELL)));
      doorFacing ??= facingOf(-nx, -nz);
    } else {
      const c = boxOf(o.at[0] + nx * (room.half + WINDOW_DEPTH / 2), o.at[1] + nz * (room.half + WINDOW_DEPTH / 2), o.width, WINDOW_DEPTH, facing);
      g.cells(c, cells);
      for (const k of cells) g.sill[k] = Math.min(g.sill[k]!, o.sill);
    }
  }
  for (const ob of room.obstacles) {
    g.markPolygon(ob, g.taken, 0);
    g.markPolygon(ob, g.near, reachR);
  }
  for (const [x, z] of room.anchors) anchors.push(g.cellAt(x, z));
  // The anchors walkable before any prop: those the path must keep joined.
  const first = anchors.find((k) => k >= 0 && g.inside[k] === 1 && g.near[k] !== 1);
  const joined = first === undefined ? [] : (() => {
    const seen = g.reach(first, null);
    return anchors.filter((k) => k >= 0 && seen[k] === 1);
  })();
  const keepsPath = (block: ReadonlySet<number>): boolean => {
    if (joined.length < 2) return joined.length === 0 || !block.has(joined[0]!);
    const seen = g.reach(joined[0]!, block);
    return joined.every((k) => seen[k] === 1);
  };
  const stand = (b: Box, grownBox: Box): void => {
    g.cells(b, cells);
    for (const k of cells) g.taken[k] = 1;
    g.cells(grownBox, grown);
    for (const k of grown) g.near[k] = 1;
  };
  const pinned = new Set<string>();
  for (const pin of pins) {
    const size = pin.size ?? PIN_SIZE;
    stand(boxOf(pin.position[0], pin.position[2], size[0], size[1], pin.facing), boxOf(pin.position[0], pin.position[2], size[0], size[1], pin.facing, reachR));
    pinned.add(pin.id);
    out.push({ id: pin.id, room: room.id, model: pin.model, position: pin.position, facing: pin.facing, size, pinned: true });
  }
  const y = r6(room.floor);
  for (const p of set.props) {
    if (p.room !== '' && p.room !== room.type) continue;
    const places = candidates(p, inner, set.wallGap, doorFacing);
    for (let n = 0; n < p.count; n++) {
      const id = `${room.id}-${p.node}-${n}`.slice(0, 96);
      if (pinned.has(id)) continue;
      const rng = seededRandom(hashString(`${id}`, seed >>> 0));
      const order = places.map((c, i) => ({ c, k: p.place === 'centre' ? i + rng() * 0.5 : rng() }));
      order.sort((u, v) => u.k - v.k);
      for (const { c } of order) {
        const body = boxOf(c.x, c.z, p.width, p.depth, c.facing);
        const spaced = boxOf(c.x, c.z, p.width, p.depth, c.facing, p.spacing);
        // Inside the room, clear of other props (by its spacing), door clearances and obstacles.
        if (g.cells(body, cells).outside) continue;
        if (cells.length === 0) continue;
        g.cells(spaced, grown);
        if (grown.some((k) => g.taken[k] === 1)) continue;
        if (cells.some((k) => g.sill[k]! < p.height)) continue;
        // The walkable path still joins the doors and stairs with it standing.
        g.cells(boxOf(c.x, c.z, p.width, p.depth, c.facing, reachR), grown);
        if (!keepsPath(new Set(grown))) continue;
        stand(body, boxOf(c.x, c.z, p.width, p.depth, c.facing, reachR));
        const model = p.piece !== '' ? { assetId: p.model, piece: p.piece } : { assetId: p.model };
        out.push({ id, room: room.id, model, position: [r6(c.x), y, r6(c.z)], facing: r3(c.facing), size: [p.width, p.depth], pinned: false });
        break;
      }
    }
  }
  return out;
}

/** One light per room a Light node names (by type), the largest rooms first, up to the set's count. */
export function furnishLights(rooms: readonly FurnishRoom[], set: FurnishingSetDef): FurnishedLight[] {
  if (set.lights <= 0 || set.lightDefs.length === 0) return [];
  const sized = rooms.map((r) => {
    let a = 0;
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i]!;
      const q = r.points[(i + 1) % r.points.length]!;
      a += p[0] * q[1] - q[0] * p[1];
    }
    return { r, area: Math.abs(a) / 2 };
  });
  sized.sort((p, q) => q.area - p.area || (p.r.id < q.r.id ? -1 : 1));
  const out: FurnishedLight[] = [];
  for (const { r } of sized) {
    if (out.length >= set.lights) break;
    const def = set.lightDefs.find((d) => d.room === '' || d.room === r.type);
    if (def === undefined) continue;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of r.points) {
      cx += x;
      cz += z;
    }
    cx /= r.points.length;
    cz /= r.points.length;
    const y = Math.min(r.floor + def.height, r.top - 0.1);
    out.push({ id: `${r.id}-light`, room: r.id, position: [r6(cx), r6(y), r6(cz)], color: def.color, intensity: def.intensity, range: def.range });
  }
  return out;
}
