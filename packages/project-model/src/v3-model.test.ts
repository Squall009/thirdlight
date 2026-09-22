/**
 * Packet 44 — v3 model fixture execution and roundtrip tests.
 *
 * Executes every committed packet-39 contract fixture through the REAL v3
 * model implementation (not a re-implementation): `envelope/valid/*`,
 * `envelope/invalid/*`, `catalog/*` and `migration/**`, comparing against the
 * recorded expectations in `fixtures/m3/contracts/index.json` (code / path /
 * reason), plus the committed canonical bytes and SHA-256 digests.
 *
 * Also proves the pure v2→v3 migration identity policy, the non-destructive
 * refusal paths and the canonical `serializeCanonical` roundtrip
 * (parse→normalize→serialize is idempotent and digest-stable).
 */

import { describe, it, expect } from 'vitest';
import {
  GAME_ZONE_LIMITS,
  GAME_ZONE_ROLES,
  SURFACE_PRESETS,
  captureContent,
  migrateSceneV3,
  normalizeContentV3,
  normalizeEnvelopeV3,
  normalizeSceneV3,
  parseDocumentBytes,
  parseEnvelopeV3,
  parseSceneV3,
  serializeCanonical,
  sha256Hex,
  validateContentV3,
  validateEnvelopeV3,
  validateProjectV3,
  validateSceneV3,
  type EnvelopeV3Error,
} from '@thirdlight/project-model';
import {
  bytesEqual,
  decodeUtf8,
  m3ContractFixtureBytes,
  m3ContractFixtureKeys,
  m3ContractFixtureText,
} from './test-fixtures';

interface FixtureExpect {
  result: string;
  path?: string;
  reason?: string;
}
interface IndexEntry {
  sha256: string;
  bytes: number;
  kind: string;
  expect?: FixtureExpect;
}
const index = JSON.parse(m3ContractFixtureText('index.json')) as {
  fixtures: Record<string, IndexEntry>;
};

const FILES = m3ContractFixtureKeys();
const byFamily = (prefix: string): string[] => FILES.filter((f) => f.startsWith(prefix));

const envelopeValid = byFamily('envelope/valid/');
const envelopeInvalid = byFamily('envelope/invalid/');
const catalogFiles = byFamily('catalog/');
const migrationFiles = byFamily('migration/');

const canonicalBytesOf = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

const firstError = (r: { ok: false; errors: readonly EnvelopeV3Error[] }): EnvelopeV3Error => r.errors[0]!;

describe('packet 44 — committed contract fixtures are present and indexed', () => {
  it('covers every family and every indexed file exists', () => {
    expect(envelopeValid.length).toBeGreaterThanOrEqual(3);
    expect(envelopeInvalid.length).toBeGreaterThanOrEqual(19);
    expect(catalogFiles.length).toBeGreaterThanOrEqual(1);
    expect(migrationFiles.length).toBeGreaterThanOrEqual(6);
    for (const f of [...envelopeValid, ...envelopeInvalid, ...catalogFiles, ...migrationFiles]) {
      expect(index.fixtures[f], `index entry for ${f}`).toBeTruthy();
    }
    // Fixture totals executed below are reported in the handoff.
    expect(FILES.length).toBeGreaterThan(30);
  });
});

describe('packet 44 — valid v3 envelopes through the real implementation', () => {
  for (const rel of envelopeValid) {
    it(`${rel}: strict parse, validate, normalize and byte/digest roundtrip`, () => {
      const bytes = m3ContractFixtureBytes(rel);
      const entry = index.fixtures[rel]!;
      expect(bytes.length).toBe(entry.bytes);
      expect(sha256Hex(bytes)).toBe(entry.sha256);

      const parsed = parseDocumentBytes(bytes);
      expect(parsed.ok, decodeUtf8(bytes)).toBe(true);
      if (!parsed.ok) return;

      const viaBytes = parseEnvelopeV3(bytes);
      expect(viaBytes.ok).toBe(true);
      if (!viaBytes.ok) return;

      const validated = validateEnvelopeV3(parsed.value);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      expect(validated.normalized.storageVersion).toBe(3);
      expect(validated.normalized.scene.schemaVersion).toBe(3);

      const normalized = normalizeEnvelopeV3(parsed.value);
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) return;

      // Whole-envelope canonical bytes equal the committed bytes exactly.
      const canonical = canonicalBytesOf(normalized.normalized);
      expect(bytesEqual(canonical, bytes)).toBe(true);
      expect(sha256Hex(canonical)).toBe(entry.sha256);

      // Idempotence: re-parsing the canonical bytes and re-normalizing is stable.
      const again = normalizeEnvelopeV3(JSON.parse(decodeUtf8(canonical)));
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(bytesEqual(canonicalBytesOf(again.normalized), canonical)).toBe(true);

      // The model-owned parts also round-trip through serializeCanonical (§12.1).
      const sceneBytes = serializeCanonical(validated.normalized.scene);
      expect(sceneBytes.ok).toBe(true);
      if (sceneBytes.ok) {
        expect(bytesEqual(sceneBytes.bytes, canonicalBytesOf(validated.normalized.scene))).toBe(true);
      }
      const contentBytes = serializeCanonical(validated.normalized.content);
      expect(contentBytes.ok).toBe(true);
    });
  }
});

describe('packet 44 — invalid v3 envelopes return the recorded code/path/reason', () => {
  let executed = 0;
  for (const rel of envelopeInvalid) {
    it(`${rel}: ${index.fixtures[rel]!.expect?.result}/${index.fixtures[rel]!.expect?.path}`, () => {
      const bytes = m3ContractFixtureBytes(rel);
      const entry = index.fixtures[rel]!;
      expect(bytes.length).toBe(entry.bytes);
      expect(sha256Hex(bytes)).toBe(entry.sha256);
      const expected = entry.expect!;

      // Read from committed bytes: no hand-written expectation is used.
      const parsed = parseDocumentBytes(bytes);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const result = validateEnvelopeV3(parsed.value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = firstError(result);
      const got: FixtureExpect = {
        result: err.code,
        ...(err.path === undefined ? {} : { path: err.path }),
        ...(err.reason === undefined ? {} : { reason: err.reason }),
      };
      const want: FixtureExpect = {
        result: expected.result,
        ...(expected.path === undefined ? {} : { path: expected.path }),
        ...(expected.reason === undefined ? {} : { reason: expected.reason }),
      };
      expect(got).toEqual(want);
      executed += 1;
    });
  }
  it('executed every invalid envelope fixture', () => {
    expect(executed).toBe(envelopeInvalid.length);
  });
});

describe('packet 44 — catalog fixture through the real v3 content validator', () => {
  for (const rel of catalogFiles) {
    it(`${rel}: validate + canonical byte/digest roundtrip`, () => {
      const bytes = m3ContractFixtureBytes(rel);
      const entry = index.fixtures[rel]!;
      const doc = JSON.parse(decodeUtf8(bytes)) as Record<string, unknown>;
      const content = doc['content'];
      const validated = validateContentV3(content);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const normalized = normalizeContentV3(content);
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) return;
      const canonical = canonicalBytesOf({ content: normalized.normalized });
      expect(bytesEqual(canonical, bytes)).toBe(true);
      expect(sha256Hex(canonical)).toBe(entry.sha256);
      // serializeCanonical dispatches the six-key v3 content block.
      const viaSerialize = serializeCanonical(content);
      expect(viaSerialize.ok).toBe(true);
    });
  }
});

describe('packet 44 — migration fixtures: pure v2→v3 scene conversion', () => {
  const srcEnvelope = JSON.parse(m3ContractFixtureText('migration/v2-source/envelope.json')) as Record<string, unknown>;
  const dstEnvelope = JSON.parse(m3ContractFixtureText('migration/expected-v3-destination/envelope.json')) as Record<string, unknown>;
  const dstProject = JSON.parse(m3ContractFixtureText('migration/expected-v3-destination/project.json')) as unknown;

  it('migrateSceneV3 carries every entity verbatim and sets schemaVersion 3', () => {
    const srcScene = srcEnvelope['scene'] as Record<string, unknown>;
    const dstScene = dstEnvelope['scene'] as Record<string, unknown>;
    const before = JSON.stringify(srcScene);
    const migrated = migrateSceneV3(srcScene);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.normalized.schemaVersion).toBe(3);
    expect(migrated.normalized.sceneId).toBe(srcScene['sceneId']);
    // §23.11: entity values/order/IDs verbatim — the destination entity array
    // is byte-identical to the pure conversion result.
    expect(migrated.normalized.entities).toEqual(dstScene['entities']);
    expect(JSON.stringify(migrated.normalized.entities)).toBe(JSON.stringify(dstScene['entities']));
    // §23.11 is a scene-level operator: it does not reset the revision. The
    // destination revision 0 is the workspace copy operator's reset
    // (workspace.md §16.5, packet 46).
    expect(srcScene['revision']).toBe(6);
    expect(dstScene['revision']).toBe(0);
    expect(migrated.normalized.revision).toBe(6);
    // The caller's input is never mutated (non-destructive).
    expect(JSON.stringify(srcScene)).toBe(before);
    // The expected destination scene is accepted verbatim by the v3 validator.
    expect(validateSceneV3(dstScene).ok).toBe(true);
    expect(validateContentV3(dstEnvelope['content']).ok).toBe(true);
    // CC-44-4 resolved by the bounded contract repair
    // (docs/handoffs/repair-cc44-3-4.md): `workspace.md` §16.5.2 now resets the
    // derived revision metadata on copy (`publishedRevision`,
    // `source.publishedRevision`, `behaviorTrust[].acknowledgedRevision` → 0),
    // so the committed destination is loadable as a whole and satisfies the
    // accepted §18.9.2 rule 4 (`publishedRevision <= scene.revision`).
    const projectResult = validateProjectV3(dstProject, dstScene, dstEnvelope['content']);
    expect(projectResult.ok, JSON.stringify(projectResult)).toBe(true);
    const asset = (dstEnvelope['content'] as { assets: { versions: { publishedRevision: number }[] }[] }).assets[0];
    expect(asset?.versions[0]?.publishedRevision).toBe(0);
  });

  it('migrateSceneV3 is identity on a v3 scene and canonical/digest stable', () => {
    const dstScene = dstEnvelope['scene'] as unknown;
    const first = migrateSceneV3(dstScene);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = migrateSceneV3(first.normalized);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.normalized).toEqual(first.normalized);
    const a = serializeCanonical(first.normalized);
    const b = serializeCanonical(second.normalized);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
      expect(sha256Hex(a.bytes)).toBe(sha256Hex(b.bytes));
    }
  });

  it('refuses a v1 source non-destructively with no_migration_path', () => {
    const v1 = { schemaVersion: 1, sceneId: 'scene-main', revision: 0, entities: [] };
    const before = JSON.stringify(v1);
    const refused = migrateSceneV3(v1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors[0]!.code).toBe('no_migration_path');
      expect(refused.errors[0]!.path).toBe('/schemaVersion');
    }
    expect(JSON.stringify(v1)).toBe(before);
  });

  it('reads the interrupted-copy case (workspace-owned resume/suppression)', () => {
    const marker = JSON.parse(m3ContractFixtureText('migration/interrupted-copy/marker.json')) as Record<string, unknown>;
    const copyCase = JSON.parse(m3ContractFixtureText('migration/interrupted-copy/case.json')) as Record<string, unknown>;
    expect(marker['sourceVersion']).toBe(2);
    expect(marker['newVersion']).toBe(3);
    expect(marker['type']).toBe('migration-copy');
    const expectBlock = copyCase['expect'] as Record<string, unknown>;
    // `migration_resume_required`, marker phases and default-envelope
    // suppression are the workspace copy operator's (workspace.md §16.5/§16.6,
    // packet 46); the model layer contributes only migrateSceneV3.
    expect(expectBlock['startupScan']).toBe('migration_resume_required');
    expect(expectBlock['defaultEnvelopeSuppressed']).toBe(true);
    expect(migrationFiles.length).toBe(6);
  });
});

describe('packet 44 — captureContent accepts the v3 pair (§19.2/§16.6)', () => {
  it('captures model, modelAnimation (pinned version), cue and activation assets', () => {
    const env = JSON.parse(m3ContractFixtureText('envelope/valid/demo-0003-media-v3.json')) as Record<string, unknown>;
    const captured = captureContent(env['scene'], env['content'], { projectId: 'demo-0003', revision: 3 });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.normalized.contentVersion).toBe(1);
    expect(captured.normalized.assets.map((a) => a.assetId)).toEqual(['asset-audio-cue-start', 'asset-model-courier']);
    // modelAnimation pins its recorded version (=1 here); cues resolve current.
    expect(captured.normalized.assets.find((a) => a.assetId === 'asset-model-courier')!.version).toBe(1);
    expect(captured.normalized.assets.find((a) => a.assetId === 'asset-audio-cue-start')!.version).toBe(1);
    expect(captured.normalized.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: re-capturing the same revision is digest-identical.
    const again = captureContent(env['scene'], env['content'], { projectId: 'demo-0003', revision: 3 });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.normalized.contentDigest).toBe(captured.normalized.contentDigest);
  });

  it('a v3 scene with content.game === null and no model refs captures an empty closure', () => {
    const env = JSON.parse(m3ContractFixtureText('envelope/valid/demo-0003-fresh-v3.json')) as Record<string, unknown>;
    const captured = captureContent(env['scene'], env['content'], { projectId: 'demo-0003', revision: 0 });
    expect(captured.ok).toBe(true);
    if (captured.ok) expect(captured.normalized.assets).toEqual([]);
  });
});

describe('packet 44 — v3 scene rules and non-destructive refusals', () => {
  const fresh = JSON.parse(m3ContractFixtureText('envelope/valid/demo-0003-fresh-v3.json')) as Record<string, unknown>;

  it('unknown component kinds fail with component_unknown and do not repair', () => {
    const scene = JSON.parse(JSON.stringify(fresh['scene'])) as Record<string, unknown>;
    const entities = scene['entities'] as Record<string, unknown>[];
    (entities[0]!['components'] as Record<string, unknown>)['teleporter'] = {};
    const before = JSON.stringify(scene);
    const res = validateSceneV3(scene);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]!.code).toBe('component_unknown');
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('unknown fields fail with field_unexpected (nothing is silently dropped)', () => {
    const scene = JSON.parse(JSON.stringify(fresh['scene'])) as Record<string, unknown>;
    const entities = scene['entities'] as Record<string, unknown>[];
    (entities[0]!['components'] as Record<string, unknown>)['light'] = { type: 'ambient', color: '#000000', intensity: 1, glow: true };
    const res = validateSceneV3(scene);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === 'field_unexpected' && e.path === '/entities/0/components/light/glow')).toBe(true);
    }
  });

  it('unknown scene versions are refused with schema_version_unsupported', () => {
    const res = validateSceneV3({ schemaVersion: 4, sceneId: 'scene-main', revision: 0, entities: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]!.code).toBe('schema_version_unsupported');
  });

  it('parseSceneV3 rejects non-UTF-8 bytes (pass-1 strictness preserved)', () => {
    const bad = new Uint8Array([0xff, 0xfe, 0x00]);
    const res = parseSceneV3(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]!.code).toBe('encoding_invalid');
  });

  it('the v3 constants are the contracted frozen values', () => {
    expect(GAME_ZONE_ROLES).toEqual(['hazard', 'checkpoint', 'goal']);
    expect(GAME_ZONE_LIMITS.zones).toBe(64);
    expect(GAME_ZONE_LIMITS.checkpointZones).toBe(1);
    expect(GAME_ZONE_LIMITS.playerSpawns).toBe(16);
    expect(GAME_ZONE_LIMITS.lightsDirectional).toBe(1);
    expect(GAME_ZONE_LIMITS.lightsAmbient).toBe(1);
    expect(GAME_ZONE_LIMITS.audioAssets).toBe(16);
    expect(GAME_ZONE_LIMITS.audioVersions).toBe(8);
    expect(GAME_ZONE_LIMITS.gameBytes).toBe(16_384);
    expect(GAME_ZONE_LIMITS.animationProfileBytes).toBe(4_096);
    expect(SURFACE_PRESETS.beacon).toEqual({
      color: '#2f7fd4',
      roughness: 0.4,
      metalness: 0.1,
      emissive: '#1bc8ff',
      emissiveIntensity: 1.2,
    });
    expect(Object.isFrozen(SURFACE_PRESETS)).toBe(true);
  });

  it('the v3 envelope refuses every unsupported new combination with one error', () => {
    const base = JSON.parse(m3ContractFixtureText('envelope/valid/demo-0003-beacon-min-v3.json')) as Record<string, unknown>;
    const cases: [number, number][] = [
      [1, 3],
      [2, 3],
      [3, 1],
      [3, 2],
      [1, 1],
      [2, 2],
    ];
    for (const [storageVersion, sceneVersion] of cases) {
      const doc = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      doc['storageVersion'] = storageVersion;
      (doc['scene'] as Record<string, unknown>)['schemaVersion'] = sceneVersion;
      const res = validateEnvelopeV3(doc);
      expect(res.ok, `storage ${storageVersion} / scene ${sceneVersion}`).toBe(false);
      if (!res.ok) {
        expect(res.count).toBe(1);
        expect(res.errors[0]!.code).toBe('version_combination_unsupported');
        expect(res.errors[0]!.path).toBe('/storageVersion');
      }
    }
  });

  it('an unknown storageVersion is one storage_version_unsupported', () => {
    const doc = JSON.parse(m3ContractFixtureText('envelope/valid/demo-0003-fresh-v3.json')) as Record<string, unknown>;
    doc['storageVersion'] = 4;
    const res = validateEnvelopeV3(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.count).toBe(1);
      expect(res.errors[0]!.code).toBe('storage_version_unsupported');
      expect(res.errors[0]!.path).toBe('/storageVersion');
    }
  });

  it('a missing content.game key is one envelope_invalid/field_missing at /content/game', () => {
    const doc = JSON.parse(m3ContractFixtureText('envelope/valid/demo-0003-fresh-v3.json')) as Record<string, unknown>;
    delete (doc['content'] as Record<string, unknown>)['game'];
    const res = validateEnvelopeV3(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]!.code).toBe('envelope_invalid');
      expect(res.errors[0]!.path).toBe('/content/game');
      expect(res.errors[0]!.reason).toBe('field_missing');
    }
  });

  it('normalizeSceneV3 is idempotent and fills only the §23.7 defaults', () => {
    const scene = {
      schemaVersion: 3,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        {
          id: 'cam-main',
          components: {
            transform: {},
            camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 },
            cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } },
          },
        },
        {
          id: 'box-0001',
          components: { transform: {}, box: { size: [1, 1, 1], material: { color: '#ABCDEF' } }, surface: {} },
        },
        { id: 'light-0001', components: { transform: {}, light: { type: 'directional', color: '#FFFFFF', intensity: 1, direction: [0, -1, 0] } } },
      ],
    };
    const first = normalizeSceneV3(scene);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = normalizeSceneV3(first.normalized);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.normalized).toEqual(first.normalized);
    const box = first.normalized.entities[1]!;
    expect(box.components.surface).toEqual({ color: '#b0b0b0', roughness: 0.9, metalness: 0, emissive: '#000000', emissiveIntensity: 0 });
    expect(box.components.box!.material.color).toBe('#abcdef');
    const light = first.normalized.entities[2]!;
    expect(light.components.light!.castShadow).toBe(false);
    expect(light.components.light!.color).toBe('#ffffff');
    const a = serializeCanonical(first.normalized);
    const b = serializeCanonical(second.normalized);
    if (a.ok && b.ok) expect(sha256Hex(a.bytes)).toBe(sha256Hex(b.bytes));
  });
});
