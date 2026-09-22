import { describe, it, expect } from 'vitest';
import { assetPlacementAvailable, planAssetPlacement, planPrefabPlacement } from './placement';

describe('packet 27 — whole-model placement is a typed command, never a state write', () => {
  it('plans exactly one instantiatePrefab command for a prefab copy', () => {
    const command = planPrefabPlacement('prefab-0001', {
      parentId: null,
      transform: { position: [1, 0, 2] },
      overrides: [{ localId: 'model-0001', key: 'speed', value: 7.25 }],
    });
    expect(command.op).toBe('instantiatePrefab');
    expect(command.args).toEqual({
      prefabId: 'prefab-0001',
      parentId: null,
      transform: { position: [1, 0, 2] },
      overrides: [{ localId: 'model-0001', key: 'speed', value: 7.25 }],
    });
  });

  it('omits absent optional fields and caps overrides at the §20.3 limit', () => {
    expect(planPrefabPlacement('prefab-0001').args).toEqual({ prefabId: 'prefab-0001' });
    const many = Array.from({ length: 80 }, (_, i) => ({ localId: `model-${i}`, key: 'k', value: i }));
    expect(planPrefabPlacement('prefab-0001', { overrides: many }).args.overrides?.length).toBe(64);
  });
});

describe('packet 27 — direct whole-GLB placement plans a real createEntity (C27-1 repair)', () => {
  it('plans one createEntity model command with a resolving asset reference', () => {
    const command = planAssetPlacement('asset-0001', {
      parentId: null,
      transform: { position: [1, 0, 2] },
    });
    expect(command.op).toBe('createEntity');
    expect(command.args).toEqual({
      kind: 'model',
      model: { asset: { assetId: 'asset-0001' } },
      parentId: null,
      transform: { position: [1, 0, 2] },
    });
    expect(assetPlacementAvailable()).toBe(true);
  });
});
