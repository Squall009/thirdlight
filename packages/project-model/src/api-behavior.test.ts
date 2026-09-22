/**
 * API behavior — unit-level coverage of contract rules not pinned by the
 * file fixtures: total-function purity (never throws), canonical output
 * layout, default filling, negative zero, quaternion preservation,
 * migration semantics, limits, error shapes, and the strict-field rules.
 */

import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  KNOWN_VERSIONS,
  migrateManifest,
  migrateScene,
  normalizeManifest,
  normalizeScene,
  parseManifest,
  parseScene,
  serializeCanonical,
  validateManifest,
  validateProject,
  validateScene,
  type ModelError,
  type ModelResult,
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
  return { schemaVersion: 1, sceneId: 'scene-main', revision: 0, entities };
}

const codes = (res: { ok: false; errors: readonly { code: string }[] }): string[] =>
  res.errors.map((e) => e.code);
const first = (res: { ok: false; errors: readonly ModelError[] }): ModelError => res.errors[0]!;
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
        // packet 47 media additions (presentation.md §41.7.2 A / §18.9.3):
        // the rigid-animation role/profile codes of the promoted contract.
        'animation_role_out_of_range',
        'animation_role_duplicate',
        'animation_role_mismatch',
        'animation_role_ambiguous',
        'animation_skin_unsupported',
        'animation_root_motion',
      ].sort(),
    );
  });

  // Packet 20 (M2) made KNOWN_VERSIONS the per-document structure; packet 44
  // (M3, contract §23.1) adds scene 3. The M1 standalone interchange entry
  // points stay pinned to schemaVersion 1 (§8).
  it('KNOWN_VERSIONS is the per-document structure for M3', () => {
    expect(KNOWN_VERSIONS).toEqual({ manifest: [1], scene: [1, 2, 3] });
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
    { schemaVersion: 1 },
    { schemaVersion: 1, sceneId: {}, revision: 'x', entities: 'nope' },
    {
      schemaVersion: 1,
      sceneId: 's',
      revision: 0,
      entities: [
        { id: Symbol('x'), components: { transform: () => 1 } },
        { components: [] },
        'not-an-object',
        7,
      ],
    },
  ];

  it('validate* rejects every weird value with an error result', () => {
    for (const v of weird) {
      expect(() => validateScene(v)).not.toThrow();
      expect(() => validateManifest(v)).not.toThrow();
      const rs = validateScene(v);
      expect(rs.ok).toBe(false);
      if (!rs.ok) expect(rs.errors.length).toBeGreaterThan(0);
      const rm = validateManifest(v);
      expect(rm.ok).toBe(false);
      if (!rm.ok) expect(rm.errors.length).toBeGreaterThan(0);
      expect(() => validateProject(v, v)).not.toThrow();
      expect(() => normalizeScene(v)).not.toThrow();
      expect(() => normalizeManifest(v)).not.toThrow();
      expect(() => serializeCanonical(v)).not.toThrow();
      expect(() => migrateScene(v, 1)).not.toThrow();
      expect(() => migrateManifest(v, 2)).not.toThrow();
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
      expect(() => parseScene(b)).not.toThrow();
      expect(() => parseManifest(b)).not.toThrow();
      const r = parseScene(b);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.length).toBe(1);
        expect(['encoding_invalid', 'json_parse_error', 'duplicate_key', 'field_type', 'schema_version_unsupported']).toContain(r.errors[0]!.code);
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
    // No trailing spaces on any line.
    for (const line of text.split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('is byte-stable (idempotent) and round-trips through parseManifest', () => {
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

  it('rejects an invalid document instead of emitting best-effort output', () => {
    const bad = validScene([{ id: 'e1', components: { transform: {} } }]); // no camera
    const res = serializeCanonical(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(codes(res)).toEqual(['camera_count_invalid']);
  });
});

// ---- normalization semantics ---------------------------------------------------------

describe('normalization (§12.2)', () => {
  it('never mutates the input (deep-frozen input survives)', () => {
    const frozen = deepFreeze(validScene([cameraEntity(), boxEntity('box-1')]));
    expect(() => normalizeScene(frozen)).not.toThrow();
    expect(() => normalizeManifest(deepFreeze(validManifest()))).not.toThrow();
  });

  it('returns a NEW object graph (no aliasing of the input)', () => {
    const input = validScene([cameraEntity()]);
    const res = normalizeScene(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.normalized).not.toBe(input);
    expect(res.normalized.entities).not.toBe(input.entities);
  });

  it('fills every defaulted optional field (lenient input, strict output)', () => {
    const input = {
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        { id: 'root', components: { transform: {} } },
        { id: 'cube', parentId: 'root', components: { transform: {}, box: {} } },
        { id: 'cam-main', components: { transform: {}, camera: {} } },
      ],
    };
    const res = normalizeScene(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [root, cube, cam] = res.normalized.entities as unknown as Record<string, unknown>[];
    const tr = (e: Record<string, unknown>) => (e['components'] as Record<string, unknown>)['transform'] as Record<string, unknown>;
    expect(tr(root!)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    const box = (cube!['components'] as Record<string, unknown>)['box'] as Record<string, unknown>;
    expect(box).toEqual({ size: [1, 1, 1], material: { color: '#b0b0b0' } });
    const camComp = (cam!['components'] as Record<string, unknown>)['camera'] as Record<string, unknown>;
    expect(camComp).toEqual({ type: 'perspective', fovY: 60, near: 0.1, far: 100 });
    // Key order: id, name?, parentId?, components (§12.2 rule 4).
    expect(Object.keys(cube!)).toEqual(['id', 'parentId', 'components']);
    expect(Object.keys(root!)).toEqual(['id', 'components']);
    const ser = serializeCanonical(res.normalized);
    expect(ser.ok).toBe(true);
    if (ser.ok) {
      expect(JSON.parse(decode(ser.bytes))).toEqual(res.normalized);
    }
  });

  it('converts negative zero to zero and never sign-flips or renormalizes quaternions', () => {
    const res = parseScene(
      utf8(
        // Near-unit quaternion (|norm - 1| well within 1e-4) that is NOT
        // exactly unit: it must be preserved verbatim, not divided.
        '{"schemaVersion":1,"sceneId":"scene-main","revision":0,"entities":[' +
          '{"id":"e1","components":{"transform":{"position":[-0,-0.5,0],"rotation":[0.1,-0.2,0.3,0.927362],"scale":[1,1,1]},"camera":{}}}]}' ,
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const e = res.normalized.entities[0]!;
    expect(e.components.transform.position).toEqual([0, -0.5, 0]);
    expect(Object.is(e.components.transform.position[0], -0)).toBe(false);
    // Near-unit quaternion preserved verbatim (no division by the norm).
    expect(e.components.transform.rotation).toEqual([0.1, -0.2, 0.3, 0.927362]);
  });

  it('accepts q and -q (both denote the same rotation)', () => {
    const q = [0.3779644730092272, 0.7559289460184544, 0.3779644730092272, 0.3779644730092272];
    for (const rotation of [q, q.map((x) => -x)]) {
      const res = validateScene(
        validScene([{ id: 'e1', components: { transform: { rotation }, camera: {} } }]),
      );
      expect(res.ok, `rotation ${JSON.stringify(rotation)} must be accepted`).toBe(true);
    }
  });

  it('lowercases material.color (canonical form is lowercase)', () => {
    const res = normalizeScene(
      validScene([cameraEntity(), { ...boxEntity('box-1'), components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [1, 1, 1], material: { color: '#ABCDEF' } } } }]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const box = (res.normalized.entities[1]!.components as { box?: { material: { color: string } } }).box;
    expect(box?.material.color).toBe('#abcdef');
  });

  it('is pure: same input → deep-equal result', () => {
    const a = normalizeScene(validScene([cameraEntity(), boxEntity('b1')]));
    const b = normalizeScene(validScene([cameraEntity(), boxEntity('b1')]));
    expect(a).toEqual(b);
  });
});

// ---- migration (§12.4) ---------------------------------------------------------------

describe('migration entry points (§12.4: M1 ships no migrations)', () => {
  it('identity when schemaVersion equals target (both 1)', () => {
    const scene = validScene();
    const r = migrateScene(scene, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toEqual(scene);
    const manifest = validManifest();
    const rm = migrateManifest(manifest, 1);
    expect(rm.ok).toBe(true);
    if (rm.ok) expect(rm.normalized).toEqual(manifest);
  });

  it('no_migration_path for any other pair (from/to versions carried)', () => {
    const cases: [Record<string, unknown>, number][] = [
      [{ ...validScene(), schemaVersion: 2 }, 1],
      [{ ...validScene(), schemaVersion: 1 }, 2],
      [{ ...validScene(), schemaVersion: 2 }, 2],
      [{ sceneId: 'scene-main' }, 1], // no schemaVersion
    ];
    for (const [doc, target] of cases) {
      const r = migrateScene(doc, target);
      expect(r.ok, `from=${doc['schemaVersion']} to=${target} must fail`).toBe(false);
      if (!r.ok) {
        expect(r.errors.length).toBe(1);
        expect(first(r).code).toBe('no_migration_path');
        expect(first(r).path).toBe('/schemaVersion');
        expect(first(r).hint).toBeDefined();
      }
    }
    const fromTwo = migrateScene({ ...validScene(), schemaVersion: 2 }, 1);
    if (!fromTwo.ok) {
      expect(first(fromTwo).found).toBe(2);
    }
    const toTwo = migrateScene({ ...validScene(), schemaVersion: 1 }, 2);
    if (!toTwo.ok) {
      expect(first(toTwo).expected).toContain('2');
    }
  });

  it('never mutates the input and retains it (no destructive rewrite)', () => {
    const doc = { ...validScene(), schemaVersion: 2 };
    const before = JSON.stringify(doc);
    const r = migrateScene(doc, 1);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

// ---- version handling ------------------------------------------------------------------

describe('schema version handling (§6, §12.3 pass 3)', () => {
  it('unknown version => exactly one schema_version_unsupported with found/knownVersions/hint', () => {
    for (const [sv, hintPart] of [
      [2, 'newer'],
      [1.5, 'newer'], // above the highest known version
      [0, 'older'],
      ['1', ''],
    ] as const) {
      const res = validateScene({ ...validScene(), schemaVersion: sv });
      expect(res.ok, `schemaVersion ${String(sv)} must be unsupported`).toBe(false);
      if (!res.ok) {
        expect(res.errors.length).toBe(1);
        const e = first(res);
        expect(e.code).toBe('schema_version_unsupported');
        expect(e.path).toBe('/schemaVersion');
        expect(e.knownVersions).toEqual([1]);
        expect(e.found).toBe(sv);
        expect(e.hint).toBeDefined();
        expect(e.hint).toContain('known versions: [1]');
        if (hintPart) expect(e.hint).toContain(hintPart);
      }
    }
  });

  it('missing schemaVersion => single schema_version_unsupported (validation stops)', () => {
    const { schemaVersion: _sv, ...noVersion } = validScene();
    void _sv;
    const res = validateScene(noVersion);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBe(1);
      expect(first(res).code).toBe('schema_version_unsupported');
      // No field-level errors follow against an unknown format.
      expect(codes(res)).not.toContain('field_missing');
    }
  });

  it('project-level: independent errors in the other document are still returned', () => {
    const res = validateProject({ ...validManifest(), schemaVersion: 2 }, { ...validScene(), revision: -1 });
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
    const res = parseScene(bytes);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(codes(res)).toEqual(['schema_version_unsupported']);
    expect(bytesEqual(bytes, copy)).toBe(true);
  });
});

// ---- field rules ---------------------------------------------------------------------------

describe('strict field rules', () => {
  it('unknown fields are field_unexpected at every level (nothing is stripped)', () => {
    const checks: [string, () => ModelResult<unknown>, string][] = [
      ['manifest', () => validateManifest({ ...validManifest(), extra: 1 }), '/extra'],
      ['scene', () => validateScene({ ...validScene(), extra: 1 }), '/extra'],
      [
        'entity',
        () => validateScene(validScene([cameraEntity(), { ...boxEntity('b1'), extra: true }])),
        '/entities/1/extra',
      ],
      [
        'transform',
        () =>
          validateScene(
            validScene([{ id: 'e1', components: { transform: { position: [1, 1, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1], extra: 2 }, camera: {} } }]),
          ),
        '/entities/0/components/transform/extra',
      ],
      [
        'material',
        () =>
          validateScene(
            validScene([cameraEntity(), { ...boxEntity('b1'), components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [1, 1, 1], material: { color: '#a0a0a0', metalness: 1 } } } }]),
          ),
        '/entities/1/components/box/material/metalness',
      ],
      [
        'camera',
        () =>
          validateScene(validScene([{ id: 'e1', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100, aspect: 1.6 } } }]),
          ),
        '/entities/0/components/camera/aspect',
      ],
    ];
    for (const [label, run, path] of checks) {
      const res = run();
      expect(res.ok, `${label} with unknown field must fail`).toBe(false);
      if (!res.ok) {
        const e = res.errors.find((er) => er.path === path);
        expect(e?.code, `${label}: field_unexpected at ${path}`).toBe('field_unexpected');
      }
    }
  });

  it('required fields missing => field_missing at the field path', () => {
    const { entities: _e, ...noEntities } = validScene();
    void _e;
    const rs = validateScene(noEntities);
    expect(!rs.ok && first(rs).code === 'field_missing' && first(rs).path === '/entities').toBe(true);
    const { components: _c, ...noComponents } = cameraEntity();
    void _c;
    const re = validateScene(validScene([noComponents]));
    expect(!re.ok && re.errors.some((e) => e.code === 'field_missing' && e.path === '/entities/0/components')).toBe(true);
    const m = validateManifest({ ...validManifest(), name: undefined } as Record<string, unknown>);
    expect(!m.ok && first(m).code === 'field_missing' && first(m).path === '/name').toBe(true);
  });

  it('booleans are not M1 values: wrong type where a JSON type is expected', () => {
    const res = validateScene(validScene([{ ...cameraEntity(), name: true }]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === 'field_type' && e.path === '/entities/0/name')).toBe(true);
    }
  });

  it('document root must be an object: field_type at ""', () => {
    for (const root of [[1], 42, 'x', true]) {
      const res = validateScene(root);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.length).toBe(1);
        expect(first(res).code).toBe('field_type');
        expect(first(res).path).toBe('');
      }
    }
  });

  it('ID syntax (§5.1): 64 chars ok, 65 fails; first char [a-z0-9]; digits allowed', () => {
    const ok64 = 'a'.repeat(64);
    expect(validateScene(validScene([cameraEntity(ok64)])).ok).toBe(true);
    const bad65 = 'a'.repeat(65);
    const r65 = validateScene(validScene([cameraEntity(bad65)]));
    expect(!r65.ok && first(r65).code === 'id_invalid').toBe(true);
    for (const bad of ['-abc', 'Abc', '_x', 'a.b', 'a b']) {
      const r = validateScene(validScene([cameraEntity(bad)]));
      expect(!r.ok && first(r).code === 'id_invalid', `id '${bad}' must be id_invalid`).toBe(true);
    }
    expect(validateScene(validScene([cameraEntity('1abc')])).ok).toBe(true);
    const rm = validateManifest({ ...validManifest(), id: 'UPPER' });
    expect(!rm.ok && first(rm).code === 'id_invalid' && first(rm).path === '/id').toBe(true);
  });

  it('name fields: 1–128 chars, no control characters', () => {
    expect(validateScene(validScene([{ ...cameraEntity(), name: 'a'.repeat(128) }])).ok).toBe(true);
    const tooLong = validateScene(validScene([{ ...cameraEntity(), name: 'a'.repeat(129) }]));
    expect(!tooLong.ok && first(tooLong).code === 'field_value').toBe(true);
    const empty = validateScene(validScene([{ ...cameraEntity(), name: '' }]));
    expect(!empty.ok && first(empty).code === 'field_value').toBe(true);
    const control = validateScene(validScene([{ ...cameraEntity(), name: 'a\u0007b' }]));
    expect(!control.ok && first(control).code === 'field_value').toBe(true);
    const del = validateManifest({ ...validManifest(), name: 'a\u007fb' });
    expect(!del.ok && first(del).code === 'field_value').toBe(true);
  });

  it('revision: integer in [0, 2^53-1] (§6)', () => {
    for (const bad of [-1, 1.5, 2 ** 53, -0.5]) {
      const r = validateScene({ ...validScene(), revision: bad });
      expect(!r.ok && first(r).code === 'revision_invalid', `revision ${bad}`).toBe(true);
    }
    expect(validateScene({ ...validScene(), revision: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
    const strRev = validateScene({ ...validScene(), revision: '0' });
    expect(!strRev.ok && first(strRev).code === 'field_type').toBe(true);
    const nullRev = validateScene({ ...validScene(), revision: null });
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
      '2026-13-01T00:00:00Z', // month 13
      '2026-02-30T00:00:00Z', // Feb 30
      '2026-02-29T00:00:00Z', // non-leap Feb 29
      '1900-02-29T00:00:00Z', // century non-leap
      '2026-09-16T24:00:00Z', // hour 24
      '2026-09-16T23:60:00Z', // minute 60
      '2026-09-16T23:59:60Z', // second 60
      '2026-09-16 23:40:00Z', // no T
      '2026-09-16T23:40:00+00:00', // no literal Z
      '2026-09-16T23:40:00.000Z', // fractional seconds
      '26-09-16T23:40:00Z', // short year
    ]) {
      const r = validateManifest({ ...validManifest(), createdAt: bad });
      expect(!r.ok && first(r).code === 'field_value', `createdAt '${bad}'`).toBe(true);
    }
  });

  it('manifest scenes: exactly one M1 scene reference with the exact M1 path', () => {
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

describe('hierarchy and component rules (§9, §10, §11)', () => {
  it('duplicate entity ids: first occurrence wins, error at the later occurrence', () => {
    const res = validateScene(validScene([boxEntity('e1'), boxEntity('e1'), cameraEntity()]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const dup = res.errors.find((e) => e.code === 'id_duplicate');
      expect(dup?.path).toBe('/entities/1/id');
      expect(codes(res)).toEqual(['id_duplicate']);
    }
  });

  it('missing parentId reference => exactly reference_missing', () => {
    const res = validateScene(
      validScene([{ ...boxEntity('orphan'), parentId: 'ghost' }, cameraEntity()]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(codes(res)).toEqual(['reference_missing']);
      expect(first(res).path).toBe('/entities/0/parentId');
    }
  });

  it('self-parent is a cycle (["a"]) plus the order violation', () => {
    const res = validateScene(
      validScene([{ ...boxEntity('a'), parentId: 'a' }, cameraEntity()]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const cycle = res.errors.find((e) => e.code === 'hierarchy_cycle');
      expect(cycle?.found).toEqual(['a']);
      expect(codes(res)).toEqual(['hierarchy_cycle', 'order_parent_before_child']);
    }
  });

  it('child-before-parent without a cycle => order_parent_before_child only', () => {
    const res = validateScene(
      validScene([
        { ...boxEntity('child'), parentId: 'parent' },
        { ...boxEntity('parent') },
        cameraEntity(),
      ]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(codes(res)).toEqual(['order_parent_before_child']);
      expect(first(res).path).toBe('/entities/0/parentId');
    }
  });

  it('a valid deep hierarchy (parent-before-child) passes', () => {
    const res = validateScene(
      validScene([
        { ...boxEntity('p1') },
        { ...boxEntity('p2'), parentId: 'p1' },
        { ...boxEntity('p3'), parentId: 'p2' },
        cameraEntity(),
      ]),
    );
    expect(res.ok).toBe(true);
  });

  it('exactly one camera: zero and two both fail with camera_count_invalid', () => {
    const zero = validateScene(validScene([boxEntity('b1')]));
    expect(!zero.ok && codes(zero).every((c) => c === 'camera_count_invalid')).toBe(true);
    const two = validateScene(
      validScene([cameraEntity('c1'), { ...cameraEntity('c2'), id: 'c2' }]),
    );
    expect(!two.ok && codes(two)).toEqual(['camera_count_invalid']);
  });

  it('transform required; box/camera conflict; unknown component', () => {
    const noTransform = validateScene(
      validScene([
        { id: 'e1', components: { box: { size: [1, 1, 1], material: { color: '#a0a0a0' } } } },
        cameraEntity(),
      ]),
    );
    expect(!noTransform.ok && codes(noTransform)).toEqual(['component_missing']);

    const conflict = validateScene(
      validScene([
        {
          id: 'e1',
          components: {
            transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            box: { size: [1, 1, 1], material: { color: '#a0a0a0' } },
            camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
          },
        },
        cameraEntity(),
      ]),
    );
    expect(!conflict.ok && conflict.errors.some((e) => e.code === 'component_conflict')).toBe(true);

    // The conflict does not suppress independent field errors (and the
    // second camera is counted, so camera_count_invalid joins too).
    const conflictWithBadField = validateScene(
      validScene([
        {
          id: 'e1',
          components: {
            transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            box: { size: [0, 1, 1], material: { color: '#a0a0a0' } },
            camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
          },
        },
        cameraEntity(),
      ]),
    );
    expect(!conflictWithBadField.ok && codes(conflictWithBadField).sort()).toEqual(
      ['camera_count_invalid', 'component_conflict', 'number_out_of_range'].sort(),
    );

    const unknown = validateScene(
      validScene([
        {
          id: 'lamp',
          components: {
            transform: { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            light: { intensity: 1 },
          },
        },
        cameraEntity(),
      ]),
    );
    expect(!unknown.ok && codes(unknown)).toEqual(['component_unknown']);
    if (!unknown.ok) {
      const e = first(unknown);
      expect(e.expected).toContain('transform, box, camera');
      // No field-level errors inside the unknown component.
      expect(e.path).toBe('/entities/0/components/light');
    }
  });

  it('quaternion error carries the contract example hint', () => {
    const res = validateScene(
      validScene([{ id: 'e1', components: { transform: { rotation: [1, 0, 0, 1] }, camera: {} } }]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const q = res.errors.find((e) => e.code === 'quaternion_invalid');
      expect(q?.hint).toBe(
        'normalize to unit length; e.g. 45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]',
      );
      expect(q?.expected).toBe('finite [x,y,z,w] with |norm - 1| <= 1e-4');
    }
  });

  it('M1 limits: 1024 entities ok, 1025 limits_exceeded (entities); depth 32 ok, 33 limits_exceeded (depth)', () => {
    const mk = (n: number) =>
      validScene(
        Array.from({ length: n }, (_, i) => boxEntity(`e${i}`)).concat(cameraEntity()),
      );
    const ok1024 = validateScene(mk(1023)); // 1023 boxes + 1 camera = 1024
    expect(ok1024.ok).toBe(true);
    const bad1025 = validateScene(mk(1024)); // 1024 boxes + 1 camera = 1025
    expect(bad1025.ok).toBe(false);
    if (!bad1025.ok) {
      const lim = bad1025.errors.find((e) => e.code === 'limits_exceeded');
      expect(lim?.limit).toBe('entities');
      expect(lim?.path).toBe('/entities');
    }

    const chain = (depth: number) => {
      const ents: Record<string, unknown>[] = [{ ...boxEntity('n1') }];
      for (let i = 2; i <= depth; i++) {
        ents.push({ ...boxEntity(`n${i}`), parentId: `n${i - 1}` });
      }
      return validateScene(validScene(ents.concat(cameraEntity())));
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
    const run = (transform: Record<string, unknown>) =>
      validateScene(validScene([{ id: 'e1', components: { transform, camera: {} } }]));

    const short = run({ position: [1, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(!short.ok && codes(short).includes('field_value')).toBe(true);

    const strElem = run({ position: [0, '1', 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(!strElem.ok && strElem.errors.some((e) => e.code === 'field_type' && e.path === '/entities/0/components/transform/position/1')).toBe(true);

    const big = run({ position: [1e7, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(!big.ok && big.errors.some((e) => e.code === 'number_out_of_range' && e.path.endsWith('/position/0'))).toBe(true);

    const negScale = run({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [-1, 1, 1] });
    expect(!negScale.ok && negScale.errors.some((e) => e.code === 'number_out_of_range' && e.path.endsWith('/scale/0'))).toBe(true);

    const zeroSize = run({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    void zeroSize;
    const badBox2 = validateScene(
      validScene([
        {
          id: 'e1',
          components: {
            transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            box: { size: [2, 0, 1] },
          },
        },
        cameraEntity(),
      ]),
    );
    expect(!badBox2.ok && badBox2.errors.some((e) => e.code === 'number_out_of_range' && e.path === '/entities/0/components/box/size/1')).toBe(true);

    const cameraRange = validateScene(
      validScene([{ id: 'e1', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'perspective', fovY: 0, near: 0, far: 0.05 } } }]),
    );
    // fovY 0, near 0, far 0.05 (far <= near) all out of range.
    expect(!cameraRange.ok && new Set(codes(cameraRange)).has('number_out_of_range')).toBe(true);

    const cameraType = validateScene(
      validScene([{ id: 'e1', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'orthographic' } } }]),
    );
    expect(!cameraType.ok && cameraType.errors.some((e) => e.code === 'field_value' && e.path.endsWith('/type'))).toBe(true);

    const badColor = validateScene(
      validScene([
        {
          id: 'e1',
          components: {
            transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            box: { size: [1, 1, 1], material: { color: 'red' } },
          },
        },
        cameraEntity(),
      ]),
    );
    expect(!badColor.ok && badColor.errors.some((e) => e.code === 'field_value' && e.path.endsWith('/material/color'))).toBe(true);
  });

  it('parentId type: string or null only', () => {
    const res = validateScene(validScene([{ ...boxEntity('b1'), parentId: 5 }, cameraEntity()]));
    expect(!res.ok && res.errors.some((e) => e.code === 'field_type' && e.path === '/entities/0/parentId')).toBe(true);
    const nullParent = validateScene(validScene([{ ...boxEntity('b1'), parentId: null }, cameraEntity()]));
    expect(nullParent.ok).toBe(true);
  });
});

// ---- project-level -------------------------------------------------------------------------

describe('project-level validation (§13)', () => {
  it('success: normalized { manifest, scene }', () => {
    const res = validateProject(validManifest(), validScene());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.keys(res.normalized).sort()).toEqual(['manifest', 'scene']);
    }
  });

  it('manifest_scene_mismatch: document "manifest" at /scenes/0/id, single error', () => {
    const otherScene = { schemaVersion: 1, sceneId: 'scene-other', revision: 0, entities: [cameraEntity()] };
    const res = validateProject(validManifest(), otherScene);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(codes(res)).toEqual(['manifest_scene_mismatch']);
      expect(first(res).path).toBe('/scenes/0/id');
      expect(first(res).document).toBe('manifest');
    }
  });

  it('single-document errors from validateProject carry the document discriminator', () => {
    const res = validateProject(validManifest(), { ...validScene(), revision: -1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.every((e) => e.document === 'scene')).toBe(true);
    }
  });

  it('single-document results (validateManifest/validateScene) do NOT carry document', () => {
    const res = validateScene({ ...validScene(), revision: -1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.every((e) => e.document === undefined)).toBe(true);
  });
});