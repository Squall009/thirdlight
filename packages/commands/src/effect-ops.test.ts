/**
 * Phase 20.0: visual effects through the commands — `setEffect` (create,
 * replace, add a system), `renameEffect`, `deleteEffect`, `graphEdit` on
 * owner kind `effect` (a system's chains, one revision, one undo step,
 * refusals change nothing) and the `effect` component (public parameter
 * overrides only; the project rule runs after every command in the workspace).
 */
import { describe, expect, it } from 'vitest';
import { composeV4, newEffectSystemGraph, type ContentCatalogV4, type EffectDef, type GraphData, type ModelErrorV3, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, GraphEditChange, MutationSuccess, SetEffectChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x20000 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown; result: Record<string, unknown> } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change, result: r.result };
}
const refused = (state: State, op: string, args: Record<string, unknown>): { code: string; message: string } => {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  expect(r.state).toBe(state);
  return r.result['error'] as { code: string; message: string };
};
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const effects = (s: State): EffectDef[] => (s.content as { effects?: EffectDef[] }).effects ?? [];
const graphOf = (s: State, sys = 'sparks'): GraphData => effects(s)[0]!.systems.find((x) => x.systemId === sys)!.graph;
const owner = { kind: 'effect', id: 'fx-a/sparks' };

const EFFECT: EffectDef = {
  effectId: 'fx-a',
  name: 'Sparks',
  duration: 2,
  loop: true,
  seed: 1,
  bounds: { center: [0, 1, 0], size: [4, 4, 4] },
  parameters: [
    { key: 'count', type: 'float', default: 20, min: 0, max: 1000 },
    { key: 'secret', type: 'float', default: 1, visibility: 'private' },
  ],
  systems: [{ systemId: 'sparks', name: 'Sparks', maxParticles: 1000, space: 'local', graph: newEffectSystemGraph() }],
};
const withEffect = (): State => ok(fresh(), 'setEffect', { effect: EFFECT }).state;

function projectErrors(s: State): ModelErrorV3[] {
  const errors: ModelErrorV3[] = [];
  composeV4([{ ...s.scene, sceneId: 'scene-main' }], s.content as unknown as ContentCatalogV4, errors, s.scene.revision);
  return errors;
}

describe('effect commands', () => {
  it('creates, renames, adds a system and deletes, each one undo step', () => {
    const s0 = fresh();
    const created = ok(s0, 'setEffect', { effect: EFFECT });
    expect((created.change as SetEffectChange).previous).toBeNull();
    expect(effects(created.state)[0]!.systems[0]!.graph.nodes.map((n) => n.id)).toEqual(['initialize', 'output', 'spawn', 'update']);
    expect(effects(ok(created.state, 'undo', {}).state)).toEqual([]);

    const renamed = ok(created.state, 'renameEffect', { effectId: 'fx-a', name: 'Embers' });
    expect(effects(renamed.state)[0]!.name).toBe('Embers');
    expect(refused(renamed.state, 'renameEffect', { effectId: 'fx-a', name: 'Embers' }).code).toBe('no_change');
    expect(refused(renamed.state, 'renameEffect', { effectId: 'fx-a', name: '' }).code).toBe('field_value');
    expect(refused(renamed.state, 'renameEffect', { effectId: 'nope', name: 'X' }).code).toBe('reference_missing');

    const two = ok(renamed.state, 'setEffect', { effect: { ...effects(renamed.state)[0]!, systems: [...EFFECT.systems, { systemId: 'smoke', name: 'Smoke', maxParticles: 200, space: 'world', graph: newEffectSystemGraph() }] } });
    expect(effects(two.state)[0]!.systems.map((x) => x.systemId)).toEqual(['sparks', 'smoke']);
    expect(effects(ok(two.state, 'undo', {}).state)[0]!.systems).toHaveLength(1);

    const deleted = ok(two.state, 'deleteEffect', { effectId: 'fx-a' });
    expect(effects(deleted.state)).toEqual([]);
    expect((deleted.state.content as unknown as Record<string, unknown>)['effects']).toBeUndefined();
    const back = ok(deleted.state, 'undo', {});
    expect(effects(back.state)).toEqual(effects(two.state));
    expect(effects(ok(back.state, 'redo', {}).state)).toEqual([]);
  });

  it('refuses malformed effects (the missing context node, a duplicate system, a bad seed)', () => {
    const noContexts = { ...EFFECT, systems: [{ ...EFFECT.systems[0]!, graph: { nodes: [], edges: [] } }] };
    expect(refused(fresh(), 'setEffect', { effect: noContexts }).message).toMatch(/exactly one "Spawn"/);
    expect(refused(fresh(), 'setEffect', { effect: { ...EFFECT, systems: [EFFECT.systems[0], EFFECT.systems[0]] } }).code).toBe('id_duplicate');
    expect(refused(fresh(), 'setEffect', { effect: { ...EFFECT, seed: -1 } }).code).toBe('field_value');
    expect(refused(fresh(), 'setEffect', { effect: { ...EFFECT, parameters: [{ key: 'c', type: 'texture', default: '' }] } }).code).toBe('field_value');
    expect(refused(fresh(), 'deleteEffect', { effectId: 'fx-a' }).code).toBe('reference_missing');
  });
});

describe('graphEdit on an effect system', () => {
  it('builds spawn burst → lifetime → billboard chains as one revision and one undo step', () => {
    const s0 = withEffect();
    const r = ok(s0, 'graphEdit', {
      owner,
      ops: [
        { op: 'addNodes', nodes: [{ id: 'burst', type: 'spawn.burst', position: [240, 0] }, { id: 'life', type: 'init.lifetime', position: [240, 200], data: { min: 0.5, max: 1.5 } }, { id: 'bb', type: 'output.billboard', position: [240, 600], data: { blend: 'additive' } }, { id: 'n', type: 'value.parameter', position: [0, 80], data: { key: 'count' } }] },
        {
          op: 'connect',
          edges: [
            { id: 'e1', from: { node: 'spawn', port: 'then' }, to: { node: 'burst', port: 'in' } },
            { id: 'e2', from: { node: 'initialize', port: 'then' }, to: { node: 'life', port: 'in' } },
            { id: 'e3', from: { node: 'output', port: 'then' }, to: { node: 'bb', port: 'in' } },
            { id: 'e4', from: { node: 'n', port: 'value' }, to: { node: 'burst', port: 'count' } },
          ],
        },
      ],
    });
    expect(r.state.scene.revision).toBe(s0.scene.revision + 1);
    const change = r.change as GraphEditChange;
    expect(change.type).toBe('graphEdit');
    expect(change.owner).toEqual(owner);
    expect(graphOf(r.state).edges).toHaveLength(4);
    const undone = ok(r.state, 'undo', {});
    expect(graphOf(undone.state)).toEqual(graphOf(s0));
    expect(graphOf(ok(undone.state, 'redo', {}).state)).toEqual(graphOf(r.state));
  });

  it('refuses a block in the wrong context, a branching chain, removing a context and a bad curve', () => {
    const s = ok(withEffect(), 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'g', type: 'update.gravity', position: [0, 0] }, { id: 'd', type: 'update.drag', position: [0, 0] }] }, { op: 'connect', edges: [{ id: 'e1', from: { node: 'update', port: 'then' }, to: { node: 'g', port: 'in' } }] }] }).state;
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'connect', edges: [{ id: 'x', from: { node: 'initialize', port: 'then' }, to: { node: 'd', port: 'in' } }] }] }).message).toMatch(/initialize chain output cannot feed a update chain input/);
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'connect', edges: [{ id: 'x', from: { node: 'update', port: 'then' }, to: { node: 'd', port: 'in' } }] }] }).message).toMatch(/takes one connection/);
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'removeNodes', ids: ['output'] }] }).message).toMatch(/exactly one "Output"/);
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'c', type: 'update.size.curve', position: [0, 0], data: { curve: [0, 1, 0.5] } }] }] }).message).toMatch(/a curve/);
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'c', type: 'update.color.gradient', position: [0, 0], data: { gradient: [0, 1, 1, 1, 2] } }] }] }).message).toMatch(/a gradient/);
    expect(refused(s, 'graphEdit', { owner: { kind: 'effect', id: 'fx-a/none' }, ops: [{ op: 'removeNodes', ids: ['g'] }] }).code).toBe('reference_missing');
  });

  it('types a Parameter node from the declaration and refuses a texture field naming no texture', () => {
    const s = withEffect();
    const vec = ok(s, 'setEffect', { effect: { ...EFFECT, parameters: [{ key: 'count', type: 'vec3', default: [0, 1, 0] }] } }).state;
    // A vec3 parameter cannot feed a float input (no vec3 → float conversion).
    expect(refused(vec, 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'b', type: 'spawn.burst', position: [0, 0] }, { id: 'n', type: 'value.parameter', position: [0, 0], data: { key: 'count' } }] }, { op: 'connect', edges: [{ id: 'e', from: { node: 'n', port: 'value' }, to: { node: 'b', port: 'count' } }] }] }).message).toMatch(/vec3 output cannot feed a float input/);
    const bad = run(s, 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'b', type: 'output.billboard', position: [0, 0], data: { texture: 'no-such-texture' } }] }] });
    expect(bad.result.ok).toBe(false);
    expect(JSON.stringify(bad.result)).toMatch(/texture asset/);
  });
});

describe('the effect component', () => {
  it('stores public overrides (one undo); a private one or an unknown effect is refused by the project rule', () => {
    const s = withEffect();
    const created = ok(s, 'createEntity', { kind: 'box' });
    const id = String(created.result['createdId']);
    const r = ok(created.state, 'setComponent', { entityId: id, component: 'effect', value: { effectId: 'fx-a', playOnStart: false, params: { count: 5 } } });
    const comps = r.state.scene.entities.find((e) => e.id === id)!.components as Record<string, unknown>;
    expect(comps['effect']).toEqual({ effectId: 'fx-a', playOnStart: false, params: { count: 5 } });
    expect(projectErrors(r.state)).toEqual([]);
    // playOnStart back to its default is omitted from the canonical form.
    const on = ok(r.state, 'setComponent', { entityId: id, component: 'effect', value: { playOnStart: true } });
    expect((on.state.scene.entities.find((e) => e.id === id)!.components as Record<string, unknown>)['effect']).toEqual({ effectId: 'fx-a', params: { count: 5 } });
    expect(ok(r.state, 'undo', {}).state.scene.entities.find((e) => e.id === id)!.components).not.toHaveProperty('effect');
    const priv = ok(created.state, 'setComponent', { entityId: id, component: 'effect', value: { effectId: 'fx-a', params: { secret: 2 } } }).state;
    expect(projectErrors(priv)[0]!.message).toMatch(/private/);
    const ghost = ok(created.state, 'setComponent', { entityId: id, component: 'effect', value: { effectId: 'ghost' } }).state;
    expect(projectErrors(ghost)[0]!.message).toMatch(/names no effect/);
    // Deleting an effect an object plays breaks the project rule (the workspace refuses it).
    expect(projectErrors(ok(r.state, 'deleteEffect', { effectId: 'fx-a' }).state)[0]!.message).toMatch(/names no effect/);
  });
});
