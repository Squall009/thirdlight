/**
 * Packet 21 — pure content and property commands (commands.md §8.5–§8.12).
 *
 * The strongest evidence is replaying packet 16's accepted command fixtures:
 * the scenario's M1 (`publishBehavior` declaration-create) and M2
 * (`setBehaviorProperties` attach) request/result pairs are asserted
 * byte-for-byte against the committed `prefab-scenario.messages.json`, and the
 * non-prefab atomic-rejection cases of `prefab-failures.json` are replayed
 * against the base / after-M2 states and asserted against the committed error
 * payloads. Because packet 21 does not implement prefab ops, only the states
 * reachable without one (`base`, `r4-after-M2`) are replayed here.
 *
 * The remaining tests cover the op surface itself: change/inverse data, one
 * revision + one history entry per success, undo/redo round-trips, redo
 * invalidation, no-change, stale-before-validation ordering, the declaration
 * replacement rules and the bounded content queries (against the after
 * envelope's catalog).
 *
 * Phase 9.3 (v1/v2 scene model removed): ported from `m2-*.test.ts` (archived
 * under archive/removed-v1-v2/commands/). Every state is a v4 project scene:
 * the M2 fixture envelopes are lifted in memory by `m2EnvelopeV4` (scene
 * relabelled schemaVersion 4, content given the v4 scene index), and the
 * recorded M2 results are asserted against the v4 engine; where v4 differs
 * the difference is stated at the assertion.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, contentCounts, createCommandState, queryAssets, queryBehaviors } from './index';
import type { CommandState, MutationSuccess } from './index';
import { m2EnvelopeV4, m2FixtureJson } from './test-fixtures';

interface ScenarioStep {
  stepId: string;
  in: Record<string, unknown>;
  out: Record<string, unknown>;
}

interface FailureStep {
  in: Record<string, unknown>;
  out: Record<string, unknown>;
}

interface FailureCase {
  caseId: string;
  state: string;
  steps: FailureStep[];
  expect: { codes: string[]; durableStateUnchanged: boolean };
}

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const AFTER = m2EnvelopeV4('contracts/commands/prefab-scenario.after.json');
const STEPS = m2FixtureJson<{ steps: ScenarioStep[] }>(
  'contracts/commands/prefab-scenario.messages.json',
).steps;
const FAILURES = m2FixtureJson<{ cases: FailureCase[] }>(
  'contracts/commands/prefab-failures.json',
).cases;

const M1 = STEPS.find((s) => s.stepId === 'M1') as ScenarioStep;
const M2 = STEPS.find((s) => s.stepId === 'M2') as ScenarioStep;

/** A fresh command state from the committed before envelope (revision 2). */
function baseState(): CommandState<SceneV4> {
  return createCommandState(BEFORE.scene, BEFORE.content);
}

function stateAfterM1(): CommandState<SceneV4> {
  const r1 = applyMutation(baseState(), M1.in);
  if (!r1.ok) throw new Error('M1 fixture failed to apply');
  return r1.state as CommandState<SceneV4>;
}

function stateAfterM2(): CommandState<SceneV4> {
  const r1 = applyMutation(baseState(), M1.in);
  if (!r1.ok) throw new Error('M1 fixture failed to apply');
  const r2 = applyMutation(r1.state, M2.in);
  if (!r2.ok) throw new Error('M2 fixture failed to apply');
  return r2.state;
}

/** A state built from the committed after envelope (revision 11). */
function afterState(): CommandState<SceneV4> {
  return createCommandState(AFTER.scene, AFTER.content);
}

/** A fresh syntactically valid requestId. */
let counter = 0;
function rid(): string {
  counter += 1;
  return `req-${BigInt(counter).toString(16).padStart(32, '0')}`;
}

function mutation(
  state: CommandState<SceneV4>,
  op: string,
  args: unknown,
  expectedRevision = state.scene.revision,
): ReturnType<typeof applyMutation> {
  return applyMutation(state, {
    op,
    projectId: 'demo-0003',
    expectedRevision,
    requestId: rid(),
    origin: { kind: 'mcp', clientId: 'pi-harness' },
    args,
  });
}

function ok(r: ReturnType<typeof applyMutation>): { state: CommandState<SceneV4>; result: MutationSuccess } {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.result)}`);
  return { state: r.state as CommandState<SceneV4>, result: r.result };
}

function failCode(r: ReturnType<typeof applyMutation>): string {
  if (r.ok) throw new Error('expected failure');
  return r.result.error.code;
}

function failError(r: ReturnType<typeof applyMutation>): Record<string, unknown> {
  if (r.ok) throw new Error('expected failure');
  return r.result.error as unknown as Record<string, unknown>;
}

/** A syntactically valid 64-hex digest. */
const DIGEST = 'a'.repeat(64);

// ---- accepted fixture replay -------------------------------------------------------

describe('packet-16 accepted fixture replay (non-prefab steps)', () => {
  it('M1 publishBehavior declaration-create matches the committed result byte-for-byte', () => {
    const r = applyMutation(baseState(), M1.in);
    expect(r.ok).toBe(true);
    expect(r.result).toEqual(M1.out);
  });

  it('M2 setBehaviorProperties attach matches the committed result byte-for-byte', () => {
    const r1 = applyMutation(baseState(), M1.in);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = applyMutation(r1.state, M2.in);
    expect(r2.ok).toBe(true);
    expect(r2.result).toEqual(M2.out);
    // The applied content is exactly the fixture's behavior record, and the
    // scene component carries the declaration-filled values in order.
    const entity = r2.ok
      ? (r2.state.scene.entities.find((e) => e.id === 'model-0001') as SceneV4['entities'][number])
      : undefined;
    expect(entity?.components.behavior?.values).toEqual(
      (M2.out as unknown as { change: { next: { values: unknown } } }).change.next.values,
    );
  });

  it('replays every non-prefab atomic-rejection case against its reachable state', () => {
    const reachable = new Set(['base', 'r3-after-M1', 'r4-after-M2']);
    let replayed = 0;
    for (const c of FAILURES) {
      if (!reachable.has(c.state)) continue;
      if (c.steps.length !== 1) continue;
      const step = c.steps[0] as FailureStep;
      const op = step.in['op'] as string;
      if (op === 'createPrefab' || op === 'instantiatePrefab' || op === 'queryPrefabs') continue;
      const state =
        c.state === 'base'
          ? baseState()
          : c.state === 'r3-after-M1'
            ? stateAfterM1()
            : stateAfterM2();
      const r = applyMutation(state, step.in);
      expect(r.ok, `${c.caseId} must fail`).toBe(false);
      expect(r.ok ? undefined : r.result.error.code, c.caseId).toBe(c.expect.codes[0]);
      expect(r.result, c.caseId).toEqual(step.out);
      replayed += 1;
    }
    expect(replayed).toBe(11); // F10–F20 (F16/F17 need r3; F21/F22 need prefab states)
  });
});

// ---- publishAsset ------------------------------------------------------------------

// v3/v4 publishAsset names the asset kind (commands.md §3.1.1); the M2 args had none.
const ASSET_ARGS = {
  mode: 'create',
  kind: 'model',
  assetId: 'asset-0123456789abcdef',
  displayName: 'Crate',
  sourceDigest: DIGEST,
  sourceByteLength: 26,
  importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
  metrics: {
    nodes: 4,
    meshes: 1,
    primitives: 2,
    materials: 2,
    images: 1,
    textures: 1,
    vertices: 96,
    triangles: 48,
    animations: 1,
    animationChannels: 3,
    clipDurationMs: 1000,
    decodedGeometryBytes: 4096,
    decodedImageBytes: 2048,
  },
  importedAt: '2026-09-18T10:00:00Z',
};

describe('publishAsset (commands.md §8.5)', () => {
  it('create consumes exactly one revision/history entry with a correct inverse', () => {
    const before = baseState();
    const { state, result } = ok(mutation(before, 'publishAsset', ASSET_ARGS));
    expect(result.revision).toBe(before.scene.revision + 1);
    expect(result.history).toEqual({ undoDepth: 1, redoDepth: 0 });
    const change = result.change as unknown as { type: string; previous: unknown; next: { currentVersion: number; versions: unknown[] } };
    expect(change.type).toBe('publishAsset');
    expect(change.previous).toBeNull();
    expect(change.next.currentVersion).toBe(1);
    expect(change.next.versions).toHaveLength(1);
    expect(state.content?.assets.map((a) => a.assetId)).toContain(ASSET_ARGS.assetId);

    const undone = ok(mutation(state, 'undo', {}));
    expect(undone.state.content?.assets).toEqual(before.content?.assets);
    // The undo change is in the applied direction: a create is removed.
    const undoChange = undone.result.change as unknown as { mode: string; previous: unknown; next: unknown };
    expect(undoChange.mode).toBe('create');
    expect(undoChange.next).toBeNull();
    expect(undoChange.previous).toEqual(change.next);
    const redone = ok(mutation(undone.state, 'redo', {}));
    expect(redone.state.content?.assets).toEqual(state.content?.assets);
    expect((redone.result.change as unknown as { mode: string }).mode).toBe('create');
  });

  it('reimport appends one immutable version and restores the previous record on undo', () => {
    const created = ok(mutation(baseState(), 'publishAsset', ASSET_ARGS));
    const reimportArgs = { ...ASSET_ARGS, mode: 'reimport', sourceDigest: 'b'.repeat(64), sourceByteLength: 30 };
    const r2 = ok(mutation(created.state, 'publishAsset', reimportArgs));
    const next = (r2.result.change as unknown as { next: { currentVersion: number; versions: { version: number }[] } }).next;
    expect(next.currentVersion).toBe(2);
    expect(next.versions.map((v) => v.version)).toEqual([1, 2]);
    const undone = ok(mutation(r2.state, 'undo', {}));
    const record = undone.state.content?.assets.find((a) => a.assetId === ASSET_ARGS.assetId);
    expect(record?.currentVersion).toBe(1);
    expect(record?.versions).toHaveLength(1);
  });

  it('create on an existing id and reimport on an unknown one fail without touching state', () => {
    const created = ok(mutation(baseState(), 'publishAsset', ASSET_ARGS));
    const before = JSON.stringify(created.state);
    expect(failCode(mutation(created.state, 'publishAsset', ASSET_ARGS))).toBe('asset_id_duplicate');
    expect(failCode(mutation(baseState(), 'publishAsset', { ...ASSET_ARGS, mode: 'reimport' }))).toBe(
      'asset_not_found',
    );
    expect(JSON.stringify(created.state)).toBe(before);
  });

  it('rejects a malformed digest, byte length and request shape before any mutation', () => {
    expect(failCode(mutation(baseState(), 'publishAsset', { ...ASSET_ARGS, sourceDigest: 'nope' }))).toBe(
      'digest_invalid',
    );
    expect(failCode(mutation(baseState(), 'publishAsset', { ...ASSET_ARGS, mode: 'bad' }))).toBe('field_value');
    expect(
      failCode(mutation(baseState(), 'publishAsset', { ...ASSET_ARGS, importedAt: undefined })),
    ).toBe('field_missing');
    expect(
      failCode(mutation(baseState(), 'publishAsset', { ...ASSET_ARGS, unexpected: 1 })),
    ).toBe('field_unexpected');
  });
});

// ---- publishBehavior ---------------------------------------------------------------

const DECLARATION = {
  properties: [
    { key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 },
    { key: 'visible', label: 'Visible', type: 'boolean', default: true },
  ],
};
const NEW_BEHAVIOR = {
  behaviorId: 'behavior-0002',
  displayName: 'Second',
  mode: 'declaration-create',
  declaration: DECLARATION,
};

describe('publishBehavior (commands.md §8.8)', () => {
  it('declaration-create/update consume one revision and restore the previous record on undo', () => {
    const created = ok(mutation(baseState(), 'publishBehavior', NEW_BEHAVIOR));
    const record = created.state.content?.behaviors.find((b) => b.behaviorId === 'behavior-0002');
    expect(record?.source).toBeNull();
    expect(record?.publishedRevision).toBe(3);
    const updated = ok(
      mutation(created.state, 'publishBehavior', {
        ...NEW_BEHAVIOR,
        mode: 'declaration-update',
        displayName: 'Second v2',
      }),
    );
    expect(
      updated.state.content?.behaviors.find((b) => b.behaviorId === 'behavior-0002')?.displayName,
    ).toBe('Second v2');
    const undone = ok(mutation(updated.state, 'undo', {}));
    expect(
      undone.state.content?.behaviors.find((b) => b.behaviorId === 'behavior-0002')?.displayName,
    ).toBe('Second');
    const undoneAgain = ok(mutation(undone.state, 'undo', {}));
    expect(undoneAgain.state.content?.behaviors.some((b) => b.behaviorId === 'behavior-0002')).toBe(false);
  });

  it('source mode is unavailable before any existence or declaration validation', () => {
    const r = mutation(baseState(), 'publishBehavior', {
      behaviorId: 'behavior-9999',
      displayName: 'x',
      mode: 'source',
      declaration: { properties: [] },
      source: { sourceDigest: DIGEST, sourceByteLength: 1 },
    });
    expect(failError(r)).toMatchObject({
      code: 'behavior_publication_unavailable',
      cls: 'unavailable',
      reason: 'preparer_unavailable',
    });
  });

  it('validates declaration data and bounds with the contract codes', () => {
    expect(
      failCode(mutation(baseState(), 'publishBehavior', { ...NEW_BEHAVIOR, declaration: { properties: [] } })),
    ).toBe('field_value');
    const badDefault = {
      ...NEW_BEHAVIOR,
      declaration: { properties: [{ key: 'n', label: 'N', type: 'number', default: 5, min: 0, max: 1 }] },
    };
    expect(failCode(mutation(baseState(), 'publishBehavior', badDefault))).toBe('property_value');
    const dupKey = {
      ...NEW_BEHAVIOR,
      declaration: {
        properties: [DECLARATION.properties[0], DECLARATION.properties[0]],
      },
    };
    expect(failCode(mutation(baseState(), 'publishBehavior', dupKey))).toBe('property_value');
    const tooMany = {
      ...NEW_BEHAVIOR,
      declaration: {
        properties: Array.from({ length: 33 }, (_, i) => ({
          key: `k${i}`,
          label: `K${i}`,
          type: 'number',
          default: 0,
        })),
      },
    };
    expect(failCode(mutation(baseState(), 'publishBehavior', tooMany))).toBe('limits_exceeded');
  });
});

// ---- setBehaviorProperties ---------------------------------------------------------

describe('setBehaviorProperties (commands.md §8.9)', () => {
  it('updates one key, records changedKeys in declaration order and is self-inverse', () => {
    const state = stateAfterM2();
    const r = ok(
      mutation(state, 'setBehaviorProperties', {
        entityId: 'model-0001',
        behaviorId: 'behavior-0001',
        values: { visible: false },
      }),
    );
    const change = r.result.change as unknown as { previous: unknown; next: unknown; changedKeys: string[] };
    expect(change.changedKeys).toEqual(['visible']);
    const undone = ok(mutation(r.state, 'undo', {}));
    expect((undone.result.change as unknown as { changedKeys: string[] }).changedKeys).toEqual(['visible']);
    const comp = undone.state.scene.entities.find((e) => e.id === 'model-0001')?.components.behavior;
    expect(comp?.values['visible']).toBe(true);
    const redone = ok(mutation(undone.state, 'redo', {}));
    expect(
      redone.state.scene.entities.find((e) => e.id === 'model-0001')?.components.behavior?.values['visible'],
    ).toBe(false);
  });

  it('removes the component with behaviorId null and undo restores it', () => {
    const state = stateAfterM2();
    const removed = ok(mutation(state, 'setBehaviorProperties', { entityId: 'model-0001', behaviorId: null }));
    expect(
      removed.state.scene.entities.find((e) => e.id === 'model-0001')?.components.behavior,
    ).toBeUndefined();
    const undoChange = removed.result.change as unknown as { previous: unknown; next: unknown; changedKeys: string[] };
    expect(undoChange.next).toBeNull();
    expect(undoChange.changedKeys).toEqual([
      'speed',
      'label',
      'visible',
      'offset',
      'target',
      'material',
    ]);
    const undone = ok(mutation(removed.state, 'undo', {}));
    expect(
      undone.state.scene.entities.find((e) => e.id === 'model-0001')?.components.behavior?.behaviorId,
    ).toBe('behavior-0001');
    expect((undone.result.change as unknown as { next: unknown }).next).not.toBeNull();
  });

  it('no-change on an identical write and argument errors leave the state untouched', () => {
    const state = stateAfterM2();
    const before = JSON.stringify(state);
    expect(
      failCode(
        mutation(state, 'setBehaviorProperties', {
          entityId: 'model-0001',
          behaviorId: 'behavior-0001',
          values: { speed: 4.5 },
        }),
      ),
    ).toBe('no_change');
    expect(
      failCode(mutation(state, 'setBehaviorProperties', { entityId: 'nope', behaviorId: null })),
    ).toBe('entity_not_found');
    expect(
      failCode(
        mutation(state, 'setBehaviorProperties', { entityId: 'model-0001', behaviorId: null, values: { a: 1 } }),
      ),
    ).toBe('field_value');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('rejects the camera and resolves entity/asset references', () => {
    const state = stateAfterM2();
    expect(
      failCode(
        mutation(state, 'setBehaviorProperties', { entityId: 'cam-main', behaviorId: 'behavior-0001' }),
      ),
    ).toBe('field_value');
    expect(
      failCode(
        mutation(state, 'setBehaviorProperties', {
          entityId: 'model-0001',
          behaviorId: 'behavior-0001',
          values: { target: 'group-0099' },
        }),
      ),
    ).toBe('reference_missing');
    expect(
      failCode(
        mutation(state, 'setBehaviorProperties', {
          entityId: 'model-0001',
          behaviorId: 'behavior-0001',
          values: { material: 'asset-0000000000000000' },
        }),
      ),
    ).toBe('asset_reference_missing');
  });

  it('deleteEntity rejects a subtree referenced from outside (§8.3 step 2b)', () => {
    const state = stateAfterM2();
    // An outside entity holds an entityRef value naming an entity inside the
    // group-0001 subtree. Create a second root, attach the behavior there and
    // point it at group-0001.
    const created = ok(mutation(state, 'createEntity', { kind: 'group' }));
    const rootId = created.result.createdId as string;
    const referencing = ok(
      mutation(created.state, 'setBehaviorProperties', {
        entityId: rootId,
        behaviorId: 'behavior-0001',
        values: { target: 'group-0001' },
      }),
    );
    const r = mutation(referencing.state, 'deleteEntity', { entityId: 'group-0001' });
    expect(failError(r)).toMatchObject({
      code: 'reference_in_use',
      entityIds: ['group-0001', 'box-0001', 'model-0001', 'model-0002'],
      referencingEntityIds: [rootId],
    });

    // A value from INSIDE the closure is fine (both disappear).
    const inside = ok(
      mutation(state, 'setBehaviorProperties', {
        entityId: 'model-0001',
        behaviorId: 'behavior-0001',
        values: { target: 'box-0001' },
      }),
    );
    const okDelete = mutation(inside.state, 'deleteEntity', { entityId: 'group-0001' });
    expect(okDelete.ok).toBe(true);
  });
});

// ---- setComponent ------------------------------------------------------------------

describe('setComponent (commands.md §8.10)', () => {
  it('edits a box field, carries changedFields and is self-inverse', () => {
    const state = baseState();
    const r = ok(
      mutation(state, 'setComponent', {
        entityId: 'box-0001',
        component: 'box',
        value: { material: { color: '#C05050' } },
      }),
    );
    const change = r.result.change as unknown as { previous: unknown; next: { material: { color: string } }; changedFields: string[] };
    expect(change.changedFields).toEqual(['material']);
    expect(change.next.material.color).toBe('#c05050'); // canonical lowercase
    const undone = ok(mutation(r.state, 'undo', {}));
    expect(
      (undone.state.scene.entities.find((e) => e.id === 'box-0001')?.components.box as { material: { color: string } })
        .material.color,
    ).toBe('#b0b0b0');
    const redone = ok(mutation(undone.state, 'redo', {}));
    expect(
      (redone.state.scene.entities.find((e) => e.id === 'box-0001')?.components.box as { material: { color: string } })
        .material.color,
    ).toBe('#c05050');
  });

  it('rejects unowned/unknown components, unknown fields, missing components and no-change', () => {
    const state = baseState();
    expect(
      failError(mutation(state, 'setComponent', { entityId: 'box-0001', component: 'transform', value: { position: [1, 0, 0] } }))
        .code,
    ).toBe('field_value');
    expect(
      failCode(mutation(state, 'setComponent', { entityId: 'box-0001', component: 'box', value: { colour: '#fff000' } })),
    ).toBe('field_unexpected');
    expect(
      failCode(mutation(state, 'setComponent', { entityId: 'group-0001', component: 'box', value: { size: [1, 1, 1] } })),
    ).toBe('component_missing');
    // A present field replaces the whole field; the same canonical value is a
    // no-change (uppercase hex canonicalizes to the same lowercase value).
    expect(
      failCode(
        mutation(state, 'setComponent', {
          entityId: 'box-0001',
          component: 'box',
          value: { material: { color: '#B0B0B0' } },
        }),
      ),
    ).toBe('no_change');
  });

  it('phase 14.0: sets, validates, clears and undoes the controller capsule', () => {
    const added = ok(mutation(baseState(), 'setComponent', { entityId: 'group-0000', component: 'controller', value: {} }));
    const controllerOf = (s: CommandState<SceneV4>) => (s.scene.entities.find((e) => e.id === 'group-0000')?.components as { controller?: unknown }).controller;
    expect(controllerOf(added.state)).toEqual({});
    const capsule = { radius: 0.25, height: 1, offset: [0, -0.4] };
    const set = ok(mutation(added.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { capsule } }));
    expect(controllerOf(set.state)).toEqual({ capsule });
    const change = set.result.change as unknown as { previous: unknown; next: unknown; changedFields: string[] };
    expect(change).toMatchObject({ previous: {}, next: { capsule }, changedFields: ['capsule'] });
    // The model's ranges hold (a height under two radii, an unknown field).
    expect(failCode(mutation(set.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { capsule: { radius: 0.5, height: 0.6 } } }))).toBe('field_value');
    expect(failCode(mutation(set.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { speed: 2 } }))).toBe('field_unexpected');
    expect(failCode(mutation(set.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { capsule: 'small' } }))).toBe('field_type');
    expect(failCode(mutation(set.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { capsule } }))).toBe('no_change');
    // One undo restores the default (no capsule); redo brings it back.
    const undone = ok(mutation(set.state, 'undo', {}));
    expect(controllerOf(undone.state)).toEqual({});
    const redone = ok(mutation(undone.state, 'redo', {}));
    expect(controllerOf(redone.state)).toEqual({ capsule });
    // null goes back to the default capsule.
    const cleared = ok(mutation(redone.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { capsule: null } }));
    expect(controllerOf(cleared.state)).toEqual({});
  });

  it('phase 15.3: controller tuning is set, validated, reset with null and undone; engine settings are validated', () => {
    const added = ok(mutation(baseState(), 'setComponent', { entityId: 'group-0000', component: 'controller', value: {} }));
    const controllerOf = (s: CommandState<SceneV4>) => (s.scene.entities.find((e) => e.id === 'group-0000')?.components as { controller?: unknown }).controller;
    const set = ok(mutation(added.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { jumpRelease: 1, coyoteTime: 0.1, autostep: true } }));
    expect(JSON.stringify(controllerOf(set.state))).toBe('{"coyoteTime":0.1,"jumpRelease":1,"autostep":true}');
    expect((set.result.change as unknown as { changedFields: string[] }).changedFields).toEqual(['coyoteTime', 'jumpRelease', 'autostep']);
    expect(failCode(mutation(set.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { skin: 0.5 } }))).toBe('field_value');
    const reset = ok(mutation(set.state, 'setComponent', { entityId: 'group-0000', component: 'controller', value: { jumpRelease: null } }));
    expect(controllerOf(reset.state)).toEqual({ coyoteTime: 0.1, autostep: true });
    expect(controllerOf(ok(mutation(reset.state, 'undo', {})).state)).toEqual({ coyoteTime: 0.1, jumpRelease: 1, autostep: true });
    // engine settings: a choice of step rates, whole voice counts
    const hz = ok(mutation(baseState(), 'setSettings', { settings: { fixed_step_hz: 240 } }));
    expect((hz.state.content as unknown as { settings: Record<string, number> }).settings['fixed_step_hz']).toBe(240);
    expect(failCode(mutation(baseState(), 'setSettings', { settings: { fixed_step_hz: 100 } }))).toBe('field_value');
    expect(failCode(mutation(baseState(), 'setSettings', { settings: { audio_voices: 2.5 } }))).toBe('field_value');
  });

  it('phase 14.2: a trigger turns into a circle (radius) with stay mode in one edit, validated, undone in one step', () => {
    const triggerOf = (s: CommandState<SceneV4>) => (s.scene.entities.find((e) => e.id === 'group-0000')?.components as { trigger?: unknown }).trigger;
    const added = ok(mutation(baseState(), 'setComponent', { entityId: 'group-0000', component: 'trigger', value: { size: [2, 2], signal: 'go' } }));
    expect(triggerOf(added.state)).toEqual({ size: [2, 2], signal: 'go' });
    const circle = ok(mutation(added.state, 'setComponent', { entityId: 'group-0000', component: 'trigger', value: { shape: 'circle', radius: 1.5, size: null, mode: 'stay' } }));
    expect(JSON.stringify(triggerOf(circle.state))).toBe('{"signal":"go","shape":"circle","radius":1.5,"mode":"stay"}');
    expect((circle.result.change as unknown as { changedFields: string[] }).changedFields).toEqual(['size', 'shape', 'radius', 'mode']);
    // A circle keeps no size; a box has no radius; unknown modes are refused.
    expect(failCode(mutation(circle.state, 'setComponent', { entityId: 'group-0000', component: 'trigger', value: { size: [1, 1] } }))).toBe('field_unexpected');
    expect(failCode(mutation(circle.state, 'setComponent', { entityId: 'group-0000', component: 'trigger', value: { shape: 'box' } }))).toBe('field_missing');
    expect(failCode(mutation(circle.state, 'setComponent', { entityId: 'group-0000', component: 'trigger', value: { mode: 'always' } }))).toBe('field_value');
    const undone = ok(mutation(circle.state, 'undo', {}));
    expect(triggerOf(undone.state)).toEqual({ size: [2, 2], signal: 'go' });
    const back = ok(mutation(circle.state, 'setComponent', { entityId: 'group-0000', component: 'trigger', value: { shape: null, radius: null, size: [3, 3], mode: null } }));
    expect(triggerOf(back.state)).toEqual({ size: [3, 3], signal: 'go' });
  });

  it('edits camera fields and rejects a model asset that does not resolve', () => {
    const state = baseState();
    const r = ok(mutation(state, 'setComponent', { entityId: 'cam-main', component: 'camera', value: { fovY: 45 } }));
    expect((r.result.change as unknown as { changedFields: string[] }).changedFields).toEqual(['fovY']);
    expect(failCode(mutation(state, 'setComponent', {
      entityId: 'model-0001',
      component: 'model',
      value: { asset: { assetId: 'asset-0000000000000000' } },
    }))).toBe('asset_reference_missing');
  });
});

// ---- setSettings -------------------------------------------------------------------

describe('setSettings (commands.md §8.11)', () => {
  it('applies a partial typed map with ascending changedKeys and self-inverse', () => {
    const state = baseState();
    const r = ok(mutation(state, 'setSettings', { settings: { run_speed: 6, jump_velocity: 8 } }));
    const change = r.result.change as unknown as { previous: Record<string, unknown>; next: Record<string, unknown>; changedKeys: string[] };
    expect(change.changedKeys).toEqual(['jump_velocity', 'run_speed']);
    expect(change.previous).toEqual({});
    expect(change.next['run_speed']).toBe(6);
    const undone = ok(mutation(r.state, 'undo', {}));
    expect(undone.state.content?.settings).toEqual({});
    const redone = ok(mutation(undone.state, 'redo', {}));
    expect(redone.state.content?.settings['jump_velocity']).toBe(8);
  });

  it('rejects unknown keys, out-of-range values, empty maps and the cross-key violation', () => {
    const state = baseState();
    expect(failError(mutation(state, 'setSettings', { settings: { gravity: 9.8 } })).code).toBe('setting_unknown');
    expect(failError(mutation(state, 'setSettings', { settings: { run_speed: 0 } })).code).toBe('field_value');
    expect(failCode(mutation(state, 'setSettings', { settings: {} }))).toBe('field_value');
    expect(
      failCode(mutation(state, 'setSettings', { settings: { max_slope_climb_deg: 25, min_slope_slide_deg: 30 } })),
    ).toBe('field_value');
    // Equal thresholds are legal (physics fixture S10).
    const equal = ok(
      mutation(state, 'setSettings', { settings: { max_slope_climb_deg: 30, min_slope_slide_deg: 30 } }),
    );
    expect(equal.state.content?.settings['max_slope_climb_deg']).toBe(30);
  });

  it('no-change on an identical write', () => {
    const state = ok(mutation(baseState(), 'setSettings', { settings: { run_speed: 6 } })).state;
    expect(failCode(mutation(state, 'setSettings', { settings: { run_speed: 6 } }))).toBe('no_change');
  });
});

// ---- acknowledgeBehaviorTrust ------------------------------------------------------

describe('acknowledgeBehaviorTrust (commands.md §8.12)', () => {
  it('appends one entry with the result revision, is no-change when present and undo removes it', () => {
    const state = baseState();
    const r = ok(mutation(state, 'acknowledgeBehaviorTrust', { sourceDigest: DIGEST }));
    const change = r.result.change as { previous: unknown[]; next: { sourceDigest: string; acknowledgedRevision: number }[] };
    expect(change.previous).toEqual([]);
    expect(change.next).toEqual([{ sourceDigest: DIGEST, acknowledgedRevision: r.result.revision }]);
    expect(failCode(mutation(r.state, 'acknowledgeBehaviorTrust', { sourceDigest: DIGEST }))).toBe('no_change');
    const undone = ok(mutation(r.state, 'undo', {}));
    expect(undone.state.content?.behaviorTrust.entries).toEqual([]);
    expect(failCode(mutation(state, 'acknowledgeBehaviorTrust', { sourceDigest: 'zz' }))).toBe('digest_invalid');
  });
});

// ---- ordering, revision and history rules ------------------------------------------

describe('ordering, revision and history rules (commands.md §6.1/§9)', () => {
  it('a stale revision is reported as stale, not validated (stale precedes argument validation)', () => {
    const state = baseState();
    const before = JSON.stringify(state);
    const r = applyMutation(state, {
      op: 'setComponent',
      projectId: 'demo-0003',
      expectedRevision: 0, // stale
      requestId: rid(),
      args: { entityId: 'nope', component: 'bogus', value: {} },
    });
    expect(failCode(r)).toBe('revision_conflict');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('a fresh edit truncates the redo tail (redo invalidation)', () => {
    const state = baseState();
    const a = ok(mutation(state, 'setSettings', { settings: { run_speed: 6 } }));
    const undone = ok(mutation(a.state, 'undo', {}));
    expect(undone.result.history).toEqual({ undoDepth: 0, redoDepth: 1 });
    const b = ok(mutation(undone.state, 'setSettings', { settings: { run_speed: 7 } }));
    expect(b.result.history).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(failCode(mutation(b.state, 'redo', {}))).toBe('history_empty');
  });

  it('mixed M1/M2 history shares one stack (undo crosses the op kinds)', () => {
    const state = baseState();
    const behavior = ok(mutation(state, 'publishBehavior', NEW_BEHAVIOR));
    const box = ok(mutation(behavior.state, 'setComponent', {
      entityId: 'box-0001',
      component: 'box',
      value: { size: [2, 2, 2] },
    }));
    expect(box.result.history).toEqual({ undoDepth: 2, redoDepth: 0 });
    const undoBox = ok(mutation(box.state, 'undo', {}));
    expect((undoBox.result.change as unknown as { type: string }).type).toBe('setComponent');
    const undoBehavior = ok(mutation(undoBox.state, 'undo', {}));
    expect((undoBehavior.result.change as unknown as { type: string }).type).toBe('publishBehavior');
    expect(undoBehavior.state.content?.behaviors.some((b) => b.behaviorId === 'behavior-0002')).toBe(false);
  });

  it('the request-byte bound is enforced before argument validation', () => {
    const state = baseState();
    const r = applyMutation(state, {
      op: 'setComponent',
      projectId: 'demo-0003',
      expectedRevision: state.scene.revision,
      requestId: rid(),
      args: { entityId: 'box-0001', component: 'box', value: { size: [1, 1, 1] }, pad: 'x'.repeat(70_000) },
    });
    expect(failError(r)).toMatchObject({ code: 'limits_exceeded', limit: 'request_bytes' });
  });
});

// ---- packet-21 fixture replay ------------------------------------------------------

describe('fixtures/m2/commands/content-ops.messages.json replay', () => {
  it('replays every step byte-for-byte and ends at the indexed revision', () => {
    const scenario = m2FixtureJson<{
      base: { state: string; revision: number };
      steps: ScenarioStep[];
    }>('commands/content-ops.messages.json');
    const index = m2FixtureJson<{
      files: { file: string; finalRevision: number; outcomes: { stepId: string; op: string }[] }[];
    }>('commands/expected.json');
    let state: CommandState<SceneV4> = baseState();
    for (const step of scenario.steps) {
      // v3/v4: publishAsset requires the asset `kind` (the M2 requests
      // predate it); the recorded results already carry `kind: "model"`.
      const request =
        step.in['op'] === 'publishAsset'
          ? { ...step.in, args: { ...(step.in['args'] as Record<string, unknown>), kind: 'model' } }
          : step.in;
      const r = applyMutation(state, request);
      expect(r.result, step.stepId).toEqual(step.out);
      if (r.ok) state = r.state as CommandState<SceneV4>;
    }
    const entry = index.files[0] as { finalRevision: number; outcomes: { stepId: string; op: string }[] };
    expect(state.scene.revision).toBe(entry.finalRevision);
    expect(entry.outcomes.map((o) => o.stepId)).toEqual(scenario.steps.map((st) => st.stepId));
    expect(entry.outcomes.map((o) => o.op)).toEqual(scenario.steps.map((st) => st.in['op']));
  });
});

// ---- content queries ---------------------------------------------------------------

describe('content queries (commands.md §5.6)', () => {
  it('queryAssets/queryBehaviors return the committed query examples', () => {
    const examples = m2FixtureJson<{ examples: Record<string, { request: unknown; result: unknown }> }>(
      'contracts/commands/queries.json',
    ).examples;
    const state = afterState();
    for (const name of ['queryAssets', 'queryBehaviors']) {
      const ex = examples[name] as { request: unknown; result: unknown };
      const op = name as 'queryAssets' | 'queryBehaviors';
      const got = op === 'queryAssets' ? queryAssets(state, ex.request) : queryBehaviors(state, ex.request);
      expect(got, name).toEqual(ex.result);
    }
    const decl = examples['queryBehaviorDeclaration'] as { request: unknown; result: unknown };
    expect(queryBehaviors(state, decl.request)).toEqual(decl.result);
  });

  it('queryProject content counts match the committed example', () => {
    const example = m2FixtureJson<{ examples: Record<string, { result: { content: unknown } }> }>(
      'contracts/commands/queries.json',
    ).examples['queryProject'] as { result: { content: unknown } };
    // v3/v4 add the audio/game/zone/spawn counts to the M2 four.
    expect(contentCounts(afterState())).toEqual({
      ...(example.result.content as Record<string, unknown>),
      audioAssets: 0,
      game: false,
      zones: 0,
      spawns: 0,
    });
  });

  it('queries are bounded, read-only and validate their args', () => {
    const state = afterState();
    const before = JSON.stringify(state);
    const page = queryAssets(state, { op: 'queryAssets', projectId: 'demo-0003', args: { limit: 1, offset: 1 } });
    expect(page.ok && page.assets).toHaveLength(1);
    expect(page.ok && page.total).toBe(2);
    expect(
      queryAssets(state, { op: 'queryAssets', projectId: 'demo-0003', args: { limit: 129 } }),
    ).toMatchObject({ ok: false, error: { code: 'field_value' } });
    expect(
      queryBehaviors(state, { op: 'queryBehaviors', projectId: 'demo-0003', args: { nope: true } }),
    ).toMatchObject({ ok: false, error: { code: 'field_unexpected' } });
    expect(
      queryAssets(state, { op: 'queryAssets', projectId: 'demo-0003', args: { assetId: 'asset-0000000000000000' } }),
    ).toMatchObject({ ok: false, error: { code: 'asset_not_found' } });
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ---- pure/inverse invariants -------------------------------------------------------

describe('invariants', () => {
  it('every successful M2 mutation consumes exactly one revision and one history entry', () => {
    let state = baseState();
    const ops: [string, unknown][] = [
      ['publishAsset', ASSET_ARGS],
      ['publishBehavior', NEW_BEHAVIOR],
      ['setComponent', { entityId: 'box-0001', component: 'box', value: { size: [3, 1, 1] } }],
      ['setSettings', { settings: { run_speed: 5 } }],
      ['acknowledgeBehaviorTrust', { sourceDigest: DIGEST }],
    ];
    let expected = state.scene.revision;
    for (const [op, args] of ops) {
      const r = ok(mutation(state, op, args));
      expected += 1;
      expect(r.result.revision, op).toBe(expected);
      expect(r.result.history.undoDepth, op).toBeGreaterThan(0);
      state = r.state;
    }
    expect(state.scene.revision).toBe(expected);
  });

  it('failed edits leave the input state byte-identical (no partial content change)', () => {
    const state = stateAfterM2();
    const before = JSON.stringify(state);
    mutation(state, 'publishBehavior', { ...NEW_BEHAVIOR, declaration: { properties: [] } });
    mutation(state, 'setComponent', { entityId: 'box-0001', component: 'camera', value: { fovY: 10 } });
    mutation(state, 'acknowledgeBehaviorTrust', { sourceDigest: 'bad' });
    expect(JSON.stringify(state)).toBe(before);
  });
});
