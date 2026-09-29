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
    expect(message(run(fresh(), 'publishAsset', publish({ convertedFrom: { ...CONVERTED, encoding: 'raw' } })))).toMatch(/color.*normal.*data/);
    // Phase 25.21: "data" (UASTC, linear) is an encoding.
    expect(run(fresh(), 'publishAsset', publish({ convertedFrom: { ...CONVERTED, encoding: 'data' } })).ok).toBe(true);
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

describe('packed textures and texture arrays (phase 25.21)', () => {
  const ARRAY = { format: 'ktx2', width: 64, height: 64, decodedBytes: 64 * 64 * 4 * 3, codec: 'uastc', levels: 7, layers: 3 };
  const src = (assetId: string, channel: string): Record<string, unknown> => ({ assetId, digest: 'c'.repeat(64), channel });
  const PACKED = {
    layers: [
      [src('alb', 'r'), src('alb', 'g'), src('alb', 'b'), src('hgt', 'r')],
      [src('alb', 'r'), { value: 0 }, { value: 0 }, { value: 255 }],
      [{ value: 10 }, { value: 20 }, { value: 30 }, { value: 40 }],
    ],
    converter: { name: 'ktx2-encoder', version: '0.6.0' },
    encoding: 'data',
  };
  const packed = (extra: Record<string, unknown> = {}): Record<string, unknown> => publish({ assetId: 'tex-arr', convertedFrom: undefined, metrics: ARRAY, packedFrom: PACKED, ...extra });

  it('publishes a texture array with its layers and channel sources; queryAssets names them', () => {
    const r = run(fresh(), 'publishAsset', packed());
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    const rec = (r.state.content as unknown as { assets: { assetId: string; versions: { metrics: unknown; packedFrom?: unknown }[] }[] }).assets.find((a) => a.assetId === 'tex-arr')!;
    expect(rec.versions[0]!.metrics).toEqual(ARRAY);
    expect(rec.versions[0]!.packedFrom).toEqual(PACKED);
  });

  it('refuses a layer count that does not match, a bad channel, packedFrom with convertedFrom, a derived size that ignores the layers', () => {
    expect(message(run(fresh(), 'publishAsset', packed({ metrics: { ...ARRAY, layers: 2, decodedBytes: 64 * 64 * 4 * 2 } })))).toMatch(/one entry per layer/);
    expect(message(run(fresh(), 'publishAsset', packed({ packedFrom: { ...PACKED, layers: [[src('alb', 'x'), { value: 0 }, { value: 0 }, { value: 0 }], ...PACKED.layers.slice(1)] } })))).toMatch(/channel source/);
    expect(run(fresh(), 'publishAsset', packed({ convertedFrom: CONVERTED })).ok).toBe(false);
    expect(message(run(fresh(), 'publishAsset', packed({ metrics: { ...ARRAY, decodedBytes: 64 * 64 * 4 } })))).toMatch(/derived/);
    const one = run(fresh(), 'publishAsset', packed({ metrics: { ...ARRAY, layers: 1 } }));
    expect(JSON.stringify(one.result)).toMatch(/2-256 layers/);
  });

  it('a texture array is read by graph materials only (not a shader material slot, a cookie or the sky)', () => {
    const s = run(fresh(), 'publishAsset', packed()).state;
    const shader = run(s, 'setMaterial', { material: { materialId: 'mat-s', name: 'S', shader: 'standard', params: {}, textures: { map: 'tex-arr' } } });
    expect(shader.ok).toBe(false);
    expect(message(shader)).toMatch(/texture array/);
    const graph = run(s, 'setMaterial', {
      material: {
        materialId: 'mat-g',
        name: 'G',
        shader: 'standard',
        params: {},
        textures: {},
        parameters: [{ key: 'layers', type: 'texture', default: 'tex-arr' }],
        graph: {
          nodes: [
            { id: 'p', type: 'parameter', position: [0, 0], data: { key: 'layers' } },
            { id: 's', type: 'sampleTexture', position: [200, 0], data: { texture: 'tex-arr' } },
            { id: 'o', type: 'pbr', position: [400, 0] },
          ],
          edges: [
            { id: 'e1', from: { node: 'p', port: 'value' }, to: { node: 's', port: 'tex' } },
            { id: 'e2', from: { node: 's', port: 'rgb' }, to: { node: 'o', port: 'baseColor' } },
          ],
        },
      },
    });
    expect(graph.ok, JSON.stringify(graph.result).slice(0, 400)).toBe(true);
    const sky = run(s, 'setEnvironment', { environment: { sky: { mode: 'texture', texture: 'tex-arr' } } });
    expect(sky.ok).toBe(false);
  });
});
