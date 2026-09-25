/**
 * The packet-20 (M2) scene/content/project rules on the live v3 model
 * (phase 9.3 port of `m2-model.test.ts`, archived under
 * archive/removed-v1-v2/project-model/).
 *
 * The committed fixtures under fixtures/m2/model/ are schemaVersion 2
 * documents. The v2 scene model is gone, but every rule they pin lives on in
 * the v3 validators, so each document is upgraded IN MEMORY by exactly two
 * edits — scene `schemaVersion` 2 → 3 and content `game: null` — and then
 * run through `validateSceneV3`/`parseSceneV3`/`validateContentV3`/
 * `validateProjectV3`. That pins:
 *   - canonical round-trip byte identity for the scene and the content block
 *     (the committed bytes, upgraded the same way);
 *   - the exact error-code set of every invalid fixture, with the source
 *     bytes retained unchanged (non-destructive failure);
 *   - the captured content view, settings resolution, canonical number rules
 *     and the behavior source record rules.
 *
 * Not ported (removed behaviour): the v1 → v2 scene migration
 * (`migrateSceneV1ToV2`/`migrateScene`) and the M1 entry-point pinning.
 */

import { describe, it, expect } from 'vitest';
import {
  captureContent,
  normalizeContentV3,
  normalizeSceneV3,
  parseSceneV3,
  resolveGameplaySettings,
  serializeCanonical,
  validateContentV3,
  validateProjectV3,
  validateSceneV3,
  M2_SETTINGS_KEYS,
  type ContentCatalogV3,
} from '@thirdlight/project-model';
import { bytesEqual, decodeUtf8, m2ModelFixtureBytes, m2ModelFixtureText } from './test-fixtures';

interface Entry {
  path: string;
  kind: 'scene-v2' | 'content' | 'project-v2';
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
const first = (res: { ok: false; errors: readonly { code: string; reason?: string }[] }): { code: string; reason?: string } => res.errors[0]!;

/** The in-memory v2 → v3 upgrade: the scene's schemaVersion only. */
function sceneV3(doc: unknown): Record<string, unknown> {
  const s = doc as Record<string, unknown>;
  expect(s['schemaVersion']).toBe(2);
  return { ...s, schemaVersion: 3 };
}
/** The in-memory v2 → v3 upgrade: the content block gains `game: null`. */
function contentV3(doc: unknown): Record<string, unknown> {
  const c = doc as Record<string, unknown>;
  expect(Object.prototype.hasOwnProperty.call(c, 'game')).toBe(false);
  return { ...c, game: null };
}
/** The same upgrade on the committed text (the fixtures are canonical: `"schemaVersion": 2` once, at the top). */
function sceneV3Text(text: string): string {
  expect(text.split('"schemaVersion": 2').length).toBe(2);
  return text.replace('"schemaVersion": 2', '"schemaVersion": 3');
}
const canonicalText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

type AnyResult = { ok: true; normalized: unknown } | { ok: false; errors: readonly { code: string; reason?: string }[] };

function runEntry(entry: Entry): AnyResult {
  const doc = JSON.parse(m2ModelFixtureText(entry.path)) as Record<string, unknown>;
  switch (entry.entryPoint) {
    case 'validateSceneV3':
      return validateSceneV3(sceneV3(doc));
    case 'parseSceneV3':
      return parseSceneV3(new TextEncoder().encode(sceneV3Text(m2ModelFixtureText(entry.path))));
    case 'validateContentV3':
      return validateContentV3(contentV3(doc));
    case 'validateProjectV3':
      return validateProjectV3(doc['manifest'], sceneV3(doc['scene']), contentV3(doc['content']));
    default:
      throw new Error(`unknown entryPoint ${entry.entryPoint}`);
  }
}

describe('fixtures/m2/model expected.json index', () => {
  it('is versioned, unique, names only live v3 entry points and pins codes for every invalid entry', () => {
    expect(index.indexVersion).toBe(1);
    const paths = index.entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const e of index.entries) {
      expect(['validateSceneV3', 'parseSceneV3', 'validateContentV3', 'validateProjectV3']).toContain(e.entryPoint);
      if (!e.valid) expect(e.expectedCodes?.length, `${e.path} must pin codes`).toBeGreaterThan(0);
    }
  });
});

describe('valid fixtures: byte-exact canonical round trip (after the in-memory upgrade)', () => {
  it('valid/scene-v2.json validates as v3, serializes byte-exactly and is idempotent', () => {
    const upgradedText = sceneV3Text(m2ModelFixtureText('valid/scene-v2.json'));
    const result = parseSceneV3(new TextEncoder().encode(upgradedText));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ser = serializeCanonical(result.normalized);
    expect(ser.ok).toBe(true);
    if (!ser.ok) return;
    expect(decodeUtf8(ser.bytes)).toBe(upgradedText);
    const again = parseSceneV3(ser.bytes);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const ser2 = serializeCanonical(again.normalized);
    expect(ser2.ok && bytesEqual(ser2.bytes, ser.bytes)).toBe(true);
  });

  it('valid/content.json validates as v3 content, serializes byte-exactly and is idempotent', () => {
    const upgraded = contentV3(JSON.parse(m2ModelFixtureText('valid/content.json')));
    const result = validateContentV3(upgraded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ser = serializeCanonical(result.normalized);
    expect(ser.ok).toBe(true);
    if (!ser.ok) return;
    // The committed content bytes plus the trailing `"game": null`.
    expect(decodeUtf8(ser.bytes)).toBe(canonicalText(upgraded));
    const committed = m2ModelFixtureText('valid/content.json');
    expect(decodeUtf8(ser.bytes)).toBe(`${committed.replace(/\n}\n$/, ',\n  "game": null\n}\n')}`);
    const ser2 = serializeCanonical(result.normalized);
    expect(ser2.ok && bytesEqual(ser2.bytes, ser.bytes)).toBe(true);
  });

  it('valid/project-v2.json embeds the standalone scene and content fixtures and loads as a v3 project', () => {
    const project = JSON.parse(m2ModelFixtureText('valid/project-v2.json')) as { manifest: unknown; scene: unknown; content: unknown };
    expect(project.scene).toEqual(JSON.parse(m2ModelFixtureText('valid/scene-v2.json')));
    expect(project.content).toEqual(JSON.parse(m2ModelFixtureText('valid/content.json')));
    const composed = validateProjectV3(project.manifest, sceneV3(project.scene), contentV3(project.content));
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
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

  it('the un-upgraded v2 scene is refused by validateSceneV3 with one schema_version_unsupported', () => {
    const doc = JSON.parse(m2ModelFixtureText('valid/scene-v2.json')) as Record<string, unknown>;
    const res = validateSceneV3(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]!.code).toBe('schema_version_unsupported');
      expect(res.errors[0]!.knownVersions).toEqual([3, 4]);
      expect(res.errors[0]!.found).toBe(2);
    }
  });
});

describe('runtime-only non-finite values', () => {
  it('validateSceneV3 rejects NaN with number_not_finite', () => {
    const doc = sceneV3(JSON.parse(m2ModelFixtureText('valid/scene-v2.json'))) as {
      entities: { id: string; components: { transform?: { position: number[] } } }[];
    };
    doc.entities.find((e) => e.id === 'group-0001')!.components.transform!.position = [Number.NaN, 0, 0];
    const res = validateSceneV3(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.map((e) => [e.code, e.path])).toEqual([['number_not_finite', '/entities/1/components/transform/position/0']]);
    }
  });

  it('validateContentV3 rejects a non-finite metric with field_type', () => {
    const doc = contentV3(JSON.parse(m2ModelFixtureText('valid/content.json'))) as {
      assets: { versions: { metrics: Record<string, number> }[] }[];
    };
    doc.assets[0]!.versions[0]!.metrics['vertices'] = Number.POSITIVE_INFINITY;
    const res = validateContentV3(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.map((e) => [e.code, e.path])).toEqual([['field_type', '/assets/0/versions/0/metrics/vertices']]);
  });
});

describe('captured content view (§19, the v3 pair)', () => {
  it('captures only reachable assets at their current version, sorted, with a recomputable digest', () => {
    const scene = sceneV3(JSON.parse(m2ModelFixtureText('valid/scene-v2.json')));
    const contentResult = validateContentV3(contentV3(JSON.parse(m2ModelFixtureText('valid/content.json'))));
    expect(contentResult.ok).toBe(true);
    if (!contentResult.ok) return;
    const content: ContentCatalogV3 = contentResult.normalized;
    const res = captureContent(scene, content, { projectId: 'demo-m2', revision: 4 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.normalized.contentVersion).toBe(1);
    expect(res.normalized.projectId).toBe('demo-m2');
    expect(res.normalized.assets.map((a) => a.assetId)).toEqual(['asset-7f3a2c9e1b4d5068']);
    expect(res.normalized.assets[0]!.version).toBe(2);
    expect(res.normalized.assets[0]!.sourceDigest).toBe('bb'.repeat(32));
    // The same digest the v2 capture produced: the captured view is unchanged.
    expect(res.normalized.contentDigest).toBe('e85de67fe3a1ae162dc106de45fe599b07164b674ecfbfa52f0c8c4f12563fe6');
    const again = captureContent(scene, content, { projectId: 'demo-m2', revision: 4 });
    expect(again.ok && again.normalized.contentDigest).toBe(res.normalized.contentDigest);
  });

  it('reports an unresolved reference before capture', () => {
    const scene = sceneV3(JSON.parse(m2ModelFixtureText('valid/scene-v2.json'))) as {
      entities: { id: string; components: { model?: { asset: { assetId: string } } } }[];
    };
    scene.entities.find((e) => e.id === 'model-0001')!.components.model!.asset.assetId = 'asset-missing';
    const content = contentV3(JSON.parse(m2ModelFixtureText('valid/content.json')));
    const res = captureContent(scene, content, { projectId: 'demo-m2', revision: 4 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(codesOf(res.errors)).toEqual(['asset_reference_missing']);
      expect(res.errors[0]!.found).toBe('asset-missing');
    }
  });

  it('refuses a v2 scene (the v2 capture branch was removed)', () => {
    const scene = JSON.parse(m2ModelFixtureText('valid/scene-v2.json')) as unknown;
    const content = contentV3(JSON.parse(m2ModelFixtureText('valid/content.json')));
    const res = captureContent(scene, content, { projectId: 'demo-m2', revision: 4 });
    expect(res.ok).toBe(false);
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
      // Phase 15.3: optional engine settings (resolved only when set).
      'fixed_step_hz',
      'audio_voices',
      'music_fade_s',
      'animation_crossfade_s',
      // Phase 17.1: the renderer backend (0 legacy WebGL, 1 auto, 2 WebGPU, 3 WebGL 2).
      'render_backend',
      // Phase 22.0: where the simulation runs (1 a worker, 2 the main thread).
      'sim_thread',
    ]);
    // an unset engine setting stays out of the resolved block (its digest is unchanged); a set one follows the six
    const engine = resolveGameplaySettings({ settings: { audio_voices: 4, fixed_step_hz: 60 } });
    expect(engine.ok && Object.keys(engine.normalized)).toEqual(['gravity_y', 'run_speed', 'jump_velocity', 'max_fall_speed', 'max_slope_climb_deg', 'min_slope_slide_deg', 'fixed_step_hz', 'audio_voices']);
    const backend = resolveGameplaySettings({ settings: { render_backend: 3 } });
    expect(backend.ok && backend.normalized.render_backend).toBe(3);
    // Phase 17.4: 0 (the archived WebGL renderer) stays valid in an older project (read as auto).
    const legacy = resolveGameplaySettings({ settings: { render_backend: 0 } });
    expect(legacy.ok && legacy.normalized.render_backend).toBe(0);
    for (const bad of [{ fixed_step_hz: 90 }, { audio_voices: 2.5 }, { audio_voices: 33 }, { music_fade_s: -1 }, { render_backend: 4 }, { render_backend: 1.5 }, { sim_thread: 0 }, { sim_thread: 3 }]) {
      expect(resolveGameplaySettings({ settings: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
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
    const scene = sceneV3(JSON.parse(m2ModelFixtureText('valid/scene-v2.json'))) as {
      entities: { id: string; components: { transform?: { position: number[]; rotation?: number[] } } }[];
    };
    const group = scene.entities.find((e) => e.id === 'group-0001')!;
    group.components.transform!.position = [-0, 0, 0];
    group.components.transform!.rotation = [0, 0, 0, 1.00005];
    const res = normalizeSceneV3(scene);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const t = res.normalized.entities.find((e) => e.id === 'group-0001')!.components as { transform: { position: number[]; rotation: number[] } };
    expect(Object.is(t.transform.position[0], -0)).toBe(false);
    expect(t.transform.position[0]).toBe(0);
    expect(t.transform.rotation).toEqual([0, 0, 0, 1.00005]);
    const ser = serializeCanonical(res.normalized);
    expect(ser.ok).toBe(true);
    if (ser.ok) expect(decodeUtf8(ser.bytes).includes('1.00005')).toBe(true);
  });

  it('dispatches the content block and rejects an invalid document instead of emitting bytes', () => {
    const upgraded = contentV3(JSON.parse(m2ModelFixtureText('valid/content.json')));
    const normalized = normalizeContentV3(upgraded);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      const ser = serializeCanonical(normalized.normalized);
      expect(ser.ok).toBe(true);
      if (ser.ok) expect(decodeUtf8(ser.bytes)).toBe(canonicalText(upgraded));
    }
    const bad = serializeCanonical({ assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null, nope: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => [e.code, e.path])).toEqual([['field_unexpected', '/nope']]);
  });
});

describe('behavior source records (§22.2/§12.3 step 5)', () => {
  it('validates a source record and rejects a bad digest / entry path', () => {
    const content = contentV3(JSON.parse(m2ModelFixtureText('valid/content.json')));
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
    const ok = validateContentV3(content);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);

    const badDigest = JSON.parse(JSON.stringify(content)) as typeof content;
    (badDigest['behaviors'] as { source: { sourceDigest: string } }[])[0]!.source.sourceDigest = 'not-hex';
    const bad = validateContentV3(badDigest);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(codesOf(bad.errors)).toContain('digest_invalid');

    const badEntry = JSON.parse(JSON.stringify(content)) as typeof content;
    (badEntry['behaviors'] as { source: { entryPath: string } }[])[0]!.source.entryPath = 'src/other.ts';
    const bad2 = validateContentV3(badEntry);
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(codesOf(bad2.errors)).toContain('field_value');
  });
});
