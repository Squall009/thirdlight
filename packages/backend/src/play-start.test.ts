/**
 * Phase 23.8: resolving a test/debug start of Play against the project.
 */
import { describe, expect, it } from 'vitest';

import { resolvePlayStart } from './play-start';

const scene = (sceneId: string, entities: { id: string; components?: Record<string, unknown> }[] = []) => ({ sceneId, entities });
const scenes = [scene('scene-hub', [{ id: 'spawn-0001', components: { playerSpawn: {} } }]), scene('scene-arena', [{ id: 'rock-0001', components: {} }, { id: 'spawn-0009', components: { playerSpawn: {} } }]), scene('scene-extra')];

describe('resolvePlayStart', () => {
  it('the scene loads with the start scenes; the character starts at its first player spawn', () => {
    const r = resolvePlayStart({ sceneId: 'scene-arena', variables: { gold: 3 } }, { content: {}, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' });
    expect(r).toEqual({ ok: true, start: { sceneId: 'scene-arena', scenes: ['scene-hub', 'scene-arena'], spawnId: 'spawn-0009', variables: { gold: 3 } }, notes: [] });
    // A start scene stays the start set; a scene without a spawn names none.
    expect(resolvePlayStart({ sceneId: 'scene-hub' }, { content: {}, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' })).toMatchObject({ ok: true, start: { scenes: ['scene-hub'], spawnId: 'spawn-0001' } });
    expect(resolvePlayStart({ sceneId: 'scene-extra' }, { content: {}, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' })).toEqual({ ok: true, start: { sceneId: 'scene-extra', scenes: ['scene-hub', 'scene-extra'] }, notes: [] });
    expect(resolvePlayStart({ sceneId: 'scene-arena' }, { content: {}, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' })).toEqual({ ok: true, start: { sceneId: 'scene-arena', scenes: ['scene-hub', 'scene-arena'], spawnId: 'spawn-0009' }, notes: [] });
  });

  it('refuses unknown scenes and saves without a save schema; a mode is checked once modes exist, noted otherwise', () => {
    const plain = { content: {}, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' };
    expect(resolvePlayStart({ sceneId: 'scene-none' }, plain)).toMatchObject({ ok: false });
    expect(resolvePlayStart({ saveSlot: '1' }, plain)).toMatchObject({ ok: false, error: { path: '/options/saveSlot' } });
    expect(resolvePlayStart({ sceneId: 'scene-other' }, { content: {}, sceneId: 'scene-main' })).toMatchObject({ ok: false });
    expect(resolvePlayStart({ sceneId: 'scene-main' }, { content: {}, sceneId: 'scene-main' })).toEqual({ ok: true, start: { sceneId: 'scene-main' }, notes: [] });
    expect(resolvePlayStart({ mode: 'battle' }, plain)).toEqual({ ok: true, start: {}, notes: ['mode "battle" ignored: the project defines no game modes'] });
    const withModes = { ...plain, content: { modes: [{ modeId: 'explore' }, { modeId: 'battle' }] } };
    expect(resolvePlayStart({ mode: 'battle' }, withModes)).toEqual({ ok: true, start: { mode: 'battle' }, notes: [] });
    expect(resolvePlayStart({ mode: 'dance' }, withModes)).toMatchObject({ ok: false, error: { path: '/options/mode' } });
  });

  it('phase 23.19: a project save document or slot needs a save schema; newer documents and missing slots are refused', () => {
    const withSchema = { content: { saveSchema: { version: 2, slots: 5 } }, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' };
    const doc = { format: 'thirdlight.save', version: 1, doc: { a: 1 } };
    expect(resolvePlayStart({ save: doc }, withSchema)).toEqual({ ok: true, start: { projectSave: doc }, notes: [] });
    expect(resolvePlayStart({ saveSlot: '4' }, withSchema)).toEqual({ ok: true, start: { projectSaveSlot: 4 }, notes: [] });
    expect(resolvePlayStart({ saveSlot: '6' }, withSchema)).toMatchObject({ ok: false, error: { path: '/options/saveSlot' } });
    expect(resolvePlayStart({ save: { ...doc, version: 3 } }, withSchema)).toMatchObject({ ok: false, error: { path: '/options/save/version' } });
    const plain = { content: {}, scenes, startScenes: ['scene-hub'], sceneId: 'scene-hub' };
    expect(resolvePlayStart({ save: doc }, plain)).toMatchObject({ ok: false, error: { path: '/options/save' } });
    expect(resolvePlayStart({ saveSlot: '7' }, plain)).toMatchObject({ ok: false, error: { path: '/options/saveSlot' } });
  });
});
