/**
 * Material instances through the commands — an instance is a
 * `setMaterial` with `instanceOf` (one undo), checked against its parent by
 * the resulting-state rules; object, model-asset and block-type mappings name
 * it like a material, and per-object overrides of an instance use its root's
 * parameters.
 */
import { describe, expect, it } from 'vitest';
import { composeV4, type ContentCatalogV4, type MaterialDef, type ModelErrorV3, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess } from './index';
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
    requestId: `req-${(0x25190 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): State {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  expect((r.result as unknown as MutationSuccess).change).toBeDefined();
  return r.state;
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string; path?: string } {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  expect(r.state).toBe(state);
  const e = r.result['error'] as { code: string; message: string; path?: string; details?: { message: string }[] };
  // The resulting-state check names the broken rule in its details.
  return { ...e, message: e.details?.[0]?.message ?? e.message };
}
/** The project rules the workspace applies after every command (object overrides against the materials). */
function projectErrors(s: State): ModelErrorV3[] {
  const errors: ModelErrorV3[] = [];
  composeV4([{ ...s.scene, sceneId: 'scene-main' }], s.content as unknown as ContentCatalogV4, errors, s.scene.revision);
  return errors;
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const materials = (s: State): MaterialDef[] => (s.content as { materials?: MaterialDef[] }).materials ?? [];

const GRAPH: MaterialDef = {
  materialId: 'mat-g',
  name: 'Graph',
  shader: 'standard',
  params: {},
  textures: {},
  parameters: [
    { key: 'tint', type: 'color', default: '#ffffff' },
    { key: 'gloss', type: 'float', default: 0.5, min: 0, max: 1 },
  ],
  graph: { nodes: [{ id: 'out', type: 'pbr', position: [400, 0] }], edges: [] },
};
const SHADER: MaterialDef = { materialId: 'mat-s', name: 'Shader', shader: 'standard', params: { color: '#808080', roughness: 0.4 }, textures: {} };

function base(): State {
  return ok(ok(fresh(), 'setMaterial', { material: GRAPH }), 'setMaterial', { material: SHADER });
}

describe('material instances (phase 25.19)', () => {
  it('an instance of a graph material sets parameter values; one of a shader material sets params', () => {
    let s = ok(base(), 'setMaterial', { material: { materialId: 'mi-red', name: 'Red', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-g', values: { tint: '#ff0000' } } });
    s = ok(s, 'setMaterial', { material: { materialId: 'mi-rough', name: 'Rough', shader: 'standard', params: { roughness: 1 }, textures: {}, instanceOf: 'mat-s' } });
    // An instance of an instance.
    s = ok(s, 'setMaterial', { material: { materialId: 'mi-red-dull', name: 'Red dull', shader: 'standard', params: {}, textures: {}, instanceOf: 'mi-red', values: { gloss: 0 } } });
    const red = materials(s).find((m) => m.materialId === 'mi-red')!;
    expect(red.values).toEqual({ tint: '#ff0000' });
    expect(red.instanceOf).toBe('mat-g');
    // Undo removes the last instance only.
    const undone = run(s, 'undo', {}).state;
    expect(materials(undone).some((m) => m.materialId === 'mi-red-dull')).toBe(false);
    expect(materials(undone).some((m) => m.materialId === 'mi-red')).toBe(true);
  });

  it('refuses a missing parent, a loop, another shader, its own graph and unknown or misfit values', () => {
    const s = base();
    const inst = (patch: Partial<MaterialDef>): Record<string, unknown> => ({ material: { materialId: 'mi-x', name: 'X', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-g', ...patch } });
    expect(refused(s, 'setMaterial', inst({ instanceOf: 'mat-nope' })).message).toMatch(/names no material/);
    expect(refused(s, 'setMaterial', inst({ instanceOf: 'mi-x' })).message).toMatch(/own parent/);
    expect(refused(s, 'setMaterial', inst({ shader: 'unlit' })).message).toMatch(/parent's shader/);
    expect(refused(s, 'setMaterial', inst({ graph: GRAPH.graph! })).message).toMatch(/no graph of its own/);
    expect(refused(s, 'setMaterial', inst({ values: { nope: 1 } })).message).toMatch(/no parameter "nope"/);
    expect(refused(s, 'setMaterial', inst({ values: { gloss: 3 } })).message).toMatch(/gloss must be/);
    expect(refused(s, 'setMaterial', inst({ instanceOf: 'mat-s', values: { tint: '#ff0000' } })).message).toMatch(/only an instance of a graph material/);
    expect(refused(s, 'setMaterial', { material: { ...SHADER, materialId: 'mat-v', values: { a: 1 } } }).message).toMatch(/values belong to a material instance/);
    // A loop through two instances.
    const a = ok(s, 'setMaterial', inst({ materialId: 'mi-a' }));
    const b = ok(a, 'setMaterial', inst({ materialId: 'mi-b', instanceOf: 'mi-a' }));
    expect(refused(b, 'setMaterial', inst({ materialId: 'mi-a', instanceOf: 'mi-b' })).message).toMatch(/loops/);
  });

  it('a parent with instances is not deleted, nor loses a parameter an instance sets', () => {
    const s = ok(base(), 'setMaterial', { material: { materialId: 'mi-red', name: 'Red', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-g', values: { tint: '#ff0000' } } });
    expect(refused(s, 'deleteMaterial', { materialId: 'mat-g' }).message).toMatch(/names no material/);
    expect(refused(s, 'setMaterial', { material: { ...GRAPH, parameters: [GRAPH.parameters![1]!] } }).message).toMatch(/no parameter "tint"/);
    // The shader of the parent changes only with its instances'.
    const sh = ok(s, 'setMaterial', { material: { materialId: 'mi-s', name: 'S', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-s' } });
    expect(refused(sh, 'setMaterial', { material: { ...SHADER, shader: 'unlit', params: {} } }).message).toMatch(/parent's shader/);
  });

  it('object, model-asset and block-type mappings name an instance; object overrides use its root parameters', () => {
    let s = ok(base(), 'setMaterial', { material: { materialId: 'mi-red', name: 'Red', shader: 'standard', params: {}, textures: {}, instanceOf: 'mat-g', values: { tint: '#ff0000' } } });
    s = ok(s, 'setComponent', { entityId: 'box-0001', component: 'materials', value: { '*': 'mi-red' } });
    s = ok(s, 'setComponent', { entityId: 'box-0001', component: 'materialParams', value: { 'mi-red': { gloss: 0.9 } } });
    expect(projectErrors(s)).toEqual([]);
    const wrong = ok(s, 'setComponent', { entityId: 'box-0001', component: 'materialParams', value: { 'mi-red': { nope: 1 } } });
    expect(projectErrors(wrong)[0]!.message).toMatch(/has no parameter "nope"/);
    s = ok(s, 'setAssetOptions', { assetId: 'asset-2b11d4a76c9f0e35', materials: { '*': 'mi-red' } });
    s = ok(s, 'setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full', materials: { '*': 'mi-red' } } });
    expect((s.content as { blockTypes?: { materials?: Record<string, string> }[] }).blockTypes?.[0]?.materials).toEqual({ '*': 'mi-red' });
    // Now the instance is in use: deleting it is refused like any used material.
    expect(refused(s, 'deleteMaterial', { materialId: 'mi-red' }).code).toBeDefined();
  });
});
