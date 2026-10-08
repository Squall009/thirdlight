/**
 * Rooms and runs: an `architecture` component's outlines made into the
 * elements the generator makes. `expandArchitecture` is the one entry point
 * the page, the generator workers' keys, the simulation and an export use.
 *
 * Each outline goes through its preset's style (`arch-style.ts`). A closed
 * outline is a room, drawn with its inside to the right of travel:
 * - Storeys: the outline raised by the storey height (absent: the top of
 *   the room's walls) once per storey, each with its own openings; floors
 *   (the style's flat fills facing up) are the slabs, cut by the room's
 *   holes and by stairs that reach them.
 * - Shared walls: where two rooms' outlines run along one line at one
 *   height, the wall (the style's sweep marked `wall`, drawn on the outline)
 *   is made once, by the room listed first. Its face toward the other room
 *   wears that room's own inside rows (`segmentSlots`), the other room's
 *   wall is cut there (its remaining runs stop at the owner's face), and a
 *   door either room puts there is cut through the one wall, framed on both
 *   sides and cut into both rooms' trims.
 * - Outside: a room's `outside` preset dresses the walls' outer faces (its
 *   wall's inside rows) and runs its trims (not its walls or fills) along
 *   the outline's stretches no other room shares.
 * - Stairs: a stepped profile swept across the flight's width, its sides
 *   capped, colliding step by step.
 * An open outline is a run (a rail, a fence, a pipe): its style alone.
 *
 * Buildings (`buildings`) are rooms with a roof over their top storey (a
 * fill over the footprint, `arch-roof.ts`). One whose interior is a scene of
 * its own is made in two parts from the one definition: here the exterior
 * (walls, floors and ceilings, so windows show rooms; the facade and the
 * roof; no inside trims or stairs), and in that scene the interior (an
 * object the build makes there, `interiorOf`: everything but the facade's
 * trims and the roof). Their walls are the same sweep with the same
 * openings, so windows and doors line up on both sides.
 *
 * Pure and deterministic (plain arithmetic), like the rest of the generator.
 */
import { buildingFloorPlan, floorPlanOutlines, propElement } from './arch-building-plan';
import { architectureOutlineGroups, groupContextText, internElements, rememberedGroups } from './arch-groups';
import { furnishLights, furnishRoom, type FurnishedLight, type FurnishedProp, type FurnishOpening, type FurnishRoom } from './arch-furnish';
import { pointInPolygon } from './arch-mesh';
import { pathPointAt, samplePath } from './arch-path';
import {
  architectureProfileName,
  evaluateStyle,
  middleOf,
  paramValue,
  resolveArchitecturePreset,
  type ArchitectureExpansion,
  type ArchitecturePreview,
  type ArchitectureRoomOpening,
  type ArchitectureRoomPlan,
  type ArchitectureStyles,
  type ResolvedArchitecturePreset,
} from './arch-style';
import {
  ARCHITECTURE_DOOR_SILL_MAX,
  ARCHITECTURE_ROOF_OVERHANG_DEFAULT,
  ARCHITECTURE_ROOF_SLOT_DEFAULT,
  ARCHITECTURE_STAIR_RISER,
  type ArchitectureBuilding,
  type ArchitectureComponent,
  type ArchitectureElement,
  type ArchitectureFill,
  type ArchitectureOpening,
  type ArchitectureOutline,
  type ArchitecturePaint,
  type ArchitecturePath,
  type ArchitectureProfile,
  type ArchitectureStair,
  type ArchitectureSweep,
} from './architecture';

/** Metres one storey rises when the room's style has no wall to measure (and names no storey height). */
export const ARCHITECTURE_STOREY_HEIGHT_FALLBACK = 3;
/**
 * Metres a room's ground floor lies above its outline when the room is drawn
 * on a block layer: the layer's cell tops are there, and the floor laid over
 * them must not share their plane (it would flicker against them).
 */
export const ARCHITECTURE_FLOOR_ON_CELLS = 0.01;
/** Slots a stair wears: its treads, its risers, back and sides. */
export const ARCHITECTURE_STAIR_SLOTS = Object.freeze({ tread: 'floor', riser: 'lower_wall' });

/** Lengths and heights closer than this are one (metres): drawn points snap to cells, so shared lines meet exactly. */
const EPS = 1e-4;

const NO_MATERIALS: Readonly<Record<string, string>> = Object.freeze({});
const NO_SET: ReadonlySet<string> = new Set();

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const sq = (v: number): number => v * v;

/**
 * What of a building an object makes: all of it (its interior in place),
 * the exterior (its interior is a scene of its own: walls, floors and
 * ceilings so the windows show rooms, the facade and the roof; no inside
 * trims or stairs), or the interior (that scene's: everything but the
 * facade's trims and the roof).
 */
type BuildingPart = 'whole' | 'exterior' | 'interior';

/** An outline resolved: its preset (and outside preset) and its parameters' values. */
interface Styled {
  o: ArchitectureOutline;
  index: number;
  r: ResolvedArchitecturePreset;
  value: (name: string) => number;
  outside: { r: ResolvedArchitecturePreset; value: (name: string) => number } | null;
  /** The building it is (null: a room or a run), and what of it this object makes. */
  building: ArchitectureBuilding | null;
  part: BuildingPart;
  /** The building it is a room of (its program's, or naming it), whose part it takes. */
  parent: Styled | null;
}

/** A stretch of a room's outline another room's runs along too. */
interface Span {
  a: number;
  b: number;
  other: Inst;
  /** This room makes the wall there (it is listed first). */
  owner: boolean;
  /** The same stretch along the other room. */
  twin: Span | null;
  /** Both rooms lie on one side of the wall (a building and a room of it). */
  same: boolean;
}

/** One storey of a room (or a run): the outline as evaluated. */
interface Inst {
  s: Styled;
  storey: number;
  id: string;
  path: ArchitecturePath;
  base: number;
  /** The outline's corners when it is straight, closed and level (only those share walls). */
  poly: [number, number, number][] | null;
  /** Distance along the outline to each corner (and the length last). */
  dist: number[];
  openings: ArchitectureOpening[];
  /** Openings of rooms beside it on shared stretches (along this outline). */
  extra: ArchitectureOpening[];
  /** Of those, its building's (doors and windows in the building's walls): this room's own holes to the outside. */
  parentExtra: ArchitectureOpening[];
  spans: Span[];
  elements: ArchitectureElement[];
  wall: ArchitectureSweep | null;
  /** Metres its wall reaches either side of the outline. */
  half: number;
}

/** The value function of one outline's parameters (memoized; masks read at the outline's middle). */
function valuesOf(r: ResolvedArchitecturePreset, o: ArchitectureOutline, c: ArchitectureComponent, origin: readonly number[]): (name: string) => number {
  const style = r.style!;
  const at = middleOf(o.path);
  const values = new Map<string, number>();
  return (name: string): number => {
    const known = values.get(name);
    if (known !== undefined) return known;
    const p = style.params.get(name);
    const v = p === undefined ? 0 : paramValue(p, r, at, c, origin);
    values.set(name, v);
    return v;
  };
}

/** The path raised by `dy` metres. */
function raised(p: ArchitecturePath, dy: number): ArchitecturePath {
  if (dy === 0) return p;
  return { ...p, points: p.points.map((q) => [q[0], r6(q[1] + dy), q[2]] as [number, number, number]) };
}

/** The path walked the other way (its arcs bulging the same way in space). */
export function reversedPath(p: ArchitecturePath): ArchitecturePath {
  const pts = [...p.points].reverse();
  const out: ArchitecturePath = { ...p, points: pts };
  if (p.bulges !== undefined) {
    const n = p.points.length;
    const segs = p.closed === true ? n : n - 1;
    const b: number[] = [];
    // Reversed segment k joins reversed points k and k + 1: the original segment segs - 1 - k (closed: shifted by the start).
    for (let k = 0; k < segs; k++) b.push(-(p.bulges[p.closed === true ? (segs - 2 - k + segs) % segs : segs - 1 - k] ?? 0));
    out.bulges = b;
  }
  return out;
}

/** The corners of a straight, closed, level outline (null: arcs, a curve, an offset or chamfer, or heights that differ). */
function straightPolygon(p: ArchitecturePath): [number, number, number][] | null {
  if (p.closed !== true || p.points.length < 3 || p.curve === true || (p.offset ?? 0) !== 0 || (p.chamfer ?? 0) !== 0) return null;
  if ((p.bulges ?? []).some((b) => b !== 0)) return null;
  const y = p.points[0]![1];
  if (p.points.some((q) => Math.abs(q[1] - y) > EPS)) return null;
  return p.points.map((q) => [q[0], q[1], q[2]]);
}

function cumulative(poly: readonly (readonly number[])[], closed: boolean): number[] {
  const out = [0];
  const n = poly.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    out.push(out[i]! + Math.sqrt(sq(b[0]! - a[0]!) + sq(b[2]! - a[2]!)));
  }
  return out;
}

/** The point at `d` along a straight polyline (closed: wraps). */
function pointAlong(poly: readonly (readonly number[])[], dist: readonly number[], closed: boolean, d: number): [number, number, number] {
  const L = dist[dist.length - 1]!;
  let x = closed && L > 0 ? ((d % L) + L) % L : Math.max(0, Math.min(L, d));
  const segs = dist.length - 1;
  let i = 0;
  while (i < segs - 1 && dist[i + 1]! <= x) i++;
  const a = poly[i]!;
  const b = poly[(i + 1) % poly.length]!;
  const span = dist[i + 1]! - dist[i]!;
  const f = span > 0 ? (x - dist[i]!) / span : 0;
  x = f;
  return [r6(a[0]! + (b[0]! - a[0]!) * x), r6(a[1]! + (b[1]! - a[1]!) * x), r6(a[2]! + (b[2]! - a[2]!) * x)];
}

/** Where two rooms' outlines run along one line: the stretches along each (distances), or none. */
function sharedStretches(A: Inst, B: Inst): { a: [number, number]; b: [number, number]; same: boolean }[] {
  const out: { a: [number, number]; b: [number, number]; same: boolean }[] = [];
  const pa = A.poly!;
  const pb = B.poly!;
  for (let i = 0; i < pa.length; i++) {
    const a0 = pa[i]!;
    const a1 = pa[(i + 1) % pa.length]!;
    const dx = a1[0] - a0[0];
    const dz = a1[2] - a0[2];
    const la = Math.sqrt(dx * dx + dz * dz);
    if (la < EPS) continue;
    const ux = dx / la;
    const uz = dz / la;
    for (let j = 0; j < pb.length; j++) {
      const b0 = pb[j]!;
      const b1 = pb[(j + 1) % pb.length]!;
      // Both ends of B's side on A's line.
      const off0 = (b0[0] - a0[0]) * -uz + (b0[2] - a0[2]) * ux;
      const off1 = (b1[0] - a0[0]) * -uz + (b1[2] - a0[2]) * ux;
      if (Math.abs(off0) > EPS || Math.abs(off1) > EPS) continue;
      const t0 = (b0[0] - a0[0]) * ux + (b0[2] - a0[2]) * uz;
      const t1 = (b1[0] - a0[0]) * ux + (b1[2] - a0[2]) * uz;
      const lo = Math.max(0, Math.min(t0, t1));
      const hi = Math.min(la, Math.max(t0, t1));
      if (hi - lo < EPS * 10) continue;
      const lb = Math.abs(t1 - t0);
      // Along B's side: from b0 at 0 to b1 at lb.
      const tb = (t: number): number => (t1 > t0 ? t - t0 : t0 - t);
      const sb0 = tb(lo);
      const sb1 = tb(hi);
      // Rooms either side of a wall walk it opposite ways (each keeps its inside on its right); one inside the other, the same way.
      out.push({ a: [A.dist[i]! + lo, A.dist[i]! + hi], b: [B.dist[j]! + Math.max(0, Math.min(lb, Math.min(sb0, sb1))), B.dist[j]! + Math.max(0, Math.min(lb, Math.max(sb0, sb1)))], same: t1 > t0 });
    }
  }
  return out;
}

/** A wall profile's faces on one side: the segments wholly right (inside) or left (outside) of the path, by height. */
function faceRows(def: ArchitectureProfile, side: 1 | -1): { y0: number; y1: number; slot: string }[] {
  const out: { y0: number; y1: number; slot: string }[] = [];
  const n = def.points.length;
  const segs = def.closed === true ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const a = def.points[k]!;
    const b = def.points[(k + 1) % n]!;
    if (a[0] * side > EPS && b[0] * side > EPS) out.push({ y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), slot: def.slots[k] ?? '' });
  }
  return out;
}

/**
 * A wall profile's slots with its outer (left) faces — or, for a room inside
 * the wall's own room (`side` 1), its inner faces — wearing the rows
 * another's inner (right) faces wear at their heights.
 */
function slotsFacing(def: ArchitectureProfile, other: ArchitectureProfile, side: 1 | -1 = -1): string[] | null {
  const rows = faceRows(other, 1);
  if (rows.length === 0) return null;
  const n = def.points.length;
  const segs = def.closed === true ? n : n - 1;
  const slots = def.slots.slice(0, segs);
  let changed = false;
  for (let k = 0; k < segs; k++) {
    const a = def.points[k]!;
    const b = def.points[(k + 1) % n]!;
    if (!(a[0] * side > EPS && b[0] * side > EPS)) continue;
    const ym = (a[1] + b[1]) / 2;
    let best = rows[0]!;
    let bestD = Infinity;
    for (const r of rows) {
      const d = ym < r.y0 ? r.y0 - ym : ym > r.y1 ? ym - r.y1 : 0;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (slots[k] !== best.slot) {
      slots[k] = best.slot;
      changed = true;
    }
  }
  return changed ? slots : def.slots.slice(0, segs);
}

/** Metres a wall profile reaches either side of its path. */
function halfThickness(def: ArchitectureProfile | undefined): number {
  let h = 0;
  for (const q of def?.points ?? []) h = Math.max(h, Math.abs(q[0]));
  return h;
}

/** The top of a wall profile above its path (metres). */
function profileTop(def: ArchitectureProfile | undefined): number {
  let t = -Infinity;
  for (const q of def?.points ?? []) t = Math.max(t, q[1]);
  return t;
}

/** Whether an opening's span along the outline overlaps [a, b] (closed outline of length L). */
function openingIn(o: ArchitectureOpening, a: number, b: number, L: number): boolean {
  const at = L > 0 ? ((o.at % L) + L) % L : o.at;
  return at > a - EPS && at < b + EPS;
}

/** The stair's elements: one stepped sweep across its width (its sides capped), and its footprint for the floors it reaches. */
function stairElement(id: string, s: ArchitectureStair, material: string | null): { element: ArchitectureSweep; profile: ArchitectureProfile; foot: number[]; head: number[]; footprint: [number, number][] } | null {
  let foot = s.from;
  let head = s.to;
  if (head[1] < foot[1]) [foot, head] = [head, foot];
  const rx = head[0] - foot[0];
  const rz = head[2] - foot[2];
  const run = Math.sqrt(rx * rx + rz * rz);
  const rise = head[1] - foot[1];
  if (run < 0.01 || rise < 0.01) return null;
  const ux = rx / run;
  const uz = rz / run;
  const n = s.steps ?? Math.max(1, Math.round(rise / ARCHITECTURE_STAIR_RISER));
  const h = rise / n;
  const g = run / n;
  // The sweep's travel has the run on its right: right of (tx, tz) is (-tz, tx) = (ux, uz).
  const tx = uz;
  const tz = -ux;
  const w = s.width / 2;
  // The flight's side view, counter-clockwise in (along the run, up) so its faces look out: the back, then the
  // treads and risers down to the foot, then the bottom.
  const pts: [number, number][] = [[r6(run), 0], [r6(run), r6(rise)]];
  const slots: string[] = [ARCHITECTURE_STAIR_SLOTS.riser];
  for (let i = n - 1; i >= 0; i--) {
    pts.push([r6(i * g), r6((i + 1) * h)]);
    slots.push(ARCHITECTURE_STAIR_SLOTS.tread);
    pts.push([r6(i * g), r6(i * h)]);
    slots.push(ARCHITECTURE_STAIR_SLOTS.riser);
  }
  // The closing segment from the foot back to the start is the bottom, on the floor: left open.
  slots.push('');
  const profile: ArchitectureProfile = { points: pts, slots, closed: true, cap: ARCHITECTURE_STAIR_SLOTS.riser };
  const p0: [number, number, number] = [r6(foot[0] - tx * w), foot[1], r6(foot[2] - tz * w)];
  const p1: [number, number, number] = [r6(foot[0] + tx * w), foot[1], r6(foot[2] + tz * w)];
  const element: ArchitectureSweep = { id, kind: 'sweep', path: { points: [p0, p1] }, profile: '', stepped: true, ...(material !== null ? { material } : {}) };
  const corner = (along: number, across: number): [number, number] => [r6(foot[0] + ux * along + tx * across), r6(foot[2] + uz * along + tz * across)];
  return { element, profile, foot, head, footprint: [corner(0, -w), corner(run, -w), corner(run, w), corner(0, w)] };
}

/**
 * The component the generator makes: its own elements and profiles plus
 * each outline's, made by its preset's style (a swap replacing the preset,
 * a preview's values over one), rooms' walls shared and dressed per side,
 * storeys, floor holes and stairs; with `paint` (a block layer's wall paint
 * the rooms are drawn on) for the faces to read. `origin` is the object's
 * world position (masks read world noise and heights). A component without
 * outlines is itself.
 *
 * The outlines expand in groups that do not meet (`arch-groups.ts`), each
 * remembered by its own inputs: an edit expands again only the groups it
 * changed, and the rest keep the very element objects they made (the chunk
 * keys hash only new ones). What it makes does not depend on what was
 * remembered.
 */
export function expandArchitecture(c: ArchitectureComponent, origin: readonly number[], table: ArchitectureStyles, opts: { swaps?: Readonly<Record<string, string>> | null; preview?: ArchitecturePreview | null; paint?: ArchitecturePaint | null } = {}): ArchitectureExpansion {
  const buildings = c.buildings ?? [];
  const outlines: ArchitectureOutline[] = buildings.length === 0 ? (c.outlines ?? []) : [...(c.outlines ?? []), ...buildings];
  const paint = opts.paint ?? null;
  if (outlines.length === 0) {
    if (c.outlines === undefined && c.masks === undefined && c.buildings === undefined && c.interiorOf === undefined && paint === null) return { component: c, materials: NO_MATERIALS, problems: [], presets: NO_SET, rooms: [] };
    const { outlines: _o, masks: _m, buildings: _b, interiorOf: _i, ...rest } = c;
    return { component: paint !== null ? { ...rest, paint } : rest, materials: NO_MATERIALS, problems: [], presets: NO_SET, rooms: [] };
  }
  const own = c.outlines?.length ?? 0;
  const flags = outlines.map((_o, i) => buildings.length > 0 && i >= own);
  const groups = architectureOutlineGroups(outlines, flags);
  const memo = rememberedGroups<GroupExpansion>(table);
  const context = groupContextText(c, origin, opts.swaps);
  const preview = opts.preview ?? null;
  const previewText = preview !== null ? `\npreview ${JSON.stringify(preview)}` : '';
  const profiles: Record<string, ArchitectureProfile> = { ...(c.profiles ?? {}) };
  const elements: ArchitectureElement[] = [...c.elements];
  const materials: Record<string, string> = {};
  const problems: string[] = [];
  const presets = new Set<string>();
  const rooms: ArchitectureRoomPlan[] = [];
  const props: FurnishedProp[] = [];
  const lights: FurnishedLight[] = [];
  const planRooms: ArchitectureOutline[] = [];
  const append = <T>(to: T[], from: readonly T[]): void => {
    for (const v of from) to.push(v);
  };
  for (const g of groups) {
    let key = context;
    for (const i of g) key += `\n${flags[i] ? 'B' : 'O'}${JSON.stringify(outlines[i])}`;
    // A preview reaches a group only through the presets it resolves through.
    let x = memo.get(key);
    if (x !== undefined && preview !== null && x.presets.has(preview.preset)) x = memo.get(key + previewText);
    if (x === undefined) {
      const made = expandGroup(
        c,
        g.map((i) => outlines[i]!),
        g.map((i) => flags[i]!),
        origin,
        table,
        opts,
      );
      // Outlines that meet expand together: an edit to one makes the others' elements again, the same ones.
      x = g.length > 1 ? { ...made, elements: internElements(table, made.elements, elements.length + made.elements.length * groups.length) } : made;
      memo.set(preview !== null && x.presets.has(preview.preset) ? key + previewText : key, x, groups.length);
    }
    append(elements, x.elements);
    for (const name in x.profiles) profiles[name] ??= x.profiles[name]!;
    Object.assign(materials, x.materials);
    append(problems, x.problems);
    for (const p of x.presets) presets.add(p);
    append(rooms, x.rooms);
    append(props, x.props);
    append(lights, x.lights);
    append(planRooms, x.planRooms);
  }
  const { outlines: _o, masks: _m, buildings: _b, interiorOf: _i, ...rest } = c;
  return { component: { ...rest, elements, profiles, ...(paint !== null ? { paint } : {}) }, materials, problems: [...new Set(problems)], presets, rooms, ...(props.length > 0 ? { props } : {}), ...(lights.length > 0 ? { lights } : {}), ...(planRooms.length > 0 ? { planRooms } : {}) };
}

/** One group's share of an expansion, in its own order (remembered: never changed once made). */
interface GroupExpansion {
  elements: readonly ArchitectureElement[];
  /** The profiles it made (not the component's own). */
  profiles: Readonly<Record<string, ArchitectureProfile>>;
  materials: Readonly<Record<string, string>>;
  problems: readonly string[];
  presets: ReadonlySet<string>;
  rooms: readonly ArchitectureRoomPlan[];
  props: readonly FurnishedProp[];
  lights: readonly FurnishedLight[];
  planRooms: readonly ArchitectureOutline[];
}

/** A group of outlines (`flags`: which are buildings) expanded: the whole expansion's steps over only these. */
function expandGroup(c: ArchitectureComponent, outlines: readonly ArchitectureOutline[], flags: readonly boolean[], origin: readonly number[], table: ArchitectureStyles, opts: { swaps?: Readonly<Record<string, string>> | null; preview?: ArchitecturePreview | null }): GroupExpansion {
  const buildings = outlines.filter((_o, i) => flags[i]) as ArchitectureBuilding[];
  const ownBuildings = new Set<ArchitectureOutline>(buildings);
  const profiles: Record<string, ArchitectureProfile> = { ...(c.profiles ?? {}) };
  const materials: Record<string, string> = {};
  const problems: string[] = [];
  const presets = new Set<string>();
  const resolve = (o: ArchitectureOutline, presetId: string): { r: ResolvedArchitecturePreset; value: (name: string) => number } | null => {
    const id = opts.swaps?.[presetId] ?? presetId;
    const r = resolveArchitecturePreset(table, id, opts.preview);
    for (const p of r.chain) presets.add(p);
    if (r.problem !== null || r.style === null) {
      problems.push(`outline ${o.id}: ${r.problem ?? 'no style'}`);
      return null;
    }
    if (r.sheet !== null) materials[r.sheet] = r.sheet;
    return { r, value: valuesOf(r, o, c, origin) };
  };
  const evaluate = (st: { r: ResolvedArchitecturePreset; value: (name: string) => number }, outline: ArchitectureOutline): ArchitectureElement[] => {
    const out: ArchitectureElement[] = [];
    evaluateStyle(st.r.style!, st.value, outline, st.r.sheet, out, profiles, problems);
    return out;
  };

  // The outlines and their presets.
  const styled: Styled[] = [];
  const buildingStyled = new Map<string, Styled>();
  outlines.forEach((o, index) => {
    const own = resolve(o, o.preset);
    if (own === null) return;
    const room = o.path.closed === true && o.path.points.length >= 3;
    const outside = room && o.outside !== undefined ? resolve(o, o.outside) : null;
    const building = ownBuildings.has(o) ? (o as ArchitectureBuilding) : null;
    const part: BuildingPart = building === null ? 'whole' : c.interiorOf !== undefined ? 'interior' : building.interior !== undefined ? 'exterior' : 'whole';
    const st: Styled = { o, index, r: own.r, value: own.value, outside, building, part, parent: null };
    styled.push(st);
    if (building !== null) buildingStyled.set(building.id, st);
  });
  // A storey's rise: its height, else the walls' top on the ground storey.
  const rises = new Map<Styled, number>();
  const storeyRise = (s: Styled): number => {
    let h = rises.get(s);
    if (h === undefined) {
      h = s.o.storeyHeight ?? 0;
      if (h <= 0) h = wallTop(evaluate(s, { ...s.o, openings: [] }), s.o.path, profiles) ?? ARCHITECTURE_STOREY_HEIGHT_FALLBACK;
      rises.set(s, h);
    }
    return h;
  };
  // Rooms of buildings: those stored naming their building (a locked plan), else those its program splits the footprint into.
  const locked = new Set<string>();
  const planRooms: ArchitectureOutline[] = [];
  for (const s of styled) {
    const B = s.building === null && s.o.building !== undefined ? buildingStyled.get(s.o.building) : undefined;
    if (B === undefined) continue;
    s.parent = B;
    s.part = B.part;
    locked.add(B.o.id);
  }
  for (const B of [...buildingStyled.values()]) {
    const b = B.building!;
    if (b.program === undefined || locked.has(b.id)) continue;
    const program = table.programs.get(b.program);
    if (program === undefined) {
      problems.push(`building ${b.id}: room program "${b.program}" is not in the project`);
      continue;
    }
    const rise = (b.storeys ?? 1) > 1 ? storeyRise(B) : 0;
    const plan = buildingFloorPlan(b, program, rise);
    problems.push(...plan.problems);
    for (const o of floorPlanOutlines(b, plan, rise)) {
      planRooms.push(o);
      const own = resolve(o, o.preset);
      if (own !== null) styled.push({ o, index: styled.length, r: own.r, value: own.value, outside: null, building: null, part: B.part, parent: B });
    }
  }

  // Storeys: each room's outline raised by its storey height once per storey.
  const insts: Inst[] = [];
  const rooms: ArchitectureRoomPlan[] = [];
  for (const s of styled) {
    const room = s.o.path.closed === true && s.o.path.points.length >= 3;
    const storeys = room ? (s.o.storeys ?? 1) : 1;
    const height = storeys > 1 ? storeyRise(s) : 0;
    for (let k = 0; k < storeys; k++) {
      const path = raised(s.o.path, r6(k * height));
      const poly = room ? straightPolygon(path) : null;
      const openings = (s.o.openings ?? []).filter((o) => (o.storey ?? 0) === k).map(({ storey: _s, ...rest }) => rest);
      insts.push({ s, storey: k, id: k === 0 ? s.o.id : `${s.o.id}-s${k}`, path, base: path.points[0]![1], poly, dist: poly !== null ? cumulative(poly, true) : [], openings, extra: [], parentExtra: [], spans: [], elements: [], wall: null, half: 0 });
    }
  }
  const instsOf = new Map<Styled, Inst[]>();
  for (const X of insts) instsOf.set(X.s, [...(instsOf.get(X.s) ?? []), X]);
  // The storeys of buildings their rooms fill: there the building makes only its walls.
  const planned = new Set<Inst>();
  for (const X of insts) {
    if (X.s.parent === null) continue;
    const P = (instsOf.get(X.s.parent) ?? []).find((i) => Math.abs(i.base - X.base) < EPS);
    if (P !== undefined) planned.add(P);
  }

  // Shared walls: rooms running along one line at one height (the room listed first makes the wall).
  const roomsInsts = insts.filter((i) => i.poly !== null);
  // Each room's ground box: only rooms whose boxes touch can share a wall.
  const boxes = roomsInsts.map((i) => {
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of i.poly!) [x0, z0, x1, z1] = [Math.min(x0, q[0]), Math.min(z0, q[2]), Math.max(x1, q[0]), Math.max(z1, q[2])];
    return [x0 - EPS, z0 - EPS, x1 + EPS, z1 + EPS];
  });
  // The pairs whose boxes touch, found by a sweep along x (buildings split into rooms make hundreds), in list order.
  const byX = roomsInsts.map((_r, i) => i).sort((p, q) => boxes[p]![0]! - boxes[q]![0]! || p - q);
  const pairs: [number, number][] = [];
  for (let k = 0; k < byX.length; k++) {
    const i = byX[k]!;
    const bi = boxes[i]!;
    for (let m = k + 1; m < byX.length && boxes[byX[m]!]![0]! <= bi[2]!; m++) {
      const j = byX[m]!;
      const bj = boxes[j]!;
      if (bi[1]! > bj[3]! || bj[1]! > bi[3]!) continue;
      pairs.push(i < j ? [i, j] : [j, i]);
    }
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (const [x, y] of pairs) {
    const A = roomsInsts[x]!;
    const B = roomsInsts[y]!;
    if (A.s === B.s || Math.abs(A.base - B.base) > EPS) continue;
    for (const st of sharedStretches(A, B)) {
      // A building makes the walls on its footprint for the rooms inside it, wherever they are listed.
      const flip = st.same && A.s.parent === B.s;
      const [O, N, so, sn] = flip ? [B, A, st.b, st.a] : [A, B, st.a, st.b];
      const sa: Span = { a: so[0], b: so[1], other: N, owner: true, twin: null, same: st.same };
      const sb: Span = { a: sn[0], b: sn[1], other: O, owner: false, twin: sa, same: st.same };
      sa.twin = sb;
      O.spans.push(sa);
      N.spans.push(sb);
    }
  }
  // A door either room puts on a shared stretch is both rooms': cut into both rooms' trims, framed both sides.
  const both = (o: ArchitectureOpening): ArchitectureOpening => ({ ...o, frameSides: o.frameSides ?? 'both' });
  for (const X of roomsInsts) {
    const L = X.dist[X.dist.length - 1]!;
    X.openings = X.openings.map((o) => (X.spans.some((sp) => openingIn(o, sp.a, sp.b, L)) ? both(o) : o));
  }
  for (const X of roomsInsts) {
    const LX = X.dist[X.dist.length - 1]!;
    for (const sp of X.spans) {
      const Y = sp.other;
      const back = sp.twin;
      if (back === null) continue;
      const LY = Y.dist[Y.dist.length - 1]!;
      for (const o of Y.openings) {
        if (!openingIn(o, back.a, back.b, LY)) continue;
        const p = pointAlong(Y.poly!, Y.dist, true, o.at);
        // Along X: the stretch's start plus the distance from X's point there.
        const start = pointAlong(X.poly!, X.dist, true, sp.a);
        const at = r6(sp.a + Math.sqrt(sq(p[0] - start[0]) + sq(p[2] - start[2])));
        const dup = X.openings.some((q) => Math.abs(q.at - at) < (q.width + o.width) / 2 && q.bottom < o.top && o.bottom < q.top);
        if (dup || at > LX) continue;
        const made = both({ ...o, id: `${Y.s.o.id}-${o.id}`.slice(0, 64), at });
        X.extra.push(made);
        if (Y.s === X.s.parent) X.parentExtra.push(made);
      }
    }
  }

  // The rooms' and runs' elements.
  for (const X of insts) {
    const outline: ArchitectureOutline = { id: X.id, path: X.path, preset: X.s.o.preset, openings: [...X.openings, ...X.extra] };
    X.elements = evaluate(X.s, outline);
    // A room on a block layer: its ground floor laid just over the cells it stands on.
    if (c.layer !== undefined && X.storey === 0 && X.s.o.path.closed === true) {
      X.elements = X.elements.map((e) => (e.kind === 'fill' && e.shape === 'flat' && (e.face ?? 'up') === 'up' && e.path.points[0]![1] === X.base ? ({ ...e, height: r6((e.height ?? 0) + ARCHITECTURE_FLOOR_ON_CELLS) } as ArchitectureFill) : e));
    }
    X.wall = (X.poly !== null ? (X.elements.find((e) => e.kind === 'sweep' && e.wall === true && samePoints(e.path, X.path)) as ArchitectureSweep | undefined) : undefined) ?? null;
    X.half = X.wall !== null ? halfThickness(profiles[X.wall.profile]) : 0;
  }
  // Only rooms that both have a wall on the outline share one (a style without one keeps its own pieces).
  for (const X of insts) X.spans = X.spans.filter((sp) => X.wall !== null && sp.other.wall !== null);
  // The rooms' floor plans: regions of the layer they are drawn on, and what the rooms see each other through.
  const planOf = new Map<Inst, ArchitectureRoomPlan>();
  for (const X of insts) {
    if (X.s.o.path.closed !== true || X.s.o.path.points.length < 3) continue;
    const top = wallTop(X.elements, X.path, profiles) ?? (X.s.o.storeyHeight ?? ARCHITECTURE_STOREY_HEIGHT_FALLBACK);
    const ceil = r6(X.base + top);
    const type = X.s.o.roomType;
    const plan: ArchitectureRoomPlan = { id: X.id, outline: X.s.o.id, storey: X.storey, ...(type !== undefined ? { type } : {}), points: X.s.o.path.points.map((q) => [q[0], q[2]] as [number, number]), floor: X.base, top: ceil, openings: roomOpenings(X, ceil, [...X.openings, ...X.parentExtra]), covered: hasFill(X, (y, up) => !up || y > X.base + 0.5), holes: [] };
    // A building storey its rooms fill is no room of its own: they are.
    if (!planned.has(X)) rooms.push(plan);
    planOf.set(X, plan);
  }
  // A storey's floor covers the storey below it; a building's roof covers its top storey.
  for (const X of insts) {
    const plan = planOf.get(X);
    if (plan === undefined || plan.covered) continue;
    // A building's room: under the building's next storey, or its roof.
    const P = X.s.parent;
    if (P !== null) {
      const top = (instsOf.get(P) ?? []).reduce((m, i) => Math.max(m, i.base), -Infinity);
      plan.covered = X.base < top - EPS || (P.building?.roof !== undefined && P.part !== 'interior');
      continue;
    }
    if (X.s.building?.roof !== undefined && X.s.part !== 'interior' && X.storey === (X.s.o.storeys ?? 1) - 1) {
      plan.covered = true;
      continue;
    }
    const above = (instsOf.get(X.s) ?? []).find((i) => i.storey === X.storey + 1);
    if (above !== undefined && hasFill(above, (y, up) => up && Math.abs(y - above.base) < 0.5)) plan.covered = true;
  }

  // Stairs and holes: the floors (flat fills facing up) of each storey cut by the room's holes and the stairs reaching them.
  const stairs: ArchitectureElement[] = [];
  /** Stairs of buildings whose interiors are scenes of their own: made there, not in the exterior. */
  const exteriorOnly = new Set<ArchitectureElement>();
  const holesOf = new Map<Inst, ArchitecturePath[]>();
  /** The stairs made: whose they are, foot, head and footprint (rooms keep them free of props). */
  const flights: { s: Styled; foot: number[]; head: number[]; footprint: [number, number][] }[] = [];
  for (const s of styled) {
    const mine = (instsOf.get(s) ?? []).filter((i) => i.poly !== null);
    for (const h of s.o.holes ?? []) {
      const at = mine.find((i) => i.storey === (h.storey ?? 0));
      if (at !== undefined) holesOf.set(at, [...(holesOf.get(at) ?? []), { ...h.path, closed: true }]);
    }
    for (const st of s.o.stairs ?? []) {
      const made = stairElement(`${s.o.id}-stair-${st.id}`, st, s.r.sheet);
      if (made === null) {
        problems.push(`outline ${s.o.id}: stair ${st.id} neither rises nor runs`);
        continue;
      }
      const name = architectureProfileName(made.profile);
      profiles[name] ??= made.profile;
      const stair: ArchitectureElement = { ...made.element, profile: name };
      stairs.push(stair);
      flights.push({ s, foot: made.foot, head: made.head, footprint: made.footprint });
      if (s.part === 'exterior') exteriorOnly.add(stair);
      for (const i of mine) {
        const floor = i.base;
        if (i.storey === 0 || !(made.foot[1]! < floor - 0.01 && made.head[1]! >= floor - 0.05)) continue;
        holesOf.set(i, [...(holesOf.get(i) ?? []), { points: made.footprint.map((q) => [q[0], floor, q[1]] as [number, number, number]), closed: true }]);
      }
    }
  }
  for (const [i, holes] of holesOf) {
    i.elements = i.elements.map((e) => (e.kind === 'fill' && e.shape === 'flat' && (e.face ?? 'up') === 'up' ? ({ ...e, holes: [...(e.holes ?? []), ...holes] } as ArchitectureFill) : e));
    const plan = planOf.get(i);
    if (plan !== undefined) plan.holes = holes.map((h) => h.points.map((q) => [q[0], q[2]] as [number, number]));
  }

  // Buildings' furnishing: props and lights in their rooms, pinned props where they were pinned.
  const props: FurnishedProp[] = [];
  const lights: FurnishedLight[] = [];
  for (const B of buildingStyled.values()) {
    const b = B.building!;
    const pins = b.pins ?? [];
    if (B.part === 'exterior' || (b.furnishing === undefined && pins.length === 0)) continue;
    const set = b.furnishing !== undefined ? (table.furnishings.get(b.furnishing) ?? null) : null;
    if (b.furnishing !== undefined && set === null) problems.push(`building ${b.id}: furnishing set "${b.furnishing}" is not in the project`);
    const placedPins = new Set<string>();
    const furnished: FurnishRoom[] = [];
    const first = props.length;
    for (const X of insts) {
      const plan = planOf.get(X);
      if (X.s.parent !== B || X.poly === null || plan === undefined) continue;
      const room = furnishRoomOf(X, plan, holesOf.get(X) ?? [], flights, c.layer !== undefined && X.storey === 0 ? ARCHITECTURE_FLOOR_ON_CELLS : 0);
      const flat = X.poly.flatMap((q) => [q[0], q[2]]);
      const mine = pins.filter((p) => !placedPins.has(p.id) && p.position[1] > X.base - 0.5 && p.position[1] < plan.top && pointInPolygon(p.position[0], p.position[2], flat));
      for (const p of mine) placedPins.add(p.id);
      if (set !== null && X.s.o.roomType !== undefined) {
        furnished.push(room);
        props.push(...furnishRoom(room, set, b.layoutSeed ?? 0, mine));
      } else props.push(...mine.map((p) => pinnedProp(p, X.id)));
    }
    for (const p of pins) if (!placedPins.has(p.id)) props.push(pinnedProp(p, ''));
    for (let i = first; i < props.length; i++) props[i] = { ...props[i]!, building: b.id };
    if (set !== null) lights.push(...furnishLights(furnished, set));
  }

  // The outside presets' walls (their inner faces dress this room's outer faces) and trims along the open stretches.
  const outsideWall = new Map<Inst, ArchitectureProfile>();
  const exterior: ArchitectureElement[] = [];
  for (const X of insts) {
    const out = X.s.outside;
    if (out === null || X.s.o.path.closed !== true) continue;
    const reversed = reversedPath(X.path);
    const probe = evaluate(out, { id: `${X.id}-x`, path: reversed, preset: X.s.o.outside! });
    const w = probe.find((e) => e.kind === 'sweep' && e.wall === true) as ArchitectureSweep | undefined;
    if (w !== undefined && profiles[w.profile] !== undefined) outsideWall.set(X, profiles[w.profile]!);
    const runs = X.poly !== null ? openStretches(X) : [{ a: 0, b: samplePath(X.path).length, trimA: 0, trimB: 0 }];
    runs.forEach((run, k) => {
      const whole = X.poly === null || X.spans.length === 0;
      const path = whole ? reversed : reversedPath(subPath(X, run.a, run.b, 0, 0));
      const len = run.b - run.a;
      const L = whole ? len : X.dist[X.dist.length - 1]!;
      const openings = X.openings
        .filter((o) => whole || openingIn(o, run.a, run.b, L) || openingIn(o, run.a + L, run.b + L, 2 * L))
        .map((o) => ({ ...o, at: r6(whole ? (len - o.at + len) % len : len - unwrap(o.at - run.a, L)) }));
      const els = evaluate(out, { id: `${X.id}-x${k}`, path, preset: X.s.o.outside!, openings });
      // A building's interior made in its own scene wears no facade trims.
      if (X.s.part !== 'interior') for (const e of els) if (e.kind !== 'fill' && !(e.kind === 'sweep' && e.wall === true)) exterior.push(e);
    });
  }

  // The walls: one per shared stretch (the owner's, its face toward the other room in that room's rows), the rest in runs.
  const elements: ArchitectureElement[] = [];
  for (const X of insts) {
    const W = X.wall;
    if (W === null) {
      elements.push(...(planned.has(X) ? X.elements.filter((e) => e.kind === 'sweep' && e.wall === true) : X.elements));
      continue;
    }
    const def = profiles[W.profile];
    const outer = outsideWall.get(X);
    let baseDef = def;
    if (def !== undefined && outer !== undefined) {
      const slots = slotsFacing(def, outer);
      if (slots !== null) baseDef = { ...def, slots };
    }
    const walls = def === undefined ? [W] : wallPieces(X, W, baseDef!, profiles);
    for (const e of X.elements) {
      if (e === W) elements.push(...walls);
      // A storey its rooms fill: the rooms make the floors, ceilings and trims.
      else if (planned.has(X)) continue;
      // A building's exterior keeps the inside's walls and its floors and ceilings (rooms behind the windows), not its trims.
      else if (X.s.part !== 'exterior' || e.kind === 'fill' || (e.kind === 'sweep' && e.wall === true)) elements.push(e);
    }
  }
  elements.push(...stairs.filter((e) => !exteriorOnly.has(e)), ...exterior, ...roofs(styled, insts, planOf), ...props.map(propElement));
  const made: Record<string, ArchitectureProfile> = {};
  for (const name in profiles) if (profiles[name] !== c.profiles?.[name]) made[name] = profiles[name]!;
  return { elements, profiles: made, materials, problems, presets, rooms, props, lights, planRooms };
}

/** A pinned prop as placed (standing in `room`, "" for none). */
function pinnedProp(p: NonNullable<ArchitectureBuilding['pins']>[number], room: string): FurnishedProp {
  return { id: p.id, room, model: p.model, position: p.position, facing: p.facing, size: p.size ?? [0.5, 0.5], pinned: true };
}

/** A building's room storey as the furnishing reads it: its walls' inner faces, doors and windows, stairs and holes. */
function furnishRoomOf(X: Inst, plan: ArchitectureRoomPlan, holes: readonly ArchitecturePath[], flights: readonly { s: Styled; foot: number[]; head: number[]; footprint: [number, number][] }[], raise: number): FurnishRoom {
  const poly = X.poly!;
  const openings: FurnishOpening[] = [...X.openings, ...X.extra].map((o) => {
    const p = pointAlong(poly, X.dist, true, o.at);
    return { at: [p[0], p[2]], width: o.width, sill: o.bottom, door: o.bottom <= ARCHITECTURE_DOOR_SILL_MAX };
  });
  const obstacles: [number, number][][] = holes.map((h) => h.points.map((q) => [q[0], q[2]] as [number, number]));
  const anchors: [number, number][] = [];
  for (const f of flights) {
    if (f.s !== X.s) continue;
    const dx = f.head[0]! - f.foot[0]!;
    const dz = f.head[2]! - f.foot[2]!;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    // The way onto a flight starting here, and off one arriving here (its landing).
    if (Math.abs(f.foot[1]! - X.base) < 0.05) {
      obstacles.push(f.footprint);
      anchors.push([f.foot[0]! - (dx / l) * 0.5, f.foot[2]! - (dz / l) * 0.5]);
    } else if (Math.abs(f.head[1]! - X.base) < 0.05) anchors.push([f.head[0]! + (dx / l) * 0.5, f.head[2]! + (dz / l) * 0.5]);
  }
  return { id: X.id, type: X.s.o.roomType ?? '', points: poly.map((q) => [q[0], q[2]] as [number, number]), half: X.half, floor: r6(X.base + raise), top: plan.top, openings, obstacles, anchors };
}

/**
 * The buildings' roofs: each a fill over its footprint at the top of its
 * top storey's walls, wearing the facade's trim sheet (the inside's when it
 * has none). Not in an interior made in its own scene.
 */
function roofs(styled: readonly Styled[], insts: readonly Inst[], planOf: ReadonlyMap<Inst, ArchitectureRoomPlan>): ArchitectureFill[] {
  const out: ArchitectureFill[] = [];
  for (const s of styled) {
    const b = s.building;
    const roof = b?.roof;
    if (b === null || roof === undefined || s.part === 'interior' || b.path.closed !== true) continue;
    const top = insts.find((i) => i.s === s && i.storey === (b.storeys ?? 1) - 1);
    const plan = top !== undefined ? planOf.get(top) : undefined;
    if (plan === undefined) continue;
    const sheet = s.outside?.r.sheet ?? s.r.sheet;
    const flat = roof.shape === 'flat';
    out.push({
      id: `${b.id}-roof`,
      kind: 'fill',
      path: { ...b.path, points: b.path.points.map((q) => [q[0], plan.top, q[2]] as [number, number, number]) },
      shape: roof.shape,
      slot: roof.slot ?? ARCHITECTURE_ROOF_SLOT_DEFAULT,
      ...(roof.trimSlot !== undefined ? { trimSlot: roof.trimSlot } : {}),
      ...(flat ? { face: 'up' as const } : { overhang: roof.overhang ?? ARCHITECTURE_ROOF_OVERHANG_DEFAULT }),
      ...(roof.rise !== undefined ? { rise: roof.rise } : {}),
      ...(roof.axis !== undefined ? { axis: roof.axis } : {}),
      ...(roof.breakRise !== undefined ? { breakRise: roof.breakRise } : {}),
      ...(roof.inset !== undefined ? { inset: roof.inset } : {}),
      ...(sheet !== null ? { material: sheet } : {}),
    });
  }
  return out;
}

/** The top of a room's walls above its outline (metres; null: its style made no wall). */
function wallTop(elements: readonly ArchitectureElement[], outline: ArchitecturePath, profiles: Readonly<Record<string, ArchitectureProfile>>): number | null {
  let top = -Infinity;
  const y0 = outline.points[0]![1];
  for (const e of elements) if (e.kind === 'sweep' && e.wall === true) top = Math.max(top, profileTop(profiles[e.profile]) + e.path.points[0]![1] - y0);
  return top === -Infinity ? null : top;
}

/**
 * The holes a room's own openings make in its walls: each opening's stretch
 * of the outline (its ends on the ground) and its sill and head, kept
 * between the room's floor and the top of its walls.
 */
function roomOpenings(X: Inst, top: number, list: readonly ArchitectureOpening[]): ArchitectureRoomOpening[] {
  if (list.length === 0) return [];
  const s = samplePath(X.path);
  const p: number[] = [0, 0, 0];
  const t: number[] = [0, 0, 0];
  const out: ArchitectureRoomOpening[] = [];
  for (const o of list) {
    const bottom = Math.max(X.base, X.base + o.bottom);
    const head = Math.min(top, X.base + o.top);
    if (head <= bottom || o.width <= 0) continue;
    pathPointAt(s, o.at - o.width / 2, p, t);
    const from: [number, number] = [r6(p[0]!), r6(p[2]!)];
    pathPointAt(s, o.at + o.width / 2, p, t);
    out.push({ id: o.id, from, to: [r6(p[0]!), r6(p[2]!)], bottom: r6(bottom), top: r6(head) });
  }
  return out;
}

/** Whether a room's (or storey's) elements hold a fill `test` accepts (its height above the object, facing up). */
function hasFill(X: Inst, test: (y: number, up: boolean) => boolean): boolean {
  for (const e of X.elements) {
    if (e.kind !== 'fill') continue;
    let y = 0;
    for (const q of e.path.points) y += q[1];
    y = y / Math.max(1, e.path.points.length) + (e.height ?? 0);
    const up = (e.shape === 'flat' && (e.face ?? 'up') === 'up') || (e.shape === 'coffered' && e.face === 'up');
    if (test(y, up)) return true;
  }
  return false;
}

/** Whether an element's path is the outline itself (the same points, no offset). */
function samePoints(a: ArchitecturePath, b: ArchitecturePath): boolean {
  if ((a.offset ?? 0) !== 0 || (a.chamfer ?? 0) !== 0 || a.curve === true || a.points.length !== b.points.length || (a.closed === true) !== (b.closed === true)) return false;
  return a.points.every((q, i) => q[0] === b.points[i]![0] && q[1] === b.points[i]![1] && q[2] === b.points[i]![2]);
}

/** A distance taken into [0, L). */
function unwrap(d: number, L: number): number {
  return L > 0 ? ((d % L) + L) % L : d;
}

/** A closed outline's stretches no other room shares, and the trims at their ends (the half thickness of the wall that stops them). */
function openStretches(X: Inst): { a: number; b: number; trimA: number; trimB: number }[] {
  const L = X.dist[X.dist.length - 1]!;
  const spans = [...X.spans].sort((p, q) => p.a - q.a);
  if (spans.length === 0) return [{ a: 0, b: L, trimA: 0, trimB: 0 }];
  // Merge overlapping spans (the thickest wall stopping each end).
  const merged: { a: number; b: number; ta: number; tb: number }[] = [];
  for (const sp of spans) {
    const half = halfOf(sp);
    const last = merged[merged.length - 1];
    if (last !== undefined && sp.a <= last.b + EPS) {
      if (sp.b > last.b) {
        last.b = sp.b;
        last.tb = half;
      }
    } else merged.push({ a: sp.a, b: sp.b, ta: half, tb: half });
  }
  const out: { a: number; b: number; trimA: number; trimB: number }[] = [];
  for (let k = 0; k < merged.length; k++) {
    const cur = merged[k]!;
    const next = merged[(k + 1) % merged.length]!;
    const a = cur.b;
    const b = k + 1 < merged.length ? next.a : next.a + L;
    if (b - a > EPS * 10) out.push({ a, b, trimA: cur.tb, trimB: next.ta });
  }
  return out;
}

/** The half thickness of the wall making a span: the other room's where it makes it, else none to stop at. */
function halfOf(sp: Span): number {
  return sp.owner ? 0 : sp.other.half;
}

/** The outline from `a` to `b` (distances; `b` may pass the end of a closed outline), its ends moved in by the trims. */
function subPath(X: Inst, a: number, b: number, trimA: number, trimB: number): ArchitecturePath {
  const poly = X.poly!;
  const dist = X.dist;
  const L = dist[dist.length - 1]!;
  const a2 = a + Math.min(trimA, (b - a) / 3);
  const b2 = b - Math.min(trimB, (b - a) / 3);
  const pts: [number, number, number][] = [pointAlong(poly, dist, true, a2)];
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < poly.length; i++) {
      const d = dist[i]! + lap * L;
      if (d > a2 + EPS && d < b2 - EPS) pts.push([poly[i]![0], poly[i]![1], poly[i]![2]]);
    }
  }
  pts.push(pointAlong(poly, dist, true, b2));
  return { points: pts };
}

/**
 * A room's wall cut where other rooms make it: open runs over what is left
 * (ends stopping at the owner's face), each with this room's openings along
 * it; and along stretches it makes for another room, its outer faces in
 * that room's inner rows (`segmentSlots`, corners added where a stretch
 * starts or ends mid-side).
 */
function wallPieces(X: Inst, W: ArchitectureSweep, def: ArchitectureProfile, profiles: Record<string, ArchitectureProfile>): ArchitectureSweep[] {
  const name = architectureProfileName(def);
  profiles[name] ??= def;
  const L = X.dist[X.dist.length - 1]!;
  const skipped = X.spans.filter((sp) => !sp.owner);
  const owned = X.spans.filter((sp) => sp.owner);
  // The rows facing each room this wall is made for.
  const facing = owned.map((sp) => {
    const otherDef = sp.other.wall !== null ? profiles[sp.other.wall.profile] : undefined;
    const slots = otherDef !== undefined ? slotsFacing(def, otherDef, sp.same ? 1 : -1) : null;
    // Rows the wall wears anyway need no list of their own.
    return { sp, slots: slots !== null && slots.some((x, i) => x !== def.slots[i]) ? slots : null };
  });
  const segSlots = (pts: readonly (readonly number[])[], start: number, closed: boolean): Record<string, string[]> | undefined => {
    const out: Record<string, string[]> = {};
    const segs = closed ? pts.length : pts.length - 1;
    let d = start;
    for (let k = 0; k < segs; k++) {
      const p = pts[k]!;
      const q = pts[(k + 1) % pts.length]!;
      const len = Math.sqrt(sq(q[0]! - p[0]!) + sq(q[2]! - p[2]!));
      const mid = unwrap(d + len / 2, L);
      d += len;
      const f = facing.find((x) => mid > x.sp.a && mid < x.sp.b);
      if (f?.slots !== null && f !== undefined) out[String(k)] = f.slots;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  // Corners where an owned stretch starts or ends, so its segments are whole.
  const cuts = owned.flatMap((sp) => [sp.a, sp.b]);
  if (skipped.length === 0) {
    const pts = withCorners(X, cuts);
    const slots = segSlots(pts, 0, true);
    return [{ ...W, profile: name, path: { ...W.path, points: pts }, ...(slots !== undefined ? { segmentSlots: slots } : {}) }];
  }
  const runs = openStretches({ ...X, spans: skipped });
  const openings = W.openings ?? [];
  return runs.map((run, k) => {
    const path = subPath(X, run.a, run.b, run.trimA, run.trimB);
    const trimA = Math.min(run.trimA, (run.b - run.a) / 3);
    const start = run.a + trimA;
    const pts = withCornersOn(path.points, X, start, cuts);
    const len = run.b - run.a - trimA - Math.min(run.trimB, (run.b - run.a) / 3);
    const own = openings
      .map((o) => ({ ...o, at: r6(unwrap(o.at - start, L)) }))
      .filter((o) => o.at > o.width / 2 - EPS && o.at < len - o.width / 2 + EPS);
    const slots = segSlots(pts, start, false);
    const { openings: _o, segmentSlots: _s, ...base } = W;
    return { ...base, id: `${W.id}-r${k}`, profile: name, path: { points: pts }, ...(own.length > 0 ? { openings: own } : {}), ...(slots !== undefined ? { segmentSlots: slots } : {}) };
  });
}

/** A closed outline's corners with points added at the given distances (where none stands). */
function withCorners(X: Inst, cuts: readonly number[]): [number, number, number][] {
  const poly = X.poly!;
  const out: [number, number, number][] = [];
  const L = X.dist[X.dist.length - 1]!;
  for (let i = 0; i < poly.length; i++) {
    out.push([poly[i]![0], poly[i]![1], poly[i]![2]]);
    const d0 = X.dist[i]!;
    const d1 = X.dist[i + 1]!;
    for (const c of [...cuts].map((x) => unwrap(x, L)).sort((p, q) => p - q)) if (c > d0 + EPS && c < d1 - EPS) out.push(pointAlong(poly, X.dist, true, c));
  }
  return out;
}

/** An open run's points with points added at the given outline distances (the run starts at `start` along the outline). */
function withCornersOn(points: readonly [number, number, number][], X: Inst, start: number, cuts: readonly number[]): [number, number, number][] {
  const L = X.dist[X.dist.length - 1]!;
  const out: [number, number, number][] = [points[0]!];
  let d = start;
  for (let k = 0; k + 1 < points.length; k++) {
    const p = points[k]!;
    const q = points[k + 1]!;
    const len = Math.sqrt(sq(q[0] - p[0]) + sq(q[2] - p[2]));
    const inside = cuts
      .map((c) => {
        let x = unwrap(c - d, L);
        if (x > len) x = -1;
        return x;
      })
      .filter((x) => x > EPS && x < len - EPS)
      .sort((u, v) => u - v);
    for (const x of inside) out.push([r6(p[0] + ((q[0] - p[0]) * x) / len), p[1], r6(p[2] + ((q[2] - p[2]) * x) / len)]);
    out.push(q);
    d += len;
  }
  return out;
}
