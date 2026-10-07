/**
 * The terrains' colliders as the runtime hands them to the 3D port (a
 * recording port): one heightfield per whole tile at its corner, patches for
 * a holed tile, flat tiles without data, tiles with data waiting for their
 * decoded data, one batch per flush, `collision: false` and removal.
 */
import { describe, expect, it } from 'vitest';

import type { EntityV3, TerrainComponent } from '@thirdlight/project-model';

import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';
import { TERRAIN_COLLIDER_PATCH_CELLS, TerrainColliders, terrainColliderPieces } from './terrain-collision';
import { colliderEntityOf } from './physics-query-args';

const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);

function recorder(): { port: PhysicsPort3D; adds: StaticColliderSpec3D[][]; removes: string[][] } {
  const adds: StaticColliderSpec3D[][] = [];
  const removes: string[][] = [];
  const port = {
    dimension: 3,
    stageCharacterMove: () => undefined,
    step: () => ({}) as never,
    addStaticColliders: (s: readonly StaticColliderSpec3D[]) => void adds.push([...s]),
    removeStaticColliders: (ids: readonly string[]) => void removes.push([...ids]),
    dispose: () => undefined,
  } as PhysicsPort3D;
  return { port, adds, removes };
}

const entity = (id: string, terrain: TerrainComponent, position = [0, 0, 0]): EntityV3 => ({ id, components: { transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain } }) as unknown as EntityV3;

const tileData = (digest: string, samples: number, step: number, holes: Uint8Array | null = null) => ({ digest, samples, heights: new Uint16Array(samples * samples).fill(step), holes });

describe('terrain colliders', () => {
  it('a whole tile is one heightfield at its corner; a tile without data is flat; a tile with data waits for it', () => {
    const c: TerrainComponent = { tileSamples: 17, spacing: 2, heightRange: [0, 65535], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0, data: D1 }] };
    const tc = new TerrainColliders();
    const { port, adds } = recorder();
    expect(tc.add([entity('ground', c, [100, 5, -40])])).toEqual(['ground']);
    tc.flush(port);
    // Only the flat tile: [1, 0] has not arrived.
    expect(adds.length).toBe(1);
    expect(adds[0]!.map((s) => s.entityId)).toEqual(['ground#terrain:0,0:0']);
    expect(adds[0]![0]!.position).toEqual({ x: 100, y: 5, z: -40 });
    expect(tc.memory()!.waiting).toBe(1);
    tc.addTiles([tileData(D1, 17, 7)]);
    tc.flush(port);
    expect(adds.length).toBe(2);
    const s = adds[1]![0]!;
    expect(s.entityId).toBe('ground#terrain:1,0:0');
    // Tile [1, 0] starts one tile (16 cells × 2 m) along x.
    expect(s.position).toEqual({ x: 132, y: 5, z: -40 });
    const shape = s.shape as { type: string; cellsX: number; cellX: number; heights: Float32Array };
    expect([shape.type, shape.cellsX, shape.cellX]).toEqual(['heightfield', 16, 2]);
    // heightRange [0, 65535]: a step is a metre.
    expect(shape.heights[0]).toBe(7);
    expect(tc.memory()).toMatchObject({ tiles: 1, colliders: 2, tilesWithColliders: 2, waiting: 0 });
    // Nothing changed: no batch.
    tc.flush(port);
    expect(adds.length).toBe(2);
    expect(colliderEntityOf(s.entityId)).toBe('ground');
  });

  it('a holed tile: patches, all-hole patches left out; removal returns every id; collision false makes none', () => {
    const n = 64;
    const holes = new Uint8Array((n * n) / 8);
    // The first patch (16 × 16 cells) all hole, one cell of the second.
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) holes[(z * n + x) >> 3]! |= 1 << ((z * n + x) & 7);
    holes[(0 * n + 20) >> 3]! |= 1 << ((0 * n + 20) & 7);
    const pieces = terrainColliderPieces({ samples: n + 1, heights: new Uint16Array((n + 1) ** 2), holes }, 1, [0, 1]);
    expect(TERRAIN_COLLIDER_PATCH_CELLS).toBe(16);
    // The cut patch is a mesh of 255 cells; the whole patches merged (as wide, then as deep as they go): [32, 64) × [0, 64) and [0, 32) × [16, 64).
    const mesh = pieces.filter((p) => p.shape.type === 'mesh');
    expect(mesh.length).toBe(1);
    expect((mesh[0]!.shape as { indices: Uint32Array }).indices.length).toBe(255 * 6);
    expect(pieces.filter((p) => p.shape.type === 'heightfield').map((p) => [p.x, p.z, (p.shape as { cellsX: number }).cellsX, (p.shape as { cellsZ: number }).cellsZ])).toEqual([
      [32, 0, 32, 64],
      [0, 16, 32, 48],
    ]);

    const c: TerrainComponent = { tileSamples: n + 1, spacing: 1, heightRange: [0, 1], tiles: [{ x: 0, z: 0, data: D2 }] };
    const tc = new TerrainColliders();
    const { port, adds } = recorder();
    tc.add([entity('t', c), entity('scenery', { ...c, collision: false })]);
    tc.addTiles([{ digest: D2, samples: n + 1, heights: new Uint16Array((n + 1) ** 2), holes }]);
    tc.flush(port);
    expect(adds.length).toBe(1);
    expect(adds[0]!.every((s) => s.entityId.startsWith('t#terrain:0,0:'))).toBe(true);
    expect(tc.remove(new Set(['t'])).sort()).toEqual(adds[0]!.map((s) => s.entityId).sort());
    // Its tile's data goes with it.
    expect(tc.memory()).toBeNull();
  });

  it('the collision ring: only its tiles have colliders', () => {
    const c: TerrainComponent = { tileSamples: 17, spacing: 1, heightRange: [0, 1], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }] };
    const tc = new TerrainColliders((_id, x) => x !== 1);
    const { port, adds } = recorder();
    tc.add([entity('g', c)]);
    tc.flush(port);
    expect(adds[0]!.map((s) => s.entityId)).toEqual(['g#terrain:0,0:0', 'g#terrain:2,0:0']);
  });
});
