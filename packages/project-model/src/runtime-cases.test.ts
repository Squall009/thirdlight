/**
 * Runtime (non-JSON) validation cases — fixtures/project-model/runtime/
 * non-finite-cases.md (contract §12.7). JSON has no literal NaN/±Infinity
 * tokens, so R1–R4 are exercised IN MEMORY by building the document value
 * directly and passing it to the validator. R5 pins the serializer's
 * refusal behavior; R6 is covered by the non-strict-json fixture (asserted
 * here for completeness). `path` expectations follow the md: the code and
 * the path of the offending element are binding.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeScene,
  parseManifest,
  serializeCanonical,
  validateScene,
  type ModelError,
} from '@thirdlight/project-model';
import { bytesEqual, fixtureBytes } from './test-fixtures';

/** A minimal valid scene with one entity whose transform/camera is `mutate`'d. */
function sceneWith(mutate: (e: Record<string, unknown>) => void): Record<string, unknown> {
  const entity: Record<string, unknown> = {
    id: 'cam-main',
    components: {
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
    },
  };
  mutate(entity);
  return { schemaVersion: 1, sceneId: 'scene-main', revision: 0, entities: [entity] };
}

const T = (e: Record<string, unknown>) => e['components'] as Record<string, unknown>;
const TR = (e: Record<string, unknown>) => T(e)['transform'] as Record<string, unknown>;
const CAM = (e: Record<string, unknown>) => T(e)['camera'] as Record<string, unknown>;

function codesOf(res: { ok: false; errors: readonly ModelError[] }): string[] {
  return res.errors.map((e) => e.code);
}

describe('runtime non-finite cases R1–R6 (contract §12.7)', () => {
  it('R1: NaN in position => number_not_finite at .../position/0 (with found NaN)', () => {
    const doc = sceneWith((e) => {
      TR(e)['position'] = [Number.NaN, 0, 0];
    });
    const res = validateScene(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBe(1);
      expect(res.errors[0]!.code).toBe('number_not_finite');
      expect(res.errors[0]!.path).toBe('/entities/0/components/transform/position/0');
      expect(Number.isNaN(res.errors[0]!.found)).toBe(true);
    }
  });

  it('R2: scale [0, Infinity, 1] => number_not_finite (scale/1) AND number_out_of_range (scale/0)', () => {
    const doc = sceneWith((e) => {
      TR(e)['scale'] = [0, Number.POSITIVE_INFINITY, 1];
    });
    const res = validateScene(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const byPath = new Map(res.errors.map((er) => [er.path, er.code]));
      expect(byPath.get('/entities/0/components/transform/scale/1')).toBe('number_not_finite');
      expect(byPath.get('/entities/0/components/transform/scale/0')).toBe('number_out_of_range');
      expect(new Set(codesOf(res)).size).toBe(2);
      expect(new Set(codesOf(res))).toEqual(new Set(['number_not_finite', 'number_out_of_range']));
    }
  });

  it('R3: -Infinity in rotation => number_not_finite at .../rotation/1 (no quaternion error)', () => {
    const doc = sceneWith((e) => {
      TR(e)['rotation'] = [0, Number.NEGATIVE_INFINITY, 0, 1];
    });
    const res = validateScene(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBe(1);
      expect(res.errors[0]!.code).toBe('number_not_finite');
      expect(res.errors[0]!.path).toBe('/entities/0/components/transform/rotation/1');
    }
  });

  it('R4: finite-but-out-of-range fovY (1e308) => number_out_of_range at .../camera/fovY', () => {
    const doc = sceneWith((e) => {
      CAM(e)['fovY'] = 1e308;
    });
    const res = validateScene(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const fov = res.errors.find((er) => er.path === '/entities/0/components/camera/fovY');
      expect(fov?.code).toBe('number_out_of_range');
    }
  });

  it('R5: normalizer/serializer reject non-finite values and never emit NaN/Infinity tokens', () => {
    const r1 = sceneWith((e) => {
      TR(e)['position'] = [Number.NaN, 0, 0];
    });
    const r2 = sceneWith((e) => {
      TR(e)['scale'] = [0, Number.POSITIVE_INFINITY, 1];
    });
    const r3 = sceneWith((e) => {
      TR(e)['rotation'] = [0, Number.NEGATIVE_INFINITY, 0, 1];
    });
    for (const [i, doc] of [r1, r2, r3].entries()) {
      const n = normalizeScene(doc);
      expect(n.ok, `normalizeScene (case ${i + 1}) must reject`).toBe(false);
      if (!n.ok) {
        expect(n.errors.some((er) => er.code === 'number_not_finite')).toBe(true);
        // The serialized error payload must be valid STRICT JSON: no
        // NaN/Infinity tokens (JSON.parse rejects them).
        const payload = JSON.stringify(n);
        expect(() => JSON.parse(payload)).not.toThrow();
        expect(payload).not.toMatch(/:[ \t]*NaN|:[ \t]*-?Infinity/);
      }
      const s = serializeCanonical(doc);
      expect(s.ok, `serializeCanonical (case ${i + 1}) must reject`).toBe(false);
      if (!s.ok) {
        expect(s.errors.some((er) => er.code === 'number_not_finite')).toBe(true);
        const payload = JSON.stringify(s);
        expect(() => JSON.parse(payload)).not.toThrow();
        expect(payload).not.toMatch(/:[ \t]*NaN|:[ \t]*-?Infinity/);
      }
    }
  });

  it('R6: file containing NaN/Infinity tokens => json_parse_error; bytes retained', () => {
    const before = fixtureBytes('invalid/non-strict-json.json');
    const res = parseManifest(before);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBe(1);
      expect(res.errors[0]!.code).toBe('json_parse_error');
      expect(res.errors[0]!.path).toBe('');
    }
    // Original bytes retained (the parse is a pure reader).
    expect(bytesEqual(before, fixtureBytes('invalid/non-strict-json.json'))).toBe(true);
  });
});