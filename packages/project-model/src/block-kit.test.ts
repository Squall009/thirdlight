/**
 * Kit swaps: a layer seen through its kits meshes, collides and answers
 * queries as the same layout built from the swapped blocks would — checked
 * against a grid whose cells were rewritten by hand — while the stored grid
 * keeps its cells; plus the rules' validation and content checks.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits, autoVariant } from './block-grid';
import { canonicalBlockLayerComponent, canonicalBlockType, composeBlockContent, validateBlockLayerComponent, validateBlockType, type BlockLayerComponent, type BlockType } from './block-layers';
import { blockKitNames, canonicalLayerKits, kitZones, validateLayerKits } from './block-kit';
import { BlockKitView, blockKitView } from './block-kit-view';
import { collisionMeshChunk, meshBlockChunk, shapeSource } from './block-mesh';
import type { ModelErrorV2 } from './errors';

const LAYER: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [40, 8, 40] } };

const wallPieces = { pieces: { single: { variant: 0 }, end: { variant: 1 }, straight: { variant: 2 }, corner: { variant: 3 } } };
const T: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#808080' }, { color: '#909090' }], shape: 'full', kits: { burnt: { block: 'ash', variants: [1, 0] }, winter: { block: 'snow' } } },
  { blockId: 'ash', name: 'Ash', variants: [{ color: '#202020' }, { color: '#303030' }], shape: 'full' },
  { blockId: 'snow', name: 'Snow', variants: [{ color: '#f0f0f0' }], shape: 'full' },
  { blockId: 'wall', name: 'Wall', variants: [{ color: '#a00000' }, { color: '#b00000' }, { color: '#c00000' }, { color: '#d00000' }], shape: 'custom', boxes: [[0.3, 0, 0.3, 0.7, 1, 0.7]], connect: wallPieces, kits: { burnt: { block: 'ruin' } } },
  // The ruin is lower and connects its own way (its own looks, its own piece rules).
  { blockId: 'ruin', name: 'Ruin', variants: [{ color: '#00a000' }, { color: '#00b000' }, { color: '#00c000' }, { color: '#00d000' }], shape: 'custom', boxes: [[0.3, 0, 0.3, 0.7, 0.5, 0.7]], connect: { pieces: { single: { variant: 3 }, end: { variant: 2 }, straight: { variant: 1 }, corner: { variant: 0 } } } },
  { blockId: 'fence', name: 'Fence', variants: [{ color: '#c08040' }], shape: 'half', placement: 'edge', kits: { burnt: { block: 'charred' } } },
  { blockId: 'charred', name: 'Charred', variants: [{ color: '#402010' }], shape: 'none', placement: 'edge', blocking: false },
];
const TYPES = new Map(T.map((t) => [t.blockId, t]));
const ctx = { types: TYPES, stamps: new Map() };
const looks = { source: (t: BlockType, v: number, fm: [number, number, number]) => ({ key: `${t.blockId}:${v}`, source: t.shape === 'none' ? shapeSource('full', fm[0], fm[1], fm[2]) : shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes), uv: 'world' as const }) };

/** A small map: a stone floor, a wall line with a corner, a fence along an edge, a hall region over half of it. */
function map(): BlockGrid {
  const g = new BlockGrid(LAYER);
  const res = applyBlockEdits(g, [
    { kind: 'fill', box: [0, 0, 0, 20, 1, 20], cell: { block: 'stone' } },
    { kind: 'cells', at: [5, 1, 5, 6, 1, 5, 7, 1, 5, 7, 1, 6, 7, 1, 7, 15, 1, 15], cell: { block: 'wall' } },
    { kind: 'edges', at: [2, 1, 2, 0, 3, 1, 2, 0], edge: { block: 'fence' } },
    { kind: 'region', regionId: 'hall', op: 'set', boxes: [[0, 0, 0, 10, 8, 10]] },
  ], ctx);
  expect(res.ok).toBe(true);
  g.takeDirty();
  return g;
}

/** The same map with every block a kit swaps rewritten by hand (`inZone` limits it to a region). */
function rewritten(kit: string, inZone: (x: number, y: number, z: number) => boolean): BlockGrid {
  const g = map();
  const cells: [number, number, number][] = [];
  g.forEach((x, y, z) => cells.push([x, y, z]));
  const snapshot = cells.map(([x, y, z]) => [x, y, z, g.get(x, y, z)!] as const);
  for (const [x, y, z, c] of snapshot) {
    const s = c.block !== undefined ? TYPES.get(c.block)?.kits?.[kit] : undefined;
    if (s === undefined || !inZone(x, y, z)) continue;
    const from = TYPES.get(c.block!)!;
    // The look each stone shows, mapped per look.
    const own = c.variant ?? autoVariant(from, x, y, z);
    const variant = s.variants?.[own] ?? s.variant;
    g.set(x, y, z, { block: s.block, ...(c.rot !== undefined ? { rot: c.rot } : {}), ...(variant !== undefined ? { variant } : {}) });
  }
  const edges: [number, number, number, number][] = [];
  g.forEachEdge((x, y, z, axis) => edges.push([x, y, z, axis]));
  for (const [x, y, z, axis] of edges) {
    const e = g.edgeAt(x, y, z, axis)!;
    const s = TYPES.get(e.block)?.kits?.[kit];
    if (s !== undefined && (inZone(x, y, z) || inZone(axis === 0 ? x - 1 : x, y, axis === 1 ? z - 1 : z))) g.setEdge(x, y, z, axis, { block: s.block });
  }
  g.takeDirty();
  return g;
}

const meshKey = (parts: ReturnType<typeof meshBlockChunk>): string => JSON.stringify(parts.map((p) => [p.key, [...p.positions], [...p.indices]]));

describe('kit swaps', () => {
  it('a layer under a kit meshes and collides as the same layout built from the swapped blocks, its cells untouched', () => {
    const g = map();
    const before = JSON.stringify(g.toData('l', null, g.chunkKeys()));
    const view = blockKitView(g, [{ kit: 'burnt' }], TYPES);
    expect(view).toBeInstanceOf(BlockKitView);
    const by = rewritten('burnt', () => true);
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      expect(meshKey(meshBlockChunk(view, cx, cz, TYPES, looks))).toBe(meshKey(meshBlockChunk(by, cx, cz, TYPES, looks)));
      expect(JSON.stringify(collisionMeshChunk(view, cx, cz, TYPES))).toBe(JSON.stringify(collisionMeshChunk(by, cx, cz, TYPES)));
    }
    // The stored cells are as authored.
    expect(JSON.stringify(g.toData('l', null, g.chunkKeys()))).toBe(before);
    // Reads: the swapped values (connected ruins resolve their own pieces from their swapped neighbours).
    expect(view.get(5, 1, 5)?.block).toBe('ruin');
    expect(view.edgeAt(2, 1, 2, 0)?.block).toBe('charred');
    expect(g.get(5, 1, 5)?.block).toBe('wall');
  });

  it('a region\'s kit swaps only inside it (edge pieces on its outline included), over the layer\'s kit elsewhere', () => {
    const g = map();
    const hall = (x: number, y: number, z: number): boolean => x >= 0 && x < 10 && z >= 0 && z < 10 && y >= 0 && y < 8;
    const view = blockKitView(g, [{ kit: 'burnt', region: 'hall' }], TYPES);
    const by = rewritten('burnt', hall);
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) expect(meshKey(meshBlockChunk(view, cx, cz, TYPES, looks))).toBe(meshKey(meshBlockChunk(by, cx, cz, TYPES, looks)));
    expect(view.get(15, 1, 15)?.block).toBe('wall');
    // Winter over the layer, burnt in the hall: the hall's kit wins where it swaps.
    const both = blockKitView(g, [{ kit: 'burnt', region: 'hall' }, { kit: 'winter' }], TYPES);
    expect(both.get(1, 0, 1)?.block).toBe('ash');
    expect(both.get(15, 0, 15)?.block).toBe('snow');
    // The wall outside the hall: winter has no swap for walls.
    expect(both.get(15, 1, 15)?.block).toBe('wall');
  });

  it('maps looks per look, and leaves a layer without a swapping kit as the grid itself', () => {
    const g = map();
    const view = blockKitView(g, [{ kit: 'burnt' }], TYPES);
    let seen = 0;
    g.forEachInChunk('0,0', (x, y, z, i) => {
      const c = g.valueOf(i);
      if (c.block !== 'stone') return;
      seen += 1;
      expect(view.get(x, y, z)).toEqual({ block: 'ash', variant: autoVariant(TYPES.get('stone')!, x, y, z) === 0 ? 1 : 0 });
    });
    expect(seen).toBeGreaterThan(200);
    expect(blockKitView(g, undefined, TYPES)).toBe(g);
    expect(blockKitView(g, [{ kit: 'nothing-swaps' }], TYPES)).toBe(g);
    // A region the layer does not have makes no zone.
    expect(blockKitView(g, [{ kit: 'burnt', region: 'gone' }], TYPES)).toBe(g);
    // Walking the view never grows the palette after its first read (live blocks index a palette snapshot).
    const n = view.paletteCells().length;
    view.forEach(() => undefined);
    view.forEachEdge(() => undefined);
    expect(g.paletteCells().length).toBe(n);
  });

  it('validates kits on block types and layers, and checks swaps against the content', () => {
    const errs = (f: (e: ModelErrorV2[]) => void): string[] => {
      const e: ModelErrorV2[] = [];
      f(e);
      return e.map((x) => `${x.code} ${x.path}`);
    };
    expect(errs((e) => validateBlockType(T[0], '', e))).toEqual([]);
    expect(errs((e) => validateBlockType({ ...T[0]!, kits: { 'Bad Name': { block: 'ash' } } }, '', e))).toEqual(['id_invalid /kits/Bad Name']);
    expect(errs((e) => validateBlockType({ ...T[0]!, kits: { burnt: { block: 'ash', variants: [9] } } }, '', e))).toEqual(['field_value /kits/burnt/variants']);
    expect(canonicalBlockType({ ...T[0]!, kits: { winter: { block: 'snow' }, burnt: { block: 'ash', variants: [1, 0] } } }).kits).toEqual({ burnt: { block: 'ash', variants: [1, 0] }, winter: { block: 'snow' } });
    expect(canonicalBlockType({ ...T[2]!, kits: {} }).kits).toBeUndefined();
    const compose = (types: BlockType[]): string[] => errs((e) => composeBlockContent({ blockTypes: types }, e));
    expect(compose(T)).toEqual([]);
    // Another placement, another footprint, a look the target lacks, a missing target.
    expect(compose([...T.slice(1), { ...T[0]!, kits: { burnt: { block: 'charred' } } }])).toEqual([`field_value /blockTypes/${T.length - 1}/kits/burnt/block`]);
    expect(compose([...T.slice(1), { ...T[0]!, kits: { burnt: { block: 'ash' } } }, { blockId: 'big', name: 'Big', variants: [{ color: '#000000' }], shape: 'full', footprint: [2, 1, 2], kits: { burnt: { block: 'ash' } } }])).toEqual([`field_value /blockTypes/${T.length}/kits/burnt/block`]);
    expect(compose([...T.slice(1), { ...T[0]!, kits: { burnt: { block: 'snow', variant: 1 } } }])).toEqual([`field_value /blockTypes/${T.length - 1}/kits/burnt/variant`]);
    expect(compose([...T.slice(1), { ...T[0]!, kits: { burnt: { block: 'lava' } } }])).toEqual([`reference_missing /blockTypes/${T.length - 1}/kits/burnt/block`]);
    expect(blockKitNames(T)).toEqual(['burnt', 'winter']);
    // Layers: one kit for the whole layer, one per region.
    expect(errs((e) => validateLayerKits([{ kit: 'burnt' }, { kit: 'winter', region: 'hall' }], '', e))).toEqual([]);
    expect(errs((e) => validateLayerKits([{ kit: 'burnt' }, { kit: 'winter' }], '', e))).toEqual(['id_duplicate /1']);
    expect(errs((e) => validateLayerKits([{ kit: 'burnt', region: 'a' }, { kit: 'winter', region: 'a' }], '', e))).toEqual(['id_duplicate /1']);
    expect(errs((e) => validateBlockLayerComponent({ ...LAYER, kits: [{ kit: 'burnt', zone: 'x' }] }, '', e))).toEqual(['field_unexpected /kits/0/zone']);
    expect(canonicalLayerKits([{ kit: 'b', region: 'r' }, { kit: 'a' }])).toEqual([{ kit: 'a' }, { kit: 'b', region: 'r' }]);
    expect(canonicalBlockLayerComponent({ ...LAYER, kits: [] }).kits).toBeUndefined();
    expect(kitZones([{ kit: 'b', region: 'r' }, { kit: 'a' }, { kit: 'c', region: 'missing' }], new Map([['r', [[0, 0, 0, 1, 1, 1]]]]))).toEqual([{ kit: 'a', boxes: null }, { kit: 'b', boxes: [[0, 0, 0, 1, 1, 1]] }]);
  });
});
