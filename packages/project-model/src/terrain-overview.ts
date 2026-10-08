/**
 * A streamed terrain's overview: every tile at its coarsest level, in one
 * blob a build ships beside the tiles (`terrain.overview`), so the whole
 * terrain reaches the horizon from the first frame while only the tiles in
 * its render ring are read at full detail.
 *
 * A tile's overview is {@link TERRAIN_OVERVIEW_SAMPLES} samples a side: its
 * heights taken at every (samples − 1) / 16th sample — exactly the vertices
 * the renderer's coarsest level of the full tile draws, so a full tile at
 * that level and its overview meet without a crack and one replaces the
 * other without a jump; the layers it shows there (baked weights and hand
 * paint mixed) as baked weights; a cell a hole where at least half of the
 * full tile's cells under it are.
 *
 * The blob (`TLTO`, the shared header of `binary-container.ts`) holds, after
 * a layout byte and the count, each tile's coordinates and its overview as a
 * tile payload (`terrain-tile.ts`).
 *
 * Pure: no compression here (node:zlib in a build, the page's
 * DecompressionStream in a game).
 */
import { hasBinaryMagic, readBinaryBlob, wrapBinaryBlob, type BinaryCompression } from './binary-container';
import { decodeTerrainTile, encodeTerrainTile, setTerrainHole, terrainHoleAt, terrainLayersAt, writeSampleLayers, TERRAIN_WEIGHT_BYTES, type TerrainTile } from './terrain-tile';

/** Samples along an overview tile's side (one node of the renderer's 16² grid). */
export const TERRAIN_OVERVIEW_SAMPLES = 17;
/** The first bytes of an overview blob ("TLTO"). */
export const TERRAIN_OVERVIEW_MAGIC = Object.freeze([0x54, 0x4c, 0x54, 0x4f]);
/** The payload layout this engine writes and reads. */
export const TERRAIN_OVERVIEW_LAYOUT = 1;

/** One tile's overview and where it lies. */
export interface TerrainOverviewTile {
  readonly x: number;
  readonly z: number;
  readonly tile: TerrainTile;
}

/** A full tile's overview (a tile already of overview size is copied as it is). */
export function terrainOverviewTile(t: TerrainTile): TerrainTile {
  const n = TERRAIN_OVERVIEW_SAMPLES;
  const s = t.samples;
  const step = (s - 1) / (n - 1);
  const heights = new Uint16Array(n * n);
  const weights = t.weights !== null || t.paint !== null ? new Uint8Array(n * n * TERRAIN_WEIGHT_BYTES) : null;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const at = j * step * s + i * step;
      heights[j * n + i] = t.heights[at]!;
      if (weights !== null) {
        const l = terrainLayersAt(t, at);
        writeSampleLayers(weights, (j * n + i) * TERRAIN_WEIGHT_BYTES, l.layers, l.weights);
      }
    }
  }
  const out: TerrainTile = { samples: n, heights, weights, holes: null, paint: null };
  if (t.holes !== null) {
    for (let cz = 0; cz < n - 1; cz++) {
      for (let cx = 0; cx < n - 1; cx++) {
        let holes = 0;
        for (let z = cz * step; z < (cz + 1) * step; z++) for (let x = cx * step; x < (cx + 1) * step; x++) if (terrainHoleAt(t, x, z)) holes += 1;
        if (holes * 2 >= step * step) setTerrainHole(out, cx, cz, true);
      }
    }
  }
  return out;
}

/** The overview payload of tiles (uncompressed; `wrapTerrainOverview` adds the header). */
export function encodeTerrainOverview(tiles: readonly TerrainOverviewTile[]): Uint8Array {
  const parts = tiles.map((t) => ({ x: t.x, z: t.z, payload: encodeTerrainTile(t.tile).payload }));
  const size = 5 + parts.reduce((n, p) => n + 8 + p.payload.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = TERRAIN_OVERVIEW_LAYOUT;
  dv.setUint32(1, parts.length, true);
  let o = 5;
  for (const p of parts) {
    dv.setInt16(o, p.x, true);
    dv.setInt16(o + 2, p.z, true);
    dv.setUint32(o + 4, p.payload.length, true);
    out.set(p.payload, o + 8);
    o += 8 + p.payload.length;
  }
  return out;
}

/** Tiles back from an overview payload (throws a short message when malformed). */
export function decodeTerrainOverview(payload: Uint8Array): TerrainOverviewTile[] {
  if (payload.length < 5) throw new Error('terrain overview binary: the data ends early');
  if (payload[0] !== TERRAIN_OVERVIEW_LAYOUT) throw new Error(`terrain overview binary: layout ${payload[0]} is not one this engine reads (${TERRAIN_OVERVIEW_LAYOUT})`);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = dv.getUint32(1, true);
  const out: TerrainOverviewTile[] = [];
  let o = 5;
  for (let k = 0; k < count; k++) {
    if (o + 8 > payload.length) throw new Error('terrain overview binary: the data ends early');
    const x = dv.getInt16(o, true);
    const z = dv.getInt16(o + 2, true);
    const len = dv.getUint32(o + 4, true);
    if (o + 8 + len > payload.length) throw new Error('terrain overview binary: the data ends early');
    const tile = decodeTerrainTile(payload.subarray(o + 8, o + 8 + len));
    if (tile.samples !== TERRAIN_OVERVIEW_SAMPLES) throw new Error(`terrain overview binary: a tile of ${tile.samples} samples`);
    out.push({ x, z, tile });
    o += 8 + len;
  }
  if (o !== payload.length) throw new Error('terrain overview binary: bytes left after its tiles');
  return out;
}

/** An overview blob: the header and the (compressed) payload. */
export function wrapTerrainOverview(compression: BinaryCompression, rawLength: number, stored: Uint8Array): Uint8Array {
  return wrapBinaryBlob(TERRAIN_OVERVIEW_MAGIC, compression, rawLength, stored);
}

/** An overview blob's header and stored payload (throws when it is not one). */
export function readTerrainOverviewBlob(blob: Uint8Array): { compression: BinaryCompression; rawLength: number; stored: Uint8Array } {
  const r = readBinaryBlob(blob, TERRAIN_OVERVIEW_MAGIC, 'terrain overview');
  return { compression: r.compression, rawLength: r.rawLength, stored: r.stored };
}

/** Whether bytes are a terrain overview blob. */
export function isTerrainOverviewBlob(blob: Uint8Array): boolean {
  return hasBinaryMagic(blob, TERRAIN_OVERVIEW_MAGIC);
}
