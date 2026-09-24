/**
 * The packet-05 document cases on the live v3 model (phase 9.3 port of the
 * M1 fixture-index driver, archived with its corpus under
 * archive/removed-v1-v2/). Each case is a schemaVersion 3 scene (or a
 * storage-v3 project: v1 manifest + v3 scene + v3 content) built inline and
 * run through the strict byte parsers (`parseManifest`/`parseSceneV3`) and
 * `validateProjectV3`. Invalid cases pin the EXACT set of error codes (plus
 * count / ordered code+path where it matters); valid cases run revalidation,
 * repeated normalization and the serialized round-trip (idempotence, §12.2
 * rule 7), with a golden canonical text for the quaternion case.
 *
 * Differences from the M1 corpus, all real v3 behaviour: `light` is a v3
 * component, so the unknown-component case uses `teleporter`; the known scene
 * versions are [3, 4], so the "future" version is 5 and the "past" ones 2
 * and 0.
 */

import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  parseSceneV3,
  serializeCanonical,
  validateManifest,
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

const T = (position: number[] = [0, 0, 0], rotation: number[] = [0, 0, 0, 1], scale: number[] = [1, 1, 1]) => ({ position, rotation, scale });
const CAMERA = { type: 'perspective', fovY: 60, near: 0.1, far: 100 };
const cam = (id = 'cam-main') => ({ id, name: 'Main Camera', components: { transform: T([0, 0.5, 4]), camera: CAMERA } });
const box = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  ...extra,
  components: { transform: T(), box: { size: [1, 1, 1], material: { color: '#a0a0a0' } } },
});
const scene = (entities: unknown[], extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ schemaVersion: 3, sceneId: 'scene-main', revision: 0, entities, ...extra }, null, 2)}\n`;

function codeSet(errors: readonly { code: string }[]): string[] {
  return [...new Set(errors.map((e) => e.code))].sort();
}

/** Parse both project parts from bytes; tag parse errors; else validateProjectV3. */
function parseProjectBytes(manifestText: string, sceneText: string) {
  const m = parseManifest(utf8(manifestText));
  const s = parseSceneV3(utf8(sceneText));
  if (!m.ok || !s.ok) {
    const errors: ModelErrorV3[] = [];
    if (!m.ok) for (const e of m.errors) errors.push({ ...(e as ModelErrorV3), document: 'manifest' });
    if (!s.ok) for (const e of s.errors) errors.push({ ...e, document: 'scene' });
    return { ok: false as const, errors };
  }
  return validateProjectV3(m.normalized, s.normalized, emptyContentV3());
}

/** Valid-case invariants: revalidation + normalization idempotence + serialized round-trip. */
function checkValidRoundTrip(label: string, kind: 'manifest' | 'scene', normalized: unknown): void {
  const revalidated = kind === 'scene' ? validateSceneV3(normalized) : validateManifest(normalized);
  expect(revalidated.ok, `${label}: normalized value must revalidate`).toBe(true);
  const r1 = serializeCanonical(normalized);
  expect(r1.ok, `${label}: serializeCanonical must succeed on the normalized value`).toBe(true);
  if (!r1.ok) return;
  const reparse = kind === 'scene' ? parseSceneV3(r1.bytes) : parseManifest(r1.bytes);
  expect(reparse.ok, `${label}: canonical bytes must reparse`).toBe(true);
  if (reparse.ok) expect(reparse.normalized, `${label}: reparsed value must equal the normalized value`).toEqual(normalized);
  const r2 = serializeCanonical(reparse.ok ? reparse.normalized : normalized);
  expect(r2.ok).toBe(true);
  if (r2.ok) expect(bytesEqual(r2.bytes, r1.bytes), `${label}: canonical bytes must be idempotent`).toBe(true);
}

// ---- valid cases ---------------------------------------------------------------

const QUATERNION_SCENE = `{
  "schemaVersion": 3,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [
    {
      "id": "cam-main",
      "components": {
        "transform": {
          "position": [-0, 0, 0],
          "rotation": [0.3779644730092272, 0.7559289460184544, 0.3779644730092272, 0.3779644730092272]
        },
        "camera": {}
      }
    },
    {
      "id": "negative-q",
      "components": {
        "transform": {
          "rotation": [-0.3779644730092272, -0.7559289460184544, -0.3779644730092272, -0.3779644730092272]
        }
      }
    },
    { "id": "near-unit-low", "components": { "transform": { "rotation": [0, 0, 0, 0.99995] } } },
    { "id": "near-unit-high", "components": { "transform": { "rotation": [0, 0, 0, 1.00005] } } }
  ]
}
`;

/** Golden canonical form: -0 → 0, defaults filled, quaternions verbatim (never renormalized or sign-flipped). */
const QUATERNION_GOLDEN = `${JSON.stringify(
  {
    schemaVersion: 3,
    sceneId: 'scene-main',
    revision: 0,
    entities: [
      { id: 'cam-main', components: { transform: T([0, 0, 0], [0.3779644730092272, 0.7559289460184544, 0.3779644730092272, 0.3779644730092272]), camera: CAMERA } },
      { id: 'negative-q', components: { transform: T([0, 0, 0], [-0.3779644730092272, -0.7559289460184544, -0.3779644730092272, -0.3779644730092272]) } },
      { id: 'near-unit-low', components: { transform: T([0, 0, 0], [0, 0, 0, 0.99995]) } },
      { id: 'near-unit-high', components: { transform: T([0, 0, 0], [0, 0, 0, 1.00005]) } },
    ],
  },
  null,
  2,
)}\n`;

const DEFAULTS_OMITTED_SCENE = scene([
  { id: 'root', components: { transform: {} } },
  { id: 'cube', parentId: 'root', components: { transform: {}, box: {} } },
  { id: 'cam-main', components: { transform: {}, camera: {} } },
]);

describe('valid v3 cases: parse, validate, normalize, byte round trip', () => {
  it('demo project (manifest + scene + empty content)', () => {
    const res = parseProjectBytes(DEMO_MANIFEST_TEXT, DEMO_SCENE_TEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    checkValidRoundTrip('demo project [scene]', 'scene', res.normalized.scene);
    checkValidRoundTrip('demo project [manifest]', 'manifest', res.normalized.manifest);
  });

  for (const [label, text] of [
    ['demo scene', DEMO_SCENE_TEXT],
    ['minimal scene', MINIMAL_SCENE_TEXT],
    ['defaults omitted', DEFAULTS_OMITTED_SCENE],
    ['quaternion round trip', QUATERNION_SCENE],
  ] as const) {
    it(label, () => {
      const res = parseSceneV3(utf8(text));
      expect(res.ok, `${label} must parse and validate`).toBe(true);
      if (res.ok) checkValidRoundTrip(label, 'scene', res.normalized);
    });
  }

  it('demo manifest', () => {
    const res = parseManifest(utf8(DEMO_MANIFEST_TEXT));
    expect(res.ok).toBe(true);
    if (res.ok) checkValidRoundTrip('demo manifest', 'manifest', res.normalized);
  });

  it('quaternion round trip: canonical bytes equal the golden text', () => {
    const res = parseSceneV3(utf8(QUATERNION_SCENE));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ser = serializeCanonical(res.normalized);
    expect(ser.ok).toBe(true);
    if (ser.ok) expect(decodeUtf8(ser.bytes)).toBe(QUATERNION_GOLDEN);
  });

  it('defaults omitted: the normalizer fills every default', () => {
    const res = parseSceneV3(utf8(DEFAULTS_OMITTED_SCENE));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.normalized.entities).toEqual([
      { id: 'root', components: { transform: T() } },
      { id: 'cube', parentId: 'root', components: { transform: T(), box: { size: [1, 1, 1], material: { color: '#b0b0b0' } } } },
      { id: 'cam-main', components: { transform: T(), camera: CAMERA } },
    ]);
  });
});

// ---- invalid cases ----------------------------------------------------------------

interface InvalidCase {
  label: string;
  kind: 'scene' | 'manifest' | 'project';
  text: string;
  manifestText?: string;
  codes: string[];
  count?: number;
  ordered?: [string, string, string?][]; // [code, path, document?]
}

const NON_STRICT_MANIFEST = `{
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

const INVALID_NUMBERS = scene([
  { id: 'e-zero-q', components: { transform: T([0, 0, 0], [0, 0, 0, 0]) } },
  { id: 'e-long-q', components: { transform: T([0, 0, 0], [1, 0, 0, 1]) } },
  { id: 'e-neg-scale', components: { transform: T([0, 0, 0], [0, 0, 0, 1], [-1, 1, 1]) } },
  { id: 'e-zero-size', components: { transform: T(), box: { size: [2, 0, 1], material: { color: '#a0a0a0' } } } },
  { id: 'e-bad-type', components: { transform: { position: [0, '1', 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } },
  { id: 'e-bad-cam', components: { transform: T([0, 0.5, 4]), camera: { type: 'perspective', fovY: 200, near: 0.1, far: 2000000 } } },
]);

const INVALID: InvalidCase[] = [
  { label: 'duplicate key (escaped)', kind: 'scene', text: DUPLICATE_KEY_SCENE_TEXT, codes: ['duplicate_key'], count: 1, ordered: [['duplicate_key', '/schemaVersion']] },
  {
    label: 'numeric overflow (1e400 decodes to Infinity)',
    kind: 'scene',
    text: NUMERIC_OVERFLOW_SCENE_TEXT,
    codes: ['number_not_finite'],
    count: 2,
    ordered: [
      ['number_not_finite', '/entities/0/components/transform/position/0'],
      ['number_not_finite', '/entities/0/components/transform/position/1'],
    ],
  },
  {
    label: 'mixed schema versions (v1 manifest, v2 scene)',
    kind: 'project',
    manifestText: DEMO_MANIFEST_TEXT,
    text: '{\n  "schemaVersion": 2,\n  "sceneId": "scene-other",\n  "futureField": true\n}\n',
    codes: ['schema_version_unsupported'],
    count: 1,
    ordered: [['schema_version_unsupported', '/schemaVersion', 'scene']],
  },
  {
    label: 'duplicate ids (first occurrence wins)',
    kind: 'scene',
    text: scene([box('e-dup'), box('e-dup'), cam()]),
    codes: ['id_duplicate'],
    count: 1,
    ordered: [['id_duplicate', '/entities/1/id']],
  },
  {
    label: 'hierarchy cycle a->b->a',
    kind: 'scene',
    text: scene([box('node-a', { parentId: 'node-b' }), box('node-b', { parentId: 'node-a' }), cam()]),
    codes: ['hierarchy_cycle', 'order_parent_before_child'],
  },
  {
    label: 'missing parent reference',
    kind: 'scene',
    text: scene([box('orphan', { parentId: 'ghost' }), cam()]),
    codes: ['reference_missing'],
    count: 1,
    ordered: [['reference_missing', '/entities/0/parentId']],
  },
  { label: 'invalid numbers (all errors collected)', kind: 'scene', text: INVALID_NUMBERS, codes: ['field_type', 'number_out_of_range', 'quaternion_invalid'] },
  {
    label: 'unknown component',
    kind: 'scene',
    text: scene([{ id: 'lamp', components: { transform: T([0, 2, 0]), teleporter: { range: 1 } } }, cam()]),
    codes: ['component_unknown'],
    count: 1,
    ordered: [['component_unknown', '/entities/0/components/teleporter']],
  },
  { label: 'two cameras', kind: 'scene', text: scene([cam(), cam('cam-second'), box('block')]), codes: ['camera_count_invalid'], count: 1 },
  {
    label: 'missing transform',
    kind: 'scene',
    text: scene([{ id: 'floating-box', components: { box: { size: [1, 1, 1] } } }, cam()]),
    codes: ['component_missing'],
    count: 1,
    ordered: [['component_missing', '/entities/0/components/transform']],
  },
  { label: 'unsupported future version 5', kind: 'scene', text: scene([cam()], { schemaVersion: 5 }), codes: ['schema_version_unsupported'], count: 1 },
  { label: 'unsupported past version 2 (the removed M2 scene)', kind: 'scene', text: scene([cam()], { schemaVersion: 2 }), codes: ['schema_version_unsupported'], count: 1 },
  { label: 'unsupported past version 0', kind: 'scene', text: scene([cam()], { schemaVersion: 0 }), codes: ['schema_version_unsupported'], count: 1 },
  { label: 'non-strict JSON (NaN/Infinity tokens)', kind: 'manifest', text: NON_STRICT_MANIFEST, codes: ['json_parse_error'], count: 1, ordered: [['json_parse_error', '']] },
  {
    label: 'manifest/scene id mismatch',
    kind: 'project',
    manifestText: DEMO_MANIFEST_TEXT,
    text: scene([cam()], { sceneId: 'scene-other' }),
    codes: ['manifest_scene_mismatch'],
    count: 1,
    ordered: [['manifest_scene_mismatch', '/scenes/0/id', 'manifest']],
  },
];

describe('invalid v3 cases: exact code sets, counts and non-destructive failure', () => {
  for (const c of INVALID) {
    it(c.label, () => {
      const before = utf8(c.text);
      const copy = before.slice();
      const res =
        c.kind === 'project' ? parseProjectBytes(c.manifestText!, c.text) : c.kind === 'manifest' ? parseManifest(before) : parseSceneV3(before);
      expect(res.ok, `${c.label} must fail`).toBe(false);
      if (res.ok) return;
      const errors = res.errors as readonly ModelErrorV3[];
      expect(codeSet(errors), `${c.label}: exact code set`).toEqual([...c.codes].sort());
      if (c.count !== undefined) expect(errors.length, `${c.label}: error count`).toBe(c.count);
      if (c.ordered) {
        c.ordered.forEach(([code, path, document], i) => {
          expect(errors[i]!.code).toBe(code);
          expect(errors[i]!.path).toBe(path);
          if (document !== undefined) expect(errors[i]!.document).toBe(document);
        });
      }
      // The parsers are pure readers: the input bytes are retained untouched.
      expect(bytesEqual(before, copy), `${c.label}: bytes retained`).toBe(true);
    });
  }

  it('the unsupported-version error names the known versions and the direction', () => {
    const future = parseSceneV3(utf8(scene([cam()], { schemaVersion: 5 })));
    const past = parseSceneV3(utf8(scene([cam()], { schemaVersion: 2 })));
    expect(future.ok || past.ok).toBe(false);
    if (!future.ok) {
      expect(future.errors[0]!.knownVersions).toEqual([3, 4]);
      expect(future.errors[0]!.hint).toContain('newer');
    }
    if (!past.ok) {
      expect(past.errors[0]!.found).toBe(2);
      expect(past.errors[0]!.hint).toContain('older');
    }
  });
});
