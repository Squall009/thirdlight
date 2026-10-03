/**
 * The rules checked when a game starts (Play, the export), not per edit:
 * a view exists, one player controller, a player only in a start scene, a
 * kept object is one object, a kept flag under an object that is not kept.
 */
import { describe, expect, it } from 'vitest';

import { playChecks } from './play-checks';
import type { SceneV4 } from './types-v3';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (sceneId: string, entities: unknown[]): SceneV4 => ({ schemaVersion: 4, sceneId, revision: 1, entities } as unknown as SceneV4);
const shot = (id: string, extra: Record<string, unknown> = {}) => ({ id, components: { transform: T, virtualCamera: { rig: 'fixed', ...extra } } });
const player = (id: string) => ({ id, components: { transform: T, controller: {} } });
const codes = (scenes: SceneV4[], start: string[]) => playChecks({}, scenes, start).map((c) => [c.code, c.refuse]);

describe('play checks', () => {
  it('a view: an enabled camera in a start scene, else a warning', () => {
    expect(codes([scene('a', [shot('c1')])], ['a'])).toEqual([]);
    expect(codes([scene('a', [shot('c1', { enabled: false })]), scene('b', [shot('c2')])], ['a'])).toEqual([['view_missing', false]]);
    // An inactive camera is not in the game.
    expect(codes([scene('a', [{ ...shot('c1'), active: false }])], ['a'])).toEqual([['view_missing', false]]);
  });

  it('any number of player controllers in the scenes the game starts with (they share the view); a player elsewhere is a warning', () => {
    expect(codes([scene('a', [shot('c1'), player('p1'), player('p2')])], ['a'])).toEqual([]);
    expect(codes([scene('a', [shot('c1'), player('p1')]), scene('b', [player('p2')])], ['a', 'b'])).toEqual([]);
    expect(codes([scene('a', [shot('c1')]), scene('b', [player('p2'), player('p3')])], ['a'])).toEqual([['player_scene', false]]);
    expect(playChecks({}, [scene('a', [shot('c1')]), scene('b', [player('p2'), player('p3')])], ['a'])[0]!.message).toMatch(/player controllers "p2", "p3"/);
  });

  it('a kept object is one object; a kept flag under an object that is not kept has no effect', () => {
    const kept = (id: string) => ({ id, keepLoaded: true, components: { transform: T } });
    expect(codes([scene('a', [shot('c1'), kept('k1')]), scene('b', [kept('k1')])], ['a'])).toEqual([['kept_twice', true]]);
    const under = { id: 'k2', parentId: 'p0', keepLoaded: true, components: { transform: T } };
    expect(codes([scene('a', [shot('c1'), { id: 'p0', components: { transform: T } }, under])], ['a'])).toEqual([['kept_ignored', false]]);
    // In a folder it is kept; under a kept object too.
    const folder = { id: 'f0', components: { folder: {} } };
    expect(codes([scene('a', [shot('c1'), folder, { ...under, parentId: 'f0' }])], ['a'])).toEqual([]);
    expect(codes([scene('a', [shot('c1'), kept('p0'), under])], ['a'])).toEqual([]);
  });
});
