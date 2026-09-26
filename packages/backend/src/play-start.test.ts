/**
 * Phase 23.8: resolving a test/debug start of Play against the project.
 */
import { describe, expect, it } from 'vitest';

import { resolvePlayStart } from './play-start';

const scene = (sceneId: string, entities: { id: string; components?: Record<string, unknown> }[] = []) => ({ sceneId, entities });
const scenes = [scene('scene-hub', [{ id: 'spawn-0001', components: { playerSpawn: {} } }]), scene('scene-arena', [{ id: 'rock-0001', components: {} }, { id: 'spawn-0009', components: { playerSpawn: {} } }]), scene('scene-extra')];

describe('resolvePlayStart', () => {
  it('without levels: the scene loads with the start scenes; a game starts at its first player spawn', () => {
    const r = resolvePlayStart({ sceneId: 'scene-arena', variables: { gold: 3 } }, { content: { game: { spawnId: 'spawn-0001' } }, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' });
    expect(r).toEqual({ ok: true, start: { sceneId: 'scene-arena', scenes: ['scene-hub', 'scene-arena'], spawnId: 'spawn-0009', variables: { gold: 3 } }, notes: [] });
    // A start scene stays the start set; a scene without a spawn keeps the game's; scene mode has no spawn.
    expect(resolvePlayStart({ sceneId: 'scene-hub' }, { content: { game: {} }, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' })).toMatchObject({ ok: true, start: { scenes: ['scene-hub'], spawnId: 'spawn-0001' } });
    expect(resolvePlayStart({ sceneId: 'scene-extra' }, { content: { game: {} }, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' })).toEqual({ ok: true, start: { sceneId: 'scene-extra', scenes: ['scene-hub', 'scene-extra'] }, notes: [] });
    expect(resolvePlayStart({ sceneId: 'scene-arena' }, { content: { game: null }, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' })).toEqual({ ok: true, start: { sceneId: 'scene-arena', scenes: ['scene-hub', 'scene-arena'] }, notes: [] });
  });

  it('with levels: the first level that loads the scene; a save continues a level; others are refused', () => {
    const content = { game: {}, flow: { levels: [{ id: 'level-1', scenes: ['scene-hub'] }, { id: 'level-2', scenes: ['scene-hub', 'scene-arena'] }] } };
    const project = { content, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' };
    expect(resolvePlayStart({ sceneId: 'scene-arena' }, project)).toEqual({ ok: true, start: { sceneId: 'scene-arena', levelId: 'level-2' }, notes: [] });
    expect(resolvePlayStart({ sceneId: 'scene-extra' }, project)).toMatchObject({ ok: false, error: { code: 'field_value', path: '/options/sceneId' } });
    expect(resolvePlayStart({ save: { version: 1, levelId: 'level-2', run: {} } }, project)).toMatchObject({ ok: true, start: { save: { levelId: 'level-2' } } });
    expect(resolvePlayStart({ save: { version: 1, levelId: 'level-9', run: {} } }, project)).toMatchObject({ ok: false, error: { path: '/options/save/levelId' } });
    expect(resolvePlayStart({ saveSlot: 'auto' }, project)).toEqual({ ok: true, start: { saveSlot: 'auto' }, notes: [] });
  });

  it('refuses unknown scenes and saves without levels; a mode is checked once modes exist, noted otherwise', () => {
    const plain = { content: { game: {} }, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' };
    expect(resolvePlayStart({ sceneId: 'scene-none' }, plain)).toMatchObject({ ok: false });
    expect(resolvePlayStart({ saveSlot: '1' }, plain)).toMatchObject({ ok: false, error: { path: '/options/saveSlot' } });
    expect(resolvePlayStart({ sceneId: 'scene-other' }, { content: {}, sceneId: 'scene-main' })).toMatchObject({ ok: false });
    expect(resolvePlayStart({ sceneId: 'scene-main' }, { content: {}, sceneId: 'scene-main' })).toEqual({ ok: true, start: { sceneId: 'scene-main' }, notes: [] });
    expect(resolvePlayStart({ mode: 'battle' }, plain)).toEqual({ ok: true, start: {}, notes: ['mode "battle" ignored: the project defines no game modes'] });
    const withModes = { ...plain, content: { game: {}, modes: [{ modeId: 'explore' }, { modeId: 'battle' }] } };
    expect(resolvePlayStart({ mode: 'battle' }, withModes)).toEqual({ ok: true, start: { mode: 'battle' }, notes: [] });
    expect(resolvePlayStart({ mode: 'dance' }, withModes)).toMatchObject({ ok: false, error: { path: '/options/mode' } });
  });
});
