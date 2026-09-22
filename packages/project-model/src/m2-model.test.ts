/**
 * Packet 20 — M2 model v2 and pure migration regression suite
 * (docs/contracts/project-model.md §§12–13.1, 18–22).
 *
 * The committed fixtures under fixtures/m2/model/ pin:
 *   - canonical round-trip byte identity for the v2 scene and the content
 *     block (normalize -> serializeCanonical -> parse is byte-stable and
 *     idempotent, and equals the committed bytes);
 *   - the exact error-code set of every invalid fixture, with the source
 *     bytes retained unchanged (non-destructive failure);
 *   - the pure M1 -> M2 scene conversion (IDs retained, input untouched).
 *
 * In-memory cases cover the runtime-only non-finite boundary, the captured
 * content view, settings resolution and the M1 entry-point pinning.
 */

import { describe, it, expect } from 'vitest';
import {
  captureContent,
  migrateScene,
  migrateSceneV1ToV2,
  normalizeContent,
  normalizeSceneV2,
  parseSceneV2,
  resolveGameplaySettings,
  serializeCanonical,
  validateContent,
  validateProjectV2,
  validateScene,
  validateSceneV2,
  M2_SETTINGS_KEYS,
  SCHEMA_VERSIONS_BY_DOCUMENT,
  type ContentCatalog,
    type ModelResult,
  type SceneV2,
} from '@thirdlight/project-model';
import { bytesEqual, decodeUtf8, m2ModelFixtureBytes, m2ModelFixtureText } from './test-fixtures';

interface Entry {
  path: string;
  kind: string;
  entryPoint: string;
  valid: boolean;
  notes?: string;
  expectedCodes?: string[];
  expectedReasons?: string[];
  expectedNormalized?: string;
}
const index = JSON.parse(m2ModelFixtureText('expected.json')) as { indexVersion: number; entries: Entry[] };

const bytes = m2ModelFixtureBytes;
const codesOf = (errors: readonly { code: string }[]): string[] => [...new Set(errors.map((e) => e.code))].sort();
const first = (res: { ok: false; errors: readonly { code: string; reason?: string }[] }): { code: string; reason?: string } =>
  res.errors[0]!;

type AnyResult =
  | { ok: true; normalized: unknown }
  | { ok: false; errors: readonly { code: string; reason?: string }[] };

function runEntry(entry: Entry): AnyResult {
  const doc = JSON.parse(m2ModelFixtureText(entry.path)) as Record<string, unknown>;
  switch (entry.entryPoint) {
    case 'validateSceneV2':
      return validateSceneV2(doc);
    case 'parseSceneV2':
      return parseSceneV2(bytes(entry.path));
    case 'validateContent':
      return validateContent(doc);
    case 'validateProjectV2':
      return validateProjectV2(doc['manifest'], doc['scene'], doc['content']);
    case 'migrateSceneV1ToV2':
      return migrateSceneV1ToV2(doc);
    default:
      throw new Error(`unknown entryPoint ${entry.entryPoint}`);
  }
}

describe('fixtures/m2/model expected.json index', () => {
  it('is versioned, unique, and pins codes for every invalid entry', () => {
    expect(index.indexVersion).toBe(1);
    const paths = index.entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const e of index.entries) {
      if (!e.valid) expect(e.expectedCodes?.length, `${e.path} must pin codes`).toBeGreaterThan(0);
    }
  });
});

describe('valid fixtures: byte-exact canonical round trip', () => {
  for (const entry of index.entries.filter((e) => e.valid && (e.kind === 'scene-v2' || e.kind === 'content'))) {
    it(`${entry.path} validates, serializes byte-exactly and is idempotent`, () => {
      const source = bytes(entry.path);
      const result = runEntry(entry);
      expect(result.ok, `${entry.path} must validate`).toBe(true);
      if (!result.ok) return;
      const ser = serializeCanonical(result.normalized);
      expect(ser.ok, `${entry.path} must serialize`).toBe(true);
      if (!ser.ok) return;
      expect(
        bytesEqual(ser.bytes, source),
        `${entry.path}: canonical bytes must equal the committed fixture bytes`,
      ).toBe(true);
      const ser2 = serializeCanonical(result.normalized);
      if (ser2.ok) expect(bytesEqual(ser2.bytes, ser.bytes)).toBe(true);
    });
  }

  it('valid/project-v2.json embeds the standalone scene and content fixtures', () => {
    const project = JSON.parse(m2ModelFixtureText('valid/project-v2.json')) as {
      manifest: unknown;
      scene: unknown;
      content: unknown;
    };
    expect(project.scene).toEqual(JSON.parse(m2ModelFixtureText('valid/scene-v2.json')));
    expect(project.content).toEqual(JSON.parse(m2ModelFixtureText('valid/content.json')));
    const composed = validateProjectV2(project.manifest, project.scene, project.content);
    expect(composed.ok).toBe(true);
  });
});

describe('invalid fixtures: exact codes and non-destructive failure', () => {
  for (const entry of index.entries.filter((e) => !e.valid)) {
    it(`${entry.path} fails with exactly ${JSON.stringify(entry.expectedCodes)}`, () => {
      const before = bytes(entry.path);
      const copy = before.slice();
      const result = runEntry(entry);
      expect(result.ok, `${entry.path} must fail`).toBe(false);
      if (result.ok) return;
      expect(codesOf(result.errors)).toEqual([...entry.expectedCodes!].sort());
      if (entry.expectedReasons) {
        const reasons = result.errors.map((e) => e.reason).filter((r): r is string => r !== undefined);
        for (const r of entry.expectedReasons) expect(reasons).toContain(r);
      }
      // Non-destructive: the pure validators never rewrite the source bytes.
      expect(bytesEqual(before, m2ModelFixtureBytes(entry.path)), `${entry.path} bytes retained`).toBe(true);
      expect(bytesEqual(copy, before)).toBe(true);
    });
  }
});

describe('pure M1 -> M2 scene migration', () => {
  it('retains sceneId, revision and entity IDs and never mutates the input', () => {
    const input = m2ModelFixtureText('migration/scene-v1-input.json');
    const doc = JSON.parse(input) as Record<string, unknown>;
    const before = JSON.stringify(doc);
    const res = migrateSceneV1ToV2(doc);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const expected = JSON.parse(m2ModelFixtureText('migration/scene-v2-expected.json')) as SceneV2;
    expect(res.normalized).toEqual(expected);
    expect(res.normalized.sceneId).toBe('scene-main');
    expect(res.normalized.revision).toBe(3);
    expect(res.normalized.entities.map((e) => e.id)).toEqual(['cam-main', 'box-0001', 'group-0001', 'box-0002']);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('fails non-destructively on an invalid v1 source', () => {
    const bad = { schemaVersion: 1, sceneId: 'scene-main', revision: 0, entities: [] };
    const before = JSON.stringify(bad);
    const res = migrateSceneV1ToV2(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(codesOf(res.errors)).toContain('camera_count_invalid');
    expect(JSON.stringify(bad)).toBe(before);
  });

  it('keeps the M1 migrateScene entry point behavior unchanged', () => {
    const v1 = JSON.parse(m2ModelFixtureText('migration/scene-v1-input.json')) as Record<string, unknown>;
    const r1 = migrateScene(v1, 1);
    expect(r1.ok).toBe(true);
    const r2 = migrateScene(v1, 2);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(first(r2).code).toBe('no_migration_path');
  });
});

describe('M1 entry points stay pinned to the standalone interchange version', () => {
  it('validateScene still rejects a standalone schemaVersion 2 scene', () => {
    const doc = JSON.parse(m2ModelFixtureText('valid/scene-v2.json')) as Record<string, unknown>;
    const res = validateScene(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(1);
      expect(first(res).code).toBe('schema_version_unsupported');
    }
  });

  it('SCHEMA_VERSIONS_BY_DOCUMENT is the per-document M3 structure', () => {
    expect(SCHEMA_VERSIONS_BY_DOCUMENT).toEqual({ manifest: [1], scene: [1, 2, 3] });
  });
});

describe('runtime-only non-finite values', () => {
  const validScene = JSON.parse(m2ModelFixtureText('valid/scene-v2.json')) as {
    entities: { id: string; components: { transform?: { position: number[] } } }[];
  };
  it('validateSceneV2 rejects NaN/Infinity with number_not_finite', () => {
    const doc = JSON.parse(JSON.stringify(validScene)) as typeof validScene;
    const group = doc.entities.find((e) => e.id === 'group-0001')!;
    group.components.transform!.position = [Number.NaN, 0, 0];
    const res = validateSceneV2(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const e = first(res);
      expect(e.code).toBe('number_not_finite');
    }
  });

  it('validateContent rejects a non-finite metric with number_not_finite/field_type', () => {
    const doc = JSON.parse(m2ModelFixtureText('valid/content.json')) as Record<string, unknown>;
    const content = doc as { assets: { versions: { metrics: Record<string, number> }[] }[] };
    content.assets[0]!.versions[0]!.metrics['vertices'] = Number.POSITIVE_INFINITY;
    const res = validateContent(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(codesOf(res.errors)).toContain('field_type');
  });
});

describe('captured content view (§19)', () => {
  it('captures only reachable assets at their current version, sorted, with a recomputable digest', () => {
    const scene = JSON.parse(m2ModelFixtureText('valid/scene-v2.json')) as unknown;
    const contentResult = validateContent(JSON.parse(m2ModelFixtureText('valid/content.json')));
    expect(contentResult.ok).toBe(true);
    if (!contentResult.ok) return;
    const content: ContentCatalog = contentResult.normalized;
    const res = captureContent(scene, content, { projectId: 'demo-m2', revision: 4 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.normalized.contentVersion).toBe(1);
    expect(res.normalized.projectId).toBe('demo-m2');
    expect(res.normalized.assets.map((a) => a.assetId)).toEqual(['asset-7f3a2c9e1b4d5068']);
    expect(res.normalized.assets[0]!.version).toBe(2);
    expect(res.normalized.assets[0]!.sourceDigest).toBe('bb'.repeat(32));
    expect(res.normalized.contentDigest).toBe('e85de67fe3a1ae162dc106de45fe599b07164b674ecfbfa52f0c8c4f12563fe6');
    // same input -> same digest (pure and reproducible)
    const again = captureContent(scene, content, { projectId: 'demo-m2', revision: 4 });
    expect(again.ok && again.normalized.contentDigest).toBe(res.normalized.contentDigest);
  });

  it('reports an unresolved reference before capture', () => {
    const scene = JSON.parse(m2ModelFixtureText('valid/scene-v2.json')) as {
      entities: { id: string; components: { model?: { asset: { assetId: string } } } }[];
    };
    scene.entities.find((e) => e.id === 'model-0001')!.components.model!.asset.assetId = 'asset-missing';
    const content = JSON.parse(m2ModelFixtureText('valid/content.json')) as unknown;
    const res = captureContent(scene, content, { projectId: 'demo-m2', revision: 4 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(codesOf(res.errors)).toContain('asset_reference_missing');
  });
});

describe('gameplay settings resolution (§21.5)', () => {
  it('fills the six defaults and applies content.settings overrides, deep-frozen', () => {
    const defaults = resolveGameplaySettings({ settings: {} });
    expect(defaults.ok).toBe(true);
    if (defaults.ok) {
      expect(defaults.normalized).toEqual({
        gravity_y: -19.62,
        run_speed: 4,
        jump_velocity: 7,
        max_fall_speed: -30,
        max_slope_climb_deg: 45,
        min_slope_slide_deg: 30,
      });
      expect(Object.isFrozen(defaults.normalized)).toBe(true);
    }
    const overridden = resolveGameplaySettings({ settings: { run_speed: 6, jump_velocity: 9 } });
    expect(overridden.ok).toBe(true);
    if (overridden.ok) {
      expect(overridden.normalized.run_speed).toBe(6);
      expect(overridden.normalized.jump_velocity).toBe(9);
      expect(overridden.normalized.gravity_y).toBe(-19.62);
    }
    expect(M2_SETTINGS_KEYS.map((s) => s.key)).toEqual([
      'gravity_y',
      'run_speed',
      'jump_velocity',
      'max_fall_speed',
      'max_slope_climb_deg',
      'min_slope_slide_deg',
    ]);
  });

  it('rejects an unknown key and the slope cross-check', () => {
    const unknown = resolveGameplaySettings({ settings: { teleport: 1 } });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(first(unknown).code).toBe('setting_unknown');
    const slope = resolveGameplaySettings({ settings: { max_slope_climb_deg: 20, min_slope_slide_deg: 30 } });
    expect(slope.ok).toBe(false);
    if (!slope.ok) expect(first(slope).code).toBe('field_value');
  });
});

describe('canonical serialization (§12.2)', () => {
  it('normalizes negative zero and preserves accepted near-unit quaternions', () => {
    const scene = JSON.parse(m2ModelFixtureText('valid/scene-v2.json')) as {
      entities: { id: string; components: { transform?: { position: number[]; rotation?: number[] } } }[];
    };
    const group = scene.entities.find((e) => e.id === 'group-0001')!;
    group.components.transform!.position = [-0, 0, 0];
    group.components.transform!.rotation = [0, 0, 0, 1.00005];
    const res = normalizeSceneV2(scene);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const t = res.normalized.entities.find((e) => e.id === 'group-0001')!.components.transform;
    expect(Object.is(t.position[0], -0)).toBe(false);
    expect(t.position[0]).toBe(0);
    expect(t.rotation).toEqual([0, 0, 0, 1.00005]);
    const ser = serializeCanonical(res.normalized);
    expect(ser.ok).toBe(true);
    if (ser.ok) expect(decodeUtf8(ser.bytes).includes('1.00005')).toBe(true);
  });

  it('dispatches the content block and rejects an invalid document instead of emitting bytes', () => {
    const content = JSON.parse(m2ModelFixtureText('valid/content.json')) as unknown;
    const normalized = normalizeContent(content);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      const ser = serializeCanonical(normalized.normalized);
      expect(ser.ok).toBe(true);
      if (ser.ok) expect(bytesEqual(ser.bytes, bytes('valid/content.json'))).toBe(true);
    }
    const bad = serializeCanonical({ assets: [], prefabs: [], behaviors: [], settings: {}, nope: 1 });
    expect(bad.ok).toBe(false);
  });
});

describe('behavior source records (§22.2/§12.3 step 5)', () => {
  it('validates a source record and rejects a bad digest / output bound', () => {
    const content = JSON.parse(m2ModelFixtureText('valid/content.json')) as Record<string, unknown>;
    const behaviors = content['behaviors'] as { source: unknown }[];
    behaviors[0]!.source = {
      sourceDigest: 'ab'.repeat(32),
      sourceByteLength: 677,
      entryPath: 'src/index.ts',
      fileCount: 1,
      manifestDigest: 'cd'.repeat(32),
      outputDigest: 'ef'.repeat(32),
      outputByteLength: 489,
      requiredModules: ['@thirdlight/runtime'],
      publishedRevision: 3,
    };
    const ok = validateContent(content);
    expect(ok.ok).toBe(true);

    const badDigest = JSON.parse(JSON.stringify(content)) as typeof content;
    ((badDigest['behaviors'] as { source: { sourceDigest: string } }[])[0]!).source.sourceDigest = 'not-hex';
    const bad = validateContent(badDigest);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(codesOf(bad.errors)).toContain('digest_invalid');

    const badEntry = JSON.parse(JSON.stringify(content)) as typeof content;
    ((badEntry['behaviors'] as { source: { entryPath: string } }[])[0]!).source.entryPath = 'src/other.ts';
    const bad2 = validateContent(badEntry);
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(codesOf(bad2.errors)).toContain('field_value');
  });
});
