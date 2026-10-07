/**
 * Opt-in (TL_PERF=1): the block extras on the level classes' area layer (100 × 100 m of corner-height hills at
 * 0.5 m rows, 10 walled rooms; `tools/perf/level.ts`), without a browser.
 *
 *   TL_PERF=1 npx vitest run tests/perf/block-walk.test.ts
 *
 * - Walking: `ctx.grid.path` across the area (corner to corner, cold and with the graph kept from an earlier query,
 *   and into a room through its door — the rooms made of edge pieces), places on the path and time; `reachable` within 20 m; the Problems checks over the whole
 *   layer (floating blocks and every place reachable from a corner region).
 * - Corner shading: meshing every chunk of the area without and with `vertexAO`, the shading pass's own time.
 * The numbers go to ~/.cache/thirdlight-perf/block-walk.jsonl and the phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, blockLayerChecks, blockTopOptions, chunkMeshAO, meshBlockChunk, shapeSource, type BlockLayerComponent, type BlockType, type EntityV3 } from '@thirdlight/project-model';

import { RuntimeGrid } from '../../packages/runtime/src/grid';
import { levelPlan } from '../../tools/perf/level';

const TYPES: BlockType[] = [
  { blockId: 'soil', name: 'Soil', variants: [{ color: '#7a6040' }], shape: 'full' },
  { blockId: 'rock', name: 'Rock', variants: [{ color: '#808080' }], shape: 'full' },
  { blockId: 'rock-wall', name: 'Rock wall', variants: [{ color: '#808080' }], shape: 'full', placement: 'edge' },
  // The rooms' door gaps: open doors (the walker passes, as a game's opened door).
  { blockId: 'rock-door', name: 'Rock door', variants: [{ color: '#604020' }], shape: 'full', placement: 'edge', blocking: false },
];
const TYPE_MAP = new Map(TYPES.map((t) => [t.blockId, t]));

function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'block-walk.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const time = (f: () => unknown, reps = 7): number => {
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    f();
    ts.push(performance.now() - t0);
  }
  return Math.round(median(ts) * 100) / 100;
};

/** The area class's layer (its component as the class writes it) built from the plan's edits. */
function area(edgeWalls: boolean): { comp: BlockLayerComponent; grid: BlockGrid; plan: ReturnType<typeof levelPlan> } {
  const plan = levelPlan('area', undefined, 0, edgeWalls);
  const comp = plan.layer.components['blockLayer'] as BlockLayerComponent;
  const grid = new BlockGrid(comp);
  const r = applyBlockEdits(grid, plan.blockEdits as never, { types: TYPE_MAP, stamps: new Map() });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return { comp, grid, plan };
}

describe.skipIf(process.env['TL_PERF'] === undefined)('block extras on the area class (opt-in)', () => {
  it('walks the area: paths, reach and the Problems checks', () => {
    for (const edgeWalls of [false, true]) {
      const { comp, grid, plan } = area(edgeWalls);
      const data = grid.toData('ground', null, grid.chunkKeys());
      const rt = new RuntimeGrid(TYPES, [], false, 45);
      rt.addLayers([{ id: 'ground', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: { ...comp, data } } } as unknown as EntityV3]);
      const api = rt.api;
      const top = (x: number, z: number): [number, number, number] => [x, api.columnTop('ground', x, z)!, z];
      // Corner to corner (about 140 m), and from outside a room to its middle (through the door in its north wall).
      const room = plan.rooms[0]!;
      const inside = top(Math.floor((room.box[0] + room.box[2]) / 2), Math.floor((room.box[1] + room.box[3]) / 2));
      const outside = top(room.box[0] + Math.floor((room.box[2] - room.box[0]) / 2), Math.max(0, room.box[1] - 3));
      // The first path reads the columns it visits (cold); later ones reuse them while the layer is unchanged (warm).
      const c0 = performance.now();
      const across = api.path('ground', top(2, 2), top(97, 97));
      const acrossColdMs = Math.round((performance.now() - c0) * 100) / 100;
      const into = api.path('ground', outside, inside);
      expect(across).not.toBeNull();
      const numbers = {
        edgeWalls,
        cells: grid.size,
        edges: grid.edgeCount,
        acrossPlaces: across?.length ?? null,
        acrossColdMs,
        acrossWarmMs: time(() => api.path('ground', top(2, 2), top(97, 97))),
        intoRoomPlaces: into?.length ?? null,
        intoRoomMs: time(() => api.path('ground', outside, inside)),
        reach20m: api.reachable('ground', top(50, 50), 20).length,
        reach20mMs: time(() => api.reachable('ground', top(50, 50), 20)),
        neighboursUs: Math.round(time(() => { for (let i = 0; i < 1000; i++) api.walkNeighbours('ground', top(40 + (i % 10), 40)); }, 5) * 1000) / 1000,
        checksMs: time(() => blockLayerChecks('ground', { ...comp, walk: { from: 'start' } }, { ...data!, regions: [{ regionId: 'start', boxes: [[0, 0, 0, 3, 32, 3]] }] }, { blockTypes: TYPES }, 45), 3),
        checks: blockLayerChecks('ground', { ...comp, walk: { from: 'start' } }, { ...data!, regions: [{ regionId: 'start', boxes: [[0, 0, 0, 3, 32, 3]] }] }, { blockTypes: TYPES }, 45).map((c) => c.message.slice(0, 160)),
      };
      record(`block-walk area: ${JSON.stringify(numbers)}`);
      // Both kinds of room have a way in: the cell walls' gap, the edge walls' open door.
      expect(into).not.toBeNull();
    }
  }, 600_000);

  it('meshes the area with corner shading', () => {
    for (const edgeWalls of [false, true]) {
      const { comp, grid } = area(edgeWalls);
      const looks = { source: (t: BlockType, v: number, fm: [number, number, number]) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2]), uv: 'world' as const, tangents: true }) };
      const tops = blockTopOptions({ ...comp, cellSize: grid.cellSize });
      const keys = grid.chunkKeys();
      const mesh: number[] = [];
      const ao: number[] = [];
      let vertices = 0;
      let shaded = 0;
      for (let rep = 0; rep < 5; rep++) {
        let m = 0;
        let a = 0;
        vertices = 0;
        shaded = 0;
        for (const k of keys) {
          const [cx, cz] = k.split(',').map(Number) as [number, number];
          const t0 = performance.now();
          const parts = meshBlockChunk(grid, cx, cz, TYPE_MAP, looks, tops);
          const t1 = performance.now();
          for (const p of parts) {
            const s = chunkMeshAO(grid, TYPE_MAP, p, 0.6);
            vertices += s.length;
            for (const v of s) if (v < 1) shaded += 1;
          }
          const t2 = performance.now();
          m += t1 - t0;
          a += t2 - t1;
        }
        mesh.push(m / keys.length);
        ao.push(a / keys.length);
      }
      const numbers = { edgeWalls, chunks: keys.length, meshMsPerChunk: Math.round(median(mesh) * 100) / 100, aoMsPerChunk: Math.round(median(ao) * 100) / 100, vertices, shadedVertices: shaded, aoBytes: vertices * 4 };
      record(`block-walk area AO: ${JSON.stringify(numbers)}`);
      expect(shaded).toBeGreaterThan(0);
    }
  }, 600_000);
});
