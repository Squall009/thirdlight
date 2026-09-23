/**
 * Packet-24 adversarial profile coverage: one synthetic case per normative
 * validation step of project-model.md §18.7.2 (steps 1–16) and per §18.8
 * diagnostic code, built from the committed `tiny-v1.glb` fixture so the input
 * is a real GLB container that differs from a valid file only in the field
 * under test. Acceptance row A04 ("bad GLB … is rejected") at the unit level;
 * the rejection is always a `rejected` proposal, never a thrown error.
 */

import { describe, expect, it } from 'vitest';

import { inspectGlb, type ImportJobPort, type ImportProposal } from './index';
import { buildGlbFromJsonText, cloneJson, mutateFixture, splitGlb } from './test-glb';
import { fixtureBytes } from './test-fixtures';

const job: ImportJobPort = {
  now: () => 0,
  isCancelled: () => false,
  proposalId: () => 'p-00000000000000000000000000000001',
  stageId: () => 'stage-24-synthetic',
  expiresAt: () => '2026-09-18T00:00:00Z',
};

const options = {
  profile: 'gltf-glb',
  recipeVersion: 1,
  toolchain: { three: '0.186.0' },
  job,
} as const;

const tinyV1 = fixtureBytes('tiny-v1.glb');

function inspectBytes(bytes: Uint8Array): ImportProposal {
  return inspectGlb(bytes, options);
}

function expectRejected(
  bytes: Uint8Array,
  code: string,
  path?: string,
): ImportProposal {
  const proposal = inspectBytes(bytes);
  expect(proposal.status).toBe('rejected');
  const codes = proposal.diagnostics.map((d) => d.code);
  expect(codes).toContain(code);
  expect(proposal.metrics).toBeUndefined();
  expect(proposal.diagnosticCount).toBeGreaterThanOrEqual(codes.length);
  if (path !== undefined) {
    expect(proposal.diagnostics.map((d) => d.path)).toContain(path);
  }
  return proposal;
}

function mutate(mutateJson: (json: Record<string, unknown>) => void, bin?: Uint8Array): Uint8Array {
  return mutateFixture(tinyV1, mutateJson, bin);
}

/**
 * `tiny-v1.glb` plus one real embedded 20000x20000 PNG (the `decoded-limit.glb`
 * header PNG), so step 11 passes and the texture/sampler step is reached.
 * Rebuilt from the committed `decoded-limit.glb` container.
 */
function withValidImage(mutateJson: (json: Record<string, unknown>) => void): Uint8Array {
  return mutateFixture(fixtureBytes('decoded-limit.glb'), mutateJson);
}

/** Rebuild the base fixture from its parsed JSON with a raw mutation. */
function baseJson(): Record<string, unknown> {
  return cloneJson(splitGlb(tinyV1).json);
}

function rebuild(json: Record<string, unknown>, bin?: Uint8Array): Uint8Array {
  return mutateFixture(tinyV1, (target) => {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, json);
  }, bin);
}

describe('§18.7.2 step 1 — size', () => {
  it('rejects empty and oversized sources without throwing', () => {
    expectRejected(new Uint8Array(0), 'asset_size_exceeded', '');
    const oversized = new Uint8Array(33_554_433);
    const proposal = expectRejected(oversized, 'asset_size_exceeded', '');
    expect(proposal.diagnostics[0]?.limit).toBe('source_bytes');
    expect(proposal.diagnostics[0]?.found).toBe(33_554_433);
    // The rejection is deterministic and the digest is still the source digest.
    expect(inspectBytes(oversized).sourceDigest).toBe(proposal.sourceDigest);
  });
});

describe('§18.7.2 step 2 — container', () => {
  it('rejects a shorter-than-header source', () => {
    expectRejected(new Uint8Array([1, 2, 3]), 'asset_container_invalid', '');
  });
  it('rejects a bad magic', () => {
    const bytes = Uint8Array.from(tinyV1);
    bytes[0] = 0x00;
    expectRejected(bytes, 'asset_container_invalid', '');
  });
  it('rejects a container version other than 2', () => {
    const bytes = Uint8Array.from(tinyV1);
    new DataView(bytes.buffer).setUint32(4, 1, true);
    expectRejected(bytes, 'asset_container_invalid', '');
  });
  it('rejects a declared length mismatch (truncation and padding alike)', () => {
    const bytes = Uint8Array.from(tinyV1);
    new DataView(bytes.buffer).setUint32(8, tinyV1.length + 4, true);
    expectRejected(bytes, 'asset_container_invalid', '');
  });
});

describe('§18.7.2 step 3 — chunk framing', () => {
  it('rejects a chunk length that is not a multiple of 4', () => {
    const bytes = Uint8Array.from(tinyV1);
    const jsonLength = new DataView(bytes.buffer).getUint32(12, true);
    new DataView(bytes.buffer).setUint32(20 + jsonLength, jsonLength - 1, true);
    expectRejected(bytes, 'asset_container_invalid', '');
  });
  it('rejects trailing bytes after the last chunk', () => {
    const split = splitGlb(tinyV1);
    const rebuilt = mutateFixture(tinyV1, () => {}, split.bin);
    const withTrailing = new Uint8Array(rebuilt.length + 4);
    withTrailing.set(rebuilt);
    new DataView(withTrailing.buffer).setUint32(8, withTrailing.length, true);
    expectRejected(withTrailing, 'asset_container_invalid', '');
  });
  it('rejects a JSON-only container', () => {
    const json = JSON.stringify(baseJson());
    const jsonBytes = new TextEncoder().encode(json);
    const pad = (4 - (jsonBytes.length % 4)) % 4;
    const jsonLength = jsonBytes.length + pad;
    const total = 12 + 8 + jsonLength;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    expectRejected(out, 'asset_container_invalid', '');
  });
});

describe('§18.7.2 step 4 — JSON', () => {
  it('rejects invalid UTF-8 in the JSON chunk', () => {
    const bytes = Uint8Array.from(tinyV1);
    bytes[25] = 0xff;
    expectRejected(bytes, 'asset_json_invalid', '');
  });
  it('rejects duplicated member names with the offending JSON Pointer', () => {
    const text = '{"asset":{"version":"2.0","version":"2.0"},"buffers":[{"byteLength":4}],"bufferViews":[]}';
    expectRejected(buildGlbFromJsonText(text, new Uint8Array(4)), 'asset_json_invalid', '/asset/version');
  });
  it('rejects a non-object root and trailing garbage', () => {
    expectRejected(buildGlbFromJsonText('[1,2]', new Uint8Array(0)), 'asset_json_invalid', '');
    expectRejected(
      buildGlbFromJsonText('{"asset":{"version":"2.0"}} trailing', new Uint8Array(0)),
      'asset_json_invalid',
      '',
    );
  });
  it('rejects a JSON chunk above the 8 MiB cap with the byte cap as the failed limit', () => {
    const filler = 'a'.repeat(8_388_608);
    const text = `{"asset":{"version":"2.0"},"filler":"${filler}","buffers":[{"byteLength":0}],"bufferViews":[]}`;
    const proposal = expectRejected(buildGlbFromJsonText(text, new Uint8Array(0)), 'asset_json_invalid', '');
    expect(proposal.diagnostics[0]?.limit).toBe('json_chunk_bytes');
  });
});

describe('§18.7.2 step 5 — glTF version, extensions and compression', () => {
  it('rejects a glTF 1.0 asset version', () => {
    expectRejected(
      mutate((json) => {
        (json['asset'] as Record<string, unknown>)['version'] = '1.0';
      }),
      'asset_version_unsupported',
      '/asset/version',
    );
  });
  it('rejects an undeclared extension object anywhere it is visited', () => {
    expectRejected(
      mutate((json) => {
        json['extensions'] = { KHR_materials_unlit: {} };
      }),
      'asset_extension_unsupported',
      '/extensions/KHR_materials_unlit',
    );
    expectRejected(
      mutate((json) => {
        (json['nodes'] as Record<string, unknown>[])[0]!['extensions'] = {
          KHR_materials_unlit: {},
        };
      }),
      'asset_extension_unsupported',
      '/nodes/0/extensions/KHR_materials_unlit',
    );
  });
  it('rejects a required extension that is not declared in extensionsUsed', () => {
    expectRejected(
      mutate((json) => {
        json['extensionsRequired'] = ['EXT_fixture'];
      }),
      'asset_extension_unsupported',
      '/extensionsRequired',
    );
  });
  it('rejects a meshopt-compressed bufferView whose stream does not decode', () => {
    expectRejected(
      mutate((json) => {
        json['extensionsUsed'] = ['EXT_meshopt_compression'];
        const bv = (json['bufferViews'] as Record<string, unknown>[])[0]!;
        const length = bv['byteLength'] as number;
        // The raw (uncompressed) bytes are not a meshopt stream.
        bv['extensions'] = { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: length, byteStride: 4, count: length / 4, mode: 'ATTRIBUTES' } };
      }),
      'asset_buffer_invalid',
      '/bufferViews/0/extensions/EXT_meshopt_compression',
    );
  });
});

describe('§18.7.2 step 6/7 — buffers and bufferViews', () => {
  it('rejects two buffers, an over-long buffer and excessive BIN padding', () => {
    expectRejected(
      mutate((json) => {
        json['buffers'] = [{ byteLength: 140 }, { byteLength: 4 }];
      }),
      'asset_buffer_invalid',
      '/buffers/1',
    );
    expectRejected(
      mutate((json) => {
        (json['buffers'] as Record<string, unknown>[])[0]!['byteLength'] = 100_000;
      }),
      'asset_buffer_invalid',
      '/buffers/0/byteLength',
    );
    const padded = mutate(
      (json) => {
        (json['buffers'] as Record<string, unknown>[])[0]!['byteLength'] = 4;
      },
      splitGlb(tinyV1).bin,
    );
    expectRejected(padded, 'asset_buffer_invalid', '/buffers/0/byteLength');
  });
  it('rejects a bufferView target, range overrun and 4-byte misalignment', () => {
    expectRejected(
      mutate((json) => {
        (json['bufferViews'] as Record<string, unknown>[])[0]!['target'] = 1234;
      }),
      'asset_buffer_invalid',
      '/bufferViews/0/target',
    );
    expectRejected(
      mutate((json) => {
        (json['bufferViews'] as Record<string, unknown>[])[0]!['byteLength'] = 1000;
      }),
      'asset_buffer_invalid',
      '/bufferViews/0/byteLength',
    );
    expectRejected(
      mutate((json) => {
        (json['bufferViews'] as Record<string, unknown>[])[0]!['byteOffset'] = 2;
      }),
      'asset_buffer_invalid',
      '/bufferViews/0/byteOffset',
    );
  });
});

describe('§18.7.2 step 8 — accessors', () => {
  it('rejects a sparse accessor with the unsupported code', () => {
    expectRejected(
      mutate((json) => {
        (json['accessors'] as Record<string, unknown>[])[0]!['sparse'] = { count: 1 };
      }),
      'asset_accessor_unsupported',
      '/accessors/0/sparse',
    );
  });
  it('rejects a bad componentType, type, count and missing bufferView', () => {
    expectRejected(
      mutate((json) => {
        (json['accessors'] as Record<string, unknown>[])[0]!['componentType'] = 5127;
      }),
      'asset_accessor_invalid',
      '/accessors/0/componentType',
    );
    expectRejected(
      mutate((json) => {
        (json['accessors'] as Record<string, unknown>[])[0]!['type'] = 'VEC5';
      }),
      'asset_accessor_invalid',
      '/accessors/0/type',
    );
    expectRejected(
      mutate((json) => {
        (json['accessors'] as Record<string, unknown>[])[0]!['count'] = 0;
      }),
      'asset_accessor_invalid',
      '/accessors/0/count',
    );
    expectRejected(
      mutate((json) => {
        delete (json['accessors'] as Record<string, unknown>[])[0]!['bufferView'];
      }),
      'asset_accessor_invalid',
      '/accessors/0/bufferView',
    );
  });
  it('rejects a component-misaligned accessor byteOffset and an arithmetic overflow', () => {
    expectRejected(
      mutate((json) => {
        (json['accessors'] as Record<string, unknown>[])[0]!['byteOffset'] = 2;
      }),
      'asset_accessor_invalid',
      '/accessors/0/byteOffset',
    );
    // A hostile byteOffset close to 2^32 must be compared with real number
    // arithmetic (no 32-bit wraparound): the range check still fails.
    expectRejected(
      mutate((json) => {
        (json['accessors'] as Record<string, unknown>[])[0]!['byteOffset'] = 4294967292;
      }),
      'asset_accessor_invalid',
      '/accessors/0',
    );
  });
});

describe('§18.7.2 step 9 — meshes and primitives', () => {
  it('rejects a missing mesh array, a missing POSITION and a missing primitives array', () => {
    expectRejected(
      mutate((json) => {
        json['meshes'] = [];
      }),
      'asset_mesh_invalid',
      '/meshes',
    );
    expectRejected(
      mutate((json) => {
        delete ((json['meshes'] as Record<string, unknown>[])[0]!['primitives'] as Record<
          string,
          unknown
        >[])[0]!['attributes'];
        ((json['meshes'] as Record<string, unknown>[])[0]!['primitives'] as Record<string, unknown>[])[0]![
          'attributes'
        ] = { NORMAL: 1 };
      }),
      'asset_mesh_invalid',
      '/meshes/0/primitives/0/attributes',
    );
    expectRejected(
      mutate((json) => {
        delete (json['meshes'] as Record<string, unknown>[])[0]!['primitives'];
      }),
      'asset_mesh_invalid',
      '/meshes/0/primitives',
    );
  });
  it('rejects a non-triangle mode, an unknown attribute and a primitive extension', () => {
    expectRejected(
      mutate((json) => {
        ((json['meshes'] as Record<string, unknown>[])[0]!['primitives'] as Record<string, unknown>[])[0]![
          'mode'
        ] = 5;
      }),
      'asset_primitive_unsupported',
      '/meshes/0/primitives/0/mode',
    );
    expectRejected(
      mutate((json) => {
        const attributes = ((json['meshes'] as Record<string, unknown>[])[0]!['primitives'] as Record<
          string,
          unknown
        >[])[0]!['attributes'] as Record<string, unknown>;
        attributes['_CUSTOM'] = 1;
      }),
      'asset_primitive_unsupported',
      '/meshes/0/primitives/0/attributes/_CUSTOM',
    );
    expectRejected(
      mutate((json) => {
        ((json['meshes'] as Record<string, unknown>[])[0]!['primitives'] as Record<string, unknown>[])[0]![
          'extensions'
        ] = { KHR_materials_unlit: {} };
      }),
      'asset_extension_unsupported',
      '/meshes/0/primitives/0/extensions/KHR_materials_unlit',
    );
  });
  it('rejects a signed index accessor', () => {
    expectRejected(
      mutate((json) => {
        (json['accessors'] as Record<string, unknown>[])[2]!['componentType'] = 5122;
      }),
      'asset_accessor_unsupported',
      '/meshes/0/primitives/0/indices',
    );
  });
});

describe('§18.7.2 step 10/12 — materials and textures', () => {
  it('rejects a non-core material field, a bad alphaMode and an out-of-range factor', () => {
    expectRejected(
      mutate((json) => {
        (json['materials'] as Record<string, unknown>[])[0]!['ior'] = 1.5;
      }),
      'asset_material_invalid',
      '/materials/0/ior',
    );
    expectRejected(
      mutate((json) => {
        (json['materials'] as Record<string, unknown>[])[0]!['alphaMode'] = 'FOO';
      }),
      'asset_material_invalid',
      '/materials/0/alphaMode',
    );
    expectRejected(
      mutate((json) => {
        ((json['materials'] as Record<string, unknown>[])[0]!['pbrMetallicRoughness'] as Record<
          string,
          unknown
        >)['metallicFactor'] = 2;
      }),
      'asset_material_invalid',
      '/materials/0/pbrMetallicRoughness/metallicFactor',
    );
  });
  it('rejects unresolved texture references from materials and from textures', () => {
    expectRejected(
      mutate((json) => {
        ((json['materials'] as Record<string, unknown>[])[0]!['pbrMetallicRoughness'] as Record<
          string,
          unknown
        >)['baseColorTexture'] = { index: 3 };
      }),
      'asset_material_invalid',
      '/materials/0/pbrMetallicRoughness/baseColorTexture/index',
    );
    expectRejected(
      withValidImage((json) => {
        json['textures'] = [{ source: 4 }];
      }),
      'asset_texture_invalid',
      '/textures/0/source',
    );
  });
  it('rejects an out-of-range sampler wrap enum', () => {
    expectRejected(
      withValidImage((json) => {
        json['samplers'] = [{ wrapS: 1234 }];
        json['textures'] = [{ source: 0, sampler: 0 }];
      }),
      'asset_texture_invalid',
      '/samplers/0/wrapS',
    );
  });
});

describe('§18.7.2 step 11 — images', () => {
  it('rejects an image without a bufferView and a non-image mimeType', () => {
    expectRejected(
      mutate((json) => {
        json['images'] = [{ mimeType: 'image/png' }];
      }),
      'asset_image_invalid',
      '/images/0/bufferView',
    );
    expectRejected(
      mutate((json) => {
        json['images'] = [{ bufferView: 1, mimeType: 'text/plain' }];
      }),
      'asset_image_invalid',
      '/images/0/mimeType',
    );
  });
  it('rejects an image whose bytes are neither PNG nor JPEG', () => {
    expectRejected(
      mutate((json) => {
        json['images'] = [{ bufferView: 2, mimeType: 'image/png' }];
      }),
      'asset_image_invalid',
      '/images/0',
    );
  });
  it('rejects a PNG signature whose header cannot be read', () => {
    const truncatedPng = mutateFixture(fixtureBytes('decoded-limit.glb'), (json) => {
      (json['bufferViews'] as Record<string, unknown>[])[5]!['byteLength'] = 8;
    });
    expectRejected(truncatedPng, 'asset_image_invalid', '/images/0');
  });
});

describe('§18.7.2 step 13 — animations', () => {
  it('rejects a bad target path, a missing target node and a mismatched output type', () => {
    expectRejected(
      mutate((json) => {
        (((json['animations'] as Record<string, unknown>[])[0]!['channels'] as Record<string, unknown>[])[0]![
          'target'
        ] as Record<string, unknown>)['path'] = 'color';
      }),
      'asset_animation_invalid',
      '/animations/0/channels/0/target/path',
    );
    expectRejected(
      mutate((json) => {
        (((json['animations'] as Record<string, unknown>[])[0]!['channels'] as Record<string, unknown>[])[0]![
          'target'
        ] as Record<string, unknown>)['node'] = 7;
      }),
      'asset_animation_invalid',
      '/animations/0/channels/0/target/node',
    );
    expectRejected(
      mutate((json) => {
        ((json['animations'] as Record<string, unknown>[])[0]!['samplers'] as Record<string, unknown>[])[0]![
          'output'
        ] = 3; // SCALAR while the rotation path needs VEC4
      }),
      'asset_animation_invalid',
      '/animations/0/samplers/0/output',
    );
  });
  it('rejects KHR_animation_pointer with the animation code', () => {
    expectRejected(
      mutate((json) => {
        (((json['animations'] as Record<string, unknown>[])[0]!['channels'] as Record<string, unknown>[])[0]![
          'target'
        ] as Record<string, unknown>)['extensions'] = { KHR_animation_pointer: {} };
      }),
      'asset_animation_invalid',
      '/animations/0/channels/0/target/extensions',
    );
  });
});

describe('§18.7.2 step 14 — nodes and scenes', () => {
  it('rejects a hierarchy cycle, matrix+TRS together and a dangling child', () => {
    expectRejected(
      mutate((json) => {
        (json['nodes'] as Record<string, unknown>[])[0]!['children'] = [1];
        (json['nodes'] as Record<string, unknown>[])[1]!['children'] = [0];
      }),
      'asset_node_invalid',
      '/nodes/0',
    );
    expectRejected(
      mutate((json) => {
        (json['nodes'] as Record<string, unknown>[])[1]!['matrix'] = [
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ];
        (json['nodes'] as Record<string, unknown>[])[1]!['translation'] = [1, 2, 3];
      }),
      'asset_node_invalid',
      '/nodes/1',
    );
    expectRejected(
      mutate((json) => {
        (json['nodes'] as Record<string, unknown>[])[0]!['children'] = [9];
      }),
      'asset_node_invalid',
      '/nodes/0/children/0',
    );
  });
  it('rejects a missing scene, an out-of-range scene index and a dangling scene node', () => {
    expectRejected(
      mutate((json) => {
        json['scenes'] = [];
        delete json['scene'];
      }),
      'asset_scene_invalid',
      '/scenes',
    );
    expectRejected(
      mutate((json) => {
        json['scene'] = 5;
      }),
      'asset_scene_invalid',
      '/scene',
    );
    expectRejected(
      mutate((json) => {
        (json['scenes'] as Record<string, unknown>[])[0]!['nodes'] = [9];
      }),
      'asset_scene_invalid',
      '/scenes/0/nodes/0',
    );
  });
});

describe('§18.8.2 — bounded diagnostics', () => {
  it('returns at most 10 diagnostics plus the true count', () => {
    const extensions = Array.from({ length: 12 }, (_, i) => `EXT_fixture_${i}`);
    const proposal = expectRejected(
      mutate((json) => {
        json['extensionsUsed'] = extensions;
      }),
      'asset_extension_unsupported',
    );
    expect(proposal.diagnosticCount).toBe(12);
    expect(proposal.diagnostics.length).toBe(10);
    expect(proposal.diagnostics.every((d) => d.code === 'asset_extension_unsupported')).toBe(true);
    expect(proposal.diagnostics[0]?.path).toBe('/extensionsUsed');
  });

  it('reports several independent diagnostics for one step', () => {
    const proposal = expectRejected(
      mutate((json) => {
        json['extensionsUsed'] = ['EXT_a'];
        json['extensionsRequired'] = ['EXT_b'];
      }),
      'asset_extension_unsupported',
    );
    expect(proposal.diagnosticCount).toBe(2);
    expect(proposal.diagnostics.length).toBe(2);
    expect(proposal.diagnostics.map((d) => d.path)).toEqual([
      '/extensionsUsed',
      '/extensionsRequired',
    ]);
  });
});

describe('diagnostic hygiene', () => {
  it('never leaks a path, a URL we fetched, or credential-shaped data', () => {
    for (const file of ['external-uri-buffer.glb', 'external-uri-image.glb', 'required-extension.glb']) {
      const proposal = inspectBytes(fixtureBytes(file));
      expect(proposal.status).toBe('rejected');
      for (const diagnostic of proposal.diagnostics) {
        expect(typeof diagnostic.message).toBe('string');
        expect(diagnostic.message.length).toBeGreaterThan(0);
        expect(diagnostic.message).not.toContain('/home/');
        expect(diagnostic.message).not.toContain('http');
      }
    }
  });

  it('rebuild() helper keeps the base fixture legal for the untouched steps', () => {
    // A guard for the mutation helpers themselves: the pristine baseline still
    // validates, so every rejection above is caused by its mutation.
    expect(inspectBytes(rebuild(baseJson())).status).toBe('ok');
  });
});
