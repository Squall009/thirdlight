/**
 * Phase 14.6: `setAssetOptions {clipsFor}` marks an animation-only model as
 * clips for another model's rig (null clears it), one undo step; the
 * resulting-state check refuses the asset itself, a missing rig, a rig that
 * is itself clips-only and a bad value.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
const RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
const METRICS = { nodes: 2, meshes: 0, primitives: 0, materials: 0, images: 0, textures: 0, vertices: 0, triangles: 0, animations: 1, animationChannels: 1, clipDurationMs: 1000, decodedGeometryBytes: 0, decodedImageBytes: 0 };

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; ok: boolean; error?: { code: string } } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x146c00 + counter).toString(16).padStart(32, '0')}`, args });
  const result = out.result as unknown as { ok: boolean; error?: { code: string } };
  return { state: (out as { state?: State }).state ?? state, ok: result.ok, ...(result.error !== undefined ? { error: result.error } : {}) };
}
function withModels(): State {
  let s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content) as ContentDocument) as unknown as State;
  for (const [assetId, digest] of [['rig-0001', 'c'], ['moves-0001', 'd'], ['moves-0002', 'e']] as const) {
    const r = run(s, 'publishAsset', { mode: 'create', assetId, kind: 'model', sourceDigest: digest.repeat(64), sourceByteLength: 2048, importRecipe: RECIPE, metrics: METRICS, importedAt: '2026-09-24T00:00:00Z' });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    s = r.state;
  }
  return s;
}
const clipsFor = (s: State, id: string) => ((s.content as ContentDocument).assets.find((a) => a.assetId === id) as { clipsFor?: string } | undefined)?.clipsFor;

describe('setAssetOptions clipsFor', () => {
  it('marks a model as clips for another rig, clears it with null, with undo/redo', () => {
    const s = withModels();
    const marked = run(s, 'setAssetOptions', { assetId: 'moves-0001', clipsFor: 'rig-0001' });
    expect(marked.ok, JSON.stringify(marked.error)).toBe(true);
    expect(clipsFor(marked.state, 'moves-0001')).toBe('rig-0001');
    const undone = run(marked.state, 'undo', {});
    expect(clipsFor(undone.state, 'moves-0001')).toBeUndefined();
    expect(clipsFor(run(undone.state, 'redo', {}).state, 'moves-0001')).toBe('rig-0001');
    const cleared = run(marked.state, 'setAssetOptions', { assetId: 'moves-0001', clipsFor: null });
    expect(cleared.ok).toBe(true);
    expect(clipsFor(cleared.state, 'moves-0001')).toBeUndefined();
  });

  it('refuses itself, a missing rig, a clips-only rig and a non-string', () => {
    const s = withModels();
    expect(run(s, 'setAssetOptions', { assetId: 'moves-0001', clipsFor: 'moves-0001' }).ok).toBe(false);
    expect(run(s, 'setAssetOptions', { assetId: 'moves-0001', clipsFor: 'nope-0001' }).ok).toBe(false);
    expect(run(s, 'setAssetOptions', { assetId: 'moves-0001', clipsFor: 3 }).ok).toBe(false);
    const marked = run(s, 'setAssetOptions', { assetId: 'moves-0001', clipsFor: 'rig-0001' }).state;
    expect(run(marked, 'setAssetOptions', { assetId: 'moves-0002', clipsFor: 'moves-0001' }).ok).toBe(false);
  });
});
