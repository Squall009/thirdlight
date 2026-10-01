import { describe, expect, it } from 'vitest';

import { assetUsers, projectWideRoots, startDrawSet } from './missing-files';

const content = {
  assets: [
    { assetId: 'rock', kind: 'model', materials: { Stone: 'mat-stone' } },
    { assetId: 'stone-albedo', kind: 'texture' },
    { assetId: 'burnt-albedo', kind: 'texture' },
    { assetId: 'click', kind: 'audio' },
    { assetId: 'title-font', kind: 'font' },
  ],
  materials: [
    { materialId: 'mat-stone', textures: { map: 'stone-albedo' } },
    { materialId: 'mat-burnt', textures: { map: 'burnt-albedo' } },
  ],
  prefabs: [{ prefabId: 'pf-rock', entities: [{ id: 'e1', components: { model: { asset: { assetId: 'rock' } } } }] }],
  uiThemes: [{ themeId: 't', font: 'title-font' }],
  eventCues: [{ event: 'jump', sound: 'click' }],
};
const scenes = [
  { sceneId: 'day', entities: [{ id: 'a', components: { model: { asset: { assetId: 'rock' } } } }] },
  { sceneId: 'night', entities: [{ id: 'b', components: { materials: { '*': 'mat-burnt' } } }] },
];

describe('missing files: who uses an asset, what the start draws', () => {
  it('the start draws its scenes’ assets (through materials and model material maps) and the project-wide blocks’', () => {
    expect([...startDrawSet(content, scenes, ['day'])].sort()).toEqual(['click', 'rock', 'stone-albedo', 'title-font']);
    expect(startDrawSet(content, scenes, ['night']).has('burnt-albedo')).toBe(true);
    expect(startDrawSet(content, scenes, ['night']).has('rock')).toBe(false);
  });

  it('lists every scene, resource and block that reaches an asset', () => {
    const users = assetUsers(content, scenes, new Set(['stone-albedo', 'burnt-albedo', 'title-font', 'rock']));
    expect(users.get('stone-albedo')).toEqual([
      { kind: 'scene', id: 'day' },
      { kind: 'prefab', id: 'pf-rock' },
      { kind: 'material', id: 'mat-stone' },
      { kind: 'asset', id: 'rock' },
    ]);
    expect(users.get('burnt-albedo')).toEqual([
      { kind: 'scene', id: 'night' },
      { kind: 'material', id: 'mat-burnt' },
    ]);
    expect(users.get('title-font')).toEqual([{ kind: 'project', id: 'uiThemes' }]);
    // A model is not its own user.
    expect(users.get('rock')).toEqual([
      { kind: 'scene', id: 'day' },
      { kind: 'prefab', id: 'pf-rock' },
    ]);
  });

  it('the project-wide blocks take the effects in the form given', () => {
    expect(projectWideRoots({ effects: ['raw'] })[1]).toEqual(['raw']);
    expect(projectWideRoots({ effects: ['raw'] }, ['runtime'])[1]).toEqual(['runtime']);
  });
});
