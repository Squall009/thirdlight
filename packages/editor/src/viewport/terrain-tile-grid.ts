/**
 * The terrain editor's tile grid in the Scene view (its Tiles mode): every
 * tile's outline laid on its ground, and every empty square beside the
 * terrain (its 8 neighbours) drawn dashed with a "+" — click one to add a
 * tile there, click a tile to pick it. The square under the pointer is
 * filled (amber: a tile would be added; blue: the tile is picked), the
 * picked tile filled blue.
 *
 * Which square the pointer is over: the terrain's ground under it, else the
 * level of the empty squares (the height of the ground along their edges).
 *
 * Drawn only, never picked, never depth-tested (it lies on the ground).
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import { terrainTileKey, terrainTileSize, type TerrainComponent } from '@thirdlight/runtime';

import { tokenColour } from './brush-cursor';

/** A square of the grid: a tile, or an empty place beside the terrain. */
export interface TileGridCell {
  readonly x: number;
  readonly z: number;
  readonly kind: 'tile' | 'empty';
}

/** Lifted off the ground so the lines do not flicker into it. */
const LIFT = 0.08;
/** The most points along a tile's edge the outline follows the ground by. */
const EDGE_POINTS = 48;
/** Dashes along an empty square's side. */
const DASHES = 12;

export class TerrainTileGrid {
  private readonly root = new THREE.Group();
  private readonly tileLines: THREE.LineSegments;
  private readonly emptyLines: THREE.LineSegments;
  private readonly hoverFill: THREE.Mesh;
  private readonly pickedFill: THREE.Mesh;
  private readonly tileMat: THREE.LineBasicMaterial;
  private readonly emptyMat: THREE.LineBasicMaterial;
  private readonly addMat: THREE.MeshBasicMaterial;
  private readonly pickMat: THREE.MeshBasicMaterial;
  /** The empty squares and the height each is drawn at. */
  private empty = new Map<string, number>();
  private tiles = new Set<string>();
  /** Each tile's mean ground height (its fill is drawn there). */
  private tileHeights = new Map<string, number>();
  private size = 1;
  private origin: readonly number[] = [0, 0, 0];
  /** The level an empty square under the pointer is found at (their mean height). */
  private level = 0;
  private drawnKey = '';

  constructor(parent: THREE.Object3D) {
    this.root.name = 'terrain-tile-grid';
    this.root.visible = false;
    this.tileMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
    this.emptyMat = new THREE.LineBasicMaterial({ color: tokenColour('--brush'), transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
    this.addMat = new THREE.MeshBasicMaterial({ color: tokenColour('--brush'), transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.pickMat = new THREE.MeshBasicMaterial({ color: tokenColour('--select'), transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.tileLines = new THREE.LineSegments(new THREE.BufferGeometry(), this.tileMat);
    this.emptyLines = new THREE.LineSegments(new THREE.BufferGeometry(), this.emptyMat);
    this.hoverFill = new THREE.Mesh(quad(), this.addMat);
    this.pickedFill = new THREE.Mesh(quad(), this.pickMat);
    this.hoverFill.renderOrder = 17;
    this.pickedFill.renderOrder = 16;
    this.tileLines.renderOrder = 18;
    this.emptyLines.renderOrder = 18;
    for (const o of [this.tileLines, this.emptyLines, this.hoverFill, this.pickedFill]) {
      o.frustumCulled = false;
      o.raycast = () => undefined;
    }
    this.hoverFill.visible = false;
    this.pickedFill.visible = false;
    this.root.add(this.pickedFill, this.hoverFill, this.tileLines, this.emptyLines);
    parent.add(this.root);
  }

  setVisible(on: boolean): void {
    this.root.visible = on;
  }

  /**
   * Lay the grid for a terrain at `origin` (world), its ground read by
   * `heightAt` (world y at world x, z; null off the tiles). Drawn again only
   * when the tiles changed.
   */
  update(c: TerrainComponent, origin: readonly number[], heightAt: (x: number, z: number) => number | null, key: string): void {
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.size = terrainTileSize(c);
    this.origin = origin;
    this.tiles = new Set(c.tiles.map((t) => terrainTileKey(t.x, t.z)));
    const s = this.size;
    const [ox, oy, oz] = [origin[0]!, origin[1]!, origin[2]!];
    const yAt = (x: number, z: number): number => (heightAt(x, z) ?? oy) + LIFT;
    // Each tile's edges once (a shared edge is drawn by the tile on its -x / -z side, or by the tile alone).
    const pts: number[] = [];
    const n = Math.max(2, Math.min(EDGE_POINTS, Math.round(s / c.spacing)));
    const edge = (x0: number, z0: number, x1: number, z1: number): void => {
      for (let i = 0; i < n; i++) {
        const a = i / n;
        const b = (i + 1) / n;
        const xa = x0 + (x1 - x0) * a;
        const za = z0 + (z1 - z0) * a;
        const xb = x0 + (x1 - x0) * b;
        const zb = z0 + (z1 - z0) * b;
        pts.push(xa, yAt(xa, za), za, xb, yAt(xb, zb), zb);
      }
    };
    for (const t of c.tiles) {
      const x0 = ox + t.x * s;
      const z0 = oz + t.z * s;
      edge(x0, z0, x0 + s, z0);
      edge(x0, z0, x0, z0 + s);
      if (!this.tiles.has(terrainTileKey(t.x + 1, t.z))) edge(x0 + s, z0, x0 + s, z0 + s);
      if (!this.tiles.has(terrainTileKey(t.x, t.z + 1))) edge(x0, z0 + s, x0 + s, z0 + s);
    }
    setPositions(this.tileLines.geometry, pts);
    this.tileHeights = new Map();
    for (const t of c.tiles) {
      let sum = 0;
      let count = 0;
      for (let j = 0; j <= 2; j++)
        for (let i = 0; i <= 2; i++) {
          const h = heightAt(ox + (t.x + i / 2) * s, oz + (t.z + j / 2) * s);
          if (h !== null) {
            sum += h;
            count += 1;
          }
        }
      this.tileHeights.set(terrainTileKey(t.x, t.z), count > 0 ? sum / count : oy);
    }
    // The empty squares round the tiles, each at the height of the ground along the edges it shares.
    this.empty = new Map();
    for (const t of c.tiles) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = terrainTileKey(t.x + dx, t.z + dz);
          if (this.tiles.has(k) || this.empty.has(k)) continue;
          this.empty.set(k, this.edgeHeight(t.x + dx, t.z + dz, heightAt) ?? oy);
        }
    }
    const dash: number[] = [];
    let sum = 0;
    // Each side once (two empty squares share theirs); a side along a tile is the tile's outline already.
    const sides = new Set<string>();
    for (const [k, y] of this.empty) {
      sum += y;
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      const x0 = ox + cx * s;
      const z0 = oz + cz * s;
      const yy = y + LIFT;
      const side = (key: string, beyond: string, ax: number, az: number, bx: number, bz: number): void => {
        if (sides.has(key) || this.tiles.has(beyond)) return;
        sides.add(key);
        for (let i = 0; i < DASHES; i++) {
          const a = i / DASHES;
          const b = (i + 0.55) / DASHES;
          dash.push(ax + (bx - ax) * a, yy, az + (bz - az) * a, ax + (bx - ax) * b, yy, az + (bz - az) * b);
        }
      };
      side(`h${cx},${cz}`, terrainTileKey(cx, cz - 1), x0, z0, x0 + s, z0);
      side(`v${cx + 1},${cz}`, terrainTileKey(cx + 1, cz), x0 + s, z0, x0 + s, z0 + s);
      side(`h${cx},${cz + 1}`, terrainTileKey(cx, cz + 1), x0 + s, z0 + s, x0, z0 + s);
      side(`v${cx},${cz}`, terrainTileKey(cx - 1, cz), x0, z0 + s, x0, z0);
      // The "+" in its middle.
      const mx = x0 + s / 2;
      const mz = z0 + s / 2;
      const arm = s * 0.08;
      dash.push(mx - arm, yy, mz, mx + arm, yy, mz, mx, yy, mz - arm, mx, yy, mz + arm);
    }
    this.level = this.empty.size > 0 ? sum / this.empty.size : oy;
    setPositions(this.emptyLines.geometry, dash);
  }

  /** The mean ground height along the edges an empty square shares with tiles (its corners where it only touches one). */
  private edgeHeight(cx: number, cz: number, heightAt: (x: number, z: number) => number | null): number | null {
    const s = this.size;
    const [ox, oz] = [this.origin[0]!, this.origin[2]!];
    let sum = 0;
    let count = 0;
    const steps = 8;
    const x0 = ox + cx * s;
    const z0 = oz + cz * s;
    // Points along the square's border, nudged a little into the square beside it (whose ground is read).
    const nudge = Math.min(0.01 * s, 0.25);
    for (let i = 0; i <= steps; i++) {
      const a = i / steps;
      for (const [x, z] of [
        [x0 + a * s, z0 - nudge],
        [x0 + a * s, z0 + s + nudge],
        [x0 - nudge, z0 + a * s],
        [x0 + s + nudge, z0 + a * s],
      ] as const) {
        const h = heightAt(x, z);
        if (h !== null) {
          sum += h;
          count += 1;
        }
      }
    }
    return count === 0 ? null : sum / count;
  }

  /** The square under a ray: the ground's tile where the ray meets the ground, else the empty square at the grid's level (null: neither). */
  cellAt(ray: THREE.Ray, groundHit: THREE.Vector3 | null): TileGridCell | null {
    const s = this.size;
    const [ox, oz] = [this.origin[0]!, this.origin[2]!];
    const at = (p: THREE.Vector3): { x: number; z: number; key: string } => {
      const x = Math.floor((p.x - ox) / s);
      const z = Math.floor((p.z - oz) / s);
      return { x, z, key: terrainTileKey(x, z) };
    };
    if (groundHit !== null) {
      const c = at(groundHit);
      if (this.tiles.has(c.key)) return { x: c.x, z: c.z, kind: 'tile' };
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.level);
    const p = ray.intersectPlane(plane, new THREE.Vector3());
    if (p === null) return null;
    const c = at(p);
    if (this.empty.has(c.key)) return { x: c.x, z: c.z, kind: 'empty' };
    if (this.tiles.has(c.key)) return { x: c.x, z: c.z, kind: 'tile' };
    return null;
  }

  /** Fill the square under the pointer (null: none). */
  setHover(cell: TileGridCell | null): void {
    this.place(this.hoverFill, cell);
    this.hoverFill.material = cell?.kind === 'tile' ? this.pickMat : this.addMat;
  }

  /** Fill the picked tile (null: none). */
  setPicked(cell: readonly [number, number] | null): void {
    this.place(this.pickedFill, cell === null || !this.tiles.has(terrainTileKey(cell[0], cell[1])) ? null : { x: cell[0], z: cell[1], kind: 'tile' });
  }

  private place(m: THREE.Mesh, cell: TileGridCell | null): void {
    if (cell === null) {
      m.visible = false;
      return;
    }
    const s = this.size;
    const key = terrainTileKey(cell.x, cell.z);
    const y = (cell.kind === 'empty' ? this.empty.get(key) : this.tileHeights.get(key)) ?? this.level;
    m.position.set(this.origin[0]! + cell.x * s, y + LIFT, this.origin[2]! + cell.z * s);
    m.scale.set(s, 1, s);
    m.updateMatrixWorld();
    m.visible = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const o of [this.tileLines, this.emptyLines, this.hoverFill, this.pickedFill]) o.geometry.dispose();
    this.tileMat.dispose();
    this.emptyMat.dispose();
    this.addMat.dispose();
    this.pickMat.dispose();
  }
}

/** A unit square on the ground plane from (0, 0) to (1, 1). */
function quad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

function setPositions(g: THREE.BufferGeometry, pts: number[]): void {
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.computeBoundingSphere();
}
