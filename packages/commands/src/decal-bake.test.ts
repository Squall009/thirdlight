/**
 * "Bake to model" as one command: a model `publishAsset` with `bakeDecal`
 * publishes the record with its material map and swaps the object's clipped
 * decal for a model of it in one change and one history entry; one undo
 * takes all of it back, one redo puts all of it back; a refusal (no clipped
 * decal, a model already there, an asset id in use, not a model create)
 * changes nothing.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
type Entity = { id: string; components: Record<string, unknown> };
type Asset = { assetId: string; materials?: Record<string, string> };

const RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
const METRICS = { nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0, vertices: 120, triangles: 80, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 6000, decodedImageBytes: 0 };
const T = { position: [0, 0, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const CLIPPED = { size: [2, 1, 0.5], material: 'mat-crack', mode: 'clipped', sortOrder: 2 };

function state(): State {
  const scene = structuredClone(BEFORE.scene) as unknown as { entities: Entity[] };
  scene.entities.push({ id: 'decal-000001', components: { transform: T, decal: CLIPPED } });
  scene.entities.push({ id: 'decal-000002', components: { transform: T, decal: { size: [1, 1, 1], material: 'mat-crack' } } });
  const onModel = scene.entities.find((e) => e.id === 'model-0001')!;
  onModel.components = { ...onModel.components, decal: CLIPPED };
  const content = { ...structuredClone(BEFORE.content), materials: [{ materialId: 'mat-crack', name: 'Crack', shader: 'decal', params: { blend: 'multiply' }, textures: {} }] };
  return createCommandState(scene as unknown as SceneV4, content as unknown as ContentDocument) as unknown as State;
}

let counter = 0;
function run(s: State, op: string, args: Record<string, unknown>): { ok: boolean; state: State; result: Record<string, unknown>; code: string } {
  counter += 1;
  const out = applyMutation(s, { op, projectId: BEFORE.projectId, expectedRevision: s.scene.revision, requestId: `req-${(0x5b0000 + counter).toString(16).padStart(32, '0')}`, args });
  const result = out.result as unknown as Record<string, unknown> & { ok: boolean; error?: { code: string } };
  return { ok: result.ok, state: ((out as { state?: State }).state ?? s) as State, result, code: result.error?.code ?? '' };
}

const bake = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'create',
  assetId: 'baked-0001',
  kind: 'model',
  displayName: 'Crack (baked decal)',
  sourceDigest: 'a'.repeat(64),
  sourceByteLength: 9000,
  sourcePath: 'assets/baked-decal.glb',
  importRecipe: RECIPE,
  metrics: METRICS,
  importedAt: '2026-10-11T00:00:00Z',
  bakeDecal: { entityId: 'decal-000001' },
  ...extra,
});

const entity = (s: State, id: string): Entity => (s.scene.entities as unknown as Entity[]).find((e) => e.id === id)!;
const asset = (s: State, id: string): Asset | undefined => (s.content!.assets as unknown as Asset[]).find((a) => a.assetId === id);

describe('bake a clipped decal to a model in one command', () => {
  it('publishes the record with its material map and swaps the decal for the model in one change; one undo and one redo take all of it', () => {
    const s0 = state();
    const r = run(s0, 'publishAsset', bake());
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    expect(asset(r.state, 'baked-0001')?.materials).toEqual({ 'mat-crack_decal': 'mat-crack' });
    expect(entity(r.state, 'decal-000001').components['decal']).toBeUndefined();
    expect(entity(r.state, 'decal-000001').components['model']).toEqual({ asset: { assetId: 'baked-0001' } });
    // One revision, one history entry; the change names the components clients take.
    expect(r.result['revision']).toBe(s0.scene.revision + 1);
    expect(r.state.history.entries.length).toBe(s0.history.entries.length + 1);
    const change = r.result['change'] as { type: string; follows?: { entityId: string; component: string; next: unknown }[] };
    expect(change.type).toBe('publishAsset');
    expect(change.follows).toEqual([
      { entityId: 'decal-000001', component: 'decal', next: null },
      { entityId: 'decal-000001', component: 'model', next: { asset: { assetId: 'baked-0001' } } },
    ]);

    const u = run(r.state, 'undo', {});
    expect(u.ok, JSON.stringify(u.result)).toBe(true);
    expect(asset(u.state, 'baked-0001')).toBeUndefined();
    expect(entity(u.state, 'decal-000001').components).toEqual(entity(s0, 'decal-000001').components);
    expect(u.state.content!.assets).toEqual(s0.content!.assets);
    expect((u.result['change'] as { follows?: unknown[] }).follows).toEqual([
      { entityId: 'decal-000001', component: 'decal', next: entity(s0, 'decal-000001').components['decal'] },
      { entityId: 'decal-000001', component: 'model', next: null },
    ]);

    const again = run(u.state, 'redo', {});
    expect(again.ok, JSON.stringify(again.result)).toBe(true);
    expect(asset(again.state, 'baked-0001')?.materials).toEqual({ 'mat-crack_decal': 'mat-crack' });
    expect(entity(again.state, 'decal-000001').components).toEqual(entity(r.state, 'decal-000001').components);
  });

  it('a refusal changes nothing', () => {
    const s0 = state();
    const existing = (s0.content!.assets as unknown as Asset[])[0]!.assetId;
    const cases: [Record<string, unknown>, string][] = [
      [bake({ bakeDecal: { entityId: 'box-0001' } }), 'component_missing'],
      [bake({ bakeDecal: { entityId: 'decal-000002' } }), 'component_conflict'],
      [bake({ bakeDecal: { entityId: 'model-0001' } }), 'component_conflict'],
      [bake({ bakeDecal: { entityId: 'nobody-0001' } }), 'entity_not_found'],
      [bake({ assetId: existing }), 'asset_id_duplicate'],
      [bake({ mode: 'reimport', assetId: existing }), 'field_unexpected'],
      [bake({ kind: 'audio' }), 'field_unexpected'],
      [bake({ bakeDecal: { entityId: 'decal-000001', material: 'mat-crack' } }), 'field_unexpected'],
    ];
    for (const [args, code] of cases) {
      const r = run(s0, 'publishAsset', args);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(r.code, JSON.stringify(r.result)).toBe(code);
      expect(r.state).toBe(s0);
    }
    expect(s0.history.entries.length).toBe(0);
  });
});
