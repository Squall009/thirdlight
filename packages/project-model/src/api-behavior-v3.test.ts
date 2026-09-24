/**
 * API behavior on the live (storage v3/v4) model — unit-level coverage of
 * contract rules not pinned by the file fixtures: total-function purity
 * (never throws), canonical output layout, default filling, negative zero,
 * quaternion preservation, schema version handling, limits, error shapes and
 * the strict-field rules.
 *
 * Phase 9.3 port of the M1 `api-behavior.test.ts` (archived under
 * archive/removed-v1-v2/project-model/): the scene cases now run through
 * `validateSceneV3`/`normalizeSceneV3`/`parseSceneV3` (and `validateSceneV4`
 * where v4 differs), the project cases through `validateProjectV3`. The M1
 * migration entry points (`migrateScene`/`migrateManifest`) were removed and
 * their cases are not ported.
 */

import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  KNOWN_VERSIONS,
  SCHEMA_VERSIONS_BY_DOCUMENT,
  V3_REGISTRY,
  normalizeManifest,
  normalizeSceneV3,
  parseManifest,
  parseSceneV3,
  serializeCanonical,
  validateContentV3,
  validateManifest,
  validateProjectV3,
  validateSceneV3,
  validateSceneV4,
  type ModelErrorV3,
} from '@thirdlight/project-model';
import { bytesEqual } from './test-fixtures';

// ---- builders -----------------------------------------------------------------

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    engineVersion: '0.1.0',
    id: 'demo-0001',
    name: 'Demo Project',
    createdAt: '2026-09-16T23:40:00Z',
    scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
  };
}

function emptyContent(): Record<string, unknown> {
  return { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null };
}

function cameraEntity(id = 'cam-main'): Record<string, unknown> {
  return {
    id,
    components: {
      transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
    },
  };
}

function boxEntity(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    components: {
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      box: { size: [1, 1, 1], material: { color: '#a0a0a0' } },
      ...extra,
    },
  };
}

function validScene(entities: Record<string, unknown>[] = [cameraEntity()]): Record<string, unknown> {
  return { schemaVersion: 3, sceneId: 'scene-main', revision: 0, entities };
}

const codes = (res: { ok: false; errors: readonly { code: string }[] }): string[] => res.errors.map((e) => e.code);
const first = (res: { ok: false; errors: readonly ModelErrorV3[] }): ModelErrorV3 => res.errors[0]!;
const decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v as Record<string, unknown>)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

// ---- constants ------------------------------------------------------------------

describe('stable constants (dependencies.md §3 single source of truth)', () => {
  it('ERROR_CODES is exactly the §12.6 stable code set (M3 v3 extended)', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'encoding_invalid',
        'json_parse_error',
        'duplicate_key',
        'schema_version_unsupported',
        'field_missing',
        'field_unexpected',
        'field_type',
        'field_value',
        'id_invalid',
        'id_duplicate',
        'reference_missing',
        'hierarchy_cycle',
        'order_parent_before_child',
        'number_not_finite',
        'number_out_of_range',
        'quaternion_invalid',
        'component_unknown',
        'component_missing',
        'component_conflict',
        'camera_count_invalid',
        'limits_exceeded',
        'revision_invalid',
        'manifest_scene_mismatch',
        'no_migration_path',
        'version_combination_unsupported',
        'asset_reference_missing',
        'digest_invalid',
        'asset_version_invalid',
        'recipe_invalid',
        'prefab_reference_missing',
        'prefab_component_forbidden',
        'behavior_reference_missing',
        'property_unknown',
        'property_type',
        'property_value',
        'setting_unknown',
        'collider_shape_invalid',
        'controller_count_invalid',
        'physics_transform_unsupported',
        'behavior_source_invalid',
        'behavior_source_duplicate',
        'behavior_source_missing',
        'behavior_source_escape',
        'behavior_source_cycle',
        'behavior_import_forbidden',
        'behavior_import_unpinned',
        'behavior_dynamic_code',
        'behavior_source_limits_exceeded',
        'behavior_compile_timeout',
        'behavior_compile_failed',
        'behavior_output_limits_exceeded',
        'behavior_output_forbidden_content',
        'behavior_declaration_mismatch',
        'behavior_trust_unacknowledged',
        // packet 44 v3 additions (§23.9)
        'game_reference_missing',
        'game_reference_in_use',
        'zone_transform_unsupported',
        'spawn_transform_unsupported',
        'zone_checkpoint_count_invalid',
        'zone_goal_missing',
        'asset_kind_mismatch',
        'game_config_invalid',
        // packet 47 media additions (presentation.md §41.7.2 A / §18.9.3)
        'animation_role_out_of_range',
        'animation_role_duplicate',
        'animation_role_mismatch',
        'animation_role_ambiguous',
        'animation_skin_unsupported',
        'animation_root_motion',
      ].sort(),
    );
  });

  // Phase 9.3: the v1/v2 scene models were removed; the manifest keeps its
  // v1 (the storage-v3 project manifest) and scenes are v3 or v4.
  it('KNOWN_VERSIONS / SCHEMA_VERSIONS_BY_DOCUMENT are the per-document v3/v4 structure', () => {
    expect(KNOWN_VERSIONS).toEqual({ manifest: [1], scene: [3, 4] });
    expect(SCHEMA_VERSIONS_BY_DOCUMENT).toEqual({ manifest: [1], scene: [3, 4] });
    expect(KNOWN_VERSIONS).toBe(SCHEMA_VERSIONS_BY_DOCUMENT);
  });
});

// ---- total functions: never throw -------------------------------------------------

describe('total functions (never throw on malformed data)', () => {
  const weird = [
    null,
    undefined,
    42,
    'str',
    true,
    false,
    [],
    [null, 1, 'x'],
    { schemaVersion: 3 },
    { schemaVersion: 4 },
    { schemaVersion: 3, sceneId: {}, revision: 'x', entities: 'nope' },
    {
      schemaVersion: 3,
      sceneId: 's',
      revision: 0,
      entities: [{ id: Symbol('x'), components: { transform: () => 1 } }, { components: [] }, 'not-an-object', 7],
    },
    {
      schemaVersion: 4,
      sceneId: 's',
      revision: 0,
      entities: [{ id: Symbol('x'), components: { transform: () => 1 } }, { components: [] }, 'not-an-object', 7],
    },
  ];

  it('validate* rejects every weird value with an error result', () => {
    for (const v of weird) {
      expect(() => validateSceneV3(v)).not.toThrow();
      expect(() => validateSceneV4(v)).not.toThrow();
      expect(() => validateManifest(v)).not.toThrow();
      expect(() => validateContentV3(v)).not.toThrow();
      const rs = validateSceneV3(v);
      expect(rs.ok).toBe(false);
      if (!rs.ok) expect(rs.errors.length).toBeGreaterThan(0);
      const r4 = validateSceneV4(v);
      expect(r4.ok).toBe(false);
      if (!r4.ok) expect(r4.errors.length).toBeGreaterThan(0);
      const rm = validateManifest(v);
      expect(rm.ok).toBe(false);
      if (!rm.ok) expect(rm.errors.length).toBeGreaterThan(0);
      const rc = validateContentV3(v);
      expect(rc.ok).toBe(false);
      expect(() => validateProjectV3(v, v, v)).not.toThrow();
      expect(validateProjectV3(v, v, v).ok).toBe(false);
      expect(() => normalizeSceneV3(v)).not.toThrow();
      expect(() => normalizeManifest(v)).not.toThrow();
      expect(() => serializeCanonical(v)).not.toThrow();
      expect(serializeCanonical(v).ok).toBe(false);
    }
  });

  it('parse* rejects arbitrary byte inputs with an error result', () => {
    const byteInputs: Uint8Array[] = [
      new Uint8Array(),
      new Uint8Array([0x00]),
      new Uint8Array([0xff]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([0x7b]),
      new Uint8Array([0xef, 0xbb, 0xbf]),
      utf8('NaN'),
      utf8('Infinity'),
      utf8('undefined'),
      utf8('{'),
      utf8('{} extra'),
      utf8('01'),
      utf8('1.'),
      utf8('1e'),
      utf8('"\\u12G4"'),
      utf8('"\\x41"'),
      utf8('"unterminated'),
      utf8('{"a":1,}'),
    ];
    for (const b of byteInputs) {
      expect(() => parseSceneV3(b)).not.toThrow();
      expect(() => parseManifest(b)).not.toThrow();
      const r = parseSceneV3(b);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.length).toBe(1);
        expect(['encoding_invalid', 'json_parse_error', 'duplicate_key', 'field_type', 'schema_version_unsupported']).toContain(
          r.errors[0]!.code,
        );
      }
    }
  });
});

// ---- canonical output layout -------------------------------------------------------

describe('canonical byte layout (§12.2 rule 6)', () => {
  it('manifest serialization: 2-space indent, LF, one trailing newline, no BOM', () => {
    const res = serializeCanonical(validManifest());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const text = decode(res.bytes);
    expect(res.bytes[0]).toBe(0x7b); // '{' — no BOM
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(false);
    expect(text.includes('\r')).toBe(false);
    expect(text.split('\n')[1]).toBe('  "schemaVersion": 1,');
    for (const line of text.split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('v3 scene serialization has the same layout', () => {
    const res = serializeCanonical(validScene([cameraEntity(), boxEntity('box-1')]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const text = decode(res.bytes);
    expect(res.bytes[0]).toBe(0x7b);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(false);
    expect(text.includes('\r')).toBe(false);
    expect(text.split('\n')[1]).toBe('  "schemaVersion": 3,');
    for (const line of text.split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('manifest: byte-stable (idempotent) and round-trips through parseManifest', () => {
    const r1 = serializeCanonical(validManifest());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const reparse = parseManifest(r1.bytes);
    expect(reparse.ok).toBe(true);
    if (!reparse.ok) return;
    const r2 = serializeCanonical(reparse.normalized);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(bytesEqual(r2.bytes, r1.bytes)).toBe(true);
      expect(JSON.parse(decode(r1.bytes))).toEqual(reparse.normalized);
    }
  });

  it('v3 and v4 scenes: byte-stable (idempotent) and round-trip through the strict parser', () => {
    const v3 = validScene([cameraEntity(), boxEntity('box-1'), { ...boxEntity('box-2'), parentId: 'box-1' }]);
    const r1 = serializeCanonical(v3);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const reparse = parseSceneV3(r1.bytes);
    expect(reparse.ok).toBe(true);
    if (!reparse.ok) return;
    const r2 = serializeCanonical(reparse.normalized);
    expect(r2.ok && bytesEqual(r2.bytes, r1.bytes)).toBe(true);
    expect(JSON.parse(decode(r1.bytes))).toEqual(reparse.normalized);

    const v4 = { ...v3, schemaVersion: 4 };
    const s1 = serializeCanonical(v4);
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    expect(decode(s1.bytes).split('\n')[1]).toBe('  "schemaVersion": 4,');
    const back = validateSceneV4(JSON.parse(decode(s1.bytes)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const s2 = serializeCanonical(back.normalized);
    expect(s2.ok && bytesEqual(s2.bytes, s1.bytes)).toBe(true);
  });

  it('rejects an invalid document instead of emitting best-effort output', () => {
    const bad = validScene([{ id: 'e1', components: { transform: {} } }]); // v3: no camera
    const res = serializeCanonical(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(codes(res)).toEqual(['camera_count_invalid']);
  });
});

// ---- normalization semantics ---------------------------------------------------------

describe('normalization (§12.2)', () => {
  it('never mutates the input (deep-frozen input survives)', () => {
    const frozen = deepFreeze(validScene([cameraEntity(), boxEntity('box-1')]));
    expect(() => normalizeSceneV3(frozen)).not.toThrow();
    expect(normalizeSceneV3(frozen).ok).toBe(true);
    expect(() => normalizeManifest(deepFreeze(validManifest()))).not.toThrow();
  });

  it('returns a NEW object graph (no aliasing of the input)', () => {
    const input = validScene([cameraEntity()]);
    const res = normalizeSceneV3(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.normalized).not.toBe(input);
    expect(res.normalized.entities).not.toBe(input['entities']);
  });

  it('fills every defaulted optional field (lenient input, strict output)', () => {
    const input = validScene([
      { id: 'root', components: { transform: {} } },
      { id: 'cube', parentId: 'root', components: { transform: {}, box: {} } },
      { id: 'cam-main', components: { transform: {}, camera: {} } },
    ]);
    const res = normalizeSceneV3(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [root, cube, cam] = res.normalized.entities as unknown as Record<string, unknown>[];
    const tr = (e: Record<string, unknown>) => (e['components'] as Record<string, unknown>)['transform'] as Record<string, unknown>;
    expect(tr(root!)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    const box = (cube!['components'] as Record<string, unknown>)['box'] as Record<string, unknown>;
    expect(box).toEqual({ size: [1, 1, 1], material: { color: '#b0b0b0' } });
    const camComp = (cam!['components'] as Record<string, unknown>)['camera'] as Record<string, unknown>;
    expect(camComp).toEqual({ type: 'perspective', fovY: 60, near: 0.1, far: 100 });
    // Key order: id, name?, parentId?, flags?, components (§12.2 rule 4).
    expect(Object.keys(cube!)).toEqual(['id', 'parentId', 'components']);
    expect(Object.keys(root!)).toEqual(['id', 'components']);
    const ser = serializeCanonical(res.normalized);
    expect(ser.ok).toBe(true);
    if (ser.ok) expect(JSON.parse(decode(ser.bytes))).toEqual(res.normalized);
  });

  it('converts negative zero to zero and never sign-flips or renormalizes quaternions', () => {
    const res = parseSceneV3(
      utf8(
        // Near-unit quaternion (|norm - 1| well within 1e-4) that is NOT
        // exactly unit: it must be preserved verbatim, not divided.
        '{"schemaVersion":3,"sceneId":"scene-main","revision":0,"entities":[' +
          '{"id":"e1","components":{"transform":{"position":[-0,-0.5,0],"rotation":[0.1,-0.2,0.3,0.927362],"scale":[1,1,1]},"camera":{}}}]}',
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const e = res.normalized.entities[0]! as unknown as { components: { transform: { position: number[]; rotation: number[] } } };
    expect(e.components.transform.position).toEqual([0, -0.5, 0]);
    expect(Object.is(e.components.transform.position[0], -0)).toBe(false);
    expect(e.components.transform.rotation).toEqual([0.1, -0.2, 0.3, 0.927362]);
  });

  it('accepts q and -q (both denote the same rotation)', () => {
    const q = [0.3779644730092272, 0.7559289460184544, 0.3779644730092272, 0.3779644730092272];
    for (const rotation of [q, q.map((x) => -x)]) {
      const res = validateSceneV3(validScene([{ id: 'e1', components: { transform: { rotation }, camera: {} } }]));
      expect(res.ok, `rotation ${JSON.stringify(rotation)} must be accepted`).toBe(true);
    }
  });

  it('lowercases material.color (canonical form is lowercase)', () => {
    const res = normalizeSceneV3(
      validScene([
        cameraEntity(),
        {
          id: 'box-1',
          components: {
            transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            box: { size: [1, 1, 1], material: { color: '#ABCDEF' } },
          },
        },
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const box = (res.normalized.entities[1]!.components as { box?: { material: { color: string } } }).box;
    expect(box?.material.color).toBe('#abcdef');
  });

  it('is pure: same input → deep-equal result', () => {
    const a = normalizeSceneV3(validScene([cameraEntity(), boxEntity('b1')]));
    const b = normalizeSceneV3(validScene([cameraEntity(), boxEntity('b1')]));
    expect(a).toEqual(b);
  });
});

// ---- version handling ------------------------------------------------------------------

describe('schema version handling (§6, §12.3 pass 3)', () => {
  it('unknown version => exactly one schema_version_unsupported with found/knownVersions/hint', () => {
    for (const [sv, hintPart] of [
      [1, 'older'], // the removed M1 scene
      [2, 'older'], // the removed M2 scene
      [0, 'older'],
      [5, 'newer'],
      [4.5, 'newer'], // above the highest known version
      ['3', ''],
    ] as const) {
      const res = validateSceneV3({ ...validScene(), schemaVersion: sv });
      expect(res.ok, `schemaVersion ${String(sv)} must be unsupported`).toBe(false);
      if (!res.ok) {
        expect(res.errors.length).toBe(1);
        const e = first(res);
        expect(e.code).toBe('schema_version_unsupported');
        expect(e.path).toBe('/schemaVersion');
        expect(e.knownVersions).toEqual([3, 4]);
        expect(e.found).toBe(sv);
        expect(e.hint).toBeDefined();
        expect(e.hint).toContain('known versions: [3, 4]');
        if (hintPart) expect(e.hint).toContain(hintPart);
      }
    }
  });

  it('a known version of the other validator is one field_value (v4 to V3, v3 to V4)', () => {
    const v4InV3 = validateSceneV3({ ...validScene(), schemaVersion: 4 });
    expect(!v4InV3.ok && codes(v4InV3)).toEqual(['field_value']);
    if (!v4InV3.ok) expect(first(v4InV3).path).toBe('/schemaVersion');
    const v3InV4 = validateSceneV4(validScene());
    expect(!v3InV4.ok && codes(v3InV4)).toEqual(['field_value']);
    if (!v3InV4.ok) expect(first(v3InV4).path).toBe('/schemaVersion');
  });

  it('missing schemaVersion => single schema_version_unsupported (validation stops)', () => {
    const { schemaVersion: _sv, ...noVersion } = validScene();
    void _sv;
    const res = validateSceneV3(noVersion);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBe(1);
      expect(first(res).code).toBe('schema_version_unsupported');
      expect(codes(res)).not.toContain('field_missing');
    }
  });

  it('manifest: only schemaVersion 1 is known', () => {
    for (const sv of [0, 2, '1']) {
      const r = validateManifest({ ...validManifest(), schemaVersion: sv });
      expect(!r.ok && codes(r)).toEqual(['schema_version_unsupported']);
      if (!r.ok) expect(first(r).knownVersions).toEqual([1]);
    }
  });

  it('project-level: independent errors in the other document are still returned', () => {
    const res = validateProjectV3({ ...validManifest(), schemaVersion: 2 }, { ...validScene(), revision: -1 }, emptyContent());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(codes(res).sort()).toEqual(['revision_invalid', 'schema_version_unsupported'].sort());
      const byDoc = new Map(res.errors.map((e) => [e.document, e.code]));
      expect(byDoc.get('manifest')).toBe('schema_version_unsupported');
      expect(byDoc.get('scene')).toBe('revision_invalid');
    }
  });

  it('unsupported-version handling without destructive rewrite (bytes untouched)', () => {
    const bytes = utf8('{"schemaVersion":2,"sceneId":"scene-main"}');
    const copy = bytes.slice();
    const res = parseSceneV3(bytes);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(codes(res)).toEqual(['schema_version_unsupported']);
    expect(bytesEqual(bytes, copy)).toBe(true);
  });
});

// ---- field rules ---------------------------------------------------------------------------

describe('strict field rules', () => {
  it('unknown fields are field_unexpected at every level (nothing is stripped)', () => {
    const checks: [string, () => { ok: boolean; errors?: readonly { code: string; path: string }[] }, string][] = [
      ['manifest', () => validateManifest({ ...validManifest(), extra: 1 }), '/extra'],
      ['scene', () => validateSceneV3({ ...validScene(), extra: 1 }), '/extra'],
      ['v4 scene', () => validateSceneV4({ ...validScene(), schemaVersion: 4, extra: 1 }), '/extra'],
      ['entity', () => validateSceneV3(validScene([cameraEntity(), { ...boxEntity('b1'), extra: true }])), '/entities/1/extra'],
      [
        'transform',
        () =>
          validateSceneV3(
            validScene([{ id: 'e1', components: { transform: { position: [1, 1, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1], extra: 2 }, camera: {} } }]),
          ),
        '/entities/0/components/transform/extra',
      ],
      [
        'material',
        () =>
          validateSceneV3(
            validScene([
              cameraEntity(),
              {
                id: 'b1',
                components: {
                  transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
                  box: { size: [1, 1, 1], material: { color: '#a0a0a0', metalness: 1 } },
                },
              },
            ]),
          ),
        '/entities/1/components/box/material/metalness',
      ],
      [
        'camera',
        () =>
          validateSceneV3(
            validScene([
              {
                id: 'e1',
                components: {
                  transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
                  camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100, aspect: 1.6 },
                },
              },
            ]),
          ),
        '/entities/0/components/camera/aspect',
      ],
    ];
    for (const [label, run, path] of checks) {
      const res = run();
      expect(res.ok, `${label} with unknown field must fail`).toBe(false);
      if (!res.ok) {
        const e = res.errors!.find((er) => er.path === path);
        expect(e?.code, `${label}: field_unexpected at ${path}`).toBe('field_unexpected');
      }
    }
  });

  it('required fields missing => field_missing at the field path', () => {
    const { entities: _e, ...noEntities } = validScene();
    void _e;
    const rs = validateSceneV3(noEntities);
    expect(!rs.ok && first(rs).code === 'field_missing' && first(rs).path === '/entities').toBe(true);
    const { components: _c, ...noComponents } = cameraEntity();
    void _c;
    const re = validateSceneV3(validScene([noComponents]));
    expect(!re.ok && re.errors.some((e) => e.code === 'field_missing' && e.path === '/entities/0/components')).toBe(true);
    const m = validateManifest({ ...validManifest(), name: undefined } as Record<string, unknown>);
    expect(!m.ok && first(m).code === 'field_missing' && first(m).path === '/name').toBe(true);
  });

  it('wrong JSON type where a string is expected => field_type', () => {
    const res = validateSceneV3(validScene([{ ...cameraEntity(), name: true }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'field_type' && e.path === '/entities/0/name')).toBe(true);
  });

  it('entity flags are booleans: a non-boolean flag => field_type', () => {
    const res = validateSceneV3(validScene([{ ...cameraEntity(), active: 1 }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'field_type' && e.path === '/entities/0/active')).toBe(true);
  });

  it('document root must be an object: field_type at ""', () => {
    for (const root of [[1], 42, 'x', true]) {
      for (const validate of [validateSceneV3, validateSceneV4]) {
        const res = validate(root);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.errors.length).toBe(1);
          expect(first(res).code).toBe('field_type');
          expect(first(res).path).toBe('');
        }
      }
    }
  });

  it('ID syntax (§5.1): 64 chars ok, 65 fails; first char [a-z0-9]; digits allowed', () => {
    expect(validateSceneV3(validScene([cameraEntity('a'.repeat(64))])).ok).toBe(true);
    const r65 = validateSceneV3(validScene([cameraEntity('a'.repeat(65))]));
    expect(!r65.ok && first(r65).code === 'id_invalid').toBe(true);
    for (const bad of ['-abc', 'Abc', '_x', 'a.b', 'a b']) {
      const r = validateSceneV3(validScene([cameraEntity(bad)]));
      expect(!r.ok && first(r).code === 'id_invalid', `id '${bad}' must be id_invalid`).toBe(true);
    }
    expect(validateSceneV3(validScene([cameraEntity('1abc')])).ok).toBe(true);
    const badScene = validateSceneV3({ ...validScene(), sceneId: 'Scene' });
    expect(!badScene.ok && first(badScene).code === 'id_invalid' && first(badScene).path === '/sceneId').toBe(true);
    const rm = validateManifest({ ...validManifest(), id: 'UPPER' });
    expect(!rm.ok && first(rm).code === 'id_invalid' && first(rm).path === '/id').toBe(true);
  });

  it('name fields: 1–128 chars, no control characters', () => {
    expect(validateSceneV3(validScene([{ ...cameraEntity(), name: 'a'.repeat(128) }])).ok).toBe(true);
    const tooLong = validateSceneV3(validScene([{ ...cameraEntity(), name: 'a'.repeat(129) }]));
    expect(!tooLong.ok && first(tooLong).code === 'field_value').toBe(true);
    const empty = validateSceneV3(validScene([{ ...cameraEntity(), name: '' }]));
    expect(!empty.ok && first(empty).code === 'field_value').toBe(true);
    const control = validateSceneV3(validScene([{ ...cameraEntity(), name: 'a\u0007b' }]));
    expect(!control.ok && first(control).code === 'field_value').toBe(true);
    const del = validateManifest({ ...validManifest(), name: 'a\u007fb' });
    expect(!del.ok && first(del).code === 'field_value').toBe(true);
  });

  it('revision: integer in [0, 2^53-1] (§6)', () => {
    for (const bad of [-1, 1.5, 2 ** 53, -0.5]) {
      const r = validateSceneV3({ ...validScene(), revision: bad });
      expect(!r.ok && first(r).code === 'revision_invalid', `revision ${bad}`).toBe(true);
    }
    expect(validateSceneV3({ ...validScene(), revision: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
    const strRev = validateSceneV3({ ...validScene(), revision: '0' });
    expect(!strRev.ok && first(strRev).code === 'field_type').toBe(true);
    const nullRev = validateSceneV3({ ...validScene(), revision: null });
    expect(!nullRev.ok && first(nullRev).code === 'field_type').toBe(true);
  });

  it('engineVersion: well-formed semver accepted; never blocks validation', () => {
    for (const good of ['0.1.0', '1.2.3', '1.2.3-alpha.1', '1.2.3-0.3.7', '10.20.30']) {
      expect(validateManifest({ ...validManifest(), engineVersion: good }).ok, good).toBe(true);
    }
    for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '', '0.1']) {
      const r = validateManifest({ ...validManifest(), engineVersion: bad });
      expect(!r.ok && first(r).code === 'field_value', `engineVersion '${bad}'`).toBe(true);
    }
  });

  it('createdAt: UTC second-precision timestamp with an existing calendar date', () => {
    for (const good of ['2026-09-16T23:40:00Z', '2024-02-29T00:00:00Z', '2100-02-28T23:59:59Z']) {
      expect(validateManifest({ ...validManifest(), createdAt: good }).ok, good).toBe(true);
    }
    for (const bad of [
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '1900-02-29T00:00:00Z',
      '2026-09-16T24:00:00Z',
      '2026-09-16T23:60:00Z',
      '2026-09-16T23:59:60Z',
      '2026-09-16 23:40:00Z',
      '2026-09-16T23:40:00+00:00',
      '2026-09-16T23:40:00.000Z',
      '26-09-16T23:40:00Z',
    ]) {
      const r = validateManifest({ ...validManifest(), createdAt: bad });
      expect(!r.ok && first(r).code === 'field_value', `createdAt '${bad}'`).toBe(true);
    }
  });

  it('manifest scenes: exactly one scene reference with the exact path scenes/main.json', () => {
    for (const bad of [
      { ...validManifest(), scenes: [] },
      { ...validManifest(), scenes: [{ id: 'scene-main', path: 'scenes/main.json' }, { id: 'scene-2', path: 'scenes/second.json' }] },
      { ...validManifest(), scenes: [{ id: 'scene-main', path: 'scenes/other.json' }] },
      { ...validManifest(), scenes: [{ id: 'scene-main', path: '/scenes/main.json' }] },
      { ...validManifest(), scenes: [{ id: 'scene-main', path: 'scenes/../scenes/main.json' }] },
    ]) {
      const r = validateManifest(bad);
      expect(!r.ok && codes(r).includes('field_value'), JSON.stringify(bad.scenes)).toBe(true);
    }
    const missingPath = validateManifest({ ...validManifest(), scenes: [{ id: 'scene-main' }] });
    expect(!missingPath.ok && missingPath.errors.some((e) => e.code === 'field_missing' && e.path === '/scenes/0/path')).toBe(true);
  });
});

// ---- hierarchy and components ----------------------------------------------------------------

describe('hierarchy and component rules (§9, §10, §11, §23.3)', () => {
  it('duplicate entity ids: first occurrence wins, error at the later occurrence', () => {
    const res = validateSceneV3(validScene([boxEntity('e1'), boxEntity('e1'), cameraEntity()]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.find((e) => e.code === 'id_duplicate')?.path).toBe('/entities/1/id');
      expect(codes(res)).toEqual(['id_duplicate']);
    }
  });

  it('missing parentId reference => exactly reference_missing', () => {
    const res = validateSceneV3(validScene([{ ...boxEntity('orphan'), parentId: 'ghost' }, cameraEntity()]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(codes(res)).toEqual(['reference_missing']);
      expect(first(res).path).toBe('/entities/0/parentId');
      expect(first(res).found).toBe('ghost');
    }
  });

  it('self-parent is a cycle (["a"]) plus the order violation', () => {
    const res = validateSceneV3(validScene([{ ...boxEntity('a'), parentId: 'a' }, cameraEntity()]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.find((e) => e.code === 'hierarchy_cycle')?.found).toEqual(['a']);
      expect(codes(res)).toEqual(['hierarchy_cycle', 'order_parent_before_child']);
    }
  });

  it('a two-node cycle a->b->a => hierarchy_cycle and order_parent_before_child', () => {
    const res = validateSceneV3(
      validScene([{ ...boxEntity('node-a'), parentId: 'node-b' }, { ...boxEntity('node-b'), parentId: 'node-a' }, cameraEntity()]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect([...new Set(codes(res))].sort()).toEqual(['hierarchy_cycle', 'order_parent_before_child']);
  });

  it('child-before-parent without a cycle => order_parent_before_child only', () => {
    const res = validateSceneV3(validScene([{ ...boxEntity('child'), parentId: 'parent' }, { ...boxEntity('parent') }, cameraEntity()]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(codes(res)).toEqual(['order_parent_before_child']);
      expect(first(res).path).toBe('/entities/0/parentId');
    }
  });

  it('a valid deep hierarchy (parent-before-child) passes', () => {
    const res = validateSceneV3(
      validScene([{ ...boxEntity('p1') }, { ...boxEntity('p2'), parentId: 'p1' }, { ...boxEntity('p3'), parentId: 'p2' }, cameraEntity()]),
    );
    expect(res.ok).toBe(true);
  });

  it('v3: exactly one camera — zero and two both fail with camera_count_invalid', () => {
    const zero = validateSceneV3(validScene([boxEntity('b1')]));
    expect(!zero.ok && codes(zero)).toEqual(['camera_count_invalid']);
    const two = validateSceneV3(validScene([cameraEntity('c1'), cameraEntity('c2')]));
    expect(!two.ok && codes(two)).toEqual(['camera_count_invalid']);
    if (!two.ok) expect(first(two).found).toBe(2);
  });

  it('v4: at most one camera — zero passes, two fail with camera_count_invalid', () => {
    const zero = validateSceneV4({ ...validScene([boxEntity('b1')]), schemaVersion: 4 });
    expect(zero.ok).toBe(true);
    const two = validateSceneV4({ ...validScene([cameraEntity('c1'), cameraEntity('c2')]), schemaVersion: 4 });
    expect(!two.ok && codes(two)).toEqual(['camera_count_invalid']);
  });

  it('transform required; box/camera conflict; unknown component', () => {
    const noTransform = validateSceneV3(
      validScene([{ id: 'e1', components: { box: { size: [1, 1, 1], material: { color: '#a0a0a0' } } } }, cameraEntity()]),
    );
    expect(!noTransform.ok && codes(noTransform)).toEqual(['component_missing']);
    if (!noTransform.ok) expect(first(noTransform).path).toBe('/entities/0/components/transform');

    const conflictEntity = (size: number[]) => ({
      id: 'e1',
      components: {
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        box: { size, material: { color: '#a0a0a0' } },
        camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
      },
    });
    const conflict = validateSceneV3(validScene([conflictEntity([1, 1, 1]), cameraEntity()]));
    expect(!conflict.ok && conflict.errors.some((e) => e.code === 'component_conflict')).toBe(true);

    // The conflict does not suppress independent field errors (and the
    // second camera is counted, so camera_count_invalid joins too).
    const conflictWithBadField = validateSceneV3(validScene([conflictEntity([0, 1, 1]), cameraEntity()]));
    expect(!conflictWithBadField.ok && codes(conflictWithBadField).sort()).toEqual(
      ['camera_count_invalid', 'component_conflict', 'number_out_of_range'].sort(),
    );

    const unknown = validateSceneV3(
      validScene([
        { id: 'lamp', components: { transform: { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, teleporter: { range: 1 } } },
        cameraEntity(),
      ]),
    );
    expect(!unknown.ok && codes(unknown)).toEqual(['component_unknown']);
    if (!unknown.ok) {
      const e = first(unknown);
      expect(e.expected).toBe(`known component types: ${V3_REGISTRY.join(', ')}`);
      expect(e.found).toBe('teleporter');
      // No field-level errors inside the unknown component.
      expect(e.path).toBe('/entities/0/components/teleporter');
    }
    // A v4-only component is unknown to v3 (instances).
    const v4Only = validateSceneV3(validScene([cameraEntity(), boxEntity('b1', { instances: {} })]));
    expect(!v4Only.ok && codes(v4Only)).toContain('component_unknown');
  });

  it('quaternion error carries the contract example hint', () => {
    const res = validateSceneV3(validScene([{ id: 'e1', components: { transform: { rotation: [1, 0, 0, 1] }, camera: {} } }]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const q = res.errors.find((e) => e.code === 'quaternion_invalid');
      expect(q?.hint).toBe('normalize to unit length; e.g. 45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]');
      expect(q?.expected).toBe('finite [x,y,z,w] with |norm - 1| <= 1e-4');
    }
  });

  it('limits: v3 1024 entities ok, 1025 limits_exceeded (entities); depth 32 ok, 33 limits_exceeded (depth)', () => {
    const mk = (n: number) => validScene(Array.from({ length: n }, (_, i) => boxEntity(`e${i}`)).concat(cameraEntity()));
    expect(validateSceneV3(mk(1023)).ok).toBe(true); // 1023 boxes + 1 camera = 1024
    const bad1025 = validateSceneV3(mk(1024));
    expect(bad1025.ok).toBe(false);
    if (!bad1025.ok) {
      const lim = bad1025.errors.find((e) => e.code === 'limits_exceeded');
      expect(lim?.limit).toBe('entities');
      expect(lim?.path).toBe('/entities');
    }
    // v4 lifts the per-scene entity cap to 16,384.
    expect(validateSceneV4({ ...mk(1024), schemaVersion: 4 }).ok).toBe(true);

    const chain = (depth: number) => {
      const ents: Record<string, unknown>[] = [{ ...boxEntity('n1') }];
      for (let i = 2; i <= depth; i++) ents.push({ ...boxEntity(`n${i}`), parentId: `n${i - 1}` });
      return validateSceneV3(validScene(ents.concat(cameraEntity())));
    };
    expect(chain(32).ok).toBe(true);
    const deep = chain(33);
    expect(deep.ok).toBe(false);
    if (!deep.ok) {
      const lim = deep.errors.find((e) => e.code === 'limits_exceeded');
      expect(lim?.limit).toBe('depth');
      expect(lim?.path).toBe('/entities/32');
      expect(lim?.found).toBe(33);
    }
  });

  it('numeric vector rules: length, element type, finiteness, per-field ranges', () => {
    const run = (transform: Record<string, unknown>) => validateSceneV3(validScene([{ id: 'e1', components: { transform, camera: {} } }]));

    const short = run({ position: [1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(!short.ok && codes(short).includes('field_value')).toBe(true);

    const strElem = run({ position: [0, '1', 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(!strElem.ok && strElem.errors.some((e) => e.code === 'field_type' && e.path === '/entities/0/components/transform/position/1')).toBe(true);

    const big = run({ position: [1e7, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(!big.ok && big.errors.some((e) => e.code === 'number_out_of_range' && e.path.endsWith('/position/0'))).toBe(true);

    const negScale = run({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [-1, 1, 1] });
    expect(!negScale.ok && negScale.errors.some((e) => e.code === 'number_out_of_range' && e.path.endsWith('/scale/0'))).toBe(true);

    const zeroQ = run({ position: [0, 0, 0], rotation: [0, 0, 0, 0], scale: [1, 1, 1] });
    expect(!zeroQ.ok && codes(zeroQ)).toContain('quaternion_invalid');

    const badBox = validateSceneV3(
      validScene([
        { id: 'e1', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [2, 0, 1] } } },
        cameraEntity(),
      ]),
    );
    expect(!badBox.ok && badBox.errors.some((e) => e.code === 'number_out_of_range' && e.path === '/entities/0/components/box/size/1')).toBe(true);

    const cameraRange = validateSceneV3(
      validScene([
        {
          id: 'e1',
          components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'perspective', fovY: 0, near: 0, far: 0.05 } },
        },
      ]),
    );
    // fovY 0, near 0, far 0.05 (far <= near default) all out of range.
    expect(!cameraRange.ok && new Set(codes(cameraRange))).toEqual(new Set(['number_out_of_range']));

    const cameraType = validateSceneV3(
      validScene([
        { id: 'e1', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'orthographic' } } },
      ]),
    );
    expect(!cameraType.ok && cameraType.errors.some((e) => e.code === 'field_value' && e.path.endsWith('/type'))).toBe(true);

    const badColor = validateSceneV3(
      validScene([
        {
          id: 'e1',
          components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [1, 1, 1], material: { color: 'red' } } },
        },
        cameraEntity(),
      ]),
    );
    expect(!badColor.ok && badColor.errors.some((e) => e.code === 'field_value' && e.path.endsWith('/material/color'))).toBe(true);
  });

  it('parentId type: string or null only', () => {
    const res = validateSceneV3(validScene([{ ...boxEntity('b1'), parentId: 5 }, cameraEntity()]));
    expect(!res.ok && res.errors.some((e) => e.code === 'field_type' && e.path === '/entities/0/parentId')).toBe(true);
    const nullParent = validateSceneV3(validScene([{ ...boxEntity('b1'), parentId: null }, cameraEntity()]));
    expect(nullParent.ok).toBe(true);
  });
});

// ---- project-level -------------------------------------------------------------------------

describe('project-level validation (§13.2 validateProjectV3)', () => {
  it('success: normalized { manifest, scene, content }', () => {
    const res = validateProjectV3(validManifest(), validScene(), emptyContent());
    expect(res.ok).toBe(true);
    if (res.ok) expect(Object.keys(res.normalized).sort()).toEqual(['content', 'manifest', 'scene']);
  });

  it('manifest_scene_mismatch: document "manifest" at /scenes/0/id, single error', () => {
    const otherScene = { ...validScene(), sceneId: 'scene-other' };
    const res = validateProjectV3(validManifest(), otherScene, emptyContent());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(codes(res)).toEqual(['manifest_scene_mismatch']);
      expect(first(res).path).toBe('/scenes/0/id');
      expect(first(res).document).toBe('manifest');
      expect(first(res).found).toBe('scene-main');
    }
  });

  it('single-document errors from validateProjectV3 carry the document discriminator', () => {
    const res = validateProjectV3(validManifest(), { ...validScene(), revision: -1 }, emptyContent());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.every((e) => e.document === 'scene')).toBe(true);
    const content = validateProjectV3(validManifest(), validScene(), { ...emptyContent(), extra: 1 });
    expect(content.ok).toBe(false);
    if (!content.ok) expect(content.errors.every((e) => e.document === 'content')).toBe(true);
  });

  it('single-document results (validateManifest/validateSceneV3) do NOT carry document', () => {
    const res = validateSceneV3({ ...validScene(), revision: -1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.every((e) => e.document === undefined)).toBe(true);
    const m = validateManifest({ ...validManifest(), id: 'BAD' });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.errors.every((e) => e.document === undefined)).toBe(true);
  });
});
