/**
 * Packet-24 acceptance: the module boundary and the observable absence of
 * network/plugin behavior.
 *
 * §18.7.1/§4.3 (dependencies.md): the importer inspects bytes itself — no
 * `three`/GLTFLoader import, no plugin registry, no URL fetch, no I/O. The
 * static import graph is proved by `tools/check-boundaries.mjs`; this suite
 * proves the runtime behavior: with `fetch`, `XMLHttpRequest` and `WebSocket`
 * replaced by throwing stubs, every fixture (including the remote-URI and
 * `data:` URI ones) still produces its normal proposal — nothing is fetched.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import * as api from './index';
import {
  importMetadataDigest,
  importRecipeDigest,
  inspectAudio,
  inspectGlb,
  M2_GLTF_EXTENSION_ALLOWLIST,
  M2_GLTF_PROFILE_LIMITS,
  prepareImport,
  sanitizeDisplayName,
  type ImportDiagnosticCode,
  type ImportJobPort,
  type ImportOptions,
} from './index';
import { fixtureBytes, fixtureBase64 } from './test-fixtures';

const options: ImportOptions = {
  profile: 'gltf-glb',
  recipeVersion: 1,
  toolchain: { three: '0.186.0' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('public surface (dependencies.md §3)', () => {
  it('exports exactly the approved runtime values', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'ANIMATION_PROFILE_MAX_CLIPS',
        'ANIMATION_PROFILE_MAX_CLIP_MS',
        'ANIMATION_PROFILE_MAX_TRACKS',
        'ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP',
        'ANIMATION_PROFILE_MAX_TRACK_TIMES',
        'ANIMATION_ROLE_KEYS',
        'ANIMATION_ROLE_NAME_CHARS',
        'AUDIO_PCM_WAV_BITS_PER_SAMPLE',
        'AUDIO_PCM_WAV_BLOCK_ALIGN',
        'AUDIO_PCM_WAV_BYTE_RATE',
        'AUDIO_PCM_WAV_CHANNELS',
        'AUDIO_PCM_WAV_HEADER_BYTES',
        'AUDIO_PCM_WAV_LIMITS',
        'AUDIO_PCM_WAV_MAX_DURATION_MS',
        'AUDIO_PCM_WAV_MAX_FRAMES',
        'AUDIO_PCM_WAV_MAX_PCM_BYTES',
        'AUDIO_PCM_WAV_MAX_SOURCE_BYTES',
        'AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES',
        'AUDIO_PCM_WAV_SAMPLE_RATE',
        'AUDIO_PCM_WAV_TOOLCHAIN',
        'AUDIO_PIPELINE_NAME',
        'AUDIO_PIPELINE_VERSION',
        'AUDIO_REPORTED_LIMITS',
        'M2_GLTF_EXTENSION_ALLOWLIST',
        'M2_GLTF_IMAGE_BYTES',
        'M2_GLTF_INSPECTION_ENTRIES',
        'M2_GLTF_INSPECTION_NAME_CHARS',
        'M2_GLTF_INSPECTION_TIMEOUT_MS',
        'M2_GLTF_JSON_CHUNK_BYTES',
        'M2_GLTF_MAX_DIAGNOSTICS',
        'M2_GLTF_PROFILE_LIMITS',
        'M2_GLTF_SOURCE_BYTES',
        'M2_GLTF_TOOLCHAIN',
        'importMetadataDigest',
        'importRecipeDigest',
        'inspectAudio',
        'inspectGlb',
        'prepareImport',
        'sanitizeDisplayName',
      ].sort(),
    );
    expect(typeof inspectGlb).toBe('function');
    expect(typeof prepareImport).toBe('function');
    expect(typeof inspectAudio).toBe('function');
    expect(Object.isFrozen(M2_GLTF_PROFILE_LIMITS)).toBe(true);
    expect(Object.isFrozen(M2_GLTF_EXTENSION_ALLOWLIST)).toBe(true);
    expect(M2_GLTF_EXTENSION_ALLOWLIST).toContain('EXT_texture_webp');
  });

  it('has no plugin registry, loader or URL input on the surface', () => {
    for (const key of Object.keys(api)) {
      expect(key.toLowerCase()).not.toContain('register');
      expect(key.toLowerCase()).not.toContain('loader');
      expect(key.toLowerCase()).not.toContain('fetch');
      expect(key.toLowerCase()).not.toContain('url');
    }
    for (const value of Object.values(api)) {
      if (typeof value === 'function') {
        expect(value.constructor.name).not.toBe('AsyncFunction');
      }
    }
  });
});

describe('no network and no I/O', () => {
  const throwing = (): never => {
    throw new Error('network access attempted by the importer');
  };

  it('inspects every fixture with fetch/XHR/WebSocket stubbed to throw', () => {
    vi.stubGlobal('fetch', throwing);
    vi.stubGlobal('XMLHttpRequest', throwing);
    vi.stubGlobal('WebSocket', throwing);
    const files = fixtureBase64();
    for (const name of Object.keys(files)) {
      const proposal = inspectGlb(fixtureBytes(name), options);
      expect(['ok', 'rejected']).toContain(proposal.status);
    }
    expect(globalThis.fetch).toBe(throwing);
  });

  it('rejects remote/data URIs without ever resolving them', () => {
    vi.stubGlobal('fetch', throwing);
    for (const name of ['external-uri-buffer.glb', 'external-uri-image.glb']) {
      const proposal = inspectGlb(fixtureBytes(name), options);
      expect(proposal.status).toBe('rejected');
      expect(proposal.diagnostics.map((d) => d.code)).toEqual(['asset_uri_rejected']);
      // The offending value is echoed as data, never fetched.
      expect(String(proposal.diagnostics[0]?.found)).toMatch(/^(https:|data:)/);
    }
  });
});

describe('immutability of the proposal', () => {
  it('is deep-frozen, so a caller cannot mutate authoring-facing data', () => {
    const proposal = inspectGlb(fixtureBytes('tiny-v1.glb'), options);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.metrics)).toBe(true);
    expect(Object.isFrozen(proposal.inspection.nodeNames)).toBe(true);
    expect(Object.isFrozen(proposal.importRecipe)).toBe(true);
    expect(Object.isFrozen(proposal.limits)).toBe(true);
    expect(Object.isFrozen(proposal.diagnostics)).toBe(true);
    expect(() => {
      (proposal as { status: string }).status = 'mutated';
    }).toThrow(TypeError);
    expect(proposal.status).toBe('ok');
  });

  it('exposes no functions on the returned value (validated data only)', () => {
    const proposal = inspectGlb(fixtureBytes('tiny-v1.glb'), options);
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'function') throw new Error(`function at ${path}`);
      if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          expect(k.length).toBeGreaterThan(0);
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(proposal, 'proposal');
  });
});

describe('option validation (caller programming errors throw)', () => {
  const bytes = fixtureBytes('tiny-v1.glb');
  const bad: [string, unknown][] = [
    ['bytes', undefined],
    ['options', undefined],
    ['profile', { ...options, profile: 'gltf' }],
    ['recipeVersion', { ...options, recipeVersion: 2 }],
    ['toolchain missing', { profile: 'gltf-glb', recipeVersion: 1 }],
    ['toolchain extra tool', { ...options, toolchain: { three: '0.186.0', x: '1.0.0' } }],
    ['toolchain wrong pin', { ...options, toolchain: { three: '0.180.0' } }],
    [
      'job proposalId',
      { ...options, job: { ...goodJob(), proposalId: () => 'nope' } },
    ],
    ['job stageId', { ...options, job: { ...goodJob(), stageId: () => '' } }],
    ['job expiresAt', { ...options, job: { ...goodJob(), expiresAt: () => '' } }],
    ['job timeoutMs', { ...options, job: { ...goodJob(), timeoutMs: 0 } }],
  ];

  function goodJob(): ImportJobPort {
    return {
      now: () => 0,
      isCancelled: () => false,
      proposalId: () => 'p-00000000000000000000000000000000',
      stageId: () => 'stage',
      expiresAt: () => '2026-09-18T00:00:00Z',
    };
  }

  it.each(bad)('throws TypeError for a bad %s', (_label, badOptions) => {
    if (badOptions === undefined && _label === 'bytes') {
      expect(() => inspectGlb(undefined as unknown as Uint8Array, options)).toThrow(TypeError);
      return;
    }
    if (badOptions === undefined) {
      expect(() => inspectGlb(bytes, undefined as unknown as ImportOptions)).toThrow(TypeError);
      return;
    }
    expect(() => inspectGlb(bytes, badOptions as ImportOptions)).toThrow(TypeError);
  });

  it('is total over hostile bytes: never throws for bad input data', () => {
    const hostile: [string, Uint8Array][] = [
      ['empty', new Uint8Array(0)],
      ['junk', new Uint8Array([0xff, 0xfe, 0xfd, 0x00])],
      ['glb magic only', new Uint8Array([0x67, 0x6c, 0x54, 0x46])],
      ['one byte', new Uint8Array([0])],
      ['all ones', new Uint8Array(1024).fill(0xff)],
    ];
    for (const [, input] of hostile) {
      const proposal = inspectGlb(input, options);
      expect(proposal.status).toBe('rejected');
      expect((proposal.diagnostics[0]?.code as ImportDiagnosticCode).startsWith('asset_')).toBe(true);
    }
    for (const file of Object.keys(fixtureBase64())) {
      expect(() => inspectGlb(fixtureBytes(file), options)).not.toThrow();
    }
  });
});

describe('suggested display name sanitization', () => {
  it('strips control characters, trims and caps at 128 characters', () => {
    expect(sanitizeDisplayName('  Hero Model  ')).toBe('Hero Model');
    expect(sanitizeDisplayName('hero\u0000\u001bmodel')).toBe('heromodel');
    expect(sanitizeDisplayName('x'.repeat(200)).length).toBe(128);
    expect(sanitizeDisplayName(undefined)).toBe('');
    expect(sanitizeDisplayName('bad\nname')).toBe('badname');
  });

  it('is used for the proposal field and never as a path or an identity', () => {
    const proposal = inspectGlb(fixtureBytes('tiny-v1.glb'), {
      ...options,
      displayName: '../escape\u0000',
    });
    expect(proposal.suggestedDisplayName).toBe('../escape');
    expect(proposal).not.toHaveProperty('path');
  });
});

describe('digest helpers', () => {
  it('recipe digest is the SHA-256 of the canonical recipe JSON', async () => {
    const proposal = inspectGlb(fixtureBytes('tiny-v1.glb'), options);
    const canonical = '{"extensions":[],"profile":"gltf-glb","recipeVersion":1,"toolchain":{"three":"0.186.0"}}';
    // Independent recomputation through the platform WebCrypto, not the
    // package's own pure SHA-256.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(importRecipeDigest(proposal.importRecipe)).toBe(expected);
  });

  it('metadata digest of an accepted model changes with the metrics and is stable otherwise', () => {
    const v1 = inspectGlb(fixtureBytes('tiny-v1.glb'), options);
    const v2 = inspectGlb(fixtureBytes('tiny-v2.glb'), options);
    expect(importMetadataDigest(v1)).toMatch(/^[0-9a-f]{64}$/);
    expect(importMetadataDigest(v1)).not.toBe(importMetadataDigest(v2));
    expect(importMetadataDigest(v1)).toBe(importMetadataDigest(inspectGlb(fixtureBytes('tiny-v1.glb'), options)));
  });
});
