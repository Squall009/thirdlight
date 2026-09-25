/**
 * Phase 18.0/18.1: graph materials through the commands — `setMaterial`
 * with a graph and parameters, `graphEdit` on owner kind `material` (one
 * revision, one undo step, refusals change nothing), material functions as
 * standalone graphs (a used function keeps the ports its callers wire and
 * cannot be deleted) and per-object overrides (`setComponent
 * materialParams`, public parameters only).
 */
import { describe, expect, it } from 'vitest';
import { composeV4, type ContentCatalogV4, type GraphData, type MaterialDef, type ModelErrorV3, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, GraphEditChange, MutationSuccess } from './index';
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
    requestId: `req-${(0x18000 + counter).toString(16).padStart(32, '0')}`,
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
const materials = (s: State): MaterialDef[] => (s.content as { materials?: MaterialDef[] }).materials ?? [];
const graphOf = (s: State, id = 'mat-g'): GraphData => materials(s).find((m) => m.materialId === id)!.graph!;
const owner = { kind: 'material', id: 'mat-g' };

function withGraphMaterial(): State {
  return ok(fresh(), 'setMaterial', {
    material: { materialId: 'mat-g', name: 'Graph', shader: 'standard', params: {}, textures: {}, parameters: [{ key: 'tint', type: 'color', default: '#ffffff' }, { key: 'secret', type: 'float', default: 1, visibility: 'private' }], graph: { nodes: [{ id: 'out', type: 'pbr', position: [400, 0] }], edges: [] } },
  }).state;
}

describe('graphEdit on a graph material', () => {
  it('adds and wires texture × tint into the base colour as one revision and one undo step', () => {
    const s0 = withGraphMaterial();
    const r = ok(s0, 'graphEdit', {
      owner,
      ops: [
        { op: 'addNodes', nodes: [{ id: 'tex', type: 'sampleTexture', position: [0, 0] }, { id: 'tint', type: 'parameter', position: [0, 200], data: { key: 'tint' } }, { id: 'mul', type: 'multiply', position: [200, 0] }] },
        {
          op: 'connect',
          edges: [
            { id: 'e1', from: { node: 'tex', port: 'rgb' }, to: { node: 'mul', port: 'a' } },
            { id: 'e2', from: { node: 'tint', port: 'value' }, to: { node: 'mul', port: 'b' } },
            { id: 'e3', from: { node: 'mul', port: 'out' }, to: { node: 'out', port: 'baseColor' } },
          ],
        },
      ],
    });
    expect(r.state.scene.revision).toBe(s0.scene.revision + 1);
    const change = r.change as GraphEditChange;
    expect(change.type).toBe('graphEdit');
    expect(change.owner).toEqual(owner);
    expect(graphOf(r.state).nodes.map((n) => n.id)).toEqual(['mul', 'out', 'tex', 'tint']);
    expect(graphOf(r.state).edges).toHaveLength(3);
    const undone = ok(r.state, 'undo', {});
    expect(graphOf(undone.state)).toEqual({ nodes: [{ id: 'out', type: 'pbr', position: [400, 0] }], edges: [] });
    const redone = ok(undone.state, 'redo', {});
    expect(graphOf(redone.state)).toEqual(graphOf(r.state));
  });

  it('refuses a cycle, a second surface output, an undeclared parameter and a texture into a value (nothing changes)', () => {
    const s = ok(withGraphMaterial(), 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'a', type: 'add', position: [0, 0] }, { id: 'b', type: 'add', position: [0, 100] }] }, { op: 'connect', edges: [{ id: 'e1', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'a' } }] }] }).state;
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'connect', edges: [{ id: 'e2', from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'a' } }] }] }).code).toBe('hierarchy_cycle');
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'u', type: 'unlit', position: [0, 0] }] }] }).message).toMatch(/at most one/);
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'p', type: 'parameter', position: [0, 0], data: { key: 'ghost' } }] }] }).message).toMatch(/declare it first/);
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 't', type: 'sampleTexture', position: [0, 0] }, { id: 'f', type: 'float', position: [0, 0] }] }, { op: 'connect', edges: [{ id: 'e3', from: { node: 'f', port: 'value' }, to: { node: 't', port: 'tex' } }] }] }).message).toMatch(/cannot feed a texture input/);
  });

  it('refuses a material without a graph and a texture field naming no texture asset', () => {
    const s = ok(withGraphMaterial(), 'setMaterial', { material: { materialId: 'mat-s', name: 'Shader', shader: 'standard', params: {}, textures: {} } }).state;
    expect(refused(s, 'graphEdit', { owner: { kind: 'material', id: 'mat-s' }, ops: [{ op: 'addNodes', nodes: [{ id: 'f', type: 'float', position: [0, 0] }] }] }).code).toBe('reference_missing');
    expect(refused(s, 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 't', type: 'sampleTexture', position: [0, 0], data: { texture: 'no-such-texture' } }] }] }).code).toBe('asset_reference_missing');
  });
});

describe('material functions', () => {
  const fnGraph = {
    nodes: [
      { id: 'inColor', type: 'functionInput', position: [0, 0], data: { name: 'color', type: 'vec3' } },
      { id: 'result', type: 'functionOutput', position: [300, 0], data: { name: 'result', type: 'vec3' } },
    ],
    edges: [{ id: 'e1', from: { node: 'inColor', port: 'value' }, to: { node: 'result', port: 'value' } }],
  };
  function withCall(): State {
    let s = ok(withGraphMaterial(), 'setGraph', { graph: { graphId: 'pass', kind: 'material-function', name: 'Pass', graph: fnGraph } }).state;
    s = ok(s, 'graphEdit', {
      owner,
      ops: [
        { op: 'addNodes', nodes: [{ id: 'call', type: 'call', position: [200, 0], data: { function: 'pass' } }, { id: 'c', type: 'color', position: [0, 0] }] },
        { op: 'connect', edges: [{ id: 'w1', from: { node: 'c', port: 'rgb' }, to: { node: 'call', port: 'inColor' } }, { id: 'w2', from: { node: 'call', port: 'result' }, to: { node: 'out', port: 'baseColor' } }] },
      ],
    }).state;
    return s;
  }

  it('a material calls a function through its interface ports', () => {
    const s = withCall();
    expect(graphOf(s).edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort()).toEqual(['c.rgb>call.inColor', 'call.result>out.baseColor']);
  });

  it('a function keeps the ports its callers wire, and a used function cannot be deleted', () => {
    const s = withCall();
    expect(refused(s, 'graphEdit', { owner: { kind: 'graph', id: 'pass' }, ops: [{ op: 'removeNodes', ids: ['inColor'] }] }).message).toMatch(/has no input "inColor"/);
    expect(refused(s, 'deleteGraph', { graphId: 'pass' }).message).toMatch(/names no material-function graph/);
    // An unwired addition is fine.
    ok(s, 'graphEdit', { owner: { kind: 'graph', id: 'pass' }, ops: [{ op: 'addNodes', nodes: [{ id: 'inExtra', type: 'functionInput', position: [0, 100], data: { name: 'extra' } }] }] });
  });

  it('refuses a function that calls itself', () => {
    const s = withCall();
    expect(refused(s, 'graphEdit', { owner: { kind: 'graph', id: 'pass' }, ops: [{ op: 'addNodes', nodes: [{ id: 'self', type: 'call', position: [0, 200], data: { function: 'pass' } }] }] }).message).toMatch(/call each other in a cycle \(pass → pass\)/);
  });
});

/** The workspace's project-wide rules after a command (workspace service: composeV4 over every scene). */
function projectErrors(s: State): ModelErrorV3[] {
  const errors: ModelErrorV3[] = [];
  composeV4([{ ...s.scene, sceneId: 'scene-main' }], s.content as unknown as ContentCatalogV4, errors, s.scene.revision);
  return errors;
}

describe('per-object overrides (setComponent materialParams)', () => {
  function withBox(): { state: State; id: string } {
    const s = withGraphMaterial();
    const created = ok(s, 'createEntity', { kind: 'box' });
    const id = String(created.result['createdId']);
    return { state: ok(created.state, 'setComponent', { entityId: id, component: 'materials', value: { '*': 'mat-g' } }).state, id };
  }

  it('stores a public parameter override (one undo) and refuses a private one', () => {
    const { state, id } = withBox();
    const r = ok(state, 'setComponent', { entityId: id, component: 'materialParams', value: { 'mat-g': { tint: '#ff0000' } } });
    const comps = r.state.scene.entities.find((e) => e.id === id)!.components as Record<string, unknown>;
    expect(comps['materialParams']).toEqual({ 'mat-g': { tint: '#ff0000' } });
    expect(projectErrors(r.state)).toEqual([]);
    expect(ok(r.state, 'undo', {}).state.scene.entities.find((e) => e.id === id)!.components).not.toHaveProperty('materialParams');
    // The shape is the command's; the values against the material are the project rule the workspace applies after every command.
    expect(refused(state, 'setComponent', { entityId: id, component: 'materialParams', value: { 'mat-g': { tint: { r: 1 } } } }).code).toBe('field_type');
    const priv = ok(state, 'setComponent', { entityId: id, component: 'materialParams', value: { 'mat-g': { secret: 2 } } }).state;
    expect(projectErrors(priv)[0]!.message).toMatch(/private/);
    const wrong = ok(state, 'setComponent', { entityId: id, component: 'materialParams', value: { 'mat-g': { tint: 3 } } }).state;
    expect(projectErrors(wrong)[0]!.message).toMatch(/colour/);
  });

  it('a material cannot lose a parameter an object overrides', () => {
    const { state, id } = withBox();
    const s = ok(state, 'setComponent', { entityId: id, component: 'materialParams', value: { 'mat-g': { tint: '#ff0000' } } }).state;
    const m = materials(s).find((x) => x.materialId === 'mat-g')!;
    const dropped = ok(s, 'setMaterial', { material: { ...m, parameters: [] } }).state;
    expect(projectErrors(dropped)[0]!.message).toMatch(/has no parameter "tint"/);
  });
});
