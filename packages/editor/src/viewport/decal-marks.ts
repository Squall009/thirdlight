/**
 * What the decal editor draws over the Scene view: each selected decal's
 * outline (the selection colour) with a square at each corner, a dashed
 * outline round the decal under the pointer, the primary selection's turn
 * ring with its knob and its size corner, and the rectangle a box selection
 * drags out (a page element over the canvas, so it is crisp at any zoom).
 *
 * Outlines lie in the decal's image plane (its XY), at its width and height;
 * the grips keep a constant size on screen (`frame`).
 *
 * Browser-only (three.js, DOM).
 */
import * as THREE from 'three';

import { tokenColour } from './brush-cursor';
import { ringGeometry, ringLine } from './helper-shapes';

/** A decal as the marks draw it: its world matrix (scale left out) and its image's width and height. */
export interface MarkedDecal {
  readonly id: string;
  readonly world: THREE.Matrix4;
  readonly size: readonly number[];
}

/** The corner squares' size on screen, as a share of the view's height (about 7 px at 1080p). */
const CORNER_SCREEN = 0.0065;
/** The outlines and grips draw over the scene (after the decals and the brush cursor). */
const MARK_ORDER = 14;

/** The unit square's outline, closed by repeating the first corner (the WebGPU renderer draws no line loops). */
const UNIT_OUTLINE = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0]);
/** The corners of a decal's image, as signs of its half width and height. */
const CORNERS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

export class DecalMarks {
  private readonly group = new THREE.Group();
  private readonly outlines = new THREE.Group();
  /** Outline and corner objects, one pair per selected decal (kept for the next selection). */
  private readonly pool: { line: THREE.Line; corners: THREE.Group }[] = [];
  private readonly square = new THREE.BufferGeometry();
  private readonly cornerGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly lineMat: THREE.LineBasicMaterial;
  private readonly cornerMat: THREE.MeshBasicMaterial;
  private readonly hover: THREE.Line;
  private readonly hoverMat: THREE.LineDashedMaterial;
  /** The primary decal's turn ring, its knob and its size corner. */
  private readonly grips = new THREE.Group();
  private readonly ring: THREE.Line;
  readonly knob: THREE.Mesh;
  readonly corner: THREE.Mesh;
  private readonly gripMat: THREE.MeshBasicMaterial;
  private readonly ringMat: THREE.LineBasicMaterial;
  /** Where the knob and the corner are in the world (what a press is tested against). */
  readonly gripWorld = { turn: new THREE.Vector3(), size: new THREE.Vector3() };
  private box: HTMLDivElement | null = null;

  constructor(private readonly overlay: THREE.Object3D) {
    this.square.setAttribute('position', new THREE.BufferAttribute(UNIT_OUTLINE, 3));
    const select = tokenColour('--select');
    this.lineMat = new THREE.LineBasicMaterial({ color: select, depthTest: false, transparent: true });
    this.cornerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, side: THREE.DoubleSide });
    this.hoverMat = new THREE.LineDashedMaterial({ color: tokenColour('--text'), dashSize: 0.06, gapSize: 0.04, depthTest: false, transparent: true, opacity: 0.85 });
    this.hover = new THREE.Line(this.square.clone(), this.hoverMat);
    this.hover.visible = false;
    this.ringMat = new THREE.LineBasicMaterial({ color: select, depthTest: false, transparent: true });
    this.ring = ringLine(ringGeometry('xy', 64), this.ringMat);
    this.gripMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
    this.knob = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.gripMat);
    this.corner = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), this.gripMat);
    for (const o of [this.ring, this.knob, this.corner]) this.grips.add(o);
    this.grips.visible = false;
    this.grips.matrixAutoUpdate = false;
    for (const o of [this.outlines, this.hover, this.grips]) this.group.add(o);
    this.group.traverse((o) => {
      o.renderOrder = MARK_ORDER;
      o.raycast = () => undefined;
      o.frustumCulled = false;
    });
    this.group.name = 'decal-marks';
    overlay.add(this.group);
  }

  /** The selected decals' outlines and corners (laid again every frame: the objects are kept, only their matrices change). */
  setSelection(decals: readonly MarkedDecal[]): void {
    while (this.pool.length < decals.length) {
      const line = new THREE.Line(this.square, this.lineMat);
      const corners = new THREE.Group();
      for (let k = 0; k < CORNERS.length; k++) corners.add(new THREE.Mesh(this.cornerGeometry, this.cornerMat));
      for (const o of [line, corners, ...corners.children]) {
        o.renderOrder = MARK_ORDER;
        o.raycast = () => undefined;
        o.frustumCulled = false;
      }
      line.matrixAutoUpdate = corners.matrixAutoUpdate = false;
      this.outlines.add(line, corners);
      this.pool.push({ line, corners });
    }
    this.pool.forEach((p, i) => {
      const d = decals[i];
      p.line.visible = p.corners.visible = d !== undefined;
      if (d === undefined) return;
      p.line.matrix.copy(scaled(d));
      p.corners.matrix.copy(d.world);
      p.corners.children.forEach((c, k) => c.position.set((CORNERS[k]![0] * (d.size[0] ?? 1)) / 2, (CORNERS[k]![1] * (d.size[1] ?? 1)) / 2, 0));
      p.line.matrixWorldNeedsUpdate = p.corners.matrixWorldNeedsUpdate = true;
    });
  }

  /** The dashed outline of the decal under the pointer (null: none). */
  setHover(d: MarkedDecal | null): void {
    this.hover.visible = d !== null;
    if (d === null) return;
    this.hover.matrixAutoUpdate = false;
    this.hover.matrix.copy(scaled(d));
    // Dashes a constant share of the outline whatever its size.
    const k = Math.max(0.05, Math.hypot(d.size[0] ?? 1, d.size[1] ?? 1));
    this.hoverMat.dashSize = 0.06 / k;
    this.hoverMat.gapSize = 0.04 / k;
    this.hover.computeLineDistances();
  }

  /** The turn ring and the size corner round the primary decal (null: none), as `size` while a drag previews it. */
  setGrips(world: THREE.Matrix4 | null, size: readonly number[]): void {
    this.grips.visible = world !== null;
    if (world === null) return;
    this.grips.matrix.copy(world);
    this.grips.updateMatrixWorld(true);
    const [w, h] = [size[0] ?? 1, size[1] ?? 1];
    const r = 0.55 * Math.hypot(w, h);
    this.ring.scale.set(r, r, 1);
    this.knob.position.set(0, r, 0);
    this.corner.position.set(w / 2, h / 2, 0);
    this.gripWorld.turn.set(0, r, 0).applyMatrix4(world);
    this.gripWorld.size.set(w / 2, h / 2, 0).applyMatrix4(world);
  }

  gripsShown(): boolean {
    return this.grips.visible;
  }

  /** Before a frame: the knob, the size corner and the outlines' corner squares keep their size on screen. */
  frame(camera: THREE.PerspectiveCamera): void {
    const lens = Math.tan((camera.fov * Math.PI) / 360);
    const at = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (const p of this.pool) {
      if (!p.corners.visible) continue;
      p.corners.updateMatrixWorld(true);
      s.setFromMatrixScale(p.corners.matrixWorld);
      for (const c of p.corners.children) {
        at.setFromMatrixPosition(c.matrixWorld);
        c.scale.setScalar((at.distanceTo(camera.position) * lens * CORNER_SCREEN * 2) / Math.max(1e-6, s.x));
      }
    }
    if (!this.grips.visible) return;
    const k = lens * 0.016;
    const parentScale = new THREE.Vector3().setFromMatrixScale(this.grips.matrixWorld);
    for (const g of [this.knob, this.corner]) {
      g.updateMatrixWorld();
      const at = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
      g.scale.setScalar(Math.max(0.01, at.distanceTo(camera.position) * k) / Math.max(1e-6, parentScale.x));
    }
  }

  /** The box selection's rectangle over `canvas` between two client points (null: none). */
  setBox(canvas: HTMLCanvasElement, from: { x: number; y: number } | null, to?: { x: number; y: number }): void {
    if (from === null || to === undefined) {
      this.box?.remove();
      this.box = null;
      return;
    }
    const host = canvas.parentElement;
    if (host === null) return;
    if (this.box === null) {
      this.box = document.createElement('div');
      this.box.className = 'tl-decal-box';
      this.box.setAttribute('aria-hidden', 'true');
      host.appendChild(this.box);
    }
    const r = host.getBoundingClientRect();
    const x = Math.min(from.x, to.x) - r.left;
    const y = Math.min(from.y, to.y) - r.top;
    Object.assign(this.box.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(to.x - from.x)}px`, height: `${Math.abs(to.y - from.y)}px` });
  }

  dispose(): void {
    this.setBox(document.createElement('canvas'), null);
    this.setSelection([]);
    this.group.removeFromParent();
    this.square.dispose();
    this.cornerGeometry.dispose();
    this.hover.geometry.dispose();
    this.knob.geometry.dispose();
    this.corner.geometry.dispose();
    this.ring.geometry.dispose();
    for (const m of [this.lineMat, this.cornerMat, this.hoverMat, this.gripMat, this.ringMat]) m.dispose();
  }
}

/** A decal's image rectangle as a matrix of the unit square. */
function scaled(d: MarkedDecal): THREE.Matrix4 {
  return d.world.clone().multiply(new THREE.Matrix4().makeScale(Math.max(1e-4, d.size[0] ?? 1), Math.max(1e-4, d.size[1] ?? 1), 1));
}
