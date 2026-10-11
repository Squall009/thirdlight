/**
 * A change of an object's vertex paint alone (a brush stroke, `paintVertices`
 * over MCP, its undo or redo) is drawn in place: the object keeps what it
 * draws until its new paint has been read, then only the paint is swapped.
 * Realizing the object again would take it out of the scene until its new
 * blob arrived — a stroke would make the painted object blink.
 *
 * Pure: two entity documents in, a yes or no out.
 */

/** An entity document as a scene hands it to the adapter (the fields a paint change is told apart by). */
export interface PaintDocLike {
  readonly id: string;
  readonly components: object;
}

/** Component keys a paint change may touch: `vertexPaint`, and `instances` (its `paint`). The transform is followed apart from the document. */
const PAINT_KEYS = new Set(['vertexPaint', 'instances', 'transform']);

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

function withoutPaint(instances: unknown): unknown {
  if (instances === null || typeof instances !== 'object' || Array.isArray(instances)) return instances;
  const { paint: _paint, ...rest } = instances as Record<string, unknown>;
  void _paint;
  return rest;
}

/**
 * Whether `after` differs from `before` only in its vertex paint (its
 * `vertexPaint`, an instance set's `paint`): the paint changed, every other
 * component, its parent, tags and flags the same (a transform changed with
 * it is followed apart from the document). A new document equal by value is
 * no paint change: a host hands one over to have the object made again for
 * what the document does not hold (its asset's options, a material).
 */
export function paintOnlyChange(before: PaintDocLike | undefined, after: PaintDocLike | undefined): boolean {
  if (before === undefined || after === undefined || before.id !== after.id) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === 'components') continue;
    if (!same((before as unknown as Record<string, unknown>)[k], (after as unknown as Record<string, unknown>)[k])) return false;
  }
  const a = before.components as Readonly<Record<string, unknown>>;
  const b = after.components as Readonly<Record<string, unknown>>;
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of names) {
    if (PAINT_KEYS.has(k)) continue;
    if (!same(a[k], b[k])) return false;
  }
  const paintOf = (c: Readonly<Record<string, unknown>>): unknown => [c['vertexPaint'], (c['instances'] as { paint?: unknown } | undefined)?.paint];
  if (same(paintOf(a), paintOf(b))) return false;
  // An instance set's buffer, asset or chunking changed: its copies are made again.
  if ((a['instances'] === undefined) !== (b['instances'] === undefined)) return false;
  if (a['instances'] !== undefined && !same(withoutPaint(a['instances']), withoutPaint(b['instances']))) return false;
  // Paint on an object that draws none (no model, set, architecture or spline) is nothing to draw in place.
  return a['model'] !== undefined || a['instances'] !== undefined || a['architecture'] !== undefined || a['spline'] !== undefined;
}
