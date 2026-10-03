/**
 * Manifest v2 pure derivation.
 *
 * Node unit/mock-level per the zero-dependency leaf rule: `project-model`
 * forbids Node built-ins (`check-boundaries` `node: []`, tests included), so
 * this suite exercises the PURE logic — the block-digest rule, the v2 assembly
 * (key order, self-identifying buildId), the strict v2 reader and the
 * v1/v2 version-compat rule — over small synthetic inputs. The binding
 * fixture re-derivation (the committed `manifest-v2-preimage.json` →
 * `buildId` `41b5a60b…`) is in `tests/integration/m3-builds/` where Node
 * `crypto`/`fs` are allowed and the digests are re-derived independently.
 */
import { describe, expect, it } from 'vitest';

import {
  blockDigest,
  captureManifestV2,
  manifestBuildIdInputV2,
  manifestVersionCompat,
  MANIFEST_KEYS_V2,
  mediaProfileDigest,
  RUNTIME_CONTENT_MANIFEST_VERSION_4,
  MANIFEST_CONTENT_FILE_KEYS,
  sha256Hex,
  validateManifestV2,
} from './index';
import { ASSETS, DIGEST, everyOptionalKey, MEDIA, ROLES, SETTINGS, v2Input } from './manifest-test-inputs';

describe('manifest-v2: block digest', () => {
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
    // `tags` is present only when the project defines tags.
    expect(keys).toEqual(MANIFEST_KEYS_V2.filter((k) => k !== 'tags' && k !== 'effects' && k !== 'environment' && k !== 'lighting' && k !== 'animators' && k !== 'rigs' && k !== 'modelColliders' && k !== 'prefabs' && k !== 'blockTypes' && k !== 'cellFields' && k !== 'input' && k !== 'collisionLayers' && k !== 'saveSchema' && k !== 'uiThemes' && k !== 'timelines' && k !== 'eventCues' && k !== 'shell' && k !== 'modes' && k !== 'scenes' && k !== 'contentFiles' && k !== 'libraries' && k !== 'loadable'));
    expect(keys[keys.length - 1]).toBe('buildId');
    const tagged = captureManifestV2({ ...(v2Input() as object), tags: [{ bit: 3, name: 'walker' }] } as never);
    expect(tagged.ok).toBe(true);
    if (tagged.ok) {
      expect(Object.keys(tagged.manifest)).toEqual(MANIFEST_KEYS_V2.filter((k) => k !== 'effects' && k !== 'environment' && k !== 'lighting' && k !== 'animators' && k !== 'rigs' && k !== 'modelColliders' && k !== 'prefabs' && k !== 'blockTypes' && k !== 'cellFields' && k !== 'input' && k !== 'collisionLayers' && k !== 'saveSchema' && k !== 'uiThemes' && k !== 'timelines' && k !== 'eventCues' && k !== 'shell' && k !== 'modes' && k !== 'scenes' && k !== 'contentFiles' && k !== 'libraries' && k !== 'loadable'));
      expect(validateManifestV2(tagged.manifest).ok).toBe(true);
    }
    expect(res.manifest.manifestVersion).toBe(RUNTIME_CONTENT_MANIFEST_VERSION_4);
    // No content file block given: no contentFiles key and no files.
    expect(res.contentFiles).toEqual([]);
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
    expect(res.manifest.mediaDigest).toBe(blockDigest(MEDIA));
    expect(res.manifest.sceneDigest).toBe(DIGEST);
    expect(res.manifest.contentDigest).toBe(DIGEST);
  });

  it('the document has no game block, no gameDigest and no cue slots', () => {
    const res = captureManifestV2(v2Input() as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('game' in res.manifest).toBe(false);
    expect('gameDigest' in res.manifest).toBe(false);
    expect(Object.keys(res.manifest.media)).toEqual(['animation']);
    const withCues = { ...res.manifest, media: { cues: {}, animation: [] } };
    expect(validateManifestV2(withCues).ok).toBe(false);
    expect(validateManifestV2({ ...res.manifest, manifestVersion: 2 }).ok).toBe(false);
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
    const physics = res.manifest.modules.find((m) => m['id'] === 'thirdlight.physics-rapier:3d') as Record<string, unknown>;
    expect(physics['package']).toBe('@thirdlight/physics-rapier');
    const controller = res.manifest.modules.find((m) => m['id'] === 'thirdlight.character:controller') as Record<string, unknown>;
    expect(controller['package']).toBe('@thirdlight/character');
  });
});

/**
 * Every optional key at once (TL-15). Each value is the smallest
 * block its canonical form accepts; the point is the key set and order, the
 * buildId the preview and both export paths re-derive, and the strict reader.
 * Materials, materialFunctions, uiDocuments, dialogue and
 * buffers are capture inputs that become content files (the document's
 * `contentFiles` key), not document keys.
 */
describe('manifest-v2: every optional key present', () => {
  it('the fixture names every optional key (a key added to MANIFEST_KEYS_V2 must be added here)', () => {
    const required = Object.keys(captureManifestOrThrow(v2Input()));
    const optional = MANIFEST_KEYS_V2.filter((k) => !required.includes(k));
    const fileKeys: readonly string[] = MANIFEST_CONTENT_FILE_KEYS;
    const inputs = Object.keys(everyOptionalKey());
    expect([...inputs.filter((k) => !fileKeys.includes(k)), 'contentFiles'].sort()).toEqual([...optional].sort());
    expect(inputs.filter((k) => fileKeys.includes(k)).sort()).toEqual([...fileKeys].sort());
  });

  it('the content file blocks leave the document for their own files, listed by digest', () => {
    const res = captureManifestV2({ ...v2Input(), ...everyOptionalKey() } as never);
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    const doc = res.manifest as unknown as Record<string, unknown>;
    for (const k of MANIFEST_CONTENT_FILE_KEYS) expect(k in doc, k).toBe(false);
    expect(res.contentFiles.map((f) => f.key)).toEqual([...MANIFEST_CONTENT_FILE_KEYS]);
    expect(doc['contentFiles']).toEqual(res.contentFiles.map((f) => ({ key: f.key, path: `content/sha256/${f.digest}`, digest: f.digest, byteLength: f.bytes.length })));
    const blocks: Record<string, unknown> = {};
    for (const f of res.contentFiles) {
      expect(sha256Hex(f.bytes)).toBe(f.digest);
      blocks[f.key] = JSON.parse(new TextDecoder().decode(f.bytes));
      // Each file is its block's canonical bytes (the block digest rule).
      expect(blockDigest(blocks[f.key])).toBe(f.digest);
    }
    expect(blocks['buffers']).toEqual([{ digest: 'f'.repeat(64), byteLength: 48 }]);
    // The strict reader checks the rows, and with the blocks given, the blocks against their rows.
    const checked = validateManifestV2(JSON.parse(JSON.stringify(doc)), { contentFiles: blocks });
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    const tampered = validateManifestV2(doc, { contentFiles: { ...blocks, buffers: [{ digest: 'e'.repeat(64), byteLength: 48 }] } });
    expect(tampered.ok).toBe(false);
    const missing = validateManifestV2(doc, { contentFiles: { ...blocks, dialogue: undefined } as never });
    expect(missing.ok).toBe(false);
    // A document carrying a block itself is refused (not a v4 key).
    expect(validateManifestV2({ ...doc, materials: [] }).ok).toBe(false);
    // Rows out of order are refused.
    const rows = [...(doc['contentFiles'] as unknown[])].reverse();
    expect(validateManifestV2({ ...doc, contentFiles: rows }).ok).toBe(false);
  });

  it('the document carries every key in MANIFEST_KEYS_V2 order; the buildId re-derives and the strict reader accepts it', () => {
    const manifest = captureManifestOrThrow({ ...v2Input(), ...everyOptionalKey() });
    expect(Object.keys(manifest)).toEqual([...MANIFEST_KEYS_V2]);
    // The preview's and both exporters' re-derivation: every key but buildId, in MANIFEST_KEYS_V2 order.
    const preimage: Record<string, unknown> = {};
    for (const k of MANIFEST_KEYS_V2) if (k !== 'buildId') preimage[k] = manifest[k];
    expect(sha256Hex(new TextEncoder().encode(`${JSON.stringify(preimage, null, 2)}\n`))).toBe(manifest['buildId']);
    // The document bytes are the canonical serialization: the preimage bytes are its prefix up to buildId.
    const { buildId: _b, ...without } = manifest;
    expect(new TextDecoder().decode(manifestBuildIdInputV2(without)!)).toBe(`${JSON.stringify(without, null, 2)}\n`);
    const checked = validateManifestV2(JSON.parse(JSON.stringify(manifest)));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    // Library rows name their module by its output digest.
    expect(manifest['libraries']).toEqual([{ libraryId: 'lib-a', sourceDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64), outputByteLength: 12, path: `libraries/${'b'.repeat(64)}.js` }]);
    const badRow = { ...(manifest['libraries'] as Record<string, unknown>[])[0], path: 'libraries/x.js' };
    expect(validateManifestV2({ ...JSON.parse(JSON.stringify(manifest)), libraries: [badRow] }).ok).toBe(false);
  });
});

function captureManifestOrThrow(input: Record<string, unknown>): Record<string, unknown> {
  const res = captureManifestV2(input as never);
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  return res.manifest as unknown as Record<string, unknown>;
}

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

describe('manifest-v2: optional engine settings and model bounds', () => {
  const capture = (over: Record<string, unknown>): Record<string, unknown> => {
    const res = captureManifestV2(v2Input(over) as never);
    if (!res.ok) throw new Error('expected a valid capture');
    return JSON.parse(new TextDecoder().decode(res.bytes)) as Record<string, unknown>;
  };

  it('a project that sets no engine setting keeps its exact settings block and digest', () => {
    const doc = capture({});
    expect(Object.keys(doc['settings'] as object)).toEqual(Object.keys(SETTINGS));
    expect(doc['settingsDigest']).toBe(blockDigest(SETTINGS));
  });

  it('set engine settings follow the six in registry order and validate; out of order they are refused', () => {
    const doc = capture({ settings: { ...SETTINGS, fixed_step_hz: 60, animation_crossfade_s: 0.1 } });
    expect(validateManifestV2(doc).ok).toBe(true);
    const bad = capture({ settings: { ...SETTINGS, animation_crossfade_s: 0.1, fixed_step_hz: 60 } });
    expect(validateManifestV2(bad).ok).toBe(false);
    const unknown = capture({ settings: { ...SETTINGS, teleport: 1 } });
    expect(validateManifestV2(unknown).ok).toBe(false);
  });

  it('a model row carries its recorded bounds only when it has them', () => {
    const bounds = { min: [-1, 0, -0.5], max: [1, 2, 0.5] };
    const doc = capture({ assets: [{ ...ASSETS[0]!, bounds }] });
    expect((doc['assets'] as Record<string, unknown>[])[0]!['bounds']).toEqual(bounds);
    expect(validateManifestV2(doc).ok).toBe(true);
    expect('bounds' in (capture({})['assets'] as Record<string, unknown>[])[0]!).toBe(false);
  });
});

describe('manifest-v2: version-compat rule', () => {
  it('a v1 reader rejects a v2 document (manifest_version)', () => {
    const res = manifestVersionCompat({ manifestVersion: 2 }, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('manifest_version');
  });

  it('a v4 reader rejects a v1, v2 or v3 document (manifest_version)', () => {
    expect(manifestVersionCompat({ manifestVersion: 2 }, 4).ok).toBe(false);
    expect(manifestVersionCompat({ manifestVersion: 3 }, 4).ok).toBe(false);
    const res = manifestVersionCompat({ manifestVersion: 1 }, 4);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('manifest_version');
  });

  it('a matching version loads', () => {
    expect(manifestVersionCompat({ manifestVersion: 4 }, 4).ok).toBe(true);
    expect(manifestVersionCompat({ manifestVersion: 1 }, 1).ok).toBe(true);
  });
});

describe('manifest-v2: contract constants', () => {
  it('the v2 key order carries the six added keys and buildId last', () => {
    expect(MANIFEST_KEYS_V2).toHaveLength(42); // the blocks that grow with a project (materials, materialFunctions, uiDocuments, dialogue, buffers) are under contentFiles
    expect(MANIFEST_KEYS_V2).not.toContain('gameDigest');
    expect(MANIFEST_KEYS_V2).toContain('settingsDigest');
    expect(MANIFEST_KEYS_V2).toContain('mediaDigest');
    expect(MANIFEST_KEYS_V2).toContain('settings');
    expect(MANIFEST_KEYS_V2).not.toContain('game');
    expect(MANIFEST_KEYS_V2).toContain('media');
    expect(MANIFEST_KEYS_V2).not.toContain('flow');
    expect(MANIFEST_KEYS_V2[MANIFEST_KEYS_V2.length - 1]).toBe('buildId');
  });
});