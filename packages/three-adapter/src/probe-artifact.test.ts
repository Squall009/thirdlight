import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PROBE_ARTIFACT_ROW_PROBES, PROBE_FILLED, PROBE_GPU_TEXELS, PROBE_MOVED, PROBE_SH_TEXELS, PROBE_TEXELS, PROBE_VALID, probeGridGpuBytes } from '@thirdlight/runtime';

import { atlasFromSamples, decodeProbeArtifact, decodeProbeSamples, encodePng16, packProbeTexels } from './probe-artifact';
import { edgeWalls } from './probe-bake';
import { packProbeTile, PROBE_WEIGHT_FILLED, PROBE_WEIGHT_MOVED } from './probe-pack';

const half = (v: number): number => THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(v));

describe('probe artifact', () => {
  it("round-trips through a 16-bit PNG into three's atlas layout, with each probe's validity and its walls", async () => {
    // More probes than one artifact row holds, so rows wrap.
    const resolution: [number, number, number] = [9, 8, 9];
    const n = resolution[0] * resolution[1] * resolution[2];
    expect(n).toBeGreaterThan(PROBE_ARTIFACT_ROW_PROBES);
    const sh = new Float32Array(n * 27);
    for (let i = 0; i < sh.length; i++) sh[i] = ((i % 97) - 40) / 8; // negative SH terms and values over 1
    const validity = new Float32Array(n).map((_, i) => [PROBE_VALID, PROBE_MOVED, PROBE_FILLED][i % 3]!);
    // Per axis a cut flag and where: x cut at a quarter on every fifth probe.
    const walls = new Float32Array(n * 6).map((_, i) => (i % 6 === 0 ? (Math.floor(i / 6) % 5 === 0 ? 1 : 0) : i % 6 === 1 ? 0.25 : 0));
    const packed = packProbeTexels(sh, validity, walls);
    const png = await encodePng16(packed.width, packed.height, packed.samples);
    const decoded = decodeProbeArtifact(png, { resolution });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Array.from(decoded.validity)).toEqual(Array.from(validity));
    const [nx, ny, nz] = resolution;
    const padded = nz + 2;
    // A probe's coefficient c (channel ch) sits in sub-volume floor(v / 4), channel v % 4, v = 3c + ch.
    const atlasAt = (ix: number, iy: number, slice: number, ch: number): number => THREE.DataUtils.fromHalfFloat(decoded.atlas[((slice * ny + iy) * nx + ix) * 4 + ch]!);
    for (const [ix, iy, iz] of [[0, 0, 0], [8, 7, 8], [3, 5, 4]] as const) {
      const p = ix + iy * nx + iz * nx * ny;
      for (let v = 0; v < 27; v++) {
        const t = Math.floor(v / 4);
        expect(atlasAt(ix, iy, t * padded + 1 + iz, v % 4)).toBeCloseTo(half(sh[p * 27 + v]!), 6);
      }
      // (cut x, cut x × where x, …): the where is stored times the flag, so the filter interpolates both.
      const cut = walls[p * 6]!;
      expect(atlasAt(ix, iy, PROBE_SH_TEXELS * padded + 1 + iz, 0)).toBe(cut);
      expect(atlasAt(ix, iy, PROBE_SH_TEXELS * padded + 1 + iz, 1)).toBe(cut * 0.25);
    }
    // The padding slices copy the edge slices.
    expect(atlasAt(2, 2, 0, 0)).toBe(atlasAt(2, 2, 1, 0));
    expect(atlasAt(2, 2, padded - 1, 0)).toBe(atlasAt(2, 2, padded - 2, 0));
    expect(decoded.atlas.byteLength).toBe(nx * ny * PROBE_TEXELS * padded * 8);
    expect(probeGridGpuBytes({ resolution })).toBe(nx * ny * PROBE_GPU_TEXELS * padded * 8);
    // The streaming read (native inflate) gives the file's samples exactly.
    const streamed = await decodeProbeSamples(png, { resolution });
    expect(streamed.ok).toBe(true);
    if (!streamed.ok) return;
    expect(streamed.samples).toEqual(packed.samples);
    expect(Array.from(streamed.validity)).toEqual(Array.from(validity));
  });

  it('refuses a file of the wrong size', async () => {
    const packed = packProbeTexels(new Float32Array(8 * 27), new Float32Array(8));
    const png = await encodePng16(packed.width, packed.height, packed.samples);
    expect(decodeProbeArtifact(png, { resolution: [3, 3, 3] }).ok).toBe(false);
    expect((await decodeProbeSamples(png, { resolution: [3, 3, 3] })).ok).toBe(false);
    // A file cut short does not inflate to its image.
    expect((await decodeProbeSamples(png.subarray(0, png.length - 20), { resolution: [2, 2, 2] })).ok).toBe(false);
  });
});

describe('probe walls', () => {
  it('an edge is cut where both its probes see a surface before the other', () => {
    // 3 × 2 × 2 probes 2 m apart; along x the probes at x = 2 and 4 see a wall at x = 2.8…3.2; one probe at x = 0 sees a post 1 m up.
    const grid = { min: [0, 0, 0] as [number, number, number], max: [4, 2, 2] as [number, number, number], resolution: [3, 2, 2] as [number, number, number] };
    const along = new Float32Array(12 * 6);
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 1) along[i * 6] = 0.8; // +x from x = 2: the wall's near face at 2.8
      if (i % 3 === 2) along[i * 6 + 1] = 0.8; // −x from x = 4: its far face at 3.2
    }
    along[0 * 6 + 2] = 1; // +y from the first probe sees something its upper neighbour does not
    const walls = new Float32Array(12 * 6);
    edgeWalls(grid, along, walls);
    // x edges from x = 2 are cut in the wall's middle (3.0: half the edge); those from x = 0 are not.
    expect([walls[1 * 6], walls[1 * 6 + 1]]).toEqual([1, 0.5]);
    expect(walls[0 * 6]).toBe(0);
    // One side seeing a surface does not cut an edge.
    expect(walls[0 * 6 + 2]).toBe(0);
    // The last plane along an axis has no edge there.
    expect(walls[2 * 6]).toBe(0);
  });
});

describe('probe packing', () => {
  it('packs a tile on its own: first-order light weighted by validity, the weight, the walls as they are', () => {
    const tile = (resolution: [number, number, number], value: number, validity: number) => {
      const n = resolution[0] * resolution[1] * resolution[2];
      // Coefficient c's channels: value × (c + 1), so each lands where it should.
      const sh = new Float32Array(n * 27).map((_, i) => value * (Math.floor((i % 27) / 3) + 1));
      const v = new Float32Array(n).fill(validity);
      // Every edge cut at its middle (cut flag 1, share 0.5).
      const walls = new Float32Array(n * 6).map((_, i) => (i % 2 === 0 ? 1 : 0.5));
      return packProbeTile({ resolution }, packProbeTexels(sh, v, walls).samples, v);
    };
    const valid = tile([2, 2, 2], 1, PROBE_VALID);
    expect([valid.nx, valid.ny, valid.depth]).toEqual([2, 2, PROBE_GPU_TEXELS * (2 + 2)]);
    expect(valid.data.length).toBe(probeGridGpuBytes({ resolution: [2, 2, 2] }) / 2);
    const at = (p: { data: Uint16Array; nx: number; ny: number }, x: number, y: number, slice: number, ch: number): number => THREE.DataUtils.fromHalfFloat(p.data[((slice * p.ny + y) * p.nx + x) * 4 + ch]!);
    // Texel 0: band 0 × weight, the weight; texel 1: the y term, the z term's red; texel 3: the x term's blue (4 slices a sub-volume).
    expect([at(valid, 0, 0, 1, 0), at(valid, 0, 0, 1, 3)]).toEqual([1, 1]);
    expect(at(valid, 0, 0, 4 + 1, 0)).toBe(2);
    expect(at(valid, 0, 0, 4 + 1, 3)).toBe(3);
    expect(at(valid, 0, 0, 3 * 4 + 1, 0)).toBe(4);
    const moved = tile([3, 2, 3], 2, PROBE_MOVED);
    expect(at(moved, 2, 0, 1, 0)).toBeCloseTo(2 * PROBE_WEIGHT_MOVED, 3);
    expect(at(moved, 2, 0, 1, 3)).toBeCloseTo(PROBE_WEIGHT_MOVED, 3);
    const filled = tile([2, 3, 2], 4, PROBE_FILLED);
    expect(at(filled, 0, 2, 1, 0)).toBeCloseTo(4 * PROBE_WEIGHT_FILLED, 3);
    // The walls (texels 4 and 5) unweighted; the padding slices copy the edge layers.
    expect([at(moved, 2, 0, 4 * 5 + 1, 0), at(moved, 2, 0, 4 * 5 + 1, 1)]).toEqual([1, 0.5]);
    expect(at(moved, 2, 0, 4 * 5, 0)).toBe(1);
    expect(at(moved, 2, 0, 4 * 5 + 4, 0)).toBe(1);
  });
});
