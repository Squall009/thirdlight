/**
 * The rules checked when a game starts (Play, the export), not per edit:
 * a view exists, one player controller, a player only in a start scene, a
 * kept object is one object, a kept flag under an object that is not kept,
 * a block layer naming regions or kits it does not have.
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

  it('a block layer whose cut-aways, kits or walk name a region it does not have, or a kit no block type has, is a warning', () => {
    const layer = (blockLayer: Record<string, unknown>) => ({ id: 'ground', components: { transform: T, blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] }, ...blockLayer } } });
    const withRegions = (s: SceneV4, ids: string[]): SceneV4 => ({ ...s, blocks: [{ entityId: 'ground', regions: ids.map((regionId) => ({ regionId, boxes: [[0, 0, 0, 1, 1, 1]] })) }] } as unknown as SceneV4);
    const content = { blockTypes: [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#808080' }], shape: 'full', kits: { burnt: { block: 'stone' } } }] };
    const fine = withRegions(scene('a', [shot('c1'), layer({ cutaway: { regions: [{ region: 'roof', when: 'room' }] }, kits: [{ kit: 'burnt', region: 'room' }] })]), ['roof', 'room']);
    expect(playChecks(content, [fine], ['a'])).toEqual([]);
    // The room renamed: the cut-away's when and the kit's region name it still; the layer's kit is one no type has.
    const stale = withRegions(scene('a', [shot('c1'), layer({ cutaway: { regions: [{ region: 'roof', when: 'room' }] }, kits: [{ kit: 'burnt', region: 'room' }, { kit: 'winter' }] })]), ['roof', 'hall']);
    const checks = playChecks(content, [stale], ['a']);
    expect(checks.map((c) => [c.code, c.refuse])).toEqual([['block_names_missing', false], ['block_names_missing', false]]);
    expect(checks[0]!.message).toMatch(/names a region it does not have: "room"/);
    expect(checks[1]!.message).toMatch(/kit no block type has: "winter"/);
    // A walk that starts in a region the layer does not have.
    const walk = withRegions(scene('a', [shot('c1'), layer({ walk: { from: 'spawn' } })]), ['roof']);
    expect(playChecks(content, [walk], ['a']).map((c) => c.message)).toEqual([expect.stringMatching(/names a region it does not have: "spawn".*walk check/)]);
  });
});
