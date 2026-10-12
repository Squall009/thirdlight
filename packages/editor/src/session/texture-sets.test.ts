import { describe, expect, it } from 'vitest';

import { matchingTexture, textureRoleOf, textureSetQuery } from './texture-sets';

describe('texture sets by name', () => {
  it('splits a name into its stem and the map it names', () => {
    expect(textureRoleOf('rock_albedo')).toEqual({ stem: 'rock', role: 'albedo' });
    expect(textureRoleOf('Forest-Dirt_BaseColor.png')).toEqual({ stem: 'forest dirt', role: 'albedo' });
    expect(textureRoleOf('forest dirt base color')).toEqual({ stem: 'forest dirt', role: 'albedo' });
    expect(textureRoleOf('rock_normal_gl')).toEqual({ stem: 'rock', role: 'normals' });
    expect(textureRoleOf('rockNormal')).toEqual({ stem: 'rock', role: 'normals' });
    expect(textureRoleOf('rock_ORM')).toEqual({ stem: 'rock', role: 'orm' });
    expect(textureRoleOf('Meadow grass')).toBeNull();
    expect(textureRoleOf('albedo')).toBeNull();
  });

  it('finds the other maps of an albedo\'s set, never a near stem', () => {
    const textures = [
      { id: 'a', name: 'rocks_normal' },
      { id: 'b', name: 'rock_roughness' },
      { id: 'c', name: 'rock_normal' },
      { id: 'd', name: 'rock_orm' },
      { id: 'e', name: 'rock_albedo' },
    ];
    expect(matchingTexture('rock_albedo', 'normals', textures)).toBe('c');
    expect(matchingTexture('rock_basecolor', 'orm', textures)).toBe('d');
    expect(matchingTexture('rock_normal', 'orm', textures)).toBeNull();
    expect(matchingTexture('Meadow grass', 'normals', textures)).toBeNull();
    expect(textureSetQuery('Rock_BaseColor')).toBe('rock');
    expect(textureSetQuery('rock_normal')).toBeNull();
  });
});
