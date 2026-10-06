import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PROBE_ARTIFACT_ROW_PROBES, PROBE_FILLED, PROBE_MOVED, PROBE_VALID, probeGridGpuBytes } from '@thirdlight/runtime';

import { decodeProbeArtifact, encodePng16, packProbeTexels, probeAtlasTexture, probeGridLight } from './probe-artifact';

describe('probe artifact', () => {
  it('round-trips through a 16-bit PNG into three\'s atlas layout, with each probe\'s validity', async () => {
    // More probes than one artifact row holds, so rows wrap.
    const resolution: [number, number, number] = [9, 8, 9];
    const n = resolution[0] * resolution[1] * resolution[2];
    expect(n).toBeGreaterThan(PROBE_ARTIFACT_ROW_PROBES);
    const sh = new Float32Array(n * 27);
    for (let i = 0; i < sh.length; i++) sh[i] = ((i % 97) - 40) / 8; // negative SH terms and values over 1
    const validity = new Float32Array(n).map((_, i) => [PROBE_VALID, PROBE_MOVED, PROBE_FILLED][i % 3]!);
    const packed = packProbeTexels(sh, validity);
    const png = await encodePng16(packed.width, packed.height, packed.samples);
    const decoded = decodeProbeArtifact(png, { resolution });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Array.from(decoded.validity)).toEqual(Array.from(validity));
    const [nx, ny, nz] = resolution;
    const padded = nz + 2;
    const half = (v: number): number => THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(v));
    // A probe's coefficient c (channel ch) sits in sub-volume floor(v / 4), channel v % 4, v = 3c + ch.
    const atlasAt = (ix: number, iy: number, slice: number, ch: number): number => THREE.DataUtils.fromHalfFloat(decoded.atlas[((slice * ny + iy) * nx + ix) * 4 + ch]!);
    for (const [ix, iy, iz] of [[0, 0, 0], [8, 7, 8], [3, 5, 4]] as const) {
      const p = ix + iy * nx + iz * nx * ny;
      for (let v = 0; v < 27; v++) {
        const t = Math.floor(v / 4);
        expect(atlasAt(ix, iy, t * padded + 1 + iz, v % 4)).toBeCloseTo(half(sh[p * 27 + v]!), 6);
      }
    }
    // The padding slices copy the edge slices.
    expect(atlasAt(2, 2, 0, 0)).toBe(atlasAt(2, 2, 1, 0));
    expect(atlasAt(2, 2, padded - 1, 0)).toBe(atlasAt(2, 2, padded - 2, 0));
    const grid = { min: [0, 0, 0] as [number, number, number], max: [16, 7, 16] as [number, number, number], resolution };
    const texture = probeAtlasTexture(decoded.atlas, resolution);
    expect(texture.image.depth).toBe(7 * padded);
    expect(decoded.atlas.byteLength).toBe(probeGridGpuBytes(grid));
    const light = probeGridLight(grid, texture);
    expect(light.boundingBox.min.toArray()).toEqual([0, 0, 0]);
    expect(light.boundingBox.max.toArray()).toEqual([16, 7, 16]);
  });

  it('refuses a file of the wrong size', async () => {
    const packed = packProbeTexels(new Float32Array(8 * 27), new Float32Array(8));
    const png = await encodePng16(packed.width, packed.height, packed.samples);
    expect(decodeProbeArtifact(png, { resolution: [3, 3, 3] }).ok).toBe(false);
  });
});
