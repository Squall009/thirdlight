/**
 * Packet 58 — manifest v2 pure derivation (delivery.md §2, sessions.md §17.1.1).
 *
 * Node unit/mock-level per the zero-dependency leaf rule: `project-model`
 * forbids Node built-ins (`check-boundaries` `node: []`, tests included), so
 * this suite exercises the PURE logic — the block-digest rule, the v2 assembly
 * (key order, self-identifying buildId), the strict v2 reader and the
 * v1/v2 version-compat rule — over small synthetic inputs. The binding
 * fixture re-derivation (the committed `manifest-v2-preimage.json` →
 * `buildId` `41b5a60b…`) lives in `tests/integration/m3-builds/` where Node
 * `crypto`/`fs` are allowed and the digests are re-derived independently.
 */
import { describe, expect, it } from 'vitest';

import {
  blockDigest,
  captureManifestV2,
  CUE_SLOTS,
  manifestBuildIdInputV2,
  manifestVersionCompat,
  MANIFEST_KEYS_V2,
  mediaProfileDigest,
  RUNTIME_CONTENT_MANIFEST_VERSION_2,
  sha256Hex,
  validateManifestV2,
} from './index';

// A small synthetic settings block in registry order (all defaults).
const SETTINGS = {
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
} as const;

// A small frozen game block in canonical GameConfig order.
const GAME = {
  configVersion: 1,
  title: 'T',
  objective: 'O',
  instructions: 'I',
  playerId: 'p-1',
  cameraId: 'cam-1',
  spawnId: 'sp-1',
  level: { minX: 0, maxX: 10, minY: -2, maxY: 6 },
  killY: -4,
  cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
} as const;

// A minimal media identity (no cues, one animation row).
const ROLES = {
  idle: { clipIndex: 0, clipName: 'Idle' },
  run: { clipIndex: 1, clipName: 'Run' },
  airborne: { clipIndex: 2, clipName: 'Air' },
};
const MEDIA = {
  cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
  animation: [
    {
      entityId: 'p-1',
      assetId: 'asset-1',
      version: 1,
      profileDigest: mediaProfileDigest(ROLES),
      roles: ROLES,
    },
  ],
};

const ASSETS = [
  {
    assetId: 'asset-1',
    kind: 'model' as const,
    version: 1,
    sourceDigest: 'a'.repeat(64),
    sourceByteLength: 47,
    recipe: { id: 'gltf-glb', version: 1 },
    metricsDigest: 'b'.repeat(64),
  },
];

const DIGEST = 'c'.repeat(64);

function v2Input(over: Record<string, unknown> = {}) {
  return {
    projectId: 'demo-0001',
    revision: 12,
    capturedAt: '2026-09-19T10:00:00Z',
    sceneDigest: DIGEST,
    contentDigest: DIGEST,
    assets: ASSETS,
    behaviors: [],
    settings: SETTINGS,
    game: GAME,
    media: MEDIA,
    moduleIds: ['thirdlight.platformer-game:session', 'thirdlight.platformer:controller'],
    ...over,
  };
}

describe('manifest-v2: block digest (delivery.md §2.4 rule 1)', () => {
  it('hashes JSON.stringify(value, null, 2) + "\\n" in the value own key order', () => {
    const value = { b: 1, a: 2 }; // key order b, a (NOT sorted)
    const expected = sha256Hex(new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
    expect(blockDigest(value)).toBe(expected);
    // sorted-key order would differ — the digest is order-sensitive.
    const sorted = { a: 2, b: 1 };
    expect(blockDigest(value)).not.toBe(blockDigest(sorted));
  });

  it('a null block hashes the four canonical bytes "null" + newline', () => {
    const expected = sha256Hex(new TextEncoder().encode('null\n'));
    expect(blockDigest(null)).toBe(expected);
    expect(blockDigest(null)).not.toBe(blockDigest({}));
  });

  it('profileDigest equals the block digest of the canonical roles bytes', () => {
    expect(mediaProfileDigest(ROLES)).toBe(blockDigest(ROLES));
  });
});

describe('manifest-v2: captureManifestV2 assembly', () => {
  it('emits the v2 document in MANIFEST_KEYS_V2 order with buildId last', () => {
    const res = captureManifestV2(v2Input() as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const keys = Object.keys(res.manifest);
    // `tags` (phase 12 b) is present only when the project defines tags.
    expect(keys).toEqual(MANIFEST_KEYS_V2.filter((k) => k !== 'tags' && k !== 'materials' && k !== 'environment' && k !== 'lighting' && k !== 'animators' && k !== 'input' && k !== 'flow' && k !== 'scenes' && k !== 'buffers'));
    expect(keys[keys.length - 1]).toBe('buildId');
    const tagged = captureManifestV2({ ...(v2Input() as object), tags: [{ bit: 3, name: 'enemy' }] } as never);
    expect(tagged.ok).toBe(true);
    if (tagged.ok) {
      expect(Object.keys(tagged.manifest)).toEqual(MANIFEST_KEYS_V2.filter((k) => k !== 'materials' && k !== 'environment' && k !== 'lighting' && k !== 'animators' && k !== 'input' && k !== 'flow' && k !== 'scenes' && k !== 'buffers'));
      expect(validateManifestV2(tagged.manifest).ok).toBe(true);
    }
    expect(res.manifest.manifestVersion).toBe(RUNTIME_CONTENT_MANIFEST_VERSION_2);
    expect(res.manifest.snapshotId).toBe('demo-0001@r12');
  });

  it('buildId is self-identifying over the document without buildId', () => {
    const res = captureManifestV2(v2Input() as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { buildId, ...without } = res.manifest as unknown as Record<string, unknown>;
    const preimage = manifestBuildIdInputV2(without);
    expect(preimage).not.toBeNull();
    expect(sha256Hex(preimage!)).toBe(buildId);
    expect(res.buildId).toBe(buildId);
  });

  it('block digests are derived from the declared blocks', () => {
    const res = captureManifestV2(v2Input() as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.settingsDigest).toBe(blockDigest(SETTINGS));
    expect(res.manifest.gameDigest).toBe(blockDigest(GAME));
    expect(res.manifest.mediaDigest).toBe(blockDigest(MEDIA));
    expect(res.manifest.sceneDigest).toBe(DIGEST);
    expect(res.manifest.contentDigest).toBe(DIGEST);
  });

  it('a null game hashes the null preimage and the document carries game: null', () => {
    const res = captureManifestV2(v2Input({ game: null }) as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.game).toBeNull();
    expect(res.manifest.gameDigest).toBe(blockDigest(null));
  });

  it('asset rows carry kind, the derived recipeDigest and the sha256 path', () => {
    const res = captureManifestV2(v2Input() as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const a = res.manifest.assets[0] as Record<string, unknown>;
    expect(a['kind']).toBe('model');
    expect(a['path']).toBe(`content/sha256/${'a'.repeat(64)}`);
    expect(a['recipeDigest']).toBe(blockDigest({ id: 'gltf-glb', version: 1 }));
    // key order of the row (kind immediately after assetId).
    expect(Object.keys(a)).toEqual([
      'assetId', 'kind', 'version', 'sourceDigest', 'sourceByteLength', 'recipeDigest', 'metricsDigest', 'path',
    ]);
  });

  it('requires contentDigest and a scene/sceneDigest', () => {
    const noContent = v2Input();
    delete (noContent as Record<string, unknown>)['contentDigest'];
    expect((captureManifestV2(noContent as never) as { ok: boolean }).ok).toBe(false);
    expect((captureManifestV2({ ...v2Input(), sceneDigest: undefined } as never) as { ok: boolean }).ok).toBe(false);
  });

  it('modules are mapped through the M3 package table in ascending id order', () => {
    const res = captureManifestV2(v2Input() as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = (res.manifest.modules as readonly Record<string, unknown>[]).map((m) => m['id']);
    expect(ids).toEqual([...ids].sort());
    const session = res.manifest.modules.find((m) => m['id'] === 'thirdlight.platformer-game:session') as Record<string, unknown>;
    expect(session['package']).toBe('@thirdlight/platformer-game');
  });
});

describe('manifest-v2: validateManifestV2 (strict reader)', () => {
  function aValidDoc(): Record<string, unknown> {
    const res = captureManifestV2(v2Input() as never);
    if (!res.ok) throw new Error('expected a valid capture');
    return JSON.parse(new TextDecoder().decode(res.bytes)) as Record<string, unknown>;
  }

  it('accepts a well-formed v2 document', () => {
    const doc = aValidDoc();
    const res = validateManifestV2(doc);
    expect(res.ok).toBe(true);
  });

  it('rejects a v1 document with manifest_invalid / manifest_version', () => {
    const doc = aValidDoc();
    doc['manifestVersion'] = 1;
    const res = validateManifestV2(doc);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('manifest_invalid');
    expect(res.error.reason).toBe('manifest_version');
  });

  it('rejects an unknown key (manifest_invalid / unknown_key)', () => {
    const doc = aValidDoc();
    doc['extraneous'] = true;
    const res = validateManifestV2(doc);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('unknown_key');
  });

  it('rejects a missing key (manifest_invalid / missing_key)', () => {
    const doc = aValidDoc();
    delete doc['mediaDigest'];
    const res = validateManifestV2(doc);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('missing_key');
  });

  it('rejects a tampered block digest (digest_mismatch)', () => {
    const doc = aValidDoc();
    doc['settingsDigest'] = 'f'.repeat(64);
    const res = validateManifestV2(doc);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('digest_mismatch');
  });

  it('rejects a tampered buildId (digest_mismatch)', () => {
    const doc = aValidDoc();
    doc['buildId'] = 'e'.repeat(64);
    const res = validateManifestV2(doc);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('digest_mismatch');
  });

  it('rejects a non-{model,audio} asset kind', () => {
    const doc = aValidDoc();
    (doc['assets'] as unknown as Array<Record<string, unknown>>)[0]!['kind'] = 'video';
    const res = validateManifestV2(doc);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('manifest_invalid');
  });

  it('rejects a settings block that leaves the registry order', () => {
    const doc = aValidDoc();
    const s = doc['settings'] as Record<string, number>;
    doc['settings'] = {
      run_speed: s['run_speed'],
      gravity_y: s['gravity_y'],
      jump_velocity: s['jump_velocity'],
      max_fall_speed: s['max_fall_speed'],
      max_slope_climb_deg: s['max_slope_climb_deg'],
      min_slope_slide_deg: s['min_slope_slide_deg'],
    };
    const res = validateManifestV2(doc);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('manifest_invalid');
  });
});

describe('manifest-v2: version-compat rule (delivery.md §2.1)', () => {
  it('a v1 reader rejects a v2 document (manifest_version)', () => {
    const res = manifestVersionCompat({ manifestVersion: 2 }, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('manifest_version');
  });

  it('a v2 reader rejects a v1 document (manifest_version)', () => {
    const res = manifestVersionCompat({ manifestVersion: 1 }, 2);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('manifest_version');
  });

  it('a matching version loads', () => {
    expect(manifestVersionCompat({ manifestVersion: 2 }, 2).ok).toBe(true);
    expect(manifestVersionCompat({ manifestVersion: 1 }, 1).ok).toBe(true);
  });
});

describe('manifest-v2: contract constants', () => {
  it('the v2 key order carries the six added keys and buildId last', () => {
    expect(MANIFEST_KEYS_V2).toHaveLength(31); // incl. the optional phase-12 tags, scenes, buffers, the phase-9.4 materials, environment, the 9.6 lighting, the 9.7 animators, the 9.8 input and the 9.10 flow
    expect(MANIFEST_KEYS_V2).toContain('gameDigest');
    expect(MANIFEST_KEYS_V2).toContain('settingsDigest');
    expect(MANIFEST_KEYS_V2).toContain('mediaDigest');
    expect(MANIFEST_KEYS_V2).toContain('settings');
    expect(MANIFEST_KEYS_V2).toContain('game');
    expect(MANIFEST_KEYS_V2).toContain('media');
    expect(MANIFEST_KEYS_V2[MANIFEST_KEYS_V2.length - 1]).toBe('buildId');
  });

  it('the cue slots are the five game cues in order', () => {
    expect([...CUE_SLOTS]).toEqual(['start', 'jump', 'checkpoint', 'death', 'goal']);
  });
});