/**
 * One vertex paint stroke: its dabs (world points the brush touched), the
 * brush (radius in metres, strength, falloff, the channel, erase) and what
 * it paints (a model's meshes, one copy of an instance set, or one side of
 * a generated mesh's path). The backend that owns the project turns it
 * into bytes with the shared paint brush (`paint-brush.ts`), so the
 * editor's strokes and MCP's are the same command with the same result.
 *
 * Distances are measured in the world, so a scaled object is painted with
 * the brush's real size.
 *
 * Pure: arrays in, bytes out.
 */
import { BRUSH_FALLOFFS, PAINT_BRUSH_LIMITS, brushFalloff, paintPoint, type BrushFalloff } from './paint-brush';
import { PATH_PAINT_SIDES, VERTEX_PAINT_BYTES, VERTEX_PAINT_LAYOUT, isPathPaintKey, type PathPaintSide } from './vertex-paint';

export type PaintVec3 = [number, number, number];

/**
 * The vertex brush's bounds: a stroke fits one command. Strength is the
 * shared brush's blend per dab (its bound is that brush's); the radius is
 * metres in the world, not the block brush's cells, so it is bounded here.
 */
export const VERTEX_PAINT_BRUSH_LIMITS = Object.freeze({
  dabs: 256,
  /** Metres. */
  radius: Object.freeze({ min: 0.01, max: 64 }),
  strengthMax: PAINT_BRUSH_LIMITS.strengthMax,
});

export interface VertexPaintBrush {
  /** Metres in the world. */
  radius: number;
  /** How far toward full (or, erasing, toward 0) one dab moves a vertex at its centre, (0, 1]. */
  strength: number;
  /** smooth (absent), linear or constant (`paint-brush.ts`). */
  falloff?: BrushFalloff;
  /** 0–3: R, G, B, A. */
  channel: number;
  erase?: boolean;
}

export interface VertexPaintStroke {
  dabs: PaintVec3[];
  brush: VertexPaintBrush;
  /** A model: only this mesh (absent: every mesh of the object's model, its piece's when it shows one). */
  mesh?: string;
  /** An instance set: the copy painted (its address: its place in the set's buffer). */
  copy?: number;
  /** A generated mesh: the path painted (`outline:<id>`, `building:<id>`, `element:<id>`, `spline`). */
  path?: string;
  /** With `path`: the faces painted (left or right of travel, or the faces looking up or down). */
  side?: PathPaintSide;
}

const STROKE_KEYS = ['dabs', 'brush', 'mesh', 'copy', 'path', 'side'];
const BRUSH_KEYS = ['radius', 'strength', 'falloff', 'channel', 'erase'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** What is wrong with a stroke (a JSON pointer below the stroke and why), or null. `extra`: keys the caller adds. */
export function vertexPaintStrokeError(s: Record<string, unknown>, extra: readonly string[] = []): { path: string; message: string } | null {
  const L = VERTEX_PAINT_BRUSH_LIMITS;
  for (const k of Object.keys(s)) if (!STROKE_KEYS.includes(k) && !extra.includes(k)) return { path: `/${k}`, message: `unknown field "${k}" (${[...extra, ...STROKE_KEYS].join(', ')})` };
  const dabs = s['dabs'];
  if (!Array.isArray(dabs) || dabs.length < 1 || dabs.length > L.dabs) return { path: '/dabs', message: `dabs is 1-${L.dabs} world points [x, y, z]` };
  for (let i = 0; i < dabs.length; i++) {
    const d = dabs[i] as unknown;
    if (!Array.isArray(d) || d.length !== 3 || !d.every(finite)) return { path: `/dabs/${i}`, message: 'a dab is a world point [x, y, z]' };
  }
  const b = s['brush'];
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return { path: '/brush', message: 'brush is {radius, strength, channel, falloff?, erase?}' };
  const brush = b as Record<string, unknown>;
  for (const k of Object.keys(brush)) if (!BRUSH_KEYS.includes(k)) return { path: `/brush/${k}`, message: `unknown brush field "${k}" (${BRUSH_KEYS.join(', ')})` };
  if (!finite(brush['radius']) || brush['radius'] < L.radius.min || brush['radius'] > L.radius.max) return { path: '/brush/radius', message: `radius is ${L.radius.min}-${L.radius.max} m` };
  if (!finite(brush['strength']) || brush['strength'] <= 0 || brush['strength'] > L.strengthMax) return { path: '/brush/strength', message: 'strength is in (0, 1] (how far one dab moves a vertex at its centre)' };
  if (brush['falloff'] !== undefined && !BRUSH_FALLOFFS.includes(brush['falloff'] as BrushFalloff)) return { path: '/brush/falloff', message: `falloff is ${BRUSH_FALLOFFS.join(', ')}` };
  if (typeof brush['channel'] !== 'number' || !Number.isInteger(brush['channel']) || brush['channel'] < 0 || brush['channel'] >= VERTEX_PAINT_BYTES) return { path: '/brush/channel', message: `channel is 0-${VERTEX_PAINT_BYTES - 1} (R, G, B, A)` };
  if (brush['erase'] !== undefined && typeof brush['erase'] !== 'boolean') return { path: '/brush/erase', message: 'erase is true or false' };
  if (s['mesh'] !== undefined && (typeof s['mesh'] !== 'string' || !/#\d+$/.test(s['mesh']))) return { path: '/mesh', message: 'mesh names one mesh of the model ("Body/Hull#0")' };
  if (s['copy'] !== undefined && (typeof s['copy'] !== 'number' || !Number.isInteger(s['copy']) || s['copy'] < 0)) return { path: '/copy', message: 'copy is a copy\'s address (its place in the set\'s buffer, from 0)' };
  if (s['path'] !== undefined && (typeof s['path'] !== 'string' || !isPathPaintKey(s['path']))) return { path: '/path', message: 'path is "outline:<id>", "building:<id>", "element:<id>" or "spline"' };
  if ((s['path'] === undefined) !== (s['side'] === undefined)) return { path: s['path'] === undefined ? '/path' : '/side', message: 'path and side go together (a generated mesh\'s path and the faces painted)' };
  if (s['side'] !== undefined && !(PATH_PAINT_SIDES as readonly unknown[]).includes(s['side'])) return { path: '/side', message: `side is ${PATH_PAINT_SIDES.join(', ')}` };
  const targets = ['mesh', 'copy', 'path'].filter((k) => s[k] !== undefined);
  if (targets.length > 1 && !(targets.length === 2 && targets.includes('mesh') && targets.includes('copy'))) return { path: `/${targets[1]!}`, message: 'a stroke paints a model\'s meshes, one copy of an instance set, or one side of a path' };
  return null;
}

/**
 * Apply the dabs to the vertices at `points` (world xyz) whose bytes are
 * `values` (4 a vertex), in dab order. Returns how many bytes changed.
 */
export function paintVertexDabs(points: Float32Array, values: Uint8Array, dabs: readonly PaintVec3[], brush: VertexPaintBrush): number {
  const r = brush.radius;
  const r2 = r * r;
  const falloff = brush.falloff ?? 'smooth';
  const n = Math.min(points.length / 3, values.length / VERTEX_PAINT_BYTES);
  // The dabs' box first: most vertices of a big mesh are nowhere near a stroke.
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const d of dabs) {
    x0 = Math.min(x0, d[0] - r); y0 = Math.min(y0, d[1] - r); z0 = Math.min(z0, d[2] - r);
    x1 = Math.max(x1, d[0] + r); y1 = Math.max(y1, d[1] + r); z1 = Math.max(z1, d[2] + r);
  }
  const near: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = points[i * 3]!, y = points[i * 3 + 1]!, z = points[i * 3 + 2]!;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1) near.push(i);
  }
  let changed = 0;
  for (const d of dabs) {
    for (const i of near) {
      const dx = points[i * 3]! - d[0], dy = points[i * 3 + 1]! - d[1], dz = points[i * 3 + 2]! - d[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      if (paintPoint(values, i * VERTEX_PAINT_BYTES, VERTEX_PAINT_LAYOUT, brush, brush.strength * brushFalloff(d2, r, falloff))) changed++;
    }
  }
  return changed;
}

/** Whether every byte is 0 (nothing painted: the blob need not be kept). */
export function paintIsEmpty(values: Uint8Array): boolean {
  for (let i = 0; i < values.length; i++) if (values[i] !== 0) return false;
  return true;
}

/** `points` (xyz) moved by the column-major 4×4 `m`, as float32. */
export function transformPoints(points: Float32Array, m: readonly number[]): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]!, y = points[i + 1]!, z = points[i + 2]!;
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  return out;
}
