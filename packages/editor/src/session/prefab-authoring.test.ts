/**
 * Packet 28 — prefab capture/instantiation planning (Node; vitest).
 *
 * Pins the contract's capture rejection order (§8.6.2/§8.6.3), the three and
 * only three instantiation configurables (§8.7.1), override legality against
 * the published declarations (§8.7.3), the atomic instance limits (§8.7.5)
 * and the client recovery for a stale revision / backend-rejected limit
 * (§5.5/§6.4). Nothing here executes behavior code.
 */
import { describe, expect, it } from 'vitest';
import type { PrefabDefinition, PropertyDeclaration } from '@thirdlight/project-model';
import {
  captureClosure,
  collectOverrides,
  entityRefLinks,
  makePrefabId,
  newPrefabDraft,
  overrideDraftKey,
  planCreatePrefab,
  planInstantiatePrefab,
  preflightCreatePrefab,
  recoverPrefabCommandFailure,
  type CaptureEntityView,
} from './prefab-authoring';
import { deriveOverrideTargets } from './property-controls';

const DECLARATION: PropertyDeclaration = {
  properties: [
    { key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 },
    { key: 'target', label: 'Target', type: 'entityRef', default: null },
    { key: 'material', label: 'Material', type: 'assetRef', default: 'asset-7f3a2c9e1b4d5068' },
  ],
};
const DECLARATIONS = new Map([['behavior-0001', DECLARATION]]);
const ASSETS = ['asset-7f3a2c9e1b4d5068', 'asset-2b11d4a76c9f0e35'];

/** The accepted `prefab-scenario.after.json` definition (4 entities, depth 2). */
const DEFINITION: PrefabDefinition = {
  prefabId: 'prefab-0001',
  displayName: 'Station Kit',
  createdRevision: 5,
  entityCount: 4,
  depth: 2,
  entities: [
    { localId: 'group-0001', name: 'Station', components: { transform: tr() } },
    {
      localId: 'box-0001',
      name: 'Pedestal',
      parentLocalId: 'group-0001',
      components: { transform: tr(), box: { size: [2, 0.5, 2], material: { color: '#b0b0b0' } } },
    },
    {
      localId: 'model-0001',
      name: 'Lantern',
      parentLocalId: 'group-0001',
      components: {
        transform: tr(),
        model: { asset: { assetId: 'asset-7f3a2c9e1b4d5068' } },
        behavior: {
          behaviorId: 'behavior-0001',
          values: { speed: 4.5, target: 'group-0001', material: 'asset-7f3a2c9e1b4d5068' },
        },
      },
    },
    {
      localId: 'model-0002',
      name: 'Ramp',
      parentLocalId: 'group-0001',
      components: { transform: tr(), model: { asset: { assetId: 'asset-2b11d4a76c9f0e35' } } },
    },
  ],
};

function tr(): PrefabDefinition['entities'][number]['components']['transform'] {
  return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function view(over: Partial<CaptureEntityView> & { id: string }): CaptureEntityView {
  return { parentId: null, camera: false, prefab: null, behavior: null, ...over };
}

const SCENE: CaptureEntityView[] = [
  view({ id: 'group-0000' }),
  view({ id: 'cam-main', camera: true }),
  view({ id: 'group-0001', parentId: 'group-0000' }),
  view({ id: 'box-0001', parentId: 'group-0001' }),
  view({ id: 'model-0001', parentId: 'group-0001', behavior: { behaviorId: 'behavior-0001', values: { speed: 4.5, target: 'group-0001', material: 'asset-7f3a2c9e1b4d5068' } } }),
  view({ id: 'model-0002', parentId: 'group-0001' }),
];

const BASE_INSTANTIATE = {
  prefabId: 'prefab-0001',
  definition: DEFINITION,
  declarations: DECLARATIONS,
  parentId: null as string | null,
  sceneEntityIds: ['group-0000', 'group-0001', 'cam-main'],
  assetIds: ASSETS,
  sceneEntityCount: 6,
  parentDepth: 0,
};

describe('packet 28 — capture closure and preflight (commands.md §8.6.2/§8.6.3)', () => {
  it('computes the subtree closure in document order with its depth', () => {
    const closure = captureClosure(SCENE, 'group-0001');
    expect(closure?.entities.map((e) => e.id)).toEqual(['group-0001', 'box-0001', 'model-0001', 'model-0002']);
    expect(closure?.depth).toBe(2);
    expect(captureClosure(SCENE, 'nope')).toBeNull();
  });

  it('finds declared entityRef links through the published declaration', () => {
    const model = SCENE.find((e) => e.id === 'model-0001')!;
    expect(entityRefLinks(model, DECLARATIONS)).toEqual([{ key: 'target', entityId: 'group-0001' }]);
    expect(entityRefLinks(view({ id: 'x' }), DECLARATIONS)).toEqual([]);
  });

  it('plans exactly one createPrefab command for a legal capture', () => {
    const plan = planCreatePrefab({
      prefabId: 'prefab-0002',
      displayName: 'Station Kit Copy',
      sourceEntityId: 'group-0001',
      scene: SCENE,
      existingPrefabIds: ['prefab-0001'],
      declarations: DECLARATIONS,
      cameraId: 'cam-main',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.command).toEqual({
      op: 'createPrefab',
      args: { prefabId: 'prefab-0002', displayName: 'Station Kit Copy', sourceEntityId: 'group-0001' },
    });
  });

  it('rejects the camera, a nested copy and an external reference atomically', () => {
    const base = {
      prefabId: 'prefab-0002',
      displayName: 'Kit',
      scene: SCENE,
      existingPrefabIds: [] as string[],
      declarations: DECLARATIONS,
      cameraId: 'cam-main',
    };
    const camera = preflightCreatePrefab({ ...base, sourceEntityId: 'cam-main' });
    expect(camera).toMatchObject({ ok: false, error: { code: 'prefab_camera_capture_forbidden', cameraId: 'cam-main' } });

    const nestedScene = [...SCENE, view({ id: 'group-0002', prefab: { prefabId: 'prefab-0001', localId: 'group-0001' } })];
    const nested = preflightCreatePrefab({ ...base, scene: nestedScene, sourceEntityId: 'group-0002' });
    expect(nested).toMatchObject({ ok: false, error: { code: 'prefab_nested_forbidden', prefabInstanceIds: ['group-0002'] } });

    const externalScene = SCENE.map((e) =>
      e.id === 'model-0001' ? { ...e, behavior: { behaviorId: 'behavior-0001', values: { speed: 4.5, target: 'group-0000', material: 'asset-7f3a2c9e1b4d5068' } } } : e,
    );
    const external = preflightCreatePrefab({ ...base, scene: externalScene, sourceEntityId: 'group-0001' });
    expect(external).toMatchObject({
      ok: false,
      error: { code: 'prefab_external_reference_forbidden', localId: 'model-0001', key: 'target', entityId: 'group-0000' },
    });
  });

  it('rejects bad ids, duplicate ids, a bad display name and an unknown source', () => {
    const base = {
      prefabId: 'prefab-0002',
      displayName: 'Kit',
      sourceEntityId: 'group-0001',
      scene: SCENE,
      existingPrefabIds: [] as string[],
      declarations: DECLARATIONS,
    };
    expect(preflightCreatePrefab({ ...base, prefabId: 'Bad Id' })).toMatchObject({ ok: false, error: { code: 'id_invalid' } });
    expect(preflightCreatePrefab({ ...base, existingPrefabIds: ['prefab-0002'] })).toMatchObject({ ok: false, error: { code: 'prefab_id_duplicate' } });
    expect(preflightCreatePrefab({ ...base, displayName: '' })).toMatchObject({ ok: false, error: { code: 'field_value' } });
    expect(preflightCreatePrefab({ ...base, sourceEntityId: 'group-9999' })).toMatchObject({ ok: false, error: { code: 'entity_not_found' } });
  });

  it('enforces the prefab_entities/prefab_depth/prefabs limits', () => {
    const deep: CaptureEntityView[] = [];
    for (let i = 0; i < 20; i += 1) deep.push(view({ id: `group-${i}`, parentId: i === 0 ? null : `group-${i - 1}` }));
    const base = { prefabId: 'prefab-0002', displayName: 'Kit', scene: deep, existingPrefabIds: [] as string[], declarations: DECLARATIONS };
    expect(preflightCreatePrefab({ ...base, sourceEntityId: 'group-0' })).toMatchObject({
      ok: false,
      error: { code: 'limits_exceeded', limit: 'prefab_depth', current: 20, max: 16 },
    });

    const wide: CaptureEntityView[] = [view({ id: 'group-0' })];
    for (let i = 0; i < 257; i += 1) wide.push(view({ id: `box-${i}`, parentId: 'group-0' }));
    expect(preflightCreatePrefab({ ...base, scene: wide, sourceEntityId: 'group-0' })).toMatchObject({
      ok: false,
      error: { code: 'limits_exceeded', limit: 'prefab_entities', current: 258, max: 256 },
    });

    const many = Array.from({ length: 128 }, (_, i) => `prefab-${i}`);
    expect(preflightCreatePrefab({ ...base, scene: SCENE, sourceEntityId: 'group-0001', existingPrefabIds: many })).toMatchObject({
      ok: false,
      error: { code: 'limits_exceeded', limit: 'prefabs', current: 128, max: 128 },
    });
  });
});

describe('packet 28 — instantiation accepts only the three configurables (§8.7)', () => {
  it('plans the accepted fixture I1 command byte-shape (root transform + one override)', () => {
    const plan = planInstantiatePrefab({
      ...BASE_INSTANTIATE,
      transform: { position: [12, 0, 0] },
      overrides: [{ localId: 'model-0001', key: 'speed', value: 9.75 }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.command.args).toEqual({
      prefabId: 'prefab-0001',
      parentId: null,
      transform: { position: [12, 0, 0] },
      overrides: [{ localId: 'model-0001', key: 'speed', value: 9.75 }],
    });
  });

  it('plans a plain copy with no optional fields', () => {
    const plan = planInstantiatePrefab({ ...BASE_INSTANTIATE, parentId: undefined, sceneEntityCount: 6 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.command.args).toEqual({ prefabId: 'prefab-0001' });
  });

  it('rejects unknown definitions, unresolved parents, an invalid transform and >64 overrides', () => {
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, definition: null })).toMatchObject({ ok: false, error: { code: 'prefab_not_found' } });
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, parentId: 'group-9999' })).toMatchObject({ ok: false, error: { code: 'reference_missing' } });
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, transform: { rotation: [0, 0, 0, 0] } })).toMatchObject({
      ok: false,
      error: { code: 'quaternion_invalid' },
    });
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, transform: { scale: [0, 1, 1] } })).toMatchObject({
      ok: false,
      error: { code: 'field_value' },
    });
    const many = Array.from({ length: 65 }, () => ({ localId: 'model-0001', key: 'speed', value: 1 }));
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: many })).toMatchObject({
      ok: false,
      error: { code: 'limits_exceeded', limit: 'overrides', current: 65, max: 64 },
    });
  });

  it('type-checks every override against the declared property', () => {
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'nope', key: 'speed', value: 1 }] })).toMatchObject({
      ok: false,
      error: { code: 'prefab_local_unknown' },
    });
    // `model-0002` has no behavior component ⇒ no declared properties to override.
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'model-0002', key: 'speed', value: 1 }] })).toMatchObject({
      ok: false,
      error: { code: 'property_unknown' },
    });
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'model-0001', key: 'nope', value: 1 }] })).toMatchObject({
      ok: false,
      error: { code: 'property_unknown' },
    });
    expect(
      planInstantiatePrefab({
        ...BASE_INSTANTIATE,
        overrides: [
          { localId: 'model-0001', key: 'speed', value: 1 },
          { localId: 'model-0001', key: 'speed', value: 2 },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'field_value' } });
  });

  it('rejects invalid values and unresolved references (the unsupported-override cases)', () => {
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'model-0001', key: 'speed', value: 'fast' }] })).toMatchObject({
      ok: false,
      error: { code: 'property_type' },
    });
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'model-0001', key: 'speed', value: 99999 }] })).toMatchObject({
      ok: false,
      error: { code: 'property_value' },
    });
    // entityRef: a definition localId is legal (remapped), an existing scene
    // entity is legal, anything else is reference_missing.
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'model-0001', key: 'target', value: 'box-0001' }] }).ok).toBe(true);
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'model-0001', key: 'target', value: 'group-0000' }] }).ok).toBe(true);
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'model-0001', key: 'target', value: 'group-0009' }] })).toMatchObject({
      ok: false,
      error: { code: 'reference_missing' },
    });
    expect(planInstantiatePrefab({ ...BASE_INSTANTIATE, overrides: [{ localId: 'model-0001', key: 'material', value: 'asset-0000000000000000' }] })).toMatchObject({
      ok: false,
      error: { code: 'asset_reference_missing' },
    });
  });

  it('enforces the atomic entities/depth limits', () => {
    const limited = planInstantiatePrefab({ ...BASE_INSTANTIATE, sceneEntityCount: 1023 });
    expect(limited).toMatchObject({ ok: false, error: { code: 'limits_exceeded', limit: 'entities', current: 1027, max: 1024 } });
    const deep = planInstantiatePrefab({ ...BASE_INSTANTIATE, parentDepth: 31 });
    expect(deep).toMatchObject({ ok: false, error: { code: 'limits_exceeded', limit: 'depth', current: 33, max: 32 } });
  });
});

describe('packet 28 — initial-override drafts come only from published declarations', () => {
  const targets = deriveOverrideTargets(DEFINITION, DECLARATIONS);

  it('derives one target for the behavior-carrying definition entity', () => {
    expect(targets.map((t) => t.localId)).toEqual(['model-0001']);
    expect(targets[0]!.controls.map((c) => c.key)).toEqual(['speed', 'target', 'material']);
  });

  it('collects typed overrides from the draft map and rejects an undeclared edit', () => {
    const drafts = new Map([
      [overrideDraftKey('model-0001', 'speed'), '9.75'],
      [overrideDraftKey('model-0001', 'target'), ''],
    ]);
    const collected = collectOverrides(targets, drafts, { entityIds: ['group-0000'], assetIds: ASSETS });
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.overrides).toEqual([
      { localId: 'model-0001', key: 'speed', value: 9.75 },
      { localId: 'model-0001', key: 'target', value: null },
    ]);
    expect(collectOverrides(targets, new Map([[overrideDraftKey('model-0001', 'nope'), '1']]))).toMatchObject({
      ok: false,
      error: { code: 'property_unknown' },
    });
    expect(collectOverrides(targets, new Map([[overrideDraftKey('model-0002', 'speed'), '1']]))).toMatchObject({
      ok: false,
      error: { code: 'prefab_local_unknown' },
    });
  });
});

describe('packet 28 — client recovery for stale revisions and rejected limits', () => {
  it('re-issues once for a stale revision, then surfaces', () => {
    const first = recoverPrefabCommandFailure({ code: 'revision_conflict', currentRevision: 12 }, { reissues: 0 });
    expect(first.kind).toBe('reissue');
    expect(first.message).toContain('fresh requestId');
    const second = recoverPrefabCommandFailure({ code: 'revision_conflict', currentRevision: 13 }, { reissues: 1 });
    expect(second.kind).toBe('surface');
    expect(second.message).toContain('retry manually');
  });

  it('surfaces a backend-rejected instance limit with its exact bound', () => {
    const recovery = recoverPrefabCommandFailure({ code: 'limits_exceeded', limit: 'entities', current: 1030, max: 1024 }, { reissues: 0 });
    expect(recovery.kind).toBe('surface');
    expect(recovery.reason).toBe('limits_exceeded');
    expect(recovery.message).toContain('"entities"');
    expect(recovery.message).toContain('current 1030');
    expect(recovery.message).toContain('max 1024');
  });

  it('surfaces any other command failure unchanged', () => {
    expect(recoverPrefabCommandFailure({ code: 'property_type', message: 'bad' }, { reissues: 0 })).toEqual({
      kind: 'surface',
      reason: 'property_type',
      message: 'bad',
    });
  });
});

describe('packet 28 — capture drafts', () => {
  it('generates an id-syntax prefabId, avoiding existing ids', () => {
    const id = makePrefabId(() => 0.5);
    expect(id).toMatch(/^prefab-[0-9a-f]{16}$/);
    const draft = newPrefabDraft({ id: 'group-0001', name: 'Station' }, [makePrefabId(() => 0.5)]);
    expect(draft.displayName).toBe('Station');
    expect(draft.prefabId).not.toBe(makePrefabId(() => 0.5));
  });

  it('falls back to a safe display name for an empty/nameless selection', () => {
    expect(newPrefabDraft(null, []).displayName).toBe('Prefab');
    expect(newPrefabDraft({ id: 'group-1', name: '   ' }, []).displayName).toBe('Prefab');
  });
});
