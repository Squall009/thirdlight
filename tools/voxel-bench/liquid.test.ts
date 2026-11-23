/**
 * Liquid in the derive: whether any output but the liquid's own reads a
 * liquid cell differently from air (the proof the narrowed feeds rest on),
 * on the lake and cave worlds cell for cell and on hand-made cases.
 */
import {
  chunkGrid,
  chunkOfKey,
  createWorldStore,
  deriveFromStore,
  encodeShader,
  openRegionsArrays,
  VOXEL_ROLE,
  WORLD_RULES,
  type ChunkCoord,
  type DerivedData,
  type PaletteStore,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { crc32 } from '@thirdlight/shared';
import { loadArea } from './regions';
import { putVoxel } from './scenes';
import { MAT } from './world-kit';
import { cavesWorld, hillyWorld } from './worlds';

const grid = chunkGrid(32);
const E = grid.edge;
const C = VOXEL_ROLE;

/** A CRC of views' bytes in turn. */
function crcOf(...a: ArrayBufferView[]): number {
  let n = 0;
  for (const v of a) n += v.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const v of a) {
    out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), o);
    o += v.byteLength;
  }
  return crc32(out);
}

/** Each consumer's bytes of a derived chunk (a CRC each): what a liquid-only change must leave as it is. */
function consumerHashes(d: DerivedData): Record<string, number> {
  const occ = d.occupancy;
  return {
    mesh: crcOf(d.ground.vertices, d.ground.indices, d.base.vertices, d.base.indices, d.instances.data),
    collision: crcOf(d.collision.boxes, d.collision.ramps.vertices, d.collision.ramps.indices, new Uint32Array([d.collision.fullBoxes])),
    nav: crcOf(...(d.nav.blocks === null ? [] : [d.nav.blocks]), d.nav.standable, d.nav.clearance, new Uint32Array([d.nav.blocking])),
    light: crcOf(...(d.light.full === null ? [] : [d.light.full]), d.light.partialCells, d.light.partialCover, new Int32Array([d.light.uniform])),
    occupancy: crcOf(occ.bricks, ...(occ.mask === null ? [] : [occ.mask]), new Uint32Array([occ.flag])),
    regions: d.regions == null ? 0 : crcOf(...openRegionsArrays(d.regions), new Int32Array([d.regions.count, d.regions.connect, d.regions.skyUniform])),
    shader: crc32(encodeShader(d.shader)),
  };
}

const coordOf = (key: number): ChunkCoord => chunkOfKey(grid, key, { cx: 0, cy: 0, cz: 0 });

/** Every chunk holding a liquid cell, and every chunk beside one (what a change of those cells can reach), with the liquid cells counted. */
function chunksNearLiquid(store: PaletteStore): { chunks: ChunkCoord[]; cells: number } {
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  const found = new Map<string, ChunkCoord>();
  let cells = 0;
  for (const key of store.chunkKeys()) {
    const c = coordOf(key);
    let has = false;
    for (let lx = 0; lx < E; lx++) for (let lz = 0; lz < E; lz++) for (let ly = 0; ly < E; ly++) {
      if (store.voxelAt(c.cx * E + lx, c.cy * E + ly, c.cz * E + lz, v).material !== 0 && v.role === C.liquid) {
        has = true;
        cells++;
      }
    }
    if (!has) continue;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = { cx: c.cx + dx, cy: c.cy + dy, cz: c.cz + dz };
      found.set(`${n.cx},${n.cy},${n.cz}`, n);
    }
  }
  return { chunks: [...found.values()], cells };
}

/** A copy of `store` with every liquid cell made air: every air ↔ liquid change at once. */
function drained(store: PaletteStore): PaletteStore {
  const out = createWorldStore(grid);
  for (const key of store.chunkKeys()) {
    const c = coordOf(key);
    out.adoptPayload(c.cx, c.cy, c.cz, store.chunkPayload(c.cx, c.cy, c.cz, true));
  }
  const v = { material: 0, role: 0, shape: 0, wetness: 0 };
  const air = { material: 0, role: 0, shape: 0, wetness: 0 };
  for (const key of store.chunkKeys()) {
    const c = coordOf(key);
    for (let lx = 0; lx < E; lx++) for (let lz = 0; lz < E; lz++) for (let ly = 0; ly < E; ly++) {
      const x = c.cx * E + lx;
      const y = c.cy * E + ly;
      const z = c.cz * E + lz;
      if (out.voxelAt(x, y, z, v).material !== 0 && v.role === C.liquid) out.setVoxel(x, y, z, air);
    }
  }
  return out;
}

/** Per consumer, the chunks whose bytes differ between the world with its liquid and without it. */
function differences(wet: PaletteStore, dry: PaletteStore, chunks: readonly ChunkCoord[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of chunks) {
    const a = consumerHashes(deriveFromStore(wet, c.cx, c.cy, c.cz, WORLD_RULES));
    const b = consumerHashes(deriveFromStore(dry, c.cx, c.cy, c.cz, WORLD_RULES));
    for (const k of Object.keys(a)) {
      out[k] ??= [];
      if (a[k] !== b[k]) out[k]!.push(`${c.cx},${c.cy},${c.cz}`);
    }
  }
  return out;
}

describe('liquid is open space to every consumer but its own', () => {
  it('derives the hilly world\'s lakes and the caves world\'s pools to the same mesh, collision, nav, light, occupancy, regions and shader data with the liquid as without it', { timeout: 300_000 }, () => {
    const report: Record<string, unknown> = {};
    for (const [name, w, area] of [
      // A small lake whole (open water and its shore) and a stretch of the large lake's shore.
      ['hilly small lake', hillyWorld(), [768, 800, 960, 1024]],
      ['hilly large lake', hillyWorld(), [-96, 1504, 96, 1760]],
      ['caves', cavesWorld({ footprint: 256 }), [0, 0, 256, 256]],
    ] as const) {
      const store = createWorldStore(grid);
      loadArea(w.grids[0]!, store, area[0], area[1], area[2], area[3]);
      const near = chunksNearLiquid(store);
      expect(near.cells, `${name}: liquid cells`).toBeGreaterThan(1000);
      const diff = differences(store, drained(store), near.chunks);
      report[name] = { liquidCells: near.cells, chunks: near.chunks.length, differing: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.length])) };
      for (const k of ['mesh', 'collision', 'nav', 'light', 'occupancy', 'regions', 'shader']) expect(diff[k], `${name}: ${k}`).toEqual([]);
    }
    console.log(JSON.stringify(report));
  });

  it('reads liquid under a gable roof, on the walls\' tops, as the air it stands in for (the roof words, the shader data)', () => {
    const wet = createWorldStore(grid);
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) putVoxel(wet, x, 0, z, MAT.grass, C.terrain);
    // A 45° gable roof over two walls whose tops lie one cell under it, that cell water: the roof mesher's "one air
    // cell over a body" (it closes the roof down onto the wall there).
    for (let z = 2; z < 10; z++) {
      for (let x = 1; x <= 9; x++) putVoxel(wet, x, 4 + Math.min(x - 1, 9 - x), z, MAT.rock, C.roof);
      for (const x of [2, 8]) {
        for (let y = 1; y <= 3; y++) putVoxel(wet, x, y, z, MAT.rock, C.wall);
        putVoxel(wet, x, 4, z, MAT.water, C.liquid);
      }
    }
    const dry = createWorldStore(grid);
    dry.adoptPayload(0, 0, 0, wet.chunkPayload(0, 0, 0, true));
    for (let z = 2; z < 10; z++) for (const x of [2, 8]) dry.setVoxel(x, 4, z, { material: 0, role: 0, shape: 0, wetness: 0 });
    const diff = differences(wet, dry, [{ cx: 0, cy: 0, cz: 0 }]);
    console.log(JSON.stringify(diff));
    for (const k of ['mesh', 'collision', 'nav', 'light', 'occupancy', 'regions', 'shader']) expect(diff[k], k).toEqual([]);
  });
});
