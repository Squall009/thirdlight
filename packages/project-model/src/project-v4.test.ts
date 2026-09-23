/**
 * Phase 12 (c): v4 scenes (instance sets, exit zones, optional camera-follow
 * bounds, at most one camera), the v4 content block (startScenes, game
 * configVersion 2 without level/killY), the cross-scene project rules and the
 * v3 → v4 migration (run on the real Beacon Reach sample).
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
  import.meta.glob('../../../samples/beacon-reach/captured/project.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>,
)[0] as string;
const SAMPLE = JSON.parse(SAMPLE_RAW) as { content: { assets: { assetId: string; kind: string }[] } };
/** A real model asset record (the catalog validates records in full). */
const MODEL = SAMPLE.content.assets.find((a) => a.kind === 'model')!;
const GRASS = MODEL.assetId;
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y = 0) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const DIGEST = 'ab'.repeat(32);
const camera = (id = 'cam-main') => ({ id, components: { transform: T, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } });
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
  it('accepts instance sets, exit zones, bounds-less camera follow and a camera-less scene', () => {
    const r = validateSceneV4(
      scene('scene-a', [
        { id: 'grass-0001', components: { transform: T, instances: { asset: { assetId: GRASS }, buffer: DIGEST, count: 12000 } } },
        { id: 'zone-0001', components: { transform: at(5, 1), gameZone: { role: 'exit', size: [1, 2], load: ['scene-b'], unload: ['scene-a'], spawnId: 'spawn-0002' } } },
      ]),
    );
    expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
    expect(validateSceneV4(scene('scene-core', [camera()])).ok).toBe(true);
  });

  it('refuses bad instance sets, empty exits and two cameras', () => {
    const bad = (entities: unknown[], extra: Record<string, unknown> = {}) => validateSceneV4({ ...scene('scene-a', entities), ...extra });
    expect(bad([{ id: 'g-1', components: { transform: T, instances: { asset: { assetId: GRASS }, buffer: 'nope', count: 1 } } }]).ok).toBe(false);
    expect(bad([{ id: 'g-1', components: { transform: T, instances: { asset: { assetId: GRASS }, buffer: DIGEST, count: 70000 } } }]).ok).toBe(false);
    expect(bad([{ id: 'g-1', components: { transform: T, box: { size: [1, 1, 1], material: { color: '#ffffff' } }, instances: { asset: { assetId: GRASS }, buffer: DIGEST, count: 3 } } }]).ok).toBe(false);
    expect(bad([{ id: 'z-1', components: { transform: T, gameZone: { role: 'exit', size: [1, 1] } } }]).ok).toBe(false);
    expect(bad([camera('c-1'), camera('c-2')]).ok).toBe(false);
  });
});

describe('content v4', () => {
  it('needs startScenes and a configVersion 2 game without level or killY', () => {
    expect(validateContentV4(content()).ok).toBe(true);
    const { startScenes: _s, ...noStart } = content();
    expect(validateContentV4(noStart).ok).toBe(false);
    const game = { configVersion: 2, title: 'T', objective: 'O', instructions: 'I', playerId: 'p', cameraId: 'c', spawnId: 's', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } };
    expect(validateContentV4(content({ game })).ok).toBe(true);
    expect(validateContentV4(content({ game: { ...game, killY: -5 } })).ok).toBe(false);
    expect(validateContentV4(content({ game: { ...game, configVersion: 1 } })).ok).toBe(false);
    // The start set must come from the scene index; scene ids are unique.
    expect(validateContentV4(content({ startScenes: ['scene-nowhere'] })).ok).toBe(false);
    expect(validateContentV4(content({ scenes: [{ sceneId: 'scene-core', name: 'A' }, { sceneId: 'scene-core', name: 'B' }] })).ok).toBe(false);
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
    const exit = scene('scene-exit', [{ id: 'zone-0001', components: { transform: T, gameZone: { role: 'exit', size: [1, 1], load: ['scene-gone'] } } }]);
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, exit]))).toContain('an exit names no scene');
    const badSpawn = scene('scene-exit', [{ id: 'zone-0001', components: { transform: T, gameZone: { role: 'exit', size: [1, 1], load: ['scene-core'], spawnId: 'spawn-0002' } } }]);
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, level, badSpawn]))).toContain('an exit spawn must be');
    const inst = scene('scene-level', [{ id: 'g-1', components: { transform: T, instances: { asset: { assetId: 'asset-none' }, buffer: DIGEST, count: 2 } } }]);
    expect(JSON.stringify(validateProjectV4(MANIFEST, content(), [core, inst]))).toContain('asset_reference_missing');
  });
});

describe('migration v3 → v4', () => {
  it('migrates the Beacon Reach sample: one scene "Main", startScenes, killY becomes a fall zone, and the result validates', () => {
    const captured = JSON.parse(SAMPLE_RAW) as {
      scene: SceneV3;
      content: ContentCatalogV3;
    };
    const env = validateEnvelopeV3({ storageVersion: 3, type: 'authoring-state', projectId: 'beacon', scene: captured.scene, content: captured.content, retry: { retention: 64, records: [] } });
    expect(env.ok, JSON.stringify(!env.ok && env.errors)).toBe(true);
    if (!env.ok) return;
    const manifest: Manifest = { schemaVersion: 1, engineVersion: '0.1.0', id: 'beacon', name: 'Beacon Reach', createdAt: '2026-09-23T00:00:00Z', scenes: [{ id: env.normalized.scene.sceneId, path: 'scenes/main.json' }] };
    const { project, notes } = migrateProjectV3ToV4(manifest, env.normalized.scene, env.normalized.content);
    expect(project.scenes).toHaveLength(1);
    expect(project.scenes[0]).toMatchObject({ schemaVersion: 4, sceneId: env.normalized.scene.sceneId });
    expect(project.content.scenes).toEqual([{ sceneId: env.normalized.scene.sceneId, name: 'Main' }]);
    expect(project.content.startScenes).toEqual([env.normalized.scene.sceneId]);
    expect(project.content.game).not.toHaveProperty('level');
    expect(project.content.game).not.toHaveProperty('killY');
    expect(project.content.game?.configVersion).toBe(2);
    const fall = project.scenes[0]!.entities.find((e) => e.name === 'Fall zone');
    expect(fall?.components.gameZone).toMatchObject({ role: 'hazard' });
    expect(notes.join(' ')).toContain('Fall zone');
    const v = validateProjectV4(project.manifest, project.content, project.scenes);
    expect(v.ok, JSON.stringify(!v.ok && v.errors)).toBe(true);
  });
});
