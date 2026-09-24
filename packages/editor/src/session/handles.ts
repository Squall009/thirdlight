/**
 * Phase 15.2: Scene-view handles driven by the component descriptors — the
 * pure part (no DOM, no three.js).
 *
 * Every component of the selected object whose descriptor lists a handle
 * (`box2`, `box3`, `radius`, `capsule`, `segment1d`, `cone`, `direction`,
 * `path`, `polygon`, `point`) and whose `when` holds becomes one
 * `HandleShape`: the bound fields read into a small geometric model, in the
 * handle's frame (world, or the object's position / rotation about Z /
 * rotation / whole transform — `follows`). The Scene view draws the model,
 * turns pointer positions into frame points, and asks this module where the
 * grips sit, what a drag makes of the model (snapped, inside the fields'
 * ranges) and which `setComponent` value stores it — one command on release,
 * one undo step. Generalises the phase 14.0 size handles and the 9.12 mover
 * waypoint handles.
 *
 * Snapping (the snap toggle; Shift turns it off for one drag): sizes, radii,
 * ranges and polygon corners land on 5 cm (`SNAP_SIZE_M`), path points and
 * world-space bounds on the translate grid (`SNAP_TRANSLATE_M`), a spot
 * cone's half-angle on 5° steps, a direction's components on 0.05.
 */
import type { DescriptorJson, DescriptorRegistry, FieldCondition, FieldDescriptor, HandleDescriptor, HandleKind, ObjectFieldDescriptor } from '@thirdlight/project-model';

import { applies, deepEqual, fieldAt, setAt, type FieldPath, type Level } from './descriptor-fields';
import type { ProjectedEntity } from './projection';
import { SNAP_TRANSLATE_M } from './snapping';

/** The size snapping step (m): fine enough for a character's or a trigger's size in any genre, still round numbers. */
export const SNAP_SIZE_M = 0.05;
/** A spot cone's half-angle snapping step (degrees). */
export const SNAP_ANGLE_DEG = 5;
/** A direction's component snapping step (the field's step). */
export const SNAP_DIRECTION = 0.05;
/** The drawn length of a direction handle and of a cone without a range (m). */
export const DIRECTION_LENGTH_M = 2;
export const CONE_DISPLAY_M = 3;
/** Where a zero radius's grip sits (m) — off the object's own gizmo. */
const MIN_GRIP_RADIUS_M = 0.25;
/** The smallest gap a drag keeps between two edges of a range or bounds (m). */
const MIN_GAP_M = 0.05;

export type Frame = 'world' | 'position' | 'rotationZ' | 'rotation' | 'transform';

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/** A draggable point: a size edge, a path/polygon corner or an "insert here" point on an edge. */
export interface Grip {
  id: string;
  at: P3;
  /** How the pointer moves it: on the frame's X/Y plane through it, along an axis through it, or on a camera-facing plane. */
  drag: 'plane' | 'axis' | 'free';
  axis?: P3;
  role: 'size' | 'vertex' | 'insert';
}

type Range = { min: number; max: number };

export type HandleModel =
  | { type: 'box'; dims: 2 | 3; roles: 'size' | 'half'; center: P3; half: P3; anchor: 'center' | 'bottom' }
  | { type: 'bounds'; minX: number; maxX: number; minY: number; maxY: number }
  | { type: 'capsule'; cx: number; cy: number; radius: number; halfHeight: number }
  | { type: 'radius'; r: number; along: 'xy' | 'x'; band: number | null }
  | { type: 'segment'; left: number; right: number }
  | { type: 'cone'; dir: P3; angle: number; range: number }
  | { type: 'direction'; dir: P3 }
  | { type: 'points'; pts: P3[]; dims: 2 | 3; closed: boolean; start: boolean; minItems: number; maxItems: number }
  | { type: 'point'; p: P3; dims: 2 | 3 };

export interface HandleShape {
  entityId: string;
  component: string;
  /** The handle's index in the component descriptor's `handles`. */
  handleIndex: number;
  kind: HandleKind;
  label: string;
  frame: Frame;
  model: HandleModel;
  /** Field ranges by role (`x`/`y`/`z` for per-axis limits of vectors). */
  limits: Record<string, Range>;
  /** Why the previewed model cannot be stored (drawn red, not committed). */
  error?: string;
  /** The component value as stored when the shape was read (the commit diffs against it). */
  value: Record<string, unknown>;
  bind: Readonly<Record<string, string>>;
  root: ObjectFieldDescriptor;
}

// ---- small helpers ------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const N = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};
const clamp = (v: number, r: Range | undefined): number => (r === undefined ? v : Math.min(r.max, Math.max(r.min, v)));
const snapTo = (v: number, step: number, on: boolean): number => (on ? Math.round(v / step) * step : v);
const p3 = (x: number, y: number, z = 0): P3 => ({ x, y, z });
const len = (v: P3): number => Math.hypot(v.x, v.y, v.z);
const unit = (v: P3): P3 => {
  const l = len(v);
  return l < 1e-9 ? p3(0, -1, 0) : p3(v.x / l, v.y / l, v.z / l);
};
const cross = (a: P3, b: P3): P3 => p3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const dot = (a: P3, b: P3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const ptrPath = (ptr: string): FieldPath => ptr.split('/');

/** A vector perpendicular to `d` (the same choice the Scene view's spot-light cone uses). */
export function perpendicular(d: P3): P3 {
  const side = Math.abs(d.y) > 0.9 ? p3(1, 0, 0) : p3(0, 1, 0);
  return unit(cross(d, side));
}

/** The effective value at a pointer (stored, else the applicable variant's default) and its descriptor. */
function effective(root: ObjectFieldDescriptor, value: Obj, ptr: string): { v: unknown; f: FieldDescriptor | null } {
  const path = ptrPath(ptr);
  let level: Level | undefined;
  let desc: FieldDescriptor = root;
  let v: unknown = value;
  for (const seg of path) {
    if (desc.type !== 'object') return { v: undefined, f: null };
    const here: Level = { desc, value: isObj(v) ? v : {}, ...(level !== undefined ? { parent: level } : {}) };
    const variants: readonly FieldDescriptor[] = desc.fields.filter((x) => x.key === seg);
    const next: FieldDescriptor | undefined = variants.find((x) => applies(x, here)) ?? variants[0];
    if (next === undefined) return { v: undefined, f: null };
    const stored = isObj(v) ? v[seg] : undefined;
    level = here;
    desc = next;
    v = stored !== undefined ? stored : next.default !== undefined ? clone(next.default) : next.type === 'object' ? {} : undefined;
  }
  return { v, f: desc };
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function conditionsHold(root: ObjectFieldDescriptor, value: Obj, when: FieldCondition | readonly FieldCondition[] | undefined): boolean {
  if (when === undefined) return true;
  const list = Array.isArray(when) ? (when as readonly FieldCondition[]) : [when as FieldCondition];
  return list.every((c) => c.in.some((x) => x === effective(root, value, c.key).v));
}

function rangeOf(f: FieldDescriptor | null): Range | undefined {
  if (f === null) return undefined;
  const t = f.type === 'list' ? f.item : f;
  if (t.type !== 'number' && t.type !== 'int' && t.type !== 'vec2' && t.type !== 'vec3') return undefined;
  const min = t.min ?? -Infinity;
  const max = t.max ?? Infinity;
  // An exclusive minimum of 0 (a size): the smallest step above it.
  const lo = (t as { minExclusive?: boolean }).minExclusive === true ? min + 0.001 : min;
  return { min: lo, max };
}

const frameOf = (h: HandleDescriptor): Frame => (h.space === 'world' ? 'world' : (h.follows ?? 'position'));

// ---- reading shapes -----------------------------------------------------------

/** The handle shapes of one object (its components in registry order, each handle whose `when` holds). */
export function handleShapesOf(e: ProjectedEntity, reg: DescriptorRegistry | null): HandleShape[] {
  if (reg === null) return [];
  const out: HandleShape[] = [];
  for (const c of reg.components) {
    if (c.handles.length === 0 || c.value.type !== 'object') continue;
    const raw = e.components[c.name];
    if (raw === undefined || !isObj(raw)) continue;
    const root = c.value;
    c.handles.forEach((h, handleIndex) => {
      if (!conditionsHold(root, raw, h.when)) return;
      const shape = readShape(e.id, c.name, handleIndex, h, root, raw);
      if (shape !== null) out.push(shape);
    });
  }
  return out;
}

function readShape(entityId: string, component: string, handleIndex: number, h: HandleDescriptor, root: ObjectFieldDescriptor, value: Obj): HandleShape | null {
  const at = (role: string): { v: unknown; f: FieldDescriptor | null } => effective(root, value, h.bind[role] ?? '');
  const limits: Record<string, Range> = {};
  const lim = (role: string, f: FieldDescriptor | null): void => {
    const r = rangeOf(f);
    if (r !== undefined) limits[role] = r;
  };
  const base = { entityId, component, handleIndex, kind: h.kind, label: h.label, frame: frameOf(h), limits, value, bind: h.bind, root };
  const vec = (v: unknown, n: number): number[] | null => (Array.isArray(v) && v.length >= n && v.slice(0, n).every((x) => typeof x === 'number') ? (v as number[]) : null);
  switch (h.kind) {
    case 'box2':
    case 'box3': {
      if (h.bind['size'] !== undefined) {
        const s = at('size');
        const dims = h.kind === 'box3' ? 3 : 2;
        const v = vec(s.v, dims);
        if (v === null) return null;
        lim('size', s.f);
        const half = p3(v[0]! / 2, v[1]! / 2, dims === 3 ? v[2]! / 2 : 0);
        const anchor = h.anchor === 'bottom' ? 'bottom' : 'center';
        return { ...base, model: { type: 'box', dims, roles: 'size', center: p3(0, anchor === 'bottom' ? half.y : 0, 0), half, anchor } };
      }
      if (h.bind['halfX'] !== undefined) {
        const hx = at('halfX');
        const hy = at('halfY');
        if (typeof hx.v !== 'number' || typeof hy.v !== 'number') return null;
        lim('halfX', hx.f);
        lim('halfY', hy.f);
        return { ...base, model: { type: 'box', dims: 2, roles: 'half', center: p3(0, 0, 0), half: p3(hx.v, hy.v, 0), anchor: 'center' } };
      }
      // World bounds: only while they are set (absent means "anywhere").
      const parent = (h.bind['minX'] ?? '').split('/').slice(0, -1).join('/');
      if (parent !== '' && value[parent] === undefined) return null;
      const b = ['minX', 'maxX', 'minY', 'maxY'].map((r) => at(r));
      if (!b.every((x) => typeof x.v === 'number')) return null;
      lim('minX', b[0]!.f);
      return { ...base, model: { type: 'bounds', minX: b[0]!.v as number, maxX: b[1]!.v as number, minY: b[2]!.v as number, maxY: b[3]!.v as number } };
    }
    case 'capsule': {
      const r = at('radius');
      const ht = at('height');
      const o = at('offset');
      const off = vec(o.v, 2) ?? [0, 0];
      lim('radius', r.f);
      lim('height', ht.f);
      lim('offset', o.f);
      return { ...base, model: { type: 'capsule', cx: off[0]!, cy: off[1]!, radius: N(r.v, 0.3), halfHeight: N(ht.v, 1.8) / 2 } };
    }
    case 'radius': {
      const r = at('radius');
      lim('radius', r.f);
      const band = h.band !== undefined ? N(effective(root, value, h.band).v, 0) : null;
      return { ...base, model: { type: 'radius', r: N(r.v), along: h.along === 'x' ? 'x' : 'xy', band } };
    }
    case 'segment1d': {
      const r = at('range');
      const v = vec(r.v, 2);
      if (v === null) return null;
      lim('range', r.f);
      return { ...base, model: { type: 'segment', left: v[0]!, right: v[1]! } };
    }
    case 'cone': {
      const d = vec(at('direction').v, 3) ?? [0, -1, 0];
      const a = at('angle');
      const rg = at('range');
      lim('angle', a.f);
      lim('range', rg.f);
      return { ...base, model: { type: 'cone', dir: unit(p3(d[0]!, d[1]!, d[2]!)), angle: N(a.v, 30), range: N(rg.v) } };
    }
    case 'direction': {
      const d = vec(at('direction').v, 3) ?? [0, -1, 0];
      return { ...base, model: { type: 'direction', dir: unit(p3(d[0]!, d[1]!, d[2]!)) } };
    }
    case 'path':
    case 'polygon': {
      const role = h.kind === 'path' ? 'points' : 'vertices';
      const l = at(role);
      if (!Array.isArray(l.v)) return null;
      const f = l.f;
      const item = f?.type === 'list' ? f.item : null;
      const dims = item?.type === 'vec3' ? 3 : 2;
      lim(role, f);
      const pts = (l.v as unknown[]).map((q) => (Array.isArray(q) ? p3(N(q[0]), N(q[1]), dims === 3 ? N(q[2]) : 0) : p3(0, 0, 0)));
      const minItems = f?.type === 'list' ? (f.minItems ?? 0) : 0;
      const maxItems = f?.type === 'list' ? (f.maxItems ?? 64) : 64;
      const closed = h.kind === 'polygon' || (h.loop !== undefined && conditionsHold(root, value, h.loop));
      return { ...base, model: { type: 'points', pts, dims, closed, start: h.kind === 'path', minItems, maxItems } };
    }
    case 'point': {
      const pt = at('point');
      const v = vec(pt.v, 2);
      if (v === null) return null;
      lim('point', pt.f);
      const dims = Array.isArray(pt.v) && pt.v.length === 3 ? 3 : 2;
      return { ...base, model: { type: 'point', p: p3(v[0]!, v[1]!, dims === 3 ? N(v[2]) : 0), dims } };
    }
  }
}

// ---- grips --------------------------------------------------------------------

/** Where a points model's segment k (inserting at index k) starts and ends. */
function segmentEnds(m: Extract<HandleModel, { type: 'points' }>, k: number): [P3, P3] | null {
  const n = m.pts.length;
  if (m.start) {
    const origin = p3(0, 0, 0);
    if (k < n) return [k === 0 ? origin : m.pts[k - 1]!, m.pts[k]!];
    return m.closed && n > 0 ? [m.pts[n - 1]!, origin] : null;
  }
  if (k < 1 || k > n) return null;
  return [m.pts[k - 1]!, m.pts[k % n]!];
}

/** The grips of a shape (frame coordinates). */
export function gripsOf(s: HandleShape): Grip[] {
  const m = s.model;
  switch (m.type) {
    case 'box': {
      const g: Grip[] = [
        { id: 'top', at: p3(m.center.x, m.center.y + m.half.y, m.center.z), drag: 'plane', role: 'size' },
        { id: 'side', at: p3(m.center.x + m.half.x, m.center.y, m.center.z), drag: 'plane', role: 'size' },
      ];
      if (m.dims === 3) g.push({ id: 'depth', at: p3(m.center.x, m.center.y, m.center.z + m.half.z), drag: 'axis', axis: p3(0, 0, 1), role: 'size' });
      return g;
    }
    case 'bounds': {
      const mx = (m.minX + m.maxX) / 2;
      const my = (m.minY + m.maxY) / 2;
      return [
        { id: 'left', at: p3(m.minX, my), drag: 'plane', role: 'size' },
        { id: 'right', at: p3(m.maxX, my), drag: 'plane', role: 'size' },
        { id: 'bottom', at: p3(mx, m.minY), drag: 'plane', role: 'size' },
        { id: 'top', at: p3(mx, m.maxY), drag: 'plane', role: 'size' },
      ];
    }
    case 'capsule':
      return [
        { id: 'top', at: p3(m.cx, m.cy + m.halfHeight), drag: 'plane', role: 'size' },
        { id: 'side', at: p3(m.cx + m.radius, m.cy), drag: 'plane', role: 'size' },
      ];
    case 'radius':
      return [{ id: 'side', at: p3(Math.max(m.r, MIN_GRIP_RADIUS_M), 0), drag: 'plane', role: 'size' }];
    case 'segment':
      return [
        { id: 'left', at: p3(m.left, 0), drag: 'plane', role: 'size' },
        { id: 'right', at: p3(m.right, 0), drag: 'plane', role: 'size' },
      ];
    case 'cone': {
      const L = m.range > 0 ? m.range : CONE_DISPLAY_M;
      const tip = p3(m.dir.x * L, m.dir.y * L, m.dir.z * L);
      const u = perpendicular(m.dir);
      const r = Math.tan((m.angle * Math.PI) / 180) * L;
      return [
        { id: 'tip', at: tip, drag: 'free', role: 'size' },
        { id: 'angle', at: p3(tip.x + u.x * r, tip.y + u.y * r, tip.z + u.z * r), drag: 'free', role: 'size' },
      ];
    }
    case 'direction':
      return [{ id: 'tip', at: p3(m.dir.x * DIRECTION_LENGTH_M, m.dir.y * DIRECTION_LENGTH_M, m.dir.z * DIRECTION_LENGTH_M), drag: 'free', role: 'size' }];
    case 'points': {
      const g: Grip[] = m.pts.map((q, i) => ({ id: `p${i}`, at: q, drag: 'plane', role: 'vertex' }));
      if (m.pts.length < m.maxItems) {
        const count = m.start ? m.pts.length + (m.closed ? 1 : 0) : m.pts.length;
        for (let k = m.start ? 0 : 1; k < (m.start ? count : count + 1); k++) {
          const ends = segmentEnds(m, k);
          if (ends === null) continue;
          const [a, b] = ends;
          g.push({ id: `i${k}`, at: p3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), drag: 'plane', role: 'insert' });
        }
      }
      return g;
    }
    case 'point':
      return [{ id: 'point', at: m.p, drag: 'plane', role: 'vertex' }];
  }
}

// ---- dragging -----------------------------------------------------------------

/** Polygon rules the collider validator checks (convex, counter-clockwise, no repeated corner, some area). */
export function polygonProblem(pts: readonly { x: number; y: number }[]): string | null {
  const n = pts.length;
  if (n < 3) return 'a polygon needs at least 3 corners';
  let twice = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    if (a.x === b.x && a.y === b.y) return 'two corners are on the same spot';
    twice += a.x * b.y - b.x * a.y;
  }
  if (twice <= 0) return 'the corners must go counter-clockwise (the shape turned inside out)';
  if (twice / 2 < 1e-6) return 'the polygon has no area';
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const c = pts[(i + 2) % n]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < -1e-9) return 'a polygon collider must stay convex';
  }
  return null;
}

function withError(s: HandleShape): HandleShape {
  const m = s.model;
  if (s.kind === 'polygon' && m.type === 'points') {
    const problem = polygonProblem(m.pts.map((q) => ({ x: round3(q.x), y: round3(q.y) })));
    if (problem !== null) return { ...s, error: problem };
  }
  const { error: _drop, ...rest } = s;
  return rest;
}

/**
 * The shape after dragging grip `id` to the frame point `p`. Values snap
 * when `snap` is on and stay inside the bound fields' ranges.
 */
export function dragGrip(s: HandleShape, id: string, p: P3, snap: boolean): HandleShape {
  const m = s.model;
  const L = s.limits;
  const size = (v: number): number => snapTo(v, SNAP_SIZE_M, snap);
  switch (m.type) {
    case 'box': {
      // Sizes are the full extent (a half-extent field's range doubles).
      const full = (axis: 'x' | 'y' | 'z', raw: number): number => {
        const idx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
        const r = m.roles === 'half' ? L[idx === 0 ? 'halfX' : 'halfY'] : L['size'];
        const range = r === undefined ? undefined : m.roles === 'half' ? { min: 2 * r.min, max: 2 * r.max } : r;
        return round3(clamp(size(raw), range));
      };
      if (id === 'side') return { ...s, model: { ...m, half: { ...m.half, x: full('x', 2 * Math.abs(p.x - m.center.x)) / 2 } } };
      if (id === 'depth') return { ...s, model: { ...m, half: { ...m.half, z: full('z', 2 * Math.abs(p.z - m.center.z)) / 2 } } };
      if (m.anchor === 'bottom') {
        const bottom = m.center.y - m.half.y;
        const h = full('y', p.y - bottom);
        return { ...s, model: { ...m, center: { ...m.center, y: bottom + h / 2 }, half: { ...m.half, y: h / 2 } } };
      }
      return { ...s, model: { ...m, half: { ...m.half, y: full('y', 2 * Math.abs(p.y - m.center.y)) / 2 } } };
    }
    case 'bounds': {
      const r = L['minX'];
      const g = (v: number): number => round3(clamp(snapTo(v, SNAP_TRANSLATE_M, snap), r));
      if (id === 'left') return { ...s, model: { ...m, minX: Math.min(g(p.x), round3(m.maxX - MIN_GAP_M)) } };
      if (id === 'right') return { ...s, model: { ...m, maxX: Math.max(g(p.x), round3(m.minX + MIN_GAP_M)) } };
      if (id === 'bottom') return { ...s, model: { ...m, minY: Math.min(g(p.y), round3(m.maxY - MIN_GAP_M)) } };
      return { ...s, model: { ...m, maxY: Math.max(g(p.y), round3(m.minY + MIN_GAP_M)) } };
    }
    case 'capsule': {
      const rr = L['radius'] ?? { min: 0.05, max: 5 };
      const hr = L['height'] ?? { min: 0.1, max: 20 };
      if (id === 'side') {
        const radius = round3(clamp(size(Math.abs(p.x - m.cx)), { min: rr.min, max: Math.min(rr.max, m.halfHeight) }));
        return { ...s, model: { ...m, radius } };
      }
      // The top moves; the feet stay (the offset follows).
      const bottom = m.cy - m.halfHeight;
      const height = round3(clamp(size(p.y - bottom), { min: Math.max(hr.min, 2 * m.radius), max: hr.max }));
      return { ...s, model: { ...m, cy: round3(bottom + height / 2), halfHeight: height / 2 } };
    }
    case 'radius': {
      const raw = m.along === 'x' ? Math.abs(p.x) : Math.hypot(p.x, p.y);
      return { ...s, model: { ...m, r: round3(clamp(size(raw), L['radius'])) } };
    }
    case 'segment': {
      const v = round3(clamp(size(p.x), L['range']));
      if (id === 'left') return { ...s, model: { ...m, left: Math.min(v, round3(m.right - MIN_GAP_M)) } };
      return { ...s, model: { ...m, right: Math.max(v, round3(m.left + MIN_GAP_M)) } };
    }
    case 'cone': {
      if (id === 'tip') {
        const l = len(p);
        if (l < 1e-3) return s;
        const dir = unit(p);
        const range = m.range > 0 ? round3(clamp(size(l), L['range'])) : m.range;
        return { ...s, model: { ...m, dir, range } };
      }
      const Lc = m.range > 0 ? m.range : CONE_DISPLAY_M;
      const t = dot(p, m.dir);
      const perp = len(p3(p.x - m.dir.x * t, p.y - m.dir.y * t, p.z - m.dir.z * t));
      const deg = (Math.atan2(perp, Lc) * 180) / Math.PI;
      const angle = round3(clamp(snap ? Math.round(deg / SNAP_ANGLE_DEG) * SNAP_ANGLE_DEG : Math.round(deg * 10) / 10, L['angle'] ?? { min: 1, max: 89 }));
      return { ...s, model: { ...m, angle } };
    }
    case 'direction': {
      if (len(p) < 1e-3) return s;
      return { ...s, model: { ...m, dir: unit(p) } };
    }
    case 'points': {
      const i = Number(id.slice(1));
      if (!id.startsWith('p') || !Number.isInteger(i) || m.pts[i] === undefined) return s;
      const step = s.kind === 'path' ? SNAP_TRANSLATE_M : SNAP_SIZE_M;
      const r = L[s.kind === 'path' ? 'points' : 'vertices'];
      const pts = m.pts.map((q, j) => (j === i ? p3(round3(clamp(snapTo(p.x, step, snap), r)), round3(clamp(snapTo(p.y, step, snap), r)), q.z) : q));
      return withError({ ...s, model: { ...m, pts } });
    }
    case 'point': {
      const r = L['point'];
      return { ...s, model: { ...m, p: p3(round3(clamp(snapTo(p.x, SNAP_TRANSLATE_M, snap), r)), round3(clamp(snapTo(p.y, SNAP_TRANSLATE_M, snap), r)), m.p.z) } };
    }
  }
}

/**
 * Start dragging an "insert" grip: a new corner/point at the middle of its
 * segment (the drag then moves grip `p<k>`), or null when the list is full.
 */
export function insertPoint(s: HandleShape, gripId: string): { shape: HandleShape; grip: string } | null {
  const m = s.model;
  if (m.type !== 'points' || !gripId.startsWith('i') || m.pts.length >= m.maxItems) return null;
  const k = Number(gripId.slice(1));
  const ends = segmentEnds(m, k);
  if (ends === null) return null;
  const [a, b] = ends;
  const mid = p3(round3((a.x + b.x) / 2), round3((a.y + b.y) / 2), round3((a.z + b.z) / 2));
  const pts = [...m.pts.slice(0, k), mid, ...m.pts.slice(k)];
  return { shape: withError({ ...s, model: { ...m, pts } }), grip: `p${k}` };
}

/** Delete a corner/point (Alt+click), or say why not. */
export function deletePoint(s: HandleShape, gripId: string): { ok: true; shape: HandleShape } | { ok: false; message: string } {
  const m = s.model;
  if (m.type !== 'points' || !gripId.startsWith('p')) return { ok: false, message: 'only a corner or a path point can be deleted' };
  if (m.pts.length <= m.minItems) return { ok: false, message: `${s.label} keeps at least ${m.minItems} point${m.minItems === 1 ? '' : 's'}` };
  const i = Number(gripId.slice(1));
  const shape = withError({ ...s, model: { ...m, pts: m.pts.filter((_, j) => j !== i) } });
  return shape.error !== undefined ? { ok: false, message: shape.error } : { ok: true, shape };
}

// ---- committing ---------------------------------------------------------------

function fieldWrites(s: HandleShape): [string, DescriptorJson][] {
  const m = s.model;
  const b = s.bind;
  const r3 = (v: P3, dims: 2 | 3): number[] => (dims === 3 ? [round3(v.x), round3(v.y), round3(v.z)] : [round3(v.x), round3(v.y)]);
  switch (m.type) {
    case 'box':
      if (m.roles === 'half') return [[b['halfX']!, round3(m.half.x)], [b['halfY']!, round3(m.half.y)]];
      return [[b['size']!, m.dims === 3 ? [round3(2 * m.half.x), round3(2 * m.half.y), round3(2 * m.half.z)] : [round3(2 * m.half.x), round3(2 * m.half.y)]]];
    case 'bounds':
      return [[b['minX']!, round3(m.minX)], [b['maxX']!, round3(m.maxX)], [b['minY']!, round3(m.minY)], [b['maxY']!, round3(m.maxY)]];
    case 'capsule':
      return [[b['radius']!, round3(m.radius)], [b['height']!, round3(2 * m.halfHeight)], [b['offset']!, [round3(m.cx), round3(m.cy)]]];
    case 'radius':
      return [[b['radius']!, round3(m.r)]];
    case 'segment':
      return [[b['range']!, [round3(m.left), round3(m.right)]]];
    case 'cone': {
      const d = snapDirection(m.dir);
      const out: [string, DescriptorJson][] = [[b['direction']!, d], [b['angle']!, round3(m.angle)]];
      if (m.range > 0) out.push([b['range']!, round3(m.range)]);
      return out;
    }
    case 'direction':
      return [[b['direction']!, snapDirection(m.dir)]];
    case 'points':
      return [[b[s.kind === 'path' ? 'points' : 'vertices']!, m.pts.map((q) => r3(q, m.dims))]];
    case 'point':
      return [[b['point']!, r3(m.p, m.dims)]];
  }
}

/** A direction as stored: components on 0.05 steps (at most ±1; never all zero). */
function snapDirection(d: P3): number[] {
  let v = [d.x, d.y, d.z].map((c) => round3(Math.round(c / SNAP_DIRECTION) * SNAP_DIRECTION));
  if (v.every((c) => c === 0)) v = [d.x, d.y, d.z].map(round3);
  return v;
}

/**
 * The `setComponent` value that stores the shape: the changed top-level
 * fields whole (an optional field back at its default is removed — `null`),
 * `null` when nothing changed, or why it cannot be stored.
 */
export function commitValue(s: HandleShape): { ok: true; component: string; value: Record<string, unknown> } | { ok: false; message: string } | null {
  if (s.error !== undefined) return { ok: false, message: s.error };
  let candidate: unknown = clone(s.value);
  for (const [ptr, v] of fieldWrites(s)) {
    const path = ptrPath(ptr);
    const f = fieldAt(s.root, candidate, path);
    // A nested optional field (a capsule's offset) or an omit-default one back at its default is removed.
    const drop = f !== null && f.required !== true && (path.length > 1 || f.omitDefault === true) && f.default !== undefined && f.default !== null && deepEqual(v, f.default);
    candidate = setAt(candidate, path, drop ? undefined : v);
  }
  const next = candidate as Obj;
  const patch: Obj = {};
  for (const k of new Set([...Object.keys(s.value), ...Object.keys(next)])) {
    if (!deepEqual(s.value[k], next[k])) patch[k] = next[k] === undefined ? null : next[k];
  }
  return Object.keys(patch).length === 0 ? null : { ok: true, component: s.component, value: patch };
}

// ---- drawing ------------------------------------------------------------------

const circle = (cx: number, cy: number, r: number, n = 48): P3[] => Array.from({ length: n + 1 }, (_, i) => p3(cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)));
const rect = (x0: number, y0: number, x1: number, y1: number, z = 0): P3[] => [p3(x0, y0, z), p3(x1, y0, z), p3(x1, y1, z), p3(x0, y1, z), p3(x0, y0, z)];

/** The shape's outline as polylines (frame coordinates) — the drag preview. */
export function linesOf(s: HandleShape): P3[][] {
  const m = s.model;
  switch (m.type) {
    case 'box': {
      const { x: hx, y: hy, z: hz } = m.half;
      const c = m.center;
      if (m.dims === 2) return [rect(c.x - hx, c.y - hy, c.x + hx, c.y + hy, c.z)];
      const front = rect(c.x - hx, c.y - hy, c.x + hx, c.y + hy, c.z + hz);
      const back = rect(c.x - hx, c.y - hy, c.x + hx, c.y + hy, c.z - hz);
      const edges = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [p3(c.x + a! * hx, c.y + b! * hy, c.z - hz), p3(c.x + a! * hx, c.y + b! * hy, c.z + hz)]);
      return [front, back, ...edges];
    }
    case 'bounds':
      return [rect(m.minX, m.minY, m.maxX, m.maxY)];
    case 'capsule': {
      const seg = Math.max(0, m.halfHeight - m.radius);
      const pts: P3[] = [];
      for (let i = 0; i <= 16; i++) pts.push(p3(m.cx + m.radius * Math.cos((i / 16) * Math.PI), m.cy + seg + m.radius * Math.sin((i / 16) * Math.PI)));
      for (let i = 0; i <= 16; i++) pts.push(p3(m.cx + m.radius * Math.cos(Math.PI + (i / 16) * Math.PI), m.cy - seg + m.radius * Math.sin(Math.PI + (i / 16) * Math.PI)));
      pts.push(pts[0]!);
      return [pts];
    }
    case 'radius':
      if (m.along === 'x') {
        const h = m.band !== null && m.band > 0 ? m.band : 0.2;
        return [rect(-m.r, -h, m.r, h)];
      }
      return [circle(0, 0, m.r)];
    case 'segment':
      return [[p3(m.left, 0), p3(m.right, 0)], [p3(m.left, -0.2), p3(m.left, 0.2)], [p3(m.right, -0.2), p3(m.right, 0.2)]];
    case 'cone': {
      const L = m.range > 0 ? m.range : CONE_DISPLAY_M;
      const u = perpendicular(m.dir);
      const v = unit(cross(m.dir, u));
      const r = Math.tan((m.angle * Math.PI) / 180) * L;
      const ring = Array.from({ length: 33 }, (_, i) => {
        const a = (i / 32) * Math.PI * 2;
        return p3(m.dir.x * L + (u.x * Math.cos(a) + v.x * Math.sin(a)) * r, m.dir.y * L + (u.y * Math.cos(a) + v.y * Math.sin(a)) * r, m.dir.z * L + (u.z * Math.cos(a) + v.z * Math.sin(a)) * r);
      });
      return [ring, ...[0, 8, 16, 24].map((i) => [p3(0, 0, 0), ring[i]!])];
    }
    case 'direction':
      return [[p3(0, 0, 0), p3(m.dir.x * DIRECTION_LENGTH_M, m.dir.y * DIRECTION_LENGTH_M, m.dir.z * DIRECTION_LENGTH_M)]];
    case 'points': {
      const pts = m.start ? [p3(0, 0, 0), ...m.pts] : [...m.pts];
      if (m.closed && pts.length > 0) pts.push(pts[0]!);
      return [pts];
    }
    case 'point':
      return [[p3(m.p.x - 0.2, m.p.y, m.p.z), p3(m.p.x + 0.2, m.p.y, m.p.z)], [p3(m.p.x, m.p.y - 0.2, m.p.z), p3(m.p.x, m.p.y + 0.2, m.p.z)]];
  }
}

/** The most corners a polygon collider may have (the collider descriptor's vertex list; 8 before the descriptors arrive). */
export function maxPolygonCorners(reg: DescriptorRegistry | null): number {
  const collider = reg?.components.find((c) => c.name === 'collider')?.value;
  const shape = collider?.type === 'object' ? collider.fields.find((f) => f.key === 'shape') : undefined;
  const vertices = shape?.type === 'object' ? shape.fields.find((f) => f.key === 'vertices') : undefined;
  return vertices?.type === 'list' ? (vertices.maxItems ?? 8) : 8;
}
