/**
 * Live blocks' data rules: the `live` flag on a block type (checked, stored
 * only when true), the prefabs a live block may spawn (a root that stays the
 * cell's static part; a root without a model is a logic-only cell), the ids a
 * cell's objects take, and where the root stands.
 */
import { describe, expect, it } from 'vitest';

import { canonicalBlockType, composeBlockContent, rotatedFootprint, validateBlockType, type BlockType } from './block-layers';
import { blockTypeLive, liveBlockIds, liveBlockPlacement, liveBlockPrefabProblem, liveBlockPrefix, liveBlockRootId, liveEdgeRootId } from './block-live';
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';

const errs = (f: (e: ModelErrorV2[]) => void): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  f(e);
  return e;
};
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const door = (root: Record<string, unknown>, child: Record<string, unknown> = { box: { size: [1, 1, 1], material: { color: '#ffffff' } } }) => ({
  prefabId: 'door',
  entities: [
    { localId: 'group-0001', components: { transform: T, ...root } },
    { localId: 'box-0001', parentLocalId: 'group-0001', components: { transform: T, ...child } },
  ],
});
const LIVE: BlockType = { blockId: 'door', name: 'Door', variants: [{ prefab: 'door' }], shape: 'none', live: true };

describe('live block types', () => {
  it('live is a boolean, needs a prefab look, and is stored only when true', () => {
    expect(errs((e) => validateBlockType(LIVE, '', e))).toEqual([]);
    expect(errs((e) => validateBlockType({ ...LIVE, live: 'yes' }, '', e))[0]?.path).toBe('/live');
    expect(errs((e) => validateBlockType({ ...LIVE, variants: [{ color: '#ff0000' }] }, '', e))[0]?.message).toContain('prefab look');
    expect(errs((e) => validateBlockType({ ...LIVE, variants: [{ color: '#ff0000' }], live: false }, '', e))).toEqual([]);
    expect(canonicalBlockType(LIVE).live).toBe(true);
    expect('live' in canonicalBlockType({ ...LIVE, live: false })).toBe(false);
    expect(blockTypeLive(LIVE)).toBe(true);
    expect(blockTypeLive({ ...LIVE, live: false })).toBe(false);
  });

  it('a live prefab: a root without a model is allowed; a moving root, a player or a nested layer is not', () => {
    const compose = (prefab: ReturnType<typeof door>, type: BlockType = LIVE): ModelErrorV2[] => errs((e) => composeBlockContent({ blockTypes: [type], prefabs: [prefab] }, e));
    expect(compose(door({ behavior: { behaviorId: 'b', values: {} } }))).toEqual([]);
    expect(compose(door({ model: { asset: { assetId: 'm' } } }))).toEqual([]);
    // Not live: the prefab look still needs the model it shows.
    expect(compose(door({}), { ...LIVE, live: false, variants: [{ prefab: 'door' }] })[0]?.message).toContain('has a model on its root');
    expect(compose(door({ mover: { waypoints: [[0, 1, 0]] } }))[0]?.message).toContain('cannot carry mover');
    expect(compose(door({}, { controller: {} }))[0]?.message).toContain('controller');
    expect(compose(door({}, { blockLayer: {} }))[0]?.message).toContain('blockLayer');
    expect(liveBlockPrefabProblem(door({ animator: {} }))).toContain('put moving parts on a child');
    // A child may move.
    expect(liveBlockPrefabProblem(door({}, { mover: { waypoints: [[0, 1, 0]] } }))).toBeNull();
  });

  it('ids come from the cell and fit the id syntax; a long layer id is hashed', () => {
    expect(liveBlockRootId('ground', 3, 0, 12)).toBe('ground-3_0_12');
    expect(liveBlockRootId('ground', -4096, -1024, -4096)).toBe('ground-m4096_m1024_m4096');
    expect(liveBlockIds('ground-1_2_3', 3)).toEqual(['ground-1_2_3', 'ground-1_2_3-1', 'ground-1_2_3-2']);
    const long = 'a'.repeat(60);
    expect(liveBlockPrefix(long)).toMatch(/^l[0-9a-f]{8}$/);
    expect(liveBlockPrefix(long)).not.toBe(liveBlockPrefix(`${'a'.repeat(59)}b`));
    for (const id of liveBlockIds(liveBlockRootId(long, -4096, -1024, -4096), 9999)) expect(ID_RE.test(id)).toBe(true);
    for (const id of liveBlockIds(liveBlockRootId('a'.repeat(40), -4096, -1024, -4096), 9999)) expect(ID_RE.test(id)).toBe(true);
    // An edge piece's ids name its edge (the axis letter after the coordinates) and fit the syntax too.
    expect(liveEdgeRootId('ground', 3, 0, 12, 0)).toBe('ground-3_0_12x');
    expect(liveEdgeRootId('ground', 3, 0, 12, 1)).toBe('ground-3_0_12z');
    for (const id of liveBlockIds(liveEdgeRootId('a'.repeat(40), -4096, -1024, -4096, 1), 9999)) expect(ID_RE.test(id)).toBe(true);
    for (const id of liveBlockIds(liveEdgeRootId('a'.repeat(41), -4096, -1024, -4096, 1), 9999)) expect(ID_RE.test(id)).toBe(true);
  });

  it('the root stands at the bottom centre of the turned footprint, turned about +Y', () => {
    const well: BlockType = { ...LIVE, footprint: [2, 1, 3] };
    const p = liveBlockPlacement({ x: 10, y: 1, z: -5 }, [1, 0.5, 1], rotatedFootprint(well, 90), 90, 4, 2, 6);
    // Turned 90°: the footprint is 3 × 2 along x, z.
    expect(p.position).toEqual([10 + 4 + 1.5, 1 + 1, -5 + 6 + 1]);
    expect(p.rotation[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(p.rotation[3]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(liveBlockPlacement({ x: 0, y: 0, z: 0 }, [2, 1, 2], [1, 1, 1], undefined, 0, 0, 0)).toEqual({ position: [1, 0, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  });
});
