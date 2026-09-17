/**
 * Normative fixture-index driver (fixtures/project-model/README.md "How
 * packet 05 must use this"; contract §16).
 *
 * `expected.json` (indexVersion 2) is the single source of truth for file
 * fixture expectations: file bytes go through `parseManifest`/`parseScene`;
 * project entries use the standalone interchange composition of contract
 * §13 (NOT workspace envelope loading). `expectedCodes` is the exact SET of
 * error codes; `expectedErrorCount` pins multiplicity; `expectedErrors`
 * pins the full ordered list by code/path/document. Valid entries run
 * through validation, repeated normalization, and the serialized
 * round-trip (idempotence, §12.2 rule 7); where `expectedNormalized`
 * exists, canonical bytes are compared with the golden file.
 */

import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  parseScene,
  validateManifest,
  validateScene,
  validateProject,
  serializeCanonical,
  type ModelError,
} from '@thirdlight/project-model';
import { bytesEqual, fixtureBytes, fixtureText } from './test-fixtures';

const bytes = fixtureBytes;
const text = fixtureText;

interface ExpectedError {
  code: string;
  path?: string;
  document?: string;
}
interface Entry {
  path: string;
  kind: string;
  valid: boolean;
  notes?: string;
  expectedCodes?: string[];
  expectedErrorCount?: number;
  expectedErrors?: ExpectedError[];
  expectedNormalized?: string;
}
const index = JSON.parse(text('expected.json')) as {
  indexVersion: number;
  entries: Entry[];
};

function codeSet(errors: readonly ModelError[]): string[] {
  return [...new Set(errors.map((e) => e.code))].sort();
}

function checkOrderedErrors(errors: readonly ModelError[], expected: ExpectedError[]): void {
  expect(errors.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = errors[i]!;
    const want = expected[i]!;
    expect(e.code).toBe(want.code);
    if (want.path !== undefined) expect(e.path).toBe(want.path);
    if (want.document !== undefined) expect(e.document).toBe(want.document);
  }
}

/**
 * Interchange project composition (contract §13): call both parse* entry
 * points; if either fails, combine/tag the errors (manifest then scene,
 * `document` discriminator) without cross-document checks; otherwise pass
 * the normalized values to validateProject.
 */
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

/** Valid-entry invariants: revalidation + normalization idempotence + serialized round-trip. */
function checkValidRoundTrip(label: string, kind: 'manifest' | 'scene', normalized: unknown): void {
  // (a) the normalized value re-validates.
  const revalidated = kind === 'scene' ? validateScene(normalized) : validateManifest(normalized);
  expect(revalidated.ok, `${label}: normalized value must revalidate`).toBe(true);
  // (b) a second normalization pass is byte-identical, including the
  //     serialized/reparsed round-trip (§12.2 rule 7).
  const r1 = serializeCanonical(normalized);
  expect(r1.ok, `${label}: serializeCanonical must succeed on the normalized value`).toBe(true);
  if (!r1.ok) return;
  const reparse = kind === 'scene' ? parseScene(r1.bytes) : parseManifest(r1.bytes);
  expect(reparse.ok, `${label}: canonical bytes must reparse`).toBe(true);
  if (reparse.ok) {
    expect(reparse.normalized, `${label}: reparsed value must equal the normalized value`).toEqual(normalized);
  }
  const r2 = serializeCanonical(reparse.ok ? reparse.normalized : normalized);
  expect(r2.ok).toBe(true);
  if (r1.ok && r2.ok) {
    expect(
      bytesEqual(r2.bytes, r1.bytes),
      `${label}: canonical bytes must be idempotent (second pass byte-identical)`,
    ).toBe(true);
  }
}

describe('fixture index (expected.json, indexVersion 2)', () => {
  it('index sanity: version 2, unique entry paths, invalid entries carry codes', () => {
    expect(index.indexVersion).toBe(2);
    const paths = index.entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const e of index.entries) {
      if (!e.valid) {
        expect(e.expectedCodes?.length, `${e.path} must pin expectedCodes`).toBeGreaterThan(0);
      }
    }
  });

  for (const entry of index.entries) {
    const label = `${entry.valid ? 'valid' : 'invalid'} ${entry.path} (${entry.kind})`;
    it(label, () => {
      const files =
        entry.kind === 'project'
          ? [`${entry.path}/project.json`, `${entry.path}/scenes/main.json`]
          : [entry.path];

      if (entry.valid) {
        if (entry.kind === 'project') {
          const res = parseProjectInterchange(bytes(files[0]!), bytes(files[1]!));
          expect(res.ok, `${label} must parse and validate`).toBe(true);
          if (res.ok) {
            checkValidRoundTrip(label, 'scene', res.normalized.scene);
            checkValidRoundTrip(label + ' [manifest]', 'manifest', res.normalized.manifest);
          }
          return;
        }
        if (entry.kind === 'manifest') {
          const res = parseManifest(bytes(entry.path));
          expect(res.ok, `${label} must parse and validate`).toBe(true);
          if (!res.ok) return;
          checkValidRoundTrip(label, 'manifest', res.normalized);
          return;
        }
        // kind: scene
        const res = parseScene(bytes(entry.path));
        expect(res.ok, `${label} must parse and validate`).toBe(true);
        if (!res.ok) return;
        checkValidRoundTrip(label, 'scene', res.normalized);
        if (entry.expectedNormalized) {
          const ser = serializeCanonical(res.normalized);
          expect(ser.ok).toBe(true);
          if (ser.ok) {
            expect(
              bytesEqual(ser.bytes, bytes(entry.expectedNormalized)),
              `${label}: canonical bytes must equal the golden file ${entry.expectedNormalized}`,
            ).toBe(true);
          }
        }
        return;
      }

      // Invalid entry: run the documented entry point and compare the
      // EXACT set of codes (plus count / ordered list where pinned).
      let errors: readonly ModelError[];
      if (entry.kind === 'project') {
        const res = parseProjectInterchange(bytes(files[0]!), bytes(files[1]!));
        expect(res.ok, `${label} must fail`).toBe(false);
        if (res.ok) return;
        errors = res.errors;
      } else {
        const res = entry.kind === 'manifest' ? parseManifest(bytes(entry.path)) : parseScene(bytes(entry.path));
        expect(res.ok, `${label} must fail`).toBe(false);
        if (res.ok) return;
        errors = res.errors;
      }
      expect(
        codeSet(errors),
        `${label}: exact code set (unexpected additional codes are a defect)`,
      ).toEqual([...entry.expectedCodes!].sort());
      if (entry.expectedErrorCount !== undefined) {
        expect(errors.length, `${label}: pinned error count`).toBe(entry.expectedErrorCount);
      }
      if (entry.expectedErrors) {
        checkOrderedErrors(errors, entry.expectedErrors);
      }
    });
  }

  it('valid/minimal-scene.json is content-identical to the §15 default creation scene', () => {
    // Contract §15 default scene template (normative).
    const template = {
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        {
          id: 'cam-main',
          name: 'Main Camera',
          components: {
            transform: {
              position: [0, 0.5, 4],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
            camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
          },
        },
      ],
    };
    const res = parseScene(bytes('valid/minimal-scene.json'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.normalized).toEqual(template);
  });

  it('invalid fixtures retain their source bytes (no destructive rewrite)', () => {
    // The parser is a pure reader; pin the observable: bytes read before
    // and after parse are identical (contract §12.3/§12.4, charter §6).
    for (const p of [
      'invalid/unsupported-version.json',
      'invalid/numeric-overflow.json',
      'invalid/non-strict-json.json',
      'invalid/duplicate-key.json',
    ]) {
      const before = bytes(p);
      const res = p.endsWith('non-strict-json.json') ? parseManifest(before) : parseScene(before);
      expect(res.ok).toBe(false);
      expect(bytesEqual(before, bytes(p)), `${p} must be retained untouched`).toBe(true);
    }
  });
});