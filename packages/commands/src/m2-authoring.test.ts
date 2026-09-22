/**
 * Packet-27 repair (GG-1/GG-2) — whole-GLB placement and collider/controller
 * authoring (commands.md §3.1/§5.3/§8.1/§8.10).
 *
 * Byte-exact replay of `fixtures/m2/commands/model-authoring.messages.json`
 * plus focused boundary tests for the repaired `createEntity` `model` kind and
 * the `setComponent` add/edit/remove semantics.
 */

import { describe, expect, it } from 'vitest';
import type { ContentCatalog, Manifest, SceneV2 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess } from './index';
import { m2FixtureJson } from './test-fixtures';

interface ScenarioStep {
  stepId: string;
  in: Record<string, unknown>;
  out: Record<string, unknown>;
}

const BEFORE = m2FixtureJson<{ scene: SceneV2; content: ContentCatalog; projectId: string }>(
  'contracts/commands/prefab-scenario.before.json',
);
const MANIFEST = m2FixtureJson<{ manifest: Manifest }>('contracts/commands/queries.json').manifest;

function baseState(): CommandState<SceneV2> {
  return createCommandState(BEFORE.scene, BEFORE.content, MANIFEST);
}

let counter = 0;
function rid(): string {
  counter += 1;
  return `req-${BigInt(counter).toString(16).padStart(32, 'f')}`;
}

function mutation(
  state: CommandState<SceneV2>,
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

function ok(r: ReturnType<typeof applyMutation>): { state: CommandState<SceneV2>; result: MutationSuccess } {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.result)}`);
  return { state: r.state as CommandState<SceneV2>, result: r.result };
}

function failCode(r: ReturnType<typeof applyMutation>): string {
  if (r.ok) throw new Error('expected failure');
  return r.result.error.code;
}

describe('fixtures/m2/commands/model-authoring.messages.json replay (C27-1/C28-1)', () => {
  it('replays every step byte-for-byte and ends at the indexed revision', () => {
    const scenario = m2FixtureJson<{ base: { state: string; revision: number }; steps: ScenarioStep[] }>(
      'commands/model-authoring.messages.json',
    );
    const index = m2FixtureJson<{
      files: { file: string; finalRevision: number; outcomes: { stepId: string; op: string }[] }[];
    }>('commands/expected.json');
    let state = baseState();
    for (const step of scenario.steps) {
      const r = applyMutation(state, step.in);
      expect(r.result, step.stepId).toEqual(step.out);
      if (r.ok) state = r.state as CommandState<SceneV2>;
    }
    const entry = index.files.find((f) => f.file === 'commands/model-authoring.messages.json') as {
      finalRevision: number;
      outcomes: { stepId: string; op: string }[];
    };
    expect(state.scene.revision).toBe(entry.finalRevision);
    expect(entry.outcomes.map((o) => o.stepId)).toEqual(scenario.steps.map((s) => s.stepId));
    expect(entry.outcomes.map((o) => o.op)).toEqual(scenario.steps.map((s) => s.in['op']));
  });

  it('plans/creates the model kind with the derived prefix and resolving asset only', () => {
    const r = ok(
      mutation(baseState(), 'createEntity', {
        kind: 'model',
        model: { asset: { assetId: 'asset-2b11d4a76c9f0e35' } },
      }),
    );
    expect(r.result.createdId).toBe('model-0003');
    const entity = (r.result.change as unknown as { entity: { components: Record<string, unknown> } }).entity;
    expect(entity.components['model']).toEqual({ asset: { assetId: 'asset-2b11d4a76c9f0e35' } });

    const missing = mutation(baseState(), 'createEntity', {
      kind: 'model',
      model: { asset: { assetId: 'asset-0000000000000000' } },
    });
    expect(failCode(missing)).toBe('asset_reference_missing');

    // `model` is mandatory for kind model; forbidden for group/box.
    expect(failCode(mutation(baseState(), 'createEntity', { kind: 'model' }))).toBe('field_missing');
    expect(
      failCode(
        mutation(baseState(), 'createEntity', {
          kind: 'group',
          model: { asset: { assetId: 'asset-2b11d4a76c9f0e35' } },
        }),
      ),
    ).toBe('field_unexpected');
    expect(failCode(mutation(baseState(), 'createEntity', { kind: 'camera' }))).toBe('field_value');
  });

  it('adds, edits and removes a collider; undo restores both directions', () => {
    const s1 = ok(
      mutation(baseState(), 'createEntity', {
        kind: 'model',
        model: { asset: { assetId: 'asset-2b11d4a76c9f0e35' } },
      }),
    );
    const add = ok(
      mutation(s1.state, 'setComponent', {
        entityId: 'model-0003',
        component: 'collider',
        value: { shape: { type: 'box', hx: 1.5, hy: 0.25 } },
      }),
    );
    expect(add.result.change).toMatchObject({
      type: 'setComponent',
      component: 'collider',
      previous: null,
      next: { shape: { type: 'box', hx: 1.5, hy: 0.25 } },
      changedFields: ['shape'],
    });
    const undoAdd = ok(mutation(add.state, 'undo', {}));
    expect((undoAdd.result.change as { next: unknown }).next).toBeNull();
    const redoAdd = ok(mutation(undoAdd.state, 'redo', {}));
    expect((redoAdd.result.change as { previous: unknown }).previous).toBeNull();

    const edit = ok(
      mutation(redoAdd.state, 'setComponent', {
        entityId: 'model-0003',
        component: 'collider',
        value: { shape: { type: 'box', hx: 2, hy: 0.25 } },
      }),
    );
    expect((edit.result.change as { previous: unknown }).previous).toEqual({
      shape: { type: 'box', hx: 1.5, hy: 0.25 },
    });
    const remove = ok(
      mutation(edit.state, 'setComponent', { entityId: 'model-0003', component: 'collider', value: null }),
    );
    expect((remove.result.change as { next: unknown }).next).toBeNull();
    // Undo of a removal restores the value.
    const undoRemove = ok(mutation(remove.state, 'undo', {}));
    expect((undoRemove.result.change as { next: unknown }).next).toEqual({
      shape: { type: 'box', hx: 2, hy: 0.25 },
    });
  });

  it('adds and removes the controller marker and rejects a second controller', () => {
    const s1 = ok(
      mutation(baseState(), 'createEntity', {
        kind: 'model',
        model: { asset: { assetId: 'asset-2b11d4a76c9f0e35' } },
      }),
    );
    const s2 = ok(
      mutation(s1.state, 'createEntity', {
        kind: 'model',
        model: { asset: { assetId: 'asset-7f3a2c9e1b4d5068' } },
      }),
    );
    const add = ok(
      mutation(s2.state, 'setComponent', { entityId: 'model-0003', component: 'controller', value: {} }),
    );
    expect(add.result.change).toMatchObject({ component: 'controller', previous: null, next: {}, changedFields: [] });
    const second = mutation(add.state, 'setComponent', {
      entityId: 'model-0004',
      component: 'controller',
      value: {},
    });
    expect(failCode(second)).toBe('controller_count_invalid');
    const remove = ok(
      mutation(add.state, 'setComponent', { entityId: 'model-0003', component: 'controller', value: null }),
    );
    expect((remove.result.change as { next: unknown }).next).toBeNull();
  });

  it('rejects removal and empty values for the field edits, and a bad shape', () => {
    expect(
      failCode(mutation(baseState(), 'setComponent', { entityId: 'model-0001', component: 'model', value: null })),
    ).toBe('field_value');
    expect(
      failCode(mutation(baseState(), 'setComponent', { entityId: 'box-0001', component: 'box', value: {} })),
    ).toBe('field_value');
    expect(
      failCode(
        mutation(baseState(), 'setComponent', {
          entityId: 'model-0001',
          component: 'collider',
          value: { shape: { type: 'nope' } },
        }),
      ),
    ).toBe('field_value');
    expect(
      failCode(
        mutation(baseState(), 'setComponent', {
          entityId: 'model-0001',
          component: 'collider',
          value: { shape: { type: 'box', hx: 0, hy: 1 } },
        }),
      ),
    ).toBe('number_out_of_range');
    // box/camera/model still require the component to exist.
    expect(
      failCode(mutation(baseState(), 'setComponent', { entityId: 'box-0001', component: 'model', value: { asset: { assetId: 'asset-2b11d4a76c9f0e35' } } })),
    ).toBe('component_missing');
  });
});
