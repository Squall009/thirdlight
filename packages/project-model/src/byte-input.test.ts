/**
 * Constructed byte-input cases (the packet-05 byte-input-cases.md list,
 * archived with the M1 corpus under
 * archive/removed-v1-v2/fixtures-project-model/runtime/): encoding, strict
 * JSON syntax vs duplicate-key precedence, JSON Pointer escaping, numeric
 * overflow, whitespace tolerance, project version precedence and error
 * attribution. Uses the actual `parseManifest`/`parseSceneV3` exports (NOT
 * `JSON.parse` followed by validation). Every input is copied and asserted
 * byte-equal after every call.
 *
 * Phase 9.3: the M1 `parseScene`/`validateProject` were removed; the scene
 * inputs are schemaVersion 3 documents (inline, test-docs-v3.ts) and the
 * project cases run through `validateProjectV3` (manifest + scene + content).
 */

import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  parseSceneV3,
  validateContentV3,
  validateProjectV3,
  validateSceneV3,
  type ModelErrorV3,
} from '@thirdlight/project-model';
import { bytesEqual, decodeUtf8 } from './test-fixtures';
import {
  DEMO_MANIFEST_TEXT,
  DEMO_SCENE_TEXT,
  DUPLICATE_KEY_SCENE_TEXT,
  MINIMAL_SCENE_TEXT,
  NUMERIC_OVERFLOW_SCENE_TEXT,
  emptyContentV3,
  utf8,
} from './test-docs-v3';

const decode = decodeUtf8;

/** Copies each input; `expectBytesUnchanged` asserts byte equality after calls. */
class ByteGuard {
  private before = new Map<string, Uint8Array>();
  keep(key: string, b: Uint8Array): Uint8Array {
    this.before.set(key, b.slice());
    return b;
  }
  assertAllUnchanged(): void {
    for (const [key, b] of this.before) {
      expect(
        bytesEqual(b, this.before.get(key)!),
        `${key}: input bytes must be untouched by the parse call`,
      ).toBe(true);
    }
  }
}

const valid = utf8(MINIMAL_SCENE_TEXT);

function singleError(res: { ok: false; errors: readonly ModelErrorV3[] }, code: string, path: string): void {
  expect(res.errors.length).toBe(1);
  expect(res.errors[0]!.code).toBe(code);
  expect(res.errors[0]!.path).toBe(path);
}

describe('byte-input cases B1–B11', () => {
  it('B1: valid bytes parse; normalized value equals validateSceneV3(JSON.parse(...))', () => {
    const g = new ByteGuard();
    const input = g.keep('B1', valid);
    const res = parseSceneV3(input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const expected = validateSceneV3(JSON.parse(decode(valid)));
      expect(expected.ok).toBe(true);
      if (expected.ok) expect(res.normalized).toEqual(expected.normalized);
    }
    g.assertAllUnchanged();
  });

  it('B2: leading BOM => exactly one encoding_invalid at "" (not silently stripped)', () => {
    const g = new ByteGuard();
    const input = g.keep(
      'B2',
      Uint8Array.from([0xef, 0xbb, 0xbf, ...valid]),
    );
    const res = parseSceneV3(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'encoding_invalid', '');
    g.assertAllUnchanged();
  });

  it('B3: malformed UTF-8 => exactly one encoding_invalid at "" (no U+FFFD replacement)', () => {
    const g = new ByteGuard();
    const input = g.keep(
      'B3',
      Uint8Array.from([...utf8('{"name":"'), 0xc3, 0x28, ...utf8('"}')]),
    );
    const res = parseSceneV3(input);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      singleError(res, 'encoding_invalid', '');
      // No replacement character may have been decoded (the failure happens
      // before any value materialization).
      expect(res.errors[0]!.found).toBe(0x28);
    }
    g.assertAllUnchanged();
  });

  it('B4: syntax takes precedence over duplicates and version checking', () => {
    const g = new ByteGuard();
    const input = g.keep('B4', utf8('{"schemaVersion":2,"schemaVersion":3,}'));
    const res = parseSceneV3(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'json_parse_error', '');
    g.assertAllUnchanged();
  });

  it('B5: duplicate-key fixture => one duplicate_key at /schemaVersion (decoded key names)', () => {
    const g = new ByteGuard();
    const input = g.keep('B5', utf8(DUPLICATE_KEY_SCENE_TEXT));
    const res = parseSceneV3(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'duplicate_key', '/schemaVersion');
    g.assertAllUnchanged();
  });

  it('B6: nested duplicate with JSON Pointer escaping => duplicate_key at /future/a~1b~0', () => {
    const g = new ByteGuard();
    const input = g.keep('B6', utf8('{"schemaVersion":2,"future":{"a/b~":0,"a\\u002fb~":1}}'));
    const res = parseSceneV3(input);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      singleError(res, 'duplicate_key', '/future/a~1b~0');
      // The repeated (decoded) name is `a/b~`.
      expect(res.errors[0]!.found).toBe('a/b~');
    }
    g.assertAllUnchanged();
  });

  it('B7: trailing ASCII space is accepted (input need not be canonical)', () => {
    const g = new ByteGuard();
    const input = g.keep('B7', Uint8Array.from([...valid, 0x20]));
    const res = parseSceneV3(input);
    expect(res.ok).toBe(true);
    g.assertAllUnchanged();
  });

  it('B8: trailing value => one json_parse_error at ""', () => {
    const g = new ByteGuard();
    const input = g.keep('B8', Uint8Array.from([...valid, ...utf8(' null')]));
    const res = parseSceneV3(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'json_parse_error', '');
    g.assertAllUnchanged();
  });

  it('B9: numeric-overflow fixture => two number_not_finite at position/0 and /1 (valid syntax)', () => {
    const g = new ByteGuard();
    const input = g.keep('B9', utf8(NUMERIC_OVERFLOW_SCENE_TEXT));
    const res = parseSceneV3(input);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBe(2);
      expect(res.errors[0]!.code).toBe('number_not_finite');
      expect(res.errors[0]!.path).toBe('/entities/0/components/transform/position/0');
      expect(res.errors[1]!.code).toBe('number_not_finite');
      expect(res.errors[1]!.path).toBe('/entities/0/components/transform/position/1');
    }
    g.assertAllUnchanged();
  });

  it('B10: demo scene bytes parse (repeated names in separate objects are not duplicates)', () => {
    const g = new ByteGuard();
    const input = g.keep('B10', utf8(DEMO_SCENE_TEXT));
    const res = parseSceneV3(input);
    expect(res.ok).toBe(true);
    g.assertAllUnchanged();
  });

  it('B11: BOM prefixed malformed UTF-8 => exactly one encoding_invalid (no further errors)', () => {
    const g = new ByteGuard();
    const malformed = Uint8Array.from([...utf8('{"name":"'), 0xc3, 0x28, ...utf8('"}')]);
    const input = g.keep('B11', Uint8Array.from([0xef, 0xbb, 0xbf, ...malformed]));
    const res = parseSceneV3(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'encoding_invalid', '');
    g.assertAllUnchanged();
  });
});

// ---- project version precedence and error attribution --------------------------

/**
 * Byte composition of a storage-v3 project's parts: both strict byte parsers
 * run; if either fails, the errors are combined and tagged (manifest then
 * scene, `document` discriminator) without cross-document checks; otherwise
 * the normalized values go to `validateProjectV3` with the content block.
 */
function parseProjectBytes(manifestBytes: Uint8Array, sceneBytes: Uint8Array, content: unknown = emptyContentV3()) {
  const m = parseManifest(manifestBytes);
  const s = parseSceneV3(sceneBytes);
  if (!m.ok || !s.ok) {
    const errors: ModelErrorV3[] = [];
    if (!m.ok) for (const e of m.errors) errors.push({ ...(e as ModelErrorV3), document: 'manifest' });
    if (!s.ok) for (const e of s.errors) errors.push({ ...e, document: 'scene' });
    return { ok: false as const, errors };
  }
  return validateProjectV3(m.normalized, s.normalized, content);
}

describe('project version precedence and error attribution (byte-input-cases.md)', () => {
  const demoManifestBytes = utf8(DEMO_MANIFEST_TEXT);
  const demoSceneBytes = utf8(DEMO_SCENE_TEXT);
  const demoManifest = JSON.parse(decode(demoManifestBytes)) as Record<string, unknown>;
  const demoScene = JSON.parse(decode(demoSceneBytes)) as Record<string, unknown>;
  const content = emptyContentV3();

  const ordered = (
    errors: readonly ModelErrorV3[],
    ...want: [string, string, string][] // [code, document, path]
  ): void => {
    expect(errors.length).toBe(want.length);
    want.forEach(([code, document, path], i) => {
      const e = errors[i]!;
      expect(e.code).toBe(code);
      expect(e.document).toBe(document);
      expect(e.path).toBe(path);
    });
  };

  it('the demo project parts load (bytes and values agree)', () => {
    expect(validateContentV3(content).ok).toBe(true);
    const bytes = parseProjectBytes(demoManifestBytes, demoSceneBytes);
    expect(bytes.ok).toBe(true);
    const value = validateProjectV3(demoManifest, demoScene, content);
    expect(value.ok).toBe(true);
    if (bytes.ok && value.ok) expect(bytes.normalized).toEqual(value.normalized);
  });

  it('scene v2 + mismatched scene ID + absent required fields => one scene version error', () => {
    // Value route.
    const res = validateProjectV3(demoManifest, { schemaVersion: 2, sceneId: 'scene-other' }, content);
    expect(res.ok).toBe(false);
    if (!res.ok) ordered(res.errors, ['schema_version_unsupported', 'scene', '/schemaVersion']);
    // Byte route (the mixed-schema-versions case: a valid manifest, an old scene).
    const bytes = parseProjectBytes(demoManifestBytes, utf8('{\n  "schemaVersion": 2,\n  "sceneId": "scene-other",\n  "futureField": true\n}\n'));
    expect(bytes.ok).toBe(false);
    if (!bytes.ok) {
      ordered(bytes.errors, ['schema_version_unsupported', 'scene', '/schemaVersion']);
      expect(bytes.errors[0]!.found).toBe(2);
      expect(bytes.errors[0]!.knownVersions).toEqual([3, 4]);
    }
  });

  it('manifest v2, valid scene => one manifest version error', () => {
    const res = validateProjectV3({ ...demoManifest, schemaVersion: 2 }, demoScene, content);
    expect(res.ok).toBe(false);
    if (!res.ok) ordered(res.errors, ['schema_version_unsupported', 'manifest', '/schemaVersion']);
  });

  it('manifest v2 and scene v2 => two version errors, manifest then scene', () => {
    const res = validateProjectV3({ ...demoManifest, schemaVersion: 2 }, { ...demoScene, schemaVersion: 2 }, content);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      ordered(
        res.errors,
        ['schema_version_unsupported', 'manifest', '/schemaVersion'],
        ['schema_version_unsupported', 'scene', '/schemaVersion'],
      );
    }
  });

  it('manifest v2 + scene missing revision => version error plus the scene field error', () => {
    const { revision: _rev, ...sceneNoRevision } = demoScene;
    void _rev;
    const res = validateProjectV3({ ...demoManifest, schemaVersion: 2 }, sceneNoRevision, content);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      ordered(
        res.errors,
        ['schema_version_unsupported', 'manifest', '/schemaVersion'],
        ['field_missing', 'scene', '/revision'],
      );
    }
  });

  it('scene v0, valid manifest => one scene version error', () => {
    const res = validateProjectV3(demoManifest, { ...demoScene, schemaVersion: 0 }, content);
    expect(res.ok).toBe(false);
    if (!res.ok) ordered(res.errors, ['schema_version_unsupported', 'scene', '/schemaVersion']);
  });

  it('manifest, scene and content errors are all attributed, in that order', () => {
    const res = validateProjectV3({ ...demoManifest, schemaVersion: 2 }, { ...demoScene, schemaVersion: 1 }, { ...content, extra: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      ordered(
        res.errors,
        ['schema_version_unsupported', 'manifest', '/schemaVersion'],
        ['schema_version_unsupported', 'scene', '/schemaVersion'],
        ['field_unexpected', 'content', '/extra'],
      );
    }
  });

  it('valid manifest bytes + duplicate-key scene bytes => one tagged duplicate_key, no cross-document checks', () => {
    const res = parseProjectBytes(demoManifestBytes, utf8(DUPLICATE_KEY_SCENE_TEXT));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      ordered(res.errors, ['duplicate_key', 'scene', '/schemaVersion']);
      // No manifest errors and no cross-document (manifest_scene_mismatch)
      // error: a parse failure stops cross-document checks.
      for (const e of res.errors) expect(e.code).not.toBe('manifest_scene_mismatch');
    }
  });
});
