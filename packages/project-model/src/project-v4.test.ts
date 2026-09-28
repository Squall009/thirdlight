/**
 * Phase 12 (c): v4 scenes (instance sets, at most one camera), the v4 content
 * block (startScenes; phase 24: no game block, no flow), the cross-scene
 * project rules and the v3 → v4 migration (run on the neutral starter
 * template).
 */
import { describe, expect, it } from 'vitest';

import { migrateProjectV3ToV4, validateProjectV4 } from './project-v4';
import { validateContentV4 } from './content';
import { validateSceneV4 } from './scene-v3';
import { validateEnvelopeV3 } from './project-v3';
import type { ContentCatalogV3, SceneV3 } from './types-v3';
import type { Manifest } from './types';

// Package sources may not import Node builtins: the sample is read through Vite's raw import.
const SAMPLE_RAW = Object.values(
  import.meta.glob('../../../templates/starter/captured/project.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>,
)[0] as string;
const SAMPLE = JSON.parse(SAMPLE_RAW) as { content: { assets: { assetId: string; kind: string }[] } };
/** A real model asset record (the catalog validates records in full). */
const MODEL = SAMPLE.content.assets.find((a) => a.kind === 'model')!;
const GRASS = MODEL.assetId;
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y = 0) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const DIGEST = 'ab'.repeat(32);
const camera = (id = 'cam-main') => ({ id, components: { transform: T, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } });
const scene = (sceneId: string, entities: unknown[]) => ({ schemaVersion: 4, sceneId, revision: 1, entities });
const MANIFEST = { schemaVersion: 2, engineVersion: '0.1.0', id: 'p', name: 'P', createdAt: '2026-09-23T00:00:00Z' };
const content = (extra: Record<string, unknown> = {}) => ({
  assets: [MODEL],
  prefabs: [],
  behaviors: [],
  settings: {},
  behaviorTrust: { entries: [] },
  game: null,
  scenes: [
    { sceneId: 'scene-core', name: 'Core' },
    { sceneId: 'scene-level', name: 'Level' },
    { sceneId: 'scene-exit', name: 'Exit' },
  ],
  startScenes: ['scene-core'],
  ...extra,
});

describe('scene v4', () => {
  it('accepts instance sets and a camera-less scene', () => {
    const r = validateSceneV4(
      scene('scene-a', [
        { id: 'grass-0001', components: { transform: T, instances: { asset: { assetId: GRASS }, buffer: DIGEST, count: 12000 } } },
        { id: 'spawn-0002', components: { transform: at(5, 1), playerSpawn: {} } },
      ]),
    );
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    expect(validateSceneV4(scene('scene-core', [camera()])).ok).toBe(true);
  });

  it('refuses bad instance sets, the removed game components and two cameras', () => {
    const bad = (entities: unknown[], extra: Record<string, unknown> = {}) => validateSceneV4({ ...scene('scene-a', entities), ...extra });
    expect(bad([{ id: 'g-1', components: { transform: T, instances: { asset: { assetId: GRASS }, buffer: 'nope', count: 1 } } }]).ok).toBe(false);
    expect(bad([{ id: 'g-1', components: { transform: T, instances: { asset: { assetId: GRASS }, buffer: DIGEST, count: 70000 } } }]).ok).toBe(false);
    expect(bad([{ id: 'g-1', components: { transform: T, box: { size: [1, 1, 1], material: { color: '#ffffff' } }, instances: { asset: { assetId: GRASS }, buffer: DIGEST, count: 3 } } }]).ok).toBe(false);
    // Phase 24: gameZone and cameraFollow are no components any more.
    for (const removed of [{ gameZone: { role: 'exit', size: [1, 1], load: ['scene-a'] } }, { cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } }]) {
      const r = bad([{ id: 'z-1', components: { transform: T, ...removed } }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => [e.code, e.path])).toEqual([['component_unknown', `/entities/0/components/${Object.keys(removed)[0]}`]]);
    }
    expect(bad([camera('c-1'), camera('c-2')]).ok).toBe(false);
  });
});

describe('content v4', () => {
  it('needs startScenes', () => {
    expect(validateContentV4(content()).ok).toBe(true);
    const { startScenes: _s, ...noStart } = content();
    expect(validateContentV4(noStart).ok).toBe(false);
    // The start set must come from the scene index; scene ids are unique.
    expect(validateContentV4(content({ startScenes: ['scene-nowhere'] })).ok).toBe(false);
    expect(validateContentV4(content({ scenes: [{ sceneId: 'scene-core', name: 'A' }, { sceneId: 'scene-core', name: 'B' }] })).ok).toBe(false);
  });

  it('phase 24: refuses a game block and a flow key, naming the removal', () => {
    const game = { configVersion: 2, title: 'T', objective: 'O', instructions: 'I', playerId: 'p', cameraId: 'c', spawnId: 's', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } };
    const withGame = validateContentV4(content({ game }));
    expect(withGame.ok).toBe(false);
    if (!withGame.ok) {
      const e = withGame.errors.find((x) => x.path === '/game');
      expect(e, JSON.stringify(withGame.errors)).toBeDefined();
      expect(e!.code).toBe('game_config_invalid');
      expect(e!.message).toContain('removed in phase 24');
    }
    const withFlow = validateContentV4(content({ flow: { levels: [] } }));
    expect(withFlow.ok).toBe(false);
    if (!withFlow.ok) {
      const e = withFlow.errors.find((x) => x.path === '/flow');
      expect(e, JSON.stringify(withFlow.errors)).toBeDefined();
      expect(e!.message).toContain('removed in phase 24');
    }
    // The key itself stays: game must be present and null.
    const { game: _g, ...noGame } = content();
    expect(validateContentV4(noGame).ok).toBe(false);
  });
});

describe('project v4', () => {
  const core = scene('scene-core', [camera(), { id: 'light-0001', components: { transform: T, light: { type: 'ambient', color: '#ffffff', intensity: 1 } } }]);
  const level = scene('scene-level', [
    { id: 'box-0001', components: { transform: T, box: { size: [1, 1, 1], material: { color: '#ffffff' } } } },
    { id: 'spawn-0002', components: { transform: at(2), playerSpawn: {} } },
  ]);

  it('accepts a start scene with the camera and a level scene loaded later', () => {
    const r = validateProjectV4(MANIFEST, content({ scenes: [{ sceneId: 'scene-core', name: 'Core' }, { sceneId: 'scene-level', name: 'Level' }] }), [core, level]);
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    if (r.ok) expect(r.normalized.scenes.map((s) => s.sceneId)).toEqual(['scene-core', 'scene-level']);
  });

  it('refuses duplicate ids across scenes, one-per-game things outside the start set, and dangling references', () => {
    const dup = scene('scene-level', [{ id: 'cam-main', components: { transform: T } }]);
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, dup]))).toContain('unique across the project');
    const litLevel = scene('scene-level', [{ id: 'light-0009', components: { transform: T, light: { type: 'ambient', color: '#ffffff', intensity: 1 } } }]);
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, litLevel]))).toContain('start_scene_only');
    expect(validateProjectV4(MANIFEST, content({ startScenes: ['scene-nope'] }), [core]).ok).toBe(false);
    const noCam = scene('scene-core', []);
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [noCam]))).toContain('camera_count_invalid');
    // Phase 24.4e: a trigger's scene transition names existing scenes and a player spawn in the scene it loads (or its own).
    const door = (t: Record<string, unknown>) => scene('scene-exit', [{ id: 'door-0001', components: { transform: T, trigger: { size: [1, 1], signal: 'door', sceneTransition: t } } }]);
    expect(validateProjectV4(MANIFEST, content(), [core, level, door({ scene: 'scene-level', spawn: 'spawn-0002', unload: ['scene-exit'] })]).ok).toBe(true);
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, level, door({ scene: 'scene-gone' })]))).toContain('a scene transition names no scene');
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, level, door({ scene: 'scene-level', unload: ['scene-gone'] })]))).toContain('a scene transition unloads no scene');
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, level, door({ scene: 'scene-core', spawn: 'spawn-0002' })]))).toContain('a scene transition\'s spawn must be');
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, level, door({ scene: 'scene-level', spawn: 'box-0001' })]))).toContain('a scene transition\'s spawn must be');
    // Phase 24.4j: the shell's listed scenes are scenes of the project, each spawn a player spawn in its scene.
    const hudDoc = { uiDocumentId: 'hud', name: 'HUD', root: { type: 'panel' } };
    const shell = (scenes: unknown[]) => content({ uiDocuments: [hudDoc], shell: { hud: ['hud'], scenes } });
    const good = validateProjectV4(MANIFEST, shell([{ scene: 'scene-core' }, { scene: 'scene-level', spawn: 'spawn-0002' }]), [core, level, scene('scene-exit', [])]);
    expect(good.ok, JSON.stringify(!good.ok && good.errors)).toBe(true);
    expect(JSON.stringify(validateProjectV4(MANIFEST, shell([{ scene: 'scene-gone' }]), [core, level]))).toContain('a listed scene names an unknown scene');
    expect(JSON.stringify(validateProjectV4(MANIFEST, shell([{ scene: 'scene-core', spawn: 'spawn-0002' }]), [core, level]))).toContain('a listed scene starts at a player spawn in that scene');
    expect(JSON.stringify(validateProjectV4(MANIFEST, content({ shell: { hud: ['hud'] } }), [core, level]))).toContain('no UI document');
    const inst = scene('scene-level', [{ id: 'g-1', components: { transform: T, instances: { asset: { assetId: 'asset-none' }, buffer: DIGEST, count: 2 } } }]);
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, inst]))).toContain('asset_reference_missing');
  });
});

describe('migration v3 → v4', () => {
  it('migrates the starter template: one scene "Main", startScenes, no game block, and the result validates', () => {
    const captured = JSON.parse(SAMPLE_RAW) as { scene: SceneV3; content: ContentCatalogV3 };
    const env = validateEnvelopeV3({ storageVersion: 3, type: 'authoring-state', projectId: 'starter', scene: captured.scene, content: captured.content, retry: { retention: 64, records: [] } });
    expect(env.ok, JSON.stringify(!env.ok && env.errors)).toBe(true);
    if (!env.ok) return;
    const manifest: Manifest = { schemaVersion: 1, engineVersion: '0.1.0', id: 'starter', name: 'Starter', createdAt: '2026-09-23T00:00:00Z', scenes: [{ id: env.normalized.scene.sceneId, path: 'scenes/main.json' }] };
    const { project, notes } = migrateProjectV3ToV4(manifest, env.normalized.scene, env.normalized.content);
    expect(project.scenes).toHaveLength(1);
    expect(project.scenes[0]).toMatchObject({ schemaVersion: 4, sceneId: env.normalized.scene.sceneId });
    expect(project.scenes[0]!.entities.map((e) => e.id)).toEqual(env.normalized.scene.entities.map((e) => e.id));
    expect(project.content.scenes).toEqual([{ sceneId: env.normalized.scene.sceneId, name: 'Main' }]);
    expect(project.content.startScenes).toEqual([env.normalized.scene.sceneId]);
    expect(project.content.game).toBeNull();
    expect(notes).toEqual([]);
    const v = validateProjectV4(project.manifest, project.content, project.scenes);
    expect(v.ok, JSON.stringify(!v.ok && v.errors)).toBe(true);
  });
});
