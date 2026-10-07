/**
 * The instance brush: a stroke paints copies onto an instance set, or erases
 * them, on whatever surface lies under it.
 *
 * A stroke is its dabs (world points the pointer touched) and one brush
 * (radius, density, spacing, random scale and turn, alignment to the
 * surface, a seed). Where copies may go does not depend on how the dabs
 * overlap: the world's XZ plane is cut into square cells of 1 / density m²,
 * each cell holds one point jittered by a hash of the seed and the cell, and
 * the stroke's candidates are the cells' points inside any dab. So the same
 * stroke always gives the same copies, two strokes over one place with one
 * seed give the same points (the second adds nothing), and a long stroke is
 * as dense as a single dab.
 *
 * Each candidate drops straight down onto a surface within the brush's reach
 * above and below its dab. The surface comes from whoever can see it: the
 * editor sends what it found under every candidate (block layers and the
 * drawn shape of every object that collides), and a caller without a view
 * lets the backend drop onto the scene's block layers. The copies are made
 * here, in one place, from the candidates, their surface and the seed.
 *
 * Erasing removes the copies inside any dab's cylinder (the radius across,
 * the reach up and down).
 *
 * The payload of one stroke is bounded (`INSTANCE_BRUSH_LIMITS`), so it fits
 * one command; the set itself has no count of its own beyond an instance
 * set's (`MAX_INSTANCES`).
 */

import { surfaceBelow, type SurfaceGrid } from './block-surface';
import type { BlockType } from './block-layers';
import { INSTANCE_FLOATS, MAX_INSTANCES } from './types-v3';

export type BrushVec3 = [number, number, number];

/** The brush settings one stroke carries. */
export interface InstanceBrush {
  /** Dab radius (m). */
  radius: number;
  /** Copies per square metre the stroke aims for. */
  density: number;
  /** No two copies closer than this across the ground (m; 0: only exact repeats are skipped). */
  spacing: number;
  /** Random uniform scale between these (inclusive). */
  scale: [number, number];
  /** Random turn about the up axis, 0 to this many degrees. */
  yaw: number;
  /** How far each copy leans to the surface normal: 0 upright, 1 along it. */
  align: number;
  /** Picks the jitter, scale and turn: the same seed gives the same copies. */
  seed: number;
}

export type InstanceStrokeMode = 'paint' | 'erase';

/** The surface under one candidate: its height and the normal's X and Z (Y follows); null: nothing there. */
export type StrokeSurfaceSample = [number, number, number] | null;

export interface InstanceStroke {
  mode: InstanceStrokeMode;
  dabs: BrushVec3[];
  brush: InstanceBrush;
  /** Per candidate (in `strokeCandidates` order), the surface under it. */
  surface?: StrokeSurfaceSample[];
}

/**
 * What one stroke may carry. `dabs` and `samples` keep a stroke (with its
 * surface, three numbers per candidate) inside one command request; the rest
 * are the fields' sane ranges.
 */
export const INSTANCE_BRUSH_LIMITS = Object.freeze({
  dabs: 256,
  samples: 1536,
  radius: Object.freeze({ min: 0.05, max: 50 }),
  density: Object.freeze({ min: 0.001, max: 100 }),
  spacing: Object.freeze({ min: 0, max: 50 }),
  scale: Object.freeze({ min: 0.01, max: 100 }),
  yaw: Object.freeze({ min: 0, max: 360 }),
  align: Object.freeze({ min: 0, max: 1 }),
  /** Coordinates and heights (m from the origin). */
  extent: 100_000,
});

/** A new brush's settings (the editor's starting point). */
export const INSTANCE_BRUSH_DEFAULTS: Readonly<InstanceBrush> = Object.freeze({ radius: 2, density: 1, spacing: 0.5, scale: [0.8, 1.2] as [number, number], yaw: 360, align: 0, seed: 1 });

/** The brush reaches this many radii above and below its dab (where copies may land, what erasing takes). */
export const INSTANCE_BRUSH_REACH = 2;

/** Copies closer than this across the ground are the same copy (painting twice adds nothing). */
const SAME_COPY_M = 1e-3;
/** A surface steeper than this (normal Y) is a wall: nothing lands on it. */
const MIN_NORMAL_Y = 0.05;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Why `stroke` (the op's args without `entityId`) is not a stroke, with the path (null: it is one). */
export function instanceStrokeError(stroke: unknown): { path: string; message: string } | null {
  const L = INSTANCE_BRUSH_LIMITS;
  if (typeof stroke !== 'object' || stroke === null || Array.isArray(stroke)) return { path: '', message: 'the stroke is an object' };
  const s = stroke as Record<string, unknown>;
  if (s['mode'] !== 'paint' && s['mode'] !== 'erase') return { path: '/mode', message: 'mode is "paint" or "erase"' };
  const dabs = s['dabs'];
  if (!Array.isArray(dabs) || dabs.length < 1 || dabs.length > L.dabs) return { path: '/dabs', message: `dabs is a list of 1–${L.dabs} world points [x, y, z]` };
  for (let i = 0; i < dabs.length; i++) {
    const d = dabs[i] as unknown;
    if (!Array.isArray(d) || d.length !== 3 || !d.every((v) => isNum(v) && Math.abs(v) <= L.extent)) return { path: `/dabs/${i}`, message: `each dab is [x, y, z] within ${L.extent} m` };
  }
  const b = s['brush'];
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return { path: '/brush', message: 'brush is {radius, density, spacing, scale: [min, max], yaw, align, seed}' };
  const br = b as Record<string, unknown>;
  for (const k of Object.keys(br)) if (!['radius', 'density', 'spacing', 'scale', 'yaw', 'align', 'seed'].includes(k)) return { path: `/brush/${k}`, message: `unknown brush field "${k}"` };
  for (const k of ['radius', 'density', 'spacing', 'yaw', 'align'] as const) {
    const v = br[k];
    const r = L[k];
    if (!isNum(v) || v < r.min || v > r.max) return { path: `/brush/${k}`, message: `${k} is a number ${r.min}–${r.max}` };
  }
  const sc = br['scale'];
  if (!Array.isArray(sc) || sc.length !== 2 || !sc.every((v) => isNum(v) && v >= L.scale.min && v <= L.scale.max) || (sc[0] as number) > (sc[1] as number)) {
    return { path: '/brush/scale', message: `scale is [min, max] with ${L.scale.min} ≤ min ≤ max ≤ ${L.scale.max}` };
  }
  if (!Number.isSafeInteger(br['seed'])) return { path: '/brush/seed', message: 'seed is a whole number' };
  const surface = s['surface'];
  if (surface !== undefined) {
    if (s['mode'] !== 'paint') return { path: '/surface', message: 'only a paint stroke carries a surface' };
    if (!Array.isArray(surface) || surface.length > L.samples) return { path: '/surface', message: `surface is a list of up to ${L.samples} entries [y, nx, nz] or null` };
    for (let i = 0; i < surface.length; i++) {
      const e = surface[i] as unknown;
      if (e === null) continue;
      if (!Array.isArray(e) || e.length !== 3 || !e.every(isNum) || Math.abs(e[0] as number) > L.extent || Math.hypot(e[1] as number, e[2] as number) > 1 + 1e-6) {
        return { path: `/surface/${i}`, message: 'each entry is [y, nx, nz] (the normal\'s X and Z, |(nx, nz)| ≤ 1) or null' };
      }
    }
  }
  for (const k of Object.keys(s)) if (!['mode', 'dabs', 'brush', 'surface', 'entityId'].includes(k)) return { path: `/${k}`, message: `unknown field "${k}"` };
  return null;
}

/** A 32-bit mix of the seed, a cell and a salt in [0, 1) (the same in every JavaScript engine: integer arithmetic only). */
export function brushHash(seed: number, ix: number, iz: number, salt: number): number {
  let h = (seed | 0) ^ Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** One place a copy may go: its cell, its point across the ground and the first dab that holds it. */
export interface StrokeCandidate {
  ix: number;
  iz: number;
  x: number;
  z: number;
  dab: number;
}

/**
 * A stroke's candidates as its dabs come in (the editor adds dabs while the
 * pointer moves). `add` refuses a dab that would take the stroke past
 * `INSTANCE_BRUSH_LIMITS.samples` candidates.
 */
export class StrokeCandidates {
  readonly dabs: BrushVec3[] = [];
  private readonly cells = new Map<string, StrokeCandidate>();
  private readonly cell: number;

  constructor(private readonly brush: Pick<InstanceBrush, 'radius' | 'density' | 'seed'>) {
    this.cell = 1 / Math.sqrt(brush.density);
  }

  get count(): number {
    return this.cells.size;
  }

  add(dab: BrushVec3): boolean {
    const r = this.brush.radius;
    const c = this.cell;
    const fresh: StrokeCandidate[] = [];
    const room = INSTANCE_BRUSH_LIMITS.samples - this.cells.size;
    const index = this.dabs.length;
    for (let iz = Math.floor((dab[2] - r) / c), z1 = Math.floor((dab[2] + r) / c); iz <= z1; iz++) {
      for (let ix = Math.floor((dab[0] - r) / c), x1 = Math.floor((dab[0] + r) / c); ix <= x1; ix++) {
        const key = `${ix},${iz}`;
        if (this.cells.has(key)) continue;
        const x = (ix + brushHash(this.brush.seed, ix, iz, 0)) * c;
        const z = (iz + brushHash(this.brush.seed, ix, iz, 1)) * c;
        if ((x - dab[0]) ** 2 + (z - dab[2]) ** 2 > r * r) continue;
        fresh.push({ ix, iz, x, z, dab: index });
        if (fresh.length > room) return false;
      }
    }
    this.dabs.push([dab[0], dab[1], dab[2]]);
    for (const f of fresh) this.cells.set(`${f.ix},${f.iz}`, f);
    return true;
  }

  /** The candidates in their one order (by cell row, then column): the order a stroke's surface follows. */
  list(): StrokeCandidate[] {
    return [...this.cells.values()].sort((a, b) => a.iz - b.iz || a.ix - b.ix);
  }
}

/** A stroke's candidates (null: more than one stroke may carry). */
export function strokeCandidates(dabs: readonly BrushVec3[], brush: Pick<InstanceBrush, 'radius' | 'density' | 'seed'>): StrokeCandidate[] | null {
  const s = new StrokeCandidates(brush);
  for (const d of dabs) if (!s.add(d)) return null;
  return s.list();
}

/** The heights a candidate's drop spans: from the reach above its dab down to the reach below. */
export function candidateDrop(c: StrokeCandidate, dabs: readonly BrushVec3[], radius: number): { top: number; bottom: number } {
  const y = dabs[c.dab]![1];
  return { top: y + radius * INSTANCE_BRUSH_REACH, bottom: y - radius * INSTANCE_BRUSH_REACH };
}

/** The surface under a point between two heights (the highest one), or null. */
export type StrokeSurfaceDrop = (x: number, top: number, bottom: number, z: number) => StrokeSurfaceSample;

/** A block layer as a surface: its grid, its types and where its origin is in the world. */
export interface BrushBlockLayer {
  grid: SurfaceGrid;
  types: ReadonlyMap<string, BlockType>;
  origin: readonly number[];
}

/** Drop onto block layers' tops (the colliders' shape), the highest within the span. */
export function dropOntoBlockLayers(layers: readonly BrushBlockLayer[]): StrokeSurfaceDrop {
  return (x, top, bottom, z) => {
    let best: StrokeSurfaceSample = null;
    for (const l of layers) {
      const o = l.origin;
      const hit = surfaceBelow(l.grid, l.types, x - o[0]!, top - o[1]!, z - o[2]!);
      if (hit === null) continue;
      const y = o[1]! + hit.height;
      if (y < bottom || y > top || (best !== null && y <= best[0])) continue;
      best = [y, hit.normal[0], hit.normal[2]];
    }
    return best;
  };
}

/** Where the set is in the world: its matrix and inverse (column-major 4 × 4), its world rotation and mean scale. */
export interface InstanceSetSpace {
  toWorld: readonly number[];
  toLocal: readonly number[];
  rotation: readonly [number, number, number, number];
  scale: number;
}

const apply4 = (m: readonly number[], x: number, y: number, z: number): BrushVec3 => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
  m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
  m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
];

export type Quat = [number, number, number, number];
export const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** A painted copy's world rotation: a random turn about up, then a lean toward the normal by `align`. */
export function copyRotation(nx: number, ny: number, nz: number, align: number, yawDeg: number): Quat {
  const t = (yawDeg * Math.PI) / 180 / 2;
  const turn: Quat = [0, Math.sin(t), 0, Math.cos(t)];
  const across = Math.hypot(nx, nz);
  if (align <= 0 || across < 1e-9) return turn;
  const a = (Math.acos(Math.max(-1, Math.min(1, ny))) * align) / 2;
  const s = Math.sin(a) / across;
  // The axis is up × normal = (nz, 0, −nx).
  return qmul([nz * s, 0, -nx * s, Math.cos(a)], turn);
}

export type InstanceStrokeResult =
  | { ok: true; floats: Float32Array; added: number; removed: number }
  | { ok: false; code: 'no_change' | 'set_empty' | 'set_full' | 'stroke_too_large' | 'surface_mismatch'; message: string };

/**
 * Apply a (valid) stroke to a set's copies (`floats`, local to the set).
 * Paint uses the stroke's own surface when it has one, else `drop`; a
 * candidate with no surface gets no copy.
 */
export function applyInstanceStroke(floats: Float32Array, stroke: InstanceStroke, space: InstanceSetSpace, drop?: StrokeSurfaceDrop): InstanceStrokeResult {
  const n = Math.floor(floats.length / INSTANCE_FLOATS);
  const { brush, dabs } = stroke;
  const r = brush.radius;
  const reach = r * INSTANCE_BRUSH_REACH;
  const world = (i: number): BrushVec3 => apply4(space.toWorld, floats[i * INSTANCE_FLOATS]!, floats[i * INSTANCE_FLOATS + 1]!, floats[i * INSTANCE_FLOATS + 2]!);

  if (stroke.mode === 'erase') {
    const keep: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = world(i);
      const hit = dabs.some((d) => (p[0] - d[0]) ** 2 + (p[2] - d[2]) ** 2 <= r * r && Math.abs(p[1] - d[1]) <= reach);
      if (!hit) keep.push(i);
    }
    if (keep.length === n) return { ok: false, code: 'no_change', message: 'no copies of the set under the stroke' };
    if (keep.length === 0) return { ok: false, code: 'set_empty', message: 'an instance set keeps at least one copy (delete the object instead)' };
    const out = new Float32Array(keep.length * INSTANCE_FLOATS);
    keep.forEach((i, k) => out.set(floats.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS), k * INSTANCE_FLOATS));
    return { ok: true, floats: out, added: 0, removed: n - keep.length };
  }

  const candidates = strokeCandidates(dabs, brush);
  if (candidates === null) return { ok: false, code: 'stroke_too_large', message: `the stroke holds more than ${INSTANCE_BRUSH_LIMITS.samples} places for copies (a smaller radius, a lower density or a shorter stroke)` };
  if (stroke.surface !== undefined && stroke.surface.length !== candidates.length) {
    return { ok: false, code: 'surface_mismatch', message: `the surface has ${stroke.surface.length} entries; the stroke has ${candidates.length} candidates` };
  }
  // Spacing across the ground, against the set's copies near the stroke and the new ones.
  const gap = Math.max(brush.spacing, SAME_COPY_M);
  const cell = Math.max(gap, 0.5);
  const near = new Map<string, number[]>();
  const keyOf = (x: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const put = (x: number, z: number): void => {
    const k = keyOf(x, z);
    const list = near.get(k);
    if (list === undefined) near.set(k, [x, z]);
    else list.push(x, z);
  };
  const crowded = (x: number, z: number): boolean => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = near.get(`${cx + dx},${cz + dz}`);
        if (list === undefined) continue;
        for (let i = 0; i < list.length; i += 2) if ((list[i]! - x) ** 2 + (list[i + 1]! - z) ** 2 < gap * gap) return true;
      }
    }
    return false;
  };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const d of dabs) {
    minX = Math.min(minX, d[0] - r - gap);
    maxX = Math.max(maxX, d[0] + r + gap);
    minZ = Math.min(minZ, d[2] - r - gap);
    maxZ = Math.max(maxZ, d[2] + r + gap);
  }
  for (let i = 0; i < n; i++) {
    const p = world(i);
    if (p[0] >= minX && p[0] <= maxX && p[2] >= minZ && p[2] <= maxZ) put(p[0], p[2]);
  }
  const made: number[] = [];
  const [qx, qy, qz, qw] = space.rotation;
  const toSet: Quat = [-qx, -qy, -qz, qw];
  candidates.forEach((c, i) => {
    const span = candidateDrop(c, dabs, r);
    const sample = stroke.surface !== undefined ? stroke.surface[i]! : drop !== undefined ? drop(c.x, span.top, span.bottom, c.z) : null;
    if (sample === null) return;
    const [y, nx, nz] = sample;
    const ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
    if (ny < MIN_NORMAL_Y || y > span.top || y < span.bottom) return;
    if (crowded(c.x, c.z)) return;
    put(c.x, c.z);
    const s = brush.scale[0] + brushHash(brush.seed, c.ix, c.iz, 2) * (brush.scale[1] - brush.scale[0]);
    const q = qmul(toSet, copyRotation(nx, ny, nz, brush.align, brushHash(brush.seed, c.ix, c.iz, 3) * brush.yaw));
    const p = apply4(space.toLocal, c.x, y, c.z);
    const ls = s / space.scale;
    made.push(p[0], p[1], p[2], q[0], q[1], q[2], q[3], ls, ls, ls);
  });
  const added = made.length / INSTANCE_FLOATS;
  if (added === 0) return { ok: false, code: 'no_change', message: 'no place under the stroke takes a copy (no surface there, or copies already within the spacing)' };
  if (n + added > MAX_INSTANCES) return { ok: false, code: 'set_full', message: `the set would hold ${n + added} copies; one instance set holds at most ${MAX_INSTANCES} (paint into another set)` };
  const out = new Float32Array((n + added) * INSTANCE_FLOATS);
  out.set(floats.subarray(0, n * INSTANCE_FLOATS), 0);
  out.set(made, n * INSTANCE_FLOATS);
  return { ok: true, floats: out, added, removed: 0 };
}
