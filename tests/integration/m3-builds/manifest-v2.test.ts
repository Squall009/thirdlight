/**
 * Packet 58 — manifest v2 binding re-derivation (delivery.md §2, §9).
 *
 * The committed delivery fixtures are the evidence. This suite:
 *   1. re-derives every v2 block digest + `buildId` INDEPENDENTLY with
 *      `node:crypto` (not the package's SHA-256) against the committed
 *      preimages and `digests/expected.json`;
 *   2. runs the package's PURE `captureManifestV2` over the fixture inputs and
 *      asserts the emitted document is byte-identical to the committed
 *      `manifest-v2-example.json` (the self-identifying `buildId` included);
 *   3. derives the captured v3 content view and media identity over the real
 *      `demo-0003-media-v3` envelope;
 *   4. exercises the strict v2 reader's captured-state re-derivation
 *      (media identity, asset kind) and the v1/v2 version-compat rule.
 *
 * Node: pinned Node 22 (this lives under `tests/`, where Node built-ins are
 * allowed); the derivation under test (`project-model`) is the zero-dependency
 * pure leaf.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  blockDigest,
  captureContentViewV3,
  captureManifestV2,
  manifestVersionCompat,
  resolveMediaIdentityV3,
  validateManifestV2,
  type ManifestAssetInputV2,
} from '@thirdlight/project-model';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFEST = join(REPO_ROOT, 'fixtures', 'm3', 'delivery', 'manifest');
const ENVELOPE = join(REPO_ROOT, 'fixtures', 'm3', 'contracts', 'envelope', 'valid');

const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const bytesOf = (p: string): Uint8Array => new Uint8Array(readFileSync(p));
/** Independent SHA-256 (node:crypto) of the `JSON.stringify(v, null, 2) + "\n"` bytes. */
const canonSha = (v: unknown): string => createHash('sha256').update(`${JSON.stringify(v, null, 2)}\n`, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// 1. Independent block-digest re-derivation (node:crypto, not the package)
// ---------------------------------------------------------------------------
describe('manifest-v2: independent digest re-derivation', () => {
  const expected = json<typeof import('../../../fixtures/m3/delivery/digests/expected.json')>(
    join(REPO_ROOT, 'fixtures', 'm3', 'delivery', 'digests', 'expected.json'),
  );
  const example = json<Record<string, unknown>>(join(MANIFEST, 'manifest-v2-example.json'));
  const contentPre = json<Record<string, unknown>>(join(MANIFEST, 'content-view-preimage.json'));
  const scenePre = json<Record<string, unknown>>(join(MANIFEST, 'scene-preimage.json'));

  it('reproduces every committed block digest', () => {
    expect(canonSha(scenePre)).toBe(expected.sceneDigest);
    expect(canonSha(contentPre)).toBe(expected.contentDigest);
    expect(canonSha(contentPre['game'])).toBe(expected.gameDigest);
    expect(canonSha(contentPre['settings'])).toBe(expected.settingsDigest);
    expect(canonSha(example['media'])).toBe(expected.mediaDigest);
  });

  it('reproduces the buildOptionsDigest and the self-identifying buildId', () => {
    const preimage = json<Record<string, unknown>>(join(MANIFEST, 'manifest-v2-preimage.json'));
    const options = {
      bundler: 'esbuild@0.28.2', bundle: true, platform: 'browser', format: 'iife',
      treeShaking: false, sourcemap: false, minify: false, target: 'es2022', loaders: ['ts', 'tsx'],
    };
    expect(canonSha(options)).toBe(expected.buildOptionsDigest);
    expect(preimage['toolchain'] && (preimage['toolchain'] as Record<string, unknown>)['optionsDigest']).toBe(expected.buildOptionsDigest);
    const { buildId, ...without } = example;
    expect(canonSha(without)).toBe(buildId);
    expect(buildId).toBe(expected.buildId);
  });

  it('a null game block hashes the four canonical bytes "null"', () => {
    expect(canonSha(null)).toBe(createHash('sha256').update('null\n', 'utf8').digest('hex'));
  });

  it('the animation profileDigest equals the canonical roles bytes', () => {
    const media = example['media'] as { animation: { profileDigest: string; roles: unknown }[] };
    for (const row of media.animation) {
      expect(row.profileDigest).toBe(canonSha(row.roles));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. captureManifestV2 → byte-identical to the committed example
// ---------------------------------------------------------------------------
describe('manifest-v2: captureManifestV2 fixture re-derivation', () => {
  const exampleBytes = bytesOf(join(MANIFEST, 'manifest-v2-example.json'));
  const preimage = json<Record<string, unknown>>(join(MANIFEST, 'manifest-v2-preimage.json'));
  const contentPre = json<Record<string, unknown> & { assets: { recipe: { id: string; version: number }; metricsDigest: string }[] }>(
    join(MANIFEST, 'content-view-preimage.json'),
  );
  const scenePre = json<unknown>(join(MANIFEST, 'scene-preimage.json'));
  const expected = json<Record<string, unknown>>(
    join(REPO_ROOT, 'fixtures', 'm3', 'delivery', 'digests', 'expected.json'),
  );

  it('emits a document byte-identical to the committed example (buildId included)', () => {
    const assets: ManifestAssetInputV2[] = contentPre.assets.map((a) => ({
      assetId: a.assetId,
      kind: a.kind as 'model' | 'audio',
      version: a.version,
      sourceDigest: a.sourceDigest,
      sourceByteLength: a.sourceByteLength,
      recipe: a.recipe,
      metricsDigest: a.metricsDigest,
    }));
    const res = captureManifestV2({
      projectId: preimage['projectId'] as string,
      revision: preimage['revision'] as number,
      capturedAt: preimage['capturedAt'] as string,
      scene: scenePre,
      contentDigest: expected['contentDigest'] as string,
      assets,
      behaviors: [],
      settings: preimage['settings'] as Record<string, number>,
      game: preimage['game'] as never,
      media: preimage['media'] as never,
      moduleIds: (preimage['modules'] as { id: string }[]).map((m) => m.id),
      enginePins: preimage['enginePins'] as { id: string; version: string; apiVersion: number }[],
      recipes: preimage['recipes'] as Record<string, number>,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The emitted bytes are byte-identical to the committed example file.
    expect(Buffer.from(res.bytes).equals(Buffer.from(exampleBytes))).toBe(true);
    expect(res.buildId).toBe(expected['buildId']);
    // sceneDigest is derived from the captured scene (not supplied).
    expect(res.manifest.sceneDigest).toBe(expected['sceneDigest']);
  });

  it('the preimage (without buildId) equals the example minus buildId', () => {
    const example = json<Record<string, unknown>>(join(MANIFEST, 'manifest-v2-example.json'));
    const { buildId: _b, ...exampleWithout } = example;
    expect(JSON.stringify(exampleWithout, null, 2)).toBe(JSON.stringify(preimage, null, 2));
  });
});

// ---------------------------------------------------------------------------
// 3. Captured v3 content view + media identity over the real envelope
// ---------------------------------------------------------------------------
describe('manifest-v2: captured v3 content view + media identity', () => {
  const env = json<Record<string, unknown> & { scene: unknown; content: unknown }>(
    join(ENVELOPE, 'demo-0003-media-v3.json'),
  );
  const scene = env.scene;
  const content = env.content;
  const ctx = { projectId: 'demo-0003', revision: (env.scene as { revision: number }).revision };

  it('captureContentViewV3 derives kind-tagged assets + the six-key contentDigest', () => {
    const res = captureContentViewV3(scene, content, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const view = res.normalized;
    // The reachable assets carry the record kind; both the model and audio are
    // reachable (the model via model/modelAnimation, the audio via game cues).
    const kinds = new Set(view.assets.map((a) => a.kind));
    expect(kinds.has('model')).toBe(true);
    expect(kinds.has('audio')).toBe(true);
    for (const a of view.assets) {
      expect(a.recipe.version).toBe(1);
      expect(a.metricsDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(a.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // contentDigest = the block digest of the six-key view (independent node:crypto).
    const withoutDigest = {
      assets: view.assets,
      prefabs: view.prefabs,
      behaviors: view.behaviors,
      settings: view.settings,
      behaviorTrust: view.behaviorTrust,
      game: view.game,
    };
    expect(canonSha(withoutDigest)).toBe(view.contentDigest);
    // settings are the resolved six keys in registry order.
    expect(Object.keys(view.settings)).toEqual([
      'gravity_y', 'run_speed', 'jump_velocity', 'max_fall_speed', 'max_slope_climb_deg', 'min_slope_slide_deg',
    ]);
  });

  it('resolveMediaIdentityV3 derives the cues + animation rows', () => {
    const res = resolveMediaIdentityV3(scene, content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const media = res.normalized;
    // The envelope's cues: start/checkpoint/death/goal → the audio asset; jump → null.
    expect(Object.keys(media.cues)).toEqual(['start', 'jump', 'checkpoint', 'death', 'goal']);
    expect(media.cues['jump']).toBeNull();
    for (const slot of ['start', 'checkpoint', 'death', 'goal'] as const) {
      expect(media.cues[slot]?.assetId).toBe('asset-audio-cue-start');
    }
    // The single modelAnimation entity produces one animation row.
    expect(media.animation).toHaveLength(1);
    const row = media.animation[0]!;
    expect(row.entityId).toBe('model-0001');
    expect(row.assetId).toBe('asset-model-courier');
    expect(row.profileDigest).toBe(blockDigest(row.roles));
    expect(row.profileDigest).toBe(canonSha(row.roles));
  });

  it('a cue referencing a missing asset fails asset_reference_missing', () => {
    const badContent = JSON.parse(JSON.stringify(content)) as unknown;
    const g = (badContent as { game: { cues: Record<string, string | null> } }).game;
    g.cues.start = 'asset-does-not-exist';
    const res = resolveMediaIdentityV3(scene, badContent);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.code === 'asset_reference_missing')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. The strict v2 reader over the captured state
// ---------------------------------------------------------------------------
describe('manifest-v2: validateManifestV2 captured-state re-derivation', () => {
  const env = json<Record<string, unknown> & { scene: unknown; content: unknown }>(
    join(ENVELOPE, 'demo-0003-media-v3.json'),
  );
  const scene = env.scene;
  const content = env.content;
  const ctx = { projectId: 'demo-0003', revision: (env.scene as { revision: number }).revision };

  function buildDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
    const viewRes = captureContentViewV3(scene, content, ctx);
    const mediaRes = resolveMediaIdentityV3(scene, content);
    if (!viewRes.ok || !mediaRes.ok) throw new Error('expected a valid capture');
    const assets: ManifestAssetInputV2[] = viewRes.normalized.assets.map((a) => ({
      assetId: a.assetId,
      kind: a.kind,
      version: a.version,
      sourceDigest: a.sourceDigest,
      sourceByteLength: a.sourceByteLength,
      recipe: a.recipe,
      metricsDigest: a.metricsDigest,
    }));
    const res = captureManifestV2({
      projectId: 'demo-0003',
      revision: ctx.revision,
      capturedAt: '2026-09-19T10:00:00Z',
      scene,
      contentDigest: viewRes.normalized.contentDigest,
      assets,
      behaviors: [],
      settings: viewRes.normalized.settings as unknown as Record<string, number>,
      game: viewRes.normalized.game,
      media: mediaRes.normalized,
      moduleIds: ['thirdlight.platformer-game:session', 'thirdlight.platformer:controller'],
      ...over,
    });
    if (!res.ok) throw new Error('expected a valid manifest');
    return JSON.parse(new TextDecoder().decode(res.bytes)) as Record<string, unknown>;
  }

  it('accepts a document consistent with its captured scene + content', () => {
    const doc = buildDoc();
    const res = validateManifestV2(doc, { scene, content });
    expect(res.ok).toBe(true);
  });

  it('rejects a media identity that disagrees with the captured content (media_identity)', () => {
    const doc = buildDoc();
    // A different captured content (cues changed) → the re-derived media differs.
    const altContent = JSON.parse(JSON.stringify(content)) as unknown;
    const g = (altContent as { game: { cues: Record<string, string | null> } }).game;
    g.cues.start = null;
    const res = validateManifestV2(doc, { scene, content: altContent });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('media_identity');
  });

  it('rejects an asset kind that disagrees with the captured record (asset_kind_mismatch)', () => {
    const doc = buildDoc();
    const assets = doc['assets'] as Record<string, unknown>[];
    // Flip the model asset's declared kind to audio, then re-derive the buildId
    // so the document is SELF-consistent (the buildId check passes) but the
    // declared kind disagrees with the captured record (a model).
    const modelRow = assets.find((a) => a['kind'] === 'model')!;
    modelRow['kind'] = 'audio';
    const { buildId: _b, ...without } = doc;
    doc['buildId'] = canonSha(without);
    const res = validateManifestV2(doc, { scene, content });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('asset_kind_mismatch');
  });

  it('rejects a sceneDigest that does not match the captured scene', () => {
    const doc = buildDoc();
    doc['sceneDigest'] = 'f'.repeat(64);
    const res = validateManifestV2(doc, { scene, content });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('digest_mismatch');
  });
});

// ---------------------------------------------------------------------------
// 5. Version-compat rule over real v1/v2 documents
// ---------------------------------------------------------------------------
describe('manifest-v2: version compatibility', () => {
  const example = json<Record<string, unknown>>(join(MANIFEST, 'manifest-v2-example.json'));

  it('a v1 reader rejects the v2 example document (manifest_version)', () => {
    const res = manifestVersionCompat(example, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('manifest_version');
  });

  it('a v2 reader rejects a v1 document (manifest_version)', () => {
    const res = manifestVersionCompat({ manifestVersion: 1 }, 2);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe('manifest_version');
  });

  it('the v2 reader rejects the v2 example only via validateManifestV2 success', () => {
    expect(validateManifestV2(example).ok).toBe(true);
  });
});