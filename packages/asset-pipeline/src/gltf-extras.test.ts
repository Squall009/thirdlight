/**
 * Phase 25.6 (E19): glTF `extras` (application data an exporter such as
 * Blender writes from custom properties) are accepted and ignored on every
 * glTF object — the root, the asset, scenes, nodes, meshes, primitives,
 * accessors, buffer views, buffers, materials and their texture references,
 * textures, images, samplers, animations and their channels/samplers, skins
 * and cameras.
 */
import { describe, expect, it } from 'vitest';

import { inspectGlb, type ImportProposal } from './index';
import { buildGlb, cloneJson, splitGlb } from './test-glb';
import { fixtureBytes } from './test-fixtures';

const base = splitGlb(fixtureBytes('tiny-v1.glb'));

/** A 1×1 RGBA PNG (a real, decodable image). */
const PNG_1X1 = Uint8Array.from(
  atobBytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
);

function atobBytes(b64: string): number[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of b64.replace(/=+$/, '')) {
    buffer = (buffer << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * tiny-v1 grown to hold every object kind: UVs, a texture on every material
 * slot (an embedded PNG), a skin, a morph target and a camera.
 */
function everyKind(): { json: Record<string, unknown>; bin: Uint8Array } {
  const json = cloneJson(base.json) as Record<string, unknown>;
  const at = (n: number): number => (n + 3) & ~3;
  const uvOffset = at(base.bin.length);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const pngOffset = at(uvOffset + uv.byteLength);
  const bin = new Uint8Array(at(pngOffset + PNG_1X1.length));
  bin.set(base.bin, 0);
  bin.set(new Uint8Array(uv.buffer), uvOffset);
  bin.set(PNG_1X1, pngOffset);
  (json['buffers'] as Record<string, unknown>[])[0]!['byteLength'] = bin.length;
  const views = json['bufferViews'] as Record<string, unknown>[];
  views.push({ buffer: 0, byteOffset: uvOffset, byteLength: uv.byteLength, target: 34962 });
  views.push({ buffer: 0, byteOffset: pngOffset, byteLength: PNG_1X1.length });
  const accessors = json['accessors'] as Record<string, unknown>[];
  accessors.push({ bufferView: views.length - 2, componentType: 5126, count: 3, type: 'VEC2' });
  const prim = (json['meshes'] as { primitives: Record<string, unknown>[] }[])[0]!.primitives[0]!;
  (prim['attributes'] as Record<string, number>)['TEXCOORD_0'] = accessors.length - 1;
  prim['targets'] = [{ POSITION: 0 }];
  json['images'] = [{ bufferView: views.length - 1, mimeType: 'image/png' }];
  json['samplers'] = [{ magFilter: 9729, minFilter: 9729 }];
  json['textures'] = [{ source: 0, sampler: 0 }];
  const mat = (json['materials'] as Record<string, unknown>[])[0]!;
  const pbr = mat['pbrMetallicRoughness'] as Record<string, unknown>;
  pbr['baseColorTexture'] = { index: 0 };
  pbr['metallicRoughnessTexture'] = { index: 0 };
  mat['normalTexture'] = { index: 0, scale: 1 };
  mat['occlusionTexture'] = { index: 0, strength: 1 };
  mat['emissiveTexture'] = { index: 0 };
  const nodes = json['nodes'] as Record<string, unknown>[];
  nodes.push({ name: 'Joint' }, { name: 'Eye', camera: 0 });
  (nodes[0]!['children'] as number[]).push(2, 3);
  json['skins'] = [{ joints: [2] }];
  json['cameras'] = [{ type: 'perspective', perspective: { yfov: 0.8, znear: 0.1 } }];
  return { json, bin };
}

/** Maps whose keys are names, not glTF properties (an `extras` key there would be a name). */
const NAME_MAPS = new Set(['attributes', 'extensions']);

/** Put `extras` on every glTF object of the document (not inside extras, and not as a key of a name map). */
function addExtrasEverywhere(value: unknown, key: string | null, inTargets: boolean): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + addExtrasEverywhere(v, key, key === 'targets'), 0);
  if (typeof value !== 'object' || value === null) return 0;
  const obj = value as Record<string, unknown>;
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'extras') continue;
    n += addExtrasEverywhere(v, k, false);
  }
  if ((key !== null && NAME_MAPS.has(key)) || inTargets) return n;
  obj['extras'] = { note: 'from a DCC tool', props: { weight: 2, tags: ['a', 'b'] } };
  return n + 1;
}

function inspect(json: Record<string, unknown>, bin: Uint8Array): ImportProposal {
  return inspectGlb(buildGlb(json, bin), { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' } });
}

describe('glTF extras (phase 25.6)', () => {
  it('the grown fixture is accepted as it is', () => {
    const { json, bin } = everyKind();
    const p = inspect(json, bin);
    expect(p.status, JSON.stringify(p.diagnostics).slice(0, 600)).toBe('ok');
  });

  it('extras on every glTF object are accepted and do not change what the import records', () => {
    const plain = everyKind();
    const withExtras = everyKind();
    const count = addExtrasEverywhere(withExtras.json, null, false);
    expect(count).toBeGreaterThan(30);
    for (const k of ['asset', 'materials', 'textures', 'images', 'samplers', 'animations', 'skins', 'cameras', 'nodes', 'accessors', 'bufferViews', 'buffers', 'meshes', 'scenes']) {
      expect(JSON.stringify(withExtras.json[k]), k).toContain('"extras"');
    }
    const p = inspect(withExtras.json, withExtras.bin);
    expect(p.status, JSON.stringify(p.diagnostics).slice(0, 600)).toBe('ok');
    const q = inspect(plain.json, plain.bin);
    expect(p.metrics).toEqual(q.metrics);
  });

  it('extras of any JSON type on a material and its PBR block are ignored', () => {
    for (const extras of [{}, 'text', 3, [1, 2], null, true]) {
      const { json, bin } = everyKind();
      const mat = (json['materials'] as Record<string, unknown>[])[1]!;
      mat['extras'] = extras;
      (mat['pbrMetallicRoughness'] as Record<string, unknown>)['extras'] = extras;
      const p = inspect(json, bin);
      expect(p.status, `${JSON.stringify(extras)}: ${JSON.stringify(p.diagnostics).slice(0, 300)}`).toBe('ok');
    }
  });
});
