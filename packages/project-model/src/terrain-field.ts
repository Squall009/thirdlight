/**
 * A loaded terrain as something to ask: the height, normal, slope, hole and
 * material layers at a world point — what the renderer's tile textures, the
 * heightfield colliders, surface queries and placement tools read, the same
 * in the editor, Play and an export.
 *
 * Heights between samples are bilinear (the four samples around the point);
 * a point in a hole, outside every tile or in a tile not loaded has none.
 *
 * Pure.
 */
import { terrainFlatStep, terrainHeightOf, terrainTileKey, terrainTileSize, type TerrainComponent } from './terrain';
import { flatTerrainTile, terrainHoleAt, terrainLayersAt, terrainTileBytes, type TerrainTile } from './terrain-tile';

export interface TerrainSample {
  /** World height (metres). */
  height: number;
  /** Unit normal (world). */
  normal: [number, number, number];
  /** Degrees from level. */
  slope: number;
  /** The layers showing at the nearest sample, strongest first, weights summing to 255. */
  layers: number[];
  weights: number[];
}

export class TerrainField {
  readonly n: number;
  readonly spacing: number;
  readonly origin: readonly [number, number, number];
  private readonly range: readonly number[];
  private readonly tiles = new Map<string, TerrainTile>();

  /**
   * `component` and its object's world position; `tiles` the loaded tiles'
   * data by "x,z" (a tile the component names without data is flat unless
   * given).
   */
  constructor(component: TerrainComponent, origin: readonly number[], tiles: ReadonlyMap<string, TerrainTile>) {
    this.n = component.tileSamples - 1;
    this.spacing = component.spacing;
    this.range = component.heightRange;
    this.origin = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const flat = terrainFlatStep(component.heightRange);
    for (const ref of component.tiles) {
      const key = terrainTileKey(ref.x, ref.z);
      const t = tiles.get(key) ?? (ref.data === undefined ? flatTerrainTile(component.tileSamples, flat) : undefined);
      if (t !== undefined) this.tiles.set(key, t);
    }
  }

  /** The loaded tile at tile coordinates (x, z). */
  tile(x: number, z: number): TerrainTile | undefined {
    return this.tiles.get(terrainTileKey(x, z));
  }

  /** What the loaded tiles take in memory. */
  memory(): { tiles: number; bytes: number } {
    let bytes = 0;
    for (const t of this.tiles.values()) bytes += terrainTileBytes(t);
    return { tiles: this.tiles.size, bytes };
  }

  /** The tile, its cell and the position in the cell (0–1) under a world point, or null off the loaded tiles. */
  private locate(wx: number, wz: number): { t: TerrainTile; cx: number; cz: number; fx: number; fz: number } | null {
    const u = (wx - this.origin[0]) / this.spacing;
    const v = (wz - this.origin[2]) / this.spacing;
    const gx = Math.floor(u);
    const gz = Math.floor(v);
    const tx = Math.floor(gx / this.n);
    const tz = Math.floor(gz / this.n);
    const t = this.tiles.get(terrainTileKey(tx, tz));
    if (t === undefined) return null;
    return { t, cx: gx - tx * this.n, cz: gz - tz * this.n, fx: u - gx, fz: v - gz };
  }

  /** The world height at a world point (null: no terrain there, or a hole). */
  heightAt(wx: number, wz: number): number | null {
    const at = this.locate(wx, wz);
    if (at === null || terrainHoleAt(at.t, at.cx, at.cz)) return null;
    const s = this.n + 1;
    const i = at.cz * s + at.cx;
    const h = at.t.heights;
    const top = h[i]! + (h[i + 1]! - h[i]!) * at.fx;
    const bottom = h[i + s]! + (h[i + s + 1]! - h[i + s]!) * at.fx;
    return this.origin[1] + terrainHeightOf(this.range, top + (bottom - top) * at.fz);
  }

  /** Whether a world point is over a hole (false off the terrain). */
  holeAt(wx: number, wz: number): boolean {
    const at = this.locate(wx, wz);
    return at !== null && terrainHoleAt(at.t, at.cx, at.cz);
  }

  /** The surface at a world point (null: no terrain there, or a hole). */
  sample(wx: number, wz: number): TerrainSample | null {
    const height = this.heightAt(wx, wz);
    if (height === null) return null;
    // The normal from the heights half a sample either side (the edges of a hole or the terrain: this point's).
    const d = this.spacing * 0.5;
    const hx0 = this.heightAt(wx - d, wz) ?? height;
    const hx1 = this.heightAt(wx + d, wz) ?? height;
    const hz0 = this.heightAt(wx, wz - d) ?? height;
    const hz1 = this.heightAt(wx, wz + d) ?? height;
    const nx = -(hx1 - hx0) / (2 * d);
    const nz = -(hz1 - hz0) / (2 * d);
    const len = Math.sqrt(nx * nx + 1 + nz * nz);
    const normal: [number, number, number] = [nx / len, 1 / len, nz / len];
    const at = this.locate(wx, wz)!;
    const s = this.n + 1;
    const i = (at.cz + (at.fz >= 0.5 ? 1 : 0)) * s + at.cx + (at.fx >= 0.5 ? 1 : 0);
    const { layers, weights } = terrainLayersAt(at.t, i);
    return { height, normal, slope: (Math.acos(normal[1]) * 180) / Math.PI, layers, weights };
  }

  /** The world box of tile (x, z) in XZ: [minX, minZ, maxX, maxZ]. */
  tileBounds(x: number, z: number): [number, number, number, number] {
    const size = terrainTileSize({ tileSamples: this.n + 1, spacing: this.spacing });
    return [this.origin[0] + x * size, this.origin[2] + z * size, this.origin[0] + (x + 1) * size, this.origin[2] + (z + 1) * size];
  }
}
