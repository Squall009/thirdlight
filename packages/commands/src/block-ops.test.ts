/**
 * Block-layer commands — block types, cell fields, stamps,
 * editBlocks bulk edits (compact change data), undo/redo, deleting a layer
 * with its cells (and its undo), the request cap and the project rules.
 */
import { describe, expect, it } from 'vitest';
import type { BlockLayerData, SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, EditBlocksChange, MutationSuccess } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;

let counter = 0;
function run(state: State, op: string, args?: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x23500 + counter).toString(16).padStart(32, '0')}`,
    args: args ?? {},
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args?: Record<string, unknown>): { state: State; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string; path?: string } {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  return r.result['error'] as { code: string; message: string };
}
const layerOf = (s: State, id = 'layer-1'): BlockLayerData | undefined => s.scene.blocks?.find((b) => b.entityId === id);
const cellsIn = (d: BlockLayerData | undefined): number => (d?.chunks ?? []).reduce((n, c) => n + c.columns.reduce((m, col) => m + col.slice(2).filter((_, i) => i % 3 === 1).reduce((a, b) => a + b, 0), 0), 0);

/** A project with two block types, a schema and a 32 × 8 × 32 layer. */
function setup(): State {
  let s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
  s = ok(s, 'setCellFields', { fields: [{ key: 'walkable', type: 'bool' }, { key: 'cost', type: 'int', default: 1, min: 0, max: 9 }] }).state;
  s = ok(s, 'setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full', metadata: { walkable: true } } }).state;
  s = ok(s, 'setBlockType', { block: { blockId: 'slab', name: 'Slab', variants: [{ color: '#aaaaaa' }], shape: 'half', rotations: [0] } }).state;
  const created = run(s, 'createEntity', { kind: 'group', name: 'Ground', transform: { position: [0, 0, 0] } });
  expect(created.result.ok, JSON.stringify(created.result)).toBe(true);
  s = created.state;
  const id = (created.result as { createdId: string }).createdId;
  s = ok(s, 'setComponent', { entityId: id, component: 'blockLayer', value: { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 8, 32] } } }).state;
  // rename the id for the tests below (the entity id is what the layer is addressed by)
  (s as { layerId?: string }).layerId = id;
  return s;
}

describe('block layer commands (phase 23.5)', () => {
  it('editBlocks fills, reports a compact change, undoes and redoes', () => {
    const s0 = setup();
    const id = (s0 as { layerId?: string }).layerId!;
    const r = ok(s0, 'editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [0, 0, 0, 20, 2, 20], cell: { block: 'stone' } }, { kind: 'region', regionId: 'spawn.area', op: 'set', boxes: [[0, 2, 0, 4, 3, 4]] }] });
    const change = r.change as EditBlocksChange;
    expect(change).toEqual({ type: 'editBlocks', entityId: id, chunks: [[0, 0], [1, 0], [0, 1], [1, 1]], regions: ['spawn.area'], cells: 800 });
    expect(JSON.stringify(change).length).toBeLessThan(200);
    expect(cellsIn(layerOf(r.state, id))).toBe(800);
    const undone = ok(r.state, 'undo');
    expect(layerOf(undone.state, id)).toBeUndefined();
    expect((undone.change as EditBlocksChange).chunks.length).toBe(4);
    const redone = ok(undone.state, 'redo');
    expect(layerOf(redone.state, id)).toEqual(layerOf(r.state, id));
  });

  it('an edit that changes nothing is no_change; bad edits are field errors', () => {
    const s0 = setup();
    const id = (s0 as { layerId?: string }).layerId!;
    const s1 = ok(s0, 'editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [1, 0, 1], cell: { block: 'stone' } }] }).state;
    expect(refused(s1, 'editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [1, 0, 1], cell: { block: 'stone' } }] }).code).toBe('no_change');
    expect(refused(s1, 'editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [0, 0, 0] }] }).code).toMatch(/field_/);
    expect(refused(s1, 'editBlocks', { entityId: id, edits: [{ kind: 'blob' }] }).code).toBe('field_value');
    expect(refused(s1, 'editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [99, 0, 0], cell: { block: 'stone' } }] }).code).toBe('field_value');
    // the project rules: an unknown block, a rotation the type does not allow, an unknown field
    expect(refused(s1, 'editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [2, 0, 2], cell: { block: 'nope' } }] }).code).toBe('reference_missing');
    expect(refused(s1, 'editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [2, 0, 2], cell: { block: 'slab', rot: 90 } }] }).code).toBe('field_value');
    expect(refused(s1, 'editBlocks', { entityId: id, edits: [{ kind: 'meta', at: [2, 0, 2], set: { nope: 1 } }] }).code).toBe('reference_missing');
    // not a layer
    expect(refused(s1, 'editBlocks', { entityId: 'nope-0001', edits: [{ kind: 'cells', at: [1, 0, 1], cell: null }] }).code).toBe('entity_not_found');
  });

  it('a block type in use cannot be deleted; a cell field in use cannot be dropped', () => {
    const s0 = setup();
    const id = (s0 as { layerId?: string }).layerId!;
    const s1 = ok(s0, 'editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [1, 0, 1], cell: { block: 'slab', meta: { cost: 3 } } }] }).state;
    expect(refused(s1, 'deleteBlockType', { blockId: 'slab' }).code).toBe('reference_missing');
    expect(refused(s1, 'setCellFields', { fields: [{ key: 'walkable', type: 'bool' }] }).code).toBe('reference_missing');
    const s2 = ok(s1, 'editBlocks', { entityId: id, edits: [{ kind: 'cells', at: [1, 0, 1], cell: null }] }).state;
    const s3 = ok(s2, 'deleteBlockType', { blockId: 'slab' }).state;
    expect((s3.content as { blockTypes?: { blockId: string }[] }).blockTypes!.map((t) => t.blockId)).toEqual(['stone']);
    const back = ok(s3, 'undo').state;
    expect((back.content as { blockTypes?: { blockId: string }[] }).blockTypes!.map((t) => t.blockId)).toEqual(['slab', 'stone']);
  });

  it('stamps: save a selection, place it turned, delete it', () => {
    const s0 = setup();
    const id = (s0 as { layerId?: string }).layerId!;
    let s = ok(s0, 'editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [0, 0, 0, 3, 1, 1], cell: { block: 'stone' } }] }).state;
    s = ok(s, 'setBlockStamp', { stampId: 'wall', name: 'Wall', entityId: id, box: [0, 0, 0, 3, 1, 1] }).state;
    const stamp = (s.content as { blockStamps?: { size: number[] }[] }).blockStamps![0]!;
    expect(stamp.size).toEqual([3, 1, 1]);
    s = ok(s, 'editBlocks', { entityId: id, edits: [{ kind: 'stamp', stampId: 'wall', at: [10, 0, 10], rot: 90 }] }).state;
    expect(cellsIn(layerOf(s, id))).toBe(6);
    s = ok(s, 'deleteBlockStamp', { stampId: 'wall' }).state;
    expect((s.content as { blockStamps?: unknown[] }).blockStamps).toBeUndefined();
  });

  it('deleting a layer takes its cells; undo brings them back', () => {
    const s0 = setup();
    const id = (s0 as { layerId?: string }).layerId!;
    const s1 = ok(s0, 'editBlocks', { entityId: id, edits: [{ kind: 'fill', box: [0, 0, 0, 4, 1, 4], cell: { block: 'stone' } }] }).state;
    const del = ok(s1, 'deleteEntity', { entityId: id }).state;
    expect(del.scene.blocks).toBeUndefined();
    const back = ok(del, 'undo').state;
    expect(cellsIn(layerOf(back, id))).toBe(16);
    const again = ok(back, 'redo').state;
    expect(again.scene.blocks).toBeUndefined();
    // removing the component while cells remain is refused (clear the layer first)
    expect(refused(s1, 'setComponent', { entityId: id, component: 'blockLayer', value: null }).code).toBe('reference_missing');
  });

  it('a large map is built in a few requests under the 64 KiB cap (run-length arrays)', () => {
    const s0 = setup();
    const id = (s0 as { layerId?: string }).layerId!;
    // 32 × 32 columns of varying height 1-8: one array edit per 8 rows of z
    let s = s0;
    for (let z0 = 0; z0 < 32; z0 += 8) {
      const data: number[] = [];
      // x fastest, then z, then y; per y layer, a cell is stone when y < height(x, z)
      for (let y = 0; y < 8; y++) for (let z = z0; z < z0 + 8; z++) for (let x = 0; x < 32; x++) {
        const h = 1 + ((x * 7 + z * 3) % 8);
        const v = y < h ? 0 : -1;
        if (data.length >= 2 && data[data.length - 1] === v) data[data.length - 2]! += 1;
        else data.push(1, v);
      }
      const args = { entityId: id, edits: [{ kind: 'array', origin: [0, 0, z0], size: [32, 8, 8], palette: [{ block: 'stone' }], data }] };
      expect(JSON.stringify(args).length).toBeLessThan(65_536);
      s = ok(s, 'editBlocks', args).state;
    }
    let expected = 0;
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) expected += 1 + ((x * 7 + z * 3) % 8);
    expect(cellsIn(layerOf(s, id))).toBe(expected);
  });
});
