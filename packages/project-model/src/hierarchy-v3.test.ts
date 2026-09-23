/**
 * Phase 12: folders and the inherited hierarchy flags in the v3 scene model —
 * validation, canonical form, effective flags and the runtime resolve.
 */

import { describe, expect, it } from 'vitest';

import { effectiveEntityFlags, resolveSceneHierarchy } from './hierarchy-v3';
import { validateSceneV3 } from './scene-v3';
import type { SceneV3 } from './types-v3';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y = 0) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const camera = { id: 'cam', components: { transform: T, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } };

function scene(entities: unknown[]): unknown {
  return { schemaVersion: 3, sceneId: 'scene-main', revision: 1, entities: [camera, ...entities] };
}

function valid(entities: unknown[]): SceneV3 {
  const r = validateSceneV3(scene(entities));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.normalized;
}

function errorsOf(entities: unknown[]): { code: string; path: string; reason?: string }[] {
  const r = validateSceneV3(scene(entities));
  return r.ok ? [] : (r.errors as unknown as { code: string; path: string; reason?: string }[]);
}

describe('folder validation', () => {
  it('accepts a transform-less folder and canonicalizes the flags (only non-defaults kept)', () => {
    const s = valid([
      { id: 'folder-0001', name: 'Level', active: true, locked: false, static: true, components: { folder: {} } },
      { id: 'box-0001', parentId: 'folder-0001', active: false, components: { transform: at(2), box: { size: [1, 1, 1], material: { color: '#ffffff' } } } },
    ]);
    expect(s.entities[1]).toEqual({ id: 'folder-0001', name: 'Level', static: true, components: { folder: {} } });
    expect(Object.keys(s.entities[2]!)).toEqual(['id', 'parentId', 'active', 'components']);
  });

  it('refuses a folder with a transform or another component, and a folder under an object', () => {
    expect(errorsOf([{ id: 'folder-0001', components: { folder: {}, transform: T } }])[0]).toMatchObject({ code: 'component_conflict', reason: 'folder' });
    expect(errorsOf([{ id: 'folder-0001', components: { folder: { x: 1 } } }])[0]?.code).toBe('field_unexpected');
    expect(
      errorsOf([
        { id: 'group-0001', components: { transform: T } },
        { id: 'folder-0001', parentId: 'group-0001', components: { folder: {} } },
      ])[0],
    ).toMatchObject({ code: 'field_value', reason: 'folder_parent' });
    expect(errorsOf([{ id: 'box-0001', active: 'yes', components: { transform: T } }])[0]?.code).toBe('field_type');
  });

  it('zones, spawns and physics bodies may sit in folders but still not under objects', () => {
    valid([
      { id: 'folder-0001', components: { folder: {} } },
      { id: 'folder-0002', parentId: 'folder-0001', components: { folder: {} } },
      { id: 'zone-0001', parentId: 'folder-0002', components: { transform: at(1), gameZone: { role: 'hazard', size: [1, 1] } } },
      { id: 'spawn-0001', parentId: 'folder-0001', components: { transform: at(2), playerSpawn: {} } },
      { id: 'box-0001', parentId: 'folder-0002', components: { transform: at(3), box: { size: [1, 1, 1], material: { color: '#ffffff' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } },
    ]);
    const errs = errorsOf([
      { id: 'folder-0001', components: { folder: {} } },
      { id: 'group-0001', parentId: 'folder-0001', components: { transform: T } },
      { id: 'zone-0001', parentId: 'group-0001', components: { transform: at(1), gameZone: { role: 'hazard', size: [1, 1] } } },
    ]);
    expect(errs[0]).toMatchObject({ code: 'zone_transform_unsupported', reason: 'parented' });
  });

  it('refuses an inactive camera and an inactive safe spawn of an active checkpoint', () => {
    const r = validateSceneV3({ schemaVersion: 3, sceneId: 'scene-main', revision: 1, entities: [{ ...camera, active: false }] });
    expect(r.ok).toBe(false);
    const errs = errorsOf([
      { id: 'folder-0001', active: false, components: { folder: {} } },
      { id: 'spawn-0001', parentId: 'folder-0001', components: { transform: at(1), playerSpawn: {} } },
      {
        id: 'zone-0001',
        components: {
          transform: at(2),
          gameZone: { role: 'checkpoint', size: [1, 1], safeSpawnId: 'spawn-0001', activation: { emissive: '#ffffff', emissiveIntensity: 1, cueAssetId: null } },
        },
      },
    ]);
    expect(errs[0]).toMatchObject({ code: 'game_reference_missing', reason: 'safe_spawn' });
  });
});

describe('effective flags and resolve', () => {
  const s = (): SceneV3 =>
    valid([
      { id: 'folder-0001', name: 'Static stuff', static: true, locked: true, components: { folder: {} } },
      { id: 'folder-0002', parentId: 'folder-0001', components: { folder: {} } },
      { id: 'group-0001', parentId: 'folder-0002', components: { transform: at(5) } },
      { id: 'box-0001', parentId: 'group-0001', components: { transform: at(1), box: { size: [1, 1, 1], material: { color: '#ffffff' } } } },
      { id: 'folder-0003', active: false, components: { folder: {} } },
      { id: 'box-0002', parentId: 'folder-0003', components: { transform: at(9), box: { size: [1, 1, 1], material: { color: '#ffffff' } } } },
      { id: 'group-0002', active: false, components: { transform: T } },
      { id: 'box-0003', parentId: 'group-0002', components: { transform: T, box: { size: [1, 1, 1], material: { color: '#ffffff' } } } },
    ]);

  it('folders pass locked/static to their whole subtree; any inactive ancestor deactivates', () => {
    // An object's own locked/static stay on it.
    const own = effectiveEntityFlags(
      valid([
        { id: 'group-0009', locked: true, static: true, components: { transform: T } },
        { id: 'box-0009', parentId: 'group-0009', components: { transform: T, box: { size: [1, 1, 1], material: { color: '#ffffff' } } } },
      ]).entities,
    );
    expect(own.get('box-0009')).toMatchObject({ locked: false, static: false });
    const f = effectiveEntityFlags(s().entities);
    expect(f.get('group-0001')).toMatchObject({ locked: true, static: true, inheritedFrom: { locked: 'folder-0001', static: 'folder-0001' } });
    // A folder's flags reach its whole subtree, through objects.
    expect(f.get('box-0001')).toMatchObject({ active: true, locked: true, static: true, inheritedFrom: { locked: 'folder-0001' } });
    expect(f.get('box-0002')).toMatchObject({ active: false, inheritedFrom: { active: 'folder-0003' } });
    expect(f.get('box-0003')).toMatchObject({ active: false, inheritedFrom: { active: 'group-0002' } });
    expect(f.get('cam')).toMatchObject({ active: true, locked: false, static: false, inheritedFrom: {} });
  });

  it('resolve drops folders and inactive subtrees, re-hangs children and keeps order', () => {
    const r = resolveSceneHierarchy(s());
    expect(r.entities.map((e) => e.id)).toEqual(['cam', 'group-0001', 'box-0001']);
    expect(r.entities[1]).toEqual({ id: 'group-0001', static: true, components: { transform: at(5) } });
    expect(r.entities[2]).toMatchObject({ parentId: 'group-0001', static: true });
    // The resolved scene is itself a valid scene, and resolving is idempotent.
    expect(validateSceneV3(r).ok).toBe(true);
    expect(resolveSceneHierarchy(r)).toEqual(r);
  });
});

describe('tags (phase 12 b)', () => {
  it('validates the entity mask, and folders OR their mask into the whole subtree', () => {
    expect(errorsOf([{ id: 'box-0001', tags: -1, components: { transform: T } }])[0]?.code).toBe('field_value');
    expect(errorsOf([{ id: 'box-0001', tags: 2 ** 32, components: { transform: T } }])[0]?.code).toBe('field_value');
    const s = valid([
      { id: 'folder-0001', tags: 0b001, components: { folder: {} } },
      { id: 'group-0001', parentId: 'folder-0001', tags: 0b100, components: { transform: T } },
      { id: 'box-0001', parentId: 'group-0001', tags: 0, components: { transform: T, box: { size: [1, 1, 1], material: { color: '#ffffff' } } } },
      { id: 'box-0002', tags: 0b010, components: { transform: T, box: { size: [1, 1, 1], material: { color: '#ffffff' } } } },
    ]);
    // A zero mask is not stored.
    expect('tags' in s.entities[3]!).toBe(false);
    const f = effectiveEntityFlags(s.entities);
    expect(f.get('group-0001')).toMatchObject({ tags: 0b101, inheritedTags: 0b001 });
    // An object's own tags stay on it; the folder's reach through it.
    expect(f.get('box-0001')).toMatchObject({ tags: 0b001, inheritedTags: 0b001 });
    expect(f.get('box-0002')).toMatchObject({ tags: 0b010, inheritedTags: 0 });
    const r = resolveSceneHierarchy(s);
    expect(r.entities.find((e) => e.id === 'group-0001')?.tags).toBe(0b101);
    expect(r.entities.find((e) => e.id === 'box-0001')?.tags).toBe(0b001);
  });

  it('the registry: bits 0-31 once, names unique ignoring case; entity bits must be defined', async () => {
    const { validateContentV3 } = await import('./content');
    const { validateProjectV3 } = await import('./project-v3');
    const base = { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null };
    expect(validateContentV3({ ...base, tags: [{ bit: 1, name: 'b' }, { bit: 0, name: 'a' }] })).toMatchObject({ ok: true, normalized: { tags: [{ bit: 0, name: 'a' }, { bit: 1, name: 'b' }] } });
    expect('tags' in (validateContentV3({ ...base, tags: [] }) as { normalized: object }).normalized).toBe(false);
    expect(validateContentV3({ ...base, tags: [{ bit: 0, name: 'a' }, { bit: 0, name: 'b' }] }).ok).toBe(false);
    expect(validateContentV3({ ...base, tags: [{ bit: 0, name: 'Enemy' }, { bit: 1, name: 'enemy' }] }).ok).toBe(false);
    expect(validateContentV3({ ...base, tags: [{ bit: 32, name: 'a' }] }).ok).toBe(false);
    const manifest = { schemaVersion: 1, engineVersion: '0.1.0', id: 'p', name: 'P', createdAt: '2026-09-23T00:00:00Z', scenes: [{ id: 'scene-main', path: 'scenes/main.json' }] };
    const doc = scene([{ id: 'box-0001', tags: 0b10, components: { transform: T } }]);
    const refused = validateProjectV3(manifest, doc, { ...base, tags: [{ bit: 0, name: 'a' }] });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('"reason":"tag"');
    expect(validateProjectV3(manifest, doc, { ...base, tags: [{ bit: 1, name: 'b' }] }).ok).toBe(true);
  });
});
