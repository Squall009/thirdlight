/**
 * The preview pane's kit piece subject: one piece of a kit slot standing
 * where the engine would put it — in an opening of a sample wall (a door, a
 * window), on the wall's line (an edge piece), on the floor before it — or
 * alone. The wall and floor wear the kit's trim sheet with strip UVs as the
 * generator lays them (the floor row on the floor, the lower wall row on
 * the first metre, the upper wall row above, the bevel on the top; each
 * field repeating at its height), so a piece is judged against the sheet it
 * will meet. Two boxes say whether it fits: dashed blue, the cell it should
 * fill; solid red, where it draws; small axes mark its file origin.
 *
 * Browser-only.
 */
import type { KitSlotPlacement } from '@thirdlight/project-model';
import { trimRowOf, trimRowMetres, trimU, trimV, type TrimSheet } from '@thirdlight/project-model/trim-sheet';
import { disposeObjectTree, type MaterialDefLike, type MaterialFunctionLike } from '@thirdlight/three-adapter';
import * as THREE from 'three';

import type { PreviewStage, PreviewSubject } from './preview-renderer';

export type KitPreviewMode = 'wall' | 'room' | 'alone';

/** The sample wall's length and height, and how far a free piece stands before it (metres). */
const WALL = { length: 5, height: 3, thickness: 0.2, freeAhead: 1 } as const;
/** The quads' grid on the wall: every field row the spec lays out repeats at a multiple of it. */
const STEP = 0.5;

const CELL_COLOR = 0x4f8cff;
const DRAW_COLOR = 0xff5a5a;

interface Geo {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
}

/** One quad (corners counter-clockwise seen from where it faces) with its four UVs. */
function quad(g: Geo, c: readonly [number, number, number][], n: readonly [number, number, number], uv: readonly [number, number][]): void {
  const b = g.pos.length / 3;
  for (let i = 0; i < 4; i++) {
    g.pos.push(...c[i]!);
    g.nrm.push(...n);
    g.uv.push(...uv[i]!);
  }
  g.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
}

/** Strip UVs of a face `x0..x1` along and `y0..y1` up, on the row `slot` (a field repeats at its height). */
function stripUv(sheet: TrimSheet | null, slot: string, x0: number, x1: number, y0: number, y1: number): [number, number][] {
  const row = sheet === null ? null : (trimRowOf(sheet, slot) ?? sheet.rows[0] ?? null);
  if (sheet === null || row === null) return [[x0 / 4, y0], [x1 / 4, y0], [x1 / 4, y1], [x0 / 4, y1]];
  const h = trimRowMetres(sheet, row);
  // v counts from the row's top: the face's top edge is its top within the repeat it lies in.
  const base = Math.floor((y0 + 1e-6) / h) * h;
  const t = (y: number): number => 1 - (y - base) / h;
  return [
    [trimU(sheet, row, x0), trimV(sheet, row, t(y0))],
    [trimU(sheet, row, x1), trimV(sheet, row, t(y0))],
    [trimU(sheet, row, x1), trimV(sheet, row, t(y1))],
    [trimU(sheet, row, x0), trimV(sheet, row, t(y1))],
  ];
}

/** The row a wall face at height `y` wears (as block walls: the lower wall below a metre, the upper above). */
const wallRow = (y: number): string => (y < 1 - 1e-6 ? 'lower_wall' : 'upper_wall');

/**
 * A wall along x (centred), its front facing +z, with a hole `hole` (x0, x1,
 * y0, y1; null: none): front and back faces in 0.5 m quads, the top and the
 * hole's reveals.
 */
function wallGeometry(sheet: TrimSheet | null, hole: [number, number, number, number] | null): Geo {
  const g: Geo = { pos: [], nrm: [], uv: [], idx: [] };
  const half = WALL.length / 2;
  const zf = WALL.thickness / 2;
  const inHole = (x: number, y: number): boolean => hole !== null && x > hole[0] + 1e-6 && x < hole[1] - 1e-6 && y > hole[2] + 1e-6 && y < hole[3] - 1e-6;
  // Hole edges join the quad grid so no quad straddles them.
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (let x = -half; x <= half + 1e-6; x += STEP) xs.add(Math.round(x * 1000) / 1000);
  for (let y = 0; y <= WALL.height + 1e-6; y += STEP) ys.add(Math.round(y * 1000) / 1000);
  if (hole !== null) {
    xs.add(hole[0]).add(hole[1]);
    ys.add(hole[2]).add(hole[3]);
  }
  const X = [...xs].filter((x) => x >= -half - 1e-6 && x <= half + 1e-6).sort((a, b) => a - b);
  const Y = [...ys].filter((y) => y >= -1e-6 && y <= WALL.height + 1e-6).sort((a, b) => a - b);
  for (let i = 0; i + 1 < X.length; i++) for (let j = 0; j + 1 < Y.length; j++) {
    const x0 = X[i]!, x1 = X[i + 1]!, y0 = Y[j]!, y1 = Y[j + 1]!;
    if (inHole((x0 + x1) / 2, (y0 + y1) / 2)) continue;
    // A quad never crosses a row repeat: the grid lines fall on every field height of the spec.
    const row = wallRow((y0 + y1) / 2);
    quad(g, [[x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf]], [0, 0, 1], stripUv(sheet, row, x0, x1, y0, y1));
    quad(g, [[x1, y0, -zf], [x0, y0, -zf], [x0, y1, -zf], [x1, y1, -zf]], [0, 0, -1], stripUv(sheet, row, -x1, -x0, y0, y1));
  }
  const top = WALL.height;
  quad(g, [[-half, top, zf], [half, top, zf], [half, top, -zf], [-half, top, -zf]], [0, 1, 0], stripUv(sheet, 'bevel', -half, half, 0, WALL.thickness));
  if (hole !== null) {
    const [x0, x1, y0, y1] = hole;
    const reveal = (c: [number, number, number][], n: [number, number, number], len: number): void => quad(g, c, n, stripUv(sheet, 'frame', 0, len, 0, Math.min(WALL.thickness, 0.125)));
    reveal([[x0, y0, zf], [x0, y0, -zf], [x0, y1, -zf], [x0, y1, zf]], [1, 0, 0], y1 - y0);
    reveal([[x1, y0, -zf], [x1, y0, zf], [x1, y1, zf], [x1, y1, -zf]], [-1, 0, 0], y1 - y0);
    reveal([[x0, y1, zf], [x0, y1, -zf], [x1, y1, -zf], [x1, y1, zf]], [0, -1, 0], x1 - x0);
    if (y0 > 1e-6) reveal([[x0, y0, -zf], [x0, y0, zf], [x1, y0, zf], [x1, y0, -zf]], [0, 1, 0], x1 - x0);
  }
  return g;
}

/** A floor `size` square at y = 0 on the floor row (its 1 m tiles across). */
function floorGeometry(sheet: TrimSheet | null, size: number, z0: number): Geo {
  const g: Geo = { pos: [], nrm: [], uv: [], idx: [] };
  const half = size / 2;
  for (let x = -half; x < half - 1e-6; x += 1) for (let z = z0; z < z0 + size - 1e-6; z += 1) {
    const uv = stripUv(sheet, 'floor', x, x + 1, 0, 1);
    quad(g, [[x, 0, z + 1], [x + 1, 0, z + 1], [x + 1, 0, z], [x, 0, z]], [0, 1, 0], uv);
  }
  return g;
}

function meshOf(g: Geo): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
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
    const parts = [meshOf(wallGeometry(sheet, hole))];
    if (this.mode === 'room') {
      const side = (sign: number): THREE.Mesh => {
        const m = meshOf(wallGeometry(sheet, null));
        m.rotation.y = sign * (Math.PI / 2);
        m.position.set(-sign * (WALL.length / 2), 0, WALL.length / 2);
        return m;
      };
      parts.push(side(1), side(-1));
      parts.push(meshOf(floorGeometry(sheet, WALL.length, 0)));
    } else parts.push(meshOf(floorGeometry(sheet, WALL.length, -1)));
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
    this.onState?.(Math.abs(off.x) > 0.02 || Math.abs(draws.min.y - cell.min.y) > 0.02 ? `draws ${off.x.toFixed(2)} m along, ${(draws.min.y - cell.min.y).toFixed(2)} m up from its cell` : 'fills its cell');
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
