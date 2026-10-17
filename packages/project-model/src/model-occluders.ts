/**
 * Occluder stand-ins in model files and a model's occluder import setting.
 *
 * A `<piece>_OCC` node is a mesh drawn into the view's depth only: never in
 * colour, never into a shadow map or a probe. Occlusion culling reads that
 * depth, so a model whose own surfaces write no solid depth (a cut-out
 * hedge, glass, thin detail) or are too detailed to be worth it still hides
 * what is behind it. The author promises it lies inside the model's own
 * surfaces; what can be checked is that it lies inside the piece's LOD0
 * bounds. A node with a vertex outside them is reported (the project's
 * problems) and ignored when the model is drawn, so a stray stand-in never
 * hides something seen beside the model.
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
import { glbChunks, sanitizeRigNodeName } from './model-rig';
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

/** One `_OCC` node checked against its piece. */
export interface ModelOccluderCheck {
  /** The piece it stands in for (its base name; `''`: a file of one piece). */
  readonly piece: string;
  /** The node's path from the scene root (`hedge_OCC`). */
  readonly node: string;
  readonly vertices: number;
  /** Vertices outside the piece's LOD0 bounds: the node is ignored when any is. */
  readonly outside: number;
  /** The piece has no render geometry to check against (the node is ignored too). */
  readonly noBounds: boolean;
}

/** Every `_OCC` node of a model checked against its piece's LOD0 bounds (empty: the model has none). */
export function modelOccluderChecks(g: ModelGeometry): ModelOccluderCheck[] {
  const nodes = new Map<string, { piece: string; points: number[] }>();
  for (const p of g.primitives) {
    if (!p.occluder || p.occluderNode === undefined) continue;
    let n = nodes.get(p.occluderNode);
    if (n === undefined) nodes.set(p.occluderNode, (n = { piece: p.piece, points: [] }));
    for (const q of p.positions) n.points.push(q[0], q[1], q[2]);
  }
  const out: ModelOccluderCheck[] = [];
  const boxes = new Map<string, OccluderBounds | null>();
  for (const [node, n] of nodes) {
    let box = boxes.get(n.piece);
    if (box === undefined) boxes.set(n.piece, (box = renderBounds(g, n.piece)));
    const vertices = n.points.length / 3;
    out.push({ piece: n.piece, node, vertices, outside: box === null ? vertices : occluderPointsOutside(n.points, box), noBounds: box === null });
  }
  return out;
}

/** The LOD0 render bounds of a piece (of the whole file when it has no render geometry of its own name). */
function renderBounds(g: ModelGeometry, piece: string): OccluderBounds | null {
  let prims = modelRenderPrimitives(g, piece);
  // An `_OCC` node whose name matches no drawn piece stands in for the whole file.
  if (prims.length === 0) prims = modelRenderPrimitives(g, null);
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
  if (c.outside === 0) return null;
  return `${c.node}: ${c.outside} of ${c.vertices} vertices outside the LOD0 bounds of ${c.piece === '' ? 'the model' : `"${c.piece}"`}: the occluder stand-in is ignored (it could hide what is seen beside it).`;
}

/**
 * A model file's `_OCC` nodes checked (empty: it has none; a string: why it
 * could not be read). Only a file that names an `_OCC` node is decoded.
 */
export function modelOccluderReport(bytes: Uint8Array): ModelOccluderCheck[] | string {
  const chunks = glbChunks(bytes);
  if (typeof chunks === 'string') return chunks;
  const nodes = Array.isArray(chunks.json['nodes']) ? (chunks.json['nodes'] as unknown[]) : [];
  const named = nodes.some((n) => typeof n === 'object' && n !== null && typeof (n as { name?: unknown }).name === 'string' && MODEL_OCC_RE.test(sanitizeRigNodeName((n as { name: string }).name)));
  if (!named) return [];
  const read = readModelGeometry(bytes);
  return read.ok ? modelOccluderChecks(read.geometry) : read.message;
}
