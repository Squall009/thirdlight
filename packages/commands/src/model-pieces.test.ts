/**
 * Multi-piece models (2026-09-24): `model.piece`, a folder created with its
 * children in one transaction, and `setAssetOptions {vertexColors}` — each
 * with undo/redo.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument, MutationSuccess } from './index';
import { m3ContractJson } from './test-fixtures';

interface EnvelopeFixture {
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}

const BEFORE = m3ContractJson<EnvelopeFixture>('commands/scenario.before.json');
type State = CommandState<SceneV3>;

const MODEL_RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
const MODEL_METRICS = { nodes: 3, meshes: 3, primitives: 3, materials: 1, images: 0, textures: 0, vertices: 72, triangles: 36, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 1000, decodedImageBytes: 0 };
const AUDIO_RECIPE = { profile: 'pcm-wav', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } };
const AUDIO_METRICS = { container: 'riff-wave', encoding: 'pcm-s16le', channels: 1, sampleRate: 48000, bitsPerSample: 16, frames: 96, durationMs: 2, pcmBytes: 192, dataChunkBytes: 192, riffChunkBytes: 228 };

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x7b100 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: (out as { state?: State }).state ?? state, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; id: string; change: MutationSuccess['change'] } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, id: String(r.result.createdId ?? ''), change: (r.result as unknown as MutationSuccess).change };
}
function withKit(): State {
  let s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content) as unknown as ContentDocument) as unknown as State;
  s = ok(s, 'publishAsset', { mode: 'create', assetId: 'asset-kit', kind: 'model', sourceDigest: 'a'.repeat(64), sourceByteLength: 4096, importRecipe: MODEL_RECIPE, metrics: MODEL_METRICS, importedAt: '2026-09-24T00:00:00Z' }).state;
  s = ok(s, 'publishAsset', { mode: 'create', assetId: 'asset-sfx', kind: 'audio', sourceDigest: 'b'.repeat(64), sourceByteLength: 236, importRecipe: AUDIO_RECIPE, metrics: AUDIO_METRICS, importedAt: '2026-09-24T00:00:00Z' }).state;
  return s;
}
const entity = (s: State, id: string) => s.scene.entities.find((e) => e.id === id) as unknown as { id: string; parentId?: string; components: Record<string, unknown> } | undefined;
const box = [[0, 0], [1, 0], [1, 1], [0, 1]];

describe('model pieces', () => {
  it('a model entity keeps its piece; a bad piece is refused', () => {
    const s = withKit();
    const r = ok(s, 'createEntity', { kind: 'model', model: { asset: { assetId: 'asset-kit' }, piece: 'rock' }, name: 'rock' });
    expect(entity(r.state, r.id)?.components['model']).toEqual({ asset: { assetId: 'asset-kit' }, piece: 'rock' });
    expect(run(s, 'createEntity', { kind: 'model', model: { asset: { assetId: 'asset-kit' }, piece: '' } }).result.ok).toBe(false);
    expect(run(s, 'createEntity', { kind: 'model', model: { asset: { assetId: 'asset-kit' }, piece: 'x'.repeat(129) } }).result.ok).toBe(false);
    expect(run(s, 'createEntity', { kind: 'model', model: { asset: { assetId: 'asset-kit' }, part: 'rock' } }).result.ok).toBe(false);
  });
});

describe('a folder created with children', () => {
  it('creates the folder and every child in one transaction; one undo removes all; redo restores the same ids', () => {
    const s0 = withKit();
    const count0 = s0.scene.entities.length;
    const r = ok(s0, 'createEntity', {
      kind: 'folder',
      name: 'kit',
      children: [
        { kind: 'model', name: 'rock', model: { asset: { assetId: 'asset-kit' }, piece: 'rock' }, transform: { position: [0, 0, 0] }, components: { collider: { shape: { type: 'polygon', vertices: box } } } },
        { kind: 'model', name: 'flower', model: { asset: { assetId: 'asset-kit' }, piece: 'flower' }, transform: { position: [1.5, 0, 0] } },
      ],
    });
    expect(r.state.scene.entities.length).toBe(count0 + 3);
    const kids = r.state.scene.entities.filter((e) => (e as { parentId?: string }).parentId === r.id);
    expect(kids.map((k) => (k.components as { model?: { piece?: string } }).model?.piece)).toEqual(['rock', 'flower']);
    expect((kids[0]!.components as { collider?: unknown }).collider).toEqual({ shape: { type: 'polygon', vertices: box } });
    const change = r.change as { type: string; entity: { id: string }; children?: { id: string }[] };
    expect(change.type).toBe('createEntity');
    expect(change.children?.map((c) => c.id)).toEqual(kids.map((k) => k.id));

    const undone = ok(r.state, 'undo', {}).state;
    expect(undone.scene.entities.length).toBe(count0);
    const redone = ok(undone, 'redo', {}).state;
    expect(redone.scene.entities.map((e) => e.id)).toEqual(r.state.scene.entities.map((e) => e.id));
  });

  it('refuses children on a non-folder, a nested folder, a parentId inside a child, and a bad child (nothing is created)', () => {
    const s = withKit();
    const child = { kind: 'model', model: { asset: { assetId: 'asset-kit' }, piece: 'rock' } };
    expect(run(s, 'createEntity', { kind: 'group', children: [child] }).result.ok).toBe(false);
    expect(run(s, 'createEntity', { kind: 'folder', children: [{ kind: 'folder' }] }).result.ok).toBe(false);
    expect(run(s, 'createEntity', { kind: 'folder', children: [{ ...child, parentId: 'box-0001' }] }).result.ok).toBe(false);
    expect(run(s, 'createEntity', { kind: 'folder', children: [] }).result.ok).toBe(false);
    const bad = run(s, 'createEntity', { kind: 'folder', children: [child, { kind: 'model', model: { asset: { assetId: 'asset-nope' } } }] });
    expect(bad.result.ok).toBe(false);
    expect(bad.state.scene.entities.length).toBe(s.scene.entities.length);
    const badPath = run(s, 'createEntity', { kind: 'folder', children: [child, { kind: 'box', box: { size: 'big' } }] });
    expect((badPath.result as { error?: { path?: string } }).error?.path ?? (badPath.result as { path?: string }).path).toMatch(/^\/args\/children\/1\//);
  });
});

describe('setAssetOptions', () => {
  it('stores vertexColors "tint" on the record (data = absent), with undo/redo', () => {
    const s = withKit();
    const kit = (st: State) => (st.content as ContentDocument).assets.find((a) => a.assetId === 'asset-kit') as { vertexColors?: string };
    expect(kit(s).vertexColors).toBeUndefined();
    const tinted = ok(s, 'setAssetOptions', { assetId: 'asset-kit', vertexColors: 'tint' });
    expect(kit(tinted.state).vertexColors).toBe('tint');
    expect((tinted.change as { type: string }).type).toBe('setAssetOptions');
    const undone = ok(tinted.state, 'undo', {}).state;
    expect(kit(undone).vertexColors).toBeUndefined();
    expect(kit(ok(undone, 'redo', {}).state).vertexColors).toBe('tint');
    expect(kit(ok(tinted.state, 'setAssetOptions', { assetId: 'asset-kit', vertexColors: 'data' }).state).vertexColors).toBeUndefined();
  });

  it('refuses an unknown asset, an audio asset and a bad mode', () => {
    const s = withKit();
    expect(run(s, 'setAssetOptions', { assetId: 'asset-nope', vertexColors: 'tint' }).result.ok).toBe(false);
    expect(run(s, 'setAssetOptions', { assetId: 'asset-sfx', vertexColors: 'tint' }).result.ok).toBe(false);
    expect(run(s, 'setAssetOptions', { assetId: 'asset-kit', vertexColors: 'red' }).result.ok).toBe(false);
    expect(run(s, 'setAssetOptions', { assetId: 'asset-kit' }).result.ok).toBe(false);
  });
});
