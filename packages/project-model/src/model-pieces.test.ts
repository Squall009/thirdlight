/**
 * Multi-piece models (2026-09-24): the optional `piece` on `components.model`
 * and on an instance set's asset, and the optional `vertexColors: "tint"` on a
 * model asset record. Both survive canonicalization.
 */
import { describe, expect, it } from 'vitest';

import { validateContentV4 } from './content';
import { validateSceneV4 } from './scene-v3';

const SAMPLE_RAW = Object.values(
  import.meta.glob('../../../samples/beacon-reach/captured/project.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>,
)[0] as string;
const SAMPLE = JSON.parse(SAMPLE_RAW) as { content: { assets: { assetId: string; kind: string }[] } };
const MODEL = SAMPLE.content.assets.find((a) => a.kind === 'model')!;
const AUDIO = SAMPLE.content.assets.find((a) => a.kind === 'audio');
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-a', revision: 1, entities });
const content = (assets: unknown[]) => ({
  assets,
  prefabs: [],
  behaviors: [],
  settings: {},
  behaviorTrust: { entries: [] },
  game: null,
  scenes: [{ sceneId: 'scene-a', name: 'A' }],
  startScenes: ['scene-a'],
});

describe('model piece', () => {
  it('is kept on a model component and on an instance set asset', () => {
    const r = validateSceneV4(
      scene([
        { id: 'model-0001', components: { transform: T, model: { asset: { assetId: MODEL.assetId }, piece: 'rock' } } },
        { id: 'grass-0001', components: { transform: T, instances: { asset: { assetId: MODEL.assetId, piece: 'fern' }, buffer: 'ab'.repeat(32), count: 3 } } },
      ]),
    );
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    if (!r.ok) return;
    const [m, g] = r.normalized.entities as unknown as { components: Record<string, unknown> }[];
    expect(m!.components['model']).toEqual({ asset: { assetId: MODEL.assetId }, piece: 'rock' });
    expect((g!.components['instances'] as { asset: unknown }).asset).toEqual({ assetId: MODEL.assetId, piece: 'fern' });
  });

  it('refuses an empty, overlong or non-string piece', () => {
    for (const piece of ['', 'x'.repeat(129), 7, 'a\nb']) {
      expect(validateSceneV4(scene([{ id: 'model-0001', components: { transform: T, model: { asset: { assetId: MODEL.assetId }, piece } } }])).ok).toBe(false);
    }
  });
});

describe('asset vertexColors', () => {
  it('a model record may say "tint" (absent = shader data) and keeps it through canonicalization', () => {
    const r = validateContentV4(content([{ ...MODEL, vertexColors: 'tint' }]));
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    if (r.ok) expect((r.normalized.assets[0] as { vertexColors?: string }).vertexColors).toBe('tint');
  });

  it('refuses any other value, and the field on an audio record', () => {
    expect(validateContentV4(content([{ ...MODEL, vertexColors: 'data' }])).ok).toBe(false);
    expect(validateContentV4(content([{ ...MODEL, vertexColors: true }])).ok).toBe(false);
    if (AUDIO !== undefined) expect(validateContentV4(content([MODEL, { ...AUDIO, vertexColors: 'tint' }])).ok).toBe(false);
  });
});
