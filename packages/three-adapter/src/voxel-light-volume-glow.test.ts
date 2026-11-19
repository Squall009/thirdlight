/**
 * Emissive voxel materials, from the record to the light volume: the looks carry a record's glow (its colour × strength,
 * in linear light) and an instance inherits it; the material table holds it; the cells' glow words are the mean of
 * the glows of the solid cells across their faces (one value a material: its glow × its mean colour); a ray of the
 * update sees the glow as light given off (a white furnace with glowing walls, a glowing patch seen from above: closed
 * forms); and a record's glow change finds exactly the cells beside that material and marks what their light reaches.
 */
import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { MATERIAL_BITS, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderGridSide, VOXEL_SIZE_M, WETNESS_MAX } from '@thirdlight/voxel';

import { voxelStandInLook } from './voxel-chunk-view';
import { layerMeansOfSums, VolumeColourCache, volumeBrickGlows, volumeCellGlow, volumeLookGlow, volumeLookKey, volumeMaterialBox, volumeMaterialBricks } from './voxel-light-volume-colours';
import { VolumeLookWatch } from './voxel-light-volume-looks';
import { volumeDecode, volumeEncode, volumeMarkBoxes, type VolumeMarkable } from './voxel-light-volume-layout';
import { VolumeUpdateModel, volumeGlowDirect, volumePredicateSource, volumeReferenceFace, type VolumeLightWorld } from './voxel-light-volume-reference';
import { volumeBrickEmitters, volumeGlowBrickKey, volumeGlowFormFactor } from './voxel-light-volume-emitters';
import { VOLUME_GLOW_EMITTER, VOLUME_LAMP_FLOATS } from './voxel-light-volume-layout';
import { CLUSTER_RECT } from './cluster-build';
import { recordGlow, voxelLooksKey, voxelRecordLooks, type VoxelLookRecord } from './voxel-material-looks';
import { createVoxelSurface } from './voxel-surface';
import type { VoxelMaterialLook } from './voxel-surface';

const LAYOUT = { cellMetres: VOXEL_SIZE_M, side: shaderGridSide(32), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS };
const lin = (hex: number): [number, number, number] => {
  const c = new Color().setHex(hex);
  return [c.r, c.g, c.b];
};

const records: VoxelLookRecord[] = [
  { materialId: 'lava', shader: 'standard', params: { color: '#a04020', emissive: '#ff6010', emissiveIntensity: 3 }, voxel: { id: 20, use: 'terrain' } },
  // An instance: its own voxel id, the parent's glow colour, its own strength.
  { materialId: 'lava-dim', shader: 'standard', params: { emissiveIntensity: 0.5 }, instanceOf: 'lava', voxel: { id: 21 } },
  // Black glow and no strength: dark.
  { materialId: 'coal', shader: 'standard', params: { emissive: '#000000', emissiveIntensity: 4 }, voxel: { id: 22, use: 'terrain' } },
  { materialId: 'stone', shader: 'standard', params: { color: '#808080', emissive: '#00ffff', emissiveIntensity: 0 }, voxel: { id: 23, use: 'construction' } },
];

describe('emissive voxel materials: the looks and the table', () => {
  it("carry a record's glow (colour × strength, linear) and inherit it along an instance chain; dark records have none", () => {
    const look = voxelRecordLooks(records);
    const fire = lin(0xff6010);
    expect(look(20).glow).toEqual(fire.map((v) => v * 3));
    expect(look(21).glow).toEqual(fire.map((v) => v * 0.5));
    expect(look(22).glow).toBeUndefined();
    expect(look(23).glow).toBeUndefined();
    expect(look(5)).toEqual(voxelStandInLook(5));
    expect(recordGlow({ emissive: 'ff6010', emissiveIntensity: 2 })).toEqual(fire.map((v) => v * 2));
    expect(recordGlow({ emissiveIntensity: 2 })).toBeNull();
  });

  it('change their key when a glow parameter changes, and only then', () => {
    const key = voxelLooksKey(records);
    expect(voxelLooksKey(records.map((r) => (r.materialId === 'lava' ? { ...r, params: { ...r.params, emissiveIntensity: 4 } } : r)))).not.toBe(key);
    expect(voxelLooksKey(records.map((r) => (r.materialId === 'lava' ? { ...r, params: { ...r.params, emissive: '#ff6011' } } : r)))).not.toBe(key);
    expect(voxelLooksKey(records.map((r) => (r.materialId === 'lava' ? { ...r, params: { ...r.params, roughness: 0.2 } } : r)))).toBe(key);
  });

  it("hold each id's glow in the material table (the a of the tiles, relief and layer blocks), 0 where none, the layers set after it kept", () => {
    const look = voxelRecordLooks(records);
    const surface = createVoxelSurface(LAYOUT, { look, blendMetres: 0.25 });
    expect(surface.tableEntry(20).glow.map((v) => Math.fround(v))).toEqual(look(20).glow!.map((v) => Math.fround(v)));
    expect(surface.tableEntry(23).glow).toEqual([0, 0, 0]);
    expect(surface.tableEntry(0).glow).toEqual([0, 0, 0]);
    // The texture layers written over the same block keep the glow.
    surface.setTextures({}, (m) => (m === 20 ? [0, 1, 2] : null));
    expect(surface.tableEntry(20).layers).toEqual([0, 1, 2]);
    expect(surface.tableEntry(20).glow.map((v) => Math.fround(v))).toEqual(look(20).glow!.map((v) => Math.fround(v)));
    expect(surface.tableEntry(23).layers).toEqual([-1, -1, -1]);
    surface.dispose();
  });
});

/** A 34³ shader grid (border included) from a cell rule in chunk (0, 0, 0)'s cells (−1 … 32). */
function gridOf(entry: (x: number, y: number, z: number) => number): Uint16Array {
  const S = 34;
  const g = new Uint16Array(S ** 3);
  for (let x = -1; x <= 32; x++) for (let z = -1; z <= 32; z++) for (let y = -1; y <= 32; y++) g[((x + 1) * S + (z + 1)) * S + (y + 1)] = entry(x, y, z);
  return g;
}

describe('emissive voxel materials: the cells beside them', () => {
  // A scrap: ground of stone (23) up to y 3, a lava strip (20) in it at x 8 … 11, a dim lava cube (21) at (20, 4, 20) on
  // it, a wall of the dim lava at z 30 … 31 from x 0 to 5 up to y 8 beside stone.
  const entry = (x: number, y: number, z: number): number => {
    if (x === 20 && y === 4 && z === 20) return 21;
    if (z >= 30 && x <= 5 && y <= 8) return 21;
    if (y > 3) return 0;
    if (y === 3 && x >= 8 && x <= 11) return 20;
    return 23;
  };
  const grid = gridOf(entry);
  const look = voxelRecordLooks(records);
  // The mean colour of a flat look is its tint: lava's #a04020; the stone's is not looked at (it does not glow).
  const means = new Map<number, [number[] | null, number[] | null, number[] | null]>([[23, [[0.5, 0.5, 0.5], null, null]]]);
  const colours = new VolumeColourCache(look, means);

  it("holds one value a material: its glow × its mean colour (the tint × the wall set's mean, the tint alone without one)", () => {
    const tint = lin(0xa04020);
    expect(volumeLookGlow(look(20), null)).toEqual(look(20).glow!.map((v, k) => v * tint[k]!));
    // With a texture mean: × the wall set's.
    expect(volumeLookGlow(look(20), [[0.5, 0.25, 1], null, [0, 0, 0]])).toEqual(look(20).glow!.map((v, k) => v * tint[k]! * [0.5, 0.25, 1][k]!));
    expect(volumeLookGlow(look(23), [[0.5, 0.5, 0.5], null, null])).toBeNull();
  });

  it("writes each open cell the mean of the glows across its faces, against a cell-by-cell reference; a cell bordering none holds 0", () => {
    const glowOf = (e: number): readonly number[] => volumeLookGlow(look(e), means.get(e) ?? null) ?? [0, 0, 0];
    let lit = 0;
    let dark = 0;
    const words = new Uint32Array(64);
    for (let bx = 0; bx < 8; bx++) for (let by = 0; by < 4; by++) for (let bz = 0; bz < 8; bz++) {
      const any = volumeBrickGlows(bx, by, bz, new Map([['0,0,0', grid]]), colours, words);
      let some = false;
      for (let lz = 0; lz < 4; lz++) for (let ly = 0; ly < 4; ly++) for (let lx = 0; lx < 4; lx++) {
        const [x, y, z] = [bx * 4 + lx, by * 4 + ly, bz * 4 + lz];
        const w = words[lx + 4 * (ly + 4 * lz)]!;
        expect(w).toBe(volumeCellGlow(grid, [0, 0, 0], x, y, z, colours));
        // The reference: open, the six neighbours' glows summed over those holding a material.
        const ns = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => entry(x + dx!, y + dy!, z + dz!)).filter((e) => e !== 0);
        const sum = [0, 1, 2].map((k) => ns.reduce((s, e) => s + glowOf(e)[k]!, 0));
        if (entry(x, y, z) !== 0 || sum.every((v) => v === 0)) {
          expect(w, `cell ${x},${y},${z}`).toBe(0);
          if (entry(x, y, z) === 0 && ns.length > 0) dark++;
          continue;
        }
        some = true;
        lit++;
        const want = sum.map((v) => v / ns.length);
        const got = volumeDecode(w);
        // RGB9E5: 9 bits under the largest channel's exponent.
        const tol = Math.max(...want) / 256;
        for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!), `cell ${x},${y},${z} channel ${k}`).toBeLessThanOrEqual(tol);
      }
      expect(any).toBe(some);
    }
    // Over the strip (one face: the whole glow), its sides (half), beside the cube and up the wall.
    expect(lit).toBeGreaterThan(40);
    expect(dark).toBeGreaterThan(500);
    const over = volumeDecode(volumeCellGlow(grid, [0, 0, 0], 9, 4, 5, colours));
    expect(over[0]).toBeCloseTo(glowOf(20)[0]!, 1);
    const corner = volumeDecode(volumeCellGlow(grid, [0, 0, 0], 5, 4, 29, colours));
    // Beside the wall (z 30) and over the stone (y 3): half the dim lava's glow.
    expect(corner[0]).toBeCloseTo(glowOf(21)[0]! / 2, 2);
  });

  it("finds exactly the open cells beside a changed material (none for one that is not there), and the bricks they lie in", () => {
    for (const id of [20, 21]) {
      const box = volumeMaterialBox(grid, new Set([id]))!;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) {
        if (entry(x, y, z) !== 0) continue;
        const borders = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => entry(x + dx!, y + dy!, z + dz!) === id);
        if (!borders) continue;
        [x, y, z].forEach((v, k) => {
          lo[k] = Math.min(lo[k]!, v);
          hi[k] = Math.max(hi[k]!, v);
        });
      }
      expect(box).toEqual([lo, hi]);
    }
    expect(volumeMaterialBox(grid, new Set([22]))).toBeNull();
    expect(volumeMaterialBox(7, new Set([7]))).toBeNull();
    // The strip's cells (x 8 … 11, y 4, every z) as world bricks of a chunk one along x.
    expect(volumeMaterialBox(grid, new Set([20]))).toEqual([[8, 4, 0], [11, 4, 31]]);
    expect(volumeMaterialBricks(grid, [1, 0, 0], new Set([20]))).toEqual([[10, 1, 0], [10, 1, 7]]);
  });

  it("marks, for a record's glow change, exactly the bricks a ray from which reaches those cells (from nothing beside them, half within the reach)", () => {
    const box = volumeMaterialBricks(grid, [0, 0, 0], new Set([21]))!;
    const bricks: (VolumeMarkable & { was: number })[] = [];
    for (let x = -10; x < 18; x++) for (let y = -4; y < 8; y++) for (let z = -10; z < 18; z++) bricks.push({ bx: x, by: y, bz: z, level: 0, updates: 30, was: 30 });
    const reach = 12;
    const marked = new Set(volumeMarkBoxes(bricks, [box], [reach, 6, 3, 2], 8));
    for (const b of bricks) {
      const gap = Math.max(...[b.bx, b.by, b.bz].map((v, a) => (v < box[0][a]! ? box[0][a]! - v : v > box[1][a]! ? v - box[1][a]! : 0)));
      expect(marked.has(b), `brick ${b.bx},${b.by},${b.bz} gap ${gap}`).toBe(gap <= reach);
      if (gap <= 2) expect(b.updates).toBe(0);
      else if (gap <= reach) expect(b.updates).toBe(4);
      else expect(b.updates).toBe(30);
    }
  });

  it("glows by the mean of what it draws: the wall set's colour × glow mask where the mask was read, its colour mean (as before) where it is 1 or was not read", () => {
    const tint = lin(0xa04020);
    const colour = [0.5, 0.25, 0.8];
    // The pass's sums: the coarse colour, and over the finer level colour × mask (mask a third of the texels) and colour.
    const col = [0.52, 0.24, 0.82];
    const prod = [0.52 * 0.3, 0.24 * 0.35, 0.82 * 0.3, 0.32];
    const masked = layerMeansOfSums(colour, prod, col, (c) => c);
    expect(masked.slice(0, 3)).toEqual(colour);
    expect(masked.slice(3, 6).map((v) => Number(v.toFixed(6)))).toEqual([0.5 * 0.3, 0.25 * 0.35, 0.8 * 0.3].map((v) => Number(v.toFixed(6))));
    const want = look(20).glow!.map((v, k) => v * tint[k]! * masked[3 + k]!);
    volumeLookGlow(look(20), [masked, null, null])!.forEach((v, k) => expect(v).toBeCloseTo(want[k]!, 12));
    // A mask of 1 everywhere: the pass's drawn mean is the colour mean exactly, so the value is the one without a mask.
    const unmasked = layerMeansOfSums(colour, [...col, 1], col, (c) => c);
    expect(unmasked.slice(3, 6)).toEqual(colour);
    expect(volumeLookGlow(look(20), [unmasked, null, null])).toEqual(volumeLookGlow(look(20), [colour, null, null]));
    // sRGB bytes in a plain format: the colour made linear, the mask's share kept.
    const srgb = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    expect(layerMeansOfSums(colour, [...col, 1], col, srgb).slice(3, 6)).toEqual(colour.map(srgb));
    // A channel black over the finer level: its share is the mask's mean (nothing glows there either way).
    expect(layerMeansOfSums([0, 0.5, 0.5], [0, 0.1, 0.1, 0.25], [0, 0.4, 0.4], (c) => c)[3]).toBe(0);
  });

  it("marks the bricks bordering a material whose glow mask's mean changed (a texture change), and only that material", () => {
    const watch = new VolumeLookWatch();
    const at = (mask: number): Map<number, [number[] | null, number[] | null, number[] | null]> => new Map([[20, [[0.5, 0.5, 0.5, 0.5 * mask, 0.5 * mask, 0.5 * mask], null, null]], [21, [[0.5, 0.5, 0.5], null, null]], [23, [[0.5, 0.5, 0.5], null, null]]]);
    expect(watch.changed(look, at(1), ['0,0,0'])).toBe(0);
    expect(watch.changed(look, at(1), ['0,0,0'])).toBe(0);
    expect(watch.changed(look, at(0.3), ['0,0,0'])).toBe(1);
    const found: [readonly number[], readonly number[]][] = [];
    watch.drain(() => true, new Map([['0,0,0', grid]]), (lo, hi) => void found.push([lo, hi]));
    expect(found).toEqual([volumeMaterialBricks(grid, [0, 0, 0], new Set([20]))]);
  });

  it("changes a look's key for the volume exactly when its glow or bounce colours do", () => {
    const a: VoxelMaterialLook = { colour: 0xa04020, pattern: 0, glow: [1, 0.5, 0] };
    expect(volumeLookKey(a, null)).toBe(volumeLookKey({ ...a, constructionTileMetres: 2 }, null));
    expect(volumeLookKey(a, null)).not.toBe(volumeLookKey({ ...a, glow: [1, 0.5, 0.1] }, null));
    expect(volumeLookKey(a, null)).not.toBe(volumeLookKey({ ...a, colour: 0xa04021 }, null));
  });
});

/** A sky of nothing, no sun, no lamps: the box's glow alone lights it. */
function glowWorld(solid: (x: number, y: number, z: number) => boolean, glow: (x: number, y: number, z: number) => number, albedo: number): VolumeLightWorld {
  // The update's rule: an open cell's glow is the mean of the glows of its solid neighbours.
  const cellGlow = (air: readonly number[]): number[] => {
    let s = 0;
    let n = 0;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const c = [air[0]! + dx, air[1]! + dy, air[2]! + dz] as const;
      if (!solid(c[0], c[1], c[2])) continue;
      n++;
      s += glow(c[0], c[1], c[2]);
    }
    const v = n === 0 ? 0 : s / n;
    return volumeDecode(v > 0 ? volumeEncode(v, v, v) : 0);
  };
  return { src: volumePredicateSource(solid, [-2, -2, -2], [2, 2, 2]), sky: new Float32Array(12), sun: new Float32Array(7), lamps: new Float32Array(0), lampCount: 0, albedo: () => [albedo, albedo, albedo], glow: (air) => cellGlow(air) };
}

const grey = (c: readonly number[] | null | undefined): number => (c === null || c === undefined ? 0 : (c[0]! + c[1]! + c[2]!) / 3);
const mean = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / v.length;

/** The form factor from a point to a parallel a × b rectangle whose corner lies on its normal, h away (closed form). */
function cornerFormFactor(a: number, b: number, h: number): number {
  const A = a / h;
  const B = b / h;
  return (A / Math.sqrt(1 + A * A)) * Math.atan(B / Math.sqrt(1 + A * A)) / (2 * Math.PI) + (B / Math.sqrt(1 + B * B)) * Math.atan(A / Math.sqrt(1 + B * B)) / (2 * Math.PI);
}

describe('emissive voxel materials: the update sees the glow as light given off (closed forms)', () => {
  const BOX = 10;
  const box = (x: number, y: number, z: number): boolean => !(x >= 0 && x < BOX && y >= 0 && y < BOX && z >= 0 && z < BOX);

  it('the white furnace: a closed box whose walls all glow (radiance Le) and bounce ρ holds π Le / (1 − ρ) on every face', () => {
    const LE = 2;
    const RHO = 0.7;
    const w = glowWorld(box, () => LE, RHO);
    const m = new VolumeUpdateModel(w, [0, 0, 0], [BOX, BOX, BOX], { rays: 4, reach: 24, sunReach: 48, filter: false });
    const closed = (Math.PI * LE) / (1 - RHO);
    // Bounces build over the updates; refined to the volume's whole history the mean holds them.
    for (let i = 0; i < 8; i++) m.step();
    const first = mean([...m.cells.values()].flatMap((c) => c.faces.filter((f) => f !== null).map(grey))) / closed;
    for (let i = 8; i < 64; i++) m.step();
    const refined = mean([...m.cells.values()].flatMap((c) => c.faces.filter((f) => f !== null).map(grey))) / closed;
    console.log(`[glow furnace] the glowing box's faces against π Le / (1 − ρ): first settle ${first.toFixed(3)}, refined to 64 updates ${refined.toFixed(3)}`);
    expect(first).toBeGreaterThan(0.6);
    expect(refined).toBeGreaterThan(0.95);
    expect(refined).toBeLessThan(1.06);
  }, 30_000);

  it("a glowing 2 × 2 m patch in a black box's floor lights the ceiling's cell over its middle by π Le × the form factor", () => {
    const LE = 3;
    const solid = box;
    // The patch: floor cells x, z 3 … 6 (2 m square, its middle at 2.5 m), the floor's top at y 0.
    const glow = (x: number, y: number, z: number): number => (y === -1 && x >= 3 && x <= 6 && z >= 3 && z <= 6 ? LE : 0);
    const w = glowWorld(solid, glow, 0);
    // The ceiling's cell over the patch's middle corner: its centre (2.25, 4.75, 2.25)... the cell over (5, 9, 5) is
    // centred at (2.75, 4.75, 2.75); its down face looks at the patch 4.75 m below.
    const cell = [4, 9, 4];
    const p = [(cell[0]! + 0.5) * 0.5, (cell[2]! + 0.5) * 0.5];
    const h = (cell[1]! + 0.5) * 0.5;
    // Four corner rectangles round the point's foot, the patch spanning 1.5 … 3.5 m.
    const sides = [[p[0]! - 1.5, p[1]! - 1.5], [3.5 - p[0]!, p[1]! - 1.5], [p[0]! - 1.5, 3.5 - p[1]!], [3.5 - p[0]!, 3.5 - p[1]!]];
    const closed = Math.PI * LE * sides.reduce((s, [a, b]) => s + cornerFormFactor(a!, b!, h), 0);
    const ref = grey(volumeReferenceFace(w, cell, 3, { rays: 20000, bounces: 0, reach: 24 }));
    // The patch is found by about 5 % of a face's rays: one update's estimate with 4,096 of them lies 0.75–1.12 of it
    // over ten seeds, so the mean of eight such (a face's whole history is 256 rays: the small emitter's noise).
    const got = mean(Array.from({ length: 8 }, (_, seed) => {
      const m = new VolumeUpdateModel(w, [4, 9, 4], [5, 10, 5], { rays: 4096, reach: 24, sunReach: 48, filter: false, seed });
      m.step();
      return grey(m.cells.get(cell.join(','))!.faces[3]);
    }));
    console.log(`[glow patch] the ceiling cell's down face: closed form ${closed.toFixed(4)}, the reference ${ref.toFixed(4)} (${(ref / closed).toFixed(3)}), the update's model ${got.toFixed(4)} (${(got / closed).toFixed(3)})`);
    // 20,000 rays: about 3 % noise; the model's eight estimates about 4 %.
    expect(ref / closed).toBeGreaterThan(0.97);
    expect(ref / closed).toBeLessThan(1.03);
    expect(got / closed).toBeGreaterThan(0.85);
    expect(got / closed).toBeLessThan(1.15);
  }, 30_000);
});

describe("emissive voxel materials: the glowing faces' emitters a cell aims at", () => {
  const LE = 2;
  const glowLooks = (m: number): VoxelMaterialLook => (m === 20 ? { colour: 0xffffff, pattern: 0, glow: [LE, LE, LE] } : { colour: 0xffffff, pattern: 0 });

  it('takes the exact form factor to a rectangle, clipped to the horizon, nothing from its back', () => {
    // A 2 × 3 m rectangle 1.5 m over a point facing it, its corner on the point's normal (the closed form).
    const p = [0, 0, 0];
    const up = [0, 1, 0];
    expect(volumeGlowFormFactor(p, up, [1, 1.5, 1.5], [1, 0, 0], [0, 0, 1.5])).toBeCloseTo(cornerFormFactor(2, 3, 1.5), 6);
    // Its back: none.
    expect(volumeGlowFormFactor(p, up, [1, 1.5, 1.5], [1, 0, 0], [0, 0, -1.5])).toBe(0);
    // A wall rising from the point's plane and dipping 1 m below it (a strip's side seen from a cell over the floor):
    // the part above the horizon only, the same as the rectangle cut at it.
    const cut = volumeGlowFormFactor(p, up, [1, 0.5, 2], [1, 0, 0], [0, -1.5, 0]);
    expect(cut).toBeCloseTo(volumeGlowFormFactor(p, up, [1, 1, 2], [1, 0, 0], [0, -1, 0]), 6);
    expect(cut).toBeGreaterThan(0);
  });

  it("makes one rectangle a brick and facing over its glowing faces, their power over its area, lit on the open side", () => {
    // A strip of lava 4 cells along x in a stone floor (its top at y 2 m), and a one-cell lava block on the floor beside it.
    const entry = (x: number, y: number, z: number): number => (y <= 3 ? (y === 3 && z === 5 && x >= 4 && x <= 7 ? 20 : 23) : x === 1 && y === 4 && z === 5 ? 20 : 0);
    const grids = new Map([['0,0,0', gridOf(entry)]]);
    const colours = new VolumeColourCache(glowLooks, null);
    // The strip's open cells (y 4) lie in brick (1, 1, 1): one emitter facing up, 2 × 0.5 m at y 2 m.
    const strip = volumeBrickEmitters(1, 1, 1, grids, colours, 24);
    expect(strip.length).toBe(VOLUME_LAMP_FLOATS);
    expect(Array.from(strip.subarray(0, 8))).toEqual([3, 2, 2.75, 24, LE * 1, LE * 1, LE * 1, 2]);
    expect(strip[9]).toBe(1);
    expect(strip[11]).toBe(CLUSTER_RECT | VOLUME_GLOW_EMITTER);
    expect(strip[15]).toBe(volumeGlowBrickKey(1, 1, 1));
    // Lit above it, dark below its plane.
    const w = glowWorld((x, y, z) => entry(x, y, z) !== 0, () => 0, 0);
    expect(volumeGlowDirect(w, [3, 3, 2.75], [0, -1, 0], strip, [0.5, 0.5])[0]).toBeGreaterThan(0);
    expect(volumeGlowDirect(w, [3, 1, 2.75], [0, 1, 0], strip, [0.5, 0.5])[0]).toBe(0);
    // The block's open cells round it (brick 0, 1, 1): its top and four sides, five emitters, its power 0.25 m² each.
    const block = volumeBrickEmitters(0, 1, 1, grids, colours, 24);
    expect(block.length / VOLUME_LAMP_FLOATS).toBe(5);
    for (let o = 0; o < block.length; o += VOLUME_LAMP_FLOATS) expect(block[o + 4]).toBeCloseTo(LE * 0.25, 9);
    expect(volumeBrickEmitters(5, 5, 5, grids, colours, 24).length).toBe(0);
  });

  it('the white furnace with every wall an emitter: aimed at, the glow is counted once (π Le / (1 − ρ)) and is even sooner', () => {
    const BOX = 10;
    const RHO = 0.7;
    const box = (x: number, y: number, z: number): boolean => !(x >= 0 && x < BOX && y >= 0 && y < BOX && z >= 0 && z < BOX);
    const grids = new Map([['0,0,0', gridOf((x, y, z) => (box(x, y, z) ? 20 : 0))]]);
    const colours = new VolumeColourCache(glowLooks, null);
    const parts: Float32Array[] = [];
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) parts.push(volumeBrickEmitters(x, y, z, grids, colours, 24));
    const emitters = new Float32Array(parts.reduce((n, e) => n + e.length, 0));
    let o = 0;
    for (const e of parts) {
      emitters.set(e, o);
      o += e.length;
    }
    const w = glowWorld(box, () => LE, RHO);
    const closed = (Math.PI * LE) / (1 - RHO);
    const faces = (m: VolumeUpdateModel): number[] => [...m.cells.values()].flatMap((c) => c.faces.filter((f) => f !== null).map(grey));
    const aimed = new VolumeUpdateModel(w, [0, 0, 0], [BOX, BOX, BOX], { rays: 4, reach: 24, sunReach: 48, filter: false, emitters });
    const found = new VolumeUpdateModel(w, [0, 0, 0], [BOX, BOX, BOX], { rays: 4, reach: 24, sunReach: 48, filter: false });
    for (let i = 0; i < 8; i++) {
      aimed.step();
      found.step();
    }
    const spread = (v: number[]): number => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2))) / mean(v);
    const first = { aimed: mean(faces(aimed)) / closed, found: mean(faces(found)) / closed, aimedSpread: spread(faces(aimed)), foundSpread: spread(faces(found)) };
    for (let i = 8; i < 64; i++) aimed.step();
    const refined = mean(faces(aimed)) / closed;
    console.log(`[glow emitters furnace] at the first settle aimed ${first.aimed.toFixed(3)} (spread ${first.aimedSpread.toFixed(3)}), found by rays ${first.found.toFixed(3)} (spread ${first.foundSpread.toFixed(3)}); aimed refined to 64 updates ${refined.toFixed(3)}`);
    expect(refined).toBeGreaterThan(0.95);
    expect(refined).toBeLessThan(1.06);
    // Aimed or found, the box's glow is the same light (none counted twice, none lost).
    expect(Math.abs(first.aimed - first.found)).toBeLessThan(0.02);
  }, 60_000);

  it("a glowing 2 × 2 m patch seen from the ceiling: one update's 4 rays aimed at its emitter hold its light (π Le × the form factor), where rays alone need thousands", () => {
    const BOX = 10;
    const box = (x: number, y: number, z: number): boolean => !(x >= 0 && x < BOX && y >= 0 && y < BOX && z >= 0 && z < BOX);
    const patch = (x: number, y: number, z: number): boolean => y === -1 && x >= 3 && x <= 6 && z >= 3 && z <= 6;
    const grids = new Map([['0,0,0', gridOf((x, y, z) => (patch(x, y, z) ? 20 : box(x, y, z) ? 23 : 0))]]);
    const colours = new VolumeColourCache(glowLooks, null);
    const parts = [0, 1].flatMap((x) => [0, 1].map((z) => volumeBrickEmitters(x, 0, z, grids, colours, 24)));
    const emitters = new Float32Array(parts.reduce((n, e) => n + e.length, 0));
    parts.reduce((o, e) => (emitters.set(e, o), o + e.length), 0);
    const w = glowWorld(box, (x, y, z) => (patch(x, y, z) ? LE : 0), 0);
    const cell = [4, 9, 4];
    const p = [(cell[0]! + 0.5) * 0.5, (cell[2]! + 0.5) * 0.5];
    const h = (cell[1]! + 0.5) * 0.5;
    const sides = [[p[0]! - 1.5, p[1]! - 1.5], [3.5 - p[0]!, p[1]! - 1.5], [p[0]! - 1.5, 3.5 - p[1]!], [3.5 - p[0]!, 3.5 - p[1]!]];
    const closed = Math.PI * LE * sides.reduce((sum, [a, b]) => sum + cornerFormFactor(a!, b!, h), 0);
    const one = (seed: number, e?: Float32Array): number => {
      const m = new VolumeUpdateModel(w, [4, 9, 4], [5, 10, 5], { rays: 4, reach: 24, sunReach: 48, filter: false, seed, ...(e !== undefined ? { emitters: e } : {}) });
      m.step();
      return grey(m.cells.get(cell.join(','))!.faces[3]) / closed;
    };
    const aimed = Array.from({ length: 8 }, (_, seed) => one(seed, emitters));
    const found = Array.from({ length: 8 }, (_, seed) => one(seed));
    console.log(`[glow emitters patch] one update of 4 rays against π Le F: aimed ${aimed.map((v) => v.toFixed(2)).join(' ')}; rays alone ${found.map((v) => v.toFixed(2)).join(' ')}`);
    for (const v of aimed) {
      expect(v).toBeGreaterThan(0.85);
      expect(v).toBeLessThan(1.15);
    }
  });
});
