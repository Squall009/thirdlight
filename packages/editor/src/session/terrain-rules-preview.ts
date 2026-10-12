/**
 * The material rules' live preview in the terrain editor: the drawn tiles'
 * layers as a bake of the draft rules would leave them, worked out in the
 * editor with the bake's own function (`bakeTerrainRules`, the one the
 * command runs) over the decoded tiles the Scene view holds, nearest the
 * camera first, up to a budget of samples a preview may take on the main
 * thread. The renderer draws the result in place of the stored layers until
 * the preview ends (`TerrainView.previewLayers`).
 *
 * What the preview leaves out (the bake has it): the ground the rules read
 * past the previewed tiles (a cavity at their outer edge), the splines'
 * paint over the rules.
 *
 * Pure.
 */
import { bakeTerrainRules, SurfaceRuleSet, TerrainSamples, terrainTileKey, terrainTileSize, type SurfaceRule, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

/** The most samples one preview bakes (about four 513² tiles): the draft is previewed near the camera, the bake does all. */
export const RULES_PREVIEW_SAMPLES = 1_100_000;

export interface RulesPreview {
  /** The tiles baked, by "x,z" (only those the preview covered). */
  readonly tiles: ReadonlyMap<string, TerrainTile>;
  /** Tiles covered and the terrain's tiles. */
  readonly covered: number;
  readonly total: number;
}

/**
 * Bake `rules` over the decoded tiles nearest world (x, z) `near`, within
 * the sample budget. `tileOf` gives a decoded tile (undefined: not decoded
 * yet, left out); `origin` is the terrain object's position.
 */
export function bakeRulesPreview(c: TerrainComponent, origin: readonly number[], tileOf: (x: number, z: number) => TerrainTile | undefined, rules: readonly SurfaceRule[], near: readonly [number, number], budget = RULES_PREVIEW_SAMPLES): RulesPreview {
  const size = terrainTileSize(c);
  const per = c.tileSamples * c.tileSamples;
  const order = [...c.tiles].sort((a, b) => dist(a, near, origin, size) - dist(b, near, origin, size));
  const chosen = new Map<string, TerrainTile>();
  let samples = 0;
  for (const t of order) {
    if (samples + per > budget && chosen.size > 0) break;
    const tile = tileOf(t.x, t.z);
    if (tile === undefined) continue;
    chosen.set(terrainTileKey(t.x, t.z), tile);
    samples += per;
  }
  if (chosen.size === 0) return { tiles: chosen, covered: 0, total: c.tiles.length };
  const s = new TerrainSamples(c, chosen);
  bakeTerrainRules(s, new SurfaceRuleSet([...rules]), origin, null);
  return { tiles: s.all(), covered: chosen.size, total: c.tiles.length };
}

const dist = (t: { x: number; z: number }, near: readonly [number, number], origin: readonly number[], size: number): number => Math.hypot(origin[0]! + (t.x + 0.5) * size - near[0], origin[2]! + (t.z + 0.5) * size - near[1]);
