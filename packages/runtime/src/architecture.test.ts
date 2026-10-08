import { describe, expect, it } from 'vitest';
import type { ArchitectureComponent, EntityV3 } from '@thirdlight/project-model';

import { RuntimeArchitecture } from './architecture';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';

// A wall with a door and a floor (a neutral test style).
const ROOM: ArchitectureComponent = {
  profiles: { wall: { points: [[0.1, 0], [0.1, 3], [-0.1, 3], [-0.1, 0]], slots: ['lower_wall', 'bevel', 'upper_wall'] } },
  elements: [
    { id: 'wall', kind: 'sweep', path: { points: [[0, 0, 0], [8, 0, 0]] }, profile: 'wall', openings: [{ id: 'door', at: 4, width: 1, bottom: 0, top: 2 }] },
    { id: 'floor', kind: 'fill', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true }, shape: 'flat', slot: 'floor' },
  ],
};

const entity = (c: ArchitectureComponent, at: [number, number, number] = [10, 0, 0]): EntityV3 => ({ id: 'arch', name: 'Arch', components: { transform: { position: at, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, architecture: c } }) as unknown as EntityV3;

function port(): { port: PhysicsPort3D; added: StaticColliderSpec3D[]; removed: string[] } {
  const added: StaticColliderSpec3D[] = [];
  const removed: string[] = [];
  return { port: { addStaticColliders: (s: StaticColliderSpec3D[]) => added.push(...s), removeStaticColliders: (ids: string[]) => removed.push(...ids) } as unknown as PhysicsPort3D, added, removed };
}

describe('generated architecture in the simulation', () => {
  it('builds boxes beside and above the door and a floor mesh, at the object, with stable ids; again only when the parameters change', () => {
    const arch = new RuntimeArchitecture(true);
    const p = port();
    arch.add([entity(ROOM)]);
    arch.flush(p.port);
    const boxes = p.added.filter((s) => (s.shape as { type: string }).type === 'box');
    // Left of the door, right of it, above it (the door reaches the floor: nothing below).
    expect(boxes.map((b) => b.entityId)).toEqual(['arch#arch:wall:0', 'arch#arch:wall:1', 'arch#arch:wall:2']);
    const above = boxes.find((b) => b.position.y > 2)!;
    expect(above.position.x).toBeCloseTo(14, 6);
    expect((above.shape as { hy: number }).hy).toBeCloseTo(0.5, 6);
    expect(p.added.some((s) => (s.shape as { type: string }).type === 'mesh' && s.entityId.startsWith('arch#arch:floor'))).toBe(true);
    const n = p.added.length;
    // Realized again unchanged: nothing rebuilt.
    arch.add([entity(ROOM)]);
    arch.flush(p.port);
    expect(p.added.length).toBe(n);
    // Moved: rebuilt where it now is.
    arch.add([entity(ROOM, [0, 0, 0])]);
    arch.flush(p.port);
    expect(p.removed.length).toBe(n);
    expect(p.added.length).toBe(2 * n);
    expect(arch.remove(new Set(['arch'])).length).toBe(n);
    expect(arch.diagnostics()).toBeNull();
  });
});
