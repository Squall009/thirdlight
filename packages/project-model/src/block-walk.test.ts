/**
 * Walking a block layer: places to stand, steps by the height-step, drop and
 * headroom limits, edge pieces that block (walls, closed doors) and those
 * that don't (open doors, railings that do not block, a kit's broken door),
 * paths (A*) through doors and up ramps and stairs, reach by cost, the
 * search bound; and the layer's walk settings; and the level checks built on
 * them (floating blocks, empty regions, unreachable places).
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits } from './block-grid';
import { canonicalBlockLayerComponent, validateBlockLayerComponent, type BlockLayerComponent, type BlockType } from './block-layers';
import { blockKitView } from './block-kit-view';
import { BlockWalkGraph, findWalkPath, footprintAnchors, walkReach, type WalkPlace, type WalkSettings } from './block-walk';
import { defaultWalkSettings, walkSettingsOf } from './block-walk-settings';
import { blockLayerChecks } from './block-checks';
import type { ModelErrorV2 } from './errors';

const LAYER: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [24, 8, 24] } };
const T: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#808080' }], shape: 'full' },
  { blockId: 'slab', name: 'Slab', variants: [{ color: '#909090' }], shape: 'half' },
  { blockId: 'ramp', name: 'Ramp', variants: [{ color: '#a0a0a0' }], shape: 'ramp' },
  { blockId: 'stairs', name: 'Stairs', variants: [{ color: '#b0b0b0' }], shape: 'stairs' },
  { blockId: 'grass', name: 'Grass tuft', variants: [{ color: '#20a020' }], shape: 'none' },
  { blockId: 'hut', name: 'Hut', variants: [{ color: '#a06020' }], shape: 'full', footprint: [2, 1, 2] },
  { blockId: 'wall', name: 'Wall', variants: [{ color: '#888888' }], shape: 'full', placement: 'edge' },
  { blockId: 'door', name: 'Door', variants: [{ color: '#884422' }], shape: 'full', placement: 'edge', kits: { ruined: { block: 'doorway' } } },
  { blockId: 'doorway', name: 'Broken door', variants: [{ color: '#442211' }], shape: 'none', placement: 'edge', blocking: false },
  { blockId: 'rail', name: 'Rail', variants: [{ color: '#444444' }], shape: 'half', placement: 'edge', blocking: false },
];
const TYPES = new Map(T.map((t) => [t.blockId, t]));
const ctx = { types: TYPES, stamps: new Map() };

function grid(edits: readonly unknown[], layer: BlockLayerComponent = LAYER): BlockGrid {
  const g = new BlockGrid(layer);
  const r = applyBlockEdits(g, edits as never, ctx);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  g.takeDirty();
  return g;
}

/** A 20 × 20 stone floor (row 0, tops at 1 m). */
const FLOOR = { kind: 'fill', box: [0, 0, 0, 20, 1, 20], cell: { block: 'stone' } } as const;
const settings = (o: Partial<WalkSettings> = {}): WalkSettings => ({ ...defaultWalkSettings(LAYER.cellSize, 45), ...o });
const place = (g: BlockWalkGraph, x: number, y: number, z: number): WalkPlace => {
  const p = g.placeAt(x, y, z);
  expect(p, `a place at ${x},${y},${z}`).not.toBeNull();
  return p!;
};
const path = (g: BlockWalkGraph, a: [number, number, number], b: [number, number, number]): [number, number, number][] | string => {
  const r = findWalkPath(g, place(g, ...a), place(g, ...b));
  return r.ok ? r.places.map((p) => [p.x, p.y, p.z]) : r.reason;
};

describe('the walk graph', () => {
  it('stands on block tops with headroom, names a place by its cell or the air above it, and walks a straight floor', () => {
    const g = new BlockWalkGraph(grid([FLOOR, { kind: 'fill', box: [5, 1, 5, 6, 2, 6], cell: { block: 'grass' } }, { kind: 'cells', at: [8, 2, 8], cell: { block: 'stone' } }]), TYPES, settings());
    expect(g.placesIn(0, 0).map((p) => [p.y, p.height])).toEqual([[0, 1]]);
    // A tuft (shape none) is no ground and no ceiling.
    expect(g.placesIn(5, 5).map((p) => p.y)).toEqual([0]);
    // A block a row over the floor's top leaves it a row of headroom (the default); its own top is a place too.
    expect(g.placesIn(8, 8).map((p) => p.y)).toEqual([0, 2]);
    expect(new BlockWalkGraph(g.grid, TYPES, settings({ headroom: 1.5 })).placesIn(8, 8).map((p) => p.y)).toEqual([2]);
    expect(g.placeAt(3, 1, 3)?.y).toBe(0);
    expect(g.placeAt(3, 0, 3)?.y).toBe(0);
    const r = findWalkPath(g, place(g, 0, 1, 0), place(g, 4, 1, 0));
    expect(r.ok && r.places.map((p) => p.x)).toEqual([0, 1, 2, 3, 4]);
    expect(r.ok && r.cost).toBeCloseTo(4, 9);
  });

  it('steps up and down by the step and drop limits; a ramp and stairs climb a row a ledge does not', () => {
    // A raised terrace (rows 0-1, tops at 2 m) from x = 10 on.
    const edits = [FLOOR, { kind: 'fill', box: [10, 1, 0, 20, 2, 20], cell: { block: 'stone' } }] as const;
    const ledge = new BlockWalkGraph(grid([...edits]), TYPES, settings());
    expect(path(ledge, [8, 1, 3], [12, 2, 3])).toBe('unreachable');
    // With a step of a whole row it climbs.
    expect(path(new BlockWalkGraph(grid([...edits]), TYPES, settings({ maxStep: 1 })), [8, 1, 3], [12, 2, 3])).toEqual([[8, 0, 3], [9, 0, 3], [10, 1, 3], [11, 1, 3], [12, 1, 3]]);
    // Down only: a drop of a row with maxDrop 1 and maxStep 0.5 goes down, not up.
    const drop = new BlockWalkGraph(grid([...edits]), TYPES, settings({ maxDrop: 1 }));
    expect(path(drop, [12, 2, 3], [8, 1, 3])).toEqual([[12, 1, 3], [11, 1, 3], [10, 1, 3], [9, 0, 3], [8, 0, 3]]);
    expect(path(drop, [8, 1, 3], [12, 2, 3])).toBe('unreachable');
    // A ramp at (9, 1, 3) rising toward +x (rotation 90 turns +Z to +X): its low end meets the floor, its high end the terrace.
    const ramp = new BlockWalkGraph(grid([...edits, { kind: 'cells', at: [9, 1, 3], cell: { block: 'ramp', rot: 90 } }]), TYPES, settings({ maxStep: 0.01, maxDrop: 0.01 }));
    expect(path(ramp, [8, 1, 3], [12, 2, 3])).toEqual([[8, 0, 3], [9, 1, 3], [10, 1, 3], [11, 1, 3], [12, 1, 3]]);
    // Not from the side: the ramp's side is half a row above the floor there.
    expect(ramp.steps(place(ramp, 9, 1, 4)).map((s) => [s.place.x, s.place.y, s.place.z])).not.toContainEqual([9, 1, 3]);
    // Stairs: a half-row step at the front, none at the top.
    const stairs = new BlockWalkGraph(grid([...edits, { kind: 'cells', at: [9, 1, 3], cell: { block: 'stairs', rot: 90 } }]), TYPES, settings());
    expect(path(stairs, [8, 1, 3], [12, 2, 3])).toEqual([[8, 0, 3], [9, 1, 3], [10, 1, 3], [11, 1, 3], [12, 1, 3]]);
  });

  it('needs headroom over the higher top: a low ceiling blocks the way', () => {
    // A roof over x = 5 one row above the floor's top: no place under it, and nothing crosses.
    const g = grid([FLOOR, { kind: 'fill', box: [5, 2, 0, 6, 3, 20], cell: { block: 'stone' } }]);
    expect(path(new BlockWalkGraph(g, TYPES, settings()), [3, 1, 3], [8, 1, 3])).toEqual([[3, 0, 3], [4, 0, 3], [5, 0, 3], [6, 0, 3], [7, 0, 3], [8, 0, 3]]);
    expect(path(new BlockWalkGraph(g, TYPES, settings({ headroom: 1.5 })), [3, 1, 3], [8, 1, 3])).toBe('unreachable');
  });

  it('respects edge pieces: walls block, a closed door blocks and an open one does not, a non-blocking rail does not; a kit\'s broken door lets through', () => {
    // A wall along the grid line x = 10 over the whole floor (row 1, where the walker is), a door at z = 15.
    const wallLine: number[] = [];
    for (let z = 0; z < 20; z++) if (z !== 15) wallLine.push(10, 1, z, 0);
    const base = [FLOOR, { kind: 'edges', at: wallLine, edge: { block: 'wall' } }] as const;
    const closed = grid([...base, { kind: 'edges', at: [10, 1, 15, 0], edge: { block: 'door' } }]);
    expect(path(new BlockWalkGraph(closed, TYPES, settings()), [8, 1, 3], [12, 1, 3])).toBe('unreachable');
    const open = grid([...base, { kind: 'edges', at: [10, 1, 15, 0], edge: { block: 'door', open: true } }]);
    const through = path(new BlockWalkGraph(open, TYPES, settings()), [8, 1, 3], [12, 1, 3]) as [number, number, number][];
    expect(Array.isArray(through)).toBe(true);
    // Through the door: from column 9 to 10 at z = 15.
    const i = through.findIndex((c) => c[0] === 9 && c[2] === 15);
    expect(through[i + 1]).toEqual([10, 0, 15]);
    expect(through).toHaveLength(1 + 1 + 12 + 12 + 1 + 2);
    // A rail that does not block passage.
    const rail = grid([...base, { kind: 'edges', at: [10, 1, 15, 0], edge: { block: 'rail' } }]);
    expect(Array.isArray(path(new BlockWalkGraph(rail, TYPES, settings()), [8, 1, 3], [12, 1, 3]))).toBe(true);
    // The closed door under the "ruined" kit is a doorway that blocks nothing; the stored grid keeps its door.
    const ruined = blockKitView(closed, [{ kit: 'ruined' }], TYPES);
    expect(Array.isArray(path(new BlockWalkGraph(ruined, TYPES, settings()), [8, 1, 3], [12, 1, 3]))).toBe(true);
    expect(closed.edgeAt(10, 1, 15, 0)).toEqual({ block: 'door' });
    // A wall a row up (over the walker's head room: rows 1 and up) still blocks; one under the floor's top does not.
    const high = grid([FLOOR, { kind: 'edges', at: wallLine.map((v, k) => (k % 4 === 1 ? 2 : v)), edge: { block: 'wall' } }, { kind: 'edges', at: [10, 2, 15, 0], edge: { block: 'wall' } }]);
    expect(path(new BlockWalkGraph(high, TYPES, settings({ headroom: 1.5 })), [8, 1, 3], [12, 1, 3])).toBe('unreachable');
    expect(Array.isArray(path(new BlockWalkGraph(high, TYPES, settings()), [8, 1, 3], [12, 1, 3]))).toBe(true);
    const low = grid([FLOOR, { kind: 'edges', at: wallLine.map((v, k) => (k % 4 === 1 ? 0 : v)), edge: { block: 'wall' } }]);
    expect(Array.isArray(path(new BlockWalkGraph(low, TYPES, settings()), [8, 1, 3], [12, 1, 3]))).toBe(true);
  });

  it('steps diagonally only where both ways round the corner walk, at √2 a step', () => {
    const open = new BlockWalkGraph(grid([FLOOR]), TYPES, settings({ diagonal: true }));
    const r = findWalkPath(open, place(open, 0, 1, 0), place(open, 4, 1, 4));
    expect(r.ok && r.places).toHaveLength(5);
    expect(r.ok && r.cost).toBeCloseTo(4 * Math.SQRT2, 9);
    // A wall end at the corner of (2, 2): the step from (1, 1) to (2, 2) would cut it.
    const walled = new BlockWalkGraph(grid([FLOOR, { kind: 'edges', at: [2, 1, 1, 0], edge: { block: 'wall' } }]), TYPES, settings({ diagonal: true }));
    const steps = walled.steps(place(walled, 1, 1, 1)).map((s) => [s.place.x, s.place.z]);
    expect(steps).not.toContainEqual([2, 2]);
    expect(steps).not.toContainEqual([2, 0]);
    expect(steps).toContainEqual([0, 2]);
  });

  it('walks the tops of larger blocks, and a path is the same every time', () => {
    const g = grid([FLOOR, { kind: 'cells', at: [6, 1, 6], cell: { block: 'hut' } }]);
    const graph = new BlockWalkGraph(g, TYPES, settings({ maxStep: 1, maxDrop: 1 }), { anchorOf: footprintAnchors(g, TYPES) });
    // The hut covers (6..7, 1, 6..7): its covered column's place is its own cell in the hut's top row.
    expect(graph.placesIn(7, 7).map((p) => [p.y, p.height])).toEqual([[1, 2]]);
    const a = path(graph, [4, 1, 7], [7, 2, 7]);
    expect(a).toEqual([[4, 0, 7], [5, 0, 7], [6, 1, 7], [7, 1, 7]]);
    expect(path(new BlockWalkGraph(g, TYPES, settings({ maxStep: 1, maxDrop: 1 }), { anchorOf: footprintAnchors(g, TYPES) }), [4, 1, 7], [7, 2, 7])).toEqual(a);
  });

  it('reaches places within a cost, skips places entering refuses, and stops at the search bound', () => {
    const g = new BlockWalkGraph(grid([FLOOR]), TYPES, settings());
    const start = place(g, 10, 1, 10);
    const r = walkReach(g, [start], { maxCost: 2 });
    // A diamond of radius 2: 1 + 4 + 8.
    expect(r.places).toHaveLength(13);
    expect(r.truncated).toBe(false);
    // Entering x = 11 is refused (an occupied cell): the diamond loses that side.
    const blocked = walkReach(g, [start], { maxCost: 2, enter: (p) => (p.x === 11 ? 0 : 1) });
    expect(blocked.places.some((p) => p.place.x === 11)).toBe(false);
    // A cost of 3 per metre on z = 12 makes the far cell dearer than the bound.
    const dear = walkReach(g, [start], { maxCost: 2, enter: (p) => (p.z === 12 ? 3 : 1) });
    expect(dear.places.some((p) => p.place.z === 12)).toBe(false);
    expect(walkReach(g, [start], { maxNodes: 5 })).toMatchObject({ truncated: true });
    expect(findWalkPath(g, start, place(g, 19, 1, 19), { maxNodes: 10 })).toMatchObject({ ok: false, reason: 'limit' });
  });

  it('takes its settings from a query, then the layer\'s walk, then the defaults; the walk field is checked', () => {
    const c: BlockLayerComponent = { ...LAYER, cellSize: [1, 0.5, 1], maxSlope: 30, walk: { maxStep: 0.5, diagonal: true } };
    expect(walkSettingsOf(c, 45)).toEqual({ maxStep: 0.5, maxDrop: 0.25, headroom: 0.5, maxSlope: 30, diagonal: true });
    expect(walkSettingsOf(c, 45, { maxStep: 1, diagonal: false })).toMatchObject({ maxStep: 1, diagonal: false });
    expect(walkSettingsOf(LAYER, 45)).toEqual({ maxStep: 0.5, maxDrop: 0.5, headroom: 1, maxSlope: 45, diagonal: false });
    const errors = (v: unknown): string[] => {
      const out: ModelErrorV2[] = [];
      validateBlockLayerComponent({ ...LAYER, ...(v as object) }, '', out);
      return out.map((e) => `${e.path}: ${e.message}`);
    };
    expect(errors({ walk: { from: 'spawn', maxStep: 0.5, maxDrop: 2, headroom: 1.8, field: 'walkable', diagonal: true }, vertexAO: 0.6 })).toEqual([]);
    expect(errors({ walk: { maxStep: -1 } }).join()).toContain('walk.maxStep');
    expect(errors({ walk: { from: 'a b' } }).join()).toContain('walk.from');
    expect(errors({ walk: { speed: 1 } }).join()).toContain('no field "speed"');
    expect(errors({ vertexAO: 2 }).join()).toContain('vertexAO');
    // Stored only when they say something.
    expect(canonicalBlockLayerComponent({ ...LAYER, walk: {}, vertexAO: 0 })).toEqual(LAYER);
    expect(canonicalBlockLayerComponent({ ...LAYER, walk: { diagonal: false, from: 'spawn' }, vertexAO: 0.5 })).toEqual({ ...LAYER, walk: { from: 'spawn' }, vertexAO: 0.5 });
  });
});

describe('the level checks', () => {
  const content = { blockTypes: T, cellFields: [{ key: 'walkable', type: 'bool' as const, default: true }] };

  it('find blocks that float, and none where blocks or edge pieces join them to the ground', () => {
    const data = (g: BlockGrid) => g.toData('layer', null, g.chunkKeys());
    // A floating slab over the floor, and a roof on walls made of edge pieces (joined, so standing).
    const roofWalls: number[] = [];
    for (let y = 1; y < 3; y++) for (let x = 2; x < 5; x++) roofWalls.push(x, y, 2, 1, x, y, 5, 1);
    const g = grid([FLOOR, { kind: 'fill', box: [12, 4, 12, 14, 5, 13], cell: { block: 'stone' } }, { kind: 'edges', at: roofWalls, edge: { block: 'wall' } }, { kind: 'fill', box: [2, 3, 2, 5, 4, 5], cell: { block: 'stone' } }]);
    const checks = blockLayerChecks('layer', LAYER, data(g), content, 45);
    expect(checks.map((c) => c.code)).toEqual(['block_floating']);
    expect(checks[0]!.message).toContain('2 blocks in 1 group');
    expect(checks[0]!.cells).toEqual([[12, 4, 12], [13, 4, 12]]);
    // Joined by a pillar: nothing floats.
    const joined = grid([FLOOR, { kind: 'fill', box: [12, 1, 12, 13, 5, 13], cell: { block: 'stone' } }, { kind: 'fill', box: [12, 4, 12, 14, 5, 13], cell: { block: 'stone' } }]);
    expect(blockLayerChecks('layer', LAYER, data(joined), content, 45)).toEqual([]);
    // A layer whose blocks all start above row 0 is grounded on its own lowest row.
    const raised = grid([{ kind: 'fill', box: [0, 3, 0, 4, 4, 4], cell: { block: 'stone' } }]);
    expect(blockLayerChecks('layer', LAYER, data(raised), content, 45)).toEqual([]);
  });

  it('find regions with no cell of the layer, and places not reachable from the walk\'s region', () => {
    // A walled-off yard (x 15..19, z 15..19) on the floor, a start region at the corner, a region outside the bounds.
    const yard: number[] = [];
    for (let i = 15; i < 20; i++) yard.push(15, 1, i, 0, i, 1, 15, 1);
    const g = grid([FLOOR, { kind: 'edges', at: yard, edge: { block: 'wall' } }, { kind: 'region', regionId: 'spawn', op: 'set', boxes: [[0, 1, 0, 2, 2, 2]] }, { kind: 'region', regionId: 'gone', op: 'set', boxes: [[30, 0, 30, 31, 1, 31]] }]);
    const d = g.toData('layer', null, g.chunkKeys());
    const layer = { ...LAYER, walk: { from: 'spawn' } };
    const checks = blockLayerChecks('layer', layer, d, content, 45);
    expect(checks.map((c) => c.code)).toEqual(['block_region_empty', 'block_unreachable']);
    expect(checks[0]!.message).toContain('"gone"');
    expect(checks[1]!.message).toContain('25 of 400 places');
    expect(checks[1]!.cells[0]).toEqual([15, 0, 15]);
    // A door in the yard's wall opens it.
    const doored = grid([FLOOR, { kind: 'edges', at: yard, edge: { block: 'wall' } }, { kind: 'edges', at: [15, 1, 17, 0], edge: { block: 'door', open: true } }, { kind: 'region', regionId: 'spawn', op: 'set', boxes: [[0, 1, 0, 2, 2, 2]] }]);
    expect(blockLayerChecks('layer', layer, doored.toData('layer', null, doored.chunkKeys()), content, 45)).toEqual([]);
    // Without a walk region there is no reachability check; a region with no place to stand says so.
    expect(blockLayerChecks('layer', LAYER, d, content, 45).map((c) => c.code)).toEqual(['block_region_empty']);
    const air = grid([FLOOR, { kind: 'region', regionId: 'sky', op: 'set', boxes: [[0, 5, 0, 2, 6, 2]] }]);
    expect(blockLayerChecks('layer', { ...LAYER, walk: { from: 'sky' } }, air.toData('layer', null, air.chunkKeys()), content, 45)[0]!.message).toContain('holds no place to stand');
    // The walk field: cells marked not walkable are no places (and so not unreachable either).
    const marked = grid([FLOOR, { kind: 'edges', at: yard, edge: { block: 'wall' } }, { kind: 'meta', set: { walkable: false }, box: [15, 0, 15, 20, 1, 20] }, { kind: 'region', regionId: 'spawn', op: 'set', boxes: [[0, 1, 0, 2, 2, 2]] }]);
    expect(blockLayerChecks('layer', { ...LAYER, walk: { from: 'spawn', field: 'walkable' } }, marked.toData('layer', null, marked.chunkKeys()), content, 45)).toEqual([]);
  });
});
