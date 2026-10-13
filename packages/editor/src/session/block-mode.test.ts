import { describe, expect, it } from 'vitest';
import type { BlockLayerComponent, BlockType, MaterialDef } from '@thirdlight/project-model';
import { BlockGrid, applyBlockEdits, strokeCoverage } from '@thirdlight/runtime';

import { paintEdit } from './block-brush';
import { BLOCK_DEFAULT_BRUSH, BLOCK_MODES, BLOCK_WET_CHANNEL, blockDab, blockDabStep, blockPaintChannels, blockToolUses } from './block-mode';
import { boundsGrown, isCutAway, themeOf, withBounds, withCutaway, withRegionFollowed, withTheme as withLayerTheme } from './block-layer-edits';
import { connectPiecesOf, duplicateBlockType, newBlockType, withBoxValue, withConnectPiece, withConnectWith, withLook, withLookAdded, withMetadata, withoutLook, withPlacement, withRotations, withShape, withTheme } from './block-type-edits';
import { RESERVED_TOOL_KEYS } from './edit-keys';
import { layeredMaterial } from './material-graph';
import { paletteLayers, withSlotTexture } from './layer-palette';

const STONE: BlockType = { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' };

describe('the block editor\'s modes and brushes', () => {
  it('every mode names its tools; letter keys are unique in a mode and never the shared map\'s C or F', () => {
    expect(BLOCK_MODES.map((m) => m.label)).toEqual(['Build', 'Shape', 'Paint', 'Regions', 'Rooms & buildings', 'Rules']);
    expect(BLOCK_MODES[0]!.tiles.map((t) => t.label)).toEqual(['Single', 'Line', 'Rect', 'Box', 'Flood', 'Column', 'Erase', 'Pick', 'Replace', 'Stamp', 'Paste', 'Select']);
    for (const m of BLOCK_MODES) {
      const keys = m.tiles.map((t) => t.key).filter((k) => k !== undefined);
      expect(new Set(keys).size, m.id).toBe(keys.length);
      // X is the erase tiles' (it switches to them, as the shared map's X does); C and F stay the shared map's.
      for (const k of keys) expect(RESERVED_TOOL_KEYS.has(`Key${k!}`) && k !== 'X', `${m.id} ${k}`).toBe(false);
    }
  });

  it('a dab in cells from the shared settings: half the size across, a height step × strength in rows; spacing a share of the size', () => {
    const b = { ...BLOCK_DEFAULT_BRUSH, size: 6, strength: 0.5, heightStep: 0.5, spacing: 0.125 };
    expect(blockDab('paint', b, [1, 1, 1])).toEqual({ radius: 3, strength: 0.5 });
    expect(blockDab('paint', b, [2, 0.5, 2])).toEqual({ radius: 1.5, strength: 0.5 });
    expect(blockDab('height', b, [1, 0.5, 1])).toEqual({ radius: 3, strength: 0.5 });
    expect(blockDab('height', { ...b, strength: 0.001 }, [1, 1, 1]).strength).toBe(1 / 64);
    expect(blockDab('smooth', { ...b, size: 1000 }, [1, 1, 1]).radius).toBe(32);
    expect(blockDabStep(b, [1, 1, 1])).toBe(0.75);
    expect(blockDabStep({ size: 0.5, spacing: 0.02 }, [1, 1, 1])).toBe(0.25);
    expect(blockToolUses('paint')).toEqual(['size', 'strength', 'opacity', 'falloff', 'spacing', 'invert', 'mask']);
    expect(blockToolUses('single')).toEqual([]);
  });

  it('a paint stroke previewed dab by dab with one coverage map holds its opacity as the command with every dab does', () => {
    const layer: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 4, 16] } };
    const types = new Map([['stone', STONE]]);
    const base = new BlockGrid(layer);
    applyBlockEdits(base, [{ kind: 'fill', box: [0, 0, 0, 16, 1, 16], cell: { block: 'stone' } }], { types, stamps: new Map() });
    const dabs = [4, 5, 6, 7].map((x) => paintEdit([x, 8], { radius: 3, strength: 0.6, falloff: 'smooth', channel: 2 }, false, 'tops', 0, { opacity: 0.5 }));
    const copy = (): BlockGrid => BlockGrid.from(layer, base.toData('l', null, base.chunkKeys()));
    const preview = copy();
    const coverages = new Map<string, ReturnType<typeof strokeCoverage>>();
    for (const d of dabs) applyBlockEdits(preview, [d], { types, stamps: new Map(), coverages });
    const stored = copy();
    applyBlockEdits(stored, dabs, { types, stamps: new Map() });
    expect(JSON.stringify(preview.chunkKeys().map((k) => preview.encodeChunk(k)))).toBe(JSON.stringify(stored.chunkKeys().map((k) => stored.encodeChunk(k))));
    // Without the shared map each dab would start its own ceiling: the preview would paint past the opacity.
    const apart = copy();
    for (const d of dabs) applyBlockEdits(apart, [d], { types, stamps: new Map() });
    expect(JSON.stringify(apart.chunkKeys().map((k) => apart.encodeChunk(k)))).not.toBe(JSON.stringify(stored.chunkKeys().map((k) => stored.encodeChunk(k))));
  });

  it('the paint palette: a layered surface\'s layers as Base, 2, 3, 4 by name and picture, then Wet; anything else reads no paint', () => {
    const layered = withSlotTexture(withSlotTexture(layeredMaterial('m-l', 'Ground'), 0, 'cobbles'), 1, 'grass');
    const ch = blockPaintChannels(layered, [layered], paletteLayers(layered, (id) => ({ cobbles: 'Cobbles', grass: 'Grass' })[id], null));
    expect(ch.reads).toBe(true);
    expect(ch.tiles.map((t) => [t.index, t.name, t.badge ?? null, t.texture])).toEqual([
      [0, 'Cobbles', 'B', 'cobbles'],
      [1, 'Grass', null, 'grass'],
      [2, 'Layer 3', null, null],
      [3, 'Layer 4', null, null],
      [BLOCK_WET_CHANNEL, 'Wet', 'W', null],
    ]);
    const plain: MaterialDef = { materialId: 'm-p', name: 'Plain', shader: 'standard', params: {}, textures: {} };
    expect(blockPaintChannels(plain, [plain]).reads).toBe(false);
    expect(blockPaintChannels(null, []).reads).toBe(false);
    expect(blockPaintChannels(null, []).tiles.map((t) => t.name)).toEqual(['Base', 'Layer 2', 'Layer 3', 'Layer 4', 'Wet']);
  });
});

describe('the block type editor\'s edits', () => {
  it('new, duplicated and renamed types get free ids; looks are added up to the limit, changed, and taken out with the pieces that name them', () => {
    const a = newBlockType([STONE]);
    expect(a.blockId).toBe('block-2');
    expect(a.variants[0]!.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(newBlockType([STONE], { model: { assetId: 'door' } }, 'Stone').blockId).toBe('stone-2');
    expect(duplicateBlockType(STONE, [STONE])).toMatchObject({ blockId: 'stone-copy', name: 'Stone copy' });
    let t = withLookAdded(STONE, { model: { assetId: 'm', piece: 'p' }, weight: 2 })!;
    expect(t.variants).toHaveLength(2);
    t = withLook(t, 1, { weight: undefined, uv: 'world' });
    expect(t.variants[1]).toEqual({ model: { assetId: 'm', piece: 'p' }, uv: 'world' });
    t = withConnectPiece(withConnectPiece(t, 'end', 1), 'straight', 0, 90);
    const out = withoutLook(t, 0);
    expect(out.variants).toEqual([{ model: { assetId: 'm', piece: 'p' }, uv: 'world' }]);
    expect(out.connect?.pieces).toEqual({ end: { variant: 0 } });
    expect(withoutLook(STONE, 0)).toBe(STONE);
    let full: BlockType = STONE;
    for (let i = 0; i < 7; i++) full = withLookAdded(full, { color: '#000000' })!;
    expect(withLookAdded(full, { color: '#000000' })).toBeNull();
  });

  it('shape, boxes, turns, placement, connections, themes and metadata are stored only when they say something', () => {
    const custom = withShape(STONE, 'custom');
    expect(custom.boxes).toEqual([[0, 0, 0, 1, 1, 1]]);
    expect(withBoxValue(custom, 0, 4, 0.5).boxes).toEqual([[0, 0, 0, 1, 0.5, 1]]);
    // A min pushed onto its max keeps the box (it stops just under the max).
    expect(withBoxValue(custom, 0, 1, 1).boxes![0]).toEqual([0, 0.99, 0, 1, 1, 1]);
    expect(withShape(custom, 'half').boxes).toBeUndefined();
    expect(withRotations(STONE, [0, 90]).rotations).toEqual([0, 90]);
    expect(withRotations(STONE, [0, 90, 180, 270]).rotations).toBeUndefined();
    const edge = withPlacement(STONE, 'edge');
    expect(edge.placement).toBe('edge');
    expect(edge.rotations).toBeUndefined();
    expect(connectPiecesOf(edge)).not.toContain('cross');
    expect(withConnectWith(STONE, ['stone', 'wall', 'wall']).connect).toEqual({ pieces: {}, with: ['wall'] });
    expect(withTheme(withTheme(STONE, 'winter', { block: 'snow', variant: 1 }), 'winter', null).kits).toBeUndefined();
    expect(withTheme(STONE, 'winter', { block: 'stone' }).kits).toEqual({ winter: { block: 'stone' } });
    expect(withMetadata(withMetadata(STONE, 'walkable', false), 'walkable', null).metadata).toBeUndefined();
  });
});

describe('the block layer\'s own settings', () => {
  const layer: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] } };
  it('a region cut away and themed; renamed, its cut-away, theme and walk follow; deleted, they go', () => {
    let c = withLayerTheme(withCutaway(layer, 'roof', true), 'roof', 'burnt');
    c = withLayerTheme(c, null, 'burnt');
    c = { ...c, walk: { from: 'roof', maxStep: 1 } };
    expect(isCutAway(c, 'roof')).toBe(true);
    expect(themeOf(c, 'roof')).toBe('burnt');
    const renamed = withRegionFollowed(c, 'roof', 'top')!;
    expect(renamed.cutaway).toEqual({ regions: [{ region: 'top' }] });
    expect(renamed.kits).toEqual([{ kit: 'burnt', region: 'top' }, { kit: 'burnt' }]);
    expect(renamed.walk).toEqual({ from: 'top', maxStep: 1 });
    const gone = withRegionFollowed(renamed, 'top', null)!;
    expect([gone.cutaway, gone.kits, gone.walk]).toEqual([{}, [{ kit: 'burnt' }], { maxStep: 1 }]);
    expect(withRegionFollowed(layer, 'nothing', 'x')).toBeNull();
    expect(withCutaway(withCutaway(layer, 'a', true), 'a', false).cutaway).toEqual({});
  });

  it('bounds grown, kept, and refused when empty, too large or out of range (the block editor e2e stores them through the backend)', () => {
    const grown = boundsGrown(layer, 8);
    expect(grown).toEqual({ min: [-8, 0, -8], max: [16, 8, 16] });
    const ok = withBounds(layer, grown.min, grown.max);
    expect(ok.ok && ok.component?.bounds).toEqual(grown);
    expect(withBounds(layer, [0, 0, 0], [8, 8, 8])).toEqual({ ok: true, component: null });
    for (const [min, max] of [[[0, 0, 0], [0, 8, 8]], [[0, 0, 0], [2000, 8, 8]], [[-5000, 0, 0], [8, 8, 8]], [[0, 0, 0], [8, Number.NaN, 8]]] as const) {
      expect(withBounds(layer, min, max).ok).toBe(false);
    }
  });
});
