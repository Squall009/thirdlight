/**
 * Occluder stand-ins in model files and a model's occluder import setting.
 *
 * A `<piece>_OCC` node is a mesh drawn into the view's depth only: never in
 * colour, never into a shadow map or a probe. Occlusion culling reads that
 * depth, so a model whose own surfaces write no solid depth (a cut-out
 * hedge, glass, thin detail) or are too detailed to be worth it still hides
 * what is behind it. Whatever it covers counts as hidden, so it must lie
 * inside the model's own surfaces. Two checks hold it there, both on the
 * piece's LOD0 geometry: every vertex inside its bounds, and, seen along each
 * axis from both sides, the stand-in nowhere where the piece's triangles are
 * not (an opening in an arch, the notch of an L-shaped piece, the gap between
 * two posts) nor in front of them ({@link occluderCoverageBreaks}). What the
 * checks cannot see is a texture's cut-outs and see-through materials: a
 * stand-in inside a hedge of leaf cards or behind a pane of glass passes, and
 * what shows through them is culled; that is the author's choice. A node that
 * fails a check is reported (the project's problems) and ignored when the
 * model is drawn, so a stray stand-in never hides something seen beside the
 * model.
 *
 * The model's import setting `occluder` says which of its geometry counts as
 * an occluder: `auto` (absent) its `_OCC` nodes when it has any, else its own
 * opaque surfaces; `occ` only its `_OCC` nodes; `none` nothing (its `_OCC`
 * nodes are not drawn at all).
 *
 * Pure: geometry in, rows out; no I/O, no three.js.
 */
import type { ModelErrorV2 } from './errors';
import { MODEL_OCC_RE, modelRenderPrimitives, readModelGeometry, type ModelGeometry } from './model-collision';
import { readGlb } from '@thirdlight/shared';
import { sanitizeRigNodeName } from './model-rig';
import { fieldValue, unexpectedField } from './validate';

/** What of a model counts as an occluder (absent: `auto`). */
export const MODEL_OCCLUDER_MODES = ['auto', 'occ', 'none'] as const;
export type ModelOccluderMode = (typeof MODEL_OCCLUDER_MODES)[number];

/** A model's occluder mode from its record (`auto` when absent or unknown). */
export function modelOccluderModeOf(v: unknown): ModelOccluderMode {
  return v === 'occ' || v === 'none' ? v : 'auto';
}

/** What of a model hides what is behind it: its stand-ins, its own surfaces (`hasStandins`: an `_OCC` node passed the check). */
export function modelOccluderUse(mode: ModelOccluderMode, hasStandins: boolean): { readonly standins: boolean; readonly surfaces: boolean } {
  if (mode === 'none') return { standins: false, surfaces: false };
  if (mode === 'occ') return { standins: true, surfaces: false };
  return { standins: hasStandins, surfaces: !hasStandins };
}

/** The record-level `occluder` setting: models only (`auto` is the default, kept as absence by the canonical form). */
export function validateModelOccluderField(a: Record<string, unknown>, path: string, errors: ModelErrorV2[], isModel: boolean): void {
  const v = a['occluder'];
  if (v === undefined) return;
  if (!isModel) {
    errors.push(unexpectedField(`${path}/occluder`, 'occluder', 'only a model asset has an occluder setting'));
    return;
  }
  if (!(MODEL_OCCLUDER_MODES as readonly unknown[]).includes(v)) errors.push(fieldValue(`${path}/occluder`, v, '"auto", "occ" or "none"', 'occluder is auto (its _OCC nodes, else its opaque surfaces), occ (only its _OCC nodes) or none'));
}

/**
 * How far an `_OCC` vertex may lie outside its piece's LOD0 bounds (m): an
 * exporter's rounding, far below anything a stand-in that hides a seen
 * pixel would need.
 */
export const OCCLUDER_INSIDE_TOLERANCE_M = 0.001;

/** An axis-aligned box (min, max corners). */
export interface OccluderBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** How many of `points` (xyz, flat) lie outside `box` by more than {@link OCCLUDER_INSIDE_TOLERANCE_M}. */
export function occluderPointsOutside(points: ArrayLike<number>, box: OccluderBounds): number {
  const t = OCCLUDER_INSIDE_TOLERANCE_M;
  let n = 0;
  for (let i = 0; i + 2 < points.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = points[i + k]!;
      if (!(v >= box.min[k]! - t && v <= box.max[k]! + t)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

/**
 * The coverage check's grid: texels along the piece's longest side. Coarse on
 * purpose: an opening a stand-in must not cover is a doorway, an arch, the
 * gap between posts, many texels wide on any piece; a texel's slack (the
 * piece's coverage is grown by one texel) keeps an exporter's rounding and
 * thin geometry from failing a stand-in that fits.
 */
export const OCCLUDER_COVERAGE_TEXELS = 64;

/** Where a stand-in leaves its piece, seen along the axes ({@link occluderCoverageBreaks}). */
export interface OccluderCoverageBreaks {
  /** Texels (summed over the three axes) the stand-in covers and the piece does not, within a texel. */
  readonly uncovered: number;
  /** Texels where the stand-in lies in front of every piece surface within a texel, from either side. */
  readonly nearer: number;
}

/** One axis's projection: per texel whether something covers it, and its nearest and farthest depth along the axis. */
class AxisGrid {
  readonly covered: Uint8Array;
  readonly lo: Float32Array;
  readonly hi: Float32Array;
  constructor(
    readonly nu: number,
    readonly nv: number,
  ) {
    this.covered = new Uint8Array(nu * nv);
    this.lo = new Float32Array(nu * nv).fill(Number.POSITIVE_INFINITY);
    this.hi = new Float32Array(nu * nv).fill(Number.NEGATIVE_INFINITY);
  }
  mark(i: number, j: number, depth: number): void {
    if (i < 0 || j < 0 || i >= this.nu || j >= this.nv || !Number.isFinite(depth)) return;
    const k = j * this.nu + i;
    this.covered[k] = 1;
    if (depth < this.lo[k]!) this.lo[k] = depth;
    if (depth > this.hi[k]!) this.hi[k] = depth;
  }
}

/**
 * Draw the triangles (`tris`: nine floats each, three corners) into `grid`
 * along axis `a`: each texel whose centre a triangle covers, with the
 * triangle's depth there; with `edges`, also every texel its corners and
 * edges pass through (so a sliver narrower than a texel still covers its
 * line: the piece's side of the check is the lenient one).
 */
function drawAxis(grid: AxisGrid, tris: ArrayLike<number>, a: number, min: readonly number[], texel: number, edges: boolean): void {
  const u = (a + 1) % 3;
  const v = (a + 2) % 3;
  const P = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let t = 0; t + 8 < tris.length; t += 9) {
    for (let c = 0; c < 3; c += 1) {
      P[c * 3] = (tris[t + c * 3 + u]! - min[u]!) / texel;
      P[c * 3 + 1] = (tris[t + c * 3 + v]! - min[v]!) / texel;
      P[c * 3 + 2] = tris[t + c * 3 + a]!;
    }
    const [x0, y0, d0, x1, y1, d1, x2, y2, d2] = P as [number, number, number, number, number, number, number, number, number];
    if (edges) {
      for (const [ax, ay, ad, bx, by, bd] of [[x0, y0, d0, x1, y1, d1], [x1, y1, d1, x2, y2, d2], [x2, y2, d2, x0, y0, d0]] as const) {
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
        for (let s = 0; s <= steps; s += 1) {
          const f = s / steps;
          // (A corner on the bounds' far side lies on the last texel's edge: it is that texel's.)
          const i = Math.min(grid.nu - 1, Math.floor(ax + (bx - ax) * f));
          const j = Math.min(grid.nv - 1, Math.floor(ay + (by - ay) * f));
          grid.mark(i, j, ad + (bd - ad) * f);
        }
      }
    }
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const i1 = Math.min(grid.nu - 1, Math.ceil(Math.max(x0, x1, x2)));
    const j0 = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const j1 = Math.min(grid.nv - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let j = j0; j <= j1; j += 1) {
      const py = j + 0.5;
      for (let i = i0; i <= i1; i += 1) {
        const px = i + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        grid.mark(i, j, w0 * d0 + w1 * d1 + w2 * d2);
      }
    }
  }
}

/**
 * Where a stand-in (`standin`: triangles, nine floats each) leaves its piece
 * (`piece`, its LOD0 triangles; `box`, their bounds), seen along each axis:
 * texels the stand-in covers that no piece triangle covers within a texel
 * (it would hide what is seen through an opening), and texels where it lies
 * in front of the piece's nearest surface within a texel, from either side
 * (it would hide what is seen beside a bulge), past
 * {@link OCCLUDER_INSIDE_TOLERANCE_M}. Both zero: it passes. A texture's
 * cut-outs and see-through materials are not geometry: they are not seen here.
 */
export function occluderCoverageBreaks(piece: ArrayLike<number>, standin: ArrayLike<number>, box: OccluderBounds): OccluderCoverageBreaks {
  const size = [0, 1, 2].map((k) => box.max[k]! - box.min[k]!);
  const texel = Math.max(...size) / OCCLUDER_COVERAGE_TEXELS;
  if (!(texel > 0)) return { uncovered: 0, nearer: 0 };
  const tol = OCCLUDER_INSIDE_TOLERANCE_M;
  let uncovered = 0;
  let nearer = 0;
  for (let a = 0; a < 3; a += 1) {
    const nu = Math.max(1, Math.ceil(size[(a + 1) % 3]! / texel));
    const nv = Math.max(1, Math.ceil(size[(a + 2) % 3]! / texel));
    const own = new AxisGrid(nu, nv);
    const occ = new AxisGrid(nu, nv);
    drawAxis(own, piece, a, box.min, texel, true);
    drawAxis(occ, standin, a, box.min, texel, false);
    for (let j = 0; j < nv; j += 1) {
      for (let i = 0; i < nu; i += 1) {
        const k = j * nu + i;
        if (occ.covered[k] === 0) continue;
        let any = false;
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let dj = -1; dj <= 1; dj += 1) {
          for (let di = -1; di <= 1; di += 1) {
            const x = i + di;
            const y = j + dj;
            if (x < 0 || y < 0 || x >= nu || y >= nv) continue;
            const n = y * nu + x;
            if (own.covered[n] === 0) continue;
            any = true;
            lo = Math.min(lo, own.lo[n]!);
            hi = Math.max(hi, own.hi[n]!);
          }
        }
        if (!any) uncovered += 1;
        else if (occ.lo[k]! < lo - tol || occ.hi[k]! > hi + tol) nearer += 1;
      }
    }
  }
  return { uncovered, nearer };
}

/** One `_OCC` node checked against its piece. */
export interface ModelOccluderCheck {
  /** The piece it stands in for (its base name; `''`: a file of one piece). */
  readonly piece: string;
  /** The node's path from the scene root (`hedge_OCC`). */
  readonly node: string;
  readonly vertices: number;
  /** Vertices outside the piece's LOD0 bounds: the node is ignored when any is. */
  readonly outside: number;
  /** Where it leaves the piece seen along the axes ({@link occluderCoverageBreaks}): the node is ignored when either is not 0. */
  readonly uncovered: number;
  readonly nearer: number;
  /** The piece has no render geometry to check against (the node is ignored too). */
  readonly noBounds: boolean;
}

/** Every `_OCC` node of a model checked against its piece's LOD0 geometry (empty: the model has none). */
export function modelOccluderChecks(g: ModelGeometry): ModelOccluderCheck[] {
  const nodes = new Map<string, { piece: string; points: number[]; tris: number[] }>();
  for (const p of g.primitives) {
    if (!p.occluder || p.occluderNode === undefined) continue;
    let n = nodes.get(p.occluderNode);
    if (n === undefined) nodes.set(p.occluderNode, (n = { piece: p.piece, points: [], tris: [] }));
    for (const q of p.positions) n.points.push(q[0], q[1], q[2]);
    pushTriangles(p, n.tris);
  }
  const out: ModelOccluderCheck[] = [];
  const pieces = new Map<string, { box: OccluderBounds; tris: number[] } | null>();
  for (const [node, n] of nodes) {
    let own = pieces.get(n.piece);
    if (own === undefined) pieces.set(n.piece, (own = pieceGeometry(g, n.piece)));
    const vertices = n.points.length / 3;
    if (own === null) {
      out.push({ piece: n.piece, node, vertices, outside: vertices, uncovered: 0, nearer: 0, noBounds: true });
      continue;
    }
    const outside = occluderPointsOutside(n.points, own.box);
    const breaks = outside === 0 ? occluderCoverageBreaks(own.tris, n.tris, own.box) : { uncovered: 0, nearer: 0 };
    out.push({ piece: n.piece, node, vertices, outside, ...breaks, noBounds: false });
  }
  return out;
}

/** A primitive's triangles as nine floats each (its positions are in the file's space). */
function pushTriangles(p: ModelGeometry['primitives'][number], out: number[]): void {
  for (const t of p.triangles) for (const i of t) {
    const q = p.positions[i];
    if (q !== undefined) out.push(q[0], q[1], q[2]);
  }
}

/** A piece's LOD0 render triangles and their bounds (the whole file's when it has no render geometry of its own name; null: none). */
function pieceGeometry(g: ModelGeometry, piece: string): { box: OccluderBounds; tris: number[] } | null {
  let prims = modelRenderPrimitives(g, piece);
  // An `_OCC` node whose name matches no drawn piece stands in for the whole file.
  if (prims.length === 0) prims = modelRenderPrimitives(g, null);
  const box = renderBounds(prims);
  if (box === null) return null;
  const tris: number[] = [];
  for (const p of prims) pushTriangles(p, tris);
  return { box, tris };
}

/** The bounds of a piece's render primitives (null: no vertex). */
function renderBounds(prims: readonly ModelGeometry['primitives'][number][]): OccluderBounds | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) for (const q of p.positions) for (let k = 0; k < 3; k += 1) {
    if (q[k]! < min[k]!) min[k] = q[k]!;
    if (q[k]! > max[k]!) max[k] = q[k]!;
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** The problem line of a stand-in that is ignored (null: it is used). */
export function modelOccluderProblem(c: ModelOccluderCheck): string | null {
  if (c.noBounds) return `${c.node}: its piece has no LOD0 geometry to hold it: the occluder stand-in is ignored.`;
  const of = c.piece === '' ? 'the model' : `"${c.piece}"`;
  if (c.outside > 0) return `${c.node}: ${c.outside} of ${c.vertices} vertices outside the LOD0 bounds of ${of}: the occluder stand-in is ignored (it could hide what is seen beside it).`;
  if (c.uncovered > 0) return `${c.node}: it covers an opening of ${of} (no LOD0 surface there, seen along an axis): the occluder stand-in is ignored (it could hide what is seen through it).`;
  if (c.nearer > 0) return `${c.node}: it stands out in front of the LOD0 surfaces of ${of}: the occluder stand-in is ignored (it could hide what is seen beside it).`;
  return null;
}

/**
 * A model file's `_OCC` nodes checked (empty: it has none; a string: why it
 * could not be read). Only a file that names an `_OCC` node is decoded.
 */
export function modelOccluderReport(bytes: Uint8Array): ModelOccluderCheck[] | string {
  const chunks = readGlb(bytes);
  if (typeof chunks === 'string') return chunks;
  const nodes = Array.isArray(chunks.json['nodes']) ? (chunks.json['nodes'] as unknown[]) : [];
  const named = nodes.some((n) => typeof n === 'object' && n !== null && typeof (n as { name?: unknown }).name === 'string' && MODEL_OCC_RE.test(sanitizeRigNodeName((n as { name: string }).name)));
  if (!named) return [];
  const read = readModelGeometry(bytes);
  return read.ok ? modelOccluderChecks(read.geometry) : read.message;
}
