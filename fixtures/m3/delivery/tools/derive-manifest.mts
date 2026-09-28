/**
 * Re-derives the recorded manifest-v2 delivery fixtures from the product
 * (`@thirdlight/project-model`'s `captureManifestV2` / `blockDigest`), so a
 * product change to the manifest (engine pins, module ids, the removed game
 * layer) is re-recorded by code, never by hand.
 *
 * Inputs it keeps: the committed scene / content-view preimages (after taking
 * out the platformer game layer removed in phase 24: the `cameraFollow`
 * component, the `gameZone` entities, `content.game` → null) and the recorded
 * asset rows, settings and animation rows. Everything else — the media cue
 * slots, the module rows (the known M3 modules the scene needs), the engine
 * pins, the recipes, every block digest and the buildId — comes from the
 * product. It then rewrites the files that carry the buildId or the digests
 * (digests/expected.json, the settings variant, the pinned run, the wire
 * results, each checked by the protocol validator) and the bytes/sha256 rows
 * of index.json.
 *
 * Run: npx tsx fixtures/m3/delivery/tools/derive-manifest.mts
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CUE_SLOTS,
  M3_KNOWN_MODULE_IDS,
  blockDigest,
  captureManifestV2,
  resolveRequiredModules,
  type ManifestAssetInputV2,
} from '@thirdlight/project-model';
import { validateGameControlResult, validateGameObservation } from '@thirdlight/protocol';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const canon = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const readJson = <T = Record<string, unknown>>(rel: string): T => JSON.parse(readFileSync(join(DIR, rel), 'utf8')) as T;
const written: string[] = [];
const writeJson = (rel: string, v: unknown): void => {
  writeFileSync(join(DIR, rel), canon(v));
  written.push(rel);
};

type Entity = { id: string; components: Record<string, unknown> };
/** The scene preimage without the removed game layer (idempotent). */
function neutralScene(scene: { entities: Entity[] } & Record<string, unknown>): typeof scene {
  return {
    ...scene,
    entities: scene.entities
      .filter((e) => e.components['gameZone'] === undefined)
      .map((e) => {
        const { cameraFollow: _c, ...components } = e.components;
        return { ...e, components };
      }),
  };
}
const neutralContent = (c: Record<string, unknown>): Record<string, unknown> => ({ ...c, game: null });

// 1. The preimages.
const scene = neutralScene(readJson('manifest/scene-preimage.json'));
writeJson('manifest/scene-preimage.json', scene);
const content = neutralContent(readJson('manifest/content-view-preimage.json'));
writeJson('manifest/content-view-preimage.json', content);
const changedContent = neutralContent(readJson('manifest/variants/changed-content-view-preimage.json'));
writeJson('manifest/variants/changed-content-view-preimage.json', changedContent);

// 2. The manifest through the product.
const previous = readJson('manifest/manifest-v2-preimage.json');
const media = {
  cues: Object.fromEntries(CUE_SLOTS.map((slot) => [slot, null])),
  animation: (previous['media'] as { animation: unknown[] }).animation,
};
const modules = resolveRequiredModules({ scene: scene as never, behaviors: [], physicsDimension: 2 });
if (!modules.ok) throw new Error(`modules: ${modules.message}`);
const contentDigest = blockDigest(content);
const res = captureManifestV2({
  projectId: previous['projectId'] as string,
  revision: previous['revision'] as number,
  capturedAt: previous['capturedAt'] as string,
  scene,
  contentDigest,
  assets: (content['assets'] as ManifestAssetInputV2[]).map((a) => ({ ...a })),
  behaviors: [],
  settings: content['settings'] as Record<string, number>,
  game: null,
  media: media as never,
  moduleIds: modules.moduleIds.filter((id) => M3_KNOWN_MODULE_IDS.includes(id)),
});
if (!res.ok) throw new Error(`captureManifestV2: ${JSON.stringify(res.error)}`);
const example = JSON.parse(new TextDecoder().decode(res.bytes)) as Record<string, unknown>;
writeFileSync(join(DIR, 'manifest/manifest-v2-example.json'), res.bytes);
written.push('manifest/manifest-v2-example.json');
const { buildId, ...preimage } = example;
writeJson('manifest/manifest-v2-preimage.json', preimage);

// 3. The recorded digests.
const expected = readJson('digests/expected.json');
const changedContentDigest = blockDigest(changedContent);
const changedSettingsDigest = blockDigest(changedContent['settings']);
writeJson('digests/expected.json', {
  ...expected,
  sceneDigest: example['sceneDigest'],
  contentDigest,
  gameDigest: example['gameDigest'],
  settingsDigest: example['settingsDigest'],
  mediaDigest: example['mediaDigest'],
  buildOptionsDigest: example['buildOptionsDigest'],
  buildId,
  contentCanonicalBytes: Buffer.byteLength(canon(content)),
  manifestCanonicalBytes: res.bytes.length,
  changed: { contentDigest: changedContentDigest, settingsDigest: changedSettingsDigest },
});
const variant = readJson<{ changed: Record<string, unknown> & { unchanged: Record<string, unknown> } } & Record<string, unknown>>('manifest/variants/settings-variant.json');
const { title: _title, ...unchanged } = variant.changed.unchanged;
writeJson('manifest/variants/settings-variant.json', {
  ...variant,
  changed: {
    ...variant.changed,
    contentDigest: changedContentDigest,
    settingsDigest: changedSettingsDigest,
    unchanged: { ...unchanged, sceneDigest: example['sceneDigest'], gameDigest: example['gameDigest'], mediaDigest: example['mediaDigest'], cues: media.cues },
  },
});

// 4. The buildId carriers.
const pinned = readJson<{ run: Record<string, unknown> } & Record<string, unknown>>('settings/pinned-run.json');
writeJson('settings/pinned-run.json', { ...pinned, run: { ...pinned.run, buildId } });
const observe = readJson('wire/observe-result.json');
const observation = { ...observe, buildId };
const obsOk = validateGameObservation(observation);
if (!obsOk.ok) throw new Error(`observe-result: ${JSON.stringify(obsOk)}`);
writeJson('wire/observe-result.json', observation);
const control = { ...readJson('wire/control-result.json'), buildId };
const ctlOk = validateGameControlResult(control);
if (!ctlOk.ok) throw new Error(`control-result: ${JSON.stringify(ctlOk)}`);
writeJson('wire/control-result.json', control);

// 5. The index rows (bytes, sha256) of every listed file.
const index = readJson<{ files: Record<string, { bytes: number; sha256: string }> }>('index.json');
for (const rel of Object.keys(index.files)) {
  const bytes = readFileSync(join(DIR, rel));
  const row = index.files[rel]!;
  row.bytes = bytes.length;
  row.sha256 = createHash('sha256').update(bytes).digest('hex');
}
writeFileSync(join(DIR, 'index.json'), canon(index));
console.log(`buildId ${String(buildId)}; rewrote ${written.join(', ')} and index.json`);
