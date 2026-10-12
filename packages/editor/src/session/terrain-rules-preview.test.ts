import { describe, expect, it } from 'vitest';
import { flatTerrainTile, terrainFlatStep, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { bakeRulesPreview } from './terrain-rules-preview';

const C: TerrainComponent = { tileSamples: 17, spacing: 1, heightRange: [-10, 50], tiles: [0, 1, 2, 3].map((x) => ({ x, z: 0 })) };

/** A tile sloping up along x: 1 m a metre from tile 2 on (steep), flat before. */
function tile(x: number): TerrainTile {
  const t = flatTerrainTile(17, terrainFlatStep(C.heightRange));
  if (x >= 2) for (let j = 0; j < 17; j++) for (let i = 0; i < 17; i++) t.heights[j * 17 + i] = Math.round(((x - 2) * 16 + i) * (65535 / 60)) + t.heights[0]!;
  return t;
}

describe('rules preview', () => {
  it('bakes the draft over the decoded tiles nearest the camera, within its budget', () => {
    const rules = [{ layer: 3, slope: { min: 30 } }];
    const all = bakeRulesPreview(C, [0, 0, 0], tile, rules, [56, 8]);
    expect(all.covered).toBe(4);
    // The steep tiles take layer 3 (the first byte of a sample's weights is its strongest layer), the flat ones keep layer 0.
    expect(all.tiles.get('3,0')!.weights![8 * 17 * 8 + 8 * 8]).toBe(3);
    expect(all.tiles.get('0,0')!.weights?.[0] ?? 0).toBe(0);
    // Room for two tiles: the two nearest the point.
    const two = bakeRulesPreview(C, [0, 0, 0], tile, rules, [56, 8], 2 * 17 * 17);
    expect([...two.tiles.keys()].sort()).toEqual(['2,0', '3,0']);
    expect(two.total).toBe(4);
    // Not decoded yet: left out.
    expect(bakeRulesPreview(C, [0, 0, 0], (x) => (x === 1 ? tile(1) : undefined), rules, [0, 0]).covered).toBe(1);
  });
});
