/**
 * Terrain data: the component's rules, a tile's binary form (every map,
 * canonical bytes for equal tiles), the brushes (each sculpt kind
 * deterministic, edge samples written in every tile that holds them, paint
 * keeping the strongest four layers, holes), 16-bit heightmaps (PNG and RAW,
 * made here) laid onto tiles, a corner-height block layer converted, and the
 * field a game asks for heights. Neutral fixtures only.
 */
import { describe, expect, it } from 'vitest';

import { applyBlockEdits, BlockGrid } from './block-grid';
import type { BlockLayerComponent, BlockType } from './block-layers';
import { canonicalTerrain, terrainFlatStep, terrainHeightOf, terrainStepOf, terrainTileKey, validateTerrainComponent, type TerrainComponent } from './terrain';
import { holeTerrain, paintTerrain, paintTerrainSample, rampTerrain, sculptTerrain, TerrainSamples, terrainNoise, type TerrainSculptKind } from './terrain-edit';
import { TerrainField } from './terrain-field';
import { blockLayerToTerrain, decodeHeightmap, importHeightmap } from './terrain-import';
import { decodeTerrainTile, encodeTerrainTile, flatTerrainTile, readTerrainTileBlob, setTerrainHole, terrainHoleAt, terrainLayersAt, terrainTileBlobBytes, terrainTileBytes, wrapTerrainTile, TERRAIN_PAINT_BYTES, type TerrainTile } from './terrain-tile';
import type { ModelErrorV2 } from './errors';

const COMP: TerrainComponent = { tileSamples: 17, spacing: 1, heightRange: [-10, 54], tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 1 }] };
const flat = (): Map<string, TerrainTile> => new Map(COMP.tiles.map((t) => [terrainTileKey(t.x, t.z), flatTerrainTile(17, terrainFlatStep(COMP.heightRange))]));
const samples = (): TerrainSamples => new TerrainSamples(COMP, flat());
const roundTrip = (t: TerrainTile): TerrainTile => decodeTerrainTile(encodeTerrainTile(t).payload);
const bytesOf = (t: TerrainTile): string => Array.from(encodeTerrainTile(t).payload, (b) => b.toString(16).padStart(2, '0')).join('');

/** Every shared edge sample equal in the tiles holding it. */
function seams(s: TerrainSamples): number {
  let bad = 0;
  const n = s.n;
  for (const [key, t] of s.all()) {
    const [tx, tz] = key.split(',').map(Number) as [number, number];
    const right = s.tile(tx + 1, tz);
    const below = s.tile(tx, tz + 1);
    for (let i = 0; i <= n; i++) {
      if (right !== undefined && t.heights[i * (n + 1) + n] !== right.heights[i * (n + 1)]) bad += 1;
      if (below !== undefined && t.heights[n * (n + 1) + i] !== below.heights[i]) bad += 1;
    }
  }
  return bad;
}

describe('terrain component', () => {
  it('takes 2^n + 1 tiles, a spacing, a rising range and unique tiles with optional digests', () => {
    const errs = (v: unknown): ModelErrorV2[] => {
      const e: ModelErrorV2[] = [];
      validateTerrainComponent(v, '/t', e);
      return e;
    };
    expect(errs(COMP)).toEqual([]);
    expect(errs({ ...COMP, tiles: [{ x: 0, z: 0, data: 'a'.repeat(64) }] })).toEqual([]);
    expect(errs({ ...COMP, tileSamples: 16 }).map((e) => e.path)).toEqual(['/t/tileSamples']);
    expect(errs({ ...COMP, spacing: 0 }).map((e) => e.path)).toEqual(['/t/spacing']);
    expect(errs({ ...COMP, heightRange: [5, 5] }).map((e) => e.path)).toEqual(['/t/heightRange']);
    expect(errs({ ...COMP, tiles: [{ x: 0, z: 0 }, { x: 0, z: 0 }] }).map((e) => e.path)).toEqual(['/t/tiles/1']);
    expect(errs({ ...COMP, tiles: [{ x: 0.5, z: 0, data: 'nope' }] }).map((e) => e.path)).toEqual(['/t/tiles/0/x', '/t/tiles/0/data']);
    expect(errs({ ...COMP, extra: 1 }).map((e) => e.path)).toEqual(['/t/extra']);
    // Optional: far ground past a distance, and material rules (a terrain's: no block conditions).
    expect(errs({ ...COMP, macroDistance: 400, rules: [{ layer: 7, slope: { min: 30, fade: 5 } }] })).toEqual([]);
    expect(errs({ ...COMP, macroDistance: 0, rules: [{ layer: 1, blocks: ['x'] }] }).map((e) => e.path)).toEqual(['/t/macroDistance', '/t/rules/0/blocks']);
    expect(canonicalTerrain({ ...COMP, rules: [{ layer: 2, strength: 1 }], macroDistance: 300 })).toEqual({ ...canonicalTerrain(COMP), macroDistance: 300, rules: [{ layer: 2 }] });
    expect(canonicalTerrain({ ...COMP, tiles: [{ x: 1, z: 1 }, { x: 0, z: 0 }] }).tiles).toEqual([{ x: 0, z: 0 }, { x: 1, z: 1 }]);
  });

  it('maps heights to 16-bit steps of the range and back', () => {
    expect(terrainStepOf([-10, 54], -10)).toBe(0);
    expect(terrainStepOf([-10, 54], 54)).toBe(65535);
    expect(terrainStepOf([-10, 54], 1000)).toBe(65535);
    expect(Math.abs(terrainHeightOf([-10, 54], terrainStepOf([-10, 54], 3.21)) - 3.21)).toBeLessThan(64 / 65535);
    expect(terrainHeightOf([-10, 54], terrainFlatStep([-10, 54]))).toBeCloseTo(0, 3);
  });
});

describe('terrain tile binary', () => {
  it('round-trips heights, weights, holes and paint; a bare tile is heights only', () => {
    const t = flatTerrainTile(33, 1234);
    for (let i = 0; i < t.heights.length; i++) t.heights[i] = (i * 7919) & 0xffff;
    expect(encodeTerrainTile(t).flags).toBe(0);
    expect(roundTrip(t)).toEqual(t);
    t.weights = new Uint8Array(33 * 33 * 8);
    for (let i = 0; i < 33 * 33; i++) {
      t.weights[i * 8] = 3;
      t.weights[i * 8 + 1] = 9;
      t.weights[i * 8 + 4] = 200;
      t.weights[i * 8 + 5] = 55;
    }
    setTerrainHole(t, 5, 6, true);
    t.paint = new Uint8Array(33 * 33 * TERRAIN_PAINT_BYTES);
    expect(paintTerrainSample(t.paint, 40 * TERRAIN_PAINT_BYTES, 7, 0.5, false)).toBe(true);
    const back = roundTrip(t);
    expect(back).toEqual(t);
    expect(terrainHoleAt(back, 5, 6)).toBe(true);
    expect(terrainHoleAt(back, 6, 5)).toBe(false);
    expect(terrainTileBytes(back)).toBe(33 * 33 * (2 + 8 + 9) + Math.ceil((32 * 32) / 8));
  });

  it('drops maps that hold only their default, so equal tiles are equal bytes', () => {
    const a = flatTerrainTile(17, 500);
    const b = flatTerrainTile(17, 500);
    b.weights = new Uint8Array(17 * 17 * 8);
    for (let i = 0; i < 17 * 17; i++) b.weights[i * 8 + 4] = 255;
    b.holes = new Uint8Array(32);
    b.paint = new Uint8Array(17 * 17 * TERRAIN_PAINT_BYTES);
    expect(bytesOf(a)).toBe(bytesOf(b));
  });

  it('carries the tile size and maps in its header, readable without inflating', () => {
    const t = flatTerrainTile(129, 9);
    setTerrainHole(t, 0, 0, true);
    const enc = encodeTerrainTile(t);
    const blob = wrapTerrainTile('none', enc, enc.payload);
    const h = readTerrainTileBlob(blob);
    expect(h.samples).toBe(129);
    expect(h.rawLength).toBe(enc.payload.length);
    expect(terrainTileBlobBytes(blob)).toBe(terrainTileBytes(t));
    expect(() => readTerrainTileBlob(new Uint8Array(16))).toThrow(/not a binary terrain tile/);
    expect(() => decodeTerrainTile(enc.payload.subarray(0, 20))).toThrow(/bytes/);
  });
});

describe('terrain brushes', () => {
  const kinds: TerrainSculptKind[] = ['raise', 'lower', 'smooth', 'flatten', 'noise'];
  for (const kind of kinds) {
    it(`${kind}: the same dabs give the same tiles, edges stay joined`, () => {
      const run = (): TerrainSamples => {
        const s = samples();
        // Uneven ground first, so smoothing and flattening have work.
        for (let i = 0; i < 6; i++) sculptTerrain(s, { kind: 'raise', at: [10 + i * 2, 12 + (i % 3)], radius: 5, strength: 3, falloff: 'smooth' });
        for (const at of [[16, 16], [17.5, 15], [14, 18]] as const) sculptTerrain(s, { kind, at, radius: 6, strength: kind === 'raise' || kind === 'lower' || kind === 'noise' ? 2 : 0.8, falloff: 'smooth', height: 1.5, scale: 4, seed: 7 });
        return s;
      };
      const a = run();
      const b = run();
      expect([...a.all().entries()].map(([k, t]) => [k, bytesOf(t)])).toEqual([...b.all().entries()].map(([k, t]) => [k, bytesOf(t)]));
      expect(seams(a)).toBe(0);
      // The dab reached across the tile corner at (16, 16): all four tiles were written.
      expect([...a.touched].sort()).toEqual(['0,0', '0,1', '1,0', '1,1']);
    });
  }

  it('raise lifts the centre by the strength and leaves the far ground', () => {
    const s = samples();
    sculptTerrain(s, { kind: 'raise', at: [8, 8], radius: 4, strength: 2, falloff: 'smooth' });
    const h = (x: number, z: number): number => s.heightOf(s.step(x, z)!);
    expect(h(8, 8)).toBeCloseTo(2, 2);
    expect(h(8, 11)).toBeGreaterThan(0);
    expect(h(8, 12)).toBeCloseTo(0, 2);
    expect(h(20, 20)).toBeCloseTo(0, 2);
  });

  it('flatten levels toward its height, smooth evens a spike, noise is deterministic value noise', () => {
    const s = samples();
    sculptTerrain(s, { kind: 'flatten', at: [8, 8], radius: 3, strength: 1, falloff: 'constant', height: 4 });
    expect(s.heightOf(s.step(8, 8)!)).toBeCloseTo(4, 2);
    sculptTerrain(s, { kind: 'raise', at: [24, 24], radius: 0.5, strength: 10, falloff: 'constant' });
    const spike = s.heightOf(s.step(24, 24)!);
    sculptTerrain(s, { kind: 'smooth', at: [24, 24], radius: 0.5, strength: 1, falloff: 'constant' });
    expect(s.heightOf(s.step(24, 24)!)).toBeLessThan(spike / 4);
    expect(terrainNoise(1.25, 3.5, 7)).toBe(terrainNoise(1.25, 3.5, 7));
    expect(terrainNoise(1.25, 3.5, 7)).not.toBe(terrainNoise(1.25, 3.5, 8));
    expect(Math.abs(terrainNoise(0.3, 0.6, 1))).toBeLessThanOrEqual(1);
  });

  it('a ramp lays the slope between its ends', () => {
    const s = samples();
    rampTerrain(s, { from: [2, 0, 16], to: [30, 14, 16], radius: 3, strength: 1, falloff: 'constant' });
    expect(s.heightOf(s.step(2, 16)!)).toBeCloseTo(0, 2);
    expect(s.heightOf(s.step(16, 16)!)).toBeCloseTo(7, 2);
    expect(s.heightOf(s.step(30, 16)!)).toBeCloseTo(14, 2);
    expect(s.heightOf(s.step(16, 25)!)).toBeCloseTo(0, 2);
    expect(seams(s)).toBe(0);
  });

  it('paint blends layers over the baked ones, keeps the strongest four, and erases back to the rules', () => {
    const s = samples();
    for (const layer of [3, 5, 9, 12, 20]) paintTerrain(s, { at: [4, 4], radius: 2, strength: 0.6, falloff: 'constant', layer });
    const t = s.tile(0, 0)!;
    const i = 4 * 17 + 4;
    const own = Array.from(t.paint!.subarray(i * 9, i * 9 + 9));
    expect(own.slice(4, 8).reduce((a, b) => a + b, 0)).toBe(255);
    expect(own[0]).toBe(20);
    expect(own[8]).toBeGreaterThan(200);
    const shown = terrainLayersAt(t, i);
    expect(shown.layers.length).toBeLessThanOrEqual(4);
    expect(shown.weights.reduce((a, b) => a + b, 0)).toBe(255);
    for (let k = 0; k < 12; k++) paintTerrain(s, { at: [4, 4], radius: 2, strength: 1, falloff: 'constant', layer: 0, erase: true });
    expect(terrainLayersAt(s.tile(0, 0)!, i)).toEqual({ layers: [0], weights: [255] });
    expect(encodeTerrainTile(s.tile(0, 0)!).flags & 4).toBe(0);
  });

  it('a paint dab on a tile edge writes every tile holding the sample', () => {
    const s = samples();
    paintTerrain(s, { at: [16, 16], radius: 0.5, strength: 1, falloff: 'constant', layer: 2 });
    const corner = [s.tile(0, 0)!.paint!.subarray(288 * 9, 289 * 9), s.tile(1, 0)!.paint!.subarray(16 * 17 * 9, (16 * 17 + 1) * 9), s.tile(0, 1)!.paint!.subarray(16 * 9, 17 * 9), s.tile(1, 1)!.paint!.subarray(0, 9)];
    for (const c of corner) expect(Array.from(c)).toEqual(Array.from(corner[0]!));
  });

  it('holes cut the cells within the radius and fill them back', () => {
    const s = samples();
    expect(holeTerrain(s, { at: [16, 16], radius: 1 })).toBe(4);
    expect(terrainHoleAt(s.tile(0, 0)!, 15, 15)).toBe(true);
    expect(terrainHoleAt(s.tile(1, 1)!, 0, 0)).toBe(true);
    expect(holeTerrain(s, { at: [16, 16], radius: 1, erase: true })).toBe(4);
    expect(terrainHoleAt(s.tile(1, 1)!, 0, 0)).toBe(false);
  });
});

/** A zlib stream of stored (uncompressed) blocks: what a PNG's data may be, made without a compressor. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const part = data.subarray(b * 65535, (b + 1) * 65535);
    out[o] = b === blocks - 1 ? 1 : 0;
    out[o + 1] = part.length & 0xff;
    out[o + 2] = part.length >> 8;
    out[o + 3] = ~part.length & 0xff;
    out[o + 4] = (~part.length >> 8) & 0xff;
    out.set(part, o + 5);
    o += 5 + part.length;
  }
  let a = 1;
  let c = 0;
  for (const v of data) {
    a = (a + v) % 65521;
    c = (c + a) % 65521;
  }
  new DataView(out.buffer).setUint32(o, ((c << 16) | a) >>> 0);
  return out;
}

/** A 16-bit greyscale PNG (filter 0 rows), made here. */
function png16(width: number, height: number, at: (x: number, y: number) => number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    v.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 16;
  ihdr[9] = 0;
  const raw = new Uint8Array(height * (1 + width * 2));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = at(x, y);
      raw[y * (1 + width * 2) + 1 + x * 2] = v >> 8;
      raw[y * (1 + width * 2) + 2 + x * 2] = v & 0xff;
    }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('heightmap import', () => {
  const at = (x: number, y: number): number => (x * 1000 + y * 37) & 0xffff;

  it('reads a 16-bit PNG and a RAW file to the same samples', () => {
    const png = decodeHeightmap(png16(20, 12, at), { format: 'png16' });
    expect(png.ok).toBe(true);
    const raw = new Uint8Array(20 * 12 * 2);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 20; x++) new DataView(raw.buffer).setUint16((y * 20 + x) * 2, at(x, y), true);
    const r = decodeHeightmap(raw, { format: 'raw16', width: 20 });
    expect(r.ok).toBe(true);
    if (!png.ok || !r.ok) return;
    expect(r.map.height).toBe(12);
    expect(Array.from(png.map.samples)).toEqual(Array.from(r.map.samples));
    const big = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 2) [big[i], big[i + 1]] = [raw[i + 1]!, raw[i]!];
    const b = decodeHeightmap(big, { format: 'raw16', width: 20, byteOrder: 'big' });
    expect(b.ok && Array.from(b.map.samples)).toEqual(Array.from(r.map.samples));
    expect(decodeHeightmap(raw, { format: 'raw16' }).ok).toBe(false);
    expect(decodeHeightmap(raw.subarray(1), { format: 'raw16' }).ok).toBe(false);
  });

  it('lays the samples one per terrain sample, adds tiles it reaches, extends edges in new tiles', () => {
    const s = new TerrainSamples({ ...COMP, heightRange: [0, 65535] }, new Map());
    const map = { width: 20, height: 12, samples: new Uint16Array(20 * 12).map((_, i) => at(i % 20, Math.floor(i / 20))) };
    const r = importHeightmap(s, map, [0, 0], [0, 65535]);
    expect(r.added).toBe(2);
    expect([...s.all().keys()].sort()).toEqual(['0,0', '1,0']);
    expect(s.step(5, 7)).toBe(at(5, 7));
    expect(s.step(19, 11)).toBe(at(19, 11));
    expect(s.step(25, 15)).toBe(at(19, 11));
    expect(seams(s)).toBe(0);
    // A tile made next to ground already there: the samples past the image on their shared edge keep that ground
    // (no one-sample cliff cut into it), the new tile meets it without a seam.
    const kept = new TerrainSamples({ ...COMP, heightRange: [0, 65535] }, new Map());
    kept.addTile(1, 0);
    for (let z = 0; z <= COMP.tileSamples - 1; z++) for (let x = 0; x <= COMP.tileSamples - 1; x++) kept.setStep(16 + x, z, 777 + x + z);
    const before = new Map([...Array(17).keys()].map((z) => [z, kept.step(16, z)]));
    importHeightmap(kept, { width: 17, height: 9, samples: new Uint16Array(17 * 9).fill(40000) }, [0, 0], [0, 65535]);
    for (let z = 0; z <= 16; z++) expect(kept.step(16, z), `row ${z}`).toBe(z < 9 ? 40000 : before.get(z));
    expect(kept.step(8, 12)).toBe(40000);
    expect(seams(kept)).toBe(0);
    // Another range: the steps are what the heights are in the terrain's own range.
    const half = new TerrainSamples({ ...COMP, heightRange: [0, 100] }, new Map());
    importHeightmap(half, { width: 2, height: 2, samples: new Uint16Array([0, 65535, 65535, 0]) }, [0, 0], [0, 50]);
    expect(half.heightOf(half.step(1, 0)!)).toBeCloseTo(50, 2);
  });
});

describe('block layer to terrain', () => {
  const TYPES: BlockType[] = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' }];
  const types = new Map(TYPES.map((t) => [t.blockId, t]));
  const LAYER: BlockLayerComponent = { cellSize: [2, 0.5, 2], bounds: { min: [0, 0, 0], max: [8, 16, 8] } };

  it('takes the corner heights at every sample and cuts holes over empty columns', () => {
    const g = new BlockGrid(LAYER);
    const columns: number[] = [];
    // A slope rising along x by one row per column (corners in rows), one column left empty.
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) if (!(x === 3 && z === 3)) columns.push(x, z, 2 + x, 3 + x, 3 + x, 2 + x);
    const r = applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 8, 1, 8], cell: { block: 'soil' } }, { kind: 'cells', at: [3, 0, 3], cell: null }, { kind: 'surface', columns }], { types, stamps: new Map() });
    expect(r.ok).toBe(true);
    const data = g.toData('layer-1', null, g.chunkKeys());
    const s = new TerrainSamples({ tileSamples: 17, spacing: 1, heightRange: [-10, 54] }, new Map());
    // The layer sits at (10, 1, 0); the terrain object at (10, 0, 0): the layer's x 0 is the terrain's x 0.
    const out = blockLayerToTerrain(s, { component: LAYER, data, types, origin: [10, 1, 0] }, [10, 0, 0]);
    expect(out.added).toBe(1);
    expect(out.clamped).toBe(0);
    // Sample (x, z) metres → layer column x / 2: height = 1 + rows × 0.5 with rows = 2 + x / 2 along the slope.
    for (const x of [0, 2, 5, 9, 16]) expect(s.heightOf(s.step(x, 5)!)).toBeCloseTo(1 + (2 + x / 2) * 0.5, 2);
    const t = s.tile(0, 0)!;
    expect(terrainHoleAt(t, 6, 6)).toBe(true);
    expect(terrainHoleAt(t, 7, 7)).toBe(true);
    expect(terrainHoleAt(t, 4, 4)).toBe(false);
    expect(out.holes).toBe(4);
  });
});

describe('terrain field', () => {
  it('answers heights between samples, normals, slope, holes and layers', () => {
    const s = samples();
    rampTerrain(s, { from: [0, 0, 8], to: [32, 16, 8], radius: 64, strength: 1, falloff: 'constant' });
    holeTerrain(s, { at: [20.5, 20.5], radius: 0.4 });
    const field = new TerrainField(COMP, [100, 5, -50], s.all());
    expect(field.heightAt(100 + 10.5, -50 + 3)).toBeCloseTo(5 + 5.25, 2);
    const smp = field.sample(100 + 10, -50 + 10)!;
    expect(smp.slope).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 1);
    expect(smp.normal[0]).toBeLessThan(0);
    expect(smp.layers).toEqual([0]);
    expect(field.heightAt(100 + 20.5, -50 + 20.5)).toBeNull();
    expect(field.holeAt(100 + 20.5, -50 + 20.5)).toBe(true);
    expect(field.heightAt(100 - 1, -50)).toBeNull();
    expect(field.memory()).toEqual({ tiles: 4, bytes: 4 * 17 * 17 * 2 + 32 });
  });
});
