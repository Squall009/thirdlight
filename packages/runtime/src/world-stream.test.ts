/**
 * World streaming in the simulation: a streamed block layer's chunk
 * colliders and live blocks, and a streamed terrain's tile colliders, follow
 * their rings around the sources (the first admission whole, later ones
 * nearest first within the step's budget, leaving at once past the
 * hysteresis), edits inside a ring collide at once, and two runs fed the same
 * sources do the same at the same steps.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, type BlockLayerComponent, type BlockType, type EntityV3, type PrefabDefinition, type TerrainComponent } from '@thirdlight/project-model';

import { RuntimeGrid } from './grid';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';
import { STREAM_COLLIDER_SAMPLES_PER_STEP, STREAM_CHUNK_COST, STREAM_LIVE_SPAWNS_PER_STEP, STREAM_RECHECK_METRES } from './world-stream';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'lamp', name: 'Lamp', variants: [{ prefab: 'lamp' }], shape: 'none', live: true },
];
const PREFABS = new Map([['lamp', { prefabId: 'lamp', displayName: 'lamp', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0001', components: { transform: T, light: { type: 'point' } } }] } as never as PrefabDefinition]]);
/** 8 × 8 chunks of 1 m cells (128 m square), streamed: collision 20 m, live 10 m, hysteresis 4 m. */
const COMP: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [128, 4, 128] }, streaming: { render: 64, collision: 20, live: 10, hysteresis: 4 } };

function layer(id: string, comp: BlockLayerComponent): EntityV3 {
  const g = new BlockGrid(comp);
  applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 128, 1, 128], cell: { block: 'stone' } }, { kind: 'fill', box: [0, 1, 0, 128, 2, 128], cell: { block: 'lamp' } }] as never, { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });
  const data = g.toData(id, null, g.takeDirty().chunks);
  return { id, components: { transform: T, blockLayer: { ...comp, ...(data !== null ? { data } : {}) } } } as unknown as EntityV3;
}

function port(): PhysicsPort3D & { live: Set<string>; adds: number[] } {
  const live = new Set<string>();
  const adds: number[] = [];
  return {
    dimension: 3,
    live,
    adds,
    stageCharacterMove: () => undefined,
    step: () => ({}) as never,
    addStaticColliders: (specs: readonly StaticColliderSpec3D[]) => {
      adds.push(specs.length);
      for (const s of specs) live.add(s.entityId);
    },
    removeStaticColliders: (ids: readonly string[]) => {
      for (const id of ids) live.delete(id);
    },
    dispose: () => undefined,
  } as PhysicsPort3D & { live: Set<string>; adds: number[] };
}

const chunksOf = (p: { live: Set<string> }, id: string): string[] => [...new Set([...p.live].filter((c) => c.startsWith(`${id}#blocks:`)).map((c) => c.split(':')[1]!))].sort();

describe('world streaming in the simulation', () => {
  it('a streamed layer collides only in its ring around the sources, admits nearest first within the budget and drops past the hysteresis', () => {
    const at = [[7, 0, 7]];
    const grid = new RuntimeGrid(TYPES, [], true, 45, undefined, undefined, undefined, () => at);
    const p = port();
    grid.addLayers([layer('g', COMP)]);
    // The ring reaches the recheck distance further than asked (24 m): a source moves up to that far between looks.
    expect(STREAM_RECHECK_METRES).toBe(4);
    // Nothing before the first step boundary (no look yet); the first admission is the whole ring (the load).
    grid.flushCollision(p);
    expect(chunksOf(p, 'g')).toEqual([]);
    grid.beginStep(1);
    grid.flushCollision(p);
    // Within 24 m of (7, 7): chunks 0–1 along each axis (the chunk starting 16 m away), not chunk 2 (25 m).
    expect(chunksOf(p, 'g')).toEqual(['0,0', '0,1', '1,0', '1,1']);
    // The source moves to (48, 8): chunks behind it past 28 m (ring + hysteresis) go at once; new ones come
    // nearest first, two a step (each costs half the step's budget).
    expect(Math.floor(STREAM_COLLIDER_SAMPLES_PER_STEP / STREAM_CHUNK_COST)).toBe(2);
    at[0] = [48, 0, 8];
    grid.beginStep(2);
    grid.flushCollision(p);
    const second = chunksOf(p, 'g');
    // Chunk 0 (its far side at 16 m, 32 m away) is gone; chunks 2 (in it) and one nearest more came; 4 still waits.
    expect(second).not.toContain('0,0');
    expect(second).toContain('2,0');
    expect(grid.stream.diagnostics()!.collision.pending).toBeGreaterThan(0);
    for (let s = 3; s < 8; s++) {
      grid.beginStep(s);
      grid.flushCollision(p);
    }
    expect(chunksOf(p, 'g')).toEqual(['1,0', '1,1', '2,0', '2,1', '2,2', '3,0', '3,1', '3,2', '4,0', '4,1']);
    expect(grid.stream.diagnostics()).toMatchObject({ sources: 1, objects: 1, collision: { resident: 10, pending: 0 } });
    // A move shorter than the recheck distance does not look at the rings again.
    const rechecks = grid.stream.diagnostics()!.rechecks;
    at[0] = [48 + STREAM_RECHECK_METRES / 2, 0, 8];
    grid.beginStep(9);
    expect(grid.stream.diagnostics()!.rechecks).toBe(rechecks);
  });

  it('an edit inside the ring collides at once; one outside it does not', () => {
    const at = [[8, 0, 8]];
    const grid = new RuntimeGrid(TYPES, [], true, 45, undefined, undefined, undefined, () => at);
    const p = port();
    grid.addLayers([layer('g', { ...COMP, bounds: { min: [0, 0, 0], max: [128, 4, 128] } })]);
    grid.beginStep(1);
    grid.flushCollision(p);
    const before = p.adds.length;
    grid.api.set('g', 3, 2, 3, { block: 'stone' });
    grid.api.set('g', 100, 2, 100, { block: 'stone' });
    grid.flushCollision(p);
    expect(p.adds.length).toBe(before + 1);
    expect(chunksOf(p, 'g')).not.toContain('6,6');
  });

  it('live blocks have objects only in their ring, spawned within the per-step budget', () => {
    const at = [[1, 0, 1]];
    const grid = new RuntimeGrid(TYPES, [], false, 45, undefined, PREFABS, undefined, () => at);
    grid.addLayers([layer('g', COMP)]);
    grid.beginStep(1);
    // The live ring (10 m and the recheck's 4 round (1, 1)) holds chunk 0,0 only: 256 lamps, spawned 16 a step.
    let total = 0;
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const d = grid.takeLive((id) => seen.has(id));
      for (const e of d?.add ?? []) seen.add(e.id);
      if (d !== null) {
        expect(d.add.length).toBeLessThanOrEqual(STREAM_LIVE_SPAWNS_PER_STEP);
        total += d.add.length;
      }
      grid.beginStep(2 + s);
    }
    expect(total).toBe(256);
    expect([...seen].every((id) => /^g-(\d|1[0-5])_1_(\d|1[0-5])$/.test(id))).toBe(true);
    // Away by 64 m: they all go at the next sync (removals are not budgeted).
    at[0] = [72, 0, 72];
    grid.beginStep(100);
    const gone = grid.takeLive((id) => seen.has(id))!;
    expect(gone.remove.length).toBe(256);
  });

  it('a streamed terrain builds the tiles in its collision ring from the data the page sent, and lets data go', () => {
    const at = [[6, 0, 6]];
    const D = (n: number): string => String(n).repeat(64);
    const tiles = [];
    for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) tiles.push({ x, z, data: D((z * 4 + x) % 10) });
    // 4 × 4 tiles of 32 m (17 samples, 2 m), collision ring 20 m.
    const c: TerrainComponent = { tileSamples: 17, spacing: 2, heightRange: [0, 100], tiles: tiles.slice(0, 10), streaming: { render: 200, collision: 20, hysteresis: 4 } };
    const grid = new RuntimeGrid(TYPES, [], true, 45, undefined, undefined, undefined, () => at);
    const p = port();
    grid.addLayers([{ id: 't', components: { transform: T, terrain: c } } as unknown as EntityV3]);
    grid.addTerrainData(c.tiles.map((t) => ({ digest: t.data!, samples: 17, heights: new Uint16Array(17 * 17), holes: null })));
    grid.beginStep(1);
    grid.flushCollision(p);
    const built = (): string[] => [...new Set([...p.live].map((id) => id.split(':')[1]!))].sort();
    // Within 24 m of (6, 6): tile 0,0; the tiles starting 32 m away are 26 m off.
    expect(built()).toEqual(['0,0']);
    at[0] = [31, 0, 31];
    grid.beginStep(2);
    grid.flushCollision(p);
    grid.beginStep(3);
    grid.flushCollision(p);
    expect(built()).toEqual(['0,0', '0,1', '1,0', '1,1']);
    // The page lets go of a tile's data: its collider stays while the tile is in the ring.
    grid.addTerrainData([{ digest: D(5), dropped: true }]);
    grid.flushCollision(p);
    expect(built()).toContain('1,1');
    expect(grid.terrain.memory()!.waiting).toBe(0);
  });

  it('two runs fed the same sources build and drop the same colliders at the same steps', () => {
    const path = (s: number): number[][] => [[8 + s * 3, 0, 8 + s * 1.5]];
    const run = (): string[] => {
      let s = 0;
      const grid = new RuntimeGrid(TYPES, [], true, 45, undefined, undefined, undefined, () => path(s));
      const p = port();
      grid.addLayers([layer('g', COMP)]);
      const log: string[] = [];
      for (s = 0; s < 30; s++) {
        grid.beginStep(s + 1);
        grid.flushCollision(p);
        log.push(chunksOf(p, 'g').join(' '));
      }
      return log;
    };
    expect(run()).toEqual(run());
  });
});
