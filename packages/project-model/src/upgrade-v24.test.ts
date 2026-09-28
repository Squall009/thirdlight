/**
 * Phase 24.8: the pure schemaVersion 2 → 3 upgrade (`upgradeProjectDocsV24`)
 * and the validators' refusal of removed game data.
 */
import { describe, it, expect } from 'vitest';
import { upgradeProjectDocsV24, removedComponentMessage, REMOVED_IN_PHASE_24 } from './upgrade-v24';
import { validateSceneV4 } from './scene-v3';
import { validateContentV4 } from './content';
import { validateProjectV4 } from './project-v4';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const box = { size: [1, 1, 1], material: { color: '#ffffff' } };
const content = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  assets: [],
  prefabs: [],
  behaviors: [],
  settings: {},
  behaviorTrust: { entries: [] },
  game: null,
  scenes: [{ sceneId: 'scene-main', name: 'Main' }],
  startScenes: ['scene-main'],
  ...extra,
});
const scene = (entities: unknown[]): Record<string, unknown> => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities });
const cam = { id: 'cam-main', components: { transform: T, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } };
const MANIFEST = { schemaVersion: 3, engineVersion: '0.1.0', id: 'p', name: 'P', createdAt: '2026-09-23T00:00:00Z' };

describe('phase 24.8 upgrade: generic data is carried over', () => {
  it('pickups become collectibles adding to the counters they added to; the amount, size and sound carry over', () => {
    const u = upgradeProjectDocsV24(content(), [
      scene([
        cam,
        { id: 'box-0001', components: { transform: T, box, pickup: { kind: 'coin', value: 1 } } },
        { id: 'box-0002', components: { transform: T, box, pickup: { kind: 'gem', value: 3, size: [0.5, 0.5] } } },
        { id: 'box-0003', components: { transform: T, box, pickup: { kind: 'key', value: 1, respawn: 'never' } } },
        { id: 'box-0004', components: { transform: T, box, pickup: { kind: 'life', value: 1 } } },
        { id: 'box-0005', components: { transform: T, box, pickup: { kind: 'custom', counter: 'shards', value: 2, cue: 'audio-0001' } } },
        { id: 'box-0006', components: { transform: T, box, pickup: { kind: 'custom', value: 1 } } },
      ]),
    ]);
    expect(u.errors).toEqual([]);
    const comps = (i: number): Record<string, unknown> => ((u.scenes[0] as { entities: Array<{ components: Record<string, unknown> }> }).entities[i]!.components);
    expect(comps(1)['collectible']).toEqual({ counter: 'coins' });
    expect(comps(2)['collectible']).toEqual({ counter: 'gems', amount: 3, size: [0.5, 0.5] });
    expect(comps(3)['collectible']).toEqual({ counter: 'keys' });
    expect(comps(4)['collectible']).toEqual({ counter: 'lives' });
    expect(comps(5)['collectible']).toEqual({ counter: 'shards', amount: 2 });
    expect(comps(6)['collectible']).toEqual({ counter: 'custom' });
    for (let i = 1; i <= 6; i++) expect(comps(i)['pickup']).toBeUndefined();
    expect((u.content as { eventCues: unknown[] }).eventCues).toEqual([{ on: 'event', name: 'collected', entity: 'box-0005', assetId: 'audio-0001' }]);
    expect('game' in (u.content as object)).toBe(false);
    expect(u.notes.join('\n')).toContain('6 pickups became collectibles');
    // The upgraded scene is a valid v4 scene.
    expect(validateSceneV4(u.scenes[0]).ok).toBe(true);
  });

  it('a spawn facing becomes a yaw (right +90, left -90, none dropped); a yaw already there wins', () => {
    const u = upgradeProjectDocsV24(content(), [
      scene([
        cam,
        { id: 'spawn-0001', components: { transform: T, playerSpawn: { facing: 'right' } } },
        { id: 'spawn-0002', components: { transform: T, playerSpawn: { facing: 'left' } } },
        { id: 'spawn-0003', components: { transform: T, playerSpawn: { facing: 'none' } } },
        { id: 'spawn-0004', components: { transform: T, playerSpawn: { facing: 'left', yaw: 30 } } },
      ]),
    ]);
    expect(u.errors).toEqual([]);
    const spawns = (u.scenes[0] as { entities: Array<{ components: { playerSpawn?: unknown } }> }).entities.slice(1).map((e) => e.components.playerSpawn);
    expect(spawns).toEqual([{ yaw: 90 }, { yaw: -90 }, {}, { yaw: 30 }]);
  });

  it('the session player health fields are dropped (only the deleted session read them)', () => {
    const u = upgradeProjectDocsV24(content(), [scene([cam, { id: 'box-0001', components: { transform: T, box, health: { max: 3, start: 2, invulnerableSeconds: 1, knockback: 4, hitBounce: 5, knockbackTime: 0.2, hitEffect: 'fx' } } }])]);
    expect(u.errors).toEqual([]);
    expect((u.scenes[0] as { entities: Array<{ components: Record<string, unknown> }> }).entities[1]!.components['health']).toEqual({ max: 3, start: 2 });
  });

  it('prefab pickups are upgraded too; the whole project then validates', () => {
    const prefab = { prefabId: 'prefab-0001', displayName: 'Coin', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', components: { transform: T, box, pickup: { kind: 'coin', value: 1 } } }] };
    const u = upgradeProjectDocsV24(content({ prefabs: [prefab] }), [scene([cam])]);
    expect(u.errors).toEqual([]);
    const pf = (u.content as { prefabs: Array<{ entities: Array<{ components: Record<string, unknown> }> }> }).prefabs[0]!;
    expect(pf.entities[0]!.components['collectible']).toEqual({ counter: 'coins' });
    const v = validateProjectV4(MANIFEST, u.content, u.scenes);
    expect(v.ok, JSON.stringify(v.ok ? [] : v.errors)).toBe(true);
  });
});

describe('phase 24.8 upgrade: game data is refused by name', () => {
  it('refuses a game block, a flow, enemies, zones, camera follows and the pickup forms that were game rules', () => {
    const u = upgradeProjectDocsV24(content({ game: { configVersion: 2 }, flow: { levels: [] } }), [
      scene([
        { ...cam, components: { ...cam.components, cameraFollow: { deadZone: { x: 1, y: 1 }, smoothing: 0.2 } } },
        { id: 'box-0001', components: { transform: T, box, enemy: { speed: 1 } } },
        { id: 'box-0002', components: { transform: T, gameZone: { role: 'goal', size: [1, 1] } } },
        { id: 'box-0003', components: { transform: T, box, pickup: { kind: 'heart', value: 1 } } },
        { id: 'box-0004', components: { transform: T, box, pickup: { kind: 'coin', value: 1, respawn: 'death' } } },
        { id: 'box-0005', components: { transform: T, box, pickup: { kind: 'coin', value: 1, effect: 'fx-0001' } } },
      ]),
    ]);
    const byPath = Object.fromEntries(u.errors.map((e) => [e.path, e]));
    expect(Object.keys(byPath).sort()).toEqual([
      '/entities/0/components/cameraFollow',
      '/entities/1/components/enemy',
      '/entities/2/components/gameZone',
      '/entities/3/components/pickup',
      '/entities/4/components/pickup',
      '/entities/5/components/pickup',
      '/flow',
      '/game',
    ]);
    for (const e of u.errors) expect(e.message).toContain(REMOVED_IN_PHASE_24);
    expect(byPath['/entities/1/components/enemy']!.message).toContain('component "enemy"');
    expect(byPath['/entities/1/components/enemy']).toMatchObject({ document: 'scene', sceneId: 'scene-main', code: 'component_unknown' });
    expect(byPath['/entities/3/components/pickup']!.message).toContain('a heart healed the player');
    expect(byPath['/entities/4/components/pickup']!.message).toContain('came back when the player died');
    expect(byPath['/entities/5/components/pickup']!.message).toContain('played an effect');
    expect(byPath['/game']).toMatchObject({ document: 'content' });
  });

  it('refuses a sound on a prefab pickup (an event cue row names a scene object)', () => {
    const prefab = { prefabId: 'prefab-0001', displayName: 'Coin', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', components: { transform: T, box, pickup: { kind: 'coin', value: 1, cue: 'audio-0001' } } }] };
    const u = upgradeProjectDocsV24(content({ prefabs: [prefab] }), [scene([cam])]);
    expect(u.errors.map((e) => e.path)).toEqual(['/prefabs/0/entities/0/components/pickup']);
    expect(u.errors[0]!.message).toContain('from a prefab');
  });

  it('the validators refuse removed data in a schemaVersion 3 project the same way', () => {
    const s = validateSceneV4(scene([cam, { id: 'box-0001', components: { transform: T, box, enemy: { speed: 1 } } }, { id: 'spawn-0001', components: { transform: T, playerSpawn: { facing: 'left' } } }]));
    expect(s.ok).toBe(false);
    if (!s.ok) {
      const enemy = s.errors.find((e) => e.path === '/entities/1/components/enemy');
      expect(enemy?.message).toBe(removedComponentMessage('enemy'));
      const facing = s.errors.find((e) => e.path === '/entities/2/components/playerSpawn/facing');
      expect(facing?.message).toContain('replaced by yaw');
    }
    const c = validateContentV4({ ...content(), game: { configVersion: 2 } });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.errors.find((e) => e.path === '/game')?.message).toContain(REMOVED_IN_PHASE_24);
  });
});
