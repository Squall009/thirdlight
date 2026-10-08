/**
 * Rule scatter's copies in the running game: found by place and address,
 * hidden, shown and removed (each change a render change, the colliders of
 * the copies that collide taken off and put back in the grid's batches), a
 * new run bringing every copy back, the terrain's blobs arriving from the
 * page, a block layer's copies from its chunks, and a ray hit naming a copy.
 */
import { describe, expect, it } from 'vitest';

import { bakeScatterCell, encodeChunkScatter, type EntityV3, type ModelColliderTable, type ScatterGround, type ScatterRule, type ScatterSurface, type TerrainComponent } from '@thirdlight/project-model';

import { RuntimeGrid, type GridRenderChange } from './grid';
import { colliderEntityOf } from './physics-query-args';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';
import { parseScatterAddress, scatterAddress, type ScatterCopyChange } from './scatter-copies';

const FLAT: ScatterSurface = {
  at(x, z) {
    return { x, y: 2, z, slope: 0, wall: false, nx: 0, ny: 1, nz: 0, cavity: () => 0, layer: () => 1 } as ScatterGround;
  },
};
const TREES: ScatterRule = { id: 'trees', asset: { assetId: 'kit', piece: 'tree' }, density: 0.04, scale: [1, 2], collide: true };
const ROCKS: ScatterRule = { id: 'rocks', asset: { assetId: 'kit', piece: 'rock' }, density: 0.02 };
/** The tree's `_COL`: a 1 m box around its trunk. */
const TABLE: ModelColliderTable = { kit: { tree: [[[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 3, -0.5], [0.5, 3, -0.5], [0.5, 3, 0.5], [-0.5, 3, 0.5]]] } };
const TILE = 64;
const D0 = 'a'.repeat(64);
const D1 = 'b'.repeat(64);

function recorder(): { port: PhysicsPort3D; added: Map<string, StaticColliderSpec3D>; batches: number } {
  const added = new Map<string, StaticColliderSpec3D>();
  const r = { port: null as unknown as PhysicsPort3D, added, batches: 0 };
  r.port = {
    dimension: 3,
    stageCharacterMove: () => undefined,
    step: () => ({}) as never,
    addStaticColliders: (s: readonly StaticColliderSpec3D[]) => {
      r.batches += 1;
      for (const x of s) {
        expect(added.has(x.entityId)).toBe(false);
        added.set(x.entityId, x);
      }
    },
    removeStaticColliders: (ids: readonly string[]) => {
      r.batches += 1;
      for (const id of ids) expect(added.delete(id)).toBe(true);
    },
    dispose: () => undefined,
  } as PhysicsPort3D;
  return r;
}

/** A terrain of two 64 m tiles (33 samples at 2 m) at x = 100, its scatter baked over flat ground. */
function terrainScene(): { entity: EntityV3; blobs: { digest: string; scatter: ReturnType<typeof bakeScatterCell>['cell'] }[] } {
  const origin = [100, 0, 0];
  const blobs = [D0, D1].map((digest, x) => ({ digest, scatter: bakeScatterCell([TREES, ROCKS], FLAT, null, [100 + x * TILE, 0, 100 + (x + 1) * TILE, TILE], null, origin).cell }));
  const terrain: TerrainComponent = { tileSamples: 33, spacing: 2, heightRange: [0, 100], tiles: [{ x: 0, z: 0, scatter: D0 }, { x: 1, z: 0, scatter: D1 }], scatter: [TREES, ROCKS] };
  return { entity: { id: 'ground', components: { transform: { position: origin, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, terrain } } as unknown as EntityV3, blobs };
}

/** The scatter copies' colliders of those the port holds (the terrain's tiles have theirs too). */
const scatterIds = (added: Map<string, unknown>): string[] => [...added.keys()].filter((k) => k.includes('#scatter:')).sort();

const copyChanges = (changes: GridRenderChange[]): ScatterCopyChange[] => changes.filter((c): c is ScatterCopyChange => 'rule' in c);

describe('scatter copies in the game', () => {
  it('a terrain\'s copies: found near a point, named by address, colliding once their blob arrives', () => {
    const { entity, blobs } = terrainScene();
    const grid = new RuntimeGrid([], [], true, 45, undefined, undefined, TABLE);
    const rec = recorder();
    grid.addLayers([entity]);
    grid.flushCollision(rec.port);
    // No blob yet: no copies, no colliders.
    expect(grid.scatter.api.near([132, 0, 32], 1000)).toEqual([]);
    expect(grid.scatter.diagnostics()).toMatchObject({ copies: 0, waiting: 2 });
    grid.addTerrainData(blobs);
    grid.flushCollision(rec.port);
    const all = grid.scatter.api.near([164, 0, 32], 1000, { limit: 1024 });
    const trees = all.filter((c) => c.rule === 'trees');
    const rocks = all.filter((c) => c.rule === 'rocks');
    expect(trees.length).toBeGreaterThan(100);
    expect(rocks.length).toBeGreaterThan(50);
    // Nearest first; every copy on the terrain's ground (y 2) within its tiles.
    for (let i = 1; i < all.length; i++) expect(Math.hypot(all[i]!.position[0] - 164, all[i]!.position[2] - 32)).toBeGreaterThanOrEqual(Math.hypot(all[i - 1]!.position[0] - 164, all[i - 1]!.position[2] - 32));
    for (const c of all) {
      expect(c.position[1]).toBe(2);
      expect(c.position[0]).toBeGreaterThanOrEqual(100);
      expect(c.position[0]).toBeLessThan(228);
      expect(parseScatterAddress(c.address)).toEqual({ entityId: 'ground', rule: c.rule, ix: c.cell[0], iz: c.cell[1] });
    }
    // Only the trees collide: one collider per tree, its id its address, at the copy, its model's box at its scale.
    expect(scatterIds(rec.added)).toEqual(trees.map((t) => t.address).sort());
    const t0 = trees[0]!;
    const spec = rec.added.get(t0.address)!;
    expect([spec.position.x, spec.position.y, spec.position.z]).toEqual([...t0.position]);
    const hull = (spec.shape as { type: string; parts: { shape: { points: number[] } }[] }).parts[0]!.shape.points;
    expect(Math.max(...hull.filter((_, i) => i % 3 === 1))).toBeCloseTo(3 * t0.scale, 4);
    expect(colliderEntityOf(t0.address)).toBe('ground');
    expect(grid.hitDetail('ground', t0.address, [0, 0, 0])).toEqual({ scatter: t0.address });
    // A smaller circle, one rule, a limit.
    const near = grid.scatter.api.near(t0.position, 10, { rule: 'trees', limit: 3 });
    expect(near[0]!.address).toBe(t0.address);
    expect(near.length).toBeLessThanOrEqual(3);
    expect(grid.scatter.api.get(t0.address)).toEqual(t0);
    expect(grid.scatter.api.get(scatterAddress('ground', 'trees', 999999, 0))).toBeNull();
    expect(grid.scatter.api.get('ground')).toBeNull();
  });

  it('hide, show and remove: render changes, colliders off and back in one batch each, a new run brings every copy back', () => {
    const { entity, blobs } = terrainScene();
    const grid = new RuntimeGrid([], [], true, 45, undefined, undefined, TABLE);
    const rec = recorder();
    grid.addLayers([entity]);
    grid.addTerrainData(blobs);
    grid.flushCollision(rec.port);
    grid.takeRenderChanges();
    const [a, b] = grid.scatter.api.near([164, 0, 32], 1000, { rule: 'trees' });
    const rock = grid.scatter.api.near([164, 0, 32], 1000, { rule: 'rocks' })[0]!;
    const before = scatterIds(rec.added).length;
    const batches = rec.batches;
    expect(grid.scatter.api.hide(a!.address)).toBe(true);
    expect(grid.scatter.api.hide(a!.address)).toBe(false);
    expect(grid.scatter.api.remove(b!.address)).toBe(true);
    expect(grid.scatter.api.hide(rock.address)).toBe(true);
    grid.flushCollision(rec.port);
    // One remove batch for both trees (the rock never collided).
    expect(rec.batches).toBe(batches + 1);
    expect(scatterIds(rec.added).length).toBe(before - 2);
    expect(rec.added.has(a!.address) || rec.added.has(b!.address)).toBe(false);
    const changes = copyChanges(grid.takeRenderChanges());
    expect(changes.map((c) => [c.rule, c.state])).toEqual([['trees', 'hidden'], ['trees', 'removed'], ['rocks', 'hidden']]);
    expect(changes[0]).toMatchObject({ entityId: 'ground', cell: a!.cell, key: a!.position[0] < 164 ? '0,0' : '1,0' });
    // Hidden copies are left out of `near` unless asked for; a removed one is gone.
    expect(grid.scatter.api.near(a!.position, 0.01).length).toBe(0);
    expect(grid.scatter.api.near(a!.position, 0.01, { hidden: true })[0]).toMatchObject({ address: a!.address, hidden: true });
    expect(grid.scatter.api.get(b!.address)).toBeNull();
    expect(grid.scatter.api.show(b!.address)).toBe(false);
    expect(grid.scatter.api.remove(b!.address)).toBe(false);
    expect(grid.scatter.api.changed()).toEqual([...[{ address: a!.address, state: 'hidden' }, { address: b!.address, state: 'removed' }, { address: rock.address, state: 'hidden' }]].sort((x, y) => (x.address < y.address ? -1 : 1)));
    // Shown again: its collider is back (one add batch).
    expect(grid.scatter.api.show(a!.address)).toBe(true);
    grid.flushCollision(rec.port);
    expect(rec.added.has(a!.address)).toBe(true);
    expect(copyChanges(grid.takeRenderChanges()).map((c) => c.state)).toEqual(['shown']);
    // A new run: everything back.
    grid.reset();
    grid.flushCollision(rec.port);
    expect(scatterIds(rec.added).length).toBe(before);
    expect(copyChanges(grid.takeRenderChanges()).map((c) => [c.rule, c.state]).sort()).toEqual([['rocks', 'shown'], ['trees', 'shown']]);
    expect(grid.scatter.api.changed()).toEqual([]);
    // Unloaded: its colliders are the caller's to remove.
    const gone = grid.removeLayers(new Set(['ground']));
    expect(gone.filter((id) => id.includes('#scatter:')).sort()).toEqual(scatterIds(rec.added));
    expect(grid.scatter.diagnostics()).toBeNull();
  });

  it('a block layer\'s copies come with its chunks; without a 3D port nothing collides', () => {
    const shrubs: ScatterRule = { id: 'shrubs', asset: { assetId: 'kit', piece: 'tree' }, density: 0.5, collide: true };
    const cell = bakeScatterCell([shrubs], FLAT, null, [0, 0, 16, 16], null, [0, 0, 0]).cell;
    const layer = { id: 'blocks', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 4, 16] }, scatter: [shrubs], data: { entityId: 'blocks', chunks: [{ cx: 0, cz: 0, palette: [], columns: [], scatter: encodeChunkScatter(cell) }] } } } } as unknown as EntityV3;
    const flat = new RuntimeGrid([], [], false, 45, undefined, undefined, TABLE);
    const rec = recorder();
    flat.addLayers([layer]);
    flat.flushCollision(rec.port);
    const copies = flat.scatter.api.near([8, 0, 8], 20, { limit: 1024 });
    expect(copies.length).toBe(cell.get('shrubs')!.cells.length / 2);
    expect(rec.added.size).toBe(0);
    expect(flat.scatter.api.hide(copies[0]!.address)).toBe(true);
    expect(copyChanges(flat.takeRenderChanges())).toEqual([{ entityId: 'blocks', key: '0,0', rule: 'shrubs', cell: copies[0]!.cell, state: 'hidden' }]);
  });
});
