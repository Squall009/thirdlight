/** The materials a game uses (the manifest leaves the others out). */
import { describe, expect, it } from 'vitest';
import { materialsInUse } from './material-use';

describe('materialsInUse (phase 25.7b)', () => {
  it('counts object mappings and overrides, shipped model defaults, block types, effects and timelines', () => {
    const used = materialsInUse({
      entities: [
        { components: { materials: { '*': 'm-object' } } },
        { components: { materialParams: { 'm-override': { tint: '#ffffff' } } } },
        { components: { box: { size: [1, 1, 1] } } },
      ],
      assets: [{ materials: { Body: 'm-model-default' } }, {}],
      blockTypes: [{ materials: { '*': 'm-block' } }],
      effects: [{ effectId: 'fx', name: 'Fx', systems: [{ graph: { nodes: [{ id: 'o', type: 'output', data: { shading: 'material', material: 'm-effect' } }], edges: [] } }] } as never],
      timelines: [{ timelineId: 't', name: 'T', duration: 1, tracks: [{ type: 'material', target: 'box-000001', param: 'tint', material: 'm-timeline', keys: [] }] } as never],
    });
    expect([...used].sort()).toEqual(['m-block', 'm-effect', 'm-model-default', 'm-object', 'm-override', 'm-timeline']);
  });

  it('an unnamed material is not used', () => {
    expect(materialsInUse({ entities: [{ components: {} }] }).size).toBe(0);
  });
});
