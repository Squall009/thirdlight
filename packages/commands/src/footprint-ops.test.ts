/**
 * Props' block footprints written by the command that places, moves or
 * deletes the prop — one revision and one undo step with it — and the
 * `rebased` count of `editBlocks` surface and sculpt edits.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, type BlockLayerComponent, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, EditBlocksChange, FootprintChunks, MutationSuccess } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
type Change = { type: string; footprints?: FootprintChunks[] };

let counter = 0;
function run(state: State, op: string, args?: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x28b60 + counter).toString(16).padStart(32, '0')}`,
    args: args ?? {},
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args?: Record<string, unknown>): { state: State; change: Change; createdId?: string } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(true);
  const res = r.result as unknown as MutationSuccess;
  return { state: r.state, change: res.change as unknown as Change, createdId: res.createdId };
}

const LAYER: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 8, 32] } };

/** A 32 × 8 × 32 layer at the origin with rows 0-1 filled (tops at y = 1), and a `marked` cell field. */
function setup(): { s: State; layer: string } {
  let s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
  s = ok(s, 'setCellFields', { fields: [{ key: 'marked', type: 'bool' }, { key: 'cost', type: 'int', default: 1, min: 0, max: 9 }] }).state;
  s = ok(s, 'setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' } }).state;
  const c = ok(s, 'createEntity', { kind: 'group', name: 'Ground', transform: { position: [0, 0, 0] } });
  const layer = c.createdId!;
  s = ok(c.state, 'setComponent', { entityId: layer, component: 'blockLayer', value: LAYER }).state;
  s = ok(s, 'editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 32, 2, 32], cell: { block: 'stone' } }] }).state;
  return { s, layer };
}

/** The `marked` field of each cell on row 1 that has it, as "x,z". */
function markedCells(s: State, layer: string): string[] {
  const g = BlockGrid.from(LAYER, s.scene.blocks?.find((b) => b.entityId === layer) ?? null);
  const out: string[] = [];
  g.forEach((x, y, z) => {
    if (y === 1 && g.get(x, y, z)?.meta?.['marked'] === true) out.push(`${x},${z}`);
  });
  return out.sort();
}

function prop(s: State, position: number[], parentId: string | null = null): { s: State; id: string } {
  const c = ok(s, 'createEntity', { kind: 'box', name: 'Hut', parentId, transform: { position }, box: { size: [1, 1, 1] } });
  return { s: c.state, id: c.createdId! };
}

describe('prop footprints in the command layer', () => {
  it('placing the footprint writes the cells beneath in the same step; undo takes both back', () => {
    const { s: s0, layer } = setup();
    const p = prop(s0, [4, 1, 3.5]);
    const placed = ok(p.s, 'setComponent', { entityId: p.id, component: 'blockFootprint', value: { size: [2, 1], set: { marked: true } } });
    expect(placed.state.scene.revision).toBe(p.s.scene.revision + 1);
    expect(markedCells(placed.state, layer)).toEqual(['3,3', '4,3']);
    expect(placed.change.footprints).toEqual([{ entityId: layer, chunks: [[0, 0]], regions: [] }]);
    const undone = ok(placed.state, 'undo');
    expect(markedCells(undone.state, layer)).toEqual([]);
    expect(undone.change.footprints?.[0]?.entityId).toBe(layer);
    expect(undone.state.scene.blocks).toEqual(p.s.scene.blocks);
    expect(markedCells(ok(undone.state, 'redo').state, layer)).toEqual(['3,3', '4,3']);
  });

  it('a move clears the old cells and writes the new ones as one undo step', () => {
    const { s: s0, layer } = setup();
    const p = prop(s0, [4.5, 1, 3.5]);
    const s1 = ok(p.s, 'setComponent', { entityId: p.id, component: 'blockFootprint', value: { set: { marked: true } } }).state;
    expect(markedCells(s1, layer)).toEqual(['4,3']);
    const moved = ok(s1, 'setTransform', { entityId: p.id, transform: { position: [20.5, 1, 18.5] } });
    expect(moved.change.type).toBe('setTransform');
    expect(markedCells(moved.state, layer)).toEqual(['20,18']);
    // Both chunks the footprint touched are named.
    expect(moved.change.footprints).toEqual([{ entityId: layer, chunks: [[0, 0], [1, 1]], regions: [] }]);
    const undone = ok(moved.state, 'undo');
    expect(undone.state.scene.entities.find((e) => e.id === p.id)?.components.transform?.position).toEqual([4.5, 1, 3.5]);
    expect(markedCells(undone.state, layer)).toEqual(['4,3']);
    // The step below is the footprint's placement, not a second write of the move.
    expect(markedCells(ok(undone.state, 'undo').state, layer)).toEqual([]);
    const redone = ok(undone.state, 'redo');
    expect(markedCells(redone.state, layer)).toEqual(['20,18']);
    expect(redone.state.scene.blocks).toEqual(moved.state.scene.blocks);
    // A quarter turn swaps a 2 × 1 footprint's sides.
    const s2 = ok(moved.state, 'setComponent', { entityId: p.id, component: 'blockFootprint', value: { size: [2, 1], set: { marked: true } } }).state;
    const turned = ok(ok(s2, 'setTransform', { entityId: p.id, transform: { position: [20.5, 1, 19] } }).state, 'setTransform', { entityId: p.id, transform: { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } });
    expect(markedCells(turned.state, layer)).toEqual(['20,18', '20,19']);
  });

  it('deleting a prop clears its cells; undoing the delete restores them', () => {
    const { s: s0, layer } = setup();
    const p = prop(s0, [8.5, 1, 8.5]);
    const s1 = ok(p.s, 'setComponent', { entityId: p.id, component: 'blockFootprint', value: { size: [3, 3], set: { marked: true, cost: 5 } } }).state;
    expect(markedCells(s1, layer)).toHaveLength(9);
    const deleted = ok(s1, 'deleteEntity', { entityId: p.id });
    expect(markedCells(deleted.state, layer)).toEqual([]);
    const g = BlockGrid.from(LAYER, deleted.state.scene.blocks?.find((b) => b.entityId === layer) ?? null);
    expect(g.get(8, 1, 8)?.meta).toBeUndefined();
    expect(deleted.change.footprints?.[0]?.entityId).toBe(layer);
    const undone = ok(deleted.state, 'undo');
    expect(undone.state.scene.entities.some((e) => e.id === p.id)).toBe(true);
    expect(undone.state.scene.blocks).toEqual(s1.scene.blocks);
    expect(markedCells(ok(undone.state, 'redo').state, layer)).toEqual([]);
  });

  it('a prop under a moved parent takes its footprint along; edits that move no footprint write nothing', () => {
    const { s: s0, layer } = setup();
    const g = ok(s0, 'createEntity', { kind: 'group', name: 'Yard', transform: { position: [0, 0, 0] } });
    const p = prop(g.state, [2.5, 1, 2.5], g.createdId!);
    const s1 = ok(p.s, 'setComponent', { entityId: p.id, component: 'blockFootprint', value: { layer, set: { marked: true } } }).state;
    const moved = ok(s1, 'setTransform', { entityId: g.createdId!, transform: { position: [3, 0, 0] } });
    expect(markedCells(moved.state, layer)).toEqual(['5,2']);
    // Scale only: the footprint stays where it is.
    const scaled = ok(moved.state, 'setTransform', { entityId: p.id, transform: { scale: [2, 2, 2] } });
    expect(scaled.change.footprints).toBeUndefined();
    expect(scaled.state.scene.blocks).toEqual(moved.state.scene.blocks);
    // Moving the layer leaves the cells it holds as they are.
    const layerMoved = ok(scaled.state, 'setTransform', { entityId: layer, transform: { position: [0, 0, 1] } });
    expect(layerMoved.change.footprints).toBeUndefined();
  });

  it('a footprint set with a field outside the cell schema is refused, naming the field and the layer', () => {
    const { s: s0, layer } = setup();
    const p = prop(s0, [4.5, 1, 3.5]);
    const r = run(p.s, 'setComponent', { entityId: p.id, component: 'blockFootprint', value: { set: { nope: true } } });
    expect(r.result.ok).toBe(false);
    const said = JSON.stringify(r.result);
    expect(said).toContain(`on layer ${layer}`);
    expect(said).toContain('is not a cell field');
    expect(said).toContain('nope');
    expect(r.state).toBe(p.s);
    // Off the layer too: the footprint itself is wrong wherever the prop stands.
    const off = prop(s0, [-10, 1, -10]);
    const r2 = run(off.s, 'setComponent', { entityId: off.id, component: 'blockFootprint', value: { set: { nope: true } } });
    expect(r2.result.ok).toBe(false);
    expect(JSON.stringify(r2.result)).toContain('over no block layer yet');
  });

  it('a footprint field the schema dropped later is skipped by moves of the prop and its parent', () => {
    const { s: s0, layer } = setup();
    const g = ok(s0, 'createEntity', { kind: 'group', name: 'Yard', transform: { position: [0, 0, 0] } });
    // Off the layer, so the cells hold no `marked` when the field goes.
    const p = prop(g.state, [-10.5, 1, 3.5], g.createdId!);
    let s = ok(p.s, 'setComponent', { entityId: p.id, component: 'blockFootprint', value: { set: { marked: true, cost: 3 } } }).state;
    s = ok(s, 'setCellFields', { fields: [{ key: 'cost', type: 'int', default: 1, min: 0, max: 9 }] }).state;
    const meta = (st: State, x: number, z: number): Record<string, unknown> | undefined => BlockGrid.from(LAYER, st.scene.blocks?.find((b) => b.entityId === layer) ?? null).get(x, 1, z)?.meta;
    // The prop moves onto the layer: `cost` lands, the stale `marked` is skipped.
    const moved = ok(s, 'setTransform', { entityId: p.id, transform: { position: [4.5, 1, 3.5] } });
    expect(meta(moved.state, 4, 3)).toEqual({ cost: 3 });
    // Its parent's drag moves it along.
    const dragged = ok(moved.state, 'setTransform', { entityId: g.createdId!, transform: { position: [2, 0, 0] } });
    expect(meta(dragged.state, 4, 3)?.['cost']).toBeUndefined();
    expect(meta(dragged.state, 6, 3)).toEqual({ cost: 3 });
  });

  it("deleting or moving one prop keeps another prop's fields on the cells they share", () => {
    const { s: s0, layer } = setup();
    const a = prop(s0, [4.5, 1, 3.5]);
    let s = ok(a.s, 'setComponent', { entityId: a.id, component: 'blockFootprint', value: { set: { marked: true } } }).state;
    const b = prop(s, [4, 1, 3.5]);
    s = ok(b.s, 'setComponent', { entityId: b.id, component: 'blockFootprint', value: { size: [2, 1], set: { marked: true, cost: 7 } } }).state;
    expect(markedCells(s, layer)).toEqual(['3,3', '4,3']);
    const deleted = ok(s, 'deleteEntity', { entityId: b.id });
    // A still stands on (4,3): its `marked` stays; B's other cell and its `cost` go.
    expect(markedCells(deleted.state, layer)).toEqual(['4,3']);
    const g = BlockGrid.from(LAYER, deleted.state.scene.blocks?.find((e) => e.entityId === layer) ?? null);
    expect(g.get(4, 1, 3)?.meta).toEqual({ marked: true });
    // One undo step brings B and every cell back.
    expect(ok(deleted.state, 'undo').state.scene.blocks).toEqual(s.scene.blocks);
    // Moving B away alike.
    const moved = ok(s, 'setTransform', { entityId: b.id, transform: { position: [20, 1, 20.5] } });
    expect(markedCells(moved.state, layer)).toEqual(['19,20', '20,20', '4,3']);
  });
});

describe('editBlocks rebased count', () => {
  it('counts the columns whose top row a surface or sculpt edit moved', () => {
    const { s: s0, layer } = setup();
    // Columns (0,0) and (1,0) rise to row 4 (a flat top 4 rows up); (2,0) stays at its top (rows 0-1).
    const surf = ok(s0, 'editBlocks', { entityId: layer, edits: [{ kind: 'surface', columns: [0, 0, 4, 4, 4, 4, 1, 0, 4, 4, 4, 4, 2, 0, 2, 2, 2, 2], cell: { block: 'stone' } }] });
    expect((surf.change as unknown as EditBlocksChange).rebased).toBe(2);
    const sculpt = ok(surf.state, 'editBlocks', { entityId: layer, edits: [{ kind: 'sculpt', op: 'raise', at: [16, 16], radius: 3, strength: 3, cell: { block: 'stone' } }] });
    expect((sculpt.change as unknown as EditBlocksChange).rebased).toBeGreaterThan(0);
    // Other edits carry no count.
    const fill = ok(sculpt.state, 'editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [10, 2, 10, 11, 3, 11], cell: { block: 'stone' } }] });
    expect((fill.change as unknown as EditBlocksChange).rebased).toBeUndefined();
  });
});
