/**
 * Dropping a model asset (2026-09-24): the one createEntity a drop issues.
 */
import { describe, expect, it } from 'vitest';

import { parseAssetDrag, planModelDrop, type PieceFacts } from './placement';

const piece = (name: string, width: number, collider: [number, number][] | null = null, skinned = false): PieceFacts => ({
  name,
  bounds: { min: [0, 0, -0.5], max: [width, 1, 0.5] },
  collider,
  skinned,
});
const BOX: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

describe('planModelDrop', () => {
  it('a multi-piece file becomes one folder with every piece in a row (0.5 m gaps) and _COL colliders', () => {
    const { args } = planModelDrop({
      assetId: 'asset-kit',
      displayName: 'kit',
      pieces: [piece('rock', 1, BOX), piece('bush', 2), piece('flower', 0.5)],
      wholeCollider: null,
      position: [10, 0, 0],
      parentId: 'folder-0001',
    });
    expect(args['kind']).toBe('folder');
    expect(args['name']).toBe('kit');
    expect(args['parentId']).toBe('folder-0001');
    const children = args['children'] as { name: string; model: { piece: string }; transform: { position: number[] }; components?: unknown }[];
    expect(children.map((c) => c.model.piece)).toEqual(['rock', 'bush', 'flower']);
    expect(children.map((c) => c.transform.position[0])).toEqual([10, 11.5, 14]);
    expect(children[0]!.components).toEqual({ collider: { shape: { type: 'polygon', vertices: BOX } } });
    expect(children[1]!.components).toBeUndefined();
  });

  it('one piece becomes one model entity; a whole single-piece file keeps its collider unless it is skinned', () => {
    const one = planModelDrop({ assetId: 'a', displayName: 'kit', piece: 'rock', pieces: [piece('rock', 1, BOX), piece('bush', 2)], wholeCollider: null, position: [1, 2, 0], parentId: null }).args;
    expect(one).toEqual({ kind: 'model', name: 'rock', model: { asset: { assetId: 'a' }, piece: 'rock' }, transform: { position: [1, 2, 0] }, components: { collider: { shape: { type: 'polygon', vertices: BOX } } } });
    const prop = planModelDrop({ assetId: 'a', displayName: 'crate', pieces: [piece('crate', 1)], wholeCollider: BOX, position: [0, 0, 0], parentId: null }).args;
    expect(prop['model']).toEqual({ asset: { assetId: 'a' } });
    expect(prop['components']).toBeDefined();
    const hero = planModelDrop({ assetId: 'a', displayName: 'hero', pieces: [piece('hero_rig', 1, null, true)], wholeCollider: BOX, position: [0, 0, 0], parentId: null }).args;
    expect(hero['components']).toBeUndefined();
  });
});

describe('parseAssetDrag', () => {
  it('reads {assetId, piece?} and rejects anything else', () => {
    expect(parseAssetDrag('{"assetId":"a","piece":"rock"}')).toEqual({ assetId: 'a', piece: 'rock' });
    expect(parseAssetDrag('{"assetId":"a"}')).toEqual({ assetId: 'a' });
    expect(parseAssetDrag('{"piece":"rock"}')).toBeNull();
    expect(parseAssetDrag('nope')).toBeNull();
  });
});
