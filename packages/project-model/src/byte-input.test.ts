/**
 * Constructed byte-input cases (fixtures/project-model/runtime/
 * byte-input-cases.md, normative packet 05 tests): encoding, strict JSON
 * syntax vs duplicate-key precedence, JSON Pointer escaping, numeric
 * overflow, whitespace tolerance, project version precedence and error
 * attribution. Uses the actual `parseManifest`/`parseScene`/`validateProject`
 * exports (NOT `JSON.parse` followed by validation). Every input is copied
 * and asserted byte-equal after every call.
 */

import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  parseScene,
  validateProject,
  validateScene,
  type ModelError,
} from '@thirdlight/project-model';
import { bytesEqual, decodeUtf8, fixtureBytes } from './test-fixtures';

const fileBytes = fixtureBytes;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
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

const valid = fileBytes('valid/minimal-scene.json');

function singleError(res: { ok: false; errors: readonly ModelError[] }, code: string, path: string): void {
  expect(res.errors.length).toBe(1);
  expect(res.errors[0]!.code).toBe(code);
  expect(res.errors[0]!.path).toBe(path);
}

describe('byte-input cases B1–B11', () => {
  it('B1: valid bytes parse; normalized value equals validateScene(JSON.parse(...))', () => {
    const g = new ByteGuard();
    const input = g.keep('B1', valid);
    const res = parseScene(input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const expected = validateScene(JSON.parse(decode(valid)));
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
    const res = parseScene(input);
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
    const res = parseScene(input);
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
    const input = g.keep('B4', utf8('{"schemaVersion":2,"schemaVersion":1,}'));
    const res = parseScene(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'json_parse_error', '');
    g.assertAllUnchanged();
  });

  it('B5: duplicate-key fixture => one duplicate_key at /schemaVersion (decoded key names)', () => {
    const g = new ByteGuard();
    const input = g.keep('B5', fileBytes('invalid/duplicate-key.json'));
    const res = parseScene(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'duplicate_key', '/schemaVersion');
    g.assertAllUnchanged();
  });

  it('B6: nested duplicate with JSON Pointer escaping => duplicate_key at /future/a~1b~0', () => {
    const g = new ByteGuard();
    const input = g.keep('B6', utf8('{"schemaVersion":2,"future":{"a/b~":0,"a\\u002fb~":1}}'));
    const res = parseScene(input);
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
    const res = parseScene(input);
    expect(res.ok).toBe(true);
    g.assertAllUnchanged();
  });

  it('B8: trailing value => one json_parse_error at ""', () => {
    const g = new ByteGuard();
    const input = g.keep('B8', Uint8Array.from([...valid, ...utf8(' null')]));
    const res = parseScene(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'json_parse_error', '');
    g.assertAllUnchanged();
  });

  it('B9: numeric-overflow fixture => two number_not_finite at position/0 and /1 (valid syntax)', () => {
    const g = new ByteGuard();
    const input = g.keep('B9', fileBytes('invalid/numeric-overflow.json'));
    const res = parseScene(input);
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
    const input = g.keep('B10', fileBytes('valid/demo-project/scenes/main.json'));
    const res = parseScene(input);
    expect(res.ok).toBe(true);
    g.assertAllUnchanged();
  });

  it('B11: BOM prefixed malformed UTF-8 => exactly one encoding_invalid (no further errors)', () => {
    const g = new ByteGuard();
    const malformed = Uint8Array.from([...utf8('{"name":"'), 0xc3, 0x28, ...utf8('"}')]);
    const input = g.keep('B11', Uint8Array.from([0xef, 0xbb, 0xbf, ...malformed]));
    const res = parseScene(input);
    expect(res.ok).toBe(false);
    if (!res.ok) singleError(res, 'encoding_invalid', '');
    g.assertAllUnchanged();
  });
});

// ---- project version precedence and error attribution --------------------------

/** Interchange composition per contract §13 (see fixture-index driver). */
function parseProjectInterchange(manifestBytes: Uint8Array, sceneBytes: Uint8Array) {
  const m = parseManifest(manifestBytes);
  const s = parseScene(sceneBytes);
  if (!m.ok || !s.ok) {
    const errors: ModelError[] = [];
    if (!m.ok) for (const e of m.errors) errors.push({ ...e, document: 'manifest' });
    if (!s.ok) for (const e of s.errors) errors.push({ ...e, document: 'scene' });
    return { ok: false as const, errors };
  }
  return validateProject(m.normalized, s.normalized);
}

describe('project version precedence and error attribution (byte-input-cases.md)', () => {
  const demoManifestBytes = fileBytes('valid/demo-project/project.json');
  const demoSceneBytes = fileBytes('valid/demo-project/scenes/main.json');
  const demoManifest = JSON.parse(decode(demoManifestBytes)) as Record<string, unknown>;
  const demoScene = JSON.parse(decode(demoSceneBytes)) as Record<string, unknown>;

  const ordered = (
    errors: readonly ModelError[],
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

  it('scene v2 + mismatched scene ID + absent required fields => one scene version error', () => {
    // Value route.
    const res = validateProject(demoManifest, { schemaVersion: 2, sceneId: 'scene-other' });
    expect(res.ok).toBe(false);
    if (!res.ok) ordered(res.errors, ['schema_version_unsupported', 'scene', '/schemaVersion']);
    // Byte route with the committed mixed-schema-versions fixture.
    const bytes = parseProjectInterchange(
      demoManifestBytes,
      fileBytes('invalid/mixed-schema-versions/scenes/main.json'),
    );
    expect(bytes.ok).toBe(false);
    if (!bytes.ok) {
      ordered(bytes.errors, ['schema_version_unsupported', 'scene', '/schemaVersion']);
      expect(bytes.errors[0]!.found).toBe(2);
    }
  });

  it('manifest v2, valid scene => one manifest version error', () => {
    const res = validateProject({ ...demoManifest, schemaVersion: 2 }, demoScene);
    expect(res.ok).toBe(false);
    if (!res.ok) ordered(res.errors, ['schema_version_unsupported', 'manifest', '/schemaVersion']);
  });

  it('both versions 2 => two version errors, manifest then scene (even when versions match)', () => {
    const res = validateProject({ ...demoManifest, schemaVersion: 2 }, { ...demoScene, schemaVersion: 2 });
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
    const res = validateProject({ ...demoManifest, schemaVersion: 2 }, sceneNoRevision);
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
    const res = validateProject(demoManifest, { ...demoScene, schemaVersion: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) ordered(res.errors, ['schema_version_unsupported', 'scene', '/schemaVersion']);
  });

  it('no case emits schema_mixed_versions (the code is not part of M1)', () => {
    const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ ...demoManifest, schemaVersion: 2 }, demoScene],
      [demoManifest, { ...demoScene, schemaVersion: 2 }],
      [{ ...demoManifest, schemaVersion: 2 }, { ...demoScene, schemaVersion: 2 }],
      [demoManifest, { ...demoScene, schemaVersion: 0 }],
    ];
    for (const [m, s] of pairs) {
      const res = validateProject(m, s);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      for (const e of res.errors) {
        expect(e.code).not.toBe('schema_mixed_versions');
      }
    }
  });

  it('valid manifest bytes + duplicate-key.json bytes => one tagged duplicate_key, no cross-document checks', () => {
    const res = parseProjectInterchange(
      demoManifestBytes,
      fileBytes('invalid/duplicate-key.json'),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      ordered(res.errors, ['duplicate_key', 'scene', '/schemaVersion']);
      // No manifest errors and no cross-document (manifest_scene_mismatch)
      // error: a parse failure stops cross-document checks.
      for (const e of res.errors) {
        expect(e.code).not.toBe('manifest_scene_mismatch');
      }
    }
  });
});