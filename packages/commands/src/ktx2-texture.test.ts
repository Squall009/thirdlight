/**
 * Phase 25.19: a KTX2 texture version through `publishAsset` — the KTX2
 * metrics (codec, mip levels) and the `convertedFrom` of a PNG encoded at
 * import are kept in canonical form; the model refuses a converted texture
 * that is not a KTX2 and an encoding it does not know, and an image the page
 * draws (a UI image) naming a KTX2.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { ok: boolean; state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x2519f00 + counter).toString(16).padStart(32, '0')}`, args });
  return { ok: out.ok, state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const message = (r: { result: Record<string, unknown> }): string => {
  const e = r.result['error'] as { message: string; details?: { message: string }[] };
  return e.details?.[0]?.message ?? e.message;
};

const METRICS = { format: 'ktx2', width: 64, height: 64, decodedBytes: 64 * 64 * 4, codec: 'etc1s', levels: 7 };
const CONVERTED = { format: 'png', sourceDigest: 'b'.repeat(64), sourceByteLength: 900, converter: { name: 'ktx2-encoder', version: '0.6.0' }, encoding: 'color' };
const publish = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'create',
  assetId: 'tex-k',
  kind: 'texture',
  displayName: 'Checker',
  sourceDigest: 'a'.repeat(64),
  sourceByteLength: 4000,
  importRecipe: { profile: 'image', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } },
  metrics: METRICS,
  convertedFrom: CONVERTED,
  importedAt: '2026-09-29T00:00:00Z',
  ...extra,
});

describe('KTX2 texture versions (phase 25.19)', () => {
  it('publishes a KTX2 encoded from a PNG with its facts and original', () => {
    const r = run(fresh(), 'publishAsset', publish());
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    const rec = (r.state.content as unknown as { assets: { assetId: string; versions: { metrics: unknown; convertedFrom?: unknown }[] }[] }).assets.find((a) => a.assetId === 'tex-k')!;
    expect(rec.versions[0]!.metrics).toEqual(METRICS);
    expect(rec.versions[0]!.convertedFrom).toEqual(CONVERTED);
    // A KTX2 imported as is: no convertedFrom.
    expect(run(fresh(), 'publishAsset', publish({ convertedFrom: undefined })).ok).toBe(true);
  });

  it('refuses a converted texture that is not KTX2, an unknown encoding, missing codec facts', () => {
    expect(message(run(fresh(), 'publishAsset', publish({ metrics: { format: 'png', width: 64, height: 64, decodedBytes: 64 * 64 * 4 } })))).toMatch(/holds the KTX2/);
    expect(message(run(fresh(), 'publishAsset', publish({ convertedFrom: { ...CONVERTED, encoding: 'data' } })))).toMatch(/color.*normal/);
    expect(message(run(fresh(), 'publishAsset', publish({ convertedFrom: { ...CONVERTED, converter: { name: 'blender', version: '4.2' } } })))).toMatch(/ktx2-encoder/);
    expect(message(run(fresh(), 'publishAsset', publish({ metrics: { ...METRICS, levels: 0 } })))).toMatch(/mip levels/);
  });

  it('a UI image cannot name a KTX2 texture (the page draws it)', () => {
    const s = run(fresh(), 'publishAsset', publish()).state;
    const doc = (image: string): Record<string, unknown> => ({ document: { uiDocumentId: 'hud', name: 'HUD', root: { type: 'image', image } } });
    const refused = run(s, 'setUiDocument', doc('tex-k'));
    expect(refused.ok).toBe(false);
    expect(message(refused)).toMatch(/cannot be a KTX2/);
  });
});
