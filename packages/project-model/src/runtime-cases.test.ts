/**
 * Runtime (non-JSON) validation cases — the packet-05 non-finite cases
 * (contract §12.7; the M1 case list lives on in
 * archive/removed-v1-v2/fixtures-project-model/runtime/non-finite-cases.md).
 * JSON has no literal NaN/±Infinity tokens, so R1–R4 are exercised IN MEMORY
 * by building the document value directly and passing it to the validator.
 * R5 pins the serializer's refusal behavior; R6 pins the strict byte parser
 * on a manifest carrying NaN/Infinity tokens (inline bytes). The code and the
 * path of the offending element are binding.
 *
 * Phase 9.3: driven through the live v3 scene validator (`validateSceneV3`,
 * `normalizeSceneV3`), plus `validateSceneV4` in the last case.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSceneV3,
  parseManifest,
  serializeCanonical,
  validateSceneV3,
  validateSceneV4,
  type ModelErrorV3,
} from '@thirdlight/project-model';
import { bytesEqual } from './test-fixtures';

/** A manifest with NaN/Infinity tokens: INTENTIONALLY not strict JSON. */
const NON_STRICT_JSON = `{
  "schemaVersion": 1,
  "engineVersion": "0.1.0",
  "id": "bad-project",
  "name": "Non-finite tokens",
  "createdAt": "2026-09-16T23:40:00Z",
  "scenes": [
    { "id": "scene-main", "path": "scenes/main.json" }
  ],
  "lastEditPosition": NaN,
  "lastEditScale": Infinity
}
`;

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
  return { schemaVersion: 3, sceneId: 'scene-main', revision: 0, entities: [entity] };
}

const T = (e: Record<string, unknown>) => e['components'] as Record<string, unknown>;
const TR = (e: Record<string, unknown>) => T(e)['transform'] as Record<string, unknown>;
const CAM = (e: Record<string, unknown>) => T(e)['camera'] as Record<string, unknown>;

function codesOf(res: { ok: false; errors: readonly ModelErrorV3[] }): string[] {
  return res.errors.map((e) => e.code);
}

describe('runtime non-finite cases R1–R6 (contract §12.7)', () => {
  it('R1: NaN in position => number_not_finite at .../position/0 (with found NaN)', () => {
    const doc = sceneWith((e) => {
      TR(e)['position'] = [Number.NaN, 0, 0];
    });
    const res = validateSceneV3(doc);
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
    const res = validateSceneV3(doc);
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
    const res = validateSceneV3(doc);
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
    const res = validateSceneV3(doc);
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
      const n = normalizeSceneV3(doc);
      expect(n.ok, `normalizeSceneV3 (case ${i + 1}) must reject`).toBe(false);
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
    const before = new TextEncoder().encode(NON_STRICT_JSON);
    const copy = before.slice();
    const res = parseManifest(before);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBe(1);
      expect(res.errors[0]!.code).toBe('json_parse_error');
      expect(res.errors[0]!.path).toBe('');
    }
    // Original bytes retained (the parse is a pure reader).
    expect(bytesEqual(before, copy)).toBe(true);
  });

  it('R1–R3 hold for a v4 scene too (validateSceneV4 and serializeCanonical)', () => {
    const cases: [(e: Record<string, unknown>) => void, string][] = [
      [(e) => { TR(e)['position'] = [Number.NaN, 0, 0]; }, '/entities/0/components/transform/position/0'],
      [(e) => { TR(e)['scale'] = [1, Number.POSITIVE_INFINITY, 1]; }, '/entities/0/components/transform/scale/1'],
      [(e) => { TR(e)['rotation'] = [0, Number.NEGATIVE_INFINITY, 0, 1]; }, '/entities/0/components/transform/rotation/1'],
    ];
    for (const [mutate, path] of cases) {
      const doc = { ...sceneWith(mutate), schemaVersion: 4 };
      const res = validateSceneV4(doc);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.map((er) => [er.code, er.path])).toEqual([['number_not_finite', path]]);
      const s = serializeCanonical(doc);
      expect(s.ok).toBe(false);
      if (!s.ok) expect(s.errors.some((er) => er.code === 'number_not_finite' && er.path === path)).toBe(true);
    }
  });
});
