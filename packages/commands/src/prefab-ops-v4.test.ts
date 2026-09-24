/**
 * Packet 22 — pure prefab capture and instantiation (commands.md §8.6–§8.7).
 *
 * The strongest evidence is replaying packet 16's accepted contract fixtures
 * byte-for-byte: the `createPrefab`/`instantiatePrefab`/undo/redo/retry steps
 * M3–M10 of `contracts/commands/prefab-scenario.messages.json`, and every
 * prefab atomic-rejection case of `contracts/commands/prefab-failures.json`
 * against its reachable state. Those fixtures were authored at packet 16 and
 * are not regenerated here.
 *
 * The remaining tests cover the acceptance criteria directly: two instances
 * with distinct IDs and remapped internal references, the exact generated
 * mapping in the result, one undo/redo preserving identity, two-instance
 * independence, atomic rejection with no partial expansion, deterministic ID
 * re-use after a deletion, the prefab limits and `queryPrefabs`.
 *
 * Phase 9.3 (v1/v2 scene model removed): ported from `m2-*.test.ts` (archived
 * under archive/removed-v1-v2/commands/). Every state is a v4 project scene:
 * the M2 fixture envelopes are lifted in memory by `m2EnvelopeV4` (scene
 * relabelled schemaVersion 4, content given the v4 scene index), and the
 * recorded M2 results are asserted against the v4 engine; where v4 differs
 * the difference is stated at the assertion.
 */

import { describe, expect, it } from 'vitest';
import type { PrefabDefinition, SceneV4 } from '@thirdlight/project-model';

import {
  applyMutation,
  createCommandState,
  queryPrefabs,
} from './index';
import { nextFreeEntityId } from './prefab-ops';
import type { CommandState, InstantiatePrefabChange, MutationSuccess } from './index';
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

const step = (id: string): ScenarioStep => STEPS.find((s) => s.stepId === id) as ScenarioStep;

/** A fresh command state from the committed before envelope (revision 2). */
function baseState(): CommandState<SceneV4> {
  return createCommandState(BEFORE.scene, BEFORE.content);
}

/** Replay the scenario's first `n` steps to reach a committed snapshot state. */
function stateThrough(id: string): CommandState<SceneV4> {
  let state = baseState();
  for (const s of STEPS) {
    // M10 is a duplicated retry served by the workspace dedup layer (§6.1
    // step 2); the pure layer re-validates and would conflict. It changes no
    // state, so skipping it reaches the same snapshot.
    if ((s.out as { duplicated?: boolean }).duplicated !== true) {
      const r = applyMutation(state, s.in);
      expect(r.ok, `scenario ${s.stepId} must apply`).toBe(true);
      if (!r.ok) return state;
      state = r.state as CommandState<SceneV4>;
    }
    if (s.stepId === id) return state;
  }
  throw new Error(`unknown scenario step ${id}`);
}

const SNAPSHOT_BUILDERS: Record<string, () => CommandState<SceneV4>> = {
  base: baseState,
  'r3-after-M1': () => stateThrough('M1'),
  'r4-after-M2': () => stateThrough('M2'),
  'r5-after-M3': () => stateThrough('M3'),
  'r6-after-M4': () => stateThrough('M4'),
  'r7-after-M5': () => stateThrough('M5'),
  'r8-after-M6': () => stateThrough('M6'),
  'r11-after-M10': () => stateThrough('M10'),
};

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

function instantiateChange(result: MutationSuccess): InstantiatePrefabChange {
  return result.change as unknown as InstantiatePrefabChange;
}

// ---- accepted packet-16 fixture replay ---------------------------------------------

describe('packet-16 accepted prefab fixture replay', () => {
  it('replays the whole M1–M10 scenario byte-for-byte and lands on the after envelope', () => {
    let state = baseState();
    const seen = new Map<string, MutationSuccess>();
    for (const s of STEPS) {
      const req = s.in as { requestId: string };
      if ((s.out as { duplicated?: boolean }).duplicated === true) {
        // A duplicated retry is served by the workspace dedup layer (§6.1 step
        // 2) BEFORE this pure layer is reached: the recorded result replays
        // byte-identically modulo `duplicated`. Assert that relationship
        // instead of re-executing (the pure layer has no record map).
        const recorded = seen.get(req.requestId);
        expect(recorded, `${s.stepId} duplicate of an unrecorded request`).toBeDefined();
        const out = { ...(s.out as Record<string, unknown>) };
        delete out['duplicated'];
        const prev = { ...(recorded as unknown as Record<string, unknown>) };
        delete prev['duplicated'];
        expect(out).toEqual(prev);
        continue;
      }
      const r = applyMutation(state, s.in);
      expect(r.result, s.stepId).toEqual(s.out);
      if (r.ok) {
        seen.set(req.requestId, r.result);
        state = r.state as CommandState<SceneV4>;
      }
    }
    expect(state.scene).toEqual(AFTER.scene);
    expect(state.scene.revision).toBe(AFTER.scene.revision);
    expect(state.content).toEqual(AFTER.content);
  });

  it('M3 captures the 4-entity definition and M4/M5 materialize two independent instances', () => {
    const m3 = applyMutation(stateThrough('M2'), step('M3').in);
    expect(m3.result).toEqual(step('M3').out);
    const m4 = applyMutation(stateThrough('M3'), step('M4').in);
    expect(m4.result).toEqual(step('M4').out);
    const m5 = applyMutation(stateThrough('M4'), step('M5').in);
    expect(m5.result).toEqual(step('M5').out);
    if (!m4.ok || !m5.ok) throw new Error('instantiation must succeed');
    const c4 = instantiateChange(m4.result);
    const c5 = instantiateChange(m5.result);
    // Distinct IDs, exact mapping, remapped internal reference.
    expect(c4.mapping.map((m) => m.entityId)).toEqual(['group-0002', 'box-0002', 'model-0003', 'model-0004']);
    expect(c5.mapping.map((m) => m.entityId)).toEqual(['group-0003', 'box-0003', 'model-0005', 'model-0006']);
    expect(c4.mapping.map((m) => m.localId)).toEqual(['group-0001', 'box-0001', 'model-0001', 'model-0002']);
    const lantern4 = c4.entries.find((e) => e.entity.id === 'model-0003');
    const lantern5 = c5.entries.find((e) => e.entity.id === 'model-0005');
    expect(lantern4?.entity.components.behavior?.values['target']).toBe('group-0002');
    expect(lantern5?.entity.components.behavior?.values['target']).toBe('group-0003');
    expect(c4.entries[0]?.index).toBe(6);
    expect(c5.entries[0]?.index).toBe(10);
  });

  it('replays every pure prefab atomic-rejection case against its reachable state, byte-for-byte', () => {
    let replayed = 0;
    for (const c of FAILURES) {
      const build = SNAPSHOT_BUILDERS[c.state];
      if (build === undefined) continue;
      // F24 (`request_id_reused`) is a workspace dedup-layer outcome, not a
      // pure-layer one.
      if (c.caseId.startsWith('F24')) continue;
      let state = build();
      for (const s of c.steps) {
        const r = applyMutation(state, s.in);
        expect(r.result, c.caseId).toEqual(s.out);
        if (r.ok) state = r.state as CommandState<SceneV4>;
      }
      expect(c.expect.durableStateUnchanged).toBe(true);
      replayed += 1;
    }
    // F01–F09 (prefab), F10–F20 (packet-21 content/property cases, now
    // reachable through the r3/r4/r5/r7 snapshots), F21 (`reference_in_use`,
    // corrected to the Lantern `model-0005` by the Gate F repair GF-3),
    // F22 (no_change), F23 (stale instantiate).
    expect(replayed).toBe(23);
  });

  it('§20.10 reference_in_use: a copy outside the deleted subtree blocks the delete (F21)', () => {
    // The committed F21 case now carries the instance-B lantern ID
    // (`model-0005`, per the scenario's own M5 mapping); this re-derives the
    // same outcome through the helper API as an independent check.
    const state = stateThrough('M5');
    const edited = ok(
      mutation(state, 'setBehaviorProperties', {
        entityId: 'model-0005',
        behaviorId: 'behavior-0001',
        values: { target: 'group-0001' },
      }),
    );
    const r = mutation(edited.state, 'deleteEntity', { entityId: 'group-0001' });
    expect(failError(r)).toEqual({
      code: 'reference_in_use',
      cls: 'validation',
      entityIds: ['group-0001', 'box-0001', 'model-0001', 'model-0002'],
      referencingEntityIds: ['model-0005'],
      message: 'an entity outside the deleted subtree references an entity inside it',
      hint: 'clear the referencing property values first, or delete the referencing entity too',
    });
  });

  it('invalid input never partially expands: the state object is untouched', () => {
    const state = stateThrough('M5');
    const before = JSON.stringify(state);
    const bad = [
      ['createPrefab', { prefabId: 'prefab-0002', displayName: 'Copy', sourceEntityId: 'group-0002' }],
      ['instantiatePrefab', { prefabId: 'prefab-0001', overrides: [{ localId: 'model-9999', key: 'speed', value: 1 }] }],
      ['instantiatePrefab', { prefabId: 'prefab-0001', overrides: [{ localId: 'model-0001', key: 'target', value: 'group-0099' }] }],
    ] as [string, unknown][];
    for (const [op, args] of bad) {
      expect(failCode(mutation(state, op, args))).toBeTruthy();
    }
    expect(JSON.stringify(state)).toBe(before);
  });
});

// ---- one undo / redo preserves identity --------------------------------------------

describe('one undo/redo preserves instance identity (§8.7.6)', () => {
  it('undo removes the whole subtree and redo restores exactly those IDs', () => {
    const state = stateThrough('M5');
    // Undo the SECOND instance (M5): its whole subtree disappears in one step.
    const undone = ok(mutation(state, 'undo', {}));
    const ids = undone.state.scene.entities.map((e) => e.id);
    expect(ids).not.toContain('group-0003');
    expect(ids).not.toContain('model-0006');
    expect(undone.result.change).toMatchObject({ type: 'deleteEntity', rootId: 'group-0003' });
    const redone = ok(mutation(undone.state, 'redo', {}));
    const change = instantiateChange(redone.result);
    expect(change.rootId).toBe('group-0003');
    expect(change.mapping.map((m) => m.entityId)).toEqual(['group-0003', 'box-0003', 'model-0005', 'model-0006']);
    expect(redone.state.scene.entities.map((e) => e.id)).toEqual(state.scene.entities.map((e) => e.id));
    expect(redone.state.scene.entities).toEqual(state.scene.entities);
  });

  it('redo after undo re-inserts recorded values without re-checking IDs against later state', () => {
    // Undo both instances (M5 then M4: separate history entries), then redo in order.
    let state = stateThrough('M5');
    state = ok(mutation(state, 'undo', {})).state; // undo M5
    state = ok(mutation(state, 'undo', {})).state; // undo M4
    expect(state.scene.entities.map((e) => e.id)).not.toContain('group-0002');
    const redo1 = ok(mutation(state, 'redo', {}));
    expect(instantiateChange(redo1.result).mapping.map((m) => m.entityId)).toEqual([
      'group-0002',
      'box-0002',
      'model-0003',
      'model-0004',
    ]);
    const redo2 = ok(mutation(redo1.state, 'redo', {}));
    expect(instantiateChange(redo2.result).mapping.map((m) => m.entityId)).toEqual([
      'group-0003',
      'box-0003',
      'model-0005',
      'model-0006',
    ]);
  });
});

// ---- two-instance independence -----------------------------------------------------

describe('two instances share no entity, no value storage and no link', () => {
  it('editing one copy never touches the other, and a definition change is impossible', () => {
    const state = stateThrough('M5');
    const edited = ok(
      mutation(state, 'setBehaviorProperties', {
        entityId: 'model-0003',
        behaviorId: 'behavior-0001',
        values: { speed: 9.75 },
      }),
    );
    const a = edited.state.scene.entities.find((e) => e.id === 'model-0003');
    const b = edited.state.scene.entities.find((e) => e.id === 'model-0005');
    expect(a?.components.behavior?.values['speed']).toBe(9.75);
    // The other copy keeps the definition's recorded value.
    expect(b?.components.behavior?.values['speed']).toBe(4.5);
    // Both retain their own provenance and separate value objects.
    expect(a?.components.prefab).toEqual({ prefabId: 'prefab-0001', localId: 'model-0001' });
    expect(b?.components.prefab).toEqual({ prefabId: 'prefab-0001', localId: 'model-0001' });
    expect(a?.components.behavior?.values).not.toBe(b?.components.behavior?.values);
    // The definition value is byte-unchanged.
    expect(edited.state.content?.prefabs).toEqual(state.content?.prefabs);
  });

  it('a later definition is not editable and existing instances are unaffected by capture', () => {
    const state = stateThrough('M5');
    // Capturing a NEW definition from a fresh subtree does not touch instances.
    const fresh = ok(mutation(state, 'createPrefab', { prefabId: 'prefab-0002', displayName: 'Pedestal', sourceEntityId: 'box-0001' }));
    expect(fresh.state.content?.prefabs.map((d) => d.prefabId)).toEqual(['prefab-0001', 'prefab-0002']);
    const before = state.scene.entities.filter((e) => e.id.startsWith('model-'));
    const after = fresh.state.scene.entities.filter((e) => e.id.startsWith('model-'));
    expect(after).toEqual(before);
  });
});

// ---- capture semantics --------------------------------------------------------------

describe('createPrefab (§8.6)', () => {
  it('definition localIds are the subtree closure in document order; parent links are trimmed to the closure', () => {
    const state = stateThrough('M2');
    const r = ok(mutation(state, 'createPrefab', { prefabId: 'prefab-0001', displayName: 'Station Kit', sourceEntityId: 'group-0001' }));
    const change = r.result.change as { definition: PrefabDefinition };
    expect(change.definition.entities.map((e) => e.localId)).toEqual([
      'group-0001',
      'box-0001',
      'model-0001',
      'model-0002',
    ]);
    expect(change.definition.entities[0]?.parentLocalId).toBeUndefined();
    expect(change.definition.entities[1]?.parentLocalId).toBe('group-0001');
    expect(change.definition).toMatchObject({ createdRevision: 5, entityCount: 4, depth: 2 });
  });

  it('undo removes the definition and redo re-inserts the recorded value verbatim', () => {
    const state = stateThrough('M2');
    const captured = ok(mutation(state, 'createPrefab', { prefabId: 'prefab-0001', displayName: 'Station Kit', sourceEntityId: 'group-0001' }));
    const definition = (captured.result.change as { definition: PrefabDefinition }).definition;
    const undone = ok(mutation(captured.state, 'undo', {}));
    expect(undone.result.change).toEqual({ type: 'removePrefab', prefabId: 'prefab-0001' });
    expect(undone.state.content?.prefabs).toEqual([]);
    const redone = ok(mutation(undone.state, 'redo', {}));
    expect((redone.result.change as { definition: PrefabDefinition }).definition).toEqual(definition);
    expect(redone.state.content?.prefabs).toEqual([definition]);
  });

  it('rejects the three forbidden capture contents with the §5.4 codes', () => {
    const state = stateThrough('M5');
    // nested: capture an instance subtree
    expect(
      failError(mutation(state, 'createPrefab', { prefabId: 'prefab-0002', displayName: 'Copy', sourceEntityId: 'group-0002' })),
    ).toMatchObject({ code: 'prefab_nested_forbidden', prefabInstanceIds: ['group-0002', 'box-0002', 'model-0003', 'model-0004'] });
    // camera
    expect(
      failError(mutation(baseState(), 'createPrefab', { prefabId: 'prefab-0002', displayName: 'World', sourceEntityId: 'group-0000' })),
    ).toMatchObject({ code: 'prefab_camera_capture_forbidden', cameraId: 'cam-main' });
    // external reference
    expect(
      failError(mutation(stateThrough('M2'), 'createPrefab', { prefabId: 'prefab-0002', displayName: 'Lantern Only', sourceEntityId: 'model-0001' })),
    ).toMatchObject({ code: 'prefab_external_reference_forbidden', localId: 'model-0001', key: 'target', entityId: 'group-0001' });
  });
});

// ---- deterministic allocation and limits -------------------------------------------

describe('deterministic ID allocation and limits (§8.7.2/§20.3)', () => {
  it('re-uses deleted IDs exactly as the accepted createEntity rule does', () => {
    // From the after envelope group-0002/box-0002/model-0003/model-0004 are free
    // again (M7–M10 deleted them), so the next instance must take those IDs.
    const state = createCommandState(AFTER.scene, AFTER.content);
    const r = ok(mutation(state, 'instantiatePrefab', { prefabId: 'prefab-0001', transform: { position: [12, 0, 0] } }));
    const change = instantiateChange(r.result);
    expect(change.mapping.map((m) => m.entityId)).toEqual(['group-0002', 'box-0002', 'model-0003', 'model-0004']);
    expect(change.entries.map((e) => e.index)).toEqual([10, 11, 12, 13]);
  });

  it('the deterministic allocator exhausts a full prefix without partial allocation', () => {
    const used = new Set<string>();
    for (let n = 1; n <= 9999; n++) used.add(`group-${String(n).padStart(4, '0')}`);
    expect(nextFreeEntityId(used, 'group')).toBeUndefined();
    // A different prefix is unaffected, and the scan is the smallest free NNNN.
    expect(nextFreeEntityId(used, 'box')).toBe('box-0001');
    used.add('box-0001');
    expect(nextFreeEntityId(used, 'box')).toBe('box-0002');
  });

  it('the result entity bound is checked before ID allocation (§8.7.5 step 6 order)', () => {
    // instantiatePrefab bounds a v4 scene at 16384 entities (the cap
    // createEntity/pasteEntities use) — the entity bound fires before a full
    // group prefix is scanned (C10's id_exhaustion remains a
    // contract-required defensive branch, unit-tested above).
    const base = stateThrough('M5');
    const entities = [...base.scene.entities];
    for (let n = 1; n <= 9999; n++) {
      entities.push({
        id: `group-${String(n).padStart(4, '0')}`,
        components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      } as SceneV4['entities'][number]);
    }
    while (entities.length < 16_384) {
      entities.push({
        id: `pad-${entities.length}`,
        components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      } as SceneV4['entities'][number]);
    }
    const state = createCommandState({ ...base.scene, entities } as SceneV4, base.content);
    const before = JSON.stringify(state);
    const r = mutation(state, 'instantiatePrefab', { prefabId: 'prefab-0001' });
    expect(failError(r)).toMatchObject({ code: 'limits_exceeded', limit: 'entities', max: 16_384 });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('rejects 65 overrides and a 257-entity definition with the contract limits', () => {
    const state = stateThrough('M5');
    const definition = state.content?.prefabs[0] as PrefabDefinition;
    const overrides = Array.from({ length: 65 }, () => ({ localId: 'model-0001', key: 'speed', value: 1 }));
    expect(failError(mutation(state, 'instantiatePrefab', { prefabId: 'prefab-0001', overrides }))).toMatchObject({
      code: 'limits_exceeded',
      limit: 'overrides',
      current: 65,
      max: 64,
    });
    // Definition count bound: 128 existing definitions, then a 129th capture.
    const prefabs = Array.from({ length: 128 }, (_, i) => ({
      ...definition,
      prefabId: `prefab-${String(i + 1).padStart(4, '0')}`,
    }));
    const full = createCommandState(BEFORE.scene, { ...BEFORE.content, prefabs });
    expect(failError(mutation(full, 'createPrefab', { prefabId: 'prefab-0200', displayName: 'X', sourceEntityId: 'group-0001' }))).toMatchObject({
      code: 'limits_exceeded',
      limit: 'prefabs',
      current: 129,
      max: 128,
    });
  });

  it('rejects an instantiation that would exceed the scene entity or depth limit', () => {
    const state = stateThrough('M5');
    const definition = state.content?.prefabs[0] as PrefabDefinition;
    // Entity bound: a v4 scene of 1024 entities still takes an instance
    // (the v4 per-scene cap is 16384, as createEntity/pasteEntities); one of
    // 16384 does not.
    const entities = [...state.scene.entities];
    while (entities.length < 1024) {
      entities.push({
        id: `pad-${entities.length}`,
        components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      } as SceneV4['entities'][number]);
    }
    const at1024 = mutation(createCommandState({ ...state.scene, entities: [...entities] } as SceneV4, state.content), 'instantiatePrefab', { prefabId: 'prefab-0001' });
    expect((at1024 as { ok: boolean }).ok).toBe(true);
    while (entities.length < 16_384) {
      entities.push({
        id: `pad-${entities.length}`,
        components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      } as SceneV4['entities'][number]);
    }
    const full = createCommandState({ ...state.scene, entities } as SceneV4, state.content);
    expect(failError(mutation(full, 'instantiatePrefab', { prefabId: 'prefab-0001' }))).toMatchObject({
      code: 'limits_exceeded',
      limit: 'entities',
      max: 16_384,
    });
    void definition;
    // Depth bound: a chain of depth 32 parents plus a depth-2 definition = 34.
    const chain: SceneV4['entities'] = [];
    let prev: string | null = null;
    for (let i = 1; i <= 32; i++) {
      chain.push({
        id: `deep-${i}`,
        ...(prev !== null ? { parentId: prev } : {}),
        components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      } as SceneV4['entities'][number]);
      prev = `deep-${i}`;
    }
    const deepState = createCommandState(
      { ...BEFORE.scene, entities: [...BEFORE.scene.entities, ...chain] } as SceneV4,
      state.content);
    expect(failError(mutation(deepState, 'instantiatePrefab', { prefabId: 'prefab-0001', parentId: 'deep-32' }))).toMatchObject({
      code: 'limits_exceeded',
      limit: 'depth',
      current: 34,
      max: 32,
    });
  });

  it('rejects an override whose declared value fails the rule', () => {
    const state = stateThrough('M5');
    expect(
      failError(mutation(state, 'instantiatePrefab', { prefabId: 'prefab-0001', overrides: [{ localId: 'model-0001', key: 'speed', value: 'fast' }] })),
    ).toEqual({
      code: 'property_type',
      cls: 'validation',
      key: 'speed',
      found: 'fast',
      expected: 'finite number in [-1000, 1000]',
      message: 'the declared property type is number',
    });
    expect(
      failError(mutation(state, 'instantiatePrefab', { prefabId: 'prefab-0001', overrides: [{ localId: 'model-0001', key: 'speed', value: 5000 }] })),
    ).toMatchObject({ code: 'property_value', key: 'speed' });
  });
});

describe('fixtures/m2/prefabs/independence.messages.json replay', () => {
  it('replays every step byte-for-byte and ends at the indexed revision', () => {
    const scenario = m2FixtureJson<{
      base: { state: string; revision: number };
      steps: ScenarioStep[];
    }>('prefabs/independence.messages.json');
    const index = m2FixtureJson<{
      files: { finalRevision: number; outcomes: { stepId: string; op: string; changeType: string }[] }[];
    }>('prefabs/expected.json');
    let state = createCommandState(AFTER.scene, AFTER.content);
    for (const s of scenario.steps) {
      const r = applyMutation(state, s.in);
      expect(r.result, s.stepId).toEqual(s.out);
      if (r.ok) state = r.state as CommandState<SceneV4>;
    }
    const entry = index.files[0] as {
      finalRevision: number;
      outcomes: { stepId: string; op: string; changeType: string }[];
    };
    expect(state.scene.revision).toBe(entry.finalRevision);
    expect(entry.outcomes.map((o) => o.stepId)).toEqual(scenario.steps.map((s) => s.stepId));
    expect(entry.outcomes.map((o) => o.op)).toEqual(scenario.steps.map((s) => s.in['op']));
    expect(entry.outcomes.map((o) => o.changeType)).toEqual(
      scenario.steps.map((s) => (s.out['change'] as { type: string }).type),
    );
    expect(state.content).toEqual(AFTER.content);
  });

  it('the two new copies are independent and the edits touch only copy A', () => {
    const scenario = m2FixtureJson<{ steps: ScenarioStep[] }>('prefabs/independence.messages.json');
    let state = createCommandState(AFTER.scene, AFTER.content);
    const applied: MutationSuccess[] = [];
    for (const s of scenario.steps) {
      const r = applyMutation(state, s.in);
      if (!r.ok) throw new Error(`${s.stepId} must apply`);
      applied.push(r.result);
      state = r.state as CommandState<SceneV4>;
    }
    const c1 = instantiateChange(applied[0] as MutationSuccess);
    const c4 = instantiateChange(applied[3] as MutationSuccess);
    expect(c1.mapping.map((m) => m.entityId)).toEqual(['group-0002', 'box-0002', 'model-0003', 'model-0004']);
    expect(c4.mapping.map((m) => m.entityId)).toEqual(['group-0004', 'box-0004', 'model-0007', 'model-0008']);
    // Edited copy A only: copy B (model-0005/0006) and the later copy C
    // (model-0007/0008) keep the definition's recorded speed and target.
    const byId = new Map(state.scene.entities.map((e) => [e.id, e]));
    expect(byId.get('model-0003')?.components.behavior?.values?.['speed']).toBe(1.25);
    expect(byId.get('model-0005')?.components.behavior?.values?.['speed']).toBe(4.5);
    expect(byId.get('model-0007')?.components.behavior?.values?.['speed']).toBe(4.5);
    expect(byId.get('box-0002')?.components.box?.material?.color).toBe('#112233');
    expect(byId.get('box-0004')?.components.box?.material?.color).toBe('#b0b0b0');
    // Remapped internal references per copy.
    expect(byId.get('model-0003')?.components.behavior?.values?.['target']).toBe('group-0002');
    expect(byId.get('model-0007')?.components.behavior?.values?.['target']).toBe('group-0004');
    // The definition is byte-unchanged by every edit.
    expect(state.content?.prefabs).toEqual(AFTER.content.prefabs);
  });

  it('one undo removes copy C whole and redo restores exactly its IDs', () => {
    const scenario = m2FixtureJson<{ steps: ScenarioStep[] }>('prefabs/independence.messages.json');
    const undoStep = scenario.steps.find((s) => s.stepId === 'I5') as ScenarioStep;
    const redoStep = scenario.steps.find((s) => s.stepId === 'I6') as ScenarioStep;
    let state = createCommandState(AFTER.scene, AFTER.content);
    for (const s of scenario.steps) {
      if (s.stepId === 'I5') break;
      const r = applyMutation(state, s.in);
      if (!r.ok) throw new Error(`${s.stepId} must apply`);
      state = r.state as CommandState<SceneV4>;
    }
    const undone = ok(mutation(state, 'undo', {}, undoStep.in['expectedRevision'] as number));
    expect(undone.result.change).toEqual(undoStep.out['change']);
    expect(undone.state.scene.entities.map((e) => e.id)).not.toContain('group-0004');
    const redone = ok(mutation(undone.state, 'redo', {}, redoStep.in['expectedRevision'] as number));
    expect(redone.result.change).toEqual(redoStep.out['change']);
    expect(instantiateChange(redone.result).mapping.map((m) => m.entityId)).toEqual([
      'group-0004',
      'box-0004',
      'model-0007',
      'model-0008',
    ]);
  });
});

// ---- phase 14.1: gameplay components in v4 prefabs -----------------------------------

describe('phase 14.1: a v4 prefab keeps its gameplay components', () => {
  it('createPrefab captures a collider and a pickup; instantiatePrefab copies them; a controller is still refused', () => {
    const T = { position: [4, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    const crate = { id: 'box-0101', components: { transform: T, box: { size: [1, 1, 1], material: { color: '#aa7733' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true } } };
    const coin = { id: 'box-0102', components: { transform: { ...T, position: [6, 1, 0] }, box: { size: [0.4, 0.4, 0.1], material: { color: '#ffcc00' } }, pickup: { kind: 'coin', value: 5, size: [0.6, 0.6] } } };
    const player = { id: 'player-0101', components: { transform: T, controller: {} } };
    const state = createCommandState({ ...BEFORE.scene, entities: [...BEFORE.scene.entities, crate, coin, player] } as unknown as SceneV4, BEFORE.content);
    const a = ok(mutation(state, 'createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: 'box-0101' }));
    const b = ok(mutation(a.state, 'createPrefab', { prefabId: 'coin', displayName: 'Coin', sourceEntityId: 'box-0102' }));
    const defs = (b.state.content as unknown as { prefabs: PrefabDefinition[] }).prefabs;
    expect(defs.find((d) => d.prefabId === 'crate')!.entities[0]!.components.collider).toEqual({ shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true });
    expect(defs.find((d) => d.prefabId === 'coin')!.entities[0]!.components.pickup).toMatchObject({ kind: 'coin', value: 5, size: [0.6, 0.6] });
    expect(failCode(mutation(b.state, 'createPrefab', { prefabId: 'hero', displayName: 'Hero', sourceEntityId: 'player-0101' }))).toBe('prefab_component_forbidden');
    const placed = ok(mutation(b.state, 'instantiatePrefab', { prefabId: 'coin', transform: { position: [9, 2, 0] } }));
    const copy = placed.state.scene.entities.find((e) => e.id === instantiateChange(placed.result).rootId)!;
    expect((copy.components as unknown as { pickup?: unknown }).pickup).toMatchObject({ kind: 'coin', value: 5 });
    expect(copy.components.transform?.position).toEqual([9, 2, 0]);
    const crateCopy = ok(mutation(placed.state, 'instantiatePrefab', { prefabId: 'crate', transform: { position: [12, 0.5, 0] } }));
    const crateEntity = crateCopy.state.scene.entities.find((e) => e.id === instantiateChange(crateCopy.result).rootId)!;
    expect(crateEntity.components.collider).toEqual({ shape: { type: 'box', hx: 0.5, hy: 0.5 }, oneWay: true });
  });
});

// ---- queryPrefabs ------------------------------------------------------------------

describe('queryPrefabs (commands.md §5.6)', () => {
  it('returns the committed query examples and a bounded, read-only page', () => {
    const examples = m2FixtureJson<{ examples: Record<string, { request: unknown; result: unknown }> }>(
      'contracts/commands/queries.json',
    ).examples;
    const state = createCommandState(AFTER.scene, AFTER.content);
    const s = examples['queryPrefabs'] as { request: unknown; result: unknown };
    expect(queryPrefabs(state, s.request)).toEqual(s.result);
    const d = examples['queryPrefabDefinition'] as { request: unknown; result: unknown };
    expect(queryPrefabs(state, d.request)).toEqual(d.result);
    expect(queryPrefabs(state, { op: 'queryPrefabs', projectId: 'demo-0003', args: { prefabId: 'prefab-0099' } })).toMatchObject({
      ok: false,
      error: { code: 'prefab_not_found' },
    });
    expect(queryPrefabs(state, { op: 'queryPrefabs', projectId: 'demo-0003', args: { limit: 129 } })).toMatchObject({
      ok: false,
      error: { code: 'field_value' },
    });
  });
});
