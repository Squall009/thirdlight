/**
 * What the structure mode draws over the Scene view: the structure's own
 * 0.5 m grid (faint, turned with it, so the snapping is visible), its
 * footprint's outline at its floor, the handles (a corner, an edge's middle,
 * the storey arrow over the roof, the turn knob on its ring), the ghost of a
 * drag's new height, an opening's box and ghost and a misfit's marker.
 *
 * Everything that belongs to the structure lies in one group placed and
 * turned as its grid is (`setPlace`), so its numbers are the grid's own
 * metres; a drawn rectangle before a structure exists lies in the world.
 * Drawn only, over the scene (no depth test: a handle behind a wall is still
 * there to drag), never picked by the view's own raycasts: the tool finds a
 * handle by its distance on screen.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import { VOXEL_SIZE_M, type GridPlacement } from '@thirdlight/voxel';

import { tokenColour } from './brush-cursor';

/** Lines and handles drawn after the scene. */
const ORDER = 999;
/** Lifted off the floor so the outline never sinks into the slab's top face. */
const LIFT = 0.03;
/** A handle's radius as a share of its distance to the camera (about 1/60 of the view height across). */
const HANDLE_SCREEN = 0.012;

/** A handle as the overlay draws it: where it is (grid metres), what it looks like. */
export interface OverlayHandle {
  readonly id: string;
  readonly kind: 'corner' | 'edge' | 'storey' | 'yaw';
  readonly at: readonly [number, number, number];
}

const lineMaterial = (color: THREE.Color, opacity: number): THREE.LineBasicMaterial => new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity });

function lines(points: readonly number[], m: THREE.Material): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const l = new THREE.LineSegments(g, m);
  l.renderOrder = ORDER;
  l.frustumCulled = false;
  return l;
}

/** The twelve edges of a box (min, max) as line segment points. */
function boxEdges(min: readonly number[], max: readonly number[]): number[] {
  const [x0, y0, z0] = min as [number, number, number];
  const [x1, y1, z1] = max as [number, number, number];
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  return e.flatMap((i) => c[i]!);
}

export class StructureOverlay {
  /** The structure's own frame (placed and turned as its grid). */
  private readonly frame = new THREE.Group();
  /** World-aligned drawings (a rectangle drawn before the structure exists, its grid). */
  private readonly world = new THREE.Group();
  private readonly colours = { line: tokenColour('--brush'), grid: new THREE.Color(0xc8d0e0), handle: tokenColour('--brush'), storey: new THREE.Color(0x6fc3ff), yaw: new THREE.Color(0x9be08a), misfit: new THREE.Color(0xff4a4a), ghost: new THREE.Color(0x6fc3ff) };
  private readonly parts = new Map<string, THREE.Object3D>();
  private readonly handles = new Map<string, THREE.Mesh>();
  private readonly handleGeometry = { corner: new THREE.BoxGeometry(2, 2, 2), edge: new THREE.BoxGeometry(1.6, 1.6, 1.6), storey: new THREE.ConeGeometry(1.6, 3.2, 12), yaw: new THREE.SphereGeometry(1.2, 12, 8) };

  constructor(parent: THREE.Object3D) {
    this.frame.name = 'structure-overlay';
    this.world.name = 'structure-overlay-world';
    this.frame.visible = false;
    this.world.visible = false;
    parent.add(this.frame, this.world);
  }

  /** Where the structure's grid stands (null: nothing of the structure is drawn). */
  setPlace(place: Pick<GridPlacement, 'position' | 'yawRad'> | null): void {
    this.frame.visible = place !== null;
    if (place === null) return;
    this.frame.position.set(place.position[0], place.position[1], place.position[2]);
    this.frame.rotation.set(0, place.yawRad, 0);
  }

  /** A part's lines replaced (null: gone); `world`: in the world rather than the structure's frame. */
  private setLines(name: string, points: readonly number[] | null, colour: THREE.Color, opacity: number, world = false): void {
    const old = this.parts.get(name);
    if (old !== undefined) {
      old.removeFromParent();
      (old as THREE.LineSegments).geometry.dispose();
      ((old as THREE.LineSegments).material as THREE.Material).dispose();
      this.parts.delete(name);
    }
    if (points === null || points.length === 0) return;
    const l = lines(points, lineMaterial(colour, opacity));
    l.name = `structure-${name}`;
    (world ? this.world : this.frame).add(l);
    this.parts.set(name, l);
  }

  /** The faint 0.5 m grid over a box of cells (lattice corners, at the floor's height in metres). */
  setGrid(box: { minX: number; maxX: number; minZ: number; maxZ: number } | null, y: number, world = false): void {
    if (box === null) return this.setLines(world ? 'world-grid' : 'grid', null, this.colours.grid, 0);
    const pts: number[] = [];
    const h = y + LIFT / 2;
    for (let x = box.minX; x <= box.maxX; x++) pts.push(x * VOXEL_SIZE_M, h, box.minZ * VOXEL_SIZE_M, x * VOXEL_SIZE_M, h, box.maxZ * VOXEL_SIZE_M);
    for (let z = box.minZ; z <= box.maxZ; z++) pts.push(box.minX * VOXEL_SIZE_M, h, z * VOXEL_SIZE_M, box.maxX * VOXEL_SIZE_M, h, z * VOXEL_SIZE_M);
    this.setLines(world ? 'world-grid' : 'grid', pts, this.colours.grid, 0.18, world);
    this.world.visible = this.world.children.length > 0;
  }

  /** The footprint's outline (polygons of cell points) at a height (metres); `name` keeps the live preview apart from the stored one. */
  setOutline(name: 'outline' | 'preview' | 'world-rect', polygons: readonly (readonly (readonly [number, number])[])[] | null, y: number, world = false): void {
    if (polygons === null) return this.setLines(name, null, this.colours.line, 0);
    const pts: number[] = [];
    const h = y + LIFT;
    for (const p of polygons)
      for (let k = 0; k < p.length; k++) {
        const a = p[k]!;
        const b = p[(k + 1) % p.length]!;
        pts.push(a[0] * VOXEL_SIZE_M, h, a[1] * VOXEL_SIZE_M, b[0] * VOXEL_SIZE_M, h, b[1] * VOXEL_SIZE_M);
      }
    this.setLines(name, pts, name === 'outline' ? this.colours.line : new THREE.Color(0xffffff), name === 'outline' ? 0.75 : 1, world);
    this.world.visible = this.world.children.length > 0;
  }

  /** A box's edges in the structure's frame (grid metres): the ghost of a new height, a cursor's cells, a misfit's marker (null: gone). */
  setBox(name: 'ghost' | 'marker' | 'opening', box: { min: readonly number[]; max: readonly number[] } | null, colour?: 'ghost' | 'cursor' | 'misfit' | 'dig'): void {
    const c = colour === 'misfit' || colour === 'dig' ? this.colours.misfit : colour === 'cursor' ? this.colours.line : this.colours.ghost;
    this.setLines(name, box === null ? null : boxEdges(box.min, box.max), c, name === 'ghost' ? 0.7 : 1);
  }

  /** The turn knob's ring (centre and radius in grid metres, at a height; null: gone). */
  setRing(centre: readonly [number, number, number] | null, radius: number): void {
    if (centre === null) return this.setLines('ring', null, this.colours.yaw, 0);
    const pts: number[] = [];
    const n = 96;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const b = ((k + 1) / n) * Math.PI * 2;
      pts.push(centre[0] + Math.cos(a) * radius, centre[1] + LIFT, centre[2] + Math.sin(a) * radius, centre[0] + Math.cos(b) * radius, centre[1] + LIFT, centre[2] + Math.sin(b) * radius);
    }
    this.setLines('ring', pts, this.colours.yaw, 0.55);
  }

  /** The handles drawn (in the structure's frame); `active`: the one dragged or under the pointer, drawn white. */
  setHandles(list: readonly OverlayHandle[], active: string | null): void {
    const keep = new Set(list.map((h) => h.id));
    for (const [id, m] of this.handles) {
      if (keep.has(id)) continue;
      m.removeFromParent();
      (m.material as THREE.Material).dispose();
      this.handles.delete(id);
    }
    for (const h of list) {
      let m = this.handles.get(h.id);
      if (m === undefined) {
        const colour = h.kind === 'storey' ? this.colours.storey : h.kind === 'yaw' ? this.colours.yaw : this.colours.handle;
        m = new THREE.Mesh(this.handleGeometry[h.kind], new THREE.MeshBasicMaterial({ color: colour.clone(), depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
        m.renderOrder = ORDER + 1;
        m.frustumCulled = false;
        m.name = `structure-handle-${h.id}`;
        m.userData['base'] = colour.clone();
        this.frame.add(m);
        this.handles.set(h.id, m);
      }
      m.position.set(h.at[0], h.at[1], h.at[2]);
      (m.material as THREE.MeshBasicMaterial).color.copy(h.id === active ? new THREE.Color(0xffffff) : (m.userData['base'] as THREE.Color));
    }
  }

  /** Handles keep about the same size on screen. */
  scaleHandles(camera: THREE.PerspectiveCamera): void {
    if (this.handles.size === 0) return;
    this.frame.updateMatrixWorld(true);
    const k = Math.tan((camera.fov * Math.PI) / 360) * HANDLE_SCREEN;
    const p = new THREE.Vector3();
    for (const m of this.handles.values()) m.scale.setScalar(Math.max(0.02, m.getWorldPosition(p).distanceTo(camera.position) * k));
  }

  /** Each handle's place on screen (client px), for the tool's grab and the tests. */
  handlePoints(camera: THREE.Camera, rect: { left: number; top: number; width: number; height: number }): { id: string; x: number; y: number }[] {
    if (rect.width === 0 || !this.frame.visible) return [];
    this.frame.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    const p = new THREE.Vector3();
    const out: { id: string; x: number; y: number }[] = [];
    for (const [id, m] of this.handles) {
      m.getWorldPosition(p).project(camera);
      if (p.z > 1) continue;
      out.push({ id, x: Math.round(rect.left + ((p.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - p.y) / 2) * rect.height) });
    }
    return out;
  }

  /** Everything gone (the mode closed, or the tool off). */
  clear(): void {
    for (const name of [...this.parts.keys()]) this.setLines(name, null, this.colours.line, 0, false);
    this.setHandles([], null);
    this.frame.visible = false;
    this.world.visible = false;
  }

  dispose(): void {
    this.clear();
    for (const g of Object.values(this.handleGeometry)) g.dispose();
    this.frame.removeFromParent();
    this.world.removeFromParent();
  }
}
