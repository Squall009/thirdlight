/**
 * Opt-in (TL_PERF=1): terrain data costs, without a browser.
 *
 *   TL_PERF=1 npx vitest run tests/perf/terrain.test.ts
 *
 * - A dab on a 513² tile (1 m spacing): each sculpt kind, paint and holes at 8, 32 and 64 m radius (the brush core
 *   alone), and a whole stroke the way the backend runs one (read the tile blob, plan 32 dabs, encode and gzip the
 *   tile, digest it).
 * - Blob sizes of a 513² tile: rolling hills, the same painted with four layers, with holes.
 * - A 4k heightmap import: a 4097² 16-bit PNG and a 4096² RAW (decode, lay onto 513² tiles, encode and gzip
 *   every tile).
 * - The renderer's page-side work for the landscape class's terrain (144 tiles of 257² at 2 m): packing a tile's
 *   texels (heights and normals, layers) and its height bounds, and a CDLOD selection with the camera flying over it.
 * - Material rules baked into a tile (slope, cavity, a noise mask over what the rules before left, height): a
 *   257² and a 1,025² tile whole, and the part a 16 m raise bakes again.
 * The numbers go to ~/.cache/thirdlight-perf/terrain.jsonl and the phase plan's progress table.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import { SurfaceRuleSet, TerrainSamples, bakeTerrainRules, terrainBakeMargin, terrainBakeRect, cloneTerrainTile, decodeHeightmap, flatTerrainTile, holeTerrain, importHeightmap, paintTerrain, sculptTerrain, terrainFlatStep, terrainNoise, terrainTileKey, type TerrainComponent, type TerrainSculptKind, type TerrainTile } from '@thirdlight/project-model';

import { terrainBlobOf, terrainTileOfBlob } from '../../packages/workspace/src/terrain-edits';
import { PageNodes, selectTerrainNodes, terrainLodLayout, terrainLodRanges, tileHeightBounds, type SelectStats, type SelectTile } from '../../packages/three-adapter/src/terrain-quadtree';
import { packHeightNormal, packLayers, TERRAIN_TEXEL_BYTES } from '../../packages/three-adapter/src/terrain-texels';

const ON = process.env['TL_PERF'] === '1';
function record(line: string): void {
  console.log(line);
  const dir = join(process.env['TL_PERF_ROOT'] ?? join(homedir(), '.cache', 'thirdlight-perf'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'terrain.jsonl'), `${new Date().toISOString()} ${line}\n`);
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (t0: number): number => Math.round((performance.now() - t0) * 100) / 100;

const COMP: TerrainComponent = { tileSamples: 513, spacing: 1, heightRange: [-200, 600], tiles: [{ x: 0, z: 0 }] };
/** Rolling hills: a few octaves of the terrain's own value noise, metres above the object. */
const hills = (x: number, z: number): number => 60 * terrainNoise(x / 180, z / 180, 1) + 18 * terrainNoise(x / 45, z / 45, 2) + 4 * terrainNoise(x / 11, z / 11, 3) + 1 * terrainNoise(x / 3, z / 3, 4);
function hillTile(): TerrainTile {
  const s = new TerrainSamples(COMP, new Map([[terrainTileKey(0, 0), flatTerrainTile(513, terrainFlatStep(COMP.heightRange))]]));
  const t = s.writable(0, 0)!;
  for (let z = 0; z < 513; z++) for (let x = 0; x < 513; x++) t.heights[z * 513 + x] = s.stepOf(hills(x, z));
  return t;
}

/** A 16-bit greyscale PNG, rows filtered by "up" (as an encoder would for smooth data). */
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
  const stride = 1 + width * 2;
  const raw = new Uint8Array(height * stride);
  let prev = new Uint8Array(width * 2);
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width * 2);
    for (let x = 0; x < width; x++) {
      const v = at(x, y);
      row[x * 2] = v >> 8;
      row[x * 2 + 1] = v & 0xff;
    }
    raw[y * stride] = 2;
    for (let i = 0; i < row.length; i++) raw[y * stride + 1 + i] = (row[i]! - prev[i]!) & 0xff;
    prev = row;
  }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe.runIf(ON)('terrain data perf', () => {
  it('dabs on a 513² tile, and one stroke as the backend runs it', () => {
    const base = hillTile();
    for (const radius of [8, 32, 64]) {
      const row: Record<string, number> = {};
      for (const kind of ['raise', 'lower', 'smooth', 'flatten', 'noise', 'paint', 'holes'] as const) {
        const s = new TerrainSamples(COMP, new Map([[terrainTileKey(0, 0), base]]));
        const times: number[] = [];
        for (let i = 0; i < 40; i++) {
          const at: [number, number] = [100 + (i % 8) * 40, 100 + Math.floor(i / 8) * 40];
          const t0 = performance.now();
          if (kind === 'paint') paintTerrain(s, { at, radius, strength: 0.5, falloff: 'smooth', layer: 1 + (i % 6) });
          else if (kind === 'holes') holeTerrain(s, { at, radius: radius / 4 });
          else sculptTerrain(s, { kind: kind as TerrainSculptKind, at, radius, strength: kind === 'smooth' || kind === 'flatten' ? 0.5 : 1, falloff: 'smooth', height: 20, scale: 12, seed: 3 });
          times.push(performance.now() - t0);
        }
        row[kind] = Math.round(median(times.slice(1)) * 1000) / 1000;
      }
      record(JSON.stringify({ case: 'dab', tile: 513, radius, ms: row }));
    }
    // One stroke, the backend's way: decode the stored tile, 32 dabs of 16 m, encode + gzip + digest.
    const stored = terrainBlobOf(base);
    const runs: Record<string, number[]> = { decode: [], plan: [], encode: [], total: [] };
    for (let r = 0; r < 7; r++) {
      const t0 = performance.now();
      const tile = terrainTileOfBlob(stored.bytes);
      const t1 = performance.now();
      const s = new TerrainSamples(COMP, new Map([[terrainTileKey(0, 0), tile]]));
      for (let i = 0; i < 32; i++) sculptTerrain(s, { kind: 'raise', at: [200 + i * 2, 250], radius: 16, strength: 0.5, falloff: 'smooth' });
      const t2 = performance.now();
      const blob = terrainBlobOf(s.tile(0, 0)!);
      const t3 = performance.now();
      expect(blob.digest).not.toBe(stored.digest);
      runs['decode']!.push(t1 - t0);
      runs['plan']!.push(t2 - t1);
      runs['encode']!.push(t3 - t2);
      runs['total']!.push(t3 - t0);
    }
    record(JSON.stringify({ case: 'stroke', tile: 513, dabs: 32, radius: 16, ms: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, Math.round(median(v) * 100) / 100])) }));
  });

  it('material rules baked into a tile: whole, and the part a sculpt moved', () => {
    const rules = new SurfaceRuleSet([
      { layer: 3, slope: { min: 35, fade: 8 } },
      { layer: 2, cavity: { min: 0.4, fade: 0.4, radius: 4 } },
      { layer: 4, noise: { scale: 12, seed: 2, min: 0.6, fade: 0.1 }, weight: { layer: 3, max: 0.3 } },
      { layer: 5, height: { min: 50, fade: 10 } },
    ]);
    for (const samples of [257, 1025]) {
      const comp: TerrainComponent = { tileSamples: samples, spacing: 1, heightRange: [-200, 600], tiles: [{ x: 0, z: 0 }] };
      const tile = flatTerrainTile(samples, terrainFlatStep(comp.heightRange));
      const s0 = new TerrainSamples(comp, new Map([[terrainTileKey(0, 0), tile]]));
      for (let z = 0; z < samples; z++) for (let x = 0; x < samples; x++) tile.heights[z * samples + x] = s0.stepOf(hills(x, z));
      const whole: number[] = [];
      let baked: TerrainTile = tile;
      for (let r = 0; r < 5; r++) {
        const s = new TerrainSamples(comp, new Map([[terrainTileKey(0, 0), cloneTerrainTile(tile)]]));
        const t0 = performance.now();
        bakeTerrainRules(s, rules, [0, 0, 0], null);
        whole.push(performance.now() - t0);
        baked = s.tile(0, 0)!;
      }
      const part: number[] = [];
      for (let r = 0; r < 5; r++) {
        const before = new Map([[terrainTileKey(0, 0), baked]]);
        const s = new TerrainSamples(comp, new Map([[terrainTileKey(0, 0), cloneTerrainTile(baked)]]));
        for (let i = 0; i < 8; i++) sculptTerrain(s, { kind: 'raise', at: [100 + i * 2, 120], radius: 16, strength: 0.5, falloff: 'smooth' });
        const t0 = performance.now();
        const rect = terrainBakeRect(before, new Map([[terrainTileKey(0, 0), s.tile(0, 0)!]]), samples - 1, terrainBakeMargin(rules, 1));
        bakeTerrainRules(s, rules, [0, 0, 0], rect);
        part.push(performance.now() - t0);
      }
      const r2 = (v: number): number => Math.round(v * 100) / 100;
      record(JSON.stringify({ case: 'rule bake', tile: samples, rules: rules.rules.length, wholeMs: r2(median(whole)), nsPerSample: r2((median(whole) * 1e6) / (samples * samples)), raise16mMs: r2(median(part)) }));
    }
  }, 120_000);

  it('blob sizes of a 513² tile', () => {
    const t = hillTile();
    const plain = terrainBlobOf(t).bytes.length;
    const s = new TerrainSamples(COMP, new Map([[terrainTileKey(0, 0), t]]));
    for (let i = 0; i < 200; i++) paintTerrain(s, { at: [(i * 97) % 513, (i * 61) % 513], radius: 24, strength: 0.6, falloff: 'smooth', layer: i % 4 });
    const painted = terrainBlobOf(s.tile(0, 0)!).bytes.length;
    for (let i = 0; i < 20; i++) holeTerrain(s, { at: [(i * 131) % 513, (i * 71) % 513], radius: 6 });
    const holes = terrainBlobOf(s.tile(0, 0)!).bytes.length;
    const raw = 513 * 513 * 2;
    record(JSON.stringify({ case: 'blob', tile: 513, rawHeights: raw, hills: plain, painted4Layers: painted, withHoles: holes, decodedPainted: 513 * 513 * (2 + 9) }));
    expect(plain).toBeLessThan(raw);
  });

  it('a 4k heightmap import', () => {
    const at = (x: number, y: number): number => Math.max(0, Math.min(65535, Math.round(((hills(x, y) + 200) / 800) * 65535)));
    const t0 = performance.now();
    const png = png16(4097, 4097, at);
    const made = ms(t0);
    const raw = new Uint8Array(4096 * 4096 * 2);
    const view = new DataView(raw.buffer);
    for (let y = 0; y < 4096; y++) for (let x = 0; x < 4096; x++) view.setUint16((y * 4096 + x) * 2, at(x, y), true);
    for (const [format, bytes] of [['png16', png], ['raw16', raw]] as const) {
      const a = performance.now();
      const map = decodeHeightmap(bytes, { format, inflate: (d, max) => new Uint8Array(inflateSync(d, { maxOutputLength: Math.max(1, max) })) });
      expect(map.ok).toBe(true);
      if (!map.ok) return;
      const b = performance.now();
      const s = new TerrainSamples(COMP, new Map());
      const laid = importHeightmap(s, map.map, [0, 0], [-200, 600]);
      const c = performance.now();
      let stored = 0;
      for (const tile of s.all().values()) stored += terrainBlobOf(tile).bytes.length;
      const d = performance.now();
      record(JSON.stringify({ case: 'import', format, size: [map.map.width, map.map.height], fileBytes: bytes.length, tiles: laid.added, ms: { decode: Math.round(b - a), lay: Math.round(c - b), encodeGzip: Math.round(d - c), total: Math.round(d - a) }, storedBytes: stored, pngMadeMs: format === 'png16' ? made : undefined }));
    }
  }, 600_000);

  it('the renderer\'s page-side work: tile texels, height bounds, and selection while flying', () => {
    const samples = 257;
    const layout = terrainLodLayout(samples, 2);
    const tile = flatTerrainTile(samples, 0);
    for (let z = 0; z < samples; z++) for (let x = 0; x < samples; x++) tile.heights[z * samples + x] = 20000 + Math.round(3000 * Math.sin(x / 17) * Math.cos(z / 23));
    tile.weights = new Uint8Array(samples * samples * 8);
    for (let i = 0; i < samples * samples; i++) tile.weights.set([i % 4, (i + 1) % 4, 0, 0, 200, 55, 0, 0], i * 8);
    const out = new Uint8Array(samples * samples * TERRAIN_TEXEL_BYTES);
    const ids = new Uint8Array(samples * samples * TERRAIN_TEXEL_BYTES);
    const heightsMs: number[] = [];
    const layersMs: number[] = [];
    const boundsMs: number[] = [];
    for (let k = 0; k < 12; k++) {
      let t0 = performance.now();
      packHeightNormal(out, tile, () => tile, 512 / 65535, 2);
      heightsMs.push(ms(t0));
      t0 = performance.now();
      packLayers(out, ids, tile);
      layersMs.push(ms(t0));
      t0 = performance.now();
      tileHeightBounds(tile.heights, layout);
      boundsMs.push(ms(t0));
    }
    const bounds = tileHeightBounds(tile.heights, layout);
    const tiles: SelectTile[] = [];
    for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) tiles.push({ x, z, page: 0, layer: z * 12 + x, bounds });
    const page = new PageNodes();
    const stats: SelectStats = { nodes: 0, inView: 0, perLevel: [] };
    const ranges = terrainLodRanges(layout, undefined, 1);
    const selectMs: number[] = [];
    // A flight across the middle, 8 m up, a frustum of half the sky (in view: ahead of the camera along −z).
    for (let f = 0; f < 600; f++) {
      const eye: [number, number, number] = [3072 + f * 0.5, 160, 3072 - f * 0.25];
      const t0 = performance.now();
      selectTerrainNodes(tiles, { layout, ranges, eye, heightOf: (s) => -64 + (s / 65535) * 256, inView: (x, _y, z, r) => z - r < eye[2] && Math.abs(x - eye[0]) < (eye[2] - z) + r }, [page], stats);
      selectMs.push(performance.now() - t0);
    }
    const sel = selectMs.slice(100);
    record(`terrain page-side: 257² tile pack heights+normals ${median(heightsMs)} ms, layers ${median(layersMs)} ms, bounds ${median(boundsMs)} ms; selection over 144 tiles ${Math.round(median(sel) * 1000) / 1000} ms median, ${Math.round([...sel].sort((a, b) => a - b)[Math.floor(sel.length * 0.95)]! * 1000) / 1000} ms p95 (${stats.nodes} nodes, ${stats.inView} in view, per level ${stats.perLevel.join('/')})`);
    expect(stats.nodes).toBeGreaterThan(144);
  });
});
