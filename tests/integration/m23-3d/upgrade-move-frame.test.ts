/**
 * An upgrade must not change how a game plays. Before the engine owned the
 * view, a 3D character read its move input along the world axes unless a
 * virtual camera was loaded; the scene camera the upgrade turns into a shot
 * would now turn that input. Two schemaVersion 6 projects shaped like the two
 * games (`fixtures/phase28/move-frame`: a title scene holding a turned camera
 * and the player, no virtual camera; a turned camera in a start scene next to
 * a level whose orbit camera the character walks under) carry the path their
 * character walked under a recorded input on the engine that wrote them. Each
 * is upgraded by the loader's step and played again through the production
 * game host: the character walks the same path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { upgradeSceneModel } from '@thirdlight/project-model';
import { physics3DConfigOf, type ActionFrame } from '@thirdlight/runtime';

import { runScene, SETTINGS, type Any } from './character-kit';

const DIR = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'phase28', 'move-frame');
interface Shape { settings: Any; startScenes: string[]; scenes: { sceneId: string; entities: Any[] }[]; input: { steps: number; move: [number, number] }[]; v6: { path: number[][] } }
const shapeOf = (name: string): Shape => JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf8')) as Shape;

/** The character's origin (x, z) every 30th step while the recorded input plays. */
async function walk(name: string, shape: Shape, entities: Any[]): Promise<number[][]> {
  const settings = { ...SETTINGS, ...shape.settings };
  const scene = { snapshot: { snapshotId: `${name}@r1`, projectId: name, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities } }, physics: physics3DConfigOf(entities, settings) };
  const replay: ActionFrame[] = [];
  for (const seg of shape.input) for (let i = 0; i < seg.steps; i += 1) replay.push({ stepIndex: replay.length, moveX: seg.move[0], moveY: seg.move[1], jump: 'none' } as ActionFrame);
  const run = await runScene('single', scene, replay, replay.length);
  await run.h.dispose();
  expect(run.errors).toEqual([]);
  return run.path.filter((_, i) => i % 30 === 29).map((p) => [p[0]!, p[2]!]);
}

function upgraded(shape: Shape): { entities: Any[]; notes: string[] } {
  const u = upgradeSceneModel({ settings: shape.settings, startScenes: shape.startScenes, scenes: shape.scenes.map((s) => ({ sceneId: s.sceneId })) }, shape.scenes);
  return { entities: (u.scenes as { entities: Any[] }[]).flatMap((s) => s.entities), notes: u.notes };
}

const expectSamePath = (path: number[][], v6: number[][]): void => {
  expect(path.length).toBe(v6.length);
  path.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(v6[i]![0]!, 5);
    expect(p[1]).toBeCloseTo(v6[i]![1]!, 5);
  });
};

describe('an upgraded 3D project moves its character as it did before the upgrade', () => {
  it('a title scene holding a turned camera and the player (no virtual camera): world axes, as before', async () => {
    const shape = shapeOf('title-player');
    const { entities, notes } = upgraded(shape);
    const player = entities.find((e) => e.id === 'player-0001');
    expect(player.components.controller).toEqual({ moveFrame: 'world' });
    expect(notes.join('\n')).toContain('"player-0001" moves along the world axes as before');
    expectSamePath(await walk('title-player', shape, entities), shape.v6.path);
    // Without the setting the turned camera's heading would turn the input: a different path.
    const viewRelative = entities.map((e) => (e.id === 'player-0001' ? { ...e, components: { ...e.components, controller: {} } } : e));
    const other = await walk('title-player', shape, viewRelative);
    expect(Math.hypot(other.at(-1)![0]! - shape.v6.path.at(-1)![0]!, other.at(-1)![1]! - shape.v6.path.at(-1)![1]!)).toBeGreaterThan(0.2);
  }, 60_000);

  it('a turned camera in a start scene and a level with an orbit camera: relative to the orbit camera, as before', async () => {
    const shape = shapeOf('start-camera');
    const { entities, notes } = upgraded(shape);
    // A project with virtual cameras keeps the camera-relative default (its orbit camera turned the input before too).
    expect(entities.find((e) => e.id === 'player-0001').components.controller).toEqual({});
    // Only where its turned old camera would be the one live shot does the input change; the upgrade says so.
    expect(notes.join('\n')).toContain('relative to the heading of "cam-main"');
    expectSamePath(await walk('start-camera', shape, entities), shape.v6.path);
  }, 60_000);
});
