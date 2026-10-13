/**
 * The preview pane's kit piece subject: one piece of a kit slot standing
 * where the engine would put it — in an opening of a sample wall (a door, a
 * window), on the wall's line (an edge piece), on the floor before it — or
 * alone. The wall and floor are a block wall and floor and wear the kit's
 * trim sheet with the strip UVs block faces wear (`trimStripUvs`: the first
 * storey of cells the lower wall row, the storeys above the upper wall, tops
 * the floor; on a sheet drawing rows at their real height a field repeats at
 * its own height, the faces cut where it repeats), so a piece is judged
 * against the sheet as it * will meet. Two boxes say whether it fits: dashed blue, the cell it should
 * fill; solid red, where it draws; small axes mark its file origin.
 *
 * Browser-only.
 */
import type { KitSlotPlacement } from '@thirdlight/project-model';
import { TRIM_PIECE_PLACE_TOLERANCE, type TrimSheet } from '@thirdlight/project-model/trim-sheet';
import { disposeObjectTree, trimStripUvs, trimWallRowSteps, type MaterialDefLike, type MaterialFunctionLike } from '@thirdlight/three-adapter';
import * as THREE from 'three';

import type { PreviewStage, PreviewSubject } from './preview-renderer';

export type KitPreviewMode = 'wall' | 'room' | 'alone';

/** The sample wall's length and height, and how far a free piece stands before it (metres). */
const WALL = { length: 5, height: 3, thickness: 0.2, freeAhead: 1 } as const;

const CELL_COLOR = 0x4f8cff;
const DRAW_COLOR = 0xff5a5a;

/** Positions, normals and metre UVs as a block chunk has them (a wall's v is −y, a top's u, v are x, z). */
interface Geo {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

/** One quad (corners counter-clockwise seen from where it faces) with its four metre UVs. */
function quad(g: Geo, c: readonly [number, number, number][], n: readonly [number, number, number], uv: readonly [number, number][]): void {
  const b = g.pos.length / 3;
  for (let i = 0; i < 4; i++) {
    g.pos.push(...c[i]!);
    g.nrm.push(...n);
    g.uv.push(...uv[i]!);
  }
  g.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
}

/** Sorted, de-duplicated cut positions within `lo..hi` (both ends kept). */
function cuts(lo: number, hi: number, extra: Iterable<number>, step: number, from = lo): number[] {
  const out = new Set<number>([lo, hi]);
  if (step > 0) for (let v = from + step; v < hi - 1e-6; v += step) if (v > lo + 1e-6) out.add(Math.round(v * 1e4) / 1e4);
  for (const v of extra) if (v > lo + 1e-6 && v < hi - 1e-6) out.add(v);
  return [...out].sort((a, b) => a - b);
}

/**
 * A wall along x (centred), its front facing +z, with a hole `hole` (x0, x1,
 * y0, y1; null: none), cut as the block mesher cuts a wall: at every cell
 * across and up, and on a real-height sheet where a field row repeats
 * (`trimWallRowSteps`); front and back faces, the top and the hole's reveals.
 */
function wallGeometry(sheet: TrimSheet | null, cell: number, hole: [number, number, number, number] | null): Geo {
  const g: Geo = { pos: [], nrm: [], uv: [], idx: [] };
  const half = WALL.length / 2;
  const zf = WALL.thickness / 2;
  const inHole = (x: number, y: number): boolean => hole !== null && x > hole[0] + 1e-6 && x < hole[1] - 1e-6 && y > hole[2] + 1e-6 && y < hole[3] - 1e-6;
  const steps = sheet === null ? null : trimWallRowSteps(sheet);
  const X = cuts(-half, half, hole === null ? [] : [hole[0], hole[1]], cell, -half);
  const first = Math.min(cell, WALL.height);
  const ys = [...cuts(0, first, [], steps?.[0] ?? 0, 0), ...cuts(first, WALL.height, [], cell, first), ...cuts(first, WALL.height, [], steps?.[1] ?? 0, 0)];
  const Y = cuts(0, WALL.height, [...ys, ...(hole === null ? [] : [hole[2], hole[3]])], 0);
  for (let i = 0; i + 1 < X.length; i++) for (let j = 0; j + 1 < Y.length; j++) {
    const x0 = X[i]!, x1 = X[i + 1]!, y0 = Y[j]!, y1 = Y[j + 1]!;
    if (inHole((x0 + x1) / 2, (y0 + y1) / 2)) continue;
    quad(g, [[x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf]], [0, 0, 1], [[x0, -y0], [x1, -y0], [x1, -y1], [x0, -y1]]);
    quad(g, [[x1, y0, -zf], [x0, y0, -zf], [x0, y1, -zf], [x1, y1, -zf]], [0, 0, -1], [[-x1, -y0], [-x0, -y0], [-x0, -y1], [-x1, -y1]]);
  }
  const top = WALL.height;
  quad(g, [[-half, top, zf], [half, top, zf], [half, top, -zf], [-half, top, -zf]], [0, 1, 0], [[-half, zf], [half, zf], [half, -zf], [-half, -zf]]);
  if (hole !== null) {
    const [x0, x1, y0, y1] = hole;
    // Reveals as a block hole's faces: the sides walls (u across the wall's depth), the head and sill tops.
    quad(g, [[x0, y0, zf], [x0, y0, -zf], [x0, y1, -zf], [x0, y1, zf]], [1, 0, 0], [[zf, -y0], [-zf, -y0], [-zf, -y1], [zf, -y1]]);
    quad(g, [[x1, y0, -zf], [x1, y0, zf], [x1, y1, zf], [x1, y1, -zf]], [-1, 0, 0], [[-zf, -y0], [zf, -y0], [zf, -y1], [-zf, -y1]]);
    quad(g, [[x0, y1, zf], [x0, y1, -zf], [x1, y1, -zf], [x1, y1, zf]], [0, -1, 0], [[x0, zf], [x0, -zf], [x1, -zf], [x1, zf]]);
    if (y0 > 1e-6) quad(g, [[x0, y0, -zf], [x0, y0, zf], [x1, y0, zf], [x1, y0, -zf]], [0, 1, 0], [[x0, -zf], [x0, zf], [x1, zf], [x1, -zf]]);
  }
  return g;
}

/** A floor `size` square at y = 0, one quad a cell, as block tops are. */
function floorGeometry(cell: number, size: number, z0: number): Geo {
  const g: Geo = { pos: [], nrm: [], uv: [], idx: [] };
  const half = size / 2;
  for (let x = -half; x < half - 1e-6; x += cell) for (let z = z0; z < z0 + size - 1e-6; z += cell) {
    const x1 = Math.min(x + cell, half), z1 = Math.min(z + cell, z0 + size);
    quad(g, [[x, 0, z1], [x1, 0, z1], [x1, 0, z], [x, 0, z]], [0, 1, 0], [[x, z1], [x1, z1], [x1, z], [x, z]]);
  }
  return g;
}

/** The metre UVs as the sheet's strips (no sheet: metres, the sample is plain). */
function stripped(g: Geo, sheet: TrimSheet | null, cell: number): Float32Array {
  const metres = new Float32Array(g.uv);
  return sheet === null ? metres : trimStripUvs(metres, g.pos, g.idx, [cell, cell, cell], sheet);
}

function meshOf(g: Geo, sheet: TrimSheet | null, cell: number): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(stripped(g, sheet, cell), 2));
  geo.setIndex(g.idx);
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb8b4ac, roughness: 0.9 }));
}

function boxLines(box: THREE.Box3, color: number, dashed: boolean): THREE.LineSegments {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(...box.getSize(new THREE.Vector3()).toArray().map((v) => Math.max(v, 0.002)) as [number, number, number]));
  const mat = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.05, depthTest: false, transparent: true }) : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  const lines = new THREE.LineSegments(geo, mat);
  lines.position.copy(box.getCenter(new THREE.Vector3()));
  lines.renderOrder = 10;
  if (dashed) lines.computeLineDistances();
  return lines;
}

export interface KitPieceScene {
  /** The kit's trim sheet: its material id and row table (null: the kit has none, the sample is plain). */
  sheet: { materialId: string; trim: TrimSheet } | null;
  materials: readonly MaterialDefLike[];
  functions: readonly MaterialFunctionLike[];
  /** The piece's material map (its file's material names → project materials). */
  mapping: Readonly<Record<string, string>> | null;
  placement: KitSlotPlacement;
  /** The cell a block layer's grid has (metres). */
  cell: number;
}

/**
 * The piece in its sample: `load(parent)` adds the piece's root (the caller
 * owns and frees it); modes switch without loading it again. What the boxes
 * say is told through `onFit` (where it draws against its cell).
 */
export class KitPieceSubject implements PreviewSubject {
  private stage: PreviewStage | null = null;
  private readonly holder = new THREE.Group();
  private readonly sample = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private piece: THREE.Object3D | null = null;
  private undo: (() => void)[] = [];
  private mode: KitPreviewMode = 'wall';
  private scene: KitPieceScene;
  private disposed = false;

  constructor(
    readonly key: string,
    scene: KitPieceScene,
    private readonly load: () => Promise<{ root: THREE.Object3D; dispose: () => void } | null>,
    private readonly onState?: (state: string) => void,
  ) {
    this.scene = scene;
  }

  private loaded: { root: THREE.Object3D; dispose: () => void } | null = null;

  attach(stage: PreviewStage): void {
    this.stage = stage;
    this.holder.add(this.sample, this.overlay);
    stage.scene.add(this.holder);
    stage.library.setMaterials(this.scene.materials, this.scene.functions);
    this.build();
    void this.load().then(
      (m) => {
        if (this.disposed) {
          m?.dispose();
          return;
        }
        if (m === null) {
          this.onState?.('The piece could not be drawn (its file did not load).');
          return;
        }
        this.loaded = m;
        this.piece = m.root;
        this.holder.add(m.root);
        this.place();
      },
      (e: unknown) => this.onState?.(e instanceof Error ? e.message : String(e)),
    );
  }

  setMode(mode: KitPreviewMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.build();
    this.place();
  }

  /** The materials or the sheet changed (an edit while the preview shows). */
  setScene(scene: KitPieceScene): void {
    this.scene = scene;
    this.stage?.library.setMaterials(scene.materials, scene.functions);
    this.build();
    this.place();
  }

  /** The opening (or stretch, or floor spot) the piece fills: its cells from its size (at least one). */
  private cellBox(size: THREE.Vector3): THREE.Box3 {
    const c = this.scene.cell;
    const w = Math.max(1, Math.round(size.x / c)) * c;
    const h = Math.max(1, Math.round(size.y / c)) * c;
    const p = this.scene.placement;
    const y0 = p.kind === 'opening' ? (p.sill ?? 0) : 0;
    const z = p.kind === 'free' && this.mode !== 'alone' ? WALL.freeAhead : 0;
    const d = p.kind === 'free' ? Math.max(c, Math.round(size.z / c) * c) / 2 : WALL.thickness / 2;
    return new THREE.Box3(new THREE.Vector3(-w / 2, y0, z - d), new THREE.Vector3(w / 2, y0 + h, z + d));
  }

  private clearSample(): void {
    for (const u of this.undo) u();
    this.undo = [];
    for (const child of [...this.sample.children]) {
      this.sample.remove(child);
      disposeObjectTree(child);
    }
  }

  private build(): void {
    const stage = this.stage;
    if (stage === null) return;
    this.clearSample();
    stage.setGrid(this.mode === 'alone');
    if (this.mode === 'alone') return;
    const sheet = this.scene.sheet?.trim ?? null;
    const size = this.piece === null ? new THREE.Vector3(1, 2, 0.1) : new THREE.Box3().setFromObject(this.piece).getSize(new THREE.Vector3());
    const cell = this.cellBox(size);
    const p = this.scene.placement;
    const hole: [number, number, number, number] | null = p.kind === 'free' ? null : [cell.min.x, cell.max.x, cell.min.y, Math.min(cell.max.y, WALL.height)];
    const c = this.scene.cell;
    const parts = [meshOf(wallGeometry(sheet, c, hole), sheet, c)];
    if (this.mode === 'room') {
      const side = (sign: number): THREE.Mesh => {
        const m = meshOf(wallGeometry(sheet, c, null), sheet, c);
        m.rotation.y = sign * (Math.PI / 2);
        m.position.set(-sign * (WALL.length / 2), 0, WALL.length / 2);
        return m;
      };
      parts.push(side(1), side(-1));
      parts.push(meshOf(floorGeometry(c, WALL.length, 0), sheet, c));
    } else parts.push(meshOf(floorGeometry(c, WALL.length, -1), sheet, c));
    for (const m of parts) {
      this.sample.add(m);
      if (this.scene.sheet !== null) this.undo.push(stage.library.apply(m, { '*': this.scene.sheet.materialId }));
    }
  }

  /** Put the piece at its spot, its material map on it, the boxes around it; frame the view. */
  private place(): void {
    const stage = this.stage;
    const piece = this.piece;
    for (const child of [...this.overlay.children]) {
      this.overlay.remove(child);
      disposeObjectTree(child);
    }
    if (stage === null || piece === null) return;
    piece.position.set(0, 0, 0);
    piece.updateMatrixWorld(true);
    const local = new THREE.Box3().setFromObject(piece);
    const size = local.getSize(new THREE.Vector3());
    const p = this.scene.placement;
    const at = new THREE.Vector3(0, p.kind === 'opening' ? (p.sill ?? 0) : 0, p.kind === 'free' && this.mode !== 'alone' ? WALL.freeAhead : 0);
    piece.position.copy(at);
    piece.updateMatrixWorld(true);
    if (this.scene.mapping !== null && Object.keys(this.scene.mapping).length > 0) this.undo.push(stage.library.apply(piece, this.scene.mapping));
    const draws = new THREE.Box3().setFromObject(piece);
    const cell = this.cellBox(size);
    this.overlay.add(boxLines(cell, CELL_COLOR, true), boxLines(draws, DRAW_COLOR, false));
    const axes = new THREE.AxesHelper(0.35);
    axes.position.copy(at);
    (axes.material as THREE.Material).depthTest = false;
    axes.renderOrder = 11;
    this.overlay.add(axes);
    const off = draws.getCenter(new THREE.Vector3()).sub(cell.getCenter(new THREE.Vector3()));
    this.onState?.(Math.abs(off.x) > TRIM_PIECE_PLACE_TOLERANCE || Math.abs(draws.min.y - cell.min.y) > TRIM_PIECE_PLACE_TOLERANCE ? `draws ${off.x.toFixed(2)} m along, ${(draws.min.y - cell.min.y).toFixed(2)} m up from its cell` : 'fills its cell');
    const view = this.mode === 'alone' ? draws.clone().union(cell) : new THREE.Box3().setFromObject(this.holder);
    stage.frame(view, this.mode === 'alone' ? new THREE.Vector3(0.8, 0.5, 1.2) : new THREE.Vector3(0.35, 0.35, 1), this.mode === 'alone' ? 1 : 0.8);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSample();
    for (const child of [...this.overlay.children]) disposeObjectTree(child);
    if (this.piece !== null) this.holder.remove(this.piece);
    this.loaded?.dispose();
    this.loaded = null;
    this.holder.removeFromParent();
    this.stage?.setGrid(false);
    this.stage = null;
  }
}
