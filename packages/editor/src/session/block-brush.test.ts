import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, footprintCells, footprintEdits, yawQuarterTurns, type BlockLayerComponent, type BlockType } from '@thirdlight/runtime';
import * as eb from './block-brush';
import {
  DEFAULT_BRUSH,
  arrayFromCells,
  beginStroke,
  boxBetween,
  brushCell,
  clipBox,
  extendStroke,
  lineCells,
  mirrorEdit,
  nextRotation,
  pasteEdit,
  pickBrush,
  rectBetween,
  rotateEdit,
  rotatedBox,
  sliceKey,
  strokeEdits,
  type Cell3,
  type StrokeContext,
  sculptEdit,
  dabSpacing,
  toolSculpts,
} from './block-brush';
import { enumColors, fieldColor, overlayColor, overlayLegend, parseMetaValue } from './block-overlay';
import { snapToCellTop } from './block-footprint';
import { DEFAULT_SNAP_SETTINGS, getSnapSettings, loadSnapSettings, sanitizeSnapSettings, saveSnapSettings, setSnapSettings, snapTranslateDelta } from './snapping';

const LAYER: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [64, 16, 64] } };
const STONE: BlockType = { blockId: 'stone', name: 'Stone', variants: [{ color: '#777777' }, { color: '#888888' }], shape: 'full' };
const RAMP: BlockType = { blockId: 'ramp', name: 'Ramp', variants: [{ color: '#aa7744' }], shape: 'ramp', rotations: [0, 180] };
const types = new Map([STONE, RAMP].map((t) => [t.blockId, t]));

function ctx(over: Partial<StrokeContext> = {}): StrokeContext {
  return { brush: { ...DEFAULT_BRUSH, block: 'stone' }, type: STONE, bounds: LAYER.bounds, target: null, invert: false, ...over };
}

function stroke(tool: Parameters<typeof beginStroke>[0], cells: Cell3[], freehand = true) {
  const s = beginStroke(tool, cells[0]!);
  for (const c of cells.slice(1)) extendStroke(s, c, freehand);
  return s;
}

describe('block brush maths', () => {
  it('draws a gap-free 3D line', () => {
    expect(lineCells([0, 0, 0], [3, 0, 0])).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]);
    const diag = lineCells([0, 0, 0], [4, 2, 1]);
    expect(diag).toHaveLength(5);
    expect(diag[0]).toEqual([0, 0, 0]);
    expect(diag[4]).toEqual([4, 2, 1]);
    // Every step moves at most one cell per axis.
    for (let i = 1; i < diag.length; i++) for (let a = 0; a < 3; a++) expect(Math.abs(diag[i]![a]! - diag[i - 1]![a]!)).toBeLessThanOrEqual(1);
    expect(lineCells([4, 2, 1], [0, 0, 0])).toHaveLength(5);
    expect(lineCells([2, 3, 4], [2, 3, 4])).toEqual([[2, 3, 4]]);
  });

  it('makes boxes and rectangles (max exclusive) and clips them to the bounds', () => {
    expect(boxBetween([3, 1, 5], [1, 4, 2])).toEqual([1, 1, 2, 4, 5, 6]);
    expect(rectBetween([3, 2, 5], [1, 7, 2])).toEqual([1, 2, 2, 4, 3, 6]);
    expect(rectBetween([0, 2, 0], [1, 2, 1], 3)).toEqual([0, 2, 0, 2, 5, 2]);
    expect(clipBox([-5, 0, 60, 3, 20, 70], LAYER.bounds)).toEqual([0, 0, 60, 3, 16, 64]);
    expect(clipBox([70, 0, 0, 80, 1, 1], LAYER.bounds)).toBeNull();
  });

  it('turns the brush through the block type\'s allowed rotations', () => {
    expect(nextRotation(0, STONE)).toBe(90);
    expect(nextRotation(270, STONE)).toBe(0);
    expect(nextRotation(0, RAMP)).toBe(180);
    expect(nextRotation(180, RAMP)).toBe(0);
    // A disallowed brush rotation paints the first allowed one.
    expect(brushCell({ ...DEFAULT_BRUSH, block: 'ramp', rot: 90 }, RAMP)).toEqual({ block: 'ramp' });
    expect(brushCell({ ...DEFAULT_BRUSH, block: 'ramp', rot: 180 }, RAMP)).toEqual({ block: 'ramp', rot: 180 });
  });

  it('randomized looks carry no variant; a fixed look carries its index', () => {
    expect(brushCell({ ...DEFAULT_BRUSH, block: 'stone', randomize: true, variant: 1 }, STONE)).toEqual({ block: 'stone' });
    expect(brushCell({ ...DEFAULT_BRUSH, block: 'stone', randomize: false, variant: 1 }, STONE)).toEqual({ block: 'stone', variant: 1 });
    expect(brushCell({ ...DEFAULT_BRUSH, block: null }, STONE)).toBeNull();
    // The eyedropper takes block, rotation and look.
    expect(pickBrush(DEFAULT_BRUSH, { block: 'ramp', rot: 180, variant: 0 })).toEqual({ ...DEFAULT_BRUSH, block: 'ramp', rot: 180, variant: 0, randomize: false });
    expect(pickBrush(DEFAULT_BRUSH, { meta: { a: true } })).toBe(DEFAULT_BRUSH);
  });

  it('collects freehand cells without gaps or repeats, and columns once each', () => {
    const s = stroke('single', [[0, 0, 0], [3, 0, 0], [3, 0, 0], [0, 0, 0]]);
    expect(s.cells).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]);
    const col = stroke('column', [[1, 0, 1], [1, 3, 1], [2, 3, 1]]);
    expect(col.cells.map((c) => [c[0], c[2]])).toEqual([[1, 1], [2, 1]]);
  });

  it('turns each tool into one edit of the existing kinds', () => {
    expect(strokeEdits(stroke('single', [[0, 0, 0], [1, 0, 0]]), ctx())).toEqual([{ kind: 'cells', at: [0, 0, 0, 1, 0, 0], cell: { block: 'stone' } }]);
    expect(strokeEdits(stroke('erase', [[0, 0, 0]]), ctx())).toEqual([{ kind: 'cells', at: [0, 0, 0], cell: null }]);
    expect(strokeEdits(stroke('line', [[0, 0, 0], [2, 0, 0]], false), ctx())).toEqual([{ kind: 'cells', at: [0, 0, 0, 1, 0, 0, 2, 0, 0], cell: { block: 'stone' } }]);
    expect(strokeEdits(stroke('rect', [[0, 1, 0], [3, 1, 2]], false), ctx())).toEqual([{ kind: 'fill', box: [0, 1, 0, 4, 2, 3], cell: { block: 'stone' } }]);
    expect(strokeEdits(stroke('box', [[0, 1, 0], [3, 1, 2]], false), ctx({ brush: { ...DEFAULT_BRUSH, block: 'stone', height: 3 } }))).toEqual([{ kind: 'fill', box: [0, 1, 0, 4, 4, 3], cell: { block: 'stone' } }]);
    expect(strokeEdits(stroke('flood', [[5, 0, 5]]), ctx())).toEqual([{ kind: 'flood', at: [5, 0, 5], cell: { block: 'stone' }, connectivity: 'xz' }]);
    expect(strokeEdits(stroke('column', [[1, 0, 1], [2, 0, 1]]), ctx())).toEqual([{ kind: 'column', at: [1, 1, 2, 1], delta: 1, cell: { block: 'stone' } }]);
    expect(strokeEdits(stroke('column', [[1, 0, 1]]), ctx({ invert: true }))).toEqual([{ kind: 'column', at: [1, 1], delta: -1 }]);
    expect(strokeEdits(stroke('replace', [[1, 0, 1]]), ctx({ brush: { ...DEFAULT_BRUSH, block: 'ramp' }, type: RAMP, target: { block: 'stone' } }))).toEqual([{ kind: 'replace', match: { block: 'stone' }, cell: { block: 'ramp' } }]);
    expect(strokeEdits(stroke('replace', [[1, 0, 1]]), ctx({ target: null }))).toBeNull();
    expect(strokeEdits(stroke('meta', [[1, 0, 1], [2, 0, 1]]), ctx({ meta: { field: 'wet', value: true, occupiedOnly: false, shape: 'cells' } }))).toEqual([{ kind: 'meta', set: { wet: true }, at: [1, 0, 1, 2, 0, 1] }]);
    expect(strokeEdits(stroke('meta', [[1, 0, 1], [2, 0, 3]], false), ctx({ meta: { field: 'cost', value: null, occupiedOnly: true, shape: 'rect' } }))).toEqual([{ kind: 'meta', set: { cost: null }, box: [1, 0, 1, 3, 1, 4], occupiedOnly: true }]);
    expect(strokeEdits(stroke('region', [[0, 0, 0], [1, 0, 1]], false), ctx({ region: 'zone.a', invert: true }))).toEqual([{ kind: 'region', regionId: 'zone.a', op: 'remove', boxes: [[0, 0, 0, 2, 1, 2]] }]);
    expect(strokeEdits(stroke('stamp', [[4, 1, 4]]), ctx({ stamp: { stampId: 'hut', rot: 90, mirror: 'x' } }))).toEqual([{ kind: 'stamp', stampId: 'hut', at: [4, 1, 4], rot: 90, mirror: 'x' }]);
    expect(strokeEdits(stroke('paste', [[4, 1, 4]]), ctx({ paste: { kind: 'copy', box: [0, 0, 0, 2, 1, 2] } }))).toEqual([{ kind: 'copy', box: [0, 0, 0, 2, 1, 2], to: [4, 1, 4] }]);
    // Nothing to send without a block, outside the bounds, or for pick tools.
    expect(strokeEdits(stroke('single', [[0, 0, 0]]), ctx({ brush: DEFAULT_BRUSH }))).toBeNull();
    expect(strokeEdits(stroke('single', [[-1, 0, 0]]), ctx())).toBeNull();
    expect(strokeEdits(stroke('eyedropper', [[0, 0, 0]]), ctx())).toBeNull();
  });

  it('the edits do what the stroke shows (the project-model applies them)', () => {
    const g = new BlockGrid(LAYER);
    const run = (edits: ReturnType<typeof strokeEdits>) => {
      const r = applyBlockEdits(g, edits!, { types, stamps: new Map() });
      expect(r.ok).toBe(true);
    };
    run(strokeEdits(stroke('rect', [[0, 0, 0], [3, 0, 3]], false), ctx()));
    expect(g.size).toBe(16);
    run(strokeEdits(stroke('column', [[1, 0, 1], [2, 0, 1]]), ctx()));
    expect(g.columnTop(1, 1)).toBe(1);
    expect(g.columnTop(2, 1)).toBe(1);
    expect(g.columnTop(3, 1)).toBe(0);
    // Mirror in place along x: the raised columns move to the other side of the 4-wide box.
    run([mirrorEdit([0, 0, 0, 4, 2, 4], 'x')]);
    expect(g.columnTop(1, 1)).toBe(1);
    expect(g.columnTop(2, 1)).toBe(1);
    run([{ kind: 'column', at: [2, 1], delta: -1 }]);
    run([mirrorEdit([0, 0, 0, 4, 2, 4], 'x')]);
    // x = 1 (raised) lands on x = 2, x = 2 (lowered) on x = 1.
    expect(g.columnTop(2, 1)).toBe(1);
    expect(g.columnTop(1, 1)).toBe(0);
    // Rotate a 4 × 1 × 1 row about its min corner: it becomes a 1 × 1 × 4 row.
    const row = new BlockGrid(LAYER);
    applyBlockEdits(row, [{ kind: 'fill', box: [10, 0, 10, 14, 1, 11], cell: { block: 'stone' } }], { types, stamps: new Map() });
    applyBlockEdits(row, [rotateEdit([10, 0, 10, 14, 1, 11])], { types, stamps: new Map() });
    expect(rotatedBox([10, 0, 10, 14, 1, 11])).toEqual([10, 0, 10, 11, 1, 14]);
    // Each block turns with the selection.
    for (let z = 10; z < 14; z++) expect(row.get(10, 0, z)).toEqual({ block: 'stone', rot: 90 });
    expect(row.size).toBe(4);
  });

  it('pastes into another layer as an array that leaves empty source cells alone', () => {
    const src = new BlockGrid(LAYER);
    src.set(0, 0, 0, { block: 'stone' });
    src.set(1, 0, 1, { block: 'ramp', rot: 180 });
    const a = arrayFromCells([0, 0, 0, 2, 1, 2], (x, y, z) => src.get(x, y, z));
    expect(a.size).toEqual([2, 1, 2]);
    const dst = new BlockGrid(LAYER);
    dst.set(6, 0, 5, { block: 'stone' });
    const r = applyBlockEdits(dst, [pasteEdit(a, [5, 0, 5])], { types, stamps: new Map() });
    expect(r.ok).toBe(true);
    expect(dst.get(5, 0, 5)).toEqual({ block: 'stone' });
    expect(dst.get(6, 0, 6)).toEqual({ block: 'ramp', rot: 180 });
    expect(dst.get(6, 0, 5)).toEqual({ block: 'stone' });
    expect(dst.size).toBe(3);
  });

  it('moves the slice with PageUp/PageDown and ] / [ within the bounds', () => {
    expect(sliceKey('PageUp', 3, LAYER.bounds)).toBe(4);
    expect(sliceKey(']', 15, LAYER.bounds)).toBe(15);
    expect(sliceKey('PageDown', 0, LAYER.bounds)).toBe(0);
    expect(sliceKey('[', 5, LAYER.bounds)).toBe(4);
    expect(sliceKey('a', 5, LAYER.bounds)).toBeNull();
  });
});

describe('metadata overlay colours', () => {
  const wet = { key: 'wet', type: 'bool' as const, color: '#FF0000' };
  const terrain = { key: 'terrain', type: 'enum' as const, values: ['grass', 'sand', 'water'] };
  const cost = { key: 'cost', type: 'int' as const, default: 1, min: 0, max: 9, color: '#0000ff' };
  it('colours from the schema, generated palettes for enums', () => {
    expect(fieldColor(wet)).toBe('#ff0000');
    expect(fieldColor({ key: 'x' })).toMatch(/^#[0-9a-f]{6}$/);
    expect(fieldColor({ key: 'x' })).toBe(fieldColor({ key: 'x' }));
    const c = enumColors(terrain);
    expect(Object.keys(c)).toEqual(['grass', 'sand', 'water']);
    expect(new Set(Object.values(c)).size).toBe(3);
  });
  it('draws true bools, every enum value, numbers off their default, set strings', () => {
    expect(overlayColor(wet, true)).toBe('#ff0000');
    expect(overlayColor(wet, false)).toBeNull();
    expect(overlayColor(terrain, 'sand')).toBe(enumColors(terrain)['sand']);
    expect(overlayColor(cost, 1)).toBeNull();
    expect(overlayColor(cost, 9)).not.toBeNull();
    expect(overlayColor(cost, 9)).not.toBe(overlayColor(cost, 2));
    expect(overlayColor({ key: 's', type: 'string' }, '')).toBeNull();
    expect(overlayColor({ key: 's', type: 'string' }, 'door')).not.toBeNull();
    expect(overlayColor(wet, true, false)).toBeNull();
  });
  it('lists a legend for the shown fields and parses typed values', () => {
    const legend = overlayLegend([wet, terrain, cost], new Set(['terrain', 'wet']));
    expect(legend.map((l) => l.key)).toEqual(['wet', 'terrain']);
    expect(legend[1]!.entries.map((e) => e.label)).toEqual(['grass', 'sand', 'water']);
    expect(parseMetaValue(wet, 'true')).toEqual({ ok: true, value: true });
    expect(parseMetaValue(cost, '4')).toEqual({ ok: true, value: 4 });
    expect(parseMetaValue(cost, '4.5').ok).toBe(false);
    expect(parseMetaValue(cost, '12').ok).toBe(false);
    expect(parseMetaValue(terrain, 'lava').ok).toBe(false);
  });
});

describe('props on block layers', () => {
  const grid = new BlockGrid(LAYER);
  applyBlockEdits(grid, [{ kind: 'fill', box: [0, 0, 0, 8, 2, 8], cell: { block: 'stone' } }, { kind: 'fill', box: [4, 2, 4, 6, 4, 6], cell: { block: 'stone' } }], { types, stamps: new Map() });
  const layer = { entityId: 'layer-a', component: LAYER, origin: [10, 1, 0], columnTop: (x: number, z: number) => grid.columnTop(x, z) };
  it('reads the quarter turns of a rotation about +Y', () => {
    const q = (deg: number) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
    expect(yawQuarterTurns(q(0))).toBe(0);
    expect(yawQuarterTurns(q(90))).toBe(1);
    expect(yawQuarterTurns(q(-90))).toBe(3);
    expect(yawQuarterTurns(q(185))).toBe(2);
  });
  it('snaps to the top of the column under the prop (a cell centre, or a corner for an even footprint)', () => {
    // Over cell (1, 1): top row 1 → y = 1 + 2 × 0.5.
    expect(snapToCellTop([layer], [11.3, 5, 1.8], undefined, 0)).toEqual([11.5, 2, 1.5]);
    // Over the raised block (rows up to 3).
    expect(snapToCellTop([layer], [14.6, 0, 4.4], undefined, 0)).toEqual([14.5, 3, 4.5]);
    // A 2 × 2 footprint sits on a cell corner; the tallest column under it wins.
    expect(snapToCellTop([layer], [15.9, 0, 5.9], [2, 2], 0)).toEqual([16, 3, 6]);
    expect(snapToCellTop([layer], [100, 0, 0], undefined, 0)).toBeNull();
  });
  it('writes the footprint into the cells beneath and clears the cells it leaves', () => {
    // A 2 × 1 footprint on a cell corner (x = 12 → cells 1 and 2), on row 1 (its base at y = 2).
    const at1 = footprintCells(layer, [12, 2, 1.5], [0, 0, 0, 1], { size: [2, 1] });
    expect(at1).toEqual([1, 1, 1, 2, 1, 1]);
    // A quarter turn swaps the sides.
    const q90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    expect(footprintCells(layer, [11.5, 2, 2], q90, { size: [2, 1] })).toEqual([1, 1, 1, 1, 1, 2]);
    const at2 = footprintCells(layer, [13, 2, 1.5], [0, 0, 0, 1], { size: [2, 1] });
    const edits = footprintEdits(at1, at2, { blocked: true })!;
    expect(edits).toEqual([
      { kind: 'meta', set: { blocked: null }, at: [1, 1, 1] },
      { kind: 'meta', set: { blocked: true }, at: [2, 1, 1, 3, 1, 1] },
    ]);
    expect(footprintEdits(at1, at2, {})).toBeNull();
    expect(footprintCells(layer, [200, 2, 1.5], [0, 0, 0, 1], {})).toEqual([]);
  });
});

describe('snapping settings', () => {
  it('default to the contract constants, validate and persist per project', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadSnapSettings(storage, 'p1')).toEqual(DEFAULT_SNAP_SETTINGS);
    saveSnapSettings(storage, 'p1', { translateM: 1, rotateDeg: 45, scale: 0.5, cellTops: true });
    expect(getSnapSettings().translateM).toBe(1);
    expect(snapTranslateDelta([0.6, 1.4, -2.6])).toEqual([1, 1, -3]);
    expect(loadSnapSettings(storage, 'p2')).toEqual(DEFAULT_SNAP_SETTINGS);
    expect(loadSnapSettings(storage, 'p1')).toEqual({ translateM: 1, rotateDeg: 45, scale: 0.5, cellTops: true });
    expect(sanitizeSnapSettings({ translateM: -1, rotateDeg: 'x', scale: 1e9 })).toEqual(DEFAULT_SNAP_SETTINGS);
    setSnapSettings({ ...DEFAULT_SNAP_SETTINGS });
    expect(snapTranslateDelta([0.1, 0.3, -0.6])).toEqual([0, 0.25, -0.5]);
  });
});

describe('terrain brushes', () => {
  it('a dab is one sculpt edit: raise, lower with the toggle, smooth and flatten blend at most 1; the brush block grows empty ground', () => {
    const brush = { ...DEFAULT_BRUSH, radius: 4, strength: 2 };
    expect(sculptEdit('height', [3.5, 2], brush, false, 0, { block: 'stone' })).toEqual({ kind: 'sculpt', op: 'raise', at: [3.5, 2], radius: 4, strength: 2, cell: { block: 'stone' } });
    expect(sculptEdit('height', [3.5, 2], brush, true, 0, { block: 'stone' })).toEqual({ kind: 'sculpt', op: 'lower', at: [3.5, 2], radius: 4, strength: 2 });
    expect(sculptEdit('smooth', [1, 1], brush, false, 0, null)).toEqual({ kind: 'sculpt', op: 'smooth', at: [1, 1], radius: 4, strength: 1 });
    expect(sculptEdit('flatten', [1, 1], brush, false, 5.25, null)).toEqual({ kind: 'sculpt', op: 'flatten', at: [1, 1], radius: 4, strength: 1, height: 5.25 });
    expect(dabSpacing(1)).toBe(0.5);
    expect(dabSpacing(8)).toBe(2);
    expect(['height', 'smooth', 'flatten', 'column'].map((t) => toolSculpts(t as 'height'))).toEqual([true, true, true, false]);
  });

  it('dabs along a stroke applied to a layer copy give the stored result (the preview is the command)', () => {
    const types = new Map([['stone', { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' } as BlockType]]);
    const layer: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [16, 16, 16] } };
    const base = new BlockGrid(layer);
    applyBlockEdits(base, [{ kind: 'fill', box: [0, 0, 0, 16, 4, 16], cell: { block: 'stone' } }], { types, stamps: new Map() });
    const dabs = [0, 1, 2, 3].map((i) => sculptEdit('height', [4 + i * dabSpacing(3), 8], { ...DEFAULT_BRUSH, radius: 3, strength: 0.5 }, false, 0, null));
    const preview = BlockGrid.from(layer, base.toData('l', null, base.chunkKeys()));
    for (const d of dabs) applyBlockEdits(preview, [d], { types, stamps: new Map() });
    const stored = BlockGrid.from(layer, base.toData('l', null, base.chunkKeys()));
    applyBlockEdits(stored, dabs, { types, stamps: new Map() });
    expect(JSON.stringify(preview.chunkKeys().map((k) => preview.encodeChunk(k)))).toBe(JSON.stringify(stored.chunkKeys().map((k) => stored.encodeChunk(k))));
    expect(preview.get(5, preview.columnTop(5, 8)!, 8)?.corners).toBeDefined();
  });
});

describe('edge brush maths', () => {
  const WALL = { blockId: 'wall', name: 'Wall', variants: [{ color: '#888888' }, { color: '#999999' }], shape: 'full', placement: 'edge' } as BlockType;
  const BOUNDS: BlockLayerComponent['bounds'] = { min: [0, 0, 0], max: [8, 4, 8] };

  it('snaps to the nearest cell edge and grid corner', () => {
    expect(eb.nearestEdge(2.1, 5.5, 1)).toEqual([2, 1, 5, 0]);
    expect(eb.nearestEdge(2.9, 5.5, 1)).toEqual([3, 1, 5, 0]);
    expect(eb.nearestEdge(2.5, 5.05, 1)).toEqual([2, 1, 5, 1]);
    expect(eb.nearestEdge(2.5, 5.95, 1)).toEqual([2, 1, 6, 1]);
    expect(eb.nearestCorner(2.6, 5.2)).toEqual([3, 5]);
  });

  it('a line runs along the grid line in the longer direction; a rectangle draws its outline', () => {
    expect(eb.edgeLine([1, 2], [4, 3], 0)).toEqual([[1, 0, 2, 1], [2, 0, 2, 1], [3, 0, 2, 1]]);
    expect(eb.edgeLine([1, 2], [0, 5], 0)).toEqual([[1, 0, 2, 0], [1, 0, 3, 0], [1, 0, 4, 0]]);
    const room = eb.edgeRect([4, 4], [1, 2], 1);
    expect(room).toHaveLength(2 * 3 + 2 * 2);
    expect(room).toContainEqual([1, 1, 2, 1]);
    expect(room).toContainEqual([3, 1, 4, 1]);
    expect(room).toContainEqual([4, 1, 3, 0]);
    expect(eb.edgeRect([1, 1], [1, 3], 0)).toEqual(eb.edgeLine([1, 1], [1, 3], 0));
  });

  it('the brush puts down the edge piece turned end for end only; the edit keeps the edges inside the bounds', () => {
    expect(eb.allowedRotations(WALL)).toEqual([0, 180]);
    expect(eb.nextRotation(0, WALL)).toBe(180);
    expect(eb.brushEdge({ ...DEFAULT_BRUSH, block: 'wall', rot: 270 }, WALL)).toEqual({ block: 'wall' });
    expect(eb.brushEdge({ ...DEFAULT_BRUSH, block: 'wall', rot: 180, randomize: false, variant: 1 }, WALL)).toEqual({ block: 'wall', rot: 180, variant: 1 });
    expect(eb.edgeTool('rect', WALL) && !eb.edgeTool('box', WALL) && !eb.edgeTool('rect', { placement: undefined })).toBe(true);
    // x = 8 is the layer's far border line (in bounds for an x-line edge), z = 8 is not a cell row.
    expect(eb.edgesEdit([[8, 0, 2, 0], [2, 0, 8, 0], [2, 0, 8, 1]], { block: 'wall' }, BOUNDS)).toEqual([{ kind: 'edges', at: [8, 0, 2, 0, 2, 0, 8, 1], edge: { block: 'wall' } }]);
    expect(eb.edgesEdit([[9, 0, 2, 0]], null, BOUNDS)).toBeNull();
    // Previewed with the backend's own edit code.
    const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: BOUNDS });
    expect(applyBlockEdits(g, eb.edgesEdit(eb.edgeRect([0, 0], [2, 2], 0), { block: 'wall' }, BOUNDS)!, { types: new Map([['wall', WALL]]), stamps: new Map() })).toEqual({ ok: true, cells: 8 });
  });
});
