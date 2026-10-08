import { describe, expect, it } from 'vitest';

import { wallPointKey, type WallPaint } from './block-wall-paint';
import { trimColoursFromWallPaint } from './trim-paint';

describe('trim meshes read the layer wall paint', () => {
  it('a vertex on a painted wall point takes its grime layer and wetness; tops and unpainted walls stay clean', () => {
    // 1 m cells: points every 0.5 m. Column (0, 0), its +X side (the plane x = 1), across index 1 (z 0.5), height index 1 (y 0.5).
    const chunk: WallPaint = new Map([[wallPointKey(0, 0, 0, 1, 1), Uint8Array.from([0, 0, 255, 0, 204])]]);
    const points = (cx: number, cz: number): WallPaint | null => (cx === 0 && cz === 0 ? chunk : null);
    const positions = [1, 0.5, 0.5, 1, 0.5, 0.75, 1, 0.5, 2.5, 0.5, 1, 0.5];
    const normals = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0];
    const out = new Float32Array(16).fill(0.5);
    trimColoursFromWallPaint(positions, normals, out, { cellSize: [1, 1, 1], points });
    const at = (i: number): number[] => [...out.subarray(i * 4, i * 4 + 4)].map((x) => Math.round(x * 1000) / 1000);
    // On the point: grime 1, wetness 0.8; R untouched (no occlusion given).
    expect(at(0)).toEqual([0.5, 1, 0.8, 1]);
    // Halfway to the next (unpainted) point across: half of each.
    expect(at(1)).toEqual([0.5, 0.5, 0.4, 1]);
    // Another column's wall (no paint), and a top: clean and dry.
    expect(at(2)).toEqual([0.5, 0, 0, 1]);
    expect(at(3)).toEqual([0.5, 0, 0, 1]);
    // Occlusion from the generator, and another grime layer.
    trimColoursFromWallPaint(positions, normals, out, { cellSize: [1, 1, 1], points, grimeLayer: 1, occlusion: [0.25, 0, 0, 2] });
    expect(at(0)).toEqual([0.25, 0, 0.8, 1]);
    expect(at(3)[0]).toBe(1);
  });
});
