/**
 * No per-project count cap on assets or resources: a project with half as
 * many again of every kind as the engine once capped (models 128, textures
 * 256, sounds 64, music 64, fonts 16, version records 1,024, prefabs 128,
 * scripts 64, scenes 64 and 32 in the shell's list, materials 256, animators
 * 64, timelines 64, UI documents 64 and themes 16, dialogues 256, speakers
 * 128, effects 128, graphs 64, script libraries 32, environment presets 64,
 * event sounds 64, trust entries 64, block types 256, stamps 64; the Play
 * manifest was 256 KiB) opens in the real backend, takes one command of each
 * kind that makes one more, and plays and exports in the browser. The static
 * half is tests/count-caps.test.ts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { FONT_TOOLCHAIN, MUSIC_TOOLCHAIN, inspectFont, inspectMusic } from '@thirdlight/asset-pipeline';
import { defaultResourcePath, RESOURCE_KINDS, resourceFileBytes } from '@thirdlight/workspace';

import { gpuAvailable } from './browser-env.mjs';
import { PERF_ROOT, REPO, startPerfBackend } from '../../tools/perf/backend';
import { ScaleBench } from '../../tools/perf/scale';
import { generateScaleProject, SCALE_SMALL, type ScaleSpec } from '../../tools/perf/scale-generate';
import { opusVoice } from '../../tools/perf/scale-media';

const root = join(PERF_ROOT, 'e2e', `count-caps-${process.pid}-${Date.now()}`);
test.afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The old caps, and 1.5 times each: the size of this project. */
const OLD = { models: 128, textures: 256, sounds: 64, music: 64, fonts: 16, versionRecords: 1024, prefabs: 128, behaviors: 64, scenes: 64, shellScenes: 32, materials: 256, animators: 64, timelines: 64, uiDocuments: 64, uiThemes: 16, dialogues: 256, speakers: 128, effects: 128, graphs: 64, libraries: 32, presets: 64, cues: 64, trust: 64, blockTypes: 256, stamps: 64 } as const;
const over = (n: number): number => Math.ceil(n * 1.5);

/** Assets, prefabs, materials, scenes, dialogue from the bench generator; enough voices that the records pass 1.5 × 1,024. */
const SPEC: ScaleSpec = {
  ...SCALE_SMALL,
  voices: over(OLD.versionRecords) - over(OLD.sounds) - over(OLD.textures) - over(OLD.models) - over(OLD.fonts) + 1,
  voiceMaxMs: 1_000,
  sounds: over(OLD.sounds),
  textures: over(OLD.textures),
  textureSize: 8,
  models: over(OLD.models),
  prefabs: over(OLD.prefabs),
  materials: over(OLD.materials),
  scenes: over(OLD.scenes),
  dialogueNodes: 60,
};

const pad = (i: number): string => String(i).padStart(5, '0');
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${pad(i)}`);

/** The records of every other kind, as the files and `content.json` an editor would have written. */
function addOtherKinds(dir: string, sceneIds: readonly string[], soundId: string): void {
  const write = (list: string, records: Record<string, unknown>[]): void => {
    const k = RESOURCE_KINDS.find((x) => x.list === list)!;
    for (const r of records) {
      const id = String(r[k.idKey]);
      const path = defaultResourcePath(k, id);
      mkdirSync(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...path.split('/')), resourceFileBytes(k, id, r));
    }
  };
  write('behaviors', ids('script', over(OLD.behaviors)).map((behaviorId) => ({ behaviorId, displayName: behaviorId, declaration: { properties: [] }, source: null, publishedRevision: 0 })));
  write('animators', ids('animator', over(OLD.animators)).map((controllerId) => ({ controllerId, name: controllerId, parameters: [], states: [{ id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: { assetId: 'model-00000', clip: 'idle', duration: 1 } }, speed: 1, loop: true }], transitions: [], entry: 'idle', events: [] })));
  write('timelines', ids('timeline', over(OLD.timelines)).map((timelineId) => ({ timelineId, name: timelineId, duration: 5, tracks: [] })));
  write('uiDocuments', ids('hud', over(OLD.uiDocuments)).map((uiDocumentId) => ({ uiDocumentId, name: uiDocumentId, root: { type: 'panel', stretch: 'both' } })));
  write('uiThemes', ids('theme', over(OLD.uiThemes)).map((uiThemeId) => ({ uiThemeId, name: uiThemeId, styles: { label: { color: '#ffffff', fontSize: 18 } } })));
  write('dialogues', ids('talk', over(OLD.dialogues)).map((dialogueId) => ({ dialogueId, name: dialogueId, graph: { nodes: [{ id: 'start', type: 'start', position: [0, 0] }], edges: [] } })));
  write('effects', ids('effect', over(OLD.effects)).map((effectId) => ({ effectId, name: effectId, duration: 2, loop: true, seed: 1, bounds: { center: [0, 1, 0], size: [4, 4, 4] }, systems: [] })));
  write('graphs', ids('function', over(OLD.graphs)).map((graphId) => ({ graphId, kind: 'material-function', name: graphId, graph: { nodes: [], edges: [] } })));
  write('scriptLibraries', ids('lib', over(OLD.libraries)).map((libraryId) => ({ libraryId, name: libraryId, files: [{ path: 'src/index.ts', text: `export const id = '${libraryId}';\n` }] })));
  write('environment.presets', ids('preset', over(OLD.presets)).map((presetId) => ({ presetId, name: presetId, post: { exposure: 1 } })));

  // Fonts: files with sidecars, as an import leaves them.
  const ttf = new Uint8Array(readFileSync(join(REPO, 'fixtures', 'fonts', 'neutral-sans.ttf')));
  mkdirSync(join(dir, 'assets', 'font'), { recursive: true });
  for (const assetId of ids('font', over(OLD.fonts))) {
    const p = inspectFont(ttf, { profile: 'font', recipeVersion: 1, toolchain: FONT_TOOLCHAIN, displayName: assetId }) as unknown as { status: string; sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics?: unknown };
    if (p.status !== 'ok') throw new Error(`the font inspector refused the fixture: ${JSON.stringify(p).slice(0, 300)}`);
    const sourcePath = `assets/font/${assetId}.ttf`;
    writeFileSync(join(dir, sourcePath), ttf);
    const record = { assetId, kind: 'font', displayName: assetId, currentVersion: 1, versions: [{ version: 1, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, sourcePath, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: '2026-01-01T00:00:00Z', publishedRevision: 0 }] };
    writeFileSync(join(dir, `${sourcePath}.tlasset`), `${JSON.stringify({ tlasset: 2, id: assetId, kind: 'font', importSettings: {}, labels: [], address: null, record }, null, 2)}\n`);
  }

  // The project-wide lists content.json holds.
  const file = JSON.parse(readFileSync(join(dir, 'content.json'), 'utf8')) as { content: Record<string, unknown> };
  const blockTypes = ids('block', over(OLD.blockTypes)).map((blockId) => ({ blockId, name: blockId, variants: [{ color: '#888888' }], shape: 'full' }));
  Object.assign(file.content, {
    speakers: ids('speaker', over(OLD.speakers)).map((speakerId) => ({ speakerId, name: speakerId })),
    eventCues: Array.from({ length: over(OLD.cues) }, (_, i) => ({ on: 'signal', name: `cue-${i}`, assetId: soundId })),
    blockTypes,
    blockStamps: ids('stamp', over(OLD.stamps)).map((stampId) => ({ stampId, name: stampId, size: [1, 1, 1], palette: [{ block: blockTypes[0]!.blockId }], columns: [[0, 0, 0, 1, 0]] })),
    behaviorTrust: { entries: Array.from({ length: over(OLD.trust) }, (_, i) => ({ sourceDigest: pad(i).padStart(64, 'a'), acknowledgedRevision: 0 })) },
    shell: { scenes: sceneIds.slice(0, over(OLD.shellScenes)).map((scene) => ({ scene })) },
  });
  writeFileSync(join(dir, 'content.json'), `${JSON.stringify(file, null, 2)}\n`);
}

test('a project above every old count cap opens, takes one command of each kind, plays and exports', async () => {
  test.setTimeout(600_000);
  const dataRoot = join(root, 'data');
  const generated = generateScaleProject(dataRoot, 'caps', SPEC);
  addOtherKinds(generated.dir, generated.sceneIds, 'sound-00000');

  const be = await startPerfBackend(dataRoot, join(root, 'exports-a'));
  try {
    const p = be.project('caps');
    const opened = await p.query('queryProject');
    // One line per distinct problem (the same rule over many records once).
    const problems = [...new Set(((opened['error'] as { details?: { code: string; path: string; message: string }[] } | undefined)?.details ?? []).map((d) => `${d.code} ${d.path.replace(/\/\d+/g, '/N')}: ${d.message}`))];
    expect(opened['ok'], JSON.stringify(opened['error'] ?? null).slice(0, 300) + problems.join('\n')).toBe(true);
    const count = async (kind: string): Promise<number> => Number((await p.query('queryIndex', { kind, limit: 1 }))['total']);
    const expected: Record<string, number> = {
      model: over(OLD.models), texture: over(OLD.textures), audio: over(OLD.sounds), font: over(OLD.fonts), prefab: over(OLD.prefabs), behavior: over(OLD.behaviors),
      scene: over(OLD.scenes), material: over(OLD.materials), animator: over(OLD.animators), timeline: over(OLD.timelines), ui: over(OLD.uiDocuments), uitheme: over(OLD.uiThemes),
      effect: over(OLD.effects), graph: over(OLD.graphs), library: over(OLD.libraries), envpreset: over(OLD.presets),
    };
    for (const [kind, n] of Object.entries(expected)) expect(await count(kind), kind).toBeGreaterThanOrEqual(n);
    expect(await count('music')).toBeGreaterThan(over(OLD.music));
    expect(await count('dialogue')).toBeGreaterThan(over(OLD.dialogues));

    // One command of each kind, each making one more.
    const one = 'guard';
    await p.command('createScene', { name: 'One more' });
    await p.command('createPrefab', { prefabId: 'prefab-guard', displayName: 'One more', sourceEntityId: 'floor' });
    await p.command('publishBehavior', { behaviorId: `script-${one}`, displayName: 'One more', mode: 'declaration-create', declaration: { properties: [] } });
    await p.command('setMaterial', { material: { materialId: `material-${one}`, name: 'One more', shader: 'standard', params: { roughness: 0.5 }, textures: {} } });
    await p.command('setAnimator', { controller: { controllerId: `animator-${one}`, name: 'One more', parameters: [], states: [{ id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: { assetId: 'model-00000', clip: 'idle', duration: 1 } }, speed: 1, loop: true }], transitions: [], entry: 'idle', events: [] } });
    await p.command('setTimeline', { timeline: { timelineId: `timeline-${one}`, name: 'One more', duration: 5, tracks: [] } });
    await p.command('setUiDocument', { document: { uiDocumentId: `hud-${one}`, name: 'One more', root: { type: 'panel', stretch: 'both' } } });
    await p.command('setUiTheme', { theme: { uiThemeId: `theme-${one}`, name: 'One more', styles: { label: { color: '#ffffff', fontSize: 18 } } } });
    await p.command('setDialogue', { dialogue: { dialogueId: `talk-${one}`, name: 'One more', graph: { nodes: [{ id: 'start', type: 'start', position: [0, 0] }], edges: [] } } });
    await p.command('setSpeaker', { speaker: { speakerId: `speaker-${one}`, name: 'One more' } });
    await p.command('setEffect', { effect: { effectId: `effect-${one}`, name: 'One more', duration: 2, loop: true, seed: 1, bounds: { center: [0, 1, 0], size: [4, 4, 4] }, systems: [] } });
    await p.command('setGraph', { graph: { graphId: `function-${one}`, kind: 'material-function', name: 'One more', graph: { nodes: [], edges: [] } } });
    await p.command('setScriptLibrary', { libraryId: `lib-${one}`, name: 'One more', files: [{ path: 'src/index.ts', text: 'export const one = 1;\n' }] });
    const presets = ids('preset', over(OLD.presets)).map((presetId) => ({ presetId, name: presetId, post: { exposure: 1 } }));
    await p.command('setEnvironment', { environment: { presets: [...presets, { presetId: `preset-${one}`, name: 'One more', post: { exposure: 1 } }] } });
    await p.command('setEventCues', { cues: Array.from({ length: over(OLD.cues) + 1 }, (_, i) => ({ on: 'signal', name: `cue-${i}`, assetId: 'sound-00000' })) });
    await p.command('acknowledgeBehaviorTrust', { sourceDigest: 'f'.repeat(64) });
    await p.command('setBlockType', { block: { blockId: `block-${one}`, name: 'One more', variants: [{ color: '#888888' }], shape: 'full' } });
    await p.command('setBlockStamp', { stamp: { stampId: `stamp-${one}`, name: 'One more', size: [1, 1, 1], palette: [{ block: `block-${one}` }], columns: [[0, 0, 0, 1, 0]] } });
    await p.command('setShell', { shell: { scenes: generated.sceneIds.slice(0, over(OLD.shellScenes) + 1).map((scene) => ({ scene })) } });
    // An import of one more voice and one more font (the asset kinds with the lowest old caps).
    const folder = join(generated.dir, 'assets', 'guard-import');
    mkdirSync(folder, { recursive: true });
    const voice = opusVoice(7, 400, 'one-more');
    expect((inspectMusic(voice, { profile: 'music', recipeVersion: 1, toolchain: MUSIC_TOOLCHAIN }) as { status: string }).status).toBe('ok');
    writeFileSync(join(folder, 'voice-one-more.opus'), voice);
    writeFileSync(join(folder, 'font-one-more.ttf'), readFileSync(join(REPO, 'fixtures', 'fonts', 'neutral-sans.ttf')));
    const imported = await p.command('importAssets', { folder: 'assets/guard-import' });
    expect(imported['ok']).toBe(true);
    expect(await count('font')).toBe(over(OLD.fonts) + 1);
    expect(await count('scene')).toBe(over(OLD.scenes) + 1);
    expect(await count('envpreset')).toBe(over(OLD.presets) + 1);
  } finally {
    await be.stop();
  }

  // Open in the editor, edit, Play and export (the manifest holds every asset row inline: over the 256 KiB it was capped at).
  const bench = new ScaleBench({
    dataRoot,
    exportRoot: join(root, 'exports'),
    projectId: 'caps',
    generated,
    renderer: 'webgl2',
    gpu: gpuAvailable(),
    commands: 1,
    walk: 0,
    lines: 0,
    steps: ['open', 'commands', 'play', 'export'],
    log: () => undefined,
  });
  const r = await bench.run();
  expect(r.broke).toEqual({});
  expect(r.play!.split.firstFrameMs).toBeGreaterThan(0);
  expect(r.export!.state).toBe('running');
  expect(r.export!.pageErrors).toEqual([]);
});
