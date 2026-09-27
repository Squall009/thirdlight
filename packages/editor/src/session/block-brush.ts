/**
 * Phase 23.6 (E8): the block-layer brush maths — which cells a stroke
 * covers and the `editBlocks` edits it becomes.
 *
 * A stroke is previewed locally (the same `applyBlockEdits` the backend runs,
 * on a copy of the layer) and committed once, on release, as ONE `editBlocks`
 * command — one undo step per gesture, no round trip per pointer move (the
 * gizmo-drag rule). Every brush is one of the existing edit kinds:
 *
 * - single / erase: `cells` at the cells the pointer crossed (interpolated so
 *   a fast drag leaves no gaps);
 * - line: `cells` along a 3D line between the press and the release cell;
 * - rectangle: `fill` of a one-cell-thick box on the press cell's row;
 * - box: `fill` of the rectangle raised by the brush height;
 * - flood: `flood` from the pressed cell;
 * - raise / lower: `column` (+1 / −1) at every column the stroke crossed;
 * - replace-all-of-type: `replace` of the pressed cell's block in the layer;
 * - metadata paint: `meta` at the crossed cells or over a rectangle;
 * - region paint: `region` add / remove of the rectangle;
 * - stamp: `stamp` at the pressed cell; paste: `copy` (same layer) or
 *   `array` (another layer).
 *
 * Pure: no DOM, no three.js.
 */
import type { BlockCell, BlockEdit, BlockLayerComponent, BlockRotation, BlockType, CellMetaValue } from '@thirdlight/project-model';

export type Cell3 = [number, number, number];

/** A box `[x0, y0, z0, x1, y1, z1]` (min inclusive, max exclusive), as edits take it. */
export type CellBox = [number, number, number, number, number, number];

export type BlockToolId = 'single' | 'line' | 'rect' | 'box' | 'flood' | 'column' | 'erase' | 'eyedropper' | 'replace' | 'meta' | 'select' | 'paste' | 'stamp' | 'region';

/** The tools the Blocks panel offers (label, key, what it does). */
export const BLOCK_TOOLS: readonly { id: BlockToolId; label: string; hint: string }[] = [
  { id: 'single', label: 'Paint', hint: 'Paint the brush block cell by cell (drag).' },
  { id: 'line', label: 'Line', hint: 'Drag a straight line of blocks.' },
  { id: 'rect', label: 'Rectangle', hint: 'Drag a one-cell-thick rectangle.' },
  { id: 'box', label: 'Box', hint: 'Drag a rectangle; it is filled up to the box height.' },
  { id: 'flood', label: 'Flood', hint: 'Fill the connected cells equal to the clicked one.' },
  { id: 'column', label: 'Raise / lower', hint: 'Raise the columns you drag over by one cell (lower: Ctrl held or the Lower toggle).' },
  { id: 'erase', label: 'Erase', hint: 'Erase cells (drag).' },
  { id: 'eyedropper', label: 'Pick', hint: 'Take the clicked cell\'s block, rotation and variant as the brush.' },
  { id: 'replace', label: 'Replace all', hint: 'Replace every block of the clicked cell\'s type in the layer with the brush block.' },
  { id: 'meta', label: 'Metadata', hint: 'Paint the chosen metadata field value (drag; Rectangle shape for an area).' },
  { id: 'select', label: 'Select', hint: 'Drag a box of cells; then move, copy, paste, mirror, rotate or save it as a stamp.' },
  { id: 'paste', label: 'Paste', hint: 'Click to paste the copied cells with their min corner at the cell.' },
  { id: 'stamp', label: 'Stamp', hint: 'Click to place the chosen stamp with its min corner at the cell.' },
  { id: 'region', label: 'Region', hint: 'Drag a rectangle to add it to the chosen region (remove: Ctrl held).' },
];

/** Tools that add cells (their target is the empty cell in front of the face under the pointer). */
export function toolAdds(tool: BlockToolId): boolean {
  return tool === 'single' || tool === 'line' || tool === 'rect' || tool === 'box' || tool === 'paste' || tool === 'stamp';
}

/** Tools whose stroke collects every cell the pointer crosses (the others use the press and the current cell). */
export function toolFreehand(tool: BlockToolId, metaShape: 'cells' | 'rect' = 'cells'): boolean {
  return tool === 'single' || tool === 'erase' || tool === 'column' || (tool === 'meta' && metaShape === 'cells');
}

/** Tools that draw a rectangle from the press to the current cell. */
export function toolRect(tool: BlockToolId, metaShape: 'cells' | 'rect' = 'cells'): boolean {
  return tool === 'rect' || tool === 'box' || tool === 'region' || tool === 'select' || (tool === 'meta' && metaShape === 'rect');
}

// ---- cell geometry -------------------------------------------------------------------

/** The cells of a 3D line from `a` to `b` (both included; Bresenham, one cell per step of the longest axis). */
export function lineCells(a: Cell3, b: Cell3): Cell3[] {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.max(Math.abs(d[0]!), Math.abs(d[1]!), Math.abs(d[2]!));
  if (n === 0) return [[a[0], a[1], a[2]]];
  const out: Cell3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Round half away from zero so the line is symmetric (a → b visits the cells b → a does).
    const r = (v: number): number => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5));
    out.push([a[0] + r(d[0]! * t), a[1] + r(d[1]! * t), a[2] + r(d[2]! * t)]);
  }
  return out;
}

/** The box covering both cells (inclusive). */
export function boxBetween(a: Cell3, b: Cell3): CellBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]) + 1, Math.max(a[1], b[1]) + 1, Math.max(a[2], b[2]) + 1];
}

/** The rectangle between two cells on the press cell's row, `height` cells tall (≥ 1). */
export function rectBetween(a: Cell3, b: Cell3, height = 1): CellBox {
  const h = Math.max(1, Math.floor(height));
  return [Math.min(a[0], b[0]), a[1], Math.min(a[2], b[2]), Math.max(a[0], b[0]) + 1, a[1] + h, Math.max(a[2], b[2]) + 1];
}

/** A box clipped to a layer's bounds (null: nothing left). */
export function clipBox(box: readonly number[], bounds: BlockLayerComponent['bounds']): CellBox | null {
  const out: CellBox = [
    Math.max(box[0]!, bounds.min[0]),
    Math.max(box[1]!, bounds.min[1]),
    Math.max(box[2]!, bounds.min[2]),
    Math.min(box[3]!, bounds.max[0]),
    Math.min(box[4]!, bounds.max[1]),
    Math.min(box[5]!, bounds.max[2]),
  ];
  return out[3] > out[0] && out[4] > out[1] && out[5] > out[2] ? out : null;
}

export function boxVolume(box: readonly number[]): number {
  return Math.max(0, box[3]! - box[0]!) * Math.max(0, box[4]! - box[1]!) * Math.max(0, box[5]! - box[2]!);
}

export function inBounds(c: readonly number[], bounds: BlockLayerComponent['bounds']): boolean {
  return c[0]! >= bounds.min[0] && c[0]! < bounds.max[0] && c[1]! >= bounds.min[1] && c[1]! < bounds.max[1] && c[2]! >= bounds.min[2] && c[2]! < bounds.max[2];
}

/** A key for a cell (distinct cells in a stroke). */
export const cellKey = (c: readonly number[]): string => `${c[0]},${c[1]},${c[2]}`;

// ---- the brush -------------------------------------------------------------------------

export interface BrushState {
  /** The block type painted (null: none chosen). */
  block: string | null;
  rot: BlockRotation;
  /** A fixed look (variant index); null: each cell picks one by the variants' weights. */
  variant: number | null;
  /** Randomize the look: cells carry no variant, so each shows one picked by weight from its position (stable everywhere). */
  randomize: boolean;
  /** Box brush height in cells. */
  height: number;
}

export const DEFAULT_BRUSH: BrushState = { block: null, rot: 0, variant: null, randomize: true, height: 2 };

/** The allowed rotations of a block type (absent: all four). */
export function allowedRotations(t: Pick<BlockType, 'rotations'> | undefined): BlockRotation[] {
  const r = (t?.rotations ?? [0, 90, 180, 270]).filter((v): v is BlockRotation => v === 0 || v === 90 || v === 180 || v === 270);
  return r.length > 0 ? [...r].sort((a, b) => a - b) : [0];
}

/** The next allowed rotation after `rot` (a quarter turn counter-clockwise, skipping disallowed ones). */
export function nextRotation(rot: BlockRotation, t: Pick<BlockType, 'rotations'> | undefined): BlockRotation {
  const allowed = allowedRotations(t);
  const after = allowed.find((r) => r > rot);
  return after ?? allowed[0]!;
}

/** The rotation to paint: the brush's if the type allows it, else its first allowed one. */
export function paintRotation(rot: BlockRotation, t: Pick<BlockType, 'rotations'> | undefined): BlockRotation {
  const allowed = allowedRotations(t);
  return allowed.includes(rot) ? rot : allowed[0]!;
}

/** The cell value the brush paints (null: no block chosen). */
export function brushCell(b: BrushState, t: Pick<BlockType, 'rotations' | 'variants'> | undefined): BlockCell | null {
  if (b.block === null) return null;
  const rot = paintRotation(b.rot, t);
  const cell: BlockCell = { block: b.block };
  if (rot !== 0) cell.rot = rot as 90 | 180 | 270;
  if (!b.randomize && b.variant !== null && t !== undefined && b.variant >= 0 && b.variant < t.variants.length) cell.variant = b.variant;
  return cell;
}

/** The brush after an eyedropper pick of `cell` (its block, rotation and look). */
export function pickBrush(b: BrushState, cell: BlockCell | null): BrushState {
  if (cell === null || cell.block === undefined) return b;
  return { ...b, block: cell.block, rot: (cell.rot ?? 0) as BlockRotation, variant: cell.variant ?? null, randomize: cell.variant === undefined };
}

// ---- strokes ---------------------------------------------------------------------------

/** A stroke in flight: the press cell, the current cell and (freehand tools) every cell crossed, in order. */
export interface Stroke {
  tool: BlockToolId;
  start: Cell3;
  end: Cell3;
  cells: Cell3[];
  seen: Set<string>;
}

/** Most cells a freehand stroke collects (keeps one command under the 64 KiB request cap). */
export const STROKE_MAX_CELLS = 4096;

export function beginStroke(tool: BlockToolId, at: Cell3): Stroke {
  return { tool, start: [...at], end: [...at], cells: [[...at]], seen: new Set([tool === 'column' ? `${at[0]},${at[2]}` : cellKey(at)]) };
}

/**
 * Move the stroke to `at`. Freehand tools add every cell between the last one
 * and `at` (a line, so a fast drag leaves no gaps; the column tool counts
 * each column once). Returns whether the stroke changed.
 */
export function extendStroke(s: Stroke, at: Cell3, freehand: boolean): boolean {
  if (at[0] === s.end[0] && at[1] === s.end[1] && at[2] === s.end[2]) return false;
  const from = s.end;
  s.end = [...at];
  if (!freehand) return true;
  for (const c of lineCells(from, at)) {
    const k = s.tool === 'column' ? `${c[0]},${c[2]}` : cellKey(c);
    if (s.seen.has(k) || s.cells.length >= STROKE_MAX_CELLS) continue;
    s.seen.add(k);
    s.cells.push(c);
  }
  return true;
}

/** What a stroke needs besides its cells. */
export interface StrokeContext {
  brush: BrushState;
  type: Pick<BlockType, 'rotations' | 'variants'> | undefined;
  bounds: BlockLayerComponent['bounds'];
  /** The pressed cell's current value (replace-all, flood). */
  target: BlockCell | null;
  /** Lower columns / remove from a region (Ctrl held, or the panel's toggle). */
  invert: boolean;
  /** Metadata paint: the field and value (null removes the field's override). */
  meta?: { field: string; value: CellMetaValue | null; occupiedOnly: boolean; shape: 'cells' | 'rect' };
  /** Region paint: the region id. */
  region?: string;
  /** Stamp placement. */
  stamp?: { stampId: string; rot: BlockRotation; mirror: 'x' | 'z' | null };
  /** Paste: the copied box (same layer) or its cells (another layer). */
  paste?: PasteSource;
}

export type PasteSource =
  | { kind: 'copy'; box: CellBox; move?: boolean }
  | { kind: 'array'; size: [number, number, number]; palette: (BlockCell | null)[]; data: number[] };

/** Flatten cells to `at` (x, y, z, …), keeping those inside the bounds. */
function flat(cells: readonly Cell3[], bounds: BlockLayerComponent['bounds']): number[] {
  const at: number[] = [];
  for (const c of cells) if (inBounds(c, bounds)) at.push(c[0], c[1], c[2]);
  return at;
}

/**
 * The edits a stroke commits (null: nothing to send — no block chosen, out of
 * bounds, or a pick-only tool). The same edits preview the stroke locally.
 */
export function strokeEdits(s: Stroke, ctx: StrokeContext): BlockEdit[] | null {
  const cell = brushCell(ctx.brush, ctx.type);
  switch (s.tool) {
    case 'single': {
      if (cell === null) return null;
      const at = flat(s.cells, ctx.bounds);
      return at.length > 0 ? [{ kind: 'cells', at, cell }] : null;
    }
    case 'erase': {
      const at = flat(s.cells, ctx.bounds);
      return at.length > 0 ? [{ kind: 'cells', at, cell: null }] : null;
    }
    case 'line': {
      if (cell === null) return null;
      const at = flat(lineCells(s.start, s.end), ctx.bounds);
      return at.length > 0 ? [{ kind: 'cells', at, cell }] : null;
    }
    case 'rect':
    case 'box': {
      if (cell === null) return null;
      const box = clipBox(rectBetween(s.start, s.end, s.tool === 'box' ? ctx.brush.height : 1), ctx.bounds);
      return box !== null ? [{ kind: 'fill', box, cell }] : null;
    }
    case 'flood': {
      if (!inBounds(s.start, ctx.bounds)) return null;
      // Flood with the brush block, or erase-flood when no block is chosen and the target holds one.
      if (cell === null && ctx.target === null) return null;
      return [{ kind: 'flood', at: [...s.start], cell, connectivity: 'xz' }];
    }
    case 'column': {
      const at: number[] = [];
      for (const c of s.cells) if (inBounds(c, ctx.bounds)) at.push(c[0], c[2]);
      if (at.length === 0) return null;
      if (ctx.invert) return [{ kind: 'column', at, delta: -1 }];
      // Raising adds the brush block (or a copy of each column's top block when none is chosen).
      return [{ kind: 'column', at, delta: 1, ...(cell !== null ? { cell } : {}) }];
    }
    case 'replace': {
      if (ctx.target === null || ctx.target.block === undefined) return null;
      if (cell !== null && cell.block === ctx.target.block && cell.rot === undefined && cell.variant === undefined) return null;
      return [{ kind: 'replace', match: { block: ctx.target.block }, cell }];
    }
    case 'meta': {
      const m = ctx.meta;
      if (m === undefined || m.field === '') return null;
      const set = { [m.field]: m.value };
      if (m.shape === 'rect') {
        const box = clipBox(rectBetween(s.start, s.end), ctx.bounds);
        return box !== null ? [{ kind: 'meta', set, box, ...(m.occupiedOnly ? { occupiedOnly: true } : {}) }] : null;
      }
      const at = flat(s.cells, ctx.bounds);
      return at.length > 0 ? [{ kind: 'meta', set, at, ...(m.occupiedOnly ? { occupiedOnly: true } : {}) }] : null;
    }
    case 'region': {
      if (ctx.region === undefined || ctx.region === '') return null;
      const box = clipBox(rectBetween(s.start, s.end), ctx.bounds);
      return box !== null ? [{ kind: 'region', regionId: ctx.region, op: ctx.invert ? 'remove' : 'add', boxes: [box] }] : null;
    }
    case 'stamp': {
      const st = ctx.stamp;
      if (st === undefined) return null;
      return [{ kind: 'stamp', stampId: st.stampId, at: [...s.start], ...(st.rot !== 0 ? { rot: st.rot } : {}), ...(st.mirror !== null ? { mirror: st.mirror } : {}) }];
    }
    case 'paste': {
      const p = ctx.paste;
      if (p === undefined) return null;
      return [pasteEdit(p, s.start)];
    }
    case 'eyedropper':
    case 'select':
      return null;
  }
}

// ---- selections ------------------------------------------------------------------------

/** Paste a copied selection with its min corner at `at`. */
export function pasteEdit(p: PasteSource, at: Cell3): BlockEdit {
  if (p.kind === 'copy') return { kind: 'copy', box: [...p.box], to: [...at], ...(p.move === true ? { move: true } : {}) };
  return { kind: 'array', origin: [...at], size: [...p.size], palette: p.palette.map((c) => (c === null ? null : { ...c })), data: [...p.data] };
}

/** Move the selected cells so the box's min corner lands at `to`. */
export function moveEdit(box: CellBox, to: Cell3): BlockEdit {
  return { kind: 'copy', box: [...box], to: [...to], move: true };
}

/** Mirror the selection in place (along x or z). */
export function mirrorEdit(box: CellBox, axis: 'x' | 'z'): BlockEdit {
  return { kind: 'copy', box: [...box], to: [box[0], box[1], box[2]], mirror: axis, move: true };
}

/** Turn the selection a quarter turn counter-clockwise (seen from above) about its min corner. */
export function rotateEdit(box: CellBox): BlockEdit {
  return { kind: 'copy', box: [...box], to: [box[0], box[1], box[2]], rot: 90, move: true };
}

/** The selection box after a quarter turn (width and depth swap; the min corner stays). */
export function rotatedBox(box: CellBox): CellBox {
  const w = box[3] - box[0];
  const d = box[5] - box[2];
  return [box[0], box[1], box[2], box[0] + d, box[4], box[2] + w];
}

/** The selection box moved so its min corner is at `to`. */
export function movedBox(box: CellBox, to: Cell3): CellBox {
  return [to[0], to[1], to[2], to[0] + box[3] - box[0], to[1] + box[4] - box[1], to[2] + box[5] - box[2]];
}

/**
 * A copied selection as an `array` edit's cells (another layer: `copy` works
 * within one layer). Cells run x fastest, then z, then y; −1 leaves a target
 * cell as it is (so empty source cells do not erase).
 */
export function arrayFromCells(box: CellBox, get: (x: number, y: number, z: number) => BlockCell | null): PasteSource & { kind: 'array' } {
  const palette: (BlockCell | null)[] = [];
  const keys = new Map<string, number>();
  const data: number[] = [];
  let run = -2;
  let count = 0;
  const push = (v: number): void => {
    if (v === run) {
      count += 1;
      return;
    }
    if (count > 0) data.push(count, run);
    run = v;
    count = 1;
  };
  for (let y = box[1]; y < box[4]; y++)
    for (let z = box[2]; z < box[5]; z++)
      for (let x = box[0]; x < box[3]; x++) {
        const c = get(x, y, z);
        if (c === null) {
          push(-1);
          continue;
        }
        const k = JSON.stringify(c);
        let i = keys.get(k);
        if (i === undefined) {
          i = palette.length;
          palette.push(c);
          keys.set(k, i);
        }
        push(i);
      }
  if (count > 0) data.push(count, run);
  // `array` needs at least one palette entry even when every cell is left as it is.
  if (palette.length === 0) palette.push(null);
  return { kind: 'array', size: [box[3] - box[0], box[4] - box[1], box[5] - box[2]], palette, data };
}

// ---- keys ------------------------------------------------------------------------------

/** The slice row after a key (PageUp / ] up, PageDown / [ down), clamped to the bounds; null: not a slice key. */
export function sliceKey(key: string, slice: number, bounds: BlockLayerComponent['bounds']): number | null {
  const up = key === 'PageUp' || key === ']';
  const down = key === 'PageDown' || key === '[';
  if (!up && !down) return null;
  return Math.min(bounds.max[1] - 1, Math.max(bounds.min[1], slice + (up ? 1 : -1)));
}
