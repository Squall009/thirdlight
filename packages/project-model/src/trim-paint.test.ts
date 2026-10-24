import { describe, expect, it } from 'vitest';

import { encodeWallPaint, wallPointKey, type WallPaint } from './block-wall-paint';
import { paintArchitectureColours } from './trim-paint';

describe('trim meshes read the layer wall paint', () => {
  it('a vertex on a painted wall point takes its wetness into A; its layers, tops and unpainted walls stay as they are', () => {
    // 1 m cells: points every 0.5 m. Column (0, 0), its +X side (the plane x = 1), across index 1 (z 0.5), height index 1 (y 0.5).
    const chunk: WallPaint = new Map([[wallPointKey(0, 0, 0, 1, 1), Uint8Array.from([0, 0, 255, 0, 204])]]);
    const paint = { cellSize: [1, 1, 1], offset: [0, 0, 0], chunks: { '0,0': encodeWallPaint(chunk)! } };
    const positions = [1, 0.5, 0.5, 1, 0.5, 0.75, 1, 0.5, 2.5, 0.5, 1, 0.5];
    const normals = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0];
    // R the generator's occlusion; G and B are not trim data (a painted layer of 255 there must not show up).
    const colors = new Uint8Array(16);
    for (let i = 0; i < 4; i++) colors[i * 4] = 64;
    paintArchitectureColours(positions, normals, colors, paint);
    const at = (i: number): number[] => [...colors.subarray(i * 4, i * 4 + 4)];
    // On the point: wetness 204 in A; R kept.
    expect(at(0)).toEqual([64, 0, 0, 204]);
    // Halfway to the next (unpainted) point across: half.
    expect(at(1)).toEqual([64, 0, 0, 102]);
    // Another column's wall (no paint), and a top: dry.
    expect(at(2)).toEqual([64, 0, 0, 0]);
    expect(at(3)).toEqual([64, 0, 0, 0]);
  });
});
