/**
 * The schema 8 step that retires the project-wide physics dimension
 * (`upgradeToPlanes`) and the Problems lines of its notes: a 3D project only
 * loses the setting; a 2D project's scenes get the Z plane at 0, its 2D
 * collider shapes their 3D forms, its controllers the arcade profile, its
 * prefabs' bodies the plane of their own, and every converted item a note
 * (grouped into one line per kind, the field to check before the names).
 */
import { describe, expect, it } from 'vitest';

import { migrated2DProblemLines, upgradeToPlanes } from './upgrade-planes';
import { validateSceneV4 } from './scene-v3';

type Any = any;
const T = (p: number[] = [0, 0, 0], rotation: number[] = [0, 0, 0, 1]): Any => ({ position: p, rotation, scale: [1, 1, 1] });
const ent = (id: string, components: Record<string, unknown>, rotation?: number[]): Any => ({ id, components: { transform: T([0, 0, 0], rotation), ...components } });
const scene = (sceneId: string, entities: Any[]): Any => ({ schemaVersion: 4, sceneId, revision: 1, entities });
const TURNED = [0, 0, Math.sin(0.2), Math.cos(0.2)];

const LEVEL = scene('scene-main', [
  ent('floor-1', { collider: { shape: { type: 'box', hx: 10, hy: 0.5 } } }),
  ent('floor-2', { collider: { shape: { type: 'box', hx: 4, hy: 0.5 } } }),
  ent('ramp-1', { collider: { shape: { type: 'polygon', vertices: [[0, 0], [4, 0], [4, 2]] } } }),
  ent('ell-1', { collider: { shape: { type: 'compound', shapes: [{ type: 'polygon', vertices: [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]] }] } } }),
  ent('shelf-1', { collider: { shape: { type: 'box', hx: 2, hy: 0.1 }, oneWay: true } }),
  ent('wall-3d', { collider: { shape: { type: 'box', hx: 1, hy: 1, hz: 1 } } }),
  ent('player-1', { controller: { capsule: { radius: 0.182, height: 1.013, offset: [0, 0] }, coyoteTime: 0.08 } }),
  ent('check-1', { trigger: { size: [1.2, 2.4], signal: 'reached' } }, TURNED),
  ent('blocks-1', { blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 4, 2] }, planeZ: -0.5 } }),
]);
const CONTENT: Any = {
  settings: { gravity_y: -19.62, run_speed: 6.75 },
  prefabs: [{ prefabId: 'crate', entities: [{ localId: 'root', components: { transform: T(), collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } }] }],
};

describe('upgradeToPlanes', () => {
  it('a 3D project only loses the setting (a note says so); one without it is left as it is', () => {
    const scenes = [scene('scene-main', [ent('a', { collider: { shape: { type: 'box', hx: 1, hy: 1 } } })])];
    const r = upgradeToPlanes({ settings: { physics_dimension: 3, run_speed: 4 } }, scenes);
    expect(r.changed).toBe(true);
    expect((r.content as Any).settings).toEqual({ run_speed: 4 });
    expect(r.scenes[0]).toBe(scenes[0]);
    expect(r.notes).toEqual([expect.stringMatching(/^the project setting physics_dimension \(3D\) was retired/)]);
  });

  it('a 2D project: the Z plane, 3D shapes, the arcade profile, the plane on prefab bodies, every conversion noted', () => {
    const r = upgradeToPlanes({ ...CONTENT, settings: { ...CONTENT.settings, physics_dimension: 2 } }, [LEVEL]);
    expect(r.changed).toBe(true);
    expect((r.content as Any).settings).toEqual(CONTENT.settings);
    const sc = r.scenes[0] as Any;
    expect(sc.defaultPlane).toEqual({ axis: 'z', origin: 0 });
    const by = new Map((sc.entities as Any[]).map((e) => [e.id, e.components]));
    expect(by.get('floor-1').collider).toEqual({ shape: { type: 'box', hx: 10, hy: 0.5, hz: 0.5 } });
    expect(by.get('ramp-1').collider.shape).toMatchObject({ type: 'convex' });
    expect(by.get('ell-1').collider.shape.type).toBe('compound');
    expect(by.get('ell-1').collider.shape.shapes.length).toBeGreaterThan(1);
    expect(by.get('shelf-1').collider).toMatchObject({ oneWay: true, shape: { hz: 0.5 } });
    expect(by.get('wall-3d')).toBe(LEVEL.entities[5].components);
    expect(by.get('player-1').controller).toMatchObject({ profile: 'arcade', coyoteTime: 0.08 });
    expect(by.get('player-1').controller.plane).toBeUndefined();
    // Gameplay blocks keep their data.
    expect(by.get('check-1').trigger).toEqual({ size: [1.2, 2.4], signal: 'reached' });
    expect(sc.migratedFrom2D).toEqual({
      plane: true,
      objects: {
        'floor-1': ['collider:box'],
        'floor-2': ['collider:box'],
        'ramp-1': ['collider:prism'],
        'ell-1': ['collider:prisms'],
        'shelf-1': ['collider:box', 'collider:one-way'],
        'player-1': ['controller:arcade'],
        'check-1': ['trigger:area-depth', 'trigger:capsule-test', 'trigger:turned-area'],
        'blocks-1': ['blockLayer:plane-cut'],
      },
    });
    // The scene validates as it is written back (the canonical form keeps the plane and the notes).
    const v = validateSceneV4(sc);
    expect(v.ok, JSON.stringify(!v.ok && v.errors.slice(0, 3))).toBe(true);
    // A prefab is in no scene: its body names the plane itself.
    expect((r.content as Any).prefabs[0].entities[0].components.collider).toEqual({ shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, plane: { axis: 'z', origin: 0 } });
    expect(r.notes[0]).toMatch(/^a 2D project \(physics_dimension retired\) moved to the one 3D physics backend: 1 scene got a default plane/);
    expect(r.notes[1]).toBe('2D box colliders became 3D boxes 1 m deep: 1 prefab part — check `collider.shape.hz` (half the depth): crate/root');
  });

  it("a linked copy's collider and controller overrides take their 3D form too", () => {
    const copy = ent('copy-1', { prefab: { prefabId: 'crate', overrides: [{ part: 'root', path: 'components/collider/shape', value: { type: 'box', hx: 2, hy: 1 } }, { part: 'root', path: 'components/box/size', value: [1, 1, 1] }] } });
    const r = upgradeToPlanes(CONTENT, [scene('scene-main', [copy])]);
    const link = (r.scenes[0] as Any).entities[0].components.prefab;
    expect(link.overrides).toEqual([{ part: 'root', path: 'components/collider/shape', value: { type: 'box', hx: 2, hy: 1, hz: 0.5 } }, copy.components.prefab.overrides[1]]);
    expect(r.notes.some((n) => n.startsWith('1 override of linked prefab copies'))).toBe(true);
  });

  it('a scene that has a default plane keeps it; running on its own output converts nothing more', () => {
    const own = { ...scene('scene-x', [ent('a', { collider: { shape: { type: 'box', hx: 1, hy: 1 } } })]), defaultPlane: { axis: 'x', origin: 3 } };
    const r = upgradeToPlanes(CONTENT, [own]);
    expect((r.scenes[0] as Any).defaultPlane).toEqual({ axis: 'x', origin: 3 });
    expect((r.scenes[0] as Any).migratedFrom2D).toEqual({ objects: { a: ['collider:box'] } });
    const again = upgradeToPlanes(r.content, r.scenes);
    const sc = again.scenes[0] as Any;
    expect(sc.entities).toEqual((r.scenes[0] as Any).entities);
  });
});

describe('the Problems lines of the notes', () => {
  it('one line per kind across scenes, with the count, the field to check, then the objects and their scenes', () => {
    const r = upgradeToPlanes(CONTENT, [LEVEL, scene('scene-2', [ent('floor-9', { collider: { shape: { type: 'box', hx: 1, hy: 1 } } })])]);
    const lines = migrated2DProblemLines(r.scenes);
    expect(lines[0]).toBe("2 scenes of a former 2D project (physics_dimension retired) got a default plane, the Z axis at 0 — check the scene's `defaultPlane`: scene-main, scene-2");
    expect(lines[1]).toBe('2D box colliders became 3D boxes 1 m deep: 4 objects — check `collider.shape.hz` (half the depth): floor-1 (scene-main), floor-2 (scene-main), shelf-1 (scene-main), floor-9 (scene-2)');
    expect(lines.filter((l) => l.includes('arcade'))).toEqual(['controllers took the arcade movement profile (the 2D controller\'s behaviour on the 3D controller): 1 object — check `controller.profile`: player-1 (scene-main)']);
    expect(lines.some((l) => l.includes('`blockLayer.planeZ`'))).toBe(true);
    // A large project gets a short line: five names and how many more.
    const many = Array.from({ length: 40 }, (_, i) => ent(`floor-${100 + i}`, { collider: { shape: { type: 'box', hx: 1, hy: 1 } } }));
    const big = migrated2DProblemLines(upgradeToPlanes(CONTENT, [scene('scene-big', many)]).scenes);
    expect(big[1]).toMatch(/: 40 objects — .* floor-104 \(scene-big\) and 35 more$/);
    expect(migrated2DProblemLines([LEVEL])).toEqual([]);
  });
});
