/**
 * Phase 23.5 (E8): block layers — the data model, the grid and its bulk
 * edits, the ray pick, the meshing (hidden faces) and the PNG heightmap
 * decoder. Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalSceneBlocks,
  composeBlockContent,
  composeBlockLayers,
  validateBlockLayerComponent,
  validateBlockTypes,
  validateCellFields,
  type BlockLayerComponent,
  type BlockType,
  type CellField,
} from './block-layers';
import { applyBlockEdits, autoVariant, BlockGrid, effectiveCellMeta, pickCell, regionCells, subtractBox, type BlockEdit } from './block-grid';
import { collisionMeshChunk, meshBlockChunk, shapeSource } from './block-mesh';
import { decodeBase64, decodePngRgba, encodeBase64 } from './png-decode';
import { validateContentV4 } from './content';
import { validateSceneV4 } from './scene-v3';
import { resolveSceneHierarchy } from './hierarchy-v3';
import type { ModelErrorV2 } from './errors';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const LAYER: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [32, 8, 32] } };
const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'slab', name: 'Slab', variants: [{ color: '#aaaaaa' }], shape: 'half' },
  { blockId: 'ramp', name: 'Ramp', variants: [{ color: '#777777' }], shape: 'ramp', rotations: [0, 90, 180, 270] },
  { blockId: 'grass', name: 'Grass', variants: [{ color: '#55aa55', weight: 1 }, { color: '#66bb66', weight: 3 }], shape: 'full', metadata: { walkable: true } },
  { blockId: 'well', name: 'Well', variants: [{ color: '#333333' }], shape: 'full', footprint: [2, 1, 2] },
];
const FIELDS: CellField[] = [
  { key: 'walkable', type: 'bool' },
  { key: 'wet', type: 'bool', color: '#ff0000' },
  { key: 'cost', type: 'int', default: 1, min: 0, max: 9 },
  { key: 'terrain', type: 'enum', values: ['soil', 'rock'] },
];
const typeMap = new Map(TYPES.map((t) => [t.blockId, t]));
const errs = (fn: (e: ModelErrorV2[]) => void): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  fn(e);
  return e;
};
const grid = (): BlockGrid => new BlockGrid(LAYER);
const ctx = { types: typeMap, stamps: new Map() };
const edit = (g: BlockGrid, ...edits: BlockEdit[]): void => {
  const r = applyBlockEdits(g, edits, ctx);
  if (!r.ok) throw new Error(`${r.path}: ${r.message}`);
};

describe('block layers: data rules', () => {
  it('validates block types, cell fields and the component', () => {
    expect(errs((e) => validateBlockTypes(TYPES, '', e))).toEqual([]);
    expect(errs((e) => validateCellFields(FIELDS, '', e))).toEqual([]);
    expect(errs((e) => validateBlockLayerComponent(LAYER, '', e))).toEqual([]);
    expect(errs((e) => validateBlockTypes([{ ...TYPES[0], shape: 'blob' }], '', e)).map((x) => x.path)).toContain('/0/shape');
    expect(errs((e) => validateBlockTypes([{ ...TYPES[0], variants: [] }], '', e)).map((x) => x.path)).toContain('/0/variants');
    expect(errs((e) => validateBlockTypes([{ ...TYPES[0], shape: 'custom' }], '', e)).map((x) => x.path)).toContain('/0/boxes');
    expect(errs((e) => validateCellFields([{ key: 'x', type: 'enum' }], '', e)).map((x) => x.path)).toContain('/0/values');
    expect(errs((e) => validateCellFields([{ key: 'c', type: 'int', default: 12, max: 9 }], '', e)).map((x) => x.path)).toContain('/0/default');
    expect(errs((e) => validateBlockLayerComponent({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [2000, 4, 4] } }, '', e)).length).toBeGreaterThan(0);
    expect(errs((e) => validateBlockLayerComponent({ cellSize: [0, 1, 1], bounds: LAYER.bounds }, '', e)).map((x) => x.path)).toContain('/cellSize');
  });

  it('content keys are optional v4 blocks with canonical order and references checked', () => {
    const base = { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, scenes: [{ sceneId: 'main', name: 'Main' }], startScenes: ['main'] };
    const ok = validateContentV4({ ...base, blockTypes: [...TYPES].reverse(), cellFields: FIELDS });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.normalized.blockTypes!.map((t) => t.blockId)).toEqual(['grass', 'ramp', 'slab', 'stone', 'well']);
    // default metadata names a field of the schema
    const bad = validateContentV4({ ...base, blockTypes: TYPES });
    expect(bad.ok).toBe(false);
    // a model variant names a model asset
    expect(errs((e) => composeBlockContent({ blockTypes: [{ blockId: 'm', name: 'M', variants: [{ model: { assetId: 'nope' } }], shape: 'full' }] }, e))[0]?.code).toBe('asset_reference_missing');
    // absent keys keep the content exactly as before
    const plain = validateContentV4(base);
    expect(plain.ok && 'blockTypes' in plain.normalized).toBe(false);
  });

  it('scene blocks: a layer entity, cells within bounds, canonical chunks', () => {
    const g = grid();
    edit(g, { kind: 'fill', box: [0, 0, 0, 20, 1, 3], cell: { block: 'stone' } });
    const data = g.toData('layer-1', null, g.takeDirty().chunks)!;
    expect(data.chunks!.map((c) => [c.cx, c.cz])).toEqual([[0, 0], [1, 0]]);
    expect(data.chunks![0]!.columns[0]).toEqual([0, 0, 0, 1, 0]);
    const scene = { schemaVersion: 4, sceneId: 'main', revision: 1, entities: [{ id: 'layer-1', components: { transform: T, blockLayer: LAYER } }], blocks: [data] };
    const v = validateSceneV4(scene);
    expect(v.ok).toBe(true);
    // a cell outside the bounds
    const small = { ...scene, entities: [{ id: 'layer-1', components: { transform: T, blockLayer: { ...LAYER, bounds: { min: [0, 0, 0], max: [8, 8, 8] } } } }] };
    expect(validateSceneV4(small).ok).toBe(false);
    // no layer entity
    expect(validateSceneV4({ ...scene, entities: [] }).ok).toBe(false);
    // a rotated layer
    const turned = { ...scene, entities: [{ id: 'layer-1', components: { transform: { ...T, rotation: [0, 0.7071068, 0, 0.7071068] }, blockLayer: LAYER } }] };
    expect(validateSceneV4(turned).ok).toBe(false);
    // a non-canonical chunk (runs split, duplicate palette) normalizes
    const messy = { cx: 0, cz: 0, palette: [{ block: 'stone' }, { block: 'stone' }], columns: [[1, 0, 2, 1, 1, 0, 2, 0]] };
    const canon = canonicalSceneBlocks([{ entityId: 'layer-1', chunks: [messy] }])!;
    expect(canon[0]!.chunks![0]).toEqual({ cx: 0, cz: 0, palette: [{ block: 'stone' }], columns: [[1, 0, 0, 3, 0]] });
    // the runtime scene carries the cells on the component
    const resolved = resolveSceneHierarchy(v.ok ? v.normalized : (scene as never));
    expect((resolved.entities[0]!.components.blockLayer as { data?: unknown }).data).toEqual(data);
  });

  it('composition: block types, rotations, metadata fields and footprints', () => {
    const content = { blockTypes: TYPES, cellFields: FIELDS };
    const entities = [{ id: 'layer-1', components: { transform: T, blockLayer: LAYER } }];
    const check = (edits: BlockEdit[]): ModelErrorV2[] => {
      const g = grid();
      edit(g, ...edits);
      const data = g.toData('layer-1', null, g.takeDirty().chunks);
      return errs((e) => composeBlockLayers(data === null ? [] : [data], entities, content, e));
    };
    expect(check([{ kind: 'cells', at: [1, 0, 1], cell: { block: 'stone', meta: { wet: true, cost: 3 } } }])).toEqual([]);
    expect(check([{ kind: 'cells', at: [1, 0, 1], cell: { block: 'nope' } }])[0]?.code).toBe('reference_missing');
    expect(check([{ kind: 'cells', at: [1, 0, 1], cell: { meta: { cost: 'x' } } }])[0]?.code).toBe('field_value');
    expect(check([{ kind: 'cells', at: [1, 0, 1], cell: { meta: { unknown: 1 } } }])[0]?.code).toBe('reference_missing');
    expect(check([{ kind: 'cells', at: [1, 0, 1], cell: { block: 'grass', variant: 5 } }])[0]?.path).toMatch(/variant/);
    // a 2 × 2 well covering another cell
    expect(check([{ kind: 'cells', at: [4, 0, 4], cell: { block: 'well' } }])).toEqual([]);
    expect(check([{ kind: 'cells', at: [4, 0, 4], cell: { block: 'well' } }, { kind: 'cells', at: [5, 0, 5], cell: { block: 'stone' } }]).length).toBe(1);
    expect(check([{ kind: 'cells', at: [31, 0, 4], cell: { block: 'well' } }]).length).toBe(1);
  });
});

describe('block layers: the grid and bulk edits', () => {
  it('fill, cells, erase and column tops', () => {
    const g = grid();
    edit(g, { kind: 'fill', box: [0, 0, 0, 4, 3, 4], cell: { block: 'stone' } }, { kind: 'cells', at: [1, 2, 1], cell: null });
    expect(g.size).toBe(47);
    expect(g.columnTop(0, 0)).toBe(2);
    expect(g.columnTop(1, 1)).toBe(1);
    expect(g.columnTop(9, 9)).toBeNull();
    // keep mode fills only empty cells
    edit(g, { kind: 'fill', box: [0, 0, 0, 4, 4, 4], cell: { block: 'slab' }, mode: 'keep' });
    expect(g.get(1, 2, 1)?.block).toBe('slab');
    expect(g.get(0, 0, 0)?.block).toBe('stone');
    // cells outside the bounds are refused
    expect(applyBlockEdits(g, [{ kind: 'cells', at: [40, 0, 0], cell: { block: 'stone' } }], ctx).ok).toBe(false);
  });

  it('array runs, replace (metadata kept), metadata paint and flood fill', () => {
    const g = grid();
    // a 3 × 1 × 2 array: stone, stone, (-1 keeps), slab, slab, slab
    edit(g, { kind: 'array', origin: [0, 0, 0], size: [3, 1, 2], palette: [{ block: 'stone' }, { block: 'slab' }], data: [2, 0, 1, -1, 3, 1] });
    expect([g.get(0, 0, 0)?.block, g.get(1, 0, 0)?.block, g.get(2, 0, 0), g.get(0, 0, 1)?.block]).toEqual(['stone', 'stone', null, 'slab']);
    edit(g, { kind: 'meta', at: [0, 0, 0], set: { wet: true } }, { kind: 'replace', match: { block: 'stone' }, cell: { block: 'grass' } });
    expect(g.get(0, 0, 0)).toEqual({ block: 'grass', meta: { wet: true } });
    // painting an empty cell makes a metadata-only cell; null removes a field
    edit(g, { kind: 'meta', box: [5, 0, 5, 7, 1, 6], set: { walkable: false } });
    expect(g.get(6, 0, 5)).toEqual({ meta: { walkable: false } });
    edit(g, { kind: 'meta', box: [5, 0, 5, 7, 1, 6], set: { walkable: null } });
    expect(g.get(6, 0, 5)).toBeNull();
    // flood fill in the plane stops at other values
    const f = grid();
    edit(f, { kind: 'fill', box: [0, 0, 0, 6, 1, 6], cell: { block: 'stone' } }, { kind: 'fill', box: [3, 0, 0, 4, 1, 6], cell: { block: 'slab' } });
    edit(f, { kind: 'flood', at: [0, 0, 0], cell: { block: 'grass' } });
    expect(f.get(2, 0, 5)?.block).toBe('grass');
    expect(f.get(4, 0, 0)?.block).toBe('stone');
    expect(f.get(3, 0, 3)?.block).toBe('slab');
  });

  it('raise and lower columns, copy with rotation and mirror, stamps, move', () => {
    const g = grid();
    edit(g, { kind: 'cells', at: [2, 0, 2], cell: { block: 'stone' } }, { kind: 'column', at: [2, 2, 3, 3], delta: 2, cell: { block: 'slab' } });
    expect(g.columnTop(2, 2)).toBe(2);
    expect(g.columnTop(3, 3)).toBe(1);
    edit(g, { kind: 'column', at: [2, 2], delta: -2 });
    expect(g.columnTop(2, 2)).toBe(0);
    // a row of ramps turned 90°: cells rotate about the box and their rot adds
    const c = grid();
    edit(c, { kind: 'cells', at: [0, 0, 0, 1, 0, 0], cell: { block: 'ramp' } });
    edit(c, { kind: 'copy', box: [0, 0, 0, 2, 1, 1], to: [10, 0, 10], rot: 90 });
    expect(c.get(10, 0, 10)).toEqual({ block: 'ramp', rot: 90 });
    expect(c.get(10, 0, 11)).toEqual({ block: 'ramp', rot: 90 });
    edit(c, { kind: 'copy', box: [0, 0, 0, 2, 1, 1], to: [20, 0, 20], mirror: 'x' });
    expect(c.get(20, 0, 20)).toEqual({ block: 'ramp' });
    edit(c, { kind: 'cells', at: [0, 0, 0], cell: { block: 'ramp', rot: 90 } }, { kind: 'copy', box: [0, 0, 0, 1, 1, 1], to: [5, 0, 5], mirror: 'x', move: true });
    expect(c.get(5, 0, 5)).toEqual({ block: 'ramp', rot: 270 });
    expect(c.get(0, 0, 0)).toBeNull();
    // stamps come from the content
    const stamps = new Map([['hut', { stampId: 'hut', name: 'Hut', size: [2, 1, 1] as [number, number, number], palette: [{ block: 'stone' }], columns: [[0, 0, 0, 1, 0], [1, 0, 0, 1, 0]] }]]);
    const s = grid();
    const r = applyBlockEdits(s, [{ kind: 'stamp', stampId: 'hut', at: [4, 0, 4], rot: 90 }], { types: typeMap, stamps });
    expect(r.ok).toBe(true);
    expect([s.get(4, 0, 4)?.block, s.get(4, 0, 5)?.block, s.get(5, 0, 4)]).toEqual(['stone', 'stone', null]);
    expect(applyBlockEdits(s, [{ kind: 'stamp', stampId: 'nope', at: [0, 0, 0] }], { types: typeMap, stamps }).ok).toBe(false);
  });

  it('regions: set, add, subtract, rename, delete; cells listed stably', () => {
    const g = grid();
    edit(g, { kind: 'region', regionId: 'zone.a', op: 'set', boxes: [[0, 0, 0, 4, 1, 4]] });
    edit(g, { kind: 'region', regionId: 'zone.a', op: 'remove', boxes: [[1, 0, 1, 3, 1, 3]] });
    expect(regionCells(g.regions.get('zone.a')!, 100)!.length).toBe(12);
    edit(g, { kind: 'region', regionId: 'zone.a', op: 'rename', to: 'zone.b' });
    expect([...g.regions.keys()]).toEqual(['zone.b']);
    edit(g, { kind: 'region', regionId: 'zone.b', op: 'delete' });
    expect(g.regions.size).toBe(0);
    expect(subtractBox([0, 0, 0, 2, 2, 2], [0, 0, 0, 2, 2, 2])).toEqual([]);
  });

  it('effective metadata: schema defaults, then block defaults, then the cell', () => {
    expect(effectiveCellMeta({ block: 'grass', meta: { cost: 4 } }, typeMap, FIELDS)).toEqual({ walkable: true, wet: false, cost: 4, terrain: 'soil' });
    expect(effectiveCellMeta(null, typeMap, FIELDS)).toEqual({ walkable: false, wet: false, cost: 1, terrain: 'soil' });
  });

  it('the variant choice is stable and weighted', () => {
    const t = typeMap.get('grass')!;
    const counts = [0, 0];
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) counts[autoVariant(t, x, 0, z)]! += 1;
    expect(autoVariant(t, 3, 0, 7)).toBe(autoVariant(t, 3, 0, 7));
    expect(counts[1]! / 1600).toBeGreaterThan(0.6);
    expect(counts[1]! / 1600).toBeLessThan(0.9);
  });
});

describe('block layers: the ray pick (DDA)', () => {
  it('returns the first occupied cell and the face entered', () => {
    const g = grid();
    edit(g, { kind: 'fill', box: [0, 0, 0, 8, 2, 8], cell: { block: 'stone' } });
    const origin = { x: 10, y: 0, z: -5 };
    const hit = (x: number, y: number, z: number): boolean => g.get(x, y, z)?.block !== undefined;
    // straight down onto the top
    const down = pickCell(g, origin, { x: 13.5, y: 10, z: -1.5 }, { x: 0, y: -1, z: 0 }, 100, hit)!;
    expect(down.cell).toEqual([3, 1, 3]);
    expect(down.normal).toEqual([0, 1, 0]);
    expect(down.distance).toBeCloseTo(8, 9);
    // from the side, slanted
    const side = pickCell(g, origin, { x: 0, y: 1.5, z: -1 }, { x: 1, y: 0, z: 0.01 }, 100, hit)!;
    expect(side.cell[0]).toBe(0);
    expect(side.normal).toEqual([-1, 0, 0]);
    // a miss
    expect(pickCell(g, origin, { x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, 100, hit)).toBeNull();
  });
});

describe('block layers: meshing and hidden faces', () => {
  const looks = { source: (t: BlockType, _v: number, fm: [number, number, number]) => ({ key: t.blockId, source: shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes) }) };
  const tris = (g: BlockGrid): number => meshBlockChunk(g, 0, 0, typeMap, looks).reduce((n, p) => n + p.indices.length / 3, 0);

  it('a solid 4 × 4 × 4 cube draws only its outer faces', () => {
    const g = grid();
    edit(g, { kind: 'fill', box: [0, 0, 0, 4, 4, 4], cell: { block: 'stone' } });
    // 6 sides × 16 cell faces × 2 triangles
    expect(tris(g)).toBe(6 * 16 * 2);
  });

  it('half blocks side by side hide the faces between them; a full block keeps its face next to a half block', () => {
    const g = grid();
    edit(g, { kind: 'cells', at: [0, 0, 0, 1, 0, 0], cell: { block: 'slab' } });
    expect(tris(g)).toBe(2 * 12 - 4);
    const h = grid();
    edit(h, { kind: 'cells', at: [0, 0, 0], cell: { block: 'stone' } }, { kind: 'cells', at: [1, 0, 0], cell: { block: 'slab' } });
    // the slab's -X side is hidden by the solid stone; the stone's +X side stays
    expect(tris(h)).toBe(12 + 12 - 2);
  });

  it('ramps next to each other sideways hide their triangle sides', () => {
    const g = grid();
    edit(g, { kind: 'cells', at: [0, 0, 0, 1, 0, 0], cell: { block: 'ramp' } });
    const one = grid();
    edit(one, { kind: 'cells', at: [0, 0, 0], cell: { block: 'ramp' } });
    expect(tris(g)).toBe(2 * tris(one) - 2);
  });

  it('chunk borders: a neighbour in the next chunk hides the face too', () => {
    const g = grid();
    edit(g, { kind: 'cells', at: [15, 0, 0, 16, 0, 0], cell: { block: 'stone' } });
    const a = meshBlockChunk(g, 0, 0, typeMap, looks).reduce((n, p) => n + p.indices.length / 3, 0);
    expect(a).toBe(10);
  });

  it('collision: merged vertices, split to the port limits, nothing for shape none', () => {
    const g = grid();
    edit(g, { kind: 'fill', box: [0, 0, 0, 16, 1, 16], cell: { block: 'stone' } });
    const pieces = collisionMeshChunk(g, 0, 0, typeMap);
    const total = pieces.reduce((n, p) => n + p.indices.length / 3, 0);
    expect(total).toBe(2 * (256 * 2) + 4 * 16 * 2);
    for (const p of pieces) {
      expect(p.vertices.length / 3).toBeLessThanOrEqual(1024);
      expect(p.indices.length / 3).toBeLessThanOrEqual(2048);
    }
    const n = new BlockGrid(LAYER);
    const none = new Map([['ghost', { blockId: 'ghost', name: 'Ghost', variants: [{ color: '#ffffff' }], shape: 'none' as const }]]);
    applyBlockEdits(n, [{ kind: 'cells', at: [0, 0, 0], cell: { block: 'ghost' } }], { types: none, stamps: new Map() });
    expect(collisionMeshChunk(n, 0, 0, none)).toEqual([]);
  });
});

describe('block layers: PNG heightmaps', () => {
  const GREY = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAAAAACRn/EaAAAAFklEQVR42mNgcGj4z/D/PwMDQwMQAAAqMwW+RXJpuwAAAABJRU5ErkJggg==';
  const RGB = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAGUlEQVR42mP4xcoKRKxgigHCgpAMEDEIAgDxowwx7A8GPQAAAABJRU5ErkJggg==';
  const BIG = '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';

  it('decodes grey, RGB and a larger (Huffman-coded) image', () => {
    const g = decodePngRgba(decodeBase64(GREY)!);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect([g.png.width, g.png.height]).toEqual([4, 3]);
    expect([0, 1, 2, 3].map((x) => g.png.rgba[x * 4])).toEqual([0, 64, 128, 255]);
    const c = decodePngRgba(decodeBase64(RGB)!);
    expect(c.ok && [c.png.rgba[0], c.png.rgba[1]]).toEqual([250, 5]);
    const b = decodePngRgba(decodeBase64(BIG)!);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    let sum = 0;
    for (let i = 0; i < 64 * 64; i++) sum += b.png.rgba[i * 4]!;
    expect(sum).toBe(522825);
    expect(b.png.rgba[(10 * 64 + 20) * 4]).toBe(93);
    expect(decodePngRgba(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(decodeBase64(encodeBase64(new Uint8Array([1, 2, 3, 250])))).toEqual(new Uint8Array([1, 2, 3, 250]));
  });

  it('imports column heights and picks blocks by the colour map', () => {
    const g = grid();
    edit(g, {
      kind: 'heightmap',
      png: GREY,
      origin: [2, 3],
      y: 0,
      scale: 4,
      cell: { block: 'stone' },
      colors: { png: RGB, map: [{ color: '#ff0000', cell: { block: 'slab' } }, { color: '#00ff00', cell: { block: 'grass' } }] },
    });
    expect(g.columnTop(2, 3)).toBeNull();
    expect(g.columnTop(3, 3)).toBe(0);
    expect(g.columnTop(5, 3)).toBe(3);
    expect(g.get(2, 0, 4)?.block).toBe('slab');
    expect(g.get(3, 0, 4)?.block).toBe('grass');
    expect(g.columnTop(2, 5)).toBe(1);
  });
});
